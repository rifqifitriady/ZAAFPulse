# Cost Control follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the user-visible and accuracy follow-ups left by the Cost Control sub-projects 3b, 4a, 4b and 5 (PRs #56–#59), in one PR.

**Architecture:** Small, independent changes in existing files. Each task names the behaviour, the files, and the tests to write first. These are follow-ups to reviewed code, so the tasks give exact requirements and test cases instead of full code. The implementer reads the current code and keeps to its patterns.

**Tech Stack:** Node ≥18, CommonJS, zero runtime dependencies, `node:test`, plain browser JS in `public/`.

**Sources:** the deferred findings in `~/.zaafpulse-backups/sdd-ledgers/{cost-settings-ui,cost-forecast,cost-recommendations,cost-reports}-progress.md`. Test-hygiene-only and performance-only items stay deferred; they are listed under "Not in this PR".

## Global Constraints

- **Dependencies:** zero runtime dependencies. CommonJS. `node:test`.
- **Browser files:**
  - keep each file's name prefix (`cost`/`COST`, `mon`/`MON`, `ds`/`DS`);
  - nothing touches the DOM at load time;
  - keep the `module.exports` guard;
  - every owner or server string goes through `esc()`;
  - no inline handlers (CSP `script-src 'self'`).
- **Errors** are path-free, as the existing routes do (`scrub`).
- **Tests:**
  - never call a real network or signal a real process;
  - restore any global you replace;
  - spawned servers use ports 9800–9999.
- **Test-first:** write each new test first, run it, and record the RED output before changing code.
- **Prettier:** use `.prettierrc.json` (printWidth 120). Do not run `--write` on `server.js`, `lib/cost/rules.js`, `lib/connectors/acc.js`, `public/styles.css` or `test/cost-rules.test.js`; keep your own lines formatted. `*.md` is ignored.
- **Commit messages:** plain and imperative. NO `Co-Authored-By` and NO "Generated with" lines.
- **UI copy:** English, exactly as quoted here.

## File map

| File | Tasks |
|---|---|
| `lib/cost/api.js`, `lib/cost/index.js`, `lib/cost/preview.js`, `public/costsettings.js`, `public/costview.js` | 1 |
| `public/costcharts.js`, `public/costview.js`, `lib/cost/views.js`, `public/monitorsview.js` | 2 |
| `public/datasetview.js`, `public/costview.js` | 3 |
| `lib/cost/report.js`, `lib/cost/api.js`, `public/costreports.js`, `public/costcharts.js`, `lib/response-headers.js` | 4 |
| `docs/cost.md`, `docs/monitors.md` | 5 |

---

### Task 1: Settings page — outside changes, restate basis, timeouts, labels

**Files:** `public/costsettings.js`, `public/costview.js` (`costCall`), `lib/cost/api.js`, `lib/cost/index.js`, `lib/cost/preview.js`. Tests go in `test/cost-settings-ui.test.js`, `test/cost-settings-api.test.js` and `test/cost-preview.test.js`, or new `test/cost-followups-*.test.js` files.

**1a. Warn when a panel changed elsewhere (last write wins today).**
- **What the draft remembers.** When a panel's draft is first created (`costSetEdit` on a panel with no draft), store the panel's saved fields as they were then: `COST_SET.bases[panel] = costSetBody(panel, saved, null-draft...)`. Use the same body builder, applied to the saved settings alone, so the two serialise alike.
- **The check.** In `costSetSaveRun`, after the fresh GET, compare the panel's fields in `fresh.settings` with the stored base.
- **When they differ,** do NOT post. Show this message in the panel, with tone `warn`: "These settings changed elsewhere since you started editing. Save again to replace them, or Discard to load them."
- **Save again.** Mark the base as accepted (`COST_SET.bases[panel] = <fresh fields>`), so the next Save posts.
- **Clearing the base.** Discard and a successful Save delete it.
- **Tests:**
  - an outside change between the edit and the Save → no POST, the message is shown, and a second Save posts;
  - no outside change → it posts as before.

**1b. A restate refuses when settings or prices changed since its preview.**
- **The basis.** `cost.restatePreview` returns `basis`, a short hash (sha256, first 16 hex characters) of:
  - the cost settings in force: `settingsNow().value` without `budgets` and `digest`;
  - the price version id, or for new prices the pricing hash.
- **The preview answer.** `POST /api/cost/restate/preview` answers with `basis`.
- **The run.** `POST /api/cost/restate` accepts an optional `basis` (add it to `RESTATE_FIELDS`). When `basis` is given and differs from the current one, it answers 409: "the settings or prices changed since the preview; preview again". When `basis` is absent, the behaviour is unchanged, which keeps the API compatible.
- **The page.** The Restate panel sends the preview's `basis` with Run. On that 409 it marks the preview stale and shows the server's message.
- **Tests:**
  - matching basis → 200;
  - a settings change between the preview and the run → 409, and nothing written (corrections count unchanged);
  - no basis → 200;
  - the UI sends `basis` and handles the 409.

**1c. Requests time out.**
- `costCall` (public/costview.js) passes `signal: AbortSignal.timeout(30000)` unless the caller gave a signal.
- A timeout throws an Error whose message is "The request took too long; try again".
- Test: a fake fetch that never settles, combined with a short injectable timeout (add an optional `timeoutMs` option), → it rejects with that message, and a queued Settings Save does not stay blocked: the next Save runs.

**1d. A move decided by a key reads as the key.**
- In `lib/cost/preview.js` `settingsPreview`, a moved row gains `by: 'key' | 'rule'`:
  - `'key'` when the draft's center for that row comes from `keyCenters` (or the saved one did and the draft no longer has it);
  - `'rule'` otherwise.
- The rules panel's Moves list shows "Key: <name>" for `by: 'key'`, even when the row has a project, followed by "(project ~/…)" in muted text.
- Tests: preview `by` for both cases, and the UI text.

**1e. Rates repaint only when their order changed.**
- In the currency Save, compare the `from` sequence of the rates before and after the in-place sort. Call `costSetPaintPanel(panel)` only when it changed.
- Test: already-sorted rates → no repaint call.

- [ ] Write the tests for 1a–1e, run them, record RED.
- [ ] Implement 1a–1e.
- [ ] Run `node --test test/cost-*.test.js test/budgets*.test.js` and record GREEN.
- [ ] Commit: `Cost settings: warn on outside changes, refuse a stale restate, time out requests, label key moves`

### Task 2: Forecast and anomaly UI polish

**Files:** `public/costcharts.js`, `public/costview.js`, `lib/cost/views.js`, `public/monitorsview.js`, plus their tests.

**2a. A zero-width band is not drawn.**
- When a burn-down point has `low === high` (rounded to the cent), draw no band polygon for that stretch, and leave the band text out of the tooltip.
- When every point has a zero-width band, the chart draws the line only.
- Test: a model with fewer than 3 ratios → no band element, and the tooltip has no "–" range.

**2b. A day of a month that did not read has no baseline.**
- In `lib/cost/views.js`, the spikes of the Overview give a day whose month is in `unread` `baseline: null, spike: false`.
- Test: `unread: ['2026-10']` → the October days have baseline null.

**2c. Monitors parameter inputs mirror the server's bounds.**
- `MON_PARAMS` entries gain `min` and `max` (and `exclusiveMin` where the server refuses equality):
  - `ratio`: above 1, up to 100;
  - `minUSD`: above 0, up to 1,000,000;
  - the existing positive params: above 0.
- They are rendered as the input's `min`/`max`/`step` attributes. `monParamValue` refuses a value outside the bounds with the label text: "<label>: <bound rule>".
- Test: ratio 1 is refused client-side with that text; ratio 2 is accepted.

**2d. The bell and the rule card are robust.**
- The bell's cost_anomaly branch reads `MON_STATE[st]` only through `Object.hasOwn`, and an unknown state gets tone `'muted'`.
- `monRuleNow` sorts the day instances by `instance` id, newest first, instead of reversing the server's order.
- Tests: a state named `constructor` → muted with no function text; instances given oldest-last still list today first.

- [ ] Tests first (RED), then the code, then `node --test test/cost-*.test.js test/monitors*.test.js` (GREEN).
- [ ] Commit: `Cost and Monitors pages: no zero-width band, no baseline for an unread month, bounded rule inputs`

### Task 3: Recommendations and the Datasets run link

**Files:** `public/datasetview.js`, `public/costview.js`, plus their tests.

**3a. `?run=` opens its run once.**
- After `dsPaintExperiments` opens the named run, it replaces the hash with `#datasets/experiments` (`history.replaceState`, with no `hashchange`), so a later repaint does not reopen it.
- Test: with a fake `history`/`location`, the hook calls `replaceState` once, and a second paint opens nothing.

**3b. A linked run that is no longer kept says so.**
- When the hash names a valid id that is not in the list, show a notice line in the Experiments panel: "That experiment is no longer kept (only the latest 100 are)". Use the store's real cap if it differs; read it from `lib/datasets/experiments.js`.
- Then drop the `?run=` as in 3a.
- Test.

**3c. A missing percentage reads as a dash.**
- `costPercent(null|NaN)` returns '—', not '0 %'.
- Test.

- [ ] RED, code, GREEN (`node --test test/datasets-ui.test.js test/cost-recommend-ui.test.js test/cost-ui.test.js`), commit: `Recommendations: the run link opens once, a gone run says so, a missing rate reads as a dash`

### Task 4: Reports polish

**Files:** `lib/cost/report.js`, `lib/cost/api.js`, `public/costreports.js`, `public/costcharts.js`, `lib/response-headers.js`, plus their tests.

**4a. A center's report includes its keys' budgets.**
- A budget whose scope is `key` counts for a center's report when that key's center is the report's center. Use `keyCenters` from the cost settings in force; `report.js` gets them from the route.
- Under All centers, every budget shows, as now.
- Test: the demo "Acme gateway key" budget appears in the Client: Acme report.

**4b. Folders outside home do not print as absolute paths.**
- In the report's project table, an absolute project path (not starting with `~`) is shown as `…/<last segment>`. For example, `/Volumes/Work/acme` becomes `…/acme`.
- This applies to the report answer only. The Breakdown and the export keep the full value, since they are for the owner.
- Test.

**4c. The report's daily chart has no spike wording.**
- `costSpikeSvg` takes an option `{ baselineText: false }` that leaves the "no baseline yet" text and the baseline line out of the tooltip. `public/costreports.js` passes it.
- Test: the report daily SVG tooltips contain no "baseline".

**4d. `Content-Disposition` is sent once.**
- `lib/response-headers.js` stores an allowed header under its canonical name `Content-Disposition`, whatever the casing it came in, so two casings can never both go out.
- Test: route headers with both casings → one header.

- [ ] RED, code, GREEN (`node --test test/cost-report*.test.js test/cost-reports*.test.js test/response-headers.test.js test/cost-charts.test.js`), commit: `Cost reports: include a center's key budgets, shorten outside folders, plain daily tooltips, one disposition header`

### Task 5: Docs and the whole suite

- **docs/cost.md:**
  - Settings outside-change warning (1a);
  - restate `basis` and its 409 (1b), plus the API rows for restate/preview and restate;
  - the request timeout (1c);
  - "Key: name" moves (1d);
  - the zero-width band (2a);
  - the unread-month baseline (2b);
  - a run link that is opened once and a run that is no longer kept (3a, 3b);
  - a center's key budgets in reports and the shortened outside folders (4a, 4b).
- **docs/monitors.md:** the parameter bounds on the cards (2c).
- **Whole suite:** run `npm test` once. Known flaky under load: `test/evals-claude-cli.test.js`; re-run it alone if it fails.
- [ ] Commit: `Docs: the Cost Control follow-ups`

## Not in this PR

These stay recorded in the ledgers:
- test-only gaps (T1-1/2, T2-3, T4-2/3, T5-6, T6-b/f, T7-b/d, T8-a/b, T1-b/c, T5-b, T6-a, T7-e, T2-e, T4-a, T5-c, T6-a, T7-a);
- refactors (T2-1/2, T3-1, T7-c, T3-a);
- performance (recentDays caching, firstDay memo, the reader loading every month, the duplicate Value read);
- rare edges: T6-c (KEY_ID forbids dots), T6-d (two new centers), T2-a (corrections cap), T2-d, T2-f, the experiments store reading as empty, T5-a/T5-b of 4a (acceptable).
