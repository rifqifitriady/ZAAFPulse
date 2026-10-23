// The models Ollama and LM Studio last had loaded, and loading them again after a Start. While ZAAFPulse runs it
// remembers the last non-empty list read from the server (.data/runtimes/models.json), so a model unloaded when the
// server went idle, stopped from outside or lost to a restart is still known. Names come only from the runtime's own
// answers and must match NAME_RE (no leading "-": a name can never act as an option to `lms`). A read that fails or
// times out means "unknown", never "empty". Loads run one at a time, in the background, without a shell.
const { execFile } = require('child_process');
const http = require('http');
const path = require('path');
const { jsonFile } = require('./state');

const NAME_RE = /^[A-Za-z0-9][\w.:\/@+-]{0,199}$/;
const MAX_MODELS = 8;
const READ_TIMEOUT_MS = 3000;
const CURRENT_MS = 90 * 1000; // three observer passes
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const SUPPORTED = new Set(['ollama', 'lmstudio']);

// One JSON request. Resolves to { status, body } (body is null when it is not JSON), or null when the server does
// not answer in time or the URL is bad. It never rejects.
function request(url, method, payload, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(v);
    }
    try {
      const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
      const headers = data ? { 'content-type': 'application/json', 'content-length': data.length } : {};
      req = http.request(url, { method, headers }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) return finish(null);
          chunks.push(c);
        });
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = null;
          }
          finish({ status: res.statusCode, body });
        });
        res.on('error', () => finish(null));
      });
      req.on('error', () => finish(null));
      req.end(data);
    } catch {
      finish(null);
    }
  });
}

// The parsed JSON of a 2xx answer, else null.
async function getJson(url, timeoutMs = READ_TIMEOUT_MS) {
  const r = await request(url, 'GET', undefined, timeoutMs);
  return r && r.status >= 200 && r.status < 300 ? r.body : null;
}
const postJson = (url, body, timeoutMs = LOAD_TIMEOUT_MS) => request(url, 'POST', body, timeoutMs);

// Runs argv with no shell. Resolves to { code, stdout }; code is null when it timed out or could not start.
const realRun = (argv, { timeoutMs = READ_TIMEOUT_MS } = {}) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        argv[0],
        argv.slice(1),
        { timeout: timeoutMs, maxBuffer: MAX_BODY, windowsHide: true },
        (err, stdout) => {
          const code = !err ? 0 : typeof err.code === 'number' ? err.code : null;
          resolve({ code, stdout: String(stdout || '') });
        },
      );
      child.stdin.on('error', () => {}); // an EPIPE on the closed pipe must not crash the server
      child.stdin.end();
    } catch {
      resolve({ code: null, stdout: '' });
    }
  });

// The names worth keeping from a list: strings that match NAME_RE, without repeats, at most MAX_MODELS.
function clean(names) {
  const out = [];
  for (const n of Array.isArray(names) ? names : [])
    if (typeof n === 'string' && NAME_RE.test(n) && !out.includes(n)) out.push(n);
  return out.slice(0, MAX_MODELS);
}

function createModelMemory({
  file, // jsonFile of .data/runtimes/models.json: { [id]: { models: [name], ts } }
  dir, // used instead of `file` when only a folder is given
  getJson: get = getJson,
  postJson: post = postJson,
  run = realRun,
  now = Date.now,
  log = () => {},
  onDone = () => {}, // (id, { loaded, failed }) when a reload ends
} = {}) {
  const store = file || jsonFile(path.join(dir || '.', 'models.json'));
  const status = new Map(); // id -> { loading, loaded, failed }
  const seen = new Map(); // id -> { names, ts }: the last list read from the runtime, an empty one included

  const supports = (id) => typeof id === 'string' && SUPPORTED.has(id);
  const usable = (x) => !!x && !!x.entry && !!x.entry.preset && supports(x.entry.id);
  const url = (x) => `http://127.0.0.1:${x.entry.port}`;

  // The loaded model names the runtime reports, or null when that is unknown.
  async function read(x) {
    try {
      if (x.entry.id === 'ollama') {
        const r = await get(`${url(x)}/api/ps`, READ_TIMEOUT_MS);
        return r && Array.isArray(r.models) ? clean(r.models.map((m) => m && m.name)) : null;
      }
      if (!x.bin) return null;
      const r = await run([x.bin, 'ps', '--json'], { timeoutMs: READ_TIMEOUT_MS });
      if (!r || r.code !== 0) return null;
      const v = JSON.parse(r.stdout);
      const list = Array.isArray(v) ? v : v && Array.isArray(v.models) ? v.models : null;
      return list ? clean(list.map((m) => m && (m.modelKey || m.identifier))) : null;
    } catch {
      return null;
    }
  }

  function remembered(id) {
    if (!supports(id)) return [];
    const all = store.read();
    return Object.hasOwn(all, id) && all[id] && typeof all[id] === 'object' ? clean(all[id].models) : [];
  }

  // Reads the loaded models of a running, healthy runtime and saves a non-empty list that differs from the saved one.
  // While a reload is loading, only part of the list is up, so nothing is saved then.
  async function observe(x) {
    if (!usable(x) || !x.running || !x.healthy) return null;
    const names = await read(x);
    if (!names) return null;
    seen.set(x.entry.id, { names, ts: now() });
    const st = status.get(x.entry.id);
    if (!(st && st.loading) && names.length && JSON.stringify(names) !== JSON.stringify(remembered(x.entry.id))) {
      try {
        store.write({ ...store.read(), [x.entry.id]: { models: names, ts: now() } });
      } catch (e) {
        log(`runtime models: could not save (${e.code || 'error'})`);
      }
    }
    return names;
  }

  // Loads one model; resolves to null on success, else a short error text (never a path).
  async function load(x, name) {
    try {
      if (x.entry.id === 'ollama') {
        const r = await post(`${url(x)}/api/generate`, { model: name, keep_alive: -1 }, LOAD_TIMEOUT_MS);
        if (!r) return 'timed out';
        if (r.status >= 200 && r.status < 300) return null;
        return r.status === 404 ? 'not found' : 'could not load';
      }
      const r = await run([x.bin, 'load', name, '--yes'], { timeoutMs: LOAD_TIMEOUT_MS });
      if (r && r.code === 0) return null;
      return r && r.code === null ? 'timed out' : 'could not load';
    } catch {
      return 'could not load';
    }
  }

  // Starts loading the remembered models in the background; returns the names it will load ([] when there is nothing
  // to do or a reload of this runtime is running). A cancel (the runtime is being stopped) ends it before the next load;
  // a cancelled reload whose last load is still in flight does not hold up the next Start, which replaces its status.
  function reload(x) {
    if (!usable(x)) return [];
    const id = x.entry.id;
    if (id === 'lmstudio' && !x.bin) return [];
    const names = remembered(id);
    const cur = status.get(id);
    if (!names.length || (cur && cur.loading && !cur.cancelled)) return [];
    const st = { loading: true, loaded: [], failed: [], cancelled: false };
    status.set(id, st);
    (async () => {
      try {
        // LM Studio keeps its models loaded while its server is off, and `lms load` on a loaded one adds a second
        // copy: what it still has is skipped. (Ollama's load of a loaded model only renews its keep_alive.)
        const still = id === 'lmstudio' ? (await read(x)) || [] : [];
        for (const name of names) {
          if (st.cancelled) break;
          if (still.includes(name)) {
            st.loaded.push(name);
            continue;
          }
          const error = await load(x, name);
          if (!error) st.loaded.push(name);
          else if (!st.cancelled) st.failed.push({ name, error }); // after a cancel the server went away under it
        }
      } finally {
        st.loading = false;
      }
      try {
        const result = { loaded: [...st.loaded], failed: st.failed.map((f) => ({ ...f })) };
        onDone(id, st.cancelled ? { ...result, cancelled: true } : result);
      } catch (e) {
        log(`runtime models: ${id} done handler failed`);
      }
    })().catch(() => {});
    return names;
  }

  // The runtime is being stopped: a reload of it loads nothing more (`lms load` would start LM Studio again). The load
  // in flight ends on its own, and `loading` stays true until it has, so a read meanwhile saves nothing. A finished
  // reload's status goes, so a server started later some other way does not show it as its own.
  function cancel(id) {
    const st = status.get(id);
    if (st && st.loading) st.cancelled = true;
    else status.delete(id);
  }

  const statusOf = (id) => {
    const st = status.get(id);
    return st ? { loading: st.loading, loaded: [...st.loaded], failed: st.failed.map((f) => ({ ...f })) } : null;
  };

  // What the runtime has loaded now, as its last read found it (the observer reads every 30 s); null when that read is
  // older than CURRENT_MS or there was none, so a stale list is never shown as loaded.
  function current(id) {
    const s = seen.get(id);
    return s && now() - s.ts <= CURRENT_MS ? [...s.names] : null;
  }

  return { supports, observe, remembered, reload, cancel, current, status: statusOf };
}

module.exports = { createModelMemory, getJson, postJson, NAME_RE, MAX_MODELS, LOAD_TIMEOUT_MS };
