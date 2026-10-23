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
| Agent Gateway | its providers, its recent requests and its key names |
| OmniRoute | health, provider connections and call logs |
| local runtimes | which runtimes run, on which port, and their models |

- Each source gets 2 seconds; a source that fails or is slow is left empty, and a failing router is drawn red.
- The answer is cached for 5 seconds.
- Recent requests holds the 20 newest, merged from the logs, the gateway and the router. A turn that went through the gateway or a router is listed once, by that hop.
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
