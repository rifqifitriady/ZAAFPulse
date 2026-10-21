# Trace & Session Explorer

The **Trace explorer** page (`#trace`, under AI Observability) shows what one AI session did: its turns, model
calls, tool calls and subagents as a tree of spans with a timeline, a map of the same turn, and the text of any
span on request. It covers Claude Code, Codex, the Agent Gateway, Kiro, Gemini CLI and Antigravity, each as far
as that tool's own logs allow.

Everything is read from files already on this machine. Nothing is sent anywhere, and no transcript text is
copied into the index or any cache.

## What each source shows

| Source | Where it reads | Spans | Cost and tokens | Text on request |
|---|---|---|---|---|
| **Claude Code** | the log index of `~/.claude/projects` | session, turn, model call, tool call, subagent (with its own tree) | yes | prompts, replies, tool inputs and outputs, including tool output Claude Code saved to a file |
| **Codex** | the log index of `~/.codex/sessions` | session, turn, model call, tool call | yes | prompts, replies, tool inputs and outputs |
| **Agent Gateway** | this gateway's own request log and collaboration runs | plain requests: metadata only (one session per conversation). Collaboration runs: the full span tree | yes | collaboration run steps and answers only; the gateway never stores request text |
| **Kiro** | `~/.kiro/sessions/<workspace>/<session>/` | tool calls | none: Kiro stores no usage | no |
| **Gemini CLI** | `~/.gemini/tmp/<project>/chats/*.json` | one model call per Gemini message, its tool calls | tokens, when the chat file has them | no |
| **Antigravity** | `conversation_summaries.db` under `~/.gemini/antigravity` and `~/.gemini/antigravity-ide` | the conversation, with one agent span per sub-conversation and its step count | no | no |

Notes per source:

- **Claude Code and Codex** have full depth. A session's turn offsets live in the index, so the page reads
  only the turn you look at (the last one first), never the whole file. A session that is still growing is
  polled every 5 seconds and its last turn follows it. Gateway, Kiro, Gemini CLI and Antigravity sessions are
  not polled.
- **Agent Gateway** requests are metadata only. Titles hold the pattern, state, model and counts, never a task
  or a prompt, so they stay visible even when content is off.
- **Kiro** stores tool calls and their results but no usage and no user message. A turn starts at a user
  payload when a log has one; otherwise there is one turn per `executionId`, in the order first seen.
- **Gemini CLI** support follows a chat layout modelled on a synthetic file (`messages` with `user` and
  `gemini` entries). A chat that is laid out differently may show fewer details. Only the first user message
  is read, for the title.
- **Antigravity** is conversation level only: no tool calls, no text, no cost. It needs Node 22.12 or newer
  (see [Troubleshooting](#troubleshooting)).
- Sessions carry flags where the source knows them: **errors**, **loop detected** and **injection**, the same
  detectors as the Quality page.

On the page: choose 24 h, 7 d or 30 d, search by title, project or branch, filter by source or by sessions
with errors, and drag the splitter between the tree and the map. A session opens on its last turn; the turn
buttons switch turns.

## Privacy

- **Text is read on demand and never copied.** The index holds counts, ids, byte offsets and times. A span
  carries only a reference to where its text sits. When you open a span, that one byte range is read from the
  original file, in pages of 64 KB, and a single read is capped at 16 MB.
- **Content is shown as text only.** There is no Markdown rendering and no HTML from a log, so a transcript
  cannot add anything to the page.
- **Secrets are masked by default.** The whole field is scanned with the same detectors as the Quality page, so
  a secret that crosses a page boundary is still hidden. **show** reveals one masked value at a time, over
  `POST /api/trace/reveal`. A revealed value is kept only in the open page: the server does not store it, and **hide** masks it again.
- **Only the agent log folders are read.** Text is read from `~/.claude/projects` and `~/.codex/sessions`
  and nowhere else. A path is resolved first (links included), then checked to sit inside those folders, and a
  byte range is checked against the file size. The data folder with your keys and `config.json` is never a
  source.
- **The API never sees a path.** Sessions and text are addressed by opaque ids that are made per process. A
  client cannot pass a file name.
- **Antigravity's database is opened read-only.** If it is locked, a copy is read and then deleted. Only
  metadata columns are selected; the preview and summary text are never read.
- **The same sign-in as the rest of the dashboard.** Every `/api/trace/*` route needs it, and a gateway API
  key does not open them.
- **Demo mode** (`DEMO=1`) serves synthetic sessions and reads no real file.

### Turning content off

| Setting | Effect |
|---|---|
| `ZAAFPULSE_CONTENT=off` | No text at all. Span text answers 403 (`content viewing is off`), and a title that comes from a transcript is hidden, so rows show their project and times only. Gateway titles stay: they hold no text. |
| `ZAAFPULSE_CONTENT=on` | Text is allowed, also in server mode. |
| not set | Text is allowed when ZAAFPulse listens on loopback. In **server mode** (a non-loopback host) text is **off**, because other people may sign in. |

## Keyboard

| Key | Does |
|---|---|
| `j` / `k` | next / previous span |
| `Enter` | open the selected span's text, or activate the focused session, turn or span |
| `←` / `→` | previous / next turn |
| `←` / `→` on the splitter | move the splitter by 2% |

Keys do nothing while you type in a field or while a drawer is open.

## Performance

The explorer never reads a whole log to show a session. Measured with `ZAAFPULSE_PERF=1 node --test
test/trace-perf.test.js` on a synthetic 310 MB Claude Code session (200 turns, 9,800 tool calls), Apple M4,
Node 24.16.0:

| Step | Time |
|---|---|
| Last-turn skeleton, in a worker thread | about 21 ms |
| Last-turn skeleton, in the main thread | about 5 ms |
| One 31 KB content page | about 1.1 ms |

Limits: at most 20 built sessions and about 200 MB of them are kept (least recently used out first); a Claude
Code or Codex file over 50 MB is built in a worker thread, with a fall-back to the main thread; at most 4
builds or reads run at once; a source that fails is shown as unavailable and the others keep working. Method
and caveats: [docs/performance.md](performance.md#trace-explorer-showing-one-session-of-a-huge-log).

## HTTP API

All routes sit behind the dashboard sign-in. Ids are opaque and valid only for the running process.

| Route | Returns |
|---|---|
| `GET /api/trace/sources` | the six sources in a fixed order, each with `id`, `ok`, `reason` and `count` |
| `GET /api/trace/sessions?range=1..30&source=…&q=…&flags=errors` | up to 500 sessions, newest first: `key`, `title`, `source`, `project`, `branch`, `start`, `end`, `turns`, `tools`, `errors`, `cost`, `flags`. `range` is days (default 7) |
| `GET /api/trace/title?key=…` | `{ "title": … }`, read from the first prompt and masked; `null` with content off |
| `GET /api/trace/session?key=…&turn=N` | the spans of one turn (the last when `turn` is left out) and the list of turns. Text and results are content ids |
| `GET /api/trace/content?id=…&offset=N` | one page of text (`text`, `masked`, `offset`, `next`, `total`, `truncated`) with secrets replaced by labels |
| `POST /api/trace/reveal` | JSON `{ "id", "index", "offset" }`; returns `{ "value" }` for one masked value |
| `GET /api/trace/live?key=…&cursor=…` | `{ "changed": false, "cursor" }` or `{ "changed": true, "cursor", "skeleton" }` for a growing Claude Code or Codex session. The `cursor` is opaque: send back the last one |
| `GET /api/trace/find?source=…&sid=…` | `{ "key" }` for a session id the Sessions or AI Office page already holds |

Errors are JSON `{ "error": … }`: 400 for a bad or missing parameter, 403 for content off, 404 for an unknown
key or id, 405 for the wrong method, 413 for a range that is too large, and 415 for a `reveal` that is not
JSON. A query value (`cursor`, `q`, `flags`, `source`, `sid`) longer than 512 characters is refused.

## MCP

The `acc_trace_sessions` tool lists the latest sessions as metadata only, for an AI client that wants to point
you at a session. Arguments: `range` (`7`, `30`, `90` or `all`; default 30) and `limit` (1 to 200; default 50).
Each row has `key`, `source`, `title`, `project`, `start`, `end`, `turns`, `tools`, `errors`, `cost` and
`flags`. It returns no text, file path, content id or size, and no row comes from the gateway, because the MCP
process has none. Keys are made per process and are valid only for the ZAAFPulse process that made them. The
title is `null` when `ZAAFPULSE_CONTENT=off`, and in this tool it is also `null` for Claude Code and Codex,
because the MCP process is given no log folder to read text from.

## Troubleshooting

| You see | Why and what to do |
|---|---|
| **Antigravity: needs Node 22.12 or newer** | Antigravity's database is read through `node:sqlite` in read-only mode, which Node honours from 22.12. An older Node would open it read-write, so it is not opened at all. Run ZAAFPulse with Node 22.12 or newer. |
| **Antigravity: read-only SQLite not supported by this Node** or **read-only check failed** | The runtime check that proves the database would be opened read-only did not pass. Nothing was opened. Update Node. |
| A source shows **not installed** | Its folder (`~/.kiro/sessions`, `~/.gemini/tmp`, the Antigravity database) does not exist. |
| A source shows **not configured** | It is not set up here. The Agent Gateway is not available in the MCP tool. |
| **session file changed, rescanning** (404) | The log was moved or deleted after the list was built. The list is rebuilt at most once a second; pick the session again. |
| **unknown session** (404) | The key is not in the current list. Keys change when ZAAFPulse restarts, so an old `#trace?key=…` link stops working. Open the session from the list. |
| **Content viewing is off** | `ZAAFPULSE_CONTENT=off`, or server mode without `ZAAFPULSE_CONTENT=on`. See [Turning content off](#turning-content-off). |
| A Kiro session shows no cost and no text | Kiro does not store usage or messages. |
| A new turn does not show yet | The last turn comes from the index, which refreshes on its own schedule; growth inside the last turn shows at once. |
| A session is missing | A session with no turns is not listed, the page shows at most 500, and 30 days is the longest range. |
