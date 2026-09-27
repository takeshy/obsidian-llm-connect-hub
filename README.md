# LLM Connect Hub

An independent Obsidian plugin for Discord and Kakeratta. It uses models, RAG, skills, and Vault tools exposed by LLM Hub's versioned API (protocolVersion 1).

Run `cd /path/to/obsidian-llm-connect-hub && npm ci && npm run build` and copy `manifest.json` and `main.js` into `.obsidian/plugins/obsidian-llm-connect-hub/` in your Vault. Enable LLM Hub and LLM Connect Hub; either load order works. On first connection, LLM Connect Hub copies legacy Discord/Kakeratta settings and credentials, saves them, then disables the old connections. The original values remain for rollback. If migration fails, it retries on restart.

For Discord, create a bot in the Developer Portal and enable Message Content Intent. Enter its token under LLM Connect Hub → Discord, verify it, enable the connection, then **Save and reconnect**. Per-channel model/RAG/skill and other commands remain available.

For Kakeratta, issue a connection key under **Settings → Advanced options → Integrations**. Enter the displayed MCP URL and `{"Authorization":"Bearer YOUR_KEY"}` in LLM Connect Hub. Choose a default answer model, load the persona list, and configure each persona ID's model, Vault folders (one Vault-relative path per line), RAG setting, and folder skills (one name or path per line). Enable the connection and **Save and reconnect**, then enable **Prefer the external agent** for the personas in Kakeratta.

The plugin polls once a minute while Obsidian runs and uses no model tokens when idle. Keep Kakeratta's claim wait longer than one minute. Scoped Vault research requires an API model; Vault tools cannot read outside the selected folders and are disabled when the list is empty. RAG searches the selected index independently of the Vault folder list. Skill instructions are available, but scripts and workflows are disabled for Kakeratta. CLI and local models remain available for text-only persona answers without Vault/RAG/skill settings. Choose a model that follows JSON output instructions.

Credentials are stored in Obsidian SecretStorage by default. Plaintext storage is an explicit option. Do not share a `data.json` containing a bot token or Kakeratta connection key.

Pushing a new matching version in `package.json`, `manifest.json`, and `versions.json` to `main` builds and tests the plugin, then creates a draft GitHub release with `main.js` and `manifest.json`. No local Git tag is needed.
