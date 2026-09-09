// Minimal runtime stand-in for the `obsidian` package under vitest.
//
// The real `obsidian` npm package ships types only (package.json has
// `"main": ""`), so it has no runtime module for Vite/vitest to resolve.
// Files under src/ui and src/settings import classes like Modal and Setting
// from 'obsidian' as real values (not just types), which is fine inside the
// actual Obsidian app (which injects its own implementations) but breaks
// module resolution under vitest. This stub exists only so those modules can
// be *loaded* by the test runner when a test needs a pure helper that lives
// alongside Obsidian-glue code (e.g. `needsConsent` in consent-modal.ts).
// None of these classes are exercised for real behavior in unit tests.
export class App {}

export class Modal {
  app: App;
  contentEl: any;
  constructor(app: App) {
    this.app = app;
  }
  open(): void {}
  close(): void {}
}

export class PluginSettingTab {
  app: App;
  containerEl: any;
  constructor(app: App, _plugin: unknown) {
    this.app = app;
  }
}

export class Setting {
  constructor(_containerEl: unknown) {}
}

export class Notice {
  constructor(_message: unknown) {}
}

export class Plugin {}
