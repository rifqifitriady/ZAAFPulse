const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const { MARK } = require('../lib/datasets/shape');
const {
  REPLAY_DEFAULTS,
  OUTPUT_CAP,
  toMessages,
  toTools,
  previewOf,
  confirmToken,
  orderModels,
  createReplayRunner,
} = require('../lib/datasets/replay');

const secret = () =>
  'sk-' +
  'ant-api03-' +
  Array.from({ length: 48 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7) % 36]).join('');
const example = (n, text = 'fix the login redirect', over = {}) => ({
  id: `ex_${String(n).padStart(16, '0')}`,
  input: {
    system: null,
    messages: [
      { role: 'user', text },
      { role: 'tool', name: 'Bash', text: 'npm test: 1 failing' },
    ],
    tools: [
      { name: 'Read', description: 'Read a file' },
      { name: 'Bash', description: '' },
    ],
  },
  output: { text: 'Fixed.', model: null },
  reference: null,
  ...over,
});
const META = { slug: 'auth', name: 'Auth' };
const noJudge = async () => ({ ok: false, reason: 'off' });

// A stand-in for gateway.replay: records what it was asked to send.
function fakeReplay({ tiers = {}, priced = [], cost = 0, reply = () => ({ text: 'ok', toolCalls: [] }) } = {}) {
  const sent = [];
  const tierOf = (m) => tiers[m] || null;
  return {
    sent,
    tierOf,
    priced: (m) => tierOf(m) === 'private' || priced.includes(m),
    models: () => [],
    complete: async (req) => {
      sent.push(req);
      return { ...reply(req), usage: { input: 1, output: 1, cost } };
    },
  };
}
const TIERS = { 'local/qwen3': 'private', 'openai/gpt-6.1': 'external', 'other/x': 'external' };

async function gatewayWith(handler) {
  const upstream = await fakeServer({ 'POST /chat/completions': handler });
  const calls = [];
  const integrations = {
    listTools: async () => [{ name: 'Read', description: 'Read', inputSchema: { type: 'object', properties: {} } }],
    callTool: async (name, args) => {
      calls.push([name, args]);
      return { result: { content: [{ type: 'text', text: 'x' }] } };
    },
  };
  const gw = {
    providers: [
      {
        id: 'local',
        preset: 'custom',
        tier: 'private',
        baseUrl: upstream.url,
        models: ['qwen3', 'nomic-embed-text', 'glm-4.6:cloud'],
      },
      { id: 'lms', preset: 'lmstudio', baseUrl: upstream.url, models: ['phi'] },
      {
        id: 'openai',
        preset: 'custom',
        tier: 'external',
        approved: true,
        baseUrl: upstream.url,
        models: ['gpt-6.1'],
        aliases: { best: 'gpt-6.1' },
      },
      // Not usable: disabled, and external without approval.
      { id: 'off', preset: 'custom', tier: 'private', enabled: false, baseUrl: upstream.url, models: ['m'] },
      { id: 'new', preset: 'custom', tier: 'external', approved: false, baseUrl: upstream.url, models: ['n'] },
    ],
    routes: [{ name: 'router/fast', targets: ['local/qwen3'], strategy: 'fallback' }],
  };
  const gateway = createGateway({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'acc-replay-')),
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({ 'gpt-6.1': { input: 1, output: 2 } }),
    getIntegrations: () => integrations,
  });
  return { gateway, upstream, calls, close: () => upstream.close() };
}

test('replay accessor: tiers, refused names and local-first model order', async () => {
  const t = await gatewayWith(() => ({ body: {} }));
  try {
    const r = t.gateway.replay;
    assert.equal(r.tierOf('local/qwen3'), 'private');
    assert.equal(r.tierOf('openai/gpt-6.1'), 'external');
    assert.equal(r.tierOf('local/glm-4.6:cloud'), 'external');
    for (const name of ['router/fast', 'best', 'nope/x', 'qwen3']) assert.equal(r.tierOf(name), null, name);
    assert.equal(r.tierOf('off/m'), null, 'a disabled provider');
    assert.equal(r.tierOf('new/n'), null, 'an unapproved external provider');
    const names = r.models().map((m) => m.name);
    assert.ok(names.indexOf('lms/phi') >= 0 && names.indexOf('lms/phi') < names.indexOf('local/qwen3'), names);
    assert.ok(names.indexOf('local/qwen3') < names.indexOf('openai/gpt-6.1'), names);
    assert.ok(!names.some((n) => n.includes('nomic-embed-text')), names);
    assert.ok(!names.includes('off/m') && !names.includes('new/n'), names);
    const lms = r.models().find((m) => m.name === 'lms/phi');
    assert.deepEqual(lms, { name: 'lms/phi', provider: 'lms', label: 'LM Studio', tier: 'private', priced: true });
    assert.equal(r.priced('openai/gpt-6.1'), true);
    assert.equal(r.priced('local/glm-4.6:cloud'), false);
    await assert.rejects(r.complete({ model: 'router/fast', messages: [] }), (e) => e.status === 400);
    assert.equal(t.upstream.requests.length, 0);
  } finally {
    await t.close();
  }
});

test('replay: tools are declared and never executed, one call per example and model', async () => {
  const t = await gatewayWith(() => ({
    body: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    },
  }));
  try {
    const runner = createReplayRunner({ replay: t.gateway.replay, judge: noJudge });
    const record = await runner.run({
      id: 'exp_0000000000000001',
      dataset: META,
      examples: [example(1), example(2)],
      models: ['local/qwen3'],
      evaluators: ['secret_leak', 'risky_command', 'relevance'],
    });
    const sent = t.upstream.requests.filter((q) => q.path === '/chat/completions');
    assert.equal(sent.length, 2);
    for (const q of sent) {
      assert.deepEqual(
        q.body.tools.map((x) => x.function.name),
        ['Read', 'Bash'],
      );
      assert.equal(q.body.tool_choice, 'auto');
      assert.equal(q.body.temperature, 0);
      assert.ok(!q.body.messages.some((m) => m.role === 'tool'));
      assert.deepEqual(q.body.messages[1], { role: 'user', content: '[tool result: Bash]\nnpm test: 1 failing' });
    }
    assert.equal(t.calls.length, 0, 'no integration tool was called');
    assert.deepEqual(record.perExample[0].output.proposal, { name: 'Read', arguments: '{"file_path":"a.ts"}' });
    assert.equal(record.perExample[0].output.text, '');
    assert.equal(record.perExample[0].labels.secret_leak.label, 'clean');
    assert.equal(record.perExample[0].labels.relevance, null);
    assert.equal(record.status, 'done');
    assert.equal(record.stopped, null);
    assert.equal(record.usage.requests, 2);
    assert.equal(t.gateway.usage.recent(1)[0].agent, 'replay');
    assert.equal(record.summary.models['local/qwen3'].proposals, 2);
  } finally {
    await t.close();
  }
});

test('toMessages and toTools follow the send rules', () => {
  const input = {
    system: 'be brief',
    messages: [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
      { role: 'tool', name: 'Bash', text: 'ok' },
    ],
  };
  assert.deepEqual(toMessages(input, { external: false }), [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: '[tool result: Bash]\nok' },
  ]);
  const tools = toTools([
    { name: 'Read', description: 'Read a file' },
    { name: 'mcp__x.y', description: '' },
    { name: '', description: '' },
  ]);
  assert.deepEqual(tools, [
    {
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    },
  ]);
  assert.deepEqual(toTools(undefined), []);
});

test('caps: request cap, cost cap and cancel stop the run cleanly', async () => {
  const three = [example(1), example(2), example(3)];
  const base = { id: 'exp_0000000000000002', dataset: META, examples: three, evaluators: ['secret_leak'] };

  let replay = fakeReplay({ tiers: TIERS });
  const progress = [];
  let rec = await createReplayRunner({ replay, judge: noJudge }).run({
    ...base,
    models: ['local/qwen3'],
    maxRequests: 2,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(replay.sent.length, 2);
  assert.equal(rec.status, 'stopped');
  assert.equal(rec.stopped, 'request cap');
  assert.deepEqual(rec.caps, { maxCostUSD: REPLAY_DEFAULTS.maxCostUSD, maxRequests: 2 });
  assert.deepEqual(progress.at(-1), { done: 2, total: 3, requests: 2, cost: 0 });

  replay = fakeReplay({ tiers: TIERS, cost: 0.3 });
  rec = await createReplayRunner({ replay, judge: noJudge }).run({ ...base, models: ['local/qwen3'], maxCostUSD: 0.5 });
  assert.equal(replay.sent.length, 2);
  assert.equal(rec.stopped, 'cost cap');
  assert.ok(Math.abs(rec.usage.cost - 0.6) < 1e-9);

  replay = fakeReplay({ tiers: TIERS });
  const ctl = new AbortController();
  ctl.abort();
  rec = await createReplayRunner({ replay, judge: noJudge }).run({
    ...base,
    models: ['local/qwen3'],
    signal: ctl.signal,
  });
  assert.equal(replay.sent.length, 0);
  assert.equal(rec.status, 'stopped');
  assert.equal(rec.stopped, 'cancelled');
  assert.deepEqual(rec.perExample, []);
});

test('local models run first', async () => {
  const replay = fakeReplay({ tiers: TIERS, priced: ['openai/gpt-6.1'] });
  assert.deepEqual(orderModels(['openai/gpt-6.1', 'local/qwen3'], replay.tierOf), ['local/qwen3', 'openai/gpt-6.1']);
  const rec = await createReplayRunner({ replay, judge: noJudge }).run({
    id: 'exp_0000000000000003',
    dataset: META,
    examples: [example(1)],
    models: ['openai/gpt-6.1', 'local/qwen3'],
    evaluators: [],
  });
  assert.deepEqual(rec.models, ['local/qwen3', 'openai/gpt-6.1']);
  assert.equal(replay.sent[0].model, 'local/qwen3');
  assert.deepEqual(
    rec.perExample.map((r) => r.model),
    ['local/qwen3', 'openai/gpt-6.1'],
  );
  assert.equal(rec.dataset, 'auth');
  assert.equal(rec.datasetName, 'Auth');
});

test('external sends are masked; the preview shows them; the confirm token and the price rule', async () => {
  const ex = example(1, 'mail alex@example.com about /Users/alex/x');
  const preview = previewOf(ex, 'openai/gpt-6.1', { external: true });
  assert.equal(preview.model, 'openai/gpt-6.1');
  assert.match(preview.messages[0].content, /‹email›/);
  assert.match(preview.messages[0].content, /\/Users\/‹user›\/x/);
  assert.ok(!JSON.stringify(preview).includes('alex@example.com'));

  const replay = fakeReplay({ tiers: TIERS, priced: ['openai/gpt-6.1'] });
  await createReplayRunner({ replay, judge: noJudge }).run({
    id: 'exp_0000000000000004',
    dataset: META,
    examples: [ex],
    models: ['local/qwen3', 'openai/gpt-6.1'],
    evaluators: [],
  });
  assert.equal(replay.sent[0].messages[0].content, 'mail alex@example.com about /Users/alex/x');
  // The preview is exactly what the external model gets: model, messages and the declared tools.
  const { model, messages, tools } = replay.sent[1];
  assert.deepEqual({ model, messages, tools }, preview);

  const key = Buffer.from('0123456789abcdef');
  const a = confirmToken(key, { dataset: 'auth', exampleIds: ['b', 'a'], models: ['openai/gpt-6.1', 'local/qwen3'] });
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(
    a,
    confirmToken(key, { dataset: 'auth', exampleIds: ['a', 'b'], models: ['local/qwen3', 'openai/gpt-6.1'] }),
  );
  assert.notEqual(
    a,
    confirmToken(key, { dataset: 'auth', exampleIds: ['a', 'b'], models: ['other/x', 'local/qwen3'] }),
  );

  const run = (models) =>
    createReplayRunner({ replay, judge: noJudge }).run({
      id: 'exp_0000000000000005',
      dataset: META,
      examples: [ex],
      models,
      evaluators: [],
    });
  const before = replay.sent.length;
  await assert.rejects(
    run(['local/qwen3', 'other/x']),
    (e) => e.status === 400 && /no price known for other\/x/.test(e.message),
  );
  await assert.rejects(
    run(['local/qwen3', 'nope/y']),
    (e) => e.status === 400 && /unknown model nope\/y/.test(e.message),
  );
  assert.equal(replay.sent.length, before, 'refused before any call');
});

test('an imported tool description is masked for an external model, shown in the preview, and kept for a local one', async () => {
  const description = 'Ask alex@example.com before reading /Users/alex/notes';
  const ex = example(1, 'fix the login redirect', {
    input: { system: null, messages: [{ role: 'user', text: 'fix it' }], tools: [{ name: 'Mail', description }] },
  });
  const preview = previewOf(ex, 'openai/gpt-6.1', { external: true });
  assert.deepEqual(
    preview.tools.map((t) => [t.function.name, t.function.description]),
    [['Mail', 'Ask ‹email› before reading /Users/‹user›/notes']],
  );
  assert.ok(!JSON.stringify(preview).includes('alex@example.com'));
  assert.equal(previewOf(ex, 'local/qwen3').tools[0].function.description, description, 'private: unchanged');

  const replay = fakeReplay({ tiers: TIERS, priced: ['openai/gpt-6.1'] });
  await createReplayRunner({ replay, judge: noJudge }).run({
    id: 'exp_0000000000000006',
    dataset: META,
    examples: [ex],
    models: ['local/qwen3', 'openai/gpt-6.1'],
    evaluators: [],
  });
  assert.equal(replay.sent[0].tools[0].function.description, description, 'the local model gets the original');
  assert.deepEqual(replay.sent[1].tools, preview.tools, 'the external model gets what the preview showed');
  assert.ok(!JSON.stringify(replay.sent[1]).includes('alex@example.com'));
});

test('stored output is masked and capped while secret_leak still sees the raw text', async () => {
  const key = secret();
  const long = 'x'.repeat(5000);
  let n = 0;
  const replay = fakeReplay({
    tiers: TIERS,
    reply: () => (n++ === 0 ? { text: `here is ${key}`, toolCalls: [] } : { text: long, toolCalls: [] }),
  });
  const rec = await createReplayRunner({ replay, judge: noJudge }).run({
    id: 'exp_0000000000000006',
    dataset: META,
    examples: [example(1), example(2)],
    models: ['local/qwen3'],
    evaluators: ['secret_leak'],
  });
  assert.ok(!JSON.stringify(rec).includes(key));
  assert.equal(rec.perExample[0].labels.secret_leak.label, 'leaked');
  assert.ok(rec.perExample[1].output.text.includes(MARK));
  assert.ok(rec.perExample[1].output.text.length <= OUTPUT_CAP);
  assert.equal(rec.perExample[1].labels.secret_leak.label, 'clean');
});

test('a failed call is recorded with a short masked error and the run goes on', async () => {
  const key = secret();
  let n = 0;
  const replay = fakeReplay({ tiers: TIERS });
  const complete = replay.complete;
  replay.complete = async (req) => {
    if (n++ === 0) {
      replay.sent.push(req);
      throw new Error(`upstream said ${key} ${'y'.repeat(400)}`);
    }
    return complete(req);
  };
  const rec = await createReplayRunner({ replay, judge: noJudge }).run({
    id: 'exp_0000000000000007',
    dataset: META,
    examples: [example(1), example(2)],
    models: ['local/qwen3'],
    evaluators: ['secret_leak'],
  });
  const [bad, good] = rec.perExample;
  assert.equal(bad.output, null);
  assert.equal(bad.cost, 0);
  assert.ok(bad.error.length <= 200);
  assert.ok(!bad.error.includes(key));
  assert.equal(bad.labels.secret_leak, null);
  assert.equal(good.error, null);
  assert.equal(rec.status, 'done');
  assert.equal(rec.usage.requests, 2);
});

test('a call that does not answer is aborted at the timeout and the run goes on', async () => {
  const replay = fakeReplay({ tiers: TIERS });
  replay.complete = (req) =>
    new Promise((resolve, reject) => {
      replay.sent.push(req);
      req.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  const rec = await createReplayRunner({ replay, judge: noJudge, timeoutMs: 20 }).run({
    id: 'exp_0000000000000008',
    dataset: META,
    examples: [example(1), example(2)],
    models: ['local/qwen3'],
    evaluators: [],
  });
  assert.equal(replay.sent.length, 2);
  assert.deepEqual(
    rec.perExample.map((r) => r.error),
    ['no answer within 1 s', 'no answer within 1 s'],
  );
  assert.equal(rec.status, 'done');
});

test('a cancel during a call lets that call finish, records it and makes no further call', async () => {
  const replay = fakeReplay({ tiers: TIERS });
  const ctl = new AbortController();
  let aborted = false;
  replay.complete = (req) =>
    new Promise((resolve) => {
      replay.sent.push(req);
      req.signal.addEventListener('abort', () => {
        aborted = true;
      });
      ctl.abort(); // the owner presses stop while the call is running
      setTimeout(() => resolve({ text: 'done anyway', toolCalls: [], usage: { input: 1, output: 1, cost: 0.1 } }), 30);
    });
  const rec = await createReplayRunner({ replay, judge: noJudge }).run({
    id: 'exp_0000000000000009',
    dataset: META,
    examples: [example(1), example(2)],
    models: ['local/qwen3'],
    evaluators: ['secret_leak'],
    signal: ctl.signal,
  });
  assert.equal(aborted, false, 'the call in flight was not aborted');
  assert.equal(replay.sent.length, 1);
  assert.equal(rec.perExample.length, 1);
  assert.equal(rec.perExample[0].error, null);
  assert.equal(rec.perExample[0].output.text, 'done anyway');
  assert.equal(rec.perExample[0].labels.secret_leak.label, 'clean');
  assert.equal(rec.status, 'stopped');
  assert.equal(rec.stopped, 'cancelled');
  assert.ok(Math.abs(rec.usage.cost - 0.1) < 1e-9);
});
