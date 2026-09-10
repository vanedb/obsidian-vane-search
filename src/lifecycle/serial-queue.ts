// A single-lane queue: every enqueued op runs strictly after the previous one
// settles, so ops never overlap on the shared state they mutate. The chain
// never rejects — a failing op is routed to `onError` and the next op still
// runs — so callers can `await queue.enqueue(op)` without a try/catch and a
// long-lived chain is never poisoned by one failure.
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (e: unknown) => void) {}

  /** Runs `op` after all previously-enqueued ops. Resolves (never rejects) when
   *  `op` settles; if `op` throws, `onError` is called and the returned promise
   *  still resolves. */
  enqueue(op: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(op).catch((e) => this.onError(e));
    return this.tail;
  }
}
