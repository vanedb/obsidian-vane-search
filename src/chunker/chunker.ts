import { hash64 } from '../hash';

/** Bumping this is an embedding-identity change: every note re-embeds. */
export const CHUNKER_VERSION = 2;

// Budget is in CHARACTERS as a conservative proxy for the embedding model's
// token limit (e.g. OpenAI text-embedding-3-small: 8191 tokens). ~12000 chars
// stays well under that limit even for dense scripts (Russian/CJK) where a
// token can cover as little as ~1 char, i.e. worst-case ~2 chars/token still
// leaves headroom below 8191 tokens.
export const MAX_EMBED_CHARS = 12000;
// Overlap (in section-body chars) between consecutive windows of an oversized
// section, so a fact split across a window boundary still has surrounding
// context in at least one chunk.
const OVERLAP = 200;

export interface ChunkRow {
  occurrenceId: string;
  inputHash: string;
  path: string;
  breadcrumb: string;
  offsets: [number, number];
}

type Chunk = { row: ChunkRow; embeddedText: string };

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
// ATX headings only (`^#{1,6} `). Setext headings (underlined with ===/---)
// are out of scope — a naive check would misfire on '---' frontmatter-style
// dividers and horizontal rules, and ATX covers the overwhelming majority of
// real notes.
const ATX_HEADING = /^(#{1,6}) (.*)$/;

/** Split `text` into lines, each tagged with its start offset within `text`. */
function splitLines(text: string): { text: string; start: number }[] {
  const lines: { text: string; start: number }[] = [];
  let pos = 0;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      lines.push({ text: text.slice(pos).replace(/\r$/, ''), start: pos });
      return lines;
    }
    lines.push({ text: text.slice(pos, nl).replace(/\r$/, ''), start: pos });
    pos = nl + 1;
  }
}

/** Tighten [start, end) in `s` past any leading/trailing whitespace. */
function trimRange(s: string, start: number, end: number): [number, number] {
  let a = start;
  let b = end;
  while (a < b && /\s/.test(s[a])) a++;
  while (b > a && /\s/.test(s[b - 1])) b--;
  return [a, b];
}

interface Section {
  breadcrumb: string;
  start: number; // body-relative, whitespace-trimmed
  end: number;   // body-relative, whitespace-trimmed
}

/**
 * Split a note body into heading-delimited sections. A section is a heading
 * line plus its content up to the next heading (of any level); content before
 * the first heading (if any) is the "intro" section, breadcrumb = title only.
 * A single forward pass tracks a heading-path stack: entering an H{n} pops
 * the stack to depth n-1, then pushes the new heading text.
 */
function splitSections(title: string, body: string): Section[] {
  const headings = splitLines(body)
    .map((l) => ({ m: ATX_HEADING.exec(l.text), start: l.start }))
    .filter((h): h is { m: RegExpExecArray; start: number } => h.m !== null)
    .map((h) => ({ level: h.m[1].length, text: h.m[2].trim(), start: h.start }));

  const sections: Section[] = [];

  const firstHeadingStart = headings.length ? headings[0].start : body.length;
  if (firstHeadingStart > 0) {
    const [a, b] = trimRange(body, 0, firstHeadingStart);
    sections.push({ breadcrumb: title, start: a, end: b });
  }

  let stack: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    stack = stack.slice(0, h.level - 1);
    stack.push(h.text);
    const rawEnd = i + 1 < headings.length ? headings[i + 1].start : body.length;
    const [a, b] = trimRange(body, h.start, rawEnd);
    sections.push({ breadcrumb: [title, ...stack].join(' > '), start: a, end: b });
  }
  return sections;
}

function makeChunk(path: string, breadcrumb: string, sectionText: string, sectionOffset: number, index: number, start: number, end: number): Chunk {
  const slice = sectionText.slice(start, end);
  const embeddedText = `${breadcrumb}\n\n${slice}`;
  return {
    row: {
      occurrenceId: `${path}#${index}`, // '#' cannot appear in Obsidian file names
      inputHash: hash64(embeddedText),
      path,
      breadcrumb,
      offsets: [sectionOffset + start, sectionOffset + end],
    },
    embeddedText,
  };
}

export function chunkNote(path: string, content: string): Chunk[] {
  const title = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
  const fmMatch = content.match(FRONTMATTER);
  const bodyStart = fmMatch ? fmMatch[0].length : 0;
  const body = content.slice(bodyStart).trim();
  const bodyOffset = bodyStart + content.slice(bodyStart).indexOf(body);

  if (!body) {
    const embeddedText = title;
    return [{
      row: {
        occurrenceId: `${path}#0`,
        inputHash: hash64(embeddedText),
        path,
        breadcrumb: title,
        offsets: [0, 0],
      },
      embeddedText,
    }];
  }

  const chunks: Chunk[] = [];
  let index = 0;
  for (const section of splitSections(title, body)) {
    const sectionText = body.slice(section.start, section.end);
    const sectionOffset = bodyOffset + section.start;
    // Guard against a pathologically long breadcrumb eating the whole budget.
    const maxBody = Math.max(500, MAX_EMBED_CHARS - section.breadcrumb.length - 2);

    if (sectionText.length <= maxBody) {
      chunks.push(makeChunk(path, section.breadcrumb, sectionText, sectionOffset, index, 0, sectionText.length));
      index++;
      continue;
    }

    const step = maxBody - OVERLAP;
    let start = 0;
    while (start < sectionText.length) {
      const end = Math.min(start + maxBody, sectionText.length);
      chunks.push(makeChunk(path, section.breadcrumb, sectionText, sectionOffset, index, start, end));
      index++;
      if (end >= sectionText.length) break;
      start += step;
    }
  }
  return chunks;
}
