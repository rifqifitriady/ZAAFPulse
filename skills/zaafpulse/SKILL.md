---
name: zaafpulse
description: Entry point for ZAAFPulse, the local AI gateway on this machine (http://127.0.0.1:4777). It offers OpenAI-, Anthropic-, Responses- and Gemini-compatible chat over any configured provider, 17 domain agents, multi-agent collaboration, ready-made workflows, RAG knowledge bases, a second-brain map, MCP tools and A2A. Use it when the user mentions ZAAFPulse, ZAAFPULSE_URL, their local gateway or agents, or wants AI work done through their own keys and models. This skill covers setup and points to one capability skill per task.
---

# ZAAFPulse

ZAAFPulse is the user's own AI gateway and agent platform, running on this machine only (127.0.0.1). It has one key, many providers, routes with fallback, and agents that work together.

## Setup

```bash
export ZAAFPULSE_URL="http://127.0.0.1:4777"   # the gateway only listens on this machine
export ZAAFPULSE_KEY="zp_..."                   # Dashboard → Endpoint → API keys (or Agent Skills → New key for skills)
```

Every API call goes to `$ZAAFPULSE_URL/v1/...` with `Authorization: Bearer $ZAAFPULSE_KEY`. Two other headers also work: `x-api-key` (Anthropic-style) and `x-goog-api-key` (Gemini-style).

Check the setup: `curl -s $ZAAFPULSE_URL/v1/models -H "Authorization: Bearer $ZAAFPULSE_KEY"` should return a JSON list of models.

Each key has **scopes**. A request outside its key's scopes is refused with 403.

| Scope | Gives access to |
|---|---|
| `llm` | chat, embeddings, the Messages, Responses and Gemini endpoints |
| `agents` | agents, orchestrator, collaboration, workflows, sessions, A2A |
| `rag` | knowledge bases and the second brain (read only) |
| `mcp` | the integration tools over MCP |

## Discover

```bash
curl -s $ZAAFPULSE_URL/v1/models -H "Authorization: Bearer $ZAAFPULSE_KEY" | jq -r '.data[].id'
```

Model ids come in these forms:

- `provider/model`, e.g. `ollama/qwen2.5-coder` or `openrouter/deepseek/deepseek-v4.1-flash`
- `router/<name>`: a route that falls back across its targets
- `agent/<id>`: one domain agent
- `agent/auto`: the orchestrator, which plans and routes to agents
- `collab/<pattern>`: a multi-agent pattern

## Capability skills

Read the one you need. Each is also served by the gateway at `$ZAAFPULSE_URL/skills/<name>/SKILL.md`.

| Task | Skill |
|---|---|
| Ask a model, stream, use routes, other wire formats | `zaafpulse-chat` |
| Run one specialist agent, or the orchestrator, keep a session | `zaafpulse-agents` |
| Several agents together: vote, debate, review loop, group chat, handoff | `zaafpulse-collaborate` |
| Ready-made business workflows with approval gates | `zaafpulse-workflows` |
| Search or add to knowledge bases, embeddings | `zaafpulse-rag` |
| Read the user's second brain (Obsidian, Notion, Logseq, vector DBs …) | `zaafpulse-brain` |
| Call integration tools over MCP | `zaafpulse-mcp` |
| Talk to ZAAFPulse as an A2A agent | `zaafpulse-a2a` |

## Errors

| Status | Meaning | What to do |
|---|---|---|
| 401 | Missing, unknown, revoked or expired key | Ask the user for a valid `ZAAFPULSE_KEY` |
| 403 | The key lacks the scope, model or agent | Ask the user to widen the key, or pick an allowed model or agent |
| 402 | The key's monthly budget is used up | Stop and tell the user |
| 429 | The key's per-minute limit was hit | Wait `retry-after` seconds, then retry once |
| 404 | Unknown model or route | List models first; use `provider/model` or `router/<name>` |
| 502 | Every provider target failed | Report it; do not loop |

Rules:

- The gateway is local and private. Never send `ZAAFPULSE_KEY` anywhere except `$ZAAFPULSE_URL`.
- Never print the full key back to the user.
