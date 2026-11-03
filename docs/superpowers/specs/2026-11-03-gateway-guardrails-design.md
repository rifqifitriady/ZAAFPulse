# Gateway guardrails — design

Date: 2026-11-03. Status: approved by the owner ("jalankan sesuai urutan point 1 hingga 4"; standing instruction: follow
the controller's recommendations).

## Program context: AI Governance

The governance review of v1.0.4 found that the gateway enforces access and cost, but no content: prompt injection,
secret leaks and personal data are only found after the fact in agent logs, and only alert. The owner approved four
sub-projects, in this order, each with its own spec, plan and pull request:

1. **Gateway guardrails** (this spec): content checks on what the gateway sends to providers and integrations.
2. **Governance audit log**: every admin and config change, a hash chain, retention of at least 6 months, export.
3. **AI inventory and Governance page**: discovered MCP servers and AI tools with owner, purpose and risk tier;
   evidence mapped to EU AI Act Art. 12 and 14, NIST AI RMF and ISO/IEC 42001 Annex A.
4. **Users, roles and SSO** for the dashboard.

## Goal

Stop secrets and, when the owner wants it, personal data from leaving the machine through the gateway, and catch
prompt injection arriving in new input, with one policy that applies to every gateway path.

## Decisions

| # | Decision |
|---|---|
| D1 | Three checks: `secrets`, `pii`, `injection`. Modes: `secrets` and `pii` take `off`, `log`, `redact` or `block`; `injection` takes `off`, `log` or `block` (there is nothing to redact). |
| D2 | Defaults: `secrets: redact`, `pii: off`, `injection: log`, `scope: external`. |
| D3 | Scope `external` (default) checks only calls to an external provider tier; calls to private providers (own hardware) are not checked, since nothing leaves the machine. Scope `all` checks every call. |
| D4 | Per-key override: a key may set any of the three modes; a mode it does not set comes from the global setting. Scope is global only. |
| D5 | No request header turns guardrails off (unlike the token saver). |
| D6 | `secrets` and `pii` scan the whole upstream body. `injection` scans only the new input: everything after the last assistant message (in OpenAI, Anthropic and Responses shapes), or the whole input when there is none. History already sent is not re-flagged on every turn. |
| D7 | Redaction is deterministic: the same text always becomes the same placeholder, so provider prompt caches stay valid. Secrets become `‹secret: <label>›` (label from `lib/signals.js` SECRETS, e.g. `‹secret: Anthropic API key›`); a database URL keeps its host and only the password is replaced. Personal data becomes `‹email›`, `‹phone›` or `‹ip›`. |
| D8 | Gateway PII checks email, phone and IP only. The user name in home-folder paths is NOT touched: coding agents send real paths and would then call tools with paths that do not exist. `maskPii` gets an option to leave home folders alone; the judge path keeps its current behaviour. |
| D9 | Block answers HTTP 400 in the caller's format (OpenAI, Anthropic, Responses, Gemini error shape) with type `invalid_request_error` and code `guardrail_blocked`. The message names the check and the labels, never the value: `Blocked by ZAAFPulse guardrails: secret (Anthropic API key). Remove it, or ask the owner to change the policy.` |
| D10 | Fail closed: when a check throws and its mode is `redact` or `block`, the request is refused with 500 `guardrails failed` and nothing is sent upstream. A check in `log` mode that throws lets the request through. |
| D11 | What is recorded: on the usage entry, `guard: { action, hits }` where `action` is `redacted`, `blocked` or `logged` and `hits` is a list of `{ check, label, count }`. Never the matched text, never a snippet. A blocked request is recorded with status 400 and `error: 'blocked by guardrails'`. |
| D12 | The gateway `/mcp` endpoint is covered: `tools/call` arguments get the `secrets` and `pii` checks before they reach an integration, and the tool result gets the `injection` check (`block` turns the result into a tool error). The local `acc` integration (ZAAFPulse's own data) is outside scope `external`. |
| D13 | Out of scope for this sub-project: checking provider responses (secrets in agent output are already found by the log scanner and the `unsafe_content` monitor), the admin audit log (sub-project 2), and the Governance page (sub-project 3). |
| D14 | New Monitors rule `guardrail_block`: aggregate, default on, triggers when one or more requests were blocked in the last 60 minutes; never auto-pauses; the alert carries counts and check names only. |

## Architecture

### `lib/gateway/guardrails.js` (new, pure)

```
resolvePolicy(globalCfg, key) -> { secrets, pii, injection, scope }
inScope(policy, tier) -> boolean                      // tier: 'private' | 'external'
checkBody(body, policy, { format }) -> { body, action, hits }   // throws GuardrailBlock on block
checkText(text, policy, { part }) -> { text, action, hits }     // for MCP arguments and results
class GuardrailBlock extends Error { hits }
```

- `format` is the upstream body shape: `openai-chat`, `anthropic`, `responses`, `embeddings`.
- The body walker visits string leaves only. It skips structural keys (`model`, `role`, `type`, `id`, keys ending in
  `_id`, `name`, `tool_choice`, `stop`) and binary fields (`data`, `b64_json`, `image_url`, `inline_data`, `source.data`,
  strings starting with `data:`). It returns a new body; the input object is never changed.
- `injection` uses `scanInjection` from `lib/signals.js` on the new-input part (D6). `secrets` uses `secretSpans` for
  redaction and the same labels for counting. `pii` uses `maskPii(text, { home: false })` from `lib/evals/pii.js`,
  extended to report counts per kind.
- Cost: a 1 MB body is checked in under 50 ms on the CI machines (test with a generous bound).

### Gateway wiring (`lib/gateway/index.js`)

One helper, `guard(body, { key, target, format })`, is called right before every upstream call with the body that will
be sent, per route target (a fallback target can have a different tier):

- `callChat` callers: `proxyChat` (OpenAI, and the translated Anthropic, Responses and Gemini paths) and `llm` (agents,
  planner, collaboration, workflows, dataset replay).
- `anthropicPassthrough`, `responsesPassthrough`, `embeddings`.

A `GuardrailBlock` becomes the 400 of D9 in the caller's format, and is recorded (D11). The guard result's `hits` are
attached to the usage entry of the call that was sent.

### Settings and API

- Config: `gateway.guardrails = { scope, secrets, pii, injection }`, written through the existing gateway settings
  route (`route === 'settings'`), validated, unknown values refused with 400.
- Keys: `cleanKeyInput` accepts `guardrails: { secrets?, pii?, injection? }`; an empty value means inherit.
- The gateway status payload gains `settings.guardrails` and `usage.totals.guard = { redacted, blocked, logged }` for
  the month.

### Dashboard

- **Agent Gateway → Model router**: a "Guardrails" panel next to Token saver: scope and the three modes as selects,
  Save, and three tiles for this month (requests redacted, blocked, flagged; "flagged" is the `logged` action). One line under it says what each mode does
  and that home-folder paths are never touched.
- **Endpoint → API keys**: the key form gets three selects (`default` plus the modes); the key list shows a chip when a
  key overrides the policy.
- **Gateway request rows** (where usage entries are listed): a chip `redacted`, `blocked` or `flagged` with the check
  labels in its title.

### Monitors

`guardrail_block` in `lib/monitors/rules.js` (D14), reading the gateway usage entries of the window.

## Error handling

| Case | Result |
|---|---|
| A check finds something in `block` mode | 400 `guardrail_blocked` in the caller's format; recorded; nothing sent |
| A check throws in `redact`/`block` mode | 500 `guardrails failed`; nothing sent (D10) |
| A check throws in `log` mode | request goes on; `guard.error: true` on the entry |
| Bad `gateway.guardrails` in config.json | treated as the defaults (D2); the settings route refuses bad input with 400 |
| MCP argument blocked | JSON-RPC error `-32602` with the D9 message; result blocked → tool result `isError: true` with the D9 message |

## Testing

- Unit tests for `guardrails.js`: policy resolution and key override, scope, every mode of every check, deterministic
  placeholders, database URL keeps host, home paths untouched, new-input split in all three shapes, binary and
  structural keys skipped, body not mutated, block carries labels and never values, the 1 MB bound.
- Gateway tests (fake fetch, no network): redaction reaches the upstream body on chat, Anthropic passthrough, Responses
  passthrough, embeddings and `llm`; a private target is not checked under scope `external`; block returns the format's
  error shape and sends nothing; fail-closed; usage entry carries `guard` with no matched text.
- MCP tests: arguments redacted or blocked, result injection blocked.
- Monitors test for `guardrail_block`. Settings and key validation tests. UI string tests in the style of the existing
  `gatewayview` tests.

## Documentation

New `docs/guardrails.md` (what each check finds, modes, scope, what is recorded, how to read a block); a Features row and
a link in README; the API table notes the new settings fields.
