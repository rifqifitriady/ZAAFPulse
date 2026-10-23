# Start and Stop Local Model Servers from AI Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In AI Office the owner starts and stops every local model server on this machine with one button: Ollama, LM Studio, the llama.cpp server, Jan, LocalAI, and runtimes the owner defines in Settings → Local models. Commands come only from presets and approved owner entries; the dashboard only ever sends an id.

**Architecture:** A new `lib/runtimes/` module in four layers. `registry.js` describes each runtime (presets plus the owner's `config.json` "localRuntimes", validated, with a command hash for approval). `state.js` reads what is running from the process table (`lib/processes.js`, which gains each row's parent pid), the servers ZAAFPulse started, launchd's job list and Linux cgroups, and asks each health URL. `control.js` starts a server detached with its output in a log, and stops it the way it runs, reusing agent control's process checks (`sameProcess`, `sameStart`, `detectDocker`) and audit file. `api.js` is the HTTP side, mounted in `server.js` behind the dashboard sign-in. The browser side is one new script, `public/runtimesview.js`, which fills an action row on the existing Ollama and LM Studio cards, draws cards for the other runtimes in the same grid, and adds Settings → Local models.

**Tech Stack:** Node.js >= 18, CommonJS, zero runtime dependencies (`child_process`, `fs`, `http`, `crypto`), `node:test`; plain browser scripts (no build step), tested in Node with `require` and a stand-in document.

**Spec:** `docs/superpowers/specs/2026-10-23-local-runtimes-design.md`.

## Global Constraints

- Zero runtime dependencies; nothing is added to `package.json`.
- Node >= 18 and CommonJS (`require`/`module.exports`) everywhere; browser scripts are plain scripts with a `module.exports` guard for tests.
- No shell for any command: `spawn(argv[0], argv.slice(1), { shell: false })` only; the dashboard sends a runtime `id`, never a command.
- Commands come only from the presets and from owner entries in `config.json` that the owner approved in Settings; the approval is a SHA-256 of the command, so an edited command asks again.
- Never `SIGKILL`. Signal stop is `SIGINT`, then `SIGTERM` after a 5 s grace only if the same process (pid and start time) is still alive. Windows: `taskkill /PID n` without `/F`.
- Health wait after Start: poll every 500 ms for up to 30 s; each health request times out after 1.5 s.
- Stop wait: up to 10 s for the server to go, then `{ state: 'stopping', note: 'still shutting down' }`.
- Process identity check: agent control's `sameProcess` (pid plus start time within 2 s).
- Logs: `.data/runtimes/<id>.log`, mode 0600, rotated at 5 MB (one previous file `<id>.log.1` kept), last 20 lines shown, secrets masked, paths removed.
- Files ZAAFPulse writes (`started.json`, `approved.json`, logs, audit) are mode 0600 in folders of mode 0700.
- Dashboard sign-in only: the routes are mounted after `auth.check`; gateway API keys, MCP tools and A2A never reach them.
- Off in server mode (including password sign-in, `AGENTS_OFF`) and in Docker (`detectDocker`), with the reason shown on the card; demo mode simulates and starts nothing.
- Audit: every action, refused or not, is one line in `.data/agent-audit.jsonl` (the file agent control writes) with `kind: 'runtime'`; no command, path or log text in it.
- S1: log lines, errors and every other server text reach the page through `textContent`; the only `innerHTML` in `public/runtimesview.js` is the app's own icon markup.
- No filesystem path in any API error or log line (`PATHLIKE` → `[path]`); only Settings' own entry list shows the owner's command, with the home folder as `~`.
- `npm test` stays green after every task.
- Commits: stage only the files named in the task (`git add <files>`, never `-A` or `.`); commit messages carry no AI attribution lines (no `Co-Authored-By`).

## File map

| File | Task | Responsibility |
|---|---|---|
| `lib/processes.js` | 1 | process rows gain `ppid` (POSIX); new `parsePsRows` export |
| `test/processes-ppid.test.js` | 1 | parent pid from `ps` and `/proc` |
| `lib/runtimes/registry.js` | 2 | presets, owner entry validation, matchers, `commandHash` |
| `test/runtimes-registry.test.js` | 2 | presets, validation, hash |
| `lib/agents/control.js` | 3 | exports `sameStart` and a new `startOf` (used by state) |
| `lib/runtimes/state.js` | 3 | installed / running / healthy / how, children, `findBin`, `probe`, `jsonFile` |
| `test/runtimes-state.test.js` | 3 | synthetic process rows, fake PATH and app folders |
| `lib/monitors/api.js` | 4 | exports `PATHLIKE` (used by control and api) |
| `lib/runtimes/control.js` | 4 | start, stop, approve, forget, list, audit |
| `test/runtimes-control.test.js` | 4 | a fake runtime (a Node script on a port) and a fake kill |
| `lib/runtimes/api.js` | 5 | `/api/runtimes*` routes, JSON/415, scrubbing, Settings save/delete |
| `test/runtimes-api.test.js` | 5 | routes, status codes, no path in bodies |
| `lib/demo.js` | 6 | `runtimesDemo()` synthetic runtimes |
| `server.js` | 6 | builds state, control and api; mounts the routes behind sign-in |
| `test/runtimes-http.test.js` | 6 | spawned `server.js`: demo, config.json, sign-in gate, server mode |
| `public/runtimesview.js` | 7, 8 | AI Office action rows and cards (7); Settings → Local models (8) |
| `public/app.js` | 7, 8 | the slot on the Ollama and LM Studio cards (7); the Settings section (8) |
| `public/officeview.js` | 7 | marks the AI Office grid, mounts the runtimes |
| `public/index.html` | 7 | loads `runtimesview.js` |
| `public/styles.css` | 7 | `.rt-*` styles |
| `test/runtimes-ui.test.js` | 7 | pure helpers, text-only nodes, S1 audit |
| `test/runtimes-settings-ui.test.js` | 8 | Settings form helper and entry rows |
| `docs/local-models.md` | 9 | user documentation |
| `README.md` | 9 | links to the new doc and routes |

## Shared interfaces

These names are fixed; later tasks use them exactly as written here.

**`lib/processes.js` (Task 1).** A process row is `{ pid, ppid, cpu, rssKB, upSec, stopped, args, argv?, cwd? }`. `ppid` is set on macOS (`ps`) and Linux (`/proc`); Windows rows have none. New export `parsePsRows(stdout) -> rows`.

**`lib/runtimes/registry.js` (Task 2).**
- An entry: `{ id, name, preset, bin, app, brew, start, stop, health, port, openApp, upByHealth, command, match(row) -> boolean, error }`. Presets have `command: null`, `error: null`. Owner entries have `bin/app/brew/stop: null`, `start` equal to `command` when valid, `error` a reason string when not.
- `PRESETS` (frozen entries `ollama`, `lmstudio`, `llamacpp`, `jan`, `localai`), `PRESET_IDS: Set`, `ID_RE = /^[a-z0-9-]{1,40}$/`.
- `entries(list) -> [...PRESETS, ...ownerEntries(list)]`; `ownerEntries(list) -> entries`; `ownerEntry(raw, seen: Set, index = 0) -> entry`.
- `commandHash(command: string[]) -> hex sha256 of JSON.stringify(command)`; `storedEntry(entry) -> { id, name, command, port, health? }`; `progName(path) -> basename without .exe`.

**`lib/agents/control.js` (Task 3 adds exports).** `sameStart(a, b) -> boolean` (within 2 s), `startOf(row, t) -> ms | null`; existing `sameProcess`, `detectDocker`, `GRACE_MS` (5000).

**`lib/runtimes/state.js` (Task 3).**
- `createRuntimeState({ processes, entries, started, env, platform, home, binDirs, appDirs, brewPrefixes, launchctl, readCgroup, probe, now })` returns `{ list({ only }?) -> Promise<item[]>, one(id) -> Promise<item | null>, install(entry) }`.
- An item: `{ entry, installed, bin, app, startArgv, stopArgv, brewBin, running, healthy, how, pid, startTime, children, tableError }`; `how` is `'app' | 'service' | 'zaafpulse' | 'process' | 'system' | null`.
- Helpers: `jsonFile(file) -> { file, read() -> object, write(obj) }`, `probe(url, timeoutMs = 1500) -> Promise<boolean>`, `findBin(name, { env, platform, home, dirs }) -> path | null`, `parseLaunchctlList(out) -> Map<label, pid>`, `systemUnit(cgroupText) -> unit | null`, `HEALTH_TIMEOUT_MS`.

**`lib/monitors/api.js` (Task 4 adds export).** `PATHLIKE`: the global regex for absolute paths, replaced by `[path]`.

**`lib/runtimes/control.js` (Task 4).**
- `createRuntimeControl({ state, entries, dataDir, started, approvals, audit, spawn, kill, probe, platform, now, serverMode, inDocker, graceMs, stopWaitMs, healthWaitMs, pollMs, log })` returns `{ list, start, stop, approve, forget, approved, offReason, logTail }`.
- `list() -> Promise<row[]>`, a row being `{ id, name, preset, installed, running, healthy, how, pid, startTime, children, port, canStart, canStop, reason, approved, error }`.
- `start(id) -> { state: 'running' } | { state: 'starting', note, log }`; `stop({ id, pid, startTime }) -> { state: 'stopped' } | { state: 'stopping', note }`; `approve(id) -> { approved: true }`; `forget(id)`; `approved(entry) -> boolean`; `offReason() -> 'server' | 'docker' | null`; `logTail(id) -> string[]`.
- A refusal rejects with `Error { status: 400 | 403 | 404 | 409 | 502, message, log? }`.
- Also exported: `cleanLine(line)`, `OFF_TEXT`, `HEALTH_WAIT_MS` (30000), `STOP_WAIT_MS` (10000), `POLL_MS` (500).
- Audit line: `{ ts, kind: 'runtime', action: 'start' | 'stop' | 'approve', id, by: 'owner', ok, status?, error?, pid?, startTime?, how?, method?, signal?, note? }`.

**`lib/runtimes/api.js` (Task 5).** `createRuntimeApi({ control, config: { list(), save(list) }, demo, home })` returns `{ route(req) -> Promise<{ status, body } | null> }`, `req = { method, path, contentType, readBody }`. Routes: `GET /api/runtimes`, `GET /api/runtimes/config`, `POST /api/runtimes/start | stop | approve | save | delete`.

**`lib/demo.js` (Task 6).** `runtimesDemo(now?) -> { config, approved(id), list(), start(id), stop({ id, pid, startTime }), approve(id) }`.

**`public/runtimesview.js` (Tasks 7 and 8).** Pure: `rtStatus(r)`, `rtHowNote(r)`, `rtButton(r, busy)`, `rtConfirmText(r)`, `rtResultText(action, res)`, `rtErrorText(e)`, `rtLogLines(v)`, `rtCardPlan(list, slotIds)`, `rtEntryFromForm(f)` (8). Nodes: `rtActionRow(doc, r, ui)`, `rtCard(doc, r, ui, iconHtml)`, `rtEntryRow(doc, e)` (8). Browser: `RT_CARD_IDS`, `rtMount()` (7), `runtimesSettingsShell()`, `mountRuntimesSettings()` (8).

---
### Task 1: Process rows carry the parent pid

**Goal:** every POSIX process row says who its parent is, so Task 3 can tell a runtime's own helpers (Ollama's runners, its `llama-server`) from a server of their own, and a launchd-run server (parent pid 1) from one started in a terminal. `ps` gains the `ppid=` column; `/proc/<pid>/stat` already has it (the field after the state letter). The parsing of `ps` output moves into an exported pure function so it can be tested. Windows rows are unchanged (no parent pid).

**Files**

- Modify: `lib/processes.js` (the exact existing text to replace is quoted in Step 3)
- Test: `test/processes-ppid.test.js` (new)

**Interfaces**

- Consumes: nothing new.
- Produces: `parsePsRows(stdout: string) -> [{ pid, ppid, cpu, rssKB, upSec, stopped, args }]`; `procRows(root, hz)` rows gain `ppid: number`; `rows()` (used by agent control and Task 3) returns rows with `ppid` on macOS and Linux.

- [ ] **Step 1: Write the failing test**

Create `test/processes-ppid.test.js`:

```js
// Process rows carry the parent's pid, so a local model server's helpers (Ollama's runners, its llama-server) count
// toward the server instead of being taken for a server of their own (lib/runtimes/state.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePsRows, procRows, rows } = require('../lib/processes');

test('parsePsRows: pid, parent pid, cpu, memory, age, stopped and the command line', () => {
  const out = [
    '  101     1   0.5  20480    01:02:03 Ss   /opt/homebrew/opt/ollama/bin/ollama serve',
    '  202   101  12.0 409600       00:42 S    /opt/homebrew/Cellar/ollama/0.12.6/bin/ollama runner --model /x/blob',
    '  303   300   0.0   1024  2-00:00:01 T    /Applications/LM Studio.app/Contents/MacOS/LM Studio',
    'garbage',
    '',
  ].join('\n');
  const r = parsePsRows(out);
  assert.deepEqual(
    r.map((x) => [x.pid, x.ppid, x.cpu, x.rssKB, x.upSec, x.stopped]),
    [
      [101, 1, 0.5, 20480, 3723, false],
      [202, 101, 12, 409600, 42, false],
      [303, 300, 0, 1024, 172801, true],
    ],
  );
  assert.equal(r[2].args, '/Applications/LM Studio.app/Contents/MacOS/LM Studio');
});

test('procRows: the parent pid is the field after the state letter', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-procppid-'));
  fs.writeFileSync(path.join(root, 'uptime'), '1000.00 900.00');
  const d = path.join(root, '71');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'cmdline'), ['/usr/local/bin/ollama', 'runner', '--port', '40001'].join('\0'));
  fs.writeFileSync(path.join(d, 'stat'), `71 (ollama) S 70 ${'0 '.repeat(9)}100 0 0 0 0 0 0 0 100 0`);
  fs.writeFileSync(path.join(d, 'status'), 'VmRSS:\t1024 kB\n');
  const [r] = procRows(root, 100);
  assert.equal(r.pid, 71);
  assert.equal(r.ppid, 70);
  assert.equal(r.args, '/usr/local/bin/ollama runner --port 40001');
  fs.rmSync(root, { recursive: true, force: true });
});

test('rows: this process is listed with its parent', { skip: process.platform === 'win32' }, async () => {
  const me = (await rows()).find((r) => r.pid === process.pid);
  assert.ok(me, 'this test process is in the table');
  assert.equal(me.ppid, process.ppid);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/processes-ppid.test.js test/processes.test.js test/platform.test.js`

Expected: FAIL. `TypeError: parsePsRows is not a function` in the first test; the `/proc` test fails on `r.ppid` (`undefined !== 70`); the live `rows()` test fails on `me.ppid` (`undefined`). `ℹ fail 3`.

- [ ] **Step 3: Implement**

In `lib/processes.js`, replace:

```js
// Every process as { pid, cpu, rssKB, upSec, args }. cpu is the lifetime average share of one core,
// the way ps reports %CPU, so the numbers mean the same thing on every OS. On POSIX a row also says whether the
// process is stopped (SIGSTOP or job control), which agent control reads back after a restart.
function psRows() {
  return new Promise((resolve, reject) =>
    execFile('ps', ['-axo', 'pid=,pcpu=,rss=,etime=,stat=,args='], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(
        stdout
          .split('\n')
          .map((raw) => raw.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/))
          .filter(Boolean)
          .map((m) => ({
            pid: Number(m[1]),
            cpu: Number(m[2]),
            rssKB: Number(m[3]),
            upSec: parseEtime(m[4]),
            stopped: m[5].includes('T'),
            args: m[6],
          })),
      );
    }),
  );
}
```

with:

```js
// Every process as { pid, ppid, cpu, rssKB, upSec, args }. cpu is the lifetime average share of one core,
// the way ps reports %CPU, so the numbers mean the same thing on every OS. On POSIX a row also says whether the
// process is stopped (SIGSTOP or job control), which agent control reads back after a restart, and its parent's pid,
// which tells a local model server's own helpers from a server of their own (lib/runtimes/state.js).
function parsePsRows(stdout) {
  return String(stdout)
    .split('\n')
    .map((raw) => raw.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      rssKB: Number(m[4]),
      upSec: parseEtime(m[5]),
      stopped: m[6].includes('T'),
      args: m[7],
    }));
}
function psRows() {
  return new Promise((resolve, reject) =>
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,stat=,args='],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(parsePsRows(stdout))),
    ),
  );
}
```

In `lib/processes.js`, replace:

```js
        pid: Number(d),
        cpu: (cpuSec / upSec) * 100,
```

with:

```js
        pid: Number(d),
        ppid: Number(f[1]), // the field after the state letter
        cpu: (cpuSec / upSec) * 100,
```

In `lib/processes.js`, replace:

```js
  procRows,
  parseWinRows,
```

with:

```js
  procRows,
  parsePsRows,
  parseWinRows,
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/processes-ppid.test.js test/processes.test.js test/platform.test.js`

Expected: PASS (`ℹ fail 0`).

Run: `npm test`

Expected: PASS (`ℹ fail 0`).

- [ ] **Step 5: Commit**

```bash
git add lib/processes.js test/processes-ppid.test.js
git commit -m "Read each process's parent pid"
```

---

### Task 2: Runtime registry: presets and owner entries

**Goal:** one place that says what a runtime is. The five presets come from the spec's table; LM Studio's server lives inside its app or daemon, so it counts as running only while its health URL answers (`upByHealth`). `openApp` says whether opening the app starts the server (Ollama, Jan: yes; LM Studio: no). The owner's entries from `config.json` "localRuntimes" are validated (id, command, port, optional loopback-only health URL); an invalid entry keeps its reason and can never start. An owner entry's server is recognised by its program's file name and, when its command names the port, that port.

**Files**

- Create: `lib/runtimes/registry.js`
- Test: `test/runtimes-registry.test.js` (new)

**Interfaces**

- Consumes: `crypto` only.
- Produces: `PRESETS`, `PRESET_IDS`, `ID_RE`, `entries(list)`, `ownerEntries(list)`, `ownerEntry(raw, seen, index)`, `commandHash(command)`, `storedEntry(entry)`, `progName(path)`, with the entry shape in Shared interfaces.

- [ ] **Step 1: Write the failing test**

Create `test/runtimes-registry.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { PRESETS, entries, ownerEntries, commandHash, storedEntry } = require('../lib/runtimes/registry');

const row = (args, argv) => ({ pid: 9, ppid: 1, args, ...(argv ? { argv } : {}) });
const preset = (id) => PRESETS.find((p) => p.id === id);
const QWEN = {
  id: 'qwen-local',
  name: 'Qwen (llama.cpp)',
  command: ['llama-server', '-m', '/models/qwen.gguf', '--port', '8081'],
  port: 8081,
};

test('presets: ids, start and stop commands, health URLs', () => {
  assert.deepEqual(
    PRESETS.map((p) => p.id),
    ['ollama', 'lmstudio', 'llamacpp', 'jan', 'localai'],
  );
  assert.deepEqual(preset('ollama').start, ['ollama', 'serve']);
  assert.equal(preset('ollama').stop, null);
  assert.equal(preset('ollama').health, 'http://127.0.0.1:11434/api/version');
  assert.equal(preset('ollama').brew, 'ollama');
  assert.equal(preset('ollama').app, 'Ollama.app');
  assert.deepEqual(preset('lmstudio').start, ['lms', 'server', 'start']);
  assert.deepEqual(preset('lmstudio').stop, ['lms', 'server', 'stop']);
  assert.equal(preset('lmstudio').health, 'http://127.0.0.1:1234/v1/models');
  assert.equal(preset('lmstudio').upByHealth, true);
  assert.equal(preset('llamacpp').start, null, 'it needs a model path: an owner entry');
  assert.equal(preset('ollama').openApp, true, 'Ollama.app starts its server');
  assert.equal(preset('lmstudio').openApp, false, 'opening LM Studio does not start its server');
  assert.equal(preset('jan').openApp, true);
  assert.equal(preset('jan').health, 'http://127.0.0.1:1337/v1/models');
  assert.equal(preset('jan').app, 'Jan.app');
  assert.deepEqual(preset('localai').start, ['local-ai', 'run']);
  assert.equal(preset('localai').health, 'http://127.0.0.1:8080/readyz');
  for (const p of PRESETS) {
    assert.equal(p.preset, true);
    assert.ok(Object.isFrozen(p));
  }
});

test('presets: each recognises its own server and not its helpers', () => {
  const o = preset('ollama').match;
  assert.ok(o(row('/opt/homebrew/opt/ollama/bin/ollama serve')));
  assert.ok(o(row('/Applications/Ollama.app/Contents/Resources/ollama serve')));
  assert.ok(o(row('C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe serve')));
  assert.ok(!o(row('/opt/homebrew/Cellar/ollama/0.12.6/bin/ollama runner --model /x')), 'a runner is a child');
  assert.ok(!o(row('/Applications/Ollama.app/Contents/MacOS/Ollama')), 'the app itself is not the server');
  assert.ok(!o(row('vim ollama-notes.md')));
  const l = preset('lmstudio').match;
  assert.ok(l(row('/Applications/LM Studio.app/Contents/MacOS/LM Studio')));
  assert.ok(l(row('/Users/u/.lmstudio/bin/llmster --port 1234')));
  assert.ok(
    !l(row('/Applications/LM Studio.app/Contents/Frameworks/LM Studio Helper (GPU).app/Contents/MacOS/LM Studio Helper (GPU) --type=gpu-process')),
  );
  assert.ok(preset('llamacpp').match(row('/opt/homebrew/bin/llama-server -m /m.gguf --port 8081')));
  assert.ok(!preset('llamacpp').match(row('/opt/homebrew/bin/llama-server-helper')));
  assert.ok(preset('jan').match(row('/Applications/Jan.app/Contents/MacOS/Jan')));
  assert.ok(preset('localai').match(row('/usr/local/bin/local-ai run --models-path /m')));
  assert.ok(preset('localai').match(row('/usr/local/bin/local-ai')));
  assert.ok(!preset('localai').match(row('/usr/local/bin/local-ai models list')));
});

test('owner entries: a valid entry gets its start command, a default health URL and a matcher by program and port', () => {
  const [e] = ownerEntries([QWEN]);
  assert.equal(e.error, null);
  assert.equal(e.preset, false);
  assert.deepEqual(e.start, QWEN.command);
  assert.equal(e.health, 'http://127.0.0.1:8081/');
  assert.ok(e.match(row('/opt/homebrew/bin/llama-server -m /models/qwen.gguf --port 8081')));
  assert.ok(!e.match(row('/opt/homebrew/bin/llama-server -m /models/other.gguf --port 8082')), 'another port');
  assert.ok(!e.match(row('/usr/bin/python3 -m http.server 8081')), 'another program');
  const spaced = '/opt/my tools/llama-server --port 8081';
  assert.ok(e.match(row(spaced, ['/opt/my tools/llama-server', '--port', '8081'])), 'argv[0] when the row has one');
  assert.ok(!e.match(row(spaced)), 'without argv the first word is the program');
  const [h] = ownerEntries([{ ...QWEN, health: 'http://localhost:8081/health' }]);
  assert.equal(h.health, 'http://localhost:8081/health');
  assert.deepEqual(entries([QWEN]).map((x) => x.id), ['ollama', 'lmstudio', 'llamacpp', 'jan', 'localai', 'qwen-local']);
  assert.deepEqual(entries(undefined).length, 5);
  assert.deepEqual(entries({ not: 'a list' }).length, 5);
});

test('owner entries: invalid ones keep their reason and cannot start', () => {
  const err = (raw) => ownerEntries([raw])[0].error;
  assert.match(err({ ...QWEN, id: 'Bad Id' }), /id must be/);
  assert.match(err({ ...QWEN, id: 'x'.repeat(41) }), /id must be/);
  assert.match(err({ ...QWEN, command: 'llama-server -m x' }), /command must be a non-empty list of strings/);
  assert.match(err({ ...QWEN, command: [] }), /command must be a non-empty list/);
  assert.match(err({ ...QWEN, command: ['llama-server', 8081] }), /command must be a non-empty list of strings/);
  assert.match(err({ ...QWEN, command: ['llama-server', 'x'.repeat(1001)] }), /at most 1000 characters/);
  assert.match(err({ ...QWEN, command: [' '] }), /start with a program/);
  assert.match(err({ ...QWEN, port: 0 }), /port must be/);
  assert.match(err({ ...QWEN, port: 65536 }), /port must be/);
  assert.match(err({ ...QWEN, port: 80.5 }), /port must be/);
  assert.match(err({ ...QWEN, port: '8081' }), /port must be/);
  assert.match(err({ ...QWEN, id: 'ollama' }), /preset/);
  assert.match(err({ ...QWEN, health: 'http://example.com/' }), /on this machine/);
  assert.match(err({ ...QWEN, health: 'file:///etc/passwd' }), /on this machine/);
  assert.match(err('just text'), /must be an object/);
  const dup = ownerEntries([QWEN, { ...QWEN, name: 'Again' }]);
  assert.equal(dup[0].error, null);
  assert.match(dup[1].error, /same id/);
  for (const e of ownerEntries([{ ...QWEN, port: 0 }, 'x'])) {
    assert.equal(e.start, null);
    assert.equal(e.match(row('/opt/homebrew/bin/llama-server --port 8081')), false);
  }
});

test('commandHash changes with the command; storedEntry keeps only the stored fields', () => {
  const a = commandHash(QWEN);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(commandHash([...QWEN.command]), a);
  assert.notEqual(commandHash([...QWEN.command.slice(0, -1), '8082']), a);
  assert.notEqual(commandHash(['llama-server -m', '/models/qwen.gguf']), commandHash(['llama-server', '-m /models/qwen.gguf']));
  const [e] = ownerEntries([QWEN]);
  assert.deepEqual(storedEntry(e), { ...QWEN, health: 'http://127.0.0.1:8081/' });
  assert.deepEqual(storedEntry({ ...e, health: null }), QWEN);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/runtimes-registry.test.js`

Expected: FAIL. `Error: Cannot find module '../lib/runtimes/registry'`. `ℹ fail 1`.

- [ ] **Step 3: Implement**

Create `lib/runtimes/registry.js`:

```js
// Local model runtimes: the presets (Ollama, LM Studio, llama.cpp server, Jan, LocalAI) and the owner's own entries
// from config.json "localRuntimes". An entry says how its server is found in the process table, started, stopped and
// checked; the dashboard only ever sends an id. An owner entry starts only after the owner approved it in Settings, and
// the approval is a hash of its command, so editing the command asks again. Nothing here starts or signals anything
// (lib/runtimes/control.js does).
const crypto = require('crypto');

const ID_RE = /^[a-z0-9-]{1,40}$/;
const MAX_ARG = 1000; // characters in one argument of an owner's command
const MAX_NAME = 60;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const baseName = (p) => String(p).split(/[\\/]/).pop();
const progName = (p) => baseName(p).replace(/\.exe$/i, '');
const byArgs = (re) => (row) => re.test(String((row && row.args) || ''));

// Each preset:
// - bin: the program looked up on PATH and the usual folders; app: the macOS app bundle; brew: the Homebrew formula;
// - start / stop: argv without a shell, [bin, ...] (stop: the runtime's own stop command, when it has one);
// - openApp: opening the app starts the server (`open -a`), used when the program is not on this machine;
// - health: answers while the server is up; upByHealth: the server lives inside a process that stays up without it
//   (LM Studio's app or daemon), so "running" means the health URL answers;
// - match(row): whether a process-table row is this runtime's server.
const PRESETS = [
  {
    id: 'ollama',
    name: 'Ollama',
    bin: 'ollama',
    app: 'Ollama.app',
    brew: 'ollama',
    start: ['ollama', 'serve'],
    stop: null,
    health: 'http://127.0.0.1:11434/api/version',
    port: 11434,
    openApp: true,
    upByHealth: false,
    match: byArgs(/(^|[\\/])ollama(\.exe)?\s+serve(\s|$)/i),
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    bin: 'lms',
    app: 'LM Studio.app',
    brew: null,
    start: ['lms', 'server', 'start'],
    stop: ['lms', 'server', 'stop'],
    health: 'http://127.0.0.1:1234/v1/models',
    port: 1234,
    openApp: false,
    upByHealth: true,
    match: byArgs(/[\\/]LM Studio(\.app[\\/]Contents[\\/]MacOS[\\/]LM Studio|\.exe)(\s|$)|(^|[\\/])llmster(\.exe)?(\s|$)/i),
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    bin: 'llama-server',
    app: null,
    brew: 'llama.cpp',
    start: null, // it needs a model path: the owner adds it as an entry of their own
    stop: null,
    health: null,
    port: null,
    openApp: false,
    upByHealth: false,
    match: byArgs(/(^|[\\/])llama-server(\.exe)?(\s|$)/i),
  },
  {
    id: 'jan',
    name: 'Jan',
    bin: null,
    app: 'Jan.app',
    brew: null,
    start: null, // the app is opened (openApp)
    stop: null,
    health: 'http://127.0.0.1:1337/v1/models', // only while Jan's local API server is on
    port: 1337,
    openApp: true,
    upByHealth: false,
    match: byArgs(/[\\/]Jan\.app[\\/]Contents[\\/]MacOS[\\/]Jan(\s|$)/),
  },
  {
    id: 'localai',
    name: 'LocalAI',
    bin: 'local-ai',
    app: null,
    brew: 'localai',
    start: ['local-ai', 'run'],
    stop: null,
    health: 'http://127.0.0.1:8080/readyz',
    port: 8080,
    openApp: false,
    upByHealth: false,
    match: byArgs(/(^|[\\/])local-ai(\.exe)?(\s+run(\s|$)|\s*$)/i),
  },
].map((p) => Object.freeze({ ...p, preset: true, command: null, error: null }));
const PRESET_IDS = new Set(PRESETS.map((p) => p.id));

// The approval of an owner entry: a hash of its command, so a changed command needs a new approval.
const commandHash = (command) => crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex');

// An owner entry's server: a process run by the same program (its file name) that, when the command names the port,
// names it too, so two llama-server entries on different ports are told apart.
function ownerMatch(command, port) {
  const prog = progName(command[0]);
  const names = command.slice(1).some((a) => a === String(port) || a.endsWith(`=${port}`) || a.endsWith(`:${port}`));
  const portRe = new RegExp(`(^|[\\s=:])${port}(\\s|$)`);
  return (row) => {
    if (!row) return false;
    const args = String(row.args || '');
    const first = Array.isArray(row.argv) && typeof row.argv[0] === 'string' ? row.argv[0] : args.split(/\s+/)[0];
    return progName(first) === prog && (!names || portRe.test(args));
  };
}

function healthUrl(raw, port) {
  if (raw === undefined || raw === null || raw === '') return { url: `http://127.0.0.1:${port}/` };
  if (typeof raw !== 'string' || raw.length > MAX_ARG) return { error: 'health must be a URL' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'health must be a URL' };
  }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname))
    return { error: 'health must be an http:// URL on this machine (127.0.0.1, localhost or [::1])' };
  return { url: u.href };
}

// One owner entry as stored in config.json, checked. `seen` holds the ids of the entries before it. An invalid entry
// keeps its `error` and cannot start; it is still listed so the owner sees why.
function ownerEntry(raw, seen, index = 0) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = typeof obj.id === 'string' ? obj.id.slice(0, 40) : `entry-${index + 1}`;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, MAX_NAME) : id;
  const out = {
    id,
    name,
    preset: false,
    bin: null,
    app: null,
    brew: null,
    start: null,
    stop: null,
    health: null,
    port: Number.isInteger(obj.port) ? obj.port : null,
    openApp: false,
    upByHealth: false,
    command: Array.isArray(obj.command) ? obj.command.filter((a) => typeof a === 'string') : [],
    match: () => false,
    error: null,
  };
  const bad = (error) => ({ ...out, error });
  if (obj !== raw) return bad('an entry must be an object');
  if (!ID_RE.test(obj.id || '')) return bad('id must be 1 to 40 lowercase letters, digits or dashes');
  if (PRESET_IDS.has(id)) return bad(`${id} is the id of a preset`);
  if (seen.has(id)) return bad('another entry has the same id');
  const cmd = obj.command;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === 'string'))
    return bad('command must be a non-empty list of strings');
  if (cmd.some((a) => a.length > MAX_ARG)) return bad(`each argument of command must be at most ${MAX_ARG} characters`);
  if (!cmd[0].trim()) return bad('command must start with a program');
  if (!(Number.isInteger(obj.port) && obj.port >= 1 && obj.port <= 65535))
    return bad('port must be a whole number from 1 to 65535');
  const h = healthUrl(obj.health, obj.port);
  if (h.error) return bad(h.error);
  return { ...out, command: [...cmd], start: [...cmd], health: h.url, match: ownerMatch(cmd, obj.port) };
}

// The owner's entries from config.json "localRuntimes" (anything but a list is no entries).
function ownerEntries(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map((raw, i) => {
    const e = ownerEntry(raw, seen, i);
    if (!e.error) seen.add(e.id);
    return e;
  });
}

// Every runtime: the presets, then the owner's entries.
const entries = (list) => [...PRESETS, ...ownerEntries(list)];

// An entry as it is stored in config.json, from what Settings sends; null fields are left out.
const storedEntry = (e) => ({
  id: e.id,
  name: e.name,
  command: e.command,
  port: e.port,
  ...(typeof e.health === 'string' && e.health ? { health: e.health } : {}),
});

module.exports = { PRESETS, PRESET_IDS, ID_RE, entries, ownerEntries, ownerEntry, commandHash, storedEntry, progName };
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/runtimes-registry.test.js`

Expected: PASS (`ℹ fail 0`).

Run: `npm test`

Expected: PASS (`ℹ fail 0`).

- [ ] **Step 5: Commit**

```bash
git add lib/runtimes/registry.js test/runtimes-registry.test.js
git commit -m "Describe local model runtimes: presets and owner entries"
```

---

### Task 3: Runtime state: installed, running, healthy, and how

**Goal:** read what each runtime is doing. A row matching a runtime is its **server** unless a matching process sits above it within four parents, in which case it is that server's **child** (counted, never signalled). Owner entries are matched before presets, so the owner's `llama-server` on port 8081 is theirs while another `llama-server` stays the llama.cpp preset. `how` is decided in this order: `zaafpulse` (pid and start time recorded in `started.json`), `app` (the server or its parent runs from `<App>.app/Contents/MacOS/`), `service` (macOS, parent pid 1 and `launchctl list` has `homebrew.mxcl.<formula>` with this pid), `system` (Linux, `/proc/<pid>/cgroup` under `/system.slice/*.service`), else `process`. Health URLs are asked in parallel, each for at most 1.5 s. Installed means the program is on PATH or the usual folders, the app is in `/Applications` or `~/Applications`, or the Homebrew formula is present. `startArgv` uses the program found (`[bin, ...start.slice(1)]`), else `['/usr/bin/open', '-a', app]` when `openApp`. Start times use agent control's `startOf` and are kept stable across reads with `sameStart`, exactly as agent control does, so this task exports those two helpers from `lib/agents/control.js` (the private computation in its `table()` is replaced by `startOf`, no behaviour change).

**Files**

- Create: `lib/runtimes/state.js`
- Modify: `lib/agents/control.js` (the exact existing text to replace is quoted in Step 3)
- Test: `test/runtimes-state.test.js` (new)

**Interfaces**

- Consumes: `lib/processes.js` `rows()` rows with `ppid` (Task 1) and `isOwn(row)`; `lib/agents/control.js` `sameStart`, `startOf` (exported here); registry entries (Task 2).
- Produces: `createRuntimeState(...)`, `jsonFile`, `probe`, `findBin`, `parseLaunchctlList`, `systemUnit`, `HEALTH_TIMEOUT_MS`, with the item shape in Shared interfaces.

- [ ] **Step 1: Write the failing test**

Create `test/runtimes-state.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { entries } = require('../lib/runtimes/registry');
const {
  createRuntimeState,
  jsonFile,
  probe,
  findBin,
  parseLaunchctlList,
  systemUnit,
} = require('../lib/runtimes/state');

const NOW = 1_800_000_000_000;
const startOf = (upSec) => Math.round((NOW - upSec * 1000) / 1000) * 1000;
const row = (pid, ppid, args, upSec = 600) => ({ pid, ppid, cpu: 0, rssKB: 1024, upSec, args });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const exe = (dir, name) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
  return f;
};
const QWEN = { id: 'qwen-local', name: 'Qwen', command: ['llama-server', '--port', '8081'], port: 8081 };

// A state over synthetic rows: nothing on PATH, no app or brew folders, no health answers unless `answers` says so.
function stateOf(rows, opts = {}) {
  let launchctlCalls = 0;
  const st = createRuntimeState({
    processes: { rows: async () => (typeof rows === 'function' ? rows() : rows) },
    entries: () => entries(opts.config || []),
    started: { read: () => opts.started || {} },
    env: { PATH: '' },
    platform: opts.platform || 'darwin',
    home: '/nonexistent-home',
    binDirs: [],
    appDirs: [],
    brewPrefixes: [],
    launchctl: async () => {
      launchctlCalls++;
      return opts.jobs || new Map();
    },
    readCgroup: opts.readCgroup || (() => ''),
    probe: async (url) => (opts.answers || []).includes(url),
    now: () => NOW,
    ...opts.extra,
  });
  return { st, launchctlCalls: () => launchctlCalls };
}
const byId = (list) => Object.fromEntries(list.map((x) => [x.entry.id, x]));

test('a server started by the Ollama app: how is app, its runner and llama-server count as children', async () => {
  const rows = [
    row(500, 1, '/Applications/Ollama.app/Contents/MacOS/Ollama'),
    row(501, 500, '/Applications/Ollama.app/Contents/Resources/ollama serve', 590),
    row(502, 501, '/Applications/Ollama.app/Contents/Resources/ollama runner --model /x/blob --port 50123', 30),
    row(503, 501, '/Applications/Ollama.app/Contents/Resources/llama-server --model /x/blob --port 50124', 20),
  ];
  const { st } = stateOf(rows, { answers: ['http://127.0.0.1:11434/api/version'] });
  const x = byId(await st.list());
  assert.equal(x.ollama.running, true);
  assert.equal(x.ollama.healthy, true);
  assert.equal(x.ollama.how, 'app');
  assert.equal(x.ollama.pid, 501);
  assert.equal(x.ollama.startTime, startOf(590));
  assert.equal(x.ollama.children, 2);
  assert.equal(x.llamacpp.running, false, "Ollama's llama-server is its child, not a llama.cpp server");
});

test('a server launchd runs as homebrew.mxcl.ollama is a brew service', async () => {
  const brew = tmp('zp-rt-brew-');
  const brewBin = exe(path.join(brew, 'bin'), 'brew');
  const rows = [row(601, 1, '/opt/homebrew/opt/ollama/bin/ollama serve')];
  const jobs = new Map([['homebrew.mxcl.ollama', 601]]);
  const { st } = stateOf(rows, { jobs, extra: { brewPrefixes: [brew] } });
  const o = byId(await st.list()).ollama;
  assert.equal(o.how, 'service');
  assert.equal(o.brewBin, brewBin);
  assert.equal(o.healthy, false, 'running but not answering');
  // Another job's pid, or none, is not a service.
  const other = stateOf(rows, { jobs: new Map([['homebrew.mxcl.ollama', 999]]) });
  assert.equal(byId(await other.st.list()).ollama.how, 'process');
  fs.rmSync(brew, { recursive: true, force: true });
});

test('a server ZAAFPulse started is zaafpulse, by pid and start time; a reused pid is not', async () => {
  const rows = [row(701, 1, '/opt/homebrew/bin/ollama serve')];
  const mine = stateOf(rows, { started: { ollama: { pid: 701, startTime: startOf(600) + 1000 } } });
  assert.equal(byId(await mine.st.list()).ollama.how, 'zaafpulse');
  assert.equal(mine.launchctlCalls(), 0, 'launchd is not asked about our own server');
  const reused = stateOf(rows, { started: { ollama: { pid: 701, startTime: startOf(600) - 60000 } } });
  assert.equal(byId(await reused.st.list()).ollama.how, 'process');
});

test('a server run from a shell is a process; the oldest of two servers is the one listed', async () => {
  const rows = [
    row(800, 1, '-zsh'),
    row(802, 800, '/usr/local/bin/ollama serve', 100),
    row(801, 800, '/usr/local/bin/ollama serve', 900),
  ];
  const o = byId((await stateOf(rows).st.list())).ollama;
  assert.equal(o.how, 'process');
  assert.equal(o.pid, 801);
});

test('Linux: a systemd system unit is "system"; a user unit or a terminal is a process', async () => {
  const rows = [row(901, 1, '/usr/local/bin/ollama serve')];
  const sys = stateOf(rows, { platform: 'linux', readCgroup: () => '0::/system.slice/ollama.service\n' });
  assert.equal(byId(await sys.st.list()).ollama.how, 'system');
  const user = stateOf(rows, {
    platform: 'linux',
    readCgroup: () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/ollama.service\n',
  });
  assert.equal(byId(await user.st.list()).ollama.how, 'process');
  const gone = stateOf(rows, {
    platform: 'linux',
    readCgroup: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(byId(await gone.st.list()).ollama.how, 'process');
});

test('an owner entry claims the llama-server on its port; another port stays the llama.cpp preset', async () => {
  const rows = [
    row(1001, 1, '/opt/homebrew/bin/llama-server -m /m/qwen.gguf --port 8081'),
    row(1002, 1, '/opt/homebrew/bin/llama-server -m /m/other.gguf --port 9090'),
  ];
  const x = byId(await stateOf(rows, { config: [QWEN] }).st.list());
  assert.equal(x['qwen-local'].pid, 1001);
  assert.equal(x.llamacpp.pid, 1002);
  assert.equal(x.llamacpp.running, true);
});

test('LM Studio counts as running only while its health URL answers', async () => {
  const rows = [row(1101, 1, '/Applications/LM Studio.app/Contents/MacOS/LM Studio')];
  const off = byId(await stateOf(rows).st.list()).lmstudio;
  assert.equal(off.running, false, 'the app is open, the server is off');
  assert.equal(off.pid, null);
  const on = byId(await stateOf(rows, { answers: ['http://127.0.0.1:1234/v1/models'] }).st.list()).lmstudio;
  assert.equal(on.running, true);
  assert.equal(on.how, 'app');
  assert.equal(on.pid, 1101);
});

// POSIX paths and executable bits: the Windows CI skips it.
test('installed from a fake PATH, fake app folders and a fake Homebrew; the start argv uses what was found', { skip: process.platform === 'win32' }, async () => {
  const bin = tmp('zp-rt-bin-');
  const ollama = exe(bin, 'ollama');
  exe(bin, 'llama-server');
  const apps = tmp('zp-rt-apps-');
  fs.mkdirSync(path.join(apps, 'Jan.app'));
  fs.mkdirSync(path.join(apps, 'Ollama.app'));
  const brew = tmp('zp-rt-brew-');
  fs.mkdirSync(path.join(brew, 'opt', 'localai'), { recursive: true });
  const { st } = stateOf([], {
    config: [QWEN],
    extra: { env: { PATH: bin }, appDirs: [apps], brewPrefixes: [brew] },
  });
  const x = byId(await st.list());
  assert.equal(x.ollama.installed, true);
  assert.deepEqual(x.ollama.startArgv, [ollama, 'serve'], 'the program beats opening the app');
  assert.equal(x.jan.installed, true);
  assert.deepEqual(x.jan.startArgv, ['/usr/bin/open', '-a', path.join(apps, 'Jan.app')]);
  assert.equal(x.localai.installed, true, 'the Homebrew formula is there');
  assert.equal(x.localai.startArgv, null, 'but its program is not on PATH');
  assert.equal(x.lmstudio.installed, false);
  assert.equal(x.llamacpp.installed, true);
  assert.equal(x.llamacpp.startArgv, null, 'needs an owner entry with a model path');
  assert.deepEqual(x['qwen-local'].startArgv, [path.join(bin, 'llama-server'), '--port', '8081']);
  for (const d of [bin, apps, brew]) fs.rmSync(d, { recursive: true, force: true });
});

test('one(id) reads one runtime; an unreadable table says so and nothing runs', async () => {
  const rows = [row(1201, 1, '/usr/local/bin/ollama serve')];
  const { st } = stateOf(rows);
  assert.equal((await st.one('ollama')).pid, 1201);
  assert.equal(await st.one('nope'), null);
  const broken = stateOf(() => {
    throw new Error('ps failed');
  });
  const o = await broken.st.one('ollama');
  assert.equal(o.running, false);
  assert.equal(o.tableError, 'the process table could not be read');
});

test('findBin: absolute paths as given, PATH then the usual folders, never a relative path', () => {
  const d = tmp('zp-rt-find-');
  const f = exe(d, 'tool');
  fs.writeFileSync(path.join(d, 'plain'), 'x', { mode: 0o644 });
  if (process.platform !== 'win32') {
    assert.equal(findBin(f, { platform: 'darwin' }), f);
    assert.equal(findBin('tool', { env: { PATH: d }, platform: 'darwin', dirs: [] }), f);
    assert.equal(findBin('tool', { env: { PATH: '' }, platform: 'darwin', dirs: [d] }), f);
    assert.equal(findBin('plain', { env: { PATH: d }, platform: 'darwin', dirs: [] }), null, 'not executable');
  }
  assert.equal(findBin('./tool', { env: { PATH: d }, dirs: [] }), null);
  assert.equal(findBin('missing', { env: { PATH: d }, dirs: [] }), null);
  assert.equal(findBin('', {}), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('parseLaunchctlList and systemUnit', () => {
  const jobs = parseLaunchctlList('PID\tStatus\tLabel\n601\t0\thomebrew.mxcl.ollama\n-\t0\thomebrew.mxcl.redis\n');
  assert.deepEqual([...jobs], [['homebrew.mxcl.ollama', 601]]);
  assert.equal(systemUnit('0::/system.slice/ollama.service\n'), 'ollama.service');
  assert.equal(systemUnit('12:pids:/system.slice/local-ai.service\n0::/system.slice/local-ai.service'), 'local-ai.service');
  assert.equal(systemUnit('0::/user.slice/user-1000.slice/session-2.scope\n'), null);
  assert.equal(systemUnit(''), null);
});

test('jsonFile: mode 0600, written whole, an unreadable file reads as {}', () => {
  const d = tmp('zp-rt-json-');
  const f = jsonFile(path.join(d, 'runtimes', 'started.json'));
  assert.deepEqual(f.read(), {});
  f.write({ ollama: { pid: 5, startTime: 1 } });
  assert.deepEqual(f.read(), { ollama: { pid: 5, startTime: 1 } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  fs.writeFileSync(f.file, '[1,2]');
  assert.deepEqual(f.read(), {});
  fs.rmSync(d, { recursive: true, force: true });
});

test('probe: an answer below 500 within the time counts; 503, a closed port and silence do not', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/hang') return; // never answers
    res.writeHead(req.url === '/busy' ? 503 : 200);
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await probe(`${base}/api/version`), true);
  assert.equal(await probe(`${base}/busy`), false);
  const t = Date.now();
  assert.equal(await probe(`${base}/hang`, 200), false);
  assert.ok(Date.now() - t < 1000);
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  assert.equal(await probe(`${base}/api/version`), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/runtimes-state.test.js test/agents-control.test.js`

Expected: FAIL. `Error: Cannot find module '../lib/runtimes/state'`. `ℹ fail 1` (the agent control tests still pass).

- [ ] **Step 3: Implement**

Create `lib/runtimes/state.js`:

```js
// What each local model runtime (lib/runtimes/registry.js) is doing now: whether it is installed, its server process
// (pid, start time, children) and how that server runs, and whether its health URL answers within 1.5 s. Read from the
// process table (lib/processes), the servers ZAAFPulse started (.data/runtimes/started.json), launchd's job list on
// macOS and /proc/<pid>/cgroup on Linux. A process whose parent (or an ancestor a few levels up) is a runtime's
// server counts toward that server and is never a server itself: Ollama's runners and its llama-server.
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const realProcesses = require('../processes');
const { sameStart, startOf } = require('../agents/control');

const HEALTH_TIMEOUT_MS = 1500;
const MAX_DEPTH = 4; // how far up the parent chain a server is looked for
const LAUNCHCTL_TIMEOUT_MS = 3000;

// A small JSON object kept in a file of its own (mode 0600), written through a temp file and a rename.
function jsonFile(file) {
  return {
    file,
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      } catch {
        return {};
      }
    },
    write(obj) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

// Whether `url` answers within `timeoutMs`. An answer below 500 counts (a 503 means "not ready yet").
function probe(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(v);
    }
    try {
      req = http.get(url, (res) => {
        res.resume();
        finish(res.statusCode < 500);
      });
    } catch {
      return finish(false);
    }
    req.on('error', () => finish(false));
  });
}

// `launchctl list`: "PID<TAB>Status<TAB>Label" per job; a job that is not running has "-" for its pid.
function parseLaunchctlList(out) {
  const jobs = new Map();
  for (const line of String(out).split('\n')) {
    const f = line.split('\t');
    if (f.length >= 3 && /^\d+$/.test(f[0])) jobs.set(f[2].trim(), Number(f[0]));
  }
  return jobs;
}
const listLaunchd = () =>
  new Promise((resolve) =>
    execFile('launchctl', ['list'], { timeout: LAUNCHCTL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? new Map() : parseLaunchctlList(stdout)),
    ),
  );

// Linux: the systemd system unit a process runs under ("ollama.service"), or null. User units are not "the system".
function systemUnit(cgroup) {
  const m = /(?:^|\n)[^\n]*:\/system\.slice\/([^/\n]+\.service)(?:\/|\n|$)/.exec(String(cgroup || ''));
  return m ? m[1] : null;
}

const isFile = (f, win) => {
  try {
    if (!fs.statSync(f).isFile()) return false;
    if (!win) fs.accessSync(f, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const isDir = (f) => {
  try {
    return fs.statSync(f).isDirectory();
  } catch {
    return false;
  }
};
const defaultBinDirs = (platform, home) =>
  platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.lmstudio', 'bin'), path.join(home, '.local', 'bin')];

// A program as it would be run: an absolute path as given (when it is an executable file), else the first match on
// PATH and then the usual folders. A relative path is never looked up: it would depend on the server's own folder.
function findBin(name, { env = process.env, platform = process.platform, home = os.homedir(), dirs } = {}) {
  if (typeof name !== 'string' || !name) return null;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  if (p.isAbsolute(name)) return isFile(name, win) ? name : null;
  if (/[\\/]/.test(name)) return null;
  const all = [
    ...String(env.PATH || env.Path || '').split(win ? ';' : ':'),
    ...(dirs || defaultBinDirs(platform, home)),
  ].filter((d) => d && p.isAbsolute(d));
  const names = win && !/\.exe$/i.test(name) ? [`${name}.exe`] : [name];
  for (const d of all) for (const n of names) if (isFile(p.join(d, n), win)) return p.join(d, n);
  return null;
}

function createRuntimeState({
  processes = realProcesses,
  entries = () => [], // the runtimes, from lib/runtimes/registry.js entries()
  started = { read: () => ({}) }, // .data/runtimes/started.json: { [id]: { pid, startTime } }
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  binDirs, // the usual folders after PATH (default: Homebrew, /usr/local/bin, /usr/bin, ~/.lmstudio/bin, ~/.local/bin)
  appDirs = platform === 'darwin' ? ['/Applications', path.join(home, 'Applications')] : [],
  brewPrefixes = platform === 'darwin' ? ['/opt/homebrew', '/usr/local'] : [],
  launchctl = listLaunchd, // () => Promise<Map label -> pid>
  readCgroup = (pid) => fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'),
  probe: probeUrl = probe,
  now = Date.now,
} = {}) {
  // pid -> the first start time read for it, as agent control keeps it: ps gives an age in whole seconds.
  let starts = new Map();
  const bin = (name) => findBin(name, { env, platform, home, dirs: binDirs });
  const app = (bundle) => (bundle ? appDirs.map((d) => path.join(d, bundle)).find(isDir) || null : null);
  const brewed = (formula) => !!formula && brewPrefixes.some((p) => isDir(path.join(p, 'opt', formula)));
  const brewBin = () => brewPrefixes.map((p) => path.join(p, 'bin', 'brew')).find((f) => isFile(f, false)) || null;

  // Where a runtime is on this machine, and the argv that starts and (when it has one) stops it.
  function install(e) {
    if (!e.preset) {
      const b = e.error ? null : bin(e.command[0]);
      return { installed: !!b, bin: b, app: null, startArgv: b ? [b, ...e.command.slice(1)] : null, stopArgv: null };
    }
    const b = e.bin ? bin(e.bin) : null;
    const a = platform === 'darwin' ? app(e.app) : null;
    const installed = !!(b || a || brewed(e.brew));
    let startArgv = null;
    if (b && e.start && e.start[0] === e.bin) startArgv = [b, ...e.start.slice(1)];
    else if (a && e.openApp) startArgv = ['/usr/bin/open', '-a', a];
    const stopArgv = b && e.stop && e.stop[0] === e.bin ? [b, ...e.stop.slice(1)] : null;
    return { installed, bin: b, app: a, startArgv, stopArgv };
  }

  async function table() {
    const t = now();
    const next = new Map();
    const rows = (await processes.rows()).map((r) => {
      let startTime = startOf(r, t);
      const known = starts.get(r.pid);
      if (sameStart(known, startTime)) startTime = known;
      if (startTime != null) next.set(r.pid, startTime);
      return { ...r, startTime };
    });
    starts = next;
    return rows;
  }

  // Every runtime with its server, or only the one with id `only` (the others are still read: a process is a server
  // or a child depending on the processes around it).
  async function list({ only } = {}) {
    const all = entries();
    // Owner entries first: their match is narrower than a preset's (a llama-server on their port).
    const order = [...all.filter((e) => !e.preset && !e.error), ...all.filter((e) => e.preset)];
    let rows = [];
    let tableError = null;
    try {
      rows = await table();
    } catch {
      tableError = 'the process table could not be read';
    }
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const runtimeOf = new Map(); // pid -> entry, for the rows that match a runtime
    for (const r of rows) {
      if (realProcesses.isOwn(r)) continue;
      const e = order.find((x) => x.match(r));
      if (e) runtimeOf.set(r.pid, e);
    }
    // The topmost matching process at most MAX_DEPTH parents up, other than the row itself; null when none.
    const serverAbove = (r) => {
      let found = null;
      let cur = r;
      for (let i = 0; i < MAX_DEPTH; i++) {
        const p = byPid.get(cur.ppid);
        if (!p || p.pid === cur.pid) break;
        if (runtimeOf.has(p.pid)) found = p;
        cur = p;
      }
      return found;
    };
    const servers = new Map(); // entry id -> [server rows], oldest first
    const children = new Map(); // server pid -> how many processes run under it
    for (const r of rows) {
      const above = serverAbove(r);
      if (above) children.set(above.pid, (children.get(above.pid) || 0) + 1);
      else if (runtimeOf.has(r.pid)) {
        const id = runtimeOf.get(r.pid).id;
        servers.set(id, [...(servers.get(id) || []), r]);
      }
    }
    for (const xs of servers.values()) xs.sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity));
    const mine = started.read();
    let jobs = null; // launchd's jobs, read once and only when a server could be a brew service
    const out = [];
    for (const e of all) {
      if (only !== undefined && e.id !== only) continue;
      const found = e.error ? [] : servers.get(e.id) || [];
      const rec = mine[e.id];
      const ours = (r) => !!rec && r.pid === rec.pid && sameStart(rec.startTime, r.startTime);
      const srv = found.find(ours) || found[0] || null;
      let how = null;
      if (srv) {
        const parent = byPid.get(srv.ppid) || null;
        const bundle = e.app ? `/${e.app}/Contents/MacOS/` : null;
        if (ours(srv)) how = 'zaafpulse';
        else if (bundle && [srv, parent].some((x) => x && String(x.args).includes(bundle))) how = 'app';
        else if (platform === 'darwin' && e.brew && srv.ppid === 1) {
          if (!jobs) jobs = await launchctl();
          if (jobs.get(`homebrew.mxcl.${e.brew}`) === srv.pid) how = 'service';
        } else if (platform === 'linux') {
          let cg = '';
          try {
            cg = readCgroup(srv.pid);
          } catch {
            cg = '';
          }
          if (systemUnit(cg)) how = 'system';
        }
      }
      out.push({ e, srv, how: srv ? how || 'process' : null, where: install(e) });
    }
    // The health URLs are asked at the same time, each for at most 1.5 s.
    return Promise.all(
      out.map(async ({ e, srv, how, where }) => {
        const answered = e.health && !e.error && (srv || where.installed) ? await probeUrl(e.health) : false;
        const running = e.upByHealth ? answered : !!srv;
        return {
          entry: e,
          ...where,
          brewBin: how === 'service' ? brewBin() : null,
          running,
          healthy: running && answered,
          how: running ? how || 'process' : null,
          pid: running && srv ? srv.pid : null,
          startTime: running && srv ? srv.startTime : null,
          children: running && srv ? children.get(srv.pid) || 0 : 0,
          tableError,
        };
      }),
    );
  }

  const one = async (id) => {
    const xs = await list({ only: id });
    return xs.find((x) => !x.entry.error) || xs[0] || null;
  };

  return { list, one, install };
}

module.exports = {
  createRuntimeState,
  jsonFile,
  probe,
  findBin,
  parseLaunchctlList,
  systemUnit,
  HEALTH_TIMEOUT_MS,
};
```

In `lib/agents/control.js`, replace:

```js
const sameProcess = (a, b) => !!a && !!b && a.pid === b.pid && sameStart(a.startTime, b.startTime);
```

with:

```js
const sameProcess = (a, b) => !!a && !!b && a.pid === b.pid && sameStart(a.startTime, b.startTime);
// A row's start time (ms, whole seconds) from its age at `t`; null when the table gave no age.
const startOf = (row, t) => (Number.isFinite(row.upSec) ? Math.round((t - row.upSec * 1000) / 1000) * 1000 : null);
```

In `lib/agents/control.js`, replace:

```js
      let startTime = Number.isFinite(r.upSec) ? Math.round((t - r.upSec * 1000) / 1000) * 1000 : null;
```

with:

```js
      let startTime = startOf(r, t);
```

In `lib/agents/control.js`, replace:

```js
module.exports = { createAgentControl, detectDocker, sameProcess, isAgentBinary, GRACE_MS, SAME_START_MS };
```

with:

```js
module.exports = {
  createAgentControl,
  detectDocker,
  sameProcess,
  sameStart,
  startOf,
  isAgentBinary,
  GRACE_MS,
  SAME_START_MS,
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/runtimes-state.test.js test/agents-control.test.js`

Expected: PASS (`ℹ fail 0`).

Run: `npm test`

Expected: PASS (`ℹ fail 0`).

- [ ] **Step 5: Commit**

```bash
git add lib/runtimes/state.js lib/agents/control.js test/runtimes-state.test.js
git commit -m "Read which local model servers run, and how"
```

---

### Task 4: Start and Stop

**Goal:** the actions. Start refuses (each refusal audited) when control is off (403), the runtime is unknown (404), the entry is invalid (409), not installed (409), already running (409), an owner entry is not approved (403), or there is no start command (409, llama.cpp: "add it in Settings → Local models with a model path"). It opens `.data/runtimes/<id>.log` (rotated past 5 MB, mode 0600), spawns `startArgv` detached with `stdio: ['ignore', log, log]`, `cwd: dataDir`, `shell: false`, waits for the `spawn` or `error` event (502 "the command could not start"), unrefs it, records `{ pid, startTime }` in `started.json`, and polls the health URL every 500 ms for up to 30 s of real time. A command that exits non-zero before answering is a 502 with the log lines; a launcher that exits 0 (`lms`, `open`) is not. Stop refuses a bad target (400), unknown (404), not running (409 "already stopped"), a changed pid or start time (409 "the process changed; refresh") and a systemd system unit (409). It then uses, in order: the runtime's own stop command, `osascript -e 'quit app "<App>"'` for `app` on macOS, `brew services stop <formula>` for `service`, `taskkill /PID n` on Windows, else `SIGINT`, a 5 s grace, and `SIGTERM` only if the table still shows the same process. It waits up to 10 s in all for the server to go (for LM Studio: for its health URL to stop answering). `PATHLIKE` is exported from `lib/monitors/api.js` so log lines and messages are scrubbed the same way as the monitor routes; `maskSecrets` comes from `lib/trace/model.js`.

**Files**

- Create: `lib/runtimes/control.js`
- Modify: `lib/monitors/api.js` (the exact existing text to replace is quoted in Step 3)
- Test: `test/runtimes-control.test.js` (new)

**Interfaces**

- Consumes: `state.list()`, `state.one(id)` (Task 3); `entries()`, `commandHash` (Task 2); `jsonFile`, `probe` (Task 3); `detectDocker`, `sameProcess`, `sameStart`, `GRACE_MS` from `lib/agents/control.js`; `createAudit` from `lib/audit.js`; `PATHLIKE` from `lib/monitors/api.js` (exported here); `maskSecrets` from `lib/trace/model.js`.
- Produces: `createRuntimeControl(...)` with `{ list, start, stop, approve, forget, approved, offReason, logTail }`, `cleanLine`, `OFF_TEXT`, `HEALTH_WAIT_MS`, `STOP_WAIT_MS`, `POLL_MS`, as in Shared interfaces.

The tests start a real fake runtime: a small Node script written to a temp folder (a path under the repository would be taken for ZAAFPulse's own process by `isOwn`) that answers its health URL, prints a path and an API key to its log, and exits on `SIGINT`. Its process table is the children the test spawned, so no other process on the machine is ever read or signalled. The stop cases use a fake state and a `kill` that records every call.

- [ ] **Step 1: Write the failing test**

Create `test/runtimes-control.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn: realSpawn } = require('child_process');
const { entries, commandHash } = require('../lib/runtimes/registry');
const { createRuntimeState, jsonFile } = require('../lib/runtimes/state');
const { createRuntimeControl } = require('../lib/runtimes/control');

const POSIX = process.platform !== 'win32';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// The fake runtime lives in a temp folder: a path under the repository would read as ZAAFPulse's own process.
const FAKE_SRC = `const http = require('http');
const [port, mode] = process.argv.slice(2);
console.log('loading model from /Users/someone/models/qwen.gguf');
console.log('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456');
if (mode === '--fail') { console.error('error: address already in use'); process.exit(3); }
const server = http.createServer((req, res) => {
  if (mode === '--silent') return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"version":"0.0.0"}');
});
server.listen(Number(port), '127.0.0.1');
process.on('SIGINT', () => { server.close(); process.exit(0); });
setTimeout(() => process.exit(0), 60000); // never outlives a failed test by long
`;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const recorder = () => {
  const lines = [];
  return { lines, record: (e) => lines.push(e) };
};
const rejects = (p, status, re) =>
  assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)) && !/[\\/]Users[\\/]/.test(e.message));

// A real start against the fake runtime: the process table is the children this test spawned.
async function realSetup({ mode, approve = true, healthWaitMs = 10000, extra = {} } = {}) {
  const dir = tmp('zp-rt-ctl-');
  const fake = path.join(dir, 'fake-runtime.js');
  fs.writeFileSync(fake, FAKE_SRC);
  const port = await freePort();
  const config = [
    { id: 'fake-rt', name: 'Fake runtime', command: [process.execPath, fake, String(port), ...(mode ? [mode] : [])], port },
  ];
  const dataDir = path.join(dir, '.data');
  const started = jsonFile(path.join(dataDir, 'runtimes', 'started.json'));
  const approvals = jsonFile(path.join(dataDir, 'runtimes', 'approved.json'));
  if (approve) approvals.write({ 'fake-rt': commandHash(config[0]) });
  const spawned = [];
  const spawn = (...a) => {
    const c = realSpawn(...a);
    c.spawnedAt = Date.now();
    spawned.push(c);
    return c;
  };
  const table = {
    rows: async () =>
      spawned
        .filter((c) => c.pid && c.exitCode === null && c.signalCode === null)
        .map((c) => ({
          pid: c.pid,
          ppid: process.pid,
          cpu: 0,
          rssKB: 0,
          upSec: Math.round((Date.now() - c.spawnedAt) / 1000),
          args: c.spawnargs.join(' '),
        })),
  };
  // Nothing from this machine: no PATH, no app or Homebrew folders, so only the fake runtime is installed.
  const state = createRuntimeState({
    processes: table,
    entries: () => entries(config),
    started,
    env: { PATH: '' },
    binDirs: [],
    appDirs: [],
    brewPrefixes: [],
    platform: 'linux',
    readCgroup: () => '',
  });
  const audit = recorder();
  const ctl = createRuntimeControl({
    state,
    entries: () => entries(config),
    dataDir,
    started,
    approvals,
    audit,
    spawn,
    inDocker: false,
    healthWaitMs,
    pollMs: 50,
    graceMs: 2000,
    stopWaitMs: 5000,
    ...extra,
  });
  const cleanup = () => {
    for (const c of spawned) {
      try {
        process.kill(c.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ctl, state, started, approvals, audit, spawned, dataDir, port, config, cleanup };
}

test('start detaches the server, records it, waits for health; stop sends SIGINT and it exits', async (t) => {
  const s = await realSetup();
  t.after(s.cleanup);
  const r = await s.ctl.start('fake-rt');
  assert.deepEqual(r, { state: 'running' });
  const child = s.spawned[0];
  assert.equal(child.spawnargs[0], process.execPath);
  const rec = s.started.read()['fake-rt'];
  assert.equal(rec.pid, child.pid);
  const log = path.join(s.dataDir, 'runtimes', 'fake-rt.log');
  assert.ok(fs.existsSync(log));
  if (POSIX) assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  const [row] = await s.ctl.list();
  assert.equal(row.id, 'fake-rt');
  assert.equal(row.running, true);
  assert.equal(row.healthy, true);
  assert.equal(row.how, 'zaafpulse');
  assert.equal(row.canStop, true);
  assert.equal(row.canStart, false);
  await rejects(s.ctl.start('fake-rt'), 409, /already running/);
  assert.deepEqual(
    s.audit.lines.map((l) => [l.kind, l.action, l.id, l.ok]),
    [
      ['runtime', 'start', 'fake-rt', true],
      ['runtime', 'start', 'fake-rt', false],
    ],
  );
  if (!POSIX) return; // Windows stops with taskkill, covered with a fake below
  const stopped = await s.ctl.stop({ id: 'fake-rt', pid: row.pid, startTime: row.startTime });
  assert.deepEqual(stopped, { state: 'stopped' });
  assert.deepEqual(s.started.read(), {});
  const stopLine = s.audit.lines.find((l) => l.action === 'stop');
  assert.equal(stopLine.signal, 'SIGINT');
  assert.equal(stopLine.how, 'zaafpulse');
});

test('the spawn: no shell, detached, stdin ignored, output to the log, the data folder as working folder', async (t) => {
  const calls = [];
  const s = await realSetup({
    extra: {
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        const c = new EventEmitter();
        c.pid = 4321;
        c.unref = () => {};
        process.nextTick(() => c.emit('spawn'));
        return c;
      },
      probe: async () => true,
    },
  });
  t.after(s.cleanup);
  assert.deepEqual(await s.ctl.start('fake-rt'), { state: 'running' });
  const [{ cmd, args, opts }] = calls;
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, s.config[0].command.slice(1));
  assert.equal(opts.shell, false);
  assert.equal(opts.detached, true);
  assert.equal(opts.cwd, s.dataDir);
  assert.equal(opts.stdio[0], 'ignore');
  assert.equal(typeof opts.stdio[1], 'number');
  assert.equal(opts.stdio[1], opts.stdio[2]);
});

test('a start that never answers reports starting, with the log masked and without paths', async (t) => {
  const s = await realSetup({ mode: '--silent', healthWaitMs: 400 });
  t.after(s.cleanup);
  const r = await s.ctl.start('fake-rt');
  assert.equal(r.state, 'starting');
  assert.equal(r.note, 'started, not answering yet');
  const text = r.log.join('\n');
  assert.match(text, /loading model from \[path\]/);
  assert.match(text, /OpenAI API key hidden/);
  assert.doesNotMatch(text, /sk-proj-|\/Users\/someone/);
});

test('a command that exits with an error is a 502 with the masked log', async (t) => {
  const s = await realSetup({ mode: '--fail' });
  t.after(s.cleanup);
  await assert.rejects(s.ctl.start('fake-rt'), (e) => {
    assert.equal(e.status, 502);
    assert.equal(e.message, 'the command exited with code 3');
    assert.ok(e.log.some((l) => /address already in use/.test(l)));
    assert.ok(!e.log.join('\n').includes('/Users/someone'));
    return true;
  });
  assert.equal(s.audit.lines.at(-1).status, 502);
});

test('a command that cannot be spawned is a 502', async (t) => {
  const s = await realSetup({
    extra: {
      spawn: () => {
        const c = new EventEmitter();
        process.nextTick(() => c.emit('error', Object.assign(new Error('spawn /x ENOENT'), { code: 'ENOENT' })));
        return c;
      },
    },
  });
  t.after(s.cleanup);
  await rejects(s.ctl.start('fake-rt'), 502, /^the command could not start$/);
  assert.deepEqual(s.started.read(), {});
});

test('refusals: unknown, unapproved, server mode, Docker, not installed; each is audited', async (t) => {
  const s = await realSetup({ approve: false });
  t.after(s.cleanup);
  await rejects(s.ctl.start('nope'), 404, /unknown runtime/);
  await rejects(s.ctl.start('fake-rt'), 403, /approve it in Settings first/);
  const [row] = await s.ctl.list();
  assert.equal(row.approved, false);
  assert.equal(row.canStart, false);
  assert.equal(row.reason, 'approve it in Settings first');
  // Approving stores a hash of the command; a changed command asks again.
  assert.deepEqual(await s.ctl.approve('fake-rt'), { approved: true });
  assert.equal(s.approvals.read()['fake-rt'], commandHash(s.config[0]));
  assert.equal((await s.ctl.list())[0].canStart, true);
  s.config[0].command = [...s.config[0].command, '--verbose'];
  assert.equal((await s.ctl.list())[0].approved, false);
  await rejects(s.ctl.approve('ollama'), 400, /preset/);
  await rejects(s.ctl.approve('nope'), 404);
  s.ctl.forget('fake-rt');
  assert.deepEqual(s.approvals.read(), {});
  const server = await realSetup({ extra: { serverMode: true } });
  t.after(server.cleanup);
  await rejects(server.ctl.start('fake-rt'), 403, /off on this server/);
  await rejects(server.ctl.stop({ id: 'fake-rt', pid: 4242, startTime: 1 }), 403, /off on this server/);
  await rejects(server.ctl.approve('fake-rt'), 403);
  const off = (await server.ctl.list())[0];
  assert.equal(off.canStart, false);
  assert.equal(off.reason, 'runtime control is off on this server');
  const docker = await realSetup({ extra: { inDocker: true } });
  t.after(docker.cleanup);
  await rejects(docker.ctl.start('fake-rt'), 403, /off in Docker/);
  const missing = await realSetup();
  t.after(missing.cleanup);
  missing.config[0].command = [path.join(os.tmpdir(), 'zp-no-such-runtime'), '--port', String(missing.port)];
  missing.approvals.write({ 'fake-rt': commandHash(missing.config[0]) });
  await rejects(missing.ctl.start('fake-rt'), 409, /not installed/);
  for (const a of [s, server, docker, missing])
    for (const l of a.audit.lines) {
      assert.equal(l.kind, 'runtime');
      assert.equal(l.by, 'owner');
    }
  assert.ok(s.audit.lines.filter((l) => l.ok === false).length >= 4);
});

// ---- stop, with a fake state and a kill that records every call ----
function fakeKill({ exitOn = null, gone = new Set() } = {}) {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (gone.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    if (signal === exitOn) gone.add(pid);
    return true;
  };
  return { calls, kill, sent: () => calls.filter(([, s]) => s !== 0).map(([, s]) => s) };
}
const OLLAMA = entries([]).find((e) => e.id === 'ollama');
const LMSTUDIO = entries([]).find((e) => e.id === 'lmstudio');
const SRV = { pid: 5150, startTime: 1_790_000_000_000 };
const item = (over = {}) => ({
  entry: OLLAMA,
  installed: true,
  bin: '/opt/homebrew/bin/ollama',
  app: null,
  startArgv: ['/opt/homebrew/bin/ollama', 'serve'],
  stopArgv: null,
  brewBin: null,
  running: true,
  healthy: true,
  how: 'process',
  ...SRV,
  children: 1,
  tableError: null,
  ...over,
});
function stopSetup({ x = item(), killer = fakeKill(), platform = 'darwin', probe = async () => false, runCode = 0 } = {}) {
  const ran = [];
  const audit = recorder();
  const dir = tmp('zp-rt-stop-');
  const ctl = createRuntimeControl({
    state: { one: async () => x, list: async () => [x] },
    entries: () => entries([]),
    dataDir: dir,
    audit,
    kill: killer.kill,
    spawn: (cmd, args) => {
      ran.push([cmd, ...args]);
      const c = new EventEmitter();
      process.nextTick(() => c.emit('close', runCode));
      return c;
    },
    probe,
    platform,
    inDocker: false,
    graceMs: 40,
    stopWaitMs: 120,
    pollMs: 5,
  });
  return { ctl, ran, audit, killer, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('stop: SIGINT, then SIGTERM after the grace when the same process is still there; never SIGKILL', async (t) => {
  const s = stopSetup();
  t.after(s.cleanup);
  const r = await s.ctl.stop({ id: 'ollama', ...SRV });
  assert.deepEqual(r, { state: 'stopping', note: 'still shutting down' }, 'the fake process never exits');
  assert.deepEqual(s.killer.sent(), ['SIGINT', 'SIGTERM']);
  assert.ok(!s.killer.calls.some(([, sig]) => sig === 'SIGKILL'));
  assert.deepEqual(
    s.audit.lines.map((l) => [l.action, l.ok, l.signal]),
    [
      ['stop', true, 'SIGINT'],
      ['stop', true, 'SIGTERM'],
    ],
  );
  const quick = stopSetup({ killer: fakeKill({ exitOn: 'SIGINT' }) });
  t.after(quick.cleanup);
  assert.deepEqual(await quick.ctl.stop({ id: 'ollama', ...SRV }), { state: 'stopped' });
  assert.deepEqual(quick.killer.sent(), ['SIGINT']);
});

test('stop: a changed pid or start time, a stopped server, a system unit and a bad target are refused', async (t) => {
  const s = stopSetup();
  t.after(s.cleanup);
  await rejects(s.ctl.stop({ id: 'ollama', pid: SRV.pid + 1, startTime: SRV.startTime }), 409, /the process changed; refresh/);
  await rejects(s.ctl.stop({ id: 'ollama', pid: SRV.pid, startTime: SRV.startTime + 5000 }), 409, /process changed/);
  await rejects(s.ctl.stop({ id: 'ollama', pid: 1, startTime: SRV.startTime }), 400);
  await rejects(s.ctl.stop({ id: 'ollama', pid: SRV.pid }), 400);
  assert.deepEqual(s.killer.sent(), []);
  const idle = stopSetup({ x: item({ running: false, pid: null, startTime: null, how: null }) });
  t.after(idle.cleanup);
  await rejects(idle.ctl.stop({ id: 'ollama', ...SRV }), 409, /already stopped/);
  const sys = stopSetup({ x: item({ how: 'system' }) });
  t.after(sys.cleanup);
  await rejects(sys.ctl.stop({ id: 'ollama', ...SRV }), 409, /managed by the system/);
  const none = stopSetup({ x: null });
  t.after(none.cleanup);
  await rejects(none.ctl.stop({ id: 'nope', ...SRV }), 404);
  assert.ok(s.audit.lines.every((l) => l.ok === false && l.kind === 'runtime'));
});

test('stop follows how the server runs: own stop command, quit the app, brew services, taskkill', async (t) => {
  const lms = stopSetup({
    x: item({ entry: LMSTUDIO, how: 'app', stopArgv: ['/Users/u/.lmstudio/bin/lms', 'server', 'stop'] }),
  });
  t.after(lms.cleanup);
  assert.deepEqual(await lms.ctl.stop({ id: 'lmstudio', ...SRV }), { state: 'stopped' }, 'the health URL went quiet');
  assert.deepEqual(lms.ran, [['/Users/u/.lmstudio/bin/lms', 'server', 'stop']]);
  const app = stopSetup({ x: item({ how: 'app' }), killer: fakeKill({ gone: new Set([SRV.pid]) }) });
  t.after(app.cleanup);
  assert.deepEqual(await app.ctl.stop({ id: 'ollama', ...SRV }), { state: 'stopped' });
  assert.deepEqual(app.ran, [['/usr/bin/osascript', '-e', 'quit app "Ollama"']]);
  const svc = stopSetup({ x: item({ how: 'service', brewBin: '/opt/homebrew/bin/brew' }), killer: fakeKill({ gone: new Set([SRV.pid]) }) });
  t.after(svc.cleanup);
  await svc.ctl.stop({ id: 'ollama', ...SRV });
  assert.deepEqual(svc.ran, [['/opt/homebrew/bin/brew', 'services', 'stop', 'ollama']]);
  const winOk = stopSetup({ platform: 'win32', killer: fakeKill({ gone: new Set([SRV.pid]) }) });
  t.after(winOk.cleanup);
  await winOk.ctl.stop({ id: 'ollama', ...SRV });
  assert.deepEqual(winOk.ran, [['taskkill', '/PID', String(SRV.pid)]], 'no /F');
  const winBad = stopSetup({ platform: 'win32', runCode: 128 });
  t.after(winBad.cleanup);
  await rejects(winBad.ctl.stop({ id: 'ollama', ...SRV }), 502, /taskkill/);
  for (const s of [lms, app, svc, winOk]) assert.deepEqual(s.killer.sent(), [], 'no signal when a command stops it');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/runtimes-control.test.js test/monitors-api.test.js`

Expected: FAIL. `Error: Cannot find module '../lib/runtimes/control'`. `ℹ fail 1` (the monitor API tests still pass).

- [ ] **Step 3: Implement**

Create `lib/runtimes/control.js`:

```js
// Start and stop the local model servers (lib/runtimes/registry.js). The dashboard sends only an id, and to stop also
// the pid and start time it was shown; every command comes from a preset or from an owner entry in config.json that
// the owner approved, and runs without a shell. A started server is detached (its own session, output to
// .data/runtimes/<id>.log), so it outlives a ZAAFPulse restart. Stop follows how the server runs: the runtime's own
// stop command, quitting its app, `brew services stop`, or SIGINT and then SIGTERM after 5 s (taskkill without /F on
// Windows); SIGKILL is never sent. Control is off in server mode and in Docker, and every action, refused or not, is
// written to agent-audit.jsonl with kind 'runtime'. A refusal rejects with an Error carrying `status` (400, 403, 404,
// 409 or 502) and a message that names no path; a failed start also carries the masked log lines (`log`).
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { createAudit } = require('../audit');
const { detectDocker, sameProcess, sameStart, GRACE_MS } = require('../agents/control');
const { PATHLIKE } = require('../monitors/api');
const { maskSecrets } = require('../trace/model');
const { commandHash } = require('./registry');
const { jsonFile, probe: realProbe } = require('./state');

const HEALTH_WAIT_MS = 30000;
const STOP_WAIT_MS = 10000;
const POLL_MS = 500;
const COMMAND_TIMEOUT_MS = 15000;
const MAX_LOG = 5 * 1024 * 1024; // a log is rotated at this size when its server starts; one previous file is kept
const LOG_LINES = 20;
const LOG_READ = 64 * 1024; // how much of the end of a log is read for its last lines
const OFF_TEXT = { server: 'runtime control is off on this server', docker: 'runtime control is off in Docker' };
const MANAGED = 'managed by the system; stop it with systemctl';
const NEEDS_ENTRY = 'add it in Settings → Local models with a model path';

const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flag = (v) => (typeof v === 'function' ? !!v() : !!v);
// One log line as the dashboard may show it: secrets masked, paths out, no control characters, clipped.
const cleanLine = (line) =>
  maskSecrets(String(line))
    .replace(PATHLIKE, '[path]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trimEnd()
    .slice(0, 300);

function createRuntimeControl({
  state, // lib/runtimes/state.js createRuntimeState()
  entries = () => [], // the runtimes, from lib/runtimes/registry.js entries()
  dataDir, // .data: the started servers' working folder; runtimes/ and agent-audit.jsonl live in it
  started, // jsonFile of .data/runtimes/started.json
  approvals, // jsonFile of .data/runtimes/approved.json: { [id]: commandHash }
  audit,
  spawn = childProcess.spawn,
  kill = (pid, signal) => process.kill(pid, signal),
  probe = realProbe,
  platform = process.platform,
  now = Date.now,
  serverMode = false,
  inDocker,
  graceMs = GRACE_MS,
  stopWaitMs = STOP_WAIT_MS,
  healthWaitMs = HEALTH_WAIT_MS,
  pollMs = POLL_MS,
  log = () => {},
} = {}) {
  const dir = path.join(dataDir || '.', 'runtimes');
  const startedFile = started || jsonFile(path.join(dir, 'started.json'));
  const approvedFile = approvals || jsonFile(path.join(dir, 'approved.json'));
  const auditLog = audit || (dataDir ? createAudit(path.join(dataDir, 'agent-audit.jsonl')) : { record() {} });
  const win = platform === 'win32';
  let docker = inDocker;
  // Why control is off here ('server' or 'docker'), or null when it is on.
  const offReason = () => {
    if (flag(serverMode)) return 'server';
    if (docker === undefined) docker = detectDocker(); // read once, on first use
    return flag(docker) ? 'docker' : null;
  };

  // Calls `check` every pollMs until it says yes or `ms` of real time have passed. The limit is a real timer, never
  // `now`, so a fixed clock in a test cannot hang it, and a slow check (a health URL takes up to 1.5 s) counts.
  async function waitFor(check, ms) {
    let over = ms <= 0;
    const timer = setTimeout(() => {
      over = true;
    }, Math.max(0, ms));
    try {
      for (;;) {
        if (await check()) return true;
        if (over) return false;
        await sleepFor(pollMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // One audit line per action, refused or not: no path, no command, no log text.
  const record = (action, id, extra) =>
    auditLog.record({
      ts: now(),
      kind: 'runtime',
      action,
      id: typeof id === 'string' ? id.slice(0, 40) : null,
      by: 'owner',
      ...extra,
    });

  const approved = (e) => e.preset || (!e.error && approvedFile.read()[e.id] === commandHash(e));
  const logFile = (id) => path.join(dir, `${id}.log`);

  // The last lines of a runtime's log, masked; [] when there is none.
  function logTail(id) {
    let text = '';
    let fd;
    try {
      fd = fs.openSync(logFile(id), 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, LOG_READ);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } catch {
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-LOG_LINES)
      .map(cleanLine);
  }

  function openLog(id) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = logFile(id);
    try {
      if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.fchmodSync(fd, 0o600); // a log made by an older version keeps no wider mode
    } catch {
      /* not ours to change */
    }
    return fd;
  }

  // A fixed command (a stop command, osascript, brew, taskkill), no shell, output ignored.
  function run(argv) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), {
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
          timeout: COMMAND_TIMEOUT_MS,
        });
      } catch (err) {
        return resolve({ code: null, error: err.message });
      }
      child.on('error', (err) => resolve({ code: null, error: err.message }));
      child.on('close', (code) => resolve({ code }));
    });
  }

  // The runtime with this id, as the state reads it now (a valid entry wins over an invalid one with the same id).
  async function find(id) {
    if (typeof id !== 'string') return null;
    return state.one(id);
  }

  // A runtime as the dashboard lists it: what it is doing, and whether Start or Stop may be offered and why not.
  function view(x, off) {
    const e = x.entry;
    const ok = approved(e);
    let reason = null;
    if (off) reason = OFF_TEXT[off];
    else if (e.error) reason = e.error;
    else if (x.tableError) reason = x.tableError;
    else if (x.running) reason = x.how === 'system' ? MANAGED : x.pid ? null : 'the server process was not found';
    else if (!x.installed) reason = 'not installed';
    else if (!x.startArgv) reason = e.id === 'llamacpp' ? NEEDS_ENTRY : 'this runtime has no start command';
    else if (!ok) reason = 'approve it in Settings first';
    return {
      id: e.id,
      name: e.name,
      preset: e.preset,
      installed: x.installed,
      running: x.running,
      healthy: x.healthy,
      how: x.how,
      pid: x.pid,
      startTime: x.startTime,
      children: x.children,
      port: e.port,
      canStart: !reason && !x.running,
      canStop: !reason && x.running,
      reason,
      approved: ok,
      error: e.error,
    };
  }

  // Every runtime that is installed, running, or one of the owner's entries.
  async function list() {
    const off = offReason();
    return (await state.list()).filter((x) => x.installed || x.running || !x.entry.preset).map((x) => view(x, off));
  }

  async function start(id) {
    const refuse = (status, message, extra = {}) => {
      record('start', id, { ok: false, status, error: message });
      return fail(status, message, extra);
    };
    const off = offReason();
    if (off) throw refuse(403, OFF_TEXT[off]);
    const x = await find(id);
    if (!x) throw refuse(404, 'unknown runtime');
    const e = x.entry;
    if (e.error) throw refuse(409, `the entry is not valid: ${e.error}`);
    if (!x.installed) throw refuse(409, 'not installed');
    if (x.running) throw refuse(409, 'already running');
    if (!approved(e)) throw refuse(403, 'approve it in Settings first');
    if (!x.startArgv) throw refuse(409, e.id === 'llamacpp' ? NEEDS_ENTRY : 'this runtime has no start command');
    const argv = x.startArgv;
    let fd;
    try {
      fd = openLog(e.id);
    } catch (err) {
      log(`runtimes: cannot open the log of ${e.id}: ${err.message}`);
      throw refuse(502, 'the log file could not be opened');
    }
    let child = null;
    let spawnError = null;
    try {
      child = spawn(argv[0], argv.slice(1), {
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: dataDir,
        shell: false,
        windowsHide: true,
      });
      // ENOENT and the like come as an 'error' event instead of the 'spawn' one.
      spawnError = await new Promise((resolve) => {
        child.once('spawn', () => resolve(null));
        child.once('error', resolve);
      });
    } catch (err) {
      spawnError = err;
    } finally {
      fs.closeSync(fd); // the child has its own copy
    }
    if (spawnError) {
      log(`runtimes: ${e.id} could not start: ${spawnError.message}`);
      throw refuse(502, 'the command could not start', { log: logTail(e.id) });
    }
    const exit = { done: false, code: null };
    child.on('exit', (code) => Object.assign(exit, { done: true, code }));
    child.unref();
    const startTime = Math.round(now() / 1000) * 1000;
    const mine = startedFile.read();
    mine[e.id] = { pid: child.pid, startTime };
    try {
      startedFile.write(mine);
    } catch (err) {
      log(`runtimes: cannot record ${e.id}: ${err.message}`);
    }
    record('start', e.id, { ok: true, pid: child.pid, startTime });
    // The health URL, every 500 ms for up to 30 s. A launcher that exits 0 (lms, open) is not a failure.
    const failed = () => exit.done && exit.code !== 0;
    const up = await waitFor(async () => (await probe(e.health)) || failed(), healthWaitMs);
    if (up && failed() && !(await probe(e.health))) {
      const message = exit.code === null ? 'the command was stopped' : `the command exited with code ${exit.code}`;
      record('start', e.id, { ok: false, status: 502, error: message, pid: child.pid, startTime });
      throw fail(502, message, { log: logTail(e.id) });
    }
    if (up) return { state: 'running' };
    return { state: 'starting', note: 'started, not answering yet', log: logTail(e.id) };
  }

  const alive = (pid) => {
    try {
      kill(pid, 0);
      return true;
    } catch (err) {
      return !!(err && err.code === 'EPERM');
    }
  };

  async function stop(target) {
    const t = target && typeof target === 'object' ? target : {};
    const id = t.id;
    const pid = Number.isInteger(t.pid) ? t.pid : null;
    const startTime = Number.isFinite(t.startTime) ? t.startTime : null;
    const refuse = (status, message, extra = {}) => {
      record('stop', id, { ok: false, status, error: message, pid, startTime, ...extra });
      return fail(status, message);
    };
    const off = offReason();
    if (off) throw refuse(403, OFF_TEXT[off]);
    // pid 0, 1 and negative pids would signal a process group or init: never a target.
    if (!pid || pid <= 1 || startTime == null) throw refuse(400, 'a stop needs the pid and start time shown');
    const x = await find(id);
    if (!x) throw refuse(404, 'unknown runtime');
    const e = x.entry;
    if (!x.running || !x.pid) throw refuse(409, 'already stopped');
    if (!sameProcess({ pid: x.pid, startTime: x.startTime }, { pid, startTime }))
      throw refuse(409, 'the process changed; refresh');
    if (x.how === 'system') throw refuse(409, MANAGED);
    const how = x.how;
    // Gone: the health URL no longer answers (a server inside an app), or the process has exited.
    const gone = async () => (e.upByHealth ? !(await probe(e.health)) : !alive(pid));
    const done = (method, extra = {}) => record('stop', e.id, { ok: true, pid, startTime, how, method, ...extra });
    let waitFrom = 0; // ms of the stop wait already spent (the grace before SIGTERM counts)
    let method;
    let cmd = null;
    if (x.stopArgv) [method, cmd] = ['command', x.stopArgv];
    else if (how === 'app' && platform === 'darwin' && e.app)
      [method, cmd] = ['app', ['/usr/bin/osascript', '-e', `quit app "${e.app.replace(/\.app$/, '')}"`]];
    else if (how === 'service' && x.brewBin) [method, cmd] = ['service', [x.brewBin, 'services', 'stop', e.brew]];
    else if (win) [method, cmd] = ['taskkill', ['taskkill', '/PID', String(pid)]]; // no /F: the app is asked to close
    if (cmd) {
      const r = await run(cmd);
      if (r.code !== 0) {
        log(`runtimes: stopping ${e.id} failed (${r.error || `exit ${r.code}`})`);
        throw refuse(502, method === 'taskkill' ? 'taskkill could not stop the process' : 'the stop command failed', {
          how,
          method,
        });
      }
      done(method);
    } else {
      method = 'signal';
      try {
        kill(pid, 'SIGINT');
      } catch (err) {
        if (err && err.code === 'EPERM') throw refuse(403, 'not permitted to signal this process', { how });
        done(method, { signal: 'SIGINT', note: 'already gone' });
        return finish(e.id, true);
      }
      done(method, { signal: 'SIGINT' });
      if (await waitFor(() => !alive(pid), graceMs)) return finish(e.id, true);
      waitFrom = graceMs;
      // Still alive after the grace: SIGTERM, but only to the same process (the pid may have been reused).
      const y = await state.one(e.id);
      if (!y || y.tableError) return finish(e.id, false); // cannot tell: do not escalate, do not claim it exited
      if (y.pid !== pid || !sameStart(y.startTime, startTime)) return finish(e.id, true); // gone; the pid is another's
      try {
        kill(pid, 'SIGTERM');
        done(method, { signal: 'SIGTERM' });
      } catch {
        return finish(e.id, true); // gone in the gap
      }
    }
    return finish(e.id, await waitFor(gone, stopWaitMs - waitFrom));
  }

  function finish(id, stopped) {
    if (!stopped) return { state: 'stopping', note: 'still shutting down' };
    const mine = startedFile.read();
    if (mine[id]) {
      delete mine[id];
      try {
        startedFile.write(mine);
      } catch {
        /* the record is checked by pid and start time anyway */
      }
    }
    return { state: 'stopped' };
  }

  // The owner approves an entry's command as it is now (Settings → Local models).
  async function approve(id) {
    const refuse = (status, message) => {
      record('approve', id, { ok: false, status, error: message });
      return fail(status, message);
    };
    const off = offReason();
    if (off) throw refuse(403, OFF_TEXT[off]);
    const all = entries();
    const e = all.find((x) => x.id === id && !x.error) || all.find((x) => x.id === id);
    if (!e) throw refuse(404, 'unknown runtime');
    if (e.preset) throw refuse(400, 'a preset needs no approval');
    if (e.error) throw refuse(409, `the entry is not valid: ${e.error}`);
    const ok = approvedFile.read();
    ok[e.id] = commandHash(e);
    approvedFile.write(ok);
    record('approve', e.id, { ok: true });
    return { approved: true };
  }

  // An entry was deleted: its approval goes too, so an entry added later with the same id asks again.
  function forget(id) {
    const ok = approvedFile.read();
    if (Object.hasOwn(ok, id)) {
      delete ok[id];
      approvedFile.write(ok);
    }
  }

  return { list, start, stop, approve, forget, approved, offReason, logTail };
}

module.exports = { createRuntimeControl, cleanLine, OFF_TEXT, HEALTH_WAIT_MS, STOP_WAIT_MS, POLL_MS };
```

In `lib/monitors/api.js`, replace:

```js
module.exports = { createMonitorApi };
```

with:

```js
module.exports = { createMonitorApi, PATHLIKE };
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/runtimes-control.test.js test/monitors-api.test.js`

Expected: PASS (`ℹ fail 0`).

Run: `npm test`

Expected: PASS (`ℹ fail 0`).

- [ ] **Step 5: Commit**

```bash
git add lib/runtimes/control.js lib/monitors/api.js test/runtimes-control.test.js
git commit -m "Start and stop local model servers, audited, never with SIGKILL"
```

---

### Task 5: HTTP API

**Goal:** the routes, independent of `server.js`. `GET /api/runtimes` lists runtimes (field by field, text clipped, `reason` and `error` scrubbed). `POST /api/runtimes/start | stop | approve` take only `{ id }` (and `pid`, `startTime` to stop), reject unknown fields, and pass the control module's 400/403/404/409/502 through with a scrubbed message and scrubbed `log`; anything else is a 500 without detail. Settings needs to read and change the owner's entries, which the spec's table does not cover, so three routes are added: `GET /api/runtimes/config` (the entries with their command, home folder shown as `~`), `POST /api/runtimes/save` (`{ entry, was? }`: `~/` expanded back, validated with `ownerEntry`, an edit can rename, the old id's approval is forgotten) and `POST /api/runtimes/delete` (`{ id }`, its approval forgotten). Every POST needs `application/json` (415). In demo mode the answers come from the demo object and save/delete are refused with 409.

**Files**

- Create: `lib/runtimes/api.js`
- Test: `test/runtimes-api.test.js` (new)

**Interfaces**

- Consumes: `control.list/start/stop/approve/approved/forget` (Task 4); `ID_RE`, `ownerEntries`, `ownerEntry`, `storedEntry` (Task 2); `PATHLIKE` (Task 4); `demo` shaped as `runtimesDemo()` (Task 6).
- Produces: `createRuntimeApi({ control, config, demo, home }) -> { route(req) }`.

- [ ] **Step 1: Write the failing test**

Create `test/runtimes-api.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeApi } = require('../lib/runtimes/api');

const HOME = '/Users/someone';
const QWEN = {
  id: 'qwen-local',
  name: 'Qwen (llama.cpp)',
  command: ['llama-server', '-m', `${HOME}/models/qwen.gguf`, '--port', '8081'],
  port: 8081,
};
const ROW = {
  id: 'ollama',
  name: 'Ollama',
  preset: true,
  installed: true,
  running: true,
  healthy: true,
  how: 'service',
  pid: 4242,
  startTime: 1_790_000_000_000,
  children: 1,
  port: 11434,
  canStart: false,
  canStop: true,
  reason: null,
  approved: true,
  error: null,
};
const err = (status, message, extra) => Object.assign(new Error(message), { status }, extra);

function setup({ list = [ROW], stored = [QWEN], demo = null, act = {} } = {}) {
  const calls = [];
  const forgot = [];
  const approvedIds = new Set();
  const saved = { value: stored };
  const control = {
    list: async () => list,
    approved: (e) => approvedIds.has(e.id),
    forget: (id) => forgot.push(id),
  };
  for (const a of ['start', 'stop', 'approve'])
    control[a] = async (target) => {
      calls.push([a, target]);
      if (act[a]) return act[a](target);
      return a === 'approve' ? { approved: true } : { state: a === 'start' ? 'running' : 'stopped' };
    };
  const api = createRuntimeApi({
    control,
    config: { list: () => saved.value, save: (v) => (saved.value = v) },
    demo,
    home: HOME,
  });
  const call = (method, path, body, contentType = 'application/json') =>
    api.route({
      method,
      path,
      contentType,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
  return { api, call, calls, forgot, saved, approvedIds };
}
const noPath = (body) => assert.doesNotMatch(JSON.stringify(body), /\/Users\/|[A-Z]:\\\\/, JSON.stringify(body));

test('GET /api/runtimes lists the runtimes with the fields the page uses', async () => {
  const { call } = setup();
  const r = await call('GET', '/api/runtimes');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [ROW]);
  assert.equal((await setup().api.route({ method: 'GET', path: '/api/other' })), null, 'not ours');
  assert.equal((await call('GET', '/api/runtimes/nope')).status, 404);
  assert.equal((await call('POST', '/api/runtimes')).status, 405);
  assert.equal((await call('GET', '/api/runtimes/start')).status, 405);
});

test('POST needs JSON, a JSON object and only known fields', async () => {
  const { call, calls } = setup();
  assert.equal((await call('POST', '/api/runtimes/start', { id: 'ollama' }, 'text/plain')).status, 415);
  assert.equal((await call('POST', '/api/runtimes/start', 'id=ollama', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await call('POST', '/api/runtimes/start', '{bad')).status, 400);
  assert.equal((await call('POST', '/api/runtimes/start', '[1]')).status, 400);
  const extra = await call('POST', '/api/runtimes/start', { id: 'ollama', command: ['sh', '-c', 'x'] });
  assert.equal(extra.status, 400);
  assert.match(extra.body.error, /unknown field: command/);
  assert.equal((await call('POST', '/api/runtimes/start', { id: 'Ollama!' })).status, 400);
  assert.equal((await call('POST', '/api/runtimes/start', {})).status, 400);
  assert.deepEqual(calls, [], 'nothing reached the control module');
});

test('start, stop and approve pass the id (and the process) to the control module', async () => {
  const { call, calls } = setup();
  assert.deepEqual((await call('POST', '/api/runtimes/start', { id: 'ollama' })).body, { state: 'running' });
  const target = { id: 'ollama', pid: 4242, startTime: 1_790_000_000_000 };
  assert.deepEqual((await call('POST', '/api/runtimes/stop', target)).body, { state: 'stopped' });
  assert.deepEqual((await call('POST', '/api/runtimes/approve', { id: 'qwen-local' })).body, { approved: true });
  assert.deepEqual(calls, [
    ['start', 'ollama'],
    ['stop', target],
    ['approve', 'qwen-local'],
  ]);
  assert.equal((await call('POST', '/api/runtimes/stop', { ...target, pid: 1 })).status, 400);
  assert.equal((await call('POST', '/api/runtimes/stop', { ...target, pid: '4242' })).status, 400);
  assert.equal((await call('POST', '/api/runtimes/stop', { id: 'ollama', pid: 4242 })).status, 400);
});

test('refusals keep their status; messages and log lines carry no path; anything else is a 500', async () => {
  const cases = [
    [404, 'unknown runtime'],
    [409, 'not installed'],
    [409, 'the process changed; refresh'],
    [403, 'approve it in Settings first'],
    [403, 'runtime control is off on this server'],
    [400, 'a stop needs the pid and start time shown'],
  ];
  for (const [status, message] of cases) {
    const { call } = setup({ act: { start: () => Promise.reject(err(status, message)) } });
    const r = await call('POST', '/api/runtimes/start', { id: 'ollama' });
    assert.equal(r.status, status);
    assert.deepEqual(r.body, { error: message });
  }
  const failing = setup({
    act: {
      start: () =>
        Promise.reject(
          err(502, `cannot open ${HOME}/models/qwen.gguf`, { log: [`error loading ${HOME}/models/qwen.gguf`, 'C:\\Users\\u\\m.gguf'] }),
        ),
    },
  });
  const r = await failing.call('POST', '/api/runtimes/start', { id: 'ollama' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'cannot open [path]');
  assert.deepEqual(r.body.log, ['error loading [path]', '[path]']);
  noPath(r.body);
  const starting = setup({ act: { start: async () => ({ state: 'starting', note: 'started, not answering yet', log: [`${HOME}/x/y.gguf`] }) } });
  const s = await starting.call('POST', '/api/runtimes/start', { id: 'ollama' });
  assert.equal(s.status, 200);
  noPath(s.body);
  const odd = setup({ act: { stop: () => Promise.reject(new Error(`EACCES ${HOME}/.data`)) } });
  const o = await odd.call('POST', '/api/runtimes/stop', { id: 'ollama', pid: 4242, startTime: 1 });
  assert.equal(o.status, 500);
  assert.deepEqual(o.body, { error: 'the runtime could not be stopped' });
  const listed = setup({ list: [{ ...ROW, reason: `cannot read ${HOME}/x`, error: '/etc/passwd is bad' }] });
  noPath((await listed.call('GET', '/api/runtimes')).body);
});

test('Settings: the entries with ~ for the home folder; save expands it, checks the entry and keeps the others', async () => {
  const { call, saved, forgot, approvedIds } = setup();
  approvedIds.add('qwen-local');
  const r = await call('GET', '/api/runtimes/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entries, [
    {
      id: 'qwen-local',
      name: 'Qwen (llama.cpp)',
      command: ['llama-server', '-m', '~/models/qwen.gguf', '--port', '8081'],
      port: 8081,
      health: 'http://127.0.0.1:8081/',
      approved: true,
      error: null,
    },
  ]);
  noPath(r.body);
  const add = await call('POST', '/api/runtimes/save', {
    entry: { id: 'mistral', name: 'Mistral', command: ['llama-server', '-m', '~/m/mistral.gguf', '--port', '8082'], port: 8082 },
  });
  assert.equal(add.status, 200);
  assert.deepEqual(saved.value[1], {
    id: 'mistral',
    name: 'Mistral',
    command: ['llama-server', '-m', `${HOME}/m/mistral.gguf`, '--port', '8082'],
    port: 8082,
    health: 'http://127.0.0.1:8082/',
  });
  assert.equal(add.body.entries.length, 2);
  const dup = await call('POST', '/api/runtimes/save', { entry: { ...QWEN } });
  assert.equal(dup.status, 409);
  const bad = await call('POST', '/api/runtimes/save', { entry: { ...QWEN, id: 'new-one', port: 0 } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /port/);
  const preset = await call('POST', '/api/runtimes/save', { entry: { ...QWEN, id: 'ollama' } });
  assert.equal(preset.status, 400);
  const extra = await call('POST', '/api/runtimes/save', { entry: { ...QWEN, id: 'x2', shell: true } });
  assert.equal(extra.status, 400);
  // Edit: renaming moves the entry and drops the old approval.
  const edit = await call('POST', '/api/runtimes/save', { was: 'qwen-local', entry: { ...QWEN, id: 'qwen' } });
  assert.equal(edit.status, 200);
  assert.deepEqual(saved.value.map((x) => x.id), ['qwen', 'mistral']);
  assert.deepEqual(forgot, ['qwen-local']);
  assert.equal((await call('POST', '/api/runtimes/save', { was: 'gone', entry: { ...QWEN, id: 'gone' } })).status, 404);
  const del = await call('POST', '/api/runtimes/delete', { id: 'mistral' });
  assert.equal(del.status, 200);
  assert.deepEqual(saved.value.map((x) => x.id), ['qwen']);
  assert.deepEqual(forgot, ['qwen-local', 'mistral']);
  assert.equal((await call('POST', '/api/runtimes/delete', { id: 'mistral' })).status, 404);
  // A hand-written entry that is not valid is listed with its reason.
  const handmade = setup({ stored: [{ id: 'x', command: 'llama-server -m x', port: 1 }] });
  const [h] = (await handmade.call('GET', '/api/runtimes/config')).body.entries;
  assert.match(h.error, /command/);
});

test('demo mode: answers from the demo, changes nothing in config.json', async () => {
  const demo = {
    config: [QWEN],
    approved: (id) => id === 'qwen-local',
    list: () => [ROW],
    start: async (id) => ({ state: 'running', demo: true, id }),
    stop: async () => ({ state: 'stopped', demo: true }),
    approve: async () => ({ approved: true, demo: true }),
  };
  const { call, calls, saved } = setup({ demo });
  assert.deepEqual((await call('GET', '/api/runtimes')).body, [ROW]);
  assert.deepEqual((await call('POST', '/api/runtimes/start', { id: 'ollama' })).body, { state: 'running', demo: true, id: 'ollama' });
  assert.equal((await call('GET', '/api/runtimes/config')).body.entries[0].approved, true);
  assert.equal((await call('POST', '/api/runtimes/save', { entry: { ...QWEN, id: 'x' } })).status, 409);
  assert.equal((await call('POST', '/api/runtimes/delete', { id: 'qwen-local' })).status, 409);
  assert.deepEqual(calls, [], 'the real control module is never asked');
  assert.deepEqual(saved.value, [QWEN]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/runtimes-api.test.js`

Expected: FAIL. `Error: Cannot find module '../lib/runtimes/api'`. `ℹ fail 1`.

- [ ] **Step 3: Implement**

Create `lib/runtimes/api.js`:

```js
// The HTTP side of local model runtimes: /api/runtimes*. server.js puts it behind the dashboard sign-in (never a
// gateway API key, MCP or A2A) and sends what `route` returns. The page names a runtime by id only. No error or log
// line carries a path; the owner's own commands (Settings → Local models) are shown with the home folder as ~.
// Demo mode answers from lib/demo.js runtimesDemo() and starts nothing.
const { PATHLIKE } = require('../monitors/api');
const { ID_RE, ownerEntries, ownerEntry, storedEntry } = require('./registry');

const MAX_ENTRIES = 50;
const FIELDS = {
  start: ['id'],
  stop: ['id', 'pid', 'startTime'],
  approve: ['id'],
  delete: ['id'],
  save: ['entry', 'was'],
};
const ENTRY_FIELDS = ['id', 'name', 'command', 'port', 'health'];
const DONE = { start: 'started', stop: 'stopped', approve: 'approved' };

const fail = (status, message) => Object.assign(new Error(message), { status });
const reply = (status, body) => ({ status, body });
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyFields = (body, allowed) => {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw fail(400, `unknown field: ${k.slice(0, 40)}`);
};
const scrub = (msg) =>
  String(msg == null ? '' : msg)
    .replace(PATHLIKE, '[path]')
    .slice(0, 300);
const idParam = (v) => {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw fail(400, 'id must be 1 to 40 lowercase letters, digits or dashes');
  return v;
};

function createRuntimeApi({
  control,
  // config.json "localRuntimes": { list() -> the stored array (or anything), save(array) }
  config,
  demo = null, // lib/demo.js runtimesDemo() in demo mode
  home = '',
} = {}) {
  // The owner's command as Settings shows it: the home folder as ~ (and back again when it is saved).
  const tilde = (a) => (home && home.length > 1 && a.startsWith(home + '/') ? `~${a.slice(home.length)}` : a);
  const untilde = (a) => (home && home.length > 1 && a.startsWith('~/') ? home + a.slice(1) : a);

  // A runtime as the page gets it: the fields it uses, numbers as numbers and text clipped.
  const row = (r) => ({
    id: r.id,
    name: String(r.name).slice(0, 60),
    preset: r.preset === true,
    installed: r.installed === true,
    running: r.running === true,
    healthy: r.healthy === true,
    how: r.how || null,
    pid: Number.isInteger(r.pid) ? r.pid : null,
    startTime: Number.isFinite(r.startTime) ? r.startTime : null,
    children: Number.isInteger(r.children) ? r.children : 0,
    port: Number.isInteger(r.port) ? r.port : null,
    canStart: r.canStart === true,
    canStop: r.canStop === true,
    reason: r.reason ? scrub(r.reason) : null,
    approved: r.approved === true,
    error: r.error ? scrub(r.error) : null,
  });

  const stored = () => {
    const list = demo ? demo.config : config.list();
    return Array.isArray(list) ? list : [];
  };

  // Settings → Local models: the owner's entries with their commands, and whether each is approved as it is now.
  function entriesView() {
    return {
      entries: ownerEntries(stored()).map((e) => ({
        id: e.id,
        name: e.name,
        command: e.command.map((a) => tilde(a)),
        port: e.port,
        health: e.health,
        approved: demo ? !!demo.approved(e.id) : control.approved(e),
        error: e.error ? scrub(e.error) : null,
      })),
      demo: !!demo,
    };
  }

  function save(body) {
    if (demo) throw fail(409, 'demo mode: changes are not saved');
    if (!isObject(body.entry)) throw fail(400, 'entry must be an object');
    onlyFields(body.entry, ENTRY_FIELDS);
    const was = body.was === undefined || body.was === null ? null : idParam(body.was);
    const raw = { ...body.entry };
    if (Array.isArray(raw.command)) raw.command = raw.command.map((a) => (typeof a === 'string' ? untilde(a) : a));
    const list = stored();
    const others = list.filter((x) => !(isObject(x) && x.id === (was || raw.id)));
    if (was && !list.some((x) => isObject(x) && x.id === was)) throw fail(404, 'unknown entry');
    if (!was && list.some((x) => isObject(x) && x.id === raw.id)) throw fail(409, 'an entry with this id exists');
    if (others.length >= MAX_ENTRIES) throw fail(400, `at most ${MAX_ENTRIES} entries`);
    const seen = new Set(ownerEntries(others).filter((x) => !x.error).map((x) => x.id));
    const e = ownerEntry(raw, seen);
    if (e.error) throw fail(400, e.error);
    const next = list.map((x) => (isObject(x) && x.id === (was || raw.id) ? storedEntry(e) : x));
    if (!was) next.push(storedEntry(e));
    try {
      config.save(next);
    } catch {
      throw fail(500, 'the settings could not be saved');
    }
    if (was && was !== e.id) control.forget(was);
    return reply(200, entriesView());
  }

  function remove(body) {
    if (demo) throw fail(409, 'demo mode: changes are not saved');
    const id = idParam(body.id);
    const list = stored();
    if (!list.some((x) => isObject(x) && x.id === id)) throw fail(404, 'unknown entry');
    try {
      config.save(list.filter((x) => !(isObject(x) && x.id === id)));
    } catch {
      throw fail(500, 'the settings could not be saved');
    }
    control.forget(id);
    return reply(200, entriesView());
  }

  async function act(action, body) {
    const id = idParam(body.id);
    if (action === 'stop') {
      const { pid, startTime } = body;
      if (!(Number.isInteger(pid) && pid > 1 && pid < 2 ** 31)) throw fail(400, 'pid must be a whole number above 1');
      if (!(Number.isFinite(startTime) && startTime >= 0)) throw fail(400, 'startTime must be a time in milliseconds');
    }
    const target = action === 'stop' ? { id, pid: body.pid, startTime: body.startTime } : id;
    try {
      const r = await (demo || control)[action](target);
      const out = { ...r };
      if (Array.isArray(out.log)) out.log = out.log.map((l) => scrub(l));
      return reply(200, out);
    } catch (e) {
      const st = e && e.status;
      if (![400, 403, 404, 409, 502].includes(st)) throw fail(500, `the runtime could not be ${DONE[action]}`);
      const log = Array.isArray(e.log) ? { log: e.log.map((l) => scrub(l)) } : {};
      return reply(st, { error: scrub(e.message), ...log });
    }
  }

  const GET = {
    '/api/runtimes': async () => reply(200, ((await (demo || control).list()) || []).map(row)),
    '/api/runtimes/config': async () => reply(200, entriesView()),
  };
  const POST = {
    '/api/runtimes/start': (b) => act('start', b),
    '/api/runtimes/stop': (b) => act('stop', b),
    '/api/runtimes/approve': (b) => act('approve', b),
    '/api/runtimes/save': save,
    '/api/runtimes/delete': remove,
  };

  // `req` is { method, path, contentType, readBody }. Returns { status, body }, or null when the path is not ours.
  async function route(req) {
    const p = req.path;
    if (p !== '/api/runtimes' && !p.startsWith('/api/runtimes/')) return null;
    if (!Object.hasOwn(GET, p) && !Object.hasOwn(POST, p)) return reply(404, { error: 'unknown route' });
    const isPost = Object.hasOwn(POST, p);
    if (req.method !== (isPost ? 'POST' : 'GET')) return reply(405, { error: 'method not allowed' });
    try {
      if (!isPost) return await GET[p]();
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
      let body;
      try {
        body = JSON.parse(await req.readBody());
      } catch (e) {
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      if (!isObject(body)) return reply(400, { error: 'bad request body' });
      onlyFields(body, FIELDS[p.slice('/api/runtimes/'.length)]);
      return await POST[p](body);
    } catch (e) {
      const st = e && e.status;
      if (Number.isInteger(st) && st >= 400 && st <= 599) return reply(st, { error: scrub(e.message) });
      return reply(500, { error: 'runtime request failed' });
    }
  }

  return { route };
}

module.exports = { createRuntimeApi };
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/runtimes-api.test.js`

Expected: PASS (`ℹ fail 0`).

Run: `npm test`

Expected: PASS (`ℹ fail 0`).

- [ ] **Step 5: Commit**

```bash
git add lib/runtimes/api.js test/runtimes-api.test.js
git commit -m "Add the /api/runtimes routes"
```

---

### Task 6: Server wiring and demo runtimes

**Goal:** make it real. `server.js` builds the state, the control module (data folder `.data`, or the demo's throwaway folder; `serverMode: AGENTS_OFF`, the same flag as agent control, so password sign-in turns it off too) and the API, whose `config.save` writes `config.json` "localRuntimes" through a temp file and a rename like the monitor channels do. The routes are mounted right after the monitor routes, which is after `auth.check`, so a gateway API key gets 401. `lib/demo.js` gains `runtimesDemo()`: Ollama running as a brew service, LM Studio and LocalAI stopped, and an owner llama.cpp entry waiting for approval; its actions change only its in-memory list.

**Files**

- Modify: `lib/demo.js` (the exact existing text to replace is quoted in Step 3)
- Modify: `server.js` (the exact existing text to replace is quoted in Step 3)
- Test: `test/runtimes-http.test.js` (new)

**Interfaces**

- Consumes: everything from Tasks 2 to 5; `rawConfig()`, `rawCache`, `CONFIG_FILE`, `DIR`, `DEMO`, `demoDir`, `AGENTS_OFF`, `readBody`, `send` in `server.js`.
- Produces: `runtimesDemo(now?)` in `lib/demo.js` (shape in Shared interfaces); the live routes.

- [ ] **Step 1: Write the failing test**

Create `test/runtimes-http.test.js`:

```js
// /api/runtimes through a spawned server.js: demo data and demo actions, the owner's entries saved to config.json,
// the sign-in gate (gateway keys refused) and control off with password sign-in. Nothing here starts a runtime: the
// only start is in demo mode, and the real server is asked to start an entry that is not approved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway } = require('../lib/gateway');
const { detectDocker } = require('../lib/agents/control');
const { secretsFor, NO_JUDGE_PORTS } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const noPaths = (bodies) => {
  for (const b of bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
};
const ROUTES = {
  get: ['/api/runtimes', '/api/runtimes/config'],
  post: ['/api/runtimes/start', '/api/runtimes/stop', '/api/runtimes/approve', '/api/runtimes/save', '/api/runtimes/delete'],
};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function startServer(env, { data = tmp('zp-rt-http-') } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        ZAAFPULSE_SECRET_STORE: 'file',
        ZAAFPULSE_MASTER_KEY: 'a-master-key-for-the-tests-only',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
      },
      stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const base = `http://127.0.0.1:${port}`;
    const kill = async () => {
      if (!exited) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
    };
    const stop = async () => {
      await kill();
      fs.rmSync(data, { recursive: true, force: true });
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { port, data, base, stop };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  fs.rmSync(data, { recursive: true, force: true });
  throw new Error('could not start server.js on a free port');
}
function client(base, headers = {}) {
  const bodies = [];
  const call = async (p, { method = 'GET', body, raw, extra = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...extra },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    bodies.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  };
  const post = (p, body, extra = JSON_HEADERS) => call(p, { method: 'POST', body, extra });
  return { call, post, bodies };
}

test('runtimes over HTTP: demo runtimes, demo start and stop, approve, nothing saved', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const list = await c.call('/api/runtimes');
    assert.equal(list.status, 200);
    const by = Object.fromEntries(list.json.map((r) => [r.id, r]));
    assert.equal(by.ollama.running, true);
    assert.equal(by.ollama.how, 'service');
    assert.equal(by['qwen-local'].reason, 'approve it in Settings first');
    const stop = await c.post('/api/runtimes/stop', { id: 'ollama', pid: by.ollama.pid, startTime: by.ollama.startTime });
    assert.deepEqual(stop.json, { state: 'stopped', demo: true });
    assert.deepEqual((await c.post('/api/runtimes/start', { id: 'ollama' })).json, { state: 'running', demo: true });
    assert.equal((await c.post('/api/runtimes/start', { id: 'qwen-local' })).status, 403);
    assert.equal((await c.post('/api/runtimes/approve', { id: 'qwen-local' })).status, 200);
    assert.equal((await c.post('/api/runtimes/start', { id: 'qwen-local' })).status, 200);
    const cfg = await c.call('/api/runtimes/config');
    assert.deepEqual(cfg.json.entries[0].command.slice(0, 3), ['llama-server', '-m', '~/models/qwen2.5-7b-instruct-q4_k_m.gguf']);
    assert.equal(cfg.json.demo, true);
    assert.equal((await c.post('/api/runtimes/save', { entry: { id: 'x', command: ['x'], port: 1 } })).status, 409);
    assert.equal((await c.call('/api/runtimes/start', { method: 'POST', raw: '{"id":"ollama"}' })).status, 415);
    assert.ok(!fs.existsSync(path.join(s.data, 'config.json')), 'demo mode writes no config.json');
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('runtimes over HTTP: an owner entry is saved to config.json, listed, and starts only once approved', async () => {
  const data = tmp('zp-rt-http-cfg-');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ userName: 'Kept' }));
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    const entry = { id: 'fake-llm', name: 'Fake', command: ['zp-no-such-program', '--port', '18081'], port: 18081 };
    const saved = await c.post('/api/runtimes/save', { entry });
    assert.equal(saved.status, 200);
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(cfg.userName, 'Kept');
    assert.deepEqual(cfg.localRuntimes, [{ ...entry, health: 'http://127.0.0.1:18081/' }]);
    const row = (await c.call('/api/runtimes')).json.find((r) => r.id === 'fake-llm');
    assert.equal(row.installed, false);
    assert.equal(row.canStart, false);
    const start = await c.post('/api/runtimes/start', { id: 'fake-llm' });
    assert.ok([403, 409].includes(start.status), `refused (${start.status})`);
    if (!detectDocker()) {
      assert.equal(start.status, 409);
      assert.equal(start.json.error, 'not installed');
      assert.equal((await c.post('/api/runtimes/approve', { id: 'fake-llm' })).status, 200);
      const approved = path.join(data, '.data', 'runtimes', 'approved.json');
      assert.ok(fs.existsSync(approved));
      if (process.platform !== 'win32') assert.equal(fs.statSync(approved).mode & 0o777, 0o600);
      const audit = fs.readFileSync(path.join(data, '.data', 'agent-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(
        audit.map((l) => [l.kind, l.action, l.id, l.ok]),
        [
          ['runtime', 'start', 'fake-llm', false],
          ['runtime', 'approve', 'fake-llm', true],
        ],
      );
    }
    assert.equal((await c.post('/api/runtimes/delete', { id: 'fake-llm' })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).localRuntimes, []);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('runtimes over HTTP: sign-in only, gateway keys refused, control off with password sign-in', async () => {
  const data = tmp('zp-rt-http-auth-');
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const apiKey = gw.keys.create({ name: 'rt', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 }).secret;
  gw.flush();
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  const anon = client(s.base);
  const bearer = client(s.base, { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey });
  try {
    for (const who of [anon, bearer]) {
      for (const p of ROUTES.get) assert.equal((await who.call(p)).status, 401, p);
      for (const p of ROUTES.post) assert.equal((await who.post(p, { id: 'ollama' })).status, 401, p);
    }
    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const c = client(s.base, { cookie });
    const list = await c.call('/api/runtimes');
    assert.equal(list.status, 200);
    for (const r of list.json) {
      assert.equal(r.canStart, false);
      assert.equal(r.canStop, false);
      assert.equal(r.reason, 'runtime control is off on this server');
    }
    const start = await c.post('/api/runtimes/start', { id: 'ollama' });
    assert.equal(start.status, 403);
    assert.equal(start.json.error, 'runtime control is off on this server');
    assert.equal((await c.post('/api/runtimes/stop', { id: 'ollama', pid: 4242, startTime: 1 })).status, 403);
    assert.equal((await c.post('/api/runtimes/approve', { id: 'ollama' })).status, 403);
    for (const who of [c, anon, bearer]) noPaths(who.bodies);
  } finally {
    await s.stop();
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/runtimes-http.test.js`

Expected: FAIL. The three tests fail on their first `/api/runtimes` assertion: the request falls through to the static file handler and answers 404 (`Expected values to be strictly equal: 404 !== 200`). `ℹ fail 3`.

- [ ] **Step 3: Implement**

In `lib/demo.js`, replace:

```js
  const channels = { desktop: true, webhook: { url: { keychain: 'acc.monitors-webhook-url' } } };
  return { file, alerts, candidates, paused, channels };
}
```

with:

```js
  const channels = { desktop: true, webhook: { url: { keychain: 'acc.monitors-webhook-url' } } };
  return { file, alerts, candidates, paused, channels };
}

// Synthetic local model servers for AI Office and Settings → Local models: Ollama running as a brew service with one
// model loaded, LM Studio and LocalAI installed and stopped, and one owner entry (llama.cpp) waiting for approval. The
// buttons change this list in memory only: nothing is started, stopped or written, and answers say { demo: true }.
function runtimesDemo(now = Date.now()) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const second = (t) => Math.round(t / 1000) * 1000;
  const base = { preset: true, installed: true, healthy: false, how: null, pid: null, startTime: null, children: 0 };
  const items = [
    { ...base, id: 'ollama', name: 'Ollama', port: 11434, running: true, healthy: true, how: 'service', pid: 40112 },
    { ...base, id: 'lmstudio', name: 'LM Studio', port: 1234, running: false },
    { ...base, id: 'localai', name: 'LocalAI', port: 8080, running: false },
    { ...base, id: 'qwen-local', name: 'Qwen (llama.cpp)', preset: false, port: 8081, running: false },
  ];
  items[0].startTime = second(now - 5 * 86400e3);
  items[0].children = 1;
  const approved = new Set();
  const config = [
    {
      id: 'qwen-local',
      name: 'Qwen (llama.cpp)',
      command: ['llama-server', '-m', '~/models/qwen2.5-7b-instruct-q4_k_m.gguf', '--port', '8081'],
      port: 8081,
    },
  ];
  let nextPid = 51200;
  const ok = (r) => r.preset || approved.has(r.id);
  const view = (r) => {
    const reason = !r.running && !ok(r) ? 'approve it in Settings first' : null;
    return { ...r, canStart: !r.running && !reason, canStop: r.running, reason, approved: ok(r), error: null };
  };
  const find = (id) => {
    const r = items.find((x) => x.id === id);
    if (!r) throw fail(404, 'unknown runtime');
    return r;
  };
  return {
    config,
    approved: (id) => approved.has(id),
    list: () => items.map(view),
    async start(id) {
      const r = find(id);
      if (r.running) throw fail(409, 'already running');
      if (!ok(r)) throw fail(403, 'approve it in Settings first');
      Object.assign(r, { running: true, healthy: true, how: 'zaafpulse', pid: nextPid++, startTime: second(Date.now()) });
      return { state: 'running', demo: true };
    },
    async stop({ id, pid, startTime }) {
      const r = find(id);
      if (!r.running) throw fail(409, 'already stopped');
      if (r.pid !== pid || r.startTime !== startTime) throw fail(409, 'the process changed; refresh');
      Object.assign(r, { running: false, healthy: false, how: null, pid: null, startTime: null, children: 0 });
      return { state: 'stopped', demo: true };
    },
    async approve(id) {
      const r = find(id);
      if (r.preset) throw fail(400, 'a preset needs no approval');
      approved.add(id);
      return { approved: true, demo: true };
    },
  };
}
```

In `lib/demo.js`, replace:

```js
  monitorsDemo,
  traceDemoAlias,
```

with:

```js
  monitorsDemo,
  runtimesDemo,
  traceDemoAlias,
```

In `server.js`, replace:

```js
const { createAgentControl } = require('./lib/agents/control');
```

with:

```js
const { createAgentControl } = require('./lib/agents/control');
const runtimeRegistry = require('./lib/runtimes/registry');
const { createRuntimeState, jsonFile } = require('./lib/runtimes/state');
const { createRuntimeControl } = require('./lib/runtimes/control');
const { createRuntimeApi } = require('./lib/runtimes/api');
```

In `server.js`, replace:

```js
  agentsOff: AGENTS_OFF,
  notifyOff: NOTIFY_OFF,
  home: os.homedir(),
});
```

with:

```js
  agentsOff: AGENTS_OFF,
  notifyOff: NOTIFY_OFF,
  home: os.homedir(),
});
// Local model servers (lib/runtimes): Start and Stop on the AI Office cards, and the owner's own runtimes in
// config.json "localRuntimes" (Settings → Local models). Off wherever agent control is off (server mode, password
// sign-in) and in Docker. Demo mode answers from synthetic runtimes and starts nothing.
const runtimeDir = DEMO ? demoDir : path.join(DIR, '.data');
const runtimeEntries = () => runtimeRegistry.entries(rawConfig().localRuntimes);
const runtimeStarted = jsonFile(path.join(runtimeDir, 'runtimes', 'started.json'));
const runtimeControl = createRuntimeControl({
  state: createRuntimeState({ entries: runtimeEntries, started: runtimeStarted }),
  entries: runtimeEntries,
  dataDir: runtimeDir,
  started: runtimeStarted,
  serverMode: AGENTS_OFF,
  log: (m) => console.error(m),
});
const runtimeApi = createRuntimeApi({
  control: runtimeControl,
  config: {
    list: () => rawConfig().localRuntimes,
    save: (list) => {
      const raw = { ...rawConfig(), localRuntimes: list };
      fs.writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(raw, null, 2));
      fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
      rawCache = { mtime: fs.statSync(CONFIG_FILE).mtimeMs, value: raw };
    },
  },
  demo: DEMO ? demo.runtimesDemo() : null,
  home: os.homedir(),
});
```

In `server.js`, replace:

```js
      if (hit) return send(res, hit.status, hit.body);
    }
    if (url.pathname === '/api/logs') {
```

with:

```js
      if (hit) return send(res, hit.status, hit.body);
    }
    // Local model servers: Start, Stop and the owner's entries, behind the same sign-in. Only ids reach the server.
    {
      const hit = await runtimeApi.route({
        method: req.method,
        path: url.pathname,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
      });
      if (hit) return send(res, hit.status, hit.body);
    }
    if (url.pathname === '/api/logs') {
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/runtimes-http.test.js`

Expected: PASS (`ℹ fail 0`).

Run: `npm test`

Expected: PASS (`ℹ fail 0`).

- [ ] **Step 5: Commit**

```bash
git add lib/demo.js server.js test/runtimes-http.test.js
git commit -m "Serve the runtime routes behind the dashboard sign-in, with demo runtimes"
```

---

### Task 7: AI Office: Start and Stop on the cards

**Goal:** the buttons. `squadCards` (in `public/app.js`) gives the Ollama and LM Studio cards an empty `data-rt-slot` under their status line. The AI Office grid gets `data-rt-grid`, and `mountSquad` calls `rtMount()`, which polls `/api/runtimes` every 5 s while the page is shown. Each runtime with a slot gets an action row in it; every other runtime (llama.cpp, Jan, LocalAI, the owner's, or Ollama/LM Studio when they have no card) gets a card of its own appended to the grid. The row shows the server state and port, one button (Stop while running, Start while stopped, "Starting…"/"Stopping…" in flight), how the server runs, the reason when no button is offered (control off, not approved), and after an action the result or error and the masked log lines. Stop asks "Stop Ollama? Models it has loaded are unloaded." first. Every node is built with `createElement` and `textContent`; the overview page's grid has no `data-rt-grid`, so nothing is drawn there.

**Files**

- Create: `public/runtimesview.js`
- Modify: `public/app.js` (the exact existing text to replace is quoted in Step 3)
- Modify: `public/officeview.js` (the exact existing text to replace is quoted in Step 3)
- Modify: `public/index.html` (the exact existing text to replace is quoted in Step 3)
- Modify: `public/styles.css` (the exact existing text to replace is quoted in Step 3)
- Test: `test/runtimes-ui.test.js` (new)

**Interfaces**

- Consumes: `GET /api/runtimes`, `POST /api/runtimes/start | stop` (Task 5); `icon()`, `onUnmount()` (existing globals from `public/app.js` and `public/iso.js`).
- Produces: `RT`, `RT_CARD_IDS`, `RT_ID_RE`, `rtText`, `rtCap`, `rtEl`, `rtStatus`, `rtHowNote`, `rtButton`, `rtConfirmText`, `rtResultText`, `rtErrorText`, `rtLogLines`, `rtCardPlan`, `rtActionRow`, `rtCard`, `rtApi`, `rtPaint`, `rtLoad`, `rtAct`, `rtMount` (all globals of the page; the pure ones and the node builders are exported for tests).

- [ ] **Step 1: Write the failing test**

Create `test/runtimes-ui.test.js`:

```js
// AI Office's Start and Stop: the pure helpers of public/runtimesview.js without a browser, its nodes built against a
// stand-in document that refuses innerHTML, and an audit of the file (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  rtStatus,
  rtHowNote,
  rtButton,
  rtConfirmText,
  rtResultText,
  rtErrorText,
  rtLogLines,
  rtCardPlan,
  rtActionRow,
  rtCard,
} = require('../public/runtimesview');

const SRC = path.join(__dirname, '..', 'public', 'runtimesview.js');
const R = (over = {}) => ({
  id: 'ollama',
  name: 'Ollama',
  preset: true,
  installed: true,
  running: true,
  healthy: true,
  how: 'process',
  pid: 4242,
  startTime: 1,
  children: 1,
  port: 11434,
  canStart: false,
  canStop: true,
  reason: null,
  approved: true,
  error: null,
  ...over,
});

test('rtButton: Stop while running, Start while stopped, a label while a request is out, none when not allowed', () => {
  assert.deepEqual(rtButton(R()), { action: 'stop', label: 'Stop', disabled: false });
  assert.deepEqual(rtButton(R({ running: false, canStop: false, canStart: true })), {
    action: 'start',
    label: 'Start',
    disabled: false,
  });
  assert.deepEqual(rtButton(R(), 'start'), { action: 'start', label: 'Starting…', disabled: true });
  assert.deepEqual(rtButton(R(), 'stop'), { action: 'stop', label: 'Stopping…', disabled: true });
  assert.equal(rtButton(R({ canStop: false, reason: 'runtime control is off on this server' })), null);
  assert.equal(rtButton(R({ running: false, canStart: false })), null);
  assert.equal(rtButton(null), null);
});

test('rtStatus and rtHowNote: the status line and how a server runs', () => {
  assert.deepEqual(rtStatus(R()), { cls: 'running', text: 'Server running · port 11434 · 1 model process' });
  assert.equal(rtStatus(R({ healthy: false, children: 2 })).text, 'Server running · port 11434 · not answering · 2 model processes');
  assert.deepEqual(rtStatus(R({ running: false })), { cls: 'idle', text: 'Server stopped · port 11434' });
  assert.deepEqual(rtStatus(R({ running: false, installed: false })), { cls: 'off', text: 'Not installed' });
  assert.equal(rtHowNote(R()), 'started outside ZAAFPulse');
  assert.equal(rtHowNote(R({ how: 'service' })), 'brew service');
  assert.equal(rtHowNote(R({ how: 'app' })), 'app');
  assert.equal(rtHowNote(R({ how: 'zaafpulse' })), 'started here');
  assert.equal(rtHowNote(R({ how: 'system' })), 'managed by the system');
  assert.equal(rtHowNote(R({ how: '<b>x</b>' })), '');
  assert.equal(rtHowNote(R({ running: false })), '');
});

test('rtConfirmText, rtResultText and rtErrorText', () => {
  assert.equal(rtConfirmText(R()), 'Stop Ollama? Models it has loaded are unloaded.');
  assert.equal(rtResultText('start', { state: 'running' }), 'Started.');
  assert.equal(rtResultText('start', { state: 'starting', note: 'started, not answering yet' }), 'Started, not answering yet.');
  assert.equal(rtResultText('stop', { state: 'stopped' }), 'Stopped.');
  assert.equal(rtResultText('stop', { state: 'stopping', note: 'still shutting down' }), 'Still shutting down.');
  assert.equal(rtResultText('start', { state: 'running', demo: true }), 'Demo mode: nothing was started.');
  assert.equal(rtResultText('stop', { state: 'stopped', demo: true }), 'Demo mode: nothing was stopped.');
  assert.equal(rtErrorText({ status: 409, message: 'the process changed; refresh' }), 'The process changed; refresh (409)');
  assert.equal(rtErrorText({ status: 403, message: 'approve it in Settings first' }), 'Approve it in Settings first (403)');
  assert.equal(rtErrorText({}), 'The request failed');
});

test('rtLogLines keeps at most 20 lines of text', () => {
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  assert.deepEqual(rtLogLines(many), many.slice(-20));
  assert.deepEqual(rtLogLines(['a\u0000b', 7, '<script>x</script>']), ['a b', '<script>x</script>']);
  assert.deepEqual(rtLogLines('nope'), []);
});

test('rtCardPlan: Ollama and LM Studio go on their cards when they have one, the rest get their own', () => {
  const list = [R(), R({ id: 'lmstudio' }), R({ id: 'localai' }), R({ id: 'qwen-local', preset: false }), null];
  const plan = rtCardPlan(list, ['ollama', 'lmstudio']);
  assert.deepEqual(plan.slots.map((r) => r.id), ['ollama', 'lmstudio']);
  assert.deepEqual(plan.own.map((r) => r.id), ['localai', 'qwen-local']);
  assert.deepEqual(rtCardPlan(list, ['ollama']).own.map((r) => r.id), ['lmstudio', 'localai', 'qwen-local']);
  assert.deepEqual(rtCardPlan(null, []), { slots: [], own: [] });
});

// A tiny stand-in for `document` that records how nodes are filled and refuses innerHTML.
function fakeDoc() {
  const el = (tag) => {
    const node = { tag, children: [], className: '', attrs: {}, textContent: '' };
    node.appendChild = (c) => (node.children.push(c), c);
    node.setAttribute = (k, v) => (node.attrs[k] = String(v));
    Object.defineProperty(node, 'innerHTML', {
      set() {
        throw new Error('innerHTML used for content');
      },
    });
    return node;
  };
  return { createElement: el, createTextNode: (text) => ({ tag: '#text', text }) };
}
const flat = (n, out = []) => {
  out.push(n);
  for (const c of n.children || []) flat(c, out);
  return out;
};
const texts = (n) => flat(n).map((x) => (x.tag === '#text' ? x.text : x.textContent)).filter(Boolean);

test('the action row: error and log lines are text, never markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const row = rtActionRow(fakeDoc(), R({ running: false, canStart: true }), {
    msg: `The command could not start ${evil} (502)`,
    tone: 'bad',
    log: [`error ${evil}`, 'second line'],
  });
  const all = flat(row);
  const btn = all.find((n) => n.tag === 'button');
  assert.equal(btn.textContent, 'Start');
  assert.equal(btn.attrs['data-rt-act'], 'start');
  assert.equal(btn.attrs['data-rt-id'], 'ollama');
  const msg = all.find((n) => n.className.includes('rt-msg'));
  assert.equal(msg.textContent, `The command could not start ${evil} (502)`);
  assert.equal(msg.attrs.role, 'status');
  const pre = all.find((n) => n.tag === 'pre');
  assert.equal(pre.textContent, `error ${evil}\nsecond line`);
  const off = rtActionRow(fakeDoc(), R({ canStop: false, reason: 'runtime control is off in Docker' }));
  assert.ok(!flat(off).some((n) => n.tag === 'button'), 'no button when control is off');
  assert.ok(texts(off).includes('Runtime control is off in Docker'));
});

test('a card of its own is built from text', () => {
  const card = rtCard(fakeDoc(), R({ id: 'localai', name: 'Local<b>AI</b>', port: 8080, children: 0 }));
  assert.equal(card.attrs['data-rt-card'], 'localai');
  const t = texts(card);
  assert.ok(t.includes('LOCAL<B>AI</B>'));
  assert.ok(t.includes('Running now'));
  assert.ok(t.includes('8080'));
  assert.ok(t.includes('Stop'));
});

test('runtimesview.js builds no HTML from server text (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // The only innerHTML is the app's own icon markup.
  const sets = [...src.matchAll(/\binnerHTML\s*\+?=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(sets, ['iconHtml']);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|DOMParser|createContextualFragment/);
  // No HTML template takes a value: markup in a template is static (the Settings shell), text goes in by textContent.
  for (const t of [...src.matchAll(/`[^`]*`/g)].map((m) => m[0]).filter((x) => /<[a-z]/.test(x)))
    assert.doesNotMatch(t, /\$\{/, `a template with markup takes a value: ${t.slice(0, 60)}`);
  assert.match(src, /\.textContent = text/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/runtimes-ui.test.js test/office-view.test.js`

Expected: FAIL. `Error: Cannot find module '../public/runtimesview'`. `ℹ fail 1` (the office view tests still pass).

- [ ] **Step 3: Implement**

Create `public/runtimesview.js`:

```js
'use strict';
/* Local model servers in the dashboard: Start and Stop in AI Office (an action row on the Ollama and LM Studio cards,
   a card of their own for llama.cpp, Jan, LocalAI and the owner's runtimes) and Settings → Local models (the owner's
   entries: add, edit, delete, approve). Everything from /api/runtimes reaches the page as text: nodes are made with
   createElement and filled with textContent (S1). The only innerHTML here is this app's own icon markup. The helpers
   at the top are pure, so test/runtimes-ui.test.js runs them without a browser. */

const RT_CARD_IDS = ['ollama', 'lmstudio']; // runtimes that already have a card among the installed AI tools
const RT_POLL_MS = 5000;
const RT_ID_RE = /^[a-z0-9-]{1,40}$/;
const RT_HOW = {
  app: 'app',
  service: 'brew service',
  zaafpulse: 'started here',
  process: 'started outside ZAAFPulse',
  system: 'managed by the system',
};
const RT_DESC = {
  ollama: 'Runs open models on this machine. Stopping the server unloads every model.',
  lmstudio: 'Runs open models on this machine. Start and Stop use its lms command.',
  llamacpp: "llama.cpp's OpenAI-compatible server. Add it in Settings → Local models with a model file to start it here.",
  jan: "Jan desktop app. Its local API server answers on port 1337 while it is on in Jan's settings.",
  localai: 'LocalAI, an OpenAI-compatible server for local models.',
};
const RT_OWN_DESC = 'Your own runtime from Settings → Local models.';

// One line of text from the server: control characters out, spaces folded, clipped. Markup stays text.
const rtText = (v, max = 300) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const rtCap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The runtime's status line: { cls: 'running' | 'idle' | 'off', text }.
function rtStatus(r) {
  if (!r || typeof r !== 'object') return { cls: 'off', text: '' };
  const port = Number.isInteger(r.port) ? ` · port ${r.port}` : '';
  if (r.running) {
    const n = Number.isInteger(r.children) ? r.children : 0;
    const kids = n > 0 ? ` · ${n} model process${n === 1 ? '' : 'es'}` : '';
    return { cls: 'running', text: `Server running${port}${r.healthy ? '' : ' · not answering'}${kids}` };
  }
  if (!r.installed) return { cls: 'off', text: 'Not installed' };
  return { cls: 'idle', text: `Server stopped${port}` };
}

// How a running server runs, as a short note next to Stop; '' when it is not running.
const rtHowNote = (r) => (r && r.running && Object.hasOwn(RT_HOW, r.how) ? RT_HOW[r.how] : '');

// The one button a runtime gets, or null: Stop while running, Start while stopped, a label while a request is out.
function rtButton(r, busy) {
  if (busy === 'start') return { action: 'start', label: 'Starting…', disabled: true };
  if (busy === 'stop') return { action: 'stop', label: 'Stopping…', disabled: true };
  if (!r) return null;
  if (r.running && r.canStop === true) return { action: 'stop', label: 'Stop', disabled: false };
  if (!r.running && r.canStart === true) return { action: 'start', label: 'Start', disabled: false };
  return null;
}

const rtConfirmText = (r) => `Stop ${rtText(r && r.name, 60) || 'this server'}? Models it has loaded are unloaded.`;

// What happened, from the answer of /api/runtimes/start or /stop.
function rtResultText(action, res) {
  if (!res || typeof res !== 'object') return '';
  if (res.demo) return `Demo mode: nothing was ${action === 'stop' ? 'stopped' : 'started'}.`;
  if (res.state === 'running') return 'Started.';
  if (res.state === 'starting') return `${rtCap(rtText(res.note)) || 'Started, not answering yet'}.`;
  if (res.state === 'stopped') return 'Stopped.';
  if (res.state === 'stopping') return `${rtCap(rtText(res.note)) || 'Still shutting down'}.`;
  return '';
}

// Any refusal as text, with its status.
function rtErrorText(e) {
  const st = e && Number.isInteger(e.status) ? e.status : 0;
  const msg = rtCap(rtText(e && e.message)) || 'The request failed';
  return st ? `${msg} (${st})` : msg;
}

// The masked log lines of a start, as text: at most 20, each clipped.
const rtLogLines = (v) =>
  Array.isArray(v)
    ? v
        .filter((l) => typeof l === 'string')
        .slice(-20)
        .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, 300))
    : [];

// Which runtimes go on an existing card's slot and which get a card of their own.
function rtCardPlan(list, slotIds) {
  const slots = new Set(slotIds || []);
  const rows = Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string') : [];
  return { slots: rows.filter((r) => slots.has(r.id)), own: rows.filter((r) => !slots.has(r.id)) };
}

/* ---------- nodes (text only) ---------- */
function rtEl(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

// Under a card's status line: the server's state, the button and how it runs, then the result and any log lines.
function rtActionRow(doc, r, ui = {}) {
  const box = rtEl(doc, 'div', 'rt-body');
  const row = rtEl(doc, 'div', 'rt-row');
  row.appendChild(rtEl(doc, 'span', 'rt-state', rtStatus(r).text));
  const b = rtButton(r, ui.busy);
  if (b) {
    const btn = rtEl(doc, 'button', `btn ghost mon-sm${b.action === 'stop' ? ' danger' : ''}`, b.label);
    btn.type = 'button';
    btn.disabled = b.disabled;
    btn.setAttribute('data-rt-act', b.action);
    btn.setAttribute('data-rt-id', r.id);
    row.appendChild(btn);
  }
  const how = rtHowNote(r);
  if (how) row.appendChild(rtEl(doc, 'span', 'rt-how', how));
  box.appendChild(row);
  if (!b && r.reason) box.appendChild(rtEl(doc, 'p', 'mon-note off', rtCap(rtText(r.reason))));
  if (ui.msg) {
    const m = rtEl(doc, 'p', `mon-msg rt-msg ${ui.tone || ''}`, ui.msg);
    m.setAttribute('role', 'status');
    box.appendChild(m);
  }
  const lines = rtLogLines(ui.log);
  if (lines.length) box.appendChild(rtEl(doc, 'pre', 'rt-log', lines.join('\n')));
  return box;
}

// A card of its own (llama.cpp, Jan, LocalAI, the owner's runtimes): name, status, description, actions, numbers.
function rtCard(doc, r, ui = {}, iconHtml = '') {
  const card = rtEl(doc, 'div', 'card agent rt-card');
  card.setAttribute('data-rt-card', r.id);
  const top = rtEl(doc, 'div', 'agent-top');
  const ic = rtEl(doc, 'span', `agent-icon chip ${r.preset ? 'green' : 'violet'}`);
  if (iconHtml) ic.innerHTML = iconHtml;
  const names = rtEl(doc, 'div');
  names.appendChild(rtEl(doc, 'div', 'agent-name', rtText(r.name, 60).toUpperCase()));
  names.appendChild(rtEl(doc, 'div', 'agent-role', r.preset ? 'Local models' : 'Your own runtime'));
  top.appendChild(ic);
  top.appendChild(names);
  card.appendChild(top);
  const st = rtStatus(r);
  const status = rtEl(doc, 'div', `status ${st.cls}`);
  status.appendChild(rtEl(doc, 'i'));
  status.appendChild(doc.createTextNode(r.running ? 'Running now' : r.installed ? 'Installed · not running' : 'Not installed'));
  card.appendChild(status);
  card.appendChild(rtEl(doc, 'p', 'agent-desc', r.preset && RT_DESC[r.id] ? RT_DESC[r.id] : RT_OWN_DESC));
  const slot = rtEl(doc, 'div', 'rt-slot');
  slot.appendChild(rtActionRow(doc, r, ui));
  card.appendChild(slot);
  const stats = rtEl(doc, 'div', 'agent-stats');
  for (const [value, label] of [
    [Number.isInteger(r.port) ? String(r.port) : '—', 'port'],
    [r.running && Number.isInteger(r.pid) ? String(r.pid) : '—', 'pid'],
    [r.running ? String(Number.isInteger(r.children) ? r.children : 0) : '—', 'model processes'],
  ]) {
    const cell = rtEl(doc, 'div');
    cell.appendChild(rtEl(doc, 'b', 'num', value));
    cell.appendChild(rtEl(doc, 'span', '', label));
    stats.appendChild(cell);
  }
  card.appendChild(stats);
  return card;
}

/* ---------- browser side ---------- */
const RT = { list: null, ui: {}, err: '' };

// fetch with the server's { error, log } and status kept, so a failed start can show its log lines.
async function rtApi(path, body) {
  const opts =
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  let r;
  try {
    r = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error('the server did not answer'), { status: 0 });
  }
  if (r.status === 401) {
    location.href = '/login.html';
    throw Object.assign(new Error('signed out'), { status: 401 });
  }
  let j = null;
  try {
    j = await r.json();
  } catch {
    j = null;
  }
  if (!r.ok) {
    const msg = j && typeof j.error === 'string' ? j.error : `the server answered ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status, log: j && Array.isArray(j.log) ? j.log : [] });
  }
  return j && typeof j === 'object' ? j : {};
}

// AI Office: fill the slots of the existing cards and draw the other runtimes' cards in the same grid.
function rtPaint() {
  const grid = document.querySelector('[data-rt-grid]');
  if (!grid || !Array.isArray(RT.list)) return;
  const active = document.activeElement;
  const focused = active && grid.contains(active) && active.dataset ? active.dataset.rtId : null;
  const slots = new Map([...grid.querySelectorAll('[data-rt-slot]')].map((s) => [s.dataset.rtSlot, s]));
  const plan = rtCardPlan(RT.list, [...slots.keys()]);
  for (const r of plan.slots) slots.get(r.id).replaceChildren(rtActionRow(document, r, RT.ui[r.id]));
  const cards = new Map([...grid.querySelectorAll('[data-rt-card]')].map((c) => [c.dataset.rtCard, c]));
  for (const [id, c] of cards) if (!plan.own.some((r) => r.id === id)) c.remove();
  for (const r of plan.own) {
    const next = rtCard(document, r, RT.ui[r.id], icon('cube', 18));
    if (cards.has(r.id)) cards.get(r.id).replaceWith(next);
    else grid.appendChild(next);
  }
  if (focused)
    for (const b of grid.querySelectorAll('[data-rt-act]'))
      if (b.dataset.rtId === focused) {
        b.focus({ preventScroll: true });
        break;
      }
}

async function rtLoad() {
  try {
    const list = await rtApi('/api/runtimes');
    RT.list = Array.isArray(list) ? list : [];
  } catch {
    return; // keep what is drawn; the next poll tries again
  }
  rtPaint();
}

async function rtAct(id, action) {
  const r = (RT.list || []).find((x) => x.id === id);
  if (!r) return;
  const ui = (RT.ui[id] = RT.ui[id] || {});
  if (ui.busy) return;
  if (action === 'stop' && !confirm(rtConfirmText(r))) return;
  Object.assign(ui, { busy: action, msg: '', tone: '', log: [] });
  rtPaint();
  try {
    const body = action === 'stop' ? { id, pid: r.pid, startTime: r.startTime } : { id };
    const res = await rtApi(`/api/runtimes/${action}`, body);
    const settled = res.state === 'running' || res.state === 'stopped';
    Object.assign(ui, { msg: rtResultText(action, res), tone: settled ? 'good' : 'warn', log: rtLogLines(res.log) });
  } catch (e) {
    Object.assign(ui, { msg: rtErrorText(e), tone: 'bad', log: rtLogLines(e.log) });
  } finally {
    ui.busy = '';
  }
  await rtLoad();
  rtPaint();
}

// Called by the AI Office page when it is drawn; polls while the page is on screen.
function rtMount() {
  if (!document.querySelector('[data-rt-grid]')) return;
  rtPaint();
  rtLoad();
  const timer = setInterval(() => {
    if (document.querySelector('[data-rt-grid]')) rtLoad();
  }, RT_POLL_MS);
  onUnmount(() => clearInterval(timer));
}

/* ---------- page-wide clicks ---------- */
if (typeof document !== 'undefined')
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-rt-act]');
    if (b && RT_ID_RE.test(b.dataset.rtId || '')) rtAct(b.dataset.rtId, b.dataset.rtAct);
  });

if (typeof module !== 'undefined')
  module.exports = {
    rtStatus,
    rtHowNote,
    rtButton,
    rtConfirmText,
    rtResultText,
    rtErrorText,
    rtLogLines,
    rtCardPlan,
    rtActionRow,
    rtCard,
  };
```

In `public/app.js`, replace:

```js
      <div class="status ${statusCls}"><i></i>${statusText}</div>
      <p class="agent-desc">${meta.desc}</p>${tags}
```

with:

```js
      <div class="status ${statusCls}"><i></i>${statusText}</div>${RT_CARD_IDS.includes(id) ? `<div class="rt-slot" data-rt-slot="${id}"></div>` : ''}
      <p class="agent-desc">${meta.desc}</p>${tags}
```

In `public/officeview.js`, replace:

```js
    <div class="grid squad">${s.html}</div>
```

with:

```js
    <div class="grid squad" data-rt-grid>${s.html}</div>
```

In `public/officeview.js`, replace:

```js
  monPaintStrips(); // paused agents, with Resume and Stop
```

with:

```js
  monPaintStrips(); // paused agents, with Resume and Stop
  rtMount(); // Start and Stop for the local model servers, on the Installed AI tools cards
```

In `public/index.html`, replace:

```html
  <script src="monitorsview.js"></script>
  <script src="app.js"></script>
```

with:

```html
  <script src="monitorsview.js"></script>
  <script src="runtimesview.js"></script>
  <script src="app.js"></script>
```

In `public/styles.css`, replace:

```css
.mon-secret .ie-secret:has(.input[hidden]) select {
  grid-column: 1 / -1;
}
```

with:

```css
.mon-secret .ie-secret:has(.input[hidden]) select {
  grid-column: 1 / -1;
}
/* Local model servers: the action row on AI Office cards, and Settings → Local models */
.rt-slot:empty {
  display: none;
}
.rt-body {
  display: grid;
  gap: 6px;
}
.rt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-2);
}
.rt-state {
  flex: 1;
  min-width: 0;
}
.rt-how {
  color: var(--muted);
}
.rt-msg.warn {
  color: var(--warn-ink);
}
.rt-log {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rt-card .btn.danger,
.agent .rt-slot .btn.danger,
.rt-settings .btn.danger {
  color: var(--bad);
  border-color: color-mix(in srgb, var(--bad) 45%, transparent);
}
.rt-settings {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  scroll-margin-top: 76px;
}
.rt-entries {
  display: grid;
  gap: 8px;
}
.rt-entry {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-2);
}
.rt-entry-main {
  display: grid;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.rt-entry-main small {
  color: var(--muted);
}
.rt-cmd {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.rt-approval {
  font-size: 12px;
  color: var(--muted);
}
.rt-approval.good {
  color: var(--good);
}
.rt-form {
  display: grid;
  gap: 10px;
}
.rt-form h4 {
  margin: 0;
}
.rt-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.rt-form-grid label {
  display: grid;
  gap: 4px;
  font-size: 12.5px;
}
.rt-wide {
  grid-column: 1 / -1;
}
@media (max-width: 720px) {
  .rt-form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/runtimes-ui.test.js test/office-view.test.js`

Expected: PASS (`ℹ fail 0`).

Run: `npm test`

Expected: PASS (`ℹ fail 0`).

- [ ] **Step 5: Commit**

```bash
git add public/runtimesview.js public/app.js public/index.html public/officeview.js public/styles.css test/runtimes-ui.test.js
git commit -m "Start and stop local model servers from the AI Office cards"
```

---

### Task 8: Settings → Local models

**Goal:** the owner's entries. A Settings section (after Monitors) lists the entries from `/api/runtimes/config` with their command, port, health URL, approval state and any error, with **Approve** (asks for confirmation and shows the exact command), **Edit** (fills the form; the id can change) and **Delete** (confirmation; its approval goes too). The form takes id, name, port, an optional health URL and the command as one argument per line, so there is no quoting. After a save the entry needs approval again. All of it is text through `textContent`; the section's static markup is the only template.

**Files**

- Modify: `public/runtimesview.js` (the exact existing text to replace is quoted in Step 3)
- Modify: `public/app.js` (the exact existing text to replace is quoted in Step 3)
- Test: `test/runtimes-settings-ui.test.js` (new)

**Interfaces**

- Consumes: `GET /api/runtimes/config`, `POST /api/runtimes/save | delete | approve` (Task 5); `rtApi`, `rtEl`, `rtText`, `rtCap`, `rtErrorText`, `RT_ID_RE` (Task 7).
- Produces: `rtEntryFromForm(f) -> { entry } | { error }`, `rtEntryRow(doc, e)`, `runtimesSettingsShell() -> string`, `mountRuntimesSettings()`.

- [ ] **Step 1: Write the failing test**

Create `test/runtimes-settings-ui.test.js`:

```js
// Settings → Local models: the form helper and the entry rows of public/runtimesview.js, built against a stand-in
// document that refuses innerHTML (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const { rtEntryFromForm, rtEntryRow } = require('../public/runtimesview');

// A tiny stand-in for `document` that records how nodes are filled and refuses innerHTML.
function fakeDoc() {
  const el = (tag) => {
    const node = { tag, children: [], className: '', attrs: {}, textContent: '' };
    node.appendChild = (c) => (node.children.push(c), c);
    node.setAttribute = (k, v) => (node.attrs[k] = String(v));
    Object.defineProperty(node, 'innerHTML', {
      set() {
        throw new Error('innerHTML used for content');
      },
    });
    return node;
  };
  return { createElement: el, createTextNode: (text) => ({ tag: '#text', text }) };
}
const flat = (n, out = []) => {
  out.push(n);
  for (const c of n.children || []) flat(c, out);
  return out;
};
const texts = (n) => flat(n).map((x) => (x.tag === '#text' ? x.text : x.textContent)).filter(Boolean);
const buttons = (n) => flat(n).filter((x) => x.tag === 'button').map((x) => x.attrs['data-rt-entry-act']);

test('rtEntryFromForm: one argument per line, the port as a number, optional name and health', () => {
  const ok = rtEntryFromForm({
    id: ' qwen-local ',
    name: 'Qwen',
    command: 'llama-server\n-m\n~/models/qwen.gguf\n\n--port\n8081\n',
    port: '8081',
    health: '',
  });
  assert.deepEqual(ok, {
    entry: {
      id: 'qwen-local',
      name: 'Qwen',
      command: ['llama-server', '-m', '~/models/qwen.gguf', '--port', '8081'],
      port: 8081,
    },
  });
  assert.match(rtEntryFromForm({ id: 'Bad Id', command: 'x', port: '1' }).error, /^Id/);
  assert.match(rtEntryFromForm({ id: 'a', command: '\n \n', port: '1' }).error, /^Command/);
  assert.match(rtEntryFromForm({ id: 'a', command: 'x', port: '' }).error, /^Port/);
  assert.match(rtEntryFromForm({ id: 'a', command: 'x', port: '70000' }).error, /^Port/);
  assert.match(rtEntryFromForm({ id: 'a', command: 'x', port: '80.5' }).error, /^Port/);
  const h = rtEntryFromForm({ id: 'a', command: 'x', port: '1', health: 'http://127.0.0.1:1/h' });
  assert.equal(h.entry.health, 'http://127.0.0.1:1/h');
  assert.match(rtEntryFromForm(null).error, /^Id/);
});

test('rtEntryRow: name, command, port and approval as text; Approve only for a valid entry not yet approved', () => {
  const e = {
    id: 'qwen-local',
    name: 'Qwen',
    command: ['llama-server', '-m', '~/models/<qwen>.gguf'],
    port: 8081,
    health: 'http://127.0.0.1:8081/',
    approved: false,
    error: null,
  };
  const row = rtEntryRow(fakeDoc(), e);
  assert.equal(row.attrs['data-rt-entry'], 'qwen-local');
  const t = texts(row);
  assert.ok(t.includes('llama-server -m ~/models/<qwen>.gguf'));
  assert.ok(t.includes('qwen-local · port 8081 · http://127.0.0.1:8081/'));
  assert.ok(t.includes('Not approved'));
  assert.deepEqual(buttons(row), ['approve', 'edit', 'delete']);
  const approved = rtEntryRow(fakeDoc(), { ...e, approved: true });
  assert.ok(texts(approved).includes('Approved'));
  assert.deepEqual(buttons(approved), ['edit', 'delete']);
  const bad = rtEntryRow(fakeDoc(), { ...e, error: 'port must be a whole number from 1 to 65535' });
  assert.ok(texts(bad).includes('Port must be a whole number from 1 to 65535'));
  assert.deepEqual(buttons(bad), ['edit', 'delete'], 'an invalid entry cannot be approved');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/runtimes-settings-ui.test.js test/runtimes-ui.test.js`

Expected: FAIL. `TypeError: rtEntryFromForm is not a function` and `TypeError: rtEntryRow is not a function`. `ℹ fail 2` (the Task 7 UI tests still pass).

- [ ] **Step 3: Implement**

In `public/runtimesview.js`, replace:

```js
/* ---------- page-wide clicks ---------- */
```

with:

```js
/* ---------- Settings → Local models ---------- */
// The Settings form as an entry for /api/runtimes/save, or { error }. The command is one argument per line.
function rtEntryFromForm(f) {
  const v = (k) => String((f && f[k]) || '').trim();
  const id = v('id');
  if (!RT_ID_RE.test(id)) return { error: 'Id: 1 to 40 lowercase letters, digits or dashes.' };
  const command = String((f && f.command) || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!command.length) return { error: 'Command: one argument per line, starting with the program.' };
  const port = Number(v('port'));
  if (!v('port') || !Number.isInteger(port) || port < 1 || port > 65535)
    return { error: 'Port: a whole number from 1 to 65535.' };
  const entry = { id, command, port };
  if (v('name')) entry.name = v('name').slice(0, 60);
  if (v('health')) entry.health = v('health');
  return { entry };
}

// One owner entry in Settings: name, command, port, approval and its buttons.
function rtEntryRow(doc, e) {
  const row = rtEl(doc, 'div', 'rt-entry');
  row.setAttribute('data-rt-entry', e.id);
  const main = rtEl(doc, 'div', 'rt-entry-main');
  main.appendChild(rtEl(doc, 'b', '', rtText(e.name, 60) || e.id));
  main.appendChild(rtEl(doc, 'code', 'rt-cmd', (Array.isArray(e.command) ? e.command : []).join(' ').slice(0, 1000)));
  const port = Number.isInteger(e.port) ? ` · port ${e.port}` : '';
  main.appendChild(rtEl(doc, 'small', '', `${rtText(e.id, 40)}${port}${e.health ? ` · ${rtText(e.health, 200)}` : ''}`));
  if (e.error) main.appendChild(rtEl(doc, 'p', 'mon-msg bad', rtCap(rtText(e.error))));
  row.appendChild(main);
  const acts = rtEl(doc, 'div', 'mon-acts rt-entry-acts');
  acts.appendChild(rtEl(doc, 'span', `rt-approval ${e.approved ? 'good' : ''}`, e.approved ? 'Approved' : 'Not approved'));
  const btn = (act, label, cls = 'btn ghost mon-sm') => {
    const b = rtEl(doc, 'button', cls, label);
    b.type = 'button';
    b.setAttribute('data-rt-entry-act', act);
    acts.appendChild(b);
  };
  if (!e.approved && !e.error) btn('approve', 'Approve', 'btn mon-sm');
  btn('edit', 'Edit');
  btn('delete', 'Delete', 'btn ghost mon-sm danger');
  row.appendChild(acts);
  return row;
}

function runtimesSettingsShell() {
  return `<section class="card rt-settings" id="rt-settings" aria-labelledby="rt-set-title">
    <div class="card-head"><h3 id="rt-set-title">Local models</h3><span class="meta">your own model servers · Start and Stop in AI Office · stored in config.json</span></div>
    <p class="mon-desc">Ollama, LM Studio, llama.cpp server, Jan and LocalAI need nothing here. Add a server of your own, such as <code>llama-server</code> with a model file, then approve it: ZAAFPulse only starts a command you approved, and asks again after you edit it. The command runs without a shell.</p>
    <div class="rt-entries" id="rt-entries"><div class="skeleton" style="height:64px"></div></div>
    <form class="rt-form" id="rt-form" novalidate>
      <h4 id="rt-form-title">Add a runtime</h4>
      <div class="rt-form-grid">
        <label>Id<input class="input" name="id" maxlength="40" placeholder="qwen-local" autocomplete="off" spellcheck="false"></label>
        <label>Name<input class="input" name="name" maxlength="60" placeholder="Qwen (llama.cpp)"></label>
        <label>Port<input class="input" name="port" type="number" min="1" max="65535" step="1" placeholder="8081"></label>
        <label>Health URL <small>optional</small><input class="input" name="health" placeholder="http://127.0.0.1:8081/" autocomplete="off" spellcheck="false"></label>
        <label class="rt-wide">Command <small>one argument per line</small><textarea class="input mono" name="command" rows="5" spellcheck="false" placeholder="llama-server&#10;-m&#10;~/models/qwen.gguf&#10;--port&#10;8081"></textarea></label>
      </div>
      <input type="hidden" name="was">
      <div class="mon-acts"><button class="btn mon-sm" type="submit">Save</button><button class="btn ghost mon-sm" type="button" data-rt-cancel hidden>Cancel</button><span class="saved" id="rt-form-msg" role="status"></span></div>
    </form></section>`;
}

async function mountRuntimesSettings() {
  const sec = document.getElementById('rt-settings');
  if (!sec) return;
  const form = document.getElementById('rt-form');
  const S = { entries: [] };
  const say = (msg, bad = false) => {
    const out = document.getElementById('rt-form-msg');
    if (!out) return;
    out.textContent = msg;
    out.classList.toggle('bad', bad);
  };
  const paint = () => {
    const box = document.getElementById('rt-entries');
    if (!box) return;
    if (!S.entries.length) box.replaceChildren(rtEl(document, 'p', 'mon-note off', 'No runtimes of your own yet.'));
    else box.replaceChildren(...S.entries.map((e) => rtEntryRow(document, e)));
  };
  const reset = () => {
    form.reset();
    form.elements.was.value = '';
    document.getElementById('rt-form-title').textContent = 'Add a runtime';
    sec.querySelector('[data-rt-cancel]').hidden = true;
  };
  const load = async () => {
    try {
      S.entries = (await rtApi('/api/runtimes/config')).entries || [];
    } catch (e) {
      const box = document.getElementById('rt-entries');
      if (box) box.replaceChildren(rtEl(document, 'p', 'mon-msg bad', `Could not read the runtimes: ${rtErrorText(e)}`));
      return;
    }
    paint();
  };
  await load();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    const draft = rtEntryFromForm({
      id: f.id.value,
      name: f.name.value,
      command: f.command.value,
      port: f.port.value,
      health: f.health.value,
    });
    if (draft.error) return say(draft.error, true);
    say('Saving…');
    try {
      const body = { entry: draft.entry, ...(f.was.value ? { was: f.was.value } : {}) };
      S.entries = (await rtApi('/api/runtimes/save', body)).entries || [];
      paint();
      reset();
      say('Saved. Approve it before it can start.');
    } catch (e) {
      say(rtErrorText(e), true);
    }
  });

  sec.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-rt-cancel]')) return void (reset(), say(''));
    const b = ev.target.closest('[data-rt-entry-act]');
    const row = b && b.closest('[data-rt-entry]');
    if (!row) return;
    const e = S.entries.find((x) => x.id === row.dataset.rtEntry);
    if (!e) return;
    const act = b.dataset.rtEntryAct;
    if (act === 'edit') {
      const f = form.elements;
      f.id.value = e.id;
      f.name.value = e.name || '';
      f.port.value = Number.isInteger(e.port) ? String(e.port) : '';
      f.health.value = e.health || '';
      f.command.value = (e.command || []).join('\n');
      f.was.value = e.id;
      document.getElementById('rt-form-title').textContent = `Edit ${rtText(e.name, 60) || e.id}`;
      sec.querySelector('[data-rt-cancel]').hidden = false;
      say('');
      f.id.focus();
      return;
    }
    if (act === 'delete' && !confirm(`Delete ${rtText(e.name, 60) || e.id}? Its approval goes too.`)) return;
    if (
      act === 'approve' &&
      !confirm(`Approve this command?\n\n${(e.command || []).join(' ')}\n\nZAAFPulse runs exactly this, without a shell, when you press Start.`)
    )
      return;
    b.disabled = true;
    try {
      if (act === 'delete') S.entries = (await rtApi('/api/runtimes/delete', { id: e.id })).entries || [];
      if (act === 'approve') {
        await rtApi('/api/runtimes/approve', { id: e.id });
        await load();
      }
      paint();
      say(act === 'approve' ? `Approved ${rtText(e.name, 60) || e.id}. Start it from AI Office.` : 'Deleted.');
    } catch (err) {
      b.disabled = false;
      say(rtErrorText(err), true);
    }
  });
}

/* ---------- page-wide clicks ---------- */
```

In `public/runtimesview.js`, replace:

```js
    rtActionRow,
    rtCard,
  };
```

with:

```js
    rtActionRow,
    rtCard,
    rtEntryFromForm,
    rtEntryRow,
  };
```

In `public/app.js`, replace:

```js
  ${evalsSettingsShell()}
  ${monitorsSettingsShell()}
```

with:

```js
  ${evalsSettingsShell()}
  ${monitorsSettingsShell()}
  ${runtimesSettingsShell()}
```

In `public/app.js`, replace:

```js
  mountEvalsSettings();
  mountMonitorsSettings();
```

with:

```js
  mountEvalsSettings();
  mountMonitorsSettings();
  mountRuntimesSettings();
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/runtimes-settings-ui.test.js test/runtimes-ui.test.js`

Expected: PASS (`ℹ fail 0`).

Run: `npm test`

Expected: PASS (`ℹ fail 0`).

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/runtimesview.js test/runtimes-settings-ui.test.js
git commit -m "Add Settings → Local models for owner-defined runtimes"
```

---

### Task 9: Documentation

**Goal:** a user doc in the style of `docs/monitors.md` (short sections, tables, the safety rules spelled out), linked from the README's docs list and route table.

**Files**

- Create: `docs/local-models.md`
- Modify: `README.md` (the exact existing text to replace is quoted in Step 3)

**Interfaces**

- Consumes: the behaviour of Tasks 1 to 8 as built.
- Produces: `docs/local-models.md`; README links.

- [ ] **Step 1: Check there is no doc yet**

Run: `test -e docs/local-models.md && echo exists || echo missing`

Expected: `missing`.

- [ ] **Step 2: Write the doc and the links**

Create `docs/local-models.md`:

````markdown
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

A server counts as up when its URL answers within 1.5 seconds. LM Studio counts as running only while its URL answers, because its app stays open when the server is off.

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

## What Start does

1. The command runs without a shell, detached from ZAAFPulse, with its output in `.data/runtimes/<id>.log` (mode 0600). The log is rotated at 5 MB when the server starts, and one previous file is kept.
2. The pid and start time go to `.data/runtimes/started.json`, so the card can say "started here".
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
| `command` | the program and its arguments, one string each, at most 1,000 characters each. In Settings you type one argument per line. `~/` at the start of an argument is your home folder |
| `port` | 1 to 65535 |
| `health` | optional; `http://127.0.0.1:<port>/` when left out. Must be an `http://` URL on this machine |

An entry that is not valid is listed with the reason and cannot start.

**Approve before the first start.** An entry starts only after you press **Approve** in Settings. The approval is stored in `.data/runtimes/approved.json` as a hash of the command, so an edited command asks again. Deleting an entry deletes its approval. A command typed into `config.json` by hand also needs the approval in the dashboard.

Your entry's server is found by its program name and, when the command names the port, by that port too. Two `llama-server` entries on different ports are told apart.

## Safety

- The dashboard only ever sends a runtime's id. Commands come only from the presets and from your approved entries in `config.json`.
- The routes are behind the dashboard sign-in. Gateway API keys, MCP tools and A2A cannot reach them.
- Start and Stop are **off in server mode, with password sign-in and in Docker**, the same as agent control ([docs/monitors.md](monitors.md#where-control-is-off)). The cards then hide the buttons and say why.
- Stop checks the pid and start time the card was shown. If the server was restarted in between, the stop is refused with "the process changed; refresh".
- Every action, refused or not, is written to `.data/agent-audit.jsonl` with `kind: "runtime"`: the time, the action, the runtime id, the pid and start time, how it was stopped, and the result. It holds no command, path or log text.
- No error or log line the dashboard gets holds a file path. Settings shows your own commands with your home folder as `~`.

Demo mode shows synthetic runtimes. Its buttons change only what the page shows: nothing is started, stopped or saved.

## API

All routes are behind the dashboard sign-in. Writes need `Content-Type: application/json` (415 otherwise).

| Route | Body | Answer |
|---|---|---|
| `GET /api/runtimes` | | `[{ id, name, preset, installed, running, healthy, how, pid, startTime, children, port, canStart, canStop, reason, approved, error }]` |
| `POST /api/runtimes/start` | `{ id }` | `{ state: "running" }`, or `{ state: "starting", note, log }` |
| `POST /api/runtimes/stop` | `{ id, pid, startTime }` | `{ state: "stopped" }`, or `{ state: "stopping", note }` |
| `POST /api/runtimes/approve` | `{ id }` | `{ approved: true }` |
| `GET /api/runtimes/config` | | your entries for Settings: `{ entries: [{ id, name, command, port, health, approved, error }] }` |
| `POST /api/runtimes/save` | `{ entry, was? }` | the entries; `was` names the entry being edited |
| `POST /api/runtimes/delete` | `{ id }` | the entries |

Errors are `{ error }` with 400, 403, 404, 409 or 502. A failed start (502) also has `log`.

| Case | Status | Message |
|---|---|---|
| Unknown runtime | 404 | `unknown runtime` |
| Not installed | 409 | `not installed` |
| Already running, already stopped | 409 | `already running`, `already stopped` |
| The server was restarted since the card was drawn | 409 | `the process changed; refresh` |
| Your entry is not approved | 403 | `approve it in Settings first` |
| Server mode, password sign-in, Docker | 403 | `runtime control is off on this server`, `… in Docker` |
| The command could not start or exited with an error | 502 | a short message, with `log` |
| No answer within 30 seconds | 200 | `started, not answering yet` |

## Known limits

- **Linux and Windows service managers.** A systemd system unit is shown as "managed by the system" and is not stopped. On Linux, a server started while ZAAFPulse runs as a systemd user service lives in that service's cgroup, so restarting the service also stops the server.
- **The log is rotated only at start.** The server writes its own log while it runs, so a long run can grow past 5 MB until the next start.
- **One server per runtime.** When two servers of the same runtime run, the one started here is shown, otherwise the oldest.
- **Windows** has no parent pids in the process table here, so model processes are not counted toward their server.
````

In `README.md`, replace:

```markdown
docs/monitors.md       monitors, alerts, webhook, pausing an agent: rules, channels, limits, API
```

with:

```markdown
docs/monitors.md       monitors, alerts, webhook, pausing an agent: rules, channels, limits, API
docs/local-models.md   starting and stopping local model servers: runtimes, your own entries, safety, API
```

In `README.md`, replace:

```markdown
| `POST /api/rescan` | re-index changed log files now |
```

with:

```markdown
| `GET /api/runtimes` · `/api/runtimes/config` · `POST /api/runtimes/start` · `stop` · `approve` · `save` · `delete` | local model servers: Start and Stop in AI Office and your own runtimes in Settings; see [docs/local-models.md](docs/local-models.md#api) |
| `POST /api/rescan` | re-index changed log files now |
```

- [ ] **Step 3: Check the doc matches the code**

Run: `grep -c "localRuntimes\|agent-audit.jsonl\|SIGKILL\|approve it in Settings first" docs/local-models.md`

Expected: a count of at least 4.

Run: `npm test`

Expected: PASS (`ℹ fail 0`).

- [ ] **Step 4: Commit**

```bash
git add docs/local-models.md README.md
git commit -m "Document starting and stopping local model servers"
```

---

## Decisions where the spec leaves room

| Question | Decision |
|---|---|
| Settings needs to read, add, edit and delete owner entries; the spec's API table has no route for that | Three more routes behind the same sign-in: `GET /api/runtimes/config`, `POST /api/runtimes/save`, `POST /api/runtimes/delete` (Task 5). |
| "No path in any body" versus Settings showing the owner's own command | Errors and log lines never hold a path (`[path]`). Only `GET /api/runtimes/config` returns the owner's commands, with the home folder as `~`; `save` turns `~/` back into the home folder. |
| Where the approval hash is stored | `.data/runtimes/approved.json` (mode 0600), not `config.json`, so editing `config.json` by hand cannot approve a command. Deleting or renaming an entry forgets its approval. |
| LM Studio: the table says `how: app` → quit the app, the preset says `lms server stop` | A runtime's own stop command wins when its program is found; quitting the app is the fallback. LM Studio counts as running only while its health URL answers, because the app stays open without the server. |
| "Reported with it" for a server's children | The list carries `children` (a count). Children are never signalled. |
| Process rows had no parent pid | Task 1 adds `ppid` to the `ps` and `/proc` rows. Windows rows have none, so model processes are not grouped there (documented). |
| Two servers of one runtime | The one in `started.json` is shown, otherwise the oldest. |
| A Linux systemd unit | `how: 'system'`, no Stop button, a stop request is a 409 "managed by the system; stop it with systemctl". Only `/system.slice/*.service` counts; user units are processes. |
| Health URL of an owner entry | Optional, must be `http://` on 127.0.0.1, localhost or [::1], so the server never probes another host. |
| Approve while control is off | Refused (403) like Start and Stop, and audited. |
| Log rotation | Rotated at 5 MB when a server starts (the running server holds the file). |
| The 30 s and 10 s waits | Measured with a real timer, so a 1.5 s health request counts toward them. |
| Ollama with only `Ollama.app` (no `ollama` program found) | Start opens the app (`openApp`); Jan always starts that way. |

## Self-review

**Spec coverage**

| Spec item | Task |
|---|---|
| `lib/runtimes/registry.js`, entry fields, five presets with their start, stop and health | 2 |
| Owner entries in `config.json` "localRuntimes", validation (unique id, not a preset id, string array of at most 1,000 characters each, port 1 to 65535, default health URL), invalid entries listed with their reason | 2, 5 |
| Approval stored with a hash of the command; editing asks again | 2, 4, 8 |
| `lib/runtimes/state.js`: installed, running, healthy within 1.5 s, `how` (app, service via `homebrew.mxcl.<formula>`, zaafpulse via `started.json`, process) | 3 |
| A child (`llama-server`, runners) counts toward its server and is never signalled | 1, 3 |
| Start: refusals 404/409/409/403, detached spawn without a shell, log mode 0600 rotated at 5 MB, one previous file, pid and start time in `started.json`, health every 500 ms up to 30 s, `starting` with 20 masked log lines | 4 |
| Stop: 409 when not running or changed (`sameProcess`, 2 s), by `how`, never SIGKILL, `taskkill` without `/F`, 10 s wait, `stopped` / `stopping` | 4 |
| Dashboard sign-in only, not gateway keys, MCP or A2A | 6 |
| Off in server mode and Docker with the reason on the card | 4, 6, 7 |
| Every action audited to `agent-audit.jsonl` with `kind: 'runtime'` | 4, 6 |
| Commands only from presets and `config.json`; the dashboard sends an id | 4, 5 |
| API: four routes, shapes, errors 400/403/404/409/502 without a path, 415 without JSON | 5, 6 |
| UI: action row on Ollama and LM Studio cards, Stop note of how it runs, Start, Starting…/Stopping…, error and masked log as text | 7 |
| Stop confirmation text | 7 |
| Own cards for llama.cpp, Jan, LocalAI and owner entries, with status, port and buttons | 7 |
| Buttons hidden when control is off, the card says why | 7 |
| Settings → Local models: list, add, edit, delete, Approve | 8 |
| Demo mode: synthetic runtimes, simulated buttons | 6 |
| Error handling table | 4, 5 |
| Tests: registry, state from synthetic rows and fake PATH/app folders, control against a fake runtime, API, UI helpers and the `textContent` audit | 2, 3, 4, 5, 6, 7, 8 |
| Linux systemd unit reported as managed by the system and not stopped | 3, 4 |
| User docs | 9 |

**Placeholder scan.** Every code step holds the complete file or the exact replacement; there is no "TBD", "TODO", "similar to Task N" or "add error handling". Each modification quotes the current text verbatim from the branch base (`09bd76e` plus the spec commit).

**Name and type consistency.** `startOf` and `sameStart` (Task 3 exports) are used by `state.js`; `PATHLIKE` (Task 4 export) by `control.js` and `api.js`; `jsonFile`, `probe` (Task 3) by `control.js` and `server.js`; `createRuntimeState`, `createRuntimeControl`, `createRuntimeApi`, `runtimesDemo`, `entries` are wired in `server.js` with the names they are defined with; the browser globals `RT_CARD_IDS` and `rtMount` (Task 7) are used by `public/app.js` and `public/officeview.js`, and `runtimesSettingsShell` / `mountRuntimesSettings` (Task 8) by `public/app.js`. A state item's `startArgv`, `stopArgv`, `brewBin`, `how`, `pid`, `startTime`, `tableError` are the fields `control.js` reads; a control row's fields are the ones `api.js` copies and `runtimesview.js` reads.

**Verified before writing.** Every task was applied in order to a clean copy of this branch: each Step 2 failed with the message given, each Step 4 passed, and the full suite ended at 1,347 tests, 0 failures. The AI Office cards and Settings → Local models were rendered in demo mode in headless Chrome.
