# Gateway guardrails

The Agent Gateway checks what it sends to a provider or an integration before it leaves the machine. Three checks run on every gateway path under one policy: **secrets** (API keys, tokens, private keys, database passwords), **personal data** (emails, phone numbers, IP addresses) and **prompt injection** in new input. Each check can be off, only counted, redacted or blocked. Set the policy under **Agent Gateway → Model router → Guardrails**; a key can set its own modes under **Endpoint → API keys**.

## The checks

| Check | What it finds | Modes |
|---|---|---|
| `secrets` | Anthropic, OpenAI, OpenRouter, AWS, GitHub, Slack, Google, Stripe and Hugging Face keys, JSON Web Tokens, private keys and database URLs with a password: the same detector as the Quality page's secrets. Documentation placeholders (`sk-xxxx…`, `your-key`) are ignored. | `off`, `log`, `redact`, `block` |
| `pii` | Email addresses, phone numbers (9 to 15 digits with a leading `+`, an area code in brackets, or 3 to 5 groups split by dashes) and IP addresses (not `127.0.0.1`, `0.0.0.0` or `::1`). The user name in home-folder paths is **never touched**: coding agents send real paths and would then call their tools with paths that do not exist. | `off`, `log`, `redact`, `block` |
| `injection` | Instruction override, persona hijack, requests to send or reveal secrets, hide-from-user instructions, fake role tags and fake authority: the same detector as the Quality page's poisoning detections. Text that only quotes attacks is left out. | `off`, `log`, `block` (there is nothing to redact) |

`secrets` and `pii` scan the whole body that will be sent. `injection` scans only the **new input**: everything after the last assistant message (an assistant message in OpenAI and Anthropic requests; in Responses requests also a function call or another item the model produced), or the whole input when there is none. A trailing assistant item (a prefill) is ignored when finding that last assistant message. History already sent is not flagged again on every turn.

The checks read text only. Model names, roles, ids, tool names and `stop` sequences are skipped. So are images and other binary data (`b64_json`, `image_url`, `inline_data`, `data` under a `type: base64` parent, and base64 data URLs of the form `data:<mime>;base64,…`; any other string that starts with `data:` is checked) and the opaque tokens a provider must get back unchanged (a thinking `signature`, `encrypted_content`). Thinking, redacted thinking and reasoning blocks (`type` `thinking`, `redacted_thinking`, `reasoning`) are signed model output and pass through unchanged. MCP tool arguments skip no key at all: a tool may call a field `name` or `id`.

## Modes

| Mode | What happens |
|---|---|
| `off` | Not checked. |
| `log` | Sent as it is; the request is counted as **flagged** and its usage entry names what was found. |
| `redact` | Replaced before it is sent; the request is counted as **redacted**. |
| `block` | Refused with HTTP 400; nothing is sent. The request is counted as **blocked**. |

Redaction is deterministic: the same text always becomes the same placeholder, so a provider's prompt cache stays valid from one turn to the next.

| Found | Becomes |
|---|---|
| a secret | `‹secret: <label>›`, for example `‹secret: Anthropic API key›` |
| a database URL with a password | the password only: `postgres://app:‹secret: Database URL with password›@db.internal:5432/app` keeps its host |
| a private key | the whole block, from its `BEGIN` line to its `END` line (to the end of the text when the `END` line is missing) |
| an email, phone number or IP address | `‹email›`, `‹phone›`, `‹ip›` |

## Defaults and scope

| Setting | Default |
|---|---|
| `secrets` | `redact` |
| `pii` | `off` |
| `injection` | `log` |
| `scope` | `external` |

**Scope** `external` checks only calls to an external provider (one you approved under Providers); calls to a private provider on your own hardware (Ollama, LM Studio, vLLM, TGI…) are not checked, since nothing leaves the machine. Scope `all` checks every call. In a route with fallback targets each target is checked for its own tier, so a private first target gets the request as it was and an external fallback gets it redacted.

**Per key.** A key may set any of the three modes; a mode it leaves on `default` comes from the policy. A key that sets its own shows an **own guardrails** chip in the key list. Scope is set for the whole gateway only. No request header turns the guardrails off (unlike the token saver's `x-zp-token-saver: off`).

## Where it applies

| Path | What is checked |
|---|---|
| `POST /v1/chat/completions` | the OpenAI body sent to each route target |
| `POST /v1/messages` | the Anthropic body sent to a native Anthropic provider, or the translated OpenAI body |
| `POST /v1/messages/count_tokens` | the body sent to a native Anthropic provider; when the guardrails would block it, the estimate answers and nothing is sent |
| `POST /v1/responses` | the Responses body sent to a provider that speaks it, or the translated OpenAI body |
| `POST /v1beta/models/<m>:generateContent` · `:streamGenerateContent` | the translated OpenAI body |
| `POST /v1/embeddings`, knowledge-base embeddings | the `input` sent to the embedding model |
| agents, the orchestrator, collaboration runs, workflows, the Playground, the evals judge and dataset replay | every model call they make through the gateway |
| `POST /mcp` `tools/call` | the arguments get `secrets` and `pii` before they reach the integration; the tool result (its text parts and embedded resource text) gets `injection` (block: the result becomes a tool error). The local `acc` integration (ZAAFPulse's own data) counts as private |

Not checked: what providers answer (secrets in agent output are already found by the log scanner and the `unsafe_content` monitor).

## What is recorded

Each usage entry of a checked call that found something carries `guard: { action, hits }`: `action` is `redacted`, `blocked` or `logged`, and `hits` is a list of `{ check, label, count }`, for example `{ "check": "secrets", "label": "GitHub token", "count": 1 }`. Never the matched text, never a snippet. A blocked request is recorded with status 400, `error: "blocked by guardrails"` and no tokens. An MCP tool call is recorded (kind `mcp`, the tool as its model) only when a check found something. An answer from the integration of the form `{ error }` is recorded as status 502 `integration error`, a result with `isError` as status 200 `tool error`; a blocked result records the argument hits and the injection hits together.

The Guardrails panel shows this month's requests **redacted**, **blocked** and **flagged**. Each row of **Recent requests** on the gateway Overview has a chip with the action, and the labels in its tooltip. The Monitors rule `guardrail_block` (on by default) alerts when one or more requests were blocked in the last 60 minutes; the alert carries the count and the check names only ([docs/monitors.md](monitors.md#rules)).

## Reading a block

A blocked request answers HTTP 400 in the caller's own error format, with type `invalid_request_error` and code `guardrail_blocked`. The message names the check and the labels, never the value:

```
Blocked by ZAAFPulse guardrails: secret (Anthropic API key). Remove it, or ask the owner to change the policy.
```

| Format | Body |
|---|---|
| OpenAI chat, Responses, embeddings | `{ "error": { "message": "…", "type": "invalid_request_error", "code": "guardrail_blocked" } }` |
| Anthropic | `{ "type": "error", "error": { "type": "invalid_request_error", "message": "…", "code": "guardrail_blocked" } }` |
| Gemini | `{ "error": { "code": 400, "message": "…", "status": "INVALID_ARGUMENT", "details": [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "guardrail_blocked", "domain": "zaafpulse" }] } }` |
| MCP arguments | JSON-RPC error `-32602` with the message |
| MCP result | a tool result with `isError: true` and the message |

Agents, workflows and the Playground get the same message as their error.

**Fail closed.** When a check itself fails and its mode is `redact` or `block`, the request is refused with HTTP 500 `guardrails failed` and nothing is sent. A check in `log` mode that fails lets the request through; its usage entry gets `guard.error: true`.

## Settings and API

The policy is `gateway.guardrails` in `config.json`:

```json
{ "gateway": { "guardrails": { "scope": "external", "secrets": "redact", "pii": "off", "injection": "log" } } }
```

A field that is missing or not allowed counts as its default. The Guardrails panel saves through `POST /api/gateway/settings` with `{ "guardrails": { … } }` (any of the four fields); a value that is not allowed is refused with HTTP 400 and nothing is written. `GET /api/gateway` returns the policy in use as `settings.guardrails` and this month's counts as `usage.totals.guard` (`{ redacted, blocked, logged }`). A key's modes are `guardrails: { secrets?, pii?, injection? }` on `POST /api/gateway/keys` (`create` and `update`); an empty value means the policy's.

## Known limits

- The detectors are patterns. A secret type they do not know, a password outside a database URL, or personal data other than emails, phone numbers and IP addresses is not found. Prompt injection detection is a heuristic with measured precision and recall ([docs/quality-metrics.md](quality-metrics.md)).
- Provider responses are not checked. The log scanner and the `unsafe_content` monitor cover what agents output.
- Tool calls that agents make to integrations from inside the gateway (the orchestrator's function calling) are not checked; only `POST /mcp` from a client is.
- Only string values are scanned. Object keys and non-string values (numbers, booleans) are not.
- The OpenAI message `name` field and other structural fields (`model`, `role`, `type`, `id`, `tool_choice`, `stop`, keys ending in `_id`) are not scanned.
- MCP `resource_link` descriptions and `structuredContent` are not scanned; the injection check reads text parts and embedded resource text only.
- Text inside a JSON string that is itself inside the body (a tool call's `arguments`) is checked as it is written there: a key right after an escaped `\n` may not be found.
- Home-folder user names are never touched, even with `pii` on.
- Redacted secrets reach the model as placeholders, so an agent may write a placeholder back into a file.
