# Agent Run Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every gateway trace on disk and explain any trace in the explorer the way Jaeger does: adjusted spans, critical path, self time, cost per branch, root cause, a dependency map, MCP reads, and context propagation to remote agents and MCP servers.

**Architecture:** `lib/otel.js` stays the one tracer and gains a second sink next to the OTLP exporter: `lib/trace/recorder.js` strips content and buffers span records into `lib/trace/store.js` (daily NDJSON segments, an in-memory trace index, a snapshot, retention). The explorer's gateway adapter lists stored traces; `lib/trace/adjust.js` and `lib/trace/analyze.js` run on the explorer span model, so the analysis covers every source. The explorer page, `/api/trace/*` and the `acc` MCP connector show it.

**Tech Stack:** Node 18+ standard library only (`fs`, `crypto`, `http`, `async_hooks`, `node:test`). Plain browser JS in `public/`.

Spec: `docs/superpowers/specs/2026-10-22-agent-tracing-design.md`

## Global Constraints

- Runtime dependencies: **0**. Do not add anything to `package.json`.
- Node **>= 18**, CommonJS, `'use strict'` only in `public/*.js`. No `node:sqlite`.
- Span records: fields exactly `t s p n k st d ok err src svc a`; `st` and `d` in **microseconds**; `err` masked, at most **200** characters.
- Trace summary fields exactly: `traceId src svc root rootStart start end spans errors toolCalls tokensIn tokensOut costUSD models agents tools runId ref`.
- Tokens and cost in a summary or a rollup come from `chat` spans only.
- **No content in the store**: drop `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` before a span is stored.
- Traces folder `.data/traces/`, mode `0700`; files `0600`.
- Defaults: tracing **on**, retention **14 days**, **500 MB**; buffer **10,000** spans, batch **500**, flush **1 s**, snapshot and retention every **5 min**; return channel **1 MB** body, **2,000** spans per trace from outside, trace IDs known for **24 h**.
- A tracing failure never fails a request or a run: every hook catches its own errors.
- Content from logs is rendered with `esc()` / `textContent` only (S1). No file path in any API or MCP response (S3).
- Comment style: short `//` comments that explain why, like the existing `lib/*.js`. Format with the repo's `.prettierrc.json` (`npx prettier --write <files>` if prettier is installed globally; otherwise match the style by hand).
- The suite is `npm test` (`node --test test/*.test.js`) and must stay green.
- Commits carry **no AI attribution** (owner rule for this repo). Every commit stages only the files its task names (`git add <paths>`), never `git add -A`.

## File map

| File | Status | Responsibility | Task |
|---|---|---|---|
| `lib/trace/summary.js` | create | one trace's summary from span records | 1 |
| `lib/trace/store.js` | create | segments, trace index, snapshot, retention, covered window, run lookup | 2 |
| `lib/trace/recorder.js` | create | OTel span → span record, content stripping, buffer, known trace IDs, ingest | 3 |
| `lib/otel.js` | modify | local sink; `live`; `within`; `spanBook`; run trace context; `traceparent` of tool spans | 4, 5, 6, 13 |
| `server.js` | modify | store, recorder, timers, shutdown; store into the registry; deps route; return channel | 4, 9, 10, 14 |
| `config.example.json` | modify | `tracing` block | 4 |
| `lib/gateway/collab.js` | modify | `run.otel`, `rt.within`, `rt.traceCtx`, chat spans in place, full export list | 5 |
| `lib/gateway/orchestrator.js` | modify | span book for standalone runs, nesting, A2A client span and header | 6, 13 |
| `lib/trace/adjust.js` | create | dedupe, orphans, clock skew (explorer span model) | 7 |
| `lib/trace/analyze.js` | create | critical path, rollups, self time, root cause (explorer span model) | 8 |
| `lib/trace/gateway.js` | modify | stored trace rows and skeletons, de-duplication, run text | 9 |
| `lib/trace/index.js` | modify | store option, row tags and stamps, analysis in sealed skeletons, `minMs`/`minCost`, `deps` | 9, 10 |
| `lib/trace/deps.js` | create | dependency map over stored traces | 10 |
| `lib/demo.js` | modify | demo dependency sample | 10 |
| `public/traceview.js`, `public/styles.css` | modify | critical path, self time, branch totals, root cause, dependency table | 11 |
| `lib/trace/views.js` | create | MCP views of a skeleton | 12 |
| `lib/local.js`, `lib/connectors/acc.js` | modify | `acc_trace_get` | 12 |
| `lib/integrations.js`, `lib/connectors/mcp-proxy.js`, `lib/mcp/client.js` | modify | pass `traceparent` to MCP servers | 13 |
| `lib/trace/otlp.js` | create | OTLP/HTTP JSON return channel | 14 |
| `docs/explorer.md`, `docs/otel.md` | modify | user documentation (README is left to the owner) | 15 |
| `test/trace-*.test.js`, `test/otel.test.js` | create / modify | tests | all |

## Shared interfaces (read this before any task)

**OTel span record** (what `lib/otel.js` hands to the exporter and the sink; exists today):
`{ traceId, spanId, parentSpanId ('' for none), traceState, flags (bit 0x200: parent is remote), name, kind (1 internal, 2 server, 3 client), startNs (BigInt), endNs (BigInt), attributes: {}, dropped, status: { code (0 unset, 1 ok, 2 error), message } }`

**Span record** (one NDJSON line): `{ t, s, p, n, k, st, d, ok, err?, src, svc, a }` as in the spec.

**Explorer span** (what every adapter returns; `lib/trace/model.js` `span()`): `{ id, parent, kind ('session'|'turn'|'chat'|'tool'|'agent'|'answer'|'unknown'), op, name, start (ms), end (ms|null), status ('ok'|'error'|'running'|'unknown'), model, provider, usage: { input, output, cacheRead, … } | null, cost, tool: { name, target } | null, signals: [], text, result? }`. This plan adds an optional `service` (string) to spans converted from stored traces.

**Span book** (Tasks 5 and 6; the object `orchestrator.js` calls as `ctx.run` or `ctx.tracer`):
- `span(name, attrs, parentId) → { id, end(more = {}, err = null) }`
- `within(id, fn) → fn()` run with span `id` as the current OTel parent
- `traceCtx(id) → { traceId, spanId, sampled } | undefined`

---

# Phase 1: The store

Result of the phase: every gateway request, model call, run and integration tool call is kept on disk under `.data/traces/` (without content), whether or not OTLP export is on.

### Task 1: Trace summary

**Files:**
- Create: `lib/trace/summary.js`, `test/trace-summary.test.js`

**Interfaces:**
- Consumes: span records.
- Produces: `blankSummary(traceId) → summary`, `addSpan(summary, record) → summary`, `summarize(traceId, records) → summary` (summary without `ref`).

- [ ] **Step 1: Write the failing test** (`test/trace-summary.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../lib/trace/summary');

const T = 'a'.repeat(32);
const rec = (s, p, n, st, d, a = {}, ok = true) => ({ t: T, s, p, n, k: 'internal', st, d, ok, src: 'gateway', svc: 'zaafpulse', a });

test('summary: root, time range and counts; tokens and cost from chat spans only', () => {
  const root = '1'.repeat(16);
  const agent = '4'.repeat(16);
  const s = summarize(T, [
    rec('2'.repeat(16), agent, 'chat m1', 1100, 200, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'm1',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
      'zaafpulse.cost.usd': 0.01,
    }),
    rec('3'.repeat(16), agent, 'execute_tool web', 1300, 100, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' }, false),
    // The agent span repeats its children's totals; they must not be counted twice.
    rec(agent, root, 'invoke_agent sales', 1050, 400, {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.id': 'sales',
      'gen_ai.usage.input_tokens': 10,
      'zaafpulse.cost.usd': 0.01,
    }),
    rec(root, null, 'invoke_workflow auto', 1000, 500, { 'zaafpulse.run.id': 'run_1' }),
  ]);
  assert.equal(s.root, 'invoke_workflow auto');
  assert.equal(s.rootStart, 1000);
  assert.equal(s.start, 1000);
  assert.equal(s.end, 1500);
  assert.equal(s.spans, 4);
  assert.equal(s.errors, 1);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.tokensIn, 10);
  assert.equal(s.tokensOut, 5);
  assert.equal(s.costUSD, 0.01);
  assert.deepEqual(s.models, ['m1']);
  assert.deepEqual(s.agents, ['sales']);
  assert.deepEqual(s.tools, ['web']);
  assert.equal(s.runId, 'run_1');
  assert.equal(s.src, 'gateway');
  assert.equal(s.svc, 'zaafpulse');
});

test('summary: a span with a remote parent still becomes the root when it starts first', () => {
  const s = summarize(T, [
    rec('2'.repeat(16), '1'.repeat(16), 'chat m', 1100, 10, { 'gen_ai.operation.name': 'chat' }),
    rec('1'.repeat(16), 'f'.repeat(16), 'POST /v1/chat/completions', 1000, 200),
  ]);
  assert.equal(s.root, 'POST /v1/chat/completions');
  assert.equal(s.runId, null);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-summary.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/summary'`.

- [ ] **Step 3: Implement** (`lib/trace/summary.js`)

```js
// One stored trace's summary, built span by span as lines are indexed. The root is the span that starts first
// (a request continued from a caller has a remote parent, so "no parent" is not enough). Tokens and cost come
// from chat spans only: agent and workflow spans repeat their children's totals.
const LIST_MAX = 20;

function blankSummary(traceId) {
  return {
    traceId,
    src: null,
    svc: null,
    root: null,
    rootStart: 0,
    start: 0,
    end: 0,
    spans: 0,
    errors: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUSD: 0,
    models: [],
    agents: [],
    tools: [],
    runId: null,
  };
}

const addTo = (list, v) => {
  if (v != null && v !== '' && !list.includes(String(v)) && list.length < LIST_MAX) list.push(String(v));
};

function addSpan(sum, sp) {
  sum.spans++;
  if (!sp.ok) sum.errors++;
  const end = sp.st + sp.d;
  if (!sum.start || sp.st < sum.start) sum.start = sp.st;
  if (end > sum.end) sum.end = end;
  if (!sum.root || sp.st < sum.rootStart || (sp.st === sum.rootStart && !sp.p)) {
    sum.root = sp.n;
    sum.rootStart = sp.st;
    sum.src = sp.src;
    sum.svc = sp.svc;
  }
  const a = sp.a || {};
  const op = a['gen_ai.operation.name'];
  if (op === 'chat') {
    sum.tokensIn += Number(a['gen_ai.usage.input_tokens']) || 0;
    sum.tokensOut += Number(a['gen_ai.usage.output_tokens']) || 0;
    sum.costUSD += Number(a['zaafpulse.cost.usd']) || 0;
    addTo(sum.models, a['gen_ai.request.model']);
  }
  if (op === 'execute_tool') sum.toolCalls++;
  addTo(sum.agents, a['gen_ai.agent.id']);
  addTo(sum.tools, a['gen_ai.tool.name']);
  if (a['zaafpulse.run.id'] && !sum.runId) sum.runId = String(a['zaafpulse.run.id']);
  return sum;
}

function summarize(traceId, spans) {
  const sum = blankSummary(traceId);
  for (const sp of spans) addSpan(sum, sp);
  return sum;
}

module.exports = { blankSummary, addSpan, summarize };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-summary.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/summary.js test/trace-summary.test.js
git commit -m "Add trace summaries for the local trace store"
```

### Task 2: Segment store with snapshot and retention

**Files:**
- Create: `lib/trace/store.js`, `test/trace-store.test.js`

**Interfaces:**
- Consumes: `blankSummary`, `addSpan` (Task 1).
- Produces: `createTraceStore({ dir, retentionDays = 14, maxBytes = 524288000, now = Date.now }) → { writeSpans(records) → number, getSpans(traceId) → record[] | null, getSummary(traceId) → summary | null, summaries() → summary[], byRun(runId) → summary | null, covered() → { from, to } | null (microseconds), snapshot(), applyRetention() → { deleted: string[] }, stats() → { traces, segments, bytes, skipped } }`. Summaries carry `ref: { "<YYYY-MM-DD>.ndjson": [startByte, endByte] }`.

- [ ] **Step 1: Write the failing test** (`test/trace-store.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTraceStore } = require('../lib/trace/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-trace-'));
const T1 = '1'.repeat(32);
const T2 = '2'.repeat(32);
const T3 = '3'.repeat(32);
const sp = (t, s, p = null, st = 1000, d = 10, a = {}) => ({ t, s, p, n: `op ${s.slice(0, 2)}`, k: 'internal', st, d, ok: true, src: 'gateway', svc: 'zaafpulse', a });
const NOON = () => Date.UTC(2026, 9, 22, 12);

test('store: appended spans read back by trace; summaries, runs and the covered window are kept', () => {
  const dir = tmp();
  const store = createTraceStore({ dir, now: NOON });
  store.writeSpans([
    sp(T1, 'a'.repeat(16), null, 1000, 50, { 'zaafpulse.run.id': 'run_1' }),
    sp(T2, 'b'.repeat(16), null, 5000, 10),
    sp(T1, 'c'.repeat(16), 'a'.repeat(16), 1005, 2),
  ]);
  assert.deepEqual(store.getSpans(T1).map((s) => s.s), ['a'.repeat(16), 'c'.repeat(16)]);
  assert.equal(store.getSpans(T2).length, 1);
  assert.equal(store.getSpans('9'.repeat(32)), null);
  assert.equal(store.summaries().length, 2);
  assert.equal(store.getSummary(T1).spans, 2);
  assert.equal(store.byRun('run_1').traceId, T1);
  assert.equal(store.byRun('run_2'), null);
  assert.deepEqual(store.covered(), { from: 1000, to: 5010 });
  const file = path.join(dir, '2026-10-22.ndjson');
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});

test('store: a new instance loads the snapshot and reads only what was appended after it', () => {
  const dir = tmp();
  const a = createTraceStore({ dir, now: NOON });
  a.writeSpans([sp(T1, 'a'.repeat(16))]);
  a.snapshot();
  a.writeSpans([sp(T2, 'b'.repeat(16))]);
  const b = createTraceStore({ dir, now: NOON });
  assert.equal(b.summaries().length, 2);
  assert.equal(b.getSummary(T1).spans, 1);
});

test('store: a line cut short by a crash is closed and skipped; later writes stay intact', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '2026-10-22.ndjson'), JSON.stringify(sp(T1, 'a'.repeat(16))) + '\n{"t":"cut');
  const store = createTraceStore({ dir, now: NOON });
  store.writeSpans([sp(T2, 'b'.repeat(16))]);
  assert.equal(store.getSpans(T1).length, 1);
  assert.equal(store.getSpans(T2).length, 1);
  assert.equal(store.stats().skipped, 1);
});

test('store: retention deletes whole segments by age, then by size, never today', () => {
  const dir = tmp();
  let t = Date.UTC(2026, 9, 1, 12);
  const store = createTraceStore({ dir, now: () => t });
  store.writeSpans([sp(T1, 'a'.repeat(16), null, 1000, 1, { 'zaafpulse.run.id': 'run_old' })]);
  t = Date.UTC(2026, 9, 10, 12);
  store.writeSpans([sp(T2, 'b'.repeat(16))]);
  t = Date.UTC(2026, 9, 22, 12);
  assert.deepEqual(store.applyRetention().deleted, ['2026-10-01.ndjson']);
  assert.equal(store.getSummary(T1), null);
  assert.equal(store.byRun('run_old'), null);
  assert.ok(store.getSummary(T2));

  const small = createTraceStore({ dir, now: () => t, maxBytes: 1 });
  small.writeSpans([sp(T3, 'c'.repeat(16))]);
  assert.deepEqual(small.applyRetention().deleted, ['2026-10-10.ndjson']);
  assert.ok(small.getSummary(T3));
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-store.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/store'`.

- [ ] **Step 3: Implement** (`lib/trace/store.js`)

```js
// Append-only trace storage, after Jaeger's Badger and memory backends: one NDJSON segment per UTC day, a trace
// index in memory (each trace's summary and the byte range it covers in each segment), and a snapshot of that
// index so a restart reads only what was appended since. Retention deletes whole segments, oldest first, never
// today's. Only the server process writes here.
const fs = require('fs');
const path = require('path');
const { blankSummary, addSpan } = require('./summary');

const SNAPSHOT = 'index.json';
const SNAPSHOT_VERSION = 1;
const SEGMENT = /^\d{4}-\d{2}-\d{2}\.ndjson$/;
const DAY_MS = 86400000;

function createTraceStore({ dir, retentionDays = 14, maxBytes = 500 * 1024 * 1024, now = Date.now }) {
  let traces = new Map(); // traceId -> summary with ref { segment: [start, end] }
  let offsets = {}; // segment -> bytes already indexed
  const runs = new Map(); // run id -> trace id
  let skipped = 0;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const segmentFor = (ms) => `${new Date(ms).toISOString().slice(0, 10)}.ndjson`;
  const segments = () => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => SEGMENT.test(f))
        .sort();
    } catch {
      return [];
    }
  };
  const sizeOf = (seg) => {
    try {
      return fs.statSync(path.join(dir, seg)).size;
    } catch {
      return 0;
    }
  };

  function index(span, segment, start, end) {
    let sum = traces.get(span.t);
    if (!sum) {
      sum = { ...blankSummary(span.t), ref: {} };
      traces.set(span.t, sum);
    }
    addSpan(sum, span);
    if (sum.runId) runs.set(sum.runId, sum.traceId);
    const r = sum.ref[segment];
    sum.ref[segment] = r ? [Math.min(r[0], start), Math.max(r[1], end)] : [start, end];
  }

  // Index the complete lines appended to a segment since `from`; returns the new offset. A last line without
  // its newline is left for later (it may still be in the middle of being written).
  function scan(segment, from) {
    const size = sizeOf(segment);
    if (size <= from) return from;
    const fd = fs.openSync(path.join(dir, segment), 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      let pos = 0;
      for (;;) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        try {
          const sp = JSON.parse(buf.toString('utf8', pos, nl));
          if (sp && typeof sp.t === 'string' && typeof sp.s === 'string') index(sp, segment, from + pos, from + nl + 1);
          else if (nl > pos) skipped++;
        } catch {
          skipped++;
        }
        pos = nl + 1;
      }
      return from + pos;
    } finally {
      fs.closeSync(fd);
    }
  }

  function forget(segment) {
    delete offsets[segment];
    for (const [id, sum] of traces) {
      if (!sum.ref[segment]) continue;
      delete sum.ref[segment];
      if (Object.keys(sum.ref).length) continue;
      traces.delete(id);
      if (sum.runId && runs.get(sum.runId) === id) runs.delete(sum.runId);
    }
  }

  function catchUp() {
    const present = new Set(segments());
    for (const seg of Object.keys(offsets)) if (!present.has(seg)) forget(seg);
    for (const seg of present) offsets[seg] = scan(seg, offsets[seg] || 0);
  }

  // A line cut short by a crash is closed, so the next append does not join it.
  function repairTails() {
    for (const seg of segments())
      if ((offsets[seg] || 0) < sizeOf(seg)) {
        fs.appendFileSync(path.join(dir, seg), '\n');
        offsets[seg] = scan(seg, offsets[seg] || 0);
      }
  }

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT), 'utf8'));
      if (j.version !== SNAPSHOT_VERSION) return;
      traces = new Map(j.traces.map((s) => [s.traceId, s]));
      offsets = j.offsets || {};
      for (const s of traces.values()) if (s.runId) runs.set(s.runId, s.traceId);
    } catch {
      /* no snapshot yet: catchUp reads every segment */
    }
  }

  function snapshot() {
    const tmp = path.join(dir, `${SNAPSHOT}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ version: SNAPSHOT_VERSION, offsets, traces: [...traces.values()] }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, path.join(dir, SNAPSHOT));
  }

  function writeSpans(spans) {
    if (!spans.length) return 0;
    const seg = segmentFor(now());
    fs.appendFileSync(path.join(dir, seg), spans.map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
    offsets[seg] = scan(seg, offsets[seg] || 0);
    return spans.length;
  }

  function getSpans(traceId) {
    const sum = traces.get(traceId);
    if (!sum) return null;
    const out = [];
    for (const [seg, [start, end]] of Object.entries(sum.ref)) {
      let fd;
      try {
        fd = fs.openSync(path.join(dir, seg), 'r');
      } catch {
        continue;
      }
      try {
        const buf = Buffer.alloc(end - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        for (const line of buf.toString('utf8').split('\n')) {
          if (!line.includes(traceId)) continue;
          try {
            const sp = JSON.parse(line);
            if (sp.t === traceId) out.push(sp);
          } catch {
            /* counted when indexed */
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    return out;
  }

  // The time the store covers, so the gateway adapter can tell which older request rows it already holds.
  function covered() {
    let from = Infinity;
    let to = -Infinity;
    for (const s of traces.values()) {
      if (s.start < from) from = s.start;
      if (s.end > to) to = s.end;
    }
    return Number.isFinite(from) ? { from, to } : null;
  }

  function applyRetention() {
    const today = segmentFor(now());
    const cutoff = segmentFor(now() - retentionDays * DAY_MS);
    const list = segments();
    let total = list.reduce((n, s) => n + sizeOf(s), 0);
    const deleted = [];
    for (const seg of list) {
      if (seg === today) break;
      if (seg >= cutoff && total <= maxBytes) break;
      total -= sizeOf(seg);
      fs.unlinkSync(path.join(dir, seg));
      forget(seg);
      deleted.push(seg);
    }
    if (deleted.length) snapshot();
    return { deleted };
  }

  load();
  catchUp();
  repairTails();

  return {
    writeSpans,
    getSpans,
    getSummary: (traceId) => traces.get(traceId) || null,
    summaries: () => [...traces.values()],
    byRun: (runId) => (runs.has(runId) ? traces.get(runs.get(runId)) || null : null),
    covered,
    snapshot,
    applyRetention,
    stats: () => {
      const list = segments();
      return { traces: traces.size, segments: list.length, bytes: list.reduce((n, s) => n + sizeOf(s), 0), skipped };
    },
  };
}

module.exports = { createTraceStore };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-store.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/store.js test/trace-store.test.js
git commit -m "Add the append-only trace store with snapshot and retention"
```

### Task 3: Recorder (OTel spans → stored records)

**Files:**
- Create: `lib/trace/recorder.js`, `test/trace-recorder.test.js`

**Interfaces:**
- Consumes: a store's `writeSpans` (Task 2); OTel span records (Shared interfaces).
- Produces: `toRecord(otelRecord) → record`; `CONTENT_KEYS`; `createRecorder({ store, enabled = () => true, flushMs = 1000, batch = 500, maxBuffer = 10000, knownMs = 86400000, log = console.error, now = Date.now }) → { enabled(), add(otelRecord), ingest(records) → number, flush() → number, knows(traceId) → boolean, stats() → { buffered, written, dropped, writeErrors } }`. `add` is the sink `lib/otel.js` calls (Task 4).

- [ ] **Step 1: Write the failing test** (`test/trace-recorder.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecorder, toRecord } = require('../lib/trace/recorder');

const T = '4bf92f3577b34da6a3ce929d0e0e4736';
const otelRec = (extra = {}) => ({
  traceId: T,
  spanId: '00f067aa0ba902b7',
  parentSpanId: '',
  name: 'chat m',
  kind: 3,
  startNs: 1792642201123456789n,
  endNs: 1792642201223456789n,
  attributes: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.input.messages': '[{"role":"user"}]',
    'gen_ai.output.messages': '[]',
    'gen_ai.system_instructions': '[]',
    'gen_ai.tool.call.arguments': '{}',
    'gen_ai.tool.call.result': 'x',
    'zaafpulse.cost.usd': 0.01,
  },
  status: { code: 0, message: '' },
  ...extra,
});
const memStore = () => {
  const spans = [];
  return { spans, writeSpans: (l) => (spans.push(...l), l.length) };
};

test('recorder: an OTel span becomes a record in microseconds, without content attributes', () => {
  const r = toRecord(otelRec());
  assert.deepEqual(r, {
    t: T,
    s: '00f067aa0ba902b7',
    p: null,
    n: 'chat m',
    k: 'client',
    st: 1792642201123456,
    d: 100000,
    ok: true,
    src: 'gateway',
    svc: 'zaafpulse',
    a: { 'gen_ai.operation.name': 'chat', 'zaafpulse.cost.usd': 0.01 },
  });
  const failed = toRecord(otelRec({ parentSpanId: 'b7ad6b7169203331', status: { code: 2, message: 'x'.repeat(500) } }));
  assert.equal(failed.ok, false);
  assert.equal(failed.err.length, 200);
  assert.equal(failed.p, 'b7ad6b7169203331');
});

test('recorder: buffers until flush, writes in one batch, and knows the trace IDs it saw', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  rec.add(otelRec());
  assert.equal(store.spans.length, 0);
  assert.equal(rec.flush(), 1);
  assert.equal(store.spans.length, 1);
  assert.equal(rec.knows(T), true);
  assert.equal(rec.knows('f'.repeat(32)), false);
  assert.deepEqual(rec.stats(), { buffered: 0, written: 1, dropped: 0, writeErrors: 0 });
});

test('recorder: off means nothing is kept; a full buffer drops and counts; a failed write never throws', () => {
  let on = false;
  const store = memStore();
  const rec = createRecorder({ store, enabled: () => on, flushMs: 0, batch: 100, maxBuffer: 2 });
  rec.add(otelRec());
  assert.equal(rec.stats().buffered, 0);
  on = true;
  rec.add(otelRec());
  rec.add(otelRec());
  rec.add(otelRec());
  assert.equal(rec.stats().dropped, 1);
  const broken = createRecorder({
    store: {
      writeSpans: () => {
        throw new Error('disk full');
      },
    },
    flushMs: 0,
    log: () => {},
  });
  broken.add(otelRec());
  assert.equal(broken.flush(), 0);
  assert.equal(broken.stats().writeErrors, 1);
});

test('recorder: a full batch is written at once; known trace IDs expire', () => {
  let t = 0;
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0, batch: 2, knownMs: 1000, now: () => t });
  rec.add(otelRec());
  rec.add(otelRec());
  assert.equal(store.spans.length, 2);
  t = 2000;
  assert.equal(rec.knows(T), false);
});

test('recorder: ingest takes ready records from the return channel', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  const r = { t: T, s: '1'.repeat(16), p: null, n: 'x', k: 'server', st: 1, d: 1, ok: true, src: 'remote', svc: 'far', a: {} };
  assert.equal(rec.ingest([r]), 1);
  rec.flush();
  assert.deepEqual(store.spans, [r]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-recorder.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/recorder'`.

- [ ] **Step 3: Implement** (`lib/trace/recorder.js`)

```js
// The local sink of lib/otel.js: every finished span becomes a compact record (microseconds, no content) and
// waits in a bounded buffer until it is written to the trace store, once a second or every `batch` spans. It
// also remembers which trace IDs it saw, so the return channel accepts spans for those traces only. Nothing here
// may throw into a request or a run.
const KIND = { 1: 'internal', 2: 'server', 3: 'client' };
// Prompt, reply and tool text that OTLP export may carry with captureContent; the store never keeps it.
const CONTENT_KEYS = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]);

function toRecord(r) {
  const a = {};
  for (const [k, v] of Object.entries(r.attributes || {})) if (!CONTENT_KEYS.has(k)) a[k] = v;
  const st = Number(r.startNs / 1000n);
  const failed = r.status && r.status.code === 2;
  return {
    t: r.traceId,
    s: r.spanId,
    p: r.parentSpanId || null,
    n: r.name,
    k: KIND[r.kind] || 'internal',
    st,
    d: Math.max(0, Number(r.endNs / 1000n) - st),
    ok: !failed,
    ...(failed ? { err: String(r.status.message || 'error').slice(0, 200) } : {}),
    src: 'gateway',
    svc: 'zaafpulse',
    a,
  };
}

function createRecorder({
  store,
  enabled = () => true,
  flushMs = 1000,
  batch = 500,
  maxBuffer = 10000,
  knownMs = 86400000,
  log = console.error,
  now = Date.now,
}) {
  let buf = [];
  let timer = null;
  let lastLog = -Infinity;
  const seen = new Map(); // trace id -> last time seen; oldest first
  const stats = { written: 0, dropped: 0, writeErrors: 0 };

  const on = () => {
    try {
      return !!enabled();
    } catch {
      return false;
    }
  };
  function remember(t) {
    seen.delete(t);
    seen.set(t, now());
    if (seen.size > 100000) for (const [id, at] of seen) if (now() - at > knownMs || seen.size > 100000) seen.delete(id);
  }
  function push(records) {
    let n = 0;
    for (const r of records) {
      if (buf.length >= maxBuffer) {
        stats.dropped++;
        continue;
      }
      buf.push(r);
      n++;
    }
    if (buf.length >= batch) flush();
    else if (flushMs > 0 && buf.length && !timer) {
      timer = setTimeout(flush, flushMs);
      if (timer.unref) timer.unref();
    }
    return n;
  }
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!buf.length) return 0;
    const list = buf;
    buf = [];
    try {
      const n = store.writeSpans(list);
      stats.written += n;
      return n;
    } catch (err) {
      stats.writeErrors++;
      if (now() - lastLog > 60000) {
        lastLog = now();
        try {
          log(`traces: write failed: ${err.message}`);
        } catch {
          /* logging must not fail a request */
        }
      }
      return 0;
    }
  }

  return {
    enabled: on,
    add(rec) {
      try {
        if (!on()) return;
        remember(rec.traceId);
        push([toRecord(rec)]);
      } catch {
        /* a span that cannot be converted is not kept */
      }
    },
    ingest: (records) => (on() ? push(records) : 0),
    flush,
    knows(t) {
      const at = seen.get(t);
      return at !== undefined && now() - at <= knownMs;
    },
    stats: () => ({ buffered: buf.length, ...stats }),
  };
}

module.exports = { createRecorder, toRecord, CONTENT_KEYS };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-recorder.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/recorder.js test/trace-recorder.test.js
git commit -m "Add the trace recorder: content-free span records in a bounded buffer"
```

### Task 4: The local sink in `lib/otel.js`, and the server wiring

**Files:**
- Modify: `lib/otel.js`, `server.js`, `config.example.json`
- Create: `test/trace-sink.test.js`

**Interfaces:**
- Consumes: `createTraceStore` (Task 2), `createRecorder` (Task 3).
- Produces: `createOtel({ ..., sink })` where `sink = { enabled() → boolean, add(otelRecord) }`; instance method `live() → boolean` (export on or sink enabled); module function `otel.live()`. In `server.js`: `traceStore`, `recorder` (used by Tasks 9, 10 and 14).

- [ ] **Step 1: Write the failing test** (`test/trace-sink.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const otel = require('../lib/otel');

function setup(on = () => true) {
  const got = [];
  const o = otel.createOtel({
    getConfig: () => ({}),
    env: {},
    refreshMs: 0,
    log: () => {},
    sink: { enabled: on, add: (r) => got.push(r) },
  });
  return { o, got };
}
const usage = (extra = {}) => ({ ts: Date.now(), ms: 5, model: 'm', provider: 'p', status: 200, kind: 'chat', input: 3, output: 2, cost: 0.01, ...extra });

test('sink: spans reach the local sink while OTLP export is off', () => {
  const { o, got } = setup();
  assert.equal(o.status().enabled, false);
  assert.equal(o.live(), true);
  o.startSpan('x').end();
  o.onUsage(usage());
  o.toolCall('t', { id: 'f', type: 'http' }, { a: 1 }).end(true, { content: [{ type: 'text', text: 'result' }] });
  assert.deepEqual(got.map((r) => r.name), ['x', 'chat m', 'execute_tool t']);
  const tool = got[2];
  assert.equal(tool.attributes['gen_ai.tool.call.arguments'], undefined);
  assert.equal(tool.attributes['gen_ai.tool.call.result'], undefined);
});

test('sink: a disabled sink and no export means no spans at all', () => {
  const { o, got } = setup(() => false);
  assert.equal(o.live(), false);
  o.onUsage(usage());
  o.toolCall('t', { id: 'f', type: 'http' }, {}).end(true, { content: [] });
  assert.equal(got.length, 0);
});

test('sink: a gateway request is traced for the sink, continues traceparent, and copies no body', async () => {
  const { o, got } = setup();
  let iterWrapped = null;
  const server = http.createServer(
    o.wrapHandler(async (req, res) => {
      iterWrapped = Object.hasOwn(req, Symbol.asyncIterator);
      for await (const _ of req); // the gateway reads the body this way
      o.onUsage(usage());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }));
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceparent: parent },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'secret prompt' }] }),
    });
    await r.text();
    await new Promise((res) => setTimeout(res, 20));
    const serverSpan = got.find((s) => s.kind === 2);
    const chat = got.find((s) => s.name === 'chat m');
    assert.equal(serverSpan.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(serverSpan.parentSpanId, '00f067aa0ba902b7');
    assert.equal(chat.parentSpanId, serverSpan.spanId);
    assert.equal(chat.attributes['gen_ai.response.id'], 'chatcmpl-1');
    assert.equal(iterWrapped, false, 'the request body is not copied when export is off');
    assert.ok(!JSON.stringify(got, (k, v) => (typeof v === 'bigint' ? String(v) : v)).includes('secret prompt'));
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-sink.test.js`
Expected: FAIL: `o.live is not a function`, and no spans reach `got` (every hook returns early while export is off).

- [ ] **Step 3: Add the sink to `createOtel`** (`lib/otel.js`)

In the parameter list of `function createOtel({`, add `sink = null,` after the line `  refreshMs = 2000,`.

Directly after the line `  const known = new Set();` (inside `createOtel`), add:

```js
  // The local trace store (lib/trace/recorder.js): spans are produced when export is on or the sink is.
  const sinkOn = () => {
    try {
      return !!sink && !!sink.enabled();
    } catch {
      return false;
    }
  };
  const live = (s) => !!(s && s.enabled) || sinkOn();
  // With export off nothing is ever sent, so nothing of a request or reply is copied for content.
  const LOCAL = { enabled: false, captureContent: false, contentMaxChars: 4096 };
```

Replace the whole `record` function:

```js
  function record(rec) {
    current(); // a span started directly (not through a hook) still picks up the current settings
    if (exporter) exporter.add(rec);
    if (sinkOn())
      try {
        sink.add(rec);
      } catch {
        /* the local store must not break a request */
      }
  }
```

In `wrapHandler`, replace

```js
      if (!s.enabled || !traced(String(req.url || '').split('?')[0])) return handler.call(this, req, res);
      let ctx;
      try {
        ctx = requestContext(req, res, s);
```

with

```js
      if (!live(s) || !traced(String(req.url || '').split('?')[0])) return handler.call(this, req, res);
      let ctx;
      try {
        ctx = requestContext(req, res, s.enabled ? s : LOCAL);
```

In `onUsage`, replace `      if (!current().enabled || !e) return;` with `      if (!live(current()) || !e) return;`.

In `exportRun`, replace `      if (!s.enabled || !run || !Array.isArray(run.trace) || !run.trace.length) return;` with `      if (!live(s) || !run || !Array.isArray(run.trace) || !run.trace.length) return;`.

In `toolCall`, replace `      if (!s.enabled) return NOOP;` with `      if (!live(s)) return NOOP;`.

Replace the instance's return line

```js
  return { wrapHandler, exportRun, toolCall, startSpan, onUsage, status, flush, shutdown, active, current };
```

with

```js
  return {
    wrapHandler,
    exportRun,
    toolCall,
    startSpan,
    onUsage,
    status,
    flush,
    shutdown,
    active,
    current,
    live: () => live(current()),
  };
```

In `module.exports`, after the line `  get,` add:

```js
  live: () => !!instance && instance.live(),
```

- [ ] **Step 4: Run the new test and the OTel suite**

Run: `node --test test/trace-sink.test.js test/otel.test.js`
Expected: PASS. (The existing "export off sends nothing" test still passes: it gives no sink.)

- [ ] **Step 5: Wire the store into the server** (`server.js`)

Add next to the other `require('./lib/…')` lines at the top:

```js
const { createTraceStore } = require('./lib/trace/store');
const { createRecorder } = require('./lib/trace/recorder');
```

Replace the two lines

```js
// OpenTelemetry trace export: off unless config.json has "otel": { "enabled": true } (see docs/otel.md).
otel.init({ getConfig: rawConfig, secrets: createSecrets(), version: require('./package.json').version });
```

with

```js
// Local trace store: every gateway trace without content, under .data/traces (on unless "tracing": { "enabled":
// false }). Retention is read at start; the on/off switch whenever config.json changes.
const tracingCfg = () => (rawConfig() || {}).tracing || {};
const traceStore = createTraceStore({
  dir: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'traces'),
  retentionDays: Number(tracingCfg().retentionDays) > 0 ? Number(tracingCfg().retentionDays) : 14,
  maxBytes: Number(tracingCfg().maxBytes) > 0 ? Number(tracingCfg().maxBytes) : 500 * 1024 * 1024,
});
const recorder = createRecorder({ store: traceStore, enabled: () => tracingCfg().enabled !== false });
// OpenTelemetry trace export: off unless config.json has "otel": { "enabled": true } (see docs/otel.md). The local
// store is its second sink.
otel.init({
  getConfig: rawConfig,
  secrets: createSecrets(),
  version: require('./package.json').version,
  sink: recorder,
});
```

In the `server.listen(PORT, HOST, () => {` callback, directly after the line `  setInterval(syncPrices, 3600 * 1000).unref();` add:

```js
  // Trace store: snapshot the index and apply retention now and every 5 minutes.
  const keepTraces = () => {
    try {
      recorder.flush();
      traceStore.applyRetention();
      traceStore.snapshot();
    } catch (err) {
      console.error('traces:', err.message);
    }
  };
  keepTraces();
  setInterval(keepTraces, 5 * 60 * 1000).unref();
```

In the signal handler, replace

```js
      evalEngine.stop(); // a running judge call is cancelled, and its working folder removed
      gateway.flush();
```

with

```js
      evalEngine.stop(); // a running judge call is cancelled, and its working folder removed
      gateway.flush();
      recorder.flush();
      traceStore.snapshot();
```

- [ ] **Step 6: Document the setting** (`config.example.json`)

After the closing `},` of the `"otel"` block add:

```json
  "tracing": {
    "enabled": true,
    "retentionDays": 14,
    "maxBytes": 524288000
  },
```

- [ ] **Step 7: Check it by hand**

Run: `ZAAFPULSE_DATA=$(mktemp -d) node server.js` and stop it with Ctrl-C after it prints its address.
Expected: the printed data folder holds `.data/traces/index.json` (an empty index, mode `0600`), and the server starts and stops without a `traces:` error.

- [ ] **Step 8: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add lib/otel.js server.js config.example.json test/trace-sink.test.js
git commit -m "Keep every gateway trace in a local store, next to OTLP export"
```

---

# Phase 2: Complete trees

Result of the phase: a model call's `chat` span sits under the agent (or step) that made it, a collaboration run keeps one trace ID from start to export (also across a pause and resume), its export is no longer cut at 800 spans, and a standalone agent run has `invoke_agent` and `execute_tool` spans like a run does.

### Task 5: Run trace context and model calls in place

**Files:**
- Modify: `lib/otel.js`, `lib/gateway/collab.js`, `test/otel.test.js`, `test/trace-sink.test.js`

**Interfaces:**
- Consumes: `live` (Task 4).
- Produces (instance and module): `within(parent, fn, chatSpanId = null) → fn()`; `runContext(runId) → { traceId, spanId, sampled }`; module `runSpanId(runId, spanId) → 16 hex` (the exported id of a run span); `exportRun(run, spans?)` (exports `spans` when given, else the last execution in `run.trace`). In `collab.js`: `run.otel`, `rt.spans`, `rt.traceCtx(id)`, `rt.within(id, fn)` (the span book interface, see Shared interfaces).

- [ ] **Step 1: Write the failing tests**

Append to `test/trace-sink.test.js`:

```js
test('sink: within() parents the spans started inside it; the first successful model call takes the given id', () => {
  const { o, got } = setup();
  const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };
  o.within(parent, () => {
    o.onUsage(usage({ status: 500, error: 'upstream' }));
    o.onUsage(usage());
    o.onUsage(usage());
  }, 'c'.repeat(16));
  assert.equal(got.length, 3);
  for (const r of got) {
    assert.equal(r.traceId, 'a'.repeat(32));
    assert.equal(r.parentSpanId, 'b'.repeat(16));
  }
  assert.notEqual(got[0].spanId, 'c'.repeat(16), 'a failed attempt keeps a random id');
  assert.equal(got[1].spanId, 'c'.repeat(16));
  assert.notEqual(got[2].spanId, 'c'.repeat(16), 'the id is used once');
});

test('sink: a run exported with its fixed trace context and an explicit span list', () => {
  const { o, got } = setup();
  const T0 = Date.now() - 1000;
  const spans = [
    { id: 'r0', parent: null, name: 'invoke_workflow auto', start: 0, end: 900, status: 'ok', attrs: { 'zp.pattern': 'auto' } },
    { id: 'r1', parent: 'r0', name: 'invoke_agent a', start: 10, end: 800, status: 'ok', attrs: { 'zp.agent': 'a', 'zp.cost_usd': 0.5 } },
  ];
  o.exportRun({ id: 'run_9', pattern: 'auto', state: 'completed', createdAt: T0, updatedAt: T0 + 900, otel: { traceId: 'd'.repeat(32), spanId: 'e'.repeat(16), sampled: true }, trace: [] }, spans);
  const [root, agent] = got;
  assert.equal(root.traceId, 'd'.repeat(32));
  assert.equal(root.parentSpanId, 'e'.repeat(16));
  assert.equal(root.spanId, otel.runSpanId('run_9', 'r0'));
  assert.equal(agent.parentSpanId, root.spanId);
  assert.equal(agent.attributes['gen_ai.agent.id'], 'a');
  assert.equal(agent.attributes['zaafpulse.cost.usd'], 0.5);
  // Outside a request, a run gets a stable trace of its own and no parent.
  const own = o.runContext('run_9');
  assert.match(own.traceId, /^[0-9a-f]{32}$/);
  assert.deepEqual(o.runContext('run_9'), { traceId: own.traceId, spanId: '', sampled: true });
});
```

Then, in `test/otel.test.js`, give `gatewaySetup` a sink: replace `async function gatewaySetup(upstreamHandler, otelCfg) {` with `async function gatewaySetup(upstreamHandler, otelCfg, sink = null) {`, and in its `otel.init({ … })` call add `sink,` after `version: '1.0.3',` (so the call reads `otel.init({ getConfig: () => config, secrets: secretsFor(), env: {}, refreshMs: 0, log: () => {}, version: '1.0.3', sink })`). Append:

```js
test('otel: a collaboration run keeps one trace, and its model calls sit under the agent that made them', async () => {
  const got = [];
  let n = 0;
  const t = await gatewaySetup(
    () => {
      n++;
      return n === 1
        ? {
            body: completion(null, {
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 't1',
                        type: 'function',
                        function: { name: 'zp_handoff', arguments: '{"agent":"hr-finance","note":"over limit"}' },
                      },
                    ],
                  },
                },
              ],
            }),
          }
        : { body: completion('Finance approves the refund.') };
    },
    { enabled: false },
    { enabled: () => true, add: (r) => got.push(r) },
  );
  try {
    const r = await t.call('/v1/collaborate', { pattern: 'handoff', agent: 'customer-service', task: 'I want a refund' });
    assert.equal(r.status, 200, r.text);
    await sleep(30);
    const server = got.find((s) => s.kind === 2);
    const root = got.find((s) => s.name === 'invoke_workflow handoff');
    const runId = root.attributes['zaafpulse.run.id'];
    const run = t.gateway.trace.run(runId);
    assert.deepEqual(run.otel, { traceId: server.traceId, spanId: server.spanId, sampled: true });
    for (const s of got) assert.equal(s.traceId, server.traceId, s.name);
    const agents = new Set(got.filter((s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent').map((s) => s.spanId));
    const rtChats = new Set(run.trace.filter((s) => /^chat /.test(s.name)).map((s) => otel.runSpanId(runId, s.id)));
    const chats = got.filter((s) => s.name === 'chat fake/m');
    assert.equal(chats.length, n);
    for (const ch of chats) {
      assert.ok(agents.has(ch.parentSpanId), 'a model call sits under its agent');
      assert.ok(rtChats.has(ch.spanId), "it takes the run's own chat span id");
    }
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/trace-sink.test.js test/otel.test.js`
Expected: FAIL: `o.within is not a function`, `otel.runSpanId is not a function`, `run.otel` undefined, chat spans parented to the request span.

- [ ] **Step 3: Implement in `lib/otel.js`**

Above `function createOtel({`, add:

```js
// A run's own attribute names (zp.*) as exported: cost and agent have semconv or zaafpulse names.
function runAttrs(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'zp.cost_usd') out['zaafpulse.cost.usd'] = Number(v) || 0;
    else if (k === 'zp.agent') out['gen_ai.agent.id'] = v;
    else if (k.startsWith('zp.')) out[`zaafpulse.${k.slice(3)}`] = v;
    else out[k] = v;
  }
  return out;
}
// The exported id of a collaboration run's span: parents and children agree without any shared state.
const runSpanId = (runId, spanId) => hashId(`${runId}:${spanId}`, 8);
```

In `onUsage`, replace

```js
      const end = Number(e.ts) || now();
      const span = startSpan(`${op} ${e.model}`, {
        kind: KIND.CLIENT,
        startNs: msToNs(end - (Number(e.ms) || 0)),
```

with

```js
      const end = Number(e.ts) || now();
      // Inside within(…, chatSpanId): the first successful call takes the id the caller reserved for it.
      const reserved = ctx && ctx.chatSpanId && !(e.status >= 400 || e.error) ? ctx.chatSpanId : null;
      if (reserved) ctx.chatSpanId = null;
      const span = startSpan(`${op} ${e.model}`, {
        kind: KIND.CLIENT,
        ...(reserved ? { spanId: reserved } : {}),
        startNs: msToNs(end - (Number(e.ms) || 0)),
```

Replace the whole `exportRun` function with:

```js
  /* collaboration runs: the run's own trace, converted when it ends */
  // `list`: this execution's spans in full (collab keeps them apart from run.trace, which the live view caps).
  function exportRun(run, list) {
    try {
      const s = current();
      if (!live(s) || !run) return;
      let spans = Array.isArray(list) ? list : null;
      if (!spans) {
        if (!Array.isArray(run.trace) || !run.trace.length) return;
        // A resumed run appends a new root each time it runs: send only this execution's spans.
        let from = run.trace.length - 1;
        while (from > 0 && !(run.trace[from].parent == null && /^invoke_workflow/.test(run.trace[from].name))) from--;
        spans = run.trace.slice(from);
      }
      if (!spans.length) return;
      const ctx = als.getStore();
      const fixed = run.otel && run.otel.traceId ? run.otel : null;
      if (fixed ? fixed.sampled === false : ctx && !ctx.self.sampled) return;
      if (ctx) ctx.child();
      // A run started by a request sits in that request's trace for good (run.otel); older runs as before.
      const traceId = fixed ? fixed.traceId : ctx ? ctx.self.traceId : hashId(`zaafpulse-run:${run.id}`, 16);
      const rootParent = fixed ? fixed.spanId || '' : ctx ? ctx.self.spanId : '';
      const traceState = !fixed && ctx ? ctx.self.traceState : '';
      const t0 = Number(run.createdAt) || now();
      const lastEnd = (Number(run.updatedAt) || now()) - t0;
      for (const sp of spans) {
        // Model calls already have their own span from the gateway, with provider and cache details.
        if (/^chat /.test(sp.name)) continue;
        const attrs = runAttrs(sp.attrs);
        let name = sp.name;
        if (attrs['gen_ai.operation.name'] === 'invoke_agent')
          name = `invoke_agent ${attrs['gen_ai.agent.name'] || attrs['gen_ai.agent.id'] || ''}`.trim();
        if (attrs['gen_ai.operation.name'] === 'execute_tool') attrs['gen_ai.tool.type'] = 'function';
        const root = sp.parent == null;
        if (root) {
          Object.assign(attrs, {
            'gen_ai.workflow.name': run.pattern,
            'zaafpulse.run.id': run.id,
            'zaafpulse.run.state': run.state,
            'zaafpulse.api_key.id': run.keyId || 'dashboard',
            ...(run.contextId ? { 'gen_ai.conversation.id': run.contextId } : {}),
          });
          if (s.captureContent) {
            attrs['gen_ai.input.messages'] = JSON.stringify(
              capParts([{ role: 'user', parts: [textPart(run.task || '')] }], s.contentMaxChars),
            );
            if (run.answer)
              attrs['gen_ai.output.messages'] = JSON.stringify(
                capParts(
                  [{ role: 'assistant', parts: [textPart(run.answer)], finish_reason: 'stop' }],
                  s.contentMaxChars,
                ),
              );
          }
        }
        const span = startSpan(name, {
          kind: KIND.INTERNAL,
          parent: { traceId, spanId: root ? rootParent : runSpanId(run.id, sp.parent), sampled: true, traceState },
          spanId: runSpanId(run.id, sp.id),
          startNs: msToNs(t0 + (Number(sp.start) || 0)),
          attributes: attrs,
        });
        if (sp.status === 'error') span.fail('_OTHER', sp.error || 'error');
        span.end(msToNs(t0 + (sp.end != null ? Number(sp.end) : lastEnd)));
      }
    } catch {
      /* telemetry must not break the run */
    }
  }

  // Runs fn with `parent` ({ traceId, spanId, sampled }) as the current span, so spans started inside it (model
  // calls, integration tools) nest under it. `chatSpanId` reserves an id for the first successful model call.
  function within(parent, fn, chatSpanId = null) {
    if (!parent || !parent.traceId || !live(current())) return fn();
    const outer = als.getStore();
    const ctx = {
      self: {
        traceId: parent.traceId,
        spanId: parent.spanId || '',
        sampled: parent.sampled !== false,
        traceState: parent.traceState || '',
      },
      parent: null,
      format: null, // model calls inside end at once; the request's reply details stay with the request
      pending: [],
      finished: true,
      children: 0,
      server: null,
      chatSpanId,
      child() {
        if (outer) outer.child();
      },
    };
    return als.run(ctx, fn);
  }

  // A collaboration run's trace context, fixed when it starts: the request's span when there is one, else a
  // stable trace of its own. Kept in runs.json, so a resumed run and its model calls stay in one trace.
  function runContext(runId) {
    const ctx = als.getStore();
    return ctx
      ? { traceId: ctx.self.traceId, spanId: ctx.self.spanId, sampled: ctx.self.sampled !== false }
      : { traceId: hashId(`zaafpulse-run:${runId}`, 16), spanId: '', sampled: true };
  }
```

In the instance's return object, add `within,` and `runContext,` after `live: () => live(current()),`.

In `module.exports`, replace `  exportRun: (run) => instance && instance.exportRun(run),` with:

```js
  exportRun: (run, spans) => instance && instance.exportRun(run, spans),
  within: (parent, fn, chatSpanId) => (instance ? instance.within(parent, fn, chatSpanId) : fn()),
  runContext: (runId) =>
    instance ? instance.runContext(runId) : { traceId: hashId(`zaafpulse-run:${runId}`, 16), spanId: '', sampled: true },
  runSpanId,
```

- [ ] **Step 4: Implement in `lib/gateway/collab.js`**

After the line `const { firstJson, quote, MAX_DEPTH } = require('./orchestrator');` add:

```js
const otel = require('../otel');
```

In `start`, replace

```js
    const t = now();
    const run = {
      id: `run_${crypto.randomBytes(8).toString('hex')}`,
```

with

```js
    const t = now();
    const id = `run_${crypto.randomBytes(8).toString('hex')}`;
    const run = {
      id,
      // The trace this run belongs to, for good: its spans and model calls are exported into it.
      otel: otel.runContext(id),
```

In `runtime`, replace

```js
    rt.span = (name, attrs = {}, parent = null) => {
```

with

```js
    rt.spans = []; // every span of this execution, for the export; run.trace keeps 800 for the live view
    // The span book interface the orchestrator also gets outside runs (otel.spanBook): the OTel context of one
    // of this run's spans, and code run under it.
    if (!run.otel) run.otel = otel.runContext(run.id); // a run from before run.otel existed
    rt.traceCtx = (id) => ({
      traceId: run.otel.traceId,
      spanId: id ? otel.runSpanId(run.id, id) : run.otel.spanId || '',
      sampled: run.otel.sampled !== false,
    });
    rt.within = (id, fn) => otel.within(rt.traceCtx(id), fn);
    rt.span = (name, attrs = {}, parent = null) => {
```

Replace

```js
      if (run.trace.length < 800) run.trace.push(sp);
```

with

```js
      if (run.trace.length < 800) run.trace.push(sp);
      if (rt.spans.length < 20000) rt.spans.push(sp);
```

In `rt.llm`, replace

```js
        const r = await llm({ ...args, runId: run.id });
```

with

```js
        // The gateway's chat span for this call takes the place (and id) of this span in the exported tree.
        const r = await otel.within(
          rt.traceCtx(args.span),
          () => llm({ ...args, runId: run.id }),
          otel.runSpanId(run.id, sp.id),
        );
```

In `execute`, replace

```js
      require('../otel').exportRun(run);
```

with

```js
      otel.exportRun(run, rt.spans);
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/trace-sink.test.js test/otel.test.js test/collab.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/otel.js lib/gateway/collab.js test/otel.test.js test/trace-sink.test.js
git commit -m "Keep a run in one trace and put its model calls under their agents"
```

### Task 6: Spans for standalone agent runs

**Files:**
- Modify: `lib/otel.js`, `lib/gateway/orchestrator.js`, `test/trace-sink.test.js`, `test/otel.test.js`

**Interfaces:**
- Consumes: `within`, `runAttrs` (Task 5).
- Produces: instance and module `spanBook() → book | null` (the span book interface; `null` while nothing records spans). The orchestrator uses `ctx.run || ctx.tracer` everywhere it traced `ctx.run` before.

- [ ] **Step 1: Write the failing tests**

Append to `test/trace-sink.test.js`:

```js
test('sink: a span book nests agent, tool and model spans like a run does', () => {
  const { o, got } = setup();
  const book = o.spanBook();
  const agent = book.span('invoke_agent a', { 'gen_ai.operation.name': 'invoke_agent', 'zp.agent': 'a' });
  const tool = book.span('execute_tool t', { 'gen_ai.operation.name': 'execute_tool' }, agent.id);
  book.within(tool.id, () => o.toolCall('mcp_x', { id: 'm', type: 'mcp' }, {}).end(true, { content: [] }));
  tool.end({}, new Error('boom'));
  book.within(agent.id, () => o.onUsage(usage()));
  agent.end({ 'zp.cost_usd': 0.01 });
  const by = (n) => got.find((r) => r.name === n);
  assert.equal(by('execute_tool t').parentSpanId, agent.id);
  assert.equal(by('execute_tool t').status.code, 2);
  assert.equal(by('execute_tool mcp_x').parentSpanId, tool.id);
  assert.equal(by('chat m').parentSpanId, agent.id);
  assert.equal(by('invoke_agent a').attributes['gen_ai.agent.id'], 'a');
  assert.equal(by('invoke_agent a').attributes['zaafpulse.cost.usd'], 0.01);
  assert.deepEqual(book.traceCtx(agent.id).spanId, agent.id);
  assert.equal(setup(() => false).o.spanBook(), null);
});
```

Append to `test/otel.test.js`:

```js
test('otel: a standalone agent run has an invoke_agent span with its model call under it', async () => {
  const got = [];
  const t = await gatewaySetup(() => ({ body: completion('Here is the refund policy.') }), { enabled: false }, {
    enabled: () => true,
    add: (r) => got.push(r),
  });
  try {
    const r = await t.call('/v1/agents/customer-service/run', { input: 'refund policy?' });
    assert.equal(r.status, 200, r.text);
    await sleep(30);
    const server = got.find((s) => s.kind === 2);
    const agent = got.find((s) => s.name === 'invoke_agent customer-service');
    assert.ok(agent, got.map((s) => s.name).join(', '));
    assert.equal(agent.parentSpanId, server.spanId);
    const chat = got.find((s) => s.name === 'chat fake/m');
    assert.equal(chat.parentSpanId, agent.spanId);
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/trace-sink.test.js test/otel.test.js`
Expected: FAIL: `o.spanBook is not a function`; no `invoke_agent customer-service` span.

- [ ] **Step 3: Implement the span book** (`lib/otel.js`)

Directly after the `runContext` function, add:

```js
  // Spans for an agent run outside a collaboration run, with the interface of a run's rt.span, so the
  // orchestrator traces both the same way. null while nothing records spans.
  function spanBook() {
    if (!live(current())) return null;
    const open = new Map(); // span id -> span
    return {
      span(name, attributes = {}, parentId = null) {
        const p = parentId ? open.get(parentId) : null;
        const sp = startSpan(name, { attributes: runAttrs(attributes), ...(p ? { parent: p.context } : {}) });
        open.set(sp.context.spanId, sp);
        return {
          id: sp.context.spanId,
          end(more = {}, err = null) {
            try {
              sp.setAttributes(runAttrs(more));
              if (err) sp.fail('_OTHER', err.message || String(err));
              sp.end();
            } catch {
              /* telemetry must not break the run */
            }
          },
        };
      },
      within: (id, fn) => (open.has(id) ? within(open.get(id).context, fn) : fn()),
      traceCtx: (id) => (open.has(id) ? { ...open.get(id).context } : undefined),
    };
  }
```

Add `spanBook,` to the instance's return object (after `runContext,`), and to `module.exports` after `runSpanId,`:

```js
  spanBook: () => (instance ? instance.spanBook() : null),
```

- [ ] **Step 4: Use it in the orchestrator** (`lib/gateway/orchestrator.js`)

After the line `const { words } = require('./memory');` add:

```js
const otel = require('../otel');
```

In `runAgent`, replace

```js
  async function runAgent(agent, input, ctx = {}) {
    const span = ctx.run
      ? ctx.run.span(
```

with

```js
  async function runAgent(agent, input, ctx = {}) {
    // Outside a collaboration run, a span book gives this agent the spans a run's rt.span gives it inside one.
    if (!ctx.run && !ctx.tracer) {
      const book = otel.spanBook();
      if (book) ctx = { ...ctx, tracer: book };
    }
    const tr = ctx.run || ctx.tracer;
    const span = tr
      ? tr.span(
```

In `runLocal`, replace

```js
  async function runLocal(agent, input, ctx) {
    const call = ctx.llm || llm;
```

with

```js
  async function runLocal(agent, input, ctx) {
    const call = ctx.llm || llm;
    const tr = ctx.run || ctx.tracer;
```

Replace

```js
      const r = await call({
        model,
        messages,
        tools: round < MAX_TOOL_ROUNDS ? tools : undefined,
        keyId: ctx.keyId,
        agent: agent.id,
        sessionId: ctx.session && ctx.session.id,
        temperature: ctx.temperature,
        span: ctx.span,
      });
```

with

```js
      const callArgs = {
        model,
        messages,
        tools: round < MAX_TOOL_ROUNDS ? tools : undefined,
        keyId: ctx.keyId,
        agent: agent.id,
        sessionId: ctx.session && ctx.session.id,
        temperature: ctx.temperature,
        span: ctx.span,
      };
      // A run's rt.llm nests its own model calls; outside a run the span book does it here.
      const r = await (ctx.tracer ? ctx.tracer.within(ctx.span, () => call(callArgs)) : call(callArgs));
```

Replace

```js
        const tspan = ctx.run
          ? ctx.run.span(
```

with

```js
        const tspan = tr
          ? tr.span(
```

Replace

```js
            out = await runTool(tc.function.name, args, { ...ctx, agent, box });
```

with

```js
            // Integration calls made by the tool nest under its span.
            const go = () => runTool(tc.function.name, args, { ...ctx, agent, box });
            out = await (tspan ? tr.within(tspan.id, go) : go());
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/trace-sink.test.js test/otel.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS (orchestrator, collab, gateway and A2A tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add lib/otel.js lib/gateway/orchestrator.js test/trace-sink.test.js test/otel.test.js
git commit -m "Trace standalone agent runs with agent and tool spans"
```

---

# Phase 3: Analysis on the explorer span model

Result of the phase: two pure modules that adjust and explain any explorer skeleton, whatever its source. Times are milliseconds, as in the explorer. A span whose `end` is `null` (still running) is treated as ending at the latest end seen in the skeleton.

### Task 7: Read-time adjusters

**Files:**
- Create: `lib/trace/adjust.js`, `test/trace-adjust.test.js`

**Interfaces:**
- Consumes: explorer spans (Shared interfaces), optionally with `service`.
- Produces: `adjust(spans) → span[]` (new objects sorted by start; may set `orphanOf` (the lost parent id) and `skewMs`); `skewOf(parent, child) → ms`.

- [ ] **Step 1: Write the failing test** (`test/trace-adjust.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { adjust } = require('../lib/trace/adjust');

const sp = (id, parent, start, dur, extra = {}) => ({ id, parent, kind: 'tool', name: `op ${id}`, start, end: start + dur, status: 'ok', ...extra });
const get = (list, id) => list.find((s) => s.id === id);

test('adjust: a duplicated span keeps its longer record; the input is not modified', () => {
  const input = [sp('a', null, 0, 100), sp('b', 'a', 10, 0), sp('b', 'a', 10, 50)];
  const out = adjust(input);
  assert.equal(out.length, 2);
  assert.equal(get(out, 'b').end, 60);
  assert.equal(input[1].end, 10);
});

test('adjust: orphans hang under the root and keep their lost parent', () => {
  const out = adjust([sp('a', null, 0, 100), sp('c', 'z', 10, 5)]);
  assert.equal(get(out, 'c').parent, 'a');
  assert.equal(get(out, 'c').orphanOf, 'z');
});

test('adjust: without a root, the earliest span becomes it', () => {
  const out = adjust([sp('c', 'y', 20, 5), sp('b', 'x', 5, 10)]);
  assert.equal(get(out, 'b').parent, null);
  assert.equal(get(out, 'b').orphanOf, 'x');
  assert.equal(get(out, 'c').parent, 'b');
});

test('adjust: clock skew is corrected only across services, and carried to the same service below', () => {
  const out = adjust([
    sp('a', null, 1000, 1000, { service: 'zaafpulse' }),
    sp('b', 'a', 5000, 200, { service: 'far' }), // outside its parent: centred inside it
    sp('c', 'b', 5050, 50, { service: 'far' }), // same service as b: moves with it
    sp('d', 'a', 9000, 10, { service: 'zaafpulse' }), // same service as a: left alone
  ]);
  assert.equal(get(out, 'b').start, 1400);
  assert.equal(get(out, 'b').end, 1600);
  assert.equal(get(out, 'b').skewMs, -3600);
  assert.equal(get(out, 'c').start, 1450);
  assert.equal(get(out, 'd').start, 9000);
  assert.deepEqual(out.map((s) => s.start), [1000, 1400, 1450, 9000]);
});

test('adjust: a longer child that starts before its parent moves to the parent start', () => {
  const out = adjust([sp('a', null, 1000, 100, { service: 'x' }), sp('b', 'a', 900, 500, { service: 'far' })]);
  assert.equal(get(out, 'b').start, 1000);
});

test('adjust: spans without a service (log sources) are never shifted', () => {
  const out = adjust([sp('a', null, 1000, 100), sp('b', 'a', 5000, 10)]);
  assert.equal(get(out, 'b').start, 5000);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-adjust.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/adjust'`.

- [ ] **Step 3: Implement** (`lib/trace/adjust.js`)

```js
// Read-time fixes on explorer spans, in the order of Jaeger's standard adjusters: duplicate span ids, orphans,
// clock skew between services, then start order. The input is not modified. Clock skew only applies where both
// spans name their service and the services differ (a remote agent's spans next to ours); log sources have no
// service, so their spans keep the times their logs gave them.
const durOf = (s) => (Number.isFinite(s.end) ? s.end - s.start : 0);

// Jaeger's rule: a child outside its parent is centred inside it; a longer child that starts first is moved to
// the parent's start.
function skewOf(parent, child) {
  const pd = durOf(parent);
  const cd = durOf(child);
  if (cd > pd) return child.start < parent.start ? parent.start - child.start : 0;
  if (child.start >= parent.start && child.start + cd <= parent.start + pd) return 0;
  return parent.start + Math.floor((pd - cd) / 2) - child.start;
}

function adjust(spans) {
  // A span sent twice (once at start, once with its end) keeps the longer record.
  const byId = new Map();
  for (const s of spans) {
    if (!s || typeof s.id !== 'string') continue;
    const had = byId.get(s.id);
    if (!had || durOf(s) > durOf(had)) byId.set(s.id, { ...s });
  }
  const list = [...byId.values()].sort((a, b) => a.start - b.start);
  if (!list.length) return list;

  // Orphans hang under the root; without a root, the earliest span becomes it.
  let root = list.find((s) => !s.parent);
  if (!root) {
    root = list[0];
    root.orphanOf = root.parent;
    root.parent = null;
  }
  for (const s of list)
    if (s.parent && !byId.has(s.parent)) {
      s.orphanOf = s.parent;
      s.parent = root.id;
    }

  const kids = new Map();
  for (const s of list)
    if (s.parent) {
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    }
  const shift = (s, delta) => {
    s.start += delta;
    if (Number.isFinite(s.end)) s.end += delta;
    for (const c of kids.get(s.id) || []) if (c.service === s.service) shift(c, delta);
  };
  const seen = new Set();
  const visit = (s) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    for (const c of kids.get(s.id) || []) {
      if (s.service && c.service && c.service !== s.service) {
        const delta = skewOf(s, c);
        if (delta) {
          shift(c, delta);
          c.skewMs = delta;
        }
      }
      visit(c);
    }
  };
  for (const s of list) if (!s.parent) visit(s);

  return list.sort((a, b) => a.start - b.start);
}

module.exports = { adjust, skewOf };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-adjust.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/adjust.js test/trace-adjust.test.js
git commit -m "Add read-time trace adjusters: duplicates, orphans, clock skew"
```

### Task 8: Critical path, rollups, self time, root cause

**Files:**
- Create: `lib/trace/analyze.js`, `test/trace-analyze.test.js`

**Interfaces:**
- Consumes: explorer spans (adjusted or not).
- Produces: `analyze(spans, { rootId } = {}) → { rootSpanId, criticalPath: [{ spanId, start, end }], selfTime: { [id]: ms }, rollup: { [id]: { tokensIn, tokensOut, costUSD, spans, errors } }, rootCause: { spanId, name, error, onCriticalPath } | null }`; `criticalPath(spans, rootId?) → sections`. The critical path and the root cause stay inside the root's subtree; self time and rollups cover every span. `tokensIn` is `usage.input + cacheRead + cacheWrite5m + cacheWrite1h`.

- [ ] **Step 1: Write the failing test** (`test/trace-analyze.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, criticalPath } = require('../lib/trace/analyze');

const sp = (id, parent, start, dur, extra = {}) => ({ id, parent, kind: 'tool', name: `op ${id}`, start, end: start + dur, status: 'ok', usage: null, cost: null, ...extra });
const chat = (id, parent, start, dur, input, output, cost) => sp(id, parent, start, dur, { kind: 'chat', usage: { input, output, cacheRead: 0 }, cost });
const failed = (id, parent, start, dur) => sp(id, parent, start, dur, { status: 'error', error: `${id} failed` });
const path = (spans, rootId) => criticalPath(spans, rootId).map((x) => [x.spanId, x.start, x.end]);

test('critical path: sequential children (the example in Jaeger)', () => {
  assert.deepEqual(path([sp('a', null, 0, 100), sp('b', 'a', 10, 30), sp('c', 'a', 50, 40)]), [
    ['a', 0, 10],
    ['b', 10, 40],
    ['a', 40, 50],
    ['c', 50, 90],
    ['a', 90, 100],
  ]);
});

test('critical path: an overlapped child that finishes earlier is not on it', () => {
  assert.deepEqual(path([sp('a', null, 0, 100), sp('b', 'a', 10, 70), sp('c', 'a', 20, 40)]), [
    ['a', 0, 10],
    ['b', 10, 80],
    ['a', 80, 100],
  ]);
});

test('critical path: a child outliving its parent is cut at the parent end', () => {
  assert.deepEqual(path([sp('a', null, 0, 100), sp('b', 'a', 50, 100)]), [
    ['a', 0, 50],
    ['b', 50, 100],
  ]);
});

const tree = () => [
  sp('a', null, 0, 100),
  chat('b', 'a', 0, 40, 10, 5, 0.01),
  failed('c', 'a', 50, 40),
  chat('d', 'c', 60, 20, 3, 1, 0.002),
  failed('e', 'a', 5, 1), // fails earlier, but off the critical path
];

test('analyze: rollups from chat spans only, self time, and the failing span on the critical path', () => {
  const spans = tree();
  spans[0].cost = 99; // a parent's own cost repeats its children's: not counted
  const r = analyze(spans);
  assert.equal(r.rootSpanId, 'a');
  assert.deepEqual(r.rollup.a, { tokensIn: 13, tokensOut: 6, costUSD: 0.012, spans: 5, errors: 2 });
  assert.deepEqual(r.rollup.c, { tokensIn: 3, tokensOut: 1, costUSD: 0.002, spans: 2, errors: 1 });
  assert.equal(r.selfTime.a, 20);
  assert.equal(r.selfTime.c, 20);
  assert.deepEqual(r.rootCause, { spanId: 'c', name: 'op c', error: 'c failed', onCriticalPath: true });
  assert.equal(analyze([sp('a', null, 0, 10)]).rootCause, null);
});

test('analyze: a given root limits the critical path and the root cause to its subtree', () => {
  const r = analyze(tree(), { rootId: 'c' });
  assert.equal(r.rootSpanId, 'c');
  assert.deepEqual(r.criticalPath.map((x) => x.spanId), ['c', 'd', 'c']);
  assert.equal(r.rootCause.spanId, 'c');
  assert.ok(r.rollup.a, 'rollups still cover every span');
});

test('analyze: a running span ends at the latest end seen', () => {
  const r = analyze([sp('a', null, 0, 0, { end: null, status: 'running' }), sp('b', 'a', 0, 40)]);
  assert.deepEqual(r.criticalPath.map((x) => [x.spanId, x.start, x.end]), [['b', 0, 40]]);
  assert.equal(r.selfTime.a, 0);
});

test('analyze: cache tokens count as input', () => {
  const r = analyze([sp('a', null, 0, 10), sp('b', 'a', 0, 5, { kind: 'chat', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 } })]);
  assert.equal(r.rollup.a.tokensIn, 13);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-analyze.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/analyze'`.

- [ ] **Step 3: Implement** (`lib/trace/analyze.js`)

```js
// What a trace means, on explorer spans (ms): the critical path (Jaeger's algorithm), each span's self time,
// tokens and cost rolled up per subtree (from chat spans only: a parent's cost repeats its children's), and the
// failed span most likely to explain the outcome. A running span (end null) ends at the latest end seen.
const num = (v) => (Number.isFinite(v) ? v : 0);

function prepare(spans) {
  let last = -Infinity;
  for (const s of spans) if (Number.isFinite(s.end)) last = Math.max(last, s.end);
  const list = spans
    .filter((s) => s && typeof s.id === 'string' && Number.isFinite(s.start))
    .map((s) => ({ ...s, end: Number.isFinite(s.end) ? s.end : Math.max(s.start, last) }));
  const byId = new Map(list.map((s) => [s.id, s]));
  const kids = new Map();
  for (const s of list)
    if (s.parent && byId.has(s.parent)) {
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    }
  const roots = list.filter((s) => !s.parent || !byId.has(s.parent)).sort((a, b) => a.start - b.start);
  return { list, byId, kids, roots };
}

// Children clipped to their parent, top-down; a child entirely outside its parent is dropped with its subtree
// (Jaeger's removeOverflowingChildren).
function clipped(root, kids) {
  const boxes = new Map();
  const visit = (s, parent) => {
    let start = s.start;
    let end = s.end;
    if (parent) {
      if (end <= parent.start || start >= parent.end) return;
      start = Math.max(start, parent.start);
      end = Math.min(end, parent.end);
    }
    const box = { id: s.id, p: parent ? parent.id : null, start, end, kids: [] };
    boxes.set(s.id, box);
    if (parent) parent.kids.push(box);
    for (const c of kids.get(s.id) || []) visit(c, box);
  };
  visit(root, null);
  return boxes;
}

// From the root, take the last-finishing child; when a span has no such child, its section up to the returning
// point is on the path and the walk goes back to its parent, looking for a child that finished before this span
// started. The recursion of the Go version, as a loop.
function pathFrom(root, kids) {
  const boxes = clipped(root, kids);
  const out = [];
  let cur = boxes.get(root.id);
  let ret = null;
  for (let guard = 0; cur && guard < boxes.size * 4 + 4; guard++) {
    const end = ret === null ? cur.end : ret;
    let lfc = null;
    for (const c of cur.kids) {
      if (ret !== null && !(c.start < ret && c.end <= ret)) continue;
      if (!lfc || c.end > lfc.end) lfc = c;
    }
    if (lfc) {
      if (lfc.end !== end) out.push({ spanId: cur.id, start: lfc.end, end });
      cur = lfc;
      ret = null;
    } else {
      if (cur.start !== end) out.push({ spanId: cur.id, start: cur.start, end });
      if (!cur.p || cur.id === root.id) break;
      ret = cur.start;
      cur = boxes.get(cur.p);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function pickRoot({ byId, roots }, rootId) {
  return rootId && byId.has(rootId) ? byId.get(rootId) : roots[0] || null;
}

function criticalPath(spans, rootId) {
  const t = prepare(spans);
  const root = pickRoot(t, rootId);
  return root ? pathFrom(root, t.kids) : [];
}

function rollups(roots, kids) {
  const out = {};
  const visit = (s) => {
    const chat = s.kind === 'chat' && s.usage;
    const u = s.usage || {};
    const r = {
      tokensIn: chat ? num(u.input) + num(u.cacheRead) + num(u.cacheWrite5m) + num(u.cacheWrite1h) : 0,
      tokensOut: chat ? num(u.output) : 0,
      costUSD: s.kind === 'chat' ? num(s.cost) : 0,
      spans: 1,
      errors: s.status === 'error' ? 1 : 0,
    };
    for (const c of kids.get(s.id) || []) {
      const x = visit(c);
      r.tokensIn += x.tokensIn;
      r.tokensOut += x.tokensOut;
      r.costUSD += x.costUSD;
      r.spans += x.spans;
      r.errors += x.errors;
    }
    r.costUSD = Math.round(r.costUSD * 1e9) / 1e9; // sums of small prices, without float noise
    out[s.id] = r;
    return r;
  };
  roots.forEach(visit);
  return out;
}

// Time a span spent itself: its duration minus the union of its children's time inside it.
function selfTimes(list, kids) {
  const out = {};
  for (const s of list) {
    const iv = (kids.get(s.id) || [])
      .map((c) => [Math.max(c.start, s.start), Math.min(c.end, s.end)])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    let covered = 0;
    let cs = null;
    let ce = null;
    for (const [a, b] of iv) {
      if (cs === null || a > ce) {
        if (cs !== null) covered += ce - cs;
        cs = a;
        ce = b;
      } else ce = Math.max(ce, b);
    }
    if (cs !== null) covered += ce - cs;
    out[s.id] = Math.max(0, s.end - s.start - covered);
  }
  return out;
}

// The deepest failed span on the critical path; without one, the earliest failed span of the subtree.
function rootCause(root, kids, byId, onPath) {
  const inTree = [];
  const walk = (s) => {
    inTree.push(s);
    for (const c of kids.get(s.id) || []) walk(c);
  };
  walk(root);
  const failed = inTree.filter((s) => s.status === 'error');
  if (!failed.length) return null;
  const depth = (s) => {
    let d = 0;
    for (let p = s.parent; p && byId.has(p) && d < 1000; p = byId.get(p).parent) d++;
    return d;
  };
  const candidates = failed.filter((s) => onPath.has(s.id));
  const pick = candidates.length
    ? candidates.sort((a, b) => depth(b) - depth(a) || a.start - b.start)[0]
    : failed.sort((a, b) => a.start - b.start)[0];
  return { spanId: pick.id, name: pick.name, error: typeof pick.error === 'string' ? pick.error : '', onCriticalPath: onPath.has(pick.id) };
}

function analyze(spans, { rootId } = {}) {
  const t = prepare(Array.isArray(spans) ? spans : []);
  const root = pickRoot(t, rootId);
  const cp = root ? pathFrom(root, t.kids) : [];
  return {
    rootSpanId: root ? root.id : null,
    criticalPath: cp,
    selfTime: selfTimes(t.list, t.kids),
    rollup: rollups(t.roots, t.kids),
    rootCause: root ? rootCause(root, t.kids, t.byId, new Set(cp.map((x) => x.spanId))) : null,
  };
}

module.exports = { analyze, criticalPath };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-analyze.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/analyze.js test/trace-analyze.test.js
git commit -m "Add trace analysis: critical path, rollups, self time, root cause"
```

---

# Phase 4: In the explorer

Result of the phase: the explorer lists stored gateway traces (without showing anything twice), every opened skeleton of every source comes with its analysis, the page shows the critical path, self time, branch totals, the likely root cause and a dependency table, and AI clients read a session in small views over MCP.

### Task 9: Gateway rows and skeletons from the store

**Files:**
- Modify: `lib/trace/gateway.js`, `lib/trace/index.js`, `server.js`, `test/trace-gateway.test.js`

**Interfaces:**
- Consumes: a store (Task 2: `summaries`, `getSummary`, `getSpans`, `byRun`, `covered`); `runSpanId` (Task 5); `adjust` (Task 7).
- Produces: `createGatewayAdapter(g, store = null)`; rows `trace:<traceId>` with `tags` and `stamp`; explorer spans from stored records carry `service` and, when failed, `error`. `createTrace({ ..., traceStore })`. An adapter row may set `stamp` (string) and `tags` (string array); the registry uses both.

- [ ] **Step 1: Write the failing tests**

Append to `test/trace-gateway.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTraceStore } = require('../lib/trace/store');
const { runSpanId } = require('../lib/otel');
const { createTrace } = require('../lib/trace');

const US = (ms) => Math.round(ms * 1000);
const R0 = Date.now() - 60000; // the stored run starts a minute ago
const TS = 'a'.repeat(32); // the run's trace
const TQ = 'b'.repeat(32); // a plain chat request
const rec = (t, s, p, n, k, startMs, durMs, a = {}, extra = {}) => ({ t, s, p, n, k, st: US(startMs), d: US(durMs), ok: true, src: 'gateway', svc: 'zaafpulse', a, ...extra });
const chatAttrs = { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm', 'gen_ai.provider.name': 'openai', 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 3, 'gen_ai.usage.cache_read.input_tokens': 2, 'zaafpulse.cost.usd': 0.001 };
const SERVER = '1'.repeat(16);
const ROOT = runSpanId('r1', 'x0');
const AGENT = runSpanId('r1', 'x1');
const CHAT = runSpanId('r1', 'x2');
function storedFixture() {
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gw-store-')) });
  store.writeSpans([
    rec(TS, SERVER, 'f'.repeat(16), 'POST /v1/collaborate', 'server', R0, 5000),
    rec(TS, ROOT, SERVER, 'invoke_workflow vote', 'internal', R0 + 10, 4900, { 'gen_ai.operation.name': 'invoke_workflow', 'zaafpulse.run.id': 'r1' }),
    rec(TS, AGENT, ROOT, 'invoke_agent a', 'internal', R0 + 100, 2900, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'a' }),
    rec(TS, CHAT, AGENT, 'chat m', 'client', R0 + 200, 1800, chatAttrs),
    rec(TS, '3'.repeat(16), AGENT, 'execute_tool web', 'internal', R0 + 2100, 100, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' }, { ok: false, err: 'HTTP 500' }),
    rec(TQ, '4'.repeat(16), null, 'POST /v1/chat/completions', 'server', R0 + 20000, 300),
    rec(TQ, '5'.repeat(16), '4'.repeat(16), 'chat m', 'client', R0 + 20050, 200, chatAttrs),
  ]);
  // A request the store already holds (inside its window): not listed again from the usage log.
  const g2 = { ...g, requests: () => [...g.requests(), { ts: R0 + 20000, keyId: 'k1', provider: 'p', model: 'm', sessionId: 'conv-2', kind: 'chat', status: 200, ms: 300 }] };
  return { store, g2 };
}

test('stored traces are listed once: runs and requests the store holds are not listed again', () => {
  const { store, g2 } = storedFixture();
  const rows = createGatewayAdapter(g2, store).sessions();
  assert.deepEqual(rows.map((r) => r.id).sort(), ['req:conv-1', `trace:${TQ}`, `trace:${TS}`]);
  const r = rows.find((x) => x.id === `trace:${TS}`);
  assert.equal(r.title, 'POST /v1/collaborate · 5 spans · m');
  assert.equal(r.start, R0);
  assert.equal(r.end, R0 + 5000);
  assert.equal(r.tools, 1);
  assert.equal(r.errors, 1);
  assert.equal(r.cost, 0.001);
  assert.deepEqual(r.flags, { errors: true, loop: false, injection: false });
  assert.deepEqual(r.tags.sort(), ['a', 'm', 'web']);
  assert.equal(typeof r.stamp, 'string');
  assert.ok(!JSON.stringify(rows).includes('secret task text'));
  // Without a store, the adapter lists what it always did.
  assert.deepEqual(createGatewayAdapter(g).sessions().map((x) => x.id).sort(), ['req:conv-1', 'run:r1']);
});

test('a stored trace opens as explorer spans, with the run step text linked and an answer', async () => {
  const { store, g2 } = storedFixture();
  const sk = await createGatewayAdapter(g2, store).skeleton(null, `trace:${TS}`);
  assert.deepEqual(validate(sk.spans), []);
  const by = (name) => sk.spans.find((s) => s.name === name);
  const root = by('POST /v1/collaborate');
  assert.equal(root.parent, null);
  assert.equal(root.kind, 'session');
  assert.equal(root.start, R0);
  assert.equal(by('invoke_agent a').kind, 'agent');
  const chat = by('chat m');
  assert.equal(chat.kind, 'chat');
  assert.deepEqual(chat.usage, { input: 3, output: 3, cacheRead: 2 });
  assert.equal(chat.cost, 0.001);
  assert.equal(chat.model, 'm');
  assert.equal(chat.provider, 'openai');
  assert.equal(chat.service, 'zaafpulse');
  assert.deepEqual(chat.text, { g: 'run', id: 'r1', step: 0 });
  const tool = by('execute_tool web');
  assert.equal(tool.status, 'error');
  assert.equal(tool.error, 'HTTP 500');
  assert.deepEqual(tool.tool, { name: 'web', target: null });
  const answer = sk.spans.find((s) => s.kind === 'answer');
  assert.equal(answer.parent, ROOT);
  assert.deepEqual(answer.text, { g: 'run', id: 'r1', answer: true });
  assert.equal(sk.session.start, R0);
  await assert.rejects(createGatewayAdapter(g2, store).skeleton(null, `trace:${'c'.repeat(32)}`), (e) => e.status === 404);
});

test('registry: stored gateway rows are found by agent, model or tool', () => {
  const { store, g2 } = storedFixture();
  const t = createTrace({ gateway: g2, traceStore: store, light: [] });
  const titles = (q) => t.sessions({ q, range: 30 }).map((r) => r.title);
  assert.deepEqual(titles('web'), ['POST /v1/collaborate · 5 spans · m']);
  assert.equal(titles('m').length, 2);
  assert.deepEqual(titles('no-such-agent'), []);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/trace-gateway.test.js`
Expected: FAIL: no `trace:` rows; `run:r1` still listed; `skeleton` rejects `trace:` ids with "session not found".

- [ ] **Step 3: Implement the adapter** (`lib/trace/gateway.js`)

Replace the first line of requires

```js
const { spanId, span, maskTitle } = require('./model');
```

with

```js
const { spanId, span, maskTitle } = require('./model');
const { adjust } = require('./adjust');
const { runSpanId } = require('../otel');
```

Directly before `function createGatewayAdapter(g) {`, add:

```js
// A stored span record (lib/trace/recorder.js) as an explorer span. Times become milliseconds; OTel counts cached
// tokens inside input, the explorer next to it. Names and labels are masked and capped like a title.
function fromRecord(r, textOf) {
  const a = r.a || {};
  const kind = r.k === 'server' ? 'session' : r.k === 'client' && /^a2a /.test(r.n) ? 'agent' : kindOf(r.n);
  const chat = kind === 'chat';
  const cached = num(a['gen_ai.usage.cache_read.input_tokens']);
  return span({
    id: r.s,
    parent: r.p || null,
    kind,
    op: String(a['gen_ai.operation.name'] || r.n.split(' ')[0]),
    name: clip(r.n),
    start: r.st / 1000,
    end: (r.st + r.d) / 1000,
    status: r.ok ? 'ok' : 'error',
    model: chat ? maskTitle(a['gen_ai.request.model']) : null,
    provider: chat ? maskTitle(a['gen_ai.provider.name']) : null,
    usage:
      chat && a['gen_ai.usage.input_tokens'] != null
        ? { input: Math.max(0, num(a['gen_ai.usage.input_tokens']) - cached), output: num(a['gen_ai.usage.output_tokens']), cacheRead: cached }
        : null,
    cost: chat ? num(a['zaafpulse.cost.usd']) || null : null,
    tool: kind === 'tool' && a['gen_ai.tool.name'] ? { name: clip(a['gen_ai.tool.name']), target: null } : null,
    service: typeof r.svc === 'string' ? r.svc.slice(0, 100) : null,
    error: r.ok ? null : clip(r.err || 'error'),
    text: textOf.get(r.s) || null,
  });
}
```

Replace `function createGatewayAdapter(g) {` and the whole `groups` function (up to and including its `return out;` and closing brace) with:

```js
function createGatewayAdapter(g, store = null) {
  // What the store holds, in ms: requests inside it are listed from the store, not again from the usage log.
  function inStore() {
    const c = store ? store.covered() : null;
    return c ? (ms) => ms * 1000 >= c.from && ms * 1000 <= c.to : () => false;
  }
  // Requests by conversation, else by key per hour, each group in time order.
  function groups() {
    const out = new Map();
    const held = inStore();
    for (const r of g.requests()) {
      if (r.runId) continue; // a collaboration run's own model call: the run's skeleton already shows it
      if (held(r.ts)) continue;
      const key = r.sessionId ? `req:${String(r.sessionId).slice(0, 80)}` : `req:${String(r.keyId || 'nokey').slice(0, 80)}:${new Date(Math.floor(r.ts / HOUR) * HOUR).toISOString()}`;
      (out.get(key) || out.set(key, []).get(key)).push(r);
    }
    for (const list of out.values()) list.sort((a, b) => a.ts - b.ts);
    return out;
  }

  // One row per stored trace. The title is the root span's name and counts, never a task or a prompt.
  function storedRows() {
    if (!store) return [];
    return store.summaries().map((s) => {
      const models = s.models.length === 1 ? clip(s.models[0]) : s.models.length ? `${s.models.length} models` : null;
      return {
        id: `trace:${s.traceId}`,
        source: 'gateway',
        title: [clip(s.root) || 'trace', `${s.spans} span${s.spans === 1 ? '' : 's'}`, models].filter(Boolean).join(' · '),
        project: 'gateway',
        branch: null,
        start: Math.floor(s.start / 1000),
        end: Math.ceil(s.end / 1000),
        turns: 1,
        tools: s.toolCalls,
        errors: s.errors,
        cost: s.costUSD,
        flags: { errors: s.errors > 0, loop: false, injection: false },
        tags: [...s.agents, ...s.models, ...s.tools].map(clip).filter(Boolean),
        stamp: `${s.spans}:${s.end}`,
      };
    });
  }
```

In `sessions`, replace

```js
    const rows = g.runs().map((r) => {
```

with

```js
    const rows = g.runs()
      .filter((r) => !(store && store.byRun(r.id))) // the store holds this run's trace
      .map((r) => {
```

and replace the function's last line `    return rows;` with

```js
    return rows.concat(storedRows());
```

Directly before `  async function skeleton(_entry, id) {` add:

```js
  // The run's step text, keyed by the stored id of the chat span it belongs to (otel runSpanId).
  function runText(run) {
    const out = new Map();
    for (const [rtId, step] of linkSteps(Array.isArray(run.trace) ? run.trace : [], Array.isArray(run.steps) ? run.steps : []))
      out.set(runSpanId(run.id, rtId), { g: 'run', id: run.id, step });
    return out;
  }

  function storedSkeleton(id) {
    const traceId = id.slice('trace:'.length);
    const recs = store ? store.getSpans(traceId) : null;
    if (!recs || !recs.length) throw Object.assign(new Error('session file changed, rescanning'), { status: 404 });
    const sum = store.getSummary(traceId);
    const run = sum && sum.runId ? g.run(sum.runId) : null;
    const spans = adjust(recs.map((r) => fromRecord(r, run ? runText(run) : new Map())));
    const start = Math.min(...spans.map((s) => s.start));
    const end = Math.max(...spans.map((s) => (Number.isFinite(s.end) ? s.end : s.start)));
    if (run && typeof run.answer === 'string' && run.answer) {
      const tops = (run.trace || []).filter((s) => s.parent == null && /^invoke_workflow/.test(s.name));
      const rootId = tops.length ? runSpanId(run.id, tops[tops.length - 1].id) : null;
      const parent = spans.some((s) => s.id === rootId) ? rootId : spans.find((s) => !s.parent).id;
      spans.push(span({ id: spanId('gw', run.id, 'answer'), parent, kind: 'answer', op: 'chat', name: 'answer', start: end, end, text: { g: 'run', id: run.id, answer: true } }));
    }
    return { session: { id, source: 'gateway', project: 'gateway', branch: null, start, end }, turns: [{ index: 0, start: 0, ts: start }], spans };
  }

```

In `skeleton`, add as its first statement:

```js
    if (typeof id === 'string' && id.startsWith('trace:')) return storedSkeleton(id);
```

- [ ] **Step 4: Let the registry take the store, row stamps and tags** (`lib/trace/index.js`)

Replace

```js
  const gwAdapter = gw ? createGatewayAdapter(gw) : null;
```

with

```js
  const gwAdapter = gw ? createGatewayAdapter(gw, opts.traceStore || null) : null;
```

In `add`, replace

```js
          title: titleShown(id) && typeof r.title === 'string' && r.title ? r.title : null,
          // What changes when the session does, so a cached skeleton is not served stale.
          stamp: entry ? `${entry.mtimeMs}:${entry.size}:${pv}` : `${r.end}:${r.turns}:${r.tools}`,
```

with

```js
          title: titleShown(id) && typeof r.title === 'string' && r.title ? r.title : null,
          // What changes when the session does, so a cached skeleton is not served stale.
          stamp: entry
            ? `${entry.mtimeMs}:${entry.size}:${pv}`
            : typeof r.stamp === 'string'
              ? r.stamp
              : `${r.end}:${r.turns}:${r.tools}`,
          // Labels the search box also matches (agents, models, tools of a stored trace); already masked.
          tags: Array.isArray(r.tags) ? r.tags.filter((x) => typeof x === 'string').slice(0, 60) : null,
```

In `sessions`, replace

```js
      const hay = [t, base.project, base.branch];
```

with

```js
      const hay = [t, base.project, base.branch, ...(info.tags || [])];
```

- [ ] **Step 5: Give the registry the store** (`server.js`)

In the `createTrace({ … })` call, replace

```js
        indexer,
        gateway,
        roots: [...LOG_ROOTS.claude, ...LOG_ROOTS.codex],
```

with

```js
        indexer,
        gateway,
        traceStore,
        roots: [...LOG_ROOTS.claude, ...LOG_ROOTS.codex],
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/trace-gateway.test.js test/trace-index.test.js test/trace-registry.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/trace/gateway.js lib/trace/index.js server.js test/trace-gateway.test.js
git commit -m "List stored gateway traces in the trace explorer"
```

### Task 10: Analysis, filters and dependencies in the API

**Files:**
- Create: `lib/trace/deps.js`, `test/trace-deps.test.js`
- Modify: `lib/trace/index.js`, `lib/demo.js`, `server.js`, `test/trace-registry.test.js`, `test/trace-api.test.js`

**Interfaces:**
- Consumes: `adjust` (Task 7), `analyze` (Task 8), the store (Task 2).
- Produces: `dependencies(store, { from, to, limit = 500 }) → { nodes: [{ id, kind, label, count }], edges: [{ from, to, count, errors, p95Ms }] }` (`from`/`to` in ms). Registry: sealed skeletons gain `analysis` (Task 8's shape, or `null`); `sessions({ …, minMs, minCost })`; `deps({ range }) → { nodes, edges }`. Route `GET /api/trace/deps?range=` (days 1..30, default 7); `/api/trace/sessions` takes `minMs` and `minCost`.

- [ ] **Step 1: Write the failing tests**

`test/trace-deps.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTraceStore } = require('../lib/trace/store');
const { dependencies } = require('../lib/trace/deps');

const T = 'a'.repeat(32);
const NOW = Date.now();
const rec = (s, p, n, k, a = {}, ok = true, svc = 'zaafpulse', durMs = 5) => ({ t: T, s, p, n, k, st: (NOW - 1000) * 1000, d: durMs * 1000, ok, src: 'gateway', svc, a });

test('deps: agents to models, tools, agents and remote services, with counts, failures and p95', () => {
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-deps-')) });
  store.writeSpans([
    rec('1'.repeat(16), null, 'POST /v1/collaborate', 'server'),
    rec('2'.repeat(16), '1'.repeat(16), 'invoke_agent sales', 'internal', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'sales' }),
    rec('3'.repeat(16), '2'.repeat(16), 'chat m', 'client', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm' }),
    rec('4'.repeat(16), '2'.repeat(16), 'execute_tool web', 'internal', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' }, false),
    rec('5'.repeat(16), '4'.repeat(16), 'execute_tool web', 'internal', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' }, true, 'zaafpulse', 15),
    rec('6'.repeat(16), '2'.repeat(16), 'a2a far', 'client', { 'rpc.system': 'a2a', 'server.address': 'far:9' }),
    rec('7'.repeat(16), '6'.repeat(16), 'handle', 'server', {}, true, 'far-agent'),
  ]);
  const d = dependencies(store, { from: NOW - 60000, to: NOW + 60000 });
  const edge = (from, to) => d.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(edge('agent:sales', 'model:m'), { from: 'agent:sales', to: 'model:m', count: 1, errors: 0, p95Ms: 5 });
  assert.deepEqual(edge('agent:sales', 'tool:web'), { from: 'agent:sales', to: 'tool:web', count: 2, errors: 1, p95Ms: 15 });
  assert.equal(edge('agent:sales', 'remote:far:9').count, 1);
  assert.equal(edge('remote:far:9', 'service:far-agent').count, 1);
  assert.ok(d.nodes.some((n) => n.id === 'tool:web' && n.kind === 'tool' && n.label === 'web' && n.count === 2));
  assert.deepEqual(dependencies(store, { from: NOW + 3600000, to: NOW + 7200000 }), { nodes: [], edges: [] });
});
```

Append to `test/trace-registry.test.js` (it already imports `createTrace`):

```js
test('registry: an opened skeleton carries its analysis, rooted at the turn', async () => {
  const t = createTrace({ demo: true });
  const row = t.sessions({ range: 30 }).find((r) => r.source === 'claude');
  const sk = await t.session(row.key);
  const turn = sk.spans.find((s) => s.kind === 'turn');
  assert.equal(sk.analysis.rootSpanId, turn.id);
  assert.ok(sk.analysis.criticalPath.length > 0);
  assert.equal(sk.analysis.rootCause.name, 'execute_tool Bash');
  assert.ok(sk.analysis.rollup[turn.id].costUSD > 0);
  // Filters on duration and cost.
  assert.equal(t.sessions({ range: 30, minCost: 1000 }).length, 0);
  assert.ok(t.sessions({ range: 30, minMs: 1 }).length >= 3);
  // Demo dependencies are a fixed sample.
  assert.ok(t.deps({ range: 7 }).edges.length > 0);
});
```

Append to `test/trace-api.test.js` (add `fakeServer` to the `require('./helpers')` destructuring at the top: `const { secretsFor, NO_JUDGE_PORTS, fakeServer } = require('./helpers');`):

```js
test('trace api: a gateway request is stored without content and opens with its analysis', async () => {
  const upstream = await fakeServer({
    'POST /chat/completions': {
      body: { id: 'chatcmpl-1', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    },
    'GET /models': { body: { data: [{ id: 'm' }] } },
  });
  const data = tmp('zp-trace-api-gw-');
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      gateway: {
        providers: [{ id: 'fake', preset: 'openai', baseUrl: upstream.url, models: [], enabled: true, tier: 'private', approved: true }],
        defaults: { model: 'fake/m' },
      },
    }),
  );
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const apiKey = gw.keys.create({ name: 'trace', scopes: ['llm'], rpm: 60 }).secret;
  gw.flush();
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    const r = await fetch(`${s.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'fake/m', messages: [{ role: 'user', content: 'secret prompt' }] }),
    });
    assert.equal(r.status, 200, await r.text());
    let row;
    for (let i = 0; i < 40 && !row; i++) {
      row = (await c.call('/api/trace/sessions?source=gateway')).json.sessions.find((x) => /^POST \/v1\/chat\/completions/.test(x.title || ''));
      if (!row) await new Promise((res) => setTimeout(res, 250));
    }
    assert.ok(row, 'the stored trace is listed');
    const sk = await c.call(`/api/trace/session?key=${row.key}`);
    assert.equal(sk.status, 200);
    assert.ok(sk.json.spans.some((x) => x.kind === 'chat' && x.model === 'fake/m'));
    assert.equal(sk.json.analysis.rootSpanId, sk.json.spans.find((x) => x.parent == null).id);
    assert.equal((await c.call('/api/trace/sessions?source=gateway&minCost=1000')).json.sessions.length, 0);
    const deps = await c.call('/api/trace/deps?range=1');
    assert.equal(deps.status, 200);
    assert.ok(Array.isArray(deps.json.nodes) && Array.isArray(deps.json.edges));
    for (const b of c.bodies) assert.ok(!b.includes('secret prompt'));
    const dir = path.join(data, '.data', 'traces');
    const segs = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f));
    assert.ok(segs.length > 0);
    for (const f of segs) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('secret prompt'));
    noPaths(c.bodies);
  } finally {
    await s.stop();
    await upstream.close();
  }
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/trace-deps.test.js test/trace-registry.test.js test/trace-api.test.js`
Expected: FAIL: `Cannot find module '../lib/trace/deps'`, `sk.analysis` undefined, `t.deps is not a function`, `/api/trace/deps` answers 404.

- [ ] **Step 3: Implement the dependency map** (`lib/trace/deps.js`)

```js
// Which agents call which models, tools, agents and remote services, over the stored traces in a time range
// (Jaeger's GetDependencies). A remote service that sent spans back appears behind the call that reached it.
const { maskTitle } = require('./model');

function nodeOf(sp) {
  const a = sp.a || {};
  const op = a['gen_ai.operation.name'];
  if (sp.src === 'remote' || (sp.svc && sp.svc !== 'zaafpulse')) return `service:${sp.svc}`;
  if (sp.k === 'client' && a['rpc.system'] === 'a2a') return `remote:${a['server.address'] || sp.n}`;
  if (op === 'invoke_agent' || sp.n.startsWith('invoke_agent ')) return `agent:${a['gen_ai.agent.id'] || sp.n.slice(13)}`;
  if (op === 'chat' || sp.n.startsWith('chat ')) return `model:${a['gen_ai.request.model'] || sp.n.slice(5)}`;
  if (op === 'execute_tool' || sp.n.startsWith('execute_tool ')) return `tool:${a['gen_ai.tool.name'] || sp.n.slice(13)}`;
  return null;
}
const CALLERS = /^(agent|remote):/;

function dependencies(store, { from = 0, to = Infinity, limit = 500 } = {}) {
  const pool = store
    .summaries()
    .filter((s) => s.end >= from * 1000 && s.start <= to * 1000)
    .sort((a, b) => b.start - a.start)
    .slice(0, limit);
  const nodes = new Map();
  const edges = new Map();
  for (const s of pool) {
    const spans = store.getSpans(s.traceId) || [];
    const byId = new Map(spans.map((x) => [x.s, x]));
    for (const sp of spans) {
      const to = nodeOf(sp);
      if (!to) continue;
      const [kind, ...rest] = to.split(':');
      const node = nodes.get(to) || { id: to, kind, label: maskTitle(rest.join(':')) || kind, count: 0 };
      node.count++;
      nodes.set(to, node);
      // The caller: the nearest agent or remote call above, skipping a tool that wraps another tool.
      let caller = null;
      for (let p = byId.get(sp.p), i = 0; p && i < 100; p = byId.get(p.p), i++) {
        const n = nodeOf(p);
        if (n && CALLERS.test(n)) {
          caller = n;
          break;
        }
      }
      if (!caller || caller === to) continue;
      const k = `${caller}\n${to}`;
      const e = edges.get(k) || { from: caller, to, count: 0, errors: 0, ms: [] };
      e.count++;
      if (!sp.ok) e.errors++;
      e.ms.push(sp.d / 1000);
      edges.set(k, e);
    }
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => b.count - a.count),
    edges: [...edges.values()]
      .map(({ ms, ...e }) => {
        ms.sort((a, b) => a - b);
        return { ...e, p95Ms: ms[Math.max(0, Math.ceil(ms.length * 0.95) - 1)] };
      })
      .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
  };
}

module.exports = { dependencies, nodeOf };
```

Note that the edge ids keep the raw names (they identify a node; the explorer page shows the masked `label` of each node).

- [ ] **Step 4: Run the deps test**

Run: `node --test test/trace-deps.test.js`
Expected: PASS.

- [ ] **Step 5: Analysis, filters and deps in the registry** (`lib/trace/index.js`)

Next to the other requires at the top, add:

```js
const { adjust } = require('./adjust');
const { analyze } = require('./analyze');
const { dependencies } = require('./deps');
```

In `seal`, replace

```js
    const sealed = deepFreeze(structuredClone({ session, turns, spans }));
```

with

```js
    // Jaeger's analysis of what the client sees, once per build, cached with the skeleton. A skeleton that holds
    // one turn of a longer session is analysed from that turn.
    let analysis = null;
    try {
      const turnSpans = spans.filter((s) => s.kind === 'turn');
      analysis = analyze(adjust(spans), { rootId: turnSpans.length === 1 ? turnSpans[0].id : undefined });
    } catch {
      analysis = null; // the spans still show without it
    }
    const sealed = deepFreeze(structuredClone({ session, turns, spans, analysis }));
```

Replace the head of `sessions`

```js
  function sessions({ range, source, q, flags } = {}) {
```

with

```js
  function sessions({ range, source, q, flags, minMs, minCost } = {}) {
```

and after the line `      if (flags === 'errors' && !(base.errors > 0 || base.flags.errors)) continue;` add:

```js
      if (minMs > 0 && !(base.end - base.start >= minMs)) continue;
      if (minCost > 0 && !(base.cost >= minCost)) continue;
```

Directly before `  // What the page should say up front (S10)`, add:

```js
  // Dependencies between agents, models, tools and remote services over the stored gateway traces.
  function deps({ range } = {}) {
    if (demo) return structuredClone(demoData.deps);
    if (!opts.traceStore) return { nodes: [], edges: [] };
    const days = Number(range) > 0 ? Number(range) : 7;
    return dependencies(opts.traceStore, { from: Date.now() - days * DAY, to: Date.now() });
  }

```

and add `deps,` to the returned object after `sessions,`.

- [ ] **Step 6: A demo sample** (`lib/demo.js`)

In `traceDemo`, replace

```js
    skeletons: { [claudeSk.session.id]: claudeSk, [codexSk.session.id]: codexSk, [kiroSk.session.id]: kiroSk },
    content,
  };
```

with

```js
    skeletons: { [claudeSk.session.id]: claudeSk, [codexSk.session.id]: codexSk, [kiroSk.session.id]: kiroSk },
    content,
    // The dependency table of a week of gateway runs.
    deps: {
      nodes: [
        { id: 'agent:customer-service', kind: 'agent', label: 'customer-service', count: 42 },
        { id: 'agent:hr-finance', kind: 'agent', label: 'hr-finance', count: 17 },
        { id: 'model:openai/gpt-6.1-mini', kind: 'model', label: 'openai/gpt-6.1-mini', count: 96 },
        { id: 'tool:zp_handoff', kind: 'tool', label: 'zp_handoff', count: 17 },
        { id: 'tool:dynatrace_list_problems', kind: 'tool', label: 'dynatrace_list_problems', count: 9 },
        { id: 'remote:agents.example.com', kind: 'remote', label: 'agents.example.com', count: 4 },
      ],
      edges: [
        { from: 'agent:customer-service', to: 'model:openai/gpt-6.1-mini', count: 71, errors: 2, p95Ms: 2310 },
        { from: 'agent:customer-service', to: 'tool:zp_handoff', count: 17, errors: 0, p95Ms: 4 },
        { from: 'agent:hr-finance', to: 'model:openai/gpt-6.1-mini', count: 25, errors: 0, p95Ms: 1980 },
        { from: 'agent:hr-finance', to: 'tool:dynatrace_list_problems', count: 9, errors: 1, p95Ms: 840 },
        { from: 'agent:customer-service', to: 'remote:agents.example.com', count: 4, errors: 1, p95Ms: 5120 },
      ],
    },
  };
```

- [ ] **Step 7: Routes** (`server.js`)

In the `/api/trace/` block, replace

```js
      if (!['sources', 'settings', 'sessions', 'session', 'title', 'content', 'reveal', 'live', 'find'].includes(route))
```

with

```js
      if (
        !['sources', 'settings', 'sessions', 'session', 'title', 'content', 'reveal', 'live', 'find', 'deps'].includes(route)
      )
```

Replace

```js
          const rows = trace.sessions({
            range,
            source: q.get('source') || undefined,
            q: q.get('q') || undefined,
            flags: q.get('flags') || undefined,
          });
          return send(res, 200, { sessions: rows });
        }
```

with

```js
          const minMs = Number(q.get('minMs'));
          const minCost = Number(q.get('minCost'));
          const rows = trace.sessions({
            range,
            source: q.get('source') || undefined,
            q: q.get('q') || undefined,
            flags: q.get('flags') || undefined,
            minMs: Number.isFinite(minMs) && minMs > 0 ? minMs : undefined,
            minCost: Number.isFinite(minCost) && minCost > 0 ? minCost : undefined,
          });
          return send(res, 200, { sessions: rows });
        }
        if (route === 'deps') {
          const days = parseInt(q.get('range'), 10);
          return send(res, 200, trace.deps({ range: Number.isNaN(days) ? 7 : Math.min(30, Math.max(1, days)) }));
        }
```

- [ ] **Step 8: Run the tests and see them pass**

Run: `node --test test/trace-deps.test.js test/trace-registry.test.js test/trace-api.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/trace/deps.js lib/trace/index.js lib/demo.js server.js test/trace-deps.test.js test/trace-registry.test.js test/trace-api.test.js
git commit -m "Analyse every opened trace and map gateway dependencies"
```

### Task 11: The explorer page shows the analysis and the dependencies

**Files:**
- Modify: `public/traceview.js`, `public/styles.css`, `test/trace-ui.test.js`

**Interfaces:**
- Consumes: `analysis` on the session response (Task 10), `GET /api/trace/deps` (Task 10).
- Produces (pure, exported for tests): `trCritical(analysis) → Set<spanId>`, `trCpMs(analysis) → ms`, `trSpanFacts(analysis, spanId) → string[]`, `trCause(analysis, spansMap) → { id, line } | null`, `trDepRows(deps) → string[][]` (cells: from, to, calls, failures, p95).

- [ ] **Step 1: Write the failing test**

In `test/trace-ui.test.js`, add `trCritical, trCpMs, trSpanFacts, trCause, trDepRows,` to the destructuring of `require('../public/traceview.js')`, then append:

```js
test('analysis helpers: critical path, span facts, cause and dependency rows', () => {
  const an = {
    rootSpanId: 'r',
    criticalPath: [
      { spanId: 'r', start: 0, end: 100 },
      { spanId: 'b', start: 100, end: 1600 },
    ],
    selfTime: { r: 100, b: 1500 },
    rollup: { r: { tokensIn: 12000, tokensOut: 800, costUSD: 0.25, spans: 4, errors: 1 }, b: { tokensIn: 0, tokensOut: 0, costUSD: 0, spans: 1, errors: 1 } },
    rootCause: { spanId: 'b', name: 'execute_tool Bash', error: 'Exit code 1', onCriticalPath: true },
  };
  assert.deepEqual([...trCritical(an)], ['r', 'b']);
  assert.equal(trCritical(null).size, 0);
  assert.equal(trCpMs(an), 1600);
  assert.equal(trCpMs(null), 0);
  assert.deepEqual(trSpanFacts(an, 'r'), ['self 100 ms', 'branch $0.25 12k → 800 tok 1 error', 'on the critical path']);
  assert.deepEqual(trSpanFacts(an, 'b'), ['self 1.5 s', 'on the critical path']);
  assert.deepEqual(trSpanFacts(null, 'b'), []);
  const spans = new Map([['b', { id: 'b', kind: 'tool', name: 'execute_tool Bash' }]]);
  assert.deepEqual(trCause(an, spans), { id: 'b', line: 'Likely cause: execute_tool · Bash: Exit code 1 (on the critical path)' });
  assert.equal(trCause({ ...an, rootCause: null }, spans), null);
  assert.deepEqual(
    trDepRows({
      nodes: [
        { id: 'agent:a', kind: 'agent', label: 'a', count: 1 },
        { id: 'model:m', kind: 'model', label: 'm', count: 1 },
      ],
      edges: [{ from: 'agent:a', to: 'model:m', count: 3, errors: 1, p95Ms: 2300 }],
    }),
    [['agent a', 'model m', '3', '1', '2.3 s']],
  );
  assert.deepEqual(trDepRows(null), []);
});

test('the analysis UI fills the cause and the dependency table with text only (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /\$\('#tr-cause-msg'\)\.textContent = /);
  assert.match(src, /insertCell\(\)\.textContent = /);
  assert.doesNotMatch(src, /innerHTML[^;\n]*\b(trDepRows|trCause|cells)\b/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-ui.test.js`
Expected: FAIL, `trCritical is not a function`.

- [ ] **Step 3: Add the pure helpers** (`public/traceview.js`)

Directly after the `trBadges` function, add:

```js
// The analysis from /api/trace/session (lib/trace/analyze.js), as the tree and the detail use it.
function trCritical(an) {
  return new Set(an && Array.isArray(an.criticalPath) ? an.criticalPath.map((x) => x.spanId) : []);
}
const trCpMs = (an) =>
  an && Array.isArray(an.criticalPath) ? an.criticalPath.reduce((n, x) => n + (x.end - x.start), 0) : 0;
// One span's self time, its branch totals (for a span with children) and whether it decides the duration.
function trSpanFacts(an, id) {
  if (!an || typeof id !== 'string') return [];
  const out = [];
  const self = an.selfTime && an.selfTime[id];
  if (Number.isFinite(self)) out.push(`self ${fmtDur(self)}`);
  const r = an.rollup && an.rollup[id];
  if (r && r.spans > 1) {
    const b = [];
    if (r.costUSD > 0) b.push(trUsd(r.costUSD));
    if (r.tokensIn + r.tokensOut > 0) b.push(`${trTok(r.tokensIn)} → ${trTok(r.tokensOut)} tok`);
    if (r.errors) b.push(`${r.errors} error${r.errors === 1 ? '' : 's'}`);
    if (b.length) out.push(`branch ${b.join(' ')}`);
  }
  if (trCritical(an).has(id)) out.push('on the critical path');
  return out;
}
// The likely root cause as one line; the error is a masked status message, shown as text.
function trCause(an, spans) {
  const c = an && an.rootCause;
  if (!c || typeof c.spanId !== 'string') return null;
  const s = spans && typeof spans.get === 'function' ? spans.get(c.spanId) : null;
  const name = s ? trLabel(s) : String(c.name || 'span');
  const why = c.error ? `: ${c.error}` : '';
  return { id: c.spanId, line: `Likely cause: ${name}${why}${c.onCriticalPath ? ' (on the critical path)' : ''}` };
}
// The dependency table as text cells: from, to, calls, failures, p95.
function trDepRows(deps) {
  const nodes = deps && Array.isArray(deps.nodes) ? deps.nodes : [];
  const name = new Map(nodes.map((n) => [n.id, `${n.kind} ${n.label}`]));
  return (deps && Array.isArray(deps.edges) ? deps.edges : []).map((e) => [
    name.get(e.from) || String(e.from),
    name.get(e.to) || String(e.to),
    String(e.count),
    String(e.errors),
    fmtDur(e.p95Ms),
  ]);
}
```

Add `trCritical, trCpMs, trSpanFacts, trCause, trDepRows,` to the `module.exports` object at the end of the file.

- [ ] **Step 4: Run the helper test**

Run: `node --test test/trace-ui.test.js`
Expected: the helper test passes; the "text only" test still fails (the UI is not wired yet).

- [ ] **Step 5: Markup** (`public/traceview.js`, in `viewTrace`)

Replace

```js
        <div class="tr-notice tr-off" id="tr-off" role="status" hidden></div>
```

with

```js
        <div class="tr-notice tr-off" id="tr-off" role="status" hidden></div>
        <div class="tr-notice tr-cause" id="tr-cause" role="status" hidden><span id="tr-cause-msg"></span><button type="button" class="tr-btn ghost" id="tr-cause-go">Show</button></div>
```

Replace

```js
      <div class="tr-rtitle"><div class="tr-eyebrow">Session map</div><h2 id="tr-mtitle">From Prompt to Answer</h2></div>
```

with

```js
      <div class="tr-rtitle"><div class="tr-eyebrow">Session map</div><h2 id="tr-mtitle">From Prompt to Answer</h2></div>
      <div class="tr-seg" role="group" aria-label="Right panel"><button type="button" data-tview="map" class="on" aria-pressed="true">Map</button><button type="button" data-tview="deps" aria-pressed="false">Dependencies</button></div>
```

Replace

```js
    <div class="tr-map" id="tr-map"><svg class="tr-wires" id="tr-wires" aria-hidden="true"></svg></div>
```

with

```js
    <div class="tr-map" id="tr-map"><svg class="tr-wires" id="tr-wires" aria-hidden="true"></svg></div>
    <div class="tr-deps" id="tr-deps" tabindex="0" aria-label="Dependencies between agents, models, tools and remote services" hidden></div>
```

- [ ] **Step 6: State and painting** (`public/traceview.js`, in `mountTrace`)

In the `S` object, replace `    contentOff: false,` with:

```js
    contentOff: false,
    an: null, // the analysis of the skeleton on show
    cp: new Set(), // its critical path span ids
    view: 'map', // the right half: the map or the dependency table
```

In `clearTurn`, directly after `    S.sk = null;` add:

```js
    S.an = null;
    S.cp = new Set();
    $('#tr-cause').hidden = true;
```

In `paintSkeleton`, replace

```js
    S.spans = new Map(sk.spans.map((s) => [s.id, s]));
```

with

```js
    S.spans = new Map(sk.spans.map((s) => [s.id, s]));
    S.an = sk.analysis || null;
    S.cp = trCritical(S.an);
```

Replace

```js
    if (input + cached) sum.push(`cache hit ${Math.round((cached / (input + cached)) * 100)}%`);
```

with

```js
    if (input + cached) sum.push(`cache hit ${Math.round((cached / (input + cached)) * 100)}%`);
    if (trCpMs(S.an) > 0) sum.push(`critical path ${fmtDur(trCpMs(S.an))}`);
```

Replace

```js
    $('#tr-next').disabled = S.turn >= turns - 1;
```

with

```js
    $('#tr-next').disabled = S.turn >= turns - 1;
    paintCause();
```

Directly before `  // The session's time window, for the timeline bars.` add:

```js
  // The likely root cause above the tree, with a button that selects it.
  function paintCause() {
    const c = S.sk ? trCause(S.an, S.spans) : null;
    $('#tr-cause').hidden = !c;
    $('#tr-cause-msg').textContent = c ? c.line : '';
  }

  // The right half: the session map, or the dependency table of the chosen time range.
  function showView(v) {
    S.view = v === 'deps' ? 'deps' : 'map';
    for (const b of $$('[data-tview]', app)) {
      const on = b.dataset.tview === S.view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    $('#tr-map').hidden = S.view !== 'map';
    $('.tr-legend', app).hidden = S.view !== 'map';
    $('#tr-deps').hidden = S.view !== 'deps';
    if (S.view === 'deps') loadDeps();
  }
  async function loadDeps() {
    const box = $('#tr-deps');
    box.textContent = 'Loading dependencies…';
    let d;
    try {
      d = await trApi(`/api/trace/deps?range=${encodeURIComponent(S.range)}`);
    } catch (e) {
      if (S.alive) box.textContent = `Dependencies are not available: ${e.message}`;
      return;
    }
    if (!S.alive || S.view !== 'deps') return;
    const rows = trDepRows(d);
    if (!rows.length) {
      box.textContent = 'No agent calls in this range. Dependencies come from Agent Gateway traces.';
      return;
    }
    const table = document.createElement('table');
    table.className = 'tr-dtable';
    const head = table.createTHead().insertRow();
    for (const h of ['From', 'To', 'Calls', 'Failures', 'p95']) {
      const th = document.createElement('th');
      th.textContent = h;
      head.appendChild(th);
    }
    const tb = table.createTBody();
    for (const cells of rows) {
      const tr = tb.insertRow();
      for (const c of cells) tr.insertCell().textContent = c;
    }
    box.replaceChildren(table);
  }

```

In `rowHtml`, replace

```js
    return `<div class="tr-row${on ? ' on' : ''}${r.placeholder ? ' dim' : ''}"
```

with

```js
    return `<div class="tr-row${on ? ' on' : ''}${r.placeholder ? ' dim' : ''}${S.cp.has(r.id) ? ' cp' : ''}"
```

(the rest of that line stays as it is).

In `paintDetail`, replace

```js
    if (Number.isFinite(s.cost) && s.cost > 0) meta.push(trUsd(s.cost));
```

with

```js
    if (Number.isFinite(s.cost) && s.cost > 0) meta.push(trUsd(s.cost));
    meta.push(...trSpanFacts(S.an, s.id));
```

In the `app.addEventListener('click', …)` handler, replace

```js
      return void loadSessions();
    }
    if ((el = q('[data-tsrc]'))) {
```

with

```js
      if (S.view === 'deps') loadDeps();
      return void loadSessions();
    }
    if ((el = q('[data-tview]'))) return void showView(el.dataset.tview);
    if (q('#tr-cause-go')) {
      if (S.an && S.an.rootCause) select(S.an.rootCause.spanId, { force: true });
      return;
    }
    if ((el = q('[data-tsrc]'))) {
```

- [ ] **Step 7: Styles** (`public/styles.css`)

Directly after the `.tr-row.dim:hover { … }` rule, add:

```css
/* A span on the critical path: its bar is outlined and fully lit. */
.tr-row.cp .tr-track span {
  opacity: 1;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.85),
    0 0 8px var(--c);
}
.tr-notice.tr-cause {
  border-color: rgba(255, 90, 110, 0.45);
  background: rgba(255, 90, 110, 0.08);
  color: #ff8a99;
}
.tr-deps {
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
  color: var(--h-text-2);
  font-size: 12px;
}
.tr-dtable {
  width: 100%;
  border-collapse: collapse;
  font-family: ui-monospace, Menlo, monospace;
}
.tr-dtable th,
.tr-dtable td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--h-edge);
}
.tr-dtable th {
  position: sticky;
  top: 0;
  background: rgba(0, 0, 0, 0.45);
  font-weight: 600;
}
.tr-dtable td:nth-child(n + 3),
.tr-dtable th:nth-child(n + 3) {
  text-align: right;
}
```

- [ ] **Step 8: Run the tests**

Run: `node --test test/trace-ui.test.js`
Expected: PASS (including the existing innerHTML audits).

- [ ] **Step 9: Check it in the browser**

Run: `npm run demo`, open the printed address, go to **Trace explorer**, and open the Claude Code session "fix auth redirect".
Expected:
- the tree header ends with `critical path …`;
- rows on the critical path have an outlined bar;
- a red notice reads `Likely cause: execute_tool · Bash: …`, and **Show** selects that span;
- a span's detail line ends with `self …` (and `branch …` for a span with children);
- **Dependencies** in the right half shows the five demo rows; **Map** brings the map back; switching the time range reloads the table.

- [ ] **Step 10: Commit**

```bash
git add public/traceview.js public/styles.css test/trace-ui.test.js
git commit -m "Show the critical path, root cause and dependencies in the trace explorer"
```

### Task 12: `acc_trace_get` over MCP

**Files:**
- Create: `lib/trace/views.js`, `test/trace-views.test.js`
- Modify: `lib/local.js`, `lib/connectors/acc.js`, `test/mcp.test.js`

**Interfaces:**
- Consumes: sealed skeletons with `analysis` (Task 10).
- Produces: `traceView(skeleton, view, spanId?) → object` for `view` in `topology`, `critical_path`, `errors`, `span` (throws `status` 400 for an unknown view, 404 for an unknown span); `local.traceGet({ key, turn, view, span })`; MCP tool `acc_trace_get`.

- [ ] **Step 1: Write the failing test** (`test/trace-views.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTrace } = require('../lib/trace');
const { traceView } = require('../lib/trace/views');
const { createLocal } = require('../lib/local');

async function demoSkeleton() {
  const t = createTrace({ demo: true });
  const row = t.sessions({ range: 30 }).find((r) => r.source === 'claude');
  return t.session(row.key);
}

test('views: topology, critical path, errors and one span, without text or content ids', async () => {
  const sk = await demoSkeleton();
  const topo = traceView(sk, 'topology');
  assert.equal(topo.spans.length, sk.spans.length);
  assert.equal(topo.truncated, false);
  assert.deepEqual(Object.keys(topo.spans[0]).sort(), ['id', 'kind', 'ms', 'name', 'parent', 'status']);
  const cp = traceView(sk, 'critical_path');
  assert.ok(cp.sections.length > 0);
  assert.ok(cp.totalMs > 0);
  const err = traceView(sk, 'errors');
  assert.equal(err.rootCause.name, 'execute_tool Bash');
  assert.ok(err.failed.some((f) => f.name === 'execute_tool Bash'));
  const bash = sk.spans.find((s) => s.name === 'execute_tool Bash' && s.status === 'error');
  const one = traceView(sk, 'span', bash.id);
  assert.equal(one.onCriticalPath, true);
  assert.deepEqual(one.tool, { name: 'Bash' });
  assert.ok(Number.isFinite(one.selfMs));
  for (const v of [topo, cp, err, one]) assert.doesNotMatch(JSON.stringify(v), /ci_[0-9a-f]{16}|FAIL src|apiKey|"text"|"result"/);
  assert.throws(() => traceView(sk, 'span', 'nope'), /unknown span/);
  assert.throws(() => traceView(sk, 'everything'), /view must be/);
});

test('local.traceGet reads a session that traceSessions listed', async () => {
  const indexer = { version: 1, state: {}, results: () => [], refresh: async () => {} };
  const local = createLocal({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-views-')), indexer, contentOff: true, demo: true });
  const row = (await local.traceSessions({})).find((r) => r.source === 'claude');
  const r = await local.traceGet({ key: row.key, view: 'errors' });
  assert.equal(r.rootCause.name, 'execute_tool Bash');
});
```

In `test/mcp.test.js`, add `'acc_trace_get',` after `'acc_trace_sessions',` in the list of expected tool names.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/trace-views.test.js test/mcp.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/views'`; `acc_trace_get` missing.

- [ ] **Step 3: Implement the views** (`lib/trace/views.js`)

```js
// Small views of one explorer skeleton for an AI client (acc_trace_get), shaped like Jaeger's MCP tools: the
// topology first, then the critical path, the errors, or one span. Never text, content ids or file paths.
const MAX_SPANS = 2000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const msOf = (s) => (Number.isFinite(s.start) && Number.isFinite(s.end) ? Math.round(s.end - s.start) : null);

function traceView(sk, view, spanId) {
  const spans = Array.isArray(sk && sk.spans) ? sk.spans : [];
  const an = (sk && sk.analysis) || null;
  const byId = new Map(spans.map((s) => [s.id, s]));
  const onPath = new Set(an ? an.criticalPath.map((x) => x.spanId) : []);
  if (view === 'topology')
    return {
      spans: spans.slice(0, MAX_SPANS).map((s) => ({ id: s.id, parent: s.parent, kind: s.kind, name: s.name, ms: msOf(s), status: s.status })),
      truncated: spans.length > MAX_SPANS,
    };
  if (view === 'critical_path') {
    const sections = (an ? an.criticalPath : []).map((x) => ({
      id: x.spanId,
      name: byId.has(x.spanId) ? byId.get(x.spanId).name : null,
      ms: Math.round(x.end - x.start),
    }));
    return { totalMs: sections.reduce((n, x) => n + x.ms, 0), sections };
  }
  if (view === 'errors')
    return {
      rootCause: an ? an.rootCause : null,
      failed: spans
        .filter((s) => s.status === 'error')
        .map((s) => ({ id: s.id, parent: s.parent, name: s.name, ms: msOf(s), error: typeof s.error === 'string' ? s.error : null })),
    };
  if (view === 'span') {
    const s = byId.get(spanId);
    if (!s) throw fail(404, 'unknown span: take an id from the topology view');
    return {
      id: s.id,
      parent: s.parent,
      kind: s.kind,
      name: s.name,
      start: s.start,
      end: s.end,
      ms: msOf(s),
      status: s.status,
      model: s.model || null,
      provider: s.provider || null,
      usage: s.usage || null,
      cost: s.cost ?? null,
      tool: s.tool && s.tool.name ? { name: s.tool.name } : null,
      error: typeof s.error === 'string' ? s.error : null,
      selfMs: an && an.selfTime && Number.isFinite(an.selfTime[s.id]) ? Math.round(an.selfTime[s.id]) : null,
      rollup: (an && an.rollup && an.rollup[s.id]) || null,
      onCriticalPath: onPath.has(s.id),
    };
  }
  throw fail(400, 'view must be topology, critical_path, errors or span');
}

module.exports = { traceView };
```

- [ ] **Step 4: Expose it** (`lib/local.js`, `lib/connectors/acc.js`)

`lib/local.js`: after `const { createTrace, contentDefaultOff } = require('./trace');` add `const { traceView } = require('./trace/views');`. In the returned object, directly after the `traceSessions` method (after its closing `},`), add:

```js
    // One session that traceSessions listed, in small views (lib/trace/views.js): structure, timing and status
    // only. Its key must come from this process.
    async traceGet({ key, turn, view, span } = {}) {
      const trace = await getTrace();
      const t = Number.isInteger(turn) && turn >= 0 ? turn : undefined;
      return traceView(await trace.session(String(key || ''), { turn: t }), view, span);
    },
```

`lib/connectors/acc.js`: directly before the line `          'evals',` (the start of the `evals` tool, whose `tool(` line stays where it is), insert a new tool so that the code reads:

```js
        tool(
          'trace_get',
          'One session from acc_trace_sessions, in small views. Start with topology (span ids, parents, kinds, names, durations, statuses), then critical_path (the sections that decide how long it took), errors (failed spans and the likely root cause), or span (one span: model, tool name, tokens, cost, self time, branch totals; pass span). No transcript text, content ids or file paths. Use a key from acc_trace_sessions of this same ZAAFPulse process.',
          {
            key: { type: 'string', maxLength: 200, description: 'A key from acc_trace_sessions' },
            turn: { type: 'integer', minimum: 0, description: 'Turn index; the last turn when left out' },
            view: { type: 'string', enum: ['topology', 'critical_path', 'errors', 'span'], description: 'What to return' },
            span: { type: 'string', maxLength: 64, description: 'A span id from the topology view (view span only)' },
          },
          ({ key, turn, view, span }) => local.traceGet({ key, turn, view, span }),
          { required: ['key', 'view'] },
        ),
        tool(
          'evals',
```

(That is: the new `tool('trace_get', …)` call goes between the `trace_sessions` tool and the `evals` tool.)

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/trace-views.test.js test/mcp.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/trace/views.js lib/local.js lib/connectors/acc.js test/trace-views.test.js test/mcp.test.js
git commit -m "Add acc_trace_get: a session's topology, critical path, errors and spans over MCP"
```

---

# Phase 5: Across processes

Result of the phase: a remote A2A agent or an MCP server over Streamable HTTP receives the W3C `traceparent` of the call that reached it; one that exports OpenTelemetry can send its spans back to this ZAAFPulse, which keeps them in the same trace; the documentation describes all of it.

### Task 13: `traceparent` to remote agents and MCP servers

**Files:**
- Modify: `lib/otel.js`, `lib/gateway/orchestrator.js`, `lib/integrations.js`, `lib/connectors/mcp-proxy.js`, `lib/mcp/client.js`
- Create: `test/trace-propagate.test.js`

**Interfaces:**
- Consumes: `spanBook`, `within` (Tasks 5 and 6), `live` (Task 4).
- Produces: module `otel.startSpan(name, opts) → span | null` (null while nothing records spans), module `otel.KIND`; `otel.toolCall(...)` returns `{ end, traceparent }` (`traceparent` is `null` when not recording); connector tool `run(args, meta = {})`; MCP client `callTool(name, args, meta = {})` sending header `traceparent` and `params._meta.traceparent` when `meta.traceparent` is set; a CLIENT span `a2a <agent id>` (`rpc.system: a2a`, `server.address`, `gen_ai.agent.id`) around every remote agent call.

- [ ] **Step 1: Write the failing test** (`test/trace-propagate.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const otel = require('../lib/otel');
const { createOrchestrator } = require('../lib/gateway/orchestrator');
const { createClient } = require('../lib/mcp/client');
const { createIntegrations } = require('../lib/integrations');
const { tool } = require('../lib/connectors/base');
const { secretsFor } = require('./helpers');

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
function recording() {
  const got = [];
  otel.init({ getConfig: () => ({}), env: {}, refreshMs: 0, log: () => {}, sink: { enabled: () => true, add: (r) => got.push(r) } });
  return got;
}

test('propagation: a remote A2A agent gets the traceparent of a client span under its agent span', async () => {
  const got = recording();
  let headers = null;
  try {
    const orch = createOrchestrator({
      agents: { enabled: () => [], get: () => null },
      memory: { recall: () => [] },
      integrations: null,
      llm: async () => {
        throw new Error('not used');
      },
      getDefaults: () => ({ model: 'x' }),
      fetchImpl: async (url, init) => {
        headers = init.headers;
        return { json: async () => ({ result: { message: { parts: [{ text: 'pong' }] } } }) };
      },
    });
    const r = await orch.runAgent({ id: 'far', name: 'Far', remoteUrl: 'http://127.0.0.1:9/a2a', tools: [] }, 'ping', {});
    assert.equal(r.text, 'pong');
    const client = got.find((s) => s.name === 'a2a far');
    const agent = got.find((s) => s.name === 'invoke_agent far');
    assert.equal(client.kind, 3);
    assert.equal(client.parentSpanId, agent.spanId);
    assert.equal(client.attributes['server.address'], '127.0.0.1:9');
    assert.equal(client.attributes['rpc.system'], 'a2a');
    assert.equal(headers.traceparent, `00-${client.traceId}-${client.spanId}-01`);
  } finally {
    await otel.reset();
  }
});

test('propagation: no recording, no header', async () => {
  let headers = null;
  const orch = createOrchestrator({
    agents: { enabled: () => [], get: () => null },
    memory: { recall: () => [] },
    integrations: null,
    llm: async () => ({}),
    getDefaults: () => ({ model: 'x' }),
    fetchImpl: async (url, init) => {
      headers = init.headers;
      return { json: async () => ({ result: { message: { parts: [{ text: 'pong' }] } } }) };
    },
  });
  await orch.runAgent({ id: 'far', name: 'Far', remoteUrl: 'http://127.0.0.1:9/a2a', tools: [] }, 'ping', {});
  assert.equal(headers.traceparent, undefined);
});

test('propagation: the MCP client sends traceparent as a header and in _meta, only when given', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, header: req.headers.traceparent, meta: msg.params && msg.params._meta });
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'up', version: '1' } } }));
      }
      if (!('id' in msg)) {
        res.writeHead(202);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = createClient({ url: `http://127.0.0.1:${server.address().port}/mcp` });
    await client.callTool('echo', {}, { traceparent: TP });
    await client.callTool('echo', {});
    const calls = seen.filter((s) => s.method === 'tools/call');
    assert.deepEqual(calls[0], { method: 'tools/call', header: TP, meta: { traceparent: TP } });
    assert.deepEqual(calls[1], { method: 'tools/call', header: undefined, meta: undefined });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('propagation: an integration tool gets the traceparent of its own execute_tool span', async () => {
  const got = recording();
  try {
    let meta = null;
    const fake = {
      type: 'fake',
      create: () => ({
        tools: [
          tool('echo', 'Echo', {}, async (args, m) => {
            meta = m;
            return 'ok';
          }),
        ],
        health: async () => ({ ok: true, latencyMs: 0 }),
      }),
    };
    const accFake = { type: 'acc', create: () => ({ tools: [], health: async () => ({ ok: true, latencyMs: 0 }) }) };
    const reg = createIntegrations({ config: { integrations: { f: { type: 'fake' } } }, secrets: secretsFor(), connectors: { fake, acc: accFake } });
    await reg.callTool('f_echo', {});
    const span = got.find((s) => s.name === 'execute_tool f_echo');
    assert.equal(meta.traceparent, `00-${span.traceId}-${span.spanId}-01`);
  } finally {
    await otel.reset();
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-propagate.test.js`
Expected: FAIL: no `a2a far` span, no `traceparent` header, `callTool` ignores its third argument, `meta` undefined.

- [ ] **Step 3: OTel helpers** (`lib/otel.js`)

In `toolCall`, replace

```js
      return {
        end(ok, result) {
```

with

```js
      return {
        // Sent on to an MCP server, so a server that traces continues this span.
        traceparent: formatTraceparent(span.context),
        end(ok, result) {
```

and replace `  const NOOP = { end() {} };` with `  const NOOP = { end() {}, traceparent: null };`.

In `module.exports`, replace

```js
  toolCall: (name, entry, args) => (instance ? instance.toolCall(name, entry, args) : { end() {} }),
```

with

```js
  toolCall: (name, entry, args) => (instance ? instance.toolCall(name, entry, args) : { end() {}, traceparent: null }),
  // A span the caller ends itself; null while nothing records spans.
  startSpan: (name, opts) => (instance && instance.live() ? instance.startSpan(name, opts) : null),
  KIND,
```

- [ ] **Step 4: The A2A client span** (`lib/gateway/orchestrator.js`)

Replace

```js
  async function runRemote(agent, input, ctx) {
```

with

```js
  // The remote call runs under the calling agent's span, so its client span nests there.
  async function runRemote(agent, input, ctx) {
    const tr = ctx.run || ctx.tracer;
    const go = () => callRemote(agent, input, ctx);
    return tr ? tr.within(ctx.span, go) : go();
  }

  async function callRemote(agent, input, ctx) {
```

Directly after the line `    const token = tokenOk ? env[agent.remoteTokenEnv] : null;` add:

```js
    // A CLIENT span for the call; its traceparent goes with the request so a tracing agent continues it.
    let host = '';
    try {
      host = new URL(agent.remoteUrl).host;
    } catch {
      /* the URL was checked when the agent was saved */
    }
    const cs = otel.startSpan(`a2a ${agent.id}`, {
      kind: otel.KIND.CLIENT,
      attributes: { 'rpc.system': 'a2a', 'server.address': host, 'gen_ai.agent.id': agent.id },
    });
    const traceparent = cs ? otel.formatTraceparent(cs.context) : null;
```

After the line ``            ...(token ? { authorization: `Bearer ${token}` } : {}),`` add:

```js
            ...(traceparent ? { traceparent } : {}),
```

Replace

```js
    if (j.error)
      throw Object.assign(new Error(`remote agent ${agent.id}: ${j.error.message || 'error'}`), { status: 502 });
```

with

```js
    if (j.error) {
      if (cs) cs.fail('remote_error', String(j.error.message || 'error')).end();
      throw Object.assign(new Error(`remote agent ${agent.id}: ${j.error.message || 'error'}`), { status: 502 });
    }
```

Directly after the line `    const state = task && task.status ? String(task.status.state || '') : '';` add:

```js
    if (cs) {
      if (state) cs.setAttribute('zaafpulse.remote.state', state);
      cs.end();
    }
```

- [ ] **Step 5: Carry it to the MCP server**

`lib/integrations.js`: replace `      result = okResult(await t.run(args));` with

```js
      result = okResult(await t.run(args, span.traceparent ? { traceparent: span.traceparent } : {}));
```

`lib/connectors/mcp-proxy.js`: replace

```js
          run: async (args) => {
            const r = await client.callTool(t.name, args);
```

with

```js
          run: async (args, meta = {}) => {
            const r = await client.callTool(t.name, args, meta);
```

`lib/mcp/client.js`:
- replace `  async function post(msg) {` with `  async function post(msg, extra = {}) {`;
- in its headers, replace the line `          ...headers,` with
  ```js
          ...headers,
          ...extra,
  ```
- replace the whole `request` function with
  ```js
  async function request(method, params, extra = {}) {
    await initialize();
    try {
      return await post({ jsonrpc: '2.0', id: nextId++, method, params }, extra);
    } catch (err) {
      if (!/HTTP 404/.test(err.message) || !session) throw err;
      session = null;
      ready = null; // session expired upstream: start a new one once
      await initialize();
      return post({ jsonrpc: '2.0', id: nextId++, method, params }, extra);
    }
  }
  ```
- replace the last `return` line of `createClient` with
  ```js
  // meta.traceparent goes as a header and in _meta, so HTTP-level and MCP-aware servers can both continue it.
  const callTool = (name, args, meta = {}) =>
    request(
      'tools/call',
      { name, arguments: args || {}, ...(meta.traceparent ? { _meta: { traceparent: meta.traceparent } } : {}) },
      meta.traceparent ? { traceparent: meta.traceparent } : {},
    );
  return { initialize, listTools, callTool };
  ```

- [ ] **Step 6: Run the tests**

Run: `node --test test/trace-propagate.test.js`
Expected: PASS, 4 tests.

Run: `npm test`
Expected: PASS (MCP proxy, integrations, A2A and orchestrator tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add lib/otel.js lib/gateway/orchestrator.js lib/integrations.js lib/connectors/mcp-proxy.js lib/mcp/client.js test/trace-propagate.test.js
git commit -m "Propagate traceparent to remote A2A agents and MCP servers"
```

### Task 14: OTLP return channel

**Files:**
- Create: `lib/trace/otlp.js`, `test/trace-otlp.test.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: `recorder.knows`, `recorder.ingest` (Task 3).
- Produces: `createReceiver({ recorder, maxPerTrace = 2000 }) → { receive(body) → {} | { partialSuccess: { rejectedSpans, errorMessage } } }`; route `POST /v1/traces` (OTLP/HTTP JSON, from this machine only).

- [ ] **Step 1: Write the failing test** (`test/trace-otlp.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReceiver } = require('../lib/trace/otlp');
const { createRecorder } = require('../lib/trace/recorder');

const T = '4bf92f3577b34da6a3ce929d0e0e4736';
const CLIENT = '00f067aa0ba902b7';
const memStore = () => {
  const spans = [];
  return { spans, writeSpans: (l) => (spans.push(...l), l.length) };
};
function known() {
  const store = memStore();
  const recorder = createRecorder({ store, flushMs: 0 });
  // The recorder saw this trace go out (the a2a client span).
  recorder.add({ traceId: T, spanId: CLIENT, parentSpanId: '', name: 'a2a far', kind: 3, startNs: 1n, endNs: 2n, attributes: {}, status: { code: 0 } });
  recorder.flush();
  store.spans.length = 0;
  return { store, recorder };
}
const span = (traceId, spanId, extra = {}) => ({
  traceId,
  spanId,
  parentSpanId: CLIENT,
  name: 'handle',
  kind: 2,
  startTimeUnixNano: '1792642201123456789',
  endTimeUnixNano: '1792642201223456789',
  attributes: [
    { key: 'http.route', value: { stringValue: '/a2a' } },
    { key: 'n', value: { intValue: '3' } },
  ],
  ...extra,
});

test('otlp: spans of a trace this ZAAFPulse started are kept; unknown, malformed and excess spans are refused', () => {
  const { store, recorder } = known();
  const recv = createReceiver({ recorder, maxPerTrace: 2 });
  const out = recv.receive({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'far-agent' } }] },
        scopeSpans: [
          {
            spans: [
              span(T, '1111111111111111', { status: { code: 2, message: 'boom' } }),
              span('f'.repeat(32), '2222222222222222'), // a trace ZAAFPulse did not start
              span(T, 'zz'), // malformed span id
              span(T, '3333333333333333'),
              span(T, '4444444444444444'), // over the per-trace limit
            ],
          },
        ],
      },
    ],
  });
  assert.equal(out.partialSuccess.rejectedSpans, 3);
  recorder.flush();
  assert.equal(store.spans.length, 2);
  const [a] = store.spans;
  assert.deepEqual(
    { t: a.t, p: a.p, k: a.k, src: a.src, svc: a.svc, st: a.st, d: a.d, ok: a.ok, err: a.err },
    { t: T, p: CLIENT, k: 'server', src: 'remote', svc: 'far-agent', st: 1792642201123456, d: 100000, ok: false, err: 'boom' },
  );
  assert.deepEqual(a.a, { 'http.route': '/a2a', n: 3 });
  assert.deepEqual(recv.receive({ resourceSpans: [] }), {});
  assert.deepEqual(recv.receive(null), {});
});

test('otlp: content attributes from outside are not kept either', () => {
  const { store, recorder } = known();
  createReceiver({ recorder }).receive({
    resourceSpans: [
      { scopeSpans: [{ spans: [span(T, '5555555555555555', { attributes: [{ key: 'gen_ai.input.messages', value: { stringValue: 'secret' } }] })] }] },
    ],
  });
  recorder.flush();
  assert.deepEqual(store.spans[0].a, {});
  assert.equal(store.spans[0].svc, 'remote');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-otlp.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/otlp'`.

- [ ] **Step 3: Implement** (`lib/trace/otlp.js`)

```js
// The return channel: OTLP/HTTP JSON spans from a remote agent or MCP server, kept only for traces this ZAAFPulse
// started in the last 24 hours (the recorder saw them go out: a 128-bit trace id only the callee was given works
// as a capability) and at most maxPerTrace per trace. It is not a general OTLP backend, and like the rest of the
// store it keeps no content attributes.
const { CONTENT_KEYS } = require('./recorder');

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO = /^0+$/;
const KINDS = { 1: 'internal', 2: 'server', 3: 'client', SPAN_KIND_INTERNAL: 'internal', SPAN_KIND_SERVER: 'server', SPAN_KIND_CLIENT: 'client' };
const MAX_ATTRS = 64;

function valueOf(v = {}) {
  if ('stringValue' in v) return String(v.stringValue).slice(0, 1000);
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return !!v.boolValue;
  return JSON.stringify(v.arrayValue || v.kvlistValue || null).slice(0, 1000);
}
function attrsOf(list) {
  const out = {};
  for (const kv of (Array.isArray(list) ? list : []).slice(0, MAX_ATTRS)) {
    if (!kv || typeof kv.key !== 'string' || CONTENT_KEYS.has(kv.key)) continue;
    out[kv.key.slice(0, 100)] = valueOf(kv.value || {});
  }
  return out;
}
const usOf = (nano) => {
  try {
    return Number(BigInt(String(nano)) / 1000n);
  } catch {
    return 0;
  }
};
const id = (v, re) => {
  const s = String(v || '').toLowerCase();
  return re.test(s) && !ZERO.test(s) ? s : null;
};

function createReceiver({ recorder, maxPerTrace = 2000 }) {
  const counts = new Map(); // trace id -> spans accepted from outside
  function receive(body) {
    let rejected = 0;
    const out = [];
    for (const rs of (body && Array.isArray(body.resourceSpans) && body.resourceSpans) || []) {
      const svc = String(attrsOf(rs && rs.resource && rs.resource.attributes)['service.name'] || 'remote').slice(0, 100);
      for (const ss of (rs && rs.scopeSpans) || [])
        for (const s of (ss && ss.spans) || []) {
          const t = id(s && s.traceId, TRACE_ID);
          const sid = id(s && s.spanId, SPAN_ID);
          const p = s && s.parentSpanId ? id(s.parentSpanId, SPAN_ID) : null;
          const n = t ? counts.get(t) || 0 : 0;
          if (!t || !sid || (s.parentSpanId && !p) || !recorder.knows(t) || n >= maxPerTrace) {
            rejected++;
            continue;
          }
          counts.set(t, n + 1);
          const st = usOf(s.startTimeUnixNano);
          const failed = !!s.status && (s.status.code === 2 || s.status.code === 'STATUS_CODE_ERROR');
          out.push({
            t,
            s: sid,
            p,
            n: String(s.name || 'span').slice(0, 200),
            k: KINDS[s.kind] || 'internal',
            st,
            d: Math.max(0, usOf(s.endTimeUnixNano) - st),
            ok: !failed,
            ...(failed ? { err: String(s.status.message || 'error').slice(0, 200) } : {}),
            src: 'remote',
            svc,
            a: attrsOf(s.attributes),
          });
        }
    }
    if (out.length) recorder.ingest(out);
    if (counts.size > 10000) counts.clear();
    return rejected
      ? {
          partialSuccess: {
            rejectedSpans: rejected,
            errorMessage: 'dropped spans of traces this ZAAFPulse did not start, with malformed ids, or over the per-trace limit',
          },
        }
      : {};
  }
  return { receive };
}

module.exports = { createReceiver };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-otlp.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Serve it** (`server.js`)

Add next to the other trace requires: `const { createReceiver } = require('./lib/trace/otlp');`. After the `const recorder = createRecorder({ … });` line add:

```js
const traceReceiver = createReceiver({ recorder });
```

Replace

```js
    // The gateway authenticates its own callers with ZAAFPulse API keys.
    if (await gateway.handle(req, res, url)) return;
```

with

```js
    // OTLP/HTTP JSON return channel (lib/trace/otlp.js): spans back from remote agents and MCP servers for traces
    // this ZAAFPulse started. From this machine only; bodies over 1 MB are cut off by readBody.
    if (url.pathname === '/v1/traces' && req.method === 'POST') {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
        return send(res, 403, { error: 'the trace return channel accepts calls from this machine only' });
      if (!/^application\/json/.test(req.headers['content-type'] || ''))
        return send(res, 415, { error: 'send OTLP as JSON (content-type: application/json)' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return err.message === 'too large' ? undefined : send(res, 400, { error: 'invalid JSON' });
      }
      return send(res, 200, traceReceiver.receive(body));
    }
    // The gateway authenticates its own callers with ZAAFPulse API keys.
    if (await gateway.handle(req, res, url)) return;
```

- [ ] **Step 6: Check it against the running server**

Run `npm start`, then in another terminal (use the port the server printed):

`curl -s -X POST http://127.0.0.1:<port>/v1/traces -H 'content-type: application/json' -d '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"ffffffffffffffffffffffffffffffff","spanId":"1111111111111111","name":"x","startTimeUnixNano":"1","endTimeUnixNano":"2"}]}]}]}'`
Expected: `{"partialSuccess":{"rejectedSpans":1,…}}` (a trace this server did not start).

`curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:<port>/v1/traces -H 'content-type: application/x-protobuf' --data-binary 'x'`
Expected: `415`.

- [ ] **Step 7: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add lib/trace/otlp.js test/trace-otlp.test.js server.js
git commit -m "Accept spans back from remote agents for traces ZAAFPulse started"
```

### Task 15: Documentation

**Files:**
- Modify: `docs/explorer.md`, `docs/otel.md`

(README is left to the owner.)

- [ ] **Step 1: The explorer** (`docs/explorer.md`)

In the table of "What each source shows", replace the **Agent Gateway** row's "Where it reads" cell `this gateway's own request log and collaboration runs` with `the local trace store (.data/traces), and for older traffic this gateway's own request log and collaboration runs`, and its "Spans" cell with `every request, model call, agent, tool call and remote call as one trace (metadata only); older plain requests: metadata only, one session per conversation; older collaboration runs: the full span tree`.

Directly before the `## Privacy` heading, add:

````markdown
## Analysis

Every session you open, from any source, comes with an analysis of the turn on show (after Jaeger):

- **Critical path**: the chain of spans that decided how long the turn took. Their bars are outlined, and the
  tree header shows its length. A span that ran in parallel and finished earlier is not on it.
- **Self time and branch totals**: a span's detail line shows the time it spent itself (without its children)
  and, for a span with children, the cost, tokens and errors of everything below it. Tokens and cost are added
  up from model calls only, so nothing is counted twice.
- **Likely cause**: when something failed, a red notice names the deepest failed span on the critical path (or
  the first failure when none is on it); **Show** selects it.
- **Dependencies**: the right half's **Dependencies** switch shows which agents called which models, tools,
  agents and remote services over the chosen time range, with calls, failures and the 95th percentile duration.
  It covers Agent Gateway traces.

Search also matches the agents, models and tools of a stored gateway trace, and `/api/trace/sessions` takes
`minMs` and `minCost` to find slow or expensive sessions.

## The local trace store

The Agent Gateway keeps every trace it makes in `.data/traces/`: one file per day plus an index, files readable
by your account only. It holds span names, times, statuses, models, token counts, costs and error messages
(masked, at most 200 characters), and **no prompt, reply, tool argument or tool result**, whatever the OTLP
export settings say. Traces older than 14 days, or beyond 500 MB in total, are deleted a whole day at a time.

```json
"tracing": { "enabled": true, "retentionDays": 14, "maxBytes": 524288000 }
```

`"enabled": false` stops recording (traces already stored stay until retention removes them). Retention is read
when ZAAFPulse starts.
````

In the HTTP API table, add a row:

```markdown
| `GET /api/trace/deps?range=1..30` | `{ "nodes": [{ id, kind, label, count }], "edges": [{ from, to, count, errors, p95Ms }] }` over stored gateway traces |
```

and add to the description of `GET /api/trace/session`: `, plus "analysis": { rootSpanId, criticalPath, selfTime, rollup, rootCause } (null when it could not be computed)`.

In the `## MCP` section, after the paragraph on `acc_trace_sessions`, add:

```markdown
`acc_trace_get` reads one of those sessions in small views, so an AI client can look at structure before
details: `topology` (span ids, parents, kinds, names, durations, statuses), `critical_path`, `errors` (failed
spans and the likely cause) and `span` (one span's model, tool name, tokens, cost, self time and branch totals).
Arguments: `key`, `view`, and `turn` and `span` where needed. It never returns text, content ids or paths.
```

- [ ] **Step 2: Propagation** (`docs/otel.md`)

Directly before the `## Backends` heading, add:

```markdown
### Local store

The same spans also go to ZAAFPulse's own trace store (see [explorer.md](explorer.md#the-local-trace-store)),
whether export is on or off. Content attributes never go there.

### Calls to remote agents and MCP servers

- A remote A2A agent is called inside a CLIENT span `a2a {agent id}` (`rpc.system: a2a`, `server.address`), and
  the request carries its `traceparent`.
- A call to an MCP server over Streamable HTTP carries the `traceparent` of its `execute_tool` span, as a header
  and as `params._meta.traceparent`.

A remote agent or MCP server **on this machine** that exports OpenTelemetry can send its spans back as OTLP/HTTP
JSON to `http://127.0.0.1:<port>/v1/traces`. ZAAFPulse keeps them only for traces it started in the last 24
hours, at most 2,000 spans per trace and 1 MB per request, without content attributes, and shows them in the
same trace (their clocks are aligned to the call that reached them). Anything else is dropped and counted in
the reply's `partialSuccess`.
```

- [ ] **Step 3: Check the links and commit**

Run: `grep -n "the-local-trace-store\|## The local trace store" docs/explorer.md docs/otel.md`
Expected: the heading in `explorer.md` and the link in `otel.md`.

```bash
git add docs/explorer.md docs/otel.md
git commit -m "Document trace analysis, the local trace store and propagation"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| `lib/otel.js` is the one tracer; local sink; no content stored | 3, 4 |
| Store: segments, index, snapshot, retention, defaults | 1, 2, 4 |
| Complete trees: model calls in place, fixed run trace, full export, standalone runs | 5, 6 |
| Adjusters and analysis on every source | 7, 8, 10 |
| Gateway rows from the store, de-duplication, tags, run text | 9 |
| `minMs` / `minCost`, `/api/trace/deps`, demo sample | 10 |
| UI: critical path, self time, branch totals, root cause, dependency table | 11 |
| `acc_trace_get` | 12 |
| `traceparent` on A2A and MCP | 13 |
| Return channel with its three guards | 14 |
| Documentation | 15 |

## Execution

Execute with superpowers:subagent-driven-development, one task per subagent, in order: each phase leaves the
dashboard working, and later tasks rely on the names listed under **Interfaces** of earlier ones.
