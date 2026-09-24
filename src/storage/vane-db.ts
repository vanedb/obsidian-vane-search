export const DB_VERSION = 2;

export interface VectorRow { fingerprint: string; inputHash: string; vector: Float32Array }
export interface FileRow { path: string; mtime: number; size: number; contentHash: string; generation: number }

/** Multiple vaults share one Electron origin — the vault id keeps them apart. */
export function dbName(vaultId: string): string {
  return `vane-search/${vaultId}`;
}

export function openVaneDb(vaultId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(vaultId), DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction!;
      if (event.oldVersion === 0) {
        db.createObjectStore('vectors', { keyPath: ['fingerprint', 'inputHash'] });
        db.createObjectStore('chunks', { keyPath: ['generation', 'occurrenceId'] });
        db.createObjectStore('files', { keyPath: ['generation', 'path'] });
        db.createObjectStore('generations', { keyPath: 'generation' });
        db.createObjectStore('meta', { keyPath: 'key' });
        return;
      }
      // Upgrade in the versionchange transaction: a crash/abort keeps the v1 schema
      // intact. Old chunks were shared; copy their existing interpretation into each
      // recorded generation before any replacement can overwrite it.
      const chunks = tx.objectStore('chunks').getAll();
      const files = tx.objectStore('files').getAll();
      const gens = tx.objectStore('generations').getAll();
      gens.onsuccess = () => {
        db.deleteObjectStore('chunks');
        db.deleteObjectStore('files');
        const chunkStore = db.createObjectStore('chunks', { keyPath: ['generation', 'occurrenceId'] });
        const fileStore = db.createObjectStore('files', { keyPath: ['generation', 'path'] });
        for (const gen of gens.result) {
          const live = new Set(Object.values(gen.idMap));
          for (const row of chunks.result) if (live.has(row.occurrenceId)) {
            chunkStore.put({ ...row, generation: gen.generation });
          }
        }
        for (const row of files.result) fileStore.put(row);
      };
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

export function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

/**
 * Batched `vectors.get([fingerprint, hash])` lookup for many hashes, in one readonly
 * transaction. Hashes with no stored vector are simply absent from the returned map.
 */
export async function getVectors(db: IDBDatabase, fingerprint: string, hashes: string[]): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  if (hashes.length === 0) return out;
  const store = db.transaction('vectors').objectStore('vectors');
  const rows = await Promise.all(hashes.map((h) => reqAsPromise<VectorRow | undefined>(store.get([fingerprint, h]))));
  hashes.forEach((h, i) => { const row = rows[i]; if (row) out.set(h, row.vector); });
  return out;
}

/**
 * Resolves on transaction COMMIT (oncomplete), not on individual request success —
 * this is the durability point. Issue all writes synchronously before awaiting:
 * an `await` between puts lets the transaction auto-commit early.
 */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
  });
}
