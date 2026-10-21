// The trace registry: every source adapter behind one interface for the HTTP API. It owns what must never
// reach a client (file paths, sizes, byte ranges) and hands out opaque things instead:
//  - session keys: the source plus a keyed hash of the session id (per-process secret), so a client can
//    neither invent a key nor read an id out of one; the key -> { source, sid, entry } map stays here;
//  - content ids: random ids for every text/result ref of a skeleton. The ref and the session it belongs
//    to stay here, and the ids go when the session's cache slot is evicted.
// Errors reach the client only through `clean`: a status and a message with no path in it.
// It also bounds the work: an LRU of built skeletons (P2), big files built in a worker (P2), at most
// `maxReads` skeleton builds or content reads at a time (P9), and each source called in isolation (P10).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const claude = require('./claude');
const codex = require('./codex');
const { createGatewayAdapter } = require('./gateway');
const { createContent, MAX_READ } = require('./content');
const { baseName } = require('./light');

const SECRET = crypto.randomBytes(16);
const FILE_SOURCES = new Set(['claude', 'codex']);
const ROW_CAP = 500;
const DAY = 86400e3;
const fail = (status, message) => Object.assign(new Error(message), { status });
const unknownSession = () => fail(404, 'unknown session');
const isSubFile = (file) => file.includes(`${path.sep}subagents${path.sep}`);

// A session key says nothing about the session: the source and a keyed hash of its id. It is resolved only
// through the listing, so it cannot be turned back into an id (or the path an id was hashed from).
const KEY_SHAPE = /^[a-z][a-z0-9_-]{0,31}\.[0-9a-f]{32}$/;
const keyOf = (source, sid) =>
  `${source}.${crypto.createHmac('sha256', SECRET).update(`key:${source}:${sid}`).digest('hex').slice(0, 32)}`;

// A span id as a client sees it: keyed with the process secret, so it cannot be guessed back to the path it
// was hashed from, and stable for the life of the process so a selection survives a rebuild.
const spanKey = (id) => crypto.createHmac('sha256', SECRET).update(`span:${id}`).digest('hex').slice(0, 16);

// The live cursor: the file size, sealed (AES-GCM, bound to the session key) so the client sees neither the
// size nor a value it could forge or move to another session.
const CURSOR_KEY = crypto.createHash('sha256').update(SECRET).update('cursor').digest().subarray(0, 16);
function sealCursor(key, size) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-128-gcm', CURSOR_KEY, iv);
  c.setAAD(Buffer.from(key));
  const ct = Buffer.concat([c.update(String(size)), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
}
// The size inside a cursor, or 0 (from the beginning) when it is missing, damaged or from another session.
function openCursor(key, cursor) {
  try {
    if (typeof cursor !== 'string' || cursor.length > 200) return 0;
    const b = Buffer.from(cursor, 'base64url');
    if (b.length < 12 + 1 + 16) return 0;
    const d = crypto.createDecipheriv('aes-128-gcm', CURSOR_KEY, b.subarray(0, 12));
    d.setAAD(Buffer.from(key));
    d.setAuthTag(b.subarray(b.length - 16));
    const n = Number(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString());
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

// A reason is shown to the client: keep the message, drop anything that looks like a path. A quoted segment
// with a separator goes whole first (a path may hold spaces), then any bare path up to the next space.
const reasonOf = (e) =>
  String((e && e.message) || e || 'failed')
    .replace(/(['"`])(?:(?!\1).)*[\\/](?:(?!\1).)*\1/g, '<path>')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`]+/g, '<path>')
    .slice(0, 120);

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
};

const oneLine = (text) => {
  let out = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1); // not half a surrogate pair
  return out.trim() || null;
};

// Whether transcript text is off unless asked for: ZAAFPULSE_CONTENT=off always, and by default in server mode
// (other people may sign in there) unless ZAAFPULSE_CONTENT=on.
const contentDefaultOff = (env, serverMode) =>
  env.ZAAFPULSE_CONTENT === 'off' || (!!serverMode && env.ZAAFPULSE_CONTENT !== 'on');

function createTrace(opts = {}) {
  const {
    demo = false,
    contentOff = false,
    cacheMax = 20,
    cacheBytes = 200e6,
    workerMinBytes = 50e6,
    maxReads = 4,
    listTtlMs = 2000, // how long the session listing is reused
    workerTimeoutMs = 30000,
    workerFile = path.join(__dirname, 'worker.js'),
    pricing,
    log = console.error,
  } = opts;

  const demoData = demo ? require('../demo').traceDemo() : null;
  // The gateway may be given as the trace API itself or as the gateway that holds it.
  const gw = !demo && opts.gateway ? (opts.gateway.runs ? opts.gateway : opts.gateway.trace) || null : null;
  const gwAdapter = gw ? createGatewayAdapter(gw) : null;
  const indexer = demo ? null : opts.indexer || null;
  // Tests pass `light: []` so they never read the machine's own logs.
  const light = demo
    ? []
    : opts.light === undefined
      ? [require('./kiro'), require('./gemini'), require('./antigravity')]
      : opts.light;
  const lightById = new Map(light.map((a) => [a.id, a]));
  // Demo text is served by the real content reader through a stand-in "run", so masking, paging and
  // reveal behave exactly as for real logs.
  const demoRuns = demo
    ? { run: (id) => (Object.hasOwn(demoData.content, id) ? { answer: demoData.content[id] } : null) }
    : null;
  const content = createContent({ roots: opts.roots || [], gateway: demo ? demoRuns : gw });

  const stats = { workers: 0, fallbacks: 0 };

  // What a failure looks like to a client: a status and a message without a path. An error that already has
  // a status keeps it. A file that vanished under us means the listing is stale. Anything else is a 500
  // whose cause is logged once, scrubbed, and kept off the wire.
  const logged = new Set();
  const missing = new Map(); // key -> { at, why }: answered from memory for one listing TTL
  let lastForce = -Infinity; // when the listing was last rebuilt on demand: at most once a second
  function remember(key, why) {
    if (typeof key !== 'string') return;
    if (missing.size >= 1000) missing.delete(missing.keys().next().value);
    missing.set(key, { at: Date.now(), why });
  }
  function clean(e, key) {
    const status = e && e.status;
    if (Number.isInteger(status) && status >= 400 && status <= 599) return fail(status, reasonOf(e));
    if (e && e.code === 'ENOENT') {
      // The index may keep listing a deleted file until its next scan: ask for a new listing at most once a
      // second, and answer this key from memory meanwhile.
      const why = 'session file changed, rescanning';
      remember(key, why);
      if (Date.now() - lastForce >= 1000) {
        lastForce = Date.now();
        snap = null;
      }
      return fail(404, why);
    }
    const why = reasonOf(e);
    if (!logged.has(why) && logged.size < 100) {
      logged.add(why);
      try {
        log(`trace read failed: ${why}`);
      } catch {
        /* logging must not break the request */
      }
    }
    return fail(500, 'trace read failed');
  }
  // `keyOf` finds the session key in the call, so a vanished file can be remembered against it.
  const guard =
    (fn, keyOf) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        throw clean(e, keyOf && keyOf(args));
      }
    };

  // ---- read limit: a counter and a FIFO queue ----
  let active = 0;
  const queue = [];
  const acquire = () =>
    active < maxReads ? (active++, Promise.resolve()) : new Promise((resolve) => queue.push(resolve));
  const release = () => {
    const next = queue.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else active--;
  };
  async function limited(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ---- the session listing ----
  let snap = null;
  let gen = 0;
  // Titles are text from the transcript or the user: with content off only the gateway's own (pattern, state
  // and counts) stay.
  const titleShown = (id) => !contentOff || id === 'gateway';
  function collect(force) {
    const now = Date.now();
    if (snap && !force && now - snap.at < listTtlMs) return snap;
    const next = { at: now, gen: ++gen, sources: [], rows: [], keys: new Map(), entries: [] };
    const source = (id, fn) => {
      try {
        const count = fn();
        next.sources.push({ id, ok: true, reason: null, count });
      } catch (e) {
        next.sources.push({ id, ok: false, reason: reasonOf(e), count: 0 });
      }
    };
    // `list` are the adapter's rows; `entryOf` finds the index entry of a file-backed row.
    const add = (id, list, entryOf) => {
      let n = 0;
      for (const r of list) {
        if (!r || typeof r.id !== 'string') continue;
        const entry = entryOf ? entryOf(r) : null;
        if (entryOf && !entry) continue;
        const key = keyOf(id, r.id);
        const f = r.flags;
        const info = {
          source: id,
          sid: r.id,
          entry,
          gen: next.gen,
          title: titleShown(id) && typeof r.title === 'string' && r.title ? r.title : null,
          // What changes when the session does, so a cached skeleton is not served stale.
          stamp: entry ? `${entry.mtimeMs}:${entry.size}` : `${r.end}:${r.turns}:${r.tools}`,
        };
        const base = {
          source: id,
          project: baseName(r.project),
          branch: r.branch == null ? null : String(r.branch),
          start: r.start ?? null,
          end: r.end ?? null,
          turns: r.turns ?? 0,
          tools: r.tools ?? 0,
          errors: r.errors ?? 0,
          cost: r.cost ?? null,
          flags: { errors: !!(f && f.errors), loop: !!(f && f.loop), injection: !!(f && f.injection) },
        };
        next.keys.set(key, info);
        next.rows.push({ key, info, base });
        n++;
      }
      return n;
    };
    if (demo) {
      for (const id of ['claude', 'codex', 'kiro']) {
        source(id, () => add(id, demoData.sessions.filter((r) => r.source === id)));
      }
      return finish(next);
    }
    if (indexer) {
      let entries = null;
      let err = null;
      try {
        entries = indexer.entries();
        next.entries = entries;
      } catch (e) {
        err = e;
      }
      const byFile = new Map((entries || []).map((e) => [e.file, e]));
      for (const a of [claude, codex]) {
        source(a.id, () => {
          if (err) throw err;
          return add(a.id, a.sessions(entries), (r) => byFile.get(r.file));
        });
      }
    }
    if (gwAdapter) source('gateway', () => add('gateway', gwAdapter.sessions()));
    for (const a of light) {
      let av;
      try {
        av = a.available();
      } catch (e) {
        next.sources.push({ id: a.id, ok: false, reason: reasonOf(e), count: 0 });
        continue;
      }
      if (!av || !av.ok) {
        const reason = av && av.reason ? reasonOf(av.reason) : 'unavailable';
        next.sources.push({ id: a.id, ok: false, reason, count: 0 });
        continue;
      }
      source(a.id, () => add(a.id, a.sessions()));
    }
    return finish(next);
  }

  // All six sources are always listed, in a fixed order; one that is not set up says so.
  const SOURCE_IDS = ['claude', 'codex', 'gateway', 'kiro', 'gemini', 'antigravity'];
  function finish(next) {
    const by = new Map(next.sources.map((s) => [s.id, s]));
    const rest = next.sources.filter((s) => !SOURCE_IDS.includes(s.id));
    const off = (id) => ({ id, ok: false, reason: 'not configured', count: 0 });
    next.sources = [...SOURCE_IDS.map((id) => by.get(id) || off(id)), ...rest];
    return (snap = next);
  }

  // The session behind a key: 400 for no key, 404 for a key that is malformed, forged, gone or not listed.
  function lookup(key) {
    if (typeof key !== 'string' || !key) throw fail(400, 'session key required');
    if (!KEY_SHAPE.test(key)) throw unknownSession();
    const now = Date.now();
    const gone = missing.get(key);
    if (gone && now - gone.at < listTtlMs) throw fail(404, gone.why);
    let info = collect().keys.get(key);
    if (info) return info;
    // A key can be unlisted because the session appeared after the last listing, or because it is gone or
    // never existed. The listing is rebuilt at most once a second for that, and a key still missing after it
    // is answered from memory for one listing TTL, so a stale key cannot make every request a rescan.
    if (now - lastForce >= 1000) {
      lastForce = now;
      info = collect(true).keys.get(key);
      if (info) return info;
      remember(key, 'unknown session');
    }
    throw unknownSession();
  }

  // The key of a listed session, for links from pages that know only the session id (Sessions, AI Office).
  // It tells the client nothing new: the client sent the id. An id the listing does not have is unknown,
  // after at most one rebuild a second, as in `lookup`.
  function keyFor(source, sid) {
    if (typeof source !== 'string' || !source || typeof sid !== 'string' || !sid)
      throw fail(400, 'source and session id required');
    const find = (s) => {
      for (const { key, info } of s.rows) if (info.source === source && info.sid === sid) return key;
      return null;
    };
    let key = find(collect());
    const now = Date.now();
    if (!key && now - lastForce >= 1000) {
      lastForce = now;
      key = find(collect(true));
    }
    if (!key) throw unknownSession();
    return key;
  }

  // ---- titles: read from the first prompt on demand, cached by key and mtime ----
  const titles = new Map(); // key -> { m, t }
  const cachedTitle = (key, info) => {
    const c = info.entry && titles.get(key);
    return c && c.m === info.entry.mtimeMs ? c.t : null;
  };

  function titleRef(info) {
    const { entry, sid } = info;
    const turns = entry.result.sessions[sid].turns;
    const t0 = turns[0][0];
    if (info.source === 'claude') return { f: entry.file, s: t0, e: t0, k: 'prompt' };
    const t1 = turns[1] && turns[1][0];
    return { f: entry.file, s: t0, e: Math.min(t1 ?? entry.size, t0 + MAX_READ), k: 'prompt', i: null, src: 'codex' };
  }

  async function title(key) {
    const info = lookup(key);
    if (info.title) return info.title;
    if (!info.entry || contentOff) return null; // a prompt is content: not read when content is off
    const hit = cachedTitle(key, info);
    if (hit) return hit;
    let t;
    try {
      const r = await limited(() => content.read(titleRef(info), { max: 400 }));
      t = oneLine(r.text);
    } catch {
      return null;
    }
    if (titles.size > 5000) titles.delete(titles.keys().next().value);
    titles.set(key, { m: info.entry.mtimeMs, t });
    return t;
  }

  function sessions({ range, source, q, flags } = {}) {
    const days = Number(range);
    const cutoff = Number.isFinite(days) && days > 0 ? Date.now() - days * DAY : null;
    const needle = typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : null;
    const out = [];
    for (const { key, info, base } of collect().rows) {
      if (source && base.source !== source) continue;
      if (cutoff != null && !(base.end >= cutoff)) continue;
      if (flags === 'errors' && !(base.errors > 0 || base.flags.errors)) continue;
      const t = info.title || cachedTitle(key, info);
      const hay = [t, base.project, base.branch];
      if (needle && !hay.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle))) continue;
      out.push({ key, title: t, ...base, flags: { ...base.flags } });
    }
    const endOf = (r) => (Number.isFinite(r.end) ? r.end : 0);
    return out.sort((a, b) => endOf(b) - endOf(a)).slice(0, ROW_CAP);
  }

  const sources = () => collect().sources.map((s) => ({ ...s }));

  // ---- the LRU of sealed skeletons and their content ids ----
  const cache = new Map(); // cache key -> { sk, stamp, ids, bytes }; oldest first
  const contents = new Map(); // content id -> { ref, ck }
  let bytes = 0;
  const drop = (ck) => {
    const it = cache.get(ck);
    if (!it) return;
    cache.delete(ck);
    bytes -= it.bytes;
    for (const id of it.ids) contents.delete(id);
  };
  const touch = (ck) => {
    const it = cache.get(ck);
    if (it) {
      cache.delete(ck);
      cache.set(ck, it);
    }
    return it;
  };
  function put(ck, item) {
    drop(ck);
    cache.set(ck, item);
    bytes += item.bytes;
    // The newest item always stays, so the ids it just handed out resolve.
    while (cache.size > 1 && (cache.size > cacheMax || bytes > cacheBytes)) drop(cache.keys().next().value);
  }

  // The skeleton as a client may see it: every text/result ref becomes a content id, the project a folder
  // name. Nothing from the adapter's own object is shared, and no path survives.
  function seal(sk, ck, stamp, gen) {
    const ids = [];
    const mint = (ref) => {
      let id;
      do id = `ci_${crypto.randomBytes(8).toString('hex')}`;
      while (contents.has(id));
      // Demo refs are plain keys into the demo text.
      contents.set(id, { ref: typeof ref === 'string' ? { g: 'run', id: ref, answer: true } : ref, ck });
      ids.push(id);
      return id;
    };
    const spans = (sk.spans || []).map((s) => {
      const o = { ...s, id: spanKey(s.id), parent: s.parent == null ? s.parent : spanKey(s.parent) };
      for (const f of ['text', 'result']) {
        const ref = o[f];
        o[f] = ref != null && (typeof ref === 'object' || typeof ref === 'string') ? mint(ref) : null;
      }
      return o;
    });
    // The session's own id (a hash of a path for some sources) is replaced by its key.
    const session = { ...sk.session, id: ck.split('|')[0], project: baseName(sk.session && sk.session.project) };
    // No byte offsets: a turn is its index and its time. Copied, then frozen, so nothing a caller does to
    // the cached skeleton can reach the next caller.
    const turns = (sk.turns || []).map((t) => ({ index: t.index, ts: t.ts }));
    const sealed = deepFreeze(structuredClone({ session, turns, spans }));
    return { sk: sealed, stamp, gen, ids, bytes: JSON.stringify(sealed).length };
  }

  // ---- building a skeleton ----
  function inThread(info, turn, entry) {
    if (demo) return Promise.resolve(JSON.parse(JSON.stringify(demoData.skeletons[info.sid])));
    if (FILE_SOURCES.has(info.source)) {
      const adapter = info.source === 'claude' ? claude : codex;
      return adapter.skeleton(entry, info.sid, { turn, entries: collect().entries, pricing });
    }
    if (info.source === 'gateway') return gwAdapter.skeleton(null, info.sid);
    return lightById.get(info.source).skeleton(null, info.sid, { turn });
  }

  // Only what the adapter reads: the session's own record, the subagent files of that session (Claude) or the
  // session's usage rows (Codex). Everything is plain data, so it clones into the worker cheaply.
  function workerJob(info, turn, entry) {
    const { sid } = info;
    const slim = (e, extra) => ({
      file: e.file,
      source: e.source,
      size: e.size,
      mtimeMs: e.mtimeMs,
      result: { sessions: { [sid]: e.result.sessions[sid] }, ...extra },
    });
    const job = { adapter: info.source, sid, turn, pricing };
    if (info.source === 'claude') {
      job.entry = slim(entry);
      const mine = (e) => e.source === 'claude' && isSubFile(e.file) && e.result.sessions && e.result.sessions[sid];
      job.entries = collect().entries.filter(mine).map((e) => slim(e));
    } else {
      job.entry = slim(entry, { events: (entry.result.events || []).filter((r) => r[2] === sid) });
      job.entries = [];
    }
    return job;
  }

  function viaWorker(job) {
    return new Promise((resolve, reject) => {
      let w;
      let timer;
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (w) w.terminate().catch(() => {});
        if (err) reject(err);
        else resolve(value);
      };
      try {
        w = new Worker(workerFile, { workerData: job });
      } catch (e) {
        return reject(e);
      }
      timer = setTimeout(() => finish(new Error('worker timed out')), workerTimeoutMs);
      w.once('message', (m) =>
        m && m.ok ? finish(null, m.skeleton) : finish(new Error((m && m.message) || 'worker failed')),
      );
      w.once('error', finish);
      w.once('exit', (code) => finish(new Error(`worker exited with code ${code}`)));
    });
  }

  async function build(info, turn, entry) {
    if (!demo && FILE_SOURCES.has(info.source) && entry.size > workerMinBytes) {
      try {
        const sk = await viaWorker(workerJob(info, turn, entry));
        stats.workers++;
        return sk;
      } catch {
        stats.fallbacks++; // a worker that cannot start, dies or hangs: build here instead
      }
    }
    return inThread(info, turn, entry);
  }

  const inflight = new Map();
  async function session(key, { turn } = {}) {
    const info = lookup(key);
    if (turn != null && !(Number.isInteger(turn) && turn >= 0)) throw fail(400, 'bad turn');
    const ck = `${key}|${turn == null ? 'last' : turn}`;
    const hit = touch(ck);
    if (hit && hit.stamp === info.stamp) return hit.sk;
    const flight = `${ck}|${info.stamp}`;
    if (inflight.has(flight)) return inflight.get(flight);
    const p = limited(() => build(info, turn, info.entry))
      .then((sk) => {
        // A slower build of an older listing must not replace what a newer one already cached.
        const cur = cache.get(ck);
        if (cur && cur.gen > info.gen) return cur.sk;
        const item = seal(sk, ck, info.stamp, info.gen);
        put(ck, item);
        return item.sk;
      })
      .finally(() => inflight.delete(flight));
    inflight.set(flight, p);
    return p;
  }

  // ---- content ----
  const ofContent = (a) => {
    const c = typeof a[0] === 'string' && contents.get(a[0]);
    return c ? c.ck.split('|')[0] : null;
  };
  function resolveContent(id) {
    if (contentOff) throw fail(403, 'content viewing is off');
    if (typeof id !== 'string' || !id) throw fail(400, 'content id required');
    const c = contents.get(id);
    if (!c) throw fail(404, 'unknown content');
    touch(c.ck); // reading a session's text keeps its slot warm
    return c.ref;
  }
  const readContent = async (id, { offset = 0 } = {}) => {
    const ref = resolveContent(id);
    return limited(() => content.read(ref, { offset }));
  };
  const revealContent = async (id, index, { offset = 0 } = {}) => {
    const ref = resolveContent(id);
    if (index === undefined || index === null) throw fail(400, 'mask index required');
    return limited(() => content.reveal(ref, index, { offset }));
  };

  // ---- live tail ----
  // The size of the session file against what the client last saw, as a sealed cursor (no size on the wire).
  // Only Claude and Codex files grow under us. The last turn comes from the turn offsets in the index, so a
  // turn that started after the last index refresh only shows up after the next refresh; growth inside the
  // last turn shows at once. A missing or bad cursor means "from the beginning", so it reports a change.
  // Each size gets its own cache slot, which the LRU retires like any other.
  const liveSlots = new Map(); // key -> its newest live cache keys
  async function live(key, cursor) {
    const info = lookup(key);
    if (demo || !FILE_SOURCES.has(info.source)) return { changed: false };
    const since = openCursor(key, cursor);
    const size = (await fs.promises.stat(info.entry.file)).size;
    if (!(size > since)) return { changed: false, cursor: sealCursor(key, size) };
    const entry = { ...info.entry, size };
    const ck = `${key}|live|${size}`;
    const stamp = `${info.stamp}:${size}`;
    const have = touch(ck);
    if (have && have.stamp === stamp) return { changed: true, cursor: sealCursor(key, size), skeleton: have.sk };
    const sk = await limited(() => build(info, undefined, entry));
    const item = seal(sk, ck, stamp, info.gen);
    put(ck, item);
    // Growth slots must not push other sessions out of the cache: only the two newest are kept per session.
    const slots = (liveSlots.get(key) || []).filter((c) => c !== ck);
    slots.push(ck);
    while (slots.length > 2) drop(slots.shift());
    liveSlots.set(key, slots);
    return { changed: true, cursor: sealCursor(key, size), skeleton: item.sk };
  }

  return {
    sources,
    sessions,
    keyFor,
    title: guard(title, (a) => a[0]),
    session: guard(session, (a) => a[0]),
    content: guard(readContent, ofContent),
    reveal: guard(revealContent, ofContent),
    live: guard(live, (a) => a[0]),
    stats: () => ({
      cached: cache.size,
      contentIds: contents.size,
      bytes,
      active,
      queued: queue.length,
      workers: stats.workers,
      fallbacks: stats.fallbacks,
    }),
  };
}

module.exports = { createTrace, contentDefaultOff };
