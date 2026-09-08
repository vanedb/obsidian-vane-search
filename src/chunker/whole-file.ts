import { hash64 } from '../hash';

/** Bumping this is an embedding-identity change: every note re-embeds. */
export const CHUNKER_VERSION = 0;

export interface ChunkRow {
  occurrenceId: string;
  inputHash: string;
  path: string;
  breadcrumb: string;
  offsets: [number, number];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function chunkWholeFile(path: string, content: string): { row: ChunkRow; embeddedText: string }[] {
  const title = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
  const fmMatch = content.match(FRONTMATTER);
  const bodyStart = fmMatch ? fmMatch[0].length : 0;
  const body = content.slice(bodyStart).trim();
  const bodyOffset = bodyStart + content.slice(bodyStart).indexOf(body);
  const embeddedText = body ? `${title}\n\n${body}` : title;
  return [{
    row: {
      occurrenceId: `${path}#0`, // '#' cannot appear in Obsidian file names
      inputHash: hash64(embeddedText),
      path,
      breadcrumb: title,
      offsets: body ? [bodyOffset, bodyOffset + body.length] : [0, 0],
    },
    embeddedText,
  }];
}
