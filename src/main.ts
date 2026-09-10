// src/main.ts
import { debounce, Editor, Notice, Plugin, TAbstractFile, TFile, requestUrl, setIcon, type Debouncer } from 'obsidian';
import { openVaneDb, reqAsPromise } from './storage/vane-db';
import {
  newGeneration, saveGeneration, activateGeneration, loadActiveGeneration,
  type GenerationRecord,
} from './storage/generation-store';
import { IndexClient, workerTransport } from './index/index-client';
import { spawnIndexWorker } from './index/spawn-worker';
import { capacityFor } from './index/vane-index';
import { embeddingFingerprint, type EmbeddingProvider } from './providers/embedding-provider';
import { EmbeddingError } from './providers/openai-compat';
import { requestUrlPost } from './providers/http';
import { CHUNKER_VERSION, type ChunkRow } from './chunker/chunker';
import { runFullIndex, type FileSource } from './indexer/full-index';
import { loadGenerationIntoIndex } from './indexer/load-generation';
import { reconcileDeletions, removePaths } from './indexer/reconcile';
import { SearchService, type ChunkMeta } from './search/search-service';
import { VaneSearchModal } from './ui/search-modal';
import { RelatedNotesView, RELATED_VIEW_TYPE, type RelatedNotesHost } from './ui/related-notes-view';
import { DEFAULT_SETTINGS, buildProvider, isLocalHost, type VaneSettings } from './settings/settings';
import { VaneSettingsTab, type SettingsHost } from './settings/settings-tab';
import { ConsentModal, needsConsent } from './ui/consent-modal';

const GRAPH_FINGERPRINT = 'dot:m16:ef200'; // bump on metric/params/vanedb format change
const LIVE_DEBOUNCE_MS = 1500; // coalesce rapid edits/create bursts per path

export default class VaneSearchPlugin extends Plugin {
  private db: IDBDatabase | null = null;
  private worker: Worker | null = null;
  private client: IndexClient | null = null;
  private gen: GenerationRecord | null = null;
  private chunkMeta = new Map<string, ChunkMeta>();
  private vaneSettings: VaneSettings = { ...DEFAULT_SETTINGS };
  private apiKeyId = 'vane-search-api-key';
  private post = requestUrlPost(requestUrl as unknown as Parameters<typeof requestUrlPost>[0]);
  private provider!: EmbeddingProvider; // built from settings in onload(), after loadSettings()
  private search: SearchService | null = null;
  private status = 'starting';
  private statusEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private indexing = false;
  private unloaded = false;
  private indexReady = false;
  private initDone: Promise<void> = Promise.resolve();
  /** Single serialization point: every reconcile/reindex — manual command or live vault
   *  event — runs as one link in this chain, so none of them ever overlap. */
  private work: Promise<void> = Promise.resolve();
  private pathDebouncers = new Map<string, Debouncer<[], void>>();

  async onload() {
    await this.loadSettings();
    this.provider = this.makeProvider();

    // Light onload (spec): commands only; real init after layout is ready.
    this.addCommand({ id: 'open-search', name: 'Search vault semantically', callback: () => this.openSearch() });
    this.addCommand({ id: 'index-vault', name: 'Index new and changed notes', callback: () => void this.indexVault() });
    this.addCommand({ id: 'rebuild-index', name: 'Rebuild index from scratch', callback: () => void this.indexVault(true) });
    this.addCommand({
      id: 'search-selection',
      name: 'Find notes similar to selection',
      editorCallback: (editor: Editor) => this.searchSelection(editor),
    });
    this.addCommand({
      id: 'open-related',
      name: 'Open related notes panel',
      callback: () => void this.openRelatedPanel(),
    });
    this.registerView(RELATED_VIEW_TYPE, (leaf) => new RelatedNotesView(leaf, this.relatedNotesHost()));
    this.addSettingTab(new VaneSettingsTab(this.app, this, this.settingsHost()));
    this.addRibbonIcon('search', 'Vane Search: search vault', () => this.openSearch());
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable');
    setIcon(this.statusEl.createSpan({ cls: 'vane-status-icon' }), 'search');
    this.statusTextEl = this.statusEl.createSpan({ cls: 'vane-status-text' });
    this.statusEl.onClickEvent(() => this.openSearch());
    this.setStatus('starting');
    this.app.workspace.onLayoutReady(() => {
      this.initDone = this.initialize().catch((e) => {
        console.error('vane-search init failed', e);
        this.setStatus('error — see console');
      });
    });
  }

  onunload() {
    this.unloaded = true;
    for (const d of this.pathDebouncers.values()) d.cancel();
    this.pathDebouncers.clear();
    this.app.workspace.detachLeavesOfType(RELATED_VIEW_TYPE);
    this.worker?.terminate();
    this.db?.close();
  }

  private async loadSettings() {
    this.vaneSettings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) ?? {});
    // Object.assign shallow-copies: on first run (no saved data) consentedHosts would
    // otherwise alias the module-level DEFAULT_SETTINGS.consentedHosts singleton, and the
    // consent handler's .push would mutate it across plugin instances/vaults. Clone it.
    this.vaneSettings.consentedHosts = [...this.vaneSettings.consentedHosts];
  }

  async saveSettings() { await this.saveData(this.vaneSettings); }

  /** Reads the stored API key. An empty string (left by clearApiKey) counts as "no key". */
  private secret(): string | null {
    try {
      const s = this.app.secretStorage?.getSecret?.(this.apiKeyId) ?? null;
      return s ? s : null;
    } catch { return null; }
  }

  private makeProvider(): EmbeddingProvider {
    return buildProvider(this.vaneSettings, this.secret(), this.post);
  }


  private settingsHost(): SettingsHost {
    return {
      settings: this.vaneSettings,
      saveSettings: () => this.saveSettings(),
      setApiKey: (key: string) => {
        this.app.secretStorage.setSecret(this.apiKeyId, key);
        this.vaneSettings.hasApiKey = true;
        void this.saveSettings();
        this.provider = this.makeProvider();
      },
      clearApiKey: () => {
        try { this.app.secretStorage.setSecret(this.apiKeyId, ''); } catch { /* ignore */ }
        this.vaneSettings.hasApiKey = false;
        void this.saveSettings();
        this.provider = this.makeProvider();
      },
      hasApiKey: () => !!this.secret(),
      testConnection: async () => {
        try {
          const provider = this.makeProvider();
          const vecs = await provider.embed(['vane search connection test'], 'query');
          return { ok: true, dimension: vecs[0]?.length ?? provider.dimension(), message: 'Connected' };
        } catch (e) {
          const message = e instanceof EmbeddingError ? e.failure.message : String(e);
          return { ok: false, message };
        }
      },
      reindex: () => this.indexVault(true),
    };
  }

  private setStatus(s: string) {
    this.status = s;
    this.statusTextEl?.setText(`Vane: ${s}`);
  }

  private openSearch() {
    if (!this.search) { new Notice('Vane Search is still starting'); return; }
    new VaneSearchModal(this.app, this.search, () => this.status).open();
  }

  private searchSelection(editor: Editor) {
    const selection = editor.getSelection();
    if (!selection.trim()) { new Notice('Vane Search: select some text first'); return; }
    if (!this.search) { new Notice('Vane Search is still starting'); return; }
    new VaneSearchModal(this.app, this.search, () => this.status, selection).open();
  }

  private relatedNotesHost(): RelatedNotesHost {
    return {
      getDb: () => this.db,
      getGen: () => this.gen,
      getClient: () => this.client,
      getSearch: () => this.search,
      getRelatedExcludeFolder: () => this.vaneSettings.relatedExcludeFolder,
    };
  }

  private async openRelatedPanel() {
    const existing = this.app.workspace.getLeavesOfType(RELATED_VIEW_TYPE);
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) { new Notice('Vane Search: could not open the related-notes panel'); return; }
    await leaf.setViewState({ type: RELATED_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private vaultId(): string {
    return (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
  }

  private fileSource(): FileSource {
    return {
      list: () => this.app.vault.getMarkdownFiles()
        .map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })),
      read: async (path) => {
        const af = this.app.vault.getAbstractFileByPath(path);
        if (!(af instanceof TFile)) throw new Error(`not a file: ${path}`);
        return this.app.vault.cachedRead(af);
      },
    };
  }

  private singleFileSource(file: TFile): FileSource {
    return {
      list: () => [{ path: file.path, mtime: file.stat.mtime, size: file.stat.size }],
      read: async () => this.app.vault.cachedRead(file),
    };
  }

  /** Serializes `op` after every previously-enqueued op. Never rejects: an error here is
   *  the failure mode for the whole live-sync path (manual "Index vault"/"Rebuild" keep
   *  their own try/catch for richer messaging), so this is the catch-all — log, surface a
   *  Notice + status, keep the chain alive for the next op. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    this.work = this.work.then(op).catch((e) => {
      console.error('vane-search: background sync failed', e);
      if (!this.unloaded) {
        this.setStatus('sync failed — see console');
        new Notice('Vane Search: keeping the index in sync failed — see the developer console.');
      }
    });
    return this.work;
  }

  /** Re-embeds/tombstones exactly one file via the same `runFullIndex` used for the full
   *  vault index — no separate per-file indexer, just a FileSource that lists one path. */
  private async reindexFile(path: string) {
    if (this.unloaded || !this.indexReady || !this.db || !this.client || !this.gen) return;
    // Provider switched (e.g. new API key) without a "Rebuild" — expected, not an error:
    // the stale generation keeps serving search (already gated by ProviderMismatchError),
    // so quietly skip live reindexing rather than throwing/Notice-ing on every edit.
    // runFullIndex itself refuses this combination too (belt-and-suspenders); this check
    // just keeps that from surfacing as a scary "sync failed" Notice.
    if (embeddingFingerprint(this.provider, CHUNKER_VERSION) !== this.gen.embeddingFingerprint) return;
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile)) return; // gone already — the delete/rename handler owns this path now
    await runFullIndex({
      db: this.db, source: this.singleFileSource(af), provider: this.provider,
      client: this.client, gen: this.gen,
    });
    await this.refreshChunkMeta();
    if (!this.unloaded) this.setStatus(`ready (${Object.keys(this.gen.idMap).length} chunks)`);
  }

  /** Tombstones every occurrence still mapped under `path` — a targeted single-path
   *  removal (no whole-vault present-set scan; that's `reconcileDeletions`' job at startup). */
  private async removePath(path: string) {
    if (this.unloaded || !this.indexReady || !this.db || !this.gen) return;
    const { removed } = await removePaths({ db: this.db, gen: this.gen, paths: new Set([path]) });
    if (removed > 0) {
      await this.refreshChunkMeta();
      if (!this.unloaded) this.setStatus(`ready (${Object.keys(this.gen.idMap).length} chunks)`);
    }
  }

  private scheduleReindex(path: string) {
    if (this.unloaded) return;
    let d = this.pathDebouncers.get(path);
    if (!d) {
      d = debounce(() => {
        this.pathDebouncers.delete(path); // debounce fired — don't keep this entry around forever
        void this.enqueue(() => this.reindexFile(path));
      }, LIVE_DEBOUNCE_MS, true);
      this.pathDebouncers.set(path, d);
    }
    d();
  }

  private scheduleRemove(path: string) {
    if (this.unloaded) return;
    this.pathDebouncers.get(path)?.cancel();
    this.pathDebouncers.delete(path);
    void this.enqueue(() => this.removePath(path));
  }

  private isMdFile(f: TAbstractFile): f is TFile {
    return f instanceof TFile && f.extension === 'md';
  }

  /** Live vault-event wiring (spec section D). Registered once init is ready; each handler
   *  is a thin adapter onto the two reused primitives — reconcileDeletions and runFullIndex
   *  (via reindexFile/removePath) — debounced and serialized through `enqueue`. */
  private registerVaultSync() {
    const onCreateOrModify = (f: TAbstractFile) => {
      if (this.isMdFile(f)) this.scheduleReindex(f.path);
    };
    this.registerEvent(this.app.vault.on('create', onCreateOrModify));
    this.registerEvent(this.app.vault.on('modify', onCreateOrModify));
    this.registerEvent(this.app.vault.on('delete', (f) => {
      if (this.isMdFile(f)) this.scheduleRemove(f.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
      if (oldPath.toLowerCase().endsWith('.md')) this.scheduleRemove(oldPath);
      if (this.isMdFile(f)) this.scheduleReindex(f.path);
    }));
  }

  private async refreshChunkMeta() {
    if (!this.db) return;
    const rows = await reqAsPromise<ChunkRow[]>(
      this.db.transaction('chunks').objectStore('chunks').getAll());
    this.chunkMeta = new Map(rows.map((r) => [r.occurrenceId, { path: r.path, breadcrumb: r.breadcrumb }]));
  }

  private async initialize() {
    this.db = await openVaneDb(this.vaultId());
    if (this.unloaded) { this.db.close(); this.db = null; return; }
    void navigator.storage?.persist?.(); // spec: request durable storage, degrade gracefully
    void navigator.storage?.estimate?.().then((e) => console.debug('vane-search: storage estimate', e));
    this.worker = spawnIndexWorker();
    if (this.unloaded) { this.worker.terminate(); this.worker = null; this.db.close(); this.db = null; return; }
    this.client = new IndexClient(workerTransport(this.worker));

    this.gen = await loadActiveGeneration(this.db);
    const fp = embeddingFingerprint(this.provider, CHUNKER_VERSION);
    if (this.gen && this.gen.embeddingFingerprint !== fp) {
      // Provider/identity changed since last index — surface a rebuild hint (the full rebuild/keep-read-only modal is deferred to a later phase).
      new Notice('Vane Search: index was built with a different provider — run "Index vault" to rebuild.');
    }

    this.search = new SearchService({
      getProvider: () => this.provider,
      getClient: () => this.client!,
      resolve: (occ) => this.chunkMeta.get(occ),
      getGen: () => this.gen,
      getProviderFingerprint: () => embeddingFingerprint(this.provider, CHUNKER_VERSION),
      getFloor: () => this.vaneSettings.minScore,
    });

    if (this.gen) {
      // Reconcile BEFORE loadGenerationIntoIndex: notes deleted while the plugin was off,
      // or a deletion synced in from another device, must not get rebuilt into the worker
      // just to be searchable-but-dead. Cheap — one pass over the live idMap.
      const presentPaths = new Set(this.app.vault.getMarkdownFiles().map((f) => f.path));
      await reconcileDeletions({ db: this.db, gen: this.gen, presentPaths });

      const total = Object.keys(this.gen.idMap).length;
      await this.client.init(this.gen.dim, capacityFor(total + this.gen.tombstones.length));
      this.indexReady = true;
      await this.refreshChunkMeta();
      const { missing } = await loadGenerationIntoIndex({
        db: this.db, client: this.client, gen: this.gen,
        onProgress: (done, t) => this.setStatus(`index building ${done}/${t}`),
      });
      if (missing.length) console.warn('vane-search: drift, missing rows for', missing);
      this.setStatus(`ready (${total - missing.length} chunks)`);
    } else if (!isLocalHost(this.vaneSettings.baseUrl) && !this.secret()) {
      this.setStatus('needs API key');
    } else {
      this.setStatus('no index — run "Index vault"');
    }

    this.registerVaultSync();
  }

  /**
   * Builds `buildGen` to completion in a brand-new worker/client — spawn, init, runFullIndex —
   * and returns them. Never touches `this.worker`/`this.client`/`this.gen`: the OLD ones keep
   * serving search for the whole call. Throws (after terminating the build worker) on any
   * failure — embedding error, fingerprint guard in runFullIndex, worker crash, or the plugin
   * unloading mid-build — so the caller's try/catch is the single place that decides what a
   * failure means; this helper's only job on failure is "don't leak the worker".
   */
  private async buildGenerationInNewWorker(
    buildGen: GenerationRecord,
  ): Promise<{ worker: Worker; client: IndexClient; res: { indexed: number; skipped: number } }> {
    const worker = spawnIndexWorker();
    if (this.unloaded) { worker.terminate(); throw new Error('vane-search: unloaded during rebuild'); }
    const client = new IndexClient(workerTransport(worker));
    try {
      await client.init(buildGen.dim, capacityFor(this.app.vault.getMarkdownFiles().length));
      if (this.unloaded) throw new Error('vane-search: unloaded during rebuild');
      const res = await runFullIndex({
        db: this.db!, source: this.fileSource(), provider: this.provider,
        client, gen: buildGen,
        onProgress: (done, total) => this.setStatus(`rebuilding ${done}/${total}`),
      });
      if (this.unloaded) throw new Error('vane-search: unloaded during rebuild');
      return { worker, client, res };
    } catch (e) {
      worker.terminate();
      throw e;
    }
  }

  private async indexVault(force = false) {
    await this.initDone;
    if (!this.db || !this.client) { new Notice('Vane Search is still starting'); return; }

    const baseUrl = this.vaneSettings.baseUrl;
    if (!isLocalHost(baseUrl) && !this.secret()) {
      new Notice('Vane Search: set your API key in Settings → Vane Search to start indexing.');
      this.setStatus('needs API key');
      return;
    }
    if (needsConsent(baseUrl, this.vaneSettings.consentedHosts)) {
      let host: string;
      try { host = new URL(baseUrl).host; } catch { host = baseUrl; }
      new ConsentModal(this.app, host, () => {
        this.vaneSettings.consentedHosts.push(host);
        void this.saveSettings().then(() => void this.indexVault(force));
      }).open();
      return;
    }

    if (this.indexing) { new Notice('Vane Search: indexing is already running'); return; }
    this.indexing = true;
    // Serialized with any in-flight/queued live-event work (create/modify/rename/delete
    // reconcile) through the same `work` chain — a manual index never overlaps a background
    // reindex on the shared `gen`/`db`/`client` state.
    await this.enqueue(async () => {
      try {
        // Settings may have changed since the provider was last built (e.g. via the settings tab).
        this.provider = this.makeProvider();
        const fp = embeddingFingerprint(this.provider, CHUNKER_VERSION);
        const isFullRebuild = force || !this.gen || this.gen.embeddingFingerprint !== fp;

        let res: { indexed: number; skipped: number };
        if (isFullRebuild) {
          // Full rebuild: build the new generation in a SECOND worker while the OLD worker +
          // OLD `this.gen` keep serving search. Only on success do we activate + swap; on any
          // failure the old worker/gen/client are untouched, so a failed rebuild leaves the
          // plugin exactly as it was.
          const buildGen = newGeneration((this.gen?.generation ?? 0) + 1,
            { embeddingFingerprint: fp, graphFingerprint: GRAPH_FINGERPRINT, dim: this.provider.dimension() });
          await saveGeneration(this.db!, buildGen);

          const built = await this.buildGenerationInNewWorker(buildGen);
          res = built.res;

          await activateGeneration(this.db!, buildGen);
          // Atomic swap: search reads `this.client`/`this.gen` live (SearchService.getClient/
          // getGen), so from here on every search transparently hits the newly-built index.
          const oldWorker = this.worker;
          this.worker = built.worker;
          this.client = built.client;
          this.gen = buildGen;
          this.indexReady = true;
          oldWorker?.terminate();
        } else {
          // Incremental: fingerprint unchanged, same generation — insert straight into the
          // current serving worker, exactly as before. No second worker, no swap.
          res = await runFullIndex({
            db: this.db!, source: this.fileSource(), provider: this.provider,
            client: this.client!, gen: this.gen!,
            onProgress: (done, total) => this.setStatus(`indexing ${done}/${total}`),
          });
          await activateGeneration(this.db!, this.gen!);
        }

        await this.refreshChunkMeta();
        if (!this.unloaded) {
          this.setStatus(`ready (${Object.keys(this.gen!.idMap).length} chunks)`);
          new Notice(`Vane Search: indexed ${res.indexed}, unchanged ${res.skipped}`);
        }
      } catch (e) {
        console.error('vane-search: indexing failed', e);
        if (!this.unloaded) {
          if (e instanceof EmbeddingError) {
            const userMsg = (
              e.failure.kind === 'auth' ? 'authentication failed — check the API key' :
              e.failure.kind === 'rate-limit' ? 'rate limited, try again later' :
              e.failure.kind === 'network' ? `cannot reach ${baseUrl}` :
              e.failure.kind === 'bad-response' ? 'unexpected response from the provider' :
              e.failure.message
            );
            this.setStatus(`indexing failed — ${userMsg}`);
            new Notice(`Vane Search: ${userMsg}`);
          } else {
            this.setStatus('indexing failed — see console');
            new Notice('Vane Search: indexing failed — see the developer console.');
          }
        }
      }
    }).finally(() => { this.indexing = false; });
  }
}
