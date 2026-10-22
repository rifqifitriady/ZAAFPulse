// The local sink of lib/otel.js: every finished span becomes a compact record (microseconds, no content) and
// waits in a bounded buffer until it is written to the trace store, once a second or every `batch` spans. It
// also remembers which trace IDs it saw, so the return channel accepts spans for those traces only. Nothing here
// may throw into a request or a run.
const { secretSpans } = require('../signals');
const KIND = { 1: 'internal', 2: 'server', 3: 'client' };
// Prompt, reply and tool text that OTLP export may carry with captureContent; the store never keeps it.
const CONTENT_KEYS = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]);

const MAX_ERR = 200;
const MAX_KNOWN = 100000;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

// Secrets in an error message never reach the store; same marker as the explorer's titles.
function maskErr(text) {
  const s = String(text);
  let out = '';
  let last = 0;
  for (const sp of secretSpans(s)) {
    out += s.slice(last, sp.start) + `\u2039${sp.label} hidden\u203a`;
    last = sp.end;
  }
  out = (out + s.slice(last)).slice(0, MAX_ERR);
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

// A record from the return channel is stored without content attributes and with a masked error.
function clean(r) {
  const a = {};
  for (const [k, v] of Object.entries(r.a || {})) if (!CONTENT_KEYS.has(k)) a[k] = v;
  const out = { ...r, a };
  if (r.err !== undefined) out.err = maskErr(r.err);
  return out;
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
  const seen = new Map(); // trace id -> last time seen; oldest first
  const stats = { written: 0, dropped: 0, writeErrors: 0 };

  const on = () => {
    try {
      return !!enabled();
    } catch {
      return false;
    }
  };
  // `seen` is in last-seen order, so walk from the oldest and stop at the first entry that is neither expired nor
  // needed to get back under the cap.
  function remember(t) {
    seen.delete(t);
    const at = now();
    seen.set(t, at);
    for (const [id, last] of seen) {
      if (seen.size <= maxKnown && at - last <= knownMs) break;
      seen.delete(id);
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
          stats.dropped++; // a span that cannot be converted is not kept, nor is its trace remembered
          return;
        }
        remember(rec.traceId);
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
          if (r && typeof r === 'object' && HEX32.test(r.t) && HEX16.test(r.s)) good.push(clean(r));
          else stats.dropped++;
        }
        return push(good);
      } catch {
        return 0;
      }
    },
    flush,
    knows(t) {
      const at = seen.get(t);
      return at !== undefined && now() - at <= knownMs;
    },
    stats: () => ({ buffered: buf.length, ...stats }),
  };
}

module.exports = { createRecorder, toRecord, CONTENT_KEYS };
