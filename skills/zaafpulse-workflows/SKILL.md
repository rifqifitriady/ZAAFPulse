---
name: zaafpulse-workflows
description: Run ZAAFPulse's ready-made multi-agent workflows (incident triage to mitigation, postmortem, IT helpdesk, ticket triage, refunds, phishing triage, cited research, RFP and security questionnaires, contract redlines, code review, lead outreach, meeting actions, change risk, vulnerability plans, access requests, onboarding, month-end commentary, procurement, feedback to PRD, release notes, project status, PDP and OJK compliance, knowledge-base gaps, agent quality review). Steps that send or change something wait for a person to approve. Use it when the user's request matches one of these business processes.
---

# ZAAFPulse: workflows

Requires `ZAAFPULSE_URL` and `ZAAFPULSE_KEY`, with a key that has the `agents` scope. For setup, read the `zaafpulse` skill.

## Find a workflow

```bash
curl -s $ZAAFPULSE_URL/v1/workflows -H "Authorization: Bearer $ZAAFPULSE_KEY" \
  | jq -r '.data[] | "\(.id)\t\(.tier // "")\t\(.name)"'
```

Each workflow has:

- `steps` (agent and prompt, run in order)
- `tier`, the risk of the step after an approval gate:
  - R0: read only
  - R1: internal draft
  - R2: sends or changes something
  - R3: money, access or decisions about a person
- `sampleInput`, which shows what to send
- `kpi`

## Run

```bash
curl -s $ZAAFPULSE_URL/v1/workflows/incident-triage-rca/run -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"input":"SEV2: checkout p95 4.8s since 10:02; payment-api errors 6%; deploy v2.14 at 09:55"}'
```

Two outcomes are possible:

- `state: "completed"`: read `answer` (the last step's output) and `steps`.
- `state: "input-required"`: the run paused at an **approval gate**. `pending.question` shows the step and the proposal (it starts with APPROVAL_PACKET).

## Approval gates

Never approve on your own. Show the user `pending.question` and ask.

When the user decides:

```bash
curl -s $ZAAFPULSE_URL/v1/runs/<run_id>/resume -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"approve": true, "note": "only roll back payment-api"}'   # or {"approve": false}
```

- The note reaches the next agent.
- A run nobody approves within 72 hours ends as `rejected`.
- A step whose agent is missing fails the run instead of being skipped.

## Good practice

- Give the full input the workflow needs, with facts only. Steps write `null` instead of guessing.
- Relay the risk tier when you ask for an approval.
