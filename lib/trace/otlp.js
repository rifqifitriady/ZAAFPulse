// The return channel: OTLP/HTTP JSON spans from a remote agent or MCP server, kept only for traces whose
// traceparent this ZAAFPulse sent out in the last 24 hours (recorder.expect: a 128-bit trace id only the callee was
// given works as a capability) and at most maxPerTrace per trace. It is not a general OTLP backend, and like the
// rest of the store it keeps no content: a span keeps only the attributes on an allow-list (REMOTE_KEYS), so no
// field we compute (zaafpulse.* attributes: cost, run id) and no prompt or reply text under any convention's key.
// Numbers that are not finite are dropped.
const { REMOTE_KEYS } = require('./recorder');

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO = /^0+$/;
const KINDS = { 1: 'internal', 2: 'server', 3: 'client', SPAN_KIND_INTERNAL: 'internal', SPAN_KIND_SERVER: 'server', SPAN_KIND_CLIENT: 'client' };
const MAX_ATTRS = 64;

const finite = (n) => (Number.isFinite(n) ? n : undefined);
// undefined: not kept (not an OTLP value, or a number that is not finite).
function valueOf(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return String(v.stringValue).slice(0, 1000);
  if ('intValue' in v) return finite(Number(v.intValue));
  if ('doubleValue' in v) return finite(Number(v.doubleValue));
  if ('boolValue' in v) return !!v.boolValue;
  return JSON.stringify(v.arrayValue || v.kvlistValue || null).slice(0, 1000);
}
// The attributes in `allowed` of an OTLP attribute list.
function attrsOf(list, allowed) {
  const out = {};
  for (const kv of (Array.isArray(list) ? list : []).slice(0, MAX_ATTRS)) {
    if (!kv || typeof kv.key !== 'string' || !allowed.has(kv.key)) continue;
    const v = valueOf(kv.value);
    if (v !== undefined) out[kv.key] = v;
  }
  return out;
}
const RESOURCE_KEYS = new Set(['service.name']);
// Nanoseconds as a BigInt, or null when the value is not a whole number.
const nsOf = (nano) => {
  try {
    return nano === undefined || nano === null ? null : BigInt(String(nano));
  } catch {
    return null;
  }
};
// An OTLP list: omitted means empty (proto3 JSON leaves out empty lists); anything but an array is malformed.
const listOf = (v) => (v === undefined ? [] : Array.isArray(v) ? v : null);
const OWN_SERVICE = 'zaafpulse';
const id = (v, re) => {
  const s = String(v || '').toLowerCase();
  return re.test(s) && !ZERO.test(s) ? s : null;
};

function createReceiver({ recorder, maxPerTrace = 2000, maxTraces = 10000 }) {
  const counts = new Map(); // trace id -> spans accepted from outside; last accepted last
  function count(t, n) {
    counts.delete(t);
    counts.set(t, n);
    // The oldest go first, so a trace still receiving spans keeps its limit.
    for (const k of counts.keys()) {
      if (counts.size <= maxTraces) break;
      counts.delete(k);
    }
  }
  function receive(body) {
    let rejected = 0;
    const out = [];
    const resources = body && typeof body === 'object' ? listOf(body.resourceSpans) : [];
    if (!resources) rejected++;
    for (const rs of resources || []) {
      const scopes = rs && typeof rs === 'object' ? listOf(rs.scopeSpans) : null;
      if (!scopes) {
        rejected++;
        continue;
      }
      const svc = String(attrsOf(rs.resource && rs.resource.attributes, RESOURCE_KEYS)['service.name'] || 'remote').slice(0, 100);
      // Our own OTLP export pointed back at this server: those spans are stored already.
      const own = svc === OWN_SERVICE;
      for (const ss of scopes) {
        const spans = ss && typeof ss === 'object' ? listOf(ss.spans) : null;
        if (!spans) {
          rejected++;
          continue;
        }
        for (const s of spans) {
          if (own || !s || typeof s !== 'object') {
            rejected++;
            continue;
          }
          const t = id(s.traceId, TRACE_ID);
          const sid = id(s.spanId, SPAN_ID);
          const p = s.parentSpanId ? id(s.parentSpanId, SPAN_ID) : null;
          const n = t ? counts.get(t) || 0 : 0;
          // A span without a sane start would sort first and pass for the trace's root.
          const startNs = nsOf(s.startTimeUnixNano);
          const endNs = nsOf(s.endTimeUnixNano);
          const st = startNs === null ? 0 : Number(startNs / 1000n);
          if (
            !t ||
            !sid ||
            (s.parentSpanId && !p) ||
            !(st > 0) ||
            endNs === null ||
            endNs < startNs ||
            !recorder.knows(t) ||
            n >= maxPerTrace
          ) {
            rejected++;
            continue;
          }
          count(t, n + 1);
          const failed = !!s.status && (s.status.code === 2 || s.status.code === 'STATUS_CODE_ERROR');
          out.push({
            t,
            s: sid,
            p,
            n: String(s.name || 'span').slice(0, 200),
            k: KINDS[s.kind] || 'internal',
            st,
            d: Number(endNs / 1000n) - st,
            ok: !failed,
            ...(failed ? { err: String(s.status.message || 'error').slice(0, 200) } : {}),
            src: 'remote',
            svc,
            a: attrsOf(s.attributes, REMOTE_KEYS),
          });
        }
      }
    }
    // What the recorder could not keep (tracing off, buffer full) is rejected too.
    if (out.length) rejected += out.length - (Number(recorder.ingest(out)) || 0);
    return rejected
      ? {
          partialSuccess: {
            rejectedSpans: rejected,
            errorMessage:
              'dropped spans of traces this ZAAFPulse did not send out, malformed, from ZAAFPulse itself, over the per-trace limit, or not stored',
          },
        }
      : {};
  }
  return { receive };
}

module.exports = { createReceiver };
