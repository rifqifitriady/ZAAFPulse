// OpenTelemetry trace export for ZAAFPulse, without dependencies. Spans go to any OTLP/HTTP endpoint
// (Dynatrace, Arize Phoenix and AX, Langfuse, an OTel Collector) as binary protobuf (the OTLP default, and
// the only encoding Dynatrace and Phoenix accept) or as JSON. Off unless config.json has "otel": { "enabled": true }
// or OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set (and config.json does not turn it off).
//
// What becomes a span:
//   - every gateway request that reached a model or tool (SERVER span, continues an incoming W3C traceparent)
//   - every model call the gateway made (CLIENT span "chat {model}" / "embeddings {model}", GenAI semconv)
//   - collaboration runs, converted from the run's own trace when it ends (invoke_workflow, invoke_agent,
//     execute_tool, plan, judge)
//   - integration tool calls (execute_tool {tool})
// Prompt, completion and tool argument text is recorded only with "captureContent": true, and capped.
//
// Semantic conventions: OpenTelemetry GenAI semconv from open-telemetry/semantic-conventions-genai
// (schema gen-ai-dev/1.42.0-dev, main at 547934a, 2026-10-18), on core semconv v1.44.0.
//
// The exporter never blocks a request and never throws into one: spans go into a bounded queue (dropped
// and counted when full), are sent in batches, retried with backoff on 429/502/503/504 and network errors
// (honouring Retry-After), and flushed on shutdown.
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { AsyncLocalStorage } = require('async_hooks');
const { StringDecoder } = require('string_decoder');
const { isRef } = require('./secrets');

const SCOPE = 'zaafpulse';
const KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3 };
const STATUS = { UNSET: 0, OK: 1, ERROR: 2 };
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTRS = 128;
const MAX_VALUE = 8192;
const MAX_BODY = 1024 * 1024; // request/response bytes kept for parsing; larger bodies are not parsed
// Numbers that are always doubles, so a whole-number cost is not sent as an int on some spans.
const DOUBLE_KEYS = new Set([
  'zaafpulse.cost.usd',
  'gen_ai.response.time_to_first_chunk',
  'gen_ai.request.temperature',
  'gen_ai.request.top_p',
]);
// Header names whose value must come from the secret store or the environment, never config.json text.
const SENSITIVE_HEADER = /authorization|api[-_]?key|token|secret|password|cookie/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

// semconv gen_ai.provider.name for the gateway's provider presets; other presets are sent as their own id.
const PROVIDER_NAME = {
  openai: 'openai',
  anthropic: 'anthropic',
  'anthropic-openai': 'anthropic',
  gemini: 'gcp.gemini',
  vertex: 'gcp.vertex_ai',
  bedrock: 'aws.bedrock',
  'azure-openai': 'azure.ai.openai',
  mistral: 'mistral',
  cohere: 'cohere',
  xai: 'x_ai',
  deepseek: 'deepseek',
  perplexity: 'perplexity',
  groq: 'groq',
  moonshot: 'moonshot_ai',
};

/* ---------- ids and W3C trace context ---------- */
const ZERO = /^0+$/;
function newId(bytes) {
  let id;
  do id = crypto.randomBytes(bytes).toString('hex');
  while (ZERO.test(id));
  return id;
}
// W3C Trace Context level 1: version-traceid-parentid-flags, lowercase hex. Future versions may append fields.
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
function parseTraceparent(value) {
  if (typeof value !== 'string') return null;
  const m = TRACEPARENT.exec(value.trim());
  if (!m) return null;
  const [, version, traceId, spanId, flags, rest] = m;
  if (version === 'ff' || (version === '00' && rest)) return null;
  if (ZERO.test(traceId) || ZERO.test(spanId)) return null;
  const f = parseInt(flags, 16);
  return { traceId, spanId, flags: f, sampled: (f & 1) === 1 };
}
const formatTraceparent = (c) => `00-${c.traceId}-${c.spanId}-${c.sampled ? '01' : '00'}`;
// tracestate is passed on untouched when it looks sane (printable, at most 512 characters).
const cleanTracestate = (v) => (typeof v === 'string' && v.length <= 512 && /^[\x20-\x7e]*$/.test(v) ? v.trim() : '');
const hashId = (text, bytes) =>
  crypto
    .createHash('sha256')
    .update(text)
    .digest('hex')
    .slice(0, bytes * 2);

/* ---------- time ---------- */
const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;
const msToNs = (ms) => BigInt(Math.round(Number(ms) * 1000)) * 1000n;

/* ---------- masking ---------- */
// Credentials that may show up in upstream error text, whatever secret store they came from.
const GENERIC_SECRETS = [
  [/\b(Bearer|Basic|Api-Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '***'],
  [/\bdt0[a-z]\d{2}\.[A-Za-z0-9._-]{16,}/g, '***'],
  [/((?:api[-_]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi, '$1***'],
];
function scrub(text) {
  let s = String(text ?? '');
  for (const [re, to] of GENERIC_SECRETS) s = s.replace(re, to);
  return s;
}

/* ---------- attribute values ---------- */
function cleanValue(v) {
  if (typeof v === 'string') return v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}…` : v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) {
    const out = v
      .slice(0, 64)
      .map(cleanValue)
      .filter((x) => x !== undefined && !Array.isArray(x));
    return out;
  }
  return undefined;
}
function jsonValue(key, v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) && !DOUBLE_KEYS.has(key) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => jsonValue('', x)) } };
  return { stringValue: String(v) };
}

/* ---------- protobuf (the subset of the OTLP trace schema we write, and the response we read) ---------- */
function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}
class PbWriter {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  raw(b) {
    this.parts.push(b);
    this.length += b.length;
  }
  tag(field, wire) {
    this.raw(varint((field << 3) | wire));
  }
  varint(field, n) {
    this.tag(field, 0);
    this.raw(varint(n));
  }
  bytes(field, buf) {
    this.tag(field, 2);
    this.raw(varint(buf.length));
    this.raw(buf);
  }
  string(field, s) {
    this.bytes(field, Buffer.from(String(s), 'utf8'));
  }
  message(field, w) {
    this.bytes(field, w.finish());
  }
  fixed64(field, big) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt.asUintN(64, big));
    this.tag(field, 1);
    this.raw(b);
  }
  double(field, d) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(d);
    this.tag(field, 1);
    this.raw(b);
  }
  fixed32(field, n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    this.tag(field, 5);
    this.raw(b);
  }
  finish() {
    return Buffer.concat(this.parts, this.length);
  }
}
// AnyValue is a oneof: its field is written even when it holds the default (0, false, "").
function pbValue(key, v) {
  const w = new PbWriter();
  if (typeof v === 'string') w.string(1, v);
  else if (typeof v === 'boolean') w.varint(2, v ? 1 : 0);
  else if (typeof v === 'number' && Number.isInteger(v) && !DOUBLE_KEYS.has(key)) w.varint(3, v);
  else if (typeof v === 'number') w.double(4, v);
  else if (Array.isArray(v)) {
    const a = new PbWriter();
    for (const x of v) a.message(1, pbValue('', x));
    w.message(5, a);
  } else w.string(1, String(v));
  return w;
}
function pbAttributes(w, field, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    const kv = new PbWriter();
    kv.string(1, k);
    kv.message(2, pbValue(k, v));
    w.message(field, kv);
  }
}
function pbSpan(s) {
  const w = new PbWriter();
  w.bytes(1, Buffer.from(s.traceId, 'hex'));
  w.bytes(2, Buffer.from(s.spanId, 'hex'));
  if (s.traceState) w.string(3, s.traceState);
  if (s.parentSpanId) w.bytes(4, Buffer.from(s.parentSpanId, 'hex'));
  w.string(5, s.name);
  if (s.kind) w.varint(6, s.kind);
  w.fixed64(7, s.startNs);
  w.fixed64(8, s.endNs);
  pbAttributes(w, 9, s.attributes);
  if (s.dropped) w.varint(10, s.dropped);
  if (s.status.code || s.status.message) {
    const st = new PbWriter();
    if (s.status.message) st.string(2, s.status.message);
    if (s.status.code) st.varint(3, s.status.code);
    w.message(15, st);
  }
  w.fixed32(16, s.flags);
  return w;
}
function encodeProtobuf(batch, resource) {
  const scope = new PbWriter();
  scope.string(1, SCOPE);
  scope.string(2, resource['service.version'] || '');
  const ss = new PbWriter();
  ss.message(1, scope);
  for (const s of batch) ss.message(2, pbSpan(s));
  const res = new PbWriter();
  pbAttributes(res, 1, resource);
  const rs = new PbWriter();
  rs.message(1, res);
  rs.message(2, ss);
  const req = new PbWriter();
  req.message(1, rs);
  return req.finish();
}
function encodeJson(batch, resource) {
  const attrs = (o) => Object.entries(o).map(([key, v]) => ({ key, value: jsonValue(key, v) }));
  return Buffer.from(
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: attrs(resource) },
          scopeSpans: [
            {
              scope: { name: SCOPE, version: resource['service.version'] || '' },
              spans: batch.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.traceState ? { traceState: s.traceState } : {}),
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                flags: s.flags,
                name: s.name,
                kind: s.kind,
                startTimeUnixNano: String(s.startNs),
                endTimeUnixNano: String(s.endNs),
                attributes: attrs(s.attributes),
                ...(s.dropped ? { droppedAttributesCount: s.dropped } : {}),
                status: { ...(s.status.message ? { message: s.status.message } : {}), code: s.status.code },
              })),
            },
          ],
        },
      ],
    }),
  );
}
// ExportTraceServiceResponse: { partial_success (1): { rejected_spans (1), error_message (2) } }.
function pbFields(buf) {
  const out = [];
  let i = 0;
  const readVarint = () => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated');
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(readVarint());
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ field, value: readVarint() });
    else if (wire === 2) {
      const len = Number(readVarint());
      out.push({ field, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('bad wire type');
  }
  return out;
}
function partialSuccess(protocol, body) {
  try {
    if (!body || !body.length) return { rejected: 0, message: '' };
    if (protocol === 'http/json') {
      const p = JSON.parse(body.toString('utf8')).partialSuccess || {};
      return { rejected: Number(p.rejectedSpans || 0), message: String(p.errorMessage || '') };
    }
    const ps = pbFields(body).find((f) => f.field === 1);
    if (!ps) return { rejected: 0, message: '' };
    const inner = pbFields(ps.value);
    const r = inner.find((f) => f.field === 1);
    const m = inner.find((f) => f.field === 2);
    return { rejected: r ? Number(r.value) : 0, message: m ? m.value.toString('utf8') : '' };
  } catch {
    return { rejected: 0, message: '' };
  }
}

/* ---------- settings from config.json and the standard OTEL_* environment ---------- */
function parseKv(text) {
  const out = {};
  for (const part of String(text || '').split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep as written */
    }
    if (k) out[k] = v;
  }
  return out;
}
const num = (...vals) => {
  for (const v of vals) {
    const n = Number(v);
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(n)) return n;
  }
  return undefined;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));
const tracesUrl = (base) => {
  const b = String(base).replace(/\/+$/, '');
  return /\/v1\/traces$/.test(b) ? b : `${b}/v1/traces`;
};

function buildSettings(cfg, env, secrets, version) {
  // On with "otel": { "enabled": true }, or when an OTLP endpoint variable is set (handy in Docker) and
  // config.json does not say "enabled": false. OTEL_SDK_DISABLED=true always turns it off.
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  const envEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (cfg.enabled === false || (cfg.enabled !== true && !envEndpoint)) return { enabled: false };
  if (String(env.OTEL_SDK_DISABLED || '').toLowerCase() === 'true') return { enabled: false, why: 'OTEL_SDK_DISABLED' };
  const url = cfg.tracesEndpoint
    ? String(cfg.tracesEndpoint)
    : cfg.endpoint
      ? tracesUrl(cfg.endpoint)
      : env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        ? String(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
        : env.OTEL_EXPORTER_OTLP_ENDPOINT
          ? tracesUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT)
          : 'http://localhost:4318/v1/traces';
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`otel.endpoint: "${url}" is not a URL`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('otel.endpoint: must start with http:// or https://');
  if (u.username || u.password) throw new Error('otel.endpoint: put credentials in otel.headers, not in the URL');
  const protocol = String(
    cfg.protocol || env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL || 'http/protobuf',
  );
  if (protocol === 'grpc') throw new Error('otel.protocol: gRPC is not supported; use http/protobuf (port 4318)');
  if (protocol !== 'http/protobuf' && protocol !== 'http/json')
    throw new Error('otel.protocol: use "http/protobuf" or "http/json"');

  // Headers: OTEL_EXPORTER_OTLP_HEADERS, then the traces-only variable, then config.json (case-insensitive).
  const headers = {};
  const masks = [];
  const put = (name, value) => {
    if (!HEADER_NAME.test(name)) throw new Error(`otel.headers: "${name}" is not a valid header name`);
    if (/[\r\n]/.test(value)) throw new Error(`otel.headers.${name}: line breaks are not allowed`);
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
    headers[name] = value;
  };
  for (const src of [env.OTEL_EXPORTER_OTLP_HEADERS, env.OTEL_EXPORTER_OTLP_TRACES_HEADERS])
    for (const [k, v] of Object.entries(parseKv(src))) {
      put(k, v);
      if (v.length >= 6) masks.push(v);
    }
  const ch = cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers) ? cfg.headers : {};
  for (const [k, v] of Object.entries(ch)) {
    if (isRef(v)) {
      const value = secrets.resolve(v, `otel.headers.${k}`);
      put(k, value);
      masks.push(value);
    } else if (typeof v === 'string' || typeof v === 'number') {
      if (SENSITIVE_HEADER.test(k))
        throw new Error(
          `otel.headers.${k}: plain-text secrets are not allowed in config.json; use { "keychain": "acc.otel" } or { "env": "NAME" }`,
        );
      put(k, String(v));
    } else throw new Error(`otel.headers.${k}: expected text or { "keychain": "acc.…" } / { "env": "NAME" }`);
  }

  const envRes = parseKv(env.OTEL_RESOURCE_ATTRIBUTES);
  const cfgRes =
    cfg.resourceAttributes && typeof cfg.resourceAttributes === 'object' && !Array.isArray(cfg.resourceAttributes)
      ? cfg.resourceAttributes
      : {};
  const resource = {};
  for (const [k, v] of Object.entries({ ...envRes, ...cfgRes })) {
    const c = cleanValue(v);
    if (c !== undefined && k) resource[k] = c;
  }
  Object.assign(resource, {
    'service.name': String(cfg.serviceName || env.OTEL_SERVICE_NAME || resource['service.name'] || 'zaafpulse'),
    'service.version': version,
    'telemetry.sdk.name': 'zaafpulse',
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': version,
  });
  const b = cfg.batch && typeof cfg.batch === 'object' ? cfg.batch : {};
  const r = cfg.retry && typeof cfg.retry === 'object' ? cfg.retry : {};
  const maxQueue = clamp(num(b.maxQueueSize, env.OTEL_BSP_MAX_QUEUE_SIZE) ?? 2048, 1, 100000);
  const compression = String(
    cfg.compression || env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION || env.OTEL_EXPORTER_OTLP_COMPRESSION || 'none',
  );
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
  return {
    enabled: true,
    url: u.toString(),
    protocol,
    headers,
    masks,
    resource,
    captureContent: cfg.captureContent === true,
    contentMaxChars: clamp(num(cfg.contentMaxChars) ?? 4096, 256, 65536),
    timeoutMs: clamp(
      num(cfg.timeoutMs, env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT, env.OTEL_EXPORTER_OTLP_TIMEOUT) ?? 10000,
      100,
      60000,
    ),
    compression: compression === 'gzip' ? 'gzip' : 'none',
    maxQueue,
    maxBatch: clamp(num(b.maxExportBatchSize, env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE) ?? 512, 1, maxQueue),
    delayMs: clamp(num(b.scheduleDelayMs, env.OTEL_BSP_SCHEDULE_DELAY) ?? 5000, 1, 600000),
    maxAttempts: clamp(num(r.maxAttempts) ?? 5, 1, 10),
    initialBackoffMs: clamp(num(r.initialBackoffMs) ?? 1000, 1, 60000),
    maxBackoffMs: clamp(num(r.maxBackoffMs) ?? 30000, 1, 300000),
    warning:
      u.protocol === 'http:' && !loopback && Object.keys(headers).length
        ? `otel: ${u.host} is plain http, so the export headers travel unencrypted`
        : '',
  };
}

/* ---------- transport ---------- */
function post(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: 'POST', headers: { ...headers, 'content-length': body.length } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size < 65536) chunks.push(c);
          size += c.length;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

// Retry-After is seconds or an HTTP date.
function retryAfterMs(v, now) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now()) : null;
}

/* ---------- exporter: bounded queue, batches, one export in flight, retry ---------- */
function createExporter(s, { transport, log, mask, now }) {
  const queue = [];
  const stats = { exported: 0, dropped: 0, failed: 0, rejected: 0, retries: 0, lastError: null, lastExportAt: null };
  let inflight = null;
  let timer = null;
  let closed = false;
  let deadline = Infinity;
  const sleepers = new Set();

  const sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      function done() {
        clearTimeout(t);
        sleepers.delete(done);
        resolve();
      }
      sleepers.add(done);
    });
  const fail = (n, msg) => {
    stats.failed += n;
    stats.lastError = mask(msg);
    log(`otel: export of ${n} spans to ${new URL(s.url).host} failed: ${stats.lastError}`, 'export');
  };

  async function send(batch) {
    let body;
    try {
      body = s.protocol === 'http/json' ? encodeJson(batch, s.resource) : encodeProtobuf(batch, s.resource);
    } catch (err) {
      return fail(batch.length, `could not encode spans: ${err.message}`);
    }
    const headers = {
      ...s.headers,
      'content-type': s.protocol === 'http/json' ? 'application/json' : 'application/x-protobuf',
      'user-agent': `zaafpulse/${s.resource['service.version']}`,
    };
    if (s.compression === 'gzip') {
      body = zlib.gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    for (let attempt = 1; ; attempt++) {
      let r;
      try {
        r = await transport(s.url, body, headers, Math.max(100, Math.min(s.timeoutMs, deadline - now())));
      } catch (err) {
        r = { error: err };
      }
      if (r.status >= 200 && r.status < 300) {
        const p = partialSuccess(s.protocol, r.body);
        stats.exported += batch.length - p.rejected;
        stats.rejected += p.rejected;
        stats.lastExportAt = now();
        if (p.rejected || p.message)
          log(`otel: the endpoint rejected ${p.rejected} of ${batch.length} spans: ${mask(p.message)}`, 'partial');
        return;
      }
      const why = r.error ? r.error.message : `HTTP ${r.status} ${String(r.body || '').slice(0, 200)}`;
      if (!(r.error || RETRYABLE.has(r.status)) || attempt >= s.maxAttempts) return fail(batch.length, why);
      const backoff = Math.min(s.maxBackoffMs, s.initialBackoffMs * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
      const after = r.headers ? retryAfterMs(r.headers['retry-after'], now) : null;
      const wait = Math.min(after ?? backoff, s.maxBackoffMs * 2);
      if (now() + wait >= deadline) return fail(batch.length, `${why} (no time left to retry before shutdown)`);
      stats.retries++;
      await sleep(wait);
      if (closed && now() >= deadline) return fail(batch.length, `${why} (shutting down)`);
    }
  }

  function kick() {
    if (inflight || !queue.length) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = queue.splice(0, s.maxBatch);
    inflight = send(batch)
      .catch((err) => fail(batch.length, err.message))
      .finally(() => {
        inflight = null;
        if (queue.length >= s.maxBatch || (closed && queue.length)) kick();
        else if (queue.length) schedule();
      });
  }
  function schedule() {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      kick();
    }, s.delayMs);
    timer.unref?.();
  }
  function add(rec) {
    if (closed || queue.length >= s.maxQueue) {
      stats.dropped++;
      if (stats.dropped === 1 || stats.dropped % 1000 === 0)
        log(`otel: span queue full (${s.maxQueue}); ${stats.dropped} spans dropped so far`, 'drop');
      return;
    }
    queue.push(rec);
    if (queue.length >= s.maxBatch) kick();
    else schedule();
  }
  // Sends everything queued; resolves when done or when timeoutMs runs out, whichever comes first.
  async function flush(timeoutMs = s.timeoutMs) {
    const until = now() + timeoutMs;
    while ((queue.length || inflight) && now() < until) {
      kick();
      let t;
      await Promise.race([inflight, new Promise((r) => (t = setTimeout(r, Math.max(1, until - now()))))]);
      clearTimeout(t);
    }
    return !queue.length && !inflight;
  }
  async function shutdown(timeoutMs = 2000) {
    closed = true;
    deadline = now() + timeoutMs;
    if (timer) clearTimeout(timer);
    timer = null;
    // A retry waiting out its backoff gives up now if the deadline would pass first.
    for (const wake of [...sleepers]) wake();
    return flush(timeoutMs);
  }
  return { add, flush, shutdown, stats, queued: () => queue.length };
}

/* ---------- content (only with captureContent) ---------- */
// Text is cut to `max` characters in total; the result is a JSON string (semconv allows that on spans).
function capParts(messages, max) {
  let left = max;
  const cut = (t) => {
    const s = String(t ?? '');
    if (left <= 0) return '…[truncated]';
    const out = s.length > left ? `${s.slice(0, left)}…[truncated]` : s;
    left -= Math.min(s.length, left);
    return out;
  };
  for (const m of messages)
    for (const p of m.parts || [])
      for (const k of ['content', 'arguments', 'response']) if (typeof p[k] === 'string') p[k] = cut(p[k]);
  return messages;
}
const textPart = (t) => ({ type: 'text', content: String(t) });
const otherPart = (type) => ({ type: String(type || 'unknown') });
const asText = (c) => (typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c));
function openaiParts(m) {
  const parts = [];
  if (typeof m.content === 'string') parts.push(textPart(m.content));
  else if (Array.isArray(m.content))
    for (const c of m.content) parts.push(c && c.type === 'text' ? textPart(c.text) : otherPart(c && c.type));
  for (const tc of m.tool_calls || [])
    parts.push({
      type: 'tool_call',
      id: tc.id,
      name: tc.function && tc.function.name,
      arguments: asText(tc.function && tc.function.arguments),
    });
  if (m.role === 'tool') return [{ type: 'tool_call_response', id: m.tool_call_id, response: asText(m.content) }];
  return parts;
}
function anthropicParts(content) {
  if (typeof content === 'string') return [textPart(content)];
  return (Array.isArray(content) ? content : []).map((c) =>
    c.type === 'text'
      ? textPart(c.text)
      : c.type === 'tool_use'
        ? { type: 'tool_call', id: c.id, name: c.name, arguments: asText(c.input) }
        : c.type === 'tool_result'
          ? { type: 'tool_call_response', id: c.tool_use_id, response: asText(c.content) }
          : otherPart(c.type),
  );
}
function geminiParts(parts) {
  return (Array.isArray(parts) ? parts : []).map((p) =>
    typeof p.text === 'string'
      ? textPart(p.text)
      : p.functionCall
        ? { type: 'tool_call', name: p.functionCall.name, arguments: asText(p.functionCall.args) }
        : p.functionResponse
          ? { type: 'tool_call_response', response: asText(p.functionResponse.response) }
          : otherPart(Object.keys(p)[0]),
  );
}
// The prompt of a gateway request, in semconv shape: { input: [...messages], system: [...parts] }.
function promptOf(format, body) {
  if (!body || typeof body !== 'object') return null;
  if (format === 'openai')
    return { input: (body.messages || []).map((m) => ({ role: m.role, parts: openaiParts(m) })), system: null };
  if (format === 'anthropic')
    return {
      input: (body.messages || []).map((m) => ({ role: m.role, parts: anthropicParts(m.content) })),
      system: body.system ? anthropicParts(body.system) : null,
    };
  if (format === 'responses') {
    const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || [];
    return {
      input: items.map((it) =>
        it.type === 'function_call'
          ? {
              role: 'assistant',
              parts: [{ type: 'tool_call', id: it.call_id, name: it.name, arguments: asText(it.arguments) }],
            }
          : it.type === 'function_call_output'
            ? { role: 'tool', parts: [{ type: 'tool_call_response', id: it.call_id, response: asText(it.output) }] }
            : {
                role: it.role || 'user',
                parts:
                  typeof it.content === 'string'
                    ? [textPart(it.content)]
                    : (it.content || []).map((c) =>
                        typeof c.text === 'string' ? textPart(c.text) : otherPart(c.type),
                      ),
              },
      ),
      system: body.instructions ? [textPart(body.instructions)] : null,
    };
  }
  if (format === 'gemini')
    return {
      input: (body.contents || []).map((c) => ({
        role: c.role === 'model' ? 'assistant' : c.role || 'user',
        parts: geminiParts(c.parts),
      })),
      system: body.systemInstruction ? geminiParts(body.systemInstruction.parts) : null,
    };
  return null;
}
const FINISH = {
  stop: 'stop',
  end_turn: 'stop',
  stop_sequence: 'stop',
  completed: 'stop',
  length: 'length',
  max_tokens: 'length',
  max_output_tokens: 'length',
  tool_calls: 'tool_call',
  tool_use: 'tool_call',
  function_call: 'tool_call',
  content_filter: 'content_filter',
  safety: 'content_filter',
  recitation: 'content_filter',
  refusal: 'content_filter',
  error: 'error',
  failed: 'error',
};
// Reads what the gateway sends back (JSON or server-sent events, in any of its four formats) for the
// response id, finish reasons and, with captureContent, the answer text.
function responseObserver(maxChars, keepText) {
  const st = { mode: null, buf: '', size: 0, id: '', reasons: [], text: '', over: false };
  const addText = (t) => {
    if (keepText && typeof t === 'string' && st.text.length < maxChars)
      st.text += t.slice(0, maxChars - st.text.length);
  };
  const reason = (r) => {
    if (r && typeof r === 'string') st.reasons.push(r);
  };
  function absorb(o) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.id === 'string' && !st.id && !o.type) st.id = o.id;
    if (typeof o.responseId === 'string') st.id = st.id || o.responseId;
    for (const c of o.choices || []) {
      if (c.message) addText(c.message.content);
      if (c.delta) addText(c.delta.content);
      reason(c.finish_reason);
    }
    for (const c of o.candidates || []) {
      for (const p of (c.content && c.content.parts) || []) addText(p.text);
      reason(c.finishReason && String(c.finishReason).toLowerCase());
    }
    if (o.type === 'message' || (Array.isArray(o.content) && o.role === 'assistant')) {
      st.id = st.id || o.id || '';
      for (const c of o.content || []) if (c.type === 'text') addText(c.text);
      reason(o.stop_reason);
    }
    if (o.type === 'message_start' && o.message) st.id = o.message.id || st.id;
    if (o.type === 'content_block_delta' && o.delta) addText(o.delta.text);
    if (o.type === 'message_delta' && o.delta) reason(o.delta.stop_reason);
    if (o.type === 'response.output_text.delta') addText(o.delta);
    const resp =
      o.object === 'response' ? o : /^response\.(completed|incomplete|failed)$/.test(o.type) ? o.response : null;
    if (resp) {
      st.id = resp.id || st.id;
      if (o.object === 'response')
        for (const it of resp.output || [])
          for (const c of it.content || []) if (c.type === 'output_text') addText(c.text);
      // The Responses API reports a status, not a stop reason.
      reason(
        resp.status === 'completed'
          ? 'stop'
          : resp.status === 'incomplete'
            ? (resp.incomplete_details && resp.incomplete_details.reason) || 'length'
            : resp.status === 'failed'
              ? 'error'
              : null,
      );
    }
  }
  function line(l) {
    const t = l.trim();
    if (!t.startsWith('data:')) return;
    const d = t.slice(5).trim();
    if (!d || d === '[DONE]') return;
    try {
      absorb(JSON.parse(d));
    } catch {
      /* not JSON */
    }
  }
  const dec = new StringDecoder('utf8');
  return {
    feed(chunk) {
      if (chunk == null || st.over) return;
      const s = typeof chunk === 'string' ? chunk : dec.write(Buffer.from(chunk));
      if (!st.mode) {
        const head = s.trimStart();
        if (!head) return;
        st.mode = head[0] === '{' || head[0] === '[' ? 'json' : 'sse';
      }
      if (st.mode === 'json') {
        st.size += s.length;
        if (st.size > MAX_BODY) {
          st.over = true;
          st.buf = '';
        } else st.buf += s;
        return;
      }
      st.buf += s;
      let nl;
      while ((nl = st.buf.indexOf('\n')) >= 0) {
        line(st.buf.slice(0, nl));
        st.buf = st.buf.slice(nl + 1);
      }
      if (st.buf.length > MAX_BODY) st.buf = '';
    },
    result() {
      if (st.mode === 'json' && st.buf) {
        try {
          const j = JSON.parse(st.buf);
          for (const o of Array.isArray(j) ? j : [j]) absorb(o);
        } catch {
          /* not JSON after all */
        }
      } else if (st.mode === 'sse' && st.buf) line(st.buf);
      st.buf = '';
      return { id: st.id, reasons: [...new Set(st.reasons)], text: st.text };
    },
  };
}

/* ---------- gateway request classification ---------- */
function llmFormat(method, path) {
  if (method !== 'POST') return null;
  if (path === '/v1/chat/completions') return 'openai';
  if (path === '/v1/messages') return 'anthropic';
  if (path === '/v1/responses') return 'responses';
  if (path === '/v1/embeddings') return 'embeddings';
  if (/^\/v1beta\/models\/.+:(generateContent|streamGenerateContent)$/.test(path)) return 'gemini';
  return null;
}
const traced = (path) =>
  /^\/(v1|v1beta)\//.test(path) || path === '/mcp' || path === '/a2a' || path.startsWith('/api/');
// Low-cardinality route for the span name: ids and model names become placeholders.
function routeOf(path) {
  return path
    .replace(/^\/v1beta\/models\/.+:([A-Za-z]+)$/, '/v1beta/models/{model}:$1')
    .split('/')
    .map((seg) =>
      /^[a-z]+_[A-Za-z0-9]{6,}$/.test(seg) || /^[0-9a-f-]{8,}$/i.test(seg) || /\d{4,}/.test(seg) ? '{id}' : seg,
    )
    .join('/');
}

/* ---------- the tracer ---------- */
// A run's own attribute names (zp.*) as exported: cost and agent have semconv or zaafpulse names.
function runAttrs(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'zp.cost_usd') out['zaafpulse.cost.usd'] = Number(v) || 0;
    else if (k === 'zp.agent') out['gen_ai.agent.id'] = v;
    else if (k.startsWith('zp.')) out[`zaafpulse.${k.slice(3)}`] = v;
    else out[k] = v;
  }
  return out;
}
// The exported id of a collaboration run's span: parents and children agree without any shared state.
const runSpanId = (runId, spanId) => hashId(`${runId}:${spanId}`, 8);

function createOtel({
  getConfig = () => null,
  secrets = { resolve: () => null, mask: (s) => s },
  env = process.env,
  version = '0.0.0',
  log = (msg) => console.error(msg),
  transport = post,
  now = Date.now,
  refreshMs = 2000,
  sink = null,
} = {}) {
  const als = new AsyncLocalStorage();
  let settings = { enabled: false };
  let exporter = null;
  let source = null; // the otel section the settings came from, as JSON (config.json is re-read when it changes)
  let checked = -Infinity;
  let error = null;
  const lastLog = new Map();
  // Every header secret this instance has used, so an exporter replaced by a config change still masks its own.
  const known = new Set();
  // The local trace store (lib/trace/recorder.js): spans are produced when export is on or the sink is.
  const sinkOn = () => {
    try {
      return !!sink && !!sink.enabled();
    } catch {
      return false;
    }
  };
  const live = (s) => !!(s && s.enabled) || sinkOn();
  // A traceparent of this trace left for a remote agent or MCP server: the sink accepts its spans back.
  function expectReturn(traceId) {
    try {
      if (sinkOn() && typeof sink.expect === 'function') sink.expect(traceId);
    } catch {
      /* the local store must not break a request */
    }
  }
  // With export off nothing is ever sent, so nothing of a request or reply is copied for content.
  const LOCAL = { enabled: false, captureContent: false, contentMaxChars: 4096 };

  const mask = (text) => {
    let s = String(text ?? '');
    for (const v of known) s = s.split(v).join('***');
    return scrub(secrets.mask ? secrets.mask(s) : s);
  };
  // Each kind of message at most once a minute, always masked.
  const say = (msg, kind = msg) => {
    const t = now();
    if (t - (lastLog.get(kind) || -Infinity) < 60000) return;
    lastLog.set(kind, t);
    try {
      log(mask(msg));
    } catch {
      /* logging must not fail a request */
    }
  };

  function current() {
    const t = now();
    if (t - checked < refreshMs) return settings;
    checked = t;
    let raw;
    try {
      raw = getConfig();
    } catch {
      raw = null;
    }
    const cfg = raw && typeof raw === 'object' ? raw.otel : undefined;
    let key;
    try {
      key = JSON.stringify(cfg ?? null);
    } catch {
      key = 'unreadable';
    }
    if (key === source) return settings;
    source = key;
    const old = exporter;
    try {
      settings = buildSettings(cfg, env, secrets, version);
      for (const v of settings.masks || []) if (v) known.add(v);
      error = null;
      if (settings.warning) say(settings.warning, 'plain-http');
    } catch (err) {
      settings = { enabled: false };
      error = mask(err.message);
      say(`otel: export is off: ${err.message}`, 'config');
    }
    exporter = settings.enabled ? createExporter(settings, { transport, log: say, mask, now }) : null;
    if (old) old.shutdown(settings.timeoutMs || 2000).catch(() => {});
    return settings;
  }
  const providers = () => {
    try {
      const g = (getConfig() || {}).gateway || {};
      return Array.isArray(g.providers) ? g.providers : [];
    } catch {
      return [];
    }
  };

  /* spans */
  function record(rec) {
    current(); // a span started directly (not through a hook) still picks up the current settings
    if (exporter) exporter.add(rec);
    if (sinkOn())
      try {
        sink.add(rec);
      } catch {
        /* the local store must not break a request */
      }
  }
  // parent: { traceId, spanId, sampled, traceState, remote }; null for a root span; omitted for a child of
  // the current request. traceId and spanId fix the ids of a root span or of a span whose id is known ahead.
  function startSpan(name, { kind = KIND.INTERNAL, attributes = {}, parent, startNs, traceId: tid, spanId } = {}) {
    let p = parent;
    if (p === undefined) {
      const ctx = als.getStore();
      p = null;
      if (ctx) {
        ctx.child();
        p = ctx.self;
      }
    }
    const traceId = p ? p.traceId : tid || newId(16);
    const sampled = p ? p.sampled !== false : true;
    const rec = {
      traceId,
      spanId: spanId || newId(8),
      parentSpanId: (p && p.spanId) || '',
      traceState: (p && p.traceState) || '',
      // Bits 0-7: W3C trace flags; 8: the remote-parent bit is known; 9: the parent is remote.
      flags: (sampled ? 1 : 0) | 0x100 | (p && p.remote ? 0x200 : 0),
      name: String(name).slice(0, 256),
      kind,
      startNs: startNs ?? nowNs(),
      endNs: 0n,
      attributes: {},
      dropped: 0,
      status: { code: STATUS.UNSET, message: '' },
    };
    let ended = false;
    const span = {
      context: { traceId, spanId: rec.spanId, sampled, traceState: rec.traceState },
      setAttribute(k, v) {
        const c = cleanValue(v);
        if (c === undefined || ended) return span;
        if (!(k in rec.attributes) && Object.keys(rec.attributes).length >= MAX_ATTRS) rec.dropped++;
        else rec.attributes[k] = c;
        return span;
      },
      setAttributes(o) {
        for (const [k, v] of Object.entries(o || {})) span.setAttribute(k, v);
        return span;
      },
      setStatus(code, message = '') {
        rec.status = { code, message: code === STATUS.ERROR ? mask(String(message)).slice(0, 500) : '' };
        return span;
      },
      fail(type, message) {
        span.setAttribute('error.type', String(type || '_OTHER'));
        return span.setStatus(STATUS.ERROR, message || '');
      },
      end(endNs) {
        if (ended) return;
        ended = true;
        rec.endNs = endNs ?? nowNs();
        if (rec.endNs < rec.startNs) rec.endNs = rec.startNs;
        if (sampled) record(rec);
      },
    };
    span.setAttributes(attributes);
    return span;
  }

  /* gateway requests: SERVER span, incoming traceparent, response details for model calls */
  function requestContext(req, res, s) {
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;
    const incoming = parseTraceparent(req.headers.traceparent);
    const format = llmFormat(req.method, path);
    const ctx = {
      self: {
        traceId: incoming ? incoming.traceId : newId(16),
        spanId: newId(8),
        sampled: incoming ? incoming.sampled : true,
        traceState: incoming ? cleanTracestate(req.headers.tracestate) : '',
      },
      parent: incoming ? { ...incoming, remote: true, traceState: cleanTracestate(req.headers.tracestate) } : null,
      startNs: nowNs(),
      format,
      pending: [],
      finished: false,
      children: 0,
      server: null,
      prompt: null,
      response: null,
      child() {
        ctx.children++;
        // A run that outlives its request: send the request span now so its children have a parent.
        if (ctx.server && !ctx.server.sent) {
          ctx.server.sent = true;
          ctx.server.span.end(ctx.server.endNs);
        }
      },
    };
    if (!ctx.self.sampled) return ctx;
    const max = s.contentMaxChars;
    const observer = format && format !== 'embeddings' ? responseObserver(max, s.captureContent) : null;
    if (observer) {
      // Watch what the gateway writes back; the bytes themselves pass through untouched.
      const write = res.write;
      const end = res.end;
      res.write = function (chunk, enc, cb) {
        try {
          observer.feed(chunk, enc);
        } catch {
          /* observing must never break the reply */
        }
        return write.call(this, chunk, enc, cb);
      };
      res.end = function (chunk, enc, cb) {
        try {
          if (chunk && typeof chunk !== 'function') observer.feed(chunk, enc);
        } catch {
          /* as above */
        }
        return end.call(this, chunk, enc, cb);
      };
    }
    if (observer && s.captureContent && typeof req[Symbol.asyncIterator] === 'function') {
      // Copy the request body as the gateway reads it (it reads with for await), to record the prompt.
      const iter = req[Symbol.asyncIterator].bind(req);
      const chunks = [];
      let size = 0;
      req[Symbol.asyncIterator] = function () {
        const it = iter();
        return {
          async next() {
            const r = await it.next();
            if (!r.done && size <= MAX_BODY) {
              size += r.value.length;
              chunks.push(Buffer.from(r.value));
            }
            if (r.done && size <= MAX_BODY && !ctx.prompt) {
              try {
                ctx.prompt = promptOf(format, JSON.parse(Buffer.concat(chunks).toString('utf8')));
              } catch {
                /* not JSON */
              }
            }
            return r;
          },
          return: (v) => (it.return ? it.return(v) : Promise.resolve({ done: true, value: v })),
          throw: (e) => (it.throw ? it.throw(e) : Promise.reject(e)),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      };
    }
    const done = () => {
      if (ctx.finished) return;
      ctx.finished = true;
      try {
        ctx.response = observer ? observer.result() : null;
        const status = res.statusCode;
        const route = routeOf(path);
        // Created at the end with the ids its children already point at.
        const span = startSpan(`${req.method} ${route}`, {
          kind: KIND.SERVER,
          parent: ctx.parent,
          traceId: ctx.self.traceId,
          spanId: ctx.self.spanId,
          startNs: ctx.startNs,
          attributes: {
            'http.request.method': req.method,
            'http.route': route,
            'url.path': path,
            'url.scheme': req.socket && req.socket.encrypted ? 'https' : 'http',
            'network.protocol.version': req.httpVersion,
            'http.response.status_code': status,
            ...(req.headers['user-agent']
              ? { 'user_agent.original': String(req.headers['user-agent']).slice(0, 256) }
              : {}),
          },
        });
        if (status >= 500) span.fail(String(status));
        ctx.server = { span, endNs: nowNs(), sent: false };
        // Model endpoints always get their span; other requests only when something happened inside them.
        if (format || ctx.children) {
          ctx.server.sent = true;
          span.end(ctx.server.endNs);
        }
        for (const { span: sp, entry } of ctx.pending.splice(0)) finishModelSpan(ctx, sp, entry);
      } catch {
        /* telemetry must not break the request */
      }
    };
    res.once('finish', done);
    res.once('close', done);
    return ctx;
  }

  function wrapHandler(handler) {
    return function tracedHandler(req, res) {
      let s;
      try {
        s = current();
      } catch {
        s = { enabled: false };
      }
      if (!live(s) || !traced(String(req.url || '').split('?')[0])) return handler.call(this, req, res);
      let ctx;
      try {
        ctx = requestContext(req, res, s.enabled ? s : LOCAL);
      } catch {
        return handler.call(this, req, res);
      }
      return als.run(ctx, () => handler.call(this, req, res));
    };
  }

  /* model calls: one CLIENT span per call the gateway made, from its usage entry */
  function onUsage(e) {
    try {
      if (!live(current()) || !e) return;
      const ctx = als.getStore();
      if (ctx && !ctx.self.sampled) return;
      const op = e.kind === 'embeddings' ? 'embeddings' : 'chat';
      const prov = providers().find((p) => p && p.id === e.provider) || {};
      const preset = prov.preset && prov.preset !== 'custom' ? prov.preset : e.provider;
      let server = {};
      try {
        const u = prov.baseUrl ? new URL(prov.baseUrl) : null;
        if (u)
          server = {
            'server.address': u.hostname,
            'server.port': Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
          };
      } catch {
        /* no usable base URL */
      }
      const end = Number(e.ts) || now();
      // Inside within(…, chatSpanId): the first successful call takes the id the caller reserved for it.
      const reserved = ctx && ctx.chatSpanId && !(e.status >= 400 || e.error) ? ctx.chatSpanId : null;
      if (reserved) ctx.chatSpanId = null;
      const span = startSpan(`${op} ${e.model}`, {
        kind: KIND.CLIENT,
        ...(reserved ? { spanId: reserved } : {}),
        startNs: msToNs(end - (Number(e.ms) || 0)),
        attributes: {
          'gen_ai.operation.name': op,
          'gen_ai.provider.name': PROVIDER_NAME[preset] || String(preset || '_OTHER'),
          'gen_ai.request.model': e.model,
          'gen_ai.response.model': e.routedTo || e.model,
          ...server,
          ...(e.stream !== undefined ? { 'gen_ai.request.stream': !!e.stream } : {}),
          ...(e.input || e.output || e.status < 400
            ? { 'gen_ai.usage.input_tokens': e.input || 0, 'gen_ai.usage.output_tokens': e.output || 0 }
            : {}),
          ...(e.cached ? { 'gen_ai.usage.cache_read.input_tokens': e.cached } : {}),
          ...(e.ttft != null && e.stream ? { 'gen_ai.response.time_to_first_chunk': e.ttft / 1000 } : {}),
          ...(e.sessionId ? { 'gen_ai.conversation.id': e.sessionId } : {}),
          ...(e.agent ? { 'gen_ai.agent.id': e.agent } : {}),
          'zaafpulse.cost.usd': Number(e.cost) || 0,
          'zaafpulse.api_key.id': e.keyId || 'dashboard',
          'zaafpulse.provider.id': e.provider,
          'zaafpulse.request.kind': e.kind || 'chat',
          ...(e.format ? { 'zaafpulse.request.format': e.format } : {}),
          ...(e.requested ? { 'zaafpulse.request.model_alias': e.requested } : {}),
          ...(e.savedTokens ? { 'zaafpulse.token_saver.saved_tokens': e.savedTokens } : {}),
        },
      });
      if (e.status >= 400 || e.error)
        span.fail(e.status === 599 ? 'network_error' : String(e.status || '_OTHER'), e.error || `HTTP ${e.status}`);
      // A reply the client is still receiving: its finish reasons and text come when the response ends.
      if (ctx && ctx.format && e.kind === 'chat' && !ctx.finished) return ctx.pending.push({ span, entry: e });
      if (ctx && ctx.format && e.kind === 'chat') return finishModelSpan(ctx, span, e);
      span.end(msToNs(end));
    } catch {
      /* telemetry must not break the request */
    }
  }
  function finishModelSpan(ctx, span, e) {
    const s = settings;
    const r = ctx.response;
    if (r && !(e.status >= 400)) {
      if (r.id) span.setAttribute('gen_ai.response.id', r.id.slice(0, 256));
      if (r.reasons.length) span.setAttribute('gen_ai.response.finish_reasons', r.reasons.slice(0, 16));
    }
    if (s.captureContent) {
      const max = s.contentMaxChars;
      if (ctx.prompt && ctx.prompt.input)
        span.setAttribute('gen_ai.input.messages', JSON.stringify(capParts(structuredClone(ctx.prompt.input), max)));
      if (ctx.prompt && ctx.prompt.system)
        span.setAttribute(
          'gen_ai.system_instructions',
          JSON.stringify(capParts([{ parts: structuredClone(ctx.prompt.system) }], max)[0].parts),
        );
      if (r && !(e.status >= 400) && (r.text || r.reasons.length))
        span.setAttribute(
          'gen_ai.output.messages',
          JSON.stringify([
            {
              role: 'assistant',
              parts: r.text ? [textPart(r.text.length >= max ? `${r.text}…[truncated]` : r.text)] : [],
              finish_reason: FINISH[String(r.reasons[0] || 'stop').toLowerCase()] || String(r.reasons[0]),
            },
          ]),
        );
    }
    span.end(msToNs(Number(e.ts) || now()));
  }
  /* collaboration runs: the run's own trace, converted when it ends */
  // `list`: this execution's spans in full (collab keeps them apart from run.trace, which the live view caps).
  function exportRun(run, list) {
    try {
      const s = current();
      if (!live(s) || !run) return;
      let spans = Array.isArray(list) ? list : null;
      if (!spans) {
        if (!Array.isArray(run.trace) || !run.trace.length) return;
        // A resumed run appends a new root each time it runs: send only this execution's spans.
        let from = run.trace.length - 1;
        while (from > 0 && !(run.trace[from].parent == null && /^invoke_workflow/.test(run.trace[from].name))) from--;
        spans = run.trace.slice(from);
      }
      if (!spans.length) return;
      const ctx = als.getStore();
      const fixed = run.otel && run.otel.traceId ? run.otel : null;
      if (fixed ? fixed.sampled === false : ctx && !ctx.self.sampled) return;
      if (ctx) ctx.child();
      // A run started by a request sits in that request's trace for good (run.otel); older runs as before.
      const traceId = fixed ? fixed.traceId : ctx ? ctx.self.traceId : hashId(`zaafpulse-run:${run.id}`, 16);
      const rootParent = fixed ? fixed.spanId || '' : ctx ? ctx.self.spanId : '';
      const traceState = !fixed && ctx ? ctx.self.traceState : '';
      const t0 = Number(run.createdAt) || now();
      const lastEnd = (Number(run.updatedAt) || now()) - t0;
      for (const sp of spans) {
        // Model calls already have their own span from the gateway, with provider and cache details.
        if (/^chat /.test(sp.name)) continue;
        const attrs = runAttrs(sp.attrs);
        let name = sp.name;
        if (attrs['gen_ai.operation.name'] === 'invoke_agent')
          name = `invoke_agent ${attrs['gen_ai.agent.name'] || attrs['gen_ai.agent.id'] || ''}`.trim();
        if (attrs['gen_ai.operation.name'] === 'execute_tool') attrs['gen_ai.tool.type'] = 'function';
        const root = sp.parent == null;
        if (root) {
          Object.assign(attrs, {
            'gen_ai.workflow.name': run.pattern,
            'zaafpulse.run.id': run.id,
            'zaafpulse.run.state': run.state,
            'zaafpulse.api_key.id': run.keyId || 'dashboard',
            ...(run.contextId ? { 'gen_ai.conversation.id': run.contextId } : {}),
          });
          if (s.captureContent) {
            attrs['gen_ai.input.messages'] = JSON.stringify(
              capParts([{ role: 'user', parts: [textPart(run.task || '')] }], s.contentMaxChars),
            );
            if (run.answer)
              attrs['gen_ai.output.messages'] = JSON.stringify(
                capParts(
                  [{ role: 'assistant', parts: [textPart(run.answer)], finish_reason: 'stop' }],
                  s.contentMaxChars,
                ),
              );
          }
        }
        const span = startSpan(name, {
          kind: KIND.INTERNAL,
          parent: { traceId, spanId: root ? rootParent : runSpanId(run.id, sp.parent), sampled: true, traceState },
          spanId: runSpanId(run.id, sp.id),
          startNs: msToNs(t0 + (Number(sp.start) || 0)),
          attributes: attrs,
        });
        if (sp.status === 'error') span.fail('_OTHER', sp.error || 'error');
        span.end(msToNs(t0 + (sp.end != null ? Number(sp.end) : lastEnd)));
      }
    } catch {
      /* telemetry must not break the run */
    }
  }

  // Runs fn with `parent` ({ traceId, spanId, sampled }) as the current span, so spans started inside it (model
  // calls, integration tools) nest under it. `chatSpanId` reserves an id for the first successful model call.
  // A tracing failure runs fn plainly; fn is called once either way, and its own errors reach the caller.
  function within(parent, fn, chatSpanId = null, { inTool = false } = {}) {
    let ctx = null;
    try {
      if (parent && parent.traceId && live(current())) {
        const outer = als.getStore();
        ctx = {
          self: {
            traceId: parent.traceId,
            spanId: parent.spanId || '',
            sampled: parent.sampled !== false,
            traceState: parent.traceState || '',
          },
          parent: null,
          format: null, // model calls inside end at once; the request's reply details stay with the request
          pending: [],
          finished: true,
          children: 0,
          server: null,
          chatSpanId,
          inTool, // a tool called from here is nested inside another tool's span
          child() {
            if (outer) outer.child();
          },
        };
      }
    } catch {
      ctx = null;
    }
    return ctx ? als.run(ctx, fn) : fn();
  }

  // The trace id of the request in progress, for its usage entry, so the explorer can tell which requests the
  // trace store holds. None when the request is not sampled (it is never stored) or nothing records spans.
  function usageTraceId() {
    try {
      const ctx = als.getStore();
      return ctx && ctx.self.sampled !== false && ctx.self.traceId && live(current()) ? ctx.self.traceId : null;
    } catch {
      return null;
    }
  }

  // A collaboration run's trace context, fixed when it starts: the request's span when there is one, else a
  // stable trace of its own. Kept in runs.json, so a resumed run and its model calls stay in one trace.
  function runContext(runId) {
    const ctx = als.getStore();
    return ctx
      ? { traceId: ctx.self.traceId, spanId: ctx.self.spanId, sampled: ctx.self.sampled !== false }
      : { traceId: hashId(`zaafpulse-run:${runId}`, 16), spanId: '', sampled: true };
  }

  // Spans for an agent run outside a collaboration run, with the interface of a run's rt.span, so the
  // orchestrator traces both the same way. null while nothing records spans.
  // Nothing in it throws into the run: a span that cannot start is a no-op span (id null).
  function spanBook() {
    try {
      if (!live(current())) return null;
    } catch {
      return null;
    }
    const open = new Map(); // span id -> span
    const names = new Map(); // span id -> span name
    const NOOP_SPAN = { id: null, end() {} };
    return {
      span(name, attributes = {}, parentId = null) {
        let sp;
        try {
          const p = parentId ? open.get(parentId) : null;
          sp = startSpan(name, { attributes: runAttrs(attributes), ...(p ? { parent: p.context } : {}) });
          open.set(sp.context.spanId, sp);
          names.set(sp.context.spanId, name);
        } catch {
          return NOOP_SPAN;
        }
        return {
          id: sp.context.spanId,
          end(more = {}, err = null) {
            try {
              sp.setAttributes(runAttrs(more));
              if (err) sp.fail('_OTHER', err.message || String(err));
              sp.end();
            } catch {
              /* telemetry must not break the run */
            }
          },
        };
      },
      within(id, fn) {
        let parent = null;
        let inTool = false;
        try {
          if (open.has(id)) {
            parent = open.get(id).context;
            inTool = String(names.get(id)).startsWith('execute_tool ');
          }
        } catch {
          parent = null;
        }
        // within() runs fn once and plainly when tracing fails.
        return parent ? within(parent, fn, null, { inTool }) : fn();
      },
      traceCtx(id) {
        try {
          return open.has(id) ? { ...open.get(id).context } : undefined;
        } catch {
          return undefined;
        }
      },
    };
  }

  /* integration tool calls */
  const NOOP = { end() {}, traceparent: null };
  function toolCall(name, entry = {}, args = {}) {
    try {
      const s = current();
      if (!live(s)) return NOOP;
      const ctx = als.getStore();
      if (ctx && !ctx.self.sampled) return NOOP;
      const span = startSpan(`execute_tool ${name}`, {
        kind: entry.type === 'acc' ? KIND.INTERNAL : KIND.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': name,
          'gen_ai.tool.type': 'extension',
          // Under the agent's own tool span: the summary counts the call once.
          ...(ctx && ctx.inTool ? { 'zaafpulse.tool.nested': true } : {}),
          'zaafpulse.integration.id': entry.id,
          'zaafpulse.integration.type': entry.type,
          ...(entry.type === 'mcp' ? { 'mcp.method.name': 'tools/call' } : {}),
          // Argument names only; values only with captureContent.
          'zaafpulse.tool.argument_names': Object.keys(args || {}).slice(0, 32),
          ...(s.captureContent
            ? { 'gen_ai.tool.call.arguments': mask(JSON.stringify(args ?? {})).slice(0, s.contentMaxChars) }
            : {}),
        },
      });
      // Only an MCP server is sent the traceparent as a remote callee that may send spans back.
      if (entry.type === 'mcp') expectReturn(span.context.traceId);
      return {
        // Sent on to an MCP server, so a server that traces continues this span.
        traceparent: formatTraceparent(span.context),
        end(ok, result) {
          try {
            const text = ((result && result.content) || []).map((c) => c.text || '').join('\n');
            if (!ok) span.fail('tool_error', s.captureContent ? text.slice(0, 200) : 'the tool returned an error');
            else if (s.captureContent && text)
              span.setAttribute('gen_ai.tool.call.result', mask(text).slice(0, s.contentMaxChars));
            span.end();
          } catch {
            /* as above */
          }
        },
      };
    } catch {
      return NOOP;
    }
  }

  function status() {
    const s = current();
    return {
      enabled: !!s.enabled,
      ...(error ? { error } : {}),
      ...(s.enabled
        ? {
            endpoint: s.url,
            protocol: s.protocol,
            headers: Object.fromEntries(
              Object.keys(s.headers).map((k) => [
                k,
                SENSITIVE_HEADER.test(k) || s.masks.includes(s.headers[k]) ? '***' : s.headers[k],
              ]),
            ),
            serviceName: s.resource['service.name'],
            captureContent: s.captureContent,
            queued: exporter ? exporter.queued() : 0,
            stats: exporter ? { ...exporter.stats } : null,
          }
        : {}),
    };
  }
  const flush = (ms) => (exporter ? exporter.flush(ms) : Promise.resolve(true));
  const shutdown = (ms = 2000) => (exporter ? exporter.shutdown(ms).catch(() => false) : Promise.resolve(true));
  const active = () => {
    const ctx = als.getStore();
    return ctx ? ctx.self : null;
  };
  return {
    wrapHandler,
    exportRun,
    toolCall,
    expectReturn,
    startSpan,
    onUsage,
    status,
    flush,
    shutdown,
    active,
    current,
    live: () => live(current()),
    usageTraceId,
    within,
    runContext,
    spanBook,
  };
}

/* ---------- the process-wide instance used by the hooks ---------- */
let instance = null;
const get = () => instance;
module.exports = {
  // server.js: once at startup. getConfig returns the parsed config.json (re-read when it changes).
  init(opts) {
    if (instance) instance.shutdown(500);
    instance = createOtel(opts);
    return instance;
  },
  reset() {
    const i = instance;
    instance = null;
    return i ? i.shutdown(500) : Promise.resolve(true);
  },
  // The handler is wrapped once; whether a request is traced is decided per request.
  wrapHandler: (h) =>
    function (req, res) {
      return instance ? instance.wrapHandler(h).call(this, req, res) : h.call(this, req, res);
    },
  // Each hook below is a no-op until init() and while nothing records spans (OTLP export off and the local trace
  // store off), and none of them throws into a request or a run.
  wrapUsage: (u) => {
    if (!u || typeof u.record !== 'function') return u;
    const recordUsage = u.record;
    u.record = (e) => {
      let traceId = null;
      try {
        traceId = instance && e && typeof e === 'object' ? instance.usageTraceId() : null;
      } catch {
        /* tracing never fails a request */
      }
      const entry = recordUsage(traceId ? { ...e, traceId } : e);
      if (instance) instance.onUsage(entry);
      return entry;
    };
    return u;
  },
  exportRun: (run, spans) => instance && instance.exportRun(run, spans),
  within: (parent, fn, chatSpanId, opts) => (instance ? instance.within(parent, fn, chatSpanId, opts) : fn()),
  runContext: (runId) =>
    instance ? instance.runContext(runId) : { traceId: hashId(`zaafpulse-run:${runId}`, 16), spanId: '', sampled: true },
  runSpanId,
  spanBook: () => {
    try {
      return instance ? instance.spanBook() : null;
    } catch {
      return null; // tracing never fails a run
    }
  },
  toolCall: (name, entry, args) => (instance ? instance.toolCall(name, entry, args) : { end() {}, traceparent: null }),
  // Never throws: tracing never fails a request or a run.
  expectReturn: (traceId) => {
    try {
      if (instance) instance.expectReturn(traceId);
    } catch {
      /* as above */
    }
  },
  // A span the caller ends itself; null while nothing records spans.
  startSpan: (name, opts) => {
    try {
      return instance && instance.live() ? instance.startSpan(name, opts) : null;
    } catch {
      return null; // tracing never fails a request or a run
    }
  },
  KIND,
  status: () => (instance ? instance.status() : { enabled: false }),
  flush: (ms) => (instance ? instance.flush(ms) : Promise.resolve(true)),
  shutdown: (ms) => (instance ? instance.shutdown(ms) : Promise.resolve(true)),
  get,
  live: () => !!instance && instance.live(),
  createOtel,
  parseTraceparent,
  formatTraceparent,
  buildSettings,
  encodeJson,
  encodeProtobuf,
  routeOf,
  responseObserver,
  promptOf,
  retryAfterMs,
};
