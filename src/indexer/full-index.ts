import { reqAsPromise, txDone, type FileRow, type VectorRow } from '../storage/vane-db';
import type { GenerationRecord } from '../storage/generation-store';
import type { EmbeddingProvider } from '../providers/embedding-provider';
import type { IndexClient } from '../index/index-client';
import { chunkWholeFile, type ChunkRow } from '../chunker/whole-file';
import { hash64 } from '../hash';

export interface FileMeta { path: string; mtime: number; size: number }
export interface FileSource { list(): FileMeta[]; read(path: string): Promise<string> }

/**
 * Write-ordering contract (spec "Data flow"):
 *   1. vectors + chunks rows commit first (content-addressed — orphans are harmless cache),
 *   2. the live index insert happens next (volatile — rebuilt from IDB on restart),
 *   3. the files row and generation record commit LAST, in one transaction.
 * A crash at any point leaves the store consistent: a file is "indexed" only if step 3 committed.
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
  const files = source.list();
  const fileRows = new Map<string, FileRow>(
    (await reqAsPromise<FileRow[]>(db.transaction('files').objectStore('files').getAll())).map((r) => [r.path, r]),
  );
  const rev = new Map<string, number>(); // occurrenceId → vaneId
  for (const [vid, occ] of Object.entries(gen.idMap)) rev.set(occ, Number(vid));

  let indexed = 0, skipped = 0, done = 0;

  for (const f of files) {
    const prev = fileRows.get(f.path);
    // The generation check matters: after a provider/chunker change the new
    // generation starts empty, and a files row from the OLD generation must not
    // satisfy the skip even though mtime/size never moved.
    if (prev && prev.generation === gen.generation && prev.mtime === f.mtime && prev.size === f.size) {
      skipped++; deps.onProgress?.(++done, files.length); continue;
    }

    const content = await source.read(f.path);
    const chunks = chunkWholeFile(f.path, content);

    // Which chunks actually changed? Compare against the persisted chunk rows.
    const changed: { row: ChunkRow; embeddedText: string }[] = [];
    for (const c of chunks) {
      const oldRow = await reqAsPromise<ChunkRow | undefined>(
        db.transaction('chunks').objectStore('chunks').get(c.row.occurrenceId));
      if (!oldRow || oldRow.inputHash !== c.row.inputHash || !rev.has(c.row.occurrenceId)) changed.push(c);
    }

    if (changed.length > 0) {
      // Step 1a: embed only what has no stored vector yet (dedupe by inputHash).
      const missing: typeof changed = [];
      for (const c of changed) {
        const have = await reqAsPromise<VectorRow | undefined>(
          db.transaction('vectors').objectStore('vectors').get([gen.embeddingFingerprint, c.row.inputHash]));
        if (!have) missing.push(c);
      }
      const embedded = missing.length ? await provider.embed(missing.map((c) => c.embeddedText), 'doc') : [];

      // Step 1b: vectors + chunks commit together, before anything references them.
      const tx1 = db.transaction(['vectors', 'chunks'], 'readwrite');
      missing.forEach((c, i) => tx1.objectStore('vectors').put(
        { fingerprint: gen.embeddingFingerprint, inputHash: c.row.inputHash, vector: embedded[i] } satisfies VectorRow));
      chunks.forEach((c) => tx1.objectStore('chunks').put(c.row));
      await txDone(tx1);

      // Reuse just-embedded vectors by inputHash; only chunks that already had a
      // stored vector need an IDB round-trip.
      const justEmbedded = new Map<string, Float32Array>();
      missing.forEach((c, i) => justEmbedded.set(c.row.inputHash, embedded[i]));
      const storedVectors = new Map<string, Float32Array>();
      for (const c of changed) {
        if (justEmbedded.has(c.row.inputHash) || storedVectors.has(c.row.inputHash)) continue;
        const vecRow = await reqAsPromise<VectorRow>(
          db.transaction('vectors').objectStore('vectors').get([gen.embeddingFingerprint, c.row.inputHash]));
        storedVectors.set(c.row.inputHash, vecRow.vector);
      }

      // Step 2: build entries and the planned generation mutations WITHOUT touching
      // `gen` yet — if client.insert rejects (worker crash), `gen` and `rev` must be
      // left exactly as they were, so the failure can be retried cleanly.
      let nextId = gen.nextVaneId;
      const entries: { vaneId: number; vector: Float32Array }[] = [];
      const planned: { old: number | undefined; vaneId: number; occurrenceId: string }[] = [];
      for (const c of changed) {
        const vector = justEmbedded.get(c.row.inputHash) ?? storedVectors.get(c.row.inputHash)!;
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
  return { indexed, skipped };
}
