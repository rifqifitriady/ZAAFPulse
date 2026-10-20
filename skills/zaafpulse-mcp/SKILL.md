---
name: zaafpulse-mcp
description: Call the user's integration tools through ZAAFPulse's MCP server over HTTP (JSON-RPC at /mcp). The tools cover AI usage and quality, OmniRoute, n8n, observability and the other integrations configured in ZAAFPulse. Use it when the user wants live data or actions from those integrations, or wants to add ZAAFPulse as an MCP server in a client.
---

# ZAAFPulse: MCP tools

Requires `ZAAFPULSE_URL` and `ZAAFPULSE_KEY`, with a key that has the `mcp` scope. For setup, read the `zaafpulse` skill.

## Add ZAAFPulse to an MCP client

On the machine that runs ZAAFPulse, `npm run mcp:register -- all` already adds the local server, under the same name `zaafpulse`. Add the HTTP endpoint only for a client that has no local entry, or on another machine; with both, the client lists every tool twice.

Each client spells the HTTP entry differently. Replace `http://127.0.0.1:4777` with your `ZAAFPULSE_URL`, and `zp_...` with the key wherever the client cannot read it from the environment.

**Claude Code**

```bash
claude mcp add --transport http --scope user zaafpulse $ZAAFPULSE_URL/mcp --header "Authorization: Bearer $ZAAFPULSE_KEY"
```

**Cursor** (`~/.cursor/mcp.json`; `${env:NAME}` is read from the environment)

```json
{ "mcpServers": { "zaafpulse": { "url": "http://127.0.0.1:4777/mcp", "headers": { "Authorization": "Bearer ${env:ZAAFPULSE_KEY}" } } } }
```

**VS Code** (user `mcp.json`, opened with **MCP: Open User Configuration**; the key is asked once and stored securely)

```json
{
  "servers": {
    "zaafpulse": {
      "type": "http",
      "url": "http://127.0.0.1:4777/mcp",
      "headers": { "Authorization": "Bearer ${input:zaafpulse-key}" }
    }
  },
  "inputs": [{ "type": "promptString", "id": "zaafpulse-key", "description": "ZAAFPulse API key", "password": true }]
}
```

**Codex CLI** (`~/.codex/config.toml`, or `$CODEX_HOME/config.toml`; the token is read from the variable named)

```toml
[mcp_servers.zaafpulse]
url = "http://127.0.0.1:4777/mcp"
bearer_token_env_var = "ZAAFPULSE_KEY"
```

**Gemini CLI** (`~/.gemini/settings.json`; `httpUrl` is streamable HTTP, `url` would mean SSE; `$ZAAFPULSE_KEY` is expanded)

```json
{ "mcpServers": { "zaafpulse": { "httpUrl": "http://127.0.0.1:4777/mcp", "headers": { "Authorization": "Bearer $ZAAFPULSE_KEY" } } } }
```

**Antigravity** (`~/.gemini/config/mcp_config.json`)

```json
{ "mcpServers": { "zaafpulse": { "serverUrl": "http://127.0.0.1:4777/mcp", "headers": { "Authorization": "Bearer zp_..." } } } }
```

**Windsurf / Devin Desktop** (`~/.config/devin/mcp_config.json`, on Windows `%APPDATA%\devin\mcp_config.json`, shared with the Devin CLI; Cascade accepts `url` or `serverUrl`, the CLI documents `url`; `${env:NAME}` is read from the environment in Cascade)

```json
{ "mcpServers": { "zaafpulse": { "url": "http://127.0.0.1:4777/mcp", "headers": { "Authorization": "Bearer ${env:ZAAFPULSE_KEY}" } } } }
```

**Zed** (`settings.json`, opened with `zed: open settings file`)

```json
{ "context_servers": { "zaafpulse": { "url": "http://127.0.0.1:4777/mcp", "headers": { "Authorization": "Bearer zp_..." } } } }
```

**Claude Desktop**: its config file starts local servers only, so use `npm run mcp:register -- claude-desktop` on the ZAAFPulse machine.

## Call it directly (JSON-RPC 2.0)

```bash
# List tools
curl -s $ZAAFPULSE_URL/mcp -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[] | "\(.name)\t\(.description)"'

# Call one
curl -s $ZAAFPULSE_URL/mcp -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"acc_usage_summary","arguments":{"range":"7"}}}'
```

- The answer is `result.content[]`, a list of text parts.
- A tool error comes back with `result.isError: true`.

## Good practice

- List tools first, and use only names that the list returns.
- Tools that write anything are disabled unless the user allowed writes for that integration.
- Integration secrets stay in the macOS Keychain and never appear in tool results.
