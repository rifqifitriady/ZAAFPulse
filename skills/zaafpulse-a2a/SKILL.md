---
name: zaafpulse-a2a
description: Talk to ZAAFPulse as an Agent2Agent (A2A) agent using JSON-RPC 2.0 and SSE. Method names follow v1.0 (SendMessage, GetTask, ListTasks, CancelTask, SendStreamingMessage, SubscribeToTask); v0.3 names are also accepted. Skills are the collaboration patterns, agent:{id} and workflow:{id}. Use it when another agent or an A2A client should delegate a task to the user's ZAAFPulse agents.
---

# ZAAFPulse: A2A

Requires `ZAAFPULSE_URL` and `ZAAFPULSE_KEY`, with a key that has the `agents` scope. For setup, read the `zaafpulse` skill.

## Discover

```bash
curl -s $ZAAFPULSE_URL/.well-known/agent-card.json | jq '{name, capabilities, skills: [.skills[].id]}'
```

Skills:

- `auto`, `parallel`, `vote`, `debate`, `review`, `group`, `handoff`
- `agent:<id>`, e.g. `agent:legal-compliance`
- `workflow:<id>`, e.g. `workflow:contract-redline-review`

## Send a task

```bash
curl -s $ZAAFPULSE_URL/a2a -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"SendMessage",
  "params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"Review this NDA clause: …"}],
    "metadata":{"skill":"agent:legal-compliance"}}}}'
```

The result is `result.task`, which contains:

- `id` and `contextId` (the session)
- `status.state`: `TASK_STATE_COMPLETED`, `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_FAILED` and so on
- `artifacts`: `answer` as a text part, and `verdict` as a data part

## Options

- **Pattern options:** put them in `metadata.options`, e.g. `{"samples": 5}`.
- **Return at once:** `params.configuration.returnImmediately: true`, then poll with `GetTask`.
- **Streaming:** `SendStreamingMessage` returns SSE. The first event is the task, then status updates (who is working), the artifact, and the final status.
- **Follow-up:** reuse `message.contextId` to continue a conversation.

## Approvals (workflows)

A task in `TASK_STATE_INPUT_REQUIRED` is waiting for a person. To answer it:

- Send a new message with `message.taskId` set to that task.
- Give an explicit decision: `metadata.approve: true` or `false`, or text that starts with "approve" or "reject".
- Any unclear reply is refused, so it can never approve by accident.

## Other methods

| Method | Use |
|---|---|
| `GetTask` | `{"id": "run_…", "historyLength": 2}` |
| `ListTasks` | `{"contextId": "ses_…"}` |
| `CancelTask` | `{"id": "run_…"}` |
| `SubscribeToTask` | follow a running task as SSE |

Push notifications are not supported, because the gateway is local only.
