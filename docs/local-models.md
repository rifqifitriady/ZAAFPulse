# Local model servers

AI Office can start and stop the model servers on your machine with one button: Ollama, LM Studio, the llama.cpp server, Jan, LocalAI, and any server you add yourself. Start and Stop act on the **server**. Stopping it unloads every model it has loaded. Loading, unloading or pulling single models is not part of this.

## Where the buttons are

In **AI Office → Installed AI tools**:

- The **Ollama** and **LM Studio** cards get a row under their status line: the server's state and port, **Start** or **Stop**, and how the server runs.
- **llama.cpp**, **Jan**, **LocalAI** and your own runtimes get a card of their own in the same grid, with the same row and their port.
- A runtime shows up when it is installed, running, or one of your own entries.

Stop asks first: "Stop Ollama? Models it has loaded are unloaded." While a request is out the button reads "Starting…" or "Stopping…". When a start fails, the card shows the error and the last lines of the server's log, with secrets masked and paths removed.

## The runtimes

| Runtime | Start | Stop | Answers on |
|---|---|---|---|
| Ollama | `ollama serve` (or opens `Ollama.app` when the `ollama` program is not found) | by how it runs, see below | `http://127.0.0.1:11434/api/version` |
| LM Studio | `lms server start` | `lms server stop` | `http://127.0.0.1:1234/v1/models` |
| llama.cpp server | needs a model file: add it as your own entry | by how it runs | the port of your entry |
| Jan | opens `Jan.app` | quits the app | `http://127.0.0.1:1337/v1/models`, while Jan's local API server is on |
| LocalAI | `local-ai run` | by how it runs | `http://127.0.0.1:8080/readyz` |

A program is looked up on `PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `~/.lmstudio/bin` and `~/.local/bin`. Apps are looked up in `/Applications` and `~/Applications`.

A server counts as running while its process is there, and as answering when its URL answers within 1.5 seconds; a running server that does not answer shows "not answering". LM Studio counts as running only while its URL answers, because its app stays open when the server is off.

The processes a server starts for its models (Ollama's runners and `llama-server`) count toward that server and are shown as its model processes. They are never stopped on their own: the server stops them.

## How a server is stopped

A server is stopped the way it runs. Every stop is confirmed first and audited.

| Shown as | Meaning | Stop |
|---|---|---|
| app | the server belongs to the runtime's macOS app | quits the app (`osascript -e 'quit app "Ollama"'`) |
| brew service | launchd runs it as `homebrew.mxcl.<formula>` | `brew services stop <formula>` |
| started here | the Start button started it | `SIGINT`, then `SIGTERM` after 5 seconds |
| started outside ZAAFPulse | a terminal, a Claude session, a script | `SIGINT`, then `SIGTERM` after 5 seconds |
| managed by the system | a Linux systemd system unit | not stopped: use `systemctl` |

A runtime with its own stop command (LM Studio's `lms server stop`) is stopped with that command. `SIGKILL` is never sent. On Windows a process is stopped with `taskkill /PID n`, without `/F`. After a stop ZAAFPulse waits up to 10 seconds for the server to go; if it is still there, the card says "still shutting down".

An entry of your own is stopped only while it is approved (see [Your own runtimes](#your-own-runtimes)). Stopping an unapproved entry is refused with 403.

A second Start or Stop on a runtime while one is still in progress is refused with 409: "a start is still in progress; try again shortly" (or "a stop …").

## What Start does

1. The command runs without a shell, detached from ZAAFPulse, with its output in `.data/runtimes/<id>.log` (mode 0600). The log is rotated at 5 MB when the server starts, and one previous file is kept. The log file is opened without following symlinks, and a file with more than one hard link is refused.
2. For a server that is the started process itself, the pid and start time go to `.data/runtimes/started.json`, so the card can say "started here". A start that opens an app (Jan, Ollama.app) or uses the runtime's own launcher (LM Studio's `lms`) is not recorded, and the server then shows as "app" or "started outside ZAAFPulse".
3. ZAAFPulse asks the server's URL every 500 ms for up to 30 seconds. If it does not answer in time, the card says "started, not answering yet" and shows the last log lines. A model that takes long to load can need more time.

The server keeps running until you stop it or the machine restarts. It survives a ZAAFPulse restart. Nothing is added to your login items or system services.

## Your own runtimes

Add a server of your own in **Settings → Local models**, for example `llama-server` with a model file. Each entry is stored in `config.json`:

```json
"localRuntimes": [
  { "id": "qwen-local", "name": "Qwen (llama.cpp)", "command": ["llama-server", "-m", "/models/qwen.gguf", "--port", "8081"], "port": 8081 }
]
```

| Field | |
|---|---|
| `id` | 1 to 40 lowercase letters, digits or dashes; not a preset's id (`ollama`, `lmstudio`, `llamacpp`, `jan`, `localai`) and not used twice |
| `name` | shown on the card (optional) |
| `command` | the program and its arguments, one string each, at most 1,000 characters each. In Settings you type one argument per line, and Settings turns `~/` at the start of an argument into your home folder when you save. In a `config.json` edited by hand, use absolute paths: `~/` is not expanded there |
| `port` | 1 to 65535 |
| `health` | optional. Must be an `http://` URL on this machine. Left out, the server is checked at `http://127.0.0.1:<port>/`. That default is not stored: it follows the port, so changing the port moves it too. Settings shows the URL that is checked, and **Edit** leaves the field empty unless you typed one |

An entry that is not valid is listed with the reason and cannot start.

**A `config.json` that does not parse is refused, not overwritten.** Saving or deleting in Settings reads `config.json` again first. If the file has a syntax error (a trailing comma after a hand edit, say), the change is refused with 500 "the settings could not be saved" and the file is left as it is. Fix the file, then save again. The file is written to a private temp file (mode 0600) first and then renamed into place.

**Approve before it runs.** An entry starts only after you press **Approve** in Settings, and it can be stopped from the dashboard only while it is approved. The approval is stored in `.data/runtimes/approved.json` as a hash of the command, the port and the health URL. Editing any of the three drops the approval, so the entry asks again. Deleting an entry deletes its approval. A command typed into `config.json` by hand also needs the approval in the dashboard.

**Secrets in arguments.** Settings shows an argument that holds a secret (a key or token) masked. Leave a masked argument unchanged and the stored value is kept. A new entry may not contain the masked text: type the real value.

Your entry's server is found by its program name, and then:

- **The command names the port** (`--port 8081`, `--port=8081`, `host:8081`): the process must name that port too, whatever its other arguments. Two `llama-server` entries on different ports are told apart.
- **The command does not name the port**: the process's arguments after the program must be exactly the command's. `["python3", "serve.py"]` matches `python3 serve.py`, but not `python3 manage.py runserver` or any other `python3` on the machine, so Stop never reaches an unrelated process. A server you start with other arguments by hand is then not shown as this entry.

Putting the port in the command, when the server takes one, is the more reliable of the two.

## Safety

- The dashboard only ever sends a runtime's id. Commands come only from the presets and from your approved entries in `config.json`.
- The routes are behind the dashboard sign-in. Gateway API keys, MCP tools and A2A cannot reach them.
- Control is **off in server mode, with password sign-in and in Docker**, the same as agent control ([docs/monitors.md](monitors.md#where-control-is-off)). Start, Stop, Approve, and save and delete in Settings are then refused with 403. The cards hide the buttons and say why. Settings shows the reason, hides the commands, and disables its form and buttons.
- Stop checks the pid and start time the card was shown. If the server was restarted in between, the stop is refused with "the process changed; refresh".
- Every action that reaches control, refused or not, is written to `.data/agent-audit.jsonl` with `kind: "runtime"`. That covers start, stop, approve, save and delete: the time, the action, the runtime id, the result and, for start and stop, the pid, start time and how it was stopped. It holds no command, path or log text. A request rejected before that (a malformed body, not JSON) is not audited.
- No error or log line the dashboard gets holds a file path. Settings shows your own commands with your home folder as `~` and secrets masked.

Demo mode shows synthetic runtimes. Its Start, Stop and Approve change only what the page shows, and save and delete are refused: nothing is started, stopped or saved.

## API

All routes are behind the dashboard sign-in. Writes need `Content-Type: application/json` (415 otherwise).

| Route | Body | Answer |
|---|---|---|
| `GET /api/runtimes` | | `[{ id, name, preset, installed, running, healthy, how, pid, startTime, children, port, canStart, canStop, reason, approved, error }]` |
| `POST /api/runtimes/start` | `{ id }` | `{ state: "running" }`, or `{ state: "starting", note, log }` |
| `POST /api/runtimes/stop` | `{ id, pid, startTime }` | `{ state: "stopped" }`, or `{ state: "stopping", note }` |
| `POST /api/runtimes/approve` | `{ id }` | `{ approved: true }` |
| `GET /api/runtimes/config` | | your entries for Settings: `{ off, entries: [{ id, name, command, port, health, healthUsed, approved, error }] }`; `off` is the reason while control is off, and `command` is then `null`. `health` is the URL you gave, or `null`; `healthUsed` is the URL that is checked, the default included |
| `POST /api/runtimes/save` | `{ entry, was? }` | the same as `config`; `was` names the entry being edited |
| `POST /api/runtimes/delete` | `{ id }` | the same as `config` |

Errors are `{ error }` with 400, 403, 404, 409 or 502 (a failed save can also be 500, for instance when `config.json` does not parse). A failed start (502) also has `log`.

| Case | Status | Message |
|---|---|---|
| Unknown runtime | 404 | `unknown runtime` |
| Not installed | 409 | `not installed` |
| Already running, already stopped | 409 | `already running`, `already stopped` |
| A start or stop is still in progress for this runtime | 409 | `a start is still in progress; try again shortly`, `a stop is still in progress; try again shortly` |
| The server was restarted since the card was drawn | 409 | `the process changed; refresh` |
| Your entry is not approved (Start or Stop) | 403 | `approve it in Settings first` |
| Control is off (Start, Stop, Approve, save, delete) | 403 | `runtime control is off on this server`, `runtime control is off in Docker` |
| A new or edited argument holds the masked text | 400 | `an argument holds the hidden-secret marker; type the real value` |
| The command could not start or exited with an error | 502 | a short message, with `log` |
| No answer within 30 seconds | 200 | `started, not answering yet` |

## Known limits

- **Linux and Windows service managers.** A systemd system unit is shown as "managed by the system" and is not stopped. On Linux, a server started while ZAAFPulse runs as a systemd user service lives in that service's cgroup, so restarting the service also stops the server.
- **The log is rotated only at start.** The server writes its own log while it runs, so a long run can grow past 5 MB until the next start.
- **One server per runtime.** When two servers of the same runtime run, the one started here is shown, otherwise the oldest.
- **Windows** has no parent pids in the process table here, so model processes are not counted toward their server.
