import { describe, it, expect } from 'vitest';
import { meanVector, isExcludedByFolder } from '../../src/ui/related-notes-view';

describe('meanVector', () => {
  it('returns the vector unchanged when given a single vector', () => {
    const v = Float32Array.from([1, 2, 3]);
    expect([...meanVector([v], 3)]).toEqual([1, 2, 3]);
  });

  it('returns the component-wise mean of multiple vectors', () => {
    const a = Float32Array.from([1, 0, 4]);
    const b = Float32Array.from([3, 2, 0]);
    expect([...meanVector([a, b], 3)]).toEqual([2, 1, 2]);
  });

  it('does not mutate its input arrays', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([5, 6, 7]);
    meanVector([a, b], 3);
    expect([...a]).toEqual([1, 2, 3]);
    expect([...b]).toEqual([5, 6, 7]);
  });
});

describe('isExcludedByFolder', () => {
  it('does not exclude anything when the folder is empty', () => {
    expect(isExcludedByFolder('Daily/2026-09-08.md', '')).toBe(false);
  });

  it('excludes a note inside the folder', () => {
    expect(isExcludedByFolder('Daily/2026-09-08.md', 'Daily')).toBe(true);
  });

  it('excludes a note inside the folder when the setting has a trailing slash', () => {
    expect(isExcludedByFolder('Daily/2026-09-08.md', 'Daily/')).toBe(true);
  });

  it('excludes a note in a nested subfolder of the excluded folder', () => {
    expect(isExcludedByFolder('Daily/2026/09-08.md', 'Daily')).toBe(true);
  });

  it('does not exclude a note outside the folder', () => {
    expect(isExcludedByFolder('Projects/Daily-standup.md', 'Daily')).toBe(false);
  });

  it('does not exclude a note with a merely similar-prefixed name', () => {
    expect(isExcludedByFolder('DailyNotes/foo.md', 'Daily')).toBe(false);
  });
});
