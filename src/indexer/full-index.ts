import { getVectors, reqAsPromise, txDone, type FileRow, type VectorRow } from '../storage/vane-db';
import type { GenerationRecord } from '../storage/generation-store';
import { embeddingFingerprint, type EmbeddingProvider } from '../providers/embedding-provider';
import type { IndexClient } from '../index/index-client';
import { chunkWholeFile, CHUNKER_VERSION, type ChunkRow } from '../chunker/whole-file';
import { hash64 } from '../hash';

export interface FileMeta { path: string; mtime: number; size: number }
export interface FileSource { list(): FileMeta[]; read(path: string): Promise<string> }

type ChunkEntry = { row: ChunkRow; embeddedText: string };

/**
 * Files are processed in windows to bound memory. Each window's unique texts go
 * to one provider.embed() call, so request count follows provider batching, not
 * file count.
 */
const WINDOW = 128;

interface FilePlan {
  f: FileMeta;
  content: string;
  chunks: ChunkEntry[];
  changed: ChunkEntry[];
}

/**
 * Write order:
 *   1. vector rows commit first (content-addressed; orphans are harmless cache),
 *   2. the live index insert happens next (volatile; rebuilt from IDB on restart),
 *   3. chunk metadata, the file row and generation record commit last, in one transaction.
 * A crash at any point leaves the store consistent: a file is indexed only if step 3 committed.
 * Step 1 runs for the whole window before any file reaches step 2; steps 2–3 run per file, in order.
 */
export async function runFullIndex(deps: {
  db: IDBDatabase;
  source: FileSource;
  provider: EmbeddingProvider;
  client: IndexClient;
  gen: GenerationRecord;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ indexed: number; skipped: number }> {
  const { db, source, provider, client, gen } = deps;

  // Never store vectors under a fingerprint produced by a different provider (e.g. the
  // live reindex path after a provider switch without Rebuild).
  const providerFp = embeddingFingerprint(provider, CHUNKER_VERSION);
  if (providerFp !== gen.embeddingFingerprint) {
    throw new Error('Vane Search: provider/generation fingerprint mismatch — rebuild the index');
  }

  const files = source.list();
  const fileRows = new Map<string, FileRow>(
    (await reqAsPromise<FileRow[]>(db.transaction('files').objectStore('files').getAll())).filter((r) => r.generation === gen.generation).map((r) => [r.path, r]),
  );
  // Loaded once: per-chunk IDB round-trips dominated fresh-index time.
  const chunkRows = new Map<string, ChunkRow>(
    (await reqAsPromise<(ChunkRow & { generation: number })[]>(db.transaction('chunks').objectStore('chunks').getAll())).filter((r) => r.generation === gen.generation).map((r) => [r.occurrenceId, r]),
  );
  const rev = new Map<string, number>(); // occurrenceId → vaneId
  for (const [vid, occ] of Object.entries(gen.idMap)) rev.set(occ, Number(vid));

  let indexed = 0, skipped = 0, done = 0;

  for (let start = 0; start < files.length; start += WINDOW) {
    const windowFiles = files.slice(start, start + WINDOW);

    // Pass 1 (no network): read, chunk and diff each file against stored chunk rows.
    const plans: FilePlan[] = [];
    for (const f of windowFiles) {
      const prev = fileRows.get(f.path);
      // A row from an older generation must not satisfy the skip, even if mtime/size match.
      if (prev && prev.generation === gen.generation && prev.mtime === f.mtime && prev.size === f.size) {
        skipped++; deps.onProgress?.(++done, files.length); continue;
      }

      const content = await source.read(f.path);
      const chunks = chunkWholeFile(f.path, content);
      const changed: ChunkEntry[] = [];
      for (const c of chunks) {
        const oldRow = chunkRows.get(c.row.occurrenceId);
        if (!oldRow || oldRow.inputHash !== c.row.inputHash || !rev.has(c.row.occurrenceId)) changed.push(c);
      }
      plans.push({ f, content, chunks, changed });
    }

    // Pass 2: changed chunks in the window, deduped by inputHash.
    const textByHash = new Map<string, string>();
    for (const p of plans) {
      for (const c of p.changed) {
        if (!textByHash.has(c.row.inputHash)) textByHash.set(c.row.inputHash, c.embeddedText);
      }
    }
    const uniqueHashes = [...textByHash.keys()];

    // Reuse vectors already stored for this fingerprint.
    const storedVectors = await getVectors(db, gen.embeddingFingerprint, uniqueHashes);
    const toEmbedHashes = uniqueHashes.filter((h) => !storedVectors.has(h));

    // Pass 3: embed the missing texts in one call.
    const toEmbedTexts = toEmbedHashes.map((h) => textByHash.get(h)!);
    const embedded = toEmbedTexts.length ? await provider.embed(toEmbedTexts, 'doc') : [];
    const justEmbedded = new Map<string, Float32Array>();
    toEmbedHashes.forEach((h, i) => justEmbedded.set(h, embedded[i]));

    // Write step 1: the window's vectors, in one transaction.
    if (plans.length) {
      const tx1 = db.transaction('vectors', 'readwrite');
      const vStore = tx1.objectStore('vectors');
      toEmbedHashes.forEach((h, i) => vStore.put(
        { fingerprint: gen.embeddingFingerprint, inputHash: h, vector: embedded[i] } satisfies VectorRow));
      await txDone(tx1);
    }

    const vectorFor = (inputHash: string): Float32Array => justEmbedded.get(inputHash) ?? storedVectors.get(inputHash)!;

    // Pass 4: finalize each file in order (write steps 2–3).
    for (const p of plans) {
      const { f, content, chunks, changed } = p;

      if (changed.length > 0) {
        // Step 2: build entries and the planned generation mutations WITHOUT touching
        // `gen` yet — if client.insert rejects (worker crash), `gen` and `rev` must be
        // left exactly as they were, so the failure can be retried cleanly.
        let nextId = gen.nextVaneId;
        const entries: { vaneId: number; vector: Float32Array }[] = [];
        const planned: { old: number | undefined; vaneId: number; occurrenceId: string }[] = [];
        for (const c of changed) {
          const vector = vectorFor(c.row.inputHash);
          const old = rev.get(c.row.occurrenceId);
          const vaneId = nextId++;
          planned.push({ old, vaneId, occurrenceId: c.row.occurrenceId });
          entries.push({ vaneId, vector });
        }
        await client.insert(entries);

        // Only now — insert succeeded — apply the tombstones, idMap changes, and the
        // id counter advance, both in `gen` and in the local `rev` map.
        for (const { old, vaneId, occurrenceId } of planned) {
          if (old !== undefined) {
            gen.tombstones.push(old);
            delete gen.idMap[old];
          }
          gen.idMap[vaneId] = occurrenceId;
          rev.set(occurrenceId, vaneId);
        }
        gen.nextVaneId = nextId;
        indexed++;
      } else {
        skipped++;
      }

      // Reconcile stale occurrences: if this file now produces FEWER chunks than
      // before (e.g. trimmed under the chunker's split threshold), the vanished
      // occurrenceIds (path#1, path#2, …) are still LIVE in gen.idMap and would
      // otherwise keep surfacing stale content forever. Any client.insert(...)
      // for this file's changed chunks has already resolved by this point, so
      // it's safe to mutate `gen` — same invariant Step 2 above follows.
      const currentOccurrenceIds = new Set(chunks.map((c) => c.row.occurrenceId));
      const prefix = `${f.path}#`;
      const staleOccurrenceIds: string[] = [];
      for (const [vaneIdStr, occ] of Object.entries(gen.idMap)) {
        if (!occ.startsWith(prefix) || currentOccurrenceIds.has(occ)) continue;
        const vaneId = Number(vaneIdStr);
        gen.tombstones.push(vaneId);
        delete gen.idMap[vaneId];
        rev.delete(occ);
        staleOccurrenceIds.push(occ);
      }

      // Step 3: files row + generation record — the atomic "this file is indexed" commit.
      // Stale chunk rows are derived cache, but dropping them in the same transaction
      // keeps the durable store consistent with the generation record in one commit.
      const tx2 = db.transaction(['files', 'generations', 'chunks'], 'readwrite');
      for (const c of chunks) tx2.objectStore('chunks').put({ ...c.row, generation: gen.generation });
      for (const occ of staleOccurrenceIds) tx2.objectStore('chunks').delete([gen.generation, occ]);
      tx2.objectStore('files').put({
        path: f.path, mtime: f.mtime, size: f.size,
        contentHash: hash64(content), generation: gen.generation,
      } satisfies FileRow);
      tx2.objectStore('generations').put(gen);
      await txDone(tx2);

      deps.onProgress?.(++done, files.length);
    }
  }
  return { indexed, skipped };
}
