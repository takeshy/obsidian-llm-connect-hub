import { PluginSettingTab, Setting, Notice, FuzzySuggestModal, getLanguage, type App, type SettingDefinitionItem } from "obsidian";
import type ConnectHubPlugin from "./main";
import type { PersonaProfile, KakerattaSettings } from "./contract";
import { parseHeaderRows, type HeaderRow } from "./settingsFields";
import { withKakeratta } from "./kakeratta";

const labels = {
  en: {
    add: "Add", remove: "Remove", headerName: "Header name", headerValue: "Value", addHeader: "Add header", defaults: "Default settings", defaultsDesc: "Used for personas without an override.", addPersona: "Add persona override", overrideDesc: "Starts with a copy of the defaults. Remove to use the defaults again.", noPersonas: "No more personas to add. Load personas first.", allVault: "Read the entire vault", allVaultDesc: "Includes root notes and newly created folders. Read-only access.", addSkill: "Add skill", skillsFailed: "Could not load skills. Check the model provider connection.", noSkills: "No more skills to add", inheritModel: "Use default settings model", effectiveModel: "Current fallback model",
    title: "LLM Connect Hub", backend: "Model provider", state: "Connection status", discord: "Discord", enabled: "Enabled", token: "Bot token", tokenDesc: "Stored in Obsidian SecretStorage when available", verify: "Verify token", dm: "Respond to DMs", mention: "Require mention in servers", channels: "Allowed channel IDs", users: "Allowed user IDs", model: "Model", prompt: "System prompt", max: "Maximum response length", kakeratta: "Kakeratta", url: "MCP URL", headers: "HTTP headers", headersDesc: "Include the issued Authorization Bearer key", personas: "Persona settings", fetch: "Load personas", personaModel: "Answer model", folders: "Vault folders to read", foldersDesc: "One vault-relative folder per line. Empty disables Vault tools. API models only.", rag: "RAG setting", skills: "Folder skills", skillsDesc: "Select skills to add. Script and workflow execution is disabled for Kakeratta.", save: "Save and reconnect", imported: "Legacy connection settings are copied once. The original connections are stopped after the new settings are saved.", none: "None", default: "Use default model", connectionFailed: "Could not load personas. Check the MCP URL and key.", saved: "Connections saved", invalidHeaders: "Enter valid, unique header names and single-line values", invalidFolders: "Use vault-relative folder paths without . or .. segments", apiOnly: "Choose an API model for scoped persona research", secretUnavailable: "SecretStorage is unavailable; credentials remain in plugin data", credentialMode: "Store credentials in SecretStorage", credentialDesc: "Turning off stores the bot token and MCP headers in plugin data.json", poll: "Check periodically", pollDesc: "On: every minute while Obsidian runs. Off: once when the connection starts."
  },
  ja: {
    add: "追加", remove: "削除", headerName: "ヘッダー名", headerValue: "値", addHeader: "ヘッダーを追加", defaults: "既定設定", defaultsDesc: "担当別の上書きがない担当に適用します。", addPersona: "担当別の上書きを追加", overrideDesc: "既定設定をコピーして調整します。削除すると既定設定に戻ります。", noPersonas: "追加できる担当がありません。担当一覧を取得してください。", allVault: "Vault 全体を参照", allVaultDesc: "ルート直下のノートや新しく作成したフォルダーも含みます。読み取り専用です。", addSkill: "Skill を追加", skillsFailed: "Skill 一覧を取得できません。モデル提供元の接続を確認してください。", noSkills: "追加できる Skill がありません", inheritModel: "既定設定のモデルを使用", effectiveModel: "現在の補完モデル",
    title: "LLM Connect Hub", backend: "モデル提供元", state: "接続状態", discord: "Discord", enabled: "有効", token: "Bot トークン", tokenDesc: "利用可能な場合は Obsidian の SecretStorage に保存", verify: "トークンを確認", dm: "DM に応答", mention: "サーバーでメンションを必須にする", channels: "許可するチャンネル ID", users: "許可するユーザー ID", model: "モデル", prompt: "システムプロンプト", max: "回答の最大文字数", kakeratta: "Kakeratta", url: "MCP URL", headers: "HTTP ヘッダー", headersDesc: "発行された Authorization Bearer キーを含めます", personas: "担当別設定", fetch: "担当一覧を取得", personaModel: "回答モデル", folders: "参照する Vault フォルダー", foldersDesc: "Vault 相対パスを1行ずつ。空欄では Vault ツールを使いません。API モデルのみ対応。", rag: "RAG 設定", skills: "フォルダー Skill", skillsDesc: "一覧から Skill を追加します。Kakeratta ではスクリプト・ワークフロー実行は無効です。", save: "保存して再接続", imported: "旧連携設定を一度だけコピーし、新設定を保存した後に旧接続を停止します。", none: "なし", default: "既定モデルを使用", connectionFailed: "担当一覧を取得できません。MCP URL とキーを確認してください。", saved: "連携設定を保存しました", invalidHeaders: "ヘッダー名は重複しない有効な名前、値は改行なしで入力してください", invalidFolders: "Vault 相対パスを指定し、. や .. の部分を含めないでください", apiOnly: "担当の範囲指定には API モデルを選んでください", secretUnavailable: "SecretStorage を使えません。認証情報はプラグイン設定に保存されます", credentialMode: "認証情報を SecretStorage に保存", credentialDesc: "OFF にすると Bot トークンと MCP ヘッダーを data.json に保存します", poll: "定期確認", pollDesc: "オン: Obsidian 起動中は1分ごと。オフ: 接続開始時に1回だけ確認します。"
  },
};
function lines(value: string): string[] { return value.split(/\r?\n/).map(v => v.trim()).filter(Boolean); }
function validFolders(folders: string[]): boolean { return folders.every(folder => !folder.startsWith("/") && !folder.includes("\\") && !folder.split("/").some(part => part === "." || part === ".." || !part)); }

class ChoiceModal<T> extends FuzzySuggestModal<T> {
  constructor(app: App, private choices: T[], private label: (item: T) => string, private choose: (item: T) => void) { super(app); }
  getItems(): T[] { return this.choices; }
  getItemText(item: T): string { return this.label(item); }
  onChooseItem(item: T): void { this.choose(item); }
}

export class ConnectSettingsTab extends PluginSettingTab {
  private headerConfig?: KakerattaSettings;
  private headerRows: HeaderRow[] = [];
  private personas: Array<{ id: string; name: string }> = [];
  constructor(app: App, private plugin: ConnectHubPlugin) { super(app, plugin); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{ name: "LLM Connect Hub settings", aliases: ["Discord", "Kakeratta", "external agent"], render: setting => this.renderSettings(setting.settingEl) }];
  }
  private renderSettings(el: HTMLElement): void {
    const l = getLanguage() === "ja" ? labels.ja : labels.en;
    el.empty();
    // This definition renders a whole page, not a single horizontal setting row.
    el.removeClass("setting-item");
    new Setting(el).setName(l.title).setHeading();
    new Setting(el).setName(l.state).setDesc(this.plugin.status);
    new Setting(el).setName(l.backend).addDropdown(d => {
      for (const backend of this.plugin.backends.values()) d.addOption(backend.id, backend.name);
      if (!this.plugin.backends.size) d.addOption(this.plugin.settings.backendId, this.plugin.settings.backendId);
      d.setValue(this.plugin.settings.backendId).onChange(async value => { this.plugin.settings.backendId = value; await this.plugin.apply(); this.update(); });
    });
    new Setting(el).setDesc(l.imported);
    new Setting(el).setName(l.credentialMode).setDesc(l.credentialDesc).addToggle(t => t.setValue(this.plugin.settings.credentialStorage === "secretStorage").onChange(value => {
      this.plugin.settings.credentialStorage = value ? "secretStorage" : "plaintext";
    }));
    if (!this.app.secretStorage) new Setting(el).setDesc(l.secretUnavailable);

    const discord = this.plugin.settings.discord;
    new Setting(el).setName(l.discord).setHeading();
    new Setting(el).setName(l.enabled).addToggle(t => t.setValue(discord.enabled).onChange(value => { discord.enabled = value; }));
    new Setting(el).setName(l.token).setDesc(l.tokenDesc).addText(t => { t.inputEl.type = "password"; t.setValue(discord.botToken).onChange(value => { discord.botToken = value; }); });
    new Setting(el).setName(l.verify).addButton(b => b.setButtonText(l.verify).onClick(async () => {
      const { DiscordService } = await import("./discord");
      const backend = this.plugin.backend;
      if (!backend) return;
      const result = await new DiscordService(this.app, backend, discord).verifyToken(discord.botToken);
      new Notice(result.success ? result.username ?? "OK" : result.error ?? "Failed");
    }));
    new Setting(el).setName(l.dm).addToggle(t => t.setValue(discord.respondToDMs).onChange(value => { discord.respondToDMs = value; }));
    new Setting(el).setName(l.mention).addToggle(t => t.setValue(discord.requireMention).onChange(value => { discord.requireMention = value; }));
    new Setting(el).setName(l.channels).addText(t => t.setValue(discord.allowedChannelIds).onChange(value => { discord.allowedChannelIds = value; }));
    new Setting(el).setName(l.users).addText(t => t.setValue(discord.allowedUserIds).onChange(value => { discord.allowedUserIds = value; }));
    const models = this.plugin.backend?.listModels() ?? [];
    new Setting(el).setName(l.model).addDropdown(d => {
      d.addOption("", l.default);
      for (const model of models) d.addOption(model.name, model.displayName);
      if (discord.model && !models.some(m => m.name === discord.model)) d.addOption(discord.model, discord.model);
      d.setValue(discord.model).onChange(value => { discord.model = value; });
    });
    new Setting(el).setName(l.prompt).addTextArea(t => { t.inputEl.rows = 3; t.setValue(discord.systemPrompt).onChange(value => { discord.systemPrompt = value; }); });
    new Setting(el).setName(l.max).addText(t => t.setValue(String(discord.maxResponseLength)).onChange(value => { const n = Number(value); if (Number.isInteger(n) && n >= 1 && n <= 2000) discord.maxResponseLength = n; }));

    const k = this.plugin.settings.kakeratta;
    new Setting(el).setName(l.kakeratta).setHeading();
    new Setting(el).setName(l.enabled).addToggle(t => t.setValue(k.enabled).onChange(value => { k.enabled = value; }));
    new Setting(el).setName(l.poll).setDesc(l.pollDesc).addToggle(t => t.setValue(k.pollEnabled !== false).onChange(value => { k.pollEnabled = value; }));
    new Setting(el).setName(l.url).addText(t => t.setValue(k.url).onChange(value => { k.url = value.trim(); }));
    this.renderHeaders(el, k);
    const defaultProfile = k.defaultProfile ??= { model: k.model, vaultFolders: [], ragSetting: null, skillPaths: [] };
    new Setting(el).setName(l.defaults).setDesc(l.defaultsDesc).setHeading();
    this.renderProfile(el, defaultProfile, false);
    new Setting(el).setName(l.personas).setHeading();
    new Setting(el).setName(l.fetch).addButton(b => b.setButtonText(l.fetch).onClick(async () => {
      try {
        await this.loadPersonas(k);
        this.update();
      } catch { new Notice(l.connectionFailed); }
    }));
    new Setting(el).setName(l.addPersona).setDesc(l.overrideDesc).addButton(b => b.setButtonText(l.add).onClick(async () => {
      b.setDisabled(true);
      try { await this.loadPersonas(k); }
      catch { new Notice(l.connectionFailed); return; }
      finally { b.setDisabled(false); }
      const choices = this.personas.filter(p => !Object.hasOwn(k.personas, p.id));
      if (!choices.length) { new Notice(l.noPersonas); return; }
      new ChoiceModal(this.app, choices, p => `${p.name} (${p.id})`, p => {
        k.personas[p.id] = structuredClone(defaultProfile);
        this.update();
      }).open();
    }));
    for (const [id, profile] of Object.entries(k.personas)) {
      const name = this.personas.find(p => p.id === id)?.name ?? id;
      new Setting(el).setName(`${name} (${id})`).setHeading().addButton(b => b.setButtonText(l.remove).onClick(() => {
        delete k.personas[id];
        this.update();
      }));
      this.renderProfile(el, profile, true);
    }
    new Setting(el).setName(l.save).addButton(b => b.setButtonText(l.save).setCta().onClick(async () => {
      try { k.headers = parseHeaderRows(this.headerRows); } catch { new Notice(l.invalidHeaders); return; }
      const profiles = [defaultProfile, ...Object.values(k.personas)];
      if (profiles.some(profile => !profile.allVault && !validFolders(profile.vaultFolders))) { new Notice(l.invalidFolders); return; }
      if (profiles.some(profile => (profile.allVault || profile.vaultFolders.length > 0 || !!profile.ragSetting || profile.skillPaths.length > 0) && !(profile.model || defaultProfile.model || this.plugin.backend?.getDefaultModel() || "").startsWith("api:"))) { new Notice(l.apiOnly); return; }
      try { await this.plugin.apply(); new Notice(l.saved); this.update(); }
      catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
    }));
  }
  private async loadPersonas(config: KakerattaSettings): Promise<void> {
    config.headers = parseHeaderRows(this.headerRows);
    const result = await withKakeratta(config, call => call("list_personas", {}));
    if (!Array.isArray(result.personas)) throw new Error("Invalid persona list");
    this.personas = result.personas.filter((p: unknown): p is { id: string; name: string } => {
      return typeof p === "object" && p !== null && "id" in p && typeof p.id === "string" && "name" in p && typeof p.name === "string";
    });
  }

  private renderHeaders(el: HTMLElement, config: KakerattaSettings): void {
    const l = getLanguage() === "ja" ? labels.ja : labels.en;
    if (this.headerConfig !== config) {
      this.headerConfig = config;
      this.headerRows = Object.entries(config.headers).map(([name, value]) => ({ name, value }));
    }
    new Setting(el).setName(l.headers).setDesc(l.headersDesc).setHeading();
    const rowsEl = el.createDiv();
    const sync = () => {
      try { config.headers = parseHeaderRows(this.headerRows); } catch { /* Validate incomplete rows on save. */ }
    };
    const render = () => {
      rowsEl.empty();
      for (const row of this.headerRows) {
        const rowEl = rowsEl.createDiv();
        new Setting(rowEl).setName(l.headerName).addText(t => t.setPlaceholder("Authorization").setValue(row.name).onChange(value => { row.name = value; sync(); }));
        new Setting(rowEl).setName(l.headerValue).addText(t => t.setValue(row.value).onChange(value => { row.value = value; sync(); }))
          .addButton(b => b.setButtonText(l.remove).onClick(() => { this.headerRows.splice(this.headerRows.indexOf(row), 1); sync(); render(); }));
      }
    };
    render();
    new Setting(el).setName(l.addHeader).addButton(b => b.setButtonText(l.add).onClick(() => { this.headerRows.push({ name: "", value: "" }); render(); }));
  }

  private renderProfile(el: HTMLElement, profile: PersonaProfile, override: boolean): void {
    const l = getLanguage() === "ja" ? labels.ja : labels.en;
    const models = this.plugin.backend?.listModels() ?? [];
    const fallback = this.plugin.settings.kakeratta.defaultProfile?.model || this.plugin.backend?.getDefaultModel() || "";
    new Setting(el).setName(l.personaModel).setDesc(profile.model ? "" : `${l.effectiveModel}: ${fallback || l.none}`).addDropdown(d => {
      d.addOption("", override ? l.inheritModel : l.default);
      for (const model of models) d.addOption(model.name, model.displayName);
      if (profile.model && !models.some(m => m.name === profile.model)) d.addOption(profile.model, profile.model);
      d.setValue(profile.model).onChange(value => { profile.model = value; });
    });
    new Setting(el).setName(l.allVault).setDesc(l.allVaultDesc).addToggle(t => t.setValue(!!profile.allVault).onChange(value => { profile.allVault = value; this.update(); }));
    if (!profile.allVault) new Setting(el).setName(l.folders).setDesc(l.foldersDesc).addTextArea(t => { t.inputEl.rows = 2; t.setValue(profile.vaultFolders.join("\n")).onChange(value => { profile.vaultFolders = lines(value); }); });
    new Setting(el).setName(l.rag).addDropdown(d => {
      d.addOption("", l.none);
      const names = this.plugin.backend?.listRagSettings() ?? [];
      for (const name of names) d.addOption(name, name);
      if (profile.ragSetting && !names.includes(profile.ragSetting)) d.addOption(profile.ragSetting, profile.ragSetting);
      d.setValue(profile.ragSetting ?? "").onChange(value => { profile.ragSetting = value || null; });
    });
    new Setting(el).setName(l.skills).setDesc(l.skillsDesc);
    for (const path of profile.skillPaths) {
      new Setting(el).setName(path).addButton(b => b.setButtonText(l.remove).onClick(() => { profile.skillPaths = profile.skillPaths.filter(p => p !== path); this.update(); }));
    }
    new Setting(el).setName(l.addSkill).addButton(b => b.setButtonText(l.add).onClick(async () => {
      const backend = this.plugin.backend;
      if (!backend) { new Notice(l.skillsFailed); return; }
      b.setDisabled(true);
      try {
        const { folders } = await backend.listSkills();
        if (this.plugin.backend !== backend) return;
        const choices = folders.filter(skill => !profile.skillPaths.includes(skill.folderPath) && !profile.skillPaths.includes(skill.name));
        if (!choices.length) { new Notice(l.noSkills); return; }
        new ChoiceModal(this.app, choices, skill => `${skill.name} — ${skill.description || skill.folderPath}`, skill => {
          if (!profile.skillPaths.includes(skill.folderPath)) profile.skillPaths.push(skill.folderPath);
          this.update();
        }).open();
      } catch { new Notice(l.skillsFailed); }
      finally { b.setDisabled(false); }
    }));
  }

}
