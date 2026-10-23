# Reload the last models on Start: implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Start on Ollama or LM Studio loads again the models that were last seen loaded, and keeps them loaded until Stop.

**Architecture:**
- A new `lib/runtimes/models.js` remembers the last non-empty list of loaded models per runtime, in `.data/runtimes/models.json`, and reloads it.
- `control.js` observes before a stop and reloads after a start that answered.
- `server.js` observes every 30 s.
- The UI shows the remembered and loading models as text.

**Spec:** `docs/superpowers/specs/2026-10-23-runtime-model-reload-design.md`. It holds every exact value: the URLs, argv, regex, caps, timeouts, texts and shapes. Use them verbatim.

**Tech stack:** Node.js >= 18, CommonJS, zero dependencies, `node:test`.

## Global constraints

- No new dependencies. No shell: every command is an argv array.
- Model names come only from the runtime's own answers, and are filtered by `/^[A-Za-z0-9][\w.:\/@+-]{0,199}$/`, with at most 8 kept.
- Ollama loads use `keep_alive: -1`. LM Studio uses `lms load <name> --yes` with no TTL.
- No path appears in any API answer, error or audit line. The audit line for a reload holds counts only.
- All text on the page is rendered with `textContent` or `esc()`, never with `innerHTML` interpolation.
- Nothing runs in demo mode, server mode (`AGENTS_OFF`) or Docker, except the synthetic demo data.
- Tests never start, stop or load anything real. Never touch `.worktrees/live`.
- Commits carry no AI attribution line. Stage files by name.

---

### Task 1: `lib/runtimes/models.js`

**Files:**
- Create: `lib/runtimes/models.js`.
- Test: `test/runtimes-models.test.js`.

**Interfaces:**
- Produces: `createModelMemory({ file, getJson, postJson, run, now, log, onDone })`, which returns `{ supports, observe, remembered, reload, status }` exactly as the spec's section "lib/runtimes/models.js" describes.
- Also exports:
  - `getJson(url, timeoutMs)` and `postJson(url, body, timeoutMs)`: real implementations with `http` that never throw;
  - `NAME_RE`, `MAX_MODELS`, `LOAD_TIMEOUT_MS` (5 * 60 * 1000).
- Consumes: `jsonFile` from `lib/runtimes/state.js`, for the default `file` when a `dir` is given. Or the caller passes `file`.
- Item shape (from `state.list()`): `{ entry: { id, port, preset }, running, healthy, bin }`. Only `entry.preset && (id === 'ollama' || id === 'lmstudio')` is supported.

Steps:
- [ ] Write the failing tests:
  - **Readers:**
    - Ollama: `getJson` → `{ models: [{ name: 'llama3.2:3b' }] }`, and `observe` saves `['llama3.2:3b']`.
    - LM Studio: `run([bin, 'ps', '--json'])` → `stdout` `[{"modelKey":"qwen3-8b"}]`.
    - The item is not running or not healthy: no read, and the result is `null`.
  - **Keeping the saved list:**
    - an empty list keeps the saved one;
    - `getJson` → `null` keeps it;
    - `run` exits 1 keeps it;
    - `stdout` that is not JSON keeps it;
    - a different non-empty list replaces it.
  - **The name filter:** `-rf`, `a b`, a 201-character name and a non-string are dropped, and 9 names are capped to 8.
  - **reload:**
    - It returns the remembered names.
    - Ollama posts `{ model, keep_alive: -1 }` to `http://127.0.0.1:11434/api/generate` for each name, one after another (assert the order and that the second starts after the first resolves).
    - A 404 → `failed: [{ name, error: 'not found' }]`, and the next name is still loaded.
    - LM Studio runs `[bin, 'load', name, '--yes']`.
    - A second `reload` while one runs returns `[]`.
    - `onDone(id, { loaded, failed })` is called once.
    - `status(id).loading` is true during the reload and false after it.
    - With nothing remembered, it returns `[]` and nothing is called.
  - **Owner entries:** an owner entry or another preset is unsupported. `observe` returns `null`, `reload` returns `[]`, and `remembered` returns `[]`.
- [ ] Run `node --test test/runtimes-models.test.js`. It should fail with "Cannot find module".
- [ ] Implement `lib/runtimes/models.js` to the spec. `getJson` and `postJson` use `http.request` with the timeout and resolve, never reject. The timeout for a read is 3 s, and for a load `LOAD_TIMEOUT_MS`.
- [ ] Run the tests until they pass, then run `npm test`.
- [ ] Commit `lib/runtimes/models.js` and `test/runtimes-models.test.js`: "Remember and reload the models a local model server last had loaded".

### Task 2: wire it into control, the server and demo

**Files:**
- Modify: `lib/runtimes/control.js`, `server.js`, `lib/demo.js` (`runtimesDemo`), and `lib/runtimes/api.js` only if its demo branch builds the start answer.
- Test: `test/runtimes-control.test.js`, plus `test/runtimes-api.test.js` if the demo answer changes.

**Interfaces:**
- Consumes: Task 1's `createModelMemory`.
- `createRuntimeControl({ ..., models })` is optional. Without it, the behaviour is unchanged.
- Produces:
  - the start answer `{ state: 'running', reloading: [names] }`, with the field only when non-empty;
  - `view(x).models`, as the spec's "Wiring" section describes (`null` for unsupported runtimes);
  - the audit action `reload`.

Steps:
- [ ] Write the failing tests in `test/runtimes-control.test.js`, using a fake `models`: `{ supports, observe, reload, remembered, status }` that records its calls.
  - A stop of a supported preset calls `observe` before any signal or command. A rejecting or hanging observe (capped at 3 s; use a short injected cap in the test) still stops.
  - A start that answers `running` calls `reload` with the state item read after the server answered, and the answer has `reloading`.
  - A `starting` answer does not reload.
  - An owner entry does not reload.
  - `list()` rows carry `models` for supported presets and `null` otherwise.
  - `onDone` writes an audit line `{ kind: 'runtime', action: 'reload', ok, loaded, failed }` with counts and no names. The control creates the memory's `onDone`, or exposes a `reloaded(id, result)` that server.js passes on. Pick one and say which in the report.
- [ ] Implement the wiring in control.js.
- [ ] In `server.js`:
  - create the memory (file `.data/runtimes/models.json` via `jsonFile`) and pass it in;
  - add the 30 s observe timer, only when control is on: not `AGENTS_OFF`, not Docker (use the same detection control uses), not `DEMO`;
  - the timer runs one pass at a time, is `unref`'d, and catches everything.
- [ ] Demo: `runtimesDemo()` gives Ollama `models: { remembered: ['llama3.2:3b'], loading: false, loaded: [], failed: [] }`, and a demo start answers `reloading: ['llama3.2:3b']`.
- [ ] Run the runtimes tests and `npm test`.
- [ ] Commit: "Reload a runtime's last models after Start, and remember them before Stop".

### Task 3: the UI text and the docs

**Files:**
- Modify: `public/runtimesview.js`, `docs/local-models.md`.
- Test: `test/runtimes-ui.test.js`.

**Interfaces:**
- Consumes: the `models` field of a runtime row, and the start answer's `reloading`.
- Produces:
  - `rtModelsText(r)`: the line under the action row, or `''`;
  - an updated `rtResultText('start', res)`;
  - an updated `rtConfirmText(r)`.

All texts are in the spec's "UI" section, verbatim.

Steps:
- [ ] Write the failing tests:
  - `rtModelsText` for:
    - stopped with remembered models (1, 2, and 3 or more);
    - loading;
    - loaded;
    - failed;
    - none;
    - `models: null`.
  - `rtResultText('start', { state: 'running', reloading: ['llama3.2:3b'] })` is "Started. Loading llama3.2:3b…".
  - The `rtConfirmText` text for Ollama, and the old text for a runtime with `models: null`.
  - `rtActionRow` shows the models line as text (the stand-in document refuses `innerHTML`).
  - A model name with `<b>` comes out literally.
- [ ] Implement it in `runtimesview.js`, and draw the line in `rtActionRow` (and `rtCard`, which uses it).
- [ ] Add the docs section "Models are loaded again on Start" to `docs/local-models.md`. It covers:
  - last seen loaded;
  - kept until Stop;
  - Ollama and LM Studio only;
  - only after the Start button;
  - the 30 s check;
  - `.data/runtimes/models.json`;
  - the audit action `reload`.

  Also update the Stop confirmation text quoted in the doc.
- [ ] Run `node --test test/runtimes-ui.test.js` and `npm test`.
- [ ] Commit: "Show the models a Start reloads, and document it".
