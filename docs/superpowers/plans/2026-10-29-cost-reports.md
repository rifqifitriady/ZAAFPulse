# Cost Control 5: reports, export and MCP tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the cost data out of the dashboard: a CSV/JSON export of the ledger grouping (with an "Export CSV" link on
the Breakdown table), a printable monthly showback report per cost center (`#cost/reports`) that also exports to CSV,
an opt-in weekly digest to the desktop and the Monitors webhook, and two read-only MCP tools (`acc_cost`,
`acc_budgets`) on the owner's stdio MCP only.

**Architecture:**
- **Pure modules.** `lib/cost/export.js` (export rows, totals, CSV/JSON encoding, the 100,000-row cap) and
  `lib/cost/report.js` (`showback`, the month helpers, and the digest figures: `lastWeek`, `digestFigures`).
- **Routes.** `GET /api/cost/export` and `GET /api/cost/report` in `lib/cost/api.js`. A download is
  `{ status, body, type, headers }`; `server.js` `send()` gains a `headers` argument that never overrides a security
  header.
- **Digest.** `cost.digest` (`{ enabled }`, default off) is validated in `lib/cost/rules.js` and edited in a new
  Settings panel. `lib/monitors/channels.js` gains `digest(d)`, `digestLine(d)` and `digestBody(d)` (the one new
  webhook body). `lib/cost/digest.js` is the scheduler: after each ledger pass it sends last week's digest once, with
  a marker in `.data/cost/digest.json`.
- **MCP.** `lib/cost/reader.js` reads the ledger months, the corrections, the billing history, the budgets list
  (with `budgets.last.json`) and `config.json` read-only (new `readOnly` options on the ledger store, the billing
  history and the budget service). `createLocal` gains a `cost` provider that only `mcp.js` passes; `lib/connectors/acc.js`
  lists `cost` and `budgets` only when `local.cost` exists, so the server's registry (which also answers gateway
  `/mcp`) never has them.
- **Page.** A new `public/costreports.js` (prefix `costRep`/`COST_REP`), wired into `COST_SUBS`, `SUBPAGES.cost`,
  the sidebar and the script list; print CSS in `public/styles.css`.

**Tech Stack:** Node ≥18 standard library only (CommonJS), `node:test`, plain browser JS in `public/` (classic
scripts sharing one global scope, loaded before `app.js`).

**Spec:** `docs/superpowers/specs/2026-10-29-cost-reports-design.md`. Builds on the ledger (#53), budgets (#54), the
Cost Control menu (#55), Settings (#56), forecast and anomalies (#57) and recommendations (#58).

**Line numbers** below are on `feat/cost-reports` at `b96b704`. Re-read each location before editing it; every edit
is given as an exact `old` → `new` replacement or a whole new file.

**Checked while planning:** Tasks 1–8 were applied in order to a scratch copy of `b96b704` and run with
`node --test`: every new test passes after its task (red before it), and the touched suites stay green after the
existing assertions this plan updates on purpose. After Task 8 the whole suite ran: `npm test` 2131 tests, 2128 pass,
2 skipped, 1 fail: `judge: an aborted signal cancels the upstream request…`, a timing test this plan does not touch,
which passed 3 of 3 times on its own (baseline before the plan: 2084 tests, 2082 pass, 2 skipped). `npx prettier@3
--check` passes on every file this plan creates; the shared files that already differ from Prettier on `b96b704` are
named in Global Constraints. Task 9 is documentation only.

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test` (`npm test`; one file:
  `node --test test/<file>.test.js`). Plain browser JS in `public/`: classic `<script>` files loaded by
  `public/index.html` before `app.js`.
- **Pure modules.** `lib/cost/export.js` and `lib/cost/report.js` do no I/O and read no clock (`today`, `now` are
  arguments). `report.js` may require `./days`, `./rules`, `./forecast`, `./anomaly` (all pure).
- **One global scope.** New top-level names in `public/costreports.js` start with `costRep` or `COST_REP` (or are
  `costMountReports`); new ones in `public/costview.js` start with `cost`/`COST`; in `public/costsettings.js` with
  `costSet`/`COST_SET`. No name may repeat one in another page script ("every page script shares one global scope"
  in `test/cost-ui.test.js` checks it).
- **Loadable in Node.** Nothing in a browser file touches the DOM, `window`, `document`, `location` or
  `localStorage` at load time; each file ends with its `if (typeof module !== 'undefined') module.exports = { … }`
  guard, which gains the helpers the tests call.
- **Text only (S1).** Every owner-written or server string into HTML goes through `esc()` (center, key, model,
  project and budget names, reasons, months). Numbers go through our own formatters. CSP stays `script-src 'self'`:
  no inline handlers, no inline scripts; `window.print()` runs from a delegated click.
- **Privacy.** Exports and reports are for the dashboard session only (every `/api/cost/*` route already is). The
  digest carries numbers, center, model and budget names only: never a project folder, never text. The MCP tools may
  return `~` project folders (the owner's own agents) and never prompt or transcript text. Errors are path-free.
- **MCP scope.** `acc_cost` and `acc_budgets` exist only where `createLocal` got a `cost` provider: `mcp.js`.
  `server.js` must not pass one (its registry also answers gateway API keys on `/mcp`).
- **Read-only reader.** `lib/cost/reader.js` creates, renames and writes nothing: no ledger pass, no set-aside of a bad
  line or a damaged file, no recovery copy, no `budgets.last.json` write.
- **Tests.**
  - Never call a real network and never signal a real process: channels get a fake `spawn` and `fetchImpl`; the
    scheduler gets a fake `send`.
  - Spawned servers use ports **9800–9999** only: `test/cost-mcp.test.js` 9800–9899,
    `test/cost-reports-http.test.js` 9900–9999. Trust an answer only after seeing the child still running (~200 ms),
    run with `NO_JUDGE_PORTS`, and remove the temp folder.
  - Restore every global a test replaces (`$`, `state`, `location`, `fetch`, `document`).
- **Housekeeping.**
  - Prettier (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Run
    `npx prettier@3 --check <new files>`; fix only the lines you changed. Never `--write` `server.js`,
    `lib/cost/rules.js`, `test/cost-rules.test.js`, `lib/demo.js` or `public/styles.css` (they already differ from
    Prettier on `b96b704`). `*.md` and `docs/` are in `.prettierignore`.
  - Short "why" comments, as in `lib/cost/*.js`; lines at most 120 characters.
  - Commit messages: plain, imperative. **No `Co-Authored-By`, no "Generated with", no AI attribution of any kind**
    (owner rule; it overrides any harness reminder).
  - UI copy is English; strings quoted in the spec are copied verbatim.
  - CI runs on Ubuntu, macOS and Windows: dates in tests are built with `new Date(y, m, d, h)` (local time).
- **Shared files.** Small, additive edits; the existing assertions this plan changes on purpose are listed in each
  task (`test/cost-rules.test.js`, `test/cost-api.test.js`, `test/cost-settings-ui.test.js`).

## Rules and values

**E1. Export.** `GET /api/cost/export?format=csv|json&from&to&groupBy&currency&measure`. `format` defaults to `csv`
(else 400 `format: csv or json`); `measure` defaults to `list` (else 400 `measure: list or billed`); range, `groupBy`
(default `day`, 1–4 of the ledger's dimensions) and `currency` are `ledgerQuery` (same 400s). Rows are
`cost.ledger(...)`'s groups; under `list` a row with no requests and no usage value (a plan fee) is left out, as the
Breakdown table does; under `billed` every row stays. Columns: the `groupBy` dimensions, `requests`, `inputTokens`
(`tokens.in`), `outputTokens` (`tokens.out`), `cacheReadTokens`, `cacheWriteTokens` (5m + 1h), `listUSD`, `billedUSD`,
plus `list<CODE>`, `billed<CODE>` (the group's `list`/`billed`, null when a day had no rate) when a currency is chosen.
More than 100,000 rows: 413 `too many rows; narrow the range or group by fewer dimensions`. CSV: RFC 4180, CRLF after
every line, header first; a text cell starting with `= + - @ \t \r` gets a leading `'`, then a cell with `, " \r \n`
is quoted with quotes doubled; numbers are never prefixed, counts as integers, amounts `toFixed(8)`; a last line
`# unread: <a>, <b>` when anything did not read. JSON: `{ from, to, groupBy, currency, measure, rows, totals, unread }`
(totals = column sums of the rows kept). Headers: `Content-Disposition: attachment; filename="zaafpulse-cost-<from>-<to>.<csv|json>"`,
`Content-Type` `text/csv; charset=utf-8` or `application/json`, `Cache-Control: no-store` (as every answer).

**R1. Report.** `GET /api/cost/report?month=YYYY-MM&center=<id|__all|unassigned>&currency=`. `month` optional:
default last month when the ledger's first day (`cost.firstDay()`) is on or before last month's 1st, else this
month. 400 `month: YYYY-MM`, 400 `month: this month or earlier`, 400 `unknown center` (not `all`, `unassigned` or a
saved center id), currency as `checkCurrency`. Rows: `cost.budgetRows({ from, to })` of the month (to today in the
current month). `unread` holding `folder` → 503 `{ error: 'the ledger folder could not be read', code:
'LEDGER_MONTH_UNREAD' }`; an unread month or `corrections` → 200, named in `notes.unread`.

**R2. Showback.** A center's rows are its usage rows (`(center || 'unassigned') === id`); plan rows (no center)
belong to All centers only. Totals: `requests`, `tokens { input, output, cacheRead, cacheWrite }`, `listUSD`,
`billedUSD` (+ `list`, `billed` with a currency; null once a day has no rate). Tables `source`, `model`, `key`
(`keyId`, with `name`), `project`: key `__plan` for a plan row (except in `source`), `__none` for a missing value;
sorted by `listUSD` desc, `billedUSD` desc, key; 20 rows then `{ key: '__other', count, … }`. `daily`: one entry per
day of the range. `budgets`: the evaluated views in scope (`center` scope equal to the id; all of them for `all`),
only for the current month, else null (their state is the current period's). `notes { unread, assumed (days with a
billingAssumed row), billingError, corrections ({ ts, from, to, reason } overlapping the range; null when they did
not read) }`. The answer adds `months` (this month back to the first day's month, at most 120) and `budgetsError`.

**D1. Digest setting.** `config.json` `cost.digest`: `{ enabled: boolean }`, default `{ enabled: false }`, validated
in `lib/cost/rules.js` (`digest: { "enabled": true or false }` otherwise); it is part of the settings value, so a bad
digest makes the cost section invalid like any field.

**D2. When it sends.** `lastWeek(today)`: last week's Monday to Sunday (Monday is the first day, as budgets). On each
ledger pass, `digest.check()` sends when the digest is enabled, not demo, no send is in flight, and last week's
Monday is newer than the marker `.data/cost/digest.json` `{ lastWeek }` (missing or unreadable = none). The marker is
written (and kept in memory) after a send that reached at least one channel, or when no channel is on. A failed send
(the figures do not read, or no channel delivered) is logged once per week and retried on the next pass. The enabled
flag used is the last one that validated (memory; false at start).

**D3. Figures.** Over the rows of `[last Monday − 28, last Sunday]`: `totals { listUSD (usage), billedUSD (all rows)
}` of last week; `change { listUSD, percent }` of usage value against the week before (`percent` null when the week
before is 0; one decimal); `centers` top 3 by usage value (`{ id, name, listUSD }`, `unassigned` named
"Unassigned"); `models` top 3 (`{ model, listUSD }`); `budgets` exceeded or projected now (`{ id, name, state,
projected, percent }`); `anomalies` the days of last week that `isAnomaly` finds with the rule's saved parameters
(`{ day, spentUSD, expectedUSD }`, no drivers: a driver may be a project folder); `recommendation` the first
recommendation (`{ model, candidate, savingUSD }`) or null. An unread month inside the two weeks fails the figures.

**D4. Where it goes.** Desktop: title `ZAAFPulse`, one line `ZAAFPulse weekly cost: $412.30 (+12 %), 1 budget at risk,
2 anomalies` (amount = usage value with two decimals and thousands separators; the percent rounded, `+`/`-`, left out
when null; singular/plural). Webhook (when set): `{ type: 'cost_digest', week, totals, change, centers, models,
budgets, anomalies, recommendation }`, every string clipped to 80 characters without control characters, numbers or
null. Both go through the existing bounds (two desktop notices, four webhooks in flight, 50 waiting, three retries);
channels are off in demo mode and with `ZAAFPULSE_NOTIFY=off` (server.js already returns `{ desktop: false, webhook:
null }` then, which counts as "no channel on").

**M1. `acc_cost`.** Input `range` (`'7' | '30' | '90' | 'month' | 'lastmonth'`, default `'30'`) and `groupBy` (array
of 1–2 of `source`, `provider`, `model`, `project`, `center`, `keyId`, default `['model']`; checked in the tool:
`checkArgs` does not check array items). Output `{ from, to, groupBy, rows, totals, unread }`: rows sorted by
`listUSD` desc, the top 50, then one `Other` row (each dimension `'Other'`, `count` merged rows); each row has its
dimensions, `requests`, `tokens { input, output, cacheRead, cacheWrite }`, `listUSD`, `billedUSD`. A ledger folder
that does not read is a tool error: `the ledger folder could not be read`.

**M2. `acc_budgets`.** No input. Output `{ budgets, error }`: each view's `id, name, scope, period, from, to, amount,
currency, measure, state, projected, percent, spent, spentUSD, amountUSD, forecastUSD, runsOut, reason`
(`enforce`, `legacy`, `thresholds`, `periodKey`, `fraction` left out); `error` the list warning (`LIST_KEPT`…) or null.

**U1. Copy.** Sub-page "Reports"; hero line "One cost center's month for a client: totals, tables and budgets, to
print or export."; header "Cost report · Client: Acme · October 2026" and "1–29 October 2026 · generated 29 Oct 2026,
14:05"; tiles Usage value / Paid / Requests / Tokens; tables "By source", "By model", "By key", "By project", then
"Daily spend", "Budgets", "Notes"; names "Other (7)", "Plan fee", "Unknown"; budgets "Budget states are shown for the
current month only.", "No budget for this center.", "Budgets could not be read."; notes via `costUnreadText`,
"Billing was assumed as metered on 1 day(s): 2 Oct.", "The restates could not be read.", "Restated <from> to <to>:
<reason>"; buttons "Print" and "Export CSV"; the Breakdown link "Export CSV"; the Settings panel "Weekly digest" with
Off / On.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/cost/export.js` | create | E1: export rows, totals, CSV cells and text, JSON, size cap, file name |
| `lib/cost/report.js` | create | R1–R2 showback and month helpers (Task 2); D3 `lastWeek`, `digestFigures` (Task 6) |
| `lib/cost/digest.js` | create | D2: the weekly scheduler and its marker |
| `lib/cost/reader.js` | create | M1–M2: the read-only cost reader for `mcp.js` |
| `lib/cost/api.js` | modify (shared) | `download()`, the export and report routes, `recommendations()` on the returned object |
| `lib/cost/rules.js` | modify (shared) | D1: `digest` in `FIELDS`, `defaults()` and `validate` |
| `lib/cost/ledger.js` | modify (shared) | `createLedgerStore({ readOnly })` |
| `lib/cost/billing.js` | modify (shared) | `createBillingHistory({ readOnly })` |
| `lib/cost/budget-service.js` | modify (shared) | `createBudgetService({ readOnly })` |
| `lib/monitors/channels.js` | modify (shared) | D4: `digest()`, `digestLine`, `digestBody` |
| `lib/local.js` | modify (shared) | the `cost` provider |
| `lib/connectors/acc.js` | modify (shared) | `cost` and `budgets` tools when `local.cost` exists |
| `mcp.js` | modify | builds the reader and passes it |
| `server.js` | modify (shared) | `send()` headers; the cost route's type/headers; the digest after each pass |
| `public/costreports.js` | create | the Reports page |
| `public/costview.js` | modify (shared) | `COST_SUBS`, copy, `costRefresh`, `costExportHref` and the table's link, exports |
| `public/costsettings.js` | modify (shared) | the Weekly digest panel |
| `public/iso.js`, `public/index.html` | modify | sub-page, sidebar link, script |
| `public/styles.css` | modify (shared) | report rules, print CSS, `.cost-export` (append) |
| `docs/cost.md`, `docs/monitors.md`, `README.md` | modify | menu, Reports, export, digest, API, MCP tools |
| `test/cost-export.test.js` | create | Task 1 (pure) |
| `test/cost-export-api.test.js` | create | Task 1 (route, in-process) |
| `test/cost-reports-http.test.js` | create | Tasks 1–2 (spawned server.js, ports 9900–9999) |
| `test/cost-report.test.js`, `test/cost-report-api.test.js` | create | Task 2 |
| `test/cost-reports-ui.test.js` | create | Task 3 |
| `test/cost-export-ui.test.js` | create | Task 4 |
| `test/cost-digest-settings.test.js` | create | Task 5 |
| `test/cost-digest.test.js` | create | Tasks 6–7 |
| `test/cost-mcp.test.js` | create | Task 8 (ports 9800–9899) |
| `test/cost-rules.test.js`, `test/cost-api.test.js`, `test/cost-settings-ui.test.js` | modify | the settings shape, the nav order, the panel count |

---
### Task 1: the export (`lib/cost/export.js`, `GET /api/cost/export`, download headers)

**Files:**
- Create: `lib/cost/export.js`
- Modify: `lib/cost/api.js` (requires at 12, `reply` at 29, after `ledgerQuery` at 147, the GET table at 353)
- Modify: `server.js` (`send` at 992–995; the cost route branch at 1309–1319)
- Test: `test/cost-export.test.js`, `test/cost-export-api.test.js`, `test/cost-reports-http.test.js` (create)

**Interfaces:**
- Consumes: `cost.ledger({ from, to, groupBy, currency })` → `{ from, to, groupBy, currency, rows, totals, missingRate,
  corrections, unread, billing }` (`lib/cost/index.js:595`); a group row has the `groupBy` dimensions, `requests`,
  `tokens { in, out, cacheRead, cacheWrite5m, cacheWrite1h }`, `listUSD`, `billedUSD` and, with a currency, `list`,
  `billed` (`lib/cost/ledger.js` `groupRows`); `ledgerQuery(q)` → `{ from, to, groupBy, currency }` (`currency`
  null for USD).
- Produces:
  - `lib/cost/export.js`: `MAX_ROWS` (100000), `TOO_MANY`, `COLUMNS`, `columnsOf(groupBy, currency)`,
    `exportRows(led, { measure })`, `totalsOf(rows, currency)`, `checkSize(rows, max = MAX_ROWS)` (throws
    `status: 413`), `csvCell(v, { amount })`, `toCsv({ groupBy, currency, rows, unread })`,
    `toJson({ from, to, groupBy, currency, measure, rows, unread })`, `fileName(from, to, ext)`.
  - A route answer may be `{ status, body, type, headers }`; `server.js` `send(res, status, body, type, headers)`.
  - `GET /api/cost/export` (E1).

- [ ] **Step 1: Write the failing tests**

Create `test/cost-export.test.js`:

```js
// Cost Control 5: lib/cost/export.js, the ledger grouping as CSV or JSON. Pure: a grouped ledger answer in, text out.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../lib/cost/export');

const tokens = (i, o, cr = 0, w5 = 0, w1 = 0) => ({ in: i, out: o, cacheRead: cr, cacheWrite5m: w5, cacheWrite1h: w1 });
const LED = {
  from: '2026-10-01',
  to: '2026-10-29',
  groupBy: ['model', 'project'],
  currency: 'USD',
  rows: [
    { model: 'opus', project: '~/acme', requests: 3, tokens: tokens(100, 20, 5, 2, 1), listUSD: 1.5, billedUSD: 0 },
    { model: 'sonnet', project: null, requests: 2, tokens: tokens(10, 2), listUSD: 0.12345678912, billedUSD: 0.1 },
    { model: null, project: null, requests: 0, tokens: tokens(0, 0), listUSD: 0, billedUSD: 6.4516129 }, // a plan fee
  ],
  unread: [],
};

test('export rows: the groupBy dimensions, then the counts and the USD amounts; a plan fee only under paid', () => {
  assert.deepEqual(X.columnsOf(['model'], 'USD'), ['model', ...X.COLUMNS]);
  assert.deepEqual(X.columnsOf(['day'], 'IDR').slice(-2), ['listIDR', 'billedIDR']);
  const list = X.exportRows(LED, { measure: 'list' });
  assert.equal(list.length, 2, 'the plan fee row has no usage value');
  assert.deepEqual(list[0], {
    model: 'opus',
    project: '~/acme',
    requests: 3,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    listUSD: 1.5,
    billedUSD: 0,
  });
  assert.equal(X.exportRows(LED, { measure: 'billed' }).length, 3);
  const idr = X.exportRows(
    { ...LED, currency: 'IDR', rows: [{ ...LED.rows[0], list: 24375, billed: null }] },
    { measure: 'list' },
  );
  assert.deepEqual([idr[0].listIDR, idr[0].billedIDR], [24375, null]);
  const t = X.totalsOf(X.exportRows(LED, { measure: 'billed' }), 'USD');
  assert.deepEqual([t.requests, t.inputTokens, t.cacheWriteTokens], [5, 110, 3]);
  assert.equal(t.listUSD, 1.62345679);
  assert.equal(t.billedUSD, 6.5516129);
  const ti = X.totalsOf(idr, 'IDR');
  assert.deepEqual([ti.listIDR, ti.billedIDR], [24375, null], 'a day without a rate makes that total null');
});

test('csv: RFC 4180 with CRLF, quotes doubled, formula cells prefixed, plain numbers', () => {
  assert.equal(X.csvCell('plain'), 'plain');
  assert.equal(X.csvCell('a,b'), '"a,b"');
  assert.equal(X.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(X.csvCell('two\nlines'), '"two\nlines"');
  for (const bad of ['=SUM(A1)', '+1', '-2+3', '@cmd', '\tx', '\rx'])
    assert.equal(X.csvCell(bad).replace(/^"/, '')[0], "'", JSON.stringify(bad));
  assert.equal(X.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"', 'prefixed, then quoted');
  assert.equal(X.csvCell(null), '');
  assert.equal(X.csvCell(12), '12');
  assert.equal(X.csvCell(0.1, { amount: true }), '0.10000000');
  assert.equal(X.csvCell(1234567.5, { amount: true }), '1234567.50000000', 'no thousands separator');
  assert.equal(X.csvCell(-0.5, { amount: true }), '-0.50000000', 'a number is never prefixed');
  const rows = X.exportRows(LED, { measure: 'list' });
  const text = X.toCsv({ groupBy: LED.groupBy, currency: 'USD', rows, unread: [] });
  const lines = text.split('\r\n');
  assert.equal(lines.pop(), '', 'every line ends with CRLF');
  assert.equal(lines.length, 3);
  assert.equal(
    lines[0],
    'model,project,requests,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,listUSD,billedUSD',
  );
  assert.equal(lines[1], 'opus,~/acme,3,100,20,5,3,1.50000000,0.00000000');
  assert.equal(lines[2], 'sonnet,,2,10,2,0,0,0.12345679,0.10000000');
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /[\r\n]/, 'no bare line end');
});

test('csv: the display currency adds two columns, and an unread month is a last comment line', () => {
  const led = { ...LED, currency: 'IDR', rows: [{ ...LED.rows[0], list: 24375.5, billed: null }] };
  const text = X.toCsv({
    groupBy: led.groupBy,
    currency: 'IDR',
    rows: X.exportRows(led, { measure: 'list' }),
    unread: ['2026-09', 'corrections'],
  });
  const lines = text.split('\r\n');
  assert.match(lines[0], /,listUSD,billedUSD,listIDR,billedIDR$/);
  assert.match(lines[1], /,1\.50000000,0\.00000000,24375\.50000000,$/, 'no rate: an empty cell');
  assert.equal(lines[2], '# unread: 2026-09, corrections');
  const evil = X.toCsv({
    groupBy: ['project'],
    currency: 'USD',
    rows: X.exportRows({ groupBy: ['project'], rows: [{ project: '=cmd|"/c calc"!A1', requests: 1, listUSD: 1 }] }),
  });
  assert.equal(evil.split('\r\n')[1].split(',')[0], '"\'=cmd|""/c calc""!A1"');
});

test('json: the range, the grouping, the rows as the CSV has them, the totals and what did not read', () => {
  const rows = X.exportRows(LED, { measure: 'billed' });
  const j = X.toJson({
    from: LED.from,
    to: LED.to,
    groupBy: LED.groupBy,
    currency: 'USD',
    measure: 'billed',
    rows,
    unread: ['2026-09'],
  });
  assert.deepEqual(Object.keys(j), ['from', 'to', 'groupBy', 'currency', 'measure', 'rows', 'totals', 'unread']);
  assert.equal(j.rows.length, 3);
  assert.deepEqual(j.unread, ['2026-09']);
  assert.equal(j.totals.requests, 5);
  assert.equal(X.fileName('2026-10-01', '2026-10-29', 'csv'), 'zaafpulse-cost-2026-10-01-2026-10-29.csv');
});

test('size: more than 100,000 rows is a 413 that says what to do', () => {
  assert.equal(X.MAX_ROWS, 100000);
  X.checkSize(new Array(3), 3);
  assert.throws(
    () => X.checkSize(new Array(4), 3),
    (e) => e.status === 413 && e.message === 'too many rows; narrow the range or group by fewer dimensions',
  );
});
```

Create `test/cost-export-api.test.js`:

```js
// Cost Control 5: GET /api/cost/export, in-process on the demo ledger. The ledger's range, groupBy and currency rules,
// the view's measure, a download's type and name, the 413 cap and the 503 of a ledger that does not read; path-free.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { costDemo } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const NOW = new Date(2026, 9, 22, 15).getTime();
const TODAY = dayOf(NOW);

function setup({ cost: fake } = {}) {
  const d = costDemo(NOW);
  const cost =
    fake || createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => NOW, nocase: false });
  const api = createCostApi({ cost, settings: { get: () => d.settings, save: () => {} }, home: HOME, now: () => NOW });
  const bodies = [];
  const get = async (query) => {
    const r = await api.route({ method: 'GET', path: '/api/cost/export', query: new URLSearchParams(query) });
    bodies.push(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return r;
  };
  return { get, bodies, cost };
}

test('export: CSV by default, as a download named by its range, the rows of the ledger grouping', async () => {
  const s = setup();
  const from = addDays(TODAY, -6);
  const r = await s.get(`from=${from}&to=${TODAY}&groupBy=model,center`);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'text/csv; charset=utf-8');
  assert.deepEqual(r.headers, {
    'Content-Disposition': `attachment; filename="zaafpulse-cost-${from}-${TODAY}.csv"`,
  });
  const lines = r.body.split('\r\n');
  assert.equal(
    lines[0],
    'model,center,requests,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,listUSD,billedUSD',
  );
  const led = s.cost.ledger({ from, to: TODAY, groupBy: ['model', 'center'] });
  const usage = led.rows.filter((x) => x.requests || x.listUSD);
  assert.equal(lines.length - 2, usage.length, 'one line per row with usage, then the final CRLF');
  assert.ok(!r.body.includes('# unread'));
  for (const l of lines.slice(1, -1)) assert.match(l, /,\d+\.\d{8},\d+\.\d{8}$/);
});

test('export: JSON with the totals, paid keeps the plan fee rows, and a display currency adds its columns', async () => {
  const s = setup();
  const r = await s.get('format=json&groupBy=source,kind&measure=billed&currency=IDR');
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/json');
  assert.match(r.headers['Content-Disposition'], /filename="zaafpulse-cost-2026-10-01-2026-10-22\.json"$/);
  const j = r.body;
  assert.deepEqual(
    [j.from, j.to, j.groupBy, j.currency, j.measure],
    ['2026-10-01', TODAY, ['source', 'kind'], 'IDR', 'billed'],
  );
  const led = s.cost.ledger({ from: '2026-10-01', to: TODAY, groupBy: ['source', 'kind'] });
  assert.equal(j.rows.length, led.rows.length);
  const fee = j.rows.find((x) => x.source === 'claude' && x.kind === 'plan');
  assert.ok(fee && fee.requests === 0 && fee.billedUSD > 0, 'the Claude plan fee');
  assert.ok(j.rows.every((x) => 'listIDR' in x && 'billedIDR' in x));
  assert.ok(Math.abs(j.totals.billedUSD - led.totals.billedUSD) < 1e-6);
  assert.deepEqual(j.unread, []);
  const list = await s.get('format=json&groupBy=source,kind');
  assert.ok(!list.body.rows.some((x) => x.kind === 'plan'), 'usage value leaves the fee rows out');
});

test('export: the ledger and view rules give the same 400s; every error is path-free', async () => {
  const s = setup();
  const bad = [
    ['format=xlsx', 'format: csv or json'],
    ['measure=both', 'measure: list or billed'],
    ['groupBy=colour', 'groupBy: unknown dimension colour'],
    ['groupBy=day,source,provider,model,project', /groupBy: 1 to 4/],
    ['from=2026-10-09&to=2026-10-02', 'from must be on or before to'],
    ['from=2025-01-01&to=2026-10-22', 'at most 400 days at a time'],
    ['to=2026-02-30', 'from and to are dates (YYYY-MM-DD)'],
    ['currency=EUR', 'no rates for that currency; set it in the cost settings'],
  ];
  for (const [q, msg] of bad) {
    const r = await s.get(q);
    assert.equal(r.status, 400, q);
    if (typeof msg === 'string') assert.equal(r.body.error, msg, q);
    else assert.match(r.body.error, msg, q);
  }
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('export: over 100,000 rows is a 413; a ledger that does not read is a 503 with its code; unread months', async () => {
  const many = Array.from({ length: 100001 }, (_, i) => ({ model: `m${i}`, requests: 1, tokens: {}, listUSD: 1 }));
  const big = setup({
    cost: { ledger: (q) => ({ ...q, currency: 'USD', rows: many, totals: {}, unread: [] }) },
  });
  const r = await big.get('groupBy=model');
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'too many rows; narrow the range or group by fewer dimensions');
  const down = setup({
    cost: {
      ledger: () => {
        throw Object.assign(new Error(`ledger month 2026-10 could not be read at ${HOME}/x`), {
          code: 'LEDGER_MONTH_UNREAD',
        });
      },
    },
  });
  const d = await down.get('groupBy=model');
  assert.equal(d.status, 503);
  assert.equal(d.body.code, 'LEDGER_MONTH_UNREAD');
  assert.doesNotMatch(JSON.stringify(d.body), PATHS);
  const part = setup({
    cost: {
      ledger: (q) => ({
        ...q,
        currency: 'USD',
        rows: [{ model: 'm', requests: 1, tokens: {}, listUSD: 1, billedUSD: 1 }],
        unread: ['2026-09'],
      }),
    },
  });
  const csv = await part.get('from=2026-09-20&to=2026-10-02&groupBy=model');
  assert.match(csv.body, /\r\n# unread: 2026-09\r\n$/);
  assert.deepEqual((await part.get('format=json&from=2026-09-20&to=2026-10-02&groupBy=model')).body.unread, [
    '2026-09',
  ]);
});
```

Create `test/cost-reports-http.test.js` (Task 2 adds the report to it):

```js
// Cost Control 5 over HTTP: a spawned server.js sends the export as a download (its type, name and no-store, beside the
// security headers) and the report, on the dashboard sign-in only: never without it, never with a gateway API key.
// Demo mode reads no logs and makes no calls. Ports 9900-9999 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway } = require('../lib/gateway');
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const PASSWORD = 'correct-horse-battery';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-reports-http-'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 9900 + Math.floor(Math.random() * 100);
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
const get = (base, p, headers = {}) => fetch(base + p, { signal: AbortSignal.timeout(10000), headers });

test('demo over HTTP: the export downloads as CSV and as JSON, no-store, with the security headers', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  try {
    const r = await get(s.base, '/api/cost/export?from=2026-10-01&to=2026-10-02&groupBy=model');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(
      r.headers.get('content-disposition'),
      'attachment; filename="zaafpulse-cost-2026-10-01-2026-10-02.csv"',
    );
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const text = await r.text();
    assert.match(text, /^model,requests,inputTokens,/);
    const j = await get(s.base, '/api/cost/export?format=json&groupBy=center');
    assert.equal(j.status, 200);
    assert.match(j.headers.get('content-disposition'), /\.json"$/);
    const body = await j.json();
    assert.ok(body.rows.length > 0, 'the demo ledger');
    assert.doesNotMatch(JSON.stringify(body), PATHS);
    const bad = await get(s.base, '/api/cost/export?format=xlsx');
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('content-disposition'), null, 'an error is not a download');
  } finally {
    await s.stop();
  }
});

test('over HTTP: the export and the report answer the dashboard sign-in only, never a gateway key', async () => {
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
    const routes = ['/api/cost/export', '/api/cost/export?format=json'];
    for (const p of routes) {
      assert.equal((await get(s.base, p)).status, 401, p);
      const bearer = { authorization: `Bearer ${secret}`, 'x-api-key': secret };
      assert.equal((await get(s.base, p, bearer)).status, 401, `${p} with a key`);
    }
    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const r = await get(s.base, '/api/cost/export', { cookie });
    assert.equal(r.status, 200);
    assert.equal(
      await r.text(),
      'day,requests,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,listUSD,billedUSD\r\n',
      'an empty ledger: the header row only',
    );
  } finally {
    await s.stop();
  }
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/cost-export.test.js test/cost-export-api.test.js test/cost-reports-http.test.js`
Expected: FAIL (`Cannot find module '../lib/cost/export'`; the route answers 404 `unknown route`).

- [ ] **Step 3: Create `lib/cost/export.js`**

```js
// Cost Control 5: the ledger grouping as a file to download (GET /api/cost/export). Pure: the grouped answer of
// cost.ledger() in, CSV text or a JSON object out. Rows hold dimension values and numbers only, as the ledger does.
// CSV is RFC 4180 (comma, CRLF, quotes doubled), and a text cell a spreadsheet would run as a formula gets a leading '.
const MAX_ROWS = 100000;
const TOO_MANY = 'too many rows; narrow the range or group by fewer dimensions';
const COLUMNS = [
  'requests',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'listUSD',
  'billedUSD',
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;

// The columns of an export: the groupBy dimensions, the counts and USD amounts, and the display currency's two amounts.
const columnsOf = (groupBy, currency) => [
  ...groupBy,
  ...COLUMNS,
  ...(currency && currency !== 'USD' ? [`list${currency}`, `billed${currency}`] : []),
];

// One grouped ledger row as an export row. `measure` decides which rows are kept, as the Breakdown table does: under
// usage value (list) a plan fee row (no requests, no usage value) is left out; under paid (billed) every row stays.
function exportRows(led, { measure = 'list' } = {}) {
  const groupBy = led.groupBy || [];
  const cur = led.currency && led.currency !== 'USD' ? led.currency : null;
  const out = [];
  for (const r of led.rows || []) {
    if (measure === 'list' && !num(r.requests) && !num(r.listUSD)) continue;
    const t = r.tokens || {};
    const row = {};
    for (const d of groupBy) row[d] = r[d] ?? null;
    row.requests = num(r.requests);
    row.inputTokens = num(t.in);
    row.outputTokens = num(t.out);
    row.cacheReadTokens = num(t.cacheRead);
    row.cacheWriteTokens = num(t.cacheWrite5m) + num(t.cacheWrite1h);
    row.listUSD = num(r.listUSD);
    row.billedUSD = num(r.billedUSD);
    if (cur) {
      row[`list${cur}`] = r.list ?? null;
      row[`billed${cur}`] = r.billed ?? null;
    }
    out.push(row);
  }
  return out;
}

// The sums of the rows kept. A currency amount is null when any row's is (a day without a rate), as the ledger's.
function totalsOf(rows, currency) {
  const cur = currency && currency !== 'USD' ? currency : null;
  const t = Object.fromEntries(COLUMNS.map((c) => [c, 0]));
  if (cur) Object.assign(t, { [`list${cur}`]: 0, [`billed${cur}`]: 0 });
  for (const r of rows) {
    for (const c of COLUMNS) t[c] += num(r[c]);
    if (!cur) continue;
    for (const c of [`list${cur}`, `billed${cur}`]) t[c] = t[c] === null || r[c] === null ? null : t[c] + num(r[c]);
  }
  for (const c of ['listUSD', 'billedUSD']) t[c] = round8(t[c]);
  if (cur) for (const c of [`list${cur}`, `billed${cur}`]) if (t[c] !== null) t[c] = Math.round(t[c] * 1e4) / 1e4;
  return t;
}

// More rows than a download may hold: 413, before anything is encoded.
function checkSize(rows, max = MAX_ROWS) {
  if (rows.length > max) throw Object.assign(new Error(TOO_MANY), { status: 413 });
}

// A CSV cell. Text that starts with = + - @, a tab or a CR is prefixed with ' (CSV injection); a cell holding a comma,
// a quote, a CR or an LF is quoted, its quotes doubled. Numbers are plain: integers as they are, amounts to 8 decimals.
function csvCell(v, { amount = false } = {}) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? (amount ? v.toFixed(8) : String(v)) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvLine = (cells) => cells.join(',') + '\r\n';
const isAmount = (c) => /^(list|billed)/.test(c);

// The CSV text: a header row, one line per row, and `# unread: …` last when a month (or the corrections) did not read.
function toCsv({ groupBy, currency, rows, unread = [] }) {
  const cols = columnsOf(groupBy, currency);
  let text = csvLine(cols.map((c) => csvCell(c)));
  for (const r of rows)
    text += csvLine(cols.map((c) => (groupBy.includes(c) ? csvCell(r[c]) : csvCell(r[c], { amount: isAmount(c) }))));
  // A comment line, not a record: month ids and fixed names only, so it needs no quoting.
  if (unread.length) text += `# unread: ${unread.join(', ')}\r\n`;
  return text;
}

// The JSON answer: what the CSV holds, with the totals and the range it covers.
function toJson({ from, to, groupBy, currency, measure, rows, unread = [] }) {
  return { from, to, groupBy, currency, measure, rows, totals: totalsOf(rows, currency), unread: [...unread] };
}

// "zaafpulse-cost-2026-10-01-2026-10-29.csv": the days are checked dates, so the name needs no escaping.
const fileName = (from, to, ext) => `zaafpulse-cost-${from}-${to}.${ext}`;

module.exports = {
  MAX_ROWS,
  TOO_MANY,
  COLUMNS,
  columnsOf,
  exportRows,
  totalsOf,
  checkSize,
  csvCell,
  toCsv,
  toJson,
  fileName,
};
```

- [ ] **Step 4: The route in `lib/cost/api.js`**

After `const { recommend, spendByModel } = require('./recommend');` add:

```js
const X = require('./export');
```

After `const reply = (status, body) => ({ status, body });` add:

```js
// A file to download: server.js sends `type` and `headers` (Cache-Control: no-store is on every answer already).
const download = (body, type, name) => ({
  status: 200,
  body,
  type,
  headers: { 'Content-Disposition': `attachment; filename="${name}"` },
});
```

After the closing `}` of `function ledgerQuery(q) { … }` (before the comment `// GET /api/cost/view: what one Cost
Control page draws`) add:

```js
  // GET /api/cost/export (Cost Control 5): the ledger grouping as CSV or JSON. The range, groupBy and currency rules are
  // the ledger's and `measure` the view's; at most 100,000 rows (413 beyond).
  function exportOf(q) {
    const format = q.get('format') || 'csv';
    if (format !== 'csv' && format !== 'json') throw fail(400, 'format: csv or json');
    const measure = q.get('measure') || 'list';
    if (measure !== 'list' && measure !== 'billed') throw fail(400, 'measure: list or billed');
    const lq = ledgerQuery(q);
    const led = cost.ledger(lq);
    const rows = X.exportRows(led, { measure });
    X.checkSize(rows);
    const out = { ...lq, currency: lq.currency || 'USD', measure, rows, unread: [...(led.unread || [])] };
    if (format === 'json') return download(X.toJson(out), 'application/json', X.fileName(lq.from, lq.to, 'json'));
    return download(X.toCsv(out), 'text/csv; charset=utf-8', X.fileName(lq.from, lq.to, 'csv'));
  }

```

In the `GET` table, before `'/api/cost/status': () => reply(200, scrubAll(cost.status())),` add:

```js
    '/api/cost/export': (q) => exportOf(q),
```

(The route's `catch` already maps a `status` 400–599 error, so the 413 and the 400s need nothing more; an
`UNAVAILABLE` code is the 503.)

- [ ] **Step 5: Let `server.js` send a download**

Replace

```js
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
```

with

```js
// `headers` adds to an answer (a download's Content-Disposition); it never replaces a security header.
function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers, ...SECURITY_HEADERS });
```

In the cost route branch replace the comment line
`// The cost ledger: rows, status, settings, price versions and restate, behind the same sign-in. No path out.` with

```js
    // The cost ledger: rows, status, settings, price versions and restate, behind the same sign-in. No path out. An
    // export is a download: its own type and Content-Disposition.
```

and its `if (hit) return send(res, hit.status, hit.body);` (the one right after `costApi.route({ … })`) with

```js
      if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json', hit.headers);
```

(A JSON export is an object with type `application/json`, so `send` stringifies it; the CSV is a string.)

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/cost-export.test.js test/cost-export-api.test.js test/cost-reports-http.test.js test/cost-api.test.js test/cost-view-api.test.js`
Expected: PASS (11 new tests; the existing ones unchanged).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check lib/cost/export.js lib/cost/api.js test/cost-export.test.js test/cost-export-api.test.js test/cost-reports-http.test.js`
Expected: `All matched files use Prettier code style!` (`server.js` already differs on `b96b704`: check that your lines
look like their neighbours; do not `--write` it.)

- [ ] **Step 8: Commit**

```bash
git add lib/cost/export.js lib/cost/api.js server.js test/cost-export.test.js test/cost-export-api.test.js test/cost-reports-http.test.js
git commit -m "Cost export: the ledger grouping as a CSV or JSON download"
```

---
### Task 2: the showback report (`lib/cost/report.js`, `GET /api/cost/report`)

**Files:**
- Create: `lib/cost/report.js`
- Modify: `lib/cost/api.js` (the `./days` require at 5, requires after Task 1's `X`, constants at 24, before
  `function keys()` at ~250, the GET table)
- Modify: `test/cost-reports-http.test.js` (Task 1's file)
- Test: `test/cost-report.test.js`, `test/cost-report-api.test.js` (create)

**Interfaces:**
- Consumes: `cost.budgetRows({ from, to })` → `{ rows, unread, billingError, historyLost }` (`lib/cost/index.js:748`;
  rows billed, plan rows included, `billingAssumed` on lost days); `cost.firstDay()` (`index.js:816`, null when
  unknown); `cost.corrections()` (`index.js:722`, throws `LEDGER_CORRECTIONS_UNREAD`); `budgets.evaluate()` (views);
  `quietly`, `viewOut`, `keys()`, `checkCurrency`, `current()` inside `createCostApi`; `UNASSIGNED`, `rateFor`
  (`./rules`); `addDays`, `daysBetween`, `daysInMonth`, `monthOf` (`./days`).
- Produces (`lib/cost/report.js`): `TOP` (20), `OTHER`, `PLAN`, `NONE`, `monthRange(month, today) → { from, to }`,
  `reportMonths(today, firstDay, max = 120) → ['YYYY-MM', …]`, `defaultMonth(today, firstDay)`,
  `showback({ rows, month, today, center, centers, keyNames, budgets, corrections, unread, billingError, rateOf,
  currency, generatedAt }) → { month, from, to, center: { id, name }, currency, generatedAt, totals, tables:
  { source, model, key, project }, daily, budgets, notes }` (R2). `GET /api/cost/report` (R1) answers that plus
  `months` and `budgetsError`. Task 6 appends the digest figures to `report.js`.

- [ ] **Step 1: Write the failing tests**

Create `test/cost-report.test.js`:

```js
// Cost Control 5: lib/cost/report.js showback, one cost center's month for a client. Pure: ledger rows in, the
// report's totals, tables, daily spend, budgets and notes out.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/cost/report');

const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  project: null,
  center: 'acme',
  keyId: 'key_a',
  agent: null,
  kind: 'chat',
  requests: 2,
  tokens: { in: 100, out: 10, cacheRead: 5, cacheWrite5m: 1, cacheWrite1h: 2 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const plan = (day) => ({
  ...row(day),
  source: 'claude',
  model: null,
  center: null,
  keyId: null,
  kind: 'plan',
  requests: 0,
  tokens: {},
  listUSD: 0,
  billedUSD: 6.5,
});
const CENTERS = [
  { id: 'acme', name: 'Client: Acme' },
  { id: 'lab', name: 'Lab' },
];
const ROWS = [
  row('2026-09-03'),
  row('2026-09-03', {
    model: 'claude-sonnet-5-5',
    keyId: null,
    source: 'claude',
    project: '~/acme-web',
    listUSD: 2,
    billedUSD: 0,
  }),
  row('2026-09-10', { center: 'lab', listUSD: 4, billedUSD: 4 }),
  row('2026-09-12', { center: 'unassigned', keyId: 'key_b', listUSD: 0.5, billedUSD: 0.5 }),
  plan('2026-09-03'),
  row('2026-10-01', { listUSD: 100 }), // another month
];

test('months: the range of a month, the picker back to the first month, and the default month', () => {
  assert.deepEqual(R.monthRange('2026-09', '2026-10-29'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(R.monthRange('2026-10', '2026-10-29'), { from: '2026-10-01', to: '2026-10-29' });
  assert.deepEqual(R.monthRange('2024-02', '2026-10-29'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(R.reportMonths('2026-10-29', '2026-08-15'), ['2026-10', '2026-09', '2026-08']);
  assert.deepEqual(R.reportMonths('2026-01-05', '2025-11-30'), ['2026-01', '2025-12', '2025-11']);
  assert.deepEqual(R.reportMonths('2026-10-29', null), ['2026-10']);
  assert.equal(R.reportMonths('2026-10-29', '1990-01-01').length, 120, 'ten years at most');
  assert.equal(R.defaultMonth('2026-10-29', '2026-09-01'), '2026-09', 'all of last month is in the ledger');
  assert.equal(R.defaultMonth('2026-10-29', '2026-09-30'), '2026-10', 'the first days of the ledger');
  assert.equal(R.defaultMonth('2026-10-29', null), '2026-10');
  assert.equal(R.defaultMonth('2026-01-03', '2025-06-01'), '2025-12');
});

test('showback: one center in both measures, by source, model, key and project; plan fees only for all', () => {
  const r = R.showback({
    rows: ROWS,
    month: '2026-09',
    today: '2026-10-29',
    center: 'acme',
    centers: CENTERS,
    keyNames: new Map([['key_a', 'Acme app']]),
    generatedAt: 123,
  });
  assert.deepEqual(
    [r.month, r.from, r.to, r.center, r.currency, r.generatedAt],
    ['2026-09', '2026-09-01', '2026-09-30', { id: 'acme', name: 'Client: Acme' }, 'USD', 123],
  );
  assert.deepEqual(r.totals, {
    requests: 4,
    tokens: { input: 200, output: 20, cacheRead: 10, cacheWrite: 6 },
    listUSD: 3,
    billedUSD: 1,
  });
  assert.deepEqual(
    r.tables.source.map((x) => [x.key, x.listUSD, x.billedUSD]),
    [
      ['claude', 2, 0],
      ['gateway', 1, 1],
    ],
  );
  assert.deepEqual(
    r.tables.key.map((x) => [x.key, x.name]),
    [
      ['__none', null],
      ['key_a', 'Acme app'],
    ],
  );
  assert.deepEqual(
    r.tables.project.map((x) => x.key),
    ['~/acme-web', '__none'],
  );
  assert.equal(r.tables.model[0].tokens, 118, 'every token kind counts');
  assert.equal(r.daily.length, 30);
  assert.deepEqual(r.daily[2], { day: '2026-09-03', listUSD: 3, billedUSD: 1 });
  assert.equal(r.budgets, null, 'a past month');

  const all = R.showback({ rows: ROWS, month: '2026-09', today: '2026-10-29', center: '__all', centers: CENTERS });
  assert.equal(all.center.name, 'All centers');
  assert.equal(all.totals.listUSD, 7.5);
  assert.equal(all.totals.billedUSD, 12, 'the plan fee is paid by all centers');
  assert.ok(all.tables.model.some((x) => x.key === '__plan' && x.billedUSD === 6.5));
  assert.ok(
    all.tables.source.some((x) => x.key === 'claude' && x.billedUSD === 6.5),
    'the fee under its source',
  );

  const none = R.showback({
    rows: ROWS,
    month: '2026-09',
    today: '2026-10-29',
    center: 'unassigned',
    centers: CENTERS,
  });
  assert.deepEqual([none.center.name, none.totals.listUSD, none.tables.key[0].key], ['Unassigned', 0.5, 'key_b']);
});

test('showback: 20 rows per table, then Other with how many it holds', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    row('2026-09-05', { model: `m-${String(i).padStart(2, '0')}`, listUSD: 25 - i, billedUSD: 1 }),
  );
  const r = R.showback({ rows: many, month: '2026-09', today: '2026-10-29', center: 'acme', centers: CENTERS });
  assert.equal(r.tables.model.length, 21);
  assert.equal(r.tables.model[0].key, 'm-00');
  const other = r.tables.model[20];
  assert.deepEqual([other.key, other.count, other.listUSD, other.billedUSD, other.requests], ['__other', 5, 15, 5, 10]);
});

test('showback: the budgets of the center (every one for all), and the notes', () => {
  const view = (id, scope, over = {}) => ({
    id,
    name: id,
    scope,
    period: 'month',
    from: '2026-10-01',
    to: '2026-10-31',
    amount: 100,
    currency: 'USD',
    measure: 'list',
    enforce: 'block',
    state: 'warn_80',
    projected: true,
    percent: 84.5,
    spent: 84.5,
    reason: null,
    ...over,
  });
  const budgets = [
    view('acme', { dim: 'center', value: 'acme' }),
    view('global', 'global'),
    view('opus', { dim: 'model', value: 'x' }),
  ];
  const rows = [row('2026-10-02', { billingAssumed: true }), row('2026-10-05')];
  const corrections = [
    { ts: 5, from: '2026-10-03', to: '2026-10-04', reason: 'new prices', rows: 3 },
    { ts: 4, from: '2026-08-01', to: '2026-08-31', reason: 'old', rows: 1 },
  ];
  const r = R.showback({
    rows,
    month: '2026-10',
    today: '2026-10-29',
    center: 'acme',
    centers: CENTERS,
    budgets,
    corrections,
    unread: ['corrections'],
    billingError: 'the billing history could not be read',
  });
  assert.equal(r.to, '2026-10-29', 'the current month up to today');
  assert.deepEqual(
    r.budgets.map((b) => [b.id, b.state, b.percent]),
    [['acme', 'warn_80', 84.5]],
  );
  assert.ok(!('enforce' in r.budgets[0]));
  const all = R.showback({ rows, month: '2026-10', today: '2026-10-29', center: '__all', budgets });
  assert.equal(all.budgets.length, 3);
  assert.deepEqual(r.notes, {
    unread: ['corrections'],
    assumed: ['2026-10-02'],
    billingError: 'the billing history could not be read',
    corrections: [{ ts: 5, from: '2026-10-03', to: '2026-10-04', reason: 'new prices' }],
  });
  assert.equal(R.showback({ rows, month: '2026-10', today: '2026-10-29', corrections: null }).notes.corrections, null);
});

test('showback: the display currency per day, null once a day has no rate', () => {
  const rateOf = (day) => (day >= '2026-09-10' ? 16000 : null);
  const r = R.showback({
    rows: ROWS,
    month: '2026-09',
    today: '2026-10-29',
    center: 'lab',
    centers: CENTERS,
    rateOf,
    currency: 'IDR',
  });
  assert.deepEqual([r.totals.list, r.totals.billed], [64000, 64000]);
  assert.deepEqual(r.daily[9], { day: '2026-09-10', listUSD: 4, billedUSD: 4, list: 64000, billed: 64000 });
  const acme = R.showback({
    rows: ROWS,
    month: '2026-09',
    today: '2026-10-29',
    center: 'acme',
    rateOf,
    currency: 'IDR',
  });
  assert.deepEqual([acme.totals.list, acme.tables.source[0].list], [null, null], 'the 3rd has no rate');
});
```

Create `test/cost-report-api.test.js`:

```js
// Cost Control 5: GET /api/cost/report, in-process on the demo ledger: the default month, one center, all centers and
// Unassigned, the budgets of the current month, the display currency, the 400s and the 503; path-free.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { createBudgetService } = require('../lib/cost/budget-service');
const { costDemo } = require('../lib/demo');
const { dayOf } = require('../lib/cost/days');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const NOW = new Date(2026, 9, 22, 15).getTime(); // the demo ledger starts 29 days before: 23 September
const TODAY = dayOf(NOW);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);

function setup({ cost: fake } = {}) {
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
  const api = createCostApi({
    cost,
    settings: { get: () => d.settings, save: () => {} },
    listKeys: () => [{ id: 'key_demo0acme01', name: 'Acme client' }],
    home: HOME,
    now: () => NOW,
    budgets,
  });
  const bodies = [];
  const get = async (query) => {
    const r = await api.route({ method: 'GET', path: '/api/cost/report', query: new URLSearchParams(query) });
    bodies.push(JSON.stringify(r.body));
    return r;
  };
  return { get, bodies, cost };
}

test('report: this month by default while the ledger lacks part of last month; all centers; the months', async () => {
  const s = setup();
  const r = await s.get('');
  assert.equal(r.status, 200);
  const b = r.body;
  assert.deepEqual(
    [b.month, b.from, b.to, b.center, b.currency],
    ['2026-10', '2026-10-01', TODAY, { id: '__all', name: 'All centers' }, 'USD'],
  );
  assert.deepEqual(b.months, ['2026-10', '2026-09']);
  assert.equal(b.generatedAt, NOW);
  const led = s.cost.ledger({ from: '2026-10-01', to: TODAY, groupBy: ['day'] });
  near(b.totals.listUSD, led.totals.listUSD);
  near(b.totals.billedUSD, led.totals.billedUSD);
  assert.equal(b.daily.length, 22);
  for (const t of ['source', 'model', 'key', 'project']) assert.ok(b.tables[t].length > 0, t);
  assert.deepEqual(
    b.budgets.map((x) => x.id).sort(),
    ['acme-gateway', 'legacy-monthly', 'research-week', 'team'],
    'every budget for all centers',
  );
  assert.equal(b.budgetsError, null);
  assert.deepEqual(b.notes.unread, []);
  assert.deepEqual(b.notes.corrections, []);
});

test('report: one center, Unassigned, a past month without budget states, and the display currency', async () => {
  const s = setup();
  const acme = (await s.get('month=2026-10&center=client-acme')).body;
  assert.deepEqual(acme.center, { id: 'client-acme', name: 'Client: Acme' });
  const byCenter = s.cost.ledger({ from: '2026-10-01', to: TODAY, groupBy: ['center'] });
  near(acme.totals.listUSD, byCenter.rows.find((x) => x.center === 'client-acme').listUSD);
  assert.ok(
    acme.tables.key.some((k) => k.name === 'Acme client'),
    'keys by their names',
  );
  assert.deepEqual(acme.budgets, [], 'no budget is scoped to the Acme center');
  const research = (await s.get('center=research')).body;
  assert.deepEqual(
    research.budgets.map((x) => x.id),
    ['research-week'],
  );
  const none = await s.get('center=unassigned');
  assert.equal(none.status, 200);
  assert.equal(none.body.center.name, 'Unassigned');
  const sep = (await s.get('month=2026-09')).body;
  assert.deepEqual([sep.from, sep.to, sep.budgets], ['2026-09-01', '2026-09-30', null]);
  assert.equal(sep.daily.length, 30);
  const idr = (await s.get('currency=IDR')).body;
  assert.equal(idr.currency, 'IDR');
  assert.ok(idr.totals.list > idr.totals.listUSD * 16000);
  for (const body of s.bodies) assert.doesNotMatch(body, PATHS);
});

test('report: 400 for a bad or future month, an unknown center or currency; 503 for a ledger that does not read', async () => {
  const s = setup();
  for (const [q, msg] of [
    ['month=2026-13', 'month: YYYY-MM'],
    ['month=26-10', 'month: YYYY-MM'],
    ['month=2026-11', 'month: this month or earlier'],
    ['center=nobody', 'unknown center'],
    ['currency=EUR', 'no rates for that currency; set it in the cost settings'],
  ]) {
    const r = await s.get(q);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.error, msg, q);
  }
  const down = setup({
    cost: {
      firstDay: () => null,
      corrections: () => [],
      budgetRows: () => ({ rows: [], unread: ['folder'], billingError: null }),
    },
  });
  const d = await down.get('');
  assert.equal(d.status, 503);
  assert.deepEqual(d.body, { error: 'the ledger folder could not be read', code: 'LEDGER_MONTH_UNREAD' });
  const part = setup({
    cost: {
      firstDay: () => '2026-08-20',
      corrections: () => {
        throw Object.assign(new Error('the ledger corrections could not be read'), {
          code: 'LEDGER_CORRECTIONS_UNREAD',
        });
      },
      budgetRows: () => ({ rows: [], unread: ['2026-09', 'corrections'], billingError: null }),
    },
  });
  const p = await part.get('');
  assert.equal(p.status, 200);
  assert.equal(p.body.month, '2026-09', 'all of last month is in the ledger');
  assert.deepEqual(p.body.notes.unread, ['2026-09', 'corrections']);
  assert.equal(p.body.notes.corrections, null);
  for (const body of [...s.bodies, ...down.bodies]) assert.doesNotMatch(body, PATHS);
});
```

In `test/cost-reports-http.test.js`, after the three lines

```js
    const bad = await get(s.base, '/api/cost/export?format=xlsx');
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('content-disposition'), null, 'an error is not a download');
```

add

```js
    const rep = await get(s.base, '/api/cost/report?center=client-acme');
    assert.equal(rep.status, 200);
    assert.equal(rep.headers.get('content-type'), 'application/json');
    const report = await rep.json();
    assert.deepEqual(report.center, { id: 'client-acme', name: 'Client: Acme' });
    assert.ok(report.totals.listUSD > 0 && report.tables.model.length > 0);
    assert.doesNotMatch(JSON.stringify(report), PATHS);
    assert.equal((await get(s.base, '/api/cost/report?center=nobody')).status, 400);
```

replace `const routes = ['/api/cost/export', '/api/cost/export?format=json'];` with

```js
    const routes = ['/api/cost/export', '/api/cost/export?format=json', '/api/cost/report'];
```

and after the `'an empty ledger: the header row only',` assertion's closing `);` add

```js
    const rep = await get(s.base, '/api/cost/report', { cookie });
    assert.equal(rep.status, 200);
    assert.equal((await rep.json()).totals.listUSD, 0);
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/cost-report.test.js test/cost-report-api.test.js test/cost-reports-http.test.js`
Expected: FAIL (`Cannot find module '../lib/cost/report'`; the route answers 404).

- [ ] **Step 3: Create `lib/cost/report.js`**

```js
// Cost Control 5: the figures that leave the dashboard. showback() is one cost center's month for a client (the
// Reports page, GET /api/cost/report). Pure: ledger rows in (cost.budgetRows, plan rows included), numbers and names
// out; no I/O and no clock (`today` is an argument).
const { addDays, daysBetween, daysInMonth, monthOf } = require('./days');
const { UNASSIGNED } = require('./rules');

const TOP = 20; // rows per table, then "Other"
const MAX_MONTHS = 120; // the month picker reaches back at most ten years
const OTHER = '__other';
const PLAN = '__plan';
const NONE = '__none';
const TABLES = { source: 'source', model: 'model', key: 'keyId', project: 'project' };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;
const round4 = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const tokenSum = (t) =>
  num(t && t.in) + num(t && t.out) + num(t && t.cacheRead) + num(t && t.cacheWrite5m) + num(t && t.cacheWrite1h);

// 'YYYY-MM' of the month before.
const prevMonth = (month) => monthOf(addDays(`${month}-01`, -1));

/** The days a month's report covers: the whole month, or up to today in the current one. */
function monthRange(month, today) {
  const from = `${month}-01`;
  const end = `${month}-${String(daysInMonth(from)).padStart(2, '0')}`;
  return { from, to: month === monthOf(today) && today < end ? today : end };
}

/** The months the picker offers: this month back to the ledger's first month (this month alone without one). */
function reportMonths(today, firstDay, max = MAX_MONTHS) {
  const out = [monthOf(today)];
  const stop = typeof firstDay === 'string' ? monthOf(firstDay) : out[0];
  while (out.length < max && out[out.length - 1] > stop) out.push(prevMonth(out[out.length - 1]));
  return out;
}

/** Last month, or this month while the ledger does not hold all of last month (its first day is later than the 1st). */
function defaultMonth(today, firstDay) {
  const last = prevMonth(monthOf(today));
  return typeof firstDay === 'string' && firstDay <= `${last}-01` ? last : monthOf(today);
}

// Sums of usage value and paid (and the display currency, with `rateOf`; null once a day has no rate).
function sums(rateOf) {
  return { requests: 0, tokens: 0, listUSD: 0, billedUSD: 0, ...(rateOf ? { list: 0, billed: 0 } : {}) };
}
function addTo(s, r, rateOf) {
  s.requests += num(r.requests);
  s.tokens += tokenSum(r.tokens);
  s.listUSD += num(r.listUSD);
  s.billedUSD += num(r.billedUSD);
  if (!rateOf) return;
  const rate = rateOf(r.day);
  if (rate == null) s.list = s.billed = null;
  else if (s.list !== null) {
    s.list += num(r.listUSD) * rate;
    s.billed += num(r.billedUSD) * rate;
  }
}
const money = (s) => ({
  ...s,
  listUSD: round8(s.listUSD),
  billedUSD: round8(s.billedUSD),
  ...('list' in s ? { list: round4(s.list), billed: round4(s.billed) } : {}),
});

// A row's key in a table: a plan fee has no model, key or project; a usage row without one is "Unknown".
const keyOf = (r, field) =>
  field !== 'source' && r.kind === 'plan' ? PLAN : r[field] == null ? NONE : String(r[field]);

// One table: the top 20 by usage value (then paid, then key), the rest summed as Other with how many it holds.
function tableOf(rows, field, rateOf, nameOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r, field);
    if (!groups.has(k)) groups.set(k, sums(rateOf));
    addTo(groups.get(k), r, rateOf);
  }
  const all = [...groups.entries()]
    .map(([key, s]) => ({ key, ...(nameOf ? { name: nameOf(key) } : {}), ...money(s) }))
    .sort((a, b) => b.listUSD - a.listUSD || b.billedUSD - a.billedUSD || cmp(a.key, b.key));
  if (all.length <= TOP) return all;
  const rest = sums(rateOf);
  for (const x of all.slice(TOP)) {
    rest.requests += x.requests;
    rest.tokens += x.tokens;
    rest.listUSD += x.listUSD;
    rest.billedUSD += x.billedUSD;
    if (rateOf) {
      rest.list = rest.list === null || x.list === null ? null : rest.list + x.list;
      rest.billed = rest.billed === null || x.billed === null ? null : rest.billed + x.billed;
    }
  }
  return [...all.slice(0, TOP), { key: OTHER, count: all.length - TOP, ...money(rest) }];
}

/**
 * One cost center's month: `center` is a center id, '__all' or 'unassigned'. `rows` are cost.budgetRows of the month
 * (plan rows included: they belong to All centers only, as a plan fee has no center). `budgets` are the evaluated
 * views (null for a past month: their state is the current period's), `corrections` the restates (null when they did
 * not read), `unread` and `billingError` what the read left out. `keyNames` maps a key id to its name.
 */
function showback({
  rows = [],
  month,
  today,
  center = '__all',
  centers = [],
  keyNames = new Map(),
  budgets = null,
  corrections = [],
  unread = [],
  billingError = null,
  rateOf = null,
  currency = 'USD',
  generatedAt = null,
}) {
  const { from, to } = monthRange(month, today);
  const named = centers.find((c) => c.id === center);
  const name = center === '__all' ? 'All centers' : center === UNASSIGNED ? 'Unassigned' : named ? named.name : center;
  const mine = (rows || []).filter(
    (r) =>
      r &&
      r.day >= from &&
      r.day <= to &&
      (center === '__all' || (r.kind !== 'plan' && (r.center || UNASSIGNED) === center)),
  );
  const totals = sums(rateOf);
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const perDay = new Map(daysBetween(from, to).map((d) => [d, sums(rateOf)]));
  const assumed = new Set();
  for (const r of mine) {
    addTo(totals, r, rateOf);
    const t = r.tokens || {};
    tokens.input += num(t.in);
    tokens.output += num(t.out);
    tokens.cacheRead += num(t.cacheRead);
    tokens.cacheWrite += num(t.cacheWrite5m) + num(t.cacheWrite1h);
    if (perDay.has(r.day)) addTo(perDay.get(r.day), r, rateOf);
    if (r.billingAssumed) assumed.add(r.day);
  }
  const keyName = (k) => (k === PLAN || k === NONE ? null : keyNames.get(k) || k);
  const inScope = (b) =>
    center === '__all' || (b.scope && b.scope !== 'global' && b.scope.dim === 'center' && b.scope.value === center);
  return {
    month,
    from,
    to,
    center: { id: center, name },
    currency,
    generatedAt,
    totals: { ...money(totals), tokens },
    tables: Object.fromEntries(
      Object.entries(TABLES).map(([t, field]) => [t, tableOf(mine, field, rateOf, t === 'key' ? keyName : null)]),
    ),
    daily: [...perDay.entries()].map(([day, s]) => {
      const m = money(s);
      return {
        day,
        listUSD: m.listUSD,
        billedUSD: m.billedUSD,
        ...('list' in m ? { list: m.list, billed: m.billed } : {}),
      };
    }),
    budgets: Array.isArray(budgets)
      ? budgets.filter(inScope).map((b) => ({
          id: b.id,
          name: b.name,
          scope: b.scope,
          period: b.period,
          from: b.from,
          to: b.to,
          amount: b.amount,
          currency: b.currency,
          measure: b.measure,
          state: b.state,
          projected: b.projected,
          percent: b.percent,
          spent: b.spent,
          reason: b.reason,
        }))
      : null,
    notes: {
      unread: [...(unread || [])],
      assumed: [...assumed].sort(),
      billingError: billingError || null,
      corrections: Array.isArray(corrections)
        ? corrections
            .filter((c) => c && c.from <= to && c.to >= from)
            .map((c) => ({ ts: c.ts, from: c.from, to: c.to, reason: c.reason }))
        : null,
    },
  };
}

module.exports = { TOP, OTHER, PLAN, NONE, monthRange, reportMonths, defaultMonth, showback };
```

- [ ] **Step 4: The route in `lib/cost/api.js`**

Replace `const { isDay, addDays, dayOf } = require('./days');` with

```js
const { isDay, addDays, dayOf, monthOf } = require('./days');
```

after `const X = require('./export');` add

```js
const R = require('./report');
```

after `const REC_DAYS = 30; …` add

```js
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
```

right before `  function keys() {` add

```js
  // GET /api/cost/report (Cost Control 5): one cost center's month (lib/cost/report.js showback). Without `month`, last
  // month, or this month while the ledger does not hold all of last month. The budgets' states are the current
  // period's, so they come with the current month only. A ledger folder that does not read is a 503; a month or the
  // corrections that do not read are named in the notes.
  function report(q) {
    const today = dayOf(now());
    const s = current().value;
    const first = typeof cost.firstDay === 'function' ? cost.firstDay() : null;
    const month = q.get('month') || R.defaultMonth(today, first);
    if (!MONTH.test(month)) throw fail(400, 'month: YYYY-MM');
    if (month > monthOf(today)) throw fail(400, 'month: this month or earlier');
    const center = q.get('center') || '__all';
    if (center !== '__all' && center !== UNASSIGNED && !s.centers.some((c) => c.id === center))
      throw fail(400, 'unknown center');
    const currency = checkCurrency(q);
    const { from, to } = R.monthRange(month, today);
    const read = cost.budgetRows({ from, to });
    if ((read.unread || []).includes('folder'))
      throw Object.assign(new Error('the ledger folder could not be read'), { code: 'LEDGER_MONTH_UNREAD' });
    const thisMonth = month === monthOf(today);
    const [evaluated, budgetsFailed] =
      thisMonth && budgets ? quietly(() => budgets.evaluate().map(viewOut), []) : [null, false];
    const [corrections] = quietly(() => cost.corrections(), null);
    const data = R.showback({
      rows: read.rows,
      month,
      today,
      center,
      centers: s.centers,
      keyNames: new Map(keys().map((k) => [k.id, k.name || k.id])),
      budgets: evaluated,
      corrections,
      unread: read.unread,
      billingError: read.billingError ? scrub(read.billingError) : null,
      rateOf: currency ? (day) => rateFor(s.currency, day) : null,
      currency: currency || 'USD',
      generatedAt: now(),
    });
    return reply(200, {
      ...data,
      months: R.reportMonths(today, first),
      budgetsError: budgetsFailed ? 'budgets could not be read' : null,
    });
  }
```

and in the `GET` table, after `'/api/cost/view': (q) => view(q),` add

```js
    '/api/cost/report': (q) => report(q),
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/cost-report.test.js test/cost-report-api.test.js test/cost-reports-http.test.js test/cost-export-api.test.js test/cost-view-api.test.js test/cost-api.test.js`
Expected: PASS (8 new tests; the HTTP file's two tests now also check the report).

- [ ] **Step 6: Check the style**

Run: `npx prettier@3 --check lib/cost/report.js lib/cost/api.js test/cost-report.test.js test/cost-report-api.test.js test/cost-reports-http.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 7: Commit**

```bash
git add lib/cost/report.js lib/cost/api.js test/cost-report.test.js test/cost-report-api.test.js test/cost-reports-http.test.js
git commit -m "Cost report: one cost center's month as a showback answer"
```

---
### Task 3: the Reports page (`#cost/reports`)

**Files:**
- Create: `public/costreports.js`
- Modify: `public/costview.js` (`COST_SUBS` at 8–14, `viewCost` copy at ~462, `costRefresh` at 519, the exports at 1470)
- Modify: `public/iso.js` (`SUBPAGES.cost` at 589–595), `public/index.html` (sidebar at 47, scripts at 145)
- Modify: `public/styles.css` (append)
- Modify: `test/cost-settings-ui.test.js` (two wiring assertions at 63–71, on purpose: Reports now sits before Settings)
- Test: `test/cost-reports-ui.test.js` (create)

**Interfaces:**
- Consumes: `GET /api/cost/report` (Task 2); from `public/costview.js`: `COST`, `COST_SOURCES`, `COST_MONTH`,
  `COST_MONTH_LONG`, `costGet`, `costContext`, `costMoney`, `costScopeLabel`, `costPeriodLabel`, `costUnreadText`,
  `costRibbonHtml`, `costShowError`, `costSub`, `costQueryOfHash`; `costSpikeSvg(spikes, fmt)` (`public/costcharts.js:145`,
  reused as the daily bar chart with `baseline: null`); `metricTile`, `$` (iso.js/app.js).
- Produces: `public/costreports.js` globals `COST_REP`, `COST_REP_TABLES`, `COST_REP_STATE`, `costRepParse`,
  `costRepHash`, `costRepQuery`, `costRepMonthName`, `costRepTitle`, `costRepPeriod`, `costRepName`, `costRepAmount`,
  `costRepState`, `costRepTableHtml`, `costRepBudgetsHtml`, `costRepNotes`, `costRepControlsHtml`, `costRepHtml`,
  `costRepCsvCell`, `costRepCsv`, `costRepCsvName`, `costMountReports`, `costRepDownload`, `costRepGo`,
  `costRepInstallEvents` (none exists in any page script: checked with `grep`). `costview.js` exports also
  `COST_MONTH`, `COST_MONTH_LONG`, `costQueryOfHash`.

- [ ] **Step 1: Write the failing test**

Create `test/cost-reports-ui.test.js`:

```js
// Cost Control 5 in the browser file, without a browser: the Reports page (public/costreports.js), its controls, the
// report's tables, budgets and notes, the CSV it downloads, the print rules, and its wiring. Every server or owner
// string reaches the markup through esc().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// The page scripts share one global scope: costreports.js uses costview.js, the charts and the iso.js page helpers.
const C = require('../public/costcharts');
Object.assign(global, C, {
  COST_C: { cyan: '#4de8ff', violet: '#8b7bff', pink: '#ff4fd8', orange: '#ff9a3c', muted: '#8f98cc', blue: '#5b8cff' },
  COST_SERIES: ['#4de8ff'],
  metricTile: ({ label, value, sub }) => `<div class="metric">${label}|${value}|${sub}</div>`,
  panel: (title, meta, body) => `<section><h3>${title}</h3>${meta}${body}</section>`,
  holoEmpty: (text) => `<div class="empty">${text}</div>`,
});
const V = require('../public/costview');
Object.assign(global, V);
const U = require('../public/costreports');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const EVIL = '<img src=x onerror=alert(1)>';
const CTX = {
  cur: 'USD',
  fmt: (v) => V.costMoney(v),
  currencies: ['USD'],
  centers: { acme: 'Client: Acme' },
  keys: {},
};
const money = (l, b) => ({ listUSD: l, billedUSD: b });
const REPORT = {
  month: '2026-10',
  from: '2026-10-01',
  to: '2026-10-29',
  center: { id: 'acme', name: 'Client: Acme' },
  currency: 'USD',
  generatedAt: new Date(2026, 9, 29, 14, 5).getTime(),
  months: ['2026-10', '2026-09'],
  totals: { requests: 12, tokens: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 }, ...money(42.5, 12) },
  tables: {
    source: [{ key: 'gateway', requests: 10, tokens: 900, ...money(40, 12) }],
    model: [
      { key: EVIL, requests: 2, tokens: 10, ...money(2, 0) },
      { key: '__plan', requests: 0, tokens: 0, ...money(0, 6.5) },
      { key: '__other', count: 7, requests: 1, tokens: 1, ...money(0.5, 0.5) },
    ],
    key: [
      { key: 'key_a', name: EVIL, requests: 1, tokens: 1, ...money(1, 1) },
      { key: '__none', name: null, requests: 1, tokens: 1, ...money(1, 1) },
    ],
    project: [{ key: '=cmd|"/c calc"!A1', requests: 1, tokens: 1, ...money(1, 1) }],
  },
  daily: [
    { day: '2026-10-01', ...money(1.5, 1) },
    { day: '2026-10-02', ...money(0, 0) },
  ],
  budgets: [
    {
      id: 'acme',
      name: EVIL,
      scope: { dim: 'center', value: 'acme' },
      period: 'month',
      from: '2026-10-01',
      to: '2026-10-31',
      amount: 100,
      currency: 'USD',
      measure: 'list',
      state: 'warn_80',
      projected: true,
      percent: 84.5,
      spent: 84.5,
      reason: null,
    },
  ],
  budgetsError: null,
  notes: {
    unread: ['2026-09'],
    assumed: ['2026-10-02'],
    billingError: null,
    corrections: [{ ts: 1, from: '2026-10-03', to: '2026-10-04', reason: EVIL }],
  },
};

test('the choice: from the hash, back to it, and to the report query', () => {
  assert.deepEqual(U.costRepParse('month=2026-09&center=acme&cur=IDR'), {
    month: '2026-09',
    center: 'acme',
    cur: 'IDR',
  });
  assert.deepEqual(U.costRepParse('month=2026-13&center=../x&cur=idr'), {});
  assert.equal(U.costRepHash({ month: '2026-09', center: '__all', cur: 'USD' }), '#cost/reports?month=2026-09');
  assert.equal(
    U.costRepHash({ month: '2026-09', center: 'acme', cur: 'IDR' }),
    '#cost/reports?month=2026-09&center=acme&cur=IDR',
  );
  assert.equal(U.costRepHash({}), '#cost/reports');
  assert.equal(
    U.costRepQuery({ month: '2026-09', center: 'acme', cur: 'IDR' }),
    'month=2026-09&center=acme&currency=IDR',
  );
  assert.equal(U.costRepQuery({}), '');
});

test('the header: the center and the month, the period and when it was generated', () => {
  assert.equal(U.costRepTitle(REPORT), 'Cost report · Client: Acme · October 2026');
  assert.equal(U.costRepPeriod(REPORT), '1–29 October 2026 · generated 29 Oct 2026, 14:05');
  assert.equal(U.costRepName('model', { key: '__other', count: 7 }), 'Other (7)');
  assert.equal(U.costRepName('model', { key: '__plan' }), 'Plan fee');
  assert.equal(U.costRepName('key', { key: '__none' }), 'Unknown');
  assert.equal(U.costRepName('source', { key: 'claude' }), 'Claude Code');
  assert.equal(U.costRepName('key', { key: 'key_a', name: 'Acme app' }), 'Acme app');
  assert.equal(U.costRepState({ state: 'warn_80', projected: true }), 'Past 80 %, projected over');
  assert.equal(U.costRepState({ state: 'exceeded' }), 'Used up');
});

test('the report: totals, four tables with Other, daily spend, budgets and notes; every name escaped', () => {
  const html = U.costRepHtml(REPORT, CTX);
  assert.match(html, /<h2>Cost report · Client: Acme · October 2026<\/h2>/);
  assert.match(html, /Usage value\|\$42\.50\|/);
  assert.match(html, /Paid\|\$12\.00\|/);
  for (const t of ['By source', 'By model', 'By key', 'By project', 'Daily spend', 'Budgets', 'Notes'])
    assert.ok(html.includes(`<h3>${t}</h3>`), t);
  assert.match(html, /<td>Other \(7\)<\/td>/);
  assert.match(html, /<td>Plan fee<\/td>/);
  assert.match(html, /<td>Past 80 %, projected over<\/td>/);
  assert.match(html, /aria-label="Daily spend"/);
  assert.match(html, /September 2026 could not be read: figures leave it out\./);
  assert.match(html, /Billing was assumed as metered on 1 day\(s\): 2 Oct\./);
  assert.match(html, /Restated 2026-10-03 to 2026-10-04: &lt;img/);
  assert.ok(!html.includes(EVIL), 'no raw owner text');
  const past = U.costRepHtml({ ...REPORT, budgets: null, notes: { unread: [], assumed: [], corrections: [] } }, CTX);
  assert.match(past, /Budget states are shown for the current month only\./);
  assert.doesNotMatch(past, /<h3>Notes<\/h3>/);
  assert.match(U.costRepHtml({ ...REPORT, budgets: [] }, CTX), /No budget for this center\./);
  assert.match(U.costRepHtml({ ...REPORT, budgets: null, budgetsError: 'x' }, CTX), /Budgets could not be read\./);
  assert.match(
    U.costRepHtml({ ...REPORT, notes: { ...REPORT.notes, corrections: null } }, CTX),
    /The restates could not be read\./,
  );
});

test('the controls: month, center with All and Unassigned, Print and Export CSV, none of it printed', () => {
  const ctx = { ...CTX, currencies: ['USD', 'IDR'], centers: { acme: 'Client: Acme', evil: EVIL } };
  const html = U.costRepControlsHtml(REPORT, ctx);
  assert.match(html, /class="cost-bar cost-rep-controls cost-noprint"/);
  assert.match(
    html,
    /<option value="2026-10" selected>October 2026<\/option><option value="2026-09" >September 2026<\/option>/,
  );
  assert.match(html, /<option value="__all" >All centers<\/option><option value="acme" selected>Client: Acme<\/option>/);
  assert.match(html, /<option value="unassigned" >Unassigned<\/option>/);
  assert.match(html, /data-cost-rep-cur="IDR" aria-pressed="false"/);
  assert.match(html, /<button type="button" class="btn ghost" data-cost-rep-print>Print<\/button>/);
  assert.match(html, /<button type="button" class="btn" data-cost-rep-csv>Export CSV<\/button>/);
  assert.ok(!html.includes(EVIL));
  assert.doesNotMatch(U.costRepControlsHtml(REPORT, CTX), /data-cost-rep-cur/, 'USD only: no currency switch');
});

test('the CSV: a title, then each table with its header row, formula cells prefixed, amounts plain', () => {
  const text = U.costRepCsv(REPORT, CTX);
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'Cost report · Client: Acme · October 2026');
  assert.equal(lines[2], '');
  assert.equal(lines[3], 'By source');
  assert.equal(lines[4], 'Name,Usage value (USD),Paid (USD),Requests,Tokens');
  assert.equal(lines[5], 'Gateway,40.00000000,12.00000000,10,900');
  assert.ok(lines.includes('Other (7),0.50000000,0.50000000,1,1'));
  assert.ok(lines.includes('"\'=cmd|""/c calc""!A1",1.00000000,1.00000000,1,1'), 'CSV injection');
  assert.ok(lines.includes('Day,Usage value (USD),Paid (USD)'));
  assert.ok(lines.includes('2026-10-01,1.50000000,1.00000000'));
  assert.equal(lines.pop(), '', 'every line ends with CRLF');
  const idr = U.costRepCsv(
    {
      ...REPORT,
      tables: { source: [{ key: 'gateway', requests: 1, tokens: 1, ...money(1, 1), list: 16000, billed: null }] },
    },
    { ...CTX, cur: 'IDR' },
  );
  assert.ok(idr.includes('Name,Usage value (USD),Paid (USD),Usage value (IDR),Paid (IDR),Requests,Tokens'));
  assert.ok(idr.includes('Gateway,1.00000000,1.00000000,16000.00000000,,1,1'));
  assert.equal(U.costRepCsvName(REPORT), 'zaafpulse-report-acme-2026-10.csv');
});

test('the page loads the report the hash names, in a currency it has rates for, and paints the bar and body', async () => {
  const saved = {
    $: global.$,
    state: global.state,
    location: global.location,
    fetch: global.fetch,
    document: global.document,
  };
  const els = {
    '#cost-body': { isConnected: true, innerHTML: '' },
    '#cost-bar': { innerHTML: '' },
    '#cost-ribbon': { innerHTML: '' },
  };
  const urls = [];
  global.$ = (s) => els[s] || null;
  global.state = { sub: 'reports' };
  global.location = { hash: '#cost/reports?month=2026-09&center=acme&cur=IDR' };
  global.document = { addEventListener() {} };
  const settings = {
    settings: {
      centers: [{ id: 'acme', name: 'Client: Acme' }],
      currency: { code: 'IDR', rates: [{ from: '2026-01-01', perUSD: 16000 }] },
    },
    keys: [],
    sources: ['claude'],
  };
  global.fetch = async (url) => {
    urls.push(url);
    const json = url.startsWith('/api/cost/settings') ? settings : url.startsWith('/api/cost/status') ? {} : REPORT;
    return { status: 200, json: async () => json };
  };
  try {
    await U.costMountReports();
    assert.ok(urls.includes('/api/cost/report?month=2026-09&center=acme&currency=IDR'), urls.join(' '));
    assert.match(els['#cost-bar'].innerHTML, /data-cost-rep-month/);
    assert.match(els['#cost-body'].innerHTML, /class="cost-report"/);
    assert.equal(U.COST_REP.ctx.cur, 'IDR');
    U.costRepGo({ center: '__all' });
    assert.equal(global.location.hash, '#cost/reports?month=2026-10&cur=IDR', 'All centers is the default');
    global.location = { hash: '#cost/reports?cur=EUR' };
    urls.length = 0;
    await U.costMountReports();
    assert.ok(urls.includes('/api/cost/report?'), 'a currency without rates is USD');
  } finally {
    Object.assign(global, saved);
  }
});

test('the page is wired: sub-page and sidebar entry before Settings, the script after costsettings.js, no quiet refresh', () => {
  const html = read('index.html');
  assert.match(
    html,
    /href="#cost\/budgets"[^\n]*\n\s*<a class="nav-sub" href="#cost\/reports" data-route="cost\/reports">Reports<\/a>\n\s*<a class="nav-sub" href="#cost\/settings"/,
  );
  const at = html.indexOf('<script src="costreports.js"></script>');
  assert.ok(
    at > html.indexOf('<script src="costsettings.js"></script>') && at < html.indexOf('<script src="app.js"></script>'),
  );
  assert.match(read('iso.js'), /\['budgets', 'Budgets'\],\s*\['reports', 'Reports'\],\s*\['settings', 'Settings'\],/);
  assert.deepEqual(V.COST_SUBS.slice(-2), [
    ['reports', 'Reports'],
    ['settings', 'Settings'],
  ]);
  assert.match(
    read('costview.js'),
    /if \(costSub\(\) === 'reports'\) return quiet \? undefined : costMountReports\(\);/,
  );
});

test('print: the sidebar, the top bar, the tabs and the controls are hidden; one column for A4 and Letter', () => {
  const css = read('styles.css');
  const at = css.indexOf('@media print {');
  assert.ok(at > 0);
  const print = css.slice(at);
  for (const sel of ['.sidebar', '.topbar', '.subtabs', '.hero', '.cost-noprint', '#cost-ribbon'])
    assert.ok(print.includes(sel), sel);
  assert.match(print, /display: none !important;/);
  assert.match(print, /@page \{\s*margin: 12mm;/);
  assert.match(print, /\.cost-rep-tables \{\s*grid-template-columns: 1fr;/);
});

test('costreports.js builds no markup from server or owner text without esc(), and prints from a delegated click', () => {
  const src = read('costreports.js');
  const CONTENT =
    /\.(name|reason|reasons|project|model|center|provider|source|plan|label|title|text|error|message|id|key|value|code|currency|cur|from|to|note|dim|budget|month|day)$/;
  const bare = [...src.matchAll(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)].map((m) => m[1]).filter((e) => CONTENT.test(e));
  // Plain-text helpers build text that esc() takes later: costRepTitle, costRepPeriod, the CSV and its file name.
  const TEXT_ONLY = ['r.center.name', 'r.center.id', 'r.month', 'c.from', 'c.to', 'c.reason'];
  assert.deepEqual(
    bare.filter((e) => !TEXT_ONLY.includes(e)),
    [],
    'content interpolated without esc()',
  );
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\son[a-z]+=["`']/);
  assert.match(src, /if \(t\.hasAttribute\('data-cost-rep-print'\)\) return void window\.print\(\);/);
  for (const [name] of src.matchAll(/^(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(name.split(/\s+/).pop(), /^(?:costRep|COST_REP)|^costMountReports$/, `${name}: starts with costRep`);
});
```

In `test/cost-settings-ui.test.js` (the wiring test at 61), Reports now sits between Budgets and Settings. Replace

```js
    /<a class="nav-sub" href="#cost\/budgets"[^\n]*\n\s*<a class="nav-sub" href="#cost\/settings" data-route="cost\/settings">Settings<\/a>/,
```

with

```js
    /<a class="nav-sub" href="#cost\/reports"[^\n]*\n\s*<a class="nav-sub" href="#cost\/settings" data-route="cost\/settings">Settings<\/a>/,
```

and

```js
  assert.match(read('iso.js'), /\['budgets', 'Budgets'\],\s*\['settings', 'Settings'\],\s*\],/);
```

with

```js
  assert.match(read('iso.js'), /\['reports', 'Reports'\],\s*\['settings', 'Settings'\],\s*\],/);
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-reports-ui.test.js test/cost-settings-ui.test.js`
Expected: FAIL (`Cannot find module '../public/costreports'`; the two wiring assertions).

- [ ] **Step 3: Create `public/costreports.js`**

```js
'use strict';
/* Cost Control → Reports (#cost/reports, sub-project 5): one cost center's month for a client, drawn from
   GET /api/cost/report: the totals in both measures, the spend by source, model, key and project, the daily spend, the
   center's budgets and the notes. The month, the center and the currency live in the URL. Print calls window.print()
   from a delegated click (the CSP allows no inline handler) and the print CSS keeps the report only; Export CSV
   downloads the report's tables, built here, as one CSV in sections. Loaded after costview.js, whose helpers it uses
   inside functions only; pure helpers are exported for Node tests, and nothing here touches the DOM at load time.
   Every server or owner string reaches the markup through esc(). */

const COST_REP_TABLES = [
  ['source', 'By source'],
  ['model', 'By model'],
  ['key', 'By key'],
  ['project', 'By project'],
];
const COST_REP_STATE = { exceeded: 'Used up', ok: 'Under its levels', no_data: 'No data' };
const COST_REP = { report: null, ctx: null, hooked: false };

/* ---------- pure helpers (exported) ---------- */

/** The choice in the hash: month, center and currency; a value of the wrong shape is left out (the server decides). */
function costRepParse(query) {
  const q = new URLSearchParams(query || '');
  const out = {};
  const month = q.get('month');
  if (month && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) out.month = month;
  const center = q.get('center');
  if (center && /^[a-z0-9][a-z0-9-]{0,39}$/.test(center)) out.center = center;
  const cur = q.get('cur');
  if (cur && /^[A-Z]{3}$/.test(cur)) out.cur = cur;
  return out;
}
/** The hash that names a choice: All centers and USD are left out. */
function costRepHash(c) {
  const q = new URLSearchParams();
  if (c.month) q.set('month', c.month);
  if (c.center && c.center !== '__all') q.set('center', c.center);
  if (c.cur && c.cur !== 'USD') q.set('cur', c.cur);
  const s = q.toString();
  return `#cost/reports${s ? `?${s}` : ''}`;
}
/** The query of GET /api/cost/report for a choice. */
function costRepQuery(c) {
  const q = new URLSearchParams();
  if (c.month) q.set('month', c.month);
  if (c.center) q.set('center', c.center);
  if (c.cur && c.cur !== 'USD') q.set('currency', c.cur);
  return q.toString();
}
/** "October 2026" from YYYY-MM. */
const costRepMonthName = (m) => `${COST_MONTH_LONG[Number(String(m).slice(5, 7)) - 1] || ''} ${String(m).slice(0, 4)}`;
/** "Cost report · Client: Acme · October 2026" */
const costRepTitle = (r) => `Cost report · ${r.center.name} · ${costRepMonthName(r.month)}`;
/** "1–31 October 2026 · generated 29 Oct 2026, 14:05" (the generated time in this browser's time zone). */
function costRepPeriod(r) {
  const d = (x) => Number(String(x).slice(8));
  const at = Number.isFinite(r.generatedAt) ? new Date(r.generatedAt) : null;
  const when = at
    ? `${at.getDate()} ${COST_MONTH[at.getMonth()]} ${at.getFullYear()}, ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : '';
  return `${d(r.from)}–${d(r.to)} ${costRepMonthName(r.month)}${when ? ` · generated ${when}` : ''}`;
}
/** A table row's name: Other with how many it holds, a plan fee, Unknown, a source's label, a key's name. */
function costRepName(table, x) {
  if (x.key === '__other') return `Other (${x.count})`;
  if (x.key === '__plan') return 'Plan fee';
  if (x.key === '__none') return 'Unknown';
  if (table === 'source') return COST_SOURCES[x.key] || x.key;
  if (table === 'key') return x.name || x.key;
  return String(x.key);
}
/** An amount in the chosen currency: `field` is list or billed. */
const costRepAmount = (x, field, ctx) => ctx.fmt(ctx.cur === 'USD' ? x[`${field}USD`] : x[field]);
/** A budget's state as the Budgets page names it, and whether it is projected over. */
function costRepState(b) {
  const s = String(b.state);
  const word = COST_REP_STATE[s] || (/^warn_\d+$/.test(s) ? `Past ${s.slice(5)} %` : s);
  return b.projected ? `${word}, projected over` : word;
}

function costRepTableHtml(r, table, title, ctx) {
  const rows = (r.tables && r.tables[table]) || [];
  const body = rows.length
    ? rows
        .map(
          (x) =>
            `<tr><td>${esc(costRepName(table, x))}</td><td class="num">${esc(costRepAmount(x, 'list', ctx))}</td><td class="num">${esc(costRepAmount(x, 'billed', ctx))}</td><td class="num">${esc((x.requests || 0).toLocaleString('en'))}</td><td class="num">${esc((x.tokens || 0).toLocaleString('en'))}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="5">${esc('Nothing in this month.')}</td></tr>`;
  return `<section class="cost-rep-section"><h3>${esc(title)}</h3><table class="cost-table cost-rep-table"><thead><tr><th>Name</th><th class="num">Usage value</th><th class="num">Paid</th><th class="num">Requests</th><th class="num">Tokens</th></tr></thead><tbody>${body}</tbody></table></section>`;
}
function costRepBudgetsHtml(r, ctx) {
  if (!Array.isArray(r.budgets)) {
    const why = r.budgetsError ? 'Budgets could not be read.' : 'Budget states are shown for the current month only.';
    return `<p class="cost-note">${esc(why)}</p>`;
  }
  if (!r.budgets.length) return `<p class="cost-note">${esc('No budget for this center.')}</p>`;
  const rows = r.budgets
    .map(
      (b) =>
        `<tr><td>${esc(b.name)}</td><td>${esc(costScopeLabel(b.scope, ctx))}</td><td>${esc(costPeriodLabel(b))}</td><td>${esc(costRepState(b))}</td><td class="num">${esc(b.percent == null ? '—' : `${b.percent} %`)}</td><td class="num">${esc(b.state === 'no_data' ? b.reason || 'No data' : `${costMoney(b.spent, b.currency)} of ${costMoney(b.amount, b.currency)}`)}</td></tr>`,
    )
    .join('');
  return `<table class="cost-table cost-rep-table"><thead><tr><th>Budget</th><th>Scope</th><th>Period</th><th>State</th><th class="num">Used</th><th class="num">Spent</th></tr></thead><tbody>${rows}</tbody></table>`;
}
/** The notes: months that did not read, days whose billing was assumed, and the restates of the period. */
function costRepNotes(r) {
  const n = r.notes || {};
  const out = (n.unread || []).map(costUnreadText);
  if (n.billingError) out.push('What was paid: ' + n.billingError + '; billed as metered.');
  if ((n.assumed || []).length)
    out.push(
      `Billing was assumed as metered on ${n.assumed.length} day(s): ${n.assumed.map((d) => `${Number(d.slice(8))} ${COST_MONTH[Number(d.slice(5, 7)) - 1]}`).join(', ')}.`,
    );
  if (n.corrections === null) out.push('The restates could not be read.');
  for (const c of n.corrections || []) out.push(`Restated ${c.from} to ${c.to}: ${c.reason}`);
  return out;
}

/** The report page's control bar: month, center, currency, Print and Export CSV. Hidden when printed. */
function costRepControlsHtml(r, ctx) {
  const months = (r.months || [r.month])
    .map((m) => `<option value="${esc(m)}" ${m === r.month ? 'selected' : ''}>${esc(costRepMonthName(m))}</option>`)
    .join('');
  const centers = [['__all', 'All centers'], ...Object.entries(ctx.centers || {}), ['unassigned', 'Unassigned']]
    .map(([id, name]) => `<option value="${esc(id)}" ${id === r.center.id ? 'selected' : ''}>${esc(name)}</option>`)
    .join('');
  const cur =
    ctx.currencies.length > 1
      ? `<div class="segmented" role="group" aria-label="Currency">${ctx.currencies
          .map(
            (x) =>
              `<button type="button" data-cost-rep-cur="${esc(x)}" aria-pressed="${x === ctx.cur}">${esc(x)}</button>`,
          )
          .join('')}</div>`
      : '';
  return `<div class="cost-bar cost-rep-controls cost-noprint"><label>Month <select class="input" data-cost-rep-month>${months}</select></label><label>Center <select class="input" data-cost-rep-center>${centers}</select></label>${cur}<span class="cost-spacer"></span><button type="button" class="btn ghost" data-cost-rep-print>Print</button><button type="button" class="btn" data-cost-rep-csv>Export CSV</button></div>`;
}

/** The report itself: what prints. */
function costRepHtml(r, ctx) {
  const t = r.totals || {};
  const tok = t.tokens || {};
  const tokens = (tok.input || 0) + (tok.output || 0) + (tok.cacheRead || 0) + (tok.cacheWrite || 0);
  const tiles = [
    metricTile({ label: 'Usage value', value: esc(costRepAmount(t, 'list', ctx)), sub: 'at list prices' }),
    metricTile({ label: 'Paid', value: esc(costRepAmount(t, 'billed', ctx)), sub: 'plan fees and metered use' }),
    metricTile({ label: 'Requests', value: esc((t.requests || 0).toLocaleString('en')), sub: '' }),
    metricTile({
      label: 'Tokens',
      value: esc(tokens.toLocaleString('en')),
      sub: esc(`${(tok.input || 0).toLocaleString('en')} in · ${(tok.output || 0).toLocaleString('en')} out`),
    }),
  ].join('');
  const tables = COST_REP_TABLES.map(([k, title]) => costRepTableHtml(r, k, title, ctx)).join('');
  const field = ctx.cur === 'USD' ? 'listUSD' : 'list';
  const days = (r.daily || []).map((d) => ({
    day: d.day,
    spend: d[field] == null ? d.listUSD : d[field],
    baseline: null,
    spike: false,
    topModel: null,
  }));
  const notes = costRepNotes(r);
  return `<article class="cost-report" aria-label="${esc(costRepTitle(r))}">
    <header class="cost-rep-head"><h2>${esc(costRepTitle(r))}</h2><p>${esc(costRepPeriod(r))}</p></header>
    <div class="grid kpis cost-rep-tiles">${tiles}</div>
    <div class="cost-rep-tables">${tables}</div>
    <section class="cost-rep-section"><h3>Daily spend</h3>${costSpikeSvg(days, ctx.fmt)}</section>
    <section class="cost-rep-section"><h3>Budgets</h3>${costRepBudgetsHtml(r, ctx)}</section>
    ${notes.length ? `<section class="cost-rep-section"><h3>Notes</h3>${notes.map((x) => `<p class="cost-note">${esc(x)}</p>`).join('')}</section>` : ''}
  </article>`;
}

// A CSV cell as the server's export writes one (lib/cost/export.js): text that a spreadsheet would run as a formula
// gets a leading ', a cell with a comma, quote or line end is quoted, amounts have 8 decimals.
function costRepCsvCell(v, amount = false) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? (amount ? v.toFixed(8) : String(v)) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** The report's tables as one CSV in sections: a title line, then each table with its header row, a blank line
 *  between. Amounts in USD, and in the chosen currency too when it is not USD. */
function costRepCsv(r, ctx) {
  const cur = ctx.cur && ctx.cur !== 'USD' ? ctx.cur : null;
  const line = (cells) => cells.join(',') + '\r\n';
  const money = (x) => [
    costRepCsvCell(x.listUSD, true),
    costRepCsvCell(x.billedUSD, true),
    ...(cur ? [costRepCsvCell(x.list, true), costRepCsvCell(x.billed, true)] : []),
  ];
  const heads = ['Usage value (USD)', 'Paid (USD)', ...(cur ? [`Usage value (${cur})`, `Paid (${cur})`] : [])];
  let out = line([costRepCsvCell(costRepTitle(r))]) + line([costRepCsvCell(costRepPeriod(r))]);
  for (const [k, title] of COST_REP_TABLES) {
    out += '\r\n' + line([costRepCsvCell(title)]) + line(['Name', ...heads, 'Requests', 'Tokens']);
    for (const x of (r.tables && r.tables[k]) || [])
      out += line([
        costRepCsvCell(costRepName(k, x)),
        ...money(x),
        costRepCsvCell(x.requests),
        costRepCsvCell(x.tokens),
      ]);
  }
  out += '\r\n' + line(['Daily spend']) + line(['Day', ...heads]);
  for (const d of r.daily || []) out += line([d.day, ...money(d)]);
  return out;
}
/** "zaafpulse-report-client-acme-2026-10.csv": a center id and a month, so the name needs no escaping. */
const costRepCsvName = (r) => `zaafpulse-report-${r.center.id}-${r.month}.csv`;

/* ---------- the page ---------- */

// A report is a document: it loads when the page opens or a control changes, never on the quiet refresh cycle.
async function costMountReports() {
  costRepInstallEvents();
  const body = $('#cost-body');
  if (!body) return;
  const my = ++COST.req;
  const live = () => my === COST.req && body.isConnected && costSub() === 'reports';
  try {
    const [settings, status] = await Promise.all([
      costGet('/api/cost/settings'),
      costGet('/api/cost/status').catch(() => null),
    ]);
    if (!live()) return;
    COST.settings = settings;
    const base = costContext(settings);
    const c = costRepParse(costQueryOfHash());
    const cur = c.cur && base.currencies.includes(c.cur) ? c.cur : 'USD';
    const r = await costGet(`/api/cost/report?${costRepQuery({ ...c, cur })}`);
    if (!live()) return;
    const ctx = { ...base, cur, fmt: (v) => costMoney(v, cur) };
    COST_REP.report = r;
    COST_REP.ctx = ctx;
    $('#cost-ribbon').innerHTML = costRibbonHtml(status);
    $('#cost-bar').innerHTML = costRepControlsHtml(r, ctx);
    body.innerHTML = costRepHtml(r, ctx);
  } catch (e) {
    if (!live()) return;
    costShowError(body, e.message, false);
  }
}

// The CSV through a Blob link; nothing is kept in the page.
function costRepDownload() {
  const r = COST_REP.report;
  if (!r) return;
  const url = URL.createObjectURL(new Blob([costRepCsv(r, COST_REP.ctx)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = costRepCsvName(r);
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// A changed control names the new choice in the hash; the router mounts the page again.
function costRepGo(next) {
  const r = COST_REP.report;
  const c = {
    month: r ? r.month : undefined,
    center: r ? r.center.id : '__all',
    cur: COST_REP.ctx ? COST_REP.ctx.cur : 'USD',
  };
  location.hash = costRepHash({ ...c, ...next });
}
function costRepInstallEvents() {
  if (COST_REP.hooked) return;
  COST_REP.hooked = true;
  document.addEventListener('click', (e) => {
    const t =
      e.target.closest &&
      e.target.closest('#cost-app [data-cost-rep-print], #cost-app [data-cost-rep-csv], #cost-app [data-cost-rep-cur]');
    if (!t) return;
    if (t.hasAttribute('data-cost-rep-print')) return void window.print();
    if (t.hasAttribute('data-cost-rep-csv')) return void costRepDownload();
    costRepGo({ cur: t.dataset.costRepCur });
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('#cost-app')) return;
    if (t.hasAttribute('data-cost-rep-month')) costRepGo({ month: t.value });
    else if (t.hasAttribute('data-cost-rep-center')) costRepGo({ center: t.value });
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    COST_REP,
    COST_REP_TABLES,
    costRepParse,
    costRepHash,
    costRepQuery,
    costRepMonthName,
    costRepTitle,
    costRepPeriod,
    costRepName,
    costRepState,
    costRepNotes,
    costRepTableHtml,
    costRepBudgetsHtml,
    costRepControlsHtml,
    costRepHtml,
    costRepCsvCell,
    costRepCsv,
    costRepCsvName,
    costMountReports,
    costRepGo,
  };
```

- [ ] **Step 4: Wire the page**

`public/costview.js`:
- In `COST_SUBS`, after `['budgets', 'Budgets'],` add `['reports', 'Reports'],`.
- In `viewCost`'s copy, after the `budgets: '…',` line add

```js
    reports: "One cost center's month for a client: totals, tables and budgets, to print or export.",
```

- In `costRefresh`, after `if (costSub() === 'settings') return quiet ? undefined : costMountSettings();` add

```js
  // Reports is a document (public/costreports.js): it loads on a visit or a changed control, never on the quiet cycle.
  if (costSub() === 'reports') return quiet ? undefined : costMountReports();
```

- In `module.exports`, after `COST_SOURCES,` add `COST_MONTH,` and `COST_MONTH_LONG,`; after `costSub,` add
  `costQueryOfHash,`.

`public/iso.js`: in `SUBPAGES.cost`, after `['budgets', 'Budgets'],` add `['reports', 'Reports'],`.

`public/index.html`: after `<a class="nav-sub" href="#cost/budgets" data-route="cost/budgets">Budgets</a>` add

```html
        <a class="nav-sub" href="#cost/reports" data-route="cost/reports">Reports</a>
```

and after `<script src="costsettings.js"></script>` add `  <script src="costreports.js"></script>`.

- [ ] **Step 5: The report and print CSS**

Append to `public/styles.css`:

```css

/* Cost Control 5: the Reports page (public/costreports.js), and what it prints. */
.cost-rep-controls label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--h-muted);
}
.cost-report {
  display: grid;
  gap: 16px;
}
.cost-rep-head h2 {
  margin: 0;
  font-size: 20px;
  color: var(--h-text);
}
.cost-rep-head p {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--h-muted);
}
.cost-rep-tables {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}
.cost-rep-section h3 {
  margin: 0 0 8px;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--h-muted);
}
.cost-rep-table td {
  overflow-wrap: anywhere;
}
/* Print keeps the report only, in one column that fits A4 and Letter, black on white. */
@media print {
  @page {
    margin: 12mm;
  }
  .sidebar,
  .topbar,
  .subtabs,
  .hero,
  .cost-noprint,
  #cost-ribbon,
  .drawer,
  .drawer-backdrop,
  .tooltip {
    display: none !important;
  }
  html,
  body,
  .shell,
  .main,
  .content,
  .cost-deck {
    display: block !important;
    margin: 0 !important;
    padding: 0 !important;
    width: auto !important;
    max-width: none !important;
    overflow: visible !important;
    background: #fff !important;
  }
  .cost-report,
  .cost-report * {
    color: #000 !important;
    text-shadow: none !important;
    box-shadow: none !important;
    filter: none !important;
  }
  .cost-report .metric,
  .cost-report .cost-table th,
  .cost-report .cost-table td {
    background: #fff !important;
    border-color: #999 !important;
  }
  .cost-rep-tables {
    grid-template-columns: 1fr;
  }
  .cost-rep-section,
  .cost-rep-table tr {
    break-inside: avoid;
  }
  .cost-report svg {
    max-width: 100%;
    height: auto;
  }
}
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/cost-reports-ui.test.js test/cost-settings-ui.test.js test/cost-ui.test.js test/cost-budgets-ui.test.js`
Expected: PASS (9 new tests; the one-global-scope test still passes with the new script).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check public/costreports.js public/costview.js public/iso.js test/cost-reports-ui.test.js test/cost-settings-ui.test.js`
Expected: `All matched files use Prettier code style!` (`styles.css` already differs: do not `--write` it.)

- [ ] **Step 8: Commit**

```bash
git add public/costreports.js public/costview.js public/iso.js public/index.html public/styles.css test/cost-reports-ui.test.js test/cost-settings-ui.test.js
git commit -m "Cost Control: a Reports page that prints a center's month and exports it to CSV"
```

---
### Task 4: "Export CSV" on the Breakdown table

**Files:**
- Modify: `public/costview.js` (before `const COST_SORT_NUM` at ~864; `costPaintTable`'s `host.innerHTML` at ~909; the
  exports)
- Modify: `public/styles.css` (append)
- Test: `test/cost-export-ui.test.js` (create)

**Interfaces:**
- Consumes: `costRangeDays(c, today)`, `costToday()`, `COST.controls` (`{ range, from, to, cur, measure }`), the
  table plan's `query` (`costTablePlan`: the checked groupings plus a filter's dimension, at most 4).
- Produces: `costExportHref(c, groupBy, today = costToday()) → '/api/cost/export?format=csv&from&to&groupBy&measure[&currency]'`,
  and a `<a class="btn ghost cost-export" href="…" download>Export CSV</a>` at the end of the table bar.

- [ ] **Step 1: Write the failing test**

Create `test/cost-export-ui.test.js`:

```js
// Cost Control 5 in the browser file: the Breakdown table's Export CSV link (public/costview.js) names the page's
// range, currency and measure and the table's grouping, as GET /api/cost/export reads them.
const test = require('node:test');
const assert = require('node:assert/strict');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const U = require('../public/costview');

const T = '2026-10-29';

test('the export link: the range of the controls, the grouping, the measure and a display currency', () => {
  const c = { range: '7d', from: null, to: null, cur: 'USD', measure: 'list' };
  assert.equal(
    U.costExportHref(c, ['model'], T),
    '/api/cost/export?format=csv&from=2026-10-23&to=2026-10-29&groupBy=model&measure=list',
  );
  assert.equal(
    U.costExportHref(
      { ...c, range: 'custom', from: '2026-09-01', to: '2026-09-30', cur: 'IDR', measure: 'billed' },
      ['center', 'model'],
      T,
    ),
    '/api/cost/export?format=csv&from=2026-09-01&to=2026-09-30&groupBy=center%2Cmodel&measure=billed&currency=IDR',
  );
  const q = new URL(U.costExportHref({ ...c, range: 'lastmonth' }, ['day', 'source'], T), 'http://x').searchParams;
  assert.deepEqual([q.get('from'), q.get('to'), q.get('groupBy')], ['2026-09-01', '2026-09-30', 'day,source']);
});

test('the Breakdown table carries the link, with the filter dimension in its grouping and the markup escaped', () => {
  const saved = { $: global.$ };
  const host = { isConnected: true, innerHTML: '' };
  global.$ = (s) => (s === '#cost-table' ? host : null);
  try {
    U.COST.controls = { range: '30d', from: null, to: null, cur: 'IDR', measure: 'billed' };
    const ctx = { measure: 'billed', cur: 'IDR', fmt: (v) => U.costMoney(v, 'IDR'), centers: {}, keys: {} };
    const plan = U.costTablePlan(['model'], { dim: 'center', key: 'acme' });
    U.COST.table = {
      groupBy: ['model'],
      sort: { key: 'spend', dir: -1 },
      filter: { dim: 'center', key: 'acme' },
      data: { led: { rows: [] }, plan, ctx },
    };
    U.costPaintTable();
    const m = /<a class="btn ghost cost-export" href="([^"]+)" download>Export CSV<\/a>/.exec(host.innerHTML);
    assert.ok(m, host.innerHTML);
    const q = new URL(m[1].replace(/&amp;/g, '&'), 'http://x').searchParams;
    assert.deepEqual(
      [q.get('format'), q.get('groupBy'), q.get('measure'), q.get('currency')],
      ['csv', 'center,model', 'billed', 'IDR'],
    );
    assert.doesNotMatch(m[1], /&(?!amp;)/, 'the href is escaped');
  } finally {
    Object.assign(global, saved);
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-export-ui.test.js`
Expected: FAIL (`U.costExportHref is not a function`).

- [ ] **Step 3: The link**

In `public/costview.js`, right before `const COST_SORT_NUM = ['spend', 'share', 'requests', 'tokens', 'perRequest'];`
add

```js
/** The Breakdown table's Export CSV link (GET /api/cost/export): the page's range, currency and measure, and the
 *  table's grouping as the ledger is asked for it (a filter's dimension included; the export holds every value). */
function costExportHref(c, groupBy, today = costToday()) {
  const r = costRangeDays(c, today);
  const q = new URLSearchParams({ format: 'csv', from: r.from, to: r.to, groupBy: groupBy.join(',') });
  q.set('measure', c.measure === 'billed' ? 'billed' : 'list');
  if (c.cur && c.cur !== 'USD') q.set('currency', c.cur);
  return `/api/cost/export?${q}`;
}
```

In `costPaintTable`, replace

```js
  host.innerHTML = `<div class="cost-table-bar"><span>Group by (up to 4):</span>${picks}${chip}${left}</div>
```

with

```js
  const exportLink = `<a class="btn ghost cost-export" href="${esc(costExportHref(COST.controls, plan.query))}" download>Export CSV</a>`;
  host.innerHTML = `<div class="cost-table-bar"><span>Group by (up to 4):</span>${picks}${chip}${left}${exportLink}</div>
```

(the second line of that template, `<div class="table-wrap">…`, stays as it is) and in `module.exports`, after
`costTablePlan,` add `costExportHref,`.

Append to `public/styles.css`:

```css
/* The Breakdown table's Export CSV link sits at the end of its bar. */
.cost-table-bar .cost-export {
  margin-left: auto;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/cost-export-ui.test.js test/cost-ui.test.js`
Expected: PASS (2 new tests; the S1 audit of `costview.js` still passes).

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check public/costview.js test/cost-export-ui.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add public/costview.js public/styles.css test/cost-export-ui.test.js
git commit -m "Breakdown: an Export CSV link with the table's range, grouping, currency and measure"
```

---
### Task 5: the digest setting (`cost.digest`, Settings → Weekly digest)

**Files:**
- Modify: `lib/cost/rules.js` (`FIELDS` at 11, `defaults` at 23, the end of `validate` at 177)
- Modify: `public/costsettings.js` (`COST_SET_PANELS`/`COST_SET_FORMS` at 11–17, `costSetFromSaved` at 52,
  `costSetBody` at 72–79, `COST_SET.open` at 166, `COST_SET_EMPTY` at 195, the Save message at 387, a new panel before
  "panel: restate" at 985, the exports)
- Modify: `test/cost-rules.test.js` (the normalized value at 67–73) and `test/cost-api.test.js` (the default
  settings at 149), on purpose: the settings value now holds `digest`; `test/cost-settings-ui.test.js` (the panel
  count at 185–186 and the bodies at 1076–1077)
- Test: `test/cost-digest-settings.test.js` (create)

**Interfaces:**
- Consumes: `validate`, `settingsOf`, `defaults`, `SETTINGS_INVALID` (`lib/cost/rules.js`); `POST /api/cost/settings`
  (saves `r.value`, so `digest` is stored normalized); the Settings frame (`COST_SET_BODIES`, `COST_SET_ACTIONS`,
  `costSetEdit`, `costSetPaintPanel`, `costSetFromSaved`, `costSetBody`).
- Produces: `settingsOf(raw).value.digest` = `{ enabled }` (D1); `GET /api/cost/settings` answers it; a Save of any
  panel sends the saved `digest`; `costSetDigestHtml(st)` and the action `digest-on`. Task 7 reads
  `settingsOf(costSettings()).value.digest.enabled`.

- [ ] **Step 1: Write the failing test**

Create `test/cost-digest-settings.test.js`:

```js
// Cost Control 5: the weekly digest setting, config.json "cost.digest" ({ enabled }, off by default). Validated with
// the cost settings (lib/cost/rules.js), saved through POST /api/cost/settings, and edited in Settings → Cost's
// "Weekly digest" panel (public/costsettings.js), whose Save sends the saved settings with only `digest` replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const R = require('../lib/cost/rules');
const { createCostApi } = require('../lib/cost/api');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const V = require('../public/costview');
Object.assign(global, V);
const U = require('../public/costsettings');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const SOURCES = ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab'];

test('rules: the digest is off by default, a boolean when set, and anything else names the field', () => {
  assert.deepEqual(R.defaults().digest, { enabled: false });
  assert.deepEqual(R.validate({}).value.digest, { enabled: false });
  assert.deepEqual(R.validate({ digest: { enabled: true } }).value.digest, { enabled: true });
  assert.deepEqual(R.validate({ digest: null }).value.digest, { enabled: false });
  for (const bad of [{ enabled: 'yes' }, {}, { enabled: true, day: 'monday' }, [], 'on'])
    assert.deepEqual(R.validate({ digest: bad }).errors, ['digest: { "enabled": true or false }'], JSON.stringify(bad));
  const s = R.settingsOf({ digest: { enabled: 1 } });
  assert.equal(s.error, R.SETTINGS_INVALID, 'a bad digest makes the section invalid, as any field does');
  assert.deepEqual(s.value.digest, { enabled: false });
});

test('api: the settings answer carries the digest and a Save stores it normalized', async () => {
  let saved = { centers: [{ id: 'acme', name: 'Acme' }] };
  const api = createCostApi({
    cost: { retag: () => {} },
    settings: { get: () => saved, save: (v) => (saved = v) },
    home: HOME,
  });
  const call = async (method, body) => {
    const r = await api.route({
      method,
      path: '/api/cost/settings',
      query: new URLSearchParams(),
      contentType: 'application/json',
      readBody: async () => JSON.stringify(body),
    });
    return r;
  };
  assert.deepEqual((await call('GET')).body.settings.digest, { enabled: false });
  const ok = await call('POST', { ...saved, digest: { enabled: true } });
  assert.equal(ok.status, 200);
  assert.deepEqual(saved.digest, { enabled: true });
  assert.deepEqual((await call('GET')).body.settings.digest, { enabled: true });
  const bad = await call('POST', { ...saved, digest: { enabled: 'on' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.reasons, ['digest: { "enabled": true or false }']);
});

test('settings page: the Weekly digest panel, its Off and On, its Save body, and other Saves keep it', () => {
  assert.deepEqual(
    U.COST_SET_PANELS.map(([p]) => p),
    ['rules', 'billing', 'currency', 'digest', 'restate'],
  );
  assert.deepEqual(U.COST_SET_PANELS[3], ['digest', 'Weekly digest']);
  const saved = {
    centers: [],
    keyCenters: {},
    folderRules: [],
    billing: {},
    currency: null,
    digest: { enabled: true },
  };
  assert.deepEqual(U.costSetFromSaved('digest', saved, SOURCES), { digest: { enabled: true } });
  assert.deepEqual(U.costSetFromSaved('digest', {}, SOURCES), { digest: { enabled: false } });
  const body = U.costSetBody('digest', saved, { digest: { enabled: false } }, SOURCES);
  assert.deepEqual(body, { ...saved, digest: { enabled: false } });
  assert.deepEqual(
    U.costSetBody('rules', saved, U.costSetFromSaved('rules', saved, SOURCES), SOURCES).digest,
    { enabled: true },
    'a rules Save sends the saved digest',
  );
  assert.deepEqual(U.costSetBody('billing', {}, U.costSetFromSaved('billing', {}, SOURCES), SOURCES).digest, {
    enabled: false,
  });
  assert.equal(U.costSetDirty('digest', saved, { digest: { enabled: false } }, SOURCES), true);
  assert.equal(U.costSetDirty('digest', saved, { digest: { enabled: true } }, SOURCES), false);
  const st = { answer: { settings: saved, sources: SOURCES }, drafts: {} };
  const html = U.costSetDigestHtml(st);
  assert.match(html, /data-cost-set-act="digest-on" data-on="off" aria-pressed="false">Off</);
  assert.match(html, /data-cost-set-act="digest-on" data-on="on" aria-pressed="true">On</);
  assert.match(html, /no project folders and no text/);
  assert.match(html, /href="#settings\/monitors"/);
  assert.match(
    U.costSetDigestHtml({ ...st, drafts: { digest: { digest: { enabled: false } } } }),
    /data-on="off" aria-pressed="true"/,
  );
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-digest-settings.test.js`
Expected: FAIL (`unknown field: digest`; `costSetDigestHtml` is not a function).

- [ ] **Step 3: Validate the field**

In `lib/cost/rules.js` replace

```js
// `budgets` is validated on its own (lib/cost/budgets.js): a bad budget never makes the cost settings invalid.
const FIELDS = ['centers', 'keyCenters', 'folderRules', 'billing', 'currency', 'budgets'];
```

with

```js
// `budgets` is validated on its own (lib/cost/budgets.js): a bad budget never makes the cost settings invalid.
// `digest` is the weekly digest (Cost Control 5): { enabled }, off unless the owner turns it on.
const FIELDS = ['centers', 'keyCenters', 'folderRules', 'billing', 'currency', 'budgets', 'digest'];
```

replace `const defaults = () => ({ centers: [], keyCenters: {}, folderRules: [], billing: {}, currency: null });` with

```js
const defaults = () => ({
  centers: [],
  keyCenters: {},
  folderRules: [],
  billing: {},
  currency: null,
  digest: { enabled: false },
});
```

and in `validate`, right before its last line `return errors.length ? { ok: false, … } : { ok: true, value: out };`
add

```js
  const digest = input.digest ?? { enabled: false };
  if (!isObject(digest) || Object.keys(digest).some((k) => k !== 'enabled') || typeof digest.enabled !== 'boolean')
    errors.push('digest: { "enabled": true or false }');
  else out.digest = { enabled: digest.enabled };
```

- [ ] **Step 4: Update the two shape assertions**

`test/cost-rules.test.js`, in "validate: a full valid section is normalized": after the expected
`currency: { code: 'IDR', rates: [ … ] },` line of `assert.deepEqual(r.value, { … })` add `digest: { enabled: false },`.

`test/cost-api.test.js`: replace

```js
  assert.deepEqual(got.body.settings, { centers: [], keyCenters: {}, folderRules: [], billing: {}, currency: null });
```

with

```js
  assert.deepEqual(got.body.settings, {
    centers: [],
    keyCenters: {},
    folderRules: [],
    billing: {},
    currency: null,
    digest: { enabled: false },
  });
```

- [ ] **Step 5: The Weekly digest panel**

In `public/costsettings.js`:
- `COST_SET_PANELS`: after `['currency', 'Display currency'],` add `['digest', 'Weekly digest'],`.
- `COST_SET_FORMS`: `['rules', 'billing', 'currency', 'digest']`.
- `costSetFromSaved`: right before `const c = s.currency;` add

```js
  if (panel === 'digest') return { digest: { enabled: !!(s.digest && s.digest.enabled === true) } };
```

- `costSetBody`: in `base`, after `currency: s.currency ?? null,` add `digest: s.digest || { enabled: false },`; and
  right after the `base` object's closing `};` add

```js
  if (panel === 'digest') return { ...base, digest: { enabled: draft.digest.enabled === true } };
```

- `COST_SET.open`: `{ rules: true, billing: true, currency: true, digest: true, restate: false }`.
- `COST_SET_EMPTY`: add `digest: { enabled: false }` (written out one field per line, as Prettier puts it):

```js
const COST_SET_EMPTY = Object.freeze({
  centers: [],
  keyCenters: {},
  folderRules: [],
  billing: {},
  currency: null,
  digest: { enabled: false },
});
```

- The Save message in `costSetSaveRun`: replace
  `panel === 'currency' ? { tone: 'ok', text: 'Saved.' } : { tone: 'ok', text: COST_SET_APPLIES, restate: true };` with

```js
        panel === 'currency' || panel === 'digest'
          ? { tone: 'ok', text: 'Saved.' }
          : { tone: 'ok', text: COST_SET_APPLIES, restate: true };
```

- Right before `/* ---------- panel: restate ---------- */` add

```js
/* ---------- panel: weekly digest ---------- */

const COST_SET_DIGEST_NOTE =
  'Every Monday, a summary of the week before (Monday to Sunday): usage value and paid, the change against the week before, the top 3 cost centers and models, the budgets used up or projected over, the anomalies and the top recommendation. It goes to the desktop notification and, when one is set, to the Monitors webhook. It holds numbers and names only: no project folders and no text.';

function costSetDigestHtml(st) {
  const a = st.answer || {};
  const on = (st.drafts.digest || costSetFromSaved('digest', a.settings, a.sources)).digest.enabled === true;
  const seg = [
    ['off', 'Off'],
    ['on', 'On'],
  ]
    .map(
      ([v, text]) =>
        `<button type="button" data-cost-set-act="digest-on" data-on="${v}" aria-pressed="${on === (v === 'on')}">${text}</button>`,
    )
    .join('');
  return `<div class="segmented" role="group" aria-label="Weekly digest">${seg}</div>
    <p class="cost-note">${esc(COST_SET_DIGEST_NOTE)}</p>
    <p class="cost-note"><a href="#settings/monitors">Desktop and webhook: Settings → Monitors</a></p>`;
}
Object.assign(COST_SET_ACTIONS, {
  'digest-on': (b) => {
    costSetEdit('digest', (d) => (d.digest.enabled = b.dataset.on === 'on'));
    costSetPaintPanel('digest');
  },
});
COST_SET_BODIES.digest = costSetDigestHtml;
```

- In `module.exports`, after `costSetCurrencyHtml,` add `costSetDigestHtml,`.

`test/cost-settings-ui.test.js`: in "while the settings do not read" replace
`assert.equal((html.match(/data-cost-set-panel="/g) || []).length, 4);` and the next line's
`for (const p of ['rules', 'billing', 'currency']) {` with `…length, 5);` and
`for (const p of ['rules', 'billing', 'currency', 'digest']) {`; in "costsettings.js builds no markup …" replace
`['billing', 'currency', 'restate', 'rules']` with `['billing', 'currency', 'digest', 'restate', 'rules']` and
`for (const p of ['rules', 'billing', 'currency', 'restate'])` with
`for (const p of ['rules', 'billing', 'currency', 'digest', 'restate'])`.

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/cost-digest-settings.test.js test/cost-rules.test.js test/cost-api.test.js test/cost-settings-ui.test.js test/cost-settings-api.test.js test/cost-budgets*.test.js`
Expected: PASS (3 new tests).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check public/costsettings.js test/cost-digest-settings.test.js test/cost-api.test.js test/cost-settings-ui.test.js`
Expected: `All matched files use Prettier code style!` (`lib/cost/rules.js` and `test/cost-rules.test.js` already differ
on `b96b704`, in `settingsOf` and elsewhere: check your lines only.)

- [ ] **Step 8: Commit**

```bash
git add lib/cost/rules.js public/costsettings.js test/cost-digest-settings.test.js test/cost-rules.test.js test/cost-api.test.js test/cost-settings-ui.test.js
git commit -m "Cost settings: a weekly digest switch, off by default, with its own panel"
```

---
### Task 6: the digest figures and its two messages

**Files:**
- Modify: `lib/cost/report.js` (Task 2's file: requires, and the digest section replacing `module.exports`)
- Modify: `lib/monitors/channels.js` (requires at 11, after `sleepFor` at 87, `sendDesktop` at 249–261,
  `sendWebhook` at 304–311, `desktopLimited` at 350–363, `webhookLimited` at 382–384, before `test` at 421, the
  return and exports at 432–435)
- Test: `test/cost-digest.test.js` (create; Task 7 appends to it)

**Interfaces:**
- Consumes: `F.weekday(day)`, `F.dailyModel(series, { today, unread, since })` (`lib/cost/forecast.js`),
  `A.measureDay(rows, { model, day, history })`, `A.isAnomaly(m, params)` (`lib/cost/anomaly.js`), as
  `recentDays` uses them; `isDay` (`lib/cost/days.js`); the channel bounds `desktopLimited`, `webhookLimited`,
  `current()` inside `createChannels`.
- Produces:
  - `lib/cost/report.js`: `DIGEST_HISTORY` (28), `lastWeek(today) → { from, to }`,
    `digestFigures({ rows, unread, week, since, centers, budgets, anomalyParams, recommendation }) → { week, totals,
    change, centers, models, budgets, anomalies, recommendation }` (D3; throws when a month of the two weeks did not
    read).
  - `lib/monitors/channels.js`: exports `digestLine(d)`, `digestBody(d)` (D4); `createChannels(…).digest(d) →
    Promise<{ desktop, webhook, tried, ok, errors }>` (no logging: the scheduler logs). `sendDesktop`,
    `desktopLimited`, `sendWebhook`, `webhookLimited` take an optional prebuilt message; alerts behave as before.

- [ ] **Step 1: Write the failing test**

Create `test/cost-digest.test.js`:

```js
// Cost Control 5: the weekly digest. Its figures (lib/cost/report.js lastWeek, digestFigures), its desktop line and
// webhook body (lib/monitors/channels.js), and (Task 7, appended below) its scheduler (lib/cost/digest.js). No real
// notification and no network: a fake spawn and a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const R = require('../lib/cost/report');
const { createChannels, digestLine, digestBody } = require('../lib/monitors/channels');
const { secretsFor } = require('./helpers');
const { addDays, daysBetween } = require('../lib/cost/days');

const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  model: 'claude-sonnet-5-5',
  project: '~/secret-client/app',
  center: 'acme',
  keyId: 'key_a',
  kind: 'chat',
  requests: 1,
  tokens: {},
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
// Thursday 29 October 2026: last week is Monday 19 to Sunday 25 October.
const TODAY = '2026-10-29';
const WEEK = { from: '2026-10-19', to: '2026-10-25' };
// Four quiet weeks of $1 a day before last week, then last week at $2 a day with a $30 spike on the 21st.
function ledger() {
  const rows = [];
  for (const day of daysBetween(addDays(WEEK.from, -28), WEEK.to)) {
    const lastWeek = day >= WEEK.from;
    rows.push(row(day, { listUSD: lastWeek ? 2 : 1, billedUSD: lastWeek ? 2 : 1 }));
  }
  rows.push(row('2026-10-21', { model: 'claude-opus-5-5', center: 'lab', listUSD: 30, billedUSD: 30 }));
  rows.push(row('2026-10-20', { center: null, kind: 'plan', model: null, requests: 0, listUSD: 0, billedUSD: 6.5 }));
  return rows;
}
const FIG = (over = {}) =>
  R.digestFigures({
    rows: ledger(),
    week: WEEK,
    since: addDays(WEEK.from, -28),
    centers: [
      { id: 'acme', name: 'Client: Acme' },
      { id: 'lab', name: 'Lab' },
    ],
    budgets: [
      { id: 'team', name: 'Team', state: 'warn_80', projected: true, percent: 84.2, enforce: 'block' },
      { id: 'quiet', name: 'Quiet', state: 'ok', projected: false, percent: 10 },
      { id: 'acme', name: 'Key Acme app', state: 'exceeded', projected: false, percent: 120 },
    ],
    anomalyParams: { ratio: 2, minUSD: 1 },
    recommendation: { model: 'claude-opus-5-5', candidate: 'claude-sonnet-5-5', savingUSD: 42.4, spendUSD: 100 },
    ...over,
  });

test('last week: Monday to Sunday before the current week', () => {
  assert.deepEqual(R.lastWeek(TODAY), WEEK);
  assert.deepEqual(R.lastWeek('2026-10-26'), WEEK, 'on a Monday');
  assert.deepEqual(R.lastWeek('2026-11-01'), WEEK, 'on a Sunday');
  assert.deepEqual(R.lastWeek('2027-01-04'), { from: '2026-12-28', to: '2027-01-03' });
});

test('figures: totals, the change, top centers and models, budgets at risk, anomalies, the recommendation', () => {
  const f = FIG();
  assert.deepEqual(f.week, WEEK);
  assert.deepEqual(f.totals, { listUSD: 44, billedUSD: 50.5 }, 'paid counts the plan fee');
  assert.deepEqual(f.change, { listUSD: 37, percent: 528.6 });
  assert.deepEqual(f.centers, [
    { id: 'lab', name: 'Lab', listUSD: 30 },
    { id: 'acme', name: 'Client: Acme', listUSD: 14 },
  ]);
  assert.deepEqual(f.models, [
    { model: 'claude-opus-5-5', listUSD: 30 },
    { model: 'claude-sonnet-5-5', listUSD: 14 },
  ]);
  assert.deepEqual(
    f.budgets.map((b) => b.id),
    ['team', 'acme'],
  );
  assert.ok(!('enforce' in f.budgets[0]));
  assert.ok(f.anomalies.some((a) => a.day === '2026-10-21' && a.spentUSD === 32));
  assert.deepEqual(f.recommendation, { model: 'claude-opus-5-5', candidate: 'claude-sonnet-5-5', savingUSD: 42.4 });
  assert.doesNotMatch(JSON.stringify(f), /secret-client/, 'no project folder');
  const strict = FIG({ anomalyParams: { ratio: 50, minUSD: 1 } });
  assert.deepEqual(strict.anomalies, [], 'the rule’s saved parameters decide');
  assert.equal(
    FIG({ rows: ledger().filter((r) => r.day >= WEEK.from) }).change.percent,
    null,
    'nothing the week before',
  );
  assert.equal(FIG({ recommendation: null }).recommendation, null);
  assert.throws(() => FIG({ unread: ['2026-10'] }), /the ledger could not read 2026-10/);
  assert.doesNotThrow(() => FIG({ unread: ['2026-08'] }), 'an older month only weakens the anomaly history');
});

test('the desktop line and the webhook body: numbers and names only, never a project folder or text', () => {
  const f = FIG();
  assert.equal(digestLine(f), 'ZAAFPulse weekly cost: $44.00 (+529 %), 2 budgets at risk, 1 anomaly');
  assert.equal(
    digestLine({ totals: { listUSD: 1412.3 }, change: { percent: -12.4 }, budgets: [{}], anomalies: [{}, {}] }),
    'ZAAFPulse weekly cost: $1,412.30 (-12 %), 1 budget at risk, 2 anomalies',
  );
  assert.equal(
    digestLine({ totals: { listUSD: 3 }, change: { percent: null } }),
    'ZAAFPulse weekly cost: $3.00, 0 budgets at risk, 0 anomalies',
  );
  const body = digestBody({
    ...f,
    centers: [{ id: 'acme', name: 'Acme\nInjected', listUSD: 1, project: '~/secret-client/app' }],
    extra: 'text',
  });
  assert.deepEqual(Object.keys(body), [
    'type',
    'week',
    'totals',
    'change',
    'centers',
    'models',
    'budgets',
    'anomalies',
    'recommendation',
  ]);
  assert.equal(body.type, 'cost_digest');
  assert.deepEqual(body.centers, [{ id: 'acme', name: 'Acme Injected', listUSD: 1 }]);
  assert.doesNotMatch(JSON.stringify(body), /secret-client|text/);
});

// A spawn that records each call and plays a child that exits cleanly (or fails).
function recorder(mode = 'ok') {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    calls.push({ cmd, args, opts });
    child.kill = () => {};
    setImmediate(() => child.emit('close', mode === 'fail' ? 1 : 0));
    return child;
  };
  return { calls, spawn };
}
const make = ({ settings, spawn, fetchImpl }) =>
  createChannels({
    spawn,
    fetchImpl,
    secrets: secretsFor({ HOOK: 'https://hooks.example/x' }),
    settings: () => settings,
    platform: 'darwin',
    sleep: () => Promise.resolve(),
  });

test('channels: the digest goes to the desktop as one line and to the webhook as its own body', async () => {
  const r = recorder();
  const sent = [];
  const fetchImpl = async (url, opts) => (sent.push({ url, body: JSON.parse(opts.body) }), { ok: true, status: 200 });
  const ch = make({ settings: { desktop: true, webhook: { url: { env: 'HOOK' } } }, spawn: r.spawn, fetchImpl });
  const out = await ch.digest(FIG());
  assert.deepEqual([out.desktop, out.webhook, out.tried, out.ok], [true, true, 2, true]);
  assert.deepEqual(r.calls[0].args.slice(-2), [
    'ZAAFPulse',
    'ZAAFPulse weekly cost: $44.00 (+529 %), 2 budgets at risk, 1 anomaly',
  ]);
  assert.equal(sent[0].url, 'https://hooks.example/x');
  assert.equal(sent[0].body.type, 'cost_digest');
  assert.doesNotMatch(JSON.stringify(sent[0].body), /secret-client/);

  const none = make({ settings: { desktop: false, webhook: null }, spawn: r.spawn, fetchImpl });
  assert.deepEqual(await none.digest(FIG()), { desktop: false, webhook: false, tried: 0, ok: false, errors: [] });
  const down = make({
    settings: { desktop: true, webhook: { url: { env: 'HOOK' } } },
    spawn: recorder('fail').spawn,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  const failed = await down.digest(FIG());
  assert.deepEqual([failed.ok, failed.tried, failed.errors.length], [false, 2, 2]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-digest.test.js`
Expected: FAIL (`R.lastWeek is not a function`; `digestLine` is undefined).

- [ ] **Step 3: The figures in `lib/cost/report.js`**

After `const { UNASSIGNED } = require('./rules');` add

```js
const F = require('./forecast');
const A = require('./anomaly');
```

and replace the last line `module.exports = { TOP, OTHER, PLAN, NONE, monthRange, reportMonths, defaultMonth, showback };`
with

```js
/* ---------- the weekly digest (Cost Control 5) ---------- */

const DIGEST_TOP = 3;
// The rows the digest reads before last Monday: the four weeks each of its days is measured against.
const DIGEST_HISTORY = 28;

/** Last week, Monday to Sunday (Monday is a week's first day, as for budgets). */
function lastWeek(today) {
  const monday = addDays(today, -F.weekday(today));
  return { from: addDays(monday, -7), to: addDays(monday, -1) };
}

// The top `n` values of a dimension by usage value, with more than nothing spent.
function topBy(rows, valueOf, n) {
  const m = new Map();
  for (const r of rows) {
    const v = valueOf(r);
    if (v != null) m.set(v, (m.get(v) || 0) + num(r.listUSD));
  }
  return [...m.entries()]
    .filter(([, usd]) => round8(usd) > 0)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, n)
    .map(([value, usd]) => [value, round8(usd)]);
}

/**
 * Last week's figures for the digest (D3). `rows` are cost.budgetRows of [week.from − 28, week.to] and `unread` what
 * that read skipped; a month of the two weeks that did not read throws (no partial digest). `budgets` are the
 * evaluated views (now), `anomalyParams` the cost_anomaly rule's saved parameters, `since` the ledger's first day,
 * `recommendation` the first item of the Value page's recommendations, or null. Numbers and names only.
 */
function digestFigures({
  rows = [],
  unread = [],
  week,
  since = null,
  centers = [],
  budgets = [],
  anomalyParams = null,
  recommendation = null,
}) {
  const prev = { from: addDays(week.from, -7), to: addDays(week.from, -1) };
  const gap = (unread || []).filter(
    (u) => u === 'folder' || u === 'corrections' || (u >= monthOf(prev.from) && u <= monthOf(week.to)),
  );
  if (gap.length) throw new Error(`the ledger could not read ${gap.join(', ')}`);
  const inWeek = (r, w) => r && r.day >= w.from && r.day <= w.to;
  const use = (rows || []).filter((r) => r && r.kind !== 'plan');
  const mine = use.filter((r) => inWeek(r, week));
  const listUSD = round8(mine.reduce((a, r) => a + num(r.listUSD), 0));
  const billedUSD = round8((rows || []).filter((r) => inWeek(r, week)).reduce((a, r) => a + num(r.billedUSD), 0));
  const before = round8(use.filter((r) => inWeek(r, prev)).reduce((a, r) => a + num(r.listUSD), 0));
  const names = new Map((centers || []).map((c) => [c.id, c.name]));
  const series = use.map((r) => ({ day: r.day, usd: num(r.listUSD) }));
  const anomalies = [];
  for (const day of daysBetween(week.from, week.to)) {
    const model = F.dailyModel(series, { today: day, unread, since });
    const m = A.measureDay(use, { model, day, history: use });
    if (A.isAnomaly(m, anomalyParams)) anomalies.push({ day, spentUSD: m.spentUSD, expectedUSD: m.expectedUSD });
  }
  const r = recommendation;
  return {
    week: { from: week.from, to: week.to },
    totals: { listUSD, billedUSD },
    change: {
      listUSD: round8(listUSD - before),
      percent: before > 0 ? Math.round(((listUSD - before) / before) * 1000) / 10 : null,
    },
    centers: topBy(mine, (x) => x.center || UNASSIGNED, DIGEST_TOP).map(([id, usd]) => ({
      id,
      name: id === UNASSIGNED ? 'Unassigned' : names.get(id) || id,
      listUSD: usd,
    })),
    models: topBy(mine, (x) => x.model, DIGEST_TOP).map(([model, usd]) => ({ model, listUSD: usd })),
    budgets: (budgets || [])
      .filter((b) => b && (b.state === 'exceeded' || b.projected === true))
      .map((b) => ({ id: b.id, name: b.name, state: b.state, projected: b.projected === true, percent: b.percent })),
    anomalies,
    recommendation: r ? { model: r.model, candidate: r.candidate, savingUSD: r.savingUSD } : null,
  };
}

module.exports = {
  TOP,
  OTHER,
  PLAN,
  NONE,
  DIGEST_HISTORY,
  monthRange,
  reportMonths,
  defaultMonth,
  showback,
  lastWeek,
  digestFigures,
};
```

- [ ] **Step 4: The messages in `lib/monitors/channels.js`**

After `const { maskTitle } = require('../trace/model');` add `const { isDay } = require('../cost/days');`.

After `const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));` add (a blank line first)

```js
// The weekly cost digest (Cost Control 5): one desktop line, and the webhook's one other body. Names are clipped and
// free of control characters; everything else is a number or null. No project folder and no text ever goes in.
const nameOf = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80) : null);
const listOf = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
function digestLine(d) {
  const t = (d && d.totals) || {};
  const amount = (isNum(t.listUSD) ? t.listUSD : 0).toLocaleString('en', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const p = d && d.change && isNum(d.change.percent) ? Math.round(d.change.percent) : null;
  const change = p === null ? '' : ` (${p >= 0 ? '+' : '-'}${Math.abs(p)} %)`;
  const b = listOf(d && d.budgets, 100).length;
  const a = listOf(d && d.anomalies, 7).length;
  return `ZAAFPulse weekly cost: $${amount}${change}, ${b} budget${b === 1 ? '' : 's'} at risk, ${a} anomal${a === 1 ? 'y' : 'ies'}`;
}
function digestBody(d) {
  const w = (d && d.week) || {};
  const t = (d && d.totals) || {};
  const c = (d && d.change) || {};
  const r = d && d.recommendation;
  return {
    type: 'cost_digest',
    week: { from: isDay(w.from) ? w.from : null, to: isDay(w.to) ? w.to : null },
    totals: { listUSD: num(t.listUSD), billedUSD: num(t.billedUSD) },
    change: { listUSD: num(c.listUSD), percent: num(c.percent) },
    centers: listOf(d && d.centers, 3).map((x) => ({
      id: nameOf(x.id),
      name: nameOf(x.name),
      listUSD: num(x.listUSD),
    })),
    models: listOf(d && d.models, 3).map((x) => ({ model: nameOf(x.model), listUSD: num(x.listUSD) })),
    budgets: listOf(d && d.budgets, 100).map((x) => ({
      id: nameOf(x.id),
      name: nameOf(x.name),
      state: nameOf(x.state),
      projected: x.projected === true,
      percent: num(x.percent),
    })),
    anomalies: listOf(d && d.anomalies, 7).map((x) => ({
      day: isDay(x.day) ? x.day : null,
      spentUSD: num(x.spentUSD),
      expectedUSD: num(x.expectedUSD),
    })),
    recommendation:
      r && typeof r === 'object'
        ? { model: nameOf(r.model), candidate: nameOf(r.candidate), savingUSD: num(r.savingUSD) }
        : null,
  };
}
```

Then, inside `createChannels`:
- replace `  function sendDesktop(alert, sessionTitle) {` with

```js
  // `fixed` is a prebuilt { title, text } (the digest); otherwise the alert's own words.
  function sendDesktop(alert, sessionTitle, fixed = null) {
```

  and in it `const msg = textOf(alert, sessionTitle);` with `const msg = fixed || textOf(alert, sessionTitle);`;
- replace `  async function sendWebhook(alert, cfg, { retries = BACKOFF_MS.length } = {}) {` with

```js
  // `body` is a prebuilt JSON text (the digest); otherwise the alert's seven fields.
  async function sendWebhook(alert, cfg, { retries = BACKOFF_MS.length, body: prebuilt = null } = {}) {
```

  and in it `const body = JSON.stringify(payloadOf(alert));` with `const body = prebuilt || JSON.stringify(payloadOf(alert));`;
- replace

```js
  async function desktopLimited(alert, sessionTitle) {
    if (!textOf(alert, sessionTitle)) return { ok: false, skipped: true }; // no_data and snoozed show nothing
```

  with

```js
  async function desktopLimited(alert, sessionTitle, fixed = null) {
    if (!fixed && !textOf(alert, sessionTitle)) return { ok: false, skipped: true }; // no_data and snoozed show nothing
```

  and in it `return await sendDesktop(alert, sessionTitle);` with `return await sendDesktop(alert, sessionTitle, fixed);`;
- replace

```js
  function webhookLimited(alert, cfg) {
    return new Promise((resolve) => {
      webhookQueue.push({ run: () => sendWebhook(alert, cfg), resolve });
```

  with

```js
  function webhookLimited(alert, cfg, body = null) {
    return new Promise((resolve) => {
      webhookQueue.push({ run: () => sendWebhook(alert, cfg, { body }), resolve });
```

- right before `  // One try, so the owner sees the outcome of the button at once instead of after the backoff.` add

```js
  // The weekly cost digest through the same bounds. Not logged here: the scheduler (lib/cost/digest.js) logs a failed
  // week once. `tried` counts the channels that are on; `ok` is true when at least one of them delivered.
  async function digest(d) {
    const out = { desktop: false, webhook: false, tried: 0, ok: false, errors: [] };
    if (!d || typeof d !== 'object') return out;
    const cfg = current();
    const jobs = [];
    if (cfg.desktop !== false) {
      out.tried++;
      jobs.push(
        desktopLimited(null, null, { title: 'ZAAFPulse', text: digestLine(d) }).then((r) => {
          out.desktop = r.ok;
          if (!r.ok) out.errors.push(r.skipped ? 'desktop: busy' : `desktop: ${r.error}`);
        }),
      );
    }
    if (cfg.webhook && cfg.webhook.url) {
      out.tried++;
      jobs.push(
        webhookLimited(null, cfg.webhook, JSON.stringify(digestBody(d))).then((r) => {
          out.webhook = r.ok;
          if (!r.ok) out.errors.push(r.skipped ? 'webhook: dropped' : `webhook: ${r.error}`);
        }),
      );
    }
    await Promise.all(jobs);
    out.ok = out.desktop || out.webhook;
    return out;
  }
```

- replace `  return { notify, test };` with `  return { notify, test, digest };` and the last line with

```js
module.exports = { createChannels, checkWebhookUrl, parseHeaders, digestLine, digestBody, WINDOWS_SCRIPT };
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/cost-digest.test.js test/cost-report.test.js test/monitors-channels.test.js test/monitors-engine.test.js`
Expected: PASS (5 new tests; every channel test unchanged).

- [ ] **Step 6: Check the style**

Run: `npx prettier@3 --check lib/cost/report.js lib/monitors/channels.js test/cost-digest.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 7: Commit**

```bash
git add lib/cost/report.js lib/monitors/channels.js test/cost-digest.test.js
git commit -m "Cost digest: last week's figures, its desktop line and its webhook body"
```

---
### Task 7: the digest scheduler (`lib/cost/digest.js`) and its wiring

**Files:**
- Create: `lib/cost/digest.js`
- Modify: `lib/cost/api.js` (the `return { route };` at the end of `createCostApi`)
- Modify: `server.js` (requires after 60; `costTick` at 818–824)
- Test: `test/cost-digest.test.js` (append)

**Interfaces:**
- Consumes: `lastWeek` (Task 6), `settingsOf` (`lib/cost/rules.js`, `value.digest` from Task 5), `writePrivate`
  (`lib/cost/files.js`: 0600, temp file + rename, creates the folder), `dayOf`, `isDay`; in `server.js`:
  `costSettings()` (raw cost section, false while config.json does not parse), `cost.budgetRows`, `cost.firstDay()`,
  `costBudgets.evaluate()`, `monitorApiState.settings('cost_anomaly').params` (as `anomalyParams` already reads it),
  `monitorChannels.digest(d)` (Task 6), `digestFigures`, `DIGEST_HISTORY` (Task 6).
- Produces: `createDigest({ file, getSettings, figures, send, demo, now, log }) → { check() → Promise<{ sent, week? }> }`
  (D2); `createCostApi(…)` returns `{ route, recommendations }`, `recommendations()` = today's Value-page
  recommendations or null.

- [ ] **Step 1: Write the failing tests**

Append to `test/cost-digest.test.js`:

```js
/* ---------- the scheduler (lib/cost/digest.js) ---------- */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDigest } = require('../lib/cost/digest');

const at = (y, m, d, h = 9) => new Date(y, m, d, h).getTime();
function scheduler({ enabled = true, result = { ok: true, tried: 1 }, figures, demo = false, file } = {}) {
  const st = { t: at(2026, 9, 26), settings: { digest: { enabled } }, sends: [], logs: [], result };
  const d = createDigest({
    file,
    getSettings: () => st.settings,
    figures: figures || ((week) => ({ week })),
    send: async (f) => (st.sends.push(f.week.from), typeof st.result === 'function' ? st.result() : st.result),
    demo,
    now: () => st.t,
    log: (m) => st.logs.push(m),
  });
  return { d, st };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-digest-')), 'cost', 'digest.json');

test('scheduler: once a week, also across a restart, and a missed Monday still sends that week', async () => {
  const file = tmpFile();
  const a = scheduler({ file });
  assert.deepEqual(await a.d.check(), { sent: true, week: '2026-10-19' }, 'Monday 26 October');
  assert.deepEqual(await a.d.check(), { sent: false });
  a.st.t = at(2026, 9, 28);
  await a.d.check();
  assert.deepEqual(a.st.sends, ['2026-10-19']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { lastWeek: '2026-10-19' });
  const b = scheduler({ file }); // a restart later that week
  b.st.t = at(2026, 9, 30);
  await b.d.check();
  assert.deepEqual(b.st.sends, [], 'the marker holds');
  b.st.t = at(2026, 10, 4, 18); // the next Monday was missed: Wednesday 4 November
  await b.d.check();
  assert.deepEqual(b.st.sends, ['2026-10-26']);
  fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
});

test('scheduler: nothing while disabled or in demo; a broken config.json keeps the last valid setting', async () => {
  const off = scheduler({ enabled: false });
  await off.d.check();
  assert.deepEqual(off.st.sends, []);
  const demo = scheduler({ demo: true });
  await demo.d.check();
  assert.deepEqual(demo.st.sends, [], 'demo mode never sends');
  const on = scheduler();
  on.st.settings = false; // config.json does not parse before any valid read: off
  await on.d.check();
  assert.deepEqual(on.st.sends, []);
  on.st.settings = { digest: { enabled: true } };
  on.st.result = { ok: false, tried: 1, errors: ['webhook: HTTP 500'] };
  await on.d.check();
  on.st.settings = { digest: { enabled: 'yes' } }; // invalid now: the last valid (on) stays
  on.st.result = { ok: true, tried: 1 };
  await on.d.check();
  assert.deepEqual(on.st.sends, ['2026-10-19', '2026-10-19']);
});

test('scheduler: a failed send keeps the marker and is logged once; no channel on settles the week', async () => {
  const file = tmpFile();
  const s = scheduler({ file, result: { ok: false, tried: 2, errors: ['desktop: x', 'webhook: y'] } });
  await s.d.check();
  await s.d.check();
  assert.deepEqual(s.st.sends, ['2026-10-19', '2026-10-19'], 'tried again on the next pass');
  assert.equal(s.st.logs.length, 1);
  assert.match(s.st.logs[0], /week of 2026-10-19 was not sent \(desktop: x; webhook: y\)/);
  assert.equal(fs.existsSync(file), false, 'the marker did not move');
  const bad = scheduler({
    figures: () => {
      throw new Error('the ledger could not read 2026-10');
    },
  });
  await bad.d.check();
  assert.deepEqual(bad.st.sends, []);
  assert.match(bad.st.logs[0], /the ledger could not read 2026-10/);
  const quiet = scheduler({ result: { ok: false, tried: 0, errors: [] } });
  await quiet.d.check();
  await quiet.d.check();
  assert.deepEqual(quiet.st.sends, ['2026-10-19'], 'no channel on: the week is settled, not retried');
  fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
});

test('scheduler: one send at a time while a slow webhook is still trying', async () => {
  let release;
  const s = scheduler({ result: () => new Promise((r) => (release = r)) });
  const first = s.d.check();
  assert.deepEqual(await s.d.check(), { sent: false }, 'busy');
  release({ ok: true, tried: 1 });
  await first;
  assert.deepEqual(s.st.sends, ['2026-10-19']);
});

test("api: recommendations() for the digest is the Value page's answer, or null when it cannot be computed", () => {
  const { createCostApi } = require('../lib/cost/api');
  const settings = { get: () => ({}), save: () => {} };
  const now = () => at(2026, 9, 29);
  const empty = createCostApi({ cost: { budgetRows: () => ({ rows: [], unread: [] }) }, settings, now });
  assert.deepEqual(empty.recommendations().items, []);
  const broken = createCostApi({
    cost: {
      budgetRows: () => {
        throw new Error('the ledger folder could not be read');
      },
    },
    settings,
    now,
  });
  assert.equal(broken.recommendations(), null);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/cost-digest.test.js`
Expected: FAIL (`Cannot find module '../lib/cost/digest'`; `empty.recommendations is not a function`).

- [ ] **Step 3: Create `lib/cost/digest.js`**

```js
// Cost Control 5: the weekly digest's scheduler. After each ledger pass, check() sends last week's digest (Monday to
// Sunday) once: when it is enabled, outside demo mode, with no send in flight, and when last week's Monday is newer than
// the marker <cost dir>/digest.json { lastWeek }. The marker moves only after a send that reached a channel (or when no
// channel is on), so a restart never sends twice and a missed Monday still sends once that week. A week that fails is
// logged once and tried again on the next pass.
const fs = require('fs');
const { dayOf, isDay } = require('./days');
const { settingsOf } = require('./rules');
const { lastWeek } = require('./report');
const { writePrivate } = require('./files');

function createDigest({
  file = null, // <cost dir>/digest.json; null keeps the marker in memory only (tests, demo)
  getSettings = () => undefined, // the raw cost section, false while config.json does not parse
  figures, // (week) => digestFigures(...); throws when the ledger does not read
  send, // (figures) => Promise<{ ok, tried, errors }> (channels.digest)
  demo = false,
  now = Date.now,
  log = () => {},
} = {}) {
  let enabled = false; // the last digest setting that validated
  let sent = null; // the last week sent by this process (kept even if the marker could not be written)
  let failedWeek = null; // the week a failure was logged for
  let busy = false;

  function marker() {
    if (!file) return sent;
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && isDay(v.lastWeek) ? v.lastWeek : null;
    } catch {
      return null; // missing or unreadable: none
    }
  }
  function settled(week) {
    sent = week;
    if (!file) return;
    try {
      writePrivate(file, JSON.stringify({ lastWeek: week }));
    } catch (e) {
      log(`cost digest: the marker could not be written${e && e.code ? ` (${e.code})` : ''}`);
    }
  }
  function failed(week, why) {
    if (failedWeek === week) return;
    failedWeek = week;
    log(`cost digest: the digest for the week of ${week} was not sent (${why}); trying again on the next pass`);
  }

  async function check() {
    if (demo || busy) return { sent: false };
    const s = settingsOf(getSettings());
    if (!s.error) enabled = s.value.digest.enabled === true; // a broken config.json keeps the last valid setting
    if (!enabled) return { sent: false };
    const week = lastWeek(dayOf(now()));
    const last = [marker(), sent].filter(Boolean).sort().pop() || null;
    if (last && last >= week.from) return { sent: false };
    busy = true;
    try {
      let d;
      try {
        d = figures(week);
      } catch (e) {
        failed(week.from, (e && e.message) || 'the figures could not be read');
        return { sent: false };
      }
      const r = await send(d);
      if (r && (r.ok || r.tried === 0)) {
        settled(week.from);
        return { sent: !!r.ok, week: week.from };
      }
      failed(week.from, ((r && r.errors) || []).join('; ') || 'no channel delivered it');
      return { sent: false };
    } finally {
      busy = false;
    }
  }

  return { check };
}

module.exports = { createDigest };
```

- [ ] **Step 4: `recommendations()` on the cost API**

In `lib/cost/api.js` replace the final `  return { route };` of `createCostApi` with

```js
  // The Value page's recommendations for today, or null when they cannot be computed: the weekly digest names the first.
  const recommendations = () => quietly(() => recommendationsFor(dayOf(now())), null)[0];

  return { route, recommendations };
```

- [ ] **Step 5: Wire it in `server.js`**

After `const { dayOf: costDayOf, addDays: costAddDays } = require('./lib/cost/days');` add

```js
const { createDigest } = require('./lib/cost/digest');
const { digestFigures, DIGEST_HISTORY } = require('./lib/cost/report');
const { settingsOf: costSettingsOf } = require('./lib/cost/rules');
```

Replace the whole `costTick` block (its comment
`// The cost ledger pass reads the refreshed index too; …` through
`.catch(() => console.error('cost: the ledger pass failed'));`) with

```js
// The weekly cost digest (Cost Control 5): after a ledger pass, last week's figures once, through the Monitors
// channels (off in demo mode and with ZAAFPULSE_NOTIFY=off). Off unless config.json "cost.digest.enabled".
const costDigest = createDigest({
  file: DEMO ? null : path.join(DIR, '.data', 'cost', 'digest.json'),
  getSettings: costSettings,
  demo: DEMO,
  log: (m) => console.error(m),
  send: (d) => monitorChannels.digest(d),
  figures: (week) => {
    const r = cost.budgetRows({ from: costAddDays(week.from, -DIGEST_HISTORY), to: week.to });
    const quiet = (fn, fallback) => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };
    const rec = costApi.recommendations();
    return digestFigures({
      rows: r.rows,
      unread: r.unread,
      week,
      since: cost.firstDay(),
      centers: costSettingsOf(costSettings(), { home: os.homedir() }).value.centers,
      budgets: quiet(() => costBudgets.evaluate(), []),
      anomalyParams: quiet(() => monitorApiState.settings('cost_anomaly').params, null),
      recommendation: rec && rec.items && rec.items[0] ? rec.items[0] : null,
    });
  },
});
// The cost ledger pass reads the refreshed index too; the budget service drops the gateway calls it read, then the
// budgets are evaluated (alerts, pause), then the digest is checked (not awaited: a webhook may take a while). A
// failure never breaks a refresh.
const costTick = () =>
  Promise.resolve()
    .then(() => costBudgets.pass(() => cost.update()))
    .then(() => monitors.tickBudgets())
    .then(() => void costDigest.check().catch(() => console.error('cost: the weekly digest check failed')))
    .catch(() => console.error('cost: the ledger pass failed'));
```

(`monitorChannels`, `monitorApiState`, `costBudgets` and `costApi` are all defined above this point; the
providers run only after a pass. Demo: `createDigest({ demo: true })` never sends, and the channels are off there
anyway.)

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/cost-digest.test.js test/cost-recommend-api.test.js test/cost-view-api.test.js test/cost-reports-http.test.js test/monitors-engine.test.js`
Expected: PASS (5 new tests; the spawned demo servers still start and answer).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check lib/cost/digest.js lib/cost/api.js test/cost-digest.test.js`
Expected: `All matched files use Prettier code style!` (`server.js`: your lines only.)

- [ ] **Step 8: Commit**

```bash
git add lib/cost/digest.js lib/cost/api.js server.js test/cost-digest.test.js
git commit -m "Cost digest: send last week's digest once after a ledger pass, when it is turned on"
```

---
### Task 8: `acc_cost` and `acc_budgets` on the stdio MCP only

**Files:**
- Create: `lib/cost/reader.js`
- Modify: `lib/cost/ledger.js` (`createLedgerStore` at 159, `writeMonth` at 180, `readMonth` at 204–209,
  `readCorrections` at 236, `addCorrection` at 423)
- Modify: `lib/cost/billing.js` (`createBillingHistory` at 83, `save` at 117, `load` at 139 and 149)
- Modify: `lib/cost/budget-service.js` (options at 46, `persist` at 85)
- Modify: `lib/local.js` (comment at 16, options at 24, the returned object at 90), `lib/connectors/acc.js` (after
  `rangeOf` at 5, the tools list at 85), `mcp.js` (requires at 12, `createLocal` at 35)
- Test: `test/cost-mcp.test.js` (create; ports 9800–9899)

**Interfaces:**
- Consumes: `L.createLedgerStore`, `L.groupRows` (`lib/cost/ledger.js`), `createBillingHistory`, `billedRows`
  (`lib/cost/billing-view.js:12`, `{ from, to, today, billingFor }`), `createBudgetService` (`getSettings`,
  `getLegacy`, `cost { budgetRows, firstDay, planFeeFor }`, `lastFile`), `planFee` (`lib/cost/rules.js`); `tool()`
  (`lib/connectors/base.js:99`); `createIntegrations` (`lib/integrations.js:63`, `checkArgs` checks type and enum,
  not array items); `platform.dataDir()` honours `ZAAFPULSE_DATA`; keys live in `<data>/.data/keys.json`
  (`lib/gateway/index.js:84`).
- Produces:
  - `createLedgerStore({ dir, readOnly })`, `createBillingHistory({ dir, earlierData, readOnly })`,
    `createBudgetService({ …, readOnly })`: with `readOnly`, nothing is written, renamed or set aside (a write
    attempt throws in the store and the billing history).
  - `lib/cost/reader.js`: `createCostReader({ dir, configFile, keysFile, home, now, nocase }) → { spend({ range,
    groupBy }), budgets() }` (M1, M2), `rangeDays(range, today)`, `RANGES`, `DIMS`, `TOP` (50).
  - `createLocal({ …, cost })` returns `cost` when given; `acc` lists `cost` and `budgets` only then.

- [ ] **Step 1: Write the failing test**

Create `test/cost-mcp.test.js`:

```js
// Cost Control 5: acc_cost and acc_budgets. The read-only cost reader (lib/cost/reader.js) writes nothing, the tools are
// shaped and capped, they are on the stdio MCP (mcp.js) only, and neither the server's registry nor gateway /mcp (a
// spawned server.js asked with a gateway key) lists them. Ports 9800-9899 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const L = require('../lib/cost/ledger');
const { createCostReader, rangeDays } = require('../lib/cost/reader');
const { createLocal } = require('../lib/local');
const { createIntegrations } = require('../lib/integrations');
const { createGateway } = require('../lib/gateway');
const { dayOf } = require('../lib/cost/days');
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const NOW = new Date(2026, 9, 22, 15).getTime();
const TODAY = dayOf(NOW);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-mcp-'));
const row = (day, over = {}) => ({
  ...L.newRow({ day, source: 'gateway', provider: 'anthropic', kind: 'chat', center: 'acme', keyId: 'key_a' }),
  model: 'claude-sonnet-5-5',
  requests: 2,
  tokens: { in: 100, out: 10, cacheRead: 5, cacheWrite5m: 1, cacheWrite1h: 1 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
// A data folder as the server leaves it, with what a normal load would rewrite: a bad ledger line, a bad correction
// line, a damaged billing.json beside a good last copy, and no budgets.last.json.
function dataFolder(day = TODAY, models = 3) {
  const data = tmp();
  const dir = path.join(data, '.data', 'cost');
  fs.mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: models }, (_, i) => row(day, { model: `m-${i}`, listUSD: models - i }));
  fs.writeFileSync(
    path.join(dir, `ledger-${day.slice(0, 7)}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n{"torn": \n',
  );
  fs.writeFileSync(path.join(dir, 'corrections.jsonl'), 'not json\n');
  fs.writeFileSync(path.join(dir, 'billing.json'), '{');
  fs.writeFileSync(path.join(dir, 'billing.json.bak'), JSON.stringify({ version: 1, entries: [], overrides: [] }));
  const budget = {
    id: 'acme',
    name: 'Acme',
    scope: { dim: 'center', value: 'acme' },
    period: 'month',
    amount: 100,
    enforce: 'block',
  };
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({ cost: { centers: [{ id: 'acme', name: 'Acme' }], budgets: [budget] }, monthlyBudgetUSD: 50 }),
  );
  return { data, dir };
}
// Every file under a folder, name and bytes.
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(root);
  return out;
}
const readerOf = (data, now = () => NOW) =>
  createCostReader({
    dir: path.join(data, '.data', 'cost'),
    configFile: path.join(data, 'config.json'),
    keysFile: path.join(data, '.data', 'keys.json'),
    now,
    nocase: false,
  });

test('reader: spend and budgets from the files, and nothing written (the folder byte for byte)', () => {
  const { data } = dataFolder();
  const before = snapshot(data);
  const r = readerOf(data);
  const s = r.spend({ range: '7', groupBy: ['model'] });
  assert.deepEqual([s.from, s.to, s.groupBy], ['2026-10-16', TODAY, ['model']]);
  assert.deepEqual(
    s.rows.map((x) => [x.model, x.listUSD]),
    [
      ['m-0', 3],
      ['m-1', 2],
      ['m-2', 1],
    ],
  );
  assert.deepEqual(s.rows[0].tokens, { input: 100, output: 10, cacheRead: 5, cacheWrite: 2 });
  assert.deepEqual(s.totals, { requests: 6, listUSD: 6, billedUSD: 6 });
  assert.deepEqual(s.unread, []);
  const b = r.budgets();
  assert.deepEqual(
    b.budgets.map((x) => [x.id, x.spentUSD, x.state]),
    [
      ['acme', 6, 'ok'],
      ['legacy-monthly', 6, 'ok'],
    ],
  );
  for (const v of b.budgets)
    for (const k of ['enforce', 'legacy', 'thresholds', 'periodKey', 'fraction']) assert.ok(!(k in v), k);
  assert.equal(b.error, null);
  for (let i = 0; i < 3; i++) {
    r.spend({ range: 'month', groupBy: ['center', 'keyId'] });
    r.budgets();
  }
  assert.deepEqual(snapshot(data), before, 'no file created, renamed or changed');
  fs.rmSync(data, { recursive: true, force: true });
});

test('reader: the ranges, the top 50 then Other, the groupBy rules and a ledger folder that does not read', () => {
  assert.deepEqual(rangeDays('30', TODAY), { from: '2026-09-23', to: TODAY });
  assert.deepEqual(rangeDays('90', TODAY).from, '2026-07-25');
  assert.deepEqual(rangeDays('month', TODAY), { from: '2026-10-01', to: TODAY });
  assert.deepEqual(rangeDays('lastmonth', '2026-01-10'), { from: '2025-12-01', to: '2025-12-31' });
  const { data } = dataFolder(TODAY, 60);
  const s = readerOf(data).spend({});
  assert.equal(s.rows.length, 51);
  const other = s.rows[50];
  assert.deepEqual([other.model, other.count, other.listUSD], ['Other', 10, 55]);
  for (const bad of [[], ['model', 'center', 'source'], ['day'], ['model', 'model'], 'model'])
    assert.throws(() => readerOf(data).spend({ groupBy: bad }), /groupBy: 1 or 2 of/, JSON.stringify(bad));
  assert.throws(() => readerOf(data).spend({ range: 'all' }), /range: one of/);
  const file = tmp();
  fs.writeFileSync(path.join(file, '.data'), 'not a folder');
  assert.throws(
    () => readerOf(file).spend({}),
    (e) => e.message === 'the ledger folder could not be read',
  );
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(file, { recursive: true, force: true });
});

test('registry: the cost tools only with a cost reader, as mcp.js builds it; never as server.js builds it', async () => {
  const { data } = dataFolder();
  const cache = path.join(data, '.cache');
  const names = async (local) =>
    (await createIntegrations({ config: {}, secrets: secretsFor(), local }).listTools()).map((t) => t.name);
  const stdio = await names(createLocal({ cacheDir: cache, dataDir: data, cost: readerOf(data) }));
  assert.ok(stdio.includes('acc_cost') && stdio.includes('acc_budgets'));
  const server = await names(createLocal({ cacheDir: cache, dataDir: data, contentOff: true }));
  assert.ok(server.includes('acc_usage_summary'));
  assert.ok(!server.includes('acc_cost') && !server.includes('acc_budgets'));
  // server.js builds its registry's local data without a cost reader.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const call = src.slice(
    src.indexOf('const local = createLocal({'),
    src.indexOf('const registry = createIntegrations('),
  );
  assert.ok(call.length > 0 && !/\bcost\b/.test(call), call);
  const reg = createIntegrations({
    config: {},
    secrets: secretsFor(),
    local: createLocal({ cacheDir: cache, dataDir: data, cost: readerOf(data) }),
  });
  const out = await reg.callTool('acc_cost', { range: '7', groupBy: ['center'] });
  assert.deepEqual(
    JSON.parse(out.result.content[0].text).rows.map((x) => x.center),
    ['acme'],
  );
  const bad = await reg.callTool('acc_cost', { groupBy: ['day'] });
  assert.equal(bad.result.isError, true);
  fs.rmSync(data, { recursive: true, force: true });
});

test('stdio: mcp.js lists acc_cost and acc_budgets and answers them from its data folder', async () => {
  const { data } = dataFolder(dayOf(Date.now()));
  const before = snapshot(path.join(data, '.data', 'cost'));
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], {
    env: { ...process.env, ZAAFPULSE_DATA: data, ACC_CONFIG: '', ACC_CACHE_DIR: path.join(data, '.cache') },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const done = new Promise((r) => child.on('close', r));
  const msgs = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acc_cost', arguments: { range: '7' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'acc_budgets', arguments: {} } },
  ];
  for (const m of msgs) child.stdin.write(JSON.stringify(m) + '\n');
  child.stdin.end();
  await done;
  const byId = Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((r) => [r.id, r]),
  );
  const tools = byId[2].result.tools;
  const cost = tools.find((t) => t.name === 'acc_cost');
  assert.ok(cost && tools.some((t) => t.name === 'acc_budgets'));
  assert.equal(cost.annotations.readOnlyHint, true);
  assert.equal(JSON.parse(byId[3].result.content[0].text).rows.length, 3);
  assert.deepEqual(
    JSON.parse(byId[4].result.content[0].text).budgets.map((b) => b.id),
    ['acme', 'legacy-monthly'],
  );
  assert.deepEqual(snapshot(path.join(data, '.data', 'cost')), before);
  fs.rmSync(data, { recursive: true, force: true });
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 9800 + Math.floor(Math.random() * 100);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
async function startServer(data) {
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
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        // Trust the answer only once this child is seen still running (another server may hold the port).
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { base, stop: kill };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  throw new Error('could not start server.js on a free port');
}

test('gateway /mcp over HTTP: a gateway key lists the acc tools but never acc_cost or acc_budgets', async () => {
  const { data } = dataFolder();
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const { secret } = gw.keys.create({ name: 'client', scopes: ['mcp'], rpm: 60 });
  gw.flush();
  const s = await startServer(data);
  try {
    const rpc = (id, method, params) =>
      fetch(`${s.base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.json());
    await rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    const list = await rpc(2, 'tools/list');
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('acc_usage_summary'), names.join(' '));
    assert.ok(!names.includes('acc_cost') && !names.includes('acc_budgets'));
    const call = await rpc(3, 'tools/call', { name: 'acc_cost', arguments: {} });
    assert.ok(call.error || (call.result && call.result.isError), 'not callable either');
  } finally {
    await s.stop();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-mcp.test.js`
Expected: FAIL (`Cannot find module '../lib/cost/reader'`).

- [ ] **Step 3: Read-only options**

`lib/cost/ledger.js`:
- Replace `function createLedgerStore({ dir = null } = {}) {` with

```js
// `readOnly` (the MCP reader, lib/cost/reader.js): a bad line is skipped and left where it is, and nothing is written.
function createLedgerStore({ dir = null, readOnly = false } = {}) {
```

- Replace

```js
  const writeMonth = (m) =>
    writePrivate(fileOf(m), [...months.get(m).values()].map((r) => JSON.stringify(r) + '\n').join(''));
```

  with

```js
  const writeMonth = (m) => {
    if (readOnly) throw new Error('the ledger is open read-only');
    writePrivate(fileOf(m), [...months.get(m).values()].map((r) => JSON.stringify(r) + '\n').join(''));
  };
```

- In `readMonth`, replace `if (badLines.length) appendPrivate(` with `if (badLines.length && !readOnly) appendPrivate(`,
  and right after its `bad += badLines.length;` (before `dirty.add(m);`) add `    if (readOnly) return;`.
- In `readCorrections`, right after its `bad += badLines.length;` (before `try { appendPrivate(…corrections…`) add
  `    if (readOnly) return;`.
- In `addCorrection`, after `assertReadable(c.from, c.to);` add
  `      if (readOnly) throw new Error('the ledger is open read-only');`.

`lib/cost/billing.js`:
- Replace `function createBillingHistory({ dir = null, earlierData = () => false } = {}) {` with

```js
// `readOnly` (the MCP reader): a damaged file stays where it is, a good last copy is used without being written back,
// and nothing is saved.
function createBillingHistory({ dir = null, earlierData = () => false, readOnly = false } = {}) {
```

- In `save`, after `if (!file) return;` add `    if (readOnly) throw new Error('the billing history is open read-only');`.
- In `load`, replace `if (main.text !== undefined) setAside(file);` with
  `if (main.text !== undefined && !readOnly) setAside(file);`, and right after
  ``problems.push(`the billing history was ${how} and was recovered from its last good copy`);`` add
  `      if (readOnly) return;`.

`lib/cost/budget-service.js`: after the option `lastFile = null, // …` add
`  readOnly = false, // the MCP reader: budgets.last.json is read, never written`, and in `persist` replace
`if (!lastFile) return;` with `if (!lastFile || readOnly) return;`.

- [ ] **Step 4: Create `lib/cost/reader.js`**

```js
// Cost Control 5: a read-only view of the cost data for the owner's stdio MCP (mcp.js): the ledger months and their
// corrections, the billing history, and the budgets list as the server last saved them (config.json, else
// budgets.last.json). No ledger pass and no write of any kind: a bad line or a damaged file is skipped and left where it
// is. Every call reads the files again, so it follows the running server.
const fs = require('fs');
const path = require('path');
const L = require('./ledger');
const { createBillingHistory } = require('./billing');
const { billedRows } = require('./billing-view');
const { createBudgetService } = require('./budget-service');
const { planFee } = require('./rules');
const { dayOf, addDays } = require('./days');

const RANGES = ['7', '30', '90', 'month', 'lastmonth'];
const DIMS = ['source', 'provider', 'model', 'project', 'center', 'keyId'];
const TOP = 50;
const FOLDER_UNREAD = 'the ledger folder could not be read';
// What a budget view says to an agent: no enforcement, no legacy or period internals.
const BUDGET_FIELDS = [
  'id',
  'name',
  'scope',
  'period',
  'from',
  'to',
  'amount',
  'currency',
  'measure',
  'state',
  'projected',
  'percent',
  'spent',
  'spentUSD',
  'amountUSD',
  'forecastUSD',
  'runsOut',
  'reason',
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;

/** The days of an acc_cost range, ending today: 7, 30 or 90 days, this month, or last month. */
function rangeDays(range, today) {
  if (range === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (range === 'lastmonth') {
    const last = addDays(`${today.slice(0, 8)}01`, -1);
    return { from: `${last.slice(0, 8)}01`, to: last };
  }
  return { from: addDays(today, -(Number(range) - 1)), to: today };
}

function createCostReader({ dir, configFile, keysFile, home = '', now = Date.now, nocase } = {}) {
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return e && e.code === 'ENOENT' ? fallback : undefined;
    }
  };
  // config.json as the server reads it: {} when missing, false when it does not parse (the cost section then
  // reads as unknown and the budgets fall back to budgets.last.json, as in the server).
  const config = () => {
    const v = readJson(configFile, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : false;
  };

  function open() {
    const store = L.createLedgerStore({ dir, readOnly: true });
    try {
      store.load();
    } catch {
      /* what did not read is named in each view's `unread` */
    }
    const billing = createBillingHistory({
      dir,
      readOnly: true,
      earlierData: () => store.all().some((r) => r.kind !== 'plan'),
    });
    const rowsOf = (from, to) =>
      billedRows(store.view(from, to), { from, to, today: dayOf(now()), billingFor: billing.billingFor });
    return { store, billing, rowsOf };
  }

  /** acc_cost: spend over a range grouped by 1–2 dimensions, the top 50 by usage value, then Other. */
  function spend({ range = '30', groupBy = ['model'] } = {}) {
    if (!RANGES.includes(range)) throw new Error(`range: one of ${RANGES.join(', ')}`);
    const dims = Array.isArray(groupBy) ? groupBy : [];
    if (!dims.length || dims.length > 2 || dims.some((d) => !DIMS.includes(d)) || new Set(dims).size !== dims.length)
      throw new Error(`groupBy: 1 or 2 of ${DIMS.join(', ')}`);
    const { from, to } = rangeDays(range, dayOf(now()));
    const { store, rowsOf } = open();
    // A month that did not read is named in `unread`; a folder that did not read leaves nothing to answer from.
    if (store.unread().includes('folder')) throw new Error(FOLDER_UNREAD);
    const rows = rowsOf(from, to);
    const g = L.groupRows(rows, { groupBy: dims });
    const shape = (x) => ({
      ...Object.fromEntries(dims.map((d) => [d, x[d] ?? null])),
      requests: num(x.requests),
      tokens: {
        input: num(x.tokens.in),
        output: num(x.tokens.out),
        cacheRead: num(x.tokens.cacheRead),
        cacheWrite: num(x.tokens.cacheWrite5m) + num(x.tokens.cacheWrite1h),
      },
      listUSD: x.listUSD,
      billedUSD: x.billedUSD,
    });
    const all = g.rows.map(shape).sort((a, b) => b.listUSD - a.listUSD || b.billedUSD - a.billedUSD);
    const out = all.slice(0, TOP);
    if (all.length > TOP) {
      const rest = all.slice(TOP);
      const other = { ...Object.fromEntries(dims.map((d) => [d, 'Other'])), count: rest.length, requests: 0 };
      other.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      other.listUSD = 0;
      other.billedUSD = 0;
      for (const x of rest) {
        other.requests += x.requests;
        for (const k of Object.keys(other.tokens)) other.tokens[k] += x.tokens[k];
        other.listUSD += x.listUSD;
        other.billedUSD += x.billedUSD;
      }
      other.listUSD = round8(other.listUSD);
      other.billedUSD = round8(other.billedUSD);
      out.push(other);
    }
    return {
      from,
      to,
      groupBy: dims,
      rows: out,
      totals: { requests: g.totals.requests, listUSD: g.totals.listUSD, billedUSD: g.totals.billedUSD },
      unread: [...rows.unread],
    };
  }

  /** acc_budgets: the budgets in force with their state and forecast, as GET /api/cost/budgets has them. */
  function budgets() {
    const { store, billing, rowsOf } = open();
    const cost = {
      budgetRows: ({ from, to }) => {
        const rows = rowsOf(from, to);
        return {
          rows,
          unread: [...rows.unread],
          billingError: billing.error() ? 'the billing history could not be read' : null,
          historyLost: billing.lost(),
        };
      },
      firstDay: () => store.firstDay(),
      planFeeFor: (source, day) => {
        const b = billing.billingFor(source, day);
        return b && b.mode === 'plan' ? planFee(b, day) : 0;
      },
    };
    const cfg = config();
    const service = createBudgetService({
      getSettings: () => (cfg === false ? false : cfg.cost),
      getLegacy: () => {
        const k = readJson(keysFile, { keys: [] });
        return { monthlyBudgetUSD: cfg ? cfg.monthlyBudgetUSD : undefined, keys: (k && k.keys) || [] };
      },
      cost,
      home,
      now,
      nocase,
      lastFile: dir && path.join(dir, 'budgets.last.json'),
      readOnly: true,
    });
    const views = service.evaluate();
    return {
      budgets: views.map((v) => Object.fromEntries(BUDGET_FIELDS.map((f) => [f, v[f] === undefined ? null : v[f]]))),
      error: service.status().error,
    };
  }

  return { spend, budgets };
}

module.exports = { createCostReader, rangeDays, RANGES, DIMS, TOP };
```

- [ ] **Step 5: The provider, the tools and `mcp.js`**

`lib/local.js`: replace the comment line `// (DEMO=1) lists the synthetic trace sessions only, so no log of this machine is read.`
with

```js
// (DEMO=1) lists the synthetic trace sessions only, so no log of this machine is read. `cost` is the read-only cost
// reader (lib/cost/reader.js) for the acc_cost and acc_budgets tools: only mcp.js passes it, so the server's registry,
// which also answers gateway API keys on /mcp, never lists them (one client must never see another's spend).
```

add the option `  cost = null,` after `  dataDir = path.dirname(cacheDir),`, and in the returned object, before
`liveApps: () => processes.snapshot(),`, add `    ...(cost ? { cost } : {}),`.

`lib/connectors/acc.js`: after `const rangeOf = (r) => (r === 'all' ? 'all' : Number(r || 30));` add

```js
// The cost tools (Cost Control 5): only where the local data has a cost reader, the owner's stdio MCP (mcp.js).
const COST_RANGE = {
  type: 'string',
  enum: ['7', '30', '90', 'month', 'lastmonth'],
  description: 'Days to cover ending today, this month or last month (default 30)',
};
const COST_GROUP = {
  type: 'array',
  items: { type: 'string', enum: ['source', 'provider', 'model', 'project', 'center', 'keyId'] },
  minItems: 1,
  maxItems: 2,
  description: 'Up to 2 dimensions to group by (default ["model"])',
};
function costTools(local) {
  if (!local || !local.cost) return [];
  return [
    tool(
      'cost',
      'Spend from the cost ledger over a range, grouped by up to 2 dimensions (source, provider, model, project, center, keyId), in USD: usage value and paid, requests and tokens. Read-only.',
      { range: COST_RANGE, groupBy: COST_GROUP },
      ({ range, groupBy }) => local.cost.spend({ range: range || '30', groupBy: groupBy || ['model'] }),
    ),
    tool(
      'budgets',
      'Cost budgets with state, percent used, forecast at period end and the day they run out. Read-only.',
      {},
      () => local.cost.budgets(),
    ),
  ];
}
```

and after the `integrations_status` tool (its `() => local.integrationsStatus(),` and `),`), still inside `tools: [`,
add `        ...costTools(local),`. (`acc.js` already differs from Prettier on `b96b704` in the `trace_get` schema: do not
`--write` it.)

`mcp.js`: after `const { createLocal } = require('./lib/local');` add
`const { createCostReader } = require('./lib/cost/reader');`, and replace
`const local = createLocal({ cacheDir: CACHE_DIR, config, dataDir: DIR });` with

```js
// The cost tools read the server's cost data read-only; they are on this stdio server only, never on gateway /mcp.
const cost = createCostReader({
  dir: path.join(DIR, '.data', 'cost'),
  configFile: CONFIG_FILE,
  keysFile: path.join(DIR, '.data', 'keys.json'),
  home: require('os').homedir(),
});
const local = createLocal({ cacheDir: CACHE_DIR, config, dataDir: DIR, cost });
```

`server.js` is not changed: its `createLocal({ … contentOff: true … })` in `getIntegrations` gets no `cost`.

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/cost-mcp.test.js test/mcp.test.js test/integrations.test.js test/gateway.test.js test/mcp-http.test.js test/cost-ledger.test.js test/cost-billing.test.js test/cost-budget-service.test.js`
Expected: PASS (5 new tests; the existing ones unchanged).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check lib/cost/reader.js lib/cost/ledger.js lib/cost/billing.js lib/cost/budget-service.js lib/local.js mcp.js test/cost-mcp.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 8: Commit**

```bash
git add lib/cost/reader.js lib/cost/ledger.js lib/cost/billing.js lib/cost/budget-service.js lib/local.js lib/connectors/acc.js mcp.js test/cost-mcp.test.js
git commit -m "MCP: read-only acc_cost and acc_budgets on the stdio server, never on gateway /mcp"
```

---
### Task 9: docs and the whole suite

**Files:**
- Modify: `docs/cost.md` (the settings table at 112, the menu at 318–327, a new `### Reports, export and digest` before
  `### Settings page` at 465, the Settings panel table at 477–480, the API table at 552–564, the Files table at 533,
  Demo mode at 587)
- Modify: `docs/monitors.md` (after the seven-field body at ~90)
- Modify: `README.md` (the `acc` row of the connector table at 527)

**Interfaces:**
- Consumes: Tasks 1–8 as built.
- Produces: documentation only.

- [ ] **Step 1: `docs/cost.md`, settings and menu**

In the `## Settings (config.json → cost)` table, after the `currency` row, add

```markdown
| `digest` | `{ "enabled": true \| false }`, default `false`: the [weekly digest](#weekly-digest) |
```

In "## Cost Control menu" replace "has five pages" with "has six pages", and after the Budgets row add

```markdown
| Reports (`#cost/reports`) | What do I hand a client? | One cost center's month (or All centers, or Unassigned): usage value and paid with requests and tokens; spend by source, model, key and project (20 rows each, then Other); daily spend; the center's budgets (this month only); notes on unread months, assumed billing and restates. **Print** and **Export CSV** (see [Reports, export and digest](#reports-export-and-digest)) |
```

and append to the Breakdown row's last cell: `; **Export CSV** downloads the table's range, grouping, currency and measure`.

- [ ] **Step 2: `docs/cost.md`, the new section**

Before `### Settings page`, add:

```markdown
### Reports, export and digest

**Export.** `GET /api/cost/export` (and **Export CSV** on the Breakdown table) downloads the ledger grouping as CSV or
JSON: the same range, `groupBy` and currency rules as `/api/cost/ledger`, and `measure` as the pages have it (under
usage value the plan fee rows are left out). Columns: the dimensions, `requests`, `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `listUSD`, `billedUSD`, and `list<CODE>`, `billed<CODE>` with a display
currency. The CSV is RFC 4180 with CRLF; a cell that starts with `=`, `+`, `-`, `@`, a tab or a CR gets a leading `'`
so a spreadsheet does not run it as a formula; amounts have 8 decimals and no thousands separator. A month that did
not read adds a last line `# unread: 2026-09`. At most 400 days and 100,000 rows (413 beyond).

**Reports.** `#cost/reports` shows one cost center's month for a client, chosen with a month (this month back to the
ledger's first month; by default last month, or this month while the ledger does not hold all of last month), a
center (or All centers, or Unassigned) and the display currency. A center's figures are its usage; plan fees have no
center and show under All centers only. Budgets show their state for the current month only. **Print** uses the
browser's print (the print style hides the sidebar and the controls and fits A4 and Letter in one column); **Export
CSV** downloads the report's tables as one CSV in sections. The page does not refresh by itself.

### Weekly digest

Off by default; turn it on in Settings → **Weekly digest** (`cost.digest.enabled`). After a ledger pass on Monday, or
later that week if the server was off, ZAAFPulse sends last week's digest (Monday to Sunday) once: usage value and
paid, the change in usage value against the week before, the top 3 cost centers and models, the budgets used up or
projected over, the days the `cost_anomaly` rule finds anomalous with its saved parameters, and the top
recommendation. It goes through the Monitors channels: one desktop line ("ZAAFPulse weekly cost: $412.30 (+12 %),
1 budget at risk, 2 anomalies") and, when one is set, the webhook (its body is in [Monitors](monitors.md#channels)).
It carries numbers and center, model, key and budget names; never project folders or text. `.data/cost/digest.json`
remembers the last week sent, so a restart never sends twice; a send that reaches no channel (or figures that do not
read) is logged once and tried again on the next pass. Demo mode and `ZAAFPULSE_NOTIFY=off` send nothing.

### MCP tools

The stdio MCP server (`node mcp.js`, see the README) has two read-only tools over the same data folder, with no ledger
pass and no write: `acc_cost` (spend over `7`, `30`, `90` days, `month` or `lastmonth`, grouped by 1–2 of `source`,
`provider`, `model`, `project`, `center`, `keyId`; the top 50 rows by usage value, then Other) and `acc_budgets` (the
budgets with state, percent, forecast and the day they run out; no enforcement details). They return `~` project
folders, as the dashboard does. They are **not** on the gateway's `/mcp` endpoint, which answers clients' API keys.
```

In the Settings page's panel table, after the Display currency row, add

```markdown
| Weekly digest | `digest`: Off or On (see [Weekly digest](#weekly-digest)) |
```

and replace "It has four panels; each of the first three has its own **Save**" with "It has five panels; each of the
first four has its own **Save**".

- [ ] **Step 3: `docs/cost.md`, files, API and demo**

In the Files table, after `budgets.last.json`, add

```markdown
| `digest.json` | `{ "lastWeek": "YYYY-MM-DD" }`: the Monday of the last weekly digest sent |
```

In the API table, after the `GET /api/cost/ledger` row, add

```markdown
| `GET /api/cost/export?format&from&to&groupBy&currency&measure` | the ledger grouping as a download: `format` `csv` (default) or `json` (`{ from, to, groupBy, currency, measure, rows, totals, unread }`); `Content-Disposition: attachment; filename="zaafpulse-cost-<from>-<to>.<ext>"`. The ledger's 400s, plus `format` and `measure`; 413 over 100,000 rows; 503 with a `code` while the ledger does not read |
| `GET /api/cost/report?month&center&currency` | one center's month: `{ month, from, to, center: { id, name }, currency, generatedAt, totals, tables: { source, model, key, project }, daily, budgets, notes: { unread, assumed, billingError, corrections }, months, budgetsError }`; `center` an id, `all` (default) or `unassigned`; `budgets` null for a past month. 400 for a bad or future month, an unknown center or a currency without rates; 503 while the ledger folder does not read |
```

In "## Demo mode", append: "The Reports page and the export read the demo ledger; the weekly digest never sends."

- [ ] **Step 4: `docs/monitors.md` and `README.md`**

In `docs/monitors.md`, after the paragraph that follows the seven-field body ("For fixed rules, `state` and
`previous` are …"), add:

~~~markdown
The **weekly cost digest** (off by default; [Cost Control](cost.md#weekly-digest)) is the one other body the webhook
gets, once a week, through the same queue, retries and timeouts:

```json
{
  "type": "cost_digest",
  "week": { "from": "2026-10-19", "to": "2026-10-25" },
  "totals": { "listUSD": 412.3, "billedUSD": 236.5 },
  "change": { "listUSD": 44.1, "percent": 12 },
  "centers": [{ "id": "acme", "name": "Client: Acme", "listUSD": 210.4 }],
  "models": [{ "model": "claude-opus-5-5", "listUSD": 180.2 }],
  "budgets": [{ "id": "team", "name": "Team", "state": "warn_80", "projected": true, "percent": 84.2 }],
  "anomalies": [{ "day": "2026-10-21", "spentUSD": 32, "expectedUSD": 9.5 }],
  "recommendation": { "model": "claude-opus-5-5", "candidate": "claude-sonnet-5-5", "savingUSD": 42.4 }
}
```

Numbers and center, model, key and budget names only: no project folder and no text. The desktop gets one line.
~~~

In `README.md`'s connector table, in the `acc` row's Tools cell, after `integrations_status` add
`, and on the stdio server only (never gateway /mcp) \`cost\` (spend over a range, grouped) and \`budgets\` (state,
forecast, runs-out day), read-only`.

- [ ] **Step 5: The whole suite**

Run: `npm test`
Expected: every test passes (2084 before this plan, plus the new ones; 2 skipped as before).

Run: `npx prettier@3 --check lib/cost/export.js lib/cost/report.js lib/cost/digest.js lib/cost/reader.js public/costreports.js test/cost-*.test.js`
Expected: no file this plan created is listed (`test/cost-rules.test.js` already differs on `b96b704`).

- [ ] **Step 6: Commit**

```bash
git add docs/cost.md docs/monitors.md README.md
git commit -m "Docs: cost reports, export, the weekly digest and the MCP cost tools"
```

---
## Decisions made while planning

- **Downloads through `send()`.** No route answered a file with a name before (Datasets' export is NDJSON without
  one), so a route answer gains optional `type` and `headers`, and `send()` puts `headers` before
  `SECURITY_HEADERS`, so a download can never weaken them. `Cache-Control: no-store` is already on every answer.
- **What `measure` does to an export.** Both measures are columns, so `measure` decides the rows kept, as the
  Breakdown table: under usage value a plan fee row (no requests, no usage value) is left out. JSON `totals` are the
  sums of the rows kept (not the ledger's totals, which would count the left-out fees).
- **Numbers are never prefixed.** The formula guard applies to text cells only; a negative amount stays `-0.5`.
- **The unread comment line** is written raw (`# unread: 2026-09, corrections`): it holds month ids and fixed names
  only, and quoting it would turn it into a record.
- **Report month optional.** The server knows the ledger's first day, so `month` defaults there: last month when the
  ledger holds all of it (first day on or before last month's 1st), else this month. The answer lists `months` for the
  picker (at most 120).
- **Plan fees in a center's report.** A plan row has no center (as in Breakdown), so a center's "Paid" is its metered
  use; plan fees show under All centers only.
- **Report budgets for the current month only;** a past month answers `budgets: null` and the page says so (their
  state is the current period's).
- **503 only for a ledger folder that does not read;** an unread month or the corrections give a 200 with the month in
  `notes.unread` (the spec lists both).
- **Report CSV built in the browser** from the answer (same cell rules as the server's export); the file is
  `zaafpulse-report-<center>-<month>.csv`, USD columns always plus the chosen currency's.
- **Reports does not refresh on the 60-second cycle** (it is a document, like Settings is all forms); a changed control
  rewrites the hash and the router mounts it again. Its daily chart reuses `costSpikeSvg` with no baseline.
- **Breakdown export is a plain `<a download>` link** (same-origin, the session cookie goes with it); it exports the
  table's query grouping (a filter's dimension included), not the filtered rows.
- **The digest's `enabled` is kept in memory only** (false at start): a restart on a broken `config.json` sends nothing
  until it validates, rather than sending a digest the owner may have turned off. A marker that does not parse counts
  as none (a resend at worst).
- **"Failed" means no channel delivered.** Retrying after a partial success would show the desktop line twice. With no
  channel on (desktop off, no webhook, demo, `ZAAFPULSE_NOTIFY=off`) the week is settled without a send.
- **The change and the desktop amount are usage value;** `totals` carry paid too. Anomalies carry no drivers (a driver
  can be a project folder); key names reach the webhook only as budget names.
- **`check()` is not awaited by the ledger pass** (a webhook may take ~20 s to give up) and runs one send at a time.
- **`recommendations()` on the cost API** reuses the Value page's 30-day computation instead of repeating it in
  `server.js`.
- **Reader instead of a read-only `createCost`.** `createCost` writes at load (cursor recovery, set-aside), so the
  reader composes the store, the billing history, `billedRows`, `groupRows` and the budget service with new
  `readOnly` options (a write attempt throws), and reads `config.json` and `keys.json` on every call.
- **Other row in `acc_cost`:** each dimension `'Other'` with `count`; `groupBy` items are checked in the reader because
  `checkArgs` does not check array items.
- **Ports:** `test/cost-mcp.test.js` 9800–9899, `test/cost-reports-http.test.js` 9900–9999.

## Spec points that do not fit

- **"today is Monday or later in the week after"** always holds when last week is computed from today; the rule
  reduces to "last week's Monday is newer than the marker" (D2).
- **"A broken config.json keeps the last digest setting that validated, as budgets do":** budgets keep theirs on disk
  (`budgets.last.json`); the digest keeps it in memory only (see Decisions).
- **"key names" in the digest** appear only inside budget names; no key list is sent.
- **"Notes: months that did not read"** and **"503 when the ledger cannot be read"** overlap for a one-month report;
  this plan uses 503 for the folder only.

## Self-review

- **Spec coverage.** Export (CSV/JSON, columns, currency columns, RFC 4180, formula guard, plain numbers, unread line,
  JSON shape, headers, 400 days, 413 at 100,000 rows, session only): Task 1, the Breakdown button Task 4. Reports
  (month picker and default, center select with All and Unassigned, currency, header with period and generated time,
  totals, four tables of 20 then Other, daily bar chart, budgets in scope, notes for unread months, assumed billing and
  restates, Print with print CSS, Export CSV in sections, the route with its 400s and 503): Tasks 2–3. Digest (setting
  and panel, rules validation, marker, once a week across restarts and a missed Monday, figures with change, top 3
  centers and models, budgets at risk, anomalies with saved parameters, top recommendation, desktop line, webhook body
  without folders or text, channel bounds, failure logged once and retried, demo silent): Tasks 5–7. MCP (reader with
  no pass and no write, byte-for-byte test, both tools shaped and capped, stdio only, absent from the server registry
  and from gateway `/mcp` over HTTP with a key, path-free folder error): Task 8. Docs: Task 9. Out of scope items
  (mail, PDF, write tools, per-key gateway tools, monthly digests, invoices) are untouched.
- **Signatures.** `cost.ledger`, `cost.budgetRows`, `cost.firstDay`, `cost.corrections`, `budgets.evaluate`,
  `ledgerQuery`, `checkCurrency`, `quietly`, `viewOut`, `keys` are used as `lib/cost/index.js` and `lib/cost/api.js`
  define them at `b96b704`; `createLedgerStore`, `createBillingHistory` and `createBudgetService` only gain a
  defaulted option; `createLocal` gains a defaulted `cost`; `createChannels` keeps `notify` and `test` unchanged and
  adds `digest`; `createCostApi` returns `{ route, recommendations }` (every caller destructures `route` or calls
  `.route`).
- **No placeholders.** Every step has its full code or an exact replacement; every test file is given whole.
- **Globals.** New page names (`COST_REP*`, `costRep*`, `costMountReports`, `costExportHref`, `COST_SET_DIGEST_NOTE`,
  `costSetDigestHtml`) exist in no other page script (checked with `grep`); the global-scope test passes. Nothing new
  touches the DOM at load time; `location`, `document` and `window.print` are read inside handlers only.
- **Privacy.** The digest body is rebuilt field by field in `digestBody` (a test feeds it a project and extra text and
  checks neither leaves); the MCP tools exist only in `mcp.js`'s registry (a source check and a spawned server with a
  gateway key prove it); the reader leaves the folder byte for byte even with a bad ledger line, a bad correction and a
  damaged `billing.json`.
