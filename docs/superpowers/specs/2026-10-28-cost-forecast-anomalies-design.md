# Cost Control, sub-project 4a: forecast and anomalies

Date: 2026-10-28 · Status: approved in brainstorming · Builds on: the cost ledger (#53), budgets (#54), the Cost Control menu (#55) and the Settings page (#56).

Sub-project 4 was split in two. **4a** (this spec) covers two things:
- a weekday-aware forecast used everywhere, with the date each budget runs out;
- cost anomalies, raised through the Monitors engine with the reason for the rise.

**4b** (later) recommends cheaper models from Datasets experiments.

## Decisions taken in brainstorming

| Topic | Decision |
|---|---|
| Split | 4a = forecast + anomalies (ledger data only); 4b = cheaper-model recommendations (Datasets + ledger). |
| Forecast reach | **One forecast engine everywhere.** It draws the Overview burn-down and decides a budget's `projected` state. It also gives every budget a "runs out on" date. The Overview and budget figures can no longer disagree. |
| Forecast model | A mean per weekday over the last 4 weeks of finished days. With less history it falls back to a plain daily mean, and with too little it gives no forecast. No trend or seasonal model (Holt-Winters, EWMA): they are hard to explain and too much for a ledger a few weeks old. |
| Anomalies | **A new Monitors rule, "Cost anomaly",** checked after each ledger pass. It checks today so far and the whole of yesterday, with one instance per day. Notifications go through the existing desktop and webhook channels, with snooze. The rule names the top contributors to the rise: model, project, cost center and key. One rule on the total, not one per dimension, so the noise stays low. |
| Architecture | Two new pure modules, `lib/cost/forecast.js` and `lib/cost/anomaly.js`, wired into `views.js`, `budgets.js`, `budget-service.js`, the Monitors rules and the pages. |

**Defaults** (taken from the recommendations):
- Anomalies use the usage value (list), with plan fees left out: a plan fee is not usage.
- A plan fee enters a forecast as an exact amount per day, for the Paid measure only.
- Fewer than 7 known days gives the plain mean. Fewer than 3 gives no forecast and no anomaly, as with the spike rule today.
- `projected` still starts at 25 % of a period.
- A runs-out date is shown only inside the budget's period.
- An anomaly alerts at most once per day of spend. The instance is the day itself.

## Section 1: The forecast (`lib/cost/forecast.js`)

Pure: no I/O, no clock. Days are local `YYYY-MM-DD`, as in the ledger.

```
dailyModel(rows, { today, weeks = 4 })
  -> null | { method: 'weekday' | 'mean', known, byWeekday: [7 numbers, Mon..Sun], mean, low, high }
project(model, { today, spentSoFar, todaySoFar, to, planPerDay = () => 0 })
  -> [{ day, cum, low, high }]  // from today to `to`, inclusive
runsOut(line, amount) -> 'YYYY-MM-DD' | null
```

**`dailyModel`**
- **Input.** `rows` are ledger rows already reduced to one measure: `{ day, usd }`, one per row or per day. Plan rows (`kind: 'plan'`) are left out by the caller.
- **Window.** The finished days in `[today − 7·weeks, today − 1]`.
- **Known days.** A day counts only on or after the first day that has a row: before the ledger began is unknown, not zero. A day inside the known span with no row is a real zero.
- **Method.**
  - With 7 or more known days: `method: 'weekday'`. `byWeekday[w]` is the mean of the known days of weekday `w`. A weekday with no known day takes `mean`.
  - With 3 to 6 known days: `method: 'mean'`, and every `byWeekday[w]` is `mean`.
  - With fewer than 3 known days: `null`.
- **Band.** For each known day the ratio `actual / expected` is taken, where expected is that weekday's value from the same model. Days whose expected value is 0 are skipped. `low` and `high` are the 25th and 75th percentiles of those ratios, clamped to `[0, 10]`. With fewer than 3 ratios, both are 1.

**`project`**
- **Today.** Today's value is `max(todaySoFar, expected(today))`, so the line never forecasts less than what is already spent.
- **Each later day** adds `expected(day)`.
- **Plan fees.** Each day also adds `planPerDay(day)`: the exact fee of a plan for that day, used by the Paid measure only. It adds the same amount to `cum`, `low` and `high`.
- **Band.** `low` and `high` scale the usage part only, with the model's `low` and `high`.
- **Rounding.** `cum` starts at `spentSoFar`, the period's spend up to yesterday plus today so far. It is rounded to 8 decimals.
- **No model.** `project(null, …)` returns `[]`.

**`runsOut`**
- Returns the first `day` of `line` whose `cum > amount`.
- Returns `null` if no day passes the amount, if `line` is empty, or if the amount is not a positive number.

## Section 2: Where the forecast is used

**Overview (`lib/cost/views.js` `overview`)**
- The burn-down's forecast line and band come from `forecast.project` over the rest of the month.
  - The model is built from `history`: the measure's usage rows of `[today − 28, today − 1]`.
  - `planPerDay` takes the current plan fees when the measure is `billed`.
- The answer gains `forecastMethod: 'weekday' | 'mean' | null`.
- **Young ledgers.** With no model the forecast is the flat line it was before ("no forecast yet"), and the band stays off.
- The existing `BAND_MIN_DAYS` rule is replaced by the model's own rule.
- **API.** The view answer keeps its shape. `GET /api/cost/view?page=overview` passes `history` in place of `before`; `before` was only used by the spike baseline, which Section 4 replaces.

**Budgets (`lib/cost/budgets.js` `evaluateBudget`)**
- **New input.** `history`: the budget's measure and scope applied to the rows of the 28 days before today.
- **`projected`.** It is set when the state is not `exceeded`, `p.fraction >= PROJECTION_FROM`, and the forecast at the period's last day is above the amount.
  - Without a model, the old linear rule decides: `spent / fraction > amount`.
- **Day budgets.** A budget whose period is a day forecasts today only.
- **Two new fields** on every view:
  - `forecastUSD`: the forecast at the end of the period, or `null`;
  - `runsOut`: the `runsOut` date, or `null`. It is null when the budget is already exceeded, or when the date would fall after the period.
- `noDataView` gives both new fields as `null`.

**`lib/cost/budget-service.js`**
- Reads one more cached window, `[today − 28, today − 1]`, for the history.
- It is filtered per budget by `inScope`, and its plan rows are dropped.
- The window is cached like the period windows and counts toward `MAX_WINDOWS`.

## Section 3: Anomalies (`lib/cost/anomaly.js`)

Pure.

```
measureDay(rows, { model, day, partial, history }) ->
  { day, partial, spentUSD, expectedUSD, drivers: [{ dim, value, extraUSD, share }] } | null
isAnomaly(m, { ratio = 2, minUSD = 1 }) -> boolean
```

**`measureDay`**
- **Rows.** `rows` are the day's usage rows (list measure, plan rows excluded).
- **Expected.** `expectedUSD` is `model.byWeekday[weekday(day)]`. With `model` null, the result is `null` (no_data).
- **`partial`.** True for today: the spend so far is compared with a whole expected day. A small rise is caught only when the day is checked as yesterday.
- **Drivers.**
  - The dimensions are `model`, `project`, `center` and `keyId`.
  - Every value's spend on `day` is compared with that value's mean on the same weekday, over the same 4 weeks of `history`. That mean is 0 for a value never seen on that weekday.
  - `extraUSD` is `spend − mean`. Only values with `extraUSD > 0` count.
  - Each value's `share` is `extraUSD / (spentUSD − expectedUSD)`, capped at 1.
  - The top 3 across all dimensions by `extraUSD` are kept, ties broken by dimension order and then value.
  - The list is empty when `spentUSD <= expectedUSD`.
  - A `project` value is the `~` folder. A `keyId` value is the id; the page shows the key's name.

**`isAnomaly`**
- Returns `spentUSD > ratio × expectedUSD` and `spentUSD − expectedUSD >= minUSD`.
- An `expectedUSD` of 0 counts as anomalous once `spentUSD >= minUSD`.

**The Monitors rule `cost_anomaly`** (in `lib/monitors/rules.js` `RULES`)

```
{ id: 'cost_anomaly', title: 'Cost anomaly',
  describe: "Today's or yesterday's spend is well above what the same weekday usually costs.",
  kind: 'aggregate', params: { ratio: 2, minUSD: 1 }, defaultOn: () => true, mayAutoPause: false }
```

- **Check.** `CHECKS.cost_anomaly(p, snap)` reads `snap.costAnomaly`, which is `{ today, yesterday }` from `measureDay`. Either may be null.
- **Instances: one per day.** The instance id is the day (`YYYY-MM-DD`). Two days are reported: yesterday, and today.
  - **State:** `triggered` when `isAnomaly(m, p)` holds, else `ok`. A null `m` gives `no_data`.
  - **Value:** `spentUSD`, rounded to the cent.
  - **Threshold:** `ratio × expectedUSD`, rounded to the cent.
  - **Title:** the day, with "so far" for today. For example `Wed 28 Oct (so far)` or `Tue 27 Oct`.
- **One alert per day.** On the 28th, the partial check of the 28th may trigger instance `2026-10-28`. On the 29th, the same day is checked whole, as yesterday, under the same instance. So it stays triggered without a second alert, or it triggers then if the rise only shows on the whole day.
  - A day stops being reported after it was yesterday. The engine drops instances that are no longer reported, the way it drops the instances of sessions that ended.
  - The plan must confirm this in `lib/monitors/state.js`, and add the smallest change needed if the engine keeps them instead.
- **The snapshot.**
  - `snap.costAnomaly` is built in the engine's aggregate snapshot from a new injected provider, `costAnomaly()`. `server.js` passes a function that reads the ledger (the cost object), builds the model, and runs `measureDay` for today and yesterday.
  - Without the cost object (tests, older wiring), the snapshot has no `costAnomaly` and the rule is `no_data`.
  - **Demo.** In demo mode the provider reads the demo ledger, and the engine sends no notifications, as today.
- **Channels.** The desktop notification and the webhook carry what they carry for every rule: the rule title, the state change, value and threshold, and the instance title. Drivers are **not** sent to the desktop or the webhook: they can name projects and keys. They are shown in the dashboard only.
- **Settings.** The rule appears on the Monitors page with its two parameters, like the other aggregate rules, and can be turned off or snoozed there.

## Section 4: Pages

**Overview (`#cost`)**
- **Burn-down.**
  - The forecast line and band come from Section 2.
  - The chart's caption names the method: "Forecast: weekday pattern of the last 4 weeks", "Forecast: daily mean (little history yet)" or "No forecast yet".
- **Spike line.** It now marks a day by `isAnomaly` with the rule's current parameters: the server passes the saved `cost_anomaly` params, or the defaults. The baseline drawn is that day's `expectedUSD`. This replaces the "2× the 7-day mean" rule, so the chart and the notifications agree.
- **Anomalies card** (new), under the spike line, with a row each for today and yesterday:
  - the spend against the usual amount: "$18.40, usually $6.10 (3.0×)";
  - the state: Anomaly, Normal or "Not enough history";
  - up to 3 drivers, for example "claude-opus · +$9.20 (75 %)", "~/Github/acme-web · +$7.00 (57 %)", "Key: Acme client · +$5.10".
  - A row for a day that is not anomalous shows the figures without drivers.
  - The card links to Monitors (`#monitors`) to change the rule's sensitivity.
- **Rings.** Each budget ring's caption gains "runs out ~21 Nov", or nothing when the forecast stays under the amount.

**Budgets (`#cost/budgets`)**
- Each card gains one line:
  - "Runs out ~21 Nov at this pace", when `runsOut` is set;
  - "Stays under the amount this period (forecast $412)", when the forecast is under;
  - nothing when there is no forecast.
- The `projected` badge keeps its look; it now follows the forecast.

**Bell**
- A `cost_anomaly` alert reads "Cost anomaly · Wed 28 Oct (so far): $18.40, usual $6.10" and links to `#cost`.

**Data in the view answers**
- `GET /api/cost/view?page=overview` gains:
  - `forecastMethod`;
  - `anomalies: { today, yesterday }`. Each is the `measureDay` result plus `anomaly: boolean`, or `null`. Each driver gains `label`, with the key's name for a `keyId`.
  - `anomalyParams: { ratio, minUSD }`.
- `GET /api/cost/budgets` views gain `forecastUSD` and `runsOut`.

## Error handling

- A ledger read that fails leaves the forecast and the anomalies out:
  - the view answer gives `forecastMethod: null` and `anomalies: null` with its usual `unread`;
  - the rule gives `no_data`.
  - Neither breaks the page or the pass.
- A month that did not read is not taken as zero spend. The model leaves out the days of months in `unread`, so a gap never lowers the forecast.
- Rule params that are not positive numbers fall back to the defaults (`withDefaults`, as for every rule).

## Testing

- **`forecast.js`:**
  - the weekday means and the fallback to the mean;
  - known-day handling: days before the first row are unknown, and empty days inside the span are zero;
  - percentiles and clamping of the band;
  - `project` with today partly spent, plan fees per day, and an empty model;
  - `runsOut` at the boundaries: exactly equal is not passed, plus amounts that are not positive.
- **`anomaly.js`:**
  - partial and whole days;
  - an expected value of zero;
  - drivers: ranking, share cap, ties, no drivers when the day is not over the expected amount, a key value;
  - `isAnomaly` at both thresholds.
- **`budgets.js`:**
  - `projected` from the forecast;
  - the linear fallback without a model;
  - `runsOut` inside or after the period, and null when exceeded;
  - a day budget;
  - a billed budget with plan days.
- **`views.js`:**
  - the Overview line from the model;
  - `forecastMethod` for each method;
  - spike marks equal to `isAnomaly` with the passed params;
  - `anomalies` with key labels.
- **Monitors:**
  - the rule's states and per-day instances;
  - its titles;
  - no_data without a snapshot;
  - one alert per day across the partial and whole checks;
  - an instance dropped once its day is past yesterday;
  - no drivers in the channel payloads;
  - the rule listed with its params.
- **API:**
  - the new fields;
  - a failed read giving nulls rather than errors;
  - demo answers.
- **UI helpers** (in Node, without a browser):
  - the runs-out and forecast lines;
  - the anomaly card rows;
  - the caption per method;
  - every server or owner string through `esc()`.
- Tests never call a real network and never signal a real process.

## Out of scope

- Cheaper-model recommendations (4b).
- Hour-of-day anomalies: the ledger is daily.
- One anomaly rule per dimension.
- Trend or seasonal models.
- Reports, export and MCP tools (sub-project 5).
- The 3b follow-ups, kept in `~/.zaafpulse-backups/sdd-ledgers/cost-settings-ui-progress.md`.
