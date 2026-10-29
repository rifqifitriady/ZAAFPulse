# Cost Control 4b: cheaper-model recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Recommendations** card on the Value page (`#cost/value`) that names a model the owner pays for, a cheaper
model that did about as well in one of the owner's own Datasets experiments, the experiment itself (linked), and an
estimate of the monthly saving at the last 30 days' use; plus the 3 biggest spenders with no such evidence yet. Nothing
is switched.

**Architecture:**
- **One pure module.** `lib/cost/recommend.js`: `recommend({ experiments, spend, onPlan, from, to, now, limits })`
  (the rules R1–R7 below) and `spendByModel(rows)`, the 30-day usage value per normalized model plus the models that
  ran under a plan.
- **View and route.** `views.value` takes `recommendations` and passes it through (null when absent).
  `GET /api/cost/view?page=value` computes it from a new `experiments()` provider on `createCostApi` (default
  `() => []`) and its own quiet `cost.budgetRows` read of `[today − 29, today]`, so the page range never changes it; a
  read that throws gives `recommendations: null`. `server.js` passes `experiments: () => experiments.list()`.
- **Demo.** `datasetsDemo` gains a 24-ticket **Support tickets** dataset and a finished run (Opus, Sonnet, local Qwen)
  that backs `claude-opus-5-5 → claude-sonnet-5-5` and leaves Sonnet as a `no_cheaper_match` gap. `server.js` already
  seeds demo experiments into the store, so the route needs no demo branch.
- **Datasets deep link.** Datasets has no per-experiment route today; `#datasets/experiments?run=<id>` is added
  (`dsRunOf` in `public/datasetview.js`), and the Experiments tab opens that run after it paints.
- **Page.** `public/costview.js`: the card's text helpers and markup, after the unit charts; `public/styles.css`: its
  few rules.

**Tech Stack:** Node ≥18 standard library only (CommonJS), `node:test`, plain browser JS in `public/` (classic scripts
sharing one global scope, loaded before `app.js`).

**Spec:** `docs/superpowers/specs/2026-10-28-cost-recommendations-design.md`. Builds on the cost ledger (PR #53), the
Cost Control menu (PR #55), 4a (PR #57) and Datasets experiments.

**Line numbers** below are on `feat/cost-recommendations` at `09510e3`. Re-read each location before editing it.

**Checked while planning:** each task's code and tests were applied, in order, to a scratch copy of `09510e3` and run
with `node --test`; every new test passes after its task, and after Task 6 the whole suite passes: `npm test` 2076
tests, 2074 pass, 2 skipped, 0 fail. `npx prettier@3 --check` passes on every JS file this plan creates or changes,
except `lib/demo.js` and `server.js`, whose only Prettier differences are ones that already exist on `09510e3`.

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test` (`npm test`; one file:
  `node --test test/<file>.test.js`). Plain browser JS in `public/`: classic `<script>` files loaded by
  `public/index.html` before `app.js`.
- **Pure module.** `lib/cost/recommend.js` does no I/O and reads no clock: `now` (ms) is an argument. It may require
  `normalizeModel` from `lib/pricing.js` (pure), as `lib/cost/views.js` does.
- **One global scope.** New top-level names in `public/costview.js` start with `cost` or `COST`
  (`test/cost-ui.test.js` checks it); new ones in `public/datasetview.js` start with `ds` or `DS`. No name may repeat
  one in another page script ("every page script shares one global scope" checks it).
- **Loadable in Node.** Nothing in a browser file touches the DOM, `window`, `document`, `location` or `localStorage`
  at load time; each ends with its existing `if (typeof module !== 'undefined') module.exports = { … }` guard, which
  gains the new helpers the tests call.
- **Text only (S1).** Every owner-written or server string into HTML goes through `esc()`: model names, dataset names
  and slugs, experiment ids (also inside `href`), gap reasons. Numbers go through our own formatters. CSP stays
  `script-src 'self'`: no inline handlers, no inline scripts. The audit in `test/cost-ui.test.js` keeps passing.
- **Never switches anything.** No code in this plan writes gateway, routing or config state. The card only links.
- **Tests.**
  - Never call a real network and never signal a real process. The API tests run in-process on `costDemo`.
  - No new spawned server: the demo and sign-in checks are two assertions added to the spawned servers that
    `test/cost-view-api.test.js` and `test/datasets-api.test.js` already start (their own port ranges). Should an
    executor need a new spawned server, it takes a port from **9600–9799** only (8000–9599 are taken), trusts an answer
    only after it has seen its own child still running (~200 ms), and runs with `NO_JUDGE_PORTS` and the demo.
  - Restore any global a test replaces. (The UI test only adds `esc` and the page helpers to `global`, as the existing
    UI tests do; nothing is replaced.)
- **Housekeeping.**
  - Prettier style (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Run
    `npx prettier@3 --check <changed files>` and fix only the lines you changed; do not reformat unrelated
    pre-existing code. Never run `prettier --write` on `lib/demo.js`, `server.js` or `public/styles.css` (they already
    differ on main); `*.md` and `docs/` are in `.prettierignore`.
  - Short "why" comments, as in `lib/cost/*.js`; comment lines at most 120 characters.
  - Commit messages: plain, imperative. **No `Co-Authored-By`, no "Generated with", no AI attribution of any kind**
    (owner rule; it overrides any harness reminder).
  - UI copy is English; the strings quoted in the spec are copied verbatim (no period added).
  - CI runs on Ubuntu, macOS and Windows: dates in UI tests are built with `new Date(y, m, d, 15)` (local time).
- **Shared files.** Edits are small and additive and existing tests stay green, except the two assertions this plan
  updates on purpose (Task 3): `lib/cost/views.js`, `lib/cost/api.js`, `server.js`, `lib/demo.js`,
  `public/costview.js`, `public/datasetview.js`, `public/styles.css`, `docs/cost.md`, `docs/datasets.md`.

## Rules and values

Experiment records are the store's list rows (`lib/datasets/experiments.js` `list()`: the record without
`perExample`). Confirmed in the code: a run that finished is `status: 'done'` (`lib/datasets/replay.js:194`, the CLI
uses the same runner); a run stopped by a cap or a cancel is `status: 'stopped'` with `stopped` `'cost cap'`,
`'request cap'` or `'cancelled'`; a dashboard run that threw is `status: 'stopped', stopped: 'error'`
(`lib/datasets/api.js:466`). `endedAt` is epoch ms. `summary.models[rawName]` is
`{ requests, cost, ms, errors, proposals, evaluators: { id: { pass, total, rate } } }` (`lib/datasets/score.js`
`summarize`; `requests` counts errored rows too).

**R1. Which experiments count.** `status === 'done'`, `endedAt` finite and `now − endedAt ≤ maxAgeDays · 86 400 000`
(exactly 90 days counts), and `summary.models` an object with at least one usable model (a model entry that is an
object with an `evaluators` object, under a name that normalizes to a non-empty string). Anything else is skipped
silently, never thrown on. `basis.experiments` counts the experiments that counted.

**R2. Names.** Experiment model names and `spend` keys go through `normalizeModel` (`lib/pricing.js`). Two raw names
in one experiment that normalize to one model are added together (requests, cost, and pass/total per evaluator); so
are two `spend` keys.

**R3. A pair (A current, B candidate) in one experiment.** A needs `spend[A] > 0` and `requests > 0`; B needs
`requests > 0`. Over the evaluators **both** have: `rows` = Σ total, `rate` = Σ pass / Σ total, per model. The pair is
evidence ("compared") when both `rows ≥ minRows`. `costPer = cost / requests`; a negative cost reads as 0.

**R4. Qualifying.** Evidence, and `costPer(A) > 0` (a model that cost nothing in the run is never saved on), and
`costPer(B) / costPer(A) ≤ maxCostRatio + 1e-9`, and `rate(B) ≥ rate(A) − maxDropPoints / 100 − 1e-9`. The epsilon
makes the exact edges (5 points, 0.8) qualify despite floating point.

**R5. Choosing per A.** Qualifying pairs sorted by cost ratio ascending (= monthly saving descending, the spend being
A's own), then `rateB` descending, then `endedAt` descending (newest), then candidate name, then experiment id. The
first is the recommendation; `alsoBackedBy` = the number of other qualifying pairs for A (across experiments and
candidates).

**R6. A recommendation.** `{ model, candidate, local: costPer(B) === 0, spendUSD, savingUSD: spend × (1 − ratio),
costRatio, rateA, rateB, rowsA, rowsB, experiment: { id, dataset, datasetName, endedAt }, alsoBackedBy, onPlan }`;
money rounded to 8 decimals, `costRatio` and rates to 4; `experiment` strings are `null` when not strings. `onPlan` is
true when A is in the `onPlan` input. Items sorted by `savingUSD` descending, then model; at most `maxItems`.

**R7. Gaps.** The models with spend > 0 and no qualifying pair (a model recommended but cut by `maxItems` is no gap),
sorted by spend descending then name, at most `maxGaps`: `{ model, spendUSD, reason }`, `reason` `no_cheaper_match`
when the model was compared (R3) in some counted experiment, else `no_experiment`.

**R8. Spend.** `spendByModel(rows)` over `cost.budgetRows({ from: today − 29, to: today }).rows`: Σ `listUSD` of the
usage rows (plan rows left out) per normalized model (null model skipped), 8 decimals; `onPlan` = the models with a
usage row of `listUSD > 0` on a `(source, day)` that has a plan row (sorted).

**U1. Copy.** Row: "**claude-opus-5-5 → claude-sonnet-5-5**: about $42 a month at the last 30 days' use (cost per
example 31 % of today's)"; "Pass rate 91 % vs 93 % on *support-tickets* (120 rows each, 12 Oct)" (candidate's rate
first; the dataset's name, else its slug; "38 and 40 rows" when the two differ), linked to
`#datasets/experiments?run=<id>`; chip "local"; "+1 more experiment agrees" / "+n more experiments agree". Gaps under
"No evidence yet": "**gpt-6.1-sol** · $13.45 in the last 30 days · No experiment yet · Run an experiment in Datasets"
(link `#datasets`), reason "No cheaper model did as well" for `no_cheaper_match`. Empty: "No model spend in the last
30 days", "Run an experiment in Datasets to compare models on your own examples" (shown above the gaps when
`basis.experiments` is 0), "Recommendations could not be computed right now". Footnote: "Estimates from your own
experiments and the last 30 days' use. Nothing is switched for you." plus, when an item has `onPlan`, "Some of this
use was covered by a plan: switching there saves usage value, not money paid." Amounts in USD: the saving in whole
dollars from $10 ("$42", "$1,235"), `costMoney` below; spend with `costMoney`. Percentages "31 %".

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/cost/recommend.js` | create | pure `DEFAULTS`, `spendByModel`, `recommend` (R1–R8) |
| `lib/cost/views.js` | modify (shared) | `value({ …, recommendations })` passes it through |
| `lib/cost/api.js` | modify (shared) | `experiments` provider, `REC_DAYS`, `recommendationsFor(today)`, quiet read on Value |
| `server.js` | modify (shared) | `experiments: () => experiments.list()` for the cost API |
| `lib/demo.js` | modify (shared) | `datasetsDemo`: the Support tickets dataset and its finished run |
| `public/datasetview.js` | modify (shared) | `DS_EXP_ID`, `dsRunOf`; the Experiments tab opens `?run=<id>` |
| `public/costview.js` | modify (shared) | the Recommendations card and its text helpers |
| `public/styles.css` | modify (shared) | `.cost-recs`, `.cost-rec*`, `.cost-gaps`, `.cost-gap` (append) |
| `docs/cost.md`, `docs/datasets.md` | modify | the card, the rules, the API field, the demo, the deep link |
| `test/cost-recommend.test.js` | create | Task 1 |
| `test/cost-recommend-api.test.js` | create | Tasks 2–3 (views and the route, in-process; the demo) |
| `test/datasets-ui.test.js` | modify | Task 4: `dsRunOf` |
| `test/cost-recommend-ui.test.js` | create | Task 5 |
| `test/datasets-api.test.js`, `test/cost-view-api.test.js` | modify | Task 3: the demo's third experiment; the field over HTTP |

---
### Task 1: `lib/cost/recommend.js` (pure)

**Files:**
- Create: `lib/cost/recommend.js`
- Test: `test/cost-recommend.test.js` (create)

**Interfaces:**
- Consumes: `normalizeModel` (`lib/pricing.js`).
- Produces (all exported from `lib/cost/recommend.js`):
  - `DEFAULTS` (frozen): `{ maxDropPoints: 5, minRows: 20, maxCostRatio: 0.8, maxAgeDays: 90, maxItems: 5, maxGaps: 3 }`.
  - `spendByModel(rows) → { spend: { [model]: listUSD }, onPlan: [model] }` (R8).
  - `recommend({ experiments = [], spend = {}, onPlan = [], from = null, to = null, now, limits = {} }) →
    { items: [Rec], gaps: [Gap], basis: { experiments, from, to } }` (R1–R7; `limits` is merged over `DEFAULTS`).

- [ ] **Step 1: Write the failing test**

Create `test/cost-recommend.test.js`:

```js
// Cost Control 4b: lib/cost/recommend.js, cheaper models backed by the owner's own Datasets experiments. Pure:
// experiment records and spend in, recommendations and gaps out, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/cost/recommend');

const DAY = 86400000;
const NOW = new Date(2026, 9, 28, 12).getTime();
const RANGE = { from: '2026-09-29', to: '2026-10-28' };
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';
const QWEN = 'qwen3-coder:30b';

const ev = (pass, total) => ({ pass, total, rate: total ? pass / total : null });
// A model's summary as lib/datasets/score.js summarize writes it; `rel` is its relevance evaluator.
const m = (requests, cost, evaluators) => ({ requests, cost, ms: 1000, errors: 0, proposals: 0, evaluators });
const rel = (requests, cost, pass, total = 20) => m(requests, cost, { relevance: ev(pass, total) });
let seq = 0;
const exp = (models, over = {}) => ({
  id: `exp_${String(++seq).padStart(16, '0')}`,
  dataset: 'support-tickets',
  datasetName: 'Support tickets',
  models: Object.keys(models),
  status: 'done',
  stopped: null,
  startedAt: NOW - 2 * DAY - 60000,
  endedAt: NOW - 2 * DAY,
  summary: { models },
  ...over,
});
const run = (experiments, spend, over = {}) => R.recommend({ experiments, spend, ...RANGE, now: NOW, ...over });

test('recommend: a cheaper model as good on the same experiment, with the saving at the last 30 days of spend', () => {
  // Opus 0.1 per example, Sonnet 0.06 (60 %), both 19 of 20.
  const x = exp({ [OPUS]: rel(10, 1, 19), [SONNET]: rel(10, 0.6, 19) });
  const r = run([x], { [OPUS]: 100 });
  assert.deepEqual(r, {
    items: [
      {
        model: OPUS,
        candidate: SONNET,
        local: false,
        spendUSD: 100,
        savingUSD: 40,
        costRatio: 0.6,
        rateA: 0.95,
        rateB: 0.95,
        rowsA: 20,
        rowsB: 20,
        experiment: { id: x.id, dataset: 'support-tickets', datasetName: 'Support tickets', endedAt: NOW - 2 * DAY },
        alsoBackedBy: 0,
        onPlan: false,
      },
    ],
    gaps: [],
    basis: { experiments: 1, ...RANGE },
  });
  assert.equal(run([x], { [OPUS]: 100 }, { onPlan: [OPUS] }).items[0].onPlan, true, 'ran under a plan');
  assert.deepEqual(R.DEFAULTS, {
    maxDropPoints: 5,
    minRows: 20,
    maxCostRatio: 0.8,
    maxAgeDays: 90,
    maxItems: 5,
    maxGaps: 3,
  });
});

test('recommend: exactly 5 points lower, exactly 80 % of the cost and exactly 20 rows each still qualify', () => {
  const pick = (a, b) => run([exp({ [OPUS]: a, [SONNET]: b })], { [OPUS]: 10 }).items.map((i) => i.candidate);
  // Quality: 100 of 100 against 95 (5 points) and 94 (6 points).
  assert.deepEqual(pick(rel(10, 1, 100, 100), rel(10, 0.5, 95, 100)), [SONNET]);
  assert.deepEqual(pick(rel(10, 1, 100, 100), rel(10, 0.5, 94, 100)), []);
  // Cost: 0.08 against 0.1 (80 %) and 0.081 (81 %).
  assert.deepEqual(pick(rel(10, 1, 20), rel(10, 0.8, 20)), [SONNET]);
  assert.deepEqual(pick(rel(10, 1, 20), rel(10, 0.81, 20)), []);
  // Rows: 20 each, then 19 for either one.
  assert.deepEqual(pick(rel(10, 1, 20, 20), rel(10, 0.5, 20, 20)), [SONNET]);
  assert.deepEqual(pick(rel(10, 1, 19, 19), rel(10, 0.5, 20, 20)), []);
  assert.deepEqual(pick(rel(10, 1, 20, 20), rel(10, 0.5, 19, 19)), []);
  // A better candidate is fine, however much better.
  assert.deepEqual(pick(rel(10, 1, 10, 20), rel(10, 0.5, 20, 20)), [SONNET]);
});

test('recommend: only the evaluators both models have count; none in common is no evidence', () => {
  const a = m(10, 1, { relevance: ev(20, 20), reference_match: ev(0, 20) });
  const b = m(10, 0.5, { relevance: ev(20, 20) });
  const [r] = run([exp({ [OPUS]: a, [SONNET]: b })], { [OPUS]: 10 }).items;
  assert.deepEqual([r.rateA, r.rowsA, r.rateB, r.rowsB], [1, 20, 1, 20], 'reference_match is Opus-only');
  const apart = run([exp({ [OPUS]: rel(10, 1, 20), [SONNET]: m(10, 0.5, { faithfulness: ev(20, 20) }) })], {
    [OPUS]: 10,
  });
  assert.deepEqual(apart.items, []);
  assert.deepEqual(apart.gaps, [{ model: OPUS, spendUSD: 10, reason: 'no_experiment' }]);
});

test('recommend: stopped, old and unreadable runs and models without requests do not count', () => {
  const models = () => ({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 20) });
  const spend = { [OPUS]: 10 };
  const none = (xs) => {
    const r = run(xs, spend);
    assert.deepEqual(r.items, []);
    return r;
  };
  for (const stopped of ['cost cap', 'request cap', 'cancelled', 'error'])
    assert.equal(none([exp(models(), { status: 'stopped', stopped })]).basis.experiments, 0, stopped);
  assert.equal(none([exp(models(), { endedAt: NOW - 91 * DAY })]).basis.experiments, 0, 'ended 91 days ago');
  assert.equal(run([exp(models(), { endedAt: NOW - 90 * DAY })], spend).items.length, 1, 'ended 90 days ago');
  for (const bad of [
    null,
    'exp',
    [],
    exp(models(), { endedAt: null }),
    exp(models(), { summary: null }),
    exp(models(), { summary: { models: 'x' } }),
    exp({ [OPUS]: null, [SONNET]: { requests: 10 } }),
    exp({ '': rel(10, 1, 20), '/': rel(10, 0.5, 20) }),
  ])
    assert.equal(none([bad]).basis.experiments, 0, JSON.stringify(bad));
  const idle = none([exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(0, 0, 20) })]);
  assert.equal(idle.basis.experiments, 1);
  assert.deepEqual(idle.gaps, [{ model: OPUS, spendUSD: 10, reason: 'no_experiment' }], 'Sonnet made no request');
});

test('recommend: a local candidate costs nothing; a model that cost nothing in the run is not saved on', () => {
  const [r] = run([exp({ [OPUS]: rel(10, 1, 20), [QWEN]: rel(10, 0, 19) })], { [OPUS]: 30 }).items;
  assert.deepEqual([r.candidate, r.local, r.costRatio, r.savingUSD], [QWEN, true, 0, 30]);
  const free = run([exp({ [OPUS]: rel(10, 0, 20), [QWEN]: rel(10, 0, 20) })], { [OPUS]: 30 });
  assert.deepEqual(free.items, []);
  assert.deepEqual(free.gaps, [{ model: OPUS, spendUSD: 30, reason: 'no_cheaper_match' }]);
});

test('recommend: the largest saving wins, then the best pass rate, then the newest run; the rest back it', () => {
  const older = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.6, 20) }, { endedAt: NOW - 5 * DAY });
  const newer = exp({ [OPUS]: rel(10, 1, 20), [HAIKU]: rel(10, 0.2, 20) }, { endedAt: NOW - DAY });
  const again = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.6, 20) }, { endedAt: NOW - 3 * DAY });
  const [r] = run([older, newer, again], { [OPUS]: 100 }).items;
  assert.deepEqual([r.candidate, r.savingUSD, r.experiment.id, r.alsoBackedBy], [HAIKU, 80, newer.id, 2]);
  // The same cost ratio: the better pass rate, then the newer run.
  const lower = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 19) }, { endedAt: NOW - DAY });
  const higher = exp({ [OPUS]: rel(10, 1, 20), [HAIKU]: rel(10, 0.5, 20) }, { endedAt: NOW - 9 * DAY });
  assert.equal(run([lower, higher], { [OPUS]: 100 }).items[0].candidate, HAIKU);
  const first = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 20) }, { endedAt: NOW - 9 * DAY });
  const second = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 20) }, { endedAt: NOW - DAY });
  const [tie] = run([first, second], { [OPUS]: 100 }).items;
  assert.deepEqual([tie.experiment.id, tie.alsoBackedBy], [second.id, 1]);
});

test('recommend: items by saving, at most 5; gaps by spend, at most 3; a capped-out model is no gap', () => {
  const names = ['m-a', 'm-b', 'm-c', 'm-d', 'm-e', 'm-f', 'm-g'];
  const models = { cheap: rel(10, 0, 20) };
  const spend = { 'n-1': 1, 'n-2': 4, 'n-3': 3, 'n-4': 2 };
  names.forEach((n, i) => {
    models[n] = rel(10, 1, 20);
    spend[n] = 10 * (i + 1);
  });
  const r = run([exp(models)], spend);
  assert.deepEqual(
    r.items.map((i) => [i.model, i.savingUSD]),
    [
      ['m-g', 70],
      ['m-f', 60],
      ['m-e', 50],
      ['m-d', 40],
      ['m-c', 30],
    ],
  );
  assert.deepEqual(
    r.gaps.map((g) => [g.model, g.spendUSD, g.reason]),
    [
      ['n-2', 4, 'no_experiment'],
      ['n-3', 3, 'no_experiment'],
      ['n-4', 2, 'no_experiment'],
    ],
    'm-a and m-b are recommended past the cap',
  );
  const few = run([exp(models)], spend, { limits: { maxItems: 2, maxGaps: 1 } });
  assert.deepEqual([few.items.length, few.gaps.length], [2, 1]);
});

test('recommend: both gap reasons, and no gap for a model with no spend or a credit', () => {
  const x = exp({ [OPUS]: rel(10, 1, 20), [QWEN]: rel(10, 0, 12) }); // the local model is far worse
  const r = run([x], { [OPUS]: 100, 'gpt-6.1-sol': 50, 'deepseek-chat': 20, 'llama-3.3-70b': 10, z: 0, c: -5 });
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.gaps, [
    { model: OPUS, spendUSD: 100, reason: 'no_cheaper_match' },
    { model: 'gpt-6.1-sol', spendUSD: 50, reason: 'no_experiment' },
    { model: 'deepseek-chat', spendUSD: 20, reason: 'no_experiment' },
  ]);
  assert.deepEqual(run([], { z: 0, c: -5 }), { items: [], gaps: [], basis: { experiments: 0, ...RANGE } });
  assert.deepEqual(R.recommend({ now: NOW }).items, [], 'no input at all');
});

test('recommend: model names are normalized as the ledger does, and two names for one model add up', () => {
  const x = exp({
    'us.anthropic.claude-opus-5-5-v1:0': rel(10, 1, 20),
    'anthropic/claude-haiku-5-5': rel(5, 0.1, 10, 10),
    'claude-haiku-5-5': rel(5, 0.1, 10, 10),
  });
  const r = run([x], { 'Anthropic/Claude-Opus-5-5': 50 });
  assert.deepEqual(
    r.items.map((i) => [i.model, i.candidate, i.rowsB, i.costRatio]),
    [[OPUS, HAIKU, 20, 0.2]],
  );
});

test('recommend: amounts to 8 decimals, rates and the cost ratio to 4', () => {
  const x = exp({ [OPUS]: rel(3, 3, 30, 45), [SONNET]: rel(3, 1, 20, 30) });
  const [r] = run([x], { [OPUS]: 1 / 3 }).items;
  assert.deepEqual(
    [r.spendUSD, r.savingUSD, r.costRatio, r.rateA, r.rateB],
    [0.33333333, 0.22222222, 0.3333, 0.6667, 0.6667],
  );
});

test('spendByModel: usage value per model over the rows, plan rows out, and the models used under a plan', () => {
  const row = (over) => ({ day: '2026-10-20', source: 'claude', model: OPUS, kind: 'chat', listUSD: 1, ...over });
  const rows = [
    row({}),
    row({ day: '2026-10-21', listUSD: 2.5 }),
    { day: '2026-10-21', source: 'claude', model: null, kind: 'plan', listUSD: 0, billedUSD: 6.45 },
    row({ source: 'gateway', model: 'anthropic/claude-sonnet-5-5', listUSD: 0.1 }),
    row({ source: 'gateway', day: '2026-10-21', model: SONNET, listUSD: 0.2 }),
    row({ source: 'judge', model: 'qwen3:8b', listUSD: 0, free: true }),
    row({ model: null, listUSD: 9 }),
    null,
  ];
  assert.deepEqual(R.spendByModel(rows), {
    spend: { [OPUS]: 3.5, [SONNET]: 0.3, 'qwen3:8b': 0 },
    onPlan: [OPUS],
  });
  assert.deepEqual(R.spendByModel(undefined), { spend: {}, onPlan: [] });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-recommend.test.js`
Expected: FAIL: `Error: Cannot find module '../lib/cost/recommend'`.

- [ ] **Step 3: Create `lib/cost/recommend.js`**

```js
// Cost Control, sub-project 4b: cheaper-model recommendations. Each names a model the owner pays for, a cheaper model
// that did about as well on the owner's own Datasets experiments (the same examples, scored by the same evaluators),
// and what switching would save a month at the last 30 days' use. The experiments are the only evidence. Nothing is
// switched: routing stays a manual gateway setting. Pure: no I/O and no clock (`now` is an argument).
const { normalizeModel } = require('../pricing');

const DAY_MS = 86400000;
const DEFAULTS = Object.freeze({
  maxDropPoints: 5, // the candidate's pass rate at most this many points below the current model's
  minRows: 20, // scored rows each model needs, over the evaluators both have
  maxCostRatio: 0.8, // the candidate's cost per example at most this share of the current model's
  maxAgeDays: 90, // experiments that ended longer ago do not count
  maxItems: 5,
  maxGaps: 3,
});
const EPS = 1e-9; // the edges (exactly 5 points, exactly 0.8) qualify despite floating point

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const round8 = (v) => Math.round(v * 1e8) / 1e8;
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v) => (typeof v === 'string' ? v : null);

// One counted experiment's models by normalized name: { requests, cost, evaluators: Map(id → { pass, total }) }. Two
// raw names that normalize to one are added together. Null for a record that does not count: not a finished run
// ('done'; a stopped or errored run is 'stopped'), ended over `maxAgeDays` ago, or with no usable summary.
function modelsOf(x, { now, maxAgeDays }) {
  if (!isObject(x) || x.status !== 'done' || !Number.isFinite(x.endedAt)) return null;
  if (now - x.endedAt > maxAgeDays * DAY_MS) return null;
  const models = isObject(x.summary) && isObject(x.summary.models) ? x.summary.models : null;
  if (!models) return null;
  const out = new Map();
  for (const [name, m] of Object.entries(models)) {
    const model = normalizeModel(name);
    if (!model || !isObject(m) || !isObject(m.evaluators)) continue;
    if (!out.has(model)) out.set(model, { requests: 0, cost: 0, evaluators: new Map() });
    const o = out.get(model);
    o.requests += num(m.requests);
    o.cost += num(m.cost);
    for (const [id, e] of Object.entries(m.evaluators)) {
      if (!isObject(e) || !Number.isFinite(e.pass) || !Number.isFinite(e.total)) continue;
      const v = o.evaluators.get(id) || { pass: 0, total: 0 };
      v.pass += e.pass;
      v.total += e.total;
      o.evaluators.set(id, v);
    }
  }
  return out.size ? out : null;
}

// Two models of one experiment over the evaluators both have: each one's pass rate and rows (the summed totals). Null
// without a common evaluator or a row.
function compare(a, b) {
  let passA = 0;
  let passB = 0;
  let rowsA = 0;
  let rowsB = 0;
  for (const [id, ea] of a.evaluators) {
    const eb = b.evaluators.get(id);
    if (!eb) continue;
    passA += ea.pass;
    rowsA += ea.total;
    passB += eb.pass;
    rowsB += eb.total;
  }
  if (!(rowsA > 0) || !(rowsB > 0)) return null;
  return { rateA: passA / rowsA, rateB: passB / rowsB, rowsA, rowsB };
}

/**
 * The ledger rows of a window as `spend` for recommend(): usage value (list) per normalized model, plan rows left out,
 * and `onPlan`, the models with usage on a day their source was on a plan (a switch there saves usage value, not money
 * paid). Rows are the cost object's budgetRows (plan rows included).
 */
function spendByModel(rows) {
  const planDays = new Set();
  for (const r of rows || []) if (r && r.kind === 'plan') planDays.add(`${r.source}|${r.day}`);
  const spend = new Map();
  const onPlan = new Set();
  for (const r of rows || []) {
    if (!r || r.kind === 'plan') continue;
    const model = normalizeModel(r.model);
    if (!model) continue;
    spend.set(model, (spend.get(model) || 0) + num(r.listUSD));
    if (num(r.listUSD) > 0 && planDays.has(`${r.source}|${r.day}`)) onPlan.add(model);
  }
  return {
    spend: Object.fromEntries([...spend].map(([m, v]) => [m, round8(v)])),
    onPlan: [...onPlan].sort(cmp),
  };
}

/**
 * Cheaper models backed by the experiments. `experiments` is the experiment store's list (lib/datasets/experiments.js),
 * `spend` { model: listUSD } over [from, to] (spendByModel), `onPlan` the models that ran under a plan there.
 * Returns { items: [Rec], gaps: [Gap], basis: { experiments, from, to } }, where `basis.experiments` counts the
 * experiments that counted.
 */
function recommend({ experiments = [], spend = {}, onPlan = [], from = null, to = null, now, limits = {} } = {}) {
  const L = { ...DEFAULTS, ...(isObject(limits) ? limits : {}) };
  const spent = new Map();
  for (const [name, v] of Object.entries(isObject(spend) ? spend : {})) {
    const model = normalizeModel(name);
    if (model) spent.set(model, (spent.get(model) || 0) + num(v));
  }
  const plan = new Set((Array.isArray(onPlan) ? onPlan : []).map(normalizeModel));
  const spendOf = (m) => spent.get(m) || 0;

  const pairs = new Map(); // current model → its qualifying pairs
  const compared = new Set(); // models that met another model with enough rows in a counted experiment
  let counted = 0;
  for (const x of Array.isArray(experiments) ? experiments : []) {
    const models = modelsOf(x, { now, maxAgeDays: L.maxAgeDays });
    if (!models) continue;
    counted++;
    for (const [A, a] of models) {
      if (!(spendOf(A) > 0) || !(a.requests > 0)) continue;
      const costA = a.cost / a.requests;
      for (const [B, b] of models) {
        if (B === A || !(b.requests > 0)) continue;
        const c = compare(a, b);
        if (!c || c.rowsA < L.minRows || c.rowsB < L.minRows) continue;
        compared.add(A);
        if (!(costA > 0)) continue; // a model that cost nothing here has nothing to save on
        const costB = Math.max(0, b.cost / b.requests);
        const ratio = costB / costA;
        if (ratio > L.maxCostRatio + EPS) continue;
        if (c.rateB < c.rateA - L.maxDropPoints / 100 - EPS) continue;
        if (!pairs.has(A)) pairs.set(A, []);
        pairs.get(A).push({ B, costB, ratio, c, x });
      }
    }
  }

  // Per current model: the largest saving first (the same spend, so the lowest cost ratio), then the best pass rate,
  // then the newest experiment; the rest back it.
  const recs = [];
  for (const [A, list] of pairs) {
    list.sort(
      (p, q) =>
        p.ratio - q.ratio || q.c.rateB - p.c.rateB || q.x.endedAt - p.x.endedAt || cmp(p.B, q.B) || cmp(p.x.id, q.x.id),
    );
    const best = list[0];
    const s = spendOf(A);
    recs.push({
      model: A,
      candidate: best.B,
      local: best.costB === 0,
      spendUSD: round8(s),
      savingUSD: round8(s * (1 - best.ratio)),
      costRatio: round4(best.ratio),
      rateA: round4(best.c.rateA),
      rateB: round4(best.c.rateB),
      rowsA: best.c.rowsA,
      rowsB: best.c.rowsB,
      experiment: {
        id: text(best.x.id),
        dataset: text(best.x.dataset),
        datasetName: text(best.x.datasetName),
        endedAt: best.x.endedAt,
      },
      alsoBackedBy: list.length - 1,
      onPlan: plan.has(A),
    });
  }
  recs.sort((p, q) => q.savingUSD - p.savingUSD || cmp(p.model, q.model));

  // The models the owner pays for most that no experiment backs a switch for, whether or not they were recommended
  // past the cap.
  const gaps = [...spent]
    .filter(([m, s]) => s > 0 && !pairs.has(m))
    .sort((p, q) => q[1] - p[1] || cmp(p[0], q[0]))
    .slice(0, Math.max(0, L.maxGaps))
    .map(([model, s]) => ({
      model,
      spendUSD: round8(s),
      reason: compared.has(model) ? 'no_cheaper_match' : 'no_experiment',
    }));

  return { items: recs.slice(0, Math.max(0, L.maxItems)), gaps, basis: { experiments: counted, from, to } };
}

module.exports = { DEFAULTS, spendByModel, recommend };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/cost-recommend.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check lib/cost/recommend.js test/cost-recommend.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add lib/cost/recommend.js test/cost-recommend.test.js
git commit -m "Cost recommendations: cheaper models backed by Datasets experiments, with the monthly saving"
```

---
### Task 2: the view, the route and the server wiring

**Files:**
- Modify: `lib/cost/views.js` (`value`, lines 525–529 and the return at ~654)
- Modify: `lib/cost/api.js` (requires at 11, constants at 22, `createCostApi` options at 50, `quietly` at 164, the
  Value branch at 205–217)
- Modify: `server.js` (`createCostApi({ … })` at 513–527)
- Test: `test/cost-recommend-api.test.js` (create)

**Interfaces:**
- Consumes: Task 1's `recommend`, `spendByModel`; `cost.budgetRows({ from, to })` (`lib/cost/index.js:746`);
  `addDays` (`lib/cost/days.js`); the experiment store's `list()` (`lib/datasets/experiments.js`).
- Produces:
  - `views.value({ …, recommendations = null })` → the answer gains `recommendations` (the input, or null).
  - `createCostApi({ …, experiments = () => [] })`; `GET /api/cost/view?page=value` answers `recommendations`: the
    `recommend` result over `[today − 29, today]`, or null when the experiments or the spend read throws. The Overview
    and Breakdown answers do not carry the field.

- [ ] **Step 1: Write the failing test**

Create `test/cost-recommend-api.test.js` (Task 3 appends one more test to it):

```js
// Cost Control 4b: the recommendations in the Value answer of GET /api/cost/view, in-process on the demo ledger. The
// spend is the last 30 days whatever the page's range; a read that fails gives null and the page still renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const V = require('../lib/cost/views');
const { spendByModel } = require('../lib/cost/recommend');
const { costDemo } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const DAY = 86400000;
const NOW = new Date(2026, 9, 22, 15).getTime(); // a Thursday afternoon
const TODAY = dayOf(NOW);
const FROM30 = addDays(TODAY, -29);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);

// An experiment as the store lists it: Opus and Sonnet on 24 examples, two evaluators, Sonnet at 60 % of the cost.
const ev = (pass, total) => ({ pass, total, rate: pass / total });
const EXPERIMENT = {
  id: 'exp_00000000000000b1',
  dataset: 'support-tickets',
  datasetName: 'Support tickets',
  models: ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5'],
  evaluators: ['reference_match', 'relevance'],
  startedAt: NOW - 3 * DAY - 600000,
  endedAt: NOW - 3 * DAY,
  status: 'done',
  stopped: null,
  examples: 24,
  summary: {
    models: {
      'anthropic/claude-opus-5-5': {
        requests: 24,
        cost: 0.288,
        ms: 2100,
        errors: 0,
        proposals: 0,
        evaluators: { reference_match: ev(23, 24), relevance: ev(24, 24) },
      },
      'anthropic/claude-sonnet-5-5': {
        requests: 24,
        cost: 0.1728,
        ms: 1500,
        errors: 0,
        proposals: 0,
        evaluators: { reference_match: ev(22, 24), relevance: ev(24, 24) },
      },
    },
  },
};

function setup({ experiments, failRead } = {}) {
  const d = costDemo(NOW);
  const real = createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => NOW, nocase: false });
  const reads = [];
  // The cost object with its budgetRows watched; `failRead(range)` true makes that read throw.
  const cost = {
    ...real,
    budgetRows: (range) => {
      reads.push(range);
      if (failRead && failRead(range)) throw new Error(`ledger unreadable at ${path.join(HOME, '.data', 'cost')}`);
      return real.budgetRows(range);
    },
  };
  const api = createCostApi({
    cost,
    settings: { get: () => d.settings, save: () => {} },
    home: HOME,
    now: () => NOW,
    ...(experiments ? { experiments } : {}),
  });
  const bodies = [];
  const get = async (query) => {
    const r = await api.route({ method: 'GET', path: '/api/cost/view', query: new URLSearchParams(query) });
    bodies.push(JSON.stringify(r.body));
    return r;
  };
  return { get, reads, real, bodies };
}

test('views.value passes the recommendations through; none given is null', () => {
  const rec = { items: [], gaps: [], basis: { experiments: 0, from: FROM30, to: TODAY } };
  const range = { rows: [], from: FROM30, to: TODAY };
  assert.equal(V.value({ ...range, recommendations: rec }).recommendations, rec);
  assert.equal(V.value({ ...range, recommendations: null }).recommendations, null);
  assert.equal(V.value(range).recommendations, null);
});

test('cost view: Value recommends from the experiments and the last 30 days of usage value', async () => {
  const s = setup({ experiments: () => [EXPERIMENT] });
  const r = await s.get('page=value');
  assert.equal(r.status, 200);
  const rec = r.body.recommendations;
  assert.deepEqual(rec.basis, { experiments: 1, from: FROM30, to: TODAY });
  const { spend } = spendByModel(s.real.budgetRows({ from: FROM30, to: TODAY }).rows);
  assert.equal(rec.items.length, 1);
  const [item] = rec.items;
  assert.deepEqual(
    [item.model, item.candidate, item.local, item.costRatio, item.rateA, item.rateB, item.rowsA, item.rowsB],
    [OPUS, SONNET, false, 0.6, 0.9792, 0.9583, 48, 48],
  );
  assert.equal(item.spendUSD, spend[OPUS], 'usage value, plan rows left out');
  near(item.savingUSD, spend[OPUS] * 0.4);
  assert.equal(item.onPlan, true, 'Claude Code is on a plan in the demo');
  assert.deepEqual(item.experiment, {
    id: EXPERIMENT.id,
    dataset: 'support-tickets',
    datasetName: 'Support tickets',
    endedAt: EXPERIMENT.endedAt,
  });
  // Sonnet met Opus with enough rows, but Opus is no cheaper; the others never ran in an experiment.
  const gaps = Object.fromEntries(rec.gaps.map((g) => [g.model, g.reason]));
  assert.equal(gaps[SONNET], 'no_cheaper_match');
  assert.ok(rec.gaps.length === 3 && rec.gaps.every((g) => g.spendUSD > 0 && g.model !== OPUS));
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('cost view: the 30 days of spend do not follow the page range', async () => {
  const s = setup({ experiments: () => [EXPERIMENT] });
  const week = (await s.get(`page=value&from=${addDays(TODAY, -6)}&to=${TODAY}`)).body;
  const august = (await s.get('page=value&from=2026-08-01&to=2026-08-31')).body;
  assert.deepEqual(week.recommendations, august.recommendations);
  assert.deepEqual(august.recommendations.basis, { experiments: 1, from: FROM30, to: TODAY });
  assert.ok(august.recommendations.items.length === 1, 'August has no rows, the last 30 days do');
  assert.deepEqual(s.reads.filter((x) => x.from === FROM30 && x.to === TODAY).length, 2, 'one read per answer');
});

test('cost view: a failed read gives null recommendations and the page still renders', async () => {
  const from = addDays(TODAY, -6);
  const failing = [
    setup({
      experiments: () => {
        throw new Error('experiments unreadable');
      },
    }),
    setup({ experiments: () => [EXPERIMENT], failRead: (range) => range.from === FROM30 }),
  ];
  for (const s of failing) {
    const r = await s.get(`page=value&from=${from}&to=${TODAY}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.recommendations, null);
    assert.ok(r.body.plans.length > 0 && r.body.unit.length === 7, 'the rest of the page');
    for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
  }
  const o = await setup().get('page=overview');
  assert.equal(Object.hasOwn(o.body, 'recommendations'), false, 'the Value page only');
});

test('cost view: with no experiment provider, no recommendation and the top 3 spenders as gaps', async () => {
  const r = (await setup().get('page=value')).body.recommendations;
  assert.deepEqual(r.items, []);
  assert.equal(r.basis.experiments, 0);
  assert.equal(r.gaps.length, 3);
  assert.ok(r.gaps.every((g) => g.reason === 'no_experiment'));
  assert.ok(r.gaps[0].spendUSD >= r.gaps[1].spendUSD && r.gaps[1].spendUSD >= r.gaps[2].spendUSD);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-recommend-api.test.js`
Expected: FAIL, all 5: `AssertionError` (`recommendations` is `undefined`, not the input or null) and
`TypeError: Cannot read properties of undefined (reading 'basis')` (or `'items'`).

- [ ] **Step 3: Pass `recommendations` through `views.value`**

In `lib/cost/views.js`, replace the end of the `value` doc comment and its signature:

```js
 * range, `passRates` this file's passRates.
 */
function value({ rows = [], from, to, rateOf = null, cacheSaved = () => 0, accuracy = {}, passRates: pr = {} }) {
```

with:

```js
 * range, `passRates` this file's passRates. `recommendations` (lib/cost/recommend.js, over the last 30 days whatever
 * the range) is passed through as it is; null when it could not be computed.
 */
function value({
  rows = [],
  from,
  to,
  rateOf = null,
  cacheSaved = () => 0,
  accuracy = {},
  passRates: pr = {},
  recommendations = null,
}) {
```

and in its return, after `unit,`:

```js
    scatter: { dots, noToolCalls },
    unit,
    recommendations: recommendations || null,
    missingRate: c.missing(),
```

- [ ] **Step 4: Compute it in the route**

In `lib/cost/api.js`, after `const { HISTORY_DAYS } = require('./anomaly');`:

```js
const { recommend, spendByModel } = require('./recommend');
```

after `const VIEW_DAYS = 30; …`:

```js
const REC_DAYS = 30; // the recommendations' spend: the last 30 days, whatever the page's range
```

in the `createCostApi` options, after `passRates = () => ({}),`:

```js
  // The experiment store's list (lib/datasets/experiments.js), for the Value page's cheaper-model recommendations
  // (Cost Control 4b).
  experiments = () => [],
```

right after the `quietly` helper (before `function view(q) {`):

```js
  // The Value page's recommendations (lib/cost/recommend.js): the experiments against the usage value per model of
  // the last 30 days, a read of its own, so the page's range never changes them.
  function recommendationsFor(today) {
    const from = addDays(today, -(REC_DAYS - 1));
    const { spend, onPlan } = spendByModel(cost.budgetRows({ from, to: today }).rows);
    return recommend({ experiments: experiments() || [], spend, onPlan, from, to: today, now: now() });
  }
```

and in the Value branch of `view`, after `const [pass] = quietly(() => passRates({ from, to }), {});`:

```js
      // A read that fails (the experiments or the 30 days of spend) gives null; the page still renders.
      const [recs] = quietly(() => recommendationsFor(today), null);
```

then pass it on, after `passRates: pass,` in the `views.value({ … })` call:

```js
        passRates: pass,
        recommendations: recs,
      });
```

- [ ] **Step 5: Wire the store in `server.js`**

In the `createCostApi({ … })` call, after `passRates: (range) => costPassRates(experiments.list(), range),`:

```js
  experiments: () => experiments.list(),
```

(The store is made further down, as for `passRates`; the provider only runs on a request.)

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/cost-recommend-api.test.js test/cost-view-api.test.js test/cost-views-pages.test.js`
Expected: PASS (5 new tests; the existing ones unchanged).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check lib/cost/views.js lib/cost/api.js test/cost-recommend-api.test.js`
Expected: `All matched files use Prettier code style!` (`server.js` already differs on main: check that the one line
you added is formatted like its neighbours, and do not run `--write` on it.)

- [ ] **Step 8: Commit**

```bash
git add lib/cost/views.js lib/cost/api.js server.js test/cost-recommend-api.test.js
git commit -m "Cost view: the Value answer carries cheaper-model recommendations over the last 30 days"
```

---
### Task 3: the demo's Support tickets experiment

**Files:**
- Modify: `lib/demo.js` (`datasetsDemo`, its return at line 1254)
- Modify: `test/datasets-api.test.js` (line 983: the demo now lists 3 experiments)
- Modify: `test/cost-view-api.test.js` (the spawned demo test at ~272 and the sign-in test at ~314)
- Test: `test/cost-recommend-api.test.js` (append)

**Interfaces:**
- Consumes: `datasetsDemo`'s own `exId`, `at`, `row`, `record` and `QWEN` (`lib/demo.js:1004–1133`); `server.js:609–617`
  already creates every `seed.datasets` entry and appends every `seed.experiments` record.
- Produces: `datasetsDemo(now)` returns `datasets: [support, auth, pagination]` and
  `experiments: [supportRun, authRun, paginationRun]`. `support` is `{ slug: 'support-tickets', name: 'Support
  tickets', examples: [24 tickets] }`; `supportRun` is `exp_00000000000000a0`, `status: 'done'`, ended 16 days before
  `now`, models `ollama/qwen3-coder:30b`, `anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5-5`, evaluators
  `reference_match` and `relevance` (48 rows each): Opus 47/48 at $0.012 an example, Sonnet 46/48 at $0.0072 (60 %),
  Qwen 35/48 at $0. Against the demo ledger: one item, `claude-opus-5-5 → claude-sonnet-5-5` (about $20 a month,
  `onPlan` true: Claude Code is on the demo plan), and the gaps `claude-sonnet-5-5` (`no_cheaper_match`),
  `gpt-6.1-sol` and `deepseek-chat` (`no_experiment`). Appended first, the run is the store's oldest record, so the
  newest-first list still starts with the pagination run.

- [ ] **Step 1: Write the failing tests**

Append to `test/cost-recommend-api.test.js`:

```js

test('demo: the support-tickets experiment backs one recommendation and leaves both kinds of gap', async () => {
  const { datasetsDemo } = require('../lib/demo');
  const seed = datasetsDemo(NOW);
  const r = (await setup({ experiments: () => seed.experiments }).get('page=value')).body.recommendations;
  assert.equal(r.basis.experiments, 2, 'the stopped pagination run does not count');
  assert.deepEqual(
    r.items.map((i) => [i.model, i.candidate, i.costRatio, i.experiment.id, i.experiment.datasetName, i.onPlan]),
    [[OPUS, SONNET, 0.6, 'exp_00000000000000a0', 'Support tickets', true]],
  );
  assert.deepEqual(
    r.gaps.map((g) => [g.model, g.reason]),
    [
      [SONNET, 'no_cheaper_match'],
      ['gpt-6.1-sol', 'no_experiment'],
      ['deepseek-chat', 'no_experiment'],
    ],
  );
  const support = seed.datasets.find((d) => d.slug === 'support-tickets');
  assert.equal(support.examples.length, 24);
});
```

In `test/datasets-api.test.js`, test "datasets api: demo datasets and experiments over HTTP, masked and path-free",
replace:

```js
    assert.equal(exps.json.experiments.length, 2);
```

with:

```js
    assert.equal(exps.json.experiments.length, 3, 'support tickets, auth regressions and pagination');
```

In `test/cost-view-api.test.js`, test "cost view over HTTP: every demo page answers, …", after the line
`for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']) assert.ok(models.includes(m), m);` add:

```js
    // Cost Control 4b: the demo's support-tickets experiment, read through server.js's experiments provider.
    const rec = v.json.recommendations;
    assert.deepEqual(
      rec.items.map((i) => [i.model, i.candidate, i.experiment.id]),
      [['claude-opus-5-5', 'claude-sonnet-5-5', 'exp_00000000000000a0']],
    );
    assert.deepEqual(
      rec.gaps.map((g) => g.reason),
      ['no_cheaper_match', 'no_experiment', 'no_experiment'],
    );
```

and in test "cost view over HTTP: the dashboard sign-in only, never a gateway key", after
`assert.deepEqual(r.json.scatter, { dots: [], noToolCalls: [] }, 'an empty ledger');` add:

```js
    const rec = r.json.recommendations;
    assert.deepEqual([rec.items, rec.gaps, rec.basis.experiments], [[], [], 0], 'no spend and no experiment');
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/cost-recommend-api.test.js test/datasets-api.test.js test/cost-view-api.test.js`
Expected: FAIL in 3 tests: the new demo test (`basis.experiments` 1, not 2: only the auth run counts and has too few
rows), the datasets demo test (2 experiments, not 3) and the spawned Value test (no item). The sign-in assertion
passes already (Task 2).

- [ ] **Step 3: Add the dataset and its run to `datasetsDemo`**

In `lib/demo.js`, replace the last line of `datasetsDemo`:

```js
  return { datasets: [auth, pagination], experiments: [authRun, paginationRun] };
```

with:

```js
  // Support tickets (Cost Control 4b): Opus, Sonnet and a local Qwen on 24 tickets, 16 days ago. Sonnet does about as
  // well as Opus at 60 % of the cost per example, so the Value page recommends it; Qwen costs nothing but passes far
  // less often, so Sonnet stays a gap ("No cheaper model did as well"). Listed first, so it is the oldest record.
  const OPUS = 'anthropic/claude-opus-5-5';
  const SONNET = 'anthropic/claude-sonnet-5-5';
  const TICKETS = [
    ['I was charged twice for October', 'refund the duplicate charge'],
    ['the invoice shows the wrong company name', 'update the billing name'],
    ['how do I add a teammate to my workspace', 'invite them from Settings'],
    ['the export to CSV is empty', 'pick a date range first'],
    ['I cannot sign in after changing my email', 'sign in with the new email'],
    ['the mobile app logs me out every hour', 'update the app'],
    ['can I move my plan to yearly billing', 'switch to yearly in Billing'],
    ['webhooks stopped arriving yesterday', 'the endpoint returned errors'],
  ];
  const tickets = [];
  ['', 'Hi, ', 'Urgent: '].forEach((lead, round) =>
    TICKETS.forEach(([ask, reference], i) =>
      tickets.push({
        id: exId(101 + round * TICKETS.length + i),
        createdAt: at(400 + tickets.length),
        updatedAt: at(400 + tickets.length),
        source: null,
        input: { system: 'You answer customer support tickets.', messages: [{ role: 'user', text: lead + ask }] },
        output: { text: `To fix this, ${reference}.`, model: null },
        reference: { text: reference },
        tags: ['support'],
        evals: {},
        feedback: null,
      }),
    ),
  );
  const support = { slug: 'support-tickets', name: 'Support tickets', examples: tickets };
  // Each model's misses, by ticket number: reference_match first, then relevance.
  const misses = {
    [OPUS]: [[5], []],
    [SONNET]: [[5, 17], []],
    [QWEN]: [
      [1, 3, 5, 7, 9, 11, 13, 15, 17],
      [2, 6, 10, 14],
    ],
  };
  const per = { [OPUS]: 0.012, [SONNET]: 0.0072, [QWEN]: 0 };
  const supportRun = record({
    id: 'exp_00000000000000a0',
    dataset: support,
    examples: tickets,
    models: [QWEN, OPUS, SONNET],
    evaluators: ['reference_match', 'relevance'],
    hoursAgo: 16 * 24,
    minutes: 6,
    caps: { maxCostUSD: 1, maxRequests: 100 },
    perExample: tickets.flatMap((t, i) =>
      [QWEN, OPUS, SONNET].map((model) => {
        const [refMiss, relMiss] = misses[model];
        const hit = !refMiss.includes(i);
        const ref = t.reference.text;
        return row(
          t,
          model,
          hit ? `Sorry about that: ${ref}.` : 'Please contact support.',
          { reference_match: hit ? 'match' : 'no_match', relevance: relMiss.includes(i) ? 'partly' : 'relevant' },
          { cost: per[model], ms: model === QWEN ? 4200 : 1600 },
        );
      }),
    ),
  });

  return { datasets: [support, auth, pagination], experiments: [supportRun, authRun, paginationRun] };
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/cost-recommend-api.test.js test/datasets-api.test.js test/cost-view-api.test.js test/datasets-ui.test.js`
Expected: PASS.

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check test/cost-recommend-api.test.js test/datasets-api.test.js test/cost-view-api.test.js`
Expected: `All matched files use Prettier code style!` `lib/demo.js` already differs on main: compare
`npx prettier@3 lib/demo.js | diff - lib/demo.js` before and after your edit; no new hunk may appear.

- [ ] **Step 6: Commit**

```bash
git add lib/demo.js test/cost-recommend-api.test.js test/datasets-api.test.js test/cost-view-api.test.js
git commit -m "Demo: a support-tickets experiment that backs one cheaper-model recommendation"
```

---
### Task 4: a Datasets link that opens one experiment

The spec's `#datasets/<slug>?experiment=<id>` does not exist: Datasets routes are `#datasets`, `#datasets?ds=<slug>`
and `#datasets/experiments` (`public/datasetview.js:139` `dsRoute`), and a run opens only by a click on its row. This
task adds `#datasets/experiments?run=<id>`, which the card links to (Task 5). `app.js` strips the query before
routing (`public/app.js:1109`), so the hash still mounts the Experiments tab, and a `hashchange` re-mounts it.

**Files:**
- Modify: `public/datasetview.js` (after `dsRoute` at 139–147; the end of `dsPaintExperiments` at 1494–1498; the
  exports at ~2580)
- Test: `test/datasets-ui.test.js` (the import list at 7–43; a test after "dsRoute: …" at 121)

**Interfaces:**
- Consumes: the experiment id format `exp_` + 16 hex (`lib/datasets/api.js:15` `EXPERIMENT_ID`).
- Produces: `DS_EXP_ID`; `dsRunOf(hash) → id | null` (the `run` of an `#datasets/experiments?…` hash when it is an
  experiment id). `dsPaintExperiments` opens that run, when listed, after it paints. `dsRoute` is unchanged.

- [ ] **Step 1: Write the failing test**

In `test/datasets-ui.test.js`, add `dsRunOf,` after `dsRoute,` in the destructured `require('../public/datasetview')`
list, and add after the test "dsRoute: the tab and the dataset of a Datasets hash":

```js
test('dsRunOf: the experiment a Datasets hash opens, from the Value page link', () => {
  assert.equal(dsRunOf('#datasets/experiments?run=exp_00000000000000a0'), 'exp_00000000000000a0');
  assert.equal(dsRunOf('datasets/experiments?ds=x&run=exp_0123456789abcdef'), 'exp_0123456789abcdef', 'no # is fine');
  for (const h of [
    '#datasets/experiments',
    '#datasets?run=exp_00000000000000a0', // the list tab opens no run
    '#datasets/experiments?run=exp_1',
    '#datasets/experiments?run=../x',
    '#datasets/experiments?run=EXP_00000000000000A0',
    '',
    null,
  ])
    assert.equal(dsRunOf(h), null, String(h));
  assert.deepEqual(dsRoute('#datasets/experiments?run=exp_00000000000000a0'), { tab: 'experiments', slug: null });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/datasets-ui.test.js`
Expected: FAIL: `TypeError: dsRunOf is not a function`.

- [ ] **Step 3: Add `dsRunOf`**

In `public/datasetview.js`, between `dsRoute` and the line
`/* ---------- Playground Dataset mode and experiments: pure helpers ---------- */`:

```js
// The run a Datasets hash opens: #datasets/experiments?run=<id>, as the Value page's Recommendations link to it
// (Cost Control 4b). Null for any other hash or an id that is not an experiment id.
const DS_EXP_ID = /^exp_[0-9a-f]{16}$/;
function dsRunOf(hash) {
  const [route, query = ''] = String(hash || '')
    .replace(/^#/, '')
    .split('?');
  if (route.split('/')[1] !== 'experiments') return null;
  const id = new URLSearchParams(query).get('run');
  return id && DS_EXP_ID.test(id) ? id : null;
}
```

At the end of `dsPaintExperiments`, after its final `body.replaceChildren( dsPanel('Experiments', …), detail, );`:

```js
  // A link that names a run (the Value page's Recommendations) opens it, as a click on its row does.
  const wanted = dsRunOf(location.hash);
  const named = wanted && runs.find((x) => x.id === wanted);
  if (named) open(named);
```

and add `dsRunOf,` after `dsRoute,` in the `module.exports` list at the end of the file.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/datasets-ui.test.js test/cost-ui.test.js`
Expected: PASS (the global-scope test sees no repeated name).

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check public/datasetview.js test/datasets-ui.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add public/datasetview.js test/datasets-ui.test.js
git commit -m "Datasets: #datasets/experiments?run=<id> opens that experiment"
```

---
### Task 5: the Recommendations card on the Value page

**Files:**
- Modify: `public/costview.js` (`costValueHtml` at 915–950; a new section before `/* ---------- Budgets ---------- */`;
  the exports at ~1457)
- Modify: `public/styles.css` (append)
- Test: `test/cost-recommend-ui.test.js` (create)

**Interfaces:**
- Consumes: Task 2's `recommendations` in the Value answer; Task 4's `#datasets/experiments?run=<id>`; the page's
  `costMoney`, `costDayOf`, `costShortDay` (`public/costview.js:164`, `:76`, `:1013`; called at render time, so the
  later `const` is defined by then), and the iso.js helpers `esc`, `panel`, `holoEmpty`.
- Produces (exported for the tests): `costPercent(x) → '31 %'`, `costAbout(usd) → '$42' | '$4.26'`,
  `costExperimentHref(id) → '#datasets/experiments?run=<id>' | '#datasets/experiments'`, `costRecTexts(rec) →
  { saving, rates, dataset, detail, more }` (plain text, U1), `costRecommendationsHtml(recommendations) → html`.
  Internal: `COST_REC_COPY`, `COST_GAP_REASON`, `costRecHtml`, `costGapHtml`. `costValueHtml` ends with the
  "Recommendations" panel.

- [ ] **Step 1: Write the failing test**

Create `test/cost-recommend-ui.test.js`:

```js
// Cost Control 4b in the browser file, without a browser: the Value page's Recommendations card (public/costview.js),
// its row texts, empty states, plan footnote and experiment link. Every model, dataset and experiment name reaches the
// markup through esc().
const test = require('node:test');
const assert = require('node:assert/strict');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// The page scripts share one global scope: costview.js uses the chart builders and the iso.js page helpers.
const C = require('../public/costcharts');
Object.assign(global, C, {
  COST_C: { cyan: '#4de8ff', violet: '#8b7bff', pink: '#ff4fd8', orange: '#ff9a3c', muted: '#8f98cc', blue: '#5b8cff' },
  COST_SERIES: ['#4de8ff'],
  metricTile: ({ label, value, sub }) => `<div class="metric">${label}|${value}|${sub}</div>`,
  panel: (title, meta, body) => `<section><h3>${title}</h3><span class="meta">${meta}</span>${body}</section>`,
  holoEmpty: (text) => `<div class="empty">${text}</div>`,
});
const U = require('../public/costview');

const EVIL = '<img src=x onerror=alert(1)>';
const ENDED = new Date(2026, 9, 12, 15).getTime(); // 12 Oct, local time
const rec = (over = {}) => ({
  model: 'claude-opus-5-5',
  candidate: 'claude-sonnet-5-5',
  local: false,
  spendUSD: 135.2,
  savingUSD: 42.4,
  costRatio: 0.3125,
  rateA: 0.93,
  rateB: 0.9083,
  rowsA: 120,
  rowsB: 120,
  experiment: { id: 'exp_00000000000000a0', dataset: 'support-tickets', datasetName: null, endedAt: ENDED },
  alsoBackedBy: 0,
  onPlan: false,
  ...over,
});
const answer = (over = {}) => ({
  items: [rec()],
  gaps: [{ model: 'gpt-6.1-sol', spendUSD: 13.45, reason: 'no_experiment' }],
  basis: { experiments: 1, from: '2026-09-29', to: '2026-10-28' },
  ...over,
});
const FOOT = 'Estimates from your own experiments and the last 30 days&#39; use. Nothing is switched for you.';

test('a recommendation row: the saving, the cost per example, the pass rates, the rows and the day', () => {
  assert.deepEqual(U.costRecTexts(rec()), {
    saving: "about $42 a month at the last 30 days' use (cost per example 31 % of today's)",
    rates: 'Pass rate 91 % vs 93 %',
    dataset: 'support-tickets',
    detail: '120 rows each, 12 Oct',
    more: '',
  });
  const t = U.costRecTexts(
    rec({ savingUSD: 4.256, rowsA: 40, rowsB: 38, alsoBackedBy: 1, experiment: { datasetName: 'Support tickets' } }),
  );
  assert.deepEqual(
    [t.saving.slice(0, 15), t.dataset, t.detail, t.more],
    ['about $4.26 a m', 'Support tickets', '38 and 40 rows', '+1 more experiment agrees'],
  );
  assert.equal(U.costRecTexts(rec({ alsoBackedBy: 3 })).more, '+3 more experiments agree');
  assert.equal(U.costAbout(1234.5), '$1,235');
  assert.equal(U.costPercent(0), '0 %');
});

test('the experiment link opens its run in Datasets; without an id, the Experiments tab', () => {
  assert.equal(U.costExperimentHref('exp_00000000000000a0'), '#datasets/experiments?run=exp_00000000000000a0');
  assert.equal(U.costExperimentHref('a&b'), '#datasets/experiments?run=a%26b');
  for (const bad of [null, undefined, '', 7]) assert.equal(U.costExperimentHref(bad), '#datasets/experiments');
  const html = U.costRecommendationsHtml(answer());
  assert.match(html, /<a href="#datasets\/experiments\?run=exp_00000000000000a0">/);
  assert.match(html, /Pass rate 91 % vs 93 % on <i>support-tickets<\/i> \(120 rows each, 12 Oct\)<\/a>/);
});

test('the card: rows, a local chip, the experiments that agree, the gaps and the footnote', () => {
  const html = U.costRecommendationsHtml(
    answer({
      items: [rec(), rec({ model: 'gpt-6.1-sol', candidate: 'qwen3-coder:30b', local: true, alsoBackedBy: 2 })],
      gaps: [
        { model: 'claude-sonnet-5-5', spendUSD: 33.23, reason: 'no_cheaper_match' },
        { model: 'deepseek-chat', spendUSD: 1.22, reason: 'no_experiment' },
      ],
    }),
  );
  assert.match(html, /<b>claude-opus-5-5 → claude-sonnet-5-5<\/b>: about \$42 a month at the last 30 days&#39; use/);
  assert.equal(html.match(/<span class="cost-chip">local<\/span>/g).length, 1, 'only the local candidate');
  assert.match(html, /\+2 more experiments agree/);
  assert.match(html, /No evidence yet/);
  assert.match(html, /<b>claude-sonnet-5-5<\/b> · \$33\.23 in the last 30 days · No cheaper model did as well/);
  assert.match(html, /<b>deepseek-chat<\/b> · \$1\.22 in the last 30 days · No experiment yet/);
  assert.equal(html.match(/<a href="#datasets">Run an experiment in Datasets<\/a>/g).length, 2);
  assert.ok(html.endsWith(`<p class="cost-note">${FOOT}</p>`), 'no plan sentence');
  assert.doesNotMatch(html, /Run an experiment in Datasets to compare/);
});

test('the footnote says so when a recommended model ran under a plan', () => {
  const html = U.costRecommendationsHtml(answer({ items: [rec({ onPlan: true })] }));
  assert.ok(
    html.endsWith(
      `${FOOT} Some of this use was covered by a plan: switching there saves usage value, not money paid.</p>`,
    ),
  );
  const gapOnly = U.costRecommendationsHtml(answer({ items: [] }));
  assert.doesNotMatch(gapOnly, /covered by a plan/);
});

test('empty states: could not be computed, no spend, no experiments', () => {
  for (const bad of [null, undefined, {}, { items: [] }])
    assert.equal(
      U.costRecommendationsHtml(bad),
      '<p class="cost-note warn">Recommendations could not be computed right now</p>',
    );
  assert.equal(
    U.costRecommendationsHtml(answer({ items: [], gaps: [] })),
    '<div class="empty">No model spend in the last 30 days</div>',
  );
  const none = U.costRecommendationsHtml(answer({ items: [], basis: { experiments: 0 } }));
  assert.ok(
    none.startsWith('<p class="cost-note">Run an experiment in Datasets to compare models on your own examples</p>'),
  );
  assert.match(none, /No evidence yet/);
});

test('every model, dataset and experiment name goes through esc()', () => {
  const html = U.costRecommendationsHtml(
    answer({
      items: [
        rec({
          model: EVIL,
          candidate: `${EVIL}2`,
          experiment: { id: `"><script>x</script>`, dataset: EVIL, datasetName: `<b>${EVIL}</b>`, endedAt: ENDED },
        }),
      ],
      gaps: [{ model: `${EVIL}3`, spendUSD: 1, reason: EVIL }],
    }),
  );
  assert.doesNotMatch(html, /<img|<script|<b><img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; → &lt;img src=x onerror=alert\(1\)&gt;2/);
  assert.match(html, /href="#datasets\/experiments\?run=%22%3E%3Cscript%3Ex%3C%2Fscript%3E"/);
  assert.match(html, /<i>&lt;b&gt;&lt;img src=x onerror=alert\(1\)&gt;&lt;\/b&gt;<\/i>/);
  assert.match(html, /No experiment yet/, 'an unknown reason reads as no experiment');
});

test('the Value page places the Recommendations card after its charts', () => {
  const v = {
    plans: [],
    waterfall: { withoutCache: 0, cacheSaved: 0, usage: 0, planSaved: 0, paid: 0 },
    local: { requests: 0, tokens: 0, models: [] },
    scatter: { dots: [], noToolCalls: [] },
    unit: [{ day: '2026-10-01', perRequest: 1, perMillionTokens: 1, perThousandToolCalls: null }],
    accuracyError: null,
    recommendations: answer(),
  };
  const html = U.costValueHtml(v, { measure: 'list', cur: 'USD', fmt: (x) => U.costMoney(x), centers: {}, keys: {} });
  const at = html.indexOf('<h3>Recommendations</h3>');
  assert.ok(at > html.indexOf('Per 1,000 successful tool calls'), 'after the unit charts');
  assert.match(html.slice(at), /claude-opus-5-5 → claude-sonnet-5-5/);
  assert.match(
    U.costValueHtml({ ...v, recommendations: null }, { fmt: (x) => U.costMoney(x) }),
    /Recommendations could not be computed right now/,
  );
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-recommend-ui.test.js`
Expected: FAIL, all 7: `TypeError: U.costRecTexts is not a function` (and `U.costExperimentHref`,
`U.costRecommendationsHtml`), and the Value page test's `after the unit charts` assertion (no "Recommendations"
panel yet).

- [ ] **Step 3: Add the card**

In `public/costview.js`, `costValueHtml` ends with:

```js
      ${unit('perThousandToolCalls', 'Per 1,000 successful tool calls', COST_C.pink, 'Claude Code and Codex only')}
    </div>`;
}
```

Replace that with the panel after the unit charts, then the new section (it sits between `costValueHtml` and
`/* ---------- Budgets ---------- */`):

```js
      ${unit('perThousandToolCalls', 'Per 1,000 successful tool calls', COST_C.pink, 'Claude Code and Codex only')}
    </div>
    ${panel('Recommendations', 'cheaper models that did about as well in your experiments · usage value in USD', costRecommendationsHtml(v.recommendations))}`;
}

/* ---------- Value: cheaper-model recommendations (Cost Control 4b) ---------- */

const COST_REC_COPY = {
  failed: 'Recommendations could not be computed right now',
  noSpend: 'No model spend in the last 30 days',
  noExperiments: 'Run an experiment in Datasets to compare models on your own examples',
  gapsTitle: 'No evidence yet',
  runOne: 'Run an experiment in Datasets',
  foot: "Estimates from your own experiments and the last 30 days' use. Nothing is switched for you.",
  plan: 'Some of this use was covered by a plan: switching there saves usage value, not money paid.',
};
const COST_GAP_REASON = { no_experiment: 'No experiment yet', no_cheaper_match: 'No cheaper model did as well' };
// A share as "31 %", the way the card writes it.
const costPercent = (x) => `${Math.round((Number(x) || 0) * 100)} %`;
// An estimate in USD: whole dollars from $10 ("about $42"), cents below.
const costAbout = (v) => (Math.abs(v) >= 10 ? `$${Math.round(v).toLocaleString('en')}` : costMoney(v, 'USD'));
// Where a recommendation's experiment opens: its run on the Datasets Experiments tab (public/datasetview.js dsRunOf).
const costExperimentHref = (id) =>
  typeof id === 'string' && id ? `#datasets/experiments?run=${encodeURIComponent(id)}` : '#datasets/experiments';
// A recommendation's lines as plain text: the saving, the evidence and the experiments that agree.
function costRecTexts(r) {
  const n = Number(r.alsoBackedBy) || 0;
  const x = r.experiment || {};
  const rows = r.rowsA === r.rowsB ? `${r.rowsB} rows each` : `${r.rowsB} and ${r.rowsA} rows`;
  const day = Number.isFinite(x.endedAt) ? `, ${costShortDay(costDayOf(new Date(x.endedAt)))}` : '';
  return {
    saving: `about ${costAbout(r.savingUSD)} a month at the last 30 days' use (cost per example ${costPercent(r.costRatio)} of today's)`,
    rates: `Pass rate ${costPercent(r.rateB)} vs ${costPercent(r.rateA)}`,
    dataset: String(x.datasetName || x.dataset || 'an experiment'),
    detail: `${rows}${day}`,
    more: n > 0 ? `+${n} more experiment${n === 1 ? ' agrees' : 's agree'}` : '',
  };
}
function costRecHtml(r) {
  const t = costRecTexts(r);
  const local = r.local ? ' <span class="cost-chip">local</span>' : '';
  const more = t.more ? ` <small class="muted">${esc(t.more)}</small>` : '';
  return `<li class="cost-rec"><p class="cost-rec-main"><b>${esc(r.model)} → ${esc(r.candidate)}</b>: ${esc(t.saving)}${local}</p>
    <p class="cost-rec-ev"><a href="${esc(costExperimentHref(r.experiment && r.experiment.id))}">${esc(t.rates)} on <i>${esc(t.dataset)}</i> (${esc(t.detail)})</a>${more}</p></li>`;
}
function costGapHtml(g) {
  const reason = Object.hasOwn(COST_GAP_REASON, g.reason || '')
    ? COST_GAP_REASON[g.reason]
    : COST_GAP_REASON.no_experiment;
  return `<li class="cost-gap"><b>${esc(g.model)}</b> · ${esc(costMoney(g.spendUSD, 'USD'))} in the last 30 days · ${esc(reason)} · <a href="#datasets">${esc(COST_REC_COPY.runOne)}</a></li>`;
}
// The Recommendations card: a row per recommendation, the models with no evidence yet, and the footnote. The answer's
// `recommendations` is null when it could not be computed.
function costRecommendationsHtml(rec) {
  if (!rec || !Array.isArray(rec.items) || !Array.isArray(rec.gaps))
    return `<p class="cost-note warn">${esc(COST_REC_COPY.failed)}</p>`;
  if (!rec.items.length && !rec.gaps.length) return holoEmpty(esc(COST_REC_COPY.noSpend));
  const none =
    rec.basis && rec.basis.experiments === 0 ? `<p class="cost-note">${esc(COST_REC_COPY.noExperiments)}</p>` : '';
  const items = rec.items.length ? `<ul class="cost-recs">${rec.items.map(costRecHtml).join('')}</ul>` : '';
  const gaps = rec.gaps.length
    ? `<h4 class="cost-rec-sub">${esc(COST_REC_COPY.gapsTitle)}</h4><ul class="cost-gaps">${rec.gaps.map(costGapHtml).join('')}</ul>`
    : '';
  const plan = rec.items.some((r) => r.onPlan) ? ` ${esc(COST_REC_COPY.plan)}` : '';
  return `${none}${items}${gaps}<p class="cost-note">${esc(COST_REC_COPY.foot)}${plan}</p>`;
}
```

In the `module.exports` list, after `costValueHtml,`:

```js
    costPercent,
    costAbout,
    costExperimentHref,
    costRecTexts,
    costRecommendationsHtml,
```

- [ ] **Step 4: Style it**

Append to `public/styles.css` (after the 4a block that ends with `.cost-card .cost-card-forecast { … }`):

```css
/* Cost Control 4b: the Value page's Recommendations card. */
.cost-recs,
.cost-gaps {
  display: grid;
  gap: 10px;
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
}
.cost-rec {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--h-edge);
  border-radius: 12px;
}
.cost-rec-main,
.cost-rec-ev {
  margin: 0;
  overflow-wrap: anywhere;
}
.cost-rec-main {
  color: var(--h-text);
  font-size: 13px;
}
.cost-rec-ev {
  color: var(--h-muted);
  font-size: 12.5px;
}
.cost-rec-sub {
  margin: 4px 0 8px;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--h-muted);
}
.cost-gap {
  color: var(--h-muted);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/cost-recommend-ui.test.js test/cost-ui.test.js test/cost-forecast-ui.test.js`
Expected: PASS: 7 new tests; the esc() audit and the `cost` name prefix audit of `test/cost-ui.test.js` still pass.

- [ ] **Step 6: Check the style**

Run: `npx prettier@3 --check public/costview.js test/cost-recommend-ui.test.js`
Expected: `All matched files use Prettier code style!` (`public/costview.js` is clean on main, so `--write` on it is
safe; never on `public/styles.css`.)

- [ ] **Step 7: Commit**

```bash
git add public/costview.js public/styles.css test/cost-recommend-ui.test.js
git commit -m "Value page: a Recommendations card with the experiment behind each cheaper model"
```

---
### Task 6: docs and the whole suite

**Files:**
- Modify: `docs/cost.md` (the menu table's Value row at 325; a new `### Recommendations` after "Forecast and
  anomalies", before `### Settings page` at 435; the `GET /api/cost/view` row at 526; Demo mode at 557)
- Modify: `docs/datasets.md` (after the **Compare** bullet at ~236)

**Interfaces:**
- Consumes: Tasks 1–5 as built.
- Produces: documentation only.

- [ ] **Step 1: The menu table**

In `docs/cost.md`, the Value row of the Cost Control menu table ends with
`spend per request, per million tokens and per 1,000 successful tool calls, per day |`. Replace that ending with:

```markdown
spend per request, per million tokens and per 1,000 successful tool calls, per day; cheaper models your own Datasets experiments back, with the monthly saving (see [Recommendations](#recommendations)) |
```

- [ ] **Step 2: The Recommendations section**

After the last bullet of "Forecast and anomalies" ("**When the history does not read.** … the rule reports
`no_data`."), add a blank line and:

```markdown
### Recommendations

The Value page's **Recommendations** card names a model you pay for, a cheaper model that did about as well on your
own examples, and what switching would save. Nothing is switched for you: routing a model elsewhere stays a gateway
setting you change yourself.

- **Evidence.** Only [Datasets experiments](datasets.md#scoring-and-experiments) count: the same examples replayed on
  both models and scored by the same evaluators. A run counts when it finished (`status: "done"`; a run stopped by a
  cap, a cancel or an error does not) and ended in the last 90 days. Model names are matched as the ledger's are, so
  `anthropic/claude-opus-5-5` in an experiment is `claude-opus-5-5` in the ledger.
- **As good.** Over the evaluators both models were scored by, the candidate's pass rate is at most 5 points below
  the current model's, with at least 20 scored rows each.
- **Cheaper.** The candidate's cost per example in the run is at most 80 % of the current model's (a local model
  costs 0). A model that cost nothing in the run is never one to save on.
- **The saving.** The current model's usage value over the last 30 days times (1 − the cost ratio), in USD: "about
  $42 a month at the last 30 days' use". It is an estimate. The 30 days are always the last 30, whatever range the
  page shows. Where the model ran under a plan the saving is usage value, not money paid, and the footnote says so.
- **The choice.** For each model the largest saving wins, then the higher pass rate, then the newest run; the other
  runs that agree are counted ("+2 more experiments agree"). At most 5 recommendations, largest saving first. Each
  links to its run in Datasets (`#datasets/experiments?run=<id>`).
- **No evidence yet.** The 3 models with the most spend over the 30 days and no recommendation, each with its spend
  and a link to Datasets: "No experiment yet" (no finished run compared it with another model on enough rows) or "No
  cheaper model did as well".
- **When it cannot be computed.** A read that fails (the experiments or the 30 days of spend) answers
  `recommendations: null`; the card says "Recommendations could not be computed right now" and the rest of the page
  draws.
```

- [ ] **Step 3: The API row**

In the `GET /api/cost/view?page&from&to&currency&measure` row, replace
`the saved parameters of the rule) and `runsOut` on each ring. 400` with:

```markdown
the saved parameters of the rule) and `runsOut` on each ring. Value also answers `recommendations`: `{ items, gaps, basis: { experiments, from, to } }` over the last 30 days whatever the range, or null when it could not be computed; an item is `{ model, candidate, local, spendUSD, savingUSD, costRatio, rateA, rateB, rowsA, rowsB, experiment: { id, dataset, datasetName, endedAt }, alsoBackedBy, onPlan }` and a gap `{ model, spendUSD, reason }` (`no_experiment` or `no_cheaper_match`). 400
```

- [ ] **Step 4: Demo mode**

At the end of the "Demo mode" paragraph, after "…and the bell show its `cost_anomaly` alert.", add:

```markdown
 A finished Datasets experiment on 24 support tickets backs one recommendation on Value (Opus to Sonnet), and leaves Sonnet, GPT and DeepSeek under "No evidence yet".
```

(one space before "A", on the same line.)

- [ ] **Step 5: Datasets**

In `docs/datasets.md`, after the bullet "- **Compare.** Under **Datasets → Experiments**, … not like for like.", add:

```markdown
- **Link.** `#datasets/experiments?run=<id>` opens that run on the Experiments tab.
- **Cost.** Finished runs of the last 90 days back the cheaper-model recommendations on **Cost Control → Value**
  ([Recommendations](cost.md#recommendations)), which link to the run they rest on.
```

- [ ] **Step 6: The whole suite and the style**

Run: `npm test`
Expected: PASS: 25 new tests over `09510e3` (11 + 6 + 1 + 7); 0 fail (2 skipped, as on main).

Run: `npx prettier@3 --check lib/cost/recommend.js lib/cost/views.js lib/cost/api.js public/costview.js public/datasetview.js test/cost-recommend.test.js test/cost-recommend-api.test.js test/cost-recommend-ui.test.js test/datasets-ui.test.js test/datasets-api.test.js test/cost-view-api.test.js`
Expected: `All matched files use Prettier code style!`

Run: `git log --format=%B origin/main..HEAD | grep -ci "co-authored-by\|generated with"`
Expected: `0` (no AI attribution in any commit of the branch).

- [ ] **Step 7: Commit**

```bash
git add docs/cost.md docs/datasets.md
git commit -m "Docs: cheaper-model recommendations on the Value page and the Datasets run link"
```

---

## Decisions made while planning

- **The experiment link.** Datasets has no per-experiment route, so the spec's `#datasets/<slug>?experiment=<id>` is
  replaced by a new `#datasets/experiments?run=<id>` (Task 4): the run's id is what identifies it, and the slug of a
  deleted dataset would still name the run. `dsRoute` is left unchanged so its existing tests stand.
- **`status: 'done'` confirmed.** Only `'done'` counts; `'stopped'` covers caps, cancel and a dashboard run that threw
  (`stopped: 'error'`).
- **`onPlan` on each item.** The spec's footnote needs to know whether a recommended model "ran under a plan in the
  window", which the `Rec` shape does not carry. The route derives it from the same 30-day read (a usage row on a
  `(source, day)` that has a plan row, `spendByModel`) and `recommend` sets `onPlan` per item. Additive to the spec's
  shape.
- **`spendByModel` lives in `recommend.js`** (pure, tested there) rather than in `api.js`, so the route stays a thin
  wiring.
- **"Rows" are scored rows across the common evaluators** (Σ `total`), as the spec defines; with 24 examples and two
  evaluators that is 48, so the card says "48 rows each". `requests` (for the cost per example) includes errored rows,
  as `summarize` counts them.
- **Gap reason "compared".** `no_cheaper_match` means the model met another model in a counted run with both at
  ≥ 20 rows over common evaluators (and both with requests); anything short of that is `no_experiment`.
- **A recommended model cut by `maxItems` is not a gap** (it has a recommendation).
- **`basis.experiments` counts runs with a usable summary** (R1). With 0, the card shows the "Run an experiment…"
  line above the gaps (the gaps are then all "No experiment yet") rather than instead of them.
- **No spend** is detected as no item and no gap (every model with spend is one or the other).
- **Number formats.** The saving in whole dollars from $10 ("about $42", as the spec's example), cents below; spend in
  `costMoney`; percentages as "31 %" with a space, as the spec writes them. The singular "+1 more experiment agrees".
  Unequal rows read "38 and 40 rows" (candidate first, as the rates).
- **The plan sentence** of the footnote is not in the spec: "Some of this use was covered by a plan: switching there
  saves usage value, not money paid."
- **Panel meta**: "cheaper models that did about as well in your experiments · usage value in USD".
- **A 30-day read with an unread month** still computes (the spend is then partial); the Value page's ribbon already
  names unread months for its own range. Only a read that throws gives null.
- **Demo.** A third demo dataset and run (`support-tickets`, `exp_00000000000000a0`) rather than a summary-only
  record, so the Datasets page can open the run the card links to. It is appended first, so the newest-first list and
  the existing `experiments[0]` assertions are unchanged. The demo yields one item and **three** gaps (both reasons),
  not one gap: R7 lists every unbacked spender up to 3.
- **No new spawned server.** The demo and the empty-server answers are checked inside the spawned tests that
  `test/cost-view-api.test.js` already runs; everything else is in-process.

## Spec points that do not fit

- **`#datasets/<slug>?experiment=<id>`** does not exist; see the first decision.
- **"The demo … leaves one gap"** and "demo answers carry one item and one gap": with the gap rule (every model with
  spend and no recommendation, top 3) the demo ledger gives three gaps. The tests assert one item and the three gaps
  with both reasons.
- **The `Rec` shape** gains `onPlan` (see Decisions); the spec's footnote cannot be decided without it.
- **The plan footnote's wording** is not in the spec; this plan's sentence is in U1.

## Self-review

- **Spec coverage.** Evidence from experiments only (R1, Task 1); "as good" at 5 points and 20 rows, "cheaper" at
  80 %, both edges inclusive (Task 1 edge test); savings on 30-day list spend (R8, Tasks 1–2); ranking and
  `alsoBackedBy` (R5); caps 5 and 3 (R6–R7); gaps and both reasons; normalized names; rounding; skipped stopped/old/
  zero-request/invalid records; `views.value` pass-through and null; the route's independent 30-day window, failure
  to null, the `experiments()` provider with `() => []` default; server wiring; demo item and gaps; the card's rows,
  chip, "+n more", gaps with links, three empty states, footnote with the plan note, USD, `esc()` everywhere (Tasks
  2–5); docs (Task 6). Out of scope items (auto-routing, benchmarks, auto-runs, per-project, MCP/export) are untouched.
- **Signatures.** `recommend`/`spendByModel` are called with the same names and fields in `api.js` and the tests;
  `views.value` gains a defaulted option only; `createCostApi`'s new option is defaulted; `costRecommendationsHtml`
  takes the answer's `recommendations` as is; `dsRunOf` matches the id format of `lib/datasets/api.js:15`.
- **No placeholders.** Every step has its full code or exact replacement text; every test was run red then green on
  the scratch copy, and the whole suite after Task 6.
- **Globals.** New page names: `COST_REC_COPY`, `COST_GAP_REASON`, `costPercent`, `costAbout`, `costExperimentHref`,
  `costRecTexts`, `costRecHtml`, `costGapHtml`, `costRecommendationsHtml`, `DS_EXP_ID`, `dsRunOf`: none existed in
  any page script (checked with `grep`), and the global-scope test passes. `location` is read only inside
  `dsPaintExperiments`, at render time.
