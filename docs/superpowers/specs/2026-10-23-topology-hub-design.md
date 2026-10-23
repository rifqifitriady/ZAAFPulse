# Provider topology with ZAAFPulse as the hub: design

Date: 2026-10-23 · Status: approved by the owner in chat · Amends `2026-10-23-provider-topology-design.md`

## Goal

Every tool, router, runtime and provider is registered in ZAAFPulse and connected through it: by API, by the Agent Gateway, or by reading its logs and processes. The topology should show that, with ZAAFPulse at the centre and every node connected to it.

## Decisions

| Question | Decision |
|---|---|
| Layout | **Hub, top to bottom.** Tools are on top. One large ZAAFPulse node sits in the middle. Routers and runtimes are below it, and providers and models at the bottom. |
| Lines | **One kind of line.** Every path goes through ZAAFPulse and is coloured by its activity. How a tool is connected is shown on its node as text: "via gateway", "via OmniRoute" or "monitored". |
| Agent Gateway | Merged into the ZAAFPulse node, because it is part of ZAAFPulse. The separate `gateway` node is removed. |

## Graph (`lib/topology.js`)

**Layers** (`layer` field):
- `0`: tools, unchanged.
- `1`: the hub, `{ id: 'zaafpulse', kind: 'hub', label: 'ZAAFPulse' }`. It is always present.
  - Its `note` summarises what is connected: `gateway · 1 router · 1 runtime`. The parts are joined with ` · `, and a part is left out when its count is 0. "gateway" is included only when the gateway has an enabled provider.
  - Its status is always `active`: the node is the dashboard itself.
- `2`: routers (`router:<id>`) and running runtimes (`runtime:<id>`).
- `3`: providers (`provider:<p>`) and models (`model:<runtime>:<name>`).

**Tool nodes** get `via`: `'gateway'`, `'<router label>'` (for example `'OmniRoute'`) or `null`. The page shows it as "via gateway", "via OmniRoute" or "monitored".

**Edges:**
- every tool → `zaafpulse`;
- `zaafpulse` → every router, and → every running runtime;
- `zaafpulse` → every provider used directly: a direct tool's log providers, the defaults with no turns (Claude Code → anthropic, Codex → openai), the gateway's enabled providers, and API-error providers;
- router → its providers and calls' providers, as today;
- runtime → its models, as today.

The gateway → runtime rule becomes `zaafpulse → runtime`: a gateway provider on a running runtime's port adds no provider node.

**Request paths** always go through the hub:

| Source | Path |
|---|---|
| Direct log turn, API error | `[tool, 'zaafpulse', provider]` |
| Gateway | `[client tool?, 'zaafpulse', provider \| runtime]` |
| Router call | `[client tool?, 'zaafpulse', 'router:<id>', provider]` |

The leave-out and attribution rules are unchanged: routed tools' log turns are left out, gateway requests are credited by key, and a router call names its client tool when exactly one tool routes there.

**Status:** the rules are unchanged, with these additions:
- a tool → hub edge takes the status of the newest request whose path contains the tool;
- the hub node is always `active`;
- the runtime override (running and answering means active, not answering means error) and the running-tool override stay.

**Folding:** the 12-per-layer cap applies to layers 0, 2 and 3. Layer 1 always holds just the hub.

**Unchanged:** privacy and scrubbing, the 3 h window, the 20-request cap, and the route, its sources, caps and cache.

## Page (`public/topologyview.js`)

- **Four rows.** The hub row holds one wider node (about 1.6× a normal node), centred, with the app's own ZAAFPulse mark or icon, the label "ZAAFPulse" and the summary note as its sub-label.
- **Tool sub-label:** "via gateway", "via OmniRoute" or "monitored", replacing "tool". Other kinds keep their kind text.
- **Request rows** show the path labels joined by " → ", so "Claude Code → ZAAFPulse → Anthropic".
- The highlight, zoom, pan, fit, polling and narrow layout are unchanged. The layout must still fit at 390 px.

## Demo

`topologyDemo()` follows the new shape:
- tools: Claude Code (monitored) and Codex (via OmniRoute);
- the ZAAFPulse hub;
- OmniRoute in error, and Ollama with llama3.2:3b;
- Anthropic, OpenAI and Google;
- 8 requests.

## Docs

Update `docs/topology.md`: the layers, the hub, the "via …" labels and the paths.

## Testing

- **Unit tests:** update the topology unit tests for the new layers, edges and paths. Add tests for:
  - the hub always present;
  - the hub note text;
  - tool `via`;
  - every tool connected to the hub;
  - the folding cap skipping layer 1;
  - no `gateway` node.
- **UI tests:** a hub node gets the wide size and `kind` class `topo-hub`, and the tool sub-label shows `via`. Check `topoLayout` with 4 layers.
- **Screenshots:** take them again in demo mode at 1440 px and 390 px.
