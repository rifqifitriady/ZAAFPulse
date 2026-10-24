# Cost Control 1: Cost Ledger, Attribution and Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One durable daily cost record that every later Cost Control sub-project reads:
- the same pricing formula for every source;
- cost frozen at the price of its day;
- attributed to a cost center;
- split into what was paid (`billedUSD`) and what the use was worth (`listUSD`).

**Architecture:**
- **Collectors.** `lib/cost/collect.js` turns three raw inputs into normalized usage events: the log index (Claude Code, Codex), `.data/gateway-usage.jsonl`, and a new `.data/cost/judge-calls.jsonl`. The gateway log already holds plain requests, dataset replay, collaboration runs and external judge calls. The judge-call file holds only the judge calls that never went through the gateway.
- **Pricing.** Every event is priced with the existing `makePricer` (`lib/pricing.js`). A price version table (`lib/cost/prices.js`) records the effective pricing each time it changes, so `versionFor(day)` gives the prices in force on any day.
- **Settings and attribution.** `lib/cost/rules.js` validates `config.json` → `cost` and attributes rows to cost centers: the key's center first, then the first folder glob that matches, else `Unassigned`.
- **Store.** `lib/cost/ledger.js` keeps monthly JSONL files of daily rows plus `corrections.jsonl`, and builds the reader's view with corrections applied.
- **Pass.** `lib/cost/index.js` (`createCost`) runs one pass after each index refresh. Today's rows are rewritten; past days only grow by late events; plan fees are spread per day.
- **API.** `lib/cost/api.js` serves `/api/cost/*` behind the dashboard sign-in. Demo mode serves a synthetic ledger held in memory.

**Tech Stack:** Node ≥18 standard library only (CommonJS), `node:test`. No UI in this sub-project.

**Spec:** `docs/superpowers/specs/2026-10-23-cost-ledger-design.md`. Builds on Monitors (#40), Datasets (#41) and the follow-ups (#49, the hardened `saveConfigSection`).

**Line numbers** below are on `feat/cost-ledger` at `3737e55`. Re-read each location before editing it.

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test`. Plain browser JS in `public/` (this sub-project touches no page).
- **Text only (S1).** No page changes here. If any UI is touched later, content renders as text only (`textContent` / `esc()`), with no `innerHTML` built from data. CSP stays `script-src 'self'`.
- **Privacy.**
  - The ledger, the judge-call log, cursors and price versions hold numbers, model, provider, key and agent names, and project folders only. They never hold prompt, response or tool text.
  - Project folders are stored and shown with the home folder as `~` and forward slashes (`tilde()` from `lib/logroots.js`).
  - No new outbound connection. Currency rates are entered by the owner.
- **Files.**
  - Everything lives under `.data/cost/` (`ZAAFPULSE_DATA` decides where `.data` is).
  - Folders are mode 0700 and files 0600.
  - Every rewrite is atomic: a unique temp file `<file>.<pid>.<6 random bytes hex>.tmp`, written with `{ mode: 0o600, flag: 'wx' }`, then renamed (the same hardening as `saveConfigSection`, `server.js:258-294`).
  - Appends use `fs.appendFileSync(file, line, { mode: 0o600 })`.
  - Mode assertions are skipped on Windows.
- **Routes.**
  - Every `/api/cost/*` route needs the dashboard sign-in. A gateway API key, MCP or A2A is never accepted.
  - A state change needs `content-type: application/json` (415 otherwise).
  - Error messages are free of paths: thrown messages are scrubbed with `PATHLIKE` from `lib/monitors/api.js`, and collector errors are fixed phrases plus an error code.
- **Unchanged behaviour.** These stay exactly as they are:
  - existing pages;
  - the gateway's own `usage.cost`, the key budget (`checkBudget`, 402) and `monthSpend`;
  - Monitors;
  - the evals caps and `chargeOf`.

  The ledger prices gateway lines with `makePricer` for itself. It does **not** change how the gateway prices or records a request in this sub-project.
- **OmniRoute** is not read (spec decision: it would count routed traffic twice).
- **Tests** never call a real provider or the network. Spawned servers run with `NO_JUDGE_PORTS` and a `config.json` that has `"pricingSync": { "enabled": false }`, so the live price list is never fetched.
- **Housekeeping.**
  - Prettier style by hand (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Write short "why" comments.
  - Commits carry **no `Co-Authored-By`, no "Generated with", no AI attribution of any kind**.
  - CI runs on Ubuntu, macOS and Windows.
- **Shared files.** These may be touched by other branches. Edits to them are small and additive (new lines in their own block, new map or export entries, no reordering): `server.js`, `lib/demo.js`, `lib/evals/engine.js`, `lib/evals/claude-cli.js`, `test/evals-engine.test.js`, `test/evals-claude-cli.test.js`, `test/evals-models.test.js`.

## Rules and values

**R1. Sources and kinds.** `SOURCES = ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab']`. Every call is counted by exactly one collector:

| Raw record | Collector | `source` | `kind` | `agent` |
|---|---|---|---|---|
| Claude Code transcript event (deduplicated) | local | `claude` | `chat` | `null` |
| Codex rollout event | local | `codex` | `chat` | `null` |
| gateway line with a `runId` | gateway | `collab` | `run` | line's `agent` |
| gateway line, `agent: 'judge'`, no `runId` | gateway | `judge` | `judge` | `null` |
| gateway line, `agent: 'replay'`, no `runId` | gateway | `replay` | `replay` | `null` |
| any other gateway line | gateway | `gateway` | `chat` / `embed` (line kind `embeddings`) / `agent` | line's `agent` |
| `judge-calls.jsonl` line (Ollama, LM Studio, Claude Code CLI judge) | judge | `judge` | `judge` | `null` |
| plan fee | plan step | the source on a plan | `plan` | `null` |

- A gateway line with no input and no output tokens (a failed attempt) is skipped.
- `keyId: 'dashboard'` is stored as `null`.
- Experiment records (`.data/experiments.jsonl`) and run totals in `runs.json` are **never read**: they repeat gateway lines.

**R2. Ledger row** (one per day and key tuple):

```
{ day, source, provider, model, project, center, keyId, agent, kind, geo, plan,
  requests, tokens: { in, out, cacheRead, cacheWrite5m, cacheWrite1h }, webSearches,
  listUSD, billedUSD, priceVersion, unpriced, estimated, free, backfilled }
```

These fields go beyond the spec's row:
- `geo` (`'us'` or `null`), so a restate can apply the 1.1× US rate;
- `plan` (the plan name on a plan row, else `null`);
- `free` (a model on the owner's own hardware: `listUSD` 0 and **not** unpriced).

Other field rules:
- `model` is `normalizeModel(name)`: for the gateway, of `routedTo || model`.
- `provider` is `anthropic` for `claude`, `openai` for `codex`, the gateway provider id for gateway lines, and the judge's provider (`ollama`, `lmstudio`, `claude-code`) for judge-call lines.

**R3. Row key.** `KEY_FIELDS = ['day','source','provider','model','project','center','keyId','agent','kind','geo','plan']`.
- `rowKey(r) = JSON.stringify(KEY_FIELDS.map((f) => r[f] ?? null))`.
- `baseKey` is the same without `center`. A late event on a closed day looks its row up by `baseKey`, so the day keeps its center.

**R4. Day.** `YYYY-MM-DD` in the machine's local time zone. Each timestamp is epoch milliseconds (UTC instants from logs and the gateway) turned into a day with `Date` getters, as `lib/aggregate.js` `dayKey` does.

**R5. Settings** (`config.json` → `cost`; defaults `{ centers: [], keyCenters: {}, folderRules: [], billing: {}, currency: null }`):

| Field | Rule | Error text (prefix) |
|---|---|---|
| top level | only the five fields | `unknown field: <name>` |
| `centers` | list, at most 50; `id` matches `^[a-z0-9][a-z0-9-]{0,39}$`, unique, not `unassigned`; `name` 1–60 chars after trim | `centers[i].id: …`, `centers[i].name: …` |
| `keyCenters` | object, at most 1000; key matches `^[A-Za-z0-9_-]{1,64}$`; value a known center id | `keyCenters.<key>: unknown cost center` |
| `folderRules` | list, at most 100; `glob` per R6; `center` a known center id; order kept | `folderRules[i].glob: <why>`, `folderRules[i].center: unknown cost center` |
| `billing` | keys in `SOURCES`; value `{ mode: 'metered' }` (no other field) or `{ mode: 'plan', plan (1–60 chars), feeUSD (0–1e6), period: 'month' \| 'year' }` | `billing.<source>…` |
| `currency` | `null`, or `{ code: ^[A-Z]{3}$, not 'USD', rates: [{ from: real day, perUSD: >0 and ≤1e9 }] }` with at most 1000 rates and unique `from`; rates are stored sorted by `from` | `currency.code: …`, `currency.rates[i].…` |

- At most 50 error strings are returned.
- An invalid saved section means the defaults apply. The status then says `the saved cost settings are invalid, so the defaults apply`.

**R6. Glob syntax** (zero dependencies, `globToRegExp`):
- **Matching.** A glob is matched against the project as stored (`~/…`, forward slashes). The whole string must match.
- **Wildcards:**
  - `*` matches any run of characters except `/`;
  - `?` matches one character except `/`;
  - `**/` matches zero or more whole folders;
  - `**` elsewhere matches anything, including `/`;
  - a trailing `/**` matches the folder itself or anything under it, so `~/work/**` matches `~/work`.
- **Literals.** Every other character is literal. There are no character classes or braces: `[`, `]`, `{` and `}` are literal.
- **Saving.**
  - Backslashes become `/`.
  - A glob that starts with the home folder is rewritten to start with `~`.
  - A glob must start with `~` (followed by `/` or nothing), `/`, `*` or a drive like `C:/`.
- **Refused globs:**
  - empty;
  - longer than 300 characters;
  - holding a control character;
  - holding `***`.
- **Case.** Matching ignores case on macOS and Windows and respects it elsewhere. Tests pass `nocase` explicitly.

**R7. Attribution.** The cost center is the first of these that applies:
1. `keyCenters[keyId]`;
2. the first `folderRules` entry whose glob matches `project`;
3. `unassigned`.

Plan rows have `center: null`.

**R8. Billing.**
- Metered: `billedUSD = listUSD`.
- Plan: usage rows have `billedUSD = 0`, and one plan row per day carries `billedUSD = feeUSD / daysInMonth(day)` (period `month`) or `feeUSD / daysInYear(day)` (period `year`). Value received is the source's `listUSD`; paid is its plan rows' `billedUSD`.
- Today and backfilled days use the current settings.
- A closed day keeps the mode it had: a late event on it is billed as `plan` when that day has a plan row for the source, else as `metered`.

**R9. Price versions.**
- **Shape.** `{ id (1, 2, …), from (day), at (ms), hash (first 16 hex of SHA-256 of key-sorted JSON), changed (sorted keys, at most 100), changedCount }`.
- **Recording.** A version is recorded when a pass sees an effective pricing (`config.pricing`) whose hash differs from the latest version's. The check is memoized by object identity, and `from` is that day.
- **Clock going back.** `from` is never earlier than the previous version's `from`.
- **Lookup.** `versionFor(day)` returns the newest version with `from <= day`. A day before the first version gets the first version, which is how the history read on the first run is priced with "today's" prices.
- **Files.** `.data/cost/prices/versions.json` (`{ version: 1, versions }`) and `.data/cost/prices/<id>.json` (that version's full pricing).

**R10. Open and closed days.**
- **Today is open.**
  - Local rows for today are rebuilt from all of today's events whenever a log file changed or the price version changed.
  - Gateway and judge lines are priced when read. A same-day price change applies to lines read after it.
  - After the collectors, every row of today takes the current center and billing (`retagToday`).
- **A past day is closed.** It changes only:
  - by late local events: a recomputed row replaces the stored one only when it has more requests or more tokens, so a closed day never shrinks when logs are deleted;
  - by late gateway or judge lines, which are added to it;
  - through a restate.

  Late events are priced with `versionFor(thatDay)`.
- **Backfill.** A day before `firstDay` (the local day of the ledger's first pass, kept in `cursors.json`) is `backfilled: true`.

**R11. Cursors** (`.data/cost/cursors.json`, `{ version: 1, firstDay, local: { at }, gateway: { head, offset, at }, judge: { head, offset, at }, plans: { <source>: { lastDay } } }`):
- **`head`** names a file by the SHA-256 (16 hex) of its first line (first 4096 bytes). It is `null` while the file has no complete line.
- **Reading a log:**
  - The same head: read from `offset`; if the file is now shorter than `offset`, read it from 0.
  - Otherwise, if `<file>.1` has the cursor's head (a rotation by `lib/gateway/store.js` at 10 MB): read `<file>.1` from `offset`, then the new file from 0.
  - Otherwise: read the file from 0.
  - With no cursor at all (the first run): read `<file>.1` and the file from 0.
- **Lines.** Only complete lines count; a torn last line waits for the next pass.
- **Local collector.** It keeps no byte cursor. It remembers each indexed file's `mtimeMs:size` in memory, and after a restart one full comparison pass writes only growth.

**R12. Plan step** (after the collectors).

For each source on a plan:
1. The first day is `plans[source].lastDay + 1`. With no `lastDay`, it is the source's earliest usage day in the ledger, or today.
2. From that day through today, add a plan row for each day that has none.
3. Today's plan row is always replaced with the current plan and fee.

For each source not on a plan, today's plan row is removed. `plans[source].lastDay` becomes today for every source on every pass.

**R13. Restate** (`POST /api/cost/restate { from, to, reason, confirm: true }`):
- **Accepted input:**
  - `from ≤ to < today`; today already follows the current prices and rules;
  - at most 400 days;
  - `reason` 1–200 characters.
- **Pricing.** Each non-plan row in the range (as the reader sees it, corrections applied) is re-priced with the current version's pricer, using the row's average request: `parts(model, tokens/requests…, { ws: webSearches/requests, geo }) × requests`. A free row stays 0, and an unpriced model gives 0 with `unpriced: true`.
- **Re-attribution.** Each row is re-attributed (R7) and re-billed (R8 with current modes).
- **Plan rows:**
  - each plan row in the range is re-billed with the current mode (0 when its source is no longer on a plan);
  - every day of a source now on a plan that has no plan row gets one, as `{ before: null, after, row }`.
- **The correction.** One correction `{ ts, from, to, reason, priceVersion, rows: [{ key, before: { listUSD, billedUSD, priceVersion, center, unpriced } | null, after: {…}, row? }] }` is appended to `.data/cost/corrections.jsonl`, even when `rows` is empty. Stored rows are never rewritten.
- **Readers** apply corrections in order:
  - `before: null` adds `row` (when its day is in range);
  - otherwise `listUSD += after.listUSD - before.listUSD`, `billedUSD += after.billedUSD - before.billedUSD`, and `priceVersion`, `center`, `unpriced` come from `after`.

  Events added to a corrected row later still count on top.

**R14. Currency.**
- The ledger is USD.
- `?currency=<code>` must be `USD` or the configured code (else 400).
- Each row is converted with the latest rate whose `from <= row.day`.
- A row whose day has no such rate makes its group's (and the totals') `list` and `billed` `null`. That day is counted in `missingRate`.

**R15. API.** USD amounts are rounded to 8 decimals in responses, converted amounts to 4.

| Route | Answer |
|---|---|
| `GET /api/cost/ledger?from&to&groupBy&currency` | `{ from, to, groupBy, currency, rows, totals: { requests, listUSD, billedUSD, list?, billed? }, missingRate, corrections }` |
| `GET /api/cost/status` | `{ demo, collectors: { local, gateway, judge: { sources, at, read, total, error } }, priceVersion: { id, from, hash } \| null, unpriced: { rows, requests }, backfill: { firstDay, rows }, settings: { error }, ledger: { badLines, corrections, error } }` |
| `GET /api/cost/settings` | `{ settings, error, sources, unassigned: 'unassigned', keys: [{ id, name }] }` |
| `POST /api/cost/settings` | 200 `{ settings }` (normalized) or 400 `{ error: 'invalid cost settings', reasons }` |
| `GET /api/cost/prices/versions` | `{ current, versions: [{ id, from, at, hash, changed, changedCount }] }` |
| `POST /api/cost/restate` | 200 `{ correction }` |

- `/api/cost/ledger` defaults: `to` = today, `from` = the first of `to`'s month, `groupBy=day`.
- `groupBy` is 1–4 distinct names from `DIMS = ['day','source','provider','model','project','center','keyId','agent','kind']`.
- A range is at most 400 days.
- Grouped rows carry `requests, tokens, webSearches, listUSD, billedUSD, unpriced, estimated, backfilled` (the flags are "any row"). With a currency they also carry `list` and `billed`.
- Rows are sorted by `day` ascending, then by `listUSD + billedUSD` descending.
- Statuses:
  - an unknown `/api/cost/*` path is 404 and a wrong method 405;
  - a body that is not a JSON object is 400, and one over the body limit 413;
  - a thrown status error keeps its status with a scrubbed message;
  - anything else is 500 `cost request failed`.

**R16. Collector errors** in the status are fixed phrases plus the error code:
- `the log index could not be read (CODE)`;
- `the gateway log could not be read (CODE)`;
- `the judge call log could not be read (CODE)`;
- `the ledger could not be written (CODE)`;
- `the price versions could not be written (CODE)`.

A failing collector does not stop the others.

## File map

| File | Status | Responsibility | Shared |
|---|---|---|---|
| `lib/cost/days.js` | create | local days: `dayOf`, `isDay`, `addDays`, `monthOf`, `daysInMonth`, `daysInYear`, `daysBetween` | |
| `lib/cost/rules.js` | create | settings validation, globs, attribution, plan fee, rates | |
| `lib/cost/files.js` | create | `writePrivate` (atomic 0600), `appendPrivate`, `readJson` | |
| `lib/cost/prices.js` | create | price versions, `versionFor`, `pricerFor` | |
| `lib/cost/collect.js` | create | normalized events from the three inputs, `priceEvent` (the shared pricer), `readNew` (cursor reader) | |
| `lib/cost/ledger.js` | create | row helpers, the store (months, `.bad`, corrections), reader view, `groupRows`, `restate` | |
| `lib/cost/index.js` | create | `createCost`: the pass, plans, retag, status, query, restate, judge-call recording, demo seeding | |
| `lib/cost/api.js` | create | `/api/cost/*` | |
| `lib/evals/engine.js` | modify | `onCall` option: report each answered judge call (kind, provider, model, usage) | yes |
| `lib/evals/claude-cli.js` | modify | usage also carries `cacheRead`, `cacheWrite` | yes |
| `lib/demo.js` | modify | `costDemo()` | yes |
| `server.js` | modify | wiring, route block, pass after each index refresh | yes |
| `docs/cost.md` | create | owner docs for the ledger, settings and API | |
| `test/cost-rules.test.js`, `test/cost-prices.test.js`, `test/cost-collect.test.js`, `test/cost-ledger.test.js`, `test/cost-pass.test.js`, `test/cost-restate.test.js`, `test/cost-api.test.js` | create | tests | |
| `test/evals-engine.test.js`, `test/evals-claude-cli.test.js`, `test/evals-models.test.js` | modify | `onCall` tests; the two Claude Code usage assertions gain the new fields | yes |

---

### Task 1: Days, settings validation, globs and attribution

**Files:**
- Create: `lib/cost/days.js`, `lib/cost/rules.js`
- Test: `test/cost-rules.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `days.js`: `dayOf(ts) → 'YYYY-MM-DD'`, `isDay(s) → boolean`, `addDays(day, n) → day`, `monthOf(day) → 'YYYY-MM'`, `daysInMonth(day) → n`, `daysInYear(day) → 365|366`, `daysBetween(from, to) → [day]` (inclusive, `[]` when from > to).
  - `rules.js`:
    - `SOURCES`, `UNASSIGNED = 'unassigned'`, `LIMITS`, `defaults()`;
    - `globToRegExp(glob, { nocase }) → RegExp`, `globProblem(glob) → string | null`, `normalizeGlob(glob, home) → string`;
    - `validate(input, { home }) → { ok: true, value } | { ok: false, errors: [string] }`;
    - `settingsOf(raw, { home }) → { value, error }`;
    - `compile(settings, { nocase }) → { centerOf({ keyId, project }) → centerId, billingOf(source) → billing }`;
    - `planFee(billing, day) → USD`;
    - `rateFor(currency, day) → perUSD | null`.

- [ ] **Step 1: Write the failing test**

```js
// test/cost-rules.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const D = require('../lib/cost/days');
const R = require('../lib/cost/rules');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('days: local calendar days, real dates only, month and year lengths', () => {
  assert.equal(D.dayOf(new Date(2026, 9, 22, 23, 59).getTime()), '2026-10-22');
  assert.equal(D.isDay('2026-02-28'), true);
  assert.equal(D.isDay('2026-02-30'), false);
  assert.equal(D.isDay('2026-2-01'), false);
  assert.equal(D.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(D.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(D.monthOf('2026-10-22'), '2026-10');
  assert.equal(D.daysInMonth('2026-02-10'), 28);
  assert.equal(D.daysInMonth('2026-10-10'), 31);
  assert.equal(D.daysInYear('2026-06-01'), 365);
  assert.equal(D.daysInYear('2028-06-01'), 366);
  assert.deepEqual(D.daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(D.daysBetween('2026-10-02', '2026-10-01'), []);
});

test('globs: * stays in one folder, ** crosses folders, a trailing /** includes the folder, the rest is literal', () => {
  const m = (glob, p, nocase = false) => R.globToRegExp(glob, { nocase }).test(p);
  assert.equal(m('~/work/**', '~/work'), true);
  assert.equal(m('~/work/**', '~/work/acme/api'), true);
  assert.equal(m('~/work/**', '~/workshop'), false);
  assert.equal(m('~/work/*', '~/work/acme'), true);
  assert.equal(m('~/work/*', '~/work/acme/api'), false);
  assert.equal(m('~/work/*', '~/work'), false);
  assert.equal(m('~/work/**/api', '~/work/api'), true);
  assert.equal(m('~/work/**/api', '~/work/a/b/api'), true);
  assert.equal(m('~/work/**/api', '~/work/apix'), false);
  assert.equal(m('~/w?rk', '~/work'), true);
  assert.equal(m('~/w?rk', '~/w/rk'), false);
  assert.equal(m('~/a.b', '~/axb'), false, 'a dot is literal');
  assert.equal(m('~/x[1]', '~/x[1]'), true, 'brackets are literal');
  assert.equal(m('~/Work/**', '~/work/a'), false);
  assert.equal(m('~/Work/**', '~/work/a', true), true);
  assert.equal(R.globProblem('~/work/**'), null);
  assert.equal(R.globProblem('C:/src/**'), null);
  assert.equal(R.globProblem('**/api'), null);
  assert.match(R.globProblem(''), /empty/);
  assert.match(R.globProblem('work/**'), /starts with/);
  assert.match(R.globProblem('~/a/***'), /three stars/);
  assert.match(R.globProblem('~/a\u0001'), /control character/);
  assert.match(R.globProblem('~/' + 'a'.repeat(300)), /longer than 300/);
  assert.equal(R.normalizeGlob(`${HOME}${path.sep}work${path.sep}**`, HOME), '~/work/**');
});

test('validate: a full valid section is normalized', () => {
  const r = R.validate(
    {
      centers: [{ id: 'acme', name: '  Acme  ' }, { id: 'lab', name: 'Lab' }],
      keyCenters: { key_0123456789ab: 'acme' },
      folderRules: [{ glob: `${HOME}/work/acme/**`, center: 'acme' }, { glob: '~\\lab\\**', center: 'lab' }],
      billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 200, period: 'month' }, codex: { mode: 'metered' } },
      currency: { code: 'IDR', rates: [{ from: '2026-10-22', perUSD: 16500 }, { from: '2026-10-01', perUSD: 16000 }] },
    },
    { home: HOME },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    centers: [{ id: 'acme', name: 'Acme' }, { id: 'lab', name: 'Lab' }],
    keyCenters: { key_0123456789ab: 'acme' },
    folderRules: [{ glob: '~/work/acme/**', center: 'acme' }, { glob: '~/lab/**', center: 'lab' }],
    billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 200, period: 'month' }, codex: { mode: 'metered' } },
    currency: { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 16000 }, { from: '2026-10-22', perUSD: 16500 }] },
  });
  assert.deepEqual(R.validate({}).value, R.defaults());
});

test('validate: every bad field is named', () => {
  const r = R.validate({
    extra: 1,
    centers: [{ id: 'Bad Id', name: 'x' }, { id: 'unassigned', name: 'x' }, { id: 'a', name: 'A' }, { id: 'a', name: 'B' }, { id: 'b', name: '' }],
    keyCenters: { key_x: 'nope', 'bad key!': 'a' },
    folderRules: [{ glob: 'work/**', center: 'a' }, { glob: '~/x/**', center: 'nope' }],
    billing: { omniroute: { mode: 'metered' }, claude: { mode: 'plan', plan: 'Max', period: 'month' }, codex: { mode: 'plan', plan: 'P', feeUSD: 1, period: 'week' } },
    currency: { code: 'IDR', rates: [{ from: '2026-13-01', perUSD: 1 }, { from: '2026-10-01', perUSD: 0 }] },
  });
  assert.equal(r.ok, false);
  for (const want of [
    'unknown field: extra',
    'centers[0].id: lower-case letters, digits and dashes, up to 40',
    'centers[1].id: "unassigned" is reserved',
    'centers[3].id: a is used twice',
    'centers[4].name: 1 to 60 characters',
    'keyCenters.key_x: unknown cost center',
    'keyCenters: bad key id bad key!',
    'folderRules[0].glob: starts with ~, /, * or a drive letter like C:/',
    'folderRules[1].center: unknown cost center',
    'billing: unknown source omniroute',
    'billing.claude.feeUSD: a number from 0 to 1,000,000',
    'billing.codex.period: month or year',
    'currency.rates[0].from: a date YYYY-MM-DD',
    'currency.rates[1].perUSD: a number above 0',
  ])
    assert.ok(r.errors.includes(want), `missing: ${want}\n${r.errors.join('\n')}`);
  assert.match(R.validate({ currency: { code: 'idr', rates: [] } }).errors[0], /three capital letters/);
  assert.match(R.validate({ currency: { code: 'USD', rates: [] } }).errors[0], /kept in USD/);
  assert.match(R.validate([]).errors[0], /must be an object/);
});

test('settingsOf: nothing saved is the defaults; an invalid saved section is the defaults with an error', () => {
  assert.deepEqual(R.settingsOf(undefined), { value: R.defaults(), error: null });
  const bad = R.settingsOf({ centers: 'nope' });
  assert.deepEqual(bad.value, R.defaults());
  assert.match(bad.error, /invalid, so the defaults apply/);
});

test('attribution: the key first, then the first matching folder rule, then Unassigned', () => {
  const centers = [{ id: 'acme', name: 'A' }, { id: 'work', name: 'W' }, { id: 'lab', name: 'L' }];
  const first = R.compile(
    {
      ...R.defaults(),
      centers,
      keyCenters: { key_a: 'lab' },
      folderRules: [{ glob: '~/work/acme/**', center: 'acme' }, { glob: '~/work/**', center: 'work' }],
    },
    { nocase: false },
  );
  assert.equal(first.centerOf({ keyId: 'key_a', project: '~/work/acme' }), 'lab', 'the key wins over a folder');
  assert.equal(first.centerOf({ keyId: 'key_other', project: '~/work/acme/api' }), 'acme');
  assert.equal(first.centerOf({ keyId: null, project: '~/work/blog' }), 'work');
  assert.equal(first.centerOf({ keyId: null, project: '~/play' }), 'unassigned');
  assert.equal(first.centerOf({ keyId: null, project: null }), 'unassigned');
  const swapped = R.compile(
    { ...R.defaults(), centers, folderRules: [{ glob: '~/work/**', center: 'work' }, { glob: '~/work/acme/**', center: 'acme' }] },
    { nocase: false },
  );
  assert.equal(swapped.centerOf({ keyId: null, project: '~/work/acme/api' }), 'work', 'first match wins');
  assert.deepEqual(first.billingOf('claude'), { mode: 'metered' });
});

test('plan fee per day, and the rate of a day', () => {
  near(R.planFee({ mode: 'plan', plan: 'P', feeUSD: 310, period: 'month' }, '2026-10-05'), 10);
  near(R.planFee({ mode: 'plan', plan: 'P', feeUSD: 280, period: 'month' }, '2026-02-05'), 10);
  near(R.planFee({ mode: 'plan', plan: 'P', feeUSD: 365, period: 'year' }, '2026-02-05'), 1);
  near(R.planFee({ mode: 'plan', plan: 'P', feeUSD: 366, period: 'year' }, '2028-02-05'), 1);
  const cur = { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 16000 }, { from: '2026-10-22', perUSD: 16500 }] };
  assert.equal(R.rateFor(cur, '2026-10-21'), 16000);
  assert.equal(R.rateFor(cur, '2026-10-22'), 16500);
  assert.equal(R.rateFor(cur, '2026-09-30'), null);
  assert.equal(R.rateFor(null, '2026-10-22'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-rules.test.js`
Expected: FAIL with `Cannot find module '../lib/cost/days'`.

- [ ] **Step 3: Write `lib/cost/days.js`**

```js
// Local calendar days (YYYY-MM-DD in this machine's time zone): the day boundary the Overview uses (lib/aggregate.js).
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The shape, and a date that exists (no 2026-02-30).
function isDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

// Calendar arithmetic at local noon, so a daylight-saving change never skips or repeats a day.
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d + n, 12).getTime());
}

const monthOf = (day) => day.slice(0, 7);

function daysInMonth(day) {
  const [y, m] = day.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function daysInYear(day) {
  const y = Number(day.slice(0, 4));
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}

// Every day from `from` to `to`, both included.
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

module.exports = { dayOf, isDay, addDays, monthOf, daysInMonth, daysInYear, daysBetween };
```

- [ ] **Step 4: Write `lib/cost/rules.js`**

```js
// The owner's cost settings (config.json "cost"): cost centers, which gateway keys and project folders belong to each,
// how each source is billed (metered, or a plan with a fixed fee), and the display currency with its dated rates.
// Validation lives here, and so does attribution: a key's center first, then the first folder rule whose glob matches
// the project, else Unassigned.
const { isDay, daysInMonth, daysInYear } = require('./days');

const SOURCES = ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab'];
const UNASSIGNED = 'unassigned';
const LIMITS = { centers: 50, keyCenters: 1000, folderRules: 100, rates: 1000, glob: 300, name: 60, plan: 60 };
const FIELDS = ['centers', 'keyCenters', 'folderRules', 'billing', 'currency'];
const CENTER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
// A glob names folders from the top: ~ (the home folder), /, a drive letter, or a leading wildcard.
const GLOB_START = /^(?:~(?:\/|$)|\/|\*|[A-Za-z]:\/)/;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clip = (s) => String(s).slice(0, 40);
const defaults = () => ({ centers: [], keyCenters: {}, folderRules: [], billing: {}, currency: null });

// Glob → RegExp, matched against a whole project path written with ~ and forward slashes. * stays inside one folder,
// ? is one character, **/ is zero or more folders, ** elsewhere is anything, and a trailing /** also matches the folder
// itself. Everything else is literal (no classes or braces), so a folder name with [ or { needs no escaping.
function globToRegExp(glob, { nocase = false } = {}) {
  let src = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      src += '(?:/.*)?';
      i += 3;
    } else if (glob.startsWith('**/', i)) {
      src += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      src += '.*';
      i += 2;
    } else {
      const c = glob[i];
      src += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${src}$`, nocase ? 'i' : '');
}

function globProblem(glob) {
  if (!glob) return 'empty';
  if (glob.length > LIMITS.glob) return `longer than ${LIMITS.glob} characters`;
  if (/[\x00-\x1f]/.test(glob)) return 'holds a control character';
  if (glob.includes('***')) return 'three stars in a row';
  if (!GLOB_START.test(glob)) return 'starts with ~, /, * or a drive letter like C:/';
  return null;
}

// The glob as stored: forward slashes, and the home folder written as ~ (projects are matched in that form).
function normalizeGlob(glob, home) {
  const g = String(glob).replace(/\\/g, '/');
  const h = String(home || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return h && (g === h || g.startsWith(h + '/')) ? '~' + g.slice(h.length) : g;
}

function validate(input, { home = '' } = {}) {
  if (!isObject(input)) return { ok: false, errors: ['cost settings must be an object'] };
  const errors = [];
  const out = defaults();
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) errors.push(`unknown field: ${clip(k)}`);

  const centers = input.centers ?? [];
  if (!Array.isArray(centers)) errors.push('centers must be a list');
  else if (centers.length > LIMITS.centers) errors.push(`at most ${LIMITS.centers} cost centers`);
  else
    centers.forEach((c, i) => {
      const id = isObject(c) && typeof c.id === 'string' ? c.id : '';
      const name = isObject(c) && typeof c.name === 'string' ? c.name.trim() : '';
      if (!CENTER_ID.test(id)) errors.push(`centers[${i}].id: lower-case letters, digits and dashes, up to 40`);
      else if (id === UNASSIGNED) errors.push(`centers[${i}].id: "unassigned" is reserved`);
      else if (out.centers.some((x) => x.id === id)) errors.push(`centers[${i}].id: ${id} is used twice`);
      else if (!name || name.length > LIMITS.name) errors.push(`centers[${i}].name: 1 to ${LIMITS.name} characters`);
      else out.centers.push({ id, name });
    });
  const known = (id) => typeof id === 'string' && out.centers.some((c) => c.id === id);

  const kc = input.keyCenters ?? {};
  if (!isObject(kc)) errors.push('keyCenters must be an object');
  else if (Object.keys(kc).length > LIMITS.keyCenters) errors.push(`keyCenters: at most ${LIMITS.keyCenters} keys`);
  else
    for (const [key, center] of Object.entries(kc)) {
      if (!KEY_ID.test(key)) errors.push(`keyCenters: bad key id ${clip(key)}`);
      else if (!known(center)) errors.push(`keyCenters.${key}: unknown cost center`);
      else out.keyCenters[key] = center;
    }

  const rules = input.folderRules ?? [];
  if (!Array.isArray(rules)) errors.push('folderRules must be a list');
  else if (rules.length > LIMITS.folderRules) errors.push(`at most ${LIMITS.folderRules} folder rules`);
  else
    rules.forEach((r, i) => {
      const glob = normalizeGlob(isObject(r) && typeof r.glob === 'string' ? r.glob.trim() : '', home);
      const why = globProblem(glob);
      if (why) errors.push(`folderRules[${i}].glob: ${why}`);
      else if (!known(r.center)) errors.push(`folderRules[${i}].center: unknown cost center`);
      else out.folderRules.push({ glob, center: r.center });
    });

  const billing = input.billing ?? {};
  if (!isObject(billing)) errors.push('billing must be an object');
  else
    for (const [source, b] of Object.entries(billing)) {
      if (!SOURCES.includes(source)) errors.push(`billing: unknown source ${clip(source)}`);
      else if (isObject(b) && b.mode === 'metered' && Object.keys(b).length === 1) out.billing[source] = { mode: 'metered' };
      else if (isObject(b) && b.mode === 'plan') {
        const plan = typeof b.plan === 'string' ? b.plan.trim() : '';
        if (!plan || plan.length > LIMITS.plan) errors.push(`billing.${source}.plan: 1 to ${LIMITS.plan} characters`);
        else if (!isNum(b.feeUSD) || b.feeUSD < 0 || b.feeUSD > 1e6)
          errors.push(`billing.${source}.feeUSD: a number from 0 to 1,000,000`);
        else if (b.period !== 'month' && b.period !== 'year') errors.push(`billing.${source}.period: month or year`);
        else out.billing[source] = { mode: 'plan', plan, feeUSD: b.feeUSD, period: b.period };
      } else errors.push(`billing.${source}: { mode: 'metered' } or { mode: 'plan', plan, feeUSD, period }`);
    }

  const cur = input.currency ?? null;
  if (cur !== null) {
    if (!isObject(cur)) errors.push('currency must be an object or null');
    else if (typeof cur.code !== 'string' || !CURRENCY.test(cur.code))
      errors.push('currency.code: three capital letters, like IDR');
    else if (cur.code === 'USD') errors.push('currency.code: the ledger is kept in USD; leave currency empty for USD only');
    else if (!Array.isArray(cur.rates) || cur.rates.length > LIMITS.rates)
      errors.push(`currency.rates: a list of at most ${LIMITS.rates}`);
    else {
      const rates = [];
      cur.rates.forEach((r, i) => {
        if (!isObject(r) || !isDay(r.from)) errors.push(`currency.rates[${i}].from: a date YYYY-MM-DD`);
        else if (!isNum(r.perUSD) || r.perUSD <= 0 || r.perUSD > 1e9)
          errors.push(`currency.rates[${i}].perUSD: a number above 0`);
        else if (rates.some((x) => x.from === r.from)) errors.push(`currency.rates[${i}].from: ${r.from} is used twice`);
        else rates.push({ from: r.from, perUSD: r.perUSD });
      });
      out.currency = { code: cur.code, rates: rates.sort((a, b) => (a.from < b.from ? -1 : 1)) };
    }
  }
  return errors.length ? { ok: false, errors: errors.slice(0, 50) } : { ok: true, value: out };
}

// The settings in force. None saved means the defaults; a saved section that does not validate (a hand edit) also means
// the defaults, with `error` set so the status can say so.
function settingsOf(raw, { home = '' } = {}) {
  if (raw === undefined || raw === null) return { value: defaults(), error: null };
  const r = validate(raw, { home });
  return r.ok
    ? { value: r.value, error: null }
    : { value: defaults(), error: 'the saved cost settings are invalid, so the defaults apply' };
}

// Matchers for one settings object. Folders compare without case where the file system usually does (macOS, Windows).
function compile(settings, { nocase = process.platform === 'darwin' || process.platform === 'win32' } = {}) {
  const rules = settings.folderRules.map((r) => ({ re: globToRegExp(r.glob, { nocase }), center: r.center }));
  return {
    centerOf({ keyId, project }) {
      if (keyId && Object.hasOwn(settings.keyCenters, keyId)) return settings.keyCenters[keyId];
      if (project) for (const r of rules) if (r.re.test(project)) return r.center;
      return UNASSIGNED;
    },
    billingOf: (source) => settings.billing[source] || { mode: 'metered' },
  };
}

// A plan's fee for one day: the period's fee spread evenly over its days.
const planFee = (billing, day) =>
  billing.period === 'year' ? billing.feeUSD / daysInYear(day) : billing.feeUSD / daysInMonth(day);

// The latest rate whose `from` is on or before the day (rates are stored sorted), or null.
function rateFor(currency, day) {
  if (!currency || !Array.isArray(currency.rates)) return null;
  let hit = null;
  for (const r of currency.rates) if (r.from <= day) hit = r.perUSD;
  return hit;
}

module.exports = {
  SOURCES,
  UNASSIGNED,
  LIMITS,
  defaults,
  globToRegExp,
  globProblem,
  normalizeGlob,
  validate,
  settingsOf,
  compile,
  planFee,
  rateFor,
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/cost-rules.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/cost/days.js lib/cost/rules.js test/cost-rules.test.js
git commit -m "Cost ledger: days, cost settings validation, folder globs and attribution"
```

---

### Task 2: Private files and price versions

**Files:**
- Create: `lib/cost/files.js`, `lib/cost/prices.js`
- Test: `test/cost-prices.test.js`

**Interfaces:**
- Consumes:
  - `ensurePrivateDir(dir)` from `lib/evals/store.js`, which makes the folder 0700 when it creates it;
  - `makePricer(pricing)` from `lib/pricing.js`.
- Produces:
  - `files.js`:
    - `writePrivate(file, data)`: atomic, 0600, unique temp file, rename; it throws the original error after removing the temp file;
    - `appendPrivate(file, text)`;
    - `readJson(file, fallback)`.
  - `prices.js`: `createPriceVersions({ dir = null, now = Date.now })` returning:
    - `observe(pricing, day) → version`;
    - `versionFor(day) → version | null`;
    - `pricerFor(id) → pricer`;
    - `current() → version | null`;
    - `list() → [version]` (copies);
    - `seed([{ from, at, pricing }])`, for the demo, in memory only.

    It also exports `hashOf(pricing)` and `changedKeys(a, b)`. With `dir: null` nothing is written. A version is `{ id, from, at, hash, changed, changedCount }` (R9).

- [ ] **Step 1: Write the failing test**

```js
// test/cost-prices.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPriceVersions, hashOf } = require('../lib/cost/prices');
const { writePrivate } = require('../lib/cost/files');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-prices-'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const sum = (parts) => parts.reduce((a, b) => a + b, 0);
const mode = (p) => fs.statSync(p).mode & 0o777;

test('observe: the first prices are version 1; equal prices add nothing; a change adds a version from that day', () => {
  let t = 1000;
  const A = { m: { input: 1, output: 2 } };
  const p = createPriceVersions({ now: () => t });
  const v1 = p.observe(A, '2026-10-20');
  assert.deepEqual(v1, { id: 1, from: '2026-10-20', at: 1000, hash: hashOf(A), changed: [], changedCount: 0 });
  assert.equal(p.observe(A, '2026-10-21'), v1, 'the same object');
  assert.equal(p.observe({ m: { output: 2, input: 1 } }, '2026-10-21').id, 1, 'equal prices in a new object');
  t = 2000;
  const v2 = p.observe({ m: { input: 1, output: 3 }, n: { input: 5 } }, '2026-10-22');
  assert.deepEqual([v2.id, v2.from, v2.at, v2.changed, v2.changedCount], [2, '2026-10-22', 2000, ['m', 'n'], 2]);
  assert.equal(p.versionFor('2026-10-01').id, 1, 'before the first version: the first (history priced on the first run)');
  assert.equal(p.versionFor('2026-10-21').id, 1);
  assert.equal(p.versionFor('2026-10-22').id, 2);
  assert.equal(p.versionFor('2026-12-01').id, 2);
  p.observe({ m: { input: 9 } }, '2026-10-22');
  assert.equal(p.versionFor('2026-10-22').id, 3, 'the newest version of a day wins');
  const v4 = p.observe({ m: { input: 8 } }, '2026-10-19');
  assert.equal(v4.from, '2026-10-22', 'a clock that went back never dates a version earlier');
  assert.equal(p.current().id, 4);
  assert.equal(createPriceVersions().versionFor('2026-10-22'), null, 'no versions yet');
});

test('versions persist in prices/ (folder 0700, files 0600, no temp file left) and price with their own table', () => {
  const dir = path.join(tmp(), 'cost', 'prices');
  const p = createPriceVersions({ dir });
  p.observe({ 'claude-sonnet-5-5': { input: 2, output: 10 } }, '2026-10-21');
  p.observe({ 'claude-sonnet-5-5': { input: 4, output: 20 } }, '2026-10-22');
  const again = createPriceVersions({ dir });
  assert.deepEqual(
    again.list().map((v) => [v.id, v.from]),
    [
      [1, '2026-10-21'],
      [2, '2026-10-22'],
    ],
  );
  near(sum(again.pricerFor(1).parts('claude-sonnet-5-5', 1000, 100, 0, 0, 0, null)), 0.003);
  near(sum(again.pricerFor(2).parts('claude-sonnet-5-5', 1000, 100, 0, 0, 0, null)), 0.006);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['1.json', '2.json', 'versions.json']);
  if (process.platform !== 'win32') {
    assert.equal(mode(dir), 0o700);
    for (const f of fs.readdirSync(dir)) assert.equal(mode(path.join(dir, f)), 0o600, f);
  }
});

test('memory mode writes nothing; seed adds demo versions with their hash and changed keys', () => {
  const p = createPriceVersions();
  p.seed([
    { from: '2026-10-01', at: 1, pricing: { a: { input: 3 } } },
    { from: '2026-10-11', at: 2, pricing: { a: { input: 2 } } },
  ]);
  assert.deepEqual(
    p.list().map((v) => [v.id, v.from, v.changed]),
    [
      [1, '2026-10-01', []],
      [2, '2026-10-11', ['a']],
    ],
  );
  assert.equal(p.list()[1].hash, hashOf({ a: { input: 2 } }));
  assert.equal(p.versionFor('2026-10-05').id, 1);
});

test('writePrivate: 0600, replaces the file, and leaves no temp file', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.json');
  writePrivate(file, 'one');
  writePrivate(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  if (process.platform !== 'win32') assert.equal(mode(file), 0o600);
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }), 'key order does not change the hash');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-prices.test.js`
Expected: FAIL with `Cannot find module '../lib/cost/prices'`.

- [ ] **Step 3: Write `lib/cost/files.js`**

```js
// Private files for the cost ledger. A rewrite is atomic and hardened like saveConfigSection in server.js: a temp file
// of its own (two writers never share one), created 0600 and never an existing file ('wx'), then a rename.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensurePrivateDir } = require('../evals/store');

function writePrivate(file, data) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function appendPrivate(file, text) {
  ensurePrivateDir(path.dirname(file));
  fs.appendFileSync(file, text, { mode: 0o600 });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

module.exports = { writePrivate, appendPrivate, readJson };
```

- [ ] **Step 4: Write `lib/cost/prices.js`**

```js
// Price versions: each time the effective pricing (config.pricing: defaults, snapshot, your prices, live list) changes,
// a version { id, from, at, hash, changed, changedCount } is kept with a full copy of that pricing, so every day can be
// priced with the prices in force on it and a past day's cost stays frozen. Files: <dir>/versions.json and <dir>/<id>.json.
const path = require('path');
const crypto = require('crypto');
const { makePricer } = require('../pricing');
const { writePrivate, readJson } = require('./files');

const MAX_CHANGED = 100;

// JSON with object keys sorted, so the same prices always hash the same.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
const hashOf = (pricing) => crypto.createHash('sha256').update(stable(pricing)).digest('hex').slice(0, 16);
function changedKeys(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter((k) => stable((a || {})[k]) !== stable((b || {})[k])).sort();
}

function createPriceVersions({ dir = null, now = Date.now } = {}) {
  const indexFile = dir && path.join(dir, 'versions.json');
  const fileOf = (id) => path.join(dir, `${id}.json`);
  const loaded = dir ? readJson(indexFile, null) : null;
  const versions = loaded && Array.isArray(loaded.versions) ? loaded.versions : [];
  const bodies = new Map(); // id -> pricing
  const pricers = new Map(); // id -> makePricer(pricing)
  let seen = null; // the pricing object the last observe compared, so an unchanged config costs no hashing
  const latest = () => versions[versions.length - 1] || null;
  const pricingOf = (id) => {
    if (!bodies.has(id)) bodies.set(id, dir ? readJson(fileOf(id), {}) : {});
    return bodies.get(id);
  };
  const make = (pricing, from, at) => {
    const prev = latest();
    const changed = prev ? changedKeys(pricingOf(prev.id), pricing) : [];
    return {
      id: prev ? prev.id + 1 : 1,
      from: prev && prev.from > from ? prev.from : from,
      at,
      hash: hashOf(pricing),
      changed: changed.slice(0, MAX_CHANGED),
      changedCount: changed.length,
    };
  };

  function observe(pricing, day) {
    const last = latest();
    if (pricing === seen && last) return last;
    const copy = JSON.parse(JSON.stringify(pricing || {}));
    if (last && last.hash === hashOf(copy)) {
      seen = pricing;
      return last;
    }
    const v = make(copy, day, now());
    if (dir) {
      writePrivate(fileOf(v.id), JSON.stringify(copy));
      writePrivate(indexFile, JSON.stringify({ version: 1, versions: [...versions, v] }));
    }
    bodies.set(v.id, copy);
    versions.push(v);
    seen = pricing;
    return v;
  }

  // The version in force on `day`: the newest whose `from` is on or before it. A day before the first version (history
  // read on the first run) gets the first one: past prices were never kept.
  function versionFor(day) {
    let hit = versions[0] || null;
    for (const v of versions) if (v.from <= day) hit = v;
    return hit;
  }

  function pricerFor(id) {
    if (!pricers.has(id)) pricers.set(id, makePricer(pricingOf(id)));
    return pricers.get(id);
  }

  // Demo: versions held in memory with their prices.
  function seed(list) {
    for (const s of list) {
      const v = make(s.pricing, s.from, s.at);
      bodies.set(v.id, s.pricing);
      versions.push(v);
    }
  }

  return {
    observe,
    versionFor,
    pricerFor,
    seed,
    current: latest,
    list: () => versions.map((v) => ({ ...v, changed: [...v.changed] })),
  };
}

module.exports = { createPriceVersions, hashOf, changedKeys };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/cost-prices.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/cost/files.js lib/cost/prices.js test/cost-prices.test.js
git commit -m "Cost ledger: private atomic files and price versions with versionFor(day)"
```

---

### Task 3: Collectors, the shared pricer and the cursor reader

**Files:**
- Create: `lib/cost/collect.js`
- Test: `test/cost-collect.test.js`

**Interfaces:**
- Consumes:
  - `dedupeEvents(results, sessions)` and `mergeSessions(results)` from `lib/aggregate.js`: the Overview's dedupe key `${tool}|${e[10]}`;
  - `normalizeModel` and `makePricer` from `lib/pricing.js`;
  - `tilde(p, home)` from `lib/logroots.js`;
  - `dayOf` from `lib/cost/days.js`.
- Produces:
  - **Normalized event**: `{ ts, source, provider, model (raw, for the pricer), tokens: { in, out, cacheRead, cacheWrite5m, cacheWrite1h }, webSearches, geo, project, keyId, agent, kind, estimated: false, free }`.
  - **Local events**: `localEvents(results, { home }) → [event]` (`results` are the indexer's per-file results).
  - **Gateway events**: `gatewayEvent(line, { isPrivate }) → event | null`.
  - **Judge-call lines**:
    - `judgeLine({ kind, provider, model, usage }, ts) → line | null`, which is `null` for `kind: 'external'`;
    - a line is `{ ts, kind, provider, model, in, out, cacheRead, cacheWrite5m }`;
    - `judgeEvent(line) → event | null`.
  - **Pricing**: `priceEvent(pricer, event) → { listUSD, unpriced, estimated }`.
  - **Cursor reader**:
    - `readNew(file, cursor) → { rows, bad, cursor: { head, offset } }` (R11);
    - `headOf(file) → string | null`.

- [ ] **Step 1: Write the failing test**

```js
// test/cost-collect.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/cost/collect');
const { makePricer, eventParts } = require('../lib/pricing');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} is not ${b}`);
const sess = (tool, project) => ({ tool, project, tools: {}, skills: {}, agents: {}, prompts: 0, subagentFiles: 0 });

test('local events: one per API response, a resumed copy once, the folder with ~, provider and extras', () => {
  const row = (sid) => [1000, 'claude', sid, 'claude-sonnet-5-5', 10, 5, 1, 2, 3, 0, 'msg_1:req_1', { ws: 2, geo: 'us' }];
  const a = { events: [row('s1')], sessions: { s1: sess('claude', path.join(HOME, 'work', 'acme')) } };
  const b = { events: [row('s2')], sessions: { s2: sess('claude', path.join(HOME, 'work', 'acme')) } };
  const codex = [2000, 'codex', 'c1', 'gpt-6.1-sol', 7, 1, 0, 0, 0, 0, null, null];
  const c = {
    events: [codex, [...codex]],
    sessions: { c1: sess('codex', path.join(HOME, 'Documents', 'Codex', '2026-10-20', 'chat-1')) },
  };
  const out = C.localEvents([a, b, c], { home: HOME });
  assert.equal(out.length, 3, 'the resumed copy once; keyless Codex rows are all kept');
  assert.deepEqual(out[0], {
    ts: 1000,
    source: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    tokens: { in: 10, out: 5, cacheRead: 1, cacheWrite5m: 2, cacheWrite1h: 3 },
    webSearches: 2,
    geo: 'us',
    project: '~/work/acme',
    keyId: null,
    agent: null,
    kind: 'chat',
    estimated: false,
    free: false,
  });
  assert.equal(out[1].provider, 'openai');
  assert.equal(out[1].project, '~/Documents/Codex', 'Codex desktop chats are one project, as on the Overview');
});

test('gateway lines: source, kind, agent and key; prompt minus cache; failed attempts skipped; private is free', () => {
  const base = { ts: 5, keyId: 'key_a', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', kind: 'chat' };
  const ev = C.gatewayEvent({ ...base, input: 1000, cached: 300, output: 50, routedTo: 'openrouter/anthropic/claude-opus-5.5' });
  assert.deepEqual(
    [ev.source, ev.kind, ev.keyId, ev.agent, ev.model, ev.free],
    ['gateway', 'chat', 'key_a', null, 'openrouter/anthropic/claude-opus-5.5', false],
  );
  assert.deepEqual(ev.tokens, { in: 700, out: 50, cacheRead: 300, cacheWrite5m: 0, cacheWrite1h: 0 });
  const kinds = [
    [{ agent: 'replay', kind: 'agent', keyId: 'dashboard' }, ['replay', 'replay', null, null]],
    [{ agent: 'judge', kind: 'agent', keyId: 'dashboard' }, ['judge', 'judge', null, null]],
    [{ agent: 'planner', kind: 'agent', runId: 'run_1', keyId: 'dashboard' }, ['collab', 'run', null, 'planner']],
    [{ agent: 'coder', kind: 'agent' }, ['gateway', 'agent', 'key_a', 'coder']],
    [{ kind: 'embeddings' }, ['gateway', 'embed', 'key_a', null]],
  ];
  for (const [extra, want] of kinds) {
    const e = C.gatewayEvent({ ...base, input: 10, output: 1, ...extra });
    assert.deepEqual([e.source, e.kind, e.keyId, e.agent], want, JSON.stringify(extra));
  }
  assert.equal(C.gatewayEvent({ ...base, status: 599, error: 'down' }), null, 'no tokens: a failed attempt');
  assert.equal(C.gatewayEvent({ input: 5 }), null, 'no timestamp');
  const local = C.gatewayEvent({ ...base, provider: 'ollama', input: 5, output: 5 }, { isPrivate: (id) => id === 'ollama' });
  assert.equal(local.free, true);
});

test('judge calls: external ones are left to the gateway log; Claude Code usage is split; local judges are free', () => {
  assert.equal(C.judgeLine({ kind: 'external', provider: 'openrouter', model: 'x', usage: { input: 1, output: 1 } }, 9), null);
  const line = C.judgeLine(
    {
      kind: 'claude-cli',
      provider: 'claude-code',
      model: 'claude-haiku-5-5',
      usage: { input: 1602, output: 40, cost: 0.0005, cacheRead: 100, cacheWrite: 1500 },
    },
    9,
  );
  assert.deepEqual(line, {
    ts: 9,
    kind: 'claude-cli',
    provider: 'claude-code',
    model: 'claude-haiku-5-5',
    in: 2,
    out: 40,
    cacheRead: 100,
    cacheWrite5m: 1500,
  });
  const ev = C.judgeEvent(line);
  assert.deepEqual([ev.source, ev.kind, ev.provider, ev.free], ['judge', 'judge', 'claude-code', false]);
  assert.deepEqual(ev.tokens, { in: 2, out: 40, cacheRead: 100, cacheWrite5m: 1500, cacheWrite1h: 0 });
  const ollama = C.judgeEvent(C.judgeLine({ kind: 'ollama', provider: 'ollama', model: 'qwen3:8b', usage: { input: 9, output: 3 } }, 1));
  assert.equal(ollama.free, true);
  assert.equal(C.judgeEvent({ ts: 1, model: 'm', in: 0, out: 0 }), null);
});

test('the shared pricer: a gateway line costs what a local event with the same tokens costs (cache writes, tiers, web search, geo)', () => {
  const pricer = makePricer({
    'claude-x': {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite5m: 1.25,
      cacheWrite1h: 2,
      webSearch: 0.01,
      tiers: [{ above: 200000, input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
    },
    codex: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, estimate: true },
  });
  // The second case is over the 200,000-token tier (150,000 + 60,000 + 1,000 prompt tokens).
  for (const [inp, out, cr, w5, w1] of [
    [1000, 200, 3000, 400, 100],
    [150000, 900, 60000, 1000, 0],
  ]) {
    const local = [1, 'claude', 's', 'claude-x', inp, out, cr, w5, w1, 0, 'k', { ws: 3, geo: 'us' }];
    const want = eventParts(pricer, local).reduce((a, b) => a + b, 0);
    const line = {
      ts: 1,
      provider: 'anthropic',
      model: 'anthropic/claude-x',
      kind: 'chat',
      status: 200,
      input: inp + cr + w5 + w1,
      cached: cr,
      cacheWrite5m: w5,
      cacheWrite1h: w1,
      output: out,
      webSearches: 3,
      geo: 'us',
    };
    near(C.priceEvent(pricer, C.gatewayEvent(line)).listUSD, want);
    near(C.priceEvent(pricer, C.localEvents([{ events: [local], sessions: {} }], { home: HOME })[0]).listUSD, want);
  }
  const ev = (model, free = false) => ({
    model,
    free,
    tokens: { in: 10, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    webSearches: 0,
    geo: null,
  });
  assert.deepEqual(C.priceEvent(pricer, ev('nope')), { listUSD: 0, unpriced: true, estimated: false });
  assert.deepEqual(C.priceEvent(pricer, ev('claude-x', true)), { listUSD: 0, unpriced: false, estimated: false });
  assert.equal(C.priceEvent(pricer, ev('codex')).estimated, true);
});

test('readNew: the first run reads the rotated file too; then only new complete lines; a rotation is followed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-read-'));
  const f = path.join(dir, 'log.jsonl');
  const L = (n) => JSON.stringify({ n }) + '\n';
  let r = C.readNew(f, undefined);
  assert.deepEqual([r.rows, r.cursor], [[], { head: null, offset: 0 }]);
  fs.writeFileSync(f + '.1', L(1));
  fs.writeFileSync(f, L(2) + L(3) + '{"n":4');
  r = C.readNew(f, undefined);
  assert.deepEqual(r.rows.map((x) => x.n), [1, 2, 3], 'a torn last line waits');
  fs.appendFileSync(f, '}\nnot json\n');
  r = C.readNew(f, r.cursor);
  assert.deepEqual([r.rows.map((x) => x.n), r.bad], [[4], 1]);
  fs.appendFileSync(f, L(5));
  fs.renameSync(f, f + '.1'); // lib/gateway/store.js rotates at 10 MB
  fs.writeFileSync(f, L(6));
  r = C.readNew(f, r.cursor);
  assert.deepEqual(r.rows.map((x) => x.n), [5, 6]);
  fs.writeFileSync(f, L(7)); // a file this cursor does not know: read from the start, once
  fs.rmSync(f + '.1');
  r = C.readNew(f, r.cursor);
  assert.deepEqual(r.rows.map((x) => x.n), [7]);
  assert.deepEqual(C.readNew(f, r.cursor).rows, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-collect.test.js`
Expected: FAIL with `Cannot find module '../lib/cost/collect'`.

- [ ] **Step 3: Write `lib/cost/collect.js`**

```js
// Collectors: raw records → normalized usage events, and the one pricing formula every source shares.
// Who counts what (no call is counted twice):
//  - the log index: Claude Code and Codex transcripts, deduplicated with the Overview's key (resumed and forked sessions
//    copy earlier responses; lib/aggregate.js dedupeEvents keeps one);
//  - the gateway log: every call that went through the gateway, including dataset replay (agent "replay"), external
//    judge calls (agent "judge") and collaboration runs (runId). Experiment records and run totals repeat these lines
//    and are never read;
//  - judge-calls.jsonl: judge calls that did not go through the gateway (Ollama, LM Studio, the Claude Code CLI, which
//    runs with --no-session-persistence and so leaves no transcript).
// Events carry numbers and names only, never text.
const fs = require('fs');
const crypto = require('crypto');
const { dedupeEvents, mergeSessions } = require('../aggregate');
const { tilde } = require('../logroots');

const LOCAL_PROVIDER = { claude: 'anthropic', codex: 'openai' };
const GATEWAY_KIND = { chat: 'chat', embeddings: 'embed', agent: 'agent' };
const FREE_JUDGE = new Set(['ollama', 'lmstudio']); // the judge's own local servers
const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

// Codex desktop gives each chat its own dated folder; one project, as on the Overview.
const projectOf = (p, home) =>
  typeof p === 'string' && p
    ? tilde(p.replace(/([\\/]Documents[\\/]Codex)[\\/]\d{4}-\d{2}-\d{2}(?:[\\/].*)?$/, '$1'), home)
    : null;

function localEvents(results, { home = '' } = {}) {
  const sessions = mergeSessions(results);
  const out = [];
  for (const e of dedupeEvents(results, sessions)) {
    const provider = LOCAL_PROVIDER[e[1]];
    if (!provider || !Number.isFinite(e[0])) continue;
    const s = sessions.get(`${e[1]}:${e[2]}`) || {};
    const x = e[11] || {};
    out.push({
      ts: e[0],
      source: e[1],
      provider,
      model: String(e[3] || ''),
      tokens: { in: n(e[4]), out: n(e[5]), cacheRead: n(e[6]), cacheWrite5m: n(e[7]), cacheWrite1h: n(e[8]) },
      webSearches: n(x.ws),
      geo: x.geo === 'us' ? 'us' : null,
      project: projectOf(s.project, home),
      keyId: null,
      agent: null,
      kind: 'chat',
      estimated: false,
      free: false,
    });
  }
  return out;
}

// One gateway log line (lib/gateway/usage.js). `input` is the whole prompt (cached and cache-written tokens included);
// lines carry no cache writes, web searches or geo today, and these optional fields are read when a line has them.
function gatewayEvent(line, { isPrivate = () => false } = {}) {
  if (!line || typeof line !== 'object' || !Number.isFinite(line.ts)) return null;
  const input = n(line.input);
  const out = n(line.output);
  if (!input && !out) return null; // a failed attempt: nothing was used
  const cached = Math.min(n(line.cached), input);
  const cw5m = Math.min(n(line.cacheWrite5m), input - cached);
  const cw1h = Math.min(n(line.cacheWrite1h), input - cached - cw5m);
  const run = !!str(line.runId, 80);
  const source = run ? 'collab' : line.agent === 'judge' ? 'judge' : line.agent === 'replay' ? 'replay' : 'gateway';
  const kind = run ? 'run' : source !== 'gateway' ? source : GATEWAY_KIND[line.kind] || 'chat';
  const provider = str(line.provider, 80);
  return {
    ts: line.ts,
    source,
    provider,
    model: String(line.routedTo || line.model || ''),
    tokens: { in: input - cached - cw5m - cw1h, out, cacheRead: cached, cacheWrite5m: cw5m, cacheWrite1h: cw1h },
    webSearches: n(line.webSearches),
    geo: line.geo === 'us' ? 'us' : null,
    project: null,
    keyId: line.keyId && line.keyId !== 'dashboard' ? str(line.keyId, 64) : null,
    agent: source === 'gateway' || source === 'collab' ? str(line.agent, 80) : null,
    kind,
    estimated: false,
    free: !!provider && !!isPrivate(provider),
  };
}

// What the eval engine reports for one answered judge call, as a judge-calls.jsonl line. Claude Code's `input` holds
// the cached and cache-written tokens too; its split is in usage.cacheRead / usage.cacheWrite.
function judgeLine({ kind, provider, model, usage } = {}, ts) {
  if (kind === 'external' || !usage || typeof kind !== 'string') return null;
  const input = n(usage.input);
  const cacheRead = Math.min(n(usage.cacheRead), input);
  const cacheWrite5m = Math.min(n(usage.cacheWrite), input - cacheRead);
  return {
    ts,
    kind: kind.slice(0, 20),
    provider: str(provider, 40),
    model: String(model || '').slice(0, 100),
    in: input - cacheRead - cacheWrite5m,
    out: n(usage.output),
    cacheRead,
    cacheWrite5m,
  };
}

function judgeEvent(line) {
  if (!line || !Number.isFinite(line.ts) || typeof line.model !== 'string') return null;
  const tokens = { in: n(line.in), out: n(line.out), cacheRead: n(line.cacheRead), cacheWrite5m: n(line.cacheWrite5m), cacheWrite1h: 0 };
  if (!tokens.in && !tokens.out && !tokens.cacheRead && !tokens.cacheWrite5m) return null;
  return {
    ts: line.ts,
    source: 'judge',
    provider: str(line.provider, 40),
    model: line.model,
    tokens,
    webSearches: 0,
    geo: null,
    project: null,
    keyId: null,
    agent: null,
    kind: 'judge',
    estimated: false,
    free: FREE_JUDGE.has(line.kind),
  };
}

// The list price of one event with the shared pricer (cache writes 5m/1h, prompt-length tiers, web search, US geo): the
// same formula for every source. A model on the owner's own hardware costs 0; a model with no price is unpriced.
function priceEvent(pricer, ev) {
  if (ev.free) return { listUSD: 0, unpriced: false, estimated: false };
  if (!ev.model || !pricer.priced(ev.model)) return { listUSD: 0, unpriced: true, estimated: false };
  const t = ev.tokens;
  const extra = ev.webSearches || ev.geo ? { ws: ev.webSearches || 0, geo: ev.geo } : null;
  const p = pricer.parts(ev.model, t.in, t.out, t.cacheRead, t.cacheWrite5m, t.cacheWrite1h, extra);
  return { listUSD: p[0] + p[1] + p[2] + p[3] + p[4], unpriced: false, estimated: pricer.estimated(ev.model) };
}

// A file is named by a hash of its first line, so a rotation (file → file.1) can be told from new data.
function headOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const buf = Buffer.alloc(4096);
    const len = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, len).indexOf(10);
    return nl < 0 ? null : crypto.createHash('sha256').update(buf.subarray(0, nl)).digest('hex').slice(0, 16);
  } finally {
    fs.closeSync(fd);
  }
}

const sizeOf = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

// The complete lines from `offset` on; `end` is the offset just past the last newline.
function readFrom(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return { rows: [], bad: 0, end: offset };
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { rows: [], bad: 0, end: offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const last = buf.lastIndexOf(10);
    if (last < 0) return { rows: [], bad: 0, end: offset };
    const rows = [];
    let bad = 0;
    for (const line of buf.subarray(0, last).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r === 'object' && !Array.isArray(r)) rows.push(r);
        else bad++;
      } catch {
        bad++;
      }
    }
    return { rows, bad, end: offset + last + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

// New complete lines of an append-only log since `cursor` ({ head, offset }; none on the first run). See R11.
function readNew(file, cursor) {
  const c = cursor && Number.isFinite(cursor.offset) && cursor.offset >= 0 ? cursor : null;
  const head = headOf(file);
  const parts = [];
  if (c && head === (c.head ?? null)) parts.push(readFrom(file, sizeOf(file) < c.offset ? 0 : c.offset));
  else {
    if (!c) parts.push(readFrom(`${file}.1`, 0)); // the first run: the rotated history too
    else if (c.head && headOf(`${file}.1`) === c.head) parts.push(readFrom(`${file}.1`, c.offset));
    parts.push(readFrom(file, 0));
  }
  return {
    rows: parts.flatMap((p) => p.rows),
    bad: parts.reduce((a, p) => a + p.bad, 0),
    cursor: { head, offset: parts[parts.length - 1].end },
  };
}

module.exports = { localEvents, gatewayEvent, judgeLine, judgeEvent, priceEvent, readNew, headOf };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/cost-collect.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cost/collect.js test/cost-collect.test.js
git commit -m "Cost ledger: collectors for logs, gateway and judge calls, one shared pricer, a rotation-safe reader"
```

---

### Task 4: Report judge calls that skip the gateway (shared files)

**Files:**
- Modify: `lib/evals/engine.js`:
  - add an option after `onResult` (`:116`);
  - add a `noteCall` helper after `chargeOf`, which ends at `:235`;
  - call it after `save();` at `:680` (runJob) and `:789` (judgeMaterial).
- Modify: `lib/evals/claude-cli.js` (`:635-640`, the `usage` object in `parse`).
- Modify tests:
  - `test/evals-engine.test.js`: `rig()` at `:37` accepts `onCall`; append the new tests at the end of the file;
  - `test/evals-claude-cli.test.js:186`;
  - `test/evals-models.test.js:831`.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - **Engine option.** `createEvalEngine({ …, onCall = () => {} })`. `onCall({ kind, provider, model, usage })` runs once per answered judge call (queue or `judgeMaterial`), after the call is counted:
    - `model` is `reply.model` when the judge named one, else `resolved.model`;
    - `usage` is `reply.usage`;
    - no text is passed;
    - a throwing listener is ignored.
  - **Claude Code usage.** `claude.run()` usage becomes `{ input, output, cost, cacheRead, cacheWrite }`. `input` is unchanged (it still includes both cache counts).

- [ ] **Step 1: Write the failing tests**

In `test/evals-engine.test.js`, change the `rig` signature and the `make` call:

```js
function rig({ settings = {}, resolved = LOCAL, entries = [], demo, demoData, onCall } = {}) {
```

```js
      demo,
      demoData,
      ...(onCall ? { onCall } : {}),
    });
```

Append at the end of the file (after the `judgeMaterial` tests, which define `MATERIAL`):

```js
// ---- onCall: what the cost ledger records for judge calls that skip the gateway ----
test('onCall: each answered judge call is reported with kind, provider, model and usage, never text', async () => {
  const seen = [];
  const r = rig({ onCall: (c) => seen.push(c) });
  const v = await r.engine.judgeMaterial('task_completion', MATERIAL);
  assert.equal(v.ok, true);
  assert.deepEqual(seen, [{ kind: 'ollama', provider: 'ollama', model: 'qwen3:8b', usage: { input: 10, output: 5, cost: 0 } }]);
  assert.doesNotMatch(JSON.stringify(seen), /fix the redirect|Fixed/);

  const q = [];
  const queue = rig({ onCall: (c) => q.push(c) });
  await queue.arm();
  queue.clock.t = T0 + 15 * MIN;
  queue.st.entries.push(entry('one', [T0 + 2 * MIN], T0 + 3 * MIN));
  await queue.engine.tick();
  await queue.engine.drain();
  assert.ok(q.length >= 1);
  assert.equal(q.length, queue.calls.length, 'one report per answered call');
  assert.ok(q.every((c) => c.kind === 'ollama' && c.model === 'qwen3:8b'));
});

test('onCall: the model the judge names wins; a failed call is not reported; a throwing listener changes nothing', async () => {
  const seen = [];
  const named = rig({ onCall: (c) => seen.push(c) });
  named.st.model = 'claude-haiku-5-5';
  await named.engine.judgeMaterial('task_completion', MATERIAL);
  assert.equal(seen[0].model, 'claude-haiku-5-5');

  const failed = [];
  const down = rig({ onCall: (c) => failed.push(c) });
  down.st.failures = 1;
  assert.equal((await down.engine.judgeMaterial('task_completion', MATERIAL)).ok, false);
  assert.deepEqual(failed, []);

  const loud = rig({
    onCall: () => {
      throw new Error('listener broke');
    },
  });
  assert.equal((await loud.engine.judgeMaterial('task_completion', MATERIAL)).ok, true);
});
```

In `test/evals-claude-cli.test.js:186` and `test/evals-models.test.js:831`, replace the expected usage with:

```js
{ input: 1602, output: 40, cost: 0.0005, cacheRead: 100, cacheWrite: 1500 }
```

The fake CLI reports `input_tokens: 2, cache_creation_input_tokens: 1500, cache_read_input_tokens: 100, output_tokens: 40` (`test/helpers.js`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/evals-engine.test.js test/evals-claude-cli.test.js test/evals-models.test.js`
Expected: FAIL. The new `onCall` tests see `seen` stay `[]`, and the two usage `deepEqual`s lack `cacheRead` and `cacheWrite`.

- [ ] **Step 3: Implement**

In `lib/evals/engine.js`, add after `onResult = () => {}, …` (`:116`):

```js
  onCall = () => {}, // each answered judge call: { kind, provider, model, usage }, no text (the cost ledger listens)
```

Add after `chargeOf` (it ends at `:235`):

```js
  // The cost ledger records judge calls that do not go through the gateway; it drops `external` ones, which the gateway
  // log holds already. A listener failure never breaks judging.
  const noteCall = (resolved, reply) => {
    try {
      onCall({
        kind: resolved.kind,
        provider: resolved.provider,
        model: (reply && typeof reply.model === 'string' && reply.model) || resolved.model,
        usage: (reply && reply.usage) || null,
      });
    } catch {
      /* the ledger must never stop the judge */
    }
  };
```

In `runJob` (`:678-680`) and in `judgeMaterial` (`:787-789`), add the call right after each `save();` that follows `state.cost += chargeOf(resolved, reply, estimate, inputOnly);`:

```js
      noteCall(resolved, reply);
```

In `lib/evals/claude-cli.js` `parse`, change the usage object to:

```js
    usage: {
      input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
      output: n(u.output_tokens),
      // The API-equivalent list price of the call, as the CLI works it out; null when it said nothing.
      cost: Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : null,
      // The split the cost ledger prices with (input above includes both).
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/evals-engine.test.js test/evals-claude-cli.test.js test/evals-models.test.js`
Expected: PASS (all, including the existing cap and preview tests: `chargeOf` reads only `usage.cost` and `usage.input`).

- [ ] **Step 5: Commit**

```bash
git add lib/evals/engine.js lib/evals/claude-cli.js test/evals-engine.test.js test/evals-claude-cli.test.js test/evals-models.test.js
git commit -m "Evals: report each answered judge call to a listener, and split Claude Code cache tokens"
```

---

### Task 5: The ledger store, the reader view and grouping

**Files:**
- Create: `lib/cost/ledger.js` (`restate` is added in Task 7)
- Test: `test/cost-ledger.test.js`

**Interfaces:**
- Consumes:
  - `isDay` and `monthOf` (`days.js`);
  - `SOURCES` and `planFee` (`rules.js`);
  - `writePrivate` and `appendPrivate` (`files.js`).
- Produces:
  - **Constants**: `DIMS`, `KEY_FIELDS`, `TOKENS`.
  - **Row helpers**:
    - `newRow(dims) → row`, `cloneRow(row)`;
    - `rowKey(row)`, `baseKey(row)`, `tokenTotal(row)`;
    - `mergeRows(a, b) → row`;
    - `planRow(day, source, billing, backfilled) → row`.
  - **Store**: `createLedgerStore({ dir = null })` returning:
    - `load()`, `flush()`;
    - `get(dims) → row | null` (a copy), `put(row)`, `remove(row)`;
    - `day(day) → [row]`, `range(from, to) → [row]`, `all() → [row]` (copies);
    - `earliestDay(source) → day | null` (non-plan rows only);
    - `corrections() → [correction]`, `addCorrection(c)`;
    - `view(from, to) → [row + { key }]` (corrections applied, R13);
    - `badLines() → n`.
  - **Grouping**: `groupRows(rows, { groupBy, rateOf }) → { rows, totals, missingRate }` (R14, R15).

- [ ] **Step 1: Write the failing test**

```js
// test/cost-ledger.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/cost/ledger');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-ledger-'));
const mode = (p) => fs.statSync(p).mode & 0o777;
const row = (day, extra = {}) => ({
  ...L.newRow({ day, source: 'claude', provider: 'anthropic', model: 'claude-sonnet-5-5', project: '~/a', center: 'unassigned', kind: 'chat' }),
  requests: 1,
  listUSD: 1,
  billedUSD: 1,
  priceVersion: 1,
  ...extra,
});

test('store: rows by month in private files; put replaces by key; reads are copies', () => {
  const dir = path.join(tmp(), 'cost');
  const s = L.createLedgerStore({ dir });
  s.load();
  s.put(row('2026-09-30'));
  s.put(row('2026-10-01'));
  s.put(row('2026-10-01', { listUSD: 2 }));
  s.put(row('2026-10-02', { source: 'codex' }));
  s.flush();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ledger-2026-09.jsonl', 'ledger-2026-10.jsonl']);
  if (process.platform !== 'win32') {
    assert.equal(mode(dir), 0o700);
    for (const f of fs.readdirSync(dir)) assert.equal(mode(path.join(dir, f)), 0o600, f);
  }
  const again = L.createLedgerStore({ dir });
  again.load();
  assert.equal(again.get(row('2026-10-01')).listUSD, 2);
  assert.equal(again.day('2026-10-01').length, 1);
  assert.deepEqual(again.range('2026-09-30', '2026-10-01').map((r) => r.day).sort(), ['2026-09-30', '2026-10-01']);
  assert.equal(again.earliestDay('claude'), '2026-09-30');
  assert.equal(again.earliestDay('codex'), '2026-10-02');
  assert.equal(again.earliestDay('gateway'), null);
  const copy = again.get(row('2026-10-01'));
  copy.listUSD = 99;
  assert.equal(again.get(row('2026-10-01')).listUSD, 2, 'reads are copies');
  again.remove(row('2026-10-01'));
  assert.equal(again.get(row('2026-10-01')), null);
});

test('store: a corrupt line goes to .bad (0600) and the month still loads', () => {
  const dir = path.join(tmp(), 'cost');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger-2026-10.jsonl');
  // The second bad line is valid JSON for the wrong month.
  fs.writeFileSync(file, `${JSON.stringify(row('2026-10-01'))}\nnot json\n${JSON.stringify(row('2026-09-30'))}\n`);
  const s = L.createLedgerStore({ dir });
  s.load();
  assert.equal(s.range('2026-09-01', '2026-10-31').length, 1);
  assert.equal(s.badLines(), 2);
  assert.equal(fs.readFileSync(`${file}.bad`, 'utf8').split('\n').filter(Boolean).length, 2);
  if (process.platform !== 'win32') assert.equal(mode(`${file}.bad`), 0o600);
  s.flush();
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, 'the month is written again without them');
});

test('view: a correction moves amounts by after - before, so later growth still counts; an added row shows in range', () => {
  const s = L.createLedgerStore();
  const base = row('2026-10-01', { center: 'a' });
  s.put(base);
  const before = { listUSD: 1, billedUSD: 1, priceVersion: 1, center: 'a', unpriced: false };
  const after = { listUSD: 2, billedUSD: 0, priceVersion: 2, center: 'b', unpriced: false };
  const plan = L.planRow('2026-10-01', 'claude', { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' }, false);
  s.addCorrection({
    ts: 1,
    from: '2026-10-01',
    to: '2026-10-01',
    reason: 'r',
    priceVersion: 2,
    rows: [
      { key: L.rowKey(base), before, after },
      { key: L.rowKey(plan), before: null, after: { ...after, listUSD: 0, billedUSD: 10 }, row: plan },
    ],
  });
  let v = s.view('2026-10-01', '2026-10-01');
  const use = v.find((r) => r.kind === 'chat');
  assert.deepEqual([use.listUSD, use.billedUSD, use.center, use.priceVersion], [2, 0, 'b', 2]);
  assert.equal(v.find((r) => r.kind === 'plan').billedUSD, 10);
  s.put({ ...base, requests: 2, listUSD: 1.5, billedUSD: 1.5 }); // a late event, priced at the day's version
  v = s.view('2026-10-01', '2026-10-01');
  assert.equal(v.find((r) => r.kind === 'chat').listUSD, 2.5);
  assert.equal(s.view('2026-10-02', '2026-10-31').length, 0, 'out of range');
  assert.equal(s.get(base).center, 'a', 'the stored row is unchanged');
});

test('groupRows: sums by dimension, flags are "any row", amounts convert with the rate of each day', () => {
  const rows = [
    row('2026-10-01', { center: 'a', tokens: { in: 10, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }),
    row('2026-10-01', { center: 'b', model: 'm2', listUSD: 2, billedUSD: 0, unpriced: true }),
    row('2026-10-02', { center: 'a', listUSD: 4, billedUSD: 4, backfilled: true }),
  ];
  const g = L.groupRows(rows, { groupBy: ['center'] });
  assert.deepEqual(
    g.rows.map((x) => [x.center, x.requests, x.listUSD, x.billedUSD, x.unpriced, x.backfilled, x.tokens.in]),
    [
      ['a', 2, 5, 5, false, true, 10],
      ['b', 1, 2, 0, true, false, 0],
    ],
  );
  assert.deepEqual(g.totals, { requests: 3, listUSD: 7, billedUSD: 5 });
  const c = L.groupRows(rows, { groupBy: ['day'], rateOf: (d) => (d === '2026-10-01' ? 16000 : null) });
  assert.deepEqual(
    c.rows.map((x) => [x.day, x.list, x.billed]),
    [
      ['2026-10-01', 48000, 16000],
      ['2026-10-02', null, null],
    ],
  );
  assert.equal(c.missingRate, 1);
  assert.deepEqual([c.totals.list, c.totals.billed, c.totals.listUSD], [null, null, 7]);
});

test('keys: geo and plan are part of the key, baseKey leaves the center out, mergeRows adds', () => {
  assert.notEqual(L.rowKey(row('2026-10-01')), L.rowKey(row('2026-10-01', { geo: 'us' })));
  assert.equal(L.baseKey(row('2026-10-01', { center: 'a' })), L.baseKey(row('2026-10-01', { center: 'b' })));
  const m = L.mergeRows(row('2026-10-01', { unpriced: true }), row('2026-10-01', { priceVersion: 3 }));
  assert.deepEqual([m.requests, m.listUSD, m.billedUSD, m.priceVersion, m.unpriced], [2, 2, 2, 3, true]);
  assert.equal(L.tokenTotal({ tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 } }), 15);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-ledger.test.js`
Expected: FAIL with `Cannot find module '../lib/cost/ledger'`.

- [ ] **Step 3: Write `lib/cost/ledger.js`**

```js
// The cost ledger store: one row per day and dimension tuple in <dir>/ledger-YYYY-MM.jsonl, plus the corrections a
// restate appends to <dir>/corrections.jsonl. Rows hold numbers and names only. A month file is rewritten whole
// (temp file + rename) when one of its rows changes; a line that does not load is moved to ledger-YYYY-MM.jsonl.bad and
// the month still loads. Readers apply the corrections on top of the stored rows, which a restate never rewrites.
// With dir null (demo) everything stays in memory.
const fs = require('fs');
const path = require('path');
const { isDay, monthOf } = require('./days');
const { SOURCES, planFee } = require('./rules');
const { writePrivate, appendPrivate } = require('./files');

const DIMS = ['day', 'source', 'provider', 'model', 'project', 'center', 'keyId', 'agent', 'kind'];
const KEY_FIELDS = [...DIMS, 'geo', 'plan'];
const TOKENS = ['in', 'out', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

const zeroTokens = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
const rowKey = (r) => JSON.stringify(KEY_FIELDS.map((f) => r[f] ?? null));
// The key without the cost center: a late event on a closed day finds its row by it, so the day keeps its center.
const baseKey = (r) => JSON.stringify(KEY_FIELDS.filter((f) => f !== 'center').map((f) => r[f] ?? null));
const tokenTotal = (r) => TOKENS.reduce((a, f) => a + ((r.tokens && r.tokens[f]) || 0), 0);

function newRow(d) {
  return {
    day: d.day,
    source: d.source,
    provider: d.provider ?? null,
    model: d.model ?? null,
    project: d.project ?? null,
    center: d.center ?? null,
    keyId: d.keyId ?? null,
    agent: d.agent ?? null,
    kind: d.kind,
    geo: d.geo ?? null,
    plan: d.plan ?? null,
    requests: 0,
    tokens: zeroTokens(),
    webSearches: 0,
    listUSD: 0,
    billedUSD: 0,
    priceVersion: null,
    unpriced: false,
    estimated: false,
    free: false,
    backfilled: false,
  };
}
const cloneRow = (r) => ({ ...r, tokens: { ...zeroTokens(), ...(r.tokens || {}) } });

// Two rows that share a key after a re-attribution become one.
function mergeRows(a, b) {
  const out = cloneRow(a);
  out.requests += b.requests || 0;
  for (const f of TOKENS) out.tokens[f] += (b.tokens && b.tokens[f]) || 0;
  out.webSearches += b.webSearches || 0;
  out.listUSD += b.listUSD || 0;
  out.billedUSD += b.billedUSD || 0;
  out.priceVersion = Math.max(a.priceVersion || 0, b.priceVersion || 0) || null;
  out.unpriced = !!(a.unpriced || b.unpriced);
  out.estimated = !!(a.estimated || b.estimated);
  out.backfilled = !!(a.backfilled || b.backfilled);
  return out;
}

// What a source on a plan paid that day: the fee spread over the period's days. It has no center.
const planRow = (day, source, billing, backfilled) => ({
  ...newRow({ day, source, kind: 'plan', plan: billing.plan }),
  billedUSD: planFee(billing, day),
  backfilled: !!backfilled,
});

const validRow = (r, month) =>
  !!r &&
  typeof r === 'object' &&
  !Array.isArray(r) &&
  isDay(r.day) &&
  monthOf(r.day) === month &&
  SOURCES.includes(r.source) &&
  typeof r.kind === 'string' &&
  [r.requests, r.listUSD, r.billedUSD].every(Number.isFinite);

function createLedgerStore({ dir = null } = {}) {
  const months = new Map(); // 'YYYY-MM' -> Map(rowKey -> row)
  const dirty = new Set();
  let corrections = [];
  let bad = 0;
  const fileOf = (m) => path.join(dir, `ledger-${m}.jsonl`);
  const monthMap = (m) => {
    if (!months.has(m)) months.set(m, new Map());
    return months.get(m);
  };

  function load() {
    months.clear();
    dirty.clear();
    corrections = [];
    bad = 0;
    if (!dir) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const name of names.sort()) {
      const m = /^ledger-(\d{4}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      const rows = monthMap(m[1]);
      const badLines = [];
      for (const line of fs.readFileSync(fileOf(m[1]), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r = null;
        try {
          r = JSON.parse(line);
        } catch {
          /* kept aside below */
        }
        if (validRow(r, m[1])) rows.set(rowKey(r), cloneRow(r));
        else badLines.push(line);
      }
      if (badLines.length) {
        // Kept aside, not lost; the month is written again without them on the next flush.
        appendPrivate(`${fileOf(m[1])}.bad`, badLines.map((l) => l + '\n').join(''));
        bad += badLines.length;
        dirty.add(m[1]);
      }
    }
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, 'corrections.jsonl'), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        if (c && Array.isArray(c.rows)) corrections.push(c);
        else bad++;
      } catch {
        bad++; // a torn last line from a crash mid-append
      }
    }
  }

  const range = (from, to) => {
    const out = [];
    for (const [m, rows] of months)
      if (m >= monthOf(from) && m <= monthOf(to))
        for (const r of rows.values()) if (r.day >= from && r.day <= to) out.push(cloneRow(r));
    return out;
  };

  // The rows of [from, to] as readers see them: every correction applied in the order it was made (R13).
  function view(from, to) {
    const out = new Map(range(from, to).map((r) => [rowKey(r), { ...r, key: rowKey(r) }]));
    for (const c of corrections) {
      if (c.to < from || c.from > to) continue;
      for (const x of c.rows) {
        if (!x || typeof x.key !== 'string' || !x.after) continue;
        if (!x.before) {
          if (x.row && x.row.day >= from && x.row.day <= to) out.set(x.key, { ...cloneRow(x.row), key: x.key });
          continue;
        }
        const r = out.get(x.key);
        if (!r) continue;
        r.listUSD += x.after.listUSD - x.before.listUSD;
        r.billedUSD += x.after.billedUSD - x.before.billedUSD;
        r.priceVersion = x.after.priceVersion;
        r.center = x.after.center;
        r.unpriced = !!x.after.unpriced;
      }
    }
    return [...out.values()];
  }

  return {
    load,
    get(d) {
      const r = (months.get(monthOf(d.day)) || new Map()).get(rowKey(d));
      return r ? cloneRow(r) : null;
    },
    put(r) {
      const m = monthOf(r.day);
      monthMap(m).set(rowKey(r), cloneRow(r));
      dirty.add(m);
    },
    remove(r) {
      const m = monthOf(r.day);
      if (monthMap(m).delete(rowKey(r))) dirty.add(m);
    },
    day: (day) => range(day, day),
    range,
    all: () => [...months.values()].flatMap((rows) => [...rows.values()].map(cloneRow)),
    earliestDay(source) {
      let first = null;
      for (const rows of months.values())
        for (const r of rows.values()) if (r.source === source && r.kind !== 'plan' && (!first || r.day < first)) first = r.day;
      return first;
    },
    flush() {
      for (const m of [...dirty]) {
        if (dir) writePrivate(fileOf(m), [...monthMap(m).values()].map((r) => JSON.stringify(r) + '\n').join(''));
        dirty.delete(m);
      }
    },
    corrections: () => corrections.slice(),
    addCorrection(c) {
      if (dir) appendPrivate(path.join(dir, 'corrections.jsonl'), JSON.stringify(c) + '\n');
      corrections.push(c);
    },
    view,
    badLines: () => bad,
  };
}

// Rows summed by the dimensions asked for (R15). With `rateOf` (day → units per USD, or null) each group also carries
// its amounts in the display currency; a day without a rate makes that group's (and the totals') amounts null (R14).
function groupRows(rows, { groupBy = ['day'], rateOf = null } = {}) {
  const groups = new Map();
  const missing = new Set();
  const totals = { requests: 0, listUSD: 0, billedUSD: 0, ...(rateOf ? { list: 0, billed: 0 } : {}) };
  for (const r of rows) {
    const k = JSON.stringify(groupBy.map((d) => r[d] ?? null));
    let g = groups.get(k);
    if (!g) {
      g = {
        ...Object.fromEntries(groupBy.map((d) => [d, r[d] ?? null])),
        requests: 0,
        tokens: zeroTokens(),
        webSearches: 0,
        listUSD: 0,
        billedUSD: 0,
        unpriced: false,
        estimated: false,
        backfilled: false,
        ...(rateOf ? { list: 0, billed: 0 } : {}),
      };
      groups.set(k, g);
    }
    g.requests += r.requests || 0;
    for (const f of TOKENS) g.tokens[f] += (r.tokens && r.tokens[f]) || 0;
    g.webSearches += r.webSearches || 0;
    g.listUSD += r.listUSD || 0;
    g.billedUSD += r.billedUSD || 0;
    g.unpriced = g.unpriced || !!r.unpriced;
    g.estimated = g.estimated || !!r.estimated;
    g.backfilled = g.backfilled || !!r.backfilled;
    totals.requests += r.requests || 0;
    totals.listUSD += r.listUSD || 0;
    totals.billedUSD += r.billedUSD || 0;
    if (!rateOf) continue;
    const rate = rateOf(r.day);
    if (rate == null) {
      missing.add(r.day);
      g.list = g.billed = totals.list = totals.billed = null;
      continue;
    }
    if (g.list !== null) {
      g.list += (r.listUSD || 0) * rate;
      g.billed += (r.billedUSD || 0) * rate;
    }
    if (totals.list !== null) {
      totals.list += (r.listUSD || 0) * rate;
      totals.billed += (r.billedUSD || 0) * rate;
    }
  }
  const usd = (v) => Math.round(v * 1e8) / 1e8;
  const cur = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4);
  const money = (x) => ({
    ...x,
    listUSD: usd(x.listUSD),
    billedUSD: usd(x.billedUSD),
    ...(rateOf ? { list: cur(x.list), billed: cur(x.billed) } : {}),
  });
  const out = [...groups.values()].map(money);
  out.sort(
    (a, b) =>
      String(a.day ?? '').localeCompare(String(b.day ?? '')) || b.listUSD + b.billedUSD - (a.listUSD + a.billedUSD),
  );
  return { rows: out, totals: money(totals), missingRate: missing.size };
}

module.exports = {
  DIMS,
  KEY_FIELDS,
  TOKENS,
  newRow,
  cloneRow,
  rowKey,
  baseKey,
  tokenTotal,
  mergeRows,
  planRow,
  createLedgerStore,
  groupRows,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/cost-ledger.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cost/ledger.js test/cost-ledger.test.js
git commit -m "Cost ledger: monthly row store with .bad quarantine, corrections view and grouping with currency"
```

---

### Task 6: The ledger pass

**Files:**
- Create: `lib/cost/index.js` (`restate` is added in Task 7)
- Test: `test/cost-pass.test.js`

**Interfaces:**
- Consumes everything from Tasks 1–5:
  - from `collect.js`: `localEvents`, `gatewayEvent`, `judgeEvent`, `judgeLine`, `priceEvent`, `readNew`;
  - from `rules.js`: `settingsOf`, `compile`, `rateFor`;
  - from `prices.js`: `createPriceVersions`;
  - `L.*` from `ledger.js`;
  - from `files.js`: `writePrivate`, `appendPrivate`, `readJson`;
  - `normalizeModel` from `lib/pricing.js`.
- Produces: `createCost(options)`.

  Options:
  - `dir`: the ledger folder; `null` keeps everything in memory;
  - `gatewayLog`: the gateway log path, or `null`;
  - `entries() → [{ file, size, mtimeMs, result }]` (indexer entries);
  - `getPricing() → pricing`, `getSettings() → raw cost section`;
  - `isPrivate(providerId) → boolean`;
  - `home`, `now`, `nocase`;
  - `demo`: the `costDemo()` object or `null`.

  It returns:
  - `update() → status`: the pass; in demo, the status only;
  - `recordJudge({ kind, provider, model, usage })`: appends to `<dir>/judge-calls.jsonl`; no-op in demo or memory;
  - `ledger({ from, to, groupBy, currency }) → R15 body`;
  - `status() → R15 status`;
  - `versions() → { current, versions }`;
  - `retag()`: today's rows to the current settings, then a flush;
  - `restate`, added in Task 7.

- [ ] **Step 1: Write the failing test**

```js
// test/cost-pass.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (d, h = 12, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026, local time
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-pass-'));
// One Claude Code API response of Sonnet: 1,000 in and 100 out (0.003 at PRICE_A, 0.006 at PRICE_B).
const ev = (ts, key, sid = 's1') => [ts, 'claude', sid, 'claude-sonnet-5-5', 1000, 100, 0, 0, 0, 0, key, null];
const session = (sid, folder, tool = 'claude') => ({
  [sid]: { tool, project: path.join(HOME, ...folder.split('/')), tools: {}, skills: {}, agents: {}, prompts: 0, subagentFiles: 0 },
});
const file = (name, events, sessions = session('s1', 'work/acme')) => ({
  file: `/logs/${name}.jsonl`,
  source: 'claude',
  size: events.length,
  mtimeMs: 1,
  result: { events, sessions },
});
const gwLine = (ts, extra = {}) =>
  JSON.stringify({
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
  }) + '\n';

function rig({ settings, pricing = PRICE_A, day = 22 } = {}) {
  const dir = tmp();
  const st = { entries: [], pricing, settings, t: at(day) };
  const costDir = path.join(dir, 'cost');
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const make = () =>
    createCost({
      dir: costDir,
      gatewayLog,
      entries: () => st.entries,
      getPricing: () => st.pricing,
      getSettings: () => st.settings,
      isPrivate: (id) => id === 'ollama',
      home: HOME,
      now: () => st.t,
      nocase: false,
    });
  return { st, costDir, gatewayLog, make, cost: make() };
}
const rowsOf = (cost, from, to, groupBy) => cost.ledger({ from, to, groupBy }).rows;
const stored = (costDir) =>
  fs
    .readFileSync(path.join(costDir, 'ledger-2026-10.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test("first pass: history is filled with today's prices and marked backfilled; today is not", () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1'), ev(at(22), 'm2')]));
  r.cost.update();
  const rows = rowsOf(r.cost, '2026-10-01', '2026-10-31', ['day', 'project', 'center']);
  assert.deepEqual(
    rows.map((x) => [x.day, x.project, x.center, x.backfilled]),
    [
      ['2026-10-20', '~/work/acme', 'unassigned', true],
      ['2026-10-22', '~/work/acme', 'unassigned', false],
    ],
  );
  near(rows[0].listUSD, 0.003);
  near(rows[0].billedUSD, 0.003);
  const st = r.cost.status();
  assert.deepEqual(st.backfill, { firstDay: '2026-10-22', rows: 1 });
  assert.equal(st.priceVersion.id, 1);
  assert.equal(st.collectors.local.error, null);
});

test('freezing: after a price change yesterday keeps its price and today uses the new one', () => {
  const r = rig({ day: 21 });
  r.st.entries.push(file('a', [ev(at(21), 'm1')]));
  r.cost.update();
  r.st.t = at(22);
  r.st.pricing = PRICE_B;
  r.st.entries.push(file('b', [ev(at(22), 'm2')]));
  r.cost.update();
  const [d21, d22] = rowsOf(r.cost, '2026-10-21', '2026-10-22', ['day']);
  near(d21.listUSD, 0.003);
  near(d22.listUSD, 0.006);
  assert.deepEqual(
    stored(r.costDir)
      .map((x) => [x.day, x.priceVersion])
      .sort(),
    [
      ['2026-10-21', 1],
      ['2026-10-22', 2],
    ],
  );
  const v = r.cost.versions();
  assert.equal(v.current, 2);
  assert.deepEqual(
    v.versions.map((x) => [x.id, x.from, x.changed]),
    [
      [1, '2026-10-21', []],
      [2, '2026-10-22', ['claude-sonnet-5-5']],
    ],
  );
});

test("late events land on their own day with that day's price version", () => {
  const r = rig({ day: 21 });
  r.st.entries.push(file('a', [ev(at(21, 9), 'm1')]));
  fs.writeFileSync(r.gatewayLog, gwLine(at(21, 9)));
  r.cost.update();
  r.st.t = at(22, 0, 5);
  r.st.pricing = PRICE_B;
  r.cost.update();
  r.st.entries.push(file('late', [ev(at(21, 23), 'm9')])); // a log indexed after its day ended
  fs.appendFileSync(r.gatewayLog, gwLine(at(21, 23, 59)));
  r.cost.update();
  const rows = rowsOf(r.cost, '2026-10-21', '2026-10-21', ['source']);
  const claude = rows.find((x) => x.source === 'claude');
  const gw = rows.find((x) => x.source === 'gateway');
  assert.equal(claude.requests, 2);
  near(claude.listUSD, 0.006); // 2 × 0.003, at version 1
  assert.equal(gw.requests, 2);
  near(gw.listUSD, 0.006);
  for (const x of stored(r.costDir).filter((y) => y.day === '2026-10-21')) {
    assert.equal(x.priceVersion, 1);
    assert.equal(x.backfilled, false);
  }
});

test('a resumed or forked session counts once, and a closed day never shrinks when its log is gone', () => {
  const r = rig({ day: 21 });
  r.st.entries.push(file('a', [ev(at(21), 'm1')]), file('resumed', [ev(at(21), 'm1', 's2')], session('s2', 'work/acme')));
  r.cost.update();
  assert.equal(rowsOf(r.cost, '2026-10-21', '2026-10-21', ['day'])[0].requests, 1);
  r.st.t = at(22);
  r.st.entries = []; // Claude Code removed the old transcripts
  r.cost.update();
  const [d21] = rowsOf(r.cost, '2026-10-21', '2026-10-21', ['day']);
  assert.equal(d21.requests, 1);
  near(d21.listUSD, 0.003);
});

test('gateway log: each line is read once across passes, a rotation and a restart; a torn last line waits', () => {
  const r = rig();
  fs.writeFileSync(r.gatewayLog, gwLine(at(22, 1)) + gwLine(at(22, 2)));
  r.cost.update();
  fs.appendFileSync(r.gatewayLog, gwLine(at(22, 3)));
  fs.renameSync(r.gatewayLog, `${r.gatewayLog}.1`);
  const fifth = gwLine(at(22, 5));
  fs.writeFileSync(r.gatewayLog, gwLine(at(22, 4)) + fifth.slice(0, 20));
  r.cost.update();
  assert.equal(rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source'])[0].requests, 4);
  fs.appendFileSync(r.gatewayLog, fifth.slice(20));
  r.cost.update();
  assert.equal(rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source'])[0].requests, 5);
  const again = r.make(); // cursors.json carries the place
  again.update();
  assert.equal(rowsOf(again, '2026-10-22', '2026-10-22', ['source'])[0].requests, 5);
});

test('gateway lines: replay, judge and collaboration calls are told apart; failed attempts and private models cost nothing', () => {
  const r = rig();
  fs.writeFileSync(
    r.gatewayLog,
    [
      gwLine(at(22), { keyId: 'dashboard', agent: 'replay', kind: 'agent' }),
      gwLine(at(22), { keyId: 'dashboard', agent: 'judge', kind: 'agent' }),
      gwLine(at(22), { keyId: 'dashboard', agent: 'planner', kind: 'agent', runId: 'run_1' }),
      gwLine(at(22), { kind: 'embeddings', output: 0 }),
      gwLine(at(22), { status: 599, input: 0, output: 0, error: 'down' }),
      gwLine(at(22), { provider: 'ollama', model: 'ollama/qwen3:8b' }),
    ].join(''),
  );
  r.cost.update();
  const rows = rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source', 'kind', 'agent', 'keyId', 'provider']);
  assert.deepEqual(rows.map((x) => `${x.source}|${x.kind}|${x.agent}|${x.keyId}|${x.provider}`).sort(), [
    'collab|run|planner|null|openrouter',
    'gateway|chat|null|key_a|ollama',
    'gateway|embed|null|key_a|openrouter',
    'judge|judge|null|null|openrouter',
    'replay|replay|null|null|openrouter',
  ]);
  const local = rows.find((x) => x.provider === 'ollama');
  assert.deepEqual([local.listUSD, local.unpriced], [0, false]);
  near(rows.find((x) => x.kind === 'embed').listUSD, 0.002);
});

test('judge calls outside the gateway are recorded once; external ones are left to the gateway log', () => {
  const r = rig();
  const usage = { input: 1600, output: 40, cost: 0.01, cacheRead: 100, cacheWrite: 1500 };
  r.cost.recordJudge({ kind: 'claude-cli', provider: 'claude-code', model: 'claude-sonnet-5-5', usage });
  r.cost.recordJudge({ kind: 'external', provider: 'openrouter', model: 'x/y', usage: { input: 10, output: 5, cost: 0 } });
  r.cost.recordJudge({ kind: 'ollama', provider: 'ollama', model: 'qwen3:8b', usage: { input: 900, output: 30, cost: 0 } });
  r.cost.update();
  r.cost.update();
  const rows = rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source', 'provider', 'model']);
  assert.equal(rows.length, 2);
  const cc = rows.find((x) => x.provider === 'claude-code');
  assert.equal(cc.requests, 1);
  assert.deepEqual(cc.tokens, { in: 0, out: 40, cacheRead: 100, cacheWrite5m: 1500, cacheWrite1h: 0 });
  near(cc.listUSD, (40 * 10 + 100 * 0.2 + 1500 * 2.5) / 1e6);
  assert.equal(rows.find((x) => x.provider === 'ollama').listUSD, 0);
  const lines = fs.readFileSync(path.join(r.costDir, 'judge-calls.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
});

test('plans: the fee is spread per day, usage shows value received, and nothing is counted twice', () => {
  const r = rig({ settings: { billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' } } } });
  r.st.entries.push(file('a', [ev(at(21), 'm1'), ev(at(22), 'm2')]));
  r.st.entries.push({
    file: '/logs/codex.jsonl',
    source: 'codex',
    size: 1,
    mtimeMs: 1,
    result: { events: [[at(22), 'codex', 'c1', 'claude-sonnet-5-5', 1000, 100, 0, 0, 0, 0, null, null]], sessions: session('c1', 'm', 'codex') },
  });
  r.cost.update();
  r.cost.update(); // a second pass adds nothing
  const rows = rowsOf(r.cost, '2026-10-21', '2026-10-22', ['source', 'kind']);
  const use = rows.find((x) => x.source === 'claude' && x.kind === 'chat');
  const plan = rows.find((x) => x.source === 'claude' && x.kind === 'plan');
  const codex = rows.find((x) => x.source === 'codex');
  near(use.listUSD, 0.006);
  assert.equal(use.billedUSD, 0);
  near(plan.billedUSD, 20); // 310 / 31 for each of the 21st and the 22nd
  assert.deepEqual([plan.listUSD, plan.requests], [0, 0]);
  near(codex.listUSD, 0.003);
  near(codex.billedUSD, 0.003);
  const t = r.cost.ledger({ from: '2026-10-21', to: '2026-10-22', groupBy: ['day'] }).totals;
  near(t.listUSD, 0.009);
  near(t.billedUSD, 20.003);
  r.st.settings = { billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 365, period: 'year' } } };
  r.cost.update();
  near(rowsOf(r.cost, '2026-10-22', '2026-10-22', ['kind']).find((x) => x.kind === 'plan').billedUSD, 1);
  near(rowsOf(r.cost, '2026-10-21', '2026-10-21', ['kind']).find((x) => x.kind === 'plan').billedUSD, 10);
});

test("attribution: the key's center, then the first matching folder rule, then Unassigned; only today follows a change", () => {
  const settings = {
    centers: [
      { id: 'acme', name: 'Acme' },
      { id: 'lab', name: 'Lab' },
      { id: 'work', name: 'Work' },
    ],
    keyCenters: { key_a: 'lab' },
    folderRules: [
      { glob: '~/work/acme/**', center: 'acme' },
      { glob: '~/work/**', center: 'work' },
    ],
  };
  const r = rig({ settings, day: 21 });
  r.st.entries.push(
    file('a', [ev(at(21), 'm1')], session('s1', 'work/acme/api')),
    file('b', [ev(at(21), 'm2', 's2')], session('s2', 'work/other')),
    file('c', [ev(at(21), 'm3', 's3')], session('s3', 'play')),
  );
  fs.writeFileSync(r.gatewayLog, gwLine(at(21)));
  r.cost.update();
  const centers = (d) =>
    Object.fromEntries(rowsOf(r.cost, d, d, ['source', 'project', 'center']).map((x) => [`${x.source} ${x.project}`, x.center]));
  assert.deepEqual(centers('2026-10-21'), {
    'claude ~/work/acme/api': 'acme',
    'claude ~/work/other': 'work',
    'claude ~/play': 'unassigned',
    'gateway null': 'lab',
  });
  r.st.t = at(22);
  r.st.settings = { ...settings, folderRules: [{ glob: '~/**', center: 'work' }] };
  r.st.entries.push(file('d', [ev(at(22), 'm4', 's4')], session('s4', 'play')));
  r.cost.update();
  assert.equal(centers('2026-10-21')['claude ~/play'], 'unassigned', 'a closed day keeps its center');
  assert.equal(centers('2026-10-22')['claude ~/play'], 'work');
});

test('an invalid cost section means the defaults and the status says so; a failing collector stops nothing else', () => {
  const r = rig({ settings: { centers: 'nope' } });
  fs.mkdirSync(r.gatewayLog); // a folder where the log should be: reading it fails
  r.st.entries.push(file('a', [ev(at(22), 'm1')]));
  const st = r.cost.update();
  assert.match(st.settings.error, /invalid/);
  assert.match(st.collectors.gateway.error, /^the gateway log could not be read \(E[A-Z]+\)$/);
  assert.equal(st.collectors.local.error, null);
  assert.equal(rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source']).length, 1);
  assert.doesNotMatch(JSON.stringify(st), /Users|zp-cost-pass/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(r.costDir).mode & 0o777, 0o700);
    for (const f of ['ledger-2026-10.jsonl', 'cursors.json']) assert.equal(fs.statSync(path.join(r.costDir, f)).mode & 0o777, 0o600, f);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-pass.test.js`
Expected: FAIL with `Cannot find module '../lib/cost'`.

- [ ] **Step 3: Write `lib/cost/index.js`**

```js
// Cost Control, sub-project 1: the cost ledger. After each index refresh `update()` reads what is new in every source,
// prices it with the version of its day, attributes it to a cost center and stores daily rows (lib/cost/ledger.js).
// Today stays open: its rows follow new events, the current prices and the current rules. A past day is closed: it
// only grows by late events, priced with that day's version, and changes otherwise only through a restate.
const path = require('path');
const { normalizeModel } = require('../pricing');
const { dayOf, addDays, daysBetween, isDay } = require('./days');
const { SOURCES, settingsOf, compile, rateFor } = require('./rules');
const { createPriceVersions } = require('./prices');
const { localEvents, gatewayEvent, judgeEvent, judgeLine, priceEvent, readNew } = require('./collect');
const L = require('./ledger');
const { writePrivate, appendPrivate, readJson } = require('./files');

const LOCAL = new Set(['claude', 'codex']);
const COLLECTORS = {
  local: { sources: ['claude', 'codex'], label: 'the log index' },
  gateway: { sources: ['gateway', 'replay', 'collab', 'judge'], label: 'the gateway log' },
  judge: { sources: ['judge'], label: 'the judge call log' },
};
const fail = (status, message) => Object.assign(new Error(message), { status });
// A fixed phrase and the error code: never a path.
const failure = (what, e) => `${what}${e && typeof e.code === 'string' ? ` (${e.code})` : ''}`;

function createCost({
  dir = null,
  gatewayLog = null,
  entries = () => [],
  getPricing = () => ({}),
  getSettings = () => undefined,
  isPrivate = () => false,
  home = '',
  now = Date.now,
  nocase,
  demo = null,
} = {}) {
  const store = L.createLedgerStore({ dir });
  const prices = createPriceVersions({ dir: dir && path.join(dir, 'prices'), now });
  const cursorFile = dir && path.join(dir, 'cursors.json');
  const judgeFile = dir && path.join(dir, 'judge-calls.jsonl');
  let cursors = (cursorFile && readJson(cursorFile, null)) || {};
  if (typeof cursors !== 'object' || Array.isArray(cursors)) cursors = {};
  const status = Object.fromEntries(
    Object.keys(COLLECTORS).map((k) => [k, { at: (cursors[k] && cursors[k].at) || null, read: 0, total: 0, error: null }]),
  );
  let storeError = null;
  let settingsError = null;
  const seenFiles = new Map(); // indexed file -> `${mtimeMs}:${size}` at the last local pass (this process)
  let localVersion = null; // the price version today's local rows were last built with
  const sticky = new Map(); // day -> Map(baseKey -> center), rebuilt each pass

  try {
    store.load();
  } catch (e) {
    storeError = failure('the ledger could not be read', e);
  }
  if (demo) {
    prices.seed(demo.versions);
    for (const r of demo.rows) store.put(r);
    cursors.firstDay = demo.firstDay;
    for (const [k, v] of Object.entries(demo.collectors || {})) Object.assign(status[k], v);
  }

  function settingsNow() {
    const s = settingsOf(getSettings(), { home });
    settingsError = s.error;
    return { value: s.value, rules: compile(s.value, nocase === undefined ? {} : { nocase }) };
  }
  const backfilledDay = (day) => isDay(cursors.firstDay) && day < cursors.firstDay;
  const dimsOf = (ev, day) => ({
    day,
    source: ev.source,
    provider: ev.provider,
    model: normalizeModel(ev.model) || null,
    project: ev.project,
    keyId: ev.keyId,
    agent: ev.agent,
    kind: ev.kind,
    geo: ev.geo,
    plan: null,
  });
  // Today uses the rules; a closed day keeps the center its rows already have, and a new row on it uses the rules.
  function centerFor(dims, ev, today, rules) {
    if (dims.day === today) return rules.centerOf(ev);
    let m = sticky.get(dims.day);
    if (!m) {
      m = new Map();
      for (const r of store.day(dims.day)) if (r.kind !== 'plan') m.set(L.baseKey(r), r.center);
      sticky.set(dims.day, m);
    }
    const bk = L.baseKey(dims);
    if (!m.has(bk)) m.set(bk, rules.centerOf(ev));
    return m.get(bk);
  }
  // Today and backfilled days use the current billing; a closed day keeps its mode (a plan row says it was on a plan).
  function billingFor(day, source, today, rules) {
    if (day === today || backfilledDay(day)) return rules.billingOf(source);
    return store.day(day).some((r) => r.kind === 'plan' && r.source === source) ? { mode: 'plan' } : { mode: 'metered' };
  }
  function addEvent(row, ev, version, billing) {
    const p = priceEvent(prices.pricerFor(version.id), ev);
    row.requests += 1;
    for (const f of L.TOKENS) row.tokens[f] += ev.tokens[f] || 0;
    row.webSearches += ev.webSearches || 0;
    row.listUSD += p.listUSD;
    row.billedUSD += billing.mode === 'plan' ? 0 : p.listUSD;
    row.unpriced = row.unpriced || p.unpriced;
    row.estimated = row.estimated || p.estimated;
    row.free = !!ev.free;
    row.priceVersion = version.id;
    row.backfilled = backfilledDay(row.day);
  }

  // Local logs: the days whose files changed (and all of today after a price change) are rebuilt from the deduplicated
  // events. Today is replaced; a closed day takes a rebuilt row only when it grew (logs that were deleted never shrink it).
  function localPass(today, s) {
    const list = entries() || [];
    const days = new Set();
    const live = new Set();
    for (const e of list) {
      live.add(e.file);
      const stamp = `${e.mtimeMs}:${e.size}`;
      if (seenFiles.get(e.file) === stamp) continue;
      seenFiles.set(e.file, stamp);
      for (const x of (e.result && e.result.events) || []) if (Number.isFinite(x[0])) days.add(dayOf(x[0]));
    }
    for (const f of [...seenFiles.keys()]) if (!live.has(f)) seenFiles.delete(f);
    const todayVersion = prices.versionFor(today);
    if (todayVersion.id !== localVersion) days.add(today);
    localVersion = todayVersion.id;
    if (!days.size) return 0;
    const byDay = new Map();
    for (const ev of localEvents(list.map((e) => e.result), { home })) {
      const day = dayOf(ev.ts);
      if (!days.has(day)) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(ev);
    }
    let read = 0;
    for (const day of days) {
      const version = prices.versionFor(day);
      const computed = new Map();
      for (const ev of byDay.get(day) || []) {
        const dims = dimsOf(ev, day);
        dims.center = centerFor(dims, ev, today, s.rules);
        const k = L.rowKey(dims);
        if (!computed.has(k)) computed.set(k, L.newRow(dims));
        addEvent(computed.get(k), ev, version, billingFor(day, ev.source, today, s.rules));
        read++;
      }
      if (day === today) {
        for (const r of store.day(day)) if (LOCAL.has(r.source)) store.remove(r);
        for (const r of computed.values()) store.put(r);
        continue;
      }
      for (const r of computed.values()) {
        const have = store.get(r);
        if (!have || r.requests > have.requests || L.tokenTotal(r) > L.tokenTotal(have)) store.put(r);
      }
    }
    return read;
  }

  // An append-only log read from its cursor. Rows are staged and stored only once the whole read succeeded, so a failure
  // leaves both the rows and the cursor as they were.
  function additivePass(name, file, toEvent, today, s) {
    if (!file) return 0;
    const got = readNew(file, cursors[name]);
    const staged = new Map();
    let read = 0;
    for (const raw of got.rows) {
      const ev = toEvent(raw);
      if (!ev) continue;
      const day = dayOf(ev.ts);
      const dims = dimsOf(ev, day);
      dims.center = centerFor(dims, ev, today, s.rules);
      const k = L.rowKey(dims);
      if (!staged.has(k)) staged.set(k, store.get(dims) || L.newRow(dims));
      addEvent(staged.get(k), ev, prices.versionFor(day), billingFor(day, ev.source, today, s.rules));
      read++;
    }
    for (const row of staged.values()) store.put(row);
    cursors[name] = { ...got.cursor };
    return read;
  }

  function planPass(today, s) {
    const plans = cursors.plans && typeof cursors.plans === 'object' ? cursors.plans : {};
    cursors.plans = plans;
    for (const source of SOURCES) {
      const b = s.rules.billingOf(source);
      const last = plans[source] && isDay(plans[source].lastDay) ? plans[source].lastDay : null;
      if (b.mode === 'plan') {
        // Days the server was off get the current plan; the first time, from the source's first day in the ledger.
        const start = last ? addDays(last, 1) : store.earliestDay(source) || today;
        for (const day of daysBetween(start < today ? start : today, today)) {
          const have = store.day(day).filter((r) => r.kind === 'plan' && r.source === source);
          if (day !== today && have.length) continue;
          for (const r of have) store.remove(r);
          store.put(L.planRow(day, source, b, backfilledDay(day)));
        }
      } else for (const r of store.day(today)) if (r.kind === 'plan' && r.source === source) store.remove(r);
      plans[source] = { lastDay: today };
    }
  }

  // Today follows the current rules and billing modes, whichever pass wrote its rows.
  function retagToday(today, s) {
    for (const r of store.day(today)) {
      if (r.kind === 'plan') continue;
      const center = s.rules.centerOf(r);
      const billedUSD = s.rules.billingOf(r.source).mode === 'plan' ? 0 : r.listUSD;
      if (center === r.center && billedUSD === r.billedUSD) continue;
      store.remove(r);
      const next = { ...r, center, billedUSD };
      const have = store.get(next);
      store.put(have ? L.mergeRows(have, next) : next);
    }
  }

  function run(name, fn) {
    const st = status[name];
    try {
      const n = fn();
      st.at = now();
      st.read = n;
      st.total += n;
      st.error = null;
      cursors[name] = { ...(cursors[name] || {}), at: st.at };
    } catch (e) {
      st.error = failure(`${COLLECTORS[name].label} could not be read`, e);
    }
  }

  function save() {
    try {
      store.flush();
      // After the rows: a crash between the two writes can only make the next pass read those lines again.
      if (cursorFile) writePrivate(cursorFile, JSON.stringify({ ...cursors, version: 1 }));
      storeError = null;
    } catch (e) {
      storeError = failure('the ledger could not be written', e);
    }
  }

  function update() {
    if (demo) return statusOf();
    const today = dayOf(now());
    const s = settingsNow();
    try {
      prices.observe(getPricing() || {}, today);
    } catch (e) {
      storeError = failure('the price versions could not be written', e);
      return statusOf();
    }
    if (!isDay(cursors.firstDay)) cursors.firstDay = today;
    sticky.clear();
    run('local', () => localPass(today, s));
    run('gateway', () => additivePass('gateway', gatewayLog, (line) => gatewayEvent(line, { isPrivate }), today, s));
    run('judge', () => additivePass('judge', judgeFile, judgeEvent, today, s));
    planPass(today, s);
    retagToday(today, s);
    save();
    return statusOf();
  }

  function recordJudge(call) {
    if (demo || !judgeFile) return;
    try {
      const line = judgeLine(call || {}, now());
      if (line) appendPrivate(judgeFile, JSON.stringify(line) + '\n');
    } catch {
      /* the ledger must never break judging */
    }
  }

  function statusOf() {
    settingsNow();
    let rows = 0;
    let requests = 0;
    let backfilled = 0;
    for (const r of store.all()) {
      if (r.unpriced) {
        rows++;
        requests += r.requests;
      }
      if (r.backfilled) backfilled++;
    }
    const v = prices.current();
    return {
      demo: !!demo,
      collectors: Object.fromEntries(
        Object.entries(COLLECTORS).map(([k, c]) => [k, { sources: c.sources, ...status[k] }]),
      ),
      priceVersion: v ? { id: v.id, from: v.from, hash: v.hash } : null,
      unpriced: { rows, requests },
      backfill: { firstDay: isDay(cursors.firstDay) ? cursors.firstDay : null, rows: backfilled },
      settings: { error: settingsError },
      ledger: { badLines: store.badLines(), corrections: store.corrections().length, error: storeError },
    };
  }

  function ledger({ from, to, groupBy = ['day'], currency = null }) {
    const s = settingsNow();
    const rateOf = currency ? (day) => rateFor(s.value.currency, day) : null;
    const g = L.groupRows(store.view(from, to), { groupBy, rateOf });
    return {
      from,
      to,
      groupBy,
      currency: currency || 'USD',
      rows: g.rows,
      totals: g.totals,
      missingRate: g.missingRate,
      corrections: store.corrections().filter((c) => c.from <= to && c.to >= from).length,
    };
  }

  function retag() {
    retagToday(dayOf(now()), settingsNow());
    save();
  }

  const versions = () => {
    const v = prices.current();
    return {
      current: v ? v.id : null,
      versions: prices.list().map(({ id, from, at, hash, changed, changedCount }) => ({ id, from, at, hash, changed, changedCount })),
    };
  };

  return { update, recordJudge, ledger, status: statusOf, versions, retag };
}

module.exports = { createCost };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/cost-pass.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the cost tests together**

Run: `node --test test/cost-*.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/cost/index.js test/cost-pass.test.js
git commit -m "Cost ledger: the pass (open today, closed days, late events, plans, attribution, status)"
```

---

### Task 7: Restate and corrections

**Files:**
- Modify: `lib/cost/ledger.js` (add `repriceRow` and `restate`, and export them); `lib/cost/index.js` (add `restate` to the returned object)
- Test: `test/cost-restate.test.js`

**Interfaces:**
- Consumes:
  - `createCost` from Task 6;
  - `store.view` and `store.addCorrection` from Task 5;
  - `compile` (`rules.centerOf`, `rules.billingOf`), `planFee` and `SOURCES` from Task 1;
  - `daysBetween`.
- Produces:
  - `L.repriceRow(row, pricer) → USD`;
  - `L.restate(store, { from, to, reason, ts, version, pricer, rules, firstDay }) → correction` (R13);
  - `cost.restate({ from, to, reason }) → correction`. It throws `{ status: 400 }` when `from > to` or `to >= today`.

- [ ] **Step 1: Write the failing test**

```js
// test/cost-restate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const ev = (ts, key) => [ts, 'claude', 's1', 'claude-sonnet-5-5', 1000, 100, 0, 0, 0, 0, key, null];
const sessions = {
  s1: { tool: 'claude', project: path.join(HOME, 'work', 'acme'), tools: {}, skills: {}, agents: {}, prompts: 0, subagentFiles: 0 },
};
const file = (name, events) => ({ file: `/logs/${name}.jsonl`, source: 'claude', size: events.length, mtimeMs: 1, result: { events, sessions } });

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-restate-'));
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
const day = (cost, d, groupBy = ['day']) => cost.ledger({ from: d, to: d, groupBy }).rows;

test('restate: one correction with before and after; the stored rows stay; readers see the new amounts', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(21), 'm1'), ev(at(21, 13), 'm2')]));
  r.cost.update();
  r.st.t = at(22);
  r.st.pricing = PRICE_B;
  r.st.settings = { centers: [{ id: 'acme', name: 'Acme' }], folderRules: [{ glob: '~/work/**', center: 'acme' }] };
  r.cost.update();
  const c = r.cost.restate({ from: '2026-10-21', to: '2026-10-21', reason: 'Sonnet was priced wrong' });
  assert.deepEqual([c.from, c.to, c.reason, c.priceVersion, c.rows.length], ['2026-10-21', '2026-10-21', 'Sonnet was priced wrong', 2, 1]);
  const [x] = c.rows;
  near(x.before.listUSD, 0.006);
  near(x.after.listUSD, 0.012);
  assert.deepEqual([x.before.priceVersion, x.after.priceVersion, x.before.center, x.after.center], [1, 2, 'unassigned', 'acme']);
  const raw = fs
    .readFileSync(path.join(r.costDir, 'ledger-2026-10.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((y) => y.day === '2026-10-21');
  near(raw[0].listUSD, 0.006);
  assert.equal(raw[0].center, 'unassigned', 'the stored row is not rewritten');
  assert.equal(fs.readFileSync(path.join(r.costDir, 'corrections.jsonl'), 'utf8').trim().split('\n').length, 1);
  const [seen] = day(r.cost, '2026-10-21', ['center']);
  assert.equal(seen.center, 'acme');
  near(seen.listUSD, 0.012);
  assert.equal(r.cost.ledger({ from: '2026-10-21', to: '2026-10-21' }).corrections, 1);
  // A late event still counts on top of the restated amount (at the day's version: +0.003).
  r.st.entries.push(file('late', [ev(at(21, 20), 'm3')]));
  r.cost.update();
  near(day(r.cost, '2026-10-21')[0].listUSD, 0.015);
  near(day(r.make(), '2026-10-21')[0].listUSD, 0.015, 'read back after a restart');
});

test('restate onto a plan: usage is billed 0 and each day without a plan row gets one', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1'), ev(at(21), 'm2')]));
  r.cost.update(); // the 20th is backfilled, the 21st is today
  r.st.t = at(22);
  r.st.settings = { billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' } } };
  r.cost.update(); // the plan applies from today only
  assert.equal(day(r.cost, '2026-10-21', ['kind']).some((x) => x.kind === 'plan'), false);
  const c = r.cost.restate({ from: '2026-10-20', to: '2026-10-21', reason: 'we were on Max already' });
  assert.equal(c.rows.filter((x) => x.before === null).length, 2);
  const t = r.cost.ledger({ from: '2026-10-20', to: '2026-10-21', groupBy: ['kind'] });
  near(t.totals.billedUSD, 20);
  near(t.totals.listUSD, 0.006);
});

test('restate checks its range; an unchanged range still records the correction', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1')]));
  r.cost.update();
  assert.throws(() => r.cost.restate({ from: '2026-10-21', to: '2026-10-21', reason: 'x' }), { status: 400 });
  assert.throws(() => r.cost.restate({ from: '2026-10-20', to: '2026-10-19', reason: 'x' }), { status: 400 });
  const c = r.cost.restate({ from: '2026-10-20', to: '2026-10-20', reason: 'check' });
  assert.deepEqual(c.rows, []);
  assert.equal(r.cost.status().ledger.corrections, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-restate.test.js`
Expected: FAIL with `r.cost.restate is not a function`.

- [ ] **Step 3: Implement**

In `lib/cost/ledger.js`, extend the imports: `const { SOURCES, planFee } = require('./rules');` stays as it is, and `daysBetween` is added to the days import:

```js
const { isDay, monthOf, daysBetween } = require('./days');
```

Add before `module.exports`:

```js
// A row's list price at another pricer, from its daily sums: each request is taken as the row's average request (which
// also picks the prompt-length tier), times the number of requests.
function repriceRow(r, pricer) {
  const n = Math.max(1, r.requests || 0);
  const t = r.tokens || {};
  const extra = r.webSearches || r.geo ? { ws: (r.webSearches || 0) / n, geo: r.geo } : null;
  const p = pricer.parts(
    r.model,
    (t.in || 0) / n,
    (t.out || 0) / n,
    (t.cacheRead || 0) / n,
    (t.cacheWrite5m || 0) / n,
    (t.cacheWrite1h || 0) / n,
    extra,
  );
  return (p[0] + p[1] + p[2] + p[3] + p[4]) * n;
}

const differs = (a, b) =>
  Math.abs(a.listUSD - b.listUSD) > 1e-12 ||
  Math.abs(a.billedUSD - b.billedUSD) > 1e-12 ||
  a.priceVersion !== b.priceVersion ||
  a.center !== b.center ||
  a.unpriced !== b.unpriced;

// Re-prices [from, to] with the current pricing and re-attributes it with the current rules and billing modes (R13):
// one correction with the before and after of every row that changes, plus a plan row for each day of a source now on
// a plan that had none. The stored rows are never rewritten.
function restate(store, { from, to, reason, ts, version, pricer, rules, firstDay }) {
  const rows = [];
  const planDays = new Set();
  for (const r of store.view(from, to)) {
    const before = {
      listUSD: r.listUSD,
      billedUSD: r.billedUSD,
      priceVersion: r.priceVersion,
      center: r.center,
      unpriced: !!r.unpriced,
    };
    let after;
    if (r.kind === 'plan') {
      planDays.add(`${r.day}|${r.source}`);
      const b = rules.billingOf(r.source);
      after = { ...before, billedUSD: b.mode === 'plan' ? planFee(b, r.day) : 0 };
    } else {
      const priced = !!r.free || (!!r.model && pricer.priced(r.model));
      const listUSD = r.free || !priced ? 0 : repriceRow(r, pricer);
      after = {
        listUSD,
        billedUSD: rules.billingOf(r.source).mode === 'plan' ? 0 : listUSD,
        priceVersion: version.id,
        center: rules.centerOf(r),
        unpriced: !priced,
      };
    }
    if (differs(before, after)) rows.push({ key: r.key, before, after });
  }
  for (const source of SOURCES) {
    const b = rules.billingOf(source);
    if (b.mode !== 'plan') continue;
    for (const day of daysBetween(from, to)) {
      if (planDays.has(`${day}|${source}`)) continue;
      const row = planRow(day, source, b, day < firstDay);
      const after = { listUSD: 0, billedUSD: row.billedUSD, priceVersion: null, center: null, unpriced: false };
      rows.push({ key: rowKey(row), before: null, after, row });
    }
  }
  const correction = { ts, from, to, reason, priceVersion: version.id, rows };
  store.addCorrection(correction);
  return correction;
}
```

Add `repriceRow` and `restate` to `module.exports` in `lib/cost/ledger.js`.

In `lib/cost/index.js`, add before `return { update, … }`:

```js
  function restate({ from, to, reason }) {
    const today = dayOf(now());
    if (!(from <= to)) throw fail(400, 'from must be on or before to');
    // A correction moves amounts by (after - before); today's rows are rebuilt each pass, so it would count twice there.
    if (to >= today) throw fail(400, 'today follows the current prices and rules already; restate up to yesterday');
    const s = settingsNow();
    const version = prices.observe(getPricing() || {}, today);
    const c = L.restate(store, {
      from,
      to,
      reason,
      ts: now(),
      version,
      pricer: prices.pricerFor(version.id),
      rules: s.rules,
      firstDay: isDay(cursors.firstDay) ? cursors.firstDay : today,
    });
    save();
    return c;
  }
```

Then change the return statement to `return { update, recordJudge, ledger, status: statusOf, versions, retag, restate };`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/cost-restate.test.js test/cost-pass.test.js test/cost-ledger.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/cost/ledger.js lib/cost/index.js test/cost-restate.test.js
git commit -m "Cost ledger: restate a range as one correction, re-priced and re-attributed, rows kept"
```

---

### Task 8: The /api/cost routes and the demo ledger

**Files:**
- Create: `lib/cost/api.js`
- Modify: `lib/demo.js`: add `costDemo` after `topologyDemo` (which ends at `:1492`) and add `costDemo,` to `module.exports` (`:1494-1507`)
- Test: `test/cost-api.test.js` (in-process part)

**Interfaces:**
- Consumes:
  - `createCost` (Tasks 6–7);
  - `PATHLIKE` from `lib/monitors/api.js`;
  - `validate`, `settingsOf`, `SOURCES` and `UNASSIGNED` from `rules.js`;
  - `DIMS`, `newRow`, `rowKey` and `planRow` from `ledger.js`;
  - `priceEvent` from `collect.js`;
  - `DEFAULT_PRICING`, `makePricer` and `normalizeModel` from `lib/pricing.js`;
  - `rng` (a local helper in `lib/demo.js`).
- Produces:
  - `createCostApi({ cost, settings: { get, save }, listKeys, home, now }) → { route(req) }`. `req` is `{ method, path, query: URLSearchParams, contentType, readBody }`, and `route` returns `{ status, body }` or `null`.
  - `costDemo(now) → { settings, firstDay, versions: [{ from, at, pricing }], rows, collectors }`.

- [ ] **Step 1: Write the failing test**

```js
// test/cost-api.test.js (in-process part; Task 9 appends the spawned-server part)
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

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-api-'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);

function setup({ saved, saveThrows = false, demo = null } = {}) {
  const dir = tmp();
  const st = { saved, t: at(22) };
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const cost = createCost({
    dir: demo ? null : path.join(dir, 'cost'),
    gatewayLog: demo ? null : gatewayLog,
    getPricing: () => PRICE_A,
    getSettings: () => st.saved,
    home: HOME,
    now: () => st.t,
    nocase: false,
    demo,
  });
  const api = createCostApi({
    cost,
    settings: {
      get: () => st.saved,
      save: (v) => {
        if (saveThrows) throw Object.assign(new Error(`could not write ${path.join(HOME, 'zp', 'config.json')}`), { status: 500 });
        st.saved = v;
      },
    },
    listKeys: () => [{ id: 'key_a', name: 'Acme app', hash: 'never-shown' }],
    home: HOME,
    now: () => st.t,
  });
  const bodies = [];
  const call = async (method, p, { query = '', body, type = 'application/json' } = {}) => {
    const res = await api.route({
      method,
      path: p,
      query: new URLSearchParams(query),
      contentType: type,
      readBody: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
    });
    if (res) bodies.push(JSON.stringify(res.body));
    return res;
  };
  return { st, cost, call, bodies, gatewayLog };
}

test('cost api: route() answers only its own paths; unknown is 404, a wrong method 405', async () => {
  const s = setup();
  assert.equal(await s.call('GET', '/api/costs'), null);
  assert.equal(await s.call('GET', '/api/monitors'), null);
  assert.equal((await s.call('GET', '/api/cost/nope')).status, 404);
  assert.equal((await s.call('POST', '/api/cost/status', { body: {} })).status, 405);
  assert.equal((await s.call('GET', '/api/cost/restate')).status, 405);
});

test('cost api: the ledger checks its query and converts with the configured currency', async () => {
  const s = setup({
    saved: { currency: { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 16000 }, { from: '2026-10-22', perUSD: 16500 }] } },
  });
  fs.writeFileSync(
    s.gatewayLog,
    JSON.stringify({ ts: at(22), keyId: 'key_a', provider: 'p', model: 'claude-sonnet-5-5', kind: 'chat', input: 1000, output: 100 }) + '\n',
  );
  s.cost.update();
  for (const [query, why] of [
    ['from=2026-10-40', /dates/],
    ['from=2026-10-22&to=2026-10-01', /on or before/],
    ['from=2025-01-01&to=2026-10-22', /at most 400 days/],
    ['groupBy=day,nope', /unknown dimension nope/],
    ['groupBy=day,day', /named twice/],
    ['groupBy=day,source,model,kind,agent', /1 to 4/],
    ['currency=EUR', /no rates for that currency/],
  ]) {
    const r = await s.call('GET', '/api/cost/ledger', { query });
    assert.equal(r.status, 400, query);
    assert.match(r.body.error, why, query);
  }
  const plain = await s.call('GET', '/api/cost/ledger');
  assert.equal(plain.status, 200);
  assert.deepEqual([plain.body.from, plain.body.to, plain.body.groupBy, plain.body.currency], ['2026-10-01', '2026-10-22', ['day'], 'USD']);
  assert.equal('list' in plain.body.rows[0], false);
  const idr = await s.call('GET', '/api/cost/ledger', { query: 'currency=IDR&groupBy=day,keyId' });
  assert.equal(idr.status, 200);
  near(idr.body.rows[0].listUSD, 0.003);
  near(idr.body.rows[0].list, 49.5); // 0.003 × 16,500, the rate in force on the 22nd
  assert.equal(idr.body.missingRate, 0);
});

test('cost api: settings are read with defaults, validated on save (415, 400 with reasons), and stored normalized', async () => {
  const s = setup();
  const got = await s.call('GET', '/api/cost/settings');
  assert.deepEqual(got.body.settings, { centers: [], keyCenters: {}, folderRules: [], billing: {}, currency: null });
  assert.deepEqual(got.body.keys, [{ id: 'key_a', name: 'Acme app' }]);
  assert.equal(got.body.unassigned, 'unassigned');
  assert.equal((await s.call('POST', '/api/cost/settings', { body: {}, type: 'text/plain' })).status, 415);
  assert.equal((await s.call('POST', '/api/cost/settings', { body: '[1]' })).status, 400);
  const bad = await s.call('POST', '/api/cost/settings', {
    body: {
      centers: [{ id: 'acme', name: 'Acme' }],
      keyCenters: { key_a: 'nope' },
      folderRules: [{ glob: 'work/**', center: 'acme' }],
      currency: { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 0 }] },
    },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid cost settings');
  for (const want of [
    'keyCenters.key_a: unknown cost center',
    'folderRules[0].glob: starts with ~, /, * or a drive letter like C:/',
    'currency.rates[0].perUSD: a number above 0',
  ])
    assert.ok(bad.body.reasons.includes(want), want);
  const ok = await s.call('POST', '/api/cost/settings', {
    body: { centers: [{ id: 'acme', name: 'Acme' }], folderRules: [{ glob: `${HOME}/work/**`, center: 'acme' }] },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.st.saved.folderRules, [{ glob: '~/work/**', center: 'acme' }]);
  const failing = setup({ saveThrows: true });
  const r = await failing.call('POST', '/api/cost/settings', { body: {} });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /\[path\]/);
  for (const b of [...s.bodies, ...failing.bodies]) assert.doesNotMatch(b, PATHS);
});

test('cost api: restate needs confirm, a reason and a past range; versions and status answer', async () => {
  const s = setup();
  s.cost.update();
  const body = { from: '2026-10-20', to: '2026-10-21', reason: 'check', confirm: true };
  assert.match((await s.call('POST', '/api/cost/restate', { body: { ...body, confirm: undefined } })).body.error, /confirm: true/);
  assert.match((await s.call('POST', '/api/cost/restate', { body: { ...body, reason: ' ' } })).body.error, /reason/);
  assert.match((await s.call('POST', '/api/cost/restate', { body: { ...body, extra: 1 } })).body.error, /unknown field: extra/);
  assert.equal((await s.call('POST', '/api/cost/restate', { body: { ...body, to: '2026-10-22' } })).status, 400);
  const ok = await s.call('POST', '/api/cost/restate', { body });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body.correction).sort(), ['from', 'priceVersion', 'reason', 'rows', 'to', 'ts']);
  const v = await s.call('GET', '/api/cost/prices/versions');
  assert.equal(v.body.current, 1);
  const st = await s.call('GET', '/api/cost/status');
  assert.equal(st.body.demo, false);
  assert.equal(st.body.ledger.corrections, 1);
});

test('cost demo: three centers, Claude Code on a plan, an IDR rate, two price versions; all in memory', async () => {
  const now = Date.now();
  const d = costDemo(now);
  assert.deepEqual(d.settings.centers.map((c) => c.id), ['platform', 'client-acme', 'research']);
  assert.equal(d.settings.billing.claude.mode, 'plan');
  assert.equal(d.settings.currency.code, 'IDR');
  const s = setup({ saved: d.settings, demo: d });
  s.st.t = now;
  const from = addDays(dayOf(now), -29);
  const led = await s.call('GET', '/api/cost/ledger', { query: `from=${from}&groupBy=center&currency=IDR` });
  assert.equal(led.status, 200);
  const centers = led.body.rows.map((x) => x.center);
  for (const c of ['client-acme', 'platform', 'research', 'unassigned', null]) assert.ok(centers.includes(c), String(c));
  assert.ok(led.body.totals.list > led.body.totals.listUSD * 16000);
  const st = (await s.call('GET', '/api/cost/status')).body;
  assert.equal(st.demo, true);
  assert.ok(st.unpriced.rows > 0, 'the demo shows an unpriced model');
  assert.ok(st.backfill.rows > 0);
  const v = (await s.call('GET', '/api/cost/prices/versions')).body;
  assert.deepEqual(v.versions.map((x) => x.changed), [[], ['claude-sonnet-5-5']]);
  const r = await s.call('POST', '/api/cost/restate', {
    body: { from, to: addDays(dayOf(now), -1), reason: 'demo', confirm: true },
  });
  assert.equal(r.status, 200);
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-api.test.js`
Expected: FAIL with `Cannot find module '../lib/cost/api'`.

- [ ] **Step 3: Write `lib/cost/api.js`**

```js
// The HTTP side of the cost ledger: /api/cost/*. server.js puts this behind the dashboard sign-in (never a gateway API
// key, MCP or A2A) and sends what `route` returns; nothing here touches the socket. Answers hold numbers, dimension
// names and ~ folders only: no file path, no transcript text. A state change needs JSON (415 otherwise).
const { PATHLIKE } = require('../monitors/api');
const { isDay, addDays, dayOf } = require('./days');
const { validate, settingsOf, SOURCES, UNASSIGNED } = require('./rules');
const { DIMS } = require('./ledger');

const MAX_DAYS = 400;
const MAX_GROUP = 4;
const MAX_REASON = 200;
const RESTATE_FIELDS = ['from', 'to', 'reason', 'confirm'];

const fail = (status, message) => Object.assign(new Error(message), { status });
const reply = (status, body) => ({ status, body });
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const scrub = (m) => String(m || '').replace(PATHLIKE, '[path]').slice(0, 300);

function checkRange(from, to) {
  if (!isDay(from) || !isDay(to)) throw fail(400, 'from and to are dates (YYYY-MM-DD)');
  if (from > to) throw fail(400, 'from must be on or before to');
  if (addDays(from, MAX_DAYS) <= to) throw fail(400, `at most ${MAX_DAYS} days at a time`);
}

function createCostApi({ cost, settings, listKeys = () => [], home = '', now = Date.now }) {
  const current = () => settingsOf(settings.get(), { home });

  function ledgerQuery(q) {
    const to = q.get('to') || dayOf(now());
    if (!isDay(to)) throw fail(400, 'from and to are dates (YYYY-MM-DD)');
    const from = q.get('from') || `${to.slice(0, 8)}01`;
    checkRange(from, to);
    const raw = q.get('groupBy');
    const groupBy = (raw ? raw : 'day')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!groupBy.length || groupBy.length > MAX_GROUP) throw fail(400, `groupBy: 1 to ${MAX_GROUP} of ${DIMS.join(', ')}`);
    for (const d of groupBy) if (!DIMS.includes(d)) throw fail(400, `groupBy: unknown dimension ${d.slice(0, 40)}`);
    if (new Set(groupBy).size !== groupBy.length) throw fail(400, 'groupBy: a dimension is named twice');
    let currency = q.get('currency') || null;
    if (currency === 'USD') currency = null;
    if (currency) {
      const c = current().value.currency;
      if (!c || c.code !== currency) throw fail(400, 'no rates for that currency; set it in the cost settings');
    }
    return { from, to, groupBy, currency };
  }

  function keys() {
    try {
      return (listKeys() || []).map((k) => ({ id: String(k.id), name: String(k.name || '').slice(0, 60) }));
    } catch {
      return [];
    }
  }

  const GET = {
    '/api/cost/ledger': (q) => reply(200, cost.ledger(ledgerQuery(q))),
    '/api/cost/status': () => reply(200, cost.status()),
    '/api/cost/settings': () => {
      const s = current();
      return reply(200, { settings: s.value, error: s.error, sources: SOURCES, unassigned: UNASSIGNED, keys: keys() });
    },
    '/api/cost/prices/versions': () => reply(200, cost.versions()),
  };
  const POST = {
    '/api/cost/settings': (body) => {
      const r = validate(body, { home });
      if (!r.ok) return reply(400, { error: 'invalid cost settings', reasons: r.errors });
      settings.save(r.value);
      cost.retag(); // today's rows take the new centers and billing now, not at the next pass
      return reply(200, { settings: r.value });
    },
    '/api/cost/restate': (body) => {
      for (const k of Object.keys(body)) if (!RESTATE_FIELDS.includes(k)) throw fail(400, `unknown field: ${k.slice(0, 40)}`);
      checkRange(body.from, body.to);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason || reason.length > MAX_REASON) throw fail(400, `reason: 1 to ${MAX_REASON} characters`);
      if (body.confirm !== true) throw fail(400, 'a restate needs confirm: true');
      return reply(200, { correction: cost.restate({ from: body.from, to: body.to, reason }) });
    },
  };

  async function route(req) {
    const p = req.path;
    if (p !== '/api/cost' && !p.startsWith('/api/cost/')) return null;
    const get = Object.hasOwn(GET, p);
    const post = Object.hasOwn(POST, p);
    if (!get && !post) return reply(404, { error: 'unknown route' });
    if (!((get && req.method === 'GET') || (post && req.method === 'POST'))) return reply(405, { error: 'method not allowed' });
    try {
      if (req.method === 'GET') return GET[p](req.query);
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
      let body;
      try {
        body = JSON.parse(await req.readBody());
      } catch (e) {
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      if (!isObject(body)) return reply(400, { error: 'bad request body' });
      return POST[p](body);
    } catch (e) {
      const st = e && e.status;
      if (Number.isInteger(st) && st >= 400 && st <= 599) return reply(st, { error: scrub(e.message) });
      return reply(500, { error: 'cost request failed' });
    }
  }

  return { route };
}

module.exports = { createCostApi };
```

- [ ] **Step 4: Add `costDemo` to `lib/demo.js`**

Insert after `topologyDemo` (before `module.exports`), and add `costDemo,` as the last entry of `module.exports`:

```js
// Cost Control (lib/cost): a synthetic month of ledger rows, held in memory by the server. Three cost centers, Claude
// Code on a plan, an IDR rate that changed once, two price versions (Sonnet got cheaper 11 days ago), the first 10 days
// backfilled, one unpriced model and a free local judge. Amounts come from the built-in prices through the ledger's own
// pricer, so they look like real ones.
function costDemo(now = Date.now()) {
  const { DEFAULT_PRICING, makePricer, normalizeModel } = require('./pricing');
  const { priceEvent } = require('./cost/collect');
  const { newRow, rowKey, planRow } = require('./cost/ledger');
  const { compile } = require('./cost/rules');
  const { dayOf, addDays, daysBetween } = require('./cost/days');
  const r = rng(424242);
  const today = dayOf(now);
  const start = addDays(today, -29);
  const firstDay = addDays(today, -19);
  const cheaper = addDays(today, -11);
  const settings = {
    centers: [
      { id: 'platform', name: 'Platform' },
      { id: 'client-acme', name: 'Client: Acme' },
      { id: 'research', name: 'Research' },
    ],
    keyCenters: { key_demo0acme01: 'client-acme', key_demo0lab001: 'research' },
    folderRules: [
      { glob: '~/acme-web/**', center: 'client-acme' },
      { glob: '~/research-notes/**', center: 'research' },
      { glob: '~/**', center: 'platform' },
    ],
    billing: { claude: { mode: 'plan', plan: 'Claude Max', feeUSD: 200, period: 'month' } },
    currency: {
      code: 'IDR',
      rates: [
        { from: start, perUSD: 16250 },
        { from: addDays(today, -9), perUSD: 16420 },
      ],
    },
  };
  const sonnet = DEFAULT_PRICING['claude-sonnet-5-5'];
  const v1 = { ...DEFAULT_PRICING, 'claude-sonnet-5-5': { ...sonnet, input: 3, output: 15 } };
  const pricers = { 1: makePricer(v1), 2: makePricer(DEFAULT_PRICING) };
  const rules = compile(settings, { nocase: false });
  const rows = new Map();
  const add = (day, e, count) => {
    const version = day < cheaper ? 1 : 2;
    const dims = {
      day,
      source: e.source,
      provider: e.provider,
      model: normalizeModel(e.model),
      project: e.project,
      keyId: e.keyId,
      agent: e.agent,
      kind: e.kind,
      geo: null,
      plan: null,
    };
    dims.center = rules.centerOf(e);
    const k = rowKey(dims);
    const row = rows.get(k) || newRow(dims);
    rows.set(k, row);
    const p = priceEvent(pricers[version], e);
    row.requests += count;
    for (const f of Object.keys(e.tokens)) row.tokens[f] += e.tokens[f] * count;
    row.listUSD += p.listUSD * count;
    row.billedUSD += rules.billingOf(e.source).mode === 'plan' ? 0 : p.listUSD * count;
    row.unpriced = row.unpriced || p.unpriced;
    row.free = !!e.free;
    row.priceVersion = version;
    row.backfilled = day < firstDay;
  };
  const ev = (source, provider, model, project, keyId, agent, kind, tin, tout, cacheRead = 0, free = false) => ({
    source,
    provider,
    model,
    project,
    keyId,
    agent,
    kind,
    tokens: { in: tin, out: tout, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 },
    webSearches: 0,
    geo: null,
    free,
  });
  for (const day of daysBetween(start, today)) {
    const k = 0.6 + r() * 0.8; // busier and quieter days
    const n = (base) => Math.max(1, Math.round(base * k));
    add(day, ev('claude', 'anthropic', 'claude-opus-5-5', '~/acme-web', null, null, 'chat', 3000, 900, 60000), n(40));
    add(day, ev('claude', 'anthropic', 'claude-sonnet-5-5', '~/data-pipeline', null, null, 'chat', 2500, 700, 40000), n(30));
    add(day, ev('claude', 'anthropic', 'claude-sonnet-5-5', '~/research-notes', null, null, 'chat', 2000, 600, 20000), n(12));
    add(day, ev('codex', 'openai', 'gpt-6.1-sol', '~/mobile-app', null, null, 'chat', 4000, 800, 30000), n(25));
    add(day, ev('gateway', 'openrouter', 'deepseek-chat', null, 'key_demo0acme01', null, 'chat', 1200, 400), n(60));
    add(day, ev('gateway', 'openrouter', 'claude-sonnet-5-5', null, 'key_demo0lab001', null, 'chat', 1800, 500), n(15));
    add(day, ev('collab', 'openrouter', 'claude-sonnet-5-5', null, null, 'planner', 'run', 3000, 900), n(6));
    add(day, ev('judge', 'ollama', 'qwen3:8b', null, null, null, 'judge', 1500, 60, 0, true), n(20));
    if (day >= cheaper)
      add(day, ev('gateway', 'groq', 'llama-3.3-70b', null, 'key_demo0lab001', null, 'chat', 900, 300), n(5));
    const plan = planRow(day, 'claude', settings.billing.claude, day < firstDay);
    rows.set(rowKey(plan), plan);
  }
  const ago = (days) => now - days * DAY;
  return {
    settings,
    firstDay,
    versions: [
      { from: start, at: ago(29), pricing: v1 },
      { from: cheaper, at: ago(11), pricing: DEFAULT_PRICING },
    ],
    rows: [...rows.values()],
    collectors: {
      local: { at: now - 40e3, read: 120, total: 9400, error: null },
      gateway: { at: now - 40e3, read: 34, total: 2600, error: null },
      judge: { at: now - 40e3, read: 3, total: 410, error: null },
    },
  };
}
```

`DAY` and `rng` are already defined at the top of `lib/demo.js` (`:4`, `:14`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/cost-api.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/cost/api.js lib/demo.js test/cost-api.test.js
git commit -m "Cost ledger: /api/cost routes (ledger, status, settings, price versions, restate) and a demo ledger"
```

---

### Task 9: Wire into server.js, spawned-server tests, docs

**Files:**
- Modify: `server.js` (shared). Each edit is additive:
  - requires after `:52` (`const { createRuntimeApi } = require('./lib/runtimes/api');`);
  - the cost block after the `trace` creation, which ends at `:374`, before the `// Local evals:` comment;
  - `onCall` in the `createEvalEngine` options after `:410`;
  - the cost tick after `:648` (`const monitorTickAfterIndex = …`);
  - the route block after the runtimes route block (`:1124-1133`), before `if (url.pathname === '/api/logs')`;
  - `/api/rescan` at `:1382`;
  - the startup refresh at `:1418-1424`.
- Create: `docs/cost.md`
- Test: append to `test/cost-api.test.js`

**Interfaces:**
- Consumes:
  - `createCost` and `createCostApi`;
  - `createAfterRefresh` from `lib/monitors/index.js`, already imported at `:46`;
  - from `server.js`: `rawConfig`, `saveConfigSection`, `indexer`, `gateway`, `config`, `DIR`, `DEMO`, `demo`, `rawCache`;
  - `NO_JUDGE_PORTS` and `secretsFor` from `test/helpers.js`;
  - `createGateway` from `lib/gateway`.
- Produces: the `/api/cost/*` routes live behind the sign-in, and a ledger pass runs after each index refresh.

- [ ] **Step 1: Write the failing spawned-server tests** (append to `test/cost-api.test.js`)

```js
// ---- spawned server.js ----
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own (trace 5100-5899, evals 5900-6399, datasets/monitors 6400-6899, topology 6900-7299,
    // monitors engine and OTLP 7000-7799).
    const port = 8000 + Math.floor(Math.random() * 400);
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

test('cost api over HTTP: the demo ledger, path-free', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const from = addDays(dayOf(Date.now()), -29);
    const led = await c.call(`/api/cost/ledger?from=${from}&groupBy=center&currency=IDR`);
    assert.equal(led.status, 200);
    const centers = led.json.rows.map((x) => x.center);
    for (const id of ['client-acme', 'platform', 'research', 'unassigned']) assert.ok(centers.includes(id), id);
    assert.ok(led.json.totals.list > 0);
    assert.equal((await c.call('/api/cost/status')).json.demo, true);
    assert.equal((await c.call('/api/cost/prices/versions')).json.versions.length >= 2, true);
    assert.equal((await c.call('/api/cost/settings')).json.settings.billing.claude.mode, 'plan');
    assert.equal((await c.call('/api/cost/settings', { method: 'POST', body: {} })).status, 415);
    assert.equal((await c.post('/api/cost/restate', { from, to: from, reason: 'x' })).status, 400);
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
  } finally {
    await s.stop();
  }
});

test('cost api over HTTP: a gateway key is not a sign-in; the ledger fills from the gateway log into private files', async () => {
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
  const { key, secret } = gw.keys.create({ name: 'acme app', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 });
  gw.flush();
  const now = Date.now();
  const yesterday = now - 86400e3;
  const line = (ts) =>
    JSON.stringify({ ts, keyId: key.id, provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', kind: 'chat', status: 200, input: 1000, output: 100, cached: 0 }) + '\n';
  fs.writeFileSync(path.join(data, '.data', 'gateway-usage.jsonl'), line(yesterday) + line(now), { mode: 0o600 });
  // pricingSync off: the spawned server never fetches the live price list.
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({ pricingSync: { enabled: false }, cost: { centers: [{ id: 'acme', name: 'Acme' }], keyCenters: { [key.id]: 'acme' } } }),
  );
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  try {
    const bearer = client(s.base, { authorization: `Bearer ${secret}`, 'x-api-key': secret });
    for (const who of [client(s.base), bearer]) {
      for (const p of ['/api/cost/ledger', '/api/cost/status', '/api/cost/settings', '/api/cost/prices/versions'])
        assert.equal((await who.call(p)).status, 401, p);
      for (const p of ['/api/cost/settings', '/api/cost/restate']) assert.equal((await who.post(p, {})).status, 401, p);
    }
    const login = await fetch(`${s.base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const c = client(s.base, { cookie });
    let st = null;
    for (let i = 0; i < 60; i++) {
      st = (await c.call('/api/cost/status')).json;
      if (st.collectors.gateway.at) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(st.collectors.gateway.at, 'the ledger pass ran after the first index refresh');
    const today = dayOf(now);
    const yday = dayOf(yesterday);
    const led = await c.call(`/api/cost/ledger?from=${yday}&to=${today}&groupBy=day,center,keyId`);
    assert.equal(led.status, 200);
    assert.deepEqual(
      led.json.rows.map((x) => [x.day, x.center, x.keyId, x.backfilled]),
      [
        [yday, 'acme', key.id, true],
        [today, 'acme', key.id, false],
      ],
    );
    for (const x of led.json.rows) near(x.listUSD, 0.003);
    assert.equal((await c.post('/api/cost/settings', { folderRules: [{ glob: 'relative/**', center: 'acme' }] })).status, 400);
    assert.equal((await c.call('/api/cost/restate', { method: 'POST', body: { from: yday, to: yday, reason: 'x', confirm: true } })).status, 415);
    assert.equal((await c.post('/api/cost/restate', { from: yday, to: yday, reason: 'check', confirm: true })).status, 200);
    const dir = path.join(data, '.data', 'cost');
    const files = [`ledger-${today.slice(0, 7)}.jsonl`, 'cursors.json', 'corrections.jsonl', path.join('prices', 'versions.json'), path.join('prices', '1.json')];
    for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), f);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(dir, 'prices')).mode & 0o777, 0o700);
      for (const f of files) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
    }
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS);
  } finally {
    await s.stop();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cost-api.test.js`
Expected: the two new tests FAIL. `/api/cost/ledger` answers 404 (a static-file miss), because the routes are not wired yet.

- [ ] **Step 3: Wire `server.js`**

After `:52` add:

```js
const { createCost } = require('./lib/cost');
const { createCostApi } = require('./lib/cost/api');
```

After the `trace` creation (`:361-374`), before the `// Local evals:` comment, add:

```js
// Cost ledger (Cost Control 1): daily cost rows from every source in .data/cost/, priced with the version of their day
// and attributed to cost centers (config.json "cost"). Demo: a synthetic ledger in memory; no files, no passes.
const costDemo = DEMO ? demo.costDemo() : null;
if (DEMO) rawCache.value = { ...rawCache.value, cost: costDemo.settings };
const cost = createCost({
  dir: DEMO ? null : path.join(DIR, '.data', 'cost'),
  gatewayLog: DEMO ? null : path.join(DIR, '.data', 'gateway-usage.jsonl'),
  entries: () => (typeof indexer.entries === 'function' ? indexer.entries() : []),
  getPricing: () => config.pricing,
  getSettings: () => rawConfig().cost,
  // A model on the owner's own hardware costs nothing, as for the gateway's key budgets.
  isPrivate: (id) => {
    const p = gateway.providers.list().find((x) => x.id === id);
    return !!p && gateway.providers.tierOf(p) === 'private';
  },
  home: os.homedir(),
  demo: costDemo,
});
const costApi = createCostApi({
  cost,
  settings: { get: () => rawConfig().cost, save: (value) => saveConfigSection('cost', value) },
  listKeys: () => gateway.keys.list(),
  home: os.homedir(),
});
```

In the `createEvalEngine({ … })` options, after `onResult: (r) => datasetAuto.onResult(r),` add:

```js
  onCall: (c) => cost.recordJudge(c), // judge calls that skip the gateway, for the cost ledger
```

After `const monitorTickAfterIndex = createAfterRefresh(…);` add:

```js
// The cost ledger pass reads the refreshed index too; a failure never breaks a refresh.
const costTick = () =>
  Promise.resolve()
    .then(() => cost.update())
    .catch(() => console.error('cost: the ledger pass failed'));
const costTickAfterIndex = createAfterRefresh({ indexing: () => indexer.state.indexing, run: costTick });
```

After the runtimes route block, before `if (url.pathname === '/api/logs') {`, add:

```js
    // The cost ledger: rows, status, settings, price versions and restate, behind the same sign-in. No path out.
    {
      const hit = await costApi.route({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
      });
      if (hit) return send(res, hit.status, hit.body);
    }
```

In `/api/rescan` (`:1382-1386`), add `costTick();` after `monitorTick();`. In `server.listen` (`:1418-1424`), add `costTick();` after `monitorTick();` in the first refresh's `.then`, and add this line after `setInterval(monitorTickAfterIndex, RESCAN_MS).unref();`:

```js
  setInterval(costTickAfterIndex, RESCAN_MS).unref();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cost-api.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Write `docs/cost.md`**

```markdown
# Cost ledger

ZAAFPulse keeps one daily record of what AI use cost, in `.data/cost/`. It is the base of the Cost Control menu.

## What is counted, and by whom

- **Claude Code and Codex**: from their logs, once per API response. Resumed and forked sessions count once.
- **The gateway**: from `.data/gateway-usage.jsonl`. This covers your keys' requests, dataset replay, collaboration
  runs and judge calls to external providers.
- **Judge calls that skip the gateway** (Ollama, LM Studio, Claude Code): from `.data/cost/judge-calls.jsonl`.
  Local models cost nothing.
- **Not counted:** OmniRoute (its own figures are shown apart).

> **Note:** Claude Code or Codex pointed at this gateway shows up in both its own logs and the gateway log, so it is
> counted twice.

Every source is priced with the same price table and formula. That includes cache writes, prompt-length tiers, web
searches and US-only inference.

## Frozen cost

- **Price versions.** A price change (your own, the live list, a pin) starts a new price version from that day.
- **Today** follows the newest prices.
- **Past days** keep theirs. A log that arrives late is priced with its own day's version.
- **The first run** fills the ledger from your history with today's prices. Those rows are marked as backfilled.
- **Restating.** To re-price a past range on purpose, use `POST /api/cost/restate { from, to, reason, confirm: true }`.
  It records a correction with the old and new amounts; the original rows stay.

## Settings (`config.json` → `cost`)

    {
      "centers": [{ "id": "acme", "name": "Client: Acme" }],
      "keyCenters": { "key_0123456789ab": "acme" },
      "folderRules": [{ "glob": "~/work/acme/**", "center": "acme" }],
      "billing": { "claude": { "mode": "plan", "plan": "Claude Max", "feeUSD": 200, "period": "month" } },
      "currency": { "code": "IDR", "rates": [{ "from": "2026-10-01", "perUSD": 16250 }] }
    }

- **Cost centers.** A gateway key's center wins. Otherwise the first folder rule that matches the session's folder
  applies, and otherwise the cost is Unassigned.
- **Folder globs:**
  - `*` is any name inside one folder and `?` is one character;
  - `**/` is any number of folders;
  - `~/work/**` is `~/work` and everything below it.

  Folders start with `~`, `/`, `*` or a drive like `C:/`.
- **Billing.** `metered` (the default) bills the list price. `plan` bills the fee spread over the days of its month or
  year; the list price then shows the value you received.
- **Currency.** The ledger is in USD. With a display currency, amounts are converted with the latest rate on or before
  each day. ZAAFPulse never fetches rates.

## API (dashboard sign-in only)

| Route | |
|---|---|
| `GET /api/cost/ledger?from&to&groupBy&currency` | rows grouped by up to 4 of day, source, provider, model, project, center, keyId, agent, kind (at most 400 days) |
| `GET /api/cost/status` | each collector's last read and error, the price version, unpriced and backfilled counts |
| `GET`/`POST /api/cost/settings` | the settings above; a bad glob, center or rate is refused with the reasons |
| `GET /api/cost/prices/versions` | price versions and which models changed |
| `POST /api/cost/restate` | re-price a past range; returns the correction |

The ledger holds numbers and names only: no prompt or reply text. Folders are written with `~`.
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS on the whole suite. In particular, `test/security.test.js` and `test/signin.test.js` still pass, and so do the existing monitors and datasets spawned tests (the server starts with the new block).

- [ ] **Step 7: Commit**

```bash
git add server.js docs/cost.md test/cost-api.test.js
git commit -m "Cost ledger: wire the pass after each index refresh and the /api/cost routes behind the sign-in"
```

---

## Decisions made while planning

1. **Who owns each call (no double counting).**
   - **Gateway log.** It owns every call that passed through the gateway. That covers plain requests, dataset replay (`agent: 'replay'`), external judge calls (`agent: 'judge'`, from `gateway.judge.complete`) and collaboration runs (`runId`, set in `lib/gateway/collab.js:410`). The collector only re-labels these as `replay`, `judge` or `collab`.
   - **Judge collector.** It reads only `.data/cost/judge-calls.jsonl`, which `recordJudge` writes for `ollama`, `lmstudio` and `claude-cli` calls. It drops `external` calls.
   - **Never read.** Experiment records and run totals repeat gateway lines and are not read.
   - **Claude Code judge.** It runs with `--no-session-persistence` (`lib/evals/claude-cli.js:417`), so it leaves no transcript for the local collector.
2. **Judge cost source.** There was no per-call record, so this plan adds two small additive changes:
   - an `onCall` listener in the eval engine (Task 4);
   - a cache split in the Claude Code CLI usage.

   The CLI's own `total_cost_usd` is not used for the ledger: every source goes through the same pricer.
3. **Gateway lines lack cache writes, web searches and geo.** Today `input` is the whole prompt.
   - The collector prices `input - cached` as input.
   - It reads the optional fields `cacheWrite5m`, `cacheWrite1h`, `webSearches` and `geo` when a line has them. The parity test proves that the formula matches the local one once they are recorded.
   - The gateway's own `usage.cost`, budgets and 402 are unchanged.
4. **Cursor format** (R11).
   - **Byte cursors.** Gateway and judge logs use `{ head, offset }`. The head is a first-line hash, so the 10 MB rotation to `.1` is followed.
   - **Local logs.** They need no byte cursor: the indexer's per-file `mtimeMs:size` is remembered in memory, and the touched days are rebuilt.
   - **Crash window.** Cursors are written after the ledger rows. A crash between the two writes can count that pass's gateway lines twice. The reverse order would lose them instead; counting twice was chosen because it is visible and can be restated.
5. **Day boundary.** Epoch-millisecond timestamps (UTC instants) are turned into local days with `Date` getters, the same as the Overview.
6. **How a price change is detected.**
   - Each pass hashes `config.pricing`, memoized by object identity. This covers manual edits, the live sync, pins and integration reloads without hooking each writer.
   - A version starts on the day it is seen, and the newest of a day wins.
   - A version is never dated before the previous one.
7. **Within today.** Local rows are re-priced in full by each pass. Gateway and judge lines are priced when read, so a price change during the day applies to lines read after it.
8. **Closed days.** Local rows only grow: they are compared by `baseKey`, and the stored center is kept. Late gateway and judge lines are added. A late event uses its day's version and the billing mode the day had (the plan row is the record of it).
9. **Plans.**
   - Plan rows have no center.
   - Days the server was off are filled with the current plan.
   - The first run backfills plan rows from the source's first day of use.
   - Switching a source to a plan later applies from that day only, unless restated.
10. **Restate.**
    - It allows `to < today` only. Today's rows are rebuilt each pass, so a delta-based correction there would count twice.
    - It re-prices by the row's average request, because rows are daily sums. A row mixing requests on both sides of a tier is approximated.
    - Corrections are deltas, so later late events still count.
    - It adds plan rows for days that had none.
11. **Free and unpriced.** Private gateway providers and the local judge servers are `free` (0, not unpriced). A model with no price is `unpriced` (0, counted and reported).
12. **Currency gaps.** A day with no rate on or before it gives `null` converted amounts, counted in `missingRate`; it is not filled from a later rate. `USD` cannot be the display code.
13. **Extra row fields** beyond the spec: `geo`, `plan` and `free`. They are additive and needed for restate, plan names and free models.
14. **Status collectors** are reported as `local` (claude, codex), `gateway` (gateway, replay, collab, external judge) and `judge` (judge calls outside the gateway), each with its `sources`.
15. **Demo.** The ledger is held in memory (`dir: null`), seeded from `costDemo()`, and the pass never runs. Settings and restate work in memory.
16. **Price version storage.** A full JSON copy is kept per version, written only when the hash changes.

## Self-review

- **Spec coverage:**

  | Spec section | Task(s) |
  |---|---|
  | collectors, all five sources, dedupe, cursors, no double count | 3, 4, 6; Decision 1 |
  | `prices.js` / `versionFor` | 2 |
  | `rules.js` validation | 1 |
  | ledger store, monthly JSONL, `.bad` | 5 |
  | open today / closed days / late events / backfill | 6 |
  | restate and corrections | 7 |
  | shared pricer and gateway parity | 3 |
  | plan rows, `listUSD` / `billedUSD` | 6 (R8, R12) |
  | currency at read | 5, 8 |
  | the five routes | 8, 9 |
  | demo | 8, 9 |
  | wiring after refresh | 9 |
  | error handling (atomic, `.bad`, failing collector, invalid settings, rebuild) | 2, 5, 6 |

  A rebuild is done by deleting `.data/cost/`: the next pass backfills, and the rows are marked.

  Spec tests mapped to their test files:
  - collectors and dedupe: `cost-collect`, `cost-pass`;
  - freezing, late events, plans and attribution: `cost-pass`;
  - restate: `cost-restate`;
  - currency: `cost-ledger`, `cost-api`;
  - gateway formula: `cost-collect`;
  - storage, API, no paths and no gateway key: `cost-ledger`, `cost-pass`, `cost-api`.
- **Placeholder scan:** every step has its code, exact commands and expected results. No "TBD" or "handle edge cases" remains.
- **Name consistency:**
  - `createCost` returns `update`, `recordJudge`, `ledger`, `status`, `versions`, `retag` and `restate`. Tasks 6–9 and the API use exactly these.
  - The ledger exports used later (`newRow`, `rowKey`, `baseKey`, `planRow`, `mergeRows`, `tokenTotal`, `TOKENS`, `DIMS`, `groupRows`, `createLedgerStore`, `repriceRow`, `restate`) are all defined in Tasks 5 and 7.
  - The `rules.js` names used in Tasks 6–8 (`settingsOf`, `compile`, `rateFor`, `planFee`, `validate`, `SOURCES`, `UNASSIGNED`) are all defined in Task 1.
