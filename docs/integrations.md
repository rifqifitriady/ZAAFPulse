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

```bash
npm run mcp:register -- all              # Claude Code, Kiro and Antigravity
npm run mcp:register -- kiro --dry-run   # show what would change
npm run mcp:register -- claude --remove
```

| Client | Where |
|---|---|
| Claude Code | `claude mcp add --scope user` (the command is printed if the `claude` CLI is missing) |
| Kiro | `~/.kiro/settings/mcp.json` |
| Antigravity | `~/.gemini/config/mcp_config.json` |

Before a file is changed, it is copied to `<file>.bak-<timestamp>`. Only the `ai-command-center` entry is touched, and a file that is not valid JSON is left alone. Restart the client afterwards.

## Troubleshooting

- Open **Integrations** in the dashboard. Every integration shows its state, latency and last error, and **Test** runs a fresh check.
- Ask the agent to call `acc_integrations_status`.
- `.cache/mcp-audit.jsonl` lists every tool call: time, tool, ok or error, duration and argument names. Argument values are never recorded.
- The MCP server reads `config.json` when it starts. After editing it, restart the client (or its MCP connection). The dashboard picks up changes on its own.
- "Keychain item not found" means the reference names a service that was not stored. Check with `security find-generic-password -s <service>`.
