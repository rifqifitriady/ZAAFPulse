# Governance audit log

One record of the changes made to ZAAFPulse from the dashboard, its settings and sign-in, and of the changes an API
key makes to runs, knowledge bases and sessions: who, when, what, and the outcome (the list below says exactly what).
It is kept for at least six months, chained so that an edited or deleted line shows, and exportable. It lives in
`.data/audit/` next to your other data and never leaves the machine.

Open it under **Governance → Audit log** in the sidebar.

## What is recorded

| What | Action | Notes |
|---|---|---|
| Every change made from the dashboard (`POST`, `PUT`, `PATCH`, `DELETE` under `/api/`) | `POST /api/gateway/keys`, `POST /api/monitors/:id` … | the route with ids as `:id`, the body's `action`/`op` word (`op`), the target's id and name, the outcome and the HTTP status |
| Every write of `config.json`, from any settings page or the integrations editor | `config.change` | the changed fields as `{ path, from, to }`, secrets masked |
| Sign-in | `auth.login`, `auth.login_failed`, `auth.lockout`, `auth.logout`, `auth.local_code`, `auth.password_set` | the browser's known-device id (password mode) and its address; never a password or a cookie; `auth.logout` only when the request held a session |
| API keys | `key.create`, `key.update`, `key.revoke`, `key.delete` | the key's id and name; an update lists the fields that changed |
| Collaboration runs | `run.approve`, `run.reject`, `run.cancel` | from the dashboard, `/v1/runs/<id>/resume|cancel` and A2A, with the key that asked; an approval a key may not give is recorded as refused; a run id that is not id-shaped (`A-Z a-z 0-9 _ . : -`, at most 80) is left out of the target |
| Knowledge and sessions, with an API key | `knowledge.ingest`, `session.delete` | a document added through `POST /v1/knowledge/<kb>/documents` (the base's id, never the text) and a session deleted through `DELETE /v1/sessions/<id>`, with the key |
| Agent and runtime control | `agent.pause`, `agent.stop`, `runtime.start` … | mirrored from `.data/agent-audit.jsonl`, which stays; a rule's own pause names the rule |
| A secret shown in the Trace explorer | `trace.reveal` | which content and which mask, never the value |
| The log itself | `audit.key_created`, `audit.rekey`, `audit.prune`, `audit.gap` | see below |

Not recorded:

- read requests, including reads that travel as `POST`: polling or listing runs, reading a session, testing a provider,
  an integration or a second-brain source, listing a provider's models, reading or searching a knowledge base, the
  gateway logs and quota, and the previews `/api/evals/preview`, `/api/cost/settings/preview` and
  `/api/cost/restate/preview`;
- requests refused before sign-in, and a sign-out from a browser that held no session;
- gateway model calls (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, embeddings …), which are already in
  `gateway-usage.jsonl`;
- the work an API key starts (`/v1/agents/<id>/run`, `/v1/orchestrate`, `/v1/collaborate`, `/v1/workflows/<id>/run`,
  A2A tasks) and the sessions and memory that work writes; the runs are in the run store and the Trace explorer;
- MCP tool calls, which stay in `.cache/mcp-audit.jsonl`, whose lines now carry the `keyId` when the call came with an
  API key;
- changes made outside the server: a hand edit of `config.json` or of the data folder, and the CLI's commands other
  than `set-password`.

A request body is never copied; only the short fields named above are kept. `GET /api/gateway/<route>` is a 405 for
every route but `logs`, so a read cannot change anything there.

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
included: a token limit under a `token`, `key` or `auth` name shows as `‹changed›`. Booleans stay readable. So do
the guardrails modes at any `…guardrails.secrets` path (`gateway.guardrails.secrets`, or a key's own) and
`cost.keyCenters` (key ids). Other text is cut to 120 characters, after the credentials of a URL in it become
`scheme://‹changed›@host` (a password with an `@` in it included) and the values of its query parameters named
`api_key`, `apikey`, `key`, `token`, `access_token`, `secret`, `password`, `auth`, `signature` or `sig` become
`‹changed›`.

## The chain

Every entry has `seq` (1, 2, 3 … across months), `prev` (the `mac` of the entry before it; `genesis` for the very
first) and `mac` = HMAC-SHA256(key, `prev` + newline + the entry without `mac` as canonical JSON, keys sorted),
computed over the JSON as it is stored. Editing a field, deleting a line anywhere, moving one or writing a line that
does not parse breaks the chain at that entry. The oldest kept entry must be seq 1 (`genesis`) or the `keptFrom`
recorded by the latest prune, so deleting a whole month without a prune entry shows on verify too. Entry 1 of a log is
always `audit.key_created`. A torn last line left by a crash is dropped before the next entry is appended.

The key is 32 random bytes, made on the first entry, in the OS secret store as `acc.audit-chain` (the Keychain,
the keyring or the encrypted secret file, as for provider keys). When the store cannot hold it, it is
`.data/audit/chain.key` (mode 0600) and every entry says `"keyed": "file"`. Before the first key goes to the store,
ZAAFPulse checks that the store works with a probe item, `acc.audit-chain.probe`, which may stay in the store. A new
data folder that finds a key in the store already (another checkout or data folder of the same user) uses that key,
and its log still starts with `audit.key_created`.

What the chain protects depends on where the key is. With the key in the store, someone who can change the files in
`.data/audit/` but cannot read the store cannot edit, delete or move an entry unseen. With `chain.key`, whoever can
read the data folder can read the key too and rewrite the whole log; the chain then only shows changes made without
the key, such as a hand edit or a deleted line. Whoever can read the store's item can rewrite the log either way.

A store that does not give the key back never makes a new key while entries exist: a locked Keychain, a read that
fails, a secret the encrypted file cannot decrypt (`ZAAFPULSE_MASTER_KEY` changed or missing), or an item that holds
something other than a key. The log degrades (see below) and recovers when the store answers again; the first entry
written then is followed by a verify, so `audit_chain_broken` clears without waiting for the daily pass. Only a store
that shows it works (the probe item reads back) and still has no key on a second read counts the key as gone. While
the log is degraded every change still reads the store once (the probe and second read run at most once a minute):
the Linux keyring tool gives up after 5 seconds, but the macOS `security` read has no timeout, so a hung Keychain can
hold a change until it answers.

**Verify** (the button on the page, `GET /api/governance/audit/verify`, and once a day on its own) checks every kept
entry and answers `{ ok, checked, from, to }`, or `brokenAt` (the first seq that fails) and `reason`: `entry changed`,
`chain broken`, `sequence broken`, `unreadable line` or `key missing`. A running server also knows the last entry it
wrote, so lines cut from the end show as `sequence broken`. A log whose entry 1 is not `audit.key_created`, or is one
keyed in `chain.key` while the store holds a key, shows as `chain broken` at entry 1: that is a log written again from
scratch. The page shows the server's last result, whether it came from the button or the daily pass.

When the key is gone but entries exist (a restored data folder without its Keychain item), verify says `key missing`.
The next entry does not seal over the old chain: an `audit.rekey` entry with `prev: "rekeyed"` starts a new part with
a new key, which is kept in `.data/audit/chain.key`, never in the store. Each part is checked with the key it names
(`store` or `file`), so a part sealed with a key of someone's own vouches for nothing before it: the old part is
still checked with the old key whenever that key can be read (it comes back to the store, say). Entries whose key
cannot be read, including a part keyed in an older `chain.key` that a later rekey replaced, are counted as
`unverified` and still checked for their order. Whenever the kept log holds a rekey, verify reports the latest one
as `rekeyedAt` (its seq) and `rekeyedTs` (its time), and the page shows "The audit key was replaced at entry N (date).
Entries before it are checked only when the old key can still be read."

A rekey always alerts, through `audit_chain_broken` (below), because it is the one change to the chain that someone
who can write `.data/audit/` but not read the store can make look valid: a rekey of their own, sealed with a
`chain.key` of their own, lets them replace every entry after it. A genuine rekey (the key really went missing) alerts
the same way, so the owner can confirm it was one.

## Retention

The files are monthly: `.data/audit/governance-YYYY-MM.jsonl` (UTC months, mode 0600, folder 0700), with no size
rotation. A month is deleted once it ended more than `governance.audit.retentionMonths` months ago (default 12, never
below 6, at most 120). The `audit.prune` entry naming the months, and the `keptFrom` seq, is written before any month
is deleted; if a delete then fails, the log shows a broken sequence until the next pass finishes the job. Verify
starts from the oldest kept entry, which the latest prune entry vouches for, so pruning never breaks it.

Change it on the page or with `POST /api/governance/settings` `{ "audit": { "retentionMonths": 24 } }`; a value
outside 6 to 120 is a 400 and nothing is written (a body that is not JSON is a 415, one that is too large a 413). The
change is itself a `config.change` entry. A lowered retention takes effect at the next daily pass (every 24 hours from
start) or at a restart.

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

A full disk, a permission problem or a locked secret store never stops the change itself. The server remembers
since when writing fails and how many entries it missed (`missed` counts entries: a dashboard config change is two,
its `config.change` and its request); the page shows "Degraded since …", `GET /api/governance/audit/status` returns
`degraded: { since, missed }`, and the Monitors rule `audit_degraded` alerts. Once writing works again, one
`audit.gap` entry records how many entries were missed and since when, then the chain goes on.

## Monitors

- `audit_degraded` (on by default): triggered while entries cannot be written; its value is the number of entries
  missed.
- `audit_chain_broken` (on by default): triggered when the last verify failed; its value is the seq where the chain
  broke (0 when the key is missing) and its title the reason. Also triggered, titled `rekeyed` with the rekey's seq,
  while the chain holds a rekey whose entry is less than 7 days old: one alert per rekey, which clears after 7 days
  unless the chain is otherwise broken.

Neither pauses anything, and neither alert carries anything from an entry.

## API

All behind the dashboard sign-in; no gateway key or MCP client reaches them.

| Route | What |
|---|---|
| `GET /api/governance/audit?from&to&actor&action&outcome&limit&before` | entries, newest first, at most 500 per page (default 100); `from`/`to` are `YYYY-MM-DD` (a UTC day; `to` is the end of it) or ISO times with a zone (`Z` or `+07:00`), `actor` a kind (`dashboard`, `apikey`, `cli`, `system`, `rule`) or a key id, `action` text found in the action or its `op`; the answer is `{ entries, next, skipped }` (`next` is the `before` of the next page, `skipped` counts unreadable lines) |
| `GET /api/governance/audit/export?from&to&format=jsonl\|csv` | a download |
| `GET /api/governance/audit/verify` | `{ ok, checked, from, to, brokenAt?, reason?, unverified?, rekeyedAt?, rekeyedTs? }` |
| `GET /api/governance/audit/status` | `{ retentionMonths, months: [{ month, bytes }], bytes, degraded, lastVerify }` |
| `POST /api/governance/settings` | `{ "audit": { "retentionMonths": n } }` (6 to 120; JSON only: 415 otherwise, 413 for a body that is too large) |

A bad query value is a 400 that names it, as `limit: a whole number from 1 to 500`.

## Known limits

- One person per dashboard: entries say `dashboard`, the sign-in mode, the device and the address, not a name.
  Named users come with a later sub-project.
- The chain is anchored nowhere outside this machine. Someone with the key and the files can rewrite both.
- Someone who can write `.data/audit/` but not read the store can still cut the chain at an entry of their choosing:
  an `audit.rekey` of their own, sealed with a `chain.key` of their own, and entries of their own after it. What comes
  before the cut is still checked with the store's key and cannot be changed unseen; what came after it can be
  replaced. Such a rekey alerts (`audit_chain_broken`, `rekeyed`) and shows on the page; one while the store still
  holds its key is worth a look. The alert's 7 days count from the time the rekey entry gives, which its writer
  chose.
- Removing the whole log while the server is stopped is caught only by the rule for entry 1: a log written again by
  hand shows (its entry 1 is not `audit.key_created`, or is keyed in `chain.key` while the store holds a key). A folder
  emptied and left for the server to start over is not caught: the new log begins with its own `audit.key_created`,
  as a first start does. While the server runs, the last entry it wrote catches it.
- A log whose first key went to `chain.key` because the store was locked at that moment, while the store held a key
  (another data folder's), reports `chain broken` at entry 1 once the store answers: it looks like a rewrite.
- The degraded state (`since`, `missed`) is kept in memory: a restart while degraded loses it, so no `audit.gap`
  entry records the entries missed before the restart.
- `zaafpulse set-password` leaves its event in `.data/audit/pending/`; it becomes an entry when the server starts or
  runs its daily pass.
- The server is the only writer: one data folder is served by one server process. Two servers on one folder would each
  continue the chain from where they last saw it.
- Lines cut from the end of the newest month while the server was stopped hold together as a chain; only a running
  server notices them (it knows the last entry it wrote).
