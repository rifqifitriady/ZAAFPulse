// Pause, resume and stop a local AI agent process (Claude Code, Codex and the other apps in lib/processes APPS).
// A target is { pid, startTime }: every action reads the process table again and refuses when the pid is gone or now
// belongs to a process that started at another time (pid reuse), or is not an AI app. Pause is SIGSTOP, resume is
// SIGCONT, stop is SIGINT and then SIGTERM after a grace period if the same process is still alive. SIGKILL is never
// sent. Windows has no pause; stop there is `taskkill /PID n` without /F, so the app may still decline to close.
// Control is off in server mode and in Docker. Every action, refused or not, goes to the audit log.
// A refusal rejects with an Error carrying `status` (400 bad target, 403 not allowed, 409 process gone or changed,
// 501 not on this OS, 502 taskkill failed) and a short message that names no path.
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const realProcesses = require('../processes');
const { createAudit } = require('../audit');
const { runningPids } = require('../evals/claude-cli');
const { RULES } = require('../monitors/rules');

const GRACE_MS = 5000;
const POLL_MS = 100;
const SAME_START_MS = 2000; // start times come from an age in whole seconds, so they wobble by a second or so
const MAX_COMMAND = 300;
const TASKKILL_TIMEOUT_MS = 15e3;
const BY = new Set(['owner', 'rule']);
const AUTO_PAUSE = new Set(RULES.filter((r) => r.mayAutoPause).map((r) => r.id));

const fail = (status, message) => Object.assign(new Error(message), { status });
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flag = (v) => (typeof v === 'function' ? !!v() : !!v);
const sameStart = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= SAME_START_MS;

// Docker leaves /.dockerenv; other runtimes show in the init process's cgroups.
function detectDocker(fsLike = fs) {
  try {
    if (fsLike.existsSync('/.dockerenv')) return true;
  } catch {
    /* unreadable: look at the cgroups */
  }
  try {
    return /docker|containerd/.test(fsLike.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false; // not Linux, or no /proc
  }
}

function createAgentControl({
  processes = realProcesses,
  kill = (pid, signal) => process.kill(pid, signal),
  spawn = childProcess.spawn,
  platform = process.platform,
  now = Date.now,
  audit,
  dataDir,
  serverMode = false,
  inDocker,
  graceMs = GRACE_MS,
  pollMs = POLL_MS,
  sleep = sleepFor, // a real timer; the grace wait never reads `now`, so a fixed clock cannot hang stop
  log = () => {},
} = {}) {
  const auditLog = audit || (dataDir ? createAudit(path.join(dataDir, 'agent-audit.jsonl')) : { record() {} });
  let docker = inDocker;
  const inContainer = () => {
    if (docker === undefined) docker = detectDocker(); // read once, on first use
    return flag(docker);
  };
  const paused = new Map(); // pid -> what we paused and have not resumed (memory only)
  const win = platform === 'win32';
  const real = (p) => {
    let out;
    try {
      out = fs.realpathSync.native(p);
    } catch {
      out = path.resolve(p); // gone or unreadable: compare as written
    }
    return win ? out.toLowerCase() : out;
  };

  // The process table as agent rows: the APPS entry, a start time (ms, whole seconds) and the cwd if known.
  // ZAAFPulse itself and the judge's Claude Code calls are not agents, the same as on the live page.
  async function table() {
    const t = now();
    const skip = runningPids();
    return (await processes.rows()).map((r) => {
      const startTime = Number.isFinite(r.upSec) ? Math.round((t - r.upSec * 1000) / 1000) * 1000 : null;
      const app = realProcesses.isOwn(r, skip) ? null : realProcesses.APPS.find((a) => a.re.test(r.args)) || null;
      return { row: r, pid: r.pid, startTime, app };
    });
  }
  const agents = async () => (await table()).filter((p) => p.app);

  // The caller's `by` as given when valid; otherwise what was passed (text only, short), for the refusal's audit line.
  const byOf = (meta) => {
    const by = meta && meta.by;
    return BY.has(by) ? by : typeof by === 'string' ? by.slice(0, 32) : null;
  };

  function record(action, target, meta, extra) {
    const entry = {
      ts: now(),
      action,
      pid: target.pid,
      startTime: target.startTime,
      app: target.app || null,
      sessionId: (meta && meta.sessionId) || null,
      ...(meta && meta.rule ? { rule: meta.rule } : {}),
      by: byOf(meta),
      ...extra,
    };
    auditLog.record(entry);
  }

  // Every check before a signal. Resolves to the verified process, or audits the refusal and rejects with it.
  async function verify(action, target, meta) {
    const t = target && typeof target === 'object' ? target : {};
    const pid = Number.isInteger(t.pid) ? t.pid : null;
    const startTime = Number.isFinite(t.startTime) ? t.startTime : null;
    const by = meta && meta.by;
    const refuse = (status, message, app) => {
      record(action, { pid, startTime, app }, meta, { ok: false, status, error: message });
      return fail(status, message);
    };
    if (flag(serverMode)) throw refuse(403, 'agent control is off in server mode');
    if (inContainer()) throw refuse(403, 'agent control is off in Docker');
    if (!BY.has(by)) throw refuse(400, "by must be 'owner' or 'rule'");
    // pid 0, 1 and negative pids would signal a process group or init: never a target.
    if (!pid || pid <= 1 || startTime == null) throw refuse(400, 'a target needs a pid and a start time');
    // A rule may only pause, and only for the rules that allow it; it never resumes or stops.
    if (by === 'rule' && (action !== 'pause' || !AUTO_PAUSE.has(meta.rule)))
      throw refuse(403, 'a rule may only pause an agent');
    if (win && action !== 'stop') throw refuse(501, `${action} is not supported on Windows`);
    let list;
    try {
      list = await table();
    } catch (err) {
      log(`agent control: cannot read the process table: ${err.message}`);
      throw refuse(409, 'the process table could not be read');
    }
    const p = list.find((x) => x.pid === pid);
    if (!p) throw refuse(409, 'the process is gone');
    if (!sameStart(p.startTime, startTime)) throw refuse(409, 'the pid now belongs to another process');
    if (!p.app) throw refuse(403, 'not an AI agent process');
    return p;
  }

  // One signal; ESRCH (gone since the check) and EPERM (another user's process) become refusals. With `goneOk`, a
  // process that is already gone is not a refusal: the audit line says so and the result is false (nothing sent).
  function send(action, p, meta, signal, { goneOk = false } = {}) {
    try {
      kill(p.pid, signal);
    } catch (err) {
      const gone = !(err && err.code === 'EPERM');
      const [status, message] = gone ? [409, 'the process is gone'] : [403, 'not permitted to signal this process'];
      record(action, { ...p, app: p.app.id }, meta, { ok: false, status, error: message, signal });
      if (gone && goneOk) return false;
      throw fail(status, message);
    }
    record(action, { ...p, app: p.app.id }, meta, { ok: true, signal });
    return true;
  }

  const result = (action, p, extra) => ({
    ok: true,
    action,
    pid: p.pid,
    startTime: p.startTime,
    app: p.app.id,
    ...extra,
  });

  async function pause(target, meta = {}) {
    const p = await verify('pause', target, meta);
    send('pause', p, meta, 'SIGSTOP');
    paused.set(p.pid, {
      pid: p.pid,
      startTime: p.startTime,
      app: p.app.id,
      sessionId: meta.sessionId || null,
      by: meta.by,
      since: now(),
    });
    return result('pause', p);
  }

  async function resume(target, meta = {}) {
    const p = await verify('resume', target, meta);
    send('resume', p, meta, 'SIGCONT');
    paused.delete(p.pid);
    return result('resume', p);
  }

  // Still the same process: alive by kill(pid, 0) and with the same start time in a fresh read of the table.
  const alive = (pid) => {
    try {
      kill(pid, 0);
      return true;
    } catch (err) {
      return !!(err && err.code === 'EPERM'); // exists, but not ours to signal
    }
  };
  // true: the same process; false: gone, or the pid now belongs to another process; null: the table cannot be read.
  async function same(p) {
    if (!alive(p.pid)) return false;
    try {
      const q = (await table()).find((x) => x.pid === p.pid);
      return !!q && sameStart(q.startTime, p.startTime);
    } catch {
      return null; // cannot tell: do not escalate, and do not claim it exited
    }
  }

  function taskkill(pid) {
    return new Promise((resolve) => {
      let child;
      try {
        // No /F: Windows asks the app to close, as its window's close button would.
        child = spawn('taskkill', ['/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: TASKKILL_TIMEOUT_MS,
        });
      } catch (err) {
        return resolve({ code: null, error: err.message });
      }
      child.on('error', (err) => resolve({ code: null, error: err.message }));
      child.on('close', (code) => resolve({ code }));
    });
  }

  async function stop(target, meta = {}) {
    const p = await verify('stop', target, meta);
    if (win) {
      const { code, error } = await taskkill(p.pid);
      if (code !== 0) {
        const message = 'taskkill could not stop the process';
        log(`agent control: ${message} (${error || `exit ${code}`})`);
        record('stop', { ...p, app: p.app.id }, meta, { ok: false, status: 502, error: message });
        throw fail(502, message);
      }
      record('stop', { ...p, app: p.app.id }, meta, { ok: true, signal: 'taskkill' });
      return result('stop', p, { signal: 'taskkill', exited: null });
    }
    const wasPaused = paused.has(p.pid) || p.row.stopped === true;
    send('stop', p, meta, 'SIGINT');
    paused.delete(p.pid);
    // A stopped process keeps SIGINT pending until it runs again; it handles it first thing after SIGCONT. The
    // SIGCONT is a signal like any other, so it gets its own audit line (action resume, noted as part of the stop).
    if (wasPaused) {
      const entry = { ...p, app: p.app.id };
      try {
        kill(p.pid, 'SIGCONT');
        record('resume', entry, meta, { ok: true, signal: 'SIGCONT', note: 'continued so the stop can be handled' });
      } catch (err) {
        const error = err && err.code === 'EPERM' ? 'not permitted to signal this process' : 'the process is gone';
        record('resume', entry, meta, {
          ok: false,
          signal: 'SIGCONT',
          note: 'continued so the stop can be handled',
          error,
        });
      }
    }
    // The grace wait counts real timer steps, never `now`.
    const step = Math.max(1, pollMs);
    for (let left = graceMs; left > 0; left -= step) {
      await sleep(Math.min(step, left));
      if (!alive(p.pid)) return result('stop', p, { signal: 'SIGINT', exited: true });
    }
    const still = await same(p);
    if (still === null) return result('stop', p, { signal: 'SIGINT', exited: null });
    if (!still) return result('stop', p, { signal: 'SIGINT', exited: true });
    // Gone in the gap since the check: SIGINT worked, so the stop succeeded.
    if (!send('stop', p, meta, 'SIGTERM', { goneOk: true }))
      return result('stop', p, { signal: 'SIGINT', exited: true });
    return result('stop', p, { signal: 'SIGTERM', exited: false });
  }

  // Agent processes that could be writing a session: same working folder, started before its first line.
  async function candidates({ cwd, firstTs } = {}) {
    const first = typeof firstTs === 'number' ? firstTs : Date.parse(firstTs);
    if (typeof cwd !== 'string' || !cwd || !Number.isFinite(first)) return [];
    if (flag(serverMode) || inContainer()) return [];
    const want = real(cwd);
    let list;
    try {
      list = await agents();
    } catch (err) {
      log(`agent control: cannot read the process table: ${err.message}`);
      return [];
    }
    return list
      .filter(
        (p) => p.row.cwd && p.startTime != null && p.startTime < first + SAME_START_MS && real(p.row.cwd) === want,
      )
      .filter((p) => alive(p.pid))
      .map((p) => ({
        pid: p.pid,
        startTime: p.startTime,
        app: p.app.id,
        cwd: p.row.cwd,
        command: String(p.row.args).slice(0, MAX_COMMAND),
      }));
  }

  // What this server paused and has not resumed, while the process lives; after a restart, the agents the OS reports
  // as stopped (POSIX only). A process the OS reports as running again is dropped.
  async function listPaused() {
    let list;
    try {
      list = await agents();
    } catch {
      return [...paused.values()];
    }
    const out = [];
    for (const [pid, entry] of paused) {
      const p = list.find((x) => x.pid === pid);
      if (!p || !sameStart(p.startTime, entry.startTime) || p.row.stopped === false) paused.delete(pid);
      else out.push(entry);
    }
    for (const p of list) {
      if (p.row.stopped === true && !paused.has(p.pid))
        out.push({ pid: p.pid, startTime: p.startTime, app: p.app.id, sessionId: null, by: null, since: null });
    }
    return out;
  }

  return { candidates, pause, resume, stop, paused: listPaused };
}

module.exports = { createAgentControl, detectDocker, GRACE_MS, SAME_START_MS };
