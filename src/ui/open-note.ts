import { App, Notice, TFile } from 'obsidian';

/**
 * True iff `path` still resolves to a file in the vault. Deleted-file reconciliation is deferred
 * to a later phase, so the index can reference notes that no longer exist — every UI surface that
 * lists or opens a note must check this before showing/opening it.
 */
export function existsAsFile(app: App, path: string): boolean {
  return app.vault.getAbstractFileByPath(path) instanceof TFile;
}

/**
 * Opens `path` (in a new leaf iff `newLeaf`), or shows a Notice and does nothing if it's gone.
 * When `heading` is given, opens with a heading anchor (`path#heading`) so Obsidian scrolls to
 * that section; if the heading appears more than once in the note, Obsidian jumps to the first.
 */
export function openNoteOrNotice(app: App, path: string, newLeaf: boolean, heading?: string): void {
  if (!existsAsFile(app, path)) {
    new Notice('Vane Search: that note no longer exists — run "Rebuild index from scratch"');
    return;
  }
  const linkText = heading ? `${path}#${heading}` : path;
  void app.workspace.openLinkText(linkText, '', newLeaf);
}

/**
 * Extracts the matched section's heading from a `NoteResult.breadcrumb` (a `NoteTitle > H1 > H2`
 * trail) — the last ` > `-separated segment. Returns undefined for an intro/no-heading match
 * (breadcrumb has no ` > `), so the caller opens the note at its top instead of a bogus anchor.
 */
export function headingFromBreadcrumb(breadcrumb: string): string | undefined {
  if (!breadcrumb.includes(' > ')) return undefined;
  const parts = breadcrumb.split(' > ');
  return parts[parts.length - 1];
}
