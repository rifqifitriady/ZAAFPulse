# Cost Control, sub-project 3b: the cost Settings page

Date: 2026-10-28 · Status: approved in brainstorming · Builds on: the cost ledger (PR #53), budgets (PR #54) and the Cost Control menu (3a, PR #55).

Sub-project 3a added the Cost Control menu (Overview, Breakdown, Value, Budgets). Until now the cost settings could only be edited in `config.json` or through `POST /api/cost/settings`. This spec adds **Settings** (`#cost/settings`), a fifth Cost Control sub-page. It covers cost centers, gateway key and folder-rule attribution, billing per source, the display currency with dated rates, and restate of a past range.

## Decisions taken in brainstorming

| Topic | Decision |
|---|---|
| Layout | One sub-page, `#cost/settings`, with four panels: **Cost centers & rules**, **Billing**, **Display currency**, **Restate**. Each of the first three has its own Save. A Save sends the saved settings with only that panel's fields replaced, so a mistake in one panel never holds back another. Unsaved changes in other panels are neither sent nor lost. |
| Restate | **Preview first**. A preview route computes the restate without writing anything and shows its effect. The restate itself then needs a reason and an explicit confirmation. The panel also lists past restates. |
| Folder rules | **Server preview**. A preview route takes the unsaved draft and answers with the server's own validation and glob matcher. It shows which projects and keys of the last 30 days move to which center, which rules match nothing or are never reached, and which projects are still Unassigned. A "Test a path" field shows where one path goes. |
| Architecture | New browser file `public/costsettings.js`. New pure server module `lib/cost/preview.js`. Three new routes in `lib/cost/api.js`. `costview.js` only gains the menu entry and the mount call. |
| Applies forward | A settings change applies from today. After a Save of the rules or billing panel, the page says so and links to the Restate panel, filled with the first of this month to yesterday. |
| Center ids | A center's id is fixed once saved; its display name can change. |
| Rates | Entered by hand with a start date, as decided for sub-project 1. No rate is fetched from the network. |

## Section 1: Navigation and page frame

**Sidebar.** A fifth entry under Cost Control, after Budgets: `Settings  #cost/settings`. `COST_SUBS` gains `['settings', 'Settings']`.

**Control bar.** The Settings page has no range, currency or measure control. The bar shows only the page title and a ledger status ribbon, the same one as on the other pages.

**Loading.**
- The page loads `GET /api/cost/settings` and `GET /api/cost/budgets`, the latter to show which centers and currency budgets use.
- It draws the four panels. Opening the Restate panel loads `GET /api/cost/restates`.
- The 60-second quiet refresh of the other cost pages is off on this page: it is all forms. Data reloads after each Save, after a restate, and when the page is opened.

**Drafts.**
- Each panel keeps its draft in memory (`COST.settings.drafts[panel]`) for the life of the browser tab.
- Leaving the page and coming back restores the draft. The panel then shows "Unsaved changes" with **Discard**, which returns it to the saved values.
- A `beforeunload` warning is shown while any panel has unsaved changes.

**Settings that do not read.** `GET /api/cost/settings` reports `error` when `config.json` cannot be read or its cost settings do not validate. While that is so:
- the page shows the error and its reasons in a banner;
- every Save and the Restate button are disabled, because the saved values shown are the defaults that stand in for the invalid ones, and a panel Save would overwrite the owner's other sections with them;
- the previews still work on the draft.

The settings answer gains `reasons`: the scrubbed validation reasons, at most 50, or `[]`.

## Section 2: Panel "Cost centers & rules"

The panel saves `centers`, `keyCenters` and `folderRules` together, because they reference each other. It has three blocks and a preview column. On a narrow screen the preview goes below.

**Cost centers.**
- A table with columns Name, Id and Used by. **Add** appends a row.
- The id of a new row is made from the name, the same way as budget ids:
  - lower-case letters, digits and dashes, at most 40 characters (`CENTER_ID`);
  - a suffix `-2`, `-3`, … when the id is taken;
  - never `unassigned` or a reserved name.
  - It can be edited until the first Save; after that it is read-only.
- **Used by** lists the keys, rules and budgets that point at the center.
- **Delete** is disabled while a key or rule uses the center. Its tooltip names them.
- A center used only by budgets can be deleted in the form. The Save is then refused by the server (409, see Error handling).
- At most 50 centers (`LIMITS.centers`). Add is disabled at the limit.

**Gateway keys.**
- One row per key in the settings answer's `keys` (`{ id, name }`).
- A select offers "Folder rules decide" (no mapping) plus each center.
- A mapping in `keyCenters` whose key no longer exists is listed under the table as "Key no longer exists" with **Remove**.
- A key's center always wins over folder rules. The block says so in one line.

**Folder rules.**
- An ordered list. Each rule has a glob input, a center select, **Up** / **Down** buttons and **Delete**. Buttons rather than drag, so the order can be changed from the keyboard.
- **Add** appends a rule. At most 100 rules (`LIMITS.folderRules`).
- One line explains the order: the first matching rule wins, and a path no rule matches is Unassigned.
- Glob help, one line: `*` stays in one folder, `**` crosses folders, a trailing `/**` also matches the folder itself, start with `~`, `/` or a drive letter.

**Preview** (beside the blocks).
- About 400 ms after the last edit of the panel's draft, the page sends `POST /api/cost/settings/preview` with:
  - the saved settings, with this panel's draft fields in place;
  - the test path, if one is typed.
- A newer request supersedes an older one; the stale-answer guard is the same one the 3a pages use.
- The answer is drawn in four parts:
  1. **Moves**: the projects and keys of the last 30 days whose center changes under the draft. Each row shows the project (a `~` folder) or "Key: name", its cost in USD over 30 days, and current center → draft center. Sorted by cost, at most 50, with "and N more" below.
     - With no move: "No project or key changes center."
  2. **Rule warnings**, next to the rule they concern:
     - "Matches nothing in the last 30 days" (status `none`);
     - "Never used: rule #k above takes every path it matches" (status `shadowed`: it matches at least one project, but an earlier rule matched each of them first).
  3. **Unassigned**: projects of the last 30 days that are still Unassigned under the draft, by cost, at most 20.
     - Each has **Create rule**. It appends a rule with the glob `<project>/**`, which matches the folder and everything below it, puts focus on the new rule's center select, and scrolls it into view.
  4. **Test a path**: an input. The answer shows the center the path goes to and the rule that decides, "rule #3 `~/Github/acme/**`", or "Unassigned, no rule matches". A path is tested as a project; a key mapping does not apply.
- A draft that does not validate gets a 400 with `reasons`. The preview then shows those reasons instead of its parts, and Save stays enabled: the same reasons would come back from Save.
- Moves compare the center under the **saved** settings with the center under the **draft**, both computed by the server for the same rows. Centers stored on old rows are not used, so a draft equal to the saved settings shows no move, whatever earlier rules tagged.

**Save** sends `{ ...saved, centers, keyCenters, folderRules }`, where `saved` is read again from `GET /api/cost/settings` just before the POST. After success the panel shows: "Saved. New costs follow these rules from today. To apply them to past days, use Restate." The link opens the Restate panel with the range filled in.

## Section 3: Panel "Billing"

**Sources.** One row per source in `sources`, labelled as on the other pages: Claude Code, Codex, Gateway, Judge, Replay, Collaboration.

Each row has a **Metered** / **Plan** switch.
- **Plan** shows three fields:
  - plan name, 1–60 characters;
  - fee in USD, 0 to 1,000,000;
  - period, month or year.
- One line explains the result: "The plan fee is spread over the days of its period and counted as paid. Usage on this source counts as usage value only."
- A source missing from the saved `billing` shows as Metered.

**Save** sends `{ ...saved, billing }`, with every source written out (`{ mode: 'metered' }` or the plan). After success it shows the same "applies from today" note and Restate link as the rules panel.

## Section 4: Panel "Display currency"

**Currency.** A choice of **USD only** or **USD + display currency**. With the second:
- a code input of three capital letters, not USD (`CURRENCY`);
- a rates table with columns Start date and Units per 1 USD, plus **Add** and **Delete**;
- at most 1000 rates (`LIMITS.rates`), sorted by date on save.

The panel then shows two lines:
- **Today's rate:** "Today: 1 USD = 16,250 IDR (rate from 2026-10-01)". This line is computed in the browser with the same rule as `rateFor`: the latest start date on or before the day.
- **Note:** "Rates convert at read time: a change here also changes how past days read in this currency. USD amounts never change." Rates are not frozen per day as costs are, so the owner must know.

**Save** sends `{ ...saved, currency }`. Turning the currency off or changing its code while a budget is set in it is refused by the server (409). The reasons are shown, as for centers.

## Section 5: Panel "Restate"

**Explanation.** "Restate recomputes a past range with today's prices, rules and billing, and records the result as a correction. It cannot be undone. Today is never restated: it follows the current settings already."

**Range.**
- Two date inputs, From and To.
- Default: the first of this month to yesterday. On the first day of a month the default is the previous month.
- To is at most yesterday, and the range is at most 400 days. Both are checked in the browser with the server's wording, and by the server.

**Preview.** **Preview** sends `POST /api/cost/restate/preview { from, to }` and shows:
- **Rows:** "N ledger rows change", out of the rows in the range.
- **Usage value:** before → after and the difference, in USD.
- **Center moves:** pairs of old center → new center with their usage value, by amount, at most 20.
- **Prices:** the price versions the rows had → the version they get, or "today's prices, not yet recorded as a version" when the pricing changed since the last version. The real restate records that version.
- **Billing per source** set over the range: Metered, or the plan with its fee and period. The paid figures of the range follow it.
- With no row change: "No ledger row changes. The billing above is still set over the range." A restate stays allowed, because it may only be meant to fix billing.

**Confirm.** Shown under a preview:
- a reason, 1–200 characters;
- a checkbox, "I understand this correction cannot be undone";
- **Run restate**, enabled only when:
  - a preview of the same range is shown;
  - the reason is filled;
  - the box is checked;
  - no Save in another panel happened since the preview. A Save marks the preview stale, with "Settings changed: preview again".

Editing the range also marks the preview stale. **Run restate** sends `POST /api/cost/restate { from, to, reason, confirm: true }`. On success the panel shows "Restated: N rows" and reloads the history.

**History.**
- A table of past restates, newest first, at most 100.
- Columns: when, range, reason, rows changed, price version.
- Empty: "No restate yet."
- The reason is the owner's text and goes through `esc()`.

## Section 6: Server, API and data flow

**`lib/cost/ledger.js`.** `restate()` is split. The behaviour of `restate()` and its tests stay as they are.

```
restateRows(store, { from, to, version, pricer, rules }) -> [{ key, before, after }]   // compute only
restate(store, { from, to, reason, ts, version, pricer, rules, billing })               // restateRows + addCorrection
```

**`lib/cost/prices.js`** gains `peek(pricing)`. It returns `{ version, pricer }` without writing:
- `version` is the latest version when its hash equals the current pricing's hash;
- otherwise it is `null`, and `pricer` is made from the current pricing.

**`lib/cost/index.js`** gains two functions.
- `restatePreview({ from, to })`
  - Checks as `restate()` does: the range, today excluded, a retry with `store.flush()` before `assertReadable`, and the 409 while settings are invalid.
  - Writes nothing: no `billing.ensure`, no `prices.observe`, no correction.
  - Returns `{ from, to, rows: restateRows(...), versionsBefore, version: id or null, newPrices, billing: [{ source, ...billingOf(source) }] }`. `versionsBefore` is the distinct `before.priceVersion` values.
- `corrections()`
  - Returns `[{ ts, from, to, reason, priceVersion, rows: count, billing }]`, newest first, at most 100.
  - Throws `LEDGER_CORRECTIONS_UNREAD` (503) while the corrections do not read.

**`lib/cost/preview.js`** (new, pure: no I/O, no clock).

```
settingsPreview({ saved, draft, rows, testPath, compileOpts })
  -> { moves: [{ project, keyId, keyName, listUSD, from, to }], more,
       rules: [{ index, status: 'ok'|'none'|'shadowed', by }],
       unassigned: [{ project, listUSD }],
       test: { center, rule } | null }
restateSummary({ rows, billing, versionsBefore, version, newPrices })
  -> { changed, beforeUSD, afterUSD, moves: [{ from, to, listUSD }], versionsBefore, version, newPrices, billing }
```

- `settingsPreview` inputs:
  - `saved` and `draft` are validated settings. Both go through `rules.compile`, with the platform's case rule unless `compileOpts` says otherwise. `from` and `to` in a move are the centers under `saved` and `draft`.
  - `rows` is `cost.ledger({ from: today − 29, to: today, groupBy: ['project', 'keyId'] }).rows`.
  - `saved` is the settings in force (`settingsOf`); while they do not read it is the defaults, so every mapped row shows as a move from Unassigned.
  - `by` is the index of the earlier rule that took the rule's matches.
- `restateSummary` sums `before.listUSD` and `after.listUSD` per changed row, and center moves per (before.center, after.center) pair whose centers differ.

**Routes** in `lib/cost/api.js`. They follow the other `/api/cost` routes:
- dashboard session only, never a gateway key, MCP or A2A;
- path-free errors;
- unknown body fields are a 400.

| Route | Body / answer |
|---|---|
| `POST /api/cost/settings/preview` | Body `{ settings, testPath? }`. `testPath` is a string of at most 1000 characters, rewritten to `~` form like a glob. 400 `{ error: 'invalid cost settings', reasons }` for a draft that does not validate. 503 with a code when the ledger is unavailable. The route passes the settings in force as `saved` and the body's draft as `draft`. Answer: `settingsPreview(...)` plus `from`, `to`, `unread`. |
| `POST /api/cost/restate/preview` | Body `{ from, to }`. The same 400, 409 and 503 rules as `POST /api/cost/restate`, without reason and confirm. Answer: `restateSummary(...)`, with `from` and `to`. |
| `GET /api/cost/restates` | `{ restates: cost.corrections() }`, the reasons as written by the owner. 503 while the corrections do not read. |
| `GET /api/cost/settings` | Unchanged, plus `reasons` (see Section 1). |

**Demo.**
- In demo mode the previews answer from the demo ledger and demo settings.
- The history answers from the demo's corrections, or `[]`.
- Saves and restate behave as they do today in demo mode.
- No file, no network.

**Front end.**
- **`public/costsettings.js`** (new), loaded after `costview.js`:
  - `costMountSettings()`;
  - the four panels;
  - the drafts;
  - the preview requests;
  - pure helpers exported for Node tests: id from name, draft → request body, today's rate, restate default range, preview staleness.
- It follows the rules of `costview.js`:
  - `cost` / `COST` prefix;
  - nothing touches the DOM at load time;
  - every owner or server string goes through `esc()`;
  - no inline handlers.
- **`costview.js`** gains the `COST_SUBS` entry and calls `costMountSettings()` for `settings`. Its quiet refresh skips the Settings page.
- Styles go in `public/styles.css` under `.cost-set-`.

## Error handling

- **A Save refused with 400** shows `reasons` in the panel, as a list under its Save. Fields whose path a reason names, such as `folderRules[2].center`, get the error mark.
- **A Save refused with 409 because budgets depend on the change** shows the reasons and a link "Open Budgets" (`#cost/budgets`). The draft stays.
- **409 `CONFIG_BROKEN`** shows "config.json could not be read; fix it first". The draft stays.
- **A preview that fails**, by network or 503, shows its error in the preview column with **Retry**. The form keeps working.
- **A restate preview or run that fails** shows the server's path-free message. A 503 names what did not read, for example "a ledger month could not be read".
- **Every request** is guarded against stale answers. A failed request never clears a draft.

## Privacy

Answers hold `~` folders, key ids and names, center names, numbers and the owner's restate reasons. Nothing else: no prompt, response or tool text. The page is for the signed-in owner only.

## Testing

- **`ledger.restateRows`**: the same rows as `restate()` for the same input; `restate()` behaves as before (existing tests).
- **`prices.peek`**: the latest version when the hash matches, `null` and a fresh pricer when it does not; nothing written (a temp dir stays unchanged).
- **`index.restatePreview`**: the same refusals as `restate()`; no file written (billing history, price versions, corrections unchanged on disk); rows equal to what the following `restate()` records.
- **`index.corrections`**: newest first, the cap, 503 while unread.
- **`preview.settingsPreview`**:
  - a draft equal to the saved settings giving no move;
  - a key mapping winning over a rule;
  - the first rule winning;
  - `none` and `shadowed` with `by`;
  - moves sorted and capped with `more`;
  - unassigned list and cap;
  - the test path through rules only;
  - `<project>/**` matching the project it was made from;
  - case rule per platform option.
- **`preview.restateSummary`**: sums, center move pairs, no-change answer.
- **API**:
  - 401 without a session, a gateway key refused;
  - unknown fields;
  - an invalid draft returning reasons;
  - the restate preview's 400 for today and for more than 400 days, its 409 for invalid settings, its 503;
  - path-free errors;
  - demo answers;
  - `reasons` in the settings answer.
- **UI helpers** (in Node, as `test/monitors-ui.test.js` does):
  - id from name with suffixes and reserved names;
  - each panel's request body keeping the other sections as saved;
  - the Save buttons disabled while settings do not read;
  - today's rate rule against `rateFor`;
  - the restate default range, including the first day of a month;
  - preview staleness after a range edit or a Save;
  - Delete disabled for a used center;
  - the "Create rule" glob;
  - an audit that every owner or server string goes through `esc()`.
- **Tests never call a real network** and never signal a real process.

## Out of scope

- Fetching exchange rates.
- Renaming a center's id.
- Editing gateway keys themselves; they are managed on the Gateway page.
- Undoing a restate.
- A billed-amount difference in the restate preview; it shows the billing to be set, not the paid figures recomputed.
- The 3a follow-ups listed in its ledger.
- Sub-projects 4 (forecast, anomalies, recommendations) and 5 (reports, export, MCP).
