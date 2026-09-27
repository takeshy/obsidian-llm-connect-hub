import type { App } from "obsidian";
import type { DiscordSettings, KakerattaSettings, LegacyConnections } from "./contract";

export interface ConnectSettings {
  backendId: string;
  migration: "new" | "pending" | "done";
  credentialStorage: "plaintext" | "secretStorage";
  discord: DiscordSettings;
  kakeratta: KakerattaSettings;
}
export function defaults(): ConnectSettings {
  return {
    backendId: "llm-hub", migration: "new", credentialStorage: "secretStorage",
    discord: { enabled: false, botToken: "", respondToDMs: true, requireMention: true, allowedChannelIds: "", allowedUserIds: "", model: "", systemPrompt: "", maxResponseLength: 2000 },
    kakeratta: { enabled: false, model: "", url: "", headers: {}, personas: {} },
  };
}
const SECRET = "llm-connect-hub-credentials";
export function loadSettings(app: App, data: Partial<ConnectSettings> | null): ConnectSettings {
  const base = defaults();
  const settings = { ...base, ...data, discord: { ...base.discord, ...data?.discord }, kakeratta: { ...base.kakeratta, ...data?.kakeratta } };
  if (settings.credentialStorage === "secretStorage") {
    const secret = app.secretStorage?.getSecret(SECRET);
    if (secret) {
      const credentials = JSON.parse(secret) as { discordBotToken?: string; kakerattaHeaders?: Record<string, string> };
      settings.discord.botToken ||= credentials.discordBotToken ?? "";
      if (!Object.keys(settings.kakeratta.headers).length) settings.kakeratta.headers = credentials.kakerattaHeaders ?? {};
    }
  }
  return settings;
}
export function settingsForSave(app: App, settings: ConnectSettings): ConnectSettings {
  const data = structuredClone(settings);
  if (settings.credentialStorage === "secretStorage") {
    if (!app.secretStorage) throw new Error("Secret storage is unavailable on this device");
    app.secretStorage.setSecret(SECRET, JSON.stringify({ discordBotToken: settings.discord.botToken, kakerattaHeaders: settings.kakeratta.headers }));
    data.discord.botToken = "";
    data.kakeratta.headers = {};
  }
  return data;
}

/** Destination must be durable before retiring the legacy connection. Resumable after any failure. */
export async function migrateConnections(settings: ConnectSettings, legacy: LegacyConnections, save: () => Promise<void>, retire: () => Promise<void>): Promise<void> {
  if (settings.migration === "done") return;
  if (settings.migration === "new" &&
      !legacy.discord.enabled && !legacy.discord.botToken && !legacy.kakeratta.enabled &&
      !legacy.kakeratta.url && !Object.keys(legacy.kakeratta.headers).length) {
    settings.migration = "done";
    try { await save(); } catch (error) { settings.migration = "new"; throw error; }
    return;
  }
  if (settings.migration === "new") {
    settings.discord = structuredClone(legacy.discord);
    settings.kakeratta = structuredClone(legacy.kakeratta);
    settings.credentialStorage = legacy.credentialStorage;
    settings.migration = "pending";
  }
  await save();
  await retire();
  settings.migration = "done";
  try { await save(); } catch (error) { settings.migration = "pending"; throw error; }
}
