import { App, SuggestModal, TFile } from 'obsidian';
import { ProviderMismatchError, type SearchService, type NoteResult } from '../search/search-service';
import { RequestGate } from './request-gate';

const DEBOUNCE_MS = 300;
const PREVIEW_LEN = 140;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A NoteResult plus an optional text snippet for display — local to the modal, not part of the search-service contract. */
type SearchResult = NoteResult & { preview?: string };

/** Strips leading YAML frontmatter and a leading markdown heading, then collapses whitespace and truncates. */
function extractPreview(raw: string): string {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  const withoutHeading = body.replace(/^\s*#{1,6}\s+.*(\n|$)/, '');
  return withoutHeading.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN);
}

export class VaneSearchModal extends SuggestModal<SearchResult> {
  private gate = new RequestGate();
  private last: SearchResult[] = [];

  constructor(app: App, private svc: SearchService, private indexStatus: () => string) {
    super(app);
    this.setPlaceholder('Semantic search…');
  }

  async getSuggestions(query: string): Promise<SearchResult[]> {
    const token = this.gate.issue(); // issued even for empty input — invalidates in-flight searches
    if (!query.trim()) { this.last = []; return []; }
    await sleep(DEBOUNCE_MS); // debounce: newest keystroke wins
    if (!this.gate.isCurrent(token)) return this.last;
    let results: NoteResult[];
    try {
      results = await this.svc.search(query);
    } catch (e) {
      console.error('vane-search: search failed', e);
      if (!this.gate.isCurrent(token)) return this.last;
      this.last = [];
      this.emptyStateText = e instanceof ProviderMismatchError
        ? e.message
        : 'Search failed — see the developer console';
      return [];
    }
    if (!this.gate.isCurrent(token)) return this.last;
    // Attach a short preview per result (capped to the results shown, i.e. the search limit).
    const withPreviews: SearchResult[] = await Promise.all(
      results.map(async (r) => ({ ...r, preview: await this.loadPreview(r.path) }))
    );
    if (!this.gate.isCurrent(token)) return this.last;
    this.last = withPreviews;
    this.emptyStateText = withPreviews.length ? '' : `No results — ${this.indexStatus()}`;
    return withPreviews;
  }

  /** Best-effort snippet read — a missing/paused/unreadable file must never break search. */
  private async loadPreview(path: string): Promise<string | undefined> {
    try {
      const af = this.app.vault.getAbstractFileByPath(path);
      if (!(af instanceof TFile)) return undefined;
      const text = await this.app.vault.cachedRead(af);
      return extractPreview(text) || undefined;
    } catch (e) {
      console.debug('vane-search: preview read failed', path, e);
      return undefined;
    }
  }

  renderSuggestion(r: SearchResult, el: HTMLElement): void {
    el.createEl('div', { text: r.breadcrumb });
    const pct = Math.round(Math.max(0, r.score) * 100);
    el.createEl('small', { text: `${r.path} · ${pct}%` });
    if (r.preview) el.createEl('small', { cls: 'vane-search-preview', text: r.preview });
  }

  onChooseSuggestion(r: SearchResult): void {
    void this.app.workspace.openLinkText(r.path, '', false);
  }
}
