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
what it costs, how often it is wrong, what your agents are doing right now, and how your knowledge grows.

[Features](#features) · [Screenshots](#screenshots) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Metrics](#what-the-quality-metrics-mean) · [Privacy](#privacy)

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
| **$** | *What is AI costing me?* | API-equivalent spend per day, model, project and session at **live provider list prices**, a month-end projection, and where the money goes: input, output, cache reads or cache writes. |
| **✓** | *Can I trust what it did?* | Tool-call accuracy, hallucination signals (paths, edits, arguments and URLs that did not exist) and how often you had to correct it. |
| **⚠** | *Did anything unsafe happen?* | Prompt-injection attempts in web and MCP content, secrets that surfaced in tool output, and risky commands such as `rm -rf` or force pushes. |
| **◈** | *What are my agents doing right now?* | A live 3D office: every session and subagent walks to the room for the tool it is using, waits at the help desk when it needs you, and shows up in a request log, a stream inspector and a timeline. |
| **◉** | *Is my second brain growing?* | A live, animated graph of your Obsidian vault: hubs, orphans, unresolved links, and a replay of how it grew. |
| **⌁** | *Can my apps use any model and my agents through one API?* | An Agent Gateway on 127.0.0.1: ZAAFPulse API keys with scopes, budgets and rate limits, an OpenAI-compatible `/v1` API for Ollama, LM Studio and any hosted provider, an orchestrator that plans and routes tasks to 17 domain agents with memory and sessions, and MCP over HTTP. |
| **⇄** | *Can my agents reach the rest of my stack?* | An MCP server for Claude Code, Kiro and Antigravity with connectors to Dynatrace, Arize Phoenix and AX, n8n, OmniRoute, 9router and any HTTP or MCP service, plus a page that shows every connection's health. |

## Features

<table>
<tr>
<td width="33%" valign="top">

**Usage & cost**<br>
<sub>Tokens, sessions, prompts, models and projects across Claude Code and Codex. Cost at list price with cache-aware rates, a monthly budget meter, a projection, and a 3D "usage city" of every day.</sub>

</td>
<td width="33%" valign="top">

**Quality & safety**<br>
<sub>Accuracy, hallucination signals, poisoning, corrections, relevance, faithfulness, secrets, risky commands, API errors, loops and compactions, plus subpages for <b>Utilization</b>, <b>Cache</b>, <b>Compression</b> and <b>Provider stats</b>.</sub>

</td>
<td width="33%" valign="top">

**AI Squad, live**<br>
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
<sub>An MCP server for Claude Code, Kiro and Antigravity with connectors to Dynatrace, Arize, n8n, OmniRoute, 9router and any HTTP or MCP service, shown as a 3D hub. Add, configure and test integrations right on the page.</sub>

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

**Live model prices**<br>
<sub>Prices follow each provider's list price automatically (OpenRouter's public list, every 12 h). A card per model with prices, context, tags and your spend; pin your own price anytime.</sub>

</td>
<td valign="top">

**216-model catalog**<br>
<sub>Anthropic, OpenAI, Google, DeepSeek, Alibaba, xAI, Meta, Tencent and Z.ai, filterable by vendor and searchable, so any model you start using is priced from day one.</sub>

</td>
<td valign="top">

**OpenRouter models & rankings**<br>
<sub>Every model on OpenRouter with live prices and per-provider uptime, the most-used models and apps this week, benchmark leaders, and the inference-provider directory, all as 3D decks.</sub>

</td>
</tr>
</table>

| At a glance | |
|---|---|
| Runtime dependencies | **0** (Node standard library only) |
| First index of 2 GB of logs | **~15 s**, then **~25 ms** per rescan |
| Network exposure | **127.0.0.1 only**, host-header checked; outbound only to integrations you configure and the public price list |
| 3D scenes | plain `<canvas>` 2D with an isometric projection: no WebGL, no libraries |
| Themes | Light and dark chrome, follows your system; the decks stay dark |

## Screenshots

<details open>
<summary><b>AI Squad</b>: your agents at work in a 3D office</summary>
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
<summary><b>Second brain</b>: your Obsidian vault as a living graph</summary>
<br>
<p align="center"><img alt="Notes per week grow in 3D while the note graph replays how the vault grew" src="docs/assets/demo-brain.gif" width="82%"></p>
<img alt="Second brain: knowledge growth in 3D, vault metrics and the note graph" src="docs/assets/screen-brain.jpg">
</details>

<details>
<summary><b>Projects, agents & skills, integrations</b></summary>
<br>
<table>
<tr>
<td width="50%"><img alt="Projects: a 3D skyline of projects by tokens, sessions and cost" src="docs/assets/screen-projects.jpg"></td>
<td width="50%"><img alt="Agents and skills: subagents, skills and tools as a 3D toolbelt city" src="docs/assets/screen-agents.jpg"></td>
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

Requires macOS and Node 18 or newer. Nothing to install. Clone this repository (green **Code** button above), then:

```bash
cd ai-command-center
npm start          # reads your logs  → http://localhost:4777
npm run demo       # synthetic data   → http://localhost:4778
npm test           # run the test suite (node:test, no dependencies)
npm run media      # regenerate README screenshots and GIFs from demo data
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
| `openrouter` | OpenRouter | model catalog and prices, which providers serve a model and their uptime, provider directory, rankings of models and apps, benchmarks; credits with a key |
| `http` | AION and any REST API | one tool per endpoint you declare |
| `mcp` | any Streamable HTTP MCP server | the upstream tools, filtered, under a `<id>__` prefix |

Tools are prefixed with the integration id (`dynatrace-saas_list_problems`). Everything is read-only unless an integration sets `"allowWrite": true`. Secrets stay in the macOS Keychain or environment variables, never in `config.json`. The **Integrations** page shows each connection's health, which clients have the server registered, and recent tool calls. It also lets you **add, configure, test and delete** integrations: the form is built for each type, **Test connection** checks a draft before anything is saved, and a pasted secret goes straight to the macOS Keychain (over stdin, never into `config.json` or a process list). Setup per platform: [docs/integrations.md](docs/integrations.md).

## Agent Gateway

ZAAFPulse can sit in front of your models and agents. Everything listens on **127.0.0.1 only**.

| Layer | What it does |
|---|---|
| **Agent Gateway** | AuthN with ZAAFPulse API keys (`zp_…`, shown once, stored as SHA-256 hashes); AuthZ by scope (`llm`, `agents`, `mcp`) and allowed model and agent globs; per-key rate limit (requests per minute), monthly budget in USD and expiry; session management (24 h sessions per key). |
| **Orchestrator / Planner** | Task planning (the planner model breaks a task into 1-4 steps), routing (each step goes to the best domain agent, with keyword routing as a fallback), and memory (session history plus long-term notes that agents save and recall). |
| **LLM Gateway / Model Router** | 52 provider presets: private LLMs on your own hardware (Ollama, LM Studio, **vLLM**, **TGI**, llama.cpp, Jan, LocalAI, LiteLLM) are always allowed; labs, inference clouds, routers, Asian providers and enterprise clouds (Azure OpenAI, Vertex AI, Bedrock) serve traffic only once **approved**; models come from each provider's own `/models`. Routes are virtual models (`router/fast`) that try their targets in order (fallback or round-robin); a 429 cools a target down (its reset time, or back-off to 5 minutes) and the route moves on. Rate-limit headers become a per-provider **quota** reading, with balances from OpenRouter, DeepSeek, Moonshot and SiliconFlow. Short-lived credentials **refresh themselves** (OAuth2 client credentials or refresh token, e.g. Entra ID; Google service accounts for Vertex), with one replay after a 401. |
| **Code tools** | Claude Code (Anthropic `/v1/messages`), Codex (OpenAI `/v1/responses`), Gemini CLI (`/v1beta/models/*`) and every OpenAI-compatible tool (OpenCode, Cline/Roo/Kilo, Copilot, Continue, Aider, Zed, Qwen Code, OpenClaw, Factory Droid) on **any** provider: requests are **translated** OpenAI ⇄ Anthropic ⇄ Responses ⇄ Gemini (tools, images, streaming, usage), or passed straight through to a native Anthropic provider. A model map sends tool model names (`claude-*`, `gpt-*-codex`) to your models. One click writes a tool's config with its own key (backup + revert). The **token saver** shortens long tool results (diffs, logs, builds, grep, listings, JSON) before they go upstream and logs the tokens saved. Subscription logins are not used: API keys and official OAuth only. |
| **RAG Service** | Knowledge bases with document ingestion (text, Markdown, HTML, CSV, JSON, files or a URL) and a local vector database: chunks with embeddings from any provider's embedding model, searched by hybrid cosine + BM25 (keyword-only without an embedding model). Agents search attached knowledge bases with `zp_knowledge_search`. |
| **Agent-to-Agent** | A multi-agent collaboration engine with seven patterns (below), the **A2A protocol** (agent card + JSON-RPC/SSE, v1.0 with v0.3 accepted) for other agents to call in, and remote A2A agents that join a team. Agents consult each other with `zp_ask_agent` and hand conversations on with `zp_handoff`. **24 ready-to-use workflows** (incident triage to mitigation, postmortem, helpdesk, ticket triage, refunds, phishing triage, cited research, RFP and security questionnaires, contract redlines, code review, lead outreach, meeting actions, change risk, vulnerability plans, access requests, onboarding, month-end commentary, procurement, feedback to PRD, release notes, project status, PDP/OJK compliance, knowledge-base gaps, agent quality review) with risk tiers and **approval gates** that pause a run until someone approves. |
| **Domain agents** | 17 editable specialists: Customer Service, Sales & Marketing, Network Operations, HR & Finance, IT Helpdesk, SRE & Observability, Security, Data Analyst, DevOps, Code Reviewer, Research, Legal & Compliance, Product Manager, Project Manager, Procurement, Content Writer and AI Ops. Each has a prompt, a model and the integration tools it may call (function calling over the MCP connectors). |

**Providers**: any OpenAI-compatible API, with presets for Ollama, LM Studio, vLLM, TGI, OpenAI, OpenRouter, Anthropic (OpenAI-compatible endpoint), Google Gemini, DeepSeek, xAI and Groq. Provider keys go to the macOS Keychain.

```bash
# Models are provider/model; agent/<id> is a domain agent; agent/auto lets the orchestrator plan and route.
curl http://127.0.0.1:4777/v1/chat/completions -H "Authorization: Bearer zp_…" -H "Content-Type: application/json" \
  -d '{"model": "agent/auto", "messages": [{"role": "user", "content": "Checkout is slow. Check the network and draft a customer update."}]}'
```

| Endpoint | Scope | |
|---|---|---|
| `GET /v1/models` | any | provider models and agents this key may use |
| `POST /v1/chat/completions` | `llm` / `agents` | OpenAI format, streaming; `x-zp-session` header continues a session |
| `POST /v1/embeddings` | `llm` | passthrough |
| `GET /v1/agents` · `POST /v1/agents/<id>/run` · `POST /v1/orchestrate` | `agents` | run one agent or the orchestrator, with the plan, tool calls and usage |
| `GET /v1/sessions` · `GET`/`DELETE /v1/sessions/<id>` | `agents` | the key's own sessions |
| `GET /v1/knowledge` · `POST /v1/knowledge/<id>/search` · `POST /v1/knowledge/<id>/documents` | `rag` | search a knowledge base, add documents |
| `GET /v1/workflows` · `POST /v1/workflows/<id>/run` | `agents` | run a multi-agent workflow (it pauses at approval gates) |
| `POST /v1/collaborate` | `agents` | a collaboration run: `pattern` (auto, parallel, vote, debate, review, group, handoff, agent, workflow), `effort`, `budget`, pattern options; `async: true` returns at once |
| `GET /v1/runs` · `GET /v1/runs/<id>` · `POST /v1/runs/<id>/cancel` · `POST /v1/runs/<id>/resume` | `agents` | run state, verdict, trace and blackboard; approve or reject a paused step (`{"approve": true, "note": "…"}`) |
| `GET /.well-known/agent-card.json` · `POST /a2a` | card public · `agents` | Agent2Agent: `SendMessage`, `SendStreamingMessage` (SSE), `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`; skill in `message.metadata.skill` |
| `POST /v1/messages` · `/v1/messages/count_tokens` | `llm` | Anthropic Messages (Claude Code); `x-api-key` works |
| `POST /v1/responses` | `llm` | OpenAI Responses (Codex), streaming events included |
| `POST /v1beta/models/<model>:generateContent` · `:streamGenerateContent` · `:countTokens` | `llm` | Gemini (Gemini CLI); `x-goog-api-key` works |
| `POST /mcp` | `mcp` | MCP over HTTP with every integration tool (`claude mcp add --transport http zaafpulse http://127.0.0.1:4777/mcp --header "Authorization: Bearer zp_…"`) |

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

- **Claude Code:** Code tools → Agent skills → **Install** writes `~/.claude/skills/zaafpulse*`. Folders are marked, so a skill of yours with the same name is never overwritten, and **Remove** deletes only the marked folders.
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

Every run has a budget (tokens, model calls, time, optional cost) scaled by effort: workers stop at 85% so judging and the final answer always fit, and past 80% patterns stop adding rounds. Agent output reaches other agents as quoted data (`<agent_output>`), never as instructions; a third identical tool call is refused; consulting an agent already on the request is refused; repeated questions are answered from a per-run cache. Each run keeps a trace with OpenTelemetry GenAI span names (`invoke_workflow`, `plan`, `invoke_agent`, `execute_tool`, `chat`) carrying tokens, cost and timing but no prompt text, plus a shared blackboard. From any OpenAI client, `model: "collab/vote"` (or `collab/debate`, `collab/group`, …) runs a pattern.

Workflow approval gates fail closed: a run pauses before the gated step until someone approves (the note reaches the next agent) or rejects, an unclear A2A reply never counts as approval, nobody deciding within 72 hours rejects the run, and a step whose agent is missing fails the run rather than being skipped.

A new key is shown once and masked (`zp_ZW_j••••••••••••BBYm`) as soon as it is copied, after 60 seconds or when you leave the page. Every request is logged with key, model, agent, tokens, cost (live list prices), latency and time to first token, never prompt text. Three menus manage it: **Agent Gateway** (overview in 3D, API keys, providers, model router, sessions and memory, playground, snippets), **RAG Service** (knowledge bases, ingestion, search, API) and **Agent-to-Agent** (ready-to-use and custom workflows, a Collaborate console with a live trace, run history, specialist agents, patterns and the A2A endpoint). Keys, agents, sessions and memory live in `.data/` (git-ignored); provider settings in `config.json` under `gateway`.

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
| Live transcripts | the tail of Claude Code and Codex transcripts written in the last 30 minutes to 24 hours | for the office, logs and timeline: tool names, block sizes, file and command names, hostnames, timing and state |
| OpenRouter | its public API (models, per-model provider endpoints with uptime, provider directory) and the public rankings page; credits and key limits with an optional API key | the Models and Rankings pages, live prices, and the `openrouter` MCP tools |
| OmniRoute (optional) | its management API, GET only | quota utilization, cache and compression analytics, provider stats, call logs and upstream proxy logs |

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
| **Relevance** | Per turn (a typed prompt and everything until the next one): the share of the prompt's key terms (stop words removed in English and Indonesian, plus file names, identifiers and numbers) that the reply or the turn's tool calls address; half of the terms counts as fully relevant. Prompts with fewer than three key terms are not graded. Replies in another language than the prompt score lower. |
| **Faithfulness** | Of the checkable references in replies (file names, `identifiers` in backticks, URLs, numbers with three or more digits, decimals or %), the share that appeared earlier in the session: in your prompts, the model's tool inputs or the tool results. Context the transcript does not record (system prompts) can make a correct reference look unsupported, and a computed sum is unsupported by design: read the list before acting on it. |

**Cost** is an API-equivalent estimate: tokens × list price per million, matched by the longest model prefix, with separate cache-read and cache-write rates. On a subscription plan you are not billed per token.

**Prices stay current on their own.** At startup and whenever the cached list is older than 12 hours, the server fetches OpenRouter's public model list, which carries each provider's list price, and keeps it in `.cache/prices.json`. Precedence is built-in defaults < your prices < live prices; editing a model in **Settings → Model prices** pins your price for it, and **Use live price** unpins it. Turn **Auto-update** off to rely only on your own and the built-in prices. `config.json` stores only the prices you set.

## Privacy

- The server listens on `127.0.0.1` only and rejects requests whose `Host` is not `localhost`.
- OpenRouter's public model list, provider directory and rankings page are read with plain GETs (models every 12 hours, rankings every 6, providers daily, per-model endpoints when you open the Models page); an API key is sent only if you add an `openrouter` integration with one.
- Model prices are kept current with one GET to OpenRouter's public model list every 12 hours (no credentials, no data from this laptop); turn **Auto-update** off in Settings to stop it. Otherwise nothing is sent anywhere unless you configure an integration, and then only to the URL you configured: when an AI client calls a tool, or when the Integrations page checks health (at most once a minute per integration, or when you press Test). No telemetry, no accounts. Integration secrets stay in the macOS Keychain or environment variables, never in `config.json`.
- The office, logs and timeline read transcript tails on demand and keep only tool names, sizes, file and command names, hostnames, timing and state; message text is never shown.
- Message text is never stored. The cache keeps token counts, metadata and, for flagged quality or safety items only, a masked snippet of up to 160 characters. Secret values are never kept.
- The Agent Gateway listens on 127.0.0.1 only; API keys are stored as hashes, provider keys in the Keychain, and sessions and memory (which hold conversation text you send to agents) stay in `.data/` on this Mac.
- `config.json`, `.cache/` and `.data/` are git-ignored.

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
lib/signals.js         hallucination, injection, secret, risky-command and correction detectors; relevance and faithfulness grader
lib/indexer.js         incremental cache keyed by mtime + size
lib/aggregate.js       usage, cost and session roll-ups for a time range
lib/quality.js         quality and safety roll-ups for a time range
lib/pricing.js         default prices and cost function
lib/processes.js       running-app detection
lib/vault.js           Obsidian vault scanner
lib/demo.js            seeded synthetic dataset for demo mode
lib/office.js          live agent state from transcript tails (AI office)
lib/reqlogs.js         recent requests, error traces and stream events (Logs)
lib/timeline.js        per-agent timeline segments with a per-file cache (Time)
lib/insights.js        utilization, cache, compression and provider analytics
lib/omniroute.js       read-only OmniRoute management API client, emails masked
lib/integration-config.js  per-type field schema, validation, Keychain storage and dry runs for the editor
lib/price-sync.js      live model prices from OpenRouter's public list, cached in .cache/prices.json
lib/openrouter.js      OpenRouter models, endpoints, providers, account and the rankings-page parser (cached in .cache/)
lib/gateway/           Agent Gateway: keys and rate limits, providers and model router, usage, sessions and memory, agents, orchestrator,
                       knowledge (RAG vector store), workflows and the ready-to-use catalog, the collaboration engine
                       (collab.js), the A2A server (a2a.js), /v1, /a2a and /mcp
public/                dashboard UI: plain HTML, CSS and JavaScript, no build step
public/iso.js          isometric 3D engine, KPI cards and SVG chart helpers shared by all pages
scripts/               LaunchAgent install/uninstall, launcher, Chrome opener, MCP client registration, media capture
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
| `GET /api/live` | running AI apps, system load and used memory, indexer status |
| `GET /api/office` | live state of every agent and subagent for the 3D office |
| `GET /api/insights?range=…` | utilization, cache, compression and provider analytics for the range |
| `GET /api/logs` | requests and error traces from the last 3 hours, with stream events |
| `GET /api/timeline?hours=1\|6\|24` | per-agent timeline segments and markers |
| `GET /api/router?section=…` | OmniRoute data: `utilization`, `cache`, `compression`, `providers`, `calls`, `proxy` |
| `GET /api/mcp-calls` | recent MCP hub tool calls from the audit log |
| `GET /api/vault` | notes, links and unresolved links of the Obsidian vault |
| `GET /api/config` · `POST /api/config` | name, monthly budget, prices, vault path |
| `GET /api/openrouter?section=models\|providers\|rankings\|account` | OpenRouter data, cached (models 12 h, providers 24 h, rankings 6 h) |
| `GET /api/openrouter/endpoints?ids=…` | providers serving up to 40 models, with uptime and per-provider prices |
| `GET /api/prices` · `POST /api/prices` | live price catalog, sync status, your pinned prices; `refresh`, `toggle`, `set`, `unpin`, `remove` |
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
| Display name | your macOS account name |
| Monthly budget (USD, API-equivalent) | none |
| Model prices per 1M tokens | live provider list prices (OpenRouter's public list, refreshed every 12 h); edit a model to pin your own price, or add a prefix the list does not have |
| Obsidian vault path | the vault Obsidian has open |
| Theme | follows the system |
| Price auto-update | on; fetches the public price list every 12 hours (toggle in Settings) |

Environment variables: `PORT` (default `4777`) and `DEMO=1` for synthetic data (demo mode never writes `config.json` or fetches anything; it uses the cached price list if one exists).
</details>

<br>

<div align="center">
<sub>Built with plain Node and the browser. No frameworks, no build step, no cloud.</sub>
</div>
