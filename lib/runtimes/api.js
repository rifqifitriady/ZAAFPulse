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
