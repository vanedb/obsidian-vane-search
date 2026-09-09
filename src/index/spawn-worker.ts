export function spawnIndexWorker(): Worker {
  // The Blob URL is deliberately not revoked: some WebViews load worker scripts
  // lazily and an early revoke is a race. One URL per session is a non-leak.
  const blob = new Blob([__INDEX_WORKER_SOURCE__], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob));
}
