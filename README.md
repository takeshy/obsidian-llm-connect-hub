# LLM Connect Hub

[日本語](README_ja.md)

An Obsidian plugin that connects **Discord** and **[Kakeratta](https://kakeratta.net/lp/)** to the models, RAG, skills, and Vault tools provided by [LLM Hub](https://github.com/takeshy/obsidian-llm-hub).

Available as a community plugin: <https://community.obsidian.md/plugins/llm-connect-hub>

## Features

- **Discord bot** — Chat with LLM Hub models from Discord DMs, mentions, or allowed channels. Switch model, RAG, and skills per channel with commands.
- **Kakeratta integration** — Answer [Kakeratta](https://kakeratta.net/lp/) persona requests with your own Obsidian models, Vault notes, RAG, and skills.
- **Secure credentials** — Tokens and keys are stored in Obsidian SecretStorage by default.

## Requirements

- Obsidian 1.13.0 or later (desktop only)
- [LLM Hub](https://github.com/takeshy/obsidian-llm-hub) with public API support (protocolVersion 1)

## Installation

### From the community plugins (recommended)

1. Open <https://community.obsidian.md/plugins/llm-connect-hub>, or search for **LLM Connect Hub** in **Settings → Community plugins → Browse**.
2. Install and enable **LLM Hub** and **LLM Connect Hub**. Load order does not matter.
3. Open the LLM Connect Hub settings and confirm that LLM Hub is shown as the model provider.

### Manual build

```sh
cd /path/to/obsidian-llm-connect-hub
npm ci
npm run build
```

Copy `manifest.json` and `main.js` into `<Vault>/.obsidian/plugins/llm-connect-hub/`.

### Migrating from LLM Hub's built-in connections

On first connection, LLM Connect Hub copies the Discord/Kakeratta settings and credentials saved in LLM Hub, saves them, and then disables the old connections in LLM Hub. The original values are kept for rollback. If migration fails partway, it retries on the next restart.

To roll back, disable LLM Connect Hub and re-enable the old connections in LLM Hub.

## Discord

### Setup

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications), enable **Message Content Intent**, and invite the bot to your server.
2. In **LLM Connect Hub → Discord**, enter the bot token and click **Verify token**.
3. Turn on **Enabled** and click **Save and reconnect**.

You can configure DMs, mentions, allowed channels/users, the default model, the system prompt, and the maximum message length.

### Commands

| Command | Description |
| --- | --- |
| `!model` / `!model <name>` | List models / switch model |
| `!rag` / `!rag <name>` / `!rag off` | List RAG settings / switch / disable |
| `!websearch` | Toggle native Web Search (Gemini or official OpenAI/Anthropic/xAI APIs) |
| `!skill` / `!skill <name>` | List skills / activate a skill |
| `!research <query>` | Run Deep Research in the background |
| `!discuss <theme>` | Start an AI Discussion (uses participants from Discussion Hub) |
| `!reset` | Clear conversation history |
| `!help` | Show help |

## Kakeratta

[Kakeratta](https://kakeratta.net/lp/) personas can delegate their answers to LLM Connect Hub. Requests are answered using models, Vault notes, RAG, and skills in your Obsidian.

### Setup

1. In Kakeratta, go to **Settings → Advanced options → Integrations** and issue a connection key.
2. In **LLM Connect Hub → Kakeratta**, enter the displayed MCP URL.
3. Click **Add header** and set name `Authorization` and value `Bearer YOUR_KEY`. (If migrated, just check the value.)
4. Configure **Default settings** (see below).
5. Turn on **Enabled** and click **Save and reconnect**.
6. In Kakeratta, turn on **Prefer the external agent** for the target personas.

### Default settings and persona overrides

| Setting | Description |
| --- | --- |
| Answer model | Model used for answers. Choose one that follows JSON output instructions. |
| Vault folders | Turn on **Read the entire vault** (including root notes and future folders), or list Vault-relative folders one per line. If off and empty, Vault tools are disabled. |
| RAG | Index to search. Independent of the Vault folder list. |
| Web Search | Use native Web Search with supported Gemini or official OpenAI, Anthropic, or xAI API models. Off by default. |
| Skills | Use **Add skill** to search and add the same folder skills as chat. Remove them individually. |

Use **Add persona override** to search for a persona and customize a copy of the defaults. Removing an override restores the defaults.

### Polling

- **Check periodically** on: checks for requests once a minute while Obsidian runs. Keep Kakeratta's claim wait longer than one minute.
- **Check periodically** off: checks once when the connection starts.
- No model tokens are used when there are no requests.
- After each check, the connection status shows failed asks (e.g. `Kakeratta: connected; 1 ask failed`). Failed or expired requests fall back to Kakeratta's built-in model.

### Limitations

- Scoped Vault research requires an API model. Vault tools cannot read outside the selected folders.
- Skill instructions are available, but scripts and workflows are disabled.
- CLI and local models can still be used for text-only answers by personas without Vault/RAG/skill settings.

## Security

- Credentials are stored in Obsidian SecretStorage by default. If SecretStorage is unavailable, you must explicitly choose plaintext storage.
- Do not share a `data.json` that contains a bot token or Kakeratta connection key.

## Development

```sh
npm ci
npm test
npm run build
```

### Release

Bump the version to the same value in `package.json`, `manifest.json`, and `versions.json`, then push to `main`. GitHub Actions tests and builds the plugin and creates a draft release with `main.js` and `manifest.json`. No local Git tag is needed.

## License

MIT
