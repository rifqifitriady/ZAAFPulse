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

- A change of a source's billing in the settings starts a new entry, dated the day it is saved. Earlier days keep the billing they had.
- On the first run, each source takes its current billing from its first day of use.
- A restate writes overrides for its range: inside it, the override wins.

`billing.json` and its last good copy `billing.json.bak` are the **only record of past billing**. If `billing.json` does not read, it is recovered from the copy. If both are lost while the ledger already has data, past days are billed as metered and marked `billingAssumed`, and the status shows `historyLost`, until a restate of those days says otherwise. While the history does not read at all, the ledger shows every day as metered and names the error.

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

Settings are validated when saved, and a bad glob, center, billing or rate is refused with the reasons. If the saved section is invalid (a hand edit), the defaults apply to attribution and the status says so; the billing history is not rewritten from those defaults, and a restate is refused until the settings are fixed.

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

## Fail closed

The ledger never guesses over data it could not read.

- **A ledger month or the corrections file that does not read** (a permission or disk error) is named in the status (`ledger.unread`) and in every ledger answer that touches it (`unread`). The other months still show. The pass steps that need it stop before they change anything, their log positions stay where they were, and the next pass reads the same lines again: the logs keep the data, so nothing is lost and nothing is counted twice. A restate over it is refused (503) until it reads.
- **A line that does not parse** is moved to `<file>.bad` beside it, and the rest of the file loads. The status counts such lines (`ledger.badLines`).
- **A collector that fails** shows its error in the status and does not stop the others.
- Every message is a fixed phrase with an error code: no file path leaves the server.

## Project folders

Project folders are stored and shown with the home folder as `~` and forward slashes (`~/work/acme`). A folder outside the home folder is shown in full (`/srv/app`, `D:/work/app`). The ledger holds numbers, model, provider, key and agent names and project folders only: never prompt, reply or tool text.

## Files

Everything is under `.data/cost/` (`ZAAFPULSE_DATA` decides where `.data` is). Folders are mode 0700 and files 0600 (not enforced on Windows), and every rewrite goes through a temporary file and a rename.

| File | What |
|---|---|
| `ledger-YYYY-MM.jsonl` | one row per day and dimension tuple (source, provider, model, project, center, key, agent, kind) |
| `corrections.jsonl` | the corrections restates wrote |
| `billing.json`, `billing.json.bak` | the billing history and its last good copy |
| `cursors.json` | how far the gateway and judge logs were read, and the ledger's first day |
| `judge-calls.jsonl` | judge calls that skip the gateway |
| `prices/versions.json`, `prices/<id>.json` | the price versions and a full copy of each |

Deleting `.data/cost/` rebuilds the ledger from the logs at the next pass, with today's prices and settings, marked `backfilled`. That also drops the restates and the billing history.

## API (dashboard sign-in only)

These routes need the dashboard sign-in. A gateway API key, MCP or A2A is never accepted. A state change needs `content-type: application/json` (415 otherwise).

| Route | Answer |
|---|---|
| `GET /api/cost/ledger?from&to&groupBy&currency` | rows grouped by 1–4 of `day`, `source`, `provider`, `model`, `project`, `center`, `keyId`, `agent`, `kind`; at most 400 days; `to` defaults to today, `from` to the first of its month |
| `GET /api/cost/status` | the collectors, the price version, unpriced and backfilled counts, settings, billing and ledger health |
| `GET /api/cost/settings` | `{ settings, error, sources, unassigned, keys: [{ id, name }] }` |
| `POST /api/cost/settings` | 200 `{ settings }` (normalized; today's rows are re-attributed at once), or 400 `{ error, reasons }` |
| `GET /api/cost/prices/versions` | `{ current, versions: [{ id, from, at, hash, changed, changedCount }] }` |
| `POST /api/cost/restate` | 200 `{ correction, overrides }` |

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
| `settings.error` | set when the saved settings are invalid and the defaults apply |
| `billing` | `{ error, historyLost, problems }` |
| `ledger` | `{ badLines, corrections, error, unread }` |

Errors: 400 for bad input, 409 for a restate while the saved settings are invalid, 503 with a `code` while a month, the corrections or the billing history does not read.

## Demo mode

The demo shows a synthetic ledger held in memory: three cost centers, Claude Code on a plan, an IDR rate, two price versions, backfilled days, an unpriced model and a free local judge. No files are written and the pass never runs; settings and restate work in memory.

## Known limits

- **Two log rotations between passes.** The gateway log rotates at 10 MB and keeps one older file (`.1`). If it rotates twice between two passes (about a minute apart), the middle file is gone and its lines are not counted.
- **A crash between two writes** of a pass (the ledger rows, then the log positions) can count that pass's gateway and judge lines twice. The other order would lose them; counting twice was chosen because it is visible and a restate corrects it.
- **Agent and collaboration models called by a local tool.** Claude Code or Codex on this machine calling an `agent/…` or `collab/…` model through a key is counted twice: once from the tool's logs, and once from the gateway lines of the models the agents call, which are not tagged.
- **Embeddings from a local tool.** An embeddings request sent with a Claude Code or Codex User-Agent from this machine is skipped like its chat requests, though those tools log no embeddings.
- **The collector counts restart.** `total` and `skippedLocalClients` count from the server's start.
