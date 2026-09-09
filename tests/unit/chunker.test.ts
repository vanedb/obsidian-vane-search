import { describe, it, expect } from 'vitest';
import { chunkWholeFile, CHUNKER_VERSION, MAX_EMBED_CHARS } from '../../src/chunker/whole-file';

describe('chunkWholeFile', () => {
  it('produces one chunk with title-prefixed embedded text', () => {
    const [c] = chunkWholeFile('notes/Coffee Brewing.md', 'Grind fine.\nUse 95C water.');
    expect(c.row.occurrenceId).toBe('notes/Coffee Brewing.md#0');
    expect(c.row.path).toBe('notes/Coffee Brewing.md');
    expect(c.row.breadcrumb).toBe('Coffee Brewing');
    expect(c.embeddedText).toBe('Coffee Brewing\n\nGrind fine.\nUse 95C water.');
    expect(c.row.inputHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hash is stable and changes with content OR title', () => {
    const a = chunkWholeFile('a.md', 'same')[0].row.inputHash;
    expect(chunkWholeFile('a.md', 'same')[0].row.inputHash).toBe(a);
    expect(chunkWholeFile('a.md', 'different')[0].row.inputHash).not.toBe(a);
    // title is part of the embedded text ⇒ basename rename re-embeds (spec)
    expect(chunkWholeFile('b.md', 'same')[0].row.inputHash).not.toBe(a);
    // folder move keeps title ⇒ same hash ⇒ re-embed is free (spec)
    expect(chunkWholeFile('other/folder/a.md', 'same')[0].row.inputHash).toBe(a);
  });

  it('skips YAML frontmatter', () => {
    const plain = chunkWholeFile('n.md', 'body text')[0];
    const fm = chunkWholeFile('n.md', '---\ntags: [x]\n---\nbody text')[0];
    expect(fm.embeddedText).toBe(plain.embeddedText);
    expect(fm.row.inputHash).toBe(plain.row.inputHash);
  });

  it('empty note still yields a title-only chunk', () => {
    const [c] = chunkWholeFile('Ideas.md', '');
    expect(c.embeddedText).toBe('Ideas');
    expect(c.row.offsets).toEqual([0, 0]);
  });

  it('offsets cover the body within the original content', () => {
    const content = '---\nk: v\n---\nBody here';
    const [c] = chunkWholeFile('n.md', content);
    expect(content.slice(c.row.offsets[0], c.row.offsets[1])).toBe('Body here');
  });

  it('exports CHUNKER_VERSION 1', () => {
    expect(CHUNKER_VERSION).toBe(1);
  });

  describe('bounded chunking of oversized notes', () => {
    const path = 'notes/Huge.md';
    const title = 'Huge';
    // Non-periodic filler (each word is unique) so that windows never
    // coincide textually — a naive periodic filler like 'x '.repeat(n) can
    // produce byte-identical windows when the step aligns with the period,
    // which would make the hash-uniqueness assertion below meaningless.
    const bigBody = Array.from({ length: 20000 }, (_, i) => `word${i}`).join(' '); // far exceeds MAX_EMBED_CHARS

    it('splits an oversized note into multiple contiguous chunks, all within budget', () => {
      const chunks = chunkWholeFile(path, bigBody);
      expect(chunks.length).toBeGreaterThan(1);

      chunks.forEach((c, i) => {
        expect(c.row.occurrenceId).toBe(`${path}#${i}`);
        expect(c.embeddedText.length).toBeLessThanOrEqual(MAX_EMBED_CHARS);
        expect(c.embeddedText.startsWith(`${title}\n\n`)).toBe(true);
      });

      // hashes differ across windows and are stable across calls
      const hashes = chunks.map((c) => c.row.inputHash);
      expect(new Set(hashes).size).toBe(hashes.length);
      const chunks2 = chunkWholeFile(path, bigBody);
      expect(chunks2.map((c) => c.row.inputHash)).toEqual(hashes);

      // union of windows covers the whole body
      const bodyOffset = chunks[0].row.offsets[0];
      expect(chunks[0].row.offsets[0]).toBe(bodyOffset);
      const last = chunks[chunks.length - 1];
      expect(last.row.offsets[1]).toBe(bodyOffset + bigBody.trim().length);
    });

    it('offsets of a middle chunk slice the original content back to that window text', () => {
      const content = bigBody;
      const chunks = chunkWholeFile(path, content);
      expect(chunks.length).toBeGreaterThan(2);
      const mid = chunks[1];
      const [start, end] = mid.row.offsets;
      const windowText = content.slice(start, end);
      expect(mid.embeddedText).toBe(`${title}\n\n${windowText}`);
    });
  });
});
