import { Plugin, Notice, type EventRef } from "obsidian";
import { CONNECT_READY, CONNECT_REGISTER, CONNECT_UNREGISTER, type ConnectBackend } from "./contract";
import { DiscordService } from "./discord";
import { KakerattaService } from "./kakeratta";
import { defaults, loadSettings, settingsForSave, migrateConnections, type ConnectSettings } from "./settings";
import { ConnectSettingsTab } from "./settingsTab";

interface WorkspaceEvents {
  on(name: string, callback: (backend: ConnectBackend) => void): EventRef;
  trigger(name: string, value: unknown): void;
}
export default class ConnectHubPlugin extends Plugin {
  settings: ConnectSettings = defaults();
  backends = new Map<string, ConnectBackend>();
  status = "Waiting for LLM Hub";
  private discord?: DiscordService;
  private kakeratta?: KakerattaService;
  private stopped = false;
  private updating = Promise.resolve();
  get backend(): ConnectBackend | undefined { return this.backends.get(this.settings.backendId); }
  async onload(): Promise<void> {
    this.settings = loadSettings(this.app, await this.loadData() as Partial<ConnectSettings> | null);
    this.addSettingTab(new ConnectSettingsTab(this.app, this));
    const workspace = this.app.workspace as unknown as WorkspaceEvents;
    this.registerEvent(workspace.on(CONNECT_REGISTER, backend => this.registerBackend(backend)));
    this.registerEvent(workspace.on(CONNECT_UNREGISTER, backend => {
      if (this.backends.get(backend.id) !== backend) return;
      this.backends.delete(backend.id);
      // Immediately stop sends and generation before asynchronous cleanup.
      if (backend.id === this.settings.backendId) {
        this.discord?.stop();
        void this.kakeratta?.stop();
      }
      void this.refresh();
    }));
    workspace.trigger(CONNECT_READY, this);
  }
  registerBackend(backend: ConnectBackend): void {
    if (this.stopped || backend.protocolVersion !== 1 || typeof backend.generate !== "function") return;
    if (this.backends.get(backend.id) === backend) return;
    this.backends.set(backend.id, backend);
    void this.refresh();
  }
  async persist(): Promise<void> { await this.saveData(settingsForSave(this.app, this.settings)); }
  async apply(): Promise<void> {
    // Save the new connection before retiring the old one, even if the user edits during migration.
    if (this.settings.migration !== "done" && this.backend) {
      this.settings.migration = "pending";
      await this.persist();
      await this.backend.completeMigration();
    }
    this.settings.migration = "done";
    await this.persist();
    await this.refresh();
  }
  refresh(): Promise<void> {
    const run = async () => {
      this.discord?.stop();
      this.discord = undefined;
      this.kakeratta?.stop();
      this.kakeratta = undefined;
      if (this.stopped) return;
      const backend = this.backend;
      if (!backend) { this.status = "Waiting for LLM Hub"; return; }
      await migrateConnections(this.settings, backend.getLegacyConnections(), () => this.persist(), () => backend.completeMigration());
      if (this.stopped || this.backend !== backend) return;
      this.status = "LLM Hub connected";
      if (this.settings.discord.enabled && this.settings.discord.botToken) {
        this.discord = new DiscordService(this.app, backend, structuredClone(this.settings.discord));
        this.discord.start();
      }
      if (this.settings.kakeratta.enabled && this.settings.kakeratta.url) {
        this.kakeratta = new KakerattaService(structuredClone(this.settings.kakeratta), backend, status => { this.status = status; });
        this.kakeratta.start();
      }
    };
    this.updating = this.updating.then(run).catch(() => {
      this.status = "Connection or migration failed. Check settings and retry.";
      if (!this.stopped) new Notice(this.status);
    });
    return this.updating;
  }
  onunload(): void {
    this.stopped = true;
    this.discord?.stop();
    void this.kakeratta?.stop();
  }
}
