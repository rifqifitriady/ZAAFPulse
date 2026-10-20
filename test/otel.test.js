// OpenTelemetry export: OTLP JSON and protobuf shape, batching, retry, overflow, masking, traceparent,
// and the gateway, collaboration and integration hooks, all against a local fake collector.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fakeServer, secretsFor } = require('./helpers');
const otel = require('../lib/otel');
const { createGateway } = require('../lib/gateway');
const { createIntegrations } = require('../lib/integrations');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

// A collector that keeps raw bodies; respond(req, n) picks the answer for the n-th request.
async function collector(respond = () => ({ status: 200 })) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const r = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
        at: Date.now(),
      };
      requests.push(r);
      const out = (await respond(r, requests.length)) || {};
      res.writeHead(out.status || 200, {
        'content-type': req.headers['content-type'] || 'application/json',
        ...(out.headers || {}),
      });
      res.end(out.body || '');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    // Every span sent as JSON, flattened.
    spans: () =>
      requests.flatMap((q) =>
        JSON.parse(q.body.toString()).resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)),
      ),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}
const attr = (span, key) => {
  const a = span.attributes.find((x) => x.key === key);
  if (!a) return undefined;
  const v = a.value;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return v.arrayValue.values.map((x) => x.stringValue ?? Number(x.intValue));
  return v;
};
const make = (url, extra = {}, opts = {}) =>
  otel.createOtel({
    getConfig: () => ({ otel: { enabled: true, endpoint: url, protocol: 'http/json', ...extra } }),
    env: {},
    refreshMs: 0,
    log: () => {},
    version: '9.9.9',
    ...opts,
  });

// Minimal protobuf reader for the assertions (field number -> list of raw values).
function pb(buf) {
  const out = {};
  let i = 0;
  const vint = () => {
    let v = 0n;
    let s = 0n;
    for (;;) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return v;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const k = Number(vint());
    const f = k >>> 3;
    const w = k & 7;
    let v;
    if (w === 0) v = vint();
    else if (w === 1) {
      v = buf.subarray(i, i + 8);
      i += 8;
    } else if (w === 2) {
      const n = Number(vint());
      v = buf.subarray(i, i + n);
      i += n;
    } else if (w === 5) {
      v = buf.subarray(i, i + 4);
      i += 4;
    }
    (out[f] ||= []).push(v);
  }
  return out;
}

test('otel: OTLP/HTTP JSON shape: resource, scope, ids, nanosecond strings and attribute encoding', async () => {
  const c = await collector();
  const o = make(c.url);
  try {
    const before = BigInt(Date.now()) * 1000000n;
    const span = o.startSpan('chat gpt-x', {
      kind: 3,
      attributes: { s: 'text', n: 42, b: true, d: 1.5, cost: 0, list: ['stop', 'length'], 'zaafpulse.cost.usd': 2 },
    });
    span.end();
    assert.equal(await o.flush(2000), true);
    assert.equal(c.requests.length, 1);
    const q = c.requests[0];
    assert.equal(q.path, '/v1/traces');
    assert.equal(q.headers['content-type'], 'application/json');
    const body = JSON.parse(q.body.toString());
    const rs = body.resourceSpans[0];
    const res = Object.fromEntries(rs.resource.attributes.map((a) => [a.key, a.value.stringValue]));
    assert.equal(res['service.name'], 'zaafpulse');
    assert.equal(res['service.version'], '9.9.9');
    assert.equal(rs.scopeSpans[0].scope.name, 'zaafpulse');
    const s = rs.scopeSpans[0].spans[0];
    assert.match(s.traceId, HEX32);
    assert.match(s.spanId, HEX16);
    assert.equal(s.parentSpanId, undefined);
    assert.equal(s.kind, 3);
    assert.equal(typeof s.startTimeUnixNano, 'string');
    assert.match(s.startTimeUnixNano, /^\d{19}$/);
    assert.ok(BigInt(s.startTimeUnixNano) >= before - 5000000n);
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
    const v = Object.fromEntries(s.attributes.map((a) => [a.key, a.value]));
    assert.deepEqual(v.s, { stringValue: 'text' });
    assert.deepEqual(v.n, { intValue: '42' }); // int64 as a decimal string
    assert.deepEqual(v.b, { boolValue: true });
    assert.deepEqual(v.d, { doubleValue: 1.5 });
    assert.deepEqual(v.cost, { intValue: '0' });
    assert.deepEqual(v['zaafpulse.cost.usd'], { doubleValue: 2 }); // always a double
    assert.deepEqual(v.list, { arrayValue: { values: [{ stringValue: 'stop' }, { stringValue: 'length' }] } });
    assert.deepEqual(s.status, { code: 0 });
  } finally {
    await o.shutdown(500);
    await c.close();
  }
});

test('otel: http/protobuf is the default and encodes the OTLP trace schema', async () => {
  const c = await collector();
  const o = otel.createOtel({
    getConfig: () => ({ otel: { enabled: true, endpoint: c.url } }),
    env: {},
    refreshMs: 0,
    log: () => {},
    version: '1.2.3',
  });
  try {
    const span = o.startSpan('execute_tool x', { attributes: { 'gen_ai.tool.name': 'x', k: 7 } });
    span.fail('tool_error', 'broke');
    span.end();
    await o.flush(2000);
    const q = c.requests[0];
    assert.equal(q.headers['content-type'], 'application/x-protobuf');
    const req = pb(q.body);
    const rs = pb(req[1][0]);
    const ss = pb(rs[2][0]);
    assert.equal(pb(ss[1][0])[1][0].toString(), 'zaafpulse');
    const sp = pb(ss[2][0]);
    assert.equal(sp[1][0].length, 16); // trace id: 16 raw bytes
    assert.equal(sp[2][0].length, 8);
    assert.equal(sp[5][0].toString(), 'execute_tool x');
    assert.equal(Number(sp[6][0]), 1); // INTERNAL
    const start = sp[7][0].readBigUInt64LE();
    assert.ok(start > BigInt(Date.now() - 5000) * 1000000n);
    const status = pb(sp[15][0]);
    assert.equal(Number(status[3][0]), 2);
    assert.equal(status[2][0].toString(), 'broke');
    const kv = sp[9].map((b) => pb(b));
    const k = kv.find((x) => x[1][0].toString() === 'k');
    assert.equal(Number(pb(k[2][0])[3][0]), 7); // AnyValue.int_value
  } finally {
    await o.shutdown(500);
    await c.close();
  }
});

test('otel: spans go out in batches of maxExportBatchSize, the rest after the schedule delay', async () => {
  const c = await collector();
  const o = make(c.url, { batch: { maxExportBatchSize: 3, scheduleDelayMs: 400 } });
  const until = async (n, ms) => {
    for (const end = Date.now() + ms; c.requests.length < n && Date.now() < end;) await sleep(5);
  };
  try {
    const t0 = Date.now();
    for (let i = 0; i < 7; i++) o.startSpan(`s${i}`).end();
    await until(2, 300);
    assert.equal(c.requests.length, 2); // two full batches right away, before the delay
    assert.ok(Date.now() - t0 < 400);
    await until(3, 2000);
    assert.equal(c.requests.length, 3);
    assert.ok(c.requests[2].at - t0 >= 350, 'the remainder waited for the schedule delay');
    const sizes = c.requests.map((q) => JSON.parse(q.body).resourceSpans[0].scopeSpans[0].spans.length);
    assert.deepEqual(sizes, [3, 3, 1]);
    // The collector sees the request before the exporter has read the reply and counted it.
    for (const end = Date.now() + 1000; o.status().stats.exported < 7 && Date.now() < end;) await sleep(5);
    assert.equal(o.status().stats.exported, 7);
  } finally {
    await o.shutdown(500);
    await c.close();
  }
});

test('otel: 503 is retried with backoff, Retry-After is honoured, 400 is not retried', async () => {
  const c = await collector((r, n) =>
    n === 1 ? { status: 503 } : n === 2 ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
  );
  const o = make(c.url, { retry: { initialBackoffMs: 10, maxBackoffMs: 2000 } });
  try {
    o.startSpan('a').end();
    await o.flush(5000);
    assert.equal(c.requests.length, 3);
    assert.ok(c.requests[2].at - c.requests[1].at >= 900, 'waited for Retry-After: 1');
    assert.deepEqual(c.requests[0].body, c.requests[2].body); // the same batch
    const st = o.status().stats;
    assert.equal(st.retries, 2);
    assert.equal(st.exported, 1);
    assert.equal(st.failed, 0);
  } finally {
    await o.shutdown(500);
    await c.close();
  }
  const bad = await collector(() => ({ status: 400, body: 'bad request' }));
  const o2 = make(bad.url, { retry: { initialBackoffMs: 10 } });
  try {
    o2.startSpan('b').end();
    await o2.flush(2000);
    assert.equal(bad.requests.length, 1);
    assert.equal(o2.status().stats.failed, 1);
  } finally {
    await o2.shutdown(500);
    await bad.close();
  }
  assert.equal(otel.retryAfterMs('3', Date.now), 3000);
  const t = Date.now();
  assert.ok(Math.abs(otel.retryAfterMs(new Date(t + 5000).toUTCString(), () => t) - 5000) <= 1000);
  assert.equal(otel.retryAfterMs('soon', Date.now), null);
});

test('otel: a full queue drops spans and counts them; ending a span never waits for the network', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const c = await collector(async () => {
    await gate;
    return { status: 200 };
  });
  const o = make(c.url, { batch: { maxQueueSize: 3, maxExportBatchSize: 3, scheduleDelayMs: 10 } });
  try {
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) o.startSpan(`first${i}`).end(); // one batch, now waiting on the collector
    await sleep(30);
    for (let i = 0; i < 7; i++) o.startSpan(`more${i}`).end(); // 3 fit in the queue, 4 are dropped
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(o.status().stats.dropped, 4);
    assert.equal(o.status().queued, 3);
    release();
    await o.flush(2000);
    assert.equal(o.status().stats.exported, 6);
  } finally {
    release();
    await o.shutdown(500);
    await c.close();
  }
});

test('otel: header secrets are resolved from refs, sent as is, and masked in logs and status', async () => {
  const token = 'Api-Token dt0c01.ABCDEFGHIJKLMNOP.QRSTUVWXYZ0123456789';
  const c = await collector(() => ({ status: 401, body: `token ${token} is not valid` }));
  const logs = [];
  const o = otel.createOtel({
    getConfig: () => ({
      otel: {
        enabled: true,
        endpoint: c.url,
        protocol: 'http/json',
        headers: { Authorization: { env: 'OTEL_TEST_TOKEN' }, 'x-langfuse-ingestion-version': '4' },
      },
    }),
    secrets: secretsFor({ OTEL_TEST_TOKEN: token }),
    env: { OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=env-secret-123456,x-team=blue' },
    refreshMs: 0,
    log: (m) => logs.push(m),
  });
  try {
    o.startSpan('x').end();
    await o.flush(2000);
    const h = c.requests[0].headers;
    assert.equal(h.authorization, token);
    assert.equal(h['x-api-key'], 'env-secret-123456');
    assert.equal(h['x-langfuse-ingestion-version'], '4');
    const st = o.status();
    assert.equal(st.headers.Authorization, '***');
    assert.equal(st.headers['x-api-key'], '***');
    assert.equal(st.headers['x-team'], 'blue');
    const text = JSON.stringify(st) + logs.join('\n');
    assert.ok(logs.some((l) => /failed: HTTP 401/.test(l)));
    assert.ok(!text.includes('dt0c01.ABCDEFGHIJKLMNOP'), text);
    assert.ok(!text.includes('env-secret-123456'));
  } finally {
    await o.shutdown(500);
    await c.close();
  }
  // A plain-text secret in config.json turns export off and says why, without echoing the value.
  const logs2 = [];
  const o2 = otel.createOtel({
    getConfig: () => ({ otel: { enabled: true, headers: { Authorization: 'Bearer plain-secret-value' } } }),
    env: {},
    refreshMs: 0,
    log: (m) => logs2.push(m),
  });
  const st2 = o2.status();
  assert.equal(st2.enabled, false);
  assert.match(st2.error, /plain-text secrets are not allowed/);
  assert.ok(!logs2.join('').includes('plain-secret-value'));
});

test('otel: endpoint, protocol and service name follow config.json first, then the standard OTEL_* variables', () => {
  const s = (cfg, env = {}) => otel.buildSettings({ enabled: true, ...cfg }, env, secretsFor(), '1');
  assert.equal(s({}).url, 'http://localhost:4318/v1/traces');
  assert.equal(
    s({ endpoint: 'https://abc.live.dynatrace.com/api/v2/otlp' }).url,
    'https://abc.live.dynatrace.com/api/v2/otlp/v1/traces',
  );
  assert.equal(s({ endpoint: 'http://localhost:6006/v1/traces' }).url, 'http://localhost:6006/v1/traces');
  assert.equal(s({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://col:4318/' }).url, 'http://col:4318/v1/traces');
  assert.equal(s({}, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://col:9/custom' }).url, 'http://col:9/custom');
  assert.equal(
    s({ endpoint: 'http://a:1' }, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://b:2' }).url,
    'http://a:1/v1/traces',
  );
  assert.equal(s({}).protocol, 'http/protobuf');
  assert.equal(s({}, { OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }).protocol, 'http/json');
  assert.throws(() => s({ protocol: 'grpc' }), /gRPC is not supported/);
  assert.throws(() => s({ endpoint: 'http://u:p@host:4318' }), /credentials/);
  assert.equal(s({}, { OTEL_SERVICE_NAME: 'pulse-prod' }).resource['service.name'], 'pulse-prod');
  assert.equal(s({ serviceName: 'mine' }, { OTEL_SERVICE_NAME: 'pulse-prod' }).resource['service.name'], 'mine');
  assert.equal(
    s(
      { resourceAttributes: { 'openinference.project.name': 'zp' } },
      { OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=dev' },
    ).resource['deployment.environment.name'],
    'dev',
  );
  assert.equal(s({}).captureContent, false);
  assert.equal(otel.buildSettings(undefined, {}, secretsFor(), '1').enabled, false); // off by default
  assert.equal(otel.buildSettings({ enabled: true }, { OTEL_SDK_DISABLED: 'true' }, secretsFor(), '1').enabled, false);
});

test('otel: traceparent parsing follows W3C Trace Context', () => {
  const tid = '4bf92f3577b34da6a3ce929d0e0e4736';
  const sid = '00f067aa0ba902b7';
  assert.deepEqual(otel.parseTraceparent(`00-${tid}-${sid}-01`), {
    traceId: tid,
    spanId: sid,
    flags: 1,
    sampled: true,
  });
  assert.equal(otel.parseTraceparent(`00-${tid}-${sid}-00`).sampled, false);
  assert.equal(otel.parseTraceparent(`00-${tid.toUpperCase()}-${sid}-01`), null);
  assert.equal(otel.parseTraceparent(`00-${'0'.repeat(32)}-${sid}-01`), null);
  assert.equal(otel.parseTraceparent(`00-${tid}-${'0'.repeat(16)}-01`), null);
  assert.equal(otel.parseTraceparent(`ff-${tid}-${sid}-01`), null);
  assert.equal(otel.parseTraceparent(`00-${tid}-${sid}-01-extra`), null);
  assert.equal(otel.parseTraceparent(`01-${tid}-${sid}-01-extra`).traceId, tid); // a later version may add fields
  assert.equal(otel.parseTraceparent('garbage'), null);
  assert.equal(otel.formatTraceparent({ traceId: tid, spanId: sid, sampled: true }), `00-${tid}-${sid}-01`);
  assert.equal(otel.routeOf('/v1/runs/run_0123456789abcdef/cancel'), '/v1/runs/{id}/cancel');
  assert.equal(
    otel.routeOf('/v1beta/models/fake/llama-9:streamGenerateContent'),
    '/v1beta/models/{model}:streamGenerateContent',
  );
});

/* ---------- the hooks, through the real gateway ---------- */
const completion = (content, extra = {}) => ({
  id: 'chatcmpl-up-1',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
  ...extra,
});
async function gatewaySetup(upstreamHandler, otelCfg) {
  const upstream = await fakeServer({
    'POST /chat/completions': upstreamHandler,
    'GET /models': { body: { data: [{ id: 'm' }] } },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-otel-'));
  const gw = {
    providers: [
      {
        id: 'fake',
        preset: 'openai',
        baseUrl: upstream.url,
        models: [],
        enabled: true,
        tier: 'private',
        approved: true,
      },
    ],
    defaults: { model: 'fake/m', plannerModel: 'fake/m' },
  };
  const config = { gateway: gw, otel: otelCfg };
  otel.init({ getConfig: () => config, secrets: secretsFor(), env: {}, refreshMs: 0, log: () => {}, version: '1.0.3' });
  const gateway = createGateway({
    dataDir,
    getConfig: () => config,
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({ m: { input: 1, output: 2 } }),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({ result: { content: [] } }) }),
  });
  const handler = async (req, res) => {
    if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end();
    }
  };
  const server = http.createServer(otel.wrapHandler(handler));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { secret, key } = gateway.keys.create({ name: 'app', scopes: ['llm', 'agents'], rpm: 1000 });
  const call = async (p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  };
  return {
    gateway,
    key,
    call,
    upstream,
    close: async () => {
      await otel.reset();
      server.closeAllConnections?.();
      server.close();
      await upstream.close();
    },
  };
}

test('otel: a gateway chat request continues the incoming traceparent and records a GenAI chat span', async () => {
  const c = await collector();
  const t = await gatewaySetup(() => ({ body: completion('hello there') }), {
    enabled: true,
    endpoint: c.url,
    protocol: 'http/json',
  });
  try {
    const tid = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parent = '00f067aa0ba902b7';
    const r = await t.call(
      '/v1/chat/completions',
      { model: 'fake/m', messages: [{ role: 'user', content: 'secret prompt text' }] },
      { traceparent: `00-${tid}-${parent}-01`, tracestate: 'dt=abc' },
    );
    assert.equal(r.status, 200);
    await sleep(20);
    await otel.flush(2000);
    const spans = c.spans();
    const server = spans.find((s) => s.kind === 2);
    const chat = spans.find((s) => s.name === 'chat fake/m');
    assert.ok(server && chat, JSON.stringify(spans.map((s) => s.name)));
    assert.equal(server.name, 'POST /v1/chat/completions');
    assert.equal(server.traceId, tid);
    assert.equal(server.parentSpanId, parent);
    assert.equal(server.traceState, 'dt=abc');
    assert.equal(server.flags & 0x300, 0x300); // the parent is remote
    assert.equal(attr(server, 'http.response.status_code'), 200);
    assert.equal(chat.traceId, tid);
    assert.equal(chat.parentSpanId, server.spanId);
    assert.equal(chat.kind, 3);
    assert.equal(attr(chat, 'gen_ai.operation.name'), 'chat');
    assert.equal(attr(chat, 'gen_ai.provider.name'), 'openai');
    assert.equal(attr(chat, 'gen_ai.request.model'), 'fake/m');
    assert.equal(attr(chat, 'gen_ai.response.model'), 'fake/m');
    assert.equal(attr(chat, 'gen_ai.usage.input_tokens'), 100);
    assert.equal(attr(chat, 'gen_ai.usage.output_tokens'), 20);
    assert.equal(attr(chat, 'gen_ai.usage.cache_read.input_tokens'), 40);
    assert.deepEqual(attr(chat, 'gen_ai.response.finish_reasons'), ['stop']);
    assert.equal(attr(chat, 'gen_ai.response.id'), 'chatcmpl-up-1');
    assert.equal(attr(chat, 'server.address'), '127.0.0.1');
    assert.ok(attr(chat, 'zaafpulse.cost.usd') > 0);
    assert.equal(attr(chat, 'zaafpulse.api_key.id'), t.key.id);
    // No content without captureContent, and never the API key secret.
    const all = JSON.stringify(spans);
    assert.ok(!all.includes('secret prompt text'));
    assert.ok(!all.includes('hello there'));
    assert.equal(attr(chat, 'gen_ai.input.messages'), undefined);
    assert.ok(!/zp_[A-Za-z0-9]{10,}/.test(all));
  } finally {
    await t.close();
    await c.close();
  }
});

test('otel: errors, streaming finish reasons, unsampled parents and captured content (capped)', async () => {
  const c = await collector();
  let mode = 'error';
  const t = await gatewaySetup(
    () =>
      mode === 'error'
        ? { status: 400, body: { error: { message: 'model is not available' } } }
        : { body: completion('x'.repeat(2000)) },
    { enabled: true, endpoint: c.url, protocol: 'http/json', captureContent: true, contentMaxChars: 300 },
  );
  try {
    assert.equal(
      (await t.call('/v1/chat/completions', { model: 'fake/m', messages: [{ role: 'user', content: 'hi' }] })).status,
      400,
    );
    // A caller that does not sample: nothing is recorded for its request.
    await t.call(
      '/v1/chat/completions',
      { model: 'fake/m', messages: [{ role: 'user', content: 'hi' }] },
      { traceparent: '00-11111111111111111111111111111111-2222222222222222-00' },
    );
    mode = 'ok';
    const long = 'p'.repeat(1000);
    const r = await t.call('/v1/messages', {
      model: 'fake/m',
      max_tokens: 10,
      system: 'be brief',
      messages: [{ role: 'user', content: long }],
      stream: true,
    });
    assert.equal(r.status, 200);
    await sleep(30);
    await otel.flush(2000);
    const spans = c.spans();
    assert.ok(!spans.some((s) => s.traceId === '11111111111111111111111111111111'));
    const failed = spans.find((s) => s.name === 'chat fake/m' && s.status.code === 2);
    assert.equal(attr(failed, 'error.type'), '400');
    assert.match(failed.status.message, /model is not available/);
    const ok = spans.find((s) => s.name === 'chat fake/m' && attr(s, 'zaafpulse.request.format') === 'anthropic');
    assert.deepEqual(attr(ok, 'gen_ai.response.finish_reasons'), ['end_turn']);
    assert.equal(attr(ok, 'gen_ai.request.stream'), true);
    const input = JSON.parse(attr(ok, 'gen_ai.input.messages'));
    assert.equal(input[0].role, 'user');
    assert.ok(input[0].parts[0].content.length <= 300 + 20);
    assert.match(input[0].parts[0].content, /truncated/);
    assert.deepEqual(JSON.parse(attr(ok, 'gen_ai.system_instructions')), [{ type: 'text', content: 'be brief' }]);
    const output = JSON.parse(attr(ok, 'gen_ai.output.messages'));
    assert.equal(output[0].finish_reason, 'stop');
    assert.ok(output[0].parts[0].content.length <= 300 + 20);
  } finally {
    await t.close();
    await c.close();
  }
});

test('otel: a collaboration run becomes invoke_workflow / invoke_agent / execute_tool spans, without duplicate chat spans', async () => {
  const c = await collector();
  let n = 0;
  const t = await gatewaySetup(
    () => {
      n++;
      return n === 1
        ? {
            body: completion(null, {
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 't1',
                        type: 'function',
                        function: { name: 'zp_handoff', arguments: '{"agent":"hr-finance","note":"over limit"}' },
                      },
                    ],
                  },
                },
              ],
            }),
          }
        : { body: completion('Finance approves the refund.') };
    },
    { enabled: true, endpoint: c.url, protocol: 'http/json' },
  );
  try {
    const r = await t.call('/v1/collaborate', {
      pattern: 'handoff',
      agent: 'customer-service',
      task: 'I want a refund',
    });
    assert.equal(r.status, 200, r.text);
    await sleep(30);
    await otel.flush(2000);
    const spans = c.spans();
    const names = spans.map((s) => s.name);
    const server = spans.find((s) => s.kind === 2);
    const root = spans.find((s) => s.name === 'invoke_workflow handoff');
    assert.ok(root, names.join(', '));
    assert.equal(root.parentSpanId, server.spanId);
    assert.equal(root.traceId, server.traceId);
    assert.equal(attr(root, 'gen_ai.workflow.name'), 'handoff');
    assert.match(attr(root, 'zaafpulse.run.id'), /^run_/);
    const agents = spans.filter((s) => attr(s, 'gen_ai.operation.name') === 'invoke_agent');
    assert.ok(agents.length >= 2);
    for (const a of agents) assert.equal(a.kind, 1);
    assert.ok(agents.some((a) => a.parentSpanId === root.spanId));
    const tool = spans.find((s) => s.name === 'execute_tool zp_handoff');
    assert.ok(tool);
    assert.ok(agents.some((a) => a.spanId === tool.parentSpanId));
    // Model calls appear once, from the gateway, in the same trace.
    const chats = spans.filter((s) => s.name === 'chat fake/m');
    assert.equal(chats.length, n);
    for (const ch of chats) {
      assert.equal(ch.traceId, server.traceId);
      assert.equal(attr(ch, 'zaafpulse.request.kind'), 'agent');
      assert.ok(attr(ch, 'gen_ai.agent.id'));
    }
  } finally {
    await t.close();
    await c.close();
  }
});

test('otel: integration tool calls get execute_tool spans with argument names, values only with captureContent', async () => {
  const connectors = {
    fake: {
      type: 'fake',
      create: () => ({
        tools: [
          {
            name: 'lookup',
            description: 'Look up',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            run: async (a) =>
              a.query === 'fail' ? Promise.reject(new Error('backend down for query fail')) : `found ${a.query}`,
          },
        ],
      }),
    },
  };
  for (const capture of [false, true]) {
    const c = await collector();
    otel.init({
      getConfig: () => ({ otel: { enabled: true, endpoint: c.url, protocol: 'http/json', captureContent: capture } }),
      secrets: secretsFor(),
      env: {},
      refreshMs: 0,
      log: () => {},
    });
    try {
      const reg = createIntegrations({
        config: { integrations: { f: { type: 'fake' } } },
        secrets: secretsFor(),
        connectors,
      });
      await reg.callTool('f_lookup', { query: 'customer-4711' });
      await reg.callTool('f_lookup', { query: 'fail' });
      await otel.flush(2000);
      const spans = c.spans().filter((s) => s.name === 'execute_tool f_lookup');
      assert.equal(spans.length, 2);
      const [ok, bad] = spans;
      assert.equal(ok.kind, 3);
      assert.equal(attr(ok, 'gen_ai.tool.name'), 'f_lookup');
      assert.equal(attr(ok, 'zaafpulse.integration.id'), 'f');
      assert.deepEqual(attr(ok, 'zaafpulse.tool.argument_names'), ['query']);
      assert.equal(bad.status.code, 2);
      assert.equal(attr(bad, 'error.type'), 'tool_error');
      const all = JSON.stringify(spans);
      if (capture) {
        assert.equal(attr(ok, 'gen_ai.tool.call.arguments'), '{"query":"customer-4711"}');
        assert.equal(attr(ok, 'gen_ai.tool.call.result'), 'found customer-4711');
      } else {
        assert.ok(!all.includes('customer-4711'));
        assert.ok(!all.includes('backend down'));
      }
    } finally {
      await otel.reset();
      await c.close();
    }
  }
});

test('otel: disabled (the default) makes no network calls, even with OTEL_* variables set', async () => {
  const c = await collector();
  let sent = 0;
  const transport = async () => {
    sent++;
    return { status: 200 };
  };
  for (const cfg of [undefined, { enabled: false, endpoint: c.url }]) {
    const o = otel.createOtel({
      getConfig: () => ({ otel: cfg }),
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: c.url },
      refreshMs: 0,
      transport,
      log: () => {},
    });
    o.startSpan('x').end();
    o.onUsage({ ts: Date.now(), ms: 5, model: 'm', provider: 'p', status: 200, kind: 'chat' });
    o.exportRun({
      id: 'run_1',
      createdAt: Date.now(),
      trace: [{ id: 'a', parent: null, name: 'invoke_workflow auto', start: 0, end: 1, attrs: {} }],
    });
    o.toolCall('t', { id: 'f', type: 'http' }, { a: 1 }).end(true, { content: [] });
    assert.equal(await o.flush(200), true);
    assert.equal(o.status().enabled, false);
  }
  // And through the gateway with export off.
  const t = await gatewaySetup(() => ({ body: completion('hi') }), { enabled: false, endpoint: c.url });
  try {
    assert.equal(
      (await t.call('/v1/chat/completions', { model: 'fake/m', messages: [{ role: 'user', content: 'x' }] })).status,
      200,
    );
    await otel.flush(200);
  } finally {
    await t.close();
  }
  await sleep(50);
  assert.equal(sent, 0);
  assert.equal(c.requests.length, 0);
  await c.close();
});

test('otel: shutdown sends what is still queued', async () => {
  const c = await collector();
  const o = make(c.url, { batch: { scheduleDelayMs: 60000 } });
  o.startSpan('late').end();
  assert.equal(c.requests.length, 0);
  assert.equal(await o.shutdown(2000), true);
  assert.equal(c.requests.length, 1);
  o.startSpan('after').end(); // after shutdown: dropped, not sent
  assert.equal(o.status().stats.dropped, 1);
  await c.close();
});
