/** Monotonic token: an async result is only applied if its token is still the newest. */
export class RequestGate {
  private token = 0;
  issue(): number { return ++this.token; }
  isCurrent(t: number): boolean { return t === this.token; }
}
