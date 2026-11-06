# Dashboard users and roles

The owner can give other people their own sign-in to the dashboard: an auditor who reads the Governance pages and
exports evidence, a manager who reviews the AI inventory and approves agent runs. Nobody shares the admin password, and
every change made from the dashboard is recorded under the person who made it. Accounts are local to this ZAAFPulse:
there is no single sign-on and no second factor.

## Roles

| Role | May |
|---|---|
| **owner** | everything, as before. The admin password signs in as the owner. |
| **reviewer** | everything a viewer may, plus inventory reviews (**Governance → Inventory**, `POST /api/governance/inventory`), the owner suggestions for them (`GET /api/users/names`) and collaboration run approvals (`POST /api/gateway/collab` with `action` `get`, `list` or `resume`). |
| **viewer** | read-only: counts, costs, states, names and settings, never a transcript, a prompt, a note or a secret (the exceptions are listed below). The Overview, costs, quality, the logs, the Trace explorer's session list (without titles), the evals' summary, status, evaluators and settings, the dataset and experiment lists, monitors and alerts, runtimes, the integrations' status, the gateway (redacted, below), the OpenRouter model catalogue, and the Governance pages with the audit log, its export and verification, the inventory, the controls and the evidence export. |

Only the owner may do these, for a reviewer and a viewer alike:

- In the Trace explorer: a session's content, title or live view, a secret's reveal, and a title search (the session
  list comes without titles and branches).
- Evals: a session's results (`GET /api/evals`, which carry the judge's explanations) and the preview.
- Datasets and experiments: a dataset's or an experiment's details and exports.
- Feedback notes, the second brain and the vault.
- The integrations' settings (their config).
- The gateway: reading or searching a knowledge base, reading a gateway session, provider quotas, the provider test
  and model lists.
- The OpenRouter account (credits and key); the catalogue is allowed.
- The agents' candidates (`GET /api/agents/candidates`).
- Every setting and every action not named above.

The rule is **deny by default**: the server checks each `/api` request of a reviewer or a viewer against an explicit
list per role (`lib/users/policy.js`), and anything not listed, including a path that is not in its plain form, is
`403 { "error": "your role cannot do this" }`, recorded in the audit log as refused (a read included). The owner is
never restricted.

### What a reviewer or a viewer sees redacted

These views are rebuilt from an allow-list of fields, so a field added later stays hidden until it is listed.

- **Summary** (`/api/summary`): counts, costs, models and tools stay; the quality events lose their text (a typed
  correction, a risky command, an error snippet) and no session or project carries a path or a branch.
- **Logs** (`/api/logs`): requests keep model, tokens, timings and status, and inputs and blocks by type, tool and
  size; the error lines keep type, label and time, never the text.
- **Gateway** (`GET /api/gateway`): agents without their system prompt, memory notes without their text, sessions
  without their title, runs without their task, error or approval question, API keys with only their id, name,
  prefix, scopes, budget and dates, providers without a secret reference (and only their sign-in type), workflows
  without their step prompts, no skill folders and no quota. A reviewer reads a run with its text through `collab get`
  and `list`: they must read what they approve.
- **Gateway logs** (`/api/gateway/logs`): no error text and no ids of runs or sessions.
- **Config** (`/api/config`): the name, the monthly budget and the pricing, without the vault folders.
- **Trace sessions**: no titles, no branches, and no title search.
- **AI Office** (`/api/office`): each agent's state, zone, tool, project name, model and counts; its current activity
  and its feed by tool only (no file name, command or host), and no git branch.
- **Timeline** (`/api/timeline`): the lanes with their times, zones and tools; every tool segment's target (a file
  name, a command or a host) is blank.
- **Local models** (`/api/runtimes/config`): each entry's name, port and state; `command`, `health` and `healthUsed`
  are `null` in every sign-in mode (a command line or a health URL can hold a path or a token).
- **Integrations** (`/api/integrations`): each integration's state, counts and latency, without its error text; the AI
  clients without their config file's path; no MCP command line.
- **Router proxy log** (`/api/router?section=proxy`): status, provider and timings, without the target URL or the
  error text.
- **Inventory** (`GET /api/governance/inventory`): the items, their names, reviews and counts, without the project
  folders an MCP server is set up in or the AI clients' file paths.
- **Audit log** (the list and the CSV and JSON lines exports): a change names the setting's `path` only, never its
  `from` or `to` value (a `config.change` or a `user.update`). An exported line with no value to hide is the line as
  written; one whose values were hidden is written again, so it no longer verifies against the chain (the owner's
  export does).

What a reviewer or a viewer does see that is more than a count:

- the addresses and the device ids in the audit log (an auditor needs them);
- in the cost reads (`/api/cost/*`), the project folders as `~` paths and the owner's folder rules;
- in `/api/live`, the folders the logs are read from, as `~` paths;
- in `/api/mcp-calls` (and the integrations' calls), the tool names and the names of their arguments (never their
  values);
- in the inventory, an item's `origin`: the scheme, host name and port an agent, a provider, an integration or an MCP
  server talks to (an inventory fact, never a path or a query);
- project names (a folder's last part) and model and tool names everywhere.

Refused requests are recorded, but at most 30 per account a minute: past that, the refusals of that minute are counted
and, once the minute is over, one `audit.refused_dropped` entry names the account and the count. The dashboard does
not ask for owner-only data while it draws a page for a reviewer or a viewer (no titles or feedback marks in the
Trace explorer, no agent candidates, no OpenRouter account; the Second Brain page says it is the owner's).

## Where accounts work

- **Password sign-in** (server mode, a proxy, `ZAAFPULSE_AUTH=1`): the sign-in page asks for a name and a password. An
  empty name, or `owner`, is the admin password, so a script that posts `{ "password": … }` keeps working.
- **Local sign-in** (the default on 127.0.0.1): the owner still opens the dashboard with `zaafpulse open`. The sign-in
  page also takes a name and a password, for someone else using this machine; a name of `owner` (or none) there is
  refused and points to `zaafpulse open`. `POST /api/login` answers in local mode whenever the accounts file can be
  kept (not in demo mode), also before the first account exists (then every name is a wrong one). Every local sign-in
  comes from 127.0.0.1, so the local accounts share that one address's budget (below). An account's sign-in replaces
  the owner's cookie in that browser, and `zaafpulse open` replaces an account's session, so one browser is one person;
  an account signing out does not sign the owner out anywhere.
- **No sign-in** (`ZAAFPULSE_AUTH=none`): there are no accounts. Everyone who reaches the dashboard is the owner, and
  the Users page says so.

## Settings → Users

The owner's page (`#settings/users`): every account with its name, display name, role, last sign-in and state, and:

- **Add**: a name (2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or a digit;
  not `owner`), a display name (at most 60 characters; control and format characters are refused), the role and a first
  password of at least 12 characters (at most 1024). The person chooses a new password at the first sign-in. At most
  200 accounts.
- **Role**: reviewer or viewer. A new role ends the account's sessions at once.
- **Disable** / **Enable**: a disabled account cannot sign in, and disabling ends its sessions.
- **Reset password**: the owner sets a new one; the sessions end and the person chooses a new one at the next sign-in.
- **Delete**: the account goes and its sessions end. The audit log keeps what it did.

Removing the last reviewer or viewer is allowed: there is always the owner.

## Signing in and passwords

A wrong name, a wrong password, a disabled account and the wrong admin password all get the same answer (`401 wrong
name or password`), and an unknown name takes as long to check as a wrong password. The throttles:

- Each address has its lockout budget as before: 5 free tries, then a wait of 30 s that doubles up to an hour. An IPv6
  address counts per /64, and each /56 shares a budget of 20. When 50 failures come from all addresses within 15
  minutes ("pressure"), every address gets 1 free try (4 for a /56). A quiet day (24 h) forgets the failures.
- Each account name (not the owner) has a budget of its own: after 10 wrong passwords for one account, from any number
  of addresses, new tries for that account wait (30 s, doubling up to an hour).
- Behind a shared address (an office, a carrier NAT, or 127.0.0.1 for every local sign-in), typing mistakes of
  different people add up in that address's budget until an owner sign-in clears it or 24 hours pass. An account's own
  successful sign-in takes back only its own attempt and never gives the owner's budget fresh guesses.
- A browser that signed in before holds a signed "known browser" cookie (180 days), bound to the person who signed in:
  the owner's cookie exempts only the owner's sign-ins from the address, /56, pressure and account budgets; an
  account's cookie exempts only that account's. The browser keeps its own count either way, and a successful sign-in
  there by the person it is bound to starts that count over.
- The owner has no per-name budget: a flood of guesses must never lock the owner out of a fresh browser.

Disabling an account, changing its role, resetting its password and deleting it end its sessions at once. A display
name that changes, or enabling an account, ends nothing. `zaafpulse set-password` changes the owner's password but does
not end the owner's sessions already open; restart the server to end them.

Until a new account has chosen its own password, every route but the password change, the sign-in state and sign-out
answers `403 change your password first`, and the dashboard sends the person to the change-password step. Any account
changes its own password with **Change password** in the top bar (`POST /api/account/password { current, next }`): at
least 12 characters and not the current one. The account's other sessions end; this one goes on. A wrong current
password is limited to 5 per session in 15 minutes, then `429` for 15 minutes (recorded as refused). The owner's own
password stays with `zaafpulse set-password` on the server.

The top bar shows who is signed in and their role, with **Change password** (accounts only) and **Sign out**. A
reviewer or a viewer also sees a one-line banner ("Signed in as Vera · Viewer · read-only", or "· reviews and
approvals"), and no Settings, Users or Rescan. A refused action says "Your role cannot do this". The server is the
authority: the page does not hide every button that writes.

## Where accounts are kept

`.data/users.json`, private to the account that runs ZAAFPulse (0600), written whole through a temporary file and a
rename:

```json
{ "users": [{ "id": "usr_…", "name": "vera", "display": "Vera", "role": "viewer", "salt": "…", "hash": "…",
  "createdAt": "…", "updatedAt": "…", "disabled": false, "mustChange": true, "lastLoginAt": null }] }
```

A password is a scrypt hash with the admin password's parameters; no password, salt or hash ever leaves the server.
The file is strict. One bad entry (the wrong shape, a name twice, an id twice, a salt or hash that is not valid base64
of the right length, an unknown role) makes the whole file unreadable: **no account signs in**, the owner still can,
the Users page says so, and the file is never written over until you fix or move it. A malformed hash never signs in.

Sessions live in memory: a restart signs every account out, as it does the owner in password mode. Each person (the
owner too) keeps at most 20 sessions: a sign-in beyond that ends that person's oldest one, and every sign-in clears the
sessions that have expired.

## Audit log

A dashboard entry's actor names the account and its role: `{ "via": "dashboard", "user": "vera", "role": "viewer",
"mode": "password", "device": "…", "ip": "…" }` (`user` and `role` are `null` before sign-in, `owner` for the owner,
also in local and no-sign-in mode). A sign-in (`auth.login`), a sign-out (`auth.logout`) and a local code
(`auth.local_code`) name the account and its role in their actor. Only a failed sign-in (`auth.login_failed`) and a
lockout (`auth.lockout`) carry a target: the account they were for, when it exists (`{ "type": "user", "id": "vera" }`,
`owner` for the admin password). No entry holds a password. New entries:

| Action | When |
|---|---|
| `user.create` | the owner adds an account (with its role) |
| `user.update` | the owner changes a role, a display name or disabled, as `changes` (`{ path, from, to }`) |
| `user.password_reset` | the owner sets a new password |
| `user.delete` | the owner deletes an account (with its role) |
| `account.password_change` | an account changes its own password |
| `audit.refused_dropped` | an account had more than 30 refused requests in a minute (with `dropped`, the count left out) |

**Governance → Audit log** filters by account (**User**; `GET /api/governance/audit?user=vera`, `owner` included); the
export takes the same filter (`GET /api/governance/audit/export?user=vera`, and the page's export links carry it), and
the CSV export's `actor_id` is the account for dashboard entries (the device for entries from before accounts).

## Compliance

The control **Dashboard roles and access reviews** (`access_roles`, one of the eighteen controls) maps to EU AI Act
Art. 26(2) (human oversight assigned to competent persons), NIST AI RMF GOVERN 2.1 (roles and responsibilities) and
ISO/IEC 42001 A.3 (internal organization). It is in place when sign-in is required and no account that may sign in has
gone unused for more than 90 days (by its last sign-in, or its creation when it never signed in); partial when one has,
an access review being due ("2 accounts unused for over 90 days", a count, never a name); off without sign-in; unknown
when `users.json` cannot be read.

## API

| Route | Who | What |
|---|---|---|
| `GET /api/session` | anyone | `{ required, mode, signedIn, configured, accounts, user, role, display, mustChange }` |
| `POST /api/login` | anyone | `{ name?, password }` → `{ ok, user, role, display, mustChange }` and the session cookie |
| `GET /api/users` | owner | `{ mode, state, users }`; `state` is `ok`, `unreadable` or `off` (no sign-in) |
| `POST /api/users` | owner | `{ action: "create", name, display?, role, password }`, `{ action: "update", name, role?, display?, disabled? }`, `{ action: "reset", name, password }`, `{ action: "delete", name }` |
| `GET /api/users/names` | owner, reviewer | `{ names }`: the owner's and the enabled accounts' display names (the inventory review's owner suggestions) |
| `POST /api/account/password` | any account | `{ current, next }` |

Bad input is a 400 naming the field (`name: already taken`, `role: reviewer or viewer`, `password: at least 12
characters` …), an unknown account a 404, an unreadable `users.json` a 409, a change without sign-in a 409. Only JSON
is accepted (415).

## Known limits

- No single sign-on (the owner declined it) and no second factor.
- No per-user notification channels, no gateway API keys owned by a user, no command line for accounts.
- One server process per data folder: sessions, throttles and the accounts file belong to the process that runs; two
  servers on the same `.data` folder would not share sessions or ending them.
- A display name that changes shows in an open session only after its next sign-in.
- `zaafpulse set-password` does not end the owner's open sessions; restart the server.
