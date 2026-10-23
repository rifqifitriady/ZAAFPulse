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
