# Cost Control 4a: forecast and anomalies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One weekday-aware forecast for every cost figure (the Overview burn-down, a budget's `projected` state and
the day it runs out), and cost anomalies raised through the Monitors engine as the rule `cost_anomaly`, with the
model, project, cost center and key that drove the rise shown in the dashboard only.

**Architecture:**
- **Two pure modules.** `lib/cost/forecast.js`: `dailyModel` (a mean per weekday over the 4 weeks of finished days,
  the plain mean with 3–6 known days, nothing below 3), `project` (the cumulative line to a day, with exact plan fees)
  and `runsOut`. `lib/cost/anomaly.js`: `measureDay` (a day against its weekday, with its top 3 drivers), `isAnomaly`,
  `anomalyParams` and `recentDays` (today so far and yesterday, each against the 4 weeks before it), which the rule and
  the Overview both read.
- **Budgets.** `evaluateBudget` takes `history`, `historyUnread` and `planFee`, decides `projected` from the forecast
  (the linear pace without a model) and gains `forecastUSD` and `runsOut`. The budget service reads one more cached
  window, the 28 days before today. The cost object gains `planFeeFor(source, day)`.
- **Overview.** `views.overview` takes `history` (the 29 days before the 1st) in place of `before`, plus `unread`,
  `planFee`, `anomalyParams` and `keyNames`; it answers `forecastMethod`, `anomalies`, `anomalyParams`, rings with
  `runsOut`, and a spike line marked by `isAnomaly`. `GET /api/cost/view` passes them; `server.js` gives the API the
  saved rule parameters.
- **Monitors.** `cost_anomaly` in `RULES` (aggregate, one instance per day, no reminder), its check over
  `snap.costAnomaly`, a `costAnomaly(t)` provider in `createMonitors` (server.js reads the ledger), a day past
  yesterday counted as ended, the two parameters bounded in the API, and `usual` on its alerts for the bell.
- **Pages.** The burn-down caption names the method; an Anomalies card under the spike line; ring captions and a
  Budgets card line with the runs-out date; the bell line and the Monitors card for the rule.
- **Demo.** A spike on yesterday in the demo ledger and the rule's states and alert in the demo Monitors store.

**Tech Stack:** Node ≥18 standard library only (CommonJS), `node:test`, plain browser JS in `public/` (classic scripts
sharing one global scope, loaded before `app.js`).

**Spec:** `docs/superpowers/specs/2026-10-28-cost-forecast-anomalies-design.md`. Builds on the cost ledger (PR #53),
budgets (PR #54), the Cost Control menu (PR #55) and the Settings page (PR #56).

**Line numbers** below are on `feat/cost-forecast` at `098fa77`. Re-read each location before editing it.

**Checked while planning:** each task's code and tests were applied, in order, to a scratch copy of `098fa77` and run
with `node --test`; every new test passes after its task, and after Task 8 the whole suite in that copy passes:
`npm test` 2018 tests, 2016 pass, 2 skipped, 0 fail. `npx prettier@3 --check` passes on every file this plan creates;
on the files it changes, the only lines Prettier would change are ones that already differ on `098fa77`
(`lib/cost/index.js:307`, `server.js:289` and `:1205`, `public/styles.css:5242`, much of `lib/demo.js`): leave those.

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test` (`npm test`; one file:
  `node --test test/<file>.test.js`). Plain browser JS in `public/`: classic `<script>` files loaded by
  `public/index.html` before `app.js`.
- **Pure modules.** `lib/cost/forecast.js` and `lib/cost/anomaly.js` do no I/O and read no clock: `today` and `now`
  are arguments. Days are local `YYYY-MM-DD`, as in the ledger (`lib/cost/days.js`).
- **One global scope.** New top-level names in `public/costview.js` and `public/costcharts.js` start with `cost` or
  `COST`; in `public/monitorsview.js` they start with `mon` or `MON`. No name may repeat one in another page script
  (`test/cost-ui.test.js` "every page script shares one global scope" checks it).
- **Loadable in Node.** Nothing in a browser file touches the DOM, `window`, `document` or `localStorage` at load
  time; each ends with its existing `if (typeof module !== 'undefined') module.exports = { … }` guard, which gains the
  new helpers the tests call.
- **Text only (S1).** Every owner-written or server string into HTML goes through `esc()`: model names, `~` project
  folders, center names, key names and ids, budget names, day titles. Numbers go through our own formatters. CSP stays
  `script-src 'self'`: no inline handlers, no inline scripts. The audit tests in `test/cost-ui.test.js`,
  `test/cost-charts.test.js` and `test/monitors-ui.test.js` keep passing.
- **Drivers never leave the dashboard.** The rule keeps no driver: its results, the state store, the alerts file, the
  desktop notification and the webhook carry the rule, the state change, the value, the threshold, `usual` and the
  day's title only. Drivers reach only `GET /api/cost/view` (behind the dashboard sign-in).
- **Tests.**
  - Never call a real network and never signal a real process. The channels test uses a recording `spawn` and the
    local `fakeServer` of `test/helpers.js`.
  - Spawned servers in this plan take ports from **9400–9599** (`test/cost-forecast-http.test.js`), a range no other
    test uses (8000–8999 and 9000–9399 are taken). A test trusts an answer only after it has seen its own child still
    running (~200 ms after the first answer). Spawned servers run with `NO_JUDGE_PORTS` and the demo.
  - Restore any global a test replaces. (The UI tests only add `esc` and the page helpers to `global`, as the
    existing UI tests do; nothing is replaced.)
- **Housekeeping.**
  - Prettier style (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Run
    `npx prettier@3 --check <changed files>` and fix only the lines you changed; do not reformat unrelated
    pre-existing code (`lib/cost/index.js:307`, `server.js:289` and `:1205`, `public/styles.css:5242` and large parts of
    `lib/demo.js` already differ on main; `*.md` is in `.prettierignore`). Never run `prettier --write` on
    `lib/demo.js`, `server.js` or `public/styles.css`.
  - Short "why" comments, as in `lib/cost/*.js`.
  - Commit messages: plain, imperative. **No `Co-Authored-By`, no "Generated with", no AI attribution of any kind**
    (owner rule).
  - UI copy is English; the strings quoted in the spec are copied verbatim.
  - CI runs on Ubuntu, macOS and Windows.
- **Shared files.** Edits are small and additive and existing tests stay green, except the tests this plan updates on
  purpose (listed in each task): `lib/cost/budgets.js`, `lib/cost/budget-service.js`, `lib/cost/index.js`,
  `lib/cost/views.js`, `lib/cost/api.js`, `lib/monitors/*.js`, `server.js`, `lib/demo.js`, `public/costview.js`,
  `public/costcharts.js`, `public/monitorsview.js`, `public/styles.css`, `docs/cost.md`, `docs/monitors.md`.

## Rules and values

**F1. Model.** `dailyModel(rows, { today, weeks = 4, unread = [] })` over the finished days in
`[today − 7·weeks, today − 1]`. Known days start at the first day that has a row (rows after `today − 1` ignored);
days of a month named in `unread` are unknown; `'folder'` or `'corrections'` in `unread` gives `null`. ≥ 7 known days:
`method: 'weekday'`, `byWeekday[w]` the mean of the known days of weekday `w` (Monday 0), the overall mean where a
weekday has none. 3–6: `method: 'mean'`, every weekday the mean. < 3: `null`. Band: per known day `actual / expected`
(expected 0 skipped); `low`/`high` the 25th/75th percentile (linear interpolation), clamped to `[0, 10]`; 1 and 1 with
fewer than 3 ratios. The model also carries `known` (count) and `days` (the known days, sorted).

**F2. Projection.** `project(model, { today, spentSoFar, todaySoFar, to, planPerDay })` from `today` to `to`. Today:
`cum = spentSoFar + max(0, e − todaySoFar)`, `low`/`high` the same with `e·low` / `e·high`. Each later day adds
`e` (`e·low`, `e·high`) plus `planPerDay(day)` unscaled. `spentSoFar` holds today's plan fee already (the reader bills
it), so `planPerDay` is asked from tomorrow on. Each point rounded to 8 decimals. `project(null, …) = []`.

**F3. Runs out.** The first `day` whose `cum > amount`; equal is not past. `null` for no such day, an empty line or an
amount that is not a positive number.

**F4. Budget forecast.** `history` rows in the budget's scope, plan rows left out, the budget's field (`listUSD` or
`billedUSD`), the days of `historyUnread` unknown. `todaySoFar` = today's usage rows in scope (plan rows left out) of
`rows` and `extra`. Under "Paid", `planPerDay(day)` = Σ `planFee(source, day)` over the sources whose plan rows are in
scope (`inScope(scope, { kind: 'plan', source })`: global, or that source). The line runs to `p.to`.
`forecastUSD` = its last `cum` (8 decimals), `runsOut` = F3 against `amountUSD`, `null` when `exceeded`.
`projected` = `projection && state !== 'exceeded' && fraction ≥ 0.25 && (model ? micro(forecastUSD) > micro(amountUSD)
: spentMicro / fraction > amountMicro)`.

**F5. Overview forecast.** Model from `history` ∪ the month's rows (plan rows left out, the chosen measure), with
`unread`. The USD line (F2, to the month's last day, `planPerDay` = Σ `planFee` over every source under "Paid") is
converted day by day: each point adds `conv(day, Δ)` of its USD step to the converted month total. Without a model:
the old line (the mean of the elapsed days, today counted whole), `low`/`high` null, `early: true`.
`forecast.perDay` = (end − today's point) / days left. `forecastMethod` = `model.method` or `null`.

**A1. A day.** `measureDay(rows, { model, day, partial, history })`: `expectedUSD = byWeekday[weekday(day)]`;
`spentUSD` = Σ `listUSD` of `day`'s usage rows. Drivers only when `spentUSD > expectedUSD`: for `model`, `project`,
`center` (null reads `unassigned`) and `keyId` (null values skipped), a value's spend on `day` minus its mean over the
model's known days of the same weekday (all its known days under `'mean'`, or when that weekday has none; 0 for a value
not seen then). `extraUSD > 0` only; `share = min(1, extra / (spent − expected))` (4 decimals); top 3 by `extraUSD`,
ties by dimension order (`model`, `project`, `center`, `keyId`) then value. Money rounded to 8 decimals.

**A2. Anomaly.** `isAnomaly(m, { ratio, minUSD })` (bad parameters → 2 and 1): `expectedUSD > 0`:
`spent > ratio·expected && spent − expected ≥ minUSD` (each side rounded to 8 decimals); else `spent ≥ minUSD`.

**A3. Recent days.** `recentDays(rows, { today, unread })`: rows of `[today − 29, today]`; `today` (partial) and
`today − 1` (whole), each with `dailyModel(usage, { today: thatDay, unread })`, so a day never lifts its own expected
amount. A day of an unread month is `null`.

**M1. The rule.** Instances `today − 1` then `today` (from `dayOf(now)`), each `result(day, null, state, value,
threshold, title)` plus `usual`: `state` `triggered` | `ok` by A2 with the rule's parameters, `no_data` when the figure
is null, of another day, or not numbers. `value` = `spentUSD`, `threshold` = `ratio × expectedUSD`, `usual` =
`expectedUSD`, each to the cent. Title `Wed 28 Oct (so far)` for today, `Tue 27 Oct` for yesterday. No snapshot: one
`'all'` `no_data`. `ratio` and `minUSD` must be above 0 (`withDefaults`).

**M2. One alert per day.** The rule has `remind: false`: no 30-minute reminder, no re-alert after a `no_data` flap.
When a snooze ends, an alert already sent stays quiet; one held back by the snooze is sent once. A day is ended
(`isEndedSession`) once it is before yesterday: off the cards and the counts, no resolution, pruned by the store a day
after it was last seen (unchanged `PRUNE_MS`).

**U1. Copy.** Caption: "Forecast: weekday pattern of the last 4 weeks", "Forecast: daily mean (little history yet)",
"No forecast yet". Anomaly figures: "$18.40, usually $6.10 (3.0×)" (no ratio when usual is 0); states "Anomaly",
"Normal", "Not enough history"; drivers "claude-opus-5-5 · +$9.20 (75 %)", "Key: Acme client · +$5.10 (41 %)". Ring:
"runs out ~21 Nov". Budget card: "Runs out ~21 Nov at this pace", "Stays under the amount this period (forecast
$412.00)". Bell: "Cost anomaly · Wed 28 Oct (so far): $18.40, usual $6.10", linked to `#cost`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/cost/forecast.js` | create | pure `weekday`, `quantile`, `dailyModel`, `project`, `runsOut` |
| `lib/cost/anomaly.js` | create | pure `anomalyParams`, `measureDay`, `isAnomaly`, `recentDays`; `HISTORY_DAYS` |
| `lib/cost/budgets.js` | modify (shared) | `evaluateBudget` with `history`, `historyUnread`, `planFee`; `forecastUSD`, `runsOut` |
| `lib/cost/budget-service.js` | modify (shared) | the history window, cached; `planFeeFor` passed on |
| `lib/cost/index.js` | modify (shared) | `planFeeFor(source, day)` on the cost object |
| `lib/cost/views.js` | modify (shared) | `overview`: forecast, `forecastMethod`, spikes by `isAnomaly`, `anomalies`, `anomalyParams`, ring `runsOut` |
| `lib/cost/api.js` | modify (shared) | the Overview reads the history and passes plan fees, rule parameters and key names |
| `lib/monitors/rules.js` | modify (shared) | `cost_anomaly` rule and check; `ratio`, `minUSD` positive |
| `lib/monitors/state.js` | modify (shared) | `remind: false`; `usual` on an alert |
| `lib/monitors/index.js` | modify (shared) | `costAnomaly` provider in the aggregate snapshot; a past day has ended |
| `lib/monitors/api.js` | modify (shared) | bounds for `ratio` and `minUSD`; `usual` in `/api/alerts` |
| `server.js` | modify (shared) | the provider for the engine; the rule parameters for the cost API |
| `lib/demo.js` | modify (shared) | the team alert's `projected` from the forecast; yesterday's spike; the rule's demo states and alert |
| `public/costcharts.js` | modify (shared) | the ring caption; "no band yet" in the burn-down tooltip |
| `public/costview.js` | modify (shared) | the caption, the Anomalies card, the spike meta, the Budgets card line |
| `public/monitorsview.js` | modify (shared) | the bell line and link, the rule's parameters and card text |
| `public/styles.css` | modify (shared) | `.cost-anom*`, `.cost-ring-out`, `.cost-card-forecast` (append) |
| `docs/cost.md`, `docs/monitors.md` | modify | the forecast, anomalies, the rule, API fields, demo |
| `test/cost-forecast.test.js` | create | Task 1 |
| `test/cost-anomaly.test.js` | create | Task 2 |
| `test/cost-budgets-forecast.test.js` | create | Task 3 |
| `test/cost-forecast-views.test.js` | create | Task 4 (views and the two routes, in-process) |
| `test/monitors-anomaly.test.js` | create | Task 5 |
| `test/cost-forecast-ui.test.js` | create | Tasks 6–7 |
| `test/cost-forecast-http.test.js` | create | Task 8 (spawned demo server, ports 9400–9599) |
| `test/cost-views.test.js`, `test/cost-charts.test.js` | modify | Tasks 4 and 6: forecast and spike expectations |
| `test/monitors-rules.test.js`, `test/monitors-api.test.js`, `test/budgets-monitors.test.js` | modify | Tasks 5 and 8: the rule list and the demo alert count |

---
### Task 1: `lib/cost/forecast.js` (pure)

**Files:**
- Create: `lib/cost/forecast.js`
- Test: `test/cost-forecast.test.js` (create)

**Interfaces:**
- Consumes: `addDays`, `daysBetween`, `monthOf` (`lib/cost/days.js`).
- Produces (all exported from `lib/cost/forecast.js`):
  - `WEEKS` (4), `MIN_KNOWN` (3), `WEEKDAY_FROM` (7).
  - `weekday(day) → 0..6` (Monday 0).
  - `quantile(sorted, q) → number | null` (moved here from `lib/cost/views.js`, which re-exports it in Task 4).
  - `dailyModel(rows, { today, weeks = 4, unread = [] }) → null | { method: 'weekday' | 'mean', known, byWeekday:
    [7], mean, low, high, days: [YYYY-MM-DD] }` (F1). `rows` are `{ day, usd }`.
  - `project(model, { today, spentSoFar = 0, todaySoFar = 0, to, planPerDay = () => 0 }) → [{ day, cum, low, high }]`
    (F2).
  - `runsOut(line, amount) → 'YYYY-MM-DD' | null` (F3).

- [ ] **Step 1: Write the failing test**

Create `test/cost-forecast.test.js`:

```js
// Cost Control 4a: lib/cost/forecast.js, the forecast every cost figure uses. Pure: rows in, numbers out, no clock.
// October 2026 starts on a Thursday: the 26th is a Monday and the 29th a Thursday.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/cost/forecast');
const { addDays, daysBetween } = require('../lib/cost/days');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} is not ${b}`);
const at = (day, usd) => ({ day, usd });
// Values from `from` on, one row a day.
const series = (from, values) => values.map((v, i) => at(addDays(from, i), v));

test('weekday: Monday is 0 and Sunday 6, whatever the time zone', () => {
  assert.deepEqual(['2026-10-26', '2026-10-28', '2026-11-01', '2026-03-29'].map(F.weekday), [0, 2, 6, 6]);
});

test('dailyModel: a mean per weekday over the 4 weeks of finished days before today', () => {
  // 1-28 October, 4 of each weekday: the Mondays 8, 12, 10 and 10, every other day 1; an older row makes them known.
  const rows = [at('2026-09-01', 50)];
  for (const day of daysBetween('2026-10-01', '2026-10-28'))
    rows.push(at(day, F.weekday(day) === 0 ? { '2026-10-05': 8, '2026-10-12': 12 }[day] || 10 : 1));
  rows.push(at('2026-10-29', 500)); // today is not a finished day
  const m = F.dailyModel(rows, { today: '2026-10-29' });
  assert.equal(m.method, 'weekday');
  assert.equal(m.known, 28);
  assert.deepEqual(m.byWeekday, [10, 1, 1, 1, 1, 1, 1]);
  near(m.mean, 64 / 28);
  assert.deepEqual([m.low, m.high], [1, 1], 'the 25th and 75th percentile day is as expected');
  assert.equal(m.days.length, 28);
  assert.deepEqual([m.days[0], m.days[27]], ['2026-10-01', '2026-10-28']);
  assert.equal(F.dailyModel(rows, { today: '2026-10-29', weeks: 1 }).known, 7, 'weeks sets the window');
});

test('dailyModel: 3 to 6 known days give the plain mean, fewer give no model', () => {
  const m = F.dailyModel(series('2026-10-24', [1, 2, 3, 4, 10]), { today: '2026-10-29' });
  assert.equal(m.method, 'mean');
  assert.equal(m.known, 5);
  assert.equal(m.mean, 4);
  assert.deepEqual(m.byWeekday, [4, 4, 4, 4, 4, 4, 4]);
  // Ratios 0.25, 0.5, 0.75, 1 and 2.5.
  assert.deepEqual([m.low, m.high], [0.5, 1]);
  assert.equal(F.dailyModel(series('2026-10-26', [1, 1, 1]), { today: '2026-10-29' }).method, 'mean');
  assert.equal(F.dailyModel(series('2026-10-27', [5, 5]), { today: '2026-10-29' }), null, 'two known days');
  assert.equal(F.dailyModel([], { today: '2026-10-29' }), null);
  assert.equal(F.dailyModel([at('2026-10-29', 9)], { today: '2026-10-29' }), null, 'a ledger that began today');
});

test('dailyModel: days before the first row are unknown, an empty day inside the span is a zero', () => {
  // Rows on Tuesday the 20th and Sunday the 25th only: 20-28 October are 9 known days, 7 of them zeros.
  const m = F.dailyModel([at('2026-10-20', 5), at('2026-10-25', 3)], { today: '2026-10-29' });
  assert.equal(m.method, 'weekday');
  assert.equal(m.known, 9);
  assert.deepEqual(m.days, daysBetween('2026-10-20', '2026-10-28'));
  near(m.mean, 8 / 9);
  // Tuesdays 20 (5) and 27 (0); Sunday 25 (3); every other weekday has only zeros.
  assert.deepEqual(m.byWeekday, [0, 2.5, 0, 0, 0, 0, 3]);
});

test('dailyModel: a month that did not read is unknown, not zero; a folder or corrections problem gives none', () => {
  const rows = series('2026-09-01', Array(34).fill(1)); // 1 September to 4 October
  const m = F.dailyModel(rows, { today: '2026-10-05', unread: ['2026-09'] });
  assert.equal(m.known, 4, 'only 1-4 October count');
  assert.equal(m.method, 'mean');
  assert.equal(F.dailyModel(rows, { today: '2026-10-05' }).known, 28);
  assert.equal(F.dailyModel(rows, { today: '2026-10-05', unread: ['folder'] }), null);
  assert.equal(F.dailyModel(rows, { today: '2026-10-05', unread: ['corrections'] }), null);
});

test('dailyModel: the band is clamped to 0 and 10, and is 1 with fewer than 3 ratios', () => {
  // Credits can make a day negative. Mean 2: ratios -50, -50, 0.5, 25.5 and 79.
  const wide = F.dailyModel(series('2026-10-24', [-100, -100, 1, 51, 158]), { today: '2026-10-29' });
  assert.deepEqual([wide.low, wide.high], [0, 10]);
  // Nothing expected on any day: no ratio at all.
  const zero = F.dailyModel(series('2026-10-26', [0, 0, 0]), { today: '2026-10-29' });
  assert.deepEqual([zero.mean, zero.low, zero.high], [0, 1, 1]);
});

test('project: today never below what it spent, each later day at its weekday, plan fees exact, band on usage', () => {
  const m = F.dailyModel(series('2026-10-24', [1, 2, 3, 4, 10]), { today: '2026-10-29' }); // 4 a day, band 0.5-1
  const line = F.project(m, { today: '2026-10-29', spentSoFar: 50, todaySoFar: 1, to: '2026-10-31' });
  assert.deepEqual(line, [
    { day: '2026-10-29', cum: 53, low: 51, high: 53 },
    { day: '2026-10-30', cum: 57, low: 53, high: 57 },
    { day: '2026-10-31', cum: 61, low: 55, high: 61 },
  ]);
  const over = F.project(m, { today: '2026-10-29', spentSoFar: 50, todaySoFar: 6, to: '2026-10-29' });
  assert.deepEqual(over, [{ day: '2026-10-29', cum: 50, low: 50, high: 50 }], 'today already passed its forecast');
  const fees = F.project(m, {
    today: '2026-10-29',
    spentSoFar: 50,
    todaySoFar: 1,
    to: '2026-10-31',
    planPerDay: (day) => (day === '2026-10-31' ? 2.5 : 1),
  });
  assert.deepEqual(
    fees.map((p) => [p.cum, p.low, p.high]),
    [
      [53, 51, 53],
      [58, 54, 58],
      [64.5, 58.5, 64.5],
    ],
    "today's fee is in spentSoFar already; each later day adds its own, unscaled",
  );
  assert.deepEqual(F.project(null, { today: '2026-10-29', to: '2026-10-31' }), []);
  assert.deepEqual(F.project(m, { today: '2026-10-29', to: '2026-10-28' }), []);
  const tenths = { byWeekday: Array(7).fill(0.2), low: 1, high: 1 };
  assert.deepEqual(
    F.project(tenths, { today: '2026-10-29', spentSoFar: 0.1, to: '2026-10-31' }).map((p) => p.cum),
    [0.3, 0.5, 0.7],
    'rounded to 8 decimals',
  );
});

test('runsOut: the first day past the amount; equal is not past; amounts that are not positive numbers', () => {
  const line = [
    { day: '2026-10-29', cum: 10 },
    { day: '2026-10-30', cum: 20 },
    { day: '2026-10-31', cum: 30 },
  ];
  assert.equal(F.runsOut(line, 5), '2026-10-29');
  assert.equal(F.runsOut(line, 19.99), '2026-10-30');
  assert.equal(F.runsOut(line, 20), '2026-10-31', 'exactly the amount is not passed');
  assert.equal(F.runsOut(line, 30), null);
  for (const bad of [0, -1, NaN, Infinity, '20', null, undefined])
    assert.equal(F.runsOut(line, bad), null, String(bad));
  assert.equal(F.runsOut([], 5), null);
  assert.equal(F.runsOut(null, 5), null);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-forecast.test.js`
Expected: FAIL: `Error: Cannot find module '../lib/cost/forecast'` (the file does not load).

- [ ] **Step 3: Create `lib/cost/forecast.js`**

```js
// Cost Control, sub-project 4a: the forecast every cost figure uses (the Overview burn-down, a budget's `projected`
// and its "runs out" date). A mean per weekday over the last 4 weeks of finished days; with less history a plain daily
// mean; with too little, no forecast. Pure: no I/O and no clock (`today` is an argument). Days are local YYYY-MM-DD,
// as in the ledger.
const { addDays, daysBetween, monthOf } = require('./days');

const WEEKS = 4;
const MIN_KNOWN = 3; // fewer known days: no forecast (and no anomaly), as the spike rule had
const WEEKDAY_FROM = 7; // known days from which each weekday has its own mean
const MIN_RATIOS = 3; // fewer day ratios: the band is the forecast itself
const BAND_MAX = 10;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;
const clampBand = (v) => Math.min(BAND_MAX, Math.max(0, v));

// Monday is 0, as a budget's week (lib/cost/budgets.js periodBounds). Local noon, so no time zone moves the day.
function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
}

// The q-quantile with linear interpolation between the two nearest values (the spreadsheet PERCENTILE).
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * The spend model of the finished days in [today − 7·weeks, today − 1]. `rows` are { day, usd } of one measure (plan
 * rows left out by the caller), one per row or per day. A day counts only from the first day that has a row: before
 * the ledger began is unknown, not zero, and a day in the known span without a row is a real zero. A day of a month in
 * `unread` is unknown too, so a month that did not read never lowers the forecast; 'folder' or 'corrections' in it
 * means nothing read as it should: no model.
 * Returns null, or { method: 'weekday' | 'mean', known, byWeekday: [Mon..Sun], mean, low, high, days }; `days` are the
 * known days, which the anomaly drivers compare against (lib/cost/anomaly.js).
 */
function dailyModel(rows, { today, weeks = WEEKS, unread = [] } = {}) {
  const skip = new Set(unread || []);
  if (skip.has('folder') || skip.has('corrections')) return null;
  const from = addDays(today, -7 * weeks);
  const to = addDays(today, -1);
  const sums = new Map();
  let first = null;
  for (const r of rows || []) {
    if (!r || typeof r.day !== 'string' || r.day > to) continue;
    if (!first || r.day < first) first = r.day;
    if (r.day >= from) sums.set(r.day, (sums.get(r.day) || 0) + num(r.usd));
  }
  if (!first) return null;
  const days = daysBetween(first > from ? first : from, to).filter((d) => !skip.has(monthOf(d)));
  if (days.length < MIN_KNOWN) return null;
  const value = (d) => sums.get(d) || 0;
  const mean = days.reduce((a, d) => a + value(d), 0) / days.length;
  const method = days.length >= WEEKDAY_FROM ? 'weekday' : 'mean';
  const byWeekday = Array(7).fill(mean);
  if (method === 'weekday') {
    const sum = Array(7).fill(0);
    const n = Array(7).fill(0);
    for (const d of days) {
      sum[weekday(d)] += value(d);
      n[weekday(d)]++;
    }
    for (let w = 0; w < 7; w++) if (n[w]) byWeekday[w] = sum[w] / n[w]; // a weekday with no known day keeps the mean
  }
  // The band: how far a known day falls from what its own model expected, as the 25th and 75th percentile ratio.
  const ratios = [];
  for (const d of days) {
    const e = byWeekday[weekday(d)];
    if (e > 0) ratios.push(value(d) / e);
  }
  ratios.sort((a, b) => a - b);
  const few = ratios.length < MIN_RATIOS;
  return {
    method,
    known: days.length,
    byWeekday,
    mean,
    low: few ? 1 : clampBand(quantile(ratios, 0.25)),
    high: few ? 1 : clampBand(quantile(ratios, 0.75)),
    days,
  };
}

/**
 * The cumulative forecast from `today` to `to`, both included: [{ day, cum, low, high }]. `spentSoFar` is the period's
 * spend up to yesterday plus today so far (today's plan fee included, as the reader bills it), `todaySoFar` today's
 * usage so far. Today never forecasts less than what it spent already; each later day adds its weekday's usage and
 * `planPerDay(day)`, the exact plan fee of that day (the Paid measure only). The band scales the usage only.
 */
function project(model, { today, spentSoFar = 0, todaySoFar = 0, to, planPerDay = () => 0 } = {}) {
  if (!model || !today || !to || to < today) return [];
  let cum = num(spentSoFar);
  let low = cum;
  let high = cum;
  const so = num(todaySoFar);
  const out = [];
  for (const day of daysBetween(today, to)) {
    const e = model.byWeekday[weekday(day)];
    if (day === today) {
      cum += Math.max(0, e - so);
      low += Math.max(0, e * model.low - so);
      high += Math.max(0, e * model.high - so);
    } else {
      const fee = num(planPerDay(day));
      cum += e + fee;
      low += e * model.low + fee;
      high += e * model.high + fee;
    }
    out.push({ day, cum: round8(cum), low: round8(low), high: round8(high) });
  }
  return out;
}

// The first day whose forecast passes `amount` (equal is not passed), or null: none passes, no line, or an amount
// that is not a positive number.
function runsOut(line, amount) {
  if (!(typeof amount === 'number' && Number.isFinite(amount) && amount > 0) || !Array.isArray(line)) return null;
  const hit = line.find((p) => p && p.cum > amount);
  return hit ? hit.day : null;
}

module.exports = { WEEKS, MIN_KNOWN, WEEKDAY_FROM, weekday, quantile, dailyModel, project, runsOut };
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/cost-forecast.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check lib/cost/forecast.js test/cost-forecast.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add lib/cost/forecast.js test/cost-forecast.test.js
git commit -m "Cost forecast: a weekday model of the last 4 weeks, its projection and the day it runs out"
```

---
### Task 2: `lib/cost/anomaly.js` (pure)

**Files:**
- Create: `lib/cost/anomaly.js`
- Test: `test/cost-anomaly.test.js` (create)

**Interfaces:**
- Consumes: Task 1's `weekday`, `dailyModel`; `addDays`, `monthOf` (`lib/cost/days.js`).
- Produces (all exported from `lib/cost/anomaly.js`):
  - `RATIO` (2), `MIN_USD` (1), `HISTORY_DAYS` (29), `DIMS` (`['model', 'project', 'center', 'keyId']`).
  - `anomalyParams(p) → { ratio, minUSD }` (a value that is not a positive number takes its default).
  - `measureDay(rows, { model, day, partial = false, history = [] }) → null | { day, partial, spentUSD, expectedUSD,
    drivers: [{ dim, value, extraUSD, share }] }` (A1).
  - `isAnomaly(m, params) → boolean` (A2).
  - `recentDays(rows, { today, unread = [] }) → { today: <measureDay> | null, yesterday: <measureDay> | null }` (A3).

- [ ] **Step 1: Write the failing test**

Create `test/cost-anomaly.test.js`:

```js
// Cost Control 4a: lib/cost/anomaly.js, a day's usage value against its weekday and the values that rose the most.
// Pure: rows in, figures out, no clock. 28 October 2026 is a Wednesday, the 27th a Tuesday.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/cost/anomaly');
const F = require('../lib/cost/forecast');
const { daysBetween } = require('../lib/cost/days');

const row = (day, over = {}) => ({
  day,
  source: 'claude',
  model: 'claude-sonnet-5-5',
  project: '~/a',
  center: 'platform',
  keyId: null,
  kind: 'chat',
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const gw = (day, over = {}) =>
  row(day, { source: 'gateway', model: 'deepseek-chat', project: null, center: 'client', keyId: 'key_a', ...over });
const plan = (day) => row(day, { kind: 'plan', model: null, project: null, center: null, listUSD: 0, billedUSD: 7 });
// Every day of [from, to]: Sonnet on ~/a (1) and DeepSeek through key_a (1), and a plan fee that is not usage.
const usual = (from, to) => daysBetween(from, to).flatMap((d) => [row(d), gw(d), plan(d)]);
const series = (rows) => rows.filter((r) => r.kind !== 'plan').map((r) => ({ day: r.day, usd: r.listUSD }));
const modelFor = (rows, today) => F.dailyModel(series(rows), { today });
const brief = (m) => m.drivers.map((d) => [d.dim, d.value, d.extraUSD, d.share]);

test('measureDay: spent against the weekday, drivers ranked by their rise with the share capped at 1', () => {
  const history = usual('2026-09-30', '2026-10-27');
  const model = modelFor(history, '2026-10-28');
  // Sonnet is quiet today; Opus on ~/acme-web (client) and a new key bring 8 more.
  const today = [
    gw('2026-10-28'),
    row('2026-10-28', { model: 'claude-opus-5-5', project: '~/acme-web', center: 'client', listUSD: 6 }),
    gw('2026-10-28', { keyId: 'key_b', listUSD: 2 }),
    plan('2026-10-28'),
  ];
  const m = A.measureDay(today, { model, day: '2026-10-28', partial: true, history });
  assert.deepEqual([m.day, m.partial, m.spentUSD, m.expectedUSD], ['2026-10-28', true, 9, 2]);
  // client 9 − 1 = 8 (over the 7 the day rose: capped), Opus 6 and ~/acme-web 6 (a tie: model before project).
  assert.deepEqual(brief(m), [
    ['center', 'client', 8, 1],
    ['model', 'claude-opus-5-5', 6, 0.8571],
    ['project', '~/acme-web', 6, 0.8571],
  ]);
  assert.equal(A.measureDay(today, { model: null, day: '2026-10-28', history }), null, 'no model: no_data');
});

test('measureDay: a key value, ties broken by value, no drivers when the day is not over its amount', () => {
  const history = usual('2026-09-30', '2026-10-27');
  const model = modelFor(history, '2026-10-28');
  const keyed = A.measureDay([gw('2026-10-28', { keyId: 'key_b', listUSD: 5 })], { model, day: '2026-10-28', history });
  assert.equal(keyed.partial, false);
  assert.deepEqual(brief(keyed), [
    ['keyId', 'key_b', 5, 1],
    ['model', 'deepseek-chat', 4, 1],
    ['center', 'client', 4, 1],
  ]);
  const calm = A.measureDay([row('2026-10-28'), gw('2026-10-28')], { model, day: '2026-10-28', history });
  assert.deepEqual([calm.spentUSD, calm.expectedUSD, calm.drivers], [2, 2, []]);
  // Under the plain mean (3 known days of 0.5), two new models tie at 3: by value.
  const young = ['2026-10-25', '2026-10-26', '2026-10-27'].map((d) => row(d, { model: 'old', listUSD: 0.5 }));
  const tie = A.measureDay(
    [
      row('2026-10-28', { model: 'b-model', project: null, center: null, keyId: 'key_z', listUSD: 3 }),
      row('2026-10-28', { model: 'a-model', project: null, center: null, keyId: 'key_y', listUSD: 3 }),
    ],
    { model: modelFor(young, '2026-10-28'), day: '2026-10-28', history: young },
  );
  assert.deepEqual(brief(tie), [
    ['center', 'unassigned', 6, 1],
    ['model', 'a-model', 3, 0.5455],
    ['model', 'b-model', 3, 0.5455],
  ]);
});

test('isAnomaly: over ratio × expected and at least minUSD over it; an expected 0 needs minUSD', () => {
  const m = (spentUSD, expectedUSD) => ({ spentUSD, expectedUSD });
  assert.equal(A.isAnomaly(m(4, 2)), false, 'exactly twice is not over');
  assert.equal(A.isAnomaly(m(4.01, 2)), true);
  assert.equal(A.isAnomaly(m(1.5, 0.5)), true, 'exactly $1 over');
  assert.equal(A.isAnomaly(m(1.49, 0.5)), false, 'three times, but not $1 over');
  assert.equal(A.isAnomaly(m(1, 0)), true);
  assert.equal(A.isAnomaly(m(0.99, 0)), false);
  assert.equal(A.isAnomaly(m(6, 2), { ratio: 3, minUSD: 0.5 }), false);
  assert.equal(A.isAnomaly(m(6.5, 2), { ratio: 3, minUSD: 0.5 }), true);
  assert.equal(A.isAnomaly(m(4.01, 2), { ratio: 0, minUSD: -1 }), true, 'bad parameters take the defaults');
  assert.equal(A.isAnomaly(null), false);
  assert.deepEqual(A.anomalyParams({ ratio: 3 }), { ratio: 3, minUSD: 1 });
  assert.deepEqual(A.anomalyParams({ ratio: '3', minUSD: 0 }), { ratio: 2, minUSD: 1 });
  assert.deepEqual(A.anomalyParams(null), { ratio: 2, minUSD: 1 });
});

test('recentDays: yesterday whole and today so far, each against the 4 weeks before it; plan fees left out', () => {
  const rows = [
    ...usual('2026-09-29', '2026-10-27'),
    row('2026-10-27', { model: 'claude-opus-5-5', project: '~/acme-web', center: 'client', listUSD: 9 }),
    row('2026-10-28'),
    plan('2026-10-28'),
  ];
  const r = A.recentDays(rows, { today: '2026-10-28' });
  assert.deepEqual(
    [r.yesterday.day, r.yesterday.partial, r.yesterday.spentUSD, r.yesterday.expectedUSD],
    ['2026-10-27', false, 11, 2],
  );
  assert.equal(A.isAnomaly(r.yesterday), true);
  assert.deepEqual(brief(r.yesterday), [
    ['model', 'claude-opus-5-5', 9, 1],
    ['project', '~/acme-web', 9, 1],
    ['center', 'client', 9, 1],
  ]);
  // Today's Wednesday model holds the spike of Tuesday the 27th, which is not a Wednesday.
  assert.deepEqual([r.today.day, r.today.partial, r.today.spentUSD, r.today.expectedUSD], ['2026-10-28', true, 1, 2]);
  assert.equal(A.isAnomaly(r.today), false);
  assert.deepEqual(A.recentDays(rows, { today: '2026-10-28', unread: ['2026-10'] }), { today: null, yesterday: null });
  const young = [row('2026-10-27'), row('2026-10-28')];
  assert.deepEqual(A.recentDays(young, { today: '2026-10-28' }), { today: null, yesterday: null });
  assert.equal(A.HISTORY_DAYS, 29);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-anomaly.test.js`
Expected: FAIL: `Error: Cannot find module '../lib/cost/anomaly'`.

- [ ] **Step 3: Create `lib/cost/anomaly.js`**

```js
// Cost Control, sub-project 4a: cost anomalies. A day's usage value (list, plan fees left out: a fee is not usage)
// against what the same weekday usually costs (lib/cost/forecast.js), and the model, project, cost center and key that
// rose the most. Pure: no I/O and no clock. The Monitors rule `cost_anomaly` (lib/monitors/rules.js) and the Overview's
// Anomalies card and spike line (lib/cost/views.js) read the same figures, from recentDays().
const F = require('./forecast');
const { addDays, monthOf } = require('./days');

const RATIO = 2; // the rule's defaults: a day over twice its usual amount...
const MIN_USD = 1; // ...and at least $1 over it, so a quiet week does not make every small day an anomaly
const HISTORY_DAYS = 29; // the 4 weeks before yesterday, and yesterday: what today and yesterday are measured against
const DIMS = ['model', 'project', 'center', 'keyId'];
const TOP = 3;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const usage = (rows) => (rows || []).filter((r) => r && r.kind !== 'plan');
// A row's value on a dimension: a center the rules did not set is Unassigned; a row with no model, project or key
// (a gateway call has no project, a local one no key) is not a value of that dimension.
const valueOf = (r, dim) => (dim === 'center' ? r.center || 'unassigned' : r[dim] == null ? null : String(r[dim]));

// The rule's parameters as the figures use them: a value that is not a positive number takes the default.
function anomalyParams(p) {
  const pos = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return { ratio: pos(p && p.ratio, RATIO), minUSD: pos(p && p.minUSD, MIN_USD) };
}

/**
 * One day against its model: { day, partial, spentUSD, expectedUSD, drivers: [{ dim, value, extraUSD, share }] }, or
 * null without a model (no_data). `rows` are ledger rows (only `day`'s usage rows count); `history` the usage rows the
 * model was built from. `partial` (today): the spend so far against a whole expected day.
 * A driver is a value whose spend on `day` passed its own mean over the model's known days of the same weekday (all of
 * its known days under the plain mean, or when that weekday has none, as the model does); 0 for a value not seen then.
 * The top 3 across the four dimensions by `extraUSD`, ties by dimension order and then value; none when the day is not
 * over its expected amount. `share` is extraUSD / (spentUSD − expectedUSD), at most 1.
 */
function measureDay(rows, { model, day, partial = false, history = [] } = {}) {
  if (!model) return null;
  const w = F.weekday(day);
  const expected = num(model.byWeekday[w]);
  const own = usage(rows).filter((r) => r.day === day);
  const spent = own.reduce((a, r) => a + num(r.listUSD), 0);
  const over = spent - expected;
  let drivers = [];
  if (over > 0) {
    const known = Array.isArray(model.days) ? model.days : [];
    const same = model.method === 'weekday' ? known.filter((d) => F.weekday(d) === w) : [];
    const base = new Set(same.length ? same : known);
    const past = usage(history).filter((r) => base.has(r.day));
    const found = [];
    for (const dim of DIMS) {
      const now = new Map();
      const before = new Map();
      for (const r of own) {
        const v = valueOf(r, dim);
        if (v !== null) now.set(v, (now.get(v) || 0) + num(r.listUSD));
      }
      for (const r of past) {
        const v = valueOf(r, dim);
        if (v !== null && now.has(v)) before.set(v, (before.get(v) || 0) + num(r.listUSD));
      }
      for (const [value, spend] of now) {
        const extra = spend - (base.size ? (before.get(value) || 0) / base.size : 0);
        if (round8(extra) > 0)
          found.push({ dim, value, extraUSD: round8(extra), share: Math.round(Math.min(1, extra / over) * 1e4) / 1e4 });
      }
    }
    found.sort((a, b) => b.extraUSD - a.extraUSD || DIMS.indexOf(a.dim) - DIMS.indexOf(b.dim) || cmp(a.value, b.value));
    drivers = found.slice(0, TOP);
  }
  return { day, partial: !!partial, spentUSD: round8(spent), expectedUSD: round8(expected), drivers };
}

// Over `ratio` times its expected amount and at least `minUSD` over it. A day expected to cost nothing is an anomaly
// once it spends `minUSD`.
function isAnomaly(m, params) {
  if (!m) return false;
  const { ratio, minUSD } = anomalyParams(params);
  const spent = num(m.spentUSD);
  const expected = num(m.expectedUSD);
  if (!(expected > 0)) return spent >= minUSD;
  return spent > round8(ratio * expected) && round8(spent - expected) >= minUSD;
}

/**
 * Today so far and the whole of yesterday, each against the model of the 4 weeks before it (so a day never raises its
 * own expectation): { today, yesterday }, each a measureDay result or null. `rows` are the ledger rows of
 * [today − 29, today] (plan rows are left out here), `unread` what that read skipped: a day of a month that did not
 * read is null.
 */
function recentDays(rows, { today, unread = [] } = {}) {
  const use = usage(rows);
  const series = use.map((r) => ({ day: r.day, usd: num(r.listUSD) }));
  const skip = new Set(unread || []);
  const one = (day, partial) => {
    if (skip.has(monthOf(day))) return null;
    const model = F.dailyModel(series, { today: day, unread });
    return measureDay(use, { model, day, partial, history: use });
  };
  return { today: one(today, true), yesterday: one(addDays(today, -1), false) };
}

module.exports = { RATIO, MIN_USD, HISTORY_DAYS, DIMS, anomalyParams, measureDay, isAnomaly, recentDays };
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/cost-anomaly.test.js test/cost-forecast.test.js`
Expected: PASS, 12 tests (4 new).

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check lib/cost/anomaly.js test/cost-anomaly.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add lib/cost/anomaly.js test/cost-anomaly.test.js
git commit -m "Cost anomalies: a day against its weekday, its top drivers, and today and yesterday together"
```

---
### Task 3: A budget's forecast (shared: `lib/cost/budgets.js`, `lib/cost/budget-service.js`, `lib/cost/index.js`, `lib/demo.js`)

**Files:**
- Modify: `lib/cost/budgets.js:7` (a require), `:214-225` (`noDataView`), `:233-276` (`evaluateBudget` and its comment)
- Modify: `lib/cost/budget-service.js:25` (a require), `:33` (a constant), `:221-240` (`evaluateOne`)
- Modify: `lib/cost/index.js:16` (a require), `:823-826` (the returned object: one method after `billingFor`)
- Modify: `lib/demo.js:1332` (the team alert's `projected`), `:1526-1535` (`demoTeamSpan`, plus a new function),
  `:1645` (a comment)
- Test: `test/cost-budgets-forecast.test.js` (create)

**Interfaces:**
- Consumes: Task 1's `dailyModel`, `project`, `runsOut`; `planFee(billing, day)` (`lib/cost/rules.js`);
  `billing.billingFor` (`lib/cost/index.js`); `inScope`, `micro`, `usd` (`lib/cost/budgets.js`).
- Produces:
  - `evaluateBudget(b, { rows, extra, unread, billingError, currency, now, history = null, historyUnread = [],
    planFee = null })`: the view gains `forecastUSD: number | null` and `runsOut: 'YYYY-MM-DD' | null`; `projected`
    follows F4. `noDataView` gives both as `null`. `history` null: no model.
  - `cost.planFeeFor(source, day) → number` (USD; 0 while metered or assumed), on the object `createCost` returns.
  - The budget service reads `cost.budgetRows({ from: today − 28, to: today − 1 })` through its window cache
    (`rowsFor`, counted in `MAX_WINDOWS`); a read that throws gives `history: null`.
  - `lib/demo.js` `demoTeamProjected(now) → boolean` (module-private): the team budget's `projected` as the budget
    service evaluates it; `demoTeamSpan(now)` now returns the span alone (no `projected`).

- [ ] **Step 1: Write the failing test**

Create `test/cost-budgets-forecast.test.js`:

```js
// Cost Control 4a: a budget's forecast (lib/cost/budgets.js evaluateBudget) and the history the budget service reads
// for it (lib/cost/budget-service.js). Thursday 22 October 2026, 15:00: about 70 % of the month has passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/cost/budgets');
const { createBudgetService } = require('../lib/cost/budget-service');
const { daysBetween } = require('../lib/cost/days');
const F = require('../lib/cost/forecast');

const NOW = new Date(2026, 9, 22, 15).getTime();
const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  model: 'deepseek-chat',
  center: 'acme',
  keyId: 'key_a',
  kind: 'chat',
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
// Weekdays cost 1 and weekends 10, from 24 September (the 4 weeks before today) to yesterday; today 0.5 so far.
const weekly = (d) => (F.weekday(d) >= 5 ? 10 : 1);
const ROWS = [
  ...daysBetween('2026-09-24', '2026-10-21').map((d) => row(d, { listUSD: weekly(d), billedUSD: weekly(d) })),
  row('2026-10-22', { listUSD: 0.5, billedUSD: 0.5 }),
];
const budget = (over = {}) => ({
  id: 'team',
  name: 'Team',
  scope: 'global',
  period: 'month',
  amount: 110,
  currency: 'USD',
  measure: 'list',
  thresholds: [50, 80],
  projection: true,
  enforce: 'none',
  legacy: null,
  ...over,
});
const evalAt = (b, extra = {}) => B.evaluateBudget(b, { rows: ROWS, history: ROWS, now: NOW, ...extra });

test('projected follows the forecast: the weekends to come pass the amount the linear pace does not', () => {
  // October so far: 6 weekend days (60) and 15 weekdays (15), then 0.5 today = 75.5. Today is forecast at 1, and the
  // 9 days left hold 3 weekend days and 6 weekdays: 76 + 36 = 112. The linear pace says 75.5 / 0.7 ≈ 108.
  const v = evalAt(budget());
  assert.deepEqual(
    [v.state, v.spentUSD, v.forecastUSD, v.projected, v.runsOut],
    ['warn_50', 75.5, 112, true, '2026-10-31'],
  );
  assert.equal(evalAt(budget({ projection: false })).projected, false, 'projection off');
  const under = evalAt(budget({ amount: 120 }));
  assert.deepEqual([under.forecastUSD, under.projected, under.runsOut], [112, false, null], 'stays under');
  // 28 October ends at 100, which is not past 100; the 29th is.
  assert.equal(evalAt(budget({ amount: 100 })).runsOut, '2026-10-29');
  const used = evalAt(budget({ amount: 70 }));
  assert.deepEqual([used.state, used.forecastUSD, used.runsOut, used.projected], ['exceeded', 112, null, false]);
});

test('without a model the linear pace decides, and neither forecast field is set', () => {
  for (const history of [null, [row('2026-10-20'), row('2026-10-21')]]) {
    const v = B.evaluateBudget(budget(), { rows: ROWS, history, now: NOW });
    assert.deepEqual([v.projected, v.forecastUSD, v.runsOut], [false, null, null]);
    assert.equal(B.evaluateBudget(budget({ amount: 105 }), { rows: ROWS, history, now: NOW }).projected, true);
  }
});

test('a week forecasts to its Sunday: a date after the period is no runs-out date', () => {
  // Monday 19 to Thursday 22: 3.5 so far, then 4 today, 5 on Friday, 15 and 25 over the weekend.
  const v = evalAt(budget({ period: 'week', amount: 30 }));
  assert.deepEqual([v.from, v.to, v.spentUSD, v.forecastUSD, v.runsOut], ['2026-10-19', '2026-10-25', 3.5, 25, null]);
  assert.equal(evalAt(budget({ period: 'week', amount: 14 })).runsOut, '2026-10-24');
});

test('a day budget forecasts today only', () => {
  const v = evalAt(budget({ period: 'day', amount: 0.8 }));
  assert.deepEqual(
    [v.state, v.spentUSD, v.forecastUSD, v.runsOut, v.projected],
    ['warn_50', 0.5, 1, '2026-10-22', true],
  );
});

test('scope and measure: the history in scope only; under Paid each day to come adds the plan fees in scope', () => {
  // Every day: Claude Code on a plan (a plan row of 3, its usage billed 0) and 1 of gateway usage.
  const days = daysBetween('2026-09-24', '2026-10-22');
  const rows = days.flatMap((d) => [
    row(d),
    row(d, { source: 'claude', model: 'claude-opus-5-5', keyId: null, listUSD: 5, billedUSD: 0 }),
    { ...row(d, { source: 'claude', model: null, center: null, keyId: null, kind: 'plan' }), listUSD: 0, billedUSD: 3 },
  ]);
  const asked = [];
  const planFee = (source, day) => {
    asked.push(`${source} ${day}`);
    return source === 'claude' ? 3 : 0;
  };
  const paid = (over) =>
    B.evaluateBudget(budget({ measure: 'billed', amount: 1000, ...over }), { rows, history: rows, now: NOW, planFee });
  // Paid so far 22 × (3 + 1) = 88; today's usage (1) is as expected; 9 days to come × (1 + 3).
  assert.deepEqual([paid().spentUSD, paid().forecastUSD], [88, 124]);
  assert.ok(asked.includes('claude 2026-10-23') && asked.includes('claude 2026-10-31'));
  assert.ok(!asked.some((a) => a.endsWith('2026-10-22')), "today's fee is in what was paid already");
  assert.equal(paid({ scope: { dim: 'source', value: 'gateway' } }).forecastUSD, 31, 'another source: no fee');
  assert.equal(paid({ scope: { dim: 'key', value: 'key_a' } }).forecastUSD, 31, 'a key has no plan rows');
  const list = B.evaluateBudget(budget({ amount: 1000 }), { rows, history: rows, now: NOW, planFee });
  assert.equal(list.forecastUSD, 22 * 6 + 9 * 6, 'usage value: every usage row, no fee');
  // A month of the history that did not read is unknown: the forecast rests on October alone.
  const v = B.evaluateBudget(budget(), { rows: ROWS, history: ROWS, historyUnread: ['2026-09'], now: NOW });
  assert.equal(v.forecastUSD, 112, 'the same weekday means from 1-21 October');
});

test('a view without data has both forecast fields, null', () => {
  const v = evalAt(budget({ currency: 'IDR' }));
  assert.equal(v.state, 'no_data');
  assert.deepEqual([v.forecastUSD, v.runsOut], [null, null]);
});

test('the budget service reads the history window once a day, cached as a period; a failed read leaves no forecast', () => {
  const calls = [];
  let failHistory = false;
  const cost = {
    budgetRows: ({ from, to }) => {
      calls.push(`${from}|${to}`);
      if (failHistory && to === '2026-10-21') throw new Error('unreadable');
      return { rows: ROWS, unread: [], billingError: null };
    },
    planFeeFor: () => 0,
  };
  const make = () =>
    createBudgetService({
      getSettings: () => ({ budgets: [budget()] }),
      cost,
      now: () => NOW,
      nocase: false,
    });
  const s = make();
  const v = s.evaluate().find((x) => x.id === 'team');
  assert.deepEqual([v.forecastUSD, v.runsOut, v.projected], [112, '2026-10-31', true]);
  assert.deepEqual(calls.sort(), ['2026-09-24|2026-10-21', '2026-10-01|2026-10-31']);
  s.evaluate();
  assert.equal(calls.length, 2, 'both windows cached until a pass or a change');
  s.invalidate();
  failHistory = true;
  const w = s.evaluate().find((x) => x.id === 'team');
  assert.deepEqual([w.spentUSD, w.forecastUSD, w.runsOut, w.projected], [75.5, null, null, false]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-budgets-forecast.test.js`
Expected: FAIL, 7 tests: `forecastUSD` and `runsOut` are `undefined`, and `projected` still follows the linear pace.

- [ ] **Step 3: `lib/cost/budgets.js`**

After `const { SOURCES, UNASSIGNED, normalizeGlob, rateFor } = require('./rules');` (`:7`), add:

```js
const F = require('./forecast');
```

In `noDataView` (`:214-225`), between `percent: null,` and `reason,`, add:

```js
    forecastUSD: null,
    runsOut: null,
```

Replace the comment and the whole of `evaluateBudget` (`:233-276`, from `// \`rows\` are the ledger rows` to the
closing `}` before `// The old settings as budgets.`) with:

```js
// `rows` are the ledger rows (cost.budgetRows), `extra` the gateway calls the ledger has not read yet; both are
// filtered to the period here. `currency` is the display currency with its rates. The forecast (lib/cost/forecast.js)
// is built from `history`, the ledger rows of the 28 days before today (null when they did not read), in this budget's
// scope and measure with plan rows left out, and the days of `historyUnread` months unknown; under "Paid", each day to
// come adds `planFee(source, day)` for the sources in scope. It sets `projected` (from a quarter of the period, the
// forecast at the period's end above the amount; without a model, the linear pace spent / fraction), `forecastUSD`
// and `runsOut`, the day it passes the amount (null once exceeded, or when it stays under within the period).
function evaluateBudget(
  b,
  {
    rows = [],
    extra = [],
    unread = [],
    billingError = null,
    currency = null,
    now,
    history = null,
    historyUnread = [],
    planFee = null,
  } = {},
) {
  const p = periodBounds(b.period, now);
  let rate = 1;
  if (b.currency !== 'USD') {
    if (!currency || currency.code !== b.currency)
      return noDataView(b, p, `no rates for ${b.currency}; set them in the cost settings`);
    rate = rateFor(currency, dayOf(now));
    if (rate == null) return noDataView(b, p, `no ${b.currency} rate on or before today`);
  }
  const missing = missingFor(unread, p.from, p.to);
  if (missing.length) return noDataView(b, p, `the ledger could not read ${missing.join(', ')}`);
  if (b.measure === 'billed' && billingError) return noDataView(b, p, 'the billing history could not be read');
  const field = b.measure === 'billed' ? 'billedUSD' : 'listUSD';
  const today = dayOf(now);
  let spentUSD = 0;
  let todayUSD = 0; // today's usage so far, plan fee left out: what today's forecast must not fall under
  for (const list of [rows, extra])
    for (const r of list) {
      if (!r || r.day < p.from || r.day > p.to || !inScope(b.scope, r)) continue;
      if (b.measure === 'list' && r.kind === 'plan') continue;
      // What was paid on such a day is not known: billed as metered until a restate says otherwise.
      if (b.measure === 'billed' && r.billingAssumed)
        return noDataView(b, p, 'the billing history was lost for part of this period');
      const v = isNum(r[field]) ? r[field] : 0;
      spentUSD += v;
      if (r.day === today && r.kind !== 'plan') todayUSD += v;
    }
  const amountUSD = b.amount / rate;
  const spentMicro = micro(spentUSD);
  const amountMicro = micro(amountUSD);
  // One division of whole numbers, so the percent the view shows and the state always agree.
  const percent = amountMicro > 0 ? (spentMicro * 100) / amountMicro : Infinity;
  const state = stateOf(percent, b.thresholds);
  const series = (history || [])
    .filter((r) => r && r.kind !== 'plan' && inScope(b.scope, r))
    .map((r) => ({ day: r.day, usd: isNum(r[field]) ? r[field] : 0 }));
  const model = history ? F.dailyModel(series, { today, unread: historyUnread }) : null;
  // The plan fees of a day to come, for the sources this budget counts plan rows of (global, or a source scope).
  const fees =
    b.measure === 'billed' && typeof planFee === 'function'
      ? SOURCES.filter((s) => inScope(b.scope, { kind: 'plan', source: s }))
      : [];
  const planPerDay = (day) =>
    fees.reduce((a, s) => {
      const fee = planFee(s, day);
      return a + (isNum(fee) ? fee : 0);
    }, 0);
  const line = F.project(model, { today, spentSoFar: spentUSD, todaySoFar: todayUSD, to: p.to, planPerDay });
  const forecastUSD = line.length ? line[line.length - 1].cum : null;
  const passes = forecastUSD != null ? micro(forecastUSD) > amountMicro : spentMicro / p.fraction > amountMicro;
  const projected = b.projection && state !== 'exceeded' && p.fraction >= PROJECTION_FROM && passes;
  return {
    ...viewBase(b, p),
    state,
    projected,
    spent: shown(spentUSD * rate),
    spentUSD: usd(spentUSD),
    amountUSD: usd(amountUSD),
    percent: Number.isFinite(percent) ? pct(percent) : null,
    forecastUSD: forecastUSD == null ? null : usd(forecastUSD),
    runsOut: state === 'exceeded' ? null : F.runsOut(line, amountUSD),
    reason: null,
  };
}
```

- [ ] **Step 4: `lib/cost/budget-service.js`**

`:25` becomes `const { dayOf, addDays } = require('./days');`. Replace `:33` with:

```js
const MAX_WINDOWS = 24; // cached ledger reads: three periods and the forecast's history a day, a few days
const HISTORY_DAYS = 28; // the forecast's history (lib/cost/forecast.js): the 4 weeks before today
```

In `evaluateOne` (`:221-240`), replace from `return B.evaluateBudget(b, {` to the end of the function with:

```js
    // The forecast's history, cached like a period: one read a day for every budget. A read that fails leaves the
    // budget without a forecast (the linear pace decides `projected`), never without its figures.
    const today = dayOf(t);
    let h = null;
    try {
      h = rowsFor(addDays(today, -HISTORY_DAYS), addDays(today, -1), t);
    } catch {
      h = null;
    }
    return B.evaluateBudget(b, {
      rows: w.rows,
      extra: pending.map((x) => x.row),
      unread: w.unread,
      billingError: w.billingError,
      currency: good.currency,
      now: t,
      history: h ? h.rows : null,
      historyUnread: h ? h.unread : [],
      planFee: cost && typeof cost.planFeeFor === 'function' ? cost.planFeeFor : null,
    });
  }
```

- [ ] **Step 5: `lib/cost/index.js`**

`:16` becomes `const { SOURCES, settingsOf, compile, rateFor, planFee } = require('./rules');`. In the returned object,
after the `billingFor` method (`:823-826`, the last entry), add:

```js
    // A source's plan fee for one day in USD, as budgetRows bills it (0 while metered): what the forecast adds for each
    // day to come under "Paid" (lib/cost/forecast.js). A day to come takes the billing in force now.
    planFeeFor: (source, day) => {
      const b = billing.billingFor(source, day);
      return b && b.mode === 'plan' ? planFee(b, day) : 0;
    },
```

- [ ] **Step 6: `lib/demo.js`: the team alert follows the forecast**

The demo team budget is at 84.2 % of its amount. Its alert in `monitorsDemo` said `projected` whenever a span 25–84 %
through was found, which matched the linear pace; the forecast decides it now (a day span, for one, never projects:
the demo's today is a whole day already). `test/budgets-demo-ui.test.js` "the demo team alert agrees with the team
budget" fails without this step.

Replace the comment and `demoTeamSpan` (`:1526-1535`) with:

```js
// The demo `team` budget's period, shared by costDemo (the budget) and monitorsDemo (its alert) so the two agree: the
// first of month, week or day that is 25–84 % through (projections start at 25 %, and at 84.2 % used a span past
// 84.2 % would not project over), else the month. About 6.8 % of hours have no such span (late on a Sunday early in a
// month, the small hours near a month's end).
function demoTeamSpan(now) {
  const { periodBounds } = require('./cost/budgets');
  const fits = (b) => b.fraction >= 0.25 && b.fraction <= 0.84;
  return ['month', 'week', 'day'].map((p) => periodBounds(p, now)).find(fits) || periodBounds('month', now);
}
// Whether the demo `team` budget is projected over at `now`. The forecast decides that (lib/cost/forecast.js), from
// the demo ledger's weekdays, so the alert in monitorsDemo takes it from the same evaluation the Budgets page shows.
function demoTeamProjected(now) {
  const { createCost } = require('./cost');
  const { createBudgetService } = require('./cost/budget-service');
  const d = costDemo(now);
  const cost = createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => now, nocase: false });
  const svc = createBudgetService({ getSettings: () => d.settings, cost, home: HOME, now: () => now, nocase: false });
  const team = svc.evaluate().find((b) => b.id === 'team');
  return !!team && team.projected === true;
}
```

At `:1332`, `projected: demoTeamSpan(now).projected,` becomes `projected: demoTeamProjected(now),`. At `:1645`,
`// projected over it when demoTeamSpan finds a span, and the research week on what was paid without data (the`
becomes `// projected over it when its forecast passes the amount, and the research week on what was paid without data (the`.

- [ ] **Step 7: Run the tests and see them pass**

Run: `node --test test/cost-budgets-forecast.test.js test/cost-budgets.test.js test/cost-budget-service.test.js test/cost-budgets-api.test.js test/budgets-demo-ui.test.js test/budgets-engine.test.js test/budgets-monitors.test.js test/budgets-http.test.js`
Expected: PASS (7 new tests; the existing budget tests unchanged: without `history` the linear pace decides, as before).

- [ ] **Step 8: Check the style**

Run: `npx prettier@3 --check lib/cost/budgets.js lib/cost/budget-service.js test/cost-budgets-forecast.test.js`
Expected: `All matched files use Prettier code style!` (`lib/cost/index.js` and `lib/demo.js` differ on main already:
check that `git diff -U0` shows only your lines and that none passes 120 columns.)

- [ ] **Step 9: Commit**

```bash
git add lib/cost/budgets.js lib/cost/budget-service.js lib/cost/index.js lib/demo.js test/cost-budgets-forecast.test.js
git commit -m "Budgets: projected and the runs-out date from the forecast, with plan fees under Paid"
```

---
### Task 4: The Overview's forecast, spikes and anomalies, and the view route (shared: `lib/cost/views.js`, `lib/cost/api.js`)

**Files:**
- Modify: `lib/cost/views.js:7-15` (requires and constants), `:50-57` (`quantile`), `:111-242` (`overview` and its
  comment), `:611-613` (exports)
- Modify: `lib/cost/api.js:10` (a require), `:50` (an option), `:174-188` (the Overview branch of `view`)
- Modify: `test/cost-views.test.js:54-78`, `:123-145`, `:162`; `test/cost-charts.test.js:59`, `:66-81`, `:83-96`,
  `:109-122` (the old 7-day baseline, `before` and the mean-day forecast are gone)
- Test: `test/cost-forecast-views.test.js` (create)

**Interfaces:**
- Consumes: Tasks 1–3 (`F.dailyModel`, `F.project`, `F.weekday`, `F.quantile`; `A.anomalyParams`, `A.isAnomaly`,
  `A.recentDays`, `A.HISTORY_DAYS`; the budget views' `runsOut`; `cost.planFeeFor`); `SOURCES` (`lib/cost/rules.js`);
  `keys()` (`lib/cost/api.js`).
- Produces:
  - `views.overview({ rows, history = [], unread = [], today, budgets, rateOf, measure, currency, display, planFee =
    null, anomalyParams = null, keyNames = new Map() })`. `history` replaces `before`: the rows of the 29 days before
    the 1st, `null` when they did not read. The answer keeps its shape and gains:
    - `forecast` from F5 (`early` is true without a model; `perDay` the mean of a day after today);
    - `forecastMethod: 'weekday' | 'mean' | null`;
    - `spikes[i].spike` = `isAnomaly` of that day's usage value against its weekday's usual amount (the model of the
      28 days before it), `spikes[i].baseline` = that usual amount (null without a model), in the chosen currency;
      spikes and their top model use the usage value whatever the measure;
    - `anomalies: { today, yesterday } | null`: each `measureDay` result plus `anomaly: boolean`, each driver plus
      `label` (the key's name for a `keyId`, else the value), or `null`;
    - `anomalyParams: { ratio, minUSD }` (the passed ones, or the defaults);
    - `rings[i].runsOut: 'YYYY-MM-DD' | null`.
  - `views.SPIKE_RATIO`, `SPIKE_MIN_USD` and `BASELINE_MIN` are no longer exported (no other file reads them;
    `test/cost-views.test.js:162` is updated).
  - `createCostApi({ …, anomalyParams = () => null })`: `GET /api/cost/view?page=overview` reads
    `cost.budgetRows({ from: from − 29, to: from − 1 })` quietly (a throw gives `history: null`), adds its `unread` to
    the answer's, and passes `unread`, `planFee: cost.planFeeFor`, `anomalyParams()` (quietly) and `keyNames` from
    `keys()`.

- [ ] **Step 1: Write the failing test**

Create `test/cost-forecast-views.test.js`:

```js
// Cost Control 4a: the Overview with the forecast and the anomalies (lib/cost/views.js overview) and what
// GET /api/cost/view and GET /api/cost/budgets answer with them (lib/cost/api.js), in-process with fake readers.
// Thursday 22 October 2026: the 21st is a Wednesday, the weekend days are Saturdays and Sundays.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/cost/views');
const A = require('../lib/cost/anomaly');
const F = require('../lib/cost/forecast');
const { createCostApi } = require('../lib/cost/api');
const { createBudgetService } = require('../lib/cost/budget-service');
const { daysBetween } = require('../lib/cost/days');

const NOW = new Date(2026, 9, 22, 15).getTime();
const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  provider: 'openrouter',
  model: 'deepseek-chat',
  project: null,
  center: 'client',
  keyId: 'key_a',
  kind: 'chat',
  requests: 1,
  tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const weekly = (d) => (F.weekday(d) >= 5 ? 10 : 1);
// Weekdays 1 and weekend days 10 from 2 September (29 days before the 1st) to yesterday; 0.5 today so far.
const PATTERN = [
  ...daysBetween('2026-09-02', '2026-10-21').map((d) => row(d, { listUSD: weekly(d), billedUSD: weekly(d) })),
  row('2026-10-22', { listUSD: 0.5, billedUSD: 0.5 }),
];
const split = (rows) => ({
  history: rows.filter((r) => r.day < '2026-10-01'),
  rows: rows.filter((r) => r.day >= '2026-10-01'),
});

test('overview: the burn-down follows the weekday model; the method is named; currency converts day by day', () => {
  const o = V.overview({ ...split(PATTERN), today: '2026-10-22' });
  assert.equal(o.forecastMethod, 'weekday');
  assert.equal(o.total, 75.5);
  // Today is forecast at 1, then 3 weekend days and 6 weekdays: 76 + 36. Every day was as expected: no spread.
  assert.deepEqual(o.forecast.line[0], { day: '2026-10-22', cum: 76, low: 76, high: 76 });
  assert.deepEqual(o.forecast.line[2], { day: '2026-10-24', cum: 87, low: 87, high: 87 }, 'a Saturday');
  assert.deepEqual(
    [o.forecast.projected, o.forecast.low, o.forecast.high, o.forecast.early, o.forecast.perDay],
    [112, 112, 112, false, 4],
  );
  const idr = V.overview({ ...split(PATTERN), today: '2026-10-22', rateOf: () => 10, currency: 'IDR' });
  assert.equal(idr.forecast.projected, 1120);
  // A month of the history that did not read is unknown: the model rests on October, the same weekday means here.
  const unread = V.overview({ ...split(PATTERN), today: '2026-10-22', unread: ['2026-09'] });
  assert.deepEqual([unread.forecastMethod, unread.forecast.projected], ['weekday', 112]);
});

test('overview: the plain mean with little history, the old line without a model, nothing without a history', () => {
  const five = [1, 2, 3, 4, 10].map((v, i) => row(`2026-10-0${i + 1}`, { listUSD: v, billedUSD: v / 2 }));
  const m = V.overview({ rows: five, today: '2026-10-05' });
  // Four known days, mean 2.5, day ratios 0.4 to 1.6 (band 0.7 to 1.3); today's 10 is past its 2.5 already.
  assert.equal(m.forecastMethod, 'mean');
  assert.deepEqual([m.forecast.perDay, m.forecast.projected, m.forecast.low, m.forecast.high], [2.5, 85, 65.5, 104.5]);
  const young = V.overview({ rows: five.slice(0, 2), today: '2026-10-02' });
  assert.deepEqual([young.forecastMethod, young.forecast.early, young.forecast.projected], [null, true, 46.5]);
  assert.ok(young.forecast.line.every((p) => p.low === null && p.high === null));
  const lost = V.overview({ rows: split(PATTERN).rows, history: null, today: '2026-10-22' });
  assert.deepEqual([lost.forecastMethod, lost.anomalies, lost.forecast.early], [null, null, true]);
  assert.ok(lost.spikes.every((s) => s.baseline === null && !s.spike));
});

test('overview: under Paid each day to come adds the plan fees; today’s is in the spend already', () => {
  const rows = [
    ...daysBetween('2026-10-01', '2026-10-05').map((d) => row(d, { listUSD: 2, billedUSD: 1 })),
    ...daysBetween('2026-10-01', '2026-10-05').map((d) => ({
      ...row(d, { source: 'claude', provider: null, model: null, center: null, keyId: null, kind: 'plan' }),
      listUSD: 0,
      billedUSD: 3,
    })),
  ];
  const asked = new Set();
  const planFee = (source, day) => {
    asked.add(day);
    return source === 'claude' ? 3 : 0;
  };
  const o = V.overview({ rows, today: '2026-10-05', measure: 'billed', planFee });
  // Paid 5 × 4 = 20; today's usage (1) is as expected; 26 days × (1 + 3).
  assert.deepEqual([o.total, o.forecast.projected], [20, 124]);
  assert.ok(!asked.has('2026-10-05') && asked.has('2026-10-31'));
  assert.equal(V.overview({ rows, today: '2026-10-05', planFee }).forecast.projected, 62, 'usage value: no fee');
});

test('overview: a spike is isAnomaly with the passed parameters, against its weekday in the 4 weeks before it', () => {
  const history = daysBetween('2026-09-02', '2026-09-30').map((d) => row(d, { listUSD: 0.2 }));
  const rows = [
    row('2026-10-01', { listUSD: 0.5 }), // 2.5 × its usual 0.2, but only $0.30 over it
    row('2026-10-02', { listUSD: 1, model: 'claude-opus-5-5' }),
    row('2026-10-02', { listUSD: 2, model: 'claude-sonnet-5-5' }),
    row('2026-10-03', { listUSD: 1 }),
  ];
  const at = (anomalyParams) =>
    V.overview({ rows, history, today: '2026-10-03', rateOf: () => 10, currency: 'XYZ', anomalyParams });
  const o = at(null);
  assert.deepEqual(
    o.spikes.map((s) => [s.day, s.spike, s.baseline]),
    [
      ['2026-10-01', false, 2],
      ['2026-10-02', true, 2],
      ['2026-10-03', false, 2],
    ],
    'the baseline is the usual amount, in the chosen currency',
  );
  assert.deepEqual([o.spikes[1].spend, o.spikes[1].topModel], [30, 'claude-sonnet-5-5']);
  assert.deepEqual(o.anomalyParams, { ratio: 2, minUSD: 1 });
  const keen = at({ ratio: 2, minUSD: 0.25 });
  assert.deepEqual(
    keen.spikes.map((s) => s.spike),
    [true, true, true],
  );
  assert.deepEqual(keen.anomalyParams, { ratio: 2, minUSD: 0.25 });
  assert.deepEqual(
    at({ ratio: 20 }).spikes.map((s) => s.spike),
    [false, false, false],
  );
  assert.deepEqual(at({ ratio: -1, minUSD: 'x' }).anomalyParams, { ratio: 2, minUSD: 1 });
  for (const p of [null, { ratio: 2, minUSD: 0.25 }, { ratio: 20 }])
    for (const s of at(p).spikes)
      assert.equal(s.spike, A.isAnomaly({ spentUSD: s.spend / 10, expectedUSD: s.baseline / 10 }, p), s.day);
});

test('overview: anomalies for today and yesterday, drivers labelled with the key name', () => {
  // Every day Sonnet on ~/a (1) and DeepSeek through key_a (1); on Wednesday the 21st a new key spends 6 more.
  const base = daysBetween('2026-09-02', '2026-10-21').flatMap((d) => [
    row(d, { source: 'claude', model: 'claude-sonnet-5-5', project: '~/a', center: 'platform', keyId: null }),
    row(d),
  ]);
  const all = [
    ...base,
    row('2026-10-21', { keyId: 'key_b', listUSD: 6 }),
    row('2026-10-22', {
      source: 'claude',
      model: 'claude-sonnet-5-5',
      project: '~/a',
      center: 'platform',
      keyId: null,
    }),
  ];
  const keyNames = new Map([['key_b', 'Acme client']]);
  const o = V.overview({ ...split(all), today: '2026-10-22', keyNames });
  const y = o.anomalies.yesterday;
  assert.deepEqual([y.day, y.partial, y.spentUSD, y.expectedUSD, y.anomaly], ['2026-10-21', false, 8, 2, true]);
  assert.deepEqual(
    y.drivers.map((d) => [d.dim, d.value, d.label, d.extraUSD, d.share]),
    [
      ['model', 'deepseek-chat', 'deepseek-chat', 6, 1],
      ['center', 'client', 'client', 6, 1],
      ['keyId', 'key_b', 'Acme client', 6, 1],
    ],
  );
  const t = o.anomalies.today;
  assert.deepEqual(
    [t.day, t.partial, t.spentUSD, t.expectedUSD, t.anomaly, t.drivers],
    ['2026-10-22', true, 1, 2, false, []],
  );
  const unnamed = V.overview({ ...split(all), today: '2026-10-22' }).anomalies.yesterday.drivers;
  assert.equal(unnamed[2].label, 'key_b', 'a key without a name shows its id');
  assert.equal(
    V.overview({ ...split(all), today: '2026-10-22', anomalyParams: { ratio: 5 } }).anomalies.yesterday.anomaly,
    false,
  );
});

// The API with a fake ledger: the month and the history are cut from one list of rows.
function api({ rows = PATTERN, failHistory = false, anomalyParams } = {}) {
  const asked = [];
  const cost = {
    budgetRows: ({ from, to }) => {
      asked.push(`${from}|${to}`);
      if (failHistory && to < '2026-10-01') throw new Error('unreadable');
      const out = rows.filter((r) => r.day >= from && r.day <= to);
      return { rows: out, unread: [], billingError: null, historyLost: false };
    },
    planFeeFor: () => 0,
  };
  const budgets = createBudgetService({
    getSettings: () => ({
      budgets: [{ id: 'team', name: 'Team', scope: 'global', period: 'month', amount: 110 }],
    }),
    cost,
    now: () => NOW,
    nocase: false,
  });
  const a = createCostApi({
    cost,
    settings: { get: () => ({}), save: () => {} },
    listKeys: () => [{ id: 'key_b', name: 'Acme client' }],
    now: () => NOW,
    budgets,
    anomalyParams,
  });
  const get = (path, query = '') => a.route({ method: 'GET', path, query: new URLSearchParams(query) });
  return { get, asked };
}

test('GET /api/cost/view: the Overview gains forecastMethod, anomalies and anomalyParams from the history', async () => {
  const s = api({ anomalyParams: () => ({ ratio: 3 }) });
  const r = await s.get('/api/cost/view', 'page=overview');
  assert.equal(r.status, 200);
  assert.ok(s.asked.includes('2026-09-02|2026-09-30'), 'the 29 days before the 1st');
  assert.equal(r.body.forecastMethod, 'weekday');
  assert.equal(r.body.forecast.projected, 112);
  assert.deepEqual(r.body.anomalyParams, { ratio: 3, minUSD: 1 });
  assert.equal(r.body.anomalies.yesterday.day, '2026-10-21');
  assert.equal(r.body.anomalies.today.partial, true);
  assert.equal(r.body.rings[0].runsOut, '2026-10-31', 'a ring carries its budget’s runs-out date');
  const thrown = api({
    anomalyParams: () => {
      throw new Error('no state');
    },
  });
  assert.deepEqual((await thrown.get('/api/cost/view', 'page=overview')).body.anomalyParams, { ratio: 2, minUSD: 1 });
});

test('GET /api/cost/view: a history that does not read leaves the forecast and the anomalies out, not the page', async () => {
  const r = await api({ failHistory: true }).get('/api/cost/view', 'page=overview');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.forecastMethod, r.body.anomalies, r.body.forecast.early], [null, null, true]);
  assert.deepEqual(r.body.unread, []);
  assert.equal(r.body.total, 75.5);
});

test('GET /api/cost/budgets: each view gains forecastUSD and runsOut', async () => {
  const r = await api().get('/api/cost/budgets');
  assert.equal(r.status, 200);
  const team = r.body.budgets.find((b) => b.id === 'team');
  assert.deepEqual([team.forecastUSD, team.runsOut, team.projected], [112, '2026-10-31', true]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-forecast-views.test.js`
Expected: FAIL, 7 of 8 tests: `forecastMethod`, `anomalies` and `anomalyParams` are `undefined`, the forecast is the
mean of the elapsed days, and the history is not read.

- [ ] **Step 3: `lib/cost/views.js`, requires and constants**

Replace `:7-15` (the three requires and the five constants `SPIKE_RATIO` to `BAND_MIN_DAYS`; `const RINGS = 8;` and
what follows stay) with these lines, then one blank line before `const RINGS = 8;`:

```js
const { normalizeModel } = require('../pricing');
const { addDays, daysBetween, daysInMonth, dayOf } = require('./days');
const { tokenTotal } = require('./ledger');
const { SOURCES } = require('./rules');
const F = require('./forecast');
const A = require('./anomaly');
```

Replace `quantile` with its comment (`:50-57`) with:

```js
// The q-quantile is the forecast's own (lib/cost/forecast.js); the calendar's color steps use it too.
const { quantile } = F;
```

- [ ] **Step 4: `lib/cost/views.js`, `overview`**

Replace the comment and the whole of `overview` (`:111-242`, from `/**` to the closing `}` before
`// ---- Breakdown ----`) with:

```js
// An anomaly figure as the Overview sends it (lib/cost/anomaly.js): the measureDay result, whether the rule's
// parameters call it an anomaly, and a label per driver (a key's name for a key id; else the value itself).
function anomalyOut(m, params, keyName) {
  if (!m) return null;
  return {
    ...m,
    anomaly: A.isAnomaly(m, params),
    drivers: m.drivers.map((d) => ({ ...d, label: d.dim === 'keyId' ? keyName(d.value) || d.value : d.value })),
  };
}

/**
 * The current month, day 1 to today. `rows` are the month's ledger rows as billed (cost.budgetRows), `history` the
 * rows of the 29 days before the 1st (null when they did not read: no forecast and no anomalies), `unread` the months
 * either read skipped, `budgets` the evaluated budgets, `currency` the chosen code and `display` the display currency
 * with its latest rate ({ code, rate } or null) for the budget lines. `planFee(source, day)` is a plan's fee for a day
 * to come (the Paid forecast), `anomalyParams` the cost_anomaly rule's saved parameters and `keyNames` a Map of
 * gateway key id -> name, for the Anomalies card.
 */
function overview({
  rows = [],
  history = [],
  unread = [],
  today,
  budgets = [],
  rateOf = null,
  measure = 'list',
  currency = 'USD',
  display = null,
  planFee = null,
  anomalyParams = null,
  keyNames = new Map(),
}) {
  const c = converter(rateOf);
  const from = `${today.slice(0, 8)}01`;
  const days = daysInMonth(today);
  const last = `${today.slice(0, 8)}${String(days).padStart(2, '0')}`;
  const month = daysBetween(from, today);
  const elapsed = month.length;
  const remaining = days - elapsed;
  const inMonth = (rows || []).filter((r) => r && r.day >= from && r.day <= today);
  const usd = dailyUSD(inMonth, measure);
  // The chosen measure's month total is the daily series' own running sum (below); only the other measure is summed here.
  const other = measure === 'billed' ? 'list' : 'billed';
  let otherSum = 0;
  for (const [day, v] of [...dailyUSD(inMonth, other)].sort((a, b) => cmp(a[0], b[0])))
    otherSum += c.conv(day, v, false);

  let cum = 0;
  let spentUSD = 0;
  const daily = month.map((day) => {
    spentUSD += usd.get(day) || 0;
    const spend = c.conv(day, usd.get(day) || 0);
    cum += spend;
    return { day, spend, cum };
  });
  const spent = measure === 'billed' ? { list: otherSum, billed: cum } : { list: cum, billed: otherSum };

  // The forecast (lib/cost/forecast.js): the measure's usage over the 4 weeks before today, by weekday, projected in
  // USD to the month's end and converted day by day. Plan fees are exact: today's is spent already, each later day's
  // comes from planFee. Without a model (a young ledger, or a history that did not read) the line is the mean of the
  // elapsed days, as before, without a band.
  const known = history ? [...history, ...inMonth].filter((r) => r && r.kind !== 'plan' && r.day <= today) : null;
  const model = known
    ? F.dailyModel(
        [...dailyUSD(known, measure)].map(([day, v]) => ({ day, usd: v })),
        { today, unread },
      )
    : null;
  const planPerDay =
    measure === 'billed' && typeof planFee === 'function'
      ? (day) => SOURCES.reduce((a, s) => a + num(planFee(s, day)), 0)
      : () => 0;
  let line;
  if (model) {
    const todaySoFar = dailyUSD(
      inMonth.filter((r) => r.kind !== 'plan'),
      measure,
    ).get(today);
    const usdLine = F.project(model, { today, spentSoFar: spentUSD, todaySoFar, to: last, planPerDay });
    let prev = { cum: spentUSD, low: spentUSD, high: spentUSD };
    const at = { cum, low: cum, high: cum };
    line = usdLine.map((p) => {
      for (const k of ['cum', 'low', 'high']) at[k] += c.conv(p.day, p[k] - prev[k], false);
      prev = p;
      return { day: p.day, cum: round(at.cum), low: round(at.low), high: round(at.high) };
    });
  } else {
    const perDay = elapsed ? cum / elapsed : 0;
    line = [];
    for (let k = 0; k <= remaining; k++)
      line.push({ day: addDays(today, k), cum: round(cum + perDay * k), low: null, high: null });
  }
  const end = line[line.length - 1];
  const after = line[0];

  // Anomalies (lib/cost/anomaly.js): today so far and yesterday against the 4 weeks before each, with the rule's
  // parameters, as the Monitors rule checks them. The spike line marks each day of the month the same way: its usage
  // value (list, whatever the measure) against its weekday's usual amount, which is its baseline.
  const params = A.anomalyParams(anomalyParams);
  const all = history ? [...history, ...inMonth] : null;
  const keyName = (id) => (keyNames instanceof Map ? keyNames.get(id) : null);
  const recent = all ? A.recentDays(all, { today, unread }) : null;
  const listUSD = dailyUSD(all ? all.filter((r) => r && r.kind !== 'plan') : [], 'list');
  const listSeries = [...listUSD].map(([day, v]) => ({ day, usd: v }));
  const top = topModels(inMonth, 'list');
  const spikes = month.map((day) => {
    const m = all ? F.dailyModel(listSeries, { today: day, unread }) : null;
    const v = listUSD.get(day) || 0;
    const base = m ? m.byWeekday[F.weekday(day)] : null;
    const fig = {
      spentUSD: Math.round(v * 1e8) / 1e8,
      expectedUSD: base == null ? null : Math.round(base * 1e8) / 1e8,
    };
    return {
      day,
      spend: round(c.conv(day, v)),
      baseline: base == null ? null : round(c.conv(day, base)),
      spike: base != null && A.isAnomaly(fig, params),
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
  const total = cum;

  return {
    month: { from, to: last, today, day: elapsed, days },
    spent: { list: round(spent.list), billed: round(spent.billed) },
    total: round(total),
    daily: daily.map((d) => ({ day: d.day, spend: round(d.spend), cum: round(d.cum) })),
    forecast: {
      // The mean spend of a day after today, in the chosen currency.
      perDay: remaining ? round((end.cum - after.cum) / remaining) : 0,
      projected: end.cum,
      low: model ? end.low : null,
      high: model ? end.high : null,
      early: !model, // no band: the line is the mean of the elapsed days
      line,
    },
    forecastMethod: model ? model.method : null,
    budgetLines,
    budgetsSkipped: monthly.length - budgetLines.length,
    spikes,
    anomalies: recent
      ? { today: anomalyOut(recent.today, params, keyName), yesterday: anomalyOut(recent.yesterday, params, keyName) }
      : null,
    anomalyParams: params,
    rings: ordered.slice(0, RINGS).map((b) => ({
      id: b.id,
      name: b.name,
      state: b.state,
      tone: toneOf(b.state),
      percent: b.percent == null ? null : b.percent,
      projected: b.projected === true,
      runsOut: typeof b.runsOut === 'string' ? b.runsOut : null,
    })),
    moreBudgets: Math.max(0, ordered.length - RINGS),
    atRisk: { count: (budgets || []).filter(atRisk).length, total: (budgets || []).length },
    topCenter: topCenter && {
      ...topCenter,
      spend: round(topCenter.spend),
      share: total > 0 ? round(topCenter.spend / total) : null,
    },
    missingRate: c.missing(),
  };
}
```

In `module.exports` (`:611-613`), delete the three lines `SPIKE_RATIO,`, `SPIKE_MIN_USD,` and `BASELINE_MIN,`.

- [ ] **Step 5: `lib/cost/api.js`**

After `const preview = require('./preview');` (`:10`), add:

```js
const { HISTORY_DAYS } = require('./anomaly');
```

After `passRates = () => ({}),` (`:50`), add:

```js
  // The cost_anomaly rule's saved parameters (Cost Control 4a; server.js reads the monitor state), so the Overview's
  // spike line and Anomalies card mark what the rule would. A reader that fails gives the defaults.
  anomalyParams = () => null,
```

Replace the Overview branch of `view` (`:174-188`, from `if (page === 'overview') {` to the `});` before
`} else if (page === 'breakdown')`) with:

```js
    if (page === 'overview') {
      // The forecast's and the anomalies' history: the 29 days before the 1st (lib/cost/anomaly.js). A read that fails
      // leaves both out (forecastMethod and anomalies null), never the page.
      const [history] = quietly(
        () => cost.budgetRows({ from: addDays(from, -HISTORY_DAYS), to: addDays(from, -1) }),
        null,
      );
      for (const u of (history && history.unread) || []) unread.add(u);
      const [evaluated, budgetsFailed] = budgets ? quietly(() => budgets.evaluate(), []) : [[], false];
      flags.budgetsError = budgetsFailed ? 'budgets could not be read' : null;
      const [params] = quietly(() => anomalyParams(), null);
      data = views.overview({
        rows: read.rows,
        history: history ? history.rows : null,
        unread: [...unread],
        today,
        budgets: evaluated,
        rateOf,
        measure,
        currency: currency || 'USD',
        display: s.currency ? { code: s.currency.code, rate: rateFor(s.currency, today) } : null,
        planFee: typeof cost.planFeeFor === 'function' ? cost.planFeeFor : null,
        anomalyParams: params,
        keyNames: new Map(keys().map((k) => [k.id, k.name || k.id])),
      });
```

- [ ] **Step 6: Update the Overview tests that drew the old forecast and baseline**

In `test/cost-views.test.js`, replace the test "overview: month to date in both measures, the forecast at the mean day
and the band from the quartiles" (`:54-78`) with:

```js
test('overview: month to date in both measures, the forecast at the mean of the known days and its band', () => {
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
  // Four known days before today, mean 2.5, for the 26 days left; the day ratios 0.4 to 1.6 give a band of 0.7 to 1.3.
  // Today's 10 is past its 2.5 already, so today adds nothing.
  assert.deepEqual([o.forecast.perDay, o.forecast.projected, o.forecast.low, o.forecast.high], [2.5, 85, 65.5, 104.5]);
  assert.equal(o.forecast.early, false);
  assert.equal(o.forecastMethod, 'mean');
  assert.equal(o.forecast.line.length, 27, 'today and each day left');
  assert.deepEqual(o.forecast.line[0], { day: '2026-10-05', cum: 20, low: 20, high: 20 });
  assert.deepEqual(o.forecast.line[26], { day: '2026-10-31', cum: 85, low: 65.5, high: 104.5 });
  const paid = V.overview({ rows: [...FIVE, planRow('2026-10-01', 3)], today: '2026-10-05', measure: 'billed' });
  assert.equal(paid.total, 13);
  assert.equal(paid.daily[0].spend, 3.5, 'the plan fee is on its day');
});
```

Replace the test "overview: a spike is over twice its 7-day baseline and at least $1 over it, the days before the 1st
included" (`:123-145`) with:

```js
test('overview: a spike is an anomaly against its weekday, the days before the 1st included', () => {
  const history = Array.from({ length: 29 }, (_, i) =>
    row({ day: `2026-09-${String(i + 2).padStart(2, '0')}`, listUSD: 0.2 }),
  );
  const rows = [
    row({ day: '2026-10-01', listUSD: 0.5 }), // 2.5 × its usual 0.2, but only $0.30 over it
    row({ day: '2026-10-02', listUSD: 1, model: 'claude-opus-5-5' }),
    row({ day: '2026-10-02', listUSD: 2, model: 'claude-sonnet-5-5' }),
    row({ day: '2026-10-03', listUSD: 1 }),
  ];
  const o = V.overview({ rows, history, today: '2026-10-03', rateOf: () => 10, currency: 'XYZ' });
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
  assert.equal(s.baseline, 2, "the Fridays' usual 0.2, converted");
  assert.equal(o.spikes[0].baseline, 2);
});
```

In "overview: a ledger that starts mid-month…" (`:162`), `assert.equal(V.BASELINE_MIN, 3);` becomes
`assert.equal(require('../lib/cost/forecast').MIN_KNOWN, 3);` (the same days and numbers hold: below 7 known days the
model is the plain mean of the known days before each day).

In `test/cost-charts.test.js`, the message of the scale assertion (`:59`) becomes:

```js
  assert.match(
    svg,
    />\$150\.00</,
    'the scale follows the band top (104.5 × 1.1, rounded up), the budget fits under it',
  );
```

Replace the test "burn-down: a budget over twice the band top is pinned…" (`:66-81`) with:

```js
test('burn-down: a budget over twice the band top is pinned at the top edge and keeps the curve readable', () => {
  const rows = [1, 2, 3, 4, 10].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v }));
  const budgets = [
    { id: 'big', name: 'Big', scope: 'global', period: 'month', amount: 1000, currency: 'USD' },
    { id: 'near', name: 'Near', scope: 'global', period: 'month', amount: 200, currency: 'USD' },
  ];
  const svg = C.costBurnSvg(V.overview({ rows, today: '2026-10-05', budgets }), fmt);
  assert.equal(count(svg, /class="cost-fade cost-pinned"/g), 1);
  assert.match(svg, />↑ Budget \$1000\.00</);
  assert.match(svg, /data-tip="Monthly budget · Big · \$1000\.00 · above this scale"/);
  assert.match(svg, />Near · \$200\.00</, '200 is within twice the band top (104.5): drawn as a line');
  assert.match(svg, />\$250\.00</, 'the axis tops at the nearer budget × 1.1, not at 1,000');
  const early = C.costBurnSvg(V.overview({ rows: rows.slice(0, 2), today: '2026-10-02', budgets }), fmt);
  // Without a band the forecast's end (1.5 × 31 = 46.5) sets the reach: both budgets are over twice it.
  assert.equal(count(early, /class="cost-fade cost-pinned"/g), 2);
});
```

Replace the test "burn-down: right-skewed spend keeps the forecast end inside the scale…" (`:83-96`) with:

```js
test('burn-down: right-skewed spend keeps the forecast end inside the scale and a budget under it in scale', () => {
  // Six known days at a mean of 2.5, five of them at 0.4 of it: the band's top (0.4) is far under the forecast's end.
  const rows = [1, 1, 1, 1, 1, 10, 1].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v }));
  const budgets = [{ id: 'b', name: 'B', scope: 'global', period: 'month', amount: 120, currency: 'USD' }];
  const o = V.overview({ rows, today: '2026-10-07', budgets });
  assert.ok(o.forecast.projected > o.forecast.high, 'projected is above the band top');
  const svg = C.costBurnSvg(o, fmt);
  assert.equal(count(svg, /cost-pinned/g), 0, 'the $120 budget is drawn as a line');
  assert.match(svg, />B · \$120\.00</);
  const d = svg.match(/<path class="cost-fade" d="([^"]*)" fill="none" stroke="#8b7bff"/)[1];
  const ys = [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(ys.length > 2 && Math.min(...ys) > 14 + 0.5, 'the forecast is never clamped to the top margin');
  const top = Number([...svg.matchAll(/>\$(\d+)\.00</g)].map((m) => m[1]).sort((a, b) => b - a)[0]);
  assert.ok(top >= o.forecast.projected, 'the axis covers the projected total');
});
```

Replace the test "spike line: one marker per spike, its tooltip with the baseline and the top model" (`:109-122`)
with:

```js
test('spike line: one marker per spike, its tooltip with the baseline and the top model', () => {
  const history = Array.from({ length: 29 }, (_, i) =>
    row({ day: `2026-09-${String(i + 2).padStart(2, '0')}`, listUSD: 0.2 }),
  );
  const rows = [row({ listUSD: 0.5 }), row({ day: '2026-10-02', listUSD: 3, model: EVIL })];
  const o = V.overview({ rows, history, today: '2026-10-02' });
  const svg = C.costSpikeSvg(o.spikes, fmt);
  assert.equal(count(svg, /class="cost-spike"/g), 1);
  assert.match(svg, /data-tip="2 Oct · \$3\.00 · baseline \$0\.20 · spike · top model &lt;img/);
  assert.doesNotMatch(svg, /<img/);
  // A ledger that starts on the 1st: no baseline yet, so no dashed segment and no marker.
  const young = C.costSpikeSvg(V.overview({ rows: [row({ listUSD: 9 })], today: '2026-10-02' }).spikes, fmt);
  assert.match(young, /<path class="cost-fade" d="" /);
  assert.match(young, /data-tip="1 Oct · \$9\.00 · no baseline yet · top model claude-opus-5-5"/);
  assert.equal(count(young, /class="cost-spike"/g), 0);
});
```

- [ ] **Step 7: Run the tests and see them pass**

Run: `node --test test/cost-forecast-views.test.js test/cost-views.test.js test/cost-views-pages.test.js test/cost-charts.test.js test/cost-view-api.test.js test/cost-ui.test.js`
Expected: PASS (8 new tests; the demo Overview of `test/cost-view-api.test.js` keeps `low ≤ projected ≤ high`).

- [ ] **Step 8: Check the style**

Run: `npx prettier@3 --check lib/cost/views.js lib/cost/api.js test/cost-forecast-views.test.js test/cost-views.test.js test/cost-charts.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 9: Commit**

```bash
git add lib/cost/views.js lib/cost/api.js test/cost-forecast-views.test.js test/cost-views.test.js test/cost-charts.test.js
git commit -m "Cost Overview: the weekday forecast, spikes as anomalies, and today's and yesterday's anomalies"
```

---
### Task 5: The Monitors rule `cost_anomaly` (shared: `lib/monitors/*.js`, `server.js`)

**Files:**
- Modify: `lib/monitors/rules.js:5` (requires before it), `:19-20` (`POSITIVE`), `:23` (helpers after `clean`),
  `:90-98` (a rule after `unsafe_content`), `:234-235` (a check after `unsafe_content`'s)
- Modify: `lib/monitors/state.js:305-308` (the end of a snooze), `:312` (`spaced`), `:362` (`usual` on an alert)
- Modify: `lib/monitors/index.js:19` (a require), `:40-42` (`ended`), `:64` (an option), `:83` (a comment), `:129`
  (the snapshot field), `:218` (a part before "the recent usage"), `:292` (`ruleSnap`)
- Modify: `lib/monitors/api.js:27` (`PARAM_RANGE`), `:393-394` (`usual` in `/api/alerts`)
- Modify: `server.js:58` (two requires after it), `:522` (a cost API option), `:674` (an engine option)
- Modify: `test/monitors-rules.test.js:36`, `:73`; `test/monitors-api.test.js:199`; `test/budgets-monitors.test.js:41-42`,
  `:447`, `:451` (the rule list has nine rules)
- Test: `test/monitors-anomaly.test.js` (create)

**Interfaces:**
- Consumes: Task 2's `isAnomaly`, `recentDays`, `HISTORY_DAYS`; Task 1's `weekday`; `dayOf`, `addDays`, `isDay`
  (`lib/cost/days.js`); `cost.budgetRows`; the state store's `settings(ruleId)`.
- Produces:
  - `RULES` gains `{ id: 'cost_anomaly', title: 'Cost anomaly', describe: "Today's or yesterday's spend is well above
    what the same weekday usually costs.", kind: 'aggregate', params: { ratio: 2, minUSD: 1 }, defaultOn: () => true,
    mayAutoPause: false, remind: false }`, last; its check reads `snap.costAnomaly` (M1). Results carry `usual`.
  - `createMonitorState().apply` honours `remind: false` and copies a result's numeric `usual` onto the alert (M2).
  - `createMonitors({ …, costAnomaly = null })`: `costAnomaly(t) → { today, yesterday }` is read in each aggregate
    pass (a throw is logged as "monitors: could not read the cost anomalies: …" and leaves it null); `ruleSnap()` gains
    `costAnomaly`. `isEndedSession(s, t)` is also true for a `cost_anomaly` instance whose day is before
    `dayOf(t) − 1`.
  - `/api/monitors/<id>` accepts `ratio` (above 1, up to 100) and `minUSD` (above 0, up to 1,000,000);
    `/api/alerts` rows of `cost_anomaly` gain `usual: number | null`.
  - `server.js` passes `costAnomaly` to `createMonitors` and `anomalyParams: () =>
    monitorApiState.settings('cost_anomaly').params` to `createCostApi` (read on a request, after the store is made).

- [ ] **Step 1: Write the failing test**

Create `test/monitors-anomaly.test.js`:

```js
// Cost Control 4a: the Monitors rule cost_anomaly (lib/monitors/rules.js), its per-day instances in the state store
// (lib/monitors/state.js), the engine's snapshot provider and ended days (lib/monitors/index.js), the routes
// (lib/monitors/api.js) and what the channels carry (lib/monitors/channels.js). The channels' spawn is a recorder and
// the webhook a local fake server: nothing is shown or sent for real. 28 October 2026 is a Wednesday.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { RULES, evaluate } = require('../lib/monitors/rules');
const { createMonitorState } = require('../lib/monitors/state');
const { createMonitors, isEndedSession } = require('../lib/monitors');
const { createChannels } = require('../lib/monitors/channels');
const { createMonitorApi } = require('../lib/monitors/api');
const { fakeServer, secretsFor } = require('./helpers');

const MIN = 60e3;
const T28 = new Date(2026, 9, 28, 15).getTime();
const T29 = new Date(2026, 9, 29, 10).getTime();
const T30 = new Date(2026, 9, 30, 10).getTime();
const RULE = RULES.find((r) => r.id === 'cost_anomaly');
// A measureDay result (lib/cost/anomaly.js), with drivers that name a project and a key.
const fig = (day, spentUSD, expectedUSD, partial = false) => ({
  day,
  partial,
  spentUSD,
  expectedUSD,
  drivers: [
    { dim: 'project', value: '~/secret-project', extraUSD: 9, share: 0.7 },
    { dim: 'keyId', value: 'key_secret', extraUSD: 3, share: 0.2 },
  ],
});
const brief = (r) => [r.instance, r.state, r.value, r.threshold, r.title, r.usual];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-mon-anomaly-'));
function store(clock) {
  const dir = tmp();
  return createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => clock.t,
  });
}

test('the rule: listed with its two parameters, on by default, never pausing', () => {
  assert.deepEqual(
    [RULE.title, RULE.describe, RULE.kind, RULE.params, RULE.defaultOn({}), RULE.mayAutoPause, RULE.remind],
    [
      'Cost anomaly',
      "Today's or yesterday's spend is well above what the same weekday usually costs.",
      'aggregate',
      { ratio: 2, minUSD: 1 },
      true,
      false,
      false,
    ],
  );
});

test('the rule: one instance per day, titled, in USD to the cent; no_data without figures or a snapshot', () => {
  const snap = { costAnomaly: { yesterday: fig('2026-10-27', 3, 2), today: fig('2026-10-28', 18.404, 6.1, true) } };
  assert.deepEqual(evaluate(RULE, {}, snap, T28).map(brief), [
    ['2026-10-27', 'ok', 3, 4, 'Tue 27 Oct', 2],
    ['2026-10-28', 'triggered', 18.4, 12.2, 'Wed 28 Oct (so far)', 6.1],
  ]);
  assert.ok(evaluate(RULE, {}, snap, T28).every((r) => r.sessionId === null && !('drivers' in r)));
  assert.equal(evaluate(RULE, { ratio: 4 }, snap, T28)[1].state, 'ok', 'the owner’s ratio');
  assert.equal(evaluate(RULE, { ratio: 0, minUSD: -1 }, snap, T28)[1].threshold, 12.2, 'not positive: defaults');
  const gaps = { costAnomaly: { yesterday: null, today: fig('2026-10-27', 18, 6) } };
  assert.deepEqual(evaluate(RULE, {}, gaps, T28).map(brief), [
    ['2026-10-27', 'no_data', null, null, 'Tue 27 Oct', undefined],
    ['2026-10-28', 'no_data', null, null, 'Wed 28 Oct (so far)', undefined],
  ]);
  for (const s of [{}, { costAnomaly: null }])
    assert.deepEqual(evaluate(RULE, {}, s, T28).map(brief), [['all', 'no_data', null, null, undefined, undefined]]);
});

test('one alert per day: the partial check and the whole one share the day’s instance, with no reminder', () => {
  const clock = { t: T28 };
  const s = store(clock);
  const apply = (snap) => s.apply('cost_anomaly', evaluate(RULE, {}, snap, clock.t));
  const first = apply({ costAnomaly: { yesterday: fig('2026-10-27', 2, 2), today: fig('2026-10-28', 18.4, 6.1) } });
  assert.deepEqual(
    first.map((a) => [a.instance, a.state, a.previous, a.value, a.threshold, a.title, a.usual]),
    [['2026-10-28', 'triggered', null, 18.4, 12.2, 'Wed 28 Oct (so far)', 6.1]],
  );
  clock.t = T28 + 31 * MIN;
  assert.deepEqual(
    apply({ costAnomaly: { yesterday: fig('2026-10-27', 2, 2), today: fig('2026-10-28', 19, 6.1) } }),
    [],
  );
  clock.t = T29;
  assert.deepEqual(
    apply({ costAnomaly: { yesterday: fig('2026-10-28', 25, 6.1), today: fig('2026-10-29', 1, 2) } }),
    [],
  );
  assert.equal(s.states().find((e) => e.instance === '2026-10-28').title, 'Wed 28 Oct', 'the whole day now');
  // A rise that only shows on the whole day alerts then, once.
  const c2 = { t: T28 };
  const late = store(c2);
  const at = (snap) => late.apply('cost_anomaly', evaluate(RULE, {}, snap, c2.t));
  assert.deepEqual(at({ costAnomaly: { yesterday: null, today: fig('2026-10-28', 3, 2) } }), []);
  c2.t = T29;
  const whole = at({ costAnomaly: { yesterday: fig('2026-10-28', 9, 2), today: null } });
  assert.deepEqual(
    whole.map((a) => [a.instance, a.state, a.title]),
    [['2026-10-28', 'triggered', 'Wed 28 Oct']],
  );
});

test('a snooze keeps an alert already sent quiet, and sends one it held back once it ends', () => {
  const clock = { t: T28 };
  const s = store(clock);
  const apply = (today) =>
    s.apply('cost_anomaly', evaluate(RULE, {}, { costAnomaly: { yesterday: null, today } }, clock.t));
  assert.equal(apply(fig('2026-10-28', 18.4, 6.1)).length, 1);
  s.snooze('cost_anomaly', null, 60 * MIN);
  clock.t = T28 + 61 * MIN;
  assert.deepEqual(apply(fig('2026-10-28', 19, 6.1)), [], 'sent before the snooze: not again');
  const c2 = { t: T28 };
  const held = store(c2);
  held.snooze('cost_anomaly', null, 60 * MIN);
  const hold = (today) =>
    held.apply('cost_anomaly', evaluate(RULE, {}, { costAnomaly: { yesterday: null, today } }, c2.t));
  assert.deepEqual(hold(fig('2026-10-28', 18.4, 6.1)), [], 'snoozed');
  c2.t = T28 + 61 * MIN;
  assert.equal(hold(fig('2026-10-28', 19, 6.1)).length, 1, 'held back: sent once the snooze ends');
  c2.t = T28 + 120 * MIN;
  assert.deepEqual(hold(fig('2026-10-28', 20, 6.1)), []);
});

test('a day past yesterday has ended: off the cards and the counts, pruned by the store a day later', () => {
  const row = (instance, lastSeen = T28) => ({ rule: 'cost_anomaly', instance, lastSeen, state: 'triggered' });
  assert.equal(isEndedSession(row('2026-10-27'), T29), true);
  assert.equal(isEndedSession(row('2026-10-28'), T29), false, 'yesterday is still checked');
  assert.equal(isEndedSession(row('2026-10-29'), T29), false);
  assert.equal(isEndedSession(row('all'), T29), false);
  assert.equal(isEndedSession({ ...row('2026-10-27'), rule: 'accuracy_drop' }, T29), false, 'other rules keep theirs');
  const clock = { t: T28 };
  const s = store(clock);
  const apply = (snap) => s.apply('cost_anomaly', evaluate(RULE, {}, snap, clock.t));
  apply({ costAnomaly: { yesterday: fig('2026-10-27', 2, 2), today: fig('2026-10-28', 18.4, 6.1) } });
  clock.t = T30;
  const sent = apply({ costAnomaly: { yesterday: fig('2026-10-29', 2, 2), today: fig('2026-10-30', 1, 2) } });
  assert.deepEqual(sent, [], 'no resolution for a day that is over');
  assert.deepEqual(
    s.states().map((e) => e.instance),
    ['2026-10-29', '2026-10-30'],
    'the 27th and 28th were last seen over a day ago',
  );
});

// The engine with a fake index and office, the real state store, and a spy for the channels.
function engine({ costAnomaly, demo = false } = {}) {
  const clock = { t: T28 };
  const state = store(clock);
  const sent = [];
  const logs = [];
  const monitors = createMonitors({
    indexer: { results: () => [] },
    office: { snapshot: () => ({ agents: [] }), demoSnapshot: () => ({ agents: [] }) },
    evals: { summary: () => ({ evaluators: {} }) },
    config: () => ({}),
    state,
    channels: { notify: async (alert) => sent.push(alert) },
    now: () => clock.t,
    log: (m) => logs.push(m),
    demo,
    costAnomaly,
  });
  return { clock, state, sent, logs, monitors };
}

test('engine: the provider’s figures reach the rule after each aggregate pass; counts leave a day that is over', async () => {
  const seen = [];
  const figures = { yesterday: fig('2026-10-27', 2, 2), today: fig('2026-10-28', 18.4, 6.1) };
  const e = engine({
    costAnomaly: (t) => {
      seen.push(t);
      return figures;
    },
  });
  await e.monitors.tickAggregate();
  assert.deepEqual(seen, [T28]);
  assert.deepEqual(
    e.sent.filter((a) => a.rule === 'cost_anomaly').map((a) => [a.instance, a.title, a.usual]),
    [['2026-10-28', 'Wed 28 Oct (so far)', 6.1]],
  );
  assert.equal((await e.monitors.status()).counts.triggered, 1);
  e.clock.t = T30;
  figures.yesterday = fig('2026-10-29', 2, 2);
  figures.today = fig('2026-10-30', 1, 2);
  await e.monitors.tickAggregate();
  const counts = (await e.monitors.status()).counts;
  assert.equal(counts.triggered, 0, 'the 28th is over');
});

test('engine: no provider, or one that throws, is no_data; the demo evaluates but sends nothing', async () => {
  const none = engine();
  await none.monitors.tickAggregate();
  assert.deepEqual(
    none.state
      .states()
      .filter((x) => x.rule === 'cost_anomaly')
      .map((x) => [x.instance, x.state]),
    [['all', 'no_data']],
  );
  const broken = engine({
    costAnomaly: () => {
      throw new Error('ledger unreadable');
    },
  });
  await broken.monitors.tickAggregate();
  assert.ok(broken.logs.some((m) => /could not read the cost anomalies/.test(m)));
  assert.equal(broken.state.states().find((x) => x.rule === 'cost_anomaly').state, 'no_data');
  const demo = engine({ demo: true, costAnomaly: () => ({ yesterday: null, today: fig('2026-10-28', 18.4, 6.1) }) });
  await demo.monitors.tickAggregate();
  assert.equal(demo.state.states().find((x) => x.instance === '2026-10-28').state, 'triggered');
  assert.deepEqual(demo.sent, []);
});

test('routes: the two parameters are bounded; an alert carries its usual amount, never a driver', async () => {
  const clock = { t: T28 };
  const state = store(clock);
  state.apply(
    'cost_anomaly',
    evaluate(RULE, {}, { costAnomaly: { yesterday: null, today: fig('2026-10-28', 18.4, 6.1) } }, T28),
  );
  const api = createMonitorApi({
    state,
    monitors: { status: async () => ({}) },
    channels: {},
    control: {},
    trace: { keyFor: () => null },
    channelSettings: { get: () => ({ desktop: true, webhook: null }) },
    now: () => clock.t,
  });
  const call = (p, method = 'GET', body) =>
    api.route({
      method,
      path: p,
      query: new URLSearchParams(''),
      contentType: 'application/json',
      readBody: async () => JSON.stringify(body),
    });
  const rules = (await call('/api/monitors')).body.rules;
  const card = rules.find((r) => r.id === 'cost_anomaly');
  assert.deepEqual([card.params, card.state, card.instances.length], [{ ratio: 2, minUSD: 1 }, 'triggered', 2]);
  assert.equal((await call('/api/monitors/cost_anomaly', 'POST', { params: { ratio: 3, minUSD: 0.5 } })).status, 200);
  assert.deepEqual(state.settings('cost_anomaly').params, { ratio: 3, minUSD: 0.5 });
  for (const params of [{ ratio: 1 }, { ratio: 0.5 }, { minUSD: 0 }, { ratio: 101 }])
    assert.equal((await call('/api/monitors/cost_anomaly', 'POST', { params })).status, 400, JSON.stringify(params));
  const alerts = (await call('/api/alerts')).body.alerts;
  const a = alerts.find((x) => x.rule === 'cost_anomaly');
  assert.deepEqual([a.title, a.value, a.threshold, a.usual], ['Wed 28 Oct (so far)', 18.4, 12.2, 6.1]);
  assert.doesNotMatch(JSON.stringify(alerts), /secret|drivers/);
});

test('channels: the desktop and the webhook carry the rule, the change, the numbers and the day, never a driver', async () => {
  const clock = { t: T28 };
  const state = store(clock);
  const snap = { costAnomaly: { yesterday: null, today: fig('2026-10-28', 18.4, 6.1) } };
  const [alert] = state.apply('cost_anomaly', evaluate(RULE, {}, snap, T28));
  assert.doesNotMatch(JSON.stringify(alert), /secret|drivers/, 'the alert itself holds no driver');
  const srv = await fakeServer({ 'POST /hook': { status: 200 } });
  try {
    const calls = [];
    const spawn = (cmd, args) => {
      calls.push({ cmd, args });
      const child = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { end() {} });
      child.kill = () => {};
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    const ch = createChannels({
      spawn,
      secrets: secretsFor({ HOOK_URL: `${srv.url}/hook` }),
      settings: () => ({ desktop: true, webhook: { url: { env: 'HOOK_URL' } } }),
      platform: 'darwin',
      sleep: () => Promise.resolve(),
    });
    await ch.notify(alert, { title: alert.title });
    assert.equal(calls[0].args[6], 'ZAAFPulse: Cost anomaly');
    assert.equal(calls[0].args[7], 'Triggered: 18.4 (limit 12.2)\nWed 28 Oct (so far)');
    assert.deepEqual(srv.requests[0].body, {
      rule: 'cost_anomaly',
      state: 'triggered',
      previous: null,
      value: 18.4,
      threshold: 12.2,
      sessionId: null,
      ts: T28,
    });
    assert.doesNotMatch(JSON.stringify([calls, srv.requests[0].body]), /secret|drivers/);
  } finally {
    await srv.close();
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/monitors-anomaly.test.js`
Expected: FAIL, 9 tests: `TypeError: Cannot read properties of undefined (reading 'title')` (no `cost_anomaly` in
`RULES`) and `Unknown rule: cost_anomaly` from the state store.

- [ ] **Step 3: `lib/monitors/rules.js`**

Before `const MIN = 60e3;` (`:5`), add:

```js
const { isAnomaly } = require('../cost/anomaly');
const { weekday } = require('../cost/forecast');
const { dayOf, addDays } = require('../cost/days');

```

Replace the comment and `POSITIVE` (`:19-20`) with:

```js
// These must be above zero: a zero window or stuck time would trigger on everything (or never see anything), and a
// zero ratio or rise would make every day of spend a cost anomaly.
const POSITIVE = new Set(['windowMin', 'stuckMin', 'ratio', 'minUSD']);
```

After `const clean = (x) => Math.round(x * 1e6) / 1e6;` (`:23`), add:

```js
const cents = (x) => Math.round(x * 100) / 100;
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Wed 28 Oct (so far)" for today, "Tue 27 Oct" for a whole day: a cost anomaly's instance title.
const dayTitle = (day, partial) =>
  `${WEEKDAY[weekday(day)]} ${Number(day.slice(8))} ${MONTH[Number(day.slice(5, 7)) - 1]}${partial ? ' (so far)' : ''}`;
```

After the `unsafe_content` rule (`:90-98`, its closing `},` before `];`), add:

```js
  {
    id: 'cost_anomaly',
    title: 'Cost anomaly',
    describe: "Today's or yesterday's spend is well above what the same weekday usually costs.",
    kind: 'aggregate',
    params: { ratio: 2, minUSD: 1 },
    defaultOn: () => true,
    mayAutoPause: false,
    remind: false, // one alert per day of spend: no reminder while it stays triggered (lib/monitors/state.js)
  },
```

In `CHECKS`, after `unsafe_content`'s check (its closing `},` after `return single(n >= 1 ? 'triggered' : 'ok', n, 1);`
at `:234-235`), add:

```js

  // One instance per day, named by its date: yesterday, checked whole, and today, so far (lib/cost/anomaly.js
  // recentDays). A day keeps its instance from its partial check to its whole one, so it alerts once. The value is
  // the day's spend, the threshold ratio × its usual amount and `usual` that amount, in USD to the cent. The drivers
  // are not kept here: they can name projects and keys, and stay in the dashboard.
  cost_anomaly(p, snap, now) {
    const a = snap.costAnomaly;
    if (!a || typeof a !== 'object') return single('no_data', null, null);
    const today = dayOf(now);
    return [
      [addDays(today, -1), a.yesterday, false],
      [today, a.today, true],
    ].map(([day, m, partial]) => {
      const title = dayTitle(day, partial);
      if (!m || m.day !== day || !isNonNeg(m.spentUSD) || !isNonNeg(m.expectedUSD))
        return result(day, null, 'no_data', null, null, title);
      const r = result(
        day,
        null,
        isAnomaly(m, p) ? 'triggered' : 'ok',
        cents(m.spentUSD),
        cents(p.ratio * m.expectedUSD),
        title,
      );
      r.usual = cents(m.expectedUSD);
      return r;
    });
  },
```

- [ ] **Step 4: `lib/monitors/state.js`**

In `apply`, replace (`:305-308`):

```js
      if (e.snoozed) {
        fresh(e);
        dirty = true;
      }
```

with:

```js
      if (e.snoozed) {
        // A rule without reminders keeps an alert it sent before the snooze, and sends one it held back (once).
        if (def.remind === false) {
          e.snoozed = false;
          if (!e.open) e.state = null;
        } else fresh(e);
        dirty = true;
      }
```

Replace `const spaced = t - e.lastAlertTs >= REALERT_MS;` (`:312`) with:

```js
      // A rule without reminders (cost_anomaly: one alert per day of spend) alerts on a change of state only.
      const spaced = t - e.lastAlertTs >= REALERT_MS && def.remind !== false;
```

After `if (e.title) alert.title = e.title;` in `apply` (`:362`; not the one in `applyBudgets`), add:

```js
      if (isNum(r.usual)) alert.usual = r.usual; // a cost anomaly's usual amount, for the bell's line
```

- [ ] **Step 5: `lib/monitors/index.js`**

`:19` becomes `const { dayOf, isDay, addDays } = require('../cost/days');`. Replace the comment and `ended`
(`:40-42`) with:

```js
// A cost anomaly's instance is its day: reported while it is today or yesterday, then over, as an ended session is.
const pastDay = (s, t) =>
  s.rule === 'cost_anomaly' && isDay(s.instance) && isNum(t) && s.instance < addDays(dayOf(t), -1);
// A state row (state.states()) of a live session that ended, or of a cost anomaly's day that is no longer checked: it
// leaves the rule cards and the counts, no resolution is sent, and the state store prunes it a day after it was last
// seen. An aggregate instance ('all') never ends.
const ended = (s, t) =>
  pastDay(s, t) ||
  (LIVE_RULES.has(s.rule) &&
    s.instance !== 'all' &&
    isNum(t) &&
    !(isNum(s.lastSeen) && s.lastSeen >= t - LIVE_STALE_MS));
```

After `home = '',` (`:64`), add:

```js
  // The cost_anomaly rule's figures (Cost Control 4a): (t) -> { today, yesterday } from lib/cost/anomaly.js
  // recentDays, read from the ledger by server.js; or null (the rule is then no_data).
  costAnomaly = null,
```

The comment on `let agg = null;` (`:83`) becomes
`// { ts, budget, today, month, accuracy, evals, signals, usage, sessionInfo, costly, costAnomaly }`. After
`buildSpend: null,` in `buildAggregate`'s `out` (`:129`), add:

```js
      costAnomaly: null, // { today, yesterday } for cost_anomaly; drivers included, never sent (rules.js keeps none)
```

Before `part('the recent usage', () => {` (`:218`), add:

```js
    part('the cost anomalies', () => {
      if (typeof costAnomaly === 'function') out.costAnomaly = costAnomaly(t) || null;
    });
```

In `ruleSnap`, after `signals: agg && agg.signals,` (`:292`), add `costAnomaly: agg && agg.costAnomaly,`.

- [ ] **Step 6: `lib/monitors/api.js`**

After `windowMin: { min: 0, max: 1440, above: true },` in `PARAM_RANGE` (`:27`), add:

```js
  ratio: { min: 1, max: 100, above: true }, // cost_anomaly: times the usual amount
  minUSD: { min: 0, max: 1e6, above: true }, // cost_anomaly: the rise in USD a day needs
```

In `alerts`, after the `if (a.rule === 'budget') { … }` block (`:393-394`, its closing `}`), add:

```js
      // A cost anomaly's usual amount for its day, for the bell's "usual $6.10".
      if (a.rule === 'cost_anomaly') row.usual = isNum(a.usual) ? a.usual : null;
```

- [ ] **Step 7: `server.js`**

After `const { createGuard } = require('./lib/cost/guard');` (`:58`), add:

```js
const { recentDays, HISTORY_DAYS: ANOMALY_HISTORY_DAYS } = require('./lib/cost/anomaly');
const { dayOf: costDayOf, addDays: costAddDays } = require('./lib/cost/days');
```

In `createCostApi({ … })`, after `passRates: (range) => costPassRates(experiments.list(), range),` (`:522`), add:

```js
  // The cost_anomaly rule's saved parameters, from the store the Monitors page shows (the demo's own), made below.
  anomalyParams: () => monitorApiState.settings('cost_anomaly').params,
```

In `createMonitors({ … })`, after `home: os.homedir(),` (`:674`, the line after `retired: RETIRED_RULES,`), add:

```js
  // cost_anomaly: today so far and yesterday from the ledger as billed, each against the 4 weeks before it (the demo
  // ledger in demo mode, where nothing is sent).
  costAnomaly: (t) => {
    const today = costDayOf(t);
    const r = cost.budgetRows({ from: costAddDays(today, -ANOMALY_HISTORY_DAYS), to: today });
    return recentDays(r.rows, { today, unread: r.unread });
  },
```

- [ ] **Step 8: The rule list has nine rules**

- `test/monitors-rules.test.js`: in "the rule table is data-driven and complete", add `'cost_anomaly',` after
  `'unsafe_content',` (`:36`); in "defaultOn follows the budget and the fixed defaults", add `cost_anomaly: true,`
  after `unsafe_content: true,` (`:73`).
- `test/monitors-api.test.js:199`: `assert.equal(r.body.rules.length, 9);`.
- `test/budgets-monitors.test.js`: the test name at `:41` becomes `'the budget rule sits beside the nine fixed rules'`
  and `:42` `assert.equal(RULES.length, 9);`; `:447` becomes:

```js
  assert.deepEqual(ids, [
    'cost_burn',
    'tool_loop',
    'agent_stuck',
    'accuracy_drop',
    'eval_pass_rate',
    'unsafe_content',
    'cost_anomaly',
  ]);
```

  and `:451` `assert.equal((await api().call('/api/monitors')).body.rules.length, 9, 'without the option nothing changes');`.

- [ ] **Step 9: Run the tests and see them pass**

Run: `node --test test/monitors-anomaly.test.js test/monitors-rules.test.js test/monitors-state.test.js test/monitors-engine.test.js test/monitors-api.test.js test/monitors-channels.test.js test/budgets-monitors.test.js test/cost-forecast-views.test.js`
Expected: PASS (9 new tests). `test/monitors-api.test.js` "monitors over HTTP: demo data…" still counts 7 demo
alerts: the demo gains its anomaly alert in Task 8.

- [ ] **Step 10: Check the style**

Run: `npx prettier@3 --check lib/monitors/rules.js lib/monitors/state.js lib/monitors/index.js lib/monitors/api.js test/monitors-anomaly.test.js test/monitors-rules.test.js test/monitors-api.test.js test/budgets-monitors.test.js`
Expected: `All matched files use Prettier code style!` (`server.js` differs on main at `:289` and `:1205`; check
`git diff -U0 server.js` shows only your lines.)

- [ ] **Step 11: Commit**

```bash
git add lib/monitors/rules.js lib/monitors/state.js lib/monitors/index.js lib/monitors/api.js server.js test/monitors-anomaly.test.js test/monitors-rules.test.js test/monitors-api.test.js test/budgets-monitors.test.js
git commit -m "Monitors: the cost_anomaly rule, one instance and one alert per day, without drivers in any channel"
```

---
### Task 6: The Overview page (shared: `public/costview.js`, `public/costcharts.js`, `public/styles.css`)

**Files:**
- Modify: `public/costcharts.js:134` (the forecast tooltip), `:205-215` (`costRingsHtml`)
- Modify: `public/costview.js:656` (helpers after the section mark), `:665-667` (`forecastSub`), `:708-715`
  (`burnMeta` and the returned markup), `:1377` (exports)
- Modify: `public/styles.css` (append after the last line, `:9707`)
- Modify: `test/cost-charts.test.js:63` (the tooltip without a model)
- Test: `test/cost-forecast-ui.test.js` (create)

**Interfaces:**
- Consumes: Task 4's answer (`forecastMethod`, `forecast.early`, `anomalies`, `anomalyParams`, `rings[i].runsOut`);
  `costMoney`, `costName`, `esc`, `panel`, `costDayLabel`, `costTip`, `costRingSvg`.
- Produces (browser globals, exported for Node):
  - `costForecastCaption(method) → string` (U1), `COST_FORECAST_CAPTION`.
  - `costAnomalyFigures(m) → "$18.40, usually $6.10 (3.0×)"`, `costDriverText(d, ctx) → string`,
    `costAnomaliesHtml(o, ctx) → html`, `costAnomalyMeta(params) → string`; `costAnomalyRow(label, m, ctx)` and
    `COST_ANOMALY_DAYS` (module scope, not exported).
  - `costRingsHtml(rings, more)`: a ring with `runsOut` gains `<small class="cost-ring-out">runs out ~21 Nov</small>`
    and the same words in its tooltip.
  - The Overview: the burn-down meta `day N of M · <caption>[ · band: 25th–75th percentile days]`; the forecast tile's
    sub "no forecast yet: the mean so far" without a model; the spike panel's meta "usage value, each day against the
    same weekday of the 4 weeks before it"; a panel "Anomalies" after the grid, its meta from `costAnomalyMeta`, linked
    to `#settings/monitors`.

- [ ] **Step 1: Write the failing test**

Create `test/cost-forecast-ui.test.js`:

```js
// Cost Control 4a in the browser files, without a browser: the Overview's forecast caption, Anomalies card and ring
// captions (public/costview.js, public/costcharts.js), a budget card's forecast line, and the bell line and Monitors
// card of cost_anomaly (public/monitorsview.js). Server and owner text reaches the markup through esc().
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/cost/views');
const { daysBetween } = require('../lib/cost/days');

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
const CTX = {
  measure: 'list',
  cur: 'USD',
  fmt: (v) => U.costMoney(v),
  centers: { client: 'Client: Acme' },
  keys: { key_a: 'ci-bot' },
};
const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  provider: 'openrouter',
  model: 'deepseek-chat',
  project: null,
  center: 'client',
  keyId: 'key_a',
  kind: 'chat',
  requests: 1,
  tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});

test('the burn-down caption names the forecast method', () => {
  assert.equal(U.costForecastCaption('weekday'), 'Forecast: weekday pattern of the last 4 weeks');
  assert.equal(U.costForecastCaption('mean'), 'Forecast: daily mean (little history yet)');
  for (const m of [null, undefined, 'toString', 'other']) assert.equal(U.costForecastCaption(m), 'No forecast yet');
});

test('anomaly rows: the figures against the usual amount, and drivers as text', () => {
  assert.equal(U.costAnomalyFigures({ spentUSD: 18.4, expectedUSD: 6.1 }), '$18.40, usually $6.10 (3.0×)');
  assert.equal(U.costAnomalyFigures({ spentUSD: 1.5, expectedUSD: 0 }), '$1.50, usually $0.00', 'no ratio over 0');
  const d = (dim, value, extraUSD, share, label = value) => ({ dim, value, label, extraUSD, share });
  assert.equal(U.costDriverText(d('model', 'claude-opus-5-5', 9.2, 0.75), CTX), 'claude-opus-5-5 · +$9.20 (75 %)');
  assert.equal(U.costDriverText(d('project', '~/Github/acme-web', 7, 0.57), CTX), '~/Github/acme-web · +$7.00 (57 %)');
  assert.equal(
    U.costDriverText(d('keyId', 'key_b', 5.1, 0.41, 'Acme client'), CTX),
    'Key: Acme client · +$5.10 (41 %)',
  );
  assert.equal(U.costDriverText(d('keyId', 'key_a', 1, 1, null), CTX), 'Key: ci-bot · +$1.00 (100 %)');
  assert.equal(U.costDriverText(d('center', 'client', 2, 0.5), CTX), 'Client: Acme · +$2.00 (50 %)');
  assert.equal(U.costDriverText(d('center', 'unassigned', 2, 0.5), CTX), 'Unassigned · +$2.00 (50 %)');
});

test('the Overview: caption, spike meta and an Anomalies card with today and yesterday, names escaped', () => {
  // Every day DeepSeek through key_a (1); yesterday (Wednesday the 21st) a project with a hostile name spends 6 more.
  const all = [
    ...daysBetween('2026-09-02', '2026-10-21').map((d) => row(d)),
    row('2026-10-21', { source: 'claude', model: EVIL, project: `~/${EVIL}`, keyId: null, listUSD: 6 }),
    row('2026-10-22', { listUSD: 0.5 }),
  ];
  const o = V.overview({
    rows: all.filter((r) => r.day >= '2026-10-01'),
    history: all.filter((r) => r.day < '2026-10-01'),
    today: '2026-10-22',
  });
  const html = U.costOverviewHtml(o, CTX);
  assert.match(html, /day 22 of 31 · Forecast: weekday pattern of the last 4 weeks · band: 25th–75th percentile days/);
  assert.match(html, /usage value, each day against the same weekday of the 4 weeks before it/);
  assert.match(html, /over 2× the usual amount and at least \$1\.00 more · usage value in USD/);
  assert.match(html, /<b>Yesterday<\/b><span class="cost-chip warn">Anomaly<\/span>/);
  assert.match(html, /\$7\.00, usually \$1\.00 \(7\.0×\)/);
  assert.match(html, /<li>&lt;img src=x onerror=alert\(1\)&gt; · \+\$6\.00 \(100 %\)<\/li>/);
  assert.match(html, /<b>Today \(so far\)<\/b><span class="cost-chip">Normal<\/span>/);
  assert.equal((html.match(/<li>/g) || []).length, 3, 'drivers only for the anomaly');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /href="#settings\/monitors"/);
  const young = U.costOverviewHtml(V.overview({ rows: [row('2026-10-01')], today: '2026-10-02' }), CTX);
  assert.match(young, /· No forecast yet</);
  assert.equal((young.match(/Not enough history/g) || []).length, 2);
  const lost = U.costOverviewHtml({ ...o, anomalies: null }, CTX);
  assert.match(lost, /The ledger history could not be read: no anomalies for now\./);
});

test('rings: a runs-out date in the caption and the tooltip; none when the forecast stays under', () => {
  const ring = (over) => ({
    id: 'team',
    name: EVIL,
    state: 'warn_50',
    tone: 'warn',
    percent: 60,
    projected: true,
    ...over,
  });
  const html = C.costRingsHtml([ring({ runsOut: '2026-11-21' })], 0);
  assert.match(html, /<small class="cost-ring-out">runs out ~21 Nov<\/small>/);
  assert.match(html, /data-tip="&lt;img src=x onerror=alert\(1\)&gt; · projected over · runs out ~21 Nov"/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(C.costRingsHtml([ring({ runsOut: null, projected: false })], 0), /runs out/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-forecast-ui.test.js`
Expected: FAIL, 4 tests: `TypeError: U.costForecastCaption is not a function` (and the like), and no ring caption.

- [ ] **Step 3: `public/costcharts.js`**

In `costBurnSvg`'s forecast tooltip (`:134`), `f.early ? 'early in the month' :` becomes `f.early ? 'no band yet' :`
(without a model the line is the mean so far, with no band). Replace the comment and `costRingsHtml` (`:205-215`,
through its closing `}`) with:

```js
// The Overview's compact rings, riskiest first (the server orders them), each linking to its card in Budgets. A ring
// whose forecast passes its amount within the period says when ("runs out ~21 Nov").
function costRingsHtml(rings, more) {
  if (!rings.length) return '';
  const items = rings.map((b) => {
    const href = `#cost/budgets?focus=${encodeURIComponent(b.id)}`;
    const state = b.tone === 'none' ? 'no data' : b.projected ? 'projected over' : b.state.replace('_', ' ');
    const out = typeof b.runsOut === 'string' ? `runs out ~${costDayLabel(b.runsOut)}` : '';
    const caption = out ? `<small class="cost-ring-out">${esc(out)}</small>` : '';
    return `<a class="cost-ring tone-${esc(b.tone)}" href="${esc(href)}" data-tip="${costTip([b.name, state, out])}">${costRingSvg(b.percent, b.tone, 58)}<span>${esc(b.name)}</span>${caption}</a>`;
  });
  if (more > 0) items.push(`<a class="cost-ring cost-more" href="#cost/budgets">+ ${more} more</a>`);
  return `<div class="cost-rings">${items.join('')}</div>`;
}
```

- [ ] **Step 4: `public/costview.js`**

After `/* ---------- Overview ---------- */` and its blank line (`:656-657`), add:

```js
// The burn-down's caption names how the forecast was made (lib/cost/forecast.js).
const COST_FORECAST_CAPTION = {
  weekday: 'Forecast: weekday pattern of the last 4 weeks',
  mean: 'Forecast: daily mean (little history yet)',
};
const costForecastCaption = (method) =>
  Object.hasOwn(COST_FORECAST_CAPTION, method || '') ? COST_FORECAST_CAPTION[method] : 'No forecast yet';

// A day's spend against its usual amount, in USD as the rule measures it: "$18.40, usually $6.10 (3.0×)".
function costAnomalyFigures(m) {
  const times = m.expectedUSD > 0 ? ` (${(m.spentUSD / m.expectedUSD).toFixed(1)}×)` : '';
  return `${costMoney(m.spentUSD, 'USD')}, usually ${costMoney(m.expectedUSD, 'USD')}${times}`;
}
// One driver as text: "claude-opus-5-5 · +$9.20 (75 %)", "Key: Acme client · +$5.10 (41 %)".
function costDriverText(d, ctx) {
  const name =
    d.dim === 'keyId'
      ? `Key: ${d.label || costName('keyId', d.value, ctx)}`
      : d.dim === 'center'
        ? costName('center', d.value, ctx)
        : String(d.label || d.value);
  const share = Number.isFinite(d.share) ? ` (${Math.round(d.share * 100)} %)` : '';
  return `${name} · +${costMoney(d.extraUSD, 'USD')}${share}`;
}
// The Anomalies card: today so far and yesterday, each with its figures, its state and, when it is an anomaly, up to 3
// drivers. Every figure and name is text (esc).
const COST_ANOMALY_DAYS = [
  ['today', 'Today (so far)'],
  ['yesterday', 'Yesterday'],
];
function costAnomalyRow(label, m, ctx) {
  if (!m)
    return `<div class="cost-anom tone-none"><div class="cost-anom-head"><b>${esc(label)}</b><span class="cost-chip">Not enough history</span></div></div>`;
  const drivers =
    m.anomaly && m.drivers.length
      ? `<ul class="cost-anom-drivers">${m.drivers.map((d) => `<li>${esc(costDriverText(d, ctx))}</li>`).join('')}</ul>`
      : '';
  return `<div class="cost-anom tone-${m.anomaly ? 'bad' : 'ok'}"><div class="cost-anom-head"><b>${esc(label)}</b><span class="cost-chip${m.anomaly ? ' warn' : ''}">${m.anomaly ? 'Anomaly' : 'Normal'}</span></div>
    <p class="cost-anom-fig">${esc(costAnomalyFigures(m))}</p>${drivers}</div>`;
}
function costAnomaliesHtml(o, ctx) {
  const link = '<p class="cost-note"><a href="#settings/monitors">Change the sensitivity in Monitors</a></p>';
  if (!o.anomalies)
    return `<p class="cost-note warn">The ledger history could not be read: no anomalies for now.</p>${link}`;
  const rows = COST_ANOMALY_DAYS.map(([k, label]) => costAnomalyRow(label, o.anomalies[k], ctx)).join('');
  return `<div class="cost-anoms">${rows}</div>${link}`;
}
// The card's meta line: the rule's parameters, as the server applied them.
function costAnomalyMeta(p) {
  const ratio = p && Number.isFinite(p.ratio) ? p.ratio : 2;
  const min = p && Number.isFinite(p.minUSD) ? p.minUSD : 1;
  return `over ${ratio}× the usual amount and at least ${costMoney(min, 'USD')} more · usage value in USD`;
}

```

In `costOverviewHtml`, replace `forecastSub` (`:665-667`) with:

```js
  const forecastSub = o.forecast.early
    ? 'no forecast yet: the mean so far'
    : `${fmt(o.forecast.low)} – ${fmt(o.forecast.high)}`;
```

Replace `burnMeta` and the returned markup (`:708-715`, through the closing `}` of `costOverviewHtml`) with:

```js
  const burnMeta = `day ${o.month.day} of ${o.month.days} · ${costForecastCaption(o.forecastMethod)}${o.forecast.early ? '' : ' · band: 25th–75th percentile days'}`;
  return `<div class="live-metrics">${tiles.join('')}</div>
    ${panel('Burn-down', esc(burnMeta), costBurnSvg(o, fmt) + noBudgets + add)}
    <div class="live-grid">
      ${panel('Daily spend and spikes', 'usage value, each day against the same weekday of the 4 weeks before it', costSpikeSvg(o.spikes, fmt))}
      ${panel('Budgets', o.budgetsError ? '' : esc(`${o.atRisk.count} at risk`), rings)}
    </div>
    ${panel('Anomalies', esc(costAnomalyMeta(o.anomalyParams)), costAnomaliesHtml(o, ctx))}`;
}
```

In the `module.exports` list, after `costOverviewHtml,` (`:1377`), add:

```js
    costForecastCaption,
    costAnomalyFigures,
    costDriverText,
    costAnomaliesHtml,
    costAnomalyMeta,
```

- [ ] **Step 5: `public/styles.css`**

Append at the end of the file:

```css
/* Cost Control 4a: a ring's runs-out date, the Overview's Anomalies card and a budget card's forecast line. */
.cost-ring .cost-ring-out {
  color: var(--warn-ink);
  font-size: 10.5px;
}
.cost-anoms {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
.cost-anom {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--h-edge);
  border-radius: 12px;
}
.cost-anom.tone-bad {
  border-color: var(--h-pink);
}
.cost-anom-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.cost-anom-fig {
  margin: 0;
  color: var(--h-text);
  font-size: 13px;
}
.cost-anom-drivers {
  margin: 0;
  padding-left: 18px;
  color: var(--h-muted);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 6: The tooltip test**

In `test/cost-charts.test.js` "burn-down: actual line, forecast, band only past the third day…" (`:63`),
`assert.match(early, /early in the month/);` becomes `assert.match(early, /no band yet/);`.

- [ ] **Step 7: Run the tests and see them pass**

Run: `node --test test/cost-forecast-ui.test.js test/cost-ui.test.js test/cost-charts.test.js test/cost-charts-value.test.js test/cost-budgets-ui.test.js`
Expected: PASS (4 new tests; the esc() audit and "every page script shares one global scope" in
`test/cost-ui.test.js` and the audit in `test/cost-charts.test.js` stay green).

- [ ] **Step 8: Check the style**

Run: `npx prettier@3 --check public/costview.js public/costcharts.js test/cost-forecast-ui.test.js test/cost-charts.test.js`
Expected: `All matched files use Prettier code style!` (`public/styles.css` differs on main at `:5242`; check
`git diff -U0 public/styles.css` shows only the appended block.)

- [ ] **Step 9: Commit**

```bash
git add public/costview.js public/costcharts.js public/styles.css test/cost-forecast-ui.test.js test/cost-charts.test.js
git commit -m "Cost Overview page: the forecast caption, the Anomalies card and the runs-out date on each ring"
```

---
### Task 7: The Budgets card, the bell and the Monitors card (shared: `public/costview.js`, `public/monitorsview.js`, `public/styles.css`)

**Files:**
- Modify: `public/costview.js:951` (helpers before `costBudgetCardHtml`), `:965` (the line after `figures`), `:973`
  (the card markup), `:1370` (exports)
- Modify: `public/monitorsview.js:37` (`MON_PARAMS`), `:82` (`MON_MEASURE`), `:161-162` (a branch in `alertLine`),
  `:559` (`monAlertRow`), `:933-935` (`monRuleNow`), `:1275` (exports)
- Modify: `public/styles.css` (append)
- Test: `test/cost-forecast-ui.test.js` (append)

The bell's rows are built in `public/monitorsview.js` (`alertLine`, `monAlertRow`; `public/app.js` only mounts the
bell with `monMountBell()`), so `app.js` does not change.

**Interfaces:**
- Consumes: Task 3's `forecastUSD`, `runsOut`, `amount`, `amountUSD`, `currency` on a budget view; Task 5's `usual`
  and `title` on a `cost_anomaly` alert row and the rule row's `params`, `defaults` and `instances`; `costIsDay`,
  `costMoney`, `COST_MONTH`; `monText`, `monUSD`, `monNum`, `monMeasure`, `MON_STATE`.
- Produces:
  - `costForecastLine(b) → string` (U1; empty without a forecast, once used up or without data), exported;
    `costShortDay(day) → "21 Nov"`. A Budgets card shows the line as `<p class="cost-card-forecast">` under its spent
    figure; the `projected` chip keeps its look.
  - `alertLine(a)` for `rule: 'cost_anomaly'`: `{ kind: 'change', tone: 'bad' | 'good', change: 'Triggered' |
    'Resolved' | …, measure: 'Wed 28 Oct (so far): $18.40, usual $6.10', session: null, costHref: '#cost', text }`,
    `text` = "Cost anomaly · Wed 28 Oct (so far): $18.40, usual $6.10" for a trigger (the change word is added for any
    other state). `monAlertRow` renders `costHref` as "Open in Cost Control →".
  - `MON_PARAMS.ratio` ("Times the usual amount", step 0.1) and `MON_PARAMS.minUSD` ("Minimum rise (USD)", step 0.5);
    `MON_MEASURE.cost_anomaly` ("$18.40 spent against an anomaly level of $12.20").
  - `monRuleNow(r)` for `cost_anomaly`: each titled day, today first, "<title>: <measure>" or "<title>: not enough
    history", joined by " · ". `monRuleNow` and `monAlertRow` are exported.

- [ ] **Step 1: Write the failing tests**

Append to `test/cost-forecast-ui.test.js`:

```js

/* ---------- Budgets, the bell and the Monitors card ---------- */

const M = require('../public/monitorsview');
const budgetView = (over = {}) => ({
  id: 'team',
  name: 'Team',
  scope: 'global',
  period: 'month',
  amount: 500,
  currency: 'USD',
  measure: 'list',
  thresholds: [50, 80],
  projection: true,
  enforce: 'none',
  legacy: null,
  from: '2026-11-01',
  to: '2026-11-30',
  state: 'warn_50',
  projected: false,
  spent: 260,
  amountUSD: 500,
  percent: 52,
  forecastUSD: 412,
  runsOut: null,
  reason: null,
  ...over,
});

test('a budget card: the runs-out date, or that it stays under with the forecast in its currency, or nothing', () => {
  assert.equal(
    U.costForecastLine(budgetView({ runsOut: '2026-11-21', forecastUSD: 640 })),
    'Runs out ~21 Nov at this pace',
  );
  assert.equal(U.costForecastLine(budgetView()), 'Stays under the amount this period (forecast $412.00)');
  assert.equal(
    U.costForecastLine(budgetView({ currency: 'IDR', amount: 1650000, amountUSD: 100, forecastUSD: 50 })),
    'Stays under the amount this period (forecast IDR 825,000)',
  );
  for (const over of [{ forecastUSD: null }, { state: 'exceeded', forecastUSD: 700 }, { state: 'no_data' }])
    assert.equal(U.costForecastLine(budgetView(over)), '', JSON.stringify(over));
  const card = U.costBudgetCardHtml(
    budgetView({ name: EVIL, runsOut: '2026-11-21' }),
    { centers: {}, keys: {} },
    false,
  );
  assert.match(card, /<p class="cost-card-forecast">Runs out ~21 Nov at this pace<\/p>/);
  assert.doesNotMatch(card, /<img/);
  assert.doesNotMatch(U.costBudgetCardHtml(budgetView({ forecastUSD: null }), {}, false), /cost-card-forecast/);
});

test('the bell: a cost anomaly reads its day, spend and usual amount, and links to the Overview', () => {
  const a = (over) => ({
    id: 'a1',
    ts: null,
    rule: 'cost_anomaly',
    ruleTitle: 'Cost anomaly',
    instance: 'x',
    sessionKey: null,
    title: 'Wed 28 Oct (so far)',
    value: 18.4,
    threshold: 12.2,
    usual: 6.1,
    state: 'triggered',
    previous: null,
    ...over,
  });
  const l = M.alertLine(a(), []);
  assert.equal(l.text, 'Cost anomaly · Wed 28 Oct (so far): $18.40, usual $6.10');
  assert.deepEqual([l.change, l.tone, l.costHref, l.session], ['Triggered', 'bad', '#cost', null]);
  const row = M.monAlertRow(l, false);
  assert.match(row, /<a class="mon-session" href="#cost">Open in Cost Control →<\/a>/);
  assert.match(row, /<div class="mon-measure">Wed 28 Oct \(so far\): \$18\.40, usual \$6\.10<\/div>/);
  const ok = M.alertLine(a({ state: 'ok', previous: 'triggered', title: 'Tue 27 Oct', value: 3, usual: 2 }), []);
  assert.equal(ok.text, 'Cost anomaly · Resolved · Tue 27 Oct: $3.00, usual $2.00');
  assert.equal(M.alertLine(a({ usual: null }), []).text, 'Cost anomaly · Wed 28 Oct (so far): $18.40');
  assert.doesNotMatch(M.monAlertRow(M.alertLine(a({ title: EVIL }), []), false), /<img/);
});

test('the Monitors card: the two parameters, and each day today first', () => {
  const rule = {
    id: 'cost_anomaly',
    title: 'Cost anomaly',
    describe: "Today's or yesterday's spend is well above what the same weekday usually costs.",
    kind: 'aggregate',
    enabled: true,
    state: 'triggered',
    params: { ratio: 2, minUSD: 1 },
    defaults: { ratio: 2, minUSD: 1 },
    autoPause: false,
    mayAutoPause: false,
    instances: [
      { title: 'Tue 27 Oct', state: 'ok', value: 3, threshold: 4 },
      { title: 'Wed 28 Oct (so far)', state: 'triggered', value: 18.4, threshold: 12.2 },
      { title: null, state: 'no_data', value: null, threshold: null },
    ],
  };
  const html = M.monRuleCard(rule, { pause: false });
  assert.match(html, /Times the usual amount<input[^>]*data-mon-param="ratio"/);
  assert.match(html, /Minimum rise \(USD\)<input[^>]*data-mon-param="minUSD"/);
  assert.equal(
    M.monRuleNow(rule),
    'Wed 28 Oct (so far): $18.40 spent against an anomaly level of $12.20 · Tue 27 Oct: $3.00 spent against an anomaly level of $4.00',
  );
  const young = {
    ...rule,
    instances: [{ title: 'Wed 28 Oct (so far)', state: 'no_data', value: null, threshold: null }],
  };
  assert.equal(M.monRuleNow(young), 'Wed 28 Oct (so far): not enough history');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/cost-forecast-ui.test.js`
Expected: FAIL, 3 tests: `TypeError: U.costForecastLine is not a function`, `M.monAlertRow is not a function`, and
no `ratio` input on the card.

- [ ] **Step 3: `public/costview.js`, the Budgets card**

Before `function costBudgetCardHtml(b, ctx, locked) {` (`:951`), add:

```js
// A budget's forecast line (lib/cost/budgets.js forecastUSD and runsOut): the day it runs out at this pace, or that it
// stays under its amount, with the forecast in the budget's currency; nothing without a forecast or once used up.
const costShortDay = (day) => `${Number(day.slice(8))} ${COST_MONTH[Number(day.slice(5, 7)) - 1]}`;
function costForecastLine(b) {
  if (!b || b.state === 'no_data' || b.state === 'exceeded') return '';
  if (costIsDay(b.runsOut)) return `Runs out ~${costShortDay(b.runsOut)} at this pace`;
  if (typeof b.forecastUSD !== 'number' || !Number.isFinite(b.forecastUSD)) return '';
  const rate = b.amountUSD > 0 ? b.amount / b.amountUSD : 1;
  return `Stays under the amount this period (forecast ${costMoney(b.forecastUSD * rate, b.currency)})`;
}
```

In `costBudgetCardHtml`, after the `figures` statement (it ends at `:965`), add:

```js
  const line = costForecastLine(b);
  const forecast = line ? `<p class="cost-card-forecast">${esc(line)}</p>` : '';
```

In the card markup (`:973`), `<p>${esc(costPeriodLabel(b))}</p>${figures}<div class="cost-chips">` becomes
`<p>${esc(costPeriodLabel(b))}</p>${figures}${forecast}<div class="cost-chips">`. In the `module.exports` list, after
`costBudgetCardHtml,` (`:1370`), add `costForecastLine,`.

- [ ] **Step 4: `public/monitorsview.js`**

After `windowMin: { label: 'Window (minutes)', step: '1' },` (`:37`), add:

```js
  ratio: { label: 'Times the usual amount', step: '0.1' }, // cost_anomaly
  minUSD: { label: 'Minimum rise (USD)', step: '0.5' }, // cost_anomaly
```

After the `unsafe_content` entry of `MON_MEASURE` (`:82`), add:

```js
  cost_anomaly: [(v) => `${monUSD(v)} spent`, 'against an anomaly level of', monUSD],
```

In `alertLine`, between the end of the `budget` branch (`:161`, `line.budgetHref = …;`) and `} else {` (`:162`), add:

```js
  } else if (a.rule === 'cost_anomaly') {
    // "Cost anomaly · Wed 28 Oct (so far): $18.40, usual $6.10", linked to the Cost Control Overview.
    const st = typeof a.state === 'string' ? a.state : '';
    const day = monText(a.title, MON_MAX_TITLE);
    const figures = monNum(a.value) ? `${monUSD(a.value)}${monNum(a.usual) ? `, usual ${monUSD(a.usual)}` : ''}` : '';
    const change = st === 'triggered' ? 'Triggered' : st === 'ok' ? 'Resolved' : MON_STATE[st] || 'Changed';
    const measure = [day, figures].filter(Boolean).join(': ');
    line = { ...base, kind: 'change', tone: st === 'triggered' ? 'bad' : 'good', change, measure, session: null };
    line.costHref = '#cost';
    line.text = [line.title, st === 'triggered' ? '' : change, measure].filter(Boolean).join(' · ');
    return line;
```

In `monAlertRow` (`:559`), after
`${l.budgetHref ? `<a class="mon-session" href="${esc(l.budgetHref)}">Open in Budgets →</a>` : ''}` add
`${l.costHref ? `<a class="mon-session" href="${esc(l.costHref)}">Open in Cost Control →</a>` : ''}` (before
`</div>${time}</div>`).

In `monRuleNow`, after `const inst = Array.isArray(r.instances) ? r.instances : [];` (`:935`), add:

```js
  // cost_anomaly: one instance per day, today first ("Wed 28 Oct (so far): $18.40 spent against …").
  const days = r.id === 'cost_anomaly' ? inst.filter((i) => monText(i.title, 40)) : [];
  if (days.length)
    return days
      .slice()
      .reverse()
      .map(
        (i) =>
          `${monText(i.title, 40)}: ${i.state === 'no_data' ? 'not enough history' : monMeasure(r.id, i.value, i.threshold) || MON_STATE[i.state] || ''}`,
      )
      .join(' · ');
```

(The API lists a rule's instances in the order of their raw ids, so a day's instances come oldest first; `'all'`, the
no-snapshot instance, has no title and is left out.) In the `module.exports` list, after `monRuleCard,` (`:1275`), add
`monRuleNow,` and `monAlertRow,`.

- [ ] **Step 5: `public/styles.css`**

Append at the end of the file:

```css
.cost-card .cost-card-forecast {
  color: var(--h-text);
}
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/cost-forecast-ui.test.js test/cost-ui.test.js test/cost-budgets-ui.test.js test/monitors-ui.test.js test/budgets-demo-ui.test.js`
Expected: PASS (7 tests in `test/cost-forecast-ui.test.js`; the esc() audits of `costview.js` and `monitorsview.js`
stay green).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check public/costview.js public/monitorsview.js test/cost-forecast-ui.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 8: Commit**

```bash
git add public/costview.js public/monitorsview.js public/styles.css test/cost-forecast-ui.test.js
git commit -m "Budgets cards say when a budget runs out; the bell and Monitors show cost anomalies"
```

---
### Task 8: The demo, the docs and the whole suite (shared: `lib/demo.js`, `docs/cost.md`, `docs/monitors.md`)

**Files:**
- Modify: `lib/demo.js` `monitorsDemo` (`:1262`, `:1290`, `:1306`), `costDemo` (after the day loop, `:1639-1641` on
  `098fa77`; about `:1649-1651` after Task 3)
- Modify: `test/monitors-api.test.js:861` (the demo has one more alert)
- Modify: `docs/cost.md:200-201`, `:307`, `:321`, `:334-337`, before `:388`, `:479`, `:481`, `:510`;
  `docs/monitors.md:9`, `:21`, `:25`, `:40`, `:190`
- Test: `test/cost-forecast-http.test.js` (create; ports 9400–9599)

**Interfaces:**
- Consumes: everything above; `RULES`, `evaluate` (`lib/monitors/rules.js`); `recentDays` (`lib/cost/anomaly.js`).
- Produces:
  - `costDemo(now)`: yesterday gains 400 Sonnet calls through the Acme key (`key_demo0acme01`, "Acme client") and 60
    Opus requests on `~/acme-web`, so yesterday is an anomaly (about $8.92 against a usual $3.08 on the fixed demo
    draws) with the Acme center, the Acme key and Sonnet as its drivers, and today is normal. The rest of the demo
    month is unchanged (the burst draws nothing from the seeded `r`).
  - `monitorsDemo(now)`: the seeded store gains the rule's two day instances, evaluated by the rule from the demo
    ledger, and the alert of yesterday's anomaly (with `title` and `usual`), oldest first.

- [ ] **Step 1: Write the failing test**

Create `test/cost-forecast-http.test.js`:

```js
// Cost Control 4a over HTTP: a spawned demo server.js answers the forecast and the anomalies on the Overview, the
// budgets' forecast fields, the cost_anomaly rule card and its alert, path-free. Demo mode reads no logs, makes no
// calls and sends no notification. Ports 9400-9599 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-forecast-http-'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 9400 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
async function startServer(env) {
  const data = tmp();
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
        // Trust the answer only once this child is seen still running (another server may hold the port).
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

test('demo over HTTP: the forecast, yesterday’s anomaly with a named key, the budgets’ forecast and the rule', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const bodies = [];
  const call = async (p) => {
    const r = await fetch(s.base + p, { signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    bodies.push(text);
    return { status: r.status, json: JSON.parse(text) };
  };
  try {
    const o = await call('/api/cost/view?page=overview');
    assert.equal(o.status, 200);
    assert.equal(o.json.forecastMethod, 'weekday', 'the demo ledger holds 30 days');
    assert.deepEqual(o.json.anomalyParams, { ratio: 2, minUSD: 1 });
    const y = o.json.anomalies.yesterday;
    assert.equal(y.anomaly, true, "yesterday's spike");
    assert.ok(y.spentUSD > 2 * y.expectedUSD);
    assert.ok(
      y.drivers.some((d) => d.dim === 'keyId' && d.label === 'Acme client'),
      'the key by its name',
    );
    assert.equal(o.json.anomalies.today.anomaly, false);
    assert.ok(
      o.json.spikes.some((x) => x.spike),
      'the spike line marks it',
    );
    assert.ok(o.json.rings.every((r) => 'runsOut' in r));
    const b = await call('/api/cost/budgets');
    assert.ok(b.json.budgets.every((v) => 'forecastUSD' in v && 'runsOut' in v));
    const rules = (await call('/api/monitors')).json.rules;
    const rule = rules.find((r) => r.id === 'cost_anomaly');
    assert.deepEqual([rule.title, rule.params, rule.state], ['Cost anomaly', { ratio: 2, minUSD: 1 }, 'triggered']);
    assert.equal(rule.instances.length, 2);
    const alert = (await call('/api/alerts')).json.alerts.find((a) => a.rule === 'cost_anomaly');
    assert.equal(alert.title, rule.instances.find((i) => i.state === 'triggered').title);
    assert.equal(alert.usual, Math.round(y.expectedUSD * 100) / 100);
    for (const body of bodies) assert.doesNotMatch(body, PATHS);
    assert.doesNotMatch(JSON.stringify(alert), /drivers|acme-web/);
  } finally {
    await s.stop();
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-forecast-http.test.js`
Expected: FAIL: `yesterday's spike` (the demo month has no anomaly yet).

- [ ] **Step 3: `lib/demo.js`, yesterday's spike**

In `costDemo`, after the closing `}` of `for (const day of daysBetween(start, today)) { … }` (the line after
`add(day, ev('gateway', 'groq', 'llama-3.3-70b', …), n(5));`), add:

```js
  // Yesterday's spike (Cost Control 4a): a busy Acme key and an Opus burst on ~/acme-web, so the Overview's Anomalies
  // card and spike line, and the cost_anomaly rule, have a day to show. It draws nothing from `r`, so every other day
  // keeps its amounts.
  const yesterday = addDays(today, -1);
  add(
    yesterday,
    ev('gateway', 'openrouter', 'claude-sonnet-5-5', null, 'key_demo0acme01', null, 'chat', 1800, 500),
    400,
  );
  add(yesterday, ev('claude', 'anthropic', 'claude-opus-5-5', '~/acme-web', null, null, 'chat', 3000, 900, 60000), 60);
```

- [ ] **Step 4: `lib/demo.js`, the rule in the demo Monitors store**

In `monitorsDemo`, after `const MIN = 60000;` (`:1262`), add:

```js
  // cost_anomaly (Cost Control 4a): the demo ledger's yesterday and today, as the engine's rule reads them.
  const { RULES, evaluate } = require('./monitors/rules');
  const { recentDays } = require('./cost/anomaly');
  const today = require('./cost/days').dayOf(now);
  const costAnomaly = recentDays(costDemo(now).rows, { today });
  const anomalies = evaluate(RULES.find((r) => r.id === 'cost_anomaly'), {}, { costAnomaly }, now);
```

After `entry('unsafe_content', 'all', null, 'triggered', 1, 1, null, 50),` (`:1290`), add:

```js
    // cost_anomaly (Cost Control 4a): yesterday's spike and today, as the rule reads the demo ledger.
    ...anomalies.map((r) => entry('cost_anomaly', r.instance, null, r.state, r.value, r.threshold, r.title, 600)),
```

At the start of the `alerts` list (`:1306`, right after `const alerts = [`), add:

```js
    // The alert of yesterday's cost anomaly, with its usual amount for the bell.
    ...anomalies
      .filter((r) => r.state === 'triggered')
      .map((r) => ({
        ...change(600, 'cost_anomaly', 'triggered', null, r.value, r.threshold),
        instance: r.instance,
        title: r.title,
        usual: r.usual,
      })),
```

In `test/monitors-api.test.js` "monitors over HTTP: demo data, demo actions, validation" (`:861`), the count becomes:

```js
    assert.equal(alerts.length, 8); // five monitor alerts, two budget alerts and a cost anomaly (lib/demo.js)
```

- [ ] **Step 5: Run the demo tests and see them pass**

Run: `node --test test/cost-forecast-http.test.js test/monitors-api.test.js test/budgets-demo-ui.test.js test/cost-view-api.test.js test/cost-budgets-ui.test.js`
Expected: PASS.

- [ ] **Step 6: `docs/cost.md`**

In `### States and alerts` of Budgets (`:200-201`), "From 25 % of its period, it is also `projected` when its current
pace would pass the amount." becomes "From 25 % of its period, it is also `projected` when its forecast at the
period's end passes the amount (see [Forecast and anomalies](#forecast-and-anomalies)); while the ledger is too young
for a forecast, when its pace so far would."

In `### Budget API`, the `GET /api/cost/budgets` row (`:307`) becomes:

```md
| `GET /api/cost/budgets` | `{ budgets, error, reasons, guard: { error, problems }, kept: { error } }`; each budget includes its period, spent, percent, state and projection, `forecastUSD` (the forecast at the period's end, or null) and `runsOut` (the day the forecast passes the amount within the period, or null; null once exceeded) |
```

In `## Cost Control menu`, the Overview row (`:321`) becomes:

```md
| Overview (`#cost`) | How much this month, and is it safe? | Month to date in both measures; the forecast by weekday with its band (see [Forecast and anomalies](#forecast-and-anomalies)); the global monthly budgets as lines; daily spend against the same weekday; today's and yesterday's anomalies with what drove them; budget rings, riskiest first, with the day each runs out |
```

Replace the **Spikes.** paragraph (`:334-337`) with:

```md
**Forecast, spikes and anomalies.** See [Forecast and anomalies](#forecast-and-anomalies). The burn-down still includes
plan fees, under "Paid".
```

At the end of the **Budgets page.** list (after "- The badge on the menu counts the budgets used up or projected
over."), add:

```md
- Each card says when the budget runs out at this pace ("Runs out ~21 Nov at this pace"), or that it stays under its
  amount with the forecast ("Stays under the amount this period (forecast $412.00)"); nothing without a forecast or
  once it is used up. An Overview ring shows the same date ("runs out ~21 Nov").
```

Before `### Settings page` (`:388`), add:

```md
### Forecast and anomalies

One forecast serves the burn-down, the budgets' `projected` state and the day each budget runs out, so the Overview
and the budgets never disagree.

- **The model.** The mean spend of each weekday over the last 4 weeks of finished days (today is not one), in the
  chosen measure, plan fees left out. A day before the ledger's first row is unknown, not zero, and so is a day of a
  month that did not read; a known day without spend is a zero. With 7 or more known days each weekday has its own
  mean (a weekday without a known day takes the overall mean). With 3 to 6 the forecast is the plain daily mean. With
  fewer there is none.
- **The line.** Today is never forecast below what it has spent already; each later day adds its weekday's mean.
  Under "Paid" each day to come also adds its plan fees exactly, at the billing in force now. The band is the 25th to
  75th percentile of how far the known days fell from their weekday's mean, applied to usage only. The burn-down's
  caption names the method: "Forecast: weekday pattern of the last 4 weeks", "Forecast: daily mean (little history
  yet)" or "No forecast yet" (the line is then the mean of the month's days so far, without a band).
- **Budgets.** From 25 % of its period a budget is `projected` when the forecast at the period's end passes its
  amount; without a forecast, when its pace so far would. A day budget forecasts today only. `runsOut` is the first day
  the forecast passes the amount, shown only inside the period and not once the budget is used up.
- **Anomalies.** A day is an anomaly when its usage value (list; plan fees are not usage) is more than `ratio` times
  its weekday's usual amount over the 4 weeks before it, and at least `minUSD` more: the parameters of the Monitors
  rule [`cost_anomaly`](monitors.md#rules), 2 and $1 by default. A usual amount of $0 needs `minUSD`. The spike line
  marks each day of the month this way and draws that usual amount as its baseline, so the chart and the alerts
  agree. The **Anomalies** card shows today so far and yesterday whole: the spend against the usual amount ("$18.40,
  usually $6.10 (3.0×)"), Anomaly, Normal or "Not enough history", and, for an anomaly, up to 3 values that rose the
  most across models, projects, cost centers and keys, each with its rise and its share of the day's rise. Its figures
  are in USD, as the rule's. It links to Settings → Monitors to change the sensitivity.
- **What stays in the dashboard.** The drivers can name projects and keys, so only `GET /api/cost/view` carries them.
  The rule's alerts, the desktop notification and the webhook carry the day, its spend, the threshold and the usual
  amount only.
- **When the history does not read.** The Overview answers `forecastMethod: null` and `anomalies: null` and draws the
  rest; the rule reports `no_data`.

```

The `GET /api/cost/view` row of `## API` (`:479`) gains, before "400 for an unknown page": "The Overview also answers
`forecastMethod` (`weekday`, `mean` or null), `anomalies: { today, yesterday }` (each `{ day, partial, spentUSD,
expectedUSD, anomaly, drivers: [{ dim, value, label, extraUSD, share }] }` or null; `label` is a key's name for
`keyId`; null when the history did not read), `anomalyParams: { ratio, minUSD }` and `runsOut` on each ring." The
`GET /api/cost/budgets` row (`:481`) becomes "the budgets in force, their state and forecast (`forecastUSD`,
`runsOut`), list warnings, guard problems and kept-file status".

At the end of `## Demo mode` (`:510`), append: "Yesterday has a spike (a busy Acme key and an Opus burst on
`~/acme-web`), so the Overview shows an anomaly and the Monitors page and the bell show its `cost_anomaly` alert."

- [ ] **Step 7: `docs/monitors.md`**

"Six rules ship with ZAAFPulse." (`:9`) becomes "Seven rules ship with ZAAFPulse.". After the `unsafe_content` row
(`:21`), add:

```md
| `cost_anomaly` | Today's or yesterday's spend is well above what the same weekday usually costs (see [Forecast and anomalies](cost.md#forecast-and-anomalies)) | `ratio`: 2, `minUSD`: 1 | yes | no |
```

After the first note (`:25`, "Rules are either **live** …"), add:

```md
- `cost_anomaly` has one instance per day, named by its date: yesterday, checked whole, and today, checked so far
  ("Wed 28 Oct (so far)"). It is checked after each index refresh, from the ledger. A day alerts at most once: no
  reminder, and the whole-day check of a day that already alerted on its partial check sends nothing. A day before
  yesterday leaves the card and the counts without a resolution. It reports `no_data` until the ledger has 3 known
  days. The alert carries the day's spend (value), `ratio` × its usual amount (threshold) and the usual amount; the
  models, projects, centers and keys behind it are shown on the Cost Control Overview only.
```

In `## States and alerts`, the reminder line (`:40`) becomes "- a triggered instance **stays triggered**: a reminder
every 30 minutes (not for `cost_anomaly`);". In `## Known limits` (`:190`), "- **No statistical detection.** The rules
compare numbers to limits. They do not learn a baseline." becomes "- **Little statistical detection.** The rules
compare numbers to limits; only `cost_anomaly` learns a baseline, the mean of each weekday over 4 weeks."

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS on this machine (the scratch copy of this plan: 2018 tests, 2016 pass, 2 skipped, 0 fail). CI runs the
same on Ubuntu, macOS and Windows.

- [ ] **Step 9: Check the style**

Run: `npx prettier@3 --check test/cost-forecast-http.test.js test/monitors-api.test.js`
Expected: `All matched files use Prettier code style!` (`lib/demo.js` differs on main: check `git diff -U0 lib/demo.js`
shows only your lines and none passes 120 columns.)

- [ ] **Step 10: Commit**

```bash
git add lib/demo.js test/cost-forecast-http.test.js test/monitors-api.test.js docs/cost.md docs/monitors.md
git commit -m "Demo and docs: yesterday's cost anomaly, the forecast and the cost_anomaly rule"
```

---
## Decisions made while planning

The spec left these open, or a detail of it did not fit the code; each is built and tested as written here.

1. **`dailyModel` takes `unread`** (the spec's signature has `today` and `weeks` only): "a month that did not read is
   not taken as zero" needs the model to know which months to leave out. `'folder'` or `'corrections'` in it (nothing
   read as it should) gives no model.
2. **The model carries `days`**, its known days. The drivers compare a value with its mean over the same known days of
   the same weekday; under the plain mean, or for a weekday without a known day, over all known days, as the model
   itself does. So within one dimension the values' means add up to the expected amount.
3. **Today's plan fee is not added again.** The reader bills today's plan row already (`billedRows` makes plan rows up
   to today), so it is in `spentSoFar`; `planPerDay` is asked from tomorrow on. Adding it for today (the spec's "each
   day also adds") would count it twice.
4. **Each checked day has its own model**, the 4 weeks before it, so a spike never lifts its own expected amount and
   the whole-day check of a day uses the same model as its partial check. Hence `recentDays` reads `[today − 29,
   today]` and the Overview's `history` is the 29 days before the 1st (`HISTORY_DAYS = 29`); the forecast still uses
   only `[today − 28, today − 1]` (the model cuts its own window). The budget service reads the 28 days before today.
5. **The spike line uses the usage value whatever the measure**, so it marks what the rule (list) marks; it followed
   the chosen measure before. Each day of the month is checked against its own model, as the rule would have checked
   it. The panel's meta says "usage value".
6. **Without a model the burn-down keeps its old line** (the mean of the elapsed days, today counted whole) without a
   band: this plan reads "the flat line it was before" as that line. `forecast.early` keeps meaning "no band"; the
   tooltip says "no band yet" and the forecast tile "no forecast yet: the mean so far".
7. **`forecast.perDay`** is kept in the answer's shape: the forecast's mean spend of a day after today. No page reads
   it.
8. **Scope filtering of the history happens in `evaluateBudget`** (pure and tested), not in the budget service as the
   spec words it; the service passes the cached window as it is.
9. **Plan fees come from a new cost method, `planFeeFor(source, day)`**: the billing history's `billingFor` gives a day
   to come the billing in force now. A budget adds the fees of the sources whose plan rows it counts (global, or that
   source), as `inScope` already decides for plan rows.
10. **`forecastUSD` and `runsOut` are set even with `projection: false`**; only `projected` follows the switch.
11. **The Anomalies card shows USD** in every currency: the rule, its `minUSD` and its notifications are in USD, and the
    card says "usage value in USD". The spike line converts, as before.
12. **One alert per day needs `remind: false`.** The state store re-alerts a triggered instance every 30 minutes and
    after a `no_data` flap; a rule with `remind: false` (only `cost_anomaly`) alerts on a change of state only. When a
    snooze ends, an anomaly already announced stays quiet and one held back by the snooze is sent once (other rules
    keep "start afresh").
13. **Alerts carry `usual`.** The bell's "usual $6.10" is the expected amount, which value and threshold cannot give
    once the ratio changes. It is a number, stored with the alert and listed by `/api/alerts`; the webhook keeps its
    seven fields.
14. **Without a snapshot the rule answers one `'all'` instance**, `no_data`, as the other aggregate rules do; the card
    lists only dated instances.
15. **Parameter bounds:** `ratio` above 1 up to 100 (at 1 or below every day over its usual amount would count),
    `minUSD` above 0 up to 1,000,000. The rule's `withDefaults` treats both as positive-only.
16. **Driver values:** a center the rules did not set reads `unassigned`; a row without a model, project or key is not
    a value of that dimension (a gateway call has no project); `share` is rounded to 4 decimals; `label` is the key's
    name from the gateway key list for a `keyId` (the id when unnamed), else the value (the page names centers from
    its settings).
17. **Every driver shows its share**, keys included ("Key: Acme client · +$5.10 (41 %)"); the spec's key example
    omits it.
18. **The Anomalies card is a full-width panel** right after the grid that holds the spike line and the rings.
19. **The provider runs in the aggregate pass** (after each index refresh), as the spec's mechanism says; the ledger
    pass also runs after each index refresh, on its own, so the rule reads the ledger at most one refresh behind.
20. **Demo:** the rule's demo states and alert are computed by the rule's own check from the demo ledger, and the team
    budget's demo alert takes `projected` from evaluating that budget (`demoTeamProjected`), since the forecast decides
    it now. The spike adds no draw from the seeded generator, so the rest of the demo month is unchanged.
21. **`views.js` drops `SPIKE_RATIO`, `SPIKE_MIN_USD` and `BASELINE_MIN`**; `quantile` moves to `forecast.js` and stays
    exported from `views.js`.
22. **Ports 9400–9599** for the spawned server of `test/cost-forecast-http.test.js`.

## Spec points that do not fit, for the owner

1. **`#monitors` does not exist.** The Monitors rules live in Settings (`#settings/monitors`, which
   `public/monitorsview.js` scrolls to). The Anomalies card links there.
2. **Instances that are no longer reported are not dropped by `lib/monitors/state.js`.** It keeps them, still counted,
   until a day after they were last seen (`PRUNE_MS`); ended live sessions are hidden by `isEndedSession` in
   `lib/monitors/index.js`, which the API and the engine's counts use. The smallest change is there: a `cost_anomaly`
   day before yesterday counts as ended (off the cards and the counts, no resolution), and the store still prunes it a
   day later. `state.js` changes only for the reminder (decision 12) and `usual` (decision 13).
3. **"Checked after each ledger pass"** and "built in the engine's aggregate snapshot" differ in this code: the
   aggregate pass and the ledger pass both follow each index refresh but are not chained. The plan follows the
   snapshot mechanism (decision 19).
4. **The spike line under "Paid"** followed the measure; for the chart and the notifications to agree it now draws the
   usage value (decision 5).

## Self-review

**Spec coverage** (spec section → task):
- Decisions table: one forecast everywhere → Tasks 1, 3, 4; weekday model with mean fallback and none below 3 → Task 1;
  the rule `cost_anomaly` after each pass, per day, desktop and webhook with snooze, drivers by dimension, one rule on
  the total → Tasks 2, 5; two pure modules wired into views, budgets, service, rules and pages → Tasks 1–7.
- Defaults: list value without plan fees → Task 2 (`usage`), Task 4 (spikes); plan fee exact per day, Paid only →
  Tasks 1, 3, 4; < 7 mean, < 3 none → Task 1; `projected` from 25 % → Task 3; runs-out only inside the period → Task 3;
  one alert per day, instance the day → Task 5.
- Section 1 (`dailyModel` input, window, known days, methods, band; `project` today, later days, plan fees, band,
  rounding, null model; `runsOut`) → Task 1 and its tests.
- Section 2 (Overview line and band from `project`, `history`, `planPerDay` under billed, `forecastMethod`, young
  ledgers, `BAND_MIN_DAYS` gone, API passes `history` for `before`; budgets' `history`, `projected`, linear fallback,
  day budgets, `forecastUSD`, `runsOut`, `noDataView`; the service's cached window counted in `MAX_WINDOWS`, filtered
  by scope, plan rows dropped) → Tasks 3, 4.
- Section 3 (`measureDay` rows, expected, null model, partial, drivers by four dimensions, `extraUSD`, `share` capped,
  top 3 with ties, none when not over, `~` project and key id; `isAnomaly` both thresholds and expected 0; the rule's
  definition, check, per-day instances, states, value, threshold, titles, one alert per day, dropped instances (the
  state.js check, Spec points 2), the snapshot provider, no cost object, demo without notifications, channels without
  drivers, settings with two parameters, off and snooze) → Tasks 2, 5, 8.
- Section 4 (burn-down caption; spike line by `isAnomaly` with the saved or default parameters and the expected
  baseline; Anomalies card rows, states, drivers, no drivers when normal, link; ring captions; Budgets card line and
  the `projected` badge; the bell line and link; the view answer's `forecastMethod`, `anomalies` with `anomaly` and
  `label`, `anomalyParams`; the budgets answer's `forecastUSD` and `runsOut`) → Tasks 4, 6, 7.
- Error handling (a failed history read gives `forecastMethod: null`, `anomalies: null` with `unread`, the rule
  `no_data`, the page and the pass unbroken; unread months not zero; parameters that are not positive) → Task 1
  (unread), Task 4 (route test), Task 5 (provider throws, `withDefaults`).
- Testing list → Task 1 (weekday means and fallback, known days, percentiles and clamping, `project` partly spent, plan
  fees, empty model, `runsOut` boundaries); Task 2 (partial and whole, expected 0, ranking, share cap, ties, no
  drivers, a key value, both thresholds); Task 3 (`projected` from the forecast, linear fallback, `runsOut` inside or
  after the period and null when exceeded, a day budget, a billed budget with plan days); Task 4 (the line from the
  model, `forecastMethod` per method, spike marks equal to `isAnomaly` with passed parameters, `anomalies` with key
  labels, the new API fields, a failed read giving nulls); Task 5 (states and per-day instances, titles, no_data
  without a snapshot, one alert per day across partial and whole, an instance dropped past yesterday, no drivers in
  the channel payloads, the rule listed with its parameters); Tasks 6–7 (runs-out and forecast lines, anomaly rows,
  caption per method, esc() on names); Task 8 (demo answers). No test calls the network or signals a process.
- Out of scope (4b, hour-of-day, per-dimension rules, trend models, reports and MCP, the 3b follow-ups): nothing here.

**Placeholder scan:** no "TBD", "TODO", "similar to Task N" or "add validation"; every code step shows the code or the
exact replacement with its location, and the new files are given whole.

**Type consistency:** `dailyModel` (Task 1) returns `{ method, known, byWeekday, mean, low, high, days }`, which
`project` (Task 1), `measureDay` (`byWeekday`, `method`, `days`, Task 2), `evaluateBudget` (Task 3) and `overview`
(`method`, Task 4) read. `project` returns `[{ day, cum, low, high }]`, which `runsOut`, `evaluateBudget`
(`forecastUSD` = last `cum`) and `overview` (converted per step) read. `measureDay`'s `{ day, partial, spentUSD,
expectedUSD, drivers: [{ dim, value, extraUSD, share }] }` (Task 2) is what `recentDays` returns, what `anomalyOut`
extends with `anomaly` and `label` (Task 4), what the rule's check reads as `snap.costAnomaly.{ today, yesterday }`
(Task 5) and what `costAnomalyFigures`, `costDriverText` and `costAnomaliesHtml` read (Task 6). The rule's results
`{ instance, sessionId, state, value, threshold, title, usual }` (Task 5) become alert rows with `usual`, listed by
`/api/alerts` and read by `alertLine` (Task 7). A budget view's `forecastUSD`, `runsOut`, `amount`, `amountUSD` and
`currency` (Task 3) are what `overview`'s rings (`runsOut`, Task 4) and `costForecastLine` (Task 7) read. The cost
object's `planFeeFor(source, day)` (Task 3) is the `planFee(source, day)` that `evaluateBudget` and `overview` take.
`HISTORY_DAYS` is 29 in `lib/cost/anomaly.js` (the Overview and the provider) and a separate 28 in
`lib/cost/budget-service.js` (the forecast's window), as decision 4 says.
