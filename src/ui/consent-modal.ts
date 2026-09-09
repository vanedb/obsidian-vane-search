import { App, Modal, Setting } from 'obsidian';
import { isLocalHost } from '../settings/settings';

/** A remote host that the user has not yet acknowledged needs consent before note text leaves the device. */
export function needsConsent(baseUrl: string, consentedHosts: string[]): boolean {
  if (isLocalHost(baseUrl)) return false;
  try { return !consentedHosts.includes(new URL(baseUrl).host); } catch { return true; }
}

export class ConsentModal extends Modal {
  constructor(app: App, private host: string, private onConsent: () => void) { super(app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Send note text to a network service?' });
    contentEl.createEl('p', { text:
      `Vane Search will send the text of your notes to ${this.host} to compute embeddings. ` +
      `The text leaves this device. Only proceed if you trust that service with your notes.` });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText(`I understand, use ${this.host}`).setCta().onClick(() => { this.onConsent(); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}
