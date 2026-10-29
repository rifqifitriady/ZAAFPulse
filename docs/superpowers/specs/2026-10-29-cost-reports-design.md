# Cost Control, sub-project 5: reports, export and MCP tools

Date: 2026-10-29 · Status: decided by the controller's recommendations (the owner asked to follow them) · Builds on: the ledger (#53), budgets (#54), the Cost Control menu (#55), Settings (#56), forecast and anomalies (#57) and recommendations (#58).

This is the last Cost Control sub-project. It gets the cost data **out** of the dashboard in three ways:
- exports and a monthly showback report per cost center, which the owner can hand to a client;
- an opt-in weekly digest;
- two read-only MCP tools, so the owner's own agents can ask about spend and budgets.

## Decisions

| Topic | Decision |
|---|---|
| Export | `GET /api/cost/export` returns the ledger grouping as **CSV or JSON**: the same rows as `GET /api/cost/ledger`, the same range and `groupBy` rules, and the same currency. There is an "Export" button on the Breakdown table and on the Reports page. Dashboard session only. |
| Showback | A new sub-page, **Reports** (`#cost/reports`), shows one cost center's month: totals in both measures, by source, by model and by key, plus its budgets. It prints cleanly (print CSS) and exports to CSV. The owner chooses the month and the center, and can also choose All centers or Unassigned. |
| Digest | A **weekly digest**, off by default. It is turned on in Settings → Cost (a new "Weekly digest" panel). Every Monday it covers the week before (Monday to Sunday). It goes to the desktop notification as one short line, and to the Monitors webhook (when one is set) as a JSON body of numbers and owner-defined names only. |
| MCP | Two read-only tools, **`acc_cost`** (spend over a range, grouped) and **`acc_budgets`** (budgets with state, forecast and runs-out date). They are on the owner's **stdio MCP** (`mcp.js`) only. They are **not** on the gateway `/mcp` endpoint, which answers clients' API keys: one client must never see another's spend. |
| Privacy | Exports and reports are for the signed-in owner. The digest and the MCP tools carry numbers, center names, model names and key names. No project folders go into the digest, because they are local paths; the MCP tools do return `~` project folders, since they serve the owner's own agents. No prompt or transcript text appears anywhere. |
| Architecture | `lib/cost/report.js` (pure: showback and digest figures), `lib/cost/export.js` (pure: CSV encoding), routes in `lib/cost/api.js`, a digest scheduler in `lib/cost/digest.js`, a read-only cost reader for `mcp.js`, tools in `lib/connectors/acc.js` behind a flag only `mcp.js` sets, and a Reports page in a new `public/costreports.js`. |

## Section 1: Export

`GET /api/cost/export?format=csv|json&from&to&groupBy&currency&measure`
- **Rules.** Range, `groupBy` and currency follow `/api/cost/ledger`; `measure` follows `/api/cost/view`. Errors are the same 400s.
- **Columns.** The `groupBy` dimensions, then `requests`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `listUSD` and `billedUSD`. When a currency is chosen, it adds `list<CODE>` and `billed<CODE>`.
- **CSV:**
  - RFC 4180: comma separated, CRLF line ends, fields quoted when they contain a comma, quote, CR or LF, with quotes doubled.
  - A header row comes first.
  - A cell that starts with `=`, `+`, `-`, `@`, a tab or a CR gets a leading `'`, so a spreadsheet does not run it as a formula (CSV injection).
  - Numbers are plain: dot decimal, no thousands separator, amounts to 8 decimals.
- **JSON:** `{ from, to, groupBy, currency, measure, rows, totals, unread }`.
- **Download headers.** `Content-Disposition: attachment; filename="zaafpulse-cost-<from>-<to>.<ext>"` and `Cache-Control: no-store`.
- **Unread months.** When a month did not read, the CSV gets a final `# unread: 2026-09` comment line, and the JSON answer has the `unread` field.
- **Size.** At most 400 days, like the ledger, and at most 100,000 rows. Beyond that the answer is 413 with "too many rows; narrow the range or group by fewer dimensions".
- **Buttons.** "Export CSV" on the Breakdown table (its current range, grouping, currency and measure) and on the Reports page.

## Section 2: Reports (`#cost/reports`)

**Controls**
- A **month** picker: this month back to the ledger's first month. Default: last month, or this month in the first days of the ledger.
- A **center** select: the cost centers, plus "All centers" and "Unassigned".
- The display currency switch, as on the other pages.

**The report**
- **Header:** "Cost report · Client: Acme · October 2026". It also states the period and when the report was generated.
- **Totals:** usage value and paid, with requests and tokens.
- **Tables:** spend by source, by model, by key (key names) and by project (`~` folders). Each table holds up to 20 rows, then "Other".
- **Daily spend:** a small bar chart of the month.
- **Budgets:** those whose scope is this center, or every budget for All centers. Each shows its state and percentage, as on the Budgets page, for this month only when the month is the current one.
- **Notes:** months that did not read, and days whose billing was assumed. Corrections (restates) in the period are listed with their reason.

**Actions**
- **Print**, which calls `window.print()`. The print CSS hides the sidebar and controls and fits A4 and Letter.
- **Export CSV**, which downloads the report's tables as one CSV in sections, each table with its header row.

**Server**
- `GET /api/cost/report?month=YYYY-MM&center=<id|__all|unassigned>&currency=`
- It returns `report.js`'s showback.
- 400 for a bad month or an unknown center; 503 with a code when the ledger cannot be read.

## Section 3: Weekly digest

**Setting.** `config.json` `cost.digest`: `{ enabled: false }` by default. It is edited in a new Settings panel, "Weekly digest", saved like the other panels and validated in `lib/cost/rules.js`. Its only field is `enabled`, a boolean.

**When it runs**
- `lib/cost/digest.js` checks on each ledger pass whether the digest for last week was sent. It uses a marker file, `.data/cost/digest.json`, holding `{ lastWeek: 'YYYY-MM-DD' }` (the week's Monday).
- It sends when all of these hold:
  - the digest is enabled;
  - today is Monday or later in the week after;
  - last week's Monday is newer than the marker.
- A restart never sends twice, and a missed Monday still sends once during that week.

**The figures** (`report.js`): last week's usage value and paid, the change against the week before (amount and %), and these lists:
- the top 3 centers;
- the top 3 models;
- the budgets exceeded or projected now;
- anomalies of last week (days the `cost_anomaly` rule's check finds anomalous with its saved parameters);
- the top recommendation, if any.

**Where it goes**
- **Desktop:** one line, through the Monitors channels. For example: "ZAAFPulse weekly cost: $412.30 (+12 %), 1 budget at risk, 2 anomalies".
- **Webhook,** when the Monitors webhook is set: `{ type: 'cost_digest', week, totals, change, centers, models, budgets, anomalies, recommendation }`. It carries numbers, center names, model names, key names and budget names, and never project folders or text.
  - This is the one new webhook body. The Monitors docs list it beside the seven-field alert body.
  - It goes through the existing channel bounds: queue, retries and timeouts.

**Demo.** The digest never sends; channels are off in demo mode, as today.

## Section 4: MCP tools (stdio only)

**`acc_cost`**
- Description: "Spend from the cost ledger over a range, grouped by up to 2 dimensions (source, provider, model, project, center, keyId), in USD: usage value and paid, requests and tokens. Read-only."
- **Input:**
  - `range`: `'7' | '30' | '90' | 'month' | 'lastmonth'`, default `'30'`;
  - `groupBy`: up to 2 of the dimensions, default `['model']`.
- **Output:** `{ from, to, groupBy, rows (top 50 by usage value, then 'Other'), totals, unread }`.

**`acc_budgets`**
- Description: "Cost budgets with state, percent used, forecast at period end and the day they run out. Read-only."
- **Input:** none.
- **Output:** the budget views. `enforce` and the guard internals are left out.

**Where they appear**
- They come from a cost reader that `mcp.js` builds read-only over the same data folder: no ledger pass and no writes. It reads the ledger months, the billing history and the budgets list as the server last saved them.
- **Gateway.** The server's integrations registry (which also answers gateway `/mcp`) does not get these tools.
  - `createLocal` gains a `cost` provider. `mcp.js` passes it; `server.js` does not.
  - `lib/connectors/acc.js` lists the two tools only when `local.cost` exists.
- **Failures.** A ledger that cannot be read is a tool error with the server's path-free wording.

## Error handling

- Every new route sits behind the dashboard session, as the other `/api/cost` routes do, with path-free errors.
- A digest that fails to send is logged once, and the marker is not advanced, so it tries again on the next pass that week.
- A broken `config.json` keeps the last digest setting that validated, as budgets do.

## Testing

- **`export.js`:**
  - CSV quoting, CRLF and formula-injection prefixes;
  - the currency columns and the unread comment;
  - JSON shape;
  - the 413 cap.
- **API export:** headers, both formats, 400s, session only, path-free errors.
- **`report.js`:**
  - showback per center, all and unassigned;
  - the Other rows;
  - budgets in scope;
  - notes for unread months, assumed billing and corrections;
  - digest figures: change, top lists, anomalies with saved parameters, recommendation.
- **API report:** shapes, 400s, 503.
- **`digest.js`:**
  - sends once per week, including across a restart and a missed Monday;
  - nothing while disabled;
  - a failed send does not advance the marker;
  - the webhook body has no project folders or text;
  - no send in demo mode.
- **Settings:** the digest panel body and the rules validation.
- **MCP:**
  - both tools on the stdio registry;
  - absent from the server registry and from gateway `/mcp` (tools/list over HTTP with a gateway key);
  - outputs shaped and capped;
  - the reader writes nothing (cost folder byte for byte).
- **UI helpers:**
  - the Reports controls, tables, print classes and CSV;
  - the Breakdown export link;
  - every string through `esc()`.
- Tests never call a real network and never signal a real process. Spawned servers use ports 9800–9999.

## Out of scope

- Scheduled report emails, since there is no mail sending.
- PDF generation: the browser's print does it.
- MCP write tools.
- Cost tools on gateway `/mcp` for a key's own spend: a possible later, per-key scoped variant.
- Monthly digests.
- Invoices with tax.
