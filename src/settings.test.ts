import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { defaults, loadSettings, migrateConnections, settingsForSave } from "./settings";

function appWithSecret() {
  const secrets = new Map<string, string>();
  const app = { secretStorage: { getSecret: (key: string) => secrets.get(key) ?? null, setSecret: (key: string, value: string) => { secrets.set(key, value); } } } as unknown as App;
  return { app, secrets };
}

describe("connection settings and migration", () => {
  it("keeps SecretStorage as the default when there is no legacy connection", async () => {
    const settings = defaults();
    const retire = vi.fn();
    await migrateConnections(settings, { discord: { ...settings.discord }, kakeratta: { ...settings.kakeratta }, credentialStorage: "plaintext" }, async () => undefined, retire);
    expect(settings.credentialStorage).toBe("secretStorage");
    expect(settings.migration).toBe("done");
    expect(retire).not.toHaveBeenCalled();
  });
  it("stores credentials in SecretStorage, not data.json", () => {
    const { app } = appWithSecret();
    const settings = defaults();
    settings.discord.botToken = "discord-secret";
    settings.kakeratta.headers = { Authorization: "Bearer kakeratta-secret" };
    const saved = settingsForSave(app, settings);
    expect(JSON.stringify(saved)).not.toMatch(/discord-secret|kakeratta-secret/);
    expect(loadSettings(app, saved)).toEqual(settings);
  });
  it("round-trips default and persona profiles without exposing header values", () => {
    const { app } = appWithSecret();
    const settings = defaults();
    settings.kakeratta.headers = { Authorization: "Bearer secret", "X-Account": "001" };
    settings.kakeratta.defaultProfile = { model: "api:default", vaultFolders: [], allVault: true, ragSetting: "research", skillPaths: ["skills/review"] };
    settings.kakeratta.personas.one = { model: "api:other", vaultFolders: ["Limited"], ragSetting: null, skillPaths: [] };
    const saved = settingsForSave(app, settings);
    expect(saved.kakeratta.headers).toEqual({});
    expect(loadSettings(app, saved)).toEqual(settings);
  });
  it("never retires the old connection before the new settings are durable", async () => {
    const settings = defaults();
    const legacy = { discord: { ...settings.discord, enabled: true, botToken: "token" }, kakeratta: { ...settings.kakeratta }, credentialStorage: "plaintext" as const };
    const retire = vi.fn(async () => undefined);
    const save = vi.fn(async () => { throw new Error("disk full"); });
    await expect(migrateConnections(settings, legacy, save, retire)).rejects.toThrow("disk full");
    expect(retire).not.toHaveBeenCalled();
    expect(settings.migration).toBe("pending");
    const recoveredSave = vi.fn(async () => undefined);
    await migrateConnections(settings, legacy, recoveredSave, retire);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(settings.migration).toBe("done");
    expect(settings.discord.botToken).toBe("token");
  });
  it("resumes a failed final save without recopying edited settings", async () => {
    const settings = defaults();
    const legacy = { discord: { ...settings.discord, botToken: "old" }, kakeratta: { ...settings.kakeratta }, credentialStorage: "plaintext" as const };
    let n = 0;
    await expect(migrateConnections(settings, legacy, async () => { if (++n === 2) throw new Error("write failed"); }, async () => undefined)).rejects.toThrow();
    expect(settings.migration).toBe("pending");
    settings.discord.botToken = "edited";
    await migrateConnections(settings, legacy, async () => undefined, async () => undefined);
    expect(settings.discord.botToken).toBe("edited");
  });
});
