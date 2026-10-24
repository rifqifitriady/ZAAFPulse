# Local model servers

AI Office can start and stop the model servers on your machine with one button: Ollama, LM Studio, the llama.cpp server, Jan, LocalAI, and any server you add yourself. On macOS it can also open and quit the AI desktop apps (see [Desktop apps](#desktop-apps)). Start and Stop act on the **server**. Stopping it unloads every model it has loaded, and for Ollama and LM Studio Start loads the last ones again (see [Models are loaded again on Start](#models-are-loaded-again-on-start)). Loading, unloading or pulling a single model by hand is not part of this.

## Where the buttons are

In **AI Office → Installed AI tools**:

- The **Ollama** and **LM Studio** cards get a row under their status line: the server's state and port, **Start** or **Stop**, and how the server runs.
- **llama.cpp**, **Jan**, **LocalAI** and your own runtimes get a card of their own in the same grid, with the same row and their port.
- A runtime shows up when it is installed, running, or one of your own entries.
- The **Claude Desktop**, **ChatGPT**, **Antigravity** and **Kiro** cards get the same row (see [Desktop apps](#desktop-apps)).

The **Overview** shows the same rows on its AI Office cards. It shows only its first six cards, and never adds a card of its own, so a runtime whose card is not among them has no row there: use AI Office.

Stop asks first: "Stop Ollama? Its models are unloaded now and loaded again on the next Start." (for a runtime without the reload below: "Models it has loaded are unloaded.") While a request is out the button reads "Starting…" or "Stopping…". When a start fails, the card shows the error and the last lines of the server's log, with secrets masked and paths removed.

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

A runtime with its own stop command (LM Studio's `lms server stop`) is stopped with that command. `SIGKILL` is never sent to a model server (only a desktop app can be closed by force, see [Desktop apps](#desktop-apps)). On Windows a process is stopped with `taskkill /PID n`, without `/F`. After a stop ZAAFPulse waits up to 10 seconds for the server to go; if it is still there, the card says "still shutting down".

An entry of your own is stopped only while it is approved (see [Your own runtimes](#your-own-runtimes)). Stopping an unapproved entry is refused with 403.

A second Start or Stop on a runtime while one is still in progress is refused with 409: "a start is still in progress; try again shortly" (or "a stop …").

## What Start does

1. The command runs without a shell, detached from ZAAFPulse, with its output in `.data/runtimes/<id>.log` (mode 0600). The log is rotated at 5 MB when the server starts, and one previous file is kept. The log file is opened without following symlinks, and a file with more than one hard link is refused.
2. For a server that is the started process itself, the pid and start time go to `.data/runtimes/started.json`, so the card can say "started here". A start that opens an app (Jan, Ollama.app) or uses the runtime's own launcher (LM Studio's `lms`) is not recorded, and the server then shows as "app" or "started outside ZAAFPulse".
3. ZAAFPulse asks the server's URL every 500 ms for up to 30 seconds. If it does not answer in time, the card says "started, not answering yet" and shows the last log lines. A model that takes long to load can need more time.

The server keeps running until you stop it or the machine restarts. It survives a ZAAFPulse restart. Nothing is added to your login items or system services.

## Models are loaded again on Start

For **Ollama** and **LM Studio**, Start also loads again the models the server last had loaded, so you do not have to run `ollama run` after a Stop.

- **Which models:** the last models seen loaded. While ZAAFPulse runs, it checks the loaded models of each running Ollama and LM Studio every 30 seconds, and once more just before a Stop. It keeps the last list that was not empty in `.data/runtimes/models.json`. A model Ollama unloaded after going idle, a stop from outside ZAAFPulse and a restart of the machine therefore do not lose the list. A different list replaces it, and nothing is saved while a reload is still loading. The check is off where runtime control is off (demo mode, server mode, password sign-in, no sign-in, Docker), and with `ZAAFPULSE_RUNTIME_WATCH=off`.
- **When:** only after the **Start** button started the server and it answers; a Start that reports "started, not answering yet" reloads nothing. A server started any other way (a terminal, the Ollama app at login) is left as it is.
- **How long they stay:** until Stop. Ollama loads each model with `keep_alive: -1`, and LM Studio with `lms load <model> --yes` with no time-to-live, so they are not unloaded when idle. This keeps their memory in use: a 3B model takes about 2.3 GB.
- **How:** one model at a time, in the background; Start does not wait for them. A model LM Studio still has loaded is not loaded a second time. Ollama through `POST /api/generate` with no prompt on its own port, LM Studio through `lms load`, without a shell. A model name is used only when it comes from the runtime itself and looks like a model name: one starting with `-` is never passed to `lms`. At most 8 are kept.
- **On the card:** "Start reloads llama3.2:3b" while stopped, "Loading llama3.2:3b…" after Start, then "Model loaded: llama3.2:3b". A model that is gone or does not load is shown as "Could not load … (not found)", and the others are still loaded.
- **Stop during a reload:** no further model is loaded. A load already under way runs to its end.
- **Audit:** the end of each reload is written to `.data/agent-audit.jsonl` as action `reload`, with the number of models loaded and failed (and `cancelled` after a Stop), never their names.

The llama.cpp server and your own entries name their model in the command, so they need no reload. Jan and LocalAI are not reloaded.

## Desktop apps

On macOS the **Claude Desktop**, **ChatGPT**, **Antigravity** and **Kiro** cards in AI Office (and on the Overview) get a row with **Start** or **Stop**. The row says "App open" or "App closed"; an app has no port and no URL to answer, so it counts as open while its main process runs. Its helper processes count toward it.

| App | Opens | Main process |
|---|---|---|
| Claude Desktop | `Claude.app` | `Claude.app/Contents/MacOS/Claude` |
| ChatGPT | `ChatGPT.app` | `ChatGPT.app/Contents/MacOS/ChatGPT` |
| Antigravity | `Antigravity.app` | `Antigravity.app/Contents/MacOS/Antigravity` |
| Kiro | `Kiro.app` (the IDE) when installed, else `Kiro CLI.app` | `Kiro.app/Contents/MacOS/Kiro`, or `Kiro CLI.app/Contents/MacOS/kiro_cli_desktop` |

Apps are looked up in `/Applications` and `~/Applications`. `kiro-cli` sessions in a terminal are not the Kiro app and are left alone.

- **Start** runs `open -a` with the app found, then waits up to 15 seconds for its main process. The card says "Opened.", or "Opening, not up yet." when it takes longer.
- **Stop** asks first: "Quit Claude Desktop? If it is still open after 10 s it is force-closed; unsaved work or a running chat or agent can be lost." Then, in two stages:
  1. The app is asked to quit, as with ⌘Q (`osascript -e 'quit app "Claude"'`). An app with unsaved work may ask you first.
  2. If its main process is still there after **10 seconds**, it gets `SIGTERM`; if it is still there **5 seconds** later, `SIGKILL`. Before each signal the process is read again, and nothing is sent unless it is still the same process (the same pid and start time). An app that is gone, or a process that was replaced, ends the stop.
  The card then says "Closed.", or "Still shutting down." when it is still there 3 seconds after the last step.
- Every step is audited in `.data/agent-audit.jsonl`: the quit, and each signal with `forced: true`.
- **macOS only.** Elsewhere the cards show no button and say "macOS only".
- An app is never a card of its own: when its card is not shown (not installed, or not among the Overview's first six), it has no row.
- Control is off in the same places as for model servers (see [Safety](#safety)).

## Your own runtimes

Add a server of your own in **Settings → Local models**, for example `llama-server` with a model file. Each entry is stored in `config.json`:

```json
"localRuntimes": [
  { "id": "qwen-local", "name": "Qwen (llama.cpp)", "command": ["llama-server", "-m", "/models/qwen.gguf", "--port", "8081"], "port": 8081 }
]
```

| Field | |
|---|---|
| `id` | 1 to 40 lowercase letters, digits or dashes; not a preset's id (`ollama`, `lmstudio`, `llamacpp`, `jan`, `localai`, `claude-desktop`, `chatgpt`, `antigravity`, `kiro`) and not used twice |
| `name` | shown on the card (optional) |
| `command` | the program and its arguments, one string each, at most 1,000 characters each. In Settings you type one argument per line, and Settings turns `~/` at the start of an argument into your home folder when you save. In a `config.json` edited by hand, use absolute paths: `~/` is not expanded there |
| `port` | 1 to 65535 |
| `health` | optional. Must be an `http://` URL on this machine. Left out, the server is checked at `http://127.0.0.1:<port>/`. That default is not stored: it follows the port, so changing the port moves it too. Settings shows the URL that is checked, and **Edit** leaves the field empty unless you typed one. A URL you typed that is exactly the default is treated as the default, and follows the port too |

An entry that is not valid is listed with the reason and cannot start.

**A `config.json` that does not parse is refused, not overwritten.** Saving or deleting in Settings reads `config.json` again first. If the file has a syntax error (a trailing comma after a hand edit, say), adding an entry is refused with 500 "the settings could not be saved"; editing or deleting one answers 404 "unknown entry", because no entries can be read. Either way the file is left as it is. Fix the file, then save again. The file is written to a private temp file (mode 0600) first and then renamed into place.

**Approve before it runs.** An entry starts only after you press **Approve** in Settings, and it can be stopped from the dashboard only while it is approved. The approval is stored in `.data/runtimes/approved.json` as a hash of the command, the port and the health URL. Editing any of the three drops the approval, so the entry asks again. Deleting an entry deletes its approval. A command typed into `config.json` by hand also needs the approval in the dashboard.

**Secrets in arguments.** Settings shows an argument that holds a secret (a key or token) masked. Leave a masked argument unchanged and the stored value is kept. A new entry may not contain the masked text: type the real value.

Your entry's server is found by its program name, and then:

- **The command names the port** (`--port 8081`, `--port=8081`, `host:8081`): the process must name that port too and carry every other argument of the command; extra arguments are allowed. Two `llama-server` entries on different ports, or with different models, are told apart, and `python3 train.py --steps 8000` is not a vllm entry on port 8000.
- **The command does not name the port**: the process's arguments after the program must be exactly the command's. `["python3", "serve.py"]` matches `python3 serve.py`, but not `python3 manage.py runserver` or any other `python3` with a different command line, so Stop does not reach an unrelated process. A server you start with other arguments by hand is then not shown as this entry.

Putting the port in the command, when the server takes one, is the more reliable of the two.

## Safety

- The dashboard only ever sends a runtime's id. Commands come only from the presets and from your approved entries in `config.json`.
- The routes are behind the dashboard sign-in. Gateway API keys, MCP tools and A2A cannot reach them.
- Control is **off in server mode, with password sign-in, without sign-in (`ZAAFPULSE_AUTH=none`, outside demo mode) and in Docker**, the same as agent control ([docs/monitors.md](monitors.md#where-control-is-off)). Without sign-in any program on this machine could save a command and start it, so nothing is started from such a dashboard. Start, Stop, Approve, and save and delete in Settings are then refused with 403. The cards hide the buttons and say why. Settings shows the reason, hides the commands, and disables its form and buttons.
- Stop checks the pid and start time the card was shown. If the server was restarted in between, the stop is refused with "the process changed; refresh".
- Every action that reaches control, refused or not, is written to `.data/agent-audit.jsonl` with `kind: "runtime"`. That covers start, stop, approve, save, delete and the end of a model reload: the time, the action, the runtime id, the result and, for start and stop, the pid, start time and how it was stopped. It holds no command, path or log text. A request rejected before that (a malformed body, not JSON) is not audited.
- No error or log line the dashboard gets holds a file path. Settings shows your own commands with your home folder as `~` and secrets masked.

Demo mode shows synthetic runtimes. Its Start, Stop and Approve change only what the page shows, and save and delete are refused: nothing is started, stopped or saved.

## API

All routes are behind the dashboard sign-in. Writes need `Content-Type: application/json` (415 otherwise).

| Route | Body | Answer |
|---|---|---|
| `GET /api/runtimes` | | `[{ id, name, kind, preset, installed, running, healthy, how, pid, startTime, children, port, canStart, canStop, reason, approved, error }]`; `kind` is `"app"` for a desktop app, else `"server"` |
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
| Control is off (Start, Stop, Approve, save, delete) | 403 | `runtime control is off on this server`, `runtime control is off because this dashboard runs without sign-in`, `runtime control is off in Docker` |
| A new or edited argument holds the masked text | 400 | `an argument holds the hidden-secret marker; type the real value` |
| The command could not start or exited with an error | 502 | a short message, with `log` |
| No answer within 30 seconds | 200 | `started, not answering yet` |

## Known limits

- **Linux and Windows service managers.** A systemd system unit is shown as "managed by the system" and is not stopped. On Linux, a server started while ZAAFPulse runs as a systemd user service lives in that service's cgroup, so restarting the service also stops the server.
- **The log is rotated only at start.** The server writes its own log while it runs, so a long run can grow past 5 MB until the next start.
- **One server per runtime.** When two servers of the same runtime run, the one started here is shown, otherwise the oldest.
- **Windows** has no parent pids in the process table here, so model processes are not counted toward their server.
