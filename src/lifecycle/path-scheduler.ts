/** A debounced trigger with a cancel — the injected debounce implementation. */
export interface Debounced {
  trigger(): void;
  cancel(): void;
}

/** Per-path debounced scheduler. One shared `onFire(path)` action; each path gets
 *  its own debouncer, created lazily and PRUNED when it fires so the map tracks only
 *  paths with work still pending (no unbounded growth over a session). */
export class PathScheduler {
  private readonly debouncers = new Map<string, Debounced>();

  constructor(
    private readonly makeDebounced: (fn: () => void) => Debounced,
    private readonly onFire: (path: string) => void,
  ) {}

  /** Schedule (or re-arm) the debounced action for `path`. */
  schedule(path: string): void {
    let d = this.debouncers.get(path);
    if (!d) {
      d = this.makeDebounced(() => {
        this.debouncers.delete(path); // fired — prune before firing so re-arm during onFire re-creates
        this.onFire(path);
      });
      this.debouncers.set(path, d);
    }
    d.trigger();
  }

  /** Cancel any pending action for `path` and forget it. */
  cancel(path: string): void {
    this.debouncers.get(path)?.cancel();
    this.debouncers.delete(path);
  }

  /** Cancel everything (plugin unload). */
  cancelAll(): void {
    for (const d of this.debouncers.values()) d.cancel();
    this.debouncers.clear();
  }

  /** Number of paths with a pending debouncer — for leak assertions. */
  get pendingCount(): number {
    return this.debouncers.size;
  }
}
