# Dashboard users and roles (AI Governance 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner give other people their own sign-in to the dashboard (local accounts, no SSO): a **viewer**
who reads metadata, the Governance pages and the evidence export, and a **reviewer** who also reviews the AI inventory
and approves collaboration runs, without sharing the admin password and with every change recorded under the person
who made it. Every reviewer or viewer `/api` request is checked against an explicit allow-list (deny by default).

**Architecture:**
- **The accounts file.** `lib/users/store.js` keeps `.data/users.json` (0600, written whole and atomically through
  `lib/cost/files.js` `writePrivate`): create, update, reset, change, delete, verify, with the admin password's scrypt
  parameters (`lib/auth.js` `hashPassword`, `checkPassword`, `SCRYPT`). A file that cannot be read is never written
  over.
- **Sign-in.** `lib/auth.js` takes `{ name, password }` (no name, or `owner`, is the admin password, so the old `{
  password }` sign-in works); a session carries `{ user, role, display, mustChange }`; `sessionOf(req)`,
  `endSessions(user, keep)`, `passwordChanged(req)`; each account name has a lockout budget of its own; `actorOf`
  gains `user` and `role`. Local mode signs in accounts beside `zaafpulse open`.
- **The policy.** `lib/users/policy.js` (pure): `allowed({ role, method, path, action, mustChange })`, the per-role
  allow-lists, `redactGateway(payload, role)` and `redactTraceSessions(body, role)`.
- **The routes.** `lib/users/api.js`: `GET|POST /api/users` (owner), `GET /api/users/names` (owner, reviewer), `POST
  /api/account/password` (any account), one governance entry per change.
- **Wiring.** `server.js`: the store, `createAuth({ accounts, ownerName })`, the role gate right after the sign-in
  check (a refusal is a 403 and one refused request entry, reads included; a body is read once), the redacted gateway
  view and session list, the users routes, the `accounts` part of the control state.
- **Governance.** `lib/governance/events.js` (`requestEntry` `always`), `lib/governance/audit.js` and `api.js` (the
  `user` filter, the CSV's `actor_id`), `lib/governance/controls.js` (`access_roles` and three clauses).
- **Dashboard.** `public/usersview.js` (prefix `usr`/`USR`): Settings → Users, the role banner and identity text;
  `public/app.js`: `ZP.me`, `isOwner()`, the 403 messages, the top bar, the hidden owner controls, the `#settings/users`
  route; `public/governanceview.js`: the review drawer for reviewers with the accounts' names suggested, the User
  filter; `public/login.html`, `public/login.js`: the name field and the change-password step.

**Tech Stack:** Node ≥18 standard library only (CommonJS), `node:test`, plain browser JS in `public/` (classic
scripts sharing one global scope, loaded before `app.js`).

**Spec:** `docs/superpowers/specs/2026-11-04-dashboard-users-roles-design.md` (AI Governance sub-project 4 of 4).

**Line numbers** in each task's **Files** list are where each replacement's `old` text starts when it is applied, in
order (the base is `5688b2d` on `feat/gov-users`, with the earlier tasks of this plan applied). Every edit is an exact
`old` → `new` replacement (each `old` occurs exactly once in its file when the step runs) or a whole new file.
Re-read each location before editing it.

**Checked while planning:** Tasks 1–8 were built in order in a scratch worktree of `5688b2d` (detached). The plan was then
generated from those commits and applied mechanically, task by task, to a fresh worktree of `5688b2d`: 113 operations
(13 new files, 100 replacements, each `old` found exactly once), running each task's Step 2 command right after its
tests were added and its Step 4 command after the rest. Every new test failed before its task (Tasks 1, 3 and 7: the
module is missing; Task 2: 12 of 20; Task 4: the router is missing and both spawned tests fail; Task 5: 3 of 4; Task 6:
7 of 34; the tests that passed there are earlier tasks' and the existing assertions that do not change) and passed after
it (Task 1's command: 4 tests; Task 2's: 48; Task 3's: 7; Task 4's: 67; Task 5's: 46; Task 6's: 40; Task 7's: 39). After
every task the applied tree matched the scratch tree byte for byte. `npm test` on it: 2471 tests, 2469 pass, 2 skipped,
0 fail (30 s). This final text was applied the same way a second time, to another fresh worktree: the
same results step by step, the same tree after every task, `npm test` 2471 / 2469 / 2 skipped / 0 fail (29 s). Baseline on `5688b2d`: 2437 tests, 2435 pass, 2 skipped, 0 fail (28 s). The 34
new tests in `test/users-*.test.js` all pass; the two spawned-server tests took 0.4 s and 1.4 s. `npx prettier@3 --check`
passes on every file this plan creates and on the shared files in Global Constraints; `server.js` and
`public/styles.css` keep their `5688b2d` counts (7 and 39), and `node --check` parses the five page scripts this plan
touches. A demo server (`DEMO=1`) showed what the viewer's reads carry: the gateway payload's parts (redacted in V6), and
text in `/api/summary` (quality events) and `/api/logs` (error lines), which the spec lists as viewer reads (see Spec
points). Not checked: the pages in a real browser (their markup is tested through the exported helpers and the source,
S1 by rendering `<x>` in every field), and an account's sign-in through the local-mode page in a real browser.

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test` (`npm test`; one file:
  `node --test test/<file>.test.js`). Plain browser JS in `public/`: classic `<script>` files loaded by
  `public/index.html` before `app.js`.
- **Pure modules.** `lib/users/policy.js` requires nothing and reads no file or clock. `lib/users/store.js` requires
  only `crypto`, `fs`, `../auth` and `../cost/files`; its clock comes through `now`. `lib/users/api.js` requires
  nothing: the store, the auth, the recorder and the owner's name are passed in.
- **Secrets (binding).** No password, salt or hash leaves `lib/users/store.js` (its `view()`); no password reaches an
  audit entry, an event, a log line or an answer. A wrong name, a wrong password and a disabled account get one answer
  (`401 wrong name or password`). A failed sign-in names its account as the target only when that account exists.
- **Deny by default (binding).** A reviewer's or a viewer's `/api` request runs only when `allowed()` says so; the
  owner is never restricted; the policy's lists are the only place a route is opened to a non-owner.
- **Never in the way.** Recording an entry never changes an answer (A6). A `users.json` that cannot be read lets
  nobody in it sign in, is never written over, and never stops the owner.
- **The old sign-in keeps working.** `POST /api/login { password }` signs in the owner; the existing tests of
  `test/signin.test.js` and `test/security.test.js` pass unchanged.
- **One global scope.** New top-level names in `public/usersview.js` start with `usr` or `USR`; the new names in
  `public/app.js` (`isOwner`) and `public/governanceview.js` (`govCanReview`, `govRole`) repeat no other page script's
  (`test/cost-ui.test.js`: "every page script shares one global scope").
- **Loadable in Node.** `public/usersview.js` ends with `if (typeof module !== 'undefined') module.exports = …` and
  touches no DOM at load time; tests `require` it with stand-ins for `esc`, `subHero` and `subTabs`.
- **Text only (S1).** Every server or owner string into HTML goes through `esc()`. CSP stays `script-src 'self'`: no
  inline handlers; the Users page uses delegated `submit`, `change` and `click` listeners installed once. Every
  `.innerHTML =` in `public/usersview.js` takes a `usr…Html(` call, `usrView(` or a template literal
  (`test/users-ui.test.js` checks it). `public/login.js` puts only its own static text into markup.
- **Tests.**
  - Never call a real network and never signal a real process.
  - Spawned `server.js` tests live in `test/users-http.test.js` and use **ports 10200–10399**, which no existing test
    uses (fixed ranges taken: 4800–4989, 5100–9999 across several files, 10000–10199
    `governance-inventory-http`; the others listen on port 0). Each server gets a temp data folder that is also `HOME`
    and `USERPROFILE`, with `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` and `APPDATA` inside it, password
    sign-in (`ZAAFPULSE_AUTH=1`, `ZAAFPULSE_ADMIN_PASSWORD`) unless no sign-in is under test, and `NO_JUDGE_PORTS`; an
    answer counts only while the child is still running (`s.alive()`); the child is killed and awaited, then its folder
    removed, in `t.after`.
  - Restore what a test replaces; temp folders removed in `t.after`.
- **Housekeeping.**
  - Prettier (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Run
    `npx prettier@3 --check` on every file you create and on `lib/auth.js`, `lib/governance/events.js`,
    `lib/governance/api.js`, `lib/governance/audit.js`, `lib/governance/controls.js`, `public/app.js`, `public/iso.js`,
    `public/governanceview.js`, `public/login.js`, `test/governance-auth.test.js`, `test/governance-http.test.js`,
    `test/governance-controls.test.js`, `test/governance-evidence.test.js` and `test/governance-inventory-http.test.js`
    (all pass on `5688b2d`). Never `--write` `server.js`, `public/styles.css`, `test/signin.test.js`,
    `lib/gateway/index.js`, `test/gateway.test.js`, `test/gateway-forms.test.js` or `test/register.test.js`: they
    already differ from Prettier on `5688b2d` (so do about 90 other files this plan does not touch). For the first two
    check that `npx prettier@3 --stdin-filepath <f> < <f> | diff <f> - | grep -c '^[<>]'` stays at its `5688b2d` value
    (`server.js` 7, `public/styles.css` 39). `*.md`, `*.html`, `*.json` and `docs/` are in `.prettierignore`.
  - Short "why" comments, as in `lib/governance/*.js`; code lines at most 120 characters (string and regex literals
    that Prettier cannot break, UI copy in `public/*.js` and test titles' regexes may be longer, as existing ones are).
  - Commit messages: plain, imperative. **No `Co-Authored-By`, no "Generated with", no AI attribution of any kind**
    (owner rule; it overrides any harness reminder).
  - UI copy is English; strings quoted in the spec are copied verbatim.
  - CI runs on Ubuntu, macOS and Windows: test dates are built with `Date.UTC(…)`, paths with `path.join`, and
    file-mode checks are skipped on `win32`.
- **Shared files.** Small, additive edits. The existing assertions this plan changes on purpose: Task 2
  (`test/governance-auth.test.js`, `test/governance-http.test.js`: the dashboard actor gains `user` and `role`, and a
  failed owner sign-in names its target) and Task 6 (`test/governance-controls.test.js`,
  `test/governance-evidence.test.js`, `test/governance-inventory-http.test.js`: eighteen controls, the three new
  clauses, the `accounts` part of the state). The sign-in error text changes from `wrong password` to `wrong name or
  password` (no existing test reads it).

## Rules and values

**From the spec (verbatim):**

| # | Decision |
|---|---|
| R1 | Three roles. **owner**: everything (today's admin). **reviewer**: everything a viewer can, plus inventory reviews (`POST /api/governance/inventory`) and collaboration run approvals (`POST /api/gateway/collab` with `action` `get`, `list` or `resume`). **viewer**: read-only, metadata only. |
| R2 | One owner: the existing admin password (`.data/admin.json` or `ZAAFPULSE_ADMIN_PASSWORD`). It signs in as user `owner`. Extra accounts live in `.data/users.json` (mode 0600, atomic write): `{ users: [{ id, name, display, role, salt, hash, createdAt, updatedAt, disabled, mustChange, lastLoginAt }] }`. `name` matches `^[a-z0-9][a-z0-9._-]{1,31}$` and is not `owner`; `display` ≤ 60 characters; `role` is `reviewer` or `viewer`. Hashes use the same scrypt parameters as the admin password. A user password has at least 12 characters. |
| R3 | Where accounts work: **password** mode (sign-in with name and password; an empty name or `owner` means the admin password, so today's `{ password }` form keeps working) and **local** mode (the owner still signs in with `zaafpulse open`; the login page also offers name and password for accounts, for someone using this machine). In **none** mode there are no accounts: the page says so and user management is off. |
| R4 | Sessions carry `{ user, role }`. `check(req)` keeps its boolean contract; a new `sessionOf(req)` returns `{ user, role, display }` (the owner for `local` and `none`). Disabling or deleting an account, or changing its role or password, ends its sessions at once. The sign-in throttle also keeps a bucket per account name, so guessing one account's password from many addresses is slowed too. |
| R5 | **Deny by default.** A role policy in `lib/users/policy.js` (pure) decides every `/api/*` request for a non-owner from method, path and, for the gateway admin route, the body's `action`: an explicit allow-list per role. Anything not listed is `403 { error: 'your role cannot do this' }`, recorded as a refused request entry. The owner is never restricted. |
| R6 | What a viewer may read: the metadata routes (platform, summary, live, insights, topology, timeline, office, logs, mcp-calls, router, openrouter catalogue, prices, config read, trace sources/settings/sessions list/deps/find, evals summary/status/evaluators/settings, datasets and experiments lists, monitors, alerts, runtimes, cost reads incl. export and reports, governance reads incl. audit, audit export, verify, status, inventory, controls and evidence export, integrations status). Never for a non-owner: trace session/title/content/live and reveal, dataset and experiment details and exports, feedback notes, brain/vault, evals preview, integrations config, gateway `knowledge get/search`, `sessions get`, `quota`, `providers test/models`. |
| R7 | `GET /api/gateway` for a non-owner is a **redacted view** built by a pure function in the policy module: agents without `systemPrompt`, memory without text, sessions without titles, runs without task or answer text, keys without anything but name, prefix, scopes, budget and dates; providers without secret references. Reviewers additionally get collaboration runs with their text through `collab get/list` (they must read what they approve). |
| R8 | A new account is created by the owner with a password the owner sets once; `mustChange` is true, and until that user changes it (`POST /api/account/password { current, next }`) every other route answers `403 { error: 'change your password first' }`. Any signed-in person can change their own password; the owner's own password stays with `zaafpulse set-password`. |
| R9 | Audit: the dashboard actor gains `user` and `role` (`{ via: 'dashboard', user, role, mode, device, ip }`); sign-in events name the account (never the password); new entries `user.create`, `user.update` (role, display, disabled), `user.password_reset`, `user.delete`, `account.password_change`. The audit list filters by user; the CSV `actor_id` holds the user for dashboard entries. |
| R10 | Dashboard: Settings → **Users** (owner only): list (name, display, role, last sign-in, disabled), add, change role, disable/enable, reset password, delete. The topbar shows the signed-in display name and role and a sign-out link. For a non-owner: a one-line banner ("Signed in as <name> · <role> · read-only" / "… · reviews and approvals"), the Settings, Users and Rescan controls are hidden, and a 403 from any action is shown as "Your role cannot do this". The server is the authority; the page does not hide every write button. On the Inventory page the review drawer is enabled for reviewers and owner only, and its owner field suggests account display names (free text stays allowed). |
| R11 | Compliance: a new control `access_roles` — in place when sign-in is required and no account has gone unused for more than 90 days; partial when one has (an access review is due), naming the count only; off when sign-in is `none`. Clauses: EU AI Act Art. 26(2) (human oversight assigned to competent persons), NIST AI RMF GOVERN 2.1 (roles and responsibilities), ISO/IEC 42001 A.3 (internal organization). |
| R12 | Out of scope: SSO (declined by the owner), MFA, per-user notification channels, gateway API keys owned by users, a CLI for accounts. |

Error handling (spec): wrong name or password → 401 `wrong name or password` (one message for both) and the
throttle; a disabled account → 401 like a wrong password (no account enumeration); `users.json` unreadable → accounts
cannot sign in (the owner still can), the Users page says the file could not be read, no write over it; a non-owner
request outside the allow-list → 403 `your role cannot do this`, recorded as refused; `mustChange` → 403 `change your
password first` everywhere except the password route, session and logout; removing the last reviewer etc. → allowed,
there is always the owner.

**Values this plan fixes (where the spec leaves a choice):**

- **V1. The accounts file (R2).** `users[i]` exactly the R2 fields; `id` `usr_<12 hex>`; times ISO strings,
  `lastLoginAt` `null` until the first sign-in; `salt`/`hash` base64 from `hashPassword` (the algorithm and its
  parameters are `SCRYPT`, not stored per account). A file is **unreadable** when it does not parse, is not `{ users:
  [] }`, holds an entry of the wrong shape or holds a name twice; a missing file is no account. At most 200 accounts.
  The name is matched as given (the dashboard lowercases it); `display` is trimmed; a password is at most 1024
  characters. Messages (400, the first in `error`, all in `errors`): `name: 2 to 32 lowercase letters, digits, dots,
  dashes or underscores, starting with a letter or a digit`, `name: owner is the admin password`, `name: already
  taken`, `display: text of at most 60 characters`, `role: reviewer or viewer`, `password: at least 12 characters`
  (`next: …` for an account's own change), `password: at most 1024 characters`, `disabled: true or false`, `users: at
  most 200 accounts`; 404 `no such account`; 409 `users.json could not be read; nothing was written (fix or move
  .data/users.json)`.
- **V2. Sessions (R4).** `sessionOf(req, renew = true)` → `{ user, role, display, mustChange }` or `null`: `none` mode
  and a valid local cookie are the owner (`{ user: 'owner', role: 'owner', display: config.userName, mustChange:
  false }`); a session token is whoever signed in with it (checked before the local cookie). `check(req)` is
  `!!sessionOf(req)`. `endSessions(user, keepReq)` ends every session of that user but the one `keepReq` holds;
  `passwordChanged(req)` clears that session's `mustChange`. Ended: a new role, a disabled account, a reset password,
  a deleted account (all of them); the account's own password change (all but the current one). A display name, or
  enabling an account, ends nothing.
- **V3. Sign-in (R3, R4).** `POST /api/login { name?, password }`: the name is trimmed and lowercased; empty or
  `owner` is the admin password. Local mode answers a sign-in only when accounts exist; there an owner name is `400
  the owner signs in with \`zaafpulse open\` on this machine`. The answer is `{ ok: true, user, role, display,
  mustChange }`; in local mode it also clears the `zp_local` cookie, and `/auth/local` clears `zp_session`; an
  account's sign-out never revokes the local cookies. An unknown name is checked against a dummy hash (the same time
  as a wrong password). Throttle: each **account** name (not the owner) has a bucket `account:<name>` of 10 free
  failures, then 30 s doubling to 1 h, counted with the address buckets; a browser with a known-device cookie keeps
  only its own bucket (as before). `GET /api/session` adds `accounts` (sign-in on and a store), `user`, `role`,
  `display`, `mustChange`.
- **V4. Audit actor and events (R9).** `actorOf(req)` → `{ via: 'dashboard', user, role, mode, device, ip }` (`user`
  and `role` `null` before sign-in). `auth.login`, `auth.logout`, `auth.local_code` carry the account's `user` and
  `role`; `auth.login_failed` and `auth.lockout` carry `target: { type: 'user', id }` when the name is `owner` (or
  empty) or an existing account. `user.create` (`role`), `user.update` (`changes: [{ path, from, to }]` for `role`,
  `display`, `disabled`), `user.password_reset`, `user.delete` (`role`), `account.password_change`, each with `target:
  { type: 'user', id: <name> }`. A refused request is `requestEntry({ …, status: 403, always: true })`: its route,
  `op`, target, `refused`, 403, reads and read-only POSTs included.
- **V5. The policy (R5, R6, R1).** Exactly `VIEWER_READS` (Task 3) for `GET`, `REVIEWER_EXTRA` (`POST
  /api/governance/inventory`, `GET /api/users/names`, `POST /api/gateway/collab get|list|resume`) and `ANYONE` (`POST
  /api/account/password`, also while `mustChange`). A role other than the three gets nothing under `/api/`. The
  gateway admin action is the body's `action` string, read once by the gate.
- **V6. Redaction (R7).** `redactGateway` keeps only the listed top-level parts (`GATEWAY_PARTS`); agents without
  `systemPrompt`; memory without `text`; sessions without `title`; runs without `title`, `error`, and `pending` reduced
  to `{ step }`; keys with `id`, `name`, `prefix`, `scopes`, `budgetUSD`, `createdAt`, `expiresAt`, `lastUsedAt`,
  `revokedAt`; providers without `apiKey` and with `auth: { type }` only; `quota: []`. `redactTraceSessions` takes the
  `title` out of each row of `GET /api/trace/sessions`.
- **V7. The routes (R8, R10).** `GET /api/users` → `{ mode, state, users }` (`state` `ok`, `unreadable` or `off`);
  `POST /api/users` with `action` `create` (`name`, `display`, `role`, `password`), `update` (`name`, `role`,
  `display`, `disabled`), `reset` (`name`, `password`), `delete` (`name`): `400 action: create, update, reset or
  delete`, `400 <field>: not a field of <action>`; `GET /api/users/names` → `{ names }` (the owner's display name, then
  the enabled accounts' display names, sorted, the owner's not twice); `POST /api/account/password { current, next }`
  → `{ ok: true }`, `400 current: not your password`, `400 next: must differ from the current password`, `400 <field>:
  not a field`, for the owner `400 the owner's password is set with \`zaafpulse set-password\` on the server`. Without
  sign-in (`none`): `409 accounts need sign-in: ZAAFPULSE_AUTH=none has no accounts`. JSON only (415), a body that
  does not parse 400 `bad request body`, a wrong method 405.
- **V8. Audit filter and CSV (R9).** `GET /api/governance/audit?user=<name>` (`^[a-z0-9][a-z0-9._-]{1,31}$`, so
  `owner` too; else `400 user: owner or an account name`) keeps entries whose `actor.user` is that name. CSV
  `actor_id` = `actor.user` for a dashboard entry that has one, else `keyId`, `rule`, `device`, as before.
- **V9. The control (R11).** `access_roles`, title `Dashboard roles and access reviews`, link `#settings/users`, part
  `accounts` (`{ mode, state, users: [{ role, disabled, createdAt, lastLoginAt }] }`), after `sign_in`. New clauses
  `eu-26-2` (`Art. 26(2)`, `Human oversight assigned to competent persons`), `nist-gv-2.1` (`GOVERN 2.1`, `Roles and
  responsibilities documented`), `iso-a3` (`A.3`, `Internal organization`). `off` for `none` (`sign-in: no sign-in, so
  no accounts or roles`); `unknown` for an unreadable file (`users.json could not be read`); unused = an enabled
  account whose `lastLoginAt` (else `createdAt`) is more than 90 days before `now`; `partial` when any is unused,
  else `in place`. Evidence: `the owner only` or `the owner and <n> account(s) (<n> reviewer(s), <n> viewer(s))`,
  `<n> account(s) disabled`, `<n> account(s) unused for over 90 days: an access review is due`.
- **U1. Copy (R10).** Settings sub-pages `Preferences` and `Users`; Users: eyebrow `SETTINGS · USERS`, title `Users`,
  panel `Accounts` (`.data/users.json`), columns `Name`, `Display name`, `Role`, `Last sign-in`, `State` (`Active`,
  `Disabled`, `New password due`), buttons `Disable`/`Enable`, `Reset password`, `Delete`, form `Name`, `Display
  name`, `Role`, `First password`, `Add`. Banner `Signed in as <display> · <Role> · read-only` / `… · reviews and
  approvals`; top bar `<display> · <Role>`, `Change password`, `Sign out`; sidebar `<Role> · sign out`; a 403 `Your
  role cannot do this`; a non-owner on `#settings` `Settings and Users are for the owner of this dashboard.`. Sign-in
  page: `Name` (placeholder `Empty for the admin password`, local mode `Your account name`), `Password`; the change
  step `Current password`, `New password`, `New password again`, `Change password`, `Choose your own password before
  you go on: at least 12 characters.`, `The new passwords do not match.`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/users/store.js` | create | the accounts file (Task 1) |
| `lib/auth.js` | modify (shared) | `SCRYPT` export (Task 1); name sign-in, sessions with identity, the account bucket, `actorOf` (Task 2) |
| `lib/users/policy.js` | create | `allowed`, the lists, `redactGateway`, `redactTraceSessions` (Task 3) |
| `lib/users/api.js` | create | `/api/users`, `/api/users/names`, `/api/account/password` (Task 4) |
| `lib/governance/events.js` | modify (shared) | `requestEntry` `always` (Task 4) |
| `server.js` | modify (shared) | the store, the gate, the redacted views, the routes, a body read once (Task 4); the `accounts` control part (Task 6) |
| `lib/governance/audit.js`, `lib/governance/api.js` | modify (shared) | the `user` filter, the CSV `actor_id` (Task 5) |
| `lib/governance/controls.js` | modify (shared) | `access_roles` and its clauses (Task 6) |
| `public/usersview.js` | create | Settings → Users, the banner and identity text (Task 7) |
| `public/app.js`, `public/iso.js`, `public/index.html`, `public/styles.css` | modify (shared) | `ZP.me`, 403s, the top bar, the hidden controls, the route (Task 7) |
| `public/governanceview.js` | modify | the User filter and actor words (Task 5); the review drawer for reviewers (Task 7) |
| `public/login.html`, `public/login.js` | modify | the name field, the change-password step (Task 7) |
| `docs/users.md` | create | Task 8 |
| `docs/governance.md`, `docs/install.md`, `README.md` | modify | Task 8 |
| `test/users-store.test.js` | create | Task 1 |
| `test/users-auth.test.js` | create | Task 2 |
| `test/governance-auth.test.js`, `test/governance-http.test.js` | modify | the actor's new fields (Task 2) |
| `test/users-policy.test.js` | create | Task 3 |
| `test/users-api.test.js` | create | Task 4 |
| `test/users-http.test.js` | create (Task 4), modify (Tasks 5, 6) | spawned `server.js`, ports 10200–10399 |
| `test/users-audit.test.js` | create | Task 5 |
| `test/users-controls.test.js` | create | Task 6 |
| `test/governance-controls.test.js`, `test/governance-evidence.test.js`, `test/governance-inventory-http.test.js` | modify | eighteen controls (Task 6) |
| `test/users-ui.test.js` | create | Task 7 |

---
### Task 1: the accounts file

**Files:**
- Create: `lib/users/store.js`
- Modify: `lib/auth.js` (line 536)
- Test: `test/users-store.test.js` (create)

**Interfaces:**
- Consumes: `hashPassword(password, salt?) → { algo, N, r, p, keylen, salt, hash }` and `checkPassword(password, rec) →
  Promise<boolean>` from `lib/auth.js` (existing); `writePrivate(file, data)` from `lib/cost/files.js` (existing).
- Produces (`lib/auth.js`): the export `SCRYPT` (`{ N: 16384, r: 8, p: 1, keylen: 32 }`, unchanged).
- Produces (`lib/users/store.js`): `createUserStore({ file, now = Date.now, maxUsers = 200 })` → `{ list() → { state:
  'ok' | 'unreadable', users: view[] }, get(name) → view | null, names() → string[], create({ name, display?, role,
  password }) → { user: view }, update(name, { role?, display?, disabled? }) → { user: view, changed: string[] },
  resetPassword(name, password) → { user }, changePassword(name, next) → { user }, remove(name) → { user },
  verify(name, password) → Promise<view | null>, touch(name), state() → 'ok' | 'unreadable' }`; `view` = `{ id, name,
  display, role, createdAt, updatedAt, disabled, mustChange, lastLoginAt }`; a refusal throws an `Error` with `status`
  (400, 404, 409) and `errors` (V1). Also `nameError`, `displayError`, `roleError`, `passwordError(v, field)`, `NAME`,
  `ROLES` (`['reviewer', 'viewer']`), `MIN_PASSWORD` (12), `MAX_DISPLAY` (60), `MAX_USERS` (200), `UNREADABLE`.

- [ ] **Step 1: Write the failing test**

Create `test/users-store.test.js`:

```js
// Dashboard users (AI Governance 4): the accounts file (lib/users/store.js). Names, display names, roles and passwords
// are checked field by field; a password is a scrypt hash with the admin password's parameters and never comes out; the
// file is private and written whole; a file that cannot be read is never written over and lets nobody in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore, nameError, MIN_PASSWORD } = require('../lib/users/store');
const { SCRYPT } = require('../lib/auth');

const NOW = Date.UTC(2026, 10, 4, 9);
function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.data', 'users.json');
  let at = NOW;
  const store = createUserStore({ file, now: () => at, ...opts });
  return { store, file, dir, tick: (ms) => (at += ms) };
}
const PW = 'a long password 1';
const FIELDS = ['id', 'name', 'display', 'role', 'createdAt', 'updatedAt', 'disabled', 'mustChange', 'lastLoginAt'];

test('create: the view has no secret, the file holds a scrypt hash, is private, and the new account must change', async (t) => {
  const s = setup(t);
  assert.deepEqual(s.store.list(), { state: 'ok', users: [] }, 'no file yet is no account');
  const { user } = s.store.create({ name: 'ana.k', display: '  Ana K ', role: 'viewer', password: PW });
  assert.deepEqual(Object.keys(user), FIELDS);
  assert.match(user.id, /^usr_[0-9a-f]{12}$/);
  assert.deepEqual(
    [user.name, user.display, user.role, user.disabled, user.mustChange, user.lastLoginAt],
    ['ana.k', 'Ana K', 'viewer', false, true, null],
  );
  assert.equal(user.createdAt, '2026-11-04T09:00:00.000Z');
  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['users']);
  assert.equal(saved.users.length, 1);
  assert.ok(saved.users[0].salt && saved.users[0].hash);
  assert.ok(!fs.readFileSync(s.file, 'utf8').includes(PW));
  if (process.platform !== 'win32') assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(Buffer.from(saved.users[0].hash, 'base64').length, SCRYPT.keylen);
  assert.ok(!JSON.stringify(s.store.list()).includes(saved.users[0].hash));
  assert.deepEqual((await s.store.verify('ana.k', PW)).name, 'ana.k');
  assert.equal(await s.store.verify('ana.k', 'a long password 2'), null);
  assert.equal(await s.store.verify('nobody', PW), null);
  assert.equal(await s.store.verify('ana.k', 7), null);
  assert.deepEqual(s.store.names(), ['Ana K']);
});

test('create: each field is checked, the first problem is the error and all are listed; nothing is written', (t) => {
  const s = setup(t);
  const err = (input) => {
    try {
      s.store.create(input);
    } catch (e) {
      return [e.status, e.message, e.errors];
    }
    return null;
  };
  assert.deepEqual(err({ name: 'A', display: 'x'.repeat(61), role: 'owner', password: 'short' }), [
    400,
    'name: 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or a digit',
    [
      'name: 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or a digit',
      'display: text of at most 60 characters',
      'role: reviewer or viewer',
      `password: at least ${MIN_PASSWORD} characters`,
    ],
  ]);
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(err({ name: 'owner', role: 'viewer', password: PW })[1], 'name: owner is the admin password');
  assert.equal(err({ name: 'bo', role: 'viewer', password: 'x'.repeat(1025) })[1], 'password: at most 1024 characters');
  for (const ok of ['bo', 'a1', 'ana.k_2-x', 'z'.repeat(32)]) assert.equal(nameError(ok), null, ok);
  for (const bad of ['b', '.ana', '-ana', 'Ana', 'ana k', 'z'.repeat(33), 'ana/x', 7, null])
    assert.ok(nameError(bad), String(bad));
  s.store.create({ name: 'bo', role: 'reviewer', password: PW });
  assert.deepEqual(err({ name: 'bo', role: 'viewer', password: PW }), [
    400,
    'name: already taken',
    ['name: already taken'],
  ]);
  const small = setup(t, { maxUsers: 1 });
  small.store.create({ name: 'bo', role: 'reviewer', password: PW });
  assert.throws(() => small.store.create({ name: 'cy', role: 'viewer', password: PW }), /users: at most 1 accounts/);
});

test('update, reset, change and remove: what changed is named; a disabled account cannot sign in', async (t) => {
  const s = setup(t);
  s.store.create({ name: 'bo', display: 'Bo', role: 'viewer', password: PW });
  s.tick(60e3);
  assert.deepEqual(s.store.update('bo', { role: 'viewer' }).changed, []);
  const up = s.store.update('bo', { role: 'reviewer', display: 'Bo R', disabled: true });
  assert.deepEqual(up.changed, ['role', 'display', 'disabled']);
  assert.deepEqual([up.user.role, up.user.display, up.user.disabled], ['reviewer', 'Bo R', true]);
  assert.equal(up.user.updatedAt, '2026-11-04T09:01:00.000Z');
  assert.equal(await s.store.verify('bo', PW), null, 'disabled');
  assert.deepEqual(s.store.names(), []);
  assert.throws(() => s.store.update('bo', { disabled: 'yes' }), /disabled: true or false/);
  assert.throws(
    () => s.store.update('cy', { role: 'viewer' }),
    (e) => e.status === 404 && e.message === 'no such account',
  );
  s.store.update('bo', { disabled: false });
  const reset = s.store.resetPassword('bo', 'another password 3');
  assert.equal(reset.user.mustChange, true);
  assert.equal(await s.store.verify('bo', PW), null);
  assert.equal((await s.store.verify('bo', 'another password 3')).name, 'bo');
  assert.throws(() => s.store.changePassword('bo', 'short'), /next: at least 12 characters/);
  assert.equal(s.store.changePassword('bo', 'my own password 4').user.mustChange, false);
  assert.equal((await s.store.verify('bo', 'my own password 4')).mustChange, false);
  s.tick(1000);
  s.store.touch('bo');
  assert.equal(s.store.get('bo').lastLoginAt, '2026-11-04T09:01:01.000Z');
  assert.equal(s.store.remove('bo').user.name, 'bo');
  assert.equal(s.store.get('bo'), null);
  assert.throws(() => s.store.remove('bo'), /no such account/);
});

test('an unreadable file: nobody in it signs in, it is never written over, and the store says so', async (t) => {
  const s = setup(t);
  s.store.create({ name: 'bo', role: 'viewer', password: PW });
  for (const text of ['{ torn', '[]', '{"users":{}}', '{"users":[{"name":"bo"}]}']) {
    fs.writeFileSync(s.file, text);
    assert.deepEqual(s.store.list(), { state: 'unreadable', users: [] }, text);
    assert.equal(s.store.state(), 'unreadable');
    assert.equal(await s.store.verify('bo', PW), null);
    assert.throws(
      () => s.store.create({ name: 'cy', role: 'viewer', password: PW }),
      (e) => e.status === 409 && /users\.json could not be read; nothing was written/.test(e.message),
    );
    assert.throws(
      () => s.store.remove('bo'),
      (e) => e.status === 409,
    );
    s.store.touch('bo');
    assert.equal(fs.readFileSync(s.file, 'utf8'), text, 'never written over');
  }
  // The same name twice is a file someone edited by hand: unreadable too.
  const saved = setup(t);
  saved.store.create({ name: 'bo', role: 'viewer', password: PW });
  const d = JSON.parse(fs.readFileSync(saved.file, 'utf8'));
  fs.writeFileSync(saved.file, JSON.stringify({ users: [d.users[0], d.users[0]] }));
  assert.equal(saved.store.state(), 'unreadable');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/users-store.test.js`
Expected: FAIL: `Cannot find module '../lib/users/store'` (the file fails as one test).

- [ ] **Step 3: Write the store and export `SCRYPT`**

In `lib/auth.js`, replace

```js
  localLoginPage,
  hashPassword,
  checkPassword,
  isLoopback,
  clientKey,
  prefixKey,
```

with

```js
  localLoginPage,
  hashPassword,
  checkPassword,
  SCRYPT,
  isLoopback,
  clientKey,
  prefixKey,
```

Create `lib/users/store.js`:

```js
// Dashboard accounts (AI Governance 4): the people the owner lets sign in, in .data/users.json (0600, written whole and
// atomically through lib/cost/files.js writePrivate). The owner is not in the file: the admin password (lib/auth.js)
// signs in as user "owner". A password is kept as a scrypt hash with the admin password's parameters; no password,
// salt or hash ever leaves this module (view()). A file that cannot be read is never written over: nobody in it can
// sign in until it is fixed, and the owner still can.
const crypto = require('crypto');
const fs = require('fs');
const { hashPassword, checkPassword, SCRYPT } = require('../auth');
const { writePrivate } = require('../cost/files');

const NAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const ROLES = ['reviewer', 'viewer'];
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const MAX_DISPLAY = 60;
const MAX_USERS = 200;
const UNREADABLE = 'users.json could not be read; nothing was written (fix or move .data/users.json)';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (status, message, errors) => Object.assign(new Error(message), { status, errors: errors || [message] });
const isTime = (v) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));

// The 400 messages, one per field; null when the value is fine.
function nameError(name) {
  if (typeof name !== 'string' || !NAME.test(name))
    return 'name: 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or a digit';
  if (name === 'owner') return 'name: owner is the admin password';
  return null;
}
const displayError = (v) =>
  typeof v === 'string' && v.trim().length <= MAX_DISPLAY ? null : `display: text of at most ${MAX_DISPLAY} characters`;
const roleError = (v) => (ROLES.includes(v) ? null : 'role: reviewer or viewer');
function passwordError(v, field = 'password') {
  if (typeof v !== 'string' || v.length < MIN_PASSWORD) return `${field}: at least ${MIN_PASSWORD} characters`;
  if (v.length > MAX_PASSWORD) return `${field}: at most ${MAX_PASSWORD} characters`;
  return null;
}

// A stored account as the file must hold it; one that does not makes the whole file unreadable.
const validStored = (u) =>
  isObj(u) &&
  typeof u.id === 'string' &&
  !nameError(u.name) &&
  typeof u.display === 'string' &&
  ROLES.includes(u.role) &&
  typeof u.salt === 'string' &&
  typeof u.hash === 'string' &&
  typeof u.disabled === 'boolean' &&
  typeof u.mustChange === 'boolean' &&
  [u.createdAt, u.updatedAt, u.lastLoginAt].every(isTime);

// What the rest of ZAAFPulse sees of an account: never the salt or the hash.
const view = (u) => ({
  id: u.id,
  name: u.name,
  display: u.display,
  role: u.role,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
  disabled: u.disabled,
  mustChange: u.mustChange,
  lastLoginAt: u.lastLoginAt,
});

function createUserStore({ file, now = Date.now, maxUsers = MAX_USERS }) {
  const iso = () => new Date(now()).toISOString();
  // A hash to check against when there is no such account, so a wrong name takes as long as a wrong password.
  let dummy = null;
  const dummyRec = () => (dummy ||= hashPassword(crypto.randomBytes(16).toString('hex')));
  const recOf = (u) => ({ algo: 'scrypt', ...SCRYPT, salt: u.salt, hash: u.hash });
  const secretOf = (password) => {
    const { salt, hash } = hashPassword(password);
    return { salt, hash };
  };

  // { state: 'ok' | 'unreadable', users }: a missing file is no account yet.
  function read() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return e && e.code === 'ENOENT' ? { state: 'ok', users: [] } : { state: 'unreadable', users: [] };
    }
    try {
      const d = JSON.parse(text);
      if (!isObj(d) || !Array.isArray(d.users) || !d.users.every(validStored)) throw new Error('bad shape');
      if (new Set(d.users.map((u) => u.name)).size !== d.users.length) throw new Error('a name twice');
      return { state: 'ok', users: d.users };
    } catch {
      return { state: 'unreadable', users: [] };
    }
  }
  // The accounts to change, or a 409 when the file cannot be read (it is never written over).
  function writable() {
    const r = read();
    if (r.state !== 'ok') throw fail(409, UNREADABLE);
    return r.users;
  }
  const save = (users) => writePrivate(file, `${JSON.stringify({ users }, null, 2)}\n`);
  function found(users, name) {
    const u = users.find((x) => x.name === name);
    if (!u) throw fail(404, 'no such account');
    return u;
  }
  const check = (errors) => {
    const list = errors.filter(Boolean);
    if (list.length) throw fail(400, list[0], list);
  };

  return {
    // { state, users: views sorted by name }.
    list() {
      const r = read();
      return { state: r.state, users: r.users.map(view).sort((a, b) => a.name.localeCompare(b.name, 'en')) };
    },
    // The view of one account, or null (none, or the file cannot be read).
    get(name) {
      const u = read().users.find((x) => x.name === name);
      return u ? view(u) : null;
    },
    // The display names of the accounts that may sign in, sorted.
    names() {
      return read()
        .users.filter((u) => !u.disabled)
        .map((u) => u.display || u.name)
        .sort((a, b) => a.localeCompare(b, 'en'));
    },
    create(input) {
      const b = isObj(input) ? input : {};
      const display = b.display === undefined ? '' : b.display;
      check([nameError(b.name), displayError(display), roleError(b.role), passwordError(b.password)]);
      const users = writable();
      if (users.some((u) => u.name === b.name)) throw fail(400, 'name: already taken');
      if (users.length >= maxUsers) throw fail(400, `users: at most ${maxUsers} accounts`);
      const t = iso();
      const u = {
        id: `usr_${crypto.randomBytes(6).toString('hex')}`,
        name: b.name,
        display: display.trim(),
        role: b.role,
        ...secretOf(b.password),
        createdAt: t,
        updatedAt: t,
        disabled: false,
        mustChange: true,
        lastLoginAt: null,
      };
      save([...users, u]);
      return { user: view(u) };
    },
    // Changes role, display and disabled (each optional); `changed` names the fields whose value changed.
    update(name, input) {
      const b = isObj(input) ? input : {};
      check([
        b.role === undefined ? null : roleError(b.role),
        b.display === undefined ? null : displayError(b.display),
        b.disabled === undefined || typeof b.disabled === 'boolean' ? null : 'disabled: true or false',
      ]);
      const users = writable();
      const u = found(users, name);
      const next = {
        role: b.role === undefined ? u.role : b.role,
        display: b.display === undefined ? u.display : b.display.trim(),
        disabled: b.disabled === undefined ? u.disabled : b.disabled,
      };
      const changed = ['role', 'display', 'disabled'].filter((k) => next[k] !== u[k]);
      if (!changed.length) return { user: view(u), changed };
      Object.assign(u, next, { updatedAt: iso() });
      save(users);
      return { user: view(u), changed };
    },
    // The owner sets a new password: the account must change it at its next sign-in.
    resetPassword(name, password) {
      check([passwordError(password)]);
      const users = writable();
      const u = found(users, name);
      Object.assign(u, secretOf(password), { mustChange: true, updatedAt: iso() });
      save(users);
      return { user: view(u) };
    },
    // The account changes its own password (checked by the caller): mustChange ends.
    changePassword(name, next) {
      check([passwordError(next, 'next')]);
      const users = writable();
      const u = found(users, name);
      Object.assign(u, secretOf(next), { mustChange: false, updatedAt: iso() });
      save(users);
      return { user: view(u) };
    },
    remove(name) {
      const users = writable();
      const u = found(users, name);
      save(users.filter((x) => x !== u));
      return { user: view(u) };
    },
    // The view of the account when the name and password match and it may sign in, else null. A missing account is
    // checked against a hash of its own, so the time does not tell whether the name exists.
    async verify(name, password) {
      if (typeof password !== 'string' || password.length > MAX_PASSWORD) return null;
      const u = read().users.find((x) => x.name === name);
      const ok = await checkPassword(password, u ? recOf(u) : dummyRec());
      return ok && u && !u.disabled ? view(u) : null;
    },
    // A sign-in: lastLoginAt. Never fails the sign-in.
    touch(name) {
      try {
        const users = writable();
        const u = users.find((x) => x.name === name);
        if (!u) return;
        u.lastLoginAt = iso();
        save(users);
      } catch {
        /* the sign-in stands */
      }
    },
    state: () => read().state,
  };
}

module.exports = {
  createUserStore,
  nameError,
  displayError,
  roleError,
  passwordError,
  NAME,
  ROLES,
  MIN_PASSWORD,
  MAX_DISPLAY,
  MAX_USERS,
  UNREADABLE,
};
```

- [ ] **Step 4: Run the test**

Run: `node --test test/users-store.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Format**

Run: `npx prettier@3 --check lib/users/store.js lib/auth.js test/users-store.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add lib/users/store.js lib/auth.js test/users-store.test.js
git commit -m "Add the dashboard accounts store"
```

### Task 2: sign-in with a name; sessions with the account and its role

**Files:**
- Modify: `lib/auth.js` (lines 8, 36, 178, 258, 292, 399, 415, 430, 468, 504, 545, 578)
- Test: `test/governance-auth.test.js` (modify, lines 62, 133), `test/governance-http.test.js` (modify, lines 95, 295), `test/users-auth.test.js` (create)

**Interfaces:**
- Consumes: `createUserStore` (Task 1): `get(name)`, `verify(name, password)`, `touch(name)`.
- Produces (`lib/auth.js`): `createAuth({ …, accounts = null, ownerName = () => 'Owner' })` → adds `sessionOf(req,
  renew = true) → { user, role, display, mustChange } | null`, `endSessions(user, keepReq = null) → number`,
  `passwordChanged(req)`; `check(req)` is `!!sessionOf(req)`; `actorOf(req) → { via: 'dashboard', user, role, mode,
  device, ip }`; `POST /api/login { name?, password }` (V3); `GET /api/session` with `accounts`, `user`, `role`,
  `display`, `mustChange`; the events of V4. `ACCOUNT_FREE_FAILS = 10`.

- [ ] **Step 1: Write the failing tests, and give the actor in the existing tests its new fields**

In `test/governance-auth.test.js`, replace

```js
  const device = s.events[0].actor.device;
  assert.match(device, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(known.includes(device), 'the device is the id the known-device cookie carries');
  assert.deepEqual(s.events[1].actor, { via: 'dashboard', mode: 'password', device, ip: '127.0.0.1' });
  assert.deepEqual(s.events[2].actor, { via: 'dashboard', mode: 'password', device: null, ip: '127.0.0.1' });
  assert.equal(s.events[7].seconds, 30);
  const text = JSON.stringify(s.events);
  assert.ok(!text.includes('wrong') && !text.includes(PASSWORD) && !text.includes('zp_session'));
```

with

```js
  const device = s.events[0].actor.device;
  assert.match(device, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(known.includes(device), 'the device is the id the known-device cookie carries');
  const owner = { via: 'dashboard', user: 'owner', role: 'owner', mode: 'password', device, ip: '127.0.0.1' };
  assert.deepEqual(s.events[0].actor, owner);
  assert.deepEqual(s.events[1].actor, owner);
  assert.deepEqual(s.events[2].actor, {
    via: 'dashboard',
    user: null,
    role: null,
    mode: 'password',
    device: null,
    ip: '127.0.0.1',
  });
  assert.deepEqual(s.events[2].target, { type: 'user', id: 'owner' });
  assert.equal(s.events[7].seconds, 30);
  const text = JSON.stringify(s.events);
  assert.ok(!text.includes('wrong') && !text.includes(PASSWORD) && !text.includes('zp_session'));
```

In `test/governance-auth.test.js`, replace

```js
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

with

```js
      action: 'auth.local_code',
      outcome: 'ok',
      status: 200,
      actor: { via: 'dashboard', user: 'owner', role: 'owner', mode: 'local', device: null, ip: '127.0.0.1' },
    },
  ]);
  const req = { headers: { cookie: 'zp_known=x.y.z' }, socket: { remoteAddress: '::ffff:10.1.2.3' } };
  assert.deepEqual(s.auth.actorOf(req), {
    via: 'dashboard',
    user: null,
    role: null,
    mode: 'local',
    device: null,
    ip: '10.1.2.3',
  });
});

```

In `test/governance-http.test.js`, replace

```js
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
const LOCAL = { via: 'dashboard', mode: 'none', device: null, ip: '127.0.0.1' };

test('dashboard changes: one entry each, with the dashboard actor and the outcome; reads are not entries', async (t) => {
  const s = await startServer(t);
```

with

```js
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
const LOCAL = { via: 'dashboard', user: 'owner', role: 'owner', mode: 'none', device: null, ip: '127.0.0.1' };

test('dashboard changes: one entry each, with the dashboard actor and the outcome; reads are not entries', async (t) => {
  const s = await startServer(t);
```

In `test/governance-http.test.js`, replace

```js
  const device = all[0].actor.device;
  assert.ok(device);
  for (const e of all.slice(0, 4))
    assert.deepEqual(e.actor, { via: 'dashboard', mode: 'password', device, ip: '127.0.0.1' });
  assert.deepEqual(all[4].actor, { via: 'dashboard', mode: 'password', device: null, ip: '127.0.0.1' });
  assert.ok(!JSON.stringify(all).includes('nope') && !JSON.stringify(all).includes('horse'));
  assert.ok(s.alive());
});
```

with

```js
  const device = all[0].actor.device;
  assert.ok(device);
  for (const e of all.slice(0, 4))
    assert.deepEqual(e.actor, {
      via: 'dashboard',
      user: 'owner',
      role: 'owner',
      mode: 'password',
      device,
      ip: '127.0.0.1',
    });
  assert.deepEqual(all[4].actor, {
    via: 'dashboard',
    user: null,
    role: null,
    mode: 'password',
    device: null,
    ip: '127.0.0.1',
  });
  assert.ok(!JSON.stringify(all).includes('nope') && !JSON.stringify(all).includes('horse'));
  assert.ok(s.alive());
});
```

Create `test/users-auth.test.js`:

```js
// Dashboard users (AI Governance 4): sign-in with a name and a password (lib/auth.js with lib/users/store.js). The
// admin password still signs in alone ({ password }) as the owner; a session carries { user, role }; one message for a
// wrong name and a wrong password; a disabled account is refused like a wrong password; an account's sessions can be
// ended; each account name has a lockout budget of its own; in local mode accounts sign in beside `zaafpulse open`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createAuth, localLoginCode } = require('../lib/auth');
const { createUserStore } = require('../lib/users/store');

const ADMIN = 'correct-horse-battery';
const PW = 'viewer password 1';

// Drives auth.handle() without sockets: any client address, any time, any cookie.
function harness(t, { env = { ZAAFPULSE_ADMIN_PASSWORD: ADMIN }, host = '0.0.0.0', users = true } = {}) {
  let at = Date.UTC(2026, 10, 4, 9);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createUserStore({ file: path.join(dataDir, '.data', 'users.json'), now: () => at });
  const events = [];
  const auth = createAuth({
    dataDir,
    host,
    env,
    now: () => at,
    accounts: users ? store : null,
    ownerName: () => 'Rifqi',
    onEvent: (e) => events.push(e),
  });
  const reqOf = (method, p, { body, ip = '127.0.0.1', cookie } = {}) => {
    const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    return Object.assign(r, {
      method,
      url: p,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: ip },
    });
  };
  const call = async (method, p, opts = {}) => {
    const req = reqOf(method, p, opts);
    const res = {
      status: 0,
      headers: {},
      text: '',
      writeHead: (s, h) => ((res.status = s), (res.headers = h || {})),
      end: (x) => (res.text = String(x || '')),
    };
    const handled = await auth.handle(req, res, new URL(`http://x${p}`));
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      /* not JSON */
    }
    return { ...res, handled, json };
  };
  const login = (body, ip, cookie) => call('POST', '/api/login', { body, ip, cookie });
  return { auth, store, events, call, login, reqOf, dataDir, advance: (ms) => (at += ms) };
}
const cookiesOf = (res) =>
  []
    .concat(res.headers['set-cookie'] || [])
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))
    .join('; ');
const asReq = (cookie) => ({ headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } });

test('password mode: the admin password alone, or as "owner", is the owner; an account signs in with its name', async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', display: 'Bo', role: 'viewer', password: PW });
  for (const body of [{ password: ADMIN }, { name: 'owner', password: ADMIN }, { name: ' Owner ', password: ADMIN }]) {
    const r = await h.login(body);
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.deepEqual(r.json, { ok: true, user: 'owner', role: 'owner', display: 'Rifqi', mustChange: false });
    assert.deepEqual(h.auth.sessionOf(asReq(cookiesOf(r))), {
      user: 'owner',
      role: 'owner',
      display: 'Rifqi',
      mustChange: false,
    });
  }
  const r = await h.login({ name: 'Bo', password: PW });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, user: 'bo', role: 'viewer', display: 'Bo', mustChange: true });
  const req = asReq(cookiesOf(r));
  assert.equal(h.auth.check(req), true);
  assert.deepEqual(h.auth.sessionOf(req), { user: 'bo', role: 'viewer', display: 'Bo', mustChange: true });
  assert.equal(h.store.get('bo').lastLoginAt, '2026-11-04T09:00:00.000Z');
  const session = await h.call('GET', '/api/session', { cookie: cookiesOf(r) });
  assert.deepEqual(session.json, {
    required: true,
    mode: 'password',
    signedIn: true,
    configured: true,
    accounts: true,
    user: 'bo',
    role: 'viewer',
    display: 'Bo',
    mustChange: true,
  });
  const out = await h.call('GET', '/api/session');
  assert.deepEqual([out.json.signedIn, out.json.user, out.json.role, out.json.mustChange], [false, null, null, false]);
});

test('one message for a wrong name, a wrong password and a disabled account; events name an account that exists', async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  h.store.create({ name: 'cy', role: 'reviewer', password: PW });
  h.store.update('cy', { disabled: true });
  const tries = [
    [{ name: 'bo', password: 'not the password' }, '10.0.0.1'],
    [{ name: 'nobody', password: PW }, '10.0.0.2'],
    [{ name: 'cy', password: PW }, '10.0.0.3'],
    [{ password: 'not the admin password' }, '10.0.0.4'],
    [{ name: 'bo' }, '10.0.0.5'],
  ];
  for (const [body, ip] of tries) {
    const r = await h.login(body, ip);
    assert.deepEqual([r.status, r.json], [401, { error: 'wrong name or password' }], JSON.stringify(body));
  }
  assert.deepEqual(
    h.events.map((e) => [e.action, e.target || null, e.actor.user, e.actor.role]),
    [
      ['auth.login_failed', { type: 'user', id: 'bo' }, null, null],
      ['auth.login_failed', null, null, null],
      ['auth.login_failed', { type: 'user', id: 'cy' }, null, null],
      ['auth.login_failed', { type: 'user', id: 'owner' }, null, null],
      ['auth.login_failed', { type: 'user', id: 'bo' }, null, null],
    ],
  );
  const ok = await h.login({ name: 'bo', password: PW }, '10.0.0.9');
  assert.equal(ok.status, 200);
  const login = h.events[h.events.length - 1];
  assert.deepEqual(
    [login.action, login.actor.user, login.actor.role, login.actor.mode],
    ['auth.login', 'bo', 'viewer', 'password'],
  );
  assert.match(login.actor.device, /^[A-Za-z0-9_-]{16}$/);
  const text = JSON.stringify(h.events);
  assert.ok(!text.includes(PW) && !text.includes('not the password') && !text.includes('zp_session'));
  // Without accounts only the owner signs in; a name is a wrong name.
  const solo = harness(t, { users: false });
  assert.equal((await solo.login({ name: 'bo', password: PW })).status, 401);
  assert.equal((await solo.login({ password: ADMIN })).status, 200);
});

test("ending an account's sessions: all of them, or all but the one changing its password", async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  h.store.create({ name: 'cy', role: 'viewer', password: PW });
  const a = asReq(cookiesOf(await h.login({ name: 'bo', password: PW }, '10.0.0.1')));
  const b = asReq(cookiesOf(await h.login({ name: 'bo', password: PW }, '10.0.0.2')));
  const c = asReq(cookiesOf(await h.login({ name: 'cy', password: PW }, '10.0.0.3')));
  const o = asReq(cookiesOf(await h.login({ password: ADMIN }, '10.0.0.4')));
  assert.equal(h.auth.endSessions('bo', a), 1);
  assert.deepEqual([h.auth.check(a), h.auth.check(b), h.auth.check(c), h.auth.check(o)], [true, false, true, true]);
  h.auth.passwordChanged(a);
  assert.equal(h.auth.sessionOf(a).mustChange, false);
  assert.equal(h.auth.endSessions('bo'), 1);
  assert.equal(h.auth.sessionOf(a), null);
  assert.equal(h.auth.endSessions('owner'), 1);
  assert.equal(h.auth.check(o), false);
  // A session still ends when idle, as before.
  h.advance(12 * 3600e3 + 1);
  assert.equal(h.auth.check(c), false);
});

test('each account has its own lockout budget across addresses; the owner and a known browser are not locked out', async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  const first = await h.login({ name: 'bo', password: PW }, '198.51.100.7');
  const known = cookiesOf(first)
    .split('; ')
    .find((c) => c.startsWith('zp_known='));
  // Ten addresses, one wrong guess each: no address is locked, the account is.
  for (let a = 1; a <= 10; a++)
    assert.equal((await h.login({ name: 'bo', password: 'x' }, `203.0.113.${a}`)).status, 401);
  assert.equal((await h.login({ name: 'bo', password: PW }, '192.0.2.50')).status, 429, 'a fresh address must wait');
  assert.equal((await h.login({ name: 'bo', password: PW }, '192.0.2.51', known)).status, 200, 'the known browser');
  assert.equal((await h.login({ password: ADMIN }, '192.0.2.52')).status, 200, 'the owner');
  h.advance(31e3);
  assert.equal((await h.login({ name: 'bo', password: PW }, '192.0.2.53')).status, 200, 'after the wait');
});

test('local mode: accounts sign in with a name, the owner with `zaafpulse open`; neither sign-out ends the other', async (t) => {
  const h = harness(t, { env: { ZAAFPULSE_AUTH: 'local' }, host: '127.0.0.1' });
  h.store.create({ name: 'bo', role: 'reviewer', password: PW });
  for (const body of [{ password: 'anything at all' }, { name: 'owner', password: 'anything at all' }]) {
    const r = await h.login(body);
    assert.deepEqual([r.status, r.json.error], [400, 'the owner signs in with `zaafpulse open` on this machine']);
  }
  const code = localLoginCode(h.dataDir);
  const opened = await h.call('GET', `/auth/local?code=${code}`);
  assert.equal(opened.status, 200);
  const local = cookiesOf(opened);
  assert.match(local, /^zp_local=/);
  assert.equal(h.auth.sessionOf(asReq(local)).role, 'owner');
  // An account signs in in this browser: the owner's local cookie is cleared there.
  const r = await h.login({ name: 'bo', password: PW }, '127.0.0.1', local);
  assert.equal(r.status, 200);
  assert.ok([].concat(r.headers['set-cookie']).some((c) => /^zp_local=;/.test(c)));
  const bo = cookiesOf(r);
  assert.deepEqual(h.auth.sessionOf(asReq(bo)), { user: 'bo', role: 'reviewer', display: 'bo', mustChange: true });
  // The account signs out: the owner's local cookies (in other browsers) stay valid.
  assert.equal((await h.call('POST', '/api/logout', { body: {}, cookie: bo })).status, 200);
  assert.equal(h.auth.check(asReq(bo)), false);
  assert.equal(h.auth.check(asReq(local)), true);
  // A local sign-in ends an account's session in that browser.
  const again = await h.login({ name: 'bo', password: PW });
  const both = `${cookiesOf(again)}; ${local}`;
  const code2 = localLoginCode(h.dataDir);
  const o = await h.call('GET', `/auth/local?code=${code2}`, { cookie: both });
  assert.ok([].concat(o.headers['set-cookie']).some((c) => /^zp_session=;/.test(c)));
  assert.equal(h.auth.check(asReq(cookiesOf(again))), false);
  // Without accounts, local mode has no sign-in route at all (as before).
  const solo = harness(t, { env: { ZAAFPULSE_AUTH: 'local' }, host: '127.0.0.1', users: false });
  assert.equal((await solo.login({ name: 'bo', password: PW })).handled, false);
});

test('none mode: everyone is the owner, and there is no sign-in', async (t) => {
  const h = harness(t, { env: { ZAAFPULSE_AUTH: 'none' }, host: '127.0.0.1' });
  assert.deepEqual(h.auth.sessionOf(asReq('')), { user: 'owner', role: 'owner', display: 'Rifqi', mustChange: false });
  assert.equal((await h.login({ name: 'bo', password: PW })).handled, false);
  const s = await h.call('GET', '/api/session');
  assert.deepEqual([s.json.required, s.json.accounts, s.json.user, s.json.role], [false, false, 'owner', 'owner']);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/users-auth.test.js test/governance-auth.test.js test/governance-http.test.js`
Expected: FAIL: 12 of 20: all 6 in `test/users-auth.test.js` (no `accounts`, no `sessionOf`, the old error text), 2 of 4 in `test/governance-auth.test.js` and 4 of 10 in `test/governance-http.test.js` (the actor has no `user` or `role`, a failed owner sign-in no target).

- [ ] **Step 3: Sign-in with a name, sessions with identity, the account bucket**

In `lib/auth.js`, replace

```js
//   password  server mode (any host but 127.0.0.1), a reverse proxy or public URL, or ZAAFPULSE_AUTH=1:
//             one admin password, ZAAFPULSE_ADMIN_PASSWORD (or ..._FILE) or a scrypt hash saved by
//             `zaafpulse set-password`. Sessions are random tokens in memory.
// The gateway (/v1, /mcp, /a2a) keeps its own API keys; this guards the dashboard and its /api.
const crypto = require('crypto');
const fs = require('fs');
```

with

```js
//   password  server mode (any host but 127.0.0.1), a reverse proxy or public URL, or ZAAFPULSE_AUTH=1:
//             one admin password, ZAAFPULSE_ADMIN_PASSWORD (or ..._FILE) or a scrypt hash saved by
//             `zaafpulse set-password`. Sessions are random tokens in memory.
// Accounts (lib/users/store.js, AI Governance 4): in password and local mode the owner's other people sign in with a
// name and a password; a session then carries { user, role }. The admin password signs in as user "owner" (an empty
// name keeps today's { password } sign-in working); in local mode the owner still uses `zaafpulse open`.
// The gateway (/v1, /mcp, /a2a) keeps its own API keys; this guards the dashboard and its /api.
const crypto = require('crypto');
const fs = require('fs');
```

In `lib/auth.js`, replace

```js
const PREFIX_FREE_FAILS = 20;
const PRESSURE_FREE_FAILS = 1;
const PRESSURE_PREFIX_FREE_FAILS = 4;
const LOCK_BASE_MS = 30e3;
const LOCK_MAX_MS = 3600e3;
const FAIL_MEMORY_MS = 24 * 3600e3; // a quiet day forgets an address's failures
```

with

```js
const PREFIX_FREE_FAILS = 20;
const PRESSURE_FREE_FAILS = 1;
const PRESSURE_PREFIX_FREE_FAILS = 4;
// Each account name (not the owner) has a budget of its own, so guessing one account's password from many addresses is
// slowed too. A browser that signed in before (zp_known) keeps only its own budget, so such guessing never locks a
// person out there.
const ACCOUNT_FREE_FAILS = 10;
const LOCK_BASE_MS = 30e3;
const LOCK_MAX_MS = 3600e3;
const FAIL_MEMORY_MS = 24 * 3600e3; // a quiet day forgets an address's failures
```

In `lib/auth.js`, replace

```js
  headers = () => ({}),
  // Sign-in events for the governance audit log (server.js): { action, outcome, status, actor, … }.
  onEvent = () => {},
}) {
  const dir = path.join(dataDir, '.data');
  const file = path.join(dir, 'admin.json');
  const mode = pickMode({ host, env, platform, users, demo });
  const trustProxy = env.ZAAFPULSE_TRUST_PROXY === '1';
  const sessions = new Map(); // token -> { exp, max }
  const fails = new Map(); // address, /56 or device -> { n, last }
  const inflight = new Set(); // clients with a sign-in being checked
  let recentFails = []; // times of recent failures from any address
```

with

```js
  headers = () => ({}),
  // Sign-in events for the governance audit log (server.js): { action, outcome, status, actor, … }.
  onEvent = () => {},
  // The accounts (lib/users/store.js createUserStore), or null: then only the owner signs in.
  accounts = null,
  // The owner's display name (config.json userName).
  ownerName = () => 'Owner',
}) {
  const dir = path.join(dataDir, '.data');
  const file = path.join(dir, 'admin.json');
  const mode = pickMode({ host, env, platform, users, demo });
  const trustProxy = env.ZAAFPULSE_TRUST_PROXY === '1';
  const sessions = new Map(); // token -> { exp, max, user, role, display, mustChange }
  const fails = new Map(); // address, /56 or device -> { n, last }
  const inflight = new Set(); // clients with a sign-in being checked
  let recentFails = []; // times of recent failures from any address
```

In `lib/auth.js`, replace

```js
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
  // One sign-in event; a listener or an actor that throws never changes the answer. actorExtra overrides fields of
  // the request's actor (the device a sign-in just made).
  const emit = (req, action, outcome, extra = {}, actorExtra = {}) => {
```

with

```js
    const p = verify('known', v, 2);
    return p && Number(p[1]) >= now() ? p[0] : null;
  };
  // Who a dashboard request comes from, for the governance audit log (lib/governance/context.js): the account and its
  // role (null before sign-in), the sign-in mode, the browser's known-device id in password mode (null otherwise) and
  // the address as the lockouts count it.
  const actorOf = (req) => {
    const who = sessionOf(req, false);
    return {
      via: 'dashboard',
      user: who ? who.user : null,
      role: who ? who.role : null,
      mode,
      device: mode === 'password' ? knownDevice(cookieOf(req, KNOWN_COOKIE)) : null,
      ip: clientKey(req, trustProxy),
    };
  };
  // One sign-in event; a listener or an actor that throws never changes the answer. actorExtra overrides fields of
  // the request's actor (the device a sign-in just made).
  const emit = (req, action, outcome, extra = {}, actorExtra = {}) => {
```

In `lib/auth.js`, replace

```js
  const setCookie = (req, name, value, maxAgeMs) =>
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure(req) ? '; Secure' : ''}`;

  function check(req) {
    if (mode === 'none') return true;
    if (mode === 'local') return validLocal(cookieOf(req, LOCAL_COOKIE));
    const t = cookieOf(req, COOKIE);
    const s = t && sessions.get(t);
    if (!s || s.exp < now() || s.max < now()) {
      if (s) sessions.delete(t);
      return false;
    }
    s.exp = Math.min(s.max, now() + SESSION_MS);
    return true;
  }

  async function body(req) {
```

with

```js
  const setCookie = (req, name, value, maxAgeMs) =>
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure(req) ? '; Secure' : ''}`;

  const ownerDisplay = () => {
    try {
      return String(ownerName() || 'Owner').slice(0, 60);
    } catch {
      return 'Owner';
    }
  };
  const owner = () => ({ user: 'owner', role: 'owner', display: ownerDisplay(), mustChange: false });
  // Who signed in: { user, role, display, mustChange }, or null. No sign-in (none) and a local cookie are the owner; a
  // session token is whoever signed in with it. A session in use is renewed (renew = false only looks).
  function sessionOf(req, renew = true) {
    if (mode === 'none') return owner();
    const t = cookieOf(req, COOKIE);
    const s = t && sessions.get(t);
    if (s && (s.exp < now() || s.max < now())) sessions.delete(t);
    else if (s) {
      if (renew) s.exp = Math.min(s.max, now() + SESSION_MS);
      return s.user === 'owner'
        ? owner()
        : { user: s.user, role: s.role, display: s.display, mustChange: s.mustChange };
    }
    if (mode === 'local' && validLocal(cookieOf(req, LOCAL_COOKIE))) return owner();
    return null;
  }
  const check = (req) => !!sessionOf(req);
  // Ends every session of an account (disabled, deleted, a new role or password), but the one `keep` holds (the request
  // of someone changing their own password). Returns how many ended.
  function endSessions(user, keep = null) {
    const kept = keep ? cookieOf(keep, COOKIE) : null;
    let n = 0;
    for (const [t, s] of sessions)
      if (s.user === user && t !== kept) {
        sessions.delete(t);
        n++;
      }
    return n;
  }
  // The session of this request no longer has to change its password.
  function passwordChanged(req) {
    const s = sessions.get(cookieOf(req, COOKIE));
    if (s) s.mustChange = false;
  }

  async function body(req) {
```

In `lib/auth.js`, replace

```js
  async function login(req, res) {
    if (!(req.headers['content-type'] || '').startsWith('application/json'))
      return json(res, 415, { error: 'json only' });
    const who = clientKey(req, trustProxy);
    // A browser that signed in before is throttled on its own, so guessing from its address (a shared
    // NAT, say) or from everywhere at once cannot lock its owner out.
```

with

```js
  async function login(req, res) {
    if (!(req.headers['content-type'] || '').startsWith('application/json'))
      return json(res, 415, { error: 'json only' });
    const { name: rawName, password } = await body(req);
    // No name, or "owner", is the admin password: the { password } sign-in of before.
    const name = typeof rawName === 'string' ? rawName.trim().toLowerCase().slice(0, 64) : '';
    const isOwner = !name || name === 'owner';
    if (isOwner && mode === 'local')
      return json(res, 400, { error: 'the owner signs in with `zaafpulse open` on this machine' });
    const who = clientKey(req, trustProxy);
    // A browser that signed in before is throttled on its own, so guessing from its address (a shared
    // NAT, say) or from everywhere at once cannot lock its owner out.
```

In `lib/auth.js`, replace

```js
      : [
          [who, pressure ? PRESSURE_FREE_FAILS : FREE_FAILS],
          [prefixKey(who), pressure ? PRESSURE_PREFIX_FREE_FAILS : PREFIX_FREE_FAILS],
        ].filter(([k]) => k);
    const wait = Math.max(0, ...limits.map(([k, free]) => lockedUntil(bucket(k), free)));
    if (wait > now()) {
```

with

```js
      : [
          [who, pressure ? PRESSURE_FREE_FAILS : FREE_FAILS],
          [prefixKey(who), pressure ? PRESSURE_PREFIX_FREE_FAILS : PREFIX_FREE_FAILS],
          // The owner has no such budget: a flood of guesses must never lock the owner out of a fresh browser.
          ...(isOwner ? [] : [[`account:${name}`, ACCOUNT_FREE_FAILS]]),
        ].filter(([k]) => k);
    const wait = Math.max(0, ...limits.map(([k, free]) => lockedUntil(bucket(k), free)));
    if (wait > now()) {
```

In `lib/auth.js`, replace

```js
    }
    const slot = limits[0][0];
    if (inflight.has(slot)) return json(res, 429, { error: 'one sign-in at a time' }, { 'retry-after': '1' });
    const rec = record();
    if (!rec) return json(res, 503, { error: 'no admin password is set; run `zaafpulse set-password` on the server' });
    // Count the attempt as a failure before checking, so parallel guesses cannot all slip through.
    for (const [k] of limits) fails.set(k, { n: (bucket(k) || { n: 0 }).n + 1, last: now() });
    recentFails.push(now());
    if (fails.size > MAX_TRACKED) for (const k of [...fails.keys()].slice(0, fails.size - MAX_TRACKED)) fails.delete(k);
    inflight.add(slot);
    try {
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
      inflight.delete(slot);
```

with

```js
    }
    const slot = limits[0][0];
    if (inflight.has(slot)) return json(res, 429, { error: 'one sign-in at a time' }, { 'retry-after': '1' });
    const rec = isOwner ? record() : null;
    if (isOwner && !rec)
      return json(res, 503, { error: 'no admin password is set; run `zaafpulse set-password` on the server' });
    // A failure names the account it was for only when there is one (no name that was never an account is kept).
    const target =
      isOwner || (accounts && accounts.get(name)) ? { target: { type: 'user', id: isOwner ? 'owner' : name } } : {};
    // Count the attempt as a failure before checking, so parallel guesses cannot all slip through.
    for (const [k] of limits) fails.set(k, { n: (bucket(k) || { n: 0 }).n + 1, last: now() });
    recentFails.push(now());
    if (fails.size > MAX_TRACKED) for (const k of [...fails.keys()].slice(0, fails.size - MAX_TRACKED)) fails.delete(k);
    inflight.add(slot);
    let account = null;
    try {
      if (typeof password === 'string' && !isOwner && accounts) account = await accounts.verify(name, password);
      const ok = isOwner ? typeof password === 'string' && (await checkPassword(password, rec)) : !!account;
      if (!ok) {
        emit(req, 'auth.login_failed', 'refused', { status: 401, ...target });
        // The failure that starts a lockout is an entry of its own; the refusals during it are not (a flood of them
        // would bury everything else).
        const until = Math.max(0, ...limits.map(([k, free]) => lockedUntil(bucket(k), free)));
        if (until > now())
          emit(req, 'auth.lockout', 'refused', {
            status: 429,
            seconds: Math.ceil((until - now()) / 1000),
            ...target,
          });
        return json(res, 401, { error: 'wrong name or password' });
      }
    } finally {
      inflight.delete(slot);
```

In `lib/auth.js`, replace

```js
      if (b && --b.n <= 0) fails.delete(k);
    }
    recentFails.pop();
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { exp: now() + SESSION_MS, max: now() + SESSION_MAX_MS });
    const id = device || crypto.randomBytes(12).toString('base64url');
    emit(req, 'auth.login', 'ok', { status: 200 }, { device: id });
    return json(
      res,
      200,
      { ok: true },
      {
        'set-cookie': [
          setCookie(req, COOKIE, token, SESSION_MS),
          setCookie(req, KNOWN_COOKIE, sign('known', id, now() + KNOWN_MS), KNOWN_MS),
        ],
      },
    );
```

with

```js
      if (b && --b.n <= 0) fails.delete(k);
    }
    recentFails.pop();
    const me = isOwner
      ? owner()
      : {
          user: account.name,
          role: account.role,
          display: account.display || account.name,
          mustChange: account.mustChange,
        };
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { exp: now() + SESSION_MS, max: now() + SESSION_MAX_MS, ...me });
    if (!isOwner) accounts.touch(account.name);
    const id = device || crypto.randomBytes(12).toString('base64url');
    emit(
      req,
      'auth.login',
      'ok',
      { status: 200 },
      { user: me.user, role: me.role, ...(mode === 'password' ? { device: id } : {}) },
    );
    return json(
      res,
      200,
      { ok: true, ...me },
      {
        'set-cookie': [
          setCookie(req, COOKIE, token, SESSION_MS),
          setCookie(req, KNOWN_COOKIE, sign('known', id, now() + KNOWN_MS), KNOWN_MS),
          // In local mode an account's sign-in replaces the owner's local cookie in this browser.
          ...(mode === 'local' ? [setCookie(req, LOCAL_COOKIE, '', 0)] : []),
        ],
      },
    );
```

In `lib/auth.js`, replace

```js

  // /api/session, /api/login, /api/logout and /auth/local. Returns true when it answered.
  async function handle(req, res, url) {
    if (url.pathname === '/api/session')
      return (
        json(res, 200, {
          required: mode !== 'none',
          mode,
          signedIn: check(req),
          configured: mode !== 'password' || !!record(),
        }),
        true
      );
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      // JSON only, like every other change: another site cannot sign the owner out with a plain form.
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return (json(res, 415, { error: 'json only' }), true);
      // Signing out of local mode revokes every local cookie (only a signed-in browser may do that). Only a request
      // that held a session is an event: anyone may call this, and a flood of them is no change.
      const had = check(req);
      if (mode === 'local' && had) revokeLocal();
      sessions.delete(cookieOf(req, COOKIE));
      if (had) emit(req, 'auth.logout', 'ok', { status: 200 });
      json(
        res,
        200,
```

with

```js

  // /api/session, /api/login, /api/logout and /auth/local. Returns true when it answered.
  async function handle(req, res, url) {
    if (url.pathname === '/api/session') {
      const who = sessionOf(req);
      return (
        json(res, 200, {
          required: mode !== 'none',
          mode,
          signedIn: !!who,
          configured: mode !== 'password' || !!record(),
          accounts: mode !== 'none' && !!accounts,
          user: who ? who.user : null,
          role: who ? who.role : null,
          display: who ? who.display : null,
          mustChange: who ? who.mustChange : false,
        }),
        true
      );
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      // JSON only, like every other change: another site cannot sign the owner out with a plain form.
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return (json(res, 415, { error: 'json only' }), true);
      // Signing out of local mode revokes every local cookie (only a signed-in browser may do that). Only a request
      // that held a session is an event: anyone may call this, and a flood of them is no change.
      const had = sessionOf(req, false);
      // Only the owner's sign-out revokes the local cookies; an account's ends its own session.
      if (mode === 'local' && had && had.role === 'owner') revokeLocal();
      sessions.delete(cookieOf(req, COOKIE));
      if (had) emit(req, 'auth.logout', 'ok', { status: 200 }, { user: had.user, role: had.role });
      json(
        res,
        200,
```

In `lib/auth.js`, replace

```js
        res.writeHead(302, { location: '/login.html?expired=1', ...securityHeaders() });
        return (res.end(), true);
      }
      emit(req, 'auth.local_code', 'ok', { status: 200 });
      // A page that moves on to the dashboard, not a redirect: the browser came here from a local file,
      // and a SameSite=Strict cookie is not sent on a redirect that another origin started.
      res.writeHead(200, {
        ...securityHeaders(),
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': setCookie(req, LOCAL_COOKIE, sign('local', now() + LOCAL_MS, generation()), LOCAL_MS),
      });
      res.end(
        '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>ZAAFPulse</title><a href="/">Open ZAAFPulse</a>',
      );
      return true;
    }
    if (url.pathname === '/api/login' && req.method === 'POST' && mode === 'password')
      return (await login(req, res), true);
    return false;
  }
```

with

```js
        res.writeHead(302, { location: '/login.html?expired=1', ...securityHeaders() });
        return (res.end(), true);
      }
      emit(req, 'auth.local_code', 'ok', { status: 200 }, { user: 'owner', role: 'owner' });
      // An account's session in this browser ends: from here on it is the owner's.
      sessions.delete(cookieOf(req, COOKIE));
      // A page that moves on to the dashboard, not a redirect: the browser came here from a local file,
      // and a SameSite=Strict cookie is not sent on a redirect that another origin started.
      res.writeHead(200, {
        ...securityHeaders(),
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': [
          setCookie(req, LOCAL_COOKIE, sign('local', now() + LOCAL_MS, generation()), LOCAL_MS),
          setCookie(req, COOKIE, '', 0),
        ],
      });
      res.end(
        '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>ZAAFPulse</title><a href="/">Open ZAAFPulse</a>',
      );
      return true;
    }
    // Local mode signs in accounts only (the owner uses `zaafpulse open`), so only when there are accounts.
    if (
      url.pathname === '/api/login' &&
      req.method === 'POST' &&
      (mode === 'password' || (mode === 'local' && accounts))
    )
      return (await login(req, res), true);
    return false;
  }
```

In `lib/auth.js`, replace

```js
    mode,
    required: mode !== 'none',
    check,
    handle,
    actorOf,
    configured: () => mode !== 'password' || !!record(),
```

with

```js
    mode,
    required: mode !== 'none',
    check,
    sessionOf,
    endSessions,
    passwordChanged,
    handle,
    actorOf,
    configured: () => mode !== 'password' || !!record(),
```

- [ ] **Step 4: Run the tests, the old sign-in tests included**

Run: `node --test test/users-auth.test.js test/governance-auth.test.js test/governance-http.test.js test/signin.test.js test/security.test.js`
Expected: PASS (48 tests).

- [ ] **Step 5: Format**

Run: `npx prettier@3 --check lib/auth.js test/users-auth.test.js test/governance-auth.test.js test/governance-http.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add lib/auth.js test/users-auth.test.js test/governance-auth.test.js test/governance-http.test.js
git commit -m "Sign in to the dashboard with a name and a password; sessions carry the account and its role"
```

### Task 3: the role policy and the redacted views

**Files:**
- Create: `lib/users/policy.js`
- Test: `test/users-policy.test.js` (create)

**Interfaces:**
- Consumes: nothing (pure).
- Produces (`lib/users/policy.js`): `allowed({ role, method, path, action = null, mustChange = false }) → { ok, reason
  }` (`reason` `your role cannot do this` or `change your password first`; V5), `redactGateway(payload, role)` and
  `redactTraceSessions(body, role)` (V6), `ROLES`, `VIEWER_READS`, `REVIEWER_EXTRA`, `ANYONE`, `GATEWAY_PARTS`,
  `KEY_FIELDS`, `DENIED`, `MUST_CHANGE`.

- [ ] **Step 1: Write the failing test: a table of every route class**

Create `test/users-policy.test.js`:

```js
// Dashboard users (AI Governance 4): the role policy (lib/users/policy.js), pure. A table of every route class: what a
// viewer may read, what is never shown to anyone but the owner (content, secrets, previews), the writes, a reviewer's
// extra routes, the password route and the mustChange gate; every route a viewer may read exists; and the redacted
// gateway view keeps no system prompt, note text, session title, run task, key secret or secret reference.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  allowed,
  redactGateway,
  redactTraceSessions,
  VIEWER_READS,
  REVIEWER_EXTRA,
  GATEWAY_PARTS,
} = require('../lib/users/policy');

const ROOT = path.join(__dirname, '..');
const may = (role, method, p, action, mustChange = false) => allowed({ role, method, path: p, action, mustChange });

test('a viewer reads the metadata routes, a reviewer too; the list is exactly these', () => {
  assert.deepEqual(VIEWER_READS, [
    '/api/platform',
    '/api/summary',
    '/api/live',
    '/api/insights',
    '/api/topology',
    '/api/timeline',
    '/api/office',
    '/api/logs',
    '/api/mcp-calls',
    '/api/router',
    '/api/openrouter',
    '/api/openrouter/endpoints',
    '/api/config',
    '/api/prices',
    '/api/trace/sources',
    '/api/trace/settings',
    '/api/trace/sessions',
    '/api/trace/deps',
    '/api/trace/find',
    '/api/evals/summary',
    '/api/evals/status',
    '/api/evals/evaluators',
    '/api/evals/settings',
    '/api/datasets',
    '/api/datasets/settings',
    '/api/experiments',
    '/api/monitors',
    '/api/monitors/status',
    '/api/alerts',
    '/api/agents/candidates',
    '/api/runtimes',
    '/api/runtimes/config',
    '/api/cost/ledger',
    '/api/cost/export',
    '/api/cost/status',
    '/api/cost/settings',
    '/api/cost/restates',
    '/api/cost/prices/versions',
    '/api/cost/view',
    '/api/cost/report',
    '/api/cost/budgets',
    '/api/governance/audit',
    '/api/governance/audit/export',
    '/api/governance/audit/verify',
    '/api/governance/audit/status',
    '/api/governance/inventory',
    '/api/governance/controls',
    '/api/governance/evidence',
    '/api/integrations',
    '/api/gateway',
    '/api/gateway/logs',
  ]);
  for (const p of VIEWER_READS)
    for (const role of ['viewer', 'reviewer']) {
      assert.deepEqual(may(role, 'GET', p), { ok: true, reason: null }, `${role} GET ${p}`);
      // The same path written to is a change: refused (but a reviewer's inventory review, below).
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
        if (!(role === 'reviewer' && `${m} ${p}` === 'POST /api/governance/inventory'))
          assert.equal(may(role, m, p).ok, false, `${role} ${m} ${p}`);
    }
});

test('every route a viewer may read is a route the server answers', () => {
  const src = [
    'server.js',
    'lib/evals/api.js',
    'lib/datasets/api.js',
    'lib/monitors/api.js',
    'lib/runtimes/api.js',
    'lib/cost/api.js',
    'lib/governance/api.js',
  ]
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
  // Routes built from a word: the trace routes, the request log and the datasets' settings.
  const word = {
    '/api/trace/': (w) =>
      src.includes(`'sources', 'settings', 'sessions', 'session', 'title', 'content', 'reveal'`) &&
      src.includes(`'${w}'`),
    '/api/gateway/': (w) => src.includes(`gwAdmin[1] === '${w}'`),
    '/api/datasets/': (w) => src.includes(`a === '${w}'`),
  };
  for (const p of VIEWER_READS) {
    const prefix = Object.keys(word).find((x) => p.startsWith(x));
    assert.ok(prefix ? word[prefix](p.slice(prefix.length)) : src.includes(`'${p}'`), p);
  }
});

test('never for a non-owner: content, secrets and previews; every write; the owner is never refused', () => {
  const ownerOnly = [
    ['GET', '/api/trace/session'],
    ['GET', '/api/trace/title'],
    ['GET', '/api/trace/content'],
    ['GET', '/api/trace/live'],
    ['POST', '/api/trace/reveal'],
    ['GET', '/api/evals'],
    ['GET', '/api/feedback'],
    ['GET', '/api/feedback/sessions'],
    ['POST', '/api/feedback'],
    ['POST', '/api/evals/preview'],
    ['POST', '/api/evals/run'],
    ['POST', '/api/evals/settings'],
    ['GET', '/api/datasets/ds_1'],
    ['GET', '/api/datasets/ds_1/export'],
    ['POST', '/api/datasets'],
    ['POST', '/api/datasets/import'],
    ['PUT', '/api/datasets/ds_1'],
    ['DELETE', '/api/datasets/ds_1'],
    ['GET', '/api/experiments/exp_1'],
    ['POST', '/api/experiments'],
    ['GET', '/api/brain'],
    ['GET', '/api/brain/graph'],
    ['POST', '/api/brain/sources', 'test'],
    ['GET', '/api/vault'],
    ['GET', '/api/integrations/config'],
    ['POST', '/api/integrations/test'],
    ['POST', '/api/integrations/test-draft'],
    ['POST', '/api/integrations/save'],
    ['POST', '/api/integrations/delete'],
    ['POST', '/api/gateway/knowledge', 'get'],
    ['POST', '/api/gateway/knowledge', 'search'],
    ['POST', '/api/gateway/sessions', 'get'],
    ['POST', '/api/gateway/quota'],
    ['POST', '/api/gateway/providers', 'test'],
    ['POST', '/api/gateway/providers', 'models'],
    ['POST', '/api/gateway/logs'],
    ['POST', '/api/gateway/keys', 'create'],
    ['POST', '/api/gateway/settings'],
    ['POST', '/api/gateway/playground'],
    ['POST', '/api/gateway/collab', 'start'],
    ['POST', '/api/gateway/collab', 'cancel'],
    ['POST', '/api/cost/settings/preview'],
    ['POST', '/api/cost/restate/preview'],
    ['POST', '/api/cost/budgets'],
    ['POST', '/api/config'],
    ['POST', '/api/prices', 'refresh'],
    ['POST', '/api/governance/settings'],
    ['POST', '/api/monitors/tool_loop'],
    ['POST', '/api/monitors/channels'],
    ['POST', '/api/agents/pause'],
    ['POST', '/api/runtimes/start'],
    ['POST', '/api/rescan'],
    ['POST', '/api/mcp/register'],
    ['GET', '/api/users'],
    ['POST', '/api/users', 'create'],
    ['GET', '/api/something-new'],
  ];
  for (const [m, p, action] of ownerOnly) {
    for (const role of ['viewer', 'reviewer'])
      assert.deepEqual(may(role, m, p, action), { ok: false, reason: 'your role cannot do this' }, `${role} ${m} ${p}`);
    assert.equal(may('owner', m, p, action).ok, true);
  }
  // A role that is not one of the three, or none, gets nothing from /api; the page itself is not /api.
  for (const role of [undefined, null, 'admin', 'OWNER'])
    assert.deepEqual(may(role, 'GET', '/api/summary'), { ok: false, reason: 'your role cannot do this' });
  assert.equal(may('viewer', 'GET', '/index.html').ok, true);
  assert.equal(may('viewer', 'GET', '/api').ok, true, '"/api" alone is a file path, not an /api route');
});

test("a reviewer's extras: inventory reviews and run approvals (get, list, resume); a viewer has none of them", () => {
  assert.deepEqual(REVIEWER_EXTRA, [
    'POST /api/governance/inventory',
    'GET /api/users/names',
    'POST /api/gateway/collab get',
    'POST /api/gateway/collab list',
    'POST /api/gateway/collab resume',
  ]);
  const extras = [
    ['POST', '/api/governance/inventory'],
    ['GET', '/api/users/names'],
    ['POST', '/api/gateway/collab', 'get'],
    ['POST', '/api/gateway/collab', 'list'],
    ['POST', '/api/gateway/collab', 'resume'],
  ];
  for (const [m, p, action] of extras) {
    assert.equal(may('reviewer', m, p, action).ok, true, `reviewer ${m} ${p} ${action || ''}`);
    assert.equal(may('viewer', m, p, action).ok, false, `viewer ${m} ${p} ${action || ''}`);
  }
  // The action must be the word itself: no other route, no other spelling.
  for (const action of [undefined, null, 'Resume', 'resume ', ['resume'], 'resume\nx'])
    assert.equal(may('reviewer', 'POST', '/api/gateway/collab', action).ok, false, JSON.stringify(action));
  assert.equal(may('reviewer', 'POST', '/api/gateway/keys', 'get').ok, false);
  assert.equal(may('reviewer', 'GET', '/api/gateway/collab', 'get').ok, false);
});

test('the password route is for anyone signed in; until then every other route says "change your password first"', () => {
  for (const role of ['owner', 'reviewer', 'viewer']) {
    assert.equal(may(role, 'POST', '/api/account/password').ok, true);
    assert.equal(may(role, 'POST', '/api/account/password', null, true).ok, true);
    assert.equal(may(role, 'GET', '/api/account/password').ok, role === 'owner');
  }
  for (const role of ['reviewer', 'viewer']) {
    assert.deepEqual(may(role, 'GET', '/api/summary', null, true), { ok: false, reason: 'change your password first' });
    assert.deepEqual(may(role, 'POST', '/api/gateway/collab', 'get', true).reason, 'change your password first');
  }
  assert.equal(may('nobody', 'POST', '/api/account/password').ok, false);
});

test('the gateway view for a non-owner: no prompt, note text, title, task, key secret, secret reference or quota', () => {
  const g = {
    presets: { openai: {} },
    providers: [
      {
        id: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: { keychain: 'SECRET-REF-1' },
        auth: { type: 'oauth2', clientId: 'SECRET-CLIENT-2', tokenUrl: 'https://t' },
      },
      { id: 'local', apiKey: null },
    ],
    keys: [
      {
        id: 'key_1',
        name: 'ci',
        prefix: 'zp_ab…',
        scopes: ['llm'],
        budgetUSD: 5,
        createdAt: 1,
        expiresAt: null,
        lastUsedAt: 2,
        revokedAt: null,
        models: ['SECRET-MODEL-LIST-3'],
        guardrails: { secrets: 'off' },
        secret: 'zp_SECRET4',
      },
    ],
    agents: [{ id: 'sre', name: 'SRE', systemPrompt: 'SECRET-PROMPT-5' }],
    sessions: [{ id: 'ses_1', title: 'SECRET-TITLE-6', messages: 2 }],
    memory: [{ id: 'mem_1', text: 'SECRET-NOTE-7', scope: 'global' }],
    runs: [
      { id: 'run_1', title: 'SECRET-TASK-8', error: 'SECRET-ERROR-9', pending: { step: 2, question: 'SECRET-Q-10' } },
      { id: 'run_2', title: 'x', pending: null, state: 'done' },
    ],
    quota: [{ id: 'openai', token: 'SECRET-QUOTA-11' }],
    usage: { month: '2026-11' },
    somethingNew: 'SECRET-NEW-12',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactGateway(g, role);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.deepEqual(r.providers, [
      { id: 'openai', baseUrl: 'https://api.openai.com/v1', auth: { type: 'oauth2' } },
      { id: 'local', auth: { type: 'key' } },
    ]);
    assert.deepEqual(Object.keys(r.keys[0]), [
      'id',
      'name',
      'prefix',
      'scopes',
      'budgetUSD',
      'createdAt',
      'expiresAt',
      'lastUsedAt',
      'revokedAt',
    ]);
    assert.deepEqual(r.agents, [{ id: 'sre', name: 'SRE' }]);
    assert.deepEqual(r.sessions, [{ id: 'ses_1', messages: 2 }]);
    assert.deepEqual(r.memory, [{ id: 'mem_1', scope: 'global' }]);
    assert.deepEqual(r.runs, [
      { id: 'run_1', pending: { step: 2 } },
      { id: 'run_2', state: 'done', pending: null },
    ]);
    assert.deepEqual(r.quota, []);
    assert.deepEqual(r.usage, { month: '2026-11' });
    assert.ok(Object.keys(r).every((k) => GATEWAY_PARTS.includes(k)));
  }
  assert.equal(redactGateway(g, 'owner'), g, 'the owner sees it all');
  assert.equal(redactGateway(null, 'viewer'), null);
});

test('the trace session list for a non-owner: no title (the first prompt)', () => {
  const body = {
    sessions: [
      { key: 'claude.ab', title: 'SECRET-PROMPT-1', tokens: 9 },
      { key: 'codex.cd', title: null },
    ],
  };
  for (const role of ['viewer', 'reviewer'])
    assert.deepEqual(redactTraceSessions(body, role), {
      sessions: [{ key: 'claude.ab', tokens: 9 }, { key: 'codex.cd' }],
    });
  assert.equal(redactTraceSessions(body, 'owner'), body);
  assert.equal(redactTraceSessions(null, 'viewer'), null);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/users-policy.test.js`
Expected: FAIL: `Cannot find module '../lib/users/policy'` (the file fails as one test).

- [ ] **Step 3: Write the policy**

Create `lib/users/policy.js`:

```js
// Dashboard roles (AI Governance 4): what a signed-in person who is not the owner may do. Pure: no I/O. Deny by default:
// every /api request of a reviewer or a viewer is checked against the explicit lists below, by method and path and, for
// a gateway admin route, the body's action. Anything not listed is refused. The owner is never restricted.
//   owner     everything
//   reviewer  what a viewer may, plus inventory reviews and collaboration run approvals
//   viewer    read-only, metadata only: no trace or dataset content, no secret, no setting
const ROLES = ['owner', 'reviewer', 'viewer'];
const DENIED = 'your role cannot do this';
const MUST_CHANGE = 'change your password first';

// GET routes that show metadata: counts, costs, statuses, settings and lists, never a transcript, a prompt, a note, a
// dataset's examples or a secret. Not /api/evals (the results, with the judge's explanations of a session) and the
// trace session list only without its titles (redactTraceSessions).
const VIEWER_READS = [
  '/api/platform',
  '/api/summary',
  '/api/live',
  '/api/insights',
  '/api/topology',
  '/api/timeline',
  '/api/office',
  '/api/logs',
  '/api/mcp-calls',
  '/api/router',
  '/api/openrouter',
  '/api/openrouter/endpoints',
  '/api/config',
  '/api/prices',
  '/api/trace/sources',
  '/api/trace/settings',
  '/api/trace/sessions', // without titles (redactTraceSessions)
  '/api/trace/deps',
  '/api/trace/find',
  '/api/evals/summary',
  '/api/evals/status',
  '/api/evals/evaluators',
  '/api/evals/settings',
  '/api/datasets',
  '/api/datasets/settings',
  '/api/experiments',
  '/api/monitors',
  '/api/monitors/status',
  '/api/alerts',
  '/api/agents/candidates',
  '/api/runtimes',
  '/api/runtimes/config',
  '/api/cost/ledger',
  '/api/cost/export',
  '/api/cost/status',
  '/api/cost/settings',
  '/api/cost/restates',
  '/api/cost/prices/versions',
  '/api/cost/view',
  '/api/cost/report',
  '/api/cost/budgets',
  '/api/governance/audit',
  '/api/governance/audit/export',
  '/api/governance/audit/verify',
  '/api/governance/audit/status',
  '/api/governance/inventory',
  '/api/governance/controls',
  '/api/governance/evidence',
  '/api/integrations',
  '/api/gateway', // the redacted view (redactGateway)
  '/api/gateway/logs',
];
// A reviewer's extra routes: "METHOD path", or "METHOD path action" for a gateway admin route.
const REVIEWER_EXTRA = [
  'POST /api/governance/inventory',
  'GET /api/users/names',
  'POST /api/gateway/collab get',
  'POST /api/gateway/collab list',
  'POST /api/gateway/collab resume',
];
// Any signed-in person, also one who must change their password first.
const ANYONE = ['POST /api/account/password'];

const viewerReads = new Set(VIEWER_READS);
const reviewerExtra = new Set(REVIEWER_EXTRA);
const anyone = new Set(ANYONE);
const GATEWAY_ADMIN = /^\/api\/gateway\/[a-z]+$/;
const WORD = /^[a-z][a-z0-9_-]{0,31}$/;

// allowed({ role, method, path, action, mustChange }) -> { ok, reason }: reason is the 403 message when ok is false.
function allowed({ role, method, path, action = null, mustChange = false } = {}) {
  const yes = { ok: true, reason: null };
  const no = (reason) => ({ ok: false, reason });
  if (role === 'owner') return yes;
  const p = String(path || '');
  if (!p.startsWith('/api/')) return yes; // the page and its files; /api is what holds data
  const m = String(method || '').toUpperCase();
  if (anyone.has(`${m} ${p}`)) return ROLES.includes(role) ? yes : no(DENIED);
  if (!ROLES.includes(role)) return no(DENIED);
  if (mustChange) return no(MUST_CHANGE);
  if (m === 'GET' && viewerReads.has(p)) return yes;
  if (role === 'reviewer') {
    if (reviewerExtra.has(`${m} ${p}`)) return yes;
    if (m === 'POST' && GATEWAY_ADMIN.test(p) && typeof action === 'string' && WORD.test(action))
      if (reviewerExtra.has(`${m} ${p} ${action}`)) return yes;
  }
  return no(DENIED);
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
// What GET /api/gateway keeps for a non-owner: these parts, each item redacted below. A part added later stays out
// until it is listed here.
const GATEWAY_PARTS = [
  'presets',
  'providers',
  'defaults',
  'keys',
  'agents',
  'sessions',
  'memory',
  'usage',
  'spend',
  'builtinTools',
  'routes',
  'knowledge',
  'workflows',
  'workflowCatalog',
  'patterns',
  'effort',
  'runs',
  'skills',
  'skillRoots',
  'quota',
  'tools',
  'baseUrl',
  'settings',
];
const KEY_FIELDS = ['id', 'name', 'prefix', 'scopes', 'budgetUSD', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt'];

// redactGateway(payload, role) -> GET /api/gateway as a reviewer or a viewer sees it: agents without their system
// prompt, notes without their text, sessions without their title, runs without their task, error or approval question,
// keys with nothing but name, prefix, scopes, budget and dates (and their id), providers without a secret reference
// (and only their sign-in type), no quota read. The owner gets the payload as it is.
function redactGateway(g, role) {
  if (role === 'owner' || !isObj(g)) return g;
  const out = pick(g, GATEWAY_PARTS);
  const parts = {
    agents: (a) => list(a).map(({ systemPrompt, ...x }) => x),
    memory: (a) => list(a).map(({ text, ...x }) => x),
    sessions: (a) => list(a).map(({ title, ...x }) => x),
    runs: (a) =>
      list(a).map(({ title, error, pending, ...x }) => ({
        ...x,
        pending: isObj(pending) && Number.isInteger(pending.step) ? { step: pending.step } : null,
      })),
    keys: (a) => list(a).map((k) => pick(k, KEY_FIELDS)),
    providers: (a) =>
      list(a).map(({ apiKey, auth, ...x }) => ({ ...x, auth: { type: (isObj(auth) && auth.type) || 'key' } })),
    quota: () => [],
  };
  for (const [k, fn] of Object.entries(parts)) if (Object.hasOwn(out, k)) out[k] = fn(out[k]);
  return out;
}

// redactTraceSessions(body, role) -> GET /api/trace/sessions as a reviewer or a viewer sees it: each session without its
// title (the first prompt). The owner gets the body as it is.
function redactTraceSessions(body, role) {
  if (role === 'owner' || !isObj(body) || !Array.isArray(body.sessions)) return body;
  return { ...body, sessions: list(body.sessions).map(({ title, ...x }) => x) };
}

module.exports = {
  allowed,
  redactGateway,
  redactTraceSessions,
  ROLES,
  VIEWER_READS,
  REVIEWER_EXTRA,
  ANYONE,
  GATEWAY_PARTS,
  KEY_FIELDS,
  DENIED,
  MUST_CHANGE,
};
```

- [ ] **Step 4: Run the test**

Run: `node --test test/users-policy.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Format**

Run: `npx prettier@3 --check lib/users/policy.js test/users-policy.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add lib/users/policy.js test/users-policy.test.js
git commit -m "Add the role policy and the redacted gateway view"
```

### Task 4: the role gate, the accounts routes and the password change

**Files:**
- Create: `lib/users/api.js`
- Modify: `lib/governance/events.js` (lines 47, 60)
- Modify: `server.js` (lines 85, 142, 152, 312, 1349, 1479, 1537, 1640, 1759)
- Test: `test/users-api.test.js` (create), `test/users-http.test.js` (create)

**Interfaces:**
- Consumes: `createUserStore` (Task 1); `createAuth({ accounts, ownerName })`, `auth.sessionOf`, `auth.endSessions`,
  `auth.passwordChanged`, `auth.mode` (Task 2); `allowed`, `redactGateway`, `redactTraceSessions` (Task 3); in
  `server.js` the existing `govRecord`, `bodies`, `pendingAudit`, `send`, `config.userName`, `gateway.admin`.
- Produces (`lib/users/api.js`): `createUsersApi({ store, auth, record = () => {}, ownerName = () => 'Owner' })` → `{
  route({ method, path, contentType, readBody, req }) → Promise<{ status, body } | null> }` (V7); `FIELDS`, `OFF`.
- Produces (`lib/governance/events.js`): `requestEntry({ method, path, status, body, reply, always = false })`.
- Produces (`server.js`): `userStore` (null in demo), `usersApi`, `readBody(req, max)` that reads a body once
  (`readOnce`), the role gate after `govContext.setActor`.

- [ ] **Step 1: Write the failing tests**

Create `test/users-api.test.js`:

```js
// Dashboard users (AI Governance 4): the accounts router (lib/users/api.js) with a real store in a temp folder and a
// stand-in auth: each action's fields, the 400s, one governance entry per change (never a password), the sessions a
// change ends, the owner's names list, an account changing its own password, and no accounts without sign-in. Also
// the request entry of a refused read (lib/governance/events.js always).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUsersApi } = require('../lib/users/api');
const { createUserStore } = require('../lib/users/store');
const { requestEntry } = require('../lib/governance/events');

const PW = 'a long password 1';
function setup(t, { mode = 'password', who = { user: 'owner', role: 'owner' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'users.json');
  const store = createUserStore({ file });
  const st = { ended: [], changed: 0, entries: [], who };
  const auth = {
    mode,
    sessionOf: () => st.who,
    endSessions: (name, keep) => st.ended.push([name, keep ? 'kept one' : 'all']),
    passwordChanged: () => st.changed++,
  };
  const api = createUsersApi({ store, auth, record: (e) => st.entries.push(e), ownerName: () => 'Rifqi' });
  const call = (p, { method = 'GET', body, contentType = 'application/json' } = {}) =>
    api.route({
      method,
      path: p,
      contentType,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      req: { id: 'this request' },
    });
  const post = (body) => call('/api/users', { method: 'POST', body });
  return { api, store, st, call, post, file };
}

test('create, list, update, reset and delete: one entry each, the sessions a change ends, never a password', async (t) => {
  const s = setup(t);
  const made = await s.post({ action: 'create', name: 'vera', display: 'Vera', role: 'viewer', password: PW });
  assert.equal(made.status, 200);
  assert.deepEqual([made.body.user.name, made.body.user.mustChange], ['vera', true]);
  await s.post({ action: 'create', name: 'rex', role: 'reviewer', password: PW });
  const list = await s.call('/api/users');
  assert.deepEqual([list.status, list.body.mode, list.body.state], [200, 'password', 'ok']);
  assert.deepEqual(
    list.body.users.map((u) => [u.name, u.role]),
    [
      ['rex', 'reviewer'],
      ['vera', 'viewer'],
    ],
  );
  assert.ok(!JSON.stringify(list.body).includes('hash') && !JSON.stringify(list.body).includes('salt'));
  assert.deepEqual((await s.call('/api/users/names')).body, { names: ['Rifqi', 'rex', 'Vera'] });
  // A display name alone ends no session; a new role or a disabled account ends them.
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', display: 'Vera K' })).body.changed, ['display']);
  assert.deepEqual(s.st.ended, []);
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', role: 'reviewer' })).body.changed, ['role']);
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', disabled: true })).body.changed, ['disabled']);
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', disabled: false })).body.changed, ['disabled']);
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', disabled: false })).body.changed, []);
  assert.equal((await s.post({ action: 'reset', name: 'vera', password: 'another password 2' })).status, 200);
  assert.equal((await s.post({ action: 'delete', name: 'rex' })).status, 200);
  assert.deepEqual(s.st.ended, [
    ['vera', 'all'],
    ['vera', 'all'],
    ['vera', 'all'],
    ['rex', 'all'],
  ]);
  assert.deepEqual(s.st.entries, [
    { action: 'user.create', target: { type: 'user', id: 'vera' }, role: 'viewer' },
    { action: 'user.create', target: { type: 'user', id: 'rex' }, role: 'reviewer' },
    {
      action: 'user.update',
      target: { type: 'user', id: 'vera' },
      changes: [{ path: 'display', from: 'Vera', to: 'Vera K' }],
    },
    {
      action: 'user.update',
      target: { type: 'user', id: 'vera' },
      changes: [{ path: 'role', from: 'viewer', to: 'reviewer' }],
    },
    {
      action: 'user.update',
      target: { type: 'user', id: 'vera' },
      changes: [{ path: 'disabled', from: false, to: true }],
    },
    {
      action: 'user.update',
      target: { type: 'user', id: 'vera' },
      changes: [{ path: 'disabled', from: true, to: false }],
    },
    { action: 'user.password_reset', target: { type: 'user', id: 'vera' } },
    { action: 'user.delete', target: { type: 'user', id: 'rex' }, role: 'reviewer' },
  ]);
  assert.ok(!JSON.stringify(s.st.entries).includes(PW));
});

test('bad input: the action, unknown fields, each field, an unknown account, the method and the body', async (t) => {
  const s = setup(t);
  const err = async (body) => {
    const r = await s.post(body);
    return [r.status, r.body.error];
  };
  assert.deepEqual(await err({ action: 'promote', name: 'x' }), [400, 'action: create, update, reset or delete']);
  assert.deepEqual(await err({ name: 'x' }), [400, 'action: create, update, reset or delete']);
  assert.deepEqual(await err({ action: 'delete', name: 'x', password: PW }), [400, 'password: not a field of delete']);
  const bad = await s.post({ action: 'create', name: 'X', role: 'admin', password: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors.length, 3);
  assert.deepEqual(await err({ action: 'update', name: 'nobody', role: 'viewer' }), [404, 'no such account']);
  assert.deepEqual(await err({ action: 'reset', name: 'nobody', password: PW }), [404, 'no such account']);
  assert.equal((await s.call('/api/users', { method: 'PUT', body: {} })).status, 405);
  assert.equal((await s.call('/api/users/names', { method: 'POST', body: {} })).status, 405);
  assert.equal((await s.call('/api/account/password')).status, 405);
  assert.equal((await s.call('/api/users', { method: 'POST', body: '{}', contentType: 'text/plain' })).status, 415);
  assert.deepEqual((await s.call('/api/users', { method: 'POST', body: '{ torn' })).body, {
    error: 'bad request body',
  });
  assert.deepEqual((await s.call('/api/users', { method: 'POST', body: '[1]' })).body, { error: 'bad request body' });
  assert.equal(await s.api.route({ method: 'GET', path: '/api/usersx' }), null);
  assert.deepEqual(s.st.entries, [], 'nothing refused is an entry here (the request entry records it)');
});

test('an account changes its own password: the current one first, then a new one; its other sessions end', async (t) => {
  const s = setup(t);
  s.store.create({ name: 'vera', role: 'viewer', password: PW });
  s.st.who = { user: 'vera', role: 'viewer', mustChange: true };
  const own = (body) => s.call('/api/account/password', { method: 'POST', body });
  assert.deepEqual((await own({ current: 'wrong password!', next: 'my new password 3' })).body, {
    error: 'current: not your password',
  });
  assert.deepEqual((await own({ current: PW, next: PW })).body, {
    error: 'next: must differ from the current password',
  });
  assert.deepEqual((await own({ current: PW, next: 'short' })).body.error, 'next: at least 12 characters');
  assert.deepEqual(
    (await own({ current: PW, next: 'my new password 3', name: 'rex' })).body.error,
    'name: not a field',
  );
  assert.deepEqual(s.st.ended, []);
  const ok = await own({ current: PW, next: 'my new password 3' });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
  assert.deepEqual(s.st.ended, [['vera', 'kept one']]);
  assert.equal(s.st.changed, 1);
  assert.equal(s.store.get('vera').mustChange, false);
  assert.deepEqual(s.st.entries, [{ action: 'account.password_change', target: { type: 'user', id: 'vera' } }]);
  // The owner's own password is not changed here.
  s.st.who = { user: 'owner', role: 'owner' };
  assert.deepEqual((await own({ current: 'x', next: 'y' })).body, {
    error: "the owner's password is set with `zaafpulse set-password` on the server",
  });
});

test('without sign-in there are no accounts: the list says off and a change is refused', async (t) => {
  const s = setup(t, { mode: 'none' });
  assert.deepEqual((await s.call('/api/users')).body, { mode: 'none', state: 'off', users: [] });
  assert.deepEqual((await s.post({ action: 'create', name: 'vera', role: 'viewer', password: PW })).body, {
    error: 'accounts need sign-in: ZAAFPULSE_AUTH=none has no accounts',
  });
  assert.deepEqual((await s.call('/api/users/names')).body, { names: ['Rifqi'] });
});

test('an unreadable accounts file: the list says so and nothing is written', async (t) => {
  const s = setup(t);
  await s.post({ action: 'create', name: 'vera', role: 'viewer', password: PW });
  fs.writeFileSync(s.file, '{ torn');
  assert.deepEqual((await s.call('/api/users')).body, { mode: 'password', state: 'unreadable', users: [] });
  const r = await s.post({ action: 'delete', name: 'vera' });
  assert.deepEqual(
    [r.status, r.body.error],
    [409, 'users.json could not be read; nothing was written (fix or move .data/users.json)'],
  );
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{ torn');
});

test('a refused read is an entry when asked for (always), with no body field but the short ones', () => {
  const read = { method: 'GET', path: '/api/trace/content', status: 403 };
  assert.equal(requestEntry({ ...read, status: 200 }).action, 'GET /api/trace/content');
  assert.equal(
    requestEntry({ method: 'POST', path: '/api/gateway/knowledge', status: 403, body: '{"action":"get"}' }),
    null,
  );
  assert.deepEqual(
    requestEntry({
      method: 'POST',
      path: '/api/gateway/knowledge',
      status: 403,
      body: '{"action":"get","query":"x"}',
      always: true,
    }),
    { action: 'POST /api/gateway/knowledge', op: 'get', outcome: 'refused', status: 403 },
  );
  assert.deepEqual(requestEntry({ ...read, always: true }), {
    action: 'GET /api/trace/content',
    outcome: 'refused',
    status: 403,
  });
});
```

Create `test/users-http.test.js`:

```js
// Dashboard users and roles (AI Governance 4) through a spawned server.js in password mode: the owner (the legacy
// { password } sign-in) adds a viewer and a reviewer; each must change the password first; the viewer reads the
// Governance pages and exports evidence but is refused a setting, trace content and a gateway action; the reviewer saves
// an inventory review and reads runs but cannot change a setting; a new role or a disabled account ends the sessions;
// every entry names the account. Ports 10200-10399 are this file's own; a temp data folder is also HOME.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const ADMIN = 'correct horse battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 10200 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

// Starts server.js on a free port of the range (again when another test took the port first); stopped and its data
// folder removed when the test ends.
async function startServer(t, env = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-http-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '1',
        ZAAFPULSE_ADMIN_PASSWORD: ADMIN,
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
        CLAUDE_CONFIG_DIR: data,
        CODEX_HOME: path.join(data, '.codex'),
        XDG_CONFIG_HOME: path.join(data, '.config'),
        APPDATA: path.join(data, 'AppData', 'Roaming'),
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
// One request: JSON in and out (text when the answer is not JSON). `as` is a signed-in browser's cookie.
async function call(s, p, { method = 'GET', body, as } = {}) {
  const r = await fetch(s.base + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(as ? { cookie: as, origin: s.base } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: json === null ? text : json, text, headers: r.headers };
}
async function signIn(s, body) {
  const r = await call(s, '/api/login', { method: 'POST', body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}
function entries(s) {
  const dir = path.join(s.data, '.data', 'audit');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^governance-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
const VERA = 'vera password 01';
const REX = 'rex password 001';

test('owner, viewer and reviewer: what each may do, the mustChange gate, and every entry names the account', async (t) => {
  const s = await startServer(t);
  const owner = await signIn(s, { password: ADMIN }); // the sign-in of before still works
  for (const body of [
    { action: 'create', name: 'vera', display: 'Vera', role: 'viewer', password: 'vera first 0001' },
    { action: 'create', name: 'rex', display: 'Rex', role: 'reviewer', password: 'rex first 00001' },
  ])
    assert.equal((await call(s, '/api/users', { method: 'POST', body, as: owner })).status, 200);
  const listed = await call(s, '/api/users', { as: owner });
  assert.deepEqual(
    listed.body.users.map((u) => [u.name, u.role, u.mustChange]),
    [
      ['rex', 'reviewer', true],
      ['vera', 'viewer', true],
    ],
  );
  const file = path.join(s.data, '.data', 'users.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // The viewer: the new password first; until then everything but the password route is refused.
  let vera = await signIn(s, { name: 'vera', password: 'vera first 0001' });
  const first = await call(s, '/api/summary', { as: vera });
  assert.deepEqual([first.status, first.body], [403, { error: 'change your password first' }]);
  const session = await call(s, '/api/session', { as: vera });
  assert.deepEqual([session.body.user, session.body.role, session.body.mustChange], ['vera', 'viewer', true]);
  const change = { method: 'POST', body: { current: 'vera first 0001', next: VERA }, as: vera };
  assert.equal((await call(s, '/api/account/password', change)).status, 200);
  assert.equal((await call(s, '/api/session', { as: vera })).body.mustChange, false);
  // Reads of metadata, the Governance pages and the evidence export.
  for (const p of [
    '/api/summary',
    '/api/config',
    '/api/governance/inventory',
    '/api/governance/controls',
    '/api/governance/audit',
    '/api/governance/audit/status',
    '/api/governance/evidence?format=md',
    '/api/cost/status',
    '/api/trace/sources',
    '/api/trace/sessions',
    '/api/evals/summary',
    '/api/datasets',
    '/api/monitors',
  ])
    assert.equal((await call(s, p, { as: vera })).status, 200, p);
  // The gateway, redacted: the built-in agents have no system prompt here.
  const gw = await call(s, '/api/gateway', { as: vera });
  assert.ok(gw.body.agents.length > 0 && gw.body.agents.every((a) => !('systemPrompt' in a)));
  const ownerGw = await call(s, '/api/gateway', { as: owner });
  assert.ok(ownerGw.body.agents.some((a) => typeof a.systemPrompt === 'string'));
  // Refused: a setting, trace content, a gateway action, the accounts, a review.
  const refused = [
    ['/api/config', { method: 'POST', body: { userName: 'Eve' } }],
    ['/api/trace/content?id=ci_00', {}],
    ['/api/evals', {}],
    ['/api/gateway/keys', { method: 'POST', body: { action: 'create', name: 'mine' } }],
    ['/api/gateway/knowledge', { method: 'POST', body: { action: 'search', id: 'kb', query: 'x' } }],
    ['/api/users', {}],
    ['/api/governance/inventory', { method: 'POST', body: { id: 'app:claude', owner: 'Vera' } }],
  ];
  for (const [p, opts] of refused) {
    const r = await call(s, p, { ...opts, as: vera });
    assert.deepEqual([r.status, r.body], [403, { error: 'your role cannot do this' }], p);
  }
  assert.equal((await call(s, '/api/config', { as: owner })).body.userName !== 'Eve', true);

  // The reviewer: a review and the runs, but no setting and no new run.
  let rex = await signIn(s, { name: 'rex', password: 'rex first 00001' });
  const rexChange = { method: 'POST', body: { current: 'rex first 00001', next: REX }, as: rex };
  assert.equal((await call(s, '/api/account/password', rexChange)).status, 200);
  const review = { id: 'app:claude', owner: 'Rex', risk: 'limited' };
  const saved = await call(s, '/api/governance/inventory', { method: 'POST', body: review, as: rex });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const runs = await call(s, '/api/gateway/collab', { method: 'POST', body: { action: 'list' }, as: rex });
  assert.deepEqual([runs.status, runs.body.runs], [200, []]);
  const resume = { action: 'resume', id: 'run_none', approve: true };
  assert.deepEqual((await call(s, '/api/gateway/collab', { method: 'POST', body: resume, as: rex })).body, {
    errors: ['no such run'],
  });
  assert.equal((await call(s, '/api/users/names', { as: rex })).status, 200);
  for (const [p, body] of [
    ['/api/config', { userName: 'Rex' }],
    ['/api/gateway/collab', { action: 'start', task: 'x' }],
    ['/api/governance/settings', { audit: { retentionMonths: 24 } }],
  ])
    assert.equal((await call(s, p, { method: 'POST', body, as: rex })).status, 403, p);

  // A new role ends the reviewer's sessions; a disabled account cannot sign in again.
  const toViewer = { action: 'update', name: 'rex', role: 'viewer' };
  assert.equal((await call(s, '/api/users', { method: 'POST', body: toViewer, as: owner })).status, 200);
  assert.equal((await call(s, '/api/summary', { as: rex })).status, 401);
  rex = await signIn(s, { name: 'rex', password: REX });
  assert.equal((await call(s, '/api/session', { as: rex })).body.role, 'viewer');
  const off = { action: 'update', name: 'vera', disabled: true };
  assert.equal((await call(s, '/api/users', { method: 'POST', body: off, as: owner })).status, 200);
  assert.equal((await call(s, '/api/summary', { as: vera })).status, 401);
  const again = await call(s, '/api/login', { method: 'POST', body: { name: 'vera', password: VERA } });
  assert.deepEqual([again.status, again.body], [401, { error: 'wrong name or password' }]);
  vera = null;

  // The entries: who acted, by account and role; the refused reads too; never a password.
  const all = entries(s);
  const of = (action) => all.filter((e) => e.action === action);
  assert.deepEqual(
    of('user.create').map((e) => [e.target.id, e.actor.user, e.actor.role]),
    [
      ['vera', 'owner', 'owner'],
      ['rex', 'owner', 'owner'],
    ],
  );
  assert.deepEqual(
    of('account.password_change').map((e) => [e.target.id, e.actor.user]),
    [
      ['vera', 'vera'],
      ['rex', 'rex'],
    ],
  );
  assert.deepEqual(
    of('user.update').map((e) => e.changes),
    [[{ path: 'role', from: 'reviewer', to: 'viewer' }], [{ path: 'disabled', from: false, to: true }]],
  );
  const veraRefused = all.filter((e) => e.actor.user === 'vera' && e.outcome === 'refused');
  assert.deepEqual(
    veraRefused.map((e) => [e.action, e.status]),
    [
      ['GET /api/summary', 403],
      ['POST /api/config', 403],
      ['GET /api/trace/content', 403],
      ['GET /api/evals', 403],
      ['POST /api/gateway/keys', 403],
      ['POST /api/gateway/knowledge', 403],
      ['GET /api/users', 403],
      ['POST /api/governance/inventory', 403],
    ],
  );
  assert.ok(veraRefused.every((e) => e.actor.role === 'viewer' && e.actor.mode === 'password'));
  assert.deepEqual(
    of('auth.login').map((e) => [e.actor.user, e.actor.role]),
    [
      ['owner', 'owner'],
      ['vera', 'viewer'],
      ['rex', 'reviewer'],
      ['rex', 'viewer'],
    ],
  );
  assert.deepEqual(of('auth.login_failed').at(-1).target, { type: 'user', id: 'vera' });
  const review0 = all.find((e) => e.action === 'POST /api/governance/inventory' && e.outcome === 'ok');
  assert.deepEqual([review0.actor.user, review0.actor.role], ['rex', 'reviewer']);
  const text = JSON.stringify(all);
  for (const secret of [VERA, REX, 'vera first 0001', 'rex first 00001', ADMIN])
    assert.ok(!text.includes(secret), secret);
  assert.ok(s.alive());
});

test('without sign-in there are no accounts; the owner is everyone and the Users page is off', async (t) => {
  const s = await startServer(t, { ZAAFPULSE_AUTH: 'none', ZAAFPULSE_ADMIN_PASSWORD: '' });
  assert.deepEqual((await call(s, '/api/users')).body, { mode: 'none', state: 'off', users: [] });
  const create = { action: 'create', name: 'vera', role: 'viewer', password: VERA };
  assert.deepEqual((await call(s, '/api/users', { method: 'POST', body: create })).body, {
    error: 'accounts need sign-in: ZAAFPULSE_AUTH=none has no accounts',
  });
  const session = await call(s, '/api/session');
  assert.deepEqual([session.body.accounts, session.body.user, session.body.role], [false, 'owner', 'owner']);
  assert.ok(s.alive());
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/users-api.test.js test/users-http.test.js`
Expected: FAIL: `Cannot find module '../lib/users/api'` in `test/users-api.test.js`, and both tests of `test/users-http.test.js` (no `/api/users`, no role gate).

- [ ] **Step 3: The router, the refused entry, and the wiring in `server.js`**

In `lib/governance/events.js`, replace

```js
  return { route: path, ids: [] };
}

// requestEntry({ method, path, status, body, reply }) -> the entry of one dashboard request, or null for a read.
// body is the request's text (as read), reply the answer sent: an admin answer of { errors } with 200 is a refusal.
function requestEntry({ method, path, status, body, reply }) {
  const { route, ids } = routeOf(path);
  let b = null;
  try {
```

with

```js
  return { route: path, ids: [] };
}

// requestEntry({ method, path, status, body, reply, always }) -> the entry of one dashboard request, or null for a read.
// body is the request's text (as read), reply the answer sent: an admin answer of { errors } with 200 is a refusal.
// always: an entry even for a read (a request the role policy refused, AI Governance 4).
function requestEntry({ method, path, status, body, reply, always = false }) {
  const { route, ids } = routeOf(path);
  let b = null;
  try {
```

In `lib/governance/events.js`, replace

```js
  }
  if (!isObj(b)) b = {};
  const op = [b.action, b.op].find((v) => typeof v === 'string' && WORD.test(v)) || null;
  if (READ_ONLY.has(`${method} ${route}`) || (op && READ_ONLY.has(`${method} ${route} ${op}`))) return null;
  const id = ids[0] || (typeof b.id === 'string' && ID.test(b.id) ? b.id : null);
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : null;
  const seg = route.split('/');
```

with

```js
  }
  if (!isObj(b)) b = {};
  const op = [b.action, b.op].find((v) => typeof v === 'string' && WORD.test(v)) || null;
  if (!always && (READ_ONLY.has(`${method} ${route}`) || (op && READ_ONLY.has(`${method} ${route} ${op}`))))
    return null;
  const id = ids[0] || (typeof b.id === 'string' && ID.test(b.id) ? b.id : null);
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : null;
  const seg = route.split('/');
```

Create `lib/users/api.js`:

```js
// The HTTP side of the dashboard accounts (AI Governance 4). server.js puts it behind the sign-in and the role policy
// (lib/users/policy.js): /api/users is the owner's, /api/users/names a reviewer's too, /api/account/password anyone's.
//   GET  /api/users                 { mode, state, users }  state: 'ok' | 'unreadable' | 'off' (no sign-in)
//   POST /api/users                 { action: 'create', name, display?, role, password }
//                                   { action: 'update', name, role?, display?, disabled? }
//                                   { action: 'reset', name, password }      a new password, to be changed at sign-in
//                                   { action: 'delete', name }
//   GET  /api/users/names           { names }  the owner's and the accounts' display names (review owner suggestions)
//   POST /api/account/password      { current, next }  the signed-in account changes its own password
// Every change is one governance entry (user.create, user.update, user.password_reset, user.delete,
// account.password_change) with the account as its target, never a password. A new role, a disabled or deleted account
// and a new password end the account's sessions at once.
const FIELDS = {
  create: ['name', 'display', 'role', 'password'],
  update: ['name', 'role', 'display', 'disabled'],
  reset: ['name', 'password'],
  delete: ['name'],
};
const OFF = 'accounts need sign-in: ZAAFPULSE_AUTH=none has no accounts';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const reply = (status, body) => ({ status, body });
const failed = (e) => reply(e.status, { error: e.message, errors: e.errors || [e.message] });

// store: lib/users/store.js; auth: lib/auth.js (sessionOf, endSessions, passwordChanged); record(entry): the governance
// audit log; ownerName(): the owner's display name.
function createUsersApi({ store, auth, record = () => {}, ownerName = () => 'Owner' }) {
  const off = () => auth.mode === 'none' || !store;
  const target = (name) => ({ type: 'user', id: String(name).slice(0, 80) });
  const note = (entry) => {
    try {
      record(entry);
    } catch {
      /* the change stands (A6) */
    }
  };

  function list() {
    if (off()) return reply(200, { mode: auth.mode, state: 'off', users: [] });
    const r = store.list();
    return reply(200, { mode: auth.mode, state: r.state, users: r.users });
  }
  function names() {
    const own = String(ownerName() || 'Owner');
    const rest = off() ? [] : store.names();
    return reply(200, { names: [own, ...rest.filter((n) => n !== own)] });
  }

  function change(body) {
    if (off()) return reply(409, { error: OFF });
    const fields = FIELDS[body.action];
    if (!fields) return reply(400, { error: 'action: create, update, reset or delete' });
    const extra = Object.keys(body).filter((k) => k !== 'action' && !fields.includes(k));
    if (extra.length) return reply(400, { error: `${extra[0]}: not a field of ${body.action}` });
    const { name } = body;
    if (body.action === 'create') {
      const { user } = store.create(body);
      note({ action: 'user.create', target: target(user.name), role: user.role });
      return reply(200, { user });
    }
    if (body.action === 'update') {
      const before = store.get(name);
      const { user, changed } = store.update(name, { role: body.role, display: body.display, disabled: body.disabled });
      if (changed.length) {
        if (changed.includes('role') || (changed.includes('disabled') && user.disabled)) auth.endSessions(user.name);
        note({
          action: 'user.update',
          target: target(user.name),
          changes: changed.map((k) => ({ path: k, from: before[k], to: user[k] })),
        });
      }
      return reply(200, { user, changed });
    }
    if (body.action === 'reset') {
      const { user } = store.resetPassword(name, body.password);
      auth.endSessions(user.name);
      note({ action: 'user.password_reset', target: target(user.name) });
      return reply(200, { user });
    }
    const { user } = store.remove(name);
    auth.endSessions(user.name);
    note({ action: 'user.delete', target: target(user.name), role: user.role });
    return reply(200, { user });
  }

  async function ownPassword(body, req) {
    const who = auth.sessionOf(req, false);
    if (!who || who.role === 'owner')
      return reply(400, { error: "the owner's password is set with `zaafpulse set-password` on the server" });
    if (off()) return reply(409, { error: OFF });
    const { current, next } = body;
    const extra = Object.keys(body).filter((k) => k !== 'current' && k !== 'next');
    if (extra.length) return reply(400, { error: `${extra[0]}: not a field` });
    if (typeof current !== 'string' || !(await store.verify(who.user, current)))
      return reply(400, { error: 'current: not your password' });
    if (next === current) return reply(400, { error: 'next: must differ from the current password' });
    store.changePassword(who.user, next);
    // Every other session of the account ends; this one goes on without the mustChange gate.
    auth.endSessions(who.user, req);
    auth.passwordChanged(req);
    note({ action: 'account.password_change', target: target(who.user) });
    return reply(200, { ok: true });
  }

  // `r` is { method, path, contentType, readBody, req }. Returns { status, body }, or null when the path is not ours.
  async function route(r) {
    const p = r.path;
    if (p !== '/api/users' && p !== '/api/users/names' && p !== '/api/account/password') return null;
    const post = p !== '/api/users/names' && r.method === 'POST';
    const get = p !== '/api/account/password' && r.method === 'GET';
    if (!post && !get) return reply(405, { error: 'method not allowed' });
    if (get) return p === '/api/users' ? list() : names();
    // A change needs JSON, so a simple cross-site form post cannot make one.
    if (!(r.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
    let body;
    try {
      body = JSON.parse(await r.readBody());
    } catch (e) {
      return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
    }
    if (!isObj(body)) return reply(400, { error: 'bad request body' });
    try {
      return p === '/api/users' ? change(body) : await ownPassword(body, r.req);
    } catch (e) {
      // A store error has a status and a message without a path; anything else is a plain 500.
      if (e && Number.isInteger(e.status)) return failed(e);
      return reply(500, { error: 'accounts request failed' });
    }
  }

  return { route };
}

module.exports = { createUsersApi, FIELDS, OFF };
```

In `server.js`, replace

```js
const { createSeenStore } = require('./lib/governance/seen');
const { cleanPolicy: guardPolicy } = require('./lib/gateway/guardrails');
const { RULES: MONITOR_RULES } = require('./lib/monitors/rules');

const PORT = Number(process.env.ZAAFPULSE_PORT || process.env.PORT) || 4777;
const HOST = process.env.ZAAFPULSE_HOST || process.env.HOST || '127.0.0.1';
```

with

```js
const { createSeenStore } = require('./lib/governance/seen');
const { cleanPolicy: guardPolicy } = require('./lib/gateway/guardrails');
const { RULES: MONITOR_RULES } = require('./lib/monitors/rules');
const { createUserStore } = require('./lib/users/store');
const { createUsersApi } = require('./lib/users/api');
const { allowed: roleAllows, redactGateway, redactTraceSessions } = require('./lib/users/policy');

const PORT = Number(process.env.ZAAFPULSE_PORT || process.env.PORT) || 4777;
const HOST = process.env.ZAAFPULSE_HOST || process.env.HOST || '127.0.0.1';
```

In `server.js`, replace

```js

const { fullName, computerName } = platform;
const HOSTNAME = DEMO ? demo.config.host : computerName();
let auth;
try {
  auth = createAuth({
```

with

```js

const { fullName, computerName } = platform;
const HOSTNAME = DEMO ? demo.config.host : computerName();
// Dashboard accounts (AI Governance 4): the owner's other people, in .data/users.json. None in demo mode.
const userStore = DEMO ? null : createUserStore({ file: path.join(DIR, '.data', 'users.json') });
let auth;
try {
  auth = createAuth({
```

In `server.js`, replace

```js
    demo: DEMO,
    headers: () => SECURITY_HEADERS,
    onEvent: (e) => govRecord(e), // sign-ins and sign-outs for the governance audit log
  });
} catch (err) {
  console.error(err.message);
```

with

```js
    demo: DEMO,
    headers: () => SECURITY_HEADERS,
    onEvent: (e) => govRecord(e), // sign-ins and sign-outs for the governance audit log
    accounts: userStore,
    ownerName: () => config.userName,
  });
} catch (err) {
  console.error(err.message);
```

In `server.js`, replace

```js
  record: (e) => govRecord(e), // the evidence export (a GET), with the request's actor
  version: require('./package.json').version,
  seen: createSeenStore({ file: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'governance', 'seen.json') }),
});
let rawCache = {
  mtime: -1,
```

with

```js
  record: (e) => govRecord(e), // the evidence export (a GET), with the request's actor
  version: require('./package.json').version,
  seen: createSeenStore({ file: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'governance', 'seen.json') }),
});
// /api/users (the owner's), /api/users/names and /api/account/password (AI Governance 4); each change is a governance
// entry with the request's actor.
const usersApi = createUsersApi({
  store: userStore,
  auth,
  record: (e) => govRecord(e),
  ownerName: () => config.userName,
});
let rawCache = {
  mtime: -1,
```

In `server.js`, replace

```js
// The text each request sent, as read, for the audit entry of a dashboard change (send() keeps its short fields only).
const bodies = new WeakMap();
const AUDIT_BODY_MAX = 64 * 1024;
function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
```

with

```js
// The text each request sent, as read, for the audit entry of a dashboard change (send() keeps its short fields only).
const bodies = new WeakMap();
const AUDIT_BODY_MAX = 64 * 1024;
// A body is read once: the role check reads a gateway admin body for its action, and the route reads it again here.
const reads = new WeakMap();
function readBody(req, max = 1e6) {
  if (!reads.has(req)) reads.set(req, readOnce(req, max));
  return reads.get(req);
}
function readOnce(req, max) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
```

In `server.js`, replace

```js
    if (signedIn) {
      // The governance audit log: who this request acts as, and one entry for each change it makes (A4(1)).
      govContext.setActor(auth.actorOf(req));
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && url.pathname.startsWith('/api/'))
        pendingAudit.set(res, { req, path: url.pathname });
    }
```

with

```js
    if (signedIn) {
      // The governance audit log: who this request acts as, and one entry for each change it makes (A4(1)).
      govContext.setActor(auth.actorOf(req));
      // Roles (AI Governance 4): a reviewer's or a viewer's /api request is checked against lib/users/policy.js before
      // anything runs (a gateway admin route by its body's action). A refusal is a 403 and one refused entry, a read
      // included.
      const who = url.pathname.startsWith('/api/') ? auth.sessionOf(req, false) : null;
      if (who && who.role !== 'owner') {
        let action = null;
        if (req.method === 'POST' && /^\/api\/gateway\/[a-z]+$/.test(url.pathname))
          try {
            const b = JSON.parse(await readBody(req));
            if (b && typeof b.action === 'string') action = b.action;
          } catch {
            /* no action: refused below */
          }
        const verdict = roleAllows({
          role: who.role,
          method: req.method,
          path: url.pathname,
          action,
          mustChange: who.mustChange,
        });
        if (!verdict.ok) {
          try {
            const e = requestEntry({
              method: req.method,
              path: url.pathname,
              status: 403,
              body: bodies.get(req),
              always: true,
            });
            if (e) govRecord(e);
          } catch {
            /* an audit bug never changes the answer (A6) */
          }
          return send(res, 403, { error: verdict.reason });
        }
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && url.pathname.startsWith('/api/'))
        pendingAudit.set(res, { req, path: url.pathname });
    }
```

In `server.js`, replace

```js
        version: require('./package.json').version,
      });
    }
    if (url.pathname === '/api/gateway' && req.method === 'GET') return send(res, 200, await gateway.admin('', 'GET'));
    const gwAdmin = url.pathname.match(/^\/api\/gateway\/([a-z]+)$/);
    if (gwAdmin) {
      // Only the request log is read with GET. Every other admin route writes (defaults, settings), spends tokens
```

with

```js
        version: require('./package.json').version,
      });
    }
    // A reviewer or a viewer gets the redacted view: no prompt, note, title, task or secret reference.
    if (url.pathname === '/api/gateway' && req.method === 'GET') {
      const who = auth.sessionOf(req, false);
      return send(res, 200, redactGateway(await gateway.admin('', 'GET'), who ? who.role : 'viewer'));
    }
    const gwAdmin = url.pathname.match(/^\/api\/gateway\/([a-z]+)$/);
    if (gwAdmin) {
      // Only the request log is read with GET. Every other admin route writes (defaults, settings), spends tokens
```

In `server.js`, replace

```js
            minMs: Number.isFinite(minMs) && minMs > 0 ? minMs : undefined,
            minCost: Number.isFinite(minCost) && minCost > 0 ? minCost : undefined,
          });
          return send(res, 200, { sessions: rows });
        }
        if (route === 'deps') {
          const days = parseInt(q.get('range'), 10);
```

with

```js
            minMs: Number.isFinite(minMs) && minMs > 0 ? minMs : undefined,
            minCost: Number.isFinite(minCost) && minCost > 0 ? minCost : undefined,
          });
          // A reviewer or a viewer gets the list without titles (the first prompt).
          const who = auth.sessionOf(req, false);
          return send(res, 200, redactTraceSessions({ sessions: rows }, who ? who.role : 'viewer'));
        }
        if (route === 'deps') {
          const days = parseInt(q.get('range'), 10);
```

In `server.js`, replace

```js
        readBody: () => readBody(req),
      });
      if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json', hit.headers);
    }
    if (url.pathname === '/api/logs') {
      return send(res, 200, DEMO ? reqlogs.demoLogs() : reqlogs.logs());
```

with

```js
        readBody: () => readBody(req),
      });
      if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json', hit.headers);
    }
    // The dashboard accounts (AI Governance 4).
    {
      const hit = await usersApi.route({
        method: req.method,
        path: url.pathname,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
        req,
      });
      if (hit) return send(res, hit.status, hit.body);
    }
    if (url.pathname === '/api/logs') {
      return send(res, 200, DEMO ? reqlogs.demoLogs() : reqlogs.logs());
```

- [ ] **Step 4: Run the tests and the suites around them**

Run: `node --test test/users-api.test.js test/users-http.test.js test/governance-http.test.js test/governance-events.test.js test/governance-inventory-http.test.js test/trace-api.test.js test/signin.test.js test/security.test.js`
Expected: PASS (67 tests).

- [ ] **Step 5: Format**

Run: `npx prettier@3 --check lib/users/api.js lib/governance/events.js test/users-api.test.js test/users-http.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath server.js < server.js | diff server.js - | grep -c '^[<>]'`
Expected: `7`

- [ ] **Step 6: Commit**

```bash
git add lib/users/api.js lib/governance/events.js server.js test/users-api.test.js test/users-http.test.js
git commit -m "Check every reviewer and viewer request against the role policy; add the accounts routes"
```

### Task 5: the audit log by account

**Files:**
- Modify: `lib/governance/api.js` (lines 1, 20, 52)
- Modify: `lib/governance/audit.js` (lines 452, 636, 666)
- Modify: `public/governanceview.js` (lines 6, 33, 65, 88, 196, 520)
- Test: `test/users-audit.test.js` (create), `test/users-http.test.js` (modify, line 264)

**Interfaces:**
- Consumes: the actor's `user` and `role` (Task 2); the spawned test of Task 4.
- Produces (`lib/governance/audit.js`): `list({ …, user })` keeps entries whose `actor.user` is `user`; CSV `actor_id`
  (V8).
- Produces (`lib/governance/api.js`): `GET /api/governance/audit?user=` (V8).
- Produces (`public/governanceview.js`): `GOV.filters.user`, `govQuery` sets `user`, the `User` input in
  `govFiltersHtml`, `govActorLabel` names `user (role)`.

- [ ] **Step 1: Write the failing tests**

Create `test/users-audit.test.js`:

```js
// Dashboard users (AI Governance 4) in the governance audit log: the list filters by account (GET
// /api/governance/audit?user=), the CSV's actor_id is the account of a dashboard entry, and the Audit log page names the
// account and its role and has a User filter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGovernanceAudit, keySource } = require('../lib/governance/audit');
const { createGovernanceApi } = require('../lib/governance/api');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
global.subHero = (eyebrow, title, sub) => `<div class="hero">${eyebrow}|${title}|${sub}</div>`;
global.subTabs = (route) => `<nav class="subtabs">${route}</nav>`;
const U = require('../public/governanceview');

const NOW = Date.UTC(2026, 10, 4, 12);
const actor = (user, role) => ({ via: 'dashboard', user, role, mode: 'password', device: 'Ab12', ip: '10.0.0.2' });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = createGovernanceAudit({ dir, now: () => NOW, getKey: keySource({ dir }) });
  const api = createGovernanceApi({ audit, settings: { get: () => undefined, save: () => {} }, now: () => NOW });
  const call = (q) =>
    api.route({ method: 'GET', path: '/api/governance/audit', query: new URLSearchParams(q), contentType: '' });
  return { audit, call };
}

test('the list by account: only that account, "owner" included; a value that is no account name is a 400', async (t) => {
  const s = setup(t);
  s.audit.record({ action: 'user.create', actor: actor('owner', 'owner'), target: { type: 'user', id: 'vera' } });
  s.audit.record({ action: 'POST /api/config', actor: actor('vera', 'viewer'), outcome: 'refused', status: 403 });
  s.audit.record({ action: 'POST /api/governance/inventory', actor: actor('rex', 'reviewer') });
  s.audit.record({ action: 'config.change', actor: { via: 'apikey', keyId: 'key_1' } });
  const actions = async (q) => (await s.call(q)).body.entries.map((e) => e.action);
  assert.deepEqual(await actions('user=vera'), ['POST /api/config']);
  assert.deepEqual(await actions('user=owner'), ['user.create']);
  assert.deepEqual(await actions('user=rex&actor=dashboard'), ['POST /api/governance/inventory']);
  assert.deepEqual(await actions('user=nobody'), []);
  for (const bad of ['Vera', 'v', 'vera smith', 'x'.repeat(33)])
    assert.deepEqual(await s.call(`user=${encodeURIComponent(bad)}`), {
      status: 400,
      body: { error: 'user: owner or an account name' },
    });
  // The CSV: actor_id is the account for a dashboard entry, the key for a key's.
  const lines = s.audit.export({ format: 'csv' }).body.split('\r\n');
  assert.match(lines[0], /^seq,time,actor,actor_id,ip,/);
  assert.match(lines[2], /^2,2026-11-04T12:00:00\.000Z,dashboard,owner,10\.0\.0\.2,user\.create,/);
  assert.match(lines[3], /^3,[^,]+,dashboard,vera,10\.0\.0\.2,POST \/api\/config,/);
  assert.match(lines[5], /^5,[^,]+,apikey,key_1,,config\.change,/);
  // An entry from before accounts keeps its device.
  s.audit.record({ action: 'auth.logout', actor: { via: 'dashboard', mode: 'password', device: 'Zz99', ip: '::1' } });
  assert.match(s.audit.export({ format: 'csv' }).body.split('\r\n')[6], /^6,[^,]+,dashboard,Zz99,::1,auth\.logout,/);
});

test('the Audit log page: the account and its role in words, and a User filter in the query', () => {
  assert.equal(
    U.govActorLabel(actor('vera', 'viewer')),
    'Dashboard · vera (viewer) · password · device Ab12 · 10.0.0.2',
  );
  assert.equal(
    U.govActorLabel({ via: 'dashboard', user: 'owner', role: 'owner', mode: 'none', device: null, ip: '127.0.0.1' }),
    'Dashboard · owner · none · 127.0.0.1',
  );
  assert.equal(
    U.govActorLabel({ via: 'dashboard', user: null, role: null, mode: 'password', device: null, ip: '10.0.0.9' }),
    'Dashboard · password · 10.0.0.9',
  );
  assert.equal(
    U.govQuery({ range: 'all', actor: '', user: ' Vera ', action: '', outcome: '' }, { now: NOW }),
    'user=vera&limit=100',
  );
  assert.deepEqual(U.GOV.filters, { range: '7', actor: '', user: '', action: '', outcome: '' });
  const form = U.govFiltersHtml({ range: '7', actor: '', user: '<b>x', action: '', outcome: '' });
  assert.match(
    form,
    /<label>User<input class="input" name="user" maxlength="32" placeholder="owner, an account…" value="&lt;b&gt;x"><\/label>/,
  );
});
```

In `test/users-http.test.js`, replace

```js
  const text = JSON.stringify(all);
  for (const secret of [VERA, REX, 'vera first 0001', 'rex first 00001', ADMIN])
    assert.ok(!text.includes(secret), secret);
  assert.ok(s.alive());
});

```

with

```js
  const text = JSON.stringify(all);
  for (const secret of [VERA, REX, 'vera first 0001', 'rex first 00001', ADMIN])
    assert.ok(!text.includes(secret), secret);
  // The audit list by account.
  const byRex = await call(s, '/api/governance/audit?user=rex&limit=500', { as: owner });
  assert.equal(byRex.status, 200);
  assert.ok(byRex.body.entries.length > 0 && byRex.body.entries.every((e) => e.actor.user === 'rex'));
  assert.ok(s.alive());
});

```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/users-audit.test.js test/users-http.test.js`
Expected: FAIL: 3 of 4: both tests of `test/users-audit.test.js` (no `user` filter, the CSV and the page name no account) and the first test of `test/users-http.test.js` (`?user=rex` is a 400).

- [ ] **Step 3: The filter, the CSV and the page**

In `lib/governance/api.js`, replace

```js
// The HTTP side of the governance audit log: /api/governance/*. server.js puts it behind the dashboard sign-in; no
// gateway key or MCP client reaches it (spec A9).
//   GET  /api/governance/audit?from&to&actor&action&outcome&limit&before  newest first, at most 500 per page
//   GET  /api/governance/audit/export?from&to&format=jsonl|csv          a download
//   GET  /api/governance/audit/verify                                    { ok, checked, from, to, brokenAt?, reason? }
//   GET  /api/governance/audit/status                                    retention, months, size, degraded, verify
```

with

```js
// The HTTP side of the governance audit log: /api/governance/*. server.js puts it behind the dashboard sign-in; no
// gateway key or MCP client reaches it (spec A9).
//   GET  /api/governance/audit?from&to&actor&user&action&outcome&limit&before  newest first, at most 500 per page
//   GET  /api/governance/audit/export?from&to&format=jsonl|csv          a download
//   GET  /api/governance/audit/verify                                    { ok, checked, from, to, brokenAt?, reason? }
//   GET  /api/governance/audit/status                                    retention, months, size, degraded, verify
```

In `lib/governance/api.js`, replace

```js
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
const KINDS = new Set(['dashboard', 'apikey', 'cli', 'system', 'rule']);
const KEY_ID = /^key_[A-Za-z0-9_-]{1,40}$/;
const OUTCOMES = new Set(['ok', 'refused', 'error']);
const MAX_REVIEWS = 2000;
const SOURCES_TTL_MS = 5000; // the sources are read again at most this often; the reviews on every build
```

with

```js
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
const KINDS = new Set(['dashboard', 'apikey', 'cli', 'system', 'rule']);
const KEY_ID = /^key_[A-Za-z0-9_-]{1,40}$/;
const USER = /^[a-z0-9][a-z0-9._-]{1,31}$/; // "owner" or an account name (lib/users/store.js NAME)
const OUTCOMES = new Set(['ok', 'refused', 'error']);
const MAX_REVIEWS = 2000;
const SOURCES_TTL_MS = 5000; // the sources are read again at most this often; the reviews on every build
```

In `lib/governance/api.js`, replace

```js
    if (!KINDS.has(actor) && !KEY_ID.test(actor))
      throw fail(400, 'actor: dashboard, apikey, cli, system, rule or a key id');
    out.actor = actor;
  }
  const action = q.get('action');
  if (action) {
```

with

```js
    if (!KINDS.has(actor) && !KEY_ID.test(actor))
      throw fail(400, 'actor: dashboard, apikey, cli, system, rule or a key id');
    out.actor = actor;
  }
  const user = q.get('user');
  if (user) {
    if (!USER.test(user)) throw fail(400, 'user: owner or an account name');
    out.user = user;
  }
  const action = q.get('action');
  if (action) {
```

In `lib/governance/audit.js`, replace

```js
  };
  const matches = (e, q) =>
    (!q.actor || (e.actor && (e.actor.via === q.actor || e.actor.keyId === q.actor))) &&
    (!q.outcome || e.outcome === q.outcome) &&
    (!q.action || `${e.action} ${e.op || ''}`.toLowerCase().includes(q.action.toLowerCase())) &&
    (q.before == null || e.seq < q.before);

  // list({ from, to, actor, action, outcome, limit, before }) -> { entries, next, skipped }: newest first, at most
  // `limit` (1-500); `next` is the `before` of the next page, or null.
  function list(q = {}) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(q.limit) || 100));
```

with

```js
  };
  const matches = (e, q) =>
    (!q.actor || (e.actor && (e.actor.via === q.actor || e.actor.keyId === q.actor))) &&
    (!q.user || (e.actor && e.actor.user === q.user)) &&
    (!q.outcome || e.outcome === q.outcome) &&
    (!q.action || `${e.action} ${e.op || ''}`.toLowerCase().includes(q.action.toLowerCase())) &&
    (q.before == null || e.seq < q.before);

  // list({ from, to, actor, user, action, outcome, limit, before }) -> { entries, next, skipped }: newest first, at most
  // `limit` (1-500); `next` is the `before` of the next page, or null.
  function list(q = {}) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(q.limit) || 100));
```

In `lib/governance/audit.js`, replace

```js
  return { record, list, export: exportOf, verify, status, prune, importPending };
}

// The CSV of an export: one line per entry, the changes as "path: from → to" joined with "; ".
const CSV_COLUMNS = [
  'seq',
  'time',
```

with

```js
  return { record, list, export: exportOf, verify, status, prune, importPending };
}

// The CSV of an export: one line per entry, the changes as "path: from → to" joined with "; ". actor_id is the account
// of a dashboard entry (AI Governance 4), else the key, the rule or the device.
const CSV_COLUMNS = [
  'seq',
  'time',
```

In `lib/governance/audit.js`, replace

```js
      e.seq,
      e.ts,
      a.via,
      a.keyId || a.rule || a.device || '',
      a.ip || '',
      e.action,
      e.op || '',
```

with

```js
      e.seq,
      e.ts,
      a.via,
      (a.via === 'dashboard' && a.user) || a.keyId || a.rule || a.device || '',
      a.ip || '',
      e.action,
      e.op || '',
```

In `public/governanceview.js`, replace

```js
   - Compliance (#governance/compliance): the controls from GET /api/governance/controls, one table per framework, and
     the evidence export (GET /api/governance/evidence?format=md|json).
   - Audit log (#governance/audit): every change made to ZAAFPulse by a person or an API key, from GET
     /api/governance/audit (newest first, a page at a time). Filters: the range, the kind of actor, action text and the
     outcome. Each row's field changes open in a <details>. Verify checks the chain (GET …/audit/verify), the export
     links download CSV or JSON lines, and the retention is saved with POST /api/governance/settings.
   Events are delegated (the CSP allows no inline handler); pure helpers are exported for Node tests, and nothing here
   touches the DOM at load time. Every server or owner string reaches the markup through esc(). */
```

with

```js
   - Compliance (#governance/compliance): the controls from GET /api/governance/controls, one table per framework, and
     the evidence export (GET /api/governance/evidence?format=md|json).
   - Audit log (#governance/audit): every change made to ZAAFPulse by a person or an API key, from GET
     /api/governance/audit (newest first, a page at a time). Filters: the range, the kind of actor, the account, action
     text and the outcome. Each row's field changes open in a <details>. Verify checks the chain (GET …/audit/verify), the export
     links download CSV or JSON lines, and the retention is saved with POST /api/governance/settings.
   Events are delegated (the CSP allows no inline handler); pure helpers are exported for Node tests, and nothing here
   touches the DOM at load time. Every server or owner string reaches the markup through esc(). */
```

In `public/governanceview.js`, replace

```js
  ['error', 'Error'],
];
const GOV = {
  filters: { range: '7', actor: '', action: '', outcome: '' },
  rows: [],
  next: null,
  hooked: false,
```

with

```js
  ['error', 'Error'],
];
const GOV = {
  filters: { range: '7', actor: '', user: '', action: '', outcome: '' },
  rows: [],
  next: null,
  hooked: false,
```

In `public/governanceview.js`, replace

```js
  const from = govFrom(f.range, now);
  if (from) q.set('from', from);
  if (f.actor) q.set('actor', f.actor);
  if (f.action) q.set('action', String(f.action).slice(0, 80));
  if (f.outcome) q.set('outcome', f.outcome);
  q.set('limit', '100');
```

with

```js
  const from = govFrom(f.range, now);
  if (from) q.set('from', from);
  if (f.actor) q.set('actor', f.actor);
  if (f.user) q.set('user', String(f.user).trim().toLowerCase().slice(0, 32));
  if (f.action) q.set('action', String(f.action).slice(0, 80));
  if (f.outcome) q.set('outcome', f.outcome);
  q.set('limit', '100');
```

In `public/governanceview.js`, replace

```js
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
```

with

```js
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${day} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** Who acted, in words: "Dashboard · vera (viewer) · password · 10.0.0.2", "API key key_ab12", "Monitors rule
 * tool_loop" … */
function govActorLabel(a) {
  if (!a || typeof a !== 'object') return 'Unknown';
  if (a.via === 'dashboard')
    return [
      'Dashboard',
      a.user ? `${a.user}${a.role && a.role !== a.user ? ` (${a.role})` : ''}` : '',
      a.mode,
      a.device ? `device ${a.device}` : '',
      a.ip,
    ]
      .filter(Boolean)
      .join(' · ');
  if (a.via === 'apikey') return `API key ${a.keyId || ''}`.trim();
  if (a.via === 'rule') return `Monitors rule ${a.rule || ''}`.trim();
  if (a.via === 'cli') return 'Command line';
```

In `public/governanceview.js`, replace

```js
  return `<form id="gov-filters" class="gov-bar">
    <label>${esc('Range')}${select('range', GOV_RANGES)}</label>
    <label>${esc('Actor')}${select('actor', GOV_ACTORS)}</label>
    <label>${esc('Action')}<input class="input" name="action" maxlength="80" placeholder="config.change, keys…" value="${esc(f.action)}"></label>
    <label>${esc('Outcome')}${select('outcome', GOV_OUTCOMES)}</label>
    <button class="btn" type="submit">${esc('Apply')}</button>
```

with

```js
  return `<form id="gov-filters" class="gov-bar">
    <label>${esc('Range')}${select('range', GOV_RANGES)}</label>
    <label>${esc('Actor')}${select('actor', GOV_ACTORS)}</label>
    <label>${esc('User')}<input class="input" name="user" maxlength="32" placeholder="owner, an account…" value="${esc(f.user || '')}"></label>
    <label>${esc('Action')}<input class="input" name="action" maxlength="80" placeholder="config.change, keys…" value="${esc(f.action)}"></label>
    <label>${esc('Outcome')}${select('outcome', GOV_OUTCOMES)}</label>
    <button class="btn" type="submit">${esc('Apply')}</button>
```

In `public/governanceview.js`, replace

```js
      GOV.filters = {
        range: String(data.get('range') || '7'),
        actor: String(data.get('actor') || ''),
        action: String(data.get('action') || '').trim(),
        outcome: String(data.get('outcome') || ''),
      };
```

with

```js
      GOV.filters = {
        range: String(data.get('range') || '7'),
        actor: String(data.get('actor') || ''),
        user: String(data.get('user') || '').trim(),
        action: String(data.get('action') || '').trim(),
        outcome: String(data.get('outcome') || ''),
      };
```

- [ ] **Step 4: Run the tests and the audit suites**

Run: `node --test test/users-audit.test.js test/users-http.test.js test/governance-api.test.js test/governance-audit.test.js test/governance-ui.test.js`
Expected: PASS (46 tests).

- [ ] **Step 5: Format**

Run: `npx prettier@3 --check lib/governance/audit.js lib/governance/api.js public/governanceview.js test/users-audit.test.js test/users-http.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add lib/governance/audit.js lib/governance/api.js public/governanceview.js test/users-audit.test.js test/users-http.test.js
git commit -m "Filter the audit log by account; the account is the CSV's actor_id and is named on the page"
```

### Task 6: the `access_roles` control

**Files:**
- Modify: `lib/governance/controls.js` (lines 21, 35, 55, 69, 389, 507)
- Modify: `server.js` (line 1258)
- Test: `test/governance-controls.test.js` (modify, lines 44, 62, 79, 109, 369, 412), `test/governance-evidence.test.js` (modify, line 68), `test/governance-inventory-http.test.js` (modify, lines 213, 229, 266), `test/users-controls.test.js` (create), `test/users-http.test.js` (modify, line 264)

**Interfaces:**
- Consumes: `userStore.list()` (Task 1), `auth.mode`; the existing `controls(state)` and `controlState()`.
- Produces (`lib/governance/controls.js`): the catalogue entry `access_roles` and the clauses `eu-26-2`,
  `nist-gv-2.1`, `iso-a3` (V9); `controls()` returns eighteen controls.
- Produces (`server.js`): `controlState().accounts → { mode, state, users: [{ role, disabled, createdAt, lastLoginAt
  }] }`.

- [ ] **Step 1: Write the failing test; eighteen controls in the existing tests**

In `test/governance-controls.test.js`, replace

```js
  budgets: [{ enforce: 'block' }, { enforce: 'none' }],
  secretStore: { id: 'keychain', label: 'macOS Keychain' },
  signIn: { mode: 'local', serverMode: false, tls: false },
  content: { otelCapture: false, traceContentOff: false },
  otel: { enabled: true, error: false, failed: 0, origin: 'https://otel.example.com', protocol: 'http/protobuf' },
  traces: { store: true, enabled: true, retentionDays: 190, maxBytes: 500 * 1048576 },
```

with

```js
  budgets: [{ enforce: 'block' }, { enforce: 'none' }],
  secretStore: { id: 'keychain', label: 'macOS Keychain' },
  signIn: { mode: 'local', serverMode: false, tls: false },
  accounts: { mode: 'local', state: 'ok', users: [] },
  content: { otelCapture: false, traceContentOff: false },
  otel: { enabled: true, error: false, failed: 0, origin: 'https://otel.example.com', protocol: 'http/protobuf' },
  traces: { store: true, enabled: true, retentionDays: 190, maxBytes: 500 * 1048576 },
```

In `test/governance-controls.test.js`, replace

```js
const statusOf = (state) => Object.fromEntries(controls(state).map((c) => [c.id, c.status]));
const one = (state, id) => controls(state).find((c) => c.id === id);

test('the catalogue: seventeen controls in a fixed order, each with a link and at least one clause', () => {
  assert.deepEqual(
    CATALOGUE.map((c) => c.id),
    [
```

with

```js
const statusOf = (state) => Object.fromEntries(controls(state).map((c) => [c.id, c.status]));
const one = (state, id) => controls(state).find((c) => c.id === id);

test('the catalogue: eighteen controls in a fixed order, each with a link and at least one clause', () => {
  assert.deepEqual(
    CATALOGUE.map((c) => c.id),
    [
```

In `test/governance-controls.test.js`, replace

```js
      'cost_budgets',
      'secret_store',
      'sign_in',
      'content_capture',
      'otel_export',
      'trace_retention',
```

with

```js
      'cost_budgets',
      'secret_store',
      'sign_in',
      'access_roles',
      'content_capture',
      'otel_export',
      'trace_retention',
```

In `test/governance-controls.test.js`, replace

```js
  );
  assert.deepEqual(
    CLAUSES.filter((c) => c.framework === 'eu-ai-act').map((c) => c.ref),
    ['Art. 12', 'Art. 14', 'Art. 26', 'Art. 50'],
  );
  assert.deepEqual(
    CLAUSES.filter((c) => c.framework === 'iso-42001').map((c) => c.ref),
    ['A.2', 'A.4', 'A.5', 'A.6', 'A.7', 'A.8', 'A.9', 'A.10'],
  );
  for (const c of CLAUSES.filter((x) => x.framework === 'nist-ai-rmf'))
    assert.match(c.ref, /^(GOVERN 1|MAP 1|MEASURE 2|MANAGE 2|MANAGE 4)\.\d+$/);
});

test('wording: the framework versions, "not a certification", and never "compliant"', () => {
```

with

```js
  );
  assert.deepEqual(
    CLAUSES.filter((c) => c.framework === 'eu-ai-act').map((c) => c.ref),
    ['Art. 12', 'Art. 14', 'Art. 26', 'Art. 26(2)', 'Art. 50'],
  );
  assert.deepEqual(
    CLAUSES.filter((c) => c.framework === 'iso-42001').map((c) => c.ref),
    ['A.2', 'A.3', 'A.4', 'A.5', 'A.6', 'A.7', 'A.8', 'A.9', 'A.10'],
  );
  for (const c of CLAUSES.filter((x) => x.framework === 'nist-ai-rmf'))
    assert.match(c.ref, /^(GOVERN 1|GOVERN 2|MAP 1|MEASURE 2|MANAGE 2|MANAGE 4)\.\d+$/);
});

test('wording: the framework versions, "not a certification", and never "compliant"', () => {
```

In `test/governance-controls.test.js`, replace

```js
  s.datasets = { count: 0, experiments: [] };
  s.budgets = [];
  s.signIn = { mode: 'none', serverMode: false, tls: false };
  s.content = { otelCapture: true, traceContentOff: true };
  s.otel = { enabled: false };
  s.traces = { store: true, enabled: false, retentionDays: 14, maxBytes: 1 };
```

with

```js
  s.datasets = { count: 0, experiments: [] };
  s.budgets = [];
  s.signIn = { mode: 'none', serverMode: false, tls: false };
  s.accounts = { mode: 'none', state: 'ok', users: [] };
  s.content = { otelCapture: true, traceContentOff: true };
  s.otel = { enabled: false };
  s.traces = { store: true, enabled: false, retentionDays: 14, maxBytes: 1 };
```

In `test/governance-controls.test.js`, replace

```js
  const r = await api.route({ method: 'GET', path: '/api/governance/controls', query: new URLSearchParams() });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['generatedAt', 'notice', 'frameworks', 'clauses', 'controls']);
  assert.equal(r.body.controls.length, 17);
  const by = Object.fromEntries(r.body.controls.map((c) => [c.id, c]));
  assert.equal(by.audit_log.evidence[0], 'kept 24 months (at least 6)');
  assert.deepEqual(
```

with

```js
  const r = await api.route({ method: 'GET', path: '/api/governance/controls', query: new URLSearchParams() });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['generatedAt', 'notice', 'frameworks', 'clauses', 'controls']);
  assert.equal(r.body.controls.length, 18);
  const by = Object.fromEntries(r.body.controls.map((c) => [c.id, c]));
  assert.equal(by.audit_log.evidence[0], 'kept 24 months (at least 6)');
  assert.deepEqual(
```

In `test/governance-evidence.test.js`, replace

```js
    'audit',
    'inventory',
  ]);
  assert.deepEqual([r.version, r.generatedAt, r.controls.length], ['1.0.4', '2026-11-03T12:00:00.000Z', 17]);
  assert.deepEqual(r.audit, audit);
  assert.deepEqual(r.inventory.failed, ['trace']);
  assert.equal(r.inventory.items[0].review.risk, 'high');
```

with

```js
    'audit',
    'inventory',
  ]);
  assert.deepEqual([r.version, r.generatedAt, r.controls.length], ['1.0.4', '2026-11-03T12:00:00.000Z', 18]);
  assert.deepEqual(r.audit, audit);
  assert.deepEqual(r.inventory.failed, ['trace']);
  assert.equal(r.inventory.items[0].review.risk, 'high');
```

In `test/governance-inventory-http.test.js`, replace

```js
  assert.ok(s.alive());
});

test('controls: seventeen controls from the live settings, OpenTelemetry and trace retention included', async (t) => {
  const s = await startServer(t, {}, prepare);
  const r = await call(s, '/api/governance/controls');
  assert.equal(r.status, 200);
  assert.match(r.body.notice, /^Evidence for your assessment, not a certification\./);
  assert.equal(r.body.controls.length, 17);
  const by = Object.fromEntries(r.body.controls.map((c) => [c.id, c]));
  for (const c of r.body.controls) assert.ok(STATUSES.includes(c.status), c.id);
  assert.deepEqual(by.guardrails.evidence, [
```

with

```js
  assert.ok(s.alive());
});

test('controls: eighteen controls from the live settings, OpenTelemetry and trace retention included', async (t) => {
  const s = await startServer(t, {}, prepare);
  const r = await call(s, '/api/governance/controls');
  assert.equal(r.status, 200);
  assert.match(r.body.notice, /^Evidence for your assessment, not a certification\./);
  assert.equal(r.body.controls.length, 18);
  const by = Object.fromEntries(r.body.controls.map((c) => [c.id, c]));
  for (const c of r.body.controls) assert.ok(STATUSES.includes(c.status), c.id);
  assert.deepEqual(by.guardrails.evidence, [
```

In `test/governance-inventory-http.test.js`, replace

```js
  ]);
  assert.equal(by.guardrails.status, 'partial');
  assert.deepEqual([by.sign_in.status, by.sign_in.evidence[0]], ['off', 'sign-in: no sign-in']);
  assert.deepEqual([by.otel_export.status, by.otel_export.evidence], ['off', ['not set up (see docs/otel.md)']]);
  assert.deepEqual(
    [by.trace_retention.status, by.trace_retention.evidence[0]],
```

with

```js
  ]);
  assert.equal(by.guardrails.status, 'partial');
  assert.deepEqual([by.sign_in.status, by.sign_in.evidence[0]], ['off', 'sign-in: no sign-in']);
  assert.deepEqual(
    [by.access_roles.status, by.access_roles.evidence],
    ['off', ['sign-in: no sign-in, so no accounts or roles']],
  );
  assert.deepEqual([by.otel_export.status, by.otel_export.evidence], ['off', ['not set up (see docs/otel.md)']]);
  assert.deepEqual(
    [by.trace_retention.status, by.trace_retention.evidence[0]],
```

In `test/governance-inventory-http.test.js`, replace

```js
  const json = await call(s, '/api/governance/evidence?format=json');
  assert.equal(json.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(json.body.version, require('../package.json').version);
  assert.equal(json.body.controls.length, 17);
  assert.ok(json.body.inventory.items.some((i) => i.id === 'mcp:db' && !('projects' in i)));
  for (const text of [md.text, json.text]) {
    assert.ok(!text.includes(s.data), 'no path');
```

with

```js
  const json = await call(s, '/api/governance/evidence?format=json');
  assert.equal(json.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(json.body.version, require('../package.json').version);
  assert.equal(json.body.controls.length, 18);
  assert.ok(json.body.inventory.items.some((i) => i.id === 'mcp:db' && !('projects' in i)));
  for (const text of [md.text, json.text]) {
    assert.ok(!text.includes(s.data), 'no path');
```

Create `test/users-controls.test.js`:

```js
// Dashboard users (AI Governance 4) on the Compliance page: the access_roles control (lib/governance/controls.js). In
// place when sign-in is required and no account has gone unused for over 90 days; partial when one has (an access
// review is due), naming the count only; off without sign-in; unknown when the accounts file cannot be read. Its
// clauses: EU AI Act Art. 26(2), NIST AI RMF GOVERN 2.1, ISO/IEC 42001 A.3.
const test = require('node:test');
const assert = require('node:assert/strict');
const { controls, CATALOGUE } = require('../lib/governance/controls');

const NOW = Date.UTC(2026, 10, 4, 12);
const DAY = 864e5;
const at = (days) => new Date(NOW - days * DAY).toISOString();
const roles = (accounts) => controls({ now: NOW, accounts }).find((c) => c.id === 'access_roles');

test('access_roles: in place, partial with the count of unused accounts, off without sign-in, unknown unread', () => {
  const c = CATALOGUE.find((x) => x.id === 'access_roles');
  assert.deepEqual([c.title, c.link, c.part], ['Dashboard roles and access reviews', '#settings/users', 'accounts']);
  assert.deepEqual(
    roles({ mode: 'password', state: 'ok', users: [] }).clauses.map((x) => `${x.framework} ${x.ref} ${x.title}`),
    [
      'eu-ai-act Art. 26(2) Human oversight assigned to competent persons',
      'nist-ai-rmf GOVERN 2.1 Roles and responsibilities documented',
      'iso-42001 A.3 Internal organization',
    ],
  );
  const pick = (r) => [r.status, r.evidence];
  assert.deepEqual(pick(roles({ mode: 'password', state: 'ok', users: [] })), ['in place', ['the owner only']]);
  const users = [
    { role: 'viewer', disabled: false, createdAt: at(200), lastLoginAt: at(3) },
    { role: 'reviewer', disabled: false, createdAt: at(10), lastLoginAt: null },
    { role: 'viewer', disabled: true, createdAt: at(400), lastLoginAt: null },
  ];
  assert.deepEqual(pick(roles({ mode: 'local', state: 'ok', users })), [
    'in place',
    ['the owner and 2 accounts (1 reviewer, 1 viewer)', '1 account disabled'],
  ]);
  // A viewer last seen 91 days ago, a reviewer created 120 days ago who never signed in: two unused.
  users[0].lastLoginAt = at(91);
  users[1].createdAt = at(120);
  const partial = roles({ mode: 'password', state: 'ok', users });
  assert.deepEqual(pick(partial), [
    'partial',
    [
      'the owner and 2 accounts (1 reviewer, 1 viewer)',
      '1 account disabled',
      '2 accounts unused for over 90 days: an access review is due',
    ],
  ]);
  // Exactly 90 days is not over 90.
  assert.equal(
    roles({ mode: 'password', state: 'ok', users: [{ role: 'viewer', lastLoginAt: at(90) }] }).status,
    'in place',
  );
  assert.deepEqual(pick(roles({ mode: 'none', state: 'ok', users })), [
    'off',
    ['sign-in: no sign-in, so no accounts or roles'],
  ]);
  assert.deepEqual(pick(roles({ mode: 'password', state: 'unreadable', users: [] })), [
    'unknown',
    ['users.json could not be read'],
  ]);
  assert.deepEqual(pick(controls({ now: NOW }).find((x) => x.id === 'access_roles')), [
    'unknown',
    ['could not be read'],
  ]);
});
```

In `test/users-http.test.js`, replace

```js
  const text = JSON.stringify(all);
  for (const secret of [VERA, REX, 'vera first 0001', 'rex first 00001', ADMIN])
    assert.ok(!text.includes(secret), secret);
  // The audit list by account.
  const byRex = await call(s, '/api/governance/audit?user=rex&limit=500', { as: owner });
  assert.equal(byRex.status, 200);
```

with

```js
  const text = JSON.stringify(all);
  for (const secret of [VERA, REX, 'vera first 0001', 'rex first 00001', ADMIN])
    assert.ok(!text.includes(secret), secret);
  // The Compliance page counts the accounts that may sign in (no name).
  const controls = await call(s, '/api/governance/controls', { as: owner });
  const roles = controls.body.controls.find((c) => c.id === 'access_roles');
  assert.deepEqual(
    [roles.status, roles.evidence],
    ['in place', ['the owner and 1 account (0 reviewers, 1 viewer)', '1 account disabled']],
  );
  // The audit list by account.
  const byRex = await call(s, '/api/governance/audit?user=rex&limit=500', { as: owner });
  assert.equal(byRex.status, 200);
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/users-controls.test.js test/users-http.test.js test/governance-controls.test.js test/governance-evidence.test.js test/governance-inventory-http.test.js`
Expected: FAIL: 7 of 34: the test of `test/users-controls.test.js`, the first of `test/users-http.test.js`, 2 of 16 in `test/governance-controls.test.js` (the catalogue, the GET route), 1 of 8 in `test/governance-evidence.test.js` and 2 of 7 in `test/governance-inventory-http.test.js` (seventeen controls, no `access_roles`).

- [ ] **Step 3: The control, its clauses and its state**

In `lib/governance/controls.js`, replace

```js
    ref: 'Art. 26',
    title: 'Deployer obligations: logs kept at least 6 months, oversight assigned, monitoring',
  },
  { id: 'eu-50', framework: 'eu-ai-act', ref: 'Art. 50', title: "Transparency, where the owner's use applies" },
  {
    id: 'nist-gv-1.4',
```

with

```js
    ref: 'Art. 26',
    title: 'Deployer obligations: logs kept at least 6 months, oversight assigned, monitoring',
  },
  {
    id: 'eu-26-2',
    framework: 'eu-ai-act',
    ref: 'Art. 26(2)',
    title: 'Human oversight assigned to competent persons',
  },
  { id: 'eu-50', framework: 'eu-ai-act', ref: 'Art. 50', title: "Transparency, where the owner's use applies" },
  {
    id: 'nist-gv-1.4',
```

In `lib/governance/controls.js`, replace

```js
    title: 'Risk management through policies, procedures and controls',
  },
  { id: 'nist-gv-1.6', framework: 'nist-ai-rmf', ref: 'GOVERN 1.6', title: 'An inventory of AI systems' },
  { id: 'nist-mp-1.1', framework: 'nist-ai-rmf', ref: 'MAP 1.1', title: 'Intended purposes and context documented' },
  { id: 'nist-ms-2.1', framework: 'nist-ai-rmf', ref: 'MEASURE 2.1', title: 'Test sets, metrics and tools documented' },
  {
```

with

```js
    title: 'Risk management through policies, procedures and controls',
  },
  { id: 'nist-gv-1.6', framework: 'nist-ai-rmf', ref: 'GOVERN 1.6', title: 'An inventory of AI systems' },
  { id: 'nist-gv-2.1', framework: 'nist-ai-rmf', ref: 'GOVERN 2.1', title: 'Roles and responsibilities documented' },
  { id: 'nist-mp-1.1', framework: 'nist-ai-rmf', ref: 'MAP 1.1', title: 'Intended purposes and context documented' },
  { id: 'nist-ms-2.1', framework: 'nist-ai-rmf', ref: 'MEASURE 2.1', title: 'Test sets, metrics and tools documented' },
  {
```

In `lib/governance/controls.js`, replace

```js
    title: 'Post-deployment monitoring, override and change management',
  },
  { id: 'iso-a2', framework: 'iso-42001', ref: 'A.2', title: 'Policies related to AI' },
  { id: 'iso-a4', framework: 'iso-42001', ref: 'A.4', title: 'Resources for AI systems' },
  { id: 'iso-a5', framework: 'iso-42001', ref: 'A.5', title: 'Assessing impacts of AI systems' },
  { id: 'iso-a6', framework: 'iso-42001', ref: 'A.6', title: 'AI system life cycle' },
```

with

```js
    title: 'Post-deployment monitoring, override and change management',
  },
  { id: 'iso-a2', framework: 'iso-42001', ref: 'A.2', title: 'Policies related to AI' },
  { id: 'iso-a3', framework: 'iso-42001', ref: 'A.3', title: 'Internal organization' },
  { id: 'iso-a4', framework: 'iso-42001', ref: 'A.4', title: 'Resources for AI systems' },
  { id: 'iso-a5', framework: 'iso-42001', ref: 'A.5', title: 'Assessing impacts of AI systems' },
  { id: 'iso-a6', framework: 'iso-42001', ref: 'A.6', title: 'AI system life cycle' },
```

In `lib/governance/controls.js`, replace

```js
const KEY_RULES = ['guardrail_block', 'audit_chain_broken', 'inventory_unreviewed'];
const SIX_MONTHS_DAYS = 183;
const RECENT_DAYS = 90; // an experiment finished this recently counts as testing that happens
const DAY_MS = 864e5;
const RANK = { off: 0, log: 1, redact: 2, block: 3 };

```

with

```js
const KEY_RULES = ['guardrail_block', 'audit_chain_broken', 'inventory_unreviewed'];
const SIX_MONTHS_DAYS = 183;
const RECENT_DAYS = 90; // an experiment finished this recently counts as testing that happens
const UNUSED_DAYS = 90; // an account not signed in to for longer is due an access review (AI Governance 4)
const DAY_MS = 864e5;
const RANK = { off: 0, log: 1, redact: 2, block: 3 };

```

In `lib/governance/controls.js`, replace

```js
    },
  },
  {
    id: 'content_capture',
    title: 'Content capture off',
    clauses: ['nist-ms-2.10', 'iso-a7'],
```

with

```js
    },
  },
  {
    // AI Governance 4: who may do what on the dashboard, and whether an access review is due. Counts only, no name.
    id: 'access_roles',
    title: 'Dashboard roles and access reviews',
    clauses: ['eu-26-2', 'nist-gv-2.1', 'iso-a3'],
    link: '#settings/users',
    part: 'accounts',
    check(a, s) {
      if (a.mode === 'none') return { status: 'off', evidence: ['sign-in: no sign-in, so no accounts or roles'] };
      if (a.state === 'unreadable') return { status: 'unknown', evidence: ['users.json could not be read'] };
      const users = arr(a.users);
      const active = users.filter((u) => u.disabled !== true);
      // Unused: no sign-in (or, never signed in, no creation) in the last 90 days.
      const unused = active.filter((u) => {
        const t = Date.parse(u.lastLoginAt || u.createdAt);
        return !Number.isFinite(t) || n(s.now) - t > UNUSED_DAYS * DAY_MS;
      }).length;
      const roles = ['reviewer', 'viewer'].map((r) => plural(active.filter((u) => u.role === r).length, r));
      const off = users.length - active.length;
      return {
        status: unused ? 'partial' : 'in place',
        evidence: [
          active.length ? `the owner and ${plural(active.length, 'account')} (${roles.join(', ')})` : 'the owner only',
          ...(off ? [`${plural(off, 'account')} disabled`] : []),
          ...(unused ? [`${plural(unused, 'account')} unused for over 90 days: an access review is due`] : []),
        ],
      };
    },
  },
  {
    id: 'content_capture',
    title: 'Content capture off',
    clauses: ['nist-ms-2.10', 'iso-a7'],
```

In `lib/governance/controls.js`, replace

```js

// controls(state) -> [{ id, title, status, evidence: [text], link, clauses: [{ id, framework, ref, title }] }].
// state: { now, guardrails, audit, usage, providers, keys, workflows, agentControl, monitors, evals, datasets, budgets,
// secretStore, signIn, content, otel, traces, inventory }; a part that is null or missing could not be read.
function controls(state) {
  const s = isObj(state) ? state : {};
  const byId = new Map(CLAUSES.map((c) => [c.id, c]));
```

with

```js

// controls(state) -> [{ id, title, status, evidence: [text], link, clauses: [{ id, framework, ref, title }] }].
// state: { now, guardrails, audit, usage, providers, keys, workflows, agentControl, monitors, evals, datasets, budgets,
// secretStore, signIn, accounts, content, otel, traces, inventory }; a part that is null or missing could not be read.
function controls(state) {
  const s = isObj(state) ? state : {};
  const byId = new Map(CLAUSES.map((c) => [c.id, c]));
```

In `server.js`, replace

```js
      return { id: s.id, label: s.label };
    },
    signIn: () => ({ mode: auth.mode, serverMode: SERVER_MODE, tls: !!TLS }),
    content: () => ({ otelCapture: otel.status().captureContent === true, traceContentOff: contentOff }),
    otel: () => {
      const o = otel.status();
```

with

```js
      return { id: s.id, label: s.label };
    },
    signIn: () => ({ mode: auth.mode, serverMode: SERVER_MODE, tls: !!TLS }),
    // AI Governance 4: the accounts' roles and last sign-ins (no name leaves the control).
    accounts: () => {
      if (auth.mode === 'none' || !userStore) return { mode: auth.mode, state: 'ok', users: [] };
      const r = userStore.list();
      return {
        mode: auth.mode,
        state: r.state,
        users: r.users.map((u) => ({
          role: u.role,
          disabled: u.disabled,
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt,
        })),
      };
    },
    content: () => ({ otelCapture: otel.status().captureContent === true, traceContentOff: contentOff }),
    otel: () => {
      const o = otel.status();
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/users-controls.test.js test/users-http.test.js test/governance-controls.test.js test/governance-evidence.test.js test/governance-inventory-http.test.js test/governance-inventory-ui.test.js`
Expected: PASS (40 tests).

- [ ] **Step 5: Format**

Run: `npx prettier@3 --check lib/governance/controls.js test/users-controls.test.js test/users-http.test.js test/governance-controls.test.js test/governance-evidence.test.js test/governance-inventory-http.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath server.js < server.js | diff server.js - | grep -c '^[<>]'`
Expected: `7`

- [ ] **Step 6: Commit**

```bash
git add lib/governance/controls.js server.js test/users-controls.test.js test/users-http.test.js test/governance-controls.test.js test/governance-evidence.test.js test/governance-inventory-http.test.js
git commit -m "Add the access_roles control to the Compliance page"
```

### Task 7: the dashboard: Settings → Users, the top bar, the banner, 403s, the review drawer, the sign-in page

**Files:**
- Create: `public/usersview.js`
- Modify: `public/app.js` (lines 246, 273, 314, 1156, 1169, 1326)
- Modify: `public/governanceview.js` (lines 2, 38, 281, 294, 322, 351, 453, 467, 481, 616)
- Modify: `public/index.html` (lines 81, 109, 155)
- Modify: `public/iso.js` (line 600)
- Modify: `public/login.html` (line 28)
- Modify: `public/login.js` (line 1)
- Modify: `public/styles.css` (line 10036)
- Test: `test/users-ui.test.js` (create)

**Interfaces:**
- Consumes: `GET /api/session` (Task 2), `GET|POST /api/users`, `GET /api/users/names`, `POST /api/account/password`
  (Task 4); the existing `api`, `esc`, `$`, `$$`, `subTabs`, `subHero`, `holoEmpty`, `signOut`, `viewSettings`,
  `SUBPAGES`.
- Produces (`public/usersview.js`): `USR`, `USR_ROLES`, `usrRoleLabel(role)`, `usrErrorText(err)`, `usrWhen(ts)`,
  `usrBannerText(me)`, `usrWhoText(me)`, `usrStateTag(u)`, `usrRowsHtml(users)`, `usrAddFormHtml()`,
  `usrResetFormHtml(name)`, `usrBodyHtml(data)`, `usrView()`, `usrMount(el)` (U1).
- Produces (`public/app.js`): `ZP.me` (the `/api/session` answer), `isOwner()`; `api()` turns `403 change your
  password first` into a move to `/login.html` and `403 your role cannot do this` into `Error('Your role cannot do
  this')`.
- Produces (`public/governanceview.js`): `govCanReview(role)`, `govRole()`, `govInvRowsHtml(items, canReview = true)`,
  `govReviewFormHtml(item, names = [])`, `GOV.inv.names`.
- Produces (`public/iso.js`): `SUBPAGES.settings` = `[['', 'Preferences'], ['users', 'Users']]`.

- [ ] **Step 1: Write the failing UI test**

Create `test/users-ui.test.js`:

```js
// Dashboard users and roles (AI Governance 4) in the browser files, without a browser: Settings → Users
// (public/usersview.js), the role banner and the identity line, the review drawer for reviewers with the accounts'
// names suggested (public/governanceview.js), the 403 messages and the hidden owner controls (public/app.js), the
// sign-in page's name field and change-password step (public/login.html, public/login.js); and an audit of
// usersview.js for server or owner text put into markup without esc() (S1).
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
global.subTabs = (route) => `<nav class="subtabs">${route}</nav>`;
const U = require('../public/usersview');
const G = require('../public/governanceview');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

test('the banner and the identity line say who is signed in and what the role may do', () => {
  assert.equal(
    U.usrBannerText({ user: 'vera', role: 'viewer', display: 'Vera' }),
    'Signed in as Vera · Viewer · read-only',
  );
  assert.equal(
    U.usrBannerText({ user: 'rex', role: 'reviewer', display: '' }),
    'Signed in as rex · Reviewer · reviews and approvals',
  );
  assert.equal(U.usrBannerText({ user: 'owner', role: 'owner', display: 'Rifqi' }), '');
  assert.equal(U.usrBannerText(null), '');
  assert.equal(U.usrWhoText({ user: 'vera', role: 'viewer', display: 'Vera' }), 'Vera · Viewer');
  assert.equal(U.usrWhoText({ user: 'owner', role: 'owner', display: 'Rifqi' }), 'Rifqi · Owner');
  assert.equal(U.usrRoleLabel('reviewer'), 'Reviewer');
  assert.equal(U.usrWhen(null), 'never');
  assert.match(U.usrWhen('2026-11-04T09:05:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(
    U.usrErrorText(new Error('400 {"error":"name: already taken","errors":["name: already taken"]}')),
    'name: already taken',
  );
});

test('Settings → Users: off without sign-in, a warning for an unreadable file, else the accounts and the add form', () => {
  assert.match(
    U.usrBodyHtml({ state: 'off', users: [] }),
    /Sign-in is off \(ZAAFPULSE_AUTH=none\), so there are no accounts/,
  );
  const bad = U.usrBodyHtml({ state: 'unreadable', users: [] });
  assert.match(bad, /<div class="gov-banner">users\.json could not be read: nobody in it can sign in/);
  assert.ok(!bad.includes('id="usr-add"'), 'nothing is added over an unreadable file');
  const users = [
    { name: 'rex', display: 'Rex', role: 'reviewer', lastLoginAt: null, disabled: false, mustChange: true },
    {
      name: 'vera',
      display: '',
      role: 'viewer',
      lastLoginAt: '2026-11-04T09:00:00Z',
      disabled: true,
      mustChange: false,
    },
  ];
  const html = U.usrBodyHtml({ state: 'ok', users });
  assert.match(html, /<th>Name<\/th><th>Display name<\/th><th>Role<\/th><th>Last sign-in<\/th><th>State<\/th>/);
  assert.match(
    html,
    /<select class="input" data-usr-role="rex" aria-label="Role of rex"><option value="viewer">Viewer<\/option><option value="reviewer" selected>Reviewer<\/option><\/select>/,
  );
  assert.match(html, /<span class="tag warn">New password due<\/span>/);
  assert.match(html, /<span class="tag warn">Disabled<\/span>/);
  assert.match(html, /data-usr-toggle="vera">Enable<\/button>/);
  assert.match(html, /data-usr-toggle="rex">Disable<\/button>/);
  assert.match(
    html,
    /data-usr-reset="rex">Reset password<\/button><button class="btn ghost" type="button" data-usr-delete="rex">Delete<\/button>/,
  );
  assert.match(html, /<form id="usr-add"/);
  assert.match(html, /name="password" type="password" required minlength="12" autocomplete="new-password"/);
  assert.match(U.usrBodyHtml({ state: 'ok', users: [] }), /No accounts yet: only the owner signs in\./);
  assert.match(U.usrResetFormHtml('rex'), /<form id="usr-reset" class="gov-bar" data-usr-name="rex"/);
  assert.match(
    U.usrView(),
    /SETTINGS · USERS\|Users\|People who sign in to this dashboard with their own name and password\./,
  );
  assert.match(U.usrView(), /<nav class="subtabs">settings<\/nav>/);
});

test('the Inventory review: the button and the drawer for the owner and reviewers only; the owner field suggests names', () => {
  assert.deepEqual(
    [null, 'owner', 'reviewer', 'viewer'].map((r) => G.govCanReview(r)),
    [true, true, true, false],
  );
  const item = {
    id: 'app:claude',
    kind: 'app',
    name: 'Claude Code',
    where: ['running'],
    state: 'running',
    status: 'unreviewed',
  };
  assert.match(G.govInvRowsHtml([item]), /data-gov-review="app:claude">Review<\/button>/);
  assert.ok(!G.govInvRowsHtml([item], false).includes('data-gov-review'), 'a viewer gets no Review button');
  const form = G.govReviewFormHtml(item, ['Rifqi', 'Ana <x>']);
  assert.match(form, /name="owner" maxlength="200" value="" autocomplete="off" list="gov-owner-names">/);
  assert.match(
    form,
    /<datalist id="gov-owner-names"><option value="Rifqi"><\/option><option value="Ana &lt;x&gt;"><\/option><\/datalist>/,
  );
  assert.match(G.govReviewFormHtml(item), /<datalist id="gov-owner-names"><\/datalist>/);
});

test('wiring: the script, the Users sub-link, the top bar, the banner, the 403 messages and the hidden owner controls', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('usersview.js') > html.indexOf('governanceview.js'));
  assert.ok(html.indexOf('usersview.js') < html.indexOf('src="app.js"'));
  assert.match(html, /<a class="nav-sub" href="#settings\/users" data-route="settings\/users">Users<\/a>/);
  assert.match(html, /<div class="nav-label" id="nav-prefs">PREFERENCES<\/div>/);
  assert.match(
    html,
    /<div class="topbar-who" id="topbar-who" hidden><span id="who-text"><\/span> <a class="link-btn" id="who-password" href="\/login\.html\?change=1">Change password<\/a> <button class="link-btn" type="button" id="who-out">Sign out<\/button><\/div>/,
  );
  assert.match(
    html,
    /<div class="role-banner" id="role-banner" role="status" hidden><\/div>\s*<div class="content" id="view"/,
  );
  assert.match(read('iso.js'), /settings: \[\s*\['', 'Preferences'\],\s*\['users', 'Users'\],\s*\]/);
  const app = read('app.js');
  assert.match(app, /if \(error === 'change your password first'\) \{\s*location\.href = '\/login\.html';/);
  assert.match(app, /if \(error === 'your role cannot do this'\) throw new Error\('Your role cannot do this'\);/);
  assert.match(app, /return state\.sub === 'users' \? usrMount\(el\) : viewSettings\(el\);/);
  assert.match(app, /holoEmpty\('Settings and Users are for the owner of this dashboard\.'\)/);
  assert.match(
    app,
    /for \(const el of \$\$\('nav a\[data-route\^="settings"\], #nav-prefs, #rescan'\)\) el\.hidden = true;/,
  );
  assert.match(app, /banner\.textContent = usrBannerText\(ZP\.me\);/);
  assert.ok(read('styles.css').includes('.role-banner'));
});

test('the sign-in page: a name field, the change-password step, and the routes it calls', () => {
  const html = read('login.html');
  assert.match(
    html,
    /<label for="nm">Name<\/label>\s*<input id="nm" name="name" autocomplete="username"[^>]*placeholder="Empty for the admin password"/,
  );
  assert.match(html, /<label for="pw" style="margin-top:12px">Password<\/label>/);
  assert.ok(!html.includes('Admin password<'));
  const js = read('login.js');
  assert.match(js, /body: JSON\.stringify\(\{ \.\.\.\(name \? \{ name \} : \{\}\), password: \$id\('pw'\)\.value \}\)/);
  assert.match(js, /fetch\('\/api\/account\/password'/);
  assert.match(js, /'Choose your own password before you go on: at least 12 characters\.'/);
  assert.match(js, /if \(s\.signedIn && s\.mustChange\) return showChange\(true\);/);
  assert.match(js, /Others sign in here with the name and password the owner gave them\./);
  assert.match(js, /The new passwords do not match\./);
});

test('usersview.js puts no server or owner text into markup unescaped (S1) and loads in Node', () => {
  const x = '<x>';
  const users = [{ name: x, display: x, role: x, lastLoginAt: x, disabled: false, mustChange: false }];
  const html = [U.usrBodyHtml({ state: 'ok', users }), U.usrResetFormHtml(x), U.usrRowsHtml(users)].join('');
  assert.ok(!html.includes('<x>'), 'a field reached the markup unescaped');
  const src = read('usersview.js');
  for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g))
    assert.match(m[1].trim(), /^(usr[A-Z]\w*Html\(|usrView\(|`)/, `innerHTML from ${m[1].trim().slice(0, 40)}`);
  for (const m of src.matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(m[1], /^(usr|USR)/, m[1]);
  assert.equal(typeof document, 'undefined', 'loaded above with no DOM at all');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/users-ui.test.js`
Expected: FAIL: `Cannot find module '../public/usersview'` (the file fails as one test).

- [ ] **Step 3: The pages**

In `public/app.js`, replace

```js
    location.href = '/login.html';
    throw new Error('signed out');
  } // server mode: session ended
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
```

with

```js
    location.href = '/login.html';
    throw new Error('signed out');
  } // server mode: session ended
  if (r.status === 403) {
    // The role policy (AI Governance 4): a new password first, or a request this role may not make.
    const text = await r.text();
    let error = '';
    try {
      error = JSON.parse(text).error || '';
    } catch {
      /* not JSON */
    }
    if (error === 'change your password first') {
      location.href = '/login.html';
      throw new Error('Change your password first');
    }
    if (error === 'your role cannot do this') throw new Error('Your role cannot do this');
    throw new Error(`403 ${text}`);
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
```

In `public/app.js`, replace

```js
  serverMode: false,
  auth: false,
  baseUrl: location.origin,
};
const storeName = () => ({ keychain: 'Keychain', libsecret: 'keyring' })[ZP.secretStore.id] || 'secret file';
const storeLong = () => ZP.secretStore.label || 'secret store';
const localOnlyLabel = () => (ZP.serverMode ? 'server mode · sign-in' : '127.0.0.1 only');
```

with

```js
  serverMode: false,
  auth: false,
  baseUrl: location.origin,
  me: null, // who is signed in (GET /api/session): { user, role, display }
};
// The owner may do everything; a reviewer or a viewer sees no Settings, Users or Rescan (the server is the authority).
const isOwner = () => !ZP.me || !ZP.me.role || ZP.me.role === 'owner';
const storeName = () => ({ keychain: 'Keychain', libsecret: 'keyring' })[ZP.secretStore.id] || 'secret file';
const storeLong = () => ZP.secretStore.label || 'secret store';
const localOnlyLabel = () => (ZP.serverMode ? 'server mode · sign-in' : '127.0.0.1 only');
```

In `public/app.js`, replace

```js
  const d = state.data;
  const live = state.live;
  if (d) {
    $('#user-name').textContent = d.config.userName;
    $('#user-initials').textContent = initials(d.config.userName);
    $('#ws-host').textContent = d.config.host || 'This laptop';
    $('#ws-initials').textContent = initials((d.config.host || 'ML').replace(/[-_]/g, ' '));
    $('#b-sessions').textContent = d.kpis.sessions || '';
```

with

```js
  const d = state.data;
  const live = state.live;
  if (d) {
    const shown = isOwner() ? d.config.userName : ZP.me.display || ZP.me.user;
    $('#user-name').textContent = shown;
    $('#user-initials').textContent = initials(shown);
    $('#ws-host').textContent = d.config.host || 'This laptop';
    $('#ws-initials').textContent = initials((d.config.host || 'ML').replace(/[-_]/g, ' '));
    $('#b-sessions').textContent = d.kpis.sessions || '';
```

In `public/app.js`, replace

```js
        : a.dataset.route === state.route,
    );
  // Sub-pages show only under the section you are in, so the whole menu fits without scrolling.
  for (const a of $$('nav a.nav-sub')) a.hidden = a.dataset.route.split('/')[0] !== state.route;
  for (const a of $$('nav a:not(.nav-sub)'))
    a.classList.toggle(
      'open',
```

with

```js
        : a.dataset.route === state.route,
    );
  // Sub-pages show only under the section you are in, so the whole menu fits without scrolling.
  // A reviewer or a viewer never sees the Settings sub-links (AI Governance 4).
  for (const a of $$('nav a.nav-sub'))
    a.hidden = a.dataset.route.split('/')[0] !== state.route || (!isOwner() && a.dataset.route.startsWith('settings'));
  for (const a of $$('nav a:not(.nav-sub)'))
    a.classList.toggle(
      'open',
```

In `public/app.js`, replace

```js
  el.classList.toggle('animate', animate && !reduceMotion.matches);
  unmountBrain();
  unmountStages();
  if (state.route === 'settings') return viewSettings(el);
  // The Governance pages (Inventory, Compliance, Audit log) load their own data (public/governanceview.js): they never
  // wait for the summary.
  if (state.route === 'governance') {
```

with

```js
  el.classList.toggle('animate', animate && !reduceMotion.matches);
  unmountBrain();
  unmountStages();
  if (state.route === 'settings') {
    if (!isOwner()) {
      el.innerHTML = holoEmpty('Settings and Users are for the owner of this dashboard.');
      return;
    }
    return state.sub === 'users' ? usrMount(el) : viewSettings(el);
  }
  // The Governance pages (Inventory, Compliance, Audit log) load their own data (public/governanceview.js): they never
  // wait for the summary.
  if (state.route === 'governance') {
```

In `public/app.js`, replace

```js

(async function boot() {
  Object.assign(ZP, await api('/api/platform').catch(() => ({})));
  if (ZP.auth) {
    const role = $('.user-role');
    if (role) role.innerHTML = '<button class="link-btn" type="button" id="sign-out">Admin · sign out</button>';
    $('#sign-out')?.addEventListener('click', signOut);
  } else if (ZP.os !== 'macos') {
    const role = $('.user-role');
    if (role) role.textContent = `${ZP.osLabel} · local`;
```

with

```js

(async function boot() {
  Object.assign(ZP, await api('/api/platform').catch(() => ({})));
  ZP.me = await fetch('/api/session')
    .then((r) => r.json())
    .catch(() => null);
  if (ZP.auth) {
    const role = $('.user-role');
    if (role)
      role.innerHTML = `<button class="link-btn" type="button" id="sign-out">${esc(`${usrRoleLabel((ZP.me && ZP.me.role) || 'owner')} · sign out`)}</button>`;
    $('#sign-out')?.addEventListener('click', signOut);
    // The top bar: who is signed in, their role, a sign-out link and (for an account) the password page.
    const who = $('#topbar-who');
    if (who && ZP.me && ZP.me.signedIn) {
      who.hidden = false;
      $('#who-text').textContent = usrWhoText(ZP.me);
      $('#who-password').hidden = isOwner();
      $('#who-out').addEventListener('click', signOut);
    }
    // A reviewer or a viewer: the role banner, and no Settings, Users or Rescan.
    const banner = $('#role-banner');
    if (banner && !isOwner()) {
      banner.textContent = usrBannerText(ZP.me);
      banner.hidden = false;
      for (const el of $$('nav a[data-route^="settings"], #nav-prefs, #rescan')) el.hidden = true;
    }
  } else if (ZP.os !== 'macos') {
    const role = $('.user-role');
    if (role) role.textContent = `${ZP.osLabel} · local`;
```

In `public/governanceview.js`, replace

```js
/* The Governance menu's three pages (AI Governance 2 and 3).
   - Inventory (#governance): every AI system ZAAFPulse can see, from GET /api/governance/inventory, filtered by kind,
     state and review in the page; a drawer records an item's owner, purpose, risk and decision (POST
     /api/governance/inventory).
   - Compliance (#governance/compliance): the controls from GET /api/governance/controls, one table per framework, and
     the evidence export (GET /api/governance/evidence?format=md|json).
   - Audit log (#governance/audit): every change made to ZAAFPulse by a person or an API key, from GET
```

with

```js
/* The Governance menu's three pages (AI Governance 2 and 3).
   - Inventory (#governance): every AI system ZAAFPulse can see, from GET /api/governance/inventory, filtered by kind,
     state and review in the page; a drawer records an item's owner, purpose, risk and decision (POST
     /api/governance/inventory). Only the owner and reviewers review (AI Governance 4); the owner field suggests the
     dashboard accounts' display names (GET /api/users/names).
   - Compliance (#governance/compliance): the controls from GET /api/governance/controls, one table per framework, and
     the evidence export (GET /api/governance/evidence?format=md|json).
   - Audit log (#governance/audit): every change made to ZAAFPulse by a person or an API key, from GET
```

In `public/governanceview.js`, replace

```js
  rows: [],
  next: null,
  hooked: false,
  inv: { filters: { kind: '', state: '', review: '' }, data: null, open: null },
};

/* ---------- pure helpers (exported) ---------- */
```

with

```js
  rows: [],
  next: null,
  hooked: false,
  inv: { filters: { kind: '', state: '', review: '' }, data: null, open: null, names: [] },
};

/* ---------- pure helpers (exported) ---------- */
```

In `public/governanceview.js`, replace

```js
  const text = i.status === 'gone' ? ['Gone', words].filter(Boolean).join(' · ') : words || 'Reviewed';
  return `<span class="tag${i.status === 'gone' ? ' warn' : ''}">${esc(text)}</span>`;
}
/** The inventory's rows. */
function govInvRowsHtml(items) {
  if (!items.length) return `<tr><td colspan="7" class="muted">${esc('No items for these filters.')}</td></tr>`;
  return items
    .map((i) => {
```

with

```js
  const text = i.status === 'gone' ? ['Gone', words].filter(Boolean).join(' · ') : words || 'Reviewed';
  return `<span class="tag${i.status === 'gone' ? ' warn' : ''}">${esc(text)}</span>`;
}
/** Whether a role may review inventory items: the owner and reviewers (no role: no sign-in, the owner). */
const govCanReview = (role) => !role || role === 'owner' || role === 'reviewer';
/** The signed-in role, from the page chrome (public/app.js ZP.me); null when unknown. */
const govRole = () => (typeof ZP !== 'undefined' && ZP.me && ZP.me.role) || null;
/** The inventory's rows; the Review button only for a role that may review. */
function govInvRowsHtml(items, canReview = true) {
  if (!items.length) return `<tr><td colspan="7" class="muted">${esc('No items for these filters.')}</td></tr>`;
  return items
    .map((i) => {
```

In `public/governanceview.js`, replace

```js
      const owner = i.review && i.review.owner ? `<div class="muted">${esc(i.review.owner)}</div>` : '';
      // A source failed this build: the item is kept as it was last seen, not confirmed.
      const stale = i.stale ? `<div class="muted">${esc('not confirmed this build')}</div>` : '';
      return `<tr><td><b>${esc(i.name)}</b><div class="muted mono gov-id">${esc(i.id)}</div>${detail ? `<div class="muted">${esc(detail)}</div>` : ''}</td><td>${esc(govLabel(GOV_KINDS, i.kind))}</td><td>${esc((i.where || []).join(', ') || '—')}</td><td>${esc(govLabel(GOV_STATES, i.state))}</td><td class="mono">${esc(i.firstSeen || '—')}<br>${esc(i.lastSeen || '—')}</td><td>${govReviewTag(i)}${owner}${stale}</td><td><button class="btn ghost" type="button" data-gov-review="${esc(i.id)}">${esc(i.status === 'unreviewed' ? 'Review' : 'Edit')}</button></td></tr>`;
    })
    .join('');
}
```

with

```js
      const owner = i.review && i.review.owner ? `<div class="muted">${esc(i.review.owner)}</div>` : '';
      // A source failed this build: the item is kept as it was last seen, not confirmed.
      const stale = i.stale ? `<div class="muted">${esc('not confirmed this build')}</div>` : '';
      return `<tr><td><b>${esc(i.name)}</b><div class="muted mono gov-id">${esc(i.id)}</div>${detail ? `<div class="muted">${esc(detail)}</div>` : ''}</td><td>${esc(govLabel(GOV_KINDS, i.kind))}</td><td>${esc((i.where || []).join(', ') || '—')}</td><td>${esc(govLabel(GOV_STATES, i.state))}</td><td class="mono">${esc(i.firstSeen || '—')}<br>${esc(i.lastSeen || '—')}</td><td>${govReviewTag(i)}${owner}${stale}</td><td>${canReview ? `<button class="btn ghost" type="button" data-gov-review="${esc(i.id)}">${esc(i.status === 'unreviewed' ? 'Review' : 'Edit')}</button>` : ''}</td></tr>`;
    })
    .join('');
}
```

In `public/governanceview.js`, replace

```js
    <label>${esc('Review')}${select('review', 'Any review', GOV_REVIEWS)}</label>
  </form>`;
}
/** The review drawer of one item: what is known of it, then owner, purpose, risk, decision and note. */
function govReviewFormHtml(i) {
  const r = i.review || {};
  const opt = (list, v) =>
    list
```

with

```js
    <label>${esc('Review')}${select('review', 'Any review', GOV_REVIEWS)}</label>
  </form>`;
}
/** The review drawer of one item: what is known of it, then owner (with the accounts' names suggested), purpose, risk,
 * decision and note. */
function govReviewFormHtml(i, names = []) {
  const r = i.review || {};
  const opt = (list, v) =>
    list
```

In `public/governanceview.js`, replace

```js
      <div class="cost-drawer-head"><h2 id="gov-review-title">${esc(i.name)}</h2><button type="button" class="btn ghost" data-gov-close aria-label="Close">×</button></div>
      <p class="muted mono">${esc(i.id)}</p>
      <dl class="gov-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <label>${esc('Owner')}<input class="input" name="owner" maxlength="200" value="${esc(r.owner || '')}" autocomplete="off"></label>
      <label>${esc('Purpose')}<input class="input" name="purpose" maxlength="200" value="${esc(r.purpose || '')}" autocomplete="off"></label>
      <div class="cost-row"><label>${esc('Risk (EU AI Act tier)')}<select class="input" name="risk">${opt(GOV_RISKS, r.risk)}</select></label><label>${esc('Decision')}<select class="input" name="decision">${opt(GOV_DECISIONS, r.decision)}</select></label></div>
      <label>${esc('Note')}<textarea class="input" name="note" maxlength="200" rows="3">${esc(r.note || '')}</textarea></label>
```

with

```js
      <div class="cost-drawer-head"><h2 id="gov-review-title">${esc(i.name)}</h2><button type="button" class="btn ghost" data-gov-close aria-label="Close">×</button></div>
      <p class="muted mono">${esc(i.id)}</p>
      <dl class="gov-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <label>${esc('Owner')}<input class="input" name="owner" maxlength="200" value="${esc(r.owner || '')}" autocomplete="off" list="gov-owner-names"></label>
      <datalist id="gov-owner-names">${(Array.isArray(names) ? names : []).map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      <label>${esc('Purpose')}<input class="input" name="purpose" maxlength="200" value="${esc(r.purpose || '')}" autocomplete="off"></label>
      <div class="cost-row"><label>${esc('Risk (EU AI Act tier)')}<select class="input" name="risk">${opt(GOV_RISKS, r.risk)}</select></label><label>${esc('Decision')}<select class="input" name="decision">${opt(GOV_DECISIONS, r.decision)}</select></label></div>
      <label>${esc('Note')}<textarea class="input" name="note" maxlength="200" rows="3">${esc(r.note || '')}</textarea></label>
```

In `public/governanceview.js`, replace

```js
  if (!body) return;
  try {
    GOV.inv.data = await api('/api/governance/inventory');
    govPaintInv();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7">${esc(`Could not read the inventory: ${e.message}`)}</td></tr>`;
```

with

```js
  if (!body) return;
  try {
    GOV.inv.data = await api('/api/governance/inventory');
    // The owner field's suggestions; a failure only leaves them out.
    if (govCanReview(govRole()))
      GOV.inv.names = (await api('/api/users/names').catch(() => ({ names: [] }))).names || [];
    govPaintInv();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7">${esc(`Could not read the inventory: ${e.message}`)}</td></tr>`;
```

In `public/governanceview.js`, replace

```js
  const sum = $('#gov-inv-summary');
  if (sum) sum.innerHTML = govInvSummaryHtml(d);
  const body = $('#gov-inv-rows');
  if (body) body.innerHTML = govInvRowsHtml(govInvFilter(d.items, GOV.inv.filters));
}
async function govLoadComp() {
  const el = $('#gov-comp');
```

with

```js
  const sum = $('#gov-inv-summary');
  if (sum) sum.innerHTML = govInvSummaryHtml(d);
  const body = $('#gov-inv-rows');
  if (body) body.innerHTML = govInvRowsHtml(govInvFilter(d.items, GOV.inv.filters), govCanReview(govRole()));
}
async function govLoadComp() {
  const el = $('#gov-comp');
```

In `public/governanceview.js`, replace

```js
function govOpenReview(id) {
  const host = $('#gov-review-host');
  const item = GOV.inv.data && GOV.inv.data.items.find((i) => i.id === id);
  if (!host || !item) return;
  GOV.inv.open = id;
  host.innerHTML = govReviewFormHtml(item);
  const first = host.querySelector('input[name="owner"]');
  if (first) first.focus();
}
```

with

```js
function govOpenReview(id) {
  const host = $('#gov-review-host');
  const item = GOV.inv.data && GOV.inv.data.items.find((i) => i.id === id);
  if (!host || !item || !govCanReview(govRole())) return;
  GOV.inv.open = id;
  host.innerHTML = govReviewFormHtml(item, GOV.inv.names);
  const first = host.querySelector('input[name="owner"]');
  if (first) first.focus();
}
```

In `public/governanceview.js`, replace

```js
    govInvFilter,
    govReviewTag,
    govInvRowsHtml,
    govInvSummaryHtml,
    govInvFiltersHtml,
    govReviewFormHtml,
```

with

```js
    govInvFilter,
    govReviewTag,
    govInvRowsHtml,
    govCanReview,
    govInvSummaryHtml,
    govInvFiltersHtml,
    govReviewFormHtml,
```

In `public/index.html`, replace

```html
        <a class="nav-sub" href="#governance" data-route="governance/">Inventory</a>
        <a class="nav-sub" href="#governance/compliance" data-route="governance/compliance">Compliance</a>
        <a class="nav-sub" href="#governance/audit" data-route="governance/audit">Audit log</a>
        <div class="nav-label">PREFERENCES</div>
        <a href="#settings" data-route="settings"><span data-icon="gear"></span>Settings</a>
      </nav>

      <div class="sidebar-foot">
```

with

```html
        <a class="nav-sub" href="#governance" data-route="governance/">Inventory</a>
        <a class="nav-sub" href="#governance/compliance" data-route="governance/compliance">Compliance</a>
        <a class="nav-sub" href="#governance/audit" data-route="governance/audit">Audit log</a>
        <div class="nav-label" id="nav-prefs">PREFERENCES</div>
        <a href="#settings" data-route="settings"><span data-icon="gear"></span>Settings</a>
        <a class="nav-sub" href="#settings" data-route="settings/">Preferences</a>
        <a class="nav-sub" href="#settings/users" data-route="settings/users">Users</a>
      </nav>

      <div class="sidebar-foot">
```

In `public/index.html`, replace

```html
            <input id="search" type="search" placeholder="Search sessions, projects…" autocomplete="off">
          </label>
          <button class="icon-btn" id="rescan" title="Rescan logs now" aria-label="Rescan logs now"><span data-icon="refresh"></span></button>
        </div>
      </header>

      <div class="content" id="view" aria-live="polite"></div>
    </main>
  </div>
```

with

```html
            <input id="search" type="search" placeholder="Search sessions, projects…" autocomplete="off">
          </label>
          <button class="icon-btn" id="rescan" title="Rescan logs now" aria-label="Rescan logs now"><span data-icon="refresh"></span></button>
          <div class="topbar-who" id="topbar-who" hidden><span id="who-text"></span> <a class="link-btn" id="who-password" href="/login.html?change=1">Change password</a> <button class="link-btn" type="button" id="who-out">Sign out</button></div>
        </div>
      </header>

      <div class="role-banner" id="role-banner" role="status" hidden></div>
      <div class="content" id="view" aria-live="polite"></div>
    </main>
  </div>
```

In `public/index.html`, replace

```html
  <script src="costsettings.js"></script>
  <script src="costreports.js"></script>
  <script src="governanceview.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

with

```html
  <script src="costsettings.js"></script>
  <script src="costreports.js"></script>
  <script src="governanceview.js"></script>
  <script src="usersview.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

In `public/iso.js`, replace

```js
    ['proxy', 'Proxy logs'],
    ['time', 'Time'],
  ],
  // The inventory is the default page; the audit log moved to #governance/audit (public/governanceview.js).
  governance: [
    ['', 'Inventory'],
```

with

```js
    ['proxy', 'Proxy logs'],
    ['time', 'Time'],
  ],
  // Preferences and, for the owner, the dashboard accounts (public/usersview.js).
  settings: [
    ['', 'Preferences'],
    ['users', 'Users'],
  ],
  // The inventory is the default page; the audit log moved to #governance/audit (public/governanceview.js).
  governance: [
    ['', 'Inventory'],
```

In `public/login.html`, replace

```html
      <div class="mark"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4cc3d9" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg></div>
      <div><div class="name">ZAAF<span>Pulse</span></div><div class="sub">AI COMMAND CENTER</div></div>
    </div>
    <label for="pw">Admin password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
    <button id="go" type="submit">Sign in</button>
    <div class="err" id="err" role="alert"></div>
    <p class="note">This ZAAFPulse runs in server mode. Forgot the password? Run <code>zaafpulse set-password</code> on the server.</p>
  </form>
  <script src="login.js"></script>
</body>
```

with

```html
      <div class="mark"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4cc3d9" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg></div>
      <div><div class="name">ZAAF<span>Pulse</span></div><div class="sub">AI COMMAND CENTER</div></div>
    </div>
    <div id="fields">
      <label for="nm">Name</label>
      <input id="nm" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" placeholder="Empty for the admin password" autofocus>
      <label for="pw" style="margin-top:12px">Password</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" required>
    </div>
    <button id="go" type="submit">Sign in</button>
    <div class="err" id="err" role="alert"></div>
    <p class="note" id="note">This ZAAFPulse runs in server mode. Leave the name empty to sign in with the admin password; forgot it? Run <code>zaafpulse set-password</code> on the server. Your own account's password is reset by the owner.</p>
  </form>
  <script src="login.js"></script>
</body>
```

In `public/login.js`, replace

```js
'use strict';
// Sign-in page for server mode (kept out of the HTML so the page can run under a strict CSP).
fetch('/api/session')
  .then((r) => r.json())
  .then((s) => {
    if (!s.required || s.signedIn) return location.replace('/');
    // Local mode has no password: the owner opens the dashboard with `zaafpulse open`.
    if (s.mode === 'local') {
      const expired = new URLSearchParams(location.search).has('expired');
      document.getElementById('f').innerHTML =
        '<p class="note" style="font-size:14px;color:#e6ebff">This dashboard only opens for the account that runs ZAAFPulse.</p>' +
        '<p class="note">Run <code>zaafpulse open</code> in a terminal on this machine.' +
        (expired ? ' The sign-in link expired or was already used.' : '') +
        '</p>';
    }
  })
  .catch(() => {});
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = document.getElementById('go');
  const err = document.getElementById('err');
  go.disabled = true;
  err.textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value }),
    });
    if (r.ok) return location.replace('/');
    err.textContent = (await r.json().catch(() => ({}))).error || `Sign-in failed (${r.status})`;
  } catch {
    err.textContent = 'The server did not answer.';
  }
```

with

```js
'use strict';
// Sign-in page (kept out of the HTML so the page can run under a strict CSP). Password mode: a name and a password (no
// name is the admin password). Local mode: the owner opens the dashboard with `zaafpulse open`; accounts sign in here
// with their name. An account whose password must change (a new one, or one the owner reset) chooses a new one here
// before anything else, and any account can come back here (?change=1) to change its own.
const $id = (id) => document.getElementById(id);
const form = $id('f');
let step = 'signin';

// The change-password step: the current password, a new one twice. Static text only; nothing from the server.
function showChange(forced) {
  step = 'change';
  $id('fields').innerHTML =
    '<label for="cur">Current password</label>' +
    '<input id="cur" type="password" autocomplete="current-password" required>' +
    '<label for="nx" style="margin-top:12px">New password</label>' +
    '<input id="nx" type="password" autocomplete="new-password" minlength="12" required>' +
    '<label for="nx2" style="margin-top:12px">New password again</label>' +
    '<input id="nx2" type="password" autocomplete="new-password" minlength="12" required>';
  $id('go').textContent = 'Change password';
  $id('note').textContent = forced
    ? 'Choose your own password before you go on: at least 12 characters.'
    : 'At least 12 characters. Your other sessions end; this one goes on.';
  $id('cur').focus();
}

fetch('/api/session')
  .then((r) => r.json())
  .then((s) => {
    const change = new URLSearchParams(location.search).has('change');
    if (!s.required) return location.replace('/');
    if (s.signedIn && s.mustChange) return showChange(true);
    if (s.signedIn && change && s.role !== 'owner') return showChange(false);
    if (s.signedIn) return location.replace('/');
    // Local mode: the owner opens the dashboard with `zaafpulse open`; accounts, if any, sign in here.
    if (s.mode === 'local') {
      const expired = new URLSearchParams(location.search).has('expired');
      const expiredNote = expired ? ' The sign-in link expired or was already used.' : '';
      if (!s.accounts) {
        form.innerHTML =
          '<p class="note" style="font-size:14px;color:#e6ebff">This dashboard only opens for the account that runs ZAAFPulse.</p>' +
          `<p class="note">Run <code>zaafpulse open</code> in a terminal on this machine.${expiredNote}</p>`;
        return;
      }
      $id('nm').placeholder = 'Your account name';
      $id('nm').required = true;
      $id('note').innerHTML =
        `The owner opens this dashboard with <code>zaafpulse open</code> in a terminal on this machine.${expiredNote} ` +
        'Others sign in here with the name and password the owner gave them.';
    }
  })
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $id('go');
  const err = $id('err');
  go.disabled = true;
  err.textContent = '';
  try {
    if (step === 'change') {
      if ($id('nx').value !== $id('nx2').value) {
        err.textContent = 'The new passwords do not match.';
      } else {
        const r = await fetch('/api/account/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ current: $id('cur').value, next: $id('nx').value }),
        });
        if (r.ok) return location.replace('/');
        err.textContent = (await r.json().catch(() => ({}))).error || `Not changed (${r.status})`;
      }
    } else {
      const name = $id('nm').value.trim();
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(name ? { name } : {}), password: $id('pw').value }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.mustChange) showChange(true);
      else if (r.ok) return location.replace('/');
      else err.textContent = body.error || `Sign-in failed (${r.status})`;
    }
  } catch {
    err.textContent = 'The server did not answer.';
  }
```

In `public/styles.css`, replace

```css
.gov-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

```

with

```css
.gov-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

/* Dashboard users and roles (AI Governance 4): who is signed in, the role banner, the Users page. */
.topbar-who {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
}
.topbar-who .link-btn {
  color: var(--text-2);
  font-size: 12px;
}
.role-banner {
  padding: 8px 28px;
  border-bottom: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-ink);
  font-size: 12.5px;
}
.usr-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

```

Create `public/usersview.js`:

```js
'use strict';
/* Settings → Users (#settings/users, AI Governance 4): the people who sign in to this dashboard with their own name and
   password, from GET /api/users; add, change the role, disable or enable, reset the password and delete with POST
   /api/users. The owner's page: a reviewer or a viewer never sees it (the server refuses them anyway). Also the
   role banner and the identity line the page chrome shows for whoever is signed in.
   Events are delegated (the CSP allows no inline handler); pure helpers are exported for Node tests, and nothing here
   touches the DOM at load time. Every server or owner string reaches the markup through esc(). */

const USR_ROLES = [
  ['viewer', 'Viewer'],
  ['reviewer', 'Reviewer'],
];
const USR_ROLE_WORDS = { owner: 'Owner', reviewer: 'Reviewer', viewer: 'Viewer' };
const USR = { hooked: false, data: null, reset: null };

/* ---------- pure helpers (exported) ---------- */

/** A role in words: Owner, Reviewer, Viewer (anything else as it is). */
const usrRoleLabel = (role) => USR_ROLE_WORDS[role] || String(role ?? '');
/** A failed api() call as one line: its body's first error text, else the message as it is. */
function usrErrorText(err) {
  const msg = String((err && err.message) || err || '');
  try {
    const body = JSON.parse(msg.replace(/^\d{3}\s+/, ''));
    const first = Array.isArray(body.errors) ? body.errors[0] : body.error;
    if (first) return String(first);
  } catch {
    /* not JSON: show it as it came */
  }
  return msg;
}
/** "2026-11-04 09:05" in this browser's time zone, or "never". */
function usrWhen(ts) {
  if (!ts) return 'never';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'never';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** The one-line banner for a reviewer or a viewer; '' for the owner (or nobody signed in). */
function usrBannerText(me) {
  if (!me || !me.role || me.role === 'owner') return '';
  const what = me.role === 'reviewer' ? 'reviews and approvals' : 'read-only';
  return `Signed in as ${me.display || me.user} · ${usrRoleLabel(me.role)} · ${what}`;
}
/** The identity line in the top bar: "Vera · Viewer". */
const usrWhoText = (me) => (me && me.role ? `${me.display || me.user} · ${usrRoleLabel(me.role)}` : '');
/** An account's state in words. */
const usrStateTag = (u) =>
  u.disabled
    ? `<span class="tag warn">${esc('Disabled')}</span>`
    : u.mustChange
      ? `<span class="tag warn">${esc('New password due')}</span>`
      : `<span class="tag">${esc('Active')}</span>`;
/** The accounts' rows, each with its role select and actions. */
function usrRowsHtml(users) {
  if (!users.length)
    return `<tr><td colspan="6" class="muted">${esc('No accounts yet: only the owner signs in.')}</td></tr>`;
  return users
    .map((u) => {
      const roles = USR_ROLES.map(
        ([v, label]) => `<option value="${esc(v)}"${v === u.role ? ' selected' : ''}>${esc(label)}</option>`,
      ).join('');
      return `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.display || '—')}</td><td><select class="input" data-usr-role="${esc(u.name)}" aria-label="${esc(`Role of ${u.name}`)}">${roles}</select></td><td class="mono">${esc(usrWhen(u.lastLoginAt))}</td><td>${usrStateTag(u)}</td><td class="usr-actions"><button class="btn ghost" type="button" data-usr-toggle="${esc(u.name)}">${esc(u.disabled ? 'Enable' : 'Disable')}</button><button class="btn ghost" type="button" data-usr-reset="${esc(u.name)}">${esc('Reset password')}</button><button class="btn ghost" type="button" data-usr-delete="${esc(u.name)}">${esc('Delete')}</button></td></tr>`;
    })
    .join('');
}
/** The form that adds an account. */
function usrAddFormHtml() {
  const roles = USR_ROLES.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  return `<form id="usr-add" class="gov-bar" autocomplete="off">
    <label>${esc('Name')}<input class="input" name="name" required maxlength="32" placeholder="ana.k"></label>
    <label>${esc('Display name')}<input class="input" name="display" maxlength="60" placeholder="Ana K."></label>
    <label>${esc('Role')}<select class="input" name="role">${roles}</select></label>
    <label>${esc('First password')}<input class="input" name="password" type="password" required minlength="12" autocomplete="new-password"></label>
    <button class="btn" type="submit">${esc('Add')}</button>
    <p class="muted gov-note">${esc('Names: 2 to 32 lowercase letters, digits, dots, dashes or underscores. Passwords: at least 12 characters; the person chooses a new one at the first sign-in.')}</p>
  </form>`;
}
/** The form that sets a new password for one account. */
function usrResetFormHtml(name) {
  return `<form id="usr-reset" class="gov-bar" data-usr-name="${esc(name)}" autocomplete="off">
    <label>${esc(`New password for ${name}`)}<input class="input" name="password" type="password" required minlength="12" autocomplete="new-password"></label>
    <button class="btn" type="submit">${esc('Set password')}</button><button class="btn ghost" type="button" data-usr-cancel>${esc('Cancel')}</button>
    <p class="muted gov-note">${esc('Their sessions end now, and they choose a new password at the next sign-in.')}</p>
  </form>`;
}
/** The page's body for GET /api/users: off without sign-in, a warning when the file cannot be read, else the table. */
function usrBodyHtml(d) {
  if (!d || d.state === 'off')
    return `<div class="empty">${esc('Sign-in is off (ZAAFPULSE_AUTH=none), so there are no accounts: everyone who reaches this dashboard is the owner. Turn sign-in on to add people.')}</div>`;
  const banner =
    d.state === 'unreadable'
      ? `<div class="gov-banner">${esc('users.json could not be read: nobody in it can sign in until it is fixed or moved, and nothing is written over it. The owner still signs in.')}</div>`
      : '';
  return `${banner}<div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Name')}</th><th>${esc('Display name')}</th><th>${esc('Role')}</th><th>${esc('Last sign-in')}</th><th>${esc('State')}</th><th></th></tr></thead><tbody>${usrRowsHtml(d.users || [])}</tbody></table></div>${d.state === 'ok' ? usrAddFormHtml() : ''}`;
}

/* ---------- the page ---------- */

/** Settings → Users. */
function usrView() {
  return `<div class="holo-deck">${subTabs('settings')}${subHero('SETTINGS · USERS', 'Users', esc('People who sign in to this dashboard with their own name and password. Reviewers also save inventory reviews and approve agent runs; viewers only read, and never see transcripts, dataset examples or secrets. You, the owner, sign in with the admin password, which is changed with zaafpulse set-password on the server.'))}<div id="usr-app">
    <section class="holo panel"><div class="panel-head"><h3>${esc('Accounts')}</h3><span class="meta">${esc('.data/users.json')}</span></div><div id="usr-msg" role="alert"></div><div id="usr-body"><div class="skeleton" style="height:120px"></div></div><div id="usr-reset-host"></div></section>
  </div></div>`;
}
async function usrLoad() {
  const el = $('#usr-body');
  if (!el) return;
  try {
    USR.data = await api('/api/users');
    el.innerHTML = usrBodyHtml(USR.data);
  } catch (e) {
    el.innerHTML = `<div class="gov-banner">${esc(`Could not read the accounts: ${usrErrorText(e)}`)}</div>`;
  }
}
async function usrPost(body, done) {
  const msg = $('#usr-msg');
  if (msg) msg.textContent = '';
  try {
    await api('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (msg) msg.textContent = `Not saved: ${usrErrorText(err)}`;
    return usrLoad(); // a select that changed shows the saved value again
  }
  if (done) done();
  usrLoad();
}
function usrMount(el) {
  el.innerHTML = usrView();
  usrInstallEvents();
  usrLoad();
}
function usrInstallEvents() {
  if (USR.hooked) return;
  USR.hooked = true;
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form || !form.closest || !form.closest('#usr-app')) return;
    e.preventDefault();
    const data = new FormData(form);
    if (form.id === 'usr-add')
      usrPost(
        {
          action: 'create',
          name: String(data.get('name') || '')
            .trim()
            .toLowerCase(),
          display: String(data.get('display') || '').trim(),
          role: String(data.get('role') || 'viewer'),
          password: String(data.get('password') || ''),
        },
        () => form.reset(),
      );
    else if (form.id === 'usr-reset')
      usrPost({ action: 'reset', name: form.dataset.usrName, password: String(data.get('password') || '') }, () => {
        const host = $('#usr-reset-host');
        if (host) host.replaceChildren();
      });
  });
  document.addEventListener('change', (e) => {
    const sel = e.target && e.target.closest && e.target.closest('#usr-app [data-usr-role]');
    if (sel) usrPost({ action: 'update', name: sel.getAttribute('data-usr-role'), role: sel.value });
  });
  document.addEventListener('click', (e) => {
    const t =
      e.target.closest &&
      e.target.closest(
        '#usr-app [data-usr-toggle], #usr-app [data-usr-reset], #usr-app [data-usr-delete], #usr-app [data-usr-cancel]',
      );
    if (!t) return;
    const host = $('#usr-reset-host');
    if (t.hasAttribute('data-usr-cancel')) return void (host && host.replaceChildren());
    if (t.hasAttribute('data-usr-reset')) {
      if (host) host.innerHTML = usrResetFormHtml(t.getAttribute('data-usr-reset'));
      const input = host && host.querySelector('input[name="password"]');
      if (input) input.focus();
      return;
    }
    const name = t.getAttribute('data-usr-toggle') || t.getAttribute('data-usr-delete');
    const user = ((USR.data && USR.data.users) || []).find((u) => u.name === name);
    if (!user) return;
    if (t.hasAttribute('data-usr-toggle')) return void usrPost({ action: 'update', name, disabled: !user.disabled });
    if (confirm(`Delete ${name}? Their sessions end now; the audit log keeps what they did.`))
      usrPost({ action: 'delete', name });
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    USR,
    USR_ROLES,
    usrRoleLabel,
    usrErrorText,
    usrWhen,
    usrBannerText,
    usrWhoText,
    usrStateTag,
    usrRowsHtml,
    usrAddFormHtml,
    usrResetFormHtml,
    usrBodyHtml,
    usrView,
  };
```

- [ ] **Step 4: Run the UI tests**

Run: `node --test test/users-ui.test.js test/cost-ui.test.js test/governance-ui.test.js test/governance-inventory-ui.test.js test/users-audit.test.js`
Expected: PASS (39 tests).

- [ ] **Step 5: Format and parse**

Run: `npx prettier@3 --check public/usersview.js public/app.js public/iso.js public/governanceview.js public/login.js test/users-ui.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath public/styles.css < public/styles.css | diff public/styles.css - | grep -c '^[<>]'`
Expected: `39`
Run: `for f in public/app.js public/login.js public/usersview.js public/governanceview.js public/iso.js; do node --check $f; done`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add public/usersview.js public/app.js public/iso.js public/index.html public/styles.css public/governanceview.js public/login.html public/login.js test/users-ui.test.js
git commit -m "Show the signed-in account and its role; add Settings → Users and the change-password step"
```

### Task 8: documentation and the whole suite

**Files:**
- Create: `docs/users.md`
- Modify: `README.md` (lines 264, 521, 763, 775, 971, 1042, 1050)
- Modify: `docs/governance.md` (lines 9, 75, 110, 135, 192, 225, 236, 328, 358, 368)
- Modify: `docs/install.md` (line 181)

**Interfaces:**
- Consumes: everything above; the values V1–V9 and U1.
- Produces: documentation only.

- [ ] **Step 1: `docs/users.md`, and the pointers from `docs/governance.md`, `docs/install.md` and `README.md`**

In `README.md`, replace

```markdown
<td valign="top">

**AI governance**<br>
<sub>An inventory of every AI system here (apps, the MCP servers in your AI clients, providers, models, agents, keys) with its owner, purpose, risk and your decision; seventeen controls mapped to the EU AI Act, the NIST AI RMF and ISO/IEC 42001 with their evidence, exportable as Markdown or JSON; and an audit log of every change made by a person or an API key, chained so an edited or deleted line shows when you verify. <a href="docs/governance.md">docs/governance.md</a></sub>

</td>
</tr>
```

with

```markdown
<td valign="top">

**AI governance**<br>
<sub>An inventory of every AI system here (apps, the MCP servers in your AI clients, providers, models, agents, keys) with its owner, purpose, risk and your decision; eighteen controls mapped to the EU AI Act, the NIST AI RMF and ISO/IEC 42001 with their evidence, exportable as Markdown or JSON; an audit log of every change made by a person or an API key, chained so an edited or deleted line shows when you verify; and sign-ins of their own for auditors (viewers) and reviewers, each change recorded under their name. <a href="docs/governance.md">docs/governance.md</a> · <a href="docs/users.md">docs/users.md</a></sub>

</td>
</tr>
```

In `README.md`, replace

```markdown

Details, including the autostart opener and Windows: [docs/install.md](docs/install.md#who-can-open-the-dashboard).

### Server mode

By default ZAAFPulse listens on 127.0.0.1 only. `--server` (or `zaafpulse start --host 0.0.0.0`) makes it reachable from other machines:
```

with

```markdown

Details, including the autostart opener and Windows: [docs/install.md](docs/install.md#who-can-open-the-dashboard).

Other people can have their own sign-in, with a role: a **viewer** reads (metadata only, never transcripts or
secrets), a **reviewer** also reviews the AI inventory and approves agent runs. Add them under **Settings → Users**;
they sign in with a name and a password in password and local sign-in, and the admin password stays yours. Roles, what
each may read, passwords and the audit entries: **[docs/users.md](docs/users.md)**.

### Server mode

By default ZAAFPulse listens on 127.0.0.1 only. `--server` (or `zaafpulse start --host 0.0.0.0`) makes it reachable from other machines:
```

In `README.md`, replace

```markdown
  looks like a token. The package is the first other package-looking argument, so it can be a plain flag's value
  (`--port 8080`).

**Governance → Compliance** shows seventeen controls (the guardrails, the audit log, approvals, keys, agent control,
the Monitors, evals, budgets, sign-in, retention, the inventory itself …) with their status from your settings and
their evidence, mapped to the EU AI Act, the NIST AI RMF 1.0 and ISO/IEC 42001:2023. **Export** the inventory, the
controls and the audit log's state as Markdown or JSON. It is evidence for your assessment, not a certification.

```

with

```markdown
  looks like a token. The package is the first other package-looking argument, so it can be a plain flag's value
  (`--port 8080`).

**Governance → Compliance** shows eighteen controls (the guardrails, the audit log, approvals, keys, agent control,
the Monitors, evals, budgets, sign-in, roles and access reviews, retention, the inventory itself …) with their status from your settings and
their evidence, mapped to the EU AI Act, the NIST AI RMF 1.0 and ISO/IEC 42001:2023. **Export** the inventory, the
controls and the audit log's state as Markdown or JSON. It is evidence for your assessment, not a certification.

```

In `README.md`, replace

```markdown
**Governance → Audit log** lists every change made to ZAAFPulse by a person or an API key: dashboard changes with
their route and outcome, every `config.json` write with its changed fields (secrets masked), sign-ins and lockouts, API
key changes, approvals and cancels of collaboration runs (with the key that asked), agent and runtime control, and
each secret shown in the Trace explorer.

- **Kept** in monthly files under `.data/audit/` for 12 months by default (6 to 120), then deleted by whole months.
- **Chained:** each entry carries an HMAC of the one before it, with a key in the OS secret store. **Verify** shows
```

with

```markdown
**Governance → Audit log** lists every change made to ZAAFPulse by a person or an API key: dashboard changes with
their route and outcome, every `config.json` write with its changed fields (secrets masked), sign-ins and lockouts, API
key changes, approvals and cancels of collaboration runs (with the key that asked), agent and runtime control, and
each secret shown in the Trace explorer. Each dashboard entry names the account and its role
([docs/users.md](docs/users.md)); the list filters by account.

- **Kept** in monthly files under `.data/audit/` for 12 months by default (6 to 120), then deleted by whole months.
- **Chained:** each entry carries an HMAC of the one before it, with a key in the OS secret store. **Verify** shows
```

In `README.md`, replace

```markdown
lib/net.js             guarded fetch for addresses someone else typed (no loopback, private or metadata addresses)
lib/platform.js        OS differences: data folder, machine and user name, Obsidian config, open URL, MCP command
lib/auth.js            dashboard sign-in: local one-time-code sign-in (default), server-mode password (scrypt,
                       sessions, per-address throttling)
lib/service.js         background service: LaunchAgent, systemd, Startup folder or Task Scheduler
lib/audit.js           tool-call log (.cache/mcp-audit.jsonl)
lib/local.js           dashboard data for the acc connector
```

with

```markdown
lib/net.js             guarded fetch for addresses someone else typed (no loopback, private or metadata addresses)
lib/platform.js        OS differences: data folder, machine and user name, Obsidian config, open URL, MCP command
lib/auth.js            dashboard sign-in: local one-time-code sign-in (default), server-mode password (scrypt,
                       sessions, per-address throttling), accounts by name with their role
lib/users/             dashboard accounts: the accounts file, the role policy (deny by default), /api/users
lib/service.js         background service: LaunchAgent, systemd, Startup folder or Task Scheduler
lib/audit.js           tool-call log (.cache/mcp-audit.jsonl)
lib/local.js           dashboard data for the acc connector
```

In `README.md`, replace

````markdown
docs/cost.md           cost ledger: who counts what, frozen cost, billing, cost centers, restate, the Cost Control menu, API, limits
docs/guardrails.md     gateway guardrails: the checks, modes, scope, per-key policy, what is recorded, reading a block
docs/governance.md     governance: the AI inventory and reviews, compliance controls, evidence export, the audit log, API
docs/assets/           README banner, diagrams, screenshots and GIFs
```
</details>
````

with

````markdown
docs/cost.md           cost ledger: who counts what, frozen cost, billing, cost centers, restate, the Cost Control menu, API, limits
docs/guardrails.md     gateway guardrails: the checks, modes, scope, per-key policy, what is recorded, reading a block
docs/governance.md     governance: the AI inventory and reviews, compliance controls, evidence export, the audit log, API
docs/users.md          dashboard users and roles: owner, reviewer, viewer, what each may do, passwords, audit, API
docs/assets/           README banner, diagrams, screenshots and GIFs
```
</details>
````

In `README.md`, replace

```markdown
<details>
<summary><b>HTTP API</b></summary>

Apart from the sign-in routes in the first row, every `/api` route needs a signed-in dashboard session, unless sign-in is off.

| Route | Returns |
|---|---|
| `GET /api/session` · `POST /api/login` · `POST /api/logout` · `GET /auth/local` | sign-in state and mode; password sign-in (server mode); sign out; the one-time-code exchange that `zaafpulse open` uses |
| `GET /api/platform` | OS and the secret store in use |
| `GET /api/summary?range=7\|30\|90\|all` | usage, cost, sessions, projects, models and quality for the range |
| `GET /api/live` | running AI apps, system load and used memory, indexer status |
```

with

```markdown
<details>
<summary><b>HTTP API</b></summary>

Apart from the sign-in routes in the first row, every `/api` route needs a signed-in dashboard session, unless sign-in is off. A reviewer's or a viewer's session reaches only the routes its role allows ([docs/users.md](docs/users.md#roles)).

| Route | Returns |
|---|---|
| `GET /api/session` · `POST /api/login` · `POST /api/logout` · `GET /auth/local` | sign-in state, mode and who is signed in; sign-in with a name and a password (or the admin password alone); sign out; the one-time-code exchange that `zaafpulse open` uses |
| `GET /api/users` · `POST /api/users` · `GET /api/users/names` · `POST /api/account/password` | the dashboard accounts (the owner's), the names the inventory review suggests, an account's own password; see [docs/users.md](docs/users.md#api) |
| `GET /api/platform` | OS and the secret store in use |
| `GET /api/summary?range=7\|30\|90\|all` | usage, cost, sessions, projects, models and quality for the range |
| `GET /api/live` | running AI apps, system load and used memory, indexer status |
```

In `docs/governance.md`, replace

```markdown
  clauses they map to, and an evidence export.
- **Audit log** (`#governance/audit`): every change made by a person or an API key ([below](#audit-log)).

Everything stays on this machine. The Compliance page is evidence for your assessment, not a certification.

## Inventory

```

with

```markdown
  clauses they map to, and an evidence export.
- **Audit log** (`#governance/audit`): every change made by a person or an API key ([below](#audit-log)).

Everything stays on this machine. The Compliance page is evidence for your assessment, not a certification. Other
people can read these pages with an account of their own ([docs/users.md](users.md)): a viewer reads and exports, a
reviewer also saves reviews.

## Inventory

```

In `docs/governance.md`, replace

```markdown

The decision is a record: blocking a system stays with API keys and the guardrails.

### First and last seen

`.data/governance/seen.json` holds, for each item id, the first and the last day (UTC) the inventory saw it, and
```

with

```markdown

The decision is a record: blocking a system stays with API keys and the guardrails.

Only the owner and reviewers review ([docs/users.md](users.md)); a viewer sees the reviews without the **Review**
button. The owner field suggests the display names of the owner and the dashboard accounts, and any text is still
allowed.

### First and last seen

`.data/governance/seen.json` holds, for each item id, the first and the last day (UTC) the inventory saw it, and
```

In `docs/governance.md`, replace

```markdown
tables are grouped by framework, clause by clause:

- **EU AI Act**, Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744: Art. 12 (record-keeping), Art. 14
  (human oversight), Art. 26 (deployer obligations: logs kept at least 6 months, oversight assigned, monitoring) and
  Art. 50 (transparency, where your use applies).
- **NIST AI RMF 1.0**: GOVERN 1.4 and 1.6, MAP 1.1, MEASURE 2.1, 2.3, 2.4, 2.7 and 2.10, MANAGE 2.4 and 4.1.
- **ISO/IEC 42001:2023**, Annex A: A.2, A.4, A.5, A.6, A.7, A.8, A.9 and A.10.

It is evidence for your assessment, not a certification: a status says what ZAAFPulse does here, not whether your use
of AI meets a law or a standard.
```

with

```markdown
tables are grouped by framework, clause by clause:

- **EU AI Act**, Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744: Art. 12 (record-keeping), Art. 14
  (human oversight), Art. 26 (deployer obligations: logs kept at least 6 months, oversight assigned, monitoring), Art.
  26(2) (human oversight assigned to competent persons) and Art. 50 (transparency, where your use applies).
- **NIST AI RMF 1.0**: GOVERN 1.4, 1.6 and 2.1, MAP 1.1, MEASURE 2.1, 2.3, 2.4, 2.7 and 2.10, MANAGE 2.4 and 4.1.
- **ISO/IEC 42001:2023**, Annex A: A.2, A.3, A.4, A.5, A.6, A.7, A.8, A.9 and A.10.

It is evidence for your assessment, not a certification: a status says what ZAAFPulse does here, not whether your use
of AI meets a law or a standard.
```

In `docs/governance.md`, replace

```markdown
| Budgets that block or pause | a budget blocks, or pauses while agent control is on | budgets only alert (a pause budget counts for nothing while agent control is off or could not be read) | no budget |
| Secrets in the OS store (A.4) | the Keychain or the keyring | the encrypted secret file | |
| Dashboard sign-in | this OS account (local) or a password | | no sign-in |
| Content capture off | the OpenTelemetry export sends no prompt or reply | | it does (`otel.captureContent`) |
| OpenTelemetry export | spans are exported | the exporter reports failed exports since start | not set up |
| Trace retention | traces are kept at least 183 days (6 months) | they are kept less | tracing is off |
```

with

```markdown
| Budgets that block or pause | a budget blocks, or pauses while agent control is on | budgets only alert (a pause budget counts for nothing while agent control is off or could not be read) | no budget |
| Secrets in the OS store (A.4) | the Keychain or the keyring | the encrypted secret file | |
| Dashboard sign-in | this OS account (local) or a password | | no sign-in |
| Dashboard roles and access reviews (Art. 26(2), GOVERN 2.1, A.3) | sign-in is required and no account that may sign in has gone unused for over 90 days (or there is none) | one has: an access review is due (the count, never a name) | no sign-in |
| Content capture off | the OpenTelemetry export sends no prompt or reply | | it does (`otel.captureContent`) |
| OpenTelemetry export | spans are exported | the exporter reports failed exports since start | not set up |
| Trace retention | traces are kept at least 183 days (6 months) | they are kept less | tracing is off |
```

In `docs/governance.md`, replace

```markdown
|---|---|---|
| Every change made from the dashboard (`POST`, `PUT`, `PATCH`, `DELETE` under `/api/`) | `POST /api/gateway/keys`, `POST /api/monitors/:id` … | the route with ids as `:id`, the body's `action`/`op` word (`op`), the target's id and name, the outcome and the HTTP status |
| Every write of `config.json`, from any settings page or the integrations editor | `config.change` | the changed fields as `{ path, from, to }`, secrets masked |
| Sign-in | `auth.login`, `auth.login_failed`, `auth.lockout`, `auth.logout`, `auth.local_code`, `auth.password_set` | the browser's known-device id (password mode) and its address; never a password or a cookie; `auth.logout` only when the request held a session |
| API keys | `key.create`, `key.update`, `key.revoke`, `key.delete` | the key's id and name; an update lists the fields that changed |
| Collaboration runs | `run.approve`, `run.reject`, `run.cancel` | from the dashboard, `/v1/runs/<id>/resume|cancel` and A2A, with the key that asked; an approval a key may not give is recorded as refused; a run id that is not id-shaped (`A-Z a-z 0-9 _ . : -`, at most 80) is left out of the target |
| Knowledge and sessions, with an API key | `knowledge.ingest`, `session.delete` | a document added through `POST /v1/knowledge/<kb>/documents` (the base's id, never the text) and a session deleted through `DELETE /v1/sessions/<id>`, with the key |
```

with

```markdown
|---|---|---|
| Every change made from the dashboard (`POST`, `PUT`, `PATCH`, `DELETE` under `/api/`) | `POST /api/gateway/keys`, `POST /api/monitors/:id` … | the route with ids as `:id`, the body's `action`/`op` word (`op`), the target's id and name, the outcome and the HTTP status |
| Every write of `config.json`, from any settings page or the integrations editor | `config.change` | the changed fields as `{ path, from, to }`, secrets masked |
| Sign-in | `auth.login`, `auth.login_failed`, `auth.lockout`, `auth.logout`, `auth.local_code`, `auth.password_set` | the account and its role, the browser's known-device id (password mode) and its address; a failure names the account it was for as its target when that account exists (`owner` for the admin password); never a password or a cookie; `auth.logout` only when the request held a session |
| Dashboard accounts ([docs/users.md](users.md)) | `user.create`, `user.update`, `user.password_reset`, `user.delete`, `account.password_change` | the account as the target; an update lists the role, display name or disabled as `changes`; never a password |
| A request a reviewer's or a viewer's role does not allow | the route, as `GET /api/trace/content` or `POST /api/config` | refused, 403, reads included |
| API keys | `key.create`, `key.update`, `key.revoke`, `key.delete` | the key's id and name; an update lists the fields that changed |
| Collaboration runs | `run.approve`, `run.reject`, `run.cancel` | from the dashboard, `/v1/runs/<id>/resume|cancel` and A2A, with the key that asked; an approval a key may not give is recorded as refused; a run id that is not id-shaped (`A-Z a-z 0-9 _ . : -`, at most 80) is left out of the target |
| Knowledge and sessions, with an API key | `knowledge.ingest`, `session.delete` | a document added through `POST /v1/knowledge/<kb>/documents` (the base's id, never the text) and a session deleted through `DELETE /v1/sessions/<id>`, with the key |
```

In `docs/governance.md`, replace

```markdown

| `actor.via` | Fields | When |
|---|---|---|
| `dashboard` | `mode` (`local`, `password` or `none`), `device` (password mode: the browser's known-device id), `ip` | a signed-in dashboard request |
| `apikey` | `keyId` | a gateway request with a ZAAFPulse API key, and everything it starts |
| `cli` | none | `zaafpulse set-password` (recorded when the server next starts) |
| `system` | none | ZAAFPulse itself: retention, the key, a gap, background work |
```

with

```markdown

| `actor.via` | Fields | When |
|---|---|---|
| `dashboard` | `user` (the account, `owner` for the owner; `null` before sign-in), `role` (`owner`, `reviewer` or `viewer`), `mode` (`local`, `password` or `none`), `device` (password mode: the browser's known-device id), `ip` | a signed-in dashboard request, and sign-in itself |
| `apikey` | `keyId` | a gateway request with a ZAAFPulse API key, and everything it starts |
| `cli` | none | `zaafpulse set-password` (recorded when the server next starts) |
| `system` | none | ZAAFPulse itself: retention, the key, a gap, background work |
```

In `docs/governance.md`, replace

````markdown
One JSON object per line, for example:

```json
{"seq":42,"ts":"2026-11-03T09:12:40.118Z","action":"config.change","actor":{"via":"dashboard","mode":"local","device":null,"ip":"127.0.0.1"},"outcome":"ok","target":{"type":"config","id":"gateway"},"changes":[{"path":"gateway.guardrails.secrets","from":"redact","to":"block"}],"prev":"5f0c…","mac":"a91e…"}
```

`outcome` is `ok`, `refused` (a 4xx, or an admin answer with `errors`) or `error` (a 5xx). A change list holds at most
````

with

````markdown
One JSON object per line, for example:

```json
{"seq":42,"ts":"2026-11-03T09:12:40.118Z","action":"config.change","actor":{"via":"dashboard","user":"owner","role":"owner","mode":"local","device":null,"ip":"127.0.0.1"},"outcome":"ok","target":{"type":"config","id":"gateway"},"changes":[{"path":"gateway.guardrails.secrets","from":"redact","to":"block"}],"prev":"5f0c…","mac":"a91e…"}
```

`outcome` is `ok`, `refused` (a 4xx, or an admin answer with `errors`) or `error` (a 5xx). A change list holds at most
````

In `docs/governance.md`, replace

```markdown
**Export CSV** and **Export JSONL** download the entries of the chosen range (`GET
/api/governance/audit/export?from&to&format=csv|jsonl`), oldest first. JSONL lines are byte for byte what the log
holds, so a copy can be verified with the same key. The CSV has one line per entry (`seq, time, actor, actor_id, ip,
action, op, target_type, target_id, target_name, outcome, status, changes, prev, mac`); a cell that starts with `=`,
`+`, `-`, `@`, a tab or a carriage return gets a leading `'`, as the cost export does. At most 100,000 entries per
export (413 beyond: narrow the range).

```

with

```markdown
**Export CSV** and **Export JSONL** download the entries of the chosen range (`GET
/api/governance/audit/export?from&to&format=csv|jsonl`), oldest first. JSONL lines are byte for byte what the log
holds, so a copy can be verified with the same key. The CSV has one line per entry (`seq, time, actor, actor_id, ip,
action, op, target_type, target_id, target_name, outcome, status, changes, prev, mac`; `actor_id` is the account of a
dashboard entry, else the key, the rule or the device); a cell that starts with `=`,
`+`, `-`, `@`, a tab or a carriage return gets a leading `'`, as the cost export does. At most 100,000 entries per
export (413 beyond: narrow the range).

```

In `docs/governance.md`, replace

```markdown

| Route | What |
|---|---|
| `GET /api/governance/audit?from&to&actor&action&outcome&limit&before` | entries, newest first, at most 500 per page (default 100); `from`/`to` are `YYYY-MM-DD` (a UTC day; `to` is the end of it) or ISO times with a zone (`Z` or `+07:00`), `actor` a kind (`dashboard`, `apikey`, `cli`, `system`, `rule`) or a key id, `action` text found in the action or its `op`; the answer is `{ entries, next, skipped }` (`next` is the `before` of the next page, `skipped` counts unreadable lines) |
| `GET /api/governance/audit/export?from&to&format=jsonl\|csv` | a download |
| `GET /api/governance/audit/verify` | `{ ok, checked, from, to, brokenAt?, reason?, unverified?, rekeyedAt?, rekeyedTs? }` |
| `GET /api/governance/audit/status` | `{ retentionMonths, months: [{ month, bytes }], bytes, degraded, lastVerify }` |
```

with

```markdown

| Route | What |
|---|---|
| `GET /api/governance/audit?from&to&actor&user&action&outcome&limit&before` | entries, newest first, at most 500 per page (default 100); `from`/`to` are `YYYY-MM-DD` (a UTC day; `to` is the end of it) or ISO times with a zone (`Z` or `+07:00`), `actor` a kind (`dashboard`, `apikey`, `cli`, `system`, `rule`) or a key id, `user` an account name (`owner` included), `action` text found in the action or its `op`; the answer is `{ entries, next, skipped }` (`next` is the `before` of the next page, `skipped` counts unreadable lines) |
| `GET /api/governance/audit/export?from&to&format=jsonl\|csv` | a download |
| `GET /api/governance/audit/verify` | `{ ok, checked, from, to, brokenAt?, reason?, unverified?, rekeyedAt?, rekeyedTs? }` |
| `GET /api/governance/audit/status` | `{ retentionMonths, months: [{ month, bytes }], bytes, degraded, lastVerify }` |
```

In `docs/governance.md`, replace

```markdown

### Known limits

- One person per dashboard: entries say `dashboard`, the sign-in mode, the device and the address, not a name.
  Named users come with a later sub-project.
- The chain is anchored nowhere outside this machine. Someone with the key and the files can rewrite both.
- Someone who can write `.data/audit/` but not read the store can still cut the chain at an entry of their choosing:
  an `audit.rekey` of their own, sealed with a `chain.key` of their own, and entries of their own after it. What comes
```

with

```markdown

### Known limits

- Entries from before dashboard accounts ([docs/users.md](users.md)) have no `user` or `role`: they say `dashboard`,
  the sign-in mode, the device and the address.
- The chain is anchored nowhere outside this machine. Someone with the key and the files can rewrite both.
- Someone who can write `.data/audit/` but not read the store can still cut the chain at an entry of their choosing:
  an `audit.rekey` of their own, sealed with a `chain.key` of their own, and entries of their own after it. What comes
```

In `docs/install.md`, replace

```markdown
  - When 50 failures come from all addresses within 15 minutes, every address gets one free try instead of five. This slows a distributed attack down. It never refuses a fresh address its first try, so you can still sign in with the right password while someone else is guessing.
  - A browser that signed in before gets a signed "known browser" cookie (180 days). It has its own count, so guesses from its address (a shared office or carrier connection) or from everywhere at once do not lock it out.
  - Behind a proxy, the address is the right-most `X-Forwarded-For` entry.
- **Apps:** `/v1`, `/mcp` and `/a2a` need ZAAFPulse API keys, as they always have.
- **Host names:** with sign-in on, any host name is accepted. To restrict it, set `ZAAFPULSE_ALLOWED_HOSTS=ai.example.com,10.0.0.5`.
- **Browser protection:** every dashboard response carries a strict Content-Security-Policy, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
```

with

```markdown
  - When 50 failures come from all addresses within 15 minutes, every address gets one free try instead of five. This slows a distributed attack down. It never refuses a fresh address its first try, so you can still sign in with the right password while someone else is guessing.
  - A browser that signed in before gets a signed "known browser" cookie (180 days). It has its own count, so guesses from its address (a shared office or carrier connection) or from everywhere at once do not lock it out.
  - Behind a proxy, the address is the right-most `X-Forwarded-For` entry.
  - Each dashboard account (not the owner) has a budget of its own: after 10 failures for one account name, from any addresses, a fresh browser waits before it tries that account again ([docs/users.md](users.md#signing-in-and-passwords)).
- **Other people:** give them an account of their own, with a role, under **Settings → Users** ([docs/users.md](users.md)). They sign in with a name and a password; an empty name is the admin password.
- **Apps:** `/v1`, `/mcp` and `/a2a` need ZAAFPulse API keys, as they always have.
- **Host names:** with sign-in on, any host name is accepted. To restrict it, set `ZAAFPULSE_ALLOWED_HOSTS=ai.example.com,10.0.0.5`.
- **Browser protection:** every dashboard response carries a strict Content-Security-Policy, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
```

Create `docs/users.md`:

````markdown
# Dashboard users and roles

The owner can give other people their own sign-in to the dashboard: an auditor who reads the Governance pages and
exports evidence, a manager who reviews the AI inventory and approves agent runs. Nobody shares the admin password, and
every change is recorded under the person who made it. Accounts are local to this ZAAFPulse: there is no single
sign-on and no second factor.

## Roles

| Role | May |
|---|---|
| **owner** | everything, as before. The admin password signs in as the owner. |
| **reviewer** | everything a viewer may, plus inventory reviews (**Governance → Inventory**, `POST /api/governance/inventory`) and collaboration run approvals (`POST /api/gateway/collab` with `action` `get`, `list` or `resume`). |
| **viewer** | read-only, metadata only: the Overview, costs, quality, the Trace explorer's session list without titles, the evals' summary, monitors and alerts, runtimes, the integrations' status, the gateway with its secrets and texts taken out, and the Governance pages with the audit log, its export and the evidence export. |

Never for a reviewer or a viewer: a session's transcript, title or live view in the Trace explorer and a secret's
reveal (the session list comes without titles); a session's eval results, which carry the judge's explanations
(`GET /api/evals`); dataset and experiment details and exports; feedback notes; the second brain and the vault; the evals preview;
the integrations' settings; reading or searching a knowledge base, reading a gateway session, provider quotas, provider
tests and model lists; and every setting or action. The rule is **deny by default**: the server checks each `/api`
request of a reviewer or a viewer against an explicit list per role (`lib/users/policy.js`), and anything not listed
is `403 { "error": "your role cannot do this" }`, recorded in the audit log as refused (a read included). The owner is
never restricted.

The gateway (`GET /api/gateway`) shows a reviewer or a viewer its agents without their system prompt, memory notes
without their text, sessions without their title, runs without their task, error or approval question, API keys with
only their id, name, prefix, scopes, budget and dates, providers without a secret reference (and only their sign-in
type), and no quota. A reviewer reads a run with its text through `collab get` and `list`: they must read what they
approve.

## Where accounts work

- **Password sign-in** (server mode, a proxy, `ZAAFPULSE_AUTH=1`): the sign-in page asks for a name and a password. An
  empty name, or `owner`, is the admin password, so a script that posts `{ "password": … }` keeps working.
- **Local sign-in** (the default on 127.0.0.1): the owner still opens the dashboard with `zaafpulse open`. The sign-in
  page also takes a name and a password, for someone else using this machine. An account's sign-in replaces the owner's
  cookie in that browser, and `zaafpulse open` replaces an account's session; an account signing out does not sign the
  owner out anywhere.
- **No sign-in** (`ZAAFPULSE_AUTH=none`): there are no accounts. Everyone who reaches the dashboard is the owner, and
  the Users page says so.

## Settings → Users

The owner's page (`#settings/users`): every account with its name, display name, role, last sign-in and state, and:

- **Add**: a name (2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or a digit;
  not `owner`), a display name (at most 60 characters), the role and a first password of at least 12 characters. The
  person chooses a new password at the first sign-in.
- **Role**: reviewer or viewer. A new role ends the account's sessions at once.
- **Disable** / **Enable**: a disabled account cannot sign in, and its sessions end.
- **Reset password**: the owner sets a new one; the sessions end and the person chooses a new one at the next sign-in.
- **Delete**: the account goes and its sessions end. The audit log keeps what it did.

Removing the last reviewer or viewer is allowed: there is always the owner.

## Signing in and passwords

A wrong name and a wrong password get the same answer (`401 wrong name or password`), and so does a disabled account.
Each address has its lockout budget as before (5 free tries, then a wait that doubles), and each account name has one
of its own: after 10 wrong passwords for one account, from any number of addresses, every new try for that account
waits (30 s, doubling up to an hour). A browser that signed in before keeps only its own budget, so guessing elsewhere
does not lock a person out there. The owner has no such per-name budget, as before: a flood of guesses must never lock
the owner out of a fresh browser.

Until a new account has chosen its own password, every route but the password change, the sign-in state and sign-out
answers `403 change your password first`, and the dashboard sends it to the change-password step. Any account changes
its own password with **Change password** in the top bar (`POST /api/account/password { current, next }`): at least
12 characters and not the current one. The account's other sessions end; this one goes on. The owner's own password
stays with `zaafpulse set-password` on the server.

The top bar shows who is signed in and their role, with a sign-out link. A reviewer or a viewer also sees a one-line
banner ("Signed in as Vera · Viewer · read-only", or "· reviews and approvals"), and no Settings, Users or Rescan. A
refused action says "Your role cannot do this". The server is the authority: the page does not hide every button that
writes.

## Where accounts are kept

`.data/users.json`, private to the account that runs ZAAFPulse (0600), written whole through a temporary file and a
rename:

```json
{ "users": [{ "id": "usr_…", "name": "vera", "display": "Vera", "role": "viewer", "salt": "…", "hash": "…",
  "createdAt": "…", "updatedAt": "…", "disabled": false, "mustChange": true, "lastLoginAt": null }] }
```

A password is a scrypt hash with the admin password's parameters; no password, salt or hash ever leaves the server.
A file that cannot be read (a hand edit that broke it, an entry of the wrong shape, a name twice) is never written over:
nobody in it can sign in until it is fixed or moved, the owner still can, and the Users page says so.

Sessions live in memory: a restart signs every account out, as it does the owner in password mode.

## Audit log

A dashboard entry's actor names the account and its role: `{ "via": "dashboard", "user": "vera", "role": "viewer",
"mode": "password", "device": "…", "ip": "…" }` (`user` and `role` are `null` before sign-in, `owner` for the owner,
also in local and no-sign-in mode). Sign-in events name the account they were for as their target when it exists
(`{ "type": "user", "id": "vera" }`, `owner` for the admin password), never the password. New entries:

| Action | When |
|---|---|
| `user.create` | the owner adds an account (with its role) |
| `user.update` | the owner changes a role, a display name or disabled, as `changes` (`{ path, from, to }`) |
| `user.password_reset` | the owner sets a new password |
| `user.delete` | the owner deletes an account (with its role) |
| `account.password_change` | an account changes its own password |

**Governance → Audit log** filters by account (**User**; `GET /api/governance/audit?user=vera`), and the CSV export's
`actor_id` is the account for dashboard entries (the device for entries from before accounts).

## Compliance

The control **Dashboard roles and access reviews** (`access_roles`) maps to EU AI Act Art. 26(2) (human oversight
assigned to competent persons), NIST AI RMF GOVERN 2.1 (roles and responsibilities) and ISO/IEC 42001 A.3 (internal
organization). It is in place when sign-in is required and no account that may sign in has gone unused for more than
90 days (by its last sign-in, or its creation when it never signed in); partial when one has, an access review being
due ("2 accounts unused for over 90 days", a count, never a name); off without sign-in; unknown when `users.json`
cannot be read.

## API

| Route | Who | What |
|---|---|---|
| `GET /api/session` | anyone | `{ required, mode, signedIn, configured, accounts, user, role, display, mustChange }` |
| `POST /api/login` | anyone | `{ name?, password }` → `{ ok, user, role, display, mustChange }` and the session cookie |
| `GET /api/users` | owner | `{ mode, state, users }`; `state` is `ok`, `unreadable` or `off` (no sign-in) |
| `POST /api/users` | owner | `{ action: "create", name, display?, role, password }`, `{ action: "update", name, role?, display?, disabled? }`, `{ action: "reset", name, password }`, `{ action: "delete", name }` |
| `GET /api/users/names` | owner, reviewer | `{ names }`: the owner's and the enabled accounts' display names (the inventory review's owner suggestions) |
| `POST /api/account/password` | any account | `{ current, next }` |

Bad input is a 400 naming the field (`name: already taken`, `role: reviewer or viewer`, `password: at least 12
characters` …), an unknown account a 404, an unreadable `users.json` a 409, a change without sign-in a 409. Only JSON
is accepted (415).

## Known limits

- No single sign-on and no second factor (out of scope; the owner declined SSO).
- No per-user notification channels, no gateway API keys owned by a user, no command line for accounts.
- A display name that changes shows in an open session only after its next sign-in.
- A wrong current password on the change-password route is not throttled: whoever tries already holds that session.
````

- [ ] **Step 2: The whole suite**

Run: `npm test`
Expected: about 2471 tests, all pass but the 2 skipped. A timing test that fails once under load (`call: a helper
that keeps the pipes open cannot hold the call past its timeout`, `call: a slow CLI is stopped at the timeout…`, `a
Save queued while another hangs…`, `pii: a long run without an @…`, `GET /api/topology: 401 without sign-in…`) is
rerun on its own with `node --test <file>` before anything else is suspected.

- [ ] **Step 3: Commit**

```bash
git add docs/users.md docs/governance.md docs/install.md README.md
git commit -m "Document dashboard users and roles"
```

## Decisions made while planning

- **A router of its own.** The spec's Architecture names `lib/users/store.js` and `lib/users/policy.js`; the routes go
  to `lib/users/api.js` (like `lib/governance/api.js`), so `server.js` only wires them and the validation, the entries
  and the sessions a change ends are unit-tested with stand-ins (`test/users-api.test.js`).
- **The owner's display name** is `config.userName` (the Settings display name), passed as `ownerName`; it is what
  `sessionOf` returns for the owner and the first of `/api/users/names`.
- **`sessionOf` also returns `mustChange`** (R4 names `{ user, role, display }`): the gate needs it, and it saves a file
  read per request. A session copies the account's role at sign-in; that is safe because every role change ends the
  account's sessions (R4).
- **The per-account bucket is for accounts, not the owner** (R4). A bucket for `owner` would let a distributed guesser
  lock the owner out of every fresh browser, which `test/signin.test.js` ("never locks the owner out") forbids. Accounts
  get 10 free failures per name, counted with the address buckets; a known-device browser keeps only its own bucket,
  as before. The owner's throttle is unchanged.
- **One sign-in message for everyone.** `wrong password` becomes `wrong name or password` for the admin password too,
  so the answer never tells whether a name was given or exists; an unknown name is checked against a dummy hash.
- **Local mode** (R3): the sign-in route exists there only when accounts can exist; a name of `owner` (or none) is a
  400 pointing to `zaafpulse open` (it is not an account, so not enumeration). An account's sign-in clears the owner's
  `zp_local` in that browser and `/auth/local` clears an account's session, so one browser is one person; an account's
  sign-out no longer revokes every local cookie (only the owner's sign-out does).
- **Failed sign-ins name the account as the target** (R9 "sign-in events name the account") only when it exists or is
  the owner; a name that was never an account (perhaps a password typed in the wrong field) is not written.
- **Refused requests are entries even for reads** (R5 "recorded as a refused request entry"): `requestEntry(…, always:
  true)` keeps the route, the `op`, the short target fields, `refused` and 403; the gate records it and answers before
  the usual change entry is set up, so a refused write is one entry, not two.
- **The gate reads a gateway admin body once** for its `action`; `readBody` now keeps the read per request, so the route
  reads the same text. Only `POST /api/gateway/<word>` bodies are read early.
- **Viewer reads, against the controller's route classification:** `GET /api/evals` (eval results per session) is
  **not** a viewer read: its rows carry the judge's explanation of the session (content), and R6 lists only the evals
  summary, status, evaluators and settings. `GET /api/trace/sessions` stays a viewer read (R6 "sessions list") but
  without titles (`redactTraceSessions`), since a title is the session's first prompt and R6 says "never … title".
  `GET /api/datasets/settings` is added (a settings read like the evals' and the trace settings). `GET
  /api/gateway/logs` (the gateway request log, without trace ids) is a viewer read, as metadata. All `/api/openrouter`
  sections are allowed, `account` included (see Spec points).
- **The redacted gateway view is an allow-list** of top-level parts (`GATEWAY_PARTS`), so a part added later stays
  hidden until listed. Keys keep their `id` besides R7's fields (the usage and spend maps are keyed by it); a run's
  `pending` becomes `{ step }` (its question holds the plan's text), `error` goes; a provider keeps only `auth.type`
  (a client id is a credential part); the provider quota list is emptied (R6 refuses `quota`).
- **Ending sessions** (R4): a reset password, a new role, a disabled or deleted account end all its sessions; an
  account's own change ends all but the current one (and clears its `mustChange`); a display name or enabling ends
  nothing. A display name shows in an open session only after the next sign-in.
- **The accounts file is strict.** One malformed entry or a duplicate name makes the whole file unreadable (nobody in it
  signs in, nothing is written over it), rather than skipping entries silently. At most 200 accounts.
- **Audit filter and CSV** (R9): `?user=` takes `owner` or an account name; the CSV's `actor_id` is the account for
  dashboard entries that have one, so the device is no longer in the CSV for those (it stays in the JSON lines); no
  column is added.
- **Dashboard** (R10): the top bar gets `<display> · <Role>`, **Change password** (accounts only; `/login.html?change=1`)
  and **Sign out**; the sidebar's role line becomes `<Role> · sign out` (was `Admin · sign out`). Settings gets two
  sub-pages (`Preferences`, `Users`). A reviewer or a viewer gets the banner, no Settings links (the `PREFERENCES` label
  included) and no Rescan; `#settings` typed by hand shows "Settings and Users are for the owner of this dashboard.".
  The owner suggestions come from `GET /api/users/names` (owner and reviewer), since `/api/users` is the owner's.
- **Demo mode has no accounts** (`userStore` is null), so demo screenshots never write `users.json`.
- **Task order.** The store (1) before sign-in (2), which the policy (3) does not need but the gate (4) does; the audit
  filter (5) and the control (6) extend the spawned test of Task 4; the UI (7) calls every route; docs last (8).

## Spec points that do not fit

- **R6 vs the content of some viewer reads.** `/api/summary` carries quality events with short text (a correction the
  user typed, a risky command, an error line) and session project paths; `/api/logs` carries error lines; `/api/live`
  `~` log roots. R6 lists all three as viewer reads, so the plan allows them unchanged. The controller may want them
  redacted for non-owners (as the plan does for trace session titles).
- **R6 "openrouter catalogue".** `/api/openrouter?section=account` reads the owner's OpenRouter account (credits); the
  policy decides on the path only (R5), so every section is allowed. The controller may want the section passed as the
  action and `account` refused.
- **R6 `/api/evals`.** Not listed in R6 and it holds explanations: refused for non-owners (see Decisions), although the
  route classification given with the task listed it.
- **R4 `sessionOf` shape.** It returns `mustChange` as well.
- **R4 per-account bucket.** Not for the owner (see Decisions).
- **R7 keys "nothing but name, prefix, scopes, budget and dates".** The key's `id` is kept too.
- **R8 "every other route answers 403".** Static files (the page, its scripts) still load, so the page can send the
  person to the change step; `/api/session`, `/api/login` and `/api/logout` are answered before the gate, as the spec's
  error table says.
- **R9 "sign-in events name the account".** As the target, and only for an existing account or the owner (see
  Decisions); a successful sign-in names it in the actor.
- **R10 "the topbar shows … a sign-out link".** The sidebar keeps its sign-out too.
- **R11 "no account has gone unused for more than 90 days".** Disabled accounts are not counted; an account that never
  signed in counts from its creation; unreadable `users.json` is `unknown` (the catalogue's fourth status).
- **R11 clauses.** Art. 26(2), GOVERN 2.1 and A.3 are new clauses of their own (`eu-26-2`, `nist-gv-2.1`, `iso-a3`)
  beside Art. 26; the Compliance page and the evidence export show eighteen controls.
- **Error table "Disabled account → 401 like a wrong password".** The same answer and the same throttle; the check
  still runs the password, so the time does not tell either.
- **A wrong current password on `/api/account/password`** is not throttled: whoever tries already holds that session.
- **Not in scope and not done:** SSO, MFA, per-user channels, user-owned API keys, a CLI for accounts (R12).

## Self-review

- **Spec coverage.** R1 roles: Task 3 (`allowed`, the reviewer's extras), Task 4 (wired, spawned). R2 the file, its
  fields, 0600 and atomic, names, display, roles, scrypt, 12 characters: Task 1. R3 password, local and none modes:
  Task 2 (`test/users-auth.test.js` for each), Task 4 (none: `/api/users` off), Task 7 (the sign-in page). R4 sessions
  with identity, `check`, `sessionOf`, ending sessions, the account bucket: Task 2; the ends on disable/role/reset/
  delete: Task 4 (unit and spawned). R5 deny by default, 403 recorded as refused, the owner unrestricted: Tasks 3–4. R6
  every route class: Task 3's table and the check that every viewer read exists; spawned reads and refusals in Task 4.
  R7 the redacted view, reviewers' runs with text: Task 3 (pure), Task 4 (spawned: no `systemPrompt`; `collab list`
  and `resume` for the reviewer). R8 `mustChange`, the password route, any account, the owner with `set-password`:
  Tasks 1, 2, 4, 7. R9 actor fields, events, the five new entries, the filter, the CSV: Tasks 2, 4, 5. R10 Users page,
  top bar, banner, hidden controls, 403 text, the review drawer and its suggestions: Task 7 (and the names route in
  Task 4). R11 the control and its clauses: Task 6. R12: nothing added. Error table: Tasks 1, 2, 4. The spec's test
  list: store validation and hashing (1), the policy table (3), the redaction (3), session identity and ending (2, 4),
  the account throttle (2), the spawned scenario (4–6), the legacy login (2, 4), UI strings (7).
- **Placeholders.** None: every new file is given whole, every edit as an exact `old` → `new` pair.
- **Names and signatures.** `createUserStore` (Task 1) is what `createAuth({ accounts })` (Task 2), `createUsersApi`
  (Task 4) and `controlState().accounts` (Task 6) use; `sessionOf(req, renew)`, `endSessions(user, keepReq)`,
  `passwordChanged(req)` (Task 2) are what the gate and the router (Task 4) call; `allowed`, `redactGateway`,
  `redactTraceSessions` (Task 3) are what `server.js` requires as `roleAllows`, `redactGateway`, `redactTraceSessions`
  (Task 4); `requestEntry({ always })` (Task 4); `usrRoleLabel`, `usrWhoText`, `usrBannerText`, `usrMount` (Task 7) are
  what `app.js` calls; `govCanReview`, `govRole` (Task 7) and `GOV.filters.user` (Task 5) live in
  `public/governanceview.js`.
- **Globals.** Every new top-level name in `public/usersview.js` starts with `usr` or `USR` (tested); `isOwner`,
  `govCanReview` and `govRole` are new in their files; the one-global-scope test passes.
- **Secrets.** Tests assert that no password reaches `users.json`'s readers, the list, an event or an entry
  (`test/users-store.test.js`, `test/users-auth.test.js`, `test/users-api.test.js`, `test/users-http.test.js`), and that
  the redacted views hold no prompt, note, title, task, key secret, secret reference or quota
  (`test/users-policy.test.js`).
