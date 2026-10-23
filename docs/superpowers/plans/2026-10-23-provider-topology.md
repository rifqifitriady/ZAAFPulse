# Provider topology on the Overview: implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** add an Overview card that draws AI tools → routers and gateways → providers and local models, with green, orange and red status and a merged recent-requests list, in the style of OmniRoute's Provider Topology.

**Architecture:**
- **Server:** a pure `lib/topology.js` builds `{ nodes, edges, requests }` from existing sources. A small `lib/toolroutes.js` reads where Claude Code and Codex are pointed. `GET /api/topology` gathers the sources with caps and a cache.
- **Page:** `public/topologyview.js` draws the graph as SVG with `createElementNS` and `textContent`.

**Spec:** `docs/superpowers/specs/2026-10-23-provider-topology-design.md`. It holds every rule, threshold, label and shape. Use them verbatim.

**Tech stack:** Node.js >= 18, CommonJS, zero dependencies, `node:test`, plain browser scripts (no bundler).

## Global constraints

- No new dependencies. SVG is built by hand.
- **Output privacy:**
  - No URL, path, API key, account email or prompt text appears in `/api/topology`.
  - Tool routes keep only an origin internally, and never send it out.
  - Model names are text, clipped to 80 characters.
- **S1:** all text on the page goes through `textContent` or `esc()`. No `innerHTML` is built from data.
- **Status thresholds:**
  - active: ok and at most 5 min old;
  - recent: ok and at most 60 min old;
  - error: not ok and at most 60 min old;
  - idle: otherwise.
  - There are at most 12 nodes per layer, as the 11 busiest plus "+N more".
  - The list holds at most 20 requests.
- **Server:**
  - the answer is cached for 5 s;
  - each source is capped at 2 s, and a failure leaves that source empty;
  - `reqlogs.logs()` is reused for 10 s;
  - demo mode answers `demo.topologyDemo()` and calls nothing real.
- **Page:** it refreshes every 10 s while the Overview is shown and stops when the page changes. Updates happen in place, so zoom and highlight survive.
- **Tests:**
  - never call the real OmniRoute (127.0.0.1:20128), Ollama, or the owner's `~/.claude` or `~/.codex`. Use fake homes and fake fetches.
  - A spawned `server.js` uses `NO_JUDGE_PORTS` from `test/helpers.js`.
- Never touch `.worktrees/live`.
- **Commits:** no AI attribution line, and stage files by name.

---

### Task 1: `lib/toolroutes.js` and `lib/topology.js` (pure)

**Files:**
- Create: `lib/toolroutes.js`, `lib/topology.js`.
- Test: `test/toolroutes.test.js`, `test/topology.test.js`.

**Interfaces:**
- **`readToolRoutes({ home, env, claudeDir, codexHome })`** returns `{ claude: origin | null, codex: origin | null }`.
  - It reuses `configDir()` from `lib/claude.js` and the `CODEX_HOME` logic from `lib/codex.js` (`rootInfo`) when the dirs are not given.
- **`routeOf(origin, { baseUrl, routers: [{ id, baseUrl }] })`** returns `'gateway' | '<router id>' | null`.
  - It compares origins, treating `localhost` as equal to `127.0.0.1`. Both functions are exported from `lib/toolroutes.js`.
- **`providerOf(name)`** maps a name to `'anthropic' | 'openai' | … | 'other'`. It is exported from `lib/topology.js` together with `PROVIDER_LABELS`.
- **`buildTopology(input, now)`** returns `{ ts, nodes, edges, requests }`. The input and output shapes are exactly as in the spec section "`lib/topology.js`".
  - The input's `routes` is `{ claude: 'gateway' | '<router id>' | null, codex: … }`, already resolved by `routeOf`.
  - Tool labels: take an `appNames` map in the input (`{ id: name }`, from `lib/processes.js` `APPS`). Fall back to the id.

Steps:
- [ ] Write the failing tests. Cover every case in the spec's "Testing" bullets for toolroutes and topology, and include these:
  - **Edge choice:** a direct Claude Code with only claude-* turns gives `claude → provider:anthropic`. A Codex pointed at OmniRoute gives `codex → router:omniroute`, and its log turns are left out of the requests.
  - **Gateway to runtime:** a gateway provider with base URL port 11434 gives `gateway → runtime:ollama` when Ollama is running.
  - **Status:**
    - an error 30 min old → `error`;
    - an ok request 2 min old → `active`;
    - an ok request 40 min old → `recent`;
    - an ok request 2 h old → `idle`;
    - a running tool with no requests → `active`;
    - a router whose health has `{ error: 'timed out' }` → `error`, with note `timed out`;
    - an OmniRoute connection with `isActive: false` → that provider node is `error`.
  - **Requests:** sorted newest first, capped at 20. The client is attributed when exactly one tool routes to the hop. No URL appears anywhere in `JSON.stringify(result)`: assert that `/https?:\/\//` does not match.
  - **Cap:** 15 tool nodes → 11 + "+4 more".
- [ ] Run the tests and see them fail.
- [ ] Implement both modules.
- [ ] Run the tests until they pass, then run `npm test`.
- [ ] Commit: "Build the provider topology from the tools, routers, gateway and runtimes".

### Task 2: `GET /api/topology`, the OmniRoute additions and demo

**Files:**
- Modify: `lib/omniroute.js` (add `health()` and `providers()`), `server.js` (the route), `lib/demo.js` (`topologyDemo`).
- Test: `test/omniroute.test.js` (or its existing test file; find it with `grep -l createOmniRoute test`) and `test/topology-api.test.js`.

**Interfaces:**
- Consumes: Task 1's `buildTopology`, `readToolRoutes` and `routeOf`.
- **`router.health()`** resolves `GET /api/health` → `{ ok: true } | { error }`.
- **`router.providers()`** resolves `GET /api/providers` → `{ connections: [ … ] } | { error }`.
  - It keeps the fields of `PROVIDER_FIELDS` (from `lib/connectors/router.js`; export it from there if needed), with emails masked by `maskEmail`.
  - Both use the existing `safe`, `get` and cache.
- The route `GET /api/topology` sits behind the dashboard sign-in, like `/api/router`, and answers `buildTopology(...)`. Its sources:
  - `processes.snapshot()`, or the cached `/api/live` data if the server keeps one;
  - `reqlogs.logs()`, cached for 10 s;
  - `gateway.admin('', 'GET').providers`, `gateway.usage.recent(200)` and `gateway.keys.list()` names;
  - `router.configured()`, then `health()`, `providers()` and `callLogs()`;
  - `runtimeControl.list()`;
  - `readToolRoutes()`, with `routeOf` against `BASE_URL` and the router's baseUrl.

  Each source is capped at 2 s, and the whole answer is cached for 5 s.
- `demo.topologyDemo()` returns the synthetic graph described in the spec ("Demo mode"). Build it through `buildTopology` from synthetic inputs, so the shape cannot drift.

Steps:
- [ ] Write the failing tests:
  - `health()` and `providers()` with a fake fetch: emails are masked, and a fetch that fails gives `{ error }`.
  - A demo-mode spawned server (`DEMO=1`, `NO_JUDGE_PORTS`) answers `/api/topology` with three layers, OmniRoute in `error`, and 8 requests.
  - No `http://` appears in the body.
  - Without sign-in the route answers 401, the same as the other routes.
- [ ] Implement, run the tests and `npm test`.
- [ ] Commit: "Serve the provider topology, with OmniRoute health and providers".

### Task 3: the Overview card, styles and docs

**Files:**
- Create: `public/topologyview.js`.
- Modify: `public/index.html` (the script tag, before `overviewview.js`), `public/overviewview.js` (the section above "AI Office", and the mount), `public/styles.css` (`.topo-*` classes with theme tokens), `README.md` (one line in the feature list or docs list), `docs/topology.md` (new and short).
- Test: `test/topology-ui.test.js`.

**Interfaces:**
- Consumes: the `/api/topology` shape.
- **`topoLayout(nodes, edges, width, height)`** is pure. It returns `{ nodes: [{ id, x, y, w, h }], edges: [{ id, d }] }`, where `d` is the cubic Bézier path of the edge.
- **`topoMount()`** is called from the Overview mount. It fetches `/api/topology`, draws, polls every 10 s, and is cleaned up with `onUnmount`.
  - Look at how `mountOverview` and `rtMount` do this.
- `topoPaint(doc, root, data, ui)` builds or updates the SVG and the requests list, in place.

Steps:
- [ ] Write the failing tests.
  - `topoLayout`:
    - three layers, top to bottom;
    - nodes evenly spread across a layer;
    - every edge `d` starts with `M`.
  - Building against a stand-in document whose `innerHTML` throws:
    - node labels and request rows are `textContent`;
    - a label holding `<img onerror>` stays literal;
    - status classes are `topo-active`, `topo-recent`, `topo-error` and `topo-idle`.
  - An S1 audit of the file: no `innerHTML =` except a constant icon string, following the audit in `test/runtimes-ui.test.js`.
- [ ] Implement:
  - the view;
  - the section `<div class="section-head"><h2>Provider topology</h2><span class="meta">…</span></div>`, with the card holding the SVG area and the "Recent requests" list;
  - legend, zoom buttons (+, −, fit), drag to pan, click to highlight;
  - styles for dark and light;
  - the narrow layout: the list goes below the graph under 900 px.
- [ ] Write `docs/topology.md`: what each layer is, the colours, where the data comes from, privacy (metadata only), and how tool routing is detected. Add the README link.
- [ ] Check it in a browser:
  - run the server in demo mode on a free port outside 5100–5999, with a throwaway `ZAAFPULSE_DATA` and `HOME` under `/private/tmp/claude-501`;
  - render `#overview` in headless Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --screenshot`), and look at the screenshot.
- [ ] Run `npm test`.
- [ ] Commit: "Draw the provider topology on the Overview".
