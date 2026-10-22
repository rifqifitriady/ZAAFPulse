# Agent run tracing: design

Date: 2026-10-22 · Status: revised 2026-10-22 against main `61bd037`, awaiting owner review · Shared requirements: `2026-10-20-ai-observability-overview.md` (S1–S11, P1–P10)

## Why this revision

The first draft (approved 2026-10-22) was written against `feat/mcp-integrations`, 237 commits behind `main`. Since then `main` has gained most of the ground the draft planned to build:

| The draft planned | Already on `main` |
|---|---|
| `lib/trace/tracer.js`: spans, buffer, live events | `lib/otel.js` builds OTel GenAI spans for every gateway request (SERVER), model call (`chat`, CLIENT), collaboration run (`invoke_workflow`, `invoke_agent`, `execute_tool`, `plan`, `judge`) and integration tool call, with an incoming `traceparent` continued. They are thrown away unless OTLP export is on. |
| `lib/trace/ids.js`: IDs and `traceparent` | `newId`, `hashId`, `parseTraceparent`, `formatTraceparent` in `lib/otel.js` |
| `lib/trace/sources/claude.js`, `codex.js`: sessions as spans | The trace explorer (`lib/trace/`, sub-project 1) builds spans from Claude Code, Codex, Gateway, Kiro, Gemini CLI and Antigravity logs, with ranged reads, an LRU, workers and opaque keys |
| A new Traces page with a waterfall | The explorer page `#trace`: session list, span tree with timeline, animated map, detail panel, evals and feedback |
| `/api/traces*` | `/api/trace/*` (sources, sessions, session, title, content, reveal, live, find) |
| `acc_traces_search` | `acc_trace_sessions` |
| Opt-in excerpts stored with spans | The explorer reads text from the original logs on demand; the overview rules that transcript text is never copied (only datasets keep a masked copy) |

What `main` still lacks, and what this design adds, is the part that is really Jaeger's: a **durable trace store** for the gateway, **read-time adjusters and analysis** (critical path, self time, rollups per branch, root cause), a **dependency map**, **progressive-disclosure trace reads over MCP**, and **context propagation** to remote agents and MCP servers with a narrow return channel.

## Decisions

| Question | Decision |
|---|---|
| Edition | ZAAFPulse v1 (`ai-command-center`) only. Ragnarok is out of scope. (unchanged) |
| Tracer | **`lib/otel.js` is the one tracer.** The local store is a second sink next to the OTLP exporter, so one span pipeline feeds both. No `tracer.js`, no `ids.js`. |
| Local store default | **On**, metadata only (plug and play, no setup). `"tracing": { "enabled": false }` turns it off. |
| Span content in the store | **None.** Content attributes are stripped before a span is stored, whatever `otel.captureContent` says. The draft's opt-in excerpts are dropped: step text of collaboration runs is already read on demand from `runs.json`, and the overview keeps transcript copies out of every store. |
| Claude Code and Codex | Not rebuilt: the explorer's adapters stay the only session sources. The analysis runs on **every** source's spans, not only the gateway's. |
| UI | The existing explorer page gains the analysis and a dependency table. No new page. |
| Storage approach | A: append-only daily segment files plus an in-memory trace index (Jaeger's Badger and memory backends). (unchanged) |
| Propagation and return channel | As in the draft: `traceparent` on A2A and MCP calls; OTLP/HTTP JSON back on `POST /v1/traces` for trace IDs this ZAAFPulse started. (unchanged) |

## Goal

Turn every AI agent run on this machine into a trace that can be searched, opened and explained:

1. which steps a run took (planner, agents, model calls, tool calls, consults, remote agents),
2. where the time and the money went (critical path, self time, cost and tokens rolled up per branch),
3. where it failed (the failing span on the critical path, with its error),
4. how agents, models and tools depend on each other across gateway runs (dependency map).

Points 2 and 3 apply to every explorer source (Claude Code, Codex, Gateway, Kiro, Gemini CLI, Antigravity) as far as its spans carry times and statuses.

## Non-goals

- A general OTLP backend. Only the narrow return channel accepts spans from outside.
- Sampling. Retention bounds the size.
- Multi-user isolation, tenants, RBAC (Ragnarok).
- Replacing usage and cost accounting. `usage.js` stays the source of truth for billing.
- Storing any prompt, reply, tool argument or tool result text.
- Dependencies across Claude Code or Codex sessions (it would mean building every session's skeleton); the map covers stored gateway traces.

## Constraints

- **Zero runtime dependencies.** Node 18+ standard library only. No `node:sqlite`.
- **Local only.** Traces live under the data dir (`.data/traces/`), files `0600`, folder `0700`.
- **No content in the store** (S11). Error messages are kept, masked and cut to 200 characters, as `runs.json` already does.
- A tracing failure never fails a request or a run.
- Match the code style: CommonJS, small single-purpose files, short "why" comments, `node --test`, `.prettierrc.json`.
- Commits and PRs carry no AI attribution (owner rule for this repo).

## Logic borrowed from Jaeger

| Jaeger | Here |
|---|---|
| Trace = spans sharing a `trace_id`; the tree is rebuilt from `parent_span_id` at read time, never stored | Same |
| `Writer.WriteTraces` / `Reader.GetTrace, FindTraces, GetDependencies` | `lib/trace/store.js` writes and reads stored traces; the explorer registry finds and opens them |
| Search finds trace IDs from an index first, then loads spans | Trace index in memory, spans loaded by byte range |
| `trace_id_timestamps` (min start, max end per trace) | The trace summary carries start and end |
| Daily indices / TTL | One segment file per UTC day; retention deletes whole files |
| Adjusters: dedupe span IDs, sort, clock skew | `lib/trace/adjust.js`; clock skew only for spans whose service differs from the parent's |
| Critical path: from the root, take the last-finishing child, then walk back to children that finished before it started | `lib/trace/analyze.js`, same algorithm |
| Dependency links: parent→child pairs whose service differs | Edges from agents to models, tools, agents and remote services, with counts, errors and p95 |
| MCP tools with progressive disclosure (search → topology → critical path → span details) | `acc_trace_sessions` (exists) and a new `acc_trace_get` with views |

## Architecture

```
gateway request ──► lib/otel.js (one tracer, AsyncLocalStorage context)
                      │ span records
                      ├──► OTLP exporter (only when otel.enabled)          [exists]
                      └──► lib/trace/recorder.js ──► lib/trace/store.js    [new]
                             strips content, buffers,      .data/traces/YYYY-MM-DD.ndjson
                             remembers trace IDs           .data/traces/index.json (snapshot)
                                   ▲
              POST /v1/traces ─────┘ (return channel, known trace IDs only)

explorer registry (lib/trace/index.js)
   ├── claude, codex, kiro, gemini, antigravity adapters                   [exist]
   └── gateway adapter ── stored traces (store)  +  older runs/requests      [extended]
         │
         ▼ skeleton (explorer span model)
   adjust.js ─► analyze.js ─► `analysis` next to the spans                  [new]
         │
         ├── /api/trace/session (+ analysis), /api/trace/deps                [extended / new]
         ├── public/traceview.js: critical path, self time, branch totals,
         │   root cause, dependency table                                     [extended]
         └── acc_trace_get (MCP)                                              [new]
```

### The local sink in `lib/otel.js`

- `createOtel({ ..., sink })` takes `{ enabled() → bool, add(record) }`. Spans are produced when export is on **or** the sink is enabled; each finished span goes to the exporter when there is one and to the sink when it is enabled.
- With export off, request handling behaves as if `captureContent` were false: no request body is copied, no reply text is kept.
- `mcp.js` (stdio) gets no sink: only the server process writes the store.

### Complete trees

Two gaps in today's spans would make the analysis wrong, so they are closed:

1. **Model calls sit beside their agent, not under it.** Today a model call's `chat` span is a child of the request span. A new `otel.within(parent, fn, chatSpanId)` runs code with a given parent span, so `chat` spans nest under the agent or step that made them.
2. **A collaboration run's trace ID depends on the request that exports it.** A run gets a fixed trace context when it starts (`run.otel = { traceId, spanId }`, the request span or a stable hash), kept in `runs.json`. Its spans keep their stable IDs (`hashId(runId:spanId)`), and the gateway's `chat` span for a run's model call takes the ID of the run's own chat span, so the explorer can link step text to it.

Also:
- The export of a run uses this execution's spans in full, not `run.trace`, which stays capped at 800 for the live run view.
- A standalone agent run (no collaboration run) gets `invoke_agent` and `execute_tool` spans too, through a small span book with the same interface as a run's `rt.span`.

### Span record (one NDJSON line in a segment)

```json
{"t":"4bf92f3577b34da6a3ce929d0e0e4736","s":"00f067aa0ba902b7","p":"b7ad6b7169203331",
 "n":"execute_tool zp_memory_save","k":"internal","st":1792642201123456,"d":5120,
 "ok":true,"src":"gateway","svc":"zaafpulse",
 "a":{"gen_ai.operation.name":"execute_tool","gen_ai.tool.name":"zp_memory_save","gen_ai.agent.id":"sales"}}
```

| Field | Meaning |
|---|---|
| `t` / `s` / `p` | Trace ID (32 hex), span ID (16 hex), parent span ID or `null` |
| `n` | Span name as `lib/otel.js` names it |
| `k` | `internal`, `server`, `client` |
| `st` / `d` | Start and duration, **microseconds** (nanoseconds do not fit a JSON number exactly; Jaeger uses microseconds) |
| `ok` / `err` | Status; `err` masked, at most 200 characters |
| `src` / `svc` | `gateway` or `remote`; the service (`zaafpulse`, or a remote service's `service.name`) |
| `a` | The span's attributes, minus content attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`); a span from the return channel keeps only an allow-list of attributes (see below) |

### Trace summary (one entry in the trace index)

`traceId, src, svc, root, rootStart, start, end, spans, errors, toolCalls, tokensIn, tokensOut, costUSD, models[], agents[], tools[], runId, ref`

Tokens and cost come from `chat` spans only, because agent and workflow spans repeat their children's totals. `runId` is the `zaafpulse.run.id` of a run's root. `ref` maps each segment to the byte range the trace covers in it.

### Explorer integration

- **Gateway rows.** The gateway adapter lists one row per stored trace (`trace:<traceId>`), except a trace that belongs to a collaboration run in `runs.json` (its `runId`, or the run's `otel.traceId`): that run keeps its `run:<id>` row, because evals, feedback and links are keyed on it. Its skeleton is built from the store, and the spans of `run.trace` the store lacks are merged in under their exported ids (`runSpanId`), since agent and workflow spans are exported only when the run ends; the row's stamp includes the stored trace's span count and end, so a cached skeleton follows new spans. Requests still come from the usage log, de-duplicated per request: `lib/otel.js` writes the request's trace id on its usage entry (`traceId`, only when the request is sampled and spans are recorded), and a request is skipped only when the store holds that trace. So nothing shows twice, history from before the upgrade stays, and a request the store does not hold (unsampled, spans lost to a full buffer or a failed write, traffic while tracing was off) keeps its row.
- **Row titles** hold the root span name and counts, never a task or a prompt. Rows carry **tags** (agent IDs, model names, tool names, masked like a title) that the existing search box matches.
- **Stored skeletons** are converted to the explorer span model (`kind`, `op`, `name`, `start`/`end` in ms, `status`, `model`, `provider`, `usage`, `cost`, `tool`, plus `service`), then adjusted. When the trace is a run that `runs.json` still holds, step text and the answer are linked as today.
- **Analysis** is computed when a skeleton is sealed and cached with it: the response of `/api/trace/session` gains `analysis = { rootSpanId, criticalPath: [{ spanId, start, end }], selfTime: { spanId: ms }, rollup: { spanId: { tokensIn, tokensOut, costUSD, spans, errors } }, rootCause: { spanId, name, error, onCriticalPath } | null }`. For a skeleton that holds one turn, the turn span is the root of the analysis.
- **Search**: `/api/trace/sessions` gains `minMs` and `minCost`.
- **Dependencies**: `GET /api/trace/deps?range=` returns `{ nodes: [{ id, kind, label, count }], edges: [{ from, to, count, errors, p95Ms }] }` over stored traces in the range (at most 500 traces). Demo mode returns a fixed sample.

### UI (`public/traceview.js`)

- Rows on the critical path are marked (an accent on the timeline bar), and the tree header shows the critical path's length.
- The detail line of a span adds its self time and, for a span with children, its branch totals (cost, tokens, errors).
- A notice above the tree names the root cause with a button that selects it.
- The right half gets a **Map / Dependencies** switch; Dependencies is a table (from, to, calls, failures, p95) for the chosen time range.
- Everything is text built with `esc()` / `textContent` (S1).

### MCP

`acc_trace_get { key, turn?, view, span? }` on the `acc` connector, for sessions listed by `acc_trace_sessions` (so: no gateway sessions there, as today):

- `topology`: span ID, parent, kind, name, duration and status; no attributes;
- `critical_path`: the sections with names and durations;
- `errors`: failed spans and the root cause;
- `span`: one span's fields (model, tool, usage, cost, self time, rollup); never text or content IDs.

### Propagation and the return channel

- **A2A**: `runRemote` records a CLIENT span `a2a <agent id>` (`rpc.system: a2a`, `server.address`, `gen_ai.agent.id`) under the calling agent and sends its `traceparent` header.
- **MCP over Streamable HTTP**: `otel.toolCall` already makes a CLIENT span per integration call; its `traceparent` goes to `lib/mcp/client.js` as a header and as `params._meta.traceparent` on `tools/call`.
- **Return channel**: `POST /v1/traces`, OTLP/HTTP JSON, ahead of the gateway's own routes:
  1. only from this machine (remote address `127.0.0.1` / `::1`);
  2. only spans whose trace ID the recorder saw in the last 24 hours (a 128-bit ID that was only ever sent to the callee works as a capability); the rest are dropped and counted;
  3. bodies over 1 MB are refused, and at most 2,000 spans per trace are accepted from outside;
  4. a span from outside keeps only allowed attributes (operation, models, provider, agent and tool names, token counts, `rpc.*`, `server.*`, `http.*` method, status and route, `error.type`, `mcp.method.name`): other conventions carry prompt and reply text under their own keys (OpenInference `input.value`, OpenLLMetry `gen_ai.prompt.*`), so a deny-list would not keep the store free of content.

  Accepted spans are stored with `src: "remote"` and their own `svc`, so clock skew is corrected for them and the dependency map shows the remote service.

## Configuration

```json
"tracing": {
  "enabled": true,
  "retentionDays": 14,
  "maxBytes": 524288000
}
```

All three are optional; these are the defaults.

## Error handling

- A write failure never fails a run: spans wait in a bounded buffer (10,000), the overflow is dropped and counted (`dropped`), and write errors are counted (`writeErrors`) and logged at most once a minute.
- A corrupt or truncated segment line is skipped when indexed; a line cut short by a crash is closed before the next append.
- A stored trace whose segments were deleted by retention answers 404 ("session file changed, rescanning"), as the explorer does for a moved log.
- Analysis never throws into a response: a failure leaves `analysis: null`.

## Performance budget

| Item | Budget |
|---|---|
| Sink overhead per span | under 0.1 ms (convert and buffer) |
| Trace index memory | about 400 bytes per trace: 100,000 traces ≈ 40 MB |
| Open a stored trace of 5,000 spans | under 300 ms, analysis included |
| Analysis of a 5,000-span explorer skeleton | under 100 ms, cached with the skeleton |
| Index rebuild from 500 MB of segments | under 30 s, at startup only |

## Testing

`node --test`, one file per new module, all fixtures synthetic:

- `trace-summary`, `trace-store`, `trace-recorder`: summaries, append and read back by byte range, catch-up from a snapshot, a truncated line, retention by age and size, content stripping, buffer limits, known trace IDs.
- `otel` (extended): spans reach the sink with export off; nothing is copied from request bodies then; `within` parents model calls; a run keeps one trace ID across export and resume.
- `trace-adjust`, `trace-analyze`: duplicates, orphans, clock skew; critical path on sequential, overlapping and overflowing children; rollups from chat spans only; self time; root cause.
- `trace-gateway` (extended): stored rows, de-duplication against runs and requests, skeleton conversion, run text linking.
- `trace-api`, `trace-ui` (extended): `analysis` in the session response, `minMs` / `minCost`, `/api/trace/deps`, critical-path rows and the root-cause notice built without HTML from content.
- `trace-mcp`: the four views; no text and no content IDs.
- `trace-propagate`, `trace-otlp`: headers on fake A2A and MCP servers; the return channel keeps known trace IDs, drops unknown ones, refuses oversize bodies and calls from elsewhere.

## Phases

1. **Store**: summary, store, recorder, the sink in `lib/otel.js`, server wiring.
2. **Complete trees**: run trace context, model calls in place, standalone agent runs.
3. **Analysis**: adjusters and analysis on the explorer span model.
4. **In the explorer**: gateway rows from the store, analysis and search in the API, the UI, `acc_trace_get`.
5. **Across processes**: `traceparent` on A2A and MCP, the return channel, documentation.

Each phase ships on its own and leaves the dashboard working.

## Open points for the owner

- The local store is on by default. It holds no content, but it is a new file set under `.data/` (14 days, at most 500 MB).
- The return channel trusts the trace ID as a capability for callers on this machine. A gateway API key requirement could be added later if a remote agent on another machine needs it.
