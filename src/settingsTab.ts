import { PluginSettingTab, Setting, Notice, getLanguage, type App, type SettingDefinitionItem } from "obsidian";
import type ConnectHubPlugin from "./main";
import type { PersonaProfile } from "./contract";
import { withKakeratta } from "./kakeratta";

const labels = {
  en: {
    title: "LLM Connect Hub", backend: "Model provider", state: "Connection status", discord: "Discord", enabled: "Enabled", token: "Bot token", tokenDesc: "Stored in Obsidian SecretStorage when available", verify: "Verify token", dm: "Respond to DMs", mention: "Require mention in servers", channels: "Allowed channel IDs", users: "Allowed user IDs", model: "Model", prompt: "System prompt", max: "Maximum response length", kakeratta: "Kakeratta", url: "MCP URL", headers: "HTTP headers (JSON)", headersDesc: "Include the issued Authorization Bearer key", personas: "Persona settings", fetch: "Load personas", personaModel: "Answer model", folders: "Vault folders to read", foldersDesc: "One vault-relative folder per line. Empty disables Vault tools. API models only.", rag: "RAG setting", skills: "Folder skills", skillsDesc: "One skill name per line. Script and workflow execution is disabled for Kakeratta.", save: "Save and reconnect", imported: "Legacy connection settings are copied once. The original connections are stopped after the new settings are saved.", none: "None", default: "Use default model", connectionFailed: "Could not load personas. Check the MCP URL and key.", saved: "Connections saved", invalidHeaders: "Headers must be a JSON object of strings", invalidFolders: "Use vault-relative folder paths without . or .. segments", apiOnly: "Choose an API model for scoped persona research", secretUnavailable: "SecretStorage is unavailable; credentials remain in plugin data", credentialMode: "Store credentials in SecretStorage", credentialDesc: "Turning off stores the bot token and MCP headers in plugin data.json", askWait: "Kakeratta checks once per minute while Obsidian runs."
  },
  ja: {
    title: "LLM Connect Hub", backend: "モデル提供元", state: "接続状態", discord: "Discord", enabled: "有効", token: "Bot トークン", tokenDesc: "利用可能な場合は Obsidian の SecretStorage に保存", verify: "トークンを確認", dm: "DM に応答", mention: "サーバーでメンションを必須にする", channels: "許可するチャンネル ID", users: "許可するユーザー ID", model: "モデル", prompt: "システムプロンプト", max: "回答の最大文字数", kakeratta: "Kakeratta", url: "MCP URL", headers: "HTTP ヘッダー（JSON）", headersDesc: "発行された Authorization Bearer キーを含めます", personas: "担当別設定", fetch: "担当一覧を取得", personaModel: "回答モデル", folders: "参照する Vault フォルダー", foldersDesc: "Vault 相対パスを1行ずつ。空欄では Vault ツールを使いません。API モデルのみ対応。", rag: "RAG 設定", skills: "フォルダー Skill", skillsDesc: "Skill 名を1行ずつ。Kakeratta ではスクリプト・ワークフロー実行は無効です。", save: "保存して再接続", imported: "旧連携設定を一度だけコピーし、新設定を保存した後に旧接続を停止します。", none: "なし", default: "既定モデルを使用", connectionFailed: "担当一覧を取得できません。MCP URL とキーを確認してください。", saved: "連携設定を保存しました", invalidHeaders: "ヘッダーは文字列値を持つ JSON オブジェクトにしてください", invalidFolders: "Vault 相対パスを指定し、. や .. の部分を含めないでください", apiOnly: "担当の範囲指定には API モデルを選んでください", secretUnavailable: "SecretStorage を使えません。認証情報はプラグイン設定に保存されます", credentialMode: "認証情報を SecretStorage に保存", credentialDesc: "OFF にすると Bot トークンと MCP ヘッダーを data.json に保存します", askWait: "Obsidian 起動中に Kakeratta を1分ごとに確認します。"
  },
};
function lines(value: string): string[] { return value.split(/\r?\n/).map(v => v.trim()).filter(Boolean); }
function validFolders(folders: string[]): boolean { return folders.every(folder => !folder.startsWith("/") && !folder.includes("\\") && !folder.split("/").some(part => part === "." || part === ".." || !part)); }

export class ConnectSettingsTab extends PluginSettingTab {
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
    new Setting(el).setName(l.enabled).setDesc(l.askWait).addToggle(t => t.setValue(k.enabled).onChange(value => { k.enabled = value; }));
    new Setting(el).setName(l.url).addText(t => t.setValue(k.url).onChange(value => { k.url = value.trim(); }));
    new Setting(el).setName(l.headers).setDesc(l.headersDesc).addTextArea(t => { t.inputEl.rows = 3; t.setValue(JSON.stringify(k.headers, null, 2)).onChange(value => { try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every(v => typeof v === "string")) k.headers = parsed as Record<string, string>; else throw Error(); t.inputEl.removeClass("is-invalid"); } catch { t.inputEl.addClass("is-invalid"); } }); });
    new Setting(el).setName(l.model).addDropdown(d => {
      d.addOption("", l.default);
      for (const model of models) d.addOption(model.name, model.displayName);
      if (k.model && !models.some(m => m.name === k.model)) d.addOption(k.model, k.model);
      d.setValue(k.model).onChange(value => { k.model = value; });
    });
    new Setting(el).setName(l.personas).setHeading();
    new Setting(el).setName(l.fetch).addButton(b => b.setButtonText(l.fetch).onClick(async () => {
      try {
        const result = await withKakeratta(k, call => call("list_personas", {}));
        this.personas = Array.isArray(result.personas) ? result.personas as Array<{ id: string; name: string }> : [];
        this.update();
      } catch { new Notice(l.connectionFailed); }
    }));
    const visiblePersonas = [...this.personas];
    for (const id of Object.keys(k.personas)) if (!visiblePersonas.some(p => p.id === id)) visiblePersonas.push({ id, name: id });
    for (const persona of visiblePersonas) {
      const profile = k.personas[persona.id] ?? { model: "", vaultFolders: [], ragSetting: null, skillPaths: [] } satisfies PersonaProfile;
      k.personas[persona.id] = profile;
      new Setting(el).setName(`${persona.name} (${persona.id})`).setHeading();
      new Setting(el).setName(l.personaModel).addDropdown(d => {
        d.addOption("", l.default);
        for (const model of models.filter(m => m.name.startsWith("api:"))) d.addOption(model.name, model.displayName);
        if (profile.model && !models.some(m => m.name === profile.model)) d.addOption(profile.model, profile.model);
        d.setValue(profile.model).onChange(value => { profile.model = value; });
      });
      new Setting(el).setName(l.folders).setDesc(l.foldersDesc).addTextArea(t => { t.inputEl.rows = 2; t.setValue(profile.vaultFolders.join("\n")).onChange(value => { profile.vaultFolders = lines(value); }); });
      new Setting(el).setName(l.rag).addDropdown(d => {
        d.addOption("", l.none);
        for (const name of this.plugin.backend?.listRagSettings() ?? []) d.addOption(name, name);
        if (profile.ragSetting && !(this.plugin.backend?.listRagSettings() ?? []).includes(profile.ragSetting)) d.addOption(profile.ragSetting, profile.ragSetting);
        d.setValue(profile.ragSetting ?? "").onChange(value => { profile.ragSetting = value || null; });
      });
      new Setting(el).setName(l.skills).setDesc(l.skillsDesc).addTextArea(t => { t.inputEl.rows = 2; t.setValue(profile.skillPaths.join("\n")).onChange(value => { profile.skillPaths = lines(value); }); });
    }
    new Setting(el).setName(l.save).addButton(b => b.setButtonText(l.save).setCta().onClick(async () => {
      if (el.querySelector(".is-invalid")) { new Notice(l.invalidHeaders); return; }
      if (Object.values(k.personas).some(profile => !validFolders(profile.vaultFolders))) { new Notice(l.invalidFolders); return; }
      if (Object.values(k.personas).some(profile => (profile.vaultFolders.length > 0 || !!profile.ragSetting || profile.skillPaths.length > 0) && !(profile.model || k.model || this.plugin.backend?.getDefaultModel() || "").startsWith("api:"))) { new Notice(l.apiOnly); return; }
      try { await this.plugin.apply(); new Notice(l.saved); this.update(); }
      catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
    }));
  }
}
