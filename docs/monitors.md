# Monitors, alerts and agent pause

Monitors watch your usage, cost and quality and tell you when something looks wrong. They run inside the dashboard server, read the same data as the other pages, and send nothing but numbers. For some rules you can also let ZAAFPulse pause the agent that caused the alert, and you can pause, resume or stop an agent yourself from the dashboard.

The bell in the top bar shows open alerts. Its drawer lists recent alerts, and **Settings → Monitors** has the rules and the channels.

## Rules

Seven rules ship with ZAAFPulse. Each can be switched on or off and has its own limits. A rule that is on its default setting follows the table. Your own choices are kept in `.data/monitors.json`.

`daily_cost` and `month_projection` have been replaced by [budgets](cost.md#budgets). They are no longer evaluated,
listed or changed; their old states and alerts remain as history.

| Rule | Triggers when | Default | On by default | Auto-pause |
|---|---|---|---|---|
| `cost_burn` | One session spent more than the limit in the last 10 minutes | `maxUSD`: 5 | no | yes |
| `tool_loop` | A session shows a loop in the last 10 minutes | `maxCalls`: 50 (no effect yet, see [Known limits](#known-limits)) | yes | yes |
| `agent_stuck` | An agent is working or thinking but wrote no new log line | `stuckMin`: 10 | no | no |
| `accuracy_drop` | Today's accuracy is below the previous 7 days by more than the limit, once both rest on enough results | `dropPoints`: 5, `minSamples`: 20 | yes | no |
| `eval_pass_rate` | An evaluator passed less than the minimum share of checks in 24 hours | `minPassRate`: 0.8, `minSamples`: 20 | no | no |
| `unsafe_content` | A secret leak, or a prompt injection from outside, in the window | `windowMin`: 60 | yes | no |
| `cost_anomaly` | Today's or yesterday's spend is well above what the same weekday usually costs (see [Forecast and anomalies](cost.md#forecast-and-anomalies)) | `ratio`: 2 (above 1, up to 100), `minUSD`: 1 (above 0, up to 1,000,000) | yes | no |

Notes:

- Rules are either **live** (one instance per session: `cost_burn`, `tool_loop`, `agent_stuck`) or **aggregate** (one instance for everything).
- `accuracy_drop` reports `no_data` unless today and the previous 7 days each rest on at least `minSamples` tool results (default 20, the same as `eval_pass_rate`). One fault among the morning's first ten results would otherwise be a ten-point drop.
- `cost_anomaly` has one instance per day, named by its date: yesterday, checked whole, and today, checked so far
  ("Wed 28 Oct (so far)"). It is checked after each index refresh, from the ledger. A day alerts at most once: no
  30-minute reminder, and the whole-day check of a day that already alerted on its partial check sends nothing. After a
  snooze, an `ok` seen before it does not shorten the resolution hold. A day before yesterday leaves the card and the
  counts without a resolution. It reports `no_data` until the ledger has 3 known days. The alert carries the day's
  spend (value), the level it had to pass (threshold: the larger of `ratio` × its usual amount and the usual amount
  plus `minUSD`; `minUSD` when the usual amount is $0) and the usual amount (shown in the bell; the webhook keeps its
  seven fields). The models, projects, centers and keys behind it are shown on the Cost Control Overview only, never
  in the bell, the desktop notification or the webhook.
- `eval_pass_rate` looks at the worst evaluator that has at least `minSamples` results. Evaluators with fewer are ignored.
- `unsafe_content` counts a secret leak, or a prompt injection that came from outside (a tool result or a file, not from you).
- A rule whose input is missing reports `no_data`. It never triggers on missing data.
- A live session that has not been seen for a minute (it ended or went idle) leaves the rule card and the counts; its alerts stay in the history.
- The live check is skipped while no live rule and no auto-pause is on.

## States and alerts

Every rule instance is in one state: `ok`, `triggered` or `no_data`. A snoozed instance shows as `snoozed`.

An alert is sent when:

- an instance **becomes triggered**;
- a triggered instance **stays triggered**: a reminder every 30 minutes (not for `cost_anomaly`);
- a triggered instance **has been ok for 5 minutes**: a resolution. The wait stops a value that hovers at its limit from sending a trigger and a resolution on every check.

An instance that flips between `triggered` and `no_data` does not alert on each return. `no_data` alone never sends an alert. If a live rule cannot list sessions at all, nothing changes for the sessions it knew.

Live rules are checked every 5 seconds. Aggregate rules are checked after each index refresh, about once a minute.

**Snooze.** You can snooze a rule, or one session of a live rule, for 1 hour or 1 day. A snoozed instance is tracked quietly and sends nothing. Snoozing a rule also suspends its auto-pause. When the snooze ends, the instance starts afresh. If it is still triggered, it alerts again, but an agent that was already paused for that episode is not paused a second time.

Alerts are kept in `.data/alerts.jsonl` (newest 2000). No alert holds transcript text. It holds the rule, two numbers, and the session title with secrets masked.

Budget alerts use rule `budget` and states `ok`, `warn_<n>` and `exceeded` (see [Budgets](cost.md#states-and-alerts)).
They are sent only when the level changes; there are no reminders, and a projection alert is sent at most once per
period. The bell and the drawer show the budget's name and period. The webhook gets the state but never the name:
`sessionId` is `null` for every budget, so a receiver cannot tell budgets apart, and a projection alert arrives with
`state` equal to `previous` (for example `warn_50`/`warn_50`).

## Channels

Two channels, both optional and both free of content:

- **Desktop notification.** On by default. macOS uses `osascript`, Linux uses `notify-send`, Windows uses a PowerShell toast. The text is the rule title, the word Triggered or Resolved, the value and limit, and the masked session title. Commands run without a shell.
- **Webhook.** Off until you set one. ZAAFPulse sends a POST with a JSON body for state changes only (not for pause outcomes). Failed sends are retried three times, after 1, 4 and 16 seconds. Redirects are not followed. The URL must be `https://` (`http://` only to this machine) and must not hold credentials.

The webhook body is these seven fields and nothing else:

```json
{
  "rule": "budget",
  "state": "warn_80",
  "previous": "warn_50",
  "value": 84.2,
  "threshold": 80,
  "sessionId": null,
  "ts": 1790000000000
}
```

For fixed rules, `state` and `previous` are `ok`, `triggered`, `no_data` or `snoozed`; a budget also sends its
`warn_<n>` or `exceeded` state. `sessionId` is the raw session id for live rules, and `null` for aggregate rules and
budgets.

The URL and the headers (for a token) are secrets. Paste them in **Settings → Monitors**: they go to the OS secret store, and `config.json` keeps only a reference, as described in [Storing a secret](integrations.md#storing-a-secret):

```json
"monitors": {
  "channels": {
    "desktop": true,
    "webhook": {
      "url": { "keychain": "acc.monitors-webhook-url" },
      "headers": { "keychain": "acc.monitors-webhook-headers" }
    }
  }
}
```

An `{ "env": "NAME" }` reference works too. A plain URL typed into `config.json` is not used, and Settings says why. Headers are a JSON object or `Name: value` lines. Use **Test** to send a sample.

`ZAAFPULSE_NOTIFY=off` turns all notifications and webhooks off, and the test button sends nothing. The test suite sets it. **Demo mode never sends a signal, a notification or a webhook.**

## Agent control

You can pause, resume or stop the local agent process behind a Claude Code or Codex session from the Explorer's session panel, the Live monitor's sessions and the AI Office. The bell drawer, the Live monitor and the AI Office also show a banner for each paused agent, with Resume and Stop.

| Action | macOS and Linux | Windows |
|---|---|---|
| Pause | `SIGSTOP`: the process freezes in place | not available |
| Resume | `SIGCONT` | not available |
| Stop | `SIGINT`, then `SIGTERM` after 5 seconds if the same process is still alive | `taskkill /PID n`, without `/F` |

Details:

- `SIGKILL` is never sent.
- Claude Code may treat the first `SIGINT` as "interrupt the current turn" and not exit. That is why Stop follows with `SIGTERM`.
- On Windows `taskkill` without `/F` asks the app to close. Console apps may not. Then the API answers 502 and the dashboard tells you to close the app from its own window.
- Stop needs an explicit confirmation. A paused (`SIGSTOP`) process is continued with `SIGCONT` right after the `SIGINT` so it can handle the signal. The `SIGCONT` gets its own audit line, with a note that says why.
- **A paused agent is never resumed or stopped automatically.** Only you resume or stop it.

### Safety checks

Before every signal ZAAFPulse reads the process table again and refuses unless:

- the pid is above 1 and has a start time;
- the process still exists, and its start time matches (so a reused pid is never hit);
- it is an AI app, not ZAAFPulse itself or the judge's Claude Code calls;
- for a rule, the action is a pause and the rule is allowed to pause.

Every action, refused or not, is written to `.data/agent-audit.jsonl` (mode 0600, rotated at 5 MB). It holds the time, action, pid, start time, app, session id, who asked (`owner` or `rule`), the rule (for a rule's pause), the signal and the result, and a `note` on the `SIGCONT` that follows a stop. It holds no paths and no text.

### Linking a session to a process

A session is linked to a process by app, working folder and start time: a process of the session's own app (Claude Code for a Claude Code session, Codex for a Codex one), whose program is that app's own binary, whose working folder matches the session's, and which started before the session's first log line. The program is matched by its exact name (`claude` or `codex`, or the script node runs), read from the process's own argument list, so a path with spaces is read whole. Claude Code started by the Claude desktop app counts. A command line that only mentions the app (a dev server under `~/code/codex-clone`, the ChatGPT app's Codex helpers) or a launcher that wraps the agent is not a candidate. If exactly one process matches, it is the target. If none or several match, nothing is paused and you are told which. The dashboard never guesses.

An npm-installed Codex runs as a node wrapper and a native codex process; both match, so you choose, and auto-pause reports "several" instead of acting. On macOS a node script whose path holds a space is not matched (no candidate).

On macOS the working folder comes from `lsof`, on Linux from `/proc`. On Windows the working folder of a process is not available, so there are **no candidates** and sessions cannot be linked to processes there.

### Auto-pause

For `cost_burn` and `tool_loop` you can turn on **pause the agent automatically**. It is off by default. When one of
these triggers, ZAAFPulse looks for the one process behind the session and pauses it, once per trigger episode. The
outcome becomes an alert in the bell: paused, or why not (several matching processes, none, not on Windows, session
not indexed yet, process gone or changed). A restart does not pause the same episode twice, and an agent you resumed
stays running.

A budget with `enforce: "pause"` uses the same controls. Once per budget period, it pauses the running session that
spent the most in the budget's scope and period, on the budget's measure. Without a known home folder, project and
center budgets pause nothing and say so once. It never pauses on `no_data` and never resumes the agent. See
[Budgets → Pause](cost.md#pause).

### Where control is off

Agent control is off, and the dashboard explains why instead of offering the buttons, when:

- the server runs in **server mode**;
- the dashboard uses **password sign-in**, which includes a reverse proxy, a public URL and `ZAAFPULSE_AUTH=1`;
- the dashboard runs **without sign-in** (`ZAAFPULSE_AUTH=none`): any program on this machine could use it, so it may not signal agents;
- ZAAFPulse runs in **Docker** (found by `/.dockerenv` or the container's cgroups).

`GET /api/monitors/status` then reports `agents.available: false` and `agents.reason` as `server`, `no-sign-in` or `docker`. Turning on auto-pause is refused too (409), and a no-candidate pause is worded for that case. In demo mode the controls are shown, but nothing is signalled.

No MCP tool controls agents. The MCP server cannot pause, resume or stop anything.

## Near-live

Alerts are close to live, not instant:

- Live rules run every 5 seconds, but they read the office state and the logs as the index sees them.
- **Cost per 10 minutes (`cost_burn`) comes from the index, which refreshes about every 60 seconds.** It can lag by up to about a minute. A burst that is over in less than that may be seen late.
- Aggregate rules run after each refresh.

## API

All routes are behind the dashboard sign-in. They are never open to gateway API keys, MCP or A2A. Writes need `Content-Type: application/json`. No response holds a raw session id or a file path.

| Route | What it does |
|---|---|
| `GET /api/monitors` | every rule with its settings, its instances and states, snooze, and the channel status |
| `GET /api/monitors/status` | counts, last checks, paused agents, and `agents` (`available`, `pause`, `reason`) |
| `POST /api/monitors/<rule>` | change one rule: `enabled`, `params`, `autoPause`, or `snooze` (`"1h"`, `"1d"`, `null`; add `instance` for one session) |
| `POST /api/monitors/channels` | set the desktop channel and the webhook URL and headers (stored as secret references) |
| `POST /api/monitors/test` | send a sample to `desktop` or `webhook` |
| `GET /api/alerts` | recent alerts, with `since` (ms) and `limit` (1 to 500); a `cost_anomaly` row also has `usual`, the day's usual amount in USD (or `null`) |
| `GET /api/agents/candidates?key=` | the processes that could be behind a session |
| `POST /api/agents/pause` · `resume` · `stop` | act on `{ pid, startTime }`; `stop` needs `confirm: true`. Errors: 400, 403, 409, 501, 502 |

## Known limits

- **Too many tool calls in one turn does not fire.** The `tool_loop` rule currently triggers only on loop signals the index finds. The per-turn call count is not measured yet, so `maxCalls` has no effect. Settings shows no input for it; the API still accepts it.
- **Quiet starts.** `accuracy_drop` stays `no_data` until today and the previous 7 days each have 20 tool results (`minSamples`).
- **Little statistical detection.** The rules compare numbers to limits; only `cost_anomaly` learns a baseline, the mean of each weekday over 4 weeks.
- **Local only.** Agents on other machines, and remote paging, are out of scope.
- **Windows:** no pause, no resume, and no session-to-process link. Stop may fail on console apps.
- **Cost burn lags** by up to about a minute (see [Near-live](#near-live)).
- **Control is off** in server mode, with password sign-in, without sign-in (`ZAAFPULSE_AUTH=none`) and in Docker.
- **A paused agent is never resumed or stopped automatically**; only you resume or stop it.
- **One process per session.** If two agents share a folder and start time, ZAAFPulse will not choose.
