# Governance audit log

One record of every change made to ZAAFPulse by a person or an API key: who, when, what, and the outcome. It is kept
for at least six months, chained so that an edited or deleted line shows, and exportable. It lives in
`.data/audit/` next to your other data and never leaves the machine.

Open it under **Governance → Audit log** in the sidebar.

## What is recorded

| What | Action | Notes |
|---|---|---|
| Every change made from the dashboard (`POST`, `PUT`, `PATCH`, `DELETE` under `/api/`) | `POST /api/gateway/keys`, `POST /api/monitors/:id` … | the route with ids as `:id`, the body's `action`/`op` word (`op`), the target's id and name, the outcome and the HTTP status |
| Every write of `config.json`, from any settings page or the integrations editor | `config.change` | the changed fields as `{ path, from, to }`, secrets masked |
| Sign-in | `auth.login`, `auth.login_failed`, `auth.lockout`, `auth.logout`, `auth.local_code`, `auth.password_set` | the browser's known-device id (password mode) and its address; never a password or a cookie |
| API keys | `key.create`, `key.update`, `key.revoke`, `key.delete` | the key's id and name; an update lists the fields that changed |
| Collaboration runs | `run.approve`, `run.reject`, `run.cancel` | from the dashboard, `/v1/runs/<id>/resume|cancel` and A2A, with the key that asked; an approval a key may not give is recorded as refused |
| Agent and runtime control | `agent.pause`, `agent.stop`, `runtime.start` … | mirrored from `.data/agent-audit.jsonl`, which stays; a rule's own pause names the rule |
| A secret shown in the Trace explorer | `trace.reveal` | which content and which mask, never the value |
| The log itself | `audit.key_created`, `audit.rekey`, `audit.prune`, `audit.gap` | see below |

Not recorded: read requests, including reads that travel as `POST` (polling a run, testing a provider or an
integration, listing its models, searching a knowledge base, and the previews `/api/evals/preview`,
`/api/cost/settings/preview` and `/api/cost/restate/preview`); requests refused before sign-in; and gateway model
calls, which are already in `gateway-usage.jsonl`. A request body is never copied; only the short fields named above
are kept. `GET /api/gateway/<route>` is a 405 for every route but `logs`, so a read cannot change anything there. MCP tool calls stay in
`.cache/mcp-audit.jsonl`, whose lines now carry the `keyId` when the call came with an API key.

### Who acted

| `actor.via` | Fields | When |
|---|---|---|
| `dashboard` | `mode` (`local`, `password` or `none`), `device` (password mode: the browser's known-device id), `ip` | a signed-in dashboard request |
| `apikey` | `keyId` | a gateway request with a ZAAFPulse API key, and everything it starts |
| `cli` | none | `zaafpulse set-password` (recorded when the server next starts) |
| `system` | none | ZAAFPulse itself: retention, the key, a gap, background work |
| `rule` | `rule` | a Monitors rule that paused an agent |

### An entry

One JSON object per line, for example:

```json
{"seq":42,"ts":"2026-11-03T09:12:40.118Z","action":"config.change","actor":{"via":"dashboard","mode":"local","device":null,"ip":"127.0.0.1"},"outcome":"ok","target":{"type":"config","id":"gateway"},"changes":[{"path":"gateway.guardrails.secrets","from":"redact","to":"block"}],"prev":"5f0c…","mac":"a91e…"}
```

`outcome` is `ok`, `refused` (a 4xx, or an admin answer with `errors`) or `error` (a 5xx). A change list holds at most
50 changes, then `truncated` says how many more there were. A value under a key that looks secret (`key`, `token`,
`secret`, `password`, `auth`, `header`, `credential`) or a secret reference is written as `‹changed›`, numbers
included: a token limit under a `token`, `key` or `auth` name shows as `‹changed›`. Booleans stay readable. So do the
guardrails modes at any `…guardrails.secrets` path (`gateway.guardrails.secrets`, or a key's own) and `cost.keyCenters`
(key ids). Other text is cut to 120 characters, and the credentials of a URL in it become `scheme://‹changed›@host`.

## The chain

Every entry has `seq` (1, 2, 3 … across months), `prev` (the `mac` of the entry before it; `genesis` for the very
first) and `mac` = HMAC-SHA256(key, `prev` + newline + the entry without `mac` as canonical JSON, keys sorted), computed over
the JSON as it is stored. Editing a field, deleting a line anywhere, moving one or writing a line that does not parse
breaks the chain at that entry. The oldest kept entry must be seq 1 (`genesis`) or the `keptFrom` recorded by the
latest prune, so deleting a whole month without a prune entry shows on verify too. A torn last line left by a crash is
dropped before the next entry is appended.

The key is 32 random bytes, made on the first entry, in the OS secret store as `acc.audit-chain` (the Keychain,
the keyring or the encrypted secret file, as for provider keys). When the store cannot hold it, it is
`.data/audit/chain.key` (mode 0600) and every entry says `"keyed": "file"`. Before the first key goes to the store,
ZAAFPulse checks that the store works with a probe item, `acc.audit-chain.probe`, which may stay in the store. Whoever
can read the key can rewrite the whole log: the chain shows changes made without it, such as a hand edit or a deleted
line.

A locked or unreadable store never makes a new key while entries exist: the log degrades (see below) and recovers when
the store answers again. While it is degraded, each change may wait up to one store read timeout.

**Verify** (the button on the page, `GET /api/governance/audit/verify`, and once a day on its own) checks every kept
entry and answers `{ ok, checked, from, to }`, or `brokenAt` (the first seq that fails) and `reason`: `entry changed`,
`chain broken`, `sequence broken`, `unreadable line` or `key missing`. A running server also knows the last entry it wrote, so
lines cut from the end show as `sequence broken`.

When the key is gone but entries exist (a restored data folder without its Keychain item), verify says `key missing`.
The next entry does not seal over the old chain: an `audit.rekey` entry with `prev: "rekeyed"` starts a new part with
a new key, which is kept in `.data/audit/chain.key`, never in the store. Verify then checks the new part and reports how many older entries it could not check (`unverified`).

## Retention

The files are monthly: `.data/audit/governance-YYYY-MM.jsonl` (UTC months, mode 0600, folder 0700), with no size
rotation. A month is deleted once it ended more than `governance.audit.retentionMonths` months ago (default 12, never
below 6, at most 120). The `audit.prune` entry naming the months, and the `keptFrom` seq, is written before any month
is deleted; if a delete then fails, the log shows a broken sequence until the next pass finishes the job. Verify
starts from the oldest kept entry, which the latest prune entry vouches for, so pruning never breaks it.

Change it on the page or with `POST /api/governance/settings` `{ "audit": { "retentionMonths": 24 } }`; a value
outside 6 to 120 is a 400 and nothing is written. The change is itself a `config.change` entry. A lowered retention
takes effect at the next daily pass (every 24 hours from start) or at a restart.

## The daily pass

At start and every 24 hours the server imports the events the CLI left, prunes the months past the retention and
verifies the chain. Each step runs on its own, so one that fails never skips the others; a failure is logged by its
code only. A pending file that is not valid is dropped without being recorded.

## Export

**Export CSV** and **Export JSONL** download the entries of the chosen range (`GET
/api/governance/audit/export?from&to&format=csv|jsonl`), oldest first. JSONL lines are byte for byte what the log
holds, so a copy can be verified with the same key. The CSV has one line per entry (`seq, time, actor, actor_id, ip,
action, op, target_type, target_id, target_name, outcome, status, changes, prev, mac`); a cell that starts with `=`,
`+`, `-`, `@`, a tab or a carriage return gets a leading `'`, as the cost export does. At most 100,000 entries per
export (413 beyond: narrow the range).

## When an entry cannot be written

A full disk, a permission problem or a locked secret store never stops the change itself. The server remembers since when writing fails and
how many entries it missed; the page shows "Degraded since …", `GET /api/governance/audit/status` returns
`degraded: { since, missed }`, and the Monitors rule `audit_degraded` alerts. Once writing works again, one
`audit.gap` entry records how many entries were missed and since when, then the chain goes on.

## Monitors

- `audit_degraded` (on by default): triggered while entries cannot be written; its value is the number missed.
- `audit_chain_broken` (on by default): triggered when the last verify failed; its value is the seq where the chain
  broke (0 when the key is missing) and its title the reason.

Neither pauses anything, and neither alert carries anything from an entry.

## API

All behind the dashboard sign-in; no gateway key or MCP client reaches them.

| Route | What |
|---|---|
| `GET /api/governance/audit?from&to&actor&action&outcome&limit&before` | entries, newest first, at most 500 per page (default 100); `from`/`to` are `YYYY-MM-DD` (UTC) or ISO times, `actor` a kind (`dashboard`, `apikey`, `cli`, `system`, `rule`) or a key id, `action` text found in the action or its `op`; the answer is `{ entries, next, skipped }` (`next` is the `before` of the next page, `skipped` counts unreadable lines) |
| `GET /api/governance/audit/export?from&to&format=jsonl\|csv` | a download |
| `GET /api/governance/audit/verify` | `{ ok, checked, from, to, brokenAt?, reason?, unverified?, rekeyedAt? }` |
| `GET /api/governance/audit/status` | `{ retentionMonths, months: [{ month, bytes }], bytes, degraded, lastVerify }` |
| `POST /api/governance/settings` | `{ "audit": { "retentionMonths": n } }` (6 to 120) |

A bad query value is a 400 that names it, as `limit: a whole number from 1 to 500`.

## Known limits

- One person per dashboard: entries say `dashboard`, the sign-in mode, the device and the address, not a name.
  Named users come with a later sub-project.
- The chain is anchored nowhere outside this machine. Someone with the key and the files can rewrite both.
- `zaafpulse set-password` leaves its event in `.data/audit/pending/`; it becomes an entry when the server starts or
  runs its daily pass.
- The server is the only writer: one data folder is served by one server process. Two servers on one folder would each
  continue the chain from where they last saw it.
- Lines cut from the end of the newest month while the server was stopped hold together as a chain; only a running
  server notices them (it knows the last entry it wrote).
