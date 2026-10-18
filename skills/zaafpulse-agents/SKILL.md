---
name: zaafpulse-agents
description: Run ZAAFPulse domain agents (customer service, sales and marketing, network ops, HR and finance, IT helpdesk, SRE, security, data analyst, DevOps, code reviewer, research, legal and compliance, product, project, procurement, content writer, AI ops) or the orchestrator that plans and routes a task across them. Sessions keep conversation context. Use it when a task fits a specialist, or when the user wants their ZAAFPulse agents to do the work.
---

# ZAAFPulse: agents and orchestrator

Requires `ZAAFPULSE_URL` and `ZAAFPULSE_KEY`, with a key that has the `agents` scope. For setup, read the `zaafpulse` skill.

## List agents

```bash
curl -s $ZAAFPULSE_URL/v1/agents -H "Authorization: Bearer $ZAAFPULSE_KEY" | jq -r '.data[] | "\(.id)\t\(.description)"'
```

- Each agent has its own prompt, model, tools (MCP integrations) and knowledge bases.
- An agent can consult other agents itself, and can hand a conversation on to another.

## Run one agent

```bash
curl -s $ZAAFPULSE_URL/v1/agents/network-ops/run -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"input":"Checkout latency doubled since 10:00. What should we check first?"}'
```

- The response contains `text`, `calls` (the tools it used), `usage` and `session_id`.
- To continue the conversation, send the same `session_id` again. Sessions expire 24 hours after the last message.

## Let the orchestrator plan

```bash
curl -s $ZAAFPULSE_URL/v1/orchestrate -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"task":"Customers report slow checkout. Find the cause and draft a customer update.","effort":"standard"}'
```

- The planner splits the task into steps for specialists. Independent steps run in parallel.
- The response has `answer`, `plan.steps` (agent, instruction, dependsOn), `steps`, `trace` and `usage`.
- `effort` is `simple`, `standard` or `deep`. `deep` also asks a critic to verify the answer.

## From any OpenAI client

Use model `agent/<id>` or `agent/auto` with `/v1/chat/completions`. The header `x-zp-session: ses_...` continues a session.

## Sessions

- `GET /v1/sessions` lists the key's sessions.
- `GET /v1/sessions/<id>` reads one session's messages.
- `DELETE /v1/sessions/<id>` ends it.

## Good practice

- Pick the agent whose domain matches; the orchestrator is for mixed tasks.
- Agents may use the user's real tools, so state plainly what you want done.
- Agents return text. Nothing is sent or changed outside ZAAFPulse unless an agent's tools do that, and workflows ask for approval before such steps.
