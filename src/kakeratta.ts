import { McpHttpClient } from "obsidian-llm-hub-common/mcp";
import type { ConnectBackend, KakerattaSettings, PersonaProfile } from "./contract";
import { pollKakeratta, type PollResult } from "./kakerattaWorker";

export async function withKakeratta<T>(config: KakerattaSettings, work: (call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Use HTTPS, or HTTP on localhost");
  }
  const client = new McpHttpClient({ name: "kakeratta", transport: "http", url: config.url, headers: config.headers, enabled: true });
  try {
    await client.initialize();
    return await work(async (name, args) => {
      // Enabling this dedicated connection authorizes exactly this protocol.
      if (!["list_personas", "list_asks", "claim_ask", "read_for_ask", "submit_answer", "release_ask"].includes(name)) throw new Error("Unsupported tool");
      const result = await client.callToolRaw(name, args, true);
      if (result.isError) throw new Error("Kakeratta rejected the request");
      if (result.structuredContent) return result.structuredContent;
      return JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n")) as Record<string, unknown>;
    });
  } finally { await client.close().catch(() => undefined); }
}

export function resolvePersonaProfile(config: KakerattaSettings, context: unknown): PersonaProfile {
  const id = (context as { persona?: { id?: unknown } })?.persona?.id;
  const profile = (typeof id === "string" && Object.hasOwn(config.personas, id) ? config.personas[id] : undefined) ?? config.defaultProfile;
  const webSearch = profile?.webSearch ?? config.defaultProfile?.webSearch;
  return {
    model: profile?.model || (config.defaultProfile?.model ?? config.model),
    vaultFolders: profile?.vaultFolders ?? [],
    ragSetting: profile?.ragSetting ?? null,
    skillPaths: profile?.skillPaths ?? [],
    ...(profile?.allVault ? { allVault: true } : {}),
    ...(webSearch !== undefined ? { webSearch } : {}),
  };
}

/** Expand at answer time so newly created root notes and folders are included. */
export function resolveVaultFolders(profile: PersonaProfile, rootPaths: () => string[]): string[] {
  return profile.allVault ? rootPaths() : profile.vaultFolders;
}

/** The status line reports the outcome of the last completed poll. */
export function pollStatus(summary: PollResult): string {
  const failed = summary.errors.length;
  return failed ? `Kakeratta: connected; ${failed} ask${failed === 1 ? "" : "s"} failed` : "Kakeratta: connected";
}

export class KakerattaService {
  private controller = new AbortController();
  private timer?: number;
  private running?: Promise<void>;
  private lastStatus?: string;
  constructor(private config: KakerattaSettings, private backend: ConnectBackend, private status: (message: string) => void, private rootPaths: () => string[]) {}
  private reportStatus(message: string): void {
    if (message === this.lastStatus) return;
    this.lastStatus = message;
    this.status(message);
  }
  start(): void {
    if (this.config.pollEnabled !== false) this.timer = window.setInterval(() => this.tick(), 60_000);
    this.tick();
  }
  stop(): void {
    this.controller.abort();
    if (this.timer !== undefined) window.clearInterval(this.timer);
    // In-flight HTTP may not be cancellable; the aborted signal prevents further turns.
  }
  private tick(): void {
    if (this.running || this.controller.signal.aborted) return;
    this.running = withKakeratta(this.config, async call => {
      const summary = await pollKakeratta(call, async (messages, systemPrompt, signal, context) => {
        const profile = resolvePersonaProfile(this.config, context);
        const selectedModel = profile.model || this.backend.getDefaultModel();
        const webSearch = !!profile.webSearch && this.backend.supportsWebSearch(selectedModel);
        if ((["antigravity-cli", "claude-cli", "codex-cli"].includes(selectedModel) || selectedModel.startsWith("local-llm:")) &&
            !profile.allVault && profile.vaultFolders.length === 0 && !profile.ragSetting && !webSearch && profile.skillPaths.length === 0) {
          return this.backend.generateText({ model: selectedModel, messages, systemPrompt, signal });
        }
        const result = await this.backend.generate({
          conversation: { messages, lastActivity: Date.now(), model: selectedModel, ragSetting: profile.ragSetting, webSearch, activeSkillPaths: profile.skillPaths },
          model: selectedModel, systemPrompt, signal, vaultFolders: resolveVaultFolders(profile, this.rootPaths),
          ragQuery: (context as { trigger?: { text?: string } })?.trigger?.text ?? "",
        });
        return result.answer.content;
      }, this.controller.signal);
      if (!this.controller.signal.aborted) this.reportStatus(pollStatus(summary));
    }).catch(() => {
      if (!this.controller.signal.aborted) {
        this.reportStatus(this.config.pollEnabled === false ? "Kakeratta: connection failed" : "Kakeratta: connection failed; retrying in one minute");
      }
    }).finally(() => { this.running = undefined; });
  }
}
