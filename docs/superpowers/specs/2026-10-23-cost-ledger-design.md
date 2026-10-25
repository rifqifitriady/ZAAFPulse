# Cost Control, sub-project 1: the cost ledger, attribution and pricing

Date: 2026-10-23 · Status: approved in brainstorming, awaiting spec review · Builds on: Monitors (#40), Datasets (#41), follow-ups (#49).

## Cost Control: the whole feature

"Cost Control" is a new dashboard menu for watching, budgeting and governing what AI use costs. It is built in five sub-projects. Each one gets its own spec, plan and implementation.

| # | Sub-project | Covers |
|---|---|---|
| 1 | **Cost ledger, attribution and pricing** (this spec) | One durable daily ledger across sources, frozen cost, cost centers, billing modes (metered or plan), display currency, price versions |
| 2 | Budgets, alerts and enforcement | Budgets per scope (global, cost center, project, model, provider, key, agent), periods, soft thresholds (50/80/100 %), actions (notify, pause agent, block key, route to a cheaper or private model) on the Monitors engine |
| 3 | The Cost Control menu | Tabs Overview · Explorer · Budgets · Pricing · Savings, with animated holo charts in the ZAAFPulse style |
| 4 | Forecast, anomalies and recommendations | 7-day and weekday-aware forecast, "budget X runs out on date Y", spike detection, cheaper-model suggestions backed by Datasets replay |
| 5 | Reports, export and MCP | CSV/JSON export, a weekly digest over the webhook, showback per cost center, MCP tools `acc_cost` / `acc_budgets` |

**Charts planned for sub-project 3** (recorded here so the ledger carries the data they need): budget burn-down with a projection band; holo budget rings per scope; a cost flow (source → provider → model → project / cost center); an isometric treemap; an hour × weekday heatmap; a spike line against a 7-day baseline; plan value against plan fee; a savings waterfall; cost against quality per model; unit-cost trends (per session, per request, per passing task).

## Decisions taken in brainstorming

| Topic | Decision |
|---|---|
| Who uses it | The owner plus a few people or clients through gateway API keys. No user or team management. |
| Billing mode | Per source: **metered** (default; cost = list price) or **plan** (a fixed fee per period; list price becomes "value received"). |
| Currency | Everything is stored in USD. One display currency (e.g. IDR) with **owner-entered rates per date**; budgets may be written in it. No outbound rate service. |
| Historic cost | **Frozen when it happens.** A price change applies forward only. "Restate this period" re-prices on purpose and is recorded as a correction with old and new prices. |
| Cost centers | A gateway key's cost center first, then **project folder rules** (globs, first match wins), else `Unassigned`. Rule changes apply forward only unless restated. |
| OmniRoute | **Not in the ledger** in this version, to avoid counting routed traffic twice. Cost Control shows OmniRoute's own figures as a separate reference panel. |
| Ledger shape | A **daily aggregated ledger plus a price-version table** (not per event, not read-time recompute). |

## Goal of this sub-project

One trustworthy cost record that every later sub-project reads: the same formula for every source, cost frozen at the price of its day, attributed to a cost center, and split into what was paid and what the use was worth. Existing pages, the gateway key budget (402) and Monitors keep working unchanged; they move onto the ledger in sub-projects 2 and 3.

## Components (`lib/cost/`)

| File | Responsibility |
|---|---|
| `collect.js` | One collector per source, each turning raw records into a normalized usage event `{ ts, source, provider, model, tokens: { in, out, cacheRead, cacheWrite5m, cacheWrite1h }, webSearches, geo, project, keyId, agent, kind, estimated }`. Sources: the local log index (Claude Code, Codex), `.data/gateway-usage.jsonl`, the eval judge, Datasets replay, collaboration runs. |
| `prices.js` | Price versions. When the effective pricing changes (manual edit, sync, pin), a version `{ id, from, hash, pricing }` is stored. `versionFor(day)` returns the version in force that day. |
| `rules.js` | The owner's settings in `config.json` → `cost`: key → cost center, folder globs → cost center, billing mode per source, display currency and its dated rates. Validation lives here. |
| `ledger.js` | The store: `.data/cost/ledger-YYYY-MM.jsonl`, `.data/cost/corrections.jsonl`, `.data/cost/cursors.json`, `.data/cost/prices/`. Upserts today's rows, keeps past days closed, applies late events, restates on request. |
| shared pricer | Every source is priced with the existing `makePricer` from `lib/pricing.js` (cache writes 5m/1h, prompt-length tiers, web search, US geo). The gateway joins this formula, so its cost no longer differs from the local cost for the same tokens. |
| `api.js` | `/api/cost/*` routes, behind the dashboard sign-in. |

## Data model

**Ledger row** — one per day and dimension tuple:

```
{ day, source, provider, model, project, center, keyId, agent, kind,
  requests, tokens: { in, out, cacheRead, cacheWrite5m, cacheWrite1h }, webSearches,
  listUSD,        // list-price cost, frozen with the day's price version
  billedUSD,      // what was paid: = listUSD when metered, 0 for a source on a plan
  priceVersion, unpriced, estimated, backfilled }
```

- `day` is `YYYY-MM-DD` in the machine's local time zone, the same day boundary the dashboard uses today.
- `source` is one of `claude`, `codex`, `gateway`, `judge`, `replay`, `collab`. `kind` is the request kind (`chat`, `embed`, `judge`, `replay`, `run`, …) or `plan` for a plan row.
- `project` is the session's working folder with the home folder shown as `~`; `null` for sources without one.
- `unpriced: true` means no price was known: `listUSD` is 0 and the row is counted and reported, never hidden.

**Plan row** — one per day for each source on a plan: `{ day, source, kind: 'plan', plan, billedUSD }`, where `billedUSD` is the plan fee divided by the days in its period. For a source on a plan:
- value received = the sum of its `listUSD`;
- paid = the sum of its `billedUSD` (its plan rows).
No figure is counted twice.

**Correction** — `{ ts, from, to, reason, rows: [{ key, before: { listUSD, billedUSD, priceVersion }, after: {…} }] }`. The original rows stay; readers apply corrections on top.

**Settings** (`config.json` → `cost`):

```
{ centers: [ { id, name } ],
  keyCenters: { <keyId>: <centerId> },
  folderRules: [ { glob, center } ],          // ordered; first match wins
  billing: { <source>: { mode: 'metered' } | { mode: 'plan', plan, feeUSD, period: 'month' | 'year' } },
  currency: { code: 'IDR', rates: [ { from: 'YYYY-MM-DD', perUSD } ] } }
```

## Data flow

- **Attribution order:** a gateway row takes its key's cost center; otherwise the first folder rule whose glob matches the project; otherwise `Unassigned`.
- **Incremental updates:** each collector keeps a read cursor in `cursors.json`. After every index refresh (about 60 s) only new events are read. Local events are deduplicated with the same key the Overview uses, so resumed and forked sessions count once.
- **Closing days:** today's rows are rewritten as events arrive. A past day is never re-priced by a price change.
- **Late events** (a log indexed after its day ended) are added to their own day with **that day's price version**, so cost stays frozen even when data arrives late.
- **First run (backfill):** the ledger is filled from existing history with **today's** prices, because past prices were never kept. Those rows carry `backfilled: true`, and the UI says so.
- **Restate:** `POST /api/cost/restate { from, to, reason, confirm: true }` re-prices the range with the **current** effective pricing and re-attributes it with the **current** cost-center rules and billing modes — its purpose is to correct a wrong past price or attribution. It appends one correction with the before and after of every changed row; the original rows stay.
- **Currency:** converted at read time with the latest rate whose `from` is on or before the row's day. The ledger itself is USD.

## HTTP API

All routes need the dashboard session (never a gateway API key, MCP or A2A). State changes need JSON (415 otherwise). Responses carry no file path and no transcript text.

| Route | Returns |
|---|---|
| `GET /api/cost/ledger?from&to&groupBy=<dims>&currency=` | Aggregated rows by the requested dimensions, corrections applied, amounts in USD and in the display currency when asked |
| `GET /api/cost/status` | Per collector: last cursor time, rows read, last error (path-free); current price version; unpriced count; backfill state |
| `GET /api/cost/settings` · `POST /api/cost/settings` | The `cost` settings; POST validates every field (400 on a bad glob, unknown center, bad rate) |
| `GET /api/cost/prices/versions` | Price versions with their dates and which keys changed |
| `POST /api/cost/restate` | Re-prices a range after `{ confirm: true }`; returns the correction |

**Demo mode:** a synthetic ledger (three cost centers, one source on a plan, an IDR rate), no real files, no network.

## Error handling

- Writes are atomic (unique temp file, mode 0600, rename) in a folder of mode 0700, using the hardened writer from #49.
- A corrupt ledger line is moved to `ledger-YYYY-MM.jsonl.bad`; the month still loads.
- A failing collector does not stop the others; its error shows in `/api/cost/status`.
- A missing or corrupt ledger can be rebuilt from the sources; rebuilt rows are marked `backfilled`. Source data is never deleted.
- An invalid `cost` section is refused with 400 on save. If `config.json` already holds an invalid one, the pass waits, as it does for a `config.json` that does not parse: it writes no row, no billing entry and no re-attribution, a restate is refused (409), and the status reports it. Applying the defaults instead would move today's rows to `unassigned`, and a day that closed meanwhile would keep them. The first pass after the fix reads the logs with the fixed rules.

## Privacy

- The ledger holds numbers and dimension names only, never prompt or response text.
- Project folders are shown with the home folder as `~`.
- No new outbound connection: rates are entered by the owner.

## Testing

- **Collectors:** each source yields the right events; a resumed or forked session counts once.
- **Freezing:** change a price, and yesterday's rows keep the old price while today's use the new one.
- **Late events:** land on their own day with that day's price version.
- **Plans:** the fee is spread per day correctly; `listUSD` and `billedUSD` are right; nothing is counted twice.
- **Attribution:** key, then folder rule (order matters), then `Unassigned`.
- **Restate:** produces a correction; the original rows stay.
- **Currency:** the latest rate on or before the day is used.
- **Gateway formula:** gateway cost through the shared pricer equals the local cost for the same tokens (cache writes, tiers, web search, geo).
- **Storage and API:** files at 0600, folder 0700; a corrupt line goes to `.bad`; an invalid `cost` section is refused; responses carry no path or text; no route answers a gateway key.
- Tests never call a real provider or network.

## Out of scope for this sub-project

Budgets, alerts and enforcement (2); the Cost Control menu and its charts (3); forecasting, anomalies and recommendations (4); reports, export and MCP tools (5); OmniRoute in the ledger; live exchange rates; per-user or per-team identity.
