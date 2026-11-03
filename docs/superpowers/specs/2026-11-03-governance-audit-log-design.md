# Governance audit log — design

Date: 2026-11-03. Status: approved by the owner ("jalankan sesuai urutan point 1 hingga 4"; standing instruction: follow
the controller's recommendations). AI Governance sub-project 2 of 4 (1: gateway guardrails, merged PR #63).

## Goal

One record of every change made to ZAAFPulse by a person or an API key: who, when, what, and the outcome, kept long
enough for an audit (at least 6 months), hard to alter without it showing, and exportable. Today nothing records
config, key, provider, guardrail, integration, budget, sign-in or approval changes with an actor; only MCP tool calls
and agent/runtime control are logged, in files that rotate away after 5 MB.

## Decisions

| # | Decision |
|---|---|
| A1 | New append-only log in monthly files `.data/audit/governance-YYYY-MM.jsonl` (mode 0600, folder 0700). Months are kept for `governance.audit.retentionMonths` (default 12, min 6, max 120); whole months older than that are deleted at start and once a day, and the pruning is itself an entry. No size rotation. |
| A2 | Tamper evidence: every entry carries `seq`, `prev` and `mac`. `mac = HMAC-SHA256(key, prev + "\n" + canonical JSON of the entry without mac)`; `prev` is the previous entry's `mac` (the chain runs across months; the first entry ever has `prev: "genesis"`). The key is a 32-byte secret in the existing secret store (`acc.audit-chain`), created on first use. When the store cannot hold it, the key lives in `.data/audit/chain.key` (0600) and entries say `keyed: "file"`. A verify pass reports the first broken `seq`. Deleting whole old months by retention is expected and verify starts from the oldest kept file. |
| A3 | Actor travels with the request through `AsyncLocalStorage` (Node built-in), set in `server.js` right after `auth.check(req)` and in the gateway's `authed()`: `{ via: 'dashboard', mode, device, ip }` (device = the signed `zp_known` id in password mode, null otherwise; ip from `clientKey`), `{ via: 'apikey', keyId }`, `{ via: 'cli' }`, `{ via: 'system' }` (scheduled passes, retention) or `{ via: 'rule', rule }` (Monitors auto-pause). Module routers need no new `req` parameter. |
| A4 | What is recorded (each one entry): (1) every non-GET dashboard request under `/api/*` and every gateway admin request, after the handler, with `action` = method + route with ids replaced by `:id`, plus the body's `action`/`op` field when it is a short word, `target` (`{ type, id, name }` when the route names one) and `outcome` (`ok`, `refused` 4xx, `error` 5xx, with the status); (2) a `config.change` entry for every config.json write through any writer (`saveConfigSections`, `lib/integration-config.js`), with field-level changes; (3) sign-in events: login ok, login failed, lockout, logout, local sign-in code used, password set (CLI); (4) approvals and cancels of collaboration runs from the dashboard, `/v1/runs/:id/resume|cancel` and A2A, with the key id; (5) agent and runtime control (mirrored from the existing `agent-audit.jsonl`, which stays); (6) `/api/trace/reveal` (a secret was shown); (7) key create, update, revoke, delete with the key's id and name; (8) retention pruning and audit-key creation. Request bodies are never copied, except the whitelisted short fields named here. |
| A5 | Field changes: `changes: [{ path, from, to }]`, paths like `gateway.guardrails.secrets`. A value whose path or key name looks secret (`key`, `token`, `secret`, `password`, `auth`, `header`, `apiKey`, `credential`, values that are secret references) is written as `"‹changed›"`; any other value is cut to 120 characters; arrays of objects are compared by their `id`/`name`; at most 50 changes per entry, then `truncated: n`. |
| A6 | When an entry cannot be written (disk full, permissions) the admin change itself still happens; the server keeps the failure in memory, the Governance page and `GET /api/governance/audit/status` show "degraded since …", and the new Monitors rule `audit_degraded` alerts. Changes made while degraded are counted and recorded as one `audit.gap` entry when writing works again. |
| A7 | Bug fix found while mapping: `GET /api/gateway/<route>` reaches `admin(route, 'GET')` for routes that write (`defaults` empties the default models, `settings` rewrites the section, `playground` runs a model). A GET on a write route now answers 405 and changes nothing. |
| A8 | `.cache/mcp-audit.jsonl` entries gain `keyId` when the call came through the gateway `/mcp` (the actor was missing). |
| A9 | API: `GET /api/governance/audit?from&to&actor&action&outcome&limit&before` (newest first, at most 500 per page), `GET /api/governance/audit/export?from&to&format=jsonl|csv` (CSV with the cost export's formula guard), `GET /api/governance/audit/verify` (`{ ok, checked, from, to, brokenAt?, reason? }`), `GET /api/governance/audit/status` (retention, months kept, size, degraded, last verify), `POST /api/governance/settings` (`{ audit: { retentionMonths } }`, 400 on a bad value). All dashboard-session only; none is on the gateway or MCP. |
| A10 | Dashboard: a new **Governance** menu with one page for now, **Audit log** (`#governance`): filters (range, actor kind, action text, outcome), a table (time, actor, action, target, outcome, changes on expand), Verify with its result, Export CSV/JSONL, and the retention setting. Sub-project 3 adds Inventory and Compliance pages to this menu. |
| A11 | Monitors: rule `audit_degraded` (aggregate, default on, triggers while writing fails) and a daily verify; a broken chain raises `audit_chain_broken` (default on). Neither auto-pauses; alerts carry no entry content. |
| A12 | Out of scope: per-request logging of gateway model calls (already in `gateway-usage.jsonl`), external anchoring of the chain (e.g. to a remote log), multiple users (sub-project 4 adds named actors). |

## Architecture

- `lib/governance/audit.js` (new): `createGovernanceAudit({ dir, getKey, now })` → `{ record(entry), list(q), export(q),
  verify(), status(), prune(retentionMonths) }`. Pure helpers in `lib/governance/chain.js` (canonical JSON, mac, verify a
  sequence) and `lib/governance/diff.js` (A5).
- `lib/governance/context.js` (new): the AsyncLocalStorage, `runAs(actor, fn)`, `actor()`.
- `server.js`: wrap authenticated requests in `runAs`; record A4(1) after the handler for non-GET; config writers emit
  A4(2); route the new `/api/governance/*` API; A7 fix in the gateway admin dispatch.
- `lib/auth.js`: emit sign-in events through an injected `onEvent`.
- `lib/gateway/index.js`: actor for key-authenticated requests; approvals/cancels and key changes (A4(4), A4(7)).
- `lib/agents/control.js`, `lib/runtimes/control.js`: forward their existing audit entries (A4(5)).
- `public/governanceview.js` (new, prefix `gov`/`GOV`), wired into the sidebar and `index.html`.
- Docs: `docs/governance.md` (what is recorded, the chain, verify, retention, export, degraded mode), README row.

## Error handling

| Case | Result |
|---|---|
| Entry write fails | change goes ahead; degraded state + `audit_degraded` alert; one `audit.gap` entry later (A6) |
| Unparsable line in a month file | verify reports it as broken at that seq; list skips it and counts it |
| Audit key missing after entries exist | verify reports `reason: 'key missing'`; a new key is not created silently over an existing chain (entries continue with `keyed` noted, chain restarts with `prev: "rekeyed"` and an `audit.rekey` entry) |
| Retention value out of range | 400, nothing written |
| GET on a write route of the gateway admin | 405, nothing changed |

## Testing

Unit: chain mac and verify (tamper with a field, delete a line, reorder, cross-month chain, retention deletion keeps
verify ok), diff masking and limits, retention pruning by month, list filters and paging, CSV formula guard. Integration
(spawned server on free ports, temp data dir, no network): a dashboard config change produces both entries with the
dashboard actor; a gateway key change; a failed login and lockout; a collaboration approval via API key carries the key
id; trace reveal is recorded; GET on `/api/gateway/defaults` is 405 and defaults are unchanged; a write failure flips
degraded and records `audit.gap` later; export and verify routes. UI string tests in the existing style.
