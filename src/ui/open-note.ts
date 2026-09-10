import { App, Notice, TFile } from 'obsidian';

/**
 * True iff `path` still resolves to a file in the vault. Deleted-file reconciliation is deferred
 * to a later phase, so the index can reference notes that no longer exist — every UI surface that
 * lists or opens a note must check this before showing/opening it.
 */
export function existsAsFile(app: App, path: string): boolean {
  return app.vault.getAbstractFileByPath(path) instanceof TFile;
}

/** Opens `path` (in a new leaf iff `newLeaf`), or shows a Notice and does nothing if it's gone. */
export function openNoteOrNotice(app: App, path: string, newLeaf: boolean): void {
  if (!existsAsFile(app, path)) {
    new Notice('Vane Search: that note no longer exists — run "Rebuild index from scratch"');
    return;
  }
  void app.workspace.openLinkText(path, '', newLeaf);
}
