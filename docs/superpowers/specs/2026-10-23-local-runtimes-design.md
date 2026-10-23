# Start and stop local model servers from AI Office: design

Date: 2026-10-23 · Status: approved in brainstorming, awaiting spec review

## Goal

In AI Office, the owner can start and stop every local model server on this machine with one button: Ollama today, LM Studio and other offline runtimes when they are installed, and any runtime the owner adds by hand later.

## Decisions (brainstorming, 2026-10-23)

| Question | Decision |
|---|---|
| What Start/Stop acts on | The **model server** (e.g. `ollama serve`). Stopping it unloads every model. Per-model load and unload is out of scope. |
| Which runtimes | Every local model runtime. Presets: Ollama, LM Studio, llama.cpp server, Jan and LocalAI. The owner can also define their own runtime (name, command, port) without a code change. |
| Lifetime after Start | Until it is stopped or the Mac restarts. The server runs detached from ZAAFPulse, so it survives a ZAAFPulse restart, and no login item or system service is added. |
| Which servers Stop acts on | Every detected server, including one started outside ZAAFPulse (a terminal, a Claude session, the Ollama app, `brew services`). Each is stopped the way it runs, always after a confirmation, and every action is audited. |
| Approach | A new `lib/runtimes/` module. It reuses the process verification of agent control (`lib/agents/control.js`), but that module is not extended. |

## Non-goals

- Loading, unloading or pulling models.
- Installing a runtime.
- Making a runtime start at login.
- Running arbitrary commands from the dashboard: the dashboard only ever sends a runtime `id`.
- Windows and Linux service managers. `brew services` is handled; a Linux systemd unit is reported as "managed by the system" and not stopped.

## Components

### `lib/runtimes/registry.js`: what a runtime is

A runtime entry:

```js
{
  id,          // 'ollama', 'lmstudio', … or the owner's own id: [a-z0-9-]{1,40}
  name,        // shown on the card
  preset,      // true for built-ins
  bin,         // program name looked up on PATH and the usual folders (e.g. 'ollama')
  app,         // macOS app bundle path, when the runtime ships as an app (e.g. '/Applications/Ollama.app')
  brew,        // Homebrew formula name, when it can run as a brew service (e.g. 'ollama')
  start,       // argv run without a shell, e.g. ['ollama', 'serve']; for an app: open the app
  stop,        // optional argv of the runtime's own stop command (e.g. ['lms', 'server', 'stop'])
  health,      // URL that answers when the server is up (e.g. 'http://127.0.0.1:11434/api/version')
  match,       // how its server process is recognised in the process table (program name and arguments)
}
```

Presets:

| id | Start | Stop | Health | Notes |
|---|---|---|---|---|
| `ollama` | `ollama serve` | signal | `http://127.0.0.1:11434/api/version` | also as `Ollama.app` and as brew service `ollama` |
| `lmstudio` | `lms server start` | `lms server stop` | `http://127.0.0.1:1234/v1/models` | also as `LM Studio.app` |
| `llamacpp` | none (needs a model path): the owner adds it as their own entry | signal | port from the entry | recognised as `llama-server` |
| `jan` | open `Jan.app` | quit the app | `http://127.0.0.1:1337/v1/models` (only when Jan's API server is on) | app only |
| `localai` | `local-ai run` | signal | `http://127.0.0.1:8080/readyz` | |

`ollama serve` is the user's own server. The `llama-server` it starts for a model is its child, not a separate runtime: a process whose parent is a recognised runtime server counts toward that server.

**The owner's own entries** live in `config.json`:

```json
"localRuntimes": [
  { "id": "qwen-local", "name": "Qwen (llama.cpp)", "command": ["llama-server", "-m", "/models/qwen.gguf", "--port", "8081"], "port": 8081 }
]
```

Validation (an invalid entry is listed with its reason and cannot be started):
- `id` must be unique and not a preset id.
- `command` must be a non-empty array of strings, each at most 1,000 characters.
- `port` must be an integer from 1 to 65535.
- `health` defaults to `http://127.0.0.1:<port>/`.

### `lib/runtimes/state.js`: what is running and how

For each runtime: `installed` (binary, app or brew formula present), `running`, `healthy` (health URL answered within 1.5 s), and `how`:

| `how` | Meaning | Stop |
|---|---|---|
| `app` | the server belongs to the runtime's macOS app | quit the app (`osascript -e 'quit app "Ollama"'`) |
| `service` | launched by launchd as `homebrew.mxcl.<formula>` | `brew services stop <formula>` |
| `zaafpulse` | started by the Start button (pid recorded in `.data/runtimes/started.json`) | SIGINT, then SIGTERM after 5 s |
| `process` | anything else (a terminal, a Claude session, a script) | SIGINT, then SIGTERM after 5 s |

The server process is the one matching the runtime's `match`. Its children (e.g. `llama-server`) are reported with it but never signalled directly: the server stops its own children.

### `lib/runtimes/control.js`: Start and Stop

**Start** `{ id }`:
1. Refused when the runtime is unknown (404), not installed (409), already running (409), or an owner entry not yet approved (403).
2. The command runs with `spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', log, log], cwd: dataDir, shell: false })` and is then unref'd. `log` is `.data/runtimes/<id>.log` (mode 0600, rotated at 5 MB, one previous file kept). For an app, the command is `open -a <app>`.
3. The pid and start time are recorded in `.data/runtimes/started.json`.
4. ZAAFPulse polls the health URL every 500 ms for up to 30 s. The answer is `{ state: 'running' }`, or `{ state: 'starting', note: 'started, not answering yet', log: [last 20 lines, secrets masked, paths removed] }`.

**Stop** `{ id, pid, startTime }`:
1. Refused when the runtime is not running (409), or the pid or start time no longer match the server process (409, "the process changed; refresh"). The check is the same as agent control's (`sameProcess`, a tolerance of 2 s).
2. The runtime is stopped according to `how` (table above). It is never sent SIGKILL. On Windows a process is stopped with `taskkill /PID n` without `/F`.
3. After the stop, ZAAFPulse waits up to 10 s for the process to be gone and answers `{ state: 'stopped' }`, or `{ state: 'stopping', note: 'still shutting down' }`.

**Rules for both** (the same as agent control, S6 of the observability overview):
- Dashboard sign-in only. Not available to gateway API keys, MCP tools or A2A.
- Off in server mode and in Docker, with the reason shown on the card.
- Every action, refused or not, goes to the audit log (`agent-audit.jsonl` in the data folder, the same file agent control writes, with `kind: 'runtime'`).
- Commands come only from the presets and the owner's `config.json`. An owner entry must be approved once in Settings before it can start. The approval is stored with a hash of its command, so editing the command asks again.

## API (`lib/runtimes/api.js`, behind the dashboard sign-in)

| Route | Body | Answer |
|---|---|---|
| `GET /api/runtimes` | — | `[{ id, name, preset, installed, running, healthy, how, pid, startTime, port, canStart, canStop, reason, approved, error }]`: only runtimes that are installed or configured |
| `POST /api/runtimes/start` | `{ id }` | `{ state, note?, log? }` |
| `POST /api/runtimes/stop` | `{ id, pid, startTime }` | `{ state, note? }` |
| `POST /api/runtimes/approve` | `{ id }` | `{ approved: true }` |

Errors are `{ error }` with 400, 403, 404, 409 or 502, and never carry a path. POST requires `application/json` (415 otherwise).

## UI

**AI Office, Installed AI tools**
- The Ollama and LM Studio cards get an action row under the status line:
  - **Stop** while running, with a small note of how the server runs ("started outside ZAAFPulse", "brew service", "app").
  - **Start** while stopped.
  - "Starting…" / "Stopping…" while a request is in flight.
  - On a failure, the error and, for a failed start, the masked log lines, rendered as text.
- Stop asks for confirmation first: "Stop Ollama? Models it has loaded are unloaded."
- Runtimes without an existing card (llama.cpp, Jan, LocalAI and the owner's own entries) get their own cards in the same grid, with status, port and the same buttons.
- When control is off (server mode, Docker), the buttons are hidden and the card says why.

**Settings → Local models**
- Lists the owner's own entries with add, edit and delete.
- An **Approve** button stores the approval with a hash of the entry's command.

**Demo mode** shows synthetic runtimes. The buttons simulate the actions and start nothing.

## Error handling

| Case | Status | Shown |
|---|---|---|
| Unknown runtime | 404 | "unknown runtime" |
| Not installed | 409 | "not installed" |
| Already running / already stopped | 409 | the card refreshes |
| Process changed | 409 | "the process changed; refresh" |
| Owner entry not approved | 403 | "approve it in Settings first" |
| Server mode, Docker, or a gateway key | 403 | the reason |
| The command could not start (missing binary, spawn error) | 502 | a short message and the masked log lines |
| No health answer within 30 s | 200 | "started, not answering yet" |

## Testing

`node:test`, with no real runtime started:
- **registry**:
  - the presets;
  - validation of owner entries (bad id, a command that is not a string array, a port out of range, a duplicate or preset id);
  - the approval hash changing with the command.
- **state**, from synthetic process rows:
  - a server started by the app, by launchd (`homebrew.mxcl.ollama`), by ZAAFPulse, and by a shell;
  - a child `llama-server` counted with its server;
  - "installed" from a fake PATH and fake app folders.
- **control**, against a fake runtime (a small Node script that opens a port and answers the health URL):
  - Start detaches it, records it and waits for health;
  - a start that never answers reports `starting`;
  - Stop sends SIGINT and then SIGTERM, refuses a changed pid, and never sends SIGKILL;
  - actions are refused in server mode, in Docker and for an unapproved entry;
  - the audit lines are written.
- **API**:
  - routes and status codes;
  - 415 without JSON;
  - no path in any body.
- **UI**:
  - pure helpers for button labels and status text;
  - an audit that log lines and errors are rendered with `textContent`.
