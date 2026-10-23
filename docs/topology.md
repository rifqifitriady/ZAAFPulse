# Provider topology

The **Provider topology** card on the Overview shows how AI traffic on this machine flows. It runs from the AI tools, through the routers, the gateway and the local runtimes, to the providers and local models. Beside the graph, **Recent requests** lists the newest requests from every source. The card sits above AI Office and refreshes every 10 seconds while the Overview is on screen.

## The layers

| Row | Kind | What it is |
|---|---|---|
| Top | tools | Claude Code, Codex and the other AI apps that are installed or running |
| Middle | routers | each configured router (OmniRoute, 9router), under its connector name |
| | gateway | ZAAFPulse's own Agent Gateway, shown when it has at least one enabled provider |
| | local runtimes | Ollama and LM Studio while they run |
| Bottom | providers | Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Qwen, Meta, OpenRouter, Other |
| | models | the models loaded in a running local runtime |

A row holds at most 12 nodes: the 11 busiest, plus "+N more", whose tooltip names the rest.

## Colours

| Colour | Status | Meaning |
|---|---|---|
| green | Active | the newest request through it succeeded and is at most 5 minutes old; a running tool is active too, unless it has a recent error |
| orange | Recent | the newest request succeeded and is at most 60 minutes old |
| red | Error | the newest request failed and is at most 60 minutes old; also a router whose health check fails, or a router connection that is inactive or failing its test |

What counts as a failed request:
- **Logs:** a real API error that Claude Code or Codex logged (overloaded, a 5xx, an auth failure). It is drawn on the tool and the provider of its model, or the tool's own provider (Anthropic, OpenAI) when no model is named. A turn whose tool calls failed, such as a Bash command or a missing file, still counts as ok, because the provider answered.
- **Gateway:** a status of 400 or more, or an error.
- **Router:** a status of 400 or more. A call with no status, still in flight or from an older OmniRoute, is ok.
| grey | Idle | nothing in the last hour |

An edge gets the status of the newest request that passed along it. Active edges move.

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

Who sent a request (the first name in its path, and its client):
- **Logs:** Claude Code or Codex, whichever wrote the log.
- **Gateway:** the gateway makes one key per connected tool, named `tool:<id>`. A request made with that key is credited to that tool: `tool:claude-code` to Claude Code, `tool:codex` to Codex, and any other tool key to its app when that app is drawn. The dashboard's own calls (agents, collab, the evals judge, RAG) are credited to ZAAFPulse. Any other request shows its key name, or else its agent.
- **Router:** an OmniRoute call log does not say who sent the call. It is credited to the tool routed to that router, when exactly one tool is.
- Demo mode (`DEMO=1`) answers with a synthetic graph and calls nothing.

## How tool routing is detected

A tool that is pointed at a router or at the gateway gets an edge to it. Otherwise it goes straight to its provider.

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
