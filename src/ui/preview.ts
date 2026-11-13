const PREVIEW_LEN = 140;

/**
 * Strips leading YAML frontmatter and a leading markdown heading, then collapses whitespace and
 * truncates. Line endings may be LF or CRLF: a vault synced from Windows keeps `\r\n`, and
 * frontmatter that is not stripped shows its keys in the search results.
 */
export function extractPreview(raw: string): string {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, '');
  const withoutHeading = body.replace(/^\s*#{1,6}\s+.*(\n|$)/, '');
  return withoutHeading.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN);
}
