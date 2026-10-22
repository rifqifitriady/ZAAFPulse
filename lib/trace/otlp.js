// The return channel: OTLP/HTTP JSON spans from a remote agent or MCP server, kept only for traces this ZAAFPulse
// started in the last 24 hours (the recorder saw them go out: a 128-bit trace id only the callee was given works
// as a capability) and at most maxPerTrace per trace. It is not a general OTLP backend, and like the rest of the
// store it keeps no content attributes.
const { CONTENT_KEYS } = require('./recorder');

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO = /^0+$/;
const KINDS = { 1: 'internal', 2: 'server', 3: 'client', SPAN_KIND_INTERNAL: 'internal', SPAN_KIND_SERVER: 'server', SPAN_KIND_CLIENT: 'client' };
const MAX_ATTRS = 64;

function valueOf(v = {}) {
  if ('stringValue' in v) return String(v.stringValue).slice(0, 1000);
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return !!v.boolValue;
  return JSON.stringify(v.arrayValue || v.kvlistValue || null).slice(0, 1000);
}
function attrsOf(list) {
  const out = {};
  for (const kv of (Array.isArray(list) ? list : []).slice(0, MAX_ATTRS)) {
    if (!kv || typeof kv.key !== 'string' || CONTENT_KEYS.has(kv.key)) continue;
    out[kv.key.slice(0, 100)] = valueOf(kv.value || {});
  }
  return out;
}
const usOf = (nano) => {
  try {
    return Number(BigInt(String(nano)) / 1000n);
  } catch {
    return 0;
  }
};
const id = (v, re) => {
  const s = String(v || '').toLowerCase();
  return re.test(s) && !ZERO.test(s) ? s : null;
};

function createReceiver({ recorder, maxPerTrace = 2000 }) {
  const counts = new Map(); // trace id -> spans accepted from outside
  function receive(body) {
    let rejected = 0;
    const out = [];
    for (const rs of (body && Array.isArray(body.resourceSpans) && body.resourceSpans) || []) {
      const svc = String(attrsOf(rs && rs.resource && rs.resource.attributes)['service.name'] || 'remote').slice(0, 100);
      for (const ss of (rs && rs.scopeSpans) || [])
        for (const s of (ss && ss.spans) || []) {
          const t = id(s && s.traceId, TRACE_ID);
          const sid = id(s && s.spanId, SPAN_ID);
          const p = s && s.parentSpanId ? id(s.parentSpanId, SPAN_ID) : null;
          const n = t ? counts.get(t) || 0 : 0;
          if (!t || !sid || (s.parentSpanId && !p) || !recorder.knows(t) || n >= maxPerTrace) {
            rejected++;
            continue;
          }
          counts.set(t, n + 1);
          const st = usOf(s.startTimeUnixNano);
          const failed = !!s.status && (s.status.code === 2 || s.status.code === 'STATUS_CODE_ERROR');
          out.push({
            t,
            s: sid,
            p,
            n: String(s.name || 'span').slice(0, 200),
            k: KINDS[s.kind] || 'internal',
            st,
            d: Math.max(0, usOf(s.endTimeUnixNano) - st),
            ok: !failed,
            ...(failed ? { err: String(s.status.message || 'error').slice(0, 200) } : {}),
            src: 'remote',
            svc,
            a: attrsOf(s.attributes),
          });
        }
    }
    if (out.length) recorder.ingest(out);
    if (counts.size > 10000) counts.clear();
    return rejected
      ? {
          partialSuccess: {
            rejectedSpans: rejected,
            errorMessage: 'dropped spans of traces this ZAAFPulse did not start, with malformed ids, or over the per-trace limit',
          },
        }
      : {};
  }
  return { receive };
}

module.exports = { createReceiver };
