# Trace & Session Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A split-screen page (`#trace`) that opens any agent session on this machine. The left half shows a trace tree with on-demand, masked text; the right half shows an animated session map. The data covers Claude Code, Codex, Agent Gateway, Kiro, Antigravity and Gemini CLI.

**Architecture:**
- The indexer records per-session turn byte offsets and the Claude subagent links (no text).
- One adapter per source builds a uniform span skeleton on demand, using ranged reads of the original log.
- A content reader returns one span's text, masked, capped at 64 KB per page.
- A registry adds an LRU skeleton cache, worker offload for big files, a read limit and per-source isolation.
- `server.js` exposes `/api/trace/*` behind the dashboard sign-in.
- `public/traceview.js` renders the approved mockup.

**Tech stack:** Node ≥18 standard library only (`node:sqlite` only for Antigravity, Node 22.5+ and feature-detected), `node:test`, plain browser JS/CSS/SVG.

**Spec:** `docs/superpowers/specs/2026-10-20-trace-session-explorer-design.md`
**Shared requirements:** `docs/superpowers/specs/2026-10-20-ai-observability-overview.md`, S1–S11 and P1–P10.
**Approved mockup:** `docs/superpowers/specs/mockups/split-view-v4.html`

## Global Constraints

- Zero runtime dependencies; no new entries in `dependencies`.
- Never copy transcript text into the index or cache. The index holds counts, ids, byte offsets and times only (overview, "Content").
- Content is rendered as text only (`textContent` / `esc()`); there is no markdown-to-HTML and no `innerHTML` with content (S1).
- Secrets are masked by default with `lib/signals.js` `scanSecrets`. "Show" is per item and never cached (S2).
- APIs take opaque ids only. Files are `realpath`-checked inside known roots, and offsets are checked against the file size (S3).
- `ZAAFPULSE_CONTENT=off` disables content. Content is off by default in server mode (S10).
- Antigravity SQLite is opened `readOnly: true` (S9).
- Never read a whole log file to show a session (P1). Use the LRU cache: 20 skeletons, about 200 MB (P2). Offload files over 50 MB to a worker (P2). Isolate each adapter (P10).
- Demo mode serves synthetic sessions and reads no real files.
- Style: `.prettierrc.json`, with short "why" comments. Commits carry no AI attribution. CI runs on Ubuntu, macOS and Windows.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/trace/lines.js` | create | byte-accurate JSONL line reader over a byte range |
| `lib/claude.js`, `lib/codex.js` | modify | record turn offsets (+ Claude subagent links) in session results |
| `lib/indexer.js` | modify | `entries()`; `CACHE_VERSION` 9 → 10 |
| `lib/trace/model.js` | create | span ids, span constructor, tree validation, totals |
| `lib/trace/claude.js` | create | Claude Code adapter (sessions, skeleton, content refs, subagents) |
| `lib/trace/codex.js` | create | Codex adapter |
| `lib/trace/gateway.js` | create | gateway requests (metadata) and collaboration runs |
| `lib/trace/kiro.js`, `lib/trace/gemini.js`, `lib/trace/antigravity.js` | create | the lighter sources |
| `lib/trace/content.js` | create | ranged content read, field extraction, masking, reveal, path safety |
| `lib/trace/index.js` | create | registry: routing, LRU, worker offload, read limit, isolation, demo |
| `lib/trace/worker.js` | create | worker entry that builds a skeleton for a large file |
| `lib/gateway/index.js` | modify | expose `trace` accessors (runs, run, recent requests) |
| `lib/demo.js` | modify | `traceDemo()` synthetic sessions with content |
| `server.js` | modify | `/api/trace/*` routes |
| `public/traceview.js`, `public/styles.css`, `public/index.html`, `public/app.js`, `public/workviews.js` | create/modify | page, nav, route, links |
| `test/fixtures/trace/**`, `test/trace-*.test.js` | create | fixtures and tests |
| `README.md`, `docs/explorer.md` | modify/create | docs |

---

### Task 1: Byte-accurate line reader

**Files:**
- Create: `lib/trace/lines.js`
- Test: `test/trace-lines.test.js`

**Interfaces:**
- Produces: `readLines(file, { start = 0, end = Infinity, highWaterMark = 1 << 20 } = {})`, an async generator yielding `{ text, start, end }`.
  - `start` and `end` are byte offsets of the line within the file, `end` exclusive and including the newline.
  - `text` excludes the `\n` and a trailing `\r`.
  - The last line is yielded even without a trailing newline.
  - Reading stops at the first line that starts at or after `end`.
- Produces: `readRange(file, start, end)`, returning `Promise<Buffer>` for exactly those bytes.

- [ ] **Step 1: Write the failing test**

```js
// test/trace-lines.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLines, readRange } = require('../lib/trace/lines');

const tmp = (content) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-lines-')), 'x.jsonl');
  fs.writeFileSync(f, content);
  return f;
};
const all = async (gen) => {
  const out = [];
  for await (const l of gen) out.push(l);
  return out;
};

test('lines carry exact byte offsets, including multi-byte text and CRLF', async () => {
  const f = tmp('{"a":"é"}\n{"b":2}\r\n{"c":3}');
  const lines = await all(readLines(f));
  assert.deepEqual(
    lines.map((l) => l.text),
    ['{"a":"é"}', '{"b":2}', '{"c":3}'],
  );
  assert.deepEqual(
    lines.map((l) => [l.start, l.end]),
    [
      [0, 11],
      [11, 20],
      [20, 27],
    ],
  );
  for (const l of lines) assert.equal((await readRange(f, l.start, l.end)).toString().trimEnd(), l.text);
});

test('a range starts at a line start and stops before the end offset', async () => {
  const f = tmp('a\nbb\nccc\ndddd\n');
  const lines = await all(readLines(f, { start: 2, end: 9 }));
  assert.deepEqual(
    lines.map((l) => l.text),
    ['bb', 'ccc'],
  );
});

test('lines longer than the read buffer are joined', async () => {
  const long = 'x'.repeat(5000);
  const f = tmp(`${long}\nshort\n`);
  const lines = await all(readLines(f, { highWaterMark: 1024 }));
  assert.equal(lines[0].text.length, 5000);
  assert.equal(lines[1].start, 5001);
});
```

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/trace-lines.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/lines'`

- [ ] **Step 3: Implement**

```js
// lib/trace/lines.js
// Reads JSONL by byte range and reports where each line sits in the file. The explorer stores only
// these offsets in the index, then reads back just the turns it shows (never the whole file).
const fs = require('fs');

async function* readLines(file, { start = 0, end = Infinity, highWaterMark = 1 << 20 } = {}) {
  const stream = fs.createReadStream(file, { start, highWaterMark });
  let pending = []; // buffers of the current, unfinished line
  let pendingLen = 0;
  let lineStart = start;
  for await (const chunk of stream) {
    let from = 0;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) {
      pending.push(chunk.subarray(from, i));
      const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen + i - from);
      const lineEnd = lineStart + buf.length + 1;
      if (lineStart >= end) {
        stream.destroy();
        return;
      }
      let text = buf.toString('utf8');
      if (text.endsWith('\r')) text = text.slice(0, -1);
      yield { text, start: lineStart, end: lineEnd };
      lineStart = lineEnd;
      pending = [];
      pendingLen = 0;
      from = i + 1;
    }
    if (from < chunk.length) {
      pending.push(chunk.subarray(from));
      pendingLen += chunk.length - from;
    }
  }
  if (pendingLen && lineStart < end) {
    let text = Buffer.concat(pending, pendingLen).toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    yield { text, start: lineStart, end: lineStart + pendingLen };
  }
}

async function readRange(file, start, end) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const len = Math.max(0, end - start);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

module.exports = { readLines, readRange };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/trace-lines.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/trace/lines.js test/trace-lines.test.js
git commit -m "Add a byte-accurate JSONL line reader for the trace explorer"
```

---

### Task 2: Turn offsets and subagent links in the index

**Files:**
- Modify: `lib/claude.js` (`parseFile`: replace the `readline` loop with `readLines`, record turns and links)
- Modify: `lib/codex.js` (`parseFile`: same change, record turns)
- Modify: `lib/indexer.js` (add `entries()`; `CACHE_VERSION = 10` with a comment)
- Test: `test/trace-index.test.js`, fixtures `test/fixtures/trace/claude/*`, `test/fixtures/trace/codex/*`

**Interfaces:**
- Consumes: `readLines` from Task 1.
- Produces, on every Claude and Codex session object in `parseFile` results:
  - `turns: [[byteStart, ts]]`, one entry per typed prompt (Claude, non-subagent files) or per `user_message` / `task_started` (Codex), in file order. A turn ends where the next one starts, or at the file size.
- Produces on Claude session objects: `agentLinks: [{ toolUseId, agentId }]`, from `tool_result` lines whose `toolUseResult.agentId` is set (verified in the real format: the user line holds `toolUseResult: { agentId, agentType, status, … }` and `message.content[].tool_use_id`).
- Produces on Claude subagent files' session: `agentId`, from the file name `agent-<agentId>.jsonl`.
- Produces: `Indexer#entries()` → `[{ file, source, size, mtimeMs, result }]`.
- Unchanged: every existing field and event. The existing suites (`test/claude-usage.test.js`, `test/codex-usage.test.js`, `test/signals.test.js`, `test/indexer.test.js`) must stay green.

- [ ] **Step 1: Write the fixtures.** The Claude fixture has 2 typed prompts, one Agent tool_use with a subagent file, and one tool_result line.

`test/fixtures/trace/claude/proj/s1.jsonl`, one JSON object per line:

```
{"type":"user","sessionId":"s1","uuid":"u1","timestamp":"2026-10-20T10:00:00.000Z","cwd":"/w/p","message":{"role":"user","content":"fix the login redirect"}}
{"type":"assistant","sessionId":"s1","uuid":"a1","timestamp":"2026-10-20T10:00:02.000Z","requestId":"r1","message":{"id":"msg_1","role":"assistant","model":"claude-opus-5-5","usage":{"input_tokens":100,"output_tokens":20},"content":[{"type":"tool_use","id":"tu_1","name":"Agent","input":{"subagent_type":"Explore","prompt":"find auth"}}]}}
{"type":"user","sessionId":"s1","uuid":"u2","timestamp":"2026-10-20T10:00:30.000Z","toolUseResult":{"agentId":"ag1","agentType":"Explore","status":"completed"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"found src/auth.js"}]}}
{"type":"assistant","sessionId":"s1","uuid":"a2","timestamp":"2026-10-20T10:00:33.000Z","requestId":"r2","message":{"id":"msg_2","role":"assistant","model":"claude-opus-5-5","usage":{"input_tokens":150,"output_tokens":40},"content":[{"type":"text","text":"Changed the redirect."}]}}
{"type":"user","sessionId":"s1","uuid":"u3","timestamp":"2026-10-20T10:05:00.000Z","message":{"role":"user","content":"now run the tests"}}
{"type":"assistant","sessionId":"s1","uuid":"a3","timestamp":"2026-10-20T10:05:02.000Z","requestId":"r3","message":{"id":"msg_3","role":"assistant","model":"claude-opus-5-5","usage":{"input_tokens":200,"output_tokens":10},"content":[{"type":"text","text":"Done."}]}}
```

`test/fixtures/trace/claude/proj/s1/subagents/agent-ag1.jsonl`:

```
{"type":"user","sessionId":"s1","agentId":"ag1","isSidechain":true,"uuid":"su1","timestamp":"2026-10-20T10:00:03.000Z","message":{"role":"user","content":"find auth"}}
{"type":"assistant","sessionId":"s1","agentId":"ag1","isSidechain":true,"uuid":"sa1","timestamp":"2026-10-20T10:00:05.000Z","requestId":"r9","message":{"id":"msg_9","role":"assistant","model":"claude-haiku-5-5","usage":{"input_tokens":50,"output_tokens":5},"content":[{"type":"text","text":"src/auth.js"}]}}
```

`test/fixtures/trace/codex/rollout-c1.jsonl`:

```
{"timestamp":"2026-10-20T11:00:00.000Z","type":"session_meta","payload":{"id":"c1","cwd":"/w/q","originator":"codex_cli"}}
{"timestamp":"2026-10-20T11:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"add pagination"}}
{"timestamp":"2026-10-20T11:00:02.000Z","type":"turn_context","payload":{"model":"gpt-5.3-codex","cwd":"/w/q"}}
{"timestamp":"2026-10-20T11:00:05.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"k1","arguments":"{\"command\":[\"bash\",\"-lc\",\"ls\"]}"}}
{"timestamp":"2026-10-20T11:00:06.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"k1","output":"src\n"}}
{"timestamp":"2026-10-20T11:00:07.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":0,"output_tokens":30}}}}
{"timestamp":"2026-10-20T11:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"also sort"}}
```

- [ ] **Step 2: Write the failing test**

```js
// test/trace-index.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { readRange } = require('../lib/trace/lines');
const claude = require('../lib/claude');
const codex = require('../lib/codex');

const F = path.join(__dirname, 'fixtures', 'trace');

test('claude: turns start at each typed prompt, with byte offsets', async () => {
  const file = path.join(F, 'claude', 'proj', 's1.jsonl');
  const r = await claude.parseFile(file);
  const s = r.sessions.s1;
  assert.equal(s.turns.length, 2);
  const first = (await readRange(file, s.turns[0][0], s.turns[0][0] + 200)).toString();
  assert.match(first, /^\{"type":"user".*fix the login redirect/);
  const second = (await readRange(file, s.turns[1][0], s.turns[1][0] + 200)).toString();
  assert.match(second, /now run the tests/);
  assert.equal(s.turns[1][1], Date.parse('2026-10-20T10:05:00.000Z'));
});

test('claude: the spawning tool_use is linked to the subagent file', async () => {
  const r = await claude.parseFile(path.join(F, 'claude', 'proj', 's1.jsonl'));
  assert.deepEqual(r.sessions.s1.agentLinks, [{ toolUseId: 'tu_1', agentId: 'ag1' }]);
  const sub = await claude.parseFile(path.join(F, 'claude', 'proj', 's1', 'subagents', 'agent-ag1.jsonl'));
  assert.equal(sub.sessions.s1.agentId, 'ag1');
  assert.deepEqual(sub.sessions.s1.turns, [], 'subagent prompts are not turns of their own');
});

test('codex: a turn per user message, with offsets', async () => {
  const file = path.join(F, 'codex', 'rollout-c1.jsonl');
  const r = await codex.parseFile(file);
  const s = Object.values(r.sessions)[0];
  assert.equal(s.turns.length, 2);
  assert.match((await readRange(file, s.turns[0][0], s.turns[0][0] + 120)).toString(), /add pagination/);
});

test('usage and signals are unchanged by the line reader', async () => {
  const r = await claude.parseFile(path.join(F, 'claude', 'proj', 's1.jsonl'));
  assert.equal(r.events.length, 3);
  assert.equal(r.sessions.s1.prompts, 2);
});
```

- [ ] **Step 3: Run the test and see it fail**

Run: `node --test test/trace-index.test.js`
Expected: FAIL. `s.turns` is undefined.

- [ ] **Step 4: Implement in `lib/claude.js`**
  - Replace the `readline` loop with `for await (const { text: line, start } of readLines(file))`, and drop the now-unused `readline` require.
  - Add `turns: []` and `agentLinks: []` to the `session()` initial object.
  - Where a typed prompt in a non-subagent file is counted (the existing `if (!isSub && isTypedPrompt(o)) {` block), add `s.turns.push([start, Number.isFinite(ts) ? ts : null]);`.
  - In the `isResult` branch, before the `for (const b …)` loop:

    ```js
    const link = o.toolUseResult && typeof o.toolUseResult === 'object' && o.toolUseResult.agentId;
    if (link) {
      const tu = o.message.content.find((b) => b.type === 'tool_result' && b.tool_use_id);
      if (tu) s.agentLinks.push({ toolUseId: tu.tool_use_id, agentId: String(link) });
    }
    ```
  - After the loop, where `if (isSub) s.subagentFiles = 1;` is set, also set `s.agentId = path.basename(file, '.jsonl').replace(/^agent-/, '');` for subagent files.
- [ ] **Step 5: Implement in `lib/codex.js`.**
  - Replace the `readline` loop with `readLines` (`for await (const { text: line, start } of readLines(file))`).
  - Add `turns: []` to the session object.
  - In the `user_message` branch push `s.turns.push([start, Number.isFinite(ts) ? ts : null])`.
  - In the `task_started` branch push the same only when `userMessages === 0`, because older builds log only `task_started` (the existing comment explains this).
  - Lines skipped as fork replay (the `REPLAY_GAP_MS` check) never push a turn, so a fork's copied history is not a turn of its own.
- [ ] **Step 6: Update `lib/indexer.js`.**
  - Set `CACHE_VERSION = 10`, extending the comment: `10: session turn byte offsets and Claude subagent links for the trace explorer`.
  - Add the method:

    ```js
    // Every cached file with its result, for the trace explorer (which needs the file path per session).
    entries() {
      return Object.entries(this.files).map(([file, f]) => ({ file, source: f.source, size: f.size, mtimeMs: f.mtimeMs, result: f.result }));
    }
    ```
- [ ] **Step 7: Run the new and the existing suites**

Run: `node --test test/trace-index.test.js test/claude-usage.test.js test/codex-usage.test.js test/signals.test.js test/indexer.test.js`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/claude.js lib/codex.js lib/indexer.js test/trace-index.test.js test/fixtures/trace
git commit -m "Record turn byte offsets and subagent links in the index"
```

---

### Task 3: Span model and the Claude Code adapter skeleton

**Files:**
- Create: `lib/trace/model.js`, `lib/trace/claude.js`
- Test: `test/trace-claude.test.js` (uses the Task 2 fixtures)

**Interfaces:**
- Consumes: `readLines` (Task 1); Indexer entries shape (Task 2); `makePricer` and `DEFAULT_PRICING` from `lib/pricing.js`; `sig.classifyError` and `sig.scanSecrets` from `lib/signals.js`.
- Produces from `lib/trace/model.js`:
  - `spanId(...parts)`: the first 16 hex characters of `sha256(parts.join('\u0000'))`.
  - `span(fields)`: returns a span with defaults (`parent: null, status: 'ok', usage: null, cost: null, tool: null, signals: [], text: null`).
  - `validate(spans)`: returns an array of problems (an empty array when the tree is valid). It checks that every parent exists, that there is exactly one root, and that children start no earlier than their parent.
  - `totals(spans)`: `{ input, output, cacheRead, cost, tools, errors }`.
- Produces from `lib/trace/claude.js`:
  - `id: 'claude'`;
  - `sessions(entries)`: `[{ id, source: 'claude', title: null, project, branch, start, end, turns: n, tools, errors, cost, flags: { errors, loop, injection }, file, size }]`, with subagent files excluded and their counts folded into the parent;
  - `skeleton(entry, sessionId, { turn, entries, pricing })`: `{ session, turns: [{ index, start, ts }], spans }` for one turn (default: the last). It reads only `[turnStart, nextTurnStart)` plus any linked subagent files.
- Content refs (`span.text`) have the shape `{ f: <file>, s: <byteStart>, e: <byteEnd>, k: 'prompt' | 'reply' | 'tool_input' | 'tool_output', i: <block index or tool_use id> }`. `f` stays server-side; the API swaps it for an opaque id in Task 9.

**Span rules for Claude**
- `session`: the root; `invoke_agent claude-code`.
- `turn`: one per typed prompt; it ends at the last line before the next turn.
- `chat`: one per assistant message id. Streamed blocks with the same `message.id` merge into one. Usage comes from the row with the largest output, as in the existing dedup.
- `tool`: one per `tool_use` block. `end` is the timestamp of the matching `tool_result`; `status` is `error` when `is_error`; `signals` are the `classifyError` category.
- `agent`: a `tool` span whose `tool_use` id appears in `agentLinks`. Its children are the subagent file's own `chat` and `tool` spans, read in full because subagent files are small; recursion is limited to depth 4.
- `answer`: the last `text` block of the turn's last `chat`.

- [ ] **Step 1: Write the failing test**

```js
// test/trace-claude.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const claudeParser = require('../lib/claude');
const adapter = require('../lib/trace/claude');
const { validate, totals } = require('../lib/trace/model');

const dir = path.join(__dirname, 'fixtures', 'trace', 'claude', 'proj');
async function entriesFor(files) {
  const out = [];
  for (const file of files) out.push({ file, source: 'claude', size: fs.statSync(file).size, result: await claudeParser.parseFile(file) });
  return out;
}

test('sessions: one row per session, subagent files folded in', async () => {
  const entries = await entriesFor([path.join(dir, 's1.jsonl'), path.join(dir, 's1', 'subagents', 'agent-ag1.jsonl')]);
  const rows = adapter.sessions(entries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 's1');
  assert.equal(rows[0].turns, 2);
  assert.ok(rows[0].cost > 0);
});

test('skeleton of turn 0: turn → chat → Agent tool → subagent chat, then answer', async () => {
  const entries = await entriesFor([path.join(dir, 's1.jsonl'), path.join(dir, 's1', 'subagents', 'agent-ag1.jsonl')]);
  const main = entries[0];
  const sk = await adapter.skeleton(main, 's1', { turn: 0, entries });
  assert.deepEqual(validate(sk.spans), []);
  // Time order. The Agent tool_use becomes one `agent` span (not a tool span plus an agent span).
  assert.deepEqual(
    sk.spans.map((s) => s.kind),
    ['session', 'turn', 'chat', 'agent', 'chat', 'chat', 'answer'],
  );
  const agent = sk.spans.find((s) => s.kind === 'agent');
  assert.equal(agent.name, 'invoke_agent Explore');
  const subChat = sk.spans.find((s) => s.parent === agent.id && s.kind === 'chat');
  assert.equal(subChat.model, 'claude-haiku-5-5');
  assert.equal(sk.turns.length, 2);
  assert.ok(sk.spans.every((s) => !('textValue' in s)), 'no text in the skeleton');
  const t = totals(sk.spans);
  assert.equal(t.input, 100 + 50 + 150);
});

test('span ids are stable across rebuilds', async () => {
  const entries = await entriesFor([path.join(dir, 's1.jsonl')]);
  const a = await adapter.skeleton(entries[0], 's1', { turn: 1, entries });
  const b = await adapter.skeleton(entries[0], 's1', { turn: 1, entries });
  assert.deepEqual(a.spans.map((s) => s.id), b.spans.map((s) => s.id));
});

test('the skeleton reads only the chosen turn (byte range)', async () => {
  const entries = await entriesFor([path.join(dir, 's1.jsonl')]);
  const sk = await adapter.skeleton(entries[0], 's1', { turn: 1, entries });
  assert.equal(sk.spans.filter((s) => s.kind === 'chat').length, 1);
  assert.ok(sk.spans.every((s) => !s.text || s.text.s >= entries[0].result.sessions.s1.turns[1][0]));
});
```

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/trace-claude.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/claude'`

- [ ] **Step 3: Implement `lib/trace/model.js`**

```js
// The one span shape every trace source produces. Names and kinds follow the OTel GenAI conventions
// (invoke_agent / chat / execute_tool), so an export bridge can map spans one to one later.
const crypto = require('crypto');

const spanId = (...parts) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

function span(f) {
  return { parent: null, status: 'ok', usage: null, cost: null, tool: null, signals: [], text: null, model: null, provider: null, end: null, ...f };
}

function validate(spans) {
  const ids = new Map(spans.map((s) => [s.id, s]));
  const out = [];
  const roots = spans.filter((s) => !s.parent);
  if (roots.length !== 1) out.push(`expected one root, found ${roots.length}`);
  for (const s of spans) {
    if (s.parent && !ids.has(s.parent)) out.push(`${s.id}: parent ${s.parent} missing`);
    const p = s.parent && ids.get(s.parent);
    if (p && Number.isFinite(p.start) && Number.isFinite(s.start) && s.start < p.start) out.push(`${s.id}: starts before its parent`);
  }
  return out;
}

function totals(spans) {
  const t = { input: 0, output: 0, cacheRead: 0, cost: 0, tools: 0, errors: 0 };
  for (const s of spans) {
    if (s.usage) {
      t.input += s.usage.input || 0;
      t.output += s.usage.output || 0;
      t.cacheRead += s.usage.cacheRead || 0;
    }
    if (s.cost) t.cost += s.cost;
    if (s.kind === 'tool') t.tools++;
    if (s.status === 'error') t.errors++;
  }
  return t;
}

module.exports = { spanId, span, validate, totals };
```

- [ ] **Step 4: Implement `lib/trace/claude.js`** (the full module):

```js
// Claude Code adapter for the trace explorer. Sessions come from the index; a turn's spans are built
// by reading only that turn's byte range (and the small subagent files it links to). No text is kept:
// spans carry a reference to where their text sits, read on demand by lib/trace/content.js.
const path = require('path');
const { readLines } = require('./lines');
const { spanId, span } = require('./model');
const sig = require('../signals');
const { makePricer, DEFAULT_PRICING, eventParts } = require('../pricing');

const isSubFile = (file) => file.includes(`${path.sep}subagents${path.sep}`);

function sessions(entries) {
  const out = new Map();
  for (const e of entries) {
    if (e.source !== 'claude' || isSubFile(e.file)) continue;
    for (const [sid, s] of Object.entries(e.result.sessions || {})) {
      if (!s.turns || !s.turns.length) continue;
      const sig2 = (e.result.signals && e.result.signals.events) || [];
      const mine = sig2.filter((x) => x.sid === sid);
      out.set(sid, {
        id: sid,
        source: 'claude',
        title: null, // read on demand from the first turn (no text in the index)
        project: s.project,
        branch: s.branch,
        start: s.first,
        end: s.last,
        turns: s.turns.length,
        tools: Object.values(s.tools || {}).reduce((a, b) => a + b, 0),
        errors: mine.filter((x) => x.kind === 'error').length,
        cost: 0,
        flags: { errors: mine.some((x) => x.kind === 'error'), loop: mine.some((x) => x.kind === 'loop'), injection: mine.some((x) => x.kind === 'injection') },
        file: e.file,
        size: e.size,
      });
    }
  }
  // Cost from the usage rows (main and subagent files of the same session).
  const pricer = makePricer(DEFAULT_PRICING);
  for (const e of entries) {
    if (e.source !== 'claude') continue;
    for (const row of e.result.events || []) {
      const r = out.get(row[2]);
      if (r) r.cost += eventParts(pricer, row).reduce((a, b) => a + b, 0);
    }
  }
  return [...out.values()];
}

const tsOf = (o) => Date.parse(o.timestamp);

// Parse one transcript range into chat and tool spans under `parent`.
async function spansOf(file, range, sid, parent, ctx, depth) {
  const chats = new Map(); // message id -> chat span
  const tools = new Map(); // tool_use id -> tool span
  const out = [];
  let lastChat = null;
  let lastText = null;
  for await (const { text, start, end } of readLines(file, range)) {
    if (!text.includes('"type":"assistant"') && !text.includes('"type":"user"')) continue;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      out.push(span({ id: spanId(file, start, 'bad'), parent, kind: 'unknown', op: 'unknown', name: 'unreadable line', start: null, status: 'unknown', text: { f: file, s: start, e: end, k: 'raw' } }));
      continue;
    }
    const ts = tsOf(o);
    const m = o.message;
    if (o.type === 'assistant' && m && m.model && m.model !== '<synthetic>') {
      let c = chats.get(m.id);
      if (!c) {
        c = span({ id: spanId(file, 'chat', m.id || start), parent, kind: 'chat', op: 'chat', name: `chat ${m.model}`, start: ts, end: ts, model: m.model, provider: 'anthropic', usage: null, text: { f: file, s: start, e: end, k: 'reply', i: m.id } });
        chats.set(m.id, c);
        out.push(c);
      }
      c.end = Math.max(c.end || ts, ts);
      c.text.e = Math.max(c.text.e, end);
      const u = m.usage || {};
      const usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite5m: 0, cacheWrite1h: 0 };
      if (!c.usage || usage.output >= c.usage.output) {
        c.usage = usage;
        const row = [ts, 'claude', sid, m.model, usage.input, usage.output, usage.cacheRead, 0, 0, 0, null, null];
        c.cost = eventParts(ctx.pricer, row).reduce((a, b) => a + b, 0);
      }
      lastChat = c;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text' && b.text) lastText = { f: file, s: start, e: end, k: 'reply', i: m.id };
        if (b.type !== 'tool_use' || tools.has(b.id)) continue;
        const agentId = ctx.links.get(b.id);
        const kind = agentId ? 'agent' : 'tool';
        const label = agentId ? (b.input && b.input.subagent_type) || 'subagent' : b.name;
        const t = span({ id: spanId(file, 'tool', b.id), parent, kind, op: agentId ? 'invoke_agent' : 'execute_tool', name: agentId ? `invoke_agent ${label}` : `execute_tool ${b.name}`, start: ts, tool: { name: b.name, target: targetOf(b) }, status: 'running', text: { f: file, s: start, e: end, k: 'tool_input', i: b.id } });
        tools.set(b.id, t);
        out.push(t);
        if (agentId && depth < 4) {
          const sub = ctx.subFiles.get(agentId);
          if (sub) out.push(...(await spansOf(sub, {}, sid, t.id, ctx, depth + 1)).spans);
        }
      }
    } else if (o.type === 'user' && m && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const t = tools.get(b.tool_use_id);
        if (!t) continue;
        t.end = ts;
        t.status = b.is_error ? 'error' : 'ok';
        t.result = { f: file, s: start, e: end, k: 'tool_output', i: b.tool_use_id };
        if (b.is_error) {
          const txt = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '';
          t.signals = [sig.classifyError(txt, t.tool.name)[0]];
        }
      }
    }
  }
  return { spans: out, lastChat, lastText };
}

function targetOf(b) {
  const i = b.input || {};
  const p = i.file_path || i.path || i.notebook_path || '';
  if (p) return path.basename(String(p));
  if (typeof i.command === 'string') return i.command.trim().split(/\s+/)[0];
  if (i.url) {
    try {
      return new URL(i.url).host;
    } catch {
      return null;
    }
  }
  return null;
}

async function skeleton(entry, sid, { turn, entries = [], pricing } = {}) {
  const s = entry.result.sessions[sid];
  const turns = s.turns.map(([start, ts], index) => ({ index, start, ts }));
  const n = turn == null ? turns.length - 1 : Math.max(0, Math.min(turns.length - 1, turn));
  const range = { start: turns[n].start, end: n + 1 < turns.length ? turns[n + 1].start : entry.size };
  const links = new Map((s.agentLinks || []).map((l) => [l.toolUseId, l.agentId]));
  const subFiles = new Map();
  for (const e of entries) if (isSubFile(e.file) && e.result.sessions[sid] && e.result.sessions[sid].agentId) subFiles.set(e.result.sessions[sid].agentId, e.file);
  const ctx = { links, subFiles, pricer: makePricer(pricing || DEFAULT_PRICING) };
  const root = span({ id: spanId(entry.file, sid, 'session'), kind: 'session', op: 'invoke_agent', name: 'invoke_agent claude-code', start: s.first, end: s.last });
  const turnSpan = span({ id: spanId(entry.file, sid, 'turn', turns[n].start), parent: root.id, kind: 'turn', op: 'invoke_agent', name: `turn ${n + 1}`, start: turns[n].ts, text: { f: entry.file, s: range.start, e: range.start, k: 'prompt' } });
  const body = await spansOf(entry.file, range, sid, turnSpan.id, ctx, 0);
  turnSpan.end = Math.max(turnSpan.start || 0, ...body.spans.map((x) => x.end || 0));
  const spans = [root, turnSpan, ...body.spans];
  if (body.lastText) spans.push(span({ id: spanId(entry.file, sid, 'answer', range.start), parent: turnSpan.id, kind: 'answer', op: 'chat', name: 'answer', start: body.lastChat.end, end: body.lastChat.end, text: body.lastText }));
  for (const t of spans) if (t.status === 'running') t.status = 'unknown';
  return { session: { id: sid, source: 'claude', project: s.project, branch: s.branch, start: s.first, end: s.last }, turns, spans };
}

module.exports = { id: 'claude', sessions, skeleton };
```

The turn span's prompt ref points at the first line of the turn: `content.js` reads the line that starts at `s`. The answer span reuses the reply ref.

- [ ] **Step 5: Run the test and see it pass**

Run: `node --test test/trace-claude.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/trace/model.js lib/trace/claude.js test/trace-claude.test.js
git commit -m "Build Claude Code session skeletons from one turn's byte range"
```

---

### Task 4: Content reader, masking and path safety

**Files:**
- Create: `lib/trace/content.js`
- Test: `test/trace-content.test.js`

**Interfaces:**
- Consumes: `readRange` and `readLines` (Task 1); refs from Task 3; the `SECRETS`, `SECRET_HINT` and `isLiveSecret` internals of `lib/signals.js`.
- Produces in `lib/signals.js`: `secretSpans(text)` → `[{ start, end, label }]` (new; Step 4), so masking and `scanSecrets` never disagree.
- Produces:
  - `createContent({ roots })`: returns `{ read(ref, { offset = 0, max = 65536 }) → Promise<{ text, masked: [{ start, end, label }], offset, next, total, truncated }>, reveal(ref, maskIndex) → Promise<{ value }> }`.
  - `roots` is an array of directories, for example `[~/.claude/projects, ~/.codex/sessions, dataDir]`. `read` refuses a ref whose `realpath` is outside every root, and an `s`/`e` outside the file size.
- Field extraction by `k`:
  - `prompt`: the user text of the line at `s`.
  - `reply`: all `text` blocks of the assistant lines with message id `i` within `[s, e)`.
  - `tool_input`: the `input` of `tool_use` id `i`, pretty-printed JSON.
  - `tool_output`: the `content` of `tool_result` id `i`. When it says it was saved under `<session>/tool-results/<name>`, the reader resolves that file inside the same root. The marker format is verified on the reference machine and stored in a fixture.
  - `raw`: the raw line.

- [ ] **Step 1: Write the failing test**

```js
// test/trace-content.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContent } = require('../lib/trace/content');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const file = path.join(root, 's.jsonl');
  // Built at runtime with varied characters: a low-variety key ("aaaa…") counts as a placeholder in
  // isLiveSecret, and a literal key-shaped string would trip GitHub push protection.
  const alphabet = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const secret = 'sk-' + 'ant-api03-' + Array.from({ length: 48 }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'hello <script>alert(1)</script>' } },
    { type: 'assistant', message: { id: 'm1', model: 'x', content: [{ type: 'text', text: `key ${secret} done` }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(70000) }] } },
  ].map((o) => JSON.stringify(o) + '\n');
  fs.writeFileSync(file, lines.join(''));
  const off = [];
  let n = 0;
  for (const l of lines) {
    off.push([n, n + Buffer.byteLength(l)]);
    n += Buffer.byteLength(l);
  }
  return { root, file, off, secret };
}

test('prompt text comes back as plain text (HTML is not interpreted here)', async () => {
  const { root, file, off } = fixture();
  const c = createContent({ roots: [root] });
  const r = await c.read({ f: file, s: off[0][0], e: off[0][1], k: 'prompt' });
  assert.equal(r.text, 'hello <script>alert(1)</script>');
});

test('secrets are masked, and reveal returns one value on request', async () => {
  const { root, file, off, secret } = fixture();
  const c = createContent({ roots: [root] });
  const ref = { f: file, s: off[1][0], e: off[1][1], k: 'reply', i: 'm1' };
  const r = await c.read(ref);
  assert.ok(!r.text.includes(secret));
  assert.equal(r.masked.length, 1);
  assert.equal((await c.reveal(ref, 0)).value, secret);
});

test('tool output is paged at 64 KB', async () => {
  const { root, file, off } = fixture();
  const c = createContent({ roots: [root] });
  const ref = { f: file, s: off[2][0], e: off[2][1], k: 'tool_output', i: 't1' };
  const p1 = await c.read(ref);
  assert.equal(p1.text.length, 65536);
  assert.equal(p1.truncated, true);
  const p2 = await c.read(ref, { offset: p1.next });
  assert.equal(p2.text.length, 70000 - 65536);
});

test('refs outside the roots or past the file end are refused', async () => {
  const { root, file, off } = fixture();
  const c = createContent({ roots: [root] });
  await assert.rejects(c.read({ f: '/etc/hosts', s: 0, e: 10, k: 'raw' }), /outside/);
  await assert.rejects(c.read({ f: path.join(root, '..', path.basename(root), '..', 'x'), s: 0, e: 1, k: 'raw' }), /outside|missing/);
  await assert.rejects(c.read({ f: file, s: 0, e: 10 ** 9, k: 'raw' }), /range/);
  const link = path.join(root, 'link.jsonl');
  fs.symlinkSync('/etc/hosts', link);
  await assert.rejects(c.read({ f: link, s: 0, e: 10, k: 'raw' }), /outside/);
});
```

On Windows, wrap the symlink part in `if (process.platform !== 'win32')`, because creating a symlink needs privileges there.

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/trace-content.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/content'`

- [ ] **Step 3: Implement `lib/trace/content.js`**

```js
// Reads one span's text from the original log, on demand: only the span's byte range, masked for secrets,
// in 64 KB pages. Files must resolve inside a known source root (no traversal, no symlinks out of it).
const fs = require('fs');
const path = require('path');
const { readLines } = require('./lines');
const sig = require('../signals');

const PAGE = 64 * 1024;

function createContent({ roots }) {
  const real = roots.map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return null;
    }
  }).filter(Boolean);

  async function safe(file, s, e) {
    let rp;
    try {
      rp = fs.realpathSync(file);
    } catch {
      throw Object.assign(new Error('file missing'), { status: 404 });
    }
    if (!real.some((r) => rp === r || rp.startsWith(r + path.sep))) throw Object.assign(new Error('path outside the known log folders'), { status: 403 });
    const size = fs.statSync(rp).size;
    if (!(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e >= s && e <= size)) throw Object.assign(new Error('byte range outside the file'), { status: 400 });
    return rp;
  }

  async function fieldText(ref) {
    const file = await safe(ref.f, ref.s, ref.e);
    const parts = [];
    for await (const { text } of readLines(file, { start: ref.s, end: ref.e === ref.s ? ref.s + 1 : ref.e })) {
      if (ref.k === 'raw') {
        parts.push(text);
        break;
      }
      let o;
      try {
        o = JSON.parse(text);
      } catch {
        continue;
      }
      const m = o.message || {};
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (ref.k === 'prompt') {
        parts.push(typeof m.content === 'string' ? m.content : blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
        break;
      }
      if (ref.k === 'reply' && m.id === ref.i) for (const b of blocks) if (b.type === 'text' && b.text) parts.push(b.text);
      if (ref.k === 'tool_input') for (const b of blocks) if (b.type === 'tool_use' && b.id === ref.i) parts.push(JSON.stringify(b.input ?? {}, null, 2));
      if (ref.k === 'tool_output')
        for (const b of blocks)
          if (b.type === 'tool_result' && b.tool_use_id === ref.i)
            parts.push(typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '');
    }
    return parts.join('\n');
  }

  async function read(ref, { offset = 0, max = PAGE } = {}) {
    const full = await fieldText(ref);
    const page = full.slice(offset, offset + max);
    const masked = [];
    let text = '';
    let last = 0;
    for (const m of sig.secretSpans(page)) {
      const mark = `‹${m.label} hidden›`;
      text += page.slice(last, m.start);
      masked.push({ start: text.length, end: text.length + mark.length, label: m.label });
      text += mark;
      last = m.end;
    }
    text += page.slice(last);
    const next = offset + page.length < full.length ? offset + page.length : null;
    return { text: masked.length ? text : page, masked, offset, next, total: full.length, truncated: next !== null };
  }

  async function reveal(ref, index, { offset = 0, max = PAGE } = {}) {
    const full = await fieldText(ref);
    const m = sig.secretSpans(full.slice(offset, offset + max))[index];
    if (!m) throw Object.assign(new Error('no such masked value'), { status: 404 });
    return { value: full.slice(offset + m.start, offset + m.end) };
  }

  return { read, reveal };
}

module.exports = { createContent, PAGE };
```

When no secret is masked, `text` is the raw page (that is what `masked.length ? text : page` does). The test then expects `p1.text.length === 65536`.

- [ ] **Step 4: Add `secretSpans` to `lib/signals.js`**, after `scanSecrets`, and add it to `module.exports`:

```js
// Where each live secret sits in the text, for masking. Same patterns and placeholder checks as
// scanSecrets. For a database URL only the password is masked, so the host stays readable.
function secretSpans(text) {
  const s = String(text || '');
  if (!SECRET_HINT.test(s)) return [];
  const found = [];
  for (const [label, re] of SECRETS) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (!isLiveSecret(label, m)) continue;
      if (label === 'Database URL with password') {
        const at = m.index + m[0].indexOf(`:${m[1]}@`, m[0].indexOf('://') + 3) + 1;
        found.push({ start: at, end: at + m[1].length, label });
      } else found.push({ start: m.index, end: m.index + m[0].length, label });
    }
    re.lastIndex = 0;
  }
  // Patterns can overlap (an OpenAI-shaped match inside a longer key): keep the earliest, then the longest.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const f of found) if (!out.length || f.start >= out[out.length - 1].end) out.push(f);
  return out;
}
```

Add to `test/signals.test.js`:

```js
test('secretSpans: positions match the masked value, placeholders are skipped', () => {
  const alphabet = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const key = 'sk-' + 'ant-api03-' + Array.from({ length: 48 }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('');
  const text = `use ${key} now`;
  const [m, ...rest] = sig.secretSpans(text);
  assert.equal(rest.length, 0);
  assert.equal(text.slice(m.start, m.end), key);
  assert.deepEqual([m.label], sig.scanSecrets(text));
  assert.deepEqual(sig.secretSpans('sk-ant-your-key-here-xxxxxxxxxxxxxxxxxxxx'), []);
  const db = 'postgres://app:' + 'Tr0ub4dor3x' + '@db.local/app';
  const [d] = sig.secretSpans(db);
  assert.equal(db.slice(d.start, d.end), 'Tr0ub4dor3x');
});
```
- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/trace-content.test.js test/signals.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/trace/content.js lib/signals.js test/trace-content.test.js test/signals.test.js
git commit -m "Read one span's text on demand, masked, paged and kept inside the log folders"
```

---

### Task 5: Codex adapter

**Files:**
- Create: `lib/trace/codex.js`
- Test: `test/trace-codex.test.js` (fixture from Task 2, plus `test/fixtures/trace/codex/rollout-fork.jsonl`, a fork whose first lines are copied parent history within 1 s)

**Interfaces:**
- Consumes: the Task 2 result fields, `readLines`, and `model.js`.
- Produces: `id: 'codex'`, `sessions(entries)` and `skeleton(entry, sessionId, { turn, entries, pricing })`, with the same output shape as Task 3.

**Span rules for Codex**
- The turn starts at the `user_message` offset.
- `chat` spans come from `token_count` deltas within the turn, with the model from the latest `turn_context`. The reply text ref points at `agent_message` lines.
- `tool` spans pair `function_call` / `custom_tool_call` with `*_output` by `call_id`, using `shellOutput()` exit codes for status (reuse `lib/codex.js` exports; export `shellOutput` and `commandOf` if they are not exported).
- `web_search_call` becomes a tool span named `execute_tool web_search`.
- Fork replay lines (session_meta with a parent, then lines within `REPLAY_GAP_MS`) are skipped, as in the parser.

- [ ] **Step 1: Write the failing test**

```js
// test/trace-codex.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const codexParser = require('../lib/codex');
const adapter = require('../lib/trace/codex');
const { validate } = require('../lib/trace/model');

const F = path.join(__dirname, 'fixtures', 'trace', 'codex');
const entry = async (name) => {
  const file = path.join(F, name);
  return { file, source: 'codex', size: fs.statSync(file).size, result: await codexParser.parseFile(file) };
};

test('codex turn: chat from token counts, a shell tool paired by call id', async () => {
  const e = await entry('rollout-c1.jsonl');
  const sid = Object.keys(e.result.sessions)[0];
  const sk = await adapter.skeleton(e, sid, { turn: 0, entries: [e] });
  assert.deepEqual(validate(sk.spans), []);
  const tool = sk.spans.find((s) => s.kind === 'tool');
  assert.equal(tool.name, 'execute_tool shell');
  assert.equal(tool.status, 'ok');
  assert.equal(tool.tool.target, 'ls');
  const chat = sk.spans.find((s) => s.kind === 'chat');
  assert.equal(chat.model, 'gpt-5.3-codex');
  assert.equal(chat.usage.input, 300);
});

test('codex fork: copied parent history is not part of the turn', async () => {
  const e = await entry('rollout-fork.jsonl');
  const sid = Object.keys(e.result.sessions)[0];
  const sk = await adapter.skeleton(e, sid, { turn: 0, entries: [e] });
  assert.equal(sk.spans.filter((s) => s.kind === 'chat').length, 1);
});
```

`rollout-fork.jsonl`, one JSON object per line:

```
{"timestamp":"2026-10-20T12:00:00.000Z","type":"session_meta","payload":{"id":"f1","forked_from_id":"c1","cwd":"/w/q"}}
{"timestamp":"2026-10-20T12:00:00.100Z","type":"event_msg","payload":{"type":"user_message","message":"add pagination"}}
{"timestamp":"2026-10-20T12:00:00.200Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":0,"output_tokens":30}}}}
{"timestamp":"2026-10-20T12:05:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"now in the fork"}}
{"timestamp":"2026-10-20T12:05:01.000Z","type":"turn_context","payload":{"model":"gpt-5.3-codex"}}
{"timestamp":"2026-10-20T12:05:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":420,"cached_input_tokens":0,"output_tokens":45}}}}
```

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/trace-codex.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/codex'`

- [ ] **Step 3: Implement `lib/trace/codex.js`**
  - Mirror `lib/trace/claude.js`: `sessions()` reads `entries` with `source === 'codex'` and costs rows with `eventParts`. `skeleton()` reads `[turnStart, nextTurnStart)`.
  - Line types: `turn_context` sets the model. `token_count` makes a chat span with the delta against the previous total; the baseline is the last `total_token_usage` seen before the range, found by reading the session's `token_count` rows from `entry.result.events` up to the turn's ts. `agent_message` sets the reply ref. Calls and outputs become tool spans.
  - Use `lib/codex.js` `commandOf(args)` (already exported) for the target, which is the first word of the command. Use `shellOutput(text)` for the exit status; add `shellOutput` to `lib/codex.js`'s `module.exports`.
  - Content refs reuse the shape from Task 3 with `k` values `prompt`, `reply`, `tool_input` and `tool_output`. Extend `lib/trace/content.js` `fieldText` for Codex lines:
    - `o.payload.type === 'user_message'` gives `payload.message` for `prompt`;
    - `agent_message` gives `payload.message` for `reply`;
    - `function_call` with `call_id === i` gives `arguments` for `tool_input`;
    - `function_call_output` gives `output` for `tool_output`.

    Add one test per field in `test/trace-content.test.js`.
- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/trace-codex.test.js test/trace-content.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/trace/codex.js lib/trace/content.js lib/codex.js test/trace-codex.test.js test/trace-content.test.js test/fixtures/trace/codex
git commit -m "Add the Codex trace adapter"
```

---

### Task 6: Gateway adapter (requests and collaboration runs)

**Files:**
- Modify: `lib/gateway/index.js`, adding to the object `createGateway` returns:

  ```js
  trace: {
    runs: (limit = 200) => collab.list({ limit }),
    run: (id) => collab.get(id),
    requests: (n = 2000) => usage.recent(n),
  },
  ```
- Create: `lib/trace/gateway.js`
- Test: `test/trace-gateway.test.js`

**Interfaces:**
- Consumes: `gateway.trace` (above); run shape `{ id, pattern, state, createdAt, task, trace: [{ id, parent, name, start, end, status, attrs, error }], steps: [{ agent, model, text, usage }], answer }`; request entries `{ ts, keyId, provider, model, agent, sessionId, kind, status, ms, ttft, input, output, cached, error, cost }`.
- Produces: `createGatewayAdapter(gatewayTrace)` → `{ id: 'gateway', sessions(), skeleton(_, id, { turn }) }`.
  - Sessions: one per collaboration run (`run:<id>`, title from `pattern` and state, never task text), plus one per `sessionId` grouping of plain requests (`req:<sessionId>`). Requests without a session id are grouped per key per hour (`req:<keyId>:<hourIso>`).
  - Run skeleton: the run's `trace` spans mapped to the span model. Names are kept. Kind comes from the name prefix: `invoke_workflow` → `session`, `invoke_agent` → `agent`, `chat` → `chat`, `execute_tool` → `tool`, `plan` or `judge` → `tool`. Step text refs are `{ g: 'run', id, step: n }`; the answer ref is `{ g: 'run', id, answer: true }`.
  - Request skeleton: one `chat` span per request (metadata only, `text: null`).
- `lib/trace/content.js` gains `g: 'run'` refs: the text is read from `gatewayTrace.run(id)` and masked the same way (`createContent({ roots, gateway })`).

- [ ] **Step 1: Write the failing test**

```js
// test/trace-gateway.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGatewayAdapter } = require('../lib/trace/gateway');
const { validate } = require('../lib/trace/model');

const run = {
  id: 'r1', pattern: 'vote', state: 'completed', createdAt: 1000, task: 'secret task text', answer: 'final',
  steps: [{ agent: 'a', model: 'm', text: 'step text', usage: { input: 5, output: 3 } }],
  trace: [
    { id: 'x0', parent: null, name: 'invoke_workflow vote', start: 1000, end: 5000, status: 'ok', attrs: {} },
    { id: 'x1', parent: 'x0', name: 'invoke_agent a', start: 1100, end: 3000, status: 'ok', attrs: {} },
    { id: 'x2', parent: 'x1', name: 'chat m', start: 1200, end: 2000, status: 'ok', attrs: { 'gen_ai.usage.input_tokens': 5 } },
  ],
};
const g = {
  runs: () => [run],
  run: (id) => (id === 'r1' ? run : null),
  requests: () => [
    { ts: 2000, keyId: 'k1', provider: 'p', model: 'm', sessionId: 'conv-1', kind: 'chat', status: 200, ms: 300, input: 10, output: 4, cost: 0.001 },
    { ts: 2500, keyId: 'k1', provider: 'p', model: 'm', sessionId: 'conv-1', kind: 'chat', status: 500, ms: 90, input: 3, output: 0, cost: 0, error: 'upstream' },
  ],
};

test('runs and request sessions are listed without task text', () => {
  const a = createGatewayAdapter(g);
  const rows = a.sessions();
  assert.deepEqual(rows.map((r) => r.id).sort(), ['req:conv-1', 'run:r1']);
  assert.ok(!JSON.stringify(rows).includes('secret task text'));
});

test('a run skeleton maps its trace spans', async () => {
  const sk = await createGatewayAdapter(g).skeleton(null, 'run:r1', {});
  assert.deepEqual(validate(sk.spans), []);
  assert.deepEqual(sk.spans.map((s) => s.kind), ['session', 'agent', 'chat']);
});

test('a request session has one chat span per request, the failed one marked', async () => {
  const sk = await createGatewayAdapter(g).skeleton(null, 'req:conv-1', {});
  const chats = sk.spans.filter((s) => s.kind === 'chat');
  assert.equal(chats.length, 2);
  assert.equal(chats[1].status, 'error');
  assert.ok(chats.every((c) => c.text === null));
});
```

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/trace-gateway.test.js`
Expected: FAIL, `Cannot find module '../lib/trace/gateway'`

- [ ] **Step 3: Implement `lib/trace/gateway.js`**

```js
// Agent Gateway sessions for the trace explorer: collaboration runs (full span tree, step text on demand)
// and plain requests grouped by conversation (metadata only: the gateway never stores request text).
const { spanId, span } = require('./model');

const kindOf = (name) =>
  /^invoke_workflow/.test(name) ? 'session' : /^invoke_agent/.test(name) ? 'agent' : /^chat|^embeddings/.test(name) ? 'chat' : 'tool';

function createGatewayAdapter(g) {
  function groups() {
    const out = new Map();
    for (const r of g.requests()) {
      const key = r.sessionId ? `req:${r.sessionId}` : `req:${r.keyId || 'nokey'}:${new Date(Math.floor(r.ts / 3600000) * 3600000).toISOString()}`;
      (out.get(key) || out.set(key, []).get(key)).push(r);
    }
    return out;
  }
  function sessions() {
    const rows = g.runs().map((r) => ({
      id: `run:${r.id}`, source: 'gateway', title: `${r.pattern} run · ${r.state}`, project: 'gateway', branch: null,
      start: r.createdAt, end: Math.max(r.createdAt, ...(r.trace || []).map((s) => s.end || 0)), turns: 1,
      tools: (r.trace || []).filter((s) => kindOf(s.name) === 'tool').length, errors: (r.trace || []).filter((s) => s.status === 'error').length,
      cost: (r.spent && r.spent.cost) || 0, flags: { errors: r.state === 'failed', loop: false, injection: false },
    }));
    for (const [id, reqs] of groups())
      rows.push({
        id, source: 'gateway', title: `${reqs.length} request${reqs.length === 1 ? '' : 's'} · ${reqs[0].model}`, project: 'gateway', branch: null,
        start: Math.min(...reqs.map((r) => r.ts)), end: Math.max(...reqs.map((r) => r.ts + (r.ms || 0))), turns: 1, tools: 0,
        errors: reqs.filter((r) => r.status >= 400 || r.error).length, cost: reqs.reduce((a, r) => a + (r.cost || 0), 0),
        flags: { errors: reqs.some((r) => r.status >= 400 || r.error), loop: false, injection: false },
      });
    return rows;
  }
  async function skeleton(_entry, id) {
    if (id.startsWith('run:')) {
      const r = g.run(id.slice(4));
      if (!r) throw Object.assign(new Error('run not found'), { status: 404 });
      const spans = (r.trace || []).map((s, i) =>
        span({ id: spanId('gw', r.id, s.id), parent: s.parent ? spanId('gw', r.id, s.parent) : null, kind: kindOf(s.name), op: s.name.split(' ')[0], name: s.name, start: s.start, end: s.end, status: s.status === 'error' ? 'error' : 'ok', model: s.attrs && s.attrs['gen_ai.request.model'], usage: s.attrs && s.attrs['gen_ai.usage.input_tokens'] != null ? { input: s.attrs['gen_ai.usage.input_tokens'] || 0, output: s.attrs['gen_ai.usage.output_tokens'] || 0, cacheRead: 0 } : null, text: kindOf(s.name) === 'chat' ? { g: 'run', id: r.id, step: i } : null }),
      );
      return { session: { id, source: 'gateway', start: r.createdAt }, turns: [{ index: 0, start: 0, ts: r.createdAt }], spans };
    }
    const reqs = groups().get(id);
    if (!reqs) throw Object.assign(new Error('session not found'), { status: 404 });
    const root = span({ id: spanId('gw', id), kind: 'session', op: 'invoke_agent', name: 'gateway session', start: reqs[0].ts, end: Math.max(...reqs.map((r) => r.ts + (r.ms || 0))) });
    const spans = [root, ...reqs.map((r, i) => span({ id: spanId('gw', id, i), parent: root.id, kind: 'chat', op: 'chat', name: `chat ${r.model}`, start: r.ts, end: r.ts + (r.ms || 0), status: r.status >= 400 || r.error ? 'error' : 'ok', model: r.model, provider: r.provider, usage: { input: r.input || 0, output: r.output || 0, cacheRead: r.cached || 0 }, cost: r.cost || 0 }))];
    return { session: { id, source: 'gateway', start: root.start }, turns: [{ index: 0, start: 0, ts: root.start }], spans };
  }
  return { id: 'gateway', sessions, skeleton };
}

module.exports = { createGatewayAdapter };
```

- [ ] **Step 4: Add the `trace` accessors to `createGateway`'s return value** in `lib/gateway/index.js`, next to the other returned members. Then extend `lib/trace/content.js` for `ref.g === 'run'`:
  - `step: n` returns the step text;
  - `answer: true` returns `run.answer`;
  - the text is masked like file text.

  Add a test in `test/trace-content.test.js` with a fake gateway.
- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/trace-gateway.test.js test/trace-content.test.js test/gateway.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/trace/gateway.js lib/trace/content.js lib/gateway/index.js test/trace-gateway.test.js test/trace-content.test.js
git commit -m "Add gateway runs and request sessions to the trace explorer"
```

---

### Task 7: Kiro, Gemini CLI and Antigravity adapters

**Files:**
- Create: `lib/trace/kiro.js`, `lib/trace/gemini.js`, `lib/trace/antigravity.js`
- Test: `test/trace-light.test.js`, fixtures under `test/fixtures/trace/{kiro,gemini}/`. The Antigravity DB is generated in the test with `node:sqlite` when available, and that test is skipped otherwise.

**Interfaces**
- Each module exports `{ id, available(), sessions(), skeleton(_, id, { turn }) }`, where `available()` returns `{ ok, reason }`. These sources are not in the indexer: they list files themselves (cheap: their folders are small) and cache listings for 30 s.
- **Kiro**
  - Root: `~/.kiro/sessions`. Each session has `<id>/<sess>/messages.jsonl` and a session JSON next to it, with `title`, `workspacePaths`, `createdAt` and `lastModifiedAt`.
  - Messages: lines `{ id, timestamp, payload: { type, toolCallId, toolName, args, status, kind, … } }`.
  - Turns: a new turn starts at each payload whose `type` is a user message. The exact type values are verified on the real file and recorded in the fixture.
  - Tool spans come from payloads with `toolName`, and `status` gives the span status.
  - No usage or cost.
- **Gemini CLI**
  - Root: `~/.gemini/tmp/**/chats/*.json`, documented chat files with a `messages` array of `{ type: 'user' | 'gemini', content, toolCalls?, tokens? }`.
  - Turns come from user messages. Tool spans come from `toolCalls`.
  - Usage comes from `tokens` when present.
  - The fixture is synthetic, because the format was not in use on the reference machine.
- **Antigravity**
  - `available()` is false (reason "needs Node 22.5 or newer") when `require('node:sqlite')` throws.
  - Opens `~/.gemini/antigravity/conversation_summaries.db` and `~/.gemini/antigravity-ide/conversation_summaries.db`, when present, with `new DatabaseSync(file, { readOnly: true })`. On `SQLITE_BUSY` it copies the file to `os.tmpdir()` and opens the copy (S9).
  - Sessions come from `SELECT conversation_id, title, step_count, agent_name, parent_conversation_id, nesting_depth, status, last_modified_time FROM conversation_summaries`.
  - The skeleton is conversation level: the root span, then one `agent` child per sub-conversation (`parent_conversation_id`), each with its step count in `tool.target`.
  - Text is not available; `text` is null.

- [ ] **Step 1: Write the failing test.** Cover the following:
  - a Kiro fixture with 2 turns and 3 tool calls (one failed) gives `validate() === []`, 3 tool spans, and 1 error;
  - a Gemini fixture with 2 turns and usage gives chat spans with usage;
  - Antigravity, run only `if (sqliteAvailable)`: create a temp DB with the `conversation_summaries` columns above, holding 1 parent and 2 child rows. Then:
    - `sessions()` gives 1 row with `turns === 1`;
    - the skeleton has 2 `agent` children;
    - after the read, the DB file's mtime is unchanged.

```js
// test/trace-light.test.js (Antigravity part)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  /* Node < 22.5 */
}
const ag = require('../lib/trace/antigravity');

test('antigravity: conversation level, read-only', { skip: !sqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-ag-'));
  const db = path.join(dir, 'conversation_summaries.db');
  const w = new sqlite.DatabaseSync(db);
  w.exec(`CREATE TABLE conversation_summaries (conversation_id text primary key, title text, step_count integer, agent_name text, parent_conversation_id text, nesting_depth integer, status text, last_modified_time datetime, last_user_input_time datetime, workspace_uris text, preview text)`);
  w.exec(`INSERT INTO conversation_summaries VALUES ('p','landing page',34,'main','',0,'idle','2026-10-19T10:00:00Z','2026-10-19T09:00:00Z','file:///w','') , ('c1','sub a',5,'helper','p',1,'idle','2026-10-19T09:30:00Z','2026-10-19T09:10:00Z','file:///w',''), ('c2','sub b',3,'helper','p',1,'idle','2026-10-19T09:40:00Z','2026-10-19T09:20:00Z','file:///w','')`);
  w.close();
  const before = fs.statSync(db).mtimeMs;
  const a = ag.createAntigravity({ files: [db] });
  const rows = a.sessions();
  assert.equal(rows.length, 1);
  const sk = await a.skeleton(null, rows[0].id, {});
  assert.equal(sk.spans.filter((s) => s.kind === 'agent').length, 2);
  assert.equal(fs.statSync(db).mtimeMs, before);
});
```

Each light module exports a factory (`createKiro({ root })`, `createGemini({ root })`, `createAntigravity({ files })`) for tests, plus a default instance on the real home folders.

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/trace-light.test.js`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement the three modules** as specified. Before writing the Kiro parser, read the real `~/.kiro/sessions/*/*/messages.jsonl` keys (keys only, never values) to confirm the payload type names. Encode them in the fixture and in a short comment.
- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/trace-light.test.js`
Expected: PASS (the Antigravity test is skipped on Node < 22.5)

- [ ] **Step 5: Commit**

```bash
git add lib/trace/kiro.js lib/trace/gemini.js lib/trace/antigravity.js test/trace-light.test.js test/fixtures/trace/kiro test/fixtures/trace/gemini
git commit -m "Add Kiro, Gemini CLI and Antigravity to the trace explorer"
```

---

### Task 8: Registry: routing, LRU, worker offload, read limit, isolation, demo

**Files:**
- Create: `lib/trace/index.js`, `lib/trace/worker.js`
- Modify: `lib/demo.js` (add `traceDemo()`)
- Test: `test/trace-registry.test.js`

**Interfaces:**
- Consumes: the adapters from Tasks 3, 5, 6 and 7; `Indexer#entries()`; `createContent`.
- Produces:
  - `createTrace({ indexer, gateway, roots, light, demo = false, contentOff = false, cacheMax = 20, cacheBytes = 200e6, workerMinBytes = 50e6, maxReads = 4 })`. `light` is the list of Kiro, Gemini and Antigravity adapters; it defaults to the instances on the real home folders, and tests pass `light: []` so they never read the machine's own logs. It returns:
    - `sources()`: `[{ id, ok, reason, count }]`;
    - `sessions({ range, source, q, flags })`: rows sorted by `end` desc, each with an opaque `key`;
    - `title(key)`: masked, at most 80 characters;
    - `session(key, { turn })`: a skeleton whose span text refs are replaced by opaque content ids;
    - `content(contentId, { part, offset })` and `reveal(contentId, maskIndex)`;
    - `live(key, since)`.
  - An opaque key is `base64url(source + ':' + sessionId)` plus a per-process HMAC tag, so a client cannot forge keys or content ids for other files (S3).
  - Content ids are kept in a per-process map `{ id → ref }`, filled when a skeleton is built and bounded by the LRU.
- Behaviour:
  - **LRU:** evicts by count and by approximate bytes, estimated as JSON length (P2).
  - **Worker offload:** a skeleton for an entry with `size > workerMinBytes` is built in `lib/trace/worker.js` through `worker_threads`, with a fallback to the main thread on error (P2).
  - **Read limit:** at most `maxReads` concurrent skeleton builds or content reads; extra requests wait in a queue (P9).
  - **Isolation:** an adapter that throws produces `sources()[i].ok = false` with the reason, and its sessions are omitted. The rest still work (P10).
  - **`contentOff`:** `content` and `reveal` throw a 403 "content viewing is off" (S10).
  - **`demo`:** sessions, skeletons and content come from `demo.traceDemo()`, with no file access.

- [ ] **Step 1: Write the failing test**

```js
// test/trace-registry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const claudeParser = require('../lib/claude');
const { createTrace } = require('../lib/trace');

const dir = path.join(__dirname, 'fixtures', 'trace', 'claude', 'proj');
async function fakeIndexer() {
  const files = [path.join(dir, 's1.jsonl'), path.join(dir, 's1', 'subagents', 'agent-ag1.jsonl')];
  const entries = [];
  for (const file of files) entries.push({ file, source: 'claude', size: fs.statSync(file).size, result: await claudeParser.parseFile(file) });
  return { entries: () => entries };
}
const gw = { runs: () => [], run: () => null, requests: () => [] };

test('sessions get opaque keys; a forged key is refused', async () => {
  const t = createTrace({ indexer: await fakeIndexer(), gateway: gw, light: [], roots: [path.join(__dirname, 'fixtures', 'trace')] });
  const [row] = t.sessions({});
  assert.ok(row.key && !row.key.includes('/'));
  await assert.rejects(t.session(Buffer.from('claude:s1').toString('base64url')), /unknown session/);
});

test('skeleton text refs are opaque content ids, and content reads back', async () => {
  const t = createTrace({ indexer: await fakeIndexer(), gateway: gw, light: [], roots: [path.join(__dirname, 'fixtures', 'trace')] });
  const [row] = t.sessions({});
  const sk = await t.session(row.key, { turn: 0 });
  const turn = sk.spans.find((s) => s.kind === 'turn');
  assert.equal(typeof turn.text, 'string');
  assert.ok(!JSON.stringify(sk).includes(dir), 'no file paths reach the client');
  const c = await t.content(turn.text, {});
  assert.equal(c.text, 'fix the login redirect');
  assert.equal(await t.title(row.key), 'fix the login redirect');
});

test('content can be switched off', async () => {
  const t = createTrace({ indexer: await fakeIndexer(), gateway: gw, light: [], roots: [path.join(__dirname, 'fixtures', 'trace')], contentOff: true });
  const [row] = t.sessions({});
  const sk = await t.session(row.key, { turn: 0 });
  await assert.rejects(t.content(sk.spans[1].text, {}), /content viewing is off/);
});

test('a failing adapter is isolated', async () => {
  const t = createTrace({ indexer: { entries: () => { throw new Error('boom'); } }, gateway: gw, light: [], roots: [] });
  const src = t.sources();
  assert.equal(src.find((s) => s.id === 'claude').ok, false);
  assert.ok(Array.isArray(t.sessions({})));
});

test('demo mode serves synthetic sessions without files', async () => {
  const t = createTrace({ demo: true });
  const rows = t.sessions({});
  assert.ok(rows.length >= 3);
  const sk = await t.session(rows[0].key, {});
  assert.ok(sk.spans.length > 3);
});
```

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/trace-registry.test.js`
Expected: FAIL, `Cannot find module '../lib/trace'`

- [ ] **Step 3: Implement `lib/trace/index.js` and `lib/trace/worker.js`**
  - **Keys:** `const SECRET = crypto.randomBytes(16)`. `key = base64url(`${source}:${sid}`) + '.' + hmac(SECRET, source + ':' + sid).slice(0, 12)`. Verify with `crypto.timingSafeEqual`.
  - **Content ids:** `ci_` + 16 random hex, stored in a `Map` cleared alongside LRU evictions.
  - **LRU:** a `Map` re-inserted on access; evict while `size > cacheMax || bytes > cacheBytes`.
  - **Queue:** a counter plus a FIFO array of resolvers.
  - **Worker:** `new Worker(path.join(__dirname, 'worker.js'), { workerData: { adapter: 'claude' | 'codex', entry, sid, turn, siblings } })`. The worker requires the adapter and posts the skeleton back. On error or exit, build in-thread instead.
  - **Titles:** `content.read({ ...firstTurnPromptRef }, { max: 400 })`, collapsed to one line, sliced to 80 characters and masked. Cached in a small `Map` keyed by session key and file `mtimeMs`.
- [ ] **Step 4: Add `traceDemo()` to `lib/demo.js`.** It returns `{ sessions: [...], skeletons: { [sid]: { session, turns, spans } }, content: { [refId]: text } }` for 3 synthetic sessions (Claude Code with a subagent and one failed Bash, Codex, Kiro), using the same names as the approved mockup (fix auth redirect, tokoku-api pagination, spec: billing). Export it.
- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/trace-registry.test.js`
Expected: PASS

- [ ] **Step 6: Performance check (P1, P2)**
  - Add `test/trace-perf.test.js`, which generates a 300 MB synthetic Claude session in `os.tmpdir()`: 20,000 lines across 200 turns, with large tool results.
  - It asserts that a last-turn skeleton builds in under 3 s, and that a `content` page returns in under 100 ms.
  - Skip the test unless `ZAAFPULSE_PERF=1`, and document that in `docs/performance.md`.
- [ ] **Step 7: Commit**

```bash
git add lib/trace/index.js lib/trace/worker.js lib/demo.js test/trace-registry.test.js test/trace-perf.test.js docs/performance.md
git commit -m "Trace registry: opaque keys, LRU cache, worker offload, read limit, isolation and demo data"
```

---

### Task 9: HTTP API

**Files:**
- Modify: `server.js`. Create the registry next to the indexer, then add the routes before the `/api/logs` route:
  - `const trace = createTrace({ indexer, gateway: gateway.trace, roots, demo: DEMO, contentOff })`;
  - `roots`: `[claude ROOT, codex ROOT, platform.dataDir()]`;
  - `contentOff = process.env.ZAAFPULSE_CONTENT === 'off' || (SERVER_MODE && process.env.ZAAFPULSE_CONTENT !== 'on')`.
- Test: `test/trace-api.test.js` (spawns `server.js` in demo mode on a random free port, like the existing server tests in `test/security.test.js`)

**Interfaces:**

| Route | Handler |
|---|---|
| `GET /api/trace/sources` | `trace.sources()` |
| `GET /api/trace/sessions?range=7&source=&q=&flags=errors` | `{ sessions: trace.sessions(...) }` (`range` in days, 1–30) |
| `GET /api/trace/session?key=&turn=` | `trace.session(key, { turn })` |
| `GET /api/trace/title?key=` | `{ title }` |
| `GET /api/trace/content?id=&offset=` | `trace.content(id, { offset })` |
| `POST /api/trace/reveal` `{ id, index }` | `trace.reveal(id, index)` (JSON body, CSRF-safe like the other POSTs) |
| `GET /api/trace/live?key=&since=` | `trace.live(key, since)` |

- Errors carry `err.status` (400, 403 or 404) with `{ error: message }`.
- The routes sit behind the existing `auth.check`, so gateway keys cannot reach them.

- [ ] **Step 1: Write the failing test.** Cover the following:
  - the demo server is up;
  - `/api/trace/sessions` returns ≥3 rows with keys;
  - `/api/trace/session` returns spans;
  - `/api/trace/content` returns text;
  - a forged key gives 404;
  - a session request without a key gives 400;
  - with `ZAAFPULSE_CONTENT=off`, content gives 403;
  - with a gateway API key (`Authorization: Bearer …`) and no dashboard cookie in server mode, `/api/trace/sessions` gives 401.

  Reuse the helpers that spawn the server and wait for the port from `test/security.test.js`, and copy the pattern exactly.
- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/trace-api.test.js`
Expected: FAIL (404 on `/api/trace/sessions`)

- [ ] **Step 3: Implement the routes in `server.js`**, using the existing `send(res, status, body)`. Keep them before `/api/logs`, and mirror the style of `/api/timeline`.
- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/trace-api.test.js test/security.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.js test/trace-api.test.js
git commit -m "Serve the trace explorer over /api/trace behind the dashboard sign-in"
```

---

### Task 10: The split-view page

**Files:**
- Create: `public/traceview.js` (view and mount), with styles appended to `public/styles.css` under a `/* trace explorer */` section
- Modify:
  - `public/index.html`: add the nav link `<a href="#trace" data-route="trace"><span data-icon="list"></span>Trace explorer</a>` directly after the Sessions link, and `<script src="traceview.js"></script>` before `app.js`;
  - `public/app.js`: `VIEWS.trace = viewTrace`; `TITLES.trace = 'TRACE EXPLORER'`; in `render()`, add `if (state.route === 'trace') mountTrace();` next to `mountSessions()`, and add `'trace'` to the list of routes that render without `state.data`;
  - `public/workviews.js`: each session row links to `#trace?s=<id>&src=<tool>`;
  - `public/officeview.js`: the agent card links to the trace.
- Test: `test/trace-ui.test.js` (DOM-free unit tests of pure render helpers exported from `traceview.js` through `module.exports` when `typeof module !== 'undefined'`), plus a headless screenshot check in Step 6.

**Interfaces:**
- Consumes: the `/api/trace/*` routes (Task 9).
- Produces these browser globals:
  - `viewTrace()`: returns the page HTML skeleton (two halves, empty);
  - `mountTrace()`: fetches the data, wires the events, draws the map, and registers cleanup with `onUnmount`.
- Produces these pure helpers, unit-tested:
  - `treeRows(spans)`: rows `{ id, depth, kind, name, start, end, status, badges }` in display order, with collapsed state;
  - `mapNodes(spans)`: the ordered nodes for the map, with repeated identical tool calls folded into one node with a count;
  - `textNodes(text, masked)`: returns DOM-free parts `[{ text, masked: label | null }]`, which the view turns into `textContent` spans (S1).

**Layout:** port `docs/superpowers/specs/mockups/split-view-v4.html`, keeping its markup classes, sizes and behaviour:
- **Sessions column:** 264 px, collapsing to 64 px. Contents: a search box, a horizontally scrolled source chip row, day groups, and 32 px source icons. Each row's top line holds the title and time, then a meta line, then flags.
- **Tree:** columns Span, Timeline and Time; 34 px rows with indentation guides; collapsible nodes.
- **Detail panel:** fixed height, `clamp(230px, 32vh, 300px)`. Tabs Output, Input, Evals and Notes. Evals and Notes are hidden until sub-project 2. Actions are grouped:
  - left: Good, Bad and Add note, hidden until sub-project 2;
  - right: Add to dataset and Replay turn, hidden until sub-project 4, and Pause agent, hidden until sub-project 3.
- **Splitter:** draggable between 38% and 70%, stored in `localStorage` through try/catch.
- **Map:** the holo map with flowing dashes, a travelling packet, pulsing rings and flickering error nodes, all stopped under `prefers-reduced-motion`. A turn stepper and a legend.
- **Selection:** one model shared by both halves.
- **Keyboard:** `j`/`k` move between spans, `←`/`→` change turn, `Enter` focuses the detail.
- **Narrow screens:** below 1100 px the halves stack.

**Security:**
- Content is rendered only with `textContent` through `textNodes()` (S1).
- A masked item renders a "show" button that calls `POST /api/trace/reveal` and replaces only that span's `textContent`. The value is never stored (S2).
- When content is off (403), the panel shows "Content viewing is off (ZAAFPULSE_CONTENT)".

**Steps**
- [ ] **Step 1: Write the failing unit tests.** Cover the following:
  - `treeRows` gives depth and order for the Claude fixture skeleton from the demo data;
  - `mapNodes` folds 5 identical `Read` calls into one node with `count: 5`;
  - `textNodes('a ‹api key hidden› b', [{ start: 2, end: 18, label: 'api key' }])` gives three parts, the middle one masked;
  - an `innerHTML` audit: `traceview.js` source contains no `innerHTML =` assignment that uses a variable named `text`, `content` or `value`. This is a regex check over the file, which guards S1.
- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test test/trace-ui.test.js`
Expected: FAIL (`traceview.js` missing)

- [ ] **Step 3: Implement `public/traceview.js` and the CSS**, porting the mockup. Use `api()`, `esc()`, `$`/`$$` and `onUnmount` from the existing files. Poll `/api/trace/live` every 5 s while the selected session is running, and clear the poll in `onUnmount`.
- [ ] **Step 4: Wire the route, nav and links** (`index.html`, `app.js`, `workviews.js`, `officeview.js`).
- [ ] **Step 5: Run the unit tests and the full suite**

Run: `node --test test/trace-ui.test.js && ZAAFPULSE_DATA=$(mktemp -d) HOME=$(mktemp -d) node --test test/*.test.js`
Expected: all PASS

- [ ] **Step 6: Visual check in demo mode.** Start `node bin/zaafpulse.js start --demo --port 4930 --data $(mktemp -d)`, then take headless Chrome screenshots of `http://localhost:4930/#trace` at 1512×945 and at 390×844.
  - Compare against the mockup: the sessions column has margins and no overflow; the action row is visible; the map draws its connectors.
  - Check the reduced-motion screenshot (`--force-prefers-reduced-motion`) shows no animation.
  - Kill the server afterwards.
- [ ] **Step 7: Commit**

```bash
git add public/traceview.js public/styles.css public/index.html public/app.js public/workviews.js public/officeview.js test/trace-ui.test.js
git commit -m "Trace explorer page: split view with the trace tree and the animated session map"
```

---

### Task 11: Docs, MCP tool and final verification

**Files:**
- Create: `docs/explorer.md`. It covers what each source shows, the depth table, privacy (text read on demand, never copied; masking; `ZAAFPULSE_CONTENT`; off by default in server mode), keyboard shortcuts, and the performance numbers from Task 8.
- Modify: `README.md`. Add a "Trace & Session Explorer" section with one screenshot taken in demo mode, linking `docs/explorer.md`. Add the routes to the HTTP API table. Add `lib/trace/` to the project structure.
- Modify: `lib/connectors/acc.js`. Add a read-only `acc_trace_sessions` tool that returns the latest 50 sessions (key, source, title, cost, flags) through the registry. It returns no content, so MCP clients cannot pull transcript text (S6 spirit). Add a test in `test/mcp.test.js`.

- [ ] **Step 1: Write the `acc_trace_sessions` test.** It lists the tool, and the result has no `text` fields.
- [ ] **Step 2: Implement the tool.** Pass the registry in through `createLocal` the same way `integrationsStatus` is wired.
- [ ] **Step 3: Write the docs and the README section.**
- [ ] **Step 4: Run the full suite twice**

Run: `ZAAFPULSE_DATA=$(mktemp -d) HOME=$(mktemp -d) node --test test/*.test.js` (twice)
Expected: all PASS both times

- [ ] **Step 5: Commit**

```bash
git add docs/explorer.md README.md lib/connectors/acc.js test/mcp.test.js
git commit -m "Document the trace explorer and list its sessions over MCP"
```

---

## Self-review

**Spec coverage**

| Spec item | Task |
|---|---|
| Sources and depth | 3, 5, 6, 7 |
| Span model | 3 |
| Index additions | 2 |
| Adapters | 3, 5, 6, 7 |
| Registry (LRU, worker, read limit, isolation) | 8 |
| Content and masking | 4 |
| API | 9 |
| UI | 10 |
| Demo | 8, 10 |
| Error handling | 3 (unreadable line), 4 (range), 8 (isolation) |
| Testing (fixtures, security, performance) | 2–10 |
| Docs | 11 |

**Refinements of the spec (already folded into the spec in the same commit)**

1. The session **title** is read on demand from the first turn, masked and cached in memory, instead of being stored in the index. This keeps the index free of text.
2. **Turn offsets** are stored as `[start, ts]`; a turn ends where the next one starts or at the file size.
3. **Adapters** expose `sessions(entries)` and `skeleton(...)`. Content reading is shared in `lib/trace/content.js` instead of a `content()` per adapter, so masking and path checks live in one place.
4. **API ids travel as query parameters** (`?key=`, `?id=`), not path segments. Session keys and content ids are opaque, HMAC-tagged per process, and "show" is `POST /api/trace/reveal`.
5. A read-only **MCP tool** `acc_trace_sessions` was added (metadata only).

**Verification points carried from the spec, done at the start of their task:**
- Claude `tool-results/` marker format (Task 4);
- Kiro payload type names (Task 7);
- Gemini chat format (Task 7, synthetic).
