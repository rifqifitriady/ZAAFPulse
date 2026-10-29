# Cost Control, sub-project 4b: cheaper-model recommendations

Date: 2026-10-28 · Status: decided by the controller's recommendations (the owner asked to follow them) · Builds on: the cost ledger (#53), the Cost Control menu (#55), 4a (#57), and Datasets experiments.

4b recommends cheaper models. Each recommendation names the model the owner pays for, the cheaper candidate, and the experiment in Datasets that shows the candidate does about as well on the owner's own examples. It also gives an estimate of what the switch would save per month, from the ledger. It never changes routing by itself.

## Decisions

| Topic | Decision |
|---|---|
| Evidence | Only **Datasets experiments** count: the same examples run on both models, scored by the same evaluators. Nothing comes from public benchmarks or guesses. |
| Where | A new **Recommendations** card on the Value page (`#cost/value`), served in the existing `GET /api/cost/view?page=value` answer. No new sub-page and no new route. |
| What counts as "as good" | The candidate's pass rate is at most **5 points** below the current model's, over the same experiment, with **at least 20 scored rows** for each model. |
| What counts as "cheaper" | The candidate's cost per example is at most **80 %** of the current model's, so the saving is at least 20 % (a local model costs 0). |
| Savings | The current model's usage value (list) over the last 30 days × (1 − cost ratio). It is shown as "about $X a month at the last 30 days' use". It is an estimate, and the card says so. |
| Gaps | The 3 models with the most spend over 30 days that **no** experiment compares with a cheaper model are listed as "No evidence yet". Each links to Datasets so the owner can run an experiment. |
| Action | **No automatic switch.** The card links to the experiment, so the owner can read its rows. Routing a model elsewhere stays a manual gateway setting (out of scope). |
| Architecture | A new pure module, `lib/cost/recommend.js`, wired into `views.value` and the Value page in `public/costview.js`. |

## Section 1: The module (`lib/cost/recommend.js`)

Pure: no I/O and no clock.

```
recommend({ experiments, spend, from, to, now, limits = DEFAULTS })
  -> { items: [Rec], gaps: [Gap], basis: { experiments, from, to } }
DEFAULTS = { maxDropPoints: 5, minRows: 20, maxCostRatio: 0.8, maxAgeDays: 90, maxItems: 5, maxGaps: 3 }
```

**Inputs**
- `experiments` is the experiment store's list (`lib/datasets/experiments.js`). Each record has `id`, `dataset`, `datasetName`, `endedAt`, `status` and `summary.models[name] = { requests, cost, errors, evaluators: { id: { pass, total } } }`.
- `spend` is `{ [model]: listUSD }`: the ledger's usage value per normalized model over `[from, to]`, the last 30 days, plan rows left out.

**Which experiments count**
- Only experiments that ended within the last `maxAgeDays` (`now − endedAt`), with `status` `'done'`. A stopped or errored run does not count.
- Model names are normalized as the ledger's are (`normalizeModel`).

**Per experiment and per pair (current model A, candidate B)**
- Both A and B must be in `summary.models`, and A must have `spend[A] > 0`.
- **Pass rate.** Each model's `rate` is the sum of `pass` over the sum of `total`, across the evaluators **both** models have. `rows` is that same sum of `total`.
  - The pair counts only if both have `rows >= minRows`.
  - An experiment with no common evaluator is skipped.
- **Cost per example** is `cost / requests` for each model. A model with 0 requests is skipped.
  - B qualifies when `costPer(B) <= maxCostRatio × costPer(A)`, which includes a local model at 0.
  - A with `costPer(A) == 0` is never a current model to save on.
- **Quality.** B qualifies when `rate(B) >= rate(A) − maxDropPoints / 100`.

**Choosing per current model**
- For each A, the qualifying (experiment, B) pairs are ranked by the monthly saving (largest first), then by `rate(B)` (highest), then by the newest experiment.
- The best pair is the recommendation, and the others are counted as `alsoBackedBy`.

**A recommendation (`Rec`)**

```
{ model: A, candidate: B, local: costPer(B) === 0,
  spendUSD: spend[A], savingUSD: spend[A] × (1 − costPer(B)/costPer(A)),
  costRatio, rateA, rateB, rowsA, rowsB,
  experiment: { id, dataset, datasetName, endedAt }, alsoBackedBy: n }
```

- Items are sorted by `savingUSD` (largest first), at most `maxItems`.
- Amounts are rounded to 8 decimals, rates to 4.

**A gap (`Gap`)**

```
{ model, spendUSD, reason: 'no_experiment' | 'no_cheaper_match' }
```

- Gaps are the models with `spend > 0` and no recommendation, sorted by spend, at most `maxGaps`.
- **`no_experiment`:** no counted experiment has the model with enough rows.
- **`no_cheaper_match`:** experiments exist, but no candidate is both as good and cheap enough.

## Section 2: The view and the route

- `views.value(...)` gains a `recommendations` input and passes it through as `recommendations` in the answer. The input is the result of `recommend(...)`, or `null` when it could not be computed.
- **What the route passes.** `GET /api/cost/view?page=value` computes it with:
  - the experiment store's list, read through the same `passRates` provider path server.js already wires (a new `experiments()` provider on `createCostApi`, default `() => []`);
  - `spend` from the ledger's last 30 days `[today − 29, today]`, list measure, plan rows out, grouped by model. This is a separate quiet read, so the page's own range does not change the recommendation.
- **Failure.** A read that fails gives `recommendations: null`, and the page still renders.
- **Demo.** The demo includes one experiment that backs one recommendation and leaves one gap, so the card shows both.

## Section 3: The Value page card

A **Recommendations** card, placed after the existing Value charts:
- **A row per recommendation:**
  - "**claude-opus-5-5 → claude-sonnet-5-5**: about $42 a month at the last 30 days' use (cost per example 31 % of today's)";
  - a second line: "Pass rate 91 % vs 93 % on *support-tickets* (120 rows each, 12 Oct)", linking to the experiment in Datasets (`#datasets/<slug>?experiment=<id>`; the plan confirms the exact Datasets route);
  - a "local" chip when the candidate is a local model;
  - "+n more experiments agree" when `alsoBackedBy > 0`.
- **No evidence yet:** the gaps, each with its 30-day spend and a link "Run an experiment in Datasets" (`#datasets`). The reason reads "No experiment yet" or "No cheaper model did as well".
- **Empty states:**
  - no spend in 30 days: "No model spend in the last 30 days";
  - no experiments: "Run an experiment in Datasets to compare models on your own examples";
  - `recommendations: null`: "Recommendations could not be computed right now".
- **The footnote:** "Estimates from your own experiments and the last 30 days' use. Nothing is switched for you."
- **Currency.** Amounts are shown in USD. The Value page shows both measures, and the saving is on usage value, so a plan-covered source saves usage value, not money paid. The footnote says so when any recommended model ran under a plan in the window.
- Every model, dataset and experiment name goes through `esc()`.

## Error handling

- An experiment record with a missing or invalid summary is skipped, never thrown on.
- An unknown model name (normalizing to null) is skipped.
- A failed read gives `recommendations: null`.

## Testing

- **`recommend.js`:**
  - qualification at both edges: exactly 5 points drop, exactly 0.8 ratio, exactly 20 rows;
  - common evaluators only;
  - stopped runs, old runs and zero requests skipped;
  - a local candidate;
  - choosing the best pair, and `alsoBackedBy`;
  - sorting and caps;
  - both gap reasons;
  - normalized names;
  - rounding.
- **`views.value`:** passes `recommendations` through, and null stays null.
- **API:**
  - the field is present;
  - the 30-day spend window is independent of the page range;
  - a failed read gives null;
  - demo answers carry one item and one gap.
- **UI helpers** (in Node): the row texts, the empty states, the plan footnote, the experiment link, and every string through `esc()`.
- Tests never call a real network or signal a real process.

## Out of scope

- Automatic routing to the cheaper model.
- Recommendations from public benchmarks.
- Running experiments automatically.
- Per-project recommendations.
- Reports, export and MCP tools (sub-project 5).
