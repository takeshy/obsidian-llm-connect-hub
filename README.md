# LLM Connect Hub

An independent Obsidian plugin for Discord and Kakeratta. It uses models, RAG, skills, and Vault tools exposed by LLM Hub's versioned API (protocolVersion 1).

Run `cd /path/to/obsidian-llm-connect-hub && npm ci && npm run build` and copy `manifest.json` and `main.js` into `.obsidian/plugins/obsidian-llm-connect-hub/` in your Vault. Enable LLM Hub and LLM Connect Hub; either load order works. On first connection, LLM Connect Hub copies legacy Discord/Kakeratta settings and credentials, saves them, then disables the old connections. The original values remain for rollback. If migration fails, it retries on restart.

For Discord, create a bot in the Developer Portal and enable Message Content Intent. Enter its token under LLM Connect Hub → Discord, verify it, enable the connection, then **Save and reconnect**. Per-channel model/RAG/skill and other commands remain available.

For Kakeratta, issue a connection key under **Settings → Advanced options → Integrations**. Enter the displayed MCP URL, then **Add header** with name `Authorization` and value `Bearer YOUR_KEY`. Headers can be added and removed without JSON. Configure the shared **Default settings** for the answer model, Vault folders, RAG, and skills. Use **Add persona override** to search for a persona and customize a copy of the defaults; removing an override restores the defaults. Choose **Read the entire vault** (including root notes and future folders), or enter Vault-relative folders one per line. Use **Add skill** to search the same folder skills as chat and remove selected skills individually. Enable the connection and **Save and reconnect**, then enable **Prefer the external agent** for the personas in Kakeratta.

With **Check periodically** on, the plugin polls once a minute while Obsidian runs. With it off, it checks once when the connection starts. It uses no model tokens when idle. When periodic checking is on, keep Kakeratta's claim wait longer than one minute. Scoped Vault research requires an API model; Vault tools cannot read outside the selected folders and are disabled when the list is empty and entire-vault access is off. RAG searches the selected index independently of the Vault folder list. Skill instructions are available, but scripts and workflows are disabled for Kakeratta. CLI and local models remain available for text-only persona answers without Vault/RAG/skill settings. Choose a model that follows JSON output instructions.

Credentials are stored in Obsidian SecretStorage by default. Plaintext storage is an explicit option. Do not share a `data.json` containing a bot token or Kakeratta connection key.

Pushing a new matching version in `package.json`, `manifest.json`, and `versions.json` to `main` builds and tests the plugin, then creates a draft GitHub release with `main.js` and `manifest.json`. No local Git tag is needed.
