import { App, PluginSettingTab, Plugin, Setting, Notice } from 'obsidian';
import { PRESETS, type VaneSettings } from './settings';

export interface SettingsHost {
  settings: VaneSettings;
  saveSettings(): Promise<void>;
  setApiKey(key: string): void;
  clearApiKey(): void;
  hasApiKey(): boolean;
  testConnection(): Promise<{ ok: boolean; dimension?: number; message: string }>;
  reindex(): Promise<void>;
}

export class VaneSettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private host: SettingsHost) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.host.settings;

    new Setting(containerEl).setName('Provider').setDesc('Where embeddings are computed. Local Ollama is private and free.')
      .addDropdown((d) => {
        for (const [k, p] of Object.entries(PRESETS)) d.addOption(k, p.label);
        d.setValue(s.providerId).onChange(async (v) => {
          const preset = PRESETS[v as keyof typeof PRESETS];
          Object.assign(s, { providerId: v, baseUrl: preset.baseUrl, model: preset.model, dimension: preset.dimension,
            queryPrefix: preset.queryPrefix, docPrefix: preset.docPrefix });
          await this.host.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl).setName('Base URL').addText((t) =>
      t.setValue(s.baseUrl).onChange(async (v) => { s.baseUrl = v.trim(); await this.host.saveSettings(); }));
    new Setting(containerEl).setName('Model').addText((t) =>
      t.setValue(s.model).onChange(async (v) => { s.model = v.trim(); await this.host.saveSettings(); }));
    new Setting(containerEl).setName('Embedding dimension').setDesc('Must match the model. "Test connection" fills this in.')
      .addText((t) => t.setValue(String(s.dimension)).onChange(async (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) { s.dimension = n; await this.host.saveSettings(); } }));

    new Setting(containerEl).setName('API key').setDesc('Stored in Obsidian SecretStorage, never in data.json. Leave blank for local Ollama.')
      .addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder(this.host.hasApiKey() ? '•••••• (saved)' : 'not set');
        t.onChange((v) => { if (v) this.host.setApiKey(v); else this.host.clearApiKey(); }); });

    new Setting(containerEl).setName('Test connection').setDesc('Embeds a probe string; on success, fills in the dimension.')
      .addButton((b) => b.setButtonText('Test').onClick(async () => {
        const r = await this.host.testConnection();
        new Notice(r.message);
        if (r.ok && r.dimension) { this.host.settings.dimension = r.dimension; await this.host.saveSettings(); this.display(); }
      }));

    new Setting(containerEl).setName('Minimum match score').setDesc('0-1, 0 = show all results regardless of relevance.')
      .addSlider((sl) => sl.setLimits(0, 1, 0.01).setValue(s.minScore).setDynamicTooltip()
        .onChange(async (v) => { s.minScore = v; await this.host.saveSettings(); }));

    new Setting(containerEl).setName('Exclude folder from Related notes').setDesc('e.g. your daily-notes folder; leave blank for none. Notes in it are still findable via search.')
      .addText((t) => t.setValue(s.relatedExcludeFolder).onChange(async (v) => { s.relatedExcludeFolder = v.trim(); await this.host.saveSettings(); }));

    new Setting(containerEl).setName('Rebuild index').setDesc('Re-embed the whole vault with the current provider.')
      .addButton((b) => b.setButtonText('Rebuild').setWarning().onClick(() => void this.host.reindex()));
  }
}
