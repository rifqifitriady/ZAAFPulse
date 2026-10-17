# MCP integrations hub: design

Date: 2026-10-17 · Status: approved

## Decisions from review (2026-10-17)

| Platform | Decision |
|---|---|
| Dynatrace | Both SaaS and Managed, as two instances (`dynatrace-saas`, `dynatrace-managed`). The existing `dynatrace-managed-mcp` in Claude Code stays alongside it. |
| Arize | Phoenix is the instance in use (`flavor: "phoenix"`). AX support is still built, but is not in the live config. |
| n8n | As designed: read tools, plus `run_workflow` limited to allowlisted webhooks and `set_workflow_active`, behind `allowWrite`. |
| OmniRoute | Live and tested on this Mac. A `read`-scope access token named `ai-command-center` is stored in Keychain as `acc.omniroute`. That token works for `/api/health`, `/api/models`, `/api/combos`, `/api/providers`, `/api/usage/analytics` and `/api/telemetry/summary`. `/v1/models` needs an inference key (`sk-…`) and none exists, so the omniroute flavor lists models from `/api/models` and uses `/v1/models` only when `apiKey` is set. OmniRoute's own MCP (`/api/mcp/stream`) demands an `admin` token, so the `omniroute-mcp` proxy entry ships with `enabled: false`. |
| 9router | Supported (flavor `9router`), covered by unit tests against a fake server, and not tested live yet. |
| Kiro | `~/.kiro/settings/mcp.json` is created by the registration script. Not tested live yet. |

## Goal

Give AI Command Center (ZAAFPulse) an MCP server, so that AI clients on this Mac (Claude Code, Kiro, Antigravity) can:

1. query the dashboard's own data (usage, cost, quality, live apps), and
2. reach outside platforms through one place: Dynatrace, Arize (AX and Phoenix), n8n, OmniRoute, 9router, AION and any other HTTP or MCP service added later through config.

The dashboard gains an **Integrations** page that shows the state of every connection and the most recent tool calls.

## Constraints

- **Zero runtime dependencies.** MCP (JSON-RPC 2.0 over stdio, and Streamable HTTP for the proxy client) is implemented with the Node standard library. Node 18+ (`fetch` is built in).
- **Secrets never live in `config.json`.** A secret field is a reference: `{ "env": "NAME" }` or `{ "keychain": "service-name" }` (read with `security find-generic-password -s <service> -w`). Resolved values are masked in every error and log line.
- **Read plus safe actions.** All read tools are on by default. Write tools exist only where an action can be undone or is explicitly allowlisted, appear only when the integration sets `allowWrite: true`, and carry MCP annotations so clients ask before running them.
- **Dashboard stays local.** The server keeps listening on 127.0.0.1 with the host-header check. The web UI never writes to other apps' config files.
- Match the existing code style: CommonJS, small single-purpose files in `lib/`, short comments, no build step.

## Architecture

```
Claude Code ─┐                       ┌─ Dynatrace      API v2 (SaaS + Managed), DQL on SaaS
Kiro ────────┼─ stdio ─► mcp.js ─────┼─ Arize          AX REST /v2 · Phoenix REST /v1
Antigravity ─┘   (MCP server)        ├─ n8n            REST /api/v1 + allowlisted webhooks
                     │               ├─ router         OmniRoute / 9router (OpenAI-compatible + management API)
                     │               ├─ http           generic, endpoints declared in config (AION, others)
                     │               └─ mcp            upstream MCP server, tools re-exposed with a prefix
                     ▼
            .cache/mcp-audit.jsonl ◄── server.js reads it ──► Integrations page
```

`mcp.js` and `server.js` are separate processes. Both build connectors through `lib/integrations.js` from the same `config.json`. The audit log file is the only thing they share at runtime.

### Files

| File | Responsibility |
|---|---|
| `mcp.js` | stdio entry point. Wires protocol, integrations and audit log. |
| `lib/mcp/protocol.js` | JSON-RPC 2.0 framing (newline-delimited), dispatch of `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Protocol version negotiation: offers `2025-06-18`, accepts the client's version when it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`. |
| `lib/mcp/client.js` | Minimal MCP client over Streamable HTTP (POST, JSON or SSE response, `Mcp-Session-Id`). Used only by the `mcp` connector. |
| `lib/integrations.js` | Reads `config.integrations`, instantiates one connector per entry, applies `enabled` and `allowWrite`, prefixes tool names, runs health checks, routes `tools/call`. |
| `lib/secrets.js` | Resolves secret references and masks resolved values in strings. |
| `lib/audit.js` | Appends one line per tool call to `.cache/mcp-audit.jsonl` and reads the tail; rotates at 5 MB (keeps one `.1` file). |
| `lib/connectors/acc.js` | The dashboard's own data. |
| `lib/connectors/dynatrace.js` | Dynatrace. |
| `lib/connectors/arize.js` | Arize AX and Phoenix (`flavor`). |
| `lib/connectors/n8n.js` | n8n. |
| `lib/connectors/router.js` | OmniRoute and 9router (`flavor`). |
| `lib/connectors/http.js` | Generic HTTP connector. |
| `lib/connectors/mcp-proxy.js` | Upstream MCP proxy. |
| `lib/connectors/base.js` | Shared `request()` helper: base URL join, auth header, 15 s timeout, JSON parse, 50 KB result cap with a truncation note, secret masking on errors. |
| `scripts/register-mcp.js` | Registers or removes the server in Claude Code, Kiro and Antigravity. |
| `config.example.json` | Committed example of every integration type with placeholder references. |
| `docs/integrations.md` | Per-platform setup: where to create the token, minimal scopes, example config. |
| `test/*.test.js` | `node:test` suites. |

### Connector interface

Each connector module exports:

```js
module.exports = {
  type: 'n8n',                       // matches config "type"
  create(id, cfg, ctx) {             // ctx: { secrets, request }
    return {
      health: async () => ({ ok, latencyMs, detail }),
      tools: [{ name, description, inputSchema, write, annotations, run: async (args) => result }],
    };
  },
};
```

`lib/integrations.js` turns `name` into `<id>_<name>` (the `mcp` type uses `<id>__<upstream name>`), drops tools with `write: true` unless `allowWrite` is set, and wraps `run` with timing, audit and error masking. A connector whose config is invalid or whose secret cannot be resolved still appears in `acc_integrations_status` with the error, and contributes no tools. It never stops the other connectors.

Tool results are returned as one `text` content item holding pretty-printed JSON. Failures return `isError: true` with a masked message.

## Connectors and tools

Tool names below omit the `<id>_` prefix. Read tools carry `readOnlyHint: true`. Write tools carry `readOnlyHint: false` plus `destructiveHint` and `idempotentHint` as listed.

### acc (always present, id `acc`)

Reads the same data the dashboard shows, using `Indexer` against the existing `.cache/index.json` (an incremental refresh happens on first use) and the existing `summarize`, quality, `processes.snapshot` and vault functions.

| Tool | Input | Returns |
|---|---|---|
| `usage_summary` | `range`: 7, 30, 90 or `all` | spend, tokens, sessions, top models and projects |
| `quality` | `range` | accuracy, hallucination, poisoning, corrections, safety counts |
| `live_apps` | none | running AI apps with CPU, memory, uptime |
| `integrations_status` | none | every configured integration: type, enabled, ok, latency, tool count, write enabled, last error |

### dynatrace (`type: "dynatrace"`)

Config: `baseUrl` (SaaS `https://<env>.live.dynatrace.com`, or Managed `https://<host>/e/<env-id>`), `token` (API token, header `Authorization: Api-Token <t>`), optional `platformToken` and `platformUrl` (`https://<env>.apps.dynatrace.com`) for DQL.

| Tool | API |
|---|---|
| `list_problems` | `GET /api/v2/problems` (`from`, `problemSelector`, `pageSize`) |
| `get_problem` | `GET /api/v2/problems/{id}` |
| `list_entities` | `GET /api/v2/entities` (`entitySelector` required, `from`, `fields`) |
| `query_metrics` | `GET /api/v2/metrics/query` (`metricSelector`, `from`, `resolution`, `entitySelector`) |
| `query_logs` | `GET /api/v2/logs/search` (`query`, `from`, `limit`) |
| `list_security_problems` | `GET /api/v2/securityProblems` |
| `dql` | `POST {platformUrl}/platform/storage/query/v1/query:execute`, polls `query:poll` until done (only listed when `platformToken` is set) |

Scopes needed: `problems.read`, `entities.read`, `metrics.read`, `logs.read`, `securityProblems.read`; platform token `storage:*:read` for DQL. Health: `GET /api/v2/problems?pageSize=1`.

### arize (`type: "arize"`, `flavor: "ax" | "phoenix"`)

**AX** (`baseUrl` default `https://api.arize.com`, `apiKey` as `Authorization: Bearer`; endpoints from the published `/v2/spec.yaml`):

| Tool | API |
|---|---|
| `list_projects` | `GET /v2/projects` |
| `search_spans` | `POST /v2/spans` (operation `list_spans`: project, time window, filter, limit up to 500) |
| `list_traces` | `GET /v2/traces` |
| `list_datasets` | `GET /v2/datasets` |
| `list_experiments` | `GET /v2/experiments` |
| `list_monitors` | `GET /v2/monitors` |

**Phoenix** (`baseUrl` e.g. `http://localhost:6006` or `https://app.phoenix.arize.com/s/<space>`, optional `apiKey` as Bearer): `list_projects` (`GET /v1/projects`), `search_spans` (`GET /v1/projects/{project}/spans`), `list_datasets` (`GET /v1/datasets`), `list_experiments` (`GET /v1/datasets/{id}/experiments`). Exact query parameters are confirmed against the Phoenix OpenAPI document (`/openapi.json` on the instance) during implementation. Any tool whose path the instance does not serve is reported as unsupported in its error, not hidden.

Health: AX `GET /v2/projects?limit=1`, Phoenix `GET /v1/projects?limit=1`.

### n8n (`type: "n8n"`)

Config: `baseUrl`, `apiKey` (header `X-N8N-API-KEY`), optional `webhooks`: map of name to full webhook URL, optional `allowWrite`.

| Tool | API | Write |
|---|---|---|
| `list_workflows` | `GET /api/v1/workflows` (`active`, `tags`, `limit`) | no |
| `get_workflow` | `GET /api/v1/workflows/{id}` (nodes summarised: name, type, no credentials) | no |
| `list_executions` | `GET /api/v1/executions` (`workflowId`, `status`, `limit`) | no |
| `get_execution` | `GET /api/v1/executions/{id}` (`includeData` off by default) | no |
| `run_workflow` | `POST` to a webhook named in `webhooks` (input: `name`, `payload`). URLs that are not in the allowlist are refused. | yes, `destructiveHint: false`, `idempotentHint: false` |
| `set_workflow_active` | `POST /api/v1/workflows/{id}/activate` or `/deactivate` | yes, `destructiveHint: false`, `idempotentHint: true` |

Health: `GET /api/v1/workflows?limit=1`.

### router (`type: "router"`, `flavor: "omniroute" | "9router"`)

Config: `baseUrl` (default `http://localhost:20128`), `apiKey` (Bearer). For OmniRoute the management routes need a key with `manage` scope or an `oma_live_…` access token, given as optional `managementToken`.

| Tool | API | Flavor |
|---|---|---|
| `health` | `GET /api/health` (OmniRoute, no auth needed); for 9router a `GET /v1/models` round trip | both |
| `list_models` | OmniRoute: `GET /api/models` with `managementToken`, or `GET /v1/models` when `apiKey` is set. 9router: `GET /v1/models` | both |
| `list_providers` | `GET /api/providers` (connections, without credentials) | omniroute |
| `list_combos` | `GET /api/combos` | omniroute |
| `usage` | `GET /api/usage/analytics?period=day\|week\|month`, trimmed to `summary`, `byModel`, `byProvider`, `dailyTrend`, `errorBreakdown` | omniroute |
| `telemetry` | `GET /api/telemetry/summary` | omniroute |

Tools a flavor does not support are not listed. 9router's management API is not documented publicly, so it gets only the OpenAI-compatible tools. Chat completions are deliberately left out, because they spend tokens.

### http (`type: "http"`), used for AION and anything else

Config: `baseUrl`, optional `auth` `{ header, prefix, secret }`, optional `headers` (non-secret), `endpoints`: list of `{ name, method, path, description, params, body, write }`.

- `path` may contain `{param}` placeholders. `params` is a JSON Schema `properties` object that becomes the tool's `inputSchema`; placeholders are filled from it and the rest go to the query string (GET, DELETE) or the JSON body (POST, PUT, PATCH).
- `write` defaults to `true` for any method other than GET, so a POST endpoint needs `allowWrite` unless the config marks it `write: false` (for search-style POSTs).
- `name` must match `^[a-z0-9_]{1,48}$`.
- Health: optional `healthPath`, otherwise the connector reports "configured, not checked".

### mcp (`type: "mcp"`)

Config: `url` (Streamable HTTP endpoint, e.g. OmniRoute `http://localhost:20128/api/mcp/stream`), optional `auth`, optional `include` and `exclude` glob lists, optional `allowWrite`.

On first `tools/list` the proxy initialises a session with the upstream, lists its tools, filters them, and caches the list for 5 minutes. A tool is treated as write unless the upstream marks it `readOnlyHint: true`, so it is hidden without `allowWrite`. Calls are forwarded and their content is returned unchanged, apart from the size cap. stdio upstreams are out of scope (YAGNI): clients can run those directly.

## Configuration

`config.json` gains an `integrations` object keyed by instance id (`^[a-z0-9-]{1,32}$`). Two instances of one type are allowed (e.g. `dynatrace-saas` and `dynatrace-managed`). Every entry may set `enabled: false`.

```json
"integrations": {
  "dynatrace": { "type": "dynatrace", "baseUrl": "https://abc123.live.dynatrace.com", "token": { "keychain": "acc.dynatrace" } },
  "phoenix":   { "type": "arize", "flavor": "phoenix", "baseUrl": "http://localhost:6006", "apiKey": { "keychain": "acc.phoenix" } },
  "n8n":       { "type": "n8n", "baseUrl": "https://n8n.example.com", "apiKey": { "env": "N8N_API_KEY" },
                 "allowWrite": true, "webhooks": { "daily-report": "https://n8n.example.com/webhook/abc" } },
  "omniroute": { "type": "router", "flavor": "omniroute", "baseUrl": "http://localhost:20128", "managementToken": { "keychain": "acc.omniroute" } },
  "aion":      { "type": "http", "baseUrl": "https://aion.example.com",
                 "auth": { "header": "Authorization", "prefix": "Bearer ", "secret": { "env": "AION_TOKEN" } },
                 "endpoints": [ { "name": "list_agents", "method": "GET", "path": "/api/agents", "description": "List AION agents" } ] },
  "omniroute-mcp": { "type": "mcp", "enabled": false, "url": "http://localhost:20128/api/mcp/stream", "include": ["*health*", "*usage*"] }
}
```

`server.js` `loadConfig()` keeps the `integrations` object as is. `POST /api/config` leaves it untouched (it is edited in the file, not in the UI). A secret placed as a plain string is rejected at load time, with an error pointing at `docs/integrations.md`.

Storing a key in the Keychain: `security add-generic-password -a "$USER" -s acc.dynatrace -w` (documented in `docs/integrations.md`).

## Client registration

`npm run mcp:register -- <claude|kiro|antigravity|all> [--remove] [--dry-run]` runs `scripts/register-mcp.js`.

The entry it writes is `"ai-command-center": { "command": "<absolute node path>", "args": ["<absolute repo path>/mcp.js"] }`.

| Client | How |
|---|---|
| Claude Code | `claude mcp add --scope user ai-command-center -- <node> <mcp.js>` (and `claude mcp remove`). If the `claude` CLI is missing, it prints the command instead of editing `~/.claude.json` by hand. |
| Kiro | merge into `~/.kiro/settings/mcp.json` under `mcpServers` (file created if absent) |
| Antigravity | merge into `~/.gemini/config/mcp_config.json` under `mcpServers` (an empty file is treated as `{}`) |

Before any file write it copies the original to `<file>.bak-<YYYYMMDDHHmmss>`. It writes atomically (temp file plus rename), keeps every other entry, and refuses to touch a file that is not valid JSON. `--dry-run` prints the resulting JSON.

`lib/processes.js` gains Kiro (`/Kiro\.app\/|kiro-cli/`, paths `/Applications/Kiro.app`, `~/.kiro`) so it appears in the live monitor.

## Dashboard

- Navigation gains **Integrations** next to the existing pages, following the current markup and styles in `public/`.
- One card per integration: type icon, id, status dot (ok, error, disabled, not checked), latency, tool count, a "write on" badge, last error (masked), and a **Test** button.
- **Clients** row: Claude Code, Kiro and Antigravity, each marked registered or not (read from their config files, or from `claude mcp list` output when the CLI is present), plus the copyable register command.
- **Recent tool calls** table from the audit log: time, tool, ok or error, duration, argument names (never values). It is filterable by integration.
- API: `GET /api/integrations` returns integrations (health cached 60 s), clients and the last 100 audit entries. `POST /api/integrations/test` with `{ id }` runs one fresh health check. Both go through the existing host check.
- Demo mode: `lib/demo.js` provides a synthetic integrations payload covering every status.

## Error handling

- Every outbound request has a 15 s timeout (DQL polling 60 s total) and returns a short error: HTTP status plus the first 300 characters of the body, masked.
- Results larger than 50 KB are cut, with `"truncated": true` and a hint to narrow the query.
- Unknown tool, invalid arguments (checked against the tool's `inputSchema` for required fields and basic types) and disabled writes return JSON-RPC errors or `isError` results with a clear message. They never throw out of the stdio loop.
- `mcp.js` writes diagnostics to stderr only. stdout carries protocol messages only.

## Testing

`npm test` runs `node --test test/`. No dependencies.

- `protocol.test.js`: initialize and version negotiation, tools/list, tools/call, unknown method, malformed JSON line, notifications get no reply.
- `secrets.test.js`: env and keychain resolution (keychain via an injected exec stub), plain-string rejection, masking.
- `integrations.test.js`: prefixing, `allowWrite` filtering, a broken connector isolated from the rest, audit entries carry argument names only.
- One test per connector against a local `http.createServer` fake: request path, method, auth header, query mapping, truncation, error masking. For `mcp-proxy`, a fake Streamable HTTP server answers both JSON and SSE.
- `register.test.js`: runs against a temporary `HOME`; covers merge, backup, `--remove`, an empty Antigravity file and invalid JSON refusal. Claude registration is tested in dry-run.
- End to end: spawn `node mcp.js` with a temp config, send initialize plus tools/list over stdin, assert the `acc_*` tools are present.

## Out of scope

- Editing integrations from the web UI.
- Stdio upstream MCP servers in the proxy.
- Write tools for Dynatrace, Arize and the routers.
- Running chat completions through the routers.
- Ingesting Kiro or Antigravity conversation logs into usage and cost. Their local formats are undocumented, so this is a later, separate spec.

## README

- Add "MCP server" and "Integrations" sections: what the tools do, the register command, a pointer to `docs/integrations.md`.
- Extend the project structure and HTTP API tables.
- The privacy section changes from "Nothing is sent anywhere" to: nothing is sent anywhere **unless you configure an integration**, and then only to the URL you configured: when a client calls a tool, or when the Integrations page runs its health checks (at most once a minute per integration, or when you press Test).
