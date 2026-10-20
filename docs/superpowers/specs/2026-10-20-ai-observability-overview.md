# AI Observability for ZAAFPulse: overview and shared requirements

Date: 2026-10-20 · Status: approved in brainstorming, awaiting spec review

This document covers the whole AI observability program. It holds the positioning, the comparison with Dynatrace and Arize, the decisions made, the requirements every sub-project must meet, and the build order. Each sub-project has its own spec:

| # | Sub-project | Spec | Depends on |
|---|---|---|---|
| 1 | Trace & Session Explorer | `2026-10-20-trace-session-explorer-design.md` | none |
| 2 | Local evals and feedback | `2026-10-20-local-evals-feedback-design.md` | 1 |
| 3 | Monitors, alerts and agent pause | `2026-10-20-monitors-agent-control-design.md` | 1, 2 |
| 4 | Datasets, replay and the CI gate | `2026-10-20-datasets-replay-design.md` | 1, 2 |

Out of scope for now: a bridge that exports history, evals and feedback to Phoenix, AX and Dynatrace. The existing OTLP export stays as it is.

## Principles

These are the owner's words, and every feature is filtered through them.

- **Lightweight.** No runtime dependencies (unchanged), no database server, no extra process.
- **Simple and easy to use.** Each feature works with no setup and has sensible defaults.
- **Plug and play.** Data comes from logs that already exist on disk; nothing needs to be installed in the agents.
- **Runs on localhost.** Content stays on the machine unless the owner explicitly chooses otherwise.

## Positioning, from the comparative study (2026-10-20)

ZAAFPulse stays a local, single-user tool. It does not try to be a smaller Dynatrace or Arize. It does what they cannot do well on a developer's laptop, and leaves scale, team workflows and long retention to them.

| Capability | Dynatrace | Arize Phoenix | Arize AX | ZAAFPulse after this program |
|---|---|---|---|---|
| Coding-agent sessions | live OTel only, 7 agents, needs telemetry flags | hooks; rebuilds 1 foreground subagent | hooks | **retroactive from logs, every subagent, no setup** |
| Trace view | Distributed Tracing | trace tree | trace tree, agent graph | tree + animated session map (split view) |
| Cost | not a stored field; tokens × price | yes | yes, not retroactive | yes, detailed tiers (existing) |
| LLM-as-judge | Preview (`dt-evals` CLI) | 16 evaluators (SDK); no online evals | 28 templates, online | 5 templates, local model first, on by default |
| Code evaluators | — | yes | Enterprise | yes (existing detectors) |
| Human feedback | no | yes | yes, plus queues | thumbs + notes, single user |
| Datasets and experiments | no | yes | yes | local datasets, text-only replay, CI gate |
| Monitors and alerts | yes | no | yes | local rules, alert on state change |
| Act on the machine | no | no | no | **pause, resume, stop an agent** |
| Offline, zero setup | no | needs Python 3.11, open ports | no | yes |

Sources: the three research reports of 2026-10-20 (Dynatrace AI Observability, Arize AX/Phoenix, and a ZAAFPulse baseline from main 7ec871b). Key references:
- https://docs.dynatrace.com/docs/observe/dynatrace-for-ai-observability
- https://github.com/dynatrace-oss/dt-evals
- https://arize.com/docs/phoenix
- https://arize.com/docs/ax
- https://github.com/Arize-ai/openinference
- https://github.com/Arize-ai/coding-harness-tracing

## Decisions (brainstorming, 2026-10-20)

| Topic | Decision |
|---|---|
| Wave 1 | A Explorer, B evals, C feedback, D monitors and agent pause, F datasets and replay. E (export bridge) is deferred. |
| Content | Prompt and response text is **read from the original log files on demand**. It is never copied into the index or cache. Datasets are the only place a copy is kept, and only when the user saves one; the copy is masked. |
| Explorer sources | Claude Code, Codex, Agent Gateway, Kiro, Antigravity and Gemini CLI, with tiered depth (see spec 1). |
| Architecture | On-demand adapters per source build one span model when a session is opened. The index only gains light per-session metadata and per-turn byte offsets. |
| Explorer layout | Split screen in one page. The left half is the explorer (sessions, trace tree, detail panel); the right half is an animated session map in the holo style. The two halves are synced. Mockup approved: `mockups/split-view-v4.html`. |
| LLM judge | **On by default**, local model first: Ollama, then LM Studio, then a model chosen in Settings. With no local model the judge waits: no data leaves the machine, and a banner offers to set one up. An external provider runs only when the owner selects it. |
| Agent control | Manual pause, resume and stop, plus **automatic pause** for rules the owner enables. An agent is never stopped or resumed automatically. |

## Shared security requirements (apply to every sub-project)

| Id | Requirement |
|---|---|
| S1 | Transcript content is attacker-influenced (web pages, repo files, tool output), so it is rendered as text only (`textContent` / `esc()`). There is no markdown-to-HTML and no `innerHTML` for content. The CSP stays `script-src 'self'`. |
| S2 | Secrets are masked by default, using the existing `scanSecrets`. "Show" reveals one item on an explicit click and is never persisted. Dataset copies are masked on save. |
| S3 | APIs take opaque ids from the index, never file paths. Every file is resolved with `realpath` and must sit inside a known source root; symlinks that leave the root are refused. Offsets are validated against the file size. |
| S4 | Nothing goes to an external judge or replay model unless the owner selected that provider. Before anything is sent, secrets and PII are masked. Sending is preceded by a preview of what will be sent. Every send is subject to sampling and budget caps. |
| S5 | Judge input is wrapped as untrusted data. The judge has no tools, and its output must match a JSON schema with categorical labels; invalid output is dropped. |
| S6 | Agent control acts only on processes that `lib/processes.js` identifies as AI agents, after checking both PID and start time. It sends SIGSTOP and SIGCONT to pause and resume, and SIGINT then SIGTERM to stop; never SIGKILL. A dashboard sign-in is required. It is not available to gateway API keys, MCP tools or A2A. It is off in server mode and Docker. Every action is written to the audit log. |
| S7 | Alert webhooks carry numbers and ids only, never content. URLs and secrets are secret references. Alerts are sent on state change only, and are rate-limited. |
| S8 | Replay is text-only: tool calls are shown as proposals and never executed. Replay goes through the gateway with a per-run budget, and secrets are masked first. |
| S9 | Antigravity SQLite files are opened with `readOnly: true`, and copied to a temporary file first if locked. Nothing is ever written to them. |
| S10 | Content viewing can be turned off (`ZAAFPULSE_CONTENT=off`) and is **off by default in server mode**, with a notice in the UI. |
| S11 | New stores (`evals`, `feedback`, `alerts`, `datasets`, `experiments`) live in `.data` with mode 0600 and rotation or caps. Evals, feedback and alerts hold no prompt text. |

## Shared scalability requirements

The reference machine holds 3.0 GB of Claude Code logs in 804 files. The largest file is 375 MB (19,688 lines); the p95 is 11 MB. There are 642 subagent files and 292 MB of Codex logs.

| Id | Requirement |
|---|---|
| P1 | No feature reads a whole log file to show one session. Per-turn byte offsets in the index allow ranged reads. Span text is fetched when it is opened, capped at 64 KB, with a "load more" control. |
| P2 | Session skeletons (spans without text) are kept in an in-memory LRU cache, bounded by count (20) and size (about 200 MB). Sessions over 50 MB are built on the existing worker-thread pool. |
| P3 | The subagent-to-parent mapping is computed at index time. |
| P4 | Large trees are grouped by turn, collapsible, and rendered virtually. |
| P5 | Wave 1 has no full-text search across content. Lists filter on index metadata. |
| P6 | Judge work runs in a single queue with concurrency 1, a daily cap (default 500 judgments) and a cost cap for external providers. It is idempotent per target and evaluator version. |
| P7 | Monitors evaluate on existing aggregates every rescan (60 s), and on live data every 5 s. Each rule has a small state machine. |
| P8 | A growing active session is read from its last offset only. |
| P9 | In server mode, concurrent heavy reads are limited per process and share the same LRU cache. |
| P10 | Each source adapter is isolated: a parse failure in one source is reported for that source and never breaks the others. Every adapter has format fixtures in its tests. |

## Conventions for every sub-project

- Zero runtime dependencies. Node ≥18 for everything except the Antigravity adapter, which needs `node:sqlite` (Node 22.5+). On older Node that source is hidden with a note.
- Demo mode (`--demo`) ships synthetic data for every new view, so screenshots and the media script keep working.
- Work is test-first with `node:test`, and the full suite must stay green on Ubuntu, macOS and Windows CI.
- Commits and PRs carry no AI attribution (owner rule for this repo).
- Style follows `.prettierrc.json`, with short "why" comments.
