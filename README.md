<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner-light.svg">
  <img alt="ZAAFPulse: AI command center and agentic workspace for macOS, Linux and Windows" src="docs/assets/banner-dark.svg" width="100%">
</picture>

<br>

<img alt="macOS, Linux, Windows" src="https://img.shields.io/badge/runs%20on-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-0f1b2a?style=flat-square">
<img alt="Node 18+" src="https://img.shields.io/badge/Node-18%2B-1f7f95?style=flat-square&logo=nodedotjs&logoColor=white">
<img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-1baf7a?style=flat-square">
<a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-1f7f95?style=flat-square"></a>
<img alt="Local first" src="https://img.shields.io/badge/data-local%20first-6250d6?style=flat-square">
<img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-supported-2a78d6?style=flat-square">
<img alt="Codex" src="https://img.shields.io/badge/Codex-supported-eb6834?style=flat-square">
<img alt="MCP server" src="https://img.shields.io/badge/MCP-server-0f1b2a?style=flat-square">
<img alt="Agent Gateway" src="https://img.shields.io/badge/Agent%20Gateway-OpenAI%20%C2%B7%20Anthropic%20%C2%B7%20Gemini-6250d6?style=flat-square">
<img alt="A2A" src="https://img.shields.io/badge/A2A-v1.0-1f7f95?style=flat-square">
<img alt="Second brain" src="https://img.shields.io/badge/Second%20brain-15%20sources-e87ba4?style=flat-square&logo=obsidian&logoColor=white">

**One command center for everything AI does on your laptop or server:**<br>
what it costs, how often it is wrong, what your agents are doing right now and how your knowledge grows,<br>
plus an agentic workspace (beta): one API for your models, 17 agents that work together, workflows, RAG, MCP and A2A.

[Features](#features) · [Screenshots](#screenshots) · [Quick start](#quick-start) · [Agentic workspace](#agentic-workspace) · [OpenTelemetry](#opentelemetry-export) · [How it works](#how-it-works) · [Metrics](#what-the-quality-metrics-mean) · [Privacy](#privacy) · [Contributing](#contributing)

</div>

<br>

<p align="center">
  <img alt="Overview opening: the 3D usage city grows day by day while the KPI cards and charts load" src="docs/assets/demo-overview.gif" width="92%">
</p>
<p align="center"><sub>Demo data. Every page is a holographic deck with its own 3D scene; drag to rotate, hover for details, click a card for a drill-down.</sub></p>

## Why ZAAFPulse

AI coding agents now run for hours, read thousands of files and call hundreds of tools. Their logs already sit on your disk, but nobody reads 2 GB of JSONL. ZAAFPulse reads it for you and answers these questions at a glance:

| | Question | What you get |
|---|---|---|
| **$** | *What is AI costing me?* | API-equivalent spend per day, model, project and session at **provider list prices** (checked against Anthropic's and OpenAI's own price lists, kept current from OpenRouter's public list), with each API response counted once even when a session was resumed or forked, a month-end projection, and where the money goes: input, output, cache reads, cache writes or web searches. |
| **✓** | *Can I trust what it did?* | Tool-call accuracy that counts only failures the model caused, non-existent targets (paths, edit text, arguments, URLs, packages and commands that did not exist) and how often you had to correct it. |
| **⚠** | *Did anything unsafe happen?* | Prompt-injection attempts in web and MCP content, secrets that surfaced in tool output, and risky commands such as `rm -rf` or force pushes. |
| **◈** | *What are my agents doing right now?* | A live 3D office: every session and subagent walks to the room for the tool it is using, waits at the help desk when it needs you, and shows up in a request log, a stream inspector and a timeline. |
| **◉** | *Is my second brain growing?* | One animated map of Obsidian, Logseq, Notion, Tana, Roam, mem.ai, Reflect, Heybrain, a PARA workspace, your RAG knowledge and vector databases: hubs, orphans, PARA lanes, a semantic map by meaning, and a replay of how it grew. |
| **⌁** | *Can my apps and coding tools use any model through one API?* | An Agent Gateway (beta) on 127.0.0.1: API keys with scopes, budgets and rate limits; OpenAI, Anthropic, Responses and Gemini endpoints over 52 provider presets with fallback routes, quota and a token saver; Claude Code, Codex, Gemini CLI and more connected in one click. |
| **⚙** | *Can my agents work together, safely?* | In beta: 17 domain agents, an orchestrator, seven collaboration patterns (vote, debate, review, group chat, handoff …) with budgets and traces, 24 ready-made workflows with approval gates, RAG, A2A, and Agent Skills that teach any AI to use all of it. |
| **⇄** | *Can my agents reach the rest of my stack?* | An MCP server for Claude Code, Cursor, VS Code, Codex, Gemini CLI and five more clients, with connectors to Dynatrace, Arize Phoenix and AX, n8n, OmniRoute, 9router and any HTTP or MCP service, plus a page that shows every connection's health. Gateway traces can go to Dynatrace, Arize, Langfuse or any other backend that takes OTLP over HTTP. |

## Features

<table>
<tr>
<td width="33%" valign="top">

**Usage & cost**<br>
<sub>Tokens, sessions, prompts, models and projects across Claude Code and Codex, each API response counted once across resumed and forked sessions. Cost at list price with cache-aware rates, long-prompt tiers, fast mode and web searches, a monthly budget meter, a projection, and a 3D "usage city" of every day.</sub>

</td>
<td width="33%" valign="top">

**Quality & safety**<br>
<sub>Accuracy, non-existent targets, poisoning, corrections, relevance, faithfulness, secrets, risky commands, API errors, loops and compactions, plus subpages for <b>Utilization</b>, <b>Cache</b>, <b>Compression</b> and <b>Provider stats</b>.</sub>

</td>
<td width="33%" valign="top">

**AI Office, live**<br>
<sub>A 3D office driven by real transcript state: who is editing, reading, running commands, browsing or delegating, who is waiting for you and who needs approval. Subagents appear next to their parent.</sub>

</td>
</tr>
<tr>
<td valign="top">

**Logs, proxy & timeline**<br>
<sub>Real-time request log with TTFT and duration, error traces and a stream inspector; OmniRoute upstream and MCP hub traffic; a timeline of every agent and subagent with parallelism.</sub>

</td>
<td valign="top">

**Live monitor**<br>
<sub>Which AI apps are running right now (Claude Code, Claude Desktop, Codex, ChatGPT, Antigravity, Cursor, Ollama, LM Studio) as a 3D fleet, with CPU, memory, machine share and load.</sub>

</td>
<td valign="top">

**Second brain graph**<br>
<sub>Obsidian by default, plus <b>Logseq</b>, <b>Notion</b>, <b>Tana</b>, <b>Roam Research</b>, <b>mem.ai</b>, <b>Reflect</b>, <b>Heybrain</b>, a <b>PARA</b> workspace, the <b>RAG</b> knowledge bases and vector databases (<b>Pinecone</b>, <b>Weaviate</b>, <b>Qdrant</b>, <b>pgvector</b>, <b>Chroma</b>). One animated map with six layouts: network, PARA lanes, semantic map (records placed by embedding meaning, nearest-neighbour links, clusters), hierarchy, timeline and all sources together (same-titled notes joined across tools). Pulses along links, search, legend filters, backlinks, open in the source app, a growth replay and a 3D chart of notes per week.</sub>

</td>
</tr>
<tr>
<td valign="top">

**MCP hub & integrations**<br>
<sub>An MCP server for Claude Code, Kiro, Antigravity, Cursor, VS Code, Claude Desktop, Codex, Gemini CLI, Windsurf/Devin and Zed, with connectors to Dynatrace, Arize, n8n, OmniRoute, 9router and any HTTP or MCP service, shown as a 3D hub. Add, configure and test integrations right on the page.</sub>

</td>
<td valign="top">

**Drill-downs everywhere**<br>
<sub>KPI cards are compact glass tiles with sparklines drawn from real series; each one opens a panel with charts, breakdowns and tables. Keyboard support, reduced motion respected.</sub>

</td>
<td valign="top">

**Always on**<br>
<sub>Optional macOS LaunchAgents keep the server running and bring the dashboard to the front at login and whenever you open the lid, reusing the same tab.</sub>

</td>
</tr>
<tr>
<td valign="top">

**Model prices**<br>
<sub>Built-in prices checked against Anthropic's and OpenAI's official lists, an offline snapshot of OpenRouter's public list shipped with the app, and, when the machine is online, a live sync of that list every 12 h. A card per model with prices, context, tags and your spend; pin your own price anytime.</sub>

</td>
<td valign="top">

**Model catalog**<br>
<sub>Anthropic, OpenAI, Google, DeepSeek, Alibaba, xAI, Meta, Tencent and Z.ai, filterable by vendor and searchable. The full catalog comes from the live list and needs network (the last copy is cached); offline, the shipped snapshot still prices 215 models.</sub>

</td>
<td valign="top">

**OpenRouter models & rankings**<br>
<sub>When online: the models on OpenRouter with live prices and per-provider uptime, the most-used models and apps this week, benchmark leaders, and the inference-provider directory, all as 3D decks.</sub>

</td>
</tr>
<tr>
<td valign="top">

**Endpoint & code tools**<br>
<sub>API keys, the MCP server (register it in any of ten clients, or connect over HTTP), snippets, and one-click setup of Claude Code, Codex, Gemini CLI, OpenCode and Aider on any provider, with backup and revert.</sub>

</td>
<td valign="top">

**Agent Gateway & model router** (beta)<br>
<sub>OpenAI ⇄ Anthropic ⇄ Responses ⇄ Gemini translation, native Responses and Anthropic passthrough, 52 provider presets, fallback routes with cooldown after a 429, quota and balances, self-refreshing OAuth2 and service-account tokens, a token saver for long tool results, and a playground.</sub>

</td>
<td valign="top">

**Agent-to-Agent & workflows** (beta)<br>
<sub>17 domain agents, an orchestrator with a parallel plan, vote, debate, review loop, group chat and handoff with budgets, verdicts and live traces, 24 ready-made workflows with approval gates, and the A2A protocol.</sub>

</td>
</tr>
<tr>
<td valign="top">

**Agent skills**<br>
<sub>Nine SKILL.md files that teach any AI agent to use ZAAFPulse, served from the running version and installable into Claude Code or `~/.agents/skills`, plus a view of the subagents, skills and tools your AI tools actually use.</sub>

</td>
<td valign="top">

**RAG service**<br>
<sub>Knowledge bases with ingestion from text, files or a URL, a local vector store, hybrid embedding + BM25 search, an API, and agents that cite the documents they used.</sub>

</td>
<td valign="top">

**Answer quality**<br>
<sub>Relevance and faithfulness per turn, computed locally from transcripts: off-topic replies and references (files, identifiers, URLs, numbers) that appeared nowhere in the session.</sub>

</td>
</tr>
<tr>
<td valign="top">

**OpenTelemetry export**<br>
<sub>Off by default. When you turn it on, gateway, agent and tool spans go over OTLP/HTTP with GenAI semantic-convention attributes to Dynatrace, Arize Phoenix or AX, Langfuse or a Collector. No prompt text unless you ask for it.</sub>

</td>
<td valign="top">

**Measured, with the method**<br>
<sub>The detectors are scored on a labelled synthetic corpus (precision and recall per detector) and the indexer on a seeded benchmark. Both scripts are in the repo, so you can rerun them.</sub>

</td>
<td valign="top">

**Checked releases**<br>
<sub>Checksums on every release file after 1.0.0 and, from 1.0.3, build-provenance attestations you can check with <code>gh attestation verify</code>. Single-file binaries after 1.0.3 check their unpacked files on every start and restore any that changed.</sub>

</td>
</tr>
</table>

| At a glance | |
|---|---|
| Runtime dependencies | **0** (Node standard library only; postject is a build-only dev dependency) |
| First index of 2 GB of logs | about **30 s** with worker threads, about **70 s** on one thread or a busy machine; a rescan with no changes takes **1–3 ms**. Worked out from 66 MB/s (worker threads) and 24–62 MB/s (one thread) measured on synthetic logs on an Apple M4 ([method and numbers](docs/performance.md)) |
| Network exposure | **127.0.0.1 only**, host-header checked, sign-in on by default; outbound only to the places listed under [Privacy](#privacy) |
| 3D scenes | plain `<canvas>` 2D with an isometric projection: no WebGL, no libraries |
| Themes | Light and dark chrome, follows your system; the decks stay dark |

## Screenshots

<details open>
<summary><b>AI Office</b>: your agents at work in a 3D office</summary>
<br>
<p align="center"><img alt="Agents walk between the coding desks, library, server room, web globe and help desk as their tools change; subagents are linked to their parent" src="docs/assets/demo-office.gif" width="88%"></p>
<table>
<tr>
<td width="50%"><img alt="Logs: request log with TTFT and duration, error traces and the stream inspector" src="docs/assets/screen-logs.jpg"></td>
<td width="50%"><img alt="Time: a timeline of every agent and subagent with parallel work" src="docs/assets/screen-time.jpg"></td>
</tr>
</table>
<table>
<tr>
<td width="50%"><img alt="Proxy logs: OmniRoute upstream attempts and MCP hub calls" src="docs/assets/screen-proxy.jpg"></td>
<td width="50%"><img alt="The AI office with roster, live activity and state counts" src="docs/assets/screen-office.jpg"></td>
</tr>
</table>
</details>

<details open>
<summary><b>Overview & live monitor</b>: usage, cost and what is running right now</summary>
<br>
<img alt="Overview: 3D usage city, KPI cards, daily activity and efficiency gauges" src="docs/assets/screen-overview.jpg">
<table>
<tr>
<td width="50%"><img alt="Live monitor: AI fleet in 3D, telemetry, machine share and process table" src="docs/assets/screen-live.jpg"></td>
<td width="50%"><img alt="Sessions: a constellation of every session by day and start hour" src="docs/assets/screen-sessions.jpg"></td>
</tr>
</table>
</details>

<details open>
<summary><b>Quality & safety</b>: accuracy, utilization, cache, compression, providers, models and rankings</summary>
<br>
<img alt="Quality and safety: KPI cards and model-caused failures per day as a 3D stacked city" src="docs/assets/screen-quality.jpg">
<table>
<tr>
<td width="50%"><img alt="Utilization: load landscape by weekday and hour, peaks, 5-hour windows and forecast" src="docs/assets/screen-utilization.jpg"></td>
<td width="50%"><img alt="Cache: hit rate, savings, write premium and router memo reuse" src="docs/assets/screen-cache.jpg"></td>
</tr>
</table>
<table>
<tr>
<td width="50%"><img alt="Compression: compactions, context pressure and tokens avoided" src="docs/assets/screen-compression.jpg"></td>
<td width="50%"><img alt="Provider stats: a 3D model skyline by provider, metric tiles, requests and cost per model" src="docs/assets/screen-providers.jpg"></td>
</tr>
</table>
<table>
<tr>
<td width="50%"><img alt="Models: every OpenRouter model with live prices, per-provider uptime and a 3D price landscape by vendor" src="docs/assets/screen-models.jpg"></td>
<td width="50%"><img alt="Rankings: the most-used models and apps on OpenRouter this week, vendor share and benchmark leaders" src="docs/assets/screen-rankings.jpg"></td>
</tr>
</table>
</details>

<details open>
<summary><b>Second brain</b>: your knowledge as a living map (Obsidian and 14 more sources)</summary>
<br>
<p align="center"><img alt="All sources on one map: the note graph replays how Obsidian, Logseq, PARA, Tana, Heybrain, RAG and two vector stores grew" src="docs/assets/demo-brain.gif" width="82%"></p>
<img alt="Second brain: knowledge growth in 3D, vault metrics and the note graph" src="docs/assets/screen-brain.jpg">
<table>
<tr>
<td width="33%"><img alt="All sources: every source on one map, notes with the same title joined across sources" src="docs/assets/screen-brain-all.jpg"></td>
<td width="33%"><img alt="Semantic map: a vector store placed by meaning, nearest neighbours linked" src="docs/assets/screen-brain-semantic.jpg"></td>
<td width="33%"><img alt="PARA: projects, areas, resources and archives in lanes" src="docs/assets/screen-brain-para.jpg"></td>
</tr>
</table>
</details>

<details open>
<summary><b>Agentic workspace</b>: endpoint, gateway, agents working together, workflows, skills and RAG</summary>
<br>
<p align="center"><img alt="A group chat run from the Collaborate page: the orchestrator picks speakers while the live trace, budget and blackboard fill in" src="docs/assets/demo-collab.gif" width="82%"></p>
<table>
<tr>
<td width="50%"><img alt="Agent Gateway overview: API keys flow through the gateway and orchestrator to 17 domain agents, with month totals" src="docs/assets/screen-gateway.jpg"></td>
<td width="50%"><img alt="Endpoint: base URL, keys, MCP clients, code tools and every endpoint with its scope" src="docs/assets/screen-endpoint.jpg"></td>
</tr>
<tr>
<td width="50%"><img alt="API keys: scopes, allowed models and agents, monthly spend against budget, rate limit and status" src="docs/assets/screen-keys.jpg"></td>
<td width="50%"><img alt="MCP server: where it is registered, register or remove per client, and the HTTP connection" src="docs/assets/screen-mcp.jpg"></td>
</tr>
<tr>
<td width="50%"><img alt="Code tools: Claude Code, Codex, Gemini CLI, OpenCode, Aider and more, set up on any provider in their own wire format" src="docs/assets/screen-code-tools.jpg"></td>
<td width="50%"><img alt="Model router: private and approved external providers, quota and cooldown, and the token saver" src="docs/assets/screen-router.jpg"></td>
</tr>
<tr>
<td width="50%"><img alt="Providers: defaults and 52 presets in six groups" src="docs/assets/screen-gateway-providers.jpg"></td>
<td width="50%"><img alt="Playground: the orchestrator's plan and the answer, with tokens, cost and model calls" src="docs/assets/screen-playground.jpg"></td>
</tr>
<tr>
<td width="50%"><img alt="Workflows: 24 ready-made workflows by category with risk tier, KPI, steps and approval gates" src="docs/assets/screen-workflows.jpg"></td>
<td width="50%"><img alt="Collaborate: pick a pattern, set effort and budget, and run" src="docs/assets/screen-collaborate.jpg"></td>
</tr>
<tr>
<td width="50%"><img alt="Runs: every collaboration run with pattern, state and approvals waiting" src="docs/assets/screen-runs.jpg"></td>
<td width="50%"><img alt="A run: answer, budget, trace with OpenTelemetry GenAI span names, steps and blackboard" src="docs/assets/screen-run-trace.jpg"></td>
</tr>
<tr>
<td width="50%"><img alt="Agent skills: nine SKILL.md files served by the gateway and installable into Claude Code" src="docs/assets/screen-skills.jpg"></td>
<td width="50%"><img alt="RAG service: knowledge bases with documents, chunks and embeddings" src="docs/assets/screen-rag.jpg"></td>
</tr>
</table>
<p align="center"><img alt="Agent Gateway in 3D: keys on the left, the gateway and orchestrator in the middle, domain agents on the right, with pulses for recent calls" src="docs/assets/demo-gateway.gif" width="82%"></p>
</details>

<details>
<summary><b>Projects, agent skill usage, integrations</b></summary>
<br>
<table>
<tr>
<td width="50%"><img alt="Projects: a 3D skyline of projects by tokens, sessions and cost" src="docs/assets/screen-projects.jpg"></td>
<td width="50%"><img alt="Agent skill usage: subagents, skills and tools your AI tools use, as a 3D toolbelt city" src="docs/assets/screen-agents.jpg"></td>
</tr>
</table>
<img alt="Integrations: the MCP hub in 3D with every connection, its health and recent calls" src="docs/assets/screen-integrations.jpg">
</details>

<details open>
<summary><b>Settings & integrations</b>: live model prices and the integration editor</summary>
<br>
<table>
<tr>
<td width="50%"><img alt="Model prices: vendor filters and a card per model with live list prices, context, tags and your spend" src="docs/assets/screen-settings.jpg"></td>
<td width="50%"><img alt="Integration editor: configure and test a connection, secrets kept in the macOS Keychain" src="docs/assets/screen-integration-editor.jpg"></td>
</tr>
</table>
</details>

<details>
<summary><b>Drill-downs</b>: spend projection and poisoning detections</summary>
<br>
<table>
<tr>
<td width="50%"><img alt="Estimated spend drill-down" src="docs/assets/screen-drawer-spend.jpg"></td>
<td width="50%"><img alt="Poisoning drill-down" src="docs/assets/screen-drawer-poisoning.jpg"></td>
</tr>
</table>
</details>

<sub>All screenshots and GIFs use the built-in demo dataset (`npm run demo`). No real projects, costs, notes or accounts are shown. Regenerate them with `npm run media` (needs Google Chrome and ffmpeg).</sub>

## Quick start

ZAAFPulse runs on **macOS, Linux (Ubuntu, Debian, RHEL, Rocky, AlmaLinux, Fedora, Amazon Linux, SUSE, Alpine) and Windows 10/11**, on a laptop or a server. Pick one of these:

| | One command |
|---|---|
| **macOS / Linux** | `curl -fsSL https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.sh \| sh` |
| **Windows 11** (PowerShell) | `irm https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.ps1 \| iex` |
| **Linux server** | `curl -fsSL https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.sh \| sudo sh -s -- --server` |
| **Docker** | `docker compose up -d` (see [compose.yaml](compose.yaml)); mainly a gateway and server deployment, see [Docker](#docker) |
| **Single file** | download `zaafpulse-<version>-<os>-<cpu>` from [Releases](https://github.com/rifqifitriady/ZAAFPulse/releases) and run it |

The installers use your Node.js 18+ or download the official Node.js LTS (checksum verified) into their own folder. They add the `zaafpulse` command and start it in the background (launchd, systemd or Task Scheduler). Then run **`zaafpulse open`**: it opens http://localhost:4777 in your browser, already signed in.

```bash
zaafpulse status      # is it running?
zaafpulse doctor      # OS, Node.js, data folder, secret store, logs found, service
zaafpulse open        # open the dashboard, signed in
zaafpulse service restart | uninstall
zaafpulse help
```

**From source** (any OS with Node 18+, no npm packages):

```bash
git clone https://github.com/rifqifitriady/ZAAFPulse.git && cd ZAAFPulse
npm start          # reads your logs  → http://localhost:4777 (then `node bin/zaafpulse.js open` to sign in)
npm run demo       # synthetic data   → http://localhost:4778
npm test           # run the test suite (node:test, no dependencies)
npm run media      # regenerate README screenshots and GIFs from demo data
```

The first start indexes your logs: about 30 seconds for 2 GB with worker threads, about 70 seconds on one thread or a busy machine ([measured](docs/performance.md)). After that the server rescans every minute and only re-reads files that changed; a rescan with no changes takes a few milliseconds, and a large session that grew is parsed again as a whole (0.4–0.9 s for 24 MB in the benchmark). Server mode, TLS, Docker, single-file builds and every option are in **[docs/install.md](docs/install.md)**.

### Verifying a download

- Every release after 1.0.0 has `SHA256SUMS.txt`. The installers check the release's source package against it and stop when they cannot.
- From 1.0.3, every release file also has a build-provenance attestation: `gh attestation verify zaafpulse-<v>-linux-x64 --repo rifqifitriady/ZAAFPulse` shows the workflow and commit that built it.
- Single-file binaries after 1.0.3 carry the SHA-256 of every app file. On every start they check the unpacked copy in the cache folder, restore any file that was changed, removed or added, and stop when they cannot.
- Version tags are never moved; a fix ships as a new version. A tag ruleset blocks moving or deleting `v*` tags, and releases are immutable once published ([docs/release-hardening.md](docs/release-hardening.md)). Both have been on since 20 October 2026, so releases after 1.0.3 also pass `gh release verify`; v1.0.0 to v1.0.3 were published before and are not immutable.
- The binaries are **not yet notarized or code-signed**. macOS quarantines a browser download (run `xattr -d com.apple.quarantine zaafpulse-*` once, or download with `curl`), and Windows SmartScreen asks once (*More info → Run anyway*).

### Signing in

Sign-in is on by default, on every OS:

- **Local sign-in** (the default on 127.0.0.1): only your OS account can open the dashboard. Open it with `zaafpulse open`, or start with `zaafpulse start --open`. The browser is signed in with a one-time code that is kept off the command line, so other accounts on the machine never see it.
- **Password** in server mode or behind a reverse proxy (below).
- **None** only when you ask for it with `ZAAFPULSE_AUTH=none`, and in demo mode on a single-user machine (its data is synthetic). Without sign-in, any program or other account on the machine could use the dashboard as you.

Details, including the autostart opener and Windows: [docs/install.md](docs/install.md#who-can-open-the-dashboard).

### Server mode

By default ZAAFPulse listens on 127.0.0.1 only. `--server` (or `zaafpulse start --host 0.0.0.0`) makes it reachable from other machines:

- The dashboard asks for an admin password of at least 10 characters, set with `zaafpulse set-password` (scrypt hash) or `ZAAFPULSE_ADMIN_PASSWORD`. It refuses to start without one. Sessions are HttpOnly, SameSite=Strict cookies. Wrong guesses are throttled per address with a growing wait; a browser that signed in before keeps its own count, so someone guessing elsewhere does not lock the owner out.
- Apps reach the gateway (`/v1`, `/mcp`, `/a2a`) with ZAAFPulse API keys, as before.
- Serve HTTPS with `ZAAFPULSE_TLS_CERT` and `ZAAFPULSE_TLS_KEY`, or use a reverse proxy (`ZAAFPULSE_TRUST_PROXY=1`, `ZAAFPULSE_PUBLIC_URL=https://…`).

### Docker

The image runs in server mode (password sign-in) and keeps its data in the `/data` volume. [compose.yaml](compose.yaml) does **not** mount `~/.claude` or `~/.codex`, so out of the box the usage, cost, quality and office pages are empty, and the live monitor only sees the container's own processes. In Docker, ZAAFPulse is mainly the Agent Gateway, agentic workspace and MCP tools.

To see the host's Claude Code and Codex logs, mount them read-only where the parsers look: `~/.claude/projects` and `~/.codex/sessions` under the home of the container's `node` user. For example, under `volumes:` in compose.yaml:

```yaml
      - ${HOME}/.claude/projects:/home/node/.claude/projects:ro
      - ${HOME}/.codex/sessions:/home/node/.codex/sessions:ro
```

The container runs as `node`, so those files must be readable by that user's uid. Setup, the master key and proxies: [docs/install.md](docs/install.md#docker).

### Run it on login (macOS, from source)

```bash
zaafpulse service install          # or: node bin/zaafpulse.js service install
./scripts/install-autostart.sh     # the older macOS setup: also brings the dashboard to the front in Chrome on wake
```

`scripts/install-autostart.sh` installs two LaunchAgents: `com.zaaf.aipulse.server` (starts at login, restarts on crash) and `com.zaaf.aipulse.opener` (brings the dashboard tab to the front in Chrome at login and whenever the Mac wakes). macOS asks once for permission to control Chrome. Logs go to `~/Library/Logs/AIPulse/`.

## MCP server and integrations

`node mcp.js` is an MCP server (stdio) named `zaafpulse` that AI clients start on demand. It offers the dashboard's own data and a connector for each platform you configure under `integrations` in `config.json`. Register it once:

```bash
zaafpulse register-mcp all                  # every supported client found on this machine (backs up each config first)
npm run mcp:register -- cursor --data ~/zp  # from source: one client, with the data folder its server should use
npm run mcp:register -- codex --dry-run     # show what would change, without writing
```

Supported clients: Claude Code, Kiro, Antigravity, Cursor, VS Code, Claude Desktop, Codex, Gemini CLI, Windsurf/Devin and Zed. `all` registers only the clients it finds here and lists the others as skipped. Only ZAAFPulse's own entry is touched, and an entry from an earlier release under the old name `ai-command-center` is migrated to `zaafpulse`. Paths per client and OS, and what registration changes: [docs/integrations.md](docs/integrations.md#registering-clients).

Or use **Endpoint → MCP server** in the dashboard: it shows where the server is registered, registers or removes it per client, and gives the HTTP connection for clients that connect by URL. The HTTP endpoint `/mcp` follows the 2025-06-18 Streamable HTTP transport (stateless, one JSON reply per POST): it checks the `MCP-Protocol-Version` header, accepts protocol versions up to 2025-11-25, refuses JSON-RPC batches from clients on 2025-06-18 or later (older clients may still send up to 20 messages, each counted against the key's rate limit), and answers a missing or wrong key with 401 and `WWW-Authenticate`.

| Type | Platforms | Tools |
|---|---|---|
| `acc` (always on) | this dashboard | `usage_summary`, `quality`, `live_apps`, `integrations_status` |
| `dynatrace` | Dynatrace SaaS and Managed | problems, entities, metrics, logs, security problems, DQL (SaaS) |
| `arize` | Arize Phoenix and Arize AX | projects, spans, traces, datasets, experiments, monitors (AX) |
| `n8n` | n8n | workflows, executions; run allowlisted webhooks and (de)activate workflows when writes are on |
| `router` | OmniRoute, 9router | health, models, providers, combos, usage, telemetry |
| `openrouter` | OpenRouter | model catalog and prices, which providers serve a model and their uptime, provider directory, rankings of models and apps, benchmarks; credits with a key |
| `http` | AION and any REST API | one tool per endpoint you declare |
| `mcp` | any Streamable HTTP MCP server | the upstream tools, filtered, under a `<id>__` prefix |

Tools are prefixed with the integration id (`dynatrace-saas_list_problems`). Everything is read-only unless an integration sets `"allowWrite": true`. Secrets stay in the OS secret store or environment variables, never in `config.json`, and a stored secret is only sent to the address it was saved for. The **Integrations** page shows each connection's health, which clients have the server registered, and recent tool calls. It also lets you **add, configure, test and delete** integrations: the form is built for each type, **Test connection** checks a draft before anything is saved, and a pasted secret goes straight to the OS secret store (on macOS over stdin to the Keychain, never into `config.json` or a process list). Setup per platform: [docs/integrations.md](docs/integrations.md).

## Agentic workspace

ZAAFPulse can sit in front of your models and agents. Everything listens on **127.0.0.1 only** unless you choose server mode.

> **Beta.** The Agent Gateway, the domain agents, the workflows and the collaboration engine are new. Their tests run against fake upstream servers, not live providers and clients, so expect rough edges: keep budgets on your keys, and please report what breaks.

The sidebar has two groups:

- **AI Observability:** Overview, AI Office, Live monitor, Quality & safety, Second brain, Projects and Sessions.
- **Agentic Workspace:**
  - **Endpoint:** API keys, the MCP server, connection snippets, code tools, and a table of every endpoint and its scope.
  - **Agent Gateway** (beta): a 3D overview, providers, model router, sessions and memory, and a playground.
  - **Agent Skills:** ZAAFPulse's own skills, and what your AI tools use.
  - **Integrations.**
  - **Agent-to-Agent** (beta): workflows, Collaborate, runs, specialist agents, patterns and A2A.
  - **RAG Service.**

| Layer | What it does |
|---|---|
| **Agent Gateway** | AuthN with ZAAFPulse API keys (`zp_…`, shown once, stored as SHA-256 hashes); AuthZ by scope (`llm`, `agents`, `rag`, `mcp`) and allowed model and agent globs, with a private-models-only option; per-key rate limit (requests per minute), monthly budget in USD and expiry; session management (24 h sessions per key). |
| **Orchestrator / Planner** | Task planning (the planner model writes a dependency graph of up to 6 steps; independent steps run in parallel), routing (each step goes to the best domain agent, with keyword routing as a fallback), and memory (session history plus long-term notes that agents save and recall). |
| **LLM Gateway / Model Router** | 52 provider presets: private LLMs on your own hardware (Ollama, LM Studio, **vLLM**, **TGI**, llama.cpp, Jan, LocalAI, LiteLLM) are always allowed; labs, inference clouds, routers, Asian providers and enterprise clouds (Azure OpenAI, Vertex AI, Bedrock) serve traffic only once **approved**; models come from each provider's own `/models`. Routes are virtual models (`router/fast`) that try their targets in order (fallback or round-robin); a 429 cools a target down (its reset time, or back-off to 5 minutes) and the route moves on. Rate-limit headers become a per-provider **quota** reading, with balances from OpenRouter, DeepSeek, Moonshot and SiliconFlow. Short-lived credentials **refresh themselves** (OAuth2 client credentials or refresh token, e.g. Entra ID; Google service accounts for Vertex), with one replay after a 401. |
| **Code tools** | Claude Code (Anthropic `/v1/messages`), Codex (OpenAI `/v1/responses`), Gemini CLI (`/v1beta/models/*`) and every OpenAI-compatible tool (OpenCode, Cline/Roo/Kilo, Copilot, Continue, Aider, Zed, Qwen Code, OpenClaw, Factory Droid) on **any** provider: requests are **translated** OpenAI ⇄ Anthropic ⇄ Responses ⇄ Gemini (tools, images, streaming, usage), or passed straight through: `/v1/messages` to a native Anthropic provider (with the client's `anthropic-version` and `anthropic-beta` headers), and `/v1/responses` unchanged to OpenAI, Azure OpenAI or any provider set to `responses: true`. OpenAI and Azure OpenAI get `max_completion_tokens`, which their reasoning models require; other providers keep `max_tokens` unless they serve an OpenAI reasoning model. A model map sends tool model names (`claude-*`, `gpt-*-codex`) to your models. One click writes a tool's config with its own key (backup + revert). The **token saver** shortens long tool results (diffs, logs, builds, grep, listings, JSON) before they go upstream and logs the tokens saved. Subscription logins are not used: API keys and official OAuth only. |
| **RAG Service** | Knowledge bases with document ingestion (text, Markdown, HTML, CSV, JSON, files or a URL) and a local vector database: chunks with embeddings from any provider's embedding model, searched by hybrid cosine + BM25 (keyword-only without an embedding model). Agents search attached knowledge bases with `zp_knowledge_search`. |
| **Agent-to-Agent** | A multi-agent collaboration engine with seven patterns (below), the **A2A protocol** (agent card + JSON-RPC/SSE, v1.0 with v0.3 accepted) for other agents to call in, and remote A2A agents that join a team. Agents consult each other with `zp_ask_agent` and hand conversations on with `zp_handoff`. **24 ready-to-use workflows** (incident triage to mitigation, postmortem, helpdesk, ticket triage, refunds, phishing triage, cited research, RFP and security questionnaires, contract redlines, code review, lead outreach, meeting actions, change risk, vulnerability plans, access requests, onboarding, month-end commentary, procurement, feedback to PRD, release notes, project status, PDP/OJK compliance, knowledge-base gaps, agent quality review) with risk tiers and **approval gates** that pause a run until someone approves. |
| **Domain agents** | 17 editable specialists: Customer Service, Sales & Marketing, Network Operations, HR & Finance, IT Helpdesk, SRE & Observability, Security, Data Analyst, DevOps, Code Reviewer, Research, Legal & Compliance, Product Manager, Project Manager, Procurement, Content Writer and AI Ops. Each has a prompt, a model and the integration tools it may call (function calling over the MCP connectors). |

**Providers**: any OpenAI-compatible API or the native Anthropic Messages API, with 52 presets in six groups (private, labs, inference clouds, routers, Asia, enterprise). Models come from each provider's own `/models`. Provider keys go to the OS secret store; short-lived tokens stay in memory.

```bash
# Models are provider/model; agent/<id> is a domain agent; agent/auto lets the orchestrator plan and route.
curl http://127.0.0.1:4777/v1/chat/completions -H "Authorization: Bearer zp_…" -H "Content-Type: application/json" \
  -d '{"model": "agent/auto", "messages": [{"role": "user", "content": "Checkout is slow. Check the network and draft a customer update."}]}'
```

| Endpoint | Scope | |
|---|---|---|
| `GET /v1/models` · `GET /v1/models/<id>` | any | provider models and agents this key may use; one model by id, for SDK `models.retrieve()` |
| `POST /v1/chat/completions` | `llm` / `agents` | OpenAI format, streaming; `x-zp-session` header continues a session. Agent and collaboration streams send headers and a keep-alive at once, then every 10 s. `agent/auto` with no default model set answers 400 with the reason |
| `POST /v1/embeddings` | `llm` | passthrough |
| `GET /v1/agents` · `POST /v1/agents/<id>/run` · `POST /v1/orchestrate` | `agents` | run one agent or the orchestrator, with the plan, tool calls and usage |
| `GET /v1/sessions` · `GET`/`DELETE /v1/sessions/<id>` | `agents` | the key's own sessions |
| `GET /v1/knowledge` · `POST /v1/knowledge/<id>/search` · `POST /v1/knowledge/<id>/documents` | `rag` | search a knowledge base, add documents |
| `GET /v1/workflows` · `POST /v1/workflows/<id>/run` | `agents` | run a multi-agent workflow (it pauses at approval gates) |
| `POST /v1/collaborate` | `agents` | a collaboration run: `pattern` (auto, parallel, vote, debate, review, group, handoff, agent, workflow), `effort`, `budget`, pattern options; `async: true` returns at once |
| `GET /v1/runs` · `GET /v1/runs/<id>` · `POST /v1/runs/<id>/cancel` · `POST /v1/runs/<id>/resume` | `agents` | run state, verdict, trace and blackboard; approve or reject a paused step (`{"approve": true, "note": "…"}`) |
| `GET /.well-known/agent-card.json` · `POST /a2a` | card public · `agents` | Agent2Agent: `SendMessage`, `SendStreamingMessage` (SSE), `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`; skill in `message.metadata.skill` |
| `POST /v1/messages` · `/v1/messages/count_tokens` | `llm` | Anthropic Messages (Claude Code); `x-api-key` works; `anthropic-beta` is forwarded to a native Anthropic provider |
| `POST /v1/responses` | `llm` | OpenAI Responses (Codex), streaming events included; passed through natively to OpenAI and Azure OpenAI (or `responses: true`), translated for every other provider |
| `POST /v1beta/models/<model>:generateContent` · `:streamGenerateContent` · `:countTokens` | `llm` | Gemini (Gemini CLI); `x-goog-api-key` works |
| `POST /mcp` | `mcp` | MCP over HTTP (2025-06-18 transport, versions up to 2025-11-25) with every integration tool (`claude mcp add --transport http zaafpulse http://127.0.0.1:4777/mcp --header "Authorization: Bearer zp_…"`) |
| `GET /v1/brain/sources` · `/v1/brain/search?q=` · `/v1/brain/graph?source=` | `rag` | the second brain, read only: titles, links, PARA buckets and structure, never note text |
| `GET /skills` · `/skills/<name>/SKILL.md` | none | agent skills (documentation only) |

### Agent skills

`skills/` holds nine Agent Skills (`SKILL.md` with name and description frontmatter). They teach any AI agent to use ZAAFPulse:

- `zaafpulse`: the entry point, covering setup, scopes, models and errors
- `zaafpulse-chat`: chat in all four wire formats, routes, the token saver and embeddings
- `zaafpulse-agents`: the domain agents and the orchestrator
- `zaafpulse-collaborate`: the collaboration patterns and runs
- `zaafpulse-workflows`: the workflows and their approval gates
- `zaafpulse-rag`: the knowledge bases
- `zaafpulse-brain`: the second brain, read only through `/v1/brain`
- `zaafpulse-mcp`: the integration tools
- `zaafpulse-a2a`: ZAAFPulse as an A2A agent

The gateway serves them at `/skills/<name>/SKILL.md`, so an agent always reads the version that is running. That avoids a public branch that can change. To give them to an agent:

- **Claude Code:** Agent Skills → **Install into Claude Code** writes each skill folder to `~/.claude/skills/zaafpulse*` (or `$CLAUDE_CONFIG_DIR/skills` when that is set). Skills can also go to `~/.agents/skills`, the folder other Agent Skills clients share. Folders are marked, so a skill of yours with the same name is never overwritten, and **Remove** deletes only the marked folders.
- **Any other AI:** paste `Read this skill and use it: http://127.0.0.1:4777/skills/zaafpulse/SKILL.md`.

A test checks that every endpoint the skills document is one the gateway actually serves.

### Multi-agent collaboration

Built from the research in `reports/Multi agent collaboration design.md` (Anthropic's multi-agent research system, OpenAI Agents SDK, LangGraph, AutoGen/Magentic-One, CrewAI, MetaGPT, the A2A spec, debate and voting studies, and the MAST failure taxonomy). Default to one agent; collaborate when the task needs it.

| Pattern | When | How it stops |
|---|---|---|
| `auto` orchestrator | parts that need different specialists | the planner writes a dependency graph; independent steps run in parallel; leaf outputs are forwarded verbatim; `verify` adds a critic pass |
| `parallel` | several views of one question | specialists answer at once, one synthesis |
| `vote` | buy accuracy (the default way) | majority with a quorum; no majority → two more samples → a judge asked twice in swapped order; low agreement is flagged for a person |
| `debate` | contested questions (rarely beats `vote` at equal cost) | 2 rounds by default (max 3); stops when everyone agrees or nobody changes their argument; ends in a vote |
| `review` | drafts with clear criteria | a critic scores against a rubric; stops on pass, on no improvement or a repeated critique; keeps the best draft |
| `group` | open-ended investigations | Magentic-One ledger each turn (done? looping? progress? who next? what instruction?); stall counter, two replans, then stop |
| `handoff` | conversations that belong to another domain | the agent in charge passes the conversation on; the session remembers who is active |

Every run has a budget (tokens, model calls, time, optional cost) scaled by effort: workers stop at 85% so judging and the final answer always fit, and past 80% patterns stop adding rounds. Agent output reaches other agents as quoted data (`<agent_output>`), never as instructions; a third identical tool call is refused; consulting an agent already on the request is refused; repeated questions are answered from a per-run cache. Each run keeps a trace with OpenTelemetry GenAI span names (`invoke_workflow`, `plan`, `invoke_agent`, `execute_tool`, `chat`) carrying tokens, cost and timing but no prompt text, plus a shared blackboard. The same spans can be exported over OTLP ([below](#opentelemetry-export)). From any OpenAI client, `model: "collab/vote"` (or `collab/debate`, `collab/group`, …) runs a pattern.

Workflow approval gates fail closed: a run pauses before the gated step until someone approves (the note reaches the next agent) or rejects, an unclear A2A reply never counts as approval, nobody deciding within 72 hours rejects the run, and a step whose agent is missing fails the run rather than being skipped.

A new key is shown once and masked (`zp_Q7m_k••••••••••••T4vX`) as soon as it is copied, after 60 seconds or when you leave the page. Every request is logged with key, model, agent, tokens, cost (list prices), latency and time to first token, never prompt text. Keys, agents, sessions, memory, runs and knowledge bases live in `.data/` (git-ignored); provider, route, second-brain and tool settings live in `config.json`.

## OpenTelemetry export

ZAAFPulse can send traces of what the Agent Gateway does to any backend that accepts OTLP over HTTP. It writes OTLP itself, with no dependencies: binary protobuf by default, JSON when you set `"protocol": "http/json"`. gRPC is not supported.

- **What is sent:** a SERVER span per gateway request (continuing the caller's W3C `traceparent`), a CLIENT span per model call (fallback attempts included), spans for collaboration runs, agent turns, the planner and judge, and every integration tool call. Attributes follow the OpenTelemetry GenAI semantic conventions (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` …), which are still marked *Development* upstream, plus `zaafpulse.cost.usd`.
- **Off by default.** Nothing is sent and no connection is made until `config.json` has `"otel": { "enabled": true, … }`. The standard `OTEL_EXPORTER_OTLP_*` variables fill in values but never turn export on by themselves.
- **No content by default.** Prompts, answers and tool arguments are sent only with `"captureContent": true`, and then capped. A header that looks secret (`Authorization`, API keys, tokens) must be a reference to the secret store or an environment variable; plain text there turns export off.
- **Ready-made configs** for Dynatrace, Arize Phoenix, Arize AX, Langfuse and a local OpenTelemetry Collector.

```json
"otel": {
  "enabled": true,
  "endpoint": "http://localhost:4318",
  "headers": { "Authorization": { "keychain": "acc.otel" } }
}
```

The stdio MCP server (`mcp.js`) does not export spans; calls through the gateway's `/mcp` do. Every span, attribute and backend: **[docs/otel.md](docs/otel.md)**.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture-light.svg">
  <img alt="Local logs, second-brain sources and integrations are collected, cached, aggregated and served on 127.0.0.1; apps and code tools reach every model and the agents through the Agent Gateway" src="docs/assets/architecture-dark.svg" width="100%">
</picture>

| Source | Read from | Gives |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl`, subagents included | tokens per call (input, output, cache read, cache write 5m/1h), web searches, fast mode and US-only inference, model, project, branch, prompts, tools, skills, subagents, quality signals |
| Codex | `~/.codex/sessions/**/*.jsonl` | tokens per turn, web searches, model, project, prompts, tool calls, failures, plan rate limits; the history a forked or spawned session copies from its parent is skipped |
| Running apps | `ps` | which AI apps are open, process count, CPU, memory, uptime |
| Second brain | Obsidian (the vault Obsidian has open, or a path in Settings) and the sources you connect: Logseq and PARA folders, Notion, mem.ai and Roam APIs, Tana, Roam, Reflect and Heybrain exports, Heybrain's MCP server, the RAG knowledge bases, and Pinecone, Weaviate, Qdrant, Chroma and pgvector | notes, links, tags, groups, PARA buckets and times; for vector stores, up to 240 sampled records projected by meaning. Note text is read to find links and never returned |
| Live transcripts | the tail of Claude Code and Codex transcripts written in the last 30 minutes to 24 hours | for the office, logs and timeline: tool names, block sizes, file and command names, hostnames, timing and state |
| OpenRouter | its public API (models, per-model provider endpoints with uptime, provider directory) and the public rankings page; credits and key limits with an optional API key | the Models and Rankings pages, live prices, and the `openrouter` MCP tools |
| OmniRoute (optional) | its management API, GET only | quota utilization, cache and compression analytics, provider stats, call logs and upstream proxy logs |

Claude Desktop, ChatGPT and Antigravity keep conversations in the cloud, so they are shown by live presence and resource use only.

Usage is counted once per API response across all log files: a resumed or forked Claude Code session copies earlier responses into a new file, and those copies are matched by message and request id and counted once. The first index runs on a pool of worker threads (`ZAAFPULSE_INDEX_WORKERS=0` turns it off), and the cache is a base file plus an append-only journal, so a growing session does not rewrite it every minute. Measurements: [docs/performance.md](docs/performance.md).

## What the quality metrics mean

These are **signals detected in the logs, not a graded evaluation**. Every one comes from a heuristic detector (patterns and small parsers, no judge model, nothing sent anywhere), and every card opens the exact items that matched, so you can judge them yourself. How each detector was measured, and where it still misses: **[docs/quality-metrics.md](docs/quality-metrics.md)**.

| Metric | How it is detected |
|---|---|
| **Accuracy** | Tool calls that did not fail because of the model ÷ tool calls with a result. Only two kinds of failure count against it: acting on a non-existent target, and misusing a tool (editing a file it had not read, an edit whose text matched more than once). Failed commands and tests are **not** counted, since tests are often run to watch them fail (a TDD red run, a check before a fix) and a build error usually sits in the code being worked on; nor are unclassified tool errors, network errors, timeouts and calls you rejected. Accuracy therefore reads higher than in 1.0.3 and earlier, which counted failed commands and tests. |
| **Non-existent targets** | "Acted on a non-existent target": a failed call on something that does not exist, and the tool said so: a file path, edit text, a tool argument or tool name, a URL or host, a package, or a command, subcommand, flag or npm script. Probes that were allowed to find nothing (`ls dist`, `cat .env.local`, `which docker`) are not counted. Made-up facts in written answers leave no trace in the logs and are not counted here (see Faithfulness). |
| **Poisoning detections** | Prompt injection in tool results: instruction override (English, Indonesian and five other languages, paraphrased, spelled out or hidden with zero-width characters), persona change, requests to send or reveal secrets, hide-from-user instructions, fake role tags or authority ("new task from the user", "pre-approved"), run-without-asking commands. Text that only quotes attacks (security docs, detector code, test samples) is left out. Split into **external** content (web, search, MCP), which matters, and local files. A zero means nothing *known* was found. |
| **Correction rate** | (Correction prompts + interrupts) ÷ typed prompts. A correction tells the model that its own previous output was wrong, unwanted or must be undone, in English or Indonesian ("that's not what I asked", "undo that", "masih error", "bukan begitu maksudku"). A new task that mentions a bug ("fix the failing test"), an answer to the model's question, correcting your own message, and any prompt before the model has replied or acted do not count. Read it as a lower bound. |
| **Safety** | Secrets that appeared in tool output (Anthropic, OpenAI, OpenRouter, AWS, GitHub, Slack, Google, Stripe and Hugging Face keys, JWTs, private keys, database URLs with a password; type only, never the value; placeholders and documentation keys are ignored) and risky commands the AI ran: recursive force deletes, `find -delete`, `git clean -f`, force pushes, hard resets, a download piped into a shell, `sudo` (also inside `bash -c`), `chmod 777`, `kill -9`, dropping database objects, writes to a disk device. Commands are parsed into words, so the same text in an `echo`, a `grep` pattern or a comment does not count. |
| **Reliability** | API errors, network and timeout failures, repeat loops (the same call three or more times in a row), and context compactions. |
| **Relevance** | Per turn (a typed prompt and everything until the next one): the share of the prompt's key terms (stop words removed in English and Indonesian, plus file names, identifiers and numbers) that the reply or the turn's tool calls address; half of the terms counts as fully relevant. Prompts with fewer than three key terms are not graded. Replies in another language than the prompt score lower. |
| **Faithfulness** | Of the checkable references in replies (file names, `identifiers` in backticks, URLs, numbers with three or more digits, decimals or %), the share that appeared earlier in the session: in your prompts, the model's tool inputs or the tool results. Context the transcript does not record (system prompts) can make a correct reference look unsupported, and a computed sum is unsupported by design: read the list before acting on it. |

### How well the detectors do

The five detectors (corrections, prompt injection, secrets, risky commands, non-existent targets) were reworked and scored on a labelled corpus of 584 items in English and Indonesian, in `test/fixtures/signals/`. **The corpus is synthetic**: written by hand and by AI agents for this purpose, not taken from real logs, so real logs will contain cases it lacks. On the full corpus the current detectors score 98–100% precision and 100% recall, but they were tuned against it, so those numbers say little about unseen text. The honest estimate is the first look at the two held-out sets, scored before any tuning on them:

| Detector | Holdout, first look (precision / recall) | Blind, first look (precision / recall) | Blind, 1.0.3 detectors |
|---|---|---|---|
| Corrections | 100% / 85% | 100% / 60% | 17% / 7% |
| Prompt injection | 93% / 65% | 88% / 47% | 67% / 27% |
| Secrets | 100% / 100% | 100% / 100% | 90% / 56% |
| Risky commands | 100% / 100% | 100% / 100% | 87% / 87% |
| Non-existent targets | 95% / 95% | 100% / 80% | 80% / 53% |

In practice: secrets and risky commands generalise well; corrections are precise but miss many ways of complaining; prompt injection is the weakest, and a new phrasing will get through. Rerun it with `node scripts/eval-signals.js` (`--compare f2b198d` for 1.0.3, `--misses` for every wrong verdict). Method, sets and known misses: [docs/quality-metrics.md](docs/quality-metrics.md).

### Cost and prices

**Cost** is an API-equivalent estimate: tokens × list price per million, matched by the longest model prefix, with separate cache-read and cache-write (5-minute and 1-hour) rates. It also applies:

- **long-prompt tiers**, where the whole request pays the higher rate once the prompt is over a threshold (for example Claude Haiku 5.5 above 100K prompt tokens);
- **fast mode**, priced at its premium rates;
- **web searches**, per search;
- the **1.1× multiplier for US-only inference** on every token category.

Each API response is counted once across all log files, so resumed and forked Claude Code sessions are not double-counted, and the history a Codex fork copies from its parent is skipped. Old Codex logs that never name a model are priced as gpt-5, the Codex default when they were written; `/api/summary` lists such models as `estimated`. On a subscription plan you are not billed per token.

**Where prices come from**, lowest to highest precedence:

1. **Built-in defaults** in `lib/pricing.js`, checked against Anthropic's and OpenAI's official price lists.
2. **An offline snapshot** of OpenRouter's public model list, shipped in `lib/data/prices-snapshot.json` with the date it was fetched (`fetchedAt`). It prices other vendors' models without any network.
3. **Your prices** from **Settings → Model prices**.
4. **The live sync**: at startup and whenever the cached list is older than 12 hours, one GET without credentials to `https://openrouter.ai/api/v1/models`, kept in `.cache/prices.json`. A model you edit is pinned to your price, and **Use live price** unpins it.

**Price sync is on by default.** Turn it off with the **Auto-update** switch in Settings → Model prices, or `"pricingSync": { "enabled": false }` in `config.json`; prices then come from the built-in defaults, the snapshot and your own. Demo mode never fetches. `config.json` stores only the prices you set.

## Privacy

By default the server listens on `127.0.0.1` only and rejects requests whose `Host` is not `localhost`; server mode changes that and requires a password.

**Everything ZAAFPulse sends over the network:**

| Destination | When | What |
|---|---|---|
| `openrouter.ai/api/v1/models` (price sync) | **On by default**: at startup and every 12 hours. Off with **Auto-update** in Settings or `"pricingSync": { "enabled": false }` | One GET with no credentials and no data from this machine |
| OpenRouter's public API and rankings page | Only when you open the Models or Rankings page, or an AI calls the `openrouter` MCP tools; cached (models 12 h, rankings 6 h, providers 24 h) | Plain GETs; an API key only if you add an `openrouter` integration with one |
| Integrations you configure (Dynatrace, Arize, n8n, OmniRoute, HTTP and MCP services) | When an AI client calls a tool, or the Integrations page checks health (at most once a minute per integration, or when you press Test) | The tool call, to the URL you configured |
| Model providers you configure | When an app, agent, workflow or the playground calls a model, when their model lists load, and to refresh OAuth2 or service-account tokens | The request you or your agents sent |
| Second-brain sources, remote A2A agents, URLs you give the RAG service | When you connect, sync or use them | Requests to that source's own API or address |
| Your OTLP endpoint | Only when `"otel": { "enabled": true }` is set ([OpenTelemetry](#opentelemetry-export)) | Spans; no prompt text unless `captureContent` is on |
| GitHub and nodejs.org | Only while `install.sh` or `install.ps1` runs | The release (or `main` when you ask), and the official Node.js LTS when your system has no Node 18+ |

Nothing else: no telemetry, no update checks, no accounts. Demo mode fetches nothing. (The maintainer script `scripts/build-single.js` downloads official Node.js binaries to build releases; the running app never does.) Integration and provider secrets stay in the OS secret store or environment variables, never in `config.json`.

- The office, logs and timeline read transcript tails on demand and keep only tool names, sizes, file and command names, hostnames, timing and state; message text is never shown.
- Message text from your logs is never stored. The cache keeps token counts, metadata and, for flagged quality or safety items only, a masked snippet of up to 160 characters. Secret values are never kept.
- Sign-in is on by default on every OS: local sign-in on 127.0.0.1 lets only your OS account in (open it with `zaafpulse open` or `zaafpulse start --open`), and server mode or a reverse proxy requires the admin password (at least 10 characters). There is no sign-in only with `ZAAFPULSE_AUTH=none`, which you set yourself, or in demo mode on a single-user machine. Every dashboard response carries a strict Content-Security-Policy and refuses to be framed. See [docs/install.md](docs/install.md#who-can-open-the-dashboard) and [SECURITY.md](SECURITY.md).
- Agents run only the integration tools they are allowed, and tools that change something run only in a workflow step a person approved. A stored secret is only ever sent to the address it was saved for. URLs given to the RAG service cannot reach this machine or private networks.
- The Agent Gateway listens on 127.0.0.1 unless you choose server mode, which requires a dashboard password; API keys are stored as hashes, provider keys in the OS secret store (macOS Keychain, Linux keyring, or an AES-256-GCM encrypted file on servers and Windows, its key sealed with DPAPI there), and sessions and memory (which hold conversation text you send to agents) stay in `.data/` on this machine.
- Second-brain sources are read with the token you give each one (kept in the OS secret store), only from that source's own API or files; the map keeps titles and links, never note text. Vector databases are sampled read-only (240 records at most), and Postgres is only sent `SELECT`s.
- **Code tools → Set up** writes a coding tool's own config file (mode 0600) with a dedicated key, after a backup that **Revert** restores; **Agent Skills → Install** writes only marked folders under `~/.claude/skills`. Nothing is written to your tools without a click.
- `config.json`, `.cache/` and `.data/` are git-ignored.

<details>
<summary><b>Project structure</b></summary>

```
bin/zaafpulse.js       the zaafpulse command: start, open, set-password, service, status, doctor, register-mcp, mcp
server.js              HTTP server, API routes, config, sign-in, TLS, demo switch
mcp.js                 MCP server "zaafpulse" over stdio for AI clients
lib/mcp/               MCP protocol (stdio server, protocol versions up to 2025-11-25, Streamable HTTP client)
lib/integrations.js    builds connectors, prefixes tools, enforces allowWrite, audits calls
lib/connectors/        acc, dynatrace, arize, n8n, router, http and mcp-proxy connectors
lib/secrets.js         secret references (secret store or env), masking
lib/secret-store.js    per-OS secret store: macOS Keychain, Linux keyring, AES-256-GCM file (DPAPI-sealed key on Windows)
lib/secret-binding.js  keeps a stored secret bound to the addresses it was saved for
lib/net.js             guarded fetch for addresses someone else typed (no loopback, private or metadata addresses)
lib/platform.js        OS differences: data folder, machine and user name, Obsidian config, open URL, MCP command
lib/auth.js            dashboard sign-in: local one-time-code sign-in (default), server-mode password (scrypt,
                       sessions, per-address throttling)
lib/service.js         background service: LaunchAgent, systemd, Startup folder or Task Scheduler
lib/audit.js           tool-call log (.cache/mcp-audit.jsonl)
lib/local.js           dashboard data for the acc connector
lib/claude.js          Claude Code log parser (usage + signals)
lib/codex.js           Codex log parser (usage + signals), skips the history a fork copies
lib/signals.js         non-existent-target, injection, secret, risky-command and correction detectors; relevance and
                       faithfulness grader
lib/indexer.js         incremental cache keyed by mtime + size, with an append-only journal; worker pool for the first index
lib/index-worker.js    worker thread that parses one log file per message
lib/aggregate.js       usage, cost and session roll-ups for a time range; one row per API response across files
lib/quality.js         quality and safety roll-ups for a time range; MODEL_FAULT lists what counts against accuracy
lib/pricing.js         built-in list prices (tiers, fast mode, web search, US-only inference) and the cost function
lib/data/              prices-snapshot.json: offline snapshot of OpenRouter's public price list, with its fetchedAt date
lib/otel.js            OTLP trace exporter (protobuf or JSON over HTTP) with GenAI spans, no dependencies
lib/processes.js       running-app detection
lib/vault.js           Obsidian vault reader for /api/vault (demo and older clients)
lib/brain/             second brain: Markdown scanner (Obsidian, Logseq, PARA, exports), Notion, Roam, Tana, mem.ai and
                       Heybrain (MCP) connectors, vector stores with PCA/kNN/k-means, a tiny Postgres client, the source registry
lib/demo.js            seeded synthetic dataset for demo mode
lib/demo-gateway.js    demo agentic workspace: fictional providers, keys, history, runs, brain sources, an offline model
lib/office.js          live agent state from transcript tails (AI office)
lib/reqlogs.js         recent requests, error traces and stream events (Logs)
lib/timeline.js        per-agent timeline segments with a per-file cache (Time)
lib/insights.js        utilization, cache, compression and provider analytics
lib/omniroute.js       read-only OmniRoute management API client, emails masked
lib/integration-config.js  per-type field schema, validation, Keychain storage and dry runs for the editor
lib/price-sync.js      live model prices from OpenRouter's public list, cached in .cache/prices.json
lib/openrouter.js      OpenRouter models, endpoints, providers, account and the rankings-page parser (cached in .cache/)
lib/gateway/           Agent Gateway: keys and rate limits, providers and model router (quota, cooldown, token refresh), format
                       translation (translate.js), token saver (rtk.js), usage, sessions and memory, agents, orchestrator,
                       knowledge (RAG vector store), workflows and the ready-to-use catalog, the collaboration engine
                       (collab.js), the A2A server (a2a.js), code tools (tools.js), agent skills (skills.js), /v1, /a2a and /mcp
skills/                nine Agent Skills (SKILL.md) that teach an AI to use ZAAFPulse, served at /skills
public/                dashboard UI: plain HTML, CSS and JavaScript, no build step
public/iso.js          isometric 3D engine, KPI cards and SVG chart helpers shared by all pages
scripts/               macOS LaunchAgent install/uninstall, launcher, Chrome opener, MCP client registration
                       (register-mcp.js), media capture, single-file build (build-single.js, sea-main.js)
scripts/eval-signals.js precision and recall of the detectors on the labelled corpus
scripts/bench-index.js indexer benchmark on seeded synthetic logs
install.sh, install.ps1 one-command installers for macOS/Linux and Windows
Dockerfile, compose.yaml container image for servers
.github/workflows/     ci.yml (the full suite on Linux, macOS and Windows), release.yml (binaries, checksums, attestations)
test/                  41 node:test suites with fake HTTP and MCP servers
test/fixtures/         the labelled synthetic signal corpus (signals/) and cost fixtures (cost/)
config.example.json    every integration type with placeholder references
docs/install.md        installers, sign-in, server mode, Docker, single-file binaries, verifying a download
docs/integrations.md   per-platform setup and MCP client registration
docs/otel.md           OpenTelemetry export: spans, attributes, backends
docs/quality-metrics.md how the quality and safety detectors are measured
docs/performance.md    indexing speed: method and numbers
docs/release-hardening.md tag ruleset and immutable releases
docs/assets/           README banner, diagrams, screenshots and GIFs
```
</details>

<details>
<summary><b>HTTP API</b></summary>

Apart from the sign-in routes in the first row, every `/api` route needs a signed-in dashboard session, unless sign-in is off.

| Route | Returns |
|---|---|
| `GET /api/session` · `POST /api/login` · `POST /api/logout` · `GET /auth/local` | sign-in state and mode; password sign-in (server mode); sign out; the one-time-code exchange that `zaafpulse open` uses |
| `GET /api/platform` | OS and the secret store in use |
| `GET /api/summary?range=7\|30\|90\|all` | usage, cost, sessions, projects, models and quality for the range |
| `GET /api/live` | running AI apps, system load and used memory, indexer status |
| `GET /api/office` | live state of every agent and subagent for the 3D office |
| `GET /api/insights?range=…` | utilization, cache, compression and provider analytics for the range |
| `GET /api/logs` | requests and error traces from the last 3 hours, with stream events |
| `GET /api/timeline?hours=1\|6\|24` | per-agent timeline segments and markers |
| `GET /api/router?section=…` | OmniRoute data: `utilization`, `cache`, `compression`, `providers`, `calls`, `proxy` |
| `GET /api/mcp-calls` | recent MCP hub tool calls from the audit log |
| `GET /api/vault` | notes, links and unresolved links of the Obsidian vault |
| `GET /api/brain` · `GET /api/brain/graph?source=…` · `POST /api/brain/sources` | second-brain sources and their graphs; save, test and delete a source |
| `GET /api/gateway` · `POST /api/gateway/<route>` | the dashboard side of the agentic workspace: keys, providers, routes, agents, workflows, runs, knowledge, tools, skills, settings |
| `POST /api/mcp/register` | register the MCP server in, or remove it from, one client (`{ "client": "claude\|kiro\|antigravity\|cursor\|vscode\|claude-desktop\|codex\|gemini\|windsurf\|zed\|all", "remove": false }`) |
| `GET /api/config` · `POST /api/config` | name, monthly budget, prices, vault path |
| `GET /api/openrouter?section=models\|providers\|rankings\|account` | OpenRouter data, cached (models 12 h, providers 24 h, rankings 6 h) |
| `GET /api/openrouter/endpoints?ids=…` | providers serving up to 40 models, with uptime and per-provider prices |
| `GET /api/prices` · `POST /api/prices` | live price catalog (when synced), sync status, your pinned prices; `refresh`, `toggle`, `set`, `unpin`, `remove` |
| `POST /api/rescan` | re-index changed log files now |
| `GET /api/integrations` | integration health, client registration and recent MCP tool calls |
| `POST /api/integrations/test` | fresh health check of one integration (`{ "id": "..." }`) |
| `GET /api/integrations/config` | field schema per type and each integration's settings, secrets as references only |
| `POST /api/integrations/test-draft` | dry run of a form: builds the connector with draft secrets in memory and checks health |
| `POST /api/integrations/save` · `POST /api/integrations/delete` | add, edit (and rename) or remove an integration in `config.json` |
</details>

<details>
<summary><b>Configuration</b></summary>

Everything is editable in **Settings** and saved to `config.json`:

| Setting | Default |
|---|---|
| Display name | your OS account name |
| Monthly budget (USD, API-equivalent) | none |
| Model prices per 1M tokens | built-in list prices, then the shipped snapshot, then the live list once synced (see [Cost and prices](#cost-and-prices)); edit a model to pin your own price, or add a prefix the list does not have |
| Obsidian vault path | the vault Obsidian has open (more sources under **Second brain → Sources**) |
| Theme | follows the system |
| Price auto-update (`pricingSync.enabled`) | on; fetches the public price list at startup and every 12 hours (toggle in Settings) |
| OpenTelemetry export (`otel`) | off; set in `config.json` only ([docs/otel.md](docs/otel.md)) |

Environment variables: `PORT` / `ZAAFPULSE_PORT` (default `4777`), `ZAAFPULSE_HOST`, `ZAAFPULSE_DATA`, `ZAAFPULSE_AUTH` (`local` by default on 127.0.0.1, `1` for password, `none` to turn sign-in off), `ZAAFPULSE_INDEX_WORKERS` (worker threads for the first index; `0` turns them off), the server-mode settings in [docs/install.md](docs/install.md), the standard `OTEL_*` variables ([docs/otel.md](docs/otel.md)), and `DEMO=1` for synthetic data. Demo mode never writes `config.json`, the Keychain or your coding tools, and fetches nothing: model calls are answered by a scripted model inside the process, and gateway data lives in a temporary folder. It uses the cached price list if one exists.
</details>

## Contributing

Contributions are welcome: bug reports, fixes, connectors, providers, agents, workflows, docs and translations.

| | |
|---|---|
| [Contributing guide](CONTRIBUTING.md) | Setup, project layout, the rules that matter (data stays local, no plain-text secrets, no runtime dependencies), tests (CI runs the full suite on Linux, macOS and Windows), pull requests and releases |
| [Code of Conduct](CODE_OF_CONDUCT.md) | How we work together (Contributor Covenant 2.1) |
| [Security Policy](SECURITY.md) | How to report a vulnerability privately, what is in scope, and how to keep an installation safe |
| [MIT License](LICENSE) | Use, change and share ZAAFPulse freely; keep the copyright notice |

Found a security problem? Do not open an issue. [Report it privately](https://github.com/rifqifitriady/ZAAFPulse/security/advisories/new).

## License

ZAAFPulse is released under the [MIT License](LICENSE). Copyright © 2026 Rifqi Fitriady and ZAAFPulse contributors.

<br>

<div align="center">
<sub>Built with plain Node and the browser. No frameworks, no build step, no cloud.</sub>
</div>
