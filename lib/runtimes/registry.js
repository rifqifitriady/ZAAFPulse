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

// A preset matches a row by its PROGRAM, never by a word somewhere in the arguments (`vim ~/dev/ollama serve`, `sudo
// ollama serve` and `tail -f llama-server.log` are not servers). The program is argv[0] when the row has argv; else the
// start of `args`, which `prog` (a regex source for the whole path, anchored here) must match from the first character:
// a path may hold spaces (`/Applications/LM Studio.app/...`) but no folder name ends in one, so `/usr/bin/vim /x/y`
// is not read as one path. `sub` says what the first argument after the program must be: a string, null for any, or
// a list of accepted values where '' stands for none.
const ROOT = String.raw`(?:[A-Za-z]:[\\/]|/)`;
// Folder names may hold spaces only inside an `.app` bundle path (DIRS). Elsewhere (SDIRS) they may not: a row without
// argv (macOS) cannot tell `/usr/bin/vim notes/ollama serve` from a program in a folder called `/usr/bin/vim notes`.
// Trade-off: a spaced non-app path without argv (`/Users/me/My Tools/bin/ollama serve` on macOS) does not match;
// rows with argv (Linux) still do, through `anyDirs` on argv[0].
const DIRS = String.raw`(?:[^\\/]*[^\s\\/][\\/])*`;
const SDIRS = String.raw`(?:[^\s\\/]+[\\/])*`;
const inDirs = (name) => String.raw`(?:${ROOT}${SDIRS}|)${name}`;
const anyDirs = (name) => String.raw`(?:${ROOT}${DIRS}|)${name}`;
// `prog` is read from the start of `args`; `argvProg` (default: the same) is the whole of argv[0], which is exact.
const byProgram = (prog, sub = null, argvProg = prog) => {
  const whole = new RegExp(`^(?:${argvProg})$`, 'i');
  const lead = new RegExp(`^(?:${prog})(?=\\s|$)`, 'i');
  const wanted = sub === null ? null : [].concat(sub);
  return (row) => {
    if (!row) return false;
    let rest;
    if (Array.isArray(row.argv) && typeof row.argv[0] === 'string') {
      if (!whole.test(row.argv[0])) return false;
      rest = row.argv.slice(1);
    } else {
      const args = String(row.args || '');
      const m = lead.exec(args);
      if (!m) return false;
      rest = args.slice(m[0].length).split(/\s+/).filter(Boolean);
    }
    return wanted === null || wanted.includes(rest[0] || '');
  };
};

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
    match: byProgram(inDirs('ollama(?:\\.exe)?'), 'serve', anyDirs('ollama(?:\\.exe)?')),
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
    match: byProgram(
      `${ROOT}${DIRS}LM Studio\\.app/Contents/MacOS/LM Studio|${ROOT}${DIRS}LM Studio\\.exe|${inDirs('llmster(?:\\.exe)?')}`,
      null,
      `${ROOT}${DIRS}LM Studio\\.app/Contents/MacOS/LM Studio|${ROOT}${DIRS}LM Studio\\.exe|${anyDirs('llmster(?:\\.exe)?')}`,
    ),
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
    match: byProgram(inDirs('llama-server(?:\\.exe)?'), null, anyDirs('llama-server(?:\\.exe)?')),
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
    match: byProgram(`${ROOT}${DIRS}Jan\\.app/Contents/MacOS/Jan`),
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
    match: byProgram(inDirs('local-ai(?:\\.exe)?'), ['', 'run'], anyDirs('local-ai(?:\\.exe)?')),
  },
].map((p) =>
  Object.freeze({
    ...p,
    start: p.start && Object.freeze([...p.start]), // shallow freeze would let `.start.push()` change the shared preset
    stop: p.stop && Object.freeze([...p.stop]),
    preset: true,
    command: null,
    error: null,
  }),
);
const PRESET_IDS = new Set(PRESETS.map((p) => p.id));

// The approval of an owner entry: a hash of what decides what runs and what is touched, so a change asks again.
// Given an entry (or its config.json object) that is the command, the port and the health URL (a stop targets the
// process on the port and a health probe reaches the URL). Given a bare command list it is that command alone.
function commandHash(x) {
  let data = x;
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    const port = Number.isInteger(x.port) ? x.port : null;
    const h = healthUrl(x.health, port);
    data = { command: x.command, port, health: h.url || String(x.health) };
  }
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

// An owner entry's server: a process run by the same program (its file name) that, when the command names the port,
// names it too, so two llama-server entries on different ports are told apart. An owner program with a space in its
// path only matches rows that carry argv (without argv the program is the first word of `args`).
function ownerMatch(command, port) {
  const prog = progName(command[0]);
  if (!prog) return () => false;
  const names = command.slice(1).some((a) => a === String(port) || a.endsWith(`=${port}`) || a.endsWith(`:${port}`));
  const portRe = new RegExp(`(^|[\\s=:])${port}(\\s|$)`);
  return (row) => {
    if (!row) return false;
    const args = String(row.args || '');
    const first = Array.isArray(row.argv) && typeof row.argv[0] === 'string' ? row.argv[0] : args.split(/\s+/)[0];
    return !!progName(first) && progName(first) === prog && (!names || portRe.test(args));
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
  if (typeof obj.id !== 'string' || !ID_RE.test(obj.id)) return bad('id must be 1 to 40 lowercase letters, digits or dashes');
  if (PRESET_IDS.has(id)) return bad(`${id} is the id of a preset`);
  if (seen.has(id)) return bad('another entry has the same id');
  const cmd = obj.command;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === 'string'))
    return bad('command must be a non-empty list of strings');
  if (cmd.some((a) => a.length > MAX_ARG)) return bad(`each argument of command must be at most ${MAX_ARG} characters`);
  if (cmd.some((a) => /[\0\r\n]/.test(a))) return bad('an argument of command cannot hold a line break or a NUL byte');
  if (!cmd[0].trim() || !progName(cmd[0])) return bad('command must start with a program');
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
