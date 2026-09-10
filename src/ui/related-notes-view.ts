import { ItemView, debounce } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { getVectors, reqAsPromise } from '../storage/vane-db';
import type { ChunkRow } from '../chunker/whole-file';
import { l2Normalize } from '../providers/embedding-provider';
import type { GenerationRecord } from '../storage/generation-store';
import type { IndexClient } from '../index/index-client';
import type { NoteResult, SearchService } from '../search/search-service';
import { existsAsFile, openNoteOrNotice } from './open-note';

export const RELATED_VIEW_TYPE = 'vane-related-notes';

const DEBOUNCE_MS = 300;
const RELATED_LIMIT = 15;

/**
 * What the panel needs from the plugin, read live — db/gen/client/search can all be null before
 * `initialize()` finishes, and gen/search are replaced on every reindex.
 */
export interface RelatedNotesHost {
  getDb(): IDBDatabase | null;
  getGen(): GenerationRecord | null;
  getClient(): IndexClient | null;
  getSearch(): SearchService | null;
}

export class RelatedNotesView extends ItemView {
  private closed = false;
  private recomputeDebounced = debounce(() => void this.recompute(), DEBOUNCE_MS, true);

  constructor(leaf: WorkspaceLeaf, private host: RelatedNotesHost) {
    super(leaf);
  }

  getViewType(): string { return RELATED_VIEW_TYPE; }
  getDisplayText(): string { return 'Related notes'; }
  getIcon(): string { return 'search'; }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.recomputeDebounced()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.recomputeDebounced()));
    await this.recompute();
  }

  async onClose(): Promise<void> {
    this.closed = true;
  }

  /** Every async path funnels through here so a thrown error renders a message, never bubbles. */
  private async recompute(): Promise<void> {
    try {
      await this.recomputeInner();
    } catch (e) {
      console.error('vane-search: related notes panel failed', e);
      this.renderMessage('Vane Search: could not compute related notes — see the developer console.');
    }
  }

  private async recomputeInner(): Promise<void> {
    if (this.closed) return;
    const db = this.host.getDb();
    const gen = this.host.getGen();
    const client = this.host.getClient();
    const search = this.host.getSearch();
    if (!db || !gen || !client || !search) {
      this.renderMessage('Vane Search is still starting.');
      return;
    }

    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      this.renderMessage('Open a note to see related notes.');
      return;
    }

    const tombstones = new Set(gen.tombstones);
    const prefix = `${file.path}#`;
    // O(live chunks) per navigation — fine at today's scale; a path→occurrences index would
    // avoid the full idMap scan if this ever shows up as a bottleneck.
    const occIds = Object.entries(gen.idMap)
      .filter(([vaneId, occ]) => occ.startsWith(prefix) && !tombstones.has(Number(vaneId)))
      .map(([, occ]) => occ);
    if (occIds.length === 0) {
      this.renderMessage('This note isn\'t indexed yet — run "Index new and changed notes".');
      return;
    }

    const vectors = await this.loadVectors(db, gen, occIds);
    if (this.closed) return;
    if (vectors.length === 0) {
      this.renderMessage('This note isn\'t indexed yet — run "Index new and changed notes".');
      return;
    }

    const centroid = l2Normalize(meanVector(vectors, gen.dim));
    const rawResults = await search.searchVector(centroid, RELATED_LIMIT, { excludePath: file.path });
    if (this.closed) return;
    // Deleted-but-indexed notes are dropped here too — reconciliation is deferred to a later phase.
    const results = rawResults.filter((r) => existsAsFile(this.app, r.path));
    this.render(results);
  }

  private async loadVectors(db: IDBDatabase, gen: GenerationRecord, occIds: string[]): Promise<Float32Array[]> {
    const chunkTx = db.transaction('chunks');
    const chunkStore = chunkTx.objectStore('chunks');
    const chunkRows = await Promise.all(
      occIds.map((id) => reqAsPromise<ChunkRow | undefined>(chunkStore.get(id)))
    );
    const inputHashes = chunkRows.filter((r): r is ChunkRow => !!r).map((r) => r.inputHash);
    if (inputHashes.length === 0) return [];

    const vectors = await getVectors(db, gen.embeddingFingerprint, inputHashes);
    return inputHashes.map((h) => vectors.get(h)).filter((v): v is Float32Array => !!v);
  }

  private renderMessage(text: string): void {
    if (this.closed) return;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vane-related-view');
    contentEl.createEl('p', { text, cls: 'vane-related-empty' });
  }

  private render(results: NoteResult[]): void {
    if (this.closed) return;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vane-related-view');
    contentEl.createEl('h4', { text: 'Related notes' });
    if (results.length === 0) {
      contentEl.createEl('p', { text: 'No strongly related notes.', cls: 'vane-related-empty' });
      return;
    }
    const list = contentEl.createEl('div', { cls: 'vane-related-list' });
    for (const r of results) {
      const item = list.createEl('div', { cls: 'vane-related-item' });
      item.createEl('div', { text: r.breadcrumb });
      const pct = Math.round(Math.max(0, r.score) * 100);
      item.createEl('small', { text: `${r.path} · ${pct}%` });
      item.addEventListener('click', (evt: MouseEvent) => {
        openNoteOrNotice(this.app, r.path, evt.metaKey || evt.ctrlKey);
      });
    }
  }
}

/** Component-wise mean of same-dimension vectors. Caller L2-normalizes the result. */
export function meanVector(vectors: Float32Array[], dim: number): Float32Array {
  const sum = new Float32Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  for (let i = 0; i < dim; i++) sum[i] /= vectors.length;
  return sum;
}
