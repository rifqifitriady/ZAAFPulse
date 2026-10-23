// Where Claude Code and Codex send their model calls: the base URL each one is configured with, reduced to its
// origin (protocol, host and port). The path, query and any credentials in the URL are dropped here and never kept.
// The origin stays on the server: the topology only learns whether a tool goes to the gateway, a router or direct.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { configDir } = require('./claude');
const codex = require('./codex');

// protocol//host:port of an http(s) URL, or null. URL.origin leaves out user, password, path, query and hash.
function originOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// Claude Code: env.ANTHROPIC_BASE_URL in <config dir>/settings.json (CLAUDE_CONFIG_DIR, else ~/.claude).
function claudeRoute(dir) {
  const text = read(path.join(dir, 'settings.json'));
  if (text === null) return null;
  try {
    const j = JSON.parse(text.replace(/^\uFEFF/, ''));
    return originOf(j && j.env && j.env.ANTHROPIC_BASE_URL);
  } catch {
    return null;
  }
}

// Codex: the top-level model_provider of config.toml, then base_url in its [model_providers.<name>] table. Read
// line by line with regexes; only the two keys matter, so no TOML parser is needed.
const count = (s, ch) => s.split(ch).length - 1;
const QUOTED = `(?:"([^"]*)"|'([^']*)')`;
function codexRoute(dir) {
  const text = read(path.join(dir, 'config.toml'));
  if (text === null) return null;
  let table = null;
  let provider = null;
  const bases = new Map();
  let depth = 0; // open brackets of a multi-line array value; its lines are never headers
  for (const line of text.split(/\r?\n/)) {
    if (depth > 0) {
      depth += count(line, '[') - count(line, ']');
      continue;
    }
    const head = line.match(/^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (head) {
      // [[array.of.tables]] resets the table too, but is never a [model_providers.<name>] table
      table = head[1] === '[[' ? `[[${head[2]}` : head[2];
      continue;
    }
    if (/^\s*[\w.-]+\s*=\s*\[/.test(line)) depth = Math.max(0, count(line, '[') - count(line, ']'));
    const kv = line.match(new RegExp(`^\\s*(model_provider|base_url)\\s*=\\s*${QUOTED}`));
    if (!kv) continue;
    const value = kv[2] ?? kv[3];
    if (kv[1] === 'model_provider' && table === null) provider = value;
    if (kv[1] === 'base_url' && table) {
      const t = table.match(/^model_providers\.(?:"([^"]+)"|'([^']+)'|([\w-]+))$/);
      if (t) bases.set(t[1] ?? t[2] ?? t[3], value);
    }
  }
  return provider ? originOf(bases.get(provider)) : null;
}

// { claude: origin | null, codex: origin | null }. The folders default to the ones Claude Code and Codex use; a file
// that cannot be read or does not parse gives null.
function readToolRoutes({ home = os.homedir(), env = process.env, claudeDir, codexHome } = {}) {
  let cdir = claudeDir;
  if (!cdir) {
    const c = configDir(env, home);
    cdir = c && c.dir ? c.dir : path.join(home, '.claude');
  }
  let xdir = codexHome;
  if (!xdir) {
    const [r] = codex.rootInfo(env, home);
    xdir = r && !r.ignored ? path.dirname(r.path) : null;
  }
  return { claude: claudeRoute(cdir), codex: xdir ? codexRoute(xdir) : null };
}

// An origin as a comparable key: localhost and ::1 count as 127.0.0.1, and a missing port is the protocol's default.
function sameKey(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = ['localhost', '[::1]'].includes(u.hostname) ? '127.0.0.1' : u.hostname;
    return `${u.protocol}//${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return null;
  }
}

// A tool's route: 'gateway' when its origin is the dashboard's (BASE_URL), a router's id when it is that router's
// baseUrl origin, otherwise null (it goes straight to the provider).
function routeOf(origin, { baseUrl, routers } = {}) {
  const key = sameKey(origin);
  if (!key) return null;
  if (sameKey(baseUrl) === key) return 'gateway';
  const hit = (Array.isArray(routers) ? routers : []).find((r) => r && r.id && sameKey(r.baseUrl) === key);
  return hit ? hit.id : null;
}

module.exports = { readToolRoutes, routeOf, originOf };
