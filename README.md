<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner-light.svg">
  <img alt="ZAAFPulse: AI command center for your Mac" src="docs/assets/banner-dark.svg" width="100%">
</picture>

<br>

<img alt="macOS" src="https://img.shields.io/badge/macOS-native-0f1b2a?style=flat-square&logo=apple&logoColor=white">
<img alt="Node 18+" src="https://img.shields.io/badge/Node-18%2B-1f7f95?style=flat-square&logo=nodedotjs&logoColor=white">
<img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-1baf7a?style=flat-square">
<img alt="Local first" src="https://img.shields.io/badge/data-local%20first-6250d6?style=flat-square">
<img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-supported-2a78d6?style=flat-square">
<img alt="Codex" src="https://img.shields.io/badge/Codex-supported-eb6834?style=flat-square">
<img alt="MCP server" src="https://img.shields.io/badge/MCP-server-0f1b2a?style=flat-square">
<img alt="Obsidian" src="https://img.shields.io/badge/Obsidian-graph-e87ba4?style=flat-square&logo=obsidian&logoColor=white">

**One local dashboard for everything AI does on your laptop:**<br>
what it costs, how often it is wrong, what it touched, and how your knowledge grows.

[Features](#features) · [Screenshots](#screenshots) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Metrics](#what-the-quality-metrics-mean) · [Privacy](#privacy)

</div>

<br>

<p align="center">
  <img alt="Dashboard opening: counters count up, charts grow, and the spend drill-down slides in" src="docs/assets/demo-overview.gif" width="92%">
</p>
<p align="center"><sub>Demo data. Every card is clickable and opens a drill-down.</sub></p>

## Why ZAAFPulse

AI coding agents now run for hours, read thousands of files and call hundreds of tools. Their logs already sit on your disk, but nobody reads 2 GB of JSONL. ZAAFPulse reads it for you and answers four questions at a glance:

| | Question | What you get |
|---|---|---|
| **$** | *What is AI costing me?* | API-equivalent spend per day, model, project and session, a month-end projection, and where the money goes: input, output, cache reads or cache writes. |
| **✓** | *Can I trust what it did?* | Tool-call accuracy, hallucination signals (paths, edits, arguments and URLs that did not exist) and how often you had to correct it. |
| **⚠** | *Did anything unsafe happen?* | Prompt-injection attempts in web and MCP content, secrets that surfaced in tool output, and risky commands such as `rm -rf` or force pushes. |
| **◉** | *Is my second brain growing?* | A live, animated graph of your Obsidian vault: hubs, orphans, unresolved links, and a replay of how it grew. |
| **⇄** | *Can my agents reach the rest of my stack?* | An MCP server for Claude Code, Kiro and Antigravity with connectors to Dynatrace, Arize Phoenix and AX, n8n, OmniRoute, 9router and any HTTP or MCP service, plus a page that shows every connection's health. |

## Features

<table>
<tr>
<td width="33%" valign="top">

**Usage & cost**<br>
<sub>Tokens, sessions, prompts, models and projects across Claude Code and Codex. Cost at list price with cache-aware rates, a monthly budget meter and a projection.</sub>

</td>
<td width="33%" valign="top">

**Quality & safety**<br>
<sub>Accuracy, hallucination signals, poisoning detection, corrections, secrets, risky commands, API errors, loops and context compactions. Every number opens the exact items behind it.</sub>

</td>
<td width="33%" valign="top">

**Second brain graph**<br>
<sub>Force-directed graph of your vault with pulses along every link, hover focus, search, legend filters, backlinks per note, Open in Obsidian, and a growth replay.</sub>

</td>
</tr>
<tr>
<td valign="top">

**Live monitor**<br>
<sub>Which AI apps are running right now (Claude Code, Claude Desktop, Codex, ChatGPT, Antigravity, Cursor, Ollama, LM Studio), with CPU sparklines, memory and uptime.</sub>

</td>
<td valign="top">

**Drill-downs everywhere**<br>
<sub>Each KPI slides open a panel with charts, breakdowns and tables. Count-up numbers, growing bars, keyboard support, and reduced-motion respected.</sub>

</td>
<td valign="top">

**Always on**<br>
<sub>Optional macOS LaunchAgents keep the server running and bring the dashboard to the front at login and whenever you open the lid, reusing the same tab.</sub>

</td>
</tr>
</table>

| At a glance | |
|---|---|
| Runtime dependencies | **0** (Node standard library only) |
| First index of 2 GB of logs | **~15 s**, then **~25 ms** per rescan |
| Network exposure | **127.0.0.1 only**, host-header checked; outbound only to integrations you configure |
| Themes | Light and dark, follows your system |

## Screenshots

<details open>
<summary><b>Overview</b>: usage, cost, quality and your AI squad on one page</summary>
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screen-overview-dark.png">
  <img alt="Overview page" src="docs/assets/screen-overview-light.png">
</picture>
</details>

<details open>
<summary><b>Quality & safety</b>: accuracy, hallucinations, poisoning and corrections</summary>
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screen-quality-dark.png">
  <img alt="Quality and safety page" src="docs/assets/screen-quality-light.png">
</picture>
</details>

<details open>
<summary><b>Second brain</b>: your Obsidian vault as a living graph</summary>
<br>
<p align="center"><img alt="Note graph with pulses travelling along links, hover focus on a hub, then a growth replay" src="docs/assets/demo-brain.gif" width="82%"></p>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screen-brain-dark.png">
  <img alt="Second brain page" src="docs/assets/screen-brain-light.png">
</picture>
</details>

<details>
<summary><b>Drill-downs</b>: spend projection and poisoning detections</summary>
<br>
<table>
<tr>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screen-drawer-spend-dark.png">
  <img alt="Estimated spend drill-down" src="docs/assets/screen-drawer-spend-light.png">
</picture>
</td>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screen-drawer-poisoning-dark.png">
  <img alt="Poisoning drill-down" src="docs/assets/screen-drawer-poisoning-light.png">
</picture>
</td>
</tr>
</table>
</details>

<sub>All screenshots use the built-in demo dataset (`npm run demo`). No real projects, costs or notes are shown.</sub>

## Quick start

Requires macOS and Node 18 or newer. Nothing to install. Clone this repository (green **Code** button above), then:

```bash
cd ai-command-center
npm start          # reads your logs  → http://localhost:4777
npm run demo       # synthetic data   → http://localhost:4778
npm test           # run the test suite (node:test, no dependencies)
```

The first start indexes your logs (about 15 seconds for 2 GB). After that the server rescans every minute and only re-reads files that changed.

### Run it on login

```bash
./scripts/install-autostart.sh     # keep the server running, show the dashboard at login and on wake
./scripts/uninstall-autostart.sh   # remove it again
```

This installs two LaunchAgents: `com.zaaf.aipulse.server` (starts at login, restarts on crash) and `com.zaaf.aipulse.opener` (brings the dashboard tab to the front in Chrome at login and whenever the Mac wakes). macOS asks once for permission to control Chrome. Logs go to `~/Library/Logs/AIPulse/`.

## MCP server and integrations

`node mcp.js` is an MCP server (stdio) that AI clients start on demand. It offers the dashboard's own data and a connector for each platform you configure under `integrations` in `config.json`. Register it once:

```bash
npm run mcp:register -- all        # Claude Code, Kiro and Antigravity (backs up their config first)
```

| Type | Platforms | Tools |
|---|---|---|
| `acc` (always on) | this dashboard | `usage_summary`, `quality`, `live_apps`, `integrations_status` |
| `dynatrace` | Dynatrace SaaS and Managed | problems, entities, metrics, logs, security problems, DQL (SaaS) |
| `arize` | Arize Phoenix and Arize AX | projects, spans, traces, datasets, experiments, monitors (AX) |
| `n8n` | n8n | workflows, executions; run allowlisted webhooks and (de)activate workflows when writes are on |
| `router` | OmniRoute, 9router | health, models, providers, combos, usage, telemetry |
| `http` | AION and any REST API | one tool per endpoint you declare |
| `mcp` | any Streamable HTTP MCP server | the upstream tools, filtered, under a `<id>__` prefix |

Tools are prefixed with the integration id (`dynatrace-saas_list_problems`). Everything is read-only unless an integration sets `"allowWrite": true`. Secrets stay in the macOS Keychain or environment variables, never in `config.json`. The **Integrations** page shows each connection's health, which clients have the server registered, and recent tool calls. Setup per platform: [docs/integrations.md](docs/integrations.md).

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture-light.svg">
  <img alt="Sources are collected, cached, aggregated and served on 127.0.0.1" src="docs/assets/architecture-dark.svg" width="100%">
</picture>

| Source | Read from | Gives |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl`, subagents included | tokens per call (input, output, cache read, cache write 5m/1h), model, project, branch, prompts, tools, skills, subagents, quality signals |
| Codex | `~/.codex/sessions/**/*.jsonl` | tokens per turn, model, project, prompts, tool calls, failures, plan rate limits |
| Running apps | `ps` | which AI apps are open, process count, CPU, memory, uptime |
| Obsidian | the vault Obsidian has open, or a path in Settings | notes, `[[wikilinks]]`, embeds and `.md` links, tags, frontmatter type; symlinked folders are followed |

Claude Desktop, ChatGPT and Antigravity keep conversations in the cloud, so they are shown by live presence and resource use only.

## What the quality metrics mean

These are **signals detected in the logs, not a graded evaluation**. Every card opens the exact items that matched, so you can judge them yourself.

| Metric | How it is detected |
|---|---|
| **Accuracy** | Tool calls that succeeded ÷ tool calls with a result. Only failures the model caused count against it (hallucination signals, edits without reading, failed commands or tests). Network errors, timeouts and calls you rejected are left out. |
| **Hallucination signals** | The model acted on something untrue and the tool said so: a path that does not exist, edit text not in the file, invalid tool arguments, a URL that returns 404. Made-up facts in written answers leave no trace in the logs and are not counted. |
| **Poisoning detections** | Prompt-injection patterns in tool results: instruction override, persona hijack, exfiltration requests, hide-from-user instructions, fake role tags, run-without-asking commands. Split into **external** content (web, search, MCP), which matters, and local files, which are usually docs or test data. |
| **Correction rate** | (Correction prompts + interrupts) ÷ typed prompts. Corrections are matched in English and Indonesian ("that's not what I asked", "kamu salah", "masih belum", "perbaiki"); correcting your own input does not count. |
| **Safety** | Secrets that appeared in tool output (type only, never the value) and risky commands the AI ran: force deletes, force pushes, hard resets, pipe-to-shell, `sudo`, `chmod 777`, `kill -9`/`pkill`, `DROP TABLE`, raw disk writes. |
| **Reliability** | API errors, network and timeout failures, repeat loops (the same call three or more times in a row), and context compactions. |

**Cost** is an API-equivalent estimate: tokens × list price per million, matched by the longest model prefix, with separate cache-read and cache-write rates. On a subscription plan you are not billed per token. Prices are editable in Settings.

## Privacy

- The server listens on `127.0.0.1` only and rejects requests whose `Host` is not `localhost`.
- Nothing is sent anywhere unless you configure an integration, and then only to the URL you configured: when an AI client calls a tool, or when the Integrations page checks health (at most once a minute per integration, or when you press Test). No telemetry, no accounts. Integration secrets stay in the macOS Keychain or environment variables, never in `config.json`.
- Message text is never stored. The cache keeps token counts, metadata and, for flagged quality or safety items only, a masked snippet of up to 160 characters. Secret values are never kept.
- `config.json` and `.cache/` are git-ignored.

<details>
<summary><b>Project structure</b></summary>

```
server.js              HTTP server, API routes, config, demo switch
mcp.js                 MCP server over stdio for AI clients
lib/mcp/               MCP protocol (stdio server, Streamable HTTP client)
lib/integrations.js    builds connectors, prefixes tools, enforces allowWrite, audits calls
lib/connectors/        acc, dynatrace, arize, n8n, router, http and mcp-proxy connectors
lib/secrets.js         Keychain and env secret references, masking
lib/audit.js           tool-call log (.cache/mcp-audit.jsonl)
lib/local.js           dashboard data for the acc connector
lib/claude.js          Claude Code log parser (usage + signals)
lib/codex.js           Codex log parser (usage + signals)
lib/signals.js         hallucination, injection, secret, risky-command and correction detectors
lib/indexer.js         incremental cache keyed by mtime + size
lib/aggregate.js       usage, cost and session roll-ups for a time range
lib/quality.js         quality and safety roll-ups for a time range
lib/pricing.js         default prices and cost function
lib/processes.js       running-app detection
lib/vault.js           Obsidian vault scanner
lib/demo.js            seeded synthetic dataset for demo mode
public/                dashboard UI: plain HTML, CSS and JavaScript, no build step
scripts/               LaunchAgent install/uninstall, launcher, Chrome opener, MCP client registration
test/                  node:test suites with fake HTTP and MCP servers
config.example.json    every integration type with placeholder references
docs/integrations.md   per-platform setup
docs/assets/           README banner, diagrams, screenshots and GIFs
```
</details>

<details>
<summary><b>HTTP API</b></summary>

| Route | Returns |
|---|---|
| `GET /api/summary?range=7\|30\|90\|all` | usage, cost, sessions, projects, models and quality for the range |
| `GET /api/live` | running AI apps and indexer status |
| `GET /api/vault` | notes, links and unresolved links of the Obsidian vault |
| `GET /api/config` · `POST /api/config` | name, monthly budget, prices, vault path |
| `POST /api/rescan` | re-index changed log files now |
| `GET /api/integrations` | integration health, client registration and recent MCP tool calls |
| `POST /api/integrations/test` | fresh health check of one integration (`{ "id": "..." }`) |
</details>

<details>
<summary><b>Configuration</b></summary>

Everything is editable in **Settings** and saved to `config.json`:

| Setting | Default |
|---|---|
| Display name | your macOS account name |
| Monthly budget (USD, API-equivalent) | none |
| Model prices per 1M tokens | current list prices for Claude models; add a prefix such as `gpt-6` to price Codex |
| Obsidian vault path | the vault Obsidian has open |
| Theme | follows the system |

Environment variables: `PORT` (default `4777`) and `DEMO=1` for synthetic data.
</details>

<br>

<div align="center">
<sub>Built with plain Node and the browser. No frameworks, no build step, no cloud.</sub>
</div>
