export function spawnIndexWorker(): Worker {
  // Keep the URL alive while this worker can load it lazily, then release it
  // on retirement. Rebuilds create replacement workers within one plugin session.
  const blob = new Blob([__INDEX_WORKER_SOURCE__], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    const worker = new Worker(url);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { terminate(); URL.revokeObjectURL(url); };
    return worker;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
