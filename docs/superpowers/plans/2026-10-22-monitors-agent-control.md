# Monitors, Alerts & Agent Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the owner when something needs attention, and let the owner (or a rule they enabled) pause a misbehaving local agent. Something needs attention when one of these happens:

- spend runs over budget;
- quality drops;
- an agent loops or gets stuck;
- unsafe content appears.

**Architecture:**

- **Rules.** Each rule is a pure function from a snapshot to one state per rule instance (`lib/monitors/rules.js`).
- **State machine and stores.** A small state machine raises an alert only when a state changes. It re-alerts at most every 30 min and supports snooze. It persists to `.data/monitors.json` and `.data/alerts.jsonl` (`lib/monitors/state.js`).
- **Channels.** Alerts go out through these channels (`lib/monitors/channels.js`):
  - the dashboard: a bell and a drawer;
  - a desktop notification, using fixed-argument OS commands with no shell;
  - an optional webhook, which sends no content.
- **Agent control.** `lib/agents/control.js` pauses, resumes or stops a verified local agent process. A target is identified by `{ pid, startTime }`, which is re-checked before every signal.
- **Engine.** `lib/monitors/index.js` wires it all together:
  - aggregate rules run after every index refresh (60 s);
  - live rules run every 5 s on running sessions only;
  - automatic pause happens only for rules the owner opted in.

**Spec:** `docs/superpowers/specs/2026-10-20-monitors-agent-control-design.md`.

**Shared rules:** S1–S11 and P1–P10 in `docs/superpowers/specs/2026-10-20-ai-observability-overview.md`.

## Global Constraints

- **Dependencies.** Zero runtime dependencies.
- **No shell (S7).** Every OS command is spawned with an argument array and no shell.
- **Notification text (S7).** Notification text contains only the rule name, numbers and the session title. It never contains transcript content.
- **Webhooks (S7).**
  - The payload is exactly `{ rule, state, previous, value, threshold, sessionId, ts }`.
  - The URL and any auth are secret references (`lib/secrets.js`).
  - A failed send is retried 3 times with backoff, then dropped.
- **Agent control (S6).**
  - Only processes identified as AI agents by `lib/processes.js` `APPS` can be targeted.
  - A target is `{ pid, startTime }`, re-verified before every signal (this protects against PID reuse).
  - Pause sends `SIGSTOP`. Resume sends `SIGCONT`. Stop sends `SIGINT`, then `SIGTERM` after 5 s if the process is still alive. **`SIGKILL` is never sent.**
  - On Windows there is no pause. Stop runs `taskkill /PID <pid>` **without `/F`**.
  - It requires a dashboard sign-in. No route is exposed to gateway API keys, MCP tools or A2A.
  - It is disabled in server mode and in Docker.
  - Every action is written to an audit log as `{ ts, action, pid, startTime, app, sessionId, rule?, by: 'owner'|'rule' }`.
- **Automatic pause.**
  - It applies only to rules where the owner enabled "pause the agent", and only to `cost_burn`, `tool_loop` or `daily_cost`.
  - An agent that was paused is never resumed or stopped automatically.
- **Linking a session to a process.**
  - Candidates are agent processes whose cwd equals the session's cwd and whose start time is before the session's first line. The process must still be alive.
  - With exactly one candidate, the session is linked automatically.
  - With several candidates, the UI asks the owner to choose. It never guesses.
- **Stores (S11).** `.data/monitors.json` and `.data/alerts.jsonl` (capped at 2,000) use file mode 0600. The audit log is `.data/agent-audit.jsonl` (mode 0600, rotating like `lib/audit.js`).
- **Rendering (S1).** Text only (`esc()` / `textContent`).
- **Demo mode.** Synthetic monitors, alerts and agents. Demo mode never sends a signal, notification or webhook.
- **Tests.** Tests never send signals to real processes other than child processes the test itself spawned (a sleeper). They never run osascript, notify-send or PowerShell for real; they record the spawn arguments instead. They never call a real webhook (use a fake server).
- **Housekeeping.** Follow `.prettierrc.json`. No AI attribution. CI runs on Ubuntu, macOS and Windows.

## Rules (exact ids, defaults)

| id | default on | default threshold | data | may auto-pause |
|---|---|---|---|---|
| `daily_cost` | on if `monthlyBudgetUSD > 0` | budget ÷ 30 per day | aggregate (today's cost) | yes |
| `month_projection` | on if budget > 0 | projection > budget, from local 00:00 on the 4th of the month | aggregate | no |
| `cost_burn` | off | > $5 per 10 min per session | live (per-session cost in the last 10 min, from index usage rows) | yes |
| `tool_loop` | on | a `loop` signal in the last 10 min, or > 50 tool calls in one turn | live + aggregate | yes |
| `agent_stuck` | off | agent state working or thinking, with no new log line for 10 min | live (office snapshot) | no |
| `accuracy_drop` | on | > 5 points below the previous 7 days, once today and the previous 7 days each have ≥ minSamples (20) tool results | aggregate (quality accuracy) | no |
| `eval_pass_rate` | off | any evaluator < 80% over 24 h with ≥ 20 samples | evals summary | no |
| `unsafe_content` | on | external prompt injection or a secret leak in the last hour | index signals | no |

- **States:** `ok`, `triggered`, `no_data`, `snoozed`.
- **Instances:** live rules have one instance per session. Aggregate rules have one instance.
- **Snooze:** 1 h or 1 day.

---

### Task 1: Rules (pure)

**Files:** Create `lib/monitors/rules.js`. Test: `test/monitors-rules.test.js`.

**Interfaces**

- `RULES`: an array of `{ id, title, describe, kind: 'aggregate'|'live', params: { name: default }, defaultOn(config), mayAutoPause }`.
- `evaluate(rule, params, snap, now)` returns `[{ instance, sessionId|null, state: 'ok'|'triggered'|'no_data', value, threshold, title? }]`.

**The snapshot is assembled by the engine (Task 5) and passed in.** Its fields:

| Field | Shape | Used by |
|---|---|---|
| `budget` | `{ monthlyUSD }` | `daily_cost`, `month_projection` |
| `today` | `{ cost }` | `daily_cost` |
| `month` | `{ cost, projection }` | `month_projection` |
| `accuracy` | `{ today, prev7 }`, both 0–1 or null | `accuracy_drop` |
| `evals` | `{ [id]: { pass, total } }` over the last 24 h | `eval_pass_rate` |
| `signals` | `[{ ts, sid, kind, external? }]` for the last hour | `unsafe_content`, `tool_loop` |
| `sessions` | live: `[{ sid, title, project, state, lastTs, cost10m, toolCallsTurn }]` | `cost_burn`, `tool_loop`, `agent_stuck` |

`title` is at most 80 characters and already masked. It is used only in notifications.

**Rules for missing data**

- Missing data gives `no_data`, never `triggered`.
- `eval_pass_rate` needs at least `minSamples` samples (default 20).
- `daily_cost` and `month_projection` give `no_data` when the budget is 0.

**Tests**

- Each rule triggers at its threshold and stays `ok` below it.
- Each rule gives `no_data` when its data is missing.
- `eval_pass_rate` respects `minSamples`.
- Live rules give one instance per session.
- `defaultOn` follows the budget.

**Commit:** "Add monitor rules as pure functions".

---

### Task 2: State machine, alerts store and persistence

**Files:** Create `lib/monitors/state.js`. Test: `test/monitors-state.test.js`.

**Interfaces**

- `createMonitorState({ file, alertsFile, now, maxAlerts = 2000 })` returns:
  - `apply(ruleId, results)`, which returns the alerts to send: `[{ id, ts, rule, instance, sessionId, state, previous, value, threshold }]`;
  - `snooze(ruleId, instance|null, ms)`;
  - `states()`;
  - `alerts({ since, limit })`;
  - `settings(ruleId)` and `setSettings(ruleId, { enabled, params, autoPause })`.

**Behaviour**

- An alert is raised only when the state changes, for example `ok` → `triggered`, `triggered` → `ok` (resolved), or `no_data` → `triggered`.
- An instance that stays `triggered` re-alerts at most every 30 minutes.
- While snoozed, the state is `snoozed` and no alert is raised. When the snooze expires, the instance is evaluated afresh.
- State and settings are persisted to `file` (JSON, mode 0600, written via a temp file and rename), so a restart does not re-fire alerts that were already sent.
- Alerts are appended to `alertsFile` (JSONL, 0600) and capped at 2,000 by compacting to the newest.
- Instances of sessions that are gone are pruned after 24 h.

**Tests**

- An alert is raised only on change.
- The re-alert spacing works with an injected clock.
- Snooze for 1 h, then expiry.
- Persistence across a new instance with the same files.
- The alerts cap.
- Pruning.
- File mode (skipped on win32).

**Commit:** "Track monitor states and alert only on change".

---

### Task 3: Channels (desktop notification and webhook)

**Files:** Create `lib/monitors/channels.js`. Test: `test/monitors-channels.test.js`.

**Interfaces**

- `createChannels({ spawn = child_process.spawn, fetchImpl = fetch, secrets, settings: () => ({ desktop: true, webhook: { url: <secret ref>, headers: <secret ref?> } | null }), platform = process.platform, log })` returns `{ notify(alert, { title }), test(kind) }`.

**Desktop notification**

- The text is built only from the rule title, the numbers (value and threshold) and the session title. The session title is clipped to 80 characters and passed through `maskTitle` from lib/trace/model.js.
- macOS: `spawn('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text])`. Passing the strings as argv keeps them out of the AppleScript source.
- Linux: `spawn('notify-send', ['--app-name=ZAAFPulse', title, text])`.
- Windows: `spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'])` with the script on stdin. Title and text go in through environment variables (`ZP_TITLE`, `ZP_TEXT`) and are read with `$env:`, so nothing is interpolated into the script.
- A failure is logged once and never throws.

**Webhook**

- POST JSON `{ rule, state, previous, value, threshold, sessionId, ts }` and nothing else.
- The URL and headers come from secret references, resolved with `secrets`.
- Timeout 10 s.
- Retry 3 times with backoff (1 s, 4 s, 16 s, injectable), then give up and log once.
- Only `https:` URLs are allowed, or `http:` to loopback.

**Tests**

- The recorded spawn args for each platform contain no shell; a title and text that contain quotes and `$(…)` arrive as separate argv or env values.
- The webhook payload has exactly the 7 keys.
- Retries, then gives up, against a fake server.
- A non-https, non-loopback URL is refused.
- The URL is resolved from a secret ref.

**Commit:** "Notify through the desktop and an optional webhook, never with content".

---

### Task 4: Agent control (pause, resume, stop)

**Files:** Create `lib/agents/control.js`. Test: `test/agents-control.test.js`.

**Interfaces**

- `createAgentControl({ processes = require('../processes'), kill = process.kill, spawn, platform, now, audit, serverMode, inDocker, log })` returns:
  - `candidates({ cwd, firstTs })`, which returns `[{ pid, startTime, app, cwd, command }]`;
  - `pause(target, meta)`, `resume(target, meta)` and `stop(target, meta)`;
  - `paused()`.
- A target is `{ pid, startTime }`. `meta` is `{ sessionId, rule?, by }`.

**Behaviour**

- **Candidates** are agent processes from `APPS`. Find how `processes.js` exposes per-process rows: `rowsForOs`/`withCwds` give pid, command and cwd; add a start time if it is missing. Use `ps -o lstart=` on POSIX and `CreationDate` on Windows, or the existing row field if there is one.
- **Matching** requires the same cwd (realpath) and a process start time before `firstTs`.
- **Every action**
  - re-reads the process row;
  - refuses with 409 when the pid is gone or its start time differs;
  - refuses with 403 when the process is not in `APPS`;
  - refuses with 403 in server mode or Docker.

  Docker detection uses `/.dockerenv` or `/proc/1/cgroup` mentioning docker or containerd.
- **Signals**
  - POSIX: `kill(pid, 'SIGSTOP')` to pause and `'SIGCONT'` to resume.
  - Stop sends `'SIGINT'`, then `'SIGTERM'` after 5 s if the process is still alive. **Never SIGKILL.**
  - Windows: pause and resume are refused with 501 "not supported on Windows". Stop runs `spawn('taskkill', ['/PID', String(pid)])` with no `/F`.
- **Audit and state**
  - Every action, including refusals, is appended to the audit log.
  - `paused()` lists the targets this process has paused and not yet resumed. It is in memory only; when the server restarts, the paused processes stay paused and are listed again from their process state if the OS reports it, otherwise not.

**Tests**

- On POSIX (skipped on win32), spawn a real child sleeper (`node -e "setInterval(()=>{},1000)"`):
  - pause → process state is stopped (via `ps -o stat=`) → resume → stop.
  - The child exits after SIGINT.
  - A child that ignores SIGINT gets SIGTERM after the grace period (use a small injectable grace).
- A wrong startTime is refused with 409.
- A non-agent process is refused.
- Server mode and Docker are refused.
- Audit entries are written.
- On Windows (or with `platform` injected), there is no pause, and stop is spawned as `taskkill /PID n` without `/F` (recorded spawn).
- `candidates`: one, many and none, with a fake process table.

**Commit:** "Pause, resume and stop verified local agents, never with SIGKILL".

---

### Task 5: Monitor engine

**Files:** Create `lib/monitors/index.js`. Modify `server.js` (wiring only; the routes come in Task 6). Test: `test/monitors-engine.test.js`.

**Interfaces**

- `createMonitors({ indexer, office, processes, evals, quality, config: () => config, state, channels, control, now, log, demo })` returns `{ tickAggregate(), tickLive(), status(), snapshot() }`.

**Aggregate tick, run after every index refresh**

Build the aggregate part of the snapshot from what the server already has:

| Snapshot field | Source |
|---|---|
| today cost, month cost and projection | `summarize()` in lib/aggregate.js; read server.js for how `/api/summary` computes `kpis` and the month projection |
| accuracy today and over the previous 7 days | quality KPIs; find where accuracy is computed (lib/quality.js) |
| evals pass rates over the last 24 h | `engine.summary({ from: now - 24h })` |
| signals in the last hour | `indexer.entries()` `result.signals.events` |

**Live tick, every 5 s**

- Take the office snapshot (`office.snapshot()`: agents with state, lastTs, project, tool, id `claude:<sid>`).
- Add per-session `cost10m`, computed from index usage rows with `ts > now - 10 min` for that sid. The index refreshes every 60 s, so this is near-live; say so in the docs.
- Add `toolCallsTurn` from the office or index data if available. Otherwise it is null.
- Evaluate only sessions that are running, meaning their state is not idle or done.

**After each tick**

- Pass the results to `state.apply`.
- Send every alert through `channels.notify`.
- For rules whose `autoPause` is on, and only for `cost_burn`, `tool_loop` and `daily_cost`, auto-pause the linked agent:
  - Resolve the target with `control.candidates` for the session's cwd and first timestamp.
  - Act only when there is exactly one candidate. Otherwise raise an alert "could not pause: several candidates".
  - Pause it with `by: 'rule'`.
  - Never auto-resume and never auto-stop.
  - Daily cost has no single session: auto-pause all running agents that belong to the costliest session today. The plan keeps it simple: the session with the highest cost today.

**Status and modes**

- `status()` returns `{ enabled, lastAggregate, lastLive, paused: control.paused(), counts }`.
- In demo mode it uses synthetic data and never signals, notifies or calls a webhook.

**Wiring in server.js**

- Create the state stores in `path.join(DIR, '.data')`.
- Create the channels, with `secrets` from the existing secret store.
- Create the control, using the server-mode and Docker flags.
- Create the monitors.
- Call `tickAggregate()` after every indexer refresh: look for where `evalTick` is wired and hook in next to it.
- Call `tickLive()` on a 5 s `setInterval(...).unref()`. If the live monitor already polls `office.snapshot`, share that call to avoid double work.
- Keep tick failures isolated: catch and log them.

**Tests**

- With fakes for everything:
  - aggregate rules raise alerts on change;
  - a live `cost_burn` with auto-pause on and one candidate pauses it (control spy, `by: 'rule'`);
  - several candidates means no pause and an alert;
  - auto-pause off means no pause;
  - nothing is ever auto-resumed;
  - demo mode means no notify, signal or webhook.
- Server wiring test: a demo server starts and `status` works (Task 6 covers the routes).

**Commit:** "Run monitors after each index refresh and on the live snapshot".

---

### Task 6: HTTP API, settings and demo

**Files:** Modify `server.js` (or add `lib/monitors/api.js` like `lib/evals/api.js`), and `lib/demo.js`. Test: `test/monitors-api.test.js`.

**Routes** (dashboard session only)

| Route | Returns |
|---|---|
| `GET /api/monitors` | `{ rules: [{ id, title, describe, kind, enabled, params, autoPause, mayAutoPause, state, instances: [{ instance, sessionKey?, state, value, threshold, snoozedUntil }] }], channels: { desktop, webhook: { configured } } }` |
| `POST /api/monitors/:id` | body `{ enabled?, params?, autoPause?, snooze?: '1h'|'1d'|null, instance? }`; validates every field |
| `POST /api/monitors/channels` | body `{ desktop?, webhookRef? }`. The webhook URL must be a secret reference. Show how secret refs are made elsewhere: lib/secrets.js `isRef` and the integrations UI |
| `POST /api/monitors/test` | body `{ kind: 'desktop'|'webhook' }`; sends a test notification |
| `GET /api/alerts?since=` | recent alerts. Session ids are mapped to opaque trace keys with `trace.keyFor` where possible. Never return raw sids or paths |
| `GET /api/agents/candidates?key=` | candidates for a session key. Map it with `trace.sourceOf` to get the session's cwd and first timestamp, the same way server.js maps keys for evals |
| `POST /api/agents/pause`, `/resume`, `/stop` | body `{ key, pid, startTime }`; `stop` also needs `confirm: true` |

**Rules for the routes**

- Responses carry no paths. A candidate's `cwd` and `command` are shown to the owner on their own dashboard, but strip the home folder to `~` and clip to 200 characters.
- Errors are path-free, with status codes 400/403/404/409/415/501.
- POST requires JSON.
- No route is reachable with a gateway API key, from MCP or from A2A. The routes sit behind `auth.check` like `/api/evals`.

**Demo** (`lib/demo.js` `monitorsDemo()`):

- monitors in mixed states;
- 5 alerts;
- one candidate for a demo session.

Agent actions in demo mode return `{ ok: true, demo: true }` and send no signal.

**Tests**

- Spawn a server the way test/evals-api.test.js does, with `NO_JUDGE_PORTS`.
- The demo routes respond.
- Validation (400), POST without JSON (415), a gateway key (401).
- Server mode refuses agent routes (403): use `ZAAFPULSE_AUTH` password mode on loopback, or inject the server-mode flag if a test hook exists.
- No paths appear in any response.

**Commit:** "Serve monitors, alerts and agent control behind the dashboard sign-in".

---

### Task 7: UI (bell, alerts drawer, monitors settings, agent controls)

**Files:** Modify `public/app.js` (top bar bell and drawer), add `public/monitorsview.js` (Settings → Monitors section, or `#monitors` under Quality; choose what fits the nav), and modify `public/traceview.js` (the `data-sub="3"` Pause agent button already exists), `public/liveview.js`, `public/officeview.js` and `public/styles.css`. Test: `test/monitors-ui.test.js` (pure helpers).

**Behaviour**

- **Bell and drawer.**
  - The bell in the top bar shows the unread alert count. Polling of `/api/alerts?since=` happens every 15 s while the page is visible.
  - The drawer lists recent alerts: rule title, state change, value against threshold, time, and a link to `#trace?key=` when there is a session.
  - "Mark all read" is stored in localStorage (a convenience only).
- **Monitors section.** For each rule: an enable switch, parameter inputs, an auto-pause switch (only when `mayAutoPause`), snooze (1 h or 1 day), and the current state.
  - Channels: a desktop notifications switch and a "Send test" button.
  - Webhook: pick a secret ref, with a link to how secrets are added, plus "Send test".
- **Agent controls** in the Explorer detail panel, the Live monitor and AI Office:
  - Pause, Resume and Stop. Stop asks for confirmation and names the app, pid and cwd.
  - With several candidates, the owner picks one from a list showing command, cwd and start time.
  - On Windows (and when disabled in server mode or Docker), Pause is hidden and the reason is shown.
  - A paused agent shows a banner: "Paused because <rule> · Resume · Stop".
- **Text only (S1).** Everything is rendered as text.

**Pure helpers** (exported for tests):

- `alertLine(alert, rules)`
- `unreadCount(alerts, lastRead)`
- `pauseBanner(paused, rules)`
- `candidateLabel(c)`

**Visual check.** In demo mode, take headless Chrome screenshots of the bell and drawer, the monitors section and the Explorer with the pause action at 1512 and 1280 widths. Use a 25 s kill timer, look at the result, and save the screenshots to the scratchpad `monitors-*.png`.

**Commit:** "Show alerts, monitor settings and agent controls in the dashboard".

---

### Task 8: Docs, MCP note and final verification

**Files:** Create `docs/monitors.md`. Modify `README.md`.

**Docs cover**

- the rules table with defaults;
- the states and when alerts fire;
- the channels and the webhook payload;
- agent control: what pause, resume and stop do per OS, the safety checks, the limits (server mode and Docker), and the audit log;
- how sessions link to processes;
- the near-live caveat (cost per 10 min comes from the 60 s index);
- the API routes;
- known limits.

**MCP.** No MCP tool controls agents (S6). The docs say so.

**Final verification.** Run the full suite twice; both runs must pass.

**Commit:** "Document monitors, alerts and agent pause".

---

## Self-review

**Spec coverage**

| Spec item | Task |
|---|---|
| Rules | 1 |
| Evaluation and states | 2, 5 |
| Channels | 3 |
| Agent control: actions, resolution, session-process link, signals, auto-pause, restrictions, audit | 4, 5 |
| API | 6 |
| UI: bell, drawer, banner, controls | 7 |
| Testing list | 1–7 |
| Out of scope (statistical detection, paging, auto-stop, remote agents) | respected |

**Approved simplification:** `daily_cost` auto-pause pauses the costliest running session of the day. The spec leaves this case unspecified, and the docs say so.
