---
name: zaafpulse-collaborate
description: Multi-agent collaboration in ZAAFPulse. Patterns are orchestrator-worker, parallel specialists, sample-and-vote, debate, review loop (critic and rubric), group chat with a progress ledger, and handoff. Each run has a budget, a trace and a verdict. Use it when one model or agent is not enough, such as accuracy-critical answers, drafts that need review, or open investigations across domains.
---

# ZAAFPulse: collaborate

Requires `ZAAFPULSE_URL` and `ZAAFPULSE_KEY`, with a key that has the `agents` scope. For setup, read the `zaafpulse` skill.

## Choose a pattern

| Pattern | Use when | Key options |
|---|---|---|
| `auto` | Parts need different specialists | `effort`, `verify` |
| `parallel` | You want several views, merged into one answer | `agents`, `aggregator` |
| `vote` | Accuracy matters; this is the default way to spend more for quality | `agents` (or one), `samples` (default 5) |
| `debate` | The question is contested; it rarely beats `vote` at the same cost | `agents`, `rounds` (default 2, max 3) |
| `review` | A draft must meet clear criteria | `agent`, `critic`, `iterations`, `threshold`, `rubric` |
| `group` | Open investigation across domains | `agents`, `turns` |
| `handoff` | The conversation belongs to another specialist | `agent` (the starting agent) |

## Run

```bash
curl -s $ZAAFPULSE_URL/v1/collaborate -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"pattern":"vote","task":"Which change most likely caused the checkout slowdown?","agents":["sre-observability"],"samples":5}'
```

The response is the whole run:

- `answer`
- `state`: `completed`, `failed`, `canceled`, `rejected` or `input-required`
- `verdict`: for vote and debate, the clusters, agreement and `needsReview`; for review, the critic's scores
- `steps`, `blackboard`, `trace` (span names, tokens and cost, never prompt text)
- `spent` against `budget`

### Budgets

- `effort`: `simple`, `standard` (the default) or `deep`. It scales tokens, calls and time.
- `budget`: `{ "tokens": …, "calls": …, "seconds": …, "costUSD": … }`.
- A run that reaches its budget returns its best answer so far, with `stop.partial: true`.

### Long runs

Add `"async": true` to get back at once. Then poll the run.

## Runs

| Call | Purpose |
|---|---|
| `GET /v1/runs` | List runs (filter with `?session_id=`) |
| `GET /v1/runs/<id>` | Read one run |
| `POST /v1/runs/<id>/cancel` | Cancel a running run |
| `POST /v1/runs/<id>/resume` `{"approve": true, "note": "…"}` | Approve a paused workflow step; `false` rejects it |

## From any OpenAI client

Use model `collab/vote`, `collab/debate`, `collab/review`, `collab/group` or `collab/parallel`. Put pattern options in the `zp` field, e.g. `"zp": {"samples": 7}`.

## Good practice

- Report the verdict as well as the answer.
- When `verdict.needsReview` is true, say that agreement was low and show the alternatives.
