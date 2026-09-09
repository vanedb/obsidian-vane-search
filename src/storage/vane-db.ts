export const DB_VERSION = 1;

export interface VectorRow { fingerprint: string; inputHash: string; vector: Float32Array }
export interface FileRow { path: string; mtime: number; size: number; contentHash: string; generation: number }

/** Multiple vaults share one Electron origin — the vault id keeps them apart. */
export function dbName(vaultId: string): string {
  return `vane-search/${vaultId}`;
}

export function openVaneDb(vaultId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(vaultId), DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('vectors', { keyPath: ['fingerprint', 'inputHash'] });
      db.createObjectStore('chunks', { keyPath: 'occurrenceId' });
      db.createObjectStore('files', { keyPath: 'path' });
      db.createObjectStore('generations', { keyPath: 'generation' });
      db.createObjectStore('meta', { keyPath: 'key' });
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
