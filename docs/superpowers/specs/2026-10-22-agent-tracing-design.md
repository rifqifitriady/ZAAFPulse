# Agent run tracing: design

Date: 2026-10-22 · Status: approved (2026-10-22)

## Decisions from brainstorming (2026-10-22)

| Question | Decision |
|---|---|
| Edition | ZAAFPulse v1 (`ai-command-center`) only. Ragnarok is out of scope. |
| What is traced | AI agent runs, as a user-facing feature. |
| Sources | (1) every gateway run, (2) Claude Code and Codex sessions, (3) remote A2A agents and MCP servers through `traceparent` propagation. OTLP ingest from arbitrary outside apps is deferred. |
| Span content | Metadata by default. Excerpts of prompts, replies and tool arguments are opt-in per source, truncated and masked. |
| Storage approach | A: append-only daily segment files plus an in-memory trace index (the pattern of Jaeger's Badger and memory backends). |

## Goal

Turn every AI agent run on this machine into a trace that can be searched, opened and explained:

1. which steps a run took (planner, agents, model calls, tool calls, consults, remote agents),
2. where the time and the money went (critical path, cost and tokens rolled up per branch),
3. where it failed (the failing span on the critical path, with its error),
4. how agents, models and tools depend on each other across runs (dependency map).

The logic follows Jaeger (CNCF), adapted to one user on one machine with zero dependencies.

## Non-goals

- A general OTLP backend for any application. Only the narrow return channel in [Propagation](#propagation) accepts spans from outside.
- Sampling. One user produces few enough spans to keep all of them; retention bounds the size instead.
- Multi-user isolation, tenants, RBAC. That belongs to Ragnarok.
- Replacing the existing usage and cost accounting. Traces read the same numbers; `usage.js` stays the source of truth for billing.

## Constraints

- **Zero runtime dependencies.** Node 18+ standard library only (`fs`, `crypto`, `readline`). No `node:sqlite`.
- **Local only.** Data under the existing data dir (`lib/platform.js`), files mode `0600`. The server keeps listening on 127.0.0.1 with the host-header check.
- **No prompt text by default**, as the collaboration engine does today.
- Match the existing code style: CommonJS, small single-purpose files, short comments, `node --test`.

## Logic borrowed from Jaeger

| Jaeger | Here |
|---|---|
| Trace = spans sharing a `trace_id`; the tree is rebuilt from `parent_span_id` at read time, never stored | Same |
| `Writer.WriteTraces` / `Reader.GetTrace, FindTraces, FindSpans, GetDependencies` | Same contract in `lib/trace/store.js` and `reader.js` |
| Search finds trace IDs from an index first, then loads spans | Trace index in memory, spans loaded by byte offset |
| `trace_id_timestamps` table (min start, max end per trace) | Trace summary carries start and end |
| Daily indices (Elasticsearch) / TTL (ClickHouse) | One segment file per UTC day; retention deletes whole files |
| Adjusters: dedupe span IDs, sort, clock skew | `adjust.js`, clock skew applied only to spans from another process |
| Critical path: from the root, take the last-finishing child, then walk back to children that finished before it started | `analyze.js`, same algorithm |
| Dependency links: count parent→child pairs whose service differs | Edges between agents, models and tools, with counts, errors and p95 duration |
| MCP tools with progressive disclosure (search → topology → critical path → span details) | Two `acc_*` MCP tools shaped the same way |

## Data model

### Span (one NDJSON line in a segment file)

```json
{"t":"4bf92f3577b34da6a3ce929d0e0e4736","s":"00f067aa0ba902b7","p":"b7ad6b7169203331",
 "n":"execute_tool zp_memory_save","k":"internal","st":1792642201123456,"d":5120,
 "ok":true,"src":"gateway","svc":"zaafpulse",
 "a":{"gen_ai.operation.name":"execute_tool","gen_ai.tool.name":"zp_memory_save","gen_ai.agent.id":"sales"}}
```

| Field | Meaning |
|---|---|
| `t` | Trace ID, 16 bytes as 32 hex characters (W3C) |
| `s` / `p` | Span ID and parent span ID, 8 bytes as 16 hex characters; `p` is `null` for the root |
| `n` | Name, OpenTelemetry GenAI style: `invoke_workflow`, `plan`, `invoke_agent <id>`, `chat <model>`, `execute_tool <name>`, `judge` |
| `k` | Kind: `internal`, `client` (outgoing call to a remote agent or MCP server), `server` |
| `st` | Start, **microseconds** since the Unix epoch. Nanoseconds do not fit a JSON number without losing precision; microseconds do (Jaeger uses the same unit) |
| `d` | Duration in microseconds |
| `ok` / `err` | Status; `err` is the error message cut to 200 characters |
| `src` | `gateway`, `claude`, `codex`, `remote` |
| `svc` | Service: `zaafpulse`, `claude-code`, `codex`, or the remote agent's host |
| `a` | Attributes: `gen_ai.*` names where one exists, `zp.*` otherwise (`zp.cost_usd`, `zp.depth`, `zp.handoff_to`, `zp.timing`) |
| `x` | Optional excerpt, only when capture is on: `{ "in": "...", "out": "..." }`, each at most `maxExcerptBytes` |

### Trace summary (one entry in the trace index)

`traceId, src, svc, root (name), start, end, spans, errors, tokensIn, tokensOut, costUSD, models[], agents[], tools[], ref`

`ref` points at the data: for stored traces `{ segment, offsets[] }`; for Claude Code and Codex sessions `{ file, sessionId }` (see [Session sources](#session-sources)).

## Components

| File | Responsibility |
|---|---|
| `lib/trace/ids.js` | Generate trace and span IDs (`crypto.randomBytes`), derive stable IDs from a string (SHA-256, first 16 or 8 bytes), parse and format `traceparent` |
| `lib/trace/tracer.js` | `startTrace(name, attrs)`, `startSpan(name, attrs, parent)`, `span.end(more, err)`. Spans are buffered and handed to the store every second or every 500 spans. Emits the same live events the collaboration UI already listens to |
| `lib/trace/store.js` | Writer: append to `traces/YYYY-MM-DD.ndjson`, record byte offsets, update the trace summary. Index snapshot to `traces/index.json` every 5 minutes and on shutdown; rebuilt by scanning segments when the snapshot is missing, older than the newest segment, or unreadable (a truncated last line is skipped). Retention: delete the oldest segments past `retentionDays` (default 14) or `maxBytes` (default 500 MB), and drop their summaries |
| `lib/trace/reader.js` | `getTrace(id)`, `findTraces(query)`, `findSpans(query)`, `getDependencies(range)`. `findTraces` filters the in-memory index (source, service, root name, agent, model, tool, errors only, min duration, min cost, time range, limit). `findSpans` scans only the segments inside the time range and stops at `limit` |
| `lib/trace/adjust.js` | Applied at read time, in order: dedupe span IDs, sort children by start, clock-skew correction for spans whose `svc` differs from the parent's (Jaeger's rule: centre the child inside the parent when it falls outside it), mark orphans (parent missing) and attach them under the root |
| `lib/trace/analyze.js` | Build the tree; critical path; self time; tokens and cost rolled up per subtree; error root cause = the deepest failed span on the critical path, else the earliest failed span |
| `lib/trace/sources/claude.js` | Claude Code session JSONL → spans (below) |
| `lib/trace/sources/codex.js` | Codex session JSONL → spans (below) |
| `lib/trace/propagate.js` | Inject `traceparent` into outgoing A2A requests and MCP calls; accept returned spans on the return channel |
| `lib/trace/capture.js` | Decide whether to keep an excerpt, cut it, and mask secrets with `lib/secrets.js` |

## Coverage of gateway runs

- The gateway's `llm()` (`lib/gateway/index.js`) and `runAgent()` (`lib/gateway/orchestrator.js`) take a trace context from `ctx`. When none is present, the entry point starts a new trace, so a plain chat, a single-agent run and a workflow run each become a trace, not only collaboration runs.
- The collaboration engine's `rt.span` becomes a thin adapter over `tracer.js`. Its live `span` / `span-end` events and the shapes the UI reads stay the same.
- Existing `run.trace` arrays in `runs.json` stay as they are. New runs store `traceId` (and `rootSpanId`) next to the live `run.trace` array, which keeps its cap of 800 spans because the existing run view reads it; the trace store has the full trace.
- The limits of 800 spans per run and 200 runs go away for traces; retention replaces them.

## Session sources

Claude Code and Codex sessions are **not copied**. The existing indexer already scans `~/.claude/projects` and `~/.codex/sessions`; it is extended to write a trace summary per session (incrementally, by file size and mtime). Spans are built from the original JSONL when a trace is opened.

Claude Code mapping:

| Session content | Span |
|---|---|
| The session | root `invoke_agent claude-code`, `svc: claude-code` |
| A user prompt | `turn` |
| An assistant message with usage | `chat <model>`, tokens and cost from the existing pricing |
| A `tool_use` and its `tool_result` | `execute_tool <name>`, from the `tool_use` timestamp to the `tool_result` timestamp |
| A subagent (sidechain messages, or the Agent/Task tool) | nested `invoke_agent <type>` under the tool span |

- IDs are derived, so they are the same every time: trace ID = hash of `sessionId`, span ID = hash of the message `uuid` (or `tool_use` id).
- Timestamps in the logs have millisecond resolution and mark when a message was written, not when a model call started. A `chat` span starts at the previous event and ends at its own message; such spans carry `zp.timing: "estimated"`, and the UI shows that.
- Codex follows the same mapping from `turn_context`, `user_message`, `function_call` / `function_call_output` and `token_count`.
- Excerpts for these sources are read from the original file at open time and never stored.

## Propagation

Outgoing calls carry the current span as W3C trace context:

- **A2A remote agents**: header `traceparent: 00-<traceId>-<spanId>-01` on the JSON-RPC POST in `runRemote`.
- **MCP over Streamable HTTP** (`lib/mcp/client.js`): the same header, plus `params._meta.traceparent` on `tools/call`.

The caller always records a `client` span with the remote latency and status, so the tree has the remote step even when the remote side sends nothing back.

**Return channel** (so the tree does not stop at the process boundary): `POST /v1/traces` accepting OTLP/HTTP JSON on 127.0.0.1, with three guards:

1. only spans whose trace ID ZAAFPulse itself started in the last 24 hours are kept; the rest are dropped and counted;
2. bodies above 1 MB and more than 2,000 spans per trace from outside are refused;
3. the same host-header check as the rest of the server.

A remote agent or MCP server that exports OpenTelemetry can point its exporter at this endpoint. Others still appear as the caller's `client` span.

## Content capture

```json
"tracing": {
  "retentionDays": 14,
  "maxBytes": 524288000,
  "capture": { "gateway": false, "claude": false, "codex": false },
  "maxExcerptBytes": 2048
}
```

When capture is on for the gateway, `invoke_agent`, `chat` and `execute_tool` spans keep `x.in` / `x.out`, cut to `maxExcerptBytes` and masked with the existing secret masking. Off by default.

## API, MCP tools and UI

HTTP (same server, same auth):

- `GET /api/traces?src=&agent=&model=&tool=&errors=1&minMs=&minCost=&from=&to=&limit=` → summaries
- `GET /api/traces/<id>` → adjusted spans, tree, critical path, rollups, error root cause
- `GET /api/traces/deps?from=&to=` → dependency edges
- `GET /api/spans?name=&tool=&errors=1&from=&to=&limit=` → matching spans

MCP (`mcp.js`, `acc` connector), shaped for an agent's context window as Jaeger's MCP tools are:

- `acc_traces_search`: summaries only.
- `acc_trace_get` with `view`: `topology` (names and durations, no attributes), `critical_path`, `errors`, or `span` (one span's attributes and excerpt).

UI: a **Traces** page: the search list with filters; a trace view with a waterfall, the critical path highlighted, cost and tokens per branch, and the error root cause called out; a dependency map of agents, models and tools (in the first version, a table of edges: from, to, calls, failures, p95). It follows the dashboard's existing style and reuses the collaboration view's span rendering.

## Error handling

- A write failure never fails the run: spans go to a bounded in-memory buffer (10,000 spans), and the overflow is dropped and counted in `/api/traces/stats`.
- A corrupt or truncated segment line is skipped on read and on index rebuild.
- A session file that disappeared makes `getTrace` answer 404 and the next indexer pass drop the summary.
- Paths in a session `ref` are checked to stay under the session roots before reading.

## Performance budget

| Item | Budget |
|---|---|
| Tracer overhead per span | under 0.1 ms (buffer append only) |
| Trace index memory | about 400 bytes per trace: 100,000 traces ≈ 40 MB |
| Search over the index | under 50 ms for 100,000 traces |
| Open a trace of 5,000 spans | under 300 ms, analysis included |
| Index rebuild from 500 MB of segments | under 30 s, at startup only |

## Testing

`node --test`, one test file per module:

- `ids`: format, stable derivation, `traceparent` round trip and rejection of malformed headers.
- `store`: append and read back by offset; rebuild after a truncated last line; retention by age and by size.
- `adjust`: duplicate IDs, orphans, clock skew cases taken from Jaeger's documented rules.
- `analyze`: critical path on fixtures (sequential children, overlapping children, a child outliving its parent); rollups; error root cause.
- `sources/claude` and `sources/codex`: fixture JSONL → expected spans, subagents, estimated timing flag.
- `propagate`: header present on fake A2A and MCP servers; return channel keeps known trace IDs, drops unknown ones, refuses oversize bodies.
- API: the four endpoints against a seeded store; the two MCP tools.

## Phases

1. **Core**: `ids`, `tracer`, `store`, `reader`; every gateway run traced; collaboration adapter; `/api/traces` list and get; a basic waterfall.
2. **Sessions**: Claude Code and Codex sources through the indexer.
3. **Analysis**: `adjust`, `analyze` (critical path, rollups, root cause), dependency map, the two MCP tools.
4. **Propagation**: `traceparent` on A2A and MCP, the return channel.

Each phase ships on its own and leaves the dashboard working.

## Resolved at review (2026-10-22)

- Retention defaults stay at 14 days and 500 MB.
- The narrow OTLP return channel of phase 4 is accepted as designed.
