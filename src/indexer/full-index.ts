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

      // Step 2: insert into the live index; supersede old occurrences via tombstones.
      const entries: { vaneId: number; vector: Float32Array }[] = [];
      for (const c of changed) {
        const vecRow = await reqAsPromise<VectorRow>(
          db.transaction('vectors').objectStore('vectors').get([gen.embeddingFingerprint, c.row.inputHash]));
        const old = rev.get(c.row.occurrenceId);
        if (old !== undefined) {
          gen.tombstones.push(old);
          delete gen.idMap[old];
        }
        const vaneId = gen.nextVaneId++;
        gen.idMap[vaneId] = c.row.occurrenceId;
        rev.set(c.row.occurrenceId, vaneId);
        entries.push({ vaneId, vector: vecRow.vector });
      }
      await client.insert(entries);
      indexed++;
    } else {
      skipped++;
    }

    // Step 3: files row + generation record — the atomic "this file is indexed" commit.
    const tx2 = db.transaction(['files', 'generations'], 'readwrite');
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
