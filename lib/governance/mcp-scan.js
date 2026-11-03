// Governance inventory (AI Governance 3): the MCP servers configured in the AI clients' own files (spec I3), for every
// client scripts/register-mcp.js knows (the table is shared through lib/mcp-clients.js). Pure: the files come through
// `read`, the folders from `home`, `env` and `platform`. Per server only its name, the transport, the command's base
// name and the first package-looking argument, or the URL's origin: never env values, headers, other arguments or
// tokens. Project folders (Claude Code's per-project servers) come back as ~ paths, for the dashboard only.
const { clients, isOurs, toml } = require('../mcp-clients');

const MAX_NAME = 120;
const MAX_SERVERS = 500; // per client file
// An npm or PyPI name as it is typed after `npx -y` or `uvx`: lowercase, an optional @scope/, an optional @version.
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,100}(@(latest|next|\d[\d.]*(?:-[\w.]+)?))?$/;
// A token typed as a bare argument: a known key prefix, or a long run of letters and digits without a separator.
const TOKEN = /^(sk|pk|rk|ghp|gho|ghs|ghu|ghr|glpat|xox[abpr]|hf|npm|github_pat)[-_]|^(?=.*\d)[a-z0-9]{24,}$/;
// Transports that mean an HTTP server when an entry names no URL field this reader knows.
// A flag that takes a secret: the argument after it is never looked at.
const SECRET_FLAG = /^--?[\w-]*(key|token|secret|pass|auth|cred|bearer)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_TYPES = /^(https?|sse|streamable-?http)$/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Copies JSON text, letting `step(s, i)` replace what starts at i ({ text, next }) or keep it (null). Strings are
// copied whole and never looked into, so a "//" or ",}" inside one stays.
function walkJson(s, step) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
      continue;
    }
    const r = step(s, i);
    if (r) {
      out += r.text;
      i = r.next - 1;
    } else out += s[i];
  }
  return out;
}

const CLOSES = /\s*[}\]]/y;
// JSON with comments and trailing commas (VS Code, Zed and Gemini CLI allow both): a comment becomes a space, a comma
// right before } or ] goes. A UTF-8 BOM is dropped; an empty file is {}. Throws on anything else that is not JSON.
function parseJsonc(src) {
  let s = String(src == null ? '' : src);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const bare = walkJson(s, (t, i) => {
    if (t[i] !== '/') return null;
    if (t[i + 1] === '/') {
      const end = t.indexOf('\n', i);
      return { text: ' ', next: end < 0 ? t.length : end };
    }
    if (t[i + 1] === '*') {
      const end = t.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('a comment is not closed');
      return { text: ' ', next: end + 2 };
    }
    return null;
  });
  const clean = walkJson(bare, (t, i) => {
    if (t[i] !== ',') return null;
    CLOSES.lastIndex = i + 1;
    return CLOSES.test(t) ? { text: '', next: i + 1 } : null;
  });
  if (!clean.trim()) return {};
  const v = JSON.parse(clean);
  return v === null ? {} : v;
}

// A client's JSON file: plain JSON first (Claude Code's file can be large), JSONC when that fails. An object or an
// error.
function parseConfig(text) {
  const s = String(text).replace(/^\ufeff/, '');
  let v;
  try {
    v = s.trim() ? JSON.parse(s) : {};
  } catch {
    v = parseJsonc(s);
  }
  if (v === null) return {};
  if (!isObj(v)) throw new Error('not a JSON object');
  return v;
}

// The program's base name: "npx" from "npx -y …", "node.exe" from "C:\Program Files\nodejs\node.exe". Anything that
// is not a plain file name (it may hold more than the program) is null.
function commandOf(c) {
  if (typeof c !== 'string' || !c.trim()) return null;
  const s = c.trim();
  const [first, ...rest] = s.split(/\s+/);
  let base = first;
  // Only a first word with a separator can be the start of a path with spaces ("C:\Program Files\x.exe"). An argument
  // right after it (a dash or a URL) ends the program; anything else that looks like a path or an argument is
  // ambiguous, so nothing is kept.
  if (/[\\/]/.test(first) && rest.length && !/^-|:\/\//.test(rest[0])) {
    if (rest.some((w) => /^([\\/~]|[A-Za-z]:)/.test(w)) || /\s-|:\/\//.test(s)) return null;
    base = s;
  }
  base = base.split(/[\\/]/).pop();
  return /^[\w.+-]{1,60}$/.test(base) ? base : null;
}

// The first argument that looks like a package name and not like a token: "@scope/pkg" from npx -y @scope/pkg.
function packageOf(args) {
  let skip = false;
  for (const a of Array.isArray(args) ? args : []) {
    if (typeof a !== 'string') continue;
    const s = a.trim();
    if (skip) {
      skip = false;
      continue;
    }
    if (!s) continue;
    if (s.startsWith('-')) {
      skip = SECRET_FLAG.test(s) && !s.includes('=');
      continue;
    }
    if (PACKAGE.test(s) && !tokenLike(s)) return s;
  }
  return null;
}
const tokenLike = (s) =>
  TOKEN.test(s) || UUID.test(s) || (s.match(/[a-z0-9]{20,}/gi) || []).some((run) => /\d/.test(run));

// A URL's scheme, host and port; a path, a query, a user name or a password never come along.
function originOf(url) {
  try {
    const u = new URL(String(url).trim());
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

// One server entry as the inventory may keep it.
function serverOf(name, raw, project) {
  const v = isObj(raw) ? raw : {};
  const cmd = isObj(v.command) ? v.command : null; // Zed's older form: "command": { "path", "args" }
  const command = typeof v.command === 'string' ? v.command : cmd && typeof cmd.path === 'string' ? cmd.path : null;
  const args = Array.isArray(v.args) ? v.args : cmd && Array.isArray(cmd.args) ? cmd.args : [];
  const url = [v.url, v.serverUrl, v.httpUrl].find((u) => typeof u === 'string' && u.trim());
  const http = !!url || (!command && HTTP_TYPES.test(String(v.type || v.transport || '')));
  return {
    name: String(name).slice(0, MAX_NAME),
    transport: http ? 'http' : 'stdio',
    command: http ? null : commandOf(command),
    package: http ? null : packageOf(args),
    origin: url ? originOf(url) : null,
    ours: !http && isOurs({ command: command || '', args: args.filter((a) => typeof a === 'string') }),
    ...(project ? { project } : {}),
  };
}

// Codex CLI's [mcp_servers.<name>] tables. Servers written as dotted keys or an inline table cannot be read here: the
// file then counts as unreadable rather than leaving them out.
function codexServers(text) {
  const s = String(text).replace(/^\ufeff/, '');
  const tables = toml.tables(s);
  // Only the root section (before the first table) can hold a dotted mcp_servers key of its own.
  const root = tables.length ? s.slice(0, tables[0].start) : s;
  if (/^[ \t]*mcp_servers[ \t]*[.=]/m.test(root)) throw new Error('mcp_servers as dotted keys or an inline table');
  const names = [];
  tables.forEach((t, n) => {
    // [mcp_servers] itself holding a key is a server written inline or dotted.
    if (t.key.length === 1 && t.key[0] === 'mcp_servers') {
      const body = s.slice(t.body, n + 1 < tables.length ? tables[n + 1].start : s.length);
      if (body.split(/\r?\n/).some((ln) => ln.trim() && !ln.trim().startsWith('#')))
        throw new Error('mcp_servers keys');
    }
  });
  for (const t of tables)
    if (t.key[0] === 'mcp_servers' && t.key.length >= 2 && !names.includes(t.key[1])) names.push(t.key[1]);
  return names.map((n) => {
    const { value } = toml.find(s, n);
    if (value === null) throw new Error('a server table that cannot be read');
    return serverOf(n, value);
  });
}

// A folder as the owner's dashboard shows it: the home folder as ~ (Windows: either slash, any case).
function tildeOf(home, platform) {
  // Same length as the input, so a cut made on the folded text fits the original (no toLowerCase on "İ").
  const norm = (x) =>
    platform === 'win32'
      ? x.replace(/\\/g, '/').replace(/[^]/g, (ch) => (ch.toLowerCase().length === 1 ? ch.toLowerCase() : ch))
      : x;
  const h = home ? norm(String(home)).replace(/\/+$/, '') : '';
  return (p) => {
    const s = String(p);
    if (!h) return s;
    const n = norm(s);
    if (n === h) return '~';
    return n.startsWith(`${h}/`) ? `~${s.slice(h.length)}` : s;
  };
}

function serversIn(c, text, tilde) {
  if (c.kind === 'codex') return codexServers(text);
  const data = parseConfig(text);
  const key = c.key || 'mcpServers';
  const list = [];
  const top = data[key];
  if (top != null && !isObj(top)) throw new Error(`"${key}" is not an object`);
  for (const [n, e] of Object.entries(top || {})) list.push(serverOf(n, e));
  // Claude Code also keeps servers per project folder (local scope) in the same file.
  if (c.kind === 'claude' && isObj(data.projects))
    for (const [folder, p] of Object.entries(data.projects))
      if (isObj(p) && isObj(p.mcpServers))
        for (const [n, e] of Object.entries(p.mcpServers)) list.push(serverOf(n, e, tilde(folder)));
  return list;
}

// Every client whose file is there: { client, name, file (a ~ path), state: 'ok' | 'unreadable', servers }. A file
// that is missing is left out; one that cannot be read or parsed is 'unreadable', with no servers, and the other
// clients are still listed. read(file) returns the text, null when the file does not exist, or throws.
function scanClients({ home, env = {}, platform = process.platform, read } = {}) {
  const tilde = tildeOf(home, platform);
  const out = [];
  for (const [id, c] of Object.entries(clients(home, { env, platform }))) {
    const row = { client: id, name: c.name, file: tilde(c.file) };
    let text;
    try {
      text = read(c.file);
    } catch {
      out.push({ ...row, state: 'unreadable', servers: [] });
      continue;
    }
    if (text == null) continue;
    try {
      out.push({ ...row, state: 'ok', servers: serversIn(c, text, tilde).slice(0, MAX_SERVERS) });
    } catch {
      out.push({ ...row, state: 'unreadable', servers: [] });
    }
  }
  return out;
}

module.exports = { scanClients, parseJsonc, parseConfig, serverOf, commandOf, packageOf, originOf };
