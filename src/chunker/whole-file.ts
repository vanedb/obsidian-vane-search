import { hash64 } from '../hash';

/** Bumping this is an embedding-identity change: every note re-embeds. */
export const CHUNKER_VERSION = 1;

// Budget is in CHARACTERS as a conservative proxy for the embedding model's
// token limit (e.g. OpenAI text-embedding-3-small: 8191 tokens). ~12000 chars
// stays well under that limit even for dense scripts (Russian/CJK) where a
// token can cover as little as ~1 char, i.e. worst-case ~2 chars/token still
// leaves headroom below 8191 tokens.
export const MAX_EMBED_CHARS = 12000;
// Overlap (in body chars) between consecutive windows of an oversized note,
// so a fact split across a window boundary still has surrounding context in
// at least one chunk.
const OVERLAP = 200;

export interface ChunkRow {
  occurrenceId: string;
  inputHash: string;
  path: string;
  breadcrumb: string;
  offsets: [number, number];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function makeChunk(path: string, title: string, body: string, bodyOffset: number, index: number, start: number, end: number): { row: ChunkRow; embeddedText: string } {
  const slice = body.slice(start, end);
  const embeddedText = `${title}\n\n${slice}`;
  return {
    row: {
      occurrenceId: `${path}#${index}`, // '#' cannot appear in Obsidian file names
      inputHash: hash64(embeddedText),
      path,
      breadcrumb: title,
      offsets: [bodyOffset + start, bodyOffset + end],
    },
    embeddedText,
  };
}

export function chunkWholeFile(path: string, content: string): { row: ChunkRow; embeddedText: string }[] {
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

  // Guard against pathologically long titles eating the whole budget.
  const maxBody = Math.max(500, MAX_EMBED_CHARS - title.length - 2);

  if (body.length <= maxBody) {
    return [makeChunk(path, title, body, bodyOffset, 0, 0, body.length)];
  }

  const chunks: { row: ChunkRow; embeddedText: string }[] = [];
  const step = maxBody - OVERLAP;
  let start = 0;
  let index = 0;
  while (start < body.length) {
    const end = Math.min(start + maxBody, body.length);
    chunks.push(makeChunk(path, title, body, bodyOffset, index, start, end));
    if (end >= body.length) break;
    start += step;
    index += 1;
  }
  return chunks;
}
