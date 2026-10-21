# Sub-project 2: Local evals and feedback

Date: 2026-10-20 · Status: approved in brainstorming, awaiting spec review · Depends on: sub-project 1 (span model and ids) · Shared requirements: overview (S1–S11, P1–P10).

## Goal

Score what agents did, automatically and locally, and let the owner mark what was good or bad. Results attach to spans, turns and sessions, so they show up in the Explorer and the Quality page, and monitors and datasets can use them.

## Evaluators

There is one registry (`lib/evals/registry.js`). Each evaluator declares:
- `id` and `version`;
- `kind`: `code` or `judge`;
- `scope`: `span`, `turn` or `session`;
- its labels, as an ordered list with a pass label;
- `direction`: `maximize` or `minimize`;
- for judges, a prompt template.

**Code evaluators.** These are the existing detectors, wrapped. They always run, at index time, on 100% of data, at no cost.

| id | scope | Source detector |
|---|---|---|
| `secret_leak` | span | `scanSecrets` |
| `risky_command` | span | `scanRisky` |
| `prompt_injection` | span | `scanInjection` (external vs local kept) |
| `non_existent_target` | span | `classifyError` → hallucination category |
| `tool_loop` | turn | the existing loop counter |
| `correction` | turn | `isCorrection` (after an assistant turn) |

**Judge evaluators.** They are on by default and use a local model first.

| id | scope | Labels (pass first) | What it reads |
|---|---|---|---|
| `faithfulness` | turn | faithful / unfaithful | answer + the tool results and files it cites |
| `task_completion` | turn | complete / partial / incomplete | prompt + final answer + the last tool outcomes |
| `tool_selection` | span (tool) | appropriate / questionable / wrong | prompt + the tool call + the tools that were available |
| `relevance` | turn | relevant / partly / off-topic | prompt + answer |
| `user_frustration` | session | none / some / high (minimize) | the user's prompts in order |

Templates follow the Arize and Phoenix patterns:
- a forced choice among the labels;
- a one-sentence explanation;
- the content wrapped as untrusted data (S5);
- no tools.

## Judge model resolution (local first)

1. The model set in Settings → Evals, if any.
2. Ollama: `GET http://127.0.0.1:11434/api/tags`. Prefer a configured name, otherwise the first instruction-tuned model from a short ranked list (qwen3, llama3.x, mistral, gemma); the list is documented.
3. LM Studio: `GET http://127.0.0.1:1234/v1/models`.
4. None found: the judge **waits**. Nothing is sent anywhere. A banner on the Quality and Explorer pages reads "Install or start Ollama, or choose a provider", with a provider picker (S4). Code evaluators keep running.

An external provider (any gateway provider) runs only after the owner selects it. Even then:
- the input is masked first (S2, S4);
- the first use shows a preview of what will be sent;
- the run is subject to the daily cost cap.

## Scheduling (lightweight by design)

- **On by default:** only turns that finish after the judge became available are judged automatically.
- **History** is judged on request, with a "Judge this session" button and a CLI command `zaafpulse eval --judge --session <id>`.
- **One queue, concurrency 1.** Daily cap: 500 judgments (configurable). Cost cap: $1/day for external providers (configurable). When a cap is hit, judging pauses until the next day and the Quality page says so.
- **Input budget:** about 6k tokens per judgment. Long material keeps its head and tail plus the cited tool results; the trimming is recorded on the result.
- **Idempotent:** the key is `(target id, evaluator id, evaluator version, judge model)`. Changing the model or template version allows a re-judge on request.
- **Gateway traffic:** plain requests have no stored text, so only code evaluators and metadata checks (status, errors, loops) apply. Collaboration runs are judged like turns.

## Stores (S11)

- `.data/evals.jsonl`. Each record holds:
  - `{ id, target: { source, session, turn, span }, evaluator, version, label, score, direction, explanation (≤300 chars), judge: { kind, model, provider }, trimmed, ts }`;
  - no prompt text.
  
  The file rotates at 10 MB and is compacted to the latest result per key.
- `.data/feedback.jsonl`. Each record holds `{ id, target, rating: 'good' | 'bad', note (≤2,000 chars), annotator: 'human', ts }`.
  - An update rewrites the record under the same id.
  - A note is the owner's own text. It is stored as written, shown as text only (S1), and never sent anywhere in wave 1.

## Where results appear

- **Explorer:**
  - badges on tree rows and map nodes (the pass label in green, any other label in amber or red);
  - the Evals tab: label, score, explanation, judge model, trimmed flag, and a "re-judge" action;
  - the Notes tab and the Good/Bad buttons, with keyboard `g` / `b` / `n`;
  - session rows show a feedback marker.
- **Quality page:**
  - a new "Evals" card with the pass rate per evaluator and its 7-day trend;
  - a "Judge agreement" metric: the share of turns with both a judge label and human feedback where they agree. The Arize pattern targets 75–85%; below 70% the card suggests reviewing the template;
  - the existing heuristic KPIs stay.
- **MCP:** a read-only `acc_evals` tool returns pass rates and the latest failures (ids and labels only).

## API (dashboard session required)

| Route | Purpose |
|---|---|
| `GET /api/evals?session=&turn=` | results for a target |
| `POST /api/evals/run` `{ session, evaluators? }` | judge a session now (queued) |
| `GET /api/evals/status` | queue depth, today's count and cost, judge model, waiting reason |
| `GET/POST /api/feedback` | read or write feedback for a target |
| Settings additions | judge on/off, model, provider (explicit), daily caps, which evaluators run |

## Testing

- **Registry:** label order, direction, idempotency keys.
- **Code evaluators:** each wrapped detector against the existing labelled corpus. Its precision and recall must not regress (`scripts/eval-signals.js`).
- **Judge:**
  - a fake Ollama and a fake LM Studio server: discovery order, waiting state, and an external provider used only after selection;
  - masking before send;
  - invalid JSON or labels dropped;
  - caps and pause;
  - idempotency;
  - trimming.
- **Feedback:** create, update and read; note size cap; rendered as text.
- **Judge agreement:** computed correctly from synthetic pairs.

## Out of scope

- Online sampling of historical traffic.
- Custom evaluator authoring in the UI. Templates are code; a later wave may add editing.
- Annotation queues.
- Sending evals or feedback to Phoenix or Dynatrace (the deferred E).
