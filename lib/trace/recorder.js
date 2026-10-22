// The local sink of lib/otel.js: every finished span becomes a compact record (microseconds, no content) and
// waits in a bounded buffer until it is written to the trace store, once a second or every `batch` spans. It
// also remembers which trace IDs it saw, so the return channel accepts spans for those traces only. Nothing here
// may throw into a request or a run.
const KIND = { 1: 'internal', 2: 'server', 3: 'client' };
// Prompt, reply and tool text that OTLP export may carry with captureContent; the store never keeps it.
const CONTENT_KEYS = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]);

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
    ...(failed ? { err: String(r.status.message || 'error').slice(0, 200) } : {}),
    src: 'gateway',
    svc: 'zaafpulse',
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
  log = console.error,
  now = Date.now,
}) {
  let buf = [];
  let timer = null;
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
  function remember(t) {
    seen.delete(t);
    seen.set(t, now());
    if (seen.size > 100000) for (const [id, at] of seen) if (now() - at > knownMs || seen.size > 100000) seen.delete(id);
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
    if (buf.length >= batch) flush();
    else if (flushMs > 0 && buf.length && !timer) {
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
      const n = store.writeSpans(list);
      stats.written += n;
      return n;
    } catch (err) {
      stats.writeErrors++;
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
        remember(rec.traceId);
        push([toRecord(rec)]);
      } catch {
        /* a span that cannot be converted is not kept */
      }
    },
    ingest: (records) => (on() ? push(records) : 0),
    flush,
    knows(t) {
      const at = seen.get(t);
      return at !== undefined && now() - at <= knownMs;
    },
    stats: () => ({ buffered: buf.length, ...stats }),
  };
}

module.exports = { createRecorder, toRecord, CONTENT_KEYS };
