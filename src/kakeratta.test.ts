import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian-llm-hub-common/mcp", () => ({ McpHttpClient: class {} }));
import { KakerattaService, resolvePersonaProfile, resolveVaultFolders, pollStatus } from "./kakeratta";
import { defaults } from "./settings";
import type { ConnectBackend } from "./contract";

describe("persona settings", () => {
  it("schedules one-minute checks only when periodic checking is enabled", () => {
    const interval = vi.spyOn(window, "setInterval").mockImplementation(() => 1);
    const clear = vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const backend = {} as ConnectBackend;
    const config = defaults().kakeratta;
    config.pollEnabled = false;
    const once = new KakerattaService(config, backend, () => undefined, () => []);
    once.start();
    expect(interval).not.toHaveBeenCalled();
    once.stop();

    config.pollEnabled = true;
    const periodic = new KakerattaService(config, backend, () => undefined, () => []);
    periodic.start();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 60_000);
    periodic.stop();
    expect(clear).toHaveBeenCalledWith(1);
    interval.mockRestore();
    clear.mockRestore();
  });
  it("summarizes failed asks from the last poll in the status line", () => {
    expect(pollStatus({ pending: 0, submitted: 0, unsubmitted: 0, errors: [] })).toBe("Kakeratta: connected");
    expect(pollStatus({ pending: 1, submitted: 1, unsubmitted: 0, errors: [] })).toBe("Kakeratta: connected");
    expect(pollStatus({ pending: 2, submitted: 1, unsubmitted: 0, errors: [new Error("provider failed")] })).toBe("Kakeratta: connected; 1 ask failed");
    expect(pollStatus({ pending: 2, submitted: 0, unsubmitted: 1, errors: [new Error("provider failed"), new Error("submit unavailable")] })).toBe("Kakeratta: connected; 2 asks failed");
  });
  it("uses defaults for unknown personas and restores them when an override is removed", () => {
    const config = defaults().kakeratta;
    config.defaultProfile = { model: "api:default", vaultFolders: ["Research"], allVault: true, ragSetting: "index", skillPaths: ["skills/review"] };
    expect(resolvePersonaProfile(config, {})).toEqual(config.defaultProfile);
    config.personas.one = { model: "", vaultFolders: [], ragSetting: null, skillPaths: [] };
    expect(resolvePersonaProfile(config, { persona: { id: "one" } })).toEqual({ model: "api:default", vaultFolders: [], ragSetting: null, skillPaths: [] });
    delete config.personas.one;
    expect(resolvePersonaProfile(config, { persona: { id: "one" } })).toEqual(config.defaultProfile);
  });
  it("can clear a legacy model to use the backend default", () => {
    const config = defaults().kakeratta;
    config.model = "api:old";
    config.defaultProfile = { model: "", vaultFolders: [], ragSetting: null, skillPaths: [] };
    expect(resolvePersonaProfile(config, {}).model).toBe("");
  });
  it("expands the entire vault at answer time, including root notes and new folders", () => {
    const profile = { model: "", vaultFolders: ["Limited"], ragSetting: null, skillPaths: [], allVault: true };
    const paths = ["root.md", "Research"];
    const rootPaths = () => [...paths];
    expect(resolveVaultFolders(profile, rootPaths)).toEqual(paths);
    paths.push("New folder");
    expect(resolveVaultFolders(profile, rootPaths)).toContain("New folder");
    profile.allVault = false;
    expect(resolveVaultFolders(profile, rootPaths)).toEqual(["Limited"]);
    profile.vaultFolders = [];
    expect(resolveVaultFolders(profile, rootPaths)).toEqual([]);
  });
  it("routes by stable persona ID rather than display name", () => {
    const config = defaults().kakeratta;
    config.model = "api:default:model";
    config.personas["id-1"] = { model: "api:chosen:model", vaultFolders: ["Clients/A"], ragSetting: "research", skillPaths: ["summarize"] };
    expect(resolvePersonaProfile(config, { persona: { id: "id-1", name: "Renamed" } })).toEqual(config.personas["id-1"]);
    expect(resolvePersonaProfile(config, { persona: { id: "id-2", name: "Renamed" } })).toEqual({ model: "api:default:model", vaultFolders: [], ragSetting: null, skillPaths: [] });
  });
});
