# AI inventory and Compliance pages (AI Governance 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two answers an auditor or a security lead asks for first: which AI systems are in use here, who owns them
and how risky they are (**Governance → Inventory**, built at read time from the sources ZAAFPulse already reads plus a
new reader of the AI clients' MCP settings, with an owner's review per item and a Monitors rule for new unreviewed
systems), and which controls are in place, with evidence (**Governance → Compliance**, a fixed catalogue of seventeen
controls mapped to the EU AI Act, the NIST AI RMF and ISO/IEC 42001, with an evidence export). The Audit log moves to
`#governance/audit`.

**Architecture:**
- **Pure modules.** `lib/mcp-clients.js` (the AI client table, `isOurs` and the TOML reader, moved out of
  `scripts/register-mcp.js`, which now requires them); `lib/governance/mcp-scan.js` (JSONC, the per-server fields,
  `scanClients({ home, env, platform, read })`); `lib/governance/inventory.js` (`buildInventory(sources, reviews, seen,
  now)`, `cleanReview`); `lib/governance/controls.js` (the catalogue, the clauses, `controls(state)`);
  `lib/governance/evidence.js` (`evidenceReport`, `toJson`, `toMarkdown`). No I/O and no clock in any of them.
- **The store.** `lib/governance/seen.js`: `.data/governance/seen.json` (id → first and last day), written atomically
  through `lib/cost/files.js` `writePrivate`, only when it changed.
- **The router.** `lib/governance/api.js` builds the inventory (sources at most every 5 s, reviews and seen dates on
  every build), the controls and the evidence, and serves `GET|POST /api/governance/inventory`, `GET
  /api/governance/controls` and `GET /api/governance/evidence` beside the audit routes; it keeps the last counts for
  the Monitors.
- **Wiring.** `server.js` gathers the sources (`inventorySources()`: processes, the summary, trace sources, the
  gateway's lists, runtimes, integrations, the MCP scan, each capped at 2 s) and the control state (`controlState()`),
  passes `govRecord` for the `governance.export` entry, builds the inventory every 10 minutes, and feeds
  `createMonitors({ inventoryStatus })`.
- **Monitors.** Rule `inventory_unreviewed` in `lib/monitors/rules.js`, fed through `lib/monitors/index.js`.
- **Dashboard.** `public/governanceview.js` gets the Inventory (filters, review drawer) and Compliance (tables by
  framework, export links) pages; `SUBPAGES.governance` in `public/iso.js`; three sub-links in `public/index.html`;
  `app.js` passes the sub-page.

**Tech Stack:** Node ≥18 standard library only (CommonJS), `node:test`, plain browser JS in `public/` (classic
scripts sharing one global scope, loaded before `app.js`).

**Spec:** `docs/superpowers/specs/2026-11-03-governance-inventory-compliance-design.md` (AI Governance sub-project 3 of
4).

**Line numbers** in each task's **Files** list are where each replacement's `old` text starts when it is applied, in
order (the base is `a91b7b2` on `feat/gov-inventory`, with the earlier tasks of this plan applied). Every edit is an
exact `old` → `new` replacement (each `old` occurs exactly once in its file when the step runs) or a whole new file.
Re-read each location before editing it.

**Checked while planning:** Tasks 1–8 were built in order in a scratch worktree of `a91b7b2` (detached). The plan was then
generated from those commits and applied mechanically, task by task, to a fresh worktree of `a91b7b2`: 113 operations
(14 new files, 99 replacements, each `old` found exactly once), running each task's Step 2 command right after its
tests were added and its pass command after the rest. Every new test failed before its task (Tasks 1 and 2: the module
is missing; Task 3: 8 of 8; Task 4: 9 of 68, the 4 new tests and the 5 rule-list assertions; Task 5: 2 of 5; Task 6: 2
of 6; Task 7: 7 of 14; the tests that passed there are earlier tasks' spawned tests and the Audit log assertions that do
not change) and passed after it (Task 1's command: 47 tests; Task 2's: 5; Task 3's: 42; Task 4's: 138; Task 5's: 28;
Task 6's: 23; Task 7's: 57). The applied tree matched the scratch tree byte for byte. `npm test` on it: 2389 tests,
2387 pass, 2 skipped, 0 fail (47 s). This final text was applied the same way a second time, to another fresh worktree:
the same results step by step, the same tree, `npm test` 2389 / 2387 / 2 skipped / 0 fail (35 s). Baseline on `a91b7b2`: 2350 tests, 2346 pass, 2 skipped, 2 fail (`call: a slow CLI
is stopped at the timeout…` and `call: a helper that keeps the pipes open…`, the known timing tests: 38 of 38 when
`test/evals-claude-cli.test.js` ran again on its own). The 39 new tests in `test/governance-*.test.js` all pass; each
of the five spawned-server tests took 0.4–0.5 s. Twice during the scratch build a run of the spawned suites failed with
test durations of about 925 s and `ECONNRESET` (a spawned test takes under 1 s; most likely the machine was
suspended); the same suites passed when run again (5 s), and no full run showed it. `npx prettier@3 --check` passes on every file this plan creates and on the shared
files listed in Global Constraints; `server.js` and `public/styles.css` keep their `a91b7b2` counts (7 and 39). A demo
server (`DEMO=1`) answered the three new GET routes (101 items, 17 controls, the Markdown export). Not checked: the
pages in a real browser (their markup is tested through the exported helpers, S1 by rendering `<x>` in every field).

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test` (`npm test`; one file:
  `node --test test/<file>.test.js`). Plain browser JS in `public/`: classic `<script>` files loaded by
  `public/index.html` before `app.js`.
- **Pure modules.** `lib/mcp-clients.js` requires only `os`, `path` and `./platform`; `lib/governance/mcp-scan.js`
  only `../mcp-clients`; `lib/governance/inventory.js` only `../topology`; `lib/governance/controls.js` nothing;
  `lib/governance/evidence.js` only `./controls`. None reads a file or the clock: files come through `read`, the time
  through `now`. `lib/governance/seen.js` requires only `../cost/files`.
- **`scripts/register-mcp.js` behaves as before.** It requires the moved code and exports the same names
  (`clients`, `isOurs`, `toml.{find,tables,body,block}`, `NAME`, `OLD_NAMES`); `test/register.test.js` and
  `test/sea.test.js` are not changed and pass.
- **Privacy (binding).** The MCP scan never returns an env value, a header, a token or an argument other than the
  first package-looking one; a URL becomes its origin. An agent is read for `id`, `name`, `enabled`, `remoteUrl` (as
  an origin) only, never `systemPrompt`; a key for `id`, `name`, `revokedAt`, `expiresAt`, `lastUsedAt`, never its
  secret. Project folders are `~` paths on the dashboard only; the evidence export holds no path. The Monitors alert
  carries a count and kinds only. A failed source is named by its id, never its error text (which may hold a path).
- **Never in the way.** A source that fails or takes over 2 s is `null` and named in `failed`; a seen store that cannot
  be read or written never fails the page; recording the `governance.export` entry never stops the export.
- **One global scope.** New top-level names in `public/governanceview.js` start with `gov` or `GOV`. No name may repeat
  one in another page script (`test/cost-ui.test.js`: "every page script shares one global scope").
- **Loadable in Node.** `public/governanceview.js` ends with `if (typeof module !== 'undefined') module.exports = …`
  and touches no DOM at load time; tests `require` it with stand-ins for `esc`, `subHero` and `subTabs`.
- **Text only (S1).** Every server or owner string into HTML goes through `esc()`; a control's link is used only when
  it is a dashboard hash. CSP stays `script-src 'self'`: no inline handlers; the page's forms, selects and buttons use
  the delegated `submit`, `change`, `keydown` and `click` listeners installed once. Every `.innerHTML =` in the file
  takes a `gov…Html(` call or a template literal (`test/governance-ui.test.js` checks it).
- **Tests.**
  - Never call a real network and never signal a real process. The MCP scan's tests use an injected reader; no real
    client config is read.
  - Spawned `server.js` tests live in `test/governance-inventory-http.test.js` and use **ports 10000–10199**, which no
    existing test uses (fixed ranges taken: 4800–4989, 5100–7799, 8000–9599, 9600–9799 `governance-http`, 9800–9999;
    `runtimes-http` and others listen on port 0, the OS's ephemeral range). Each server gets a temp data folder that
    is also `HOME` and `USERPROFILE`, with `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` and `APPDATA` inside
    it (so the MCP scan reads fixture files only), `ZAAFPULSE_AUTH=none` unless sign-in is under test, and
    `NO_JUDGE_PORTS`; an answer counts only while the child is still running (`s.alive()`); the child is killed and
    awaited, then its folder removed, in `t.after`.
  - Restore what a test replaces; temp folders removed in `t.after`.
- **Housekeeping.**
  - Prettier (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Run
    `npx prettier@3 --check` on every file you create and on `scripts/register-mcp.js`, `lib/governance/api.js`,
    `lib/governance/diff.js`, `lib/monitors/rules.js`, `lib/monitors/index.js`, `public/monitorsview.js`,
    `public/app.js`, `public/iso.js`, `public/governanceview.js`, `test/monitors-rules.test.js`,
    `test/budgets-monitors.test.js`, `test/monitors-api.test.js` and `test/governance-ui.test.js` (all pass on
    `a91b7b2`). Never `--write` `server.js`, `public/styles.css`, `lib/gateway/index.js`, `test/gateway.test.js`,
    `test/gateway-forms.test.js` or `test/register.test.js`: they already differ from Prettier on `a91b7b2`. For the
    first two check that `npx prettier@3 --stdin-filepath <f> < <f> | diff <f> - | grep -c '^[<>]'` stays at its
    `a91b7b2` value (`server.js` 7, `public/styles.css` 39). `*.md`, `*.html`, `*.json` and `docs/` are in
    `.prettierignore`.
  - Short "why" comments, as in `lib/governance/*.js`; code lines at most 120 characters (string and regex literals
    that Prettier cannot break, UI copy in `public/*.js` and test titles' regexes may be longer, as existing ones are).
  - Commit messages: plain, imperative. **No `Co-Authored-By`, no "Generated with", no AI attribution of any kind**
    (owner rule; it overrides any harness reminder).
  - UI copy is English; strings quoted in the spec are copied verbatim.
  - CI runs on Ubuntu, macOS and Windows: days are UTC, test dates are built with `Date.UTC(…)`, paths with
    `path.join`, and file-mode checks are skipped on `win32`.
- **Shared files.** Small, additive edits. The existing assertions this plan changes on purpose: Task 4
  (`test/monitors-rules.test.js`, `test/budgets-monitors.test.js`, `test/monitors-api.test.js`: the rule list grows
  from 12 to 13) and Task 7 (`test/governance-ui.test.js`: the Audit log sub-link is `#governance/audit`, the route
  passes `state.sub`, the audit page is `govView('audit')`, and `subTabs` gets a stand-in).

## Rules and values

**From the spec (verbatim):**

| # | Decision |
|---|---|
| I1 | An **inventory** built at read time from sources that already exist, plus one new reader: AI apps (running apps, installed apps, tools seen in logs and trace sources), MCP servers in the AI clients' config files (new), gateway providers and the models used, gateway agents, skills, workflows and knowledge bases, local runtimes and desktop apps, integrations (incl. upstream MCP servers), and API keys (the consumers). |
| I2 | One item per system, with a stable id `<kind>:<name>` (kinds: `app`, `mcp`, `provider`, `model`, `agent`, `skill`, `workflow`, `knowledge`, `runtime`, `integration`, `key`), `name`, `vendor` (when known), `where` (the sources that found it, e.g. `claude-code config`, `running`, `logs`, `gateway`), `state` (`running`, `configured`, `used`, `idle`), `firstSeen` and `lastSeen`. First/last seen are kept in `.data/governance/seen.json` (id → two dates), updated when the inventory is built; nothing else is stored there. |
| I3 | The **MCP reader** lists every server in the client files `scripts/register-mcp.js` already knows (Claude Code `~/.claude.json` user scope and its per-project `projects[*].mcpServers`, Claude Desktop, Cursor, Kiro, Antigravity, VS Code `servers`, Windsurf, Gemini, Zed `context_servers`, Codex TOML `[mcp_servers.*]`). JSONC (comments, trailing commas) is read. ZAAFPulse's own entry is marked `ours`. Per server only: name, client(s), transport (`stdio` or `http`), the command's base name and the first package-looking argument (`npx -y @scope/pkg` → `@scope/pkg`), or the URL's origin. Never env values, headers, other args, or tokens. Project paths are shown as `~` paths on the dashboard only. |
| I4 | Owner-entered **review** per item, saved in config.json `governance.inventory[<id>] = { owner, purpose, risk, decision, note, reviewedAt }` through `POST /api/governance/inventory` (so every change is a `config.change` audit entry). `risk`: `minimal`, `limited`, `high`, `unacceptable` (the EU AI Act tiers) or empty. `decision`: `approved`, `restricted`, `blocked` or empty. Text fields at most 200 characters. An item with no review is **unreviewed**. A review for an item that no longer appears is kept and shown as `gone`. |
| I5 | Monitors rule `inventory_unreviewed` (aggregate, default on, never auto-pauses): triggers when an item first seen in the last 7 days has no review — a new, unreviewed AI system (shadow AI). The alert carries the count and kinds only, never names. |
| I6 | **Compliance** page: a fixed catalogue of controls ZAAFPulse provides, each mapped to clauses — EU AI Act Art. 12 (record-keeping), Art. 14 (human oversight), Art. 26 (deployer obligations: logs kept ≥ 6 months, oversight assigned, monitoring), Art. 50 (transparency, where the owner's use applies); NIST AI RMF functions and categories (GOVERN 1.x, MAP 1.x, MEASURE 2.x, MANAGE 2.x/4.x); ISO/IEC 42001 Annex A controls (A.2 policies, A.5 impact, A.6 life cycle, A.7 data, A.8 information to interested parties, A.9 use, A.10 third parties). Each control has a live **status** (`in place`, `partial`, `off`) computed from current settings and state, and the **evidence**: the setting's value, a count, a date, and a link to the dashboard page that shows it. |
| I7 | The control catalogue (initial set): guardrails secrets/pii/injection modes; audit log on, verify result, retention ≥ 6 months; gateway usage log; external providers need approval; API keys with scopes/budgets/expiry; human approval gates on workflows; agent pause/stop available; Monitors rules on (incl. guardrail_block, audit_chain_broken, inventory_unreviewed); evals running; datasets experiments; cost budgets that block or pause; secrets in the OS store; sign-in mode; content capture off; OTel export; trace retention; inventory coverage (share of items reviewed, items with a high/unacceptable risk and their decision). |
| I8 | Wording: the page says "evidence for your assessment, not a certification", names the framework versions (EU AI Act Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744; NIST AI RMF 1.0; ISO/IEC 42001:2023) and never says "compliant". |
| I9 | **Evidence export**: `GET /api/governance/evidence?format=json|md` — the inventory (with reviews, without paths), the control statuses with evidence and clause mapping, the audit verify result and retention, the generated time and ZAAFPulse version. Markdown is a readable report; JSON is the same data. Dashboard session only. The export is itself recorded (it is a GET, so as a dedicated `governance.export` entry). |
| I10 | Small API gaps closed for the evidence: `otel.status()` and trace retention exposed through `GET /api/governance/controls` (the compliance answer); no new settings. |
| I11 | Pages: the Governance menu gets three sub-pages — **Inventory** (`#governance`, the default), **Compliance** (`#governance/compliance`) and **Audit log** (`#governance/audit`, moved from `#governance`; the sidebar sub-link and the docs point to the new hash, and `#governance` now opens Inventory). |
| I12 | Out of scope: per-person owners linked to users (sub-project 4 adds users; until then owner is free text), questionnaires/DPIA workflows, external attestations, blocking an AI system from the inventory (the decision is a record; enforcement stays with gateway keys/guardrails). |

Error handling (spec): a client config file unreadable or malformed → that client shows `unreadable`, the others are
still listed. A source fails while building the inventory → built from the rest, the failed source listed. Bad review
input → 400 naming the field, nothing written. `seen.json` unreadable → rebuilt from now (first seen becomes today),
never fails the page.

**Values this plan fixes (where the spec leaves a choice):**

- **V1. Ids.** `<kind>:<name>`, the name trimmed, lowercased and cut to 120 characters. The name is the system's own
  id where it has one: an app's `lib/processes.js` `APPS` id (`app:claude`), a provider, agent, workflow, knowledge
  base, runtime or integration id, a key id (`key:key_ab12`, its name is the item's `name`); a skill's name, a model's
  name, an MCP server's name. Ollama and LM Studio (`lib/topology.js` `RUNTIME_APPS`) are `runtime:` items whether
  seen as a running app or as a runtime row. The trace source `gemini` is `app:antigravity` (Gemini CLI is part of that
  app in `lib/processes.js`); the trace source `gateway` is not an app. A gateway route (`router/<name>`) is not a
  model. A runtime row of kind `app` (the desktop apps) is an `app:` item.
- **V2. Where.** `running`, `installed`, `logs`, `trace`, `runtimes`, `gateway`, `gateway usage`, `integrations`, and
  `<client name> config` (`Claude Code config`, `Cursor config` …: the display names of `lib/mcp-clients.js`), in the
  order the sources are read.
- **V3. State.** The best of `running`, `used`, `configured`, `idle` over the sources. `running`: a live app process, a
  running runtime. `used`: a tool active in the logs in the last 30 days, an MCP server in the logs' tool use, a model
  in the logs or the gateway's usage this month, a trace source with sessions, a key used in the last 30 days.
  `configured`: in a config (MCP client file, gateway provider, agent, workflow, knowledge base, a skill installed in
  `~/.claude/skills` or `~/.agents/skills`, an active key, an integration, an owner's runtime entry). `idle`:
  installed but not running, switched off, a key revoked or expired, a tool last active over 30 days ago, a skill not
  installed. A review whose id has no item makes an item with state `gone` (kind and name from the id).
- **V4. An item.** `{ id, kind, name, vendor, where, state, firstSeen, lastSeen, review, status }` (`status`:
  `unreviewed`, `reviewed`, `gone`), plus where known `origin` (a provider's base URL, an agent's remote URL, an
  integration's URL, an MCP server's URL: origins only), `type` (integration), and for MCP servers `transport`,
  `command`, `package`, `ours`, `clients` (display names), `projects` (`~` paths). Sorted by kind (the I2 order), then
  name (`localeCompare(…, 'en')`). Vendors: apps and runtimes from a fixed map (Anthropic, OpenAI, Google, Anysphere,
  Amazon Web Services, Ollama, LM Studio), providers and models from `lib/topology.js` `providerOf` (none for
  `other`), integrations from their type (Dynatrace, Arize, n8n, OmniRoute), skills `ZAAFPulse`.
- **V5. MCP scan.** `scanClients({ home, env, platform, read })` → `[{ client, name, file (~ path), state: 'ok' |
  'unreadable', servers }]`; a missing file (`read` returns null) is left out; a read that throws, a parse that
  fails, a servers key that is not an object, or Codex `mcp_servers` written as dotted keys or an inline table is
  `unreadable` with no servers. A server: `{ name (≤120), transport, command, package, origin, ours, project? }`.
  `transport` is `http` when the entry has `url`, `serverUrl` (Windsurf) or `httpUrl` (Gemini), or no command and a
  `type`/`transport` of `http`, `https`, `sse` or `streamable-http`. `command`: the base name (`npx` from `npx -y …`,
  `node.exe` from a Windows path), null unless it is a plain file name. `package`: the first argument matching
  `^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,100}(@[a-z0-9.^~*<>=-]{1,40})?$` that is not a flag and not
  token-like (`sk-`, `ghp_`, `xoxb-` … prefixes, or 24+ letters and digits with a digit and no separator). `origin`:
  `new URL(url).origin` for `http:`/`https:`, else null. `ours`: `isOurs` from `lib/mcp-clients.js`. Zed's older
  `"command": { "path", "args" }` is read. At most 500 servers per file. JSON is parsed plain first, JSONC on failure.
- **V6. Sources.** `server.js` `inventorySources()` → `{ live, summary, trace, gateway, runtimes, integrations, mcp }`,
  each through `topoSource` (2 s cap), `null` when it failed. The router reads them at most every 5 s (one read at a
  time); the reviews and the seen dates are read on every build. The inventory is built on `GET
  /api/governance/inventory`, `GET /api/governance/controls`, the evidence export, at start and every 10 minutes (as
  the system actor). Demo mode: `demo.live()`, the demo integrations, and no MCP scan (`[]`).
- **V7. Seen dates.** `{ id: { first, last } }`, UTC days (`YYYY-MM-DD`). A present item keeps its stored `first` (else
  today) and gets `last` = today; an entry without two valid days is dropped; entries of items no longer seen are kept.
  Written through `writePrivate` (0600, temp file, fsync, rename) only when the text changed.
- **V8. Reviews (I4).** `POST /api/governance/inventory` `{ id, owner?, purpose?, risk?, decision?, note? }` or
  `{ id, clear: true }`; JSON only (415), a body that does not parse is 400 `bad request body`. Messages (400, the
  first in `error`, all in `errors`): `body: an object`, `<field>: not a review field`, `id: an inventory id
  (<kind>:<name>)`, `owner|purpose|note: text of at most 200 characters` (after trimming), `risk: minimal, limited,
  high, unacceptable or empty`, `decision: approved, restricted, blocked or empty`, `clear: true or left out`,
  `inventory: at most 2000 reviews` (a new id past 2000). Saved as `{ owner, purpose, risk, decision, note, reviewedAt
  }` (`reviewedAt` the server's ISO time) beside the other `governance` fields; the answer is `{ id, review }`
  (`review: null` after a clear). A config.json write is the usual `config.change` entry; the request is its usual
  request entry (target `{ type: 'governance', id }`).
- **V9. Audit diff (A5).** The entry names directly under `governance.inventory` are item ids, not field names:
  `lib/governance/diff.js` treats that map like `cost.keyCenters`, so a review of `key:key_ab12` shows its fields
  (`governance.inventory.key:key_ab12.owner: ∅ → Ops`). Every other secret-looking name is still masked.
- **V10. Monitors (I5).** `inventory_unreviewed`: title `Unreviewed AI system`, describe `An AI system first seen in
  the last 7 days has no review in Governance → Inventory.`, aggregate, `params: {}`, on by default, no auto-pause. Its
  input is the last build's `{ newUnreviewed, newKinds }`: items present, unreviewed, not `ours`, whose `firstSeen` is
  today or one of the 6 days before. No input → `no_data` (threshold 1); 0 → `ok` (0, 1); more → `triggered` with the
  count, threshold 1, title the kinds (only the eleven kind words), sorted and joined with `, `. Measure:
  `<n> new AI system(s) not reviewed`.
- **V11. Controls (I6, I7).** Seventeen, in this order, with their page and clauses:

  | id | title | link | clauses |
  |---|---|---|---|
  | `guardrails` | Gateway guardrails | `#gateway/router` | MEASURE 2.7, MEASURE 2.10, A.2, A.7 |
  | `audit_log` | Governance audit log | `#governance/audit` | Art. 12, Art. 26, GOVERN 1.4, MANAGE 4.1, A.6 |
  | `usage_log` | Gateway request log | `#gateway` | Art. 12, Art. 26, MEASURE 2.4, A.6 |
  | `provider_approval` | External providers need approval | `#gateway/providers` | Art. 26, GOVERN 1.4, A.10 |
  | `api_keys` | API keys with scopes, budgets and expiry | `#endpoint/keys` | Art. 26, GOVERN 1.4, MANAGE 2.4, A.9 |
  | `approval_gates` | Human approval in workflows | `#a2a` | Art. 14, Art. 26, MANAGE 4.1, A.9 |
  | `agent_control` | Pause and stop an agent | `#settings/monitors` | Art. 14, MANAGE 2.4, A.9 |
  | `monitors` | Monitors rules | `#settings/monitors` | Art. 26, MEASURE 2.4, MANAGE 4.1, A.6 |
  | `evals` | Evals running | `#quality` | MEASURE 2.3, MEASURE 2.4, A.6 |
  | `experiments` | Dataset experiments | `#datasets/experiments` | MEASURE 2.1, MEASURE 2.3, A.6, A.7 |
  | `cost_budgets` | Budgets that block or pause | `#cost/budgets` | MANAGE 2.4, A.9 |
  | `secret_store` | Secrets in the OS store | `#settings` | MEASURE 2.7, A.7 |
  | `sign_in` | Dashboard sign-in | `#settings` | Art. 26, MEASURE 2.7, A.9 |
  | `content_capture` | Content capture off | `#trace` | MEASURE 2.10, A.7 |
  | `otel_export` | OpenTelemetry export | `#settings` | Art. 12, MEASURE 2.4, MANAGE 4.1, A.6 |
  | `trace_retention` | Trace retention | `#trace` | Art. 12, Art. 26, MEASURE 2.4, A.6 |
  | `inventory_coverage` | AI inventory reviewed | `#governance` | Art. 26, Art. 50, GOVERN 1.6, MAP 1.1, A.5, A.8 |

  Statuses (`share(good, all)`: `in place` when all count or there is nothing to count, `off` when none does,
  `partial` between): guardrails by how many of the three checks are not `off` (3/1–2/0); audit log `off` when degraded
  or the last verify failed, `partial` before any verify, else `in place`; usage log always `in place`; provider
  approval `partial` when an external provider is served without a recorded `approved` (set up before approvals),
  else `in place`; keys `share(active keys with a budget or an expiry, active keys)`; gates `share(R2/R3 workflows
  with an approval step, R2/R3 workflows)`; agent control `off` with its reason when `off()` gives one; Monitors by how
  many of `guardrail_block`, `audit_chain_broken`, `inventory_unreviewed` are on (3/1–2/0); evals `in place` when the
  judge is on, ready and judge evaluators are on, else `partial`; experiments `off` without a dataset, `in place` with a
  `done` experiment that ended in the last 90 days, else `partial`; budgets `off` without one, `in place` when one
  blocks or pauses, else `partial`; secret store `in place` for `keychain`/`libsecret`, else `partial`; sign-in `off`
  for `none`; content capture `off` when the OTel export captures content; OTel `off` when not enabled, `partial` with
  an exporter error; trace retention `off` without a store or with tracing off, `in place` from 183 days, else
  `partial`; inventory `in place` when every item is reviewed with no high/unacceptable item undecided and no
  unacceptable item unblocked (or there is no item), `off` when none is reviewed, else `partial`. A part that is null
  or throws: `off`, evidence `could not be read`. Evidence strings: the ones the tests in Task 5 spell out.
- **V12. Clauses and wording (I6, I8).** EU AI Act `Art. 12` Record-keeping, `Art. 14` Human oversight, `Art. 26`
  Deployer obligations: logs kept at least 6 months, oversight assigned, monitoring, `Art. 50` Transparency, where the
  owner's use applies; NIST AI RMF `GOVERN 1.4`, `GOVERN 1.6`, `MAP 1.1`, `MEASURE 2.1`, `2.3`, `2.4`, `2.7`, `2.10`,
  `MANAGE 2.4`, `MANAGE 4.1`; ISO/IEC 42001 `A.2`, `A.5`, `A.6`, `A.7`, `A.8`, `A.9`, `A.10` (the Annex A groups the
  spec names). Frameworks with the I8 versions verbatim. The notice: `Evidence for your assessment, not a
  certification. Statuses follow the current settings and state.` No string says "compliant".
- **V13. API (I9, I10).** `GET /api/governance/inventory` → `{ generatedAt, items, counts, failed, clients }`;
  `counts`: `{ total, byKind, byState, reviewed, unreviewed, gone, newUnreviewed, newKinds, high, unacceptable,
  riskUndecided, unacceptableNotBlocked }` (present items, but `gone`). `GET /api/governance/controls` → `{
  generatedAt, notice, frameworks, clauses, controls }`. `GET /api/governance/evidence?format=json|md` (default `json`;
  else 400 `format: json or md`): a download `zaafpulse-evidence-<UTC day>.<format>`, `application/json;
  charset=utf-8` or `text/markdown; charset=utf-8`; the report `{ title, notice, generatedAt, version, frameworks,
  controls, audit: { retentionMonths, degraded, lastVerify }, inventory: { counts, failed, items } }`, items without
  `projects` and no client file; the Markdown escapes `|`, `\`, `<` and `>` and folds line breaks in a cell. Each
  export records `{ action: 'governance.export', target: { type: 'evidence', id: <format> } }` through `govRecord`
  (the request's dashboard actor) before the answer; a refused format records nothing. A wrong method on any of
  these is 405, an unknown `/api/governance/*` path 404, as before.
- **U1. Copy.** Sub-pages `Inventory`, `Compliance`, `Audit log` (sidebar sub-links and sub-tabs). Inventory: eyebrow
  `GOVERNANCE · INVENTORY`, title `AI inventory`, line "Every AI system ZAAFPulse can see here: apps, the MCP servers
  in your AI clients, providers and models, agents, skills, workflows, knowledge bases, local runtimes, integrations
  and API keys. Record who owns each one, what it is for, its risk and your decision."; panel `Inventory` (`built when
  you open it`); filters `Kind` (`Any kind` …), `State` (`Any state` …), `Review` (`Any review`, `Unreviewed`,
  `Reviewed`, `Gone`); columns `Item`, `Kind`, `Where`, `State`, `First / last seen`, `Review`; `Review`/`Edit`
  buttons; the drawer's `Owner`, `Purpose`, `Risk (EU AI Act tier)`, `Decision`, `Note`, "The decision is a record:
  blocking a system stays with API keys and the guardrails.", `Save`, `Clear review`, `Cancel`. Compliance: eyebrow
  `GOVERNANCE · COMPLIANCE`, title `Compliance`, line "Evidence for your assessment, not a certification: the
  controls ZAAFPulse provides, their status from your current settings, and the clauses of the EU AI Act, the NIST
  AI RMF and ISO/IEC 42001 they map to."; `<n> in place · <n> partial · <n> off`, `Export Markdown`, `Export JSON`;
  one panel per framework (name, version) with `Clause`, `Control`, `Status` (`In place`, `Partial`, `Off`),
  `Evidence`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/mcp-clients.js` | create | the AI client table, `isOurs`, `NAME`, `OLD_NAMES`, the TOML reader, moved from `scripts/register-mcp.js` (Task 1) |
| `scripts/register-mcp.js` | modify (shared) | requires the moved code; same exports and behaviour (Task 1) |
| `lib/governance/mcp-scan.js` | create | JSONC, the per-server fields, `scanClients` (Task 1) |
| `lib/governance/inventory.js` | create | `buildInventory` (Task 2); `cleanReview` (Task 3) |
| `lib/governance/seen.js` | create | the seen dates store (Task 2) |
| `lib/governance/api.js` | modify (shared) | inventory routes and the build (Task 3); `inventoryStatus` (Task 4); controls (Task 5); evidence (Task 6) |
| `lib/governance/diff.js` | modify (shared) | review ids are not secret names (Task 3) |
| `lib/governance/controls.js` | create | the catalogue, clauses, frameworks, `controls(state)` (Task 5) |
| `lib/governance/evidence.js` | create | the report and its JSON and Markdown (Task 6) |
| `server.js` | modify (shared) | `inventorySources`, the seen store (Task 3); the Monitors input and the 10-minute build (Task 4); `controlState`, the trace retention in force (Task 5); `record` and `version` (Task 6) |
| `lib/monitors/rules.js`, `lib/monitors/index.js`, `public/monitorsview.js` | modify (shared) | `inventory_unreviewed`, its input, its words (Task 4) |
| `public/governanceview.js` | modify | Inventory and Compliance pages, the dispatcher (Task 7) |
| `public/app.js`, `public/iso.js`, `public/index.html`, `public/styles.css` | modify (shared) | route with sub-page, `SUBPAGES.governance`, sidebar, styles (Task 7) |
| `docs/governance.md`, `docs/monitors.md`, `README.md` | modify | documentation (Task 8) |
| `test/governance-mcp-scan.test.js` | create | Task 1 |
| `test/governance-inventory.test.js` | create | Task 2 |
| `test/governance-inventory-api.test.js` | create | Task 3 |
| `test/governance-inventory-http.test.js` | create (Task 3), modify (Tasks 5, 6) | spawned `server.js`, ports 10000–10199 |
| `test/governance-inventory-monitor.test.js` | create | Task 4 |
| `test/monitors-rules.test.js`, `test/budgets-monitors.test.js`, `test/monitors-api.test.js` | modify | the rule list (Task 4) |
| `test/governance-controls.test.js` | create | Task 5 |
| `test/governance-evidence.test.js` | create | Task 6 |
| `test/governance-inventory-ui.test.js` | create | Task 7 |
| `test/governance-ui.test.js` | modify | the moved Audit log page (Task 7) |

---
### Task 1: the shared client table and the MCP scan

**Files:**
- Create: `lib/mcp-clients.js`, `lib/governance/mcp-scan.js`
- Modify: `scripts/register-mcp.js` (lines 4, 58, 293)
- Test: `test/governance-mcp-scan.test.js` (create)

**Interfaces:**
- Consumes: `expandHome` from `lib/platform.js`; the existing `clients`, `isOurs`, TOML reader of
  `scripts/register-mcp.js` (moved here verbatim).
- Produces (`lib/mcp-clients.js`): `clients(home, { env, platform }) → { [id]: { name, kind, file, key?, jsonc?, cli?,
  detect, shape? } }` (unchanged), `isOurs(entry) → boolean`, `NAME = 'zaafpulse'`, `OLD_NAMES`, `toml: { key, tables,
  body, find, setPath }`.
- Produces (`lib/governance/mcp-scan.js`): `scanClients({ home, env = {}, platform, read }) → [{ client, name, file,
  state: 'ok' | 'unreadable', servers: [{ name, transport, command, package, origin, ours, project? }] }]` (V5;
  `read(file)` returns the text, `null` for a missing file, or throws); `parseJsonc(text) → value`,
  `parseConfig(text) → object` (throws), `serverOf(name, raw, project?)`, `commandOf(c)`, `packageOf(args)`,
  `originOf(url)`.

- [ ] **Step 1: Write the failing test**

Create `test/governance-mcp-scan.test.js`:

```js
// Governance inventory (AI Governance 3): the MCP scan (lib/governance/mcp-scan.js) over a fixture file for every
// client lib/mcp-clients.js knows, read through an injected reader, so no real config is ever touched. Env values,
// headers, other arguments, tokens and URL paths never come out; a file that cannot be read is "unreadable" and the
// others are still listed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanClients, parseJsonc, commandOf, packageOf, originOf } = require('../lib/governance/mcp-scan');
const { clients } = require('../lib/mcp-clients');
const register = require('../scripts/register-mcp');

const HOME = '/home/ana';
const FILES = clients(HOME, { env: {}, platform: 'linux' });
const SECRETS = [
  'SECRET-ENV-VALUE-1',
  'SECRET-HEADER-2',
  'SECRET-ARG-3',
  'SECRET-PASS-4',
  'SECRET-QUERY-5',
  'ghp_SECRETTOKEN6abcdefghijklmnop',
  'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  '/sse',
];
const secretEntry = {
  command: 'npx',
  args: ['-y', '@acme/mcp-server@1.2.0', '--token', 'SECRET-ARG-3'],
  env: { ACME_TOKEN: 'SECRET-ENV-VALUE-1' },
};
const remote = {
  url: 'https://user:SECRET-PASS-4@mcp.example.com/sse?key=SECRET-QUERY-5',
  headers: { Authorization: 'Bearer SECRET-HEADER-2' },
};
const ours = { command: '/usr/bin/node', args: ['/opt/zaafpulse/mcp.js'], env: { ZAAFPULSE_DATA: '/srv/zp' } };
const fixture = () => ({
  [FILES.claude.file]: JSON.stringify({
    mcpServers: { acme: secretEntry, zaafpulse: ours },
    projects: {
      '/home/ana/code/shop': { mcpServers: { db: { command: 'uvx', args: ['mcp-server-postgres', 'postgres://x'] } } },
      '/srv/other': { mcpServers: {} },
    },
  }),
  [FILES.kiro.file]: JSON.stringify({
    mcpServers: {
      tokens: { command: 'mytool', args: ['ghp_SECRETTOKEN6abcdefghijklmnop', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'] },
    },
  }),
  [FILES.cursor.file]: JSON.stringify({ mcpServers: { remote } }),
  [FILES.vscode.file]: `{
    // VS Code keeps its servers under "servers"
    "servers": {
      "github": {
        "type": "http",
        "url": "https://api.githubcopilot.com/mcp/",
        "headers": { "Authorization": "Bearer SECRET-HEADER-2" }
      },
      "files": {
        "type": "stdio",
        "command": "C:\\\\Program Files\\\\nodejs\\\\npx.cmd",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/ana"],
      },
    },
    /* a trailing comma and a "// not a comment" in a string */ "note": "a // b ,}",
  }`,
  [FILES['claude-desktop'].file]:
    '\ufeff{"mcpServers":{"acme":{"command":"npx","args":["-y","@acme/mcp-server@1.2.0"]}}}',
  [FILES.codex.file]: [
    'model = "gpt-5"',
    '',
    '[mcp_servers.docs]',
    'command = "npx"',
    'args = ["-y", "@docs/mcp", "--key", "SECRET-ARG-3"]',
    '',
    '[mcp_servers.docs.env]',
    'DOCS_KEY = "SECRET-ENV-VALUE-1"',
    '',
    '[mcp_servers.linear]',
    'url = "https://mcp.linear.app/sse?token=SECRET-QUERY-5"',
    '',
  ].join('\n'),
  [FILES.gemini.file]: '{ "mcpServers": { "ctx": { "httpUrl": "http://127.0.0.1:8811/mcp" } }, }',
  [FILES.windsurf.file]: JSON.stringify({ mcpServers: { surf: { serverUrl: 'https://surf.example.com/mcp' } } }),
  [FILES.zed.file]:
    '{ "context_servers": { "old-style": { "command": ' +
    '{ "path": "/usr/local/bin/uvx", "args": ["mcp-server-time"] } } } }',
  [FILES.antigravity.file]: '{ "mcpServers": ', // torn: unreadable
});
const reader = (files) => (f) => (Object.hasOwn(files, f) ? files[f] : null);

test('JSONC: comments and trailing commas go, strings are left alone, a BOM and an empty file are fine', () => {
  assert.deepEqual(parseJsonc('{ // one\n "a": [1, 2,], /* two */ "b": "x // y ,}" , }'), {
    a: [1, 2],
    b: 'x // y ,}',
  });
  assert.deepEqual(parseJsonc('\ufeff{"a":"\\"/*"}'), { a: '"/*' });
  assert.deepEqual(parseJsonc(''), {});
  assert.deepEqual(parseJsonc('null'), {});
  assert.throws(() => parseJsonc('{ /* open'), /comment is not closed/);
  assert.throws(() => parseJsonc('{ "a": }'), SyntaxError);
});

test('the parts kept of a server: the base name, the first package, the origin', () => {
  assert.equal(commandOf('npx -y @x/y'), 'npx');
  assert.equal(commandOf('C:\\Program Files\\nodejs\\node.exe'), 'node.exe');
  assert.equal(commandOf('/opt/my tool/run --token abc'), null);
  assert.equal(commandOf(''), null);
  assert.equal(packageOf(['-y', '@scope/pkg', 'other']), '@scope/pkg');
  assert.equal(packageOf(['/abs/path/server.js', 'mcp-server-fetch']), 'mcp-server-fetch');
  assert.equal(packageOf(['ghp_SECRETTOKEN6abcdefghijklmnop', 'sk-abc', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6']), null);
  assert.equal(originOf('https://u:p@h.example.com:8443/x?y=1'), 'https://h.example.com:8443');
  assert.equal(originOf('file:///etc/passwd'), null);
  assert.equal(originOf('not a url'), null);
});

test('scan: every client file is read, with names, transports, base names, packages and origins only', () => {
  const out = scanClients({ home: HOME, env: {}, platform: 'linux', read: reader(fixture()) });
  const by = Object.fromEntries(out.map((c) => [c.client, c]));
  assert.deepEqual(Object.keys(by).sort(), [
    'antigravity',
    'claude',
    'claude-desktop',
    'codex',
    'cursor',
    'gemini',
    'kiro',
    'vscode',
    'windsurf',
    'zed',
  ]);
  assert.deepEqual(by.claude, {
    client: 'claude',
    name: 'Claude Code',
    file: '~/.claude.json',
    state: 'ok',
    servers: [
      {
        name: 'acme',
        transport: 'stdio',
        command: 'npx',
        package: '@acme/mcp-server@1.2.0',
        origin: null,
        ours: false,
      },
      { name: 'zaafpulse', transport: 'stdio', command: 'node', package: null, origin: null, ours: true },
      {
        name: 'db',
        transport: 'stdio',
        command: 'uvx',
        package: 'mcp-server-postgres',
        origin: null,
        ours: false,
        project: '~/code/shop',
      },
    ],
  });
  assert.deepEqual(by.kiro.servers, [
    { name: 'tokens', transport: 'stdio', command: 'mytool', package: null, origin: null, ours: false },
  ]);
  assert.deepEqual(by.cursor.servers, [
    { name: 'remote', transport: 'http', command: null, package: null, origin: 'https://mcp.example.com', ours: false },
  ]);
  assert.deepEqual(
    by.vscode.servers.map((s) => [s.name, s.transport, s.command, s.package, s.origin]),
    [
      ['github', 'http', null, null, 'https://api.githubcopilot.com'],
      ['files', 'stdio', 'npx.cmd', '@modelcontextprotocol/server-filesystem', null],
    ],
  );
  assert.equal(by.vscode.file, '~/.config/Code/User/mcp.json');
  assert.deepEqual(
    by.codex.servers.map((s) => [s.name, s.transport, s.command, s.package, s.origin]),
    [
      ['docs', 'stdio', 'npx', '@docs/mcp', null],
      ['linear', 'http', null, null, 'https://mcp.linear.app'],
    ],
  );
  assert.equal(by['claude-desktop'].servers[0].package, '@acme/mcp-server@1.2.0');
  assert.equal(by.gemini.servers[0].origin, 'http://127.0.0.1:8811');
  assert.equal(by.windsurf.servers[0].origin, 'https://surf.example.com');
  assert.deepEqual(by.zed.servers[0], {
    name: 'old-style',
    transport: 'stdio',
    command: 'uvx',
    package: 'mcp-server-time',
    origin: null,
    ours: false,
  });
  assert.deepEqual(by.antigravity, {
    client: 'antigravity',
    name: 'Antigravity',
    file: '~/.gemini/config/mcp_config.json',
    state: 'unreadable',
    servers: [],
  });
  const text = JSON.stringify(out);
  for (const s of SECRETS) assert.ok(!text.includes(s), `${s} must not come out`);
  assert.ok(!text.includes('/home/ana'), 'folders only as ~ paths');
});

test('scan: an unreadable file, or dotted mcp_servers keys in Codex, is unreadable; a missing file is left out', () => {
  const files = {
    [FILES.cursor.file]: JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'a-mcp'] } } }),
    [FILES.codex.file]: 'mcp_servers.x.command = "npx"\n',
    [FILES.kiro.file]: JSON.stringify({ mcpServers: ['not', 'an', 'object'] }),
    [FILES.zed.file]: '[1, 2]',
  };
  const read = (f) => {
    if (f === FILES.claude.file) throw Object.assign(new Error(`EACCES: ${f}`), { code: 'EACCES' });
    return reader(files)(f);
  };
  const out = scanClients({ home: HOME, env: {}, platform: 'linux', read });
  assert.deepEqual(
    out.map((c) => [c.client, c.state, c.servers.length]),
    [
      ['claude', 'unreadable', 0],
      ['kiro', 'unreadable', 0],
      ['cursor', 'ok', 1],
      ['codex', 'unreadable', 0],
      ['zed', 'unreadable', 0],
    ],
  );
  assert.ok(!JSON.stringify(out).includes('EACCES'), 'no error text, which can hold a path');
});

test('scan: Windows home folders are ~ in either slash and any case; the table is the one register-mcp uses', () => {
  const home = 'C:\\Users\\Ana';
  const win = clients(home, { env: { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' }, platform: 'win32' });
  const files = {
    [win.claude.file]: JSON.stringify({
      projects: { 'c:/users/ana/Code/app': { mcpServers: { x: { command: 'npx', args: ['x-mcp'] } } } },
    }),
  };
  const out = scanClients({
    home,
    env: { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' },
    platform: 'win32',
    read: reader(files),
  });
  assert.equal(out[0].file, '~\\.claude.json');
  assert.equal(out[0].servers[0].project, '~/Code/app');
  assert.deepEqual(Object.keys(register.clients(HOME, { env: {} })), Object.keys(FILES));
  assert.equal(register.isOurs, require('../lib/mcp-clients').isOurs);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/governance-mcp-scan.test.js`
Expected: FAIL (`Cannot find module '../lib/governance/mcp-scan'`).

- [ ] **Step 3: Move the client table and the TOML reader into `lib/mcp-clients.js`**

The function bodies below are the ones in `scripts/register-mcp.js` today, moved without a change.

Create `lib/mcp-clients.js`:

```js
// The AI clients that keep MCP server settings: where each one keeps its file, how our own entry is recognised, and
// a reader for the TOML subset Codex CLI writes. Shared by scripts/register-mcp.js (which writes our entry) and the
// governance MCP scan (lib/governance/mcp-scan.js, which lists every entry). Pure but for the home folder and the
// environment it is given.
const os = require('os');
const path = require('path');
const { expandHome } = require('./platform');

const NAME = 'zaafpulse';
// Earlier releases registered the stdio server under this name; it is replaced when it points at ZAAFPulse.
const OLD_NAMES = ['ai-command-center'];

// Every client with its config file. "home" given without "env" (tests) never reads this machine's variables, so a
// test can never reach a real config through CODEX_HOME, APPDATA or XDG_CONFIG_HOME.
// Paths follow each vendor's documentation (docs/integrations.md lists the sources).
function clients(home, { env, platform = process.platform } = {}) {
  const e = env || (home == null ? process.env : {});
  const h = home == null ? os.homedir() : home;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const j = (...p) => P.join(h, ...p);
  const abs = (p) => P.resolve(expandHome(p));
  const appData = e.APPDATA || j('AppData', 'Roaming');
  const xdg = e.XDG_CONFIG_HOME || j('.config');
  // An app's per-user folder: ~/Library/Application Support on macOS, %APPDATA% on Windows, ~/.config on Linux.
  const appDir = (...p) =>
    platform === 'darwin'
      ? j('Library', 'Application Support', ...p)
      : platform === 'win32'
        ? P.join(appData, ...p)
        : P.join(xdg, ...p);
  const claudeDir = e.CLAUDE_CONFIG_DIR ? abs(e.CLAUDE_CONFIG_DIR) : null;
  const codexHome = e.CODEX_HOME ? abs(e.CODEX_HOME) : j('.codex');
  // Windsurf became Devin Desktop (June 2026); its docs now name ~/.config/devin. A Windsurf install that predates
  // the rename keeps ~/.codeium/windsurf, so that file is kept up to date too whenever its folder exists.
  const devin = platform === 'win32' ? P.join(appData, 'devin') : P.join(xdg, 'devin');
  const windsurf = j('.codeium', 'windsurf');
  const zed =
    platform === 'win32' ? P.join(appData, 'Zed') : platform === 'darwin' ? j('.config', 'zed') : P.join(xdg, 'zed');
  const stdio = (m) => ({ type: 'stdio', ...m });
  return {
    claude: {
      name: 'Claude Code',
      kind: 'claude',
      file: claudeDir ? P.join(claudeDir, '.claude.json') : j('.claude.json'),
      cli: 'claude',
      detect: [claudeDir || j('.claude'), j('.claude.json')],
    },
    kiro: { name: 'Kiro', kind: 'json', file: j('.kiro', 'settings', 'mcp.json'), detect: [j('.kiro')] },
    antigravity: {
      name: 'Antigravity',
      kind: 'json',
      file: j('.gemini', 'config', 'mcp_config.json'),
      detect: [j('.gemini', 'config'), j('.gemini', 'antigravity')],
    },
    cursor: { name: 'Cursor', kind: 'json', file: j('.cursor', 'mcp.json'), shape: stdio, detect: [j('.cursor')] },
    vscode: {
      name: 'VS Code',
      kind: 'json',
      key: 'servers',
      file: appDir('Code', 'User', 'mcp.json'),
      shape: stdio,
      jsonc: true,
      detect: [appDir('Code')],
    },
    'claude-desktop': {
      name: 'Claude Desktop',
      kind: 'json',
      file: appDir('Claude', 'claude_desktop_config.json'),
      detect: [appDir('Claude')],
    },
    codex: {
      name: 'Codex CLI',
      kind: 'codex',
      file: P.join(codexHome, 'config.toml'),
      cli: 'codex',
      detect: [codexHome],
    },
    gemini: {
      name: 'Gemini CLI',
      kind: 'json',
      file: j('.gemini', 'settings.json'),
      jsonc: true,
      cli: 'gemini',
      detect: [j('.gemini', 'settings.json')],
    },
    windsurf: {
      name: 'Windsurf / Devin Desktop',
      kind: 'json',
      file: P.join(devin, 'mcp_config.json'),
      detect: [devin],
    },
    'windsurf-legacy': {
      name: 'Windsurf (before the Devin rename)',
      kind: 'json',
      file: P.join(windsurf, 'mcp_config.json'),
      detect: [windsurf],
    },
    // Zed's settings.json is JSONC; it is edited only when it happens to be plain JSON.
    zed: {
      name: 'Zed',
      kind: 'json',
      key: 'context_servers',
      file: P.join(zed, 'settings.json'),
      jsonc: true,
      detect: [zed],
    },
  };
}

// Our server entry, recognised by its command: an mcp.js script, or the zaafpulse binary started with "mcp".
function isOurs(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.args)) return false;
  if (e.args.some((a) => /(^|[\\/])mcp\.js$/.test(String(a)))) return true;
  return /zaafpulse/i.test(path.basename(String(e.command || ''))) && e.args[0] === 'mcp';
}

// --- the TOML subset of Codex CLI's config.toml --------------------------------------------------------------------
// Tables, [[arrays]], key = value lines with strings, bare values (kept as written), arrays and inline tables. A
// multi-line string cannot be read: the table holding it reads as null.

// "a."b".c" -> ['a', 'b', 'c']
const tomlKey = (raw) =>
  (raw.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.]+/g) || []).map((p) => {
    const s = p.trim();
    return s.startsWith('"') ? JSON.parse(s) : s.startsWith("'") ? s.slice(1, -1) : s;
  });

// Each [table] or [[array]] header, skipping lines inside multi-line strings and arrays, so a "[" there is not one.
function tomlTables(text) {
  const out = [];
  let pos = 0;
  let multi = null;
  let depth = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const m = !multi && depth === 0 && line.match(/^[ \t]*(\[\[?)\s*([^[\]\r\n]+?)\s*\]\]?[ \t]*(#.*)?\r?\n?$/);
    if (m) out.push({ key: tomlKey(m[2]), start: pos, body: pos + line.length });
    else {
      for (const q of line.match(/"""|'''/g) || []) multi = !multi ? q : multi === q ? null : multi;
      if (!multi) {
        const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*/, '');
        depth = Math.max(0, depth + (bare.match(/[[{]/g) || []).length - (bare.match(/[\]}]/g) || []).length);
      }
    }
    pos += line.length;
  }
  return out;
}

// key = value lines: strings, bare values (numbers, booleans; kept as written), arrays and inline tables.
function tomlBody(s) {
  let i = 0;
  const ws = () => {
    while (i < s.length)
      if (/[ \t\r\n]/.test(s[i])) i++;
      else if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++;
      else break;
  };
  const str = () => {
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) throw new Error('multi-line string');
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"' && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      const v = JSON.parse(s.slice(i, j + 1)); // TOML basic strings use JSON's escapes
      i = j + 1;
      return v;
    }
    if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0 || s.slice(i, j).includes('\n')) throw new Error('literal string');
      const v = s.slice(i + 1, j);
      i = j + 1;
      return v;
    }
    return null;
  };
  const key = () => {
    const parts = [];
    do {
      ws();
      const q = str();
      if (q !== null) parts.push(q);
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
        if (!m) throw new Error(`key at ${i}`);
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
    } while (s[i] === '.' && ++i);
    return parts;
  };
  const value = () => {
    ws();
    const q = str();
    if (q !== null) return q;
    if (s[i] === '[' || s[i] === '{') {
      const arr = s[i++] === '[';
      const out = arr ? [] : {};
      for (;;) {
        ws();
        if (s[i] === (arr ? ']' : '}')) return (i++, out);
        if (arr) out.push(value());
        else {
          const k = key();
          if (s[i++] !== '=') throw new Error('inline table');
          setPath(out, k, value());
        }
        ws();
        if (s[i] === ',') i++;
        else if (s[i] !== (arr ? ']' : '}')) throw new Error('array or inline table');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(s.slice(i));
    if (!m) throw new Error(`value at ${i}`);
    i += m[0].length;
    return { raw: m[0] };
  };
  const out = {};
  for (;;) {
    ws();
    if (i >= s.length) return out;
    const k = key();
    if (s[i++] !== '=') throw new Error(`"=" expected after ${k.join('.')}`);
    setPath(out, k, value());
  }
}
function setPath(obj, keys, v) {
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' && !o[k].raw ? o[k] : (o[k] = {});
  o[keys[keys.length - 1]] = v;
}

// Where [mcp_servers.<name>] and its sub-tables sit, and what they hold (null when it cannot be read).
function tomlFind(text, name) {
  const t = tomlTables(text);
  const ours = (x) => x && x.key[0] === 'mcp_servers' && x.key[1] === name;
  const first = t.findIndex(ours);
  if (first < 0) return { start: -1 };
  let last = first;
  while (ours(t[last + 1])) last++;
  const end = last + 1 < t.length ? t[last + 1].start : text.length;
  let value = {};
  try {
    for (let k = first; k <= last; k++) {
      const body = tomlBody(text.slice(t[k].body, k + 1 < t.length ? t[k + 1].start : text.length));
      if (t[k].key.length === 2) Object.assign(value, body);
      else setPath(value, t[k].key.slice(2), body);
    }
  } catch {
    value = null;
  }
  const plain = (v) => (v && v.raw !== undefined ? v.raw : v);
  if (value && value.env) value.env = Object.fromEntries(Object.entries(value.env).map(([k, v]) => [k, plain(v)]));
  return { start: t[first].start, end, value, scattered: t.slice(last + 1).some(ours) };
}

module.exports = {
  clients,
  isOurs,
  NAME,
  OLD_NAMES,
  toml: { key: tomlKey, tables: tomlTables, body: tomlBody, find: tomlFind, setPath },
};
```

In `scripts/register-mcp.js`, replace

```js
// Config files are backed up before every write (the last 3 backups are kept) and only our own entry is touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// node + mcp.js, or the single-file binary with "mcp", plus the data folder when one was chosen (lib/platform.js).
const { mcpCommand, expandHome } = require('../lib/platform');

const NAME = 'zaafpulse';
// Earlier releases registered the stdio server under this name; it is replaced when it points at ZAAFPulse.
const OLD_NAMES = ['ai-command-center'];
const KEEP_BACKUPS = 3;

// Every client with its config file. "home" given without "env" (tests) never reads this machine's variables, so a
// test can never reach a real config through CODEX_HOME, APPDATA or XDG_CONFIG_HOME.
// Paths follow each vendor's documentation (docs/integrations.md lists the sources).
function clients(home, { env, platform = process.platform } = {}) {
  const e = env || (home == null ? process.env : {});
  const h = home == null ? os.homedir() : home;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const j = (...p) => P.join(h, ...p);
  const abs = (p) => P.resolve(expandHome(p));
  const appData = e.APPDATA || j('AppData', 'Roaming');
  const xdg = e.XDG_CONFIG_HOME || j('.config');
  // An app's per-user folder: ~/Library/Application Support on macOS, %APPDATA% on Windows, ~/.config on Linux.
  const appDir = (...p) =>
    platform === 'darwin'
      ? j('Library', 'Application Support', ...p)
      : platform === 'win32'
        ? P.join(appData, ...p)
        : P.join(xdg, ...p);
  const claudeDir = e.CLAUDE_CONFIG_DIR ? abs(e.CLAUDE_CONFIG_DIR) : null;
  const codexHome = e.CODEX_HOME ? abs(e.CODEX_HOME) : j('.codex');
  // Windsurf became Devin Desktop (June 2026); its docs now name ~/.config/devin. A Windsurf install that predates
  // the rename keeps ~/.codeium/windsurf, so that file is kept up to date too whenever its folder exists.
  const devin = platform === 'win32' ? P.join(appData, 'devin') : P.join(xdg, 'devin');
  const windsurf = j('.codeium', 'windsurf');
  const zed =
    platform === 'win32' ? P.join(appData, 'Zed') : platform === 'darwin' ? j('.config', 'zed') : P.join(xdg, 'zed');
  const stdio = (m) => ({ type: 'stdio', ...m });
  return {
    claude: {
      name: 'Claude Code',
      kind: 'claude',
      file: claudeDir ? P.join(claudeDir, '.claude.json') : j('.claude.json'),
      cli: 'claude',
      detect: [claudeDir || j('.claude'), j('.claude.json')],
    },
    kiro: { name: 'Kiro', kind: 'json', file: j('.kiro', 'settings', 'mcp.json'), detect: [j('.kiro')] },
    antigravity: {
      name: 'Antigravity',
      kind: 'json',
      file: j('.gemini', 'config', 'mcp_config.json'),
      detect: [j('.gemini', 'config'), j('.gemini', 'antigravity')],
    },
    cursor: { name: 'Cursor', kind: 'json', file: j('.cursor', 'mcp.json'), shape: stdio, detect: [j('.cursor')] },
    vscode: {
      name: 'VS Code',
      kind: 'json',
      key: 'servers',
      file: appDir('Code', 'User', 'mcp.json'),
      shape: stdio,
      jsonc: true,
      detect: [appDir('Code')],
    },
    'claude-desktop': {
      name: 'Claude Desktop',
      kind: 'json',
      file: appDir('Claude', 'claude_desktop_config.json'),
      detect: [appDir('Claude')],
    },
    codex: {
      name: 'Codex CLI',
      kind: 'codex',
      file: P.join(codexHome, 'config.toml'),
      cli: 'codex',
      detect: [codexHome],
    },
    gemini: {
      name: 'Gemini CLI',
      kind: 'json',
      file: j('.gemini', 'settings.json'),
      jsonc: true,
      cli: 'gemini',
      detect: [j('.gemini', 'settings.json')],
    },
    windsurf: {
      name: 'Windsurf / Devin Desktop',
      kind: 'json',
      file: P.join(devin, 'mcp_config.json'),
      detect: [devin],
    },
    'windsurf-legacy': {
      name: 'Windsurf (before the Devin rename)',
      kind: 'json',
      file: P.join(windsurf, 'mcp_config.json'),
      detect: [windsurf],
    },
    // Zed's settings.json is JSONC; it is edited only when it happens to be plain JSON.
    zed: {
      name: 'Zed',
      kind: 'json',
      key: 'context_servers',
      file: P.join(zed, 'settings.json'),
      jsonc: true,
      detect: [zed],
    },
  };
}

const exists = (p) => {
  try {
```

with

```js
// Config files are backed up before every write (the last 3 backups are kept) and only our own entry is touched.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// node + mcp.js, or the single-file binary with "mcp", plus the data folder when one was chosen (lib/platform.js).
const { mcpCommand } = require('../lib/platform');
// The client table, how our entry is recognised and the TOML reader, shared with the governance MCP scan.
const {
  clients,
  isOurs,
  NAME,
  OLD_NAMES,
  toml: { tables: tomlTables, body: tomlBody, find: tomlFind },
} = require('../lib/mcp-clients');

const KEEP_BACKUPS = 3;

const exists = (p) => {
  try {
```

In `scripts/register-mcp.js`, replace

```js
const showCmd = (cmd, args, platform) => [cmd, ...args].map((a) => quoteArg(a, platform)).join(' ');

// Our server entry, recognised by its command: an mcp.js script, or the zaafpulse binary started with "mcp".
function isOurs(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.args)) return false;
  if (e.args.some((a) => /(^|[\\/])mcp\.js$/.test(String(a)))) return true;
  return /zaafpulse/i.test(path.basename(String(e.command || ''))) && e.args[0] === 'mcp';
}
const envOf = (e) => JSON.stringify(Object.entries((e && e.env) || {}).sort(([a], [b]) => a.localeCompare(b)));
// Same command, arguments and environment: an entry that still starts this install the same way.
```

with

```js
const showCmd = (cmd, args, platform) => [cmd, ...args].map((a) => quoteArg(a, platform)).join(' ');

const envOf = (e) => JSON.stringify(Object.entries((e && e.env) || {}).sort(([a], [b]) => a.localeCompare(b)));
// Same command, arguments and environment: an entry that still starts this install the same way.
```

In `scripts/register-mcp.js`, replace

```js
// is cut out, replaced or appended, and every other byte stays as it was.

// "a."b".c" -> ['a', 'b', 'c']
const tomlKey = (raw) =>
  (raw.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.]+/g) || []).map((p) => {
    const s = p.trim();
    return s.startsWith('"') ? JSON.parse(s) : s.startsWith("'") ? s.slice(1, -1) : s;
  });

// Each [table] or [[array]] header, skipping lines inside multi-line strings and arrays, so a "[" there is not one.
function tomlTables(text) {
  const out = [];
  let pos = 0;
  let multi = null;
  let depth = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const m = !multi && depth === 0 && line.match(/^[ \t]*(\[\[?)\s*([^[\]\r\n]+?)\s*\]\]?[ \t]*(#.*)?\r?\n?$/);
    if (m) out.push({ key: tomlKey(m[2]), start: pos, body: pos + line.length });
    else {
      for (const q of line.match(/"""|'''/g) || []) multi = !multi ? q : multi === q ? null : multi;
      if (!multi) {
        const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*/, '');
        depth = Math.max(0, depth + (bare.match(/[[{]/g) || []).length - (bare.match(/[\]}]/g) || []).length);
      }
    }
    pos += line.length;
  }
  return out;
}

// key = value lines: strings, bare values (numbers, booleans; kept as written), arrays and inline tables.
function tomlBody(s) {
  let i = 0;
  const ws = () => {
    while (i < s.length)
      if (/[ \t\r\n]/.test(s[i])) i++;
      else if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++;
      else break;
  };
  const str = () => {
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) throw new Error('multi-line string');
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"' && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      const v = JSON.parse(s.slice(i, j + 1)); // TOML basic strings use JSON's escapes
      i = j + 1;
      return v;
    }
    if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0 || s.slice(i, j).includes('\n')) throw new Error('literal string');
      const v = s.slice(i + 1, j);
      i = j + 1;
      return v;
    }
    return null;
  };
  const key = () => {
    const parts = [];
    do {
      ws();
      const q = str();
      if (q !== null) parts.push(q);
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
        if (!m) throw new Error(`key at ${i}`);
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
    } while (s[i] === '.' && ++i);
    return parts;
  };
  const value = () => {
    ws();
    const q = str();
    if (q !== null) return q;
    if (s[i] === '[' || s[i] === '{') {
      const arr = s[i++] === '[';
      const out = arr ? [] : {};
      for (;;) {
        ws();
        if (s[i] === (arr ? ']' : '}')) return (i++, out);
        if (arr) out.push(value());
        else {
          const k = key();
          if (s[i++] !== '=') throw new Error('inline table');
          setPath(out, k, value());
        }
        ws();
        if (s[i] === ',') i++;
        else if (s[i] !== (arr ? ']' : '}')) throw new Error('array or inline table');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(s.slice(i));
    if (!m) throw new Error(`value at ${i}`);
    i += m[0].length;
    return { raw: m[0] };
  };
  const out = {};
  for (;;) {
    ws();
    if (i >= s.length) return out;
    const k = key();
    if (s[i++] !== '=') throw new Error(`"=" expected after ${k.join('.')}`);
    setPath(out, k, value());
  }
}
function setPath(obj, keys, v) {
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' && !o[k].raw ? o[k] : (o[k] = {});
  o[keys[keys.length - 1]] = v;
}

// Where [mcp_servers.<name>] and its sub-tables sit, and what they hold (null when it cannot be read).
function tomlFind(text, name) {
  const t = tomlTables(text);
  const ours = (x) => x && x.key[0] === 'mcp_servers' && x.key[1] === name;
  const first = t.findIndex(ours);
  if (first < 0) return { start: -1 };
  let last = first;
  while (ours(t[last + 1])) last++;
  const end = last + 1 < t.length ? t[last + 1].start : text.length;
  let value = {};
  try {
    for (let k = first; k <= last; k++) {
      const body = tomlBody(text.slice(t[k].body, k + 1 < t.length ? t[k + 1].start : text.length));
      if (t[k].key.length === 2) Object.assign(value, body);
      else setPath(value, t[k].key.slice(2), body);
    }
  } catch {
    value = null;
  }
  const plain = (v) => (v && v.raw !== undefined ? v.raw : v);
  if (value && value.env) value.env = Object.fromEntries(Object.entries(value.env).map(([k, v]) => [k, plain(v)]));
  return { start: t[first].start, end, value, scattered: t.slice(last + 1).some(ours) };
}

const tq = (s) => JSON.stringify(String(s)); // a JSON string is a valid TOML basic string
const tk = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tq(k));
```

with

```js
// is cut out, replaced or appended, and every other byte stays as it was.

const tq = (s) => JSON.stringify(String(s)); // a JSON string is a valid TOML basic string
const tk = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tq(k));
```

- [ ] **Step 4: The scan**

Create `lib/governance/mcp-scan.js`:

```js
// Governance inventory (AI Governance 3): the MCP servers configured in the AI clients' own files (spec I3), for every
// client scripts/register-mcp.js knows (the table is shared through lib/mcp-clients.js). Pure: the files come through
// `read`, the folders from `home`, `env` and `platform`. Per server only its name, the transport, the command's base
// name and the first package-looking argument, or the URL's origin: never env values, headers, other arguments or
// tokens. Project folders (Claude Code's per-project servers) come back as ~ paths, for the dashboard only.
const { clients, isOurs, toml } = require('../mcp-clients');

const MAX_NAME = 120;
const MAX_SERVERS = 500; // per client file
// An npm or PyPI name as it is typed after `npx -y` or `uvx`: lowercase, an optional @scope/, an optional @version.
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,100}(@[a-z0-9.^~*<>=-]{1,40})?$/;
// A token typed as a bare argument: a known key prefix, or a long run of letters and digits without a separator.
const TOKEN = /^(sk|pk|rk|ghp|gho|ghs|ghu|ghr|glpat|xox[abpr]|hf|npm|github_pat)[-_]|^(?=.*\d)[a-z0-9]{24,}$/;
// Transports that mean an HTTP server when an entry names no URL field this reader knows.
const HTTP_TYPES = /^(https?|sse|streamable-?http)$/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Copies JSON text, letting `step(s, i)` replace what starts at i ({ text, next }) or keep it (null). Strings are
// copied whole and never looked into, so a "//" or ",}" inside one stays.
function walkJson(s, step) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
      continue;
    }
    const r = step(s, i);
    if (r) {
      out += r.text;
      i = r.next - 1;
    } else out += s[i];
  }
  return out;
}

const CLOSES = /\s*[}\]]/y;
// JSON with comments and trailing commas (VS Code, Zed and Gemini CLI allow both): a comment becomes a space, a comma
// right before } or ] goes. A UTF-8 BOM is dropped; an empty file is {}. Throws on anything else that is not JSON.
function parseJsonc(src) {
  let s = String(src == null ? '' : src);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const bare = walkJson(s, (t, i) => {
    if (t[i] !== '/') return null;
    if (t[i + 1] === '/') {
      const end = t.indexOf('\n', i);
      return { text: ' ', next: end < 0 ? t.length : end };
    }
    if (t[i + 1] === '*') {
      const end = t.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('a comment is not closed');
      return { text: ' ', next: end + 2 };
    }
    return null;
  });
  const clean = walkJson(bare, (t, i) => {
    if (t[i] !== ',') return null;
    CLOSES.lastIndex = i + 1;
    return CLOSES.test(t) ? { text: '', next: i + 1 } : null;
  });
  if (!clean.trim()) return {};
  const v = JSON.parse(clean);
  return v === null ? {} : v;
}

// A client's JSON file: plain JSON first (Claude Code's file can be large), JSONC when that fails. An object or an
// error.
function parseConfig(text) {
  const s = String(text).replace(/^\ufeff/, '');
  let v;
  try {
    v = s.trim() ? JSON.parse(s) : {};
  } catch {
    v = parseJsonc(s);
  }
  if (v === null) return {};
  if (!isObj(v)) throw new Error('not a JSON object');
  return v;
}

// The program's base name: "npx" from "npx -y …", "node.exe" from "C:\Program Files\nodejs\node.exe". Anything that
// is not a plain file name (it may hold more than the program) is null.
function commandOf(c) {
  if (typeof c !== 'string' || !c.trim()) return null;
  const s = c.trim();
  const first = s.split(/\s+/)[0];
  const base = (/[\\/]/.test(first) ? s : first).split(/[\\/]/).pop();
  return /^[\w.+-]{1,60}$/.test(base) ? base : null;
}

// The first argument that looks like a package name and not like a token: "@scope/pkg" from npx -y @scope/pkg.
function packageOf(args) {
  for (const a of Array.isArray(args) ? args : []) {
    if (typeof a !== 'string') continue;
    const s = a.trim();
    if (!s || s.startsWith('-')) continue;
    if (PACKAGE.test(s) && !TOKEN.test(s)) return s;
  }
  return null;
}

// A URL's scheme, host and port; a path, a query, a user name or a password never come along.
function originOf(url) {
  try {
    const u = new URL(String(url).trim());
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

// One server entry as the inventory may keep it.
function serverOf(name, raw, project) {
  const v = isObj(raw) ? raw : {};
  const cmd = isObj(v.command) ? v.command : null; // Zed's older form: "command": { "path", "args" }
  const command = typeof v.command === 'string' ? v.command : cmd && typeof cmd.path === 'string' ? cmd.path : null;
  const args = Array.isArray(v.args) ? v.args : cmd && Array.isArray(cmd.args) ? cmd.args : [];
  const url = [v.url, v.serverUrl, v.httpUrl].find((u) => typeof u === 'string' && u.trim());
  const http = !!url || (!command && HTTP_TYPES.test(String(v.type || v.transport || '')));
  return {
    name: String(name).slice(0, MAX_NAME),
    transport: http ? 'http' : 'stdio',
    command: http ? null : commandOf(command),
    package: http ? null : packageOf(args),
    origin: url ? originOf(url) : null,
    ours: !http && isOurs({ command: command || '', args: args.filter((a) => typeof a === 'string') }),
    ...(project ? { project } : {}),
  };
}

// Codex CLI's [mcp_servers.<name>] tables. Servers written as dotted keys or an inline table cannot be read here: the
// file then counts as unreadable rather than leaving them out.
function codexServers(text) {
  const s = String(text).replace(/^\ufeff/, '');
  if (/^[ \t]*mcp_servers[ \t]*[.=]/m.test(s)) throw new Error('mcp_servers as dotted keys or an inline table');
  const names = [];
  for (const t of toml.tables(s))
    if (t.key[0] === 'mcp_servers' && t.key.length >= 2 && !names.includes(t.key[1])) names.push(t.key[1]);
  return names.map((n) => serverOf(n, toml.find(s, n).value));
}

// A folder as the owner's dashboard shows it: the home folder as ~ (Windows: either slash, any case).
function tildeOf(home, platform) {
  const norm = (x) => (platform === 'win32' ? x.replace(/\\/g, '/').toLowerCase() : x);
  const h = home ? norm(String(home)).replace(/\/+$/, '') : '';
  return (p) => {
    const s = String(p);
    if (!h) return s;
    const n = norm(s);
    if (n === h) return '~';
    return n.startsWith(`${h}/`) ? `~${s.slice(h.length)}` : s;
  };
}

function serversIn(c, text, tilde) {
  if (c.kind === 'codex') return codexServers(text);
  const data = parseConfig(text);
  const key = c.key || 'mcpServers';
  const list = [];
  const top = data[key];
  if (top != null && !isObj(top)) throw new Error(`"${key}" is not an object`);
  for (const [n, e] of Object.entries(top || {})) list.push(serverOf(n, e));
  // Claude Code also keeps servers per project folder (local scope) in the same file.
  if (c.kind === 'claude' && isObj(data.projects))
    for (const [folder, p] of Object.entries(data.projects))
      if (isObj(p) && isObj(p.mcpServers))
        for (const [n, e] of Object.entries(p.mcpServers)) list.push(serverOf(n, e, tilde(folder)));
  return list;
}

// Every client whose file is there: { client, name, file (a ~ path), state: 'ok' | 'unreadable', servers }. A file
// that is missing is left out; one that cannot be read or parsed is 'unreadable', with no servers, and the other
// clients are still listed. read(file) returns the text, null when the file does not exist, or throws.
function scanClients({ home, env = {}, platform = process.platform, read } = {}) {
  const tilde = tildeOf(home, platform);
  const out = [];
  for (const [id, c] of Object.entries(clients(home, { env, platform }))) {
    const row = { client: id, name: c.name, file: tilde(c.file) };
    let text;
    try {
      text = read(c.file);
    } catch {
      out.push({ ...row, state: 'unreadable', servers: [] });
      continue;
    }
    if (text == null) continue;
    try {
      out.push({ ...row, state: 'ok', servers: serversIn(c, text, tilde).slice(0, MAX_SERVERS) });
    } catch {
      out.push({ ...row, state: 'unreadable', servers: [] });
    }
  }
  return out;
}

module.exports = { scanClients, parseJsonc, parseConfig, serverOf, commandOf, packageOf, originOf };
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/governance-mcp-scan.test.js test/register.test.js test/sea.test.js`
Expected: PASS (47 tests; `register.test.js` and `sea.test.js` unchanged).

- [ ] **Step 6: Check the style**

Run: `npx prettier@3 --check lib/mcp-clients.js lib/governance/mcp-scan.js scripts/register-mcp.js test/governance-mcp-scan.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 7: Commit**

```bash
git add lib/mcp-clients.js lib/governance/mcp-scan.js scripts/register-mcp.js test/governance-mcp-scan.test.js
git commit -m "Governance inventory: share the AI client table and read the MCP servers in each client's settings"
```

---
### Task 2: the inventory builder and the seen dates

**Files:**
- Create: `lib/governance/inventory.js`, `lib/governance/seen.js`
- Test: `test/governance-inventory.test.js` (create)

**Interfaces:**
- Consumes: `providerOf(name) → 'anthropic' | … | 'other'` and `PROVIDER_LABELS` from `lib/topology.js`; the
  `scanClients` shape (Task 1); `writePrivate(file, text)` and `readJson(file, fallback)` from `lib/cost/files.js`.
- Produces (`lib/governance/inventory.js`): `buildInventory(sources, reviews, seen, now) → { items, counts, failed,
  clients, nextSeen }` (V1–V4, V7, V13 `counts`; `failed` lists the source ids whose value is `null`; `clients` is `[{
  client, name, file, state, servers: n }]`); `storedReview(v) → review | null`; `KINDS`, `STATES`, `RISKS`,
  `DECISIONS`, `SOURCES`, `TEXT_MAX = 200`, `NEW_DAYS = 7`.
- Produces (`lib/governance/seen.js`): `createSeenStore({ file }) → { read() → map, write(map) → boolean }`.

- [ ] **Step 1: Write the failing test**

Create `test/governance-inventory.test.js`:

```js
// Governance inventory (AI Governance 3): the pure builder (lib/governance/inventory.js) and the seen dates store
// (lib/governance/seen.js). The same system from several sources is one item with a stable id; first and last seen
// follow the store; a review whose item is no longer there is "gone"; a failed source is listed and the rest still
// counts; nothing secret (an agent's system prompt, a URL's path or token, a key's secret) reaches an item.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildInventory } = require('../lib/governance/inventory');
const { createSeenStore } = require('../lib/governance/seen');

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 864e5;
const sources = () => ({
  live: {
    apps: [
      { id: 'claude', name: 'Claude Code' },
      { id: 'ollama', name: 'Ollama' },
    ],
    installed: ['claude', 'cursor', 'ollama'],
    names: { claude: 'Claude Code', cursor: 'Cursor', ollama: 'Ollama', antigravity: 'Antigravity / Gemini' },
  },
  summary: {
    tools: [
      { id: 'claude', name: 'Claude Code', lastActive: NOW - DAY },
      { id: 'codex', name: 'Codex', lastActive: NOW - 90 * DAY },
    ],
    toolUse: [{ name: 'Read' }, { name: 'mcp__GitHub__create_issue' }, { name: 'mcp__github__list_prs' }],
    models: [{ model: 'claude-sonnet-4-5' }],
  },
  trace: [
    { id: 'claude', ok: true, count: 4 },
    { id: 'gemini', ok: true, count: 2 },
    { id: 'gateway', ok: true, count: 9 },
    { id: 'kiro', ok: false, count: 0 },
  ],
  gateway: {
    providers: [
      { id: 'openai', preset: 'openai', baseUrl: 'https://api.openai.com/v1/secret-path?key=SECRET-1', enabled: true },
      { id: 'local', preset: 'ollama', baseUrl: '', enabled: false },
    ],
    models: ['openai/gpt-5', '—', 'router/fast'],
    keys: [
      { id: 'key_a1', name: 'ci', lastUsedAt: NOW - 2 * DAY, secret: 'zp_SECRET-2', hash: 'SECRET-3' },
      { id: 'key_b2', name: 'old', revokedAt: NOW - DAY },
      { id: 'key_c3', name: 'spare', expiresAt: NOW + DAY },
    ],
    agents: [
      { id: 'researcher', name: 'Researcher', enabled: true, systemPrompt: 'SECRET-PROMPT-4' },
      { id: 'remote', name: 'Remote', enabled: false, remoteUrl: 'https://a2a.example.com/agents/x?t=SECRET-5' },
    ],
    skills: [
      { name: 'zaafpulse', claude: 'installed', agents: 'missing' },
      { name: 'cost', claude: 'missing', agents: 'missing' },
    ],
    workflows: [{ id: 'incident-triage-rca', name: 'Incident triage to mitigation' }],
    knowledge: [{ id: 'kb_1', name: 'Runbooks' }],
  },
  runtimes: [
    { id: 'ollama', name: 'Ollama', kind: 'server', preset: true, installed: true, running: true },
    { id: 'jan', name: 'Jan', kind: 'server', preset: true, installed: false, running: false },
    { id: 'my-llama', name: 'My llama', kind: 'server', preset: false, installed: false, running: false },
    { id: 'chatgpt', name: 'ChatGPT', kind: 'app', preset: true, installed: true, running: false },
  ],
  integrations: [
    { id: 'dt', type: 'dynatrace', enabled: true, url: 'https://abc.live.dynatrace.com/api?Api-Token=SECRET-6' },
    { id: 'upstream', type: 'mcp', enabled: false, url: 'https://mcp.example.com/mcp' },
  ],
  mcp: [
    {
      client: 'claude',
      name: 'Claude Code',
      file: '~/.claude.json',
      state: 'ok',
      servers: [
        {
          name: 'github',
          transport: 'http',
          command: null,
          package: null,
          origin: 'https://api.github.com',
          ours: false,
        },
        { name: 'zaafpulse', transport: 'stdio', command: 'node', package: null, origin: null, ours: true },
        {
          name: 'db',
          transport: 'stdio',
          command: 'uvx',
          package: 'mcp-server-postgres',
          origin: null,
          ours: false,
          project: '~/code/shop',
        },
      ],
    },
    {
      client: 'cursor',
      name: 'Cursor',
      file: '~/.cursor/mcp.json',
      state: 'ok',
      servers: [{ name: 'db', transport: 'stdio', command: 'uvx', package: 'mcp-server-postgres', origin: null }],
    },
    { client: 'zed', name: 'Zed', file: '~/.config/zed/settings.json', state: 'unreadable', servers: [] },
  ],
});
const byId = (inv) => Object.fromEntries(inv.items.map((i) => [i.id, i]));

test('one item per system: sources merge by id, the best state wins, every source is named in where', () => {
  const inv = buildInventory(sources(), {}, {}, NOW);
  const it = byId(inv);
  assert.deepEqual(
    inv.items.map((i) => i.id),
    [
      'app:antigravity',
      'app:chatgpt',
      'app:claude',
      'app:codex',
      'app:cursor',
      'mcp:db',
      'mcp:github',
      'mcp:zaafpulse',
      'provider:local',
      'provider:openai',
      'model:claude-sonnet-4-5',
      'model:openai/gpt-5',
      'agent:remote',
      'agent:researcher',
      'skill:cost',
      'skill:zaafpulse',
      'workflow:incident-triage-rca',
      'knowledge:kb_1',
      'runtime:my-llama',
      'runtime:ollama',
      'integration:dt',
      'integration:upstream',
      'key:key_a1',
      'key:key_b2',
      'key:key_c3',
    ],
    'by kind, then by name',
  );
  assert.equal(inv.items.length, 25);
  assert.deepEqual(it['app:claude'], {
    id: 'app:claude',
    kind: 'app',
    name: 'Claude Code',
    vendor: 'Anthropic',
    where: ['running', 'installed', 'logs', 'trace'],
    state: 'running',
    firstSeen: '2026-11-03',
    lastSeen: '2026-11-03',
    review: null,
    status: 'unreviewed',
  });
  assert.deepEqual([it['app:codex'].state, it['app:codex'].where], ['idle', ['logs']], 'last active 90 days ago');
  assert.deepEqual([it['app:antigravity'].name, it['app:antigravity'].where], ['Antigravity / Gemini', ['trace']]);
  assert.deepEqual(
    [it['runtime:ollama'].state, it['runtime:ollama'].where],
    ['running', ['running', 'installed', 'runtimes']],
  );
  assert.equal(it['app:chatgpt'].state, 'idle');
  assert.equal(it['runtime:my-llama'].state, 'configured', "the owner's own entry");
  assert.ok(!it['runtime:jan'], 'a preset that is not installed is not here');
  assert.deepEqual(it['mcp:github'].where, ['logs', 'Claude Code config']);
  assert.equal(it['mcp:github'].state, 'used');
  assert.equal(it['mcp:github'].name, 'GitHub', 'the first source names it; the id is lowercased');
  assert.deepEqual(
    [it['mcp:db'].clients, it['mcp:db'].projects, it['mcp:db'].package, it['mcp:db'].where],
    [['Claude Code', 'Cursor'], ['~/code/shop'], 'mcp-server-postgres', ['Claude Code config', 'Cursor config']],
  );
  assert.equal(it['mcp:zaafpulse'].ours, true);
  assert.deepEqual([it['provider:openai'].vendor, it['provider:openai'].origin], ['OpenAI', 'https://api.openai.com']);
  assert.equal(it['provider:local'].state, 'idle');
  assert.deepEqual([it['model:openai/gpt-5'].vendor, it['model:openai/gpt-5'].where], ['OpenAI', ['gateway usage']]);
  assert.equal(it['model:claude-sonnet-4-5'].vendor, 'Anthropic');
  assert.deepEqual(
    ['key:key_a1', 'key:key_b2', 'key:key_c3'].map((id) => it[id].state),
    ['used', 'idle', 'configured'],
  );
  assert.deepEqual([it['agent:remote'].state, it['agent:remote'].origin], ['idle', 'https://a2a.example.com']);
  assert.deepEqual(
    ['skill:zaafpulse', 'skill:cost'].map((id) => [it[id].state, it[id].vendor]),
    [
      ['configured', 'ZAAFPulse'],
      ['idle', 'ZAAFPulse'],
    ],
  );
  assert.deepEqual(
    [it['integration:dt'].vendor, it['integration:dt'].origin, it['integration:upstream'].state],
    ['Dynatrace', 'https://abc.live.dynatrace.com', 'idle'],
  );
  assert.deepEqual(inv.clients, [
    { client: 'claude', name: 'Claude Code', file: '~/.claude.json', state: 'ok', servers: 3 },
    { client: 'cursor', name: 'Cursor', file: '~/.cursor/mcp.json', state: 'ok', servers: 1 },
    { client: 'zed', name: 'Zed', file: '~/.config/zed/settings.json', state: 'unreadable', servers: 0 },
  ]);
  const text = JSON.stringify(inv);
  for (const s of ['SECRET-1', 'SECRET-2', 'SECRET-3', 'SECRET-PROMPT-4', 'SECRET-5', 'SECRET-6', 'secret-path'])
    assert.ok(!text.includes(s), `${s} must not reach an item`);
});

test('first and last seen: kept from the store, today for a new item; a review of a gone item is kept', () => {
  const seen = {
    'app:claude': { first: '2026-09-01', last: '2026-10-30' },
    'mcp:retired': { first: '2026-01-01', last: '2026-02-01' },
    'app:broken': { first: 'yesterday', last: 3 },
  };
  const reviews = {
    'app:claude': { owner: 'Ana', purpose: 'coding', risk: 'limited', decision: 'approved', note: '', reviewedAt: 'x' },
    'mcp:retired': { owner: 'Ana', risk: 'high', decision: 'blocked' },
    'not an id': { owner: 'x' },
  };
  const inv = buildInventory({ live: { apps: [{ id: 'claude', name: 'Claude Code' }] } }, reviews, seen, NOW);
  assert.deepEqual(
    inv.items.map((i) => [i.id, i.state, i.status, i.firstSeen, i.lastSeen]),
    [
      ['app:claude', 'running', 'reviewed', '2026-09-01', '2026-11-03'],
      ['mcp:retired', 'gone', 'gone', '2026-01-01', '2026-02-01'],
    ],
  );
  assert.deepEqual(inv.items[0].review, {
    owner: 'Ana',
    purpose: 'coding',
    risk: 'limited',
    decision: 'approved',
    note: '',
    reviewedAt: 'x',
  });
  assert.deepEqual(inv.nextSeen, {
    'app:claude': { first: '2026-09-01', last: '2026-11-03' },
    'mcp:retired': { first: '2026-01-01', last: '2026-02-01' },
  });
  assert.deepEqual(
    [inv.counts.total, inv.counts.reviewed, inv.counts.unreviewed, inv.counts.gone],
    [1, 1, 0, 1],
    'a gone item is not counted as present',
  );
});

test('counts: new unreviewed items (first seen in the last 7 days, not ours) by kind only; risk and decisions', () => {
  const seen = {
    'app:claude': { first: '2026-10-28', last: '2026-11-02' }, // 6 days ago: still new
    'app:codex': { first: '2026-10-27', last: '2026-11-02' }, // 7 days ago: not new
  };
  const reviews = {
    'provider:openai': { risk: 'high' },
    'provider:x': { risk: 'unacceptable', decision: 'restricted' },
  };
  const s = sources();
  s.gateway.providers.push({ id: 'x', preset: 'custom', enabled: true });
  const inv = buildInventory(s, reviews, seen, NOW);
  assert.equal(inv.counts.total, 26);
  assert.equal(inv.counts.reviewed, 2);
  assert.equal(inv.counts.newUnreviewed, 22, 'all but codex (old), the two reviewed and ours');
  assert.deepEqual(inv.counts.newKinds, [
    'agent',
    'app',
    'integration',
    'key',
    'knowledge',
    'mcp',
    'model',
    'provider',
    'runtime',
    'skill',
    'workflow',
  ]);
  assert.deepEqual(
    [inv.counts.high, inv.counts.unacceptable, inv.counts.riskUndecided, inv.counts.unacceptableNotBlocked],
    [1, 1, 1, 1],
  );
  assert.equal(inv.counts.byKind.mcp, 3);
  assert.equal(inv.counts.byState.running, 2);
});

test('a failed source is listed and the rest still counts; bad shapes never throw', () => {
  const inv = buildInventory({ ...sources(), gateway: null, mcp: null }, {}, {}, NOW);
  assert.deepEqual(inv.failed, ['gateway', 'mcp']);
  assert.ok(inv.items.some((i) => i.id === 'app:claude'));
  assert.ok(!inv.items.some((i) => i.kind === 'key'));
  const odd = buildInventory(
    { live: { apps: 'x', installed: [1, null] }, summary: { tools: [null, { id: 'claude' }] }, trace: {}, gateway: 7 },
    null,
    'x',
    NOW,
  );
  assert.deepEqual([odd.items, odd.failed], [[], []]);
  assert.deepEqual(buildInventory(undefined, undefined, undefined, NOW).counts.total, 0);
});

test('seen store: written atomically and privately only when it changed; unreadable reads as {}', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-seen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'governance', 'seen.json');
  const store = createSeenStore({ file });
  assert.deepEqual(store.read(), {});
  const map = { 'app:claude': { first: '2026-11-03', last: '2026-11-03' } };
  assert.equal(store.write(map), true);
  assert.equal(store.write(map), false, 'unchanged: not written again');
  assert.deepEqual(createSeenStore({ file }).read(), map);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['seen.json'], 'no temp file left');
  fs.writeFileSync(file, '{ torn');
  assert.deepEqual(createSeenStore({ file }).read(), {});
  fs.writeFileSync(file, '[1]');
  assert.deepEqual(createSeenStore({ file }).read(), {});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/governance-inventory.test.js`
Expected: FAIL (`Cannot find module '../lib/governance/inventory'`).

- [ ] **Step 3: The builder**

Create `lib/governance/inventory.js`:

```js
// Governance inventory (AI Governance 3): one item per AI system, built at read time from the sources server.js gathers
// (spec I1, I2). Pure: the sources, the owner's reviews (config.json governance.inventory), the first and last day each
// item was seen and the time come in; the items, their counts and the next seen dates go out. An item's id is
// `<kind>:<name>`, the name being the system's own id where it has one (a key id, a provider id), lowercased.
const { providerOf, PROVIDER_LABELS } = require('../topology');

const KINDS = [
  'app',
  'mcp',
  'provider',
  'model',
  'agent',
  'skill',
  'workflow',
  'knowledge',
  'runtime',
  'integration',
  'key',
];
// The best state wins when several sources name one system.
const STATES = ['running', 'used', 'configured', 'idle'];
const RISKS = ['minimal', 'limited', 'high', 'unacceptable']; // the EU AI Act tiers
const DECISIONS = ['approved', 'restricted', 'blocked'];
const SOURCES = ['live', 'summary', 'trace', 'gateway', 'runtimes', 'integrations', 'mcp'];
const TEXT_MAX = 200;
const NAME_MAX = 120;
const NEW_DAYS = 7; // an item first seen this many days ago or less is new (inventory_unreviewed)
const USED_DAYS = 30; // a tool or a key active this recently counts as used
const DAY_MS = 864e5;
// The apps whose server is a local runtime (as the topology draws them): one item, kind runtime.
const RUNTIME_APPS = new Set(['ollama', 'lmstudio']);
// Trace sources that are an app under another id (Gemini CLI is part of the Antigravity app, lib/processes.js).
const TRACE_APPS = { gemini: 'antigravity' };
const VENDORS = {
  claude: 'Anthropic',
  'claude-desktop': 'Anthropic',
  codex: 'OpenAI',
  chatgpt: 'OpenAI',
  antigravity: 'Google',
  cursor: 'Anysphere',
  kiro: 'Amazon Web Services',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};
const INTEGRATION_VENDORS = { dynatrace: 'Dynatrace', arize: 'Arize', n8n: 'n8n', omniroute: 'OmniRoute' };
const ID = new RegExp(`^(${KINDS.join('|')}):(.{1,${NAME_MAX}})$`);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const idOf = (kind, name) => {
  const n = str(name).trim().toLowerCase().slice(0, NAME_MAX);
  return n ? `${kind}:${n}` : null;
};
const vendorOfModel = (name) => {
  const p = providerOf(str(name));
  return p === 'other' ? null : PROVIDER_LABELS[p];
};
function originOf(url) {
  try {
    const u = new URL(str(url));
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

// A stored review as config.json holds it, read leniently: a field that is not what it should be is left out.
function storedReview(v) {
  if (!isObj(v)) return null;
  const text = (x) => (typeof x === 'string' ? x.slice(0, TEXT_MAX) : '');
  return {
    owner: text(v.owner),
    purpose: text(v.purpose),
    risk: RISKS.includes(v.risk) ? v.risk : '',
    decision: DECISIONS.includes(v.decision) ? v.decision : '',
    note: text(v.note),
    reviewedAt: typeof v.reviewedAt === 'string' ? v.reviewedAt.slice(0, 40) : null,
  };
}

// buildInventory(sources, reviews, seen, now) -> { items, counts, failed, clients, nextSeen }.
// sources (server.js; null for a source that failed, absent for one not read):
//   live: { apps: [{ id, name }], installed: [id], names: { id: name } }
//   summary: { tools: [{ id, name, lastActive }], toolUse: [{ name }], models: [{ model }] }
//   trace: [{ id, ok, count }]
//   gateway: { providers: [{ id, preset, baseUrl, enabled }], models: [name], keys: [{ id, name, revokedAt,
//     expiresAt, lastUsedAt }], agents: [{ id, name, enabled, remoteUrl }], skills: [{ name, claude, agents }],
//     workflows: [{ id, name }], knowledge: [{ id, name }] }
//   runtimes: [{ id, name, kind, preset, installed, running }]
//   integrations: [{ id, type, flavor, enabled, url }]
//   mcp: lib/governance/mcp-scan.js scanClients()
// reviews: { id: review }; seen: { id: { first, last } } (days, UTC).
function buildInventory(sources, reviews, seen, now) {
  const src = isObj(sources) ? sources : {};
  const map = new Map();
  const failed = SOURCES.filter((s) => Object.hasOwn(src, s) && src[s] === null);
  const today = dayOf(now);

  function add(kind, key, { name, vendor = null, where, state, ...extra }) {
    const id = idOf(kind, key);
    if (!id) return;
    let it = map.get(id);
    if (!it) {
      it = { id, kind, name: str(name || key).slice(0, NAME_MAX), vendor: null, where: [], state };
      map.set(id, it);
    }
    if (!it.vendor && vendor) it.vendor = vendor;
    if (where && !it.where.includes(where)) it.where.push(where);
    if (STATES.indexOf(state) < STATES.indexOf(it.state)) it.state = state;
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined || v === false) continue;
      if (Array.isArray(v)) it[k] = [...new Set([...(it[k] || []), ...v])];
      else if (it[k] === undefined || it[k] === null || it[k] === false) it[k] = v;
    }
  }
  const appKind = (id) => (RUNTIME_APPS.has(id) ? 'runtime' : 'app');
  const app = (id, name, where, state) =>
    add(appKind(id), id, { name: name || id, vendor: VENDORS[id] || null, where, state });
  const recent = (t) => Number.isFinite(t) && now - t <= USED_DAYS * DAY_MS;

  // Running and installed apps (lib/processes.js snapshot).
  const live = isObj(src.live) ? src.live : null;
  if (live) {
    const names = isObj(live.names) ? live.names : {};
    for (const a of arr(live.apps)) app(str(a.id), str(a.name) || names[a.id], 'running', 'running');
    for (const id of Array.isArray(live.installed) ? live.installed : [])
      if (typeof id === 'string') app(id, names[id], 'installed', 'idle');
  }
  // The indexed logs: Claude Code and Codex, the MCP servers their tools came from, and the models they used.
  const sum = isObj(src.summary) ? src.summary : null;
  if (sum) {
    for (const t of arr(sum.tools))
      if (Number.isFinite(t.lastActive)) app(str(t.id), str(t.name), 'logs', recent(t.lastActive) ? 'used' : 'idle');
    for (const u of arr(sum.toolUse)) {
      const m = /^mcp__(.+?)__/.exec(str(u.name));
      if (m) add('mcp', m[1], { name: m[1], where: 'logs', state: 'used' });
    }
    for (const m of arr(sum.models))
      add('model', m.model, { name: str(m.model), vendor: vendorOfModel(m.model), where: 'logs', state: 'used' });
  }
  // The trace explorer's sources with sessions (the gateway's own requests are not an app).
  const names = live && isObj(live.names) ? live.names : {};
  for (const s of arr(src.trace)) {
    const id = TRACE_APPS[s.id] || str(s.id);
    if (!s.ok || !(s.count > 0) || id === 'gateway' || !id) continue;
    app(id, names[id], 'trace', 'used');
  }
  // The gateway: providers, the models it served, keys, agents, skills, workflows and knowledge bases.
  const gw = isObj(src.gateway) ? src.gateway : null;
  if (gw) {
    for (const p of arr(gw.providers)) {
      const v = providerOf(str(p.preset || p.id));
      add('provider', p.id, {
        name: str(p.id),
        vendor: v === 'other' ? null : PROVIDER_LABELS[v],
        where: 'gateway',
        state: p.enabled === false ? 'idle' : 'configured',
        origin: originOf(p.baseUrl),
      });
    }
    // A route (router/<name>) is not a model but a choice among them; the providers it routes to are items already.
    for (const m of Array.isArray(gw.models) ? gw.models : [])
      if (typeof m === 'string' && m !== '—' && !m.startsWith('router/'))
        add('model', m, { name: m, vendor: vendorOfModel(m), where: 'gateway usage', state: 'used' });
    for (const k of arr(gw.keys)) {
      const off = !!k.revokedAt || (Number.isFinite(k.expiresAt) && k.expiresAt <= now);
      const state = off ? 'idle' : recent(k.lastUsedAt) ? 'used' : 'configured';
      add('key', k.id, { name: str(k.name) || str(k.id), where: 'gateway', state });
    }
    for (const a of arr(gw.agents))
      add('agent', a.id, {
        name: str(a.name) || str(a.id),
        where: 'gateway',
        state: a.enabled === false ? 'idle' : 'configured',
        origin: originOf(a.remoteUrl),
      });
    for (const s of arr(gw.skills)) {
      const installed = [s.claude, s.agents].some((x) => x === 'installed' || x === 'outdated');
      add('skill', s.name, {
        name: str(s.name),
        vendor: 'ZAAFPulse',
        where: 'gateway',
        state: installed ? 'configured' : 'idle',
      });
    }
    for (const w of arr(gw.workflows))
      add('workflow', w.id, { name: str(w.name) || str(w.id), where: 'gateway', state: 'configured' });
    for (const k of arr(gw.knowledge))
      add('knowledge', k.id, { name: str(k.name) || str(k.id), where: 'gateway', state: 'configured' });
  }
  // Local runtimes and desktop apps (Settings → Local models, the AI Office cards).
  for (const r of arr(src.runtimes)) {
    const id = str(r.id);
    const own = r.preset !== true;
    if (!r.running && !r.installed && !own) continue; // a preset this machine does not have
    const state = r.running ? 'running' : own ? 'configured' : 'idle';
    if (r.kind === 'app') app(id, str(r.name), 'runtimes', state);
    else add('runtime', id, { name: str(r.name) || id, vendor: VENDORS[id] || null, where: 'runtimes', state });
  }
  // Integrations, upstream MCP servers included.
  for (const i of arr(src.integrations))
    add('integration', i.id, {
      name: str(i.id),
      vendor: INTEGRATION_VENDORS[i.type] || INTEGRATION_VENDORS[i.flavor] || null,
      where: 'integrations',
      state: i.enabled === false ? 'idle' : 'configured',
      type: str(i.type) || null,
      origin: originOf(i.url),
    });
  // MCP servers in the AI clients' own config files.
  const clientRows = [];
  for (const c of arr(src.mcp)) {
    const servers = arr(c.servers);
    clientRows.push({
      client: str(c.client),
      name: str(c.name),
      file: str(c.file),
      state: str(c.state),
      servers: servers.length,
    });
    for (const s of servers)
      add('mcp', s.name, {
        name: str(s.name),
        where: `${str(c.name)} config`,
        state: 'configured',
        transport: s.transport === 'http' || s.transport === 'stdio' ? s.transport : null,
        command: typeof s.command === 'string' ? s.command : null,
        package: typeof s.package === 'string' ? s.package : null,
        origin: typeof s.origin === 'string' ? s.origin : null,
        ours: s.ours === true,
        clients: [str(c.name)],
        projects: typeof s.project === 'string' ? [s.project] : [],
      });
  }

  // Reviews, gone items and the seen dates.
  const rv = isObj(reviews) ? reviews : {};
  const old = isObj(seen) ? seen : {};
  const nextSeen = {};
  for (const [id, d] of Object.entries(old))
    if (isObj(d) && DAY.test(d.first) && DAY.test(d.last)) nextSeen[id] = { first: d.first, last: d.last };
  for (const it of map.values()) nextSeen[it.id] = { first: (nextSeen[it.id] || {}).first || today, last: today };
  for (const id of Object.keys(rv)) {
    const m = ID.exec(id);
    if (!m || map.has(id)) continue;
    map.set(id, { id, kind: m[1], name: m[2], vendor: null, where: [], state: 'gone' });
  }
  const newSince = dayOf(now - (NEW_DAYS - 1) * DAY_MS);
  const items = [...map.values()]
    .map((it) => {
      const review = storedReview(rv[it.id]);
      const d = nextSeen[it.id] || null;
      return {
        ...it,
        firstSeen: d ? d.first : null,
        lastSeen: d ? d.last : null,
        review,
        status: !review ? 'unreviewed' : it.state === 'gone' ? 'gone' : 'reviewed',
      };
    })
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name, 'en'));

  const present = items.filter((i) => i.state !== 'gone');
  const isNew = (i) => !!i.firstSeen && i.firstSeen >= newSince;
  const fresh = present.filter((i) => i.status === 'unreviewed' && !i.ours && isNew(i));
  const risky = (r) => present.filter((i) => i.review && i.review.risk === r);
  const counts = {
    total: present.length,
    byKind: Object.fromEntries(KINDS.map((k) => [k, present.filter((i) => i.kind === k).length])),
    byState: Object.fromEntries(STATES.map((s) => [s, present.filter((i) => i.state === s).length])),
    reviewed: present.filter((i) => i.status === 'reviewed').length,
    unreviewed: present.filter((i) => i.status === 'unreviewed').length,
    gone: items.filter((i) => i.status === 'gone').length,
    newUnreviewed: fresh.length,
    newKinds: [...new Set(fresh.map((i) => i.kind))].sort(),
    high: risky('high').length,
    unacceptable: risky('unacceptable').length,
    riskUndecided: [...risky('high'), ...risky('unacceptable')].filter((i) => !i.review.decision).length,
    unacceptableNotBlocked: risky('unacceptable').filter((i) => i.review.decision !== 'blocked').length,
  };
  return { items, counts, failed, clients: clientRows, nextSeen };
}

module.exports = {
  buildInventory,
  storedReview,
  KINDS,
  STATES,
  RISKS,
  DECISIONS,
  SOURCES,
  TEXT_MAX,
  NEW_DAYS,
};
```

- [ ] **Step 4: The seen store**

Create `lib/governance/seen.js`:

```js
// Governance inventory (AI Governance 3): the first and last day each inventory item was seen (spec I2), in
// .data/governance/seen.json as { id: { first, last } } and nothing else. A file that is missing or unreadable reads as
// {}, so the dates start again from today and the page never fails on it. A write is atomic and synced (private file,
// temp file of its own, rename), and only happens when the map changed.
const { writePrivate, readJson } = require('../cost/files');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function createSeenStore({ file }) {
  let last = null; // the map as last read or written, as text
  return {
    read() {
      const v = readJson(file, {});
      const map = isObj(v) ? v : {};
      last = JSON.stringify(map);
      return map;
    },
    // Returns true when the file was written.
    write(map) {
      const text = JSON.stringify(isObj(map) ? map : {});
      if (text === last) return false;
      writePrivate(file, text);
      last = text;
      return true;
    },
  };
}

module.exports = { createSeenStore };
```

- [ ] **Step 5: Run it and see it pass**

Run: `node --test test/governance-inventory.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Check the style**

Run: `npx prettier@3 --check lib/governance/inventory.js lib/governance/seen.js test/governance-inventory.test.js`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 7: Commit**

```bash
git add lib/governance/inventory.js lib/governance/seen.js test/governance-inventory.test.js
git commit -m "Governance inventory: one item per AI system from every source, with first and last seen"
```

---
### Task 3: reviews and `GET|POST /api/governance/inventory`

**Files:**
- Modify: `lib/governance/inventory.js` (lines 82, 318)
- Modify: `lib/governance/api.js` (lines 6, 18, 75, 98, 169, 181, 194, 225)
- Modify: `lib/governance/diff.js` (line 20)
- Modify: `server.js` (lines 81, 292, 1077)
- Test: `test/governance-inventory-api.test.js` (create), `test/governance-inventory-http.test.js` (create)

**Interfaces:**
- Consumes: `buildInventory` (Task 2), `createSeenStore` (Task 2), `scanClients`, `originOf` (Task 1); in `server.js`
  the existing `topoSource(fn, empty)`, `getSummary(range)`, `processes`, `trace.sources()`, `gateway.usage`,
  `gateway.keys`, `gateway.agents`, `gateway.skills`, `gateway.workflows`, `gateway.knowledge`, `runtimeApi.route`,
  `rawConfig()`, `saveConfigSection`, `demo`.
- Produces (`lib/governance/inventory.js`): `cleanReview(input) → { errors: string[], id, value: review | null }`
  (V8).
- Produces (`lib/governance/api.js`): `createGovernanceApi({ audit, settings, sources = async () => ({}), seen = { read,
  write }, now = Date.now, log })` → adds `inventory() → Promise<{ generatedAt, items, counts, failed, clients }>`;
  routes `GET` and `POST /api/governance/inventory` (V8, V13). Unknown paths 404, wrong methods 405, as before.
- Produces (`server.js`): `inventorySources() → Promise<sources>` (V6), `readClientFile(file) → text | null`,
  `invSource(fn) → value | null`.

- [ ] **Step 1: Write the failing tests**

Create `test/governance-inventory-api.test.js`:

```js
// Governance inventory (AI Governance 3): the router's inventory routes (lib/governance/api.js) with stand-in sources,
// settings and seen store: GET builds the items with their reviews and saves the seen dates; POST checks a review
// field by field (400 naming it, nothing written), saves it into governance.inventory beside the other settings, and
// clears it; the sources are read at most every 5 s. Also the audit diff of a review of a key item stays readable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGovernanceApi } = require('../lib/governance/api');
const { cleanReview } = require('../lib/governance/inventory');
const { diff } = require('../lib/governance/diff');

const NOW = Date.UTC(2026, 10, 3, 12);
function setup({ governance = { audit: { retentionMonths: 24 } }, seenWrite } = {}) {
  const st = { governance, saved: [], reads: 0, seen: {}, writes: 0, t: NOW, logs: [] };
  const api = createGovernanceApi({
    audit: { status: () => ({}), verify: () => ({}), list: () => ({}), export: () => ({}) },
    settings: { get: () => st.governance, save: (g) => st.saved.push((st.governance = g)) },
    sources: async () => {
      st.reads++;
      return {
        live: { apps: [{ id: 'claude', name: 'Claude Code' }], installed: [], names: {} },
        mcp: [
          {
            client: 'claude',
            name: 'Claude Code',
            file: '~/.claude.json',
            state: 'ok',
            servers: [{ name: 'github', transport: 'stdio', command: 'npx', package: '@x/github', origin: null }],
          },
        ],
      };
    },
    seen: {
      read: () => st.seen,
      write: seenWrite || ((m) => ((st.seen = m), st.writes++, true)),
    },
    now: () => st.t,
    log: (m) => st.logs.push(m),
  });
  const call = (p, { method = 'GET', body, contentType = 'application/json' } = {}) =>
    api.route({
      method,
      path: p,
      query: new URLSearchParams(),
      contentType,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
  return { api, call, st };
}

test('GET inventory: the items with their counts, failed sources and clients; the seen dates are saved', async () => {
  const s = setup();
  const r = await s.call('/api/governance/inventory');
  assert.equal(r.status, 200);
  assert.equal(r.body.generatedAt, '2026-11-03T12:00:00.000Z');
  assert.deepEqual(
    r.body.items.map((i) => [i.id, i.state, i.status]),
    [
      ['app:claude', 'running', 'unreviewed'],
      ['mcp:github', 'configured', 'unreviewed'],
    ],
  );
  assert.deepEqual(r.body.failed, []);
  assert.deepEqual(r.body.clients, [
    { client: 'claude', name: 'Claude Code', file: '~/.claude.json', state: 'ok', servers: 1 },
  ]);
  assert.equal(r.body.counts.total, 2);
  assert.deepEqual(s.st.seen, {
    'app:claude': { first: '2026-11-03', last: '2026-11-03' },
    'mcp:github': { first: '2026-11-03', last: '2026-11-03' },
  });
  // The sources are read again only after 5 s; the seen store is asked on every build.
  await s.call('/api/governance/inventory');
  assert.equal(s.st.reads, 1);
  s.st.t += 5000;
  await s.call('/api/governance/inventory');
  assert.equal(s.st.reads, 2);
  assert.equal((await s.call('/api/governance/inventory', { method: 'PUT', body: {} })).status, 405);
});

test('GET inventory: a seen store that cannot be written never fails the page', async () => {
  const s = setup({
    seenWrite: () => {
      throw Object.assign(new Error('EACCES: /secret/path'), { code: 'EACCES' });
    },
  });
  const r = await s.call('/api/governance/inventory');
  assert.equal(r.status, 200);
  assert.deepEqual(s.st.logs, ['governance: the inventory dates could not be saved (EACCES)']);
});

test('POST inventory: a review is saved beside the other settings, shown on the item, and cleared', async () => {
  const s = setup();
  const post = (body) => s.call('/api/governance/inventory', { method: 'POST', body });
  const r = await post({
    id: 'mcp:github',
    owner: ' Ana ',
    purpose: 'Issues',
    risk: 'limited',
    decision: 'approved',
    note: '',
  });
  assert.deepEqual(r, {
    status: 200,
    body: {
      id: 'mcp:github',
      review: {
        owner: 'Ana',
        purpose: 'Issues',
        note: '',
        risk: 'limited',
        decision: 'approved',
        reviewedAt: '2026-11-03T12:00:00.000Z',
      },
    },
  });
  assert.deepEqual(s.st.governance.audit, { retentionMonths: 24 }, 'the retention stays');
  const item = (await s.call('/api/governance/inventory')).body.items.find((i) => i.id === 'mcp:github');
  assert.deepEqual([item.status, item.review.owner], ['reviewed', 'Ana']);
  // A review of an item that is not here (yet, or any more) is kept: it shows as gone.
  assert.equal((await post({ id: 'key:key_ab12', owner: 'Ops' })).status, 200);
  const gone = (await s.call('/api/governance/inventory')).body.items.find((i) => i.id === 'key:key_ab12');
  assert.deepEqual([gone.state, gone.status], ['gone', 'gone']);
  assert.deepEqual(await post({ id: 'key:key_ab12', clear: true }), {
    status: 200,
    body: { id: 'key:key_ab12', review: null },
  });
  assert.deepEqual(Object.keys(s.st.governance.inventory), ['mcp:github']);
});

test('POST inventory: each bad field is a 400 that names it, and nothing is written', async () => {
  const s = setup();
  const post = (body, contentType) => s.call('/api/governance/inventory', { method: 'POST', body, contentType });
  for (const [body, error] of [
    [{ owner: 'Ana' }, 'id: an inventory id (<kind>:<name>)'],
    [{ id: 'robot:x' }, 'id: an inventory id (<kind>:<name>)'],
    [{ id: 'mcp:x', owner: 'x'.repeat(201) }, 'owner: text of at most 200 characters'],
    [{ id: 'mcp:x', purpose: 7 }, 'purpose: text of at most 200 characters'],
    [{ id: 'mcp:x', note: ['a'] }, 'note: text of at most 200 characters'],
    [{ id: 'mcp:x', risk: 'medium' }, 'risk: minimal, limited, high, unacceptable or empty'],
    [{ id: 'mcp:x', decision: 'maybe' }, 'decision: approved, restricted, blocked or empty'],
    [{ id: 'mcp:x', clear: 'yes' }, 'clear: true or left out'],
    [{ id: 'mcp:x', reviewedAt: 'x' }, 'reviewedAt: not a review field'],
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, error);
  }
  assert.equal((await post([1])).body.error, 'body: an object');
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post('x', 'text/plain')).status, 415);
  assert.equal(s.st.saved.length, 0, 'nothing written');
  // At most 2000 reviews; an existing one can still be changed.
  const full = setup({
    governance: { inventory: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`mcp:s${i}`, {}])) },
  });
  const more = await full.call('/api/governance/inventory', { method: 'POST', body: { id: 'mcp:new' } });
  assert.deepEqual([more.status, more.body.error], [400, 'inventory: at most 2000 reviews']);
  const same = await full.call('/api/governance/inventory', { method: 'POST', body: { id: 'mcp:s1', owner: 'Ana' } });
  assert.equal(same.status, 200);
});

test('reviews: 200 characters after trimming; the audit diff of a key item review stays readable', () => {
  assert.deepEqual(cleanReview({ id: 'app:x', owner: `  ${'a'.repeat(200)}  ` }).errors, []);
  assert.deepEqual(diff({}, { governance: { inventory: { 'key:key_ab12': { owner: 'Ops' } } } }).changes, [
    { path: 'governance.inventory.key:key_ab12.owner', from: null, to: 'Ops' },
  ]);
  // Elsewhere a secret-looking name is still masked.
  assert.deepEqual(diff({}, { governance: { apiKey: 'zp_x' } }).changes, [
    { path: 'governance.apiKey', from: null, to: '‹changed›' },
  ]);
});
```

Create `test/governance-inventory-http.test.js`:

```js
// Governance inventory and compliance (AI Governance 3) through a spawned server.js: a temp data folder that is also
// HOME (so the MCP scan reads fixture client files there, never this machine's), no network, no sign-in unless sign-in
// is under test. Ports 10000-10199 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 10000 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

// Starts server.js on a free port of the range (again when another test took the port first); stopped and its data
// folder removed when the test ends. Every folder an AI client's config may be read from points into the data folder.
// prepare(data) runs on the empty data folder before the server starts.
async function startServer(t, env = {}, prepare = null) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-inv-'));
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
// One request: JSON in and out (text when the answer is not JSON).
async function call(s, p, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(s.base + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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
// Every governance audit entry the server wrote, oldest first.
function entries(s) {
  const dir = path.join(s.data, '.data', 'audit');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^governance-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
const SECRETS = ['ghp_SECRET1abcdefghijklmnopqrstu', 'SECRET-HEADER-2', 'SECRET-QUERY-3', 'SECRET-ENV-4'];
// A Claude Code file with a user-scope server (a token in its env), a remote server (a header and a query token) and a
// project server; a gateway provider and an integration in config.json.
function prepare(data) {
  fs.writeFileSync(
    path.join(data, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_SECRET1abcdefghijklmnopqrstu' },
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/mcp?token=SECRET-QUERY-3',
          headers: { Authorization: 'Bearer SECRET-HEADER-2' },
        },
      },
      projects: { [path.join(data, 'code', 'shop')]: { mcpServers: { db: { command: 'uvx', args: ['pg-mcp'] } } } },
    }),
  );
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      gateway: {
        providers: [{ id: 'openai', preset: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: { env: 'X_KEY' } }],
      },
      integrations: {
        dt: { type: 'dynatrace', url: 'https://abc.live.dynatrace.com', apiToken: { env: 'SECRET-ENV-4' } },
      },
    }),
  );
}

test('inventory: the MCP servers of the client files, the gateway and the integrations, with no secret', async (t) => {
  const s = await startServer(t, {}, prepare);
  const r = await call(s, '/api/governance/inventory');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.items.map((i) => [i.id, i]));
  assert.deepEqual(
    [by['mcp:github'].where, by['mcp:github'].command, by['mcp:github'].package, by['mcp:github'].state],
    [['Claude Code config'], 'npx', '@modelcontextprotocol/server-github', 'configured'],
  );
  assert.deepEqual([by['mcp:remote'].transport, by['mcp:remote'].origin], ['http', 'https://mcp.example.com']);
  assert.deepEqual(by['mcp:db'].projects, [`~${path.sep}code${path.sep}shop`]);
  assert.equal(by['provider:openai'].vendor, 'OpenAI');
  assert.equal(by['integration:dt'].origin, 'https://abc.live.dynatrace.com');
  assert.ok(
    r.body.items.some((i) => i.kind === 'agent'),
    'the gateway agents',
  );
  assert.ok(
    r.body.items.some((i) => i.kind === 'skill'),
    'the ZAAFPulse skills',
  );
  assert.ok(r.body.clients.some((c) => c.client === 'claude' && c.state === 'ok' && c.file === '~/.claude.json'));
  assert.deepEqual(r.body.failed, []);
  for (const x of SECRETS) assert.ok(!r.text.includes(x), `${x} must not leave the server`);
  assert.ok(!r.text.includes('systemPrompt'), 'an agent is read for its id, name and state only');
  const seen = JSON.parse(fs.readFileSync(path.join(s.data, '.data', 'governance', 'seen.json'), 'utf8'));
  assert.match(seen['mcp:github'].first, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(entries(s), [], 'a read writes no audit entry');
  assert.ok(s.alive());
});

test('reviews: saved in config.json, recorded as config.change and as the request; a bad one is a 400', async (t) => {
  const s = await startServer(t, {}, prepare);
  const review = { id: 'mcp:github', owner: 'Ana', purpose: 'Issues', risk: 'limited', decision: 'approved' };
  const ok = await call(s, '/api/governance/inventory', { method: 'POST', body: review });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.review.owner, 'Ana');
  const cfg = JSON.parse(fs.readFileSync(path.join(s.data, 'config.json'), 'utf8'));
  assert.equal(cfg.governance.inventory['mcp:github'].decision, 'approved');
  assert.equal(cfg.gateway.providers[0].id, 'openai', 'the other sections stay');
  const item = (await call(s, '/api/governance/inventory')).body.items.find((i) => i.id === 'mcp:github');
  assert.equal(item.status, 'reviewed');
  const all = entries(s);
  const change = all.find((e) => e.action === 'config.change');
  assert.deepEqual(change.target, { type: 'config', id: 'governance' });
  assert.ok(change.changes.some((c) => c.path === 'governance.inventory.mcp:github.owner' && c.to === 'Ana'));
  const req = all.find((e) => e.action === 'POST /api/governance/inventory');
  assert.deepEqual([req.outcome, req.status, req.target], ['ok', 200, { type: 'governance', id: 'mcp:github' }]);
  const bad = await call(s, '/api/governance/inventory', { method: 'POST', body: { id: 'mcp:github', risk: 'huge' } });
  assert.deepEqual([bad.status, bad.body.error], [400, 'risk: minimal, limited, high, unacceptable or empty']);
  assert.equal(entries(s).filter((e) => e.action === 'config.change').length, 1, 'nothing written');
  assert.ok(s.alive());
});

test('inventory: for a dashboard session only; no sign-in or an API key is a 401', async (t) => {
  const s = await startServer(t, { ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: 'correct horse battery' });
  for (const headers of [{}, { authorization: 'Bearer zp_not_a_session' }]) {
    assert.equal((await call(s, '/api/governance/inventory', { headers })).status, 401);
    const post = { method: 'POST', body: { id: 'mcp:x', owner: 'x' }, headers };
    assert.equal((await call(s, '/api/governance/inventory', post)).status, 401);
  }
  const ok = await call(s, '/api/login', { method: 'POST', body: { password: 'correct horse battery' } });
  const cookie = ok.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  assert.equal((await call(s, '/api/governance/inventory', { headers: { cookie } })).status, 200);
  assert.ok(s.alive());
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/governance-inventory-api.test.js test/governance-inventory-http.test.js`
Expected: FAIL (8 of 8: there is no inventory route yet (404), and `cleanReview` is not exported).

- [ ] **Step 3: Review validation**

In `lib/governance/inventory.js`, replace

```js
}

// buildInventory(sources, reviews, seen, now) -> { items, counts, failed, clients, nextSeen }.
// sources (server.js; null for a source that failed, absent for one not read):
```

with

```js
}

// A review from the dashboard: { id, owner, purpose, risk, decision, note } or { id, clear: true }. Returns
// { errors: [message naming the field], id, value } (value null to clear). Text is trimmed.
function cleanReview(input) {
  if (!isObj(input)) return { errors: ['body: an object'], id: null, value: null };
  const errors = [];
  const allowed = ['id', 'owner', 'purpose', 'risk', 'decision', 'note', 'clear'];
  for (const k of Object.keys(input)) if (!allowed.includes(k)) errors.push(`${k}: not a review field`);
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!ID.test(id)) errors.push('id: an inventory id (<kind>:<name>)');
  if (input.clear !== undefined && input.clear !== true) errors.push('clear: true or left out');
  const value = {};
  const given = (k) => (input[k] === undefined || input[k] === null ? '' : input[k]);
  const text = (k) => {
    const v = given(k);
    if (typeof v !== 'string' || v.trim().length > TEXT_MAX)
      errors.push(`${k}: text of at most ${TEXT_MAX} characters`);
    else value[k] = v.trim();
  };
  const oneOf = (k, list) => {
    const v = given(k);
    if (v !== '' && !list.includes(v)) errors.push(`${k}: ${list.join(', ')} or empty`);
    else value[k] = v;
  };
  text('owner');
  text('purpose');
  oneOf('risk', RISKS);
  oneOf('decision', DECISIONS);
  text('note');
  return { errors, id, value: input.clear === true ? null : value };
}

// buildInventory(sources, reviews, seen, now) -> { items, counts, failed, clients, nextSeen }.
// sources (server.js; null for a source that failed, absent for one not read):
```

In `lib/governance/inventory.js`, replace

```js
module.exports = {
  buildInventory,
  storedReview,
  KINDS,
```

with

```js
module.exports = {
  buildInventory,
  cleanReview,
  storedReview,
  KINDS,
```

- [ ] **Step 4: The router: build the inventory, save a review**

In `lib/governance/api.js`, replace

```js
//   GET  /api/governance/audit/status                                    retention, months, size, degraded, verify
//   POST /api/governance/settings   { audit: { retentionMonths } }       400 on a bad value, nothing written
// It also holds the daily pass (dailyPass), which reads the retention set here.
const { cleanRetention, RETENTION } = require('./audit');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
```

with

```js
//   GET  /api/governance/audit/status                                    retention, months, size, degraded, verify
//   POST /api/governance/settings   { audit: { retentionMonths } }       400 on a bad value, nothing written
//   GET  /api/governance/inventory                                       the AI inventory (AI Governance 3)
//   POST /api/governance/inventory  { id, owner, purpose, risk, decision, note } | { id, clear: true }
// It also holds the daily pass (dailyPass), which reads the retention set here, and builds the inventory from the
// sources server.js gathers (the reviews are config.json "governance.inventory", the seen dates a store of their own).
const { cleanRetention, RETENTION } = require('./audit');
const { buildInventory, cleanReview } = require('./inventory');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
```

In `lib/governance/api.js`, replace

```js
const KEY_ID = /^key_[A-Za-z0-9_-]{1,40}$/;
const OUTCOMES = new Set(['ok', 'refused', 'error']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
```

with

```js
const KEY_ID = /^key_[A-Za-z0-9_-]{1,40}$/;
const OUTCOMES = new Set(['ok', 'refused', 'error']);
const MAX_REVIEWS = 2000;
const SOURCES_TTL_MS = 5000; // the sources are read again at most this often; the reviews on every build

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
```

In `lib/governance/api.js`, replace

```js
// settings: { get() -> config.json "governance" (or undefined), save(value) } (server.js saveConfigSection).
// log(message): where the daily pass reports a step that failed.
function createGovernanceApi({ audit, settings, log = console.error }) {
  const retention = () => {
    const g = settings.get();
    return cleanRetention(isObj(g) && isObj(g.audit) ? g.audit.retentionMonths : undefined);
  };
  function saveSettings(body) {
    const n = isObj(body) && isObj(body.audit) ? body.audit.retentionMonths : undefined;
```

with

```js
// settings: { get() -> config.json "governance" (or undefined), save(value) } (server.js saveConfigSection).
// log(message): where the daily pass reports a step that failed.
// sources(): a Promise of the inventory sources (lib/governance/inventory.js buildInventory); seen: { read(),
// write(map) } (lib/governance/seen.js).
function createGovernanceApi({
  audit,
  settings,
  sources = async () => ({}),
  seen = { read: () => ({}), write: () => false },
  now = Date.now,
  log = console.error,
}) {
  const governance = () => {
    const g = settings.get();
    return isObj(g) ? g : {};
  };
  const retention = () => {
    const g = governance();
    return cleanRetention(isObj(g.audit) ? g.audit.retentionMonths : undefined);
  };
  const reviews = () => (isObj(governance().inventory) ? governance().inventory : {});
  function saveSettings(body) {
    const n = isObj(body) && isObj(body.audit) ? body.audit.retentionMonths : undefined;
```

In `lib/governance/api.js`, replace

```js
    if (!Number.isInteger(n) || n < RETENTION.min || n > RETENTION.max)
      return reply(400, { error: `audit.retentionMonths: a whole number from ${RETENTION.min} to ${RETENTION.max}` });
    const g = settings.get();
    const cur = isObj(g) ? g : {};
    settings.save({ ...cur, audit: { ...(isObj(cur.audit) ? cur.audit : {}), retentionMonths: n } });
    return reply(200, { audit: { retentionMonths: n } });
  }
  function exportOf(q) {
    const format = q.get('format') || 'csv';
```

with

```js
    if (!Number.isInteger(n) || n < RETENTION.min || n > RETENTION.max)
      return reply(400, { error: `audit.retentionMonths: a whole number from ${RETENTION.min} to ${RETENTION.max}` });
    const cur = governance();
    settings.save({ ...cur, audit: { ...(isObj(cur.audit) ? cur.audit : {}), retentionMonths: n } });
    return reply(200, { audit: { retentionMonths: n } });
  }

  // The inventory: the sources at most every 5 s (one read at a time), the reviews and the seen dates on every build.
  // The seen dates are saved when they changed; a store that cannot be written never fails the page.
  let cache = { at: 0, value: null, pending: null };
  function readSources() {
    if (cache.value && now() - cache.at < SOURCES_TTL_MS) return Promise.resolve(cache.value);
    if (!cache.pending)
      cache.pending = Promise.resolve()
        .then(sources)
        .then((v) => ((cache = { at: now(), value: v, pending: null }), v))
        .finally(() => (cache.pending = null));
    return cache.pending;
  }
  async function inventory() {
    const src = await readSources();
    const t = now();
    let dates = {};
    try {
      dates = seen.read();
    } catch {
      dates = {};
    }
    const inv = buildInventory(src, reviews(), dates, t);
    try {
      seen.write(inv.nextSeen);
    } catch (e) {
      log(`governance: the inventory dates could not be saved (${(e && (e.code || e.name)) || 'error'})`);
    }
    return {
      generatedAt: new Date(t).toISOString(),
      items: inv.items,
      counts: inv.counts,
      failed: inv.failed,
      clients: inv.clients,
    };
  }
  // A review saved into config.json governance.inventory (every save is a config.change entry), or cleared.
  function saveReview(body) {
    const r = cleanReview(body);
    if (r.errors.length) return reply(400, { error: r.errors[0], errors: r.errors });
    const cur = governance();
    const list = { ...reviews() };
    if (r.value === null) delete list[r.id];
    else {
      if (!Object.hasOwn(list, r.id) && Object.keys(list).length >= MAX_REVIEWS)
        return reply(400, { error: `inventory: at most ${MAX_REVIEWS} reviews` });
      list[r.id] = { ...r.value, reviewedAt: new Date(now()).toISOString() };
    }
    settings.save({ ...cur, inventory: list });
    return reply(200, { id: r.id, review: list[r.id] || null });
  }
  function exportOf(q) {
    const format = q.get('format') || 'csv';
```

In `lib/governance/api.js`, replace

```js
    '/api/governance/audit/verify': () => reply(200, audit.verify()),
    '/api/governance/audit/status': () => reply(200, { retentionMonths: retention(), ...audit.status() }),
  };
```

with

```js
    '/api/governance/audit/verify': () => reply(200, audit.verify()),
    '/api/governance/audit/status': () => reply(200, { retentionMonths: retention(), ...audit.status() }),
    '/api/governance/inventory': async () => reply(200, await inventory()),
  };
  const POST = {
    '/api/governance/settings': saveSettings,
    '/api/governance/inventory': saveReview,
  };
```

In `lib/governance/api.js`, replace

```js
    const p = req.path;
    if (p !== '/api/governance' && !p.startsWith('/api/governance/')) return null;
    const isPost = p === '/api/governance/settings';
    if (!isPost && !Object.hasOwn(GET, p)) return reply(404, { error: 'unknown route' });
    if (req.method !== (isPost ? 'POST' : 'GET')) return reply(405, { error: 'method not allowed' });
    try {
      if (!isPost) return GET[p](req.query);
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
```

with

```js
    const p = req.path;
    if (p !== '/api/governance' && !p.startsWith('/api/governance/')) return null;
    if (!Object.hasOwn(GET, p) && !Object.hasOwn(POST, p)) return reply(404, { error: 'unknown route' });
    const isPost = req.method === 'POST' && Object.hasOwn(POST, p);
    if (!isPost && !(req.method === 'GET' && Object.hasOwn(GET, p))) return reply(405, { error: 'method not allowed' });
    try {
      if (!isPost) return await GET[p](req.query);
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
```

In `lib/governance/api.js`, replace

```js
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      return saveSettings(body);
    } catch (e) {
      const st = e && e.status;
```

with

```js
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      return POST[p](body);
    } catch (e) {
      const st = e && e.status;
```

In `lib/governance/api.js`, replace

```js
  }

  return { route, retention, dailyPass };
}
```

with

```js
  }

  return { route, retention, dailyPass, inventory };
}
```

- [ ] **Step 5: Review ids are not secret names in the audit diff (V9)**

In `lib/governance/diff.js`, replace

```js
// Names that only look secret: a guardrails mode (any path ending in guardrails.secrets, as gateway.guardrails.secrets
// or a key's own guardrails.secrets: it only ever holds a mode word), and the cost centers' map of gateway key ids at
// cost.keyCenters (the map and its entries, whose names are key ids). The same names anywhere else are secret.
const NOT_SECRET = new Set(['cost.keyCenters']);
const join = (path, k) => (path ? `${path}.${k}` : k);
const guardMode = (k, path) => k === 'secrets' && (path === 'guardrails' || path.endsWith('.guardrails'));
const secretName = (k, path) =>
  SECRET_WORD.test(k) && !guardMode(k, path) && !NOT_SECRET.has(join(path, k)) && path !== 'cost.keyCenters';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
```

with

```js
// Names that only look secret: a guardrails mode (any path ending in guardrails.secrets, as gateway.guardrails.secrets
// or a key's own guardrails.secrets: it only ever holds a mode word), and the cost centers' map of gateway key ids at
// cost.keyCenters (the map and its entries, whose names are key ids). The same names anywhere else are secret. The AI
// inventory's reviews at governance.inventory are a map by item id too (key:key_ab12, mcp:github-token): an id names
// no secret, and a review's own fields (owner, purpose, risk, decision, note) are not secret-looking.
const NOT_SECRET = new Set(['cost.keyCenters']);
const ID_MAPS = new Set(['cost.keyCenters', 'governance.inventory']);
const join = (path, k) => (path ? `${path}.${k}` : k);
const guardMode = (k, path) => k === 'secrets' && (path === 'guardrails' || path.endsWith('.guardrails'));
const secretName = (k, path) =>
  SECRET_WORD.test(k) && !guardMode(k, path) && !NOT_SECRET.has(join(path, k)) && !ID_MAPS.has(path);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
```

- [ ] **Step 6: `server.js`: the sources and the seen store**

In `server.js`, replace

```js
const { diff: govDiff } = require('./lib/governance/diff');
const { createGovernanceApi } = require('./lib/governance/api');

const PORT = Number(process.env.ZAAFPULSE_PORT || process.env.PORT) || 4777;
```

with

```js
const { diff: govDiff } = require('./lib/governance/diff');
const { createGovernanceApi } = require('./lib/governance/api');
const mcpScan = require('./lib/governance/mcp-scan');
const { createSeenStore } = require('./lib/governance/seen');

const PORT = Number(process.env.ZAAFPULSE_PORT || process.env.PORT) || 4777;
```

In `server.js`, replace

```js
  }
}
// /api/governance/*: the entries, an export, verify, status, and the retention in config.json "governance.audit".
const governanceApi = createGovernanceApi({
  audit: governance,
  settings: { get: () => rawConfig().governance, save: (g) => saveConfigSection('governance', g) },
});
let rawCache = {
```

with

```js
  }
}
// /api/governance/*: the entries, an export, verify, status, and the retention in config.json "governance.audit"; the
// AI inventory (AI Governance 3) from inventorySources() below, its reviews in "governance.inventory" and the days each
// item was first and last seen in .data/governance/seen.json (demo: the throwaway folder).
const governanceApi = createGovernanceApi({
  audit: governance,
  settings: { get: () => rawConfig().governance, save: (g) => saveConfigSection('governance', g) },
  sources: () => inventorySources(),
  seen: createSeenStore({ file: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'governance', 'seen.json') }),
});
let rawCache = {
```

In `server.js`, replace

```js
  return topoCache.pending;
}
const insightMemo = new Map();
function getInsights(range) {
```

with

```js
  return topoCache.pending;
}
// The AI inventory's sources (lib/governance/inventory.js buildInventory): each one capped at 2 s, and null when it
// failed (the page names it). Only what an item shows is read: gateway agents by id, name, state and remote address,
// never a system prompt; keys by id, name and dates, never a secret. The MCP scan reads the AI clients' own config
// files (lib/governance/mcp-scan.js); demo mode never reads them.
const INV_FAILED = Symbol('failed');
const invSource = async (fn) => {
  const v = await topoSource(fn, INV_FAILED);
  return v === INV_FAILED ? null : v;
};
// An AI client's config file: its text, or null when it is not there.
function readClientFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}
async function inventorySources() {
  const pick = (list, fields) =>
    (Array.isArray(list) ? list : []).map((x) => Object.fromEntries(fields.map((k) => [k, x && x[k]])));
  const [live, summary, traced, gw, runtimes, integrations, mcp] = await Promise.all([
    invSource(async () => {
      const s = DEMO ? demo.live() : await processes.snapshot();
      return {
        apps: pick(s.apps, ['id', 'name']),
        installed: s.installed,
        names: Object.fromEntries(processes.APPS.map((a) => [a.id, a.name])),
      };
    }),
    invSource(() => {
      const s = getSummary(30);
      return {
        tools: pick(s.tools, ['id', 'name', 'lastActive']),
        toolUse: pick(s.toolUse, ['name']),
        models: pick(s.models, ['model']),
      };
    }),
    invSource(() => trace.sources()),
    invSource(() => {
      const g = (rawConfig() || {}).gateway || {};
      return {
        providers: pick(g.providers, ['id', 'preset', 'baseUrl', 'enabled']),
        models: Object.keys(gateway.usage.summary().byModel || {}),
        keys: pick(gateway.keys.list(), ['id', 'name', 'revokedAt', 'expiresAt', 'lastUsedAt']),
        agents: pick(gateway.agents.list(), ['id', 'name', 'enabled', 'remoteUrl']),
        skills: pick(gateway.skills.list(), ['name', 'claude', 'agents']),
        workflows: pick(gateway.workflows.list(), ['id', 'name']),
        knowledge: pick(gateway.knowledge.list(), ['id', 'name']),
      };
    }),
    invSource(async () => (await runtimeApi.route({ method: 'GET', path: '/api/runtimes' })).body),
    invSource(() =>
      DEMO
        ? demo.integrations().integrations.filter((i) => i.type !== 'acc')
        : Object.entries((rawConfig() || {}).integrations || {}).map(([id, c]) => ({
            id,
            type: c && c.type,
            flavor: c && c.flavor,
            enabled: !(c && c.enabled === false),
            url: c && (c.url || c.baseUrl),
          })),
    ),
    invSource(() =>
      DEMO
        ? []
        : mcpScan.scanClients({
            home: os.homedir(),
            env: process.env,
            platform: process.platform,
            read: readClientFile,
          }),
    ),
  ]);
  return { live, summary, trace: traced, gateway: gw, runtimes, integrations, mcp };
}
const insightMemo = new Map();
function getInsights(range) {
```

- [ ] **Step 7: Run the tests and see them pass**

Run: `node --test test/governance-inventory-api.test.js test/governance-inventory-http.test.js test/governance-api.test.js test/governance-chain.test.js test/governance-config.test.js test/governance-http.test.js`
Expected: PASS (42 tests).

- [ ] **Step 8: Check the style**

Run: `npx prettier@3 --check lib/governance/inventory.js lib/governance/api.js lib/governance/diff.js test/governance-inventory-api.test.js test/governance-inventory-http.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath server.js < server.js | diff server.js - | grep -c '^[<>]'`
Expected: `7`

- [ ] **Step 9: Commit**

```bash
git add lib/governance/inventory.js lib/governance/api.js lib/governance/diff.js server.js test/governance-inventory-api.test.js test/governance-inventory-http.test.js
git commit -m "Governance inventory: the inventory route, and reviews saved in config.json"
```

---
### Task 4: the Monitors rule `inventory_unreviewed`

**Files:**
- Modify: `lib/monitors/rules.js` (lines 146, 169, 359)
- Modify: `lib/monitors/index.js` (lines 81, 152, 252, 335)
- Modify: `public/monitorsview.js` (line 100)
- Modify: `lib/governance/api.js` (lines 104, 127, 228)
- Modify: `server.js` (lines 783, 1917)
- Modify: `test/monitors-rules.test.js` (lines 39, 81), `test/budgets-monitors.test.js` (lines 39, 456, 461),
  `test/monitors-api.test.js` (line 197)
- Test: `test/governance-inventory-monitor.test.js` (create)

**Interfaces:**
- Consumes: `inventory()` and the counts of `buildInventory` (Tasks 2–3); the existing `RULES`, `CHECKS`, `single`,
  `result`, `isNonNeg` of `lib/monitors/rules.js`; the `part(name, fn)` pattern of `buildAggregate`.
- Produces (`lib/governance/api.js`): `inventoryStatus() → { newUnreviewed, newKinds } | null` (null before the first
  build).
- Produces (`lib/monitors/index.js`): `createMonitors({ …, inventoryStatus })` → `snap.inventory`.
- Produces (`lib/monitors/rules.js`): the rule `inventory_unreviewed` (V10).

- [ ] **Step 1: Write the failing test, and add the rule to the existing rule lists**

Create `test/governance-inventory-monitor.test.js`:

```js
// Governance inventory (AI Governance 3): the Monitors rule inventory_unreviewed (lib/monitors/rules.js), its input in
// the engine (lib/monitors/index.js) from the inventory's last counts (lib/governance/api.js inventoryStatus), and its
// words on the Monitors page. The alert carries a count and kinds only, never a name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RULES, evaluate } = require('../lib/monitors/rules');
const { createMonitors } = require('../lib/monitors');
const { createMonitorState } = require('../lib/monitors/state');
const { createGovernanceApi } = require('../lib/governance/api');

const NOW = Date.UTC(2026, 10, 3, 12);
const rule = RULES.find((r) => r.id === 'inventory_unreviewed');
const run = (snap) => evaluate(rule, {}, snap, NOW);

test('the rule: aggregate, on by default, never pausing, no parameters', () => {
  assert.deepEqual(
    [rule.title, rule.kind, rule.params, rule.defaultOn({}), rule.mayAutoPause],
    ['Unreviewed AI system', 'aggregate', {}, true, false],
  );
  assert.equal(rule.describe, 'An AI system first seen in the last 7 days has no review in Governance → Inventory.');
});

test('inventory_unreviewed: triggered by new unreviewed items, titled with their kinds only', () => {
  assert.deepEqual(run({ inventory: { newUnreviewed: 3, newKinds: ['mcp', 'app', 'github-token', 'mcp'] } }), [
    { instance: 'all', sessionId: null, state: 'triggered', value: 3, threshold: 1, title: 'app, mcp' },
  ]);
  assert.deepEqual(run({ inventory: { newUnreviewed: 0, newKinds: [] } }), [
    { instance: 'all', sessionId: null, state: 'ok', value: 0, threshold: 1 },
  ]);
  assert.equal(run({}).at(0).state, 'no_data');
  assert.equal(run({ inventory: { newUnreviewed: -1 } }).at(0).state, 'no_data');
  assert.equal(run({ inventory: { newUnreviewed: 2, newKinds: 'mcp' } }).at(0).title, undefined, 'no kinds: no title');
});

test('the Monitors page words', () => {
  const { monMeasure } = require('../public/monitorsview');
  assert.equal(monMeasure('inventory_unreviewed', 1, 1), '1 new AI system not reviewed');
  assert.equal(monMeasure('inventory_unreviewed', 4, 1), '4 new AI systems not reviewed');
});

test('engine: the counts of the last inventory build are read on each aggregate pass and alert once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-inv-mon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: NOW };
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => clock.t,
  });
  const sent = [];
  let servers = [{ name: 'github-token-server', transport: 'stdio', command: 'npx', package: 'x', origin: null }];
  const api = createGovernanceApi({
    audit: {},
    settings: { get: () => ({}), save: () => {} },
    sources: async () => ({
      mcp: [{ client: 'cursor', name: 'Cursor', file: '~/.cursor/mcp.json', state: 'ok', servers }],
    }),
    now: () => clock.t,
  });
  assert.equal(api.inventoryStatus(), null, 'nothing built yet');
  const monitors = createMonitors({
    indexer: { results: () => [] },
    office: { snapshot: () => ({ agents: [] }), demoSnapshot: () => ({ agents: [] }) },
    evals: { summary: () => ({ evaluators: {} }) },
    config: () => ({}),
    state,
    channels: { notify: async (alert) => sent.push(alert) },
    now: () => clock.t,
    inventoryStatus: () => api.inventoryStatus(),
  });
  await api.inventory();
  assert.deepEqual(api.inventoryStatus(), { newUnreviewed: 1, newKinds: ['mcp'] });
  await monitors.tickAggregate();
  const alerts = sent.filter((a) => a.rule === 'inventory_unreviewed');
  assert.deepEqual(
    alerts.map((a) => [a.state, a.value, a.title]),
    [['triggered', 1, 'mcp']],
  );
  assert.ok(!JSON.stringify(sent).includes('github-token-server'), 'no name in an alert');
  servers = [];
  clock.t += 6e3;
  await api.inventory();
  clock.t += 60e3;
  await monitors.tickAggregate();
  assert.equal(sent.filter((a) => a.rule === 'inventory_unreviewed').length, 1, 'no second alert');
  assert.equal(state.states().find((s) => s.rule === 'inventory_unreviewed').state, 'ok');
});
```

In `test/monitors-rules.test.js`, replace

```js
      'audit_degraded',
      'audit_chain_broken',
    ],
  );
```

with

```js
      'audit_degraded',
      'audit_chain_broken',
      'inventory_unreviewed',
    ],
  );
```

In `test/monitors-rules.test.js`, replace

```js
    audit_degraded: true,
    audit_chain_broken: true,
  });
  assert.strictEqual(on('cost_burn', { monthlyBudgetUSD: 500 }), false);
```

with

```js
    audit_degraded: true,
    audit_chain_broken: true,
    inventory_unreviewed: true,
  });
  assert.strictEqual(on('cost_burn', { monthlyBudgetUSD: 500 }), false);
```

In `test/budgets-monitors.test.js`, replace

```js
const brief = (a) => [a.state, a.previous, a.projected];

test('the budget rule sits beside the twelve fixed rules', () => {
  assert.equal(RULES.length, 12);
  assert.equal(
    RULES.some((r) => r.id === 'budget'),
```

with

```js
const brief = (a) => [a.state, a.previous, a.projected];

test('the budget rule sits beside the thirteen fixed rules', () => {
  assert.equal(RULES.length, 13);
  assert.equal(
    RULES.some((r) => r.id === 'budget'),
```

In `test/budgets-monitors.test.js`, replace

```js
    'audit_degraded',
    'audit_chain_broken',
  ]);
  const r = await call('/api/monitors/daily_cost', { method: 'POST', body: { enabled: true } });
```

with

```js
    'audit_degraded',
    'audit_chain_broken',
    'inventory_unreviewed',
  ]);
  const r = await call('/api/monitors/daily_cost', { method: 'POST', body: { enabled: true } });
```

In `test/budgets-monitors.test.js`, replace

```js
  assert.equal(r.status, 410);
  assert.match(r.body.error, /replaced by budgets/);
  assert.equal((await api().call('/api/monitors')).body.rules.length, 12, 'without the option nothing changes');
});
```

with

```js
  assert.equal(r.status, 410);
  assert.match(r.body.error, /replaced by budgets/);
  assert.equal((await api().call('/api/monitors')).body.rules.length, 13, 'without the option nothing changes');
});
```

In `test/monitors-api.test.js`, replace

```js
  const r = await s.call('/api/monitors');
  assert.equal(r.status, 200);
  assert.equal(r.body.rules.length, 12);
  const keys = 'id title describe kind enabled params defaults autoPause mayAutoPause state snoozedUntil instances';
  for (const rule of r.body.rules) assert.deepEqual(Object.keys(rule).sort(), keys.split(' ').sort());
```

with

```js
  const r = await s.call('/api/monitors');
  assert.equal(r.status, 200);
  assert.equal(r.body.rules.length, 13);
  const keys = 'id title describe kind enabled params defaults autoPause mayAutoPause state snoozedUntil instances';
  for (const rule of r.body.rules) assert.deepEqual(Object.keys(rule).sort(), keys.split(' ').sort());
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/governance-inventory-monitor.test.js test/monitors-rules.test.js test/budgets-monitors.test.js test/monitors-api.test.js`
Expected: FAIL (9 of 68: the four new tests, and the five rule-list assertions that now expect `inventory_unreviewed`).

- [ ] **Step 3: The rule**

In `lib/monitors/rules.js`, replace

```js
    mayAutoPause: false,
  },
];
// Why a verify of the audit chain failed (lib/governance/chain.js, audit.js): the only words an alert's title takes.
```

with

```js
    mayAutoPause: false,
  },
  {
    id: 'inventory_unreviewed',
    title: 'Unreviewed AI system',
    describe: 'An AI system first seen in the last 7 days has no review in Governance → Inventory.',
    kind: 'aggregate',
    params: {},
    defaultOn: () => true,
    mayAutoPause: false,
  },
];
// Why a verify of the audit chain failed (lib/governance/chain.js, audit.js): the only words an alert's title takes.
```

In `lib/monitors/rules.js`, replace

```js
const GUARD_WINDOW_MIN = 60;
const GUARD_CHECKS = new Set(['secrets', 'pii', 'injection']);

// Cost budgets (lib/cost/budgets.js) are instances of this rule, one per budget id, evaluated after each ledger pass
```

with

```js
const GUARD_WINDOW_MIN = 60;
const GUARD_CHECKS = new Set(['secrets', 'pii', 'injection']);
// The AI inventory's kinds (lib/governance/inventory.js KINDS): the only words inventory_unreviewed's title takes.
const INVENTORY_KINDS = new Set([
  'app',
  'mcp',
  'provider',
  'model',
  'agent',
  'skill',
  'workflow',
  'knowledge',
  'runtime',
  'integration',
  'key',
]);

// Cost budgets (lib/cost/budgets.js) are instances of this rule, one per budget id, evaluated after each ledger pass
```

In `lib/monitors/rules.js`, replace

```js
  },

  // One instance per day, named by its date: yesterday, checked whole, and today, so far (lib/cost/anomaly.js
  // recentDays). A day keeps its instance from its partial check to its whole one, so it alerts once. The value is
```

with

```js
  },

  // The AI inventory (lib/governance/inventory.js counts): items first seen in the last 7 days that nobody reviewed,
  // ZAAFPulse's own MCP entry left out. The value is how many, the title their kinds (mcp, provider …), never a name.
  inventory_unreviewed(p, snap) {
    const v = snap.inventory;
    if (!v || typeof v !== 'object' || !isNonNeg(v.newUnreviewed)) return single('no_data', null, 1);
    if (v.newUnreviewed === 0) return single('ok', 0, 1);
    const kinds = [...new Set((Array.isArray(v.newKinds) ? v.newKinds : []).filter((k) => INVENTORY_KINDS.has(k)))];
    return [result('all', null, 'triggered', v.newUnreviewed, 1, kinds.sort().join(', '))];
  },

  // One instance per day, named by its date: yesterday, checked whole, and today, so far (lib/cost/anomaly.js
  // recentDays). A day keeps its instance from its partial check to its whole one, so it alerts once. The value is
```

- [ ] **Step 4: Its input in the engine, and its words on the Monitors page**

In `lib/monitors/index.js`, replace

```js
  // lastVerify, … }; or null (both rules are then no_data).
  auditStatus = null,
} = {}) {
  const safeLog = (message) => {
```

with

```js
  // lastVerify, … }; or null (both rules are then no_data).
  auditStatus = null,
  // The inventory_unreviewed rule's input (the AI inventory's last counts, lib/governance/api.js inventoryStatus):
  // (t) -> { newUnreviewed, newKinds }; or null (the rule is then no_data).
  inventoryStatus = null,
} = {}) {
  const safeLog = (message) => {
```

In `lib/monitors/index.js`, replace

```js
      guardBlocks: null, // [{ ts, checks }] for guardrail_block: times and check names only
      audit: null, // { degraded, lastVerify } for audit_degraded and audit_chain_broken: no entry content
    };
    // Each part on its own: one that fails is missing (no_data for its rules), the others still count.
```

with

```js
      guardBlocks: null, // [{ ts, checks }] for guardrail_block: times and check names only
      audit: null, // { degraded, lastVerify } for audit_degraded and audit_chain_broken: no entry content
      inventory: null, // { newUnreviewed, newKinds } for inventory_unreviewed: a count and kinds, no name
    };
    // Each part on its own: one that fails is missing (no_data for its rules), the others still count.
```

In `lib/monitors/index.js`, replace

```js
      out.audit = s ? { degraded: s.degraded || null, lastVerify: s.lastVerify || null } : null;
    });
    part('the recent usage', () => {
      // Rows older than 10 minutes now are older than 10 minutes at every later live pass too, so this is all the
```

with

```js
      out.audit = s ? { degraded: s.degraded || null, lastVerify: s.lastVerify || null } : null;
    });
    part('the AI inventory', () => {
      if (typeof inventoryStatus !== 'function') return;
      const s = inventoryStatus(t);
      out.inventory = s ? { newUnreviewed: s.newUnreviewed, newKinds: s.newKinds } : null;
    });
    part('the recent usage', () => {
      // Rows older than 10 minutes now are older than 10 minutes at every later live pass too, so this is all the
```

In `lib/monitors/index.js`, replace

```js
      guardBlocks: agg && agg.guardBlocks,
      audit: agg && agg.audit,
      sessions: live ? live.sessions : undefined,
    };
```

with

```js
      guardBlocks: agg && agg.guardBlocks,
      audit: agg && agg.audit,
      inventory: agg && agg.inventory,
      sessions: live ? live.sessions : undefined,
    };
```

In `public/monitorsview.js`, replace

```js
  // audit_chain_broken titled "rekeyed": an intact chain whose key was replaced (lib/monitors/rules.js).
  audit_rekeyed: [(v) => `key replaced at entry ${monRound(v)}`, null, null],
};
function monMeasure(rule, value, threshold, title) {
```

with

```js
  // audit_chain_broken titled "rekeyed": an intact chain whose key was replaced (lib/monitors/rules.js).
  audit_rekeyed: [(v) => `key replaced at entry ${monRound(v)}`, null, null],
  inventory_unreviewed: [(v) => `${monPlural(v, 'new AI system')} not reviewed`, null, null],
};
function monMeasure(rule, value, threshold, title) {
```

- [ ] **Step 5: The last counts in the router, and the wiring**

In `lib/governance/api.js`, replace

```js

  // The inventory: the sources at most every 5 s (one read at a time), the reviews and the seen dates on every build.
  // The seen dates are saved when they changed; a store that cannot be written never fails the page.
  let cache = { at: 0, value: null, pending: null };
  function readSources() {
    if (cache.value && now() - cache.at < SOURCES_TTL_MS) return Promise.resolve(cache.value);
```

with

```js

  // The inventory: the sources at most every 5 s (one read at a time), the reviews and the seen dates on every build.
  // The seen dates are saved when they changed; a store that cannot be written never fails the page. The last counts
  // are kept for the Monitors rule inventory_unreviewed.
  let cache = { at: 0, value: null, pending: null };
  let lastCounts = null;
  function readSources() {
    if (cache.value && now() - cache.at < SOURCES_TTL_MS) return Promise.resolve(cache.value);
```

In `lib/governance/api.js`, replace

```js
    }
    const inv = buildInventory(src, reviews(), dates, t);
    try {
      seen.write(inv.nextSeen);
```

with

```js
    }
    const inv = buildInventory(src, reviews(), dates, t);
    lastCounts = inv.counts;
    try {
      seen.write(inv.nextSeen);
```

In `lib/governance/api.js`, replace

```js
  }

  return { route, retention, dailyPass, inventory };
}
```

with

```js
  }

  // The Monitors rule inventory_unreviewed: the counts of the last build (no names), or null before the first.
  const inventoryStatus = () =>
    lastCounts ? { newUnreviewed: lastCounts.newUnreviewed, newKinds: lastCounts.newKinds } : null;

  return { route, retention, dailyPass, inventory, inventoryStatus };
}
```

In `server.js`, replace

```js
  // audit_degraded and audit_chain_broken: the governance audit log's state and its last verify (no entry content).
  auditStatus: () => governance.status(),
});
// The routes: rules, channels, alerts and agent control. Demo serves a seeded store of its own (mixed states, five
```

with

```js
  // audit_degraded and audit_chain_broken: the governance audit log's state and its last verify (no entry content).
  auditStatus: () => governance.status(),
  // inventory_unreviewed: the AI inventory's last counts (new unreviewed items and their kinds; no names).
  inventoryStatus: () => governanceApi.inventoryStatus(),
});
// The routes: rules, channels, alerts and agent control. Demo serves a seeded store of its own (mixed states, five
```

In `server.js`, replace

```js
  auditDaily();
  setInterval(auditDaily, 24 * 3600 * 1000).unref();
  // Local model servers: remember what is loaded. Not in demo mode, server mode or Docker (control is off there), and
  // not with ZAAFPULSE_RUNTIME_WATCH=off (the tests' spawned servers, which must not read this machine's Ollama).
```

with

```js
  auditDaily();
  setInterval(auditDaily, 24 * 3600 * 1000).unref();
  // The AI inventory, now and every 10 minutes, so inventory_unreviewed sees new systems without the page open (a
  // read of the page builds it too). The pass is the system's; a failure is logged and the next one tries again.
  const inventoryPass = () =>
    govContext.runAs({ via: 'system' }, () =>
      governanceApi.inventory().catch(() => console.error('governance: the inventory pass failed')),
    );
  inventoryPass();
  setInterval(inventoryPass, 10 * 60 * 1000).unref();
  // Local model servers: remember what is loaded. Not in demo mode, server mode or Docker (control is off there), and
  // not with ZAAFPULSE_RUNTIME_WATCH=off (the tests' spawned servers, which must not read this machine's Ollama).
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/governance-inventory-monitor.test.js test/monitors-rules.test.js test/budgets-monitors.test.js test/monitors-api.test.js test/governance-monitor.test.js test/monitors-ui.test.js test/monitors-engine.test.js test/governance-inventory-http.test.js`
Expected: PASS (138 tests).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check lib/monitors/rules.js lib/monitors/index.js public/monitorsview.js lib/governance/api.js test/governance-inventory-monitor.test.js test/monitors-rules.test.js test/budgets-monitors.test.js test/monitors-api.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath server.js < server.js | diff server.js - | grep -c '^[<>]'`
Expected: `7`

- [ ] **Step 8: Commit**

```bash
git add lib/monitors/rules.js lib/monitors/index.js public/monitorsview.js lib/governance/api.js server.js test/governance-inventory-monitor.test.js test/monitors-rules.test.js test/budgets-monitors.test.js test/monitors-api.test.js
git commit -m "Governance inventory: the inventory_unreviewed rule alerts on new AI systems nobody reviewed"
```

---
### Task 5: the controls and `GET /api/governance/controls`

**Files:**
- Create: `lib/governance/controls.js`
- Modify: `lib/governance/api.js` (lines 8, 13, 78, 85, 145, 195, 255)
- Modify: `server.js` (lines 83, 301, 422, 432, 1163)
- Modify: `test/governance-inventory-http.test.js` (line 202)
- Test: `test/governance-controls.test.js` (create)

**Interfaces:**
- Consumes: `inventory()` (Task 3) and `audit.status()`, `retention()` in the router; in `server.js` `cleanPolicy` from
  `lib/gateway/guardrails.js`, `RULES` from `lib/monitors/rules.js`, `RETIRED_RULES`, `monitorApiState.settings(id)`,
  `gateway.providers.tierOf(p)`, `gateway.keys.list()`, `gateway.workflows.list()`, `gateway.usage.summary()`,
  `agentControl.off()`, `evalApi.settings()`, `evalEngine.status()`, `datasets.list()`, `experiments.list()`,
  `costBudgets.list()`, `defaultStore()` of `lib/secret-store.js`, `auth.mode`, `SERVER_MODE`, `TLS`, `contentOff`,
  `otel.status()`, `tracingOn()`, `traceStore`, `originOf` (Task 1), `invSource` (Task 3).
- Produces (`lib/governance/controls.js`): `controls(state) → [{ id, title, status, evidence: string[], link,
  clauses: [{ id, framework, ref, title }] }]` (V11); `CATALOGUE`, `CLAUSES`, `FRAMEWORKS`, `NOTICE`, `STATUSES`,
  `KEY_RULES`, `SIX_MONTHS_DAYS = 183`.
- Produces (`lib/governance/api.js`): `createGovernanceApi({ …, controlState = async () => ({}) })` → `controls() →
  Promise<{ generatedAt, notice, frameworks, clauses, controls }>`; route `GET /api/governance/controls`.
- Produces (`server.js`): `controlState() → Promise<state without now, audit and inventory>`; `TRACE_RETENTION = {
  days, maxBytes }` (the retention the trace store was opened with).

- [ ] **Step 1: Write the failing tests**

Create `test/governance-controls.test.js`:

```js
// Governance compliance (AI Governance 3): the control catalogue (lib/governance/controls.js) worked out from fixture
// states, every control in place, partial and off; the clause mapping complete; the wording (framework versions, "not a
// certification", never "compliant"); and GET /api/governance/controls with the audit log's state and the inventory's
// counts added by the router.
const test = require('node:test');
const assert = require('node:assert/strict');
const { controls, CATALOGUE, CLAUSES, FRAMEWORKS, NOTICE, STATUSES } = require('../lib/governance/controls');
const { createGovernanceApi } = require('../lib/governance/api');

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 864e5;
// A state where every control is in place.
const good = () => ({
  now: NOW,
  guardrails: { scope: 'external', secrets: 'redact', pii: 'log', injection: 'block' },
  audit: {
    retentionMonths: 12,
    degraded: null,
    lastVerify: { ok: true, checked: 40, from: 1, to: 40, at: '2026-11-03T02:00:00.000Z' },
  },
  usage: { requests: 120 },
  providers: [
    { id: 'openai', tier: 'external', approved: true, recorded: true },
    { id: 'local', tier: 'private', approved: true, recorded: false },
  ],
  keys: [
    { budgetUSD: 20, expiresAt: null, scopes: ['llm'] },
    { budgetUSD: null, expiresAt: NOW + 30 * DAY, scopes: ['llm', 'agents', 'mcp', 'rag'] },
    { revokedAt: NOW - DAY, budgetUSD: null, expiresAt: null, scopes: ['llm'] },
  ],
  workflows: [
    { tier: 'R2', gated: true },
    { tier: 'R0', gated: false },
  ],
  agentControl: { off: null },
  monitors: [
    { id: 'guardrail_block', enabled: true },
    { id: 'audit_chain_broken', enabled: true },
    { id: 'inventory_unreviewed', enabled: true },
    { id: 'cost_burn', enabled: false },
  ],
  evals: { judge: true, evaluators: 3, total: 5, ok: true, model: 'llama3', today: 12 },
  datasets: { count: 2, experiments: [{ status: 'done', endedAt: NOW - 10 * DAY }] },
  budgets: [{ enforce: 'block' }, { enforce: 'none' }],
  secretStore: { id: 'keychain', label: 'macOS Keychain' },
  signIn: { mode: 'local', serverMode: false, tls: false },
  content: { otelCapture: false, traceContentOff: false },
  otel: { enabled: true, error: false, origin: 'https://otel.example.com', protocol: 'http/protobuf' },
  traces: { store: true, enabled: true, retentionDays: 190, maxBytes: 500 * 1048576 },
  inventory: { total: 4, reviewed: 4, high: 1, unacceptable: 0, riskUndecided: 0, unacceptableNotBlocked: 0 },
});
const statusOf = (state) => Object.fromEntries(controls(state).map((c) => [c.id, c.status]));
const one = (state, id) => controls(state).find((c) => c.id === id);

test('the catalogue: seventeen controls in a fixed order, each with a link and at least one clause', () => {
  assert.deepEqual(
    CATALOGUE.map((c) => c.id),
    [
      'guardrails',
      'audit_log',
      'usage_log',
      'provider_approval',
      'api_keys',
      'approval_gates',
      'agent_control',
      'monitors',
      'evals',
      'experiments',
      'cost_budgets',
      'secret_store',
      'sign_in',
      'content_capture',
      'otel_export',
      'trace_retention',
      'inventory_coverage',
    ],
  );
  const ids = new Set(CLAUSES.map((c) => c.id));
  assert.equal(ids.size, CLAUSES.length, 'clause ids are unique');
  for (const c of CATALOGUE) {
    assert.ok(c.clauses.length >= 1, c.id);
    for (const id of c.clauses) assert.ok(ids.has(id), `${c.id}: ${id}`);
    assert.match(c.link, /^#[a-z0-9/-]+$/, c.id);
  }
  const used = new Set(CATALOGUE.flatMap((c) => c.clauses));
  assert.deepEqual(
    CLAUSES.filter((c) => !used.has(c.id)).map((c) => c.id),
    [],
    'every clause is shown by a control',
  );
  assert.deepEqual(
    FRAMEWORKS.map((f) => [f.id, CLAUSES.filter((c) => c.framework === f.id).length > 0]),
    [
      ['eu-ai-act', true],
      ['nist-ai-rmf', true],
      ['iso-42001', true],
    ],
  );
  assert.deepEqual(
    CLAUSES.filter((c) => c.framework === 'eu-ai-act').map((c) => c.ref),
    ['Art. 12', 'Art. 14', 'Art. 26', 'Art. 50'],
  );
  assert.deepEqual(
    CLAUSES.filter((c) => c.framework === 'iso-42001').map((c) => c.ref),
    ['A.2', 'A.5', 'A.6', 'A.7', 'A.8', 'A.9', 'A.10'],
  );
  for (const c of CLAUSES.filter((x) => x.framework === 'nist-ai-rmf'))
    assert.match(c.ref, /^(GOVERN 1|MAP 1|MEASURE 2|MANAGE 2|MANAGE 4)\.\d+$/);
});

test('wording: the framework versions, "not a certification", and never "compliant"', () => {
  assert.deepEqual(
    FRAMEWORKS.map((f) => f.version),
    ['Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744', 'NIST AI RMF 1.0', 'ISO/IEC 42001:2023'],
  );
  assert.match(NOTICE, /^Evidence for your assessment, not a certification\./);
  const all = JSON.stringify({ CATALOGUE, CLAUSES, FRAMEWORKS, NOTICE, out: [controls(good()), controls({})] });
  assert.doesNotMatch(all, /complian/i);
  assert.deepEqual(STATUSES, ['in place', 'partial', 'off']);
});

test('every control is in place for a good state, with its evidence', () => {
  const out = controls(good());
  assert.deepEqual(new Set(out.map((c) => c.status)), new Set(['in place']));
  const ev = Object.fromEntries(out.map((c) => [c.id, c.evidence]));
  assert.deepEqual(ev.guardrails, [
    'secrets: redact',
    'personal data: log',
    'prompt injection: block',
    'scope: external',
  ]);
  assert.deepEqual(ev.audit_log, [
    'kept 12 months (at least 6)',
    'last verify (2026-11-03): chain intact, 40 entries checked',
  ]);
  assert.deepEqual(ev.usage_log, ['120 gateway requests recorded this month']);
  assert.deepEqual(ev.provider_approval, ['1 external provider', '1 approved', '0 waiting for approval']);
  assert.deepEqual(ev.api_keys, ['2 active keys', '1 with a budget', '1 with an expiry', '1 limited to some scopes']);
  assert.deepEqual(ev.approval_gates, [
    'workflows that send, change or decide: 1 of 1 wait for a person',
    'workflows with an approval step: 1 of 2',
  ]);
  assert.deepEqual(ev.monitors, ['3 of 4 rules on', 'guardrail_block, audit_chain_broken, inventory_unreviewed on']);
  assert.deepEqual(ev.evals, [
    'code evaluators run on every session',
    'judge model: llama3',
    '3 of 5 judge evaluators on',
    '12 judged today',
  ]);
  assert.deepEqual(ev.experiments, ['2 datasets', '1 finished experiment', 'last finished 2026-10-24']);
  assert.deepEqual(ev.otel_export, ['to https://otel.example.com over http/protobuf']);
  assert.deepEqual(ev.trace_retention, ['kept 190 days, up to 500 MB']);
  assert.deepEqual(ev.inventory_coverage, [
    '4 of 4 items reviewed (100%)',
    '1 high risk, 0 unacceptable',
    '0 high or unacceptable without a decision',
    '0 unacceptable not blocked',
  ]);
  const c = one(good(), 'audit_log');
  assert.deepEqual([c.title, c.link], ['Governance audit log', '#governance/audit']);
  assert.deepEqual(
    c.clauses.map((x) => `${x.framework} ${x.ref}`),
    ['eu-ai-act Art. 12', 'eu-ai-act Art. 26', 'nist-ai-rmf GOVERN 1.4', 'nist-ai-rmf MANAGE 4.1', 'iso-42001 A.6'],
  );
});

test('partial: a check, a key, a gate or a rule missing; an old approval; a short retention; part reviewed', () => {
  const s = good();
  s.guardrails.pii = 'off';
  s.audit.lastVerify = null;
  s.providers.push({ id: 'old', tier: 'external', approved: true, recorded: false });
  s.keys.push({ budgetUSD: null, expiresAt: null, scopes: ['llm'] });
  s.workflows.push({ tier: 'R3', gated: false });
  s.monitors[2].enabled = false;
  s.evals.ok = false;
  s.datasets.experiments = [{ status: 'done', endedAt: NOW - 200 * DAY }];
  s.budgets = [{ enforce: 'none' }];
  s.secretStore = { id: 'file', label: 'encrypted secret file' };
  s.otel.error = true;
  s.traces.retentionDays = 14;
  s.inventory = { total: 4, reviewed: 3, high: 1, unacceptable: 1, riskUndecided: 1, unacceptableNotBlocked: 1 };
  const st = statusOf(s);
  for (const id of [
    'guardrails',
    'audit_log',
    'provider_approval',
    'api_keys',
    'approval_gates',
    'monitors',
    'evals',
    'experiments',
    'cost_budgets',
    'secret_store',
    'otel_export',
    'trace_retention',
    'inventory_coverage',
  ])
    assert.equal(st[id], 'partial', id);
  assert.deepEqual(one(s, 'audit_log').evidence, ['kept 12 months (at least 6)', 'not verified yet']);
  assert.ok(
    one(s, 'provider_approval').evidence.includes(
      '1 served without a recorded approval (set up before approvals existed)',
    ),
  );
  assert.deepEqual(one(s, 'monitors').evidence, ['2 of 4 rules on', 'off: inventory_unreviewed']);
  assert.deepEqual(one(s, 'trace_retention').evidence, ['kept 14 days, up to 500 MB', 'under 183 days (6 months)']);
  assert.equal(one(s, 'evals').evidence[1], 'judge waiting for a model');
  assert.deepEqual(one(s, 'otel_export').evidence, [
    'to https://otel.example.com over http/protobuf',
    'the exporter reports an error',
  ]);
});

test('off: everything switched off, degraded, broken or missing; a part that cannot be read is off', () => {
  const s = good();
  s.guardrails = { scope: 'all', secrets: 'off', pii: 'off', injection: 'off' };
  s.audit.degraded = { since: '2026-11-03T10:00:00.000Z', missed: 2 };
  s.keys = [{ budgetUSD: null, expiresAt: null, scopes: ['llm'] }];
  s.workflows = [{ tier: 'R2', gated: false }];
  s.agentControl = { off: 'agent control is off on this server' };
  s.monitors = s.monitors.map((r) => ({ ...r, enabled: false }));
  s.datasets = { count: 0, experiments: [] };
  s.budgets = [];
  s.signIn = { mode: 'none', serverMode: false, tls: false };
  s.content = { otelCapture: true, traceContentOff: true };
  s.otel = { enabled: false };
  s.traces = { store: true, enabled: false, retentionDays: 14, maxBytes: 1 };
  s.inventory = { total: 3, reviewed: 0 };
  s.usage = null;
  const st = statusOf(s);
  for (const id of CATALOGUE.map((c) => c.id).filter(
    (x) => !['provider_approval', 'evals', 'secret_store'].includes(x),
  ))
    assert.equal(st[id], 'off', id);
  assert.deepEqual(one(s, 'audit_log').evidence, [
    'kept 12 months (at least 6)',
    'degraded since 2026-11-03T10:00:00.000Z: 2 entries not written',
  ]);
  assert.deepEqual(one(s, 'usage_log').evidence, ['could not be read']);
  assert.deepEqual(one(s, 'agent_control').evidence, ['agent control is off on this server']);
  assert.deepEqual(one(s, 'sign_in').evidence, ['sign-in: no sign-in', 'this machine only']);
  s.audit = { retentionMonths: 12, degraded: null, lastVerify: { ok: false, brokenAt: 9, reason: 'chain broken' } };
  assert.deepEqual(one(s, 'audit_log').evidence[1], 'last verify: broken at entry 9 (chain broken)');
  // A state that is not there at all, or a part of the wrong shape, never throws.
  assert.ok(controls(undefined).every((c) => c.status === 'off' && c.evidence[0] === 'could not be read'));
  assert.equal(one({ guardrails: 'x' }, 'guardrails').status, 'off');
});

test('GET /api/governance/controls: the controls with the audit state and the inventory counts', async () => {
  const st = good();
  const api = createGovernanceApi({
    audit: { status: () => ({ degraded: null, lastVerify: st.audit.lastVerify }) },
    settings: { get: () => ({ audit: { retentionMonths: 24 } }), save: () => {} },
    sources: async () => ({ live: { apps: [{ id: 'claude', name: 'Claude Code' }] } }),
    controlState: async () => {
      const { audit, inventory, now, ...rest } = st;
      return rest;
    },
    now: () => NOW,
  });
  const r = await api.route({ method: 'GET', path: '/api/governance/controls', query: new URLSearchParams() });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['generatedAt', 'notice', 'frameworks', 'clauses', 'controls']);
  assert.equal(r.body.controls.length, 17);
  const by = Object.fromEntries(r.body.controls.map((c) => [c.id, c]));
  assert.equal(by.audit_log.evidence[0], 'kept 24 months (at least 6)');
  assert.deepEqual(
    [by.inventory_coverage.status, by.inventory_coverage.evidence[0]],
    ['off', '0 of 1 item reviewed (0%)'],
  );
  assert.equal((await api.route({ method: 'POST', path: '/api/governance/controls' })).status, 405);
});
```

In `test/governance-inventory-http.test.js`, replace

```js
  assert.equal((await call(s, '/api/governance/inventory', { headers: { cookie } })).status, 200);
  assert.ok(s.alive());
});
```

with

```js
  assert.equal((await call(s, '/api/governance/inventory', { headers: { cookie } })).status, 200);
  assert.ok(s.alive());
});

test('controls: seventeen controls from the live settings, OpenTelemetry and trace retention included', async (t) => {
  const s = await startServer(t, {}, prepare);
  const r = await call(s, '/api/governance/controls');
  assert.equal(r.status, 200);
  assert.match(r.body.notice, /^Evidence for your assessment, not a certification\./);
  assert.equal(r.body.controls.length, 17);
  const by = Object.fromEntries(r.body.controls.map((c) => [c.id, c]));
  for (const c of r.body.controls) assert.ok(['in place', 'partial', 'off'].includes(c.status), c.id);
  assert.deepEqual(by.guardrails.evidence, [
    'secrets: redact',
    'personal data: off',
    'prompt injection: log',
    'scope: external',
  ]);
  assert.equal(by.guardrails.status, 'partial');
  assert.deepEqual([by.sign_in.status, by.sign_in.evidence[0]], ['off', 'sign-in: no sign-in']);
  assert.deepEqual([by.otel_export.status, by.otel_export.evidence], ['off', ['not set up (see docs/otel.md)']]);
  assert.deepEqual(
    [by.trace_retention.status, by.trace_retention.evidence[0]],
    ['partial', 'kept 14 days, up to 500 MB'],
  );
  assert.deepEqual(
    [by.secret_store.status, by.secret_store.evidence],
    ['partial', ['provider keys and tokens in the encrypted secret file']],
  );
  assert.deepEqual(
    [by.agent_control.status, by.agent_control.evidence],
    ['off', ['agent control is off without a dashboard sign-in']],
  );
  assert.equal(by.provider_approval.status, 'partial', 'the provider in config.json has no recorded approval');
  assert.equal(by.inventory_coverage.status, 'off');
  assert.ok(!r.text.includes('X_KEY') && !r.text.includes(s.data), 'no secret reference, no path');
  assert.ok(s.alive());
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/governance-controls.test.js test/governance-inventory-http.test.js`
Expected: FAIL (2 of 5: `Cannot find module '../lib/governance/controls'`, and the spawned controls test (404); the Task 3 spawned tests pass).

- [ ] **Step 3: The catalogue**

Create `lib/governance/controls.js`:

```js
// Governance compliance (AI Governance 3): the fixed catalogue of controls ZAAFPulse provides (spec I6, I7), each one
// mapped to clauses of the EU AI Act, the NIST AI RMF and ISO/IEC 42001, with a live status ('in place', 'partial',
// 'off') and its evidence (a setting's value, a count, a date) worked out from the state server.js reads. Pure: no
// I/O, no clock (the time comes in the state). Evidence for the owner's assessment, not a certification: nothing here
// says "compliant".
const FRAMEWORKS = [
  {
    id: 'eu-ai-act',
    name: 'EU AI Act',
    version: 'Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744',
  },
  { id: 'nist-ai-rmf', name: 'NIST AI RMF', version: 'NIST AI RMF 1.0' },
  { id: 'iso-42001', name: 'ISO/IEC 42001', version: 'ISO/IEC 42001:2023' },
];
const CLAUSES = [
  { id: 'eu-12', framework: 'eu-ai-act', ref: 'Art. 12', title: 'Record-keeping' },
  { id: 'eu-14', framework: 'eu-ai-act', ref: 'Art. 14', title: 'Human oversight' },
  {
    id: 'eu-26',
    framework: 'eu-ai-act',
    ref: 'Art. 26',
    title: 'Deployer obligations: logs kept at least 6 months, oversight assigned, monitoring',
  },
  { id: 'eu-50', framework: 'eu-ai-act', ref: 'Art. 50', title: "Transparency, where the owner's use applies" },
  {
    id: 'nist-gv-1.4',
    framework: 'nist-ai-rmf',
    ref: 'GOVERN 1.4',
    title: 'Risk management through policies, procedures and controls',
  },
  { id: 'nist-gv-1.6', framework: 'nist-ai-rmf', ref: 'GOVERN 1.6', title: 'An inventory of AI systems' },
  { id: 'nist-mp-1.1', framework: 'nist-ai-rmf', ref: 'MAP 1.1', title: 'Intended purposes and context documented' },
  { id: 'nist-ms-2.1', framework: 'nist-ai-rmf', ref: 'MEASURE 2.1', title: 'Test sets, metrics and tools documented' },
  {
    id: 'nist-ms-2.3',
    framework: 'nist-ai-rmf',
    ref: 'MEASURE 2.3',
    title: 'Performance measured in deployment-like conditions',
  },
  { id: 'nist-ms-2.4', framework: 'nist-ai-rmf', ref: 'MEASURE 2.4', title: 'Behaviour monitored in production' },
  { id: 'nist-ms-2.7', framework: 'nist-ai-rmf', ref: 'MEASURE 2.7', title: 'Security and resilience evaluated' },
  { id: 'nist-ms-2.10', framework: 'nist-ai-rmf', ref: 'MEASURE 2.10', title: 'Privacy risk examined' },
  { id: 'nist-mg-2.4', framework: 'nist-ai-rmf', ref: 'MANAGE 2.4', title: 'Mechanisms to disengage or deactivate' },
  {
    id: 'nist-mg-4.1',
    framework: 'nist-ai-rmf',
    ref: 'MANAGE 4.1',
    title: 'Post-deployment monitoring, override and change management',
  },
  { id: 'iso-a2', framework: 'iso-42001', ref: 'A.2', title: 'Policies related to AI' },
  { id: 'iso-a5', framework: 'iso-42001', ref: 'A.5', title: 'Assessing impacts of AI systems' },
  { id: 'iso-a6', framework: 'iso-42001', ref: 'A.6', title: 'AI system life cycle' },
  { id: 'iso-a7', framework: 'iso-42001', ref: 'A.7', title: 'Data for AI systems' },
  { id: 'iso-a8', framework: 'iso-42001', ref: 'A.8', title: 'Information for interested parties' },
  { id: 'iso-a9', framework: 'iso-42001', ref: 'A.9', title: 'Use of AI systems' },
  { id: 'iso-a10', framework: 'iso-42001', ref: 'A.10', title: 'Third-party and customer relationships' },
];
const NOTICE = 'Evidence for your assessment, not a certification. Statuses follow the current settings and state.';
const STATUSES = ['in place', 'partial', 'off'];
const KEY_RULES = ['guardrail_block', 'audit_chain_broken', 'inventory_unreviewed'];
const SIX_MONTHS_DAYS = 183;
const RECENT_DAYS = 90; // an experiment finished this recently counts as testing that happens
const DAY_MS = 864e5;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const n = (v) => (Number.isFinite(v) ? v : 0);
const plural = (k, word, many = `${word}s`) => `${k} ${k === 1 ? word : many}`;
const dayOf = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null);
// Off, with the reason, when a part of the state could not be read.
const unread = () => ({ status: 'off', evidence: ['could not be read'] });
// in place when every one counts, off when none does, partial between; in place when there is nothing to count.
const share = (good, all) => (all === 0 || good === all ? 'in place' : good === 0 ? 'off' : 'partial');

// Each control: id, title, the clauses it maps to, the page that shows it, and how its status and evidence follow
// from the state. check(part, state) gets state[part] (null when it could not be read).
const CATALOGUE = [
  {
    id: 'guardrails',
    title: 'Gateway guardrails',
    clauses: ['nist-ms-2.7', 'nist-ms-2.10', 'iso-a2', 'iso-a7'],
    link: '#gateway/router',
    part: 'guardrails',
    check(g) {
      const modes = [
        ['secrets', g.secrets],
        ['personal data', g.pii],
        ['prompt injection', g.injection],
      ];
      const on = modes.filter(([, m]) => m && m !== 'off').length;
      return {
        status: on === 3 ? 'in place' : on === 0 ? 'off' : 'partial',
        evidence: [...modes.map(([w, m]) => `${w}: ${m || 'off'}`), `scope: ${g.scope || 'external'}`],
      };
    },
  },
  {
    id: 'audit_log',
    title: 'Governance audit log',
    clauses: ['eu-12', 'eu-26', 'nist-gv-1.4', 'nist-mg-4.1', 'iso-a6'],
    link: '#governance/audit',
    part: 'audit',
    check(a) {
      const kept = `kept ${a.retentionMonths} months (at least 6)`;
      const v = a.lastVerify;
      if (a.degraded)
        return {
          status: 'off',
          evidence: [
            kept,
            `degraded since ${a.degraded.since}: ${plural(n(a.degraded.missed), 'entry', 'entries')} not written`,
          ],
        };
      if (!v) return { status: 'partial', evidence: [kept, 'not verified yet'] };
      const when = v.at ? ` (${dayOf(Date.parse(v.at))})` : '';
      if (!v.ok)
        return {
          status: 'off',
          evidence: [
            kept,
            v.reason === 'key missing'
              ? `last verify${when}: the audit key is missing`
              : `last verify${when}: broken at entry ${v.brokenAt} (${v.reason})`,
          ],
        };
      return {
        status: 'in place',
        evidence: [kept, `last verify${when}: chain intact, ${plural(n(v.checked), 'entry', 'entries')} checked`],
      };
    },
  },
  {
    id: 'usage_log',
    title: 'Gateway request log',
    clauses: ['eu-12', 'eu-26', 'nist-ms-2.4', 'iso-a6'],
    link: '#gateway',
    part: 'usage',
    check: (u) => ({
      status: 'in place',
      evidence: [`${plural(n(u.requests), 'gateway request')} recorded this month`],
    }),
  },
  {
    id: 'provider_approval',
    title: 'External providers need approval',
    clauses: ['eu-26', 'nist-gv-1.4', 'iso-a10'],
    link: '#gateway/providers',
    part: 'providers',
    check(list) {
      const ext = arr(list).filter((p) => p.tier === 'external');
      const waiting = ext.filter((p) => p.approved === false).length;
      const legacy = ext.filter((p) => p.approved !== false && !p.recorded).length;
      return {
        status: legacy ? 'partial' : 'in place',
        evidence: [
          plural(ext.length, 'external provider'),
          `${ext.length - waiting} approved`,
          `${waiting} waiting for approval`,
          ...(legacy ? [`${legacy} served without a recorded approval (set up before approvals existed)`] : []),
        ],
      };
    },
  },
  {
    id: 'api_keys',
    title: 'API keys with scopes, budgets and expiry',
    clauses: ['eu-26', 'nist-gv-1.4', 'nist-mg-2.4', 'iso-a9'],
    link: '#endpoint/keys',
    part: 'keys',
    check(list, s) {
      const active = arr(list).filter((k) => !k.revokedAt && !(Number.isFinite(k.expiresAt) && k.expiresAt <= s.now));
      const budget = active.filter((k) => n(k.budgetUSD) > 0).length;
      const expiry = active.filter((k) => Number.isFinite(k.expiresAt)).length;
      const limited = active.filter((k) => n(k.budgetUSD) > 0 || Number.isFinite(k.expiresAt)).length;
      const narrow = active.filter((k) => Array.isArray(k.scopes) && k.scopes.length < 4).length;
      return {
        status: share(limited, active.length),
        evidence: [
          plural(active.length, 'active key'),
          `${budget} with a budget`,
          `${expiry} with an expiry`,
          `${narrow} limited to some scopes`,
        ],
      };
    },
  },
  {
    id: 'approval_gates',
    title: 'Human approval in workflows',
    clauses: ['eu-14', 'eu-26', 'nist-mg-4.1', 'iso-a9'],
    link: '#a2a',
    part: 'workflows',
    check(list) {
      const all = arr(list);
      const acting = all.filter((w) => w.tier === 'R2' || w.tier === 'R3');
      const gated = acting.filter((w) => w.gated).length;
      return {
        status: share(gated, acting.length),
        evidence: [
          `workflows that send, change or decide: ${gated} of ${acting.length} wait for a person`,
          `workflows with an approval step: ${all.filter((w) => w.gated).length} of ${all.length}`,
        ],
      };
    },
  },
  {
    id: 'agent_control',
    title: 'Pause and stop an agent',
    clauses: ['eu-14', 'nist-mg-2.4', 'iso-a9'],
    link: '#settings/monitors',
    part: 'agentControl',
    check: (c) =>
      c.off
        ? { status: 'off', evidence: [String(c.off)] }
        : {
            status: 'in place',
            evidence: ['pause, resume and stop are available from the dashboard and the Monitors'],
          },
  },
  {
    id: 'monitors',
    title: 'Monitors rules',
    clauses: ['eu-26', 'nist-ms-2.4', 'nist-mg-4.1', 'iso-a6'],
    link: '#settings/monitors',
    part: 'monitors',
    check(list) {
      const rules = arr(list);
      const on = new Set(rules.filter((r) => r.enabled).map((r) => r.id));
      const keyOff = KEY_RULES.filter((id) => !on.has(id));
      return {
        status: keyOff.length === 0 ? 'in place' : keyOff.length === KEY_RULES.length ? 'off' : 'partial',
        evidence: [
          `${on.size} of ${plural(rules.length, 'rule')} on`,
          keyOff.length ? `off: ${keyOff.join(', ')}` : `${KEY_RULES.join(', ')} on`,
        ],
      };
    },
  },
  {
    id: 'evals',
    title: 'Evals running',
    clauses: ['nist-ms-2.3', 'nist-ms-2.4', 'iso-a6'],
    link: '#quality',
    part: 'evals',
    check(e) {
      const judging = e.judge && n(e.evaluators) > 0 && e.ok;
      return {
        status: judging ? 'in place' : 'partial',
        evidence: [
          'code evaluators run on every session',
          !e.judge
            ? 'judge off'
            : e.ok
              ? `judge model: ${e.model || 'chosen automatically'}`
              : 'judge waiting for a model',
          `${n(e.evaluators)} of ${n(e.total)} judge evaluators on`,
          `${n(e.today)} judged today`,
        ],
      };
    },
  },
  {
    id: 'experiments',
    title: 'Dataset experiments',
    clauses: ['nist-ms-2.1', 'nist-ms-2.3', 'iso-a6', 'iso-a7'],
    link: '#datasets/experiments',
    part: 'datasets',
    check(d, s) {
      const done = arr(d.experiments).filter((x) => x.status === 'done' && Number.isFinite(x.endedAt));
      const last = done.reduce((m, x) => Math.max(m, x.endedAt), -Infinity);
      const recent = done.some((x) => s.now - x.endedAt <= RECENT_DAYS * DAY_MS);
      return {
        status: n(d.count) === 0 ? 'off' : recent ? 'in place' : 'partial',
        evidence: [
          plural(n(d.count), 'dataset'),
          `${plural(done.length, 'finished experiment')}`,
          done.length ? `last finished ${dayOf(last)}` : 'no experiment finished yet',
        ],
      };
    },
  },
  {
    id: 'cost_budgets',
    title: 'Budgets that block or pause',
    clauses: ['nist-mg-2.4', 'iso-a9'],
    link: '#cost/budgets',
    part: 'budgets',
    check(list) {
      const all = arr(list);
      const block = all.filter((b) => b.enforce === 'block').length;
      const pause = all.filter((b) => b.enforce === 'pause').length;
      return {
        status: !all.length ? 'off' : block + pause ? 'in place' : 'partial',
        evidence: [plural(all.length, 'budget'), `${block} block`, `${pause} pause`],
      };
    },
  },
  {
    id: 'secret_store',
    title: 'Secrets in the OS store',
    clauses: ['nist-ms-2.7', 'iso-a7'],
    link: '#settings',
    part: 'secretStore',
    check: (st) => ({
      status: st.id === 'keychain' || st.id === 'libsecret' ? 'in place' : 'partial',
      evidence: [`provider keys and tokens in the ${st.label || st.id}`],
    }),
  },
  {
    id: 'sign_in',
    title: 'Dashboard sign-in',
    clauses: ['eu-26', 'nist-ms-2.7', 'iso-a9'],
    link: '#settings',
    part: 'signIn',
    check(si) {
      const words = { local: 'only this OS account', password: 'a password', none: 'no sign-in' };
      return {
        status: si.mode === 'local' || si.mode === 'password' ? 'in place' : 'off',
        evidence: [
          `sign-in: ${words[si.mode] || si.mode}`,
          si.serverMode ? 'server mode' : 'this machine only',
          ...(si.serverMode ? [si.tls ? 'TLS on' : 'TLS at a proxy, or off'] : []),
        ],
      };
    },
  },
  {
    id: 'content_capture',
    title: 'Content capture off',
    clauses: ['nist-ms-2.10', 'iso-a7'],
    link: '#trace',
    part: 'content',
    check: (c) => ({
      status: c.otelCapture ? 'off' : 'in place',
      evidence: [
        c.otelCapture ? 'the OpenTelemetry export sends prompts and replies' : 'no prompt or reply is exported',
        'the local trace store keeps no content',
        c.traceContentOff
          ? 'the trace explorer shows no text'
          : 'the trace explorer shows the owner the text of local logs',
      ],
    }),
  },
  {
    id: 'otel_export',
    title: 'OpenTelemetry export',
    clauses: ['eu-12', 'nist-ms-2.4', 'nist-mg-4.1', 'iso-a6'],
    link: '#settings',
    part: 'otel',
    check: (o) =>
      !o.enabled
        ? { status: 'off', evidence: ['not set up (see docs/otel.md)'] }
        : {
            status: o.error ? 'partial' : 'in place',
            evidence: [
              `to ${o.origin || 'the configured endpoint'}${o.protocol ? ` over ${o.protocol}` : ''}`,
              ...(o.error ? ['the exporter reports an error'] : []),
            ],
          },
  },
  {
    id: 'trace_retention',
    title: 'Trace retention',
    clauses: ['eu-12', 'eu-26', 'nist-ms-2.4', 'iso-a6'],
    link: '#trace',
    part: 'traces',
    check(tr) {
      if (!tr.store || !tr.enabled)
        return { status: 'off', evidence: [tr.store ? 'tracing is off' : 'the local trace store is not available'] };
      const days = n(tr.retentionDays);
      return {
        status: days >= SIX_MONTHS_DAYS ? 'in place' : 'partial',
        evidence: [
          `kept ${plural(days, 'day')}, up to ${Math.round(n(tr.maxBytes) / 1048576)} MB`,
          ...(days < SIX_MONTHS_DAYS ? [`under ${SIX_MONTHS_DAYS} days (6 months)`] : []),
        ],
      };
    },
  },
  {
    id: 'inventory_coverage',
    title: 'AI inventory reviewed',
    clauses: ['eu-26', 'eu-50', 'nist-gv-1.6', 'nist-mp-1.1', 'iso-a5', 'iso-a8'],
    link: '#governance',
    part: 'inventory',
    check(c) {
      const total = n(c.total);
      const reviewed = n(c.reviewed);
      const open = n(c.riskUndecided) + n(c.unacceptableNotBlocked);
      const pct = total ? Math.round((reviewed / total) * 100) : 100;
      return {
        status: total === 0 || (reviewed === total && open === 0) ? 'in place' : reviewed === 0 ? 'off' : 'partial',
        evidence: [
          `${reviewed} of ${plural(total, 'item')} reviewed (${pct}%)`,
          `${n(c.high)} high risk, ${n(c.unacceptable)} unacceptable`,
          `${n(c.riskUndecided)} high or unacceptable without a decision`,
          `${n(c.unacceptableNotBlocked)} unacceptable not blocked`,
        ],
      };
    },
  },
];

// controls(state) -> [{ id, title, status, evidence: [text], link, clauses: [{ id, framework, ref, title }] }].
// state: { now, guardrails, audit, usage, providers, keys, workflows, agentControl, monitors, evals, datasets, budgets,
// secretStore, signIn, content, otel, traces, inventory }; a part that is null or missing could not be read.
function controls(state) {
  const s = isObj(state) ? state : {};
  const byId = new Map(CLAUSES.map((c) => [c.id, c]));
  return CATALOGUE.map((c) => {
    const part = s[c.part];
    let r;
    try {
      r = part === null || part === undefined ? unread() : c.check(part, s);
    } catch {
      r = unread();
    }
    return {
      id: c.id,
      title: c.title,
      status: r.status,
      evidence: r.evidence,
      link: c.link,
      clauses: c.clauses.map((id) => byId.get(id)),
    };
  });
}

module.exports = { controls, CATALOGUE, CLAUSES, FRAMEWORKS, NOTICE, STATUSES, KEY_RULES, SIX_MONTHS_DAYS };
```

- [ ] **Step 4: The route**

In `lib/governance/api.js`, replace

```js
//   GET  /api/governance/inventory                                       the AI inventory (AI Governance 3)
//   POST /api/governance/inventory  { id, owner, purpose, risk, decision, note } | { id, clear: true }
// It also holds the daily pass (dailyPass), which reads the retention set here, and builds the inventory from the
// sources server.js gathers (the reviews are config.json "governance.inventory", the seen dates a store of their own).
```

with

```js
//   GET  /api/governance/inventory                                       the AI inventory (AI Governance 3)
//   POST /api/governance/inventory  { id, owner, purpose, risk, decision, note } | { id, clear: true }
//   GET  /api/governance/controls                                        the controls with status, evidence, clauses
// It also holds the daily pass (dailyPass), which reads the retention set here, and builds the inventory from the
// sources server.js gathers (the reviews are config.json "governance.inventory", the seen dates a store of their own).
```

In `lib/governance/api.js`, replace

```js
const { cleanRetention, RETENTION } = require('./audit');
const { buildInventory, cleanReview } = require('./inventory');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
```

with

```js
const { cleanRetention, RETENTION } = require('./audit');
const { buildInventory, cleanReview } = require('./inventory');
const { controls, CLAUSES, FRAMEWORKS, NOTICE } = require('./controls');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
```

In `lib/governance/api.js`, replace

```js
// log(message): where the daily pass reports a step that failed.
// sources(): a Promise of the inventory sources (lib/governance/inventory.js buildInventory); seen: { read(),
// write(map) } (lib/governance/seen.js).
function createGovernanceApi({
  audit,
```

with

```js
// log(message): where the daily pass reports a step that failed.
// sources(): a Promise of the inventory sources (lib/governance/inventory.js buildInventory); seen: { read(),
// write(map) } (lib/governance/seen.js). controlState(): a Promise of the parts of lib/governance/controls.js state
// that server.js reads (everything but now, audit and inventory, which come from here).
function createGovernanceApi({
  audit,
```

In `lib/governance/api.js`, replace

```js
  sources = async () => ({}),
  seen = { read: () => ({}), write: () => false },
  now = Date.now,
  log = console.error,
```

with

```js
  sources = async () => ({}),
  seen = { read: () => ({}), write: () => false },
  controlState = async () => ({}),
  now = Date.now,
  log = console.error,
```

In `lib/governance/api.js`, replace

```js
    };
  }
  // A review saved into config.json governance.inventory (every save is a config.change entry), or cleared.
  function saveReview(body) {
```

with

```js
    };
  }
  // The controls: the state server.js reads, the audit log's state and retention, and the inventory's counts.
  async function controlsView() {
    const t = now();
    const [st, inv] = await Promise.all([controlState(), inventory()]);
    let auditState = null;
    try {
      auditState = { retentionMonths: retention(), ...audit.status() };
    } catch {
      auditState = null;
    }
    return {
      generatedAt: new Date(t).toISOString(),
      notice: NOTICE,
      frameworks: FRAMEWORKS,
      clauses: CLAUSES,
      controls: controls({ ...(st || {}), now: t, audit: auditState, inventory: inv.counts }),
    };
  }
  // A review saved into config.json governance.inventory (every save is a config.change entry), or cleared.
  function saveReview(body) {
```

In `lib/governance/api.js`, replace

```js
    '/api/governance/audit/status': () => reply(200, { retentionMonths: retention(), ...audit.status() }),
    '/api/governance/inventory': async () => reply(200, await inventory()),
  };
  const POST = {
```

with

```js
    '/api/governance/audit/status': () => reply(200, { retentionMonths: retention(), ...audit.status() }),
    '/api/governance/inventory': async () => reply(200, await inventory()),
    '/api/governance/controls': async () => reply(200, await controlsView()),
  };
  const POST = {
```

In `lib/governance/api.js`, replace

```js
    lastCounts ? { newUnreviewed: lastCounts.newUnreviewed, newKinds: lastCounts.newKinds } : null;

  return { route, retention, dailyPass, inventory, inventoryStatus };
}
```

with

```js
    lastCounts ? { newUnreviewed: lastCounts.newUnreviewed, newKinds: lastCounts.newKinds } : null;

  return { route, retention, dailyPass, inventory, inventoryStatus, controls: controlsView };
}
```

- [ ] **Step 5: `server.js`: the state the controls read (I10: the OTel status and the trace retention)**

In `server.js`, replace

```js
const mcpScan = require('./lib/governance/mcp-scan');
const { createSeenStore } = require('./lib/governance/seen');

const PORT = Number(process.env.ZAAFPULSE_PORT || process.env.PORT) || 4777;
```

with

```js
const mcpScan = require('./lib/governance/mcp-scan');
const { createSeenStore } = require('./lib/governance/seen');
const { cleanPolicy: guardPolicy } = require('./lib/gateway/guardrails');
const { RULES: MONITOR_RULES } = require('./lib/monitors/rules');

const PORT = Number(process.env.ZAAFPULSE_PORT || process.env.PORT) || 4777;
```

In `server.js`, replace

```js
  settings: { get: () => rawConfig().governance, save: (g) => saveConfigSection('governance', g) },
  sources: () => inventorySources(),
  seen: createSeenStore({ file: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'governance', 'seen.json') }),
});
```

with

```js
  settings: { get: () => rawConfig().governance, save: (g) => saveConfigSection('governance', g) },
  sources: () => inventorySources(),
  controlState: () => controlState(),
  seen: createSeenStore({ file: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'governance', 'seen.json') }),
});
```

In `server.js`, replace

```js
// false }). Retention is read at start; the on/off switch whenever config.json changes.
const tracingCfg = () => (rawConfig() || {}).tracing || {};
// A store that cannot open (unwritable or corrupt folder) never takes the server down: tracing is just off.
let traceStore = null;
try {
```

with

```js
// false }). Retention is read at start; the on/off switch whenever config.json changes.
const tracingCfg = () => (rawConfig() || {}).tracing || {};
// A store that cannot open (unwritable or corrupt folder) never takes the server down: tracing is just off. The
// retention in force is kept for the Compliance page (GET /api/governance/controls).
const TRACE_RETENTION = {
  days: Number(tracingCfg().retentionDays) > 0 ? Number(tracingCfg().retentionDays) : 14,
  maxBytes: Number(tracingCfg().maxBytes) > 0 ? Number(tracingCfg().maxBytes) : 500 * 1024 * 1024,
};
let traceStore = null;
try {
```

In `server.js`, replace

```js
  traceStore = createTraceStore({
    dir: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'traces'),
    retentionDays: Number(tracingCfg().retentionDays) > 0 ? Number(tracingCfg().retentionDays) : 14,
    maxBytes: Number(tracingCfg().maxBytes) > 0 ? Number(tracingCfg().maxBytes) : 500 * 1024 * 1024,
  });
} catch (err) {
```

with

```js
  traceStore = createTraceStore({
    dir: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'traces'),
    retentionDays: TRACE_RETENTION.days,
    maxBytes: TRACE_RETENTION.maxBytes,
  });
} catch (err) {
```

In `server.js`, replace

```js
  return { live, summary, trace: traced, gateway: gw, runtimes, integrations, mcp };
}
const insightMemo = new Map();
function getInsights(range) {
```

with

```js
  return { live, summary, trace: traced, gateway: gw, runtimes, integrations, mcp };
}
// The state the controls of the Compliance page are worked out from (lib/governance/controls.js): settings, counts and
// dates only. Each part is capped at 2 s and null when it could not be read. The OpenTelemetry export is named by its
// endpoint's origin, never its headers.
async function controlState() {
  const gw = () => (rawConfig() || {}).gateway || {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const parts = {
    guardrails: () => guardPolicy(gw().guardrails),
    usage: () => ({ requests: gateway.usage.summary().totals.requests }),
    providers: () =>
      list(gw().providers).map((p) => ({
        id: p.id,
        tier: gateway.providers.tierOf(p),
        approved: p.approved !== false,
        recorded: typeof p.approved === 'boolean',
      })),
    keys: () =>
      gateway.keys.list().map((k) => ({
        revokedAt: k.revokedAt,
        expiresAt: k.expiresAt,
        budgetUSD: k.budgetUSD,
        scopes: k.scopes,
      })),
    workflows: () =>
      gateway.workflows.list().map((w) => ({ tier: w.tier, gated: list(w.steps).some((x) => x && x.approve) })),
    agentControl: () => ({ off: agentControl.off() }),
    monitors: () =>
      MONITOR_RULES.filter((r) => !RETIRED_RULES.includes(r.id)).map((r) => ({
        id: r.id,
        enabled: monitorApiState.settings(r.id).enabled,
      })),
    evals: async () => {
      const cfg = evalApi.settings();
      const st = await evalEngine.status();
      const on = Object.values(cfg.evaluators || {});
      return {
        judge: cfg.judge !== false,
        evaluators: on.filter(Boolean).length,
        total: on.length,
        ok: !!(st && st.judge && st.judge.ok),
        model: (st && st.judge && st.judge.model) || null,
        today: (st && st.today && st.today.count) || 0,
      };
    },
    datasets: () => ({
      count: datasets.list().length,
      experiments: experiments.list().map((x) => ({ status: x.status, endedAt: x.endedAt })),
    }),
    budgets: () => costBudgets.list().budgets.map((b) => ({ enforce: b.enforce })),
    secretStore: () => {
      const s = require('./lib/secret-store').defaultStore();
      return { id: s.id, label: s.label };
    },
    signIn: () => ({ mode: auth.mode, serverMode: SERVER_MODE, tls: !!TLS }),
    content: () => ({ otelCapture: otel.status().captureContent === true, traceContentOff: contentOff }),
    otel: () => {
      const o = otel.status();
      return {
        enabled: !!o.enabled,
        error: !!o.error,
        origin: o.endpoint ? mcpScan.originOf(o.endpoint) : null,
        protocol: o.protocol || null,
      };
    },
    traces: () => ({
      store: !!traceStore,
      enabled: tracingOn(),
      retentionDays: TRACE_RETENTION.days,
      maxBytes: TRACE_RETENTION.maxBytes,
    }),
  };
  const names = Object.keys(parts);
  const values = await Promise.all(names.map((k) => invSource(parts[k])));
  return Object.fromEntries(names.map((k, i) => [k, values[i]]));
}
const insightMemo = new Map();
function getInsights(range) {
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/governance-controls.test.js test/governance-inventory-http.test.js test/governance-inventory-api.test.js test/governance-api.test.js test/trace-api.test.js`
Expected: PASS (28 tests).

- [ ] **Step 7: Check the style**

Run: `npx prettier@3 --check lib/governance/controls.js lib/governance/api.js test/governance-controls.test.js test/governance-inventory-http.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath server.js < server.js | diff server.js - | grep -c '^[<>]'`
Expected: `7`

- [ ] **Step 8: Commit**

```bash
git add lib/governance/controls.js lib/governance/api.js server.js test/governance-controls.test.js test/governance-inventory-http.test.js
git commit -m "Governance compliance: seventeen controls with a live status, their evidence and the clauses they map to"
```

---
### Task 6: the evidence export

**Files:**
- Create: `lib/governance/evidence.js`
- Modify: `lib/governance/api.js` (lines 9, 15, 81, 89, 151, 168, 236, 296)
- Modify: `server.js` (line 302)
- Modify: `test/governance-inventory-http.test.js` (lines 188, 238)
- Test: `test/governance-evidence.test.js` (create)

**Interfaces:**
- Consumes: `FRAMEWORKS`, `CLAUSES`, `NOTICE` (Task 5); `inventory()` (Task 3) and the controls view (Task 5) in the
  router; `govRecord(entry)` in `server.js` (it adds the request's actor).
- Produces (`lib/governance/evidence.js`): `evidenceReport({ inventory, controls, audit, version, generatedAt }) →
  report` (V13), `toJson(report) → string`, `toMarkdown(report) → string`, `ITEM_FIELDS`.
- Produces (`lib/governance/api.js`): `createGovernanceApi({ …, record = () => null, version = null })`; route `GET
  /api/governance/evidence?format=json|md` (a download; one `governance.export` entry per export).

- [ ] **Step 1: Write the failing tests**

Create `test/governance-evidence.test.js`:

```js
// Governance compliance (AI Governance 3): the evidence export (lib/governance/evidence.js and GET
// /api/governance/evidence). The report holds the inventory with its reviews, the controls with evidence and clauses,
// the audit log's verify and retention, the time and the version; it holds no path and no secret; the Markdown is
// readable and an owner's text cannot break its tables; the export is recorded as governance.export.
const test = require('node:test');
const assert = require('node:assert/strict');
const { evidenceReport, toJson, toMarkdown } = require('../lib/governance/evidence');
const { controls } = require('../lib/governance/controls');
const { createGovernanceApi } = require('../lib/governance/api');

const NOW = Date.UTC(2026, 10, 3, 12);
const inventory = {
  generatedAt: '2026-11-03T12:00:00.000Z',
  counts: { total: 2, reviewed: 1, unreviewed: 1, gone: 0 },
  failed: ['trace'],
  clients: [{ client: 'claude', name: 'Claude Code', file: '~/.claude.json', state: 'ok', servers: 1 }],
  items: [
    {
      id: 'mcp:db',
      kind: 'mcp',
      name: 'db',
      vendor: null,
      where: ['Claude Code config'],
      state: 'configured',
      firstSeen: '2026-11-01',
      lastSeen: '2026-11-03',
      status: 'reviewed',
      review: {
        owner: 'Ana | Ops',
        purpose: 'orders\n<script>x</script>',
        risk: 'high',
        decision: 'restricted',
        note: '',
      },
      transport: 'stdio',
      command: 'uvx',
      package: 'pg-mcp',
      origin: null,
      clients: ['Claude Code'],
      projects: ['~/code/secret-client-project'],
    },
    { id: 'app:claude', kind: 'app', name: 'Claude Code', vendor: 'Anthropic', where: ['running'], state: 'running' },
  ],
};
const audit = {
  retentionMonths: 12,
  degraded: null,
  lastVerify: { ok: true, checked: 4, from: 1, to: 4, at: '2026-11-03T02:00:00.000Z' },
};
const report = () =>
  evidenceReport({
    inventory,
    controls: { controls: controls({ now: NOW, audit, inventory: inventory.counts }) },
    audit,
    version: '1.0.4',
    generatedAt: '2026-11-03T12:00:00.000Z',
  });

test('the report: what it holds, and no project folder or client file', () => {
  const r = report();
  assert.deepEqual(Object.keys(r), [
    'title',
    'notice',
    'generatedAt',
    'version',
    'frameworks',
    'controls',
    'audit',
    'inventory',
  ]);
  assert.deepEqual([r.version, r.generatedAt, r.controls.length], ['1.0.4', '2026-11-03T12:00:00.000Z', 17]);
  assert.deepEqual(r.audit, audit);
  assert.deepEqual(r.inventory.failed, ['trace']);
  assert.equal(r.inventory.items[0].review.risk, 'high');
  assert.deepEqual(r.controls[1].clauses[0], { framework: 'eu-ai-act', ref: 'Art. 12', title: 'Record-keeping' });
  const text = toJson(r);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), r);
  for (const s of ['secret-client-project', '~/.claude.json', 'projects', '"file"'])
    assert.ok(!text.includes(s), `${s} must not be exported`);
});

test('Markdown: notice, controls, each framework, audit log and inventory; owner text cannot break out', () => {
  const md = toMarkdown(report());
  const lines = md.split('\n');
  const has = (line) => assert.ok(lines.includes(line), line);
  assert.deepEqual(lines.slice(0, 7), [
    '# ZAAFPulse governance evidence',
    '',
    'Generated 2026-11-03T12:00:00.000Z by ZAAFPulse 1.0.4.',
    '',
    '> Evidence for your assessment, not a certification. Statuses follow the current settings and state.',
    '',
    'Frameworks: EU AI Act (Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744); ' +
      'NIST AI RMF (NIST AI RMF 1.0); ISO/IEC 42001 (ISO/IEC 42001:2023).',
  ]);
  has('| Control | Status | Evidence | Clauses | Page |');
  has(
    '| Governance audit log | in place | kept 12 months (at least 6); last verify (2026-11-03): chain intact, ' +
      '4 entries checked | Art. 12, Art. 26, GOVERN 1.4, MANAGE 4.1, A.6 | #governance/audit |',
  );
  has('## EU AI Act (Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744)');
  has('## NIST AI RMF (NIST AI RMF 1.0)');
  has('## ISO/IEC 42001 (ISO/IEC 42001:2023)');
  has('| Art. 14 Human oversight | Human approval in workflows | off |');
  // A framework's clauses come in their own order.
  const eu = lines.slice(
    lines.indexOf('## EU AI Act (Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744)'),
  );
  assert.deepEqual(
    eu.slice(4, 7).map((l) => l.split(' | ')[0]),
    ['| Art. 12 Record-keeping', '| Art. 12 Record-keeping', '| Art. 12 Record-keeping'],
  );
  has('- Last verify: chain intact, entries 1–4 checked (2026-11-03T02:00:00.000Z)');
  has('2 items: 1 reviewed, 1 unreviewed, 0 reviews of items no longer seen.');
  has('Sources that could not be read: trace.');
  has(
    '| db (mcp:db) | mcp | — | Claude Code config | configured | 2026-11-01 | 2026-11-03 | Ana \\| Ops | ' +
      'orders &lt;script&gt;x&lt;/script&gt; | high | restricted | — |',
  );
  assert.ok(!md.includes('<script>') && !md.includes('secret-client-project'));
  assert.doesNotMatch(md, /complian/i);
});

test('GET evidence: JSON or Markdown as a download, recorded as governance.export; a bad format is 400', async () => {
  const recorded = [];
  const api = createGovernanceApi({
    audit: { status: () => audit },
    settings: { get: () => ({ audit: { retentionMonths: 12 } }), save: () => {} },
    sources: async () => ({ live: { apps: [{ id: 'claude', name: 'Claude Code' }] } }),
    record: (e) => recorded.push(e),
    version: '1.0.4',
    now: () => NOW,
  });
  const get = (q) => api.route({ method: 'GET', path: '/api/governance/evidence', query: new URLSearchParams(q) });
  const json = await get('');
  assert.equal(json.status, 200);
  assert.equal(json.type, 'application/json; charset=utf-8');
  assert.deepEqual(json.headers, {
    'Content-Disposition': 'attachment; filename="zaafpulse-evidence-2026-11-03.json"',
  });
  const r = JSON.parse(json.body);
  assert.deepEqual([r.version, r.inventory.items[0].id, r.audit.retentionMonths], ['1.0.4', 'app:claude', 12]);
  const md = await get('format=md');
  assert.equal(md.type, 'text/markdown; charset=utf-8');
  assert.match(md.headers['Content-Disposition'], /zaafpulse-evidence-2026-11-03\.md"$/);
  assert.match(md.body, /^# ZAAFPulse governance evidence/);
  assert.deepEqual(recorded, [
    { action: 'governance.export', target: { type: 'evidence', id: 'json' } },
    { action: 'governance.export', target: { type: 'evidence', id: 'md' } },
  ]);
  assert.deepEqual(await get('format=pdf'), { status: 400, body: { error: 'format: json or md' } });
  assert.equal(recorded.length, 2, 'a refused export is not an export');
});
```

In `test/governance-inventory-http.test.js`, replace

```js
});

test('inventory: for a dashboard session only; no sign-in or an API key is a 401', async (t) => {
  const s = await startServer(t, { ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: 'correct horse battery' });
  for (const headers of [{}, { authorization: 'Bearer zp_not_a_session' }]) {
    assert.equal((await call(s, '/api/governance/inventory', { headers })).status, 401);
    const post = { method: 'POST', body: { id: 'mcp:x', owner: 'x' }, headers };
    assert.equal((await call(s, '/api/governance/inventory', post)).status, 401);
```

with

```js
});

test('inventory, controls and evidence: for a dashboard session only; no sign-in or an API key is a 401', async (t) => {
  const s = await startServer(t, { ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: 'correct horse battery' });
  for (const headers of [{}, { authorization: 'Bearer zp_not_a_session' }]) {
    for (const p of ['/api/governance/inventory', '/api/governance/controls', '/api/governance/evidence?format=md'])
      assert.equal((await call(s, p, { headers })).status, 401, p);
    const post = { method: 'POST', body: { id: 'mcp:x', owner: 'x' }, headers };
    assert.equal((await call(s, '/api/governance/inventory', post)).status, 401);
```

In `test/governance-inventory-http.test.js`, replace

```js
  assert.ok(!r.text.includes('X_KEY') && !r.text.includes(s.data), 'no secret reference, no path');
  assert.ok(s.alive());
});
```

with

```js
  assert.ok(!r.text.includes('X_KEY') && !r.text.includes(s.data), 'no secret reference, no path');
  assert.ok(s.alive());
});

test('evidence: a Markdown and a JSON download, each a governance.export entry by the dashboard', async (t) => {
  const s = await startServer(t, {}, prepare);
  const md = await call(s, '/api/governance/evidence?format=md');
  assert.equal(md.status, 200);
  assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.match(
    md.headers.get('content-disposition'),
    /^attachment; filename="zaafpulse-evidence-\d{4}-\d{2}-\d{2}\.md"$/,
  );
  assert.match(md.text, /^# ZAAFPulse governance evidence\n\nGenerated .* by ZAAFPulse \d+\.\d+\.\d+\./);
  assert.match(md.text, /\| github \(mcp:github\) \| mcp \|/);
  const json = await call(s, '/api/governance/evidence?format=json');
  assert.equal(json.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(json.body.version, require('../package.json').version);
  assert.equal(json.body.controls.length, 17);
  assert.ok(json.body.inventory.items.some((i) => i.id === 'mcp:db' && !('projects' in i)));
  for (const text of [md.text, json.text]) {
    assert.ok(!text.includes(s.data), 'no path');
    assert.ok(!text.includes('~/.claude.json') && !text.includes('code/shop'), 'no client file, no project folder');
    for (const x of SECRETS) assert.ok(!text.includes(x), x);
  }
  assert.equal((await call(s, '/api/governance/evidence?format=pdf')).status, 400);
  const exports = entries(s).filter((e) => e.action === 'governance.export');
  assert.deepEqual(
    exports.map((e) => [e.target, e.actor.via, e.outcome]),
    [
      [{ type: 'evidence', id: 'md' }, 'dashboard', 'ok'],
      [{ type: 'evidence', id: 'json' }, 'dashboard', 'ok'],
    ],
  );
  assert.ok(s.alive());
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/governance-evidence.test.js test/governance-inventory-http.test.js`
Expected: FAIL (2 of 6: `Cannot find module '../lib/governance/evidence'`, and the spawned evidence test (404); the others pass (the sign-in answers 401 before any route)).

- [ ] **Step 3: The renderers**

Create `lib/governance/evidence.js`:

```js
// Governance compliance (AI Governance 3): the evidence export (spec I9), pure. evidenceReport() puts together the
// inventory with its reviews, the controls with their status, evidence and clauses, the audit log's verify result and
// retention, the time and the ZAAFPulse version; toJson() and toMarkdown() write it out. No path leaves here: an
// item's project folders are dropped, and no other field holds one.
const { CLAUSES, FRAMEWORKS, NOTICE } = require('./controls');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
// The fields of an item the report keeps (its project folders, ~ paths for the dashboard, are not one of them).
const ITEM_FIELDS = [
  'id',
  'kind',
  'name',
  'vendor',
  'where',
  'state',
  'firstSeen',
  'lastSeen',
  'status',
  'review',
  'transport',
  'command',
  'package',
  'origin',
  'type',
  'ours',
  'clients',
];

// evidenceReport({ inventory: GET /api/governance/inventory, controls: GET /api/governance/controls, audit:
// { retentionMonths, degraded, lastVerify }, version, generatedAt }) -> the report (the JSON export as it is).
function evidenceReport({ inventory, controls, audit, version, generatedAt }) {
  const inv = isObj(inventory) ? inventory : {};
  const ctl = isObj(controls) ? controls : {};
  const a = isObj(audit) ? audit : {};
  return {
    title: 'ZAAFPulse governance evidence',
    notice: NOTICE,
    generatedAt,
    version: typeof version === 'string' ? version : null,
    frameworks: FRAMEWORKS,
    controls: arr(ctl.controls).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      evidence: Array.isArray(c.evidence) ? c.evidence : [],
      link: c.link,
      clauses: arr(c.clauses).map((x) => ({ framework: x.framework, ref: x.ref, title: x.title })),
    })),
    audit: {
      retentionMonths: a.retentionMonths,
      degraded: a.degraded || null,
      lastVerify: a.lastVerify || null,
    },
    inventory: {
      counts: isObj(inv.counts) ? inv.counts : {},
      failed: Array.isArray(inv.failed) ? inv.failed : [],
      items: arr(inv.items).map((it) =>
        Object.fromEntries(ITEM_FIELDS.filter((k) => it[k] !== undefined).map((k) => [k, it[k]])),
      ),
    },
  };
}

const toJson = (report) => `${JSON.stringify(report, null, 2)}\n`;

// A table cell: one line, its pipes escaped, no markup (an owner's note may hold anything).
const cell = (v) =>
  String(v === null || v === undefined || v === '' ? '—' : v)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;
const table = (head, rows) => [row(head), `|${head.map(() => '---').join('|')}|`, ...rows.map(row)].join('\n');

function verifyLine(v) {
  if (!v) return 'not verified yet';
  const at = v.at ? ` (${v.at})` : '';
  if (v.ok)
    return v.checked ? `chain intact, entries ${v.from}–${v.to} checked${at}` : `chain intact, no entries yet${at}`;
  if (v.reason === 'key missing') return `cannot be checked: the audit key is missing${at}`;
  return `broken at entry ${v.brokenAt}: ${v.reason}${at}`;
}

// The report as a readable Markdown document: the notice, the controls, the clauses by framework, the audit log and
// the inventory.
function toMarkdown(report) {
  const r = isObj(report) ? report : {};
  const controls = arr(r.controls);
  const items = arr(r.inventory && r.inventory.items);
  const counts = (r.inventory && r.inventory.counts) || {};
  const out = [
    `# ${r.title || 'ZAAFPulse governance evidence'}`,
    '',
    `Generated ${r.generatedAt} by ZAAFPulse ${r.version || ''}`.trim() + '.',
    '',
    `> ${r.notice || NOTICE}`,
    '',
    `Frameworks: ${arr(r.frameworks)
      .map((f) => `${f.name} (${f.version})`)
      .join('; ')}.`,
    '',
    '## Controls',
    '',
    table(
      ['Control', 'Status', 'Evidence', 'Clauses', 'Page'],
      controls.map((c) => [c.title, c.status, c.evidence.join('; '), c.clauses.map((x) => x.ref).join(', '), c.link]),
    ),
  ];
  // Each framework's clauses in their order, with the controls that show them.
  for (const f of arr(r.frameworks)) {
    const rows = [];
    for (const k of CLAUSES.filter((x) => x.framework === f.id))
      for (const c of controls)
        if (c.clauses.some((x) => x.framework === f.id && x.ref === k.ref))
          rows.push([`${k.ref} ${k.title}`, c.title, c.status]);
    out.push('', `## ${f.name} (${f.version})`, '', table(['Clause', 'Control', 'Status'], rows));
  }
  const a = r.audit || {};
  const writing = a.degraded
    ? `degraded since ${a.degraded.since}, ${a.degraded.missed} entries not written`
    : 'working';
  const gone = `${counts.gone || 0} reviews of items no longer seen`;
  out.push(
    '',
    '## Audit log',
    '',
    `- Kept: ${a.retentionMonths} months`,
    `- Last verify: ${verifyLine(a.lastVerify)}`,
    `- Writing: ${writing}`,
    '',
    '## AI inventory',
    '',
    `${counts.total || 0} items: ${counts.reviewed || 0} reviewed, ${counts.unreviewed || 0} unreviewed, ${gone}.`,
  );
  const failed = (r.inventory && r.inventory.failed) || [];
  if (failed.length) out.push('', `Sources that could not be read: ${failed.join(', ')}.`);
  out.push(
    '',
    table(
      [
        'Item',
        'Kind',
        'Vendor',
        'Where',
        'State',
        'First seen',
        'Last seen',
        'Owner',
        'Purpose',
        'Risk',
        'Decision',
        'Note',
      ],
      items.map((i) => {
        const v = i.review || {};
        return [
          `${i.name} (${i.id})`,
          i.kind,
          i.vendor,
          (i.where || []).join(', '),
          i.state,
          i.firstSeen,
          i.lastSeen,
          v.owner,
          v.purpose,
          v.risk,
          v.decision,
          v.note,
        ];
      }),
    ),
    '',
  );
  return out.join('\n');
}

module.exports = { evidenceReport, toJson, toMarkdown, ITEM_FIELDS };
```

- [ ] **Step 4: The route and its audit entry**

In `lib/governance/api.js`, replace

```js
//   POST /api/governance/inventory  { id, owner, purpose, risk, decision, note } | { id, clear: true }
//   GET  /api/governance/controls                                        the controls with status, evidence, clauses
// It also holds the daily pass (dailyPass), which reads the retention set here, and builds the inventory from the
// sources server.js gathers (the reviews are config.json "governance.inventory", the seen dates a store of their own).
```

with

```js
//   POST /api/governance/inventory  { id, owner, purpose, risk, decision, note } | { id, clear: true }
//   GET  /api/governance/controls                                        the controls with status, evidence, clauses
//   GET  /api/governance/evidence?format=json|md                         a download; recorded as governance.export
// It also holds the daily pass (dailyPass), which reads the retention set here, and builds the inventory from the
// sources server.js gathers (the reviews are config.json "governance.inventory", the seen dates a store of their own).
```

In `lib/governance/api.js`, replace

```js
const { buildInventory, cleanReview } = require('./inventory');
const { controls, CLAUSES, FRAMEWORKS, NOTICE } = require('./controls');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
```

with

```js
const { buildInventory, cleanReview } = require('./inventory');
const { controls, CLAUSES, FRAMEWORKS, NOTICE } = require('./controls');
const { evidenceReport, toJson, toMarkdown } = require('./evidence');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
```

In `lib/governance/api.js`, replace

```js
// sources(): a Promise of the inventory sources (lib/governance/inventory.js buildInventory); seen: { read(),
// write(map) } (lib/governance/seen.js). controlState(): a Promise of the parts of lib/governance/controls.js state
// that server.js reads (everything but now, audit and inventory, which come from here).
function createGovernanceApi({
  audit,
```

with

```js
// sources(): a Promise of the inventory sources (lib/governance/inventory.js buildInventory); seen: { read(),
// write(map) } (lib/governance/seen.js). controlState(): a Promise of the parts of lib/governance/controls.js state
// that server.js reads (everything but now, audit and inventory, which come from here). record(entry): the governance
// audit log with the request's actor (server.js govRecord), for the evidence export; version: ZAAFPulse's.
function createGovernanceApi({
  audit,
```

In `lib/governance/api.js`, replace

```js
  seen = { read: () => ({}), write: () => false },
  controlState = async () => ({}),
  now = Date.now,
  log = console.error,
```

with

```js
  seen = { read: () => ({}), write: () => false },
  controlState = async () => ({}),
  record = () => null,
  version = null,
  now = Date.now,
  log = console.error,
```

In `lib/governance/api.js`, replace

```js
  }
  // The controls: the state server.js reads, the audit log's state and retention, and the inventory's counts.
  async function controlsView() {
    const t = now();
    const [st, inv] = await Promise.all([controlState(), inventory()]);
    let auditState = null;
    try {
```

with

```js
  }
  // The controls: the state server.js reads, the audit log's state and retention, and the inventory's counts.
  async function controlsView(built = null) {
    const t = now();
    const [st, inv] = await Promise.all([controlState(), built || inventory()]);
    let auditState = null;
    try {
```

In `lib/governance/api.js`, replace

```js
    };
  }
  // A review saved into config.json governance.inventory (every save is a config.change entry), or cleared.
  function saveReview(body) {
```

with

```js
    };
  }
  // The evidence export: the inventory, the controls and the audit log's state, as JSON or Markdown. It is a GET, so no
  // request entry covers it: it is recorded as governance.export, with the format, before the answer.
  async function evidence(q) {
    const format = q.get('format') || 'json';
    if (format !== 'json' && format !== 'md') throw fail(400, 'format: json or md');
    const inv = await inventory();
    const ctl = await controlsView(inv);
    let st = {};
    try {
      st = audit.status() || {};
    } catch {
      st = {};
    }
    const report = evidenceReport({
      inventory: inv,
      controls: ctl,
      audit: { retentionMonths: retention(), degraded: st.degraded || null, lastVerify: st.lastVerify || null },
      version,
      generatedAt: ctl.generatedAt,
    });
    try {
      record({ action: 'governance.export', target: { type: 'evidence', id: format } });
    } catch {
      /* the audit log never stops the export (A6) */
    }
    const md = format === 'md';
    return {
      status: 200,
      body: md ? toMarkdown(report) : toJson(report),
      type: md ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
      headers: {
        'Content-Disposition': `attachment; filename="zaafpulse-evidence-${ctl.generatedAt.slice(0, 10)}.${format}"`,
      },
    };
  }
  // A review saved into config.json governance.inventory (every save is a config.change entry), or cleared.
  function saveReview(body) {
```

In `lib/governance/api.js`, replace

```js
    '/api/governance/inventory': async () => reply(200, await inventory()),
    '/api/governance/controls': async () => reply(200, await controlsView()),
  };
  const POST = {
```

with

```js
    '/api/governance/inventory': async () => reply(200, await inventory()),
    '/api/governance/controls': async () => reply(200, await controlsView()),
    '/api/governance/evidence': evidence,
  };
  const POST = {
```

In `lib/governance/api.js`, replace

```js
    lastCounts ? { newUnreviewed: lastCounts.newUnreviewed, newKinds: lastCounts.newKinds } : null;

  return { route, retention, dailyPass, inventory, inventoryStatus, controls: controlsView };
}
```

with

```js
    lastCounts ? { newUnreviewed: lastCounts.newUnreviewed, newKinds: lastCounts.newKinds } : null;

  return { route, retention, dailyPass, inventory, inventoryStatus, controls: () => controlsView() };
}
```

In `server.js`, replace

```js
  sources: () => inventorySources(),
  controlState: () => controlState(),
  seen: createSeenStore({ file: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'governance', 'seen.json') }),
});
```

with

```js
  sources: () => inventorySources(),
  controlState: () => controlState(),
  record: (e) => govRecord(e), // the evidence export (a GET), with the request's actor
  version: require('./package.json').version,
  seen: createSeenStore({ file: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'governance', 'seen.json') }),
});
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/governance-evidence.test.js test/governance-inventory-http.test.js test/governance-controls.test.js test/governance-inventory-api.test.js test/governance-api.test.js`
Expected: PASS (23 tests).

- [ ] **Step 6: Check the style**

Run: `npx prettier@3 --check lib/governance/evidence.js lib/governance/api.js test/governance-evidence.test.js test/governance-inventory-http.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath server.js < server.js | diff server.js - | grep -c '^[<>]'`
Expected: `7`

- [ ] **Step 7: Commit**

```bash
git add lib/governance/evidence.js lib/governance/api.js server.js test/governance-evidence.test.js test/governance-inventory-http.test.js
git commit -m "Governance compliance: export the evidence as Markdown or JSON, recorded as governance.export"
```

---
### Task 7: the Inventory and Compliance pages; the Audit log moves to `#governance/audit`

**Files:**
- Modify: `public/governanceview.js` (lines 1, 38, 193, 412, 501, 526, 584)
- Modify: `public/app.js` (lines 1149, 1346)
- Modify: `public/iso.js` (line 601)
- Modify: `public/index.html` (line 79)
- Modify: `public/styles.css` (line 10014) (appended)
- Modify: `test/governance-ui.test.js` (lines 14, 137, 163, 171, 177)
- Test: `test/governance-inventory-ui.test.js` (create)

**Interfaces:**
- Consumes: `GET|POST /api/governance/inventory` (Task 3), `GET /api/governance/controls` (Task 5), the evidence
  links (Task 6); the page helpers `esc`, `subHero`, `subTabs`, `$`, `api` of the other page scripts; the
  `cost-drawer`, `cost-drawer-backdrop`, `cost-drawer-head`, `cost-drawer-foot` and `cost-row` styles.
- Produces (`public/governanceview.js`): `govView(sub) → html`, `govMount(sub)` (app.js calls both with `state.sub`);
  exported pure helpers `GOV_SUBS`, `GOV_KINDS`, `govSub`, `govLabel`, `govInvFilter`, `govReviewTag`,
  `govInvRowsHtml`, `govInvSummaryHtml`, `govInvFiltersHtml`, `govReviewFormHtml`, `govReviewBody`, `govStatusTag`,
  `govLink`, `govCompHtml`, `govInvView`, `govCompView`, `govAuditView` (the Audit log page, which was `govView`).
- Produces (`public/iso.js`): `SUBPAGES.governance = [['', 'Inventory'], ['compliance', 'Compliance'], ['audit',
  'Audit log']]`.

- [ ] **Step 1: Write the failing test, and move the Audit log's assertions to its new hash**

Create `test/governance-inventory-ui.test.js`:

```js
// Governance → Inventory and Compliance in the browser file, without a browser (public/governanceview.js): the sub-page
// of a hash, the filters, the rows and their review tags, the summary with failed sources, the review drawer and the
// body it posts, the Compliance tables by framework with the export links; the menu, the sub-pages and the route; and
// every server or owner string escaped (S1).
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
const U = require('../public/governanceview');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const items = [
  {
    id: 'mcp:github',
    kind: 'mcp',
    name: 'github',
    vendor: null,
    where: ['Claude Code config', 'logs'],
    state: 'used',
    firstSeen: '2026-11-01',
    lastSeen: '2026-11-03',
    status: 'unreviewed',
    review: null,
    transport: 'stdio',
    command: 'npx',
    package: '@modelcontextprotocol/server-github',
    clients: ['Claude Code'],
    projects: ['~/code/shop'],
  },
  {
    id: 'provider:openai',
    kind: 'provider',
    name: 'openai',
    vendor: 'OpenAI',
    where: ['gateway'],
    state: 'configured',
    firstSeen: '2026-10-01',
    lastSeen: '2026-11-03',
    status: 'reviewed',
    review: { owner: 'Ana', purpose: 'chat', risk: 'limited', decision: 'approved', note: '', reviewedAt: null },
    origin: 'https://api.openai.com',
  },
  {
    id: 'key:key_old',
    kind: 'key',
    name: 'key:key_old',
    vendor: null,
    where: [],
    state: 'gone',
    firstSeen: '2026-09-01',
    lastSeen: '2026-09-30',
    status: 'gone',
    review: { owner: 'Ops', purpose: '', risk: 'high', decision: '', note: '', reviewedAt: null },
  },
];

test('sub-pages: Inventory by default, then Compliance and the Audit log', () => {
  assert.deepEqual(U.GOV_SUBS, [
    ['', 'Inventory'],
    ['compliance', 'Compliance'],
    ['audit', 'Audit log'],
  ]);
  assert.deepEqual(['', 'compliance', 'audit', 'nope', undefined].map(U.govSub), ['', 'compliance', 'audit', '', '']);
  assert.match(
    U.govView(''),
    /<nav class="subtabs">governance<\/nav><div class="hero">GOVERNANCE · INVENTORY\|AI inventory\|/,
  );
  assert.match(
    U.govView('compliance'),
    /GOVERNANCE · COMPLIANCE\|Compliance\|Evidence for your assessment, not a certification:/,
  );
  assert.match(U.govView('audit'), /<nav class="subtabs">governance<\/nav><div class="hero">GOVERNANCE · AUDIT LOG\|/);
  assert.match(U.govView('x'), /GOVERNANCE · INVENTORY/);
  assert.match(U.govInvView(), /<tbody id="gov-inv-rows"><\/tbody>/);
  assert.match(U.govInvView(), /<div id="gov-review-host"><\/div>/);
});

test('inventory: the filters, the rows with their review, and the summary', () => {
  assert.deepEqual(
    U.govInvFilter(items, { kind: '', state: '', review: 'unreviewed' }).map((i) => i.id),
    ['mcp:github'],
  );
  assert.deepEqual(
    U.govInvFilter(items, { kind: 'provider', state: 'configured', review: '' }).map((i) => i.id),
    ['provider:openai'],
  );
  assert.equal(U.govInvFilter(items, { kind: '', state: 'gone', review: 'gone' }).length, 1);
  const rows = U.govInvRowsHtml(items);
  assert.match(
    rows,
    /<b>github<\/b><div class="muted mono gov-id">mcp:github<\/div><div class="muted">@modelcontextprotocol\/server-github<\/div>/,
  );
  assert.match(rows, /<td>MCP server<\/td><td>Claude Code config, logs<\/td><td>Used<\/td>/);
  assert.match(rows, /<span class="tag warn">Unreviewed<\/span>/);
  assert.match(rows, /<span class="tag">Limited · Approved<\/span><div class="muted">Ana<\/div>/);
  assert.match(rows, /<span class="tag warn">Gone · High<\/span>/);
  assert.match(rows, /data-gov-review="mcp:github">Review</);
  assert.match(rows, /data-gov-review="provider:openai">Edit</);
  assert.match(U.govInvRowsHtml([]), /No items for these filters\./);
  const sum = U.govInvSummaryHtml({
    counts: { total: 2, reviewed: 1, unreviewed: 1, newUnreviewed: 1, gone: 1 },
    failed: ['gateway', 'mcp'],
    clients: [{ client: 'zed', name: 'Zed', file: '~/.config/zed/settings.json', state: 'unreadable', servers: 0 }],
  });
  assert.match(sum, /Could not read the gateway, the AI clients&#39; MCP settings; the list is built from the rest\./);
  assert.match(sum, /MCP settings that could not be read: Zed \(~\/\.config\/zed\/settings\.json\)\./);
  assert.match(
    sum,
    /<p class="gov-summary">2 items · 1 reviewed · 1 unreviewed · 1 new this week and not reviewed · 1 reviews of items no longer seen<\/p>/,
  );
  assert.ok(!U.govInvSummaryHtml({ counts: {}, failed: [], clients: [] }).includes('gov-banner'));
  const f = U.govInvFiltersHtml({ kind: 'mcp', state: '', review: 'gone' });
  assert.match(f, /<form id="gov-inv-filters" class="gov-bar">/);
  assert.match(f, /<option value="mcp" selected>MCP server<\/option>/);
  assert.match(f, /<option value="gone" selected>Gone<\/option>/);
  assert.match(f, /<option value="">Any state<\/option>/);
});

test('review drawer: what is known of the item, the fields, Clear only when reviewed; the body it posts', () => {
  const html = U.govReviewFormHtml(items[0]);
  assert.match(html, /<form id="gov-review" novalidate data-gov-id="mcp:github">/);
  assert.match(html, /<dt>Package<\/dt><dd>@modelcontextprotocol\/server-github<\/dd>/);
  assert.match(html, /<dt>Projects<\/dt><dd>~\/code\/shop<\/dd>/);
  assert.match(html, /name="owner" maxlength="200" value=""/);
  assert.match(html, /<option value="unacceptable">Unacceptable<\/option>/);
  assert.match(html, /The decision is a record: blocking a system stays with API keys and the guardrails\./);
  assert.ok(!html.includes('data-gov-clear'), 'nothing to clear yet');
  const edit = U.govReviewFormHtml(items[1]);
  assert.match(edit, /name="owner" maxlength="200" value="Ana"/);
  assert.match(edit, /<option value="limited" selected>Limited<\/option>/);
  assert.match(edit, /<option value="approved" selected>Approved<\/option>/);
  assert.match(edit, /data-gov-clear>Clear review</);
  const form = { owner: ' Ana ', purpose: 'chat', risk: 'high', decision: '', note: null };
  assert.deepEqual(
    U.govReviewBody('mcp:github', (k) => form[k]),
    {
      id: 'mcp:github',
      owner: 'Ana',
      purpose: 'chat',
      risk: 'high',
      decision: '',
      note: '',
    },
  );
});

test('compliance: one table per framework with its clauses in order, the counts and the export links', () => {
  const d = {
    notice: 'Evidence for your assessment, not a certification.',
    frameworks: [
      {
        id: 'eu-ai-act',
        name: 'EU AI Act',
        version: 'Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744',
      },
      { id: 'iso-42001', name: 'ISO/IEC 42001', version: 'ISO/IEC 42001:2023' },
    ],
    clauses: [
      { id: 'eu-12', framework: 'eu-ai-act', ref: 'Art. 12', title: 'Record-keeping' },
      { id: 'eu-14', framework: 'eu-ai-act', ref: 'Art. 14', title: 'Human oversight' },
      { id: 'iso-a6', framework: 'iso-42001', ref: 'A.6', title: 'AI system life cycle' },
    ],
    controls: [
      {
        id: 'agent_control',
        title: 'Pause and stop an agent',
        status: 'off',
        evidence: ['agent control is off on this server'],
        link: '#settings/monitors',
        clauses: [{ id: 'eu-14' }],
      },
      {
        id: 'audit_log',
        title: 'Governance audit log',
        status: 'in place',
        evidence: ['kept 12 months (at least 6)', 'not verified yet'],
        link: 'javascript:alert(1)',
        clauses: [{ id: 'eu-12' }, { id: 'iso-a6' }],
      },
    ],
  };
  const html = U.govCompHtml(d);
  assert.match(html, /1 in place · 0 partial · 1 off/);
  assert.match(html, /href="\/api\/governance\/evidence\?format=md" download>Export Markdown</);
  assert.match(html, /href="\/api\/governance\/evidence\?format=json" download>Export JSON</);
  assert.match(
    html,
    /<h3>EU AI Act<\/h3><span class="meta">Regulation \(EU\) 2024\/1689 as amended by Regulation \(EU\) 2026\/1744<\/span>/,
  );
  assert.ok(html.indexOf('Art. 12') < html.indexOf('Art. 14'), 'clauses in their order');
  assert.match(
    html,
    /<td><b>Art\. 14<\/b> Human oversight<\/td><td><a href="#settings\/monitors">Pause and stop an agent<\/a><\/td><td><span class="tag warn">Off<\/span><\/td><td>agent control is off on this server<\/td>/,
  );
  assert.match(
    html,
    /<a href="#governance">Governance audit log<\/a><\/td><td><span class="tag">In place<\/span><\/td><td>kept 12 months \(at least 6\) · not verified yet<\/td>/,
  );
  assert.ok(!html.includes('javascript:'), 'a link is a dashboard hash or the Governance page');
  assert.doesNotMatch(html, /complian/i);
});

test('wiring: three sub-links in the menu, the sub-pages in iso.js, the route with its sub-page', () => {
  const html = read('index.html');
  assert.match(
    html,
    /<a href="#governance" data-route="governance"><span data-icon="shield"><\/span>Governance<\/a>\s*<a class="nav-sub" href="#governance" data-route="governance\/">Inventory<\/a>\s*<a class="nav-sub" href="#governance\/compliance" data-route="governance\/compliance">Compliance<\/a>\s*<a class="nav-sub" href="#governance\/audit" data-route="governance\/audit">Audit log<\/a>/,
  );
  assert.match(
    read('iso.js'),
    /governance: \[\s*\['', 'Inventory'\],\s*\['compliance', 'Compliance'\],\s*\['audit', 'Audit log'\],\s*\],/,
  );
  assert.match(read('app.js'), /el\.innerHTML = govView\(state\.sub\);\s*return govMount\(state\.sub\);/);
  const css = read('styles.css');
  for (const c of ['.gov-summary', '.gov-id', '.gov-facts']) assert.ok(css.includes(c), c);
});

test('S1: no server or owner string reaches the inventory or compliance markup unescaped', () => {
  const x = '<x>';
  const item = {
    id: x,
    kind: x,
    name: x,
    vendor: x,
    where: [x],
    state: x,
    firstSeen: x,
    lastSeen: x,
    status: 'reviewed',
    review: { owner: x, purpose: x, risk: x, decision: x, note: x, reviewedAt: x },
    transport: x,
    command: x,
    package: x,
    origin: x,
    clients: [x],
    projects: [x],
  };
  const html = [
    U.govInvRowsHtml([item, { ...item, status: 'unreviewed' }, { ...item, status: 'gone' }]),
    U.govInvSummaryHtml({ counts: { total: x }, failed: [x], clients: [{ name: x, file: x, state: 'unreadable' }] }),
    U.govInvFiltersHtml({ kind: x, state: x, review: x }),
    U.govReviewFormHtml(item),
    U.govCompHtml({
      notice: x,
      frameworks: [{ id: x, name: x, version: x }],
      clauses: [{ id: x, framework: x, ref: x, title: x }],
      controls: [{ id: x, title: x, status: x, evidence: [x], link: x, clauses: [{ id: x }] }],
    }),
  ].join('');
  assert.ok(!html.includes('<x>'), 'a field reached the markup unescaped');
});
```

In `test/governance-ui.test.js`, replace

```js
  );
global.subHero = (eyebrow, title, sub) => `<div class="hero">${eyebrow}|${title}|${sub}</div>`;
const U = require('../public/governanceview');
```

with

```js
  );
global.subHero = (eyebrow, title, sub) => `<div class="hero">${eyebrow}|${title}|${sub}</div>`;
global.subTabs = (route) => `<nav class="subtabs">${route}</nav>`;
const U = require('../public/governanceview');
```

In `test/governance-ui.test.js`, replace

```js
  assert.match(form, /<option value="rule" selected>Monitors rule<\/option>/);
  assert.match(form, /value="&quot;&gt;&lt;x"/);
  assert.match(U.govView(), /GOVERNANCE · AUDIT LOG\|Audit log\|/);
});
```

with

```js
  assert.match(form, /<option value="rule" selected>Monitors rule<\/option>/);
  assert.match(form, /value="&quot;&gt;&lt;x"/);
  assert.match(U.govView('audit'), /GOVERNANCE · AUDIT LOG\|Audit log\|/);
});
```

In `test/governance-ui.test.js`, replace

```js
  assert.ok(!odd.includes('<x>'), 'escaped');
  assert.match(
    U.govView(),
    /\|Changes made through the dashboard and by API keys: who, when, what and the outcome\. Read requests are not recorded; see docs\/governance\.md for the full list\.<\/div>/,
  );
```

with

```js
  assert.ok(!odd.includes('<x>'), 'escaped');
  assert.match(
    U.govView('audit'),
    /\|Changes made through the dashboard and by API keys: who, when, what and the outcome\. Read requests are not recorded; see docs\/governance\.md for the full list\.<\/div>/,
  );
```

In `test/governance-ui.test.js`, replace

```js
  const html = read('index.html');
  assert.match(html, /<div class="nav-label">GOVERNANCE<\/div>\s*<a href="#governance" data-route="governance">/);
  assert.match(html, /<a class="nav-sub" href="#governance" data-route="governance\/">Audit log<\/a>/);
  assert.ok(html.indexOf('governanceview.js') > html.indexOf('costreports.js'));
  assert.ok(html.indexOf('governanceview.js') < html.indexOf('src="app.js"'));
```

with

```js
  const html = read('index.html');
  assert.match(html, /<div class="nav-label">GOVERNANCE<\/div>\s*<a href="#governance" data-route="governance">/);
  assert.match(html, /<a class="nav-sub" href="#governance\/audit" data-route="governance\/audit">Audit log<\/a>/);
  assert.ok(html.indexOf('governanceview.js') > html.indexOf('costreports.js'));
  assert.ok(html.indexOf('governanceview.js') < html.indexOf('src="app.js"'));
```

In `test/governance-ui.test.js`, replace

```js
  assert.match(app, /governance: 'GOVERNANCE',/);
  assert.match(app, /governance: govView,/);
  assert.match(app, /if \(state\.route === 'governance'\) \{\s*el\.innerHTML = govView\(\);\s*return govMount\(\);/);
  assert.match(app, /state\.route !== 'governance' &&/);
  assert.ok(read('styles.css').includes('.gov-banner'));
```

with

```js
  assert.match(app, /governance: 'GOVERNANCE',/);
  assert.match(app, /governance: govView,/);
  assert.match(
    app,
    /if \(state\.route === 'governance'\) \{\s*el\.innerHTML = govView\(state\.sub\);\s*return govMount\(state\.sub\);/,
  );
  assert.match(app, /state\.route !== 'governance' &&/);
  assert.ok(read('styles.css').includes('.gov-banner'));
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/governance-inventory-ui.test.js test/governance-ui.test.js`
Expected: FAIL (7 of 14: the six new tests, and the wiring test of `test/governance-ui.test.js` (the sub-link and the route)).

- [ ] **Step 3: The pages**

In `public/governanceview.js`, replace

```js
'use strict';
/* Governance → Audit log (#governance, AI Governance 2): every change made to ZAAFPulse by a person or an API key,
   from GET /api/governance/audit (newest first, a page at a time). Filters: the range, the kind of actor, action text
   and the outcome. Each row's field changes open in a <details>. Verify checks the chain (GET …/audit/verify), the
   export links download CSV or JSON lines, and the retention is saved with POST /api/governance/settings. Events are
   delegated (the CSP allows no inline handler); pure helpers are exported for Node tests, and nothing here touches the
   DOM at load time. Every server or owner string reaches the markup through esc(). */

const GOV_RANGES = [
```

with

```js
'use strict';
/* The Governance menu's three pages (AI Governance 2 and 3).
   - Inventory (#governance): every AI system ZAAFPulse can see, from GET /api/governance/inventory, filtered by kind,
     state and review in the page; a drawer records an item's owner, purpose, risk and decision (POST
     /api/governance/inventory).
   - Compliance (#governance/compliance): the controls from GET /api/governance/controls, one table per framework, and
     the evidence export (GET /api/governance/evidence?format=md|json).
   - Audit log (#governance/audit): every change made to ZAAFPulse by a person or an API key, from GET
     /api/governance/audit (newest first, a page at a time). Filters: the range, the kind of actor, action text and the
     outcome. Each row's field changes open in a <details>. Verify checks the chain (GET …/audit/verify), the export
     links download CSV or JSON lines, and the retention is saved with POST /api/governance/settings.
   Events are delegated (the CSP allows no inline handler); pure helpers are exported for Node tests, and nothing here
   touches the DOM at load time. Every server or owner string reaches the markup through esc(). */

const GOV_RANGES = [
```

In `public/governanceview.js`, replace

```js
  next: null,
  hooked: false,
};
```

with

```js
  next: null,
  hooked: false,
  inv: { filters: { kind: '', state: '', review: '' }, data: null, open: null },
};
```

In `public/governanceview.js`, replace

```js
}

/* ---------- the page ---------- */

function govView() {
  return `<div class="holo-deck">${subHero('GOVERNANCE · AUDIT LOG', 'Audit log', esc('Changes made through the dashboard and by API keys: who, when, what and the outcome. Read requests are not recorded; see docs/governance.md for the full list.'))}<div id="gov-app">
    <section class="holo panel"><div class="panel-head"><h3>${esc('Audit log')}</h3><span class="meta">${esc('kept by month, chained')}</span></div><div id="gov-status"><div class="skeleton" style="height:40px"></div></div>${govFiltersHtml(GOV.filters)}<div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Time')}</th><th>${esc('Actor')}</th><th>${esc('Action')}</th><th>${esc('Target')}</th><th>${esc('Outcome')}</th></tr></thead><tbody id="gov-rows"></tbody></table></div><div id="gov-more"></div></section>
  </div></div>`;
```

with

```js
}

/* ---------- Inventory and Compliance (AI Governance 3): pure helpers (exported) ---------- */

const GOV_SUBS = [
  ['', 'Inventory'],
  ['compliance', 'Compliance'],
  ['audit', 'Audit log'],
];
const GOV_KINDS = [
  ['app', 'App'],
  ['mcp', 'MCP server'],
  ['provider', 'Provider'],
  ['model', 'Model'],
  ['agent', 'Agent'],
  ['skill', 'Skill'],
  ['workflow', 'Workflow'],
  ['knowledge', 'Knowledge base'],
  ['runtime', 'Local runtime'],
  ['integration', 'Integration'],
  ['key', 'API key'],
];
const GOV_STATES = [
  ['running', 'Running'],
  ['used', 'Used'],
  ['configured', 'Configured'],
  ['idle', 'Idle'],
  ['gone', 'Gone'],
];
const GOV_REVIEWS = [
  ['unreviewed', 'Unreviewed'],
  ['reviewed', 'Reviewed'],
  ['gone', 'Gone'],
];
const GOV_RISKS = [
  ['', '—'],
  ['minimal', 'Minimal'],
  ['limited', 'Limited'],
  ['high', 'High'],
  ['unacceptable', 'Unacceptable'],
];
const GOV_DECISIONS = [
  ['', '—'],
  ['approved', 'Approved'],
  ['restricted', 'Restricted'],
  ['blocked', 'Blocked'],
];
// The inventory's sources, in words, for "could not read …".
const GOV_SOURCES = {
  live: 'the running apps',
  summary: 'the indexed logs',
  trace: 'the trace sources',
  gateway: 'the gateway',
  runtimes: 'the local runtimes',
  integrations: 'the integrations',
  mcp: "the AI clients' MCP settings",
};
const GOV_STATUS_WORDS = { 'in place': 'In place', partial: 'Partial', off: 'Off' };

/** The Governance sub-page of a hash: '' (Inventory), 'compliance' or 'audit'; anything else is ''. */
const govSub = (sub) => (GOV_SUBS.some(([s]) => s && s === sub) ? sub : '');
/** A value's label in one of the [value, label] lists; the value itself when it is not listed. */
const govLabel = (list, v) => (list.find(([k]) => k === v) || [v, String(v ?? '')])[1];
/** The items the filters keep: { kind, state, review } ('' keeps all). */
function govInvFilter(items, f) {
  return (Array.isArray(items) ? items : []).filter(
    (i) => (!f.kind || i.kind === f.kind) && (!f.state || i.state === f.state) && (!f.review || i.status === f.review),
  );
}
/** An item's review as a tag: Unreviewed, or its risk and decision (Gone in front when the item is no longer seen). */
function govReviewTag(i) {
  if (i.status === 'unreviewed') return `<span class="tag warn">${esc('Unreviewed')}</span>`;
  const r = i.review || {};
  const words = [r.risk ? govLabel(GOV_RISKS, r.risk) : '', r.decision ? govLabel(GOV_DECISIONS, r.decision) : '']
    .filter(Boolean)
    .join(' · ');
  const text = i.status === 'gone' ? ['Gone', words].filter(Boolean).join(' · ') : words || 'Reviewed';
  return `<span class="tag${i.status === 'gone' ? ' warn' : ''}">${esc(text)}</span>`;
}
/** The inventory's rows. */
function govInvRowsHtml(items) {
  if (!items.length) return `<tr><td colspan="7" class="muted">${esc('No items for these filters.')}</td></tr>`;
  return items
    .map((i) => {
      const detail = [i.vendor, i.package, i.origin, i.ours ? 'this ZAAFPulse' : ''].filter(Boolean).join(' · ');
      const owner = i.review && i.review.owner ? `<div class="muted">${esc(i.review.owner)}</div>` : '';
      return `<tr><td><b>${esc(i.name)}</b><div class="muted mono gov-id">${esc(i.id)}</div>${detail ? `<div class="muted">${esc(detail)}</div>` : ''}</td><td>${esc(govLabel(GOV_KINDS, i.kind))}</td><td>${esc((i.where || []).join(', ') || '—')}</td><td>${esc(govLabel(GOV_STATES, i.state))}</td><td class="mono">${esc(i.firstSeen || '—')}<br>${esc(i.lastSeen || '—')}</td><td>${govReviewTag(i)}${owner}</td><td><button class="btn ghost" type="button" data-gov-review="${esc(i.id)}">${esc(i.status === 'unreviewed' ? 'Review' : 'Edit')}</button></td></tr>`;
    })
    .join('');
}
/** The inventory's counts, the sources that failed and the client files that could not be read. */
function govInvSummaryHtml(d) {
  const c = d.counts || {};
  const parts = [
    `${c.total || 0} items`,
    `${c.reviewed || 0} reviewed`,
    `${c.unreviewed || 0} unreviewed`,
    `${c.newUnreviewed || 0} new this week and not reviewed`,
    ...(c.gone ? [`${c.gone} reviews of items no longer seen`] : []),
  ];
  const failed = (d.failed || []).map((s) => GOV_SOURCES[s] || s);
  const unreadable = (d.clients || []).filter((x) => x.state === 'unreadable');
  return `${failed.length ? `<div class="gov-banner">${esc(`Could not read ${failed.join(', ')}; the list is built from the rest.`)}</div>` : ''}${unreadable.length ? `<div class="gov-banner">${esc(`MCP settings that could not be read: ${unreadable.map((x) => `${x.name} (${x.file})`).join(', ')}.`)}</div>` : ''}<p class="gov-summary">${esc(parts.join(' · '))}</p>`;
}
/** The inventory's filters: kind, state and review. */
function govInvFiltersHtml(f) {
  const select = (name, any, list) =>
    `<select class="input" name="${name}"><option value="">${esc(any)}</option>${list.map(([v, label]) => `<option value="${esc(v)}"${v === f[name] ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  return `<form id="gov-inv-filters" class="gov-bar">
    <label>${esc('Kind')}${select('kind', 'Any kind', GOV_KINDS)}</label>
    <label>${esc('State')}${select('state', 'Any state', GOV_STATES)}</label>
    <label>${esc('Review')}${select('review', 'Any review', GOV_REVIEWS)}</label>
  </form>`;
}
/** The review drawer of one item: what is known of it, then owner, purpose, risk, decision and note. */
function govReviewFormHtml(i) {
  const r = i.review || {};
  const opt = (list, v) =>
    list
      .map(([k, label]) => `<option value="${esc(k)}"${k === (v || '') ? ' selected' : ''}>${esc(label)}</option>`)
      .join('');
  const facts = [
    ['Kind', govLabel(GOV_KINDS, i.kind)],
    ['Vendor', i.vendor],
    ['Where', (i.where || []).join(', ')],
    ['State', govLabel(GOV_STATES, i.state)],
    ['First seen', i.firstSeen],
    ['Last seen', i.lastSeen],
    ['Transport', i.transport],
    ['Command', i.command],
    ['Package', i.package],
    ['Address', i.origin],
    ['Clients', (i.clients || []).join(', ')],
    ['Projects', (i.projects || []).join(', ')],
    ['Reviewed', r.reviewedAt ? govTime(r.reviewedAt) : ''],
  ].filter(([, v]) => v);
  return `<div class="cost-drawer-backdrop" data-gov-close></div>
  <aside class="cost-drawer holo-deck" role="dialog" aria-modal="true" aria-labelledby="gov-review-title">
    <form id="gov-review" novalidate data-gov-id="${esc(i.id)}">
      <div class="cost-drawer-head"><h2 id="gov-review-title">${esc(i.name)}</h2><button type="button" class="btn ghost" data-gov-close aria-label="Close">×</button></div>
      <p class="muted mono">${esc(i.id)}</p>
      <dl class="gov-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <label>${esc('Owner')}<input class="input" name="owner" maxlength="200" value="${esc(r.owner || '')}" autocomplete="off"></label>
      <label>${esc('Purpose')}<input class="input" name="purpose" maxlength="200" value="${esc(r.purpose || '')}" autocomplete="off"></label>
      <div class="cost-row"><label>${esc('Risk (EU AI Act tier)')}<select class="input" name="risk">${opt(GOV_RISKS, r.risk)}</select></label><label>${esc('Decision')}<select class="input" name="decision">${opt(GOV_DECISIONS, r.decision)}</select></label></div>
      <label>${esc('Note')}<textarea class="input" name="note" maxlength="200" rows="3">${esc(r.note || '')}</textarea></label>
      <p class="muted">${esc('The decision is a record: blocking a system stays with API keys and the guardrails.')}</p>
      <div id="gov-review-msg" role="alert"></div>
      <div class="cost-drawer-foot"><button class="btn" type="submit">${esc('Save')}</button>${i.review ? `<button class="btn ghost" type="button" data-gov-clear>${esc('Clear review')}</button>` : ''}<button class="btn ghost" type="button" data-gov-close>${esc('Cancel')}</button></div>
    </form>
  </aside>`;
}
/** The body of POST /api/governance/inventory from the review form's fields. */
function govReviewBody(id, get) {
  const text = (k) => String(get(k) ?? '').trim();
  return {
    id,
    owner: text('owner'),
    purpose: text('purpose'),
    risk: text('risk'),
    decision: text('decision'),
    note: text('note'),
  };
}
/** A control's status as a tag. */
const govStatusTag = (s) =>
  `<span class="tag${s === 'in place' ? '' : ' warn'}">${esc(GOV_STATUS_WORDS[s] || s)}</span>`;
/** A control's page: a dashboard hash, else the Governance page. */
const govLink = (l) => (typeof l === 'string' && /^#[a-z0-9/-]+$/.test(l) ? l : '#governance');
/** The Compliance page's body: the counts, the export links, the notice, then one table per framework, its clauses in
 * order, each with the controls that show it. */
function govCompHtml(d) {
  const list = d.controls || [];
  const n = (s) => list.filter((c) => c.status === s).length;
  const head = `<div class="gov-bar"><span class="gov-summary">${esc(`${n('in place')} in place · ${n('partial')} partial · ${n('off')} off`)}</span><a class="btn ghost" href="/api/governance/evidence?format=md" download>${esc('Export Markdown')}</a><a class="btn ghost" href="/api/governance/evidence?format=json" download>${esc('Export JSON')}</a><p class="muted gov-note">${esc(d.notice || '')}</p></div>`;
  const sections = (d.frameworks || []).map((f) => {
    const rows = [];
    for (const k of (d.clauses || []).filter((x) => x.framework === f.id))
      for (const c of list)
        if ((c.clauses || []).some((x) => x.id === k.id))
          rows.push(
            `<tr><td><b>${esc(k.ref)}</b> ${esc(k.title)}</td><td><a href="${esc(govLink(c.link))}">${esc(c.title)}</a></td><td>${govStatusTag(c.status)}</td><td>${esc((c.evidence || []).join(' · '))}</td></tr>`,
          );
    return `<section class="holo panel"><div class="panel-head"><h3>${esc(f.name)}</h3><span class="meta">${esc(f.version)}</span></div><div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Clause')}</th><th>${esc('Control')}</th><th>${esc('Status')}</th><th>${esc('Evidence')}</th></tr></thead><tbody>${rows.join('') || `<tr><td colspan="4" class="muted">${esc('No control maps here.')}</td></tr>`}</tbody></table></div></section>`;
  });
  return head + sections.join('');
}

/* ---------- the pages ---------- */

/** Governance → Audit log (#governance/audit). */
function govAuditView() {
  return `<div class="holo-deck">${subTabs('governance')}${subHero('GOVERNANCE · AUDIT LOG', 'Audit log', esc('Changes made through the dashboard and by API keys: who, when, what and the outcome. Read requests are not recorded; see docs/governance.md for the full list.'))}<div id="gov-app">
    <section class="holo panel"><div class="panel-head"><h3>${esc('Audit log')}</h3><span class="meta">${esc('kept by month, chained')}</span></div><div id="gov-status"><div class="skeleton" style="height:40px"></div></div>${govFiltersHtml(GOV.filters)}<div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Time')}</th><th>${esc('Actor')}</th><th>${esc('Action')}</th><th>${esc('Target')}</th><th>${esc('Outcome')}</th></tr></thead><tbody id="gov-rows"></tbody></table></div><div id="gov-more"></div></section>
  </div></div>`;
```

In `public/governanceview.js`, replace

```js
  }
}
function govMount() {
  govInstallEvents();
  govLoadStatus();
  govLoadRows();
}
function govInstallEvents() {
```

with

```js
  }
}
/** Governance → Inventory (#governance). */
function govInvView() {
  return `<div class="holo-deck">${subTabs('governance')}${subHero('GOVERNANCE · INVENTORY', 'AI inventory', esc('Every AI system ZAAFPulse can see here: apps, the MCP servers in your AI clients, providers and models, agents, skills, workflows, knowledge bases, local runtimes, integrations and API keys. Record who owns each one, what it is for, its risk and your decision.'))}<div id="gov-app">
    <section class="holo panel"><div class="panel-head"><h3>${esc('Inventory')}</h3><span class="meta">${esc('built when you open it')}</span></div><div id="gov-inv-summary"><div class="skeleton" style="height:40px"></div></div>${govInvFiltersHtml(GOV.inv.filters)}<div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Item')}</th><th>${esc('Kind')}</th><th>${esc('Where')}</th><th>${esc('State')}</th><th>${esc('First / last seen')}</th><th>${esc('Review')}</th><th></th></tr></thead><tbody id="gov-inv-rows"></tbody></table></div></section>
    <div id="gov-review-host"></div>
  </div></div>`;
}
/** Governance → Compliance (#governance/compliance). */
function govCompView() {
  return `<div class="holo-deck">${subTabs('governance')}${subHero('GOVERNANCE · COMPLIANCE', 'Compliance', esc('Evidence for your assessment, not a certification: the controls ZAAFPulse provides, their status from your current settings, and the clauses of the EU AI Act, the NIST AI RMF and ISO/IEC 42001 they map to.'))}<div id="gov-app"><div id="gov-comp"><div class="skeleton" style="height:240px"></div></div></div></div>`;
}
/** The page of a Governance sub-page ('' Inventory, 'compliance', 'audit'). */
function govView(sub) {
  const s = govSub(sub);
  return s === 'audit' ? govAuditView() : s === 'compliance' ? govCompView() : govInvView();
}
async function govLoadInv() {
  const body = $('#gov-inv-rows');
  if (!body) return;
  try {
    GOV.inv.data = await api('/api/governance/inventory');
    govPaintInv();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7">${esc(`Could not read the inventory: ${e.message}`)}</td></tr>`;
  }
}
function govPaintInv() {
  const d = GOV.inv.data;
  if (!d) return;
  const sum = $('#gov-inv-summary');
  if (sum) sum.innerHTML = govInvSummaryHtml(d);
  const body = $('#gov-inv-rows');
  if (body) body.innerHTML = govInvRowsHtml(govInvFilter(d.items, GOV.inv.filters));
}
async function govLoadComp() {
  const el = $('#gov-comp');
  if (!el) return;
  try {
    el.innerHTML = govCompHtml(await api('/api/governance/controls'));
  } catch (e) {
    el.innerHTML = `<div class="gov-banner">${esc(`Could not read the controls: ${e.message}`)}</div>`;
  }
}
function govOpenReview(id) {
  const host = $('#gov-review-host');
  const item = GOV.inv.data && GOV.inv.data.items.find((i) => i.id === id);
  if (!host || !item) return;
  GOV.inv.open = id;
  host.innerHTML = govReviewFormHtml(item);
  const first = host.querySelector('input[name="owner"]');
  if (first) first.focus();
}
function govCloseReview() {
  GOV.inv.open = null;
  const host = $('#gov-review-host');
  if (host) host.replaceChildren();
}
async function govSaveReview(body) {
  try {
    await api('/api/governance/inventory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = $('#gov-review-msg');
    if (msg) msg.textContent = `Not saved: ${govErrorText(err)}`;
    return;
  }
  govCloseReview();
  govLoadInv();
}
function govMount(sub) {
  govInstallEvents();
  const s = govSub(sub);
  if (s === 'audit') {
    govLoadStatus();
    govLoadRows();
  } else if (s === 'compliance') govLoadComp();
  else govLoadInv();
}
function govInstallEvents() {
```

In `public/governanceview.js`, replace

```js
    e.preventDefault();
    const data = new FormData(form);
    if (form.id === 'gov-filters') {
      GOV.filters = {
        range: String(data.get('range') || '7'),
```

with

```js
    e.preventDefault();
    const data = new FormData(form);
    if (form.id === 'gov-review') {
      govSaveReview(govReviewBody(form.dataset.govId, (k) => data.get(k)));
    } else if (form.id === 'gov-filters') {
      GOV.filters = {
        range: String(data.get('range') || '7'),
```

In `public/governanceview.js`, replace

```js
    }
  });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest && e.target.closest('#gov-app [data-gov-verify], #gov-app [data-gov-more]');
    if (!t) return;
    if (t.hasAttribute('data-gov-more')) return void govLoadRows(true);
    const out = $('#gov-verify');
    if (out) out.textContent = 'Checking…';
```

with

```js
    }
  });
  // The inventory's filters apply as they change, on the list already loaded.
  document.addEventListener('change', (e) => {
    const form = e.target && e.target.closest && e.target.closest('#gov-inv-filters');
    if (!form) return;
    const data = new FormData(form);
    GOV.inv.filters = {
      kind: String(data.get('kind') || ''),
      state: String(data.get('state') || ''),
      review: String(data.get('review') || ''),
    };
    govPaintInv();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && GOV.inv.open) govCloseReview();
  });
  document.addEventListener('click', async (e) => {
    const t =
      e.target.closest &&
      e.target.closest(
        '#gov-app [data-gov-verify], #gov-app [data-gov-more], #gov-app [data-gov-review], #gov-app [data-gov-close], #gov-app [data-gov-clear]',
      );
    if (!t) return;
    if (t.hasAttribute('data-gov-more')) return void govLoadRows(true);
    if (t.hasAttribute('data-gov-review')) return void govOpenReview(t.getAttribute('data-gov-review'));
    if (t.hasAttribute('data-gov-close')) return void govCloseReview();
    if (t.hasAttribute('data-gov-clear')) return void govSaveReview({ id: GOV.inv.open, clear: true });
    const out = $('#gov-verify');
    if (out) out.textContent = 'Checking…';
```

In `public/governanceview.js`, replace

```js
    govFiltersHtml,
    govView,
  };
```

with

```js
    govFiltersHtml,
    govView,
    govAuditView,
    GOV_SUBS,
    GOV_KINDS,
    govSub,
    govLabel,
    govInvFilter,
    govReviewTag,
    govInvRowsHtml,
    govInvSummaryHtml,
    govInvFiltersHtml,
    govReviewFormHtml,
    govReviewBody,
    govStatusTag,
    govLink,
    govCompHtml,
    govInvView,
    govCompView,
  };
```

- [ ] **Step 4: The route, the sub-pages, the menu and the styles**

In `public/app.js`, replace

```js
  unmountStages();
  if (state.route === 'settings') return viewSettings(el);
  // Governance → Audit log loads its own data (public/governanceview.js): it never waits for the summary.
  if (state.route === 'governance') {
    el.innerHTML = govView();
    return govMount();
  }
  if (!state.data && !['live', 'brain', 'integrations', 'trace', 'datasets', 'cost'].includes(state.route)) {
```

with

```js
  unmountStages();
  if (state.route === 'settings') return viewSettings(el);
  // The Governance pages (Inventory, Compliance, Audit log) load their own data (public/governanceview.js): they never
  // wait for the summary.
  if (state.route === 'governance') {
    el.innerHTML = govView(state.sub);
    return govMount(state.sub);
  }
  if (!state.data && !['live', 'brain', 'integrations', 'trace', 'datasets', 'cost'].includes(state.route)) {
```

In `public/app.js`, replace

```js
    } else if (
      !['settings', 'brain', 'squad', 'trace', 'datasets', 'cost'].includes(state.route) &&
      state.route !== 'governance' && // the audit log keeps its filters and pages: it reloads on Apply
      !$('#view').contains(document.activeElement)
    )
```

with

```js
    } else if (
      !['settings', 'brain', 'squad', 'trace', 'datasets', 'cost'].includes(state.route) &&
      state.route !== 'governance' && // the Governance pages keep their filters and drawer: they reload on their own
      !$('#view').contains(document.activeElement)
    )
```

In `public/iso.js`, replace

```js
    ['time', 'Time'],
  ],
};
function subTabs(route) {
```

with

```js
    ['time', 'Time'],
  ],
  // The inventory is the default page; the audit log moved to #governance/audit (public/governanceview.js).
  governance: [
    ['', 'Inventory'],
    ['compliance', 'Compliance'],
    ['audit', 'Audit log'],
  ],
};
function subTabs(route) {
```

In `public/index.html`, replace

```html
        <div class="nav-label">GOVERNANCE</div>
        <a href="#governance" data-route="governance"><span data-icon="shield"></span>Governance</a>
        <a class="nav-sub" href="#governance" data-route="governance/">Audit log</a>
        <div class="nav-label">PREFERENCES</div>
        <a href="#settings" data-route="settings"><span data-icon="gear"></span>Settings</a>
```

with

```html
        <div class="nav-label">GOVERNANCE</div>
        <a href="#governance" data-route="governance"><span data-icon="shield"></span>Governance</a>
        <a class="nav-sub" href="#governance" data-route="governance/">Inventory</a>
        <a class="nav-sub" href="#governance/compliance" data-route="governance/compliance">Compliance</a>
        <a class="nav-sub" href="#governance/audit" data-route="governance/audit">Audit log</a>
        <div class="nav-label">PREFERENCES</div>
        <a href="#settings" data-route="settings"><span data-icon="gear"></span>Settings</a>
```

In `public/styles.css`, replace

```css
  margin: 0;
  font-size: 12px;
}
```

with

```css
  margin: 0;
  font-size: 12px;
}
/* Governance → Inventory and Compliance (public/governanceview.js). The review drawer uses the cost drawer's styles. */
.gov-summary {
  margin: 0 0 10px;
  color: var(--h-muted);
}
.gov-id {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.gov-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 12.5px;
}
.gov-facts dt {
  color: var(--h-muted);
}
.gov-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/governance-inventory-ui.test.js test/governance-ui.test.js test/cost-ui.test.js test/monitors-ui.test.js`
Expected: PASS (57 tests).

- [ ] **Step 6: Check the style**

Run: `npx prettier@3 --check public/governanceview.js public/app.js public/iso.js test/governance-inventory-ui.test.js test/governance-ui.test.js`
Expected: `All matched files use Prettier code style!`
Run: `npx prettier@3 --stdin-filepath public/styles.css < public/styles.css | diff public/styles.css - | grep -c '^[<>]'`
Expected: `39`

- [ ] **Step 7: Commit**

```bash
git add public/governanceview.js public/app.js public/iso.js public/index.html public/styles.css test/governance-inventory-ui.test.js test/governance-ui.test.js
git commit -m "Governance: Inventory and Compliance pages; the audit log moves to #governance/audit"
```

---
### Task 8: documentation and the whole suite

**Files:**
- Modify: `docs/governance.md` (lines 1, 147, 182, 192, 210, 265, 278, 284, 293, 301, 312, 326)
- Modify: `README.md` (lines 111, 264, 735, 743, 1033, 1072, 1098)
- Modify: `docs/monitors.md` (lines 7, 24, 44)

**Interfaces:**
- Consumes: everything above; the values V1–V13 and U1.
- Produces: documentation only.

- [ ] **Step 1: `docs/governance.md`: the Inventory and Compliance sections; the audit log's sections one level down**

The audit log's own headings move down one level, so their anchors (`#retention`, `#api` …) stay what README links to.

In `docs/governance.md`, replace

````markdown
# Governance audit log

One record of the changes made to ZAAFPulse from the dashboard, its settings and sign-in, and of the changes an API
````

with

````markdown
# Governance

The **Governance** menu answers the questions an auditor or a security lead asks first: which AI systems are in use
here, who owns them and how risky they are; which controls are in place, with evidence; and who changed what. It has
three pages:

- **Inventory** (`#governance`): every AI system ZAAFPulse can see on this machine, with your review of each one.
- **Compliance** (`#governance/compliance`): the controls ZAAFPulse provides, their status from your settings, the
  clauses they map to, and an evidence export.
- **Audit log** (`#governance/audit`): every change made by a person or an API key ([below](#audit-log)).

Everything stays on this machine. The Compliance page is evidence for your assessment, not a certification.

## Inventory

### What is listed

The inventory is built when you open the page, and every 10 minutes in the background for the Monitors rule, from
what ZAAFPulse already reads plus the AI clients' MCP settings:

| Kind | From | Shown in "where" as |
|---|---|---|
| `app` | the apps running and installed (as on the Live page), the indexed Claude Code and Codex logs, the Trace explorer's sources, the desktop apps under Settings → Local models | `running`, `installed`, `logs`, `trace`, `runtimes` |
| `mcp` | the MCP servers in the AI clients' config files ([below](#mcp-servers-in-your-ai-clients)), and the `mcp__<server>__…` tools in the indexed logs | `<client> config`, `logs` |
| `provider` | the gateway's providers | `gateway` |
| `model` | the models the gateway served this month (a route, `router/<name>`, is not a model) and the models in the indexed logs | `gateway usage`, `logs` |
| `agent`, `skill`, `workflow`, `knowledge` | the gateway's agents, the ZAAFPulse agent skills, the workflows and the knowledge bases | `gateway` |
| `runtime` | local model servers: Ollama, LM Studio, the llama.cpp server, Jan, LocalAI and your own | `running`, `installed`, `runtimes` |
| `integration` | the integrations in `config.json`, upstream MCP servers included | `integrations` |
| `key` | ZAAFPulse API keys: the consumers | `gateway` |

One system is one item: Claude Code running, installed, in the logs and in the Trace explorer is one `app:claude`. An
item's id is `<kind>:<name>`, lowercased, the name being the system's own id where it has one (`key:key_ab12`,
`provider:openai`). Its state is the best one a source gives: `running`, then `used` (in the last 30 days: the logs,
the gateway's usage this month, a key's last use), `configured`, then `idle` (installed but not running, switched off,
revoked or expired). The vendor is shown where it is known. An agent is read for its id, name, state and remote
address only, never its system prompt; a key for its id, name and dates, never its secret.

A source that fails, or takes longer than 2 seconds, is named on the page and the list is built from the rest.

### MCP servers in your AI clients

ZAAFPulse reads the files `zaafpulse register-mcp` knows: Claude Code (`~/.claude.json`: the user's servers and each
project's), Claude Desktop, Cursor, Kiro, Antigravity, VS Code (`servers`), Windsurf / Devin Desktop (and the folder
from before the rename), Gemini CLI, Zed (`context_servers`) and Codex CLI (the `[mcp_servers.<name>]` tables of
`config.toml`). Comments and trailing commas are fine. A file that cannot be read or parsed shows as unreadable, and
the other clients are still listed. The same server in several clients is one item that names every client.

Of a server only this is kept: its name, the transport (`stdio` or `http`), the command's base name (`npx`) and the
first argument that looks like a package name (`npx -y @scope/pkg` gives `@scope/pkg`), or for an HTTP server its
URL's origin (`https://mcp.example.com`: no path, query or user). Never an env value, a header, another argument or a
token. ZAAFPulse's own entry is marked and is never counted as new. A project's folder shows as a `~` path on the
dashboard only; the evidence export leaves it out. Demo mode reads no client file.

### Reviews

**Review** on a row opens a drawer: owner, purpose, risk (`minimal`, `limited`, `high` or `unacceptable`, the EU AI
Act tiers, or none), decision (`approved`, `restricted` or `blocked`, or none) and a note, at most 200 characters each.
A review is saved in `config.json` as `governance.inventory["<id>"] = { owner, purpose, risk, decision, note,
reviewedAt }`, so every save is a `config.change` entry in the audit log. An item without one is **unreviewed**. A
review whose item is no longer seen is kept and shown as **gone**; **Clear review** removes it. At most 2000 reviews.

The decision is a record: blocking a system stays with API keys and the guardrails.

### First and last seen

`.data/governance/seen.json` holds, for each item id, the first and the last day (UTC) the inventory saw it, and
nothing else. It is written when a build changes it. When it cannot be read the dates start again from today; the page
never fails on it.

### The Monitors rule

`inventory_unreviewed` (on by default, never pauses) is triggered while an item first seen in the last 7 days has no
review: a new AI system nobody has looked at (shadow AI). Its value is how many, its title their kinds (`mcp,
provider`), never a name. After an upgrade or on a new install every item is new for a week.

## Compliance

The page lists a fixed set of controls, each with a status worked out from your settings and state now (`in place`,
`partial` or `off`), its evidence (a setting's value, a count, a date) and a link to the page that shows it. The
tables are grouped by framework, clause by clause:

- **EU AI Act**, Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744: Art. 12 (record-keeping), Art. 14
  (human oversight), Art. 26 (deployer obligations: logs kept at least 6 months, oversight assigned, monitoring) and
  Art. 50 (transparency, where your use applies).
- **NIST AI RMF 1.0**: GOVERN 1.4 and 1.6, MAP 1.1, MEASURE 2.1, 2.3, 2.4, 2.7 and 2.10, MANAGE 2.4 and 4.1.
- **ISO/IEC 42001:2023**, Annex A: A.2, A.5, A.6, A.7, A.8, A.9 and A.10.

It is evidence for your assessment, not a certification: a status says what ZAAFPulse does here, not whether your use
of AI meets a law or a standard.

### The controls

| Control | In place when | Partial when | Off when |
|---|---|---|---|
| Gateway guardrails | secrets, personal data and prompt injection are all checked | one or two are `off` | all three are `off` |
| Governance audit log | entries are written and the last verify found the chain intact (kept at least 6 months) | not verified yet | writing fails, or the chain is broken |
| Gateway request log | always: every gateway request is a line, never its text | | |
| External providers need approval | every external provider is approved or waits for approval | one is served without a recorded approval (set up before approvals existed) | |
| API keys with scopes, budgets and expiry | every active key has a budget or an expiry (or there is no active key) | some do | none does |
| Human approval in workflows | every workflow that sends, changes or decides (tier R2 or R3) has an approval step (or there is none) | some do | none does |
| Pause and stop an agent | agent control is on | | it is off: server mode, password or no sign-in, Docker |
| Monitors rules | `guardrail_block`, `audit_chain_broken` and `inventory_unreviewed` are on | one or two of them are off | all three are off |
| Evals running | a judge model is ready and judge evaluators are on | the judge is off or waiting (the code evaluators always run) | |
| Dataset experiments | an experiment finished in the last 90 days | datasets, but no experiment finished in the last 90 days | no dataset |
| Budgets that block or pause | a budget blocks or pauses | budgets only alert | no budget |
| Secrets in the OS store | the Keychain or the keyring | the encrypted secret file | |
| Dashboard sign-in | this OS account (local) or a password | | no sign-in |
| Content capture off | the OpenTelemetry export sends no prompt or reply | | it does (`otel.captureContent`) |
| OpenTelemetry export | spans are exported | the exporter reports an error | not set up |
| Trace retention | traces are kept at least 183 days (6 months) | they are kept less | tracing is off |
| AI inventory reviewed | every item is reviewed, every high or unacceptable one has a decision and every unacceptable one is blocked | some are reviewed | none is |

A part of the state that cannot be read makes its control `off`, with "could not be read" as the evidence.

### Evidence export

**Export Markdown** and **Export JSON** download `GET /api/governance/evidence?format=md|json`
(`zaafpulse-evidence-<day>.md` or `.json`): the inventory with its reviews, the controls with status, evidence and
clauses, the audit log's retention and last verify, the time and the ZAAFPulse version. It holds no path: an item's
project folders and the client files are left out. Each export is recorded as a `governance.export` entry, with the
format and who asked.

### Inventory and compliance API

All behind the dashboard sign-in; no gateway key or MCP client reaches them.

| Route | What |
|---|---|
| `GET /api/governance/inventory` | `{ generatedAt, items, counts, failed, clients }`: the items, their counts, the sources that failed, and the AI clients' files (`state` `ok` or `unreadable`, `~` paths) |
| `POST /api/governance/inventory` | `{ id, owner, purpose, risk, decision, note }` saves a review, `{ id, clear: true }` removes it; a bad field is a 400 that names it (`risk: minimal, limited, high, unacceptable or empty`) and nothing is written |
| `GET /api/governance/controls` | `{ generatedAt, notice, frameworks, clauses, controls: [{ id, title, status, evidence, link, clauses }] }` |
| `GET /api/governance/evidence?format=json\|md` | a download (`json` by default); any other format is a 400 |

### Known limits of the inventory

- An owner is free text: named users come with a later sub-project.
- Only the client files listed above are read; a project's own `.mcp.json` or `.cursor/mcp.json` is not.
- The package is the first argument that looks like one, so `docker run …` shows `run`.
- No questionnaire, impact assessment workflow or external attestation; a decision enforces nothing.

## Audit log

One record of the changes made to ZAAFPulse from the dashboard, its settings and sign-in, and of the changes an API
````

In `docs/governance.md`, replace

````markdown
`.data/audit/` next to your other data and never leaves the machine.

Open it under **Governance → Audit log** in the sidebar.

## What is recorded

| What | Action | Notes |
````

with

````markdown
`.data/audit/` next to your other data and never leaves the machine.

Open it under **Governance → Audit log** (`#governance/audit`) in the sidebar.

### What is recorded

| What | Action | Notes |
````

In `docs/governance.md`, replace

````markdown
every route but `logs`, so a read cannot change anything there.

### Who acted

| `actor.via` | Fields | When |
````

with

````markdown
every route but `logs`, so a read cannot change anything there.

#### Who acted

| `actor.via` | Fields | When |
````

In `docs/governance.md`, replace

````markdown
| `rule` | `rule` | a Monitors rule that paused an agent |

### An entry

One JSON object per line, for example:
````

with

````markdown
| `rule` | `rule` | a Monitors rule that paused an agent |

#### An entry

One JSON object per line, for example:
````

In `docs/governance.md`, replace

````markdown
`‹changed›`.

## The chain

Every entry has `seq` (1, 2, 3 … across months), `prev` (the `mac` of the entry before it; `genesis` for the very
````

with

````markdown
`‹changed›`.

### The chain

Every entry has `seq` (1, 2, 3 … across months), `prev` (the `mac` of the entry before it; `genesis` for the very
````

In `docs/governance.md`, replace

````markdown
the same way, so the owner can confirm it was one.

## Retention

The files are monthly: `.data/audit/governance-YYYY-MM.jsonl` (UTC months, mode 0600, folder 0700), with no size
````

with

````markdown
the same way, so the owner can confirm it was one.

### Retention

The files are monthly: `.data/audit/governance-YYYY-MM.jsonl` (UTC months, mode 0600, folder 0700), with no size
````

In `docs/governance.md`, replace

````markdown
start) or at a restart.

## The daily pass

At start and every 24 hours the server imports the events the CLI left, prunes the months past the retention and
````

with

````markdown
start) or at a restart.

### The daily pass

At start and every 24 hours the server imports the events the CLI left, prunes the months past the retention and
````

In `docs/governance.md`, replace

````markdown
code only. A pending file that is not valid is dropped without being recorded.

## Export

**Export CSV** and **Export JSONL** download the entries of the chosen range (`GET
````

with

````markdown
code only. A pending file that is not valid is dropped without being recorded.

### Export

**Export CSV** and **Export JSONL** download the entries of the chosen range (`GET
````

In `docs/governance.md`, replace

````markdown
export (413 beyond: narrow the range).

## When an entry cannot be written

A full disk, a permission problem or a locked secret store never stops the change itself. The server remembers
````

with

````markdown
export (413 beyond: narrow the range).

### When an entry cannot be written

A full disk, a permission problem or a locked secret store never stops the change itself. The server remembers
````

In `docs/governance.md`, replace

````markdown
`audit.gap` entry records how many entries were missed and since when, then the chain goes on.

## Monitors

- `audit_degraded` (on by default): triggered while entries cannot be written; its value is the number of entries
````

with

````markdown
`audit.gap` entry records how many entries were missed and since when, then the chain goes on.

### Monitors

- `audit_degraded` (on by default): triggered while entries cannot be written; its value is the number of entries
````

In `docs/governance.md`, replace

````markdown
Neither pauses anything, and neither alert carries anything from an entry.

## API

All behind the dashboard sign-in; no gateway key or MCP client reaches them.
````

with

````markdown
Neither pauses anything, and neither alert carries anything from an entry.

### API

All behind the dashboard sign-in; no gateway key or MCP client reaches them.
````

In `docs/governance.md`, replace

````markdown
A bad query value is a 400 that names it, as `limit: a whole number from 1 to 500`.

## Known limits

- One person per dashboard: entries say `dashboard`, the sign-in mode, the device and the address, not a name.
````

with

````markdown
A bad query value is a 400 that names it, as `limit: a whole number from 1 to 500`.

### Known limits

- One person per dashboard: entries say `dashboard`, the sign-in mode, the device and the address, not a name.
````

- [ ] **Step 2: `README.md` and `docs/monitors.md`**

In `README.md`, replace

````markdown

**Monitors & alerts**<br>
<sub>Ten rules on cost, quality, agent behaviour and the audit log, including cost anomalies and guardrail blocks, plus your budgets, with alerts in the top bar, a desktop notification or a webhook. Pause, resume or stop the agent behind a session, or let a cost or loop rule pause it (off by default). Snooze a rule for an hour or a day.</sub>

</td>
````

with

````markdown

**Monitors & alerts**<br>
<sub>Eleven rules on cost, quality, agent behaviour, the audit log and new AI systems, including cost anomalies and guardrail blocks, plus your budgets, with alerts in the top bar, a desktop notification or a webhook. Pause, resume or stop the agent behind a session, or let a cost or loop rule pause it (off by default). Snooze a rule for an hour or a day.</sub>

</td>
````

In `README.md`, replace

````markdown
<td valign="top">

**Governance audit log**<br>
<sub>Every change made by a person or an API key (settings, keys, providers, guardrails, integrations, budgets, sign-ins, approvals) with who, when, what and the outcome. Monthly files kept 12 months by default, chained with a key so an edited or deleted line shows when you verify, exportable as CSV or JSON lines. <a href="docs/governance.md">docs/governance.md</a></sub>

</td>
````

with

````markdown
<td valign="top">

**AI governance**<br>
<sub>An inventory of every AI system here (apps, the MCP servers in your AI clients, providers, models, agents, keys) with its owner, purpose, risk and your decision; seventeen controls mapped to the EU AI Act, the NIST AI RMF and ISO/IEC 42001 with their evidence, exportable as Markdown or JSON; and an audit log of every change made by a person or an API key, chained so an edited or deleted line shows when you verify. <a href="docs/governance.md">docs/governance.md</a></sub>

</td>
````

In `README.md`, replace

````markdown
Monitors watch your usage, cost and quality inside the dashboard server and tell you when something looks wrong. The bell in the top bar lists recent alerts, and **Settings → Monitors** has the rules and the channels.

- **Ten rules:** cost burn (per session, per 10 minutes), tool loop, agent stuck, accuracy drop, evaluator pass rate, unsafe content, cost anomaly (today's or yesterday's spend well above what the same weekday usually costs), guardrail block (the gateway guardrails blocked a request in the last hour), audit log degraded and audit chain broken (see [Governance audit log](#governance-audit-log)), plus your cost budgets. Each rule can be switched on or off, has its own limits, and can be snoozed for an hour or a day. A rule with missing input reports *no data* and never triggers.
- **Channels:** a desktop notification (on by default) and an optional webhook whose URL and headers go to the OS secret store. Neither carries transcript text. Demo mode sends nothing.
- **Agent control:** pause (`SIGSTOP`), resume or stop the Claude Code or Codex process behind a session from the Trace explorer, the Live monitor or AI Office. Before every signal the process table is read again and the pid and start time must match; every action is written to `.data/agent-audit.jsonl`.
````

with

````markdown
Monitors watch your usage, cost and quality inside the dashboard server and tell you when something looks wrong. The bell in the top bar lists recent alerts, and **Settings → Monitors** has the rules and the channels.

- **Eleven rules:** cost burn (per session, per 10 minutes), tool loop, agent stuck, accuracy drop, evaluator pass rate, unsafe content, cost anomaly (today's or yesterday's spend well above what the same weekday usually costs), guardrail block (the gateway guardrails blocked a request in the last hour), audit log degraded and audit chain broken (see [Governance audit log](#governance-audit-log)), unreviewed AI system (see [AI inventory and compliance](#ai-inventory-and-compliance)), plus your cost budgets. Each rule can be switched on or off, has its own limits, and can be snoozed for an hour or a day. A rule with missing input reports *no data* and never triggers.
- **Channels:** a desktop notification (on by default) and an optional webhook whose URL and headers go to the OS secret store. Neither carries transcript text. Demo mode sends nothing.
- **Agent control:** pause (`SIGSTOP`), resume or stop the Claude Code or Codex process behind a session from the Trace explorer, the Live monitor or AI Office. Before every signal the process table is read again and the pid and start time must match; every action is written to `.data/agent-audit.jsonl`.
````

In `README.md`, replace

````markdown
Rules, states, channels, safety checks, the API and known limits: **[docs/monitors.md](docs/monitors.md)**.

## Governance audit log
````

with

````markdown
Rules, states, channels, safety checks, the API and known limits: **[docs/monitors.md](docs/monitors.md)**.

## AI inventory and compliance

**Governance → Inventory** lists every AI system ZAAFPulse can see on this machine: the apps running and installed, the
MCP servers in your AI clients' own settings (Claude Code, Claude Desktop, Cursor, Kiro, Antigravity, VS Code,
Windsurf, Gemini CLI, Zed and Codex CLI), the gateway's providers and the models they served, agents, skills,
workflows, knowledge bases, local runtimes, integrations and API keys. One system is one item, with where it was
found, its state and the days it was first and last seen.

- **Review** each item: owner, purpose, risk (the EU AI Act tiers) and your decision, saved in `config.json` and
  recorded in the audit log.
- **Shadow AI:** the `inventory_unreviewed` rule alerts when a system first seen in the last 7 days has no review.
- **Private:** of an MCP server only its name, transport, command and package name, or its URL's origin, are kept;
  never env values, headers or tokens.

**Governance → Compliance** shows seventeen controls (the guardrails, the audit log, approvals, keys, agent control,
the Monitors, evals, budgets, sign-in, retention, the inventory itself …) with their status from your settings and
their evidence, mapped to the EU AI Act, the NIST AI RMF 1.0 and ISO/IEC 42001:2023. **Export** the inventory, the
controls and the audit log's state as Markdown or JSON. It is evidence for your assessment, not a certification.

What is listed, the reviews, every control and the API: **[docs/governance.md](docs/governance.md)**.

## Governance audit log
````

In `README.md`, replace

````markdown
docs/cost.md           cost ledger: who counts what, frozen cost, billing, cost centers, restate, the Cost Control menu, API, limits
docs/guardrails.md     gateway guardrails: the checks, modes, scope, per-key policy, what is recorded, reading a block
docs/governance.md     governance audit log: what is recorded, the chain, verify, retention, export, degraded mode, API
docs/assets/           README banner, diagrams, screenshots and GIFs
```
````

with

````markdown
docs/cost.md           cost ledger: who counts what, frozen cost, billing, cost centers, restate, the Cost Control menu, API, limits
docs/guardrails.md     gateway guardrails: the checks, modes, scope, per-key policy, what is recorded, reading a block
docs/governance.md     governance: the AI inventory and reviews, compliance controls, evidence export, the audit log, API
docs/assets/           README banner, diagrams, screenshots and GIFs
```
````

In `README.md`, replace

````markdown
| `GET /api/agents/candidates` · `POST /api/agents/pause` · `resume` · `stop` | the processes that could be behind a session, and pausing, resuming or stopping one; see [docs/monitors.md](docs/monitors.md#agent-control) |
| `GET /api/runtimes` · `/api/runtimes/config` · `POST /api/runtimes/start` · `stop` · `approve` · `save` · `delete` | local model servers: Start and Stop in AI Office and your own runtimes in Settings; see [docs/local-models.md](docs/local-models.md#api) |
| `GET /api/governance/audit` · `export` · `verify` · `status` · `POST /api/governance/settings` | the governance audit log: entries, a CSV or JSON-lines download, a check of the chain, its state, and the retention; see [docs/governance.md](docs/governance.md#api) |
| `POST /api/rescan` | re-index changed log files now |
````

with

````markdown
| `GET /api/agents/candidates` · `POST /api/agents/pause` · `resume` · `stop` | the processes that could be behind a session, and pausing, resuming or stopping one; see [docs/monitors.md](docs/monitors.md#agent-control) |
| `GET /api/runtimes` · `/api/runtimes/config` · `POST /api/runtimes/start` · `stop` · `approve` · `save` · `delete` | local model servers: Start and Stop in AI Office and your own runtimes in Settings; see [docs/local-models.md](docs/local-models.md#api) |
| `GET /api/governance/inventory` · `POST /api/governance/inventory` · `GET /api/governance/controls` · `GET /api/governance/evidence` | the AI inventory and its reviews, the compliance controls with their evidence, and the evidence export; see [docs/governance.md](docs/governance.md#inventory-and-compliance-api) |
| `GET /api/governance/audit` · `export` · `verify` · `status` · `POST /api/governance/settings` | the governance audit log: entries, a CSV or JSON-lines download, a check of the chain, its state, and the retention; see [docs/governance.md](docs/governance.md#api) |
| `POST /api/rescan` | re-index changed log files now |
````

In `README.md`, replace

````markdown
| Gateway guardrails (`gateway.guardrails`) | secrets `redact`, personal data `off`, prompt injection `log`, scope `external` ([docs/guardrails.md](docs/guardrails.md)) |
| Audit log retention (`governance.audit.retentionMonths`) | 12 months, from 6 to 120 ([docs/governance.md](docs/governance.md#retention)) |

Environment variables: `PORT` / `ZAAFPULSE_PORT` (default `4777`), `ZAAFPULSE_HOST`, `ZAAFPULSE_DATA`, `ZAAFPULSE_AUTH` (`local` by default on 127.0.0.1, `1` for password, `none` to turn sign-in off), `ZAAFPULSE_INDEX_WORKERS` (worker threads for the first index; `0` turns them off), `ZAAFPULSE_CONTENT` (`off` hides transcript text in the Trace explorer, and eval explanations; in server mode it is off unless `on`), `ZAAFPULSE_OLLAMA_URL` and `ZAAFPULSE_LMSTUDIO_URL` (move the local judge servers; for tests and unusual setups, see [docs/evals.md](docs/evals.md)), `ZAAFPULSE_CLAUDE_BIN` (the Claude Code CLI for the [Claude Code judge](docs/evals.md#claude-code), when it is not found on its own), the server-mode settings in [docs/install.md](docs/install.md), the standard `OTEL_*` variables ([docs/otel.md](docs/otel.md)), and `DEMO=1` for synthetic data. Demo mode never writes `config.json`, the Keychain or your coding tools, and fetches nothing: model calls are answered by a scripted model inside the process, and gateway data lives in a temporary folder. It uses the cached price list if one exists.
````

with

````markdown
| Gateway guardrails (`gateway.guardrails`) | secrets `redact`, personal data `off`, prompt injection `log`, scope `external` ([docs/guardrails.md](docs/guardrails.md)) |
| Audit log retention (`governance.audit.retentionMonths`) | 12 months, from 6 to 120 ([docs/governance.md](docs/governance.md#retention)) |
| AI inventory reviews (`governance.inventory`) | none; set on **Governance → Inventory** ([docs/governance.md](docs/governance.md#reviews)) |

Environment variables: `PORT` / `ZAAFPULSE_PORT` (default `4777`), `ZAAFPULSE_HOST`, `ZAAFPULSE_DATA`, `ZAAFPULSE_AUTH` (`local` by default on 127.0.0.1, `1` for password, `none` to turn sign-in off), `ZAAFPULSE_INDEX_WORKERS` (worker threads for the first index; `0` turns them off), `ZAAFPULSE_CONTENT` (`off` hides transcript text in the Trace explorer, and eval explanations; in server mode it is off unless `on`), `ZAAFPULSE_OLLAMA_URL` and `ZAAFPULSE_LMSTUDIO_URL` (move the local judge servers; for tests and unusual setups, see [docs/evals.md](docs/evals.md)), `ZAAFPULSE_CLAUDE_BIN` (the Claude Code CLI for the [Claude Code judge](docs/evals.md#claude-code), when it is not found on its own), the server-mode settings in [docs/install.md](docs/install.md), the standard `OTEL_*` variables ([docs/otel.md](docs/otel.md)), and `DEMO=1` for synthetic data. Demo mode never writes `config.json`, the Keychain or your coding tools, and fetches nothing: model calls are answered by a scripted model inside the process, and gateway data lives in a temporary folder. It uses the cached price list if one exists.
````

In `docs/monitors.md`, replace

````markdown
## Rules

Ten rules ship with ZAAFPulse. Each can be switched on or off and has its own limits. A rule that is on its default setting follows the table. Your own choices are kept in `.data/monitors.json`.

`daily_cost` and `month_projection` have been replaced by [budgets](cost.md#budgets). They are no longer evaluated,
````

with

````markdown
## Rules

Eleven rules ship with ZAAFPulse. Each can be switched on or off and has its own limits. A rule that is on its default setting follows the table. Your own choices are kept in `.data/monitors.json`.

`daily_cost` and `month_projection` have been replaced by [budgets](cost.md#budgets). They are no longer evaluated,
````

In `docs/monitors.md`, replace

````markdown
| `audit_degraded` | The governance audit log cannot write its entries (see [docs/governance.md](governance.md)) | none | yes | no |
| `audit_chain_broken` | The last check of the governance audit log's chain failed, or found a rekey less than 7 days old | none | yes | no |

Notes:
````

with

````markdown
| `audit_degraded` | The governance audit log cannot write its entries (see [docs/governance.md](governance.md)) | none | yes | no |
| `audit_chain_broken` | The last check of the governance audit log's chain failed, or found a rekey less than 7 days old | none | yes | no |
| `inventory_unreviewed` | An AI system first seen in the last 7 days has no review in Governance → Inventory (see [docs/governance.md](governance.md#the-monitors-rule)) | none | yes | no |

Notes:
````

In `docs/monitors.md`, replace

````markdown
- `guardrail_block` reads the gateway's usage entries after each refresh. Its value is the number of blocked requests in the last 60 minutes and the alert's title names the checks that blocked (`injection, secrets`): never a label or the text that was found.
- `audit_degraded` and `audit_chain_broken` read the governance audit log's state after each refresh. The first one's value is the number of entries that could not be written so far; the second one's is the seq where the chain broke (0 when the key is missing) and its title the reason (`entry changed`, `chain broken`, `sequence broken`, `unreadable line` or `key missing`). An intact chain whose key was replaced less than 7 days ago (by the rekey entry's time) triggers it too, titled `rekeyed`, with the rekey's seq ("key replaced at entry N"): every rekey alerts once, since one sealed with a key of someone's own could replace the entries after it. The chain is checked at start, once a day and whenever you press Verify. Neither alert carries anything from an entry.
- A rule whose input is missing reports `no_data`. It never triggers on missing data.
- A live session that has not been seen for a minute (it ended or went idle) leaves the rule card and the counts; its alerts stay in the history.
````

with

````markdown
- `guardrail_block` reads the gateway's usage entries after each refresh. Its value is the number of blocked requests in the last 60 minutes and the alert's title names the checks that blocked (`injection, secrets`): never a label or the text that was found.
- `audit_degraded` and `audit_chain_broken` read the governance audit log's state after each refresh. The first one's value is the number of entries that could not be written so far; the second one's is the seq where the chain broke (0 when the key is missing) and its title the reason (`entry changed`, `chain broken`, `sequence broken`, `unreadable line` or `key missing`). An intact chain whose key was replaced less than 7 days ago (by the rekey entry's time) triggers it too, titled `rekeyed`, with the rekey's seq ("key replaced at entry N"): every rekey alerts once, since one sealed with a key of someone's own could replace the entries after it. The chain is checked at start, once a day and whenever you press Verify. Neither alert carries anything from an entry.
- `inventory_unreviewed` reads the AI inventory's counts from its last build (when the Governance page opens, and every 10 minutes). Its value is the number of items first seen in the last 7 days that have no review; its title lists their kinds (`mcp, provider`), never a name. ZAAFPulse's own MCP entry does not count.
- A rule whose input is missing reports `no_data`. It never triggers on missing data.
- A live session that has not been seen for a minute (it ended or went idle) leaves the rule card and the counts; its alerts stay in the history.
````

- [ ] **Step 3: The whole suite**

Run: `npm test`
Expected: about 2389 tests, all pass but the 2 skipped. A timing test that fails once under load (`call: a helper
that keeps the pipes open cannot hold the call past its timeout`, `call: a slow CLI is stopped at the timeout…`, `a
Save queued while another hangs…`, `pii: a long run without an @…`, `GET /api/topology: 401 without sign-in…`) is
rerun on its own with `node --test <file>` before anything else is suspected.

- [ ] **Step 4: Commit**

```bash
git add docs/governance.md README.md docs/monitors.md
git commit -m "Document the AI inventory and the Compliance page"
```

## Decisions made while planning

- **The client table moves, it is not copied.** `clients()`, `isOurs`, `NAME`, `OLD_NAMES` and the TOML reader
  (`tomlKey`, `tomlTables`, `tomlBody`, `setPath`, `tomlFind`) move verbatim to `lib/mcp-clients.js`; the writers
  (`tomlBlock`, `tomlCut` …) stay in `scripts/register-mcp.js`, which requires the rest and exports the same names. The
  single-file build packs `lib/` whole, so the new module ships; `test/register.test.js` and `test/sea.test.js` pass
  unchanged. The scan reuses the TOML reader rather than a second one.
- **Task order.** The Monitors rule (Task 4) comes before the controls (Task 5), whose `monitors` control checks that
  `inventory_unreviewed` is on, and the evidence (Task 6) renders the controls.
- **The build lives in the router.** `server.js` only gathers the sources; `lib/governance/api.js` calls
  `buildInventory`, reads and writes the seen dates and keeps the last counts, so the HTTP routes, the Monitors input,
  the controls and the evidence share one build path (and the router's unit tests cover it with stand-ins).
- **Sources read at most every 5 s, built every 10 minutes.** A page open, the controls and the evidence each build
  the inventory; the sources behind them (a process listing, ten config files) are reused for 5 s. The Monitors rule
  needs new systems seen without the page open, so the server builds it at start and every 10 minutes, as the system.
- **Kinds, not names, merge where one system has two ids.** Ollama and LM Studio are `runtime:` items (as the
  topology draws them) whether a process or a runtime row shows them; Gemini CLI's trace source is
  `app:antigravity` (`lib/processes.js` counts it as that app); a desktop app's runtime row is its `app:` item. An MCP
  server is one item across clients and the logs, by its name, lowercased.
- **MCP servers seen in the logs.** The summary's `toolUse` (`mcp__<server>__<tool>`) marks a server `used`; it is the
  top 12 tools of the last 30 days, so a rarely used server shows from its config only.
- **`where` uses the clients' display names** (`Claude Code config`), which the page shows, rather than slugs.
- **A review without an item is an item.** Its state is `gone` (status `gone`), with kind and name from the id, so it
  can be seen and cleared (`{ id, clear: true }`, an addition to I4 so a gone review does not stay for ever).
- **Review input.** Flat fields, unknown fields refused, text trimmed before the 200-character check, at most 2000
  reviews (a guard on config.json's size), `reviewedAt` set by the server.
- **The audit diff shows review fields (V9).** A review of `key:key_ab12` would otherwise be `‹changed›` (its id holds
  "key"); `governance.inventory` is a map by id like `cost.keyCenters`. This is a two-line change to
  `lib/governance/diff.js` (sub-project 2's masking), covered by a test in Task 3.
- **New means first seen today or in the 6 days before (UTC days).** ZAAFPulse's own MCP entry never counts. After an
  upgrade every item is new for a week, so the rule alerts once then (one alert, its count and kinds).
- **Statuses where I7 leaves a choice (V11).** A part that cannot be read is `off` with "could not be read" (the spec
  has no fourth status). Keys count as limited with a budget or an expiry; gates are judged on the workflows that send,
  change or decide (catalogue tiers R2 and R3); experiments count when one finished in the last 90 days; the trace
  retention is `in place` from 183 days (6 months, Art. 26's figure); the encrypted secret file is `partial`; content
  capture is judged on the OTel export (the trace store keeps no content, and the Trace explorer shows the owner the
  local logs' text, which is not a capture); the gateway request log has no switch, so it is always `in place`.
- **Clauses.** NIST AI RMF at subcategory level within the families I6 names; ISO/IEC 42001 at the Annex A group level
  I6 names (A.2 … A.10), not at the level of single controls; every clause is shown by at least one control (tested).
- **Evidence.** `json` by default; the file is named by the UTC day; the `governance.export` entry is written before
  the answer and only for an accepted format; the Markdown escapes what could break a table or carry markup.
- **One page file.** The spec's Architecture names `public/governanceview.js` for the sub-pages, so the Inventory and
  Compliance pages join the Audit log there (about 600 lines); the review drawer reuses the cost drawer's styles; the
  inventory's filters work on the loaded list; the pages keep out of the one-minute repaint, as the Audit log did.
- **Demo mode** builds the inventory from the demo's apps, gateway and integrations, and never reads a client file.
- **Spawned tests** get ports 10000–10199 and point every client folder variable into the temp folder.

## Spec points that do not fit

- **I2's example `claude-code config`.** The plan writes `Claude Code config` (the client's display name).
- **I2's states.** A review whose item is gone needs a row; the plan gives it `state: 'gone'` beside the four states.
- **I4 has no way to remove a review.** The plan adds `{ id, clear: true }` (and **Clear review** in the drawer).
- **I5 on a new install or after the upgrade.** Every item is first seen that day, so the rule triggers for a week
  with everything unreviewed. The controller may prefer a baseline (items of the first build counted as seen before).
- **I6/I7 statuses.** Only `in place`, `partial` and `off`; "could not be read" is `off`. The controller may want an
  `unknown` status instead.
- **I7 "retention ≥ 6 months" for the audit log.** The setting cannot go below 6 (sub-project 2), so it is evidence
  ("kept 12 months (at least 6)"), not a status driver. Art. 26's 6 months drives the trace retention's status.
- **I7 "content capture off".** Read as the OTel export's `captureContent`; see Decisions.
- **I3 per-project servers.** Read from `~/.claude.json` `projects[*].mcpServers` as I3 says; a project's own
  `.mcp.json` is not read.
- **I3 "the first package-looking argument".** `docker run …` gives `run`; a token typed as a bare argument is not
  package-looking (V5), so it never shows.
- **I6 ISO/IEC 42001 references** are Annex A groups (A.6), as I6 lists them, not controls such as A.6.2.8.
- **I8's framework versions** are copied verbatim from the spec; the plan does not verify them.
- **I1 "the models used".** Models from the gateway's usage this month and from the indexed logs; a route
  (`router/<name>`) is left out.
- **Runtime approvals** are named in the source inventory but are not one of I7's controls; the plan adds none.

## Self-review

- **Spec coverage.** I1 every source: Task 3 (`inventorySources`) with the builder in Task 2 (apps, MCP, providers,
  models, agents, skills, workflows, knowledge, runtimes and desktop apps, integrations, keys). I2 ids, fields, states,
  seen dates in `.data/governance/seen.json`: Task 2 (store and dates), Task 3 (wired). I3 every client of
  `register-mcp`, JSONC, TOML, `ours`, the kept fields only, `~` paths: Task 1 (tests with fixtures for every client,
  secrets in env/args/headers/URL never out), the dashboard-only folders: Tasks 2, 6, 7. I4 reviews, values, 200
  characters, unreviewed, gone, `config.change`: Tasks 2–3 (HTTP test reads the entry). I5 the rule, count and kinds
  only: Task 4. I6 catalogue, clauses, live status, evidence, link: Task 5. I7 all seventeen controls: Task 5. I8 the
  notice, the versions, never "compliant": Tasks 5–7 (tested). I9 the export, its contents, no paths, session only,
  `governance.export`: Task 6 (unit and spawned). I10 OTel status and trace retention in the controls: Task 5. I11
  sub-pages, sidebar, `#governance` → Inventory, Audit log at `#governance/audit`, docs: Tasks 7–8. I12: nothing
  enforces a decision; owner is free text. Error table: unreadable client (Task 1), failed source (Tasks 2–3), bad
  review 400 (Task 3), unreadable `seen.json` (Task 2). The spec's test list: parsers, scan fixtures, merge, ids,
  dates, gone reviews, review validation, every control's status, clause completeness, renderers without paths or
  secrets, the HTTP routes (inventory, review with `config.change`, controls, evidence with its entry, session only),
  the rule, the UI strings.
- **Placeholders.** None: every new file is given whole, every edit as an exact `old` → `new` pair.
- **Names and signatures.** `scanClients` (Task 1) is what `inventorySources` calls (Task 3); `buildInventory`,
  `storedReview` (Task 2) and `cleanReview` (Task 3) are what the router uses; `createGovernanceApi({ sources, seen,
  controlState, record, version, now })` grows across Tasks 3–6 with defaults, so `test/governance-api.test.js` keeps
  its two-argument call; `inventoryStatus` (Task 4) is what `createMonitors({ inventoryStatus })` reads; `controls`,
  `CLAUSES`, `FRAMEWORKS`, `NOTICE` (Task 5) are what the router and `evidence.js` (Task 6) use; `govView(sub)` and
  `govMount(sub)` (Task 7) are what `app.js` calls.
- **Globals.** Every new top-level name in `public/governanceview.js` starts with `gov` or `GOV`; the global-scope
  test passes.
- **Privacy.** Tests assert that no env value, header, URL path or query token, argument token, system prompt, key
  secret, client file or project folder reaches the scan's output (folders as `~` only), the inventory route, the
  evidence (JSON and Markdown) or an alert.
