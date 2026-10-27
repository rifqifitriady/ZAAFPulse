# Cost Control 3a: the Cost Control menu (Overview, Breakdown, Value, Budgets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Cost Control" menu in the sidebar with four sub-pages, each answering one question:
- **Overview** (`#cost`): how much this month, and is it safe? KPI tiles, a burn-down with a projection band and budget lines, a spike line, compact budget rings;
- **Breakdown** (`#cost/breakdown`): where does the money go? A cost flow (source → provider → model → cost center), an isometric treemap of projects, a calendar heatmap and a regroupable table;
- **Value** (`#cost/value`): is it worth it? Plan value against plan fee, a savings waterfall, local models, cost against tool-call accuracy per model, unit-cost trends;
- **Budgets** (`#cost/budgets`): budget cards with rings and an add/edit form (the form deferred from sub-project 2).

**Architecture:**
- **Quality input.** The Claude Code and Codex parsers count each tool result for the model that made the call (`SignalSink.modelResult`); `lib/quality.js` `accuracyByModel` sums them over a range. The index is rebuilt once (`CACHE_VERSION` 11).
- **Pure views.** `lib/cost/views.js` computes ready-to-draw data per page from ledger rows (`cost.budgetRows`), the evaluated budgets, `cost.cacheSaved(row)` (new), the accuracy per model and the Datasets pass rates. No I/O, no clock.
- **API.** `GET /api/cost/view?page=overview|breakdown|value&from&to&currency&measure` in `lib/cost/api.js`, behind the dashboard sign-in like every `/api/cost/*` route. `server.js` passes a memoized accuracy reader (indexer version + range) and a pass-rate reader (experiment store).
- **Front end.** `public/costview.js` (routing, control bar, page shells, Budgets page and form, pure helpers exported for Node tests), `public/costcharts.js` (SVG chart builders, pure and exported, plus the isometric treemap on `isoStage`), styles under `.cost-`. The browser only draws.

**Tech Stack:** Node ≥18 standard library only (CommonJS), `node:test`, plain browser JS in `public/` (classic scripts sharing one global scope, loaded before `app.js`).

**Spec:** `docs/superpowers/specs/2026-10-27-cost-control-ui-design.md`. Builds on the cost ledger (`docs/superpowers/plans/2026-10-23-cost-ledger.md`, PR #53) and budgets (`docs/superpowers/plans/2026-10-25-cost-budgets.md`, PR #54).

**Line numbers** below are on `feat/cost-control-ui` at `82fbb50`. Re-read each location before editing it.

**Baseline:** `npm test` on `82fbb50`: 1804 tests, 1802 pass, 2 skipped, 0 fail.

**Checked while planning:** every task's code and tests were applied to a scratch copy of `82fbb50` and run. Each task's tests pass, and so does the whole suite (1866 tests: the baseline's plus 62 new), except `test/platform.test.js`, which fails in any copy of the repository under a temp folder (it fails the same way on an untouched copy) and passes in the worktree. The pages were also driven in headless Chrome against the demo (`DEMO=1`): every page rendered with no script error; the control bar, the URL and storage round trip, the table regroup, sort and flow filter, and the Budgets add, edit (400 reasons), delete and focus flows behaved as described; Task 7 was checked on its own (before Task 8) the same way.

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test`. Plain browser JS in `public/`: classic `<script>` files loaded by `public/index.html` before `app.js`.
- **One global scope.** Every top-level name in `public/costview.js` and `public/costcharts.js` starts with `cost` or `COST` (functions `costX`, constants `COST_X`), except the router's `viewCost` and `mountCost`, because all page scripts share one global scope: a second `const quantile` would stop the whole dashboard from loading, and a second `function pct` would silently replace another page's. A test checks that no top-level name is declared twice across the page scripts (Task 7), and each file's audit checks the prefix.
- **Loadable in Node.** The two new files touch no DOM, `window` or `matchMedia` at load time (only inside functions), and end with `if (typeof module !== 'undefined') module.exports = { … }`, as `public/monitorsview.js` does.
- **Text only (S1).** Every owner-written or server string into HTML goes through `esc()`: budget names, budget reasons and ids, scope values, project folders, model, provider and center names, error messages, status texts. Numbers are formatted by our own formatters. `innerHTML` is only given strings built by this file's helpers. An audit test per file (`test/cost-charts.test.js` for `costcharts.js`, `test/cost-ui.test.js` for `costview.js`, run again by Tasks 6 and 8) fails on a bare `${x.name}`-style interpolation of such a field; text built for a tooltip or a note is joined with `+` or an array and escaped once where it is drawn. CSP stays `script-src 'self'`: no inline handlers (`onclick=`), no inline scripts.
- **Errors are path-free.** Every message from `/api/cost/*` goes through `lib/cost/api.js`'s `scrub`. View answers hold numbers, dimension names, `~` folders and model names only: no prompt, response or tool text.
- **Routes.** `GET /api/cost/view` needs the dashboard sign-in (never a gateway API key, MCP or A2A): it lives in `lib/cost/api.js`, which `server.js` already serves only behind the sign-in. Same range rules as `/api/cost/ledger`: at most 400 days (`MAX_DAYS`).
- **Storage.** `localStorage` only through try/catch (`costStoreGet`/`costStoreSet`, or the existing `store` wrapper in `app.js`); the page works without it. Key: `zp.cost.controls`.
- **Motion.** With `prefers-reduced-motion` (`reduceMotion.matches` in `app.js`), numbers and charts appear at their final state: no count-up, no draw-in, no isometric sway. Entrance animation only on a route or control change (`render(true)`), never on the quiet refresh. Canvases are released through `onUnmount` (`unmountStages()` already destroys every `isoStage`).
- **Tests.**
  - Never call a real provider or the network: spawned servers run with `NO_JUDGE_PORTS` and a `config.json` with `"pricingSync": { "enabled": false }`; in-process tests use fakes.
  - Never signal a real process.
  - Spawned servers in this plan take ports from **8800–9199**, a range no other test uses (cost ledger 8000-8399, budgets 8400-8799).
- **Housekeeping.**
  - Prettier style by hand (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Short "why" comments, as in `lib/cost/*.js`. Some lines in this plan's code blocks run past 120 columns: wrap them as Prettier would when you write them; the content stays as shown.
  - Commits carry **no `Co-Authored-By`, no "Generated with", no AI attribution of any kind** (owner rule).
  - CI runs on Ubuntu, macOS and Windows.
- **Shared files.** Edits are small and additive (new lines in their own block, new options with defaults that keep today's behaviour, new map or export entries, no reordering), and existing tests stay green: `lib/signals.js`, `lib/claude.js`, `lib/codex.js`, `lib/quality.js`, `lib/indexer.js`, `lib/demo.js`, `lib/cost/index.js`, `lib/cost/api.js`, `lib/monitors/api.js`, `server.js`, `public/app.js`, `public/index.html`, `public/iso.js` (one `SUBPAGES` entry), `public/monitorsview.js`, `public/styles.css`, `README.md`, `docs/cost.md`, `docs/quality-metrics.md`. The demo's numbers do not change: the demo signals draw from the random sequence in the same order as before (Task 1). One existing assertion changes on purpose: the expected budget alert row in `test/budgets-monitors.test.js:422` gains `budget` (Task 8).

## Rules and values

**V1. Measures.** `list` reads `listUSD` (usage value, the default), `billed` reads `billedUSD` (what was paid). Plan rows (`kind: 'plan'`) carry the plan fee in `billedUSD` and no usage value: they count only for `billed`.

**V2. Currency.** Amounts are summed in USD per day and converted with that day's rate (`rateOf(day)`, the display currency's latest rate on or before the day; `null` for USD). A day with no rate counts in USD and is listed in `missingRate` (an array of days). Answers round once, to 4 decimals; the page shows USD to the cent and any other currency in whole units.

**V3. Overview** (always the current month, day 1 to today, `today` = the server's local day):
- `forecast.perDay` = month-to-date ÷ elapsed days (today a whole day); `projected` = month-to-date + `perDay` × days left.
- Band: the 25th and 75th percentile (linear interpolation) of the elapsed days' spends, each × days left, added to month-to-date. Fewer than 3 elapsed days: `early: true`, `low`/`high` null.
- Budget lines: budgets with `scope: 'global'` and `period: 'month'`, at `amount` in their own currency, or converted at the display currency's latest rate (`display: { code, rate }`), else skipped (`budgetsSkipped`).
- Spike: a day whose spend is > 2 × its baseline (the mean of the 7 days before it, the days before the 1st read from `before`) **and** ≥ $1 over it, in USD.
- Rings: at most 8, riskiest first (`exceeded`, then `projected`, then the highest percent, `no_data` last), `moreBudgets` for the rest. Tone: `ok` → cyan, `warn_*` → orange, `exceeded` → pink, `no_data` → muted, dashed.
- At risk: budgets `exceeded`, `projected` or at a warning level.

**V4. Breakdown** (the chosen range, currency, measure):
- Flow columns `source`, `provider`, `model`, `center`; each keeps its top 6 by spend, the rest is `__other`; a null provider or model is `__none`, a null center `unassigned`; plan rows flow `source → provider:__plan` ("Plan fee"). Links with no spend are dropped.
- Treemap: blocks keyed by (center, project); a null project is one block per center (the gateway, the judge); at most 40 blocks counting the `__other` block per center; `perRequest` = spend ÷ requests.
- Calendar: `week` = column from the range's first day, `weekday` 0 = Monday; `steps` = the 20/40/60/80 % quantiles of the non-zero days; `level` 0 for a zero day, else 1 + the number of steps it is above (1..5).

**V5. Value** (the chosen range and currency; both measures by nature):
- Plans: per source with plan rows in the range, `value` = the source's usage value on its plan days, `fee` = its plan rows' `billedUSD`, `multiplier` = value ÷ fee (2 decimals).
- Waterfall: `usage` = Σ `listUSD`, `cacheSaved` = Σ `cost.cacheSaved(row)`, `paid` = Σ `billedUSD` (plan rows included), `withoutCache` = usage + cacheSaved, `planSaved` = usage − paid (negative when a plan cost more). `withoutCache − cacheSaved − planSaved = paid`.
- `cost.cacheSaved(row)` = `tokens.cacheRead × (input − cacheRead) ÷ 1e6` at the base entry of the row's model in the row's price version; 0 for no version, unpriced, free or plan rows, an unpriced model, or a negative difference.
- Local models: free rows' requests and tokens per model, no money.
- Scatter (usage value): one dot per model with ≥ 1 request; x = spend per request, y = accuracy; `littleData` under 50 tool results; a model with no tool results goes to `noToolCalls`; `passRate` from experiments that ended in the range.
- Unit lines per day (usage value): spend per request, per million tokens (all token kinds), per 1,000 successful tool calls (Claude Code and Codex spend over the `ok` results of every model that day). `null` where the denominator is 0.

**V6. Accuracy per model** = `1 − model-caused failures ÷ tool results`, `MODEL_FAULT` (`hallucination`, `process`), counted per day and model (`days[day].models[model] = { results, cats }`), names normalized (`normalizeModel`) when summed.

**V7. Controls.** `#cost/<sub>?range=7d|30d|month|lastmonth|custom&from=…&to=…&cur=<code>&measure=list|billed`. Invalid values fall back silently to `30d`, USD, `list`. Custom: both dates valid, `from ≤ to`, at most 400 days. Overview always shows the current month; Value hides the measure; Budgets hides all three. The last choice is saved in `localStorage` `zp.cost.controls` and used when the URL names nothing.

**V8. Budget form → body.** `{ id, name, scope, period, amount, currency, measure, thresholds, projection, enforce }`. A new budget's id comes from the name: lowercase, runs of anything outside `a-z0-9` → `-`, trimmed of `-`, at most 60 characters, `budget` when empty; `-2`, `-3`, … when taken. Enforce options mirror `lib/cost/budgets.js` `mayBlock`/`mayPause`: block on global, key, center, model, provider, source `gateway`; pause on global, project, center, model, source `claude`/`codex`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/signals.js` | modify (shared) | `SignalSink.modelResult(ts, model, category)` |
| `lib/claude.js`, `lib/codex.js` | modify (shared) | attribute each tool result to the model of its call |
| `lib/quality.js` | modify (shared) | `accuracyByModel(results, { from, to })` |
| `lib/indexer.js` | modify (shared) | `CACHE_VERSION` 10 → 11 |
| `lib/demo.js` | modify (shared) | per-model counts in the demo signals |
| `lib/cost/index.js` | modify (shared) | `cacheSaved(row)`; `budgetRows` also returns `historyLost` |
| `lib/cost/views.js` | create | pure page data: `overview`, `breakdown`, `value`, `passRates`, `budgetOrder` |
| `lib/cost/api.js` | modify (shared) | `GET /api/cost/view`; `accuracy` and `passRates` options |
| `lib/monitors/api.js` | modify (shared) | a budget alert row carries its budget id (`budget`) for the bell's link |
| `server.js` | modify (shared) | the accuracy memo and the pass-rate reader into `createCostApi` |
| `public/costview.js` | create | controls (hash + storage), status ribbon, page shells, the table (Task 7); Budgets page and form (Task 8); helpers exported for tests |
| `public/iso.js` | modify (shared) | the `cost` entry of `SUBPAGES` |
| `public/costcharts.js` | create | SVG chart builders (pure, exported) and the isometric treemap (Tasks 5, 6) |
| `public/index.html` | modify (shared) | sidebar entry + `#b-cost` badge, the two script tags |
| `public/app.js` | modify (shared) | `VIEWS`, `TITLES`, the mount call, the refresh cycle (Task 7), the badge (Task 8) |
| `public/monitorsview.js` | modify (shared) | "Open in Budgets" on a budget alert |
| `public/styles.css` | modify (shared) | `.cost-*` styles on the holo deck tokens |
| `docs/cost.md`, `docs/quality-metrics.md`, `README.md` | modify | the Cost Control menu, the view API, accuracy per model |
| `test/budgets-monitors.test.js` | modify | the budget alert row carries `budget` |
| `test/quality-models.test.js` | create | Task 1 |
| `test/cost-views.test.js` | create | Task 2 |
| `test/cost-views-pages.test.js` | create | Task 3 |
| `test/cost-view-api.test.js` | create | Task 4 |
| `test/cost-ui.test.js` | create | Task 7 |
| `test/cost-charts.test.js` | create | Task 5 |
| `test/cost-charts-value.test.js` | create | Task 6 |
| `test/cost-budgets-ui.test.js` | create | Task 8 |

---
### Task 1: Tool-call accuracy per model (signals, parsers, demo, `accuracyByModel`)

**Files:**
- Modify: `lib/signals.js:744-745` (before `class SignalSink`), `:777` (a method before `event(ev)`)
- Modify: `lib/claude.js:155` (`toolNames`), `:192-200` (tool results), `:279-280` (tool uses)
- Modify: `lib/codex.js:123` (`toolNames`), `:193-196` (calls), `:206-215` (outputs)
- Modify: `lib/quality.js:3` (require), `:212` (exports)
- Modify: `lib/indexer.js:15-19` (`CACHE_VERSION`)
- Modify: `lib/demo.js:185-199` (the call's model), `:212-213` and `:228-231` (per-model counts) in `buildResults`
- Test: `test/quality-models.test.js`

**Interfaces:**
- Consumes: `normalizeModel` (`lib/pricing.js`), `MODEL_FAULT` (`lib/quality.js`), `dayOf`, `addDays` (`lib/cost/days.js`, in the test).
- Produces:
  - `SignalSink#modelResult(ts, model, category = null)`: `days[YYYY-MM-DD].models[model] = { results, cats: { [category]: n } }`; `models` exists only on days that counted one.
  - `accuracyByModel(results, { from, to }) → { [normalizedModel]: { results, modelFailures, accuracy, daily: { [day]: { results, ok } } } }` exported from `lib/quality.js` (`results` is `indexer.results()`; `from`/`to` local days, both included).
  - `CACHE_VERSION === 11`.

- [ ] **Step 1: Write the failing test**

```js
// Tool-call accuracy per model (Cost Control 3a): the parsers count each tool result for the model that made the call,
// accuracyByModel sums them over a range with normalized names, and the demo signals carry the same counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sig = require('../lib/signals');
const { accuracyByModel } = require('../lib/quality');
const { CACHE_VERSION } = require('../lib/indexer');
const { buildResults } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');

// Writes synthetic log lines to a temp file and parses them with the given parser.
async function parse(parser, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-qmodels-'));
  const f = path.join(dir, 'S1.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    return (await require(`../lib/${parser}`).parseFile(f)).signals;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const at = (s) => `2026-10-16T08:00:${String(s).padStart(2, '0')}.000Z`;
const dayAt = (s) => dayOf(Date.parse(at(s)));

test('SignalSink.modelResult: counts per day and model, with the failure category; odd input is ignored', () => {
  const sink = new sig.SignalSink('claude');
  const ts = Date.parse('2026-10-01T10:00:00');
  sink.modelResult(ts, 'claude-opus-5-5');
  sink.modelResult(ts, 'claude-opus-5-5', 'hallucination');
  sink.modelResult(ts, 'gpt-6.1-sol', 'execution');
  for (const bad of [undefined, null, '', 42, '__proto__', 'constructor', 'x'.repeat(201)]) sink.modelResult(ts, bad);
  sink.modelResult(NaN, 'claude-opus-5-5');
  assert.deepEqual(sink.days['2026-10-01'].models, {
    'claude-opus-5-5': { results: 2, cats: { hallucination: 1 } },
    'gpt-6.1-sol': { results: 1, cats: { execution: 1 } },
  });
  assert.equal(Object.getPrototypeOf(sink.days['2026-10-01'].models), Object.prototype);
  const other = new sig.SignalSink('claude');
  other.count(ts, 'results');
  assert.equal(other.days['2026-10-01'].models, undefined, 'a day gets models only when one is counted');
});

test('the Claude parser counts each tool result for the model of the message that made the call', async () => {
  const base = { sessionId: 'S1', cwd: '/w' };
  const user = (s, content) => ({ ...base, type: 'user', timestamp: at(s), message: { role: 'user', content } });
  const asst = (s, id, model, content, usage = {}) => ({
    ...base,
    type: 'assistant',
    timestamp: at(s),
    requestId: `req_${id}`,
    message: { id, role: 'assistant', model, content, usage: { input_tokens: 1, output_tokens: 1, ...usage } },
  });
  const signals = await parse('claude', [
    user(1, 'fix the import'),
    asst(2, 'm1', 'claude-opus-5-5', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.js' } }]),
    user(3, [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'String to replace not found in file' }]),
    asst(4, 'm2', 'claude-sonnet-5-5', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/w/a.js' } }]),
    user(5, [{ type: 'tool_result', tool_use_id: 't2', content: 'const a = 1;' }]),
    asst(6, 'm3', 'claude-opus-5-5', [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }], {
      speed: 'fast',
    }),
    user(7, [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'Exit code 1\n FAIL src/a.test.ts' }]),
    user(8, [{ type: 'tool_result', tool_use_id: 'never-seen', content: 'ok' }]),
  ]);
  const d = signals.days[dayAt(1)];
  assert.equal(d.results, 4, 'every result still counts in the totals');
  assert.deepEqual(d.models, {
    'claude-opus-5-5': { results: 1, cats: { hallucination: 1 } },
    'claude-sonnet-5-5': { results: 1, cats: {} },
    'claude-opus-5-5-fast': { results: 1, cats: { execution: 1 } },
  });
});

test('the Codex parser counts each tool result for the model of the turn that made the call', async () => {
  const item = (s, payload) => ({ timestamp: at(s), type: 'response_item', payload });
  const ctx = (s, model) => ({ timestamp: at(s), type: 'turn_context', payload: { model } });
  const signals = await parse('codex', [
    { timestamp: at(0), type: 'session_meta', payload: { id: 'S1' } },
    ctx(1, 'gpt-6.1-sol'),
    item(2, { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["npm","i","lefpad"]}' }),
    item(3, {
      type: 'function_call_output',
      call_id: 'c1',
      output:
        '{"output":"npm ERR! code E404\\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/lefpad\\n","metadata":{"exit_code":1}}',
    }),
    item(4, { type: 'function_call', name: 'shell', call_id: 'c2', arguments: '{"command":["ls"]}' }),
    ctx(5, 'gpt-6-astra'),
    item(6, { type: 'function_call_output', call_id: 'c2', output: 'Process exited with code 0\nOutput:\na.js' }),
    item(7, { type: 'function_call', name: 'shell', call_id: 'c3', arguments: '{"command":["ls"]}' }),
    item(8, { type: 'function_call_output', call_id: 'c3', output: 'Process exited with code 0\nOutput:\na.js' }),
  ]);
  assert.deepEqual(signals.days[dayAt(1)].models, {
    'gpt-6.1-sol': { results: 2, cats: { hallucination: 1 } },
    'gpt-6-astra': { results: 1, cats: {} },
  });
});

test('accuracyByModel: model-caused failures only, over the range, with names as the ledger writes them', () => {
  const file = (days) => ({ signals: { days, events: [] } });
  const results = [
    file({
      '2026-10-01': { results: 9, models: { 'claude-opus-5-5': { results: 4, cats: { hallucination: 1 } } } },
      '2026-10-02': {
        models: {
          'anthropic/Claude-Opus-5.5': { results: 6, cats: { process: 1, execution: 3, environment: 1 } },
          'gpt-6.1-sol': { results: 10, cats: {} },
        },
      },
      '2026-09-30': { models: { 'claude-opus-5-5': { results: 100, cats: { hallucination: 100 } } } },
    }),
    file({ '2026-10-02': { results: 2 } }), // a file indexed before the per-model counts
    { signals: null },
    null,
  ];
  const a = accuracyByModel(results, { from: '2026-10-01', to: '2026-10-02' });
  assert.deepEqual(Object.keys(a).sort(), ['claude-opus-5-5', 'gpt-6.1-sol']);
  const opus = a['claude-opus-5-5'];
  assert.deepEqual([opus.results, opus.modelFailures], [10, 2], 'execution and environment are not the model');
  assert.ok(Math.abs(opus.accuracy - 0.8) < 1e-12);
  assert.deepEqual(opus.daily, { '2026-10-01': { results: 4, ok: 3 }, '2026-10-02': { results: 6, ok: 5 } });
  assert.equal(a['gpt-6.1-sol'].accuracy, 1);
  assert.deepEqual(accuracyByModel(results, { from: '2026-10-03', to: '2026-10-31' }), {});
  assert.deepEqual(accuracyByModel([], { from: '2026-10-01', to: '2026-10-31' }), {});
});

test('the demo signals count tool results per model, so the Value page has a scatter in demo mode', () => {
  const now = new Date(2026, 9, 27, 15).getTime();
  const results = buildResults(now);
  let checked = 0;
  for (const r of results)
    for (const d of Object.values(r.signals.days)) {
      if (!d.models) continue;
      const sum = Object.values(d.models).reduce((a, m) => a + m.results, 0);
      assert.equal(sum, d.results, 'per model adds up to the day');
      checked++;
    }
  assert.ok(checked > 50);
  const today = dayOf(now);
  const a = accuracyByModel(results, { from: addDays(today, -29), to: today });
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']) {
    assert.ok(a[m] && a[m].results >= 50, m);
    assert.ok(a[m].accuracy > 0.9 && a[m].accuracy <= 1, m);
  }
});

test('the index is rebuilt once for the per-model counts', () => {
  assert.equal(CACHE_VERSION, 11);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/quality-models.test.js`
Expected: FAIL (`sink.modelResult is not a function`, `accuracyByModel is not a function`, `CACHE_VERSION` is 10).

- [ ] **Step 3: `lib/signals.js`** — replace the comment line above `class SignalSink` (`:744`) with:

```js
// Model names that would reach Object.prototype as a key of `models`.
const MODEL_RESERVED = ['__proto__', 'constructor', 'prototype'];
// Collects counts per local day and a capped list of notable events for one log file.
```

and add this method after `failure(ts, category, kind) { … }`, before `event(ev)`:

```js
  // A tool result counted for the model that made the call (Cost Control: tool-call accuracy per model). The name is
  // kept as the log writes it; readers normalize it (lib/quality.js accuracyByModel). `category` is the failure's.
  modelResult(ts, model, category = null) {
    if (!Number.isFinite(ts) || typeof model !== 'string' || !model || model.length > 200) return;
    if (MODEL_RESERVED.includes(model)) return;
    const d = this.day(ts);
    const models = (d.models ||= {});
    const m = (models[model] ||= { results: 0, cats: {} });
    m.results++;
    if (category) m.cats[category] = (m.cats[category] || 0) + 1;
  }
```

`day()` is unchanged: a day gets `models` only when one is counted, so every existing day object stays as it is.

- [ ] **Step 4: `lib/claude.js`**

After `const toolNames = new Map(); …` (`:155`):

```js
  const toolModels = new Map(); // tool_use id -> the model that made the call, as the usage rows name it
```

In the tool-result loop, replace

```js
        grader.toolResult(sid, text);
        sink.count(ts, 'results');
        if (b.is_error) {
          const [category, kind] = sig.classifyError(text, tool);
          sink.failure(ts, category, kind);
          sink.event({ ts, sid, kind: 'error', category, label: kind, source: tool, text: sig.snippet(text) });
        }
```

with

```js
        grader.toolResult(sid, text);
        sink.count(ts, 'results');
        let failed = null;
        if (b.is_error) {
          const [category, kind] = sig.classifyError(text, tool);
          failed = category;
          sink.failure(ts, category, kind);
          sink.event({ ts, sid, kind: 'error', category, label: kind, source: tool, text: sig.snippet(text) });
        }
        // A result whose call this file never showed has no model: it counts in the totals only.
        sink.modelResult(ts, toolModels.get(b.tool_use_id), failed);
```

and after `toolNames.set(b.id, b.name);` (`:280`):

```js
      toolModels.set(b.id, usageOf(m).model); // fast mode is "<model>-fast", as in the ledger
```

- [ ] **Step 5: `lib/codex.js`**

After `const toolNames = new Map(); // call_id -> tool name` (`:123`):

```js
  const toolModels = new Map(); // call_id -> the model in force for the turn that made the call
```

Replace `if (p.call_id) toolNames.set(p.call_id, name);` (`:196`) with

```js
      if (p.call_id) {
        toolNames.set(p.call_id, name);
        toolModels.set(p.call_id, model);
      }
```

and in the `function_call_output` branch replace

```js
      grader.toolResult(sid, text);
      sink.count(ts, 'results');
      if (/^\s*Script failed|"exit_code":\s*[1-9]|Exit code:? [1-9]|Process exited with code [1-9]/.test(text)) {
        // Only commands get here (an exit code), so a call whose name was not seen is a shell call too.
        const [category, kind] = sig.classifyError(shellOutput(text), toolNames.get(p.call_id) || 'shell');
        sink.failure(ts, category, kind);
        sink.event({ ts, sid, kind: 'error', category, label: kind, source: tool, text: sig.snippet(text) });
      }
```

with

```js
      grader.toolResult(sid, text);
      sink.count(ts, 'results');
      let failed = null;
      if (/^\s*Script failed|"exit_code":\s*[1-9]|Exit code:? [1-9]|Process exited with code [1-9]/.test(text)) {
        // Only commands get here (an exit code), so a call whose name was not seen is a shell call too.
        const [category, kind] = sig.classifyError(shellOutput(text), toolNames.get(p.call_id) || 'shell');
        failed = category;
        sink.failure(ts, category, kind);
        sink.event({ ts, sid, kind: 'error', category, label: kind, source: tool, text: sig.snippet(text) });
      }
      // The model of the call's turn; a call this file never showed is counted for the model in force now.
      sink.modelResult(ts, toolModels.get(p.call_id) || model, failed);
```

- [ ] **Step 6: `lib/quality.js`** — after `const { CATEGORY } = require('./signals');`:

```js
const { normalizeModel } = require('./pricing');
```

and replace `module.exports = { summarizeQuality, MODEL_FAULT };` with:

```js
// Tool-call accuracy per model over the local days [from, to] (YYYY-MM-DD, both included), from the counts the parsers
// keep per model (SignalSink.modelResult): 1 − model-caused failures ÷ tool results, as on the Quality page. Names are
// normalized as the ledger's are, so Cost Control can set them beside its spend. `daily[day].ok` counts the results
// that were not a model-caused failure: the successful tool calls of the unit-cost line.
function accuracyByModel(results, { from, to }) {
  const out = new Map();
  for (const r of results || []) {
    const days = r && r.signals && r.signals.days;
    if (!days || typeof days !== 'object') continue;
    for (const [day, d] of Object.entries(days)) {
      if (day < from || day > to || !d || typeof d.models !== 'object' || !d.models) continue;
      for (const [name, m] of Object.entries(d.models)) {
        const model = normalizeModel(name);
        const n = m && Number.isFinite(m.results) ? m.results : 0;
        if (!model || !n) continue;
        const bad = MODEL_FAULT.reduce((a, c) => a + ((m.cats && Number(m.cats[c])) || 0), 0);
        if (!out.has(model)) out.set(model, { results: 0, modelFailures: 0, accuracy: null, daily: new Map() });
        const x = out.get(model);
        x.results += n;
        x.modelFailures += bad;
        if (!x.daily.has(day)) x.daily.set(day, { results: 0, ok: 0 });
        const dd = x.daily.get(day);
        dd.results += n;
        dd.ok += n - bad;
      }
    }
  }
  // Built in Maps, so no model or day name can reach Object.prototype; plain objects out.
  return Object.fromEntries(
    [...out].map(([model, x]) => [
      model,
      { ...x, accuracy: x.results ? 1 - x.modelFailures / x.results : null, daily: Object.fromEntries(x.daily) },
    ]),
  );
}

module.exports = { summarizeQuality, accuracyByModel, MODEL_FAULT };
```

- [ ] **Step 7: `lib/indexer.js`** — the version comment and constant (`:15-19`) become:

```js
// 8: usage dedup keys, price extras, prompt times, Codex fork replay skipped; detector labels and categories
// reworked (signals.js); journal. 9: injection events keep their categories, Codex JSON shell output is
// classified by its own text, corrections are graded by the parsers. 10: session turn byte offsets and
// Claude subagent links for the trace explorer. 11: tool results counted per model (tool-call accuracy per model in
// Cost Control)
const CACHE_VERSION = 11;
```

The first start after the update reindexes the logs once (the cache of version 10 is dropped, as for every bump).

- [ ] **Step 8: `lib/demo.js` `buildResults`** — the model of each call is drawn **before** the row, in the same order the row drew it, so the random sequence and every demo number stay the same. Replace

```js
        events.push([
          ts,
          tool,
          sid,
          sub
            ? weighted(r, [
                ['claude-sonnet-5-5', 6],
                ['claude-haiku-5-5', 4],
              ])
            : model,
          Math.round(2 + r() * 40),
```

with

```js
        // Drawn before the row, in the order the row drew it, so the demo's numbers stay as they were.
        const callModel = sub
          ? weighted(r, [
              ['claude-sonnet-5-5', 6],
              ['claude-haiku-5-5', 4],
            ])
          : model;
        events.push([
          ts,
          tool,
          sid,
          callModel,
          Math.round(2 + r() * 40),
```

After `count(ts, 'results');` (`:213`):

```js
        // Per model, as the parsers count them (SignalSink.modelResult): tool-call accuracy per model in Cost Control.
        const perModel = ((sday(ts).models ||= {})[callModel] ||= { results: 0, cats: {} });
        perModel.results++;
```

and in the failure block, after `d.kinds[kind] = (d.kinds[kind] || 0) + 1;` (`:231`):

```js
          perModel.cats[cat] = (perModel.cats[cat] || 0) + 1;
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test test/quality-models.test.js test/signals.test.js test/indexer.test.js test/claude-usage.test.js test/codex-usage.test.js test/insights.test.js test/budgets-demo-ui.test.js`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/signals.js lib/claude.js lib/codex.js lib/quality.js lib/indexer.js lib/demo.js test/quality-models.test.js
git commit -m "Count tool results per model in the signals, and accuracyByModel over a range"
```

---
### Task 2: `cost.cacheSaved` and the Overview data (`lib/cost/views.js`)

**Files:**
- Modify: `lib/cost/index.js:688-693` (`budgetRows` answer), after `budgetRows` (`:693`) the new `cacheSaved`, the returned object (`:733`)
- Create: `lib/cost/views.js`
- Test: `test/cost-views.test.js`

**Interfaces:**
- Consumes: `addDays`, `daysBetween`, `daysInMonth` (`lib/cost/days.js`); the evaluated budget views of `lib/cost/budgets.js` `evaluateBudget` (`id, name, scope, period, amount, currency, state, projected, percent, amountUSD`).
- Produces:
  - `cost.cacheSaved(row) → number` (USD); `cost.budgetRows({ from, to })` also returns `historyLost` (boolean).
  - `lib/cost/views.js` exports `SPIKE_RATIO` (2), `SPIKE_MIN_USD` (1), `RINGS` (8), `quantile(sorted, q)`, `budgetOrder(views)`, `overview(input)`.
  - `overview({ rows, before, today, budgets, rateOf, measure, currency, display }) →`
    ```
    { month: { from, to, today, day, days }, spent: { list, billed }, total,
      daily: [{ day, spend, cum }],
      forecast: { perDay, projected, low, high, early, line: [{ day, cum, low, high }] },
      budgetLines: [{ id, name, amount }], budgetsSkipped,
      spikes: [{ day, spend, baseline, spike, topModel }],
      rings: [{ id, name, state, tone, percent, projected }], moreBudgets,
      atRisk: { count, total }, topCenter: { center, spend, share } | null, missingRate: [day] }
    ```
    `tone` is `ok`, `warn`, `exceeded` or `none` (`no_data`). Amounts are in the chosen currency (V2).

- [ ] **Step 1: Write the failing test**

```js
// Cost Control 3a: lib/cost/views.js (what the Cost Control pages draw) and the ledger's cacheSaved. Pure: rows in,
// numbers out, no clock and no files.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/cost/views');
const { createCost } = require('../lib/cost');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);
const row = (over = {}) => ({
  day: '2026-10-01',
  source: 'claude',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  project: '~/acme-web',
  center: 'platform',
  keyId: null,
  agent: null,
  kind: 'chat',
  requests: 1,
  tokens: { in: 100, out: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 1,
  billedUSD: 1,
  priceVersion: 1,
  unpriced: false,
  free: false,
  ...over,
});
const planRow = (day, billedUSD, source = 'claude') => ({
  ...row({ day, source, provider: null, model: null, project: null, center: null, kind: 'plan', requests: 0 }),
  tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  plan: 'Claude Max',
  listUSD: 0,
  billedUSD,
});
const budget = (over = {}) => ({
  id: 'b',
  name: 'B',
  scope: 'global',
  period: 'month',
  amount: 100,
  currency: 'USD',
  state: 'ok',
  projected: false,
  percent: 10,
  amountUSD: 100,
  ...over,
});
// Five days of October: 1, 2, 3, 4 and 10 USD of usage value, each billed at half, and a plan fee of 3 on the 1st.
const FIVE = [1, 2, 3, 4, 10].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v, billedUSD: v / 2 }));

test('overview: month to date in both measures, the forecast at the mean day and the band from the quartiles', () => {
  const o = V.overview({ rows: [...FIVE, planRow('2026-10-01', 3)], today: '2026-10-05' });
  assert.deepEqual(o.month, { from: '2026-10-01', to: '2026-10-31', today: '2026-10-05', day: 5, days: 31 });
  assert.deepEqual(o.spent, { list: 20, billed: 13 }, 'a plan fee is paid, never usage value');
  assert.equal(o.total, 20);
  assert.deepEqual(
    o.daily.map((d) => [d.day, d.spend, d.cum]),
    [
      ['2026-10-01', 1, 1],
      ['2026-10-02', 2, 3],
      ['2026-10-03', 3, 6],
      ['2026-10-04', 4, 10],
      ['2026-10-05', 10, 20],
    ],
  );
  // Mean 4 a day for the 26 days left; the 25th and 75th percentile days are 2 and 4.
  assert.deepEqual([o.forecast.perDay, o.forecast.projected, o.forecast.low, o.forecast.high], [4, 124, 72, 124]);
  assert.equal(o.forecast.early, false);
  assert.equal(o.forecast.line.length, 27, 'today and each day left');
  assert.deepEqual(o.forecast.line[0], { day: '2026-10-05', cum: 20, low: 20, high: 20 });
  assert.deepEqual(o.forecast.line[26], { day: '2026-10-31', cum: 124, low: 72, high: 124 });
  const paid = V.overview({ rows: [...FIVE, planRow('2026-10-01', 3)], today: '2026-10-05', measure: 'billed' });
  assert.equal(paid.total, 13);
  assert.equal(paid.daily[0].spend, 3.5, 'the plan fee is on its day');
});

test('overview: fewer than 3 days has no band, only the forecast line, marked early', () => {
  const o = V.overview({ rows: FIVE.slice(0, 2), today: '2026-10-02' });
  assert.deepEqual([o.forecast.early, o.forecast.low, o.forecast.high], [true, null, null]);
  assert.equal(o.forecast.projected, 1.5 * 31);
  assert.ok(o.forecast.line.every((p) => p.low === null && p.high === null));
});

test('overview: converted per day; a day without a rate counts in USD and is named', () => {
  const rateOf = (day) => (day <= '2026-10-03' ? 16000 : day === '2026-10-04' ? null : 16500);
  const o = V.overview({ rows: FIVE, today: '2026-10-05', rateOf, currency: 'IDR' });
  assert.equal(o.total, 6 * 16000 + 4 + 10 * 16500);
  assert.deepEqual(o.missingRate, ['2026-10-04']);
  assert.deepEqual(V.overview({ rows: FIVE, today: '2026-10-05' }).missingRate, []);
});

test('overview: budget lines are the global monthly budgets in the chosen currency; one without a rate is skipped', () => {
  const budgets = [
    budget({ id: 'usd', name: 'Team USD', amount: 100 }),
    budget({ id: 'idr', name: 'Team IDR', amount: 1650000, currency: 'IDR' }),
    budget({ id: 'week', period: 'week' }),
    budget({ id: 'center', scope: { dim: 'center', value: 'platform' } }),
    budget({ id: 'eur', amount: 90, currency: 'EUR' }),
  ];
  const display = { code: 'IDR', rate: 16500 };
  const usd = V.overview({ rows: FIVE, today: '2026-10-05', budgets, display });
  assert.deepEqual(usd.budgetLines, [
    { id: 'usd', name: 'Team USD', amount: 100 },
    { id: 'idr', name: 'Team IDR', amount: 100 },
  ]);
  assert.equal(usd.budgetsSkipped, 1);
  const idr = V.overview({ rows: FIVE, today: '2026-10-05', budgets, display, currency: 'IDR', rateOf: () => 16500 });
  assert.deepEqual(
    idr.budgetLines.map((l) => l.amount),
    [1650000, 1650000],
  );
  const noRate = V.overview({ rows: FIVE, today: '2026-10-05', budgets, display: { code: 'IDR', rate: null } });
  assert.deepEqual(
    noRate.budgetLines.map((l) => l.id),
    ['usd'],
  );
  assert.deepEqual(V.overview({ rows: FIVE, today: '2026-10-05' }).budgetLines, []);
});

test('overview: a spike is over twice its 7-day baseline and at least $1 over it, the days before the 1st included', () => {
  const before = ['24', '25', '26', '27', '28', '29', '30'].map((d) => row({ day: `2026-09-${d}`, listUSD: 0.2 }));
  const rows = [
    row({ day: '2026-10-01', listUSD: 0.5 }), // 2.5 × its baseline, but only $0.30 over it
    row({ day: '2026-10-02', listUSD: 1, model: 'claude-opus-5-5' }),
    row({ day: '2026-10-02', listUSD: 2, model: 'claude-sonnet-5-5' }),
    row({ day: '2026-10-03', listUSD: 1 }),
  ];
  const o = V.overview({ rows, before, today: '2026-10-03', rateOf: () => 10, currency: 'XYZ' });
  assert.deepEqual(
    o.spikes.map((s) => [s.day, s.spike]),
    [
      ['2026-10-01', false],
      ['2026-10-02', true],
      ['2026-10-03', false],
    ],
  );
  const s = o.spikes[1];
  assert.equal(s.topModel, 'claude-sonnet-5-5');
  assert.equal(s.spend, 30, 'shown in the chosen currency');
  assert.equal(s.baseline, 2.4286, 'the mean of the 7 days before, rounded once');
  assert.equal(o.spikes[0].baseline, 2);
});

test('overview: rings riskiest first, at most 8; at-risk count and the top cost center', () => {
  const states = [
    ['ok', 10, false],
    ['warn_80', 85, false],
    ['exceeded', 120, false],
    ['ok', 40, true],
    ['no_data', null, false],
    ['warn_50', 55, false],
    ['ok', 5, false],
    ['ok', 1, false],
    ['ok', 2, false],
    ['exceeded', 101, false],
  ];
  const budgets = states.map(([state, percent, projected], i) =>
    budget({ id: `b${i}`, name: `B${i}`, state, percent, projected, period: 'week' }),
  );
  const rows = [
    row({ center: 'platform', listUSD: 3 }),
    row({ center: 'research', listUSD: 5, day: '2026-10-02' }),
    row({ center: null, source: 'gateway', listUSD: 2, day: '2026-10-02' }),
  ];
  const o = V.overview({ rows, today: '2026-10-02', budgets });
  assert.deepEqual(
    o.rings.map((r) => [r.id, r.tone]),
    [
      ['b2', 'exceeded'],
      ['b9', 'exceeded'],
      ['b3', 'ok'],
      ['b1', 'warn'],
      ['b5', 'warn'],
      ['b0', 'ok'],
      ['b6', 'ok'],
      ['b8', 'ok'],
    ],
  );
  assert.equal(o.moreBudgets, 2);
  assert.deepEqual(o.atRisk, { count: 5, total: 10 });
  assert.deepEqual(o.topCenter, { center: 'research', spend: 5, share: 0.5 });
  assert.equal(V.budgetOrder(budgets).pop().state, 'no_data', 'without data last');
  assert.equal(V.overview({ rows: [], today: '2026-10-02' }).topCenter, null);
});

test('cacheSaved: cache reads at the input price minus the cache read price of the row’s own version', () => {
  const cost = createCost({
    demo: {
      firstDay: '2026-10-01',
      rows: [],
      settings: {},
      versions: [
        { from: '2026-10-01', at: 0, pricing: { m: { input: 3, output: 15, cacheRead: 0.3 }, odd: { input: 1, cacheRead: 2 } } },
        { from: '2026-10-11', at: 0, pricing: { m: { input: 2, output: 10, cacheRead: 0.2 } } },
      ],
    },
    home: '/home/owner',
    now: () => new Date(2026, 9, 20, 12).getTime(),
  });
  const cached = (over) => row({ model: 'm', tokens: { in: 0, out: 0, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 }, ...over });
  near(cost.cacheSaved(cached({ priceVersion: 1 })), 2.7);
  near(cost.cacheSaved(cached({ priceVersion: 2 })), 1.8);
  for (const [why, r] of [
    ['no version', cached({ priceVersion: null })],
    ['unpriced', cached({ priceVersion: 1, unpriced: true })],
    ['free', cached({ priceVersion: 1, free: true })],
    ['plan', cached({ priceVersion: 1, kind: 'plan' })],
    ['a model the version does not price', cached({ priceVersion: 2, model: 'odd' })],
    ['cache read dearer than input', cached({ priceVersion: 1, model: 'odd' })],
    ['no cache reads', row({ model: 'm', priceVersion: 1 })],
    ['an unknown version', cached({ priceVersion: 9 })],
  ])
    assert.equal(cost.cacheSaved(r), 0, why);
  assert.equal(cost.cacheSaved(null), 0);
  assert.equal(cost.budgetRows({ from: '2026-10-01', to: '2026-10-20' }).historyLost, false, 'the view names a loss');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-views.test.js`
Expected: FAIL (`Cannot find module '../lib/cost/views'`).

- [ ] **Step 3: `lib/cost/index.js`** — in `budgetRows`, the answer gains `historyLost`:

```js
    return {
      rows,
      unread: [...rows.unread],
      billingError: billing.error() ? 'the billing history could not be read' : null,
      // Days whose billing was lost are billed as metered (rows marked billingAssumed): the Cost Control pages say so.
      historyLost: billing.lost(),
    };
  }

  // What a row's cache reads saved against paying the input price for them, in USD, at the base rates of the row's
  // price version (the version of its day). Prompt-length tiers and US-only pricing are not applied, so the Value
  // page labels it an estimate. 0 for a row without a version, an unpriced, free or plan row, a model the version
  // does not price, or a cache read that is not cheaper than input.
  function cacheSaved(row) {
    if (!row || row.kind === 'plan' || row.free || row.unpriced || !Number.isInteger(row.priceVersion)) return 0;
    const n = row.tokens && row.tokens.cacheRead;
    if (!(typeof n === 'number' && n > 0)) return 0;
    const e = prices.pricerFor(row.priceVersion).entry(row.model);
    if (!e) return 0;
    const diff = (Number(e.input) || 0) - (Number(e.cacheRead) || 0);
    return diff > 0 ? (n * diff) / 1e6 : 0;
  }
```

and in the returned object, after `budgetRows,`: `cacheSaved,`. (`prices.pricerFor` of an id it does not know prices nothing, so an unknown version saves 0.)

- [ ] **Step 4: Write `lib/cost/views.js`**

```js
// Cost Control, sub-project 3a: what the Cost Control pages draw, computed from ledger rows. Pure: no I/O and no clock
// (`today` is an argument), so the browser only draws. One function per page: overview (the current month), breakdown
// (where the money went in a range) and value (what the money bought). Served by GET /api/cost/view (lib/cost/api.js).
//
// Amounts are summed in USD, converted per day with `rateOf(day)` (the display currency's rate, or null for USD) and
// rounded once, at the end. A day with no rate is counted in USD and named in `missingRate`, as the ledger answer does.
const { addDays, daysBetween, daysInMonth } = require('./days');

const SPIKE_RATIO = 2; // a day over twice its baseline...
const SPIKE_MIN_USD = 1; // ...and at least $1 over it, so a quiet week does not make every small day a spike
const BASELINE_DAYS = 7;
const BAND_MIN_DAYS = 3; // fewer elapsed days than this: a forecast line only, no band
const RINGS = 8;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const fieldOf = (measure) => (measure === 'billed' ? 'billedUSD' : 'listUSD');
// A plan row is what was paid for a plan: no usage value, so it counts only for "Paid".
const counted = (r, measure) => !!r && (measure === 'billed' || r.kind !== 'plan');

// USD → the chosen currency, per day. `missing()` lists the days that had no rate (counted in USD).
function converter(rateOf) {
  const missing = new Set();
  return {
    conv(day, usd) {
      if (!rateOf) return usd;
      const rate = rateOf(day);
      if (rate == null) {
        missing.add(day);
        return usd;
      }
      return usd * rate;
    },
    missing: () => [...missing].sort(),
  };
}

// The q-quantile with linear interpolation between the two nearest values (the spreadsheet PERCENTILE).
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

// Sums a measure per day in USD: Map(day -> USD).
function dailyUSD(rows, measure) {
  const out = new Map();
  for (const r of rows || []) {
    if (!counted(r, measure)) continue;
    out.set(r.day, (out.get(r.day) || 0) + num(r[fieldOf(measure)]));
  }
  return out;
}

// The model that spent most per day on a measure (plan rows have no model): Map(day -> model).
function topModels(rows, measure) {
  const per = new Map();
  for (const r of rows || []) {
    if (!counted(r, measure) || !r.model) continue;
    if (!per.has(r.day)) per.set(r.day, new Map());
    const m = per.get(r.day);
    m.set(r.model, (m.get(r.model) || 0) + num(r[fieldOf(measure)]));
  }
  const out = new Map();
  for (const [day, m] of per) {
    let best = null;
    for (const [model, v] of m) if (v > 0 && (!best || v > best[1])) best = [model, v];
    if (best) out.set(day, best[0]);
  }
  return out;
}

// Budgets riskiest first: used up, then projected over, then by percent; without data last.
const RANK = (b) => (b.state === 'exceeded' ? 0 : b.projected ? 1 : b.state === 'no_data' ? 3 : 2);
function budgetOrder(views) {
  return [...(views || [])].sort(
    (a, b) => RANK(a) - RANK(b) || num(b.percent) - num(a.percent) || String(a.name).localeCompare(String(b.name)),
  );
}
const toneOf = (state) =>
  state === 'exceeded' ? 'exceeded' : state === 'no_data' ? 'none' : /^warn_/.test(String(state)) ? 'warn' : 'ok';
const atRisk = (b) => b.state === 'exceeded' || b.projected === true || /^warn_/.test(String(b.state));

// A global monthly budget's amount in the chosen currency: its own, or converted at the display currency's latest
// rate (`display`: { code, rate }). null when it cannot be converted (the line is skipped).
function lineAmount(b, currency, display) {
  if (b.currency === currency) return num(b.amount);
  const rate = display && display.rate;
  if (!rate) return null;
  if (currency === 'USD' && b.currency === display.code) return num(b.amount) / rate;
  if (currency === display.code && b.currency === 'USD') return num(b.amount) * rate;
  return null;
}

/**
 * The current month, day 1 to today. `rows` are the month's ledger rows as billed (cost.budgetRows), `before` the
 * rows of the 7 days before the 1st (the spike baseline), `budgets` the evaluated budgets, `currency` the chosen code
 * and `display` the display currency with its latest rate ({ code, rate } or null) for the budget lines.
 */
function overview({ rows = [], before = [], today, budgets = [], rateOf = null, measure = 'list', currency = 'USD', display = null }) {
  const c = converter(rateOf);
  const from = `${today.slice(0, 8)}01`;
  const days = daysInMonth(today);
  const last = `${today.slice(0, 8)}${String(days).padStart(2, '0')}`;
  const month = daysBetween(from, today);
  const elapsed = month.length;
  const remaining = days - elapsed;
  const inMonth = (rows || []).filter((r) => r && r.day >= from && r.day <= today);
  const usd = dailyUSD(inMonth, measure);
  const spent = { list: 0, billed: 0 };
  for (const m of ['list', 'billed'])
    for (const [day, v] of dailyUSD(inMonth, m)) spent[m] += c.conv(day, v);

  let cum = 0;
  const daily = month.map((day) => {
    const spend = c.conv(day, usd.get(day) || 0);
    cum += spend;
    return { day, spend, cum };
  });
  // Forecast at the mean daily spend of the elapsed days (today a whole day); the band from the 25th and 75th
  // percentile of those days, each times the days left.
  const perDay = elapsed ? cum / elapsed : 0;
  const sorted = daily.map((d) => d.spend).sort((a, b) => a - b);
  const early = elapsed < BAND_MIN_DAYS;
  const p25 = early ? null : quantile(sorted, 0.25);
  const p75 = early ? null : quantile(sorted, 0.75);
  const line = [];
  for (let k = 0; k <= remaining; k++)
    line.push({
      day: addDays(today, k),
      cum: round(cum + perDay * k),
      low: early ? null : round(cum + p25 * k),
      high: early ? null : round(cum + p75 * k),
    });

  // Spikes: each day against the mean of the 7 days before it, in USD (the $1 floor is in USD).
  const allUSD = dailyUSD([...(before || []), ...inMonth], measure);
  const top = topModels(inMonth, measure);
  const spikes = month.map((day) => {
    let base = 0;
    for (let k = 1; k <= BASELINE_DAYS; k++) base += allUSD.get(addDays(day, -k)) || 0;
    base /= BASELINE_DAYS;
    const v = allUSD.get(day) || 0;
    return {
      day,
      spend: round(c.conv(day, v)),
      baseline: round(c.conv(day, base)),
      spike: v > SPIKE_RATIO * base && v - base >= SPIKE_MIN_USD,
      topModel: top.get(day) || null,
    };
  });

  const monthly = (budgets || []).filter((b) => b && b.scope === 'global' && b.period === 'month');
  const budgetLines = [];
  for (const b of monthly) {
    const amount = lineAmount(b, currency, display);
    if (amount != null) budgetLines.push({ id: b.id, name: b.name, amount: round(amount) });
  }
  const ordered = budgetOrder(budgets);
  const centers = new Map();
  for (const r of inMonth) {
    if (!counted(r, measure) || r.kind === 'plan') continue;
    const k = r.center || 'unassigned';
    centers.set(k, (centers.get(k) || 0) + c.conv(r.day, num(r[fieldOf(measure)])));
  }
  let topCenter = null;
  for (const [center, v] of centers) if (v > 0 && (!topCenter || v > topCenter.spend)) topCenter = { center, spend: v };
  const total = measure === 'billed' ? spent.billed : spent.list;

  return {
    month: { from, to: last, today, day: elapsed, days },
    spent: { list: round(spent.list), billed: round(spent.billed) },
    total: round(total),
    daily: daily.map((d) => ({ day: d.day, spend: round(d.spend), cum: round(d.cum) })),
    forecast: {
      perDay: round(perDay),
      projected: round(cum + perDay * remaining),
      low: early ? null : round(cum + p25 * remaining),
      high: early ? null : round(cum + p75 * remaining),
      early,
      line,
    },
    budgetLines,
    budgetsSkipped: monthly.length - budgetLines.length,
    spikes,
    rings: ordered.slice(0, RINGS).map((b) => ({
      id: b.id,
      name: b.name,
      state: b.state,
      tone: toneOf(b.state),
      percent: b.percent == null ? null : b.percent,
      projected: b.projected === true,
    })),
    moreBudgets: Math.max(0, ordered.length - RINGS),
    atRisk: { count: (budgets || []).filter(atRisk).length, total: (budgets || []).length },
    topCenter: topCenter && { ...topCenter, spend: round(topCenter.spend), share: total > 0 ? topCenter.spend / total : null },
    missingRate: c.missing(),
  };
}

module.exports = { SPIKE_RATIO, SPIKE_MIN_USD, RINGS, quantile, budgetOrder, overview };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/cost-views.test.js test/cost-budgets.test.js test/cost-budget-service.test.js test/cost-api.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/cost/index.js lib/cost/views.js test/cost-views.test.js
git commit -m "Cost views: the Overview's month, forecast band, budget lines, spikes and rings; cacheSaved on the ledger"
```

---
### Task 3: Breakdown and Value data, Datasets pass rates (`lib/cost/views.js`)

**Files:**
- Modify: `lib/cost/views.js` (from Task 2): the requires, the constants, one helper, two new sections, the exports
- Test: `test/cost-views-pages.test.js`

**Interfaces:**
- Consumes: Task 2's `converter`, `quantile`, `dailyUSD`, `topModels`, `round`, `num`, `fieldOf`, `counted`; `normalizeModel` (`lib/pricing.js`); `dayOf`, `daysBetween` (`lib/cost/days.js`); `TOKENS` (`lib/cost/ledger.js`).
- Produces (added to the exports: `FLOW_TOP` (6), `TREEMAP_MAX` (40), `LITTLE_DATA` (50), `breakdown`, `passRates`, `value`):
  - `breakdown({ rows, from, to, rateOf, measure }) →`
    ```
    { total, requests, planFee,
      flow: { columns: ['source','provider','model','center'],
              nodes: [{ id: '<col>:<key>', col, key, value }], links: [{ source, target, value }] },
      treemap: [{ center, spend, blocks: [{ center, project, spend, requests, share, perRequest, projects? }] }],
      calendar: { steps: [q20, q40, q60, q80], days: [{ day, week, weekday, spend, level, topModel }] },
      missingRate }
    ```
    Special keys: `__other` (Other), `__plan` (Plan fee, provider column), `__none` (no provider or model); a block's `project` is `null` (no project) or `__other` (with `projects`, how many it joins).
  - `passRates(records, { from, to }) → { [normalizedModel]: { pass, total, rate } }` (records: the experiment store's `list()`).
  - `value({ rows, from, to, rateOf, cacheSaved, accuracy, passRates }) →`
    ```
    { plans: [{ source, plan, days, value, fee, multiplier }],
      waterfall: { withoutCache, cacheSaved, usage, planSaved, paid },
      local: { requests, tokens, models: [{ model, source, requests, tokens }] },
      scatter: { dots: [{ model, requests, spend, perRequest, accuracy, toolResults, littleData, passRate }],
                 noToolCalls: [{ model, requests, spend }] },
      unit: [{ day, perRequest, perMillionTokens, perThousandToolCalls }], missingRate }
    ```

- [ ] **Step 1: Write the failing test**

```js
// Cost Control 3a: the Breakdown and Value pages of lib/cost/views.js, and the Datasets pass rates per model.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/cost/views');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);
const tokens = (over = {}) => ({ in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over });
const row = (over = {}) => ({
  day: '2026-10-01',
  source: 'gateway',
  provider: 'openrouter',
  model: 'deepseek-chat',
  project: null,
  center: 'platform',
  keyId: 'key_a',
  agent: null,
  kind: 'chat',
  requests: 1,
  tokens: tokens({ in: 900, out: 100 }),
  listUSD: 1,
  billedUSD: 1,
  priceVersion: 1,
  unpriced: false,
  free: false,
  ...over,
});
const planRow = (day, billedUSD, source = 'claude') => ({
  ...row({ day, source, provider: null, model: null, center: null, keyId: null, kind: 'plan', requests: 0 }),
  tokens: tokens(),
  plan: 'Claude Max',
  listUSD: 0,
  billedUSD,
});
const RANGE = { from: '2026-10-01', to: '2026-10-07' };

test('breakdown flow: top 6 per column plus Other; plan fees flow from their source into Plan fee', () => {
  const rows = [];
  // Eight models on one provider: the two smallest join Other in the model column.
  for (let i = 1; i <= 8; i++) rows.push(row({ model: `m${i}`, listUSD: i, billedUSD: i }));
  rows.push(row({ source: 'claude', provider: 'anthropic', model: 'm8', center: null, listUSD: 4, billedUSD: 0 }));
  rows.push(planRow('2026-10-01', 6.5));
  const list = V.breakdown({ rows, ...RANGE });
  const models = list.flow.nodes.filter((n) => n.col === 2);
  assert.deepEqual(
    models.map((n) => [n.key, n.value]),
    [
      ['m8', 12],
      ['m7', 7],
      ['m6', 6],
      ['m5', 5],
      ['m4', 4],
      ['m3', 3],
      ['__other', 3],
    ],
  );
  assert.equal(list.flow.nodes.find((n) => n.id === 'center:unassigned').value, 4, 'no center is Unassigned');
  assert.equal(list.flow.nodes.some((n) => n.key === '__plan'), false, 'usage value has no plan fee');
  assert.equal(list.total, 40);
  const paid = V.breakdown({ rows, ...RANGE, measure: 'billed' });
  const fee = paid.flow.links.find((l) => l.target === 'provider:__plan');
  assert.deepEqual(fee, { source: 'source:claude', target: 'provider:__plan', value: 6.5 });
  assert.equal(paid.flow.nodes.some((n) => n.id === 'provider:anthropic'), false, 'a row billed 0 draws nothing');
  assert.equal(paid.planFee, 6.5);
  assert.equal(paid.total, 36 + 6.5);
  for (const l of paid.flow.links) assert.ok(l.value > 0);
});

test('breakdown treemap: one block per project in its center, height by spend per request, capped at 40', () => {
  const rows = [
    row({ source: 'claude', project: '~/acme-web', center: 'acme', listUSD: 6, requests: 2 }),
    row({ source: 'claude', project: '~/acme-web', center: 'acme', listUSD: 2, requests: 2, day: '2026-10-02' }),
    row({ source: 'codex', project: '~/lab', center: 'research', listUSD: 2, requests: 10 }),
    row({ project: null, center: 'acme', listUSD: 10, requests: 1 }),
  ];
  const t = V.breakdown({ rows, ...RANGE }).treemap;
  assert.deepEqual(
    t.map((c) => [c.center, c.spend, c.blocks.map((b) => [b.project, b.spend, b.perRequest])]),
    [
      [
        'acme',
        18,
        [
          [null, 10, 10],
          ['~/acme-web', 8, 2],
        ],
      ],
      ['research', 2, [['~/lab', 2, 0.2]]],
    ],
  );
  near(t[0].blocks[1].share, 8 / 20);
  const many = [];
  for (let i = 0; i < 50; i++)
    many.push(row({ project: `~/p${i}`, center: i % 2 ? 'a' : 'b', listUSD: 100 - i }));
  const capped = V.breakdown({ rows: many, ...RANGE }).treemap;
  const blocks = capped.flatMap((c) => c.blocks);
  assert.equal(blocks.length, 40, 'the Other blocks count toward the 40');
  const others = blocks.filter((b) => b.project === '__other');
  assert.deepEqual(others.map((b) => b.center).sort(), ['a', 'b']);
  assert.equal(others.reduce((a, b) => a + b.projects, 0), 12);
  near(
    blocks.reduce((a, b) => a + b.spend, 0),
    many.reduce((a, r) => a + r.listUSD, 0),
  );
});

test('breakdown calendar: weeks by weekday, 5 quantile steps over the non-zero days, empty days at level 0', () => {
  // 2026-10-01 is a Thursday.
  const rows = [1, 2, 3, 4, 5, 6].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v, model: `m${v}` }));
  const cal = V.breakdown({ rows, from: '2026-10-01', to: '2026-10-08' }).calendar;
  assert.deepEqual(cal.steps, [2, 3, 4, 5]);
  assert.deepEqual(
    cal.days.map((d) => [d.day, d.week, d.weekday, d.level]),
    [
      ['2026-10-01', 0, 3, 1],
      ['2026-10-02', 0, 4, 1],
      ['2026-10-03', 0, 5, 2],
      ['2026-10-04', 0, 6, 3],
      ['2026-10-05', 1, 0, 4],
      ['2026-10-06', 1, 1, 5],
      ['2026-10-07', 1, 2, 0],
      ['2026-10-08', 1, 3, 0],
    ],
  );
  assert.equal(cal.days[5].topModel, 'm6');
  assert.equal(cal.days[6].topModel, null);
  assert.deepEqual(V.breakdown({ rows: [], ...RANGE }).calendar.steps, []);
});

test('breakdown: converted per day, a day without a rate in USD and named', () => {
  const rows = [row({ listUSD: 2 }), row({ day: '2026-10-02', listUSD: 3 })];
  const b = V.breakdown({ rows, ...RANGE, rateOf: (d) => (d === '2026-10-01' ? 100 : null) });
  assert.equal(b.total, 203);
  assert.deepEqual(b.missingRate, ['2026-10-02']);
});

test('value: plan value against its fee, with the multiplier; below 1 when the plan cost more', () => {
  const rows = [
    row({ source: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', listUSD: 41, billedUSD: 0 }),
    planRow('2026-10-01', 10),
    row({ source: 'codex', provider: 'openai', model: 'gpt-6.1-sol', listUSD: 3, billedUSD: 0 }),
    planRow('2026-10-01', 5, 'codex'),
    row({ source: 'claude', day: '2026-10-09', listUSD: 99 }), // outside the range
  ];
  const v = V.value({ rows, ...RANGE });
  assert.deepEqual(v.plans, [
    { source: 'claude', plan: 'Claude Max', days: 1, value: 41, fee: 10, multiplier: 4.1 },
    { source: 'codex', plan: 'Claude Max', days: 1, value: 3, fee: 5, multiplier: 0.6 },
  ]);
});

test('value: the waterfall steps add up to what was paid; free rows add no money', () => {
  const rows = [
    row({ source: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', listUSD: 40, billedUSD: 0 }),
    planRow('2026-10-01', 10),
    row({ listUSD: 5, billedUSD: 5 }),
    row({ source: 'judge', provider: 'ollama', model: 'qwen3:8b', listUSD: 0, billedUSD: 0, free: true, requests: 20 }),
  ];
  const cacheSaved = (r) => (r.model === 'claude-opus-5-5' ? 8 : r.free ? 99 : 0);
  const w = V.value({ rows, ...RANGE, cacheSaved: (r) => (r.free ? 0 : cacheSaved(r)) }).waterfall;
  assert.deepEqual(w, { withoutCache: 53, cacheSaved: 8, usage: 45, planSaved: 30, paid: 15 });
  near(w.withoutCache - w.cacheSaved - w.planSaved, w.paid);
  const dearer = V.value({ rows: [row({ listUSD: 1, billedUSD: 0, source: 'claude' }), planRow('2026-10-01', 3)], ...RANGE });
  assert.equal(dearer.waterfall.planSaved, -2, 'a plan that cost more is a step up');
});

test('value: local models show requests and tokens only', () => {
  const rows = [
    row({ source: 'judge', provider: 'ollama', model: 'qwen3:8b', free: true, listUSD: 0, requests: 20, tokens: tokens({ in: 1500, out: 60 }) }),
    row({ source: 'judge', provider: 'ollama', model: 'qwen3:8b', free: true, listUSD: 0, requests: 5, day: '2026-10-02', tokens: tokens({ in: 10 }) }),
    row({ listUSD: 1 }),
  ];
  const l = V.value({ rows, ...RANGE }).local;
  assert.deepEqual(l, { requests: 25, tokens: 1570, models: [{ model: 'qwen3:8b', source: 'judge', requests: 25, tokens: 1570 }] });
});

test('value: the scatter has a dot per measured model, hollow under 50 results, pass rates in the tooltip', () => {
  const rows = [
    row({ source: 'claude', model: 'claude-opus-5-5', listUSD: 10, requests: 4 }),
    row({ source: 'codex', model: 'gpt-6.1-sol', listUSD: 2, requests: 8 }),
    row({ model: 'deepseek-chat', listUSD: 1, requests: 50 }),
    row({ model: 'idle-model', listUSD: 0, requests: 0 }),
  ];
  const accuracy = {
    'claude-opus-5-5': { results: 200, modelFailures: 4, accuracy: 0.98, daily: {} },
    'gpt-6.1-sol': { results: 12, modelFailures: 0, accuracy: 1, daily: {} },
    'not-in-the-ledger': { results: 900, modelFailures: 0, accuracy: 1, daily: {} },
  };
  const passRates = { 'claude-opus-5-5': { pass: 3, total: 4, rate: 0.75 } };
  const s = V.value({ rows, ...RANGE, accuracy, passRates }).scatter;
  assert.deepEqual(
    s.dots.map((d) => [d.model, d.perRequest, d.accuracy, d.toolResults, d.littleData, d.passRate && d.passRate.rate]),
    [
      ['claude-opus-5-5', 2.5, 0.98, 200, false, 0.75],
      ['gpt-6.1-sol', 0.25, 1, 12, true, null],
    ],
  );
  assert.deepEqual(s.noToolCalls, [{ model: 'deepseek-chat', requests: 50, spend: 1 }]);
});

test('value: unit-cost lines per day, with a gap where the denominator is missing', () => {
  const rows = [
    row({ source: 'claude', model: 'claude-opus-5-5', listUSD: 6, requests: 3, tokens: tokens({ in: 1e6, cacheRead: 1e6 }) }),
    row({ listUSD: 2, requests: 1, tokens: tokens({ in: 0 }) }),
    row({ day: '2026-10-02', listUSD: 0, requests: 0, tokens: tokens() }),
  ];
  const accuracy = { 'claude-opus-5-5': { results: 3000, daily: { '2026-10-01': { results: 3000, ok: 2000 } } } };
  const u = V.value({ rows, ...RANGE, accuracy }).unit;
  assert.equal(u.length, 7);
  assert.deepEqual(u[0], { day: '2026-10-01', perRequest: 2, perMillionTokens: 4, perThousandToolCalls: 3 });
  assert.deepEqual(u[1], { day: '2026-10-02', perRequest: null, perMillionTokens: null, perThousandToolCalls: null });
});

test('passRates: experiments that ended in the range, summed over their evaluators, names normalized', () => {
  const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
  const rec = (endedAt, models) => ({
    endedAt,
    summary: {
      models: Object.fromEntries(
        Object.entries(models).map(([m, evs]) => [
          m,
          { evaluators: Object.fromEntries(evs.map(([pass, total], i) => [`e${i}`, { pass, total }])) },
        ]),
      ),
    },
  });
  const records = [
    rec(at(2), { 'anthropic/claude-haiku-5-5': [[1, 2], [2, 2]], 'ollama/qwen3-coder:30b': [[0, 0]] }),
    rec(at(5), { 'claude-haiku-5-5': [[1, 1]] }),
    rec(at(20), { 'claude-haiku-5-5': [[0, 9]] }), // ended outside the range
    { endedAt: null },
    null,
  ];
  assert.deepEqual(V.passRates(records, RANGE), { 'claude-haiku-5-5': { pass: 4, total: 5, rate: 0.8 } });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-views-pages.test.js`
Expected: FAIL (`V.breakdown is not a function`).

- [ ] **Step 3: The top of `lib/cost/views.js`**

Replace the require line `const { addDays, daysBetween, daysInMonth } = require('./days');` with:

```js
const { normalizeModel } = require('../pricing');
const { addDays, daysBetween, daysInMonth, dayOf } = require('./days');
const { TOKENS } = require('./ledger');
```

after `const RINGS = 8;`:

```js
const FLOW_TOP = 6;
const TREEMAP_MAX = 40;
const LITTLE_DATA = 50; // tool results below this: the accuracy is drawn hollow
const OTHER = '__other';
const PLAN = '__plan';
const NONE = '__none';
```

and after `const counted = …`:

```js
const tokensOf = (r) => TOKENS.reduce((a, f) => a + num(r.tokens && r.tokens[f]), 0);
```

- [ ] **Step 4: The two sections** — insert before `module.exports`:

```js
// ---- Breakdown ----

const FLOW_COLS = ['source', 'provider', 'model', 'center'];
const LAST = (n) => (n.key === OTHER || n.key === PLAN ? 1 : 0);
const keyOf = (r, col) => (col === 'center' ? r.center || 'unassigned' : r[col] == null ? NONE : String(r[col]));

// The top `n` keys of a column by spend; the rest become "Other".
function topKeys(sums, n) {
  return new Set(
    [...sums]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([k]) => k),
  );
}

// Source → provider → model → cost center. Each column keeps its top 6 by spend and joins the rest into "Other";
// a plan row (Paid) flows from its source into "Plan fee", as it has no provider, model or center.
function flowOf(items) {
  const usage = items.filter((x) => x.r.kind !== 'plan');
  const keep = {};
  for (const col of FLOW_COLS) {
    const sums = new Map();
    for (const { r, v } of usage) sums.set(keyOf(r, col), (sums.get(keyOf(r, col)) || 0) + v);
    if (col === 'source') for (const { r, v } of items) if (r.kind === 'plan') sums.set(r.source, (sums.get(r.source) || 0) + v);
    keep[col] = topKeys(sums, FLOW_TOP);
  }
  const nodes = new Map();
  const links = new Map();
  const node = (col, key) => {
    const k = keep[col].has(key) || key === PLAN ? key : OTHER;
    const id = `${col}:${k}`;
    if (!nodes.has(id)) nodes.set(id, { id, col: FLOW_COLS.indexOf(col), key: k, value: 0 });
    return nodes.get(id);
  };
  const link = (a, b, v) => {
    const id = `${a.id}>${b.id}`;
    if (!links.has(id)) links.set(id, { source: a.id, target: b.id, value: 0 });
    links.get(id).value += v;
  };
  for (const { r, v } of items) {
    if (!(v > 0)) continue;
    const path =
      r.kind === 'plan'
        ? [node('source', r.source), node('provider', PLAN)]
        : FLOW_COLS.map((col) => node(col, keyOf(r, col)));
    for (const n of path) n.value += v;
    for (let i = 1; i < path.length; i++) link(path[i - 1], path[i], v);
  }
  return {
    columns: FLOW_COLS,
    // Per column by spend, with Other and Plan fee last.
    nodes: [...nodes.values()]
      .map((n) => ({ ...n, value: round(n.value) }))
      .sort((a, b) => a.col - b.col || LAST(a) - LAST(b) || b.value - a.value),
    links: [...links.values()].map((l) => ({ ...l, value: round(l.value) })).sort((a, b) => b.value - a.value),
  };
}

// One block per project, grouped by cost center: footprint by spend, height by spend per request. At most 40 blocks;
// the rest join one "Other" block per center. Plan fees have no project or center: they are reported beside it.
function treemapOf(items) {
  const blocks = new Map();
  for (const { r, v } of items) {
    if (r.kind === 'plan') continue;
    const center = r.center || 'unassigned';
    const k = JSON.stringify([center, r.project || null]);
    if (!blocks.has(k)) blocks.set(k, { center, project: r.project || null, spend: 0, requests: 0 });
    const b = blocks.get(k);
    b.spend += v;
    b.requests += num(r.requests);
  }
  const sorted = [...blocks.values()]
    .filter((b) => b.spend > 0)
    .sort((a, b) => b.spend - a.spend || String(a.project).localeCompare(String(b.project)));
  let kept = sorted;
  let rest = [];
  if (sorted.length > TREEMAP_MAX) {
    let n = TREEMAP_MAX;
    // The "Other" blocks count toward the 40 too.
    while (n > 0 && n + new Set(sorted.slice(n).map((b) => b.center)).size > TREEMAP_MAX) n--;
    kept = sorted.slice(0, n);
    rest = sorted.slice(n);
  }
  const others = new Map();
  for (const b of rest) {
    if (!others.has(b.center)) others.set(b.center, { center: b.center, project: OTHER, spend: 0, requests: 0, projects: 0 });
    const o = others.get(b.center);
    o.spend += b.spend;
    o.requests += b.requests;
    o.projects++;
  }
  const total = sorted.reduce((a, b) => a + b.spend, 0);
  const centers = new Map();
  for (const b of [...kept, ...others.values()]) {
    if (!centers.has(b.center)) centers.set(b.center, { center: b.center, spend: 0, blocks: [] });
    const c = centers.get(b.center);
    c.spend += b.spend;
    c.blocks.push({
      ...b,
      spend: round(b.spend),
      share: total > 0 ? b.spend / total : 0,
      perRequest: b.requests ? round(b.spend / b.requests) : null,
    });
  }
  return [...centers.values()].map((c) => ({ ...c, spend: round(c.spend) })).sort((a, b) => b.spend - a.spend);
}

// Monday 0 … Sunday 6, from the date alone.
const weekday = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
};

// Weeks as columns, Monday to Sunday as rows; 5 color steps at the quantiles of the range's non-zero days.
function calendarOf(dayList, spendOf, topOf) {
  const first = dayList.length ? weekday(dayList[0]) : 0;
  const nonZero = dayList
    .map(spendOf)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const steps = nonZero.length ? [0.2, 0.4, 0.6, 0.8].map((q) => quantile(nonZero, q)) : [];
  return {
    steps: steps.map(round),
    days: dayList.map((day, i) => {
      const spend = spendOf(day);
      return {
        day,
        week: Math.floor((i + first) / 7),
        weekday: weekday(day),
        spend: round(spend),
        level: spend > 0 ? 1 + steps.filter((t) => spend > t).length : 0,
        topModel: topOf(day),
      };
    }),
  };
}

/** Where the money went in [from, to]: the flow, the project blocks and the calendar, on one measure. */
function breakdown({ rows = [], from, to, rateOf = null, measure = 'list' }) {
  const c = converter(rateOf);
  const field = fieldOf(measure);
  const items = [];
  let requests = 0;
  for (const r of rows || []) {
    if (!r || r.day < from || r.day > to || !counted(r, measure)) continue;
    items.push({ r, v: c.conv(r.day, num(r[field])) });
    if (r.kind !== 'plan') requests += num(r.requests);
  }
  const perDay = new Map();
  for (const { r, v } of items) perDay.set(r.day, (perDay.get(r.day) || 0) + v);
  const top = topModels(
    items.map((x) => x.r),
    measure,
  );
  const total = items.reduce((a, x) => a + x.v, 0);
  const planFee = items.filter((x) => x.r.kind === 'plan').reduce((a, x) => a + x.v, 0);
  return {
    total: round(total),
    requests,
    planFee: round(planFee),
    flow: flowOf(items),
    treemap: treemapOf(items),
    calendar: calendarOf(
      daysBetween(from, to),
      (day) => perDay.get(day) || 0,
      (day) => top.get(day) || null,
    ),
    missingRate: c.missing(),
  };
}

// ---- Value ----

// Over the experiments that ended in [from, to] and ran a model: its passes over its totals across every evaluator.
// Model names are normalized as the ledger's are. Records are the experiment store's list (lib/datasets/experiments.js).
function passRates(records, { from, to }) {
  const out = new Map();
  for (const x of records || []) {
    if (!x || !Number.isFinite(x.endedAt)) continue;
    const day = dayOf(x.endedAt);
    if (day < from || day > to) continue;
    const models = (x.summary && x.summary.models) || {};
    for (const [name, m] of Object.entries(models)) {
      const model = normalizeModel(name);
      if (!model || !m || !m.evaluators) continue;
      if (!out.has(model)) out.set(model, { pass: 0, total: 0 });
      const o = out.get(model);
      for (const e of Object.values(m.evaluators)) {
        o.pass += num(e && e.pass);
        o.total += num(e && e.total);
      }
    }
  }
  return Object.fromEntries([...out].filter(([, o]) => o.total > 0).map(([k, o]) => [k, { ...o, rate: o.pass / o.total }]));
}

/**
 * What the money bought in [from, to]: plan value against plan fee, the savings waterfall, local models, cost against
 * tool-call accuracy and unit costs. Both measures by nature: usage value (list) and what was paid (billed).
 * `cacheSaved(row)` is the ledger's USD cache saving of a row, `accuracy` lib/quality.js accuracyByModel over the same
 * range, `passRates` this file's passRates.
 */
function value({ rows = [], from, to, rateOf = null, cacheSaved = () => 0, accuracy = {}, passRates: pr = {} }) {
  const c = converter(rateOf);
  const inRange = (rows || []).filter((r) => r && r.day >= from && r.day <= to);
  const usage = inRange.filter((r) => r.kind !== 'plan');
  const plan = inRange.filter((r) => r.kind === 'plan');

  // Plan value against plan fee, per source: the usage value of its plan days against the fee of those days.
  const plans = new Map();
  for (const r of plan) {
    if (!plans.has(r.source)) plans.set(r.source, { source: r.source, plan: r.plan || null, days: new Set(), value: 0, fee: 0 });
    const p = plans.get(r.source);
    p.days.add(r.day);
    p.fee += c.conv(r.day, num(r.billedUSD));
    if (r.plan) p.plan = r.plan;
  }
  for (const r of usage) {
    const p = plans.get(r.source);
    if (p && p.days.has(r.day)) p.value += c.conv(r.day, num(r.listUSD));
  }

  // The waterfall: without cache → cache savings → plan savings → paid. The steps add up to what was paid.
  let used = 0;
  let saved = 0;
  let paid = 0;
  for (const r of usage) {
    used += c.conv(r.day, num(r.listUSD));
    saved += c.conv(r.day, num(cacheSaved(r)));
  }
  for (const r of inRange) paid += c.conv(r.day, num(r.billedUSD));

  // Local models: free rows carry tokens and requests, never money.
  const local = new Map();
  for (const r of usage) {
    if (!r.free) continue;
    const k = r.model || NONE;
    if (!local.has(k)) local.set(k, { model: r.model || null, source: r.source, requests: 0, tokens: 0 });
    const l = local.get(k);
    l.requests += num(r.requests);
    l.tokens += tokensOf(r);
  }

  // Cost against quality, one dot per model with a request in the range; usage value, so a plan does not hide it.
  const models = new Map();
  for (const r of usage) {
    if (!r.model || !(num(r.requests) > 0)) continue;
    if (!models.has(r.model)) models.set(r.model, { model: r.model, requests: 0, spend: 0 });
    const m = models.get(r.model);
    m.requests += num(r.requests);
    m.spend += c.conv(r.day, num(r.listUSD));
  }
  const dots = [];
  const noToolCalls = [];
  for (const m of [...models.values()].sort((a, b) => b.spend - a.spend || a.model.localeCompare(b.model))) {
    const q = Object.hasOwn(accuracy || {}, m.model) ? accuracy[m.model] : null;
    const base = { model: m.model, requests: m.requests, spend: round(m.spend) };
    if (!q || !(q.results > 0)) {
      noToolCalls.push(base);
      continue;
    }
    const p = Object.hasOwn(pr || {}, m.model) ? pr[m.model] : null;
    dots.push({
      ...base,
      perRequest: round(m.spend / m.requests),
      accuracy: q.accuracy,
      toolResults: q.results,
      littleData: q.results < LITTLE_DATA,
      passRate: p ? { pass: p.pass, total: p.total, rate: p.total ? p.pass / p.total : null } : null,
    });
  }

  // Unit costs per day, on usage value; a day without its denominator has no point (null), never zero.
  const ok = new Map();
  for (const q of Object.values(accuracy || {}))
    for (const [day, d] of Object.entries((q && q.daily) || {})) ok.set(day, (ok.get(day) || 0) + num(d && d.ok));
  const per = new Map();
  for (const r of usage) {
    if (!per.has(r.day)) per.set(r.day, { spend: 0, requests: 0, tokens: 0, local: 0 });
    const d = per.get(r.day);
    const v = c.conv(r.day, num(r.listUSD));
    d.spend += v;
    d.requests += num(r.requests);
    d.tokens += tokensOf(r);
    if (r.source === 'claude' || r.source === 'codex') d.local += v;
  }
  const unit = daysBetween(from, to).map((day) => {
    const d = per.get(day) || { spend: 0, requests: 0, tokens: 0, local: 0 };
    const k = ok.get(day) || 0;
    return {
      day,
      perRequest: d.requests ? round(d.spend / d.requests) : null,
      perMillionTokens: d.tokens ? round(d.spend / (d.tokens / 1e6)) : null,
      perThousandToolCalls: k ? round(d.local / (k / 1000)) : null,
    };
  });

  return {
    plans: [...plans.values()]
      .map((p) => ({
        source: p.source,
        plan: p.plan,
        days: p.days.size,
        value: round(p.value),
        fee: round(p.fee),
        multiplier: p.fee > 0 ? Math.round((p.value / p.fee) * 100) / 100 : null,
      }))
      .sort((a, b) => b.fee - a.fee),
    waterfall: {
      withoutCache: round(used + saved),
      cacheSaved: round(saved),
      usage: round(used),
      planSaved: round(used - paid),
      paid: round(paid),
    },
    local: {
      requests: [...local.values()].reduce((a, l) => a + l.requests, 0),
      tokens: [...local.values()].reduce((a, l) => a + l.tokens, 0),
      models: [...local.values()].sort((a, b) => b.requests - a.requests),
    },
    scatter: { dots, noToolCalls },
    unit,
    missingRate: c.missing(),
  };
}

```

and replace the `module.exports` line with:

```js
module.exports = {
  SPIKE_RATIO,
  SPIKE_MIN_USD,
  RINGS,
  FLOW_TOP,
  TREEMAP_MAX,
  LITTLE_DATA,
  quantile,
  budgetOrder,
  overview,
  breakdown,
  passRates,
  value,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/cost-views-pages.test.js test/cost-views.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/cost/views.js test/cost-views-pages.test.js
git commit -m "Cost views: the Breakdown flow, treemap and calendar; the Value plans, waterfall, scatter and unit costs"
```

---
### Task 4: `GET /api/cost/view` and its wiring (shared: `lib/cost/api.js`, `server.js`)

**Files:**
- Modify: `lib/cost/api.js:6-8` (requires), `:13` (constants), `:35-39` (options), before `function keys()` (`:81`), the `GET` table (`:189`)
- Modify: `server.js:54` (requires), before `const costApi = createCostApi({` (`:494`), its options (`:502-503`)
- Test: `test/cost-view-api.test.js`

**Interfaces:**
- Consumes: `views.overview`, `views.breakdown`, `views.value`, `views.passRates` (Tasks 2–3); `accuracyByModel` (Task 1); `cost.budgetRows` (with `historyLost`) and `cost.cacheSaved` (Task 2); `budgets.evaluate()` (`lib/cost/budget-service.js`); `rateFor` (`lib/cost/rules.js`); `experiments.list()` (`lib/datasets/experiments.js`); `indexer.version`, `indexer.results()`.
- Produces:
  - `createCostApi({ …, accuracy = () => ({}), passRates = () => ({}) })`: both take `{ from, to }`.
  - `GET /api/cost/view?page=overview|breakdown|value&from&to&currency&measure` → 200 with `{ page, from, to, currency, measure, unread, billing: { error, historyLost }, …page data, missingRate }`; 400 `{ error }` for an unknown page or measure, a currency without rates, a bad date, `from > to` or more than 400 days (Overview ignores `from`/`to`); 503 `{ error, code }` when the ledger is unavailable. A Breakdown or Value view without dates is the last 30 days.

- [ ] **Step 1: Write the failing test**

```js
// GET /api/cost/view (Cost Control 3a): in-process on the demo ledger, then a spawned server.js for the demo answers
// and the sign-in. No real provider, no network: pricing sync is off and the gateway has no upstream.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { createBudgetService } = require('../lib/cost/budget-service');
const { costDemo } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');
const { createGateway } = require('../lib/gateway');
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const NOW = new Date(2026, 9, 22, 15).getTime(); // a Thursday afternoon, 70 % into October
const TODAY = dayOf(NOW);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, msg || `${a} is not ${b}`);

function setup({ accuracy, passRates, cost: fake } = {}) {
  const d = costDemo(NOW);
  const cost =
    fake || createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => NOW, nocase: false });
  const budgets = fake
    ? null
    : createBudgetService({
        getSettings: () => d.settings,
        getLegacy: () => ({ monthlyBudgetUSD: 1000, keys: [] }),
        cost,
        home: HOME,
        now: () => NOW,
        nocase: false,
        demo: { noData: d.budgetNoData },
      });
  const seen = [];
  const api = createCostApi({
    cost,
    settings: { get: () => d.settings, save: () => {} },
    home: HOME,
    now: () => NOW,
    budgets,
    accuracy:
      accuracy ||
      ((range) => {
        seen.push(range);
        return { 'claude-opus-5-5': { results: 300, modelFailures: 3, accuracy: 0.99, daily: {} } };
      }),
    passRates: passRates || (() => ({ 'claude-opus-5-5': { pass: 3, total: 4, rate: 0.75 } })),
  });
  const bodies = [];
  const get = async (query) => {
    const r = await api.route({ method: 'GET', path: '/api/cost/view', query: new URLSearchParams(query) });
    bodies.push(JSON.stringify(r.body));
    return r;
  };
  return { get, bodies, seen, d };
}

test('cost view: the Overview of the demo month, with the global monthly budgets as lines', async () => {
  const s = setup();
  const r = await s.get('page=overview&from=garbage');
  assert.equal(r.status, 200, 'Overview ignores from and to');
  const o = r.body;
  assert.deepEqual([o.page, o.from, o.to, o.currency, o.measure], ['overview', '2026-10-01', TODAY, 'USD', 'list']);
  assert.deepEqual(o.unread, []);
  assert.deepEqual(o.billing, { error: null, historyLost: false });
  assert.deepEqual(o.missingRate, []);
  assert.equal(o.month.day, 22);
  assert.equal(o.daily.length, 22);
  assert.ok(o.total > 0 && o.forecast.projected > o.total);
  assert.ok(o.forecast.low <= o.forecast.projected && o.forecast.projected <= o.forecast.high + 1e-9);
  const lines = Object.fromEntries(o.budgetLines.map((l) => [l.id, l.amount]));
  assert.equal(lines['legacy-monthly'], 1000);
  assert.ok(lines.team > 0, 'the IDR budget at the latest rate');
  assert.equal(o.rings[0].id, 'acme-gateway', 'the used-up budget first');
  assert.equal(o.rings[0].tone, 'exceeded');
  const idr = (await s.get('page=overview&currency=IDR')).body;
  assert.equal(idr.currency, 'IDR');
  assert.ok(idr.total > o.total * 16000);
  assert.equal(idr.budgetLines.find((l) => l.id === 'legacy-monthly').amount, 1000 * 16420);
  const paid = (await s.get('page=overview&measure=billed')).body;
  assert.equal(paid.measure, 'billed');
  assert.equal(paid.spent.billed, paid.total);
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('cost view: Breakdown and Value over a range, with the quality readers given the same range', async () => {
  const s = setup();
  const from = addDays(TODAY, -6);
  const b = (await s.get(`page=breakdown&from=${from}&to=${TODAY}`)).body;
  assert.deepEqual([b.from, b.to], [from, TODAY]);
  assert.ok(b.flow.nodes.some((n) => n.id === 'source:claude'));
  assert.ok(b.treemap.length >= 3, 'a block group per center');
  assert.equal(b.calendar.days.length, 7);
  const dflt = (await s.get('page=breakdown')).body;
  assert.deepEqual([dflt.from, dflt.to], [addDays(TODAY, -29), TODAY], 'the last 30 days by default');
  const v = (await s.get(`page=value&from=${from}&to=${TODAY}&measure=billed`)).body;
  assert.equal(v.measure, 'billed');
  assert.deepEqual(s.seen.pop(), { from, to: TODAY });
  assert.equal(v.plans[0].source, 'claude');
  assert.ok(v.plans[0].multiplier > 0);
  const w = v.waterfall;
  near(w.withoutCache - w.cacheSaved - w.planSaved, w.paid);
  assert.ok(w.cacheSaved > 0, 'the demo reads its cache');
  const opus = v.scatter.dots.find((x) => x.model === 'claude-opus-5-5');
  assert.deepEqual([opus.accuracy, opus.passRate.rate], [0.99, 0.75]);
  assert.ok(v.scatter.noToolCalls.some((x) => x.model === 'deepseek-chat'));
  assert.ok(v.local.requests > 0, 'the free local judge');
  assert.equal(v.unit.length, 7);
});

test('cost view: 400 for a bad page, measure, currency or range; quality readers that throw leave the scatter empty', async () => {
  const s = setup({
    accuracy: () => {
      throw new Error(`index unreadable at ${path.join(HOME, '.cache', 'index.json')}`);
    },
    passRates: () => {
      throw new Error('no store');
    },
  });
  for (const [q, why] of [
    ['', /page: overview, breakdown, value/],
    ['page=settings', /page/],
    ['page=overview&measure=both', /measure: list or billed/],
    ['page=breakdown&currency=EUR', /no rates for that currency/],
    ['page=value&from=2026-10-40', /dates/],
    ['page=value&from=2026-10-20&to=2026-10-01', /on or before/],
    ['page=breakdown&from=2025-01-01&to=2026-10-22', /at most 400 days/],
  ]) {
    const r = await s.get(q);
    assert.equal(r.status, 400, q);
    assert.match(r.body.error, why, q);
  }
  const v = await s.get('page=value');
  assert.equal(v.status, 200);
  assert.deepEqual(v.body.scatter.dots, []);
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('cost view: a ledger that is not available is a path-free 503 with its code', async () => {
  const where = path.join(HOME, '.data', 'cost', 'ledger-2026-10.jsonl');
  const fake = {
    budgetRows: () => {
      throw Object.assign(new Error(`not available at ${where}`), { code: 'LEDGER_MONTH_UNREAD' });
    },
  };
  const s = setup({ cost: fake });
  for (const page of ['overview', 'breakdown', 'value']) {
    const r = await s.get(`page=${page}`);
    assert.equal(r.status, 503, page);
    assert.equal(r.body.code, 'LEDGER_MONTH_UNREAD');
    assert.doesNotMatch(JSON.stringify(r.body), PATHS);
  }
});

// ---- over HTTP ----

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-view-'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own: no other test uses 8800-9199.
    const port = 8800 + Math.floor(Math.random() * 400);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
async function startServer(env, { data = tmp() } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        CLAUDE_CONFIG_DIR: '',
        ZAAFPULSE_CLAUDE_DIRS: '',
        XDG_CONFIG_HOME: '',
        CODEX_HOME: '',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
      },
      stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const base = `http://127.0.0.1:${port}`;
    const kill = async () => {
      if (!exited) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
    };
    const stop = async () => {
      await kill();
      fs.rmSync(data, { recursive: true, force: true });
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { base, stop };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  fs.rmSync(data, { recursive: true, force: true });
  throw new Error('could not start server.js on a free port');
}
function client(base, headers = {}) {
  const bodies = [];
  const call = async (p) => {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(10000), headers });
    const text = await r.text();
    bodies.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  };
  return { call, bodies };
}

test('cost view over HTTP: every demo page answers, Value with a scatter from the demo signals, path-free', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const o = await c.call('/api/cost/view?page=overview');
    assert.equal(o.status, 200);
    assert.ok(o.json.rings.length > 0);
    assert.ok(o.json.budgetLines.some((l) => l.id === 'legacy-monthly'));
    const b = await c.call('/api/cost/view?page=breakdown&measure=billed&currency=IDR');
    assert.equal(b.status, 200);
    assert.ok(b.json.flow.links.some((l) => l.target === 'provider:__plan'), 'the Claude plan fee');
    const v = await c.call('/api/cost/view?page=value');
    assert.equal(v.status, 200);
    const models = v.json.scatter.dots.map((d) => d.model);
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']) assert.ok(models.includes(m), m);
    for (const body of c.bodies) assert.doesNotMatch(body, PATHS);
  } finally {
    await s.stop();
  }
});

test('cost view over HTTP: the dashboard sign-in only, never a gateway key', async () => {
  const data = tmp();
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const { secret } = gw.keys.create({ name: 'app', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 });
  gw.flush();
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ pricingSync: { enabled: false } }));
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  try {
    const bearer = client(s.base, { authorization: `Bearer ${secret}`, 'x-api-key': secret });
    for (const who of [client(s.base), bearer])
      for (const page of ['overview', 'breakdown', 'value'])
        assert.equal((await who.call(`/api/cost/view?page=${page}`)).status, 401, page);
    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const c = client(s.base, { cookie });
    const r = await c.call('/api/cost/view?page=value');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.scatter, { dots: [], noToolCalls: [] }, 'an empty ledger');
    assert.equal((await c.call('/api/cost/view?page=nope')).status, 400);
    for (const body of [...c.bodies, ...bearer.bodies]) assert.doesNotMatch(body, PATHS);
  } finally {
    await s.stop();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-view-api.test.js`
Expected: FAIL (`/api/cost/view` answers 404 `unknown route`).

- [ ] **Step 3: Edit `lib/cost/api.js`**

1. Requires (`:6-8`):

```js
const { validate, settingsOf, SOURCES, UNASSIGNED, rateFor } = require('./rules');
const { DIMS } = require('./ledger');
const B = require('./budgets');
const views = require('./views');
```

2. After `const RESTATE_FIELDS = …` (`:13`):

```js
const VIEW_PAGES = ['overview', 'breakdown', 'value'];
const VIEW_DAYS = 30; // a Breakdown or Value view without dates: the last 30 days
```

3. In the `createCostApi({ … })` options, after `onChange = () => {},`:

```js
  // The Cost Control pages (sub-project 3a): tool-call accuracy per model over a range (lib/quality.js
  // accuracyByModel, memoized by server.js) and the Datasets pass rates per model (lib/cost/views.js passRates).
  accuracy = () => ({}),
  passRates = () => ({}),
```

4. Before `function keys() {`:

```js
  // GET /api/cost/view: what one Cost Control page draws (lib/cost/views.js). The range rules are the ledger's;
  // Overview is always the current month. Quality inputs that fail to read leave the scatter empty, never the page.
  function viewQuery(q) {
    const page = q.get('page');
    if (!VIEW_PAGES.includes(page)) throw fail(400, `page: ${VIEW_PAGES.join(', ')}`);
    const measure = q.get('measure') || 'list';
    if (measure !== 'list' && measure !== 'billed') throw fail(400, 'measure: list or billed');
    const today = dayOf(now());
    let from = `${today.slice(0, 8)}01`;
    let to = today;
    if (page !== 'overview') {
      to = q.get('to') || today;
      if (!isDay(to)) throw fail(400, 'from and to are dates (YYYY-MM-DD)');
      from = q.get('from') || addDays(to, -(VIEW_DAYS - 1));
      checkRange(from, to);
    }
    let currency = q.get('currency') || null;
    if (currency === 'USD') currency = null;
    const s = current().value;
    if (currency && (!s.currency || s.currency.code !== currency))
      throw fail(400, 'no rates for that currency; set it in the cost settings');
    return { page, measure, from, to, today, currency, settings: s };
  }
  const quietly = (fn, fallback) => {
    try {
      return fn() || fallback;
    } catch {
      return fallback;
    }
  };
  function view(q) {
    const { page, measure, from, to, today, currency, settings: s } = viewQuery(q);
    const rateOf = currency ? (day) => rateFor(s.currency, day) : null;
    const read = cost.budgetRows({ from, to });
    const unread = new Set(read.unread || []);
    let data;
    if (page === 'overview') {
      const before = cost.budgetRows({ from: addDays(from, -7), to: addDays(from, -1) });
      for (const u of before.unread || []) unread.add(u);
      data = views.overview({
        rows: read.rows,
        before: before.rows,
        today,
        budgets: budgets ? quietly(() => budgets.evaluate(), []) : [],
        rateOf,
        measure,
        currency: currency || 'USD',
        display: s.currency ? { code: s.currency.code, rate: rateFor(s.currency, today) } : null,
      });
    } else if (page === 'breakdown') data = views.breakdown({ rows: read.rows, from, to, rateOf, measure });
    else
      data = views.value({
        rows: read.rows,
        from,
        to,
        rateOf,
        cacheSaved: cost.cacheSaved,
        accuracy: quietly(() => accuracy({ from, to }), {}),
        passRates: quietly(() => passRates({ from, to }), {}),
      });
    return reply(200, {
      page,
      from,
      to,
      currency: currency || 'USD',
      measure,
      unread: [...unread],
      billing: { error: read.billingError ? scrub(read.billingError) : null, historyLost: !!read.historyLost },
      ...data,
    });
  }

```

5. In the `GET` table, after `'/api/cost/prices/versions': …`:

```js
    '/api/cost/view': (q) => view(q),
```

The route table, the 404/405 answers, the scrub and the `UNAVAILABLE` → 503 mapping in `route()` are unchanged: a coded error from `cost.budgetRows` becomes the 503 the ledger route gives.

- [ ] **Step 4: Edit `server.js`**

1. After `const { createCostApi } = require('./lib/cost/api');` (`:54`):

```js
const { passRates: costPassRates } = require('./lib/cost/views');
const { accuracyByModel } = require('./lib/quality');
```

2. Before `const costApi = createCostApi({` (`:494`):

```js
// Tool-call accuracy per model for the Cost Control Value page: one scan of the signals per index version and range,
// so a refresh does not rescan them (a handful of ranges are in use at a time).
const accuracyMemo = { version: null, ranges: new Map() };
function costAccuracy({ from, to }) {
  if (accuracyMemo.version !== indexer.version) {
    accuracyMemo.version = indexer.version;
    accuracyMemo.ranges.clear();
  }
  const key = `${from}|${to}`;
  if (!accuracyMemo.ranges.has(key)) {
    if (accuracyMemo.ranges.size >= 8) accuracyMemo.ranges.clear();
    accuracyMemo.ranges.set(key, accuracyByModel(indexer.results(), { from, to }));
  }
  return accuracyMemo.ranges.get(key);
}
```

3. In the `createCostApi({ … })` options, after `onChange: () => budgetsChanged(),`:

```js
  accuracy: costAccuracy,
  // The experiment store is made below; this runs only on a request, after it is.
  passRates: (range) => costPassRates(experiments.list(), range),
```

The demo needs nothing more: its indexer stand-in has `version: 1` and `results: () => demo.buildResults()` (which now carry per-model counts, Task 1), and its experiments are seeded into the store at start.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/cost-view-api.test.js test/cost-api.test.js test/cost-budgets-api.test.js test/budgets-http.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/cost/api.js server.js test/cost-view-api.test.js
git commit -m "GET /api/cost/view: the Overview, Breakdown and Value data behind the dashboard sign-in"
```

---
### Task 5: Overview and Breakdown charts (`public/costcharts.js`)

**Files:**
- Create: `public/costcharts.js`
- Test: `test/cost-charts.test.js`

**Interfaces:**
- Consumes: the view answers of Tasks 2–3 (`overview`, `breakdown`); in the browser the globals `esc` (`public/app.js`), `isoStage`, `showTip`, `hideTip` (`public/iso.js`, `public/app.js`). The builders never touch the DOM; only `costMountTreemap` does.
- Produces (globals for `public/costview.js`, also exported for Node):
  - `COST_C` (palette), `COST_TONE` (`{ ok, warn, exceeded, none }` → color), `COST_SERIES` (series colors), `COST_OTHER`/`COST_PLAN`/`COST_NONE` (the special keys), `costNiceMax(v)`, `costDayLabel(day)` (`'5 Oct'`), `costPath(points)` (a null y breaks the path), `costSvg(W, H, body, cls, fixed)`, `costTip(parts)` (an escaped `·`-joined tooltip), `costPctText(x)`, `costF(n)`.
  - `costBurnSvg(overview, fmt)`, `costSpikeSvg(overview.spikes, fmt)`, `costRingSvg(percent, tone, size = 64)`, `costRingsHtml(overview.rings, overview.moreBudgets)`.
  - `costFlowSvg(breakdown.flow, { fmt, label(col, key) })`: filterable nodes carry `data-cost-node="<col>:<key>"` (never for `__other`, `__plan`, `__none`), with `role="button"` and `tabindex="0"`.
  - `costCalendarSvg(breakdown.calendar, fmt)` (fixed size, cells 24 px).
  - `costTreemapLayout(breakdown.treemap) → [{ ...block, x, z, w, d, h, color }]` on the platform `[-5.6, 5.6] × [-2.2, 2.2]`, and `costMountTreemap(canvas, blocks, { fmt, label, grow = true }) → stage` (browser only).
  - `fmt` is the page's money formatter (`costMoney` bound to the chosen currency, Task 7). Chart text sits on `.cost-chart text`; entrance motion classes: `cost-line` (draw-in, with `pathLength="1"`), `cost-grow`, `cost-fade`, `cost-pop`, `cost-ring-arc`, `cost-spike` (styles in Task 7).

- [ ] **Step 1: Write the failing test**

```js
// Cost Control charts (public/costcharts.js), Overview and Breakdown: the SVG builders run in Node on the data of
// lib/cost/views.js, and an audit of the file for names from the server put into markup without esc() (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const V = require('../lib/cost/views');

// The page's esc() lives in public/app.js; the builders call it, so the tests give them the same one.
global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const C = require('../public/costcharts');

const SRC = path.join(__dirname, '..', 'public', 'costcharts.js');
const fmt = (v) => `$${Number(v || 0).toFixed(2)}`;
const EVIL = '<img src=x onerror=alert(1)>';
const row = (over = {}) => ({
  day: '2026-10-01',
  source: 'claude',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  project: '~/acme-web',
  center: 'platform',
  kind: 'chat',
  requests: 1,
  tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const count = (s, re) => (s.match(re) || []).length;

test('helpers: a nice axis top, a day label without a Date, a path broken at a gap', () => {
  assert.deepEqual([C.costNiceMax(0), C.costNiceMax(7.2), C.costNiceMax(1234)], [1, 8, 1500]);
  assert.equal(C.costDayLabel('2026-10-05'), '5 Oct');
  assert.equal(C.costPath([[0, 1], [1, null], [2, 3], [3, 4]]), 'M0.0,1.0M2.0,3.0L3.0,4.0');
});

test('burn-down: actual line, forecast, band only past the third day, budget lines named as text', () => {
  const rows = [1, 2, 3, 4, 10].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v }));
  const budgets = [{ id: 'b', name: EVIL, scope: 'global', period: 'month', amount: 100, currency: 'USD' }];
  const svg = C.costBurnSvg(V.overview({ rows, today: '2026-10-05', budgets }), fmt);
  assert.equal(count(svg, /class="cost-band"/g), 1);
  assert.equal(count(svg, /class="cost-line"/g), 1);
  assert.match(svg, /&lt;img src=x onerror=alert\(1\)&gt; · \$100\.00/);
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /class="cost-today"/);
  const early = C.costBurnSvg(V.overview({ rows: rows.slice(0, 2), today: '2026-10-02' }), fmt);
  assert.equal(count(early, /class="cost-band"/g), 0);
  assert.match(early, /early in the month/);
});

test('spike line: one marker per spike, its tooltip with the baseline and the top model', () => {
  const before = ['24', '25', '26', '27', '28', '29', '30'].map((d) => row({ day: `2026-09-${d}`, listUSD: 0.2 }));
  const rows = [row({ listUSD: 0.5 }), row({ day: '2026-10-02', listUSD: 3, model: EVIL })];
  const o = V.overview({ rows, before, today: '2026-10-02' });
  const svg = C.costSpikeSvg(o.spikes, fmt);
  assert.equal(count(svg, /class="cost-spike"/g), 1);
  assert.match(svg, /data-tip="2 Oct · \$3\.00 · baseline \$0\.24 · spike · top model &lt;img/);
  assert.doesNotMatch(svg, /<img/);
});

test('rings: percent capped on the ring with a pink overflow arc; no data dashed; linked to the card', () => {
  const over = C.costRingSvg(125, 'exceeded');
  assert.match(over, />125%</);
  assert.equal(count(over, /<circle/g), 3, 'track, arc, overflow');
  assert.match(over, /stroke="#ff4fd8" stroke-width="2.4"/);
  const none = C.costRingSvg(null, 'none');
  assert.match(none, /stroke-dasharray="3 4"/);
  assert.match(none, />—</);
  assert.equal(count(C.costRingSvg(0, 'ok'), /<circle/g), 1, 'nothing to draw at 0 %');
  assert.equal(C.COST_TONE.warn, '#ff9a3c');
  const html = C.costRingsHtml(
    [{ id: 'team-1', name: EVIL, state: 'warn_80', tone: 'warn', percent: 85, projected: false }],
    3,
  );
  assert.match(html, /href="#cost\/budgets\?focus=team-1"/);
  assert.match(html, /\+ 3 more/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(C.costRingsHtml([], 0), '');
});

test('flow: nodes per column, a band per link, Other and Plan fee not filterable, names escaped', () => {
  const rows = [];
  for (let i = 1; i <= 8; i++) rows.push(row({ model: i === 8 ? EVIL : `m${i}`, listUSD: i, billedUSD: i }));
  rows.push({ ...row({ provider: null, model: null, center: null, kind: 'plan', requests: 0, listUSD: 0 }), billedUSD: 5 });
  const b = V.breakdown({ rows, from: '2026-10-01', to: '2026-10-07', measure: 'billed' });
  const svg = C.costFlowSvg(b.flow, { fmt, label: (col, key) => (key === '__other' ? 'Other' : key === '__plan' ? 'Plan fee' : key) });
  assert.equal(count(svg, /class="cost-link/g), b.flow.links.length);
  assert.equal(count(svg, /class="cost-node/g), b.flow.nodes.length);
  assert.match(svg, /data-cost-node="model:m7"/);
  assert.doesNotMatch(svg, /data-cost-node="model:__other"/);
  assert.doesNotMatch(svg, /data-cost-node="provider:__plan"/);
  assert.match(svg, />Plan fee</);
  assert.doesNotMatch(svg, /<img/);
});

test('calendar: a fixed-size cell per day, empty days outlined, each month named once', () => {
  const rows = [row({ day: '2026-09-30', listUSD: 2 }), row({ day: '2026-10-02', listUSD: 4 })];
  const b = V.breakdown({ rows, from: '2026-09-28', to: '2026-10-11' });
  const svg = C.costCalendarSvg(b.calendar, fmt);
  assert.equal(count(svg, /class="cost-cell"/g), 14);
  assert.match(svg, /^<svg class="cost-chart cost-calendar" viewBox="0 0 96 218" width="96" height="218"/);
  assert.equal(count(svg, /stroke="rgba\(120,140,255,\.22\)"/g), 12, 'the twelve empty days');
  assert.equal(count(svg, />Sep</g), 1);
  assert.equal(count(svg, />Oct</g), 1);
  assert.match(svg, /data-tip="2 Oct · \$4\.00 · top model claude-opus-5-5"/);
});

test('treemap layout: center strips by share, blocks by share of their center, height by spend per request', () => {
  const rows = [
    row({ project: '~/a', center: 'acme', listUSD: 6, requests: 6 }),
    row({ project: '~/b', center: 'acme', listUSD: 2, requests: 1 }),
    row({ project: '~/c', center: 'lab', listUSD: 2, requests: 4 }),
  ];
  const blocks = C.costTreemapLayout(V.breakdown({ rows, from: '2026-10-01', to: '2026-10-07' }).treemap);
  assert.deepEqual(
    blocks.map((x) => [x.center, x.project]),
    [
      ['acme', '~/a'],
      ['acme', '~/b'],
      ['lab', '~/c'],
    ],
  );
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  near(blocks[0].w + 0.1, 11.2 * 0.8);
  near(blocks[2].w + 0.1, 11.2 * 0.2);
  near(blocks[0].d + 0.1, 4.4 * 0.75);
  near(blocks[1].h, 2.8, 'the dearest per request is the tallest');
  near(blocks[0].h, 0.2 + 2.6 * 0.5);
  for (const x of blocks) assert.ok(x.x >= -5.6 && x.x + x.w <= 5.6 && x.z >= -2.2 && x.z + x.d <= 2.2);
  assert.notEqual(blocks[0].color, blocks[2].color);
  assert.deepEqual(C.costTreemapLayout([]), []);
});

test('costcharts.js builds no markup from server names without esc() (S1) and loads in Node', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const CONTENT = /\.(name|reason|project|model|center|provider|source|plan|label|title|text|error|message|id|key|day|topModel)$/;
  const bare = [...src.matchAll(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)].map((m) => m[1]).filter((e) => CONTENT.test(e));
  assert.deepEqual(bare, [], 'content interpolated without esc()');
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\son[a-z]+=/);
  for (const [name] of src.matchAll(/^(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(name.split(/\s+/).pop(), /^(?:cost|COST)/, `${name}: every top-level name starts with cost`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-charts.test.js`
Expected: FAIL (`Cannot find module '../public/costcharts'`).

- [ ] **Step 3: Write `public/costcharts.js`**

```js
'use strict';
/* Cost Control charts (sub-project 3a): SVG builders that take the data of GET /api/cost/view and return markup,
   plus the isometric treemap on isoStage (public/iso.js). The builders are pure (no DOM), so Node tests run them.
   Every name from the server (models, providers, projects, centers, budgets) reaches the markup through esc(); amounts
   go through the formatter the page passes in (`fmt`). Entrance motion is CSS keyed on #view.animate, which render()
   sets only without prefers-reduced-motion. */

// The holo palette (public/iso.js HOLO), repeated here so the builders also run in Node.
const COST_C = {
  cyan: '#4de8ff',
  blue: '#5b8cff',
  violet: '#8b7bff',
  pink: '#ff4fd8',
  orange: '#ff9a3c',
  green: '#5cf0a8',
  text: '#dfe6ff',
  muted: '#8f98cc',
};
// Ring colors by budget tone (lib/cost/views.js toneOf): ok cyan, a warning level orange, used up pink, no data muted.
const COST_TONE = { ok: COST_C.cyan, warn: COST_C.orange, exceeded: COST_C.pink, none: COST_C.muted };
// Flow columns and treemap centers take these in order.
const COST_SERIES = ['#4de8ff', '#8b7bff', '#ff4fd8', '#ff9a3c', '#5cf0a8', '#5b8cff', '#ffb547'];
const COST_OTHER = '__other';
const COST_PLAN = '__plan';
const COST_NONE = '__none';
// The calendar's five steps, dim to bright cyan; an empty day is drawn as an outline.
const COST_HEAT = ['#123a52', '#1b5f7e', '#2589a8', '#35b8d4', '#4de8ff'];
const COST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const costF = (v) => (Number.isFinite(v) ? v : 0).toFixed(1);
function costNiceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
// "22 Oct" from YYYY-MM-DD, without a Date (no time zone can move it).
const costDayLabel = (day) => `${Number(day.slice(8, 10))} ${COST_MONTHS[Number(day.slice(5, 7)) - 1] || ''}`;
// A chart that scales to its panel; `fixed` keeps its drawn size (the calendar's cells stay square and small).
const costSvg = (W, H, body, cls = '', fixed = false) =>
  `<svg class="${fixed ? '' : 'hchart '}cost-chart${cls ? ` ${cls}` : ''}" viewBox="0 0 ${W} ${H}"${fixed ? ` width="${W}" height="${H}"` : ''} role="img">${body}</svg>`;
const costTip = (parts) => esc(parts.filter((x) => x !== '' && x != null).join(' · '));
const costPctText = (x) => (x == null ? '—' : `${(x * 100).toFixed(x >= 0.995 || x < 0.1 ? 1 : 0)}%`);
// A path through points; a null y breaks it (a gap, not zero).
function costPath(pts) {
  let d = '';
  let pen = false;
  for (const [x, y] of pts) {
    if (y == null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${costF(x)},${costF(y)}`;
    pen = true;
  }
  return d;
}
function costAxis(W, m, ih, max, fmt) {
  const out = [];
  for (let i = 0; i <= 4; i++) {
    const y = m.t + (ih * i) / 4;
    out.push(
      `<line x1="${m.l}" x2="${W - m.r}" y1="${costF(y)}" y2="${costF(y)}" class="gl"/><text x="${m.l - 6}" y="${costF(y + 3)}" text-anchor="end">${esc(fmt(max * (1 - i / 4)))}</text>`,
    );
  }
  return out.join('');
}

/* ---------- Overview ---------- */

// Cumulative spend per day of the month, the forecast from today to the month's end with its band, and the global
// monthly budgets as levels. `o` is the overview answer.
function costBurnSvg(o, fmt) {
  const W = 1100; // a full-width panel: a wider drawing keeps its text at the panel's size
  const H = 300;
  const m = { t: 14, r: 12, b: 24, l: 60 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const days = o.month.days;
  const f = o.forecast;
  const max = costNiceMax(
    Math.max(o.total || 0, f.projected || 0, f.high || 0, ...o.budgetLines.map((l) => l.amount || 0)),
  );
  const x = (day) => m.l + ((Number(day.slice(8, 10)) - 1) / Math.max(1, days - 1)) * iw;
  const y = (v) => m.t + ih - (Math.min(v, max) / max) * ih;
  const out = [costAxis(W, m, ih, max, fmt)];
  if (!f.early) {
    const top = f.line.map((p) => [x(p.day), y(p.high)]);
    const bottom = f.line.map((p) => [x(p.day), y(p.low)]).reverse();
    out.push(`<path class="cost-band" d="${costPath([...top, ...bottom])}Z" fill="${COST_C.violet}" fill-opacity=".16"/>`);
  }
  out.push(
    `<path class="cost-line" pathLength="1" d="${costPath(o.daily.map((d) => [x(d.day), y(d.cum)]))}" fill="none" stroke="${COST_C.cyan}" stroke-width="2.4" style="filter:drop-shadow(0 0 4px ${COST_C.cyan})"/>`,
    `<path class="cost-fade" d="${costPath(f.line.map((p) => [x(p.day), y(p.cum)]))}" fill="none" stroke="${COST_C.violet}" stroke-width="2" stroke-dasharray="6 5"/>`,
  );
  for (const l of o.budgetLines) {
    const yy = costF(y(l.amount));
    out.push(
      `<g class="cost-fade" data-tip="${costTip(['Monthly budget', l.name, fmt(l.amount)])}"><line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="${COST_C.orange}" stroke-width="1.6" stroke-dasharray="4 4"/><text x="${W - m.r - 4}" y="${costF(y(l.amount) - 5)}" text-anchor="end" fill="${COST_C.orange}">${esc(l.name)} · ${esc(fmt(l.amount))}</text></g>`,
    );
  }
  const today = x(o.month.today);
  out.push(`<line x1="${costF(today)}" x2="${costF(today)}" y1="${m.t}" y2="${m.t + ih}" class="cost-today"/>`);
  const step = iw / Math.max(1, days - 1);
  for (const d of o.daily)
    out.push(
      `<rect x="${costF(x(d.day) - step / 2)}" y="${m.t}" width="${costF(step)}" height="${ih}" fill="transparent" data-tip="${costTip([costDayLabel(d.day), `spent ${fmt(d.cum)}`, `that day ${fmt(d.spend)}`])}"/>`,
    );
  for (const p of f.line.slice(1))
    out.push(
      `<rect x="${costF(x(p.day) - step / 2)}" y="${m.t}" width="${costF(step)}" height="${ih}" fill="transparent" data-tip="${costTip([costDayLabel(p.day), `forecast ${fmt(p.cum)}`, f.early ? 'early in the month' : `${fmt(p.low)} – ${fmt(p.high)}`])}"/>`,
    );
  for (let i = 1; i <= days; i += Math.ceil(days / 8))
    out.push(`<text x="${costF(m.l + ((i - 1) / Math.max(1, days - 1)) * iw)}" y="${H - 6}" text-anchor="middle">${i}</text>`);
  return costSvg(W, H, out.join(''), 'cost-burn');
}

// Daily spend as bars against each day's 7-day baseline; a spike is a pink marker with its day, spend, baseline and
// the day's top model.
function costSpikeSvg(spikes, fmt) {
  const W = 640;
  const H = 170;
  const m = { t: 12, r: 10, b: 22, l: 60 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = Math.max(1, spikes.length);
  const max = costNiceMax(Math.max(...spikes.map((s) => Math.max(s.spend || 0, s.baseline || 0)), 0));
  const step = iw / n;
  const bw = Math.max(2, Math.min(18, step * 0.62));
  const y = (v) => m.t + ih - (Math.min(v || 0, max) / max) * ih;
  const out = [costAxis(W, m, ih, max, fmt)];
  spikes.forEach((s, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    const h = m.t + ih - y(s.spend);
    const color = s.spike ? COST_C.pink : COST_C.blue;
    const tip = costTip([
      costDayLabel(s.day),
      fmt(s.spend),
      `baseline ${fmt(s.baseline)}`,
      s.spike ? 'spike' : '',
      s.topModel ? 'top model ' + s.topModel : '', // costTip escapes the whole line
    ]);
    out.push(
      `<g data-tip="${tip}"><rect x="${costF(m.l + i * step)}" y="${m.t}" width="${costF(step)}" height="${ih}" fill="transparent"/><rect class="cost-grow" x="${costF(x)}" y="${costF(y(s.spend))}" width="${costF(bw)}" height="${costF(Math.max(0, h))}" rx="1.5" fill="${color}" fill-opacity="${s.spike ? 1 : 0.7}"/>${s.spike ? `<circle class="cost-spike" cx="${costF(x + bw / 2)}" cy="${costF(y(s.spend) - 7)}" r="4" fill="${COST_C.pink}" style="filter:drop-shadow(0 0 5px ${COST_C.pink})"/>` : ''}</g>`,
    );
  });
  out.push(
    `<path class="cost-fade" d="${costPath(spikes.map((s, i) => [m.l + i * step + step / 2, y(s.baseline)]))}" fill="none" stroke="${COST_C.orange}" stroke-width="1.4" stroke-dasharray="4 4"/>`,
  );
  const k = Math.ceil(n / 8);
  spikes.forEach((s, i) => {
    if (i % k === 0)
      out.push(`<text x="${costF(m.l + i * step + step / 2)}" y="${H - 6}" text-anchor="middle">${esc(costDayLabel(s.day))}</text>`);
  });
  return costSvg(W, H, out.join(''), 'cost-spikes');
}

// One budget ring: the percent (capped at 100 % on the ring, the overflow as a pink outer arc), dashed and muted
// without data. `size` is the drawn width in px.
function costRingSvg(percent, tone, size = 64) {
  const r = 26;
  const C = 2 * Math.PI * r;
  const color = COST_TONE[tone] || COST_TONE.none;
  const none = percent == null;
  const p = none ? 0 : Math.max(0, Math.min(1, percent / 100));
  const over = none ? 0 : Math.max(0, Math.min(1, (percent - 100) / 100));
  const R = 31;
  const C2 = 2 * Math.PI * R;
  return `<svg class="cost-ring-svg" viewBox="0 0 70 70" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="35" cy="35" r="${r}" fill="none" stroke="rgba(140,160,255,.16)" stroke-width="6"${none ? ' stroke-dasharray="3 4"' : ''}/>
    ${none || p === 0 ? '' : `<circle class="cost-ring-arc" pathLength="1" cx="35" cy="35" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${costF(C * p)} ${costF(C)}" transform="rotate(-90 35 35)" style="filter:drop-shadow(0 0 4px ${color})"/>`}
    ${over > 0 ? `<circle cx="35" cy="35" r="${R}" fill="none" stroke="${COST_C.pink}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${costF(C2 * over)} ${costF(C2)}" transform="rotate(-90 35 35)"/>` : ''}
    <text x="35" y="39" text-anchor="middle">${none ? '—' : `${Math.round(percent)}%`}</text></svg>`;
}

// The Overview's compact rings, riskiest first (the server orders them), each linking to its card in Budgets.
function costRingsHtml(rings, more) {
  if (!rings.length) return '';
  const items = rings.map((b) => {
    const href = `#cost/budgets?focus=${encodeURIComponent(b.id)}`;
    const state = b.tone === 'none' ? 'no data' : b.projected ? 'projected over' : b.state.replace('_', ' ');
    return `<a class="cost-ring tone-${esc(b.tone)}" href="${esc(href)}" data-tip="${costTip([b.name, state])}">${costRingSvg(b.percent, b.tone, 58)}<span>${esc(b.name)}</span></a>`;
  });
  if (more > 0) items.push(`<a class="cost-ring cost-more" href="#cost/budgets">+ ${more} more</a>`);
  return `<div class="cost-rings">${items.join('')}</div>`;
}

/* ---------- Breakdown ---------- */

// The flow: four columns of nodes, links as bands whose width is the spend. A node is a button for the table filter
// (data-cost-node="<column>:<key>"). `label(col, key)` names a node (center names, Other, Plan fee).
function costFlowSvg(flow, { fmt, label }) {
  const W = 900;
  const H = 320;
  const nodeW = 12;
  const gap = 8;
  const cols = flow.columns.length;
  const colX = (c) => 120 + (c * (W - 260)) / Math.max(1, cols - 1);
  const byCol = flow.columns.map((_, c) => flow.nodes.filter((n) => n.col === c));
  const totals = byCol.map((ns) => ns.reduce((a, n) => a + n.value, 0));
  const most = Math.max(...byCol.map((ns, c) => totals[c] / Math.max(1, H - 20 - gap * (ns.length - 1))), 1e-9);
  const scale = 1 / most;
  const pos = new Map();
  byCol.forEach((ns, c) => {
    let yy = 10;
    for (const n of ns) {
      const h = Math.max(2, n.value * scale);
      pos.set(n.id, { x: colX(c), y: yy, h, out: 0, in: 0, col: c });
      yy += h + gap;
    }
  });
  const total = totals[0] || 1;
  const out = [];
  for (const l of flow.links) {
    const a = pos.get(l.source);
    const b = pos.get(l.target);
    if (!a || !b) continue;
    const h = Math.max(1, l.value * scale);
    const x0 = a.x + nodeW;
    const x1 = b.x;
    const y0 = a.y + a.out;
    const y1 = b.y + b.in;
    a.out += h;
    b.in += h;
    const xm = (x0 + x1) / 2;
    const color = COST_SERIES[a.col % COST_SERIES.length];
    const name = (id) => {
      const [col, ...key] = id.split(':');
      return label(col, key.join(':'));
    };
    out.push(
      `<path class="cost-link cost-fade" d="M${costF(x0)},${costF(y0)}C${costF(xm)},${costF(y0)} ${costF(xm)},${costF(y1)} ${costF(x1)},${costF(y1)}L${costF(x1)},${costF(y1 + h)}C${costF(xm)},${costF(y1 + h)} ${costF(xm)},${costF(y0 + h)} ${costF(x0)},${costF(y0 + h)}Z" fill="${color}" fill-opacity=".28" data-tip="${costTip([`${name(l.source)} → ${name(l.target)}`, fmt(l.value), costPctText(l.value / total)])}"/>`,
    );
  }
  for (const n of flow.nodes) {
    const p = pos.get(n.id);
    const col = flow.columns[n.col];
    const name = label(col, n.key);
    const color = COST_SERIES[n.col % COST_SERIES.length];
    const filterable = n.key !== COST_OTHER && n.key !== COST_PLAN && n.key !== COST_NONE;
    const left = n.col === 0;
    out.push(
      `<g class="cost-node${filterable ? ' cost-click' : ''}"${filterable ? ` data-cost-node="${esc(n.id)}" role="button" tabindex="0" aria-label="${esc(`Filter the table to ${name}`)}"` : ''} data-tip="${costTip([name, fmt(n.value), costPctText(n.value / total)])}"><rect class="cost-grow" x="${costF(p.x)}" y="${costF(p.y)}" width="${nodeW}" height="${costF(p.h)}" rx="2" fill="${color}" style="filter:drop-shadow(0 0 4px ${color})"/><text x="${costF(left ? p.x - 6 : p.x + nodeW + 6)}" y="${costF(p.y + p.h / 2 + 4)}" text-anchor="${left ? 'end' : 'start'}">${esc(name.length > 26 ? `${name.slice(0, 25)}…` : name)}</text></g>`,
    );
  }
  return costSvg(W, H, out.join(''), 'cost-flow');
}

// Weeks as columns, Monday to Sunday as rows; the color step is the day's level (lib/cost/views.js calendarOf).
function costCalendarSvg(cal, fmt) {
  const cell = 24;
  const gap = 4;
  const left = 34;
  const top = 18;
  const weeks = cal.days.length ? cal.days[cal.days.length - 1].week + 1 : 1;
  const W = left + weeks * (cell + gap) + 6;
  const H = top + 7 * (cell + gap) + 4;
  const out = [];
  ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((d, i) => {
    if (d) out.push(`<text x="${left - 6}" y="${top + i * (cell + gap) + 16}" text-anchor="end">${d}</text>`);
  });
  let labelled = null; // a month is named once, over the first week column it starts
  for (const d of cal.days) {
    const x = left + d.week * (cell + gap);
    const y = top + d.weekday * (cell + gap);
    const month = d.day.slice(0, 7);
    if (month !== labelled && (d.weekday === 0 || d === cal.days[0])) {
      labelled = month;
      out.push(`<text x="${x}" y="${top - 6}">${esc(COST_MONTHS[Number(d.day.slice(5, 7)) - 1] || '')}</text>`);
    }
    const fill = d.level ? COST_HEAT[d.level - 1] : 'rgba(120,140,255,.06)';
    out.push(
      `<rect class="cost-cell" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${fill}"${d.level ? '' : ' stroke="rgba(120,140,255,.22)"'} data-tip="${costTip([costDayLabel(d.day), d.spend ? fmt(d.spend) : 'nothing spent', d.topModel ? 'top model ' + d.topModel : ''])}"/>`,
    );
  }
  return costSvg(W, H, out.join(''), 'cost-calendar', true);
}

// Center strips across the platform, each as wide as its share; inside, one block per project as deep as its share
// of the center; height by spend per request. Pure, so the layout is tested; costMountTreemap draws it.
function costTreemapLayout(treemap, { X0 = -5.6, X1 = 5.6, Z0 = -2.2, Z1 = 2.2, gap = 0.1 } = {}) {
  const total = treemap.reduce((a, c) => a + c.spend, 0);
  const maxPer = Math.max(1e-9, ...treemap.flatMap((c) => c.blocks.map((b) => b.perRequest || 0)));
  const out = [];
  let x = X0;
  treemap.forEach((c, ci) => {
    const w = total > 0 ? ((X1 - X0) * c.spend) / total : 0;
    let z = Z0;
    for (const b of c.blocks) {
      const d = c.spend > 0 ? ((Z1 - Z0) * b.spend) / c.spend : 0;
      out.push({
        ...b,
        x: x + gap / 2,
        z: z + gap / 2,
        w: Math.max(0.02, w - gap),
        d: Math.max(0.02, d - gap),
        h: 0.2 + 2.6 * ((b.perRequest || 0) / maxPer),
        color: COST_SERIES[ci % COST_SERIES.length],
      });
      z += d;
    }
    x += w;
  });
  return out;
}

// The treemap on the isometric stage: blocks grow to their height (at once with reduced motion, or on a quiet
// refresh: grow false); hover names one. Returns the stage, which the page destroys before a repaint.
function costMountTreemap(canvas, blocks, { fmt, label, grow = true }) {
  const grown = new Map(grow ? [] : blocks.map((b, i) => [i, b.h]));
  let tip = '';
  return isoStage(canvas, {
    fit: [12.8, 8.6],
    origin: [0.5, 0.64],
    draw(g) {
      const { P, still } = g;
      g.glow();
      g.platform(-5.8, 5.8, -2.4, 2.4);
      const tops = [];
      const items = blocks.map((b, i) => {
        const h = still ? b.h : (grown.get(i) ?? 0.02) + (b.h - (grown.get(i) ?? 0.02)) * 0.08;
        grown.set(i, h);
        tops.push({ at: P(b.x + b.w / 2, h, b.z + b.d / 2), b });
        return { depth: P(b.x + b.w / 2, 0, b.z + b.d / 2)[2], draw: () => g.box(b.x, b.z, b.w, b.d, h, b.color, { slices: 0.4, glow: 10 }) };
      });
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      g.particles();
      const p = g.pointer;
      let hit = null;
      if (p)
        for (const t of tops) {
          const dd = Math.hypot(t.at[0] - p.x, t.at[1] - p.y);
          if (dd < 18 && (!hit || dd < hit.dd)) hit = { ...t, dd };
        }
      if (hit) {
        const b = hit.b;
        const text = [
          label('center', b.center),
          b.project === COST_OTHER ? `Other (${b.projects} projects)` : b.project || 'No project (gateway, judge)',
          fmt(b.spend),
          costPctText(b.share),
          b.perRequest == null ? '' : `${fmt(b.perRequest)} per request`,
        ]
          .filter(Boolean)
          .join(' · ');
        const key = `${text}|${p.cx}|${p.cy}`;
        if (key !== tip) showTip({ clientX: p.cx, clientY: p.cy }, esc(text));
        tip = key;
      } else if (tip) {
        hideTip();
        tip = '';
      }
    },
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    COST_TONE,
    costNiceMax,
    costDayLabel,
    costPath,
    costBurnSvg,
    costSpikeSvg,
    costRingSvg,
    costRingsHtml,
    costFlowSvg,
    costCalendarSvg,
    costTreemapLayout,
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/cost-charts.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/costcharts.js test/cost-charts.test.js
git commit -m "Cost charts: burn-down with band, spike line, budget rings, cost flow, calendar and the treemap layout"
```

---
### Task 6: Value charts (`public/costcharts.js`)

**Files:**
- Modify: `public/costcharts.js` (from Task 5): a Value section before the exports, five new exports
- Test: `test/cost-charts-value.test.js`

**Interfaces:**
- Consumes: Task 5's `COST_C`, `COST_SERIES`, `costF`, `costNiceMax`, `costSvg`, `costTip`, `costPctText`, `costPath`, `costAxis`, `costDayLabel`; the `value` answer of Task 3.
- Produces: `costPlanBarsHtml(value.plans, fmt, label(source))`, `costWaterfallSvg(value.waterfall, fmt)`, `costLocalHtml(value.local)`, `costScatterSvg(value.scatter, fmt)`, `costUnitSvg(value.unit, key, fmt, color)` with `key` one of `perRequest`, `perMillionTokens`, `perThousandToolCalls`.

- [ ] **Step 1: Write the failing test**

```js
// Cost Control charts (public/costcharts.js), Value: plan bars, the savings waterfall, local models, the cost against
// quality scatter and the unit-cost lines, on the data of lib/cost/views.js value().
const test = require('node:test');
const assert = require('node:assert/strict');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const C = require('../public/costcharts');

const fmt = (v) => `$${Number(v || 0).toFixed(2)}`;
const EVIL = '<img src=x onerror=alert(1)>';
const count = (s, re) => (s.match(re) || []).length;

test('plan bars: usage value against the fee with the multiplier; under 1× orange and said so', () => {
  const html = C.costPlanBarsHtml(
    [
      { source: 'claude', plan: EVIL, days: 30, value: 41, fee: 10, multiplier: 4.1 },
      { source: 'codex', plan: 'Pro', days: 30, value: 3, fee: 5, multiplier: 0.6 },
    ],
    fmt,
    (s) => ({ claude: 'Claude Code', codex: 'Codex' })[s],
  );
  assert.match(html, /4\.1× the fee/);
  assert.match(html, /0\.6× the fee/);
  assert.equal(count(html, /The plan cost more than metered use would have\./g), 1);
  assert.equal(count(html, /class="cost-plan under"/g), 1);
  assert.match(html, /width:100\.0%/, 'the largest bar fills the row');
  assert.doesNotMatch(html, /<img/);
  assert.equal(C.costPlanBarsHtml([], fmt, String), '');
});

test('waterfall: four steps, savings down, a dearer plan up, labels as text', () => {
  const svg = C.costWaterfallSvg({ withoutCache: 53, cacheSaved: 8, usage: 45, planSaved: 30, paid: 15 }, fmt);
  assert.equal(count(svg, /class="cost-grow"/g), 4);
  for (const t of ['Without cache', 'Cache savings', 'Plan savings', 'Paid']) assert.match(svg, new RegExp(`>${t}<`));
  assert.match(svg, />−\$8\.00</);
  assert.match(svg, />−\$30\.00</);
  assert.match(svg, />\$15\.00</);
  const up = C.costWaterfallSvg({ withoutCache: 1, cacheSaved: 0, usage: 1, planSaved: -2, paid: 3 }, fmt);
  assert.match(up, />Plan cost more</);
  assert.match(up, />\+\$2\.00</);
});

test('local models: requests and tokens only, with the note; none in the range says so', () => {
  const html = C.costLocalHtml({ requests: 25, tokens: 1570, models: [{ model: EVIL, source: 'judge', requests: 25, tokens: 1570 }] });
  assert.match(html, /Not priced: sub-project 4 compares them with a cloud model\./);
  assert.match(html, />1,570</);
  assert.doesNotMatch(html, /<img|\$/);
  assert.match(C.costLocalHtml({ requests: 0, tokens: 0, models: [] }), /No local model calls/);
});

test('scatter: a dot per model, hollow and labeled with little data, pass rate in the tooltip', () => {
  const svg = C.costScatterSvg(
    {
      dots: [
        { model: 'claude-opus-5-5', requests: 400, spend: 10, perRequest: 0.025, accuracy: 0.98, toolResults: 900, littleData: false, passRate: { pass: 3, total: 4, rate: 0.75 } },
        { model: EVIL, requests: 10, spend: 1, perRequest: 0.1, accuracy: 1, toolResults: 12, littleData: true, passRate: null },
      ],
      noToolCalls: [],
    },
    fmt,
  );
  assert.equal(count(svg, /class="cost-dot"/g), 2);
  assert.equal(count(svg, /fill="none"/g), 1, 'the little-data dot is hollow');
  assert.match(svg, /little data/);
  assert.match(svg, /Datasets pass rate 75% \(3\/4\)/);
  assert.doesNotMatch(svg, /<img/);
});

test('unit line: one path broken where a day has no denominator, a dot for a lone day', () => {
  const unit = [
    { day: '2026-10-01', perRequest: 2 },
    { day: '2026-10-02', perRequest: 3 },
    { day: '2026-10-03', perRequest: null },
    { day: '2026-10-04', perRequest: 1 },
    { day: '2026-10-05', perRequest: null },
  ];
  const svg = C.costUnitSvg(unit, 'perRequest', fmt, '#4de8ff');
  const d = /class="cost-line" pathLength="1" d="([^"]*)"/.exec(svg)[1];
  assert.equal(count(d, /M/g), 2, 'a gap, not a zero');
  assert.equal(count(svg, /<circle/g), 1, 'the lone day');
  assert.match(svg, /data-tip="3 Oct · no data"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-charts-value.test.js`
Expected: FAIL (`C.costPlanBarsHtml is not a function`).

- [ ] **Step 3: The Value section** — insert before `if (typeof module !== 'undefined')`:

```js
/* ---------- Value ---------- */

// Usage value against plan fee per source on a plan, with the multiplier; below 1× the bar is orange and says so.
// `label(source)` names a source.
function costPlanBarsHtml(plans, fmt, label) {
  if (!plans.length) return '';
  const max = Math.max(1e-9, ...plans.flatMap((p) => [p.value, p.fee]));
  const bar = (v, color, text) =>
    `<div class="cost-pbar"><i class="cost-grow-x" style="width:${costF(Math.max(0.5, (v / max) * 100))}%;background:${color};box-shadow:0 0 8px ${color}"></i><span>${esc(text)}</span></div>`;
  return `<div class="cost-plans">${plans
    .map((p) => {
      const under = p.multiplier != null && p.multiplier < 1;
      const times = p.multiplier == null ? 'no fee in this range' : `${p.multiplier.toFixed(1)}× the fee`;
      return `<div class="cost-plan${under ? ' under' : ''}"><div class="cost-plan-head"><b>${esc(label(p.source))}</b><span>${esc(p.plan || 'Plan')} · ${p.days} days</span><em>${esc(times)}</em></div>
        ${bar(p.value, under ? COST_C.orange : COST_C.cyan, `Usage value ${fmt(p.value)}`)}${bar(p.fee, COST_C.violet, `Plan fee ${fmt(p.fee)}`)}
        ${under ? '<p class="cost-note">The plan cost more than metered use would have.</p>' : ''}</div>`;
    })
    .join('')}</div>`;
}

// Without cache → cache savings (down) → plan savings (down, or up when a plan cost more) → paid.
function costWaterfallSvg(w, fmt) {
  const W = 640;
  const H = 230;
  const m = { t: 22, r: 12, b: 34, l: 60 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = costNiceMax(Math.max(w.withoutCache, w.usage, w.paid, 0));
  const y = (v) => m.t + ih - (Math.max(0, Math.min(v, max)) / max) * ih;
  const steps = [
    { name: 'Without cache', from: 0, to: w.withoutCache, color: COST_C.cyan, tip: 'usage value plus the cache savings' },
    { name: 'Cache savings', from: w.withoutCache, to: w.usage, color: COST_C.green, tip: 'estimate: base rates of each day' },
    {
      name: w.planSaved >= 0 ? 'Plan savings' : 'Plan cost more',
      from: w.usage,
      to: w.paid,
      color: w.planSaved >= 0 ? COST_C.green : COST_C.orange,
      tip: 'usage value minus what was paid',
    },
    { name: 'Paid', from: 0, to: w.paid, color: COST_C.violet, tip: 'what was paid' },
  ];
  const step = iw / steps.length;
  const bw = Math.min(90, step * 0.56);
  const out = [costAxis(W, m, ih, max, fmt)];
  steps.forEach((s, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    const top = y(Math.max(s.from, s.to));
    const h = Math.max(1, Math.abs(y(s.from) - y(s.to)));
    const amount = i === 0 || i === 3 ? s.to : s.to - s.from;
    out.push(
      `<g data-tip="${costTip([s.name, fmt(amount), s.tip])}"><rect class="cost-grow" x="${costF(x)}" y="${costF(top)}" width="${costF(bw)}" height="${costF(h)}" rx="2" fill="${s.color}" fill-opacity=".85" style="filter:drop-shadow(0 0 4px ${s.color})"/><text x="${costF(x + bw / 2)}" y="${costF(top - 6)}" text-anchor="middle" class="cost-val">${esc(i === 0 || i === 3 ? fmt(amount) : `${amount <= 0 ? '−' : '+'}${fmt(Math.abs(amount))}`)}</text><text x="${costF(x + bw / 2)}" y="${H - 12}" text-anchor="middle">${esc(s.name)}</text></g>`,
    );
    if (i < steps.length - 1) {
      const next = m.l + (i + 1) * step + (step - bw) / 2;
      out.push(`<line x1="${costF(x + bw)}" x2="${costF(next)}" y1="${costF(y(s.to))}" y2="${costF(y(s.to))}" class="cost-join"/>`);
    }
  });
  return costSvg(W, H, out.join(''), 'cost-waterfall');
}

// Free local models: requests and tokens, never money.
function costLocalHtml(local) {
  if (!local.requests) return '<p class="cost-note">No local model calls in this range.</p>';
  const rows = local.models
    .map(
      (l) =>
        `<tr><td>${esc(l.model || 'Unknown model')}</td><td>${esc(l.source)}</td><td class="num">${l.requests.toLocaleString('en')}</td><td class="num">${l.tokens.toLocaleString('en')}</td></tr>`,
    )
    .join('');
  return `<table class="cost-table"><thead><tr><th>Model</th><th>Source</th><th class="num">Requests</th><th class="num">Tokens</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="cost-note">Not priced: sub-project 4 compares them with a cloud model.</p>`;
}

// One dot per model: spend per request across, tool-call accuracy up, size by requests; hollow with little data.
function costScatterSvg(scatter, fmt) {
  const dots = scatter.dots;
  const W = 1100;
  const H = 320;
  const m = { t: 16, r: 20, b: 30, l: 56 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const maxX = costNiceMax(Math.max(0, ...dots.map((d) => d.perRequest || 0)));
  const lowY = Math.max(0, Math.floor((Math.min(1, ...dots.map((d) => d.accuracy)) - 0.01) * 50) / 50);
  const x = (v) => m.l + (Math.min(v || 0, maxX) / maxX) * iw;
  const y = (a) => m.t + ih - ((a - lowY) / Math.max(1e-9, 1 - lowY)) * ih;
  const maxReq = Math.max(1, ...dots.map((d) => d.requests));
  const out = [];
  for (let i = 0; i <= 4; i++) {
    const a = lowY + ((1 - lowY) * (4 - i)) / 4;
    const yy = costF(y(a));
    out.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" class="gl"/><text x="${m.l - 6}" y="${costF(y(a) + 3)}" text-anchor="end">${(a * 100).toFixed(1)}%</text>`);
  }
  for (let i = 0; i <= 4; i++)
    out.push(`<text x="${costF(m.l + (iw * i) / 4)}" y="${H - 8}" text-anchor="middle">${esc(fmt((maxX * i) / 4))}</text>`);
  dots.forEach((d, i) => {
    const r = 4 + 14 * Math.sqrt(d.requests / maxReq);
    const color = COST_SERIES[i % COST_SERIES.length];
    const pass = d.passRate && d.passRate.total ? `Datasets pass rate ${costPctText(d.passRate.pass / d.passRate.total)} (${d.passRate.pass}/${d.passRate.total})` : '';
    const tip = costTip([
      d.model,
      `${fmt(d.perRequest)} per request`,
      `accuracy ${costPctText(d.accuracy)}`,
      `${d.toolResults.toLocaleString('en')} tool results`,
      `${d.requests.toLocaleString('en')} requests`,
      d.littleData ? 'little data' : '',
      pass,
    ]);
    out.push(
      `<g class="cost-dot" data-tip="${tip}"><circle class="cost-pop" cx="${costF(x(d.perRequest))}" cy="${costF(y(d.accuracy))}" r="${costF(r)}" fill="${d.littleData ? 'none' : color}" fill-opacity=".55" stroke="${color}" stroke-width="2"${d.littleData ? ' stroke-dasharray="3 3"' : ''}/><text x="${costF(x(d.perRequest) + r + 4)}" y="${costF(y(d.accuracy) + 4)}">${esc(d.model)}${d.littleData ? ' · little data' : ''}</text></g>`,
    );
  });
  return costSvg(W, H, out.join(''), 'cost-scatter');
}

// One unit-cost line over the range with its own scale; a day without its denominator is a gap.
function costUnitSvg(unit, key, fmt, color) {
  const W = 340;
  const H = 170;
  const m = { t: 10, r: 8, b: 22, l: 56 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const vals = unit.map((u) => u[key]);
  const max = costNiceMax(Math.max(0, ...vals.filter((v) => v != null)));
  const x = (i) => m.l + (unit.length < 2 ? iw / 2 : (i / (unit.length - 1)) * iw);
  const y = (v) => (v == null ? null : m.t + ih - (Math.min(v, max) / max) * ih);
  const out = [costAxis(W, m, ih, max, fmt)];
  out.push(
    `<path class="cost-line" pathLength="1" d="${costPath(vals.map((v, i) => [x(i), y(v)]))}" fill="none" stroke="${color}" stroke-width="2" style="filter:drop-shadow(0 0 3px ${color})"/>`,
  );
  vals.forEach((v, i) => {
    if (v != null && (i === 0 || vals[i - 1] == null) && (i === vals.length - 1 || vals[i + 1] == null))
      out.push(`<circle cx="${costF(x(i))}" cy="${costF(y(v))}" r="2.5" fill="${color}"/>`); // a lone day between gaps
    out.push(
      `<rect x="${costF(x(i) - iw / unit.length / 2)}" y="${m.t}" width="${costF(iw / unit.length)}" height="${ih}" fill="transparent" data-tip="${costTip([costDayLabel(unit[i].day), v == null ? 'no data' : fmt(v)])}"/>`,
    );
  });
  const k = Math.ceil(unit.length / 6);
  unit.forEach((u, i) => {
    if (i % k === 0) out.push(`<text x="${costF(x(i))}" y="${H - 6}" text-anchor="middle">${esc(costDayLabel(u.day))}</text>`);
  });
  return costSvg(W, H, out.join(''), 'cost-unit');
}

```

and add to the exports, after `costTreemapLayout,`:

```js
    costPlanBarsHtml,
    costWaterfallSvg,
    costLocalHtml,
    costScatterSvg,
    costUnitSvg,
```

The local-models note keeps the spec's wording ("Not priced: sub-project 4 compares them with a cloud model."); see "Decisions made while planning".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cost-charts-value.test.js test/cost-charts.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/costcharts.js test/cost-charts-value.test.js
git commit -m "Cost charts: plan value bars, the savings waterfall, local models, cost against quality, unit-cost lines"
```

---
### Task 7: The Cost Control pages: menu, control bar, Overview, Breakdown, Value (shared: `public/app.js`, `public/index.html`, `public/iso.js`, `public/styles.css`)

**Files:**
- Create: `public/costview.js`
- Modify: `public/index.html:43` (sidebar, after the Quality "Rankings" link), `:137` (two script tags after `runtimesview.js`)
- Modify: `public/iso.js:589` (a `cost` entry in `SUBPAGES`, before `squad`)
- Modify: `public/app.js:238` (`TITLES`), `:1090` (`VIEWS`), `:1144` (no summary needed), `:1159` (mount), `:1331-1334` (the 60-second render leaves Cost Control out)
- Modify: `public/styles.css` (append, after the last rule `:9014`)
- Test: `test/cost-ui.test.js`

**Interfaces:**
- Consumes: Tasks 5–6 (every `cost…Svg`/`cost…Html` builder, `costTreemapLayout`, `costMountTreemap`, `COST_C`, `COST_SERIES`); `GET /api/cost/view` (Task 4), `GET /api/cost/settings`, `GET /api/cost/status`, `GET /api/cost/ledger` (existing); from `public/app.js`/`public/iso.js`: `$`, `esc`, `state`, `reduceMotion`, `metricTile`, `panel`, `subTabs`, `subHero`, `holoEmpty`, `onUnmount`.
- Produces:
  - `viewCost()` and `mountCost()` for the router.
  - Pure helpers (exported): `costIsDay`, `costAddDays`, `costParseControls(query, stored, currencies) → { range, from, to, cur, measure }`, `costRangeDays(controls, today) → { from, to }`, `costControlsQuery(controls)`, `costHash(sub, controls)`, `costStoreGet()`, `costStoreSet(controls)`, `costMoney(v, cur)`, `costRibbonItems(status)`, `costUnreadText(u)`, `costTableRows(ledger, groupBy, { measure, cur, filter })`, `costContext(settingsAnswer) → { display, currencies, centers, keys, sources }`; constants `COST_DEFAULT`, `COST_STORE_KEY`.
  - Page state `COST` (`req`, `settings`, `controls`, `view`, `stage`, `table`, `hooked`), `costSub()`, `costQueryOfHash()`, `costName(col, key, ctx)`, `costCall(path, opts) → { status, json }`, `costGet(path)`, `costRefresh(quiet)`, `costErrorHtml(msg)`, `costInstallEvents()`: Task 8 builds the Budgets page on these.
  - Markup hooks: `#cost-app`, `#cost-ribbon`, `#cost-bar`, `#cost-body`, `#cost-table`, `#cost-treemap`; `data-cost-range|cur|measure|date|retry|node|clear-filter|sort|group`.
- Behaviour:
  - A control change stores the choice and sets the hash (`costHash`), so the router renders the page again with its entrance motion. The page refreshes itself every 60 s, quietly (no motion, no skeleton), and skips a refresh while the tab is hidden or a field of the page has focus; `app.js` leaves `cost` out of its 60-second `render(false)`.
  - `#cost/budgets` is not a sub-page yet: the router shows the Overview until Task 8 adds it.

- [ ] **Step 1: Write the failing test**

```js
// The Cost Control pages (public/costview.js): the control bar from the hash and storage, money, the status ribbon and
// the table, without a browser; the page's wiring in index.html, iso.js and app.js; one global scope for every page
// script; and an audit of the file for server or owner text put into markup without esc() (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const U = require('../public/costview');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const CUR = ['USD', 'IDR'];

test('controls: the URL first, else the stored choice, each bad value back to its default', () => {
  const D = { range: '30d', from: null, to: null, cur: 'USD', measure: 'list' };
  assert.deepEqual(U.costParseControls('', null, CUR), D);
  assert.deepEqual(U.costParseControls('range=7d&cur=IDR&measure=billed', null, CUR), {
    ...D,
    range: '7d',
    cur: 'IDR',
    measure: 'billed',
  });
  assert.deepEqual(U.costParseControls('range=custom&from=2026-09-01&to=2026-10-05', null, CUR), {
    ...D,
    range: 'custom',
    from: '2026-09-01',
    to: '2026-10-05',
  });
  for (const q of [
    'range=custom&from=2026-02-30&to=2026-03-02', // a date that does not exist
    'range=custom&from=2026-10-05&to=2026-09-01', // reversed
    'range=custom&from=2025-01-01&to=2026-10-05', // over 400 days
    'range=custom&from=2026-10-01', // half a range
    'range=decade',
  ])
    assert.equal(U.costParseControls(q, null, CUR).range, '30d', q);
  assert.equal(U.costParseControls('cur=IDR', null, ['USD']).cur, 'USD', 'a currency without rates');
  assert.equal(U.costParseControls('measure=both', null, CUR).measure, 'list');
  const stored = JSON.stringify({ range: 'lastmonth', cur: 'IDR', measure: 'billed' });
  assert.deepEqual(U.costParseControls('', stored, CUR), { ...D, range: 'lastmonth', cur: 'IDR', measure: 'billed' });
  assert.deepEqual(U.costParseControls('focus=x', stored, CUR).range, 'lastmonth', 'only the controls count as named');
  assert.equal(U.costParseControls('range=7d', stored, CUR).cur, 'USD', 'a URL that names any control wins whole');
  for (const bad of ['{', '[]', '"7d"', JSON.stringify({ range: 7 })])
    assert.deepEqual(U.costParseControls('', bad, CUR), D, bad);
});

test('controls: the days each range covers, and the query and hash that name them', () => {
  const t = '2026-10-27';
  const days = (range, extra = {}) => U.costRangeDays({ range, ...extra }, t);
  assert.deepEqual(days('7d'), { from: '2026-10-21', to: t });
  assert.deepEqual(days('30d'), { from: '2026-09-28', to: t });
  assert.deepEqual(days('month'), { from: '2026-10-01', to: t });
  assert.deepEqual(days('lastmonth'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(U.costRangeDays({ range: 'lastmonth' }, '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(days('custom', { from: '2026-10-01', to: '2026-10-03' }), { from: '2026-10-01', to: '2026-10-03' });
  assert.equal(U.costControlsQuery({ range: '30d', cur: 'USD', measure: 'list' }), 'range=30d');
  assert.equal(
    U.costHash('breakdown', { range: 'custom', from: '2026-10-01', to: '2026-10-03', cur: 'IDR', measure: 'billed' }),
    '#cost/breakdown?range=custom&from=2026-10-01&to=2026-10-03&cur=IDR&measure=billed',
  );
  assert.equal(U.costHash('', { range: '7d', cur: 'USD', measure: 'list' }), '#cost?range=7d');
  assert.equal(U.costAddDays('2026-03-28', 2), '2026-03-30', 'across a daylight-saving change');
});

test('controls: localStorage is optional; a throwing store reads as empty and writes nothing', () => {
  const saved = global.localStorage;
  try {
    const box = new Map();
    global.localStorage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
    U.costStoreSet({ range: '7d', cur: 'USD', measure: 'list' });
    assert.equal(box.get(U.COST_STORE_KEY), JSON.stringify({ range: '7d', cur: 'USD', measure: 'list' }));
    assert.equal(U.costStoreGet(), box.get('zp.cost.controls'));
    global.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    assert.equal(U.costStoreGet(), null);
    assert.doesNotThrow(() => U.costStoreSet({ range: '7d' }));
    delete global.localStorage;
    assert.equal(U.costStoreGet(), null, 'no storage at all');
  } finally {
    if (saved !== undefined) global.localStorage = saved;
  }
});

test('money: USD to the cent, small amounts to two significant digits, other currencies in whole units', () => {
  assert.equal(U.costMoney(1234.5), '$1,234.50');
  assert.equal(U.costMoney(0.9), '$0.90');
  assert.equal(U.costMoney(0.0423), '$0.042');
  assert.equal(U.costMoney(0), '$0.00');
  assert.equal(U.costMoney(-2.5), '−$2.50');
  assert.equal(U.costMoney(2500000), '$2.5M');
  assert.equal(U.costMoney(1386421.6, 'IDR'), 'IDR 1.4M');
  assert.equal(U.costMoney(61690.4, 'IDR'), 'IDR 61,690');
  assert.equal(U.costMoney(null), '—');
  assert.equal(U.costMoney(NaN, 'IDR'), '—');
});

test('ribbon and notes: the status problems in the server words, unread months by name', () => {
  assert.deepEqual(U.costRibbonItems(null), []);
  assert.deepEqual(U.costRibbonItems({ ledger: { unread: [] }, billing: {}, prices: { problems: [] }, settings: {} }), []);
  assert.deepEqual(
    U.costRibbonItems({
      settings: { error: 'the cost settings in config.json are invalid, so the ledger pass waits until they are fixed' },
      ledger: { error: null, unread: ['2026-10', 'folder'] },
      billing: { error: 'BILLING_UNREAD', historyLost: true },
      prices: { problems: ['price version 3 had 1 unusable model entries that were ignored'] },
    }),
    [
      'the cost settings in config.json are invalid, so the ledger pass waits until they are fixed',
      'October 2026 could not be read: figures leave it out.',
      'The ledger folder could not be read: figures leave it out.',
      'The billing history: BILLING_UNREAD',
      'The billing history was lost: past days are billed as metered until restated.',
      'Prices: price version 3 had 1 unusable model entries that were ignored',
    ],
  );
  assert.equal(U.costUnreadText('corrections'), 'The restate corrections could not be read: figures leave them out.');
});

test('table rows: spend in the chosen currency and measure, shares, the flow filter, empty plan rows left out', () => {
  const led = {
    rows: [
      { model: 'opus', requests: 4, tokens: { in: 10, out: 5 }, listUSD: 6, billedUSD: 0, list: 96000, billed: 0 },
      { model: 'sonnet', requests: 2, tokens: { in: 4 }, listUSD: 2, billedUSD: 2, list: null, billed: null },
      { model: null, requests: 0, tokens: {}, listUSD: 0, billedUSD: 5, list: 0, billed: 80000 },
    ],
  };
  const usd = U.costTableRows(led, ['model'], { measure: 'list', cur: 'USD', filter: null });
  assert.deepEqual(
    usd.rows.map((r) => [r.keys[0], r.spend, r.share, r.tokens, r.perRequest]),
    [
      ['opus', 6, 0.75, 15, 1.5],
      ['sonnet', 2, 0.25, 4, 1],
    ],
  );
  const idr = U.costTableRows(led, ['model'], { measure: 'billed', cur: 'IDR', filter: null });
  assert.deepEqual(
    idr.rows.map((r) => [r.keys[0], r.spend]),
    [
      ['opus', 0],
      ['sonnet', 2],
      [null, 80000],
    ],
    'a day without a rate falls back to USD, as the ledger answers it',
  );
  const one = U.costTableRows(led, ['model'], { measure: 'list', cur: 'USD', filter: { dim: 'model', key: 'sonnet' } });
  assert.deepEqual(
    one.rows.map((r) => [r.keys[0], r.share]),
    [['sonnet', 1]],
  );
});

test('the page is wired: sidebar entry with its badge, sub-pages, scripts before app.js, route, title and mount', () => {
  const html = read('index.html');
  const cost = html.indexOf('<a href="#cost" data-route="cost">');
  assert.ok(cost > html.indexOf('data-route="quality/rankings"') && cost < html.indexOf('data-route="brain"'));
  assert.match(html, /<span data-icon="dollar"><\/span>Cost Control<b class="badge" id="b-cost"><\/b>/);
  for (const sub of ['breakdown', 'value']) assert.match(html, new RegExp(`href="#cost/${sub}" data-route="cost/${sub}"`));
  const app = html.indexOf('<script src="app.js"></script>');
  for (const f of ['costcharts.js', 'costview.js']) {
    const at = html.indexOf(`<script src="${f}"></script>`);
    assert.ok(at > html.indexOf('<script src="iso.js"></script>') && at < app, f);
  }
  const iso = read('iso.js');
  assert.match(iso, /cost: \[\s*\['', 'Overview'\],\s*\['breakdown', 'Breakdown'\],\s*\['value', 'Value'\],/);
  const a = read('app.js');
  assert.match(a, /cost: 'COST CONTROL'/);
  assert.match(a, /cost: viewCost,/);
  assert.match(a, /if \(state\.route === 'cost'\) mountCost\(\);/);
  assert.match(a, /\['live', 'brain', 'integrations', 'trace', 'datasets', 'cost'\]\.includes\(state\.route\)/);
  assert.match(a, /\['settings', 'brain', 'squad', 'trace', 'datasets', 'cost'\]\.includes\(state\.route\)/, 'it refreshes itself');
  const css = read('styles.css');
  for (const c of ['.cost-bar', '.cost-ribbon', '.animate .cost-line', '.cost-stage']) assert.ok(css.includes(c), c);
});

test('every page script shares one global scope: no top-level name is declared twice', () => {
  const html = read('index.html');
  const files = [...html.matchAll(/<script src="([\w.-]+\.js)"><\/script>/g)].map((m) => m[1]);
  assert.ok(files.includes('costview.js') && files.includes('costcharts.js'));
  const seen = new Map();
  const twice = [];
  for (const f of files)
    for (const m of read(f).matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1])) twice.push(`${m[1]}: ${seen.get(m[1])} and ${f}`);
      else seen.set(m[1], f);
    }
  assert.deepEqual(twice, []);
});

test('costview.js builds no markup from server or owner text without esc() (S1) and loads in Node', () => {
  const src = read('costview.js');
  const CONTENT =
    /\.(name|reason|reasons|project|model|center|provider|source|plan|label|title|text|error|message|id|key|value|code|currency|cur|from|to|note|dim|budget)$/;
  const bare = [...src.matchAll(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)].map((m) => m[1]).filter((e) => CONTENT.test(e));
  assert.deepEqual(bare, [], 'content interpolated without esc()');
  // innerHTML takes markup this file built (a cost…Html helper, a template), never a field straight from data.
  for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g))
    assert.doesNotMatch(m[1], /^\s*[\w$.]+\.(message|error|reason|name|text)\s*$/, `innerHTML = ${m[1]}`);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\son[a-z]+=["`']/);
  for (const [name] of src.matchAll(/^(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(name.split(/\s+/).pop(), /^(?:cost|COST)|^(?:viewCost|mountCost)$/, `${name}: starts with cost`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-ui.test.js`
Expected: FAIL (`Cannot find module '../public/costview'`).

- [ ] **Step 3: Write `public/costview.js`**

```js
'use strict';
/* Cost Control (sub-project 3a): the menu's pages. Overview (#cost), Breakdown (#cost/breakdown) and Value
   (#cost/value) draw GET /api/cost/view with the charts of public/costcharts.js; Budgets (#cost/budgets) lists
   GET /api/cost/budgets as cards and edits them in a drawer form. One control bar (range, currency, measure) lives in
   the URL and in localStorage (zp.cost.controls). Pure helpers at the top are exported for Node tests; nothing here
   touches the DOM at load time. Every server or owner string reaches the markup through esc(). */

const COST_SUBS = [
  ['', 'Overview'],
  ['breakdown', 'Breakdown'],
  ['value', 'Value'],
];
const COST_RANGES = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  month: 'This month',
  lastmonth: 'Last month',
  custom: 'Custom',
};
const COST_MEASURES = { list: 'Usage value', billed: 'Paid' };
const COST_STORE_KEY = 'zp.cost.controls';
const COST_MAX_DAYS = 400; // the API's range limit (lib/cost/api.js MAX_DAYS)
const COST_DEFAULT = Object.freeze({ range: '30d', from: null, to: null, cur: 'USD', measure: 'list' });
const COST_SOURCES = {
  claude: 'Claude Code',
  codex: 'Codex',
  gateway: 'Gateway',
  judge: 'Judge',
  replay: 'Replay',
  collab: 'Collaboration',
};
const COST_DIMS = ['day', 'source', 'provider', 'model', 'project', 'center', 'keyId', 'agent', 'kind'];
const COST_DIM_LABEL = {
  day: 'Day',
  source: 'Source',
  provider: 'Provider',
  model: 'Model',
  project: 'Project',
  center: 'Cost center',
  keyId: 'Key',
  agent: 'Agent',
  kind: 'Kind',
};
const COST_MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const COST_REFRESH_MS = 60000;

/* ---------- pure helpers (exported) ---------- */

const costPad = (n) => String(n).padStart(2, '0');
const costDayOf = (d) => `${d.getFullYear()}-${costPad(d.getMonth() + 1)}-${costPad(d.getDate())}`;
const costToday = (now = Date.now()) => costDayOf(new Date(now));
function costIsDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}
// Calendar arithmetic at local noon, as lib/cost/days.js does.
function costAddDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return costDayOf(new Date(y, m - 1, d + n, 12));
}

/** The controls from the hash's query, else the stored last choice; each invalid value falls back to its default. */
function costParseControls(query, stored, currencies = ['USD']) {
  const q = new URLSearchParams(query || '');
  const named = ['range', 'from', 'to', 'cur', 'measure'].some((k) => q.has(k));
  let src = q;
  if (!named && stored) {
    try {
      const o = JSON.parse(stored);
      if (o && typeof o === 'object' && !Array.isArray(o))
        src = new URLSearchParams(Object.entries(o).filter(([, v]) => typeof v === 'string'));
    } catch {
      /* a broken stored value: the defaults */
    }
  }
  const out = { ...COST_DEFAULT };
  const range = src.get('range');
  if (range && Object.hasOwn(COST_RANGES, range)) out.range = range;
  if (out.range === 'custom') {
    const from = src.get('from');
    const to = src.get('to');
    if (costIsDay(from) && costIsDay(to) && from <= to && costAddDays(from, COST_MAX_DAYS) > to) {
      out.from = from;
      out.to = to;
    } else out.range = COST_DEFAULT.range;
  }
  const cur = src.get('cur');
  if (cur && currencies.includes(cur)) out.cur = cur;
  const measure = src.get('measure');
  if (measure && Object.hasOwn(COST_MEASURES, measure)) out.measure = measure;
  return out;
}

/** The days a range covers, ending today (local time). */
function costRangeDays(c, today) {
  if (c.range === 'custom' && c.from && c.to) return { from: c.from, to: c.to };
  if (c.range === '7d') return { from: costAddDays(today, -6), to: today };
  if (c.range === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (c.range === 'lastmonth') {
    const last = costAddDays(`${today.slice(0, 8)}01`, -1);
    return { from: `${last.slice(0, 8)}01`, to: last };
  }
  return { from: costAddDays(today, -29), to: today };
}

/** The query that names the controls: defaults left out, except the range. */
function costControlsQuery(c) {
  const q = new URLSearchParams({ range: c.range });
  if (c.range === 'custom') {
    q.set('from', c.from);
    q.set('to', c.to);
  }
  if (c.cur && c.cur !== 'USD') q.set('cur', c.cur);
  if (c.measure && c.measure !== 'list') q.set('measure', c.measure);
  return q.toString();
}
const costHash = (sub, c) => `#cost${sub ? `/${sub}` : ''}?${costControlsQuery(c)}`;

// localStorage may be off (private mode, blocked site data): the page works without it.
function costStoreGet() {
  try {
    return localStorage.getItem(COST_STORE_KEY);
  } catch {
    return null;
  }
}
function costStoreSet(c) {
  try {
    localStorage.setItem(COST_STORE_KEY, JSON.stringify(c));
  } catch {
    /* not kept */
  }
}

/** Money in the chosen currency: USD to the cent (small amounts to two significant digits), others in whole units. */
function costMoney(v, cur = 'USD') {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  const small = a > 0 && a < (cur === 'USD' ? 0.1 : 1); // a per-request cost: two significant digits
  const body =
    a >= 1e6
      ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(a)
      : small
        ? a.toLocaleString('en', { maximumSignificantDigits: 2 })
        : cur === 'USD'
          ? a.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : Math.round(a).toLocaleString('en');
  return cur === 'USD' ? `${sign}$${body}` : `${sign}${cur} ${body}`;
}
const costPct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);

/** The ledger status ribbon: what /api/cost/status reports as a problem, in the server's path-free words. */
function costRibbonItems(st) {
  if (!st || typeof st !== 'object') return [];
  const out = [];
  if (st.settings && st.settings.error) out.push(String(st.settings.error));
  if (st.ledger && st.ledger.error) out.push(String(st.ledger.error));
  for (const u of (st.ledger && st.ledger.unread) || []) out.push(costUnreadText(u));
  if (st.billing && st.billing.error) out.push('The billing history: ' + st.billing.error); // text: escaped where it is drawn
  if (st.billing && st.billing.historyLost)
    out.push('The billing history was lost: past days are billed as metered until restated.');
  for (const p of (st.prices && st.prices.problems) || []) out.push(`Prices: ${p}`);
  return out;
}
/** "October could not be read: figures leave it out", for a month, the folder or the corrections. */
function costUnreadText(u) {
  if (u === 'folder') return 'The ledger folder could not be read: figures leave it out.';
  if (u === 'corrections') return 'The restate corrections could not be read: figures leave them out.';
  const m = /^(\d{4})-(\d{2})$/.exec(String(u));
  return m
    ? `${COST_MONTH_LONG[Number(m[2]) - 1] || m[0]} ${m[1]} could not be read: figures leave it out.`
    : `${String(u)} could not be read: figures leave it out.`;
}

/* ---------- the page ---------- */

const COST = {
  req: 0, // a newer load wins; an older answer is dropped
  settings: null,
  controls: { ...COST_DEFAULT },
  view: null,
  stage: null, // the treemap's isoStage, destroyed before a repaint
  table: { groupBy: ['model'], sort: { key: 'spend', dir: -1 }, filter: null, rows: null, data: null },
  hooked: false,
};

const costSub = () => (typeof state !== 'undefined' && state.sub) || '';
const costQueryOfHash = () => {
  const h = location.hash;
  const i = h.indexOf('?');
  return i < 0 ? '' : h.slice(i + 1);
};
// Currencies the page can show: USD, and the display currency once it has a rate.
function costContext(settings) {
  const s = (settings && settings.settings) || {};
  const cur = s.currency && Array.isArray(s.currency.rates) && s.currency.rates.length ? s.currency.code : null;
  const centers = Object.fromEntries((s.centers || []).map((c) => [c.id, c.name]));
  const keys = Object.fromEntries(((settings && settings.keys) || []).map((k) => [k.id, k.name || k.id]));
  return {
    display: cur,
    currencies: cur ? ['USD', cur] : ['USD'],
    centers,
    keys,
    sources: (settings && settings.sources) || Object.keys(COST_SOURCES),
  };
}
// A flow node or table cell as people read it.
function costName(col, key, ctx) {
  if (key === '__other') return 'Other';
  if (key === '__plan') return 'Plan fee';
  if (key === '__none' || key == null || key === '') return 'Unknown';
  if (col === 'source') return COST_SOURCES[key] || key;
  if (col === 'center') return ctx.centers[key] || (key === 'unassigned' ? 'Unassigned' : key);
  if (col === 'keyId') return ctx.keys[key] || key;
  return String(key);
}

async function costCall(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) {
    location.href = '/login.html'; // server mode: the session ended
    throw new Error('signed out');
  }
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* not JSON */
  }
  return { status: r.status, json };
}
async function costGet(path) {
  const r = await costCall(path);
  if (r.status !== 200) throw new Error((r.json && r.json.error) || `request failed (${r.status})`);
  return r.json;
}
// Numbers count up on an animated load (render(true)), at once with reduced motion or on a quiet refresh.
function costCountUp(root, fmt) {
  for (const el of root.querySelectorAll('[data-cost-count]')) {
    const to = Number(el.dataset.costCount);
    if (reduceMotion.matches || !to) continue;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / 900);
      el.textContent = fmt(to * (1 - (1 - p) ** 3));
      if (p < 1 && el.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Frames stop in a hidden tab: the number still ends at its value.
    setTimeout(() => (el.textContent = fmt(to)), 1000);
  }
}
const costCount = (v, fmt) => `<span data-cost-count="${Number(v) || 0}">${esc(fmt(v))}</span>`;

function viewCost() {
  const sub = costSub();
  const copy = {
    '': 'This month so far, where it is heading, and the budgets it meets.',
    breakdown: 'Where the money goes: sources, providers, models, cost centers and projects.',
    value: 'What the money bought: plans against their fees, savings, and cost against quality.',
  }[sub];
  const title = (COST_SUBS.find(([s]) => s === sub) || COST_SUBS[0])[1];
  return `<div class="holo-deck cost-deck" id="cost-app">
    ${subTabs('cost')}
    ${subHero(`AI OBSERVABILITY · COST CONTROL`, esc(title), esc(copy || ''))}
    <div id="cost-ribbon"></div>
    <div id="cost-bar"></div>
    <div id="cost-body"><div class="skeleton" style="height:240px"></div></div></div>`;
}

function mountCost() {
  costInstallEvents();
  // The page refreshes itself (app.js leaves it out of the 60-second render).
  const timer = setInterval(() => costRefresh(true), COST_REFRESH_MS);
  onUnmount(() => {
    clearInterval(timer);
    COST.req++; // drop a load still in flight
    COST.stage = null; // unmountStages() destroys it
  });
  costRefresh(false);
}

// A quiet refresh waits while the owner is in a field of the page, and while the tab is hidden.
function costRefresh(quiet) {
  const app = $('#cost-app');
  if (!app) return;
  if (quiet && (document.hidden || app.contains(document.activeElement))) return;
  return costMountPage(costSub(), quiet);
}

function costBarHtml(sub, c, ctx) {
  const seg = (attr, items, on, label) =>
    `<div class="segmented" role="group" aria-label="${label}">${items
      .map(([v, text]) => `<button type="button" ${attr}="${esc(v)}" aria-pressed="${v === on}">${esc(text)}</button>`)
      .join('')}</div>`;
  const today = costToday();
  const days = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const range =
    sub === ''
      ? `<span class="cost-month">This month · day ${Number(today.slice(8))} of ${days}</span>`
      : seg('data-cost-range', Object.entries(COST_RANGES), c.range, 'Range') +
        (c.range === 'custom'
          ? `<span class="cost-dates"><input class="input" type="date" data-cost-date="from" value="${esc(c.from)}" aria-label="From"> – <input class="input" type="date" data-cost-date="to" value="${esc(c.to)}" aria-label="To"></span>`
          : '');
  const cur =
    ctx.currencies.length > 1 ? seg('data-cost-cur', ctx.currencies.map((x) => [x, x]), c.cur, 'Currency') : '';
  const measure = sub === 'value' ? '' : seg('data-cost-measure', Object.entries(COST_MEASURES), c.measure, 'Measure');
  return `<div class="cost-bar">${range}<span class="cost-spacer"></span>${cur}${measure}</div>`;
}

function costRibbonHtml(st) {
  const items = costRibbonItems(st);
  return items.length
    ? `<div class="cost-ribbon" role="status">${items.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`
    : '';
}
// What a view answer leaves out or estimates: unread months, days without a rate, billing that did not read.
function costNotesHtml(v) {
  const notes = [...(v.unread || []).map(costUnreadText)];
  if (v.missingRate && v.missingRate.length)
    notes.push(v.missingRate.length + ' day(s) had no ' + v.currency + ' rate and are counted in USD.');
  if (v.billing && v.billing.error) notes.push('What was paid: ' + v.billing.error + '; billed as metered.');
  if (v.billing && v.billing.historyLost) notes.push('Part of the billing history was lost: those days are billed as metered.');
  return notes.length ? `<div class="cost-notes">${notes.map((n) => `<p class="cost-note">${esc(n)}</p>`).join('')}</div>` : '';
}
const costErrorHtml = (msg) =>
  `<section class="holo panel cost-error" role="alert"><p>Could not load this page: ${esc(msg)}</p><button type="button" class="btn" data-cost-retry>Retry</button></section>`;

async function costMountPage(sub, quiet) {
  const body = $('#cost-body');
  if (!body) return;
  const my = ++COST.req;
  const live = () => my === COST.req && body.isConnected;
  try {
    const [settings, status] = await Promise.all([
      costGet('/api/cost/settings'),
      costGet('/api/cost/status').catch(() => null),
    ]);
    if (!live()) return;
    COST.settings = settings;
    const base = costContext(settings);
    const c = costParseControls(costQueryOfHash(), costStoreGet(), base.currencies);
    COST.controls = c;
    costStoreSet(c);
    const ctx = { ...base, cur: c.cur, measure: c.measure, fmt: (v) => costMoney(v, c.cur) };
    $('#cost-bar').innerHTML = costBarHtml(sub, c, ctx);
    $('#cost-ribbon').innerHTML = costRibbonHtml(status);
    const page = sub || 'overview';
    const q = new URLSearchParams({ page, measure: c.measure });
    if (page !== 'overview') {
      const r = costRangeDays(c, costToday());
      q.set('from', r.from);
      q.set('to', r.to);
    }
    if (c.cur !== 'USD') q.set('currency', c.cur);
    const v = await costGet(`/api/cost/view?${q}`);
    if (!live()) return;
    COST.view = v;
    if (COST.stage) COST.stage.destroy();
    COST.stage = null;
    const html = page === 'overview' ? costOverviewHtml(v, ctx) : page === 'breakdown' ? costBreakdownHtml(v, ctx) : costValueHtml(v, ctx);
    body.innerHTML = costNotesHtml(v) + html;
    if (page === 'breakdown') {
      const canvas = $('#cost-treemap');
      if (canvas && v.treemap.length)
        COST.stage = costMountTreemap(canvas, costTreemapLayout(v.treemap), {
          fmt: ctx.fmt,
          label: (col, key) => costName(col, key, ctx),
          grow: !quiet,
        });
      costLoadTable(ctx, live);
    }
    if (!quiet && $('#view').classList.contains('animate')) costCountUp(body, ctx.fmt);
  } catch (e) {
    if (!live()) return;
    body.innerHTML = costErrorHtml(e.message);
  }
}

/* ---------- Overview ---------- */

function costOverviewHtml(o, ctx) {
  const fmt = ctx.fmt;
  const paid = ctx.measure === 'billed';
  const center = o.topCenter;
  const tiles = [
    metricTile({
      label: paid ? 'This month · paid' : 'This month · usage value',
      value: costCount(o.total, fmt),
      sub: esc(paid ? `Usage value ${fmt(o.spent.list)}` : `Paid ${fmt(o.spent.billed)}`),
      spark: o.daily.map((d) => d.spend),
      color: COST_C.cyan,
    }),
    metricTile({
      label: 'Forecast · month end',
      value: costCount(o.forecast.projected, fmt),
      sub: esc(o.forecast.early ? 'early in the month: no band yet' : `${fmt(o.forecast.low)} – ${fmt(o.forecast.high)}`),
      color: COST_C.violet,
    }),
    `<a class="cost-tile-link" href="#cost/budgets">${metricTile({
      label: 'Budgets at risk',
      value: `${o.atRisk.count} of ${o.atRisk.total}`,
      sub: o.atRisk.total ? 'used up, projected over or past a level' : 'no budgets yet',
      color: o.atRisk.count ? COST_C.pink : COST_C.cyan,
      p: o.atRisk.total ? o.atRisk.count / o.atRisk.total : null,
    })}</a>`,
    metricTile({
      label: 'Top cost center',
      value: center ? esc(costName('center', center.center, ctx)) : '—',
      sub: center ? esc(`${costPct(center.share)} · ${fmt(center.spend)}`) : 'nothing spent yet',
      color: COST_C.orange,
      p: center ? center.share : null,
    }),
  ];
  const add = o.budgetLines.length
    ? ''
    : '<p class="cost-note"><a href="#cost/budgets">Add a monthly budget</a> to see it against the forecast.</p>';
  const rings = costRingsHtml(o.rings, o.moreBudgets) || holoEmpty('No budgets yet. <a href="#cost/budgets">Add one</a>.');
  return `<div class="live-metrics">${tiles.join('')}</div>
    ${panel('Burn-down', esc(`day ${o.month.day} of ${o.month.days}${o.forecast.early ? ' · early in the month' : ' · band: 25th–75th percentile days'}`), costBurnSvg(o, fmt) + add)}
    <div class="live-grid">
      ${panel('Daily spend and spikes', 'each day against the 7 days before it', costSpikeSvg(o.spikes, fmt))}
      ${panel('Budgets', esc(`${o.atRisk.count} at risk`), rings)}
    </div>`;
}

/* ---------- Breakdown ---------- */

function costBreakdownHtml(b, ctx) {
  const fmt = ctx.fmt;
  const label = (col, key) => costName(col, key, ctx);
  const flow = b.flow.links.length ? costFlowSvg(b.flow, { fmt, label }) : holoEmpty('Nothing spent in this range.');
  const centers = b.treemap
    .map((c, i) => `<span><i style="background:${COST_SERIES[i % COST_SERIES.length]}"></i>${esc(label('center', c.center))} · ${esc(fmt(c.spend))}</span>`)
    .join('');
  const stage = b.treemap.length
    ? `<section class="holo stage cost-stage"><canvas id="cost-treemap" aria-label="Projects by cost center: footprint by spend, height by spend per request"></canvas>
        <div class="stage-tl"><div class="holo-kicker">PROJECTS BY COST CENTER</div><div class="stage-key">Footprint = share of spend · height = spend per request · hover a block${b.planFee ? esc(` · plan fees (${fmt(b.planFee)}) have no project`) : ''}</div></div>
        <div class="stage-legend cost-legend">${centers}</div></section>`
    : panel('Projects by cost center', '', holoEmpty('No project spend in this range.'));
  return `${panel('Cost flow', esc(`${fmt(b.total)} · source → provider → model → cost center · click a node to filter the table`), flow)}
    ${stage}
    ${panel('Calendar', 'weeks across, Monday to Sunday down', `<div class="cost-scroll">${costCalendarSvg(b.calendar, fmt)}</div>`)}
    ${panel('Table', 'from the ledger', '<div id="cost-table"><div class="skeleton" style="height:120px"></div></div>')}`;
}

// The table reads GET /api/cost/ledger with its own grouping, so it can be regrouped without a new view request.
async function costLoadTable(ctx, live) {
  const host = $('#cost-table');
  const t = COST.table;
  ctx = ctx || (t.data && t.data.ctx); // a regroup or a filter keeps the page's context
  if (!host || !ctx) return;
  const c = COST.controls;
  const r = costRangeDays(c, costToday());
  const groupBy = [...t.groupBy];
  if (t.filter && !groupBy.includes(t.filter.dim)) groupBy.unshift(t.filter.dim);
  const q = new URLSearchParams({ from: r.from, to: r.to, groupBy: groupBy.slice(0, 4).join(',') });
  if (c.cur !== 'USD') q.set('currency', c.cur);
  try {
    const led = await costGet(`/api/cost/ledger?${q}`);
    if (live && !live()) return;
    t.data = { led, groupBy: groupBy.slice(0, 4), ctx };
    costPaintTable();
  } catch (e) {
    if (live && !live()) return;
    host.innerHTML = `<p class="cost-note">${esc('The table did not load: ' + e.message)}</p>`;
  }
}
function costTableRows(led, groupBy, { measure, cur, filter }) {
  const field = measure === 'billed' ? (cur === 'USD' ? 'billedUSD' : 'billed') : cur === 'USD' ? 'listUSD' : 'list';
  const rows = (led.rows || [])
    .filter((x) => !filter || String(x[filter.dim] ?? '') === filter.key)
    .map((x) => {
      const spend = x[field] == null ? x[measure === 'billed' ? 'billedUSD' : 'listUSD'] : x[field];
      if (!spend && !x.requests) return null; // a plan row under usage value: nothing to show
      const tokens = Object.values(x.tokens || {}).reduce((a, n) => a + (Number(n) || 0), 0);
      return { keys: groupBy.map((d) => x[d]), spend, requests: x.requests, tokens, perRequest: x.requests ? spend / x.requests : null };
    })
    .filter(Boolean);
  const total = rows.reduce((a, x) => a + (x.spend || 0), 0);
  for (const x of rows) x.share = total > 0 ? x.spend / total : null;
  return { rows, total };
}
function costPaintTable() {
  const host = $('#cost-table');
  const t = COST.table;
  if (!host || !t.data) return;
  const { led, groupBy, ctx } = t.data;
  const { rows } = costTableRows(led, groupBy, { measure: ctx.measure, cur: ctx.cur, filter: t.filter });
  const s = t.sort;
  const val = (x) => (s.key.startsWith('k') ? String(x.keys[Number(s.key.slice(1))] ?? '') : x[s.key] ?? -Infinity);
  rows.sort((a, b) => {
    const A = val(a);
    const B = val(b);
    return (typeof A === 'string' ? A.localeCompare(B) : A - B) * s.dir;
  });
  const head = (key, text, num) =>
    `<th${num ? ' class="num"' : ''}><button type="button" class="cost-sort" data-cost-sort="${key}" aria-sort="${s.key === key ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(text)}${s.key === key ? (s.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`;
  const picks = COST_DIMS.map(
    (d) =>
      `<label class="cost-check"><input type="checkbox" data-cost-group="${d}" ${t.groupBy.includes(d) ? 'checked' : ''} ${!t.groupBy.includes(d) && t.groupBy.length >= 4 ? 'disabled' : ''}> ${COST_DIM_LABEL[d]}</label>`,
  ).join('');
  const chip = t.filter
    ? `<span class="cost-chip">${esc(`${COST_DIM_LABEL[t.filter.dim] || t.filter.dim}: ${costName(t.filter.dim, t.filter.key, ctx)}`)} <button type="button" data-cost-clear-filter aria-label="Clear the filter">×</button></span>`
    : '';
  const body = rows.length
    ? rows
        .slice(0, 500)
        .map(
          (x) =>
            `<tr>${x.keys.map((k, i) => `<td>${esc(costName(groupBy[i], k, ctx))}</td>`).join('')}<td class="num">${esc(ctx.fmt(x.spend))}</td><td class="num">${esc(costPct(x.share))}</td><td class="num">${(x.requests || 0).toLocaleString('en')}</td><td class="num">${(x.tokens || 0).toLocaleString('en')}</td><td class="num">${esc(ctx.fmt(x.perRequest))}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="${groupBy.length + 5}">${esc('Nothing in this range.')}</td></tr>`;
  host.innerHTML = `<div class="cost-table-bar"><span>Group by (up to 4):</span>${picks}${chip}</div>
    <div class="table-wrap"><table class="cost-table"><thead><tr>${groupBy.map((d, i) => head(`k${i}`, COST_DIM_LABEL[d] || d, false)).join('')}${head('spend', 'Spend', true)}${head('share', 'Share', true)}${head('requests', 'Requests', true)}${head('tokens', 'Tokens', true)}${head('perRequest', 'Per request', true)}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- Value ---------- */

function costValueHtml(v, ctx) {
  const fmt = ctx.fmt;
  const w = v.waterfall;
  const plans = v.plans.length
    ? costPlanBarsHtml(v.plans, fmt, (s) => COST_SOURCES[s] || s)
    : holoEmpty('No source was on a plan in this range.');
  const scatter = v.scatter.dots.length
    ? costScatterSvg(v.scatter, fmt)
    : holoEmpty('No model with measured tool calls in this range.');
  const unmeasured = v.scatter.noToolCalls.length
    ? `<p class="cost-note">No tool calls to measure: ${esc(v.scatter.noToolCalls.map((m) => m.model).join(', '))}.</p>`
    : '';
  const unit = (key, title, color, note) =>
    panel(esc(title), esc(note), costUnitSvg(v.unit, key, fmt, color));
  return `${panel('Plan value against plan fee', 'usage value of the plan days against what the plan cost', plans)}
    <div class="live-grid">
      ${panel('Savings', 'cache savings are an estimate at base rates', costWaterfallSvg(w, fmt))}
      ${panel('Local models', 'requests and tokens, not priced', costLocalHtml(v.local))}
    </div>
    ${panel('Cost against quality', 'spend per request against tool-call accuracy · dot size = requests · hollow = little data', scatter + unmeasured)}
    <div class="cost-units">
      ${unit('perRequest', 'Per request', COST_C.cyan, 'spend per request')}
      ${unit('perMillionTokens', 'Per million tokens', COST_C.violet, 'all token kinds')}
      ${unit('perThousandToolCalls', 'Per 1,000 successful tool calls', COST_C.pink, 'Claude Code and Codex spend only')}
    </div>`;
}

/* ---------- events (installed once) ---------- */

function costSetControls(next) {
  costStoreSet(next);
  location.hash = costHash(costSub(), next);
}
const COST_CLICKS = ['range', 'cur', 'measure', 'retry', 'node', 'clear-filter', 'sort']
  .map((k) => `#cost-app [data-cost-${k}]`)
  .join(', ');
function costInstallEvents() {
  if (COST.hooked) return;
  COST.hooked = true;
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest(COST_CLICKS);
    if (!t) return;
    const d = t.dataset;
    const c = COST.controls;
    if (d.costRange) {
      const next = { ...c, range: d.costRange };
      if (next.range === 'custom') Object.assign(next, costRangeDays(c, costToday()));
      return costSetControls(next);
    }
    if (d.costCur) return costSetControls({ ...c, cur: d.costCur });
    if (d.costMeasure) return costSetControls({ ...c, measure: d.costMeasure });
    if (t.hasAttribute('data-cost-retry')) return void costRefresh(false);
    if (d.costNode) return costFilterTo(d.costNode);
    if (t.hasAttribute('data-cost-clear-filter')) {
      COST.table.filter = null;
      return void costLoadTable(null, null);
    }
    if (d.costSort) {
      const s = COST.table.sort;
      COST.table.sort = { key: d.costSort, dir: s.key === d.costSort ? -s.dir : -1 };
      return costPaintTable();
    }
  });
  document.addEventListener('keydown', (e) => {
    const node = e.target.closest && e.target.closest('#cost-app [data-cost-node]');
    if (node && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      costFilterTo(node.dataset.costNode);
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('#cost-app')) return;
    if (t.dataset.costDate) {
      const c = COST.controls;
      const r = costRangeDays(c, costToday());
      const next = { ...c, range: 'custom', from: r.from, to: r.to, [t.dataset.costDate]: t.value };
      // A broken or reversed pair, or more than 400 days, is not applied: the bar keeps the last good range.
      const ok = costParseControls(costControlsQuery(next), null, [c.cur]);
      if (ok.range === 'custom') costSetControls(ok);
      return;
    }
    if (t.dataset.costGroup) {
      const g = COST.table.groupBy.filter((x) => x !== t.dataset.costGroup);
      if (t.checked) g.push(t.dataset.costGroup);
      if (g.length) COST.table.groupBy = COST_DIMS.filter((x) => g.includes(x)).slice(0, 4);
      costLoadTable(null, null);
    }
  });
}
// A flow node filters the table to it (its dimension is added to the grouping when missing).
function costFilterTo(id) {
  const i = String(id).indexOf(':');
  if (i < 0) return;
  const dim = id.slice(0, i);
  if (!COST_DIMS.includes(dim)) return;
  COST.table.filter = { dim, key: id.slice(i + 1) };
  costLoadTable(null, null);
  const host = $('#cost-table');
  if (host) host.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

if (typeof module !== 'undefined')
  module.exports = {
    COST_DEFAULT,
    COST_STORE_KEY,
    costIsDay,
    costAddDays,
    costParseControls,
    costRangeDays,
    costControlsQuery,
    costHash,
    costStoreGet,
    costStoreSet,
    costMoney,
    costRibbonItems,
    costUnreadText,
    costTableRows,
    costContext,
  };
```

- [ ] **Step 4: The sidebar and the scripts, `public/index.html`**

After the Quality "Rankings" link (`:43`):

```html
        <a href="#cost" data-route="cost"><span data-icon="dollar"></span>Cost Control<b class="badge" id="b-cost"></b></a>
        <a class="nav-sub" href="#cost/breakdown" data-route="cost/breakdown">Breakdown</a>
        <a class="nav-sub" href="#cost/value" data-route="cost/value">Value</a>
```

After `<script src="runtimesview.js"></script>` (`:137`):

```html
  <script src="costcharts.js"></script>
  <script src="costview.js"></script>
```

- [ ] **Step 5: The sub-pages, `public/iso.js`** — in `SUBPAGES`, before `squad: [` (`:589`):

```js
  cost: [
    ['', 'Overview'],
    ['breakdown', 'Breakdown'],
    ['value', 'Value'],
  ],
```

- [ ] **Step 6: The router, `public/app.js`**

1. `TITLES` (`:238`), after `datasets: 'DATASETS',`: `cost: 'COST CONTROL',`
2. `VIEWS` (`:1090`), after `datasets: viewDatasets,`: `cost: viewCost,`
3. `render()` (`:1144`): the pages that draw without the summary gain `'cost'`:

```js
  if (!state.data && !['live', 'brain', 'integrations', 'trace', 'datasets', 'cost'].includes(state.route)) {
```

4. After `if (state.route === 'datasets') mountDatasets();` (`:1159`):

```js
  if (state.route === 'cost') mountCost();
```

5. The 60-second refresh (`:1331-1334`) leaves the page to its own refresh:

```js
      !['settings', 'brain', 'squad', 'trace', 'datasets', 'cost'].includes(state.route) &&
      !$('#view').contains(document.activeElement)
    )
      render(false); // squad, trace and cost pages poll on their own
```

The crumb group stays "AI OBSERVABILITY" (the default branch), and the crumb reads `COST CONTROL / BREAKDOWN` from `SUBPAGES`.

- [ ] **Step 7: Styles, `public/styles.css`** — append:

```css

/* ---------- Cost Control (public/costview.js, public/costcharts.js) ---------- */
.cost-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.cost-spacer {
  flex: 1;
}
.cost-month {
  color: var(--h-muted);
  font-size: 13px;
}
.cost-dates {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cost-dates .input {
  width: 150px;
}
.cost-ribbon {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 8px 14px;
  border: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-ink);
  border-radius: 12px;
  font-size: 12.5px;
}
.cost-notes {
  display: grid;
  gap: 4px;
}
.cost-note {
  margin: 6px 0 0;
  color: var(--h-muted);
  font-size: 12.5px;
}
.cost-note.warn {
  color: var(--warn-ink);
}
.cost-note a,
.cost-deck .empty a {
  color: var(--h-cyan);
}
.cost-error {
  display: flex;
  align-items: center;
  gap: 14px;
  justify-content: space-between;
}
.cost-tile-link {
  color: inherit;
  text-decoration: none;
  display: block;
}
.cost-tile-link .metric {
  height: 100%;
}
/* A counting value inside a tile's number: .metric span is the tile's label style. */
.metric b [data-cost-count] {
  font: inherit;
  letter-spacing: inherit;
  text-transform: none;
  color: inherit;
}
.cost-chart text {
  fill: var(--h-muted);
  font-size: 10.5px;
}
.cost-chart .cost-val {
  fill: var(--h-text);
  font-weight: 600;
}
.cost-today {
  stroke: rgba(223, 230, 255, 0.35);
  stroke-dasharray: 2 3;
}
.cost-join {
  stroke: rgba(223, 230, 255, 0.3);
  stroke-dasharray: 3 3;
}
.cost-rings {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.cost-ring {
  display: grid;
  justify-items: center;
  gap: 4px;
  width: 92px;
  color: var(--h-text);
  text-decoration: none;
  font-size: 11.5px;
  text-align: center;
}
.cost-ring span {
  max-width: 92px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cost-ring-svg text {
  fill: var(--h-text);
  font-size: 13px;
  font-weight: 700;
}
.cost-more {
  align-self: center;
  color: var(--h-cyan);
}
.cost-node.cost-click {
  cursor: pointer;
}
.cost-node.cost-click:focus-visible rect,
.cost-node.cost-click:hover rect {
  stroke: #fff;
  stroke-width: 1.5;
}
.cost-node text {
  fill: var(--h-text);
  font-size: 11px;
}
.cost-link:hover {
  fill-opacity: 0.5;
}
.cost-scroll {
  overflow-x: auto;
}
.cost-calendar {
  display: block;
}
.cost-stage {
  height: clamp(320px, 40vw, 440px);
}
.cost-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}
.cost-legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: 6px;
}
.cost-table-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin-bottom: 10px;
  font-size: 12.5px;
  color: var(--h-muted);
}
.cost-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.cost-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--chip-blue);
  color: var(--chip-blue-ink);
  font-size: 11.5px;
}
.cost-chip.warn {
  background: var(--chip-amber);
  color: var(--chip-amber-ink);
}
.cost-chip button {
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.cost-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.cost-table th,
.cost-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--grid);
  text-align: left;
}
.cost-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.cost-sort {
  border: 0;
  background: none;
  color: var(--h-muted);
  font: inherit;
  cursor: pointer;
  padding: 0;
}
.cost-plans {
  display: grid;
  gap: 14px;
}
.cost-plan-head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
  margin-bottom: 6px;
}
.cost-plan-head span {
  color: var(--h-muted);
  font-size: 12px;
}
.cost-plan-head em {
  margin-left: auto;
  font-style: normal;
  font-weight: 700;
  color: var(--h-cyan);
}
.cost-plan.under .cost-plan-head em {
  color: #ff9a3c;
}
.cost-plan .cost-pbar {
  position: relative;
  height: 22px;
  margin: 4px 0;
  border-radius: 6px;
  background: rgba(120, 140, 255, 0.08);
  overflow: hidden;
}
.cost-plan .cost-pbar i {
  display: block;
  height: 100%;
  border-radius: 6px;
}
.cost-plan .cost-pbar span {
  position: absolute;
  left: 8px;
  top: 3px;
  font-size: 12px;
  color: var(--h-text);
}
.cost-units {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.cost-dot text {
  fill: var(--h-text);
  font-size: 11px;
}
/* Entrance motion, only while #view has .animate (render(true) without prefers-reduced-motion). */
.animate .cost-line {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: cost-draw 1.2s ease-out forwards;
}
.animate .cost-grow {
  transform-box: fill-box;
  transform-origin: bottom;
  animation: cost-grow 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.animate .cost-grow-x {
  transform-origin: left;
  animation: cost-grow-x 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.animate .cost-fade,
.animate .cost-cell,
.animate .cost-band {
  animation: cost-fade 0.9s ease-out both;
}
.animate .cost-pop,
.animate .cost-ring-arc {
  transform-box: fill-box;
  transform-origin: center;
  animation: cost-pop 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.animate .cost-spike {
  animation: cost-pulse 1.6s ease-in-out 0.8s 2;
}
@keyframes cost-draw {
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes cost-grow {
  from {
    transform: scaleY(0);
  }
}
@keyframes cost-grow-x {
  from {
    transform: scaleX(0);
  }
}
@keyframes cost-fade {
  from {
    opacity: 0;
  }
}
@keyframes cost-pop {
  from {
    transform: scale(0.2);
    opacity: 0;
  }
}
@keyframes cost-pulse {
  50% {
    opacity: 0.35;
  }
}
@keyframes cost-slide {
  from {
    transform: translateX(100%);
  }
}
@media (max-width: 900px) {
  .cost-units {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cost-deck *,
  .cost-drawer {
    animation: none !important;
    transition: none !important;
  }
}
```

The `.animate` rules only play while `#view` has the class, which `render()` sets only without `prefers-reduced-motion`; the global reduced-motion rule (`:1715`) and the last block stop any animation that is left.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test test/cost-ui.test.js test/cost-charts.test.js test/cost-charts-value.test.js test/topology-ui.test.js test/monitors-ui.test.js`
Expected: PASS.

- [ ] **Step 9: Check it in the demo**

Run: `npm run demo` and open the dashboard.
Expected:
- the sidebar shows Cost Control (dollar icon) after Quality & safety, with Breakdown and Value under it when open;
- Overview: four tiles counting up, the burn-down with its forecast and band and the $1,000 "Monthly budget" line, the spike bars (a pink marker on a day that doubled its baseline, if any), the budget rings (Acme gateway key first, pink and over 100 %);
- Breakdown: the flow (Claude Code → anthropic → claude-opus-5-5 → Client: Acme …), the isometric treemap growing (drag to turn), the calendar, the table; clicking a model node shows a "Model: …" chip and filters the table; "Paid" adds the "Plan fee" node;
- Value: the Claude Max bars (below 1× in the demo, so orange with its note), the waterfall, the qwen3:8b local row, a scatter of claude-opus-5-5, claude-sonnet-5-5 and gpt-6.1-sol, "No tool calls to measure: deepseek-chat, llama-3.3-70b, qwen3:8b", three unit lines;
- the range, IDR and Paid buttons change the URL and survive a reload; `#cost/value?range=garbage` shows Last 30 days; with the system's reduced motion on, everything appears at once.

- [ ] **Step 10: Commit**

```bash
git add public/costview.js public/index.html public/iso.js public/app.js public/styles.css test/cost-ui.test.js
git commit -m "Cost Control menu: Overview, Breakdown and Value pages with a shared control bar"
```

---
### Task 8: Budgets page, form drawer and the bell's link (shared: `public/*`, `lib/monitors/api.js`, one test assertion)

**Files:**
- Modify: `public/costview.js` (from Task 7): constants, helpers, page state, `viewCost`, `mountCost`/`costRefresh`, a Budgets section, the exports
- Modify: `public/iso.js` (the `cost` entry of `SUBPAGES`, Task 7), `public/index.html` (the sidebar, Task 7), `public/app.js:1297` and `:1327` (the badge), `public/styles.css` (append)
- Modify: `public/monitorsview.js:102` (a constant), `:157` (the budget branch of `alertLine`), `:555` (`monAlertRow`)
- Modify: `lib/monitors/api.js:34` (a constant), `:390` (the budget alert row)
- Modify: `test/budgets-monitors.test.js:422` (the budget alert row gains `budget`; one assertion changes on purpose)
- Test: `test/cost-budgets-ui.test.js`

**Interfaces:**
- Consumes: Task 7's `COST`, `costSub`, `costQueryOfHash`, `costContext`, `costCall`, `costGet`, `costErrorHtml`, `costRefresh`, `costInstallEvents`, `costMoney`, `costToday`, `costAddDays`, `COST_MEASURES`, `COST_SOURCES`; Task 5's `costRingSvg`; `GET /api/cost/budgets` (`budgets`, `error`, `reasons`, `guard { error, problems }`, `kept { error }`), `POST /api/cost/budgets` (200 `{ budget }`, 400 `{ error, reasons }`, 409 `{ error }`), `POST /api/cost/budgets/<id>/delete`, `GET /api/cost/settings` (`settings.centers`, `settings.currency`, `keys`, `sources`), `GET /api/cost/ledger` (`groupBy=project|model|provider`, for suggestions); `lib/cost/budgets.js` `mayBlock`/`mayPause`/`validateBudget` (in the test).
- Produces:
  - Pure helpers (exported): `costScopeLabel(scope, ctx)`, `costPeriodLabel(view)`, `costBudgetOrder(list)`, `costTone(state)`, `costBadgeCount(list)`, `costIdFrom(name, taken)`, `costEnforceOptions(scope) → [{ value, label, ok, why }]`, `costFormBody(fields, { id }) → { ok, body } | { ok: false, errors }`, `costBudgetBanners(answer, { budgets }) → [{ tone, title, lines, note }]`, `costBudgetCardHtml(view, ctx, locked)`, `costFormHtml(view | null, ctx, takenIds)`.
  - `costBadge()` (fetches `/api/cost/budgets`, paints `#b-cost`), called at boot and on the 60-second cycle.
  - `/api/alerts` budget rows carry `budget: <budget id>` (the `instance` stays opaque); `alertLine` sets `budgetHref: '#cost/budgets?focus=<id>'`, and the drawer row shows "Open in Budgets →".
  - Markup hooks: `#cost-form-host`, `#cost-form`, `#cost-form-id`, `#cost-form-msg`, `#cost-scope-values`, `#cost-enforce`, `[data-cost-card]`; `data-cost-add|edit|delete|confirm-delete|cancel-delete|close-form`.
- Behaviour:
  - Cards riskiest first; while `error` is set the Add, Edit and Delete buttons are disabled with "Fix config.json first" (the API answers 409 then).
  - The form is a drawer inside `#cost-app`; the page's quiet refresh skips while it (or a delete confirmation) is open, so typed values are never lost. Escape or Cancel closes it and gives focus back to its opener.
  - A new budget's id is shown read-only and follows the name; an edited budget keeps its id. Enforcement choices the scope does not allow are disabled with the reason, and redrawn when the scope changes. Save posts the body; 400 lists `reasons`, 409 shows its message, 200 closes the drawer and reloads the list.
  - Delete asks in the card; a failure is shown in the card.
  - `#cost/budgets?focus=<id>` scrolls to the card and highlights it for 2.4 s.

- [ ] **Step 1: Write the failing test**

```js
// Cost Control → Budgets (public/costview.js): labels, ordering, the badge, the id from a name, the enforcement
// choices against the server's rules, the form to the request body, the status banners and the card and form markup;
// the bell's "Open in Budgets" link (public/monitorsview.js) and the budget id it reads from /api/alerts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const B = require('../lib/cost/budgets');
const { NO_JUDGE_PORTS } = require('./helpers');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
global.costRingSvg = require('../public/costcharts').costRingSvg; // the page loads costcharts.js beside it
const U = require('../public/costview');
const { alertLine, monAlertsBody } = require('../public/monitorsview');

const EVIL = '<img src=x onerror=alert(1)>';
const CTX = { centers: { platform: 'Platform' }, keys: { key_a1: 'ci-bot' }, display: 'IDR', sources: ['claude', 'gateway'] };
const view = (over = {}) => ({
  id: 'team',
  name: 'Team',
  scope: 'global',
  period: 'month',
  amount: 100,
  currency: 'USD',
  measure: 'list',
  thresholds: [50, 80],
  projection: true,
  enforce: 'none',
  legacy: null,
  from: '2026-10-01',
  to: '2026-10-31',
  state: 'ok',
  projected: false,
  spent: 12.5,
  percent: 12.5,
  reason: null,
  ...over,
});

test('labels: the scope with names, the period with its dates', () => {
  assert.equal(U.costScopeLabel('global', CTX), 'Global');
  assert.equal(U.costScopeLabel({ dim: 'center', value: 'platform' }, CTX), 'Center · Platform');
  assert.equal(U.costScopeLabel({ dim: 'center', value: 'unassigned' }, CTX), 'Center · Unassigned');
  assert.equal(U.costScopeLabel({ dim: 'key', value: 'key_a1' }, CTX), 'Key · ci-bot');
  assert.equal(U.costScopeLabel({ dim: 'key', value: 'key_zz' }, CTX), 'Key · key_zz');
  assert.equal(U.costScopeLabel({ dim: 'source', value: 'claude' }, CTX), 'Source · Claude Code');
  assert.equal(U.costScopeLabel({ dim: 'project', value: '~/acme' }, CTX), 'Project · ~/acme');
  assert.equal(U.costPeriodLabel(view()), 'Month · 1–31 Oct');
  assert.equal(U.costPeriodLabel(view({ period: 'week', from: '2026-10-26', to: '2026-11-01' })), 'Week · 26 Oct – 1 Nov');
  assert.equal(U.costPeriodLabel(view({ period: 'day', from: '2026-10-27', to: '2026-10-27' })), 'Day · 27 Oct');
});

test('ordering, tones and the badge: riskiest first; used up or projected over count', () => {
  const list = [
    view({ id: 'a', state: 'ok', percent: 10 }),
    view({ id: 'b', state: 'warn_80', percent: 85 }),
    view({ id: 'c', state: 'exceeded', percent: 120 }),
    view({ id: 'd', state: 'ok', percent: 40, projected: true }),
    view({ id: 'e', state: 'no_data', percent: null }),
  ];
  assert.deepEqual(
    U.costBudgetOrder(list).map((b) => b.id),
    ['c', 'd', 'b', 'a', 'e'],
  );
  assert.deepEqual(
    ['ok', 'warn_50', 'exceeded', 'no_data'].map(U.costTone),
    ['ok', 'warn', 'exceeded', 'none'],
  );
  assert.equal(U.costBadgeCount(list), 2);
  assert.equal(U.costBadgeCount(null), 0);
});

test('the id of a new budget comes from its name, with a suffix when taken', () => {
  assert.equal(U.costIdFrom('Whole Team!'), 'whole-team');
  assert.equal(U.costIdFrom('  Ácme — gateway  '), 'cme-gateway');
  assert.equal(U.costIdFrom(''), 'budget');
  assert.equal(U.costIdFrom('***'), 'budget');
  assert.equal(U.costIdFrom('Team', ['team', 'team-2']), 'team-3');
  assert.equal(U.costIdFrom('constructor'), 'constructor-2');
  assert.equal(U.costIdFrom('x'.repeat(90)).length, 60);
  for (const n of ['Whole Team!', '', 'constructor', 'a'.repeat(90), '-x-']) {
    const r = B.validateBudget({ id: U.costIdFrom(n), name: 'n', scope: 'global', period: 'month', amount: 1 }, {});
    assert.ok(r.ok, `${n}: ${JSON.stringify(r.errors)}`);
  }
});

test('enforcement choices match the server: block and pause are offered exactly where lib/cost/budgets.js allows them', () => {
  const scopes = ['global'];
  for (const dim of B.DIMS) for (const value of ['x', 'gateway', 'claude', 'codex', 'judge']) scopes.push({ dim, value });
  for (const scope of scopes) {
    const o = Object.fromEntries(U.costEnforceOptions(scope).map((x) => [x.value, x]));
    const what = JSON.stringify(scope);
    assert.equal(o.none.ok, true, what);
    assert.equal(o.block.ok, B.mayBlock(scope), `block ${what}`);
    assert.equal(o.pause.ok, B.mayPause(scope), `pause ${what}`);
    if (!o.block.ok) assert.match(o.block.why, /gateway requests only/);
    if (!o.pause.ok) assert.match(o.pause.why, /local agent only/);
  }
});

test('the form to the request body: the server accepts it; a bad field is named before sending', () => {
  const f = {
    name: ' Team ',
    dim: 'center',
    value: 'platform',
    period: 'week',
    amount: '120.5',
    currency: 'IDR',
    measure: 'billed',
    warn1: '60',
    warn2: '',
    projection: false,
    enforce: 'pause',
  };
  const r = U.costFormBody(f, { id: 'team' });
  assert.deepEqual(r, {
    ok: true,
    body: {
      id: 'team',
      name: 'Team',
      scope: { dim: 'center', value: 'platform' },
      period: 'week',
      amount: 120.5,
      currency: 'IDR',
      measure: 'billed',
      thresholds: [60],
      projection: false,
      enforce: 'pause',
    },
  });
  const v = B.validateBudget(r.body, { currency: 'IDR', centers: ['platform'], home: '/home/o' });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(U.costFormBody({ ...f, dim: 'global', value: 'ignored', projection: 'on' }, { id: 'x' }).body.scope, 'global');
  const bad = U.costFormBody(
    { name: '', dim: 'project', value: ' ', period: 'year', amount: '0', warn1: '80', warn2: '50', enforce: 'block' },
    { id: 'x' },
  );
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [
    'Name: 1 to 60 characters',
    'Project: name one',
    'Period: day, week or month',
    'Amount: a number above 0',
    'Warning levels: whole numbers from 1 to 99, the second above the first',
    'Enforcement: block reaches gateway requests only: not a project or a local source',
  ]);
  assert.deepEqual(U.costFormBody({ ...f, warn1: '', warn2: '' }, { id: 't' }).body.thresholds, []);
});

test('status banners: a hand edit that does not validate, the kept list, the guard letting requests through', () => {
  assert.deepEqual(U.costBudgetBanners({ budgets: [], error: null, reasons: [], guard: { error: null, problems: [] }, kept: { error: null } }), []);
  const out = U.costBudgetBanners(
    {
      budgets: [],
      error: 'budgets in config.json are invalid; the last valid list is in force',
      reasons: ['budgets[0].amount: a number above 0, up to 1e12'],
      guard: { error: null, problems: [{ budget: 'acme', reason: 'no rates for IDR', since: null }, { budget: null, reason: 'the list did not read', since: null }] },
      kept: { error: 'the last valid budget list could not be kept' },
    },
    { budgets: [{ id: 'acme', name: 'Acme key' }] },
  );
  assert.deepEqual(
    out.map((b) => [b.tone, b.title, b.lines, b.note || null]),
    [
      ['warn', 'budgets in config.json are invalid; the last valid list is in force', ['budgets[0].amount: a number above 0, up to 1e12'], 'Fix config.json first'],
      ['muted', 'the last valid budget list could not be kept', [], null],
      ['warn', 'The gateway is letting requests through for these budgets', ['Acme key · no rates for IDR', 'All budgets · the list did not read'], null],
    ],
  );
});

test('a card: ring, name, scope, period, spent of amount and chips; no data shows the reason; names are text', () => {
  const card = U.costBudgetCardHtml(
    view({ id: 'acme', name: EVIL, scope: { dim: 'key', value: 'key_a1' }, state: 'exceeded', percent: 125, spent: 1.13, amount: 0.9, enforce: 'block', legacy: 'keyBudget' }),
    CTX,
    false,
  );
  assert.match(card, /data-cost-card="acme"/);
  assert.match(card, /tone-exceeded/);
  assert.match(card, /Key · ci-bot/);
  assert.match(card, /<b>\$1\.13<\/b> of \$0\.90/);
  for (const chip of ['Usage value', 'Blocks gateway', 'From old settings']) assert.match(card, new RegExp(`>${chip}<`));
  assert.match(card, />125%</);
  assert.doesNotMatch(card, /<img/);
  const none = U.costBudgetCardHtml(view({ state: 'no_data', percent: null, spent: null, reason: `no ${EVIL} rate` }), CTX, false);
  assert.match(none, /no &lt;img src=x onerror=alert\(1\)&gt; rate/);
  assert.match(none, /stroke-dasharray="3 4"/);
  const locked = U.costBudgetCardHtml(view(), CTX, true);
  assert.equal((locked.match(/disabled/g) || []).length, 2, 'Edit and Delete wait for the fix');
});

test('the form: a new budget shows the id from its name; a legacy one says the old setting is cleared', () => {
  const add = U.costFormHtml(null, CTX, ['budget']);
  assert.match(add, /<code id="cost-form-id">budget-2<\/code>/);
  assert.match(add, /<option value="IDR"/);
  assert.match(add, /name="warn1" type="number" min="1" max="99" step="1" value="50"/);
  assert.match(add, /data-cost-id=""/);
  const legacy = U.costFormHtml(
    view({ id: 'legacy-key-key_a1', name: EVIL, scope: { dim: 'key', value: 'key_a1' }, enforce: 'block', legacy: 'keyBudget' }),
    CTX,
    [],
  );
  assert.match(legacy, /Saving moves this budget out of the old setting \(monthly budget \/ key budget\), which is cleared\./);
  assert.match(legacy, /data-cost-id="legacy-key-key_a1"/);
  assert.match(legacy, /value="pause" {2}disabled> Pause the costliest local agent <small>pause reaches a local agent only/);
  assert.match(legacy, /value="block" checked >/);
  assert.doesNotMatch(legacy, /<img/);
});

test('the bell: a budget alert links to its card in Budgets', () => {
  const a = {
    id: 'a1',
    ts: 1,
    rule: 'budget',
    ruleTitle: 'Budget',
    instance: 'opaque',
    budget: 'team-1',
    sessionKey: null,
    title: 'Team',
    value: 82.4,
    threshold: 80,
    state: 'warn_80',
    previous: 'warn_50',
    period: 'month',
    projected: false,
  };
  const l = alertLine(a, []);
  assert.equal(l.budgetHref, '#cost/budgets?focus=team-1');
  assert.equal(l.href, null);
  assert.equal(alertLine({ ...a, budget: '../x' }, []).budgetHref, undefined);
  assert.equal(alertLine({ ...a, budget: undefined }, []).budgetHref, undefined);
  // No time: the row's time needs app.js's date helpers, which the drawer has and Node does not.
  assert.match(monAlertsBody({ alerts: [{ ...a, ts: null }], loaded: true, error: '', readAt: 0 }), /href="#cost\/budgets\?focus=team-1">Open in Budgets →<\/a>/);
});

test('Budgets is wired: the sidebar link, the sub-page, the badge at start and on the refresh cycle', () => {
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  assert.match(pub('index.html'), /<a class="nav-sub" href="#cost\/budgets" data-route="cost\/budgets">Budgets<\/a>/);
  assert.match(pub('iso.js'), /\['value', 'Value'\],\s*\['budgets', 'Budgets'\],/);
  const app = pub('app.js');
  assert.match(app, /monMountBell\(\);[^\n]*\n\s*costBadge\(\);/);
  assert.match(app, /await loadSummary\(\);\n\s*costBadge\(\);/);
  const css = pub('styles.css');
  for (const c of ['.cost-card', '.cost-card.cost-focus', '.cost-drawer', '.cost-radio.off']) assert.ok(css.includes(c), c);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-budgets-ui-'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own: no other test uses 8800-9199.
    const port = 8800 + Math.floor(Math.random() * 400);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

test('over HTTP: the demo budget alerts name their budget for the link, path-free', async () => {
  const data = tmp();
  let child = null;
  try {
    let base = null;
    for (let attempt = 0; attempt < 6 && !base; attempt++) {
      const port = await freePort();
      child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
          ...process.env,
          ...NO_JUDGE_PORTS,
          DEMO: '1',
          ZAAFPULSE_AUTH: 'none',
          ZAAFPULSE_CONTENT: '',
          ZAAFPULSE_PORT: String(port),
          ZAAFPULSE_DATA: data,
          HOME: data,
          USERPROFILE: data,
        },
        stdio: 'ignore',
      });
      for (let i = 0; i < 80; i++) {
        try {
          await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) });
          base = `http://127.0.0.1:${port}`;
          break;
        } catch {
          if (child.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }
    assert.ok(base, 'the demo server started');
    const text = await (await fetch(`${base}/api/alerts`)).text();
    const rows = JSON.parse(text).alerts.filter((a) => a.rule === 'budget');
    assert.deepEqual(rows.map((a) => a.budget).sort(), ['acme-gateway', 'team']);
    assert.ok(rows.every((a) => a.instance !== a.budget), 'the instance id stays opaque');
    assert.doesNotMatch(text, /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//);
  } finally {
    if (child && child.exitCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
    fs.rmSync(data, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-budgets-ui.test.js`
Expected: FAIL (`U.costScopeLabel is not a function`; the alert row has no `budget`).

- [ ] **Step 3: `public/costview.js`, constants and helpers**

1. `COST_SUBS` gains `['budgets', 'Budgets'],` after `['value', 'Value'],`.
2. Before `const COST_MONTH_LONG = [`:

```js
const COST_SCOPE_DIMS = ['center', 'key', 'project', 'model', 'provider', 'source'];
const COST_SCOPE_LABEL = {
  center: 'Center',
  key: 'Key',
  project: 'Project',
  model: 'Model',
  provider: 'Provider',
  source: 'Source',
};
const COST_RESERVED_IDS = ['__proto__', 'constructor', 'prototype'];
const COST_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
```

3. Before `/** The ledger status ribbon: …`:

```js
/** "Global", "Center · Platform", "Key · ci-bot", "Source · Claude Code", … */
function costScopeLabel(scope, ctx = {}) {
  if (!scope || scope === 'global') return 'Global';
  const v = String(scope.value ?? '');
  const shown =
    scope.dim === 'center'
      ? (ctx.centers && ctx.centers[v]) || (v === 'unassigned' ? 'Unassigned' : v)
      : scope.dim === 'key'
        ? (ctx.keys && ctx.keys[v]) || v
        : scope.dim === 'source'
          ? COST_SOURCES[v] || v
          : v;
  return `${COST_SCOPE_LABEL[scope.dim] || 'Scope'} · ${shown}`;
}

/** "Month · 1–31 Oct", "Week · 27 Oct – 2 Nov", "Day · 22 Oct" from a budget view's period and dates. */
function costPeriodLabel(b) {
  const name = { day: 'Day', week: 'Week', month: 'Month' }[b.period] || 'Period';
  if (!costIsDay(b.from) || !costIsDay(b.to)) return name;
  const d = (x) => Number(x.slice(8));
  const mon = (x) => COST_MONTH[Number(x.slice(5, 7)) - 1];
  if (b.from === b.to) return `${name} · ${d(b.from)} ${mon(b.from)}`;
  if (b.from.slice(0, 7) === b.to.slice(0, 7)) return `${name} · ${d(b.from)}–${d(b.to)} ${mon(b.to)}`;
  return `${name} · ${d(b.from)} ${mon(b.from)} – ${d(b.to)} ${mon(b.to)}`;
}

// As lib/cost/views.js: used up, then projected over, then by percent; without data last.
const costRank = (b) => (b.state === 'exceeded' ? 0 : b.projected ? 1 : b.state === 'no_data' ? 3 : 2);
function costBudgetOrder(list) {
  return [...(list || [])].sort(
    (a, b) =>
      costRank(a) - costRank(b) ||
      (Number(b.percent) || 0) - (Number(a.percent) || 0) ||
      String(a.name).localeCompare(String(b.name)),
  );
}
const costTone = (state) =>
  state === 'exceeded' ? 'exceeded' : state === 'no_data' ? 'none' : /^warn_/.test(String(state)) ? 'warn' : 'ok';
// The sidebar badge: budgets used up or projected over.
const costBadgeCount = (list) =>
  (Array.isArray(list) ? list : []).filter((b) => b && (b.state === 'exceeded' || b.projected === true)).length;

/** A new budget's id from its name: lowercase a-z0-9 and dashes, with -2, -3, … when taken. */
function costIdFrom(name, taken = []) {
  const base =
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'budget';
  const used = new Set([...taken, ...COST_RESERVED_IDS]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The enforcement choices for a scope, mirroring lib/cost/budgets.js mayBlock and mayPause. */
function costEnforceOptions(scope) {
  const g = !scope || scope === 'global';
  const dim = g ? 'global' : scope.dim;
  const value = g ? '' : scope.value;
  const block = g || ['key', 'center', 'model', 'provider'].includes(dim) || (dim === 'source' && value === 'gateway');
  const pause =
    g || ['project', 'center', 'model'].includes(dim) || (dim === 'source' && (value === 'claude' || value === 'codex'));
  return [
    { value: 'none', label: 'None: alerts only', ok: true, why: '' },
    {
      value: 'block',
      label: 'Block gateway requests (402)',
      ok: block,
      why: block ? '' : 'block reaches gateway requests only: not a project or a local source',
    },
    {
      value: 'pause',
      label: 'Pause the costliest local agent',
      ok: pause,
      why: pause ? '' : 'pause reaches a local agent only: not a key, a provider or the gateway',
    },
  ];
}

/** The form's fields (strings, as FormData gives them, and projection as a boolean) to the POST body. */
function costFormBody(f, { id }) {
  const errors = [];
  const name = String(f.name ?? '').trim();
  if (!name || name.length > 60) errors.push('Name: 1 to 60 characters');
  const dim = COST_SCOPE_DIMS.includes(f.dim) ? f.dim : 'global';
  const scope = dim === 'global' ? 'global' : { dim, value: String(f.value ?? '').trim() };
  if (scope !== 'global' && !scope.value) errors.push(`${COST_SCOPE_LABEL[dim]}: name one`);
  const period = ['day', 'week', 'month'].includes(f.period) ? f.period : null;
  if (!period) errors.push('Period: day, week or month');
  const amount = Number(String(f.amount ?? '').trim() || NaN);
  if (!(Number.isFinite(amount) && amount > 0)) errors.push('Amount: a number above 0');
  const thresholds = [f.warn1, f.warn2]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .map(Number);
  if (
    !thresholds.every((t) => Number.isInteger(t) && t >= 1 && t <= 99) ||
    (thresholds.length === 2 && thresholds[1] <= thresholds[0])
  )
    errors.push('Warning levels: whole numbers from 1 to 99, the second above the first');
  const enforce = f.enforce || 'none';
  const opt = costEnforceOptions(scope).find((o) => o.value === enforce);
  if (!opt) errors.push('Enforcement: none, block or pause');
  else if (!opt.ok) errors.push(`Enforcement: ${opt.why}`);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      id,
      name,
      scope,
      period,
      amount,
      currency: f.currency || 'USD',
      measure: f.measure === 'billed' ? 'billed' : 'list',
      thresholds,
      projection: f.projection === true || f.projection === 'on',
      enforce,
    },
  };
}

```

4. Before `/* ---------- the page ---------- */`:

```js
/** The status lines of GET /api/cost/budgets: the hand edit that does not validate, the kept list, the guard. */
function costBudgetBanners(a, ctx = {}) {
  const out = [];
  if (!a) return out;
  if (a.error)
    out.push({ tone: 'warn', title: a.error, lines: (a.reasons || []).map(String), note: 'Fix config.json first' });
  if (a.kept && a.kept.error) out.push({ tone: 'muted', title: String(a.kept.error), lines: [] });
  const g = a.guard || {};
  const problems = Array.isArray(g.problems) ? g.problems : [];
  if (g.error || problems.length) {
    const names = new Map((ctx.budgets || []).map((b) => [b.id, b.name]));
    out.push({
      tone: 'warn',
      title: 'The gateway is letting requests through for these budgets',
      lines: [
        ...(g.error ? [String(g.error)] : []),
        ...problems.map((p) =>
          [
            p.budget == null ? 'All budgets' : names.get(p.budget) || p.budget,
            p.reason,
            Number.isFinite(p.since) ? `since ${new Date(p.since).toLocaleString('en')}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ],
    });
  }
  return out;
}

```

- [ ] **Step 4: `public/costview.js`, the page**

1. `COST` gains, after its `table: …` line:

```js
  budgets: null,
  confirm: null, // the budget id whose delete is being confirmed
  cardMsg: {}, // budget id -> a delete error
  form: null, // { id, isNew, opener } while the drawer is open
  suggest: new Map(), // scope dim -> values seen in the ledger (last 90 days)
```

and, after `hooked: false,`: `budgetHooked: false,`.

2. Before `// Numbers count up …`:

```js
const costPost = (path, body) =>
  costCall(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

```

3. In `viewCost`, the copy table gains `budgets: 'Limits by day, week or month, with alerts and, where you choose, a block or a pause.',` and the deck gains the drawer's host after `#cost-body`:

```js
    <div id="cost-body"><div class="skeleton" style="height:240px"></div></div>
    <div id="cost-form-host"></div></div>`;
```

4. Replace `mountCost` and `costRefresh` with:

```js
function mountCost() {
  costInstallEvents();
  costInstallBudgetEvents();
  COST.form = null;
  COST.confirm = null;
  COST.cardMsg = {};
  // The page refreshes itself (app.js leaves it out of the 60-second render): a render would close an open form.
  const timer = setInterval(() => costRefresh(true), COST_REFRESH_MS);
  onUnmount(() => {
    clearInterval(timer);
    COST.req++; // drop a load still in flight
    COST.stage = null; // unmountStages() destroys it
    if (COST.form) {
      COST.form = null;
      document.body.classList.remove('drawer-locked');
    }
  });
  costRefresh(false);
}

// A quiet refresh waits while the owner is in a form or a field of the page, and while the tab is hidden.
function costRefresh(quiet) {
  const app = $('#cost-app');
  if (!app) return;
  if (quiet && (document.hidden || COST.form || COST.confirm || app.contains(document.activeElement))) return;
  if (costSub() === 'budgets') return costMountBudgets(quiet);
  return costMountPage(costSub(), quiet);
}

```

5. The Budgets section, before `/* ---------- events (installed once) ---------- */`:

```js
/* ---------- Budgets ---------- */

async function costMountBudgets(quiet) {
  const body = $('#cost-body');
  if (!body) return;
  const my = ++COST.req;
  const live = () => my === COST.req && body.isConnected;
  try {
    const [list, settings] = await Promise.all([costGet('/api/cost/budgets'), costGet('/api/cost/settings')]);
    if (!live()) return;
    COST.settings = settings;
    COST.budgets = list;
    $('#cost-bar').innerHTML = '';
    costPaintBudgets();
    costBadgePaint(list.budgets);
    if (!quiet) costFocus();
  } catch (e) {
    if (!live()) return;
    body.innerHTML = costErrorHtml(e.message);
  }
}
function costPaintBudgets() {
  const body = $('#cost-body');
  const list = COST.budgets;
  if (!body || !list) return;
  const ctx = costContext(COST.settings);
  const banners = costBudgetBanners(list, { budgets: list.budgets })
    .map(
      (b) =>
        `<div class="cost-banner ${esc(b.tone)}" role="status"><b>${esc(b.title)}</b>${b.lines.length ? `<ul>${b.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}${b.note ? `<p>${esc(b.note)}</p>` : ''}</div>`,
    )
    .join('');
  const locked = !!list.error;
  const cards = costBudgetOrder(list.budgets)
    .map((b) => costBudgetCardHtml(b, ctx, locked))
    .join('');
  body.innerHTML = `${banners}<div class="cost-toolbar"><button type="button" class="btn" data-cost-add ${locked ? 'disabled title="Fix config.json first"' : ''}>${icon('dollar', 14)} Add a budget</button>${locked ? '<span class="cost-note">Fix config.json first</span>' : ''}</div>
    ${cards ? `<div class="cost-cards">${cards}</div>` : holoEmpty('No budgets yet. Add one to get alerts at your levels, and a block or a pause where you choose.')}`;
}
function costBudgetCardHtml(b, ctx, locked) {
  const tone = costTone(b.state);
  const chips = [
    COST_MEASURES[b.measure] || 'Usage value',
    b.projected ? 'Projected over' : '',
    b.enforce === 'block' ? 'Blocks gateway' : b.enforce === 'pause' ? 'Pauses agent' : '',
    b.legacy ? 'From old settings' : '',
  ]
    .filter(Boolean)
    .map((c) => `<span class="cost-chip${c === 'Projected over' ? ' warn' : ''}">${esc(c)}</span>`)
    .join('');
  const figures =
    b.state === 'no_data'
      ? `<p class="cost-card-reason">${esc(b.reason || 'No data')}</p>`
      : `<p class="cost-card-spent"><b>${esc(costMoney(b.spent, b.currency))}</b> of ${esc(costMoney(b.amount, b.currency))}</p>`;
  const msg = COST.cardMsg[b.id] ? `<p class="cost-card-reason" role="alert">${esc(COST.cardMsg[b.id])}</p>` : '';
  const actions =
    COST.confirm === b.id
      ? `<p class="cost-confirm">${esc('Delete budget "' + b.name + '"? A budget from old settings also clears that setting.')}</p><button type="button" class="btn danger" data-cost-confirm-delete="${esc(b.id)}">Delete</button><button type="button" class="btn ghost" data-cost-cancel-delete>Cancel</button>`
      : `<button type="button" class="btn ghost" data-cost-edit="${esc(b.id)}" ${locked ? 'disabled' : ''}>Edit</button><button type="button" class="btn ghost danger" data-cost-delete="${esc(b.id)}" ${locked ? 'disabled' : ''}>Delete</button>`;
  return `<article class="holo cost-card tone-${tone}" data-cost-card="${esc(b.id)}">
    <div class="cost-card-ring">${costRingSvg(b.percent, tone, 84)}</div>
    <div class="cost-card-main"><h3>${esc(b.name)}</h3><p>${esc(costScopeLabel(b.scope, ctx))}</p><p>${esc(costPeriodLabel(b))}</p>${figures}<div class="cost-chips">${chips}</div>${msg}</div>
    <div class="cost-card-actions">${actions}</div></article>`;
}

// #cost/budgets?focus=<id> (the bell, an Overview ring): scroll to the card and highlight it for a moment.
function costFocus() {
  const id = new URLSearchParams(costQueryOfHash()).get('focus');
  if (!id) return;
  const card = [...document.querySelectorAll('[data-cost-card]')].find((el) => el.dataset.costCard === id);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  card.classList.add('cost-focus');
  setTimeout(() => card.classList.remove('cost-focus'), 2400);
}

async function costBadge() {
  try {
    const r = await costCall('/api/cost/budgets');
    if (r.status === 200 && r.json) costBadgePaint(r.json.budgets);
  } catch {
    /* the badge waits for the next cycle */
  }
}
function costBadgePaint(list) {
  const el = document.getElementById('b-cost');
  if (!el) return;
  const n = costBadgeCount(list);
  el.textContent = n ? String(n) : '';
  el.title = n ? `${n} budget${n === 1 ? '' : 's'} used up or projected over` : '';
}

/* ---------- the budget form ---------- */

function costFormHtml(b, ctx, taken) {
  const isNew = !b;
  const v = b || {
    name: '',
    scope: 'global',
    period: 'month',
    amount: '',
    currency: 'USD',
    measure: 'list',
    thresholds: [50, 80],
    projection: true,
    enforce: 'none',
  };
  const dim = v.scope === 'global' ? 'global' : v.scope.dim;
  const value = v.scope === 'global' ? '' : v.scope.value;
  const opt = (val, text, on) => `<option value="${esc(val)}" ${val === on ? 'selected' : ''}>${esc(text)}</option>`;
  const currencies = ctx.display ? ['USD', ctx.display] : ['USD'];
  if (!currencies.includes(v.currency)) currencies.push(v.currency);
  return `<div class="cost-drawer-backdrop" data-cost-close-form></div>
  <aside class="cost-drawer holo-deck" role="dialog" aria-modal="true" aria-labelledby="cost-form-title">
    <form id="cost-form" novalidate data-cost-id="${esc(isNew ? '' : b.id)}">
      <div class="cost-drawer-head"><h2 id="cost-form-title">${isNew ? 'Add a budget' : 'Edit budget'}</h2><button type="button" class="btn ghost" data-cost-close-form aria-label="Close">×</button></div>
      ${b && b.legacy ? '<p class="cost-note warn">Saving moves this budget out of the old setting (monthly budget / key budget), which is cleared.</p>' : ''}
      <label>Name<input class="input" name="name" maxlength="60" required value="${esc(v.name)}" autocomplete="off"></label>
      <p class="cost-id">Id <code id="cost-form-id">${esc(isNew ? costIdFrom(v.name, taken) : b.id)}</code>${isNew ? ' · made from the name' : ''}</p>
      <div class="cost-row">
        <label>Scope<select class="input" name="dim">${opt('global', 'Global', dim)}${COST_SCOPE_DIMS.map((d) => opt(d, COST_SCOPE_LABEL[d], dim)).join('')}</select></label>
        <label>Value<input class="input" name="value" list="cost-scope-values" value="${esc(value)}" ${dim === 'global' ? 'disabled' : ''} autocomplete="off"><datalist id="cost-scope-values">${costSuggestOptions(dim, ctx)}</datalist></label>
      </div>
      <div class="cost-row">
        <label>Period<select class="input" name="period">${opt('day', 'Day', v.period)}${opt('week', 'Week (from Monday)', v.period)}${opt('month', 'Month', v.period)}</select></label>
        <label>Amount<input class="input" name="amount" type="number" min="0" step="any" required value="${esc(v.amount)}"></label>
        <label>Currency<select class="input" name="currency">${currencies.map((c) => opt(c, c, v.currency)).join('')}</select></label>
      </div>
      <label>Measure<select class="input" name="measure">${opt('list', 'Usage value', v.measure)}${opt('billed', 'Paid', v.measure)}</select></label>
      <fieldset class="cost-row"><legend>Warning levels (%), up to two</legend><input class="input" name="warn1" type="number" min="1" max="99" step="1" value="${esc(v.thresholds[0] ?? '')}" aria-label="First warning level"><input class="input" name="warn2" type="number" min="1" max="99" step="1" value="${esc(v.thresholds[1] ?? '')}" aria-label="Second warning level"></fieldset>
      <label class="cost-check"><input type="checkbox" name="projection" ${v.projection ? 'checked' : ''}> Alert when the projection passes the amount</label>
      <fieldset id="cost-enforce"><legend>Enforcement</legend>${costEnforceHtml(v.scope, v.enforce)}</fieldset>
      <div id="cost-form-msg" role="alert"></div>
      <div class="cost-drawer-foot"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-cost-close-form>Cancel</button></div>
    </form>
  </aside>`;
}
function costEnforceHtml(scope, current) {
  const opts = costEnforceOptions(scope);
  const pick = opts.some((o) => o.value === current && o.ok) ? current : 'none';
  return opts
    .map(
      (o) =>
        `<label class="cost-radio${o.ok ? '' : ' off'}"><input type="radio" name="enforce" value="${esc(o.value)}" ${o.value === pick ? 'checked' : ''} ${o.ok ? '' : 'disabled'}> ${esc(o.label)}${o.ok ? '' : ` <small>${esc(o.why)}</small>`}</label>`,
    )
    .join('');
}
// Known values for a scope dimension; free entry stays allowed.
function costSuggestOptions(dim, ctx) {
  let vals = [];
  if (dim === 'center') vals = [...Object.entries(ctx.centers), ['unassigned', 'Unassigned']];
  else if (dim === 'key') vals = Object.entries(ctx.keys);
  else if (dim === 'source') vals = ctx.sources.map((s) => [s, COST_SOURCES[s] || s]);
  else if (COST.suggest.has(dim)) vals = COST.suggest.get(dim).map((v) => [v, v]);
  return vals.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
}
// Projects, models and providers with spend in the last 90 days, read once per dimension.
async function costLoadSuggest(dim) {
  if (!['project', 'model', 'provider'].includes(dim) || COST.suggest.has(dim)) return;
  const to = costToday();
  try {
    const led = await costGet(`/api/cost/ledger?from=${costAddDays(to, -89)}&to=${to}&groupBy=${dim}`);
    COST.suggest.set(
      dim,
      (led.rows || [])
        .map((r) => r[dim])
        .filter((v) => typeof v === 'string' && v)
        .slice(0, 200),
    );
    const list = document.getElementById('cost-scope-values');
    const form = document.getElementById('cost-form');
    if (list && form && form.elements.dim.value === dim)
      list.innerHTML = costSuggestOptions(dim, costContext(COST.settings));
  } catch {
    /* free entry still works */
  }
}
function costOpenForm(id, opener) {
  const host = $('#cost-form-host');
  if (!host || !COST.budgets) return;
  const list = COST.budgets.budgets || [];
  const b = id ? list.find((x) => x.id === id) : null;
  if (id && !b) return;
  const ctx = costContext(COST.settings);
  COST.form = { id: b ? b.id : null, isNew: !b, opener };
  host.innerHTML = costFormHtml(b, ctx, list.map((x) => x.id));
  document.body.classList.add('drawer-locked');
  const dim = b && b.scope !== 'global' ? b.scope.dim : 'global';
  costLoadSuggest(dim);
  const first = host.querySelector('input[name="name"]');
  if (first) first.focus();
}
function costCloseForm() {
  const host = $('#cost-form-host');
  if (host) host.innerHTML = '';
  document.body.classList.remove('drawer-locked');
  const opener = COST.form && COST.form.opener;
  COST.form = null;
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
}
function costFormFields(form) {
  const f = Object.fromEntries(new FormData(form));
  f.projection = form.elements.projection.checked;
  if (form.elements.value.disabled) f.value = '';
  return f;
}
const costReasonsHtml = (list) => `<ul class="cost-reasons">${list.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
async function costSubmitForm(form) {
  const msg = $('#cost-form-msg');
  const taken = ((COST.budgets && COST.budgets.budgets) || []).map((b) => b.id);
  const id = form.dataset.costId || costIdFrom(form.elements.name.value, taken);
  const r = costFormBody(costFormFields(form), { id });
  if (!r.ok) {
    msg.innerHTML = costReasonsHtml(r.errors);
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await costPost('/api/cost/budgets', r.body);
    if (res.status === 200) {
      costCloseForm();
      await costMountBudgets(true);
      return;
    }
    const j = res.json || {};
    msg.innerHTML =
      res.status === 400 && Array.isArray(j.reasons)
        ? costReasonsHtml(j.reasons)
        : `<p>${esc(j.error || `Could not save (${res.status})`)}</p>`;
  } catch (e) {
    msg.innerHTML = `<p>${esc(e.message)}</p>`;
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}
async function costDelete(id) {
  try {
    const res = await costPost(`/api/cost/budgets/${encodeURIComponent(id)}/delete`, {});
    COST.confirm = null;
    if (res.status !== 200) COST.cardMsg[id] = (res.json && res.json.error) || `Could not delete (${res.status})`;
    else delete COST.cardMsg[id];
    await costMountBudgets(true);
  } catch (e) {
    COST.confirm = null;
    COST.cardMsg[id] = e.message;
    costPaintBudgets();
  }
}

// The Budgets page's own listeners: the cards' buttons, the drawer form and its fields.
const COST_BUDGET_CLICKS = ['add', 'edit', 'delete', 'confirm-delete', 'cancel-delete', 'close-form']
  .map((k) => `#cost-app [data-cost-${k}]`)
  .join(', ');
function costInstallBudgetEvents() {
  if (COST.budgetHooked) return;
  COST.budgetHooked = true;
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest(COST_BUDGET_CLICKS);
    if (!t) return;
    const d = t.dataset;
    if (t.hasAttribute('data-cost-add')) return costOpenForm(null, t);
    if (d.costEdit) return costOpenForm(d.costEdit, t);
    if (d.costDelete) {
      COST.confirm = d.costDelete;
      return costPaintBudgets();
    }
    if (d.costConfirmDelete) return void costDelete(d.costConfirmDelete);
    if (t.hasAttribute('data-cost-cancel-delete')) {
      COST.confirm = null;
      return costPaintBudgets();
    }
    if (t.hasAttribute('data-cost-close-form')) return costCloseForm();
  });
  document.addEventListener('keydown', (e) => {
    if (COST.form && e.key === 'Escape') costCloseForm();
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.form || t.form.id !== 'cost-form') return;
    if (t.name === 'dim') {
      const form = t.form;
      form.elements.value.disabled = t.value === 'global';
      if (t.value === 'global') form.elements.value.value = '';
      $('#cost-scope-values').innerHTML = costSuggestOptions(t.value, costContext(COST.settings));
      costLoadSuggest(t.value);
      costPaintEnforce(form);
    }
    if (t.name === 'value') costPaintEnforce(t.form);
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.name === 'name' && t.form && t.form.id === 'cost-form' && !t.form.dataset.costId) {
      const taken = ((COST.budgets && COST.budgets.budgets) || []).map((b) => b.id);
      $('#cost-form-id').textContent = costIdFrom(t.value, taken);
    }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'cost-form') return;
    e.preventDefault();
    costSubmitForm(e.target);
  });
}
function costPaintEnforce(form) {
  const dim = form.elements.dim.value;
  const scope = dim === 'global' ? 'global' : { dim, value: form.elements.value.value.trim() };
  const current = (form.querySelector('input[name="enforce"]:checked') || {}).value || 'none';
  $('#cost-enforce').innerHTML = `<legend>Enforcement</legend>${costEnforceHtml(scope, current)}`;
}

```

6. Replace the exports with:

```js
if (typeof module !== 'undefined')
  module.exports = {
    COST_DEFAULT,
    COST_STORE_KEY,
    costIsDay,
    costAddDays,
    costParseControls,
    costRangeDays,
    costControlsQuery,
    costHash,
    costStoreGet,
    costStoreSet,
    costMoney,
    costScopeLabel,
    costPeriodLabel,
    costBudgetOrder,
    costTone,
    costBadgeCount,
    costIdFrom,
    costEnforceOptions,
    costFormBody,
    costRibbonItems,
    costUnreadText,
    costBudgetBanners,
    costTableRows,
    costBudgetCardHtml,
    costFormHtml,
    costContext,
  };
```

- [ ] **Step 5: The sub-page, the sidebar link and the badge**

`public/iso.js`, the `cost` entry: add `['budgets', 'Budgets'],` after `['value', 'Value'],`.

`public/index.html`, after the Cost Control "Value" link:

```html
        <a class="nav-sub" href="#cost/budgets" data-route="cost/budgets">Budgets</a>
```

`public/app.js`, after `monMountBell(); …` (`:1297`):

```js
  costBadge(); // Cost Control's badge: budgets used up or projected over (public/costview.js)
```

and in the 60-second interval, right after its `await loadSummary();` (`:1327`):

```js
    costBadge();
```

- [ ] **Step 6: Styles, `public/styles.css`** — append:

```css
/* ---------- Cost Control: Budgets (public/costview.js) ---------- */
.cost-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.cost-banner {
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-ink);
  font-size: 13px;
}
.cost-banner.muted {
  border-color: var(--border);
  background: var(--surface-2);
  color: var(--h-muted);
}
.cost-banner ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.cost-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.cost-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 14px;
  padding: 16px;
  border-radius: 16px;
  transition: box-shadow 0.4s ease;
}
.cost-card h3 {
  margin: 0;
  font-size: 15px;
}
.cost-card p {
  margin: 2px 0;
  color: var(--h-muted);
  font-size: 12.5px;
}
.cost-card .cost-card-spent {
  color: var(--h-text);
}
.cost-card .cost-card-reason {
  color: var(--warn-ink);
}
.cost-card-actions {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}
.cost-confirm {
  flex-basis: 100%;
  color: var(--h-text) !important;
}
.cost-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.cost-card.cost-focus {
  box-shadow:
    0 0 0 2px var(--h-cyan),
    0 0 24px rgba(77, 232, 255, 0.45);
}
.cost-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(6, 12, 18, 0.5);
  backdrop-filter: blur(3px);
}
.cost-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 45;
  width: min(560px, 100vw);
  border-radius: 0;
  overflow-y: auto;
  animation: cost-slide 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.cost-drawer form {
  display: grid;
  gap: 12px;
}
.cost-drawer label {
  display: grid;
  gap: 4px;
  font-size: 12.5px;
  color: var(--h-muted);
}
.cost-drawer fieldset {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
  display: grid;
  gap: 6px;
}
.cost-drawer-head,
.cost-drawer-foot {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cost-drawer-head h2 {
  margin: 0;
  flex: 1;
}
.cost-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
}
.cost-radio {
  display: flex !important;
  align-items: baseline;
  gap: 6px;
  color: var(--h-text) !important;
}
.cost-radio.off {
  opacity: 0.55;
}
.cost-radio small {
  color: var(--h-muted);
}
.cost-id code {
  color: var(--h-cyan);
}
.cost-reasons {
  margin: 0;
  padding-left: 18px;
  color: var(--warn-ink);
  font-size: 12.5px;
}
```

- [ ] **Step 7: The bell's link**

`lib/monitors/api.js`, after `const TASKKILL_HINT = …` (`:34`):

```js
const BUDGET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/; // lib/cost/budgets.js
```

and in the alerts route, after `row.projected = a.projected === true;` (`:390`):

```js
        // The budget's own id, for the bell's "Open in Budgets" link: the owner's id, shown to the owner only.
        row.budget = typeof a.instance === 'string' && BUDGET_ID.test(a.instance) ? a.instance : null;
```

`public/monitorsview.js`, after `const MON_PERIOD = …` (`:102`):

```js
const MON_BUDGET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/; // lib/cost/budgets.js
```

after the budget branch's `line = { ...base, kind: 'change', title, measure: monBudgetMeasure(a), ...monBudgetChange(a) };` (`:157`):

```js
    // Its card in Cost Control → Budgets, when the server named the budget.
    if (typeof a.budget === 'string' && MON_BUDGET_ID.test(a.budget))
      line.budgetHref = `#cost/budgets?focus=${encodeURIComponent(a.budget)}`;
```

and in `monAlertRow` (`:555`):

```js
      ${l.measure ? `<div class="mon-measure">${esc(l.measure)}</div>` : ''}${session}${l.budgetHref ? `<a class="mon-session" href="${esc(l.budgetHref)}">Open in Budgets →</a>` : ''}</div>${time}</div>`;
```

A click on the link changes the hash: the drawer closes (`hashchange` → `closeDrill`) and the card is focused.

`test/budgets-monitors.test.js:422`: after `projected: true,` in the expected row add

```js
      budget: 'team', // the budget's own id, for the bell's "Open in Budgets" link (Cost Control 3a)
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test test/cost-budgets-ui.test.js test/cost-ui.test.js test/budgets-monitors.test.js test/budgets-demo-ui.test.js test/monitors-ui.test.js test/monitors-api.test.js test/cost-budgets-api.test.js`
Expected: PASS.

- [ ] **Step 9: Check it in the demo**

Run: `npm run demo`, open `#cost/budgets`.
Expected:
- the badge on Cost Control shows 2 (Acme gateway key used up, Whole team projected over);
- seven cards, Acme gateway key first with a pink ring over 100 %, Research, paid last with a dashed ring and its reason;
- Add a budget: the id follows the name (`whole-team`); choosing Project disables "Block gateway requests" with its reason and suggests the demo folders; Save with no amount lists the problems; a valid save closes the drawer and adds the card;
- Edit a legacy budget: the note about the old setting; warning levels 90 then 80 are refused;
- Delete asks in the card, then removes it;
- the bell's budget alert has "Open in Budgets →", which opens the page with that card highlighted; an Overview ring does the same.

- [ ] **Step 10: Commit**

```bash
git add public/costview.js public/iso.js public/index.html public/app.js public/styles.css public/monitorsview.js lib/monitors/api.js test/budgets-monitors.test.js test/cost-budgets-ui.test.js
git commit -m "Cost Control Budgets: cards with rings, the add and edit drawer, delete, the badge and the bell's link"
```

---
### Task 9: Docs and the whole suite

**Files:**
- Modify: `docs/cost.md` (a `## Cost Control menu` section before `## Fail closed` (`:314`); a row in the `## API` table (`:352-366`); `## Demo mode` (`:387-389`))
- Modify: `docs/quality-metrics.md` (`## Accuracy` (`:26-43`): one paragraph)
- Modify: `README.md:808` (one paragraph after the Budgets paragraph), `:926` (the docs list line)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: `docs/cost.md`** — before `## Fail closed`, add this section:

```md
## Cost Control menu

The sidebar's **Cost Control** (after Quality & safety) has four pages. Each reads the ledger as billed, with the
corrections and billing applied, and shows only numbers, names, `~` folders and model names.

| Page | Question | What it shows |
|---|---|---|
| Overview (`#cost`) | How much this month, and is it safe? | Month to date in both measures; the forecast at the mean daily spend with a band from the 25th–75th percentile days (none before the 3rd day); the global monthly budgets as lines; daily spend against the mean of the 7 days before each day (a spike is over twice that and at least $1 over it); budget rings, riskiest first |
| Breakdown (`#cost/breakdown`) | Where does the money go? | Source → provider → model → cost center flow (top 6 per column, the rest as Other; plan fees as "Plan fee"); projects by cost center as an isometric treemap (footprint = share, height = spend per request, at most 40 blocks); a calendar of the range; a table grouped by up to four dimensions, read from `/api/cost/ledger` |
| Value (`#cost/value`) | Is it worth it? | Usage value of each plan's days against its fee, with the multiplier; a waterfall from "without cache" through cache and plan savings to what was paid; local models (requests and tokens, not priced); spend per request against tool-call accuracy per model; spend per request, per million tokens and per 1,000 successful tool calls per day |
| Budgets (`#cost/budgets`) | Set the limits | One card per budget with its ring, scope, period, spent of amount and chips; add, edit and delete in a drawer (see [Budgets](#budgets)) |

**Controls.** One bar on every page but Budgets: the range (7 days, 30 days, this month, last month or two dates, at
most 400 days), the currency (USD, or the display currency once it has a rate) and the measure (usage value or paid).
They live in the URL, `#cost/<page>?range=7d&cur=IDR&measure=billed`, and the last choice is kept in the browser's
`localStorage` (`zp.cost.controls`); a value that does not read falls back to 30 days, USD and usage value. The
Overview is always the current month, Value compares both measures and hides that switch.

**Cache savings** are an estimate: cache-read tokens × (input price − cache-read price) at the base rates of each
row's price version. Prompt-length tiers and US-only pricing are left out. Free (local) rows add no money.

**Tool-call accuracy per model** follows the Quality page's definition (see
[docs/quality-metrics.md](quality-metrics.md#accuracy-which-failures-count-against-the-model)), counted per model from
the Claude Code and Codex logs. A model with fewer than 50 tool results in the range is drawn hollow ("little data"); a
model without tool calls (gateway only) is listed under the chart. When a Datasets experiment that ended in the range
ran a model, its pass rate (passes over totals across its evaluators) is in the dot's tooltip.

**Gaps and notes.** A month that did not read, a day without a rate (counted in USD) and billing that did not read are
named above the charts; a unit-cost day without its denominator is a gap, not a zero. A ribbon repeats the ledger
status problems (`GET /api/cost/status`). The badge on the menu counts the budgets used up or projected over. A budget
alert in the bell links to its card ("Open in Budgets").

**Motion.** Charts draw in on a page or control change and refresh quietly every minute; with the system's reduced
motion setting they appear at their final state.
```

In the `## API` table, after the `GET /api/cost/settings` row:

```md
| `GET /api/cost/view?page&from&to&currency&measure` | what one Cost Control page draws: `page` is `overview` (always the current month), `breakdown` or `value`; `from`/`to` default to the last 30 days, at most 400; `measure` `list` (default) or `billed`. Always `{ page, from, to, currency, measure, unread, missingRate, billing: { error, historyLost } }` beside the page's data; 400 for an unknown page or measure or a currency without rates, 503 with a `code` while the ledger does not read |
```

In `## Demo mode`, append: `The Cost Control pages draw from it too; the demo's quality signals carry per-model tool results, so Value shows a scatter.`

- [ ] **Step 2: `docs/quality-metrics.md`** — at the end of `## Accuracy: which failures count against the model`:

```md
Accuracy is also counted per model: each tool result belongs to the model that made the call (in Claude Code logs the
model of the assistant message holding the `tool_use`, in Codex logs the model of the turn). Cost Control's Value page
sets it against spend per request. The index is rebuilt once after the update that added these counts.
```

- [ ] **Step 3: `README.md`** — after the Budgets paragraph (`:808`):

```md
The **Cost Control** menu draws the ledger: an Overview of the month with a forecast band, budget lines and spikes; a Breakdown from source to cost center with an isometric treemap of projects and a calendar; a Value page with plan value against its fee, a savings waterfall and cost against tool-call accuracy per model; and a Budgets page to add and edit budgets. See [docs/cost.md#cost-control-menu](docs/cost.md#cost-control-menu).
```

and the docs list line (`:926`) becomes:

```
docs/cost.md           cost ledger: who counts what, frozen cost, billing, cost centers, restate, the Cost Control menu, API, limits
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS on this machine (baseline 1802 passing plus this plan's tests; see Task 1–8 for their files). CI runs the same on Ubuntu, macOS and Windows.

- [ ] **Step 5: Commit**

```bash
git add docs/cost.md docs/quality-metrics.md README.md
git commit -m "Docs: the Cost Control menu, the view API, accuracy per model"
```

---
## Decisions made while planning

The spec left these open, or a detail of it did not fit the code; each is built and tested as written here.

1. **The Overview's inputs.** `overview` also takes `currency` (the chosen code) and `display` (`{ code, rate }`, the display currency's latest rate on or before today). With `rateOf` null for USD, as the spec defines it, a budget in the display currency could not be drawn on a USD chart otherwise.
2. **`missingRate` is a list of days** in every view answer (the ledger answer's is a count). The page says "N day(s) had no IDR rate and are counted in USD."
3. **Measures on the Value page.** The scatter and the unit-cost lines use the usage value (`listUSD`): on a plan every usage row is billed 0, so "paid" would put every Claude Code model at $0 per request. Plans and the waterfall use both measures, as the spec says.
4. **Successful tool calls** for the third unit line are the `ok` results (results minus model-caused failures) of every model that day, against the Claude Code and Codex spend of that day.
5. **Attribution in the parsers.** Claude Code: the model of the message that holds the `tool_use`, named as the usage rows name it (`<model>-fast` in fast mode), so it meets the ledger's model; a result whose call is not in the file has no model and counts in the totals only. Codex: the model of the turn at the time of the call; a result whose call is not in the file goes to the model in force.
6. **The bell's link needs the budget id.** `/api/alerts` keeps `instance` opaque (an HMAC), so a budget alert row gains `budget` (the id, validated as a budget id); the drawer shows "Open in Budgets →" from it. One existing assertion changes for that field.
7. **Refresh.** The cost pages refresh themselves every 60 s, quietly, and `app.js` leaves `cost` out of its 60-second `render(false)`: a render would rebuild the page and close an open budget form. A refresh is skipped while the form or a delete confirmation is open, a field has focus, or the tab is hidden.
8. **Defaults of the view route.** Breakdown and Value without dates are the last 30 days (as the page's default range); the ledger route's default (the month so far) is unchanged. The 7 days before the 1st that the Overview reads add their unread months to `unread`.
9. **Treemap.** Rows without a project (the gateway, the judge, collaboration) make one "No project" block per center, so the treemap adds up to the spend; plan fees have no project or center and are named beside it. The 40-block cap counts the "Other" blocks.
10. **Flow keys.** A row without a center is `unassigned` (as the ledger attributes it); without a provider or model it is `__none` ("Unknown", not filterable); Other and Plan fee are not filterable either. Nodes are ordered by spend with Other and Plan fee last.
11. **Table.** Rows with neither spend nor requests (plan rows under the usage value) are left out. A flow filter adds its dimension to the grouping when it is missing. At most 500 rows are drawn.
12. **Budgets while the saved list is invalid.** Add, Edit and Delete are disabled with "Fix config.json first" (the API answers 409 then), beside the orange banner.
13. **The id from a name.** Lowercase, runs of anything outside `a-z0-9` become `-`, trimmed, at most 60 characters, `budget` when nothing is left, then `-2`, `-3`… past taken ids and the reserved `constructor`/`prototype`. Every result passes `validateBudget`.
14. **Enforcement choices** mirror `mayBlock`/`mayPause` exactly (tested over every dimension and several values), which is stricter than the spec's summary (see below).
15. **Money format.** USD to the cent, under $0.10 to two significant digits (a per-request cost), compact from a million; other currencies in whole units, prefixed by their code.
16. **Accuracy memo.** Per index version, at most 8 ranges at a time (`server.js`).
17. **The index rebuild** from `CACHE_VERSION` 11 is a one-time reindex at the first start after the update, as for every earlier bump.
18. **Count-up.** Tile numbers count up on an animated load and are set to their final value after 1 s even when frames stop (a hidden tab).
19. **The demo** gets per-model tool counts without changing any other demo number (the model of each call is drawn in the same order as before). Its experiments ran models the demo ledger does not have (Haiku, local models), so no pass rate shows in the demo's scatter; the tooltip path is tested in Node.

## Spec points that do not fit, for the owner

- **Enforcement rules.** The spec says "pause not for `key` or `provider`". The server (`lib/cost/budgets.js` `mayPause`) also refuses pause on a `source` other than `claude` or `codex`, and block on a `source` other than `gateway`. The form follows the server.
- **`overview` signature and `missingRate`.** See decisions 1 and 2.
- **The bell's link** cannot be built from `/api/alerts` as it is (decision 6): a small change to `lib/monitors/api.js` is part of Task 8.
- **"Quietly, as other pages do with `render(false)`"** would close an open form; the page refreshes itself instead (decision 7).
- **Wording shown to the owner.** The spec's note "Not priced: sub-project 4 compares them with a cloud model." is kept verbatim, but "sub-project 4" is project jargon on a user-facing page; consider "Not priced yet: a later version compares them with a cloud model."
- **Spike rule on a young ledger.** Days before the ledger's first day count as 0 in the baseline, so the first days with at least $1 of spend are marked as spikes. The rule is built as written.
- **Budget lines and the burn-down scale.** The axis includes the budget amount, so a budget far above the spend (the demo: $1,000 against about $90) flattens the curve and its band. Built as written; a later option could clip the axis and mark the budget above it.

## Self-review

**Spec coverage** (spec section → task):
- Navigation: sidebar entry after Quality & safety with the `dollar` icon and `#b-cost` badge → Task 7 (entry), Task 8 (Budgets link, badge); routes and sub-pages → Task 7, Task 8.
- Routes and controls: `range` (7d, 30d, month, lastmonth, custom up to 400 days), `cur`, `measure`, silent fallback, Overview's "This month · day N of M", Value without the measure, Budgets without controls, `localStorage` with try/catch → Task 7 (`costParseControls`, `costRangeDays`, `costBarHtml`, tests).
- Refresh, motion, `onUnmount`, reduced motion → Task 7 (self-refresh, `.animate` CSS, count-up), Task 5 (`grow` in the treemap; `still` in `isoStage`).
- Ledger status ribbon → Task 7 (`costRibbonItems`, ribbon), unread notes → Task 7 (`costNotesHtml`).
- Overview: four KPI tiles, burn-down with forecast, band (25th–75th, none under 3 days), budget lines with conversion and skip, "Add a monthly budget" link, spike line (2× and $1, days before the 1st), compact rings (8, riskiest first, colors, dashed no data, "+ N more") → Task 2 (data), Task 5 (charts), Task 7 (page).
- Breakdown: flow (top 6 + Other, Plan fee, hover, click filter), iso treemap (footprint, height, `~` names, 40 cap, Other per center), calendar (week × weekday, 5 quantile steps, empty days, tooltip), table (`/api/cost/ledger` `groupBy`, up to 4, sortable, spend, share, requests, tokens, per request, filter chip with clear) → Task 3, Task 5, Task 7.
- Value: plan bars with multiplier and the under-1× wording, waterfall (four steps, cache estimate, plan up or down), local models note, scatter (x, y, size, hollow under 50, unlisted gateway-only models, pass rate tooltip), unit lines with gaps → Task 3, Task 6, Task 7.
- Accuracy per model (attribution in both parsers, `days[day].models`, normalized names, `CACHE_VERSION`, `accuracyByModel`), pass rates → Task 1, Task 3.
- Budgets page: status banners (error with reasons and the disabled form, kept, guard with name, reason, since), cards (ring with overflow arc, name, scope, period with dates, spent of amount, chips, no-data reason, Edit/Delete), form (name, read-only id with suffix, scope with suggestions and free entry, period, amount, currency, measure, two levels, projection, enforcement with reasons, 400/409, legacy note), delete confirmation, `?focus=`, bell link → Task 8.
- Server: `views.js` pure functions, `cacheSaved`, the route (session only, range rules, 400s, 503, the always-present fields), quality memo and pass rates, demo → Tasks 2–4.
- Error handling (error + retry with the bar kept, unread notes, empty states) → Task 7 (`costErrorHtml`, `holoEmpty` per chart).
- Privacy (numbers and names only, esc audits) → Global Constraints, Tasks 4, 5, 7.
- Testing list of the spec → Task 2 (forecast, band, budget lines, spikes, rings, currency per day), Task 3 (flow, Plan fee, treemap cap, calendar, multiplier, waterfall, local, scatter, unit gaps, pass rates), Task 2 (`cacheSaved`), Task 1 (parsers, `accuracyByModel`), Task 4 (401, gateway key, 400, 503, path-free, demo pages), Tasks 7–8 (UI helpers, esc audits).
- Docs → Task 9.

**Placeholder scan:** no TBD or "similar to"; every code step shows the code or the exact replacement with its location.

**Type consistency:** the view answers produced in Tasks 2–3 (`month`, `spent`, `total`, `daily`, `forecast.line`, `budgetLines`, `spikes`, `rings`, `moreBudgets`, `atRisk`, `topCenter`; `flow.columns/nodes/links`, `treemap[].blocks`, `calendar.steps/days`, `planFee`; `plans`, `waterfall`, `local`, `scatter.dots/noToolCalls`, `unit`) are the fields Tasks 5–7 read; the special keys `__other`, `__plan`, `__none` are the same in `views.js` and `costcharts.js` (`COST_OTHER`, `COST_PLAN`, `COST_NONE`). `accuracyByModel`'s `{ results, modelFailures, accuracy, daily: { ok } }` (Task 1) is what `value()` reads (Task 3); `passRates`' `{ pass, total, rate }` is what the scatter's tooltip reads (Task 6). `costMountTreemap(…, { grow })` returns the stage that `costMountPage` destroys (Task 7). The budget alert's `budget` (Task 8, `lib/monitors/api.js`) is what `alertLine` reads. `costInstallEvents` (Task 7) and `costInstallBudgetEvents` (Task 8) listen to disjoint `data-cost-*` attributes.
