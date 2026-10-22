# Agent Run Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every AI agent run on this machine (gateway runs, Claude Code and Codex sessions, calls to remote agents and MCP servers) into a trace that can be searched, opened and explained: waterfall, critical path, cost per branch, root cause of a failure, and a dependency map.

**Architecture:** A new `lib/trace/` package with the contract of Jaeger's storage API. The gateway's tracer (`tracer.js`) buffers finished spans and appends them to one NDJSON segment per UTC day (`store.js`); a trace index of summaries lives in memory and is snapshotted, so the server and `mcp.js` catch up by reading only what was appended. Claude Code and Codex sessions are indexed as summaries and rebuilt into spans from the original JSONL when opened (`sources/`). Read-time adjusters and analysis (`adjust.js`, `analyze.js`) follow Jaeger. The dashboard gets `/api/traces*` and a Traces page; MCP gets `acc_traces_search` and `acc_trace_get`.

**Tech Stack:** Node 18+ standard library only (`fs`, `crypto`, `http`, `node:test`). Plain browser JS in `public/`.

Spec: `docs/superpowers/specs/2026-10-22-agent-tracing-design.md`

## Global Constraints

- Runtime dependencies: **0**. Do not add anything to `package.json`.
- Node **>= 18**, CommonJS, `'use strict'` only in `public/*.js`. No `node:sqlite`.
- IDs: trace ID 32 lowercase hex, span ID 16 lowercase hex, never all zeros (W3C trace context).
- Times in span records: **microseconds** since the Unix epoch (`st`), durations in microseconds (`d`). Query parameters `from` / `to` are **milliseconds**.
- Span record fields exactly: `t s p n k st d ok err src svc a x` (see the spec's data model). `err` at most 200 characters.
- Trace summary fields exactly: `traceId src svc root rootStart start end spans errors tokensIn tokensOut costUSD models agents tools ref`. Public summaries (API, MCP) drop `ref` and `rootStart` and add `durationMs`.
- Tokens and cost in a summary come from `chat` spans only.
- Files under the traces folder are written with mode `0600`, the folder with `0700`.
- A tracing failure never fails an agent run.
- Retention defaults: **14 days**, **500 MB**. Buffer limit **10,000** spans, batch **500**, flush **1 s**, snapshot every **5 min**.
- Comment style: short `//` comments explaining why, like the existing `lib/*.js`.
- The working tree has unrelated uncommitted changes (README, `docs/assets`). Every commit in this plan stages **only the files the task names** (`git add <paths>`), never `git add -A` or `git commit -a`.

## File map

| File | Status | Responsibility | Phase |
|---|---|---|---|
| `lib/trace/ids.js` | create | trace/span IDs, stable IDs, `traceparent`, microsecond clock | 1 |
| `lib/trace/summary.js` | create | trace summary from spans | 1 |
| `lib/trace/store.js` | create | segments, trace index, snapshot, catch-up, retention | 1 |
| `lib/trace/tracer.js` | create | spans, scopes, buffer, `tracedLlm` | 1 |
| `lib/trace/reader.js` | create | `findTraces`, `getTrace`, `findSpans` (+ deps in phase 3) | 1, 3 |
| `lib/trace/api.js` | create | `/api/traces*` routes | 1, 3 |
| `lib/gateway/index.js` | modify | create store and tracer, pass them on, flush | 1, 4 |
| `lib/gateway/orchestrator.js` | modify | trace standalone agent runs, tool spans, remote client spans | 1, 4 |
| `lib/gateway/collab.js` | modify | `rt.span` on the tracer, `run.traceId` | 1, 4 |
| `server.js` | modify | reader, routes, timers, session index, return channel | 1, 2, 4 |
| `config.example.json` | modify | `tracing` block | 1 |
| `public/traces.js` | create | Traces page | 1, 3 |
| `public/app.js`, `public/index.html`, `public/styles.css` | modify | route, nav, script, styles | 1, 3 |
| `lib/indexer.js` | modify | cache version per instance | 2 |
| `lib/trace/sources/claude.js` | create | Claude Code session → spans | 2 |
| `lib/trace/sources/codex.js` | create | Codex session → spans | 2 |
| `lib/trace/sources/index.js` | create | session sources, builders, path guard, cache reader | 2 |
| `lib/trace/adjust.js` | create | dedupe, orphans, clock skew, order | 3 |
| `lib/trace/analyze.js` | create | critical path, rollups, self time, root cause | 3 |
| `lib/trace/views.js` | create | small views of a trace for MCP | 3 |
| `lib/connectors/acc.js`, `mcp.js` | modify | `acc_traces_search`, `acc_trace_get` | 3 |
| `lib/integrations.js`, `lib/connectors/mcp-proxy.js`, `lib/mcp/client.js` | modify | pass `traceparent` to MCP servers | 4 |
| `lib/trace/otlp.js` | create | OTLP/HTTP JSON return channel | 4 |
| `lib/trace/capture.js` | create | opt-in excerpts | 4 |
| `docs/tracing.md` | create | user documentation (README is left to the owner) | 4 |
| `test/trace-*.test.js` | create | tests | all |

---

# Phase 1: Core

Result of the phase: every gateway run (chat with an agent, a single-agent run, a workflow, a collaboration run) is a trace on disk; the dashboard lists traces and shows one as a waterfall.

### Task 1: IDs and the microsecond clock

**Files:**
- Create: `lib/trace/ids.js`, `test/trace-ids.test.js`

**Interfaces:**
- Produces: `newTraceId() → string(32)`, `newSpanId() → string(16)`, `stableId(text, bytes) → hex`, `isTraceId(v)`, `isSpanId(v)`, `formatTraceparent({ traceId, spanId, sampled? }) → string`, `parseTraceparent(header) → { traceId, spanId, sampled } | null`, `nowMicros() → number`.

- [ ] **Step 1: Write the failing test** (`test/trace-ids.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const ids = require('../lib/trace/ids');

test('ids: random trace and span IDs have the W3C sizes', () => {
  const t = ids.newTraceId();
  const s = ids.newSpanId();
  assert.match(t, /^[0-9a-f]{32}$/);
  assert.match(s, /^[0-9a-f]{16}$/);
  assert.notEqual(ids.newTraceId(), t);
  assert.ok(ids.isTraceId(t) && ids.isSpanId(s));
  assert.ok(!ids.isTraceId('0'.repeat(32)) && !ids.isSpanId('0'.repeat(16)));
});

test('ids: stable IDs repeat for the same input', () => {
  assert.equal(ids.stableId('claude:abc', 16), ids.stableId('claude:abc', 16));
  assert.notEqual(ids.stableId('claude:abc', 16), ids.stableId('claude:abd', 16));
  assert.match(ids.stableId('x', 8), /^[0-9a-f]{16}$/);
});

test('ids: traceparent round trip, malformed headers rejected', () => {
  const ctx = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' };
  const h = ids.formatTraceparent(ctx);
  assert.equal(h, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.deepEqual(ids.parseTraceparent(h), { ...ctx, sampled: true });
  assert.equal(ids.parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`), null);
  assert.equal(ids.parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), null);
  assert.equal(ids.parseTraceparent('00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01'), null);
  assert.equal(ids.parseTraceparent(undefined), null);
});

test('ids: the microsecond clock moves forward and matches the wall clock', () => {
  const a = ids.nowMicros();
  const b = ids.nowMicros();
  assert.ok(b >= a);
  assert.ok(Math.abs(a / 1000 - Date.now()) < 1000);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-ids.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/ids'`.

- [ ] **Step 3: Implement** (`lib/trace/ids.js`)

```js
// W3C trace context: trace IDs (16 bytes) and span IDs (8 bytes) as lowercase hex, and the traceparent
// header. Span times are microseconds since the epoch: nanoseconds do not fit a JSON number exactly.
const crypto = require('crypto');

const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
const HEX = /^[0-9a-f]+$/;

function randomHex(bytes, zero) {
  for (;;) {
    const id = crypto.randomBytes(bytes).toString('hex');
    if (id !== zero) return id;
  }
}
const newTraceId = () => randomHex(16, ZERO_TRACE);
const newSpanId = () => randomHex(8, ZERO_SPAN);

// Same input, same ID: traces rebuilt from session logs keep their IDs.
function stableId(text, bytes) {
  const id = crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, bytes * 2);
  return /^0+$/.test(id) ? '1'.padStart(bytes * 2, '0') : id;
}

const isTraceId = (v) => typeof v === 'string' && v.length === 32 && HEX.test(v) && v !== ZERO_TRACE;
const isSpanId = (v) => typeof v === 'string' && v.length === 16 && HEX.test(v) && v !== ZERO_SPAN;

function formatTraceparent({ traceId, spanId, sampled = true }) {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

function parseTraceparent(header) {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(header || '').trim());
  if (!m || m[1] === 'ff' || !isTraceId(m[2]) || !isSpanId(m[3])) return null;
  return { traceId: m[2], spanId: m[3], sampled: (parseInt(m[4], 16) & 1) === 1 };
}

// Wall-clock microseconds, stepping with the monotonic clock so spans in one process never go backwards.
const BASE = Date.now() * 1000 - Number(process.hrtime.bigint() / 1000n);
const nowMicros = () => BASE + Number(process.hrtime.bigint() / 1000n);

module.exports = {
  newTraceId,
  newSpanId,
  stableId,
  isTraceId,
  isSpanId,
  formatTraceparent,
  parseTraceparent,
  nowMicros,
};
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-ids.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/ids.js test/trace-ids.test.js
git commit -m "Add W3C trace and span IDs for agent tracing"
```

### Task 2: Trace summary

**Files:**
- Create: `lib/trace/summary.js`, `test/trace-summary.test.js`

**Interfaces:**
- Consumes: span records (Global Constraints).
- Produces: `blankSummary(traceId) → summary`, `addSpan(summary, span) → summary`, `summarize(traceId, spans) → summary`.

- [ ] **Step 1: Write the failing test** (`test/trace-summary.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../lib/trace/summary');

const T = 'a'.repeat(32);
const span = (s, p, n, st, d, a = {}, ok = true) => ({
  t: T,
  s,
  p,
  n,
  k: 'internal',
  st,
  d,
  ok,
  src: 'gateway',
  svc: 'zaafpulse',
  a,
});

test('summary: root, time range and counts; tokens and cost from chat spans only', () => {
  const root = '1'.repeat(16);
  const spans = [
    span('2'.repeat(16), root, 'chat m1', 1100, 200, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'm1',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
      'zp.cost_usd': 0.01,
    }),
    span('3'.repeat(16), root, 'execute_tool web', 1300, 100, { 'gen_ai.tool.name': 'web' }, false),
    // The agent span repeats its children's totals; they must not be counted twice.
    span(root, null, 'invoke_agent sales', 1000, 500, {
      'gen_ai.agent.id': 'sales',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
      'zp.cost_usd': 0.01,
    }),
  ];
  const s = summarize(T, spans);
  assert.equal(s.root, 'invoke_agent sales');
  assert.equal(s.start, 1000);
  assert.equal(s.end, 1500);
  assert.equal(s.spans, 3);
  assert.equal(s.errors, 1);
  assert.equal(s.tokensIn, 10);
  assert.equal(s.tokensOut, 5);
  assert.equal(s.costUSD, 0.01);
  assert.deepEqual(s.models, ['m1']);
  assert.deepEqual(s.agents, ['sales']);
  assert.deepEqual(s.tools, ['web']);
  assert.equal(s.src, 'gateway');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-summary.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/summary'`.

- [ ] **Step 3: Implement** (`lib/trace/summary.js`)

```js
// One trace's summary, built span by span. Tokens and cost come from chat spans only: agent and workflow
// spans repeat their children's totals, and counting both would double them.
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
    tokensIn: 0,
    tokensOut: 0,
    costUSD: 0,
    models: [],
    agents: [],
    tools: [],
  };
}

const addTo = (list, v) => {
  if (v && !list.includes(String(v)) && list.length < LIST_MAX) list.push(String(v));
};

function addSpan(sum, sp) {
  sum.spans++;
  if (!sp.ok) sum.errors++;
  const end = sp.st + sp.d;
  if (!sum.start || sp.st < sum.start) sum.start = sp.st;
  if (end > sum.end) sum.end = end;
  if (!sp.p && (!sum.root || sp.st < sum.rootStart)) {
    sum.root = sp.n;
    sum.rootStart = sp.st;
    sum.src = sp.src;
    sum.svc = sp.svc;
  }
  if (!sum.src) {
    sum.src = sp.src;
    sum.svc = sp.svc;
  }
  const a = sp.a || {};
  if (a['gen_ai.operation.name'] === 'chat') {
    sum.tokensIn += Number(a['gen_ai.usage.input_tokens']) || 0;
    sum.tokensOut += Number(a['gen_ai.usage.output_tokens']) || 0;
    sum.costUSD += Number(a['zp.cost_usd']) || 0;
    addTo(sum.models, a['gen_ai.request.model']);
  }
  addTo(sum.agents, a['gen_ai.agent.id']);
  addTo(sum.tools, a['gen_ai.tool.name']);
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
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/summary.js test/trace-summary.test.js
git commit -m "Add trace summaries for agent tracing"
```

### Task 3: Segment store with snapshot, catch-up and retention

**Files:**
- Create: `lib/trace/store.js`, `test/trace-store.test.js`

**Interfaces:**
- Consumes: `blankSummary`, `addSpan` (Task 2).
- Produces: `createTraceStore({ dir, retentionDays = 14, maxBytes = 524288000, now = Date.now, readOnly = false }) → { writeSpans(spans) → number, getSpans(traceId) → span[] | null, getSummary(traceId) → summary | null, summaries() → summary[], catchUp(), snapshot(), applyRetention() → { deleted: string[] }, stats() → { traces, segments, bytes, skipped } }`. Summaries carry `ref: { "<YYYY-MM-DD>.ndjson": [startByte, endByte] }`.

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
const sp = (t, s, p = null, st = 1000, d = 10) => ({
  t,
  s,
  p,
  n: `op ${s.slice(0, 2)}`,
  k: 'internal',
  st,
  d,
  ok: true,
  src: 'gateway',
  svc: 'zaafpulse',
  a: {},
});
const NOON = () => Date.UTC(2026, 9, 22, 12);

test('store: appended spans read back by trace, summaries kept', () => {
  const dir = tmp();
  const store = createTraceStore({ dir, now: NOON });
  store.writeSpans([sp(T1, 'a'.repeat(16)), sp(T2, 'b'.repeat(16)), sp(T1, 'c'.repeat(16), 'a'.repeat(16), 1005, 2)]);
  assert.deepEqual(
    store.getSpans(T1).map((s) => s.s),
    ['a'.repeat(16), 'c'.repeat(16)],
  );
  assert.equal(store.getSpans(T2).length, 1);
  assert.equal(store.getSpans('9'.repeat(32)), null);
  assert.equal(store.summaries().length, 2);
  assert.equal(store.getSummary(T1).spans, 2);
  assert.ok(fs.existsSync(path.join(dir, '2026-10-22.ndjson')));
});

test('store: a second instance catches up from the snapshot plus what was appended after it', () => {
  const dir = tmp();
  const a = createTraceStore({ dir, now: NOON });
  a.writeSpans([sp(T1, 'a'.repeat(16))]);
  a.snapshot();
  a.writeSpans([sp(T2, 'b'.repeat(16))]);
  const b = createTraceStore({ dir, now: NOON, readOnly: true });
  assert.equal(b.summaries().length, 2);
  a.writeSpans([sp(T2, 'c'.repeat(16), 'b'.repeat(16))]);
  b.catchUp();
  assert.equal(b.getSummary(T2).spans, 2);
  assert.throws(() => b.writeSpans([sp(T1, 'd'.repeat(16))]), /read-only/);
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
  store.writeSpans([sp(T1, 'a'.repeat(16))]);
  t = Date.UTC(2026, 9, 10, 12);
  store.writeSpans([sp(T2, 'b'.repeat(16))]);
  t = Date.UTC(2026, 9, 22, 12);
  assert.deepEqual(store.applyRetention().deleted, ['2026-10-01.ndjson']);
  assert.equal(store.getSummary(T1), null);
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
// Append-only trace storage, after Jaeger's Badger and memory backends: one NDJSON segment per UTC day,
// a trace index in memory (each trace's summary and the byte range it covers in each segment), and a
// snapshot of that index so a restart, or another process such as mcp.js, catches up by reading only
// what was appended since. Retention deletes whole segments, oldest first, never today's.
const fs = require('fs');
const path = require('path');
const { blankSummary, addSpan } = require('./summary');

const SNAPSHOT = 'index.json';
const SNAPSHOT_VERSION = 1;
const SEGMENT = /^\d{4}-\d{2}-\d{2}\.ndjson$/;
const DAY_MS = 86400000;

function createTraceStore({
  dir,
  retentionDays = 14,
  maxBytes = 500 * 1024 * 1024,
  now = Date.now,
  readOnly = false,
}) {
  let traces = new Map(); // traceId -> summary with ref { segment: [start, end] }
  let offsets = {}; // segment -> bytes already indexed
  let skipped = 0;
  if (!readOnly) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

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
    const r = sum.ref[segment];
    sum.ref[segment] = r ? [Math.min(r[0], start), Math.max(r[1], end)] : [start, end];
  }

  // Index the complete lines appended to a segment since `from`; returns the new offset. A last line
  // without its newline is left for later (it may still be in the middle of being written).
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
          if (sp && sp.t && sp.s) index(sp, segment, from + pos, from + nl + 1);
          else skipped++;
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
      if (!Object.keys(sum.ref).length) traces.delete(id);
    }
  }

  function catchUp() {
    const present = new Set(segments());
    for (const seg of Object.keys(offsets)) if (!present.has(seg)) forget(seg);
    for (const seg of present) offsets[seg] = scan(seg, offsets[seg] || 0);
  }

  // The writer closes a line cut short by a crash, so the next append does not join it.
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
    } catch {
      /* no snapshot yet: catchUp reads every segment */
    }
  }

  function snapshot() {
    if (readOnly) return;
    const tmp = path.join(dir, `${SNAPSHOT}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ version: SNAPSHOT_VERSION, offsets, traces: [...traces.values()] }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, path.join(dir, SNAPSHOT));
  }

  function writeSpans(spans) {
    if (readOnly) throw new Error('trace store is read-only');
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

  function applyRetention() {
    if (readOnly) return { deleted: [] };
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
  if (!readOnly) repairTails();

  return {
    writeSpans,
    getSpans,
    getSummary: (traceId) => traces.get(traceId) || null,
    summaries: () => [...traces.values()],
    catchUp,
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

### Task 4: Tracer, scopes and traced model calls

**Files:**
- Create: `lib/trace/tracer.js`, `test/trace-tracer.test.js`

**Interfaces:**
- Consumes: `ids` (Task 1); a store with `writeSpans(spans) → number` (Task 3), or `null`.
- Produces:
  - `createTracer({ store, now = nowMicros, clock = Date.now, flushMs = 1000, batch = 500, maxBuffer = 10000, onError }) → { startSpan(name, attrs, opts) → handle, scope({ traceId?, parentId?, src?, svc? }) → { traceId, span(name, attrs, parentId, opts) → handle }, ingest(spans), knows(traceId) → boolean, flush(), stats() → { buffered, dropped, written }, close() }`.
  - Span handle: `{ traceId, id, end(more = {}, err = null), traceparent() → string, capture(x) }`. `opts`: `{ traceId, parentId, kind, src, svc }`.
  - `tracedLlm(llm, scope) → async (args) → result` records `chat <model>` under `args.span`.

- [ ] **Step 1: Write the failing test** (`test/trace-tracer.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracer, tracedLlm } = require('../lib/trace/tracer');

const memStore = () => {
  const spans = [];
  return { spans, writeSpans: (l) => (spans.push(...l), l.length) };
};

test('tracer: spans are written once ended, with parent, duration, status and attributes', () => {
  let t = 1000;
  const store = memStore();
  const tracer = createTracer({ store, now: () => t, flushMs: 0 });
  const scope = tracer.scope();
  const root = scope.span('invoke_agent a', { 'gen_ai.agent.id': 'a' });
  t = 1100;
  const child = scope.span('execute_tool x', {}, root.id);
  t = 1150;
  child.end({ 'zp.output_chars': 3 }, new Error('boom'));
  t = 1300;
  root.end();
  tracer.flush();
  const [c, r] = store.spans;
  assert.equal(c.p, root.id);
  assert.equal(c.t, root.traceId);
  assert.equal(c.d, 50);
  assert.equal(c.ok, false);
  assert.equal(c.err, 'boom');
  assert.equal(c.a['zp.output_chars'], 3);
  assert.equal(r.p, null);
  assert.equal(r.st, 1000);
  assert.equal(r.d, 300);
  assert.match(root.traceparent(), new RegExp(`^00-${root.traceId}-${root.id}-01$`));
  root.end();
  tracer.flush();
  assert.equal(store.spans.length, 2, 'ending twice records once');
});

test('tracer: a failing store keeps the newest spans up to the limit and counts the rest', () => {
  let fail = true;
  const ok = memStore();
  const store = {
    writeSpans: (l) => {
      if (fail) throw new Error('disk full');
      return ok.writeSpans(l);
    },
  };
  const tracer = createTracer({ store, flushMs: 0, batch: 1000, maxBuffer: 3 });
  const scope = tracer.scope();
  for (let i = 0; i < 5; i++) scope.span(`s${i}`).end();
  tracer.flush();
  assert.equal(tracer.stats().dropped, 2);
  fail = false;
  tracer.flush();
  assert.deepEqual(
    ok.spans.map((s) => s.n),
    ['s2', 's3', 's4'],
  );
});

test('tracer: knows the traces it started in the last 24 hours', () => {
  let ms = Date.UTC(2026, 9, 22);
  const tracer = createTracer({ store: memStore(), flushMs: 0, clock: () => ms });
  const s = tracer.scope();
  s.span('x').end();
  assert.ok(tracer.knows(s.traceId));
  assert.ok(!tracer.knows('f'.repeat(32)));
  ms += 25 * 3600 * 1000;
  assert.ok(!tracer.knows(s.traceId));
});

test('tracer: without a store nothing is kept', () => {
  const tracer = createTracer({ store: null, flushMs: 0 });
  tracer.scope().span('x').end();
  tracer.flush();
  assert.deepEqual(tracer.stats(), { buffered: 0, dropped: 0, written: 0 });
});

test('tracedLlm: a chat span with model, tokens and cost under the given parent', async () => {
  const store = memStore();
  const tracer = createTracer({ store, flushMs: 0 });
  const scope = tracer.scope();
  const root = scope.span('invoke_agent a');
  const call = tracedLlm(
    async () => ({ message: { content: 'hi' }, usage: { input: 7, output: 3, cost: 0.002 }, routedTo: 'p/m2' }),
    scope,
  );
  await call({ model: 'p/m', agent: 'a', span: root.id, messages: [] });
  root.end();
  tracer.flush();
  const chat = store.spans.find((s) => s.n === 'chat p/m');
  assert.equal(chat.p, root.id);
  assert.equal(chat.a['gen_ai.operation.name'], 'chat');
  assert.equal(chat.a['gen_ai.usage.input_tokens'], 7);
  assert.equal(chat.a['zp.cost_usd'], 0.002);
  assert.equal(chat.a['zp.routed_to'], 'p/m2');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-tracer.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/tracer'`.

- [ ] **Step 3: Implement** (`lib/trace/tracer.js`)

```js
// Starts and ends spans, buffers the finished ones and hands them to the store in batches. A failing
// store never fails a run: the buffer is bounded, the oldest spans go first, and drops are counted.
const ids = require('./ids');

const KNOWN_MS = 24 * 3600 * 1000;

function createTracer({
  store,
  now = ids.nowMicros,
  clock = Date.now,
  flushMs = 1000,
  batch = 500,
  maxBuffer = 10000,
  onError = () => {},
} = {}) {
  let buffer = [];
  let dropped = 0;
  let written = 0;
  const started = new Map(); // traceId -> ms when a span of it last started (the return channel's guard)

  const trim = () => {
    if (buffer.length > maxBuffer) {
      dropped += buffer.length - maxBuffer;
      buffer = buffer.slice(buffer.length - maxBuffer);
    }
  };

  function flush() {
    const cut = clock() - KNOWN_MS;
    for (const [id, ms] of started) if (ms < cut) started.delete(id);
    if (!buffer.length || !store) return;
    const out = buffer;
    buffer = [];
    try {
      written += store.writeSpans(out);
    } catch (err) {
      buffer = out.concat(buffer);
      trim();
      onError(err);
    }
  }

  function record(sp) {
    if (!store) return;
    buffer.push(sp);
    trim();
    if (buffer.length >= batch) flush();
  }

  // opts: { traceId, parentId, kind, src, svc }
  function startSpan(name, attrs = {}, opts = {}) {
    const sp = {
      t: opts.traceId || ids.newTraceId(),
      s: ids.newSpanId(),
      p: opts.parentId || null,
      n: String(name).slice(0, 200),
      k: opts.kind || 'internal',
      st: now(),
      d: 0,
      ok: true,
      src: opts.src || 'gateway',
      svc: opts.svc || 'zaafpulse',
      a: { ...attrs },
    };
    started.set(sp.t, clock());
    let ended = false;
    return {
      traceId: sp.t,
      id: sp.s,
      traceparent: () => ids.formatTraceparent({ traceId: sp.t, spanId: sp.s }),
      capture(x) {
        if (x) sp.x = x;
      },
      end(more = {}, err = null) {
        if (ended) return;
        ended = true;
        sp.d = Math.max(0, now() - sp.st);
        Object.assign(sp.a, more);
        if (err) {
          sp.ok = false;
          sp.err = String(err.message || err).slice(0, 200);
        }
        record(sp);
      },
    };
  }

  // A scope is what agents and collaboration runs call: span(name, attrs, parentId, opts) → handle.
  function scope({ traceId = ids.newTraceId(), parentId = null, src, svc } = {}) {
    return {
      traceId,
      span: (name, attrs, parent, opts = {}) =>
        startSpan(name, attrs, { src, svc, ...opts, traceId, parentId: parent || parentId }),
    };
  }

  const timer = flushMs > 0 ? setInterval(flush, flushMs) : null;
  if (timer && timer.unref) timer.unref();

  return {
    startSpan,
    scope,
    // Finished spans from elsewhere (the return channel), already in the record format.
    ingest: (spans) => spans.forEach(record),
    knows: (traceId) => started.has(traceId) && clock() - started.get(traceId) < KNOWN_MS,
    flush,
    stats: () => ({ buffered: buffer.length, dropped, written }),
    close() {
      if (timer) clearInterval(timer);
      flush();
    },
  };
}

// A model call that records its own chat span, for agent runs outside a collaboration run.
function tracedLlm(llm, scope) {
  return async (args) => {
    const sp = scope.span(
      `chat ${args.model}`,
      {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': args.model,
        ...(args.agent ? { 'zp.agent': args.agent } : {}),
      },
      args.span,
    );
    try {
      const r = await llm(args);
      sp.end({
        'gen_ai.usage.input_tokens': r.usage.input,
        'gen_ai.usage.output_tokens': r.usage.output,
        'zp.cost_usd': r.usage.cost || 0,
        ...(r.routedTo && r.routedTo !== args.model ? { 'zp.routed_to': r.routedTo } : {}),
      });
      return r;
    } catch (err) {
      sp.end({}, err);
      throw err;
    }
  };
}

module.exports = { createTracer, tracedLlm };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-tracer.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/tracer.js test/trace-tracer.test.js
git commit -m "Add the tracer with bounded buffering and traced model calls"
```

### Task 5: Reader

**Files:**
- Create: `lib/trace/reader.js`, `test/trace-reader.test.js`

**Interfaces:**
- Consumes: a store (Task 3); optional `sessions = { summaries() → summary[], get(traceId) → summary | null }` and `builders = { [src]: (summary) → span[] | null }` (Task 11).
- Produces: `createTraceReader({ store, sessions, builders }) → { findTraces(q) → publicSummary[], getTrace(id) → { traceId, summary, spans } | null, findSpans(q) → span[], refresh() }`. Query `q`: `{ src, agent, model, tool, name, text, errors, minMs, minCost, from, to, limit }` (`from`/`to` in ms). `publicSummary(s)` is also exported.

- [ ] **Step 1: Write the failing test** (`test/trace-reader.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTraceStore } = require('../lib/trace/store');
const { createTraceReader } = require('../lib/trace/reader');

const MS = Date.UTC(2026, 9, 22, 12);
const US = MS * 1000;
const T1 = '1'.repeat(32);
const T2 = '2'.repeat(32);
const TS = 'c'.repeat(32);
const sp = (t, s, p, n, st, d, a = {}, ok = true, src = 'gateway') => ({
  t,
  s,
  p,
  n,
  k: 'internal',
  st,
  d,
  ok,
  src,
  svc: 'zaafpulse',
  a,
});

function setup() {
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-rd-')), now: () => MS });
  store.writeSpans([
    sp(T1, 'a'.repeat(16), null, 'invoke_agent sales', US, 2e6, { 'gen_ai.agent.id': 'sales' }),
    sp(T1, 'b'.repeat(16), 'a'.repeat(16), 'execute_tool web', US + 1000, 5000, { 'gen_ai.tool.name': 'web' }, false),
    sp(T2, 'd'.repeat(16), null, 'invoke_agent finance', US + 5e6, 1000, {
      'gen_ai.agent.id': 'finance',
    }),
    sp(T2, 'e'.repeat(16), 'd'.repeat(16), 'chat m', US + 5e6, 900, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'm',
      'zp.cost_usd': 0.5,
    }),
  ]);
  const session = {
    traceId: TS,
    src: 'claude',
    svc: 'claude-code',
    root: 'invoke_agent claude-code',
    rootStart: US - 1e6,
    start: US - 1e6,
    end: US,
    spans: 1,
    errors: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUSD: 0,
    models: [],
    agents: ['claude-code'],
    tools: [],
    ref: { file: '/x.jsonl' },
  };
  const reader = createTraceReader({
    store,
    sessions: { summaries: () => [session], get: (id) => (id === TS ? session : null) },
    builders: { claude: () => [sp(TS, 'f'.repeat(16), null, 'invoke_agent claude-code', US - 1e6, 1e6, {}, true, 'claude')] },
  });
  return { store, reader };
}

test('reader: findTraces filters and sorts newest first, without internal fields', () => {
  const { reader } = setup();
  assert.deepEqual(
    reader.findTraces({}).map((s) => s.traceId),
    [T2, T1, TS],
  );
  assert.deepEqual(
    reader.findTraces({ errors: true }).map((s) => s.traceId),
    [T1],
  );
  assert.deepEqual(
    reader.findTraces({ src: 'claude' }).map((s) => s.traceId),
    [TS],
  );
  assert.deepEqual(
    reader.findTraces({ minCost: 0.1 }).map((s) => s.traceId),
    [T2],
  );
  assert.deepEqual(
    reader.findTraces({ tool: 'web' }).map((s) => s.traceId),
    [T1],
  );
  assert.deepEqual(
    reader.findTraces({ text: 'FINANCE' }).map((s) => s.traceId),
    [T2],
  );
  assert.deepEqual(
    reader.findTraces({ minMs: 1500 }).map((s) => s.traceId),
    [T1],
  );
  assert.deepEqual(
    reader.findTraces({ from: MS + 4000 }).map((s) => s.traceId),
    [T2],
  );
  assert.equal(reader.findTraces({ limit: 1 }).length, 1);
  const s = reader.findTraces({ agent: 'sales' })[0];
  assert.equal(s.ref, undefined);
  assert.equal(s.rootStart, undefined);
  assert.equal(s.durationMs, 2000);
});

test('reader: getTrace for stored and session traces', () => {
  const { reader } = setup();
  const t = reader.getTrace(T1);
  assert.equal(t.spans.length, 2);
  assert.equal(t.summary.root, 'invoke_agent sales');
  assert.equal(reader.getTrace(TS).spans[0].src, 'claude');
  assert.equal(reader.getTrace('9'.repeat(32)), null);
});

test('reader: findSpans by name and errors over stored traces', () => {
  const { reader } = setup();
  assert.deepEqual(
    reader.findSpans({ errors: true }).map((s) => s.n),
    ['execute_tool web'],
  );
  assert.deepEqual(
    reader.findSpans({ name: 'chat' }).map((s) => s.n),
    ['chat m'],
  );
  assert.equal(reader.findSpans({ name: 'chat' })[0].durationMs, 0.9);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-reader.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/reader'`.

- [ ] **Step 3: Implement** (`lib/trace/reader.js`)

```js
// The read side, with the shape of Jaeger's Reader: find traces in the summaries first, then load the
// spans of the one asked for. Stored traces come from the store; session traces (Claude Code, Codex)
// are rebuilt from their original log when opened.
const { summarize } = require('./summary');

const publicSummary = ({ ref, rootStart, ...s }) => ({ ...s, durationMs: (s.end - s.start) / 1000 });
const clamp = (v, def, max) => Math.min(Math.max(Number(v) || def, 1), max);

function matches(s, q) {
  if (q.src && s.src !== q.src) return false;
  if (q.agent && !s.agents.includes(q.agent)) return false;
  if (q.model && !s.models.includes(q.model)) return false;
  if (q.tool && !s.tools.includes(q.tool)) return false;
  if (q.errors && !s.errors) return false;
  if (q.minMs && (s.end - s.start) / 1000 < q.minMs) return false;
  if (q.minCost && s.costUSD < q.minCost) return false;
  if (q.from && s.end < q.from * 1000) return false;
  if (q.to && s.start > q.to * 1000) return false;
  if (q.text) {
    const hay = `${s.root || ''} ${s.agents.join(' ')} ${s.models.join(' ')} ${s.tools.join(' ')}`.toLowerCase();
    if (!hay.includes(String(q.text).toLowerCase())) return false;
  }
  return true;
}

function createTraceReader({ store, sessions = null, builders = {} }) {
  const all = () => (sessions ? store.summaries().concat(sessions.summaries()) : store.summaries());
  const newestFirst = (a, b) => b.start - a.start;

  function spansOf(id) {
    const stored = store.getSpans(id);
    if (stored && stored.length) return stored;
    const s = sessions && sessions.get(id);
    const build = s && builders[s.src];
    return build ? build(s) : null;
  }

  function findTraces(q = {}) {
    return all()
      .filter((s) => matches(s, q))
      .sort(newestFirst)
      .slice(0, clamp(q.limit, 50, 500))
      .map(publicSummary);
  }

  function getTrace(id) {
    const spans = spansOf(id);
    if (!spans || !spans.length) return null;
    spans.sort((a, b) => a.st - b.st);
    return { traceId: id, summary: publicSummary(summarize(id, spans)), spans };
  }

  // Spans across traces: session traces are rebuilt only when the query names their source.
  function findSpans(q = {}) {
    const limit = clamp(q.limit, 100, 1000);
    const pool = q.src && q.src !== 'gateway' ? all() : store.summaries();
    const traceQ = { src: q.src, tool: q.tool, errors: q.errors, from: q.from, to: q.to };
    const out = [];
    for (const s of pool.filter((x) => matches(x, traceQ)).sort(newestFirst).slice(0, 2000)) {
      for (const sp of spansOf(s.traceId) || []) {
        if (q.name && !sp.n.includes(q.name)) continue;
        if (q.tool && (sp.a || {})['gen_ai.tool.name'] !== q.tool) continue;
        if (q.errors && sp.ok) continue;
        if (q.minMs && sp.d / 1000 < q.minMs) continue;
        out.push({ ...sp, durationMs: sp.d / 1000 });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  return { findTraces, getTrace, findSpans, refresh: () => store.catchUp() };
}

module.exports = { createTraceReader, publicSummary };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-reader.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/reader.js test/trace-reader.test.js
git commit -m "Add the trace reader: find traces, open one, find spans"
```

### Task 6: Trace every gateway run

**Files:**
- Modify: `lib/gateway/index.js`, `lib/gateway/orchestrator.js`, `lib/gateway/collab.js`
- Create: `test/trace-gateway.test.js`

**Interfaces:**
- Consumes: `createTraceStore` (Task 3), `createTracer`, `tracedLlm` (Task 4), `newTraceId` (Task 1).
- Produces: `gateway.traces = { store, tracer }`; `createOrchestrator({ ..., tracer })`; `createCollab({ ..., tracer })`; every run object has `traceId` and `rootSpanId`; `rt.span(name, attrs, parentId, opts) → { id, traceparent(), capture(x), end(more, err) }`; ctx field `tracing` (a scope) for agent runs outside a collaboration run.

- [ ] **Step 1: Write the failing test** (`test/trace-gateway.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');

const reply = (content, extra = {}) => ({
  body: {
    choices: [{ message: { role: 'assistant', content, ...extra } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
});
const toolCall = (name, args) =>
  reply(null, { tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function setup(handler) {
  const upstream = await fakeServer({
    'POST /chat/completions': async (r) => {
      const out = await handler(r);
      return typeof out === 'string' ? reply(out) : out;
    },
    'GET /models': { body: { data: [{ id: 'm' }] } },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-trgw-'));
  const gateway = createGateway({
    dataDir,
    getConfig: () => ({
      gateway: {
        providers: [{ id: 'fake', preset: 'custom', baseUrl: upstream.url, tier: 'private', approved: true }],
        defaults: { model: 'fake/m', plannerModel: 'fake/m' },
      },
    }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({ result: { content: [] } }) }),
  });
  return { gateway, dataDir, close: () => upstream.close() };
}

test('a single agent run outside a collaboration run is a trace: agent, model calls and tools', async () => {
  let n = 0;
  const t = await setup(() => (n++ === 0 ? toolCall('zp_memory_save', { text: 'remember this' }) : 'done'));
  try {
    const agent = t.gateway.agents.get('security');
    await t.gateway.orchestrator.runAgent(agent, 'check the logs', {});
    t.gateway.traces.tracer.flush();
    const [sum] = t.gateway.traces.store.summaries();
    assert.equal(sum.root, 'invoke_agent security');
    const spans = t.gateway.traces.store.getSpans(sum.traceId);
    const root = spans.find((s) => !s.p);
    const names = spans.map((s) => s.n).sort();
    assert.deepEqual(names, ['chat fake/m', 'chat fake/m', 'execute_tool zp_memory_save', 'invoke_agent security']);
    for (const s of spans.filter((x) => x.p)) assert.equal(s.p, root.s);
    assert.equal(sum.tokensIn, 20);
    assert.ok(fs.existsSync(path.join(t.dataDir, 'traces')));
  } finally {
    await t.close();
  }
});

test('a collaboration run keeps its live trace and writes the same spans to the trace store', async () => {
  const t = await setup((r) => {
    if (r.body.messages[0].content.startsWith('You are the ZAAFPulse planner'))
      return JSON.stringify({
        steps: [{ id: 's1', agent: 'security', instruction: 'check', dependsOn: [] }],
        reason: 'one step',
      });
    return 'all clear\nFINAL ANSWER: clear\nCONFIDENCE: 0.9';
  });
  try {
    const { run } = await t.gateway.collab.run({ pattern: 'auto', task: 'check the logs' }, {});
    assert.match(run.traceId, /^[0-9a-f]{32}$/);
    t.gateway.traces.tracer.flush();
    const spans = t.gateway.traces.store.getSpans(run.traceId);
    const root = spans.find((s) => !s.p);
    assert.equal(root.n, 'invoke_workflow auto');
    assert.equal(run.rootSpanId, root.s);
    assert.ok(spans.some((s) => s.n === 'invoke_agent security'));
    assert.ok(run.trace.some((x) => x.id === root.s), 'the live trace uses the same span IDs');
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-gateway.test.js`
Expected: FAIL, `Cannot read properties of undefined (reading 'tracer')`.

- [ ] **Step 3: Create the store and tracer in the gateway** (`lib/gateway/index.js`)

Add the requires after `const { createServer: createMcp } = require('../mcp/protocol');`:

```js
const { createTraceStore } = require('../trace/store');
const { createTracer } = require('../trace/tracer');
```

After the line `const runStore = jsonStore(path.join(dataDir, 'runs.json'), { runs: [] });` add:

```js
  // Traces of every agent run (lib/trace): append-only segments under <dataDir>/traces.
  const tracingCfg = (getConfig() || {}).tracing || {};
  const traceStore = createTraceStore({
    dir: path.join(dataDir, 'traces'),
    retentionDays: tracingCfg.retentionDays || 14,
    maxBytes: tracingCfg.maxBytes || 500 * 1024 * 1024,
    now,
  });
  const tracer = createTracer({ store: traceStore });
```

In `createOrchestrator({ ... })` add `tracer,` after `getDefaults: defaults,`. In `createCollab({ ... })` add `tracer,` after `now,`.

In the returned object, replace

```js
    flush: () => [keyStore, agentStore, sessionStore, memoryStore, workflowStore, runStore].forEach((s) => s.flush()),
```

with

```js
    traces: { store: traceStore, tracer },
    flush: () => {
      [keyStore, agentStore, sessionStore, memoryStore, workflowStore, runStore].forEach((s) => s.flush());
      tracer.flush();
      traceStore.snapshot();
    },
```

- [ ] **Step 4: Trace agent runs outside a collaboration run** (`lib/gateway/orchestrator.js`)

Add after `const { words } = require('./memory');`:

```js
const { tracedLlm } = require('../trace/tracer');
```

In the parameters of `createOrchestrator({`, add `tracer = null,` after `env = process.env,`.

Replace the start of `runAgent`:

```js
  async function runAgent(agent, input, ctx = {}) {
    const span = ctx.run
      ? ctx.run.span(
```

with

```js
  async function runAgent(agent, input, ctx = {}) {
    // Outside a collaboration run, an agent run starts its own trace.
    if (!ctx.run && !ctx.tracing && tracer) ctx = { ...ctx, tracing: tracer.scope() };
    const tracing = ctx.run || ctx.tracing;
    const span = tracing
      ? tracing.span(
```

In `runLocal`, replace

```js
    const call = ctx.llm || llm;
    const model = agent.model || getDefaults().model;
```

with

```js
    const call = ctx.llm || (ctx.tracing ? tracedLlm(llm, ctx.tracing) : llm);
    const model = agent.model || getDefaults().model;
```

Replace the tool span opening

```js
        const tspan = ctx.run
          ? ctx.run.span(
```

with

```js
        const tracing = ctx.run || ctx.tracing;
        const tspan = tracing
          ? tracing.span(
```

- [ ] **Step 5: Put the collaboration trace on the tracer** (`lib/gateway/collab.js`)

Add after the existing requires at the top of the file:

```js
const { createTracer } = require('../trace/tracer');
const { newTraceId } = require('../trace/ids');
```

Change the signature line

```js
function createCollab({ agents, orchestrator, llm, getDefaults, sessions, workflows, store, now = Date.now }) {
```

to

```js
function createCollab({
  agents,
  orchestrator,
  llm,
  getDefaults,
  sessions,
  workflows,
  store,
  now = Date.now,
  tracer = createTracer({ store: null, flushMs: 0 }),
}) {
```

In `runtime(run, ctx)`, replace the whole `rt.span = (name, attrs = {}, parent = null) => { ... };` block (from `rt.span = (name, attrs = {}, parent = null) => {` to the `};` before `rt.post =`) with:

```js
    // Runs from before tracing (in runs.json) get a trace ID when they resume.
    if (!run.traceId) run.traceId = newTraceId();
    const tracing = tracer.scope({ traceId: run.traceId });
    // Each span goes to the tracer (the trace store) and to the run's live trace for the dashboard.
    rt.span = (name, attrs = {}, parent = null, opts = {}) => {
      const ts = tracing.span(name, attrs, parent, opts);
      const sp = {
        id: ts.id,
        parent: parent || null,
        name,
        start: now() - run.createdAt,
        end: null,
        status: 'ok',
        attrs: { ...attrs },
      };
      if (run.trace.length < 800) run.trace.push(sp);
      emit({ type: 'span', span: sp });
      return {
        id: ts.id,
        traceparent: ts.traceparent,
        capture: ts.capture,
        end(more = {}, err = null) {
          ts.end(more, err);
          sp.end = now() - run.createdAt;
          Object.assign(sp.attrs, more);
          if (err) {
            sp.status = 'error';
            sp.error = String(err.message || err).slice(0, 200);
          }
          emit({ type: 'span-end', span: sp });
          touch();
        },
      };
    };
```

In `execute(run, ctx, resume = null)`, replace

```js
    const root = rt.span(`invoke_workflow ${run.pattern}`, {
      'gen_ai.operation.name': 'invoke_workflow',
      'zp.pattern': run.pattern,
      'zp.effort': run.effort,
      ...(resume ? { 'zp.resumed': true } : {}),
    });
    rt.ctx.span = root.id;
```

with

```js
    // A resumed run continues its trace: the new workflow span hangs under the first one.
    const root = rt.span(
      `invoke_workflow ${run.pattern}`,
      {
        'gen_ai.operation.name': 'invoke_workflow',
        'zp.pattern': run.pattern,
        'zp.effort': run.effort,
        ...(resume ? { 'zp.resumed': true } : {}),
      },
      resume && run.rootSpanId ? run.rootSpanId : null,
    );
    if (!run.rootSpanId) run.rootSpanId = root.id;
    rt.ctx.span = root.id;
```

In `start(...)`, in the `const run = { ... }` literal, add after `trace: [],`:

```js
      traceId: newTraceId(),
      rootSpanId: null,
```

- [ ] **Step 6: Run the new test and the existing suite**

Run: `node --test test/trace-gateway.test.js`
Expected: PASS, 2 tests.

Run: `npm test`
Expected: PASS, no regressions (collaboration, gateway and A2A tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add lib/gateway/index.js lib/gateway/orchestrator.js lib/gateway/collab.js test/trace-gateway.test.js
git commit -m "Trace every gateway agent run, not only collaboration runs"
```

### Task 7: Dashboard API, timers and config

**Files:**
- Create: `lib/trace/api.js`, `test/trace-api.test.js`
- Modify: `server.js`, `config.example.json`

**Interfaces:**
- Consumes: reader (Task 5), `gateway.traces` (Task 6).
- Produces: `traceApi(url, method, { reader, store, tracer }) → { status, body } | null`, `queryOf(searchParams) → q`. Routes: `GET /api/traces`, `GET /api/traces/stats`, `GET /api/traces/<32 hex>`, `GET /api/spans`.

- [ ] **Step 1: Write the failing test** (`test/trace-api.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { traceApi, queryOf } = require('../lib/trace/api');

const T = 'a'.repeat(32);
const reader = {
  findTraces: (q) => [{ traceId: T, q }],
  getTrace: (id) => (id === T ? { traceId: T, spans: [] } : null),
  findSpans: (q) => [{ n: 'x', q }],
};
const deps = {
  reader,
  store: { stats: () => ({ traces: 1 }) },
  tracer: { stats: () => ({ dropped: 0 }) },
};
const get = (p) => traceApi(new URL(`http://x${p}`), 'GET', deps);

test('api: query parameters become a reader query', () => {
  const q = queryOf(new URL('http://x/?src=claude&errors=1&minMs=200&from=5&limit=10&q=web').searchParams);
  assert.deepEqual(
    { src: q.src, errors: q.errors, minMs: q.minMs, from: q.from, limit: q.limit, text: q.text },
    { src: 'claude', errors: true, minMs: 200, from: 5, limit: 10, text: 'web' },
  );
  assert.equal(queryOf(new URL('http://x/?minMs=abc').searchParams).minMs, undefined);
});

test('api: routes', () => {
  assert.equal(get('/api/traces?agent=sales').body.traces[0].q.agent, 'sales');
  assert.deepEqual(get(`/api/traces/${T}`), { status: 200, body: { traceId: T, spans: [] } });
  assert.equal(get(`/api/traces/${'b'.repeat(32)}`).status, 404);
  assert.deepEqual(get('/api/traces/stats').body, { store: { traces: 1 }, tracer: { dropped: 0 } });
  assert.equal(get('/api/spans?name=chat').body.spans[0].q.name, 'chat');
  assert.equal(get('/api/other'), null);
  assert.equal(traceApi(new URL('http://x/api/traces'), 'POST', deps), null);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-api.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/api'`.

- [ ] **Step 3: Implement** (`lib/trace/api.js`)

```js
// The dashboard's trace routes. Returns { status, body } for a trace route, or null for anything else.
const num = (v) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : undefined;
};

function queryOf(sp) {
  const str = (k) => (sp.get(k) ? String(sp.get(k)).slice(0, 200) : undefined);
  return {
    src: str('src'),
    agent: str('agent'),
    model: str('model'),
    tool: str('tool'),
    name: str('name'),
    text: str('q'),
    errors: sp.get('errors') === '1',
    minMs: num(sp.get('minMs')),
    minCost: num(sp.get('minCost')),
    from: num(sp.get('from')),
    to: num(sp.get('to')),
    limit: num(sp.get('limit')),
  };
}

function traceApi(url, method, { reader, store, tracer }) {
  if (method !== 'GET') return null;
  const p = url.pathname;
  if (p === '/api/traces') return { status: 200, body: { traces: reader.findTraces(queryOf(url.searchParams)) } };
  if (p === '/api/traces/stats') return { status: 200, body: { store: store.stats(), tracer: tracer.stats() } };
  if (p === '/api/spans') return { status: 200, body: { spans: reader.findSpans(queryOf(url.searchParams)) } };
  const m = p.match(/^\/api\/traces\/([0-9a-f]{32})$/);
  if (m) {
    const t = reader.getTrace(m[1]);
    return t ? { status: 200, body: t } : { status: 404, body: { error: 'no such trace' } };
  }
  return null;
}

module.exports = { traceApi, queryOf };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-api.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire the routes, timers and shutdown** (`server.js`)

Add after `const { createAuth, isLoopback } = require('./lib/auth');`:

```js
const { createTraceReader } = require('./lib/trace/reader');
const { traceApi } = require('./lib/trace/api');
```

Insert directly before the comment line `// Second brain sources: Obsidian by default, plus Logseq, ...`:

```js
// Traces: the gateway writes them; the dashboard and the acc_* MCP tools read them.
const traceReader = createTraceReader({ store: gateway.traces.store });
setInterval(
  () => {
    gateway.traces.tracer.flush();
    gateway.traces.store.applyRetention();
    gateway.traces.store.snapshot();
  },
  5 * 60 * 1000,
).unref();
```

Insert directly before the line `    if (url.pathname === '/api/platform') {`:

```js
    const traceRoute = traceApi(url, req.method, { reader: traceReader, ...gateway.traces });
    if (traceRoute) return send(res, traceRoute.status, traceRoute.body);
```

The existing SIGTERM/SIGINT handler already calls `gateway.flush()`, which now flushes the tracer and writes the snapshot.

- [ ] **Step 6: Document the config block** (`config.example.json`)

After the line `  "monthlyBudgetUSD": 0,` insert:

```json
  "tracing": {
    "retentionDays": 14,
    "maxBytes": 524288000,
    "capture": { "gateway": false, "claude": false, "codex": false },
    "maxExcerptBytes": 2048
  },
```

Run: `node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8'))"`
Expected: no output (valid JSON).

- [ ] **Step 7: Check the server end to end**

Run (in the background, then stop it): `PORT=4790 node server.js`
Then: `curl -s http://127.0.0.1:4790/api/traces/stats`
Expected: JSON with `store.traces` (a number) and `tracer.dropped` equal to 0. If the server is in sign-in mode, sign in through the dashboard first and use the browser instead of curl.

- [ ] **Step 8: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add lib/trace/api.js test/trace-api.test.js server.js config.example.json
git commit -m "Serve traces to the dashboard: list, open, spans and stats"
```

### Task 8: Traces page (list and waterfall)

**Files:**
- Create: `public/traces.js`
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces:**
- Consumes: `GET /api/traces`, `GET /api/traces/<id>`; globals from `public/app.js`: `api`, `esc`, `fmtUSD`, `ago`, `state`, `render`, `$`, `$$`.
- Produces: `viewTracesPage() → html`, `mountTraces()`, `traceRows(spans) → [{ s, depth }]`, `fmtDurUs(us) → string`.

- [ ] **Step 1: Create the page** (`public/traces.js`)

```js
'use strict';
/* Traces: every agent run as a tree of spans (OpenTelemetry GenAI names). A filtered list, and one trace
   as a waterfall. Data from /api/traces; nothing here writes. */

const trc = { list: null, open: null, openId: null, loading: false, filter: { src: '', q: '', errors: false } };

const fmtDurUs = (us) =>
  us >= 1e6 ? `${(us / 1e6).toFixed(2)} s` : us >= 1e3 ? `${(us / 1e3).toFixed(1)} ms` : `${Math.round(us)} µs`;

async function loadTraces() {
  if (trc.loading) return;
  trc.loading = true;
  const q = new URLSearchParams({ limit: '100' });
  if (trc.filter.src) q.set('src', trc.filter.src);
  if (trc.filter.q) q.set('q', trc.filter.q);
  if (trc.filter.errors) q.set('errors', '1');
  try {
    trc.list = (await api(`/api/traces?${q}`)).traces;
  } catch (err) {
    trc.list = { error: err.message };
  }
  trc.loading = false;
  if (state.route === 'traces') render(false);
}

async function openTrace(id) {
  trc.openId = id;
  trc.open = null;
  render(false);
  try {
    trc.open = await api(`/api/traces/${id}`);
  } catch (err) {
    trc.open = { error: err.message };
  }
  if (state.route === 'traces' && trc.openId === id) render(false);
}

// Depth-first order under each parent, children by start time; a span whose parent is missing is a root.
function traceRows(spans) {
  const ids = new Set(spans.map((s) => s.s));
  const byParent = new Map();
  for (const s of spans) {
    const k = s.p && ids.has(s.p) ? s.p : '';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(s);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.st - b.st);
  const out = [];
  const walk = (k, depth) => {
    for (const s of byParent.get(k) || []) {
      out.push({ s, depth });
      walk(s.s, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

function traceTable() {
  if (!trc.list) return '<div class="skeleton" style="height:180px"></div>';
  if (trc.list.error) return `<p class="muted">${esc(trc.list.error)}</p>`;
  if (!trc.list.length) return '<p class="muted">No traces yet. Run an agent from the gateway, then come back.</p>';
  return `<table class="tbl trc-list"><thead><tr><th>When</th><th>Trace</th><th>Source</th><th class="num">Spans</th><th class="num">Duration</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>${trc.list
    .map(
      (s) => `<tr data-trace="${s.traceId}" class="${s.traceId === trc.openId ? 'active' : ''}">
        <td>${esc(ago(s.start / 1000))}</td>
        <td><b>${esc(s.root || '(still running)')}</b>${s.errors ? ` <span class="state-pill" style="--c:#ff4f6d"><i></i>${s.errors} failed</span>` : ''}<small class="block muted">${esc([...s.agents, ...s.tools].slice(0, 6).join(' · '))}</small></td>
        <td><span class="tag">${esc(s.src || '')}</span></td>
        <td class="num">${s.spans}</td>
        <td class="num">${fmtDurUs(s.end - s.start)}</td>
        <td class="num">${(s.tokensIn + s.tokensOut).toLocaleString('en')}</td>
        <td class="num">${fmtUSD(s.costUSD || 0)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function traceDetail() {
  const t = trc.open;
  if (!t) return '<section class="holo panel"><div class="skeleton" style="height:220px"></div></section>';
  if (t.error) return `<section class="holo panel"><p class="muted">${esc(t.error)}</p></section>`;
  const min = Math.min(...t.spans.map((s) => s.st));
  const max = Math.max(...t.spans.map((s) => s.st + s.d));
  const total = Math.max(1, max - min);
  const crit = new Set(((t.analysis && t.analysis.criticalPath) || []).map((c) => c.spanId));
  const rows = traceRows(t.spans)
    .map(
      ({ s, depth }) => `<div class="trc-row${s.ok ? '' : ' err'}${crit.has(s.s) ? ' crit' : ''}" title="${esc(s.err || s.n)}">
        <span class="trc-name" style="padding-left:${depth * 14}px">${esc(s.n)}</span>
        <span class="trc-track"><i style="left:${(((s.st - min) / total) * 100).toFixed(3)}%;width:${Math.max(0.3, (s.d / total) * 100).toFixed(3)}%"></i></span>
        <span class="trc-dur num">${fmtDurUs(s.d)}${s.a && s.a['zp.timing'] === 'estimated' ? ' <small class="muted">est.</small>' : ''}</span></div>`,
    )
    .join('');
  return `<section class="holo panel"><div class="panel-head"><h3>${esc(t.summary.root || 'Trace')}</h3><span class="meta mono">${t.traceId} · ${t.spans.length} spans · ${fmtDurUs(total)}</span></div>
    <div class="trc-wf">${rows}</div></section>`;
}

function viewTracesPage() {
  if (!trc.list && !trc.loading) setTimeout(loadTraces);
  const srcs = ['gateway', 'claude', 'codex', 'remote'];
  return `<div class="holo-deck">
    <section class="holo panel"><div class="panel-head"><h3>Traces</h3><span class="meta">every agent run as a tree of spans · stored on this machine</span></div>
      <form class="trc-filter" id="trc-filter">
        <select name="src"><option value="">All sources</option>${srcs.map((s) => `<option value="${s}"${trc.filter.src === s ? ' selected' : ''}>${s}</option>`).join('')}</select>
        <input name="q" placeholder="Agent, model, tool or name" value="${esc(trc.filter.q)}">
        <label class="ie-switch"><input type="checkbox" name="errors"${trc.filter.errors ? ' checked' : ''}><span></span>Failed only</label>
        <button class="btn" type="submit">Search</button>
      </form>
      ${traceTable()}
    </section>
    ${trc.openId ? traceDetail() : ''}
  </div>`;
}

function mountTraces() {
  const f = $('#trc-filter');
  if (f)
    f.onsubmit = (e) => {
      e.preventDefault();
      const d = new FormData(f);
      trc.filter = { src: d.get('src') || '', q: String(d.get('q') || '').trim(), errors: d.get('errors') === 'on' };
      trc.list = null;
      loadTraces();
    };
  for (const r of $$('[data-trace]')) r.onclick = () => openTrace(r.dataset.trace);
}
```

- [ ] **Step 2: Register the page**

`public/index.html`: after the line `<a href="#live" data-route="live"><span data-icon="pulse"></span>Live monitor<b class="badge live" id="b-live"></b></a>` insert

```html
        <a href="#traces" data-route="traces"><span data-icon="layers"></span>Traces</a>
```

and before `<script src="app.js"></script>` insert

```html
  <script src="traces.js"></script>
```

`public/app.js`:
- in the titles object, after `  live: 'LIVE MONITOR',` add `  traces: 'TRACES',`
- in `VIEWS`, after `  live: viewLive,` add `  traces: viewTracesPage,`
- replace `if (!state.data && !['live', 'brain', 'integrations'].includes(state.route)) {` with `if (!state.data && !['live', 'brain', 'integrations', 'traces'].includes(state.route)) {`
- after `  if (state.route === 'integrations') mountIntegrations();` add `  if (state.route === 'traces') mountTraces();`

- [ ] **Step 3: Styles** (append to `public/styles.css`)

```css
/* Traces */
.trc-filter { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 12px; }
.trc-filter input { min-width: 220px; }
.trc-list tr[data-trace] { cursor: pointer; }
.trc-list tr.active td { background: rgba(98, 80, 214, 0.12); }
.trc-wf { display: grid; gap: 2px; font-size: 12px; }
.trc-row { display: grid; grid-template-columns: minmax(180px, 32%) 1fr 84px; gap: 8px; align-items: center; min-height: 22px; }
.trc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trc-track { position: relative; height: 10px; border-radius: 3px; background: rgba(143, 152, 204, 0.12); }
.trc-track i { position: absolute; top: 0; bottom: 0; border-radius: 3px; background: #2a78d6; }
.trc-row.crit .trc-track i { background: #ffb547; }
.trc-row.err .trc-track i { background: #ff4f6d; }
.trc-row.err .trc-name { color: #ff4f6d; }
.trc-dur { text-align: right; }
@media (max-width: 720px) {
  .trc-row { grid-template-columns: 1fr 64px; }
  .trc-track { grid-column: 1 / -1; grid-row: 2; }
}
```

- [ ] **Step 4: Check it in the browser**

Start the dashboard with `npm start`, open the Playground (`#gateway/playground`) and run any agent once, then open `#traces`.
Expected: the run is in the list with its root `invoke_agent <id>`, its spans, tokens and cost; clicking it shows the waterfall with the agent span, its `chat` spans and any `execute_tool` spans nested under it. At a 375 px wide window the waterfall wraps without horizontal scrolling. The browser console shows no errors.

- [ ] **Step 5: Commit**

```bash
git add public/traces.js public/index.html public/app.js public/styles.css
git commit -m "Add the Traces page: filtered list and waterfall"
```

**Phase 1 done when:** `npm test` passes; a chat with `agent/<id>`, `/v1/agents/<id>/run`, a workflow and a collaboration run each appear on the Traces page.

---

# Phase 2: Claude Code and Codex sessions

Result of the phase: every Claude Code and Codex session on this machine is a trace on the Traces page, with no copy of its content; subagents appear nested under the tool call that started them.

### Task 9: Claude Code sessions as spans

**Files:**
- Create: `lib/trace/sources/jsonl.js`, `lib/trace/sources/claude.js`, `test/trace-claude.test.js`

**Interfaces:**
- Consumes: `claude.listFiles()` (`lib/claude.js`), `stableId` (Task 1), `summarize` (Task 2), `makePricer`, `DEFAULT_PRICING` (`lib/pricing.js`).
- Produces: `readLines(file) → object[]`, `usOf(iso) → number | null` (jsonl.js); `buildSpans(file, { pricing, capture }) → span[]`, `createSource({ getPricing }) → { id: 'claude-trace', listFiles(), parseFile(file) → (summary & { ref: { file } }) | null }` (claude.js). `capture` is used from Task 19 on; until then it is `undefined`.

- [ ] **Step 1: Write the failing test** (`test/trace-claude.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSpans, createSource } = require('../lib/trace/sources/claude');

const at = (s) => `2026-10-22T10:00:${s}Z`;
const us = (s) => Date.parse(at(s)) * 1000;
const SONNET = 'claude-sonnet-4-5';

function session() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cc-'));
  const sid = 's-1';
  const file = path.join(dir, `${sid}.jsonl`);
  const L = (o) => JSON.stringify({ sessionId: sid, ...o });
  const usage = (input, output) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  fs.writeFileSync(
    file,
    [
      L({ type: 'user', uuid: 'u1', timestamp: at('00.000'), message: { role: 'user', content: 'fix the bug' } }),
      L({
        type: 'assistant',
        uuid: 'a1',
        timestamp: at('02.000'),
        message: { id: 'm1', model: SONNET, usage: usage(100, 20), content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] },
      }),
      L({
        type: 'user',
        uuid: 'r1',
        timestamp: at('03.000'),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }] },
      }),
      L({
        type: 'assistant',
        uuid: 'a2',
        timestamp: at('05.000'),
        message: { id: 'm2', model: SONNET, usage: usage(150, 30), content: [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: {} }] },
      }),
      L({
        type: 'user',
        uuid: 'r2',
        timestamp: at('09.000'),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'found it' }] }] },
      }),
      L({
        type: 'assistant',
        uuid: 'a3',
        timestamp: at('10.000'),
        message: { id: 'm3', model: SONNET, usage: usage(200, 10), content: [{ type: 'text', text: 'done' }] },
      }),
    ].join('\n') + '\n',
  );
  const sub = path.join(dir, sid, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'tu2' }));
  fs.writeFileSync(
    path.join(sub, 'agent-x.jsonl'),
    [
      L({ type: 'user', uuid: 'su1', isSidechain: true, timestamp: at('05.500'), message: { role: 'user', content: 'look' } }),
      L({
        type: 'assistant',
        uuid: 'sa1',
        isSidechain: true,
        timestamp: at('08.000'),
        message: { id: 'sm1', model: 'claude-haiku-4-5', usage: usage(50, 10), content: [{ type: 'text', text: 'here' }] },
      }),
    ].join('\n') + '\n',
  );
  return file;
}

test('claude: a session becomes the session span, a turn, model calls, tool calls and a nested subagent', () => {
  const file = session();
  const spans = buildSpans(file, { pricing: { [SONNET]: { input: 3, output: 15 } } });
  const by = (n) => spans.filter((s) => s.n === n);
  const [root] = by('invoke_agent claude-code');
  assert.equal(root.p, null);
  assert.equal(root.st, us('00.000'));
  assert.equal(root.d, 10e6);
  const turn = spans.find((s) => s.n === 'turn' && s.p === root.s);
  assert.equal(turn.d, 10e6);
  const chats = by(`chat ${SONNET}`);
  assert.equal(chats.length, 3);
  const m1 = chats.find((s) => s.st === us('00.000'));
  assert.equal(m1.d, 2e6);
  assert.equal(m1.p, turn.s);
  assert.equal(m1.a['zp.timing'], 'estimated');
  assert.ok(Math.abs(m1.a['zp.cost_usd'] - 0.0006) < 1e-12);
  const [bash] = by('execute_tool Bash');
  assert.equal(bash.d, 1e6);
  assert.equal(bash.p, turn.s);
  const [agentTool] = by('execute_tool Agent');
  const [sub] = by('invoke_agent Explore');
  assert.equal(sub.p, agentTool.s);
  assert.equal(sub.st, us('05.500'));
  assert.equal(spans.length, 10);
  assert.deepEqual(
    buildSpans(file).map((s) => s.s),
    spans.map((s) => s.s),
    'the same file gives the same IDs',
  );
});

test('claude: the indexer source summarizes a session and points at its file', async () => {
  const file = session();
  const s = await createSource().parseFile(file);
  assert.match(s.traceId, /^[0-9a-f]{32}$/);
  assert.equal(s.src, 'claude');
  assert.equal(s.root, 'invoke_agent claude-code');
  assert.equal(s.tokensIn, 500);
  assert.equal(s.tokensOut, 70);
  assert.deepEqual(s.agents.sort(), ['Explore', 'claude-code']);
  assert.deepEqual(s.ref, { file });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-claude.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/sources/claude'`.

- [ ] **Step 3: Shared JSONL helpers** (`lib/trace/sources/jsonl.js`)

```js
// Reading agent session logs for tracing: whole lines only (a line still being written is skipped), and
// ISO timestamps as microseconds.
const fs = require('fs');

function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a line still being written */
    }
  }
  return out;
}

const usOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t * 1000 : null;
};

module.exports = { readLines, usOf };
```

- [ ] **Step 4: Implement** (`lib/trace/sources/claude.js`)

```js
// A Claude Code session (~/.claude/projects/<project>/<session>.jsonl; subagents in
// <session>/subagents/agent-*.jsonl, each with a .meta.json naming the tool call that started it) as
// spans: the session, each typed prompt's turn, each model call and each tool call, subagents nested
// under the tool call that started them. IDs derive from the session and message IDs, so the same file
// always gives the same trace. A log line carries the time it was written, not when a model call began,
// so a model call's span starts at the line before it and is marked zp.timing "estimated".
const fs = require('fs');
const path = require('path');
const claude = require('../../claude');
const { stableId } = require('../ids');
const { summarize } = require('../summary');
const { makePricer, DEFAULT_PRICING } = require('../../pricing');
const { readLines, usOf } = require('./jsonl');

const isPrompt = (o) =>
  o.type === 'user' &&
  o.message &&
  (typeof o.message.content === 'string' ||
    (Array.isArray(o.message.content) &&
      o.message.content.some((b) => b.type === 'text') &&
      !o.message.content.some((b) => b.type === 'tool_result')));
const resultText = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '';

function subagentsOf(file) {
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  const map = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return map;
  }
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const jsonl = path.join(dir, n.replace(/\.meta\.json$/, '.jsonl'));
      if (meta.toolUseId && fs.existsSync(jsonl))
        map.set(meta.toolUseId, { file: jsonl, type: meta.agentType || 'subagent' });
    } catch {
      /* unreadable meta file */
    }
  }
  return map;
}

function costOf(pricer, model, u) {
  const cc = u.cache_creation || {};
  const cw5 = cc.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0;
  const cw1 = cc.ephemeral_1h_input_tokens || 0;
  return pricer
    .parts(model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, cw5, cw1)
    .reduce((a, b) => a + b, 0);
}

// The spans of one transcript, hung under parentId (null for the session itself).
function transcript(lines, ctx, parentId, agentName, key) {
  const { traceId, pricer, subagents, spans, capture } = ctx;
  const timed = lines.filter((o) => usOf(o.timestamp) !== null);
  if (!timed.length) return;
  const add = (k, name, parent, st, attrs) => {
    const sp = {
      t: traceId,
      s: stableId(`${traceId}:${k}`, 8),
      p: parent,
      n: name,
      k: 'internal',
      st,
      d: 0,
      ok: true,
      src: 'claude',
      svc: 'claude-code',
      a: attrs,
    };
    spans.push(sp);
    return sp;
  };
  const close = (sp, end) => {
    sp.d = Math.max(0, end - sp.st);
  };
  const first = usOf(timed[0].timestamp);
  const last = usOf(timed[timed.length - 1].timestamp);
  const root = add(key, `invoke_agent ${agentName}`, parentId, first, {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.id': agentName,
  });
  close(root, last);
  let turn = null;
  let prev = first;
  const chats = new Map(); // message id -> span: streamed content blocks repeat the message
  const tools = new Map(); // tool_use id -> span
  const finished = new Set();
  for (const o of timed) {
    const ts = usOf(o.timestamp);
    const m = o.message || {};
    if (isPrompt(o)) {
      if (turn) close(turn, prev);
      turn = add(o.uuid || `turn:${ts}`, 'turn', root.s, ts, { 'gen_ai.operation.name': 'turn' });
    } else if (o.type === 'assistant' && m.model && m.model !== '<synthetic>') {
      const parent = turn ? turn.s : root.s;
      let chat = chats.get(m.id);
      if (!chat) {
        const u = m.usage || {};
        chat = add(m.id || o.uuid, `chat ${m.model}`, parent, prev, {
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': m.model,
          'gen_ai.usage.input_tokens':
            (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          'gen_ai.usage.output_tokens': u.output_tokens || 0,
          'zp.cache_read_tokens': u.cache_read_input_tokens || 0,
          'zp.cost_usd': costOf(pricer, m.model, u),
          'zp.timing': 'estimated',
        });
        chats.set(m.id, chat);
      }
      close(chat, ts);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text' && capture)
          chat.x = { out: capture.excerpt(`${(chat.x && chat.x.out) || ''}${b.text || ''}`) };
        if (b.type !== 'tool_use' || tools.has(b.id)) continue;
        const t = add(b.id, `execute_tool ${b.name}`, parent, ts, {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': b.name,
          'gen_ai.tool.call.id': b.id,
        });
        if (capture) t.x = { in: capture.excerpt(JSON.stringify(b.input || {})) };
        tools.set(b.id, t);
      }
    } else if (o.type === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        const t = b.type === 'tool_result' && tools.get(b.tool_use_id);
        if (!t) continue;
        close(t, ts);
        finished.add(b.tool_use_id);
        if (b.is_error) {
          t.ok = false;
          t.err = resultText(b.content).slice(0, 200) || 'tool error';
        }
        if (capture) t.x = { ...(t.x || {}), out: capture.excerpt(resultText(b.content)) };
      }
    }
    prev = ts;
  }
  if (turn) close(turn, prev);
  for (const [id, t] of tools) {
    if (!finished.has(id)) {
      close(t, last);
      t.a['zp.unfinished'] = true;
    }
    const sub = subagents.get(id);
    if (sub) {
      subagents.delete(id);
      transcript(readLines(sub.file), ctx, t.s, sub.type, `sub:${id}`);
    }
  }
}

function buildSpans(file, { pricing, capture } = {}) {
  const lines = readLines(file);
  const sessionId = (lines.find((o) => o.sessionId) || {}).sessionId || path.basename(file, '.jsonl');
  const ctx = {
    traceId: stableId(`claude:${sessionId}`, 16),
    pricer: makePricer(pricing || DEFAULT_PRICING),
    subagents: subagentsOf(file),
    spans: [],
    capture,
  };
  transcript(lines, ctx, null, 'claude-code', 'session');
  return ctx.spans;
}

// For an Indexer: one summary per main session file (subagent files are read with their session).
function createSource({ getPricing = () => undefined } = {}) {
  return {
    id: 'claude-trace',
    listFiles: () => claude.listFiles().filter((f) => !f.split(path.sep).includes('subagents')),
    async parseFile(file) {
      const spans = buildSpans(file, { pricing: getPricing() });
      if (!spans.length) return null;
      return { ...summarize(spans[0].t, spans), ref: { file } };
    },
  };
}

module.exports = { buildSpans, createSource };
```

- [ ] **Step 5: Run the test and see it pass**

Run: `node --test test/trace-claude.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 6: Try it on a real session**

Run: `node -e "const c=require('./lib/trace/sources/claude');const f=require('./lib/claude').listFiles().filter(x=>!x.includes('/subagents/'))[0];const s=c.buildSpans(f);console.log(s.length, s[0] && s[0].n)"`
Expected: a span count above 0 and `invoke_agent claude-code`. (No content is printed.)

- [ ] **Step 7: Commit**

```bash
git add lib/trace/sources/jsonl.js lib/trace/sources/claude.js test/trace-claude.test.js
git commit -m "Build traces from Claude Code sessions, subagents included"
```

### Task 10: Codex sessions as spans

**Files:**
- Create: `lib/trace/sources/codex.js`, `test/trace-codex.test.js`

**Interfaces:**
- Consumes: `codex.listFiles()` (`lib/codex.js`), `readLines`, `usOf` (Task 9), `stableId`, `summarize`, `makePricer`.
- Produces: `buildSpans(file, { pricing, capture }) → span[]`, `createSource({ getPricing }) → { id: 'codex-trace', listFiles(), parseFile(file) }`.

- [ ] **Step 1: Write the failing test** (`test/trace-codex.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSpans, createSource } = require('../lib/trace/sources/codex');

const at = (s) => `2026-10-22T09:00:${s}Z`;
const us = (s) => Date.parse(at(s)) * 1000;
const MODEL = 'gpt-5.2-codex';

function rollout() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cx-')), 'rollout-x.jsonl');
  const started = Date.parse(at('00.000')) / 1000;
  const L = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
  fs.writeFileSync(
    file,
    [
      L(at('00.000'), 'session_meta', { id: 'c-1' }),
      L(at('00.050'), 'event_msg', { type: 'task_started', turn_id: 't1', started_at: started }),
      L(at('00.100'), 'turn_context', { turn_id: 't1', model: MODEL }),
      L(at('02.000'), 'response_item', { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' }),
      L(at('03.000'), 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 1' }),
      L(at('04.000'), 'token_usage_record', {
        response_id: 'r1',
        usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 },
      }),
      L(at('05.000'), 'event_msg', { type: 'task_complete', turn_id: 't1', started_at: started, duration_ms: 5000 }),
    ].join('\n') + '\n',
  );
  return file;
}

test('codex: turns timed by Codex, tool calls, and model calls from usage records', () => {
  const spans = buildSpans(rollout(), { pricing: { [MODEL]: { input: 1, output: 10, cacheRead: 0.1 } } });
  const one = (n) => spans.find((s) => s.n === n);
  const root = one('invoke_agent codex');
  assert.equal(root.d, 5e6);
  const turn = one('turn');
  assert.equal(turn.st, us('00.000'));
  assert.equal(turn.d, 5e6);
  assert.equal(turn.a['zp.timing'], undefined);
  const tool = one('execute_tool shell');
  assert.equal(tool.d, 1e6);
  assert.equal(tool.ok, false);
  assert.equal(tool.p, turn.s);
  const chat = one(`chat ${MODEL}`);
  assert.equal(chat.st, us('03.000'));
  assert.equal(chat.d, 1e6);
  assert.equal(chat.a['gen_ai.usage.input_tokens'], 1000);
  assert.equal(chat.a['zp.timing'], 'estimated');
  assert.ok(Math.abs(chat.a['zp.cost_usd'] - 0.00132) < 1e-12);
});

test('codex: the indexer source summarizes a rollout', async () => {
  const file = rollout();
  const s = await createSource().parseFile(file);
  assert.equal(s.src, 'codex');
  assert.equal(s.errors, 1);
  assert.equal(s.tokensIn, 1000);
  assert.deepEqual(s.ref, { file });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-codex.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/sources/codex'`.

- [ ] **Step 3: Implement** (`lib/trace/sources/codex.js`)

```js
// A Codex session (~/.codex/sessions/**/rollout-*.jsonl) as spans: the session, each turn (task_started
// to task_complete or turn_aborted, timed by Codex itself), each tool call, and each model response from
// token_usage_record (token_count on older builds). A response line has no start time, so a model call's
// span starts at the line before it and is marked zp.timing "estimated".
const path = require('path');
const codex = require('../../codex');
const { stableId } = require('../ids');
const { summarize } = require('../summary');
const { makePricer, DEFAULT_PRICING } = require('../../pricing');
const { readLines, usOf } = require('./jsonl');

const FAILED = /^\s*Script failed|"exit_code":\s*[1-9]|Exit code:? [1-9]|Process exited with code [1-9]/;
const outputText = (out) =>
  typeof out === 'string'
    ? out
    : out && typeof out === 'object'
      ? String(out.output ?? out.content ?? JSON.stringify(out))
      : '';

function buildSpans(file, { pricing, capture } = {}) {
  const lines = readLines(file);
  const meta = lines.find((o) => o.type === 'session_meta');
  const sid = (meta && meta.payload && (meta.payload.id || meta.payload.session_id)) || path.basename(file, '.jsonl');
  const traceId = stableId(`codex:${sid}`, 16);
  const pricer = makePricer(pricing || DEFAULT_PRICING);
  const spans = [];
  const add = (k, name, parent, st, attrs) => {
    const sp = {
      t: traceId,
      s: stableId(`${traceId}:${k}`, 8),
      p: parent,
      n: name,
      k: 'internal',
      st,
      d: 0,
      ok: true,
      src: 'codex',
      svc: 'codex',
      a: attrs,
    };
    spans.push(sp);
    return sp;
  };
  const close = (sp, end) => {
    sp.d = Math.max(0, end - sp.st);
  };
  const timed = lines.filter((o) => usOf(o.timestamp) !== null);
  if (!timed.length) return spans;
  const first = usOf(timed[0].timestamp);
  const last = usOf(timed[timed.length - 1].timestamp);
  const root = add('session', 'invoke_agent codex', null, first, {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.id': 'codex',
  });
  close(root, last);
  const hasRecords = timed.some((o) => o.type === 'token_usage_record');
  let model = 'codex';
  let turn = null;
  let prev = first;
  const turns = new Map();
  const doneTurns = new Set();
  const tools = new Map();
  const doneTools = new Set();
  for (const o of timed) {
    const ts = usOf(o.timestamp);
    const p = o.payload || {};
    const parent = turn ? turn.s : root.s;
    if (o.type === 'turn_context' && p.model) model = p.model;
    else if (o.type === 'event_msg' && p.type === 'task_started') {
      turn = add(`turn:${p.turn_id || ts}`, 'turn', root.s, p.started_at ? p.started_at * 1e6 : ts, {
        'gen_ai.operation.name': 'turn',
      });
      turns.set(p.turn_id, turn);
    } else if (o.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
      const t = turns.get(p.turn_id) || turn;
      if (t) {
        if (p.duration_ms != null) t.d = p.duration_ms * 1000;
        else close(t, ts);
        if (p.type === 'turn_aborted') {
          t.ok = false;
          t.err = `turn aborted: ${p.reason || 'unknown'}`;
        }
        doneTurns.add(t);
      }
    } else if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      const t = add(`tool:${p.call_id}`, `execute_tool ${p.name}`, parent, ts, {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': p.name,
        'gen_ai.tool.call.id': p.call_id,
      });
      if (capture) t.x = { in: capture.excerpt(String(p.arguments ?? p.input ?? '')) };
      tools.set(p.call_id, t);
    } else if (
      o.type === 'response_item' &&
      (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')
    ) {
      const t = tools.get(p.call_id);
      if (t) {
        close(t, ts);
        doneTools.add(p.call_id);
        const text = outputText(p.output);
        if (FAILED.test(text)) {
          t.ok = false;
          t.err = text.slice(0, 200);
        }
        if (capture) t.x = { ...(t.x || {}), out: capture.excerpt(text) };
      }
    } else if (
      (o.type === 'token_usage_record' && p.usage) ||
      (!hasRecords && o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage)
    ) {
      const u = o.type === 'token_usage_record' ? p.usage : p.info.last_token_usage;
      const input = u.input_tokens || 0;
      const cached = u.cached_input_tokens || 0;
      const chat = add(`chat:${p.response_id || ts}`, `chat ${model}`, parent, prev, {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': model,
        'gen_ai.usage.input_tokens': input,
        'gen_ai.usage.output_tokens': u.output_tokens || 0,
        'zp.cache_read_tokens': cached,
        'zp.cost_usd': pricer.parts(model, input - cached, u.output_tokens || 0, cached, 0, 0).reduce((a, b) => a + b, 0),
        'zp.timing': 'estimated',
      });
      close(chat, ts);
    }
    prev = ts;
  }
  for (const t of turns.values()) if (!doneTurns.has(t)) close(t, last);
  for (const [id, t] of tools)
    if (!doneTools.has(id)) {
      close(t, last);
      t.a['zp.unfinished'] = true;
    }
  return spans;
}

function createSource({ getPricing = () => undefined } = {}) {
  return {
    id: 'codex-trace',
    listFiles: () => codex.listFiles(),
    async parseFile(file) {
      const spans = buildSpans(file, { pricing: getPricing() });
      if (!spans.length) return null;
      return { ...summarize(spans[0].t, spans), ref: { file } };
    },
  };
}

module.exports = { buildSpans, createSource };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-codex.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/sources/codex.js test/trace-codex.test.js
git commit -m "Build traces from Codex sessions"
```

### Task 11: Session index, builders and the dashboard

**Files:**
- Create: `lib/trace/sources/index.js`, `test/trace-sessions.test.js`
- Modify: `lib/indexer.js`, `server.js`

**Interfaces:**
- Consumes: the two sources (Tasks 9 and 10), `Indexer` (`lib/indexer.js`), `createTraceReader` (Task 5).
- Produces: `new Indexer(sources, cacheFile, version = 6)`; `ROOTS`, `under(file, root) → boolean`, `sessionSources({ getPricing }) → source[]`, `builders({ getPricing, getCapture, roots }) → { claude(summary), codex(summary) }`, `sessionsFrom(results) → { summaries(), get(id) }`, `cachedResults(cacheFile) → () → summary[]`.

- [ ] **Step 1: Write the failing test** (`test/trace-sessions.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Indexer } = require('../lib/indexer');
const { under, builders, sessionsFrom, cachedResults } = require('../lib/trace/sources');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-ss-'));

test('sessions: paths outside the session roots are refused', () => {
  const root = tmp();
  assert.ok(under(path.join(root, 'p', 'a.jsonl'), root));
  assert.ok(!under(path.join(root, '..', 'a.jsonl'), root));
  assert.ok(!under(root, root));
  const b = builders({ roots: { claude: root, codex: root } });
  assert.equal(b.claude({ ref: { file: '/etc/passwd' } }), null);
});

test('sessions: an indexer with its own cache version, read back from another process by its cache file', async () => {
  const dir = tmp();
  const cache = path.join(dir, 'trace-sessions.json');
  const log = path.join(dir, 'session.jsonl');
  fs.writeFileSync(log, '{}\n');
  const summary = { traceId: 'e'.repeat(32), src: 'claude', ref: { file: log } };
  const source = { id: 'fake', listFiles: () => [log], parseFile: async () => summary };
  const idx = new Indexer([source], cache, 'trace-1');
  await idx.refresh();
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).version, 'trace-1');
  const sessions = sessionsFrom(cachedResults(cache));
  assert.equal(sessions.summaries().length, 1);
  assert.equal(sessions.get('e'.repeat(32)).src, 'claude');
  assert.equal(sessions.get('f'.repeat(32)), null);
  assert.equal(new Indexer([source], cache).results().length, 0, 'the log index (version 6) ignores this cache');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-sessions.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/sources'`.

- [ ] **Step 3: Let an Indexer carry its own cache version** (`lib/indexer.js`)

Replace

```js
  constructor(sources, cacheFile) {
    this.sources = sources;
    this.cacheFile = cacheFile;
```

with

```js
  // version: the cache format; a second indexer (trace sessions) keeps its own.
  constructor(sources, cacheFile, version = CACHE_VERSION) {
    this.sources = sources;
    this.cacheFile = cacheFile;
    this.cacheVersion = version;
```

Replace `if (c.version === CACHE_VERSION) this.files = c.files;` with `if (c.version === this.cacheVersion) this.files = c.files;`, and `fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files: this.files }));` with `fs.writeFileSync(tmp, JSON.stringify({ version: this.cacheVersion, files: this.files }));`.

- [ ] **Step 4: Implement** (`lib/trace/sources/index.js`)

```js
// Session traces: the Indexer sources that summarize Claude Code and Codex sessions, the builders that
// rebuild a session's spans when it is opened (only from files under the session roots), and the session
// summaries as the reader wants them, from a live Indexer or from its cache file in another process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeTrace = require('./claude');
const codexTrace = require('./codex');

const ROOTS = {
  claude: path.join(os.homedir(), '.claude', 'projects'),
  codex: path.join(os.homedir(), '.codex', 'sessions'),
};

function under(file, root) {
  const rel = path.relative(root, path.resolve(String(file)));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const sessionSources = ({ getPricing = () => undefined } = {}) => [
  claudeTrace.createSource({ getPricing }),
  codexTrace.createSource({ getPricing }),
];

// getCapture(src) returns the excerpt helper when capture is on for that source, else null (Task 19).
function builders({ getPricing = () => undefined, getCapture = () => null, roots = ROOTS } = {}) {
  const build = (mod, src) => (s) =>
    s && s.ref && under(s.ref.file, roots[src])
      ? mod.buildSpans(s.ref.file, { pricing: getPricing(), capture: getCapture(src) || undefined })
      : null;
  return { claude: build(claudeTrace, 'claude'), codex: build(codexTrace, 'codex') };
}

const sessionsFrom = (results) => ({
  summaries: () => results().filter(Boolean),
  get: (id) => results().find((s) => s && s.traceId === id) || null,
});

// The server's session index, read by another process (mcp.js); re-read when the file changes.
function cachedResults(cacheFile) {
  let memo = { mtimeMs: -1, list: [] };
  return () => {
    let st;
    try {
      st = fs.statSync(cacheFile);
    } catch {
      return [];
    }
    if (st.mtimeMs !== memo.mtimeMs)
      try {
        const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        memo = { mtimeMs: st.mtimeMs, list: Object.values(j.files || {}).map((f) => f.result) };
      } catch {
        /* being rewritten: keep the last good list */
      }
    return memo.list;
  };
}

module.exports = { ROOTS, under, sessionSources, builders, sessionsFrom, cachedResults };
```

- [ ] **Step 5: Run the test and see it pass**

Run: `node --test test/trace-sessions.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 6: Index sessions in the server** (`server.js`)

Add after `const { traceApi } = require('./lib/trace/api');`:

```js
const { sessionSources, builders: traceBuilders, sessionsFrom } = require('./lib/trace/sources');
```

Replace

```js
const traceReader = createTraceReader({ store: gateway.traces.store });
```

with

```js
// Claude Code and Codex sessions are summarized into their own cache; their spans are built when opened.
const traceSessions = DEMO
  ? null
  : new Indexer(
      sessionSources({ getPricing: () => config.pricing }),
      path.join(DIR, '.cache', 'trace-sessions.json'),
      'trace-1',
    );
const traceReader = createTraceReader({
  store: gateway.traces.store,
  sessions: traceSessions ? sessionsFrom(() => traceSessions.results()) : null,
  builders: traceBuilders({ getPricing: () => config.pricing }),
});
```

After the line `  setInterval(() => indexer.refresh(), RESCAN_MS).unref();` add:

```js
  if (traceSessions) {
    traceSessions.refresh();
    setInterval(() => traceSessions.refresh(), RESCAN_MS).unref();
  }
```

- [ ] **Step 7: Check it in the browser**

Restart the dashboard (`npm start`). The first session scan takes about as long as the existing log index. Open `#traces`, choose source `claude`.
Expected: recent Claude Code sessions are listed with their tokens and cost; opening one shows turns, model calls marked `est.`, tool calls, and subagents nested under their Agent tool call. Choose `codex`: Codex sessions appear with turns timed exactly (no `est.` on turns).

- [ ] **Step 8: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add lib/indexer.js lib/trace/sources/index.js test/trace-sessions.test.js server.js
git commit -m "Index Claude Code and Codex sessions as traces"
```

**Phase 2 done when:** sessions from both tools are searchable on the Traces page, open in under a second for a typical session, and nothing from their content is written to disk by ZAAFPulse.

---

# Phase 3: Analysis

Result of the phase: an opened trace is adjusted (duplicates, orphans, clock skew) and explained (critical path, cost and tokens per branch, self time, likely root cause); the dashboard shows the dependencies between agents, models and tools; AI clients can search and read traces through MCP.

### Task 12: Read-time adjusters

**Files:**
- Create: `lib/trace/adjust.js`, `test/trace-adjust.test.js`

**Interfaces:**
- Produces: `adjust(spans) → span[]` (new objects, sorted by start; may set `a['zp.orphan']` and `a['zp.skew_us']`).

- [ ] **Step 1: Write the failing test** (`test/trace-adjust.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { adjust } = require('../lib/trace/adjust');

const T = 'a'.repeat(32);
const id = (c) => c.repeat(16);
const sp = (c, p, st, d, svc = 'zaafpulse') => ({
  t: T,
  s: id(c),
  p: p ? id(p) : null,
  n: `op ${c}`,
  k: 'internal',
  st,
  d,
  ok: true,
  src: 'gateway',
  svc,
  a: {},
});
const get = (list, c) => list.find((s) => s.s === id(c));

test('adjust: a duplicated span keeps its longer record; the input is not modified', () => {
  const input = [sp('a', null, 0, 100), sp('b', 'a', 10, 0), sp('b', 'a', 10, 50)];
  const out = adjust(input);
  assert.equal(out.length, 2);
  assert.equal(get(out, 'b').d, 50);
  assert.equal(input[1].d, 0);
});

test('adjust: orphans hang under the root and keep their lost parent as an attribute', () => {
  const out = adjust([sp('a', null, 0, 100), sp('c', 'z', 10, 5)]);
  assert.equal(get(out, 'c').p, id('a'));
  assert.equal(get(out, 'c').a['zp.orphan'], id('z'));
});

test('adjust: without a root, the earliest span becomes it', () => {
  const out = adjust([sp('c', 'y', 20, 5), sp('b', 'x', 5, 10)]);
  assert.equal(get(out, 'b').p, null);
  assert.equal(get(out, 'b').a['zp.orphan'], id('x'));
  assert.equal(get(out, 'c').p, id('b'));
});

test('adjust: clock skew is corrected only across services, and carried to the same service below', () => {
  const out = adjust([
    sp('a', null, 1000, 1000),
    sp('b', 'a', 5000, 200, 'far'), // outside its parent: centred inside it
    sp('c', 'b', 5050, 50, 'far'), // same service as b: moves with it
    sp('d', 'a', 9000, 10), // same service as a: left alone
  ]);
  assert.equal(get(out, 'b').st, 1400);
  assert.equal(get(out, 'b').a['zp.skew_us'], -3600);
  assert.equal(get(out, 'c').st, 1450);
  assert.equal(get(out, 'd').st, 9000);
  assert.deepEqual(
    out.map((s) => s.st),
    [1000, 1400, 1450, 9000],
  );
});

test('adjust: a longer child that starts before its parent moves to the parent start', () => {
  const out = adjust([sp('a', null, 1000, 100), sp('b', 'a', 900, 500, 'far')]);
  assert.equal(get(out, 'b').st, 1000);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-adjust.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/adjust'`.

- [ ] **Step 3: Implement** (`lib/trace/adjust.js`)

```js
// Read-time fixes, in the order of Jaeger's standard adjusters: duplicate span IDs, orphans, clock skew
// between processes, then start order. The input is not modified.

// Jaeger's rule: a child outside its parent is centred inside it; a longer child that starts first is moved
// to the parent's start.
function skewOf(parent, child) {
  if (child.d > parent.d) return child.st < parent.st ? parent.st - child.st : 0;
  if (child.st >= parent.st && child.st + child.d <= parent.st + parent.d) return 0;
  return parent.st + Math.floor((parent.d - child.d) / 2) - child.st;
}

function adjust(spans) {
  // A span sent twice (once at start, once with its end) keeps the longer record.
  const byId = new Map();
  for (const sp of spans) {
    const had = byId.get(sp.s);
    if (!had || sp.d > had.d) byId.set(sp.s, { ...sp, a: { ...(sp.a || {}) } });
  }
  const list = [...byId.values()].sort((a, b) => a.st - b.st);

  // Orphans hang under the root; without a root, the earliest span becomes it.
  let root = list.find((s) => !s.p);
  if (!root && list.length) {
    root = list[0];
    root.a['zp.orphan'] = root.p;
    root.p = null;
  }
  for (const sp of list)
    if (sp.p && !byId.has(sp.p)) {
      sp.a['zp.orphan'] = sp.p;
      sp.p = root.s;
    }

  // Clock skew: only where a child runs in another service, and the shift carries to its descendants in
  // that same service.
  const children = new Map();
  for (const sp of list)
    if (sp.p) {
      if (!children.has(sp.p)) children.set(sp.p, []);
      children.get(sp.p).push(sp);
    }
  const shift = (sp, delta) => {
    sp.st += delta;
    for (const c of children.get(sp.s) || []) if (c.svc === sp.svc) shift(c, delta);
  };
  const seen = new Set();
  const visit = (sp) => {
    if (seen.has(sp.s)) return;
    seen.add(sp.s);
    for (const c of children.get(sp.s) || []) {
      if (c.svc !== sp.svc) {
        const delta = skewOf(sp, c);
        if (delta) {
          shift(c, delta);
          c.a['zp.skew_us'] = delta;
        }
      }
      visit(c);
    }
  };
  for (const sp of list) if (!sp.p) visit(sp);

  return list.sort((a, b) => a.st - b.st);
}

module.exports = { adjust, skewOf };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-adjust.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/adjust.js test/trace-adjust.test.js
git commit -m "Add read-time trace adjusters: duplicates, orphans, clock skew"
```

### Task 13: Critical path, rollups, self time, root cause

**Files:**
- Create: `lib/trace/analyze.js`, `test/trace-analyze.test.js`

**Interfaces:**
- Produces: `analyze(spans) → { rootSpanId, criticalPath: [{ spanId, start, end }], rollup: { [spanId]: { tokensIn, tokensOut, costUSD, spans, errors } }, selfTime: { [spanId]: us }, rootCause: { spanId, name, error, onCriticalPath } | null }`. Also exports `criticalPath(spans) → sections`.

- [ ] **Step 1: Write the failing test** (`test/trace-analyze.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, criticalPath } = require('../lib/trace/analyze');

const T = 'a'.repeat(32);
const id = (c) => c.repeat(16);
const sp = (c, p, st, d, a = {}, ok = true) => ({
  t: T,
  s: id(c),
  p: p ? id(p) : null,
  n: `op ${c}`,
  k: 'internal',
  st,
  d,
  ok,
  src: 'gateway',
  svc: 'zaafpulse',
  a,
  ...(ok ? {} : { err: `${c} failed` }),
});
const path = (spans) => criticalPath(spans).map((x) => [x.spanId[0], x.start, x.end]);

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

test('analyze: rollups, self time and the failing span on the critical path', () => {
  const chat = (tin, tout, cost) => ({
    'gen_ai.operation.name': 'chat',
    'gen_ai.usage.input_tokens': tin,
    'gen_ai.usage.output_tokens': tout,
    'zp.cost_usd': cost,
  });
  const spans = [
    sp('a', null, 0, 100),
    sp('b', 'a', 0, 40, chat(10, 5, 0.01)),
    sp('c', 'a', 50, 40, {}, false),
    sp('d', 'c', 60, 20, chat(3, 1, 0.002)),
    sp('e', 'a', 5, 1, {}, false), // fails earlier, but off the critical path
  ];
  const r = analyze(spans);
  assert.equal(r.rootSpanId, id('a'));
  assert.equal(r.rollup[id('a')].tokensIn, 13);
  assert.equal(r.rollup[id('a')].tokensOut, 6);
  assert.ok(Math.abs(r.rollup[id('a')].costUSD - 0.012) < 1e-12);
  assert.equal(r.rollup[id('a')].spans, 5);
  assert.equal(r.rollup[id('a')].errors, 2);
  assert.equal(r.rollup[id('c')].tokensIn, 3);
  assert.equal(r.selfTime[id('a')], 20);
  assert.equal(r.selfTime[id('c')], 20);
  assert.deepEqual(r.rootCause, { spanId: id('c'), name: 'op c', error: 'c failed', onCriticalPath: true });
  assert.equal(analyze([sp('a', null, 0, 10)]).rootCause, null);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-analyze.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/analyze'`.

- [ ] **Step 3: Implement** (`lib/trace/analyze.js`)

```js
// What a trace means: the critical path (Jaeger's algorithm), tokens and cost rolled up per subtree, each
// span's self time, and the failed span most likely to explain the outcome.

function tree(spans) {
  const byId = new Map(spans.map((s) => [s.s, s]));
  const kids = new Map();
  for (const s of spans)
    if (s.p && byId.has(s.p)) {
      if (!kids.has(s.p)) kids.set(s.p, []);
      kids.get(s.p).push(s);
    }
  const roots = spans.filter((s) => !s.p || !byId.has(s.p)).sort((a, b) => a.st - b.st);
  return { byId, kids, roots };
}

// Children clipped to their parent, top-down; a child entirely outside its parent is dropped with its
// subtree (Jaeger's removeOverflowingChildren, in a fixed order).
function clipped(root, kids) {
  const boxes = new Map();
  const visit = (sp, parent) => {
    let st = sp.st;
    let end = sp.st + sp.d;
    if (parent) {
      if (end <= parent.st || st >= parent.end) return;
      st = Math.max(st, parent.st);
      end = Math.min(end, parent.end);
    }
    const box = { s: sp.s, p: parent ? parent.s : null, st, end, kids: [] };
    boxes.set(sp.s, box);
    if (parent) parent.kids.push(box);
    for (const c of kids.get(sp.s) || []) visit(c, box);
  };
  visit(root, null);
  return boxes;
}

// From the root, take the last-finishing child; when a span has no such child, its section up to the
// returning point is on the path and the walk goes back to its parent, looking for a child that finished
// before this span started. The recursion of the Go version, as a loop.
function criticalPath(spans) {
  const { kids, roots } = tree(spans);
  if (!roots.length) return [];
  const boxes = clipped(roots[0], kids);
  const out = [];
  let cur = boxes.get(roots[0].s);
  let ret = null;
  for (let guard = 0; cur && guard < boxes.size * 4 + 4; guard++) {
    const end = ret === null ? cur.end : ret;
    let lfc = null;
    for (const c of cur.kids) {
      if (ret !== null && !(c.st < ret && c.end <= ret)) continue;
      if (!lfc || c.end > lfc.end) lfc = c;
    }
    if (lfc) {
      if (lfc.end !== end) out.push({ spanId: cur.s, start: lfc.end, end });
      cur = lfc;
      ret = null;
    } else {
      if (cur.st !== end) out.push({ spanId: cur.s, start: cur.st, end });
      if (!cur.p) break;
      ret = cur.st;
      cur = boxes.get(cur.p);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function rollups(roots, kids) {
  const out = {};
  const visit = (sp) => {
    const a = sp.a || {};
    const chat = a['gen_ai.operation.name'] === 'chat';
    const r = {
      tokensIn: chat ? Number(a['gen_ai.usage.input_tokens']) || 0 : 0,
      tokensOut: chat ? Number(a['gen_ai.usage.output_tokens']) || 0 : 0,
      costUSD: chat ? Number(a['zp.cost_usd']) || 0 : 0,
      spans: 1,
      errors: sp.ok ? 0 : 1,
    };
    for (const c of kids.get(sp.s) || []) {
      const x = visit(c);
      r.tokensIn += x.tokensIn;
      r.tokensOut += x.tokensOut;
      r.costUSD += x.costUSD;
      r.spans += x.spans;
      r.errors += x.errors;
    }
    out[sp.s] = r;
    return r;
  };
  roots.forEach(visit);
  return out;
}

// Time a span spent itself: its duration minus the union of its children's time inside it.
function selfTimes(spans, kids) {
  const out = {};
  for (const sp of spans) {
    const end = sp.st + sp.d;
    const iv = (kids.get(sp.s) || [])
      .map((c) => [Math.max(c.st, sp.st), Math.min(c.st + c.d, end)])
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
    out[sp.s] = Math.max(0, sp.d - covered);
  }
  return out;
}

// The deepest failed span on the critical path; without one, the earliest failed span.
function rootCause(spans, byId, onPath) {
  const failed = spans.filter((s) => !s.ok);
  if (!failed.length) return null;
  const depth = (s) => {
    let d = 0;
    for (let p = s.p; p && byId.has(p) && d < 1000; p = byId.get(p).p) d++;
    return d;
  };
  const candidates = failed.filter((s) => onPath.has(s.s));
  const pick = candidates.length
    ? candidates.sort((a, b) => depth(b) - depth(a) || a.st - b.st)[0]
    : failed.sort((a, b) => a.st - b.st)[0];
  return { spanId: pick.s, name: pick.n, error: pick.err || '', onCriticalPath: onPath.has(pick.s) };
}

function analyze(spans) {
  const { byId, kids, roots } = tree(spans);
  const cp = criticalPath(spans);
  return {
    rootSpanId: roots.length ? roots[0].s : null,
    criticalPath: cp,
    rollup: rollups(roots, kids),
    selfTime: selfTimes(spans, kids),
    rootCause: rootCause(spans, byId, new Set(cp.map((x) => x.spanId))),
  };
}

module.exports = { analyze, criticalPath };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-analyze.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trace/analyze.js test/trace-analyze.test.js
git commit -m "Add trace analysis: critical path, rollups, self time, root cause"
```

### Task 14: Analysis in the reader, dependency map

**Files:**
- Modify: `lib/trace/reader.js`, `lib/trace/api.js`, `test/trace-reader.test.js`, `test/trace-api.test.js`

**Interfaces:**
- Consumes: `adjust` (Task 12), `analyze` (Task 13).
- Produces: `getTrace(id) → { traceId, summary, spans (adjusted), analysis }`; `getDependencies(q) → { nodes: [{ id, kind, label, count }], edges: [{ from, to, count, errors, p95Ms }] }`; route `GET /api/traces/deps`.

- [ ] **Step 1: Add the failing tests**

Append to `test/trace-reader.test.js`:

```js
test('reader: an opened trace comes adjusted and analysed', () => {
  const { reader } = setup();
  const t = reader.getTrace(T1);
  assert.equal(t.analysis.rootSpanId, 'a'.repeat(16));
  assert.equal(t.analysis.rootCause.name, 'execute_tool web');
  assert.ok(t.analysis.criticalPath.length > 0);
});

test('reader: dependencies between agents, models and tools', () => {
  const { reader } = setup();
  const d = reader.getDependencies({});
  const edge = (from, to) => d.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(edge('agent:sales', 'tool:web'), {
    from: 'agent:sales',
    to: 'tool:web',
    count: 1,
    errors: 1,
    p95Ms: 5,
  });
  assert.equal(edge('agent:finance', 'model:m').count, 1);
  assert.ok(d.nodes.some((n) => n.id === 'tool:web' && n.kind === 'tool' && n.label === 'web'));
});
```

In `test/trace-api.test.js`, add `getDependencies: () => ({ nodes: [], edges: [{ from: 'agent:a', to: 'tool:t' }] }),` to the `reader` stub object, and append:

```js
test('api: dependency route', () => {
  assert.equal(get('/api/traces/deps').body.edges[0].to, 'tool:t');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/trace-reader.test.js test/trace-api.test.js`
Expected: FAIL: `t.analysis` is undefined, `reader.getDependencies is not a function`, and the deps route answers 404 instead of 200 with edges.

- [ ] **Step 3: Implement in the reader** (`lib/trace/reader.js`)

Add after `const { summarize } = require('./summary');`:

```js
const { adjust } = require('./adjust');
const { analyze } = require('./analyze');
```

Replace the whole `getTrace` function with:

```js
  function getTrace(id) {
    const raw = spansOf(id);
    if (!raw || !raw.length) return null;
    const spans = adjust(raw);
    return { traceId: id, summary: publicSummary(summarize(id, spans)), spans, analysis: analyze(spans) };
  }

  // Which agents call which models, tools, agents and remote services, over the traces in range.
  function getDependencies(q = {}) {
    const nodeOf = (sp) => {
      const a = sp.a || {};
      const op = a['gen_ai.operation.name'];
      if (sp.k === 'client') return `remote:${a['server.address'] || sp.n}`;
      if (op === 'invoke_agent' || sp.n.startsWith('invoke_agent '))
        return `agent:${a['gen_ai.agent.id'] || sp.n.slice('invoke_agent '.length)}`;
      if (op === 'chat' || sp.n.startsWith('chat ')) return `model:${a['gen_ai.request.model'] || sp.n.slice(5)}`;
      if (op === 'execute_tool' || sp.n.startsWith('execute_tool '))
        return `tool:${a['gen_ai.tool.name'] || sp.n.slice('execute_tool '.length)}`;
      return null;
    };
    const pool = (q.src && q.src !== 'gateway' ? all() : store.summaries())
      .filter((s) => matches(s, { src: q.src, from: q.from, to: q.to }))
      .sort(newestFirst)
      .slice(0, clamp(q.limit, 500, 2000));
    const nodes = new Map();
    const edges = new Map();
    for (const s of pool) {
      const spans = spansOf(s.traceId) || [];
      const byId = new Map(spans.map((x) => [x.s, x]));
      for (const sp of spans) {
        const to = nodeOf(sp);
        if (!to) continue;
        const [kind, ...rest] = to.split(':');
        const node = nodes.get(to) || { id: to, kind, label: rest.join(':'), count: 0 };
        node.count++;
        nodes.set(to, node);
        let from = null;
        for (let p = byId.get(sp.p), i = 0; p && i < 100; p = byId.get(p.p), i++) {
          const n = nodeOf(p);
          if (n && n.startsWith('agent:')) {
            from = n;
            break;
          }
        }
        if (!from || from === to) continue;
        const k = `${from}\n${to}`;
        const e = edges.get(k) || { from, to, count: 0, errors: 0, ms: [] };
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
```

Change the returned object to:

```js
  return { findTraces, getTrace, findSpans, getDependencies, refresh: () => store.catchUp() };
```

- [ ] **Step 4: Add the route** (`lib/trace/api.js`)

Directly after the `/api/spans` line add:

```js
  if (p === '/api/traces/deps') return { status: 200, body: reader.getDependencies(queryOf(url.searchParams)) };
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/trace-reader.test.js test/trace-api.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/trace/reader.js lib/trace/api.js test/trace-reader.test.js test/trace-api.test.js
git commit -m "Analyse opened traces and map agent, model and tool dependencies"
```

### Task 15: MCP tools `acc_traces_search` and `acc_trace_get`

**Files:**
- Create: `lib/trace/views.js`, `test/trace-mcp.test.js`
- Modify: `lib/connectors/acc.js`, `mcp.js`, `server.js`

**Interfaces:**
- Consumes: a reader with `refresh`, `findTraces`, `getTrace` as `local.traces`.
- Produces: `traceView(trace, view = 'topology', spanId) → object`; acc tools `traces_search({ src, agent, tool, errors, minMs, hours = 24, limit = 20 })` and `trace_get({ traceId, view, spanId })`.

- [ ] **Step 1: Write the failing test** (`test/trace-mcp.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { traceView } = require('../lib/trace/views');
const { analyze } = require('../lib/trace/analyze');
const acc = require('../lib/connectors/acc');

const T = 'a'.repeat(32);
const id = (c) => c.repeat(16);
const spans = [
  { t: T, s: id('a'), p: null, n: 'invoke_agent sales', k: 'internal', st: 0, d: 100000, ok: true, src: 'gateway', svc: 'zaafpulse', a: { 'gen_ai.agent.id': 'sales' } },
  { t: T, s: id('b'), p: id('a'), n: 'execute_tool web', k: 'internal', st: 10000, d: 50000, ok: false, err: 'timeout', src: 'gateway', svc: 'zaafpulse', a: {} },
];
const trace = { traceId: T, summary: { root: 'invoke_agent sales' }, spans, analysis: analyze(spans) };

test('views: small answers shaped for an agent', () => {
  const topo = traceView(trace);
  assert.deepEqual(topo.spans[1], { id: id('b'), parent: id('a'), name: 'execute_tool web', ms: 50, ok: false });
  assert.equal(topo.spans[0].a, undefined, 'topology has no attributes');
  assert.deepEqual(
    traceView(trace, 'critical_path').criticalPath.map((c) => c.name),
    ['invoke_agent sales', 'execute_tool web', 'invoke_agent sales'],
  );
  const errs = traceView(trace, 'errors');
  assert.equal(errs.rootCause.name, 'execute_tool web');
  assert.deepEqual(errs.failed, [{ id: id('b'), parent: id('a'), name: 'execute_tool web', error: 'timeout' }]);
  const one = traceView(trace, 'span', id('a'));
  assert.equal(one.span.a['gen_ai.agent.id'], 'sales');
  assert.equal(one.span.rollup.errors, 1);
  assert.equal(one.span.selfMs, 50);
  assert.match(traceView(trace, 'span', id('z')).error, /no span/);
  assert.match(traceView(trace, 'other').error, /unknown view/);
});

test('acc tools: traces_search and trace_get over local.traces', async () => {
  const calls = [];
  const traces = {
    refresh: () => calls.push('refresh'),
    findTraces: (q) => (calls.push(q), [{ traceId: T }]),
    getTrace: (x) => (x === T ? trace : null),
  };
  const c = acc.create('acc', {}, { local: { traces } });
  const search = c.tools.find((t) => t.name === 'traces_search');
  const get = c.tools.find((t) => t.name === 'trace_get');
  const before = Date.now();
  assert.deepEqual(await search.run({ errors: true, limit: 500 }), { traces: [{ traceId: T }] });
  assert.equal(calls[0], 'refresh');
  assert.equal(calls[1].limit, 100);
  assert.ok(calls[1].from >= before - 24 * 3600 * 1000 - 5);
  assert.equal((await get.run({ traceId: T, view: 'errors' })).rootCause.name, 'execute_tool web');
  assert.match((await get.run({ traceId: 'b'.repeat(32) })).error, /no trace/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-mcp.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/views'`.

- [ ] **Step 3: Implement the views** (`lib/trace/views.js`)

```js
// Small views of one trace for an agent's context window, like Jaeger's MCP tools: the shape first
// (no attributes), then the critical path or the failures, then one span in full.
const MAX_TOPOLOGY = 400;
const ms = (us) => Math.round(us / 100) / 10;

function traceView(t, view = 'topology', spanId) {
  const base = { traceId: t.traceId, summary: t.summary };
  const byId = new Map(t.spans.map((s) => [s.s, s]));
  if (view === 'topology')
    return {
      ...base,
      spans: t.spans.slice(0, MAX_TOPOLOGY).map((s) => ({ id: s.s, parent: s.p, name: s.n, ms: ms(s.d), ok: s.ok })),
      truncated: t.spans.length > MAX_TOPOLOGY,
    };
  if (view === 'critical_path')
    return {
      ...base,
      criticalPath: t.analysis.criticalPath.map((c) => ({
        id: c.spanId,
        name: (byId.get(c.spanId) || {}).n,
        ms: ms(c.end - c.start),
      })),
    };
  if (view === 'errors')
    return {
      ...base,
      rootCause: t.analysis.rootCause,
      failed: t.spans
        .filter((s) => !s.ok)
        .slice(0, 50)
        .map((s) => ({ id: s.s, parent: s.p, name: s.n, error: s.err || '' })),
    };
  if (view === 'span') {
    const s = byId.get(spanId);
    if (!s) return { error: `no span ${spanId} in this trace` };
    return {
      ...base,
      span: { ...s, ms: ms(s.d), rollup: t.analysis.rollup[s.s], selfMs: ms(t.analysis.selfTime[s.s] || 0) },
    };
  }
  return { error: `unknown view ${view}; use topology, critical_path, errors or span` };
}

module.exports = { traceView };
```

- [ ] **Step 4: Add the tools** (`lib/connectors/acc.js`)

Add after `const { tool } = require('./base');`:

```js
const { traceView } = require('../trace/views');
```

Insert after the `integrations_status` tool (before the closing `],` of `tools`):

```js
        tool(
          'traces_search',
          'Agent run traces on this machine (ZAAFPulse gateway runs, Claude Code and Codex sessions): one summary per trace with root, source, duration, span and error counts, tokens, cost, agents, models and tools, newest first. Open one with trace_get.',
          {
            src: { type: 'string', enum: ['gateway', 'claude', 'codex'], description: 'Only this source' },
            agent: { type: 'string', description: 'Only traces in which this agent ran' },
            tool: { type: 'string', description: 'Only traces that called this tool' },
            errors: { type: 'boolean', description: 'Only traces with a failed span' },
            minMs: { type: 'number', description: 'Minimum duration in milliseconds' },
            hours: { type: 'number', description: 'How far back to look, in hours (default 24)' },
            limit: { type: 'number', description: 'Most traces to return (default 20, at most 100)' },
          },
          async (q) => {
            if (!local.traces) return { error: 'traces are not available in this process' };
            local.traces.refresh();
            const { hours, limit, ...rest } = q;
            return {
              traces: local.traces.findTraces({
                ...rest,
                from: Date.now() - (Number(hours) || 24) * 3600 * 1000,
                limit: Math.min(Number(limit) || 20, 100),
              }),
            };
          },
        ),
        tool(
          'trace_get',
          'One trace in the view you ask for, to keep the answer small: topology (span names, parents and durations, no attributes), critical_path (the sections that decided the duration), errors (failed spans and the likely root cause), or span (one span with its attributes, rollup and self time).',
          {
            traceId: { type: 'string', description: '32 hex characters, from traces_search' },
            view: {
              type: 'string',
              enum: ['topology', 'critical_path', 'errors', 'span'],
              description: 'Default topology',
            },
            spanId: { type: 'string', description: 'For view span: 16 hex characters' },
          },
          async ({ traceId, view, spanId }) => {
            if (!local.traces) return { error: 'traces are not available in this process' };
            local.traces.refresh();
            const t = local.traces.getTrace(String(traceId));
            return t ? traceView(t, view || 'topology', spanId) : { error: `no trace ${traceId}` };
          },
          { required: ['traceId'] },
        ),
```

- [ ] **Step 5: Give `mcp.js` and the server's registry a reader**

`mcp.js`, add after the existing requires:

```js
const { createTraceStore } = require('./lib/trace/store');
const { createTraceReader } = require('./lib/trace/reader');
const { builders: traceBuilders, sessionsFrom, cachedResults } = require('./lib/trace/sources');
```

After `const local = createLocal({ cacheDir: CACHE_DIR, config });` add:

```js
// Traces are written by the server; this process reads the same files and catches up before each call.
local.traces = createTraceReader({
  store: createTraceStore({ dir: path.join(DIR, '.data', 'traces'), readOnly: true }),
  sessions: sessionsFrom(cachedResults(path.join(CACHE_DIR, 'trace-sessions.json'))),
  builders: traceBuilders({ getPricing: () => config.pricing }),
});
```

In the instructions string of `mcp.js`, replace `acc_* reads local AI usage, cost, quality and running apps;` with `acc_* reads local AI usage, cost, quality, running apps and agent run traces;`.

`server.js`, after `    local.integrationsStatus = () => registry.status();` add (the reader is created further down the file, so it is looked up at call time):

```js
    local.traces = {
      refresh: () => traceReader.refresh(),
      findTraces: (q) => traceReader.findTraces(q),
      getTrace: (x) => traceReader.getTrace(x),
    };
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/trace-mcp.test.js`
Expected: PASS, 2 tests.

Run: `npm test`
Expected: PASS (the existing acc and MCP tests still list their tools).

- [ ] **Step 7: Try it from an MCP client**

Run: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"acc_traces_search","arguments":{"hours":168,"limit":3}}}' | node mcp.js`
Expected: the third reply's text holds up to 3 trace summaries (or an empty list on a machine with no runs yet), with no `ref` field.

- [ ] **Step 8: Commit**

```bash
git add lib/trace/views.js lib/connectors/acc.js mcp.js server.js test/trace-mcp.test.js
git commit -m "Expose agent run traces to AI clients as acc_traces_search and acc_trace_get"
```

### Task 16: Traces page shows the analysis and the dependencies

**Files:**
- Modify: `public/traces.js`, `public/styles.css`

**Interfaces:**
- Consumes: `analysis` in `GET /api/traces/<id>` (Task 14), `GET /api/traces/deps`.

- [ ] **Step 1: Show the root cause and per-branch cost** (`public/traces.js`)

Replace the whole `traceDetail` function with:

```js
function traceDetail() {
  const t = trc.open;
  if (!t) return '<section class="holo panel"><div class="skeleton" style="height:220px"></div></section>';
  if (t.error) return `<section class="holo panel"><p class="muted">${esc(t.error)}</p></section>`;
  const min = Math.min(...t.spans.map((s) => s.st));
  const max = Math.max(...t.spans.map((s) => s.st + s.d));
  const total = Math.max(1, max - min);
  const an = t.analysis || { criticalPath: [], rollup: {}, selfTime: {}, rootCause: null };
  const crit = new Set(an.criticalPath.map((c) => c.spanId));
  const cause = an.rootCause;
  const rows = traceRows(t.spans)
    .map(({ s, depth }) => {
      const r = an.rollup[s.s] || { tokensIn: 0, tokensOut: 0, costUSD: 0 };
      const tip = `${s.n}${s.err ? ` · ${s.err}` : ''} · branch ${fmtUSD(r.costUSD)} · ${(r.tokensIn + r.tokensOut).toLocaleString('en')} tokens · self ${fmtDurUs(an.selfTime[s.s] || 0)}`;
      return `<div class="trc-row${s.ok ? '' : ' err'}${crit.has(s.s) ? ' crit' : ''}${cause && cause.spanId === s.s ? ' cause' : ''}" title="${esc(tip)}">
        <span class="trc-name" style="padding-left:${depth * 14}px">${esc(s.n)}</span>
        <span class="trc-track"><i style="left:${(((s.st - min) / total) * 100).toFixed(3)}%;width:${Math.max(0.3, (s.d / total) * 100).toFixed(3)}%"></i></span>
        <span class="trc-dur num">${fmtDurUs(s.d)}${s.a && s.a['zp.timing'] === 'estimated' ? ' <small class="muted">est.</small>' : ''}</span></div>`;
    })
    .join('');
  return `<section class="holo panel"><div class="panel-head"><h3>${esc(t.summary.root || 'Trace')}</h3><span class="meta mono">${t.traceId} · ${t.spans.length} spans · ${fmtDurUs(total)} · ${fmtUSD(t.summary.costUSD || 0)}</span></div>
    ${cause ? `<p class="trc-cause">Likely cause: <b>${esc(cause.name)}</b>${cause.error ? ` · ${esc(cause.error)}` : ''}${cause.onCriticalPath ? '' : ' <small class="muted">(not on the critical path)</small>'}</p>` : ''}
    <p class="trc-legend"><span><i class="crit"></i>critical path</span><span><i class="err"></i>failed</span><span><i></i>other</span></p>
    <div class="trc-wf">${rows}</div></section>`;
}
```

- [ ] **Step 2: Add the dependency panel** (`public/traces.js`)

Change the state line to:

```js
const trc = { list: null, open: null, openId: null, loading: false, deps: null, filter: { src: '', q: '', errors: false } };
```

Add after `openTrace`:

```js
async function loadDeps() {
  trc.deps = { loading: true };
  try {
    trc.deps = await api(`/api/traces/deps?from=${Date.now() - 7 * 86400 * 1000}`);
  } catch (err) {
    trc.deps = { error: err.message };
  }
  if (state.route === 'traces') render(false);
}

function depsPanel() {
  const d = trc.deps;
  const body = !d || d.loading
    ? '<div class="skeleton" style="height:120px"></div>'
    : d.error
      ? `<p class="muted">${esc(d.error)}</p>`
      : !d.edges.length
        ? '<p class="muted">No calls between agents, models and tools in the last 7 days.</p>'
        : `<table class="tbl"><thead><tr><th>From</th><th>To</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">p95</th></tr></thead><tbody>${d.edges
            .slice(0, 60)
            .map(
              (e) => `<tr><td><span class="tag">${esc(e.from.split(':')[0])}</span> ${esc(e.from.split(':').slice(1).join(':'))}</td>
              <td><span class="tag">${esc(e.to.split(':')[0])}</span> ${esc(e.to.split(':').slice(1).join(':'))}</td>
              <td class="num">${e.count}</td><td class="num${e.errors ? ' bad-text' : ''}">${e.errors}</td><td class="num">${e.p95Ms.toFixed(1)} ms</td></tr>`,
            )
            .join('')}</tbody></table>`;
  return `<section class="holo panel"><div class="panel-head"><h3>Dependencies</h3><span class="meta">who calls what · gateway runs · last 7 days</span></div>${body}</section>`;
}
```

In `viewTracesPage`, change the first line to

```js
  if (!trc.list && !trc.loading) setTimeout(loadTraces);
  if (!trc.deps) setTimeout(loadDeps);
```

and replace `    ${trc.openId ? traceDetail() : ''}` with

```js
    ${trc.openId ? traceDetail() : ''}
    ${depsPanel()}
```

- [ ] **Step 3: Styles** (append to `public/styles.css`)

```css
.trc-row.cause .trc-name { font-weight: 700; }
.trc-cause { margin: 0 0 10px; padding: 8px 10px; border-left: 3px solid #ff4f6d; background: rgba(255, 79, 109, 0.08); }
.trc-legend { display: flex; gap: 14px; margin: 0 0 8px; font-size: 11px; color: var(--muted, #8f98cc); }
.trc-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border-radius: 2px; background: #2a78d6; vertical-align: -1px; }
.trc-legend i.crit { background: #ffb547; }
.trc-legend i.err { background: #ff4f6d; }
```

- [ ] **Step 4: Check it in the browser**

Restart the dashboard, open `#traces`, open a collaboration run and a run with a failed tool call.
Expected: orange bars mark the critical path; the failed run shows "Likely cause" naming the failed span; hovering a row shows the branch cost, tokens and self time; the Dependencies panel lists agent → model and agent → tool edges with counts and p95. No console errors.

- [ ] **Step 5: Commit**

```bash
git add public/traces.js public/styles.css
git commit -m "Show critical path, root cause, branch cost and dependencies on the Traces page"
```

**Phase 3 done when:** `npm test` passes and `acc_traces_search` / `acc_trace_get` answer from an MCP client with the same traces the page shows.

---

# Phase 4: Propagation, return channel, excerpts

Result of the phase: calls to remote A2A agents and MCP servers carry W3C `traceparent` and appear as client spans; a remote side that exports OpenTelemetry can send its spans back into the same trace; excerpts of content can be switched on per source.

### Task 17: `traceparent` to remote agents and MCP servers

**Files:**
- Modify: `lib/gateway/orchestrator.js`, `lib/gateway/index.js`, `lib/integrations.js`, `lib/connectors/mcp-proxy.js`, `lib/mcp/client.js`
- Create: `test/trace-propagate.test.js`

**Interfaces:**
- Produces: a `client` span `a2a <agent id>` around every remote agent call, with attributes `rpc.system: "a2a"`, `server.address`, `gen_ai.agent.id`; header `traceparent` on the A2A request; `integrations.callTool(name, args, meta = {})`; connector tool `run(args, meta)`; MCP client `callTool(name, args, meta = {})` sending header `traceparent` and `params._meta.traceparent` when `meta.traceparent` is set.

- [ ] **Step 1: Write the failing test** (`test/trace-propagate.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createOrchestrator } = require('../lib/gateway/orchestrator');
const { createTracer } = require('../lib/trace/tracer');
const { parseTraceparent } = require('../lib/trace/ids');
const { createClient } = require('../lib/mcp/client');
const { createIntegrations } = require('../lib/integrations');
const { tool } = require('../lib/connectors/base');
const { secretsFor } = require('./helpers');

const memStore = () => {
  const spans = [];
  return { spans, writeSpans: (l) => (spans.push(...l), l.length) };
};
const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

test('propagation: a remote A2A agent gets the traceparent of a client span under the agent span', async () => {
  const store = memStore();
  const tracer = createTracer({ store, flushMs: 0 });
  let headers = null;
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
    tracer,
  });
  const r = await orch.runAgent({ id: 'far', name: 'Far', remoteUrl: 'http://127.0.0.1:9/a2a', tools: [] }, 'ping', {});
  assert.equal(r.text, 'pong');
  tracer.flush();
  const client = store.spans.find((s) => s.k === 'client');
  const agent = store.spans.find((s) => s.n === 'invoke_agent far');
  assert.equal(client.n, 'a2a far');
  assert.equal(client.p, agent.s);
  assert.equal(client.a['server.address'], '127.0.0.1:9');
  assert.deepEqual(parseTraceparent(headers.traceparent), { traceId: client.t, spanId: client.s, sampled: true });
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
        return res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'up', version: '1' } },
          }),
        );
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

test('propagation: the integration registry hands the call context to the tool', async () => {
  let got = null;
  const connectors = {
    fake: {
      type: 'fake',
      create: () => ({
        health: async () => ({ ok: true }),
        tools: [
          tool('echo', 'Echo', {}, async (args, meta) => {
            got = meta;
            return { ok: true };
          }),
        ],
      }),
    },
  };
  const reg = createIntegrations({ config: { integrations: { f: { type: 'fake' } } }, secrets: secretsFor(), connectors });
  await reg.callTool('f_echo', {}, { traceparent: TP });
  assert.deepEqual(got, { traceparent: TP });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-propagate.test.js`
Expected: FAIL: no `client` span, no `traceparent` header, `meta` undefined.

- [ ] **Step 3: Client span and header for remote agents** (`lib/gateway/orchestrator.js`)

Replace the line `  async function runRemote(agent, input, ctx) {` with:

```js
  async function runRemote(agent, input, ctx) {
    // The call is a client span; its traceparent goes with the request.
    const tracing = ctx.run || ctx.tracing;
    const cs = tracing
      ? tracing.span(
          `a2a ${agent.id}`,
          { 'rpc.system': 'a2a', 'server.address': new URL(agent.remoteUrl).host, 'gen_ai.agent.id': agent.id },
          ctx.span,
          { kind: 'client' },
        )
      : null;
    try {
      const r = await callRemote(agent, input, ctx, cs ? cs.traceparent() : null);
      if (cs) cs.end(r.remoteState ? { 'zp.remote_state': r.remoteState } : {});
      return r;
    } catch (err) {
      if (cs) cs.end({}, err);
      throw err;
    }
  }

  async function callRemote(agent, input, ctx, traceparent) {
```

In the A2A request headers, after the line ``...(token ? { authorization: `Bearer ${token}` } : {}),`` add:

```js
            ...(traceparent ? { traceparent } : {}),
```

Pass the tool span to integration tools. Replace `            out = await runTool(tc.function.name, args, { ...ctx, agent, box });` with `            out = await runTool(tc.function.name, args, { ...ctx, agent, box, toolSpan: tspan });`, and replace `    const r = await integrations.callTool(name, args || {});` with:

```js
    const r = await integrations.callTool(
      name,
      args || {},
      ctx.toolSpan ? { traceparent: ctx.toolSpan.traceparent() } : {},
    );
```

- [ ] **Step 4: Carry the context through the registry and the MCP client**

`lib/gateway/index.js`: replace `      callTool: (n, a) => getIntegrations().callTool(n, a),` with `      callTool: (n, a, meta) => getIntegrations().callTool(n, a, meta),`.

`lib/integrations.js`: replace `  async function callTool(name, args = {}) {` with `  async function callTool(name, args = {}, meta = {}) {`, and `      result = okResult(await t.run(args));` with `      result = okResult(await t.run(args, meta));`.

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
- replace `  async function post(msg) {` with `  async function post(msg, extra = {}) {`
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
- replace `callTool: (name, args) => request('tools/call', { name, arguments: args || {} })` with
  ```js
  // meta.traceparent goes as a header and in _meta, so HTTP and MCP-aware servers can both continue the trace.
  callTool: (name, args, meta = {}) =>
    request(
      'tools/call',
      { name, arguments: args || {}, ...(meta.traceparent ? { _meta: { traceparent: meta.traceparent } } : {}) },
      meta.traceparent ? { traceparent: meta.traceparent } : {},
    ),
  ```

- [ ] **Step 5: Run the tests**

Run: `node --test test/trace-propagate.test.js`
Expected: PASS, 3 tests.

Run: `npm test`
Expected: PASS (MCP proxy, integrations and A2A tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add lib/gateway/orchestrator.js lib/gateway/index.js lib/integrations.js lib/connectors/mcp-proxy.js lib/mcp/client.js test/trace-propagate.test.js
git commit -m "Propagate traceparent to remote A2A agents and MCP servers"
```

### Task 18: OTLP return channel

**Files:**
- Create: `lib/trace/otlp.js`, `test/trace-otlp.test.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: `tracer.knows`, `tracer.ingest` (Task 4), `isTraceId`, `isSpanId` (Task 1).
- Produces: `createReceiver({ tracer, maxPerTrace = 2000 }) → { receive(body) → {} | { partialSuccess: { rejectedSpans, errorMessage } } }`; route `POST /v1/traces` (OTLP/HTTP JSON, from this machine only).

- [ ] **Step 1: Write the failing test** (`test/trace-otlp.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReceiver } = require('../lib/trace/otlp');
const { createTracer } = require('../lib/trace/tracer');

const memStore = () => {
  const spans = [];
  return { spans, writeSpans: (l) => (spans.push(...l), l.length) };
};

test('otlp: spans of a trace ZAAFPulse started are kept; unknown, malformed and excess spans are refused', () => {
  const store = memStore();
  const tracer = createTracer({ store, flushMs: 0 });
  const scope = tracer.scope();
  const client = scope.span('a2a far', {}, null, { kind: 'client' });
  const recv = createReceiver({ tracer, maxPerTrace: 2 });
  const span = (traceId, spanId, extra = {}) => ({
    traceId,
    spanId,
    parentSpanId: client.id,
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
  const out = recv.receive({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'far-agent' } }] },
        scopeSpans: [
          {
            spans: [
              span(scope.traceId, '1111111111111111', { status: { code: 2, message: 'boom' } }),
              span('f'.repeat(32), '2222222222222222'), // a trace ZAAFPulse did not start
              span(scope.traceId, 'zz'), // malformed span ID
              span(scope.traceId, '3333333333333333'),
              span(scope.traceId, '4444444444444444'), // over the per-trace limit
            ],
          },
        ],
      },
    ],
  });
  assert.equal(out.partialSuccess.rejectedSpans, 3);
  tracer.flush();
  const got = store.spans.filter((s) => s.src === 'remote');
  assert.equal(got.length, 2);
  const [a] = got;
  assert.deepEqual(
    { t: a.t, p: a.p, k: a.k, svc: a.svc, st: a.st, d: a.d, ok: a.ok, err: a.err },
    { t: scope.traceId, p: client.id, k: 'server', svc: 'far-agent', st: 1792642201123456, d: 100000, ok: false, err: 'boom' },
  );
  assert.deepEqual(a.a, { 'http.route': '/a2a', n: 3 });
  assert.deepEqual(recv.receive({ resourceSpans: [] }), {});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-otlp.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/otlp'`.

- [ ] **Step 3: Implement** (`lib/trace/otlp.js`)

```js
// The return channel: OTLP/HTTP JSON spans from a remote agent or MCP server, kept only for traces this
// ZAAFPulse started in the last 24 hours (the tracer knows them) and at most maxPerTrace per trace. It is
// not a general OTLP backend.
const { isTraceId, isSpanId } = require('./ids');

const KINDS = {
  1: 'internal',
  2: 'server',
  3: 'client',
  SPAN_KIND_INTERNAL: 'internal',
  SPAN_KIND_SERVER: 'server',
  SPAN_KIND_CLIENT: 'client',
};
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
  for (const kv of (Array.isArray(list) ? list : []).slice(0, MAX_ATTRS))
    if (kv && kv.key) out[String(kv.key).slice(0, 100)] = valueOf(kv.value || {});
  return out;
}
const usOf = (nano) => {
  try {
    return Number(BigInt(String(nano)) / 1000n);
  } catch {
    return 0;
  }
};

function createReceiver({ tracer, maxPerTrace = 2000 }) {
  const counts = new Map(); // traceId -> spans accepted from outside
  function receive(body) {
    let rejected = 0;
    const out = [];
    for (const rs of (body && body.resourceSpans) || []) {
      const svc = String(attrsOf(rs.resource && rs.resource.attributes)['service.name'] || 'remote').slice(0, 100);
      for (const ss of rs.scopeSpans || [])
        for (const s of ss.spans || []) {
          const t = String(s.traceId || '').toLowerCase();
          const id = String(s.spanId || '').toLowerCase();
          const p = s.parentSpanId ? String(s.parentSpanId).toLowerCase() : null;
          const n = counts.get(t) || 0;
          if (!isTraceId(t) || !isSpanId(id) || (p && !isSpanId(p)) || !tracer.knows(t) || n >= maxPerTrace) {
            rejected++;
            continue;
          }
          counts.set(t, n + 1);
          const st = usOf(s.startTimeUnixNano);
          const failed = !!s.status && (s.status.code === 2 || s.status.code === 'STATUS_CODE_ERROR');
          out.push({
            t,
            s: id,
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
    tracer.ingest(out);
    if (counts.size > 10000) counts.clear();
    return rejected
      ? {
          partialSuccess: {
            rejectedSpans: rejected,
            errorMessage: 'dropped spans of traces this ZAAFPulse did not start, with malformed IDs, or over the per-trace limit',
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
Expected: PASS.

- [ ] **Step 5: Serve it** (`server.js`)

Add after `const { traceApi } = require('./lib/trace/api');`:

```js
const { createReceiver } = require('./lib/trace/otlp');
```

After the `const traceReader = createTraceReader({ ... });` statement add:

```js
const traceReceiver = createReceiver({ tracer: gateway.traces.tracer });
```

Insert directly before the line `    // The gateway authenticates its own callers with ZAAFPulse API keys.`:

```js
    // OTLP/HTTP JSON return channel for traces this ZAAFPulse started (lib/trace/otlp.js); this machine only.
    if (url.pathname === '/v1/traces' && req.method === 'POST') {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
        return send(res, 403, { error: 'the trace return channel accepts calls from this machine only' });
      if (!/^application\/json/.test(req.headers['content-type'] || ''))
        return send(res, 415, { error: 'send OTLP as JSON (content-type: application/json)' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return err.message === 'too large'
          ? send(res, 413, { error: 'body over 1 MB' })
          : send(res, 400, { error: 'invalid JSON' });
      }
      return send(res, 200, traceReceiver.receive(body));
    }
```

- [ ] **Step 6: Check it against the running server**

With the dashboard running on port 4777: `curl -s -X POST http://127.0.0.1:4777/v1/traces -H 'content-type: application/json' -d '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"ffffffffffffffffffffffffffffffff","spanId":"1111111111111111","name":"x","startTimeUnixNano":"1","endTimeUnixNano":"2"}]}]}]}'`
Expected: `{"partialSuccess":{"rejectedSpans":1,...}}` (a trace this server did not start).
`curl -s -X POST http://127.0.0.1:4777/v1/traces -H 'content-type: application/x-protobuf' --data-binary 'x'`
Expected: HTTP 415 with the JSON hint.

- [ ] **Step 7: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add lib/trace/otlp.js test/trace-otlp.test.js server.js
git commit -m "Accept spans back from remote agents for traces ZAAFPulse started"
```

### Task 19: Opt-in excerpts

**Files:**
- Create: `lib/trace/capture.js`, `test/trace-capture.test.js`
- Modify: `lib/trace/tracer.js`, `lib/gateway/index.js`, `lib/gateway/orchestrator.js`, `lib/gateway/collab.js`, `server.js`, `mcp.js`

**Interfaces:**
- Produces: `createCapture({ getConfig, mask }) → { on(src) → boolean, excerpt(text) → string, pair(input, output) → { in, out }, lastUser(messages) → string }`; `tracedLlm(llm, scope, capture = null)`; `createOrchestrator({ ..., capture })`; `createCollab({ ..., capture })`; `gateway.traces.capture`.

- [ ] **Step 1: Write the failing test** (`test/trace-capture.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCapture } = require('../lib/trace/capture');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');

test('capture: off by default, per source when on, cut by bytes, masked', () => {
  let cfg = {};
  const c = createCapture({ getConfig: () => cfg, mask: (s) => s.replace('SECRET', '***') });
  assert.equal(c.on('gateway'), false);
  cfg = { tracing: { capture: { gateway: true }, maxExcerptBytes: 64 } };
  assert.equal(c.on('gateway'), true);
  assert.equal(c.on('claude'), false);
  assert.equal(c.excerpt('key SECRET here'), 'key *** here');
  const long = c.excerpt('é'.repeat(100));
  assert.ok(Buffer.byteLength(long) <= 64 + 3);
  assert.ok(!long.includes('�'));
  assert.ok(long.endsWith('…'));
  assert.equal(c.lastUser([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: [{ text: 'c' }] }]), 'c');
});

async function runOnce(tracing) {
  const upstream = await fakeServer({
    'POST /chat/completions': {
      body: { choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    },
  });
  const gateway = createGateway({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cap-')),
    getConfig: () => ({
      tracing,
      gateway: {
        providers: [{ id: 'fake', preset: 'custom', baseUrl: upstream.url, tier: 'private', approved: true }],
        defaults: { model: 'fake/m' },
      },
    }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({ result: { content: [] } }) }),
  });
  try {
    await gateway.orchestrator.runAgent(gateway.agents.get('security'), 'check the logs', {});
    gateway.traces.tracer.flush();
    const [s] = gateway.traces.store.summaries();
    return gateway.traces.store.getSpans(s.traceId);
  } finally {
    await upstream.close();
  }
}

test('capture: gateway spans keep excerpts only when switched on', async () => {
  const off = await runOnce(undefined);
  assert.ok(off.every((s) => !s.x));
  const on = await runOnce({ capture: { gateway: true } });
  const agent = on.find((s) => s.n === 'invoke_agent security');
  assert.deepEqual(agent.x, { in: 'check the logs', out: 'done' });
  const chat = on.find((s) => s.n === 'chat fake/m');
  assert.deepEqual(chat.x, { in: 'check the logs', out: 'done' });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/trace-capture.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/capture'`.

- [ ] **Step 3: Implement** (`lib/trace/capture.js`)

```js
// Opt-in excerpts of prompts, replies and tool input and output on spans. Off unless tracing.capture names
// the source; cut to maxExcerptBytes (64 to 16384, default 2048) on a character boundary; secrets masked.
function createCapture({ getConfig, mask = (s) => s }) {
  const cfg = () => (getConfig() || {}).tracing || {};
  const limit = () => Math.min(Math.max(Number(cfg().maxExcerptBytes) || 2048, 64), 16384);
  function excerpt(text) {
    const s = mask(String(text ?? ''));
    const max = limit();
    if (Buffer.byteLength(s) <= max) return s;
    return `${Buffer.from(s).subarray(0, max).toString('utf8').replace(/�+$/, '')}…`;
  }
  function lastUser(messages) {
    const m = [...(messages || [])].reverse().find((x) => x && x.role === 'user');
    if (!m) return '';
    return typeof m.content === 'string' ? m.content : (m.content || []).map((c) => (c && c.text) || '').join('\n');
  }
  return {
    on: (src) => !!(cfg().capture && cfg().capture[src]),
    excerpt,
    pair: (input, output) => ({ in: excerpt(input), out: excerpt(output) }),
    lastUser,
  };
}

module.exports = { createCapture };
```

- [ ] **Step 4: Record excerpts where spans end**

`lib/trace/tracer.js`: change `function tracedLlm(llm, scope) {` to `function tracedLlm(llm, scope, capture = null) {`, and directly after `      const r = await llm(args);` add:

```js
      if (capture && capture.on('gateway'))
        sp.capture(capture.pair(capture.lastUser(args.messages), r.message && r.message.content));
```

`lib/gateway/index.js`: add after `const { createTracer } = require('../trace/tracer');`:

```js
const { createCapture } = require('../trace/capture');
```

After `  const tracer = createTracer({ store: traceStore });` add:

```js
  const capture = createCapture({ getConfig, mask: (s) => secrets.mask(s) });
```

Add `capture,` after `tracer,` in both `createOrchestrator({ ... })` and `createCollab({ ... })`, and replace `    traces: { store: traceStore, tracer },` with `    traces: { store: traceStore, tracer, capture },`.

`lib/gateway/orchestrator.js`:
- in the parameters of `createOrchestrator({`, add `capture = null,` after `tracer = null,`
- replace `    const call = ctx.llm || (ctx.tracing ? tracedLlm(llm, ctx.tracing) : llm);` with `    const call = ctx.llm || (ctx.tracing ? tracedLlm(llm, ctx.tracing, capture) : llm);`
- in `runAgent`, directly after `      const r = agent.remoteUrl ? await runRemote(agent, input, inner) : await runLocal(agent, input, inner);` add
  ```js
      if (span && capture && capture.on('gateway')) span.capture(capture.pair(input, r.text));
  ```
- directly after `        const ok = !String(out).startsWith('error:');` add
  ```js
        if (tspan && capture && capture.on('gateway')) tspan.capture(capture.pair(JSON.stringify(args), out));
  ```

`lib/gateway/collab.js`:
- in the `createCollab({` parameters, add `capture = null,` after the `tracer = ...` line
- in `rt.llm`, replace
  ```js
        s.requests++;
        sp.end({
  ```
  with
  ```js
        s.requests++;
        if (capture && capture.on('gateway'))
          sp.capture(capture.pair(capture.lastUser(args.messages), r.message && r.message.content));
        sp.end({
  ```

- [ ] **Step 5: Excerpts for session traces at open time**

`server.js`: in the `createTraceReader({ ... })` call, replace the line `  builders: traceBuilders({ getPricing: () => config.pricing }),` with

```js
  builders: traceBuilders({
    getPricing: () => config.pricing,
    getCapture: (src) => (gateway.traces.capture.on(src) ? gateway.traces.capture : null),
  }),
```

`mcp.js`: add `const { createCapture } = require('./lib/trace/capture');` with the other trace requires, and replace `  builders: traceBuilders({ getPricing: () => config.pricing }),` with

```js
  builders: traceBuilders({
    getPricing: () => config.pricing,
    getCapture: (src) => {
      const c = createCapture({ getConfig: () => config, mask: (s) => secrets.mask(s) });
      return c.on(src) ? c : null;
    },
  }),
```

(`secrets` is created above `local` in `mcp.js`.) Session excerpts are built from the original file each time a trace is opened and are never written by ZAAFPulse.

- [ ] **Step 6: Run the tests**

Run: `node --test test/trace-capture.test.js`
Expected: PASS, 2 tests.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/trace/capture.js lib/trace/tracer.js lib/gateway/index.js lib/gateway/orchestrator.js lib/gateway/collab.js server.js mcp.js test/trace-capture.test.js
git commit -m "Add opt-in, masked excerpts to trace spans"
```

### Task 20: Documentation

**Files:**
- Create: `docs/tracing.md`

`README.md` has uncommitted changes of the owner's in this working tree, so this plan does not edit it. After this task, add one line under the README's feature list pointing at `docs/tracing.md`, in the owner's own commit.

- [ ] **Step 1: Write the page** (`docs/tracing.md`)

````markdown
# Agent run tracing

ZAAFPulse records every AI agent run on this machine as a trace: a tree of spans with OpenTelemetry GenAI
names (`invoke_workflow`, `plan`, `invoke_agent`, `chat <model>`, `execute_tool <name>`, `judge`). Open
**Traces** in the dashboard to search them, see one as a waterfall with its critical path, cost per branch
and likely root cause, and see which agents call which models and tools.

## What is traced

| Source | How |
|---|---|
| ZAAFPulse gateway | Every run: chat with `agent/<id>`, `/v1/agents/<id>/run`, workflows, collaboration runs |
| Claude Code | Each session in `~/.claude/projects`, subagents nested under the tool call that started them |
| Codex | Each session in `~/.codex/sessions` |
| Remote A2A agents, MCP servers | A client span per call, with W3C `traceparent` sent along |

Session traces are not copied: ZAAFPulse keeps a summary and rebuilds the spans from the session file when
you open one. Log lines carry the time they were written, so model-call spans in sessions are marked
**est.** (estimated); Codex turns are timed by Codex itself.

## Where it is stored

Gateway traces: `<data folder>/.data/traces/YYYY-MM-DD.ndjson` (one file per UTC day, append-only) and
`index.json`. Session summaries: `<data folder>/.cache/trace-sessions.json`. Files are private to your OS
account.

## Settings (`config.json`)

```json
"tracing": {
  "retentionDays": 14,
  "maxBytes": 524288000,
  "capture": { "gateway": false, "claude": false, "codex": false },
  "maxExcerptBytes": 2048
}
```

- Retention deletes whole days, oldest first, past `retentionDays` or once the folder passes `maxBytes`.
- `capture` keeps excerpts of prompts, replies and tool input and output on spans, per source, cut to
  `maxExcerptBytes` and with secrets masked. Off by default: spans hold names, times, tokens, cost, status.

## For AI clients (MCP)

- `acc_traces_search`: trace summaries, filtered by source, agent, tool, failures, duration and time.
- `acc_trace_get`: one trace as `topology`, `critical_path`, `errors` or one `span`.

## Spans back from remote agents

A remote agent or MCP server that exports OpenTelemetry can send its spans to
`http://127.0.0.1:4777/v1/traces` (OTLP/HTTP, JSON). Only spans of traces this ZAAFPulse started in the
last 24 hours are kept, at most 2,000 per trace, from this machine only.
````

- [ ] **Step 2: Commit**

```bash
git add docs/tracing.md
git commit -m "Document agent run tracing"
```

**Phase 4 done when:** `npm test` passes; a run that calls a remote agent shows its `a2a <agent>` client span; switching `tracing.capture.gateway` on shows excerpts on the next run and not on earlier ones.

---

## Spec coverage

| Spec section | Tasks |
|---|---|
| Data model: span record, trace summary | 1, 2 |
| Store: segments, index, snapshot, rebuild after a cut line, retention | 3 |
| Tracer, buffer limit, drops counted, a failure never fails a run | 4 |
| Reader: `getTrace`, `findTraces`, `findSpans`, `getDependencies` | 5, 14 |
| Coverage of every gateway run; collaboration adapter; old runs read as before | 6 |
| HTTP API (`/api/traces`, `/api/traces/<id>`, `/api/traces/deps`, `/api/spans`, stats) | 7, 14 |
| Session sources, path guard, estimated timing, no copy | 9, 10, 11 |
| Adjusters, critical path, rollups, self time, root cause | 12, 13 |
| MCP tools with progressive disclosure | 15 |
| UI: list, waterfall, critical path, cost per branch, root cause, dependency map | 8, 16 |
| Propagation to A2A and MCP; client spans | 17 |
| Return channel with its three guards | 18 |
| Content capture | 19 |
| Testing per module | every task |

Two deliberate differences from the spec, recorded there: the collaboration run keeps its live `run.trace` array (capped at 800) next to `traceId`, because the existing run view reads it; and the dependency map is a table of edges (from, to, calls, failures, p95) in this first version.

## Execution

Phases ship one at a time and each leaves the dashboard working. Within a phase, tasks run in order (each builds on the one before). Phase 2 can run in parallel with Phase 3's Tasks 12 and 13, which touch only new files.
