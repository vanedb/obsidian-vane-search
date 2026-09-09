import { App, SuggestModal } from 'obsidian';
import { ProviderMismatchError, type SearchService, type NoteResult } from '../search/search-service';
import { RequestGate } from './request-gate';

const DEBOUNCE_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VaneSearchModal extends SuggestModal<NoteResult> {
  private gate = new RequestGate();
  private last: NoteResult[] = [];

  constructor(app: App, private svc: SearchService, private indexStatus: () => string) {
    super(app);
    this.setPlaceholder('Semantic search…');
  }

  async getSuggestions(query: string): Promise<NoteResult[]> {
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
    this.last = results;
    this.emptyStateText = results.length ? '' : `No results — ${this.indexStatus()}`;
    return results;
  }

  renderSuggestion(r: NoteResult, el: HTMLElement): void {
    el.createEl('div', { text: r.breadcrumb });
    el.createEl('small', { text: `${r.path} · ${r.score.toFixed(2)}` });
  }

  onChooseSuggestion(r: NoteResult): void {
    void this.app.workspace.openLinkText(r.path, '', false);
  }
}
