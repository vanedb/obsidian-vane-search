import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PathScheduler, type Debounced } from '../../src/lifecycle/path-scheduler';

// Realistic trailing-edge debounce on fake timers: each trigger resets a 100ms timer.
function makeDebounced(fn: () => void): Debounced {
  let t: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger() { if (t) clearTimeout(t); t = setTimeout(fn, 100); },
    cancel() { if (t) clearTimeout(t); t = null; },
  };
}

describe('PathScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid schedules of one path into a single fire', () => {
    const fired: string[] = [];
    const s = new PathScheduler(makeDebounced, (p) => fired.push(p));
    s.schedule('a.md');
    s.schedule('a.md');
    s.schedule('a.md');
    expect(fired).toEqual([]);         // nothing yet — still debouncing
    vi.advanceTimersByTime(100);
    expect(fired).toEqual(['a.md']);   // exactly one fire
  });

  it('prunes the entry after it fires (no unbounded growth)', () => {
    const s = new PathScheduler(makeDebounced, () => {});
    s.schedule('a.md');
    expect(s.pendingCount).toBe(1);
    vi.advanceTimersByTime(100);
    expect(s.pendingCount).toBe(0);
  });

  it('cancel(path) prevents the fire and forgets the path', () => {
    const fired: string[] = [];
    const s = new PathScheduler(makeDebounced, (p) => fired.push(p));
    s.schedule('a.md');
    s.cancel('a.md');
    expect(s.pendingCount).toBe(0);
    vi.advanceTimersByTime(100);
    expect(fired).toEqual([]);
  });

  it('fires distinct paths independently', () => {
    const fired: string[] = [];
    const s = new PathScheduler(makeDebounced, (p) => fired.push(p));
    s.schedule('a.md');
    s.schedule('b.md');
    expect(s.pendingCount).toBe(2);
    vi.advanceTimersByTime(100);
    expect(fired.sort()).toEqual(['a.md', 'b.md']);
    expect(s.pendingCount).toBe(0);
  });

  it('cancelAll cancels all pending and clears', () => {
    const fired: string[] = [];
    const s = new PathScheduler(makeDebounced, (p) => fired.push(p));
    s.schedule('a.md');
    s.schedule('b.md');
    s.cancelAll();
    expect(s.pendingCount).toBe(0);
    vi.advanceTimersByTime(100);
    expect(fired).toEqual([]);
  });
});
