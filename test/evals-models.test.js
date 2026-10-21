const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer } = require('./helpers');
const { createModels } = require('../lib/evals/models');

const SCHEMA = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
const tags = (...names) => ({ body: { models: names.map((name) => ({ name })) } });
const ids = (...names) => ({ body: { data: names.map((id) => ({ id })) } });

// Fake Ollama + LM Studio on random ports; "down" is a port that was open and then closed (never 11434/1234).
async function rig({ ollama, lmstudio, settings = { model: '', provider: 'auto' }, gateway, now } = {}) {
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

test('resolve: a configured local model needs no probe, and a listed configured name is preferred', async () => {
  const t = await rig({
    ollama: { 'GET /api/tags': tags('qwen3:8b', 'mistral:7b') },
    settings: { model: 'my-tuned', provider: 'ollama' },
  });
  try {
    assert.deepEqual(await t.m.resolve(), { ok: true, kind: 'ollama', model: 'my-tuned', provider: 'ollama' });
    assert.equal(t.o.requests.length, 0);
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
      options: { temperature: 0 },
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
