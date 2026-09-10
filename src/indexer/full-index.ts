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
 * Files are processed in windows of this size (not all at once) to bound
 * memory: within a window we read+chunk every file, embed the whole window's
 * worth of unique texts in ONE provider.embed() call (the provider internally
 * splits that into maxBatch/maxBatchChars requests), then finalize files one
 * at a time. This turns "N files ⇒ N embedding round-trips" into "N files ⇒
 * N/WINDOW planning passes, each driving O(1) embed() calls" — the request
 * count tracks the provider's own batching, not the file count.
 */
const WINDOW = 128;

interface FilePlan {
  f: FileMeta;
  content: string;
  chunks: ChunkEntry[];
  changed: ChunkEntry[];
}

/**
 * Write-ordering contract (spec "Data flow"):
 *   1. vectors + chunks rows commit first (content-addressed — orphans are harmless cache),
 *   2. the live index insert happens next (volatile — rebuilt from IDB on restart),
 *   3. the files row and generation record commit LAST, in one transaction.
 * A crash at any point leaves the store consistent: a file is "indexed" only if step 3 committed.
 * This holds per file even though embedding (step 1a/1b) is now batched across a whole
 * WINDOW of files: every file's step-1b write happens before ANY file in the window
 * reaches step 2, and step 2/3 still run one file at a time, in order, exactly as before.
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

  // Backstop against writing a vector row keyed by `gen.embeddingFingerprint` that was
  // actually produced by a DIFFERENT provider (e.g. the live single-file reindex path
  // runs whatever `this.provider` currently is, which can drift from `this.gen` if the
  // user switches provider without clicking "Rebuild"). Every caller gets this for free —
  // the manual index path never trips it because it rebuilds `gen` to match first.
  const providerFp = embeddingFingerprint(provider, CHUNKER_VERSION);
  if (providerFp !== gen.embeddingFingerprint) {
    throw new Error('Vane Search: provider/generation fingerprint mismatch — rebuild the index');
  }

  const files = source.list();
  const fileRows = new Map<string, FileRow>(
    (await reqAsPromise<FileRow[]>(db.transaction('files').objectStore('files').getAll())).map((r) => [r.path, r]),
  );
  // Loaded ONCE up front instead of a transaction-per-chunk `chunks.get(...)` —
  // the dominant fixed cost of a fresh index was IDB round-trips, not just embedding.
  const chunkRows = new Map<string, ChunkRow>(
    (await reqAsPromise<ChunkRow[]>(db.transaction('chunks').objectStore('chunks').getAll())).map((r) => [r.occurrenceId, r]),
  );
  const rev = new Map<string, number>(); // occurrenceId → vaneId
  for (const [vid, occ] of Object.entries(gen.idMap)) rev.set(occ, Number(vid));

  let indexed = 0, skipped = 0, done = 0;

  for (let start = 0; start < files.length; start += WINDOW) {
    const windowFiles = files.slice(start, start + WINDOW);

    // ---- Pass 1: plan (no network) — read, chunk, and diff every non-skipped
    // file in the window against the persisted chunk rows and `rev`. ----
    const plans: FilePlan[] = [];
    for (const f of windowFiles) {
      const prev = fileRows.get(f.path);
      // The generation check matters: after a provider/chunker change the new
      // generation starts empty, and a files row from the OLD generation must not
      // satisfy the skip even though mtime/size never moved.
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

    // ---- Pass 2: collect this window's changed chunks, deduped by inputHash
    // (identical embedded text embeds once, same as before — just window-wide
    // instead of file-wide). ----
    const textByHash = new Map<string, string>();
    for (const p of plans) {
      for (const c of p.changed) {
        if (!textByHash.has(c.row.inputHash)) textByHash.set(c.row.inputHash, c.embeddedText);
      }
    }
    const uniqueHashes = [...textByHash.keys()];

    // Which of those already have a stored vector? Batched inside one readonly transaction
    // instead of one transaction per hash.
    const storedVectors = await getVectors(db, gen.embeddingFingerprint, uniqueHashes);
    const toEmbedHashes = uniqueHashes.filter((h) => !storedVectors.has(h));

    // ---- Pass 3: embed the whole window's missing unique texts in ONE call —
    // the provider splits this into maxBatch/maxBatchChars requests internally,
    // so the request count tracks provider batching, not file count. ----
    const toEmbedTexts = toEmbedHashes.map((h) => textByHash.get(h)!);
    const embedded = toEmbedTexts.length ? await provider.embed(toEmbedTexts, 'doc') : [];
    const justEmbedded = new Map<string, Float32Array>();
    toEmbedHashes.forEach((h, i) => justEmbedded.set(h, embedded[i]));

    // Step 1b: vectors + chunks for the WHOLE window commit together, before
    // anything in the window references them — one batched transaction rather
    // than one per chunk.
    if (plans.length) {
      const tx1 = db.transaction(['vectors', 'chunks'], 'readwrite');
      const vStore = tx1.objectStore('vectors');
      const cStore = tx1.objectStore('chunks');
      toEmbedHashes.forEach((h, i) => vStore.put(
        { fingerprint: gen.embeddingFingerprint, inputHash: h, vector: embedded[i] } satisfies VectorRow));
      for (const p of plans) for (const c of p.chunks) cStore.put(c.row);
      await txDone(tx1);
    }

    const vectorFor = (inputHash: string): Float32Array => justEmbedded.get(inputHash) ?? storedVectors.get(inputHash)!;

    // ---- Pass 4: per-file finalize, in order — unchanged from before. ----
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
      for (const occ of staleOccurrenceIds) tx2.objectStore('chunks').delete(occ);
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
