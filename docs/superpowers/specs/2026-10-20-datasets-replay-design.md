# Sub-project 4: Datasets, replay and the CI gate

Date: 2026-10-20 · Status: approved in brainstorming, awaiting spec review · Depends on: sub-projects 1 and 2 · Shared requirements: overview (S1–S11, P1–P10).

## Goal

Turn real failures into regression checks:
- save turns that went wrong;
- replay them against other models, text only;
- compare and score the results with the same evaluators;
- fail a CI step when quality drops.

## Datasets

**Example shape**

Each example is a JSON line in `.data/datasets/<slug>.jsonl` (mode 0600):

```js
{
  id, createdAt, updatedAt,
  source: { source, session, turn, span? },   // where it came from (links back to the Explorer)
  input: { system?, messages: [ { role, text } ], tools?: [ { name, description } ] },
  output: { text, model },                    // what the agent actually answered
  reference?: { text },                       // optional expected answer, editable
  tags?: [], evals?: { <evaluator>: label }, feedback?: 'good' | 'bad'
}
```

Every text field is masked with `scanSecrets` on save (S2). Datasets are the only place where wave 1 keeps a copy of transcript text, and only because the owner saved it.

**Limits:** 1,000 examples per dataset, 64 KB per text field (longer text keeps its head and tail with a marker), and 100 datasets.

**Adding examples**
- From the Explorer detail panel: "⤓ Add to dataset", choosing an existing dataset or creating one.
- Several at once: multi-select in the trace tree.
- An optional rule, "auto-add turns that fail an evaluator or get 👎", which picks the target dataset. It is off by default.

**Managing datasets:** a new Datasets view (`public/datasetview.js`, route `#datasets`):
- a list showing counts and the last change;
- an example table with input, output, reference, evals and feedback;
- inline editing of the reference and tags;
- delete;
- export and import as JSONL, with import validating the shape and size caps.

## Replay and experiments

**Where:** the existing Playground (`gatewayview.js` `gwPlayground`) gains a "Dataset" mode.

**Running an experiment**
1. Choose one example or a whole dataset.
2. Choose 1–3 models. Local models come first (Ollama, LM Studio); gateway providers can also be chosen. External providers follow the same rule as the judge (S4): explicit choice, a preview, and masking.
3. Run.

**Rules for a run**
- **Text-only (S8).** The recorded messages are sent with the tools *declared* but never executed. A tool call the model proposes is shown as a proposal, and the run stops at that point for that example.
- **Budget per run.** Cost and request caps apply, defaulting to $0.50 and 100 requests. A run stops cleanly when a cap is hit.
- **Requests go through the gateway**, so usage, cost, OTLP export and key budgets apply as for any request.

**Results**
- Side by side per example: original output | model A | model B | model C.
- Each result is scored with the chosen evaluators: code evaluators, plus judge evaluators if the judge is available. If a reference exists, a simple `reference_match` code evaluator (normalized exact or contains) is added.
- An experiment record is appended to `.data/experiments.jsonl`: `{ id, dataset, models, evaluators, startedAt, endedAt, perExample: [ { exampleId, model, label/score per evaluator, cost, ms } ], summary }`. Outputs are kept only inside the record, masked, and capped.
- An experiment list shows pass rate per evaluator and model, so two experiments can be compared.

## CI gate (`zaafpulse eval`)

```
zaafpulse eval --dataset auth-regressions --model local/qwen3 \
  --require faithfulness>=0.8 --require task_completion>=0.7 [--json] --ci
```

- Runs headless with the same engine and stores, against the local ZAAFPulse data folder (`--data` is honoured).
- Prints a table: evaluator × pass rate × requirement × result.
- `--json` writes a machine-readable report.
- `--ci` exits 1 when any requirement fails, 2 on configuration errors (unknown dataset, judge unavailable when a judge evaluator is required), and 0 otherwise.
- Documented recipes: GitHub Actions on a self-hosted runner with the data folder, and a pre-push hook.

## API (dashboard session required)

| Route | Purpose |
|---|---|
| `GET/POST /api/datasets`, `GET/PUT/DELETE /api/datasets/:slug` | list, create, rename, delete |
| `POST /api/datasets/:slug/examples` | add examples from span ids (the server reads and masks the text) |
| `PATCH/DELETE /api/datasets/:slug/examples/:id` | edit the reference or tags, or delete an example |
| `GET /api/datasets/:slug/export`, `POST /api/datasets/import` | JSONL export and import |
| `POST /api/experiments` | start a run; `GET /api/experiments` and `GET /api/experiments/:id` read results |

## Testing

- **Dataset store:**
  - masking on save;
  - caps (examples, field size, number of datasets);
  - import validation that rejects oversize or malformed lines;
  - export round-trip.
- **Add from spans:** text is read through the sub-project 1 adapters and the link back to the source is kept.
- **Replay:**
  - a fake provider proves that tools are declared and never executed;
  - a proposed tool call stops the example;
  - budget caps stop the run;
  - the local-first model order is followed;
  - the external-provider preview appears.
- **Experiments:** scoring with code and judge evaluators (fake judge), `reference_match`, and the summary maths.
- **CLI:** exit codes 0, 1 and 2; `--json` shape; `--data` honoured.

## Out of scope

- Dataset versioning beyond timestamps.
- Prompt management.
- Agent (multi-step, tool-executing) experiments.
- Sharing datasets with Phoenix or AX (the deferred E).
