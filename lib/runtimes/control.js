// Start and stop the local model servers and the desktop apps (lib/runtimes/registry.js). The dashboard sends only an
// id, and to stop also the pid and start time it was shown; every command comes from a preset or from an owner entry in
// config.json that the owner approved, and runs without a shell. A started server is detached (its own session, output
// to .data/runtimes/<id>.log), so it outlives a ZAAFPulse restart. Stop follows how the server runs: the runtime's own
// stop command, quitting its app, `brew services stop`, or SIGINT and then SIGTERM after 5 s (taskkill without /F on
// Windows); SIGKILL is never sent to a model server. A desktop app (kind 'app', macOS only) is opened with `open -a`
// and quit like ⌘Q; one still there 10 s later gets SIGTERM, and one still there 5 s after that SIGKILL, each only
// after the process was read again with the same pid and start time. Control is off in server mode, with password
// sign-in, without sign-in and in Docker (as agent control is), and every action, refused or not, is written to
// agent-audit.jsonl with kind 'runtime'. A refusal rejects with an Error carrying `status` (400, 403, 404, 409 or 502)
// and a message that names no path; a failed start also carries the masked log lines (`log`). With a model memory
// (lib/runtimes/models.js), Ollama and LM Studio get back the models they last had loaded: a Start that answers loads
// them again in the background, and a Stop first reads what is loaded so the list is fresh.
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
const OBSERVE_TIMEOUT_MS = 3000; // the read of the loaded models before a stop waits no longer than this
// A desktop app: how long Start waits for its main process, and Stop for it to end after the quit, SIGTERM and SIGKILL.
const APP_OPEN_WAIT_MS = 15000;
const APP_QUIT_WAIT_MS = 10000;
const APP_TERM_WAIT_MS = 5000;
const APP_KILL_WAIT_MS = 3000;
const MAC_ONLY = 'macOS only';
const MAX_LOG = 5 * 1024 * 1024; // a log is rotated at this size when its server starts; one previous file is kept
const LOG_LINES = 20;
const LOG_READ = 64 * 1024; // how much of the end of a log is read for its last lines
const OFF_TEXT = {
  server: 'runtime control is off on this server',
  'no-sign-in': 'runtime control is off because this dashboard runs without sign-in',
  docker: 'runtime control is off in Docker',
};
const MANAGED = 'managed by the system; stop it with systemctl';
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0; // a log that is a symlink is never written or read through
const NONBLOCK = fs.constants.O_NONBLOCK || 0; // a FIFO at the log path must not block the open
const NEEDS_APPROVAL = 'approve it in Settings first';
const NEEDS_ENTRY = 'add it in Settings → Local models with a model path';

const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The runtime's environment: ours without the ZAAFPULSE_* settings (tokens and the like), so it inherits PATH, HOME, etc.
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ZAAFPULSE_/i.test(k)));
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
  serverMode = false, // false, or why control is off: 'no-sign-in', or anything else true for 'server'
  inDocker,
  graceMs = GRACE_MS,
  stopWaitMs = STOP_WAIT_MS,
  healthWaitMs = HEALTH_WAIT_MS,
  pollMs = POLL_MS,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  models = null, // lib/runtimes/models.js createModelMemory(); without it nothing is read or loaded again
  observeTimeoutMs = OBSERVE_TIMEOUT_MS,
  appOpenWaitMs = APP_OPEN_WAIT_MS,
  appQuitWaitMs = APP_QUIT_WAIT_MS,
  appTermWaitMs = APP_TERM_WAIT_MS,
  appKillWaitMs = APP_KILL_WAIT_MS,
  log = () => {},
} = {}) {
  const dir = path.join(dataDir || '.', 'runtimes');
  const startedFile = started || jsonFile(path.join(dir, 'started.json'));
  const approvedFile = approvals || jsonFile(path.join(dir, 'approved.json'));
  const auditLog = audit || (dataDir ? createAudit(path.join(dataDir, 'agent-audit.jsonl')) : { record() {} });
  const win = platform === 'win32';
  // A desktop app is opened and quit with macOS commands: elsewhere it cannot be controlled.
  const appElsewhere = (e) => e.kind === 'app' && platform !== 'darwin';
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  let docker = inDocker;
  // Why control is off here ('server', 'no-sign-in' or 'docker'), or null when it is on.
  const offReason = () => {
    const mode = typeof serverMode === 'function' ? serverMode() : serverMode;
    if (mode) return mode === 'no-sign-in' ? 'no-sign-in' : 'server';
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

  const approved = (e) => {
    if (e.preset) return true;
    const all = approvedFile.read();
    return !e.error && Object.hasOwn(all, e.id) && all[e.id] === commandHash(e);
  };
  const logFile = (id) => path.join(dir, `${id}.log`);

  // The last lines of a runtime's log, masked; [] when there is none. Only a regular file with one name is opened:
  // on Windows there is no O_NOFOLLOW, and a FIFO would block the open.
  function logTail(id) {
    let text = '';
    let fd;
    try {
      const file = logFile(id);
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.nlink > 1) return [];
      fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW | NONBLOCK);
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink > 1) return [];
      const size = st.size;
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
    let st = null;
    try {
      st = fs.lstatSync(file);
    } catch {
      /* no log yet */
    }
    // A hard link is another name for something outside the log folder, so it is refused like a symlink.
    if (st && (!st.isFile() || st.nlink > 1))
      throw Object.assign(new Error('log file is not a regular file'), { notFile: true });
    if (st && st.size > MAX_LOG) {
      try {
        fs.renameSync(file, `${file}.1`);
      } catch {
        /* keep appending */
      }
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    try {
      fs.fchmodSync(fd, 0o600); // a log made by an older version keeps no wider mode
    } catch {
      /* not ours to change */
    }
    return fd;
  }

  // A fixed command (a stop command, osascript, brew, taskkill), no shell, output ignored.
  function run(argv) {
    return new Promise((done) => {
      let timer = null;
      let child;
      const resolve = (v) => {
        clearTimeout(timer);
        done(v);
      };
      try {
        child = spawn(argv[0], argv.slice(1), {
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
          timeout: commandTimeoutMs, // the same value as the timer below
          env: childEnv(),
        });
      } catch (err) {
        return resolve({ code: null, error: err.message });
      }
      // Independent of spawn's own timeout: a child that ignores SIGTERM cannot hang the request.
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* gone */
        }
        resolve({ code: null, error: 'timed out' });
      }, commandTimeoutMs);
      child.on('error', (err) => resolve({ code: null, error: err.message }));
      child.on('close', (code) => resolve({ code }));
    });
  }

  // Whether the model memory covers this entry: the Ollama and LM Studio presets, never an owner entry.
  const remembers = (e) => !!models && !!e && e.preset === true && models.supports(e.id);

  // The models part of a runtime's row. What is loading, loaded or failed counts only while the server runs.
  function modelsView(x) {
    if (!remembers(x.entry)) return null;
    const st = x.running ? models.status(x.entry.id) : null;
    return {
      remembered: models.remembered(x.entry.id),
      loading: !!(st && st.loading),
      loaded: st ? st.loaded : [],
      failed: st ? st.failed : [],
      // What it has loaded now, from the last read (null when unknown): the topology draws these as in use.
      current: x.running && typeof models.current === 'function' ? models.current(x.entry.id) : null,
    };
  }

  // Reads the loaded models before a stop, so Start loads the same ones. It waits at most observeTimeoutMs, and a
  // failure is only logged: the stop goes on either way.
  async function observeBeforeStop(x) {
    let timer;
    const read = Promise.resolve()
      .then(() => models.observe(x))
      .catch(() => log(`runtimes: the loaded models of ${x.entry.id} could not be read`));
    try {
      await Promise.race([read, new Promise((resolve) => (timer = setTimeout(resolve, observeTimeoutMs)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  // After a start that answered: load the remembered models again, using the item as it is now (bin and port).
  // Resolves to the names being loaded; a failure here never fails the start.
  async function reloadAfterStart(id) {
    try {
      const y = await state.one(id);
      if (!y || !remembers(y.entry)) return [];
      const names = models.reload(y);
      return Array.isArray(names) ? names : [];
    } catch {
      log(`runtimes: the models of ${id} could not be loaded again`);
      return [];
    }
  }

  // The memory's onDone: one audit line per reload, with counts only (never a model name).
  function reloaded(id, result) {
    const r = result && typeof result === 'object' ? result : {};
    const loaded = Array.isArray(r.loaded) ? r.loaded.length : 0;
    const failed = Array.isArray(r.failed) ? r.failed.length : 0;
    record('reload', id, { ok: failed === 0, loaded, failed, ...(r.cancelled ? { cancelled: true } : {}) });
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
    else if (appElsewhere(e)) reason = MAC_ONLY;
    else if (e.error) reason = e.error;
    else if (x.tableError) reason = x.tableError;
    else if (x.running) {
      if (x.how === 'system') reason = MANAGED;
      else if (!x.pid) reason = 'the server process was not found';
      else if (!ok) reason = NEEDS_APPROVAL; // an unapproved owner entry is not stopped from here either
    }
    else if (!x.installed) reason = 'not installed';
    else if (!x.startArgv) reason = e.id === 'llamacpp' ? NEEDS_ENTRY : 'this runtime has no start command';
    else if (!ok) reason = NEEDS_APPROVAL;
    return {
      id: e.id,
      name: e.name,
      kind: e.kind === 'app' ? 'app' : 'server',
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
      models: modelsView(x),
    };
  }

  // Every runtime that is installed, running, or one of the owner's entries; off macOS also the desktop apps, so their
  // cards can say why there is no button.
  async function list() {
    const off = offReason();
    return (await state.list())
      .filter((x) => x.installed || x.running || !x.entry.preset || appElsewhere(x.entry))
      .map((x) => view(x, off));
  }

  // One start or stop per id at a time; anything unexpected is audited (status 500) before it is rethrown.
  const busy = new Map();
  const audited = (action, idOf, fn, exclusive = true) => async (arg) => {
    const id = idOf(arg);
    const key = typeof id === 'string' ? id : null;
    if (exclusive && key !== null && busy.has(key)) {
      const message = `a ${busy.get(key)} is still in progress; try again shortly`;
      record(action, id, { ok: false, status: 409, error: message });
      throw fail(409, message);
    }
    if (exclusive && key !== null) busy.set(key, action);
    try {
      return await fn(arg);
    } catch (err) {
      if (!err || !err.status) record(action, id, { ok: false, status: 500, error: 'internal error' });
      throw err;
    } finally {
      if (exclusive && key !== null) busy.delete(key);
    }
  };

  async function startNow(id) {
    const refuse = (status, message, extra = {}) => {
      record('start', id, { ok: false, status, error: message });
      return fail(status, message, extra);
    };
    const off = offReason();
    if (off) throw refuse(403, OFF_TEXT[off]);
    const x = await find(id);
    if (!x) throw refuse(404, 'unknown runtime');
    const e = x.entry;
    if (appElsewhere(e)) throw refuse(409, MAC_ONLY);
    if (e.error) throw refuse(409, `the entry is not valid: ${e.error}`);
    if (!x.installed) throw refuse(409, 'not installed');
    if (x.running) throw refuse(409, 'already running');
    if (!approved(e)) throw refuse(403, NEEDS_APPROVAL);
    if (!x.startArgv) throw refuse(409, e.id === 'llamacpp' ? NEEDS_ENTRY : 'this runtime has no start command');
    const argv = x.startArgv;
    let fd;
    try {
      fd = openLog(e.id);
    } catch (err) {
      log(`runtimes: cannot open the log of ${e.id}: ${err.message}`);
      throw refuse(502, err.notFile ? 'log file is not a regular file' : 'the log file could not be opened');
    }
    let child = null;
    let spawnError = null;
    try {
      child = spawn(argv[0], argv.slice(1), {
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: dataDir,
        env: childEnv(),
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
    // Only a process that is the server itself is recorded: not `open -a`, nor a runtime's own launcher (it has a stop command).
    const direct = argv[0] !== '/usr/bin/open' && !x.stopArgv;
    const unrecord = () => {
      try {
        const m = startedFile.read();
        if (m[e.id]) {
          delete m[e.id];
          startedFile.write(m);
        }
      } catch {
        /* checked by pid and start time anyway */
      }
    };
    if (direct) {
      try {
        const mine = startedFile.read();
        mine[e.id] = { pid: child.pid, startTime };
        startedFile.write(mine);
      } catch (err) {
        log(`runtimes: cannot record ${e.id}: ${err.message}`);
      }
    }
    record('start', e.id, { ok: true, pid: child.pid, startTime });
    // The health URL, every 500 ms for up to 30 s; for a desktop app, its main process for up to 15 s. A launcher that
    // exits 0 (lms, open) is not a failure.
    const isApp = e.kind === 'app';
    const appOpen = async () => {
      try {
        const y = await state.one(e.id);
        return !!y && y.running;
      } catch {
        return false;
      }
    };
    const answers = () => (isApp ? appOpen() : probe(e.health));
    const failed = () => exit.done && exit.code !== 0;
    const up = await waitFor(async () => (await answers()) || failed(), isApp ? appOpenWaitMs : healthWaitMs);
    if (up && failed() && !(await answers())) {
      const message = exit.code === null ? 'the command was stopped' : `the command exited with code ${exit.code}`;
      record('start', e.id, { ok: false, status: 502, error: message, pid: child.pid, startTime });
      unrecord();
      throw fail(502, message, { log: logTail(e.id) });
    }
    if (up) {
      const names = remembers(e) ? await reloadAfterStart(e.id) : [];
      return names.length ? { state: 'running', reloading: names } : { state: 'running' };
    }
    if (isApp) return { state: 'starting', note: 'opening, not up yet' };
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

  async function stopNow(target) {
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
    if (appElsewhere(e)) throw refuse(409, MAC_ONLY);
    if (!approved(e)) throw refuse(403, NEEDS_APPROVAL); // the same gate as Start: an owner entry only runs approved
    if (!x.running || !x.pid) throw refuse(409, 'already stopped');
    if (!sameProcess({ pid: x.pid, startTime: x.startTime }, { pid, startTime }))
      throw refuse(409, 'the process changed; refresh');
    if (x.how === 'system') throw refuse(409, MANAGED);
    if (e.kind === 'app') return stopApp(x, pid, startTime);
    const how = x.how;
    if (remembers(e)) {
      await observeBeforeStop(x);
      models.cancel(e.id); // a reload still running loads nothing more
    }
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
    else if (win) [method, cmd] = ['taskkill', [taskkill, '/PID', String(pid)]]; // no /F: the app is asked to close
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

  // A desktop app: quit it as ⌘Q does; if its main process is still there after appQuitWaitMs, SIGTERM, and if it is
  // still there appTermWaitMs later, SIGKILL. This is the only place SIGKILL is sent. Before each signal the process is
  // read again: gone, or another pid or start time, is stopped; a table that cannot be read sends nothing.
  async function stopApp(x, pid, startTime) {
    const e = x.entry;
    const line = (extra) => record('stop', e.id, { pid, startTime, how: x.how, ...extra });
    const gone = () => !alive(pid);
    // The name of the bundle the process runs from (Kiro.app or Kiro CLI.app), from the registry: never a path.
    const bundle = x.appBundle || [].concat(e.app || [])[0];
    const r = await run(['/usr/bin/osascript', '-e', `quit app "${bundle.replace(/\.app$/, '')}"`]);
    // A quit that fails (the app said no, or ZAAFPulse may not send it Apple events) still leads to the signals below.
    if (r.code === 0) line({ ok: true, method: 'app' });
    else {
      log(`runtimes: quitting ${e.id} failed (${r.error || `exit ${r.code}`})`);
      line({ ok: false, method: 'app', error: 'the quit command failed' });
    }
    if (await waitFor(gone, appQuitWaitMs)) return finish(e.id, true);
    for (const [signal, waitMs] of [
      ['SIGTERM', appTermWaitMs],
      ['SIGKILL', appKillWaitMs],
    ]) {
      let y = null;
      try {
        y = await state.one(e.id);
      } catch {
        return finish(e.id, false); // cannot tell: no signal, and no claim that it ended
      }
      if (y && y.tableError) return finish(e.id, false);
      if (!y || !y.running || !sameProcess({ pid: y.pid, startTime: y.startTime }, { pid, startTime }))
        return finish(e.id, true); // gone; the pid may be another's now
      try {
        kill(pid, signal);
      } catch (err) {
        if (err && err.code === 'EPERM') {
          line({ ok: false, status: 403, error: 'not permitted to signal this process', method: 'signal', signal });
          return finish(e.id, false);
        }
        return finish(e.id, true); // gone in the gap
      }
      line({ ok: true, method: 'signal', signal, forced: true });
      if (await waitFor(gone, waitMs)) return finish(e.id, true);
    }
    return finish(e.id, false);
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
  async function approveNow(id) {
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

  const start = audited('start', (id) => id, startNow);
  const stop = audited('stop', (t) => t && t.id, stopNow);
  const approve = audited('approve', (id) => id, approveNow, false);

  // `record` lets the Settings routes (save, delete) write their audit lines to the same log.
  // `reloaded` is the model memory's onDone (server.js passes it on), so its audit line is written here like the rest.
  return { list, start, stop, approve, forget, approved, offReason, logTail, record, reloaded };
}

module.exports = {
  createRuntimeControl,
  cleanLine,
  OFF_TEXT,
  HEALTH_WAIT_MS,
  STOP_WAIT_MS,
  POLL_MS,
  OBSERVE_TIMEOUT_MS,
  APP_OPEN_WAIT_MS,
  APP_QUIT_WAIT_MS,
  APP_TERM_WAIT_MS,
  APP_KILL_WAIT_MS,
};
