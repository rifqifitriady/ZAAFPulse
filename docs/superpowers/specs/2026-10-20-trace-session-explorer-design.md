# Sub-project 1: Trace & Session Explorer

Date: 2026-10-20 · Status: approved in brainstorming, awaiting spec review · Shared requirements: `2026-10-20-ai-observability-overview.md` (S1–S11, P1–P10).

## Goal

Open any agent session on this machine and see what happened in it:
- every turn, model call, tool call and subagent, with time, tokens, cost and signals;
- the text of any step, read from the original log on demand.

The view is a split screen. A trace explorer sits on the left and an animated session map of the selected turn sits on the right; the two halves stay in sync.

## Sources and depth

| Source | Files | Depth |
|---|---|---|
| Claude Code | `~/.claude/projects/<proj>/<sessionId>.jsonl`, subagents in `<sessionId>/subagents/agent-<agentId>.jsonl` (lines carry `sessionId`, `agentId`, `isSidechain`), large tool output in `<sessionId>/tool-results/` | Full: turns, model calls, tools, nested and parallel subagents, tokens, cost, text |
| Codex | `~/.codex/sessions/**/*.jsonl` | Full: turns, model calls, tools, forks (existing fork detection), tokens, cost, text |
| Agent Gateway | `.data/gateway-usage.jsonl` (requests), `.data/runs.json` (collaboration runs with trace spans) | Requests: metadata only (no text is stored). Collaboration runs: full span tree and step text |
| Kiro | `~/.kiro/sessions/<id>/<sess>/messages.jsonl` + session `.json` (title, workspace, mode) | Turns and tool calls (name, status). No tokens or model, so no cost |
| Antigravity | `~/.gemini/antigravity*/conversation_summaries.db` (SQLite) | Conversation level: title, step count, agent name, parent and nesting (sub-conversations), status, times. Step payloads are undocumented protobuf and are not parsed |
| Gemini CLI | chat JSON files under `~/.gemini/tmp/**` when present | Turns and tool calls from the documented chat format; fixtures are synthetic (not in use on the reference machine) |

Each source honours its config-dir environment variable: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and a Gemini or Antigravity home if one exists.

## Span model (one shape for every source)

The span model follows the OTel GenAI semantic conventions, so a later export bridge can map it 1:1:

```js
{
  id,              // stable: hash(source, sessionId, kind, native id or line offset)
  parent,          // span id or null
  kind,            // 'session' | 'turn' | 'chat' | 'tool' | 'agent' (subagent) | 'answer'
  op,              // gen_ai.operation.name: invoke_agent | chat | execute_tool
  name,            // e.g. 'chat claude-opus-5-5', 'execute_tool Bash', 'invoke_agent Explore'
  start, end,      // ms epoch; end may be null for a running span
  status,          // 'ok' | 'error' | 'running' | 'unknown'
  model, provider, // chat spans
  usage,           // { input, output, cacheRead, cacheWrite5m, cacheWrite1h } when the source has it
  cost,            // USD via lib/pricing.js (existing pricer); null when there is no usage
  tool,            // { name, target } for tool spans, e.g. file basename or command name
  signals,         // ids of matched signals from lib/signals.js (existing detectors)
  text: { ref }    // opaque content reference: { file id, byte start, byte end, field }; never the text itself
}
```

## Index additions (`lib/indexer.js` result per file)

- Per session: source, title (the first prompt, truncated to 80 characters), project, branch, start and end, turn count, tool count, error count, cost and flags (errors, loop, injection).
- `turns[]`: byte offsets `[start, end)` of each turn within the file, plus each turn's start time.
- For Claude Code, the subagent-to-parent link: `sessionId`, `agentId`, and the spawning `tool_use` id where the parent transcript records it. The exact field is verified during implementation (P3).
- `CACHE_VERSION` is bumped. A first index after upgrade re-parses everything once. The size target is under 3% of log size, against about 1.3% today.

## Adapters (`lib/trace/`)

- One module per source: `claude.js`, `codex.js`, `gateway.js`, `kiro.js`, `antigravity.js`, `gemini.js`. Each exposes the same three functions:
  - `listSessions(range)`: from the index, with no file reads;
  - `skeleton(sessionId)`: spans without text, built by ranged reads of the turns' offsets;
  - `content(ref, { maxBytes })`: one span's text, read from the file or from `tool-results/`.
- `lib/trace/index.js` is the registry. It handles:
  - routing by source;
  - the LRU skeleton cache (P2);
  - offloading to the worker pool for sessions over 50 MB;
  - the per-process read limit (P9);
  - isolating adapter errors (P10).
- `content()` passes text through `scanSecrets` masking before returning it. The response marks masked ranges, so the UI can offer a per-item "show". "Show" re-reads the range and returns that one value without masking; it is never cached (S2).
- Antigravity requires `node:sqlite` (Node 22.5+) and opens the DB read-only (S9). Without it, the source is listed as unavailable with the reason.

## HTTP API (dashboard session required; not exposed to gateway keys)

| Route | Returns |
|---|---|
| `GET /api/trace/sessions?range=&source=&q=&flags=` | session rows from the index (P5: title, project and flags only) |
| `GET /api/trace/session/:id` | skeleton: spans without text, turn list, totals |
| `GET /api/trace/content/:spanId?part=input\|output&offset=` | masked text for one span, capped at 64 KB per page (P1) |
| `GET /api/trace/live/:id?since=` | spans appended since an offset, for a running session (P8) |

Ids are opaque and resolved through the index only (S3). `ZAAFPULSE_CONTENT=off` makes `content` return 403 with a reason (S10).

## UI (`public/traceview.js`, route `#trace`, approved mockup `mockups/split-view-v4.html`)

**Left half: explorer**
- **Top bar:** title, time range (24 h, 7 d, 30 d), a button that collapses the session list to icons.
- **Sessions column, 264 px:**
  - search;
  - one row of source chips with counts, scrolled sideways, plus "With errors";
  - sessions grouped by day;
  - each row shows a 32 px source icon, the title with the time on the right, a meta line (project · cost · duration) and flags.
- **Trace tree for the selected turn:**
  - columns Span, Timeline and Time;
  - 34 px rows with indentation guides;
  - collapsible turns and subagents;
  - virtual rendering for large trees (P4);
  - eval and feedback badges (from sub-project 2).
- **Detail panel, fixed height:**
  - tabs Output, Input, Evals, Notes;
  - text rendered as text only (S1), with masked secrets and "show" per item;
  - actions: Good, Bad and Add note on the left; Add to dataset, Replay turn and Pause agent on the right. Those actions belong to sub-projects 2–4 and stay hidden until those ship.

**Right half: session map (holo style)**
- The selected turn drawn as a vertical flow: Session → Turn → model call(s) → tools → subagents → answer → outcome.
- Numbered notes alternate left and right.
- A colour per kind: turn violet, model cyan, tool amber, subagent pink, error red, judged green.
- Motion:
  - dashes flow along the connectors;
  - a light packet travels the chain;
  - rings pulse;
  - error nodes flicker.
  
  All motion stops under `prefers-reduced-motion`.
- A turn stepper (◀ 3/14 ▶) and a legend.
- Turns with many spans collapse repeated tool calls into one node with a count.

**Shared**
- One selection model: choosing a tree row highlights the map node with the same span id, and the reverse.
- A draggable splitter (38–70% width); the position is kept in `localStorage` (convenience only).
- Below 1100 px wide the halves stack.
- Keyboard: `j`/`k` move between spans, `←`/`→` change turn, `Enter` opens the detail.

**Elsewhere in the dashboard**
- The Sessions page (`workviews.js`) links each row to `#trace?s=<id>`.
- The AI Office and Logs pages link the current session to it too.

## Demo mode

`lib/demo.js` gains three synthetic sessions with turns, subagents, one error and one loop: Claude Code, Codex and Kiro. Content comes from a fixed in-memory sample, so demo mode reads no real files.

## Error handling

- A file that has rotated or been deleted since indexing returns "session file changed, rescanning". The UI offers a refresh.
- A line that cannot be parsed becomes an `unknown` span with the byte range. It is counted in the source's error badge.
- An adapter exception is reported in the source chip's tooltip, and the other sources keep working (P10).

## Testing

- **Fixtures** per source in `test/fixtures/trace/<source>/`, all synthetic:
  - Claude Code: nested and parallel subagents, large tool-results, a compaction, an interrupted turn;
  - Codex: a fork;
  - Gateway: a collaboration run;
  - Kiro, Antigravity (a generated SQLite file) and Gemini.
- **Unit tests:** span-model invariants (every parent exists, children sit inside the parent's time window, stable ids across rebuilds), offsets, masking and "show".
- **Security tests:**
  - path traversal and foreign ids (S3);
  - `ZAAFPULSE_CONTENT=off` (S10);
  - HTML in content rendered inert (S1), via the API and a DOM-free render function.
- **Performance tests:**
  - a synthetic 300 MB session's skeleton builds in under 3 s with workers;
  - one `content` page returns in under 100 ms;
  - LRU eviction.

## Out of scope

- Full-text search across content.
- Export of these traces to Phoenix, AX or Dynatrace (the deferred E).
- Editing transcripts.
- Antigravity step payload parsing.
