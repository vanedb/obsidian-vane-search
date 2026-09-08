import { describe, it, expect } from 'vitest';
import { chunkWholeFile, CHUNKER_VERSION } from '../../src/chunker/whole-file';

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

  it('exports CHUNKER_VERSION 0', () => {
    expect(CHUNKER_VERSION).toBe(0);
  });
});
