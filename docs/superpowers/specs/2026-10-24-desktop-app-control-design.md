# Start and stop the AI desktop apps from AI Office: design

Date: 2026-10-24 · Status: approved by the owner in chat · Extends `2026-10-23-local-runtimes-design.md`

## Goal

Claude Desktop, ChatGPT, Antigravity and Kiro get the same Start/Stop row on their AI Office cards as Ollama and LM Studio. The row also appears on the Overview's AI Office cards, which today show no buttons at all.

## Decisions (2026-10-24)

| Question | Decision |
|---|---|
| Apps | Claude Desktop, ChatGPT, Antigravity and Kiro. For Kiro, Kiro.app (the IDE) is used when installed, else Kiro CLI.app. kiro-cli sessions in a terminal are left alone; agent control already handles them. |
| Stop | First a normal quit (the macOS quit command, like ⌘Q). If the main process is still there after **10 s**, `SIGTERM`; if it is still there **5 s** later, `SIGKILL`. Before each signal, the process is read again and must have the same pid and start time. |
| Where | The AI Office cards, and the Overview's AI Office cards. |
| Platform | macOS only. Elsewhere there is no button, and the card says "macOS only". |

## Registry (`lib/runtimes/registry.js`)

There are four new presets, with `kind: 'app'`. Model servers get `kind: 'server'`, and an entry without `kind` counts as `'server'`.

| id (= the `lib/processes.js` APPS id) | name | app bundle(s), first one installed wins | main executable |
|---|---|---|---|
| `claude-desktop` | Claude Desktop | `Claude.app` | `Claude` |
| `chatgpt` | ChatGPT | `ChatGPT.app` | `ChatGPT` |
| `antigravity` | Antigravity | `Antigravity IDE.app`, `Antigravity.app` | `Electron`, `Antigravity` |
| `kiro` | Kiro | `Kiro.app`, `Kiro CLI.app` | `Kiro`, `kiro_cli_desktop` |

- **Match.** The process is the app's main process: argv[0], or the leading path of `args`, is exactly `<dir>/<Bundle>.app/Contents/MacOS/<exe>`, for an app folder in `/Applications` or `~/Applications`. Helpers under `Contents/Frameworks/…` never match. Its parent must be launchd (ppid 1): an app run from a terminal does not count.
- **Start.** `['/usr/bin/open', '-a', <bundle path found>]`.
- **Health.** None. Running means the main process is there, and healthy equals running.
- **Excluded.** No model reload: `models.supports` stays ollama and lmstudio only. No owner entries of `kind: 'app'`.

## Control (`lib/runtimes/control.js`)

- **Start.** As for an app-run runtime, with these differences:
  - after `open -a`, it waits up to 15 s for the main process to appear, not for a health URL;
  - it answers `running`, or `starting` with the note "opening, not up yet".
- **Stop for `kind: 'app'`, step by step:**
  1. Run `/usr/bin/osascript -e 'quit app "<bundle name without .app>"'`. Audit with `method: 'app'`.
  2. Wait up to 10 s for the pid to be gone. If it is gone, answer `{ state: 'stopped' }`.
  3. Read the process again. If it is gone, or the pid or start time no longer match, answer `stopped`. Otherwise send `SIGTERM` to the main pid. Audit with `signal: 'SIGTERM', forced: true`.
  4. Wait up to 5 s. Read it again with the same check, then send `SIGKILL`. Audit with `signal: 'SIGKILL', forced: true`.
  5. Wait up to 3 s, then answer `stopped`, or `stopping` with the note "still shutting down".
  - A step that cannot read the process table does not signal, and answers `stopping`.
  - `SIGKILL` stays forbidden for model servers. Only `kind: 'app'` may reach step 4.
- **Unchanged rules:**
  - Stop needs the pid and start time the card was shown.
  - The busy guard applies.
  - Control is off in server mode, with password sign-in, with no sign-in and in Docker.
  - Every step is audited.
  - Non-macOS: `canStart` and `canStop` are false, with reason "macOS only".
- **List row.** `view` adds `kind`.

## Topology (`lib/topology.js`)

Runtimes of `kind: 'app'` are not runtime nodes, because these apps are already tool nodes. They are filtered out where the runtimes are read.

## UI (`public/runtimesview.js`, `public/overviewview.js`)

- **Slots.** `RT_CARD_IDS` gains `claude-desktop`, `chatgpt`, `antigravity` and `kiro`, so these rows go into the existing cards.
- **Status line for an app:** "App open" or "App closed", with no port.
- **How note:** none for an app. Today's "app" note would only repeat itself.
- **Confirmation for an app:** "Quit Claude Desktop? If it is still open after 10 s it is force-closed; unsaved work or a running chat or agent can be lost."
- **Result texts:**
  - start: "Opened." / "Opening, not up yet.";
  - stop: "Closed." / "Still shutting down.".
- **Overview.** `mountOverview` also calls `rtMount()`, so the Overview's AI Office cards get their rows.
  - The Overview shows only the first 6 cards. Ollama and LM Studio may not be among them; that is acceptable.
  - The poll stops on unmount, as on AI Office.

## Docs

`docs/local-models.md` gets a section "Desktop apps": which apps, Start, the two-stage Stop with force, macOS only, and the confirmation. The README's "Local model servers" section gains one bullet on the apps.

## Testing (no real app is opened or closed)

- **registry:**
  - the presets;
  - the main-process match (the right exe matches; a helper, another app, or the same name in an argument does not);
  - Kiro picks Kiro.app over Kiro CLI.app.
- **state:** an app is installed from a fake app folder, and running from a fake row.
- **control:**
  - stop with a fake runner and kill: the quit command first;
  - no signal when the app quits in time;
  - `SIGTERM` after 10 s, then `SIGKILL` after 5 s (injected short timers);
  - a changed pid or start time before each signal sends nothing;
  - a model server never gets `SIGKILL`;
  - non-macOS gives "macOS only";
  - the audit lines.
- **topology:** an app runtime is not drawn as a runtime.
- **ui:**
  - the app texts and the confirmation;
  - `RT_CARD_IDS` includes the four apps;
  - the Overview calls `rtMount`.
