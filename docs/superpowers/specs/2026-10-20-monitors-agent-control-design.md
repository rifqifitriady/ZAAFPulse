# Sub-project 3: Monitors, alerts and agent pause

Date: 2026-10-20 · Status: approved in brainstorming, awaiting spec review · Depends on: sub-projects 1 and 2 · Shared requirements: overview (S1–S11, P1–P10).

## Goal

Tell the owner when something needs attention: spend, quality, a runaway or stuck agent, unsafe content. Let the owner, or a rule they enabled, pause a misbehaving local agent before it burns more time or money.

## Rules

Rules live in `lib/monitors/rules.js`. Each rule declares:
- `id`;
- the parameters, with defaults;
- the data it needs: an aggregate or live data;
- whether it may auto-pause.

| Rule | On by default | Default threshold | Data | May auto-pause (opt-in) |
|---|---|---|---|---|
| `daily_cost` | yes, if a monthly budget is set | budget ÷ 30 | aggregate | yes |
| `month_projection` | yes, if a budget is set | > budget | aggregate | no |
| `cost_burn` | no | > $5 per 10 min per session | live | yes |
| `tool_loop` | yes | the same tool and input ≥3 times in a row, or > 50 steps in one turn | live + aggregate | yes |
| `agent_stuck` | no | state "working" with no new log line for 10 min | live | no |
| `accuracy_drop` | yes | > 5 points below the previous 7 days | aggregate | no |
| `eval_pass_rate` | no | an evaluator's pass rate < 80% over 24 h (≥20 samples) | evals | no |
| `unsafe_content` | yes | external prompt injection or a secret leak detected | signals | no |

## Evaluation and states

- Aggregate rules run after each index refresh (60 s). Live rules run on the existing 5 s live snapshot (`lib/processes.js` + `lib/office.js`), for running sessions only (P7).
- Each rule instance has its own state: one rule instance per session for live rules. States are `ok`, `triggered`, `no_data` and `snoozed`.
- **Alerts fire only on a change of state** (the AX pattern). A rule that keeps triggering re-alerts at most once per 30 minutes; snooze lasts 1 h or 1 day.
- The state is kept in memory and persisted to `.data/monitors.json`, so a restart does not re-fire alerts that were already sent.

## Channels

- **In the dashboard:** a bell in the top bar with a count, and an alerts drawer (recent alerts with links to the session in the Explorer). Alerts are stored in `.data/alerts.jsonl`, capped at 2,000.
- **Desktop notification:** on by default. Sent with fixed-argument OS commands and no shell:
  - macOS `osascript -e 'display notification …'`, with title and text passed as separate quoted arguments;
  - Linux `notify-send`;
  - Windows a PowerShell toast with the script on stdin.
  
  Text is limited to the rule name, numbers and the session title (S7).
- **Webhook:** optional, set in Settings → Alerts. It posts JSON with `{ rule, state, previous, value, threshold, sessionId, ts }`, never content. The URL and any auth are secret references. It is a fit for n8n or Slack. A failure retries 3 times with backoff, then gives up.

## Agent control

**Actions:** ⏸ Pause, ▶ Resume and ⏹ Stop (stop asks for confirmation). They are available in the Explorer detail panel, the Live monitor and the AI Office.

**Process resolution**
- Only processes that `lib/processes.js` identifies as AI agents can be targeted: Claude Code, Codex, Kiro and the others in `APPS`.
- A target is `{ pid, startTime }`. It is checked again before every signal, which guards against PID reuse (S6).

**Session-to-process link** (risk: verify first in implementation)
- The logs may not record a PID. The link uses three things: the session's `cwd`, the process's cwd (`lsof -a -d cwd -p <pid>` on macOS, `/proc/<pid>/cwd` on Linux), and timing (the process started before the session's first line and is still alive).
- With exactly one candidate it links automatically.
- With several, the UI asks the owner to choose and shows the command, cwd and start time. It never guesses.

**Signals**
- Pause: `SIGSTOP`. Resume: `SIGCONT`. Stop: `SIGINT`, then `SIGTERM` after 5 s if the process is still alive.
- `SIGKILL` is never sent (S6).
- Windows has no stop/continue signal, so pause is not offered there. Stop uses `taskkill /PID` without `/F`.

**Automatic pause**
- Only for rules where the owner enabled "pause the agent", and only on live rules (`cost_burn`, `tool_loop`) or `daily_cost`.
- A paused agent is never resumed or stopped automatically.
- The Explorer, Live monitor and AI Office show a banner: "Paused because <rule> · Resume · Stop". A notification is sent as well.

**Restrictions (S6)**
- A dashboard sign-in is required.
- There is no route for gateway API keys, MCP tools or A2A.
- Agent control is disabled in server mode, and in Docker (where processes are not the host's).
- Every action goes to the audit log: `{ ts, action, pid, startTime, app, sessionId, rule?, by: 'owner' | 'rule' }`.

## API (dashboard session required)

| Route | Purpose |
|---|---|
| `GET /api/monitors` | rules, parameters, states |
| `POST /api/monitors/:id` | enable or disable, set parameters, auto-pause on/off, snooze |
| `GET /api/alerts?since=` | recent alerts |
| `POST /api/agents/:target/pause\|resume\|stop` | agent control, with `{ pid, startTime }` echoed for the check |
| `GET /api/agents/candidates?session=` | candidate processes for a session |

## Testing

- **Rules:** each rule against synthetic aggregates and live snapshots, including the thresholds and the minimum samples.
- **State machine:**
  - alerts only on change;
  - re-alert spacing;
  - snooze;
  - persistence across restart.
- **Channels:**
  - notification commands built with fixed arguments (no shell), checked by recording the spawn arguments;
  - the webhook payload holds no content, retries and gives up;
  - the URL comes from a secret reference.
- **Agent control:**
  - a real child process (a sleeper script) is paused, resumed and stopped on macOS and Linux runners;
  - a PID or start-time mismatch is refused;
  - non-agent processes are refused;
  - refused in server mode and over gateway keys and MCP;
  - audit entries are written;
  - Windows: no pause option, and stop without `/F`.
- **Session-to-process linking:** one candidate, several candidates and none, with fake process tables.

## Out of scope

- Statistical anomaly detection and automatic thresholds (AX-style). Thresholds are fixed and set by the owner.
- Paging integrations beyond the generic webhook.
- Automatic stop.
- Controlling agents on other machines.
