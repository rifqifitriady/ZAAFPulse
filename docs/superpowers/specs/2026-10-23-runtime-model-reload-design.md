# Reload the last models when a local model server starts: design

Date: 2026-10-23 · Status: approved by the owner in chat

## Goal

When the owner presses **Start** on Ollama or LM Studio in AI Office, the models that were last loaded before the server stopped are loaded again, without the owner typing `ollama run`.

## Decisions (2026-10-23)

| Question | Decision |
|---|---|
| Which models | **The last models seen loaded.** While ZAAFPulse runs, it remembers the last non-empty list of loaded models. That covers a model Ollama unloaded after going idle, a stop from outside ZAAFPulse, and a Mac restart. |
| How long they stay loaded | **Until Stop.** Ollama gets `keep_alive: -1`. LM Studio gets `lms load` with no TTL. |
| Runtimes | **Ollama and LM Studio.** llama.cpp owner entries already name their model in the command. Jan and LocalAI are out of scope. |
| When | Only after the **Start button** started the server and it answers. A server started outside ZAAFPulse is left alone. |

## Components

### `lib/runtimes/models.js` (new): `createModelMemory(opts)`

Options (all injectable for tests):
- `file`: a `jsonFile` of `.data/runtimes/models.json`, shaped `{ [id]: { models: [name], ts } }`.
- `getJson(url, timeoutMs)`: resolves to the parsed JSON or `null`.
- `postJson(url, body, timeoutMs)`: resolves to `{ status, body }`.
- `run(argv, { timeoutMs })`: resolves to `{ code, stdout }`, never with a shell.
- `now`, `log`.

It supports `ollama` and `lmstudio` (`supports(id)`).

Readers (a failure or a timeout means "unknown", never "empty"):
- **ollama:** `GET http://127.0.0.1:<port>/api/ps`, then `models[].name`.
- **lmstudio:** `[bin, 'ps', '--json']`, parsed as a JSON array, then `modelKey`, else `identifier`. It needs the item's `bin`, the `lms` path found by state.js.

Loaders:
- **ollama:** `POST http://127.0.0.1:<port>/api/generate` with `{ model, keep_alive: -1 }` and no prompt. A 2xx is success. A 404 means "not found". Timeout 5 minutes.
- **lmstudio:** `[bin, 'load', name, '--yes']`. Exit 0 is success. Timeout 5 minutes.

Model names:
- They come only from the runtime's own answers.
- They are kept only when they match `/^[A-Za-z0-9][\w.:\/@+-]{0,199}$/`: no leading `-`, so a name cannot act as an option to `lms`.
- At most 8 are kept.

API:
- `observe(x)`: `x` is a state item (`entry`, `running`, `healthy`, `bin`).
  - It reads only when the item is running, healthy and supported.
  - A non-empty list that differs from the saved one replaces it.
  - An empty or unknown list leaves the saved one as it is.
  - Resolves to the list read, or `null`.
- `remembered(id)`: the saved names, or `[]`.
- `reload(x)`: loads the remembered names one at a time.
  - It is in-process and in the background: the caller does not await it.
  - It returns the names it will load (`[]` when there is nothing to do).
  - Only one reload runs per id at a time.
  - Status is kept in memory per id: `{ loading: bool, loaded: [], failed: [{ name, error }] }`, where `error` is a short text with no path (`not found`, `timed out`, `could not load`).
  - When it ends, it calls `onDone(id, { loaded, failed })` (used for the audit).
- `status(id)`: that in-memory status, or `null`.

### Wiring

- **`lib/runtimes/control.js`** takes an optional `models` (the memory above).
  - **stop:** just before stopping a supported runtime, `await models.observe(x)`, capped at 3 s, so the list is fresh. A failure never blocks the stop.
  - **start:** when the start answers `{ state: 'running' }` (health answered) and the runtime is supported, `const names = models.reload(item)`. The answer becomes `{ state: 'running', reloading: names }` when `names` is not empty. The item passed is the state item read after the server answered, so `bin` and the port are current. A start that answers `starting` does not reload.
  - The reload's end is audited: `record('reload', id, { ok: failed.length === 0, loaded: n, failed: m })`, counts only.
  - **view:** for supported runtimes, adds `models: { remembered: [names], loading, loaded: [names], failed: [{ name, error }] }`. Other runtimes get `models: null`.
- **`server.js`**: creates the memory with `.data/runtimes/models.json` and passes it to control. When runtime control is on (not `AGENTS_OFF`, not Docker, not demo), a timer every 30 s runs `state.list()` and calls `observe` on each running supported item. The timer runs one pass at a time, catches everything, and is `unref`'d.
- **Demo mode:** `runtimesDemo()` gives Ollama `models: { remembered: ['llama3.2:3b'], loading: false, loaded: [], failed: [] }`. A demo start answers `reloading: ['llama3.2:3b']`.

### UI (`public/runtimesview.js`)

All text is rendered with `textContent`.
- While stopped with remembered models: "Start reloads llama3.2:3b". With more than 2 models: "llama3.2:3b, qwen3:8b and 1 more".
- The start result stays "Started."; the models line shows "Loading llama3.2:3b…" (changed after the final review: the result went stale beside the models line).
- While running:
  - while `loading`: "Loading llama3.2:3b…";
  - after the reload: "Model loaded: llama3.2:3b" (or "Models loaded: …");
  - `failed`: "Could not load X (not found)".
- The Stop confirmation for a supported runtime: "Stop Ollama? Its models are unloaded now and loaded again on the next Start."

### Docs

`docs/local-models.md` gets a section "Models are loaded again on Start", plus the audit action `reload`.

## Error handling

- A reader that fails (the server does not answer, `lms` exits non-zero, or the JSON does not parse) means "unknown", and the saved list is kept.
- A model that fails to load is listed in `failed`, and the next model is still tried.
- The memory file is written with mode 0600 (via `jsonFile`). A file that does not parse reads as `{}`.

## Testing (`node:test`, no real model loaded)

- **models.js**, with fake `getJson`, `postJson` and `run`:
  - Ollama and LM Studio readers and loaders;
  - a non-empty list replaces the saved one; an empty or unknown list keeps it;
  - names are filtered (a leading `-`, bad characters, the cap of 8);
  - reload loads sequentially and goes on after a failure; a second reload is refused while one runs;
  - `onDone` gets counts;
  - the status shapes.
- **control:**
  - stop observes first, and a failing observe still stops;
  - a running start reloads and answers `reloading`;
  - a `starting` answer does not reload;
  - an owner entry does not reload;
  - the `view.models` shape.
- **ui:** the text helpers for each state, rendered as text.

## Non-goals

- Restoring each model's remaining keep-alive time.
- Reloading after a start from outside ZAAFPulse.
- Per-model choice in the UI.
- Jan, LocalAI, llama.cpp.
