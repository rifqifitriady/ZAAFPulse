# Cost Control, sub-project 3a: the Cost Control menu (Overview, Breakdown, Value, Budgets)

Date: 2026-10-27 · Status: approved in brainstorming · Builds on: the cost ledger (sub-project 1, PR #53) and budgets (sub-project 2, PR #54).

Cost Control is built in five sub-projects (docs/superpowers/specs/2026-10-23-cost-ledger-design.md). Sub-project 3 was split in two. **3a** (this spec) adds the Cost Control menu: animated holo charts on three read-only pages and a Budgets page with the add/edit form deferred from sub-project 2. **3b** (later, after 3a is merged) adds the cost Settings page: cost centers and folder rules, billing per source, display-currency rates, restate. Until 3b, those settings stay in `config.json` and `/api/cost/settings`.

## Decisions taken in brainstorming

| Topic | Decision |
|---|---|
| Pages | Four sub-pages, each answering one question: **Overview** ("how much, and is it safe?"), **Breakdown** ("where does the money go?"), **Value** ("is it worth it?"), **Budgets** ("set the limits"). |
| Savings | The waterfall counts **cache** and **plan** savings in money. Local models (free rows) show tokens and requests only, no money: pricing them against a reference cloud model belongs to sub-project 4. |
| Controls | One shared control bar: range (Overview is always the current month), currency USD / display currency, measure "Usage value" / "Paid". Kept in the URL and remembered in `localStorage`. |
| Cost vs quality | Tool-call **accuracy per model** from the Claude Code and Codex logs is the quality axis. Datasets experiment pass rates show in the tooltip when an experiment ran that model. |
| Heatmap | A **calendar heatmap (week × weekday)** from the ledger, which is daily. An hour-of-day view is not built: the ledger has no hours. |
| Architecture | A pure server module `lib/cost/views.js` computes ready-to-draw data per page, served by `GET /api/cost/view`. The browser only draws. |

## Section 1: Navigation, routes and the shared controls

**Sidebar.** In the AI OBSERVABILITY group, right after "Quality & safety", with the existing `dollar` icon:

```
Cost Control        #cost            (Overview)
  Breakdown         #cost/breakdown
  Value             #cost/value
  Budgets           #cost/budgets
```

A badge on the menu (`#b-cost`) counts the budgets that are `exceeded` or `projected`; it is empty when none are. It is refreshed with the dashboard's refresh cycle from `GET /api/cost/budgets`.

**Routes.** `#cost/<sub>?range=30d&from=…&to=…&cur=IDR&measure=billed`.
- `range`: `7d`, `30d`, `month`, `lastmonth` or `custom` (then `from` and `to`, at most 400 days, the API's limit). The days end today, in local time.
- Overview ignores `range` and always shows the current month. Its control bar hides the range buttons and shows "This month · day 27 of 31" instead.
- An invalid value (a broken date, `cur` without rates, an unknown `measure`) falls back to the default silently: `30d`, USD, `list`. No error page. Breakdown and Value default to the last 30 days, in the page and in the API.
- Budgets has no range or measure control; its currency switch is not shown either (each budget has its own currency).

**Control bar** at the top of each sub-page, in the `subHero` pattern of `public/iso.js`:
- **Range:** quick buttons plus two date inputs for `custom`.
- **Currency:** a USD / `<code>` switch, shown only when `/api/cost/settings` has a display currency with at least one rate.
- **Measure:** "Usage value" (`list`, the default, as for budgets) / "Paid" (`billed`).
- The last choice is stored in `localStorage` (`zp.cost.controls`) and used when the URL names nothing. Every access is wrapped in try/catch; the page works without storage.

**Refresh.** Data reloads on a route or control change (with the entrance animation). The cost pages also refresh themselves every 60 s, quietly (no motion, no skeleton), and `app.js` leaves them out of its 60-second `render(false)`: a render would rebuild the page and close an open budget form. A quiet refresh is skipped while the form or a delete confirmation is open, a field of the page has focus, or the tab is hidden. Animation runs only on the open sub-page; canvases are released through `onUnmount`. With `prefers-reduced-motion`, numbers and charts appear at their final state.

**Ledger status ribbon.** A thin ribbon above the content when `/api/cost/status` reports a problem: the ledger waiting on a broken config, months that did not read, the billing history lost, prices with problems. It uses the server's path-free wording. Charts still show what was read, and the view answer's `unread` marks what is missing.

## Section 2: Overview (`#cost`)

The current month, day 1 to today.

**KPI tiles** (`metricTile`, with count-up):
1. **This month**: spend in the chosen measure, with the other measure underneath ("Paid $212 · usage value $486"), and a sparkline of the daily spend.
2. **Forecast**: the projected month-end spend (below), with the band ("$560 – $640").
3. **Budgets at risk**: the number of budgets `exceeded`, `projected` or at a warning level, of all budgets; a click goes to `#cost/budgets`.
4. **Top cost center**: the center with the highest spend this month and its share.

**Burn-down with a projection band.** Cumulative spend per day of the month as a line, then from today to the month's end:
- a **forecast** line at the mean daily spend of the elapsed days (today included, as a whole day);
- a **band** between the 25th and 75th percentile of the daily spends of the elapsed days, each multiplied by the remaining days and added to today's cumulative spend;
- the **budget line**: the global monthly budgets (scope `global`, period `month`), each a horizontal line at its amount in the chosen currency; a budget whose currency differs from the chosen one is converted with the latest rate, and skipped when there is none. With no such budget, no line and a link "Add a monthly budget".
- Fewer than 3 elapsed days: no band, only the forecast line, marked "early in the month".
- **Scale.** The y-axis top is the larger of the cumulative spend and the reach (the larger of the forecast's end and the band's top), × 1.1, rounded up to a nice value. A budget line is part of the scale only when its amount is at most twice the reach; a larger budget is pinned at the top edge as a dashed marker labeled "↑ Budget <amount>", so the curve stays readable.

**Spike line.** Daily spend for the month, each day compared with its **baseline**: the mean of the **known** days among the 7 before it (the days before the 1st are read too). A day before the ledger's first row (the earliest day with any row read for the month and the 7 days before it) is unknown, not zero. With fewer than 3 known days the day has no baseline (no dashed segment there) and is never a spike, so a ledger that starts mid-month does not mark its first days. A day is a **spike** when it is more than twice its baseline and at least $1 more than it (in USD, before conversion), so a quiet week does not make every small day a spike. A spike is a marker with a tooltip: the day, the spend, the baseline, and the top model of that day.

**Budget rings (compact).** One small ring per budget, at most 8, the riskiest first (`exceeded`, then `projected`, then the highest percent); a "+ N more" link goes to Budgets. Ring colors by state: `ok` cyan, warning levels orange, `exceeded` pink, `no_data` muted with a dashed ring.

## Section 3: Breakdown (`#cost/breakdown`)

The chosen range, currency and measure.

**Cost flow.** A four-column flow (Sankey style): source → provider → model → cost center.
- Each column keeps its top 6 by spend and joins the rest into "Other".
- Link width is the spend. Hover shows the amount and share; a click on a node filters the table below to it.
- Plan rows (measure "Paid") have no provider, model or center: they flow from their source into a node "Plan fee".

**Isometric treemap.** One block per project, grouped by cost center, on the `isoStage` engine. A block's footprint is the share of spend; its height is the spend per request, so an expensive project stands out. Projects are shown as the ledger names them (`~/…`). At most 40 blocks; the rest join one block per center named "Other".

**Calendar heatmap.** Weeks as columns, Monday to Sunday as rows, one cell per day of the range. The color steps are quantiles of the range's non-zero days (5 steps), in the cyan ramp; a zero day is empty. The tooltip shows the day, the spend and its top model.

**Table.** Grouped by up to 4 dimensions the user picks (default: model), sortable, with spend, share, requests, tokens and spend per request. Read from the existing `/api/cost/ledger` (its `groupBy`), so the table can be regrouped without a new view request. A click on a flow node sets the table's filter; a chip shows it with a clear button.

## Section 4: Value (`#cost/value`)

The chosen range and currency. The measure switch is hidden: this page compares both measures by nature.

**Plan value vs plan fee.** One bar pair per source on a plan in the range: the usage value of that source on its plan days (`listUSD`) against what the plan cost (the plan rows' `billedUSD`). A **multiplier** label: "4.1× the fee". Below 1×, the bar is orange and the label says "the plan cost more than metered use would have".

**Savings waterfall.** Four steps from left to right:
1. **Without cache**: usage value plus the cache savings.
2. **Cache savings** (down): per row, `cacheRead tokens × (input price − cache read price)` at the base rates of the row's price version (the version of its day). Prompt-length tiers and US-only pricing are not applied, so it is labeled as an estimate. Rows without a price version, unpriced rows and free rows add nothing.
3. **Plan savings** (down, or up when a plan cost more): usage value minus what was paid.
4. **Paid**: what was paid.

Under the waterfall, **local models**: requests and tokens of free rows (Ollama, LM Studio, other local judges) in the range, with the note "Not priced: these run on your own machine. A later version compares them with a cloud model."

**Cost vs quality.** A scatter, one dot per model with at least one request in the range:
- x: spend per request (ledger, chosen currency, on the **usage value**: on a plan every usage row is billed 0, so "Paid" would put each plan model at zero);
- y: tool-call accuracy (below);
- dot size: requests;
- a model with fewer than 50 tool results in the range is drawn hollow and labeled "little data";
- a model without tool results (a gateway-only model) is listed under the chart as "no tool calls to measure", not drawn;
- the tooltip adds the Datasets pass rate when an experiment that ended in the range ran that model.

**Unit cost trends.** Three daily lines over the range, each with its own scale, on the usage value:
- spend per request;
- spend per million tokens (all token kinds);
- spend per 1,000 successful tool calls (tool results that were not a model-caused failure), for Claude Code and Codex spend only, since only their tool calls are counted.

A day without the denominator has no point (a gap, not zero).

### Accuracy per model (new, in the quality signals)

Accuracy follows the existing definition on the Quality page: `1 − model-caused failures ÷ tool results`, with the categories of `MODEL_FAULT` in `lib/quality.js`.
- The parsers attribute each tool result to the model that made the call: in Claude Code logs, the `model` of the assistant message holding the `tool_use` (looked up by `tool_use_id`); in Codex logs, the model in force for the turn.
- `SignalSink` counts per day and model: `days[day].models[model] = { results, cats }`. Model names are stored as the log names them and normalized (`normalizeModel`) when summed, so they match the ledger's model names.
- `lib/indexer.js` `CACHE_VERSION` goes up by one, so the index is rebuilt once with the new counts. The first start after the update reindexes the logs.
- `lib/quality.js` gains `accuracyByModel(results, { from, to })` returning `{ [model]: { results, modelFailures, accuracy, daily: { [day]: { results, ok } } } }`.
- Datasets pass rate for a model: over the experiments that ended in the range and ran it, the sum of passes over the sum of totals across their evaluators. Model names are normalized the same way.

## Section 5: Budgets (`#cost/budgets`)

**Status line.** At the top, when `/api/cost/budgets` reports it:
- `error` (the saved list does not validate; the last valid list is in force): an orange banner with the `reasons`, and the form is disabled with "Fix config.json first", as the API refuses changes then (409);
- `kept.error`: a muted note;
- `guard.error` and `guard.problems`: a banner "The gateway is letting requests through for these budgets", one line per problem with the budget name, the reason and since when.

**Cards.** One card per budget, the riskiest first:
- a holo ring (the percent, capped visually at 100 % with an overflow arc in pink), the state color as in Overview;
- name; scope ("Global", "Center · Platform", "Key · ci-bot", …); period with its dates ("Month · 1–31 Oct");
- spent of amount in the budget's currency; "projected" chip; enforce chip ("Blocks gateway", "Pauses agent"); "from old settings" chip for `legacy`;
- `no_data`: the reason instead of the figures;
- **Edit** and **Delete** buttons.

**Form** (a drawer, as other edit forms open). Fields:
- **Name** (1–60 characters). For a new budget, the id is made from the name (lowercase, `a-z0-9-`, a numeric suffix when taken) and shown read-only; an existing budget keeps its id.
- **Scope**: Global, or a dimension plus a value. The value is a select of known values with free entry allowed: centers from `/api/cost/settings`, keys from its `keys`, and the projects, models and providers that have spend in the last 90 days (from `/api/cost/ledger`); sources are the fixed list.
- **Period** (day, week, month), **Amount** (> 0), **Currency** (USD, or the display currency when set).
- **Measure** (usage value, paid).
- **Warning levels**: up to two integers, 1–99, ascending; default 50 and 80.
- **Projection alert** (on by default).
- **Enforcement**: none, block, pause. Options the scope does not allow are disabled with the reason, mirroring the server's `mayBlock` and `mayPause` (`lib/cost/budgets.js`) exactly: block on global, `key`, `center`, `model`, `provider` or `source` `gateway` (not `project`, not another source); pause on global, `project`, `center`, `model` or `source` `claude`/`codex` (not `key`, not `provider`, not another source). The choices are redrawn when the scope changes.
- Save posts to `POST /api/cost/budgets`. A 400 shows its `reasons` beside the form; a 409 shows its message. On success, the drawer closes and the list reloads.
- A legacy budget's form says "Saving moves this budget out of the old setting (monthly budget / key budget), which is cleared."

**Delete** asks for confirmation in place ("Delete budget "<name>"? A budget from old settings also clears that setting.") and posts `POST /api/cost/budgets/<id>/delete`.

**From the bell.** A budget alert in the alerts drawer gains a link "Open in Budgets" to `#cost/budgets?focus=<id>`, which scrolls to the card and highlights it for a moment. `/api/alerts` keeps `instance` opaque (an HMAC), so a budget alert row gains a `budget` field with the budget's id (validated as a budget id; the owner's own id, shown to the owner only), and the link is built from it.

## Section 6: Server, API and data flow

**`lib/cost/views.js`** (new, pure: no I/O, no clock). One function per page, each taking plain inputs:

```
overview({ rows, before, today, budgets, rateOf, measure, currency, display })
breakdown({ rows, from, to, rateOf, measure })
value({ rows, from, to, rateOf, cacheSaved, accuracy, passRates })
```

- `rows`: ledger rows as billed (`cost.budgetRows`), corrections applied, plan rows included; `before`: the 7 days before the month for the spike baseline.
- `rateOf(day)`: the display-currency rate, or null for USD. A day with no rate is counted in USD and listed in `missingRate`, an array of those days (the ledger answer gives a count; the view answers name the days).
- `currency` (Overview): the chosen code; `display` (Overview): `{ code, rate }`, the display currency and its latest rate on or before today, or null. With `rateOf` null for USD, the budget lines need it to convert a budget in the display currency to USD and back.
- `cacheSaved(row)`: the USD cache savings of a row (from `cost`, which holds the price versions).
- `accuracy`: `accuracyByModel(...)`; `passRates`: `{ [model]: { pass, total } }`.
- Amounts are summed in USD and converted per day, then rounded once for display (to the cent, or the whole unit for IDR).

**`lib/cost/index.js`** gains `cacheSaved(row)`: `cacheRead × (entry.input − entry.cacheRead) / 1e6` at the base entry of the row's model in the row's price version; 0 for a row without a version, an unpriced, free or plan row, or a negative difference.

**Route.** `GET /api/cost/view?page=overview|breakdown|value&from&to&currency&measure`, in `lib/cost/api.js`.
- Same rules as the other cost routes: dashboard session only (never a gateway key, MCP or A2A), path-free errors.
- Range rules as `/api/cost/ledger` (400 for a bad date or more than 400 days). Overview ignores `from` and `to`; Breakdown and Value without dates are the last 30 days.
- 400 for an unknown page or measure, or a currency without rates; 503 with the code when the ledger is unavailable (as `/api/cost/ledger`).
- The answer always carries `from`, `to`, `currency`, `measure`, `unread`, `missingRate` and `billing` (error, historyLost), beside the page's data.
- Quality inputs come from the server's index (memoized on the indexer's version and the range), and pass rates from the experiment store. In demo mode, from the demo data, with no files and no network.

**Demo.** The demo ledger and budgets already exist. The demo quality signals gain per-model counts, so Value shows a scatter in demo mode.

**Front end.** `public/costview.js` (routing, control bar, page shells, Budgets page and form, pure helpers exported for tests) and `public/costcharts.js` (burn-down, spike line, rings, flow, iso treemap, calendar, plan bars, waterfall, scatter, unit lines), loaded before `app.js`. Styles go in `public/styles.css` under a `.cost-` prefix, reusing the holo deck tokens.

**Error handling.**
- A failed view request shows the error in the page body with a retry button; the control bar stays.
- Unread months are shown as a note ("October could not be read: figures leave it out").
- A chart with no data shows its empty state, never a broken axis.

**Privacy.** Answers hold numbers, dimension names, `~` folders and model names only. No prompt, response or tool text. Budget names are the owner's and shown to the owner only.

**Performance.** One request per page view. A view over 400 days reads the same rows as the ledger route. `accuracyByModel` is memoized per indexer version and range, so a refresh does not rescan the signals.

## Testing

- `views.js`: forecast and band (including fewer than 3 days), budget lines with conversion and a skipped currency, spike rule (twice and at least $1; known days only, no baseline under 3, a ledger that starts mid-month), riskiest-first rings, top-6 plus Other in the flow, plan rows into "Plan fee", treemap capping, calendar quantiles and empty days, plan multiplier, waterfall steps adding up to what was paid, local rows kept out of money, scatter little-data marking, unit-cost gaps, currency per day with `missingRate`.
- `cacheSaved`: base rates of the row's version, zero cases.
- Signals: Claude Code and Codex parsers attribute tool results and model-caused failures per model; `accuracyByModel` over a range; normalized names.
- API: 401 without a session, a gateway key refused, 400 cases, 503 when the ledger is unavailable, no paths in errors, demo answers for each page.
- Charts (in Node): the burn-down's scale with a budget inside and one pinned at the top edge, the spike line's gap where there is no baseline.
- UI helpers (in Node, without a browser, as `test/monitors-ui.test.js` does): parsing and defaults of the controls from the hash and storage, the budget form to request body, the id from a name with suffixes, enforce options per scope (equal to `mayBlock`/`mayPause` for every dimension), the bell's link from the alert's `budget` field, ring state colors and ordering, and an audit that every owner-written or server string goes through `esc()`.
- Tests never call a real provider or network, and never signal a real process.

## Out of scope

The cost Settings page (3b); forecasts beyond the linear projection, anomalies and model recommendations (sub-project 4); reports, export and MCP tools (sub-project 5); an hour-of-day heatmap; pricing local models; per-session cost (the ledger holds no sessions).
