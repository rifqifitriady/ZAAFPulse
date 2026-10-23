# Provider topology

The **Provider topology** card on the Overview shows how AI traffic on this machine flows. ZAAFPulse sits at the centre: every tool, router, runtime and provider is registered in it and connected through it, by API, by the Agent Gateway, or by ZAAFPulse reading its logs and processes. The graph runs from the AI tools, through ZAAFPulse, to the routers and local runtimes, and on to the providers and local models. Beside the graph, **Recent requests** lists the newest requests from every source. The card sits above AI Office and refreshes every 10 seconds while the Overview is on screen.

## The layers

| Row | Kind | What it is |
|---|---|---|
| 1 (top) | tools | Claude Code, Codex and the other AI apps that are installed or running |
| 2 | the hub | ZAAFPulse itself, always present and always active, its Agent Gateway included |
| 3 | routers | each configured router (OmniRoute, 9router), under its connector name |
| | local runtimes | Ollama and LM Studio while they run |
| 4 (bottom) | providers | Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Qwen, Meta, OpenRouter, Other |
| | models | the models loaded in a running local runtime |

A row of tools, routers and runtimes, or providers and models holds at most 12 nodes: the 11 busiest, plus "+N more", whose tooltip names the rest. The hub's row holds the hub alone.

**The hub** is the wide node in the middle, with the app's own mark. Its second line sums up what is connected, such as `gateway · 1 router · 1 runtime`:
- "gateway" when the Agent Gateway has at least one enabled provider;
- the number of routers, and of running local runtimes;
- a part with a count of 0 is left out. When nothing is left, the line says "hub".

**How a tool is connected** is written on its node, under its name:
- **via gateway**: the tool is pointed at ZAAFPulse's Agent Gateway;
- **via OmniRoute** (or another router's name): the tool is pointed at that router;
- **monitored**: the tool goes straight to its provider, and ZAAFPulse sees it by reading its logs and processes.

**Edges.** There is one kind of line, coloured by its activity:
- every tool connects to the hub;
- the hub connects to every router and every running local runtime;
- the hub connects to every provider used directly: a monitored tool's providers (Claude Code → Anthropic and Codex → OpenAI when it has no turns yet), the gateway's enabled providers, and the providers of API errors. A gateway provider on a running runtime's port is that runtime, so it adds no provider node;
- a router connects to its providers, and a runtime to its models.

Edges meet the hub at points spread along its top and bottom. A line from the hub to a provider passes through the routers' row in a gap of its own, and each provider sits under what feeds it.

## Colours

| Colour | Status | Meaning |
|---|---|---|
| green | Active | the newest request through it succeeded and is at most 5 minutes old; a running tool is active too, unless it has a recent error; so is a local runtime that runs and answers, with the models it has loaded now and their edges |
| orange | Recent | the newest request succeeded and is at most 60 minutes old |
| red | Error | the newest request failed and is at most 60 minutes old; also a router whose health check fails, a router connection that is inactive or failing its test, and a local runtime that runs but does not answer ("not answering") |
| grey | Idle | nothing in the last hour |

A local runtime is often used from its own app (LM Studio's chat, `ollama run`), which no log or gateway sees, so its colour comes from its state, not only from requests. Its model nodes are the models it has loaded now, read every 30 seconds; before the first read, or when the last one is more than 90 seconds old, the models it last had loaded are drawn grey.

What counts as a failed request:
- **Logs:** a real API error that Claude Code or Codex logged (overloaded, a 5xx, an auth failure). It is drawn on the tool and the provider of its model, or the tool's own provider (Anthropic, OpenAI) when no model is named. A turn whose tool calls failed, such as a Bash command or a missing file, still counts as ok, because the provider answered.
- **Gateway:** a status of 400 or more, or an error.
- **Router:** a status of 400 or more. A call with no status, still in flight or from an older OmniRoute, is ok.

An edge gets the status of the newest request that passed along it, hop by hop: a router call colours hub → router and router → provider, not the hub's own line to that provider. A tool → hub edge takes the newest request that came from the tool. The hub is always active. Active edges move.

## Using the card

- **+**, **−** and the frame button zoom in, zoom out and fit the whole graph. Drag the graph to pan.
- Click a node to light up its edges and neighbours. The line at the bottom of the graph shows its label, status and note, such as `timed out`. Click it again, click the background, or press Escape while the graph has focus, to clear.
- Click a request to light up its path through the graph.
- The view and the highlight survive the 10-second refresh.
- Under 900 px wide, the request list moves below the graph.

## Where the data comes from

`GET /api/topology` (behind the dashboard sign-in) builds the graph on the server from sources that already exist:

| Source | Gives |
|---|---|
| running apps (`/api/live`) | which tools are installed and running |
| Claude Code and Codex logs | the turns of the last 3 hours: model, tokens, time, tool errors |
| Agent Gateway | its provider list (from its config), its recent requests and its key names |
| OmniRoute | health, provider connections and call logs, for the first enabled OmniRoute connector only; a second OmniRoute or a 9router is drawn without them |
| local runtimes | which runtimes run, on which port, and their models |

- Each asynchronous source (the running apps, the local runtimes and OmniRoute) gets 2 seconds. A source that fails or is slow is left empty, and a failing router is drawn red. The log tail and the gateway lists are read synchronously, so the cap cannot cut them short; the log read is reused for 10 seconds.
- The answer is cached for 5 seconds.
- Recent requests holds the 20 newest, merged from the logs, the gateway and the router. A turn that went through the gateway or a router is listed once, by that hop.

Every request's path goes through the hub, and its row shows the path as names joined by arrows:

| Source | Path | For example |
|---|---|---|
| a log turn, an API error | tool → ZAAFPulse → provider | Claude Code → ZAAFPulse → Anthropic |
| the gateway | tool → ZAAFPulse → provider or runtime | ZAAFPulse → Google (a dashboard call) |
| a router call | tool → ZAAFPulse → router → provider | Codex → ZAAFPulse → OmniRoute → OpenAI |

The tool is left out when nobody is credited, and a dashboard call starts at ZAAFPulse.

Who sent a request (the first name in its path, and its client):
- **Logs:** Claude Code or Codex, whichever wrote the log.
- **Gateway:** the gateway makes one key per connected tool, named `tool:<id>`. A request made with that key is credited to that tool: `tool:claude-code` to Claude Code, `tool:codex` to Codex, and any other tool key to its app when that app is drawn. The dashboard's own calls (agents, collab, the evals judge, RAG) are credited to ZAAFPulse. Any other request shows its key name, or else its agent.
- **Router:** an OmniRoute call log does not say who sent the call. It is credited to the tool routed to that router, when exactly one tool is.
- Demo mode (`DEMO=1`) answers with a synthetic graph and calls nothing.

## How tool routing is detected

A tool that is pointed at a router or at the gateway is labelled "via" that router or "via gateway", and its requests run through the hub to that router or the gateway's provider. Otherwise it is "monitored", and its requests run through the hub straight to its provider. A tool pointed at the gateway while the gateway has no enabled provider counts as monitored.

- **Claude Code:** `env.ANTHROPIC_BASE_URL` in `settings.json` in its config folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
- **Codex:** the top-level `model_provider` in `config.toml` (`CODEX_HOME`, else `~/.codex`), then `base_url` in that `[model_providers.<name>]` table.

Only the origin (`protocol://host:port`) of that URL is compared:
- an origin equal to the dashboard's own address means the gateway;
- one equal to a router connector's base URL means that router.

`localhost`, `127.0.0.1` and `[::1]` count as the same host. Other tools have no base-URL setting that is read. They show as direct, or only by whether they run.

## Privacy

The topology holds metadata only: names, statuses, models, token counts, times and short failure reasons.
- No prompt or response text.
- No URL, file path, API key or account email.
- A tool's base-URL origin is used only to match it to the gateway or a router, and is never sent to the page.
- Failure reasons have URLs, hosts, paths, emails and tokens removed.
- Model names and labels are clipped to 80 characters.

The page draws everything as text (SVG built node by node, never HTML from data).
