# Cost Control 3b: the cost Settings page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fifth Cost Control sub-page, **Settings** (`#cost/settings`), where the owner edits the cost settings without
touching `config.json`: cost centers with gateway keys and folder rules (with a live server preview of what moves),
billing per source, the display currency with dated rates, and a restate of a past range with a preview, a confirmation
and a history.

**Architecture:**
- **Ledger and prices.** `lib/cost/ledger.js` splits `restate()` into `restateRows()` (compute only) and the append;
  `lib/cost/prices.js` gains `peek(pricing)`, the version a restate would use, without recording one.
- **Cost object.** `lib/cost/index.js` gains `restatePreview({ from, to })` (the checks of `restate()`, nothing
  written) and `corrections()` (the restate history).
- **Pure preview.** New `lib/cost/preview.js`: `settingsPreview` (moves, rule warnings, Unassigned projects, a test
  path, from the server's own validation and glob matcher) and `restateSummary`. No I/O, no clock.
- **API.** `lib/cost/api.js`: `POST /api/cost/settings/preview`, `POST /api/cost/restate/preview`,
  `GET /api/cost/restates`, and `reasons` in `GET /api/cost/settings`. Same sign-in, scrub and 400/409/503 rules as the
  other `/api/cost` routes. The demo answers through the same cost object (in memory).
- **Front end.** New `public/costsettings.js` (the page, its four panels, drafts, preview requests, pure helpers
  exported for Node tests), loaded after `costview.js`. `costview.js` gains only the menu entry, the copy line and the
  mount call (its quiet refresh skips the page). Styles under `.cost-set-`.

**Tech Stack:** Node ≥18 standard library only (CommonJS), `node:test`, plain browser JS in `public/` (classic scripts
sharing one global scope, loaded before `app.js`).

**Spec:** `docs/superpowers/specs/2026-10-28-cost-settings-ui-design.md`. Builds on the cost ledger (PR #53), budgets
(PR #54) and the Cost Control menu (3a, PR #55, plan `docs/superpowers/plans/2026-10-27-cost-control-ui.md`).

**Line numbers** below are on `feat/cost-settings-ui` at `b9cf922`. Re-read each location before editing it.

**Checked while planning:** each task's code and tests were applied, in order, to a scratch copy of `b9cf922` and run
with `node --test`: each new test file fails before its task's code and passes after it, and every `test/cost-*.test.js`
file, `test/budgets-http.test.js` and `test/monitors-ui.test.js` stay green (338 tests). The whole suite in that copy:
1962 tests, 1955 pass, 2 skipped, 5 fail; the 5 (`test/evals-api.test.js` ×4, `test/trace-api.test.js` ×1) fail the
same way on an untouched copy under the temp folder and pass in the worktree. The page was also driven in headless
Chrome against the demo (`DEMO=1`) over the DevTools protocol, with no script error: add a center (the id follows the
name), delete a rule (Moves and Unassigned fill), Create rule (focus on its center), a test path, Up (focus follows),
Save rules (note and Open Restate), a billing plan with an empty fee (reason and field mark), Discard, Add rate (today's
line follows), Open Restate (range filled, history), Preview, Run restate ("Restated: 150 rows", history row), and a
draft kept after leaving the page.

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test` (`npm test`; one file:
  `node --test test/<file>.test.js`). Plain browser JS in `public/`: classic `<script>` files loaded by
  `public/index.html` before `app.js`.
- **One global scope.** Every top-level name in `public/costsettings.js` starts with `cost` or `COST` (functions
  `costSetX`, constants `COST_SET_X`), because all page scripts share one global scope. No name may repeat one of
  `costview.js` or another page script: the test "every page script shares one global scope" (`test/cost-ui.test.js`)
  checks it once the script tag is in `index.html`.
- **Loadable in Node.** `costsettings.js` touches no DOM, `window`, `document` or `localStorage` at load time (only
  inside functions) and ends with `if (typeof module !== 'undefined') module.exports = { … }`, as
  `public/costview.js` does. It reuses `costview.js` globals (`COST`, `COST_SOURCES`, `costGet`, `costPost`,
  `costToday`, `costAddDays`, `costIsDay`, `costMoney`, `costRibbonHtml`, `costErrorHtml`, `costReasonsHtml`,
  `costSub`, `COST_MAX_DAYS`) only inside functions; the Node test puts them on `global` from
  `require('../public/costview')`.
- **Text only (S1).** Every owner-written or server string into HTML goes through `esc()`: center names and ids, key
  names and ids, globs, `~` project folders, plan names, currency codes, reasons, error messages, restate reasons.
  Numbers are formatted by our own formatters. An audit test (Task 8) fails on a bare `${x.name}`-style interpolation of
  such a field in `costsettings.js`. CSP stays `script-src 'self'`: no inline handlers (`onclick=`), no inline scripts;
  events are delegated from `document`, as in `costview.js`.
- **Errors are path-free.** Every message from `/api/cost/*` goes through `lib/cost/api.js`'s `scrub`. Answers hold
  `~` folders, key ids and names, center names, numbers and the owner's restate reasons; nothing else.
- **Routes.** The three new routes live in `lib/cost/api.js`, which `server.js` serves only behind the dashboard
  sign-in: never a gateway API key, MCP or A2A. Unknown body fields are a 400. A state change or preview needs
  `content-type: application/json` (415 otherwise; the existing `route()` does this).
- **Config writes.** Writers never save over an unparsable `config.json` (409 `CONFIG_BROKEN`, "config.json could not be
  read; fix it first"): unchanged behaviour. The page only uses the existing `POST /api/cost/settings` to save.
- **Previews write nothing.** `restatePreview` never calls `billing.ensure`, `billing.addOverrides`,
  `prices.observe` or `store.addCorrection`. `peek` never writes a price file. Tests check the cost folder byte for byte.
- **Tests.**
  - Never call a real provider or the network: spawned servers run with `NO_JUDGE_PORTS` and, outside the demo, a
    `config.json` with `"pricingSync": { "enabled": false }`; in-process tests use fakes.
  - Never signal a real process.
  - Spawned servers in this plan take ports from **9200–9399** (`test/cost-settings-api.test.js`), a range no other
    test uses (cost ledger 8000–8399, budgets 8400–8799, 3a 8800–8999 and 9000–9199). A test trusts an answer only
    after it has seen its own child still running (~200 ms after the first answer).
- **Housekeeping.**
  - Prettier style by hand (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always).
    Short "why" comments, as in `lib/cost/*.js`. Wrap any line past 120 columns as Prettier would; the content stays
    as shown.
  - Commit messages: plain, imperative. **No `Co-Authored-By`, no "Generated with", no AI attribution of any kind**
    (owner rule).
  - UI copy is English, as in the rest of the dashboard; the strings quoted in the spec are copied verbatim.
  - CI runs on Ubuntu, macOS and Windows.
- **Shared files.** Edits are small and additive, and existing tests stay green: `lib/cost/ledger.js`,
  `lib/cost/prices.js`, `lib/cost/index.js`, `lib/cost/api.js`, `public/costview.js`, `public/iso.js` (one `SUBPAGES`
  entry), `public/index.html`, `public/styles.css`, `docs/cost.md`. `restate()` keeps its behaviour and its tests.

## Rules and values

**R1. Restate preview.** `cost.restatePreview({ from, to })` refuses exactly as `cost.restate()` does, minus the reason:
400 for a bad day, a reversed range or `to` on or after today; a retry with `store.flush()` while something is unread,
then `store.assertReadable` (503 codes); 409 while the settings do not read. It then prices with `prices.peek(pricing)`:
the latest version when its hash matches, else the id `observe()` would give (`next`), so its rows equal those the
following `restate()` records. `total` counts the usage rows of the range.

**R2. Settings preview.** Rows are `cost.ledger({ from: today − 29, to: today, groupBy: ['project', 'keyId'] }).rows`.
`saved` is the settings in force (`settingsOf`: the defaults while they do not read), `draft` the validated body. A row
moves when `compile(saved).centerOf(row) !== compile(draft).centerOf(row)`. Rule statuses look only at projects of
rows whose key the draft does not map: `none` when the rule matches none, `shadowed` when it matches some but an
earlier rule matched each of them first (`by` = the earliest such rule), else `ok`. The case rule is the platform's
(`nocase` on macOS and Windows) unless `compileOpts.nocase` says otherwise. Moves: by `listUSD` descending, at most 50,
`more` = the rest. Unassigned: projects still `unassigned` under the draft, by cost, at most 20. The test path goes
through the rules only.

**R3. Restate summary.** `changed` = rows that change; `beforeUSD`/`afterUSD` = Σ `before.listUSD` / Σ `after.listUSD`;
`moves` = per (`before.center`, `after.center`) pair that differs, Σ `after.listUSD`, by amount, at most 20. Amounts
are rounded to 8 decimals, as `groupRows` does.

**R4. Panel save bodies.** Each Save reads `GET /api/cost/settings` again and sends its `settings` with only the
panel's fields replaced: rules → `centers`, `keyCenters`, `folderRules`; billing → `billing` with every source written
out; currency → `currency` (`null` for "USD only", rates sorted by date). Ids, names and globs are trimmed, the code is
upper-cased, numbers typed as text are parsed (an empty field is sent as `null`, which the server refuses with its own
reason).

**R5. Center id from a name.** Lowercase, accents dropped, runs of anything outside `a-z0-9` → `-`, trimmed of `-`, at
most 40 characters, `center` when empty; `-2`, `-3`, … when taken (the suffix keeps the result within 40); never
`unassigned`, `__proto__`, `constructor` or `prototype`. Every result matches `CENTER_ID`.

**R6. Restate range.** Default: the first of this month to yesterday; on the first of a month, the previous month.
Checks, with the server's words and in its order: "from and to are dates (YYYY-MM-DD)", "from must be on or before to",
"at most 400 days at a time", "today follows the current prices and rules already; restate up to yesterday".

**R7. Preview staleness.** A restate preview remembers its range and the settings generation (`COST_SET.gen`, +1 after
each successful Save). It is `fresh` when the range and generation still match, `stale-range` ("Range changed: preview
again") or `stale-settings` ("Settings changed: preview again") otherwise. **Run restate** needs a fresh preview, a
reason of 1–200 characters, the box checked, and settings that read.

**R8. Today's rate.** The latest rate whose start date is on or before today (as `rateFor`), from the draft's rows that
have a valid date and a number above 0; "Today: 1 USD = 16,250 IDR (rate from 2026-10-01)", or "Today: no rate starts
on or before today." when none.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/cost/ledger.js` | modify (shared) | `restateRows(store, { from, to, version, pricer, rules })`; `restate()` uses it |
| `lib/cost/prices.js` | modify (shared) | `peek(pricing) → { version, pricer, next }` |
| `lib/cost/index.js` | modify (shared) | `restatePreview({ from, to })`, `corrections()`; shared range checks |
| `lib/cost/preview.js` | create | pure `settingsPreview`, `restateSummary` |
| `lib/cost/api.js` | modify (shared) | the three routes, `reasons` in the settings answer, `nocase` option |
| `public/costsettings.js` | create | the Settings page: frame, drafts, panels, previews, restate, pure helpers |
| `public/costview.js` | modify (shared) | `COST_SUBS` entry, the copy line, `costRefresh` mounts Settings (never quietly) |
| `public/iso.js` | modify (shared) | the `settings` entry of `SUBPAGES.cost` |
| `public/index.html` | modify (shared) | the sidebar sub-entry, the script tag after `costview.js` |
| `public/styles.css` | modify (shared) | `.cost-set-*` styles (append) |
| `docs/cost.md` | modify | "Settings page" section, API rows, `reasons` |
| `test/cost-restate-preview.test.js` | create | Tasks 1–2 |
| `test/cost-preview.test.js` | create | Task 3 |
| `test/cost-settings-api.test.js` | create | Task 4 (in-process and over HTTP, ports 9200–9399) |
| `test/cost-settings-ui.test.js` | create | Tasks 5–8 (`test/cost-ui.test.js` needs no change: its "one global scope" test reads every script tag) |

---
### Task 1: `ledger.restateRows` and `prices.peek`

**Files:**
- Modify: `lib/cost/ledger.js:512-541` (`restate`, split), `:543-560` (exports)
- Modify: `lib/cost/prices.js:179` (a function before `seed`), `:189-197` (the returned object)
- Test: `test/cost-restate-preview.test.js` (create)

**Interfaces:**
- Consumes: `store.assertReadable`, `store.view`, `repriceRow`, `differs` (ledger.js); `latest`, `pricerFor`, `maxId`,
  `hashOf`, `makePricer` (prices.js).
- Produces:
  - `restateRows(store, { from, to, version, pricer, rules }) → [{ key, before, after }]`, exported from
    `lib/cost/ledger.js`. Throws `LEDGER_MONTH_UNREAD` / `LEDGER_CORRECTIONS_UNREAD` as `restate()` does. Writes nothing.
  - `restate(store, { from, to, reason, ts, version, pricer, rules, billing })` unchanged in behaviour: `restateRows`
    plus `store.addCorrection`.
  - `createPriceVersions(...).peek(pricing) → { version: <version> | null, pricer, next }`: `version` is the latest
    when its hash equals `hashOf(pricing)`, else `null`; `next` is the latest id then, else the id `observe()` would
    give. Writes nothing.

- [ ] **Step 1: Write the failing test**

Create `test/cost-restate-preview.test.js`:

```js
// Cost Control 3b, the server side of the previews: ledger.restateRows computes what a restate records without
// writing it, prices.peek names the price version a restate would use without recording one, and (Task 2)
// cost.restatePreview and cost.corrections answer the Restate panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/cost/ledger');
const { compile } = require('../lib/cost/rules');
const { createPriceVersions, hashOf } = require('../lib/cost/prices');
const { makePricer } = require('../lib/pricing');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-restate-preview-'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const ACME = {
  centers: [{ id: 'acme', name: 'Acme' }],
  keyCenters: {},
  folderRules: [{ glob: '~/work/**', center: 'acme' }],
  billing: {},
  currency: null,
};
// Every file under a folder with its bytes: what "nothing written" is checked against.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const f = path.join(d, name);
      if (fs.statSync(f).isDirectory()) walk(f);
      else out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
// A stored Sonnet row of one day: 1,000 in and 100 out per request (0.003 at PRICE_A).
const row = (day, project, extra = {}) => ({
  ...L.newRow({ day, source: 'claude', kind: 'chat', project, center: 'unassigned' }),
  model: 'claude-sonnet-5-5',
  requests: 1,
  tokens: { in: 1000, out: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 0.003,
  billedUSD: 0.003,
  priceVersion: 1,
  ...extra,
});

test('restateRows: the rows restate() records, computed without a correction', () => {
  const make = () => {
    const store = L.createLedgerStore();
    store.put(row('2026-10-20', '~/work/acme'));
    store.put(row('2026-10-21', '~/play'));
    store.put({ ...row('2026-10-21', '~/work/acme'), model: 'qwen3:8b', free: true, listUSD: 0, billedUSD: 0 });
    return store;
  };
  const args = {
    from: '2026-10-20',
    to: '2026-10-21',
    version: { id: 2 },
    pricer: makePricer(PRICE_B),
    rules: compile(ACME, { nocase: false }),
  };
  const a = make();
  const rows = L.restateRows(a, args);
  assert.deepEqual(a.corrections(), [], 'nothing recorded');
  const b = make();
  const c = L.restate(b, { ...args, reason: 'check', ts: 1 });
  assert.deepEqual(rows, c.rows);
  assert.equal(b.corrections().length, 1, 'restate() still records its correction');
  const byProject = Object.fromEntries(rows.map((x) => [JSON.parse(x.key)[4] + ':' + JSON.parse(x.key)[3], x]));
  const acme = byProject['~/work/acme:claude-sonnet-5-5'];
  near(acme.after.listUSD, 0.006);
  assert.deepEqual([acme.before.center, acme.after.center, acme.after.priceVersion], ['unassigned', 'acme', 2]);
  assert.equal(byProject['~/work/acme:qwen3:8b'].after.listUSD, 0, 'a free row stays free');
  assert.equal(byProject['~/play:claude-sonnet-5-5'].after.center, 'unassigned');
});

test('restateRows: throws, like restate(), while the corrections of the store did not read', () => {
  const dir = tmp();
  const first = L.createLedgerStore({ dir });
  first.load();
  first.put(row('2026-10-20', '~/work/acme'));
  first.flush();
  const file = path.join(dir, 'corrections.jsonl');
  fs.writeFileSync(file, '');
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  if (byMode) fs.chmodSync(file, 0o000);
  else {
    fs.rmSync(file);
    fs.mkdirSync(file);
  }
  try {
    const store = L.createLedgerStore({ dir });
    assert.throws(() => store.load(), { code: L.CORRECTIONS_UNREAD });
    assert.throws(
      () =>
        L.restateRows(store, {
          from: '2026-10-20',
          to: '2026-10-20',
          version: { id: 1 },
          pricer: makePricer(PRICE_A),
          rules: compile(ACME, { nocase: false }),
        }),
      { code: L.CORRECTIONS_UNREAD },
    );
  } finally {
    if (byMode) fs.chmodSync(file, 0o600);
    else fs.rmSync(file, { recursive: true });
  }
});

test('peek: the latest version while the prices hash the same, else null with a fresh pricer; nothing written', () => {
  const dir = path.join(tmp(), 'prices');
  const p = createPriceVersions({ dir, now: () => 1000 });
  const v1 = p.observe(PRICE_A, '2026-10-20');
  const before = snapshot(dir);
  const same = p.peek(JSON.parse(JSON.stringify(PRICE_A)));
  assert.equal(same.version, v1);
  assert.equal(same.next, 1);
  near(same.pricer.parts('claude-sonnet-5-5', 1000, 100, 0, 0, 0).reduce((a, b) => a + b, 0), 0.003);
  const changed = p.peek(PRICE_B);
  assert.equal(changed.version, null);
  assert.equal(changed.next, 2, 'the id observe() would give it');
  near(changed.pricer.parts('claude-sonnet-5-5', 1000, 100, 0, 0, 0).reduce((a, b) => a + b, 0), 0.006);
  assert.deepEqual(snapshot(dir), before, 'no version file and no index change');
  assert.equal(p.list().length, 1);
  assert.equal(p.current().hash, hashOf(PRICE_A));
  assert.equal(p.observe(PRICE_B, '2026-10-22').id, changed.next);
  const none = createPriceVersions().peek(PRICE_A);
  assert.deepEqual([none.version, none.next], [null, 1], 'before the first version');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-restate-preview.test.js`
Expected: FAIL, 3 tests: `TypeError: L.restateRows is not a function` and `TypeError: p.peek is not a function`.

- [ ] **Step 3: Split `restate()` in `lib/cost/ledger.js`**

Replace the comment and body of `restate` (`:512-541`, from `// Re-prices [from, to] with the current pricing` to the
closing `}` of `restate`) with:

```js
// What a restate of [from, to] records (R13), computed only: the before and after of every usage row that changes when
// it is re-priced with `pricer` (as version `version.id`) and re-attributed with `rules`. Writes nothing; throws while a
// month of the range or the corrections did not read, as restate() does. The settings and restate previews use it.
function restateRows(store, { from, to, version, pricer, rules }) {
  store.assertReadable(from, to);
  const rows = [];
  for (const r of store.view(from, to)) {
    if (r.kind === 'plan') continue; // a stored plan row (an older format): readers ignore it
    const before = {
      listUSD: r.listUSD,
      priceVersion: r.priceVersion ?? null,
      center: r.center ?? null,
      unpriced: !!r.unpriced,
    };
    const priced = !!r.free || (!!r.model && pricer.priced(r.model));
    const after = {
      listUSD: r.free || !priced ? 0 : repriceRow(r, pricer),
      priceVersion: version.id,
      center: rules.centerOf(r),
      unpriced: !priced,
    };
    // `r.key` is the stored row's key, which every correction of that row refers to, whatever center it shows now.
    if (differs(before, after)) rows.push({ key: r.key, before, after });
  }
  return rows;
}

// Re-prices [from, to] with the current pricing and re-attributes it with the current rules (R13): one correction with
// the before and after of every usage row that changes, appended even when none does. The stored rows are never
// rewritten. Billing is not in it: it is derived when the ledger is read, and a restate re-bills its range through
// billing overrides, which `billing` (each source's billing as restated) records here. Throws, appending nothing,
// while a month of the range or the corrections did not read.
function restate(store, { from, to, reason, ts, version, pricer, rules, billing = [] }) {
  const rows = restateRows(store, { from, to, version, pricer, rules });
  const correction = { ts, from, to, reason, priceVersion: version.id, rows, billing };
  store.addCorrection(correction);
  return correction;
}
```

In `module.exports` (`:543-560`), add `restateRows,` on the line before `restate,`.

- [ ] **Step 4: Add `peek` to `lib/cost/prices.js`**

Before `// Demo: versions held in memory with their prices.` (`:179`), add:

```js
  // The version a restate would price with now, without recording it (Cost Control 3b): the latest when its prices
  // hash the same as `pricing`, else null, with a pricer made from `pricing` and the id observe() would give it
  // (`next`). Writes nothing, so a preview never adds a version.
  function peek(pricing) {
    const last = latest();
    const copy = JSON.parse(JSON.stringify(pricing || {}));
    if (last && last.hash === hashOf(copy)) return { version: last, pricer: pricerFor(last.id), next: last.id };
    let pricer;
    try {
      pricer = makePricer(copy);
    } catch {
      // As pricerFor: a shape makePricer cannot take prices with the latest usable version, else with nothing.
      pricer = last ? pricerFor(last.id) : makePricer({});
    }
    return { version: null, pricer, next: Math.max(maxId, last ? last.id : 0) + 1 };
  }
```

In the returned object (`:189`), add `peek,` after `observe,`.

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/cost-restate-preview.test.js test/cost-restate.test.js test/cost-prices.test.js test/cost-ledger.test.js`
Expected: PASS (3 new tests; the restate, prices and ledger tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add lib/cost/ledger.js lib/cost/prices.js test/cost-restate-preview.test.js
git commit -m "Cost ledger: compute a restate's rows without recording them, and peek at the price version"
```

---
### Task 2: `cost.restatePreview` and `cost.corrections`

**Files:**
- Modify: `lib/cost/index.js:32` (a constant), `:628-675` (`restate`: its checks move into two helpers it shares with
  the preview), after `:675` (two functions), `:739-759` (the returned object)
- Test: `test/cost-restate-preview.test.js` (append)

**Interfaces:**
- Consumes: Task 1's `L.restateRows` and `prices.peek`; `settingsNow`, `settingsError`, `store`, `getPricing`,
  `SOURCES`, `fail`, `dayOf`, `isDay` (index.js).
- Produces (on the object `createCost` returns):
  - `restatePreview({ from, to }) → { from, to, rows: [{ key, before, after }], total, versionsBefore, version: id |
    null, newPrices, billing: [{ source, mode, plan?, feeUSD?, period? }] }` (R1). Throws 400 / 409 (`status`) and the
    store's 503 codes, as `restate()` does. Writes nothing.
  - `corrections() → [{ ts, from, to, reason, priceVersion, rows: <count>, billing }]`, newest first, at most 100;
    throws `{ code: 'LEDGER_CORRECTIONS_UNREAD', message: 'the ledger corrections could not be read' }` while they do
    not read (after one retry).
  - `restate()` behaves as before (same messages, same order of checks).

- [ ] **Step 1: Write the failing test**

Append to `test/cost-restate-preview.test.js`:

```js
/* ---------- Task 2: cost.restatePreview and cost.corrections ---------- */

const { createCost } = require('../lib/cost');
const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const MAX = { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' };
// One Sonnet response in ~/work/acme: 1,000 in and 100 out (0.003 at PRICE_A, 0.006 at PRICE_B).
const ev = (ts, key) => [ts, 'claude', 's1', 'claude-sonnet-5-5', 1000, 100, 0, 0, 0, 0, key, null];
const sessions = {
  s1: {
    tool: 'claude',
    project: path.join(HOME, 'work', 'acme'),
    tools: {},
    skills: {},
    agents: {},
    prompts: 0,
    subagentFiles: 0,
  },
};
const logFile = (name, events) => ({
  file: `/logs/${name}.jsonl`,
  source: 'claude',
  size: events.length,
  mtimeMs: 1,
  result: { events, sessions },
});
function rig() {
  const dir = tmp();
  const st = { entries: [], pricing: PRICE_A, settings: undefined, t: at(21) };
  const costDir = path.join(dir, 'cost');
  const make = () =>
    createCost({
      dir: costDir,
      entries: () => st.entries,
      getPricing: () => st.pricing,
      getSettings: () => st.settings,
      home: HOME,
      now: () => st.t,
      nocase: false,
    });
  return { st, costDir, make, cost: make() };
}
// Two closed days of usage, then new prices, the Acme rule and a plan saved without a pass since.
function changedSince() {
  const r = rig();
  r.st.entries.push(logFile('a', [ev(at(20), 'm1'), ev(at(21), 'm2')]));
  r.cost.update();
  r.st.t = at(22);
  r.cost.update();
  r.st.pricing = PRICE_B;
  r.st.settings = { ...ACME, billing: { claude: MAX } };
  return r;
}

test('restatePreview: what the following restate records, with nothing written meanwhile', () => {
  const r = changedSince();
  const disk = snapshot(r.costDir);
  const p = r.cost.restatePreview({ from: '2026-10-20', to: '2026-10-21' });
  assert.deepEqual(snapshot(r.costDir), disk, 'no billing set-up, no price version, no correction');
  assert.equal(r.cost.status().ledger.corrections, 0);
  assert.equal(r.cost.versions().versions.length, 1);
  assert.deepEqual([p.from, p.to, p.total, p.rows.length], ['2026-10-20', '2026-10-21', 2, 2]);
  assert.deepEqual(p.versionsBefore, [1]);
  assert.deepEqual([p.version, p.newPrices], [null, true], 'the new prices are not a version yet');
  assert.ok(p.rows.every((x) => x.after.priceVersion === 2 && x.after.center === 'acme'));
  assert.deepEqual(
    p.billing.find((b) => b.source === 'claude'),
    { source: 'claude', ...MAX },
  );
  assert.deepEqual(
    p.billing.map((b) => b.source),
    ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab'],
  );
  const c = r.cost.restate({ from: '2026-10-20', to: '2026-10-21', reason: 'Acme and new prices' });
  assert.deepEqual(c.rows, p.rows, 'the preview rows are the rows the restate records');
  assert.deepEqual(c.billing, p.billing);
  const again = r.cost.restatePreview({ from: '2026-10-20', to: '2026-10-21' });
  assert.deepEqual([again.rows, again.version, again.newPrices, again.total], [[], 2, false, 2]);
});

test('restatePreview: the refusals of restate(), without a reason', () => {
  const r = changedSince();
  for (const [from, to] of [
    ['2026-10-21', '2026-10-22'], // today
    ['2026-10-21', '2026-10-20'], // reversed
    ['2026-10-32', '2026-10-20'], // not a day
    [undefined, '2026-10-20'],
  ])
    assert.throws(() => r.cost.restatePreview({ from, to }), { status: 400 }, `${from} ${to}`);
  r.st.settings = { billing: { claude: { mode: 'plan' } } }; // a hand edit that does not validate
  assert.throws(() => r.cost.restatePreview({ from: '2026-10-20', to: '2026-10-20' }), {
    status: 409,
    message: /invalid.*fix them before a restate/,
  });
  r.st.settings = ACME;
  const month = path.join(r.costDir, 'ledger-2026-10.jsonl');
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  const text = fs.readFileSync(month, 'utf8');
  if (byMode) fs.chmodSync(month, 0o000);
  else {
    fs.rmSync(month);
    fs.mkdirSync(month);
  }
  try {
    const c = r.make(); // a restart: October does not read
    assert.throws(() => c.restatePreview({ from: '2026-10-20', to: '2026-10-20' }), { code: 'LEDGER_MONTH_UNREAD' });
  } finally {
    if (byMode) fs.chmodSync(month, 0o600);
    else {
      fs.rmSync(month, { recursive: true });
      fs.writeFileSync(month, text);
    }
  }
  assert.equal(r.make().restatePreview({ from: '2026-10-20', to: '2026-10-20' }).rows.length, 1, 'readable again');
});

test('corrections: newest first without their rows, at most 100; unread is LEDGER_CORRECTIONS_UNREAD', () => {
  const r = changedSince();
  r.cost.restate({ from: '2026-10-20', to: '2026-10-20', reason: 'first' });
  r.cost.restate({ from: '2026-10-20', to: '2026-10-21', reason: 'second' });
  const list = r.cost.corrections();
  assert.deepEqual(
    list.map((c) => [c.reason, c.from, c.to, c.rows, c.priceVersion]),
    [
      ['second', '2026-10-20', '2026-10-21', 1, 2],
      ['first', '2026-10-20', '2026-10-20', 1, 2],
    ],
  );
  assert.equal(list[0].ts, at(22));
  assert.deepEqual(list[0].billing.find((b) => b.source === 'claude'), { source: 'claude', ...MAX });

  const mem = createCost({ getPricing: () => PRICE_A, now: () => at(22) });
  for (let i = 0; i < 101; i++) mem.restate({ from: '2026-10-20', to: '2026-10-20', reason: `r${i}` });
  const capped = mem.corrections();
  assert.equal(capped.length, 100);
  assert.deepEqual([capped[0].reason, capped[99].reason], ['r100', 'r1']);

  const file = path.join(r.costDir, 'corrections.jsonl');
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  const text = fs.readFileSync(file, 'utf8');
  if (byMode) fs.chmodSync(file, 0o000);
  else {
    fs.rmSync(file);
    fs.mkdirSync(file);
  }
  try {
    assert.throws(() => r.make().corrections(), {
      code: 'LEDGER_CORRECTIONS_UNREAD',
      message: 'the ledger corrections could not be read',
    });
  } finally {
    if (byMode) fs.chmodSync(file, 0o600);
    else {
      fs.rmSync(file, { recursive: true });
      fs.writeFileSync(file, text);
    }
  }
  assert.equal(r.make().corrections().length, 2, 'readable again');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-restate-preview.test.js`
Expected: FAIL, the 3 new tests: `TypeError: r.cost.restatePreview is not a function` and
`TypeError: r.cost.corrections is not a function`.

- [ ] **Step 3: Implement in `lib/cost/index.js`**

After `const MAX_REASON = 200;` (`:32`), add:

```js
const MAX_RESTATES = 100; // the history the Settings page lists
```

In `restate` (`:635-655`), replace everything from `function restate({ from, to, reason } = {}) {` down to and including
`if (settingsError) throw fail(409, \`${settingsError}: fix them before a restate\`);` with:

```js
  // The range a restate (or its preview) may cover: past days only.
  function checkRestateRange(from, to, today) {
    if (!isDay(from) || !isDay(to)) throw fail(400, 'from and to must be days (YYYY-MM-DD)');
    if (!(from <= to)) throw fail(400, 'from must be on or before to');
    // A correction moves amounts by (after - before); today's rows are rebuilt each pass, so it would count twice.
    if (to >= today) throw fail(400, 'today follows the current prices and rules already; restate up to yesterday');
  }
  // What a restate is built on must read: a month or the corrections that did not read are tried again (as a pass
  // does) before refusing, and the settings in force must validate. Returns them.
  function restateBase(from, to) {
    if (store.unread().length) {
      try {
        store.flush();
      } catch {
        /* still unavailable: assertReadable says which */
      }
    }
    store.assertReadable(from, to);
    const s = settingsNow();
    // The defaults that stand in for invalid settings would re-attribute the range to no center and re-bill every
    // source as metered for good: like observeBilling, a restate never writes billing from them.
    if (settingsError) throw fail(409, `${settingsError}: fix them before a restate`);
    return s;
  }

  function restate({ from, to, reason } = {}) {
    const today = dayOf(now());
    checkRestateRange(from, to, today);
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (!why || why.length > MAX_REASON) throw fail(400, `reason: 1 to ${MAX_REASON} characters`);
    const s = restateBase(from, to);
```

The rest of `restate` (from the comment `// Before the first pass after a start the history may be lost …` to its
closing `}`) stays as it is. After that closing `}`, add:

```js

  // What restate() would record for [from, to], computed and not written (Cost Control 3b): the same refusals, then no
  // billing set-up, no price version and no correction. `version` is null while today's prices are not a version yet
  // (`newPrices`); the rows then carry the id the restate would record, so they equal what it records. `total` counts
  // the usage rows of the range; `billing` is each source's billing the restate would set over it.
  function restatePreview({ from, to } = {}) {
    checkRestateRange(from, to, dayOf(now()));
    const s = restateBase(from, to);
    const peek = prices.peek(getPricing() || {});
    const rows = L.restateRows(store, {
      from,
      to,
      version: peek.version || { id: peek.next },
      pricer: peek.pricer,
      rules: s.rules,
    });
    const before = [...new Set(rows.map((x) => x.before.priceVersion))];
    return {
      from,
      to,
      rows,
      total: store.view(from, to).filter((r) => r.kind !== 'plan').length,
      versionsBefore: before.sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b)),
      version: peek.version ? peek.version.id : null,
      newPrices: !peek.version,
      billing: SOURCES.map((source) => ({ source, ...s.rules.billingOf(source) })),
    };
  }

  // The restates recorded, newest first, at most 100 (Cost Control 3b): what each did, its rows counted, not listed.
  // LEDGER_CORRECTIONS_UNREAD while the corrections do not read (tried again first), never an empty history.
  function corrections() {
    if (store.unread().includes('corrections')) {
      try {
        store.flush();
      } catch {
        /* a month still unread does not matter here */
      }
    }
    if (store.unread().includes('corrections'))
      throw Object.assign(new Error('the ledger corrections could not be read'), { code: L.CORRECTIONS_UNREAD });
    return store
      .corrections()
      .reverse()
      .slice(0, MAX_RESTATES)
      .map((c) => ({
        ts: c.ts,
        from: c.from,
        to: c.to,
        reason: c.reason,
        priceVersion: c.priceVersion,
        rows: c.rows.length,
        billing: Array.isArray(c.billing) ? c.billing : [],
      }));
  }
```

In the returned object (`:739`), after `restate,` add:

```js
    restatePreview,
    corrections,
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/cost-restate-preview.test.js test/cost-restate.test.js test/cost-api.test.js`
Expected: PASS (6 tests in the new file; `restate()`'s tests and the API's restate tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/cost/index.js test/cost-restate-preview.test.js
git commit -m "Cost ledger: preview a restate without writing, and list the restates recorded"
```

---
### Task 3: `lib/cost/preview.js` (pure)

**Files:**
- Create: `lib/cost/preview.js`
- Test: `test/cost-preview.test.js` (create)

**Interfaces:**
- Consumes: `compile`, `globToRegExp`, `UNASSIGNED` from `lib/cost/rules.js`; Task 2's `restatePreview` answer shape
  (for `restateSummary`).
- Produces:
  - `settingsPreview({ saved, draft, rows, testPath, keys, compileOpts }) → { moves: [{ project, keyId, keyName,
    listUSD, from, to }], more, rules: [{ index, status: 'ok' | 'none' | 'shadowed', by }], unassigned: [{ project,
    listUSD }], test: { center, rule } | null }` (R2). `saved`/`draft` are validated settings (`validate().value` or
    `settingsOf().value`); `rows` are ledger rows grouped by `project`, `keyId`; `testPath` a `~` path or null; `keys`
    `[{ id, name }]` for `keyName` (an addition to the spec's signature: the rows do not carry key names); `index`,
    `by` and `test.rule` are 0-based rule indexes (the page shows `#index+1`).
  - `restateSummary({ rows, total, billing, versionsBefore, version, newPrices }) → { changed, total, beforeUSD,
    afterUSD, moves: [{ from, to, listUSD }], versionsBefore, version, newPrices, billing }` (R3). A null center is
    `unassigned`.
  - `MAX_MOVES` (50), `MAX_UNASSIGNED` (20), `MAX_CENTER_MOVES` (20).

- [ ] **Step 1: Write the failing test**

Create `test/cost-preview.test.js`:

```js
// lib/cost/preview.js (Cost Control 3b): what a draft of the cost settings moves, which rules match nothing or are
// never reached, which projects stay Unassigned, where a test path goes; and a restate preview summed for the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, globToRegExp } = require('../lib/cost/rules');
const P = require('../lib/cost/preview');

// Settings as the server keeps them: validated, with the defaults filled in.
const S = (over) => {
  const r = validate(over);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.value;
};
const CENTERS = [
  { id: 'acme', name: 'Acme' },
  { id: 'lab', name: 'Lab' },
  { id: 'ops', name: 'Ops' },
];
const SAVED = S({
  centers: CENTERS,
  keyCenters: { key_ci: 'ops' },
  folderRules: [
    { glob: '~/work/acme/**', center: 'acme' },
    { glob: '~/work/**', center: 'lab' },
  ],
});
const ROWS = [
  { project: '~/work/acme', keyId: null, listUSD: 12 },
  { project: '~/work/acme/api', keyId: null, listUSD: 3 },
  { project: '~/work/tools', keyId: null, listUSD: 5 },
  { project: '~/play', keyId: null, listUSD: 2 },
  { project: '~/Notes', keyId: null, listUSD: 1 },
  { project: null, keyId: 'key_ci', listUSD: 7 },
  { project: null, keyId: 'key_bot', listUSD: 4 },
  { project: null, keyId: null, listUSD: 0.5 }, // the judge: no project, no key
];
const KEYS = [
  { id: 'key_ci', name: 'ci-bot' },
  { id: 'key_bot', name: 'chat bot' },
];
const run = (draft, extra = {}) =>
  P.settingsPreview({ saved: SAVED, draft, rows: ROWS, keys: KEYS, compileOpts: { nocase: false }, ...extra });

test('settingsPreview: a draft equal to the saved settings moves nothing, whatever old rows were tagged', () => {
  const tagged = ROWS.map((r) => ({ ...r, center: 'ops' })); // centers stored on the rows are not used
  const p = P.settingsPreview({ saved: SAVED, draft: SAVED, rows: tagged, keys: KEYS, compileOpts: { nocase: false } });
  assert.deepEqual(p.moves, []);
  assert.equal(p.more, 0);
  assert.deepEqual(
    p.rules.map((r) => r.status),
    ['ok', 'ok'],
  );
  assert.deepEqual(p.unassigned, [
    { project: '~/play', listUSD: 2 },
    { project: '~/Notes', listUSD: 1 },
  ]);
  assert.equal(p.test, null, 'no test path');
});

test('settingsPreview: a key mapping wins over a rule, and the first matching rule wins', () => {
  const draft = S({
    centers: CENTERS,
    keyCenters: { key_ci: 'ops', key_bot: 'lab' },
    folderRules: [
      { glob: '~/**', center: 'ops' },
      { glob: '~/work/acme/**', center: 'acme' },
    ],
  });
  const p = run(draft);
  assert.deepEqual(
    p.moves.map((m) => [m.project ?? `Key: ${m.keyName}`, m.listUSD, m.from, m.to]),
    [
      ['~/work/acme', 12, 'acme', 'ops'],
      ['~/work/tools', 5, 'lab', 'ops'],
      ['Key: chat bot', 4, 'unassigned', 'lab'],
      ['~/work/acme/api', 3, 'acme', 'ops'],
      ['~/play', 2, 'unassigned', 'ops'],
      ['~/Notes', 1, 'unassigned', 'ops'],
    ],
  );
  assert.equal(p.moves[2].keyId, 'key_bot');
  assert.deepEqual(p.rules, [
    { index: 0, status: 'ok', by: null },
    { index: 1, status: 'shadowed', by: 0 },
  ]);
  assert.deepEqual(p.unassigned, []);
});

test('settingsPreview: a rule that matches nothing is none; a rule an earlier one always takes is shadowed by it', () => {
  const draft = S({
    centers: CENTERS,
    folderRules: [
      { glob: '~/clients/**', center: 'acme' },
      { glob: '~/work/**', center: 'lab' },
      { glob: '~/work/acme/**', center: 'acme' },
      { glob: '~/play/**', center: 'ops' },
    ],
  });
  assert.deepEqual(run(draft).rules, [
    { index: 0, status: 'none', by: null },
    { index: 1, status: 'ok', by: null },
    { index: 2, status: 'shadowed', by: 1 },
    { index: 3, status: 'ok', by: null },
  ]);
  // A project only a mapped key reaches is not one the rules decide.
  const keyed = P.settingsPreview({
    saved: SAVED,
    draft: S({ centers: CENTERS, keyCenters: { key_x: 'ops' }, folderRules: [{ glob: '~/x/**', center: 'lab' }] }),
    rows: [{ project: '~/x', keyId: 'key_x', listUSD: 1 }],
    compileOpts: { nocase: false },
  });
  assert.deepEqual(keyed.rules, [{ index: 0, status: 'none', by: null }]);
});

test('settingsPreview: moves by cost, at most 50 with "more"; Unassigned by cost, at most 20', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ project: `~/p${i}`, keyId: null, listUSD: i + 1 }));
  const p = P.settingsPreview({
    saved: S({}),
    draft: S({ centers: CENTERS, folderRules: [{ glob: '~/p1*/**', center: 'lab' }] }),
    rows,
    compileOpts: { nocase: false },
  });
  assert.deepEqual(
    p.moves.map((m) => m.project),
    ['~/p19', '~/p18', '~/p17', '~/p16', '~/p15', '~/p14', '~/p13', '~/p12', '~/p11', '~/p10', '~/p1'],
  );
  assert.equal(p.more, 0);
  assert.equal(p.unassigned.length, P.MAX_UNASSIGNED);
  assert.deepEqual(p.unassigned[0], { project: '~/p59', listUSD: 60 });
  const all = P.settingsPreview({
    saved: S({}),
    draft: S({ centers: CENTERS, folderRules: [{ glob: '~/**', center: 'lab' }] }),
    rows,
    compileOpts: { nocase: false },
  });
  assert.equal(all.moves.length, P.MAX_MOVES);
  assert.equal(all.more, 10);
  assert.equal(all.moves[0].listUSD, 60);
  assert.deepEqual(all.unassigned, []);
});

test('settingsPreview: while the settings do not read, saved is the defaults: every mapped row moves from Unassigned', () => {
  const p = P.settingsPreview({ saved: S({}), draft: SAVED, rows: ROWS, keys: KEYS, compileOpts: { nocase: false } });
  assert.deepEqual(
    p.moves.map((m) => [m.project || m.keyId, m.from, m.to]),
    [
      ['~/work/acme', 'unassigned', 'acme'],
      ['key_ci', 'unassigned', 'ops'],
      ['~/work/tools', 'unassigned', 'lab'],
      ['~/work/acme/api', 'unassigned', 'acme'],
    ],
  );
});

test('settingsPreview: the test path goes through the rules only', () => {
  const at = (testPath, draft = SAVED) => run(draft, { testPath }).test;
  assert.deepEqual(at('~/work/acme/web'), { center: 'acme', rule: 0 });
  assert.deepEqual(at('~/work/zed'), { center: 'lab', rule: 1 });
  assert.deepEqual(at('~/elsewhere'), { center: 'unassigned', rule: null });
  assert.deepEqual(at('key_ci'), { center: 'unassigned', rule: null }, 'a key id is not a path');
  assert.equal(at(''), null);
});

test('settingsPreview: "<project>/**" matches the project it was made from, and only below it', () => {
  for (const project of ['~/work/acme', '~/odd [dir]/x', '/srv/app', 'C:/code/app', '~/a?b']) {
    const re = globToRegExp(`${project}/**`);
    assert.ok(re.test(project), project);
    assert.ok(re.test(`${project}/sub`), `${project}/sub`);
    assert.ok(!re.test(`${project}-other`), `${project}-other`);
    const draft = S({ centers: CENTERS, folderRules: [{ glob: `${project}/**`, center: 'lab' }] });
    const p = P.settingsPreview({ saved: S({}), draft, rows: [{ project, listUSD: 1 }], compileOpts: { nocase: false } });
    assert.deepEqual(p.unassigned, [], project);
    assert.equal(p.rules[0].status, 'ok', project);
  }
});

test('settingsPreview: the case rule is the platform one unless compileOpts names it', () => {
  const draft = S({ centers: CENTERS, folderRules: [{ glob: '~/notes/**', center: 'lab' }] });
  const rows = [{ project: '~/Notes', listUSD: 1 }];
  const loose = P.settingsPreview({ saved: S({}), draft, rows, compileOpts: { nocase: true } });
  assert.deepEqual([loose.moves.length, loose.rules[0].status], [1, 'ok']);
  const strict = P.settingsPreview({ saved: S({}), draft, rows, compileOpts: { nocase: false } });
  assert.deepEqual([strict.moves.length, strict.rules[0].status], [0, 'none']);
  const platform = P.settingsPreview({ saved: S({}), draft, rows });
  const folds = process.platform === 'darwin' || process.platform === 'win32';
  assert.equal(platform.moves.length, folds ? 1 : 0);
});

test('restateSummary: sums before and after, center moves by pair and amount; no change is a plain answer', () => {
  const x = (bUSD, aUSD, from, to) => ({
    key: 'k',
    before: { listUSD: bUSD, priceVersion: 1, center: from, unpriced: false },
    after: { listUSD: aUSD, priceVersion: 2, center: to, unpriced: false },
  });
  const billing = [{ source: 'claude', mode: 'plan', plan: 'Max', feeUSD: 200, period: 'month' }];
  const s = P.restateSummary({
    rows: [
      x(1, 2, 'unassigned', 'acme'),
      x(0.5, 0.75, 'unassigned', 'acme'),
      x(3, 4, 'lab', 'ops'),
      x(0.1, 0.3, 'lab', 'lab'),
      x(1, 1, null, 'acme'),
    ],
    total: 9,
    billing,
    versionsBefore: [1],
    version: null,
    newPrices: true,
  });
  assert.deepEqual(s, {
    changed: 5,
    total: 9,
    beforeUSD: 5.6,
    afterUSD: 8.05,
    moves: [
      { from: 'lab', to: 'ops', listUSD: 4 },
      { from: 'unassigned', to: 'acme', listUSD: 3.75 },
    ],
    versionsBefore: [1],
    version: null,
    newPrices: true,
    billing,
  });
  assert.deepEqual(P.restateSummary({ rows: [], total: 3, billing, versionsBefore: [], version: 2 }), {
    changed: 0,
    total: 3,
    beforeUSD: 0,
    afterUSD: 0,
    moves: [],
    versionsBefore: [],
    version: 2,
    newPrices: false,
    billing,
  });
  const many = Array.from({ length: 25 }, (_, i) => x(0, i + 1, 'unassigned', `c${i}`));
  const capped = P.restateSummary({ rows: many, billing: [] });
  assert.equal(capped.moves.length, P.MAX_CENTER_MOVES);
  assert.equal(capped.moves[0].to, 'c24');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-preview.test.js`
Expected: FAIL: `Error: Cannot find module '../lib/cost/preview'`.

- [ ] **Step 3: Create `lib/cost/preview.js`**

```js
// Cost Control 3b: what a change of the cost settings, or a restate, would do, from rows the caller read. Pure: no I/O,
// no clock. The Settings page draws these answers (POST /api/cost/settings/preview, POST /api/cost/restate/preview).
const { compile, globToRegExp, UNASSIGNED } = require('./rules');

const MAX_MOVES = 50;
const MAX_UNASSIGNED = 20;
const MAX_CENTER_MOVES = 20;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const usd = (v) => Math.round(v * 1e8) / 1e8;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// The case rule compile() uses unless told otherwise: folders compare without case on macOS and Windows.
const nocaseOf = (opts) =>
  opts && typeof opts.nocase === 'boolean' ? opts.nocase : process.platform === 'darwin' || process.platform === 'win32';

/**
 * The effect of `draft` against `saved` (both validated settings) on the last 30 days of rows
 * (`cost.ledger({ groupBy: ['project', 'keyId'] }).rows`), and where `testPath` (a `~` path, or null) goes.
 * `keys` names gateway keys ([{ id, name }]) for the moves.
 */
function settingsPreview({ saved, draft, rows = [], testPath = null, keys = [], compileOpts } = {}) {
  const nocase = nocaseOf(compileOpts);
  const before = compile(saved, { nocase });
  const after = compile(draft, { nocase });
  const names = new Map(keys.map((k) => [k.id, k.name]));
  const globs = draft.folderRules.map((r) => globToRegExp(r.glob, { nocase }));
  const firstRule = (p) => globs.findIndex((re) => re.test(p));

  const moves = [];
  const projects = new Map(); // project -> usage value, for the rows the folder rules decide under the draft
  for (const r of rows) {
    const row = { project: r.project ?? null, keyId: r.keyId ?? null };
    const from = before.centerOf(row);
    const to = after.centerOf(row);
    if (from !== to)
      moves.push({
        project: row.project,
        keyId: row.keyId,
        keyName: row.keyId ? names.get(row.keyId) || null : null,
        listUSD: usd(num(r.listUSD)),
        from,
        to,
      });
    const keyed = row.keyId && Object.hasOwn(draft.keyCenters, row.keyId);
    if (row.project && !keyed) projects.set(row.project, (projects.get(row.project) || 0) + num(r.listUSD));
  }
  moves.sort(
    (a, b) =>
      b.listUSD - a.listUSD || cmp(String(a.project ?? ''), String(b.project ?? '')) || cmp(a.keyId ?? '', b.keyId ?? ''),
  );

  // Each project's deciding rule under the draft, then each rule's status from the projects it matches.
  const first = new Map([...projects.keys()].map((p) => [p, firstRule(p)]));
  const rules = globs.map((re, index) => {
    const hits = [...projects.keys()].filter((p) => re.test(p));
    if (!hits.length) return { index, status: 'none', by: null };
    if (hits.some((p) => first.get(p) === index)) return { index, status: 'ok', by: null };
    return { index, status: 'shadowed', by: Math.min(...hits.map((p) => first.get(p))) };
  });

  const unassigned = [...projects]
    .filter(([p]) => first.get(p) < 0)
    .map(([project, v]) => ({ project, listUSD: usd(v) }))
    .sort((a, b) => b.listUSD - a.listUSD || cmp(a.project, b.project))
    .slice(0, MAX_UNASSIGNED);

  // A path is tested as a project: the rules decide, a key mapping does not apply.
  let test = null;
  if (typeof testPath === 'string' && testPath) {
    const i = firstRule(testPath);
    test = i < 0 ? { center: UNASSIGNED, rule: null } : { center: draft.folderRules[i].center, rule: i };
  }
  return {
    moves: moves.slice(0, MAX_MOVES),
    more: Math.max(0, moves.length - MAX_MOVES),
    rules,
    unassigned,
    test,
  };
}

/** A restate preview (cost.restatePreview) summed for the page: rows that change, usage value before and after, and
 *  the usage value that changes center, per (old center, new center) pair. */
function restateSummary({ rows = [], total = null, billing = [], versionsBefore = [], version = null, newPrices = false }) {
  let beforeUSD = 0;
  let afterUSD = 0;
  const pairs = new Map();
  for (const x of rows) {
    beforeUSD += num(x.before.listUSD);
    afterUSD += num(x.after.listUSD);
    const from = x.before.center ?? UNASSIGNED;
    const to = x.after.center ?? UNASSIGNED;
    if (from === to) continue;
    const k = JSON.stringify([from, to]);
    const m = pairs.get(k) || { from, to, listUSD: 0 };
    m.listUSD += num(x.after.listUSD);
    pairs.set(k, m);
  }
  const moves = [...pairs.values()]
    .map((m) => ({ ...m, listUSD: usd(m.listUSD) }))
    .sort((a, b) => b.listUSD - a.listUSD || cmp(a.from, b.from) || cmp(a.to, b.to))
    .slice(0, MAX_CENTER_MOVES);
  return {
    changed: rows.length,
    total,
    beforeUSD: usd(beforeUSD),
    afterUSD: usd(afterUSD),
    moves,
    versionsBefore,
    version,
    newPrices: !!newPrices,
    billing,
  };
}

module.exports = { settingsPreview, restateSummary, MAX_MOVES, MAX_UNASSIGNED, MAX_CENTER_MOVES };
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test test/cost-preview.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cost/preview.js test/cost-preview.test.js
git commit -m "Cost settings: a pure preview of a settings draft and a restate summary"
```

---
### Task 4: The three routes, `reasons`, and the demo (shared: `lib/cost/api.js`)

**Files:**
- Modify: `lib/cost/api.js:6` (require), `:9` (require), `:14` (constants), `:45` (an option), `:63` (helpers and the
  settings preview after `current`), `:272-275` (the settings answer, a new GET), `:305-311` (two new POST entries; the
  restate route uses the shared checks)
- Test: `test/cost-settings-api.test.js` (create; spawned servers on ports 9200–9399)

**Interfaces:**
- Consumes: Task 2's `cost.restatePreview`, `cost.corrections`; Task 3's `settingsPreview`, `restateSummary`;
  `validate`, `settingsOf`, `normalizeGlob` (rules.js); `cost.ledger`; the existing `scrub`, `keys()`, `checkRange`,
  `fail`, `reply`, `route()` (415, 413, 400 body, 503 for `UNAVAILABLE` codes, fixed 500).
- Produces:
  - `createCostApi({ …, nocase })`: the folder case rule of the settings preview (`undefined` = the platform's).
  - `GET /api/cost/settings` → `{ settings, error, reasons, sources, unassigned, keys }`; `reasons` = the scrubbed
    validation reasons of the saved section (at most 50), `[]` when it reads, when nothing is saved, or when
    `config.json` does not parse.
  - `POST /api/cost/settings/preview` body `{ settings, testPath? }` → 200 `{ from, to, unread, moves, more, rules,
    unassigned, test }`; 400 `unknown field: …`, `testPath: a string of at most 1000 characters`, or
    `{ error: 'invalid cost settings', reasons }`; 503 `{ error, code }`.
  - `POST /api/cost/restate/preview` body `{ from, to }` → 200 `{ from, to, changed, total, beforeUSD, afterUSD, moves,
    versionsBefore, version, newPrices, billing }`; 400 / 409 / 503 as `POST /api/cost/restate`.
  - `GET /api/cost/restates` → 200 `{ restates: [{ ts, from, to, reason, priceVersion, rows, billing }] }`; 503 while
    the corrections do not read.
  - The demo needs no change: `server.js` builds the demo's cost object with `createCost({ demo })`, so the previews
    read the demo ledger and settings and the history is the demo's corrections (none until a restate), all in memory.

- [ ] **Step 1: Write the failing test**

Create `test/cost-settings-api.test.js`:

```js
// The Settings page's routes (Cost Control 3b, lib/cost/api.js): POST /api/cost/settings/preview,
// POST /api/cost/restate/preview, GET /api/cost/restates and `reasons` in GET /api/cost/settings. In process with a
// real cost object, then over HTTP: the dashboard sign-in only, and the demo. Never the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { costDemo } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-settings-api-'));
const ACME = { centers: [{ id: 'acme', name: 'Acme' }], keyCenters: { key_a: 'acme' } };
// One gateway line of key_a: a Sonnet call of 1,000 in and 100 out (0.003 at PRICE_A).
const line = (ts) =>
  JSON.stringify({
    ts,
    keyId: 'key_a',
    provider: 'p',
    model: 'claude-sonnet-5-5',
    kind: 'chat',
    input: 1000,
    output: 100,
  }) + '\n';

function setup({ saved, demo = null, cost: fake = null } = {}) {
  const dir = tmp();
  const st = { saved, t: at(22), pricing: PRICE_A };
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const cost =
    fake ||
    createCost({
      dir: demo ? null : path.join(dir, 'cost'),
      gatewayLog: demo ? null : gatewayLog,
      getPricing: () => st.pricing,
      getSettings: () => st.saved,
      home: HOME,
      now: () => st.t,
      nocase: false,
      demo,
    });
  const api = createCostApi({
    cost,
    settings: { get: () => st.saved, save: (v) => (st.saved = v) },
    listKeys: () => [{ id: 'key_a', name: 'Acme app', hash: 'never-shown' }],
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const bodies = [];
  const call = async (method, p, body) => {
    const res = await api.route({
      method,
      path: p,
      query: new URLSearchParams(),
      contentType: 'application/json',
      readBody: async () => (body === undefined ? '' : JSON.stringify(body)),
    });
    if (res) bodies.push(JSON.stringify(res.body));
    return res;
  };
  return { st, cost, call, bodies, gatewayLog, dir };
}

test('settings answer: reasons are the scrubbed validation reasons, [] when the section reads or config.json does not', async () => {
  const ok = await setup({ saved: ACME }).call('GET', '/api/cost/settings');
  assert.deepEqual([ok.body.error, ok.body.reasons], [null, []]);
  assert.deepEqual(Object.keys(ok.body).sort(), ['error', 'keys', 'reasons', 'settings', 'sources', 'unassigned']);
  const bad = setup({ saved: { centers: 'nope', [`${HOME}/x`]: 1 } });
  const b = await bad.call('GET', '/api/cost/settings');
  assert.match(b.body.error, /cost settings in config\.json are invalid/);
  assert.ok(b.body.reasons.includes('centers must be a list'));
  assert.equal(b.body.reasons.length, 2);
  assert.match(b.body.reasons.find((r) => r.startsWith('unknown field')), /\[path\]/);
  const broken = await setup({ saved: false }).call('GET', '/api/cost/settings');
  assert.match(broken.body.error, /config\.json could not be read/);
  assert.deepEqual(broken.body.reasons, []);
  for (const x of bad.bodies) assert.doesNotMatch(x, PATHS);
});

test('settings preview: a draft against the settings in force over the last 30 days; nothing saved', async () => {
  const s = setup();
  fs.writeFileSync(s.gatewayLog, line(at(21)) + line(at(22)));
  s.cost.update();
  const draft = { ...ACME, folderRules: [{ glob: `${HOME}/work/**`, center: 'acme' }] };
  const r = await s.call('POST', '/api/cost/settings/preview', { settings: draft, testPath: `${HOME}/work/site` });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.from, r.body.to, r.body.unread], ['2026-09-23', '2026-10-22', []]);
  assert.deepEqual(r.body.moves, [
    { project: null, keyId: 'key_a', keyName: 'Acme app', listUSD: 0.006, from: 'unassigned', to: 'acme' },
  ]);
  assert.equal(r.body.more, 0);
  assert.deepEqual(r.body.rules, [{ index: 0, status: 'none', by: null }]);
  assert.deepEqual(r.body.test, { center: 'acme', rule: 0 }, 'the test path is rewritten to ~ like a glob');
  assert.equal(s.st.saved, undefined, 'a preview saves nothing');
  const none = await s.call('POST', '/api/cost/settings/preview', { settings: {} });
  assert.deepEqual([none.body.moves, none.body.test], [[], null]);
});

test('settings preview: unknown fields, a bad test path and a draft that does not validate are 400s', async () => {
  const s = setup();
  const post = (body) => s.call('POST', '/api/cost/settings/preview', body);
  const extra = await post({ settings: {}, budgets: [] });
  assert.deepEqual([extra.status, extra.body.error], [400, 'unknown field: budgets']);
  assert.equal((await post({ settings: {}, testPath: 7 })).status, 400);
  const long = await post({ settings: {}, testPath: `~/${'a'.repeat(1000)}` });
  assert.deepEqual([long.status, long.body.error], [400, 'testPath: a string of at most 1000 characters']);
  const bad = await post({ settings: { centers: [{ id: 'acme', name: 'Acme' }], folderRules: [{ glob: 'x/**' }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid cost settings');
  assert.deepEqual(bad.body.reasons, ['folderRules[0].glob: starts with ~, /, * or a drive letter like C:/']);
  assert.equal((await post({})).body.reasons[0], 'cost settings must be an object');
});

test('restate preview: the restate rules without reason and confirm; it writes nothing', async () => {
  const s = setup();
  fs.writeFileSync(s.gatewayLog, line(at(20)) + line(at(21)));
  s.cost.update();
  s.st.saved = ACME;
  s.st.pricing = PRICE_B;
  const post = (body) => s.call('POST', '/api/cost/restate/preview', body);
  for (const [body, why] of [
    [{ from: '2026-10-20', to: '2026-10-22' }, /up to yesterday/],
    [{ from: '2025-01-01', to: '2026-10-21' }, /at most 400 days/],
    [{ from: '2026-10-21', to: '2026-10-20' }, /on or before/],
    [{ from: '2026-10-20', to: '2026-10-21', reason: 'x' }, /unknown field: reason/],
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  const r = await post({ from: '2026-10-20', to: '2026-10-21' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    [r.body.from, r.body.to, r.body.changed, r.body.total, r.body.versionsBefore, r.body.version, r.body.newPrices],
    ['2026-10-20', '2026-10-21', 2, 2, [1], null, true],
  );
  assert.deepEqual([r.body.beforeUSD, r.body.afterUSD], [0.006, 0.012]);
  assert.deepEqual(r.body.moves, [{ from: 'unassigned', to: 'acme', listUSD: 0.012 }]);
  assert.equal(r.body.billing.length, 6);
  assert.equal(s.cost.status().ledger.corrections, 0, 'nothing restated');
  assert.equal(s.cost.versions().versions.length, 1, 'no price version recorded');
  s.st.saved = { centers: 'nope' };
  const invalid = await post({ from: '2026-10-20', to: '2026-10-21' });
  assert.equal(invalid.status, 409);
  assert.match(invalid.body.error, /invalid/);
});

test('restates: newest first, the reasons as written; [] before any', async () => {
  const s = setup({ saved: ACME });
  fs.writeFileSync(s.gatewayLog, line(at(20)));
  s.cost.update();
  assert.deepEqual((await s.call('GET', '/api/cost/restates')).body, { restates: [] });
  const reason = 'Acme <b>moved</b> & "fixed"';
  const done = await s.call('POST', '/api/cost/restate', { from: '2026-10-20', to: '2026-10-20', reason, confirm: true });
  assert.equal(done.status, 200);
  const list = (await s.call('GET', '/api/cost/restates')).body.restates;
  assert.deepEqual(
    list.map((c) => [c.reason, c.from, c.to, c.rows, c.priceVersion]),
    [[reason, '2026-10-20', '2026-10-20', 0, 1]], // the rows were attributed with these settings already
  );
  assert.equal((await s.call('POST', '/api/cost/restates', {})).status, 405);
});

test('the new routes: store codes are path-free 503s, any other failure a fixed 500', async () => {
  const where = path.join(HOME, '.data', 'cost', 'ledger-2026-10.jsonl');
  let thrown = null;
  const boom = () => {
    throw thrown;
  };
  const s = setup({ cost: { restatePreview: boom, corrections: boom, ledger: boom } });
  const calls = [
    () => s.call('POST', '/api/cost/restate/preview', { from: '2026-10-20', to: '2026-10-21' }),
    () => s.call('GET', '/api/cost/restates'),
    () => s.call('POST', '/api/cost/settings/preview', { settings: {} }),
  ];
  for (const code of ['LEDGER_MONTH_UNREAD', 'LEDGER_CORRECTIONS_UNREAD', 'BILLING_UNREAD']) {
    thrown = Object.assign(new Error(`not available at ${where}`), { code });
    for (const c of calls) {
      const r = await c();
      assert.equal(r.status, 503, code);
      assert.equal(r.body.code, code);
    }
  }
  thrown = new Error(`boom at ${where}`);
  for (const c of calls) assert.deepEqual(await c(), { status: 500, body: { error: 'cost request failed' } });
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('the demo: previews from the demo ledger and settings, an empty history; all in memory', async () => {
  const now = Date.now();
  const d = costDemo(now);
  const s = setup({ saved: d.settings, demo: d });
  s.st.t = now;
  const { budgets, ...saved } = d.settings;
  const same = await s.call('POST', '/api/cost/settings/preview', { settings: saved });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.moves, []);
  assert.ok(same.body.rules.every((r) => r.status === 'ok'));
  const bare = await s.call('POST', '/api/cost/settings/preview', { settings: { ...saved, folderRules: [] } });
  assert.ok(bare.body.moves.length > 0);
  assert.ok(bare.body.moves.every((m) => m.to === 'unassigned' && m.project));
  assert.ok(bare.body.unassigned.some((u) => u.project === '~/acme-web'));
  const y = addDays(dayOf(now), -1);
  const r = await s.call('POST', '/api/cost/restate/preview', { from: addDays(y, -6), to: y });
  assert.equal(r.status, 200);
  assert.ok(r.body.total > 0);
  assert.deepEqual((await s.call('GET', '/api/cost/restates')).body, { restates: [] });
  assert.equal(budgets.length, 3, 'budgets are saved through their own routes, never sent here');
});

// ---- over HTTP ----

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own: 9200-9399 (no other test uses it; 3a takes 8800-9199).
    const port = 9200 + Math.floor(Math.random() * 200);
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
        // An answer could come from another process on the port: trust it only while our child is still up.
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
  const call = async (p, { method = 'GET', body } = {}) => {
    const r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...(body !== undefined ? JSON_HEADERS : {}) },
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
    return { status: r.status, json };
  };
  return { call, post: (p, body) => call(p, { method: 'POST', body }), bodies };
}

test('over HTTP: the dashboard sign-in only, never a gateway key', async () => {
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
  const y = addDays(dayOf(Date.now()), -1);
  try {
    const bearer = client(s.base, { authorization: `Bearer ${secret}`, 'x-api-key': secret });
    for (const who of [client(s.base), bearer]) {
      assert.equal((await who.call('/api/cost/restates')).status, 401);
      assert.equal((await who.post('/api/cost/settings/preview', { settings: {} })).status, 401);
      assert.equal((await who.post('/api/cost/restate/preview', { from: y, to: y })).status, 401);
    }
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
    assert.deepEqual((await c.call('/api/cost/restates')).json, { restates: [] });
    const p = await c.post('/api/cost/settings/preview', { settings: {} });
    assert.equal(p.status, 200);
    assert.deepEqual(p.json.moves, []);
    const r = await c.post('/api/cost/restate/preview', { from: y, to: y });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, 0);
    assert.deepEqual((await c.call('/api/cost/settings')).json.reasons, []);
    for (const body of [...c.bodies, ...bearer.bodies]) assert.doesNotMatch(body, PATHS);
  } finally {
    await s.stop();
  }
});

test('over HTTP: the demo answers the previews and records a restate in memory, path-free', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const saved = (await c.call('/api/cost/settings')).json;
    assert.deepEqual(saved.reasons, []);
    const p = await c.post('/api/cost/settings/preview', { settings: { ...saved.settings, folderRules: [] } });
    assert.equal(p.status, 200);
    assert.ok(p.json.moves.length > 0);
    const y = addDays(dayOf(Date.now()), -1);
    const from = addDays(y, -6);
    assert.equal((await c.post('/api/cost/restate/preview', { from, to: y })).status, 200);
    assert.deepEqual((await c.call('/api/cost/restates')).json, { restates: [] });
    const done = await c.post('/api/cost/restate', { from, to: y, reason: 'demo check', confirm: true });
    assert.equal(done.status, 200);
    const list = (await c.call('/api/cost/restates')).json.restates;
    assert.deepEqual(
      list.map((x) => [x.reason, x.from, x.to]),
      [['demo check', from, y]],
    );
    for (const body of c.bodies) assert.doesNotMatch(body, PATHS);
  } finally {
    await s.stop();
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-settings-api.test.js`
Expected: FAIL, 9 tests (the new routes answer 404 `unknown route`; the settings answer has no `reasons`).

- [ ] **Step 3: Implement in `lib/cost/api.js`**

Line 6 becomes:

```js
const { validate, settingsOf, normalizeGlob, SOURCES, UNASSIGNED, rateFor } = require('./rules');
```

After `const views = require('./views');` (`:9`), add:

```js
const preview = require('./preview');
```

After `const RESTATE_FIELDS = ['from', 'to', 'reason', 'confirm'];` (`:14`), add:

```js
const RESTATE_PREVIEW_FIELDS = ['from', 'to'];
const SETTINGS_PREVIEW_FIELDS = ['settings', 'testPath'];
const PREVIEW_DAYS = 30; // the settings preview reads the last 30 days
const MAX_TEST_PATH = 1000;
```

In the options of `createCostApi`, after `passRates = () => ({}),` (`:45`), add:

```js
  // Folder case rule of the settings preview, as the cost object's (tests pass false); the platform's otherwise.
  nocase,
```

After `const current = () => settingsOf(settings.get(), { home });` (`:63`), add:

```js
  // Why the saved cost section does not validate, for the Settings page's banner: at most 50, scrubbed; none while
  // config.json does not parse (that is the error itself) or the section reads.
  function reasonsOf(raw, s) {
    if (!s.error || s.unreadable || raw === undefined || raw === null) return [];
    const r = validate(raw, { home });
    return r.ok ? [] : r.errors.slice(0, 50).map(scrub);
  }
  const unknownFields = (body, allowed) => {
    for (const k of Object.keys(body)) if (!allowed.includes(k)) throw fail(400, `unknown field: ${k.slice(0, 40)}`);
  };
  // The range a restate or its preview may cover: the ledger's range rules, and past days only.
  function checkRestateRange(body) {
    checkRange(body.from, body.to);
    // Today's rows follow the current prices and rules already; a correction over them would count twice.
    if (body.to >= dayOf(now()))
      throw fail(400, 'today follows the current prices and rules already; restate up to yesterday');
  }

  // POST /api/cost/settings/preview (Cost Control 3b): what an unsaved draft would move over the last 30 days, with
  // the server's own validation and glob matcher. Nothing is saved; a draft that does not validate is a 400 with its
  // reasons, as a save would be.
  function settingsPreview(body) {
    unknownFields(body, SETTINGS_PREVIEW_FIELDS);
    const raw = body.testPath;
    if (raw !== undefined && (typeof raw !== 'string' || raw.length > MAX_TEST_PATH))
      throw fail(400, `testPath: a string of at most ${MAX_TEST_PATH} characters`);
    const r = validate(body.settings, { home });
    if (!r.ok) return reply(400, { error: 'invalid cost settings', reasons: r.errors.map(scrub) });
    const to = dayOf(now());
    const from = addDays(to, -(PREVIEW_DAYS - 1));
    const led = cost.ledger({ from, to, groupBy: ['project', 'keyId'] });
    const testPath = raw && raw.trim() ? normalizeGlob(raw.trim(), home) : null;
    const out = preview.settingsPreview({
      saved: current().value,
      draft: r.value,
      rows: led.rows,
      testPath,
      keys: keys(),
      compileOpts: typeof nocase === 'boolean' ? { nocase } : undefined,
    });
    return reply(200, { from, to, unread: [...(led.unread || [])], ...out });
  }
```

Replace the `'/api/cost/settings'` entry of `GET` (`:272-275`) with:

```js
    '/api/cost/settings': () => {
      const raw = settings.get();
      const s = settingsOf(raw, { home });
      return reply(200, {
        settings: s.value,
        error: s.error,
        reasons: reasonsOf(raw, s),
        sources: SOURCES,
        unassigned: UNASSIGNED,
        keys: keys(),
      });
    },
    // The restates recorded, newest first: the reasons as the owner wrote them (no path is ever in one).
    '/api/cost/restates': () => reply(200, { restates: cost.corrections() }),
```

In `POST`, replace the first lines of the `'/api/cost/restate'` entry (`:305-311`, from `'/api/cost/restate': (body) => {`
down to its `throw fail(400, 'today follows …');`) with:

```js
    '/api/cost/settings/preview': (body) => settingsPreview(body),
    // What a restate of the range would do, written nowhere: the restate's own 400, 409 and 503, without a reason.
    '/api/cost/restate/preview': (body) => {
      unknownFields(body, RESTATE_PREVIEW_FIELDS);
      checkRestateRange(body);
      const p = cost.restatePreview({ from: body.from, to: body.to });
      return reply(200, { from: p.from, to: p.to, ...preview.restateSummary(p) });
    },
    '/api/cost/restate': (body) => {
      unknownFields(body, RESTATE_FIELDS);
      checkRestateRange(body);
```

The rest of the restate entry (from `const reason = …`) stays as it is.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/cost-settings-api.test.js test/cost-api.test.js test/cost-budgets-api.test.js test/budgets-http.test.js`
Expected: PASS (9 new tests; the existing API tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/cost/api.js test/cost-settings-api.test.js
git commit -m "Cost API: settings and restate previews, the restate history, and why the settings do not read"
```

---
### Task 5: The Settings page frame (shared: `public/costview.js`, `public/iso.js`, `public/index.html`, `public/styles.css`)

**Files:**
- Create: `public/costsettings.js` (the frame: constants, drafts, request bodies, state, panel markup, load, Save,
  mount, events; the panel bodies come in Tasks 6–8)
- Modify: `public/costview.js:8-13` (`COST_SUBS`), `:465` (the copy line), `:515` (`costRefresh`), `:1331` (exports)
- Modify: `public/iso.js:593` (`SUBPAGES.cost`), `public/index.html:47` (sidebar), `:143` (script tag)
- Modify: `public/styles.css` (append the `.cost-set-*` rules)
- Test: `test/cost-settings-ui.test.js` (create)

**Interfaces:**
- Consumes: from `costview.js` (globals in the browser; exported for Node by this task): `COST`, `COST_SOURCES`,
  `COST_MAX_DAYS`, `costToday`, `costGet`, `costPost`, `costSub`, `costReasonsHtml`, `costRibbonHtml`, `costErrorHtml`,
  `costShowError`, `costIsDay`, `costAddDays`, `costMoney`, `costUnreadText`; from `iso.js`: `$`, `onUnmount`,
  `settle`; `esc` (app.js). `GET /api/cost/settings` (Task 4's `reasons`), `GET /api/cost/budgets`,
  `GET /api/cost/status`, `POST /api/cost/settings`.
- Produces (top-level names in `public/costsettings.js`):
  - Registries the later tasks fill: `COST_SET_BODIES` (panel → `(st) => markup`), `COST_SET_ACTIONS`
    (`data-cost-set-act` → `(button) => void`), `COST_SET_ON_INPUT` (`(field, panel, path) => void`),
    `COST_SET_ON_CHANGE` (`(field) => void`), `COST_SET_ON_OPEN` (`(panel) => void`), `COST_SET_ON_LOAD`
    (`() => void`).
  - Pure: `costSetFromSaved(panel, settings, sources)`, `costSetBody(panel, saved, draft, sources)` (R4),
    `costSetDirty(panel, saved, draft, sources)`, `costSetAssign(draft, path, value)`, `costSetReasonPaths(reasons)`,
    `costSetLocked(answer)`, `costSetField(panel, path, st)`, `costSetMsgHtml(msg)`, `costSetSaveHtml(panel, st)`,
    `costSetBannerHtml(answer)`, `costSetPanelInner(panel, st)`, `costSetPageHtml(st)`.
  - State: `COST_SET` (`answer`, `budgets`, `drafts`, `msg`, `marks`, `busy`, `open`, `gen`, `preview`, `previewReq`,
    `previewTimer`, `testPath`, `restate`, `restateReq`, `history`, `historyError`, `historyReq`, `mounted`,
    `hooked`). The spec's `COST.settings.drafts[panel]` is `COST_SET.drafts[panel]`: `COST.settings` already holds the
    settings answer that every cost page reloads.
  - Page: `costMountSettings()`, `costSetUnmount()`, `costSetLoad(quiet)`, `costSetSave(panel)`, `costSetEdit(panel,
    fn)`, `costSetDraftOf(panel)`, `costSetAnyDirty()`, `costSetPaint(focus)`, `costSetPaintPanel(panel, focus)`,
    `costSetPaintSoon(panel)`, `costSetPaintDirty(panel)`, `costSetInstallEvents()`.
  - Markup hooks: `[data-cost-set-panel]` (a `<details>`), `[data-cost-set-body]`, `[data-cost-set-dirty]`,
    `[data-cost-set-msg]`, `[data-cost-set-field="<panel>:<path>"]`, `[data-cost-set-act]` with `data-panel`,
    `data-i`, `data-src`, `data-mode`, `data-on`; `data-cost-set-repaint` on a field whose change redraws its panel.
- Behaviour:
  - `#cost/settings` is the fifth sub-page (sidebar, sub-tabs, crumb). Its bar is empty, its ribbon the ledger status
    one. `costRefresh(true)` (the 60-second cycle) never reloads it; `costRefresh(false)` (route, Retry) mounts it.
  - Four `<details>` panels, the first three open; the open state lives in `COST_SET.open`.
  - A field edit stores the panel's draft (made from the saved values on the first edit) without a repaint; the
    "Unsaved changes" line with **Discard** follows the draft. Drafts outlive the page for the life of the tab; a
    `beforeunload` warning asks while any draft is dirty.
  - While the answer has `error`: the banner with the reasons, every Save disabled with "Fix config.json first".
  - Save: `GET /api/cost/settings` again, then `POST` the panel's body. 200: the draft goes, `COST_SET.gen` +1, the
    note (rules and billing: the "applies from today" text with **Open Restate**; currency: "Saved."), then a quiet
    reload. 400: the reasons under Save and `aria-invalid` on the fields they name. 409 with reasons: the reasons
    with **Open Budgets**; 409 without: the message ("config.json could not be read; fix it first"). A failure
    keeps the draft.

- [ ] **Step 1: Write the failing test**

Create `test/cost-settings-ui.test.js`:

```js
// Cost Control → Settings (public/costsettings.js), without a browser: the page's wiring, each panel's request body,
// drafts and their dirty state, the reasons' field marks, the locked page while the settings do not read, the Save
// flow against a fake server; then (Tasks 6-8) the panels' helpers and markup, and an audit for esc() (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// The page loads costview.js first: its helpers are globals there.
const V = require('../public/costview');
Object.assign(global, V);
const U = require('../public/costsettings');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const EVIL = '<img src=x onerror=alert(1)>';
const SOURCES = ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab'];
const SAVED = {
  centers: [
    { id: 'acme', name: 'Acme' },
    { id: 'lab', name: 'Lab' },
  ],
  keyCenters: { key_ci: 'lab' },
  folderRules: [{ glob: '~/work/acme/**', center: 'acme' }],
  billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 200, period: 'month' } },
  currency: { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 16250 }] },
};
const ANSWER = (over = {}) => ({
  settings: SAVED,
  error: null,
  reasons: [],
  sources: SOURCES,
  unassigned: 'unassigned',
  keys: [
    { id: 'key_ci', name: 'ci-bot' },
    { id: 'key_web', name: 'web' },
  ],
  ...over,
});
const clone = (v) => JSON.parse(JSON.stringify(v));
// A state for the markup builders, as the page starts with it, on a fixed day.
const ST = (over = {}) => ({
  ...clone(U.COST_SET),
  answer: ANSWER(),
  budgets: [],
  drafts: {},
  msg: {},
  marks: {},
  busy: {},
  preview: null,
  testPath: '',
  today: '2026-10-28',
  ...over,
});

test('the page is wired: sub-page, sidebar entry, script after costview.js, copy, and no quiet refresh', () => {
  const html = read('index.html');
  assert.match(html, /<a class="nav-sub" href="#cost\/budgets"[^\n]*\n\s*<a class="nav-sub" href="#cost\/settings" data-route="cost\/settings">Settings<\/a>/);
  const at = html.indexOf('<script src="costsettings.js"></script>');
  assert.ok(at > html.indexOf('<script src="costview.js"></script>') && at < html.indexOf('<script src="app.js"></script>'));
  assert.match(read('iso.js'), /\['budgets', 'Budgets'\],\s*\['settings', 'Settings'\],\s*\],/);
  assert.deepEqual(V.COST_SUBS[V.COST_SUBS.length - 1], ['settings', 'Settings']);
  assert.match(read('costview.js'), /settings: 'Cost centers and their rules, billing per source, the display currency, and restating past days\.'/);
  // costRefresh mounts Settings on a load and never on the 60-second cycle.
  const calls = [];
  global.state = { sub: 'settings' };
  global.$ = (s) => (s === '#cost-app' ? { contains: () => false } : null);
  global.document = { hidden: false, activeElement: null };
  global.costMountSettings = () => calls.push('mount');
  try {
    V.costRefresh(true);
    assert.deepEqual(calls, []);
    V.costRefresh(false);
    assert.deepEqual(calls, ['mount']);
  } finally {
    global.costMountSettings = U.costMountSettings;
  }
});

test('each panel sends the saved settings with only its own fields replaced', () => {
  const rules = U.costSetFromSaved('rules', SAVED, SOURCES);
  rules.centers.push({ id: ' ops ', name: ' Ops ', isNew: true, idEdited: false });
  rules.folderRules.push({ glob: ' ~/ops/** ', center: 'ops' });
  rules.keyCenters.key_web = 'ops';
  const r = U.costSetBody('rules', SAVED, rules, SOURCES);
  assert.deepEqual(r.centers[2], { id: 'ops', name: 'Ops' }, 'trimmed, no form flags');
  assert.deepEqual(r.folderRules[1], { glob: '~/ops/**', center: 'ops' });
  assert.deepEqual(r.keyCenters, { key_ci: 'lab', key_web: 'ops' });
  assert.deepEqual([r.billing, r.currency], [SAVED.billing, SAVED.currency], 'the other sections as saved');

  const billing = U.costSetFromSaved('billing', SAVED, SOURCES);
  assert.deepEqual(billing.billing.claude, { mode: 'plan', plan: 'Max', feeUSD: '200', period: 'month' });
  assert.deepEqual(billing.billing.codex, { mode: 'metered', plan: '', feeUSD: '', period: 'month' });
  billing.billing.codex = { mode: 'plan', plan: ' Pro ', feeUSD: ' 20 ', period: 'year' };
  billing.billing.gateway = { mode: 'plan', plan: 'X', feeUSD: '', period: 'month' };
  const b = U.costSetBody('billing', SAVED, billing, SOURCES);
  assert.deepEqual(Object.keys(b.billing), SOURCES, 'every source written out');
  assert.deepEqual(b.billing.codex, { mode: 'plan', plan: 'Pro', feeUSD: 20, period: 'year' });
  assert.equal(b.billing.gateway.feeUSD, null, 'an empty fee is sent for the server to refuse');
  assert.deepEqual(b.billing.judge, { mode: 'metered' });
  assert.deepEqual([b.centers, b.keyCenters, b.folderRules, b.currency], [SAVED.centers, SAVED.keyCenters, SAVED.folderRules, SAVED.currency]);

  const cur = U.costSetFromSaved('currency', SAVED, SOURCES);
  assert.deepEqual(cur.currency, { on: 'on', code: 'IDR', rates: [{ from: '2026-10-01', perUSD: '16250' }] });
  cur.currency.code = ' eur ';
  cur.currency.rates.unshift({ from: '2026-10-20', perUSD: '0.9' });
  const c = U.costSetBody('currency', SAVED, cur, SOURCES);
  assert.deepEqual(c.currency, {
    code: 'EUR',
    rates: [
      { from: '2026-10-01', perUSD: 16250 },
      { from: '2026-10-20', perUSD: 0.9 },
    ],
  });
  assert.equal(U.costSetBody('currency', SAVED, { currency: { ...cur.currency, on: 'off' } }, SOURCES).currency, null);
  assert.deepEqual(U.costSetFromSaved('currency', { ...SAVED, currency: null }, SOURCES).currency, {
    on: 'off',
    code: '',
    rates: [],
  });
  assert.equal(c.billing, SAVED.billing);
});

test('drafts: dirty only when the body would change; paths set fields; an empty key choice removes the mapping', () => {
  const d = U.costSetFromSaved('rules', SAVED, SOURCES);
  assert.equal(U.costSetDirty('rules', SAVED, null, SOURCES), false, 'no draft');
  assert.equal(U.costSetDirty('rules', SAVED, d, SOURCES), false, 'a draft equal to the saved values');
  U.costSetAssign(d, 'centers.0.name', ' Acme ');
  assert.equal(U.costSetDirty('rules', SAVED, d, SOURCES), false, 'spaces around a name are not a change');
  U.costSetAssign(d, 'folderRules.0.center', 'lab');
  assert.equal(d.folderRules[0].center, 'lab');
  assert.equal(U.costSetDirty('rules', SAVED, d, SOURCES), true);
  U.costSetAssign(d, 'keyCenters.key_web', 'acme');
  U.costSetAssign(d, 'keyCenters.key_ci', '');
  assert.deepEqual(d.keyCenters, { key_web: 'acme' });
  U.costSetAssign(d, '__proto__.polluted', 'x');
  U.costSetAssign(d, 'centers.9.name', 'x');
  assert.equal({}.polluted, undefined);
  assert.equal(d.centers.length, 2, 'a path to nothing is ignored');
  const billing = U.costSetFromSaved('billing', SAVED, SOURCES);
  U.costSetAssign(billing, 'billing.claude.feeUSD', '250');
  assert.equal(U.costSetDirty('billing', SAVED, billing, SOURCES), true);
});

test('reasons name fields: the path of each one that does, for the error mark', () => {
  assert.deepEqual(
    U.costSetReasonPaths([
      'folderRules[2].center: unknown cost center',
      'centers[0].id: lower-case letters, digits and dashes, up to 40',
      'keyCenters.key_a: unknown cost center',
      'billing.claude.plan: 1 to 60 characters',
      'currency.rates[1].perUSD: a number above 0',
      'at most 50 cost centers',
      'budget team: unknown cost center',
    ]),
    ['folderRules.2.center', 'centers.0.id', 'keyCenters.key_a', 'billing.claude.plan', 'currency.rates.1.perUSD'],
  );
  assert.deepEqual(U.costSetReasonPaths(null), []);
});

test('while the settings do not read: the banner with its reasons, every Save disabled', () => {
  const locked = ST({ answer: ANSWER({ error: 'the cost settings in config.json are invalid', reasons: [EVIL] }) });
  assert.equal(U.costSetLocked(locked.answer), true);
  assert.equal(U.costSetLocked(ANSWER()), false);
  const html = U.costSetPageHtml(locked);
  assert.match(html, /class="cost-banner warn"/);
  assert.match(html, /<li>&lt;img src=x onerror=alert\(1\)&gt;<\/li>/);
  assert.doesNotMatch(html, /<img/);
  assert.equal((html.match(/data-cost-set-panel="/g) || []).length, 4);
  for (const p of ['rules', 'billing', 'currency']) {
    const save = U.costSetSaveHtml(p, locked);
    assert.match(save, /data-cost-set-act="save"[^>]*disabled/, p);
    assert.match(save, /Fix config\.json first/);
    assert.doesNotMatch(U.costSetSaveHtml(p, ST()), /disabled/);
  }
  assert.equal(U.costSetBannerHtml(ANSWER()), '');
  assert.match(U.costSetPageHtml(ST()), /<details class="holo panel cost-set-panel" data-cost-set-panel="restate" >/);
});

test('save messages: applies from today with the Restate link, budgets with Open Budgets, all text escaped', () => {
  const ok = U.costSetMsgHtml({ tone: 'ok', text: 'Saved. New costs follow these rules from today. To apply them to past days, use Restate.', restate: true });
  assert.match(ok, /Saved\. New costs follow these rules from today\. To apply them to past days, use Restate\./);
  assert.match(ok, /data-cost-set-act="open-restate"/);
  const dep = U.costSetMsgHtml({ tone: 'warn', text: EVIL, reasons: [`budget ${EVIL}: unknown cost center`], budgets: true });
  assert.match(dep, /<a class="link-btn" href="#cost\/budgets">Open Budgets<\/a>/);
  assert.doesNotMatch(dep, /<img/);
  assert.equal(U.costSetMsgHtml(null), '');
});

// A fake server for the Save flow: each request is recorded and answered from `routes`.
function fakeServer(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = routes[`${opts.method || 'GET'} ${url}`];
    if (r instanceof Error) throw r;
    const out = typeof r === 'function' ? r() : r;
    return { status: out.status, json: async () => out.json };
  };
  return calls;
}
function resetState() {
  Object.assign(U.COST_SET, { answer: ANSWER(), drafts: {}, msg: {}, marks: {}, busy: {}, gen: 0 });
  global.state = { sub: 'settings' };
  global.$ = () => null; // nothing on screen: the flow only
  global.document = { querySelectorAll: () => [], querySelector: () => null, activeElement: null };
}

test('save: the settings are read again, the panel fields replace theirs, and success clears the draft', async () => {
  resetState();
  const elsewhere = { ...SAVED, currency: null }; // changed in another tab since the page loaded
  const calls = fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER({ settings: elsewhere }) },
    'POST /api/cost/settings': { status: 200, json: { settings: elsewhere } },
  });
  U.costSetEdit('billing', (d) => (d.billing.codex = { mode: 'plan', plan: 'Pro', feeUSD: '20', period: 'month' }));
  U.costSetEdit('rules', (d) => (d.centers[0].name = 'Acme Corp')); // another panel's draft: neither sent nor lost
  await U.costSetSave('billing');
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ['GET /api/cost/settings', 'POST /api/cost/settings'],
  );
  const body = calls[1].body;
  assert.equal(body.currency, null, 'the saved settings as read just before the POST');
  assert.equal(body.centers[0].name, 'Acme', 'the rules draft is not sent');
  assert.deepEqual(body.billing.codex, { mode: 'plan', plan: 'Pro', feeUSD: 20, period: 'month' });
  assert.equal(U.COST_SET.drafts.billing, undefined);
  assert.equal(U.COST_SET.drafts.rules.centers[0].name, 'Acme Corp');
  assert.equal(U.COST_SET.gen, 1);
  assert.equal(U.COST_SET.msg.billing.restate, true);
});

test('save: 400 marks the fields its reasons name; 409 shows budgets or CONFIG_BROKEN; a failure keeps the draft', async () => {
  resetState();
  let answer = { status: 400, json: { error: 'invalid cost settings', reasons: ['folderRules[0].center: unknown cost center'] } };
  fakeServer({ 'GET /api/cost/settings': { status: 200, json: ANSWER() }, 'POST /api/cost/settings': () => answer });
  U.costSetEdit('rules', (d) => (d.folderRules[0].center = 'gone'));
  await U.costSetSave('rules');
  assert.deepEqual(U.COST_SET.marks.rules, ['folderRules.0.center']);
  assert.deepEqual(U.COST_SET.msg.rules.reasons, ['folderRules[0].center: unknown cost center']);
  assert.ok(U.COST_SET.drafts.rules, 'the draft stays');
  answer = { status: 409, json: { error: 'budgets depend on these settings; edit or delete them first', reasons: ['budget team: x'] } };
  await U.costSetSave('rules');
  assert.equal(U.COST_SET.msg.rules.budgets, true);
  answer = { status: 409, json: { error: 'config.json could not be read; fix it first' } };
  await U.costSetSave('rules');
  assert.deepEqual([U.COST_SET.msg.rules.text, U.COST_SET.msg.rules.budgets], ['config.json could not be read; fix it first', false]);
  fakeServer({ 'GET /api/cost/settings': new Error('network down') });
  await U.costSetSave('rules');
  assert.equal(U.COST_SET.msg.rules.text, 'network down');
  assert.ok(U.COST_SET.drafts.rules);
  assert.equal(U.COST_SET.gen, 0);
});

test('save: nothing is sent while the settings do not read, then or when read again', async () => {
  resetState();
  U.COST_SET.answer = ANSWER({ error: 'config.json could not be read, so the ledger pass waits until it does' });
  const calls = fakeServer({});
  await U.costSetSave('rules');
  assert.deepEqual(calls, []);
  resetState();
  const again = fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER({ error: 'the cost settings in config.json are invalid', reasons: ['centers must be a list'] }) },
  });
  await U.costSetSave('currency');
  assert.deepEqual(again.map((c) => c.method), ['GET']);
  assert.equal(U.costSetLocked(U.COST_SET.answer), true);
  assert.deepEqual(U.COST_SET.msg.currency.reasons, ['centers must be a list']);
});

test('drafts outlive the page: leaving keeps them, and any unsaved one makes closing the tab ask', () => {
  resetState();
  assert.equal(U.costSetAnyDirty(), false);
  U.costSetEdit('currency', (d) => (d.currency.rates[0].perUSD = '16300'));
  U.costSetUnmount();
  assert.equal(U.COST_SET.drafts.currency.currency.rates[0].perUSD, '16300');
  assert.equal(U.costSetAnyDirty(), true);
  assert.match(U.costSetPageHtml(ST({ drafts: U.COST_SET.drafts })), /Unsaved changes <button[^>]*data-cost-set-act="discard" data-panel="currency"/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-settings-ui.test.js`
Expected: FAIL: `Error: Cannot find module '../public/costsettings'`.

- [ ] **Step 3: Wire the sub-page in `public/costview.js`**

In `COST_SUBS` (`:8-13`), after `['budgets', 'Budgets'],` add:

```js
  ['settings', 'Settings'],
```

In `viewCost`'s copy (`:465`), after the `budgets:` line add:

```js
    settings: 'Cost centers and their rules, billing per source, the display currency, and restating past days.',
```

In `costRefresh` (`:513`), after `if (!app) return;` add:

```js
  // Settings is all forms (public/costsettings.js): it reloads after each Save, never on the quiet cycle.
  if (costSub() === 'settings') return quiet ? undefined : costMountSettings();
```

At the top of the `module.exports` object (`:1331`), before `COST_DEFAULT,`, add:

```js
    COST_SUBS,
    COST_SOURCES,
    COST_MAX_DAYS,
    costToday,
    costGet,
    costPost,
    costSub,
    costReasonsHtml,
    costRibbonHtml,
    costErrorHtml,
    costShowError,
```

- [ ] **Step 4: The sidebar, the sub-tab and the script tag**

`public/iso.js`, in `SUBPAGES.cost` after `['budgets', 'Budgets'],` (`:593`):

```js
    ['settings', 'Settings'],
```

`public/index.html`, after the Budgets sub-entry (`:47`):

```html
        <a class="nav-sub" href="#cost/settings" data-route="cost/settings">Settings</a>
```

and after `<script src="costview.js"></script>` (`:143`):

```html
  <script src="costsettings.js"></script>
```

- [ ] **Step 5: Create `public/costsettings.js`**

```js
'use strict';
/* Cost Control → Settings (#cost/settings, sub-project 3b): cost centers with gateway keys and folder rules (with a
   server preview of what moves), billing per source, the display currency with dated rates, and a restate of a past
   range. Each of the first three panels saves on its own: it reads GET /api/cost/settings again and sends it with only
   its own fields replaced. Drafts live in memory for the life of the tab. Loaded after costview.js, whose helpers it
   uses inside functions only; pure helpers are exported for Node tests, and nothing here touches the DOM at load time.
   Every server or owner string reaches the markup through esc(). */

/* ---------- the frame: constants, drafts, request bodies ---------- */

const COST_SET_PANELS = [
  ['rules', 'Cost centers & rules'],
  ['billing', 'Billing'],
  ['currency', 'Display currency'],
  ['restate', 'Restate'],
];
const COST_SET_FORMS = ['rules', 'billing', 'currency']; // the panels with a draft and a Save
const COST_SET_LIMITS = { centers: 50, folderRules: 100, rates: 1000 }; // lib/cost/rules.js LIMITS
const COST_SET_PREVIEW_MS = 400;
const COST_SET_APPLIES = 'Saved. New costs follow these rules from today. To apply them to past days, use Restate.';
// What each panel registers as it is built (the sections below): its body markup, its buttons, its field hooks.
const COST_SET_BODIES = {}; // panel -> (st) => markup
const COST_SET_ACTIONS = {}; // data-cost-set-act -> (button) => void
const COST_SET_ON_INPUT = []; // (field, panel, path) => void, after an input event (panel null outside a draft)
const COST_SET_ON_CHANGE = []; // (field) => void, after a change event
const COST_SET_ON_OPEN = []; // (panel) => void, when a panel is opened
const COST_SET_ON_LOAD = []; // () => void, after each load of the settings, before the page is drawn

/** A panel's form values from the saved settings: what the panel shows while it has no draft. */
function costSetFromSaved(panel, settings, sources) {
  const s = settings || {};
  if (panel === 'rules')
    return {
      centers: (s.centers || []).map((c) => ({ id: c.id, name: c.name, isNew: false, idEdited: false })),
      keyCenters: { ...(s.keyCenters || {}) },
      folderRules: (s.folderRules || []).map((r) => ({ glob: r.glob, center: r.center })),
    };
  if (panel === 'billing')
    return {
      billing: Object.fromEntries(
        (sources || []).map((src) => {
          const b = (s.billing || {})[src];
          return [
            src,
            b && b.mode === 'plan'
              ? { mode: 'plan', plan: b.plan, feeUSD: String(b.feeUSD), period: b.period }
              : { mode: 'metered', plan: '', feeUSD: '', period: 'month' },
          ];
        }),
      ),
    };
  const c = s.currency;
  return {
    currency: c
      ? { on: 'on', code: c.code, rates: (c.rates || []).map((r) => ({ from: r.from, perUSD: String(r.perUSD) })) }
      : { on: 'off', code: '', rates: [] },
  };
}

// A number typed as text: an empty field is null, which the server refuses with its own reason (as it does NaN).
const costSetNum = (v) => {
  const t = String(v ?? '').trim();
  return t === '' ? null : Number(t);
};

/** The POST body of a panel's Save (R4): the saved settings with only that panel's fields replaced. */
function costSetBody(panel, saved, draft, sources) {
  const s = saved || {};
  const base = {
    centers: s.centers || [],
    keyCenters: s.keyCenters || {},
    folderRules: s.folderRules || [],
    billing: s.billing || {},
    currency: s.currency ?? null,
  };
  if (panel === 'rules')
    return {
      ...base,
      centers: draft.centers.map((c) => ({ id: String(c.id ?? '').trim(), name: String(c.name ?? '').trim() })),
      keyCenters: { ...draft.keyCenters },
      folderRules: draft.folderRules.map((r) => ({ glob: String(r.glob ?? '').trim(), center: r.center })),
    };
  if (panel === 'billing')
    return {
      ...base,
      billing: Object.fromEntries(
        (sources || Object.keys(draft.billing)).map((src) => {
          const b = draft.billing[src] || { mode: 'metered' };
          return [
            src,
            b.mode === 'plan'
              ? { mode: 'plan', plan: String(b.plan ?? '').trim(), feeUSD: costSetNum(b.feeUSD), period: b.period }
              : { mode: 'metered' },
          ];
        }),
      ),
    };
  const c = draft.currency;
  return {
    ...base,
    currency:
      c.on === 'on'
        ? {
            code: String(c.code ?? '')
              .trim()
              .toUpperCase(),
            rates: c.rates
              .map((r) => ({ from: r.from, perUSD: costSetNum(r.perUSD) }))
              .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
          }
        : null,
  };
}

/** Whether a panel's draft would change the saved settings. */
function costSetDirty(panel, saved, draft, sources) {
  if (!draft) return false;
  const was = costSetFromSaved(panel, saved, sources);
  return (
    JSON.stringify(costSetBody(panel, saved, draft, sources)) !== JSON.stringify(costSetBody(panel, saved, was, sources))
  );
}

/** Sets one form value in a draft by its field path ("centers.2.name", "keyCenters.key_a", "billing.claude.plan").
 *  An empty key mapping is removed: "Folder rules decide". */
function costSetAssign(draft, path, value) {
  const parts = String(path).split('.');
  if (parts.some((p) => ['__proto__', 'constructor', 'prototype'].includes(p))) return draft;
  if (parts[0] === 'keyCenters' && parts.length === 2) {
    if (value === '') delete draft.keyCenters[parts[1]];
    else draft.keyCenters[parts[1]] = value;
    return draft;
  }
  let at = draft;
  for (const p of parts.slice(0, -1)) {
    at = at[/^\d+$/.test(p) ? Number(p) : p];
    if (at == null || typeof at !== 'object') return draft;
  }
  at[parts[parts.length - 1]] = value;
  return draft;
}

/** The field paths a server reason names ("folderRules[2].center: …" → "folderRules.2.center"), for the error mark. */
function costSetReasonPaths(reasons) {
  return (Array.isArray(reasons) ? reasons : [])
    .map((r) => /^([A-Za-z][\w-]*(?:\[\d+\]|\.[\w-]+)*):/.exec(String(r)))
    .filter(Boolean)
    .map((m) => m[1].replace(/\[(\d+)\]/g, '.$1'));
}

/** Saves and the restate are off while the settings do not read: the values shown are the defaults standing in for
 *  the invalid ones, and a Save would write them over the owner's other sections. */
const costSetLocked = (answer) => !answer || !!answer.error;

/* ---------- the page state ---------- */

const COST_SET = {
  answer: null, // GET /api/cost/settings
  budgets: [], // GET /api/cost/budgets → budgets, for "Used by"
  drafts: {}, // panel -> its draft, kept for the life of the tab
  msg: {}, // panel -> { tone, text, reasons, restate, budgets } after a Save
  marks: {}, // panel -> the field paths a 400's reasons name
  busy: {}, // panel -> a Save in flight
  open: { rules: true, billing: true, currency: true, restate: false },
  gen: 0, // +1 after each Save that went through: a restate preview made before it is stale
  preview: null, // the settings preview: { key, sent, answer } | { key, sent, reasons } | { key, error }
  previewReq: 0,
  previewTimer: null,
  testPath: '',
  restate: { from: null, to: null, reason: '', ack: false, preview: null, of: null, error: null, done: null, running: false },
  restateReq: 0,
  history: null, // GET /api/cost/restates → restates
  historyError: null,
  historyReq: 0,
  mounted: false,
  hooked: false,
};

const COST_SET_EMPTY = Object.freeze({ centers: [], keyCenters: {}, folderRules: [], billing: {}, currency: null });
const costSetSaved = () => (COST_SET.answer && COST_SET.answer.settings) || COST_SET_EMPTY;
const costSetSources = () => (COST_SET.answer && COST_SET.answer.sources) || Object.keys(COST_SOURCES);
/** A panel's draft, or its saved values while it has none (a draft is stored only once the owner edits). */
const costSetDraftOf = (panel) => COST_SET.drafts[panel] || costSetFromSaved(panel, costSetSaved(), costSetSources());
const costSetAnyDirty = () =>
  !!COST_SET.answer && COST_SET_FORMS.some((p) => costSetDirty(p, costSetSaved(), COST_SET.drafts[p], costSetSources()));
// The draft of a panel, made from the saved values on its first edit, changed by `fn`.
function costSetEdit(panel, fn) {
  if (!COST_SET.drafts[panel]) COST_SET.drafts[panel] = costSetFromSaved(panel, costSetSaved(), costSetSources());
  fn(COST_SET.drafts[panel]);
  return COST_SET.drafts[panel];
}

/* ---------- the frame's markup ---------- */

// A form field bound to a draft path, with the error mark when a reason names it.
function costSetField(panel, path, st) {
  const bad = ((st.marks && st.marks[panel]) || []).includes(path);
  return `data-cost-set-field="${esc(panel + ':' + path)}"${bad ? ' aria-invalid="true"' : ''}`;
}
function costSetDirtyHtml(panel, st) {
  const a = st.answer || {};
  return costSetDirty(panel, a.settings, st.drafts[panel], a.sources)
    ? `<p class="cost-set-dirty" role="status">Unsaved changes <button type="button" class="btn ghost" data-cost-set-act="discard" data-panel="${esc(panel)}">Discard</button></p>`
    : '';
}
function costSetMsgHtml(m) {
  if (!m) return '';
  const reasons = Array.isArray(m.reasons) && m.reasons.length ? costReasonsHtml(m.reasons) : '';
  const restate = m.restate
    ? '<button type="button" class="link-btn" data-cost-set-act="open-restate">Open Restate</button>'
    : '';
  const budgets = m.budgets ? '<a class="link-btn" href="#cost/budgets">Open Budgets</a>' : '';
  return `<p class="cost-note${m.tone === 'ok' ? '' : ' warn'}">${esc(m.text)}</p>${reasons}${restate}${budgets}`;
}
function costSetSaveHtml(panel, st) {
  const locked = costSetLocked(st.answer);
  return `<div class="cost-set-save"><button type="button" class="btn" data-cost-set-act="save" data-panel="${esc(panel)}" ${locked || (st.busy && st.busy[panel]) ? 'disabled' : ''}>Save</button>${locked ? '<span class="cost-note">Fix config.json first</span>' : ''}<div data-cost-set-msg="${esc(panel)}" role="status">${costSetMsgHtml(st.msg && st.msg[panel])}</div></div>`;
}
/** The banner while GET /api/cost/settings reports `error`: the error, its reasons, and why Saves are off. */
function costSetBannerHtml(answer) {
  if (!answer || !answer.error) return '';
  const reasons = (answer.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('');
  return `<div class="cost-banner warn" role="status"><b>${esc(answer.error)}</b>${reasons ? `<ul>${reasons}</ul>` : ''}<p>Saving and restating are off until config.json is fixed: the values shown are the defaults that stand in for the invalid ones. The previews still work on your drafts.</p></div>`;
}
// What a panel holds under its title: the unsaved-changes line, its own body, and the Save of a form panel.
function costSetPanelInner(panel, st) {
  const body = COST_SET_BODIES[panel] ? COST_SET_BODIES[panel](st) : '';
  if (!COST_SET_FORMS.includes(panel)) return body;
  return `<div data-cost-set-dirty="${esc(panel)}">${costSetDirtyHtml(panel, st)}</div>${body}${costSetSaveHtml(panel, st)}`;
}
function costSetPanelHtml(panel, title, st) {
  return `<details class="holo panel cost-set-panel" data-cost-set-panel="${esc(panel)}" ${st.open[panel] ? 'open' : ''}><summary><h3>${esc(title)}</h3></summary><div class="cost-set-body" data-cost-set-body="${esc(panel)}">${costSetPanelInner(panel, st)}</div></details>`;
}
/** The whole page from the state: the banner, then the four panels. */
function costSetPageHtml(st) {
  return costSetBannerHtml(st.answer) + COST_SET_PANELS.map(([p, title]) => costSetPanelHtml(p, title, st)).join('');
}

/* ---------- painting, keeping the keyboard where it was ---------- */

const COST_SET_FOCUS_ATTRS = [
  'data-cost-set-field',
  'data-cost-set-act',
  'data-cost-set-test',
  'data-cost-set-restate',
  'data-panel',
  'data-i',
  'data-src',
  'data-mode',
  'data-on',
];
// The focused control as attribute pairs (no selector is built from owner text), to find it again after a repaint.
function costSetFocusKey(el, root) {
  if (!el || !root || el === root || !root.contains(el) || !el.getAttribute) return null;
  const key = COST_SET_FOCUS_ATTRS.filter((a) => el.hasAttribute(a)).map((a) => [a, el.getAttribute(a)]);
  return key.length ? key : null;
}
function costSetRefocus(root, key) {
  if (!key) return;
  const el = [...root.querySelectorAll('input, select, button, textarea')].find(
    (x) => !x.disabled && key.every(([a, v]) => x.getAttribute(a) === v),
  );
  if (el) el.focus({ preventScroll: true });
}
function costSetPaint(focus) {
  const body = $('#cost-body');
  if (!body || costSub() !== 'settings' || !COST_SET.answer) return;
  const key = focus || costSetFocusKey(document.activeElement, body);
  body.innerHTML = costSetPageHtml(COST_SET);
  costSetRefocus(body, key);
}
// One panel's body, e.g. after a row was added; `focus` names the control to take the keyboard.
function costSetPaintPanel(panel, focus) {
  const host = [...document.querySelectorAll('#cost-app [data-cost-set-body]')].find(
    (el) => el.dataset.costSetBody === panel,
  );
  if (!host || !COST_SET.answer) return;
  const key = focus || costSetFocusKey(document.activeElement, host);
  host.innerHTML = costSetPanelInner(panel, COST_SET);
  costSetRefocus(host, key);
}
// After a change event the keyboard has moved on: repaint once it has landed.
const costSetPaintSoon = (panel) => setTimeout(() => costSetPaintPanel(panel), 0);
function costSetPaintDirty(panel) {
  const el = [...document.querySelectorAll('#cost-app [data-cost-set-dirty]')].find(
    (x) => x.dataset.costSetDirty === panel,
  );
  if (el) el.innerHTML = costSetDirtyHtml(panel, COST_SET);
}

/* ---------- load, save, discard ---------- */

async function costSetLoad(quiet) {
  const body = $('#cost-body');
  if (!body || costSub() !== 'settings') return;
  const my = ++COST.req;
  const live = () => my === COST.req && body.isConnected && costSub() === 'settings';
  try {
    const [answer, budgets, status] = await Promise.all([
      costGet('/api/cost/settings'),
      costGet('/api/cost/budgets').catch(() => null),
      costGet('/api/cost/status').catch(() => null),
    ]);
    if (!live()) return;
    COST.settings = answer; // the other cost pages read the same answer
    COST_SET.answer = answer;
    COST_SET.budgets = (budgets && budgets.budgets) || [];
    // No range, currency or measure here: the bar stays empty, the ribbon is the other pages' one.
    $('#cost-bar').innerHTML = '';
    $('#cost-ribbon').innerHTML = costRibbonHtml(status);
    for (const h of COST_SET_ON_LOAD) h();
    costSetPaint();
    const view = $('#view');
    if (!quiet && view && view.classList.contains('animate') && typeof settle === 'function') settle(view);
  } catch (e) {
    if (!live()) return;
    costShowError(body, e.message, false);
  }
}

// A Save: the saved settings are read again first, so a change made elsewhere since the page loaded is kept.
async function costSetSave(panel) {
  if (COST_SET.busy[panel] || costSetLocked(COST_SET.answer)) return;
  const draft = costSetDraftOf(panel);
  COST_SET.busy[panel] = true;
  costSetPaintPanel(panel);
  let saved = false;
  try {
    const fresh = await costGet('/api/cost/settings');
    if (fresh.error) {
      COST_SET.answer = fresh;
      COST.settings = fresh;
      COST_SET.msg[panel] = { tone: 'warn', text: fresh.error, reasons: fresh.reasons || [] };
      return;
    }
    const res = await costPost('/api/cost/settings', costSetBody(panel, fresh.settings, draft, fresh.sources));
    const j = res.json || {};
    if (res.status === 200) {
      saved = true;
      if (COST_SET.drafts[panel] === draft) delete COST_SET.drafts[panel];
      COST_SET.marks[panel] = [];
      COST_SET.gen++;
      COST_SET.msg[panel] =
        panel === 'currency' ? { tone: 'ok', text: 'Saved.' } : { tone: 'ok', text: COST_SET_APPLIES, restate: true };
      return;
    }
    COST_SET.marks[panel] = res.status === 400 ? costSetReasonPaths(j.reasons) : [];
    const reasons = Array.isArray(j.reasons) ? j.reasons : [];
    // 409 with reasons: budgets depend on the change. 409 without: config.json does not parse (CONFIG_BROKEN).
    COST_SET.msg[panel] = {
      tone: 'warn',
      text: j.error || `Could not save (${res.status})`,
      reasons,
      budgets: res.status === 409 && reasons.length > 0,
    };
  } catch (e) {
    COST_SET.msg[panel] = { tone: 'warn', text: e.message }; // the draft stays
  } finally {
    COST_SET.busy[panel] = false;
    if (saved) await costSetLoad(true);
    else costSetPaint();
  }
}

/* ---------- mount, unmount, events ---------- */

function costMountSettings() {
  costSetInstallEvents();
  if (!COST_SET.mounted) {
    COST_SET.mounted = true;
    onUnmount(costSetUnmount);
  }
  return costSetLoad(false);
}
// Leaving the page: answers in flight are dropped; the drafts stay for the next visit.
function costSetUnmount() {
  COST_SET.mounted = false;
  clearTimeout(COST_SET.previewTimer);
  COST_SET.previewTimer = null;
  COST_SET.previewReq++;
  COST_SET.restateReq++;
  COST_SET.historyReq++;
  COST_SET.restate.running = false;
  for (const p of COST_SET_FORMS) COST_SET.busy[p] = false;
}

Object.assign(COST_SET_ACTIONS, {
  save: (b) => void costSetSave(b.dataset.panel),
  discard: (b) => {
    const p = b.dataset.panel;
    delete COST_SET.drafts[p];
    COST_SET.marks[p] = [];
    COST_SET.msg[p] = null;
    costSetPaintPanel(p, [['data-cost-set-act', 'save'], ['data-panel', p]]);
    for (const h of COST_SET_ON_INPUT) h(b, p, null);
  },
});

function costSetInstallEvents() {
  if (COST_SET.hooked) return;
  COST_SET.hooked = true;
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('#cost-app [data-cost-set-act]');
    if (!t || t.disabled) return;
    const fn = COST_SET_ACTIONS[t.dataset.costSetAct];
    if (fn) fn(t);
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('#cost-app')) return;
    const f = t.dataset.costSetField;
    if (!f) {
      for (const h of COST_SET_ON_INPUT) h(t, null, null);
      return;
    }
    const at = f.indexOf(':');
    const panel = f.slice(0, at);
    const path = f.slice(at + 1);
    costSetEdit(panel, (d) => costSetAssign(d, path, t.value));
    for (const h of COST_SET_ON_INPUT) h(t, panel, path);
    costSetPaintDirty(panel);
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('#cost-app')) return;
    // A select or a center name feeds other rows (Used by, the center choices): their panel is drawn again.
    if (t.hasAttribute('data-cost-set-repaint')) costSetPaintSoon(t.dataset.costSetField.split(':')[0]);
    for (const h of COST_SET_ON_CHANGE) h(t);
  });
  // A panel opened or closed (toggle does not bubble: caught on the way down).
  document.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!d.matches || !d.matches('#cost-app [data-cost-set-panel]')) return;
      COST_SET.open[d.dataset.costSetPanel] = d.open;
      if (d.open) for (const h of COST_SET_ON_OPEN) h(d.dataset.costSetPanel);
    },
    true,
  );
  // Drafts live as long as the tab: closing or reloading it with unsaved changes asks first.
  window.addEventListener('beforeunload', (e) => {
    if (!costSetAnyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    COST_SET,
    COST_SET_PANELS,
    COST_SET_BODIES,
    COST_SET_ACTIONS,
    costSetFromSaved,
    costSetBody,
    costSetDirty,
    costSetAssign,
    costSetReasonPaths,
    costSetLocked,
    costSetMsgHtml,
    costSetSaveHtml,
    costSetBannerHtml,
    costSetPageHtml,
    costSetAnyDirty,
    costSetEdit,
    costSetDraftOf,
    costSetSave,
    costSetLoad,
    costSetUnmount,
    costMountSettings,
  };
```

- [ ] **Step 6: Styles**

Append to `public/styles.css`:

```css
/* Cost Control → Settings (public/costsettings.js): four panels, the rules panel with its preview beside the forms. */
.cost-set-panel {
  margin-bottom: 14px;
}
.cost-set-panel > summary {
  cursor: pointer;
  list-style: none;
}
.cost-set-panel > summary::-webkit-details-marker {
  display: none;
}
.cost-set-panel > summary h3 {
  display: inline;
  margin: 0;
}
.cost-set-panel > summary::before {
  content: '▸ ';
  color: var(--h-muted);
}
.cost-set-panel[open] > summary::before {
  content: '▾ ';
}
.cost-set-body {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}
.cost-set-body h4 {
  margin: 8px 0 0;
  font-size: 13px;
}
.cost-set-grid {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(260px, 2fr);
  gap: 18px;
  align-items: start;
}
@media (max-width: 900px) {
  .cost-set-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.cost-set-forms,
.cost-set-preview {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.cost-set-preview {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.cost-set-preview[aria-busy='true'] {
  opacity: 0.7;
}
.cost-set-table .input {
  width: 100%;
}
.cost-set-rules {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.cost-set-rule {
  display: grid;
  grid-template-columns: auto minmax(0, 2fr) minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
}
.cost-set-rule .cost-set-warn {
  grid-column: 2 / -1;
  color: var(--warn-ink);
  font-size: 12px;
}
.cost-set-num {
  color: var(--h-muted);
  font-size: 12px;
}
.cost-set-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cost-set-save {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.cost-set-save > div {
  flex-basis: 100%;
}
.cost-set-dirty {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  color: var(--warn-ink);
  font-size: 12.5px;
}
.cost-set-source {
  display: grid;
  gap: 8px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.cost-set-source:last-of-type {
  border-bottom: 0;
}
.cost-set-source-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.cost-set-body label {
  display: grid;
  gap: 4px;
  font-size: 12.5px;
  color: var(--h-muted);
}
.cost-set-body .cost-check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--h-text);
}
.cost-set-unassigned {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.cost-set-unassigned li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  font-size: 12.5px;
}
.cost-set-unassigned li span:first-child,
.cost-set-moves td:first-child {
  overflow-wrap: anywhere;
}
.cost-set-test code,
.cost-set-today {
  color: var(--h-cyan);
}
.cost-set-summary {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
}
.cost-set-confirm {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--warn-border);
  border-radius: 12px;
}
.cost-set-body [aria-invalid='true'] {
  border-color: var(--warn-ink);
  box-shadow: 0 0 0 1px var(--warn-ink);
}
```

- [ ] **Step 7: Run the tests and see them pass**

Run: `node --test test/cost-settings-ui.test.js test/cost-ui.test.js test/cost-budgets-ui.test.js`
Expected: PASS (10 new tests; `test/cost-ui.test.js`'s "one global scope" test now also reads `costsettings.js`).

- [ ] **Step 8: Commit**

```bash
git add public/costsettings.js public/costview.js public/iso.js public/index.html public/styles.css test/cost-settings-ui.test.js
git commit -m "Cost Control Settings: the page frame, drafts, panel saves and the locked state"
```

---
### Task 6: Panel "Cost centers & rules" with the preview, Create rule and Test a path

**Files:**
- Modify: `public/costsettings.js` (a section before the `module.exports` line; names added to the exports)
- Test: `test/cost-settings-ui.test.js` (append)

**Interfaces:**
- Consumes: Task 5's registries, `COST_SET`, `costSetEdit`, `costSetDraftOf`, `costSetField`, `costSetBody`,
  `costSetFromSaved`, `costSetPaintPanel`; `costPost`, `costMoney`, `costReasonsHtml`, `costUnreadText`,
  `reduceMotion` (app.js); Task 4's `POST /api/cost/settings/preview` answer (`moves`, `more`, `rules`, `unassigned`,
  `test`, `unread`).
- Produces:
  - Pure: `costSetCenterId(name, taken)` (R5), `costSetCenterUse(draft, keys, budgets) → { [center]: { keys, rules,
    budgets } }`, `costSetDeleteBlock(use) → '' | 'In use: …'`, `costSetUsedBy(use)`, `costSetRuleGlob(project)`,
    `costSetCenterName(id, centers)`, `costSetPreviewCurrent(st)`, `costSetWarnText(st, i)`, `costSetRulesHtml(st)`,
    `costSetPreviewHtml(st)`, `costSetTestHtml(st)`.
  - Page: `costSetSchedulePreview(ms = 400)`, `costSetRunPreview()`, `costSetPaintPreview()`,
    `costSetRulesEdit(fn, focus)`, `costSetRulesInput(field, panel, path)`; actions `add-center`, `del-center`,
    `remove-key`, `add-rule`, `rule-up`, `rule-down`, `del-rule`, `create-rule`, `retry-preview`;
    `COST_SET_BODIES.rules`; a preview on every load.
  - Markup hooks: `[data-cost-set-preview-body]`, `[data-cost-set-test]`, `[data-cost-set-test-out]`,
    `[data-cost-set-warn="<i>"]`.
- Behaviour:
  - Centers table (Name, Id, Used by, Delete); a saved id is read-only; a new row's id follows its name until typed,
    and the keys and rules that chose it follow it. Delete is disabled while a key or rule uses the center (tooltip
    names them); Add is disabled at 50.
  - One row per gateway key with "Folder rules decide" and each center; mappings of keys that are gone are listed as
    "Key no longer exists" with Remove.
  - Rules: glob, center, Up/Down/Delete (keyboard reachable), Add (disabled at 100 or with no center), the order and
    glob help lines; the warnings "Matches nothing in the last 30 days" / "Never used: rule #k above takes every path
    it matches" beside their rule, only while the answer is for the rules on screen.
  - The preview column is sent ~400 ms after the last edit (`settings` = the saved settings with the rules draft,
    plus `testPath`); a newer request supersedes an older one; leaving the page drops the answer in flight. It shows
    Moves (with "No project or key changes center." and "and N more"), Unassigned (with **Create rule**: `<project>/**`
    appended, focus on its center select, scrolled into view), the draft's reasons on a 400 (Save stays enabled), or
    the error with **Retry**. Test a path: "Acme · rule #3 `~/Github/acme/**`" or "Unassigned, no rule matches".

- [ ] **Step 1: Write the failing test**

Append to `test/cost-settings-ui.test.js`:

```js
/* ---------- Task 6: cost centers & rules, the preview ---------- */

const R = require('../lib/cost/rules');

test('center id from a name: lower-case, suffixed when taken, never unassigned or a reserved name, always valid', () => {
  assert.equal(U.costSetCenterId('Client: Acme'), 'client-acme');
  assert.equal(U.costSetCenterId('Ácme Ünïon'), 'acme-union');
  assert.equal(U.costSetCenterId('Acme', ['acme']), 'acme-2');
  assert.equal(U.costSetCenterId('Acme', ['acme', 'acme-2']), 'acme-3');
  assert.equal(U.costSetCenterId('Unassigned'), 'unassigned-2');
  assert.equal(U.costSetCenterId('Constructor'), 'constructor-2');
  assert.equal(U.costSetCenterId('  ***  '), 'center');
  const long = 'x'.repeat(45);
  assert.equal(U.costSetCenterId(long).length, 40);
  assert.equal(U.costSetCenterId(long, [U.costSetCenterId(long)]), 'x'.repeat(38) + '-2');
  for (const name of ['Client: Acme', 'Unassigned', '', long, '__proto__', 'a'.repeat(80)]) {
    const id = U.costSetCenterId(name, ['a'.repeat(40)]);
    assert.ok(R.validate({ centers: [{ id, name: 'N' }] }).ok, `${name} → ${id}`);
  }
});

test('Used by and Delete: a key or a rule blocks the delete and is named; budgets alone do not block it', () => {
  const d = U.costSetFromSaved('rules', SAVED, SOURCES);
  const budgets = [{ id: 'team', name: 'Team', scope: { dim: 'center', value: 'acme' } }, { id: 'g', name: 'All', scope: 'global' }];
  const use = U.costSetCenterUse(d, ANSWER().keys, budgets);
  assert.deepEqual(use.lab, { keys: ['ci-bot'], rules: [], budgets: [] });
  assert.deepEqual(use.acme, { keys: [], rules: [1], budgets: ['Team'] });
  assert.equal(U.costSetDeleteBlock(use.lab), 'In use: key ci-bot');
  assert.equal(U.costSetUsedBy(use.acme), 'Rule #1, Budget Team');
  assert.equal(U.costSetUsedBy(undefined), '—');
  const html = U.costSetRulesHtml(ST({ budgets }));
  assert.match(html, /data-cost-set-act="del-center" data-i="0" disabled title="In use: rule #1"/);
  assert.match(html, /data-cost-set-act="del-center" data-i="1" disabled title="In use: key ci-bot"/);
  d.folderRules = [];
  d.keyCenters = {};
  const free = U.costSetRulesHtml(ST({ budgets, drafts: { rules: d } }));
  assert.match(free, /data-cost-set-act="del-center" data-i="0"  title="Budgets use it: the Save is refused until they change"/);
  assert.match(free, /data-cost-set-act="del-center" data-i="1"  title=""/);
});

test('rules panel: saved ids read-only, new ids editable, key choices, a gone key, rule order buttons, limits', () => {
  const d = U.costSetFromSaved('rules', SAVED, SOURCES);
  d.centers.push({ id: 'ops', name: 'Ops', isNew: true, idEdited: false, prevId: 'ops' });
  d.keyCenters.key_gone = 'ops';
  d.folderRules.push({ glob: '~/ops/**', center: 'ops' });
  const html = U.costSetRulesHtml(ST({ drafts: { rules: d } }));
  assert.match(html, /<td><code>acme<\/code><\/td>/);
  assert.match(html, /data-cost-set-field="rules:centers\.2\.id" data-cost-set-repaint maxlength="40" value="ops"/);
  assert.match(html, /<option value="" >Folder rules decide<\/option><option value="acme" >Acme<\/option><option value="lab" selected>Lab<\/option>/);
  assert.match(html, /Key no longer exists[\s\S]*<code>key_gone<\/code><span>→ Ops<\/span><button[^>]*data-cost-set-act="remove-key" data-i="0"/);
  assert.match(html, /data-cost-set-act="rule-up" data-i="0" disabled/);
  assert.match(html, /data-cost-set-act="rule-down" data-i="1" disabled/);
  assert.match(html, /A key's center always wins over folder rules\./);
  assert.match(html, /The first matching rule wins; a path no rule matches is Unassigned\./);
  const many = { ...d, centers: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, name: `C${i}` })) };
  assert.match(U.costSetRulesHtml(ST({ drafts: { rules: many } })), /data-cost-set-act="add-center" disabled title="At most 50 cost centers"/);
  const none = { centers: [], keyCenters: {}, folderRules: [] };
  assert.match(U.costSetRulesHtml(ST({ drafts: { rules: none } })), /data-cost-set-act="add-rule" disabled title="Add a cost center first"/);
  const marked = U.costSetRulesHtml(ST({ drafts: { rules: d }, marks: { rules: ['folderRules.1.center'] } }));
  assert.match(marked, /data-cost-set-field="rules:folderRules\.1\.center" aria-invalid="true"/);
});

test('Create rule: the glob of the folder and everything below it, appended with the focus on its center', () => {
  assert.equal(U.costSetRuleGlob('~/work/acme'), '~/work/acme/**');
  assert.equal(U.costSetRuleGlob('~/work/acme/'), '~/work/acme/**');
  assert.ok(R.globToRegExp(U.costSetRuleGlob('~/work/acme')).test('~/work/acme'));
  resetState();
  U.COST_SET.preview = { sent: SAVED, answer: { moves: [], more: 0, rules: [], unassigned: [{ project: '~/play', listUSD: 2 }], test: null } };
  global.reduceMotion = { matches: true };
  U.COST_SET_ACTIONS['create-rule']({ dataset: { i: '0' } });
  assert.deepEqual(U.COST_SET.drafts.rules.folderRules[1], { glob: '~/play/**', center: '' });
  clearTimeout(U.COST_SET.previewTimer);
});

test('a new center: its id follows its name until typed, and the keys and rules that chose it follow the id', () => {
  resetState();
  U.COST_SET_ACTIONS['add-center']();
  const d = U.COST_SET.drafts.rules;
  const field = { hasAttribute: () => false };
  d.centers[2].name = 'Ops Team';
  U.costSetRulesInput(field, 'rules', 'centers.2.name');
  assert.equal(d.centers[2].id, 'ops-team');
  d.folderRules.push({ glob: '~/ops/**', center: 'ops-team' });
  d.keyCenters.key_web = 'ops-team';
  d.centers[2].name = 'Ops';
  U.costSetRulesInput(field, 'rules', 'centers.2.name');
  assert.deepEqual([d.centers[2].id, d.folderRules[1].center, d.keyCenters.key_web], ['ops', 'ops', 'ops']);
  d.centers[2].id = 'operations';
  U.costSetRulesInput(field, 'rules', 'centers.2.id');
  d.centers[2].name = 'Something else';
  U.costSetRulesInput(field, 'rules', 'centers.2.name');
  assert.deepEqual([d.centers[2].id, d.folderRules[1].center], ['operations', 'operations'], 'a typed id stays');
  U.costSetRulesInput(field, 'rules', 'centers.0.name');
  assert.equal(d.centers[0].id, 'acme', 'a saved id never changes');
  clearTimeout(U.COST_SET.previewTimer);
});

const ANSWERED = (over = {}) => ({
  sent: SAVED,
  answer: {
    from: '2026-09-29',
    to: '2026-10-28',
    unread: [],
    moves: [
      { project: EVIL, keyId: null, keyName: null, listUSD: 12, from: 'unassigned', to: 'acme' },
      { project: null, keyId: 'key_ci', keyName: 'ci-bot', listUSD: 3, from: 'lab', to: 'gone' },
    ],
    more: 4,
    rules: [{ index: 0, status: 'shadowed', by: 0 }],
    unassigned: [{ project: '~/play', listUSD: 2 }],
    test: { center: 'acme', rule: 0 },
    ...over,
  },
});

test('preview: moves with names, "and N more", Unassigned with Create rule, the test path, all escaped', () => {
  const html = U.costSetPreviewHtml(ST({ preview: ANSWERED() }));
  assert.match(html, /<td>&lt;img src=x onerror=alert\(1\)&gt;<\/td><td class="num">\$12\.00<\/td><td>Unassigned → Acme<\/td>/);
  assert.match(html, /<td>Key: ci-bot<\/td><td class="num">\$3\.00<\/td><td>Lab → gone<\/td>/);
  assert.match(html, /and 4 more/);
  assert.match(html, /<span>~\/play<\/span><span class="num">\$2\.00<\/span><button[^>]*data-cost-set-act="create-rule" data-i="0"/);
  assert.doesNotMatch(html, /<img/);
  assert.match(U.costSetPreviewHtml(ST({ preview: ANSWERED({ moves: [], more: 0 }) })), /No project or key changes center\./);
  const bad = U.costSetPreviewHtml(ST({ preview: { sent: SAVED, reasons: [EVIL] } }));
  assert.match(bad, /does not validate[\s\S]*<li>&lt;img/);
  const failed = U.costSetPreviewHtml(ST({ preview: { error: 'a ledger month could not be read' } }));
  assert.match(failed, /a ledger month could not be read<\/p><button[^>]*data-cost-set-act="retry-preview">Retry/);
  assert.equal(U.costSetTestHtml(ST({ preview: ANSWERED(), testPath: '' })), '');
  assert.equal(
    U.costSetTestHtml(ST({ preview: ANSWERED(), testPath: '~/work/acme/web' })),
    '<p>Acme · rule #1 <code>~/work/acme/**</code></p>',
  );
  assert.equal(
    U.costSetTestHtml(ST({ preview: ANSWERED({ test: { center: 'unassigned', rule: null } }), testPath: '~/x' })),
    '<p>Unassigned, no rule matches</p>',
  );
});

test('rule warnings: none and shadowed beside their rule, only for the draft the preview was asked for', () => {
  const none = ST({ preview: ANSWERED({ rules: [{ index: 0, status: 'none', by: null }] }) });
  assert.equal(U.costSetWarnText(none, 0), 'Matches nothing in the last 30 days');
  const two = { ...SAVED, folderRules: [...SAVED.folderRules, { glob: '~/work/acme/web/**', center: 'lab' }] };
  const sh = ST({
    answer: ANSWER({ settings: two }),
    preview: { sent: two, answer: { ...ANSWERED().answer, rules: [{ index: 0, status: 'ok', by: null }, { index: 1, status: 'shadowed', by: 0 }] } },
  });
  assert.equal(U.costSetWarnText(sh, 1), 'Never used: rule #1 above takes every path it matches');
  assert.equal(U.costSetWarnText(sh, 0), '');
  const edited = U.costSetFromSaved('rules', two, SOURCES);
  edited.folderRules[1].glob = '~/elsewhere/**';
  assert.equal(U.costSetWarnText({ ...sh, drafts: { rules: edited } }, 1), '', 'an answer for an older draft says nothing');
});

test('preview requests: the draft and test path are sent; an older answer never replaces a newer one', async () => {
  resetState();
  const pending = [];
  global.fetch = (url, opts) =>
    new Promise((res) => pending.push({ url, body: JSON.parse(opts.body), res: (json) => res({ status: 200, json: async () => json }) }));
  U.costSetEdit('rules', (d) => d.folderRules.push({ glob: ' ~/x/** ', center: 'lab' }));
  U.COST_SET.testPath = ' ~/x/y ';
  const first = U.costSetRunPreview();
  const second = U.costSetRunPreview();
  assert.equal(pending[0].url, '/api/cost/settings/preview');
  assert.deepEqual(pending[0].body.settings.folderRules[1], { glob: '~/x/**', center: 'lab' });
  assert.equal(pending[0].body.testPath, '~/x/y');
  pending[1].res({ moves: [], more: 0, rules: [], unassigned: [], test: null, tag: 'newer' });
  await second;
  pending[0].res({ moves: [], more: 0, rules: [], unassigned: [], test: null, tag: 'older' });
  await first;
  assert.equal(U.COST_SET.preview.answer.tag, 'newer');
  const third = U.costSetRunPreview();
  U.costSetUnmount(); // leaving the page drops the answer in flight
  pending[2].res({ tag: 'gone' });
  await third;
  assert.equal(U.COST_SET.preview.answer.tag, 'newer');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-settings-ui.test.js`
Expected: FAIL, the 8 new tests: `TypeError: U.costSetCenterId is not a function` (and the like for the other names).

- [ ] **Step 3: Add the panel to `public/costsettings.js`**

Insert this section just before the line `if (typeof module !== 'undefined')`:

```js
/* ---------- panel: cost centers & rules, with the server preview ---------- */

const COST_SET_RESERVED_IDS = ['unassigned', '__proto__', 'constructor', 'prototype'];

/** A new center's id from its name (R5): lowercase a-z0-9 and dashes, at most 40, with -2, -3, … when taken. */
function costSetCenterId(name, taken = []) {
  const base =
    String(name || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'center';
  const used = new Set([...taken, ...COST_SET_RESERVED_IDS]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const tail = `-${n}`;
    const id = base.slice(0, 40 - tail.length).replace(/-+$/, '') + tail;
    if (!used.has(id)) return id;
  }
}
/** What points at each center: gateway keys (by name), folder rules (#k) and budgets (by name). */
function costSetCenterUse(draft, keys, budgets) {
  const out = {};
  const at = (id) => (out[id] = out[id] || { keys: [], rules: [], budgets: [] });
  const names = new Map((keys || []).map((k) => [k.id, k.name || k.id]));
  for (const [key, center] of Object.entries(draft.keyCenters || {})) at(center).keys.push(names.get(key) || key);
  (draft.folderRules || []).forEach((r, i) => {
    if (r.center) at(r.center).rules.push(i + 1);
  });
  for (const b of budgets || [])
    if (b && b.scope && b.scope.dim === 'center') at(String(b.scope.value)).budgets.push(b.name || b.id);
  return out;
}
/** Why a center cannot be deleted ("In use: key ci-bot, rule #2"), or '' when it can. Budgets do not block the form:
 *  the server refuses that Save (409) and names them. */
function costSetDeleteBlock(use) {
  if (!use || (!use.keys.length && !use.rules.length)) return '';
  return 'In use: ' + [...use.keys.map((k) => 'key ' + k), ...use.rules.map((k) => 'rule #' + k)].join(', ');
}
/** "Key ci-bot, Rule #2, Budget Team", or "—". */
function costSetUsedBy(use) {
  if (!use) return '—';
  const all = [
    ...use.keys.map((k) => 'Key ' + k),
    ...use.rules.map((k) => 'Rule #' + k),
    ...use.budgets.map((b) => 'Budget ' + b),
  ];
  return all.length ? all.join(', ') : '—';
}
/** The rule "Create rule" adds for an Unassigned project: the folder itself and everything below it. */
const costSetRuleGlob = (project) => `${String(project).replace(/\/+$/, '')}/**`;
/** A center as people read it: its name, Unassigned, or its id when the settings no longer name it. */
function costSetCenterName(id, centers) {
  if (id == null || id === 'unassigned') return 'Unassigned';
  const c = (centers || []).find((x) => x.id === id);
  return c ? c.name || c.id : String(id);
}
// The settings preview's answer is for the draft on screen when it was asked with the rules sent now.
function costSetPreviewCurrent(st) {
  const p = st.preview;
  if (!p || !p.sent || !st.answer) return false;
  const now = costSetBody('rules', st.answer.settings, st.drafts.rules || costSetFromSaved('rules', st.answer.settings, st.answer.sources), st.answer.sources);
  return JSON.stringify(now.folderRules) === JSON.stringify(p.sent.folderRules);
}
/** The warning beside rule i: "Matches nothing in the last 30 days" or "Never used: rule #k above takes every path it
 *  matches", from a preview of the draft on screen. */
function costSetWarnText(st, i) {
  const a = st.preview && st.preview.answer;
  const r = a && costSetPreviewCurrent(st) && a.rules.find((x) => x.index === i);
  if (!r) return '';
  if (r.status === 'none') return 'Matches nothing in the last 30 days';
  if (r.status === 'shadowed') return `Never used: rule #${r.by + 1} above takes every path it matches`;
  return '';
}

function costSetRulesHtml(st) {
  const a = st.answer || {};
  const d = st.drafts.rules || costSetFromSaved('rules', a.settings, a.sources);
  const keys = a.keys || [];
  const use = costSetCenterUse(d, keys, st.budgets);
  const f = (path) => costSetField('rules', path, st);
  const opt = (v, text, on) => `<option value="${esc(v)}" ${v === on ? 'selected' : ''}>${esc(text)}</option>`;
  const centerOpts = (on) => d.centers.filter((c) => c.id).map((c) => opt(c.id, c.name || c.id, on)).join('');
  const centers = d.centers
    .map((c, i) => {
      const block = costSetDeleteBlock(use[c.id]);
      const budgets = use[c.id] && use[c.id].budgets.length && !block ? 'Budgets use it: the Save is refused until they change' : '';
      const id = c.isNew
        ? `<input class="input" ${f(`centers.${i}.id`)} data-cost-set-repaint maxlength="40" value="${esc(c.id)}" aria-label="Id of center ${i + 1}" autocomplete="off">`
        : `<code>${esc(c.id)}</code>`;
      return `<tr><td><input class="input" ${f(`centers.${i}.name`)} data-cost-set-repaint maxlength="60" value="${esc(c.name)}" aria-label="Name of center ${i + 1}" autocomplete="off"></td><td>${id}</td><td>${esc(costSetUsedBy(use[c.id]))}</td><td><button type="button" class="btn ghost danger" data-cost-set-act="del-center" data-i="${i}" ${block ? 'disabled' : ''} title="${esc(block || budgets)}">Delete</button></td></tr>`;
    })
    .join('');
  const fullCenters = d.centers.length >= COST_SET_LIMITS.centers;
  const keyRows = keys
    .map(
      (k) =>
        `<tr><td>${esc(k.name || k.id)} <small>${esc(k.id)}</small></td><td><select class="input" ${f('keyCenters.' + k.id)} data-cost-set-repaint aria-label="${esc('Center of key ' + (k.name || k.id))}">${opt('', 'Folder rules decide', d.keyCenters[k.id] || '')}${centerOpts(d.keyCenters[k.id] || '')}</select></td></tr>`,
    )
    .join('');
  const gone = Object.keys(d.keyCenters).filter((id) => !keys.some((k) => k.id === id));
  const goneHtml = gone.length
    ? `<p class="cost-note warn">Key no longer exists</p><ul class="cost-set-unassigned">${gone
        .map(
          (id, i) =>
            `<li><code>${esc(id)}</code><span>${esc('→ ' + costSetCenterName(d.keyCenters[id], d.centers))}</span><button type="button" class="btn ghost" data-cost-set-act="remove-key" data-i="${i}">Remove</button></li>`,
        )
        .join('')}</ul>`
    : '';
  const rules = d.folderRules
    .map((r, i) => {
      const k = i + 1;
      return `<li class="cost-set-rule"><span class="cost-set-num">#${k}</span><input class="input" ${f(`folderRules.${i}.glob`)} maxlength="300" value="${esc(r.glob)}" aria-label="Glob of rule #${k}" autocomplete="off" spellcheck="false"><select class="input" ${f(`folderRules.${i}.center`)} data-cost-set-repaint aria-label="Center of rule #${k}">${opt('', 'Choose a center', r.center || '')}${centerOpts(r.center || '')}</select><span class="cost-set-actions"><button type="button" class="btn ghost" data-cost-set-act="rule-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move rule #${k} up">Up</button><button type="button" class="btn ghost" data-cost-set-act="rule-down" data-i="${i}" ${i === d.folderRules.length - 1 ? 'disabled' : ''} aria-label="Move rule #${k} down">Down</button><button type="button" class="btn ghost danger" data-cost-set-act="del-rule" data-i="${i}" aria-label="Delete rule #${k}">Delete</button></span><span class="cost-set-warn" data-cost-set-warn="${i}">${esc(costSetWarnText(st, i))}</span></li>`;
    })
    .join('');
  const fullRules = d.folderRules.length >= COST_SET_LIMITS.folderRules;
  const noCenter = !d.centers.some((c) => c.id);
  return `<div class="cost-set-grid"><div class="cost-set-forms">
    <h4>Cost centers</h4>
    <table class="cost-table cost-set-table"><thead><tr><th>Name</th><th>Id</th><th>Used by</th><th></th></tr></thead><tbody>${centers || '<tr><td colspan="4">No cost centers yet.</td></tr>'}</tbody></table>
    <div><button type="button" class="btn ghost" data-cost-set-act="add-center" ${fullCenters ? `disabled title="At most ${COST_SET_LIMITS.centers} cost centers"` : ''}>Add</button></div>
    <h4>Gateway keys</h4>
    <p class="cost-note">A key's center always wins over folder rules.</p>
    ${keyRows ? `<table class="cost-table cost-set-table"><tbody>${keyRows}</tbody></table>` : '<p class="cost-note">No gateway keys. Keys are managed on the Gateway page.</p>'}
    ${goneHtml}
    <h4>Folder rules</h4>
    <p class="cost-note">The first matching rule wins; a path no rule matches is Unassigned.</p>
    <p class="cost-note">Globs: <code>*</code> stays in one folder, <code>**</code> crosses folders, a trailing <code>/**</code> also matches the folder itself; start with <code>~</code>, <code>/</code> or a drive letter.</p>
    ${rules ? `<ol class="cost-set-rules">${rules}</ol>` : '<p class="cost-note">No folder rules yet.</p>'}
    <div><button type="button" class="btn ghost" data-cost-set-act="add-rule" ${fullRules || noCenter ? `disabled title="${fullRules ? `At most ${COST_SET_LIMITS.folderRules} folder rules` : 'Add a cost center first'}"` : ''}>Add</button></div>
  </div><aside class="cost-set-preview" aria-label="Preview">
    <div data-cost-set-preview-body aria-busy="false">${costSetPreviewHtml(st)}</div>
    <div class="cost-set-test"><label>Test a path<input class="input" data-cost-set-test value="${esc(st.testPath)}" maxlength="1000" placeholder="~/Github/acme/web" autocomplete="off" spellcheck="false"></label><div data-cost-set-test-out role="status">${costSetTestHtml(st)}</div></div>
  </aside></div>`;
}

/** The preview column: moves, Unassigned projects with Create rule, or the draft's reasons, or the error with Retry. */
function costSetPreviewHtml(st) {
  const p = st.preview;
  if (!p) return '<p class="cost-note">The preview is loading…</p>';
  if (p.error)
    return `<p class="cost-note warn">The preview could not load: ${esc(p.error)}</p><button type="button" class="btn ghost" data-cost-set-act="retry-preview">Retry</button>`;
  if (p.reasons)
    return `<p class="cost-note warn">This draft does not validate; Save would answer with the same reasons:</p>${costReasonsHtml(p.reasons)}`;
  const a = p.answer;
  const saved = (st.answer && st.answer.settings) || {};
  const drafted = (p.sent && p.sent.centers) || [];
  const moves = a.moves.length
    ? `<table class="cost-table cost-set-moves"><tbody>${a.moves
        .map(
          (m) =>
            `<tr><td>${esc(m.project != null ? m.project : 'Key: ' + (m.keyName || m.keyId))}</td><td class="num">${esc(costMoney(m.listUSD))}</td><td>${esc(costSetCenterName(m.from, saved.centers) + ' → ' + costSetCenterName(m.to, drafted))}</td></tr>`,
        )
        .join('')}</tbody></table>${a.more ? `<p class="cost-note">and ${Number(a.more)} more</p>` : ''}`
    : '<p class="cost-note">No project or key changes center.</p>';
  const full = ((st.drafts.rules && st.drafts.rules.folderRules) || saved.folderRules || []).length >= COST_SET_LIMITS.folderRules;
  const unassigned = a.unassigned.length
    ? `<ul class="cost-set-unassigned">${a.unassigned
        .map(
          (u, i) =>
            `<li><span>${esc(u.project)}</span><span class="num">${esc(costMoney(u.listUSD))}</span><button type="button" class="btn ghost" data-cost-set-act="create-rule" data-i="${i}" ${full ? 'disabled' : ''}>Create rule</button></li>`,
        )
        .join('')}</ul>`
    : '<p class="cost-note">No project of the last 30 days is Unassigned.</p>';
  const notes = (a.unread || []).map((u) => `<p class="cost-note warn">${esc(costUnreadText(u))}</p>`).join('');
  return `${notes}<h4>Moves</h4><p class="cost-note">The last 30 days in USD: center now → under this draft.</p>${moves}<h4>Unassigned</h4>${unassigned}`;
}
/** Where the typed test path goes: "Acme · rule #3 ~/Github/acme/**", or "Unassigned, no rule matches". */
function costSetTestHtml(st) {
  const p = st.preview;
  const t = p && p.answer && p.answer.test;
  if (!String(st.testPath || '').trim() || !t) return '';
  if (t.rule == null) return '<p>Unassigned, no rule matches</p>';
  const r = (p.sent.folderRules || [])[t.rule] || {};
  return `<p>${esc(costSetCenterName(t.center, p.sent.centers))} · rule #${t.rule + 1} <code>${esc(r.glob)}</code></p>`;
}

// The preview follows the rules draft about 400 ms after its last edit; a newer request supersedes an older one.
function costSetSchedulePreview(ms = COST_SET_PREVIEW_MS) {
  clearTimeout(COST_SET.previewTimer);
  COST_SET.previewTimer = setTimeout(() => void costSetRunPreview(), ms);
}
async function costSetRunPreview() {
  const a = COST_SET.answer;
  if (!a) return;
  const body = { settings: costSetBody('rules', a.settings, costSetDraftOf('rules'), a.sources) };
  const path = String(COST_SET.testPath || '').trim();
  if (path) body.testPath = path;
  const my = ++COST_SET.previewReq;
  const host = document.querySelector('#cost-app [data-cost-set-preview-body]');
  if (host) host.setAttribute('aria-busy', 'true');
  let next;
  try {
    const r = await costPost('/api/cost/settings/preview', body);
    const j = r.json || {};
    next =
      r.status === 200
        ? { sent: body.settings, answer: j }
        : r.status === 400 && Array.isArray(j.reasons)
          ? { sent: body.settings, reasons: j.reasons }
          : { error: j.error || `request failed (${r.status})` };
  } catch (e) {
    next = { error: e.message };
  }
  if (my !== COST_SET.previewReq) return; // a newer draft was sent meanwhile, or the page was left
  COST_SET.preview = next;
  costSetPaintPreview();
}
// The preview's parts on screen, without touching the forms (the owner may be typing in one).
function costSetPaintPreview() {
  const host = document.querySelector('#cost-app [data-cost-set-preview-body]');
  if (host) {
    host.innerHTML = costSetPreviewHtml(COST_SET);
    host.setAttribute('aria-busy', 'false');
  }
  const out = document.querySelector('#cost-app [data-cost-set-test-out]');
  if (out) out.innerHTML = costSetTestHtml(COST_SET);
  for (const el of document.querySelectorAll('#cost-app [data-cost-set-warn]'))
    el.textContent = costSetWarnText(COST_SET, Number(el.dataset.costSetWarn));
}

// A structural edit of the rules: the draft changes, the panel is drawn again, and the preview follows.
function costSetRulesEdit(fn, focus) {
  costSetEdit('rules', fn);
  costSetPaintPanel('rules', focus);
  costSetSchedulePreview();
}
const costSetAt = (b) => Number(b.dataset.i);
Object.assign(COST_SET_ACTIONS, {
  'add-center': () => {
    const d = costSetDraftOf('rules');
    if (d.centers.length >= COST_SET_LIMITS.centers) return;
    const i = d.centers.length;
    costSetRulesEdit(
      (x) => x.centers.push({ id: '', name: '', isNew: true, idEdited: false, prevId: '' }),
      [['data-cost-set-field', `rules:centers.${i}.name`]],
    );
  },
  'del-center': (b) => costSetRulesEdit((x) => x.centers.splice(costSetAt(b), 1)),
  'remove-key': (b) =>
    costSetRulesEdit((x) => {
      const keys = (COST_SET.answer && COST_SET.answer.keys) || [];
      const gone = Object.keys(x.keyCenters).filter((id) => !keys.some((k) => k.id === id));
      delete x.keyCenters[gone[costSetAt(b)]];
    }),
  'add-rule': () => {
    const d = costSetDraftOf('rules');
    if (d.folderRules.length >= COST_SET_LIMITS.folderRules) return;
    const i = d.folderRules.length;
    costSetRulesEdit((x) => x.folderRules.push({ glob: '', center: '' }), [['data-cost-set-field', `rules:folderRules.${i}.glob`]]);
  },
  'rule-up': (b) => {
    const i = costSetAt(b);
    if (i < 1) return;
    costSetRulesEdit(
      (x) => x.folderRules.splice(i - 1, 0, ...x.folderRules.splice(i, 1)),
      [['data-cost-set-act', 'rule-up'], ['data-i', String(i - 1)]],
    );
  },
  'rule-down': (b) => {
    const i = costSetAt(b);
    if (i >= costSetDraftOf('rules').folderRules.length - 1) return;
    costSetRulesEdit(
      (x) => x.folderRules.splice(i + 1, 0, ...x.folderRules.splice(i, 1)),
      [['data-cost-set-act', 'rule-down'], ['data-i', String(i + 1)]],
    );
  },
  'del-rule': (b) => costSetRulesEdit((x) => x.folderRules.splice(costSetAt(b), 1)),
  // An Unassigned project gets a rule for its folder; the keyboard goes to the new rule's center.
  'create-rule': (b) => {
    const u = COST_SET.preview && COST_SET.preview.answer && COST_SET.preview.answer.unassigned[costSetAt(b)];
    const d = costSetDraftOf('rules');
    if (!u || d.folderRules.length >= COST_SET_LIMITS.folderRules) return;
    const field = `rules:folderRules.${d.folderRules.length}.center`;
    costSetRulesEdit((x) => x.folderRules.push({ glob: costSetRuleGlob(u.project), center: '' }), [['data-cost-set-field', field]]);
    const sel = [...document.querySelectorAll('#cost-app [data-cost-set-field]')].find((el) => el.dataset.costSetField === field);
    if (sel) sel.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  },
  'retry-preview': () => costSetSchedulePreview(0),
});
// A typed edit of the rules panel (or the test path). A new center's id follows its name until the owner types one,
// and the keys and rules that chose it follow its id; a saved center's id never changes.
function costSetRulesInput(t, panel, path) {
  if (t.hasAttribute && t.hasAttribute('data-cost-set-test')) {
    COST_SET.testPath = t.value;
    return costSetSchedulePreview();
  }
  if (panel !== 'rules') return;
  const m = path && /^centers\.(\d+)\.(name|id)$/.exec(path);
  const d = COST_SET.drafts.rules;
  const c = m && d.centers[Number(m[1])];
  if (c && c.isNew) {
    const was = c.prevId ?? '';
    if (m[2] === 'id') c.idEdited = true;
    else if (!c.idEdited) {
      c.id = costSetCenterId(c.name, d.centers.filter((x) => x !== c).map((x) => x.id));
      const el = [...document.querySelectorAll('#cost-app [data-cost-set-field]')].find(
        (x) => x.dataset.costSetField === `rules:centers.${m[1]}.id`,
      );
      if (el) el.value = c.id;
    }
    if (was && was !== c.id) {
      for (const [k, v] of Object.entries(d.keyCenters)) if (v === was) d.keyCenters[k] = c.id;
      for (const r of d.folderRules) if (r.center === was) r.center = c.id;
    }
    c.prevId = c.id;
  }
  costSetSchedulePreview();
}
COST_SET_ON_INPUT.push(costSetRulesInput);
COST_SET_BODIES.rules = costSetRulesHtml;
COST_SET_ON_LOAD.push(() => costSetSchedulePreview(0));
```

In the `module.exports` object, after `costMountSettings,` add:

```js
    costSetCenterId,
    costSetCenterUse,
    costSetDeleteBlock,
    costSetUsedBy,
    costSetRuleGlob,
    costSetCenterName,
    costSetWarnText,
    costSetRulesHtml,
    costSetPreviewHtml,
    costSetTestHtml,
    costSetRunPreview,
    costSetRulesInput,
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/cost-settings-ui.test.js test/cost-ui.test.js`
Expected: PASS (18 tests in the new file).

- [ ] **Step 5: Commit**

```bash
git add public/costsettings.js test/cost-settings-ui.test.js
git commit -m "Cost Control Settings: cost centers, gateway keys and folder rules with a live server preview"
```

---
### Task 7: Panels "Billing" and "Display currency"

**Files:**
- Modify: `public/costsettings.js` (a section before the `module.exports` line; names added to the exports)
- Test: `test/cost-settings-ui.test.js` (append)

**Interfaces:**
- Consumes: Task 5's registries, `costSetEdit`, `costSetDraftOf`, `costSetField`, `costSetFromSaved`, `costSetNum`,
  `costSetPaintPanel`, `COST_SET_LIMITS`; `COST_SOURCES`, `costIsDay`, `costToday` (costview.js); `rateFor`
  (`lib/cost/rules.js`, in the test only).
- Produces:
  - Pure: `costSetBillingHtml(st)`, `costSetRateToday(rates, today) → { from, perUSD } | null` (R8),
    `costSetRateLine(code, hit)`, `costSetCurrencyHtml(st)`; constants `COST_SET_PLAN_NOTE`, `COST_SET_RATE_NOTE`.
  - Actions `mode` (`data-src`, `data-mode`), `cur-on` (`data-on`), `add-rate`, `del-rate` (`data-i`);
    `COST_SET_BODIES.billing`, `COST_SET_BODIES.currency`; `[data-cost-set-rate]` follows typing.
- Behaviour:
  - Billing: one row per source of the answer's `sources`, labelled as on the other pages, with a Metered / Plan
    switch; Plan shows plan name (≤ 60), fee in USD (0–1,000,000) and period (month or year), and the line "The plan
    fee is spread over the days of its period and counted as paid. Usage on this source counts as usage value only."
    A source missing from the saved billing shows as Metered. Switching back and forth keeps what was typed. Save
    writes every source out (Task 5's `costSetBody`).
  - Currency: **USD only** / **USD + display currency**; with the second, the code (3 letters, upper-cased on Save),
    the rates table (Start date, Units per 1 USD, Delete), **Add** (a row from today, disabled at 1000), today's rate
    line and the read-time note. A Save of a currency removed or recoded under a budget is refused by the server (409)
    and its reasons are shown with **Open Budgets** (Task 5).

- [ ] **Step 1: Write the failing test**

Append to `test/cost-settings-ui.test.js`:

```js
/* ---------- Task 7: billing and display currency ---------- */

test('billing: one row per source, Metered or Plan; a plan shows its three fields and the line on what it means', () => {
  const html = U.costSetBillingHtml(ST());
  for (const label of ['Claude Code', 'Codex', 'Gateway', 'Judge', 'Replay', 'Collaboration']) assert.match(html, new RegExp(`<b>${label}</b>`));
  assert.match(html, /data-src="claude" data-mode="plan" aria-pressed="true">Plan/);
  assert.match(html, /data-src="codex" data-mode="metered" aria-pressed="true">Metered/);
  assert.match(html, /data-cost-set-field="billing:billing\.claude\.plan" maxlength="60" value="Max"/);
  assert.match(html, /data-cost-set-field="billing:billing\.claude\.feeUSD" type="number" min="0" max="1000000" step="any" value="200"/);
  assert.match(html, /<option value="month" selected>Month<\/option><option value="year" >Year<\/option>/);
  assert.equal(
    (html.match(/The plan fee is spread over the days of its period and counted as paid\. Usage on this source counts as usage value only\./g) || []).length,
    1,
    'only under a plan',
  );
  assert.doesNotMatch(html, /billing\.codex\.plan/, 'a metered source has no plan fields');
  const evil = U.costSetFromSaved('billing', SAVED, SOURCES);
  evil.billing.claude.plan = EVIL;
  assert.doesNotMatch(U.costSetBillingHtml(ST({ drafts: { billing: evil } })), /<img/);
});

test('billing: the switch keeps a typed plan; a source missing from the saved billing shows as Metered', () => {
  resetState();
  U.COST_SET.answer = ANSWER({ settings: { ...SAVED, billing: {} } });
  U.COST_SET_ACTIONS.mode({ dataset: { src: 'codex', mode: 'plan' } });
  U.COST_SET.drafts.billing.billing.codex.plan = 'Pro';
  U.COST_SET_ACTIONS.mode({ dataset: { src: 'codex', mode: 'metered' } });
  U.COST_SET_ACTIONS.mode({ dataset: { src: 'codex', mode: 'plan' } });
  assert.deepEqual(U.COST_SET.drafts.billing.billing.codex, { mode: 'plan', plan: 'Pro', feeUSD: '', period: 'month' });
  assert.match(U.costSetBillingHtml(ST({ answer: ANSWER({ settings: { ...SAVED, billing: {} } }) })), /data-src="claude" data-mode="metered" aria-pressed="true"/);
});

test("today's rate: the rule of rateFor, from the draft's valid rows; the line and the note", () => {
  const rates = [
    { from: '2026-10-01', perUSD: '16250' },
    { from: '2026-10-20', perUSD: '16420' },
    { from: '2026-11-01', perUSD: '17000' }, // not yet
    { from: '2026-10-25', perUSD: '' }, // not a rate yet
    { from: '2026-10-26', perUSD: '0' },
  ];
  const hit = U.costSetRateToday(rates, '2026-10-28');
  assert.deepEqual(hit, { from: '2026-10-20', perUSD: 16420 });
  const valid = rates.filter((r) => Number(r.perUSD) > 0).map((r) => ({ from: r.from, perUSD: Number(r.perUSD) }));
  for (const day of ['2026-09-30', '2026-10-01', '2026-10-19', '2026-10-20', '2026-10-31', '2026-11-01', '2027-01-01']) {
    const mine = U.costSetRateToday(rates, day);
    assert.equal(mine ? mine.perUSD : null, R.rateFor({ rates: valid }, day), day);
  }
  assert.equal(U.costSetRateLine('idr', { from: '2026-10-01', perUSD: 16250 }), 'Today: 1 USD = 16,250 IDR (rate from 2026-10-01)');
  assert.equal(U.costSetRateLine('IDR', null), 'Today: no rate starts on or before today.');
  const html = U.costSetCurrencyHtml(ST());
  assert.match(html, /data-on="on" aria-pressed="true">USD \+ display currency/);
  assert.match(html, /Today: 1 USD = 16,250 IDR \(rate from 2026-10-01\)/);
  assert.match(html, /Rates convert at read time: a change here also changes how past days read in this currency\. USD amounts never change\./);
  assert.match(html, /data-cost-set-field="currency:currency\.rates\.0\.perUSD" value="16250"/);
});

test('currency: USD only hides the code and rates; Add appends a rate from today, Delete removes it; 1000 at most', () => {
  const off = U.costSetCurrencyHtml(ST({ answer: ANSWER({ settings: { ...SAVED, currency: null } }) }));
  assert.match(off, /data-on="off" aria-pressed="true">USD only/);
  assert.doesNotMatch(off, /currency\.code|Today:/);
  resetState();
  global.costToday = () => '2026-10-28';
  try {
    U.COST_SET_ACTIONS['add-rate']();
    assert.deepEqual(U.COST_SET.drafts.currency.currency.rates[1], { from: '2026-10-28', perUSD: '' });
    U.COST_SET_ACTIONS['del-rate']({ dataset: { i: '0' } });
    assert.deepEqual(U.COST_SET.drafts.currency.currency.rates, [{ from: '2026-10-28', perUSD: '' }]);
    U.COST_SET_ACTIONS['cur-on']({ dataset: { on: 'off' } });
    assert.equal(U.costSetBody('currency', SAVED, U.COST_SET.drafts.currency, SOURCES).currency, null);
  } finally {
    global.costToday = V.costToday;
  }
  const many = { currency: { on: 'on', code: 'IDR', rates: Array.from({ length: 1000 }, (_, i) => ({ from: '2026-10-01', perUSD: String(i + 1) })) } };
  assert.match(U.costSetCurrencyHtml(ST({ drafts: { currency: many } })), /data-cost-set-act="add-rate" disabled title="At most 1000 rates"/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-settings-ui.test.js`
Expected: FAIL, the 4 new tests: `TypeError: U.costSetBillingHtml is not a function`,
`TypeError: U.COST_SET_ACTIONS.mode is not a function`, `TypeError: U.costSetRateToday is not a function`,
`TypeError: U.costSetCurrencyHtml is not a function`.

- [ ] **Step 3: Add the panels to `public/costsettings.js`**

Insert this section just before the line `if (typeof module !== 'undefined')`:

```js
/* ---------- panels: billing and display currency ---------- */

const COST_SET_PLAN_NOTE =
  'The plan fee is spread over the days of its period and counted as paid. Usage on this source counts as usage value only.';
const COST_SET_RATE_NOTE =
  'Rates convert at read time: a change here also changes how past days read in this currency. USD amounts never change.';

function costSetBillingHtml(st) {
  const a = st.answer || {};
  const sources = a.sources || Object.keys(COST_SOURCES);
  const d = st.drafts.billing || costSetFromSaved('billing', a.settings, sources);
  const f = (path) => costSetField('billing', path, st);
  return sources
    .map((src) => {
      const b = d.billing[src] || { mode: 'metered', plan: '', feeUSD: '', period: 'month' };
      const label = COST_SOURCES[src] || src;
      const seg = ['metered', 'plan']
        .map(
          (m) =>
            `<button type="button" data-cost-set-act="mode" data-src="${esc(src)}" data-mode="${m}" aria-pressed="${b.mode === m}">${m === 'plan' ? 'Plan' : 'Metered'}</button>`,
        )
        .join('');
      const plan =
        b.mode === 'plan'
          ? `<div class="cost-row"><label>Plan name<input class="input" ${f(`billing.${src}.plan`)} maxlength="60" value="${esc(b.plan)}" autocomplete="off"></label><label>Fee in USD<input class="input" ${f(`billing.${src}.feeUSD`)} type="number" min="0" max="1000000" step="any" value="${esc(b.feeUSD)}"></label><label>Period<select class="input" ${f(`billing.${src}.period`)}><option value="month" ${b.period === 'month' ? 'selected' : ''}>Month</option><option value="year" ${b.period === 'year' ? 'selected' : ''}>Year</option></select></label></div><p class="cost-note">${esc(COST_SET_PLAN_NOTE)}</p>`
          : '';
      return `<div class="cost-set-source"><div class="cost-set-source-head"><b>${esc(label)}</b><div class="segmented" role="group" aria-label="${esc('Billing of ' + label)}">${seg}</div></div>${plan}</div>`;
    })
    .join('');
}

/** Today's rate (R8): the latest valid rate whose start is on or before `today`, as rateFor picks it, or null. */
function costSetRateToday(rates, today) {
  let hit = null;
  for (const r of rates || []) {
    const v = costSetNum(r.perUSD);
    if (!costIsDay(r.from) || !(Number.isFinite(v) && v > 0) || r.from > today) continue;
    if (!hit || r.from >= hit.from) hit = { from: r.from, perUSD: v };
  }
  return hit;
}
/** "Today: 1 USD = 16,250 IDR (rate from 2026-10-01)", or that no rate applies yet. */
function costSetRateLine(code, hit) {
  if (!hit) return 'Today: no rate starts on or before today.';
  const cur =
    String(code || '')
      .trim()
      .toUpperCase() || 'units';
  // Plain text, escaped where it is drawn.
  return (
    'Today: 1 USD = ' +
    hit.perUSD.toLocaleString('en', { maximumFractionDigits: 4 }) +
    ' ' +
    cur +
    ' (rate from ' +
    hit.from +
    ')'
  );
}

function costSetCurrencyHtml(st) {
  const a = st.answer || {};
  const c = (st.drafts.currency || costSetFromSaved('currency', a.settings, a.sources)).currency;
  const f = (path) => costSetField('currency', path, st);
  const today = st.today || costToday();
  const seg = [
    ['off', 'USD only'],
    ['on', 'USD + display currency'],
  ]
    .map(
      ([v, text]) =>
        `<button type="button" data-cost-set-act="cur-on" data-on="${v}" aria-pressed="${c.on === v}">${text}</button>`,
    )
    .join('');
  if (c.on !== 'on') return `<div class="segmented" role="group" aria-label="Currency">${seg}</div>`;
  const rows = c.rates
    .map(
      (r, i) =>
        `<tr><td><input class="input" type="date" ${f(`currency.rates.${i}.from`)} value="${esc(r.from)}" aria-label="Start date of rate ${i + 1}"></td><td><input class="input" type="number" min="0" step="any" ${f(`currency.rates.${i}.perUSD`)} value="${esc(r.perUSD)}" aria-label="Units per 1 USD of rate ${i + 1}"></td><td><button type="button" class="btn ghost danger" data-cost-set-act="del-rate" data-i="${i}">Delete</button></td></tr>`,
    )
    .join('');
  const full = c.rates.length >= COST_SET_LIMITS.rates;
  return `<div class="segmented" role="group" aria-label="Currency">${seg}</div>
    <label>Code<input class="input" ${f('currency.code')} maxlength="3" value="${esc(c.code)}" placeholder="IDR" autocomplete="off"></label>
    <table class="cost-table cost-set-table"><thead><tr><th>Start date</th><th>Units per 1 USD</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3">No rates yet.</td></tr>'}</tbody></table>
    <div><button type="button" class="btn ghost" data-cost-set-act="add-rate" ${full ? `disabled title="At most ${COST_SET_LIMITS.rates} rates"` : ''}>Add</button></div>
    <p class="cost-set-today" data-cost-set-rate>${esc(costSetRateLine(c.code, costSetRateToday(c.rates, today)))}</p>
    <p class="cost-note">${esc(COST_SET_RATE_NOTE)}</p>`;
}

Object.assign(COST_SET_ACTIONS, {
  mode: (b) => {
    const src = b.dataset.src;
    costSetEdit('billing', (d) => {
      d.billing[src] = { ...(d.billing[src] || { plan: '', feeUSD: '', period: 'month' }), mode: b.dataset.mode };
    });
    costSetPaintPanel('billing');
  },
  'cur-on': (b) => {
    costSetEdit('currency', (d) => (d.currency.on = b.dataset.on === 'on' ? 'on' : 'off'));
    costSetPaintPanel('currency');
  },
  'add-rate': () => {
    const d = costSetDraftOf('currency');
    if (d.currency.rates.length >= COST_SET_LIMITS.rates) return;
    const i = d.currency.rates.length;
    costSetEdit('currency', (x) => x.currency.rates.push({ from: costToday(), perUSD: '' }));
    costSetPaintPanel('currency', [['data-cost-set-field', `currency:currency.rates.${i}.perUSD`]]);
  },
  'del-rate': (b) => {
    costSetEdit('currency', (x) => x.currency.rates.splice(Number(b.dataset.i), 1));
    costSetPaintPanel('currency');
  },
});
// Today's rate follows the rates and the code as they are typed.
COST_SET_ON_INPUT.push((t, panel) => {
  if (panel !== 'currency') return;
  const el = document.querySelector('#cost-app [data-cost-set-rate]');
  const c = costSetDraftOf('currency').currency;
  if (el) el.textContent = costSetRateLine(c.code, costSetRateToday(c.rates, costToday()));
});
COST_SET_BODIES.billing = costSetBillingHtml;
COST_SET_BODIES.currency = costSetCurrencyHtml;
```

In the `module.exports` object, after `costSetRulesInput,` add:

```js
    costSetBillingHtml,
    costSetRateToday,
    costSetRateLine,
    costSetCurrencyHtml,
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/cost-settings-ui.test.js`
Expected: PASS (22 tests).

- [ ] **Step 5: Commit**

```bash
git add public/costsettings.js test/cost-settings-ui.test.js
git commit -m "Cost Control Settings: billing per source and the display currency with today's rate"
```

---
### Task 8: Panel "Restate" with preview, confirmation and history; the esc() audit

**Files:**
- Modify: `public/costsettings.js` (a section before the `module.exports` line; names added to the exports)
- Test: `test/cost-settings-ui.test.js` (append)

**Interfaces:**
- Consumes: Task 5's registries, `COST_SET` (`restate`, `restateReq`, `history`, `historyError`, `historyReq`, `gen`,
  `open`), `costSetLocked`, `costSetPaintPanel`, `costSetPaintSoon`; Task 6's `costSetCenterName`; `costGet`,
  `costPost`, `costMoney`, `costIsDay`, `costAddDays`, `costToday`, `COST_MAX_DAYS`, `COST_SOURCES` (costview.js),
  `reduceMotion` (app.js); Task 4's `POST /api/cost/restate/preview`, `GET /api/cost/restates`; the existing
  `POST /api/cost/restate` (`{ correction, overrides }`).
- Produces:
  - Pure: `costSetRestateRange(today)` (R6), `costSetRestateCheck(from, to, today)` (R6),
    `costSetPreviewState(restate, gen)` (R7), `costSetCanRun(restate, gen, locked)` (R7),
    `costSetRestateSummaryHtml(preview, centers)`, `costSetHistoryHtml(st)`, `costSetRestateHtml(st)`.
  - Page: `costSetRestatePreview()`, `costSetRunRestate()`, `costSetLoadHistory()`, `costSetOpenRestate()`,
    `costSetRestateInput(field, event)`; actions `restate-preview`, `restate-run`, `retry-history`, `open-restate`;
    `COST_SET_BODIES.restate`; the default range on the first load; the history on opening the panel.
  - Markup hooks: `[data-cost-set-restate="from|to|reason|ack"]`, `[data-cost-set-history]`.
- Behaviour:
  - The explanation line; From/To (default: the first of this month to yesterday, the previous month on the 1st);
    the server's own check line under them, Preview disabled while it fails.
  - Preview: "Rows: N ledger rows change, out of M in the range.", usage value before → after with the difference,
    center moves, "Prices: version 1, version 2 → version 3" or "→ today's prices, not yet recorded as a version", the
    billing set over the range; with no change: the billing and "No ledger row changes. The billing above is still set
    over the range."
  - Confirm: a reason (≤ 200) and "I understand this correction cannot be undone"; **Run restate** only for a fresh
    preview (R7). A date change marks it "Range changed: preview again", a Save "Settings changed: preview again". A
    run sends the previewed range; on success "Restated: N rows", the preview is cleared and the history reloads.
  - History: newest first (the server caps it at 100), When, Range, Reason (escaped), Rows changed, Price version;
    "No restate yet."; an error with **Retry**. Errors show the server's path-free message.

- [ ] **Step 1: Write the failing test**

Append to `test/cost-settings-ui.test.js`:

```js
/* ---------- Task 8: restate, history, and the esc() audit ---------- */

test('restate range: the first of the month to yesterday; on the 1st, the previous month; the server checks', () => {
  assert.deepEqual(U.costSetRestateRange('2026-10-28'), { from: '2026-10-01', to: '2026-10-27' });
  assert.deepEqual(U.costSetRestateRange('2026-11-01'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(U.costSetRestateRange('2027-01-01'), { from: '2026-12-01', to: '2026-12-31' });
  const t = '2026-10-28';
  assert.equal(U.costSetRestateCheck('2026-10-01', '2026-10-27', t), null);
  assert.equal(U.costSetRestateCheck('2026-10-01', '', t), 'from and to are dates (YYYY-MM-DD)');
  assert.equal(U.costSetRestateCheck('2026-02-30', '2026-03-01', t), 'from and to are dates (YYYY-MM-DD)');
  assert.equal(U.costSetRestateCheck('2026-10-20', '2026-10-10', t), 'from must be on or before to');
  assert.equal(U.costSetRestateCheck('2025-09-01', '2026-10-27', t), 'at most 400 days at a time');
  assert.equal(U.costSetRestateCheck('2025-09-23', '2026-10-27', t), null, '400 days exactly');
  assert.equal(U.costSetRestateCheck('2026-10-01', '2026-10-28', t), 'today follows the current prices and rules already; restate up to yesterday');
});

test('restate staleness: a range edit or a Save since the preview; Run needs fresh, a reason, the box, readable settings', () => {
  const base = { from: '2026-10-01', to: '2026-10-27', reason: 'Acme rule', ack: true, preview: { changed: 1 }, of: { from: '2026-10-01', to: '2026-10-27', gen: 2 } };
  assert.equal(U.costSetPreviewState(base, 2), 'fresh');
  assert.equal(U.costSetPreviewState({ ...base, to: '2026-10-26' }, 2), 'stale-range');
  assert.equal(U.costSetPreviewState(base, 3), 'stale-settings');
  assert.equal(U.costSetPreviewState({ ...base, preview: null }, 2), 'none');
  assert.equal(U.costSetCanRun(base, 2, false), true);
  assert.equal(U.costSetCanRun(base, 3, false), false, 'a Save since the preview');
  assert.equal(U.costSetCanRun({ ...base, from: '2026-10-02' }, 2, false), false, 'the range changed');
  assert.equal(U.costSetCanRun({ ...base, reason: '  ' }, 2, false), false);
  assert.equal(U.costSetCanRun({ ...base, reason: 'x'.repeat(201) }, 2, false), false);
  assert.equal(U.costSetCanRun({ ...base, ack: false }, 2, false), false);
  assert.equal(U.costSetCanRun(base, 2, true), false, 'settings that do not read');
  assert.equal(U.costSetCanRun({ ...base, running: true }, 2, false), false);
  const html = (r, gen = 2) => U.costSetRestateHtml(ST({ restate: { ...base, ...r }, gen, history: [] }));
  assert.match(html({}), /data-cost-set-act="restate-run" >Run restate/);
  assert.match(html({}, 3), /Settings changed: preview again[\s\S]*data-cost-set-act="restate-run" disabled/);
  assert.match(html({ to: '2026-10-26' }), /Range changed: preview again/);
  assert.match(html({ to: '2026-10-28' }), /restate up to yesterday[\s\S]*data-cost-set-act="restate-preview" disabled/);
});

test('restate preview: rows, usage before → after, center moves, prices, billing; no change says so', () => {
  const centers = SAVED.centers;
  const billing = [
    { source: 'claude', mode: 'plan', plan: EVIL, feeUSD: 200, period: 'month' },
    { source: 'codex', mode: 'metered' },
  ];
  const p = { changed: 3, total: 40, beforeUSD: 10, afterUSD: 12.5, moves: [{ from: 'unassigned', to: 'acme', listUSD: 7 }], versionsBefore: [1, 2], version: null, newPrices: true, billing };
  const html = U.costSetRestateSummaryHtml(p, centers);
  assert.match(html, /Rows: 3 ledger rows change, out of 40 in the range\./);
  assert.match(html, /Usage value: \$10\.00 → \$12\.50 \(\+\$2\.50\)/);
  assert.match(html, /<li>Unassigned → Acme: \$7\.00<\/li>/);
  assert.match(html, /Prices: version 1, version 2 → today&#39;s prices, not yet recorded as a version/);
  assert.match(html, /Claude Code: Plan &lt;img src=x onerror=alert\(1\)&gt;, \$200\.00 per month; Codex: Metered/);
  assert.doesNotMatch(html, /<img/);
  assert.match(U.costSetRestateSummaryHtml({ ...p, newPrices: false, version: 3 }, centers), /Prices: version 1, version 2 → version 3/);
  const none = U.costSetRestateSummaryHtml({ ...p, changed: 0, moves: [], versionsBefore: [] }, centers);
  assert.match(none, /Billing set over the range:[\s\S]*No ledger row changes\. The billing above is still set over the range\./);
  assert.doesNotMatch(none, /Rows:/);
  assert.match(U.costSetRestateHtml(ST()), /Restate recomputes a past range with today&#39;s prices, rules and billing, and records the result as a correction\. It cannot be undone\. Today is never restated: it follows the current settings already\./);
});

test('restate requests: preview then run with the previewed range and reason; history newest first, escaped', async () => {
  resetState();
  global.costToday = () => '2026-10-28';
  const r = U.COST_SET.restate;
  Object.assign(r, { from: '2026-10-01', to: '2026-10-27', reason: '', ack: false, preview: null, of: null, error: null, done: null });
  const history = [{ ts: Date.UTC(2026, 9, 28, 9), from: '2026-10-01', to: '2026-10-27', reason: EVIL, priceVersion: 2, rows: 3, billing: [] }];
  const calls = fakeServer({
    'POST /api/cost/restate/preview': { status: 200, json: { from: '2026-10-01', to: '2026-10-27', changed: 3, total: 9, beforeUSD: 1, afterUSD: 2, moves: [], versionsBefore: [1], version: 2, newPrices: false, billing: [] } },
    'POST /api/cost/restate': { status: 200, json: { correction: { rows: [{}, {}, {}] }, overrides: [] } },
    'GET /api/cost/restates': { status: 200, json: { restates: history } },
  });
  try {
    await U.costSetRestatePreview();
    assert.deepEqual(r.of, { from: '2026-10-01', to: '2026-10-27', gen: 0 });
    await U.costSetRunRestate();
    assert.equal(calls.length, 1, 'no run without a reason and the box');
    U.costSetRestateInput({ dataset: { costSetRestate: 'reason' }, value: ' Acme rule ' }, 'input');
    U.costSetRestateInput({ dataset: { costSetRestate: 'ack' }, checked: true }, 'input');
    U.costSetRestateInput({ dataset: { costSetRestate: 'to' }, value: '2026-10-20' }, 'input');
    assert.equal(r.to, '2026-10-27', 'a date applies on change, not while typed');
    await U.costSetRunRestate();
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(calls[0].body, { from: '2026-10-01', to: '2026-10-27' });
    assert.deepEqual(calls[1].body, { from: '2026-10-01', to: '2026-10-27', reason: 'Acme rule', confirm: true });
    assert.equal(r.done, 'Restated: 3 rows');
    assert.deepEqual([r.preview, r.reason, r.ack], [null, '', false]);
    assert.equal(calls[2].url, '/api/cost/restates');
    const html = U.costSetHistoryHtml(U.COST_SET);
    assert.match(html, /<td>2026-10-01 – 2026-10-27<\/td><td>&lt;img src=x onerror=alert\(1\)&gt;<\/td><td class="num">3<\/td><td class="num">2<\/td>/);
    assert.match(U.costSetHistoryHtml({ history: [] }), /No restate yet\./);
    assert.match(U.costSetHistoryHtml({ historyError: 'the ledger corrections could not be read' }), /could not be read<\/p><button[^>]*data-cost-set-act="retry-history"/);
  } finally {
    global.costToday = V.costToday;
  }
});

test('restate errors: the server path-free message; a newer request drops an older answer', async () => {
  resetState();
  global.costToday = () => '2026-10-28';
  const r = U.COST_SET.restate;
  Object.assign(r, { from: '2026-10-01', to: '2026-10-27', preview: null, of: null, error: null });
  fakeServer({ 'POST /api/cost/restate/preview': { status: 503, json: { error: 'ledger month 2026-10 could not be read', code: 'LEDGER_MONTH_UNREAD' } } });
  try {
    await U.costSetRestatePreview();
    assert.equal(r.error, 'ledger month 2026-10 could not be read');
    assert.equal(r.preview, null);
    const pending = [];
    global.fetch = () => new Promise((res) => pending.push(res));
    const a = U.costSetRestatePreview();
    const b = U.costSetRestatePreview();
    pending[1]({ status: 200, json: async () => ({ changed: 0, tag: 'newer' }) });
    await b;
    pending[0]({ status: 200, json: async () => ({ changed: 0, tag: 'older' }) });
    await a;
    assert.equal(r.preview.tag, 'newer');
  } finally {
    global.costToday = V.costToday;
  }
});

test('costsettings.js builds no markup from server or owner text without esc() (S1), and every name is cost-prefixed', () => {
  const src = read('costsettings.js');
  const CONTENT =
    /\.(name|reason|reasons|project|model|center|provider|source|plan|label|title|text|error|message|id|key|keyId|keyName|value|code|currency|cur|from|to|note|dim|budget|glob|perUSD|feeUSD|period|testPath)$/;
  const bare = [...src.matchAll(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)].map((m) => m[1]).filter((e) => CONTENT.test(e));
  assert.deepEqual(bare, [], 'content interpolated without esc()');
  for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g))
    assert.doesNotMatch(m[1], /^\s*[\w$.]+\.(message|error|reason|name|text|project)\s*$/, `innerHTML = ${m[1]}`);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\son[a-z]+=["`']/);
  for (const [, name] of src.matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(name, /^(?:cost|COST)/, `${name}: starts with cost`);
  // Loads in Node without a DOM (this file required it above) and every panel has a body.
  assert.deepEqual(Object.keys(U.COST_SET_BODIES).sort(), ['billing', 'currency', 'restate', 'rules']);
  for (const p of ['rules', 'billing', 'currency', 'restate']) assert.ok(U.costSetPageHtml(ST()).includes(`data-cost-set-body="${p}"`));
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/cost-settings-ui.test.js`
Expected: FAIL, the 6 new tests: `TypeError: U.costSetRestateRange is not a function` (and the like), and the audit's
`assert.deepEqual(Object.keys(U.COST_SET_BODIES).sort(), …)` without `restate`.

- [ ] **Step 3: Add the panel to `public/costsettings.js`**

Insert this section just before the line `if (typeof module !== 'undefined')`:

```js
/* ---------- panel: restate ---------- */

const COST_SET_MAX_REASON = 200; // lib/cost/api.js MAX_REASON
const COST_SET_RESTATE_TEXT =
  'Restate recomputes a past range with today\'s prices, rules and billing, and records the result as a correction. It cannot be undone. Today is never restated: it follows the current settings already.';

/** The default restate range (R6): the first of this month to yesterday; on the 1st, the whole previous month. */
function costSetRestateRange(today) {
  const to = costAddDays(today, -1);
  return { from: `${to.slice(0, 8)}01`, to };
}
/** The server's check of a restate range, in its words and order (R6), or null when it passes. */
function costSetRestateCheck(from, to, today) {
  if (!costIsDay(from) || !costIsDay(to)) return 'from and to are dates (YYYY-MM-DD)';
  if (from > to) return 'from must be on or before to';
  if (costAddDays(from, COST_MAX_DAYS) <= to) return `at most ${COST_MAX_DAYS} days at a time`;
  if (to >= today) return 'today follows the current prices and rules already; restate up to yesterday';
  return null;
}
/** A restate preview against the range on screen and the settings generation (R7). */
function costSetPreviewState(r, gen) {
  if (!r || !r.preview || !r.of) return 'none';
  if (r.of.from !== r.from || r.of.to !== r.to) return 'stale-range';
  if (r.of.gen !== gen) return 'stale-settings';
  return 'fresh';
}
/** Run restate: a fresh preview, a reason of 1-200 characters, the box checked, settings that read (R7). */
function costSetCanRun(r, gen, locked) {
  const why = String((r && r.reason) || '').trim();
  return (
    !locked &&
    !r.running &&
    costSetPreviewState(r, gen) === 'fresh' &&
    why.length >= 1 &&
    why.length <= COST_SET_MAX_REASON &&
    r.ack === true
  );
}
// Plain text, escaped where it is drawn.
const costSetPlanText = (b) =>
  b.mode === 'plan'
    ? 'Plan ' + b.plan + ', ' + costMoney(b.feeUSD) + ' per ' + (b.period === 'year' ? 'year' : 'month')
    : 'Metered';

/** What a restate preview answers, as the panel lists it. */
function costSetRestateSummaryHtml(p, centers) {
  const billing = `<li>Billing set over the range: ${(p.billing || [])
    .map((b) => esc((COST_SOURCES[b.source] || b.source) + ': ' + costSetPlanText(b)))
    .join('; ')}</li>`;
  if (!p.changed)
    return `<ul class="cost-set-summary">${billing}</ul><p class="cost-note">No ledger row changes. The billing above is still set over the range.</p>`;
  const diff = p.afterUSD - p.beforeUSD;
  const moves = (p.moves || [])
    .map(
      (m) =>
        `<li>${esc(costSetCenterName(m.from, centers) + ' → ' + costSetCenterName(m.to, centers) + ': ' + costMoney(m.listUSD))}</li>`,
    )
    .join('');
  const before = (p.versionsBefore || []).map((v) => (v == null ? 'no version' : `version ${v}`)).join(', ');
  const after = p.newPrices ? "today's prices, not yet recorded as a version" : `version ${p.version}`;
  return `<ul class="cost-set-summary">
    <li>Rows: ${Number(p.changed)} ledger rows change, out of ${Number(p.total)} in the range.</li>
    <li>Usage value: ${esc(costMoney(p.beforeUSD))} → ${esc(costMoney(p.afterUSD))} (${diff > 0 ? '+' : ''}${esc(costMoney(diff))})</li>
    ${moves ? `<li>Center moves (usage value):<ul>${moves}</ul></li>` : ''}
    <li>${esc('Prices: ' + before + ' → ' + after)}</li>
    ${billing}</ul>`;
}

function costSetHistoryHtml(st) {
  if (st.historyError)
    return `<p class="cost-note warn">${esc(st.historyError)}</p><button type="button" class="btn ghost" data-cost-set-act="retry-history">Retry</button>`;
  if (!st.history) return '<p class="cost-note">Loading…</p>';
  if (!st.history.length) return '<p class="cost-note">No restate yet.</p>';
  return `<table class="cost-table"><thead><tr><th>When</th><th>Range</th><th>Reason</th><th class="num">Rows changed</th><th class="num">Price version</th></tr></thead><tbody>${st.history
    .map(
      (c) =>
        `<tr><td>${esc(new Date(c.ts).toLocaleString('en'))}</td><td>${esc(c.from + ' – ' + c.to)}</td><td>${esc(c.reason)}</td><td class="num">${Number(c.rows)}</td><td class="num">${esc(c.priceVersion ?? '—')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function costSetRestateHtml(st) {
  const r = st.restate;
  const today = st.today || costToday();
  const locked = costSetLocked(st.answer);
  const check = costSetRestateCheck(r.from, r.to, today);
  const state = costSetPreviewState(r, st.gen);
  const centers = (st.answer && st.answer.settings && st.answer.settings.centers) || [];
  const stale =
    state === 'stale-range'
      ? '<p class="cost-note warn">Range changed: preview again</p>'
      : state === 'stale-settings'
        ? '<p class="cost-note warn">Settings changed: preview again</p>'
        : '';
  const preview = r.preview
    ? `${stale}<div class="${state === 'fresh' ? '' : 'cost-set-stale'}">${costSetRestateSummaryHtml(r.preview, centers)}</div>
      <div class="cost-set-confirm"><label>Reason<input class="input" data-cost-set-restate="reason" maxlength="${COST_SET_MAX_REASON}" value="${esc(r.reason)}" autocomplete="off"></label>
      <label class="cost-check"><input type="checkbox" data-cost-set-restate="ack" ${r.ack ? 'checked' : ''}> I understand this correction cannot be undone</label>
      <div class="cost-set-save"><button type="button" class="btn danger" data-cost-set-act="restate-run" ${costSetCanRun(r, st.gen, locked) ? '' : 'disabled'}>Run restate</button>${locked ? '<span class="cost-note">Fix config.json first</span>' : ''}</div></div>`
    : '';
  return `<p>${esc(COST_SET_RESTATE_TEXT)}</p>
    <div class="cost-row"><label>From<input class="input" type="date" data-cost-set-restate="from" value="${esc(r.from)}" max="${esc(costAddDays(today, -1))}"></label><label>To<input class="input" type="date" data-cost-set-restate="to" value="${esc(r.to)}" max="${esc(costAddDays(today, -1))}"></label></div>
    ${check ? `<p class="cost-note warn" role="alert">${esc(check)}</p>` : ''}
    <div><button type="button" class="btn" data-cost-set-act="restate-preview" ${check || r.loading ? 'disabled' : ''}>Preview</button></div>
    ${r.error ? `<p class="cost-note warn" role="alert">${esc(r.error)}</p>` : ''}
    ${r.done ? `<p class="cost-note" role="status">${esc(r.done)}</p>` : ''}
    ${preview}
    <h4>History</h4><div data-cost-set-history>${costSetHistoryHtml(st)}</div>`;
}

async function costSetRestatePreview() {
  const r = COST_SET.restate;
  const check = costSetRestateCheck(r.from, r.to, costToday());
  if (check) return;
  const my = ++COST_SET.restateReq;
  const of = { from: r.from, to: r.to, gen: COST_SET.gen };
  Object.assign(r, { error: null, done: null, loading: true });
  costSetPaintPanel('restate');
  try {
    const res = await costPost('/api/cost/restate/preview', { from: of.from, to: of.to });
    if (my !== COST_SET.restateReq) return;
    if (res.status === 200) Object.assign(r, { preview: res.json, of });
    else Object.assign(r, { preview: null, of: null, error: (res.json && res.json.error) || `request failed (${res.status})` });
  } catch (e) {
    if (my !== COST_SET.restateReq) return;
    Object.assign(r, { preview: null, of: null, error: e.message });
  }
  r.loading = false;
  costSetPaintPanel('restate', [['data-cost-set-act', 'restate-preview']]);
}
async function costSetRunRestate() {
  const r = COST_SET.restate;
  if (!costSetCanRun(r, COST_SET.gen, costSetLocked(COST_SET.answer))) return;
  const my = ++COST_SET.restateReq;
  Object.assign(r, { running: true, error: null });
  costSetPaintPanel('restate');
  try {
    const res = await costPost('/api/cost/restate', { from: r.of.from, to: r.of.to, reason: r.reason.trim(), confirm: true });
    if (my !== COST_SET.restateReq) return;
    if (res.status === 200) {
      const n = res.json.correction.rows.length;
      Object.assign(r, { done: `Restated: ${n} row${n === 1 ? '' : 's'}`, preview: null, of: null, reason: '', ack: false });
      costSetLoadHistory();
    } else r.error = (res.json && res.json.error) || `Could not restate (${res.status})`;
  } catch (e) {
    if (my !== COST_SET.restateReq) return;
    r.error = e.message;
  }
  r.running = false;
  costSetPaintPanel('restate', [['data-cost-set-act', 'restate-preview']]);
}
async function costSetLoadHistory() {
  const my = ++COST_SET.historyReq;
  COST_SET.historyError = null;
  try {
    const j = await costGet('/api/cost/restates');
    if (my !== COST_SET.historyReq) return;
    COST_SET.history = j.restates || [];
  } catch (e) {
    if (my !== COST_SET.historyReq) return;
    COST_SET.historyError = e.message; // path-free: "the ledger corrections could not be read"
  }
  const el = document.querySelector('#cost-app [data-cost-set-history]');
  if (el) el.innerHTML = costSetHistoryHtml(COST_SET);
}
// "Open Restate" after a Save: the panel opens with this month so far (to yesterday), scrolled into view.
function costSetOpenRestate() {
  const r = COST_SET.restate;
  Object.assign(r, costSetRestateRange(costToday()), { error: null, done: null });
  COST_SET.open.restate = true;
  const d = [...document.querySelectorAll('#cost-app [data-cost-set-panel]')].find(
    (x) => x.dataset.costSetPanel === 'restate',
  );
  costSetPaintPanel('restate', [['data-cost-set-act', 'restate-preview']]);
  if (!COST_SET.history) costSetLoadHistory();
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

Object.assign(COST_SET_ACTIONS, {
  'restate-preview': () => void costSetRestatePreview(),
  'restate-run': () => void costSetRunRestate(),
  'retry-history': () => void costSetLoadHistory(),
  'open-restate': () => costSetOpenRestate(),
});
// The reason and the box only enable Run restate; a date, once changed (not while typed), redraws the panel: its
// check line and the preview's staleness.
function costSetRestateInput(t, event) {
  const k = t.dataset && t.dataset.costSetRestate;
  if (!k) return;
  const r = COST_SET.restate;
  if (k === 'reason') r.reason = t.value;
  else if (k === 'ack') r.ack = !!t.checked;
  else {
    if (event !== 'change') return;
    r[k] = t.value;
    r.done = null;
    return costSetPaintSoon('restate');
  }
  const run = document.querySelector('#cost-app [data-cost-set-act="restate-run"]');
  if (run) run.disabled = !costSetCanRun(r, COST_SET.gen, costSetLocked(COST_SET.answer));
}
COST_SET_ON_INPUT.push((t) => costSetRestateInput(t, 'input'));
COST_SET_ON_CHANGE.push((t) => costSetRestateInput(t, 'change'));
COST_SET_ON_OPEN.push((panel) => {
  if (panel === 'restate' && !COST_SET.history) costSetLoadHistory();
});
COST_SET_ON_LOAD.push(() => {
  const r = COST_SET.restate;
  if (!r.from || !r.to) Object.assign(r, costSetRestateRange(costToday()));
  if (COST_SET.open.restate) costSetLoadHistory();
});
COST_SET_BODIES.restate = costSetRestateHtml;
```

In the `module.exports` object, after `costSetCurrencyHtml,` add:

```js
    costSetRestateRange,
    costSetRestateCheck,
    costSetPreviewState,
    costSetCanRun,
    costSetRestateSummaryHtml,
    costSetHistoryHtml,
    costSetRestateHtml,
    costSetRestatePreview,
    costSetRunRestate,
    costSetLoadHistory,
    costSetRestateInput,
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/cost-settings-ui.test.js test/cost-ui.test.js test/cost-budgets-ui.test.js`
Expected: PASS (28 tests in the new file).

- [ ] **Step 5: Check the page in a browser (demo)**

Run: `npm run demo` and open `#cost/settings`. Check: four panels, the first three open; Add a center and type its
name (the id follows); delete the last rule and wait (Moves and Unassigned fill, **Create rule** adds
`<project>/**` and focuses its center); type a test path; Save the rules (the "applies from today" note with **Open
Restate**); switch Codex to Plan, empty the fee and Save (the reason is listed and the fee field is marked), then
**Discard**; Add a rate (today's line follows); **Open Restate** (range filled, history loads), Preview, type a
reason, tick the box, **Run restate** ("Restated: N rows", the history gains the row); leave for Budgets and come
back (the currency draft shows "Unsaved changes"). The browser console stays free of errors.

- [ ] **Step 6: Commit**

```bash
git add public/costsettings.js test/cost-settings-ui.test.js
git commit -m "Cost Control Settings: restate with a preview, a confirmation and its history"
```

---
### Task 9: Docs and the whole suite

**Files:**
- Modify: `docs/cost.md:316` (five pages), `:324` (a row in the menu table), after `:339` (a "Settings page"
  section), `:433` (the settings row, the preview row), `:440` (two rows after the restate row), `:463` (demo mode)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: `docs/cost.md`, the menu**

In `## Cost Control menu` (`:316`), "has four pages." becomes "has five pages.". After the Budgets row of its table
(`:324`), add:

```md
| Settings (`#cost/settings`) | Who pays for what? | Cost centers, gateway keys and folder rules with a preview of what moves, billing per source, the display currency, and restate with a preview and its history (see [Settings page](#settings-page)) |
```

After the **Burn-down scale** paragraph (`:338-339`, the last paragraph before `## API (dashboard sign-in only)`), add:

```md

### Settings page

**Settings** (`#cost/settings`) edits the `cost` section of `config.json` without opening the file. It has four
panels; each of the first three has its own **Save**, which reads the saved settings again and sends them with only
that panel's fields replaced, so a mistake in one panel never holds back another. Unsaved changes are kept per panel
while the browser tab is open (leave the page and come back: they are still there, with **Discard**), and closing the
tab with unsaved changes asks first. The page has no range, currency or measure control and does not refresh by itself.

| Panel | What it edits |
|---|---|
| Cost centers & rules | `centers` (a new center's id is made from its name and is fixed after the first Save; Delete is off while a key or rule uses the center), `keyCenters` (one row per gateway key: a center, or "Folder rules decide"), `folderRules` (in order, moved with Up and Down; the first match wins) |
| Billing | `billing`: Metered or a plan (name, fee in USD, month or year) per source; every source is written out |
| Display currency | `currency`: USD only, or a code with dated rates; today's rate is shown as `rateFor` picks it |
| Restate | a [restate](#restate) of a past range, after a preview |

**Preview of the rules.** About 400 ms after an edit, the page asks the server what the draft would do over the last
30 days, with the server's own validation and glob matcher: the projects and keys that change center, the rules that
match nothing or that an earlier rule always takes, the projects still Unassigned (each with **Create rule**, which
adds `<project>/**`), and where a typed path goes. A draft that does not validate shows the reasons a Save would give.

**Changes apply from today.** After a Save of the rules or the billing, new costs follow them; past days keep theirs
until restated. The note after the Save opens the Restate panel with the first of this month to yesterday. Rates are
not frozen per day: a rate change also changes how past days read in the display currency (USD never changes).

**Restate panel.** **Preview** shows how many ledger rows change, the usage value before and after, the center moves,
the price versions (or "today's prices, not yet recorded as a version") and the billing set over the range. **Run
restate** then needs a reason and the box "I understand this correction cannot be undone"; a range edit or a Save in
another panel since the preview asks for a new one. The panel lists past restates, newest first (at most 100).

**When the settings do not read** (`config.json` does not parse, or its `cost` section does not validate) the page
shows the error and the reasons, and every Save and the restate are off: the values shown are the defaults that stand
in for the invalid ones. The previews still work on the drafts. A Save refused because budgets depend on the change
lists them with a link to Budgets.
```

- [ ] **Step 2: `docs/cost.md`, the API table and the demo**

Replace the `GET /api/cost/settings` row (`:433`) with these two rows:

```md
| `GET /api/cost/settings` | `{ settings, error, reasons, sources, unassigned, keys: [{ id, name }] }`; `reasons` lists why the saved section does not validate (at most 50), else `[]` |
| `POST /api/cost/settings/preview` | body `{ settings, testPath? }` (`testPath` at most 1000 characters, a path written with `~` or in full). 200 `{ from, to, unread, moves: [{ project, keyId, keyName, listUSD, from, to }], more, rules: [{ index, status: ok \| none \| shadowed, by }], unassigned: [{ project, listUSD }], test: { center, rule } \| null }` over the last 30 days, the settings in force against the draft; nothing is saved. 400 for an unknown field or `{ error, reasons }` for a draft that does not validate; 503 with a `code` while the ledger does not read |
```

After the `POST /api/cost/restate` row (`:440`), add:

```md
| `POST /api/cost/restate/preview` | body `{ from, to }`; what a restate would do, written nowhere: 200 `{ from, to, changed, total, beforeUSD, afterUSD, moves: [{ from, to, listUSD }], versionsBefore, version, newPrices, billing }` (`version` null and `newPrices` true while today's prices are not a version yet). The 400, 409 and 503 of `POST /api/cost/restate`, without `reason` and `confirm` |
| `GET /api/cost/restates` | `{ restates: [{ ts, from, to, reason, priceVersion, rows, billing }] }`, newest first, at most 100; `rows` counts the rows that changed. 503 while the corrections do not read |
```

At the end of the `## Demo mode` paragraph (`:463`), append: `The Settings page previews from the demo ledger and
settings; its restate history starts empty and a restate is kept in memory.`

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS on this machine (the baseline plus this plan's 6 + 9 + 9 + 28 tests in
`test/cost-restate-preview.test.js`, `test/cost-preview.test.js`, `test/cost-settings-api.test.js` and
`test/cost-settings-ui.test.js`). CI runs the same on Ubuntu, macOS and Windows.

- [ ] **Step 4: Commit**

```bash
git add docs/cost.md
git commit -m "Docs: the cost Settings page and its preview and restate routes"
```

---
## Decisions made while planning

The spec left these open, or a detail of it did not fit the code; each is built and tested as written here.

1. **Drafts live in `COST_SET.drafts[panel]`**, not `COST.settings.drafts[panel]`: `COST.settings` is the settings
   answer that every cost page replaces on each load, so drafts kept there would be lost. `COST_SET` is the Settings
   page's own state object in `costsettings.js`.
2. **`settingsPreview` takes `keys`** (`[{ id, name }]`): the ledger rows carry key ids only, and a move shows
   "Key: name". The route passes the same `keys()` the settings answer lists.
3. **`total` in the restate preview.** "N ledger rows change, out of the rows in the range" needs the count of the
   range's usage rows: `restatePreview` returns `total` and `restateSummary` passes it on.
4. **`peek` also returns `next`**, the id `observe()` would give new prices. The preview prices its rows as that
   version, so its rows equal what the following `restate()` records (tested), while the answer still says `version:
   null, newPrices: true`.
5. **`reasons` is computed in `lib/cost/api.js`** (validate the raw section again when `settingsOf` reports it invalid):
   `settingsOf` keeps its shape, which `test/cost-rules.test.js` checks with `deepEqual`. While `config.json` does not
   parse, `reasons` is `[]` and `error` says so.
6. **Case rule of the settings preview.** `createCostApi` gains a `nocase` option (tests pass `false`, as they do to
   `createCost`); `server.js` passes nothing, so the platform's rule applies, as in the ledger.
7. **Rule indexes are 0-based** in the API (`index`, `by`, `test.rule`); the page shows `#index+1`. A shadowed rule's
   `by` is the earliest rule among those that took its matches. Rule statuses look only at projects whose rows a key
   mapping does not decide.
8. **Center moves of a restate** are weighted by the usage value after the restate (`after.listUSD`); a null center
   reads as `unassigned`.
9. **Panels are `<details>` elements**: the first three open, Restate closed; opening Restate (or **Open Restate** after
   a Save) loads the history. The 400 ms preview runs on every load too, so warnings and Unassigned show before an
   edit. The test path input sits outside the part of the column a preview answer redraws, so typing is never cut.
10. **Center id from a name** (R5): at most 40 characters (`CENTER_ID`), `center` when nothing is left, a suffix that
    keeps the id within 40. A new center's id follows its name until the owner types one, and the keys and rules that
    chose it follow its id. Every result passes `validate`.
11. **Switches are segmented buttons** with `aria-pressed` (Metered / Plan, USD only / USD + display currency), as the
    other cost pages' controls; no radio inputs.
12. **Typed numbers.** A fee or rate is kept as typed; an empty or non-numeric field is sent as `null`, so the server's
    own reason ("a number from 0 to 1,000,000", "a number above 0") is shown and the field is marked. The code is
    upper-cased on Save.
13. **Restate dates apply on `change`**, not on each keystroke, so the date input is not redrawn while typed. "Restated:
    1 row" is singular.
14. **The currency Save says "Saved."** without the Restate link: rates convert at read time, so a restate does not
    change how past days read in the display currency.
15. **`costview.js` exports a few more helpers** (`COST_SUBS`, `COST_SOURCES`, `COST_MAX_DAYS`, `costToday`,
    `costGet`, `costPost`, `costSub`, `costReasonsHtml`, `costRibbonHtml`, `costErrorHtml`, `costShowError`) so the
    Node test can load `costsettings.js` the way the browser does (additive).
16. **Ports 9200–9399** for the spawned servers of `test/cost-settings-api.test.js`.

## Spec points that do not fit, for the owner

None. Every requirement of the spec maps to the code as it is; the additions above (`keys`, `total`, `next`,
`nocase`) are additive and do not change an existing answer.

## Self-review

**Spec coverage** (spec section → task):
- Decisions table: one sub-page with four panels and per-panel Save sending only its fields → Task 5 (`costSetBody`,
  `costSetSave`, tests); restate preview first, reason and confirmation, history → Tasks 2, 4, 8; server preview of
  rules with test path → Tasks 3, 4, 6; new browser file, pure server module, three routes, costview gains only the
  entry and mount → Tasks 3–6; "applies forward" note and Restate link with this month to yesterday → Tasks 5, 8; ids
  fixed after save → Task 6; rates by hand → Task 7.
- Section 1 (navigation, control bar, loading, quiet refresh off, drafts, Discard, beforeunload, settings that do not
  read with banner, disabled Saves and restate, previews still working, `reasons`) → Task 5 (and Task 4 for `reasons`,
  Task 8 for the restate's lock).
- Section 2 (centers table with Used by, Add, id from name, read-only after Save, Delete rules, 50 limit; gateway keys
  with "Folder rules decide", gone keys with Remove, the "key wins" line; ordered rules with Up/Down/Delete, Add, 100
  limit, order and glob lines; preview at 400 ms with stale guard, Moves (50, "and N more", "No project or key changes
  center."), rule warnings with their wording, Unassigned (20) with Create rule (glob, focus, scroll), Test a path, 400
  reasons with Save enabled, moves from saved vs draft only; Save with the re-read and the note) → Tasks 3, 4, 6, 5.
- Section 3 (billing rows with labels, Metered/Plan, three plan fields with limits, the explanation line, missing
  source as Metered, every source written out, the note) → Task 7, Task 5 (body, note).
- Section 4 (USD only / display currency, code, rates table with Add/Delete, 1000 limit, sorted on save, today's rate
  line by the `rateFor` rule, the read-time note, 409 reasons) → Task 7, Task 5 (409 with Open Budgets).
- Section 5 (explanation; range default incl. the 1st of a month; checks in the server's words; preview with rows, usage
  value, center moves, prices, billing, no-change text; confirm with reason, checkbox, Run gating, staleness by range
  and by Save; run and "Restated: N rows"; history with columns, empty text, escaped reason) → Task 8, Tasks 2–4.
- Section 6 (`restateRows`/`restate` split, `peek`, `restatePreview`, `corrections`, `preview.js`, the routes and their
  rules, demo, front end, styles under `.cost-set-`) → Tasks 1–5, 9.
- Error handling (400 list and field marks, 409 budgets with Open Budgets, 409 CONFIG_BROKEN, preview failure with
  Retry, restate path-free errors and 503 wording, stale guards, drafts never cleared by a failure) → Tasks 5, 6, 8, 4.
- Privacy (answers hold `~` folders, key ids and names, center names, numbers, restate reasons; esc everywhere) →
  Global Constraints, Task 4 (path-free tests), Task 8 (audit).
- Testing list → Task 1 (`restateRows`, `peek`), Task 2 (`restatePreview` refusals, nothing written, rows equal;
  `corrections` order, cap, 503), Task 3 (every listed `settingsPreview` and `restateSummary` case), Task 4 (401, gateway
  key, unknown fields, invalid draft, 400 today and > 400 days, 409, 503, path-free, demo, `reasons`), Tasks 5–8 (id
  from name, request bodies, disabled Saves, today's rate against `rateFor`, default range incl. the 1st, staleness,
  Delete disabled, Create rule glob, esc audit).
- Docs → Task 9.

**Placeholder scan:** no "TBD", "TODO", "similar to Task N" or "add validation"; every code step shows the code or the
exact replacement with its location.

**Type consistency:** `restateRows` (Task 1) returns `[{ key, before, after }]`, which `restatePreview` (Task 2)
returns as `rows` and `restateSummary` (Task 3) sums; `restatePreview`'s `{ total, versionsBefore, version, newPrices,
billing }` are the fields `restateSummary` reads and the route spreads (Task 4), and the page reads `changed`, `total`,
`beforeUSD`, `afterUSD`, `moves`, `versionsBefore`, `version`, `newPrices`, `billing` (Task 8). `settingsPreview`'s
`moves[].{ project, keyId, keyName, listUSD, from, to }`, `more`, `rules[].{ index, status, by }`, `unassigned`,
`test.{ center, rule }` (Task 3) are what `costSetPreviewHtml`, `costSetWarnText` and `costSetTestHtml` read (Task 6).
`corrections()`'s `{ ts, from, to, reason, priceVersion, rows, billing }` (Task 2) is what `costSetHistoryHtml` reads
(Task 8). Draft paths written by `costSetField` (`centers.i.name`, `folderRules.i.center`, `keyCenters.<id>`,
`billing.<source>.feeUSD`, `currency.rates.i.perUSD`) are the paths `costSetReasonPaths` makes from the server's reasons
and `costSetAssign` sets. The registries filled in Tasks 6–8 (`COST_SET_BODIES`, `COST_SET_ACTIONS`,
`COST_SET_ON_INPUT`, `COST_SET_ON_CHANGE`, `COST_SET_ON_OPEN`, `COST_SET_ON_LOAD`) are the ones Task 5 declares and
calls.

