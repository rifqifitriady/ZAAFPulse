// The local sink of lib/otel.js: every finished span becomes a compact record (microseconds, no content) and
// waits in a bounded buffer until it is written to the trace store, once a second or every `batch` spans. It
// also remembers the trace IDs whose traceparent went out to a remote agent or MCP server (expect), so the return
// channel accepts spans for those traces only. A stored span does not count: a request that came in with the
// caller's own traceparent would otherwise let that caller write into its trace. Nothing here may throw into a
// request or a run.
const { maskSecrets } = require('./model');
const KIND = { 1: 'internal', 2: 'server', 3: 'client' };
// Prompt, reply and tool text that OTLP export may carry with captureContent; the store never keeps it.
const CONTENT_KEYS = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]);
// What a span from outside (the return channel) may keep: names, models, token counts and transport details.
// An allow-list, not the deny-list above: other conventions carry prompt and reply text under their own keys
// (OpenInference input.value, output.value, llm.input_messages.*; OpenLLMetry gen_ai.prompt.*, gen_ai.completion.*).
const REMOTE_KEYS = new Set([
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.provider.name',
  'gen_ai.agent.id',
  'gen_ai.agent.name',
  'gen_ai.tool.name',
  'gen_ai.tool.type',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'rpc.system',
  'rpc.method',
  'server.address',
  'server.port',
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'error.type',
  'mcp.method.name',
]);

const MAX_ERR = 200;
const MAX_KNOWN = 100000;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

// Secrets in an error message never reach the store; same marker as the explorer's titles.
function maskErr(text) {
  const s = String(text);
  const out = maskSecrets(s).slice(0, MAX_ERR);
  return /[\ud800-\udbff]$/.test(out) ? out.slice(0, -1) : out; // do not end on half a surrogate pair
}

function toRecord(r) {
  const a = {};
  for (const [k, v] of Object.entries(r.attributes || {})) if (!CONTENT_KEYS.has(k)) a[k] = v;
  const st = Number(r.startNs / 1000n);
  const failed = r.status && r.status.code === 2;
  return {
    t: r.traceId,
    s: r.spanId,
    p: r.parentSpanId || null,
    n: r.name,
    k: KIND[r.kind] || 'internal',
    st,
    d: Math.max(0, Number(r.endNs / 1000n) - st),
    ok: !failed,
    ...(failed ? { err: maskErr(r.status.message || 'error') } : {}),
    src: 'gateway',
    svc: 'zaafpulse',
    a,
  };
}

const cut = (v, max, dflt) => (typeof v === 'string' && v ? v.slice(0, max) : dflt);
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const MAX_ATTRS = 64;

// A record from the return channel is rebuilt from the named fields only: no extra keys, only allowed attributes,
// a masked error. Returns null for a record that is not well formed.
function clean(r) {
  // typeof first: RegExp.test would coerce an array or an object with toString into a string and accept it.
  if (!r || typeof r !== 'object') return null;
  if (typeof r.t !== 'string' || !HEX32.test(r.t) || typeof r.s !== 'string' || !HEX16.test(r.s)) return null;
  if (r.p !== null && !(typeof r.p === 'string' && HEX16.test(r.p))) return null;
  if (!num(r.st) || !num(r.d)) return null;
  const a = {};
  if (r.a && typeof r.a === 'object' && !Array.isArray(r.a)) {
    let n = 0;
    for (const [k, v] of Object.entries(r.a)) {
      if (n >= MAX_ATTRS) break;
      if (!REMOTE_KEYS.has(k)) continue;
      if (typeof v === 'number' || typeof v === 'boolean') a[k] = v;
      else if (typeof v === 'string') a[k] = v.slice(0, 1000);
      else continue;
      n++;
    }
  }
  return {
    t: r.t,
    s: r.s,
    p: r.p,
    n: cut(r.n, 200, 'span'),
    k: r.k === 'server' || r.k === 'client' ? r.k : 'internal',
    st: r.st,
    d: r.d,
    ok: r.ok !== false,
    ...(r.err !== undefined && r.err !== null ? { err: maskErr(r.err) } : {}),
    src: cut(r.src, 100, 'remote'),
    svc: cut(r.svc, 100, 'remote'),
    a,
  };
}

function createRecorder({
  store,
  enabled = () => true,
  flushMs = 1000,
  batch = 500,
  maxBuffer = 10000,
  knownMs = 86400000,
  maxKnown = MAX_KNOWN,
  log = console.error,
  now = Date.now,
}) {
  let buf = [];
  let timer = null;
  let pending = null;
  let lastLog = -Infinity;
  const expected = new Map(); // trace id -> last time it went out; oldest first
  const stats = { written: 0, dropped: 0, writeErrors: 0 };

  const on = () => {
    try {
      return !!enabled();
    } catch {
      return false;
    }
  };
  // `expected` is in last-sent order, so walk from the oldest and stop at the first entry that is neither expired
  // nor needed to get back under the cap.
  function remember(t) {
    expected.delete(t);
    const at = now();
    expected.set(t, at);
    for (const [id, last] of expected) {
      if (expected.size <= maxKnown && at - last <= knownMs) break;
      expected.delete(id);
    }
  }
  function push(records) {
    let n = 0;
    for (const r of records) {
      if (buf.length >= maxBuffer) {
        stats.dropped++;
        continue;
      }
      buf.push(r);
      n++;
    }
    if (buf.length >= batch) {
      // Never write on the request path: the span that fills the batch only schedules it.
      if (!pending) {
        pending = setImmediate(() => {
          pending = null;
          flush();
        });
        if (pending.unref) pending.unref();
      }
    } else if (flushMs > 0 && buf.length && !timer) {
      timer = setTimeout(flush, flushMs);
      if (timer.unref) timer.unref();
    }
    return n;
  }
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!buf.length) return 0;
    const list = buf;
    buf = [];
    try {
      const n = Number(store.writeSpans(list)) || 0;
      stats.written += n;
      return n;
    } catch (err) {
      stats.writeErrors++;
      stats.dropped += list.length;
      if (now() - lastLog > 60000) {
        lastLog = now();
        try {
          log(`traces: write failed: ${err.message}`);
        } catch {
          /* logging must not fail a request */
        }
      }
      return 0;
    }
  }

  return {
    enabled: on,
    add(rec) {
      try {
        if (!on()) return;
        let record;
        try {
          record = toRecord(rec);
        } catch {
          stats.dropped++; // a span that cannot be converted is not kept
          return;
        }
        push([record]);
      } catch {
        /* nothing here may reach a request */
      }
    },
    ingest(records) {
      try {
        if (!on()) return 0;
        const good = [];
        for (const r of records) {
          const c = clean(r);
          if (c) good.push(c);
          else stats.dropped++;
        }
        return push(good);
      } catch {
        return 0;
      }
    },
    flush,
    // A traceparent of this trace was sent to a remote agent or MCP server: accept its spans back for knownMs.
    expect(t) {
      try {
        if (on() && typeof t === 'string' && HEX32.test(t) && !/^0+$/.test(t)) remember(t);
      } catch {
        /* nothing here may reach a request */
      }
    },
    knows(t) {
      const at = expected.get(t);
      return at !== undefined && now() - at <= knownMs;
    },
    stats: () => ({ buffered: buf.length, ...stats }),
  };
}

module.exports = { createRecorder, toRecord, CONTENT_KEYS, REMOTE_KEYS };
