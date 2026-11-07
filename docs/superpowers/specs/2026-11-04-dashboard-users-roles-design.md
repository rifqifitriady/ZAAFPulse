# Dashboard users and roles — design

Date: 2026-11-04. Status: approved by the owner. AI Governance sub-project 4 of 4 (1: guardrails, PR #63; 2: audit log,
PR #64; 3: inventory and Compliance, PR #65). Owner decisions (2026-11-04): the users are **the owner plus auditors and
viewers** who view, or manage in a limited way; sign-in is **local accounts only, no SSO**.

## Goal

Let the owner give other people their own sign-in to the dashboard — an auditor who reads the Governance pages and
exports evidence, a manager who reviews the AI inventory and approves agent runs — without sharing the admin password,
and with every change recorded under the person who made it. Today there is one admin password, a session carries no
identity, and every route assumes the owner.

## Decisions

| # | Decision |
|---|---|
| R1 | Three roles. **owner**: everything (today's admin). **reviewer**: everything a viewer can, plus inventory reviews (`POST /api/governance/inventory`) and collaboration run approvals (`POST /api/gateway/collab` with `action` `get`, `list` or `resume`). **viewer**: read-only, metadata only. |
| R2 | One owner: the existing admin password (`.data/admin.json` or `ZAAFPULSE_ADMIN_PASSWORD`). It signs in as user `owner`. Extra accounts live in `.data/users.json` (mode 0600, atomic write): `{ users: [{ id, name, display, role, salt, hash, createdAt, updatedAt, disabled, mustChange, lastLoginAt }] }`. `name` matches `^[a-z0-9][a-z0-9._-]{1,31}$` and is not `owner`; `display` ≤ 60 characters; `role` is `reviewer` or `viewer`. Hashes use the same scrypt parameters as the admin password. A user password has at least 12 characters. |
| R3 | Where accounts work: **password** mode (sign-in with name and password; an empty name or `owner` means the admin password, so today's `{ password }` form keeps working) and **local** mode (the owner still signs in with `zaafpulse open`; the login page also offers name and password for accounts, for someone using this machine). In **none** mode there are no accounts: the page says so and user management is off. |
| R4 | Sessions carry `{ user, role }`. `check(req)` keeps its boolean contract; a new `sessionOf(req)` returns `{ user, role, display }` (the owner for `local` and `none`). Disabling or deleting an account, or changing its role or password, ends its sessions at once. The sign-in throttle also keeps a bucket per account name, so guessing one account's password from many addresses is slowed too. |
| R5 | **Deny by default.** A role policy in `lib/users/policy.js` (pure) decides every `/api/*` request for a non-owner from method, path and, for the gateway admin route, the body's `action`: an explicit allow-list per role. Anything not listed is `403 { error: 'your role cannot do this' }`, recorded as a refused request entry. The owner is never restricted. |
| R6 | What a viewer may read: the metadata routes (platform, summary, live, insights, topology, timeline, office, logs, mcp-calls, router, openrouter catalogue, prices, config read, trace sources/settings/sessions list/deps/find, evals summary/status/evaluators/settings, datasets and experiments lists, monitors, alerts, runtimes, cost reads incl. export and reports, governance reads incl. audit, audit export, verify, status, inventory, controls and evidence export, integrations status). Never for a non-owner: trace session/title/content/live and reveal, dataset and experiment details and exports, feedback notes, brain/vault, evals preview, integrations config, gateway `knowledge get/search`, `sessions get`, `quota`, `providers test/models`. |
| R7 | `GET /api/gateway` for a non-owner is a **redacted view** built by a pure function in the policy module: agents without `systemPrompt`, memory without text, sessions without titles, runs without task or answer text, keys without anything but name, prefix, scopes, budget and dates; providers without secret references. Reviewers additionally get collaboration runs with their text through `collab get/list` (they must read what they approve). |
| R8 | A new account is created by the owner with a password the owner sets once; `mustChange` is true, and until that user changes it (`POST /api/account/password { current, next }`) every other route answers `403 { error: 'change your password first' }`. Any signed-in person can change their own password; the owner's own password stays with `zaafpulse set-password`. |
| R9 | Audit: the dashboard actor gains `user` and `role` (`{ via: 'dashboard', user, role, mode, device, ip }`); sign-in events name the account (never the password); new entries `user.create`, `user.update` (role, display, disabled), `user.password_reset`, `user.delete`, `account.password_change`. The audit list filters by user; the CSV `actor_id` holds the user for dashboard entries. |
| R10 | Dashboard: Settings → **Users** (owner only): list (name, display, role, last sign-in, disabled), add, change role, disable/enable, reset password, delete. The topbar shows the signed-in display name and role and a sign-out link. For a non-owner: a one-line banner ("Signed in as <name> · <role> · read-only" / "… · reviews and approvals"), the Settings, Users and Rescan controls are hidden, and a 403 from any action is shown as "Your role cannot do this". The server is the authority; the page does not hide every write button. On the Inventory page the review drawer is enabled for reviewers and owner only, and its owner field suggests account display names (free text stays allowed). |
| R11 | Compliance: a new control `access_roles` — in place when sign-in is required and no account has gone unused for more than 90 days; partial when one has (an access review is due), naming the count only; off when sign-in is `none`. Clauses: EU AI Act Art. 26(2) (human oversight assigned to competent persons), NIST AI RMF GOVERN 2.1 (roles and responsibilities), ISO/IEC 42001 A.3 (internal organization). |
| R12 | Out of scope: SSO (declined by the owner), MFA, per-user notification channels, gateway API keys owned by users, a CLI for accounts. |

## Architecture

- `lib/users/store.js` (new): accounts file, create/update/delete, password hashing and checking (reusing the scrypt helpers from `lib/auth.js`), name and role validation.
- `lib/users/policy.js` (new, pure): `allowed({ role, method, path, action, mustChange })` → `{ ok, reason }`, the per-role allow-lists, and `redactGateway(payload, role)`.
- `lib/auth.js`: name+password sign-in, sessions with identity, `sessionOf(req)`, ending a user's sessions, the per-account throttle bucket, `actorOf` with user/role.
- `server.js`: after `auth.check`, the policy gate for `/api/*` (403 recorded as refused); routes `GET/POST /api/users` (owner), `POST /api/account/password` (any signed-in user); the redacted gateway view.
- `public/login.html`, `public/login.js`: a name field (optional in password mode), the change-password step.
- `public/app.js` + a new `public/usersview.js` (prefix `usr`/`USR`): Settings → Users, topbar identity, role banner, 403 handling.
- `lib/governance/*`: actor fields, audit filter by user, the `access_roles` control.
- Docs: `docs/users.md`, README, `docs/governance.md`.

## Error handling

| Case | Result |
|---|---|
| Wrong name or password | 401 `wrong name or password` (one message for both) and the throttle |
| Disabled account | 401 like a wrong password (no account enumeration) |
| users.json unreadable | accounts cannot sign in (the owner still can); the Users page says the file could not be read; no write over it |
| A non-owner request outside the allow-list | 403 `your role cannot do this`, recorded as refused |
| `mustChange` | 403 `change your password first` everywhere except the password route, session and logout |
| Removing the last reviewer etc. | allowed; there is always the owner |

## Testing

Unit: store validation and hashing, policy allow-lists for every route class (a table test that every route a viewer may
read is listed and every content/secret route is denied), the gateway redaction (no systemPrompt, memory text, titles,
secret refs), session identity and ending sessions on disable/role change/password reset, per-account throttle. HTTP
(spawned server, temp data dir, ports outside every existing range): owner creates a viewer and a reviewer; viewer reads
the Governance pages and exports evidence but gets 403 on a settings write, a trace content read and a gateway action;
reviewer saves an inventory review and approves a run but cannot change a setting; `mustChange` flow; audit entries carry
the user; the legacy `{ password }` login still works. UI string tests.
