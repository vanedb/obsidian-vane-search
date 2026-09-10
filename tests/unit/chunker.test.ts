import { describe, it, expect } from 'vitest';
import { chunkNote, CHUNKER_VERSION, MAX_EMBED_CHARS } from '../../src/chunker/chunker';

describe('chunkNote', () => {
  it('exports CHUNKER_VERSION 2', () => {
    expect(CHUNKER_VERSION).toBe(2);
  });

  it('a note with no headings produces one intro chunk, title-prefixed', () => {
    const [c] = chunkNote('notes/Coffee Brewing.md', 'Grind fine.\nUse 95C water.');
    expect(c.row.occurrenceId).toBe('notes/Coffee Brewing.md#0');
    expect(c.row.path).toBe('notes/Coffee Brewing.md');
    expect(c.row.breadcrumb).toBe('Coffee Brewing');
    expect(c.embeddedText).toBe('Coffee Brewing\n\nGrind fine.\nUse 95C water.');
    expect(c.row.inputHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('splits a note with H1/H2/H3 into intro + one chunk per section, in document order', () => {
    const content = [
      'Intro paragraph.',
      '',
      '# Section A',
      'Text A.',
      '',
      '## Section A.1',
      'Text A.1.',
      '',
      '### Section A.1.a',
      'Text A.1.a.',
      '',
      '# Section B',
      'Text B.',
    ].join('\n');
    const chunks = chunkNote('My Note.md', content);

    expect(chunks.map((c) => c.row.occurrenceId)).toEqual([
      'My Note.md#0',
      'My Note.md#1',
      'My Note.md#2',
      'My Note.md#3',
      'My Note.md#4',
    ]);
    expect(chunks.map((c) => c.row.breadcrumb)).toEqual([
      'My Note',
      'My Note > Section A',
      'My Note > Section A > Section A.1',
      'My Note > Section A > Section A.1 > Section A.1.a',
      'My Note > Section B',
    ]);

    // intro chunk breadcrumb is title only, and its text is the pre-heading content
    expect(chunks[0].embeddedText).toBe('My Note\n\nIntro paragraph.');

    // each subsequent chunk's embedded text starts with its breadcrumb + blank line,
    // includes the heading line itself, and stays within budget.
    for (const c of chunks) {
      expect(c.embeddedText.startsWith(`${c.row.breadcrumb}\n\n`)).toBe(true);
      expect(c.embeddedText.length).toBeLessThanOrEqual(MAX_EMBED_CHARS);
    }
    expect(chunks[1].embeddedText).toBe('My Note > Section A\n\n# Section A\nText A.');
    expect(chunks[2].embeddedText).toBe('My Note > Section A > Section A.1\n\n## Section A.1\nText A.1.');
    expect(chunks[3].embeddedText).toBe('My Note > Section A > Section A.1 > Section A.1.a\n\n### Section A.1.a\nText A.1.a.');
    expect(chunks[4].embeddedText).toBe('My Note > Section B\n\n# Section B\nText B.');
  });

  it('a heading path pops back correctly after a skipped depth (H1 -> H3 -> H2)', () => {
    const content = [
      '# One',
      'a',
      '### Three',
      'b',
      '## Two',
      'c',
    ].join('\n');
    const chunks = chunkNote('n.md', content);
    expect(chunks.map((c) => c.row.breadcrumb)).toEqual([
      'n > One',
      'n > One > Three',
      'n > One > Two',
    ]);
  });

  it('a note that starts with a heading has no intro chunk', () => {
    const chunks = chunkNote('n.md', '# Only Section\nBody.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].row.breadcrumb).toBe('n > Only Section');
    expect(chunks[0].row.occurrenceId).toBe('n.md#0');
  });

  it('hash is stable across calls and changes with content OR breadcrumb', () => {
    const a = chunkNote('a.md', 'same')[0].row.inputHash;
    expect(chunkNote('a.md', 'same')[0].row.inputHash).toBe(a);
    expect(chunkNote('a.md', 'different')[0].row.inputHash).not.toBe(a);
    // title is part of the embedded text (breadcrumb) => basename rename re-embeds (spec)
    expect(chunkNote('b.md', 'same')[0].row.inputHash).not.toBe(a);
    // folder move keeps title ⇒ same hash ⇒ re-embed is free (spec)
    expect(chunkNote('other/folder/a.md', 'same')[0].row.inputHash).toBe(a);
  });

  it('skips YAML frontmatter', () => {
    const plain = chunkNote('n.md', 'body text')[0];
    const fm = chunkNote('n.md', '---\ntags: [x]\n---\nbody text')[0];
    expect(fm.embeddedText).toBe(plain.embeddedText);
    expect(fm.row.inputHash).toBe(plain.row.inputHash);
  });

  it('empty note still yields a single title-only chunk', () => {
    const [c] = chunkNote('Ideas.md', '');
    expect(c.embeddedText).toBe('Ideas');
    expect(c.row.breadcrumb).toBe('Ideas');
    expect(c.row.occurrenceId).toBe('Ideas.md#0');
    expect(c.row.offsets).toEqual([0, 0]);
  });

  it('offsets of a section chunk map back to that section\'s text within the original content', () => {
    const content = '---\nk: v\n---\nIntro text\n\n# Heading One\nBody of section one.\n\n## Heading Two\nBody of section two.';
    const chunks = chunkNote('n.md', content);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      const [start, end] = c.row.offsets;
      const sliced = content.slice(start, end);
      // the embedded text is `${breadcrumb}\n\n${sectionText}` and sectionText === the offset slice
      expect(c.embeddedText).toBe(`${c.row.breadcrumb}\n\n${sliced}`);
    }
    // spot check the actual text for the intro section
    expect(content.slice(...chunks[0].row.offsets)).toBe('Intro text');
  });

  describe('bounded chunking of an oversized section', () => {
    // Non-periodic filler (each word is unique) so windows never coincide
    // textually — a naive periodic filler could produce byte-identical
    // windows when the step aligns with the period, making the
    // hash-uniqueness assertion below meaningless.
    const bigWords = Array.from({ length: 20000 }, (_, i) => `word${i}`).join(' '); // far exceeds MAX_EMBED_CHARS
    const content = [
      'Intro.',
      '',
      '# Huge Section',
      bigWords,
      '',
      '# Small Section',
      'Small body.',
    ].join('\n');
    const path = 'notes/Huge.md';

    it('windows the oversized section into multiple chunks sharing its breadcrumb, all within budget', () => {
      const chunks = chunkNote(path, content);
      expect(chunks.length).toBeGreaterThan(3); // intro + N windows of huge section + small section

      chunks.forEach((c, i) => {
        expect(c.row.occurrenceId).toBe(`${path}#${i}`);
        expect(c.embeddedText.length).toBeLessThanOrEqual(MAX_EMBED_CHARS);
      });

      const hugeChunks = chunks.filter((c) => c.row.breadcrumb === 'Huge > Huge Section');
      expect(hugeChunks.length).toBeGreaterThan(1);
      for (const c of hugeChunks) {
        expect(c.row.breadcrumb).toBe('Huge > Huge Section');
        expect(c.embeddedText.startsWith('Huge > Huge Section\n\n')).toBe(true);
      }

      // hashes differ across windows and are stable across calls
      const hashes = chunks.map((c) => c.row.inputHash);
      expect(new Set(hashes).size).toBe(hashes.length);
      const chunks2 = chunkNote(path, content);
      expect(chunks2.map((c) => c.row.inputHash)).toEqual(hashes);

      // the trailing "Small Section" still gets its own single chunk, after the windows
      const small = chunks[chunks.length - 1];
      expect(small.row.breadcrumb).toBe('Huge > Small Section');
      expect(small.embeddedText).toBe('Huge > Small Section\n\n# Small Section\nSmall body.');

      // union of the huge section's windows covers the whole section: the first
      // window starts exactly at the heading line, the last ends exactly where
      // the section's text ends (right before the next heading).
      const firstHuge = hugeChunks[0];
      const lastHuge = hugeChunks[hugeChunks.length - 1];
      const headingStart = content.indexOf('# Huge Section');
      const sectionTextEnd = content.indexOf('\n\n# Small Section');
      expect(firstHuge.row.offsets[0]).toBe(headingStart);
      expect(lastHuge.row.offsets[1]).toBe(sectionTextEnd);
    });

    it('offsets of a middle window slice the original content back to that window\'s text', () => {
      const chunks = chunkNote(path, content);
      const hugeChunks = chunks.filter((c) => c.row.breadcrumb === 'Huge > Huge Section');
      expect(hugeChunks.length).toBeGreaterThan(2);
      const mid = hugeChunks[1];
      const [start, end] = mid.row.offsets;
      const windowText = content.slice(start, end);
      expect(mid.embeddedText).toBe(`Huge > Huge Section\n\n${windowText}`);
    });
  });
});
