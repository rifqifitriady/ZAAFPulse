---
name: zaafpulse-chat
description: Chat and code generation through the ZAAFPulse gateway. It speaks OpenAI /v1/chat/completions, Anthropic /v1/messages, OpenAI Responses /v1/responses and Gemini /v1beta/models/*, with streaming, routes that fall back across providers, and a token saver for long tool output. Use it when the user wants to prompt a model, generate or review code, summarize, or embed text through their own ZAAFPulse providers.
---

# ZAAFPulse: chat

Requires `ZAAFPULSE_URL` and `ZAAFPULSE_KEY`, with a key that has the `llm` scope. For setup, read the `zaafpulse` skill.

## Pick a model

```bash
curl -s $ZAAFPULSE_URL/v1/models -H "Authorization: Bearer $ZAAFPULSE_KEY" | jq -r '.data[].id'
```

- Prefer a `router/<name>` route when one fits the task. Routes fall back to the next target when a provider is overloaded or rate-limited.
- Private models (Ollama, LM Studio, vLLM, TGI) keep data on the user's own hardware. Choose them for sensitive content.

## OpenAI format (any provider)

```bash
curl -s $ZAAFPULSE_URL/v1/chat/completions \
  -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"model":"router/coding","messages":[{"role":"user","content":"Write a bash one-liner to count lines in *.js"}],"stream":false}'
```

JS (OpenAI SDK):

```js
import OpenAI from "openai";
const ai = new OpenAI({ baseURL: `${process.env.ZAAFPULSE_URL}/v1`, apiKey: process.env.ZAAFPULSE_KEY });
const r = await ai.chat.completions.create({ model: "router/coding", messages: [{ role: "user", content: "Hi" }] });
```

- `stream: true` returns server-sent events, exactly as OpenAI does.
- Tools (`tools`, `tool_choice`) pass through to the provider.

## Other wire formats

Each one works with any provider; the gateway translates the request and the answer.

| Client style | Endpoint | Auth header |
|---|---|---|
| Anthropic Messages | `POST /v1/messages` (+ `/v1/messages/count_tokens`) | `x-api-key: $ZAAFPULSE_KEY` |
| OpenAI Responses | `POST /v1/responses` | `Authorization: Bearer` |
| Gemini | `POST /v1beta/models/<model>:generateContent`, `:streamGenerateContent?alt=sse`, `:countTokens` | `x-goog-api-key` |

- A model name the gateway does not know (such as `claude-sonnet-…` or `gpt-…-codex`) goes through the user's model map, then to their default code model.
- With a native Anthropic provider, `/v1/messages` passes through unchanged, so prompt caching and thinking still work.

## Token saver

Long tool results are shortened before they go upstream: diffs, logs, build and test output, grep results, file listings, large JSON. Error results are never touched.

To send one request untouched, add the header `x-zp-token-saver: off`.

## Embeddings

```bash
curl -s $ZAAFPULSE_URL/v1/embeddings -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"model":"ollama/nomic-embed-text","input":["first text","second text"]}'
```

## Good practice

- Keep prompts self-contained.
- Never put `ZAAFPULSE_KEY` in prompts or files you share.
- On 429, wait for `retry-after` once. On 502, report the error instead of retrying in a loop.
