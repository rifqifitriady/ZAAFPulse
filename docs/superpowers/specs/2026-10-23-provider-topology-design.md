# Provider topology on the Overview: design

Date: 2026-10-23 · Status: approved by the owner in chat

## Goal

The Overview shows how AI traffic on this machine flows, in the style of the "Provider Topology" card on OmniRoute's home page. Traffic runs from the AI tools, through the routers and gateways, to the providers and local models. Beside the graph, a list shows the most recent requests from every source.

## Decisions (2026-10-23)

| Question | Decision |
|---|---|
| Scope | **The whole AI path**, in three layers: AI tools → routers and gateways → providers and local models. |
| Recent requests | **Merged from every source:** Claude Code and Codex turns from the logs, Agent Gateway requests, and OmniRoute call logs. Clicking a row highlights its path. |
| Approach | The graph is built on the server (`GET /api/topology`) from modules that already exist, and drawn as SVG with no library. |

## Sources (all exist today)

| Source | Function | Gives |
|---|---|---|
| Running apps | `processes.snapshot()` (`/api/live`) | which AI apps run now (`apps[].id`) and which are installed (`installed`) |
| Log turns | `reqlogs.logs()` (lib/reqlogs.js) | `requests[]` from the last 3 h of Claude Code and Codex: `{ ts, source, model, input, output, durationMs, toolErrors }`; `errors[]`: `{ ts, source, kind }` |
| Agent Gateway | `gateway.admin('', 'GET').providers`, `gateway.usage.recent(n)`, `gateway.keys.list()` | providers `{ id, preset, baseUrl, enabled }`; requests `{ ts, keyId, agent, provider, model, status, ms, input, output, error }` |
| OmniRoute | `router` (lib/omniroute.js): `configured()`, `id()`, `providerStats()`, `callLogs()`, plus `health()` (`/api/health`) and `providers()` (`/api/providers`, the `PROVIDER_FIELDS` of lib/connectors/router.js, emails masked), added in this work | health, provider connections `{ provider, name, isActive, testStatus }`, calls `{ ts, status, model, provider, durationMs, tokens }` |
| Local runtimes | `runtimeControl.list()` | `{ id, name, running, healthy, models: { loaded, remembered } }` for Ollama and LM Studio |
| Tool routing | **new** `lib/toolroutes.js` | the base-URL origin Claude Code and Codex are pointed at (below) |

Tool routing (`lib/toolroutes.js`, `readToolRoutes({ home, env })`):
- **Claude Code:** `env.ANTHROPIC_BASE_URL` in `<claude config dir>/settings.json`, using `configDir()` from lib/claude.js.
- **Codex:** in `<CODEX_HOME or ~/.codex>/config.toml`, the top-level `model_provider`, then that `[model_providers.<name>]` table's `base_url`, read with line regexes and no TOML library.
- It returns `{ claude: origin | null, codex: origin | null }`. Only `protocol//host:port` is kept: no path, no query, no credentials. A file that cannot be read, or does not parse, gives `null`.
- A tool's route is:
  - `'gateway'` when its origin equals the dashboard's `BASE_URL` origin (same host and port, with `localhost` and `127.0.0.1` treated as equal);
  - `<router id>` when it equals a router connector's `baseUrl` origin;
  - otherwise `null` (direct to the provider).

## `lib/topology.js` (pure): `buildTopology(input, now)`

`input` = `{ live, logs, gateway: { providers, usage, keys }, routers: [{ id, name, flavor, health, providers, calls }], runtimes, routes }`.

It returns `{ ts, nodes, edges, requests }`.

### Node

`{ id, layer: 0 | 1 | 2, kind, label, status, note }`:
- **Layer 0, `tool`:**
  - every tool in `live.installed` or `live.apps`, plus `claude` and `codex` when the logs hold requests from them;
  - the ids and labels are the `APPS` ids used by the dashboard (`claude` → "Claude Code", `codex` → "Codex", and so on).
- **Layer 1:**
  - `router:<id>`: each configured router, labelled with the connector name or "OmniRoute";
  - `gateway`: "Agent Gateway", only when it has at least one enabled provider;
  - `runtime:<id>`: each running local runtime, "Ollama" or "LM Studio".
- **Layer 2:**
  - `provider:<p>`: a provider, where `p` comes from `providerOf`;
  - `model:<runtime>:<name>`: a model loaded in a local runtime.

`providerOf(model | providerName)` maps a model or provider name:
- `anthropic`: claude, anthropic;
- `openai`: gpt, `o\d`, codex, openai, chatgpt;
- `google`: gemini, google, vertex;
- `xai`: grok, xai;
- `mistral`: mistral, codestral;
- `deepseek`: deepseek;
- `qwen`: qwen;
- `meta`: llama, meta;
- `openrouter`: openrouter;
- anything else: `other`.

Labels: Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Qwen, Meta, OpenRouter, Other.

### Edges

`{ id: '<from>><to>', from, to, status }`:
- **tool → layer 1** when `routes[tool]` names the gateway or a router.
- **tool → provider** when the tool is direct: one edge per provider seen in that tool's log requests. With no requests, Claude Code goes to anthropic and Codex to openai.
- **router → provider:** one edge per provider in the router's `providers` connections and in its `calls`.
- **gateway → provider:** one edge per enabled provider. When a provider's `baseUrl` is a local runtime's port (11434 or 1234), it goes to `runtime:<id>` instead.
- **runtime → model:** one edge per loaded model.

### Requests

The 20 newest, merged and sorted by `ts`, newest first. Each is:

`{ ts, path: [nodeIds], client, model, tokens, ms, ok, source: 'logs' | 'gateway' | 'router' }`

They are built from:
- **Log turns** of a tool whose route is `null` (direct):
  - path `[tool, provider:<providerOf(model)>]`;
  - `ok` is false when the turn has `toolErrors > 0`;
  - turns of tools routed through the gateway or a router are left out here, because that hop reports them.
- **Gateway usage:**
  - path `[client?, 'gateway', provider:<…> | runtime:<id>]`;
  - the gateway makes one key per connected tool, named `tool:<lib/gateway/tools.js id>`. A request made with such a key starts at that tool and has it as `client`, when the tool is a node: `tool:claude-code` is `claude`, `tool:gemini-cli` is `antigravity`, and any other id is its own APPS id (`tool:codex` is `codex`);
  - the dashboard's own calls (`keyId: 'dashboard'`: agents, collab, the evals judge, RAG embeddings) have the client "ZAAFPulse" and no tool;
  - any other request has the key name, else the agent, as `client`, and no tool. Which tools are routed to the gateway does not change this;
  - `ok` is `status < 400 && !error`.
- **Router calls:**
  - path `[client?, 'router:<id>', provider:<providerOf(provider || model)>]`;
  - `client` is the tool routed there when exactly one is, since an OmniRoute call log names no client;
  - `ok` is `status < 400`.

Model names are text, clipped to 80 characters. No prompt, path, URL, key or account appears.

### Status of a node or edge

Status is one of `active`, `recent`, `error` or `idle`. It comes from the newest request whose path contains the node, or both ends of the edge:
- `error`: that request is not ok and is at most 60 minutes old;
- `active`: it is ok and at most 5 minutes old;
- `recent`: it is ok and at most 60 minutes old;
- `idle`: anything else.

Overrides:
- a running tool (in `live.apps`) is at least `active`;
- a router whose `health` failed is `error`, with `note` set to the short reason (`timed out`, `HTTP 401`, …);
- a router provider connection with `isActive === false` or a failing `testStatus` makes that provider node `error`, with a note.

A layer with more than 12 nodes keeps the 11 busiest and adds one `more` node: "+N more", `idle`.

## `GET /api/topology` (server.js, behind the dashboard sign-in)

- It answers `buildTopology(...)`. The answer is cached for 5 s.
- Each source is awaited with a 2 s cap, and a failure leaves that source empty.
- A router that failed shows as `error`, and the rest of the graph is still drawn.
- `reqlogs.logs()` reads files from disk, so its result is reused for 10 s.
- **Demo mode:** `demo.topologyDemo()` gives a synthetic graph:
  - Claude Code and Codex;
  - OmniRoute in `error` (as in the screenshot), Agent Gateway, Ollama;
  - Anthropic, OpenAI, Google, and the model llama3.2:3b;
  - 8 requests.
- The answer holds no URL and no path.

## UI: `public/topologyview.js`, the Overview card

- A section "Provider topology" above "AI Office", with a meta line "N active · M error" and a legend (Active · Recent · Error).
- **The graph:**
  - inline SVG built with `document.createElementNS` and `textContent`, never `innerHTML` with data (S1);
  - layout by `topoLayout(nodes, edges, width)` (pure): layers top to bottom, nodes spread evenly across each layer, curved edges (cubic Bézier);
  - colours: active green, recent orange, error red, idle grey.
  - Node and edge colours come from CSS classes `topo-<status>`, with tokens for dark and light themes.
- **Controls:** zoom with +, −, and fit (the viewBox is scaled). Drag pans the view.
- **Clicking a node** highlights its edges and shows its `note`. Clicking a request row highlights that request's path. Clicking the background clears the highlight.
- **Recent requests** (on the right, or below the graph on narrow screens). Each row shows:
  - the time ago;
  - the path labels joined by " → ";
  - the model, tokens and ms;
  - a dot for ok or error.

  With no data, it shows "No requests in the last 3 hours."
- **Refresh:** every 10 s while the Overview is on screen, through its own timer. The SVG is updated in place, so the zoom and highlight are kept. The timer stops when the page changes.

## Testing (`node:test`; nothing real is called)

- **toolroutes:**
  - fake homes with `settings.json` and `config.toml`;
  - origins only;
  - a missing file, bad JSON, or TOML without `base_url` gives `null`;
  - a URL holding credentials gives its origin only.
- **topology:**
  - `providerOf`;
  - edges for direct, gateway-routed and router-routed tools;
  - gateway → runtime by port;
  - requests merged, sorted, capped at 20, and left out for routed tools;
  - client attribution;
  - the status rules and overrides;
  - the "+N more" cap;
  - no URL in the output.
- **omniroute:** `health()` and `providers()` use the fake fetch, mask emails, and fail on their own.
- **api:** the route answers in demo mode; a router whose fetch fails gives an `error` node.
- **ui:**
  - `topoLayout` positions;
  - the S1 audit of `topologyview.js`;
  - nodes and rows built against a stand-in document that refuses `innerHTML`.

## Non-goals

- Live request streaming.
- Editing routes from the graph.
- Tools other than Claude Code and Codex for base-URL detection: they show as direct or by their running state only.
- 9router's call logs, since it has no management API.
