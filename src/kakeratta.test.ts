import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian-llm-hub-common/mcp", () => ({ McpHttpClient: class {} }));
import { resolvePersonaProfile } from "./kakeratta";
import { defaults } from "./settings";

describe("persona settings", () => {
  it("routes by stable persona ID rather than display name", () => {
    const config = defaults().kakeratta;
    config.model = "api:default:model";
    config.personas["id-1"] = { model: "api:chosen:model", vaultFolders: ["Clients/A"], ragSetting: "research", skillPaths: ["summarize"] };
    expect(resolvePersonaProfile(config, { persona: { id: "id-1", name: "Renamed" } })).toEqual(config.personas["id-1"]);
    expect(resolvePersonaProfile(config, { persona: { id: "id-2", name: "Renamed" } })).toEqual({ model: "api:default:model", vaultFolders: [], ragSetting: null, skillPaths: [] });
  });
});
