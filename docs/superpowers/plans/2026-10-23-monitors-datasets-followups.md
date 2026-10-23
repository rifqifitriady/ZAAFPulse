# Monitors & Datasets Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Close the Minor findings that the Monitors (PR #40) and Datasets (PR #41) reviews deferred and that still apply on main (`09bd76e`, after Agent Tracing).
- Fix the user-facing bugs, safety gaps and missing screens (tier A) and the cheap maintainability and docs items (tier B). Tier C stays as it is, with a reason for each item.

**Sources:**
- Monitors: `.worktrees/monitors/.superpowers/sdd/` (`progress.md`, `final-review.md`, `final-rereview.md`, `final-rereview-2.md`, `task-N-review.md`).
- Datasets: `.worktrees/datasets/.superpowers/sdd/` (`progress.md`, `final-review.md`, `final-rereview.md`, `task-N-review.md`).
- Rules each feature keeps: `docs/superpowers/plans/2026-10-22-monitors-agent-control.md` and `docs/superpowers/plans/2026-10-22-datasets-replay.md`.

**Line numbers** below are on `fix/monitors-datasets-followups` at `09bd76e`. Re-read each location before editing it.

## Global Constraints

- **Dependencies.** Zero runtime dependencies. Node ≥18, CommonJS, `node:test`, plain browser JS in `public/`.
- **No shell (S7).** Every OS command is spawned with an argument array and no shell.
- **Text only (S1).** Content renders as text only (`esc()` / `textContent`, `dsEl` in `datasetview.js`). No markdown-to-HTML and no `innerHTML` built from content. CSP stays `script-src 'self'`.
- **Agent control (S6). These rules are unchanged and binding:**
  - Only processes that `lib/processes.js` `APPS` identifies as AI agents can be targeted.
  - A target is `{ pid, startTime }`, re-verified before every signal (protection against PID reuse).
  - Pause is `SIGSTOP` and resume is `SIGCONT`. Stop is `SIGINT`, then `SIGTERM` after 5 s if the process is still alive. **`SIGKILL` is never sent.** Windows has no pause, and stop runs `taskkill /PID <pid>` **without `/F`**.
  - Control needs a dashboard sign-in. No route is exposed to gateway API keys, MCP tools or A2A.
  - Control is off in server mode, with password sign-in and in Docker. Task 1 adds "without sign-in".
  - Every action and every refusal is audited (mode 0600).
  - Automatic pause happens only for `cost_burn`, `tool_loop` or `daily_cost`, and only when the owner opted in.
  - A paused agent is never resumed or stopped automatically.
  - A session links to a process automatically only when exactly one candidate matches. With several candidates, the UI asks and never guesses.
- **Notifications and webhooks (S7).**
  - Notification text holds only the rule name, numbers and the session title.
  - The webhook payload is exactly `{ rule, state, previous, value, threshold, sessionId, ts }`.
  - The webhook URL and headers are secret references.
- **Datasets privacy.**
  - **S2:** every saved text field is masked (`sig.secretSpans` → `‹<label> hidden›`) and capped at head + tail.
  - **S3:** no raw session id, span id or file path appears in an API reply. Clients get trace keys and sealed spans only, and every error message is free of paths.
  - **S4:** an external replay model needs an explicit choice, a preview and masking (`maskPii` on messages and tool descriptions). Replay to an external model is refused while content viewing is off.
  - **S10:** with content off, no transcript-derived text leaves an API response (R7).
  - **S11:** `.data/datasets/` uses folder 0700 and files 0600. `.data/experiments.jsonl` is 0600, capped at 100 records with a 2 MB record budget.
- **Replay caps (R8).**
  - The caps are checked before each call. A call in flight is **never interrupted**, so the cost can pass a cap by one call.
  - Only one experiment runs per server; a second start gets 409.
  - CI exit codes stay as in the plan: 1 when a requirement fails, 2 on a configuration error, 0 otherwise.
- **Demo mode.** It never sends a signal, notification or webhook, and it never touches the network or real files.
- **Tests.**
  - Tests never signal real processes other than children the test itself spawned (a sleeper).
  - They never run osascript, notify-send or PowerShell for real; they record the spawn arguments instead.
  - They never call a real webhook or provider; they use fake servers or fake accessors.
  - Mode assertions are skipped on Windows.
  - Each new test must fail on the code before its fix. For a test that only guards existing behaviour (a test gap), show that it fails by temporarily breaking the guarded line, then restore the line.
- **Housekeeping.**
  - Follow Prettier style (`.prettierrc.json`: printWidth 120, singleQuote, trailingComma all, arrowParens always). Write short "why" comments.
  - Commits carry **no `Co-Authored-By`, no "Generated with" and no AI attribution of any kind**.
  - CI runs on Ubuntu, macOS and Windows.
- **Controller decisions that stay** (nothing in this plan reverses them):
  - agent control off in server mode, with password sign-in and in Docker;
  - `month_projection` from the 4th of the month, and `accuracy_drop` needs 20 samples;
  - external replay is refused when content is off;
  - export links survive only within one running server;
  - cancel never interrupts the call in flight;
  - no AI attribution in commits.

## Triage

ID prefixes:
- **M** is Monitors and **D** is Datasets.
- `T<n>` is a task-review Minor, numbered in ledger order.
- `F` is a final-review Minor.
- `R1`, `R2` and `R` are re-review Minors.
- `P` is a plan-level gap.
- `N` is a new finding made during this triage.

### Monitors

| id | finding | now at | tier | reason |
|---|---|---|---|---|
| M-R2-2 | `verify()` checks the APPS app, not the program, so a hand-built POST can pause a `disclaimer` wrapper or a ChatGPT Codex helper | `lib/agents/control.js:157-187` (`:186`) | A | Safety: the only path where a non-agent passes the pre-signal check |
| M-F-3 | Agent control stays on with `ZAAFPULSE_AUTH=none`; other OS users can pause or stop the owner's agents | `server.js:478` | A | Safety; the plan says control "requires a dashboard sign-in" |
| M-T6-9 | The password-mode action test asserts only 403, which cannot show that the API gate (not control) refused | `test/monitors-api.test.js:872-879` | A | Test gap on a safety property |
| M-T5-2 | No test for a brief ok during a snooze (the auto-pause mark must survive) | `lib/monitors/state.js:234-247` | A | Test gap: "never pause the same episode twice" |
| M-T6-10 | No test of the "aggregate pass after refresh" wiring; a regression silently stops every aggregate monitor | `server.js:572-586` | A | Silent failure, untested |
| M-F-4 | A live instance whose session ended stays `triggered` for up to 24 h, in the rule card and in "N triggered now" | `lib/monitors/api.js:122-146`, `:366-369`; `lib/monitors/index.js:429-450` | A | Misleading UI counts |
| M-T7-1 | Drawer and Explorer notice are rewritten every 15 s, so keyboard focus is lost | `public/monitorsview.js:423-430`, `:741-748` | A | User-facing accessibility bug |
| M-T7-2 | Alert-poll errors are swallowed; the drawer says "Reading the alerts…" forever, or shows stale rows as current | `public/monitorsview.js:377-379`, `:486` | A | Silent failure |
| M-T7-3 | Explorer inline notice is empty for a session with no candidate (or not indexed) | `public/monitorsview.js:643` | A | Silent: the controls vanish with no reason |
| M-T7-4 | A Stop answered `exited: false` still removes the process from the list, so no second Stop is offered | `public/monitorsview.js:607` | A | User-facing bug |
| M-T7-5 | A refused rule parameter stays in the input while the card shows the saved value | `public/monitorsview.js:994-999`, `:1028` | A | Misleading UI |
| M-T5-4 | Settings shows a live "Tool calls in one turn" input for `tool_loop`, but `toolCallsTurn` is always null, so it does nothing | `public/monitorsview.js:32`, `:839-850`; `lib/monitors/index.js:227` | A | Misleading UI text |
| M-F-1 | The live pass reads the office snapshot (~46 ms sync) every 5 s even when no live rule or auto-pause is on | `lib/monitors/index.js:204-205`, `:427`; `server.js:1290` | B | Performance with an always-on trigger |
| M-F-2 | (with M-T6-3) `keyMemo` tries `claude` then `codex`; a miss forces a trace rebuild on every 15 s poll | `lib/monitors/api.js:103-120`; `lib/trace/index.js:368-386` | B | Performance with a realistic trigger (Codex sessions) |
| M-F-5 | `listPaused()` runs `lsof` for every agent on each status poll; the paused list needs no folder | `lib/agents/control.js:353-357`; `lib/processes.js:327` | B | Performance with a realistic trigger |
| M-T6-2 | `config.json` save (tmp + rename + cache) is copied five times | `server.js:297`, `:382`, `:415`, `:553`, `:598` | B | Verbatim duplication |
| M-T6-8 | Channels: the headers-without-URL pre-check uses `urlIn.mode !== 'none'` as a proxy; a URL secret can be orphaned | `lib/monitors/api.js:288-294` | B | Small correctness polish (orphan secret entry) |
| M-F-7 | `test/monitors-state.test.js` is not Prettier-formatted | file | B | Style |
| M-F-8 | The audit log folder is created without `mode: 0o700` | `lib/audit.js:12` | B | Cheap hardening (`.data` already exists as 0700 in practice) |
| M-R2-1 | Comment and fixture say `ps -o comm=` is the executable's full path; it is argv[0] as started | `lib/processes.js:291`; `test/processes.test.js:74-85` | B | Comment accuracy for a safety-adjacent helper |
| M-R2-3 | npm-installed Codex gives two candidates (node wrapper and native child), so it never auto-links | `lib/agents/control.js:337`; `docs/monitors.md:122` | B | Docs line now; the leaf-process fix needs `ppid` (see C) |
| M-R2-4 | macOS: a node script path with a space fails safe to "no candidate" | `docs/monitors.md:122` | B | Docs line |
| M-T8-5 | Docs: "Pause is not undone by anything but you" is vague | `docs/monitors.md:176` | B | Docs |
| M-R1-3 | The plan's rules table lacks the `month_projection` 4th-of-month gate and the `accuracy_drop` minimum | `docs/superpowers/plans/2026-10-22-monitors-agent-control.md:62-71` | B | Docs |

### Datasets

| id | finding | now at | tier | reason |
|---|---|---|---|---|
| D-F-1 | External replay cost is `r.usage.cost` or 0; a priced provider that sends no usage costs $0, so the cost cap never moves | `lib/datasets/replay.js:105`, `:110` | A | Safety: spend cap bypass (the judge path already guards this with `chargeOf`) |
| D-T5-6 | No way to stop a dashboard experiment; the 409 slot is held until the run ends ("No stop button") | `lib/datasets/api.js:369-410`; `docs/datasets.md:372` | A | A feature users expect. The runner already honours a signal; the call in flight still finishes |
| D-T9-3 | The auto-add rule has no screen (API or `config.json` only) | `docs/datasets.md:91-99`, `:373` | A | Missing feature users expect |
| D-T1-1 | The tag-secret test uses a 61-character key, so the 40-character tag limit rejects it before `secretSpans` runs | `test/datasets-store.test.js:318-332`; `lib/datasets/shape.js:95` | A | Test gap on S2 |
| D-T1-2 | The 0600-after-rewrite test loosens the file once, so the import and delete checks pass trivially | `test/datasets-store.test.js:334-347` | A | Test gap on S11 |
| D-T2-3 | No test puts a secret across the head/tail page edge of `readHeadTail` | `test/trace-registry.test.js:1338-1362` | A | Test gap on S2 (the reviewer's "property that matters most") |
| D-T6-4 | "Replay turn" navigates even when nothing was added for another reason; the skip reason flashes away | `public/datasetview.js:2253-2264` | A | User-facing bug |
| D-T6-5 | Add/Replay silently do nothing while a session switch is loading (`trAddBody` returns null) | `public/datasetview.js:2232-2233`, `:2249-2250` | A | Silent failure |
| D-T7-1 | "Running on <dataset>" is lost after the first poll (`s.progress = r.progress`) | `public/datasetview.js:1476` | A | Wrong UI text (implies the user's own run) |
| D-T7-2 | Poll failures other than 404 are silent and retried every 2 s | `public/datasetview.js:1463-1472` | A | Silent failure |
| D-T7-3 | The original cell says "No longer in the dataset" while examples are loading or failed to load | `public/datasetview.js:195-200`, callers `:1151`, `:1441` | A | Wrong UI text |
| D-T7-4 | A change of 0.004 shows as a green "+0 pts" (tone chosen before rounding) | `public/datasetview.js:1199-1201` | A | Wrong UI text |
| D-T7-5 | The content-off notice says proposals are hidden; only their arguments are | `public/datasetview.js:1067` | A | Wrong UI text |
| D-F-2 | Every dataset view fetches every example in full (auto-add can make that 50–80 MB) | `lib/datasets/api.js:168-172`; `public/datasetview.js:635`, `:2258` | B | Performance with a realistic trigger. Fixed additively with `?view=preview`; the default shape is kept |
| D-F-3 | A judge "no verdict" (daily or cost cap, judge off) is just `null`; the CI table shows FAIL with no hint | `lib/datasets/score.js:127`; `lib/datasets/cli.js:286-321` | B | UX: the cause is hidden |
| D-F-4 | `--ci` with no `--require` passes even when every replay of a model errored | `lib/datasets/cli.js:280-282` | A | Owner decision (2026-10-23): under `--ci` this exits 1, since a gate that checked nothing must not pass |
| D-F-5 | Imported `source.turn` may be any finite number (1.5, −3) | `lib/datasets/shape.js:128` | B | Validation polish |
| D-F-6 | Docs: `risky_command` also reads `cmd`; demo "nothing is written"; "key budgets apply" is wrong for replay (`keyId: null`) | `docs/datasets.md:180`, `:343`, `:136-137`; `lib/datasets/replay.js:3` | B | Docs accuracy |
| D-T5-9 | Import is silent about links that did not resolve (a lossy round trip across restarts) | `lib/datasets/api.js:255-276` | B | Small UX |
| D-T5-3 | The datasets `config.json` save block is a copy of the evals one | `server.js:415` | B | Closed together with M-T6-2 |
| D-T1-6 | `ensureDir` (mkdir 0700 + chmod) is duplicated | `lib/datasets/store.js:25-30` vs `lib/evals/store.js:20-26` | B | Duplication of permission logic |
| D-T3-1 | `rewriteRaw` re-implements `openJsonl.rewrite` | `lib/datasets/experiments.js:90-109` vs `lib/evals/store.js:71-87` | B | Duplication of the atomic write |
| D-T3-2 | Trimming slices a fresh `readFileSync` with byte offsets cached from an earlier read | `lib/datasets/experiments.js:116-121` | B | Cheap hardening against record loss |
| D-N-1 | `lib/datasets/experiments.js` is not Prettier-formatted (new: found by `prettier --check`) | file | B | Style |
| D-T8-1 | The CLI header says "read-only", but creating the gateway seeds missing `agents.json` / `workflows.json` | `lib/datasets/cli.js:1-6` | B | Comment accuracy |
| D-T8-2 | A failed record write drops its cause, and `--json` still reports an `experiment` id that was never stored | `lib/datasets/cli.js:274-278` | B | The failure is reported, but without its cause |
| D-T8-3 | A runner exception prints nothing on stdout with `--json`, so a JSON consumer gets a parse error | `lib/datasets/cli.js:267-270` | B | Small UX ("should not happen") |
| D-T8-4 | `table()` is copied verbatim from `lib/evals/cli.js` | `lib/datasets/cli.js:62-73` vs `lib/evals/cli.js:33-44` | B | Duplication |
| D-T8-5 | `writeState` uses a fixed `evals-state.json.tmp`; CLI and dashboard together can corrupt it and reset the judge caps | `lib/evals/engine.js:81-95` | B | Cheap one-line hardening |
| D-T6-1 | `dsApi`/`dsErrorOf` copy `trApi` with no note why | `public/datasetview.js:320-340` vs `public/traceview.js:636` | B | Duplication (needs a comment) |
| D-T6-2 | The Export click handler is written twice | `public/datasetview.js:557-565`, `:646-655` | B | Duplication |
| D-T6-3 | `dsSlugOf` mirrors the server's `slugify` and `RESERVED` with no drift test | `public/datasetview.js:106`; `lib/datasets/shape.js:24`, `:67` | B | Drift guard |
| D-T6-6 | The 16 MB import check counts file bytes; the server caps the JSON body, which is larger | `public/datasetview.js:480` | B | Small UX (generic 413) |
| D-T6-7 | Accessibility: the reference button is named by its preview text, row labels repeat on every row, focus escapes the picker | `public/datasetview.js` examples view and `dsAddPicker` | B | Small UX |
| D-T6-9 | At 1280 px the tags input clips its value | `public/styles.css` (datasets block) | B | Small UX |
| D-T7-6 | "Not run" and "No longer in the dataset" are styled as failures (red) | `public/datasetview.js:205` | B | Small UX |
| D-T7-8 | The Playground's preview → Send, 409 and 428 decisions have no tests (wiring only) | `public/datasetview.js` `dsPgRun`/`dsPlaygroundAct` | B | Maintainability. The server enforces S4 with the confirm token, so no safety property is unguarded |
| D-T9-2 | The `--json` example shows a rounded `rate: 0.667` | `docs/datasets.md:274`, `:277` | B | Docs |
| D-T3-4 | The plan still says outputs are "capped at 4,000 characters"; the 2 MB record budget and `trimmed` are not named | `docs/superpowers/plans/2026-10-22-datasets-replay.md` R10 | B | Docs |

### Dropped (fixed on main or moot)

- **M-T1-1** (bad `now` gives an `all` no_data): handled by `state.apply` (`lib/monitors/state.js:256-259`) and the engine (`lib/monitors/index.js:410`).
- **M-T2-2**: documented.
- **M-T4-4** (taskkill 502): the UI explains it.
- **M-T4-5**: correct as written.
- **M-T4-6** (broad APPS patterns): candidates need `isAgentBinary` (`control.js:337`); the `verify()` part is M-R2-2.
- **M-T4-7**: copy is in the UI and the docs.
- **M-T4-8** (unknown `by` fails open): fixed at `control.js:168`.
- **M-T5-6** (snooze suspends auto-pause): documented in `docs/monitors.md:46`.
- **M-T6-5**, **M-T6-7** (`none` code wording): both done.
- **M-T6-11** (shared import line): merged.
- **M-T8-1..4**: fixed in `afb9816`.
- **M-F-6**: fixed.
- **M-R1-1** (`codex.js` anywhere): fixed in `b147a46`.
- **D-T3-6** (flaky CLI test): fixed in `7970b01`.
- **D-T3-7** (`list()` shares cache rows): `structuredClone` at `experiments.js:136`.
- **D-T3-8** (judge ignores backoff): `waitingOut` check in `judgeMaterial`.
- **D-T4-2** (no `tierOf` unusable test): covered at `test/datasets-replay.test.js:90-116`.
- **D-T5-5a** (demo export raw ids unchecked): covered at `test/datasets-api.test.js:815`.
- **D-T6-10** (CSS at EOF): merged.
- **D-T9-1** (`stopped` values): fixed in `b4c503f`.

---

## Task order and file ownership

Monitors (Tasks 1–3) and Datasets (Tasks 4–7) are two independent streams. Inside a stream, run the tasks in order. The overlaps between the streams are:

- **`server.js`:** Task 1 changes one line (`AGENTS_OFF`). Task 2 owns the rest. No Datasets task touches it.
- **`lib/monitors/api.js`:** Task 1 adds the off-reason, then Task 2 makes its changes.
- **`public/datasetview.js`, `public/styles.css`, `test/datasets-ui.test.js`:** Task 6, then Task 7.
- **`lib/trace/index.js`:** Task 2 only (an additive option). Task 4 touches only `test/trace-registry.test.js`.

Run `node --test` on the task's test files after each task, and the full `npm test` after Tasks 3 and 7.

---

### Task 1: Agent control — verify the program, off without sign-in, a lighter paused list

**Files:**
- Modify: `lib/agents/control.js`, `lib/processes.js`, `lib/audit.js`, `lib/monitors/api.js` (off reason only), `server.js` (the `AGENTS_OFF` line only)
- Test: `test/agents-control.test.js`, `test/processes.test.js`, `test/monitors-api.test.js`, `test/audit.test.js`

**Closes:** M-R2-2, M-F-3, M-T6-9 (A); M-F-5, M-R2-1, M-F-8 (B).

**Behaviour:**

- **M-R2-2: `verify()` checks the program on POSIX.**
  - After the existing `!p.app` check, refuse a row unless at least one source `s` has `APPS_FOR[s].has(p.app.id) && isAgentBinary(s, p.row.argv)`. The refusal is 403 `not an AI agent process`, audited as every refusal is.
  - Apply this only when `platform !== 'win32'`. Windows rows carry no `argv`, and Stop there keeps the plain APPS gate.
  - **Exception:** a pid that is in this server's `paused` map with a matching start time (`sameStart`). An agent we paused can always be resumed or stopped.
  - `listPaused()` filters the OS-stopped rows it reports after a restart (its second loop) the same way. The paused banners then never offer a wrapper or helper that `verify()` would refuse.
- **M-F-5: the paused list and `verify()` skip `lsof`.**
  - `lib/processes.js` `rows({ cwds = true } = {})` skips `withCwds` when `cwds` is false. `withArgv` still runs, because the program check needs it.
  - In `control.js`, `table({ cwds })` forwards the option:
    - `candidates()` keeps `cwds: true`;
    - `verify()` and `listPaused()` pass `cwds: false`.
  - Fakes that ignore the argument still work.
- **M-F-3: control is off without sign-in.**
  - In `server.js`, `AGENTS_OFF` also holds when `auth.mode === 'none' && !DEMO`.
  - Pass the reason to `createMonitorApi` as `agentsOff: 'server' | 'no-sign-in' | false`. `true` keeps meaning `'server'`, so existing callers still work.
  - Demo with auth none keeps the controls shown, and demo never signals.
  - In `lib/monitors/api.js`:
    - `offReason()` returns `'no-sign-in'` in that case;
    - `OFF_TEXT['no-sign-in']` is `agent control is off without a dashboard sign-in`;
    - `act` and `candidates` refuse 403 with the text for the active reason. `'server'` keeps `agent control is off in server mode`.
  - `GET /api/monitors/status` reports `agents: { available: false, reason: 'no-sign-in' }`.
  - `POST /api/monitors/<rule>` with `autoPause: true` → 409 with that text.
  - The UI wording comes in Task 3. Until then the generic "off on this server" note shows.
- **M-R2-1: `comm` is argv[0].** Reword the comment at `lib/processes.js:291` (and any doc line that repeats it) to "argv[0] as the process was started (or rewrote it), read whole". Change the fixture at `test/processes.test.js:74-85` so that comm equals the first word as started (for example `node`), not a full node path.
- **M-F-8: audit folder mode.** In `lib/audit.js:12`, `mkdirSync(..., { recursive: true, mode: 0o700 })`.

**Tests (each fails before the fix):**

- **`agents-control`: the pre-signal check refuses a wrapper and a helper.**
  - Fake table rows carry `argv`: a `disclaimer --pgroup -- …/claude.app/Contents/MacOS/claude` row (app `claude-desktop`) and a `…/Codex Framework.framework/…/Codex (Renderer)` row (app `codex`).
  - `pause` of each rejects with status 403 and `/not an AI agent/`. The fake `kill` records no call. The audit fake records the refusal.
  - The desktop `claude` row is still accepted.
- **`agents-control`: a process we paused can be resumed even when its argv is unreadable.** Pause a real-binary row, then make the next table read return the row without `argv`. `resume` succeeds with `SIGCONT`.
- **`agents-control`: OS-stopped rows are filtered.** After a restart (new control, empty `paused` map), a `stopped: true` `disclaimer` row is not in `paused()`, and a `stopped: true` real `claude` row is.
- **`agents-control`: the option each path passes.**
  - The fake `processes.rows` records its argument.
  - `paused()` and `pause()` pass `{ cwds: false }`.
  - `candidates()` passes no option or `{ cwds: true }`.
- **`processes`: `rows({ cwds: false })` does not call `lsof`.** Inject or stub `execFile` the way the existing `withCwds` tests do, and assert no `lsof` spawn.
- **`monitors-api`, in process: off without sign-in.** With `agentsOff: 'no-sign-in'`:
  - status reports `reason: 'no-sign-in'`;
  - `POST /api/agents/pause` → 403 `/without a dashboard sign-in/`;
  - `autoPause: true` → 409;
  - the fake control's `calls` stay empty.
- **`monitors-api`, spawned (M-F-3).**
  - `startServer({ ZAAFPULSE_AUTH: 'none' })` without `DEMO`: `GET /api/monitors/status` gives `agents.available === false` and `reason === 'no-sign-in'`.
  - With `DEMO: '1'` it stays available.
  - Check the existing spawned tests that use `ZAAFPULSE_AUTH: 'none'` (`:739`, `:793`) still pass.
- **`monitors-api` (M-T6-9).** In the password-mode test (`:872-879`):
  - also assert `r.json.error` matches `/server mode/`;
  - after the three POSTs, assert that `<data>/.data/agent-audit.jsonl` is absent or holds no line. The control layer audits every refusal it makes, so an empty log proves the API gate refused first.
  - Show that the test fails by temporarily removing the `if (agentsOff)` line in `act`.
- **`audit` (POSIX only).** `createAudit(<tmp>/new/dir/a.jsonl).record({})` creates `new/dir` with mode 0700.

**Commit:** "Check the agent's own program before every signal, turn agent control off without sign-in, and list paused agents without lsof"

---

### Task 2: Monitors engine and API — ended sessions, the after-refresh pass, cheaper polls

**Files:**
- Modify: `lib/monitors/index.js`, `lib/monitors/api.js`, `lib/trace/index.js` (additive option), `server.js`
- Test: `test/monitors-engine.test.js`, `test/monitors-api.test.js`, `test/monitors-state.test.js`, `test/trace-registry.test.js`

**Closes:** M-F-4, M-T5-2, M-T6-10 (A); M-F-1, M-F-2 (with M-T6-3), M-T6-8, M-T6-2 (with D-T5-3), M-F-7 (B).

**Behaviour:**

- **M-F-4: ended live sessions.**
  - New constant `LIVE_STALE_MS = 60_000`, which is 12 live passes.
  - In `lib/monitors/api.js`, a live rule's instance whose `lastSeen` is older than `now() − LIVE_STALE_MS` is left out of the rule row's `instances`. It therefore no longer drives the card's overall state.
  - Such an instance is also left out of `/api/monitors/status` `counts`.
  - `lib/monitors/index.js` `status()` counts the same way.
  - Aggregate instances (`'all'`) are never treated as stale.
  - The alert history is unchanged.
  - The state machine is unchanged: no resolution is sent, and pruning still happens at 24 h.
- **M-T6-10: after-refresh wiring.**
  - Move the waiting poller from `server.js:572-586` into `lib/monitors/index.js` as an exported `createAfterRefresh({ indexing, run, pollMs = 250, timers = { setInterval, clearInterval } })`. It returns a function with these properties:
    - a call while one poller is waiting returns at once;
    - the poller checks `indexing()` every `pollMs` and, once it is false, clears itself and calls `run()` once;
    - a rejection from `run()` is caught;
    - the timer is `unref`'d when it supports that.
  - `server.js` builds it with `indexing: () => indexer.state.indexing` and `run: monitorTick`, and uses it where `monitorTickAfterIndex` is used now (`:1287`).
- **M-F-1: skip the live pass when nothing needs it.**
  - In `pass('live')`, before `build`: if no live rule is enabled, and no rule in `AUTO_PAUSE` is both enabled and `autoPause`, return without reading the office snapshot.
  - In that case `live` becomes `null` and `lastLive` is unchanged.
  - `daily_cost` with auto-pause still needs live sessions to find its target, so it keeps the pass running.
- **M-F-2: no forced rebuild from the monitors API.**
  - `trace.keyFor(source, sid, { rebuild = true } = {})`. With `rebuild: false` it never calls `collect(true)` (the demo alias still applies).
  - `keyMemo` in `lib/monitors/api.js` passes `{ rebuild: false }` for both sources.
  - A session not yet listed gets `sessionKey: null` until the next listing.
- **M-T6-8: the channel secrets.**
  - Decide "there will be a URL" from the resolved input before anything is stored:
    - an absent `urlIn` → a saved URL exists;
    - `mode: 'none'` → no URL;
    - `mode: 'keep'` → a saved URL exists;
    - `mode: 'store'` → a non-empty value;
    - `keychain` or `env` → a non-empty reference.
  - Headers with `mode !== 'none'` and no URL → 400 `set the webhook URL first`, with `resolveSecret` never called.
  - Resolve the headers **before** the URL when both are set. A headers failure then leaves no new URL secret behind.
  - Add a one-line comment saying a cleared URL leaves the old headers secret in the store (no delete API).
- **M-T6-2 / D-T5-3: one config writer.**
  - Add `saveConfigSection(name, value)` to `server.js`:
    - in demo, it sets `rawCache.value = { ...rawCache.value, [name]: value }`;
    - otherwise it writes `JSON.stringify({ ...rawConfig(), [name]: value }, null, 2)` to `${CONFIG_FILE}.tmp`, renames it over `CONFIG_FILE`, and refreshes `rawCache` from the new mtime.
  - Replace the five copies (gateway, evals, datasets, monitors channels, brain) with calls to it. The monitors channel save still builds its own section object first.
  - The gateway and brain saves now also refresh `rawCache`. That is harmless, because `rawConfig()` would reload on the mtime change anyway.
- **M-F-7.** Run `npx prettier --write test/monitors-state.test.js` (formatting only).

**Tests (each fails before the fix):**

- **`monitors-api` (M-F-4).**
  - The fake state holds two triggered `tool_loop` instances, with `lastSeen` at `now − 61_000` and `now − 5_000`.
  - `GET /api/monitors` lists only the fresh instance for `tool_loop`, and `GET /api/monitors/status` has `counts.triggered === 1`.
  - An aggregate `'all'` instance with an old `lastSeen` still counts.
- **`monitors-engine` (M-F-4).** The same staleness rule applies in `status()` counts.
- **`monitors-engine` (M-T6-10).** Use fake timers and `createAfterRefresh`:
  - while `indexing()` is true, `run` is not called;
  - five calls while waiting create one interval, and `run` is called exactly once after `indexing()` turns false;
  - a rejecting `run` causes no unhandled rejection.
- **`monitors-engine` (M-F-1).** The fake `office.snapshot` counts its calls:
  - with every live rule off and no auto-pause, `tickLive()` makes 0 calls;
  - with `cost_burn` enabled, it makes 1;
  - with every live rule off but `daily_cost` enabled with `autoPause`, it makes 1.
- **`monitors-api` (M-F-2).** The fake `trace.keyFor` records its third argument. Every call from `/api/alerts`, `/api/monitors` and `/api/monitors/status` passes `{ rebuild: false }`.
- **`trace-registry` (M-F-2).** `keyFor('codex', 'missing', { rebuild: false })` throws the unknown-session error without a forced collect. Check this the way the existing `lastForce` tests do: a following default `keyFor` for a session added since still finds it.
- **`monitors-api` (M-T6-8).** Use a `resolveSecret` fake that records its calls, with no webhook saved:
  - `{ webhookRef: { mode: 'keep' }, webhookHeadersRef: { mode: 'store', value: 'X-A: b' } }` → 400, no `resolveSecret` call;
  - `{ webhookRef: { mode: 'store', value: '' }, webhookHeadersRef: { mode: 'store', value: 'X-A: b' } }` → 400, no call;
  - with a headers resolve that throws, the URL resolve is not called.
- **`monitors-state` (M-T5-2), guarding existing behaviour.** `markActed`, snooze 1 h, then inside the snooze:
  - **Short blip:** `ok` then `triggered` again less than `RESOLVE_HOLD_MS` apart. After the snooze ends with the instance still triggered, `pending(rule)` does not list it, because the mark is kept.
  - **Long hold:** `ok` held at least `RESOLVE_HOLD_MS`, then triggered after the snooze. `pending` lists it again.
  - Show the first case fails if `settleMark` clears `actedAt` on any `ok`.
- **Server config refactor:** no new test. The spawned monitors-channels, datasets-settings and evals-settings tests must stay green.

**Commit:** "Hide ended sessions from monitor counts, test the after-refresh pass, skip unneeded live passes and trace rebuilds, and share the config writer"

---

### Task 3: Monitors UI and docs

**Files:**
- Modify: `public/monitorsview.js`, `docs/monitors.md`, `docs/superpowers/plans/2026-10-22-monitors-agent-control.md`
- Test: `test/monitors-ui.test.js`

**Closes:** M-T7-1, M-T7-2, M-T7-3, M-T7-4, M-T7-5, M-T5-4 (A); M-T8-5, M-R2-3, M-R2-4, M-R1-3 (B). Also the UI wording and docs for Tasks 1–2.

**Behaviour:**

- **M-T7-1: keep focus.**
  - Add `monWriteHtml(el, html)`:
    - it writes `el.innerHTML` only when `html` differs from the last HTML written to that element (kept in a `WeakMap`);
    - when it writes while `document.activeElement` is inside `el`, it first records a focus key and restores focus to the matching element afterwards. The key is the first of `data-mon-act`, `data-mon-pick` (with its value), `data-mon-choose` or `data-mon-param` that the element carries.
  - `monPaintDrawer` (`#drawer-body`) and `monTracePaint` use it.
- **M-T7-2: report alert-poll errors.**
  - `monPoll`'s catch sets `MON.error = monText(e.message) || 'the server did not answer'`. A successful poll sets it to `''`.
  - The alerts drawer shows one of two texts:
    - before the first successful read: `Could not read the alerts: <error>. Trying again every 15 s.`;
    - after one: a muted line above the rows, `Could not refresh the alerts (<error>). These are the alerts read at <HH:MM>.`
  - Polling continues every 15 s as now.
- **M-T7-3: say why there is nothing to act on.**
  - In inline mode, a session with no candidate shows the `monAgentNote` text (class `off`) when `t.reason === 'not-indexed'` or the candidate count is 0.
  - For `reason === 'unsupported'` (non-agent sessions) it shows nothing, so gateway sessions stay quiet.
- **M-T7-4: a Stop that did not end the process.** Move the after-action update into an exported pure `monAfterAction(t, c, action, r)`:
  - a stop removes `c` from `t.cands` only when `r.exited === true`;
  - a demo answer changes nothing;
  - pause and resume set `c.paused` as now.
- **M-T7-5: revert a refused parameter.**
  - Add an exported `monParamShown(rule, k)`: the string the input shows for the saved value, the same `show()` the card uses.
  - When `saveRule` fails for a `params` patch, and when `monParamValue` returns an error, the input is reset to `monParamShown(savedRule, k)`.
- **M-T5-4: `maxCalls` is not measured.**
  - `monRuleCard` does not render an input for `maxCalls`.
  - For `tool_loop` it renders the muted line `Too many tool calls in one turn: not measured yet, so only loop signals trigger this rule.`
  - The API still accepts the parameter.
- **Task 1 wording.** `monAgentNote` with `off === 'no-sign-in'` returns `Agent control is off because this dashboard runs without sign-in (ZAAFPULSE_AUTH=none), so any program on this machine could use it. Start it with the default sign-in to pause, resume or stop agents.`
- **Docs (`docs/monitors.md`):**
  - Known limits:
    - `Control is off in server mode, with password sign-in, without sign-in (ZAAFPULSE_AUTH=none) and in Docker.`
    - Replace "Pause is not undone by anything but you" (M-T8-5) with `A paused agent is never resumed or stopped automatically; only you resume or stop it.`
  - `:140`: the `agents.reason` values are `server`, `no-sign-in` or `docker`.
  - Linking section (M-R2-3, M-R2-4), two sentences:
    - `An npm-installed Codex runs as a node wrapper and a native codex process; both match, so you choose, and auto-pause reports "several" instead of acting.`
    - `On macOS a node script whose path holds a space is not matched (no candidate).`
  - Notes:
    - `A live session that has not been seen for a minute (it ended or went idle) leaves the rule card and the counts; its alerts stay in the history.`
    - `The live check is skipped while no live rule and no auto-pause is on.`
- **Plan table (M-R1-3), `2026-10-22-monitors-agent-control.md` rules table:**
  - `month_projection` threshold: `projection > budget, from local 00:00 on the 4th of the month`.
  - `accuracy_drop` threshold: append `, once today and the previous 7 days each have ≥ minSamples (20) tool results`.

**Tests (`test/monitors-ui.test.js`, each fails before the fix; export the helpers named above, and `monAgentHtml` and `monRuleCard` if not exported):**

- **`monWriteHtml`.** Use a fake element with a counting `innerHTML` setter and a fake `document.activeElement` inside it carrying `data-mon-act="stop"`:
  - the same HTML twice → one write;
  - new HTML → a second write, and `focus()` is called on the new element that `[data-mon-act="stop"]` selects.
- **Alerts body.** Expose the drawer's alerts body as a pure `monAlertsBody({ alerts, loaded, error, readAt })`:
  - `loaded: false` with an error contains `Could not read the alerts: boom. Trying again every 15 s.`;
  - `loaded: true` with an error contains `Could not refresh the alerts (boom)`.
- **Inline notes.** `monAgentHtml(t, 'inline')` with `cands: []`, `canPause: true`:
  - `reason: 'not-indexed'` contains `not in the index yet`;
  - `reason: 'none'` contains `No running agent process matches`;
  - `reason: 'unsupported'` returns `''`.
- **`monAfterAction`.** A stop with `exited: false` keeps the candidate, `exited: null` keeps it, and `exited: true` removes it.
- **`monParamShown`.** For a percent param it returns the saved value as shown, for example `0.8` → `'80'`.
- **`monRuleCard`.** A `tool_loop` row has no `data-mon-param="maxCalls"` and contains `not measured yet`.
- **`monAgentNote`.** `{ available: false, off: 'no-sign-in' }` contains `ZAAFPULSE_AUTH=none`.

**Commit:** "Keep focus and report poll errors in the alerts drawer, say why a session has no agent, keep a process a Stop did not end, and document control without sign-in"

---

### Task 4: Datasets server — external cost floor, a stop route, a light view, privacy tests

**Files:**
- Modify: `lib/datasets/replay.js`, `lib/gateway/index.js` (replay accessor, additive), `lib/datasets/api.js`, `lib/datasets/shape.js`
- Test: `test/datasets-replay.test.js`, `test/datasets-api.test.js`, `test/datasets-store.test.js`, `test/trace-registry.test.js`

**Closes:** D-F-1, D-T5-6 (server), D-T1-1, D-T1-2, D-T2-3 (A); D-F-2 (server), D-T5-9, D-F-5, D-F-6 (the `replay.js` comment) (B).

**Behaviour:**

- **D-F-1: count at least an estimate for external calls.**
  - `gateway.replay` gains `priceOf: (name) => usage.priceOf(name)`, the same function the judge accessor exposes.
  - In `once()`, for an `external` model with `price = replay.priceOf(model)`, compute:
    - `inEst = chars / 4 × price.input / 1e6`, where `chars` is the characters of every sent message `content` plus every sent tool's name and description;
    - `outEst = (reply text chars + proposal argument chars) / 4 × price.output / 1e6`.
  - The charged cost is the reported cost when `usage` is present, `usage.cost` is finite and ≥ 0, `usage.input > 0`, and `cost ≥ inEst`. Otherwise it is `max(reported or 0, inEst + outEst)`.
  - A failed external call counts `inEst`, because the text may have reached the provider (as the judge counts it).
  - Private models are unchanged: the cost is as reported, and 0 is allowed.
  - A missing `priceOf` or a null price falls back to today's behaviour.
- **D-T5-6: stop a run between calls.**
  - `start()` creates an `AbortController` per run and passes `signal` to `runner.run`.
  - New route `POST /api/experiments/:id/cancel` (JSON body `{}`; 415 without JSON):
    - the running id → 202 `{ id, status: 'cancelling' }`, idempotent;
    - a stored record's id → 409 `{ error: 'the run has already ended' }`;
    - an id of the right shape that is unknown → 404 `unknown experiment`;
    - a bad shape → 400.
  - While cancelling, `GET /api/experiments/:id` returns `progress.cancelling: true`.
  - The record ends `status: 'stopped', stopped: 'cancelled'`.
  - The call in flight finishes and is recorded (R8; controller decision). Its judge evaluators get no verdict because the signal is aborted; this is existing runner behaviour.
- **D-F-2: a light view.**
  - `GET /api/datasets/:slug?view=preview` returns the same `{ dataset, examples }` shape, with these changes:
    - `input.system`, every `input.messages[].text` and `output.text` are cut to their first 600 characters;
    - each `input.tools[].description` becomes `''`;
    - `reference.text`, `tags`, `evals`, `feedback` and `link` are whole;
    - a row where anything was cut has `cut: true`.
  - R7 nulls still apply.
  - Any other `view` value → 400 `view must be preview`.
  - The default (no `view`) is unchanged.
- **D-T5-9: report dropped links.** The import reply adds `links: { kept, dropped }`:
  - `kept` counts the lines whose `source.key` resolved through `trace.sourceOf`;
  - `dropped` counts those whose key did not resolve and were imported with `source: null`.
- **D-F-5: whole turns.** In `shape.js:128`, `source.turn` must be `Number.isInteger(turn) && turn >= 0`, with the reason `source.turn must be a whole number from 0`.
- **D-F-6 (code comment).** The `replay.js:3` header says `usage, cost and OTLP export apply; calls are recorded as dashboard calls (no API key, so no key budget applies)`.

**Tests (each fails before the fix; test-gap items show failure by breaking the guarded line):**

- **`datasets-replay` (D-F-1).**
  - The fake replay has `tierOf('ext/m') === 'external'` and `priceOf('ext/m') → { input: 10, output: 30 }`. `complete` returns `{ text: 'x'.repeat(4000), usage: undefined }`, and the example's messages hold 4,000 characters. That gives `inEst = $0.01` and `outEst = $0.03`.
  - With 3 examples and `maxCostUSD: 0.05`:
    - the first row's `cost` is about `0.04` (within 1e-9);
    - the run stops with `stopped: 'cost cap'` after 2 calls.
  - A private model with no usage still costs 0.
  - An external call that throws counts `inEst`.
- **`datasets-api` (D-T5-6).** The fake runner waits on a deferred per call and honours `signal`:
  - start → 202;
  - `POST /api/experiments/<id>/cancel` with `{}` → 202 `cancelling`;
  - `GET` shows `progress.cancelling: true`;
  - releasing the call gives a stored record with `stopped: 'cancelled'`;
  - a second cancel after the end → 409;
  - an unknown id → 404;
  - a non-JSON POST → 415.
- **`datasets-api` (D-F-2).** An example with a 5,000-character output and a 900-character reference:
  - `?view=preview` gives `output.text.length === 600`, the reference whole and `cut: true`;
  - no `view` gives 5,000;
  - `?view=x` → 400.
- **`datasets-api` (D-T5-9).** Import two keyed lines, one key the fake `trace.sourceOf` resolves and one it does not. The reply has `links: { kept: 1, dropped: 1 }`.
- **`datasets-store` (D-F-5).** `cleanExample` refuses turns `1.5` and `-3` with the reason above, and accepts `0`.
- **`datasets-store` (D-T1-1).**
  - Build at runtime a ≤ 40-character key that `sig.secretSpans` matches and that fits the tag pattern. For example, an AWS-style `AKIA` + 16 characters from `[0-9A-Z]`, not the documented example key, which the placeholder check may skip.
  - Assert first that `TAG` accepts it and `secretSpans` finds it, then that `cleanExample(ex({ tags: [k] })).ok === false`.
  - Show that it fails when the `secretSpans` clause at `shape.js:95` is removed.
- **`datasets-store` (D-T1-2).** Before each of `update`, `importJsonl` and `removeExample`, `chmod` the file to 0644, and assert 0600 after each (POSIX only).
- **`trace-registry` (D-T2-3).**
  - Plant a runtime-built key at the head/tail page edge of a 70,000-character answer: start it at `half − 20`, where `half` is the page size `readHeadTail` uses, with a space before it.
  - `t.example(...)` output contains `hidden›` and never the raw key.
  - Show that it fails if the second page is read without masking.

**Commit:** "Count external replay cost at least by its estimate, add a stop route for experiments and a light dataset view, and pin the masking and file-mode tests"

---

### Task 5: Datasets CLI gate and stores

**Files:**
- Modify: `lib/datasets/cli.js`, `lib/datasets/score.js`, `lib/evals/cli.js` (export `table`), `lib/evals/engine.js` (`writeState`), `lib/evals/store.js`, `lib/datasets/store.js`, `lib/datasets/experiments.js`
- Test: `test/datasets-cli.test.js`, `test/datasets-score.test.js`, `test/datasets-experiments.test.js`, `test/evals-engine.test.js`

**Closes:** D-F-3, D-F-4, D-T8-1, D-T8-2, D-T8-3, D-T8-4, D-T8-5, D-T1-6, D-T3-1, D-T3-2, D-N-1 (all B).

**Behaviour:**

- **D-F-3: keep why a verdict is missing.**
  - When the judge reply is not ok, `scoreResult` still stores `null` for that evaluator. It also adds `missing: { [evaluator]: reason }` to the row, where `reason` is the reply's `reason` cut to 60 characters, or `no verdict`. Reasons are fixed engine strings, never content.
  - `summarize` adds `missing: { <reason>: n }` to `summary.models[m].evaluators[id]`, only when n > 0. This is additive, like `trimmed`.
  - The CLI prints, for each such evaluator and model, one stderr line: `<evaluator> on <model>: <n> of <total> had no verdict (<reason>: <n>, …)`.
  - `--json` carries `missing` inside `evaluators` (it already spreads the summary).
- **D-F-4: a gate that checked nothing fails (owner decision 2026-10-23).**
  - After the run, for each model whose `summary.models[m].errors` equals that model's attempted rows (> 0), print to stderr: `Every replay against <model> failed; the pass rates above count them as not passing.`
  - `--json` adds `allFailed: [<model>, …]`, empty when none.
  - With `--ci`, a non-empty `allFailed` makes the exit code 1 (and `ok: false` in `--json`), with or without `--require`. Without `--ci` the exit code is unchanged. Configuration errors stay 2.
- **D-T8-1.** The header comment says that building the gateway may create missing `agents.json` / `workflows.json` in the data folder, as the dashboard does. No config, key or record is written before the run.
- **D-T8-2.**
  - The store catch reports `Could not store the experiment record in experiments.jsonl (<e.code or 'error'>).` No path appears.
  - `--json` gains `stored: true|false`.
  - Exit codes are unchanged.
- **D-T8-3.**
  - With `--json`, a runner exception prints `{ "ok": false, "error": "the replay failed" }` on stdout, in addition to the stderr line. Exit stays 1.
  - Add an optional `createRunner` in `replayRun`'s context (default `createReplayRunner`) as the test seam.
- **D-T8-4.** Export `table` from `lib/evals/cli.js`. `lib/datasets/cli.js` requires it and deletes its copy.
- **D-T8-5.**
  - `writeState` uses `${file}.${process.pid}.tmp`, so CLI and dashboard never share a temp file.
  - On failure it removes its own temp file.
  - Export `writeState` for the test if it is not exported.
- **D-T1-6.** Export `ensurePrivateDir(dir)` from `lib/evals/store.js`: return if the folder exists; else `mkdirSync` recursive 0700, then a quiet `chmod` 0700 on POSIX. `openJsonl` and `lib/datasets/store.js` use it.
- **D-T3-1.**
  - `openJsonl` gains `rewriteText(data)`: `rewrite(rows)` builds the text and calls it, and the temp file, mode, rename and cleanup stay as now.
  - `experiments.js` replaces `rewriteRaw` with `io.rewriteText`.
- **D-T3-2.**
  - When a trim is due, `append` reads the file once, parses that buffer into line ranges with the same parser `load()` uses, and slices **that** buffer. Factor the parser out of `load()`.
  - It never reuses `cache.lines` offsets against a fresh read.
- **D-N-1.** Run `npx prettier --write lib/datasets/experiments.js`.

**Tests (each fails before the fix; refactors D-T1-6, D-T3-1 and D-T8-4 keep behaviour, and the existing suites must stay green):**

- **`datasets-score` (D-F-3).** A judge fake returns `{ ok: false, reason: 'daily cap' }` for 2 of 3 rows. The summary for that evaluator holds `missing: { 'daily cap': 2 }`, and a code evaluator has no `missing`.
- **`datasets-cli` (D-F-3).** The same through the CLI with `--json`: stderr has `had no verdict (daily cap: 2)`, and the JSON evaluators carry `missing`.
- **`datasets-cli` (D-F-4).** A fake provider that fails every call: stderr has `Every replay against <model> failed`, JSON has `allFailed: ['<model>']`, and the exit code is 1 under `--ci` without `--require` (0 without `--ci`).
- **`datasets-cli` (D-T8-2).** Make `<data>/.data/experiments.jsonl` a directory: stderr matches `/Could not store the experiment record in experiments\.jsonl \((E[A-Z]+|error)\)/`, and JSON has `stored: false`.
- **`datasets-cli` (D-T8-3).** An injected `createRunner` whose `run` throws, with `--json`: stdout parses to `{ ok: false, error: 'the replay failed' }`, and the exit code is 1.
- **`evals-engine` (D-T8-5).** Create a directory at `${stateFile}.tmp`. `writeState` still writes the state file (it fails before, because the fixed temp name is taken).
- **`datasets-experiments` (D-T3-2).**
  - Fill the store to `max` with records of different lengths.
  - Wrap `fs.readFileSync` so that the read inside `append` returns the file after another writer replaced one record with a longer one.
  - After `append`, every kept line parses and carries an expected id (no fragments).

**Commit:** "Show why judge verdicts are missing and when every replay failed, report a lost record's cause, and share the private-folder and rewrite helpers"

---

### Task 6: Datasets UI — the auto-add screen, Stop, and honest run and replay messages

**Files:**
- Modify: `public/datasetview.js`, `public/styles.css`
- Test: `test/datasets-ui.test.js`

**Closes:** D-T9-3, D-T5-6 (UI), D-T6-4, D-T6-5, D-T7-1, D-T7-2, D-T7-3, D-T7-4, D-T7-5 (A); D-F-2 (UI) (B).

**Behaviour:**

- **D-T9-3: the auto-add screen.**
  - Add an **Auto-add** section to the Datasets list view, below the list, read from `GET /api/datasets/settings`. Its controls:
    - a switch, `Add turns that went wrong automatically` (`enabled`);
    - a dataset select listing the existing datasets by name, with the slug as the value;
    - a checkbox, `When a judge evaluator fails a turn` (`onFail`);
    - a checkbox, `When you rate a turn 👎` (`onBad`);
    - a **Save** button with a status line.
  - Save posts `{ autoAdd: { enabled, dataset, onFail, onBad } }` and shows the server's error text on 400.
  - Client check, via an exported `dsAutoAddBody(form)`: enabled with no dataset → `Pick a dataset for auto-add`.
  - With no datasets, the select is disabled and shows `Create a dataset first`.
  - With content off, the note `Auto-add does nothing while content viewing is off.` shows above the controls.
  - Dataset names render through `textContent` only.
- **D-T5-6 (UI): Stop.**
  - While a run is shown as running (own or followed), the Playground progress block has a button: `Stop after the current call`.
  - A click posts `POST /api/experiments/<id>/cancel` with `{}`. The button is then disabled with `Stopping…`, and the progress line appends ` · stopping after the current call`. A 409 means the run already ended, so keep polling.
  - `dsStopLine` maps `stopped: 'cancelled'` to `Stopped before the end, on request`.
- **D-T6-4: Replay only when there is an example.**
  - Move the decision into an exported `dsReplayTarget({ slug, added, skipped, examples, item })`. It returns either `{ hash }` (when an id is found in `added` or by key and turn) or `{ message }`.
  - The message is `Not replayed: <first skipped reason>`, or `Not replayed: the turn was not found in the dataset`.
  - The message stays in the picker's result line and nothing navigates.
- **D-T6-5: say when the session is still loading.**
  - Add an exported `dsAddOrWhy(sel, S)`. It returns `{ body }`, or `{ why: 'The session is still loading. Try again in a moment.' }` when `trAddBody` returns null.
  - The Add and Replay clicks show `why` in the Explorer's notice or status line instead of doing nothing.
- **D-T7-1.** `s.progress = { ...s.progress, ...r.progress }`, through an exported `dsMergeProgress(prev, next)` that keeps `dataset`.
- **D-T7-2: report poll failures.**
  - On a non-404 poll error, set `s.msg = 'Could not refresh the progress. Retrying…'` (neutral tone) and keep polling with backoff from an exported `dsPollDelay(failures)`: 2,000 ms × 2^failures, capped at 30,000 ms.
  - A successful poll resets the count and clears the message.
- **D-T7-3: no false "deleted".**
  - `dsResultCells(record, example, examplesState)`, with `examplesState` one of `'loading'`, `'error'` or `'ready'`. When the example is missing, the original cell shows:
    - `Loading the dataset…` for loading;
    - `Could not read the dataset` for error;
    - `No longer in the dataset` only for ready.
  - The callers at `:1151` and `:1441` pass the state they know.
- **D-T7-4.** Add an exported `dsDeltaText(d)` → `{ text, tone }`:
  - `null` → `{ '—', '' }`;
  - otherwise `p = Math.round(d * 100)`: `p === 0` → `{ '±0', '' }`, else `+p pts` / `−|p| pts` with tone `up` / `down`.
- **D-T7-5.** The content-off notice reads `Labels and pass rates are shown; outputs, proposal arguments and errors are not.`
- **D-F-2 (UI).** The examples view (`:635`) and the Replay lookup (`:2258`) fetch `dsPath(slug) + '?view=preview'`. The Experiments tab and the Playground keep the full fetch, because they show whole original outputs.

**Tests (each fails before the fix):**

- **`dsAutoAddBody`.** Enabled with no dataset → `{ error: 'Pick a dataset for auto-add' }`. A full form → the exact `{ autoAdd: { … } }` body.
- **Auto-add section render.** Use a fake `document` that throws on any `innerHTML` set (as the existing `dsPvModel` test does). A dataset named `<img src=x onerror=1>` appears as an option's text. With content off, the note is present.
- **Stop.**
  - `dsStopLine({ status: 'stopped', stopped: 'cancelled' })` returns `Stopped before the end, on request`.
  - Render the progress block for a running state with the fake document: the Stop button is present, and in the `cancelling` state it is disabled and reads `Stopping…`.
- **`dsReplayTarget`.**
  - `added: [{ id: 'e1' }]` → a hash with `&ex=e1`.
  - `added: []`, `skipped: [{ reason: 'this session has no text' }]` with no match → `{ message: 'Not replayed: this session has no text' }`.
  - An already-saved example found by key and turn → a hash with its id.
- **`dsAddOrWhy`.** With `trAddBody` returning null → the `why` text.
- **`dsMergeProgress`.** It keeps `dataset` when the next progress lacks it.
- **`dsPollDelay`.** 0 → 2000, 1 → 4000, 4 → 30000, 9 → 30000.
- **`dsResultCells`.** A missing example gives `Loading the dataset…`, `Could not read the dataset` or `No longer in the dataset` for the three states.
- **`dsDeltaText`.** `0.004` → `±0` with no tone; `0.006` → `+1 pts`, `up`; `-0.2` → `−20 pts`, `down`.
- **Content-off notice.** It contains `proposal arguments`.

**Commit:** "Add the auto-add screen and a Stop button, and keep replay, progress and result messages accurate"

---

### Task 7: Datasets UI polish and docs

**Files:**
- Modify: `public/datasetview.js`, `public/styles.css`, `docs/datasets.md`, `README.md` (API row only), `docs/superpowers/plans/2026-10-22-datasets-replay.md`
- Test: `test/datasets-ui.test.js`

**Closes:** D-T6-1, D-T6-2, D-T6-3, D-T6-6, D-T6-7, D-T6-9, D-T7-6, D-T7-8, D-T9-2, D-F-6 (docs), D-T3-4 (all B). Also the docs for Tasks 4–6.

**Behaviour:**

- **D-T6-1.** Add a comment above `dsApi` saying it is a copy of `trApi` that keeps the server's `reasons` (import needs them), so the two must change together.
- **D-T6-2.** Extract `dsExportButton(slug, label, msg)` and use it at both places.
- **D-T6-3.** No code change; the guard is the drift test below.
- **D-T6-6.**
  - Before posting, compute the JSON body. If `new Blob([body]).size > DS_IMPORT_MAX`, say `The file is too large to import: with its JSON wrapping it is over 16 MB.`
  - Keep the cheap file-size pre-check.
  - Expose the check as `dsImportTooBig(bodyText)`.
- **D-T6-7: accessibility.**
  - The reference button gets `aria-label="Edit reference"`.
  - Each row's tags input and Delete button get `aria-label`s `Tags of example <n>` and `Delete example <n>`, where n is the row number shown.
  - In the picker, Tab from its last control (or Shift-Tab from the first) wraps to the other end. Escape closes it and returns focus to the opener.
- **D-T6-9.** Widen the tags column in the datasets examples table so a 2-tag value is not clipped at 1280 px, or let the input grow on focus. CSS only.
- **D-T7-6.**
  - `dsResultCells` puts `Not run: the run stopped first` and the three Task 6 original-cell texts in a `note` field, not `error`.
  - Render `note` with a neutral class `ds-cell-note` (muted text, no red border).
- **D-T7-8.** Move the Playground's decisions into exported pure helpers:
  - `dsPgSendPlan(s)` returns one of:
    - `{ kind: 'refuse', message: DS_EXTERNAL_OFF }` when content is off and an external model is picked;
    - `{ kind: 'preview', body }` when an external model is picked and there is no current preview;
    - `{ kind: 'send', body }`, carrying `confirm` only when the preview matches the current form.
  - `dsPgOnError(s, err)` maps:
    - 409 → `{ follow: true }`;
    - 428 → `{ dropPreview: true, message: 'Preview what will be sent first' }`;
    - 403 with content off → the off message.
  - `dsPgRun` and `dsPlaygroundAct` call these helpers.
- **Docs (`docs/datasets.md`):**
  - **`:180`:** `risky_command` reads a proposed call's `command` or `cmd` argument.
  - **`:343`:** "nothing is written to your data folder".
  - **`:136-137`:** usage, cost and OTLP export apply; replay calls are recorded as dashboard calls with no API key, so no key budget applies.
  - **`:274`, `:277`:** show an unrounded rate (`0.6666666666666666`), or add "rates are not rounded".
  - **Adding examples, automatically:** the rule is set on the Datasets page (Auto-add) or by API or `config.json`. Remove "It has no screen yet" and the Known-limits line at `:373`.
  - **Replay:**
    - **Stop after the current call** ends a run at the next call boundary with `stopped: 'cancelled'`; the call in flight finishes and is recorded, and its judge verdicts are skipped. Remove "No stop button" (`:372`).
    - An external call counts at least its estimate when the provider reports no usage.
  - **CI gate:**
    - the `had no verdict (<reason>: n)` stderr line and `missing`;
    - `allFailed` and its warning;
    - `stored`;
    - `{ ok: false, error }` on a runner failure with `--json`.
  - **Import:** `links: { kept, dropped }`, and `source.turn` must be a whole number from 0.
  - **HTTP API table:** `GET /api/datasets/<slug>?view=preview` and `POST /api/experiments/<id>/cancel`.
- **README.md:827.** Add `POST /api/experiments/<id>/cancel` to the datasets API row.
- **Plan (D-T3-4).** In `2026-10-22-datasets-replay.md` R10, add: `A stored record is bounded at 2 MB: over that, texts shorten to 1,000 then 250 characters, then go, and results are dropped from the end last; the record then carries trimmed: { textChars, droppedResults? }.`

**Tests (each fails before the fix; D-T6-1, D-T6-2 and D-T6-9 have no new test):**

- **Slug drift (D-T6-3).** For `['Auth regressions', 'CON', 'import', '  ', 'Ünïcode name', 'a'.repeat(80)]`, the name part `dsSlugOf` derives equals `require('../lib/datasets/shape').slugify(name)`, where the server would accept one. This guards existing behaviour: show that it fails if a reserved word is removed from either list.
- **`dsImportTooBig`.** A body string just over 16 MB → true; just under → false.
- **Accessibility.** Render the examples view with the fake document: the reference button's `aria-label` is `Edit reference`, and rows 1 and 2 have distinct `Tags of example 1` / `Tags of example 2` labels.
- **`dsResultCells` (D-T7-6).** `Not run…` is in `note`, and `error` is null.
- **`dsPgSendPlan` and `dsPgOnError`.** One case per branch above: refuse, preview, send with a matching confirm, send without confirm after a form change, 409 follow, 428 drop.

**Commit:** "Tidy the datasets view (shared export button, import size, labels, neutral notes), test the Playground decisions, and update the datasets docs"

---

## Tier C (left as is)

**Monitors**

- **M-T1-2** `agent_stuck` rounding: cosmetic.
- **M-T1-3** `tool_loop` value and threshold mean different things per path: the UI reads it correctly, and the per-turn path never fires.
- **M-T2-1** ok-then-disappear within 5 min never resolves: by design (resolution needs a held ok). The display side is fixed by M-F-4.
- **M-T3-1** `pumpWebhooks` slot leak when an injected sleep rejects: reachable only through injection.
- **M-T3-2** `ZP_DRY_RUN` case on Windows: matters only if the owner sets `zp_dry_run` themselves.
- **M-T3-3** WinRT toast unverified: a manual check before a release, not code. A balloon fallback exists.
- **M-T4-1** NaN `pollMs`: reachable only through injection.
- **M-T4-2** SIGCONT after SIGINT audited as `resume`: the `note` tells them apart.
- **M-T4-3 / M-P-1** Windows has no candidates, so Stop cannot be reached from the UI: a plan-level scope gap, documented. A fix needs a Windows cwd source (owner decision).
- **M-P-2** `tool_loop`'s per-turn call count is not measured: a new data source in the index. The UI is made honest by M-T5-4.
- **M-T4-9** Linux `t` (traced) state counts as stopped: rare, and resuming it is harmless.
- **M-T5-1** a persistently unreadable `ps` is retried every 5 s: rare, reported once, bounded.
- **M-T5-3** the once-per-episode report flag is in memory: one extra report after a restart at most.
- **M-T5-5** the aggregate pass rereads the index each minute: speculative. Measure before changing it.
- **M-T5-7** `ruleSnap` reads the raw budget when `agg` is null: harmless, and the next pass validates it.
- **M-T5-8** long comment lines in `lib/monitors/channels.js:42,55,73`: cosmetic, and Prettier passes.
- **M-T6-1** `key` is optional on agent actions: the audit `sessionId` is null only for hand-built calls.
- **M-T6-4** the per-process instance-id salt gives 404 after a restart: only the API's per-instance snooze uses it, and no page sends instance ids.
- **M-T6-6** demo channels are dropped on a config reload: demo only.
- **M-T7-6** the `MON_APP` list can drift, and the file is large: maintainability with no defect. A split is optional.
- **M-T7-7** "Paused because" reads only the newest 100 alerts: fails soft, showing the generic banner.
- **M-R2-3 (code part)** preferring the leaf process for npm Codex: needs `ppid` in the process rows (not there today). Only the docs change in Task 3.

**Datasets**

- **D-T1-3** noisy unreadable-index test, 500 path untested: test hygiene.
- **D-T1-4** a concurrent `recoverIndex` loser gets 500: needs a corrupt index plus two writers at once.
- **D-T1-5** `remove()` unlinks after the index write: rare adoption edge.
- **D-T2-1** a gateway task over 64 KB keeps its head only: brief-mandated.
- **D-T2-2** `readHeadTail` rescans: CPU only, under `limited()`.
- **D-T2-4** masked placeholders can exceed the cap: `shape.js` re-caps.
- **D-T2-5** long test lines: cosmetic.
- **D-T3-3** a torn tail costs a full parse: happens only after a crash.
- **D-T3-5** `judgeMaterial` builds the prompt before the gates: it changes the reason only when `buildPrompt` throws.
- **D-T3-9** the experiment's in-flight judge call is not cancelled by a provider switch: cost only, and "the call in flight finishes" is the controller decision.
- **D-T4-1** a cancelled run's last call gets no verdict: follows the cancel decision. Task 7 documents it.
- **D-T4-3** the runner trusts its options: validated by the API and the CLI.
- **D-T4-4** extra `timeoutMs` option: harmless.
- **D-T4-5** `toTools` drops duplicate names: correct.
- **D-T4-6** the inline route check could use `isRouted`: predates the feature.
- **D-T4-7** gateway Prettier diff: predates the feature.
- **D-T5-1** the "dataset must exist" check is relaxed for `onFail`/`onBad`-only edits: deliberate.
- **D-T5-2** a reason merged in the microtask after save is lost: a microtask window.
- **D-T5-4** `onFeedback` placement in the options: churn only, now that the rebase is done.
- **D-T5-5b** weak assertions (demo `>= 1`, queue bounds only): test strength, not a gap in a property.
- **D-T5-8** a keyed import line with a bad turn gives a generic reason: rare.
- **D-T5-10** export cannot tell "gone" from "never linked": both are `source: null` by design.
- **D-T5-11** links survive only within one running server: controller decision.
- **D-T5-12** extra options (`log`, `limits`, `max`): test seams.
- **D-F-2b** a per-dataset byte cap: it would add a limit beyond the plan's verbatim R1. The light view covers the realistic cost.
- **D-T6-8 / D-T7-7** `datasetview.js` size (2,294 lines): a split is a refactor with no defect. Revisit after Tasks 6–7.
- **D-T7-9** Send reads state, not the DOM: guarded by the preview check, with no mismatch path.
- **D-R-1** one docs line over the wrap width: cosmetic. Fix it in passing if Task 7 touches that paragraph.

## Owner decisions surfaced by this plan

1. **M-F-3** — decided 2026-10-23: agent control is off under `ZAAFPULSE_AUTH=none` (outside demo), per "requires a dashboard sign-in".
2. **D-T5-6** — decided 2026-10-23: add the cancel route and the Stop button; it never interrupts the call in flight.
3. **D-F-4** — decided 2026-10-23: `--ci` exits 1 when every replay of a model errored.
4. **M-T4-3 / M-P-1** (Windows Stop unreachable from the UI) and **M-P-2** (per-turn tool-call count) stay open as scope gaps.

## Self-review

- Every deferred item in the ledgers and in the final and re-review files is in exactly one place: the triage tables, the dropped list or tier C.
- Each A and B item maps to one task. The file overlaps (`server.js`, `lib/monitors/api.js`, `public/datasetview.js`, `public/styles.css`) are ordered Task 1 → 2 and Task 6 → 7.
- No task reverses a listed controller decision:
  - control stays off in server mode, with password sign-in and in Docker;
  - the rule minimums stay;
  - external replay stays refused with content off;
  - links stay per process;
  - cancel waits for the call in flight;
  - exit codes are unchanged.
- No task adds a dependency, a shell spawn or `innerHTML` built from content. No test signals a process other than its own sleeper or calls a real network.
