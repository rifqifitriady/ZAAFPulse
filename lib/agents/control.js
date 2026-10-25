// Pause, resume and stop a local AI agent process (Claude Code, Codex and the other apps in lib/processes APPS).
// A target is { pid, startTime }: every action reads the process table again and refuses when the pid is gone or now
// belongs to a process that started at another time (pid reuse), or is not an AI app. Pause is SIGSTOP, resume is
// SIGCONT, stop is SIGINT and then SIGTERM after a grace period if the same process is still alive. SIGKILL is never
// sent. Windows has no pause; stop there is `taskkill /PID n` without /F, so the app may still decline to close.
// On POSIX the process must also run the agent's own program (isAgentBinary), unless this server paused it.
// Control is off in server mode and in Docker. Every action, refused or not, goes to the audit log.
// A refusal rejects with an Error carrying `status` (400 bad target, 403 not allowed, 409 process gone or changed,
// 501 not on this OS, 502 taskkill failed) and a short message that names no path.
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const realProcesses = require('../processes');
const { createAudit } = require('../audit');
const { runningPids } = require('../evals/claude-cli');
const { RULES, BUDGET_RULE } = require('../monitors/rules');

const GRACE_MS = 5000;
const POLL_MS = 100;
const SAME_START_MS = 2000; // start times come from an age in whole seconds, so they wobble by a second or so
const MAX_COMMAND = 300;
const TASKKILL_TIMEOUT_MS = 15e3;
const BY = new Set(['owner', 'rule']);
// The rules that may pause an agent: the fixed ones that allow it, and a cost budget set to pause (budgets replace the
// retired daily_cost). A budget is outside RULES, so it is named here on purpose; every check below still applies.
const AUTO_PAUSE = new Set([...RULES.filter((r) => r.mayAutoPause).map((r) => r.id), BUDGET_RULE.id]);

const fail = (status, message) => Object.assign(new Error(message), { status });
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flag = (v) => (typeof v === 'function' ? !!v() : !!v);
const sameStart = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= SAME_START_MS;
// One process, as the API and the dashboard tell them apart: the same pid and a start time within the tolerance.
const sameProcess = (a, b) => !!a && !!b && a.pid === b.pid && sameStart(a.startTime, b.startTime);
// A row's start time (ms, whole seconds) from its age at `t`; null when the table gave no age.
const startOf = (row, t) => (Number.isFinite(row.upSec) ? Math.round((t - row.upSec * 1000) / 1000) * 1000 : null);

// Linking a session to a process needs more than lib/processes' broad patterns, which count any command line with
// "codex" in it as Codex on the live page: the program itself (or the script node runs) must be the agent's own
// binary, so a dev server under ~/code/codex-clone, a ChatGPT helper or a launcher wrapper is never a candidate. The
// program comes from the row's argv (Linux /proc cmdline, macOS ps comm), never from splitting the command line on
// spaces: macOS paths such as "Application Support" hold one. A row without an argv is not a candidate.
// The names are exact on POSIX ("Codex (Renderer)" is a helper); only Windows' .exe is matched in any case.
const SCRIPT_HOST = /^(node|nodejs|bun|deno)(\.exe)?$/;
const AGENT_BIN = {
  claude: (prog, b) =>
    b === 'claude' || /^claude\.exe$/i.test(b) || /[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.m?js$/.test(prog),
  codex: (prog, b) =>
    b === 'codex' ||
    /^codex-(aarch64|x86_64)-[\w.-]+$/.test(b) ||
    /^codex\.exe$/i.test(b) ||
    /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/.test(prog),
};
// The APPS ids a session's process may carry: the Claude desktop app runs Claude Code from its own folder
// (.../claude-code/<version>/.../claude.app/Contents/MacOS/claude), which the live page counts as Claude Desktop.
const APPS_FOR = { claude: new Set(['claude', 'claude-desktop']), codex: new Set(['codex']) };
const baseName = (p) => String(p).split(/[\\/]/).pop();
// The executable, or the script when the executable is node (or bun, deno): its first argument that is not a flag.
function program(argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== 'string') return '';
  const exe = argv[0];
  if (!SCRIPT_HOST.test(baseName(exe))) return exe;
  return argv.slice(1).find((t) => typeof t === 'string' && t && !t.startsWith('-')) || exe;
}
const isAgentBinary = (source, argv) => {
  if (!Object.hasOwn(AGENT_BIN, source)) return false;
  const prog = program(argv);
  return !!prog && AGENT_BIN[source](prog, baseName(prog));
};

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
  // pid -> the start time first read for it. `ps` gives an age in whole seconds, so a start time computed afresh moves
  // by a second between reads; the first value is kept while later ones fall within the tolerance, so every reply
  // (candidates, the paused list, action results) names a process with one start time.
  let starts = new Map();
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
  // `{ cwds: false }` skips the working folders (lsof on macOS): only candidates() matches on them.
  async function table(opts) {
    const t = now();
    const skip = runningPids();
    const next = new Map(); // only the pids in this read, so ended processes drop out
    const out = (await processes.rows(opts)).map((r) => {
      let startTime = startOf(r, t);
      const known = starts.get(r.pid);
      if (sameStart(known, startTime)) startTime = known;
      if (startTime != null) next.set(r.pid, startTime);
      const app = realProcesses.isOwn(r, skip) ? null : realProcesses.APPS.find((a) => a.re.test(r.args)) || null;
      return { row: r, pid: r.pid, startTime, app };
    });
    starts = next;
    return out;
  }
  const agents = async (opts) => (await table(opts)).filter((p) => p.app);
  const LIGHT = { cwds: false };
  // The agent's own program (not a launcher or a helper of its app), read from argv. Windows rows have no argv, so
  // there only the APPS match counts.
  const ownProgram = (p) =>
    win || Object.keys(APPS_FOR).some((s) => APPS_FOR[s].has(p.app.id) && isAgentBinary(s, p.row.argv));
  // A process this server paused (same pid and start time) stays controllable even if its argv cannot be read now.
  const pausedHere = (p) => paused.has(p.pid) && sameStart(paused.get(p.pid).startTime, p.startTime);

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
      list = await table(LIGHT);
    } catch (err) {
      log(`agent control: cannot read the process table: ${err.message}`);
      throw refuse(409, 'the process table could not be read');
    }
    const p = list.find((x) => x.pid === pid);
    if (!p) throw refuse(409, 'the process is gone');
    if (!sameStart(p.startTime, startTime)) throw refuse(409, 'the pid now belongs to another process');
    if (!p.app) throw refuse(403, 'not an AI agent process');
    if (!ownProgram(p) && !pausedHere(p)) throw refuse(403, 'not an AI agent process', p.app.id);
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
  // true: the same process; false: gone, the pid now belongs to another process, or it runs another program (an exec
  // in place keeps the pid and start time); null: the table cannot be read. The program check is verify()'s, with
  // `wasPausedHere` standing in for pausedHere(), whose entry the stop has already removed.
  async function same(p, wasPausedHere) {
    if (!alive(p.pid)) return false;
    try {
      const q = (await table(LIGHT)).find((x) => x.pid === p.pid);
      return !!q && sameStart(q.startTime, p.startTime) && !!q.app && (ownProgram(q) || wasPausedHere);
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
    const wasPausedHere = pausedHere(p);
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
    const still = await same(p, wasPausedHere);
    if (still === null) return result('stop', p, { signal: 'SIGINT', exited: null });
    if (!still) return result('stop', p, { signal: 'SIGINT', exited: true });
    // Gone in the gap since the check: SIGINT worked, so the stop succeeded.
    if (!send('stop', p, meta, 'SIGTERM', { goneOk: true }))
      return result('stop', p, { signal: 'SIGINT', exited: true });
    return result('stop', p, { signal: 'SIGTERM', exited: false });
  }

  // Agent processes that could be writing a session: the session's own app (`source`, claude or codex) run from its
  // own binary (not a wrapper that launched it), in the same working folder, started before its first line.
  async function candidates({ cwd, firstTs, source } = {}) {
    const first = typeof firstTs === 'number' ? firstTs : Date.parse(firstTs);
    if (typeof cwd !== 'string' || !cwd || !Number.isFinite(first)) return [];
    if (!Object.hasOwn(APPS_FOR, source)) return [];
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
      .filter((p) => APPS_FOR[source].has(p.app.id) && isAgentBinary(source, p.row.argv))
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
  // as stopped (POSIX only) that verify() would accept, so no banner offers a wrapper or a helper. A process the OS
  // reports as running again is dropped.
  async function listPaused() {
    let list;
    try {
      list = await agents(LIGHT);
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
      if (p.row.stopped === true && !paused.has(p.pid) && ownProgram(p))
        out.push({ pid: p.pid, startTime: p.startTime, app: p.app.id, sessionId: null, by: null, since: null });
    }
    return out;
  }

  return { candidates, pause, resume, stop, paused: listPaused };
}

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
