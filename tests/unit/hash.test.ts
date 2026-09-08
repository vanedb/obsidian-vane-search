import { describe, it, expect } from 'vitest';
import { hash64 } from '../../src/hash';

describe('hash64', () => {
  it('is deterministic and 16 hex chars', () => {
    expect(hash64('hello')).toBe(hash64('hello'));
    expect(hash64('hello')).toMatch(/^[0-9a-f]{16}$/);
  });
  it('differs on different input, handles empty and unicode', () => {
    expect(hash64('hello')).not.toBe(hash64('hello '));
    expect(hash64('')).toMatch(/^[0-9a-f]{16}$/);
    expect(hash64('émoji 🌱')).toBe(hash64('émoji 🌱'));
  });
});
