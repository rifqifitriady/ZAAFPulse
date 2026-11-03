# AI inventory and Compliance pages — design

Date: 2026-11-03. Status: approved by the owner ("jalankan sesuai urutan point 1 hingga 4"; standing instruction: follow
the controller's recommendations). AI Governance sub-project 3 of 4 (1: gateway guardrails, PR #63; 2: governance audit
log, PR #64).

## Goal

Answer two questions an auditor or a security lead asks first: **which AI systems are in use here, who owns them and how
risky are they**, and **which controls are in place, with evidence**. Today the facts are spread over Overview, AI
Office, Agent Gateway, Integrations and Local runtimes, nobody can record an owner, purpose or risk tier, and MCP servers
configured in other AI clients (Claude Code, Cursor, Kiro, …) are not seen at all.

## Decisions

| # | Decision |
|---|---|
| I1 | An **inventory** built at read time from sources that already exist, plus one new reader: AI apps (running apps, installed apps, tools seen in logs and trace sources), MCP servers in the AI clients' config files (new), gateway providers and the models used, gateway agents, skills, workflows and knowledge bases, local runtimes and desktop apps, integrations (incl. upstream MCP servers), and API keys (the consumers). |
| I2 | One item per system, with a stable id `<kind>:<name>` (kinds: `app`, `mcp`, `provider`, `model`, `agent`, `skill`, `workflow`, `knowledge`, `runtime`, `integration`, `key`), `name`, `vendor` (when known), `where` (the sources that found it, e.g. `claude-code config`, `running`, `logs`, `gateway`), `state` (`running`, `configured`, `used`, `idle`), `firstSeen` and `lastSeen`. First/last seen are kept in `.data/governance/seen.json` (id → two dates), updated when the inventory is built; nothing else is stored there. |
| I3 | The **MCP reader** lists every server in the client files `scripts/register-mcp.js` already knows (Claude Code `~/.claude.json` user scope and its per-project `projects[*].mcpServers`, Claude Desktop, Cursor, Kiro, Antigravity, VS Code `servers`, Windsurf, Gemini, Zed `context_servers`, Codex TOML `[mcp_servers.*]`). JSONC (comments, trailing commas) is read. ZAAFPulse's own entry is marked `ours`. Per server only: name, client(s), transport (`stdio` or `http`), the command's base name and the first package-looking argument (`npx -y @scope/pkg` → `@scope/pkg`), or the URL's origin. Never env values, headers, other args, or tokens. Project paths are shown as `~` paths on the dashboard only. |
| I4 | Owner-entered **review** per item, saved in config.json `governance.inventory[<id>] = { owner, purpose, risk, decision, note, reviewedAt }` through `POST /api/governance/inventory` (so every change is a `config.change` audit entry). `risk`: `minimal`, `limited`, `high`, `unacceptable` (the EU AI Act tiers) or empty. `decision`: `approved`, `restricted`, `blocked` or empty. Text fields at most 200 characters. An item with no review is **unreviewed**. A review for an item that no longer appears is kept and shown as `gone`. |
| I5 | Monitors rule `inventory_unreviewed` (aggregate, default on, never auto-pauses): triggers when an item first seen in the last 7 days has no review — a new, unreviewed AI system (shadow AI). The alert carries the count and kinds only, never names. |
| I6 | **Compliance** page: a fixed catalogue of controls ZAAFPulse provides, each mapped to clauses — EU AI Act Art. 12 (record-keeping), Art. 14 (human oversight), Art. 26 (deployer obligations: logs kept ≥ 6 months, oversight assigned, monitoring), Art. 50 (transparency, where the owner's use applies); NIST AI RMF functions and categories (GOVERN 1.x, MAP 1.x, MEASURE 2.x, MANAGE 2.x/4.x); ISO/IEC 42001 Annex A controls (A.2 policies, A.5 impact, A.6 life cycle, A.7 data, A.8 information to interested parties, A.9 use, A.10 third parties). Each control has a live **status** (`in place`, `partial`, `off`) computed from current settings and state, and the **evidence**: the setting's value, a count, a date, and a link to the dashboard page that shows it. |
| I7 | The control catalogue (initial set): guardrails secrets/pii/injection modes; audit log on, verify result, retention ≥ 6 months; gateway usage log; external providers need approval; API keys with scopes/budgets/expiry; human approval gates on workflows; agent pause/stop available; Monitors rules on (incl. guardrail_block, audit_chain_broken, inventory_unreviewed); evals running; datasets experiments; cost budgets that block or pause; secrets in the OS store; sign-in mode; content capture off; OTel export; trace retention; inventory coverage (share of items reviewed, items with a high/unacceptable risk and their decision). |
| I8 | Wording: the page says "evidence for your assessment, not a certification", names the framework versions (EU AI Act Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744; NIST AI RMF 1.0; ISO/IEC 42001:2023) and never says "compliant". |
| I9 | **Evidence export**: `GET /api/governance/evidence?format=json|md` — the inventory (with reviews, without paths), the control statuses with evidence and clause mapping, the audit verify result and retention, the generated time and ZAAFPulse version. Markdown is a readable report; JSON is the same data. Dashboard session only. The export is itself recorded (it is a GET, so as a dedicated `governance.export` entry). |
| I10 | Small API gaps closed for the evidence: `otel.status()` and trace retention exposed through `GET /api/governance/controls` (the compliance answer); no new settings. |
| I11 | Pages: the Governance menu gets three sub-pages — **Inventory** (`#governance`, the default), **Compliance** (`#governance/compliance`) and **Audit log** (`#governance/audit`, moved from `#governance`; the sidebar sub-link and the docs point to the new hash, and `#governance` now opens Inventory). |
| I12 | Out of scope: per-person owners linked to users (sub-project 4 adds users; until then owner is free text), questionnaires/DPIA workflows, external attestations, blocking an AI system from the inventory (the decision is a record; enforcement stays with gateway keys/guardrails). |

## Architecture

- `lib/governance/mcp-scan.js` (new): pure parsers (JSONC, the TOML subset) and `scanClients({ home, env, platform, read })` → `[{ client, file(~), servers: [{ name, transport, command, package, origin, ours, project? }] }]`, using the paths from `scripts/register-mcp.js` (move the path table to a shared module both use, or require it).
- `lib/governance/inventory.js` (new): pure `buildInventory(sources, reviews, seen, now)` → `{ items, counts }` and `nextSeen`; sources are passed in by `server.js` (processes snapshot, summary tools, trace sources, gateway admin payload, runtimes rows, integrations status, MCP scan).
- `lib/governance/controls.js` (new): pure `controls(state)` → `[{ id, title, status, evidence, link, clauses }]` and the clause catalogue.
- `lib/governance/evidence.js` (new): pure JSON and Markdown renderers.
- `lib/governance/api.js`: new routes `GET /api/governance/inventory`, `POST /api/governance/inventory`, `GET /api/governance/controls`, `GET /api/governance/evidence`.
- `lib/monitors/rules.js`: `inventory_unreviewed`.
- `public/governanceview.js`: sub-pages (Inventory with filters by kind/state/review, a review drawer; Compliance with the control table grouped by framework and an Export button), `SUBPAGES.governance` in `public/iso.js`, sidebar sub-links.
- Docs: `docs/governance.md` (Inventory, Compliance, evidence export), README.

## Error handling

| Case | Result |
|---|---|
| A client config file is unreadable or malformed | that client shows `unreadable`; other clients still listed |
| A source fails while building the inventory | the inventory is built from the rest and lists the failed source |
| Bad review input | 400 naming the field; nothing written |
| `seen.json` unreadable | rebuilt from now (first seen becomes today), never fails the page |

## Testing

Unit: the JSONC and TOML parsers, the MCP scan with fixture files for every client (secrets in env/args/headers never
appear), inventory merge (same system from several sources is one item, stable ids, first/last seen, gone reviews),
review validation, every control's status from fixture states, clause mapping completeness, evidence renderers (no
paths, no secrets). HTTP: inventory, review save (audit `config.change`), controls, evidence (audit entry), session
only. Monitors rule. UI string tests.
