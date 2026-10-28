# Cost ledger

ZAAFPulse keeps one daily record of what AI use cost, in `.data/cost/`. Every source is counted once, priced with the prices of its day and attributed to a cost center. It is the base of the Cost Control menu.

The ledger is filled by a pass that runs after each index refresh (at start, every minute and after **Rescan**). Nothing is fetched for it: it reads files on this machine only.

## What is counted, and by whom

Each call is counted by exactly one collector.

| What | Counted from | `source` |
|---|---|---|
| Claude Code on this machine | its own logs, once per API response; resumed and forked sessions count once | `claude` |
| Codex on this machine | its own logs, once per API response; the history a fork copies is skipped | `codex` |
| Requests through the Agent Gateway with your API keys | `.data/gateway-usage.jsonl` | `gateway` |
| Dataset replay | the gateway log | `replay` |
| Collaboration runs | the gateway log | `collab` |
| Judge calls to an external provider (they go through the gateway) | the gateway log | `judge` |
| Judge calls that skip the gateway (Ollama, LM Studio, the Claude Code CLI) | `.data/cost/judge-calls.jsonl`, written by the eval engine as each call is answered | `judge` |

- **The gateway owns every call that passed through it.** Experiment records and run totals repeat gateway lines and are never read.
- **Free models.** A model on a private gateway provider (your own hardware) and the local judge servers (Ollama, LM Studio) cost 0 and are marked `free`, not unpriced.
- **Not counted:** OmniRoute. Its own figures are shown apart; reading them too would count routed traffic twice.
- **A gateway line with no input and no output tokens** (a failed attempt) is skipped.

### Claude Code and Codex pointed at the gateway

Claude Code or Codex **on this machine**, pointed at this gateway, is counted **once, from its own logs**. The gateway tags its lines with the tool (`client`: `claude-code` from a `claude-cli/` User-Agent, `codex` from `codex_cli_rs/` or `codex/`) and whether the request came from this machine (`local`), and the ledger skips those lines. The status shows how many were skipped (`skippedLocalClients`).

A request counts as from this machine only when its connection comes from loopback and it carries no forwarding header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP`, `Via`). With `ZAAFPULSE_TRUST_PROXY=1`, a request with `X-Forwarded-For` counts as local only when every address in it is loopback.

The same tools **on another machine** have no logs here, so they are counted **from the gateway**. That includes a tool on this machine that reaches the gateway through a proxy or tunnel (nginx, Caddy, `tailscale serve`, cloudflared, ngrok): the request is not taken as local, and the gateway line is kept. Counting twice is visible; a dropped cost is not.

Two cases fall the other way, and their cost is **dropped** (see [Known limits](#known-limits)):

- Claude Code or Codex on this machine whose logs ZAAFPulse cannot read (another user's folder, or a log folder it does not know): its gateway lines are still skipped as "counted from logs".
- A tool on another machine that reaches the gateway through an SSH or port-forward tunnel (`ssh -L`/`-R`, `kubectl port-forward`, socat): the request arrives from loopback with no forwarding header, so it looks local and is skipped too.

## Pricing

Every source is priced with the same price table and formula as the dashboard (see [Cost and prices](../README.md#cost-and-prices)): input, output, cache reads, cache writes (5-minute and 1-hour), long-prompt tiers, web searches and the 1.1× rate for US-only inference.

- A gateway line carries the whole prompt as `input`: the cached part is priced as cache reads, the rest as input. Cache writes, web searches and the US-only flag are read when a line has them.
- A model with no known price costs 0 and is marked `unpriced`. The status counts unpriced rows and requests.
- The gateway's own figures (`usage.cost`, key budgets, the 402 answer, month spend) are unchanged: the ledger prices gateway lines for itself.

## Frozen cost

- **Price versions.** Each pass compares the effective prices (built-in, snapshot, your own, the live list, pins) with the latest version. A change starts a new price version from that day. A version is never dated before the one before it, and the newest of a day wins. Each version keeps a full copy of its prices in `.data/cost/prices/<id>.json`.
- **Today is open.** Its rows follow the newest prices and the current cost-center rules. Claude Code and Codex rows of today are rebuilt by each pass; gateway and judge lines are priced when they are read, so a price change during the day applies to the lines read after it.
- **Past days are closed.** They keep their prices, centers and billing. A past day only grows, by events that arrive late, and each is priced with that day's version. A closed day never shrinks when logs are deleted.
- **The first run** fills the ledger from your history with the prices of that day. Those rows are marked `backfilled`, and the status says from which day (`backfill.firstDay`).
- **Restate** re-prices a past range on purpose (see [Restate](#restate)).

## Billing

Rows carry the **list cost** (`listUSD`): what the use would cost at list prices. What was **billed** (`billedUSD`) depends on how each source is paid:

- **`metered`** (the default): billed at the list price.
- **`plan`**: the source's usage is billed 0, and each day carries one plan row with the day's share of the fee (`feeUSD` spread over the days of its month or year). The list cost then shows the value you received. Plan rows have no cost center.

**Billing is derived when the ledger is read**, from a dated billing history in `.data/cost/billing.json`. The pass never writes a plan row, so a day is billed exactly once, whatever order the passes ran in and whether the server ran that day at all.

- A change of a source's billing starts a new entry. A change saved in **Settings** is dated the day it is saved; a **hand edit of `config.json`** is dated when the next pass sees it (at most a minute later while the server runs, or at its next start). Earlier days keep the billing they had.
- On the first run, each source takes its current billing from its first day of use.
- A late log line dated before a source's first billing entry is billed as metered: no plan covered that day.
- A restate writes overrides for its range: inside it, the override wins.

`billing.json` and its last good copy `billing.json.bak` are the **only record of past billing**. If `billing.json` does not read, it is recovered from the copy. If both are lost while the ledger already has data, past days are billed as metered and marked `billingAssumed`. A restate of those days corrects their billing. `historyLost` stays set in the status and in each ledger answer **for good**, also after a restate: it records that the history was lost once, not that days are still assumed (the rows' `billingAssumed` says that). While the history does not read at all, the ledger shows every day as metered and names the error.

## Cost centers

The cost center of a row is the first of these that applies:

1. the center of its **gateway key** (`keyCenters`);
2. the first **folder rule** whose glob matches the session's project folder;
3. `unassigned`.

Folder globs are matched against the folder as it is shown: the home folder as `~`, forward slashes.

- `*` is any run of characters inside one folder, and `?` is one character.
- `**/` is any number of whole folders; `**` elsewhere is anything.
- A trailing `/**` matches the folder itself too: `~/work/**` is `~/work` and everything below it.
- Every other character is literal (no `[...]` or `{...}`).
- A glob starts with `~`, `/`, `*` or a drive such as `C:/`. A glob that starts with your home folder is saved with `~`. Backslashes become `/`.
- Matching ignores case on macOS and Windows and respects it on Linux.

**Rule changes apply forward.** Saving the settings re-attributes today's rows at once. Past days keep their centers; a late event on a past day joins its row there, and a new row on a past day takes the current rules. To re-attribute a past range, restate it.

## Display currency

The ledger is in USD. With a display currency, amounts are also converted with the latest rate dated on or before each row's day. You enter the rates, with their dates; ZAAFPulse never fetches rates and makes no outbound connection for the ledger. A day with no rate on or before it gets no converted amount (`null`), and is counted in `missingRate`; it is never filled from a later rate.

## Settings (`config.json` → `cost`)

```json
"cost": {
  "centers": [{ "id": "acme", "name": "Client: Acme" }],
  "keyCenters": { "key_0123456789ab": "acme" },
  "folderRules": [{ "glob": "~/work/acme/**", "center": "acme" }],
  "billing": { "claude": { "mode": "plan", "plan": "Claude Max", "feeUSD": 200, "period": "month" } },
  "currency": { "code": "IDR", "rates": [{ "from": "2026-10-01", "perUSD": 16250 }] }
}
```

| Field | Rule |
|---|---|
| `centers` | up to 50; `id` is lowercase letters, digits and `-` (up to 40), unique, not `unassigned`; `name` 1–60 characters |
| `keyCenters` | up to 1000; a gateway key id to a known center |
| `folderRules` | up to 100, in order (the first match wins); `glob` as above (up to 300 characters, no `***`), `center` a known center |
| `billing` | per source (`claude`, `codex`, `gateway`, `judge`, `replay`, `collab`): `{ "mode": "metered" }` or `{ "mode": "plan", "plan", "feeUSD" (0–1,000,000), "period": "month" \| "year" }` |
| `currency` | `null`, or a three-letter `code` other than `USD` and up to 1000 `rates` `{ "from": day, "perUSD" }` with distinct days |

Settings are validated when saved, and a bad glob, center, billing or rate is refused with the reasons. If the saved section is invalid (a hand edit), the pass **waits**, as it does for a `config.json` that does not parse (below): its defaults would move today's rows to `unassigned`, and a day that closed meanwhile would keep them. It reads no log, records no billing and re-attributes no row, and a restate is refused (409). The status shows `settings.error`: `the cost settings in config.json are invalid, so the ledger pass waits until they are fixed`. The first pass after the fix reads what waited in the logs and attributes it with the fixed rules. Meanwhile no new spend reaches the ledger: budgets count only the gateway calls they recorded themselves, not local Claude Code or Codex use.

If `config.json` itself does not parse (a hand edit with a syntax error, or an editor caught mid-write), the settings are unknown, not empty: the pass **waits** until the file parses again. It reads no log, records no billing, freezes no price version and re-attributes no row, and a restate is refused (409). The status shows `settings.error`: `config.json could not be read, so the ledger pass waits until it does`. The logs keep the data: the first pass after the fix reads it, with lines of days that closed meanwhile counted as late events of their day.

## Restate

A restate re-reads a past range with what holds now: the current prices, the current cost-center rules and the current billing. Use it after fixing a price, adding a folder rule or switching a source to a plan.

```
POST /api/cost/restate
{ "from": "2026-10-01", "to": "2026-10-20", "reason": "Acme folder rule added", "confirm": true }
```

- `to` must be before today: today already follows the current prices and rules. At most 400 days; `reason` 1–200 characters; `confirm: true` is required.
- **List cost and centers** change through one correction appended to `.data/cost/corrections.jsonl`, with the old and new amounts of each row. Stored rows are never rewritten; readers apply the corrections on top, so events that arrive later still count. Rows are daily sums, so each is re-priced from its average request: a row that mixes requests on both sides of a long-prompt tier is approximated.
- **Billing** changes through one override per source for the range, with its current billing. This is also how days billed as `billingAssumed` are corrected.
- The answer holds the correction and the overrides written.

## Budgets

Budgets sit on the ledger. They can cover everything or one cost center, gateway key, project, model, provider or
source, for a local day, a week beginning Monday or a calendar month.

### Budgets in `config.json`

Saved budgets live in `config.json` under `cost.budgets`. At most 100 are accepted.

```json
"cost": {
  "budgets": [
    {
      "id": "acme-month",
      "name": "Acme monthly",
      "scope": { "dim": "center", "value": "acme" },
      "period": "month",
      "amount": 500,
      "currency": "USD",
      "measure": "billed",
      "thresholds": [50, 80],
      "projection": true,
      "enforce": "none"
    }
  ]
}
```

| Field | Rule and default |
|---|---|
| `id` | required; letters, digits, `-` and `_`, up to 80, starting with a letter or digit; unique |
| `name` | required; 1–60 characters, no control characters |
| `scope` | required; `"global"` or `{ "dim": "center" \| "key" \| "project" \| "model" \| "provider" \| "source", "value": "…" }` |
| `period` | required; `day`, `week` (Monday first) or `month`, in local time |
| `amount` | required; above 0 and at most 1e12 |
| `currency` | `USD`, or the configured display currency; default `USD` |
| `measure` | `list` (usage value) or `billed` (what was paid); default `list` |
| `thresholds` | up to two rising whole percentages from 1 to 99; default `[50, 80]`; 100 % is always exceeded |
| `projection` | whether to warn about projected overspend; default `true` |
| `enforce` | `none`, `block` or `pause`; default `none`; the scopes each action supports are below |

Unknown fields, duplicate ids, invalid values and more than 100 budgets are refused with validation reasons. A
saved cost-center scope must name a configured center, a non-USD currency must be the configured display currency,
and a source must be one of the ledger sources. Changing the cost settings is refused with 409 when it would make a
saved budget invalid; edit or delete that budget first.

If `cost.budgets` does not validate, or `config.json` does not parse, the last valid list stays in force. It is kept in
`.data/cost/budgets.last.json`, so it also survives a restart. If there is no valid kept list, only the old monthly and
key budgets apply. `GET /api/cost/budgets` reports the warning and validation reasons; save and delete answer 409 until
the hand edit is fixed. A valid list always replaces the kept list. While `config.json` does not parse, ZAAFPulse does
not write it at all: a save from Settings, the price editor, the cost settings, Integrations, Monitors, Evals, Datasets
or Local models answers 409 `config.json could not be read; fix it first`, and the gateway and second-brain pages refuse
their saves in their own words. The file, and the budgets in it, stay as you left them until you fix it.

### What a budget counts

`list` counts the ledger's list-price value. `billed` counts what was paid after plan billing, corrections and billing
overrides. Plan fee rows have no center, project, key, model or provider, so they count only in global and source
budgets. A budget in the display currency converts the ledger's USD amounts at the latest configured rate on or before
today.

The current ledger rows and gateway calls recorded since the last ledger pass are combined, so a gateway block can
take effect before the next pass. When the saved cost settings or `config.json` cannot be read, the ledger pass waits;
pending gateway calls use the last valid attribution, while local Claude Code and Codex spend reaches budgets only
after the settings are fixed and the ledger pass catches up.

### States and alerts

A budget is `ok`, `warn_<n>` at each configured level, or `exceeded` at 100 %. From 25 % of its period, it is also
`projected` when its current pace would pass the amount. A new period begins at `ok`. An unread ledger month, folder
or corrections file makes the budget `no_data`; so does missing currency data and, for a billed budget, unreadable or
assumed billing history. `no_data` never alerts, blocks or pauses.

Alerts are sent only when the level changes, and projection alerts at most once per period. There are no reminders.
A budget seen for the first time starts at `ok`, so a first state above a level alerts once. A lower level (after the
amount was raised) alerts too. A `no_data` budget keeps its last state and sends nothing.

Alerts appear in the bell and drawer, and can go to the desktop notification and the webhook. The desktop shows the
budget's name as its second line. The webhook body stays the seven fields of every monitor alert (`rule`, `state`,
`previous`, `value`, `threshold`, `sessionId`, `ts`); a budget's name never leaves the machine. Two consequences for a
webhook receiver:

- **It cannot tell budgets apart.** `rule` is `budget` and `sessionId` is `null` for every budget, so nothing in the body
  names the budget. Use the bell or `GET /api/cost/budgets` to see which one changed.
- **A projection alert has `state` equal to `previous`.** A budget at `warn_50` whose pace starts to pass the amount
  sends `warn_50`/`warn_50`. Only the bell and the drawer say "projected".

### Block

`block` works for global, key, center, model, provider and `source: gateway` budgets. The gateway checks the blocking
budgets in scope before it sends a request to each route target. Spent is the ledger's total for the period plus the
gateway calls recorded since the last ledger pass, so a budget blocks at the next request, not at the next pass.

- **Route targets.** A target whose provider or model budget is used up is skipped and the next target is tried. Only
  when no target is left does the gateway answer 402, with a message that names only the budget that refused it and its
  period, for example `budget "Acme key" is used up for this month`. No figures and no other budget are in it.
- **Which calls.** Dashboard calls (no key) meet only global, model and provider budgets. Key, center and source
  budgets need a key; a key's center comes from `cost.keyCenters` (`unassigned` when it has none). The model checked
  is the name the call is logged under, as in the ledger.
- **The Playground counts but is never blocked.** The ledger tags the dashboard's own gateway calls (the Playground)
  as source `gateway`, so they count toward a `source: gateway` budget, but the guard never blocks a call without a
  key. Your own Playground use can therefore use up such a budget and cut off every keyed client, while the
  Playground keeps working. Use a key or center budget to limit clients without counting your own use.
- **Priced models only.** A key under a blocking key or center budget may call only priced (or private) models, as a
  key with `budgetUSD` could before. Global, model and provider budgets do not add this rule.
- **Overshoot.** Nothing is reserved: every request already in flight finishes, so concurrent requests can pass the
  amount by more than one call (one per request in flight).
- **Lift.** A new period or a raised amount lifts the block at the next request.
- **Fail open.** When spent cannot be computed (the budget is `no_data`, the ledger read throws, the list does not
  read), the guard lets the request through and reports why under `guard.error` and `guard.problems` in
  `GET /api/cost/budgets`, path-free. When the check itself fails, the request goes through too, and
  `the budget check failed, so requests are allowed` is listed with `budget: null` until a check works again.

The guard reads the budget list once for each route target it checks, so a route with several targets costs a few more
reads per request; a route has a handful of targets at most.

### Pause

`pause` works for global, project, center, model and `source: claude` or `source: codex` budgets. When such a budget
is `exceeded`, ZAAFPulse pauses one local Claude Code or Codex session, once per period:

- **The target** is the running session that spent the most in the budget's scope and period, on the budget's measure.
  For a model budget that is the session's spend on that model; for other scopes, the session's cost in the period
  (a source, project or center budget counts only sessions in its scope). For a `billed` budget, days on which the
  session's source was on a plan count as zero. The sessions are ranked with today's list prices; this only picks the
  target and changes no figure. A session with nothing spent in scope is never paused.
- **Once per period, once the agent was looked up.** When the process behind the chosen session has been looked up,
  the period is used up whatever the outcome (paused, no matching process, several, refused): the budget does not
  pause again until its next period. Until then it keeps looking. With no running session in scope, a session not
  indexed yet, or a process table that does not read, nothing is used up, and a later pass can pause a session that
  starts running later in the period. A budget that becomes exceeded before the server has read the running sessions
  acts on the first live pass.
- **A change wins, until the pause is sent.** If the budget is saved while its agent is being looked up (pause turned
  off, another scope, measure or period, or no longer exceeded), nothing is signalled and nothing is used up; the next
  pass decides with the budget as it is now. A save that lands once the pause has started (while the process is being
  verified for the signal) does not stop it; resume the agent from the dashboard.
- **No candidate** (no running session in scope has spent anything this period) is reported once in the bell, and
  the budget keeps looking. When the home folder is not known, project and center budgets cannot match a session's
  folder: they pause nothing and say so once, path-free. Source, model and global budgets still pause.
- **Never on `no_data`**, and a paused agent is never resumed automatically.

Every rule of [agent control](monitors.md#agent-control) applies: the process is verified again before the signal,
there is no SIGKILL, and every action goes to `.data/agent-audit.jsonl`. Windows cannot pause a process. Agent control
is off in server mode, with a password sign-in or no sign-in, and in Docker; saving a pause budget there is refused
with 409. A pause budget that is in force there anyway (written by hand, or saved before the server changed) pauses
nothing and says so once per period in the bell (`could not pause: agent control is off …`). Demo mode never pauses or notifies.

### Migration

The old top-level `monthlyBudgetUSD` and each gateway key's `budgetUSD` are read as budgets with the default thresholds
and projection. The old `daily_cost` and `month_projection` monitor rules have been replaced by budgets and are no
longer evaluated, acted on, listed or counted, and a change to them answers 410. Their old states and alerts remain as
history.

Nothing replaces `daily_cost` automatically: `legacy-monthly` is a monthly, notify-only budget. If you had `daily_cost`
on with a daily limit of your own, or with auto-pause, create a `day` budget with that amount to keep it, with
`"enforce": "pause"` if you used auto-pause (where agent control is on).

One overlap at the upgrade: `legacy-monthly` is seen for the first time, so its first pass alerts from `ok` (for
example "Passed 80 %" or "Projected") even when a `month_projection` alert from before the upgrade is still open. That
old alert never gets a resolution, because the rule is retired. Each overspend is announced at most twice, and only
once, at the upgrade.

Editing the old monthly budget through the budget API saves it as `legacy-monthly` and clears `monthlyBudgetUSD` in
the same `config.json` write. Editing a key budget saves its replacement first and then clears the key's `budgetUSD` in
`keys.json`; the saved budget wins between those writes, so it is never counted twice. Once the monthly budget is
managed this way, the old Settings field shows its managed amount and ignores edits. A key's spend now uses the
ledger's shared pricer, so it may read slightly higher than the key table.

### Budget API

These routes have the same dashboard sign-in and JSON requirements as the other cost routes.

| Route | Answer |
|---|---|
| `GET /api/cost/budgets` | `{ budgets, error, reasons, guard: { error, problems }, kept: { error } }`; each budget includes its period, spent, percent, state and projection |
| `POST /api/cost/budgets` | creates or replaces one budget; 200 `{ budget }`, 400 `{ error, reasons }`, or 409 while the saved list is invalid or pause is unavailable |
| `POST /api/cost/budgets/<id>/delete` | 200 `{ deleted }`, or 404; deleting a legacy budget also clears its old setting |

Writes need `Content-Type: application/json` (415 otherwise). Responses and validation reasons never expose a file
path.

## Cost Control menu

The sidebar's **Cost Control** (after Quality & safety) has five pages. Each reads the ledger as billed, with the
corrections and billing applied, and shows only numbers, names, `~` folders and model names.

| Page | Question | What it shows |
|---|---|---|
| Overview (`#cost`) | How much this month, and is it safe? | Month to date in both measures; the forecast at the mean daily spend, with a band from the 25th to 75th percentile day (none before the 3rd day); the global monthly budgets as lines; daily spend against a baseline; budget rings, riskiest first |
| Breakdown (`#cost/breakdown`) | Where does the money go? | Source, provider, model and cost center as a flow (top 6 per column, the rest as Other; plan fees as "Plan fee"); projects by cost center as an isometric treemap (footprint by spend, block height by spend per request); a calendar of the range; a table grouped by up to four dimensions, read from `/api/cost/ledger` |
| Value (`#cost/value`) | Is it worth it? | Usage value of each plan's days against its fee, with the multiplier; a waterfall from "without cache" through cache and plan savings to what was paid; local models (requests and tokens, not priced); spend per request against tool-call accuracy per model; spend per request, per million tokens and per 1,000 successful tool calls, per day |
| Budgets (`#cost/budgets`) | Set the limits | One card per budget with its ring, scope, period, spent of amount and chips; add, edit and delete in a drawer (the rules are in [Budgets](#budgets)) |
| Settings (`#cost/settings`) | Who pays for what? | Cost centers, gateway keys and folder rules with a preview of what moves, billing per source, the display currency, and restate with a preview and its history (see [Settings page](#settings-page)) |

**Controls.** One bar on every page but Budgets: the range (7 days, 30 days, this month, last month or two dates, at
most 400 days), the currency (USD, or the display currency once it has a rate) and the measure (usage value or paid).
They live in the URL, `#cost/<page>?range=7d&cur=IDR&measure=billed`, and the last choice is kept in the browser's
`localStorage` (`zp.cost.controls`). A value that does not read falls back to 30 days, USD and usage value. The
Overview is always the current month. Value hides the measure switch: its plan and waterfall figures show both
measures, and the accuracy chart and the unit costs use usage value (local models show requests and tokens, no money).

**Spikes.** A day is a spike when its usage spend is more than twice its baseline and at least $1 over it. The baseline
is the mean of the known days among the 7 before it. A day needs at least 3 known days of baseline; days before the
ledger's first row are unknown, not zero, so a new ledger shows no spikes at first. A plan fee never counts as a spike
in either measure. The burn-down still includes plan fees, under "Paid".

**Burn-down scale.** The axis covers the spend so far, the forecast's end and the band. A budget more than twice that
reach is not drawn to scale: it is pinned at the top edge as "↑ Budget <amount>", so the curve stays readable.

**Breakdown.** The treemap shows at most 40 blocks, the per-center "Other" blocks (a center's smallest projects beyond
the cap) included. With spend in more than 39 cost centers, the smallest fold into one "Other centers" block. Clicking a
node in the flow filters the table by it (Other, Unknown and Plan fee are groupings, not ledger values, and are not
filters; their tooltip says so): the table asks the ledger for that dimension too, without a column for it (every row
has the same value). Under "Paid", Unassigned holds the usage rows without a center rule; plan fees have no center and
read "Plan fee". The table takes up to four groupings: with four checked and a filter on, the last grouping is left out
while the filter is on, and an amber chip says so.

**Budgets page.**

- The id comes from the name: accents stripped, lowercase `a-z`, `0-9` and dashes, with `-2`, `-3` when taken.
- The enforcement options match what the server accepts. Block: global, key, cost center, model, provider and source
  gateway. Pause: global, project, cost center, model and source `claude` or `codex`.
- Deleting a budget that came from the old settings says so; a budget saved from this page does not.
- A budget alert in the bell has an "Open in Budgets" link to `#cost/budgets?focus=<id>`, which shows that card.
- The badge on the menu counts the budgets used up or projected over.

**Refresh.** The cost pages refresh every 60 seconds, quietly, and keep what is on screen until the new answer comes. A
refresh waits while a form field has focus, while the Budgets drawer or a delete confirmation is open, and while the tab
is hidden. A quiet refresh that fails keeps the last figures with a note ("Could not refresh: …"); a load that fails
shows the error with Retry. With the system's reduced motion setting, charts and numbers appear at their final state.

**Cache savings** are an estimate: cache-read tokens × (input price − cache-read price) at the base rates of each
row's price version. Prompt-length tiers and US-only pricing are left out. Free (local) rows add no money.

**Tool-call accuracy per model** follows the Quality page's definition (see
[docs/quality-metrics.md](quality-metrics.md#accuracy-which-failures-count-against-the-model)), counted per model from
the Claude Code and Codex logs. A model with fewer than 50 tool results in the range is drawn hollow ("little data"); a
model without tool calls (gateway only) is listed under the chart. When a Datasets experiment that ended in the range
ran a model, its pass rate (passes over totals across its evaluators) is in the dot's tooltip. After the update that
added these counts, the index is rebuilt once at the first start.

**Gaps and notes.** A month that did not read, a day that had no rate and billing that did not read are named above the
charts. A day with no rate is counted in USD; `missingRate` lists only the days that had spend in the chosen measure (or
a drawn baseline) without a rate. A unit-cost day without its denominator is a gap, not a zero. A ribbon repeats the
ledger status problems (`GET /api/cost/status`). If the budgets or the accuracy cannot be read, the page says so and
draws the rest.

**Limits of these pages.**

- Cache savings is an estimate, as above.
- Local models are not priced. They show requests and tokens only.
- Per-session cost is not shown.
- A new budget saved with an id that another browser tab just created replaces that budget. There is no create-only
  mode yet.

## Fail closed

The ledger never guesses over data it could not read.

- **A ledger month or the corrections file that does not read** (a permission or disk error) is named in the status (`ledger.unread`) and in every ledger answer that touches it (`unread`). The other months still show. The pass steps that need it stop before they change anything, their log positions stay where they were, and the next pass reads the same lines again: the logs keep the data, so nothing is lost and nothing is counted twice. A restate over it is refused (503) until it reads.
- **A line that does not parse** is moved to `<file>.bad` beside it, and the rest of the file loads. The status counts such lines (`ledger.badLines`).
- **A collector that fails** shows its error in the status and does not stop the others.
- **The log positions** (`cursors.json`, how far the gateway and judge logs were read) are written with a last good copy, `cursors.json.bak`. A missing, empty, torn or invalid `cursors.json` is moved aside to `cursors.json.bad` (or `.bad.1`, …) and recovered from the copy; the status names the recovery (`cursors.problems`). If neither reads on a later run, reading those logs from the start would count every line still in them twice, so the **gateway and judge lines are paused**: the status shows `cursor state lost: gateway and judge lines are paused; see docs/cost.md (rebuild)` (`cursors.error`, and the error of both collectors). Claude Code and Codex go on, rebuilt from the index. Nothing is written over the lost positions, so a restart stays paused. To go on, [rebuild the ledger](#rebuilding-the-ledger). A true first run (no ledger rows, price versions or billing history yet) simply reads every log once.
- Every message is a fixed phrase with an error code: no file path leaves the server.

## Project folders

Project folders are stored and shown with the home folder as `~` and forward slashes (`~/work/acme`). A folder outside the home folder is shown in full (`/srv/app`, `D:/work/app`). The ledger holds numbers, model, provider, key and agent names and project folders only: never prompt, reply or tool text.

## Files

Everything is under `.data/cost/` (`ZAAFPULSE_DATA` decides where `.data` is). Folders are mode 0700 and files 0600 (not enforced on Windows), and every rewrite goes through a temporary file that is synced to disk before the rename (and the folder after it, except on Windows), so a power loss leaves the old copy or the new one.

| File | What |
|---|---|
| `ledger-YYYY-MM.jsonl` | one row per day and dimension tuple (source, provider, model, project, center, key, agent, kind) |
| `corrections.jsonl` | the corrections restates wrote |
| `billing.json`, `billing.json.bak` | the billing history and its last good copy |
| `cursors.json`, `cursors.json.bak` | how far the gateway and judge logs were read, and the ledger's first day; and its last good copy |
| `judge-calls.jsonl` | judge calls that skip the gateway |
| `budgets.last.json` | the last valid saved budget list and cost-setting context needed to keep it in force |
| `prices/versions.json`, `prices/<id>.json` | the price versions and a full copy of each |

### Rebuilding the ledger

To rebuild the ledger from its sources (for example after `cursor state lost`):

1. Stop the server.
2. Delete everything in `.data/cost/` **except `judge-calls.jsonl`**: that file is itself a source (the judge calls that skip the gateway), and deleting it loses them.
3. Start the server. The first pass reads the logs again, as a first run.

The rows come back marked `backfilled` (every day before the rebuild), priced at the current prices, attributed with the current rules and billed from the current settings. The restates, the billing history and the price versions are gone. Only what the sources still hold comes back: the gateway log keeps two 10 MB files, and Claude Code removes old transcripts after its cleanup period (30 days by default), so older history is lost. Never delete `cursors.json` on its own: that pauses the gateway and judge lines as above.

### Settings page

**Settings** (`#cost/settings`) edits the `cost` section of `config.json` without opening the file. It has four
panels; each of the first three has its own **Save**, which reads the saved settings again and sends them with only
that panel's fields replaced, so a mistake in one panel never holds back another. Saves of different panels run one
after another. Typing while a Save runs is kept as a draft: only a draft that still says what was sent is cleared.
Unsaved changes are kept per panel while the browser tab is open (leave the page and come back: they are still there,
with **Discard**), and closing the tab with unsaved changes asks first. The page has no range, currency or measure
control and does not refresh by itself.

| Panel | What it edits |
|---|---|
| Cost centers & rules | `centers` (a new center's id is made from its name and is fixed after the first Save; Delete is off while a key or rule uses the center), `keyCenters` (one row per gateway key: a center, or "Folder rules decide"), `folderRules` (in order, moved with Up and Down; the first match wins) |
| Billing | `billing`: Metered or a plan (name, fee in USD, month or year) per source; every source is written out |
| Display currency | `currency`: USD only, or a code with dated rates; the rates are sorted by start date when the panel is saved; today's rate is shown as `rateFor` picks it |
| Restate | a [restate](#restate) of a past range, after a preview |

**New center ids.** While a new center's id is made from its name, or typed by hand, the keys and rules that chose
that center follow the id as it is typed. They stay where they were while the id equals another center's id, and
follow once it is its own again.

**Preview of the rules.** About 400 ms after an edit, the page asks the server what the draft would do over the last
30 days, with the server's own validation and glob matcher: the projects and keys that change center, the rules that
match nothing or that an earlier rule always takes, the projects still Unassigned (each with **Create rule**, which
adds `<project>/**`), and where a typed path goes. A draft that does not validate shows the reasons a Save would give.

**Changes apply from today.** After a Save of the rules or the billing, new costs follow them; past days keep theirs
until restated. The note after the Save opens the Restate panel with the first of this month to yesterday. Rates are
not frozen per day: a rate change also changes how past days read in the display currency (USD never changes).

**Restate panel.** **Preview** shows how many ledger rows change, the usage value before and after, the center moves,
the price versions (or "today's prices, not yet recorded as a version") and the billing set over the range. **Run
restate** then needs a reason and the box "I understand this correction cannot be undone". It stays off while a Save
is in flight, and it needs a fresh preview of the same range made after the last Save: a range edit or a Save since
the preview asks for a new one. Leaving the page while a restate runs clears the preview, the reason and the box (the
correction may have been recorded) and the history loads again on the next visit. The panel lists past restates,
newest first (at most 100).

**When the settings do not read** (`config.json` does not parse, or its `cost` section does not validate) the page
shows the error and the reasons, and every Save and the restate are off: the values shown are the defaults that stand
in for the invalid ones. The previews still work on the drafts. A Save refused because budgets depend on the change
lists them with a link to Budgets.

## API (dashboard sign-in only)

These routes need the dashboard sign-in. A gateway API key, MCP or A2A is never accepted. A state change needs `content-type: application/json` (415 otherwise).

| Route | Answer |
|---|---|
| `GET /api/cost/ledger?from&to&groupBy&currency` | rows grouped by 1–4 of `day`, `source`, `provider`, `model`, `project`, `center`, `keyId`, `agent`, `kind`; at most 400 days; `to` defaults to today, `from` to the first of its month |
| `GET /api/cost/status` | the collectors, the price version, unpriced and backfilled counts, settings, billing and ledger health |
| `GET /api/cost/settings` | `{ settings, error, reasons, sources, unassigned, keys: [{ id, name }] }`; `reasons` lists why the saved section does not validate (at most 50), else `[]` |
| `POST /api/cost/settings/preview` | body `{ settings, testPath? }` (`testPath` at most 1000 characters, a path written with `~` or in full). 200 `{ from, to, unread, moves: [{ project, keyId, keyName, listUSD, from, to }], more, rules: [{ index, status: ok \| none \| shadowed, by }], unassigned: [{ project, listUSD }], test: { center, rule } \| null }` over the last 30 days, the settings in force against the draft; nothing is saved. 400 for an unknown field or `{ error, reasons }` for a draft that does not validate; 503 with a `code` while the ledger does not read |
| `GET /api/cost/view?page&from&to&currency&measure` | what one Cost Control page draws. `page` is `overview` (always the current month), `breakdown` or `value`; `from`/`to` default to the last 30 days, at most 400; `measure` is `list` (default) or `billed`; Value ignores `measure` and answers `measure: null`. The answer is `{ page, from, to, currency, measure, unread, missingRate, billing: { error, historyLost } }` beside the page's data, plus `budgetsError` on Overview and `accuracyError` on Value (a fixed phrase, or null). 400 for an unknown page, a bad measure or date, a range over 400 days or a currency without rates; 503 with a `code` while the ledger does not read |
| `POST /api/cost/settings` | 200 `{ settings }` (normalized; today's rows are re-attributed at once), or 400 `{ error, reasons }` |
| `GET /api/cost/budgets` | the budgets in force, their state, list warnings, guard problems and kept-file status |
| `POST /api/cost/budgets` | create or replace one budget; 400 for validation, 409 while a hand edit is invalid or pause is unavailable |
| `POST /api/cost/budgets/<id>/delete` | delete a saved or legacy budget |
| `GET /api/cost/prices/versions` | `{ current, versions: [{ id, from, at, hash, changed, changedCount }] }` |
| `POST /api/cost/restate` | 200 `{ correction, overrides }` |
| `POST /api/cost/restate/preview` | body `{ from, to }`; what a restate would do, written nowhere: 200 `{ from, to, changed, total, beforeUSD, afterUSD, moves: [{ from, to, listUSD }], versionsBefore, version, newPrices, billing }` (`version` null and `newPrices` true while today's prices are not a version yet). The 400, 409 and 503 of `POST /api/cost/restate`, without `reason` and `confirm` |
| `GET /api/cost/restates` | `{ restates: [{ ts, from, to, reason, priceVersion, rows, billing }] }`, newest first, at most 100; `rows` counts the rows that changed. 503 while the corrections do not read |

**Ledger answer:** `{ from, to, groupBy, currency, rows, totals, missingRate, corrections, unread, billing: { error, historyLost } }`. Each row has `requests`, `tokens` (`in`, `out`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`), `webSearches`, `listUSD`, `billedUSD` and the flags `unpriced`, `estimated`, `backfilled`, `billingAssumed` (true when any row in the group is). With `currency` (the configured code) rows and totals also carry `list` and `billed`.

**Status fields:**

| Field | |
|---|---|
| `demo` | the demo ledger is shown |
| `collectors.local`, `.gateway`, `.judge` | `sources`, `at` (last read), `read` (events in the last pass), `total` and `skippedLocalClients` (since `since`, this start), `error` |
| `priceVersion` | `{ id, from, hash }` of the current version |
| `prices.problems` | price versions that could not be used |
| `unpriced` | `{ rows, requests }` with no known price |
| `backfill` | `{ firstDay, rows }` |
| `settings.error` | set when the saved settings are invalid or `config.json` does not parse: the pass waits |
| `cursors` | `{ error, problems }`: `error` while the log positions are lost (the gateway and judge lines are paused), `problems` for a recovery from the last good copy |
| `billing` | `{ error, historyLost, problems }` |
| `ledger` | `{ badLines, corrections, error, unread }` |

Errors: 400 for bad input, 409 for a restate while the saved settings are invalid or `config.json` does not parse, 503 with a `code` while a month, the corrections or the billing history does not read.

## Demo mode

The demo shows a synthetic ledger held in memory: three cost centers, Claude Code on a plan, an IDR rate, two price versions, backfilled days, an unpriced model and a free local judge. No files are written and the pass never runs; settings and restate work in memory. The Settings page previews from the demo ledger and settings; its restate history starts empty and a restate is kept in memory. The Cost Control pages draw from it too; the demo's quality signals carry per-model tool results, so Value shows a scatter.

## Known limits

- **Local Claude Code or Codex through a key.** Its own usage is counted from the local logs under source `claude` or
  `codex`, without the gateway key. A key budget does not count that usage, although once that key budget is used up by
  other traffic the gateway refuses the local tool's next request through the key.
- **Concurrent gateway requests can overshoot a block.** There is no reservation. Requests already in flight finish,
  so the budget may pass its amount by more than one call.
- **Invalid cost settings delay local spend.** While the cost section or `config.json` does not read, the ledger pass
  waits. Pending gateway calls use the last valid settings, but local Claude Code and Codex usage is absent from budget
  spend until the settings are fixed and a pass reads it. The pending gateway calls are kept in memory only: a restart
  during that wait drops them from every budget until the fix, when the ledger reads them from the gateway log.
- **Gateway calls just before a restart.** A block counts the gateway calls made since the last ledger pass from
  memory. After a restart those calls count again only when the first ledger pass reads them from the gateway log,
  which runs after the first index refresh. Until then a key or global block reached through such calls lets requests
  through: at most about one pass interval of calls.
- **A kept list that no longer fits after a restart.** If `config.json` does not parse at startup and the kept list in
  `budgets.last.json` no longer validates against the settings in force (for example, a hand edit removed a center
  that a budget names), only the old monthly and key budgets apply, with a warning in `GET /api/cost/budgets`.
- **Two log rotations between passes.** The gateway log rotates at 10 MB and keeps one older file (`.1`). If it rotates twice between two passes (about a minute apart), the middle file is gone and its lines are not counted.
- **A crash between two writes** of a pass (the ledger rows, then the log positions) can count that pass's gateway and judge lines twice. The other order would lose them; counting twice was chosen because it is visible and a restate corrects it.
- **Agent and collaboration models called by a local tool.** Claude Code or Codex on this machine calling an `agent/…` or `collab/…` model through a key is counted twice: once from the tool's logs, and once from the gateway lines of the models the agents call, which are not tagged.
- **Embeddings from a local tool.** An embeddings request sent with a Claude Code or Codex User-Agent from this machine is skipped like its chat requests, though those tools log no embeddings.
- **The collector counts restart.** `total` and `skippedLocalClients` count from the server's start.
- **Local tools whose logs cannot be read.** Claude Code or Codex on this machine that ZAAFPulse cannot read the logs of loses its cost when it calls the gateway: the gateway lines are skipped as "counted from logs", and there are no logs to count. The status counts the skipped lines (`skippedLocalClients`).
- **SSH and port-forward tunnels look local.** A tool on another machine that reaches the gateway through `ssh -L`/`-R`, `kubectl port-forward` or socat arrives from loopback with no forwarding header, so a Claude Code or Codex line from it is skipped as local, and its cost is dropped. A reverse proxy that adds a forwarding header (nginx, Caddy) is counted from the gateway instead.
- **A crash during the very first pass** can leave the log positions unsaved after the billing history was written. The next start then pauses the gateway and judge lines as for lost positions; a first run's data all comes back from the sources, so a [rebuild](#rebuilding-the-ledger) loses nothing.
