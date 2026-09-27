import { describe, expect, it, vi } from "vitest";
import { defaults } from "./settings";

const calls = vi.hoisted(() => ({ discordStart: vi.fn(), discordStop: vi.fn(), kakerattaStart: vi.fn(), kakerattaStop: vi.fn() }));
vi.mock("obsidian", () => ({
  Plugin: class { app: unknown; private stored: unknown[] = [];
    constructor() { this.app = { workspace: { on: (name: string, handler: (value: unknown) => void) => { const handlers = (this.app as { handlers: Map<string, Function[]> }).handlers; handlers.set(name, [...(handlers.get(name) ?? []), handler]); return {}; }, trigger: (name: string, value: unknown) => { for (const callback of ((this.app as { handlers: Map<string, Function[]> }).handlers.get(name) ?? [])) callback(value); } }, handlers: new Map<string, Function[]>(), secretStorage: { getSecret: () => null, setSecret: vi.fn() } }; }
    loadData() { return Promise.resolve(null); }
    saveData(data: unknown) { this.stored.push(data); return Promise.resolve(); }
    get saved() { return this.stored; }
    addSettingTab() {}
    registerEvent() {}
  },
  Notice: class {},
}));
vi.mock("./settingsTab", () => ({ ConnectSettingsTab: class {} }));
vi.mock("./discord", () => ({ DiscordService: class { start() { calls.discordStart(); } stop() { calls.discordStop(); } } }));
vi.mock("./kakeratta", () => ({ KakerattaService: class { start() { calls.kakerattaStart(); } stop() { calls.kakerattaStop(); } } }));
import ConnectHubPlugin from "./main";

describe("LLM Connect Hub registration", () => {
  it("accepts a backend after startup and migrates before starting connections", async () => {
    const plugin = new ConnectHubPlugin();
    await plugin.onload();
    const defaultsCopy = defaults();
    const retired = vi.fn(async () => undefined);
    const backend = { protocolVersion: 1, id: "llm-hub", name: "LLM Hub", generate: vi.fn(),
      getLegacyConnections: () => ({ discord: { ...defaultsCopy.discord, enabled: true, botToken: "token" }, kakeratta: { ...defaultsCopy.kakeratta }, credentialStorage: "plaintext" }),
      completeMigration: retired };
    (plugin.app.workspace as { trigger: (name: string, value: unknown) => void }).trigger("llm-connect-hub:register-backend", backend);
    await plugin.refresh();
    expect(retired).toHaveBeenCalledTimes(1);
    expect(plugin.settings.migration).toBe("done");
    expect(plugin.settings.discord.botToken).toBe("token");
    expect(calls.discordStart).toHaveBeenCalled();
    plugin.onunload();
    expect(calls.discordStop).toHaveBeenCalled();
  });
});
