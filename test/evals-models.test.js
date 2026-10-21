const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeServer, fakeClaude } = require('./helpers');
const { createModels, externalSystem, externalPayload } = require('../lib/evals/models');
const { createClaude, destinationOf } = require('../lib/evals/claude-cli');

const SCHEMA = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
const tags = (...names) => ({ body: { models: names.map((name) => ({ name })) } });
const ids = (...names) => ({ body: { data: names.map((id) => ({ id })) } });
const WAIT = 'Install or start Ollama, or choose a provider';

// Fake Ollama + LM Studio on random ports; "down" is a port that was open and then closed (never 11434/1234).
async function rig({ ollama, lmstudio, settings = { model: '', provider: 'auto' }, gateway, now, claude } = {}) {
  const o = ollama && (await fakeServer(ollama));
  const l = lmstudio && (await fakeServer(lmstudio));
  const dead = await fakeServer({});
  const deadUrl = dead.url;
  await dead.close();
  const state = { settings };
  const m = createModels({
    settings: () => state.settings,
    gateway: gateway || { judge: { providers: () => [], complete: async () => assert.fail('external called') } },
    ollamaUrl: o ? o.url : deadUrl,
    lmstudioUrl: l ? l.url : deadUrl,
    ...(now ? { now } : {}),
    claude: claude || createClaude({ env: { ZAAFPULSE_CLAUDE_BIN: path.join(os.tmpdir(), 'zp-no-claude', 'claude') } }),
  });
  return {
    m,
    o,
    l,
    state,
    close: async () => {
      if (o) await o.close();
      if (l) await l.close();
    },
  };
}

test('resolve: Ollama wins over LM Studio, and the ranked pick skips embedding models', async () => {
  const t = await rig({
    ollama: { 'GET /api/tags': tags('nomic-embed-text:latest', 'mistral:7b', 'llama3.2:3b', 'qwen2.5:7b') },
    lmstudio: { 'GET /v1/models': ids('qwen3-8b') },
  });
  try {
    assert.deepEqual(await t.m.resolve(), { ok: true, kind: 'ollama', model: 'qwen2.5:7b', provider: 'ollama' });
    assert.equal(t.l.requests.length, 0);
  } finally {
    await t.close();
  }
});

test('resolve: an embedding-only Ollama is skipped and LM Studio is used', async () => {
  const t = await rig({
    ollama: { 'GET /api/tags': tags('nomic-embed-text', 'mxbai-embed-large') },
    lmstudio: { 'GET /v1/models': ids('text-embedding-nomic-embed', 'phi4-mini', 'gemma2-9b') },
  });
  try {
    assert.deepEqual(await t.m.resolve(), {
      ok: true,
      kind: 'lmstudio',
      model: 'gemma2-9b',
      provider: 'lmstudio',
    });
  } finally {
    await t.close();
  }
});

test('resolve: LM Studio when Ollama is not running; nothing found means wait', async () => {
  const t = await rig({ lmstudio: { 'GET /v1/models': ids('llama-3.1-8b-instruct') } });
  const none = await rig({});
  try {
    const r = await t.m.resolve();
    assert.equal(r.kind, 'lmstudio');
    assert.equal(r.model, 'llama-3.1-8b-instruct');
    assert.deepEqual(await none.m.resolve(), {
      ok: false,
      waiting: true,
      reason: 'Install or start Ollama, or choose a provider',
    });
  } finally {
    await t.close();
    await none.close();
  }
});

test('resolve: a configured local model is used as given, and a listed configured name is preferred', async () => {
  const t = await rig({
    ollama: { 'GET /api/tags': tags('qwen3:8b', 'mistral:7b') },
    settings: { model: 'my-tuned', provider: 'ollama' },
  });
  try {
    // Not listed, still used: the one probe only looks for a cloud model under that name.
    assert.deepEqual(await t.m.resolve(), { ok: true, kind: 'ollama', model: 'my-tuned', provider: 'ollama' });
    assert.deepEqual(t.o.requests.map((r) => r.path), ['/api/tags']);
    t.state.settings = { model: 'mistral:7b', provider: 'auto' };
    assert.equal((await t.m.resolve()).model, 'mistral:7b');
  } finally {
    await t.close();
  }
});

test('resolve: external is used only when the owner selected it, never as a fallback', async () => {
  const gateway = {
    judge: {
      providers: () => [{ id: 'cloud', label: 'Cloud', models: ['big-1'] }],
      complete: async () => assert.fail('external called'),
    },
  };
  const t = await rig({ gateway, settings: { model: 'big-1', provider: 'auto' } });
  try {
    // auto with nothing local: wait, even though a gateway provider exists
    assert.equal((await t.m.resolve()).waiting, true);
    // a provider id the gateway does not know is not routable
    t.state.settings = { model: 'x', provider: 'ghost' };
    assert.equal((await t.m.resolve()).waiting, true);
    // an explicit, known provider with a model is used
    t.state.settings = { model: 'big-1', provider: 'cloud' };
    assert.deepEqual(await t.m.resolve(), { ok: true, kind: 'external', model: 'big-1', provider: 'cloud' });
  } finally {
    await t.close();
  }
});

test('resolve: an explicit external choice is not overridden by a running local model', async () => {
  const gateway = { judge: { providers: () => [{ id: 'cloud', label: 'Cloud', models: ['big-1'] }] } };
  const t = await rig({
    gateway,
    ollama: { 'GET /api/tags': tags('qwen3:8b') },
    settings: { model: 'big-1', provider: 'cloud' },
  });
  try {
    assert.equal((await t.m.resolve()).kind, 'external');
    assert.equal(t.o.requests.length, 0);
  } finally {
    await t.close();
  }
});

test('resolve: the answer is cached for 30 seconds', async () => {
  let clock = 1_000_000;
  const t = await rig({ ollama: { 'GET /api/tags': tags('qwen3:8b') }, now: () => clock });
  try {
    await t.m.resolve();
    await t.m.resolve();
    assert.equal(t.o.requests.length, 1);
    clock += 29_000;
    await t.m.resolve();
    assert.equal(t.o.requests.length, 1);
    clock += 2_000;
    await t.m.resolve();
    assert.equal(t.o.requests.length, 2);
  } finally {
    await t.close();
  }
});

test('call: the Ollama body carries the schema, temperature 0 and no tools', async () => {
  const t = await rig({
    ollama: {
      'GET /api/tags': tags('qwen3:8b'),
      'POST /api/chat': { body: { message: { content: '{"label":"ok"}' }, prompt_eval_count: 12, eval_count: 5 } },
    },
  });
  try {
    const r = await t.m.resolve();
    const out = await t.m.call(r, { system: 'SYS', user: 'USR', schema: SCHEMA });
    assert.deepEqual(out, { text: '{"label":"ok"}', usage: { input: 12, output: 5, cost: 0 } });
    const body = t.o.requests.at(-1).body;
    assert.deepEqual(body, {
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USR' },
      ],
      stream: false,
      format: SCHEMA,
      think: false,
      options: { temperature: 0, num_ctx: 8192 },
    });
    assert.equal('tools' in body, false);
  } finally {
    await t.close();
  }
});

test('call: the LM Studio body carries the json schema and no tools', async () => {
  const t = await rig({
    lmstudio: {
      'GET /v1/models': ids('qwen3-8b'),
      'POST /v1/chat/completions': {
        body: {
          choices: [{ message: { content: '{"label":"ok"}' } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        },
      },
    },
  });
  try {
    const r = await t.m.resolve();
    const out = await t.m.call(r, { system: 'SYS', user: 'USR', schema: SCHEMA });
    assert.deepEqual(out, { text: '{"label":"ok"}', usage: { input: 7, output: 3, cost: 0 } });
    const body = t.l.requests.at(-1).body;
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'verdict', schema: SCHEMA } });
    assert.equal(body.messages.length, 2);
    assert.equal('tools' in body, false);
  } finally {
    await t.close();
  }
});

test('call: external goes through gateway.judge.complete and returns its usage and cost', async () => {
  const seen = [];
  const gateway = {
    judge: {
      providers: () => [{ id: 'cloud', label: 'Cloud', models: ['big-1'] }],
      hasPrice: () => true,
      complete: async (a) => {
        seen.push(a);
        return { text: '{"label":"ok"}', usage: { input: 30, output: 8, cost: 0.002 } };
      },
    },
  };
  const t = await rig({ gateway, settings: { model: 'big-1', provider: 'cloud' } });
  try {
    const r = await t.m.resolve();
    const out = await t.m.call(r, { system: 'SYS', user: 'USR', schema: SCHEMA });
    assert.deepEqual(out, { text: '{"label":"ok"}', usage: { input: 30, output: 8, cost: 0.002 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'cloud/big-1');
    assert.equal(seen[0].messages[1].content, 'USR');
    assert.ok(seen[0].messages[0].content.startsWith('SYS'));
    assert.equal(seen[0].messages[0].content, externalSystem('SYS', SCHEMA), 'the preview shows this very text');
    assert.ok(seen[0].messages[0].content.includes('"label"'), 'the schema is described in the prompt');
    assert.equal('tools' in seen[0], false);
  } finally {
    await t.close();
  }
});

test('call: errors carry a status and a short message without credentials', async () => {
  const t = await rig({
    ollama: {
      'GET /api/tags': tags('qwen3:8b'),
      'POST /api/chat': { status: 500, body: { error: 'boom' } },
    },
  });
  const down = await rig({});
  try {
    const r = await t.m.resolve();
    await assert.rejects(t.m.call(r, { system: 's', user: 'u', schema: SCHEMA }), (e) => {
      assert.equal(e.status, 500);
      assert.ok(e.message.length < 120);
      assert.ok(!/https?:\/\//.test(e.message));
      return true;
    });
    const dead = { ok: true, kind: 'ollama', model: 'x', provider: 'ollama' };
    await assert.rejects(
      down.m.call(dead, { system: 's', user: 'u', schema: SCHEMA }),
      (e) => e.status === 0 && !/https?:\/\//.test(e.message),
    );
  } finally {
    await t.close();
    await down.close();
  }
});

test('call: a slow model times out', async () => {
  const hang = new Promise(() => {});
  const t = await rig({ ollama: { 'GET /api/tags': tags('qwen3:8b'), 'POST /api/chat': () => hang } });
  const slow = createModels({
    settings: () => ({ model: '', provider: 'auto' }),
    gateway: { judge: { providers: () => [], complete: async () => ({}) } },
    ollamaUrl: t.o.url,
    lmstudioUrl: t.o.url,
    callMs: 80,
  });
  try {
    const r = await slow.resolve();
    await assert.rejects(slow.call(r, { system: 's', user: 'u', schema: SCHEMA }), (e) => {
      assert.equal(e.status, 0);
      assert.match(e.message, /timed out/);
      return true;
    });
  } finally {
    await t.close();
  }
});

// Review fixes: the judge goes only to the provider the owner selected.
const cloud = (extra = {}) => ({
  judge: {
    providers: () => [
      { id: 'cloud', label: 'Cloud', models: [] },
      { id: 'openai', label: 'OpenAI', models: [] },
    ],
    aliased: (n) => n === 'fast' || n === 'cloud/shortcut',
    complete: async () => ({ text: '{}', usage: {} }),
    ...extra,
  },
});
const pickCloud = async (model, gateway = cloud()) => {
  const t = await rig({ gateway, settings: { model, provider: 'cloud' } });
  const r = await t.m.resolve();
  return { t, r };
};

test('external: an id with its own slash is routed through the selected provider', async () => {
  const seen = [];
  const gateway = cloud({
    providers: () => [{ id: 'cloud', label: 'Cloud', models: [] }],
    complete: async (a) => {
      seen.push(a.model);
      return { text: '{}', usage: {} };
    },
  });
  for (const [model, want] of [
    ['meta-llama/llama-3.1-70b', 'cloud/meta-llama/llama-3.1-70b'],
    ['openai/gpt-4o', 'cloud/openai/gpt-4o'], // openai is not a configured provider here
    ['cloud/big-1', 'cloud/big-1'],
    ['big-1', 'cloud/big-1'],
  ]) {
    const { t, r } = await pickCloud(model, gateway);
    try {
      assert.equal(r.ok, true, model);
      await t.m.call(r, { system: 's', user: 'u', schema: SCHEMA });
      assert.equal(seen.at(-1), want);
    } finally {
      await t.close();
    }
  }
});

test('external: route, alias and other-provider names are refused', async () => {
  for (const model of ['router/smart', 'fast', 'cloud/shortcut', 'openai/gpt-4o']) {
    const { t, r } = await pickCloud(model);
    try {
      assert.deepEqual(r, { ok: false, waiting: true, reason: 'model is not from the selected provider' }, model);
    } finally {
      await t.close();
    }
  }
  // call() re-checks, so a hand-built resolution cannot slip a route through
  const { t } = await pickCloud('big-1');
  try {
    await assert.rejects(
      t.m.call(
        { ok: true, kind: 'external', model: 'router/smart', provider: 'cloud' },
        { system: 's', user: 'u', schema: SCHEMA },
      ),
      (e) => e.status === 0 && /selected provider/.test(e.message),
    );
  } finally {
    await t.close();
  }
});

test('external: a selected provider that is unavailable or has no model waits, with no local fallback', async () => {
  for (const settings of [
    { model: 'x', provider: 'ghost' },
    { model: '', provider: 'cloud' },
  ]) {
    const t = await rig({ gateway: cloud(), ollama: { 'GET /api/tags': tags('qwen3:8b') }, settings });
    try {
      assert.deepEqual(await t.m.resolve(), { ok: false, waiting: true, reason: 'selected provider unavailable' });
      assert.equal(t.o.requests.length, 0);
    } finally {
      await t.close();
    }
  }
});

test('external: the timeout aborts the request, not only the wait', async () => {
  let signal;
  const gateway = cloud({
    complete: ({ signal: s }) => {
      signal = s;
      return new Promise((_, rej) => s.addEventListener('abort', () => rej(new Error('aborted upstream'))));
    },
  });
  const m = createModels({
    settings: () => ({ model: 'big-1', provider: 'cloud' }),
    gateway,
    ollamaUrl: 'http://127.0.0.1:9',
    lmstudioUrl: 'http://127.0.0.1:9',
    callMs: 50,
  });
  const r = await m.resolve();
  await assert.rejects(m.call(r, { system: 's', user: 'u', schema: SCHEMA }), (e) => {
    assert.equal(e.status, 0);
    assert.match(e.message, /timed out/);
    return true;
  });
  assert.equal(signal.aborted, true);
});

test('resolve: overlapping calls share one probe', async () => {
  const t = await rig({ ollama: { 'GET /api/tags': tags('qwen3:8b') } });
  try {
    const [a, b] = await Promise.all([t.m.resolve(), t.m.resolve()]);
    assert.equal(a, b);
    assert.equal(t.o.requests.length, 1);
  } finally {
    await t.close();
  }
});

test('resolve: rerank models are skipped like embedding models', async () => {
  const t = await rig({ ollama: { 'GET /api/tags': tags('bge-reranker-v2', 'qwen3-rerank:4b', 'phi4:14b') } });
  try {
    assert.equal((await t.m.resolve()).model, 'phi4:14b');
  } finally {
    await t.close();
  }
});

test('call: a failed response has its body cancelled', async () => {
  let cancelled = 0;
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    body: { cancel: async () => void cancelled++ },
  });
  const m = createModels({
    settings: () => ({ model: 'x', provider: 'ollama' }),
    gateway: { judge: { providers: () => [] } },
    fetchImpl,
  });
  const r = await m.resolve();
  const probed = cancelled; // the cloud-model lookup of a named Ollama model got a 503 too
  await assert.rejects(m.call(r, { system: 's', user: 'u', schema: SCHEMA }), (e) => e.status === 503);
  assert.equal(cancelled - probed, 1);
});

test('priced and cost: an external model without a list price is unpriced and its cost is null, never 0', async () => {
  const prices = { 'cloud/big-1': { input: 3, output: 15 } };
  const gateway = cloud({
    hasPrice: (n) => !!prices[n],
    priceOf: (n) => prices[n] || null,
    complete: async () => ({ text: '{}', usage: { input: 10, output: 5, cost: 0 } }), // the gateway says 0 for unpriced
  });
  const known = await pickCloud('big-1', gateway);
  const unknown = await pickCloud('mystery-9', gateway);
  try {
    assert.equal(known.t.m.priced(known.r), true);
    assert.deepEqual(known.t.m.priceOf(known.r), { input: 3, output: 15 });
    assert.equal(unknown.t.m.priced(unknown.r), false);
    assert.equal(unknown.t.m.priceOf(unknown.r), null);
    assert.equal((await unknown.t.m.call(unknown.r, { system: 's', user: 'u', schema: SCHEMA })).usage.cost, null);
    assert.equal((await known.t.m.call(known.r, { system: 's', user: 'u', schema: SCHEMA })).usage.cost, 0);
    // A gateway that cannot say is unpriced, and local models are always free.
    assert.equal(known.t.m.priced({ ok: true, kind: 'ollama', model: 'm', provider: 'ollama' }), true);
    const blind = await pickCloud('big-1', cloud());
    try {
      assert.equal(blind.t.m.priced(blind.r), false);
    } finally {
      await blind.t.close();
    }
  } finally {
    await known.t.close();
    await unknown.t.close();
  }
});

// Final review: Ollama 0.12+ lists cloud models in /api/tags; a request to one is forwarded to ollama.com.
const CLOUD_REASON =
  'Ollama cloud models send text off this machine; choose an external provider in the gateway instead';
const remote = (name, model = name.replace(/-?cloud$/, '')) => ({
  name,
  model: name,
  remote_host: 'https://ollama.com:443',
  remote_model: model,
});

test('cloud: an Ollama cloud model is never auto-picked; the local one is', async () => {
  const t = await rig({
    ollama: {
      'GET /api/tags': {
        body: {
          models: [
            remote('qwen3-coder:480b-cloud'),
            { name: 'qwen3:8b', model: 'qwen3:8b', remote_host: 'https://ollama.com:443' }, // remote, local-looking name
            { name: 'glm-4.6:cloud' }, // the name alone says cloud
            { name: 'llama3.1:8b' },
          ],
        },
      },
    },
  });
  try {
    assert.deepEqual(await t.m.resolve(), { ok: true, kind: 'ollama', model: 'llama3.1:8b', provider: 'ollama' });
  } finally {
    await t.close();
  }
});

test('cloud: an Ollama that lists only cloud models means wait', async () => {
  const t = await rig({
    ollama: { 'GET /api/tags': { body: { models: [remote('gpt-oss:120b-cloud'), { name: 'qwen3:cloud' }] } } },
  });
  try {
    assert.deepEqual(await t.m.resolve(), { ok: false, waiting: true, reason: WAIT });
  } finally {
    await t.close();
  }
});

test('cloud: a cloud model named in the settings is refused, and call() refuses one too', async () => {
  const t = await rig({
    ollama: {
      'GET /api/tags': { body: { models: [remote('mine', 'gpt-oss:120b'), { name: 'qwen3:8b' }] } },
      'POST /api/chat': () => assert.fail('a cloud model was called'),
    },
  });
  try {
    for (const settings of [
      { provider: 'ollama', model: 'gpt-oss:120b-cloud' },
      { provider: 'ollama', model: 'GLM-4.6:Cloud' },
      { provider: 'auto', model: 'deepseek-v3.1:671b-cloud' },
      { provider: 'ollama', model: 'mine' }, // listed with a remote host under a local-looking name
    ]) {
      t.state.settings = settings;
      assert.deepEqual(await t.m.resolve(), { ok: false, waiting: true, reason: CLOUD_REASON }, settings.model);
    }
    const handMade = { ok: true, kind: 'ollama', model: 'kimi-k2:1t-cloud', provider: 'ollama' };
    await assert.rejects(t.m.call(handMade, { system: 's', user: 'u', schema: SCHEMA }), (e) => {
      assert.equal(e.status, 0);
      assert.equal(e.message, CLOUD_REASON);
      return true;
    });
    assert.equal(t.o.requests.filter((r) => r.method === 'POST').length, 0);
  } finally {
    await t.close();
  }
});

// Final review: Ollama's default context (2048 or 4096 tokens) is smaller than the judge's input budget, and it cuts
// the start of the context, where the system prompt is, without saying so.
test('call: Ollama gets a context window sized for the prompt, and no thinking', async () => {
  const t = await rig({
    ollama: {
      'GET /api/tags': tags('qwen3:8b'),
      'POST /api/chat': { body: { message: { content: '{"label":"ok"}' } } },
    },
  });
  try {
    const r = await t.m.resolve();
    for (const [size, want] of [
      [10, 8192], // the floor
      [20000, 8192], // 7,692 tokens still fit the smallest bucket
      [30000, 16384],
      [60000, 32768], // 21,025 tokens: the next bucket up
      [400000, 32768], // the ceiling
    ]) {
      await t.m.call(r, { system: 'SYS', user: 'u'.repeat(size), schema: SCHEMA });
      const body = t.o.requests.at(-1).body;
      assert.equal(body.options.num_ctx, want, `user of ${size}`);
      assert.ok(body.options.num_ctx >= 8192);
      assert.equal(body.think, false);
      assert.equal(body.options.temperature, 0);
    }
  } finally {
    await t.close();
  }
});

// Final review: a provider whose id is "router" would turn "smart" into "router/smart", which the gateway serves as
// a route whose targets may be other providers.
test('external: a final name that is a configured route is refused, also for a provider called router', async () => {
  const gateway = (routed) =>
    cloud({
      providers: () => [{ id: 'router', label: 'Router', models: [] }],
      ...(routed ? { routed } : {}),
    });
  const routes = (n) => n === 'router/smart';
  for (const model of ['smart', 'router/smart']) {
    const t = await rig({ gateway: gateway(routes), settings: { model, provider: 'router' } });
    try {
      const want = { ok: false, waiting: true, reason: 'model is not from the selected provider' };
      assert.deepEqual(await t.m.resolve(), want, model);
    } finally {
      await t.close();
    }
  }
  const seen = [];
  const ok = await rig({
    gateway: cloud({
      providers: () => [{ id: 'router', label: 'Router', models: [] }],
      routed: routes,
      complete: async (a) => (seen.push(a.model), { text: '{}', usage: {} }),
    }),
    settings: { model: 'big-1', provider: 'router' },
  });
  try {
    const r = await ok.m.resolve();
    assert.equal(r.ok, true);
    await ok.m.call(r, { system: 's', user: 'u', schema: SCHEMA });
    assert.deepEqual(seen, ['router/big-1']);
  } finally {
    await ok.close();
  }
  // A gateway that cannot say which routes exist: every router/... name is refused.
  const blind = await rig({ gateway: gateway(null), settings: { model: 'big-1', provider: 'router' } });
  try {
    assert.equal((await blind.m.resolve()).ok, false);
  } finally {
    await blind.close();
  }
});

// Final review: the ranked pick should not load a 70B model when a light one is there.
test('resolve: the auto-pick prefers at most 14B, and a larger model only when nothing lighter is listed', async () => {
  const sized = (...pairs) => ({
    body: { models: pairs.map(([name, size]) => ({ name, details: size ? { parameter_size: size } : {} })) },
  });
  for (const [list, want] of [
    [sized(['llama3.3:70b', '70.6B'], ['qwen3:8b', '8.2B']), 'qwen3:8b'],
    [sized(['qwen3:32b', '32.8B'], ['qwen3:8b', '8.2B']), 'qwen3:8b'],
    [sized(['qwen3:235b', '235.1B'], ['mistral:7b', '7.2B']), 'mistral:7b'],
    [sized(['qwen3:latest', '30.5B'], ['llama3.2:latest', '3.2B']), 'llama3.2:latest'], // the size from details
    [sized(['qwen3:30b-a3b'], ['gemma3:4b']), 'gemma3:4b'], // no details: the size in the name
    [sized(['llama3.3:70b', '70.6B'], ['phi4:14b', '14.7B']), 'llama3.3:70b'], // nothing at most 14B: rank decides
    [sized(['qwen2.5:14b', '14.8B'], ['qwen2.5:0.5b', '494.03M']), 'qwen2.5:0.5b'],
  ]) {
    const t = await rig({ ollama: { 'GET /api/tags': list } });
    try {
      assert.equal((await t.m.resolve()).model, want, JSON.stringify(list.body.models.map((m) => m.name)));
    } finally {
      await t.close();
    }
  }
  // A name the owner typed is still used whatever its size.
  const t = await rig({
    ollama: { 'GET /api/tags': sized(['llama3.3:70b', '70.6B'], ['qwen3:8b', '8.2B']) },
    settings: { provider: 'auto', model: 'llama3.3:70b' },
  });
  try {
    assert.equal((await t.m.resolve()).model, 'llama3.3:70b');
  } finally {
    await t.close();
  }
});

// Re-review: a num_ctx that differs per call makes Ollama reload the runner, so it comes in three sizes only.
test('call: num_ctx is rounded up to 8192, 16384 or 32768 for any prompt size', async () => {
  const seen = new Set();
  const m = createModels({
    settings: () => ({ provider: 'ollama', model: 'qwen3:8b' }),
    gateway: { judge: { providers: () => [] } },
    fetchImpl: async (url, init) => {
      if (init && init.method === 'POST') seen.add(JSON.parse(init.body).options.num_ctx);
      return { ok: true, json: async () => ({ models: [], message: { content: '{}' } }) };
    },
  });
  const r = await m.resolve();
  for (let size = 0; size <= 200000; size += 1777) {
    await m.call(r, { system: 'S', user: 'u'.repeat(size), schema: SCHEMA });
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [8192, 16384, 32768]);
});

// Re-review: an Ollama that refuses the think field gets the call again without it, and keeps that for the model.
test('call: an Ollama that refuses "think" is asked again without it, once per model', async () => {
  const bodies = [];
  const t = await rig({
    ollama: {
      'GET /api/tags': tags('qwen3:8b'),
      'POST /api/chat': (r) => {
        bodies.push(r.body);
        if ('think' in r.body) return { status: 400, body: { error: `"${r.body.model}" does not support thinking` } };
        return { body: { message: { content: '{"label":"ok"}' } } };
      },
    },
  });
  try {
    const r = await t.m.resolve();
    assert.equal((await t.m.call(r, { system: 's', user: 'u', schema: SCHEMA })).text, '{"label":"ok"}');
    assert.deepEqual(bodies.map((b) => 'think' in b), [true, false]);
    await t.m.call(r, { system: 's', user: 'u', schema: SCHEMA });
    assert.equal(bodies.length, 3, 'remembered: no second refused call');
    assert.equal('think' in bodies[2], false);
    // Another model still gets think: false first.
    await t.m.call({ ...r, model: 'llama3.1:8b' }, { system: 's', user: 'u', schema: SCHEMA });
    assert.equal(bodies[3].think, false);
  } finally {
    await t.close();
  }
  // A 400 about something else is not retried and keeps its short message.
  const other = await rig({
    ollama: {
      'GET /api/tags': tags('qwen3:8b'),
      'POST /api/chat': { status: 400, body: { error: 'invalid format schema' } },
    },
  });
  try {
    const r = await other.m.resolve();
    await assert.rejects(other.m.call(r, { system: 's', user: 'u', schema: SCHEMA }), (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.message, 'Ollama returned 400');
      return true;
    });
    assert.equal(other.o.requests.filter((x) => x.method === 'POST').length, 1);
  } finally {
    await other.close();
  }
});

// ---- the Claude Code judge (a fake claude; the real one is never started) ----
const CLAUDE_MISSING = 'Claude Code not found: install it, or set ZAAFPULSE_CLAUDE_BIN';
function claudeRig(mode = 'ok') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-models-claude-'));
  const log = path.join(dir, 'runs.jsonl');
  const env = { ZAAFPULSE_CLAUDE_BIN: fakeClaude(path.join(dir, 'bin')), FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log };
  const runs = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((r) => !r.version)
      : [];
  return {
    claude: createClaude({ env, home: dir, systemDirs: [] }),
    runs,
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('claude-code: chosen only by name, as an alias or "default", and waiting when it is not installed', async () => {
  const c = claudeRig();
  const pick = async (settings, claude = c.claude) => {
    const t = await rig({ settings, claude });
    try {
      return await t.m.resolve();
    } finally {
      await t.close();
    }
  };
  try {
    // Where the text goes rides along, with the token its preview confirms.
    const here = destinationOf({});
    const on = { ok: true, kind: 'claude-cli', provider: 'claude-code', destination: here.text, confirm: here.token };
    assert.deepEqual(await pick({ provider: 'claude-code', model: '' }), { ...on, model: 'default' });
    assert.deepEqual(await pick({ provider: 'claude-code', model: 'haiku' }), { ...on, model: 'haiku' });
    assert.deepEqual(await pick({ provider: 'claude-code', model: 'claude-sonnet-5-5' }), {
      ...on,
      model: 'claude-sonnet-5-5',
    });
    // Never picked by Auto, even when it is installed and nothing local runs.
    assert.deepEqual(await pick({ provider: 'auto', model: '' }), { ok: false, waiting: true, reason: WAIT });
    assert.deepEqual(await pick({ provider: 'auto', model: 'haiku' }), { ok: false, waiting: true, reason: WAIT });
    // A model name that could be read as a flag waits, and so does a missing CLI.
    const bad = await pick({ provider: 'claude-code', model: '--bare' });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /model name/);
    const none = await rig({ settings: { provider: 'claude-code', model: 'haiku' } });
    try {
      assert.deepEqual(await none.m.resolve(), { ok: false, waiting: true, reason: CLAUDE_MISSING });
    } finally {
      await none.close();
    }
  } finally {
    c.done();
  }
});

test('claude-code: a gateway provider with the same id is never the judge', async () => {
  const sent = [];
  const gateway = {
    judge: {
      providers: () => [{ id: 'claude-code', label: 'Gateway one', models: ['m1'] }],
      hasPrice: () => true,
      complete: async (a) => (sent.push(a), { text: '{}', usage: {} }),
    },
  };
  const t = await rig({ gateway, settings: { provider: 'claude-code', model: 'm1' } });
  try {
    assert.deepEqual(await t.m.resolve(), { ok: false, waiting: true, reason: CLAUDE_MISSING });
    assert.equal(sent.length, 0);
  } finally {
    await t.close();
  }
});

test('claude-code: it is priced (the CLI reports cost) and has an estimate price for the cost cap', async () => {
  const c = claudeRig();
  const t = await rig({ settings: { provider: 'claude-code', model: 'haiku' }, claude: c.claude });
  try {
    const r = await t.m.resolve();
    assert.equal(t.m.priced(r), true);
    for (const model of ['haiku', 'sonnet', 'opus', 'default', 'claude-something-new']) {
      const p = t.m.priceOf({ ...r, model });
      assert.ok(p.input > 0 && p.output > 0, model);
    }
    assert.ok(t.m.priceOf({ ...r, model: 'haiku' }).input < t.m.priceOf({ ...r, model: 'default' }).input);
  } finally {
    await t.close();
    c.done();
  }
});

test('claude-code: the call sends the external payload (PII masked) on stdin, and reports cost and model', async () => {
  const c = claudeRig();
  const t = await rig({ settings: { provider: 'claude-code', model: '' }, claude: c.claude });
  try {
    const r = await t.m.resolve();
    const system = 'Judge this. Owner is ana@example.com';
    const user = 'From /Users/ana/work, call +62 812-3456-7890 or mail ana@example.com';
    const out = await t.m.call(r, { system, user, schema: SCHEMA });
    const preview = externalPayload(system, user, SCHEMA);
    const [run] = c.runs();
    assert.deepEqual(
      { system: run.argv[run.argv.indexOf('--system-prompt') + 1], user: run.stdin },
      preview,
      'what is sent is what the preview shows',
    );
    assert.doesNotMatch(run.stdin + run.argv.join(' '), /ana@example|\/Users\/ana|812-3456/);
    assert.equal(run.argv.includes('--model'), false, '"default" leaves the model to Claude Code');
    assert.deepEqual(JSON.parse(run.argv[run.argv.indexOf('--json-schema') + 1]), SCHEMA);
    assert.deepEqual(out.usage, { input: 1602, output: 40, cost: 0.0005 });
    assert.equal(out.model, 'claude-haiku-5-5');
    assert.equal(out.text, JSON.stringify({ label: 'ok', explanation: 'fake verdict' }));

    const h = await rig({ settings: { provider: 'claude-code', model: 'haiku' }, claude: c.claude });
    try {
      await h.m.call(await h.m.resolve(), { system, user, schema: SCHEMA });
      const argv = c.runs()[1].argv;
      assert.equal(argv[argv.indexOf('--model') + 1], 'haiku');
    } finally {
      await h.close();
    }
  } finally {
    await t.close();
    c.done();
  }
});

test('claude-code: an error from the CLI keeps its status', async () => {
  const c = claudeRig('limit');
  const t = await rig({ settings: { provider: 'claude-code', model: 'haiku' }, claude: c.claude });
  try {
    const r = await t.m.resolve();
    await assert.rejects(t.m.call(r, { system: 's', user: 'u', schema: SCHEMA }), (e) => e.status === 429);
  } finally {
    await t.close();
    c.done();
  }
});

test('claude-code: the signal of the caller cancels a running call', async () => {
  const c = claudeRig('hang');
  const t = await rig({ settings: { provider: 'claude-code', model: 'haiku' }, claude: c.claude });
  try {
    const r = await t.m.resolve();
    const ctl = new AbortController();
    const p = t.m.call(r, { system: 's', user: 'u', schema: SCHEMA, signal: ctl.signal });
    for (let i = 0; i < 100 && !c.runs().length; i++) await new Promise((res) => setTimeout(res, 20));
    ctl.abort();
    await assert.rejects(p, (e) => e.status === 0 && /cancelled/.test(e.message));
  } finally {
    await t.close();
    c.done();
  }
});
