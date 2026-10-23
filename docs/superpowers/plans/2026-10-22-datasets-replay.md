# Datasets, Replay & the CI Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn real failures into regression checks:
- save agent turns that went wrong into local **datasets**;
- **replay** them against other models, text only, through the gateway;
- score the results with the **same evaluators** and keep an experiment record;
- **fail a CI step** (`zaafpulse eval --dataset … --ci`) when quality drops.

**Architecture:**
- **Datasets.** `lib/datasets/shape.js` validates, masks and caps one example; `lib/datasets/store.js` keeps one JSONL file per dataset in `.data/datasets/` plus a small `index.json` of names and counts. Examples are built server-side from a trace turn by a new registry method, `trace.example(key, turn, span?)` (`lib/trace/index.js`), which reads text only through the masked content reader.
- **Replay.** A new gateway accessor, `gateway.replay`, sends one non-streaming request per example and model through the gateway's own `llm()` (usage, cost and OTLP export apply). Tools are *declared* and never executed. `lib/datasets/replay.js` runs an experiment with per-run cost and request caps, external-provider masking and a preview token.
- **Scoring.** `lib/datasets/score.js` scores each output with code evaluators (`reference_match`, `secret_leak`, `risky_command`) and judge evaluators. Judge calls go through a new `engine.judgeMaterial()` in `lib/evals/engine.js`, which shares the judge queue's single lane (concurrency 1), its daily and cost caps, and its external-preview gate. Records go to `.data/experiments.jsonl` (`lib/datasets/experiments.js`).
- **Surfaces.** `lib/datasets/api.js` serves `/api/datasets*` and `/api/experiments*` behind the dashboard sign-in. `public/datasetview.js` is the new `#datasets` view (plus the Explorer's "Add to dataset" and the Playground's Dataset mode). `lib/datasets/cli.js` is the headless CI gate.

**Tech stack:** Node ≥18 standard library only, `node:test`, plain browser JS/CSS.

**Spec:** `docs/superpowers/specs/2026-10-20-datasets-replay-design.md`. Shared rules S1–S11 and P1–P10: `docs/superpowers/specs/2026-10-20-ai-observability-overview.md`. Builds on sub-project 1 (`lib/trace/*`, `public/traceview.js`, `docs/explorer.md`) and sub-project 2 (`lib/evals/*`, `public/evalsview.js`, `docs/evals.md`).

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18. `node:test`. The full suite stays green on Ubuntu, macOS and Windows CI.
- **Example shape (verbatim).** Each example is a JSON line in `.data/datasets/<slug>.jsonl` (mode 0600): `{ id, createdAt, updatedAt, source: { source, session, turn, span? }, input: { system?, messages: [ { role, text } ], tools?: [ { name, description } ] }, output: { text, model }, reference?: { text }, tags?: [], evals?: { <evaluator>: label }, feedback?: 'good' | 'bad' }`.
- **Masking (S2).** "Every text field is masked with `scanSecrets` on save." In code this is the trace masker: `sig.secretSpans()` (the same patterns and placeholder checks as `scanSecrets`) replaced by `‹<label> hidden›`. Datasets are the only place a copy of transcript text is kept, and only because the owner saved it.
- **Limits (verbatim).** "1,000 examples per dataset, 64 KB per text field (longer text keeps its head and tail with a marker), and 100 datasets." 64 KB is 65,536 characters; the marker is `[… trimmed …]` (`MARK` from `lib/evals/judge.js`).
- **Text only (S1).** Transcript text, outputs, references, tags and preview text render as text only (`textContent` / `esc()`); no markdown-to-HTML; no `innerHTML` built from content. CSP stays `script-src 'self'`.
- **Replay rules (S8, verbatim).** "The recorded messages are sent with the tools *declared* but never executed. A tool call the model proposes is shown as a proposal, and the run stops at that point for that example." "Cost and request caps apply, defaulting to $0.50 and 100 requests. A run stops cleanly when a cap is hit." "Requests go through the gateway, so usage, cost, OTLP export and key budgets apply as for any request."
- **External providers (S4).** "External providers follow the same rule as the judge (S4): explicit choice, a preview, and masking." Local models come first (Ollama, LM Studio).
- **Experiment record (verbatim fields).** `.data/experiments.jsonl`: `{ id, dataset, models, evaluators, startedAt, endedAt, perExample: [ { exampleId, model, label/score per evaluator, cost, ms } ], summary }`. "Outputs are kept only inside the record, masked, and capped."
- **CI gate exit codes (verbatim).** "`--ci` exits 1 when any requirement fails, 2 on configuration errors (unknown dataset, judge unavailable when a judge evaluator is required), and 0 otherwise." `--data` is honoured. `--json` writes a machine-readable report.
- **API.** Every route needs the dashboard session (never a gateway API key, MCP tool or A2A). Opaque trace keys in, no file path out (S3). State changes need JSON (415 otherwise), like `/api/evals`.
- **Content off (S10).** With `ZAAFPULSE_CONTENT=off` (and by default in server mode) no transcript-derived text leaves an API response (see Rules R7).
- **Stores (S11).** `.data/datasets/` (folder 0700, files 0600) and `.data/experiments.jsonl` (0600) with caps. On Windows, skip mode assertions in tests.
- **Demo mode.** `--demo` ships synthetic datasets and experiments; no network, no real files.
- **Process.** Prettier style by hand (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always) and short "why" comments. Commits are authored as configured, with **no `Co-Authored-By`, no "Generated with", no AI attribution** of any kind.
- **Shared files with sub-project 3.** Sub-project 3 (branch `feat/monitors`) is in flight and touches `public/app.js`, `lib/demo.js`, `server.js`, `README.md` (and adds `lib/monitors/*`, `lib/agents/control.js`, `public/monitorsview.js`). Edits to those four files in this plan are **small and additive**: new lines in their own block, new entries appended to maps and export lists, no reformatting or reordering of existing lines, so the later rebase is mechanical.

## Rules and values

**R1. Limits** (`LIMITS` in `lib/datasets/shape.js`; tests may pass smaller ones):

| Key | Value | Meaning |
|---|---|---|
| `examples` | 1000 | examples per dataset |
| `datasets` | 100 | datasets in the folder |
| `field` | 65536 | characters per text field (head + tail with `MARK` when longer) |
| `messages` | 50 | messages per example (at least one `user`) |
| `tools` | 100 | declared tools per example |
| `tags` | 20 | tags per example; each `^[\p{L}\p{N}_.:-]{1,40}$` (unicode) |
| `toolName` | 200 | characters of a tool or message `name` |
| `name` | 80 | characters of a dataset display name |
| `exampleBytes` | 1048576 | serialized size of one example |
| `importBytes` | 16777216 | request body of `POST /api/datasets/import` |
| `addItems` | 50 | items in one `POST /api/datasets/:slug/examples` |

Slugs match `^[a-z0-9][a-z0-9-]{0,63}$`; `import` and `settings` are reserved. A slug is fixed at creation; `PUT` changes the display name only.

**R2. Example roles.** `system | user | assistant | tool`. A `tool` message may carry `name` (≤200). `input.system` is a string or `null`. `output.model` is a string or `null`. `reference` is `{ text }` or `null`. `feedback` is `'good' | 'bad' | null`. `evals` maps a registry evaluator id to one of its labels. `source` is `{ source, session, turn, span }` or `null` (imported examples may have none).

**R3. Example from a trace turn** (`trace.example`): `messages` = the turn prompt as `{ role: 'user', text }` (head + tail at 65,536), then the **last 10** tool results of the turn as `{ role: 'tool', name, text }` (head + tail at 8,000 each, in call order); `tools` = the distinct tool names called in the turn as `{ name, description: '' }` (at most 100); `output.text` = the turn's answer span (head + tail at 65,536); `output.model` = the model of the turn's last `chat` span that has one, else `null`. Gateway runs: the prompt is the run task (masked), no tool messages.

**R4. Sending an example** (`toMessages`): `system` → `{ role: 'system', content }`; `user`/`assistant` → same role; `tool` → `{ role: 'user', content: '[tool result: <name>]\n<text>' }` (there is no `tool_call_id` to pair it with). Tools are declared as `{ type: 'function', function: { name, description, parameters: { type: 'object', properties: {}, additionalProperties: true } } }`; names that do not match `^[A-Za-z0-9_-]{1,64}$` are left out. For an **external** model every `content` also goes through `maskPii` (`lib/evals/pii.js`).

**R5. Models for replay.** Only `provider/model` names of a usable gateway provider. Aliases and routes (`router/…`, or any name `providers.routes()` lists) are refused, since their real target is not known up front. The tier is the provider's (`private` or `external`); a model part matching `/(^|[:-])cloud$/i` counts as `external`. Embedding and rerank models (`/embed|rerank/i`) are not listed. Order: private providers with preset `ollama`, then `lmstudio`, then other private, then external; within a provider, the gateway's model order. An external model must have a known list price (`usage.hasPrice`), or the run is refused (the cost cap could not count it).

**R6. Experiment evaluators** (`EXPERIMENT_EVALUATORS` in `lib/datasets/score.js`; pass label first):

| id | kind | labels | how |
|---|---|---|---|
| `reference_match` | code | `match`, `no_match` | only when the example has a reference: `normalize(out) === normalize(ref)` or `normalize(out).includes(normalize(ref))`; `normalize` = NFKC, lower case, whitespace collapsed, trimmed |
| `secret_leak` | code | registry labels | `sig.scanSecrets(rawText + '\n' + (proposal ? proposal.arguments : ''))` non-empty → `leaked` |
| `risky_command` | code | registry labels | a proposal whose JSON arguments hold a string `command` or `cmd`: `sig.scanRisky(cmd)` non-empty → `risky`; else `safe` |
| `faithfulness`, `task_completion`, `tool_selection`, `relevance` | judge | registry labels | `engine.judgeMaterial(id, material)` |

`user_frustration` (session scope) and the log-signal code evaluators do not apply to a replay output. `reference_match` is **not** added to `lib/evals/registry.js`, because every registry code evaluator is emitted for every turn of every session.

**R7. Content off.** Dataset and experiment responses return every text (`input.system`, `messages[].text`, `output.text`, `reference.text`, result `output.text`, `proposal.arguments`) as `null`. `POST /api/datasets/:slug/examples`, `GET …/export` and the experiment preview return 403 `content viewing is off`. Auto-add does nothing. Import, edits of tags, deletes and runs are allowed (the copy is the owner's own).

**R8. Run caps.** Defaults `maxCostUSD: 0.5`, `maxRequests: 100`; accepted `0 < maxCostUSD ≤ 10`, `1 ≤ maxRequests ≤ 1000` (whole number). The caps count **replay** requests and their cost; judge calls fall under the eval engine's daily and cost caps (P6). Before each replay call: `signal.aborted` → stop `cancelled`; `requests >= maxRequests` → stop `request cap`; `cost >= maxCostUSD` → stop `cost cap`. A call is never interrupted, so the cost can pass the cap by one call. One experiment runs at a time per server (409).

**R9. Summary maths.** Per model and evaluator: `pass` = rows whose label is the pass label; `total` = every attempted row of that model (an errored replay or a missing verdict counts as not passing), except `reference_match`, whose `total` counts only rows of examples that have a reference; `rate = total ? pass / total : null`. Per model also `requests`, `cost`, `ms` (mean of answered rows), `errors`, `proposals`. Original outputs are shown, not scored.

**R10. Stored output cap.** A result's `output.text` and `proposal.arguments` are masked and capped at 4,000 characters (head + tail). `experiments.jsonl` keeps the newest 100 records. A stored record is bounded at 2 MB: over that, texts shorten to 1,000 then 250 characters, then go, and results are dropped from the end last; the record then carries trimmed: { textChars, droppedResults? }.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/datasets/shape.js` | create | limits, masking, head+tail cap, slugs, example validation |
| `lib/datasets/store.js` | create | `.data/datasets/` store: index, examples, add/edit/delete, import/export |
| `lib/evals/store.js` | modify | export the existing `openJsonl` |
| `lib/trace/index.js` | modify | `example(key, turn, span?)`, `sealSpan(rawId)` |
| `lib/datasets/score.js` | create | experiment evaluators, `reference_match`, code labels, judge material, summary |
| `lib/datasets/experiments.js` | create | `.data/experiments.jsonl` store |
| `lib/evals/engine.js` | modify | `judgeMaterial()`, a shared model-call lane, `onResult` option |
| `lib/gateway/index.js` | modify | `replay` accessor: `models`, `tierOf`, `priced`, `complete` |
| `lib/datasets/replay.js` | create | messages/tools for a send, preview, confirm token, the runner |
| `lib/datasets/api.js` | create | `/api/datasets*`, `/api/experiments*` |
| `lib/datasets/auto.js` | create | the optional auto-add rule |
| `lib/evals/api.js` | modify | `onFeedback` option |
| `server.js` | modify | wiring block, `readBody(req, max)`, `send(..., hit.type)` |
| `lib/demo.js` | modify | `datasetsDemo()` |
| `public/datasetview.js`, `public/index.html`, `public/app.js`, `public/styles.css` | create/modify | `#datasets` view |
| `public/traceview.js` | modify | "Add to dataset", multi-select, "Replay turn", `&turn=` deep link |
| `public/gatewayview.js` | modify | Playground "Dataset" mode (delegates to `datasetview.js`) |
| `lib/datasets/cli.js`, `lib/evals/cli.js`, `bin/zaafpulse.js` | create/modify | `zaafpulse eval --dataset … --ci` |
| `docs/datasets.md`, `README.md` | create/modify | docs and CI recipes |
| `test/datasets-*.test.js` | create | tests |

---

### Task 1: Example shape and the dataset store

**Files:**
- Create: `lib/datasets/shape.js`, `lib/datasets/store.js`
- Modify: `lib/evals/store.js` (last line: `module.exports = { createEvalStore, createFeedbackStore, openJsonl };`)
- Test: `test/datasets-store.test.js`

**Interfaces:**
- Consumes: `openJsonl(file, { readOnly })` from `lib/evals/store.js` → `{ size(), read() → { rows, bad }, append(row), rewrite(rows) }` (creates the folder 0700 and files 0600, rewrites via temp file + rename). `sig.secretSpans(text)` from `lib/signals.js` → `[{ start, end, label }]`. `MARK` from `lib/evals/judge.js`.
- Produces from `shape.js`:
  - `LIMITS` (R1), `ROLES = ['system', 'user', 'assistant', 'tool']`, `MARK`, `RESERVED = new Set(['import', 'settings'])`.
  - `maskText(text) → string`.
  - `capField(text, max = LIMITS.field) → string`.
  - `slugify(name) → string | null`; `validSlug(slug) → boolean` (shape and not reserved).
  - `sourceKey(source) → string | null`: `${source}|${session}|${turn}` or null when `source` is null.
  - `cleanExample(raw, { strict = false, now = Date.now, limits = LIMITS } = {}) → { ok: true, example } | { ok: false, reason }`. Non-strict (server-built examples): masks, then caps over-long text with `capField`. Strict (import): a text field longer than `limits.field` **before** masking is rejected with `reason: '<path> is longer than 64 KB'` (for example `input.messages[2].text`); everything is still masked. Both: unknown roles, a missing user message, more than `limits.messages` messages, more than `limits.tools` tools, a bad tag, an unknown evaluator or label in `evals`, a bad `feedback`, or a serialized size over `limits.exampleBytes` are rejected. A valid `id` (`^ex_[0-9a-f]{16}$`) and finite `createdAt`/`updatedAt` are kept; otherwise a new id and `now()`.
- Produces from `store.js`: `createDatasetStore({ dir, now = Date.now, limits = LIMITS })` returning:
  - `list() → [{ slug, name, count, createdAt, updatedAt }]` sorted by `updatedAt` descending;
  - `get(slug) → meta | null`;
  - `create({ name, slug }) → meta`. `slug` defaults to `slugify(name)`. 400 bad name (empty or over 80) or slug; 409 slug exists; 400 `at most 100 datasets`;
  - `rename(slug, name) → meta`; `remove(slug) → boolean` (deletes the file and the index entry);
  - `examples(slug) → [example]` (404 unknown);
  - `add(slug, raws, { strict = false } = {}) → { added: [example], skipped: [{ index, reason }] }`. Skips `already in this dataset` (same `sourceKey`), `dataset is full (1,000 examples)` and invalid ones (`reason` from `cleanExample`);
  - `update(slug, id, { reference, tags }) → example`. `reference`: a string sets `{ text }` (masked, capped), `null` or `''` removes it, `undefined` keeps it. `tags`: an array replaces them (validated, deduplicated). 404 unknown id; 400 invalid;
  - `removeExample(slug, id) → boolean`;
  - `exportJsonl(slug) → string` (one example per line, `\n` after each);
  - `importJsonl({ slug, name, jsonl }) → { dataset: meta, added: n }`. **Atomic:** every non-blank line is parsed and checked with `cleanExample(…, { strict: true })`; if any line fails, or the result would pass 1,000 examples, nothing is written and it throws 400 with `reasons: ['line N: …']` (at most 20). A new `slug` is created (with `name`, default the slug); an existing one is appended to, giving a new id to any id it already holds;
  - `hasSource(slug, source) → boolean`.
- Errors are `Object.assign(new Error(message), { status, reasons? })`; messages never contain a path.
- Files: the store creates `dir` with mode 0700 (and chmods it, POSIX only) on its first write. `<dir>/index.json` = `{ version: 1, datasets: [{ slug, name, createdAt, updatedAt, count }] }` (written 0600 through temp + rename) and `<dir>/<slug>.jsonl` (through `openJsonl`). `add` appends; `update`, `removeExample` and an import into an existing dataset rewrite. The index `count` and `updatedAt` change with every write.

```js
// lib/datasets/shape.js (the helpers whose exact behaviour the tests pin)
const sig = require('../signals');
const { MARK } = require('../evals/judge');

function maskText(text) {
  const s = String(text ?? '');
  let out = '';
  let last = 0;
  for (const sp of sig.secretSpans(s)) {
    out += s.slice(last, sp.start) + `‹${sp.label} hidden›`;
    last = sp.end;
  }
  return out + s.slice(last);
}

// Head and tail around a marker, never cutting a surrogate pair in half.
function capField(text, max = LIMITS.field) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const gap = `\n${MARK}\n`;
  const half = Math.floor((max - gap.length) / 2);
  let head = s.slice(0, half);
  let tail = s.slice(s.length - half);
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  if (/^[\udc00-\udfff]/.test(tail)) tail = tail.slice(1);
  return head + gap + tail;
}

function slugify(name) {
  const s = String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return s && validSlug(s) ? s : null;
}
```

- [ ] **Step 1: Write the failing test**

```js
// test/datasets-store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatasetStore } = require('../lib/datasets/store');
const { LIMITS, MARK, capField, slugify, cleanExample } = require('../lib/datasets/shape');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-ds-'));
// Built at runtime so no live-looking key sits in the source.
const secret = () =>
  'sk-' + 'ant-api03-' + Array.from({ length: 48 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7) % 36]).join('');
const ex = (over = {}) => ({
  source: { source: 'claude', session: 's1', turn: 0, span: null },
  input: { system: null, messages: [{ role: 'user', text: 'fix the login redirect' }], tools: [{ name: 'Read', description: '' }] },
  output: { text: 'Changed the redirect.', model: 'claude-opus-5-5' },
  ...over,
});

test('every text field is masked on save', () => {
  const dir = tmp();
  const s = createDatasetStore({ dir });
  s.create({ name: 'Auth regressions' });
  const k = secret();
  const { added } = s.add('auth-regressions', [
    ex({
      input: {
        system: `key ${k}`,
        messages: [
          { role: 'user', text: `use ${k}` },
          { role: 'tool', name: 'Bash', text: `KEY=${k}` },
        ],
        tools: [{ name: 'Bash', description: `takes ${k}` }],
      },
      output: { text: `done ${k}`, model: null },
      reference: { text: k },
    }),
  ]);
  assert.equal(added.length, 1);
  const raw = fs.readFileSync(path.join(dir, 'auth-regressions.jsonl'), 'utf8');
  assert.ok(!raw.includes(k), 'no live secret on disk');
  assert.match(s.examples('auth-regressions')[0].output.text, /hidden/);
});

test('caps: examples per dataset, field size and number of datasets', () => {
  const s = createDatasetStore({ dir: tmp(), limits: { ...LIMITS, examples: 2, datasets: 2 } });
  s.create({ name: 'a' });
  s.create({ name: 'b' });
  assert.throws(() => s.create({ name: 'c' }), (e) => e.status === 400 && /at most/.test(e.message));
  const src = (turn) => ({ source: 'claude', session: 's1', turn, span: null });
  const r = s.add('a', [ex({ source: src(0) }), ex({ source: src(1) }), ex({ source: src(2) })]);
  assert.equal(r.added.length, 2);
  assert.match(r.skipped[0].reason, /full/);
  const long = 'a'.repeat(40000) + 'z'.repeat(40000);
  const capped = capField(long);
  assert.ok(capped.length <= LIMITS.field);
  assert.ok(capped.startsWith('aaa') && capped.endsWith('zzz') && capped.includes(MARK));
  assert.equal(cleanExample(ex({ output: { text: long, model: null } })).example.output.text, capped);
});

test('the same source is not added twice', () => {
  const s = createDatasetStore({ dir: tmp() });
  s.create({ name: 'a' });
  s.add('a', [ex()]);
  assert.match(s.add('a', [ex()]).skipped[0].reason, /already/);
});

test('import rejects malformed or oversize lines and writes nothing', () => {
  const s = createDatasetStore({ dir: tmp() });
  const good = JSON.stringify(ex());
  assert.throws(
    () => s.importJsonl({ slug: 'x', jsonl: `${good}\n{not json\n` }),
    (e) => e.status === 400 && /^line 2:/.test(e.reasons[0]),
  );
  const big = JSON.stringify(ex({ output: { text: 'a'.repeat(LIMITS.field + 1), model: null } }));
  assert.throws(() => s.importJsonl({ slug: 'x', jsonl: big }), (e) => /longer than 64 KB/.test(e.reasons[0]));
  const role = JSON.stringify(ex({ input: { messages: [{ role: 'boss', text: 'hi' }] } }));
  assert.throws(() => s.importJsonl({ slug: 'x', jsonl: role }), (e) => e.status === 400);
  assert.equal(s.get('x'), null, 'a rejected import creates no dataset');
});

test('export then import round-trips every field', () => {
  const s = createDatasetStore({ dir: tmp() });
  s.create({ name: 'a' });
  s.add('a', [ex({ reference: { text: 'expected' }, tags: ['auth', 'p1'], evals: { relevance: 'partly' }, feedback: 'bad' })]);
  const r = s.importJsonl({ slug: 'b', name: 'Copy', jsonl: s.exportJsonl('a') });
  assert.equal(r.added, 1);
  assert.deepEqual(s.examples('b'), s.examples('a'));
  assert.equal(s.get('b').name, 'Copy');
});

test('slugs, rename, edit, delete', () => {
  const s = createDatasetStore({ dir: tmp() });
  assert.equal(slugify('  ÄB c!! '), 'ab-c');
  assert.equal(s.create({ name: 'Auth regressions' }).slug, 'auth-regressions');
  assert.throws(() => s.create({ name: 'Auth regressions' }), (e) => e.status === 409);
  assert.throws(() => s.create({ name: 'x', slug: 'import' }), (e) => e.status === 400);
  assert.equal(s.rename('auth-regressions', 'Auth').name, 'Auth');
  const [e] = s.add('auth-regressions', [ex()]).added;
  const k = secret();
  assert.match(s.update('auth-regressions', e.id, { reference: `ref ${k}` }).reference.text, /hidden/);
  assert.deepEqual(s.update('auth-regressions', e.id, { tags: ['a', 'a', 'b'] }).tags, ['a', 'b']);
  assert.throws(() => s.update('auth-regressions', e.id, { tags: ['no spaces'] }), (x) => x.status === 400);
  assert.equal(s.update('auth-regressions', e.id, { reference: null }).reference, null);
  assert.equal(s.removeExample('auth-regressions', e.id), true);
  assert.equal(s.list()[0].count, 0);
  assert.equal(s.remove('auth-regressions'), true);
  assert.deepEqual(s.list(), []);
});

test('files are private (POSIX)', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp(), 'datasets');
  const s = createDatasetStore({ dir });
  s.create({ name: 'a' });
  s.add('a', [ex()]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'a.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'index.json')).mode & 0o777, 0o600);
});
```

- [ ] **Step 2: Run it and see it fail.** `node --test test/datasets-store.test.js` → FAIL (`Cannot find module '../lib/datasets/store'`).
- [ ] **Step 3: Implement `shape.js` and `store.js`** with the interfaces above, and export `openJsonl` from `lib/evals/store.js`. `cleanExample` builds a new object field by field (never spreads `raw`), so unknown keys are dropped.
- [ ] **Step 4: Run it and see it pass**, then `node --test test/evals-store.test.js` (unchanged behaviour).
- [ ] **Step 5: Commit** with the message "Add the dataset store with masking, caps and JSONL import and export".

---

### Task 2: Build an example from a trace turn

**Files:**
- Modify: `lib/trace/index.js`
- Test: `test/trace-registry.test.js` (add cases; reuse its `make()`, `tmpClaude()`, `U()`, `A()`, `secret()` helpers)

**Interfaces:**
- Consumes: the registry internals `lookup(key)`, `build(info, turn, entry)`, `limited(fn)`, `content.read(ref, { offset, max })` (→ `{ text, next, total, truncated }`; `max` is capped at 64 KB by the reader), `demoRef(ref)`, `maskPlain(text, max)`, `spanKey(rawId)`, `gw.run(id)`, and `MARK` from `lib/evals/judge.js`.
- Produces (both on the object `createTrace` returns):
  - `example(key, turn, span) → Promise<{ input: { system: null, messages, tools }, output: { text, model }, source: { source, session, turn, span } } | null>`, wrapped in `guard(example, (a) => a[0])`.
    - 404 for an unknown key (via `lookup`), 400 `bad turn` for a turn that is not a whole number ≥ 0, `null` for a turn past the end, `null` for a light source or a gateway request group (same rule as `judgeable`).
    - `span` is optional: a **sealed** span id as the client holds it. It must be a span of that turn (`spanKey(s.id) === span` for a span in the built skeleton), else 400 `span is not in this turn`. It is stored raw in `source.span` and does not change the content (R3).
    - Content follows R3. Text is read with a helper `readHeadTail(ref, max)`: read `{ max: Math.floor(max / 2) }`; if `truncated`, read again at `offset = Math.max(first.next, first.total - Math.floor(max / 2))` and join with `\n${MARK}\n`. Reads go through `limited()` (P9). It ignores `contentOff` like `material()` (server-internal); the API enforces R7.
  - `sealSpan(rawId) → string | null`: `spanKey(rawId)` for a non-empty string, else null (for the link back from a dataset row).

- [ ] **Step 1: Write the failing tests** (add to `test/trace-registry.test.js`):
  - Claude fixture `s1` turn 0: `messages[0]` deep-equals `{ role: 'user', text: 'fix the login redirect' }`; `output.text === 'Changed the redirect.'`; `source` deep-equals `{ source: 'claude', session: 's1', turn: 0, span: null }`; `tools` names include `Agent`; every later message has `role: 'tool'` and a `name`; `output.model` is a string.
  - With `tmpClaude` and a runtime `secret()` in the prompt and in a Bash tool output: `JSON.stringify(ex)` does not contain the secret and the prompt matches `/hidden/`.
  - A turn whose answer is 70,000 characters: `output.text.length <= 65536 + MARK.length + 2`, it contains `MARK`, and it ends with the answer's last 100 characters.
  - A sealed span id taken from `(await t.session(key, { turn: 0 })).spans` of a tool span: `source.span` is the raw id and `t.sealSpan(source.span)` equals the sealed id. A sealed id of a span from turn 1 used with turn 0 → rejects with status 400.
  - A light source (`fakeLight`) → `null`; a forged key → status 404; `turn: -1` → 400; `turn: 99` → `null`.
- [ ] **Step 2: Run them and see them fail** (`node --test test/trace-registry.test.js`).
- [ ] **Step 3: Implement it** next to `material()`, reusing its span selection (`isCall`, the turn and answer spans, the gateway run task through `maskPlain(task, 65536)`). Do not put the raw skeleton in the client cache.
- [ ] **Step 4: Run them and see them pass** (`test/trace-registry.test.js` and the other `test/trace-*.test.js`).
- [ ] **Step 5: Commit** with the message "Build a masked dataset example from one trace turn".

---

### Task 3: Experiment scoring, the experiment store and judge calls outside the queue

**Files:**
- Create: `lib/datasets/score.js`, `lib/datasets/experiments.js`
- Modify: `lib/evals/engine.js`
- Test: `test/datasets-score.test.js`, `test/datasets-experiments.test.js`, `test/evals-engine.test.js` (add cases with its `rig()` helper)

**Interfaces:**
- Consumes: `R` (`lib/evals/registry.js`: `get`, `scoreOf`), `sig.scanSecrets`, `sig.scanRisky`, `buildPrompt`/`parseVerdict` (`lib/evals/judge.js`), `openJsonl`.
- Produces from `engine.js` (new member of the returned object):
  - `judgeMaterial(evaluatorId, material, { signal } = {}) → Promise<{ ok: true, label, score, pass, explanation, judge: { kind, model, provider }, trimmed } | { ok: false, reason }>`.
    - Throws 400 unless the id is a judge evaluator with `scope: 'turn'`.
    - Same gates as the queue, in this order: `rollover()`; `settings().judge === false` → `judge off`; `resolveQuiet()` not ok → its `reason`; `blocked(s, r)` → its `reason` (unpriced or unconfirmed external); `capped(s, r)` → `daily cap` / `cost cap`; an external estimate that would pass the cost cap → `cost cap`.
    - Counts against `state.count` and `state.cost` exactly as `runJob` does, so extract two internal helpers from `runJob` and use them in both places: `estimateOf(resolved, built) → { estimate, inputOnly }` and `chargeOf(resolved, reply, estimate, inputOnly) → cost`. The existing engine tests must pass unchanged.
    - **One lane.** Add `const exclusive = (fn) => { const p = lane.then(fn, fn); lane = p.catch(() => {}); return p; }` with `let lane = Promise.resolve()`, and route the `models.call` in `runJob` and the one in `judgeMaterial` through it, so at most one judge call is in flight across the queue and experiments (P6).
    - An invalid verdict → `{ ok: false, reason: 'invalid verdict' }` (counted in `counters.invalid`); a failed call → `{ ok: false, reason: 'judge call failed' }`. Nothing is written to the eval store.
    - **Demo:** no model call; the label is the pass label, except the second label when the first byte of `sha256(material.answer || '')` is divisible by 4; `explanation: 'Demo verdict (no model was called).'`, `judge: { kind: 'ollama', model: 'qwen3:8b', provider: 'ollama' }`.
- Produces from `score.js`:
  - `EXPERIMENT_EVALUATORS`: `[{ id, kind, title, labels, pass }]` per R6, in that order; `getExperimentEvaluator(id) → evaluator | null`.
  - `normalize(text) → string`; `referenceMatch(output, reference) → 'match' | 'no_match' | null` (null when the reference is empty or missing).
  - `codeLabel(id, { rawText, proposal }) → label` for `secret_leak` and `risky_command`.
  - `judgeMaterialOf(example, result) → { prompt, answer, tools, available }`: `prompt` = the user messages' text joined with `\n\n`; `answer` = `result.output.text`; `tools` = each `tool` message as `{ name, target: null, status: 'ok', output: text }`, then the proposal (if any) as `{ name, target: null, status: 'proposed', output: '' }`; `available` = declared tool names.
  - `scoreResult({ example, result, evaluators, judge }) → Promise<{ [id]: { label, score, pass } | null }>`. `result` is `{ exampleId, model, output: { text, proposal: { name, arguments } | null } | null, rawText, error, cost, ms }` (`rawText` is the unmasked model text: for `secret_leak` and `reference_match` (masked first), never stored). `judge` is `(id, material) => Promise<judgeMaterial reply>`. Scores: `R.scoreOf` for registry evaluators, and 1 for `match` / 0 for `no_match`. An errored result (`result.error`) scores every evaluator `null` without calling the judge; `reference_match` is absent (not `null`) when the example has no reference; a judge reply with `ok: false` gives `null`.
  - `summarize(perExample, { models, evaluators, examples }) → { models: { [model]: { requests, cost, ms, errors, proposals, evaluators: { [id]: { pass, total, rate } } } } }` per R9. `examples` is the list of example objects (to know which have a reference).
- Produces from `experiments.js`: `createExperimentStore({ file, max = 100 })` → `{ append(record), list() → [row], get(id) → record | null }`. A row is the record without `perExample`, plus `examples` (the count of distinct example ids). `list()` is newest first and cached until the next `append`; `get` reads the file and returns the line with that id. `append` rewrites the file with the newest `max` records when there are more.

```js
// lib/datasets/score.js (the parts the tests pin)
const normalize = (t) => String(t ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
function referenceMatch(output, reference) {
  const ref = normalize(reference);
  if (!ref) return null;
  const out = normalize(output);
  return out === ref || out.includes(ref) ? 'match' : 'no_match';
}
```

- [ ] **Step 1: Write the failing tests**

```js
// test/datasets-score.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/evals/registry');
const S = require('../lib/datasets/score');

const secret = () =>
  'sk-' + 'ant-api03-' + Array.from({ length: 48 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7) % 36]).join('');
const example = (over = {}) => ({
  id: 'ex_0000000000000001',
  input: {
    system: null,
    messages: [
      { role: 'user', text: 'fix the login redirect' },
      { role: 'tool', name: 'Read', text: 'export function afterSignIn() {}' },
    ],
    tools: [{ name: 'Read', description: '' }, { name: 'Edit', description: '' }],
  },
  output: { text: 'Fixed.', model: 'claude-opus-5-5' },
  reference: { text: 'the redirect keeps next' },
  ...over,
});
const result = (text, proposal = null) => ({ exampleId: 'ex_0000000000000001', model: 'local/qwen3', output: { text, proposal }, rawText: text, error: null, cost: 0, ms: 5 });

test('reference_match: normalized exact or contains', () => {
  assert.equal(S.referenceMatch('  The Redirect keeps   NEXT ', 'the redirect keeps next'), 'match');
  assert.equal(S.referenceMatch('Done: the redirect keeps next.', 'the redirect keeps next'), 'match');
  assert.equal(S.referenceMatch('nothing changed', 'the redirect keeps next'), 'no_match');
  assert.equal(S.referenceMatch('anything', ''), null);
});

test('code labels read the raw output and the proposal', () => {
  assert.equal(S.codeLabel('secret_leak', { rawText: `here: ${secret()}`, proposal: null }), 'leaked');
  assert.equal(S.codeLabel('secret_leak', { rawText: 'clean', proposal: null }), 'clean');
  const rm = { name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /' }) };
  assert.equal(S.codeLabel('risky_command', { rawText: '', proposal: rm }), 'risky');
  assert.equal(S.codeLabel('risky_command', { rawText: 'rm -rf /', proposal: null }), 'safe');
});

test('judges get the prompt, the answer, the tool results and the proposal', async () => {
  const seen = [];
  const judge = async (id, material) => {
    seen.push([id, material]);
    return id === 'relevance' ? { ok: false, reason: 'daily cap' } : { ok: true, label: R.get(id).pass, score: 1, pass: true };
  };
  const proposal = { name: 'Edit', arguments: '{}' };
  const out = await S.scoreResult({ example: example(), result: result('Fixed it.', proposal), evaluators: ['reference_match', 'task_completion', 'relevance'], judge });
  assert.deepEqual(out.reference_match, { label: 'no_match', score: 0, pass: false });
  assert.deepEqual(out.task_completion, { label: 'complete', score: 1, pass: true });
  assert.equal(out.relevance, null);
  const m = seen[0][1];
  assert.equal(m.prompt, 'fix the login redirect');
  assert.equal(m.answer, 'Fixed it.');
  assert.deepEqual(m.tools.map((t) => [t.name, t.status]), [['Read', 'ok'], ['Edit', 'proposed']]);
  assert.deepEqual(m.available, ['Read', 'Edit']);
});

test('an errored replay is not judged and counts against every evaluator', async () => {
  let calls = 0;
  const judge = async () => (calls++, { ok: true, label: 'complete', score: 1, pass: true });
  const errored = { ...result(''), output: null, error: 'upstream_error' };
  const out = await S.scoreResult({ example: example(), result: errored, evaluators: ['task_completion'], judge });
  assert.equal(calls, 0);
  assert.equal(out.task_completion, null);
});

test('summary maths per model and evaluator', () => {
  const row = (model, exampleId, labels, extra = {}) => ({ exampleId, model, output: { text: 'x', proposal: null }, error: null, labels, cost: 0.01, ms: 10, ...extra });
  const pass = (id) => ({ label: R.get(id) ? R.get(id).pass : 'match', score: 1, pass: true });
  const fail = { label: 'no_match', score: 0, pass: false };
  const examples = [example({ id: 'a' }), example({ id: 'b' }), example({ id: 'c', reference: null })];
  const per = [
    row('m1', 'a', { reference_match: pass('reference_match'), task_completion: pass('task_completion') }),
    row('m1', 'b', { reference_match: fail, task_completion: null }),
    row('m1', 'c', { task_completion: pass('task_completion') }),
    row('m2', 'a', { reference_match: null, task_completion: null }, { error: 'boom', output: null, cost: 0, ms: null }),
  ];
  const s = S.summarize(per, { models: ['m1', 'm2'], evaluators: ['reference_match', 'task_completion'], examples });
  assert.deepEqual(s.models.m1.evaluators.reference_match, { pass: 1, total: 2, rate: 0.5 });
  assert.deepEqual(s.models.m1.evaluators.task_completion, { pass: 2, total: 3, rate: 2 / 3 });
  assert.equal(s.models.m2.errors, 1);
  assert.deepEqual(s.models.m2.evaluators.task_completion, { pass: 0, total: 1, rate: 0 });
  assert.equal(s.models.m1.requests, 3);
  assert.equal(Math.round(s.models.m1.cost * 100), 3);
});
```

  Also write `test/datasets-experiments.test.js`: `append` three records with `max: 2` → `list()` has the newest two, newest first, without `perExample` and with `examples` counted; `get(id)` returns the full record; `get('exp_missing')` is null; mode 0600 on POSIX. And add to `test/evals-engine.test.js`: `judgeMaterial` with a fake local model returns `{ ok: true, label }`; `judge: false` → `judge off`; with `dailyCap: 1` the second call → `daily cap` and `status().today.count === 1`; an external unconfirmed resolution → the confirm reason and no model call; a non-judge id throws 400; a queue job and a `judgeMaterial` call started together never have two model calls in flight (count in the fake `call`); demo mode makes no model call.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run them and see them pass**, including the whole `test/evals-engine.test.js` and `test/evals-cli.test.js` (the lane must not change queue behaviour).
- [ ] **Step 5: Commit** with the message "Score replay outputs with the evaluators and store experiment records".

---

### Task 4: Text-only replay through the gateway

**Files:**
- Modify: `lib/gateway/index.js` (add `replay` next to `judge` in the returned object)
- Create: `lib/datasets/replay.js`
- Test: `test/datasets-replay.test.js`

**Interfaces:**
- Consumes: the gateway's internal `llm({ model, messages, tools, keyId, agent, temperature, signal })` (→ `{ message, usage: { input, output, cost }, routedTo }`), `providers.list()`, `providers.usable(p)`, `providers.tierOf(p)`, `providers.cachedModels(p)`, `providers.routes()`, provider `aliases`, `usage.hasPrice(name)`. From Tasks 1 and 3: `maskText`, `capField`, `scoreResult`, `summarize`, `judgeMaterialOf`. `maskPii` from `lib/evals/pii.js`.
- Produces on the gateway: `replay: { models, tierOf, priced, complete }`:
  - `models() → [{ name, provider, label, tier: 'private' | 'external', priced }]` in R5 order (`label` as in `judge.providers()`).
  - `tierOf(name) → 'private' | 'external' | null` (R5; null for aliases, routes, unknown or unusable providers, or a name without `/`).
  - `priced(name) → boolean`: true for private, else `usage.hasPrice(name)`.
  - `complete({ model, messages, tools, signal }) → Promise<{ text, toolCalls: [{ name, arguments }], usage: { input, output, cost } }>`: calls `llm({ model, messages, tools, keyId: null, agent: 'replay', temperature: 0, signal })`. `text` keeps only text parts when the content is a list; `toolCalls` comes from `message.tool_calls` (`function.name`, `String(function.arguments || '')`). It never calls an integration or a tool. It throws 400 when `tierOf(model)` is null.
- Produces from `replay.js`:
  - `REPLAY_DEFAULTS = { maxCostUSD: 0.5, maxRequests: 100, timeoutMs: 120000 }`, `OUTPUT_CAP = 4000`.
  - `toMessages(input, { external }) → [{ role, content }]` and `toTools(tools) → [openAI tool]` (R4).
  - `previewOf(example, model, { external }) → { model, messages }` (what `complete` would receive).
  - `confirmToken(secret, { dataset, exampleIds, models }) → string`: hex HMAC-SHA256 over `JSON.stringify([dataset, [...exampleIds].sort(), [...models].sort()])`, first 32 characters.
  - `orderModels(models, tierOf) → models`: private before external, otherwise in the given order.
  - `createReplayRunner({ replay, judge, now = Date.now })` → `{ run(opts) → Promise<record> }`. `replay` is the gateway accessor; `judge` is `(id, material, { signal }) => engine.judgeMaterial(id, material, { signal })`. `opts`: `{ id, dataset: meta, examples, models, evaluators, maxCostUSD, maxRequests, signal, onProgress }`.
    - Throws 400 `unknown model <name>` when `tierOf` is null, and 400 `no price known for <name>, so the cost cap cannot apply` for an unpriced external model, before any call.
    - Example-major loop (`for example → for model of orderModels(...)`), one call at a time, with R8 checks before each call, a `timeoutMs` abort per call, and `onProgress({ done, total, requests, cost })` after each.
    - Each call sends `toMessages(example.input, { external: tierOf(model) === 'external' })` and `toTools(example.input.tools)`. Exactly one call per example and model: a proposed tool call is recorded and nothing is sent back.
    - A result row is `{ exampleId, model, output: { text: capField(maskText(text), OUTPUT_CAP), proposal: first toolCall ? { name: name.slice(0, 200), arguments: capField(maskText(arguments), OUTPUT_CAP) } : null }, error: null, labels, cost, ms }`. The raw text is for `secret_leak` and `reference_match` (masked first) scoring (passed to `scoreResult` as `result.rawText`), never stored. A failed call gives `{ output: null, error: <message ≤ 200 characters, maskText applied>, cost: 0, ms }`.
    - The record is `{ id, dataset: meta.slug, datasetName: meta.name, models (ordered), evaluators, startedAt, endedAt, status: 'done' | 'stopped', stopped: null | 'cost cap' | 'request cap' | 'cancelled', caps: { maxCostUSD, maxRequests }, usage: { requests, cost }, perExample, summary: summarize(...) }`.

- [ ] **Step 1: Write the failing tests** in `test/datasets-replay.test.js`:
  - **Gateway accessor** with `createGateway` (copy the setup of `test/gateway.test.js`: `fakeServer` upstream, `secretsFor()`, a temp `dataDir`) and providers `{ id: 'local', preset: 'custom', tier: 'private', baseUrl: upstream.url, models: ['qwen3', 'nomic-embed-text', 'glm-4.6:cloud'] }`, `{ id: 'lms', preset: 'lmstudio', baseUrl: upstream.url, models: ['phi'] }` and `{ id: 'openai', preset: 'custom', tier: 'external', approved: true, baseUrl: upstream.url, models: ['gpt-6.1'], aliases: { best: 'gpt-6.1' } }`, plus a route `router/fast`:
    - `tierOf('local/qwen3') === 'private'`, `tierOf('openai/gpt-6.1') === 'external'`, `tierOf('local/glm-4.6:cloud') === 'external'`, and `null` for `router/fast`, `best`, `nope/x` and `qwen3`;
    - `models()` lists `lms/phi` before `local/qwen3` (lmstudio preset before other private), both before `openai/gpt-6.1`, and no `nomic-embed-text`.
  - **Tools are declared and never executed:** the upstream answers `{ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }`. Run 2 examples × `local/qwen3` through a real runner on that gateway (`judge` returns `{ ok: false, reason: 'off' }`): the upstream saw exactly 2 requests, each body has `tools[*].function.name` = the declared names and `tool_choice: 'auto'`, no message has `role: 'tool'`, the integrations spy's `callTool` was never called, and `perExample[0].output.proposal` deep-equals `{ name: 'Read', arguments: '{"file_path":"a.ts"}' }`.
  - **A `tool` input message** is sent as `{ role: 'user', content: '[tool result: Bash]\n…' }`.
  - **Budget caps** (fake `replay` object, no gateway): 3 examples, `maxRequests: 2` → 2 calls, `status: 'stopped'`, `stopped: 'request cap'`; usage cost 0.3 per call with `maxCostUSD: 0.5` → 2 calls then `cost cap`; an aborted `signal` → `cancelled` with 0 calls.
  - **Local-first order:** `models: ['openai/gpt-6.1', 'local/qwen3']` → `record.models` is `['local/qwen3', 'openai/gpt-6.1']` and the first call is to `local/qwen3`.
  - **External masking and the preview:** an example whose user text holds `alex@example.com` and a home path `/Users/alex/x`: `previewOf(…, { external: true })` shows `‹email›` and `‹user›`; the private send shows them as they are; `confirmToken` is stable for the same input and differs when a model changes; an unpriced external model is refused before any call.
  - **Stored output** is masked (a runtime secret in the model's text is not in `JSON.stringify(record)`) while `secret_leak` still labels it `leaked`, and text over 4,000 characters contains `MARK`.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement the accessor and the runner.**
- [ ] **Step 4: Run it and see it pass**, plus `test/gateway.test.js` and `test/evals-api.test.js`.
- [ ] **Step 5: Commit** with the message "Replay dataset examples text-only through the gateway with per-run caps".

---

### Task 5: HTTP API, the auto-add rule, server wiring and demo data

**Files:**
- Create: `lib/datasets/api.js`, `lib/datasets/auto.js`
- Modify: `server.js`, `lib/demo.js`, `lib/evals/api.js` (`onFeedback`), `lib/evals/engine.js` (`onResult`)
- Test: `test/datasets-api.test.js`, `test/datasets-auto.test.js`

**Interfaces:**
- Consumes: Task 1 store, Task 2 `trace.example`/`trace.sealSpan`/`trace.keyFor`/`trace.sourceOf`, Task 3 `createExperimentStore`/`EXPERIMENT_EVALUATORS`, Task 4 `createReplayRunner`/`previewOf`/`confirmToken`/`orderModels`/`gateway.replay`.
- Produces from `api.js`: `createDatasetApi({ datasets, experiments, runner, replay, trace, contentOff = false, settings, secret = crypto.randomBytes(16), now = Date.now, newId })` → `{ route(req), settings: current, running: () => id | null }`.
  - `req` is `{ method, path, query, contentType, readBody(max) }`. `route` returns `null` when the path is neither `/api/datasets`, `/api/datasets/…`, `/api/experiments` nor `/api/experiments/…`; otherwise `{ status, body, type? }` (`type` only for the export).
  - `settings` is `{ get() → stored config.datasets, save(next) }`; `current()` → `{ autoAdd: { enabled: false, dataset: '', onFail: true, onBad: true } }` with stored values over the defaults.
  - Example rows for a client: `{ id, createdAt, updatedAt, link: { source, key, turn, span } | null, input, output, reference, tags, evals, feedback }`. `link.key` comes from `trace.keyFor(source, session)` (null when that throws), `link.span` from `trace.sealSpan`; no raw session id is returned. Texts follow R7.
- Produces from `auto.js`: `createAutoAdd({ datasets, trace, settings, contentOff = false, log = () => {} })` → `{ onResult(result), onFeedback(record), drain() → Promise, stats() → { added, skipped, queued } }`.
  - `settings` is `() => current().autoAdd`. Nothing happens unless `enabled`, the dataset exists and content is on.
  - `onResult`: a judge result (`R.get(result.evaluator).kind === 'judge'`, scope `turn`, integer `target.turn`) whose label is not the pass label, when `onFail`. `onFeedback`: `rating === 'bad'` with an integer `target.turn`, when `onBad`.
  - A bounded queue (200, deduplicated by `sourceKey`), one item at a time: `trace.keyFor` → `trace.example(key, turn)` → `datasets.add(slug, [{ ...ex, tags: ['auto'], evals?: { [evaluator]: label }, feedback?: 'bad' }])`. Errors are logged once per reason and never thrown.
- Modifies: `createEvalEngine({ …, onResult = () => {} })` calls `onResult(stored)` after each successful `store.put` (in a try/catch); `createEvalApi({ …, onFeedback = () => {} })` calls `onFeedback(rec)` after a successful `feedback.set` in `feedbackPost`.

**Routes** (all behind the dashboard sign-in; 400 validation, 403 content off, 404 unknown, 405 wrong method, 409 conflict, 413 too large, 415 a POST/PUT/PATCH without JSON, 428 preview needed, 500 `dataset request failed`; every message path-free; query and string values over 512 characters → 400):

| Route | Body | Reply |
|---|---|---|
| `GET /api/datasets` | — | `{ datasets: [meta], limits: { examples, datasets, fieldChars }, content: !contentOff }` |
| `POST /api/datasets` | `{ name, slug? }` | `{ dataset }` |
| `GET /api/datasets/settings` · `POST` | `{ autoAdd: { enabled?, dataset?, onFail?, onBad? } }` | `{ autoAdd }` (booleans checked; `dataset` must exist when `enabled`) |
| `GET /api/datasets/:slug` | — | `{ dataset, examples: [row] }` |
| `PUT /api/datasets/:slug` | `{ name }` | `{ dataset }` |
| `DELETE /api/datasets/:slug` | — | `{ deleted: true }` |
| `POST /api/datasets/:slug/examples` | `{ items: [{ key, turn, span? }] }` (1–50) | `{ added: [row], skipped: [{ index, reason }] }`; an item whose session has no text is skipped `this session has no text`; 403 when content is off |
| `PATCH /api/datasets/:slug/examples/:id` | `{ reference?: string \| null, tags?: [string] }` | `{ example: row }` |
| `DELETE /api/datasets/:slug/examples/:id` | — | `{ deleted: true }` |
| `GET /api/datasets/:slug/export` | — | the JSONL text, `type: 'application/x-ndjson; charset=utf-8'`; 403 when content is off |
| `POST /api/datasets/import` | `{ slug, name?, jsonl }` (body up to 16 MB: `readBody(LIMITS.importBytes)`) | `{ dataset, added }`; 400 carries `reasons` |
| `GET /api/experiments` | — | `{ experiments: [row], running: { id, dataset, done, total, requests, cost } \| null, models: replay.models(), evaluators: EXPERIMENT_EVALUATORS }` |
| `POST /api/experiments` | `{ dataset, examples?: [id], models: [1–3 names], evaluators: [1–7 ids], maxCostUSD?, maxRequests?, preview?: true, confirm? }` | 202 `{ id, status: 'running' }`; with `preview: true` 200 `{ preview: [previewOf(first example, m)] for each external model, confirm }` (403 when content is off) |
| `GET /api/experiments/:id` | — | while running `{ id, status: 'running', progress }`, else the record (texts per R7); id shape `^exp_[0-9a-f]{16}$` |

`POST /api/experiments` rules: the dataset and every listed example exist (`examples`, when given, holds 1–1,000 distinct ids; otherwise the whole dataset); the caps follow R8; models are distinct, each with a non-null `tierOf`; an external model must be priced; with any external model and no `preview`, `confirm` must equal `confirmToken(secret, { dataset, exampleIds, models })`, else 428 `{ error: 'preview what will be sent first', preview: true }`; another run in progress → 409. The run starts in the background; when it ends the record is appended to `experiments.jsonl`; a runner failure is logged and kept as a record with `status: 'stopped', stopped: 'error'`.

**Server wiring** (one new block after the eval block, plus these small edits):
- `readBody(req, max = 1e6)` replaces the fixed `1e6`.
- Create `const datasets = createDatasetStore({ dir: path.join(evalDir, 'datasets') })` and `const experiments = createExperimentStore({ file: path.join(evalDir, 'experiments.jsonl') })` **before** `createEvalEngine`. Pass `onResult: (r) => datasetAuto.onResult(r)` to the engine and `onFeedback: (f) => datasetAuto.onFeedback(f)` to `createEvalApi` (the closures run later, so `datasetAuto` may be defined after them).
- The runner gets `replay: gateway.replay` and `judge: (id, m, o) => evalEngine.judgeMaterial(id, m, o)`. Settings read and write `config.json` under `datasets`, the same way as `evals` (demo: `rawCache` only).
- Route call right after the eval route: `const hit = await datasetApi.route({ …, readBody: (max) => readBody(req, max) }); if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json');`.
- **Demo:** after the stores exist, seed them from `demo.datasetsDemo()`: `datasets.create(...)` and `datasets.add(slug, examples, { strict: true })` per dataset, `experiments.append(record)` per record (the store lives in the throwaway `demoDir`).

**Demo data** (`lib/demo.js`, appended function and export entry): `datasetsDemo(now = Date.now())` → `{ datasets: [{ slug: 'auth-regressions', name: 'Auth regressions', examples }, { slug: 'pagination', name: 'Pagination', examples }], experiments: [record, record] }`. Examples point at the demo trace sessions (`demo-claude-1`, `demo-codex-1`, turn 0), use the demo prompts and answers, one with a reference, one with tags and `feedback: 'bad'`, and one with a runtime-built fake key in a tool message (masked when seeded). The two experiment records use `ollama/qwen3-coder:30b`, `lmstudio/mistral-small-3.2` and `anthropic/claude-haiku-5-5`, with mixed labels, one proposal, one `cost cap` stop, and summaries computed with `summarize`.

- [ ] **Step 1: Write the failing tests.**
  - `test/datasets-api.test.js`, **unit** (fake `trace`, the real store in a temp dir, a fake `replay` and runner):
    - create → list → get → rename → delete; 409 on a duplicate; 415 for a non-JSON POST; 400 for a value over 512 characters;
    - add from items: the fake `trace.example` result is stored with its `source`, the row's `link.key` is the key the fake `keyFor` returns, and no row contains the raw session id;
    - `contentOff: true`: example rows have `output.text === null`, adding and exporting give 403, the experiment preview gives 403;
    - PATCH reference and tags; DELETE an example;
    - export then import round-trip; an import with a bad line → 400 with `reasons`;
    - experiments: a local model starts (202) and a second start while running → 409; an external model without `confirm` → 428; the preview gives the masked messages and a `confirm` that then starts the run; an unknown model → 400;
    - the settings route stores `autoAdd`, rejects a non-boolean and an unknown dataset.
  - `test/datasets-api.test.js`, **spawned server** (copy `startServer` and the sign-in helpers of `test/evals-api.test.js`, choosing a port range of its own, for example 6400–6899): with `DEMO=1`, `GET /api/datasets` lists `auth-regressions`, and `GET /api/datasets/auth-regressions` contains no `sk-ant` and no `/Users/`; with `ZAAFPULSE_AUTH=1` a gateway API key without the dashboard cookie gets 401 on `/api/datasets` and `/api/experiments`.
  - `test/datasets-auto.test.js`: disabled → nothing added; enabled with a failing judge result → one example tagged `auto` with `evals: { relevance: 'off-topic' }`; a passing result → nothing; a code-evaluator result → nothing; 👎 feedback → `feedback: 'bad'`; the same turn twice → one example; content off → nothing; a missing dataset → nothing and no throw.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run them and see them pass**, then `test/evals-api.test.js`, `test/trace-api.test.js`, `test/security.test.js` and `test/demo-gateway.test.js`.
- [ ] **Step 5: Commit** with the message "Serve datasets and experiments behind the dashboard sign-in, with demo data and auto-add".

---

### Task 6: Datasets view and "Add to dataset" in the Explorer

**Files:**
- Create: `public/datasetview.js`
- Modify: `public/index.html` (a nav link and a nav sub-link after the Trace explorer link, and `<script src="datasetview.js"></script>` before `traceview.js`), `public/app.js` (append `datasets: viewDatasets` to `VIEWS`, `datasets: 'DATASETS'` to `TITLES`, a line `if (state.route === 'datasets') mountDatasets();` after the trace mount, and `'datasets'` added to the two route lists that skip `state.data` and the 60 s re-render), `public/traceview.js`, `public/styles.css`
- Test: `test/datasets-ui.test.js`, `test/trace-ui.test.js` (add cases)

**Interfaces:**
- Consumes: the Task 5 routes, `api()`/`esc()` from `app.js`, `trApi()` from `traceview.js` (for status-aware errors in the Explorer).
- Produces (globals, and `module.exports` under `if (typeof module !== 'undefined')` for tests):
  - `viewDatasets()`, `mountDatasets()`; `dsAddPicker(anchorEl, items, { onAdded })` (used by the Explorer).
  - Pure helpers: `dsListRows(datasets) → [{ slug, name, count, when }]` (`when` like "3 h ago"); `dsPreview(text, n = 160) → string` (one line, `…` when cut, `'(hidden while content viewing is off)'` for null); `dsTagsPatch(input) → { tags } | { error }` (split on commas and spaces, R1 tag rule, at most 20); `dsImportError(err) → string` (the first three `reasons`, else the message); `dsLinkHref(link) → string | null` (`#trace?key=<k>&turn=<t>`).
- In `traceview.js`: `trSelToggle(sel, item) → newSel` (an array of `{ key, turn }`, toggling by key and turn, at most 50) and `trAddBody(sel, current) → { items }` (the multi-selection, else the current turn with the selected span: `{ key: S.key, turn: S.turn, span: S.sel }`), both exported.

**Behaviour:**
- **List** (`#datasets`): name, example count and last change; "New dataset" (name field); "Import JSONL" (file input; read with `FileReader` as text, then `POST /api/datasets/import` with the file name's slug); per row, "Export" (fetch the export and save it through a Blob link named `<slug>.jsonl`), "Rename" and "Delete" (with `confirm()`).
- **Example table** for the selected dataset (`#datasets?ds=<slug>`): input (first user message, `dsPreview`), output, reference, evals (label pills, green for the pass label), feedback marker, tags and a link back to the Explorer (`dsLinkHref`, hidden when the key is null). Clicking the reference opens an inline textarea with Save/Cancel (`PATCH`); the tags cell has an input (Enter saves through `dsTagsPatch`); each row has Delete. Every text cell is filled with `textContent` (S1). With content off, a notice says "Text is hidden while content viewing is off" and the add buttons are disabled.
- **Tabs** inside the view: "Datasets" and "Experiments" (`#datasets/experiments`, Task 7 fills it). Do not edit `SUBPAGES` in `public/iso.js`.
- **Explorer:**
  - Show the existing `data-sub="4"` buttons. "⤓ Add to dataset" opens `dsAddPicker` for `trAddBody(...)`: a select of datasets plus "New dataset…" (a name field), then `POST /api/datasets` when new and `POST /api/datasets/:slug/examples`; the result line ("Added 2 · skipped 1: already in this dataset") is set with `textContent`.
  - **Multi-select:** Ctrl/Cmd-click (or Space) on a turn row or a placeholder turn row toggles it in `S.multi` through `trSelToggle`; a slim bar above the tree says "N turns selected" with "⤓ Add to dataset" and "Clear". Plain clicks keep their current behaviour.
  - "↻ Replay turn" adds the current turn the same way, then opens `#gateway/playground?ds=<slug>&ex=<id>`.
  - Deep link: `#trace?key=…&turn=N` opens turn N (read the existing deep-link code at the end of `mountTrace` and pass the turn into the session load).
  - With content off both buttons are disabled, with the title "Content viewing is off".

- [ ] **Step 1: Write the failing tests:** `dsListRows` ordering and `when`; `dsPreview` cut and null; `dsTagsPatch` (good input, a bad tag, 21 tags); `dsImportError` with `reasons`; `dsLinkHref` with and without a key; `trSelToggle` add, remove, cap at 50; `trAddBody` with and without a multi-selection; an **S1 audit** of `public/datasetview.js` copied from `test/evals-ui.test.js` (`evalsview.js builds no HTML from …`), matching `/\b(text|output|reference|input|messages|tags|reason|reasons|name)\b/` outside `esc(...)`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.** Then check it visually in demo mode (`node bin/zaafpulse.js start --demo` on a free port): headless Chrome screenshots of `#datasets`, `#datasets?ds=auth-regressions` and `#trace` with the picker open, at 1512×945 and 1280×800, saved to the scratchpad, with a kill timer; look at them.
- [ ] **Step 4: Run the tests and see them pass** (`test/datasets-ui.test.js`, `test/trace-ui.test.js`), then the full suite once.
- [ ] **Step 5: Commit** with the message "Add the Datasets view and Add to dataset in the trace explorer".

---

### Task 7: Playground Dataset mode and the experiment list

**Files:**
- Modify: `public/gatewayview.js` (a fourth mode `['dataset', 'Dataset']` in `gwPlayground`; when `p.mode === 'dataset'` the form body is `dsPlayground(gw.pg)` and the submit and click handlers delegate to `dsPlaygroundAct(event, gw.pg, paintGateway)`), `public/datasetview.js`, `public/styles.css`
- Test: `test/datasets-ui.test.js` (add cases)

**Interfaces:**
- Consumes: `GET/POST /api/experiments`, `GET /api/experiments/:id`, `GET /api/datasets`, `GET /api/datasets/:slug`.
- Produces in `datasetview.js` (exported for tests):
  - `dsPlayground(pg) → html` and `dsPlaygroundAct(event, pg, repaint)`;
  - `dsModelOptions(models) → { groups: [{ label, options: [{ value, label, external }] }], defaults: [name] }`: a "On this machine" group (private, in the order given) and an "External (sends masked text)" group; `defaults` is the first private model, or `[]` when none (an external model is never preselected);
  - `dsRunBody(state) → { dataset, examples?, models, evaluators, maxCostUSD, maxRequests }` or `{ error }` (no dataset, 0 or more than 3 models, no evaluator, caps out of range);
  - `dsResultCells(record, example) → [{ head, text, labels, proposal, error }]`: the original output first, then one cell per model in `record.models` order;
  - `dsPassTable(summary, evaluators) → [{ model, cells: [{ evaluator, rate, pass, total }] }]`;
  - `dsCompare(a, b) → [{ evaluator, model, a, b, delta }]` for the evaluator and model pairs present in both records.

**Behaviour:**
- **Dataset mode:** pick a dataset, then "Whole dataset" or one example (a select of `dsPreview` lines; `?ds=&ex=` in the hash preselects them); pick 1–3 models from `dsModelOptions` (checkboxes, at most 3); evaluators as checkboxes (default `reference_match`, `secret_leak`, `task_completion`, `relevance`); the caps ($0.50, 100) as number fields; Run.
- **External models:** when one is ticked, Run becomes "Preview what will be sent". It calls `POST /api/experiments` with `preview: true` and shows each model's messages in read-only boxes filled with `textContent`, then "Send to <providers>", which posts again with `confirm`.
- **Progress:** poll `GET /api/experiments/:id` every 2 s while it runs ("12 / 40 · 15 requests · $0.03"), stop polling when the page changes.
- **Results:** a side-by-side grid per example (`dsResultCells`): original output | model A | model B | model C, each with label pills, a proposal shown as "Proposed tool call: <name>" plus its arguments (text), or the error; and the pass-rate table (`dsPassTable`) with the stop reason when `stopped`.
- **Experiments tab** (`#datasets/experiments`): the list (dataset, models, started, status, pass rate per evaluator and model); tick two rows and "Compare" shows `dsCompare` with the delta coloured (green up, red down); clicking a row opens its results grid.

- [ ] **Step 1: Write the failing tests:** `dsModelOptions` groups and the default (only private preselected; none when there is no private model); `dsRunBody` errors and a good body; `dsResultCells` order with an errored cell and a proposal; `dsPassTable`; `dsCompare` delta; the S1 audit from Task 6 still passes with the new code.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it**, with a visual check in demo mode as in Task 6 (`#gateway/playground` in Dataset mode with a run against the demo gateway's scripted model, and `#datasets/experiments` with the two seeded records compared).
- [ ] **Step 4: Run the tests and see them pass**, then the full suite once.
- [ ] **Step 5: Commit** with the message "Replay datasets in the Playground and compare experiments".

---

### Task 8: The CI gate command

**Files:**
- Create: `lib/datasets/cli.js`
- Modify: `bin/zaafpulse.js`, `lib/evals/cli.js` (extract `judgeGate`)
- Test: `test/datasets-cli.test.js`

**Interfaces:**
- Consumes: `createGateway`, `createSecrets`, `otel.init`/`otel.reset`, `createModels`, `createClaude`, `createEvalEngine`, `createEvalStore`, `createFeedbackStore`, `createEvalApi` (for its `settings()` defaults, as `runEval` uses it), Tasks 1, 3 and 4.
- Modifies `lib/evals/cli.js`: move the three settings checks at the top of `runEval` (Claude Code unconfirmed or moved, an external provider, judging off) into `judgeGate(settings, claude) → string | null`, exported with `readConfig` as `module.exports = { runEval, USAGE, judgeGate, readConfig }`. `runEval` calls it and returns 2 with the same messages; `test/evals-cli.test.js` passes unchanged.
- Produces from `lib/datasets/cli.js`:
  - `DATASET_USAGE = 'usage: zaafpulse eval --dataset <slug> --model <provider/model> [--model …] [--require <evaluator>>=<0..1>]… [--max-cost USD] [--max-requests N] [--json] [--ci] [--data DIR]'`;
  - `parseRequirement(text) → { evaluator, op: '>=' | '>', threshold } | null` (`^([a-z_]+)(>=|>)(0(?:\.\d+)?|1(?:\.0+)?)$`);
  - `checkRequirements(summary, requirements, models) → [{ evaluator, model, op, threshold, rate, pass, total, ok }]` (one row per requirement and model; `rate` null → not ok);
  - `runDatasetEval({ dataset, models, requires, json = false, ci = false, maxCostUSD, maxRequests, dir, env = process.env, out, err }) → Promise<number>`.
- `bin/zaafpulse.js`: add `'--dataset', '--model', '--require', '--max-cost', '--max-requests'` to `VALUE_FLAGS`; add `const flagAll = (name) => argv.flatMap((a, i) => (a === `--${name}` && i + 1 < argv.length ? [argv[i + 1]] : []));`; in `eval()`, when `flag('dataset')` is set call `runDatasetEval` (values that start with `-` → usage, exit 2), else keep the `--judge` path. Add one help line and one header comment line.

**Behaviour of `runDatasetEval`:**
1. **Configuration (exit 2, message on stderr):** a bad `--require`; an evaluator not in `EXPERIMENT_EVALUATORS`; no `--model` or more than 3; `--max-cost` or `--max-requests` outside R8; an unknown dataset in `<dir>/.data/datasets`; a model whose `tierOf` is null (`unknown model`); an **external** model (`external models need the dashboard and its preview`); a required judge evaluator while `judgeGate(...)` returns a message or `models.resolve()` is not ok (`judge unavailable: <reason>`).
2. **Headless wiring** against `dir`: `config = readConfig(dir)` (the helper in `lib/evals/cli.js`, now also exported: `module.exports = { runEval, USAGE, judgeGate, readConfig }`), `version` from `package.json`, `otel.init({ getConfig: () => config, secrets: createSecrets(), version })`, a gateway with `dataDir: <dir>/.data`, `getConfig: () => config`, `writeGatewayConfig` and `resolveSecret` that throw `read-only here`, `getPricing: () => config.pricing`, `getIntegrations: () => ({ listTools: async () => [], callTool: async () => { throw new Error('no tools in replay'); } })`; models and engine as in `runEval` (no gateway for the judge, so only a local judge or a confirmed Claude Code judges).
3. **Evaluators:** the required ones; with no `--require`, the three code evaluators.
4. **Run** with `createReplayRunner` (`id: 'exp_' + 16 hex`), append the record to `<dir>/.data/experiments.jsonl`, `await otel.reset()`, and handle SIGINT/SIGTERM like `runEval` (abort the run, stop the models).
5. **Output:** a table `EVALUATOR  MODEL  PASS RATE  REQUIRED  RESULT` (rate as `83.3% (5/6)`, required as `>= 0.80` or `-`, result `pass`/`FAIL`/`-`), plus a stderr line when the run stopped early. With `--json`, print instead `{ ok, dataset, models, experiment, stopped, usage: { requests, cost }, evaluators: { [model]: { [id]: { pass, total, rate } } }, requirements: [row] }`.
6. **Exit:** `--ci`: 1 when any requirement row is not ok or the run stopped early, else 0. Without `--ci`: 0 after a run. Configuration errors: 2 either way.

- [ ] **Step 1: Write the failing tests** in `test/datasets-cli.test.js` (spawn `bin/zaafpulse.js` like `test/evals-cli.test.js`, with a temp `HOME`, `NO_JUDGE_PORTS`, and a data folder holding `config.json` with `gateway.providers: [{ id: 'local', preset: 'custom', tier: 'private', baseUrl: <fake upstream>, models: ['qwen3'] }, { id: 'openai', preset: 'custom', tier: 'external', approved: true, baseUrl: <fake upstream>, models: ['gpt-6.1'] }]`, and a dataset `auth-regressions` seeded through `createDatasetStore({ dir: <data>/.data/datasets })` with three examples (turns 0–2) whose reference is `the redirect keeps next`):
  - the upstream answers with the reference text → `--model local/qwen3 --require 'reference_match>=0.8' --ci` exits 0, prints `reference_match` and `pass`, and `experiments.jsonl` has one record;
  - the upstream answers something else → the same command exits 1 and prints `FAIL`;
  - exit 2 for an unknown dataset, an unknown evaluator (`--require 'nope>=0.5'`), a malformed requirement, `--model openai/gpt-6.1`, `--model router/x`, and `--require 'task_completion>=0.7'` with no judge reachable;
  - with a fake Ollama (`ZAAFPULSE_OLLAMA_URL`, as in `test/evals-cli.test.js`) returning the pass label, `--require 'task_completion>=0.7' --ci` exits 0;
  - `--json` prints one JSON object whose keys are `ok, dataset, models, experiment, stopped, usage, evaluators, requirements`, and whose `requirements[0]` has `evaluator, model, op, threshold, rate, pass, total, ok`;
  - `--data <dirA>` while `ZAAFPULSE_DATA` points to an empty `<dirB>`: the dataset is found in A and the record is written to A, not B;
  - `--max-requests 2` with three examples and `--ci` exits 1 and says the run stopped at the request cap;
  - unit tests for `parseRequirement` and `checkRequirements`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run them and see them pass**, plus `test/evals-cli.test.js`.
- [ ] **Step 5: Commit** with the message "Add zaafpulse eval --dataset as a CI quality gate".

---

### Task 9: Docs, README and final verification

**Files:**
- Create: `docs/datasets.md`
- Modify: `README.md`, `docs/explorer.md` (one paragraph: "Add to dataset", multi-select and "Replay turn"), `docs/evals.md` (one paragraph under the command line section pointing to `zaafpulse eval --dataset` and to `judgeMaterial` sharing the judge's caps)

**Behaviour:**
- **`docs/datasets.md`** sections:
  1. What it is for (the spec's goal, four bullets).
  2. The example shape (the verbatim JSON from Global Constraints) and R2–R3 (how a turn becomes an example).
  3. Limits (R1) and masking (S2, the `‹… hidden›` marker, the head + tail marker).
  4. Adding examples: the Explorer button, multi-select, "Replay turn", the auto-add rule (off by default; judge failures and 👎; tag `auto`; paused while content is off).
  5. Managing datasets: the view, inline edits, import (atomic, the reasons shown) and export.
  6. Replay: text only (R4, the `[tool result: …]` wording, tools declared and never run, one call per example and model), models (R5, local first, aliases and routes refused, Ollama or LM Studio must be added under Gateway → Providers), external providers (price needed, masked with personal data hidden, preview, the confirm step), caps (R8).
  7. Scoring and experiments: R6, R9, R10, the record shape, comparing two experiments, judge calls counting against the Settings → Evals caps.
  8. The CI gate: usage, the table, `--json` shape, exit codes, `--data`; **quote every `--require`** (`'faithfulness>=0.8'`), since an unquoted `>` is a shell redirect. Recipes:

     ```yaml
     # .github/workflows/eval-gate.yml (a self-hosted runner on the machine that holds the ZAAFPulse data folder)
     name: eval-gate
     on: [pull_request]
     jobs:
       gate:
         runs-on: [self-hosted, zaafpulse]
         steps:
           - uses: actions/checkout@v4
           # ZAAFPULSE_DATA is set on the runner to the data folder, for example
           # ~/.local/share/zaafpulse/data (Linux) or ~/Library/Application Support/ZAAFPulse (macOS)
           - run: >
               zaafpulse eval --dataset auth-regressions --model local/qwen3
               --require 'faithfulness>=0.8' --require 'task_completion>=0.7' --ci
               --data "$ZAAFPULSE_DATA"
     ```

     ```sh
     #!/bin/sh
     # .git/hooks/pre-push (chmod +x): block a push when the regression set drops
     exec zaafpulse eval --dataset auth-regressions --model local/qwen3 --require 'task_completion>=0.7' --ci
     ```

     The data folder defaults are those of `lib/platform.js` `defaultDataDir()` (a git checkout uses its own folder); the pre-push hook needs no `--data` when the hook runs as the same user as the dashboard.
  9. Privacy (S1, S2, S4, S8, S10, S11 as they apply here) and where the data lives (`.data/datasets/index.json`, `<slug>.jsonl`, `.data/experiments.jsonl`, modes).
  10. HTTP API (the Task 5 routes table) and known limits (no versioning beyond timestamps, no prompt management, no tool-executing agent experiments, no sharing with Phoenix or AX).
- **README:** a short "Datasets, replay & the CI gate" section after "Local evals & feedback" (four bullets and a link to `docs/datasets.md`), one row in the API table, one row in the Privacy table (replay models: what is sent and when), `lib/datasets/` and `docs/datasets.md` lines in the file layout, and the `eval --dataset` line where the CLI is listed. Additive lines only (Global Constraints).
- [ ] **Step 1: Write the docs.** Every command, route and limit must match the code; check them against `lib/datasets/*.js` and `bin/zaafpulse.js --help`.
- [ ] **Step 2: Check the examples:** no real paths, keys, user names or session ids appear in `docs/datasets.md` or the README lines (use `alex`, `/Users/alex`, `auth-regressions`, `local/qwen3`).
- [ ] **Step 3: Run the full suite twice** (`npm test`). Both runs must pass.
- [ ] **Step 4: Commit** with the message "Document datasets, replay and the CI gate".

---

## Decisions made while planning

1. **Examples are turn-level.** The input is the turn prompt plus the last 10 tool results as `tool` messages (8,000 characters each); the output is the turn's final answer. A selected span is recorded in `source.span` for the link back only. Including the tool results lets a replayed model answer from the same evidence, so `faithfulness` means something.
2. **`tool` messages are sent as user messages** prefixed `[tool result: <name>]`, because a recorded result has no `tool_call_id` to pair with; tools are declared as functions with an open parameter schema.
3. **"Masked with `scanSecrets`"** is implemented with `sig.secretSpans()` and the trace explorer's `‹… hidden›` marker (the same patterns and placeholder checks); external replay also gets `maskPii`, as the external judge does.
4. **Replay only through the gateway** (S8), only `provider/model` names of a usable provider. Aliases and routes are refused because their target tier is unknown; names ending in `cloud` count as external. An Ollama or LM Studio that runs but is not added as a gateway provider is not used (the docs say how to add it).
5. **External replay** needs a known price (otherwise the cost cap counts nothing) and a per-run preview: the server returns the masked messages and an HMAC `confirm` token over dataset, examples and models; a run without it gets 428. The CLI refuses external replay models (exit 2), because it has no preview step.
6. **Run caps count replay requests only.** Judge calls go through a new `engine.judgeMaterial()`, which shares the judge's single lane (P6 concurrency 1), daily and cost caps, and external-preview gate.
7. **Experiment evaluators** are `reference_match`, `secret_leak`, `risky_command` and the four turn-scope judges. The other code evaluators read log signals and `user_frustration` is session-scope, so they do not apply. `reference_match` lives in `lib/datasets/score.js`, not in the registry, because registry code evaluators are emitted for every turn.
8. **Pass rates are strict:** an errored replay or a missing verdict counts as not passing; `reference_match` counts only examples with a reference. Original outputs are shown, not scored.
9. **One experiment at a time per server** (409); stored outputs are capped at 4,000 characters; `experiments.jsonl` keeps the newest 100 records.
10. **Dataset files:** `.data/datasets/<slug>.jsonl` plus an `index.json` of names, counts and times. Import is atomic (any bad line rejects it, with up to 20 reasons) with a 16 MB body cap; export is NDJSON; a slug is fixed at creation (`PUT` renames the display name); `import` and `settings` are reserved; per example at most 50 messages, 100 tools, 20 tags and 1 MB.
11. **Content off (S10):** texts are `null` in responses; adding from spans, export and the experiment preview give 403; auto-add pauses. Import, tag edits, deletes and runs still work.
12. **Auto-add triggers** are failing judge results (turn scope) and 👎. Code evaluator results are computed on demand and never stored, so they cannot trigger it. Settings live in `config.json` under `datasets.autoAdd`; added examples get the tag `auto`.
13. **CLI details:** `--require` takes `>=` or `>` (the docs quote it); `--model` may repeat up to 3 times; without `--require` only the code evaluators run; a run stopped by a cap exits 1 under `--ci`; without `--ci` a finished run exits 0; CLI runs are appended to the same `experiments.jsonl`.
14. **"↻ Replay turn"** adds the turn to a dataset and opens the Playground's Dataset mode on that example.
15. **The Datasets view has its own Datasets/Experiments tabs** instead of a `SUBPAGES` entry in `public/iso.js`, to keep shared-file edits small.
16. **The CLI task comes before the docs task**, so the docs describe a command that exists.
17. **`reference_match` reads the masked full answer.** It matches against `maskText(rawText)`, not the stored `output.text`: the stored text is capped at 4,000 characters (head + tail), so a reference in the middle of a long answer would always be `no_match`. The raw text is masked first (as the reference was on save), is used for `secret_leak` and `reference_match` only, and is never stored. An experiment list row carries `examples` as the count of distinct example ids, not the ids.

## Self-review

**Spec coverage:**

| Spec item | Task |
|---|---|
| Example shape, `.data/datasets/<slug>.jsonl` 0600, masking on save | 1 |
| Limits: 1,000 examples, 64 KB per field with head and tail, 100 datasets | 1 |
| Add from the Explorer detail panel, existing or new dataset | 2 (builder), 5 (route), 6 (UI) |
| Multi-select in the trace tree | 6 |
| Auto-add rule, off by default, target dataset | 5 |
| Datasets view: list with counts and last change, example table, inline reference and tags, delete, JSONL export and validated import | 1, 5, 6 |
| Playground Dataset mode: one example or a dataset, 1–3 models, local first, external choice + preview + masking | 4, 5, 7 |
| Text-only replay, tools declared never executed, proposal stops the example | 4 |
| Budget per run ($0.50, 100 requests), clean stop | 4 |
| Requests through the gateway (usage, cost, OTLP) | 4 |
| Side-by-side results, code + judge scoring, `reference_match` | 3, 7 |
| Experiment record and list, comparing two experiments | 3, 4, 7 |
| CI gate: headless, `--data`, table, `--json`, exit codes 0/1/2, recipes | 8, 9 |
| API routes | 5 |
| Tests: store (masking, caps, import, export), add from spans, replay (fake provider, proposal, caps, local first, preview), experiments (code, fake judge, `reference_match`, summary), CLI (exit codes, `--json`, `--data`) | 1, 2, 4, 3, 8 |
| Demo mode data for the new views | 5, 6, 7 |
| Out of scope: versioning, prompt management, agent experiments, Phoenix/AX sharing | 9 (known limits) |

**Placeholders:** none; every route, function, shape, cap and message is named above. **Type consistency:** `example(key, turn, span)`, `sealSpan`, `judgeMaterial(evaluatorId, material, { signal })`, `scoreResult({ example, result, evaluators, judge })`, `summarize(perExample, { models, evaluators, examples })`, `gateway.replay.{ models, tierOf, priced, complete }`, `createReplayRunner({ replay, judge, now }).run({ id, dataset, examples, models, evaluators, maxCostUSD, maxRequests, signal, onProgress })`, `createDatasetApi({ datasets, experiments, runner, replay, trace, contentOff, settings, secret, now, newId })` and `runDatasetEval({ dataset, models, requires, json, ci, maxCostUSD, maxRequests, dir, env, out, err })` are used with the same names and shapes in every task that consumes them.
