# Cost Control 2: Budgets, Alerts and Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Budgets on top of the cost ledger:
- each budget has a scope (global or one dimension), a period (day, Monday week, month), an amount in USD or the display currency, and a measure (usage value or what was paid);
- states `ok` → `warn_<n>` → `exceeded` (100 % always), a projection from 25 % of the period, and `no_data` when spent cannot be known;
- alerts on a change of state through the Monitors channels;
- optional enforcement: **block** matching gateway requests with 402 at once (a real-time guard), or **pause** the costliest local agent in scope once per period;
- the old `monthlyBudgetUSD`, per-key `budgetUSD` and the `daily_cost` / `month_projection` rules migrated without double alerts.

**Architecture:**
- **Pure rules.** `lib/cost/budgets.js`: validation, the old settings read as budgets, period bounds, spent per scope from ledger rows, currency conversion, state and projection. No I/O, no clock.
- **Budget service.** `lib/cost/budget-service.js`: the budgets in force (saved list; the last valid one kept in `.data/cost/budgets.last.json` across restarts; legacy merged), each budget's evaluation from the ledger (`cost.budgetRows`, new) plus the gateway calls recorded since the last ledger pass (priced by `cost.priceGatewayLine`, new), and the exact retirement of those increments when a pass reads them.
- **Guard.** `lib/cost/guard.js`: `check({ keyId, model, provider, agent, runId })` before the gateway forwards a request; the gateway filters its route targets through it and answers 402 when none is left.
- **Monitors.** A `budget` rule kept out of `RULES` (`BUDGET_RULE`), one instance per budget id in `monitors.json`, with its own change-only state path (`applyBudgets`), the existing channels, alerts drawer and auto-pause machinery. `tickBudgets()` runs after each ledger pass.
- **API.** `GET /api/cost/budgets`, `POST /api/cost/budgets`, `POST /api/cost/budgets/<id>/delete` in `lib/cost/api.js`.
- **Wiring.** `server.js` builds the service and guard after the ledger, passes a late-bound guard to the gateway, retires the two old rules, and runs `tickBudgets()` after every ledger pass.

**Tech Stack:** Node ≥18 standard library only (CommonJS), `node:test`, plain browser JS in `public/`.

**Spec:** `docs/superpowers/specs/2026-10-25-cost-budgets-design.md`. Builds on the cost ledger (`docs/superpowers/plans/2026-10-23-cost-ledger.md`, PR #53) and Monitors (#40, #49).

**Line numbers** below are on `feat/cost-budgets` at `f40b1ce`. Re-read each location before editing it.

**Checked while planning:** the code and tests of every task were applied to a scratch copy of `f40b1ce` and run. Each task's tests pass, and so does the whole suite, except `test/platform.test.js`, which fails in any copy of the repository under a temp folder (it fails the same way without these changes) and passes in the worktree.

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test`. Plain browser JS in `public/`.
- **Text only (S1).** Every value from the server renders as text: `esc()` in templates, `textContent` elsewhere. No `innerHTML` built from data. CSP stays `script-src 'self'`.
- **Privacy.**
  - Alerts and the 402 message hold budget names, numbers and periods only, never prompt or response text.
  - The 402 goes to the key's caller and names only the budget that refused it: no figures, no other budget.
  - The webhook body stays the seven fields `{ rule, state, previous, value, threshold, sessionId, ts }`; a budget's name never goes to the webhook.
  - Budget names are owner-written and shown back to the owner only (bell, drawer, desktop notification, `/api/cost/budgets`).
- **Fail directions (decided, tested):**
  - The **guard allows** a request whenever spent cannot be computed (the budget is `no_data`, the ledger read throws, the list does not read), and reports why in `GET /api/cost/budgets` → `guard.error`.
  - A budget is **`no_data`** when a ledger month of its period (or the folder, or the corrections) did not read; for `billed` when the billing history does not read or a row of the period was billed as assumed; when its currency has no rate on or before today or is not the display currency.
  - `no_data` never alerts and never pauses; it keeps the last known state.
  - A saved budget list that does not validate (or a `config.json` that does not parse) keeps the **last valid list** in force, from memory or, after a restart, from `.data/cost/budgets.last.json` (written 0600 with fsync + rename whenever a list validates), and shows a path-free status warning. Only when neither is valid do the legacy budgets alone apply (with the warning). A valid `config.json` list always wins over the file. A budget save is **refused (409)** until the hand edit is fixed.
- **Errors are path-free on every platform.** Every message from `/api/cost/*` goes through `lib/cost/api.js`'s `scrub` (home → `~`, a `~\…` or `~/…` path → `[path]`, then `PATHLIKE`). Tests include a Windows-style `C:\…` path and a home path followed by backslashes.
- **Routes.** Every `/api/cost/*` route needs the dashboard sign-in, never a gateway API key, MCP or A2A. A state change needs `content-type: application/json` (415 otherwise).
- **Agent control.** Every existing rule still holds for a budget pause: the program is verified before every signal (`lib/agents/control.js`), never SIGKILL, off without sign-in, in server mode and in Docker, audited. A paused agent is never resumed automatically. Demo mode never pauses or notifies.
- **Tests.**
  - Never call a real provider or the network: upstreams are `fakeServer` on 127.0.0.1 (`test/helpers.js`); spawned servers run with `NO_JUDGE_PORTS` and a `config.json` with `"pricingSync": { "enabled": false }`.
  - Never signal a real process: the agent control in engine tests is a spy.
  - Mode assertions are skipped on Windows.
  - Spawned servers take ports from **8400–8799**, a range no other test uses (trace 5100-5899, evals 5900-6399, log roots 6100-6899, datasets/monitors 6400-6899, topology 6900-7299, monitors engine and OTLP 7000-7799, cost ledger 8000-8399).
- **Housekeeping.**
  - Prettier style by hand (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Short "why" comments. Some lines in this plan's code blocks run past 120 columns: wrap them as Prettier would when you write them; the content stays as shown.
  - Commits carry **no `Co-Authored-By`, no "Generated with", no AI attribution of any kind**.
  - CI runs on Ubuntu, macOS and Windows.
- **Shared files.** Edits are small and additive (new lines in their own block, new options with defaults that keep today's behaviour, new map or export entries, no reordering), and existing tests stay green: `server.js`, `lib/demo.js`, `README.md`, `public/app.js`, `public/gatewayview.js`, `public/monitorsview.js`, `lib/gateway/index.js`, `lib/monitors/rules.js`, `lib/monitors/state.js`, `lib/monitors/index.js`, `lib/monitors/api.js`, `lib/monitors/channels.js`, `docs/monitors.md`. One existing assertion changes on purpose: the demo alert count in `test/monitors-api.test.js:861` (5 → 7, the two demo budget alerts).

## Rules and values

**R1. Budget shape** (stored in `config.json` → `cost.budgets`, normalized on save):

```
{ id, name, scope, period, amount, currency, measure, thresholds, projection, enforce, legacy }
```

| Field | Rule | Default | Error (prefix) |
|---|---|---|---|
| `id` | `^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`, not `constructor`/`prototype`; unique in the list | — | `id: …`, `budgets[i].id: <id> is used twice` |
| `name` | 1–60 chars after trim, no control character | — | `name: …` |
| `scope` | `'global'` or `{ dim, value }`, dim one of `center`, `key`, `project`, `model`, `provider`, `source` | — | `scope: …`, `scope.dim: …`, `scope.value: …` |
| `scope.value` | 1–300 chars, no control character; `key`: `^[A-Za-z0-9_-]{1,64}$`; `center`: a configured center or `unassigned`; `source`: one of `SOURCES`; `model`: stored as `normalizeModel(value)`; `project`: backslashes → `/`, home → `~`, trailing `/` dropped | — | as above |
| `period` | `day`, `week`, `month` | — | `period: day, week or month` |
| `amount` | finite, > 0, ≤ 1e12 | — | `amount: a number above 0` |
| `currency` | `USD` or the configured display currency code | `USD` | `currency: USD or <code>` |
| `measure` | `list` (`listUSD`) or `billed` (`billedUSD`) | `list` | `measure: list or billed` |
| `thresholds` | 0–2 whole numbers in 1..99, strictly rising | `[50, 80]` | `thresholds: …` |
| `projection` | boolean | `true` | `projection: true or false` |
| `enforce` | `none`, `block`, `pause` | `none` | `enforce: …` |
| `enforce: 'block'` | scope global, key, center, model, provider, or source `gateway` | | `enforce: block works on …` |
| `enforce: 'pause'` | scope global, project, center, model, or source `claude` / `codex` | | `enforce: pause works on …` |
| `legacy` | absent or `null` on input; set only by the legacy reader | `null` | `legacy: …` |
| unknown field | refused | | `unknown field: <name>` |

- At most 100 budgets; at most 50 error strings are returned.
- `rules.js` `validate` accepts a `budgets` field and **ignores** it (the cost settings stay valid whatever the list holds; the list is validated by `budgets.js`).

**R2. Legacy budgets** (read on every call, never written):
- `monthlyBudgetUSD > 0` → `{ id: 'legacy-monthly', name: 'Monthly budget', scope: 'global', period: 'month', amount, currency: 'USD', measure: 'list', thresholds: [50, 80], projection: true, enforce: 'none', legacy: 'monthlyBudgetUSD' }`.
- Each gateway key that is not revoked and has a number `budgetUSD ≥ 0` → `{ id: 'legacy-key-<keyId>', name: 'Key <key name>', scope: { dim: 'key', value: keyId }, period: 'month', amount: budgetUSD, currency: 'USD', measure: 'list', thresholds: [50, 80], projection: true, enforce: 'block', legacy: 'keyBudget' }`. A budget of 0 is kept: it is `exceeded` at once, as the old `monthSpend >= 0` check refused at once.
- **A saved budget wins over a legacy one of the same id.** Effective list = saved, then the legacy budgets whose id is not saved.

**R3. Period bounds** (local time, `periodBounds(period, t)`):
- day: local midnight to the next; week: Monday 00:00 to the next Monday; month: the 1st to the next 1st.
- Returns `{ period, from, to, start, end, fraction, key }`: `from`/`to` are `YYYY-MM-DD` (both included), `fraction = (t − start) / (end − start)` clamped to 0..1, `key = '<period>:<from>'` (the period key alerts and pauses reset on).

**R4. Spent** = sum of `listUSD` (`list`) or `billedUSD` (`billed`) over the rows of `[from, to]` in scope, plus the gateway increments in scope.
- Scope match: `global` matches every row; otherwise `row[field] === value` with field `center`, `keyId`, `project`, `model`, `provider`, `source`.
- **Plan rows** (`kind: 'plan'`) count only for `billed`, and only in `global` and `source` scopes.
- The rows are `cost.budgetRows({ from, to })`: the reader's view with corrections applied and billing (overrides included) derived, as every ledger read.
- **Currency:** a budget in the display currency has `amountUSD = amount / rate`, `rate = rateFor(currency, today)` (latest on or before today); `spent` is shown in the budget's currency (`spentUSD × rate`).

**R5. States.**
- `percent = spentUSD / amountUSD × 100` (shown rounded to 0.1; `null` for an amount of 0).
- `exceeded` when `percent ≥ 100`, always; else `warn_<t>` for the highest threshold `t ≤ percent`; else `ok`.
- `projected = projection && state !== 'exceeded' && fraction ≥ 0.25 && spentUSD / fraction > amountUSD`.
- `no_data` (with `reason`) as in the Global Constraints; `spent`, `spentUSD`, `amountUSD`, `percent` are then `null` and `projected` false.

**R6. Alerts** (`state.applyBudgets`, rule `budget`, instance = budget id):
- An alert goes out when the threshold state changes (either way), or when `projected` turns true. Nothing else: no reminder, no resolution hold.
- A new period (`periodKey` changed) starts at `ok` without an alert, and clears the pause mark.
- `no_data` keeps the last known state and alerts neither way.
- A budget seen for the first time starts at `ok`: a first state above a level alerts once.
- Alert row: `{ id, ts, rule: 'budget', instance, sessionId: null, state, previous, value: percent, threshold: level (50, 80 … or 100), title: name, period: 'day'|'week'|'month', projected }`.
- With `retire` (the saved list read in full), a budget no longer listed loses its state and snooze.

**R7. Guard** (`guard.check(ctx)`, ctx `{ keyId, model, provider, agent, runId }`):
- Only `enforce: 'block'` budgets. A call with no key (`null` or `'dashboard'`) is a dashboard call.
- In scope: `global` always; `key` when `keyId === value`; `center` when the key's center (`cost.keyCenters`, else `unassigned`) is `value`; `model` when `normalizeModel(model) === value`; `provider` when `provider === value`; `source` (`gateway`) when there is a key and the call's source is `gateway` (no `runId`, agent not `judge`/`replay`). So dashboard calls meet only global, model and provider budgets.
- Refused when the budget is `exceeded`: `{ budget: <id>, message: 'budget "<name>" is used up for this <period>' }`. The gateway answers HTTP 402, type `insufficient_quota`.
- `no_data` or any error: allowed, and the reason is kept for the status.
- The gateway checks **each route target**; a target that is refused is skipped, and 402 comes only when no target is left.

**R8. Increment retirement.** Each recorded gateway line that the ledger would take (`cost.priceGatewayLine(entry)` not `null`) is kept as `{ seq, row }`. `service.pass(run)` takes `mark = seq`, runs the (synchronous) ledger pass, and when `cost.gatewayPasses()` went up drops every increment with `seq ≤ mark`. Increments older than the earliest current period start (month or week) are dropped too.

**R9. Pause.** On `exceeded` with `enforce: 'pause'`: the costliest running local session **today** (the engine's existing `agg.costly` ranking) whose session is in scope:
- `global`: any; `source`: the session's tool; `project`: the session folder as the ledger writes it (`~/…`, `projectOf` from `lib/cost/collect.js`); `center`: that folder through the folder rules; `model`: one of the session's models (normalized).
- Once per period (`actedAt` cleared on a new period); never on `no_data`; never resumed.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/cost/budgets.js` | create | Pure: validation, legacy reading, period bounds, scope, spent, currency, state, projection, the Overview's monthly figure |
| `lib/cost/budget-service.js` | create | Budgets in force, the last valid list (kept in `budgets.last.json`), evaluation, gateway increments and their retirement |
| `lib/cost/guard.js` | create | The gateway's real-time check |
| `lib/cost/rules.js` | modify | `validate` accepts the `budgets` field |
| `lib/cost/index.js` | modify | `budgetRows`, `priceGatewayLine`, `gatewayPasses` on the cost object |
| `lib/cost/collect.js` | modify | export `projectOf` |
| `lib/cost/api.js` | modify | the three budget routes; settings save keeps `budgets`; `onChange` |
| `lib/gateway/index.js` | modify (shared) | `budgetGuard` option: target filtering, 402, record hook, priced-only rule |
| `lib/monitors/rules.js` | modify (shared) | `BUDGET_RULE`, `ruleById`, `isBudgetState` |
| `lib/monitors/state.js` | modify (shared) | budget states: `applyBudgets`, `pendingBudgets`, `markActed`, cleaning, no prune |
| `lib/monitors/channels.js` | modify (shared) | budget words, budget states in the webhook |
| `lib/monitors/api.js` | modify (shared) | budget alert fields, `retired` option, counts |
| `lib/monitors/index.js` | modify (shared) | `tickBudgets`, budget pause, `retired`, `home` |
| `lib/demo.js` | modify (shared) | demo budgets, budget alerts |
| `public/monitorsview.js` | modify (shared) | budget alert lines in the bell and drawer |
| `public/app.js`, `public/gatewayview.js` | modify (shared) | "Manage in Budgets" notes; the Settings field once managed |
| `server.js` | modify (shared) | `saveConfigSections`, service, guard, gateway option, ticks, retired rules, `/api/config` |
| `docs/cost.md`, `docs/monitors.md`, `README.md` | modify | budgets docs |
| `test/cost-budgets.test.js` | create | Task 1 |
| `test/cost-budget-service.test.js` | create | Task 2 |
| `test/cost-guard.test.js` | create | Task 3 |
| `test/budgets-monitors.test.js` | create | Task 4 |
| `test/budgets-engine.test.js` | create | Task 5 |
| `test/cost-budgets-api.test.js` | create | Task 6 |
| `test/budgets-demo-ui.test.js` | create | Task 7 |
| `test/budgets-http.test.js` | create | Task 8 |

---

### Task 1: Budget rules (pure)

**Files:**
- Create: `lib/cost/budgets.js`
- Modify: `lib/cost/rules.js:10` (`FIELDS`)
- Test: `test/cost-budgets.test.js`

**Interfaces:**
- Consumes: `normalizeModel` (`lib/pricing.js`); `dayOf`, `addDays`, `monthOf` (`lib/cost/days.js`); `SOURCES`, `UNASSIGNED`, `normalizeGlob`, `rateFor` (`lib/cost/rules.js`).
- Produces (`lib/cost/budgets.js` exports):
  - `DIMS`, `PERIODS`, `LIMITS` (`{ budgets: 100, name: 60, value: 300, amount: 1e12 }`), `DEFAULT_THRESHOLDS`, `PROJECTION_FROM` (0.25), `LEGACY_MONTHLY` (`'legacy-monthly'`), `legacyKeyId(keyId)`;
  - `validateBudget(input, { currency, centers, home }) → { ok: true, value } | { ok: false, errors }` (`currency` is the display code or `null`, `centers` an id list);
  - `validateList(list, ctx) → { ok: true, value: budget[] } | { ok: false, errors }`;
  - `mayBlock(scope)`, `mayPause(scope)`, `inScope(scope, row)`, `stateOf(percent, thresholds)`;
  - `periodBounds(period, t) → { period, from, to, start, end, fraction, key }`;
  - `evaluateBudget(budget, { rows, extra, unread, billingError, currency, now }) → view`;
  - `noDataView(budget, bounds, reason) → view`;
  - `legacyBudgets({ monthlyBudgetUSD, keys }) → budget[]`, `effectiveBudgets(saved, legacy) → budget[]`, `copyBudget(b)`;
  - `monthlyFigure({ saved, monthlyBudgetUSD, currency, now }) → { monthlyBudgetUSD, monthlyBudgetManaged }`.
  - A **view** is the budget's fields plus `{ from, to, periodKey, fraction, state, projected, spent, spentUSD, amountUSD, percent, reason }`.

- [ ] **Step 1: Write the failing test**

```js
// test/cost-budgets.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/cost/budgets');
const { validate } = require('../lib/cost/rules');

const HOME = '/Users/owner';
const at = (m, d, h = 12, min = 0) => new Date(2026, m - 1, d, h, min).getTime();
const CTX = { currency: 'IDR', centers: ['acme', 'lab'], home: HOME };
const CUR = {
  code: 'IDR',
  rates: [
    { from: '2026-10-01', perUSD: 16000 },
    { from: '2026-10-21', perUSD: 16500 },
  ],
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);
const good = (over = {}) => ({ id: 'team', name: 'Team', scope: 'global', period: 'month', amount: 100, ...over });
const ok = (over) => {
  const r = B.validateBudget(good(over), CTX);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.value;
};
const row = (over = {}) => ({
  day: '2026-10-20',
  source: 'gateway',
  provider: 'openrouter',
  model: 'claude-sonnet-5-5',
  project: null,
  center: 'acme',
  keyId: 'key_a',
  kind: 'chat',
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const pick = (b) => ({ from: b.from, to: b.to, key: b.key });

test('validateBudget: defaults and normalized scope values', () => {
  assert.deepEqual(B.validateBudget(good(), CTX), {
    ok: true,
    value: {
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
    },
  });
  assert.deepEqual(ok({ scope: { dim: 'model', value: 'anthropic/Claude-Sonnet-5.5' } }).scope, {
    dim: 'model',
    value: 'claude-sonnet-5-5',
  });
  assert.deepEqual(ok({ scope: { dim: 'project', value: '/Users/owner/work/acme/' } }).scope, {
    dim: 'project',
    value: '~/work/acme',
  });
  assert.deepEqual(ok({ scope: { dim: 'project', value: '~\\work\\acme' } }).scope, {
    dim: 'project',
    value: '~/work/acme',
  });
  assert.equal(ok({ currency: 'IDR', amount: 1500000 }).currency, 'IDR');
  assert.equal(ok({ scope: { dim: 'center', value: 'unassigned' } }).scope.value, 'unassigned');
  assert.equal(ok({ id: 'legacy-key-key_a1' }).id, 'legacy-key-key_a1', 'a key id holds an underscore');
  assert.deepEqual(ok({ thresholds: [] }).thresholds, []);
  assert.equal(ok({ enforce: 'block', scope: { dim: 'source', value: 'gateway' } }).enforce, 'block');
  assert.equal(ok({ enforce: 'pause', scope: { dim: 'source', value: 'codex' } }).enforce, 'pause');
});

test('validateBudget: every refusal has a reason', () => {
  const why = (over, ctx = CTX) => B.validateBudget(good(over), ctx).errors.join(' | ');
  assert.match(why({ scope: { dim: 'team', value: 'x' } }), /scope\.dim/);
  assert.match(why({ scope: { dim: 'model', value: ' ' } }), /scope\.value/);
  assert.match(why({ scope: 'everything' }), /scope: 'global' or \{ dim, value \}/);
  assert.match(why({ scope: { dim: 'center', value: 'gone' } }), /unknown cost center/);
  assert.match(why({ scope: { dim: 'source', value: 'cursor' } }), /scope\.value/);
  assert.match(why({ scope: { dim: 'key', value: 'has space' } }), /scope\.value/);
  assert.match(why({ amount: 0 }), /amount/);
  assert.match(why({ amount: -5 }), /amount/);
  assert.match(why({ amount: '5' }), /amount/);
  assert.match(why({ currency: 'EUR' }), /currency: USD or IDR/);
  assert.match(why({ currency: 'IDR' }, { ...CTX, currency: null }), /currency: USD$/);
  assert.match(why({ enforce: 'block', scope: { dim: 'project', value: '~/x' } }), /enforce: block/);
  assert.match(why({ enforce: 'block', scope: { dim: 'source', value: 'claude' } }), /enforce: block/);
  assert.match(why({ enforce: 'pause', scope: { dim: 'key', value: 'key_a' } }), /enforce: pause/);
  assert.match(why({ enforce: 'pause', scope: { dim: 'provider', value: 'groq' } }), /enforce: pause/);
  assert.match(why({ enforce: 'pause', scope: { dim: 'source', value: 'gateway' } }), /enforce: pause/);
  assert.match(why({ enforce: 'stop' }), /enforce/);
  assert.match(why({ thresholds: [80, 50] }), /thresholds/);
  assert.match(why({ thresholds: [50, 80, 90] }), /thresholds/);
  assert.match(why({ thresholds: [100] }), /thresholds/);
  assert.match(why({ thresholds: [0] }), /thresholds/);
  assert.match(why({ thresholds: [50.5] }), /thresholds/);
  assert.match(why({ legacy: 'keyBudget' }), /legacy/);
  assert.match(why({ extra: 1 }), /unknown field: extra/);
  assert.match(why({ id: 'Bad id!' }), /id:/);
  assert.match(why({ id: 'constructor' }), /id:/);
  assert.match(why({ name: '' }), /name/);
  assert.match(why({ name: 'a\nb' }), /name/);
  assert.match(why({ period: 'year' }), /period/);
  assert.match(why({ measure: 'paid' }), /measure/);
  assert.match(why({ projection: 'yes' }), /projection/);
  assert.match(B.validateBudget('x', CTX).errors[0], /a budget must be an object/);
});

test('validateList: duplicate ids, the size limit, prefixed reasons; the cost settings ignore the field', () => {
  const dup = B.validateList([good(), good({ name: 'Again' })], CTX);
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(), /budgets\[1\]\.id: team is used twice/);
  assert.match(B.validateList('x', CTX).errors.join(), /budgets must be a list/);
  const many = Array.from({ length: 101 }, (_, i) => good({ id: `b${i}` }));
  assert.match(B.validateList(many, CTX).errors.join(), /at most 100 budgets/);
  assert.match(B.validateList([good({ amount: 0 })], CTX).errors.join(), /budgets\[0\]\.amount/);
  assert.deepEqual(B.validateList([], CTX), { ok: true, value: [] });
  const s = validate({ budgets: [{ junk: true }] });
  assert.equal(s.ok, true, 'a budget list never makes the cost settings invalid');
  assert.equal('budgets' in s.value, false);
});

test('periodBounds: local day, Monday week, month; roll-over at local midnight', () => {
  const t = at(10, 22, 18); // Thursday 22 October 2026, 18:00
  assert.deepEqual(pick(B.periodBounds('day', t)), { from: '2026-10-22', to: '2026-10-22', key: 'day:2026-10-22' });
  assert.deepEqual(pick(B.periodBounds('week', t)), { from: '2026-10-19', to: '2026-10-25', key: 'week:2026-10-19' });
  assert.deepEqual(pick(B.periodBounds('month', t)), {
    from: '2026-10-01',
    to: '2026-10-31',
    key: 'month:2026-10-01',
  });
  near(B.periodBounds('day', t).fraction, 0.75);
  assert.equal(B.periodBounds('week', at(10, 25, 23)).from, '2026-10-19', 'Sunday ends the week');
  assert.equal(B.periodBounds('week', at(10, 26, 0, 1)).from, '2026-10-26', 'Monday starts one');
  assert.deepEqual(pick(B.periodBounds('week', at(12, 31))), {
    from: '2026-12-28',
    to: '2027-01-03',
    key: 'week:2026-12-28',
  });
  assert.equal(B.periodBounds('day', at(10, 31, 23, 59)).key, 'day:2026-10-31');
  assert.equal(B.periodBounds('month', new Date(2026, 10, 1, 0, 1).getTime()).key, 'month:2026-11-01');
  assert.equal(B.periodBounds('month', at(2, 10)).to, '2026-02-28');
});

test('spent per scope for both measures; plan rows only for billed in global and source scopes', () => {
  const rows = [
    row({ listUSD: 2, billedUSD: 2 }),
    // Claude Code on a plan: worth 5, billed 0.
    row({ source: 'claude', provider: 'anthropic', keyId: null, project: '~/work/acme', listUSD: 5, billedUSD: 0 }),
    row({ source: 'claude', kind: 'plan', provider: null, model: null, center: null, keyId: null, listUSD: 0, billedUSD: 6.45 }),
    row({ day: '2026-09-30', listUSD: 100, billedUSD: 100 }), // before the period
    row({ keyId: 'key_b', center: 'lab', model: 'deepseek-chat', provider: 'groq', listUSD: 1, billedUSD: 1 }),
  ];
  const spent = (over, extra = []) =>
    B.evaluateBudget(ok(over), { rows, extra, currency: CUR, now: at(10, 22) }).spentUSD;
  near(spent({}), 8);
  near(spent({ measure: 'billed' }), 2 + 0 + 6.45 + 1);
  near(spent({ scope: { dim: 'source', value: 'claude' }, measure: 'billed' }), 6.45);
  near(spent({ scope: { dim: 'source', value: 'claude' } }), 5);
  near(spent({ scope: { dim: 'center', value: 'acme' }, measure: 'billed' }), 2, 'the plan row has no center');
  near(spent({ scope: { dim: 'key', value: 'key_a' } }), 2);
  near(spent({ scope: { dim: 'model', value: 'deepseek-chat' } }), 1);
  near(spent({ scope: { dim: 'model', value: 'claude-sonnet-5-5' }, measure: 'billed' }), 2);
  near(spent({ scope: { dim: 'provider', value: 'groq' } }), 1);
  near(spent({ scope: { dim: 'project', value: '~/work/acme' } }), 5);
  near(spent({}, [row({ listUSD: 3 })]), 11, 'gateway increments count beside the ledger rows');
  assert.equal(B.inScope({ dim: 'source', value: 'claude' }, rows[2]), true);
  assert.equal(B.inScope({ dim: 'center', value: 'acme' }, { ...rows[2], center: 'acme' }), false);
});

test('a budget in the display currency: converted at the latest rate on or before today; no rate is no_data', () => {
  const b = ok({ currency: 'IDR', amount: 165000 }); // $10 at today's rate
  const v = B.evaluateBudget(b, { rows: [row({ listUSD: 5 })], currency: CUR, now: at(10, 22) });
  near(v.amountUSD, 10);
  assert.equal(v.percent, 50);
  assert.equal(v.state, 'warn_50');
  near(v.spent, 82500);
  near(
    B.evaluateBudget(b, { rows: [], currency: CUR, now: at(10, 20) }).amountUSD,
    165000 / 16000,
    'on the 20th the rate of the 1st applies',
  );
  const late = { code: 'IDR', rates: [{ from: '2026-11-01', perUSD: 16000 }] };
  const none = B.evaluateBudget(b, { rows: [], currency: late, now: at(10, 22) });
  assert.equal(none.state, 'no_data');
  assert.match(none.reason, /no IDR rate on or before today/);
  assert.equal(none.percent, null);
  assert.match(B.evaluateBudget(b, { rows: [], currency: null, now: at(10, 22) }).reason, /no rates for IDR/);
});

test('states: warning levels in order, 100 % always exceeded, projection from a quarter of the period', () => {
  const at22 = at(10, 22, 12); // about 69 % of October
  const st = (usd, over = {}) =>
    B.evaluateBudget(ok({ amount: 100, ...over }), { rows: [row({ listUSD: usd })], currency: null, now: at22 });
  assert.equal(st(10).state, 'ok');
  assert.equal(st(50).state, 'warn_50');
  assert.equal(st(79.99).state, 'warn_50');
  assert.equal(st(80).state, 'warn_80');
  assert.equal(st(99.99).state, 'warn_80');
  assert.equal(st(100).state, 'exceeded');
  assert.equal(st(250).state, 'exceeded');
  assert.equal(st(100, { thresholds: [] }).state, 'exceeded', '100 % is always exceeded');
  assert.equal(st(99, { thresholds: [] }).state, 'ok');
  assert.equal(st(60, { thresholds: [90] }).state, 'ok');
  assert.equal(st(60).projected, false, '60 at 69 % projects to about 87');
  assert.equal(st(70).projected, true, '70 at 69 % projects to about 101');
  assert.equal(st(70, { projection: false }).projected, false);
  assert.equal(st(120).projected, false, 'exceeded is not also projected');
  const day = ok({ period: 'day', amount: 10 });
  const r3 = [row({ day: '2026-10-22', listUSD: 3 })];
  assert.equal(B.evaluateBudget(day, { rows: r3, now: at(10, 22, 5) }).projected, false, 'before a quarter');
  assert.equal(B.evaluateBudget(day, { rows: r3, now: at(10, 22, 7) }).projected, true);
});

test('no_data: an unread month of the period, the folder, the corrections; billing lost or unread for billed', () => {
  const at22 = at(10, 22);
  const b = ok();
  assert.match(B.evaluateBudget(b, { rows: [], unread: ['2026-10'], now: at22 }).reason, /could not read 2026-10/);
  assert.equal(B.evaluateBudget(b, { rows: [], unread: ['2026-09'], now: at22 }).state, 'ok', 'outside the period');
  assert.equal(B.evaluateBudget(b, { rows: [], unread: ['folder'], now: at22 }).state, 'no_data');
  assert.equal(B.evaluateBudget(b, { rows: [], unread: ['corrections'], now: at22 }).state, 'no_data');
  // Thursday 1 October: the week started on Monday 28 September, so September matters.
  assert.equal(B.evaluateBudget(ok({ period: 'week' }), { rows: [], unread: ['2026-09'], now: at(10, 1) }).state, 'no_data');
  const billed = ok({ measure: 'billed' });
  assert.match(
    B.evaluateBudget(billed, { rows: [], billingError: 'x', now: at22 }).reason,
    /billing history could not be read/,
  );
  assert.match(
    B.evaluateBudget(billed, { rows: [row({ billingAssumed: true })], now: at22 }).reason,
    /billing history was lost/,
  );
  assert.equal(B.evaluateBudget(b, { rows: [row({ billingAssumed: true })], now: at22 }).state, 'ok');
  const v = B.evaluateBudget(b, { rows: [], unread: ['2026-10'], now: at22 });
  assert.deepEqual([v.spent, v.spentUSD, v.amountUSD, v.percent, v.projected], [null, null, null, null, false]);
});

test('legacy budgets: monthlyBudgetUSD and key budgets; a saved budget of the same id wins; the monthly figure', () => {
  const legacy = B.legacyBudgets({
    monthlyBudgetUSD: 300,
    keys: [
      { id: 'key_a', name: 'Acme app', budgetUSD: 5 },
      { id: 'key_b', name: 'Lab', budgetUSD: null },
      { id: 'key_c', name: 'Old', budgetUSD: 9, revokedAt: 1 },
      { id: 'key_z', name: 'Zero', budgetUSD: 0 },
    ],
  });
  const brief = (b) => [b.id, b.scope === 'global' ? 'global' : `${b.scope.dim}:${b.scope.value}`, b.period, b.amount, b.enforce, b.legacy];
  assert.deepEqual(legacy.map(brief), [
    ['legacy-monthly', 'global', 'month', 300, 'none', 'monthlyBudgetUSD'],
    ['legacy-key-key_a', 'key:key_a', 'month', 5, 'block', 'keyBudget'],
    ['legacy-key-key_z', 'key:key_z', 'month', 0, 'block', 'keyBudget'],
  ]);
  assert.equal(legacy[1].name, 'Key Acme app');
  assert.deepEqual(B.legacyBudgets({ monthlyBudgetUSD: 0 }), []);
  assert.equal(B.evaluateBudget(legacy[2], { rows: [], now: at(10, 22) }).state, 'exceeded', 'a budget of 0 blocks');
  const saved = [ok({ id: 'legacy-monthly', name: 'Team month', amount: 400 })];
  assert.deepEqual(
    B.effectiveBudgets(saved, legacy).map((b) => [b.id, b.amount, b.legacy]),
    [
      ['legacy-monthly', 400, null],
      ['legacy-key-key_a', 5, 'keyBudget'],
      ['legacy-key-key_z', 0, 'keyBudget'],
    ],
  );
  const now = at(10, 22);
  assert.deepEqual(B.monthlyFigure({ saved, monthlyBudgetUSD: 0, currency: null, now }), {
    monthlyBudgetUSD: 400,
    monthlyBudgetManaged: true,
  });
  assert.deepEqual(B.monthlyFigure({ saved: [], monthlyBudgetUSD: 300, currency: null, now }), {
    monthlyBudgetUSD: 300,
    monthlyBudgetManaged: false,
  });
  const idr = [ok({ id: 'legacy-monthly', currency: 'IDR', amount: 1650000 })];
  assert.deepEqual(B.monthlyFigure({ saved: idr, monthlyBudgetUSD: 0, currency: CUR, now }), {
    monthlyBudgetUSD: 100,
    monthlyBudgetManaged: true,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-budgets.test.js`
Expected: FAIL with `Cannot find module '../lib/cost/budgets'`.

- [ ] **Step 3: Accept the `budgets` field in the cost settings** (`lib/cost/rules.js:10`)

```js
// `budgets` is validated on its own (lib/cost/budgets.js): a bad budget never makes the cost settings invalid.
const FIELDS = ['centers', 'keyCenters', 'folderRules', 'billing', 'currency', 'budgets'];
```

`validate` copies only the five settings fields into `out`, so `budgets` is accepted and left out of the value. Nothing else in `rules.js` changes.

- [ ] **Step 4: Write `lib/cost/budgets.js`**

```js
// Cost Control, sub-project 2: budgets. Pure functions: a budget's validation, the old settings read as budgets, the
// bounds of its period in local time, what it spent from ledger rows, and its state. No I/O and no clock: `now` is an
// argument. The budgets in force and the gateway calls not yet in the ledger live in lib/cost/budget-service.js, the
// gateway's check in lib/cost/guard.js, and the alerts in the Monitors engine (rule `budget`).
const { normalizeModel } = require('../pricing');
const { dayOf, addDays, monthOf } = require('./days');
const { SOURCES, UNASSIGNED, normalizeGlob, rateFor } = require('./rules');

const DIMS = ['center', 'key', 'project', 'model', 'provider', 'source'];
const PERIODS = ['day', 'week', 'month'];
const MEASURES = ['list', 'billed'];
const ENFORCE = ['none', 'block', 'pause'];
const FIELDS = ['id', 'name', 'scope', 'period', 'amount', 'currency', 'measure', 'thresholds', 'projection', 'enforce', 'legacy'];
const DEFAULT_THRESHOLDS = [50, 80];
const PROJECTION_FROM = 0.25; // a projection from the first quarter of a period is noise
const LIMITS = { budgets: 100, name: 60, value: 300, amount: 1e12 };
const BUDGET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];
const CONTROL = /[\u0000-\u001f\u007f]/;
const LEGACY_MONTHLY = 'legacy-monthly';
const legacyKeyId = (keyId) => `legacy-key-${keyId}`;
// The ledger row field each scope dimension reads.
const ROW_FIELD = { center: 'center', key: 'keyId', project: 'project', model: 'model', provider: 'provider', source: 'source' };

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clip = (s) => String(s).slice(0, 40);
const usd = (v) => Math.round(v * 1e8) / 1e8;
const shown = (v) => Math.round(v * 1e4) / 1e4;
const pct = (v) => Math.round(v * 10) / 10;
const copyBudget = (b) => ({ ...b, scope: b.scope === 'global' ? 'global' : { ...b.scope }, thresholds: [...b.thresholds] });

// Block reaches gateway requests only: a project or a local source never goes through the gateway.
function mayBlock(scope) {
  if (scope === 'global') return true;
  if (scope.dim === 'source') return scope.value === 'gateway';
  return ['key', 'center', 'model', 'provider'].includes(scope.dim);
}
// Pause reaches a local agent only: a key or a provider has no local session behind it.
function mayPause(scope) {
  if (scope === 'global') return true;
  if (scope.dim === 'source') return scope.value === 'claude' || scope.value === 'codex';
  return ['project', 'center', 'model'].includes(scope.dim);
}

function scopeOf(s, ctx, errors) {
  if (s === 'global') return 'global';
  if (!isObject(s) || Object.keys(s).some((k) => k !== 'dim' && k !== 'value')) {
    errors.push("scope: 'global' or { dim, value }");
    return null;
  }
  if (!DIMS.includes(s.dim)) {
    errors.push(`scope.dim: one of ${DIMS.join(', ')}`);
    return null;
  }
  let v = typeof s.value === 'string' ? s.value.trim() : '';
  if (!v || v.length > LIMITS.value || CONTROL.test(v)) {
    errors.push(`scope.value: 1 to ${LIMITS.value} characters`);
    return null;
  }
  if (s.dim === 'key' && !KEY_ID.test(v)) errors.push('scope.value: a gateway key id');
  else if (s.dim === 'center' && v !== UNASSIGNED && !(ctx.centers || []).includes(v))
    errors.push('scope.value: unknown cost center');
  else if (s.dim === 'source' && !SOURCES.includes(v)) errors.push(`scope.value: one of ${SOURCES.join(', ')}`);
  else if (s.dim === 'model') {
    v = normalizeModel(v);
    if (!v) errors.push('scope.value: a model name');
  } else if (s.dim === 'project') {
    // As the ledger stores projects: forward slashes, the home folder as ~, no trailing slash.
    v = normalizeGlob(v, ctx.home || '').replace(/(.)\/+$/, '$1');
  }
  return { dim: s.dim, value: v };
}

function validateBudget(input, ctx = {}) {
  if (!isObject(input)) return { ok: false, errors: ['a budget must be an object'] };
  const errors = [];
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) errors.push(`unknown field: ${clip(k)}`);
  const id = typeof input.id === 'string' ? input.id : '';
  if (!BUDGET_ID.test(id) || RESERVED.includes(id))
    errors.push('id: letters, digits, dashes and underscores, up to 80, starting with a letter or digit');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > LIMITS.name || CONTROL.test(name))
    errors.push(`name: 1 to ${LIMITS.name} characters, no control characters`);
  const scope = scopeOf(input.scope, ctx, errors);
  if (!PERIODS.includes(input.period)) errors.push('period: day, week or month');
  if (!isNum(input.amount) || input.amount <= 0 || input.amount > LIMITS.amount) errors.push('amount: a number above 0');
  const currency = input.currency ?? 'USD';
  if (currency !== 'USD' && !(ctx.currency && currency === ctx.currency))
    errors.push(`currency: USD${ctx.currency ? ` or ${ctx.currency}` : ''}`);
  const measure = input.measure ?? 'list';
  if (!MEASURES.includes(measure)) errors.push('measure: list or billed');
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const rising =
    Array.isArray(thresholds) &&
    thresholds.length <= 2 &&
    thresholds.every((t) => Number.isInteger(t) && t >= 1 && t <= 99) &&
    thresholds.every((t, i) => i === 0 || t > thresholds[i - 1]);
  if (!rising) errors.push('thresholds: up to 2 whole numbers from 1 to 99, rising (100 % is always exceeded)');
  const projection = input.projection ?? true;
  if (typeof projection !== 'boolean') errors.push('projection: true or false');
  const enforce = input.enforce ?? 'none';
  if (!ENFORCE.includes(enforce)) errors.push('enforce: none, block or pause');
  else if (scope && enforce === 'block' && !mayBlock(scope))
    errors.push('enforce: block works on global, key, center, model, provider or source gateway budgets');
  else if (scope && enforce === 'pause' && !mayPause(scope))
    errors.push('enforce: pause works on global, project, center, model or source claude or codex budgets');
  if (input.legacy !== undefined && input.legacy !== null)
    errors.push('legacy: set only for budgets read from the old settings');
  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
  return {
    ok: true,
    value: { id, name, scope, period: input.period, amount: input.amount, currency, measure, thresholds: [...thresholds], projection, enforce, legacy: null },
  };
}

function validateList(list, ctx = {}) {
  if (!Array.isArray(list)) return { ok: false, errors: ['budgets must be a list'] };
  if (list.length > LIMITS.budgets) return { ok: false, errors: [`at most ${LIMITS.budgets} budgets`] };
  const errors = [];
  const out = [];
  list.forEach((b, i) => {
    const r = validateBudget(b, ctx);
    if (!r.ok) for (const e of r.errors) errors.push(`budgets[${i}].${e}`);
    else if (out.some((x) => x.id === r.value.id)) errors.push(`budgets[${i}].id: ${r.value.id} is used twice`);
    else out.push(r.value);
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 50) } : { ok: true, value: out };
}

// The current period in local time: a day from midnight, a week from Monday, a month from the 1st. `fraction` is how
// much of it has passed at `t`; `key` changes when a new period starts.
function periodBounds(period, t) {
  const d = new Date(t);
  let start;
  let end;
  if (period === 'day') {
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  } else if (period === 'week') {
    const back = (d.getDay() + 6) % 7; // Monday is 0
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
    end = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + 7);
  } else {
    start = new Date(d.getFullYear(), d.getMonth(), 1);
    end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  const from = dayOf(start.getTime());
  const to = addDays(dayOf(end.getTime()), -1);
  const fraction = Math.min(1, Math.max(0, (t - start.getTime()) / (end.getTime() - start.getTime())));
  return { period, from, to, start: start.getTime(), end: end.getTime(), fraction, key: `${period}:${from}` };
}

// Plan rows carry no center, model, key or project: they count only in global and source budgets.
function inScope(scope, row) {
  if (scope === 'global') return true;
  if (row.kind === 'plan') return scope.dim === 'source' && row.source === scope.value;
  return row[ROW_FIELD[scope.dim]] === scope.value;
}

function stateOf(percent, thresholds) {
  if (percent >= 100) return 'exceeded';
  let s = 'ok';
  for (const t of thresholds) if (percent >= t) s = `warn_${t}`;
  return s;
}

const viewBase = (b, p) => ({
  ...copyBudget(b),
  from: p.from,
  to: p.to,
  periodKey: p.key,
  fraction: Math.round(p.fraction * 1e4) / 1e4,
});
function noDataView(b, p, reason) {
  return { ...viewBase(b, p), state: 'no_data', projected: false, spent: null, spentUSD: null, amountUSD: null, percent: null, reason };
}

// The names in a range read's `unread` that touch [from, to]: its months, the folder, the corrections.
const missingFor = (unread, from, to) =>
  (unread || []).filter(
    (u) => u === 'folder' || u === 'corrections' || (/^\d{4}-\d{2}$/.test(u) && u >= monthOf(from) && u <= monthOf(to)),
  );

// `rows` are the ledger rows (cost.budgetRows), `extra` the gateway calls the ledger has not read yet; both are
// filtered to the period here. `currency` is the display currency with its rates.
function evaluateBudget(b, { rows = [], extra = [], unread = [], billingError = null, currency = null, now } = {}) {
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
  let spentUSD = 0;
  for (const list of [rows, extra])
    for (const r of list) {
      if (!r || r.day < p.from || r.day > p.to || !inScope(b.scope, r)) continue;
      if (b.measure === 'list' && r.kind === 'plan') continue;
      // What was paid on such a day is not known: billed as metered until a restate says otherwise.
      if (b.measure === 'billed' && r.billingAssumed)
        return noDataView(b, p, 'the billing history was lost for part of this period');
      spentUSD += isNum(r[field]) ? r[field] : 0;
    }
  const amountUSD = b.amount / rate;
  const percent = amountUSD > 0 ? (spentUSD / amountUSD) * 100 : Infinity;
  const state = stateOf(percent, b.thresholds);
  const projected =
    b.projection && state !== 'exceeded' && p.fraction >= PROJECTION_FROM && spentUSD / p.fraction > amountUSD;
  return {
    ...viewBase(b, p),
    state,
    projected,
    spent: shown(spentUSD * rate),
    spentUSD: usd(spentUSD),
    amountUSD: usd(amountUSD),
    percent: Number.isFinite(percent) ? pct(percent) : null,
    reason: null,
  };
}

// The old settings as budgets. Never written: they are read on every call, and a saved budget of the same id wins.
function legacyBudgets({ monthlyBudgetUSD, keys = [] } = {}) {
  const out = [];
  const base = { period: 'month', currency: 'USD', measure: 'list', thresholds: [...DEFAULT_THRESHOLDS], projection: true };
  if (isNum(monthlyBudgetUSD) && monthlyBudgetUSD > 0)
    out.push({ id: LEGACY_MONTHLY, name: 'Monthly budget', scope: 'global', amount: monthlyBudgetUSD, ...base, enforce: 'none', legacy: 'monthlyBudgetUSD' });
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!k || !KEY_ID.test(String(k.id)) || k.revokedAt || !isNum(k.budgetUSD) || k.budgetUSD < 0) continue;
    const name = `Key ${String(k.name || k.id)}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, LIMITS.name);
    out.push({ id: legacyKeyId(k.id), name, scope: { dim: 'key', value: String(k.id) }, amount: k.budgetUSD, ...base, enforce: 'block', legacy: 'keyBudget' });
  }
  return out;
}

const effectiveBudgets = (saved, legacy) => [
  ...saved.map(copyBudget),
  ...legacy.filter((l) => !saved.some((s) => s.id === l.id)).map(copyBudget),
];

// The monthly budget the Overview draws: the saved `legacy-monthly` budget once it was edited there (in USD at
// today's rate; 0 when it is no longer a monthly budget or has no rate), else the old setting.
function monthlyFigure({ saved = [], monthlyBudgetUSD, currency = null, now }) {
  const b = saved.find((x) => x.id === LEGACY_MONTHLY);
  if (!b) return { monthlyBudgetUSD: isNum(monthlyBudgetUSD) && monthlyBudgetUSD > 0 ? monthlyBudgetUSD : 0, monthlyBudgetManaged: false };
  let amount = 0;
  if (b.period === 'month') {
    const rate = b.currency === 'USD' ? 1 : currency && currency.code === b.currency ? rateFor(currency, dayOf(now)) : null;
    amount = rate ? b.amount / rate : 0;
  }
  return { monthlyBudgetUSD: Math.round(amount * 100) / 100, monthlyBudgetManaged: true };
}

module.exports = {
  DIMS,
  PERIODS,
  LIMITS,
  DEFAULT_THRESHOLDS,
  PROJECTION_FROM,
  LEGACY_MONTHLY,
  legacyKeyId,
  validateBudget,
  validateList,
  mayBlock,
  mayPause,
  inScope,
  stateOf,
  periodBounds,
  evaluateBudget,
  noDataView,
  legacyBudgets,
  effectiveBudgets,
  copyBudget,
  monthlyFigure,
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/cost-budgets.test.js test/cost-rules.test.js`
Expected: PASS (the cost rules tests stay green).

- [ ] **Step 6: Commit**

```bash
git add lib/cost/budgets.js lib/cost/rules.js test/cost-budgets.test.js
git commit -m "Budgets: validation, legacy reading, periods, spent, states and projection"
```

---
### Task 2: Ledger reads for budgets, and the budget service

**Files:**
- Modify: `lib/cost/index.js` (the `../pricing` require at `:14`; `createCost`'s locals after `:137`; `run()` at `:413-428`; new functions before `return {` at `:672`; the returned object)
- Modify: `lib/cost/collect.js:250` (export `projectOf`, used by Task 5)
- Create: `lib/cost/budget-service.js` (writes `<cost dir>/budgets.last.json` through `writePrivate` from `lib/cost/files.js`)
- Test: `test/cost-budget-service.test.js`

**Interfaces:**
- Consumes: Task 1's `lib/cost/budgets.js`; `settingsOf`, `compile` (`lib/cost/rules.js`); `gatewayEvent`, `priceEvent` (`lib/cost/collect.js`); `billedRows` (`lib/cost/billing-view.js`); `writePrivate` (`lib/cost/files.js`: unique temp file, `wx`, 0600, fsync, rename, folder sync).
- Produces:
  - on the cost object (`createCost`):
    - `budgetRows({ from, to }) → { rows, unread: string[], billingError: string | null }`: `billedRows(store.view(from, to), …)`, plan rows included, corrections and billing overrides applied;
    - `priceGatewayLine(entry) → row | null`: the row the next pass adds for one gateway log line, `{ day, source, provider, model, project: null, center, keyId, agent, kind, listUSD, billedUSD, billingAssumed? }`, or `null` for a line the ledger skips;
    - `gatewayPasses() → number`: how many gateway steps were applied since start.
  - `lib/cost/collect.js` also exports `projectOf(path, home)`.
  - `createBudgetService({ getSettings, getLegacy, cost, home, now, nocase, demo, lastFile })` (`lib/cost/budget-service.js`) returning:
    - `list() → { budgets, saved, legacy, error, reasons, complete }` (`budgets` is the effective list, `saved` the list in force (from `config.json`, else the last valid one), `legacy` every legacy budget, `complete` false while the saved list or `config.json` does not read);
    - `evaluate() → view[]`, `evaluateOne(budget, t?) → view`;
    - `record(entry)`, `pass(run) → run's result`, `invalidate()`, `pendingCount() → number`;
    - `complete() → boolean`, `keyCenter(keyId) → center id | 'unassigned'`, `centerOfProject(project) → center id | 'unassigned'`;
    - `monthly() → { monthlyBudgetUSD, monthlyBudgetManaged }`;
    - `reportGuard(message | null)`, `status() → { error, reasons, guard, kept }` (`kept` is a path-free phrase when `budgets.last.json` could not be written, else `null`).
  - `lastFile` is the path of `budgets.last.json` (`null`: nothing is kept on disk, as in the demo). It holds `{ version: 1, budgets, context: { currency, centers } }`: the last list that validated, normalized, with the display currency code and center ids it validated against. Legacy budgets are never stored in it.
  - `getSettings()` returns the raw `config.json` → `cost` section (`false` when `config.json` does not parse); `getLegacy()` returns `{ monthlyBudgetUSD, keys }` (the raw top-level number and `gateway.keys.list()`); `demo` is `{ noData: { [budgetId]: reason } }` or `null`.

- [ ] **Step 1: Write the failing test**

```js
// test/cost-budget-service.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createBudgetService } = require('../lib/cost/budget-service');
const { createGuard } = require('../lib/cost/guard');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (d, h = 12, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026, local time
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} is not ${b}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-budget-service-'));
const BASE = {
  centers: [{ id: 'acme', name: 'Acme' }],
  keyCenters: { key_a: 'acme' },
  folderRules: [{ glob: '~/work/acme/**', center: 'acme' }],
};
const KEY_BUDGET = { id: 'acme', name: 'Acme', scope: { dim: 'key', value: 'key_a' }, period: 'month', amount: 1, enforce: 'block' };
// One gateway call of Sonnet, 1,000 in and 100 out: 0.003 at PRICE_A.
const entry = (ts, extra = {}) => ({
  ts,
  keyId: 'key_a',
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet-5.5',
  kind: 'chat',
  status: 200,
  input: 1000,
  output: 100,
  cached: 0,
  ...extra,
});

function rig({ budgets = [], legacy = {}, demo = null, dir = tmp() } = {}) {
  const st = { pricing: PRICE_A, settings: { ...BASE, budgets }, legacy, t: at(22) };
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const cost = createCost({
    dir: path.join(dir, 'cost'),
    gatewayLog,
    getPricing: () => st.pricing,
    getSettings: () => st.settings,
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const make = () =>
    createBudgetService({
      getSettings: () => st.settings,
      getLegacy: () => st.legacy,
      cost,
      home: HOME,
      now: () => st.t,
      nocase: false,
      demo,
      lastFile,
    });
  const lastFile = path.join(dir, 'cost', 'budgets.last.json');
  const s = make();
  // As the gateway does it: the line is appended (synchronously), then the call is reported.
  const send = (ts, extra) => {
    const e = entry(ts, extra);
    fs.appendFileSync(gatewayLog, JSON.stringify(e) + '\n');
    s.record(e);
  };
  return { st, cost, s, make, send, gatewayLog, lastFile, dir };
}
const spentOf = (s, id) => s.evaluate().find((v) => v.id === id).spentUSD;

test('priceGatewayLine: the row the next pass adds, or null for a line the ledger skips', () => {
  const r = rig();
  const row = r.cost.priceGatewayLine(entry(at(22, 10)));
  assert.deepEqual(
    { day: row.day, source: row.source, model: row.model, keyId: row.keyId, center: row.center, kind: row.kind },
    { day: '2026-10-22', source: 'gateway', model: 'claude-sonnet-5-5', keyId: 'key_a', center: 'acme', kind: 'chat' },
  );
  near(row.listUSD, 0.003);
  near(row.billedUSD, 0.003);
  assert.equal(r.cost.priceGatewayLine(entry(at(22), { client: 'claude-code', local: true })), null, 'from the logs');
  assert.equal(r.cost.priceGatewayLine(entry(at(22), { input: 0, output: 0 })), null, 'a failed attempt');
  assert.equal(r.cost.priceGatewayLine(entry(at(22), { keyId: 'dashboard', agent: 'judge' })).source, 'judge');
  assert.equal(r.cost.priceGatewayLine(entry(at(22), { runId: 'r1', agent: 'planner' })).source, 'collab');
  assert.equal(r.cost.gatewayPasses(), 0);
  r.cost.update();
  assert.equal(r.cost.gatewayPasses(), 1);
});

test('a pass between two requests: each call counts once, before and after the ledger reads it', () => {
  const r = rig({ budgets: [KEY_BUDGET] });
  r.send(at(22, 10));
  near(spentOf(r.s, 'acme'), 0.003, 'in memory only: the ledger has not read it');
  assert.equal(r.s.pendingCount(), 1);
  r.s.pass(() => r.cost.update());
  assert.equal(r.s.pendingCount(), 0, 'the pass read it');
  near(spentOf(r.s, 'acme'), 0.003, 'counted once, now from the ledger');
  r.send(at(22, 10, 5));
  near(spentOf(r.s, 'acme'), 0.006);
  r.s.pass(() => {}); // a pass whose gateway step did not run (the log did not read, or the positions are lost)
  assert.equal(r.s.pendingCount(), 1, 'kept until a pass reads it');
  near(spentOf(r.s, 'acme'), 0.006);
  r.s.pass(() => {
    r.cost.update();
    r.send(at(22, 10, 10)); // recorded after this pass read the log
  });
  assert.equal(r.s.pendingCount(), 1, 'a call after the mark waits for the next pass');
  near(spentOf(r.s, 'acme'), 0.009);
  r.s.pass(() => r.cost.update());
  assert.equal(r.s.pendingCount(), 0);
  near(spentOf(r.s, 'acme'), 0.009);
});

test('an increment from before the current periods is dropped', () => {
  const r = rig({ budgets: [KEY_BUDGET] });
  r.send(at(22, 10));
  r.st.t = new Date(2026, 10, 3, 12).getTime(); // Tuesday 3 November: the week and the month began after the call
  r.send(new Date(2026, 10, 3, 9).getTime());
  assert.equal(r.s.pendingCount(), 1);
  near(spentOf(r.s, 'acme'), 0.003, 'the new month counts only its own call');
});

test('spent follows the ledger read: a restate correction and a billing override apply', () => {
  const all = { id: 'all', name: 'All', scope: 'global', period: 'month', amount: 1 };
  const paid = { id: 'paid', name: 'Paid', scope: { dim: 'source', value: 'gateway' }, period: 'month', amount: 100, measure: 'billed' };
  const r = rig({ budgets: [all, paid] });
  r.st.t = at(21);
  fs.appendFileSync(r.gatewayLog, JSON.stringify(entry(at(21, 10))) + '\n');
  r.cost.update();
  r.st.t = at(22);
  r.st.pricing = PRICE_B;
  r.cost.update();
  near(spentOf(r.s, 'all'), 0.003, 'a closed day keeps the price of its day');
  r.cost.restate({ from: '2026-10-21', to: '2026-10-21', reason: 'new prices' });
  r.s.invalidate();
  near(spentOf(r.s, 'all'), 0.006, 'the correction applies');
  near(spentOf(r.s, 'paid'), 0.006);
  r.cost.addBillingOverride({
    source: 'gateway',
    from: '2026-10-01',
    to: '2026-10-21',
    billing: { mode: 'plan', plan: 'Team', feeUSD: 31, period: 'month' },
  });
  r.s.invalidate();
  near(spentOf(r.s, 'paid'), 21, 'on the plan: one day of the fee a day, the usage billed 0');
  near(spentOf(r.s, 'all'), 0.006, 'the usage value does not change');
});

test('the last valid list stays in force while a hand edit does not validate, and is kept in budgets.last.json', () => {
  const r = rig({ budgets: [KEY_BUDGET] });
  assert.deepEqual(r.s.list().budgets.map((b) => b.id), ['acme']);
  assert.equal(r.s.list().complete, true);
  const kept = JSON.parse(fs.readFileSync(r.lastFile, 'utf8'));
  assert.deepEqual([kept.version, kept.budgets.map((b) => b.id), kept.context.centers], [1, ['acme'], ['acme']]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.lastFile).mode & 0o777, 0o600);
  r.st.settings = { ...BASE, budgets: [{ id: 'acme', name: '' }] };
  let l = r.s.list();
  assert.deepEqual(l.budgets.map((b) => b.id), ['acme']);
  assert.equal(l.complete, false);
  assert.equal(l.error, 'budgets in config.json are invalid; the last valid list is in force');
  assert.ok(l.reasons.some((x) => /budgets\[0\]\.name/.test(x)), l.reasons.join());
  assert.deepEqual(JSON.parse(fs.readFileSync(r.lastFile, 'utf8')).budgets.map((b) => b.id), ['acme'], 'not overwritten');
  r.st.settings = false; // config.json does not parse
  l = r.s.list();
  assert.equal(l.error, 'config.json could not be read; the last valid budget list is in force');
  assert.deepEqual(l.budgets.map((b) => b.id), ['acme']);
  r.st.settings = { ...BASE, budgets: [] };
  l = r.s.list();
  assert.equal(l.complete, true);
  assert.deepEqual(l.budgets, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.lastFile, 'utf8')).budgets, [], 'a valid save overwrites the file');
});

test('a restart on a broken hand edit still enforces the last valid list, a blocking budget included', () => {
  const tiny = { ...KEY_BUDGET, amount: 0.001 };
  const r = rig({ budgets: [tiny] });
  r.send(at(22, 10));
  r.s.pass(() => r.cost.update()); // the call is in the ledger: 0.003 against 0.001
  r.st.settings = { ...BASE, budgets: [{ id: 'acme', name: '' }] }; // the hand edit
  const after = r.make(); // the restart: nothing in memory
  const l = after.list();
  assert.deepEqual(l.budgets.map((b) => [b.id, b.enforce]), [['acme', 'block']]);
  assert.equal(l.error, 'budgets in config.json are invalid; the last valid list is in force');
  assert.equal(createGuard({ service: after }).check({ keyId: 'key_a' }).budget, 'acme', 'still blocks');
  r.st.settings = false;
  assert.deepEqual(r.make().list().budgets.map((b) => b.id), ['acme'], 'also when config.json does not parse');
});

test('a corrupt budgets.last.json with an invalid config: the old settings alone, with a warning; a valid config wins', () => {
  const r = rig({ budgets: [KEY_BUDGET], legacy: { monthlyBudgetUSD: 300 } });
  r.s.list(); // writes the file
  fs.writeFileSync(r.lastFile, '{"version":1,"budgets":[{"id":', { mode: 0o600 });
  r.st.settings = { ...BASE, budgets: [{ id: 'x' }] };
  let l = r.make().list();
  assert.deepEqual(l.budgets.map((b) => b.id), ['legacy-monthly']);
  assert.equal(l.error, 'budgets in config.json are invalid and no valid list was kept; only the old settings apply');
  fs.writeFileSync(r.lastFile, JSON.stringify({ version: 1, budgets: [{ id: 'bad' }], context: {} }), { mode: 0o600 });
  assert.deepEqual(r.make().list().budgets.map((b) => b.id), ['legacy-monthly'], 'a kept list that does not validate');
  const other = { id: 'other', name: 'Other', scope: 'global', period: 'day', amount: 5 };
  fs.writeFileSync(r.lastFile, JSON.stringify({ version: 1, budgets: [other], context: { currency: null, centers: [] } }));
  r.st.settings = { ...BASE, budgets: [KEY_BUDGET] };
  l = r.make().list();
  assert.deepEqual(l.budgets.map((b) => b.id), ['acme', 'legacy-monthly'], 'the valid config wins over the file');
  assert.equal(l.error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.lastFile, 'utf8')).budgets.map((b) => b.id), ['acme']);
  const onDisk = JSON.parse(fs.readFileSync(r.lastFile, 'utf8')).budgets;
  assert.ok(onDisk.every((b) => b.legacy === null && !b.id.startsWith('legacy-')), 'legacy budgets are never kept');
});

test('legacy budgets merge, the key and folder centers, the monthly figure, the demo stand-in', () => {
  const r = rig({
    budgets: [{ id: 'legacy-monthly', name: 'Team month', scope: 'global', period: 'month', amount: 400 }],
    legacy: { monthlyBudgetUSD: 300, keys: [{ id: 'key_a', name: 'Acme app', budgetUSD: 5 }] },
  });
  const l = r.s.list();
  assert.deepEqual(
    l.budgets.map((b) => [b.id, b.legacy]),
    [
      ['legacy-monthly', null],
      ['legacy-key-key_a', 'keyBudget'],
    ],
  );
  assert.deepEqual(l.legacy.map((b) => b.id), ['legacy-monthly', 'legacy-key-key_a']);
  assert.equal(r.s.keyCenter('key_a'), 'acme');
  assert.equal(r.s.keyCenter('key_x'), 'unassigned');
  assert.equal(r.s.centerOfProject('~/work/acme/web'), 'acme');
  assert.equal(r.s.centerOfProject('~/elsewhere'), 'unassigned');
  assert.deepEqual(r.s.monthly(), { monthlyBudgetUSD: 400, monthlyBudgetManaged: true });
  const d = rig({ budgets: [KEY_BUDGET], demo: { noData: { acme: 'the billing history could not be read (demo)' } } });
  const v = d.s.evaluate()[0];
  assert.equal(v.state, 'no_data');
  assert.match(v.reason, /\(demo\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-budget-service.test.js`
Expected: FAIL with `Cannot find module '../lib/cost/budget-service'`.

- [ ] **Step 3: Add the ledger reads to `lib/cost/index.js`**

1. `:14`, take the pricer factory too:

```js
const { normalizeModel, makePricer } = require('../pricing');
```

2. After `const sticky = new Map(); …` (`:137`):

```js
  let gatewayPasses = 0; // gateway steps applied since start: the budget service drops what a pass read (budget-service.js)
```

3. In `run()` (`:413-428`), right after `st.error = null;`:

```js
      if (name === 'gateway') gatewayPasses++;
```

4. Before `return {` (`:672`):

```js
  // The rows a budget sums (lib/cost/budgets.js): the reader's view with the corrections and the billing applied, plan
  // rows included. `unread` names what the view skipped; `billingError` is set while the billing history does not
  // read (the rows are then billed as metered, which a budget on what was paid must not take for the bill).
  function budgetRows({ from, to }) {
    const rows = billedRows(store.view(from, to), {
      from,
      to,
      today: dayOf(now()),
      billingFor: billing.billingFor,
      backfilled: backfilledDay,
    });
    return { rows, unread: [...rows.unread], billingError: billing.error() ? 'the billing history could not be read' : null };
  }

  // One gateway log line as the row the next pass adds for it (the same collector, the price version of its day and
  // the same attribution), for the budget guard's count of the calls the ledger has not read yet. null for a line the
  // ledger does not take (a local tool's line, a failed attempt). Before the first pass there is no price version:
  // the current prices stand in.
  function priceGatewayLine(line) {
    const ev = gatewayEvent(line, { isPrivate });
    if (!ev) return null;
    const day = dayOf(ev.ts);
    const v = prices.versionFor(day);
    const p = priceEvent(v ? prices.pricerFor(v.id) : makePricer(getPricing() || {}), ev);
    const b = billing.billingFor(ev.source, day);
    return {
      day,
      source: ev.source,
      provider: ev.provider,
      model: normalizeModel(ev.model) || null,
      project: null,
      center: settingsNow().rules.centerOf(ev),
      keyId: ev.keyId,
      agent: ev.agent,
      kind: ev.kind,
      listUSD: p.listUSD,
      billedUSD: b.mode === 'plan' ? 0 : p.listUSD,
      ...(b.assumed ? { billingAssumed: true } : {}),
    };
  }
```

5. Add to the returned object, after `restate,`:

```js
    budgetRows,
    priceGatewayLine,
    gatewayPasses: () => gatewayPasses,
```

- [ ] **Step 4: Export `projectOf` from `lib/cost/collect.js`** (`:250`)

```js
module.exports = { localEvents, gatewayEvent, judgeLine, judgeEvent, priceEvent, readNew, headOf, projectOf };
```

- [ ] **Step 5: Write `lib/cost/budget-service.js`**

```js
// The budgets in force and what they spent, for the API, the Monitors engine and the gateway guard. The list is
// config.json "cost.budgets" (validated; while a hand edit does not validate or config.json does not parse, the last
// valid list stays in force, kept across restarts in budgets.last.json) plus the old settings read as budgets (monthlyBudgetUSD, a key's budgetUSD); a saved budget wins
// over the old setting of the same id. Spent is the ledger's (cost.budgetRows) plus the gateway calls recorded since
// the last pass that read the gateway log.
//
// No double count: record() runs right after the gateway appended the line (synchronously, lib/gateway/store.js),
// and a ledger pass is synchronous too, so no call is recorded while a pass reads. pass() takes the last sequence
// number before the pass; when the pass applied its gateway step (cost.gatewayPasses() went up), every call up to
// that number is in the ledger and is dropped here. A call recorded after the mark, or a pass whose gateway step
// stopped, keeps its increment until a pass reads it.
const fs = require('fs');
const B = require('./budgets');
const { settingsOf, compile } = require('./rules');
const { dayOf } = require('./days');
const { writePrivate } = require('./files');

// Path-free status phrases: the list in force while config.json's does not validate or read.
const LIST_KEPT = 'budgets in config.json are invalid; the last valid list is in force';
const LIST_NONE = 'budgets in config.json are invalid and no valid list was kept; only the old settings apply';
const UNREAD_KEPT = 'config.json could not be read; the last valid budget list is in force';
const UNREAD_NONE = 'config.json could not be read and no valid budget list was kept; only the old settings apply';
const MAX_WINDOWS = 24; // cached ledger reads: three periods a day, a few days

function createBudgetService({
  getSettings = () => undefined,
  getLegacy = () => ({}),
  cost,
  home = '',
  now = Date.now,
  nocase,
  demo = null,
  lastFile = null, // <cost dir>/budgets.last.json; null keeps nothing on disk (the demo)
} = {}) {
  const NONE = {}; // no getter returns this, so the first read always validates
  let lastRaw = NONE;
  let saved = [];
  let inForce = false; // `saved` came from a list that validated (this process or budgets.last.json)
  let listError = null;
  let reasons = [];
  let keepError = null;
  let keptText = null; // what budgets.last.json holds, so it is written only when the list changes
  // The last cost settings that read: the display currency, the centers and the folder rules.
  let good = settingsOf(undefined).value;
  let goodRead = false;
  let rules = compile(good, nocase === undefined ? {} : { nocase });
  let guardError = null;
  let seq = 0;
  let pending = []; // { seq, row }: gateway calls the ledger has not read yet
  const windows = new Map(); // `${from}|${to}|${today}` -> cost.budgetRows(...)

  const contextOf = (v) => ({ currency: v.currency ? v.currency.code : null, centers: v.centers.map((c) => c.id), home });

  // A list that validated: in force, and written to budgets.last.json (0600, fsync, rename) when it changed. Legacy
  // budgets are never stored: they always come from the current old settings.
  function keep(list) {
    saved = list;
    inForce = true;
    if (!lastFile) return;
    const ctx = contextOf(good);
    const text = JSON.stringify({ version: 1, budgets: list, context: { currency: ctx.currency, centers: ctx.centers } });
    if (text === keptText) return;
    try {
      writePrivate(lastFile, text);
      keptText = text;
      keepError = null;
    } catch (e) {
      keepError = `the last valid budget list could not be kept${e && typeof e.code === 'string' ? ` (${e.code})` : ''}`;
    }
  }

  // budgets.last.json after a restart: its list, validated against the cost settings that read now, or against the
  // ones it was kept with while config.json does not parse. null when it is missing, does not parse or does not
  // validate: then only the legacy budgets apply.
  function kept() {
    if (!lastFile) return null;
    let v;
    try {
      keptText = fs.readFileSync(lastFile, 'utf8');
      v = JSON.parse(keptText);
    } catch {
      return null;
    }
    if (!v || typeof v !== 'object' || v.version !== 1) return null;
    const c = v.context && typeof v.context === 'object' ? v.context : {};
    const ctx = goodRead
      ? contextOf(good)
      : { currency: typeof c.currency === 'string' ? c.currency : null, centers: Array.isArray(c.centers) ? c.centers : [], home };
    const r = B.validateList(v.budgets, ctx);
    return r.ok ? r.value : null;
  }

  // Not valid now: the list in force stays, else the kept one is read once; the warning says which applies.
  function fallBack(whenKept, whenNone) {
    if (!inForce) {
      const k = kept();
      if (k) {
        saved = k;
        inForce = true;
      }
    }
    listError = inForce ? whenKept : whenNone;
  }

  function readSaved() {
    const raw = getSettings();
    if (raw === lastRaw) return;
    lastRaw = raw;
    if (raw === false) {
      reasons = [];
      fallBack(UNREAD_KEPT, UNREAD_NONE);
      return;
    }
    const s = settingsOf(raw, { home });
    if (!s.error) {
      good = s.value;
      goodRead = true;
      rules = compile(good, nocase === undefined ? {} : { nocase });
    }
    const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.budgets : undefined;
    if (list === undefined || list === null) {
      listError = null;
      reasons = [];
      keep([]);
      return;
    }
    const r = B.validateList(list, contextOf(good));
    if (r.ok) {
      listError = null;
      reasons = [];
      keep(r.value);
    } else {
      reasons = r.errors;
      fallBack(LIST_KEPT, LIST_NONE);
    }
  }

  function legacy() {
    try {
      return B.legacyBudgets(getLegacy() || {});
    } catch {
      return [];
    }
  }

  function list() {
    readSaved();
    const old = legacy();
    return {
      budgets: B.effectiveBudgets(saved, old),
      saved: saved.map(B.copyBudget),
      legacy: old,
      error: listError,
      reasons: [...reasons],
      complete: listError === null,
    };
  }

  const invalidate = () => windows.clear();
  // One ledger read per period window and day, until a pass or a change invalidates it.
  function rowsFor(from, to, t) {
    const k = `${from}|${to}|${dayOf(t)}`;
    if (!windows.has(k)) {
      if (windows.size >= MAX_WINDOWS) windows.clear();
      windows.set(k, cost.budgetRows({ from, to }));
    }
    return windows.get(k);
  }

  function evaluateOne(b, t = now()) {
    const p = B.periodBounds(b.period, t);
    // The demo's stand-in for an input that did not read: shown as no_data, with its reason.
    if (demo && demo.noData && Object.hasOwn(demo.noData, b.id)) return B.noDataView(b, p, demo.noData[b.id]);
    let w;
    try {
      w = rowsFor(p.from, p.to, t);
    } catch {
      return B.noDataView(b, p, 'the ledger could not be read');
    }
    return B.evaluateBudget(b, {
      rows: w.rows,
      extra: pending.map((x) => x.row),
      unread: w.unread,
      billingError: w.billingError,
      currency: good.currency,
      now: t,
    });
  }

  function evaluate() {
    const t = now();
    return list().budgets.map((b) => evaluateOne(b, t));
  }

  // Calls from before the earliest current period (the month's or the week's start) can never count again.
  function prune(t) {
    const keep = [B.periodBounds('month', t).from, B.periodBounds('week', t).from].sort()[0];
    pending = pending.filter((x) => x.row.day >= keep);
  }

  function record(e) {
    if (!cost || typeof cost.priceGatewayLine !== 'function') return;
    let row = null;
    try {
      row = cost.priceGatewayLine(e);
    } catch {
      row = null; // a budget never fails a request
    }
    if (!row) return;
    pending.push({ seq: ++seq, row });
    prune(now());
  }

  function pass(run) {
    const mark = seq;
    const before = cost.gatewayPasses();
    try {
      return run();
    } finally {
      if (cost.gatewayPasses() > before) pending = pending.filter((x) => x.seq > mark);
      invalidate();
      prune(now());
    }
  }

  function monthly() {
    readSaved();
    let m;
    try {
      m = (getLegacy() || {}).monthlyBudgetUSD;
    } catch {
      m = undefined;
    }
    return B.monthlyFigure({ saved, monthlyBudgetUSD: m, currency: good.currency, now: now() });
  }

  readSaved(); // on load: a list that validates is kept at once, before any request reads it
  return {
    list,
    evaluate,
    evaluateOne,
    record,
    pass,
    invalidate,
    pendingCount: () => pending.length,
    complete: () => list().complete,
    keyCenter(keyId) {
      readSaved();
      return rules.centerOf({ keyId });
    },
    centerOfProject(project) {
      readSaved();
      return rules.centerOf({ project });
    },
    monthly,
    reportGuard(message) {
      guardError = message || null;
    },
    status() {
      readSaved();
      return { error: listError, reasons: [...reasons], guard: guardError, kept: keepError };
    },
  };
}

module.exports = { createBudgetService, LIST_KEPT, LIST_NONE, UNREAD_KEPT, UNREAD_NONE };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/cost-budget-service.test.js test/cost-pass.test.js test/cost-api.test.js test/cost-collect.test.js`
Expected: PASS. The ledger tests stay green: nothing in the pass changed but a counter.

- [ ] **Step 7: Commit**

```bash
git add lib/cost/index.js lib/cost/collect.js lib/cost/budget-service.js test/cost-budget-service.test.js
git commit -m "Budget service: budgets in force, ledger reads, gateway increments retired by the pass"
```

---
### Task 3: The gateway guard (shared: `lib/gateway/index.js`)

**Files:**
- Create: `lib/cost/guard.js`
- Modify: `lib/gateway/index.js` (shared). Each edit is listed in Step 4; with no `budgetGuard` option the gateway behaves exactly as today (every existing gateway test builds it without one).
- Test: `test/cost-guard.test.js`

**Interfaces:**
- Consumes: the service from Task 2 (`list`, `evaluateOne`, `keyCenter`, `reportGuard`, `record`, `pass`); `normalizeModel` (`lib/pricing.js`).
- Produces:
  - `createGuard({ service })` (`lib/cost/guard.js`) returning:
    - `check({ keyId, model, provider, agent, runId }) → null | { budget: id, message }`;
    - `keyLimited(keyId) → boolean`: a blocking key or center budget applies to this key.
  - `createGateway({ …, budgetGuard })`: `budgetGuard` is `{ check(ctx), keyLimited(keyId), record(entry) }` or absent.

- [ ] **Step 1: Write the failing test**

```js
// test/cost-guard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createGuard } = require('../lib/cost/guard');
const { createBudgetService } = require('../lib/cost/budget-service');
const { createCost } = require('../lib/cost');
const { createGateway } = require('../lib/gateway');
const { fakeServer, secretsFor } = require('./helpers');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (m, d, h = 12) => new Date(2026, m - 1, d, h).getTime();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} is not ${b}`);
const blk = (id, scope, over = {}) => ({
  id,
  name: id.toUpperCase(),
  scope,
  period: 'month',
  amount: 1,
  currency: 'USD',
  measure: 'list',
  thresholds: [50, 80],
  projection: true,
  enforce: 'block',
  legacy: null,
  ...over,
});
function fake(budgets, views = {}) {
  const reports = [];
  const service = {
    list: () => {
      if (budgets instanceof Error) throw budgets;
      return { budgets };
    },
    evaluateOne: (b) => {
      const v = views[b.id];
      if (v instanceof Error) throw v;
      return { state: 'ok', reason: null, ...v };
    },
    keyCenter: (k) => (k === 'key_a' ? 'acme' : 'unassigned'),
    reportGuard: (m) => reports.push(m),
  };
  return { reports, guard: createGuard({ service }) };
}

test('guard: which blocking budgets a call meets; dashboard calls meet only global, model and provider', () => {
  const all = [
    blk('glob', 'global'),
    blk('key', { dim: 'key', value: 'key_a' }),
    blk('center', { dim: 'center', value: 'acme' }),
    blk('model', { dim: 'model', value: 'claude-sonnet-5-5' }),
    blk('prov', { dim: 'provider', value: 'groq' }),
    blk('gw', { dim: 'source', value: 'gateway' }),
  ];
  const hit = (id, ctx) => {
    const r = fake(all, { [id]: { state: 'exceeded' } }).guard.check(ctx);
    return r && r.budget;
  };
  const key = { keyId: 'key_a', model: 'fake/x', provider: 'openrouter' };
  const dash = { keyId: 'dashboard', model: 'fake/x', provider: 'openrouter' };
  assert.equal(hit('glob', key), 'glob');
  assert.equal(hit('glob', dash), 'glob');
  assert.equal(hit('key', key), 'key');
  assert.equal(hit('key', { ...key, keyId: 'key_b' }), null);
  assert.equal(hit('key', dash), null);
  assert.equal(hit('center', key), 'center', 'through the key center');
  assert.equal(hit('center', { ...key, keyId: 'key_b' }), null);
  assert.equal(hit('center', dash), null);
  assert.equal(hit('model', { ...key, model: 'anthropic/claude-sonnet-5.5' }), 'model', 'normalized like the ledger');
  assert.equal(hit('model', { ...dash, model: 'anthropic/claude-sonnet-5.5' }), 'model');
  assert.equal(hit('prov', { ...dash, provider: 'groq' }), 'prov');
  assert.equal(hit('prov', key), null);
  assert.equal(hit('gw', key), 'gw');
  assert.equal(hit('gw', { ...key, runId: 'r1' }), null, 'a collaboration run is source collab');
  assert.equal(hit('gw', { ...key, agent: 'replay' }), null);
  assert.equal(hit('gw', { ...key, agent: 'judge' }), null);
  assert.equal(hit('gw', dash), null);
});

test('guard: the refusal names only its budget and period; warnings, notify-only and pause never block', () => {
  const one = fake([blk('team', 'global', { name: 'Team', period: 'day' })], { team: { state: 'exceeded' } });
  assert.deepEqual(one.guard.check({ keyId: 'key_a' }), { budget: 'team', message: 'budget "Team" is used up for this day' });
  assert.equal(fake([blk('a', 'global')], { a: { state: 'warn_80' } }).guard.check({ keyId: 'key_a' }), null);
  assert.equal(fake([blk('a', 'global', { enforce: 'none' })], { a: { state: 'exceeded' } }).guard.check({}), null);
  assert.equal(fake([blk('a', 'global', { enforce: 'pause' })], { a: { state: 'exceeded' } }).guard.check({}), null);
  const both = fake([blk('first', 'global'), blk('second', 'global')], {
    first: { state: 'ok' },
    second: { state: 'exceeded' },
  });
  assert.equal(both.guard.check({}).budget, 'second', 'the first exhausted one in scope');
});

test('guard: allows when spent cannot be computed, and says why', () => {
  const nd = fake([blk('a', 'global', { name: 'Team' })], { a: { state: 'no_data', reason: 'the ledger could not read 2026-10' } });
  assert.equal(nd.guard.check({ keyId: 'key_a' }), null);
  assert.match(nd.reports.at(-1), /budget "Team" has no data \(the ledger could not read 2026-10\), so its requests are allowed/);
  const thrown = fake([blk('a', 'global')], { a: new Error('EIO') });
  assert.equal(thrown.guard.check({}), null);
  assert.match(thrown.reports.at(-1), /could not be checked/);
  const unreadable = fake(new Error('boom'));
  assert.equal(unreadable.guard.check({}), null);
  assert.match(unreadable.reports.at(-1), /budgets could not be read/);
  const clean = fake([blk('a', 'global')]);
  clean.guard.check({});
  assert.equal(clean.reports.at(-1), null, 'a clean check clears the report');
  // With the real service: a ledger month that did not read lets even an exhausted key through.
  const broken = { budgetRows: () => ({ rows: [], unread: ['2026-10'], billingError: null }), priceGatewayLine: () => null, gatewayPasses: () => 0 };
  const svc = createBudgetService({
    getSettings: () => undefined,
    getLegacy: () => ({ keys: [{ id: 'key_a', name: 'App', budgetUSD: 0 }] }),
    cost: broken,
    now: () => at(10, 22),
  });
  assert.equal(createGuard({ service: svc }).check({ keyId: 'key_a' }), null);
  assert.match(svc.status().guard, /could not read 2026-10/);
});

test('guard: keyLimited for blocking key and center budgets only', () => {
  const g = (list) => fake(list).guard;
  assert.equal(g([blk('k', { dim: 'key', value: 'key_a' })]).keyLimited('key_a'), true);
  assert.equal(g([blk('k', { dim: 'key', value: 'key_a' })]).keyLimited('key_b'), false);
  assert.equal(g([blk('c', { dim: 'center', value: 'acme' })]).keyLimited('key_a'), true);
  assert.equal(g([blk('c', { dim: 'center', value: 'acme' }, { enforce: 'none' })]).keyLimited('key_a'), false);
  assert.equal(g([blk('all', 'global')]).keyLimited('key_a'), false);
});

// ---- in process: the gateway with a fake upstream, the real ledger, service and guard ----
const PRICING = { 'llama-9': { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 } };
const completion = () => ({
  id: 'c1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 500 }, // 0.002 at PRICING
});

async function setup() {
  const upstream = await fakeServer({
    'POST /chat/completions': () => ({ body: completion() }),
    'GET /models': { body: { data: [{ id: 'llama-9' }, { id: 'tiny' }] } },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-guard-'));
  const clock = { t: at(10, 22) };
  const st = { settings: undefined };
  const cost = createCost({
    dir: path.join(dataDir, 'cost'),
    gatewayLog: path.join(dataDir, 'gateway-usage.jsonl'),
    getPricing: () => PRICING,
    getSettings: () => st.settings,
    home: HOME,
    now: () => clock.t,
    nocase: false,
  });
  let gateway = null;
  const service = createBudgetService({
    getSettings: () => st.settings,
    getLegacy: () => ({ keys: gateway ? gateway.keys.list() : [] }),
    cost,
    home: HOME,
    now: () => clock.t,
  });
  const guard = createGuard({ service });
  gateway = createGateway({
    dataDir,
    getConfig: () => ({ gateway: { providers: [{ id: 'fake', preset: 'custom', baseUrl: upstream.url, models: [], enabled: true }] } }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => PRICING,
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
    now: () => clock.t,
    budgetGuard: { check: guard.check, keyLimited: guard.keyLimited, record: service.record },
  });
  const server = http.createServer(async (req, res) => {
    if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chat = async (secret, model = 'fake/llama-9') => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }] }),
    });
    return { status: r.status, text: await r.text() };
  };
  const spent = (id) => service.evaluate().find((v) => v.id === id).spentUSD;
  const close = async () => {
    server.close();
    await upstream.close();
  };
  return { gateway, cost, service, st, clock, chat, spent, close };
}

test('gateway: a key budget blocks at once, is counted once across a pass, and lifts on a raised amount or a new month', async () => {
  const t = await setup();
  try {
    const { key, secret } = t.gateway.keys.create({ name: 'app', scopes: ['llm'], budgetUSD: 0.002 });
    const id = `legacy-key-${key.id}`;
    t.st.settings = { budgets: [{ id: 'secret-team', name: 'Secret team', scope: 'global', period: 'month', amount: 100, enforce: 'block' }] };
    assert.equal((await t.chat(secret)).status, 200);
    near(t.spent(id), 0.002, 'counted before the ledger read it');
    const refused = await t.chat(secret);
    assert.equal(refused.status, 402);
    assert.match(refused.text, /budget \\?"Key app\\?" is used up for this month/);
    assert.doesNotMatch(refused.text, /Secret team|\$|0\.002/, 'no other budget, no figures');
    t.service.pass(() => t.cost.update());
    assert.equal(t.service.pendingCount(), 0);
    near(t.spent(id), 0.002, 'once, now from the ledger');
    assert.equal((await t.chat(secret)).status, 402);
    t.gateway.keys.update(key.id, { budgetUSD: 1 });
    assert.equal((await t.chat(secret)).status, 200, 'a raised amount lifts the block');
    t.gateway.keys.update(key.id, { budgetUSD: 0.002 });
    assert.equal((await t.chat(secret)).status, 402);
    t.clock.t = at(11, 2);
    assert.equal((await t.chat(secret)).status, 200, 'a new month starts at 0');
  } finally {
    await t.close();
  }
});

test('gateway: a budget can pass its amount by one call; dashboard calls meet global and provider budgets only', async () => {
  const t = await setup();
  try {
    const { secret } = t.gateway.keys.create({ name: 'app', scopes: ['llm'], budgetUSD: 0.003 });
    assert.equal((await t.chat(secret)).status, 200);
    assert.equal((await t.chat(secret)).status, 200, 'under the amount when it started');
    assert.equal((await t.chat(secret)).status, 402, 'over by one call, then blocked');
    const ask = () => t.gateway.judge.complete({ model: 'fake/llama-9', messages: [{ role: 'user', content: 'x' }] });
    await ask(); // the key's budget does not reach the dashboard
    t.st.settings = { budgets: [{ id: 'fake-day', name: 'Fake provider', scope: { dim: 'provider', value: 'fake' }, period: 'day', amount: 0.001, enforce: 'block' }] };
    await assert.rejects(ask(), (e) => e.status === 402 && /budget "Fake provider" is used up for this day/.test(e.message));
    t.st.settings = { budgets: [{ id: 'gw', name: 'Gateway', scope: { dim: 'source', value: 'gateway' }, period: 'month', amount: 0.001, enforce: 'block' }] };
    await ask(); // source gateway needs a key: the judge is the dashboard
    t.st.settings = { budgets: [{ id: 'all', name: 'Everything', scope: 'global', period: 'month', amount: 0.001, enforce: 'block' }] };
    await assert.rejects(ask(), (e) => e.status === 402 && /budget "Everything" is used up for this month/.test(e.message));
  } finally {
    await t.close();
  }
});

test('gateway: a key under a blocking key budget saved in Budgets may use only priced models', async () => {
  const t = await setup();
  try {
    const { key, secret } = t.gateway.keys.create({ name: 'app', scopes: ['llm'] }); // no budgetUSD of its own
    assert.equal((await t.chat(secret, 'fake/tiny')).status, 200, 'no budget yet: an unpriced model is fine');
    t.st.settings = {
      budgets: [{ id: 'k', name: 'K', scope: { dim: 'key', value: key.id }, period: 'month', amount: 5, enforce: 'block' }],
    };
    const unpriced = await t.chat(secret, 'fake/tiny');
    assert.equal(unpriced.status, 402, 'its spend could not be counted');
    assert.match(unpriced.text, /has no known price/);
    assert.equal((await t.chat(secret)).status, 200, 'a priced model still goes');
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-guard.test.js`
Expected: FAIL with `Cannot find module '../lib/cost/guard'`.

- [ ] **Step 3: Write `lib/cost/guard.js`**

```js
// The gateway's real-time budget check (Cost Control 2). Before the gateway forwards a request to a route target it
// asks check(); a blocking budget in scope that is used up refuses it, and the gateway answers 402 naming only that
// budget. Spent is the service's: the ledger total for the period plus the calls recorded since the last pass, so a
// budget blocks at once. A call already in flight finishes, so a budget can pass its amount by the calls in flight.
// Fail open: a budget whose spent cannot be computed (no_data, a read that throws) lets the request through, and the
// reason is kept for the status. Blocking every client because of a broken file is the worse failure.
const { normalizeModel } = require('../pricing');

// The ledger's source for a gateway call (lib/cost/collect.js gatewayEvent).
const sourceOf = ({ runId, agent }) => (runId ? 'collab' : agent === 'judge' ? 'judge' : agent === 'replay' ? 'replay' : 'gateway');

function createGuard({ service }) {
  // A dashboard call has no key: only global, model and provider budgets reach it.
  function applies(b, ctx) {
    if (b.enforce !== 'block') return false;
    const s = b.scope;
    if (s === 'global') return true;
    if (s.dim === 'key') return !!ctx.keyId && ctx.keyId === s.value;
    if (s.dim === 'center') return !!ctx.keyId && service.keyCenter(ctx.keyId) === s.value;
    if (s.dim === 'model') return !!ctx.model && ctx.model === s.value;
    if (s.dim === 'provider') return !!ctx.provider && ctx.provider === s.value;
    if (s.dim === 'source') return !!ctx.keyId && s.value === 'gateway' && ctx.source === 'gateway';
    return false;
  }

  function check(input = {}) {
    const keyId = input.keyId && input.keyId !== 'dashboard' ? String(input.keyId) : null;
    const ctx = {
      keyId,
      model: normalizeModel(input.model) || null,
      provider: typeof input.provider === 'string' && input.provider ? input.provider : null,
      source: sourceOf(input),
    };
    let list;
    try {
      list = service.list().budgets;
    } catch {
      service.reportGuard('the budgets could not be read, so requests are allowed');
      return null;
    }
    let problem = null;
    for (const b of list) {
      let v;
      try {
        if (!applies(b, ctx)) continue;
        v = service.evaluateOne(b);
      } catch {
        problem = `budget "${b.name}" could not be checked, so its requests are allowed`;
        continue;
      }
      if (v.state === 'no_data') {
        problem = `budget "${b.name}" has no data (${v.reason}), so its requests are allowed`;
        continue;
      }
      if (v.state === 'exceeded') {
        service.reportGuard(problem);
        return { budget: b.id, message: `budget "${b.name}" is used up for this ${b.period}` };
      }
    }
    service.reportGuard(problem);
    return null;
  }

  // A key whose spend a blocking budget counts may use only models that have a price (as a key's budgetUSD did):
  // otherwise the budget could be run past at a cost of $0.
  function keyLimited(keyId) {
    try {
      return service.list().budgets.some(
        (b) =>
          b.enforce === 'block' &&
          b.scope !== 'global' &&
          ((b.scope.dim === 'key' && b.scope.value === keyId) ||
            (b.scope.dim === 'center' && service.keyCenter(keyId) === b.scope.value)),
      );
    } catch {
      return false;
    }
  }

  return { check, keyLimited };
}

module.exports = { createGuard };
```

- [ ] **Step 4: Edit `lib/gateway/index.js`** (shared; re-read each spot first)

1. `createGateway` options (`:67-82`): add `budgetGuard = null,` after `fetchImpl,`.

2. Right after the `usage` creation (`:92-94`):

```js
  // Cost Control budgets: each recorded call is reported to the budget service, which counts it until the next ledger
  // pass reads it (lib/cost/budget-service.js). A budget never fails a request.
  if (budgetGuard && typeof budgetGuard.record === 'function') {
    const recordUsage = usage.record;
    usage.record = (e) => {
      const entry = recordUsage(e);
      try {
        budgetGuard.record(entry);
      } catch {
        /* the request goes on */
      }
      return entry;
    };
  }
```

3. After `checkBudget` (`:103-107`):

```js
  // With the budget guard (lib/cost/guard.js) each route target is checked against the blocking budgets in scope: a
  // refused target is skipped, and a request no target may take gets 402 naming only the budget that refused it.
  // Without the guard the list is returned as it is (checkBudget, the key's own monthly budget, applies instead).
  // `modelOf` gives the name the call is logged under, which the ledger's model is made from.
  function allowedTargets(list, { keyId = null, agent, runId, modelOf = (t) => t.name } = {}) {
    if (!budgetGuard) return list;
    let refusal = null;
    const ok = list.filter((t) => {
      let r = null;
      try {
        r = budgetGuard.check({ keyId, model: modelOf(t), provider: t.provider && t.provider.id, agent, runId });
      } catch {
        r = null;
      }
      if (r && !refusal) refusal = r;
      return !r;
    });
    if (!ok.length && refusal) throw new HttpError(402, refusal.message, 'insufficient_quota');
    return ok;
  }
  const limitedKey = (k) => !!k && (k.budgetUSD != null || (!!budgetGuard && budgetGuard.keyLimited(k.id)));
```

4. `targetsFor` (`:122`): `if (k && k.budgetUSD != null) {` → `if (limitedKey(k)) {`.

5. Each call site keeps today's order without a guard and checks the targets with one:

| Site | Today | Becomes |
|---|---|---|
| `llm` `:142` and the loop `:144` | `checkBudget(keyId);` … `for (const target of targetsFor(model, k)) {` | `if (!budgetGuard) checkBudget(keyId);` … `for (const target of allowedTargets(targetsFor(model, k), { keyId, agent, runId })) {` |
| `embed` `:219-220` | `if (k) checkBudget(k.id);` … `for (const target of targetsFor(model, k \|\| null)) {` | `if (k && !budgetGuard) checkBudget(k.id);` … `for (const target of allowedTargets(targetsFor(model, k \|\| null), { keyId, modelOf: () => model })) {` |
| `proxyChat` `:603-604` | `const targets = targetsFor(model, key);` `checkBudget(key.id);` | `const targets = allowedTargets(targetsFor(model, key), { keyId: key.id });` `if (!budgetGuard) checkBudget(key.id);` |
| `anthropicPassthrough` `:1008-1013` | `targetsFor(model, key);` inside the `try`, then `checkBudget(key.id);` | inside the same `try`: `targetsFor(model, key);` then `allowedTargets([t], { keyId: key.id, modelOf: () => model });`; after it `if (!budgetGuard) checkBudget(key.id);` |
| `responsesPassthrough` `:1125-1126` | `const targets = targetsFor(model, key);` `checkBudget(key.id);` | `const targets = allowedTargets(targetsFor(model, key), { keyId: key.id });` `if (!budgetGuard) checkBudget(key.id);` |
| `embeddings` `:1246-1247` | `const target = targetsFor(body.model, key)[0];` `checkBudget(key.id);` | `const target = allowedTargets(targetsFor(body.model, key), { keyId: key.id, modelOf: () => body.model })[0];` `if (!budgetGuard) checkBudget(key.id);` |

`llm` already destructures `agent` and `runId`, so collaboration runs (`runId`, source `collab`), replay and judge calls are checked as the ledger counts them. Leave `checkBudget`, `usage.monthSpend` and the admin `spend` map as they are: they are today's behaviour without a guard, and the key table's spend column.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/cost-guard.test.js test/gateway.test.js test/gateway-compat.test.js test/gateway-extra.test.js test/security.test.js`
Expected: PASS. The existing gateway tests build the gateway without `budgetGuard` and keep the old 402.

- [ ] **Step 6: Commit**

```bash
git add lib/cost/guard.js lib/gateway/index.js test/cost-guard.test.js
git commit -m "Budget guard: block gateway requests at once, per route target, fail open"
```

---
### Task 4: The `budget` rule in the Monitors state, channels and alerts API (shared: `lib/monitors/*`)

**Files:**
- Modify: `lib/monitors/rules.js` (shared): after `RULES` (`:99`) and `module.exports` (`:242`)
- Modify: `lib/monitors/state.js` (shared): the require (`:15`), `ruleOf` (`:33`), `cleanEntry` (`:67-88`), the prune in `apply` (`:349-355`), `markActed` (`:441-454`), new `applyBudgets` and `pendingBudgets`, the returned object (`:575`)
- Modify: `lib/monitors/channels.js` (shared): the require (`:10`), `wordOf` (`:168-178`), `textOf` (`:180-196`), `payloadOf` (`:274-284`)
- Modify: `lib/monitors/api.js` (shared): the require (`:7`), the options (`:47-71`), `list` (`:200-204`), `setRule` (`:223-225`), `alerts` (`:368-384`), `status` (`:389-417`)
- Test: `test/budgets-monitors.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (the results are plain objects).
- Produces:
  - `lib/monitors/rules.js`: `BUDGET_RULE` (`{ id: 'budget', title: 'Budget', describe, kind: 'budget', params: {}, defaultOn: () => true, mayAutoPause: false }`), `ruleById(id) → rule | null` (RULES, then BUDGET_RULE), `isBudgetState(s) → boolean` (`ok`, `exceeded`, `no_data`, `warn_<1..99>`). `RULES` is unchanged (still the eight fixed rules).
  - `state.applyBudgets(results, { retire = true } = {}) → alert[]`; a result is `{ instance, state, projected, periodKey, period, value, threshold, title }`.
  - `state.pendingBudgets() → [{ instance, sessionId: null, value, threshold, title, since }]`: exceeded, with data, not acted on this period, not snoozed.
  - `state.markActed('budget', id)` works for an `exceeded` budget.
  - `createMonitorApi({ …, retired = [] })`: retired rule ids are left out of `/api/monitors`, its counts and `enabled`; a change to one answers 410.
  - `/api/alerts` rows of rule `budget` carry `ruleTitle: 'Budget'`, `title` (the budget name), `period` and `projected`.

- [ ] **Step 1: Write the failing test**

```js
// test/budgets-monitors.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createMonitorState } = require('../lib/monitors/state');
const { createChannels } = require('../lib/monitors/channels');
const { createMonitorApi } = require('../lib/monitors/api');
const { RULES, BUDGET_RULE, ruleById, isBudgetState } = require('../lib/monitors/rules');
const { fakeServer, secretsFor } = require('./helpers');

const T0 = 1_800_000_000_000;
const HOUR = 3600e3;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-budgets-monitors-'));
function store(dir = tmp()) {
  const clock = { t: T0 };
  const make = () =>
    createMonitorState({
      file: path.join(dir, 'monitors.json'),
      alertsFile: path.join(dir, 'alerts.jsonl'),
      now: () => clock.t,
      config: () => ({}),
    });
  return { s: make(), make, clock, dir };
}
const res = (over = {}) => ({
  instance: 'team',
  state: 'ok',
  projected: false,
  periodKey: 'month:2026-10-01',
  period: 'month',
  value: 10,
  threshold: null,
  title: 'Team',
  ...over,
});
const brief = (a) => [a.state, a.previous, a.projected];

test('the budget rule sits beside the eight fixed rules', () => {
  assert.equal(RULES.length, 8);
  assert.equal(RULES.some((r) => r.id === 'budget'), false);
  assert.equal(ruleById('budget'), BUDGET_RULE);
  assert.equal(ruleById('daily_cost').id, 'daily_cost');
  assert.equal(ruleById('nope'), null);
  for (const s of ['ok', 'exceeded', 'no_data', 'warn_50', 'warn_8']) assert.equal(isBudgetState(s), true, s);
  for (const s of ['triggered', 'warn_100', 'warn_0', 'warn_x', 'snoozed', '']) assert.equal(isBudgetState(s), false, s);
});

test('applyBudgets: an alert on each change of state, none on repeats or no_data', () => {
  const { s, clock } = store();
  assert.deepEqual(s.applyBudgets([res()]), [], 'first seen at ok: quiet');
  const a = s.applyBudgets([res({ state: 'warn_50', value: 55, threshold: 50 })]);
  assert.equal(a.length, 1);
  const { id, ts, ...rest } = a[0];
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(ts, T0);
  assert.deepEqual(rest, {
    rule: 'budget',
    instance: 'team',
    sessionId: null,
    state: 'warn_50',
    previous: 'ok',
    value: 55,
    threshold: 50,
    period: 'month',
    projected: false,
    title: 'Team',
  });
  clock.t += HOUR;
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', value: 60, threshold: 50 })]), [], 'no reminder');
  assert.deepEqual(s.applyBudgets([res({ state: 'exceeded', value: 104, threshold: 100 })]).map(brief), [
    ['exceeded', 'warn_50', false],
  ]);
  assert.deepEqual(s.applyBudgets([res({ state: 'no_data', value: null })]), []);
  assert.deepEqual(s.applyBudgets([res({ state: 'exceeded', value: 106 })]), [], 'back from no_data at the same state');
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_80', value: 90, threshold: 80 })]).map(brief), [
    ['warn_80', 'exceeded', false],
  ], 'the amount was raised');
  assert.equal(s.alerts({ limit: 10 }).filter((x) => x.rule === 'budget').length, 3);
  const fresh = store().s;
  assert.deepEqual(fresh.applyBudgets([res({ state: 'warn_80' })]).map(brief), [['warn_80', 'ok', false]], 'first seen above a level');
});

test('applyBudgets: the projection alerts when it starts to pass the amount, and never beside exceeded', () => {
  const { s } = store();
  s.applyBudgets([res({ state: 'warn_50' })]);
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', projected: true })]).map(brief), [['warn_50', 'warn_50', true]]);
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', projected: true })]), []);
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', projected: false })]), [], 'falling back is quiet');
  assert.equal(s.applyBudgets([res({ state: 'warn_50', projected: true })]).length, 1);
  assert.deepEqual(s.applyBudgets([res({ state: 'exceeded', projected: true })]).map(brief), [['exceeded', 'warn_50', false]]);
});

test('applyBudgets: a new period starts at ok without an alert, and may alert again from there', () => {
  const { s } = store();
  s.applyBudgets([res({ state: 'exceeded' })]);
  assert.deepEqual(s.applyBudgets([res({ periodKey: 'month:2026-11-01' })]), [], 'reset without an alert');
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', periodKey: 'month:2026-11-01' })]).map(brief), [
    ['warn_50', 'ok', false],
  ]);
  const b = store().s;
  b.applyBudgets([res({ state: 'exceeded' })]);
  assert.deepEqual(b.applyBudgets([res({ state: 'warn_80', periodKey: 'month:2026-11-01' })]).map(brief), [
    ['warn_80', 'ok', false],
  ], 'a new period that opens above a level alerts from ok');
});

test('applyBudgets: retire with the list, keep without it; snooze is quiet; the state survives a restart', () => {
  const { s, make, clock } = store();
  s.applyBudgets([res(), res({ instance: 'lab', title: 'Lab' })]);
  s.snooze('budget', 'lab', HOUR);
  s.applyBudgets([res()], { retire: false });
  assert.ok(s.states().some((e) => e.instance === 'lab'), 'kept while the list did not read in full');
  s.applyBudgets([res()]);
  assert.ok(!s.states().some((e) => e.instance === 'lab'), 'gone with its budget');
  assert.equal(s.applyBudgets([res(), res({ instance: 'lab', state: 'warn_50' })]).length, 1, 'its snooze went too');
  s.snooze('budget', 'team', HOUR);
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_80' }), res({ instance: 'lab', state: 'warn_50' })]), []);
  assert.equal(s.states().find((e) => e.instance === 'team').state, 'snoozed');
  clock.t += 2 * HOUR;
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_80' }), res({ instance: 'lab', state: 'warn_50' })]), [], 'tracked while snoozed');
  const again = make();
  assert.deepEqual(again.applyBudgets([res({ state: 'warn_80' }), res({ instance: 'lab', state: 'warn_50' })]), [], 'after a restart');
  clock.t += 2 * 86400e3;
  again.apply('unsafe_content', [{ instance: 'all', sessionId: null, state: 'ok', value: 0, threshold: 1 }]);
  assert.ok(again.states().some((e) => e.rule === 'budget'), 'the day-old prune leaves budgets alone');
});

test('pendingBudgets and markActed: once per period, never on no data', () => {
  const { s, make } = store();
  s.applyBudgets([res({ state: 'warn_50' })]);
  assert.deepEqual(s.pendingBudgets(), []);
  assert.equal(s.markActed('budget', 'team'), false, 'only an exceeded budget');
  s.applyBudgets([res({ state: 'exceeded', value: 120, threshold: 100 })]);
  assert.deepEqual(s.pendingBudgets().map((p) => [p.instance, p.sessionId, p.value, p.title]), [['team', null, 120, 'Team']]);
  assert.equal(s.markActed('budget', 'team'), true);
  assert.equal(s.markActed('budget', 'team'), false, 'once');
  assert.deepEqual(make().pendingBudgets(), [], 'the mark is saved');
  s.applyBudgets([res({ state: 'exceeded', value: 130 })]);
  assert.deepEqual(s.pendingBudgets(), [], 'still this period');
  s.applyBudgets([res({ state: 'exceeded', periodKey: 'month:2026-11-01' })]);
  assert.deepEqual(s.pendingBudgets().map((p) => p.instance), ['team'], 'a new period may pause again');
  s.applyBudgets([res({ state: 'no_data', periodKey: 'month:2026-11-01' })]);
  assert.deepEqual(s.pendingBudgets(), [], 'never on no data');
});

test('a saved budget entry with a bad state is dropped on load', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'monitors.json'),
    JSON.stringify({ version: 1, states: [{ rule: 'budget', instance: 'x', state: 'warn_x' }, { rule: 'budget', instance: 'y', state: 'warn_80', period: 'month:2026-10-01' }] }),
  );
  const { s } = store(dir);
  assert.deepEqual(s.states().map((e) => [e.instance, e.state]), [['y', 'warn_80']]);
});

// ---- channels ----
function recorder() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    calls.push({ cmd, args, opts });
    child.stdin = Object.assign(new EventEmitter(), { end() {} });
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  return { calls, spawn };
}
const budgetAlert = (over = {}) => ({
  id: 'b1',
  ts: 1_700_000_000_000,
  rule: 'budget',
  instance: 'team',
  sessionId: null,
  state: 'warn_80',
  previous: 'warn_50',
  value: 82.4,
  threshold: 80,
  title: 'Team',
  period: 'month',
  projected: false,
  ...over,
});

test('channels: a budget alert on the desktop names the level, the share and the period; the name is the second line', async () => {
  const text = async (a) => {
    const r = recorder();
    const ch = createChannels({ spawn: r.spawn, secrets: secretsFor(), settings: () => ({ desktop: true, webhook: null }), platform: 'darwin' });
    await ch.notify(a, { title: a.title });
    return r.calls[0] && [r.calls[0].args[6], r.calls[0].args[7]];
  };
  assert.deepEqual(await text(budgetAlert()), ['ZAAFPulse: Budget', 'Passed 80 %: 82 % of the budget this month\nTeam']);
  assert.equal((await text(budgetAlert({ state: 'exceeded', value: 104 })))[1], 'Budget used up: 104 % of the budget this month\nTeam');
  assert.equal((await text(budgetAlert({ state: 'ok', previous: 'exceeded', value: 40, period: 'week' })))[1], 'Back under its levels: 40 % of the budget this week\nTeam');
  assert.equal((await text(budgetAlert({ state: 'warn_50', previous: 'exceeded', value: 60, period: 'day' })))[1], 'Back to 50 %: 60 % of the budget today\nTeam');
  assert.equal((await text(budgetAlert({ state: 'warn_50', previous: 'warn_50', projected: true, value: 60 })))[1], 'Projected to pass the budget: 60 % of the budget this month\nTeam');
});

test('channels: the webhook gets the seven fields with the budget state, and never the budget name', async () => {
  const srv = await fakeServer({ 'POST /hook': { status: 200 } });
  try {
    const ch = createChannels({
      spawn: recorder().spawn,
      secrets: secretsFor({ HOOK_URL: `${srv.url}/hook` }),
      settings: () => ({ desktop: false, webhook: { url: { env: 'HOOK_URL' } } }),
    });
    await ch.notify(budgetAlert({ title: 'Secret project budget' }), { title: 'Secret project budget' });
    assert.deepEqual(srv.requests[0].body, {
      rule: 'budget',
      state: 'warn_80',
      previous: 'warn_50',
      value: 82.4,
      threshold: 80,
      sessionId: null,
      ts: 1_700_000_000_000,
    });
    assert.ok(!JSON.stringify(srv.requests[0].body).includes('Secret'));
  } finally {
    await srv.close();
  }
});

// ---- the alerts API ----
function api({ retired = [] } = {}) {
  const dir = tmp();
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => T0,
    config: () => ({ monthlyBudgetUSD: 300 }),
  });
  const a = createMonitorApi({
    state,
    monitors: { status: async () => ({ lastAggregate: 1, lastLive: 2, paused: [] }) },
    channels: { test: async () => ({ ok: true }) },
    control: { paused: async () => [] },
    trace: {
      keyFor: () => null,
      sourceOf: () => {
        throw Object.assign(new Error('unknown session'), { status: 404 });
      },
    },
    channelSettings: { get: () => ({ desktop: true, webhook: null }), save: () => {} },
    resolveSecret: () => undefined,
    inDocker: false,
    home: '/Users/owner',
    retired,
    now: () => T0,
  });
  const call = async (p, { method = 'GET', body } = {}) => {
    const u = new URL(p, 'http://x');
    return a.route({
      method,
      path: u.pathname,
      query: u.searchParams,
      contentType: 'application/json',
      readBody: async () => JSON.stringify(body ?? {}),
    });
  };
  return { state, call };
}

test('alerts API: a budget row has its title, the budget name, the period and the projection; the instance is opaque', async () => {
  const { state, call } = api();
  state.applyBudgets([res()]);
  state.applyBudgets([res({ state: 'warn_80', value: 84.2, threshold: 80, projected: true })]);
  const [row] = (await call('/api/alerts')).body.alerts;
  assert.deepEqual(
    { ...row, id: null, instance: null },
    {
      id: null,
      ts: T0,
      rule: 'budget',
      ruleTitle: 'Budget',
      instance: null,
      sessionKey: null,
      title: 'Team',
      value: 84.2,
      threshold: 80,
      period: 'month',
      projected: true,
      state: 'warn_80',
      previous: 'ok',
    },
  );
  assert.match(row.instance, /^[0-9a-f]{20}$/);
  const st = (await call('/api/monitors/status')).body;
  assert.deepEqual(st.counts, { ok: 0, triggered: 0, no_data: 0, snoozed: 0 }, 'budgets are not monitor rules in the counts');
});

test('alerts API: retired rules are left out, and a change to one is refused', async () => {
  const { call } = api({ retired: ['daily_cost', 'month_projection'] });
  const ids = (await call('/api/monitors')).body.rules.map((r) => r.id);
  assert.deepEqual(ids, ['cost_burn', 'tool_loop', 'agent_stuck', 'accuracy_drop', 'eval_pass_rate', 'unsafe_content']);
  const r = await call('/api/monitors/daily_cost', { method: 'POST', body: { enabled: true } });
  assert.equal(r.status, 410);
  assert.match(r.body.error, /replaced by budgets/);
  assert.equal((await api().call('/api/monitors')).body.rules.length, 8, 'without the option nothing changes');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/budgets-monitors.test.js`
Expected: FAIL (`BUDGET_RULE` is undefined; `s.applyBudgets is not a function`).

- [ ] **Step 3: `lib/monitors/rules.js`** — after `RULES` (`:99`):

```js
// Cost budgets (lib/cost/budgets.js) are instances of this rule, one per budget id, evaluated after each ledger pass
// by tickBudgets() in the engine. It is not in RULES: it has no fixed card, no parameters and no check of its own.
const BUDGET_RULE = {
  id: 'budget',
  title: 'Budget',
  describe: 'A cost budget reached one of its levels, or is projected to pass its amount.',
  kind: 'budget',
  params: {},
  defaultOn: () => true,
  mayAutoPause: false, // a budget pauses through its own `enforce: 'pause'`
};
const BUDGET_STATE = /^(?:ok|exceeded|no_data|warn_[1-9]\d?)$/;
const isBudgetState = (s) => typeof s === 'string' && BUDGET_STATE.test(s);
const ruleById = (id) => RULES.find((r) => r.id === id) || (id === BUDGET_RULE.id ? BUDGET_RULE : null);
```

and `module.exports = { RULES, BUDGET_RULE, ruleById, isBudgetState, evaluate };`.

- [ ] **Step 4: `lib/monitors/state.js`**

1. `:15`: `const { ruleById, isBudgetState } = require('./rules');` and `:33`: `const ruleOf = (id) => ruleById(id);` (`RULES` is no longer read here).
2. Add after `STATES` (`:24`):

```js
const PERIOD_NAMES = new Set(['day', 'week', 'month']);
// A budget's states are its threshold levels (rules.js isBudgetState); every other rule keeps ok/triggered/no_data.
const stateOk = (rule, s) => s === null || s === undefined || (rule === 'budget' ? isBudgetState(s) : STATES.has(s));
```

3. `cleanEntry` (`:67-88`): replace the state check with `if (!stateOk(e.rule, e.state)) return null;`, build the object into `const out = { … }` (the same fields as today), then:

```js
  // A budget also keeps its period key (a new period resets it), whether the projection was passing, and whether its
  // last evaluation had no data.
  if (e.rule === 'budget')
    Object.assign(out, {
      period: typeof e.period === 'string' ? e.period.slice(0, 40) : null,
      projected: e.projected === true,
      noData: e.noData === true,
    });
  return out;
```

4. The prune in `apply` (`:350`): `if (t - e.lastSeen > PRUNE_MS) {` → `if (e.rule !== 'budget' && t - e.lastSeen > PRUNE_MS) {` with the comment `// A budget leaves with its budget (applyBudgets), never by age.`

5. `markActed` (`:446`):

```js
    const due = !!e && (e.rule === 'budget' ? e.state === 'exceeded' && !e.noData : e.state === 'triggered' && e.open);
    if (!isNum(t) || !due || e.actedAt) return false;
```

6. After `pending` (`:437`):

```js
  // Budgets (rule `budget`, one instance per budget id) have no reminder and no resolution hold. An alert goes out
  // when the threshold state changes (ok, warn_<n>, exceeded; either way) or when the projection starts to pass the
  // amount. A new period starts at ok without an alert and ends the pause mark, so a budget pauses at most once per
  // period. no_data keeps the last known state and alerts neither way: a file that fails to read for a minute is not
  // news. With `retire` (the saved list read in full) a budget no longer listed loses its state and its snooze.
  function applyBudgets(results, { retire = true } = {}) {
    load();
    const t = now();
    if (!isNum(t) || !Array.isArray(results)) return [];
    const out = [];
    const seen = new Set();
    let dirty = false;
    for (const r of results) {
      if (!isObj(r) || typeof r.instance !== 'string' || !r.instance || !isBudgetState(r.state)) continue;
      if (typeof r.periodKey !== 'string' || !r.periodKey) continue;
      seen.add(r.instance);
      const key = keyOf('budget', r.instance);
      let e = entries.get(key);
      if (!e) {
        e = cleanEntry({ rule: 'budget', instance: r.instance, state: null });
        entries.set(key, e);
        dirty = true;
      }
      e.value = orNull(r.value);
      e.threshold = orNull(r.threshold);
      e.title = typeof r.title === 'string' && r.title ? r.title.slice(0, MAX_TITLE) : null;
      e.lastSeen = t;
      // Snoozed: tracked quietly, as for every rule. The flag follows the snooze, so an ended one never blocks a pause.
      const snoozed = snoozeEnd('budget', r.instance, t) > 0;
      if (e.snoozed !== snoozed) {
        e.snoozed = snoozed;
        dirty = true;
      }
      if (e.period !== r.periodKey) {
        e.period = r.periodKey;
        e.state = 'ok';
        e.projected = false;
        e.actedAt = 0;
        e.since = t;
        dirty = true;
      }
      if (r.state === 'no_data') {
        if (!e.noData) dirty = true;
        e.noData = true;
        continue;
      }
      if (e.noData) dirty = true;
      e.noData = false;
      const prev = e.state || 'ok';
      const projected = r.projected === true && r.state !== 'exceeded';
      const changed = prev !== r.state;
      const newlyProjected = projected && !e.projected;
      if (changed) {
        e.state = r.state;
        e.since = t;
        dirty = true;
      }
      if (e.projected !== projected) {
        e.projected = projected;
        dirty = true;
      }
      if (!(changed || newlyProjected)) continue;
      if (snoozed) continue;
      e.lastAlertTs = t;
      const alert = {
        id: newId(),
        ts: t,
        rule: 'budget',
        instance: r.instance,
        sessionId: null,
        state: r.state,
        previous: prev,
        value: e.value,
        threshold: e.threshold,
        period: PERIOD_NAMES.has(r.period) ? r.period : null,
        projected,
      };
      if (e.title) alert.title = e.title;
      out.push(alert);
    }
    if (retire)
      for (const [k, e] of entries)
        if (e.rule === 'budget' && !seen.has(e.instance)) {
          entries.delete(k);
          delete snoozes.instances[k];
          dirty = true;
        }
    dropExpiredSnoozes(t);
    // Alerts first, state second, as in apply().
    if (out.length) record(out);
    if (dirty) {
      try {
        save();
      } catch (err) {
        warn(`save ${file}`, err);
      }
    }
    return out;
  }

  // Exceeded budgets with data, not acted on this period and not snoozed: what the engine may pause for.
  function pendingBudgets() {
    load();
    const t = now();
    if (!isNum(t)) return [];
    const out = [];
    for (const e of entries.values()) {
      if (e.rule !== 'budget' || e.state !== 'exceeded' || e.noData || e.actedAt || e.snoozed) continue;
      if (snoozeEnd('budget', e.instance, t) > 0) continue;
      out.push({ instance: e.instance, sessionId: null, value: e.value, threshold: e.threshold, title: e.title, since: e.since });
    }
    return out;
  }
```

7. The returned object (`:575`): add `applyBudgets, pendingBudgets` after `pending`.

`apply()` resets (`fresh()`) only the entries of the rule it was called for, and its prune now skips budgets, so the other rules never change a budget entry.

- [ ] **Step 5: `lib/monitors/channels.js`**

1. `:10`: `const { ruleById, isBudgetState } = require('./rules');`.
2. After `PAUSE_WHY` (`:32`):

```js
// The words for a budget alert (rule `budget`): the level it reached or fell back to, or its projection.
const PERIOD_WORD = { day: 'today', week: 'this week', month: 'this month' };
const rankOf = (s) => (s === 'exceeded' ? 100 : typeof s === 'string' && s.startsWith('warn_') ? Number(s.slice(5)) : 0);
function budgetWord(a) {
  const now = rankOf(a.state);
  const was = rankOf(a.previous);
  if (now > was) return a.state === 'exceeded' ? 'Budget used up' : `Passed ${now} %`;
  if (now < was) return a.state === 'ok' ? 'Back under its levels' : `Back to ${now} %`;
  return a.projected === true ? 'Projected to pass the budget' : null;
}
```

3. `wordOf` (`:168`): before `if (alert.action !== undefined) return null;` add `if (alert.rule === 'budget' && alert.action === undefined) return budgetWord(alert);`.
4. `textOf` (`:180-196`): `const rule = ruleById(alert.rule);`, and replace the two lines that add the value and the threshold with:

```js
    if (alert.rule === 'budget' && alert.action === undefined) {
      if (isNum(alert.value))
        line += `: ${Math.round(alert.value)} % of the budget ${PERIOD_WORD[alert.period] || 'this period'}`;
    } else {
      if (isNum(alert.value)) line += `: ${fmt(alert.value)}`;
      if (isNum(alert.threshold))
        line += isNum(alert.value) ? ` (limit ${fmt(alert.threshold)})` : ` (limit: ${fmt(alert.threshold)})`;
    }
```

5. `payloadOf` (`:274-284`): `rule: ruleById(a.rule) ? a.rule : null,`, `state: STATES.has(a.state) || isBudgetState(a.state) ? a.state : null,`, `previous: STATES.has(a.previous) || isBudgetState(a.previous) ? a.previous : null,`. The body keeps its seven fields; the budget's name (the alert's `title`) is not one of them.

- [ ] **Step 6: `lib/monitors/api.js`**

1. `:7`: `const { RULES, ruleById } = require('./rules');`.
2. Options (`:47-71`): add `retired = [],` (comment: `// rule ids replaced by budgets (server.js): not listed, not counted, not changed`), and at the top of the body `const RETIRED = new Set(retired);` and `const active = () => RULES.filter((r) => !RETIRED.has(r.id));`.
3. `list()` (`:203`): `rules: active().map((r) => ruleRow(r, all, keyOf))`.
4. `setRule` (`:224`), first line: `if (RETIRED.has(id)) throw fail(410, \`${id} is replaced by budgets (docs/cost.md#budgets)\`);`.
5. `alerts` (`:369`): `const rule = ruleById(a.rule);`, and before the `if (a.action !== undefined)` line:

```js
      if (a.rule === 'budget') {
        row.period = ['day', 'week', 'month'].includes(a.period) ? a.period : null;
        row.projected = a.projected === true;
      }
```

6. `status` (`:397-399, :403`): skip `s.rule === 'budget' || RETIRED.has(s.rule)` in the counts loop, and `enabled: active().some((r) => state.settings(r.id).enabled)`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/budgets-monitors.test.js test/monitors-state.test.js test/monitors-channels.test.js test/monitors-api.test.js test/monitors-rules.test.js test/monitors-engine.test.js`
Expected: PASS. No existing assertion changes in this task.

- [ ] **Step 8: Commit**

```bash
git add lib/monitors/rules.js lib/monitors/state.js lib/monitors/channels.js lib/monitors/api.js test/budgets-monitors.test.js
git commit -m "Monitors: the budget rule, change-only budget states, budget alert words and fields"
```

---
### Task 5: Budget ticks and the budget pause in the engine (shared: `lib/monitors/index.js`)

**Files:**
- Modify: `lib/monitors/index.js` (shared): requires (`:12-16`), options (`:41-55`), locals (`:72-83`), the costly list (`:138-141`), `run` (`:255-271`), `targetOf` (`:310-320`), `actOn` (`:357-363`), `liveNeeded` (`:442-449`), `status` (`:454-481`), the returned object (`:507`)
- Test: `test/budgets-engine.test.js`

**Interfaces:**
- Consumes:
  - Task 4: `state.applyBudgets(results, { retire })`, `state.pendingBudgets()`, `state.markActed('budget', id)`, `state.note({ rule: 'budget', … })`;
  - Task 2: the service's `evaluate()`, `complete()`, `centerOfProject(project)` (passed in as `budgets`);
  - `projectOf(path, home)` (`lib/cost/collect.js`, Task 2), `normalizeModel` (`lib/pricing.js`).
- Produces: `createMonitors({ …, budgets = null, retired = [], home = '' })` returning `{ tickAggregate, tickLive, tickBudgets, status, snapshot }`. `tickBudgets()` never rejects.

- [ ] **Step 1: Write the failing test**

```js
// test/budgets-engine.test.js
// The engine's budget pass with the real state store in a temp folder and spies for the channels and the agent
// control. Nothing here signals a process or shows a notification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMonitors } = require('../lib/monitors');
const { createMonitorState } = require('../lib/monitors/state');

const MIN = 60e3;
const T0 = new Date(2026, 9, 22, 12, 0, 0).getTime();
const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const ONE = { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }; // one input token is one dollar
const PRICING = { 'test-model': ONE, 'other-model': ONE };
let reqId = 0;
const usage = (ts, sid, usd, tool, model) => [ts, tool, sid, model, usd, 0, 0, 0, 0, false, `r${++reqId}`, null];
const session = (cwd, tool = 'claude') => ({
  tool,
  project: cwd,
  first: T0 - 60 * MIN,
  last: T0 - 5 * MIN,
  prompts: 1,
  promptTs: [T0 - 60 * MIN],
  tools: {},
  skills: {},
  agents: {},
  subagentFiles: 0,
});
// Today: s1 in ~/acme-web cost 9, s2 in ~/lab cost 5 on another model, the Codex session s3 in ~/acme-api cost 3.
const RESULTS = [
  {
    events: [
      usage(T0 - 30 * MIN, 's1', 9, 'claude', 'test-model'),
      usage(T0 - 20 * MIN, 's2', 5, 'claude', 'other-model'),
      usage(T0 - 10 * MIN, 's3', 3, 'codex', 'test-model'),
    ],
    sessions: {
      s1: session(path.join(HOME, 'acme-web')),
      s2: session(path.join(HOME, 'lab')),
      s3: session(path.join(HOME, 'acme-api'), 'codex'),
    },
  },
];
const AGENTS = ['claude:s1', 'claude:s2', 'codex:s3'].map((id) => ({ id, kind: 'session', state: 'working', project: 'p', lastTs: T0 - 1000 }));
const view = (over = {}) => ({
  id: 'team',
  name: 'Team',
  scope: 'global',
  period: 'month',
  periodKey: 'month:2026-10-01',
  enforce: 'none',
  state: 'ok',
  projected: false,
  percent: 10,
  ...over,
});

function setup({ views = [], demo = false, retired = [], conf = {}, pauseThrows = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-budgets-engine-'));
  const clock = { t: T0 };
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => clock.t,
    config: () => ({ pricing: PRICING, ...conf }),
  });
  const data = { views, complete: true };
  const sent = [];
  const calls = { candidates: [], pause: [], resume: [], stop: [] };
  const control = {
    async candidates(a) {
      calls.candidates.push(a);
      return [{ pid: 4242, startTime: T0 - 90 * MIN }];
    },
    async pause(target, meta) {
      calls.pause.push({ target, meta });
      if (pauseThrows) throw Object.assign(new Error('the process is gone'), { status: 409 });
      return { ok: true };
    },
    async resume(target, meta) {
      calls.resume.push({ target, meta });
    },
    async stop(target, meta) {
      calls.stop.push({ target, meta });
    },
    async paused() {
      return [];
    },
  };
  const monitors = createMonitors({
    indexer: { results: () => RESULTS },
    office: { snapshot: () => ({ ts: clock.t, agents: AGENTS }), demoSnapshot: () => ({ ts: clock.t, agents: AGENTS }) },
    evals: { summary: () => ({ evaluators: {} }) },
    config: () => ({ pricing: PRICING, ...conf }),
    state,
    channels: {
      notify: async (alert, o) => {
        sent.push({ alert, title: o && o.title });
        return { desktop: true, webhook: false };
      },
    },
    control,
    now: () => clock.t,
    log: () => {},
    demo,
    platform: 'darwin',
    budgets: {
      evaluate: () => data.views.map((v) => ({ ...v })),
      complete: () => data.complete,
      centerOfProject: (p) => (p.startsWith('~/acme') ? 'acme' : 'unassigned'),
    },
    retired,
    home: HOME,
  });
  // The order of the server: the index refresh (aggregate), then the ledger pass (budgets), and the live pass.
  const cycle = async () => {
    await monitors.tickAggregate();
    await monitors.tickBudgets();
    await monitors.tickLive();
  };
  return { monitors, state, data, sent, calls, clock, cycle };
}
const budgetSent = (sent) => sent.filter((s) => s.alert.rule === 'budget' && s.alert.action === undefined);
const pauseNotes = (state) => state.alerts({ limit: 100 }).filter((a) => a.rule === 'budget' && a.action === 'pause');

test('engine: budget states alert on a change only, with the name as the title', async () => {
  const e = setup({ views: [view()] });
  await e.cycle();
  assert.equal(budgetSent(e.sent).length, 0);
  e.data.views = [view({ state: 'warn_50', percent: 55 })];
  await e.monitors.tickBudgets();
  const s = budgetSent(e.sent);
  assert.equal(s.length, 1);
  assert.deepEqual(
    [s[0].alert.state, s[0].alert.previous, s[0].alert.value, s[0].alert.threshold, s[0].alert.period, s[0].title],
    ['warn_50', 'ok', 55, 50, 'month', 'Team'],
  );
  await e.monitors.tickBudgets();
  assert.equal(budgetSent(e.sent).length, 1, 'no repeat');
  e.data.views = [];
  e.data.complete = false;
  await e.monitors.tickBudgets();
  assert.equal(e.state.states().filter((x) => x.rule === 'budget').length, 1, 'not retired while the list did not read');
  e.data.complete = true;
  await e.monitors.tickBudgets();
  assert.equal(e.state.states().filter((x) => x.rule === 'budget').length, 0, 'retired with its budget');
});

test('engine: demo mode evaluates budgets but never notifies or pauses', async () => {
  const e = setup({ demo: true, views: [view({ state: 'exceeded', percent: 120, enforce: 'pause' })] });
  await e.cycle();
  await e.monitors.tickBudgets();
  assert.equal(e.sent.length, 0);
  assert.equal(e.calls.pause.length, 0);
  assert.equal(e.calls.candidates.length, 0);
});

test('engine: an exceeded pause budget pauses the costliest running session in scope, once per period', async () => {
  const e = setup({ views: [view({ state: 'exceeded', percent: 120, enforce: 'pause' })] });
  await e.cycle();
  assert.equal(e.calls.pause.length, 1);
  assert.deepEqual(e.calls.pause[0].meta, { by: 'rule', rule: 'budget', sessionId: 's1' });
  assert.deepEqual(e.calls.pause[0].target, { pid: 4242, startTime: T0 - 90 * MIN });
  assert.equal(e.calls.candidates[0].source, 'claude');
  assert.deepEqual(pauseNotes(e.state).map((n) => [n.ok, n.code]), [[true, 'paused']]);
  await e.cycle();
  await e.cycle();
  assert.equal(e.calls.pause.length, 1, 'once per period');
  assert.equal(e.calls.resume.length, 0, 'never resumed');
  e.data.views = [view({ state: 'exceeded', percent: 130, enforce: 'pause', periodKey: 'month:2026-11-01' })];
  await e.cycle();
  assert.equal(e.calls.pause.length, 2, 'a new period may pause again');
});

test('engine: the scope picks the session; a scope with no session in it reports once and pauses nothing', async () => {
  const pausedFor = async (scope) => {
    const e = setup({ views: [view({ state: 'exceeded', enforce: 'pause', scope })] });
    await e.cycle();
    return e.calls.pause.map((p) => p.meta.sessionId);
  };
  assert.deepEqual(await pausedFor({ dim: 'source', value: 'codex' }), ['s3']);
  assert.deepEqual(await pausedFor({ dim: 'project', value: '~/lab' }), ['s2']);
  assert.deepEqual(await pausedFor({ dim: 'center', value: 'acme' }), ['s1'], 'through the folder rules');
  assert.deepEqual(await pausedFor({ dim: 'model', value: 'other-model' }), ['s2']);
  assert.deepEqual(await pausedFor({ dim: 'key', value: 'key_a' }), [], 'a key has no local session');
  const e = setup({ views: [view({ state: 'exceeded', enforce: 'pause', scope: { dim: 'project', value: '~/nowhere' } })] });
  await e.cycle();
  await e.cycle();
  assert.equal(e.calls.pause.length, 0);
  assert.deepEqual(pauseNotes(e.state).map((n) => [n.ok, n.code]), [[false, 'none']], 'reported once');
});

test('engine: notify-only and warning budgets never pause; a refused pause is reported', async () => {
  const quiet = setup({ views: [view({ state: 'exceeded', enforce: 'none' }), view({ id: 'b', state: 'warn_80', enforce: 'pause' })] });
  await quiet.cycle();
  assert.equal(quiet.calls.pause.length, 0);
  const refused = setup({ pauseThrows: true, views: [view({ state: 'exceeded', enforce: 'pause' })] });
  await refused.cycle();
  assert.deepEqual(pauseNotes(refused.state).map((n) => [n.ok, n.code]), [[false, 'refused']]);
});

test('engine: retired rules are not evaluated', async () => {
  const conf = { monthlyBudgetUSD: 300 }; // daily_cost is on by default, with a limit of 10 a day; today cost 17
  const on = setup({ conf });
  await on.monitors.tickAggregate();
  assert.equal(on.sent.filter((s) => s.alert.rule === 'daily_cost').length, 1);
  const off = setup({ conf, retired: ['daily_cost', 'month_projection'] });
  await off.monitors.tickAggregate();
  assert.equal(off.sent.filter((s) => s.alert.rule === 'daily_cost' || s.alert.rule === 'month_projection').length, 0);
  assert.equal((await off.monitors.status()).counts.triggered, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/budgets-engine.test.js`
Expected: FAIL with `e.monitors.tickBudgets is not a function`.

- [ ] **Step 3: Edit `lib/monitors/index.js`**

1. Requires (`:16`): `const { makePricer, eventParts, DEFAULT_PRICING, normalizeModel } = require('../pricing');` and add `const { projectOf } = require('../cost/collect');`.

2. Options (`:41-55`), after `platform = process.platform,`:

```js
  // Cost budgets (lib/cost/budget-service.js): { evaluate(), complete(), centerOfProject(project) }, or null.
  budgets = null,
  // Rule ids replaced by budgets (server.js passes daily_cost and month_projection): never evaluated or acted on.
  retired = [],
  // The home folder, to write a session's folder as the ledger does (~/…) for project and center budgets.
  home = '',
```

and right after `const cfg = …` (`:69`): `const RETIRED = new Set(retired);`.

3. Locals (`:83`), after `const busy = new Set();`:

```js
  let budgetViews = []; // the budgets as last evaluated: their scope and enforce, for the pause
  let budgetRunning = null;
```

4. The costly list (`:138-141`): keep the order and the filter, give each entry what a budget scope needs:

```js
        .map((s) => ({
          key: `${s.tool}:${s.id}`,
          sid: s.id,
          tool: s.tool,
          project: typeof s.projectPath === 'string' ? s.projectPath : null,
          models: Array.isArray(s.models) ? s.models.map((m) => normalizeModel(m)) : [],
        }));
```

5. `run` (`:258`): `if (rule.kind !== kind || RETIRED.has(rule.id)) continue;`, and after `await autoPauseDue();` add `await autoPauseBudgets(); // a budget waiting for a live pass acts on it`.

6. `targetOf` (`:310`), first lines of the body:

```js
    if (ruleId === 'budget') {
      const b = budgetViews.find((v) => v.id === p.instance);
      if (!b) return null;
      for (const c of (agg && agg.costly) || []) {
        if (!inBudgetScope(b.scope, c)) continue;
        const s = sessions.find((x) => x.key === c.key);
        if (s) return s;
      }
      return null;
    }
```

and before `targetOf`:

```js
  // Whether a session of today's cost list is in a budget's scope. A project or a center needs the home folder, to
  // write the session's folder as the ledger does; without it those scopes match nothing (nothing is paused).
  function inBudgetScope(scope, c) {
    if (scope === 'global') return true;
    if (!scope || typeof scope !== 'object') return false;
    const project = home && c.project ? projectOf(c.project, home) : null;
    if (scope.dim === 'source') return c.tool === scope.value;
    if (scope.dim === 'project') return project !== null && project === scope.value;
    if (scope.dim === 'model') return Array.isArray(c.models) && c.models.includes(scope.value);
    if (scope.dim === 'center') {
      if (project === null || !budgets) return false;
      try {
        return budgets.centerOfProject(project) === scope.value;
      } catch {
        return false;
      }
    }
    return false; // key, provider: no local session behind them
  }
```

7. `actOn` (`:359-362`): the "no target" branch reports for budgets too:

```js
    if (!target) {
      // daily_cost and a budget pick the session themselves, so they say when none was running.
      if (ruleId === 'daily_cost')
        passing(null, 'none', 'could not pause: no candidate (no running session has a cost today)');
      else if (ruleId === 'budget')
        passing(null, 'none', "could not pause: no candidate (no running session in the budget's scope has a cost today)");
      return;
    }
```

8. `autoPauseDue` (`:327`): `for (const ruleId of AUTO_PAUSE) {` → first line inside: `if (RETIRED.has(ruleId)) continue;`. After `autoPauseDue`:

```js
  // An exceeded budget set to pause, not acted on this period: the costliest running local session in its scope.
  async function autoPauseBudgets() {
    if (demo || !control || !budgets) return;
    const pausing = new Set(budgetViews.filter((v) => v.enforce === 'pause' && v.state === 'exceeded').map((v) => v.id));
    let due = [];
    try {
      due = state.pendingBudgets().filter((p) => pausing.has(p.instance));
    } catch (err) {
      safeLog(`monitors: could not read the exceeded budgets: ${err && err.message}`);
      return;
    }
    const open = new Set(due.map((p) => keyOf('budget', p.instance)));
    for (const k of reported) if (k.startsWith('budget|') && !open.has(k)) reported.delete(k);
    for (const p of due) await actOn('budget', p);
  }

  // After each ledger pass (server.js): every budget's state goes to the state store, which returns the alerts of a
  // change; then the pause. A pass still running is joined. It never rejects.
  const levelOf = (st) => (st === 'exceeded' ? 100 : /^warn_\d{1,2}$/.test(st) ? Number(st.slice(5)) : null);
  function tickBudgets() {
    if (!budgets) return Promise.resolve();
    if (budgetRunning) return budgetRunning;
    const p = (async () => {
      await null;
      try {
        if (!isNum(now())) return;
        let views;
        try {
          views = budgets.evaluate();
        } catch (err) {
          safeLog(`monitors: the budgets could not be evaluated: ${err && err.message}`);
          return;
        }
        budgetViews = Array.isArray(views) ? views : [];
        let complete = false;
        try {
          complete = budgets.complete() === true;
        } catch {
          complete = false;
        }
        const results = budgetViews.map((v) => ({
          instance: v.id,
          state: v.state,
          projected: v.projected === true,
          periodKey: v.periodKey,
          period: v.period,
          value: isNum(v.percent) ? v.percent : null,
          threshold: levelOf(v.state),
          title: typeof v.name === 'string' ? v.name : null,
        }));
        let alerts = [];
        try {
          alerts = state.applyBudgets(results, { retire: complete }) || [];
        } catch (err) {
          safeLog(`monitors: the budget states could not be kept: ${err && err.message}`);
        }
        for (const a of alerts) send(a);
        await autoPauseBudgets();
      } catch (err) {
        safeLog(`monitors: the budget pass failed: ${err && err.message}`);
      } finally {
        budgetRunning = null;
      }
    })();
    budgetRunning = p;
    return p;
  }
```

9. `liveNeeded` (`:442-449`): skip retired rules (`if (!s.enabled || RETIRED.has(rule.id)) continue;`), and before `return false;`: `if (budgetViews.some((v) => v.enforce === 'pause')) return true; // a budget's pause looks for the running sessions`.

10. `status` (`:463-464`): `if (s.rule === 'budget' || RETIRED.has(s.rule)) continue;` first in the counts loop; `enabled: RULES.some((r) => !RETIRED.has(r.id) && settingsOf(r.id).enabled),`.

11. The returned object: `return { tickAggregate, tickLive, tickBudgets, status, snapshot };`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/budgets-engine.test.js test/monitors-engine.test.js test/agents-control.test.js`
Expected: PASS. The existing engine tests pass no `budgets` and no `retired`, so they see today's engine.

- [ ] **Step 5: Commit**

```bash
git add lib/monitors/index.js test/budgets-engine.test.js
git commit -m "Monitors engine: budget ticks, budget pause in scope once per period, retired rules"
```

---
### Task 6: The `/api/cost/budgets` routes

**Files:**
- Modify: `lib/cost/api.js`: requires (`:4-7`), options (`:26`), the settings save (`:94-100`), restate (`:101-117`), the route maps and `route` (`:76-146`)
- Test: `test/cost-budgets-api.test.js`

**Interfaces:**
- Consumes: Task 1's `validateBudget`, `LIMITS`; Task 2's service (`list`, `evaluate`, `status`).
- Produces: `createCostApi({ …, budgets = null, budgetStore = null, pauseOff = () => null, onChange = () => {} })`:
  - `budgetStore.save(list, { clearMonthly, clearKey })` writes `config.json` → `cost.budgets` (and `monthlyBudgetUSD: 0` in the same write when `clearMonthly`), then clears `clearKey`'s `budgetUSD` (server.js, Task 8);
  - `pauseOff() → reason | null`: why agent control is off here;
  - `onChange()` after every change the budgets read (a settings save, a restate, a budget save or delete).
  - Routes:
    - `GET /api/cost/budgets` → 200 `{ budgets: view[], error, reasons, guard: { error }, kept: { error } }`;
    - `POST /api/cost/budgets` (one budget) → 200 `{ budget: view }`, 400 `{ error: 'invalid budget', reasons }`, 409 while the saved list does not validate or while `enforce: 'pause'` and agent control is off;
    - `POST /api/cost/budgets/<id>/delete` → 200 `{ deleted: id }`, 404 for an id that is neither saved nor legacy.

- [ ] **Step 1: Write the failing test**

```js
// test/cost-budgets-api.test.js (in process; Task 8 adds the spawned server in test/budgets-http.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { createBudgetService } = require('../lib/cost/budget-service');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\/|~[\\/]/;
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-budgets-api-'));
const BASE = { centers: [{ id: 'acme', name: 'Acme' }], currency: { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 16000 }] } };
const ACME = { id: 'acme-key', name: 'Acme key', scope: { dim: 'key', value: 'key_a' }, period: 'month', amount: 0.004, enforce: 'block' };

function setup({ budgets = [ACME], monthly = 1, keys = [{ id: 'key_b', name: 'Lab', budgetUSD: 2 }], saveThrows = false } = {}) {
  const dir = tmp();
  const st = { saved: { ...BASE, budgets }, monthly, keys, t: at(22), saves: [], changes: 0, pauseOff: null };
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const cost = createCost({
    dir: path.join(dir, 'cost'),
    gatewayLog,
    getPricing: () => PRICE_A,
    getSettings: () => st.saved,
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const budgetsSvc = createBudgetService({
    getSettings: () => st.saved,
    getLegacy: () => ({ monthlyBudgetUSD: st.monthly, keys: st.keys }),
    cost,
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const api = createCostApi({
    cost,
    settings: { get: () => st.saved, save: (v) => (st.saved = v) },
    listKeys: () => st.keys,
    home: HOME,
    now: () => st.t,
    budgets: budgetsSvc,
    budgetStore: {
      save: (list, clears) => {
        if (saveThrows)
          throw Object.assign(new Error(`could not write ${HOME}\\zp\\config.json or C:\\zp\\config.json`), { status: 500 });
        st.saved = { ...st.saved, budgets: list };
        st.saves.push(clears);
        if (clears.clearMonthly) st.monthly = 0;
        if (clears.clearKey) st.keys = st.keys.map((k) => (k.id === clears.clearKey ? { ...k, budgetUSD: null } : k));
      },
    },
    pauseOff: () => st.pauseOff,
    onChange: () => {
      st.changes++;
      budgetsSvc.invalidate();
    },
  });
  const bodies = [];
  const call = async (method, p, { body, type = 'application/json' } = {}) => {
    const res = await api.route({
      method,
      path: p,
      query: new URLSearchParams(),
      contentType: type,
      readBody: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
    });
    if (res) bodies.push(JSON.stringify(res.body));
    return res;
  };
  const line = (ts) =>
    fs.appendFileSync(
      gatewayLog,
      JSON.stringify({ ts, keyId: 'key_a', provider: 'p', model: 'claude-sonnet-5-5', kind: 'chat', input: 1000, output: 100 }) + '\n',
    );
  return { st, cost, call, bodies, line };
}
const byId = (r) => Object.fromEntries(r.body.budgets.map((b) => [b.id, b]));

test('GET budgets: saved and legacy budgets with spent, percent, state, period bounds and legacy', async () => {
  const s = setup();
  s.line(at(22, 9));
  s.cost.update();
  const r = await s.call('GET', '/api/cost/budgets');
  assert.equal(r.status, 200);
  const b = byId(r);
  assert.deepEqual(Object.keys(b).sort(), ['acme-key', 'legacy-key-key_b', 'legacy-monthly']);
  const acme = b['acme-key'];
  for (const k of ['spent', 'spentUSD', 'amountUSD', 'percent', 'projected', 'state', 'from', 'to', 'periodKey', 'legacy'])
    assert.ok(k in acme, k);
  assert.deepEqual([acme.state, acme.percent, acme.from, acme.to, acme.legacy], ['warn_50', 75, '2026-10-01', '2026-10-31', null]);
  assert.equal(b['legacy-monthly'].legacy, 'monthlyBudgetUSD');
  assert.equal(b['legacy-key-key_b'].legacy, 'keyBudget');
  assert.equal(b['legacy-key-key_b'].enforce, 'block');
  assert.deepEqual([r.body.error, r.body.reasons, r.body.guard, r.body.kept], [null, [], { error: null }, { error: null }]);
});

test('POST budgets: creates and updates one budget; 400 with reasons; 409 for a pause while agent control is off', async () => {
  const s = setup();
  const team = { id: 'team', name: 'Team', scope: 'global', period: 'week', amount: 160000, currency: 'IDR' };
  const made = await s.call('POST', '/api/cost/budgets', { body: team });
  assert.equal(made.status, 200);
  assert.deepEqual([made.body.budget.id, made.body.budget.currency, made.body.budget.amountUSD], ['team', 'IDR', 10]);
  assert.deepEqual(s.st.saved.budgets.map((b) => b.id), ['acme-key', 'team']);
  assert.equal(s.st.changes, 1);
  const edited = await s.call('POST', '/api/cost/budgets', { body: { ...ACME, amount: 1 } });
  assert.equal(edited.status, 200);
  assert.deepEqual(s.st.saved.budgets.map((b) => [b.id, b.amount]), [['acme-key', 1], ['team', 160000]], 'in place');
  for (const [body, re] of [
    [{ ...team, scope: { dim: 'team', value: 'x' } }, /scope\.dim/],
    [{ ...team, scope: { dim: 'model', value: '' } }, /scope\.value/],
    [{ ...team, amount: 0 }, /amount/],
    [{ ...team, currency: 'EUR' }, /currency: USD or IDR/],
    [{ ...team, enforce: 'block', scope: { dim: 'project', value: '~/x' } }, /enforce: block/],
    [{ ...team, enforce: 'block', scope: { dim: 'source', value: 'codex' } }, /enforce: block/],
    [{ ...team, enforce: 'pause', scope: { dim: 'key', value: 'key_a' } }, /enforce: pause/],
    [{ ...team, enforce: 'pause', scope: { dim: 'provider', value: 'groq' } }, /enforce: pause/],
    [{ ...team, legacy: 'keyBudget' }, /legacy/],
  ]) {
    const r = await s.call('POST', '/api/cost/budgets', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, 'invalid budget');
    assert.match(r.body.reasons.join(' | '), re);
  }
  s.st.pauseOff = 'agent control is off on this server';
  const paused = await s.call('POST', '/api/cost/budgets', { body: { ...team, enforce: 'pause' } });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /agent control is off/);
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: { ...team, enforce: 'none' } })).status, 200);
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: team, type: 'text/plain' })).status, 415);
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: '[1]' })).status, 400);
});

test('editing a legacy budget saves it and clears the old setting; a delete clears it too', async () => {
  const s = setup();
  const monthly = { id: 'legacy-monthly', name: 'Team month', scope: 'global', period: 'month', amount: 60 };
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: monthly })).status, 200);
  assert.deepEqual(s.st.saves.at(-1), { clearMonthly: true, clearKey: null });
  assert.equal(s.st.monthly, 0);
  let b = byId(await s.call('GET', '/api/cost/budgets'));
  assert.deepEqual([b['legacy-monthly'].amount, b['legacy-monthly'].legacy], [60, null], 'listed once, as saved');
  const key = { id: 'legacy-key-key_b', name: 'Lab key', scope: { dim: 'key', value: 'key_b' }, period: 'month', amount: 3, enforce: 'block' };
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: key })).status, 200);
  assert.deepEqual(s.st.saves.at(-1), { clearMonthly: false, clearKey: 'key_b' });
  assert.equal(s.st.keys[0].budgetUSD, null);
  assert.deepEqual((await s.call('POST', '/api/cost/budgets/acme-key/delete', { body: {} })).body, { deleted: 'acme-key' });
  b = byId(await s.call('GET', '/api/cost/budgets'));
  assert.equal('acme-key' in b, false);
  const fresh = setup({ budgets: [] });
  assert.equal((await fresh.call('POST', '/api/cost/budgets/legacy-key-key_b/delete', { body: {} })).status, 200);
  assert.deepEqual(fresh.st.saves.at(-1), { clearMonthly: false, clearKey: 'key_b' }, 'a legacy delete clears its old setting');
  assert.equal((await fresh.call('POST', '/api/cost/budgets/nope/delete', { body: {} })).status, 404);
  assert.equal((await fresh.call('GET', '/api/cost/budgets/nope/delete')).status, 405);
  assert.equal((await fresh.call('POST', '/api/cost/budgets/legacy-monthly/delete', { body: {}, type: 'text/plain' })).status, 415);
});

test('a saved list that does not validate: listed with its reasons, changes refused until it is fixed', async () => {
  const s = setup();
  assert.equal((await s.call('GET', '/api/cost/budgets')).status, 200); // the list read once while it was valid
  s.st.saved = { ...BASE, budgets: [ACME, { id: 'x' }] };
  const r = await s.call('GET', '/api/cost/budgets');
  assert.equal(r.status, 200);
  assert.match(r.body.error, /the last valid list is in force/);
  assert.ok(r.body.reasons.some((x) => /budgets\[1\]/.test(x)));
  assert.ok('acme-key' in byId(r), 'the last valid list is still in force');
  const post = await s.call('POST', '/api/cost/budgets', { body: ACME });
  assert.equal(post.status, 409);
  assert.equal((await s.call('POST', '/api/cost/budgets/acme-key/delete', { body: {} })).status, 409);
  assert.deepEqual(s.st.saved.budgets.length, 2, 'the hand edit is left as it is');
});

test('the settings save keeps the budgets; errors are path-free', async () => {
  const s = setup();
  const r = await s.call('POST', '/api/cost/settings', { body: { centers: [{ id: 'acme', name: 'Acme Corp' }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(s.st.saved.budgets.map((b) => b.id), ['acme-key']);
  assert.equal(s.st.saved.centers[0].name, 'Acme Corp');
  assert.ok(s.st.changes >= 1);
  const broken = setup({ saveThrows: true });
  const fail = await broken.call('POST', '/api/cost/budgets', { body: { ...ACME, amount: 2 } });
  assert.equal(fail.status, 500);
  assert.match(fail.body.error, /\[path\]/);
  for (const b of [...s.bodies, ...broken.bodies]) assert.doesNotMatch(b, PATHS, b);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-budgets-api.test.js`
Expected: FAIL: `GET /api/cost/budgets` answers 404 `unknown route`.

- [ ] **Step 3: Edit `lib/cost/api.js`**

1. Requires (`:7`): add `const B = require('./budgets');`.
2. Options (`:26`):

```js
function createCostApi({
  cost,
  settings,
  listKeys = () => [],
  home = '',
  now = Date.now,
  // The budgets (Cost Control 2): the service (lib/cost/budget-service.js), where a change is written (server.js),
  // why agent control is off here (a pause budget is refused then), and what to run after any change they read.
  budgets = null,
  budgetStore = null,
  pauseOff = () => null,
  onChange = () => {},
}) {
```

3. After `ledgerQuery`'s helpers (before `const GET = {`):

```js
  const BUDGET_DELETE = /^\/api\/cost\/budgets\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/delete$/;
  // A view keeps its ~ project folder (as the ledger rows do); only its reason, a message, is scrubbed.
  const viewOut = (v) => (v && v.reason ? { ...v, reason: scrub(v.reason) } : v);
  const changed = () => {
    try {
      onChange();
    } catch {
      /* a refresh of the budgets never fails the request */
    }
  };
  // The saved list as it is now. A change is refused while it does not validate (or config.json does not parse), so a
  // save never replaces the owner's hand edit with the last valid list.
  function savedList() {
    if (!budgets || !budgetStore) throw fail(404, 'unknown route');
    const l = budgets.list();
    if (!l.complete) throw fail(409, `${l.error}; fix config.json first`);
    return l;
  }
  // The old setting a legacy budget of this id came from: cleared in the same save (monthlyBudgetUSD) or right after
  // it (a key's budgetUSD). The saved budget wins over the old setting, so a crash in between counts it once.
  function clearsFor(l, id) {
    const old = l.legacy.find((b) => b.id === id);
    return {
      clearMonthly: !!old && old.legacy === 'monthlyBudgetUSD',
      clearKey: old && old.legacy === 'keyBudget' ? old.scope.value : null,
    };
  }
  function saveBudget(body) {
    const l = savedList();
    const s = current().value;
    const r = B.validateBudget(body, {
      currency: s.currency ? s.currency.code : null,
      centers: s.centers.map((c) => c.id),
      home,
    });
    if (!r.ok) return reply(400, { error: 'invalid budget', reasons: r.errors });
    const why = r.value.enforce === 'pause' ? pauseOff() : null;
    if (why) throw fail(409, why);
    const next = [...l.saved];
    const at = next.findIndex((b) => b.id === r.value.id);
    if (at >= 0) next[at] = r.value;
    else next.push(r.value);
    if (next.length > B.LIMITS.budgets) throw fail(400, `at most ${B.LIMITS.budgets} budgets`);
    budgetStore.save(next, clearsFor(l, r.value.id));
    changed();
    return reply(200, { budget: viewOut(budgets.evaluate().find((v) => v.id === r.value.id) || null) });
  }
  function deleteBudget(id) {
    const l = savedList();
    const clears = clearsFor(l, id);
    if (!l.saved.some((b) => b.id === id) && !clears.clearMonthly && !clears.clearKey) throw fail(404, 'unknown budget');
    budgetStore.save(
      l.saved.filter((b) => b.id !== id),
      clears,
    );
    changed();
    return reply(200, { deleted: id });
  }
```

4. `GET` map: add

```js
    '/api/cost/budgets': () => {
      if (!budgets) throw fail(404, 'unknown route');
      const st = budgets.status();
      return reply(200, {
        budgets: budgets.evaluate().map(viewOut),
        error: st.error && scrub(st.error),
        reasons: st.reasons.map(scrub),
        guard: { error: st.guard && scrub(st.guard) },
        kept: { error: st.kept && scrub(st.kept) },
      });
    },
```

5. `POST` map: add `'/api/cost/budgets': (body) => saveBudget(body),`; in `/api/cost/settings` replace `settings.save(r.value);` with

```js
      // Budgets are saved through their own routes: a settings save keeps the list as it is.
      const raw = settings.get();
      settings.save(isObject(raw) && raw.budgets !== undefined ? { ...r.value, budgets: raw.budgets } : r.value);
```

and call `changed();` after `cost.retag();`; in `/api/cost/restate` call `changed();` before `return reply(200, { correction, overrides });`.

6. `route` (`:120-146`): match the delete path beside the two maps:

```js
    const del = p.match(BUDGET_DELETE);
    const get = Object.hasOwn(GET, p);
    const post = Object.hasOwn(POST, p) || !!del;
```

and in the `try`, after the body is parsed and checked to be an object: `if (del) return deleteBudget(del[1]);` before `return POST[p](body);`. The 415, 413, 400 and error mapping stay as they are, so every budget error is scrubbed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cost-budgets-api.test.js test/cost-api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/cost/api.js test/cost-budgets-api.test.js
git commit -m "Cost API: list, save and delete budgets; a legacy edit clears its old setting"
```

---
### Task 7: Demo budgets and the minimal UI (shared: `lib/demo.js`, `public/*`, one test assertion)

**Files:**
- Modify: `lib/demo.js` (shared): `costDemo` (`:1507-1626`), `monitorsDemo` (`:1297-1310`)
- Modify: `public/monitorsview.js` (shared): after `monMeasure` (`:84-99`), `alertLine` (`:110-152`), the exports (`:1234-1253`)
- Modify: `public/app.js` (shared): `viewSettings` (`:731-776`)
- Modify: `public/gatewayview.js` (shared): the key form (`:589`)
- Modify: `test/monitors-api.test.js:861` (the demo has two more alerts: 5 → 7)
- Test: `test/budgets-demo-ui.test.js`

**Interfaces:**
- Consumes: `periodBounds` (Task 1); `createBudgetService` (Task 2); `/api/alerts` budget rows (Task 4); `/api/config`'s `monthlyBudgetManaged` (Task 8 wires it; the page treats a missing field as false).
- Produces:
  - `costDemo(now)` returns `settings.budgets` (three budgets) and `budgetNoData: { 'research-week': reason }`;
  - `monitorsDemo(now).alerts` has two budget rows;
  - `public/monitorsview.js` exports `monBudgetChange(alert) → { change, tone }` beside `alertLine`.

- [ ] **Step 1: Write the failing test**

```js
// test/budgets-demo-ui.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { costDemo, monitorsDemo } = require('../lib/demo');
const { createCost } = require('../lib/cost');
const { createBudgetService } = require('../lib/cost/budget-service');
const { alertLine, monBudgetChange } = require('../public/monitorsview');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const NOW = new Date(2026, 9, 22, 15).getTime(); // a Thursday afternoon, 70 % into October

test('demo budgets come in mixed states: used up and blocking, projected in IDR, without data', () => {
  const d = costDemo(NOW);
  assert.deepEqual(d.settings.budgets.map((b) => b.id), ['acme-gateway', 'team', 'research-week']);
  const cost = createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => NOW, nocase: false });
  const svc = createBudgetService({
    getSettings: () => d.settings,
    getLegacy: () => ({ monthlyBudgetUSD: 1000, keys: [] }),
    cost,
    home: HOME,
    now: () => NOW,
    nocase: false,
    demo: { noData: d.budgetNoData },
  });
  assert.equal(svc.list().complete, true, 'the demo list validates');
  const v = Object.fromEntries(svc.evaluate().map((x) => [x.id, x]));
  assert.deepEqual([v['acme-gateway'].state, v['acme-gateway'].enforce], ['exceeded', 'block']);
  assert.equal(v.team.projected, true);
  assert.notEqual(v.team.state, 'exceeded');
  assert.equal(v.team.currency, 'IDR');
  assert.equal(v['research-week'].state, 'no_data');
  assert.match(v['research-week'].reason, /\(demo\)/);
  assert.equal(v['legacy-monthly'].legacy, 'monthlyBudgetUSD');
  const alerts = monitorsDemo(NOW).alerts.filter((a) => a.rule === 'budget');
  assert.deepEqual(alerts.map((a) => [a.instance, a.state, a.title, a.period]), [
    ['acme-gateway', 'exceeded', 'Acme gateway key', 'month'],
    ['team', 'warn_80', 'Whole team', 'month'],
  ]);
});

test('the bell and drawer: a budget alert names the budget, the share and the period', () => {
  const b = (over = {}) => ({
    id: 'a1',
    ts: 1,
    rule: 'budget',
    ruleTitle: 'Budget',
    instance: 'abc',
    sessionKey: null,
    title: 'Team',
    value: 82.4,
    threshold: 80,
    state: 'warn_80',
    previous: 'warn_50',
    period: 'month',
    projected: false,
    ...over,
  });
  const l = alertLine(b(), []);
  assert.equal(l.text, 'Budget · Passed 80% · 82.4% of the budget this month · Team');
  assert.deepEqual([l.kind, l.tone, l.href], ['change', 'warn', null]);
  assert.deepEqual(monBudgetChange(b({ state: 'exceeded', previous: 'warn_80' })), { change: 'Used up', tone: 'bad' });
  assert.deepEqual(monBudgetChange(b({ state: 'ok', previous: 'exceeded' })), { change: 'Back under its levels', tone: 'good' });
  assert.deepEqual(monBudgetChange(b({ state: 'warn_50', previous: 'exceeded' })), { change: 'Back to 50%', tone: 'good' });
  assert.deepEqual(monBudgetChange(b({ state: 'warn_50', previous: 'warn_50', projected: true })), {
    change: 'Projected to pass its amount',
    tone: 'warn',
  });
  assert.equal(alertLine(b({ period: 'week' }), []).measure, '82.4% of the budget this week');
  assert.equal(alertLine(b({ period: 'decade' }), []).measure, '82.4% of the budget this period');
  assert.equal(alertLine(b({ ruleTitle: null }), []).title, 'Budget', 'the rule title without the server one');
});

test('the old budget fields say where budgets are managed', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /Manage in Budgets/);
  assert.match(app, /monthlyBudgetManaged \? 'disabled' : ''/);
  assert.match(app, /\.\.\.\(cfg\.monthlyBudgetManaged \? \{\} : \{ monthlyBudgetUSD:/, 'a managed field is not sent');
  const gw = fs.readFileSync(path.join(__dirname, '..', 'public', 'gatewayview.js'), 'utf8');
  assert.match(gw, /Manage in Budgets/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/budgets-demo-ui.test.js`
Expected: FAIL (`monBudgetChange` is not exported; the demo has no budgets).

- [ ] **Step 3: Demo budgets in `lib/demo.js` `costDemo`** — after the `for (const day of daysBetween(start, today))` loop, before `const ago = …` (`:1606`):

```js
  // Budgets in mixed states (Cost Control 2), their amounts set from the demo's own rows so the states hold on any
  // day: the Acme key used up and blocked, the whole team projected over its amount in IDR, and the research week on
  // what was paid without data (the demo's stand-in for a billing history that could not be read).
  const { periodBounds } = require('./cost/budgets');
  const spentIn = (b, inScope) =>
    [...rows.values()].filter((x) => x.day >= b.from && x.day <= today && inScope(x)).reduce((a, x) => a + x.listUSD, 0);
  const month = periodBounds('month', now);
  const acmeUSD = spentIn(month, (x) => x.keyId === 'key_demo0acme01');
  // A period far enough in for a projection (from 25 %) and not near its end, else the month.
  const span =
    ['month', 'week', 'day'].map((p) => periodBounds(p, now)).find((b) => b.fraction >= 0.3 && b.fraction <= 0.85) || month;
  const teamUSD = spentIn(span, () => true);
  const amountUSD = Math.max(teamUSD * 1.1, (teamUSD / Math.max(span.fraction, 0.3)) * 0.9);
  const rateToday = settings.currency.rates[settings.currency.rates.length - 1].perUSD;
  settings.budgets = [
    {
      id: 'acme-gateway',
      name: 'Acme gateway key',
      scope: { dim: 'key', value: 'key_demo0acme01' },
      period: 'month',
      amount: Math.max(0.0001, Math.round(acmeUSD * 0.8 * 1e4) / 1e4),
      enforce: 'block',
    },
    { id: 'team', name: 'Whole team', scope: 'global', period: span.period, amount: Math.round(amountUSD * rateToday), currency: 'IDR' },
    {
      id: 'research-week',
      name: 'Research, paid',
      scope: { dim: 'center', value: 'research' },
      period: 'week',
      amount: 50,
      measure: 'billed',
    },
  ];
```

and in the returned object, after `billing: …`: `budgetNoData: { 'research-week': 'the billing history could not be read (demo)' },`.

- [ ] **Step 4: Demo budget alerts in `monitorsDemo`** (`:1297-1310`). Insert after the `change(50, 'unsafe_content', …)` row:

```js
    // Budget alerts (Cost Control 2): the ids and names of costDemo's budgets.
    {
      ...change(30, 'budget', 'exceeded', 'warn_80', 125, 100),
      instance: 'acme-gateway',
      title: 'Acme gateway key',
      period: 'month',
      projected: false,
    },
```

and append after the pause row:

```js
    { ...change(8, 'budget', 'warn_80', 'warn_50', 84.2, 80), instance: 'team', title: 'Whole team', period: 'month', projected: true },
```

Then change `test/monitors-api.test.js:861` to `assert.equal(alerts.length, 7);` with the comment `// five monitor alerts and two budget alerts (lib/demo.js monitorsDemo)`.

- [ ] **Step 5: Budget lines in `public/monitorsview.js`**

After `monMeasure` (`:99`):

```js
// A budget alert (rule `budget`): the level it reached or fell back to, or its projection, with its share of the
// period. The budget's name is the line's session part (the owner's own words, shown as text).
const MON_PERIOD = { day: 'today', week: 'this week', month: 'this month' };
const monBudgetRank = (s) => (s === 'exceeded' ? 100 : /^warn_\d{1,2}$/.test(String(s || '')) ? Number(s.slice(5)) : 0);
function monBudgetChange(a) {
  const now = monBudgetRank(a.state);
  const was = monBudgetRank(a.previous);
  if (now > was) return a.state === 'exceeded' ? { change: 'Used up', tone: 'bad' } : { change: `Passed ${now}%`, tone: 'warn' };
  if (now < was) return { change: a.state === 'ok' ? 'Back under its levels' : `Back to ${now}%`, tone: 'good' };
  if (a.projected === true) return { change: 'Projected to pass its amount', tone: 'warn' };
  return { change: 'Changed', tone: 'muted' };
}
const monBudgetMeasure = (a) =>
  monNum(a.value)
    ? `${monRound(a.value)}% of the budget ${Object.hasOwn(MON_PERIOD, a.period || '') ? MON_PERIOD[a.period] : 'this period'}`
    : '';
```

In `alertLine`, between the pause branch and the generic change branch:

```js
  } else if (a.rule === 'budget') {
    // The bell's rule list (/api/monitors) has no budget rule, so its title is named here when the server sent none.
    const title = monText(a.ruleTitle, MON_MAX_TITLE) || 'Budget';
    line = { ...base, kind: 'change', title, measure: monBudgetMeasure(a), ...monBudgetChange(a) };
  } else {
```

and add `monBudgetChange,` to the exports. The drawer and the bell render `line.text` and its parts as text already (`monAlertRow`), so nothing else changes there.

- [ ] **Step 6: The old fields, `public/app.js` `viewSettings`**

Above `async function viewSettings`:

```js
const SETTINGS_BUDGETS_DOC = 'https://github.com/rifqifitriady/ZAAFPulse/blob/main/docs/cost.md#budgets';
```

Replace the monthly budget `<label>` line (`:739`) with:

```js
        <label>Monthly budget (USD, API-equivalent)<input class="input" name="monthlyBudgetUSD" type="number" min="0" step="1" value="${Number(cfg.monthlyBudgetUSD) || 0}" ${cfg.monthlyBudgetManaged ? 'disabled' : ''}></label>
        <p class="muted" style="margin:-4px 0 0">${cfg.monthlyBudgetManaged ? 'This budget was edited in Budgets, so it is changed there now.' : 'Read as the monthly budget in Budgets, with alerts at 50 and 80 %.'} <a href="${SETTINGS_BUDGETS_DOC}" target="_blank" rel="noopener">Manage in Budgets</a></p>
```

and in the submit body (`:760-765`) replace `monthlyBudgetUSD: Number(f.get('monthlyBudgetUSD')),` with `...(cfg.monthlyBudgetManaged ? {} : { monthlyBudgetUSD: Number(f.get('monthlyBudgetUSD')) }),`.

- [ ] **Step 7: The key form, `public/gatewayview.js`** — at the top of the file with the other constants:

```js
const GW_BUDGETS_DOC = 'https://github.com/rifqifitriady/ZAAFPulse/blob/main/docs/cost.md#budgets';
```

and after the `<div class="gw-row">…<button class="btn" type="submit">Create key</button></div>` row of the key form (`:589-592`):

```js
          <p class="muted">A key's budget is a monthly budget that blocks the key with 402 once it is used up. <a href="${GW_BUDGETS_DOC}" target="_blank" rel="noopener">Manage in Budgets</a></p>
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test test/budgets-demo-ui.test.js test/monitors-ui.test.js test/gateway-forms.test.js test/cost-api.test.js test/monitors-api.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/demo.js public/monitorsview.js public/app.js public/gatewayview.js test/monitors-api.test.js test/budgets-demo-ui.test.js
git commit -m "Budgets in the demo, budget alerts in the bell and drawer, Manage in Budgets notes"
```

---
### Task 8: Wire into `server.js`, spawned-server tests, docs (shared: `server.js`, `README.md`, `docs/monitors.md`)

**Files:**
- Modify: `server.js` (shared). Each edit is additive or a one-line change:
  - `:47` the agent control require; after `:54` the budget requires;
  - `saveConfigSection` (`:253-297`) becomes `saveConfigSections(patch)` plus a one-line `saveConfigSection`;
  - before `const gateway = createGateway({` (`:365`) the late-bound guard, and `budgetGuard` in its options;
  - the cost block (`:401-424`): the demo's raw `monthlyBudgetUSD`, the service and the guard, the cost API options;
  - `createMonitors` (`:560-571`) and `createMonitorApi` (`:613-639`) options;
  - `costTick` (`:701-704`);
  - `/api/summary` (`:1038`), `/api/config` GET and POST (`:1257-1300`).
- Create: `test/budgets-http.test.js`
- Modify: `docs/cost.md` (new `## Budgets` section), `docs/monitors.md` (rules table note, budget alerts), `README.md` (Cost ledger section, the Monitors feature cell)

**Interfaces:**
- Consumes: everything above: `createBudgetService`, `createGuard`, the gateway's `budgetGuard`, the cost API's `budgets`/`budgetStore`/`pauseOff`/`onChange`, the engine's `budgets`/`retired`/`home` and `tickBudgets`, the monitor API's `retired`; `detectDocker` (`lib/agents/control.js`); `fakeServer`, `secretsFor`, `NO_JUDGE_PORTS` (`test/helpers.js`).
- Produces: budgets live behind the dashboard sign-in, the guard in front of every gateway request, `tickBudgets()` after every ledger pass, `daily_cost` and `month_projection` retired.

- [ ] **Step 1: Write the failing spawned-server tests**

```js
// test/budgets-http.test.js: a spawned server.js, the demo and a real data folder. No real provider, no network: the
// upstream is a fake server on 127.0.0.1; pricing sync is off; notifications are off (NO_JUDGE_PORTS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway } = require('../lib/gateway');
const { NO_JUDGE_PORTS, secretsFor, fakeServer } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const PRICE = { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-budgets-http-'));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own: no other test uses 8400-8799.
    const port = 8400 + Math.floor(Math.random() * 400);
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
  const call = async (p, { method = 'GET', body, extra = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
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
  return { call, post: (p, body) => call(p, { method: 'POST', body, extra: JSON_HEADERS }), bodies };
}

test('budgets over HTTP: the demo budgets and budget alerts, the retired rules, path-free', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const r = await c.call('/api/cost/budgets');
    assert.equal(r.status, 200);
    const v = Object.fromEntries(r.json.budgets.map((b) => [b.id, b]));
    assert.deepEqual([v['acme-gateway'].state, v['acme-gateway'].enforce], ['exceeded', 'block']);
    assert.equal(v['research-week'].state, 'no_data');
    assert.equal(v['legacy-monthly'].legacy, 'monthlyBudgetUSD');
    const alerts = (await c.call('/api/alerts')).json.alerts.filter((a) => a.rule === 'budget');
    assert.deepEqual(
      alerts.map((a) => [a.title, a.period, a.ruleTitle]),
      [
        ['Whole team', 'month', 'Budget'],
        ['Acme gateway key', 'month', 'Budget'],
      ],
      'newest first',
    );
    const ids = (await c.call('/api/monitors')).json.rules.map((x) => x.id);
    assert.equal(ids.includes('daily_cost') || ids.includes('month_projection'), false);
    const cfg = (await c.call('/api/config')).json;
    assert.deepEqual([cfg.monthlyBudgetUSD, cfg.monthlyBudgetManaged], [1000, false]);
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
  } finally {
    await s.stop();
  }
});

test('budgets over HTTP: sign-in only; a key budget answers 402 at once; a legacy edit moves the old setting', async () => {
  const upstream = await fakeServer({
    'POST /chat/completions': {
      body: {
        id: 'c1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 }, // 0.002 at PRICE
      },
    },
    'GET /models': { body: { data: [{ id: 'llama-9' }] } },
  });
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
  const { key, secret } = gw.keys.create({ name: 'app', scopes: ['llm'], budgetUSD: 0.002, rpm: 600 });
  gw.flush();
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      pricingSync: { enabled: false },
      pricing: { 'llama-9': PRICE },
      monthlyBudgetUSD: 50,
      gateway: { providers: [{ id: 'fake', preset: 'custom', baseUrl: upstream.url, models: [], enabled: true }] },
    }),
  );
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  try {
    const bearer = client(s.base, { authorization: `Bearer ${secret}`, 'x-api-key': secret });
    for (const who of [client(s.base), bearer]) {
      assert.equal((await who.call('/api/cost/budgets')).status, 401);
      assert.equal((await who.post('/api/cost/budgets', {})).status, 401);
      assert.equal((await who.post('/api/cost/budgets/legacy-monthly/delete', {})).status, 401);
    }
    const chat = () => bearer.post('/v1/chat/completions', { model: 'fake/llama-9', messages: [{ role: 'user', content: 'x' }] });
    assert.equal((await chat()).status, 200);
    const refused = await chat();
    assert.equal(refused.status, 402, 'blocked before any ledger pass read the call');
    assert.match(refused.text, /budget \\?"Key app\\?" is used up for this month/);
    const login = await fetch(`${s.base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const c = client(s.base, { cookie });
    const list = Object.fromEntries((await c.call('/api/cost/budgets')).json.budgets.map((b) => [b.id, b]));
    assert.equal(list[`legacy-key-${key.id}`].state, 'exceeded');
    assert.deepEqual([list['legacy-monthly'].amount, list['legacy-monthly'].legacy], [50, 'monthlyBudgetUSD']);
    assert.equal((await c.call('/api/cost/budgets', { method: 'POST', body: {} })).status, 415);
    assert.equal((await c.post('/api/cost/budgets', { id: 'x' })).status, 400);
    const edit = await c.post('/api/cost/budgets', { id: 'legacy-monthly', name: 'Team month', scope: 'global', period: 'month', amount: 60 });
    assert.equal(edit.status, 200);
    const file = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(file.monthlyBudgetUSD, 0, 'the old setting is cleared in the same write');
    assert.deepEqual(file.cost.budgets.map((b) => b.id), ['legacy-monthly']);
    assert.equal(file.pricingSync.enabled, false, 'every other section is kept');
    const cfg = (await c.call('/api/config')).json;
    assert.deepEqual([cfg.monthlyBudgetUSD, cfg.monthlyBudgetManaged], [60, true]);
    assert.equal((await c.post(`/api/cost/budgets/legacy-key-${key.id}/delete`, {})).status, 200);
    assert.equal((await chat()).status, 200, 'the key budget is gone with its budgetUSD');
    assert.equal((await c.call('/api/monitors')).json.rules.some((r) => r.id === 'daily_cost'), false);
    const kept = JSON.parse(fs.readFileSync(path.join(data, '.data', 'cost', 'budgets.last.json'), 'utf8'));
    assert.deepEqual(kept.budgets.map((b) => b.id), ['legacy-monthly'], 'the last valid list is on disk');
    if (process.platform !== 'win32')
      assert.equal(fs.statSync(path.join(data, '.data', 'cost', 'budgets.last.json')).mode & 0o777, 0o600);
    for (const b of [...c.bodies, ...bearer.bodies]) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
  } finally {
    await s.stop();
    await upstream.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/budgets-http.test.js`
Expected: FAIL. `GET /api/cost/budgets` answers 404 (`unknown route`: the cost API has no budget service yet), and the key's 402 still carries the old message (`monthly budget of $0.002 reached for this key`).

- [ ] **Step 3: Edit `server.js`**

1. `:47`: `const { createAgentControl, detectDocker } = require('./lib/agents/control');`. After `:54`:

```js
const { createBudgetService } = require('./lib/cost/budget-service');
const { createGuard } = require('./lib/cost/guard');
```

2. `saveConfigSection` (`:260-297`): rename it `saveConfigSections(patch)`; in its DEMO branch use `rawCache.value = { ...rawCache.value, ...patch };` and build `const raw = { ...base, ...patch };`. Everything else (the fresh read, the refusal of an unparsable file, the unique temp file, `wx`, 0600, the rename, the cache refresh) stays as it is. Then:

```js
// One section, for every settings page. A budget save writes two top-level fields at once (budget-service.js).
function saveConfigSection(name, value) {
  return saveConfigSections({ [name]: value });
}
```

and extend the comment above it: `saveConfigSections(patch) replaces several top-level sections in one write.`

3. Before `const gateway = createGateway({` (`:365`):

```js
// Cost Control budgets: the gateway asks the guard before each request and reports each call to the budget service.
// Both are made with the ledger below, after the gateway; until then (startup, before the server listens) nothing is
// refused.
let costBudgets = null;
let costGuard = null;
const budgetGuard = {
  check: (ctx) => (costGuard ? costGuard.check(ctx) : null),
  keyLimited: (keyId) => !!costGuard && costGuard.keyLimited(keyId),
  record: (entry) => costBudgets && costBudgets.record(entry),
};
```

and `budgetGuard,` in the `createGateway` options after `trustProxy: …`.

4. The cost block: `if (DEMO) rawCache.value = { ...rawCache.value, cost: costDemo.settings };` (`:404`) becomes

```js
if (DEMO) rawCache.value = { ...rawCache.value, cost: costDemo.settings, monthlyBudgetUSD: demo.config.monthlyBudgetUSD };
```

After `const cost = createCost({ … });` (`:418`):

```js
// Budgets (Cost Control 2): config.json "cost.budgets" plus the old monthlyBudgetUSD and key budgets read as budgets.
costBudgets = createBudgetService({
  getSettings: costSettings,
  getLegacy: () => ({ monthlyBudgetUSD: rawConfig().monthlyBudgetUSD, keys: gateway.keys.list() }),
  cost,
  home: os.homedir(),
  demo: costDemo ? { noData: costDemo.budgetNoData } : null,
  // The last valid list, kept across restarts (the demo keeps nothing on disk).
  lastFile: DEMO ? null : path.join(DIR, '.data', 'cost', 'budgets.last.json'),
});
costGuard = createGuard({ service: costBudgets });
// A budget save: the list into config.json "cost", and the old setting it replaces cleared in the same write
// (monthlyBudgetUSD) or right after it (a key's budgetUSD, in keys.json). A saved budget wins over the old setting of
// its id, so a crash between the two writes never counts a budget twice.
function saveBudgets(list, { clearMonthly = false, clearKey = null } = {}) {
  const raw = rawConfig();
  const c = raw && raw.cost && typeof raw.cost === 'object' && !Array.isArray(raw.cost) ? raw.cost : {};
  saveConfigSections({ cost: { ...c, budgets: list }, ...(clearMonthly ? { monthlyBudgetUSD: 0 } : {}) });
  if (clearMonthly && !DEMO) config = loadConfig();
  if (clearKey) gateway.keys.update(clearKey, { budgetUSD: null });
}
// A pause budget needs agent control, as an auto-pause rule does (lib/monitors/api.js): off in server mode, with a
// password or no sign-in, and in Docker.
const budgetPauseOff = () =>
  AGENTS_OFF === 'no-sign-in'
    ? 'agent control is off without a dashboard sign-in'
    : AGENTS_OFF
      ? 'agent control is off on this server'
      : !DEMO && detectDocker()
        ? 'agent control is off in Docker'
        : null;
// After any change the budgets read: a fresh ledger read and a budget pass, so an alert or a lifted block is current.
const budgetsChanged = () => {
  costBudgets.invalidate();
  monitors.tickBudgets().catch(() => {});
};
```

(`AGENTS_OFF` and `monitors` are declared further down; both functions run only on a request.) Add to the `createCostApi({ … })` options:

```js
  budgets: costBudgets,
  budgetStore: { save: saveBudgets },
  pauseOff: budgetPauseOff,
  onChange: () => budgetsChanged(),
```

5. Before `const monitors = createMonitors({` (`:560`):

```js
// daily_cost and month_projection became budgets (legacy-monthly): they are not evaluated, listed or changed, so
// nothing alerts twice.
const RETIRED_RULES = ['daily_cost', 'month_projection'];
```

and in its options: `budgets: costBudgets, retired: RETIRED_RULES, home: os.homedir(),`. In `createMonitorApi({ … })`: `retired: RETIRED_RULES,`.

6. `costTick` (`:701-704`):

```js
// The cost ledger pass reads the refreshed index too; the budget service drops the gateway calls it read, then the
// budgets are evaluated (alerts, pause). A failure never breaks a refresh.
const costTick = () =>
  Promise.resolve()
    .then(() => costBudgets.pass(() => cost.update()))
    .then(() => monitors.tickBudgets())
    .catch(() => console.error('cost: the ledger pass failed'));
```

7. `/api/summary` (`:1038`): `config: { userName: config.userName, monthlyBudgetUSD: costBudgets.monthly().monthlyBudgetUSD, host: HOSTNAME },`.

8. `/api/config` GET (`:1257-1260`): `return send(res, 200, { ...rest, ...costBudgets.monthly() });`. POST (`:1261-1300`):
   - `const managed = costBudgets.monthly().monthlyBudgetManaged;` at the top, and the budget line becomes `if (!managed && Number.isFinite(body.monthlyBudgetUSD) && body.monthlyBudgetUSD >= 0)`;
   - in the DEMO branch, after `config = next;`: `rawCache.value = { ...rawCache.value, monthlyBudgetUSD: next.monthlyBudgetUSD };` (the demo's legacy budget reads it);
   - after `memo.clear();`: `budgetsChanged();`;
   - the answer: `return send(res, 200, { ...rest, ...costBudgets.monthly() });`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/budgets-http.test.js test/cost-api.test.js test/monitors-api.test.js test/monitors-engine.test.js test/signin.test.js test/security.test.js`
Expected: PASS.

- [ ] **Step 5: Docs**

`docs/cost.md`: a `## Budgets` section after `## Restate` (before `## Fail closed`), with these subsections and contents:
- **Budgets in `config.json`.** The shape (R1) as a table with defaults, an example, and the validation errors; while the list does not validate or `config.json` does not parse, the last valid list stays in force (kept in `.data/cost/budgets.last.json`, so a restart keeps it), else only the old settings apply; the status warnings and the 409 until the list is fixed. Add `budgets.last.json` to `## Files`.
- **What a budget counts.** R4: both measures, plan rows only in global and source scopes, corrections and billing overrides applied, the display currency at the latest rate on or before today.
- **States and alerts.** R5 and R6: `ok`, `warn_<n>`, `exceeded` at 100 % always, `projected` from 25 % of the period, the `no_data` cases, change-only alerts, a new period starts at `ok`, alerts in the bell, the desktop and the webhook (the webhook gets the state, never the name).
- **Block.** R7: the scopes, dashboard calls, route targets skipped, the 402 message, overshoot by the calls in flight, the lift at a new period or a raised amount, and fail-open (`guard.error` in `GET /api/cost/budgets`).
- **Pause.** R9 and every agent-control rule (link `docs/monitors.md#agent-control`).
- **Migration.** R2, the retired rules, the edit that clears the old setting (and the order of the two writes for a key), the Settings field once managed, and "a key's spent now uses the ledger's shared pricer, so it may read slightly higher than the key table".
- **API.** The three routes with their answers and errors, in the style of `## API`.
- **Known limits** additions: Claude Code or Codex on this machine through a key is counted under its own source, not the key (see the decision below); concurrent requests can pass a block by more than one call.

`docs/monitors.md`: under `## Rules`, a note that `daily_cost` and `month_projection` are replaced by budgets (`docs/cost.md#budgets`) and are no longer evaluated or listed; under `## States and alerts`, a short paragraph on budget alerts (rule `budget`, states `ok`/`warn_<n>`/`exceeded`, change-only, no reminders) and on the budget pause under `### Auto-pause`.

`README.md`: after the Cost ledger bullet list (`:806`), add

```md
**Budgets** sit on the ledger: global or per cost center, key, project, model, provider or source, by day, week (from Monday) or month, on the usage value or on what was paid, in USD or your display currency. Alerts at your levels (50 and 80 % by default), at 100 % and when the projection passes the amount, in the bell, the desktop or a webhook. A budget can also block matching gateway requests with 402 at once, or pause the costliest local agent in its scope. The old monthly budget and key budgets are read as budgets. See [docs/cost.md#budgets](docs/cost.md#budgets).
```

and in the Monitors feature cell (`:93`) change `Eight rules on cost, quality and agent behaviour` to `Six rules on cost, quality and agent behaviour, plus your budgets,` (the two old cost rules are budgets now).

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS on this machine. CI runs the same on Ubuntu, macOS and Windows.

- [ ] **Step 7: Commit**

```bash
git add server.js test/budgets-http.test.js docs/cost.md docs/monitors.md README.md
git commit -m "Wire budgets: the guard before every gateway request, budget passes after the ledger, retired rules, docs"
```

---
## Decisions made while planning

The spec left these open; each is built and tested as written here.

1. **Where budget state persists.** In the Monitors state file (`.data/monitors.json`, 0600, temp file + rename), as entries of rule `budget` with three extra fields: `period` (the period key), `projected`, `noData`. Their alerts go to `.data/alerts.jsonl` with the other alerts. The rule is `BUDGET_RULE`, kept **out of `RULES`**, so the eight fixed rules, their cards, their settings and every existing test stay as they are; `ruleById()` finds it for the state store, the channels and the alerts API.
2. **Instance ids** are the budget ids. Legacy ids are `legacy-monthly` and `legacy-key-<keyId>`; the id pattern allows `_` because key ids are `key_<hex>`. Monitor API instance ids stay opaque (the existing HMAC).
3. **Removing a budget** retires its state entry and its snooze on the next budget pass, but only when the saved list read in full (`complete`); while a hand edit does not validate or `config.json` does not parse, nothing is retired. Budget entries are never pruned by age.
4. **Its own state path** (`applyBudgets`), not `apply()`: budgets have several levels, no reminder and no resolution hold, a period reset, and `no_data` that keeps the last state. The snooze, the alert store, the channels, `note()` and `markActed()` are shared.
5. **A budget seen for the first time** starts at `ok`, so a first state above a level alerts once. A drop (after an amount was raised) alerts too ("Back under its levels"). A projection alerts only when it starts to pass the amount, and never beside `exceeded`.
6. **The increment retirement key** is a per-process sequence number. `service.pass(run)` takes the last number before the synchronous ledger pass and drops every increment up to it when `cost.gatewayPasses()` went up (the gateway step was applied). This holds because the gateway appends a line synchronously (`appendFileSync`) before it reports the call, and a pass reads synchronously, so no call can be recorded while a pass reads. A pass whose gateway step stopped (the log did not read, the positions are lost) keeps every increment. Tested with the real ledger, including a call recorded inside a pass after its read.
7. **Increments are priced by the ledger itself** (`cost.priceGatewayLine`: the gateway collector, the price version of the day, the attribution, the billing of the day), so the guard and the next pass agree; a line the ledger skips (a local tool's line, a failed attempt) adds nothing.
8. **How the guard learns a key's center:** from `config.json` → `cost.keyCenters` through the service (`keyCenter`), `unassigned` when the key has none, the same as the ledger attributes a gateway line.
9. **The guard checks each route target.** A target whose provider or model budget is used up is skipped and the next target is tried; 402 comes only when no target is left. The model checked is the name the call is logged under (`routedTo || model`), as the ledger's model.
10. **The source of a call** for a `source: gateway` budget is derived as the ledger does: `runId` → `collab`, agent `judge` → `judge`, agent `replay` → `replay`, else `gateway`. Dashboard calls (no key) meet only global, model and provider budgets; key, center and source budgets need a key.
11. **Overshoot.** No reservation: every request in flight finishes, so concurrent requests can pass a block by more than one call (one per request in flight). Documented.
12. **Priced models only.** A key under a blocking key or center budget may use only priced (or private) models, as a key with `budgetUSD` does today; global, model and provider budgets do not add that rule (it would change every key).
13. **`no_data` cases**, all failing open for the guard and never pausing: an unread month of the period, the folder or the corrections; for `billed`, the billing history unreadable or a row of the period billed as assumed (history lost); a currency with no rate on or before today, or no longer the display currency.
14. **The last valid list survives a restart (owner decision D).** Whenever a `cost.budgets` list validates (on load or on save; an absent list counts as a valid empty one), it is written to `.data/cost/budgets.last.json` through `writePrivate` (unique temp file, 0600, fsync, rename, folder sync), only when it changed: `{ version: 1, budgets, context: { currency, centers } }`. While `config.json`'s list does not validate or the file does not parse, the list in force stays: the one of this process, else the kept file, validated against the cost settings that read now (or the context it was kept with while `config.json` does not parse). Only when neither is valid do the legacy budgets alone apply. Path-free warnings: `budgets in config.json are invalid; the last valid list is in force`, `… and no valid list was kept; only the old settings apply`, and the two `config.json could not be read; …` forms. A valid `config.json` list always wins and overwrites the file. Legacy budgets are never stored in it. A failed write is shown as `kept.error` in `GET /api/cost/budgets`. A save or delete is still refused with 409 until the hand edit is fixed, so the owner's file is never overwritten with the kept list. The demo keeps nothing on disk.
15. **`cost.budgets` and the cost settings.** `rules.js` accepts the field and ignores it, so a bad budget never makes the cost settings fall back to defaults; `POST /api/cost/settings` keeps the saved list.
16. **The pause target** is the costliest running session **today** (the engine's existing `agg.costly`, as for `daily_cost`) whose session is in scope: tool for `source`, the folder written as the ledger writes it (`projectOf`, `~/…`) for `project`, that folder through the folder rules for `center`, one of the session's models for `model`. Without the home folder, project and center budgets match nothing. A budget waiting for the first live pass acts on it then. "No candidate" is reported once per period.
17. **A pause budget needs agent control:** saving `enforce: 'pause'` answers 409 where agent control is off (server mode, password or no sign-in, Docker), the same rule as a rule's auto-pause setting. The control module still checks the process before every signal.
18. **Retiring `daily_cost` and `month_projection`** is a `retired` option of the engine and the monitor API, set by `server.js`: they are not evaluated, not acted on, not listed, not counted, and a change answers 410. Their old states and alerts stay as history. Without the option (every existing test) they behave as before.
19. **Legacy budgets** use the spec's defaults for unlisted fields: levels 50 and 80 and the projection, so key budgets now alert before they block. A key budget of 0 is kept (exceeded at once, as the old check refused at once); a revoked key's budget is not read.
20. **Editing a legacy budget** saves it under the same id, so its state and alerts carry over (no new alert for a state it already had). For `monthlyBudgetUSD` the list and `monthlyBudgetUSD: 0` go in one `config.json` write (`saveConfigSections`). A key's `budgetUSD` lives in `keys.json`: it is cleared right after the `config.json` write, and because a saved budget wins over the old setting of its id, a crash between the two writes never counts the key twice.
21. **The old Settings field after the edit** is shown disabled with the managed amount (`/api/config` returns `monthlyBudgetUSD` and `monthlyBudgetManaged`, and ignores a posted value while managed), and the Overview's budget line reads the same figure. The key form is a create form, so it only gains the note; the key table keeps `usage.monthSpend` as its spend column.
22. **The demo's no-data budget** uses a demo-only stand-in (`budgetNoData`), shown with the reason `the billing history could not be read (demo)`: the in-memory demo ledger cannot fail a read. The other demo budgets take their amounts from the demo rows, so their states hold on any day.
23. **Budget alerts on the webhook** keep the seven fields (the state is `warn_80`, `exceeded`, …); the budget's name never leaves the machine. The desktop shows the name as its second line. A budget has no snooze route yet (the state store supports it; sub-project 3 adds the page).

**Owner decisions (2026-10-25):**
- **A. Accepted.** Claude Code or Codex on this machine pointed at the gateway with a key is counted from its own logs under `claude`/`codex`, without the key (sub-project 1), so a key budget does not count those calls. The ledger is the only spent; documented under Known limits.
- **B. Accepted.** Legacy key budgets alert at 50 % and 80 % and on projection (spec defaults), and block at 100 %.
- **C. Accepted.** The guard routes around a blocked provider or model to the next route target; 402 only when no target is left.
- **D. Changed.** The last valid budget list survives a restart in `.data/cost/budgets.last.json` (decision 14; Task 2, wired in Task 8): invalid hand edit + restart keeps the kept list (a blocking budget included) in force with a warning; a corrupt or invalid kept file with an invalid config leaves the legacy budgets alone, with a warning; a valid config always wins over the file.

## Self-review

**Spec coverage** (spec section → task):
- Budget shape and validation, incl. block/pause scope rules, currency, duplicates, legacy field → Task 1 (R1), Task 6 (400 with reasons).
- An invalid saved list keeps the last valid one in force with a status warning, across restarts (owner decision D: `budgets.last.json`) → Task 2 (restart with a blocking budget, corrupt file, valid config wins), Task 6 (409 while invalid), Task 8 (the file on disk, 0600).
- Period bounds: local day, Monday week, month, roll-over → Task 1.
- Spent per scope, both measures, plan rows only global/source for billed, corrections and overrides via the ledger read → Task 1 (pure), Task 2 (real ledger: restate correction, billing override).
- IDR conversion, no rate → `no_data` → Task 1.
- States, `exceeded` at 100 % always, `projected` from 25 %, `no_data` cases → Task 1; change-only alerts and period reset → Task 4, Task 5.
- Guard: scopes, increments and their exact retirement, a pass between two requests, overshoot by one call, lift on a new period and a raised amount, allow when unavailable, 402 naming only its budget, dashboard calls → Task 2, Task 3, Task 8 (over HTTP).
- Pause: scopes, costliest running session in scope, once per period, never resumed, agent-control safety → Task 1 (scope validation), Task 5 (engine with a spy control), Task 6 (409 while control is off).
- Migration: legacy budgets read, `daily_cost`/`month_projection` retired, 402 kept, editing a legacy budget clears the old setting in one write → Task 1, Task 4/5 (`retired`), Task 3, Task 6, Task 8.
- HTTP API: three routes, sign-in only, gateway key refused, 415, 400, path-free → Task 6, Task 8.
- Demo budgets in mixed states → Task 7, Task 8.
- UI: budget alerts in the bell and drawer; "Manage in Budgets" on the old fields → Task 7.
- Privacy: names and numbers only; the webhook without names; the 402 names one budget → Task 3, Task 4.
- Docs (`docs/cost.md` budgets section, README) → Task 8.

**Placeholder scan:** no TBD or "similar to"; every code step shows the code; integration steps name each line and the exact replacement.

**Type consistency:** the view fields (`periodKey`, `percent`, `spentUSD`, `amountUSD`, `state`, `projected`, `reason`) are produced by `evaluateBudget` (Task 1) and read by the guard (Task 3: `state`), the engine (Task 5: `id`, `name`, `state`, `projected`, `periodKey`, `period`, `percent`, `scope`, `enforce`), the API (Task 6) and the demo test (Task 7). The engine's result fields (`instance`, `state`, `projected`, `periodKey`, `period`, `value`, `threshold`, `title`) match `applyBudgets` (Task 4). The service methods the engine uses (`evaluate`, `complete`, `centerOfProject`) and the guard uses (`list`, `evaluateOne`, `keyCenter`, `reportGuard`) are defined in Task 2; `status()` returns `{ error, reasons, guard, kept }`, which Task 6's `GET /api/cost/budgets` maps to `error`, `reasons`, `guard.error`, `kept.error`; `lastFile` is passed in Task 8. `budgetStore.save(list, { clearMonthly, clearKey })` is the same in Task 6 and Task 8.
