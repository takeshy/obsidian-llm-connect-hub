import { App, Notice, requestUrl } from "obsidian";
import type { ConnectBackend, DiscordSettings, ConversationState, AnswerResult, PromptTemplate } from "./contract";
const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

// Discord API constants
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_USER_AGENT = "DiscordBot (https://github.com/obsidian-llm-hub, 1.0)";

// Gateway Opcodes
const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// Gateway Intents
const GatewayIntents = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
};

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  mentions: Array<{ id: string }>;
  type: number;
}

interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

const MAX_CONVERSATION_MESSAGES = 20;
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SNOWFLAKE_RE = /^\d{17,20}$/;

export class DiscordService {
  private controller = new AbortController();
  private ws: WebSocket | null = null;
  private heartbeatInterval: number | null = null;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;
  private isConnected = false;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private conversations = new Map<string, ConversationState>();
  private channelQueues = new Map<string, Array<{ content: string; messageId: string }>>();
  private processingChannels = new Set<string>();
  private runningDiscussions = new Map<string, { stop: () => void }>();
  private heartbeatAcked = true;

  constructor(
    private app: App,
    private backend: ConnectBackend,
    private config: DiscordSettings,
  ) {}

  get settings(): DiscordSettings {
    return this.config;
  }

  /**
   * Start the Discord bot
   */
  start(): void {
    if (!this.settings.botToken) {
      throw new Error("Discord bot token is not configured");
    }

    if (this.isConnected) {
      return;
    }

    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.connect();
  }

  /**
   * Stop the Discord bot
   */
  stop(): void {
    this.shouldReconnect = false;
    this.controller.abort();
    this.channelQueues.clear();
    this.pendingSkills.clear();
    this.cleanup();
    this.conversations.clear();
    // Stop all running discussions
    for (const [, handle] of this.runningDiscussions) {
      handle.stop();
    }
    this.runningDiscussions.clear();
  }

  /**
   * Check if the bot is currently connected
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Verify the bot token by fetching the bot user info
   */
  async verifyToken(token: string): Promise<{ success: boolean; username?: string; error?: string }> {
    try {
      const response = await requestUrl({
        url: `${DISCORD_API_BASE}/users/@me`,
        headers: { Authorization: `Bot ${token}`, "User-Agent": DISCORD_USER_AGENT },
      });
      if (response.status >= 400) {
        return { success: false, error: `HTTP ${response.status}: ${response.text}` };
      }
      const data = response.json as { username: string; id: string };
      return { success: true, username: data.username };
    } catch (e) {
      return { success: false, error: formatError(e) };
    }
  }

  // ========================================
  // WebSocket Gateway
  // ========================================

  private connect(): void {
    const url = this.resumeGatewayUrl || DISCORD_GATEWAY_URL;

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error("LLM Connect Hub: Failed to create Discord WebSocket:", formatError(e));
      this.scheduleReconnect();
      return;
    }

    this.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as GatewayPayload;
        this.handleGatewayPayload(payload);
      } catch (e) {
        console.error("LLM Connect Hub: Failed to parse Discord gateway message:", formatError(e));
      }
    };

    this.ws.onclose = (event) => {
      this.isConnected = false;
      this.stopHeartbeat();

      const code = event.code;
      // Non-recoverable close codes
      if (code === 4004) {
        console.error("LLM Connect Hub: Discord authentication failed - invalid bot token");
        new Notice("Discord: Invalid bot token");
        this.shouldReconnect = false;
        return;
      }
      if (code === 4014) {
        console.error("LLM Connect Hub: Discord: Disallowed intents - enable MESSAGE_CONTENT intent in Discord Developer Portal");
        new Notice("Discord: Enable message content intent in the developer portal");
        this.shouldReconnect = false;
        return;
      }

      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event) => {
      console.error("LLM Connect Hub: Discord Gateway WebSocket error:", event);
    };
  }

  private handleGatewayPayload(payload: GatewayPayload): void {
    if (payload.s !== null && payload.s !== undefined) {
      this.lastSequence = payload.s;
    }

    switch (payload.op) {
      case GatewayOp.HELLO: {
        const data = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(data.heartbeat_interval);

        // Resume or identify
        if (this.sessionId && this.lastSequence !== null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }

      case GatewayOp.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;

      case GatewayOp.RECONNECT:
        this.ws?.close();
        break;

      case GatewayOp.INVALID_SESSION: {
        const canResume = payload.d as boolean;
        if (!canResume) {
          this.sessionId = null;
          this.lastSequence = null;
        }
        // Close existing WebSocket before reconnecting
        this.cleanup();
        window.setTimeout(() => {
          if (this.shouldReconnect) {
            this.connect();
          }
        }, canResume ? 1000 : 5000);
        break;
      }

      case GatewayOp.DISPATCH:
        this.handleDispatch(payload.t || "", payload.d);
        break;
    }
  }

  private handleDispatch(event: string, data: unknown): void {
    switch (event) {
      case "READY": {
        const readyData = data as {
          session_id: string;
          resume_gateway_url: string;
          user: { id: string; username: string };
        };
        this.sessionId = readyData.session_id;
        this.resumeGatewayUrl = readyData.resume_gateway_url;
        this.botUserId = readyData.user.id;
        this.isConnected = true;
        this.reconnectAttempts = 0;
        new Notice(`Discord bot connected as ${readyData.user.username}`);
        break;
      }

      case "RESUMED":
        this.isConnected = true;
        this.reconnectAttempts = 0;
        break;

      case "MESSAGE_CREATE": {
        const message = data as DiscordMessage;
        void this.handleMessage(message);
        break;
      }
    }
  }

  private sendIdentify(): void {
    const intents =
      GatewayIntents.GUILDS |
      GatewayIntents.GUILD_MESSAGES |
      GatewayIntents.DIRECT_MESSAGES |
      GatewayIntents.MESSAGE_CONTENT;

    this.send({
      op: GatewayOp.IDENTIFY,
      d: {
        token: this.settings.botToken,
        intents,
        properties: {
          os: "obsidian",
          browser: "obsidian-llm-hub",
          device: "obsidian-llm-hub",
        },
      },
    });
  }

  private sendResume(): void {
    this.send({
      op: GatewayOp.RESUME,
      d: {
        token: this.settings.botToken,
        session_id: this.sessionId,
        seq: this.lastSequence,
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatAcked = true;
    // Send first heartbeat after jitter
    window.setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatInterval = window.setInterval(() => {
        if (!this.heartbeatAcked) {
          // Zombie connection — no ACK received since last heartbeat
          console.warn("LLM Connect Hub: Discord heartbeat ACK not received, reconnecting");
          this.ws?.close(4000);
          return;
        }
        this.sendHeartbeat();
      }, intervalMs);
    }, intervalMs * Math.random());
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      window.clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendHeartbeat(): void {
    this.heartbeatAcked = false;
    this.send({ op: GatewayOp.HEARTBEAT, d: this.lastSequence });
  }

  private send(payload: { op: number; d: unknown }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("LLM Connect Hub: Discord max reconnect attempts reached");
      new Notice("Discord bot: max reconnect attempts reached, stopped");
      this.shouldReconnect = false;
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    window.setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onclose = null; // Prevent reconnect handler
      this.ws.close(1000);
      this.ws = null;
    }
    this.isConnected = false;
  }

  // ========================================
  // Message Handling
  // ========================================

  private async handleMessage(message: DiscordMessage): Promise<void> {
    if (this.controller.signal.aborted) return;
    // Ignore bot messages (including own)
    if (message.author.bot) return;

    // Check if this is a DM (no guild_id)
    const isDM = !message.guild_id;

    // DM policy
    if (isDM && !this.settings.respondToDMs) return;

    // In channels, check if bot is mentioned (when requireMention is enabled)
    if (!isDM && this.settings.requireMention) {
      const isMentioned = message.mentions.some(m => m.id === this.botUserId);
      if (!isMentioned) return;
    }

    // Check allowed channels
    if (this.settings.allowedChannelIds) {
      const allowedChannels = this.settings.allowedChannelIds.split(",").map(s => s.trim()).filter(Boolean);
      if (allowedChannels.length > 0 && !allowedChannels.includes(message.channel_id)) return;
    }

    // Check allowed users
    if (this.settings.allowedUserIds) {
      const allowedUsers = this.settings.allowedUserIds.split(",").map(s => s.trim()).filter(Boolean);
      if (allowedUsers.length > 0 && !allowedUsers.includes(message.author.id)) return;
    }

    // Extract message content (remove bot mention if present)
    let content = message.content;
    if (this.botUserId) {
      content = content.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();
    }

    if (!content) return;

    // Handle ! commands (model, rag, skill, reset)
    const commandResult = await this.handleCommand(content, message.channel_id);
    if (commandResult !== null) {
      if (commandResult.reply) {
        await this.sendResponse(message.channel_id, commandResult.reply, message.id);
      }
      if (commandResult.overrideContent) {
        // Skill without variables — use template as the message content
        content = commandResult.overrideContent;
      } else {
        return;
      }
    }

    // Queue message if channel is already being processed
    if (this.processingChannels.has(message.channel_id)) {
      const queue = this.channelQueues.get(message.channel_id) || [];
      queue.push({ content, messageId: message.id });
      this.channelQueues.set(message.channel_id, queue);
      return;
    }

    await this.processMessage(message.channel_id, content, message.id);
  }

  private async processMessage(channelId: string, content: string, messageId: string): Promise<void> {
    if (this.controller.signal.aborted) return;
    this.processingChannels.add(channelId);

    try {
      // Show typing indicator
      await this.sendTyping(channelId);

      // Get or create conversation history for this channel
      const conversation = this.getConversation(channelId);

      // Check if a skill is being applied — resolve template
      const skillCommand = this.pendingSkills.get(channelId);
      if (skillCommand) {
        this.pendingSkills.delete(channelId);
        content = skillCommand.promptTemplate.replace(/\{selection\}/g, content).replace(/\{content\}/g, content);
      }

      // Add user message
      conversation.messages.push({
        role: "user",
        content,
        timestamp: Date.now(),
      });

      // Trim conversation history
      if (conversation.messages.length > MAX_CONVERSATION_MESSAGES) {
        conversation.messages = conversation.messages.slice(-MAX_CONVERSATION_MESSAGES);
      }
      conversation.lastActivity = Date.now();

      // Generate response
      const generated = await this.generateResponse(conversation);
      const response = generated.content;

      // Add assistant message to conversation
      conversation.messages.push({
        role: "assistant",
        content: response,
        timestamp: Date.now(),
        webSearchUsed: generated.webSearchUsed,
        webSearchSources: generated.webSearchSources,
        providerContinuation: generated.providerContinuation,
      });

      // Append model footer to display
      const modelLabel = this.getModelDisplayName(conversation);
      const displayResponse = response + `\n-# ${modelLabel}`;

      // Send response (split if too long)
      await this.sendResponse(channelId, displayResponse, messageId);
    } catch (e) {
      console.error("LLM Connect Hub: Discord message handling failed:", formatError(e));
      try {
        await this.sendDiscordMessage(channelId, "Sorry, an error occurred while processing your message.");
      } catch { /* ignore */ }
    } finally {
      this.processingChannels.delete(channelId);

      // Process next queued message
      const queue = this.channelQueues.get(channelId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.channelQueues.delete(channelId);
        void this.processMessage(channelId, next.content, next.messageId);
      }
    }
  }

  // ========================================
  // Command Handling
  // ========================================

  private pendingSkills = new Map<string, PromptTemplate>();

  /**
   * Handle ! commands. Returns { reply, overrideContent } if handled, null if not a command.
   * reply is the message to send back (empty = no reply).
   * overrideContent replaces the message content for LLM processing (for immediate skill execution).
   */
  private async handleCommand(content: string, channelId: string): Promise<{ reply: string; overrideContent?: string } | null> {
    if (!content.startsWith("!")) return null;

    const spaceIdx = content.indexOf(" ");
    const cmd = (spaceIdx >= 0 ? content.slice(1, spaceIdx) : content.slice(1)).toLowerCase();
    const arg = spaceIdx >= 0 ? content.slice(spaceIdx + 1).trim() : "";

    switch (cmd) {
      case "model": return { reply: this.handleModelCommand(arg, channelId) };
      case "rag": return { reply: this.handleRagCommand(arg, channelId) };
      case "websearch": return { reply: this.handleWebSearchCommand(channelId) };
      case "skill": return await this.handleSkillCommand(arg, channelId);
      case "research": return this.handleResearchCommand(arg, channelId);
      case "discuss": return this.handleDiscussCommand(arg, channelId);
      case "reset": return { reply: this.handleResetCommand(channelId) };
      case "help": return { reply: this.handleHelpCommand(channelId) };
      default: return null;
    }
  }

  private handleModelCommand(arg: string, channelId: string): string {
    const models = this.getAvailableModels();
    const conversation = this.getConversation(channelId);

    if (!arg) {
      const currentModel = conversation.model || this.settings.model || null;
      const lines = ["**Available models:**"];
      for (const m of models) {
        const marker = m.name === currentModel ? " ✅" : "";
        lines.push(`- \`${m.name}\` — ${m.displayName}${marker}`);
      }
      lines.push("");
      lines.push("Usage: `!model <name>` to switch");
      if (currentModel) {
        lines.push(`Current: \`${currentModel}\``);
      } else {
        lines.push("Current: (default)");
      }
      return lines.join("\n");
    }

    // Find matching model
    const match = models.find(m =>
      m.name === arg || m.displayName.toLowerCase() === arg.toLowerCase()
    );
    if (!match) {
      return `Model \`${arg}\` not found. Use \`!model\` to see available models.`;
    }

    if (conversation.model !== match.name) {
      conversation.cliSession = undefined;
      conversation.lastInteractionId = undefined;
    }
    conversation.model = match.name;

    return `Model switched to **${match.displayName}** (\`${match.name}\`)`;
  }

  private handleRagCommand(arg: string, channelId: string): string {
    const ragNames = this.backend.listRagSettings();
    const conversation = this.getConversation(channelId);

    if (!arg) {
      if (ragNames.length === 0) {
        return "No RAG settings configured. Configure RAG in Obsidian settings.";
      }
      const lines = ["**Available RAG settings:**"];
      for (const name of ragNames) {
        const marker = name === conversation.ragSetting ? " ✅" : "";
        lines.push(`- \`${name}\`${marker}`);
      }
      lines.push(`- \`off\` — Disable RAG${!conversation.ragSetting ? " ✅" : ""}`);
      lines.push("");
      lines.push("Usage: `!rag <name>` to switch, `!rag off` to disable");
      return lines.join("\n");
    }

    if (arg.toLowerCase() === "off") {
      conversation.ragSetting = null;
      return "RAG disabled for this channel.";
    }

    if (!ragNames.includes(arg)) {
      return `RAG setting \`${arg}\` not found. Use \`!rag\` to see available settings.`;
    }

    conversation.ragSetting = arg;
    return `RAG switched to **${arg}**`;
  }

  private handleWebSearchCommand(channelId: string): string {
    const conversation = this.getConversation(channelId);

    // Check if the current model has a native provider search tool.
    const model: string = conversation.model
      || (this.settings.model ? this.settings.model : null)
      || this.backend.getDefaultModel();

    if (!conversation.webSearch && !this.supportsWebSearch(model)) {
      return "Web Search is available with Gemini and official OpenAI, Anthropic, or Grok API models. Current model does not support it.";
    }

    conversation.webSearch = !conversation.webSearch;
    return conversation.webSearch
      ? "Web Search **enabled** for this channel."
      : "Web Search **disabled** for this channel.";
  }

  private async handleSkillCommand(arg: string, channelId: string): Promise<{ reply: string; overrideContent?: string }> {
    const { prompts: slashCommands, folders: folderSkills } = await this.backend.listSkills();
    const conversation = this.getConversation(channelId);

    if (!arg) {
      if (slashCommands.length === 0 && folderSkills.length === 0) {
        return { reply: "No skills configured." };
      }
      const lines = ["**Available skills:**"];
      for (const s of slashCommands) {
        const desc = s.description ? ` — ${s.description}` : "";
        lines.push(`- \`${s.name}\`${desc}`);
      }
      for (const s of folderSkills) {
        const isActive = conversation.activeSkillPaths.includes(s.folderPath);
        const desc = s.description ? ` — ${s.description}` : "";
        const marker = isActive ? " ✅" : "";
        lines.push(`- \`${s.name}\`${desc}${marker}`);
      }
      lines.push("");
      lines.push("Usage: `!skill <name>` to activate, `!skill off` to deactivate all");
      return { reply: lines.join("\n") };
    }

    if (arg.toLowerCase() === "off") {
      conversation.activeSkillPaths = [];
      this.pendingSkills.delete(channelId);
      return { reply: "All skills deactivated." };
    }

    // Try slash command first
    const slashCommand = slashCommands.find(s => s.name.toLowerCase() === arg.toLowerCase());
    if (slashCommand) {
      if (slashCommand.model) {
        conversation.model = slashCommand.model;
      }
      if (slashCommand.searchSelection !== null && slashCommand.searchSelection !== undefined) {
        conversation.ragSetting = slashCommand.searchSelection.ragSetting;
        conversation.webSearch = slashCommand.searchSelection.webSearch;
      }
      if (slashCommand.promptTemplate.includes("{selection}") || slashCommand.promptTemplate.includes("{content}")) {
        this.pendingSkills.set(channelId, slashCommand);
        return { reply: `Skill **${slashCommand.name}** activated. Send the text to apply it to.` };
      }
      return { reply: "", overrideContent: slashCommand.promptTemplate };
    }

    // Try folder skill (toggle on/off)
    const folderSkill = folderSkills.find(s => s.name.toLowerCase() === arg.toLowerCase());
    if (folderSkill) {
      const idx = conversation.activeSkillPaths.indexOf(folderSkill.folderPath);
      if (idx >= 0) {
        conversation.activeSkillPaths.splice(idx, 1);
        return { reply: `Skill **${folderSkill.name}** deactivated.` };
      }
      conversation.activeSkillPaths.push(folderSkill.folderPath);
      return { reply: `Skill **${folderSkill.name}** activated.` };
    }

    return { reply: `Skill \`${arg}\` not found. Use \`!skill\` to see available skills.` };
  }

  private handleResearchCommand(query: string, channelId: string): { reply: string } {
    if (!query) {
      return { reply: "Usage: `!research <query>` — Run Gemini Deep Research on a topic." };
    }

    const conversation = this.getConversation(channelId);

    // Fire-and-forget: run research in background so the channel stays responsive
    void (async () => {
      try {
        const { content: fullText, interactionId } = await this.backend.research({
          query, previousInteractionId: conversation.lastInteractionId, signal: this.controller.signal,
        });

        if (interactionId) {
          conversation.lastInteractionId = interactionId;
        }

        // Add to conversation history so follow-up messages have context
        conversation.messages.push(
          { role: "user", content: `[Deep Research] ${query}`, timestamp: Date.now() },
          { role: "assistant", content: fullText, timestamp: Date.now() },
        );
        if (conversation.messages.length > MAX_CONVERSATION_MESSAGES) {
          conversation.messages = conversation.messages.slice(-MAX_CONVERSATION_MESSAGES);
        }
        conversation.lastActivity = Date.now();

        await this.sendResponse(channelId, fullText || "Deep Research returned no results.");
      } catch (e) {
        try {
          await this.sendDiscordMessage(channelId, `Deep Research error: ${formatError(e)}`);
        } catch { /* ignore */ }
      }
    })();

    return { reply: `Deep Research started for: **${query}**\nThis may take several minutes. You can continue chatting in the meantime.` };
  }

  private handleDiscussCommand(theme: string, channelId: string): { reply: string } {
    if (!theme) {
      return { reply: "Usage: `!discuss <theme>` — Start an AI Discussion on a topic.\nConfigure participants in Discussion Hub." };
    }

    if (this.runningDiscussions.has(channelId) && this.runningDiscussions.get(channelId)) {
      return { reply: "A discussion is already running in this channel. Please wait for it to complete." };
    }

    const hub = this.backend.getDiscussionApi();
    if (!hub) return { reply: "Discussion Hub is not installed or enabled." };
    const config = hub.getConfiguration();

    // Filter out "user" type — no UI to collect user input from Discord
    const isHuman = (person: { providerId: string; modelId: string }) => person.providerId === "discussion-hub" && person.modelId === "user";
    const participants = config.participants.filter((person) => !isHuman(person));
    const voters = config.voters.filter((person) => !isHuman(person));

    if (participants.length < 1) {
      return { reply: "No AI participants configured (user participants are excluded in Discord). Open Discussion Hub in Obsidian and add AI participants." };
    }
    if (voters.length < 1) {
      return { reply: "No AI voters configured (user voters are excluded in Discord). Open Discussion Hub in Obsidian and add AI voters." };
    }

    const turns = config.defaultTurns || 2;

    // Fire-and-forget: run discussion in background
    const abortController = new AbortController();
    this.runningDiscussions.set(channelId, { stop: () => abortController.abort() });
    void (async () => {
      try {
        await this.sendDiscordMessage(channelId, `**Discussion Hub is running ${turns} turn${turns === 1 ? "" : "s"}...**`);
        const result = await hub.runDiscussion({ theme, turns, participants, voters, abortSignal: abortController.signal });
        const lines = [`# AI Discussion: ${result.theme}`, "", "## Discussion", ""];
        for (const turn of result.turns) {
          lines.push(`### Turn ${turn.turnNumber}`, "");
          for (const response of turn.responses) lines.push(`#### ${response.displayName}`, "", response.error ? `> Error: ${response.error}` : response.content, "");
        }
        lines.push("## Conclusions", "");
        for (const conclusion of result.conclusions) lines.push(`### ${conclusion.displayName}`, "", conclusion.content, "");
        lines.push("## Voting Results", "");
        for (const vote of result.votes) lines.push(`- **${vote.voterDisplayName}** → **${vote.votedForDisplayName}**${vote.reason ? `: ${vote.reason}` : ""}`);
        lines.push("", "## Final Conclusion", "", result.finalConclusion || "No winner");
        const markdown = lines.join("\n");

        // Send result (may be split across multiple messages)
        await this.sendResponse(channelId, markdown);
      } catch (e) {
        try {
          await this.sendDiscordMessage(channelId, `Discussion error: ${formatError(e)}`);
        } catch { /* ignore */ }
      } finally {
        this.runningDiscussions.delete(channelId);
      }
    })();

    const participantNames = participants.map(p => p.displayName).join(", ");
    return { reply: `**AI Discussion started:** ${theme}\n**Participants:** ${participantNames}\n**Turns:** ${turns}\nThis may take several minutes.` };
  }

  private handleResetCommand(channelId: string): string {
    this.conversations.delete(channelId);
    this.pendingSkills.delete(channelId);
    return "Conversation history cleared.";
  }

  private handleHelpCommand(_channelId: string): string {
    const lines = [
      "**LLM Connect Hub Discord Bot Commands:**",
      "- `!model` — List available models",
      "- `!model <name>` — Switch model",
      "- `!rag` — List RAG settings",
      "- `!rag <name>` — Switch RAG setting",
      "- `!rag off` — Disable RAG",
      "- `!websearch` — Toggle native Web Search (Gemini or official OpenAI/Anthropic/xAI APIs)",
      "- `!skill` — List available skills",
      "- `!skill <name>` — Activate a skill",
      "- `!research <query>` — Run Deep Research (runs in background, may take several minutes)",
      "- `!discuss <theme>` — Start AI Discussion (uses participants configured in Discussion Hub)",
      "- `!reset` — Clear conversation history",
      "- `!help` — Show this help",
    ];
    return lines.join("\n");
  }

  private getAvailableModels(): Array<{ name: string; displayName: string }> {
    return this.backend.listModels();
  }

  private getConversation(channelId: string): ConversationState {
    // Clean up stale conversations
    const now = Date.now();
    for (const [id, conv] of this.conversations) {
      if (now - conv.lastActivity > CONVERSATION_TTL_MS) {
        this.conversations.delete(id);
      }
    }

    let conv = this.conversations.get(channelId);
    if (!conv) {
      conv = { messages: [], lastActivity: now, model: null, ragSetting: null, webSearch: false, activeSkillPaths: [] };
      this.conversations.set(channelId, conv);
    }
    return conv;
  }

  private getModelDisplayName(conversation: ConversationState): string {
    const model: string = conversation.model
      || (this.settings.model ? this.settings.model : null)
      || this.backend.getDefaultModel();
    const models = this.getAvailableModels();
    const found = models.find(m => m.name === model);
    const label = found ? found.displayName : model;
    const extras: string[] = [];
    if (conversation.ragSetting) extras.push(`RAG: ${conversation.ragSetting}`);
    if (conversation.webSearch) {
      extras.push(this.supportsWebSearch(model) ? "WebSearch" : "WebSearch (inactive)");
    }
    return extras.length > 0 ? `${label} | ${extras.join(" | ")}` : label;
  }

  private supportsWebSearch(model: string): boolean {
    return this.backend.supportsWebSearch(model);
  }

  private async generateResponse(conversation: ConversationState): Promise<AnswerResult> {
    const result = await this.backend.generate({ conversation, model: this.settings.model, systemPrompt: this.settings.systemPrompt, signal: this.controller.signal });
    if (this.controller.signal.aborted) throw new Error("Connection stopped");
    Object.assign(conversation, result.conversation);
    return result.answer;
  }

  // ========================================
  // Discord REST API
  // ========================================

  private async sendResponse(channelId: string, content: string, replyToId?: string): Promise<void> {
    const maxLen = Math.max(1, Math.min(this.settings.maxResponseLength || 2000, 2000));

    if (content.length <= maxLen) {
      await this.sendDiscordMessage(channelId, content, replyToId);
      return;
    }

    // Split long messages
    const chunks = this.splitMessage(content, maxLen);
    for (let i = 0; i < chunks.length; i++) {
      await this.sendDiscordMessage(
        channelId,
        chunks[i],
        i === 0 ? replyToId : undefined,
      );
    }
  }

  private splitMessage(content: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Try to split at newline
      let splitIdx = remaining.lastIndexOf("\n", maxLen);
      if (splitIdx < maxLen * 0.5) {
        // Try to split at space
        splitIdx = remaining.lastIndexOf(" ", maxLen);
      }
      if (splitIdx < maxLen * 0.3) {
        splitIdx = maxLen;
      }

      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }

    return chunks;
  }

  private async sendDiscordMessage(
    channelId: string,
    content: string,
    replyToId?: string,
  ): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (!SNOWFLAKE_RE.test(channelId)) {
      throw new Error("Invalid Discord channel ID");
    }
    const body: Record<string, unknown> = { content };
    if (replyToId) {
      body.message_reference = { message_id: replyToId };
      body.allowed_mentions = { replied_user: false };
    }

    const response = await requestUrl({
      url: `${DISCORD_API_BASE}/channels/${channelId}/messages`,
      method: "POST",
      headers: {
        Authorization: `Bot ${this.settings.botToken}`,
        "User-Agent": DISCORD_USER_AGENT,
      },
      contentType: "application/json",
      body: JSON.stringify(body),
      throw: false,
    });

    // Handle rate limiting
    if (response.status === 429) {
      const responseBody: unknown = response.json;
      const retryAfter = responseBody && typeof responseBody === "object" && "retry_after" in responseBody
        && typeof responseBody.retry_after === "number"
        ? responseBody.retry_after
        : undefined;
      const waitMs = retryAfter ? retryAfter * 1000 : 5000;
      console.warn(`LLM Connect Hub: Discord rate limited, retrying in ${waitMs}ms`);
      await new Promise(resolve => window.setTimeout(resolve, waitMs));
      return this.sendDiscordMessage(channelId, content, replyToId);
    }

    if (response.status >= 400) {
      console.error(`LLM Connect Hub: Discord API ${response.status}:`, response.text);
      throw new Error(`Discord API error: ${response.status} ${response.text}`);
    }
  }

  private async sendTyping(channelId: string): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (!SNOWFLAKE_RE.test(channelId)) return;
    try {
      await requestUrl({
        url: `${DISCORD_API_BASE}/channels/${channelId}/typing`,
        method: "POST",
        headers: {
          Authorization: `Bot ${this.settings.botToken}`,
          "User-Agent": DISCORD_USER_AGENT,
        },
      });
    } catch {
      // Typing indicator is non-critical, ignore errors
    }
  }
}
