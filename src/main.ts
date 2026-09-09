// src/main.ts
import { Notice, Plugin, TFile, requestUrl } from 'obsidian';
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
import { CHUNKER_VERSION, type ChunkRow } from './chunker/whole-file';
import { runFullIndex, type FileSource } from './indexer/full-index';
import { loadGenerationIntoIndex } from './indexer/load-generation';
import { SearchService, type ChunkMeta } from './search/search-service';
import { VaneSearchModal } from './ui/search-modal';
import { DEFAULT_SETTINGS, buildProvider, isLocalHost, type VaneSettings } from './settings/settings';
import { VaneSettingsTab, type SettingsHost } from './settings/settings-tab';
import { ConsentModal, needsConsent } from './ui/consent-modal';

const GRAPH_FINGERPRINT = 'dot:m16:ef200'; // bump on metric/params/vanedb format change

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
  private indexing = false;
  private unloaded = false;
  private indexReady = false;
  private initDone: Promise<void> = Promise.resolve();

  async onload() {
    await this.loadSettings();
    this.provider = this.makeProvider();

    // Light onload (spec): commands only; real init after layout is ready.
    this.addCommand({ id: 'open-search', name: 'Search vault semantically', callback: () => {
      if (!this.search) { new Notice('Vane Search is still starting'); return; }
      new VaneSearchModal(this.app, this.search, () => this.status).open();
    }});
    this.addCommand({ id: 'index-vault', name: 'Index vault', callback: () => void this.indexVault() });
    this.addCommand({ id: 'rebuild-index', name: 'Rebuild index (re-embed vault)', callback: () => void this.indexVault(true) });
    this.addSettingTab(new VaneSettingsTab(this.app, this, this.settingsHost()));
    this.statusEl = this.addStatusBarItem();
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
    this.statusEl?.setText(`Vane: ${s}`);
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
      client: this.client,
      resolve: (occ) => this.chunkMeta.get(occ),
      getGen: () => this.gen,
      getProviderFingerprint: () => embeddingFingerprint(this.provider, CHUNKER_VERSION),
    });

    if (this.gen) {
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
    try {
      // Settings may have changed since the provider was last built (e.g. via the settings tab).
      this.provider = this.makeProvider();
      const fp = embeddingFingerprint(this.provider, CHUNKER_VERSION);
      if (!this.gen || this.gen.embeddingFingerprint !== fp || force) {
        this.gen = newGeneration((this.gen?.generation ?? 0) + 1,
          { embeddingFingerprint: fp, graphFingerprint: GRAPH_FINGERPRINT, dim: this.provider.dimension() });
        await saveGeneration(this.db, this.gen);
        this.indexReady = false; // force the re-init below even if a later branch is added
      }
      if (!this.indexReady) {
        await this.client.init(this.gen.dim, capacityFor(this.app.vault.getMarkdownFiles().length));
        this.indexReady = true;
      }
      const res = await runFullIndex({
        db: this.db, source: this.fileSource(), provider: this.provider,
        client: this.client, gen: this.gen,
        onProgress: (done, total) => this.setStatus(`indexing ${done}/${total}`),
      });
      await activateGeneration(this.db, this.gen);
      await this.refreshChunkMeta();
      if (!this.unloaded) {
        this.setStatus(`ready (${Object.keys(this.gen.idMap).length} chunks)`);
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
    } finally {
      this.indexing = false;
    }
  }
}
