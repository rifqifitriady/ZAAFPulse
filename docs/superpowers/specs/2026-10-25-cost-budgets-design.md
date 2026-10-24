# Cost Control, sub-project 2: budgets, alerts and enforcement

Date: 2026-10-25 · Status: approved in brainstorming, awaiting spec review · Builds on: the cost ledger (sub-project 1, PR #53) and Monitors (#40, #49).

Cost Control is built in five sub-projects (see docs/superpowers/specs/2026-10-23-cost-ledger-design.md). This one adds budgets on top of the ledger, alerts through the Monitors engine, and optional enforcement. The Budgets page with its holo rings and the add-budget form belong to sub-project 3; model rerouting belongs to sub-project 4.

## Decisions taken in brainstorming

| Topic | Decision |
|---|---|
| What a budget measures | Chosen per budget: **usage value** (`listUSD`, the default) or **what was paid** (`billedUSD`). |
| Scope | Global, or **one** dimension: cost center, gateway API key, project, model, provider, or source (`claude`, `codex`, `gateway`, `judge`, `replay`, `collab`). No combinations. |
| Periods | Day, week (starts Monday), month (starts on the 1st), in the machine's local time. Nothing carries over. |
| Alerts | Up to 3 thresholds per budget (default 50 / 80 / 100 %), plus a **projection alert** once at least 25 % of the period has passed. Delivered through the Monitors channels (bell, desktop, webhook); only on a change of state. |
| At 100 % | A notification, plus optional enforcement per budget: **block** matching gateway requests (HTTP 402) or **pause** the local agent. Default: notify only. Rerouting to a cheaper or private model is deferred to sub-project 4. |
| Existing controls | **Migrated** to budgets: `monthlyBudgetUSD`, per-key `budgetUSD`, and the Monitors rules `daily_cost` and `month_projection`. Old settings keep being read. |
| Architecture | Budgets are instances of a `budget` rule in the Monitors engine; a real-time **gateway guard** enforces blocks. |
| UI in this sub-project | Minimal: alerts in the existing bell and drawer; old budget forms keep working with a "Manage in Budgets" link. Budgets are created through the API or `config.json` until sub-project 3. |

## Components

| Unit | Responsibility |
|---|---|
| `lib/cost/budgets.js` (new, pure) | Validation; period bounds; spent per budget from ledger rows; percentage; threshold state; projection. No I/O. |
| `config.json` → `cost.budgets` | The budget list (shape below). |
| `budget` rule in `lib/monitors/` | One rule instance per budget, evaluated after each ledger pass. Reuses the state machine, snooze, change-only alerts, channels and auto-pause. |
| `lib/cost/guard.js` (new) | The gateway's real-time check before a request is sent. |
| Migration (in `lib/cost/budgets.js` + wiring) | Reads the old settings as budgets, retires the two old monitor rules, keeps per-key 402 behaviour. |
| `lib/cost/api.js` (extend) | `/api/cost/budgets` routes. |

## Budget shape

```
{ id,                       // slug, unique
  name,                     // shown in alerts and the 402 message
  scope: 'global' | { dim: 'center' | 'key' | 'project' | 'model' | 'provider' | 'source', value },
  period: 'day' | 'week' | 'month',
  amount, currency,         // currency 'USD' or the display currency (e.g. 'IDR')
  measure: 'list' | 'billed',          // default 'list'
  thresholds: [50, 80, 100],           // 1–3 ascending integers in 1..100; the last one may be 100
  projection: true,                    // default true
  enforce: 'none' | 'block' | 'pause', // default 'none'
  legacy: null | 'monthlyBudgetUSD' | 'keyBudget' }   // set only for budgets read from old settings
```

Validation (400 with reasons on save; an invalid saved list keeps the last valid one in force and shows a status warning):
- unknown scope dimension or empty value; amount ≤ 0;
- a currency other than USD or the configured display currency;
- `enforce: 'block'` with scope `project` or `source` other than `gateway`;
- `enforce: 'pause'` with scope `key` or `provider`;
- duplicate ids.

## Rules

**Spent** for a budget = the sum of `listUSD` (measure `list`) or `billedUSD` (measure `billed`) over ledger rows in the current period that match the scope.
- Plan rows count only for measure `billed`, and only in global and `source` scopes. They carry no center, model or key.
- Corrections and billing overrides apply, as in every ledger read.
- **Currency:** an amount in the display currency is converted to USD with the latest rate on or before today. With no rate, the budget is `no_data` and says why.

**States:** `ok` → `threshold_1` → `threshold_2` → `exceeded`, where the last threshold, normally 100 %, is `exceeded`.
- `projected` is reported beside the threshold state when, at ≥ 25 % of the period, `spent ÷ elapsed fraction > amount`.
- `no_data` when the ledger months the period needs are unreadable, the billing history is lost for a `billed` budget, or there is no rate.
- An alert fires only on a change of state. A new period starts at `ok` without an alert.

**Block (`enforce: 'block'`):**
- **Scopes:** global, key, center (through the key's center), model, provider, and source `gateway`.
- **Guard:** before the gateway forwards a request, `guard.check({ keyId, center, model, provider })` returns the first exhausted blocking budget in scope, or `null`. Spent = the ledger total for the period plus gateway calls recorded since the last ledger pass, kept in memory per budget and cleared when the pass covers them.
- **Refusal:** HTTP 402 `{ error: 'budget "<name>" is used up for this <period>' }`, with no figures from other budgets.
- **Overshoot:** a call in flight finishes, so a budget can pass its amount by one call.
- **Unblocking:** the block lifts at the next period or when the amount is raised.
- **Dashboard calls:** calls from the dashboard itself (Playground, replay, collaboration, judge through the gateway) are subject to global, model and provider budgets.
- **Fail-open:** if spent cannot be computed (ledger unavailable), the guard **allows** the request and reports the error in status. Blocking every client because of a broken file is the worse failure.

**Pause (`enforce: 'pause'`):**
- **Scopes:** global, source `claude` or `codex`, project, center (through folder rules) and model.
- **Action:** on `exceeded`, the existing auto-pause pauses the costliest running local session in scope, once per period.
- **Safety:** every agent-control rule still holds — program verified before every signal, never SIGKILL, off without sign-in, in server mode and in Docker, audited. A paused agent is never resumed automatically.

**Migration:**
- `monthlyBudgetUSD` > 0 is read as `{ id: 'legacy-monthly', scope: 'global', period: 'month', measure: 'list', enforce: 'none', legacy: 'monthlyBudgetUSD' }`.
- Each gateway key with `budgetUSD` is read as `{ id: 'legacy-key-<keyId>', scope: { dim: 'key', value: keyId }, period: 'month', measure: 'list', enforce: 'block', legacy: 'keyBudget' }`. The old in-memory `checkBudget` path is replaced by the guard, and its 402 behaviour is kept.
- `daily_cost` and `month_projection` are turned off. Their alerts come from budget states now, so nothing alerts twice.
- Editing a legacy budget through the API saves it into `cost.budgets` and clears the old setting in the same write.
- Key spend now uses the ledger's shared pricer (cache writes, tiers, web search, geo), so a key's "spent" may read slightly higher than before, and it is more accurate.

## HTTP API

All routes need the dashboard session (never a gateway key, MCP or A2A). State changes need JSON (415 otherwise). Errors are path-free.

| Route | Returns |
|---|---|
| `GET /api/cost/budgets` | Each budget with `spent`, `percent`, `projected`, `state`, period bounds, and `legacy` |
| `POST /api/cost/budgets` | Creates or updates one budget; 400 with reasons |
| `POST /api/cost/budgets/<id>/delete` | Deletes one budget; a legacy one clears its old setting |

Demo mode ships budgets in mixed states (one exceeded with block, one projected, one with no data), with no real files and no network.

## UI (minimal in this sub-project)

- Budget alerts appear in the existing bell and alerts drawer with the budget name, the percentage and the period.
- The Settings budget field and the API key budget field keep working through the migration and gain a "Manage in Budgets" note.
- The Budgets page (rings, form) comes in sub-project 3.

## Privacy

- Alerts and the 402 message hold budget names, numbers and periods only, never prompt or response text.
- Budget names are owner-written and are shown back to the owner only. The 402 goes to the key's caller and names only that budget.

## Testing

- Period bounds: day, Monday weeks, months, period roll-over in local time.
- Spent per scope for both measures; plan rows only in global and source scopes; corrections and overrides applied.
- IDR conversion; no rate → `no_data`.
- States: threshold order, change-only alerts, projection from 25 %, reset at a new period, `no_data` cases.
- Guard: blocks at once (including calls not yet in the ledger), passes by at most one call, lifts at a new period and on a raised amount, allows when the ledger is unavailable, the 402 message names only its budget.
- Pause: costliest running session in scope, invalid scopes refused, once per period, never resumed.
- Migration: old settings read as budgets; `daily_cost` and `month_projection` no longer alert; a key budget still blocks with 402; editing a legacy budget clears the old setting.
- API: 401 without session, gateway key refused, 415, 400 with reasons, no paths.
- Tests never call a real provider or network, and never signal a real process.

## Out of scope

The Budgets page and charts (sub-project 3); smarter forecasts and rerouting to a cheaper model (sub-project 4); reports and export (sub-project 5); budgets combining several dimensions; custom one-off periods; carry-over.
