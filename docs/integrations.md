# Integrations

The MCP server (`node mcp.js`) gives AI clients one set of tools for the dashboard's own data and for every platform configured under `integrations` in `config.json`. This page covers how to set up each platform, register the clients, and find out why something does not connect.

Start from [`config.example.json`](../config.example.json). Each key under `integrations` is an instance id (`a-z`, `0-9` and `-`, up to 32 characters). It becomes the prefix of that instance's tools, so `dynatrace-saas` gives you `dynatrace-saas_list_problems`. You can run two instances of one type. Any entry can be switched off with `"enabled": false`.

## Storing a secret

Secrets never go into `config.json`. A secret field holds a reference instead:

```json
"token": { "keychain": "acc.dynatrace-saas" }
"token": { "env": "DT_TOKEN" }
```

Store a value in the macOS Keychain (you are prompted for it, so it does not end up in your shell history):

```bash
security add-generic-password -a "$USER" -s acc.dynatrace-saas -w
```

Add `-U` to replace an existing value. Environment variables work too, but clients launched from the Dock or Finder often do not inherit your shell's variables, so the Keychain is the safer default. A plain string in a secret field is rejected with an error.

## Write tools

Every tool is read-only unless it says otherwise. Write tools (running an n8n workflow, a POST endpoint of an HTTP integration, an upstream MCP tool not marked read-only) are only offered when the integration sets `"allowWrite": true`. They carry `readOnlyHint: false`, so clients ask before running them.

## Dynatrace SaaS

1. In Dynatrace, go to **Access tokens → Generate new token** and grant `problems.read`, `entities.read`, `metrics.read`, `logs.read` and `securityProblems.read`.
2. Store the token: `security add-generic-password -a "$USER" -s acc.dynatrace-saas -w`.
3. Set `baseUrl` to `https://<environment-id>.live.dynatrace.com`.
4. For DQL on Grail, create a platform token with `storage:logs:read`, `storage:events:read`, `storage:metrics:read`, `storage:spans:read`, `storage:entities:read` and `storage:buckets:read`. Store it as `acc.dynatrace-saas-platform`, and set `platformUrl` to `https://<environment-id>.apps.dynatrace.com` and `platformToken` to the reference.

Tools: `list_problems`, `get_problem`, `list_entities`, `query_metrics`, `query_logs`, `list_security_problems`, and `dql` (only with a platform token).

## Dynatrace Managed

Use the same API token scopes. `baseUrl` is `https://<cluster-host>/e/<environment-id>`. Managed has no Grail, so there is no `dql` tool. This connector can run alongside the official `dynatrace-managed-mcp` server.

## Arize Phoenix

- **Local Phoenix:** `baseUrl` `http://localhost:6006`. An `apiKey` is only needed when authentication is enabled (**Settings → API Keys**).
- **Phoenix Cloud:** `baseUrl` `https://app.phoenix.arize.com/s/<space>`, with an `apiKey`.

Set `"flavor": "phoenix"`. Tools: `list_projects`, `search_spans`, `list_traces`, `list_datasets`, `list_experiments`.

## Arize AX

Create an API key under **Settings → API Keys**, store it, and set `"flavor": "ax"`. `baseUrl` defaults to `https://api.arize.com`. Tools: `list_projects`, `search_spans`, `list_traces`, `list_datasets`, `list_experiments`, `list_monitors`.

## n8n

1. In n8n, go to **Settings → n8n API → Create an API key** and store it as `acc.n8n`.
2. Set `baseUrl` to your instance URL.
3. To let agents start workflows, give each workflow a **Webhook** trigger and list its production URL under `webhooks` with a short name. `run_workflow` only accepts names from this list, and the API key is never sent to a webhook.
4. Set `"allowWrite": true` to enable `run_workflow` and `set_workflow_active`.

Read tools: `list_workflows`, `get_workflow` (node names and types, never credentials), `list_executions`, `get_execution`.

## OmniRoute

OmniRoute serves its gateway and dashboard on `http://localhost:20128`.

1. Create a read-only access token and store it:
   ```bash
   omniroute tokens create --name ai-command-center --scope read
   security add-generic-password -a "$USER" -s acc.omniroute -w
   ```
2. Set it as `managementToken`.

Tools: `health`, `list_models`, `list_providers` (emails and credentials left out), `list_combos`, `usage`, `telemetry`. `/v1/models` needs an inference key (`sk-…`) instead. Set it as `apiKey` if you want models listed from there.

OmniRoute also has its own MCP server (`/api/mcp/stream`, about 110 tools), but it requires an **admin** token. The `omniroute-mcp` example entry is disabled for that reason. Enable it only if you accept giving agents admin-level access, and keep `include` narrow.

## 9router

Set `"flavor": "9router"`, `baseUrl` (default `http://localhost:20128`, the same port as OmniRoute, so change one of them if you run both), and an optional `apiKey`. Tools: `health`, `list_models`.

## AION and other HTTP APIs

Use `"type": "http"` for any REST API without a dedicated connector. Each entry in `endpoints` becomes one tool:

| Field | Meaning |
|---|---|
| `name` | Tool name after the prefix, `a-z`, `0-9` and `_` |
| `method` | `GET` (default), `POST`, `PUT`, `PATCH` or `DELETE` |
| `path` | Starts with `/`. `{param}` placeholders become required string arguments |
| `params` | JSON Schema `properties` for the other arguments. They go to the query string (GET, DELETE) or the JSON body (POST, PUT, PATCH) |
| `required` | Extra required argument names |
| `body` | Fixed JSON merged under the arguments in the body |
| `write` | Defaults to `true` for anything but GET. Set `false` for search-style POSTs |
| `description` | What the tool does, written for the AI |

Other fields: `auth` (`header`, `prefix`, `secret`), `headers` (non-secret values only), and `healthPath`. Without a health path, the integration shows as "not checked".

## Upstream MCP servers

Use `"type": "mcp"` to re-expose a Streamable HTTP MCP server. Set `url`, optional `auth`, and optional `include` and `exclude` glob lists (for example `["*health*"]`). Tools appear as `<id>__<upstream tool>`. An upstream tool counts as a write unless it is annotated `readOnlyHint: true`.

## Registering clients

The stdio server is registered as `zaafpulse`, the same name the HTTP endpoint `/mcp` uses, so a client never lists the same tools under two names. Use one of the two per client: the stdio server on the machine that runs ZAAFPulse, or the HTTP endpoint from elsewhere (snippets per client are in the `zaafpulse-mcp` skill).

```bash
npm run mcp:register -- all                   # every client found on this machine; the others are listed as skipped
npm run mcp:register -- codex --dry-run       # show what would change, without writing
npm run mcp:register -- cursor --data ~/zp    # the client's server uses this data folder
npm run mcp:register -- claude --remove
```

| Client | id | macOS | Linux | Windows | How |
|---|---|---|---|---|---|
| Claude Code | `claude` | `~/.claude.json` | same | same | `claude mcp add --scope user` (and `mcp remove`). With `CLAUDE_CONFIG_DIR`, its `.claude.json` is read there. The commands are printed when the `claude` CLI is not on PATH |
| Kiro | `kiro` | `~/.kiro/settings/mcp.json` | same | same | `mcpServers` |
| Antigravity | `antigravity` | `~/.gemini/config/mcp_config.json` | same | same | `mcpServers` |
| Cursor | `cursor` | `~/.cursor/mcp.json` | same | same | `mcpServers`, `"type": "stdio"` |
| VS Code | `vscode` | `~/Library/Application Support/Code/User/mcp.json` | `~/.config/Code/User/mcp.json` | `%APPDATA%\Code\User\mcp.json` | top-level `servers`, `"type": "stdio"` |
| Claude Desktop | `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` |
| Codex CLI | `codex` | `~/.codex/config.toml` (or `$CODEX_HOME`) | same | same | `codex mcp add` for a new entry when the CLI is installed; otherwise only the `[mcp_servers.zaafpulse]` table is added, replaced or removed |
| Gemini CLI | `gemini` | `~/.gemini/settings.json` | same | same | `mcpServers` |
| Windsurf / Devin Desktop | `windsurf` | `~/.config/devin/mcp_config.json` | same (`$XDG_CONFIG_HOME/devin`) | `%APPDATA%\devin\mcp_config.json` | `mcpServers`. A Windsurf install from before the June 2026 rename keeps `~/.codeium/windsurf/mcp_config.json`; when that folder exists, `windsurf` (and `all`) update it too, as the `windsurf-legacy` client |
| Zed | `zed` | `~/.config/zed/settings.json` | `$XDG_CONFIG_HOME/zed/settings.json` | `%APPDATA%\Zed\settings.json` | `context_servers` |

On Linux, `~/.config` stands for `$XDG_CONFIG_HOME` when it is set.

What registration does:

- **Only our entry is touched.** Other servers, and settings you added to ours (`disabled`, `autoApprove`, Codex `enabled` or timeouts), are kept.
- **Stale entries are replaced.** The entry is compared by command, arguments and environment. After moving the install or updating Node it is rewritten; Claude Code gets `mcp remove` then `mcp add`.
- **The old name is migrated.** An `ai-command-center` entry that starts ZAAFPulse (`mcp.js`, or the `zaafpulse` binary with `mcp`) is removed; one that starts something else is left alone. `--remove` removes both names.
- **The data folder goes with it.** A client starts the server without your shell's environment. When `--data`, `ZAAFPULSE_DATA`, `ACC_CONFIG` or `ACC_CACHE_DIR` points somewhere other than the folder `mcp.js` finds on its own, the entry gets an `env` with the absolute path.
- **Files are written carefully.** Before a change the file is copied to `<file>.bak-<timestamp>` (the newest 3 are kept). A symlinked config is written through to its target, the file's permissions are kept, a UTF-8 BOM is kept, and an empty or `null` file counts as empty. A file that is not valid JSON is left alone with an error.
- **Files with comments are not rewritten.** VS Code, Zed and Gemini CLI accept comments in their settings. When the file has comments or trailing commas, it is left as it is and the exact entry to add is printed (for VS Code also as a `code --add-mcp` command). Codex's TOML is never re-serialised: when `mcp_servers` is written as dotted keys or an inline table, the table to add is printed instead.
- **`all` only touches installed clients**, judged by the client's config folder or its CLI on PATH, so it never creates folders for apps you do not have.

Restart the client afterwards.

Sources checked in October 2026: [Cursor](https://cursor.com/docs/context/mcp), [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) and [VS Code settings paths](https://code.visualstudio.com/docs/configure/settings), [Claude Desktop](https://modelcontextprotocol.io/quickstart/user), [Claude Code MCP](https://code.claude.com/docs/en/mcp) and [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars), [Codex MCP](https://developers.openai.com/codex/mcp) and [config reference](https://developers.openai.com/codex/config-reference), [Gemini CLI](https://geminicli.com/docs/tools/mcp-server), [Antigravity](https://antigravity.google/docs/mcp), [Devin Desktop (Windsurf)](https://docs.devin.ai/desktop/cascade/mcp) and its [FAQ](https://docs.devin.ai/desktop/devin-desktop-faq), [Zed](https://zed.dev/docs/ai/mcp). The Claude Desktop path on Linux and the Zed path on Windows are not given in those pages.

## Troubleshooting

- Open **Integrations** in the dashboard. Every integration shows its state, latency and last error, and **Test** runs a fresh check.
- Ask the agent to call `acc_integrations_status`.
- `.cache/mcp-audit.jsonl` lists every tool call: time, tool, ok or error, duration and argument names. Argument values are never recorded.
- The MCP server reads `config.json` when it starts. After editing it, restart the client (or its MCP connection). The dashboard picks up changes on its own.
- "Keychain item not found" means the reference names a service that was not stored. Check with `security find-generic-password -s <service>`.
