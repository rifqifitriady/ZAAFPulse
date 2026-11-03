# Governance audit log (AI Governance 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One record of every change made to ZAAFPulse by a person or an API key (who, when, what, outcome), kept at
least six months in monthly files, chained with an HMAC so an edited, deleted or moved line shows when verified,
exportable as CSV or JSON lines, shown under a new **Governance → Audit log** page, and watched by two new Monitors
rules.

**Architecture:**
- **Pure modules.** `lib/governance/chain.js` (canonical JSON, the mac, `verifyChain`), `lib/governance/diff.js`
  (field-level changes with secrets masked, spec A5) and `lib/governance/events.js` (what a dashboard request and an
  agent or runtime control line become as entries). No I/O, no clock.
- **The store.** `lib/governance/audit.js`: `createGovernanceAudit({ dir, getKey, now })` →
  `{ record, list, export, verify, status, prune, importPending }`, `keySource({ dir, store })` (the key from the secret
  store, else `chain.key`), `queueEvent(dir, event)` (the CLI's way in). It does the I/O; the clock and the key come in.
- **The actor.** `lib/governance/context.js`: an `AsyncLocalStorage` slot per request (`runAs`, `setActor`, `actor`).
  `server.js` runs every request in `runAs(null, …)` and fills the slot after `auth.check` (`auth.actorOf(req)`); the
  gateway's `authed()` fills it with the key. Module routers need no new parameter.
- **Wiring.** `server.js`: `govRecord(entry)` adds the actor; `send()` writes the entry of a non-GET dashboard request
  right before its answer (A4(1)); both config writers report `config.change` (A4(2)); `lib/auth.js` reports sign-in
  events through `onEvent` (A4(3)); the gateway reports key changes and run approvals/cancels through `audit` (A4(4),
  A4(7)); the agent and runtime control logs are mirrored (A4(5)); `/api/trace/reveal` is recorded (A4(6));
  `lib/integrations.js` adds `keyId` to MCP audit lines (A8); a GET on a writing gateway admin route is 405 (A7);
  `/api/governance/*` comes from `lib/governance/api.js` (A9); a daily pass imports CLI events, prunes and verifies.
- **Monitors.** Rules `audit_degraded` and `audit_chain_broken` in `lib/monitors/rules.js`, fed by
  `createMonitors({ auditStatus })`.
- **Dashboard.** `public/governanceview.js` (prefix `gov`/`GOV`), a **GOVERNANCE** group in the sidebar, the route in
  `public/app.js`.

**Tech Stack:** Node ≥18 standard library only (CommonJS; `async_hooks` for the actor, `crypto` for the HMAC),
`node:test`, plain browser JS in `public/` (classic scripts sharing one global scope, loaded before `app.js`).

**Spec:** `docs/superpowers/specs/2026-11-03-governance-audit-log-design.md` (AI Governance sub-project 2 of 4).

**Line numbers** below are where each text sits when its task starts (the base is `46f7f98` on `feat/gov-audit`, with
the earlier tasks of this plan applied). Re-read each location before editing it; every edit is given as an exact
`old` → `new` replacement (each `old` occurs exactly once in its file when the step runs), a whole new file, or a block
appended to the end of a file this plan created.

**Checked while planning:** Tasks 1–9 were built in order in a scratch worktree of `46f7f98` (detached). The plan was
then expanded from that tree and applied mechanically, task by task, to a fresh worktree of `46f7f98`: 100 operations
(19 new files, 4 blocks appended to `test/governance-http.test.js`, 77 replacements, each `old` found exactly once),
running each task's Step 2 command right after its tests were added and its pass command after the rest. Every new
test failed before its task (Tasks 1, 2 and 8: the module is missing; Task 3: 2 of 2, the module is missing and the
spawned server writes no request entry; Task 4: 2 of 4; Task 5: 7 of 9; Task 6: 1 of 1; Task 7: 8 of 13; the tests
that passed there are earlier tasks' spawned tests, and Task 4's listener-that-throws test, which holds before the
listener exists) and passed after it (Task 3's command: 34 tests; Task 5's: 116; Task 7's: 250, 1 skipped; Task 8's:
61). The applied tree matched the scratch tree byte for byte. `npm test` on it: 2306 tests, 2304 pass, 2 skipped, 0
fail. Baseline on `46f7f98`: 2256 tests, 2254 pass, 2 skipped, 0 fail. The 50 new tests in `test/governance-*.test.js`
all pass; each of the six spawned-server tests took 0.5–0.7 s inside the full run. One run of the neighbouring
spawned suites after Task 3 had a single failure that passed on the rerun and in both full runs (timing under load).
`npx prettier@3 --check` passes on every file this plan creates and on the shared files listed in Global Constraints;
`server.js`, `lib/gateway/index.js` and `public/styles.css` keep their `46f7f98` counts (7, 22 and 39). Task 9 is
documentation only. Not checked: the Audit log page in a real browser (its markup is tested through the exported
helpers, S1 by rendering `<x>` in every field).

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test` (`npm test`; one file:
  `node --test test/<file>.test.js`). Plain browser JS in `public/`: classic `<script>` files loaded by
  `public/index.html` before `app.js`.
- **Pure modules.** `lib/governance/chain.js`, `lib/governance/diff.js` and `lib/governance/events.js` do no I/O and
  read no clock; `chain.js` requires only `crypto`, `diff.js` only `./chain`, `events.js` nothing.
  `lib/governance/context.js` requires only `async_hooks`. `lib/governance/audit.js` takes `now` and `getKey` from its
  caller and requires only `crypto`, `fs`, `path`, `./chain` and `../cost/export` (for `csvCell`).
- **Never in the way (A6).** Recording never fails or slows the change it records: `record()` never throws, and every
  listener added here (`onEvent` in `lib/auth.js`, `onChange` in `lib/integration-config.js`, `audit` in the gateway)
  is called inside `try`/`catch`.
- **Privacy.** No request body is copied: of a body only `action`/`op` (a short word), `id` (an id-shaped string) and
  `name` (cut to 80) are kept. Never in an entry, a test fixture's recorded output or an alert: a key's secret, a
  password, a cookie, a revealed value, a secret value (A5 masks it as `‹changed›`). Alerts carry a count, a seq and a
  fixed reason word only (A11).
- **One global scope.** New top-level names in `public/governanceview.js` start with `gov` or `GOV`. No name may repeat
  one in another page script ("every page script shares one global scope: no top-level name is declared twice" in
  `test/cost-ui.test.js` checks it).
- **Loadable in Node.** `public/governanceview.js` ends with `if (typeof module !== 'undefined') module.exports = …` and
  touches no DOM at load time; tests `require` it with stand-ins for `esc` and `subHero`.
- **Text only (S1).** Every server or owner string into HTML goes through `esc()`. CSP stays `script-src 'self'`: no
  inline handlers, no inline scripts; the page's forms and buttons use delegated `submit` and `click` listeners
  installed once.
- **Tests.**
  - Never call a real network and never signal a real process. Upstream providers are `fakeServer` (from
    `test/helpers.js`) on `127.0.0.1`; in-process gateways listen on port `0`.
  - Spawned `server.js` tests live in `test/governance-http.test.js` and use **ports 9600–9799**, which no existing test
    uses (the spawned tests take 4800–4989, 5100–7799, 8000–9599 and 9800–9999). Each server gets a temp data folder
    (`ZAAFPULSE_DATA`, `HOME`, `USERPROFILE`), `ZAAFPULSE_AUTH=none` unless sign-in is under test, and
    `NO_JUDGE_PORTS`; an answer counts only while the child is still running (`s.alive()`); the child is killed and
    awaited, then its folder removed, in `t.after`.
  - `NO_JUDGE_PORTS` gains `ZAAFPULSE_SECRET_STORE=file` and `ZAAFPULSE_MASTER_KEY` (Task 3): the first change a
    spawned server records makes the audit key, which must go to an encrypted file in the test folder, never this
    machine's Keychain or keyring (and no DPAPI prompt on Windows).
  - Restore what a test replaces; temp folders removed in `t.after`.
- **Housekeeping.**
  - Prettier (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Run
    `npx prettier@3 --check` on every file you create and on `lib/auth.js`, `lib/integration-config.js`,
    `lib/integrations.js`, `lib/gateway/a2a.js`, `lib/monitors/rules.js`, `lib/monitors/index.js`,
    `public/monitorsview.js`, `public/app.js`, `bin/zaafpulse.js`, `test/helpers.js`, `test/monitors-rules.test.js`,
    `test/budgets-monitors.test.js` and `test/monitors-api.test.js` (all pass on `46f7f98`). Never `--write`
    `server.js`, `lib/gateway/index.js`, `public/styles.css`, `test/gateway.test.js` or `test/gateway-forms.test.js`:
    they already differ from Prettier on `46f7f98`. For the first three check that
    `npx prettier@3 --stdin-filepath <f> < <f> | diff <f> - | grep -c '^[<>]'` stays at its `46f7f98` value (`server.js`
    7, `lib/gateway/index.js` 22, `public/styles.css` 39). `*.md`, `*.html`, `*.json` and `docs/` are in
    `.prettierignore`.
  - Short "why" comments, as in `lib/gateway/*.js`; code lines at most 120 characters (UI copy strings in
    `public/*.js` may be longer, as the existing ones are).
  - Commit messages: plain, imperative. **No `Co-Authored-By`, no "Generated with", no AI attribution of any kind**
    (owner rule; it overrides any harness reminder).
  - UI copy is English; strings quoted in the spec are copied verbatim.
  - CI runs on Ubuntu, macOS and Windows: months are UTC, test dates are built with `Date.UTC(…)`, paths with
    `path.join`, and file-mode checks are skipped on `win32`.
- **Shared files.** Small, additive edits. The existing assertions this plan changes on purpose are in Task 7
  (`test/monitors-rules.test.js`, `test/budgets-monitors.test.js`, `test/monitors-api.test.js`: the rule list grows
  from 10 to 12).

## Rules and values

**From the spec (verbatim):**

| # | Decision |
|---|---|
| A1 | New append-only log in monthly files `.data/audit/governance-YYYY-MM.jsonl` (mode 0600, folder 0700). Months are kept for `governance.audit.retentionMonths` (default 12, min 6, max 120); whole months older than that are deleted at start and once a day, and the pruning is itself an entry. No size rotation. |
| A2 | Tamper evidence: every entry carries `seq`, `prev` and `mac`. `mac = HMAC-SHA256(key, prev + "\n" + canonical JSON of the entry without mac)`; `prev` is the previous entry's `mac` (the chain runs across months; the first entry ever has `prev: "genesis"`). The key is a 32-byte secret in the existing secret store (`acc.audit-chain`), created on first use. When the store cannot hold it, the key lives in `.data/audit/chain.key` (0600) and entries say `keyed: "file"`. A verify pass reports the first broken `seq`. Deleting whole old months by retention is expected and verify starts from the oldest kept file. |
| A3 | Actor travels with the request through `AsyncLocalStorage` (Node built-in), set in `server.js` right after `auth.check(req)` and in the gateway's `authed()`: `{ via: 'dashboard', mode, device, ip }` (device = the signed `zp_known` id in password mode, null otherwise; ip from `clientKey`), `{ via: 'apikey', keyId }`, `{ via: 'cli' }`, `{ via: 'system' }` (scheduled passes, retention) or `{ via: 'rule', rule }` (Monitors auto-pause). Module routers need no new `req` parameter. |
| A4 | What is recorded (each one entry): (1) every non-GET dashboard request under `/api/*` and every gateway admin request, after the handler, with `action` = method + route with ids replaced by `:id`, plus the body's `action`/`op` field when it is a short word, `target` (`{ type, id, name }` when the route names one) and `outcome` (`ok`, `refused` 4xx, `error` 5xx, with the status); (2) a `config.change` entry for every config.json write through any writer (`saveConfigSections`, `lib/integration-config.js`), with field-level changes; (3) sign-in events: login ok, login failed, lockout, logout, local sign-in code used, password set (CLI); (4) approvals and cancels of collaboration runs from the dashboard, `/v1/runs/:id/resume\|cancel` and A2A, with the key id; (5) agent and runtime control (mirrored from the existing `agent-audit.jsonl`, which stays); (6) `/api/trace/reveal` (a secret was shown); (7) key create, update, revoke, delete with the key's id and name; (8) retention pruning and audit-key creation. Request bodies are never copied, except the whitelisted short fields named here. |
| A5 | Field changes: `changes: [{ path, from, to }]`, paths like `gateway.guardrails.secrets`. A value whose path or key name looks secret (`key`, `token`, `secret`, `password`, `auth`, `header`, `apiKey`, `credential`, values that are secret references) is written as `"‹changed›"`; any other value is cut to 120 characters; arrays of objects are compared by their `id`/`name`; at most 50 changes per entry, then `truncated: n`. |
| A6 | When an entry cannot be written (disk full, permissions) the admin change itself still happens; the server keeps the failure in memory, the Governance page and `GET /api/governance/audit/status` show "degraded since …", and the new Monitors rule `audit_degraded` alerts. Changes made while degraded are counted and recorded as one `audit.gap` entry when writing works again. |
| A7 | Bug fix found while mapping: `GET /api/gateway/<route>` reaches `admin(route, 'GET')` for routes that write (`defaults` empties the default models, `settings` rewrites the section, `playground` runs a model). A GET on a write route now answers 405 and changes nothing. |
| A8 | `.cache/mcp-audit.jsonl` entries gain `keyId` when the call came through the gateway `/mcp` (the actor was missing). |
| A9 | API: `GET /api/governance/audit?from&to&actor&action&outcome&limit&before` (newest first, at most 500 per page), `GET /api/governance/audit/export?from&to&format=jsonl\|csv` (CSV with the cost export's formula guard), `GET /api/governance/audit/verify` (`{ ok, checked, from, to, brokenAt?, reason? }`), `GET /api/governance/audit/status` (retention, months kept, size, degraded, last verify), `POST /api/governance/settings` (`{ audit: { retentionMonths } }`, 400 on a bad value). All dashboard-session only; none is on the gateway or MCP. |
| A10 | Dashboard: a new **Governance** menu with one page for now, **Audit log** (`#governance`): filters (range, actor kind, action text, outcome), a table (time, actor, action, target, outcome, changes on expand), Verify with its result, Export CSV/JSONL, and the retention setting. Sub-project 3 adds Inventory and Compliance pages to this menu. |
| A11 | Monitors: rule `audit_degraded` (aggregate, default on, triggers while writing fails) and a daily verify; a broken chain raises `audit_chain_broken` (default on). Neither auto-pauses; alerts carry no entry content. |
| A12 | Out of scope: per-request logging of gateway model calls (already in `gateway-usage.jsonl`), external anchoring of the chain (e.g. to a remote log), multiple users (sub-project 4 adds named actors). |

Error handling (spec): entry write fails → change goes ahead; degraded state + `audit_degraded` alert; one
`audit.gap` entry later (A6). Unparsable line in a month file → verify reports it as broken at that seq; list skips it
and counts it. Audit key missing after entries exist → verify reports `reason: 'key missing'`; a new key is not created
silently over an existing chain (entries continue with `keyed` noted, chain restarts with `prev: "rekeyed"` and an
`audit.rekey` entry). Retention value out of range → 400, nothing written. GET on a write route of the gateway admin →
405, nothing changed.

**Values this plan fixes (where the spec leaves a choice):**

- **V1. An entry.** Written as one JSON line in this field order: `seq`, `ts` (ISO, UTC, ms), `action`, `actor`,
  `outcome` (`ok` unless given), then the entry's own fields (`op`, `target`, `status`, `changes`, `truncated`, …),
  `keyed: "file"` (only when the key is the file), `prev`, `mac`. Months are UTC (`ts.slice(0, 7)`). An entry without
  an actor is `{ via: 'system' }`; `server.js`'s `govRecord` fills in the request's actor first.
- **V2. Action names.** Requests: `<METHOD> <route>` (A4(1)). Others: `config.change`, `auth.login`,
  `auth.login_failed`, `auth.lockout`, `auth.logout`, `auth.local_code`, `auth.password_set`, `key.create`,
  `key.update`, `key.revoke`, `key.delete`, `run.approve`, `run.reject`, `run.cancel`, `agent.<action>`,
  `runtime.<action>`, `trace.reveal`, `audit.key_created`, `audit.rekey`, `audit.prune`, `audit.gap`.
- **V3. Request entries (A4(1)).** Methods `POST`, `PUT`, `PATCH`, `DELETE` on a path under `/api/`, once signed in
  (sign-in, sign-out and `/auth/local` are V9's own events). Written in `send()` right before the answer, so a client
  that reads the log after the answer finds it. Route with ids: `/api/monitors/:id` (not `channels`, `test`,
  `status`), `/api/datasets/:id` (not `settings`, `import`), `/api/datasets/:id/examples`,
  `/api/datasets/:id/examples/:id`, `/api/experiments/:id/cancel`; any other path as it is, cut to 120. `op` = the
  body's `action` or `op` when it matches `^[a-z][a-z0-9_-]{0,31}$`. `target` = `{ type, id?, name? }` when there is
  an id or a name: `type` is `gateway.<route>` under `/api/gateway/`, else the first segment after `/api/`; `id` is the
  path's first id, else the body's `id` when it matches `^[A-Za-z0-9_.:-]{1,80}$`; `name` is the body's `name`,
  trimmed and cut to 80. `outcome`: `ok` below 400, `refused` 4xx, `error` 5xx, and `refused` for a 200 answer with a
  non-empty `errors` list (the gateway admin's refusals); `status` always. **Not entries** (reads sent as `POST`; the
  dashboard polls `collab get` every 1.2 s while a run works): `POST /api/gateway/logs`, `POST /api/gateway/quota`,
  and with `op`: `providers test|models`, `knowledge get|search`, `collab get|list`, `sessions get`; `POST
  /api/integrations/test`, `POST /api/integrations/test-draft`, `POST /api/evals/preview`, `POST
  /api/cost/settings/preview`, `POST /api/cost/restate/preview`, `POST /api/brain/sources` with `op` `test`.
- **V4. Field changes (A5).** Secret-looking key names: `/key|token|secret|password|auth|header|credential/i`
  (`apiKey` included), except `secrets` (the guardrails mode at `gateway.guardrails.secrets`) and `keyCenters` (key
  ids of cost centers); a value under such a key anywhere up its path, a secret reference (`{ env }` or `{ keychain }`)
  and any list or object that holds one is `‹changed›`, but a boolean or a number is always shown (it cannot hold a
  secret: `tokenSaver: true → false` stays readable). Absent is `null`; text over 120 characters keeps 119 and `…`; a
  list or object that is not compared field by field is its JSON text, cut the same way. Objects recurse in sorted key
  order (`a.b.c`); arrays whose elements all have a unique `id` (else `name`) recurse by it (`providers[openai].baseUrl`,
  an added element as its fields from `null`); any other array is compared whole. `diff()` also returns `sections`
  (the changed top-level keys, sorted); a `config.change` entry's `target` is `{ type: 'config', id: sections joined
  with "," }`.
- **V5. The key.** `keySource({ dir, store })`: the store's `acc.audit-chain` (base64 of 32 bytes), else
  `<dir>/chain.key`; on the first `record`, a new key goes to the store (read back to be sure), else to `chain.key`
  (`wx`, 0600). The first entry ever is `audit.key_created` (with `keyed`); a key made while entries exist writes
  `audit.rekey` (`reason: 'key missing'`, `prev: "rekeyed"`) before the entry. `server.js` passes
  `defaultStore()` (demo mode: no store, so demo keeps its key file in the throwaway folder).
- **V6. Verify.** `{ ok, checked, from, to }`; on failure `brokenAt` and `reason`: `entry changed` (mac), `chain
  broken` (prev), `sequence broken` (a seq that is not the one before + 1; `brokenAt` is the seq expected),
  `unreadable line` (`brokenAt` after the entry before it), `key missing` (`brokenAt: null`, `checked: 0`; no key while
  entries exist). Only the part from the last `rekeyed` entry is checked; then `unverified` (entries before it) and
  `rekeyedAt`. A server that wrote or read a later entry than the last one verified reports `sequence broken` there
  (lines cut from the end). The last result is kept with `at` for `status()` and the Monitors.
- **V7. Degraded (A6).** `since` = the time of the first failed write; `missed` counts the entries that could not be
  written (a dashboard config change is two entries: `config.change` and its request). The next entry that can be
  written is preceded by `{ action: 'audit.gap', outcome: 'error', missed, since }`.
- **V8. Retention (A1).** A month `M` is deleted when `M` is before the current UTC month minus `retentionMonths`
  (it ended more than that many months ago): with 12 on 2026-11-03, 2025-10 goes and 2025-11 stays. A bad stored value
  counts as 12. `audit.prune` entry: `{ months, retentionMonths }`, only when a month went. The daily pass
  (`importPending`, `prune`, `verify`) runs once when the server listens and every 24 hours.
- **V9. Sign-in events (A4(3)).** `auth.login` (`ok`, 200, the actor's `device` is the id the new `zp_known` cookie
  carries), `auth.login_failed` (`refused`, 401), `auth.lockout` (`refused`, 429, `seconds`: only on the failure that
  starts a lockout; the 429s during it are not entries), `auth.logout` (`ok`, 200; a non-JSON logout is refused before
  it is an event), `auth.local_code` (`ok`, 200; only a code that worked), `auth.password_set` (actor `cli`, from
  `zaafpulse set-password`: the CLI leaves `.data/audit/pending/<ts>-<hex>.json` `{ action, ts }` and the server
  records it at its next start or daily pass with `occurredAt`; only `auth.password_set` is accepted from there).
- **V10. Gateway (A4(4), A4(7), A8).** `createGateway({ audit })`. Keys: `create`, `update` (with `changes` from V4),
  `revoke` and `delete` (only when the key existed), whoever calls them (the keys page, a code tool's key, the skills
  key, a budget save clearing a key budget); target `{ type: 'key', id, name }`. Runs: `collab.cancel` and
  `collab.resume` are wrapped, so the dashboard, `/v1/runs` and A2A all record `run.cancel`, `run.approve` or
  `run.reject` (`approve === false`), `refused` with 404/409 when the run is unknown or in the wrong state; an approval
  a key may not give (`approveOwnRuns` off) is `run.approve` `refused` 403 on `/v1/runs` and A2A. The key id comes
  from the actor. MCP audit lines get `keyId` when the actor is an API key (gateway `/mcp`, or an agent run with a key).
- **V11. Monitors (A11).** `audit_degraded`: title `Audit log degraded`, describe `The governance audit log cannot
  write its entries; changes go ahead unrecorded until it can.`, aggregate, `params: {}`, on by default, no auto-pause;
  no `snap.audit` → `no_data`; not degraded → `ok` (0, threshold 1); degraded → `triggered`, value `missed`, threshold
  1. `audit_chain_broken`: title `Audit chain broken`, describe `The daily check of the governance audit log found an
  entry changed, missing or out of order.`; no last verify → `no_data`; ok → `ok` (0); failed → `triggered`, value
  `brokenAt` (0 for `key missing`), threshold null, title = the reason when it is one of V6's five. Measure words:
  `<n> audit entr(y|ies) not written`, `broken at entry <n>` / `cannot be checked`.
- **V12. A7.** `GET /api/gateway/logs` still reads; a `GET` on any other `/api/gateway/<route>` is 405
  `method not allowed` and calls nothing; so is any method but `POST` (that one is recorded as `refused` 405).
- **V13. API (A9).** `from`/`to`: `YYYY-MM-DD` (UTC day; `to` is the end of that day) or an ISO time with a zone;
  `actor`: `dashboard`, `apikey`, `cli`, `system`, `rule` or a key id (`key_…`) matched against `actor.keyId`;
  `action`: at most 80 characters, found case-insensitively in `action` + ` ` + `op`; `outcome`: `ok`, `refused`,
  `error`; `limit` 1–500 (default 100); `before` ≥ 1. Answer `{ entries, next, skipped }`. Messages (400):
  `from: a date (YYYY-MM-DD) or an ISO time`, `to: …` (same), `from is after to`,
  `actor: dashboard, apikey, cli, system, rule or a key id`, `action: at most 80 characters`,
  `outcome: ok, refused or error`, `limit: a whole number from 1 to 500`, `before: a whole number from 1`,
  `format: jsonl or csv`, `audit.retentionMonths: a whole number from 6 to 120`. Export: `format` default `csv`, oldest
  first, `zaafpulse-audit-<from day|start>-<to day|now>.<csv|jsonl>`, at most 100,000 entries (413
  `too many entries; narrow the range`); JSONL lines are the stored lines; CSV columns `seq, time, actor, actor_id,
  ip, action, op, target_type, target_id, target_name, outcome, status, changes, prev, mac` through `csvCell` from
  `lib/cost/export.js`, changes as `path: from → to` joined with `; ` (absent `∅`). Status: `{ retentionMonths,
  months: [{ month, bytes }] newest first, bytes, degraded: { since, missed } | null, lastVerify }`. Settings save
  keeps the other `governance` fields and answers `{ audit: { retentionMonths } }`.
- **U1. Copy.** Sidebar group `GOVERNANCE`, item `Governance` (shield icon), sub-item `Audit log`; crumb
  `GOVERNANCE`; hero eyebrow `GOVERNANCE · AUDIT LOG`, title `Audit log`, line "Every change made to ZAAFPulse by a
  person or an API key: who, when, what and the outcome. Entries are chained, so a changed or deleted line shows when
  you verify."; panel `Audit log` (`kept by month, chained`); filters `Range` (`Last 24 hours`, `Last 7 days`
  (default), `Last 30 days`, `Everything kept`), `Actor` (`Anyone`, `Dashboard`, `API key`, `Command line`,
  `ZAAFPulse`, `Monitors rule`), `Action`, `Outcome` (`Any outcome`, `OK`, `Refused`, `Error`), `Apply`; columns
  `Time`, `Actor`, `Action`, `Target`, `Outcome`; `<n> field(s) changed` in a `<details>`; `Older entries`; status
  line `Keep months` + `Save`, `<n> months · <size>`, `Verify` with `Chain intact: entries <a>–<b> checked.` /
  `Broken at entry <n>: <reason>.` / `Cannot be checked: the audit key is missing.` / `Not checked yet.`,
  `Export CSV`, `Export JSONL`; banner `Degraded since <time>: <n> audit entr(y|ies) could not be written. Changes
  still go ahead.`

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/governance/chain.js` | create | canonical JSON, mac, seal, `verifyChain` (Task 1) |
| `lib/governance/diff.js` | create | field-level changes, masking, limits (Task 1) |
| `lib/governance/audit.js` | create | the store, the key source, the CLI queue (Task 2) |
| `lib/governance/context.js` | create | the actor slot per request (Task 3) |
| `lib/governance/events.js` | create | request and control lines as entries (Task 3) |
| `lib/governance/api.js` | create | `/api/governance/*` (Task 7) |
| `server.js` | modify (shared) | the store, `govRecord`, request entries in `send()`, the actor (Task 3); `configChanged` (Task 4); sign-in, gateway, control and reveal wiring (Task 5); A7 (Task 6); the API, the daily pass, the Monitors input (Task 7) |
| `lib/auth.js` | modify (shared) | `actorOf` (Task 3); `onEvent` (Task 5) |
| `lib/gateway/index.js` | modify (shared) | the key actor (Task 3); key and run entries (Task 5) |
| `lib/gateway/a2a.js` | modify (shared) | a refused approval (Task 5) |
| `lib/integrations.js` | modify (shared) | `keyId` on MCP audit lines (Task 5) |
| `lib/integration-config.js` | modify (shared) | `onChange` (Task 4) |
| `lib/monitors/rules.js`, `lib/monitors/index.js` | modify (shared) | the two rules and their input (Task 7) |
| `public/monitorsview.js` | modify (shared) | the rules' measure words (Task 7) |
| `bin/zaafpulse.js` | modify (shared) | `set-password` queues its event (Task 7) |
| `public/governanceview.js` | create | the Audit log page (Task 8) |
| `public/index.html`, `public/app.js`, `public/styles.css` | modify (shared) | menu, script, route, styles (Task 8) |
| `docs/governance.md` | create | the feature's documentation (Task 9) |
| `README.md`, `docs/monitors.md` | modify | feature cell, rules, section, docs list, API row, configuration row; the two rules (Task 9) |
| `test/helpers.js` | modify (shared) | `NO_JUDGE_PORTS` keeps the audit key out of the Keychain (Task 3) |
| `test/governance-chain.test.js` | create | Task 1 |
| `test/governance-audit.test.js` | create | Task 2 |
| `test/governance-events.test.js` | create | Task 3 |
| `test/governance-http.test.js` | create (Task 3), append (Tasks 4–7) | spawned `server.js`, ports 9600–9799 |
| `test/governance-config.test.js` | create | Task 4 |
| `test/governance-auth.test.js`, `test/governance-gateway.test.js` | create | Task 5 |
| `test/governance-api.test.js`, `test/governance-monitor.test.js`, `test/governance-cli.test.js` | create | Task 7 |
| `test/governance-ui.test.js` | create | Task 8 |
| `test/monitors-rules.test.js`, `test/budgets-monitors.test.js`, `test/monitors-api.test.js` | modify | the rule list (Task 7) |

---
### Task 1: the pure chain and the field-level changes

**Files:**
- Create: `lib/governance/chain.js`, `lib/governance/diff.js`
- Test: `test/governance-chain.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces (`lib/governance/chain.js`): `GENESIS = 'genesis'`, `REKEYED = 'rekeyed'`; `canonical(value) → string`
  (sorted keys, no spaces, `undefined` fields left out); `macOf(key: Buffer, entry) → hex string` (its own `mac`
  ignored); `seal(key, entry) → { ...entry, mac }`; `isEntry(x) → boolean` (integer `seq` ≥ 1, string `prev`, 64-hex
  `mac`); `verifyChain(items: (entry|null)[], key) → { ok, checked, from, to, brokenAt?, reason?, unverified?,
  rekeyedAt? }` (V6, without the key-missing and tail cases, which Task 2 adds).
- Produces (`lib/governance/diff.js`): `diff(before, after) → { changes: [{ path, from, to }], truncated?, sections }`
  (V4); `MASK = '‹changed›'`, `MAX_CHANGES = 50`, `MAX_TEXT = 120`.

- [ ] **Step 1: Write the failing test**

Create `test/governance-chain.test.js`:

```js
// Governance audit log (AI Governance 2): the pure chain (lib/governance/chain.js) and the field-level changes
// (lib/governance/diff.js). A changed field, a deleted or moved line and an unreadable line are each found at the right
// seq; a chain that starts after deleted months, or restarts after a rekey, still verifies.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { canonical, macOf, seal, verifyChain, GENESIS, REKEYED } = require('../lib/governance/chain');
const { diff, MASK } = require('../lib/governance/diff');

const KEY = Buffer.alloc(32, 7);
// n sealed entries in a row, the first one after `prev`.
function chainOf(n, { key = KEY, prev = GENESIS, from = 1 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = seal(key, {
      seq: from + i,
      ts: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
      action: 'config.change',
      actor: { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' },
      prev: out.length ? out[out.length - 1].mac : prev,
    });
    out.push(e);
  }
  return out;
}

test('chain: canonical JSON sorts keys at every level and leaves undefined out', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: undefined } }), '{"a":{"d":[2,{"x":0,"y":1}]},"b":1}');
  assert.equal(canonical('x'), '"x"');
  assert.equal(canonical(null), 'null');
});

test('chain: the mac is HMAC-SHA256 of prev, a newline and the canonical entry without its mac', () => {
  const e = { seq: 1, ts: '2026-11-01T00:00:00.000Z', action: 'audit.key_created', prev: GENESIS };
  const want = crypto
    .createHmac('sha256', KEY)
    .update(`genesis\n${canonical(e)}`)
    .digest('hex');
  assert.equal(macOf(KEY, e), want);
  assert.equal(seal(KEY, e).mac, want);
  assert.equal(macOf(KEY, { ...e, mac: 'ignored' }), want);
  assert.notEqual(macOf(Buffer.alloc(32, 8), e), want);
});

test('verify: an untouched chain is ok, also when it starts after deleted months', () => {
  assert.deepEqual(verifyChain(chainOf(5), KEY), { ok: true, checked: 5, from: 1, to: 5 });
  // Retention deleted seq 1-40: the first kept entry points at a mac that is no longer there.
  const kept = chainOf(3, { prev: 'f'.repeat(64), from: 41 });
  assert.deepEqual(verifyChain(kept, KEY), { ok: true, checked: 3, from: 41, to: 43 });
  assert.deepEqual(verifyChain([], KEY), { ok: true, checked: 0, from: null, to: null });
});

test('verify: a changed field, a deleted line, a moved line and an unreadable line are found at their seq', () => {
  const c = chainOf(5);
  const changed = c.map((e) => (e.seq === 3 ? { ...e, actor: { ...e.actor, ip: '10.0.0.9' } } : e));
  assert.deepEqual(verifyChain(changed, KEY), {
    ok: false,
    checked: 2,
    from: 1,
    to: 2,
    brokenAt: 3,
    reason: 'entry changed',
  });
  const deleted = c.filter((e) => e.seq !== 4);
  assert.equal(verifyChain(deleted, KEY).brokenAt, 4);
  assert.equal(verifyChain(deleted, KEY).reason, 'sequence broken');
  const moved = [c[0], c[2], c[1], c[3], c[4]];
  assert.equal(verifyChain(moved, KEY).brokenAt, 2);
  // A line renumbered to hide a deletion still breaks the chain: its prev names the deleted entry.
  const renumbered = [c[0], c[1], { ...c[3], seq: 3 }];
  assert.equal(verifyChain(renumbered, KEY).reason, 'chain broken');
  const unreadable = [c[0], c[1], null, c[3]];
  assert.deepEqual(
    [verifyChain(unreadable, KEY).brokenAt, verifyChain(unreadable, KEY).reason],
    [3, 'unreadable line'],
  );
  assert.equal(verifyChain([null, c[1]], KEY).brokenAt, 1);
  assert.equal(verifyChain(c, Buffer.alloc(32, 1)).reason, 'entry changed');
});

test('verify: after a rekey only the new part is checked; the part before it is counted as unverified', () => {
  const old = chainOf(3, { key: Buffer.alloc(32, 1) });
  const fresh = chainOf(2, { prev: REKEYED, from: 4 });
  assert.deepEqual(verifyChain([...old, ...fresh], KEY), {
    ok: true,
    checked: 2,
    from: 4,
    to: 5,
    unverified: 3,
    rekeyedAt: 4,
  });
  const tampered = [...old, fresh[0], { ...fresh[1], action: 'auth.login' }];
  assert.equal(verifyChain(tampered, KEY).brokenAt, 5);
});

test('diff: field paths, secrets masked by key name and by reference, text cut to 120 characters', () => {
  const before = {
    userName: 'Ana',
    gateway: { guardrails: { secrets: 'redact' }, tokenSaver: true },
    monitors: { channels: { webhook: { url: { keychain: 'acc.monitors-webhook-url' } } } },
    vaultPaths: ['/a'],
  };
  const after = {
    userName: 'x'.repeat(200),
    gateway: { guardrails: { secrets: 'block' }, tokenSaver: true, apiToken: 'plain-text' },
    monitors: { channels: { webhook: { url: { keychain: 'acc.other' } } } },
    vaultPaths: ['/a', '/b'],
  };
  const d = diff(before, after);
  assert.deepEqual(d.changes, [
    { path: 'gateway.apiToken', from: null, to: MASK },
    { path: 'gateway.guardrails.secrets', from: 'redact', to: 'block' },
    { path: 'monitors.channels.webhook.url', from: MASK, to: MASK },
    { path: 'userName', from: 'Ana', to: `${'x'.repeat(119)}…` },
    { path: 'vaultPaths', from: '["/a"]', to: '["/a","/b"]' },
  ]);
  assert.deepEqual(d.sections, ['gateway', 'monitors', 'userName', 'vaultPaths']);
  assert.equal(d.truncated, undefined);
  assert.deepEqual(diff({ a: 1 }, { a: 1 }), { changes: [], sections: [] });
  // A switch or a number under a secret-looking name cannot hold a secret, and stays readable.
  assert.deepEqual(diff({ gateway: { tokenSaver: true } }, { gateway: { tokenSaver: false } }).changes, [
    { path: 'gateway.tokenSaver', from: true, to: false },
  ]);
});

test('diff: arrays of objects are compared by id or name; a new section counts', () => {
  const p = (id, extra = {}) => ({ id, preset: 'custom', baseUrl: `https://${id}.example/v1`, ...extra });
  const before = { gateway: { providers: [p('a'), p('b')], routes: [{ name: 'r1', targets: ['a/m'] }] } };
  const after = {
    gateway: {
      providers: [p('b', { baseUrl: 'https://b2.example/v1' }), p('c', { apiKey: { keychain: 'acc.gw-c' } })],
      routes: [{ name: 'r1', targets: ['a/m', 'b/m'] }],
    },
    governance: { audit: { retentionMonths: 24 } },
  };
  assert.deepEqual(diff(before, after).changes, [
    { path: 'gateway.providers[a].baseUrl', from: 'https://a.example/v1', to: null },
    { path: 'gateway.providers[a].id', from: 'a', to: null },
    { path: 'gateway.providers[a].preset', from: 'custom', to: null },
    { path: 'gateway.providers[b].baseUrl', from: 'https://b.example/v1', to: 'https://b2.example/v1' },
    { path: 'gateway.providers[c].apiKey', from: null, to: MASK },
    { path: 'gateway.providers[c].baseUrl', from: null, to: 'https://c.example/v1' },
    { path: 'gateway.providers[c].id', from: null, to: 'c' },
    { path: 'gateway.providers[c].preset', from: null, to: 'custom' },
    { path: 'gateway.routes[r1].targets', from: '["a/m"]', to: '["a/m","b/m"]' },
    { path: 'governance.audit.retentionMonths', from: null, to: 24 },
  ]);
  // A list whose objects have no id is compared whole, and masked when it holds a secret.
  assert.deepEqual(diff({ x: [{ a: 1 }] }, { x: [{ a: 2 }] }).changes, [
    { path: 'x', from: '[{"a":1}]', to: '[{"a":2}]' },
  ]);
  assert.deepEqual(diff({ x: [{ a: 1 }] }, { x: [{ token: 'abc' }] }).changes, [
    { path: 'x', from: '[{"a":1}]', to: MASK },
  ]);
  assert.deepEqual(diff({}, { cost: {} }).changes, [{ path: 'cost', from: null, to: '{}' }]);
});

test('diff: at most 50 changes, then truncated says how many more', () => {
  const after = {};
  for (let i = 0; i < 73; i++) after[`k${String(i).padStart(2, '0')}`] = i;
  const d = diff({}, after);
  assert.equal(d.changes.length, 50);
  assert.equal(d.truncated, 23);
  assert.equal(d.changes[0].path, 'k00');
  assert.equal(d.sections.length, 73);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/governance-chain.test.js`
Expected: FAIL (`Cannot find module '../lib/governance/chain'`).

- [ ] **Step 3: Create the two modules**

Create `lib/governance/chain.js`:

```js
// Governance audit log (AI Governance 2): the tamper-evident chain, pure (no I/O, no clock). An entry's mac is
// HMAC-SHA256(key, prev + "\n" + canonical JSON of the entry without mac); prev is the mac of the entry before it,
// "genesis" for the first entry ever and "rekeyed" where a new key restarts the chain (the old key was missing).
const crypto = require('crypto');

const GENESIS = 'genesis';
const REKEYED = 'rekeyed';
const MAC = /^[0-9a-f]{64}$/;

// JSON with the keys of every object sorted and no spaces: the same entry always gives the same text. An undefined
// field is left out, as JSON.stringify does when the line is written.
function canonical(v) {
  if (v === undefined || v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x)).join(',')}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

// The mac of an entry (its own mac field, if any, is not part of it).
function macOf(key, entry) {
  const { mac, ...rest } = entry;
  return crypto
    .createHmac('sha256', key)
    .update(`${rest.prev}\n${canonical(rest)}`)
    .digest('hex');
}

// The entry with its mac added.
const seal = (key, entry) => ({ ...entry, mac: macOf(key, entry) });

const isEntry = (e) =>
  !!e &&
  typeof e === 'object' &&
  !Array.isArray(e) &&
  Number.isInteger(e.seq) &&
  e.seq >= 1 &&
  typeof e.prev === 'string' &&
  typeof e.mac === 'string' &&
  MAC.test(e.mac);

// Checks entries in file order (null where a line did not parse) with the current key. The chain restarts at the last
// "rekeyed" entry: what came before it was sealed with a key that is gone, so it is counted as unverified, not checked.
// The first entry checked keeps whatever prev it has (older months may have been deleted by retention). Returns
// { ok, checked, from, to } plus { brokenAt, reason } at the first entry that fails, and { unverified, rekeyedAt }
// after a rekey.
function verifyChain(items, key) {
  let start = 0;
  for (let i = items.length - 1; i > 0; i--)
    if (isEntry(items[i]) && items[i].prev === REKEYED) {
      start = i;
      break;
    }
  let prev = null;
  let first = null;
  let checked = 0;
  // Where an unreadable line sits: after the entry before it, else just before the next readable one.
  const seqAt = (i) => {
    if (prev) return prev.seq + 1;
    const next = items.slice(i + 1).find(isEntry);
    return next ? Math.max(1, next.seq - 1) : 1;
  };
  const broken = (brokenAt, reason) => ({
    ok: false,
    checked,
    from: first,
    to: prev ? prev.seq : null,
    brokenAt,
    reason,
  });
  for (let i = start; i < items.length; i++) {
    const e = items[i];
    if (!isEntry(e)) return broken(seqAt(i), 'unreadable line');
    if (prev && e.seq !== prev.seq + 1) return broken(prev.seq + 1, 'sequence broken');
    if (prev && e.prev !== prev.mac) return broken(e.seq, 'chain broken');
    if (macOf(key, e) !== e.mac) return broken(e.seq, 'entry changed');
    if (first === null) first = e.seq;
    prev = { seq: e.seq, mac: e.mac };
    checked++;
  }
  return {
    ok: true,
    checked,
    from: first,
    to: prev ? prev.seq : null,
    ...(start > 0 ? { unverified: start, rekeyedAt: items[start].seq } : {}),
  };
}

module.exports = { GENESIS, REKEYED, canonical, macOf, seal, isEntry, verifyChain };
```

Create `lib/governance/diff.js`:

```js
// Governance audit log (AI Governance 2): the field-level changes between two config.json values, pure (spec A5).
// A change is { path, from, to } with paths like gateway.guardrails.secrets; arrays of objects are compared by their
// id (or name), as gateway.providers[openai].baseUrl. A value under a key that looks secret, or a secret reference, is
// written as "‹changed›" (a switch or a number is not: it cannot hold one); any other text is cut to 120 characters.
// At most 50 changes, then `truncated` says how many more there were.
const { canonical } = require('./chain');

const MASK = '‹changed›';
const MAX_CHANGES = 50;
const MAX_TEXT = 120;
// Key names that hold secrets or point at them (apiKey, x-api-key, headers, oauth, credentials …).
const SECRET_WORD = /key|token|secret|password|auth|header|credential/i;
// Names that only look secret: the guardrails mode (gateway.guardrails.secrets) and the key ids of cost centers.
const NOT_SECRET = new Set(['secrets', 'keyCenters']);
const secretName = (k) => SECRET_WORD.test(k) && !NOT_SECRET.has(k);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// A secret reference, as lib/secrets.js isRef: { env: name } or { keychain: service }.
const isRef = (v) => isObj(v) && (typeof v.env === 'string' || typeof v.keychain === 'string');
// Anything under it that is a reference or sits under a secret-looking key.
const hasSecret = (v) =>
  isRef(v) ||
  (Array.isArray(v) && v.some(hasSecret)) ||
  (isObj(v) && Object.entries(v).some(([k, x]) => secretName(k) || hasSecret(x)));
const cut = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

// How a value is written in a change: absent is null, text is cut, a list or an object is its JSON text, cut.
function shown(v, secret) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (secret || hasSecret(v)) return MASK;
  if (typeof v === 'string') return cut(v);
  return cut(JSON.stringify(v));
}

// An array as a map by id (or name), or null when an element has neither or two share one. An empty array is an empty
// map, so a first provider added to [] is still compared field by field.
function byId(arr) {
  if (!Array.isArray(arr)) return null;
  const m = new Map();
  for (const x of arr) {
    const id = isObj(x)
      ? typeof x.id === 'string' || typeof x.id === 'number'
        ? String(x.id)
        : typeof x.name === 'string'
          ? x.name
          : null
      : null;
    if (id === null || m.has(id)) return null;
    m.set(id, x);
  }
  return m;
}

function walk(a, b, path, secret, out) {
  if (canonical(a) === canonical(b)) return;
  const leaf = () => out.push({ path, from: shown(a, secret), to: shown(b, secret) });
  if (isRef(a) || isRef(b)) return leaf();
  const objA = isObj(a) || a === undefined;
  const objB = isObj(b) || b === undefined;
  if (objA && objB && (isObj(a) || isObj(b))) {
    const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
    if (!keys.length) return leaf();
    for (const k of keys) walk((a || {})[k], (b || {})[k], path ? `${path}.${k}` : k, secret || secretName(k), out);
    return;
  }
  const ma = a === undefined ? new Map() : byId(a);
  const mb = b === undefined ? new Map() : byId(b);
  if (ma && mb && (Array.isArray(a) || Array.isArray(b)) && (ma.size || mb.size)) {
    for (const id of [...new Set([...ma.keys(), ...mb.keys()])])
      walk(ma.get(id), mb.get(id), `${path}[${id}]`, secret, out);
    return;
  }
  leaf();
}

// diff(before, after) -> { changes: [{ path, from, to }], truncated?, sections }: sections are the top-level keys
// that changed, sorted.
function diff(before, after) {
  const out = [];
  walk(isObj(before) ? before : {}, isObj(after) ? after : {}, '', false, out);
  const sections = [...new Set(out.map((c) => c.path.split(/[.[]/)[0]))].sort();
  return {
    changes: out.slice(0, MAX_CHANGES),
    ...(out.length > MAX_CHANGES ? { truncated: out.length - MAX_CHANGES } : {}),
    sections,
  };
}

module.exports = { diff, MASK, MAX_CHANGES, MAX_TEXT };
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test test/governance-chain.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check lib/governance/chain.js lib/governance/diff.js test/governance-chain.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add lib/governance/chain.js lib/governance/diff.js test/governance-chain.test.js
git commit -m "Governance audit: the chain and the field-level changes"
```

---
### Task 2: the store (`lib/governance/audit.js`)

**Files:**
- Create: `lib/governance/audit.js`
- Test: `test/governance-audit.test.js` (create)

**Interfaces:**
- Consumes: Task 1's `GENESIS`, `REKEYED`, `seal`, `isEntry`, `verifyChain`; `csvCell(value)` from
  `lib/cost/export.js` (the formula guard).
- Produces: `createGovernanceAudit({ dir, getKey, now = Date.now })` →
  - `record({ action, actor?, outcome?, ...fields }) → entry | null` (never throws; V1, V5, V7),
  - `list({ from?, to?, actor?, action?, outcome?, limit?, before? }) → { entries, next, skipped }` (times in ms),
  - `export({ from?, to?, format: 'csv'|'jsonl' }) → { body, type, name }` (throws `{ status: 413 }` past 100,000),
  - `verify() → { ok, checked, from, to, brokenAt?, reason?, unverified?, rekeyedAt? }`,
  - `status() → { months: [{ month, bytes }], bytes, degraded: { since, missed } | null, lastVerify }`,
  - `prune(retentionMonths) → string[]` (the deleted months), `importPending() → number`.
- Produces: `keySource({ dir, store = null }) → ({ create = false }) → { key, keyed: 'store'|'file', created } | null`;
  `queueEvent(dir, { action }, t = Date.now()) → string[]` (paths made; never throws); `cleanRetention(v) → 6…120`
  (else 12); `monthOf(t)`, `monthsBefore(month, n)`, `RETENTION`, `SERVICE = 'acc.audit-chain'`, `CSV_COLUMNS`.

- [ ] **Step 1: Write the failing test**

Create `test/governance-audit.test.js`:

```js
// Governance audit log (AI Governance 2): the store (lib/governance/audit.js). Monthly files chained across months,
// the key from the store or the file, a rekey when the key is gone, the degraded state and its gap entry, list filters
// and paging, the exports with the formula guard, retention by whole months, and the CLI's pending events.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../lib/governance/audit');

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 864e5;
function setup(t, { store = null } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-audit-')), 'audit');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const clock = { t: NOW };
  const make = (s = store) =>
    A.createGovernanceAudit({ dir, getKey: A.keySource({ dir, store: s }), now: () => clock.t });
  return { dir, clock, audit: make(), make };
}
const memStore = () => {
  const items = new Map();
  return { items, get: (k) => items.get(k) || null, set: (k, v) => items.set(k, v) };
};
const linesIn = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const dash = { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' };

test('record: the first entry makes the key (in the store) and says so; entries are chained in a month file', (t) => {
  const store = memStore();
  const { dir, audit } = setup(t, { store });
  const e = audit.record({ action: 'config.change', actor: dash, changes: [{ path: 'userName', from: 'a', to: 'b' }] });
  assert.equal(e.seq, 2);
  assert.equal(store.items.get(A.SERVICE).length, 44); // 32 bytes, base64
  const file = path.join(dir, 'governance-2026-11.jsonl');
  const [k, c] = linesIn(file);
  assert.deepEqual(
    [k.seq, k.action, k.actor, k.keyed, k.prev, c.prev, c.action, c.outcome],
    [1, 'audit.key_created', { via: 'system' }, 'store', 'genesis', k.mac, 'config.change', 'ok'],
  );
  assert.deepEqual(Object.keys(c), ['seq', 'ts', 'action', 'actor', 'outcome', 'changes', 'prev', 'mac']);
  assert.equal(c.ts, '2026-11-03T12:00:00.000Z');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  assert.deepEqual(audit.verify(), { ok: true, checked: 2, from: 1, to: 2 });
  // A record without an actor is the server's own.
  assert.deepEqual(audit.record({ action: 'audit.prune' }).actor, { via: 'system' });
});

test('record: the chain runs across months; a store that cannot hold the key leaves it in chain.key', (t) => {
  const broken = { get: () => null, set: () => {} }; // takes the key, never gives it back
  const { dir, clock, audit, make } = setup(t, { store: broken });
  audit.record({ action: 'auth.login', actor: dash });
  clock.t = Date.UTC(2026, 11, 1, 0, 5);
  audit.record({ action: 'auth.logout', actor: dash });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['chain.key', 'governance-2026-11.jsonl', 'governance-2026-12.jsonl']);
  const [dec] = linesIn(path.join(dir, 'governance-2026-12.jsonl'));
  assert.equal(dec.seq, 3);
  assert.equal(dec.keyed, 'file');
  assert.equal(dec.prev, linesIn(path.join(dir, 'governance-2026-11.jsonl'))[1].mac);
  // A fresh server finds the key in the file and goes on with the chain.
  const again = make();
  assert.equal(again.record({ action: 'auth.login', actor: dash }).seq, 4);
  assert.deepEqual(again.verify(), { ok: true, checked: 4, from: 1, to: 4 });
});

test('verify: a changed field, a deleted line and lines cut from the end are reported with their seq', (t) => {
  const { dir, audit, make } = setup(t, { store: memStore() });
  for (let i = 0; i < 5; i++) audit.record({ action: 'config.change', actor: dash, op: `n${i}` });
  const file = path.join(dir, 'governance-2026-11.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('"op":"n2"', '"op":"nX"'));
  assert.deepEqual([audit.verify().brokenAt, audit.verify().reason], [4, 'entry changed']);
  const lines = text.trim().split('\n');
  fs.writeFileSync(file, [...lines.slice(0, 2), ...lines.slice(3)].join('\n') + '\n');
  assert.deepEqual([audit.verify().brokenAt, audit.verify().reason], [3, 'sequence broken']);
  // The chain left after the last line is cut holds together; the server knows what it wrote last.
  fs.writeFileSync(file, lines.slice(0, 5).join('\n') + '\n');
  assert.deepEqual([audit.verify().ok, audit.verify().brokenAt], [false, 6]);
  assert.equal(audit.status().lastVerify.brokenAt, 6);
  assert.equal(audit.status().lastVerify.at, '2026-11-03T12:00:00.000Z');
  // An unparsable line: verify breaks there, list skips it and counts it.
  fs.writeFileSync(file, [...lines.slice(0, 3), '{"seq":4,"half', ...lines.slice(4)].join('\n') + '\n');
  const fresh = make();
  assert.deepEqual([fresh.verify().brokenAt, fresh.verify().reason], [4, 'unreadable line']);
  assert.equal(fresh.list({}).skipped, 1);
  assert.equal(fresh.list({}).entries.length, 5);
});

test('rekey: entries without their key are not sealed over silently; the chain restarts with audit.rekey', (t) => {
  const { dir, audit, make } = setup(t, { store: memStore() });
  audit.record({ action: 'auth.login', actor: dash });
  audit.record({ action: 'auth.logout', actor: dash });
  const lost = make(memStore()); // another store: the key is gone
  assert.deepEqual(lost.verify(), {
    ok: false,
    checked: 0,
    from: null,
    to: null,
    brokenAt: null,
    reason: 'key missing',
  });
  const e = lost.record({ action: 'config.change', actor: dash });
  const all = linesIn(path.join(dir, 'governance-2026-11.jsonl'));
  assert.deepEqual(
    all.map((x) => [x.seq, x.action, x.prev === 'rekeyed']),
    [
      [1, 'audit.key_created', false],
      [2, 'auth.login', false],
      [3, 'auth.logout', false],
      [4, 'audit.rekey', true],
      [5, 'config.change', false],
    ],
  );
  assert.equal(e.seq, 5);
  assert.deepEqual(lost.verify(), { ok: true, checked: 2, from: 4, to: 5, unverified: 3, rekeyedAt: 4 });
});

test('degraded: a write that fails is counted, the status says since when, and one audit.gap entry follows', (t) => {
  const { dir, clock, audit } = setup(t, { store: memStore() });
  audit.record({ action: 'auth.login', actor: dash });
  const file = path.join(dir, 'governance-2026-11.jsonl');
  const kept = fs.readFileSync(file);
  fs.rmSync(file);
  fs.mkdirSync(file); // the month file is now a folder: every append fails
  clock.t += 1000;
  assert.equal(audit.record({ action: 'config.change', actor: dash }), null);
  clock.t += 1000;
  assert.equal(audit.record({ action: 'config.change', actor: dash }), null);
  assert.deepEqual(audit.status().degraded, { since: '2026-11-03T12:00:01.000Z', missed: 2 });
  fs.rmdirSync(file);
  fs.writeFileSync(file, kept, { mode: 0o600 });
  clock.t += 1000;
  const e = audit.record({ action: 'auth.logout', actor: dash });
  assert.equal(e.seq, 4);
  const gap = linesIn(file)[2];
  assert.deepEqual(
    [gap.seq, gap.action, gap.outcome, gap.missed, gap.since],
    [3, 'audit.gap', 'error', 2, '2026-11-03T12:00:01.000Z'],
  );
  assert.equal(audit.status().degraded, null);
  assert.equal(audit.verify().ok, true);
});

test('list: newest first, filters by time, actor kind or key id, action text and outcome, pages with before', (t) => {
  const { clock, audit } = setup(t, { store: memStore() });
  const key = { via: 'apikey', keyId: 'key_abc123' };
  const rows = [
    ['auth.login', dash, 'ok'],
    ['POST /api/gateway/keys', dash, 'ok', 'create'],
    ['run.approve', key, 'refused'],
    ['run.cancel', key, 'ok'],
    ['config.change', dash, 'ok'],
    ['POST /api/config', dash, 'error'],
  ];
  for (const [action, actor, outcome, op] of rows) {
    clock.t += DAY;
    audit.record({ action, actor, outcome, ...(op ? { op } : {}) });
  }
  const seqs = (q) => audit.list(q).entries.map((e) => e.seq);
  assert.deepEqual(seqs({}), [7, 6, 5, 4, 3, 2, 1]);
  const page = audit.list({ limit: 3 });
  assert.deepEqual([page.entries.map((e) => e.seq), page.next], [[7, 6, 5], 5]);
  assert.deepEqual(
    audit.list({ limit: 3, before: 5 }).entries.map((e) => e.seq),
    [4, 3, 2],
  );
  assert.equal(audit.list({ limit: 3, before: 2 }).next, null);
  assert.deepEqual(seqs({ actor: 'apikey' }), [5, 4]);
  assert.deepEqual(seqs({ actor: 'key_abc123' }), [5, 4]);
  assert.deepEqual(seqs({ actor: 'system' }), [1]);
  assert.deepEqual(seqs({ action: 'KEYS CREATE' }), [3]);
  assert.deepEqual(seqs({ action: 'run.' }), [5, 4]);
  assert.deepEqual(seqs({ outcome: 'refused' }), [4]);
  assert.deepEqual(seqs({ from: NOW + 2 * DAY, to: NOW + 4 * DAY }), [5, 4, 3]);
  assert.equal(audit.list({ limit: 9999 }).entries.length, 7);
});

test('export: JSON lines exactly as written, CSV with one line per entry and the formula guard', (t) => {
  const { dir, audit } = setup(t, { store: memStore() });
  audit.record({
    action: 'POST /api/gateway/keys',
    actor: { via: 'apikey', keyId: 'key_1' },
    op: 'create',
    target: { type: 'gateway.keys', id: 'key_2', name: '=HYPERLINK("x")' },
    status: 200,
  });
  audit.record({ action: 'config.change', actor: dash, changes: [{ path: 'userName', from: null, to: '+1, two' }] });
  const j = audit.export({ format: 'jsonl' });
  assert.equal(j.body, fs.readFileSync(path.join(dir, 'governance-2026-11.jsonl'), 'utf8'));
  assert.equal(j.type, 'application/x-ndjson');
  assert.equal(j.name, 'zaafpulse-audit-start-now.jsonl');
  const c = audit.export({ format: 'csv', from: Date.UTC(2026, 10, 1), to: NOW });
  assert.equal(c.name, 'zaafpulse-audit-2026-11-01-2026-11-03.csv');
  const lines = c.body.split('\r\n');
  assert.equal(lines[0], A.CSV_COLUMNS.join(','));
  assert.equal(lines.length, 5); // header, three entries, the empty end
  assert.match(
    lines[2],
    /^2,2026-11-03T12:00:00\.000Z,apikey,key_1,,POST \/api\/gateway\/keys,create,gateway\.keys,key_2,"'=HYPERLINK\(""x""\)",ok,200,,/,
  );
  assert.match(lines[3], /,"userName: ∅ → \+1, two",/);
});

test('prune: whole months that ended more than the retention ago go, and the pruning is an entry', (t) => {
  const { dir, clock, audit } = setup(t, { store: memStore() });
  for (const [y, m] of [
    [2025, 8],
    [2025, 9],
    [2025, 10],
    [2026, 10],
  ]) {
    clock.t = Date.UTC(y, m, 15);
    audit.record({ action: 'auth.login', actor: dash });
  }
  clock.t = NOW;
  assert.deepEqual(audit.prune(12), ['2025-09', '2025-10']);
  assert.deepEqual(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort(),
    ['governance-2025-11.jsonl', 'governance-2026-11.jsonl'],
  );
  const last = audit.list({ limit: 1 }).entries[0];
  assert.deepEqual([last.action, last.months, last.retentionMonths], ['audit.prune', ['2025-09', '2025-10'], 12]);
  assert.deepEqual(audit.verify(), { ok: true, checked: 3, from: 4, to: 6 });
  assert.deepEqual(audit.prune(12), []);
  // A retention out of range counts as 12; at most 120, at least 6.
  assert.deepEqual(
    [A.cleanRetention(5), A.cleanRetention(6), A.cleanRetention(120), A.cleanRetention('24')],
    [12, 6, 120, 12],
  );
});

test('pending: the CLI leaves an event, the server records it with the cli actor and removes the file', (t) => {
  const { dir, audit } = setup(t, { store: memStore() });
  const made = A.queueEvent(dir, { action: 'auth.password_set' }, Date.UTC(2026, 10, 2, 9));
  assert.equal(made.length, 3);
  fs.writeFileSync(path.join(dir, 'pending', '1-0000000a.json'), '{"action":"config.change","ts":1}');
  assert.equal(audit.importPending(), 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pending')), []);
  const e = audit.list({}).entries[0];
  assert.deepEqual(
    [e.action, e.actor, e.occurredAt],
    ['auth.password_set', { via: 'cli' }, '2026-11-02T09:00:00.000Z'],
  );
  assert.equal(audit.importPending(), 0);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/governance-audit.test.js`
Expected: FAIL (`Cannot find module '../lib/governance/audit'`).

- [ ] **Step 3: Create the store**

Create `lib/governance/audit.js`:

```js
// Governance audit log (AI Governance 2): who changed what in ZAAFPulse, when, and with what outcome. Append-only
// monthly files .data/audit/governance-YYYY-MM.jsonl (UTC months; files 0600, folder 0700), one sealed entry per line
// (lib/governance/chain.js), chained across months with a key from the secret store (acc.audit-chain), or from
// .data/audit/chain.key when the store cannot hold it. Whole months older than the retention are deleted, and that is
// an entry too. A write that fails never stops the change it records: the log is then degraded, and the changes it
// missed become one audit.gap entry once writing works again. The server is the only writer; the CLI leaves events in
// pending/ for it (queueEvent). The clock and the key come in from outside.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GENESIS, REKEYED, seal, isEntry, verifyChain } = require('./chain');
const { csvCell } = require('../cost/export');

const SERVICE = 'acc.audit-chain';
const FILE = /^governance-(\d{4}-(?:0[1-9]|1[0-2]))\.jsonl$/;
const RETENTION = { default: 12, min: 6, max: 120 };
const MAX_PAGE = 500;
const MAX_EXPORT = 100000;
// What the CLI may leave for the server to record (bin/zaafpulse.js set-password).
const CLI_ACTIONS = new Set(['auth.password_set']);
const MAX_PENDING = 100;

const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
// The month `n` months before YYYY-MM.
function monthsBefore(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}
// retentionMonths from config.json: a whole number from 6 to 120, else 12.
const cleanRetention = (v) => (Number.isInteger(v) && v >= RETENTION.min && v <= RETENTION.max ? v : RETENTION.default);

// Where the chain key comes from: the secret store first, then chain.key. create: true makes one when there is none,
// in the store when it holds it (read back to be sure), else in chain.key. Returns { key, keyed, created } or null;
// `created` is true on the one call that made it. A key that reads is kept in memory.
function keySource({ dir, store = null }) {
  let cached = null;
  const file = path.join(dir, 'chain.key');
  const valid = (text) => {
    const key = Buffer.from(String(text || '').trim(), 'base64');
    return key.length === 32 ? key : null;
  };
  return ({ create = false } = {}) => {
    if (cached) return cached;
    if (store) {
      let key = null;
      try {
        key = valid(store.get(SERVICE));
      } catch {
        /* the store cannot be read: try the file */
      }
      if (key) return (cached = { key, keyed: 'store', created: false });
    }
    let fromFile = null;
    try {
      fromFile = valid(fs.readFileSync(file, 'utf8'));
    } catch {
      /* none yet */
    }
    if (fromFile) return (cached = { key: fromFile, keyed: 'file', created: false });
    if (!create) return null;
    const key = crypto.randomBytes(32);
    const text = key.toString('base64');
    if (store) {
      try {
        store.set(SERVICE, text);
        if (store.get(SERVICE) === text) {
          cached = { key, keyed: 'store', created: false };
          return { ...cached, created: true };
        }
      } catch {
        /* the store cannot hold it: the file below */
      }
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${text}\n`, { mode: 0o600, flag: 'wx' });
    cached = { key, keyed: 'file', created: false };
    return { ...cached, created: true };
  };
}

// The CLI's way in (bin/zaafpulse.js): one event as a file in <dir>/pending, recorded by the server when it next
// starts or runs its daily pass. Never throws; returns the paths it made (a root-run CLI hands them to the data
// folder's owner).
function queueEvent(dir, event, t = Date.now()) {
  const pending = path.join(dir, 'pending');
  const file = path.join(pending, `${t}-${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ action: event.action, ts: t }), { mode: 0o600, flag: 'wx' });
    return [dir, pending, file];
  } catch {
    return [];
  }
}

function createGovernanceAudit({ dir, getKey, now = Date.now }) {
  let tail; // { seq, mac } of the last entry written, null when there is none, undefined until read
  let degraded = null; // { since, missed } while entries cannot be written
  let restart = null; // 'created' or 'rekeyed' until the entry that says so is written
  let lastVerify = null;

  // The month files, oldest first: [{ month, file }].
  function months() {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return names
      .map((n) => n.match(FILE))
      .filter(Boolean)
      .map((m) => ({ month: m[1], file: path.join(dir, m[0]) }))
      .sort((a, b) => (a.month < b.month ? -1 : 1));
  }
  // One month's lines: { line, entry } where entry is null for a line that does not parse as an entry.
  function linesOf(file) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        let entry = null;
        try {
          entry = JSON.parse(line);
        } catch {
          /* counted where it is read */
        }
        return { line, entry: isEntry(entry) ? entry : null };
      });
  }
  // The last readable entry, from the newest month that has one.
  function readTail() {
    for (const m of months().reverse()) {
      const last = linesOf(m.file)
        .reverse()
        .find((x) => x.entry);
      if (last) return { seq: last.entry.seq, mac: last.entry.mac };
    }
    return null;
  }
  const anyEntries = () => months().some((m) => fs.statSync(m.file).size > 0);

  // Seal one entry after the tail and append it to its month's file.
  function append(fields, k, prev) {
    const t = now();
    const entry = seal(k.key, {
      seq: tail ? tail.seq + 1 : 1,
      ts: new Date(t).toISOString(),
      ...fields,
      ...(k.keyed === 'file' ? { keyed: 'file' } : {}),
      prev: prev || (tail ? tail.mac : GENESIS),
    });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, `governance-${monthOf(t)}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    tail = { seq: entry.seq, mac: entry.mac };
    return entry;
  }

  // record({ action, actor, ...fields }) -> the entry written, or null when it could not be (never throws). The
  // fields are written in the order action, actor, then the rest; outcome is 'ok' unless given.
  function record(input) {
    const { action, actor = { via: 'system' }, outcome = 'ok', ...rest } = input || {};
    const fields = { action: String(action || 'unknown'), actor, outcome, ...rest };
    try {
      if (tail === undefined) tail = readTail();
      const k = getKey({ create: true });
      if (k.created) restart = anyEntries() ? REKEYED : 'created';
      if (restart === 'created')
        append({ action: 'audit.key_created', actor: { via: 'system' }, outcome: 'ok', keyed: k.keyed }, k);
      if (restart === REKEYED)
        append(
          { action: 'audit.rekey', actor: { via: 'system' }, outcome: 'ok', reason: 'key missing', keyed: k.keyed },
          k,
          REKEYED,
        );
      restart = null;
      if (degraded) {
        append(
          {
            action: 'audit.gap',
            actor: { via: 'system' },
            outcome: 'error',
            missed: degraded.missed,
            since: new Date(degraded.since).toISOString(),
          },
          k,
        );
        degraded = null;
      }
      return append(fields, k);
    } catch {
      if (!degraded) degraded = { since: now(), missed: 0 };
      degraded.missed++;
      return null;
    }
  }

  // Every readable month, newest first, between two times; `skipped` counts lines that did not parse.
  function* newestFirst(from, to) {
    for (const m of months().reverse()) {
      if ((to != null && m.month > monthOf(to)) || (from != null && m.month < monthOf(from))) continue;
      for (const x of linesOf(m.file).reverse()) yield x;
    }
  }
  const inRange = (e, from, to) => {
    const t = Date.parse(e.ts);
    return (from == null || t >= from) && (to == null || t <= to);
  };
  const matches = (e, q) =>
    (!q.actor || (e.actor && (e.actor.via === q.actor || e.actor.keyId === q.actor))) &&
    (!q.outcome || e.outcome === q.outcome) &&
    (!q.action || `${e.action} ${e.op || ''}`.toLowerCase().includes(q.action.toLowerCase())) &&
    (q.before == null || e.seq < q.before);

  // list({ from, to, actor, action, outcome, limit, before }) -> { entries, next, skipped }: newest first, at most
  // `limit` (1-500); `next` is the `before` of the next page, or null.
  function list(q = {}) {
    const limit = Math.min(MAX_PAGE, Math.max(1, q.limit || 100));
    const entries = [];
    let skipped = 0;
    let more = false;
    for (const x of newestFirst(q.from, q.to)) {
      if (!x.entry) {
        skipped++;
        continue;
      }
      if (!inRange(x.entry, q.from, q.to) || !matches(x.entry, q)) continue;
      if (entries.length === limit) {
        more = true;
        break;
      }
      entries.push(x.entry);
    }
    return { entries, next: more ? entries[entries.length - 1].seq : null, skipped };
  }

  // export({ from, to, format }) -> { body, type, name }: JSON lines as written (so a copy can be verified), or CSV,
  // oldest first. More than 100,000 entries is a 413.
  function exportOf({ from = null, to = null, format = 'csv' } = {}) {
    const rows = [];
    for (const x of newestFirst(from, to)) {
      if (!x.entry || !inRange(x.entry, from, to)) continue;
      if (rows.length === MAX_EXPORT)
        throw Object.assign(new Error('too many entries; narrow the range'), { status: 413 });
      rows.push(x);
    }
    rows.reverse();
    const day = (t, d) => (t == null ? d : new Date(t).toISOString().slice(0, 10));
    const name = `zaafpulse-audit-${day(from, 'start')}-${day(to, 'now')}.${format}`;
    if (format === 'jsonl')
      return { body: rows.map((x) => `${x.line}\n`).join(''), type: 'application/x-ndjson', name };
    return { body: toCsv(rows.map((x) => x.entry)), type: 'text/csv; charset=utf-8', name };
  }

  // verify() -> { ok, checked, from, to, brokenAt?, reason?, unverified?, rekeyedAt? }, kept as the last result
  // (with `at`) for status() and the Monitors rule.
  function verify() {
    const items = [];
    for (const m of months()) for (const x of linesOf(m.file)) items.push(x.entry);
    const k = getKey({ create: false });
    let r;
    if (!k)
      r = items.length
        ? { ok: false, checked: 0, from: null, to: null, brokenAt: null, reason: 'key missing' }
        : { ok: true, checked: 0, from: null, to: null };
    else {
      r = verifyChain(items, k.key);
      // Lines cut from the end leave a chain that holds together: the last entry this server wrote says otherwise.
      if (r.ok && tail && (r.to === null || r.to < tail.seq))
        r = { ...r, ok: false, brokenAt: r.to === null ? tail.seq : r.to + 1, reason: 'sequence broken' };
    }
    lastVerify = { ...r, at: new Date(now()).toISOString() };
    return r;
  }

  // status() -> { months: [{ month, bytes }] newest first, bytes, degraded, lastVerify }. Reads no key.
  function status() {
    let list = [];
    try {
      list = months()
        .reverse()
        .map((m) => ({ month: m.month, bytes: fs.statSync(m.file).size }));
    } catch {
      /* unreadable folder: degraded says why soon enough */
    }
    return {
      months: list,
      bytes: list.reduce((a, m) => a + m.bytes, 0),
      degraded: degraded ? { since: new Date(degraded.since).toISOString(), missed: degraded.missed } : null,
      lastVerify,
    };
  }

  // Deletes the whole months that ended more than `retentionMonths` months ago (the current month and the ones before
  // it within the retention stay), then records which went. Returns the deleted months.
  function prune(retentionMonths) {
    const keep = monthsBefore(monthOf(now()), cleanRetention(retentionMonths));
    const gone = [];
    try {
      for (const m of months())
        if (m.month < keep) {
          fs.rmSync(m.file, { force: true });
          gone.push(m.month);
        }
    } catch {
      /* what could not go stays until the next pass */
    }
    if (gone.length)
      record({
        action: 'audit.prune',
        actor: { via: 'system' },
        months: gone,
        retentionMonths: cleanRetention(retentionMonths),
      });
    return gone;
  }

  // Records the CLI's events (queueEvent), oldest first; a file is removed once its entry is written.
  function importPending() {
    const pending = path.join(dir, 'pending');
    let names = [];
    try {
      names = fs.readdirSync(pending).filter((n) => /^\d{1,15}-[0-9a-f]{8}\.json$/.test(n));
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names.sort().slice(0, MAX_PENDING)) {
      const file = path.join(pending, name);
      let ev = null;
      try {
        if (fs.statSync(file).size <= 1024) ev = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        /* unreadable: removed below */
      }
      if (ev && CLI_ACTIONS.has(ev.action) && Number.isFinite(ev.ts)) {
        const e = record({ action: ev.action, actor: { via: 'cli' }, occurredAt: new Date(ev.ts).toISOString() });
        if (!e) break; // degraded: the rest waits for the next pass
        n++;
      }
      fs.rmSync(file, { force: true });
    }
    return n;
  }

  return { record, list, export: exportOf, verify, status, prune, importPending };
}

// The CSV of an export: one line per entry, the changes as "path: from → to" joined with "; ".
const CSV_COLUMNS = [
  'seq',
  'time',
  'actor',
  'actor_id',
  'ip',
  'action',
  'op',
  'target_type',
  'target_id',
  'target_name',
  'outcome',
  'status',
  'changes',
  'prev',
  'mac',
];
function toCsv(entries) {
  const line = (cells) => `${cells.map((c) => csvCell(c)).join(',')}\r\n`;
  const show = (v) => (v === null || v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v));
  let out = line(CSV_COLUMNS);
  for (const e of entries) {
    const a = e.actor || {};
    const t = e.target || {};
    out += line([
      e.seq,
      e.ts,
      a.via,
      a.keyId || a.rule || a.device || '',
      a.ip || '',
      e.action,
      e.op || '',
      t.type || '',
      t.id || '',
      t.name || '',
      e.outcome || '',
      e.status ?? '',
      (e.changes || []).map((c) => `${c.path}: ${show(c.from)} → ${show(c.to)}`).join('; '),
      e.prev,
      e.mac,
    ]);
  }
  return out;
}

module.exports = {
  createGovernanceAudit,
  keySource,
  queueEvent,
  cleanRetention,
  monthOf,
  monthsBefore,
  RETENTION,
  SERVICE,
  CSV_COLUMNS,
};
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test test/governance-audit.test.js test/governance-chain.test.js`
Expected: PASS (17 tests).

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check lib/governance/audit.js test/governance-audit.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add lib/governance/audit.js test/governance-audit.test.js
git commit -m "Governance audit: the store"
```

---
### Task 3: the actor, and one entry for each dashboard change

**Files:**
- Create: `lib/governance/context.js`, `lib/governance/events.js`
- Modify: `lib/auth.js` (`knownDevice` at 244–247, the return at 454)
- Modify: `server.js` (requires at 76–77, after `demoReady` at 241–242, `send` at 1035–1037, `readBody` at 1059–1071,
  the sign-in check at 1176–1180, `traced` at 1664)
- Modify: `lib/gateway/index.js` (requires at 43, the end of `authed()` at 518–525)
- Modify: `test/helpers.js` (`NO_JUDGE_PORTS` at 68–76)
- Test: `test/governance-events.test.js` (create), `test/governance-http.test.js` (create; later tasks append to it)

**Interfaces:**
- Consumes: Task 2's `createGovernanceAudit`, `keySource`.
- Produces (`lib/governance/context.js`): `runAs(actor | null, fn) → fn's result` (a fresh slot); `setActor(actor)`
  (fills the current slot; nothing outside `runAs`); `actor() → actor | null`.
- Produces (`lib/governance/events.js`): `requestEntry({ method, path, status, body: string?, reply? }) → entry |
  null` (V3; null for a read); `controlEntry(line) → entry | null` (an `agent-audit.jsonl` line, used in Task 5);
  `routeOf(path) → { route, ids }`; `outcomeOf(status)`; `READ_ONLY`.
- Produces (`lib/auth.js`): `auth.actorOf(req) → { via: 'dashboard', mode, device, ip }`.
- Produces (`server.js`): `governance` (the store), `govRecord(entry)` (adds the actor: the entry's, else
  `govContext.actor()`, else `{ via: 'system' }`), `govDir`; later tasks use all three.
- Produces (`test/governance-http.test.js`): `startServer(t, env = {}, prepare = null) → { base, data, alive }`,
  `call(s, path, { method, body, headers }) → { status, body, headers }`, `entries(s) → entry[]` (every month file,
  oldest first), `LOCAL` (the no-sign-in dashboard actor), `fakeServer`, `queueEvent` in scope for later tasks.

- [ ] **Step 1: Write the failing tests**

Create `test/governance-events.test.js`:

```js
// Governance audit log (AI Governance 2): the actor that travels with a request (lib/governance/context.js), what a
// dashboard request and an agent or runtime control line become as entries (lib/governance/events.js), and the
// gateway's key check setting the actor for everything its request starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { runAs, setActor, actor } = require('../lib/governance/context');
const { requestEntry, controlEntry, routeOf } = require('../lib/governance/events');
const { createGateway } = require('../lib/gateway');
const { secretsFor } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('context: each runAs has its own actor, kept across awaits and timers; nothing outside it', async () => {
  setActor({ via: 'cli' }); // outside any request: ignored
  assert.equal(actor(), null);
  const one = runAs(null, async () => {
    setActor({ via: 'apikey', keyId: 'key_a' });
    await sleep(20);
    return actor();
  });
  const two = runAs({ via: 'system' }, async () => {
    await sleep(5);
    return new Promise((r) => setTimeout(() => r(actor()), 5));
  });
  assert.deepEqual(await Promise.all([one, two]), [{ via: 'apikey', keyId: 'key_a' }, { via: 'system' }]);
  assert.equal(
    runAs(null, () => actor()),
    null,
  );
});

test('requests: method and route with ids as :id, the action word, the target, the outcome', () => {
  assert.deepEqual(routeOf('/api/datasets/my-set/examples/ex_7'), {
    route: '/api/datasets/:id/examples/:id',
    ids: ['my-set', 'ex_7'],
  });
  assert.deepEqual(routeOf('/api/monitors/channels'), { route: '/api/monitors/channels', ids: [] });
  assert.deepEqual(
    requestEntry({
      method: 'POST',
      path: '/api/gateway/keys',
      status: 200,
      body: JSON.stringify({ action: 'create', name: 'ci pipeline', scopes: ['llm'], secret: 'zp_never' }),
      reply: { key: { id: 'key_1' }, secret: 'zp_x' },
    }),
    {
      action: 'POST /api/gateway/keys',
      op: 'create',
      target: { type: 'gateway.keys', name: 'ci pipeline' },
      outcome: 'ok',
      status: 200,
    },
  );
  assert.deepEqual(
    requestEntry({ method: 'POST', path: '/api/monitors/tool_loop', status: 200, body: '{"enabled":false}' }),
    { action: 'POST /api/monitors/:id', target: { type: 'monitors', id: 'tool_loop' }, outcome: 'ok', status: 200 },
  );
  // An admin answer of { errors } with 200 is a refusal; 4xx is refused, 5xx an error.
  const refused = requestEntry({
    method: 'POST',
    path: '/api/gateway/keys',
    status: 200,
    body: '{"action":"create"}',
    reply: { errors: ['name is required'] },
  });
  assert.equal(refused.outcome, 'refused');
  assert.equal(requestEntry({ method: 'POST', path: '/api/config', status: 415, body: '' }).outcome, 'refused');
  assert.equal(requestEntry({ method: 'DELETE', path: '/api/datasets/a', status: 500 }).outcome, 'error');
  // Only short words and ids from a body: a long or odd action, a path-like id and a long name are cut or left out.
  assert.deepEqual(
    requestEntry({
      method: 'POST',
      path: '/api/brain/sources',
      status: 200,
      body: JSON.stringify({ action: 'Save Now', id: '../etc/passwd', name: 'n'.repeat(200), token: 't' }),
    }),
    {
      action: 'POST /api/brain/sources',
      target: { type: 'brain', name: 'n'.repeat(80) },
      outcome: 'ok',
      status: 200,
    },
  );
  assert.equal(requestEntry({ method: 'POST', path: '/api/config', status: 200, body: '{not json' }).op, undefined);
});

test('requests: reads sent as POST are not entries', () => {
  const read = (path, body) => requestEntry({ method: 'POST', path, status: 200, body: JSON.stringify(body) });
  assert.equal(read('/api/gateway/collab', { action: 'get', id: 'run_1' }), null);
  assert.equal(read('/api/gateway/collab', { action: 'list' }), null);
  assert.equal(read('/api/gateway/providers', { action: 'test', id: 'p' }), null);
  assert.equal(read('/api/gateway/logs', {}), null);
  assert.equal(read('/api/integrations/test-draft', { id: 'x' }), null);
  assert.equal(read('/api/cost/settings/preview', {}), null);
  assert.equal(read('/api/brain/sources', { action: 'test', id: 'obsidian' }), null);
  assert.equal(read('/api/gateway/collab', { action: 'cancel', id: 'run_1' }).op, 'cancel');
  assert.equal(read('/api/gateway/providers', { action: 'save', id: 'p' }).op, 'save');
});

test('control lines: agent and runtime actions, a rule as the actor of its own pause', () => {
  assert.deepEqual(
    controlEntry({
      ts: 1,
      action: 'pause',
      pid: 4242,
      startTime: 9,
      app: 'claude',
      by: 'rule',
      rule: 'tool_loop',
      ok: true,
    }),
    {
      action: 'agent.pause',
      actor: { via: 'rule', rule: 'tool_loop' },
      target: { type: 'agent', id: '4242', name: 'claude' },
      outcome: 'ok',
    },
  );
  assert.deepEqual(
    controlEntry({ ts: 1, kind: 'runtime', action: 'start', id: 'ollama', by: 'owner', ok: false, status: 409 }),
    { action: 'runtime.start', target: { type: 'runtime', id: 'ollama' }, outcome: 'refused', status: 409 },
  );
  assert.equal(controlEntry({ kind: 'runtime', action: 'stop', id: 'x', ok: false, status: 502 }).outcome, 'error');
  assert.equal(controlEntry({ action: 'Bad Action' }), null);
  assert.equal(controlEntry(null), null);
});

test('gateway: a request with an API key acts as that key; without one it acts as no one', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-ctx-'));
  const gateway = createGateway({
    dataDir,
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const seen = [];
  const server = http.createServer((req, res) =>
    runAs(null, async () => {
      if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
        res.writeHead(404);
        res.end();
      }
      seen.push(actor());
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    gateway.flush();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const made = gateway.keys.create({ name: 'ci', scopes: ['llm'] });
  const ok = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${made.secret}` } });
  assert.equal(ok.status, 200);
  await ok.text();
  const no = await fetch(`${base}/v1/models`);
  assert.equal(no.status, 401);
  await no.text();
  await sleep(10);
  assert.deepEqual(seen, [{ via: 'apikey', keyId: made.key.id }, null]);
});
```

Create `test/governance-http.test.js`:

```js
// Governance audit log (AI Governance 2) through a spawned server.js: a temp data folder, no network, no sign-in (or a
// password where sign-in is tested). The entries are read from the month files the server writes; each one is
// written before the answer it records. Ports 9600-9799 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS, fakeServer } = require('./helpers');
const { queueEvent } = require('../lib/governance/audit');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 9600 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

// Starts server.js on a free port of the range (again when another test took the port first); stopped and its data
// folder removed when the test ends. An answer counts only while the child is still running. prepare(data) runs on
// the empty data folder before the server starts.
async function startServer(t, env = {}, prepare = null) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-http-'));
    if (prepare) prepare(data);
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: 'none',
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
    const gone = new Promise((r) => child.on('exit', () => r((exited = true))));
    const stop = async () => {
      if (!exited) child.kill();
      await gone;
      fs.rmSync(data, { recursive: true, force: true });
    };
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await sleep(200);
        if (!exited) {
          t.after(stop);
          return { base, data, alive: () => !exited };
        }
      } catch {
        await sleep(150);
      }
    }
    await stop();
  }
  throw new Error('could not start server.js on a free port');
}
// One request: JSON in and out (text when the answer is not JSON).
async function call(s, p, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(s.base + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: json === null ? text : json, headers: r.headers };
}
// Every entry the server wrote, oldest first.
function entries(s) {
  const dir = path.join(s.data, '.data', 'audit');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^governance-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
const LOCAL = { via: 'dashboard', mode: 'none', device: null, ip: '127.0.0.1' };

test('dashboard changes: one entry each, with the dashboard actor and the outcome; reads are not entries', async (t) => {
  const s = await startServer(t);
  assert.equal((await call(s, '/api/config')).status, 200);
  assert.equal(
    (await call(s, '/api/gateway/collab', { method: 'POST', body: { action: 'get', id: 'run_0' } })).status,
    200,
  );
  assert.deepEqual(entries(s), [], 'reads write nothing (and make no key)');
  assert.equal((await call(s, '/api/config', { method: 'POST', body: { userName: 'Ana' } })).status, 200);
  const made = await call(s, '/api/gateway/keys', { method: 'POST', body: { action: 'create', name: 'ci' } });
  assert.match(made.body.secret, /^zp_/);
  const bad = await call(s, '/api/gateway/keys', { method: 'POST', body: { action: 'create' } });
  assert.deepEqual(bad.body.errors, ['name is required']);
  assert.equal((await call(s, '/api/monitors/tool_loop', { method: 'POST', body: { enabled: false } })).status, 200);
  assert.equal(
    (await call(s, '/api/config', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status,
    415,
  );
  const all = entries(s);
  const requests = all.filter((e) => /^(POST|PUT|PATCH|DELETE) /.test(e.action));
  assert.deepEqual(
    requests.map((e) => [e.action, e.op || null, e.target || null, e.outcome, e.status]),
    [
      ['POST /api/config', null, null, 'ok', 200],
      ['POST /api/gateway/keys', 'create', { type: 'gateway.keys', name: 'ci' }, 'ok', 200],
      ['POST /api/gateway/keys', 'create', null, 'refused', 200],
      ['POST /api/monitors/:id', null, { type: 'monitors', id: 'tool_loop' }, 'ok', 200],
      ['POST /api/config', null, null, 'refused', 415],
    ],
  );
  for (const e of requests) assert.deepEqual(e.actor, LOCAL);
  assert.equal(all[0].action, 'audit.key_created');
  assert.ok(!JSON.stringify(all).includes(made.body.secret), 'a key secret is never written');
  assert.ok(s.alive());
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/governance-events.test.js test/governance-http.test.js`
Expected: FAIL (`Cannot find module '../lib/governance/context'`; the spawned test finds no request entries).

- [ ] **Step 3: The actor slot and the request entries**

Create `lib/governance/context.js`:

```js
// Governance audit log (AI Governance 2): who is acting, carried with the request through AsyncLocalStorage, so the
// module routers and the gateway need no new parameter. server.js runs every request in runAs(null, …); the dashboard
// sign-in check and the gateway's key check then fill in the actor with setActor. Work started by that request
// (awaits, timers, a collaboration run) sees the same actor; anything else (scheduled passes) has none.
//   { via: 'dashboard', mode, device, ip }  { via: 'apikey', keyId }  { via: 'cli' }  { via: 'system' }
//   { via: 'rule', rule }
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Runs fn with its own actor slot (null until setActor fills it).
const runAs = (actor, fn) => als.run({ actor: actor || null }, fn);
// Sets the actor of the request this runs in; nothing outside runAs.
function setActor(actor) {
  const s = als.getStore();
  if (s) s.actor = actor;
}
// The actor of the request this runs in, or null.
function actor() {
  const s = als.getStore();
  return (s && s.actor) || null;
}

module.exports = { runAs, setActor, actor };
```

Create `lib/governance/events.js`:

```js
// Governance audit log (AI Governance 2): what a dashboard request and an agent or runtime control line become as audit
// entries (spec A4), pure. Of a request body only the short fields named here are kept: the action word (action or
// op) and the target's id and name. Reads that travel as POST are not entries.
const WORD = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_PATH = 120;

// Routes with ids in their path: the action names the route with each id as :id.
const ID_ROUTES = [
  [/^\/api\/monitors\/(?!channels$|test$|status$)([a-z_]{1,40})$/, '/api/monitors/:id'],
  [/^\/api\/datasets\/(?!settings$|import$)([^/]+)$/, '/api/datasets/:id'],
  [/^\/api\/datasets\/([^/]+)\/examples$/, '/api/datasets/:id/examples'],
  [/^\/api\/datasets\/([^/]+)\/examples\/([^/]+)$/, '/api/datasets/:id/examples/:id'],
  [/^\/api\/experiments\/([^/]+)\/cancel$/, '/api/experiments/:id/cancel'],
];
// Reads sent as POST: polling a run (every 1.2 s while it works), testing a connection, previews. They change
// nothing, so they are not entries.
const READ_ONLY = new Set([
  'POST /api/gateway/logs',
  'POST /api/gateway/quota',
  'POST /api/gateway/providers test',
  'POST /api/gateway/providers models',
  'POST /api/gateway/knowledge get',
  'POST /api/gateway/knowledge search',
  'POST /api/gateway/collab get',
  'POST /api/gateway/collab list',
  'POST /api/gateway/sessions get',
  'POST /api/integrations/test',
  'POST /api/integrations/test-draft',
  'POST /api/evals/preview',
  'POST /api/cost/settings/preview',
  'POST /api/cost/restate/preview',
  'POST /api/brain/sources test',
]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const outcomeOf = (status) => (status < 400 ? 'ok' : status < 500 ? 'refused' : 'error');

// '/api/datasets/abc/examples/7' -> { route: '/api/datasets/:id/examples/:id', ids: ['abc', '7'] }
function routeOf(p) {
  const path = String(p || '').slice(0, MAX_PATH);
  for (const [re, route] of ID_ROUTES) {
    const m = path.match(re);
    if (m) return { route, ids: m.slice(1).map((x) => x.slice(0, 80)) };
  }
  return { route: path, ids: [] };
}

// requestEntry({ method, path, status, body, reply }) -> the entry of one dashboard request, or null for a read.
// body is the request's text (as read), reply the answer sent: an admin answer of { errors } with 200 is a refusal.
function requestEntry({ method, path, status, body, reply }) {
  const { route, ids } = routeOf(path);
  let b = null;
  try {
    b = typeof body === 'string' && body ? JSON.parse(body) : null;
  } catch {
    b = null;
  }
  if (!isObj(b)) b = {};
  const op = [b.action, b.op].find((v) => typeof v === 'string' && WORD.test(v)) || null;
  if (READ_ONLY.has(`${method} ${route}`) || (op && READ_ONLY.has(`${method} ${route} ${op}`))) return null;
  const id = ids[0] || (typeof b.id === 'string' && ID.test(b.id) ? b.id : null);
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : null;
  const seg = route.split('/');
  const type = seg[2] === 'gateway' && seg[3] ? `gateway.${seg[3]}` : seg[2] || 'api';
  const refused = status < 400 && isObj(reply) && Array.isArray(reply.errors) && reply.errors.length > 0;
  return {
    action: `${method} ${route}`,
    ...(op ? { op } : {}),
    ...(id || name ? { target: { type, ...(id ? { id } : {}), ...(name ? { name } : {}) } } : {}),
    outcome: refused ? 'refused' : outcomeOf(status),
    status,
  };
}

// controlEntry(line) -> the entry of one agent-audit.jsonl line (lib/agents/control.js, lib/runtimes/control.js), or
// null. A rule's own pause names the rule as its actor; the rest take the request's actor.
function controlEntry(e) {
  if (!isObj(e) || typeof e.action !== 'string' || !WORD.test(e.action)) return null;
  const runtime = e.kind === 'runtime';
  const id = runtime
    ? typeof e.id === 'string' && e.id
      ? e.id.slice(0, 40)
      : null
    : Number.isInteger(e.pid)
      ? String(e.pid)
      : null;
  const name = !runtime && typeof e.app === 'string' && e.app ? e.app.slice(0, 40) : null;
  const status = Number.isInteger(e.status) ? e.status : null;
  return {
    action: `${runtime ? 'runtime' : 'agent'}.${e.action}`,
    ...(e.by === 'rule' && typeof e.rule === 'string' ? { actor: { via: 'rule', rule: e.rule.slice(0, 40) } } : {}),
    ...(id || name
      ? { target: { type: runtime ? 'runtime' : 'agent', ...(id ? { id } : {}), ...(name ? { name } : {}) } }
      : {}),
    outcome: e.ok === false ? (status && status >= 500 ? 'error' : 'refused') : 'ok',
    ...(status ? { status } : {}),
  };
}

module.exports = { requestEntry, controlEntry, routeOf, outcomeOf, READ_ONLY };
```

- [ ] **Step 4: Wire them in `lib/auth.js`, `server.js`, the gateway and the test helper**

In `lib/auth.js`, replace

```js
  const knownDevice = (v) => {
    const p = verify('known', v, 2);
    return p && Number(p[1]) >= now() ? p[0] : null;
  };
```

with

```js
  const knownDevice = (v) => {
    const p = verify('known', v, 2);
    return p && Number(p[1]) >= now() ? p[0] : null;
  };
  // Who a dashboard request comes from, for the governance audit log (lib/governance/context.js): the sign-in mode, the
  // browser's known-device id in password mode (null otherwise) and the address as the lockouts count it.
  const actorOf = (req) => ({
    via: 'dashboard',
    mode,
    device: mode === 'password' ? knownDevice(cookieOf(req, KNOWN_COOKIE)) : null,
    ip: clientKey(req, trustProxy),
  });
```

In `lib/auth.js`, replace

```js
  return { mode, required: mode !== 'none', check, handle, configured: () => mode !== 'password' || !!record() };
```

with

```js
  return {
    mode,
    required: mode !== 'none',
    check,
    handle,
    actorOf,
    configured: () => mode !== 'password' || !!record(),
  };
```

In `server.js`, replace

```js
const { createRecorder } = require('./lib/trace/recorder');
const { createReceiver } = require('./lib/trace/otlp');
```

with

```js
const { createRecorder } = require('./lib/trace/recorder');
const { createReceiver } = require('./lib/trace/otlp');
const govContext = require('./lib/governance/context');
const { requestEntry } = require('./lib/governance/events');
const { createGovernanceAudit, keySource } = require('./lib/governance/audit');
```

In `server.js`, replace

```js
const demoGw = DEMO ? require('./lib/demo-gateway') : null;
let demoReady = !DEMO;
```

with

```js
const demoGw = DEMO ? require('./lib/demo-gateway') : null;
let demoReady = !DEMO;
// Governance audit log (AI Governance 2, lib/governance): every change a person or an API key makes, with its actor and
// outcome, in .data/audit (demo: the throwaway folder), chained with acc.audit-chain from the secret store (demo: a
// key file, so demo mode never touches the store).
const govDir = path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'audit');
const governance = createGovernanceAudit({
  dir: govDir,
  getKey: keySource({ dir: govDir, store: DEMO ? null : require('./lib/secret-store').defaultStore() }),
});
// An entry's actor: the one it names, else the request's (lib/governance/context.js), else the server's own.
function govRecord(entry) {
  return governance.record({ ...entry, actor: entry.actor || govContext.actor() || { via: 'system' } });
}
```

In `server.js`, replace

```js
// `headers` may add a download's Content-Disposition only (lib/response-headers.js).
function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, responseHeaders(type, headers, SECURITY_HEADERS));
```

with

```js
// Dashboard changes waiting for their answer (A4(1)): the entry is written right before the answer, so whoever reads
// the log after the answer finds it. The request's body comes from readBody; only its short fields are kept.
const pendingAudit = new WeakMap();
// `headers` may add a download's Content-Disposition only (lib/response-headers.js).
function send(res, status, body, type = 'application/json', headers = {}) {
  const p = pendingAudit.get(res);
  if (p) {
    pendingAudit.delete(res);
    const e = requestEntry({ method: p.req.method, path: p.path, status, body: bodies.get(p.req), reply: body });
    if (e) govRecord(e);
  }
  res.writeHead(status, responseHeaders(type, headers, SECURITY_HEADERS));
```

In `server.js`, replace

```js
function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > max) {
        req.destroy();
        reject(new Error('too large'));
      }
    });
    req.on('end', () => resolve(data));
  });
}
```

with

```js
// The text each request sent, as read, for the audit entry of a dashboard change (send() keeps its short fields only).
const bodies = new WeakMap();
function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > max) {
        req.destroy();
        reject(new Error('too large'));
      }
    });
    req.on('end', () => {
      bodies.set(req, data);
      resolve(data);
    });
  });
}
```

In `server.js`, replace

```js
    if (!auth.check(req) && !['/login.html', '/login.js'].includes(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'sign in first' });
      res.writeHead(302, { location: '/login.html', ...SECURITY_HEADERS });
      return res.end();
    }
```

with

```js
    const signedIn = auth.check(req);
    if (!signedIn && !['/login.html', '/login.js'].includes(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'sign in first' });
      res.writeHead(302, { location: '/login.html', ...SECURITY_HEADERS });
      return res.end();
    }
    if (signedIn) {
      // The governance audit log: who this request acts as, and one entry for each change it makes (A4(1)).
      govContext.setActor(auth.actorOf(req));
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && url.pathname.startsWith('/api/'))
        pendingAudit.set(res, { req, path: url.pathname });
    }
```

In `server.js`, replace

```js
const traced = otel.wrapHandler(handler); // continues an incoming traceparent on gateway requests
```

with

```js
// Each request runs with its own actor slot for the governance audit log (filled after sign-in or the key check);
// otel continues an incoming traceparent on gateway requests.
const traced = otel.wrapHandler((req, res) => govContext.runAs(null, () => handler(req, res)));
```

In `lib/gateway/index.js`, replace

```js
const G = require('./guardrails');
```

with

```js
const G = require('./guardrails');
const govContext = require('../governance/context');
```

In `lib/gateway/index.js`, replace

```js
    const wait = keys.rateLimit(a.key);
    if (wait)
      throw Object.assign(
        new HttpError(429, `rate limit of ${a.key.rpm} requests per minute reached`, 'rate_limit_error'),
        { retryAfter: wait },
      );
    return a.key;
  }
```

with

```js
    const wait = keys.rateLimit(a.key);
    if (wait)
      throw Object.assign(
        new HttpError(429, `rate limit of ${a.key.rpm} requests per minute reached`, 'rate_limit_error'),
        { retryAfter: wait },
      );
    // The governance audit log: this request, and whatever it starts, acts as this key (lib/governance/context.js).
    govContext.setActor({ via: 'apikey', keyId: a.key.id });
    return a.key;
  }
```

In `test/helpers.js`, replace

```js
// would also read the loaded models of this machine's Ollama every 30 s (lib/runtimes/models.js): off too.
const NO_CLAUDE = path.join(__dirname, 'fixtures', 'no-claude-here', 'claude');
const NO_JUDGE_PORTS = {
  ZAAFPULSE_OLLAMA_URL: 'http://127.0.0.1:9',
  ZAAFPULSE_LMSTUDIO_URL: 'http://127.0.0.1:9',
  ZAAFPULSE_CLAUDE_BIN: NO_CLAUDE,
  ZAAFPULSE_NOTIFY: 'off',
  ZAAFPULSE_RUNTIME_WATCH: 'off',
};
```

with

```js
// would also read the loaded models of this machine's Ollama every 30 s (lib/runtimes/models.js): off too.
// Its first change makes the governance audit key (lib/governance/audit.js), which goes to the secret store: here an
// encrypted file in the test's data folder, never this machine's Keychain or keyring (and no DPAPI on Windows).
const NO_CLAUDE = path.join(__dirname, 'fixtures', 'no-claude-here', 'claude');
const NO_JUDGE_PORTS = {
  ZAAFPULSE_OLLAMA_URL: 'http://127.0.0.1:9',
  ZAAFPULSE_LMSTUDIO_URL: 'http://127.0.0.1:9',
  ZAAFPULSE_CLAUDE_BIN: NO_CLAUDE,
  ZAAFPULSE_NOTIFY: 'off',
  ZAAFPULSE_RUNTIME_WATCH: 'off',
  ZAAFPULSE_SECRET_STORE: 'file',
  ZAAFPULSE_MASTER_KEY: 'a-master-key-for-the-tests-only',
};
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/governance-events.test.js test/governance-http.test.js test/signin.test.js test/security.test.js`
Expected: PASS (the 6 new tests; the sign-in and security suites unchanged).

- [ ] **Step 6: Check the style**

Run: `npx prettier@3 --check lib/governance/context.js lib/governance/events.js lib/auth.js test/helpers.js test/governance-events.test.js test/governance-http.test.js`
Expected: `All matched files use Prettier code style!`
Run: `for f in server.js lib/gateway/index.js; do npx prettier@3 --stdin-filepath $f < $f | diff $f - | grep -c '^[<>]'; done`
Expected: `7` and `22`.

- [ ] **Step 7: Commit**

```bash
git add lib/governance/context.js lib/governance/events.js lib/auth.js server.js lib/gateway/index.js test/helpers.js test/governance-events.test.js test/governance-http.test.js
git commit -m "Governance audit: the actor and an entry for each dashboard change"
```

---
### Task 4: `config.change` from both config writers

**Files:**
- Modify: `lib/integration-config.js` (`createIntegrationConfig` at 428–429, `save`/`remove` at 458–468)
- Modify: `server.js` (requires at 80, `integrationConfig` at 236, after `govRecord` at 257–259, `saveConfigSections`
  at 304–307 and 333–336)
- Test: `test/governance-config.test.js` (create), `test/governance-http.test.js` (append)

**Interfaces:**
- Consumes: Task 1's `diff`; Task 3's `govRecord`.
- Produces: `createIntegrationConfig({ …, onChange(before, after) })`; `configChanged(before, after)` in `server.js`
  (one `config.change` entry with `target: { type: 'config', id: sections }`, `changes`, `truncated?`; none when
  nothing changed).

- [ ] **Step 1: Write the failing tests**

Create `test/governance-config.test.js`:

```js
// Governance audit log (AI Governance 2): the integration settings writer (lib/integration-config.js) reports each
// config.json write as (before, after), so server.js can record its config.change entry; a refused change reports
// nothing, and a listener that throws never undoes a save.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIntegrationConfig } = require('../lib/integration-config');
const { diff, MASK } = require('../lib/governance/diff');

const fakeSecrets = { resolve: () => null, mask: (s) => s };
function setup(t, onChange) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-ic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ userName: 'Ana', integrations: {} }));
  return { file, ic: createIntegrationConfig({ file, secrets: fakeSecrets, store: () => {}, onChange }) };
}

test('integration settings: a save and a delete report what config.json held before and after', (t) => {
  const seen = [];
  const { file, ic } = setup(t, (before, after) => seen.push({ before, after }));
  const form = {
    id: 'n8n-prod',
    type: 'n8n',
    values: { baseUrl: 'http://127.0.0.1:9', apiKey: { mode: 'store', value: 's3cret-value' } },
  };
  assert.equal(ic.save(form).id, 'n8n-prod');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].before, { userName: 'Ana', integrations: {} });
  assert.deepEqual(seen[0].after, JSON.parse(fs.readFileSync(file, 'utf8')));
  const changes = diff(seen[0].before, seen[0].after).changes;
  assert.ok(changes.some((c) => c.path === 'integrations.n8n-prod.baseUrl' && c.to === 'http://127.0.0.1:9'));
  assert.deepEqual(
    changes.find((c) => c.path === 'integrations.n8n-prod.apiKey'),
    { path: 'integrations.n8n-prod.apiKey', from: null, to: MASK },
  );
  assert.ok(!JSON.stringify(changes).includes('s3cret-value'));
  assert.deepEqual(ic.remove('n8n-prod'), { id: 'n8n-prod' });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].before.integrations['n8n-prod'], 'the delete reports the entry it removed');
  assert.deepEqual(seen[1].after, { userName: 'Ana', integrations: {} });
  // Refused: nothing written, nothing reported.
  assert.ok(ic.save({ id: 'Bad Id', type: 'router', values: {} }).errors);
  assert.ok(ic.remove('nope').errors);
  assert.equal(seen.length, 2);
});

test('integration settings: a listener that throws never undoes the save', (t) => {
  const { file, ic } = setup(t, () => {
    throw new Error('listener down');
  });
  assert.equal(ic.save({ id: 'r1', type: 'router', values: { baseUrl: 'http://127.0.0.1:9' } }).id, 'r1');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).integrations.r1);
});
```

Append to `test/governance-http.test.js`:

```js
test('config changes: both writers leave a config.change entry with the fields, secrets masked', async (t) => {
  const s = await startServer(t);
  assert.equal((await call(s, '/api/config', { method: 'POST', body: { userName: 'Ana' } })).status, 200);
  const guard = { guardrails: { secrets: 'block' } };
  assert.equal((await call(s, '/api/gateway/settings', { method: 'POST', body: guard })).status, 200);
  const integration = { id: 'r1', type: 'router', values: { baseUrl: 'http://127.0.0.1:9', flavor: '9router' } };
  assert.equal((await call(s, '/api/integrations/save', { method: 'POST', body: integration })).status, 200);
  assert.equal((await call(s, '/api/integrations/delete', { method: 'POST', body: { id: 'r1' } })).status, 200);
  const all = entries(s).filter((e) => e.action !== 'audit.key_created');
  assert.deepEqual(
    all.map((e) => e.action),
    [
      'config.change',
      'POST /api/config',
      'config.change',
      'POST /api/gateway/settings',
      'config.change',
      'POST /api/integrations/save',
      'config.change',
      'POST /api/integrations/delete',
    ],
  );
  const [cfg, , gw, , saved, , gone] = all;
  assert.deepEqual(cfg.target, { type: 'config', id: 'monthlyBudgetUSD,userName,vaultPaths' });
  assert.deepEqual(
    cfg.changes.find((c) => c.path === 'userName'),
    { path: 'userName', from: null, to: 'Ana' },
  );
  assert.ok(gw.changes.some((c) => c.path === 'gateway.guardrails.secrets' && c.to === 'block'));
  assert.ok(saved.changes.some((c) => c.path === 'integrations.r1.baseUrl' && c.to === 'http://127.0.0.1:9'));
  assert.ok(gone.changes.some((c) => c.path === 'integrations.r1.baseUrl' && c.from === 'http://127.0.0.1:9'));
  assert.deepEqual(all[5].target, { type: 'integrations', id: 'r1' });
  for (const e of all) assert.deepEqual(e.actor, LOCAL);
  assert.ok(s.alive());
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/governance-config.test.js test/governance-http.test.js`
Expected: FAIL (2 of 4: the integration writer reports nothing; the spawned server writes no `config.change`).

- [ ] **Step 3: The writers report their writes**

In `lib/integration-config.js`, replace

```js
function createIntegrationConfig({ file, secrets, store = keychainStore, connectors = DEFAULT_CONNECTORS }) {
  return {
```

with

```js
// onChange(before, after) hears of every write (the governance audit log's config.change, server.js); a listener that
// throws never undoes the save.
function createIntegrationConfig({
  file,
  secrets,
  store = keychainStore,
  connectors = DEFAULT_CONNECTORS,
  onChange = null,
}) {
  const changed = (before, after) => {
    if (typeof onChange !== 'function') return;
    try {
      onChange(before, after);
    } catch {
      /* the save stands */
    }
  };
  return {
```

In `lib/integration-config.js`, replace

```js
      if (!originalId) next[built.id] = built.entry;
      writeConfig(file, { ...cfg, integrations: next });
      return { id: built.id, entry: built.entry };
    },
    remove(id) {
      const cfg = readForChange(file);
      if (!cfg.integrations || !cfg.integrations[id]) return { errors: [`no integration called "${id}"`] };
      delete cfg.integrations[id];
      writeConfig(file, cfg);
      return { id };
    },
```

with

```js
      if (!originalId) next[built.id] = built.entry;
      const after = { ...cfg, integrations: next };
      writeConfig(file, after);
      changed(cfg, after);
      return { id: built.id, entry: built.entry };
    },
    remove(id) {
      const cfg = readForChange(file);
      if (!cfg.integrations || !cfg.integrations[id]) return { errors: [`no integration called "${id}"`] };
      const { [id]: gone, ...rest } = cfg.integrations;
      const after = { ...cfg, integrations: rest };
      writeConfig(file, after);
      changed(cfg, after);
      return { id };
    },
```

In `server.js`, replace

```js
const { createGovernanceAudit, keySource } = require('./lib/governance/audit');
```

with

```js
const { createGovernanceAudit, keySource } = require('./lib/governance/audit');
const { diff: govDiff } = require('./lib/governance/diff');
```

In `server.js`, replace

```js
const integrationConfig = createIntegrationConfig({ file: CONFIG_FILE, secrets: createSecrets() });
```

with

```js
const integrationConfig = createIntegrationConfig({
  file: CONFIG_FILE,
  secrets: createSecrets(),
  onChange: (before, after) => configChanged(before, after),
});
```

In `server.js`, replace

```js
function govRecord(entry) {
  return governance.record({ ...entry, actor: entry.actor || govContext.actor() || { via: 'system' } });
}
```

with

```js
function govRecord(entry) {
  return governance.record({ ...entry, actor: entry.actor || govContext.actor() || { via: 'system' } });
}
// Every config.json write, from either writer (saveConfigSections below, lib/integration-config.js), is one
// config.change entry with its field-level changes, secrets masked (lib/governance/diff.js). A write that changed
// nothing is no entry.
function configChanged(before, after) {
  const d = govDiff(before, after);
  if (!d.changes.length) return;
  govRecord({
    action: 'config.change',
    target: { type: 'config', id: d.sections.join(',').slice(0, 80) },
    changes: d.changes,
    ...(d.truncated ? { truncated: d.truncated } : {}),
  });
}
```

In `server.js`, replace

```js
  if (DEMO) {
    rawCache.value = { ...rawCache.value, ...patch };
    return;
  }
```

with

```js
  if (DEMO) {
    const before = rawCache.value;
    rawCache.value = { ...rawCache.value, ...patch };
    configChanged(before, rawCache.value);
    return;
  }
```

In `server.js`, replace

```js
  } catch (e) {
    fs.rmSync(tmpFile, { force: true });
    throw refuse(CONFIG_UNSAVED, e);
  }
```

with

```js
  } catch (e) {
    fs.rmSync(tmpFile, { force: true });
    throw refuse(CONFIG_UNSAVED, e);
  }
  configChanged(base, raw);
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/governance-config.test.js test/governance-http.test.js test/integration-config.test.js`
Expected: PASS.

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check lib/integration-config.js test/governance-config.test.js test/governance-http.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath server.js < server.js | diff server.js - | grep -c '^[<>]'`
Expected: `7`.

- [ ] **Step 6: Commit**

```bash
git add lib/integration-config.js server.js test/governance-config.test.js test/governance-http.test.js
git commit -m "Governance audit: config.change from both config writers"
```

---
### Task 5: sign-in, keys, runs, reveal, agent and runtime control, and the MCP key id

**Files:**
- Modify: `lib/auth.js` (options at 170–173, after `actorOf` at 256–257, the wrong-password branch at 385–388, the
  session at 407–408, logout at 440–441, `/auth/local` at 455–456)
- Modify: `lib/gateway/index.js` (requires at 44, options at 86–88, `keys` at 96, `collab` at 424–427, `/v1/runs`
  resume at 1869–1874)
- Modify: `lib/gateway/a2a.js` (`createA2A` at 101, the refused approval at 280–285)
- Modify: `lib/integrations.js` (requires at 5–6, the audit line at 145–154)
- Modify: `server.js` (requires at 79, `createAuth` at 138, `createGateway` at 464–466, `agentControl` at 708,
  `runtimeControl` at 839–842, `trace.reveal` at 1371)
- Test: `test/governance-auth.test.js`, `test/governance-gateway.test.js` (create), `test/governance-http.test.js`
  (append)

**Interfaces:**
- Consumes: Task 1's `diff` (key updates); Task 3's `setActor`/`actor`, `controlEntry`, `govRecord`.
- Produces: `createAuth({ …, onEvent({ action, outcome, status, actor, seconds? }) })` (V9);
  `createGateway({ …, audit(entry) })` (V10); `createA2A({ …, audit })`; MCP audit lines with `keyId`.

- [ ] **Step 1: Write the failing tests**

Create `test/governance-auth.test.js`:

```js
// Governance audit log (AI Governance 2): the sign-in events lib/auth.js reports (onEvent), each with its actor. The
// failure that starts a lockout is one auth.lockout event; the refusals during the lockout are none. No password or
// cookie value is ever in an event.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createAuth, localLoginCode } = require('../lib/auth');

const PASSWORD = 'correct horse battery';
async function setup(t, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-auth-'));
  const events = [];
  const auth = createAuth({ dataDir, env, onEvent: (e) => events.push(e) });
  const server = http.createServer(async (req, res) => {
    if (!(await auth.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  return { events, base, post, dataDir, auth };
}

test('password sign-in: login, logout, failures and the one lockout event, each with the actor', async (t) => {
  const s = await setup(t, { ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD });
  const ok = await s.post('/api/login', { password: PASSWORD });
  assert.equal(ok.status, 200);
  const cookies = ok.headers.getSetCookie().map((c) => c.split(';')[0]);
  const known = cookies.find((c) => c.startsWith('zp_known='));
  assert.equal((await s.post('/api/logout', {}, { cookie: cookies.join('; ') })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await s.post('/api/login', { password: `wrong ${i}` })).status, 401);
  assert.equal((await s.post('/api/login', { password: 'wrong again' })).status, 429);
  assert.deepEqual(
    s.events.map((e) => [e.action, e.outcome, e.status]),
    [
      ['auth.login', 'ok', 200],
      ['auth.logout', 'ok', 200],
      ['auth.login_failed', 'refused', 401],
      ['auth.login_failed', 'refused', 401],
      ['auth.login_failed', 'refused', 401],
      ['auth.login_failed', 'refused', 401],
      ['auth.login_failed', 'refused', 401],
      ['auth.lockout', 'refused', 429],
    ],
  );
  const device = s.events[0].actor.device;
  assert.match(device, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(known.includes(device), 'the device is the id the known-device cookie carries');
  assert.deepEqual(s.events[1].actor, { via: 'dashboard', mode: 'password', device, ip: '127.0.0.1' });
  assert.deepEqual(s.events[2].actor, { via: 'dashboard', mode: 'password', device: null, ip: '127.0.0.1' });
  assert.equal(s.events[7].seconds, 30);
  const text = JSON.stringify(s.events);
  assert.ok(!text.includes('wrong') && !text.includes(PASSWORD) && !text.includes('zp_session'));
  // A logout that is not JSON is refused before anything happens: no event.
  const before = s.events.length;
  assert.equal((await fetch(`${s.base}/api/logout`, { method: 'POST', body: 'x' })).status, 415);
  assert.equal(s.events.length, before);
});

test('local sign-in: a code that works is an event; an expired or unknown one is not', async (t) => {
  const s = await setup(t, { ZAAFPULSE_AUTH: 'local' });
  const code = localLoginCode(s.dataDir);
  assert.equal((await fetch(`${s.base}/auth/local?code=${code}`, { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${s.base}/auth/local?code=${code}`, { redirect: 'manual' })).status, 302);
  assert.deepEqual(s.events, [
    {
      action: 'auth.local_code',
      outcome: 'ok',
      status: 200,
      actor: { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' },
    },
  ]);
  const req = { headers: { cookie: 'zp_known=x.y.z' }, socket: { remoteAddress: '::ffff:10.1.2.3' } };
  assert.deepEqual(s.auth.actorOf(req), { via: 'dashboard', mode: 'local', device: null, ip: '10.1.2.3' });
});
```

Create `test/governance-gateway.test.js`:

```js
// Governance audit log (AI Governance 2): what the gateway reports to it (createGateway({ audit })): key changes with
// the key's id and name, and approvals, rejections and cancels of collaboration runs from the dashboard, /v1/runs and
// A2A, each with the actor of its request; and the MCP audit line of a call made with a key names the key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const { createIntegrations } = require('../lib/integrations');
const { tool, S } = require('../lib/connectors/base');
const { runAs, actor } = require('../lib/governance/context');

const reply = (content) => ({
  body: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
});
const fake = {
  type: 'fake',
  create: () => ({
    tools: [tool('read', 'Read', { q: S.str('Query') }, async (a) => ({ got: a.q ?? null }), { required: [] })],
    health: async () => ({ ok: true, latencyMs: 1 }),
  }),
};

async function setup(t) {
  const upstream = await fakeServer({
    'POST /chat/completions': () => reply('done'),
    'GET /models': { body: { data: [{ id: 'm' }] } },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-gw-'));
  const mcpCalls = [];
  const registry = createIntegrations({
    config: { integrations: { one: { type: 'fake' } } },
    secrets: secretsFor(),
    connectors: { fake, acc: { type: 'acc', create: () => ({ tools: [], health: async () => ({ ok: true }) }) } },
    audit: { record: (e) => mcpCalls.push(e) },
  });
  const seen = []; // each entry with the actor of the request it was made in
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
    getIntegrations: () => registry,
    audit: (e) => seen.push({ ...e, by: actor() }),
  });
  const server = http.createServer((req, res) =>
    runAs(null, async () => {
      if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
        res.writeHead(404);
        res.end();
      }
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections?.();
    server.close();
    await upstream.close();
    gateway.flush();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, secret, body) => {
    const r = await fetch(base + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { gateway, seen, call, mcpCalls };
}
// A run waiting for approval at its second step, started with `secret`.
async function gatedRun(s, secret) {
  s.gateway.workflows.save({
    id: 'gated',
    name: 'Gated',
    steps: [
      { agent: 'hr-finance', prompt: 'Review {{input}}' },
      { agent: 'legal-compliance', prompt: 'Sign off {{step1}}', approve: true },
    ],
  });
  const r = await s.call('/v1/workflows/gated/run', secret, { input: 'laptop' });
  assert.equal(r.json.state, 'input-required');
  return r.json.id;
}

test('keys: create, update, revoke and delete are entries with the key id and name; an update lists its fields', async (t) => {
  const s = await setup(t);
  const made = await s.gateway.admin('keys', 'POST', { action: 'create', name: 'ci', scopes: ['llm'] });
  const id = made.key.id;
  await s.gateway.admin('keys', 'POST', { action: 'update', id, rpm: 120, guardrails: { secrets: 'block' } });
  await s.gateway.admin('keys', 'POST', { action: 'update', id, name: 'ci' }); // nothing changes
  await s.gateway.admin('keys', 'POST', { action: 'revoke', id });
  await s.gateway.admin('keys', 'POST', { action: 'delete', id });
  await s.gateway.admin('keys', 'POST', { action: 'delete', id }); // already gone: no entry
  await s.gateway.admin('keys', 'POST', { action: 'create' }); // refused by the key rules: no entry
  const target = { type: 'key', id, name: 'ci' };
  assert.deepEqual(
    s.seen.map(({ by, ...e }) => e),
    [
      { action: 'key.create', target },
      {
        action: 'key.update',
        target,
        changes: [
          { path: 'guardrails.secrets', from: null, to: 'block' },
          { path: 'rpm', from: 60, to: 120 },
        ],
      },
      { action: 'key.update', target },
      { action: 'key.revoke', target },
      { action: 'key.delete', target },
    ],
  );
  assert.ok(!JSON.stringify(s.seen).includes(made.secret), 'the secret is never in an entry');
});

test('runs: approvals, rejections and cancels name the key or the dashboard; a refused approval too', async (t) => {
  const s = await setup(t);
  const { key, secret } = s.gateway.keys.create({ name: 'app', scopes: ['agents', 'llm'] });
  const run1 = await gatedRun(s, secret);
  s.seen.length = 0;
  assert.equal((await s.call(`/v1/runs/${run1}/resume`, secret, { approve: true })).status, 403);
  assert.equal((await s.call(`/v1/runs/${run1}/resume`, secret, { approve: false })).json.state, 'rejected');
  assert.equal((await s.call(`/v1/runs/${run1}/cancel`, secret, {})).status, 409);
  const run2 = await gatedRun(s, secret);
  const a2a = await s.call('/a2a', secret, {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: { message: { taskId: run2, role: 'user', parts: [{ kind: 'text', text: 'approve' }] } },
  });
  assert.match(a2a.json.error.message, /approve this task in the ZAAFPulse dashboard/);
  await runAs({ via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' }, () =>
    s.gateway.admin('collab', 'POST', { action: 'resume', id: run2, approve: true }),
  );
  const run3 = await gatedRun(s, secret);
  await s.gateway.admin('collab', 'POST', { action: 'cancel', id: run3 });
  // A key allowed to approve its own runs (a pipeline with its own human approval) approves through the API.
  const own = s.gateway.keys.create({ name: 'pipeline', scopes: ['agents', 'llm'], approveOwnRuns: true });
  const run4 = await gatedRun(s, own.secret);
  assert.equal((await s.call(`/v1/runs/${run4}/resume`, own.secret, { approve: true })).status, 200);
  const byKey = { via: 'apikey', keyId: key.id };
  const dash = { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' };
  assert.deepEqual(
    s.seen.filter((e) => e.action.startsWith('run.')),
    [
      { action: 'run.approve', target: { type: 'run', id: run1 }, outcome: 'refused', status: 403, by: byKey },
      { action: 'run.reject', target: { type: 'run', id: run1 }, outcome: 'ok', by: byKey },
      { action: 'run.cancel', target: { type: 'run', id: run1 }, outcome: 'refused', status: 409, by: byKey },
      { action: 'run.approve', target: { type: 'run', id: run2 }, outcome: 'refused', status: 403, by: byKey },
      { action: 'run.approve', target: { type: 'run', id: run2 }, outcome: 'ok', by: dash },
      { action: 'run.cancel', target: { type: 'run', id: run3 }, outcome: 'ok', by: null },
      {
        action: 'run.approve',
        target: { type: 'run', id: run4 },
        outcome: 'ok',
        by: { via: 'apikey', keyId: own.key.id },
      },
    ],
  );
});

test('mcp: a tool call through /mcp with a key leaves an MCP audit line that names the key', async (t) => {
  const s = await setup(t);
  const { key, secret } = s.gateway.keys.create({ name: 'mcp', scopes: ['mcp'] });
  const r = await s.call('/mcp', secret, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'one_read', arguments: { q: 'x' } },
  });
  assert.equal(r.status, 200);
  assert.equal(s.mcpCalls.length, 1);
  assert.equal(s.mcpCalls[0].tool, 'one_read');
  assert.equal(s.mcpCalls[0].keyId, key.id);
  // The same registry used outside a key's request (the stdio MCP server, the dashboard) names none.
  const { createIntegrations: again } = require('../lib/integrations');
  const lines = [];
  const local = again({
    config: { integrations: { one: { type: 'fake' } } },
    secrets: secretsFor(),
    connectors: { fake, acc: { type: 'acc', create: () => ({ tools: [], health: async () => ({ ok: true }) }) } },
    audit: { record: (e) => lines.push(e) },
  });
  await local.callTool('one_read', { q: 'y' });
  assert.equal(lines[0].keyId, undefined);
});
```

Append to `test/governance-http.test.js`:

```js
test('keys, runs, reveal and control: the gateway key and the API key that acts are named', async (t) => {
  const upstream = await fakeServer({
    'POST /chat/completions': {
      body: {
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    },
    'GET /models': { body: { data: [{ id: 'm' }] } },
  });
  t.after(() => upstream.close());
  const s = await startServer(t);
  const admin = async (route, body) => (await call(s, `/api/gateway/${route}`, { method: 'POST', body })).body;
  await admin('providers', { action: 'save', id: 'fake', preset: 'custom', baseUrl: upstream.url, tier: 'private' });
  await admin('defaults', { model: 'fake/m', plannerModel: 'fake/m' });
  await admin('workflows', {
    action: 'save',
    id: 'gated',
    name: 'Gated',
    steps: [
      { agent: 'hr-finance', prompt: 'Review {{input}}' },
      { agent: 'legal-compliance', prompt: 'Sign off {{step1}}', approve: true },
    ],
  });
  const made = await admin('keys', { action: 'create', name: 'pipeline', scopes: ['agents', 'llm'] });
  const auth = { authorization: `Bearer ${made.secret}` };
  const run = await call(s, '/v1/workflows/gated/run', { method: 'POST', body: { input: 'x' }, headers: auth });
  assert.equal(run.body.state, 'input-required');
  const resume = (approve) =>
    call(s, `/v1/runs/${run.body.id}/resume`, { method: 'POST', body: { approve }, headers: auth });
  assert.equal((await resume(true)).status, 403);
  assert.equal((await resume(false)).body.state, 'rejected');
  assert.equal((await call(s, '/api/trace/reveal', { method: 'POST', body: { id: 'nope', index: 0 } })).status, 404);
  const start = await call(s, '/api/runtimes/start', { method: 'POST', body: { id: 'ollama' } });
  assert.equal(start.status, 403);
  const all = entries(s);
  const one = (action) => all.filter((e) => e.action === action);
  assert.deepEqual(one('key.create')[0].target, { type: 'key', id: made.key.id, name: 'pipeline' });
  assert.deepEqual(one('key.create')[0].actor, LOCAL);
  const byKey = { via: 'apikey', keyId: made.key.id };
  assert.deepEqual(
    [...one('run.approve'), ...one('run.reject')].map((e) => [e.action, e.outcome, e.actor]),
    [
      ['run.approve', 'refused', byKey],
      ['run.reject', 'ok', byKey],
    ],
  );
  assert.deepEqual(
    one('trace.reveal').map((e) => [e.target, e.outcome, e.status, e.actor]),
    [[{ type: 'content', id: 'nope' }, 'refused', 404, LOCAL]],
  );
  assert.deepEqual(
    one('runtime.start').map((e) => [e.target, e.outcome, e.status, e.actor]),
    [[{ type: 'runtime', id: 'ollama' }, 'refused', 403, LOCAL]],
  );
  assert.ok(fs.existsSync(path.join(s.data, '.data', 'agent-audit.jsonl')), 'the control log stays');
  assert.ok(!JSON.stringify(all).includes(made.secret));
  assert.ok(s.alive());
});

test('sign-in: login, a change, logout, five failures and one lockout, with the device and address', async (t) => {
  const s = await startServer(t, { ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: 'correct horse battery' });
  const ok = await call(s, '/api/login', { method: 'POST', body: { password: 'correct horse battery' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const headers = { cookie, origin: s.base };
  assert.equal((await call(s, '/api/config', { method: 'POST', body: { userName: 'Ana' }, headers })).status, 200);
  assert.equal((await call(s, '/api/logout', { method: 'POST', body: {}, headers })).status, 200);
  for (let i = 0; i < 5; i++)
    assert.equal((await call(s, '/api/login', { method: 'POST', body: { password: `nope ${i}` } })).status, 401);
  assert.equal((await call(s, '/api/login', { method: 'POST', body: { password: 'nope' } })).status, 429);
  const all = entries(s).filter((e) => e.action !== 'audit.key_created');
  assert.deepEqual(
    all.map((e) => e.action),
    [
      'auth.login',
      'config.change',
      'POST /api/config',
      'auth.logout',
      'auth.login_failed',
      'auth.login_failed',
      'auth.login_failed',
      'auth.login_failed',
      'auth.login_failed',
      'auth.lockout',
    ],
  );
  const device = all[0].actor.device;
  assert.ok(device);
  for (const e of all.slice(0, 4))
    assert.deepEqual(e.actor, { via: 'dashboard', mode: 'password', device, ip: '127.0.0.1' });
  assert.deepEqual(all[4].actor, { via: 'dashboard', mode: 'password', device: null, ip: '127.0.0.1' });
  assert.ok(!JSON.stringify(all).includes('nope') && !JSON.stringify(all).includes('horse'));
  assert.ok(s.alive());
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/governance-auth.test.js test/governance-gateway.test.js test/governance-http.test.js`
Expected: FAIL (the 5 tests of the two new files and the 2 appended ones).

- [ ] **Step 3: Report the events**

In `lib/auth.js`, replace

```js
  demo = false,
  headers = () => ({}),
}) {
  const dir = path.join(dataDir, '.data');
```

with

```js
  demo = false,
  headers = () => ({}),
  // Sign-in events for the governance audit log (server.js): { action, outcome, status, actor, … }.
  onEvent = () => {},
}) {
  const dir = path.join(dataDir, '.data');
```

In `lib/auth.js`, replace

```js
    ip: clientKey(req, trustProxy),
  });
```

with

```js
    ip: clientKey(req, trustProxy),
  });
  // One sign-in event; a listener that throws never changes the answer.
  const emit = (req, action, outcome, extra = {}, actor = actorOf(req)) => {
    try {
      onEvent({ action, outcome, ...extra, actor });
    } catch {
      /* the answer stands */
    }
  };
```

In `lib/auth.js`, replace

```js
      const { password } = await body(req);
      if (typeof password !== 'string' || !(await checkPassword(password, rec)))
        return json(res, 401, { error: 'wrong password' });
    } finally {
```

with

```js
      const { password } = await body(req);
      if (typeof password !== 'string' || !(await checkPassword(password, rec))) {
        emit(req, 'auth.login_failed', 'refused', { status: 401 });
        // The failure that starts a lockout is an entry of its own; the refusals during it are not (a flood of them
        // would bury everything else).
        const until = Math.max(0, ...limits.map(([k, free]) => lockedUntil(bucket(k), free)));
        if (until > now())
          emit(req, 'auth.lockout', 'refused', { status: 429, seconds: Math.ceil((until - now()) / 1000) });
        return json(res, 401, { error: 'wrong password' });
      }
    } finally {
```

In `lib/auth.js`, replace

```js
    const id = device || crypto.randomBytes(12).toString('base64url');
    return json(
```

with

```js
    const id = device || crypto.randomBytes(12).toString('base64url');
    emit(req, 'auth.login', 'ok', { status: 200 }, { ...actorOf(req), device: id });
    return json(
```

In `lib/auth.js`, replace

```js
      sessions.delete(cookieOf(req, COOKIE));
      json(
```

with

```js
      sessions.delete(cookieOf(req, COOKIE));
      emit(req, 'auth.logout', 'ok', { status: 200 });
      json(
```

In `lib/auth.js`, replace

```js
      // A page that moves on to the dashboard, not a redirect: the browser came here from a local file,
      // and a SameSite=Strict cookie is not sent on a redirect that another origin started.
```

with

```js
      emit(req, 'auth.local_code', 'ok', { status: 200 });
      // A page that moves on to the dashboard, not a redirect: the browser came here from a local file,
      // and a SameSite=Strict cookie is not sent on a redirect that another origin started.
```

In `lib/gateway/index.js`, replace

```js
const govContext = require('../governance/context');
```

with

```js
const govContext = require('../governance/context');
const { diff: govDiff } = require('../governance/diff');
```

In `lib/gateway/index.js`, replace

```js
  budgetGuard = null,
}) {
  const keyStore = jsonStore(path.join(dataDir, 'keys.json'), { keys: [] });
```

with

```js
  budgetGuard = null,
  // The governance audit log (server.js): (entry) -> void, for key changes and run approvals and cancels.
  audit = null,
}) {
  const keyStore = jsonStore(path.join(dataDir, 'keys.json'), { keys: [] });
```

In `lib/gateway/index.js`, replace

```js
  const keys = createKeys(keyStore, { now });
```

with

```js
  const keys = createKeys(keyStore, { now });
  // One governance entry; the actor (dashboard or a key) comes with the request. A listener that throws changes
  // nothing.
  const govAudit = (entry) => {
    if (typeof audit !== 'function') return;
    try {
      audit(entry);
    } catch {
      /* the change stands */
    }
  };
  // Key changes, whoever makes them (the keys page, a code tool's key, the skills key, a budget save): the key's id and
  // name, and for an update the fields that changed.
  {
    const keyEntry = (action, k, extra = {}) =>
      govAudit({ action: `key.${action}`, target: { type: 'key', id: k.id, name: k.name }, ...extra });
    const { create, update, revoke, remove } = keys;
    keys.create = (...args) => {
      const r = create(...args);
      if (r.key) keyEntry('create', r.key);
      return r;
    };
    keys.update = (id, input) => {
      const before = keys.list().find((k) => k.id === id);
      const r = update(id, input);
      if (r.key) {
        const d = govDiff(before, r.key);
        keyEntry('update', r.key, d.changes.length ? { changes: d.changes } : {});
      }
      return r;
    };
    keys.revoke = (id) => {
      const r = revoke(id);
      if (r.key) keyEntry('revoke', r.key);
      return r;
    };
    keys.remove = (id) => {
      const k = keys.list().find((x) => x.id === id);
      const r = remove(id);
      if (!r.errors && k) keyEntry('delete', k);
      return r;
    };
  }
```

In `lib/gateway/index.js`, replace

```js
    store: runStore,
    now,
  });
  const a2a = createA2A({ collab, sessions, agents, workflows, version });
```

with

```js
    store: runStore,
    now,
  });
  // Approvals, rejections and cancels of collaboration runs (the dashboard, /v1/runs and A2A all go through these).
  {
    const runEntry = (action, id, c) =>
      govAudit({
        action,
        target: { type: 'run', id: String(id).slice(0, 40) },
        outcome: c && c.error ? 'refused' : 'ok',
        ...(c && c.error ? { status: c.error === 'not-found' ? 404 : 409 } : {}),
      });
    const { cancel, resume } = collab;
    collab.cancel = (id, keyId) => {
      const c = cancel(id, keyId);
      runEntry('run.cancel', id, c);
      return c;
    };
    collab.resume = (id, decision = {}, ctx = {}) => {
      const c = resume(id, decision, ctx);
      runEntry(decision.approve === false ? 'run.reject' : 'run.approve', id, c);
      return c;
    };
  }
  const a2a = createA2A({ collab, sessions, agents, workflows, version, audit: govAudit });
```

In `lib/gateway/index.js`, replace

```js
          if (body.approve !== false && !key.approveOwnRuns)
            throw new HttpError(
              403,
              'approve this run in the ZAAFPulse dashboard (this key may reject, not approve)',
              'permission_error',
            );
```

with

```js
          if (body.approve !== false && !key.approveOwnRuns) {
            govAudit({ action: 'run.approve', target: { type: 'run', id: runM[1] }, outcome: 'refused', status: 403 });
            throw new HttpError(
              403,
              'approve this run in the ZAAFPulse dashboard (this key may reject, not approve)',
              'permission_error',
            );
          }
```

In `lib/gateway/a2a.js`, replace

```js
function createA2A({ collab, sessions, agents, workflows, version }) {
```

with

```js
// audit: the gateway's governance entry (an approval this key may not give is recorded as refused).
function createA2A({ collab, sessions, agents, workflows, version, audit = () => {} }) {
```

In `lib/gateway/a2a.js`, replace

```js
      if (approve && !key.approveOwnRuns)
        return rpcError(
          id,
          'unsupported',
          'approve this task in the ZAAFPulse dashboard; this key may reject it, not approve it',
        );
```

with

```js
      if (approve && !key.approveOwnRuns) {
        audit({ action: 'run.approve', target: { type: 'run', id: r.id }, outcome: 'refused', status: 403 });
        return rpcError(
          id,
          'unsupported',
          'approve this task in the ZAAFPulse dashboard; this key may reject it, not approve it',
        );
      }
```

In `lib/integrations.js`, replace

```js
    span.end(ok, result);
    if (audit)
      audit.record({
        ts: started,
        integration: t.entry.id,
        tool: name,
        ok,
        ms: now() - started,
        args: Object.keys(args || {}),
      });
```

with

```js
    span.end(ok, result);
    // A call made with an API key (the gateway's /mcp, or an agent run with a key) names the key (lib/governance).
    const who = govContext.actor();
    if (audit)
      audit.record({
        ts: started,
        integration: t.entry.id,
        tool: name,
        ok,
        ms: now() - started,
        args: Object.keys(args || {}),
        ...(who && who.via === 'apikey' ? { keyId: who.keyId } : {}),
      });
```

In `server.js`, replace

```js
const { requestEntry } = require('./lib/governance/events');
```

with

```js
const { requestEntry, controlEntry } = require('./lib/governance/events');
```

In `server.js`, replace

```js
  auth = createAuth({ dataDir: DIR, host: HOST, demo: DEMO, headers: () => SECURITY_HEADERS });
```

with

```js
  auth = createAuth({
    dataDir: DIR,
    host: HOST,
    demo: DEMO,
    headers: () => SECURITY_HEADERS,
    onEvent: (e) => govRecord(e), // sign-ins and sign-outs for the governance audit log
  });
```

In `server.js`, replace

```js
  trustProxy: process.env.ZAAFPULSE_TRUST_PROXY === '1',
  budgetGuard,
});
```

with

```js
  trustProxy: process.env.ZAAFPULSE_TRUST_PROXY === '1',
  budgetGuard,
  audit: (e) => govRecord(e), // key changes, run approvals and cancels
});
```

In `server.js`, replace

```js
const agentControl = createAgentControl({ dataDir: monitorDir, serverMode: AGENTS_OFF, log: (m) => console.error(m) });
```

with

```js
// Agent and runtime control keep their own log (agent-audit.jsonl); each line is also a governance entry (A4(5)).
function controlAudit(dir) {
  const log = createAudit(path.join(dir, 'agent-audit.jsonl'));
  return {
    record(line) {
      log.record(line);
      const e = controlEntry(line);
      if (e) govRecord(e);
    },
  };
}
const agentControl = createAgentControl({
  dataDir: monitorDir,
  serverMode: AGENTS_OFF,
  log: (m) => console.error(m),
  audit: controlAudit(monitorDir),
});
```

In `server.js`, replace

```js
const runtimeControl = createRuntimeControl({
  state: runtimeState,
  entries: runtimeEntries,
  dataDir: runtimeDir,
```

with

```js
const runtimeControl = createRuntimeControl({
  state: runtimeState,
  entries: runtimeEntries,
  dataDir: runtimeDir,
  audit: controlAudit(runtimeDir),
```

In `server.js`, replace

```js
        return send(res, 200, await trace.reveal(id, index, { offset }));
```

with

```js
        // A secret was shown (A4(6)): which content and which mask, never the value.
        const target = { type: 'content', id: String(id ?? '').slice(0, 80) };
        let shown;
        try {
          shown = await trace.reveal(id, index, { offset });
        } catch (err) {
          const st = err && err.status;
          govRecord({
            action: 'trace.reveal',
            target,
            outcome: Number.isInteger(st) && st < 500 ? 'refused' : 'error',
            ...(Number.isInteger(st) ? { status: st } : {}),
          });
          throw err;
        }
        govRecord({ action: 'trace.reveal', target, ...(index !== undefined ? { index } : {}) });
        return send(res, 200, shown);
```

In `lib/integrations.js`, replace

```js
const { RAW } = require('./connectors/base');
const otel = require('./otel');
```

with

```js
const { RAW } = require('./connectors/base');
const otel = require('./otel');
const govContext = require('./governance/context');
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/governance-auth.test.js test/governance-gateway.test.js test/governance-http.test.js test/signin.test.js test/collab.test.js test/integrations.test.js test/agents-control.test.js test/runtimes-control.test.js`
Expected: PASS.

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check lib/auth.js lib/gateway/a2a.js lib/integrations.js test/governance-auth.test.js test/governance-gateway.test.js test/governance-http.test.js`
Expected: `All matched files use Prettier code style!`
Run: `for f in server.js lib/gateway/index.js; do npx prettier@3 --stdin-filepath $f < $f | diff $f - | grep -c '^[<>]'; done`
Expected: `7` and `22`.

- [ ] **Step 6: Commit**

```bash
git add lib/auth.js lib/gateway/index.js lib/gateway/a2a.js lib/integrations.js server.js test/governance-auth.test.js test/governance-gateway.test.js test/governance-http.test.js
git commit -m "Governance audit: sign-in, keys, runs, reveal and control entries"
```

---
### Task 6: a GET on a writing gateway admin route is 405 (A7)

**Files:**
- Modify: `server.js` (the gateway admin dispatch at 1254–1255)
- Test: `test/governance-http.test.js` (append)

**Interfaces:**
- Consumes: Task 3's test helpers.
- Produces: V12.

- [ ] **Step 1: Write the failing test**

Append to `test/governance-http.test.js`:

```js
test('a GET on a gateway admin route that writes is 405 and changes nothing; the request log still reads', async (t) => {
  const s = await startServer(t);
  const set = await call(s, '/api/gateway/defaults', { method: 'POST', body: { model: 'a/b', plannerModel: 'a/c' } });
  assert.deepEqual(set.body.defaults, { model: 'a/b', plannerModel: 'a/c', codeModel: '' });
  const config = () => JSON.parse(fs.readFileSync(path.join(s.data, 'config.json'), 'utf8'));
  const before = config();
  for (const route of ['defaults', 'settings', 'playground', 'quota', 'keys', 'providers'])
    assert.equal((await call(s, `/api/gateway/${route}`)).status, 405, route);
  assert.deepEqual(config(), before);
  assert.deepEqual((await call(s, '/api/gateway')).body.defaults, { model: 'a/b', plannerModel: 'a/c', codeModel: '' });
  assert.ok(Array.isArray((await call(s, '/api/gateway/logs')).body.entries));
  const del = await call(s, '/api/gateway/defaults', { method: 'DELETE', body: {} });
  assert.equal(del.status, 405);
  assert.deepEqual(config(), before);
  assert.deepEqual(
    entries(s)
      .filter((e) => e.action.includes('/api/gateway/defaults'))
      .map((e) => [e.action, e.outcome, e.status]),
    [
      ['POST /api/gateway/defaults', 'ok', 200],
      ['DELETE /api/gateway/defaults', 'refused', 405],
    ],
  );
  assert.ok(s.alive());
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test --test-name-pattern="a GET on a gateway" test/governance-http.test.js`
Expected: FAIL (`GET /api/gateway/defaults` answers 200 and empties the default models).

- [ ] **Step 3: Only the request log reads with GET**

In `server.js`, replace

```js
    if (gwAdmin) {
      if (req.method === 'GET') return send(res, 200, await gateway.admin(gwAdmin[1], 'GET'));
```

with

```js
    if (gwAdmin) {
      // Only the request log is read with GET. Every other admin route writes (defaults, settings), spends tokens
      // (playground) or calls providers (quota), so a GET there is 405 and changes nothing (A7); so is any method but
      // POST.
      if (req.method === 'GET')
        return gwAdmin[1] === 'logs'
          ? send(res, 200, await gateway.admin('logs', 'GET'))
          : send(res, 405, { error: 'method not allowed' });
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test test/governance-http.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Check the style**

Run: `npx prettier@3 --check test/governance-http.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath server.js < server.js | diff server.js - | grep -c '^[<>]'`
Expected: `7`.

- [ ] **Step 6: Commit**

```bash
git add server.js test/governance-http.test.js
git commit -m "Gateway admin: a GET on a route that writes is 405"
```

---
### Task 7: the API, the retention, the daily pass, the CLI event and the Monitors rules

**Files:**
- Create: `lib/governance/api.js`
- Modify: `server.js` (requires at 81, after `configChanged` at 276–279, `createMonitors` at 760–761, after the cost
  router at 1462–1464, after `keepTraces` at 1802–1803)
- Modify: `lib/monitors/rules.js` (the end of `RULES` at 120–129, before the `cost_anomaly` check at 302)
- Modify: `lib/monitors/index.js` (options at 77–80, `out` at 149–150, after the guardrail part at 242–244, `ruleSnap`
  at 326–327)
- Modify: `public/monitorsview.js` (`MON_MEASURE` at 97–98)
- Modify: `bin/zaafpulse.js` (`set-password` at 124 and 130–136)
- Modify: `test/monitors-rules.test.js` (37–41, 78–80), `test/budgets-monitors.test.js` (41–42, 454–457, 462),
  `test/monitors-api.test.js` (199)
- Test: `test/governance-api.test.js`, `test/governance-monitor.test.js`, `test/governance-cli.test.js` (create),
  `test/governance-http.test.js` (append)

**Interfaces:**
- Consumes: Task 2's store and `cleanRetention`, `RETENTION`, `queueEvent`; Task 3's `governance`; Task 4's
  `configChanged` (a settings save is a config change).
- Produces: `createGovernanceApi({ audit, settings: { get, save } }) → { route(req), retention() }` where `req` is
  `{ method, path, query: URLSearchParams, contentType, readBody }` and the answer `{ status, body, type?, headers? }`
  or null (V13); `createMonitors({ auditStatus })`, `snap.audit = { degraded, lastVerify }`; rules `audit_degraded`,
  `audit_chain_broken`; `MON_MEASURE.audit_degraded`, `MON_MEASURE.audit_chain_broken` (V11).

- [ ] **Step 1: Write the failing tests**

Create `test/governance-api.test.js`:

```js
// Governance audit log (AI Governance 2): the router for /api/governance/* (lib/governance/api.js) on a real store in a
// temp folder: query checks (400 with nothing read), paging, the export as a download, verify, status with the
// retention, and the retention setting (400 on a bad value, nothing written).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGovernanceAudit, keySource } = require('../lib/governance/audit');
const { createGovernanceApi } = require('../lib/governance/api');

function setup(t) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-api-')), 'audit');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const audit = createGovernanceAudit({ dir, getKey: keySource({ dir }), now: () => Date.UTC(2026, 10, 3, 12) });
  const saved = [];
  let governance;
  const api = createGovernanceApi({
    audit,
    settings: { get: () => governance, save: (g) => saved.push((governance = g)) },
  });
  const call = (p, { method = 'GET', body, contentType = 'application/json' } = {}) => {
    const u = new URL(p, 'http://x');
    return api.route({
      method,
      path: u.pathname,
      query: u.searchParams,
      contentType,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
  };
  return { audit, call, saved };
}
const dash = { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' };

test('list: newest first with paging; every bad query value is a 400', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 4; i++) s.audit.record({ action: 'config.change', actor: dash });
  const r = await s.call('/api/governance/audit?limit=2');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.entries.map((e) => e.seq), r.body.next, r.body.skipped], [[5, 4], 4, 0]);
  const next = await s.call(`/api/governance/audit?limit=2&before=${r.body.next}`);
  assert.deepEqual(
    next.body.entries.map((e) => e.seq),
    [3, 2],
  );
  const q = (x) => s.call(`/api/governance/audit?${x}`);
  assert.deepEqual(
    (await q('actor=system')).body.entries.map((e) => e.action),
    ['audit.key_created'],
  );
  assert.equal((await q('from=2026-11-03&to=2026-11-03')).body.entries.length, 5);
  assert.equal((await q('to=2026-11-02')).body.entries.length, 0);
  for (const [bad, message] of [
    ['from=2026-02-30', 'from: a date (YYYY-MM-DD) or an ISO time'],
    ['to=yesterday', 'to: a date (YYYY-MM-DD) or an ISO time'],
    ['from=2026-11-04&to=2026-11-03', 'from is after to'],
    ['actor=root', 'actor: dashboard, apikey, cli, system, rule or a key id'],
    ['outcome=maybe', 'outcome: ok, refused or error'],
    ['limit=0', 'limit: a whole number from 1 to 500'],
    ['limit=501', 'limit: a whole number from 1 to 500'],
    ['before=-1', 'before: a whole number from 1'],
    [`action=${'a'.repeat(81)}`, 'action: at most 80 characters'],
  ])
    assert.deepEqual(await q(bad), { status: 400, body: { error: message } }, bad);
  assert.equal((await q('actor=key_abc&from=2026-11-03T00:00:00.000Z')).status, 200);
});

test('export, verify and status; the routes answer 404, 405 and 415 as the other routers do', async (t) => {
  const s = setup(t);
  s.audit.record({ action: 'POST /api/gateway/keys', actor: dash, target: { type: 'gateway.keys', name: '@SUM(A1)' } });
  const csv = await s.call('/api/governance/audit/export?format=csv&from=2026-11-01');
  assert.equal(csv.status, 200);
  assert.equal(csv.type, 'text/csv; charset=utf-8');
  assert.deepEqual(csv.headers, {
    'Content-Disposition': 'attachment; filename="zaafpulse-audit-2026-11-01-now.csv"',
  });
  assert.match(csv.body, /,'@SUM\(A1\),/);
  const jsonl = await s.call('/api/governance/audit/export?format=jsonl');
  assert.equal(jsonl.body.trim().split('\n').length, 2);
  assert.deepEqual((await s.call('/api/governance/audit/export?format=xml')).body, { error: 'format: jsonl or csv' });
  assert.deepEqual((await s.call('/api/governance/audit/verify')).body, { ok: true, checked: 2, from: 1, to: 2 });
  const st = (await s.call('/api/governance/audit/status')).body;
  assert.equal(st.retentionMonths, 12);
  assert.deepEqual(
    st.months.map((m) => m.month),
    ['2026-11'],
  );
  assert.equal(st.degraded, null);
  assert.equal(st.lastVerify.ok, true);
  assert.equal((await s.call('/api/governance/nope')).status, 404);
  assert.equal((await s.call('/api/governance/audit', { method: 'POST', body: {} })).status, 405);
  assert.equal((await s.call('/api/governance/settings')).status, 405);
  assert.equal(await s.call('/api/other'), null);
  const plain = await s.call('/api/governance/settings', { method: 'POST', body: 'x', contentType: 'text/plain' });
  assert.equal(plain.status, 415);
});

test('settings: the retention from 6 to 120 months is saved beside other governance settings; anything else is 400', async (t) => {
  const s = setup(t);
  const post = (body) => s.call('/api/governance/settings', { method: 'POST', body });
  for (const bad of [
    {},
    { audit: {} },
    { audit: { retentionMonths: 5 } },
    { audit: { retentionMonths: 121 } },
    { audit: { retentionMonths: '24' } },
    { audit: { retentionMonths: 6.5 } },
  ])
    assert.deepEqual(await post(bad), {
      status: 400,
      body: { error: 'audit.retentionMonths: a whole number from 6 to 120' },
    });
  assert.equal(s.saved.length, 0, 'nothing written');
  assert.deepEqual(await post({ audit: { retentionMonths: 24 } }), {
    status: 200,
    body: { audit: { retentionMonths: 24 } },
  });
  assert.deepEqual(s.saved, [{ audit: { retentionMonths: 24 } }]);
  assert.equal((await s.call('/api/governance/audit/status')).body.retentionMonths, 24);
  assert.equal((await post('{nope')).status, 400);
});
```

Create `test/governance-monitor.test.js`:

```js
// Governance audit log (AI Governance 2): the Monitors rules audit_degraded and audit_chain_broken
// (lib/monitors/rules.js), the engine's input for them (lib/monitors/index.js) and their words on the Monitors page.
// The alerts carry a count or a seq and a fixed reason, never anything from an entry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RULES, evaluate } = require('../lib/monitors/rules');
const { createMonitors } = require('../lib/monitors');
const { createMonitorState } = require('../lib/monitors/state');

const NOW = new Date(2026, 10, 3, 12).getTime();
const rule = (id) => RULES.find((r) => r.id === id);
const run = (id, snap) => evaluate(rule(id), {}, snap, NOW);

test('the rules: aggregate, on by default, never pausing, no parameters', () => {
  assert.deepEqual(
    ['audit_degraded', 'audit_chain_broken'].map((id) => {
      const r = rule(id);
      return [r.title, r.kind, r.params, r.defaultOn({}), r.mayAutoPause];
    }),
    [
      ['Audit log degraded', 'aggregate', {}, true, false],
      ['Audit chain broken', 'aggregate', {}, true, false],
    ],
  );
  assert.equal(
    rule('audit_degraded').describe,
    'The governance audit log cannot write its entries; changes go ahead unrecorded until it can.',
  );
  assert.equal(
    rule('audit_chain_broken').describe,
    'The daily check of the governance audit log found an entry changed, missing or out of order.',
  );
});

test('audit_degraded: triggered while writing fails, its value the entries missed', () => {
  const one = (snap) => run('audit_degraded', snap)[0];
  assert.deepEqual(one({ audit: { degraded: { since: 'x', missed: 3 }, lastVerify: null } }), {
    instance: 'all',
    sessionId: null,
    state: 'triggered',
    value: 3,
    threshold: 1,
  });
  assert.equal(one({ audit: { degraded: null, lastVerify: null } }).state, 'ok');
  assert.equal(one({}).state, 'no_data');
});

test('audit_chain_broken: triggered by a failed verify, titled with its reason only; no verify yet is no_data', () => {
  const one = (v) => run('audit_chain_broken', { audit: { degraded: null, lastVerify: v } })[0];
  assert.deepEqual(one({ ok: false, brokenAt: 41, reason: 'entry changed', at: 'x' }), {
    instance: 'all',
    sessionId: null,
    state: 'triggered',
    value: 41,
    threshold: null,
    title: 'entry changed',
  });
  assert.deepEqual(
    [one({ ok: false, brokenAt: null, reason: 'key missing' }).value, one({ ok: false, reason: 'odd <b>' }).title],
    [0, undefined],
  );
  assert.equal(one({ ok: true, checked: 9 }).state, 'ok');
  assert.equal(one(null).state, 'no_data');
});

test('the Monitors page words', () => {
  const { monMeasure } = require('../public/monitorsview');
  assert.equal(monMeasure('audit_degraded', 1, 1), '1 audit entry not written');
  assert.equal(monMeasure('audit_degraded', 4, 1), '4 audit entries not written');
  assert.equal(monMeasure('audit_chain_broken', 41, null), 'broken at entry 41');
  assert.equal(monMeasure('audit_chain_broken', 0, null), 'cannot be checked');
});

test('engine: the audit status is read on each aggregate pass and a broken chain alerts once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-mon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: NOW };
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => clock.t,
  });
  const sent = [];
  let status = { months: [], degraded: null, lastVerify: { ok: false, brokenAt: 7, reason: 'chain broken' } };
  const monitors = createMonitors({
    indexer: { results: () => [] },
    office: { snapshot: () => ({ agents: [] }), demoSnapshot: () => ({ agents: [] }) },
    evals: { summary: () => ({ evaluators: {} }) },
    config: () => ({}),
    state,
    channels: { notify: async (alert) => sent.push(alert) },
    now: () => clock.t,
    auditStatus: () => status,
  });
  await monitors.tickAggregate();
  const broken = sent.filter((a) => a.rule === 'audit_chain_broken');
  assert.deepEqual(
    broken.map((a) => [a.state, a.value, a.title]),
    [['triggered', 7, 'chain broken']],
  );
  assert.equal(sent.filter((a) => a.rule === 'audit_degraded').length, 0);
  status = { months: [], degraded: { since: 'x', missed: 2 }, lastVerify: status.lastVerify };
  clock.t += 60e3;
  await monitors.tickAggregate();
  assert.equal(sent.filter((a) => a.rule === 'audit_chain_broken').length, 1, 'still broken: no second alert');
  assert.deepEqual(
    sent.filter((a) => a.rule === 'audit_degraded').map((a) => [a.state, a.value]),
    [['triggered', 2]],
  );
});
```

Create `test/governance-cli.test.js`:

```js
// Governance audit log (AI Governance 2): `zaafpulse set-password` leaves an auth.password_set event in
// .data/audit/pending (the CLI never writes the chain itself); the server's store records it with the cli actor and
// removes the file. Nothing of the password is in either.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createGovernanceAudit, keySource } = require('../lib/governance/audit');

test('set-password: the event waits in pending/ and becomes an entry with the cli actor', (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-cli-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'zaafpulse.js'), 'set-password', '--stdin'],
    {
      input: 'correct horse battery\n',
      env: { ...process.env, ZAAFPULSE_DATA: data, HOME: data, USERPROFILE: data },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const dir = path.join(data, '.data', 'audit');
  const files = fs.readdirSync(path.join(dir, 'pending'));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(dir, 'pending', files[0]), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['action', 'ts']);
  assert.ok(!text.includes('horse'));
  assert.deepEqual(fs.readdirSync(dir), ['pending'], 'no chain, no key from the CLI');
  const audit = createGovernanceAudit({ dir, getKey: keySource({ dir }) });
  assert.equal(audit.importPending(), 1);
  const e = audit.list({}).entries[0];
  assert.deepEqual([e.action, e.actor, typeof e.occurredAt], ['auth.password_set', { via: 'cli' }, 'string']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pending')), []);
});
```

Append to `test/governance-http.test.js`:

```js
test('the API: entries, export, verify, status, retention; a write failure is degraded, then one audit.gap', async (t) => {
  // The CLI's set-password event waits in pending/ and is recorded when the server starts.
  const s = await startServer(t, {}, (data) =>
    queueEvent(path.join(data, '.data', 'audit'), { action: 'auth.password_set' }),
  );
  assert.deepEqual(
    entries(s).map((e) => [e.action, e.actor.via]),
    [
      ['audit.key_created', 'system'],
      ['auth.password_set', 'cli'],
    ],
  );
  const change = (name) => call(s, '/api/config', { method: 'POST', body: { userName: name } });
  assert.equal((await change('Ana')).status, 200);
  const list = await call(s, '/api/governance/audit?limit=2');
  assert.deepEqual(
    list.body.entries.map((e) => e.action),
    ['POST /api/config', 'config.change'],
  );
  assert.equal(list.body.next, 3);
  const csv = await call(s, '/api/governance/audit/export?format=csv');
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(csv.headers.get('content-disposition'), /^attachment; filename="zaafpulse-audit-start-now\.csv"$/);
  assert.match(csv.body, /,ok,,monthlyBudgetUSD: ∅ → 0; userName: ∅ → Ana; vaultPaths: ∅ → \[\],/);
  const jsonl = await call(s, '/api/governance/audit/export?format=jsonl');
  assert.equal(jsonl.body.trim().split('\n').length, 4);
  // The month file is a folder for a while: the changes go ahead, the log is degraded (two entries each).
  const month = new Date().toISOString().slice(0, 7);
  const file = path.join(s.data, '.data', 'audit', `governance-${month}.jsonl`);
  fs.renameSync(file, `${file}.kept`);
  fs.mkdirSync(file);
  assert.equal((await change('Budi')).status, 200);
  assert.equal((await change('Citra')).status, 200);
  const degraded = (await call(s, '/api/governance/audit/status')).body.degraded;
  assert.equal(degraded.missed, 4);
  assert.match(degraded.since, /^\d{4}-\d{2}-\d{2}T/);
  fs.rmdirSync(file);
  fs.renameSync(`${file}.kept`, file);
  assert.equal((await change('Dewi')).status, 200);
  const after = (await call(s, '/api/governance/audit?limit=3')).body.entries;
  assert.deepEqual(
    after.map((e) => [e.action, e.missed ?? null]),
    [
      ['POST /api/config', null],
      ['config.change', null],
      ['audit.gap', 4],
    ],
  );
  assert.equal((await call(s, '/api/governance/audit/status')).body.degraded, null);
  assert.deepEqual((await call(s, '/api/governance/audit/verify')).body, { ok: true, checked: 7, from: 1, to: 7 });
  // The retention: 400 and nothing written for a bad value; a good one is a config change like any other.
  const bad = await call(s, '/api/governance/settings', { method: 'POST', body: { audit: { retentionMonths: 3 } } });
  assert.deepEqual(bad.body, { error: 'audit.retentionMonths: a whole number from 6 to 120' });
  assert.equal(bad.status, 400);
  assert.ok(!('governance' in JSON.parse(fs.readFileSync(path.join(s.data, 'config.json'), 'utf8'))));
  const good = await call(s, '/api/governance/settings', { method: 'POST', body: { audit: { retentionMonths: 24 } } });
  assert.deepEqual(good.body, { audit: { retentionMonths: 24 } });
  const st = (await call(s, '/api/governance/audit/status')).body;
  assert.equal(st.retentionMonths, 24);
  assert.deepEqual(
    st.months.map((m) => m.month),
    [month],
  );
  assert.ok(st.bytes > 0);
  assert.equal(st.lastVerify.ok, true);
  const cfg = entries(s).find((e) => e.action === 'config.change' && e.target.id === 'governance');
  assert.deepEqual(cfg.changes, [{ path: 'governance.audit.retentionMonths', from: null, to: 24 }]);
  assert.ok(s.alive());
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/governance-api.test.js test/governance-monitor.test.js test/governance-cli.test.js test/governance-http.test.js`
Expected: FAIL (`Cannot find module '../lib/governance/api'`; the 5 Monitors tests; the CLI leaves no event; the
appended spawned test).

- [ ] **Step 3: Create the router**

Create `lib/governance/api.js`:

```js
// The HTTP side of the governance audit log: /api/governance/*. server.js puts it behind the dashboard sign-in; no
// gateway key or MCP client reaches it (spec A9).
//   GET  /api/governance/audit?from&to&actor&action&outcome&limit&before  newest first, at most 500 per page
//   GET  /api/governance/audit/export?from&to&format=jsonl|csv          a download
//   GET  /api/governance/audit/verify                                    { ok, checked, from, to, brokenAt?, reason? }
//   GET  /api/governance/audit/status                                    retention, months, size, degraded, verify
//   POST /api/governance/settings   { audit: { retentionMonths } }       400 on a bad value, nothing written
const { cleanRetention, RETENTION } = require('./audit');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
const KINDS = new Set(['dashboard', 'apikey', 'cli', 'system', 'rule']);
const KEY_ID = /^key_[A-Za-z0-9_-]{1,40}$/;
const OUTCOMES = new Set(['ok', 'refused', 'error']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const reply = (status, body) => ({ status, body });
const fail = (status, message) => Object.assign(new Error(message), { status });

// A time from the query: YYYY-MM-DD (UTC; the end of that day for `to`) or an ISO time; null when absent.
function timeOf(name, v, end) {
  if (v == null || v === '') return null;
  if (DAY.test(v)) {
    const t = Date.parse(`${v}T00:00:00.000Z`);
    if (Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v) return end ? t + 864e5 - 1 : t;
  } else if (ISO.test(v) && Number.isFinite(Date.parse(v))) return Date.parse(v);
  throw fail(400, `${name}: a date (YYYY-MM-DD) or an ISO time`);
}
function rangeOf(q) {
  const from = timeOf('from', q.get('from'), false);
  const to = timeOf('to', q.get('to'), true);
  if (from !== null && to !== null && from > to) throw fail(400, 'from is after to');
  return { from, to };
}
// The list query, every value checked.
function listQuery(q) {
  const out = rangeOf(q);
  const actor = q.get('actor');
  if (actor) {
    if (!KINDS.has(actor) && !KEY_ID.test(actor))
      throw fail(400, 'actor: dashboard, apikey, cli, system, rule or a key id');
    out.actor = actor;
  }
  const action = q.get('action');
  if (action) {
    if (action.length > 80) throw fail(400, 'action: at most 80 characters');
    out.action = action;
  }
  const outcome = q.get('outcome');
  if (outcome) {
    if (!OUTCOMES.has(outcome)) throw fail(400, 'outcome: ok, refused or error');
    out.outcome = outcome;
  }
  const limit = q.get('limit');
  if (limit) {
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 500)
      throw fail(400, 'limit: a whole number from 1 to 500');
    out.limit = Number(limit);
  }
  const before = q.get('before');
  if (before) {
    if (!/^\d{1,15}$/.test(before) || Number(before) < 1) throw fail(400, 'before: a whole number from 1');
    out.before = Number(before);
  }
  return out;
}

// settings: { get() -> config.json "governance" (or undefined), save(value) } (server.js saveConfigSection).
function createGovernanceApi({ audit, settings }) {
  const retention = () => {
    const g = settings.get();
    return cleanRetention(isObj(g) && isObj(g.audit) ? g.audit.retentionMonths : undefined);
  };
  function saveSettings(body) {
    const n = isObj(body) && isObj(body.audit) ? body.audit.retentionMonths : undefined;
    if (!Number.isInteger(n) || n < RETENTION.min || n > RETENTION.max)
      return reply(400, { error: `audit.retentionMonths: a whole number from ${RETENTION.min} to ${RETENTION.max}` });
    const g = settings.get();
    const cur = isObj(g) ? g : {};
    settings.save({ ...cur, audit: { ...(isObj(cur.audit) ? cur.audit : {}), retentionMonths: n } });
    return reply(200, { audit: { retentionMonths: n } });
  }
  function exportOf(q) {
    const format = q.get('format') || 'csv';
    if (format !== 'csv' && format !== 'jsonl') throw fail(400, 'format: jsonl or csv');
    const x = audit.export({ ...rangeOf(q), format });
    return {
      status: 200,
      body: x.body,
      type: x.type,
      headers: { 'Content-Disposition': `attachment; filename="${x.name}"` },
    };
  }
  const GET = {
    '/api/governance/audit': (q) => reply(200, audit.list(listQuery(q))),
    '/api/governance/audit/export': exportOf,
    '/api/governance/audit/verify': () => reply(200, audit.verify()),
    '/api/governance/audit/status': () => reply(200, { retentionMonths: retention(), ...audit.status() }),
  };

  // `req` is { method, path, query, contentType, readBody }. Returns { status, body, type?, headers? }, or null when
  // the path is not ours.
  async function route(req) {
    const p = req.path;
    if (p !== '/api/governance' && !p.startsWith('/api/governance/')) return null;
    const isPost = p === '/api/governance/settings';
    if (!isPost && !Object.hasOwn(GET, p)) return reply(404, { error: 'unknown route' });
    if (req.method !== (isPost ? 'POST' : 'GET')) return reply(405, { error: 'method not allowed' });
    try {
      if (!isPost) return GET[p](req.query);
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
      let body;
      try {
        body = JSON.parse(await req.readBody());
      } catch (e) {
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      return saveSettings(body);
    } catch (e) {
      const st = e && e.status;
      // A message with a status is ours or the config writer's and holds no path; anything else is a plain 500.
      if (Number.isInteger(st) && st >= 400 && st <= 599) return reply(st, { error: e.message });
      return reply(500, { error: 'audit request failed' });
    }
  }

  return { route, retention };
}

module.exports = { createGovernanceApi };
```

- [ ] **Step 4: Wire the routes, the daily pass and the rules; update the rule-list assertions (10 rules become 12)**

In `server.js`, replace

```js
const { diff: govDiff } = require('./lib/governance/diff');
```

with

```js
const { diff: govDiff } = require('./lib/governance/diff');
const { createGovernanceApi } = require('./lib/governance/api');
```

In `server.js`, replace

```js
    changes: d.changes,
    ...(d.truncated ? { truncated: d.truncated } : {}),
  });
}
```

with

```js
    changes: d.changes,
    ...(d.truncated ? { truncated: d.truncated } : {}),
  });
}
// /api/governance/*: the entries, an export, verify, status, and the retention in config.json "governance.audit".
const governanceApi = createGovernanceApi({
  audit: governance,
  settings: { get: () => rawConfig().governance, save: (g) => saveConfigSection('governance', g) },
});
```

In `server.js`, replace

```js
      .map((e) => ({ ts: e.ts, checks: [...new Set((e.guard.hits || []).map((h) => h.check))] })),
});
```

with

```js
      .map((e) => ({ ts: e.ts, checks: [...new Set((e.guard.hits || []).map((h) => h.check))] })),
  // audit_degraded and audit_chain_broken: the governance audit log's state and its last verify (no entry content).
  auditStatus: () => governance.status(),
});
```

In `server.js`, replace

```js
      if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json', hit.headers);
    }
    if (url.pathname === '/api/logs') {
```

with

```js
      if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json', hit.headers);
    }
    // The governance audit log: entries, export (a download), verify, status and the retention setting. Behind the
    // same sign-in; no gateway key or MCP client reaches it.
    {
      const hit = await governanceApi.route({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
      });
      if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json', hit.headers);
    }
    if (url.pathname === '/api/logs') {
```

In `server.js`, replace

```js
  keepTraces();
  setInterval(keepTraces, 5 * 60 * 1000).unref();
```

with

```js
  keepTraces();
  setInterval(keepTraces, 5 * 60 * 1000).unref();
  // The governance audit log, now and once a day: the CLI's events, the whole months past the retention, and a check
  // of the chain (the Monitors rules audit_degraded and audit_chain_broken read the result).
  const auditDaily = () => {
    try {
      governance.importPending();
      governance.prune(governanceApi.retention());
      governance.verify();
    } catch {
      console.error('audit: the daily pass failed');
    }
  };
  auditDaily();
  setInterval(auditDaily, 24 * 3600 * 1000).unref();
```

In `lib/monitors/rules.js`, replace

```js
  {
    id: 'guardrail_block',
    title: 'Guardrail block',
    describe: 'The gateway guardrails blocked one or more requests in the last 60 minutes.',
    kind: 'aggregate',
    params: {},
    defaultOn: () => true,
    mayAutoPause: false,
  },
];
```

with

```js
  {
    id: 'guardrail_block',
    title: 'Guardrail block',
    describe: 'The gateway guardrails blocked one or more requests in the last 60 minutes.',
    kind: 'aggregate',
    params: {},
    defaultOn: () => true,
    mayAutoPause: false,
  },
  {
    id: 'audit_degraded',
    title: 'Audit log degraded',
    describe: 'The governance audit log cannot write its entries; changes go ahead unrecorded until it can.',
    kind: 'aggregate',
    params: {},
    defaultOn: () => true,
    mayAutoPause: false,
  },
  {
    id: 'audit_chain_broken',
    title: 'Audit chain broken',
    describe: 'The daily check of the governance audit log found an entry changed, missing or out of order.',
    kind: 'aggregate',
    params: {},
    defaultOn: () => true,
    mayAutoPause: false,
  },
];
// Why a verify of the audit chain failed (lib/governance/chain.js, audit.js): the only words an alert's title takes.
const AUDIT_REASONS = new Set(['entry changed', 'chain broken', 'sequence broken', 'unreadable line', 'key missing']);
```

In `lib/monitors/rules.js`, replace

```js
  // One instance per day, named by its date: yesterday, checked whole, and today, so far (lib/cost/anomaly.js
```

with

```js
  // Governance audit log (lib/governance/audit.js status()): entries cannot be written. The value is how many were
  // missed so far; nothing of an entry is in the alert.
  audit_degraded(p, snap) {
    const a = snap.audit;
    if (!a || typeof a !== 'object') return single('no_data', null, 1);
    if (!a.degraded) return single('ok', 0, 1);
    return single('triggered', isNonNeg(a.degraded.missed) ? a.degraded.missed : 1, 1);
  },

  // The last verify of the audit chain (daily, or from the dashboard): the value is the seq where it broke (0 when the
  // key is missing), the title the reason. No verify yet is no_data.
  audit_chain_broken(p, snap) {
    const v = snap.audit && snap.audit.lastVerify;
    if (!v || typeof v !== 'object' || typeof v.ok !== 'boolean') return single('no_data', null, null);
    if (v.ok) return single('ok', 0, null);
    const at = isNonNeg(v.brokenAt) ? v.brokenAt : 0;
    return [result('all', null, 'triggered', at, null, AUDIT_REASONS.has(v.reason) ? v.reason : null)];
  },

  // One instance per day, named by its date: yesterday, checked whole, and today, so far (lib/cost/anomaly.js
```

In `lib/monitors/index.js`, replace

```js
  // The guardrail_block rule's input (gateway guardrails): (t) -> [{ ts, checks }], the gateway requests the guardrails
  // blocked, from server.js; or null (the rule is then no_data).
  guardBlocks = null,
} = {}) {
```

with

```js
  // The guardrail_block rule's input (gateway guardrails): (t) -> [{ ts, checks }], the gateway requests the guardrails
  // blocked, from server.js; or null (the rule is then no_data).
  guardBlocks = null,
  // The audit_degraded and audit_chain_broken rules' input (lib/governance/audit.js status()): (t) -> { degraded,
  // lastVerify, … }; or null (both rules are then no_data).
  auditStatus = null,
} = {}) {
```

In `lib/monitors/index.js`, replace

```js
      guardBlocks: null, // [{ ts, checks }] for guardrail_block: times and check names only
    };
```

with

```js
      guardBlocks: null, // [{ ts, checks }] for guardrail_block: times and check names only
      audit: null, // { degraded, lastVerify } for audit_degraded and audit_chain_broken: no entry content
    };
```

In `lib/monitors/index.js`, replace

```js
    part('the guardrail blocks', () => {
      if (typeof guardBlocks === 'function') out.guardBlocks = guardBlocks(t) || null;
    });
```

with

```js
    part('the guardrail blocks', () => {
      if (typeof guardBlocks === 'function') out.guardBlocks = guardBlocks(t) || null;
    });
    part('the audit log', () => {
      if (typeof auditStatus !== 'function') return;
      const s = auditStatus(t);
      out.audit = s ? { degraded: s.degraded || null, lastVerify: s.lastVerify || null } : null;
    });
```

In `lib/monitors/index.js`, replace

```js
      guardBlocks: agg && agg.guardBlocks,
      sessions: live ? live.sessions : undefined,
```

with

```js
      guardBlocks: agg && agg.guardBlocks,
      audit: agg && agg.audit,
      sessions: live ? live.sessions : undefined,
```

In `public/monitorsview.js`, replace

```js
  guardrail_block: [(v) => `${monPlural(v, 'blocked request')} in the last hour`, null, null],
};
```

with

```js
  guardrail_block: [(v) => `${monPlural(v, 'blocked request')} in the last hour`, null, null],
  audit_degraded: [(v) => `${monRound(v)} audit ${v === 1 ? 'entry' : 'entries'} not written`, null, null],
  audit_chain_broken: [(v) => (v > 0 ? `broken at entry ${monRound(v)}` : 'cannot be checked'), null, null],
};
```

In `test/monitors-rules.test.js`, replace

```js
      'cost_anomaly',
      'guardrail_block',
    ],
  );
  for (const r of RULES) {
```

with

```js
      'cost_anomaly',
      'guardrail_block',
      'audit_degraded',
      'audit_chain_broken',
    ],
  );
  for (const r of RULES) {
```

In `test/monitors-rules.test.js`, replace

```js
    cost_anomaly: true,
    guardrail_block: true,
  });
```

with

```js
    cost_anomaly: true,
    guardrail_block: true,
    audit_degraded: true,
    audit_chain_broken: true,
  });
```

In `test/budgets-monitors.test.js`, replace

```js
test('the budget rule sits beside the ten fixed rules', () => {
  assert.equal(RULES.length, 10);
```

with

```js
test('the budget rule sits beside the twelve fixed rules', () => {
  assert.equal(RULES.length, 12);
```

In `test/budgets-monitors.test.js`, replace

```js
    'cost_anomaly',
    'guardrail_block',
  ]);
  const r = await call('/api/monitors/daily_cost', { method: 'POST', body: { enabled: true } });
```

with

```js
    'cost_anomaly',
    'guardrail_block',
    'audit_degraded',
    'audit_chain_broken',
  ]);
  const r = await call('/api/monitors/daily_cost', { method: 'POST', body: { enabled: true } });
```

In `test/budgets-monitors.test.js`, replace

```js
  assert.equal((await api().call('/api/monitors')).body.rules.length, 10, 'without the option nothing changes');
```

with

```js
  assert.equal((await api().call('/api/monitors')).body.rules.length, 12, 'without the option nothing changes');
```

In `test/monitors-api.test.js`, replace

```js
  assert.equal(r.body.rules.length, 10);
```

with

```js
  assert.equal(r.body.rules.length, 12);
```

- [ ] **Step 5: `zaafpulse set-password` leaves its event for the server**

In `bin/zaafpulse.js`, replace

```js
    const { setPassword } = require('../lib/auth');
```

with

```js
    const { setPassword } = require('../lib/auth');
    const { queueEvent } = require('../lib/governance/audit');
```

In `bin/zaafpulse.js`, replace

```js
      const file = setPassword(dir, pw);
      // A root-run CLI writes for the service user that owns the data folder (Linux system install).
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        const st = fs.statSync(dir);
        fs.chownSync(file, st.uid, st.gid);
        fs.chownSync(path.dirname(file), st.uid, st.gid);
      }
```

with

```js
      const file = setPassword(dir, pw);
      // The governance audit log records it (actor: cli) when the server next starts or runs its daily pass; the CLI
      // never writes the chain itself.
      const queued = queueEvent(path.join(dir, '.data', 'audit'), { action: 'auth.password_set' });
      // A root-run CLI writes for the service user that owns the data folder (Linux system install).
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        const st = fs.statSync(dir);
        fs.chownSync(file, st.uid, st.gid);
        fs.chownSync(path.dirname(file), st.uid, st.gid);
        for (const p of queued) fs.chownSync(p, st.uid, st.gid);
      }
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/governance-*.test.js test/monitors-*.test.js test/budgets-monitors.test.js test/guardrails-monitor.test.js`
Expected: PASS (the monitors suites green with the updated counts).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check lib/governance/api.js lib/monitors/rules.js lib/monitors/index.js public/monitorsview.js bin/zaafpulse.js test/governance-api.test.js test/governance-monitor.test.js test/governance-cli.test.js test/governance-http.test.js test/monitors-rules.test.js test/budgets-monitors.test.js test/monitors-api.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath server.js < server.js | diff server.js - | grep -c '^[<>]'`
Expected: `7`.

- [ ] **Step 8: Commit**

```bash
git add lib/governance/api.js server.js lib/monitors/rules.js lib/monitors/index.js public/monitorsview.js bin/zaafpulse.js test/governance-api.test.js test/governance-monitor.test.js test/governance-cli.test.js test/governance-http.test.js test/monitors-rules.test.js test/budgets-monitors.test.js test/monitors-api.test.js
git commit -m "Governance audit: the API, the retention, the daily pass and the Monitors rules"
```

---
### Task 8: the Governance menu and the Audit log page

**Files:**
- Create: `public/governanceview.js`
- Modify: `public/index.html` (the sidebar at 78–79, the scripts at 150–151)
- Modify: `public/app.js` (`TITLES` at 238–240, `VIEWS` at 1092–1094, the crumb group at 1125–1127, `render` at 1150,
  the refresh at 1346–1347)
- Modify: `public/styles.css` (after the cost export rule at 9964–9967)
- Test: `test/governance-ui.test.js` (create)

**Interfaces:**
- Consumes: Task 7's routes; `esc`, `$`, `api` (`public/app.js`), `subHero` (`public/iso.js`), all called inside
  functions only.
- Produces: `govView()`, `govMount()` (used by `app.js`); pure helpers `govFrom`, `govQuery`, `govExportHref`,
  `govTime`, `govActorLabel`, `govTargetLabel`, `govChangesHtml`, `govOutcomeHtml`, `govRowsHtml`, `govVerifyText`,
  `govSize`, `govStatusHtml`, `govFiltersHtml` (exported for tests); `GOV`, `GOV_RANGES`, `GOV_ACTORS`. Copy: U1.

- [ ] **Step 1: Write the failing test**

Create `test/governance-ui.test.js`:

```js
// Governance → Audit log in the browser file, without a browser (public/governanceview.js): the queries and export
// links from the filters, actors and targets in words, the rows with their changes, the status line ("Degraded since
// …"), the verify result; the page's wiring in index.html and app.js; and an audit of the file for server or owner
// text put into markup without esc() (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
global.subHero = (eyebrow, title, sub) => `<div class="hero">${eyebrow}|${title}|${sub}</div>`;
const U = require('../public/governanceview');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const NOW = Date.UTC(2026, 10, 3, 12);

test('filters: the list query and the export links', () => {
  assert.equal(U.govFrom('7', NOW), '2026-10-27T12:00:00.000Z');
  assert.equal(U.govFrom('all', NOW), null);
  assert.equal(
    U.govQuery({ range: '1', actor: 'apikey', action: 'run.', outcome: 'refused' }, { now: NOW }),
    'from=2026-11-02T12%3A00%3A00.000Z&actor=apikey&action=run.&outcome=refused&limit=100',
  );
  assert.equal(
    U.govQuery({ range: 'all', actor: '', action: '', outcome: '' }, { before: 41, now: NOW }),
    'limit=100&before=41',
  );
  assert.equal(
    U.govExportHref({ range: '30' }, 'csv', NOW),
    '/api/governance/audit/export?from=2026-10-04T12%3A00%3A00.000Z&format=csv',
  );
  assert.equal(U.govExportHref({ range: 'all' }, 'jsonl', NOW), '/api/governance/audit/export?format=jsonl');
});

test('words: actors, targets, the verify result and the size', () => {
  assert.equal(
    U.govActorLabel({ via: 'dashboard', mode: 'password', device: 'Ab12', ip: '10.0.0.2' }),
    'Dashboard · password · device Ab12 · 10.0.0.2',
  );
  assert.equal(
    U.govActorLabel({ via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' }),
    'Dashboard · local · 127.0.0.1',
  );
  assert.equal(U.govActorLabel({ via: 'apikey', keyId: 'key_ab12' }), 'API key key_ab12');
  assert.equal(U.govActorLabel({ via: 'rule', rule: 'tool_loop' }), 'Monitors rule tool_loop');
  assert.equal(U.govActorLabel({ via: 'cli' }), 'Command line');
  assert.equal(U.govActorLabel({ via: 'system' }), 'ZAAFPulse');
  assert.equal(U.govTargetLabel({ type: 'key', id: 'key_1', name: 'ci' }), 'key ci (key_1)');
  assert.equal(U.govTargetLabel({ type: 'monitors', id: 'tool_loop' }), 'monitors tool_loop');
  assert.equal(U.govTargetLabel(undefined), '—');
  assert.equal(U.govVerifyText(null), 'Not checked yet.');
  assert.equal(U.govVerifyText({ ok: true, checked: 9, from: 3, to: 11 }), 'Chain intact: entries 3–11 checked.');
  assert.equal(
    U.govVerifyText({ ok: true, checked: 2, from: 4, to: 5, unverified: 3, rekeyedAt: 4 }),
    'Chain intact: entries 4–5 checked. 3 older entries were sealed with a key that is gone.',
  );
  assert.equal(
    U.govVerifyText({ ok: false, brokenAt: 7, reason: 'entry changed' }),
    'Broken at entry 7: entry changed.',
  );
  assert.equal(
    U.govVerifyText({ ok: false, brokenAt: null, reason: 'key missing' }),
    'Cannot be checked: the audit key is missing.',
  );
  assert.equal(U.govSize({ months: [{}, {}], bytes: 2048 }), '2 months · 2.0 KB');
});

test('rows: every server string escaped, changes in a details element, refusals with their status', () => {
  const html = U.govRowsHtml([
    {
      seq: 2,
      ts: '2026-11-03T12:00:00.000Z',
      action: 'config.change',
      actor: { via: 'dashboard', mode: 'none', device: null, ip: '127.0.0.1' },
      target: { type: 'config', id: 'userName' },
      outcome: 'ok',
      changes: [{ path: 'userName', from: null, to: '<img src=x>' }],
      truncated: 3,
    },
    {
      seq: 1,
      ts: '2026-11-03T11:00:00.000Z',
      action: 'POST /api/gateway/keys',
      op: 'create',
      actor: { via: 'apikey', keyId: 'key_<b>' },
      target: { type: 'gateway.keys', name: '<script>' },
      outcome: 'refused',
      status: 403,
    },
  ]);
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('key_<b>'));
  assert.match(html, /<details class="gov-changes"><summary>4 fields changed<\/summary>/);
  assert.match(html, /<code>userName<\/code>: ∅ → &lt;img src=x&gt;/);
  assert.match(html, /and 3 more/);
  assert.match(html, /<span class="tag warn">Refused 403<\/span>/);
  assert.match(html, /<span class="tag">OK<\/span>/);
  assert.match(U.govRowsHtml([]), /No entries for these filters\./);
});

test('status: the degraded line, the retention, verify and the export links', () => {
  const f = { range: 'all', actor: '', action: '', outcome: '' };
  const st = {
    retentionMonths: 24,
    months: [{ month: '2026-11', bytes: 512 }],
    bytes: 512,
    degraded: { since: '2026-11-03T10:00:00.000Z', missed: 2 },
    lastVerify: { ok: true, checked: 0, from: null, to: null },
  };
  const html = U.govStatusHtml(st, f, null);
  assert.match(
    html,
    /<div class="gov-banner">Degraded since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}: 2 audit entries could not be written\./,
  );
  assert.match(html, /name="retentionMonths" min="6" max="120" step="1" value="24"/);
  assert.match(html, /Chain intact: no entries yet\./);
  assert.match(html, /href="\/api\/governance\/audit\/export\?format=csv" download>Export CSV</);
  assert.match(html, /href="\/api\/governance\/audit\/export\?format=jsonl" download>Export JSONL</);
  assert.ok(!U.govStatusHtml({ ...st, degraded: null }, f, null).includes('gov-banner'));
  assert.match(
    U.govStatusHtml(st, f, { ok: false, brokenAt: 9, reason: 'chain broken' }),
    /Broken at entry 9: chain broken\./,
  );
  const form = U.govFiltersHtml({ range: '30', actor: 'rule', action: '"><x', outcome: 'error' });
  assert.match(form, /<option value="30" selected>Last 30 days<\/option>/);
  assert.match(form, /<option value="rule" selected>Monitors rule<\/option>/);
  assert.match(form, /value="&quot;&gt;&lt;x"/);
  assert.match(U.govView(), /GOVERNANCE · AUDIT LOG\|Audit log\|/);
});

test('wiring: the Governance menu, the script before app.js, the route and its mount', () => {
  const html = read('index.html');
  assert.match(html, /<div class="nav-label">GOVERNANCE<\/div>\s*<a href="#governance" data-route="governance">/);
  assert.match(html, /<a class="nav-sub" href="#governance" data-route="governance\/">Audit log<\/a>/);
  assert.ok(html.indexOf('governanceview.js') > html.indexOf('costreports.js'));
  assert.ok(html.indexOf('governanceview.js') < html.indexOf('src="app.js"'));
  const app = read('app.js');
  assert.match(app, /governance: 'GOVERNANCE',/);
  assert.match(app, /governance: govView,/);
  assert.match(app, /if \(state\.route === 'governance'\) \{\s*el\.innerHTML = govView\(\);\s*return govMount\(\);/);
  assert.match(app, /state\.route !== 'governance' &&/);
  assert.ok(read('styles.css').includes('.gov-banner'));
});

test('governanceview.js puts no server or owner text into markup unescaped (S1) and loads in Node', () => {
  // Every string the server or the owner can set is "<x>": none may reach the markup as a tag.
  const x = '<x>';
  const entry = {
    seq: 1,
    ts: x,
    action: x,
    op: x,
    actor: { via: 'dashboard', mode: x, device: x, ip: x },
    target: { type: x, id: x, name: x },
    outcome: x,
    status: x,
    changes: [{ path: x, from: x, to: x }],
    truncated: x,
  };
  const others = [
    { ...entry, actor: { via: 'apikey', keyId: x } },
    { ...entry, actor: { via: 'rule', rule: x } },
    { ...entry, actor: { via: x } },
  ];
  const status = { retentionMonths: x, months: [{ month: x, bytes: 1 }], bytes: 1, degraded: { since: x, missed: x } };
  const filters = { range: x, actor: x, action: x, outcome: x };
  const html = [
    U.govRowsHtml([entry, ...others]),
    U.govStatusHtml({ ...status, lastVerify: { ok: false, brokenAt: x, reason: x } }, filters, null),
    U.govStatusHtml(status, filters, { ok: true, checked: 1, from: x, to: x, unverified: x }),
    U.govFiltersHtml(filters),
  ].join('');
  assert.ok(!html.includes('<x>'), 'a field reached the markup unescaped');
  const src = read('governanceview.js');
  for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g))
    assert.match(m[1].trim(), /^(gov[A-Z]\w*Html\(|`)/, `innerHTML from ${m[1].trim().slice(0, 40)}`);
  assert.equal(typeof document, 'undefined', 'loaded above with no DOM at all');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/governance-ui.test.js`
Expected: FAIL (`Cannot find module '../public/governanceview'`).

- [ ] **Step 3: Create the page**

Create `public/governanceview.js`:

```js
'use strict';
/* Governance → Audit log (#governance, AI Governance 2): every change made to ZAAFPulse by a person or an API key,
   from GET /api/governance/audit (newest first, a page at a time). Filters: the range, the kind of actor, action text
   and the outcome. Each row's field changes open in a <details>. Verify checks the chain (GET …/audit/verify), the
   export links download CSV or JSON lines, and the retention is saved with POST /api/governance/settings. Events are
   delegated (the CSP allows no inline handler); pure helpers are exported for Node tests, and nothing here touches the
   DOM at load time. Every server or owner string reaches the markup through esc(). */

const GOV_RANGES = [
  ['1', 'Last 24 hours'],
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['all', 'Everything kept'],
];
const GOV_ACTORS = [
  ['', 'Anyone'],
  ['dashboard', 'Dashboard'],
  ['apikey', 'API key'],
  ['cli', 'Command line'],
  ['system', 'ZAAFPulse'],
  ['rule', 'Monitors rule'],
];
const GOV_OUTCOMES = [
  ['', 'Any outcome'],
  ['ok', 'OK'],
  ['refused', 'Refused'],
  ['error', 'Error'],
];
const GOV = {
  filters: { range: '7', actor: '', action: '', outcome: '' },
  rows: [],
  next: null,
  verify: null,
  hooked: false,
};

/* ---------- pure helpers (exported) ---------- */

/** The ISO time a range starts at, or null for everything kept. */
function govFrom(range, now = Date.now()) {
  const days = Number(range);
  return Number.isFinite(days) && days > 0 ? new Date(now - days * 864e5).toISOString() : null;
}
/** The query of GET /api/governance/audit for the filters (and the page before a seq). */
function govQuery(f, { before = null, now = Date.now() } = {}) {
  const q = new URLSearchParams();
  const from = govFrom(f.range, now);
  if (from) q.set('from', from);
  if (f.actor) q.set('actor', f.actor);
  if (f.action) q.set('action', String(f.action).slice(0, 80));
  if (f.outcome) q.set('outcome', f.outcome);
  q.set('limit', '100');
  if (before) q.set('before', String(before));
  return q.toString();
}
/** The export link for the filters' range: format csv or jsonl. */
function govExportHref(f, format, now = Date.now()) {
  const q = new URLSearchParams();
  const from = govFrom(f.range, now);
  if (from) q.set('from', from);
  q.set('format', format);
  return `/api/governance/audit/export?${q}`;
}
/** "2026-11-03 14:05:09" in this browser's time zone. */
function govTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${day} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** Who acted, in words: "Dashboard · password · 10.0.0.2", "API key key_ab12", "Monitors rule tool_loop" … */
function govActorLabel(a) {
  if (!a || typeof a !== 'object') return 'Unknown';
  if (a.via === 'dashboard')
    return ['Dashboard', a.mode, a.device ? `device ${a.device}` : '', a.ip].filter(Boolean).join(' · ');
  if (a.via === 'apikey') return `API key ${a.keyId || ''}`.trim();
  if (a.via === 'rule') return `Monitors rule ${a.rule || ''}`.trim();
  if (a.via === 'cli') return 'Command line';
  if (a.via === 'system') return 'ZAAFPulse';
  return String(a.via || 'Unknown');
}
/** What was acted on: "gateway.keys ci (key_1)", or an em dash. */
function govTargetLabel(t) {
  if (!t || typeof t !== 'object') return '—';
  const name = t.name || '';
  const id = t.id && t.id !== t.name ? (name ? `(${t.id})` : t.id) : '';
  return [t.type, name, id].filter(Boolean).join(' ');
}
/** A change's value as text: absent is an empty set sign. */
const govValue = (v) => (v === null || v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v));
/** The field changes of an entry in a <details>, or '' when it has none. */
function govChangesHtml(e) {
  const list = Array.isArray(e.changes) ? e.changes : [];
  if (!list.length) return '';
  const more = e.truncated > 0 ? `<li class="muted">${esc(`and ${e.truncated} more`)}</li>` : '';
  const n = list.length + (e.truncated > 0 ? e.truncated : 0);
  return `<details class="gov-changes"><summary>${esc(`${n} field${n === 1 ? '' : 's'} changed`)}</summary><ul>${list
    .map((c) => `<li><code>${esc(c.path)}</code>: ${esc(govValue(c.from))} → ${esc(govValue(c.to))}</li>`)
    .join('')}${more}</ul></details>`;
}
/** The outcome as a tag; a refusal or an error names its HTTP status. */
function govOutcomeHtml(e) {
  const word =
    e.outcome === 'ok'
      ? 'OK'
      : e.outcome === 'refused'
        ? 'Refused'
        : e.outcome === 'error'
          ? 'Error'
          : String(e.outcome || '');
  const status = e.status && e.outcome !== 'ok' ? ` ${e.status}` : '';
  return `<span class="tag${e.outcome === 'ok' ? '' : ' warn'}">${esc(word + status)}</span>`;
}
/** The table rows. */
function govRowsHtml(entries) {
  if (!entries.length) return `<tr><td colspan="5" class="muted">${esc('No entries for these filters.')}</td></tr>`;
  return entries
    .map(
      (e) =>
        `<tr><td class="mono">${esc(govTime(e.ts))}</td><td>${esc(govActorLabel(e.actor))}</td><td><b>${esc(e.action)}</b>${e.op ? ` <span class="muted">${esc(e.op)}</span>` : ''}${govChangesHtml(e)}</td><td>${esc(govTargetLabel(e.target))}</td><td>${govOutcomeHtml(e)}</td></tr>`,
    )
    .join('');
}
/** The verify result in words. */
function govVerifyText(v) {
  if (!v) return 'Not checked yet.';
  if (v.ok) {
    const base = v.checked ? `Chain intact: entries ${v.from}–${v.to} checked.` : 'Chain intact: no entries yet.';
    return v.unverified ? `${base} ${v.unverified} older entries were sealed with a key that is gone.` : base;
  }
  if (v.reason === 'key missing') return 'Cannot be checked: the audit key is missing.';
  return `Broken at entry ${v.brokenAt}: ${v.reason}.`;
}
/** The size of the kept months: "3 months · 1.2 MB". */
function govSize(st) {
  const n = (st.months || []).length;
  const b = st.bytes || 0;
  const size = b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
  return `${n} month${n === 1 ? '' : 's'} · ${size}`;
}
/** The status panel: degraded banner, retention form, size, verify and the export links. */
function govStatusHtml(st, f, verify) {
  const banner = st.degraded
    ? `<div class="gov-banner">${esc(`Degraded since ${govTime(st.degraded.since)}: ${st.degraded.missed} audit ${st.degraded.missed === 1 ? 'entry' : 'entries'} could not be written. Changes still go ahead.`)}</div>`
    : '';
  return `${banner}<div class="gov-bar">
    <form id="gov-retention" class="gov-inline"><label>${esc('Keep months')}<input class="input" type="number" name="retentionMonths" min="6" max="120" step="1" value="${esc(st.retentionMonths)}"></label><button class="btn ghost" type="submit">${esc('Save')}</button></form>
    <span class="muted">${esc(govSize(st))}</span>
    <button class="btn ghost" type="button" data-gov-verify>${esc('Verify')}</button>
    <span class="muted" id="gov-verify">${esc(govVerifyText(verify || st.lastVerify))}</span>
    <a class="btn ghost" href="${esc(govExportHref(f, 'csv'))}" download>${esc('Export CSV')}</a>
    <a class="btn ghost" href="${esc(govExportHref(f, 'jsonl'))}" download>${esc('Export JSONL')}</a>
  </div>`;
}
/** The filter form. */
function govFiltersHtml(f) {
  const select = (name, list) =>
    `<select class="input" name="${name}">${list.map(([v, label]) => `<option value="${esc(v)}"${v === f[name] ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  return `<form id="gov-filters" class="gov-bar">
    <label>${esc('Range')}${select('range', GOV_RANGES)}</label>
    <label>${esc('Actor')}${select('actor', GOV_ACTORS)}</label>
    <label>${esc('Action')}<input class="input" name="action" maxlength="80" placeholder="config.change, keys…" value="${esc(f.action)}"></label>
    <label>${esc('Outcome')}${select('outcome', GOV_OUTCOMES)}</label>
    <button class="btn" type="submit">${esc('Apply')}</button>
  </form>`;
}

/* ---------- the page ---------- */

function govView() {
  return `<div class="holo-deck">${subHero('GOVERNANCE · AUDIT LOG', 'Audit log', esc('Every change made to ZAAFPulse by a person or an API key: who, when, what and the outcome. Entries are chained, so a changed or deleted line shows when you verify.'))}<div id="gov-app">
    <section class="holo panel"><div class="panel-head"><h3>${esc('Audit log')}</h3><span class="meta">${esc('kept by month, chained')}</span></div><div id="gov-status"><div class="skeleton" style="height:40px"></div></div>${govFiltersHtml(GOV.filters)}<div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Time')}</th><th>${esc('Actor')}</th><th>${esc('Action')}</th><th>${esc('Target')}</th><th>${esc('Outcome')}</th></tr></thead><tbody id="gov-rows"></tbody></table></div><div id="gov-more"></div></section>
  </div></div>`;
}
async function govLoadStatus() {
  const el = $('#gov-status');
  if (!el) return;
  try {
    el.innerHTML = govStatusHtml(await api('/api/governance/audit/status'), GOV.filters, GOV.verify);
  } catch (e) {
    el.innerHTML = `<div class="gov-banner">${esc(`Could not read the audit log: ${e.message}`)}</div>`;
  }
}
// The first page for the filters, or the next one (more = true).
async function govLoadRows(more = false) {
  const body = $('#gov-rows');
  if (!body) return;
  try {
    const r = await api(`/api/governance/audit?${govQuery(GOV.filters, { before: more ? GOV.next : null })}`);
    GOV.rows = more ? [...GOV.rows, ...r.entries] : r.entries;
    GOV.next = r.next;
    body.innerHTML = govRowsHtml(GOV.rows);
    const m = $('#gov-more');
    if (m)
      m.innerHTML = `${r.next ? `<button class="btn ghost" type="button" data-gov-more>${esc('Older entries')}</button>` : ''}${r.skipped ? ` <span class="muted">${esc(`${r.skipped} unreadable line${r.skipped === 1 ? '' : 's'} skipped`)}</span>` : ''}`;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5">${esc(`Could not read the audit log: ${e.message}`)}</td></tr>`;
  }
}
function govMount() {
  govInstallEvents();
  govLoadStatus();
  govLoadRows();
}
function govInstallEvents() {
  if (GOV.hooked) return;
  GOV.hooked = true;
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form || !form.closest || !form.closest('#gov-app')) return;
    e.preventDefault();
    const data = new FormData(form);
    if (form.id === 'gov-filters') {
      GOV.filters = {
        range: String(data.get('range') || '7'),
        actor: String(data.get('actor') || ''),
        action: String(data.get('action') || '').trim(),
        outcome: String(data.get('outcome') || ''),
      };
      govLoadStatus(); // the export links follow the range
      govLoadRows();
    } else if (form.id === 'gov-retention') {
      try {
        await api('/api/governance/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audit: { retentionMonths: Number(data.get('retentionMonths')) } }),
        });
      } catch (err) {
        alert(`Not saved: ${err.message}`);
      }
      govLoadStatus();
      govLoadRows();
    }
  });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest && e.target.closest('#gov-app [data-gov-verify], #gov-app [data-gov-more]');
    if (!t) return;
    if (t.hasAttribute('data-gov-more')) return void govLoadRows(true);
    const out = $('#gov-verify');
    if (out) out.textContent = 'Checking…';
    try {
      GOV.verify = await api('/api/governance/audit/verify');
    } catch (err) {
      GOV.verify = null;
      if (out) out.textContent = `Could not check: ${err.message}`;
      return;
    }
    govLoadStatus();
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    GOV,
    GOV_RANGES,
    GOV_ACTORS,
    govFrom,
    govQuery,
    govExportHref,
    govTime,
    govActorLabel,
    govTargetLabel,
    govChangesHtml,
    govOutcomeHtml,
    govRowsHtml,
    govVerifyText,
    govSize,
    govStatusHtml,
    govFiltersHtml,
    govView,
  };
```

- [ ] **Step 4: The menu, the script, the route and the styles**

In `public/index.html`, replace

```html
        <a class="nav-sub" href="#rag/connect" data-route="rag/connect">API &amp; usage</a>
        <div class="nav-label">PREFERENCES</div>
```

with

```html
        <a class="nav-sub" href="#rag/connect" data-route="rag/connect">API &amp; usage</a>
        <div class="nav-label">GOVERNANCE</div>
        <a href="#governance" data-route="governance"><span data-icon="shield"></span>Governance</a>
        <a class="nav-sub" href="#governance" data-route="governance/">Audit log</a>
        <div class="nav-label">PREFERENCES</div>
```

In `public/index.html`, replace

```html
  <script src="costreports.js"></script>
  <script src="app.js"></script>
```

with

```html
  <script src="costreports.js"></script>
  <script src="governanceview.js"></script>
  <script src="app.js"></script>
```

In `public/app.js`, replace

```js
  datasets: 'DATASETS',
  cost: 'COST CONTROL',
};
```

with

```js
  datasets: 'DATASETS',
  cost: 'COST CONTROL',
  governance: 'GOVERNANCE',
};
```

In `public/app.js`, replace

```js
  datasets: viewDatasets,
  cost: viewCost,
};
```

with

```js
  datasets: viewDatasets,
  cost: viewCost,
  governance: govView, // public/governanceview.js
};
```

In `public/app.js`, replace

```js
      : state.route === 'settings'
        ? 'PREFERENCES'
        : 'AI OBSERVABILITY';
```

with

```js
      : state.route === 'settings'
        ? 'PREFERENCES'
        : state.route === 'governance'
          ? 'GOVERNANCE'
          : 'AI OBSERVABILITY';
```

In `public/app.js`, replace

```js
  if (state.route === 'settings') return viewSettings(el);
```

with

```js
  if (state.route === 'settings') return viewSettings(el);
  // Governance → Audit log loads its own data (public/governanceview.js): it never waits for the summary.
  if (state.route === 'governance') {
    el.innerHTML = govView();
    return govMount();
  }
```

In `public/app.js`, replace

```js
      !['settings', 'brain', 'squad', 'trace', 'datasets', 'cost'].includes(state.route) &&
      !$('#view').contains(document.activeElement)
```

with

```js
      !['settings', 'brain', 'squad', 'trace', 'datasets', 'cost'].includes(state.route) &&
      state.route !== 'governance' && // the audit log keeps its filters and pages: it reloads on Apply
      !$('#view').contains(document.activeElement)
```

In `public/styles.css`, replace

```css
/* The Breakdown table's Export CSV link sits at the end of its bar. */
.cost-table-bar .cost-export {
  margin-left: auto;
}
```

with

```css
/* The Breakdown table's Export CSV link sits at the end of its bar. */
.cost-table-bar .cost-export {
  margin-left: auto;
}

/* Governance → Audit log (public/governanceview.js): the filter and status bars, the degraded banner, the changes. */
.gov-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin: 0 0 14px;
}
.gov-bar label,
.gov-inline label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.gov-inline {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.gov-inline .input {
  width: 90px;
}
.gov-banner {
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--warn-border);
  border-radius: 8px;
  background: var(--warn-bg);
  color: var(--warn-ink);
}
.gov-changes {
  margin-top: 6px;
  font-size: 12px;
}
.gov-changes ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.gov-changes code {
  overflow-wrap: anywhere;
}
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/governance-ui.test.js test/cost-ui.test.js test/cost-reports-ui.test.js test/monitors-ui.test.js`
Expected: PASS (6 new tests; "every page script shares one global scope" still passes).

- [ ] **Step 6: Check the style**

Run: `npx prettier@3 --check public/governanceview.js public/app.js test/governance-ui.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath public/styles.css < public/styles.css | diff public/styles.css - | grep -c '^[<>]'`
Expected: `39`.

- [ ] **Step 7: Commit**

```bash
git add public/governanceview.js public/index.html public/app.js public/styles.css test/governance-ui.test.js
git commit -m "Governance: the Audit log page"
```

---
### Task 9: documentation and the whole suite

**Files:**
- Create: `docs/governance.md`
- Modify: `README.md` (the Monitors cell at 113, the last feature row at 261–265, the rules at 737, before Local model
  servers at 743–745, the docs list at 1013, the API table at 1053, the configuration table at 1076)
- Modify: `docs/monitors.md` (the rule table at 23, the notes at 43)

**Interfaces:**
- Consumes: everything above; the values V1–V13.
- Produces: documentation only.

- [ ] **Step 1: The documentation page**

Create `docs/governance.md`:

````markdown
# Governance audit log

One record of every change made to ZAAFPulse by a person or an API key: who, when, what, and the outcome. It is kept
for at least six months, chained so that an edited or deleted line shows, and exportable. It lives in
`.data/audit/` next to your other data and never leaves the machine.

Open it under **Governance → Audit log** in the sidebar.

## What is recorded

| What | Action | Notes |
|---|---|---|
| Every change made from the dashboard (`POST`, `PUT`, `PATCH`, `DELETE` under `/api/`) | `POST /api/gateway/keys`, `POST /api/monitors/:id` … | the route with ids as `:id`, the body's `action`/`op` word (`op`), the target's id and name, the outcome and the HTTP status |
| Every write of `config.json`, from any settings page or the integrations editor | `config.change` | the changed fields as `{ path, from, to }`, secrets masked |
| Sign-in | `auth.login`, `auth.login_failed`, `auth.lockout`, `auth.logout`, `auth.local_code`, `auth.password_set` | the browser's known-device id (password mode) and its address; never a password or a cookie |
| API keys | `key.create`, `key.update`, `key.revoke`, `key.delete` | the key's id and name; an update lists the fields that changed |
| Collaboration runs | `run.approve`, `run.reject`, `run.cancel` | from the dashboard, `/v1/runs/<id>/resume|cancel` and A2A, with the key that asked; an approval a key may not give is recorded as refused |
| Agent and runtime control | `agent.pause`, `agent.stop`, `runtime.start` … | mirrored from `.data/agent-audit.jsonl`, which stays; a rule's own pause names the rule |
| A secret shown in the Trace explorer | `trace.reveal` | which content and which mask, never the value |
| The log itself | `audit.key_created`, `audit.rekey`, `audit.prune`, `audit.gap` | see below |

Reads that travel as `POST` are not entries: polling a run, testing a provider or an integration, listing its models,
searching a knowledge base and the previews (`/api/evals/preview`, `/api/cost/settings/preview`,
`/api/cost/restate/preview`). A request body is never copied; only the short fields named above are kept.

Gateway model calls are not entries: they are already in the gateway's request log. MCP tool calls stay in
`.cache/mcp-audit.jsonl`, whose lines now carry the `keyId` when the call came with an API key.

### Who acted

| `actor.via` | Fields | When |
|---|---|---|
| `dashboard` | `mode` (`local`, `password` or `none`), `device` (password mode: the browser's known-device id), `ip` | a signed-in dashboard request |
| `apikey` | `keyId` | a gateway request with a ZAAFPulse API key, and everything it starts |
| `cli` | none | `zaafpulse set-password` (recorded when the server next starts) |
| `system` | none | ZAAFPulse itself: retention, the key, a gap, background work |
| `rule` | `rule` | a Monitors rule that paused an agent |

### An entry

One JSON object per line, for example:

```json
{"seq":42,"ts":"2026-11-03T09:12:40.118Z","action":"config.change","actor":{"via":"dashboard","mode":"local","device":null,"ip":"127.0.0.1"},"outcome":"ok","target":{"type":"config","id":"gateway"},"changes":[{"path":"gateway.guardrails.secrets","from":"redact","to":"block"}],"prev":"5f0c…","mac":"a91e…"}
```

`outcome` is `ok`, `refused` (a 4xx, or an admin answer with `errors`) or `error` (a 5xx). A change list holds at most
50 changes, then `truncated` says how many more there were. A value under a key that looks secret (`key`, `token`,
`secret`, `password`, `auth`, `header`, `credential`) or a secret reference is written as `‹changed›`; switches and
numbers stay readable, and so do `gateway.guardrails.secrets` (a mode) and `cost.keyCenters` (key ids). Other text is
cut to 120 characters.

## The chain

Every entry has `seq` (1, 2, 3 … across months), `prev` (the `mac` of the entry before it; `genesis` for the very
first) and `mac` = HMAC-SHA256(key, `prev` + newline + the entry without `mac` as canonical JSON, keys sorted). Editing
a field, deleting a line, moving one or writing a line that does not parse breaks the chain at that entry.

The key is 32 random bytes, made on the first entry, in the OS secret store as `acc.audit-chain` (the Keychain,
the keyring or the encrypted secret file, as for provider keys). When the store cannot hold it, it is
`.data/audit/chain.key` (mode 0600) and every entry says `"keyed": "file"`. Whoever can read the key can rewrite the
whole log: the chain shows changes made without it, such as a hand edit or a deleted line.

**Verify** (the button on the page, `GET /api/governance/audit/verify`, and once a day on its own) checks every kept
entry and answers `{ ok, checked, from, to }`, or `brokenAt` (the first seq that fails) and `reason`: `entry changed`,
`chain broken`, `sequence broken`, `unreadable line` or `key missing`. A server also knows the last entry it wrote, so
lines cut from the end show as `sequence broken`.

When the key is gone but entries exist (a restored data folder without its Keychain item), verify says `key missing`.
The next entry does not seal over the old chain: an `audit.rekey` entry with `prev: "rekeyed"` starts a new part with
a new key. Verify then checks the new part and reports how many older entries it could not check (`unverified`).

## Retention

The files are monthly: `.data/audit/governance-YYYY-MM.jsonl` (UTC months, mode 0600, folder 0700), with no size
rotation. A month is deleted once it ended more than `governance.audit.retentionMonths` months ago (default 12, from 6
to 120), at start and once a day, and the deletion is an `audit.prune` entry naming the months. Verify starts from the
oldest kept month, so pruning never breaks it.

Change it on the page or with `POST /api/governance/settings` `{ "audit": { "retentionMonths": 24 } }`; a value
outside 6 to 120 is a 400 and nothing is written. The change is itself a `config.change` entry.

## Export

**Export CSV** and **Export JSONL** download the entries of the chosen range (`GET
/api/governance/audit/export?from&to&format=csv|jsonl`), oldest first. JSONL lines are byte for byte what the log
holds, so a copy can be verified with the same key. The CSV has one line per entry (`seq, time, actor, actor_id, ip,
action, op, target_type, target_id, target_name, outcome, status, changes, prev, mac`); a cell that starts with `=`,
`+`, `-`, `@`, a tab or a carriage return gets a leading `'`, as the cost export does. At most 100,000 entries per
export (413 beyond: narrow the range).

## When an entry cannot be written

A full disk or a permission problem never stops the change itself. The server remembers since when writing fails and
how many entries it missed; the page shows "Degraded since …", `GET /api/governance/audit/status` returns
`degraded: { since, missed }`, and the Monitors rule `audit_degraded` alerts. Once writing works again, one
`audit.gap` entry records how many entries were missed and since when, then the chain goes on.

## Monitors

- `audit_degraded` (on by default): triggered while entries cannot be written; its value is the number missed.
- `audit_chain_broken` (on by default): triggered when the last verify failed; its value is the seq where the chain
  broke (0 when the key is missing) and its title the reason.

Neither pauses anything, and neither alert carries anything from an entry.

## API

All behind the dashboard sign-in; no gateway key or MCP client reaches them.

| Route | What |
|---|---|
| `GET /api/governance/audit?from&to&actor&action&outcome&limit&before` | entries, newest first, at most 500 per page (default 100); `from`/`to` are `YYYY-MM-DD` (UTC) or ISO times, `actor` a kind (`dashboard`, `apikey`, `cli`, `system`, `rule`) or a key id, `action` text found in the action or its `op`; the answer is `{ entries, next, skipped }` (`next` is the `before` of the next page, `skipped` counts unreadable lines) |
| `GET /api/governance/audit/export?from&to&format=jsonl\|csv` | a download |
| `GET /api/governance/audit/verify` | `{ ok, checked, from, to, brokenAt?, reason?, unverified?, rekeyedAt? }` |
| `GET /api/governance/audit/status` | `{ retentionMonths, months: [{ month, bytes }], bytes, degraded, lastVerify }` |
| `POST /api/governance/settings` | `{ "audit": { "retentionMonths": n } }` (6 to 120) |

A bad query value is a 400 that names it, as `limit: a whole number from 1 to 500`.

## Known limits

- One person per dashboard: entries say `dashboard`, the sign-in mode, the device and the address, not a name.
  Named users come with a later sub-project.
- The chain is anchored nowhere outside this machine. Someone with the key and the files can rewrite both.
- The oldest kept month has no entry before it to check its first line against, so deleting that whole file looks
  like retention. The `audit.prune` entries show which months retention deleted.
- `zaafpulse set-password` leaves its event in `.data/audit/pending/`; it becomes an entry when the server starts or
  runs its daily pass.
- The server is the only writer. Two servers on one data folder would each continue the chain from where they last
  saw it.
- Lines cut from the end of the newest month while the server was stopped hold together as a chain; only a running
  server notices them (it knows the last entry it wrote).
````

- [ ] **Step 2: `README.md` and `docs/monitors.md`**

In `README.md`, replace

```markdown
<sub>Eight rules on cost, quality and agent behaviour, including cost anomalies and guardrail blocks, plus your budgets, with alerts in the top bar, a desktop notification or a webhook. Pause, resume or stop the agent behind a session, or let a cost or loop rule pause it (off by default). Snooze a rule for an hour or a day.</sub>
```

with

```markdown
<sub>Ten rules on cost, quality, agent behaviour and the audit log, including cost anomalies and guardrail blocks, plus your budgets, with alerts in the top bar, a desktop notification or a webhook. Pause, resume or stop the agent behind a session, or let a cost or loop rule pause it (off by default). Snooze a rule for an hour or a day.</sub>
```

In `README.md`, replace

```markdown
<sub>Secrets, personal data and prompt injection checked in everything the gateway sends to a provider or an MCP integration: off, log, redact or block, per key if you like. Redacted text becomes a fixed placeholder; nothing matched is ever stored. On by default: after an upgrade, coding agents see <code>‹secret: …›</code> where a file holds a key (set secrets to log to opt out; <a href="docs/guardrails.md#what-changes-when-you-upgrade">what changes</a>). <a href="docs/guardrails.md">docs/guardrails.md</a></sub>

</td>
</tr>
</table>
```

with

```markdown
<sub>Secrets, personal data and prompt injection checked in everything the gateway sends to a provider or an MCP integration: off, log, redact or block, per key if you like. Redacted text becomes a fixed placeholder; nothing matched is ever stored. On by default: after an upgrade, coding agents see <code>‹secret: …›</code> where a file holds a key (set secrets to log to opt out; <a href="docs/guardrails.md#what-changes-when-you-upgrade">what changes</a>). <a href="docs/guardrails.md">docs/guardrails.md</a></sub>

</td>
<td valign="top">

**Governance audit log**<br>
<sub>Every change made by a person or an API key (settings, keys, providers, guardrails, integrations, budgets, sign-ins, approvals) with who, when, what and the outcome. Monthly files kept 12 months by default, chained with a key so an edited or deleted line shows when you verify, exportable as CSV or JSON lines. <a href="docs/governance.md">docs/governance.md</a></sub>

</td>
</tr>
</table>
```

In `README.md`, replace

```markdown
- **Eight rules:** cost burn (per session, per 10 minutes), tool loop, agent stuck, accuracy drop, evaluator pass rate, unsafe content, cost anomaly (today's or yesterday's spend well above what the same weekday usually costs) and guardrail block (the gateway guardrails blocked a request in the last hour), plus your cost budgets. Each rule can be switched on or off, has its own limits, and can be snoozed for an hour or a day. A rule with missing input reports *no data* and never triggers.
```

with

```markdown
- **Ten rules:** cost burn (per session, per 10 minutes), tool loop, agent stuck, accuracy drop, evaluator pass rate, unsafe content, cost anomaly (today's or yesterday's spend well above what the same weekday usually costs), guardrail block (the gateway guardrails blocked a request in the last hour), audit log degraded and audit chain broken (see [Governance audit log](#governance-audit-log)), plus your cost budgets. Each rule can be switched on or off, has its own limits, and can be snoozed for an hour or a day. A rule with missing input reports *no data* and never triggers.
```

In `README.md`, replace

```markdown
Rules, states, channels, safety checks, the API and known limits: **[docs/monitors.md](docs/monitors.md)**.

## Local model servers
```

with

```markdown
Rules, states, channels, safety checks, the API and known limits: **[docs/monitors.md](docs/monitors.md)**.

## Governance audit log

**Governance → Audit log** lists every change made to ZAAFPulse by a person or an API key: dashboard changes with
their route and outcome, every `config.json` write with its changed fields (secrets masked), sign-ins and lockouts, API
key changes, approvals and cancels of collaboration runs (with the key that asked), agent and runtime control, and
each secret shown in the Trace explorer.

- **Kept** in monthly files under `.data/audit/` for 12 months by default (6 to 120), then deleted by whole months.
- **Chained:** each entry carries an HMAC of the one before it, with a key in the OS secret store. **Verify** shows
  the first entry that was changed, removed or moved; it also runs once a day, and the `audit_chain_broken` rule alerts.
- **Never in the way:** when an entry cannot be written the change still happens, the page shows "Degraded since …",
  and `audit_degraded` alerts; one `audit.gap` entry follows once writing works again.
- **Export** as CSV or JSON lines; no request body is copied.

What is recorded, the chain, retention and the API: **[docs/governance.md](docs/governance.md)**.

## Local model servers
```

In `README.md`, replace

```markdown
docs/guardrails.md     gateway guardrails: the checks, modes, scope, per-key policy, what is recorded, reading a block
```

with

```markdown
docs/guardrails.md     gateway guardrails: the checks, modes, scope, per-key policy, what is recorded, reading a block
docs/governance.md     governance audit log: what is recorded, the chain, verify, retention, export, degraded mode, API
```

In `README.md`, replace

```markdown
| `POST /api/rescan` | re-index changed log files now |
```

with

```markdown
| `GET /api/governance/audit` · `export` · `verify` · `status` · `POST /api/governance/settings` | the governance audit log: entries, a CSV or JSON-lines download, a check of the chain, its state, and the retention; see [docs/governance.md](docs/governance.md#api) |
| `POST /api/rescan` | re-index changed log files now |
```

In `README.md`, replace

```markdown
| Gateway guardrails (`gateway.guardrails`) | secrets `redact`, personal data `off`, prompt injection `log`, scope `external` ([docs/guardrails.md](docs/guardrails.md)) |
```

with

```markdown
| Gateway guardrails (`gateway.guardrails`) | secrets `redact`, personal data `off`, prompt injection `log`, scope `external` ([docs/guardrails.md](docs/guardrails.md)) |
| Audit log retention (`governance.audit.retentionMonths`) | 12 months, from 6 to 120 ([docs/governance.md](docs/governance.md#retention)) |
```

In `docs/monitors.md`, replace

```markdown
| `guardrail_block` | The gateway guardrails blocked one or more requests in the last 60 minutes (see [docs/guardrails.md](guardrails.md)) | none | yes | no |
```

with

```markdown
| `guardrail_block` | The gateway guardrails blocked one or more requests in the last 60 minutes (see [docs/guardrails.md](guardrails.md)) | none | yes | no |
| `audit_degraded` | The governance audit log cannot write its entries (see [docs/governance.md](governance.md)) | none | yes | no |
| `audit_chain_broken` | The last check of the governance audit log's chain failed | none | yes | no |
```

In `docs/monitors.md`, replace

```markdown
- `guardrail_block` reads the gateway's usage entries after each refresh. Its value is the number of blocked requests in the last 60 minutes and the alert's title names the checks that blocked (`injection, secrets`): never a label or the text that was found.
```

with

```markdown
- `guardrail_block` reads the gateway's usage entries after each refresh. Its value is the number of blocked requests in the last 60 minutes and the alert's title names the checks that blocked (`injection, secrets`): never a label or the text that was found.
- `audit_degraded` and `audit_chain_broken` read the governance audit log's state after each refresh. The first one's value is the number of entries that could not be written so far; the second one's is the seq where the chain broke (0 when the key is missing) and its title the reason (`entry changed`, `chain broken`, `sequence broken`, `unreadable line` or `key missing`). The chain is checked at start, once a day and whenever you press Verify. Neither alert carries anything from an entry.
```

- [ ] **Step 3: The whole suite**

Run: `npm test`
Expected: about 2306 tests, all pass but the 2 skipped. A timing test that fails once under load (`call: a helper that
keeps the pipes open cannot hold the call past its timeout`, `a Save queued while another hangs…`) is rerun on its own
with `node --test <file>` before anything else is suspected.

- [ ] **Step 4: Commit**

```bash
git add docs/governance.md README.md docs/monitors.md
git commit -m "Document the governance audit log"
```

## Decisions made while planning

- **Reads sent as POST are not entries (V3).** The dashboard polls `collab get` every 1.2 s while a run works, and
  tests connections, lists provider models, searches knowledge bases and asks for previews with `POST`. Recording them
  would bury the changes; they change nothing. The list is explicit (`READ_ONLY` in `lib/governance/events.js`), so a
  new writing route is recorded by default. `GET /api/gateway` and `GET /api/gateway/logs` are reads and are not
  entries either.
- **Two entries for one dashboard change.** A settings save is a `config.change` entry (the fields) and its request
  entry (the route, the outcome); a key made from the dashboard is `key.create` and `POST /api/gateway/keys`; a reveal
  is `trace.reveal` and `POST /api/trace/reveal`. The specific entry carries what the route cannot say; the request
  entry carries the outcome of the request as a whole. The spec's test list asks for "both entries".
- **The entry is written right before the answer.** `send()` in `server.js` writes the pending request entry before
  `writeHead`, so a client (or a test) that reads the log after the answer always finds it. A request that never
  answers (a body over the limit, a dropped connection) is no entry.
- **The CLI never writes the chain.** `zaafpulse set-password` often runs as root on a Linux system install, where the
  secret store it would see is not the service's; writing the chain from there could seal with the wrong key or leave
  root-owned files. It leaves `{ action, ts }` in `.data/audit/pending/` (handed to the data folder's owner when run as
  root) and the server records it with the `cli` actor at its next start or daily pass. The server stays the only
  writer, so `record()` can keep the last `seq`/`mac` in memory.
- **What `missed` counts (A6).** Entries, not requests: a dashboard config change while degraded misses two. The page
  and the Monitors measure say "audit entries".
- **Masking (A5) keeps switches, numbers and two names readable.** `secret` in the spec's word list matches
  `gateway.guardrails.secrets`, the spec's own example path, whose value is a mode (`redact`, `block`); `key` matches
  `cost.keyCenters`, whose values are key ids. Both names are exempt. A boolean or a number cannot hold a secret, so
  `tokenSaver: true → false` stays readable. Everything else under a secret-looking name, and any secret reference, is
  `‹changed›`.
- **Retention by whole UTC months (V8).** "Whole months older than that" is read as: a month goes once it ended more
  than `retentionMonths` months ago, so at least that many full months are always kept besides the current one.
- **Verify after a rekey.** The part sealed with the lost key cannot be checked; verify checks the part from the
  `audit.rekey` entry on and says how many entries it could not check (`unverified`, shown on the page). While the key
  is missing and nothing new was written, verify is `ok: false`, `reason: 'key missing'`, `brokenAt: null`.
- **Lines cut from the end.** The chain alone cannot see them; the running server compares the last verified `seq`
  with the last one it wrote or read and reports `sequence broken` at the first missing one.
- **Lockout events.** One `auth.lockout` (with `seconds`) on the failure that starts a lockout; the 429 answers during
  it are not entries, or a flood of guesses would flood the log. A local sign-in code that does not work is not an
  entry either (only this OS account can reach that page).
- **Key and run entries at the source.** The gateway wraps `keys.create/update/revoke/remove` and
  `collab.cancel/resume` once, so every caller is covered: the keys page, a code tool's key, the skills key, a budget
  save that clears a key budget, the dashboard, `/v1/runs` and A2A. An approval a key may not give is recorded as
  `run.approve` refused 403 too.
- **The MCP key id comes from the actor (A8).** `lib/integrations.js` reads `actor()`, which also names the key when
  an agent run started with a key calls a tool.
- **Agent and runtime control are mirrored in `server.js`.** Both control modules already take an `audit` option; the
  server passes one that writes `agent-audit.jsonl` as before and then a governance entry. The control modules are not
  touched.
- **A7 covers every method but POST.** A `GET` on any admin route but `logs` is 405 and not recorded (a read); a
  `PUT`/`DELETE` is 405 and recorded as refused.
- **The page skips the summary.** `app.js` renders `#governance` before the "no data yet" skeleton and leaves it out of
  the one-minute repaint, without changing the route lists `test/cost-ui.test.js` asserts. S1 is tested by rendering
  every helper with `<x>` in each field, since the text helpers build strings that are escaped where they are used.
- **Demo mode.** The audit key lives in the throwaway folder (no secret store); the demo's seeding shows up as entries.
- **Spawned tests and the Keychain.** `NO_JUDGE_PORTS` forces the file secret store with a test master key, because
  the first change any spawned server records now makes the audit key.

## Spec points that do not fit

- **A4(1) "every gateway admin request".** Read as "every one that can change something": the reads sent as `POST`
  listed in V3 are left out (the 1.2 s run polling alone would be most of the log). The controller may want them in.
- **A4(3) "password set (CLI)".** Recorded when the server next starts or runs its daily pass, not at once; `ts` is the
  time it was recorded and `occurredAt` the time the CLI ran (see the CLI decision above).
- **A5's word list catches the spec's own example.** `gateway.guardrails.secrets` would be `‹changed›` by the letter of
  A5; the plan exempts `secrets` and `keyCenters` and never masks booleans or numbers.
- **Error handling: "entries continue with `keyed` noted".** Read as: the `audit.rekey` entry says where the new key
  is (`keyed: "store"` or `"file"`), and later entries carry `keyed: "file"` only when the key is the file, as A2 says.
- **"verify reports `reason: 'key missing'`" after a rekey.** Once the chain restarts, verify is `ok` for the new part
  and reports `unverified`/`rekeyedAt`; `key missing` is reported while there is no key at all. A verify that stayed
  broken for ever after a rekey would keep `audit_chain_broken` triggered with nothing the owner could do.
- **A2 "verify starts from the oldest kept file".** So the first kept entry's `prev` is not checked: deleting the
  oldest month by hand looks like retention. The `audit.prune` entries and `docs/governance.md` say so.
- **A11 "a daily verify".** Also once when the server starts; the result is kept in memory (a restart verifies again).
- **Architecture: `lib/agents/control.js`, `lib/runtimes/control.js` "forward their existing audit entries".** Done
  through their existing `audit` option from `server.js`; neither file changes.
- **A9 verify answer.** Adds `unverified` and `rekeyedAt` after a rekey.
- **A6 wording.** The page says "Degraded since …" (a sentence start) for the spec's "degraded since …".
- **The spec's integration test "a collaboration approval via API key carries the key id".** A key may not approve by
  default; the spawned test records the refused approval and the rejection with the key id, and the in-process
  gateway test also covers an approval by a key with `approveOwnRuns`.

## Self-review

- **Spec coverage.** A1 monthly files, modes, retention with its entry, start and daily: Tasks 2 and 7. A2 seq, prev,
  mac, genesis, cross-month chain, the key in the store or `chain.key`, `keyed`, verify's first broken seq, retention
  keeps verify ok: Tasks 1–2 (and the rekey case of the error table). A3 the actor through AsyncLocalStorage, set after
  `auth.check` and in `authed()`, all five kinds: Task 3 (`dashboard`, `apikey`, `system`), Task 5 (`rule`), Task 7
  (`cli`). A4(1) request entries: Task 3 (+ V3 reads). A4(2) both writers: Task 4. A4(3) sign-in events: Task 5, the CLI
  event Task 7. A4(4) runs from the dashboard, `/v1/runs` and A2A with the key id: Task 5. A4(5) control mirrored with
  `agent-audit.jsonl` kept: Task 5. A4(6) reveal: Task 5. A4(7) keys: Task 5. A4(8) prune and key creation: Task 2. A5:
  Task 1. A6 degraded, status, gap: Tasks 2 and 7, rule Task 7, page Task 8. A7: Task 6. A8: Task 5. A9 the five routes
  with validation and the formula guard: Task 7 (CSV in Task 2). A10 the menu and page: Task 8. A11 both rules, daily
  verify, no pause, no content: Task 7. A12: nothing logs model calls or anchors the chain. Docs and README: Task 9.
  The spec's test list: chain and verify cases and retention (Tasks 1–2), diff (Task 1), pruning (Task 2), list
  filters and paging (Tasks 2 and 7), CSV guard (Tasks 2 and 7), spawned: config change with both entries (Task 4), key
  change (Tasks 3 and 5), failed login and lockout (Task 5), approval via API key with the key id (Task 5), reveal (Task
  5), GET on `/api/gateway/defaults` (Task 6), degraded and `audit.gap` (Task 7), export and verify routes (Task 7), UI
  strings (Task 8).
- **Placeholders.** None: every new file is given whole, every edit as an exact `old` → `new` pair or a block appended
  to a file this plan created.
- **Names and signatures.** `createGovernanceAudit({ dir, getKey, now })` and its seven methods (Task 2) are what
  `server.js` (Tasks 3, 7), `lib/governance/api.js` (Task 7) and the tests call; `keySource`, `queueEvent`,
  `cleanRetention`, `RETENTION` likewise. `runAs`/`setActor`/`actor` (Task 3) are used by `server.js`, the gateway,
  `lib/integrations.js` and the tests. `requestEntry`/`controlEntry` (Task 3) by `server.js` (Tasks 3, 5).
  `govRecord`, `configChanged`, `governance`, `governanceApi` are defined once in `server.js` and used after. `auth.
  actorOf` (Task 3) is what `emit` uses (Task 5). `createMonitors({ auditStatus })` feeds `snap.audit` (Task 7).
  `govView`/`govMount` (Task 8) are what `app.js` calls.
- **Globals.** Every new top-level name in `public/governanceview.js` starts with `gov` or `GOV`; the global-scope test
  passes.
- **Privacy.** Tests assert that no entry holds a key's secret, a password, `zp_session`, a pasted integration secret
  or a hand-typed token, and that alerts carry a count, a seq and a reason word only.
