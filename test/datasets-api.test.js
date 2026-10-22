// The dataset and experiment routes: /api/datasets/*, /api/experiments/*. Unit tests drive `route` with a fake trace,
// a fake gateway.replay and a fake runner over the real stores in a temp folder; a spawned server.js checks the demo
// data and the sign-in gate. Nothing reads the machine's own logs and nothing contacts a provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway } = require('../lib/gateway');
const { createDatasetStore } = require('../lib/datasets/store');
const { createExperimentStore } = require('../lib/datasets/experiments');
const { createDatasetApi } = require('../lib/datasets/api');
const { secretsFor, NO_JUDGE_PORTS } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const RAW_SESSION = 'RAW-SESSION-4f1c';
const RAW_SPAN = 'RAWSPAN-91';
const EMAIL = 'alex.doe@corp.example.org';

// ---------------------------------------------------------------------------------------------------------------
// Unit: route() with fakes
// ---------------------------------------------------------------------------------------------------------------

// Keys `claude.k1` (a session with text) and `kiro.k2` (no text); sealed span ids are `sealed-<n>`.
function fakeTrace() {
  const keys = { 'claude.k1': ['claude', RAW_SESSION], 'kiro.k2': ['kiro', 'kiro-raw-2'] };
  const notFound = () => Object.assign(new Error('unknown session'), { status: 404 });
  return {
    keyFor(source, sid) {
      for (const [k, [s, id]] of Object.entries(keys)) if (s === source && id === sid) return k;
      throw notFound();
    },
    sealSpan: (raw) => (typeof raw === 'string' && raw ? raw.replace('RAWSPAN-', 'sealed-') : null),
    async example(key, turn, span) {
      if (!Object.hasOwn(keys, key)) throw notFound();
      const [source, session] = keys[key];
      if (source === 'kiro') return null;
      if (span != null && span !== 'sealed-91')
        throw Object.assign(new Error('span is not in this turn'), { status: 400 });
      return {
        input: {
          system: null,
          messages: [
            { role: 'user', text: `fix the login redirect, mail ${EMAIL} when done (turn ${turn})` },
            { role: 'tool', name: 'Bash', text: 'npm test: 1 failing' },
          ],
          tools: [{ name: 'Bash', description: '' }],
        },
        output: { text: 'Fixed the redirect.', model: 'claude-opus-5-5' },
        source: { source, session, turn, span: span ? RAW_SPAN : null },
      };
    },
  };
}

function fakeReplay() {
  const tiers = { 'ollama/qwen3': 'private', 'ext/gpt': 'external', 'ext/unpriced': 'external' };
  return {
    tierOf: (m) => tiers[m] || null,
    priced: (m) => tiers[m] === 'private' || m === 'ext/gpt',
    models: () => [{ name: 'ollama/qwen3', provider: 'ollama', label: 'Ollama', tier: 'private', priced: true }],
    complete: async () => ({ text: 'ok', toolCalls: [], usage: { cost: 0 } }),
  };
}

// A runner whose run stays open until the test lets it finish (or fail).
function fakeRunner() {
  const calls = [];
  let settle = null;
  return {
    calls,
    run(opts) {
      calls.push(opts);
      opts.onProgress({ done: 0, total: opts.examples.length * opts.models.length, requests: 0, cost: 0 });
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
      }).then(() => ({
        id: opts.id,
        dataset: opts.dataset.slug,
        datasetName: opts.dataset.name,
        models: opts.models,
        evaluators: opts.evaluators,
        startedAt: 1,
        endedAt: 2,
        status: 'done',
        stopped: null,
        caps: { maxCostUSD: opts.maxCostUSD, maxRequests: opts.maxRequests },
        usage: { requests: 1, cost: 0 },
        perExample: [
          {
            exampleId: opts.examples[0].id,
            model: opts.models[0],
            output: { text: 'replayed answer', proposal: { name: 'Bash', arguments: '{"command":"ls"}' } },
            error: null,
            labels: {},
            cost: 0,
            ms: 5,
          },
        ],
        summary: { models: {} },
      }));
    },
    finish: () => settle.resolve(),
    fail: () => settle.reject(new Error('boom /Users/someone/secret')),
  };
}

function setup({ contentOff = false } = {}) {
  const dir = tmp('zp-ds-api-');
  const datasets = createDatasetStore({ dir: path.join(dir, 'datasets') });
  const experiments = createExperimentStore({ file: path.join(dir, 'experiments.jsonl') });
  const runner = fakeRunner();
  let stored = {};
  const settings = { get: () => stored, save: (next) => (stored = next) };
  const logs = [];
  let n = 0;
  const api = createDatasetApi({
    datasets,
    experiments,
    runner,
    replay: fakeReplay(),
    trace: fakeTrace(),
    contentOff,
    settings,
    secret: Buffer.from('test-secret'),
    newId: () => `exp_${String(++n).padStart(16, '0')}`,
    log: (m) => logs.push(m),
  });
  const call = (method, p, body, { type = 'application/json', query = '' } = {}) =>
    api.route({
      method,
      path: p,
      query: new URLSearchParams(query),
      contentType: body === undefined ? undefined : type,
      readBody: async (max = 1e6) => {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        if (text.length > max) throw new Error('too large');
        return text;
      },
    });
  const idle = async () => {
    for (let i = 0; i < 100 && api.running(); i++) await new Promise((r) => setImmediate(r));
  };
  return {
    dir,
    datasets,
    experiments,
    runner,
    api,
    call,
    idle,
    logs,
    stored: () => stored,
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// A dataset with one example from the fake trace.
async function withExample(s, slug = 'auth') {
  assert.equal((await s.call('POST', '/api/datasets', { name: 'Auth', slug })).status, 200);
  const r = await s.call('POST', `/api/datasets/${slug}/examples`, { items: [{ key: 'claude.k1', turn: 0 }] });
  assert.equal(r.status, 200);
  return r.body.added[0];
}

test('datasets api: route() answers only its own paths', async () => {
  const s = setup();
  try {
    assert.equal(await s.call('GET', '/api/evals'), null);
    assert.equal(await s.call('GET', '/api/datasetsx'), null);
    assert.equal((await s.call('GET', '/api/datasets/a/b')).status, 404);
    assert.equal((await s.call('GET', '/api/experiments/a/b')).status, 404);
    assert.equal((await s.call('PUT', '/api/datasets')).status, 405);
    assert.equal((await s.call('GET', '/api/datasets/import')).status, 405);
  } finally {
    s.done();
  }
});

test('datasets api: create, list, get, rename, delete; 409, 415, 400', async () => {
  const s = setup();
  try {
    const created = await s.call('POST', '/api/datasets', { name: 'Auth regressions' });
    assert.equal(created.status, 200);
    assert.equal(created.body.dataset.slug, 'auth-regressions');
    assert.equal((await s.call('POST', '/api/datasets', { name: 'Again', slug: 'auth-regressions' })).status, 409);

    const list = await s.call('GET', '/api/datasets');
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.datasets.map((d) => d.slug),
      ['auth-regressions'],
    );
    assert.deepEqual(list.body.limits, { examples: 1000, datasets: 100, fieldChars: 65536 });
    assert.equal(list.body.content, true);

    const got = await s.call('GET', '/api/datasets/auth-regressions');
    assert.equal(got.status, 200);
    assert.equal(got.body.dataset.name, 'Auth regressions');
    assert.deepEqual(got.body.examples, []);

    const renamed = await s.call('PUT', '/api/datasets/auth-regressions', { name: 'Auth' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.dataset.name, 'Auth');
    assert.equal(renamed.body.dataset.slug, 'auth-regressions', 'the slug is fixed');

    assert.equal((await s.call('POST', '/api/datasets', { name: 'x' }, { type: 'text/plain' })).status, 415);
    assert.equal((await s.call('PUT', '/api/datasets/auth-regressions', { name: 'x' }, { type: '' })).status, 415);
    assert.equal((await s.call('POST', '/api/datasets', '{not json')).status, 400);
    assert.equal((await s.call('POST', '/api/datasets', [])).status, 400);
    const long = await s.call('POST', '/api/datasets', { name: 'x'.repeat(600) });
    assert.equal(long.status, 400);
    assert.equal((await s.call('GET', '/api/datasets', undefined, { query: `q=${'x'.repeat(600)}` })).status, 400);
    assert.equal((await s.call('GET', `/api/datasets/${'a'.repeat(600)}`)).status, 400);
    assert.equal((await s.call('GET', '/api/datasets/nope')).status, 404);
    assert.equal((await s.call('POST', '/api/datasets', { name: 'Bad', slug: 'Bad Slug' })).status, 400);

    assert.deepEqual((await s.call('DELETE', '/api/datasets/auth-regressions')).body, { deleted: true });
    assert.equal((await s.call('DELETE', '/api/datasets/auth-regressions')).status, 404);
    assert.deepEqual((await s.call('GET', '/api/datasets')).body.datasets, []);
  } finally {
    s.done();
  }
});

test('datasets api: adding from trace items stores the source and links back by key, never by session id', async () => {
  const s = setup();
  try {
    await s.call('POST', '/api/datasets', { name: 'Auth', slug: 'auth' });
    const r = await s.call('POST', '/api/datasets/auth/examples', {
      items: [
        { key: 'claude.k1', turn: 0, span: 'sealed-91' },
        { key: 'kiro.k2', turn: 0 },
        { key: 'claude.k1', turn: 0 },
        { key: 'missing.k9', turn: 1 },
        { key: 'claude.k1', turn: 2, span: 'sealed-00' },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.added.length, 1);
    const row = r.body.added[0];
    assert.deepEqual(row.link, { source: 'claude', key: 'claude.k1', turn: 0, span: 'sealed-91' });
    assert.deepEqual(
      Object.keys(row).sort(),
      ['createdAt', 'evals', 'feedback', 'id', 'input', 'link', 'output', 'reference', 'tags', 'updatedAt'].sort(),
    );
    assert.equal(row.output.text, 'Fixed the redirect.');
    assert.deepEqual(r.body.skipped, [
      { index: 1, reason: 'this session has no text' },
      { index: 2, reason: 'already in this dataset' },
      { index: 3, reason: 'unknown session' },
      { index: 4, reason: 'span is not in this turn' },
    ]);
    // The store keeps the source (with the raw ids) for the link; no response carries them.
    const stored = s.datasets.examples('auth')[0];
    assert.deepEqual(stored.source, { source: 'claude', session: RAW_SESSION, turn: 0, span: RAW_SPAN });
    const got = await s.call('GET', '/api/datasets/auth');
    const text = JSON.stringify([r.body, got.body]);
    assert.doesNotMatch(text, new RegExp(RAW_SESSION));
    assert.doesNotMatch(text, new RegExp(RAW_SPAN));
    assert.equal(got.body.examples[0].link.key, 'claude.k1');

    // Item checks: 1 to 50 items, a key, a whole turn.
    const bad = async (items) => (await s.call('POST', '/api/datasets/auth/examples', { items })).status;
    assert.equal(await bad([]), 400);
    assert.equal(await bad(Array.from({ length: 51 }, (_, i) => ({ key: 'claude.k1', turn: i }))), 400);
    assert.equal(await bad([{ key: 'claude.k1', turn: -1 }]), 400);
    assert.equal(await bad([{ key: 'claude.k1', turn: 1.5 }]), 400);
    assert.equal(await bad([{ turn: 1 }]), 400);
    assert.equal(await bad([{ key: 'claude.k1', turn: 1, span: 7 }]), 400);
    assert.equal(
      (await s.call('POST', '/api/datasets/nope/examples', { items: [{ key: 'claude.k1', turn: 0 }] })).status,
      404,
    );

    // An imported example has no source: its link is null. One whose session is gone links with a null key.
    s.datasets.add('auth', [
      {
        input: { messages: [{ role: 'user', text: 'q' }] },
        output: { text: 'a' },
        source: { source: 'claude', session: 'gone-session', turn: 3, span: null },
      },
      { input: { messages: [{ role: 'user', text: 'q2' }] }, output: { text: 'a2' } },
    ]);
    const rows = (await s.call('GET', '/api/datasets/auth')).body.examples;
    assert.deepEqual(rows[1].link, { source: 'claude', key: null, turn: 3, span: null });
    assert.equal(rows[2].link, null);
    assert.doesNotMatch(JSON.stringify(rows), /gone-session/);
  } finally {
    s.done();
  }
});

test('datasets api: PATCH a reference and tags, DELETE an example', async () => {
  const s = setup();
  try {
    const row = await withExample(s);
    const p = `/api/datasets/auth/examples/${row.id}`;
    const patched = await s.call('PATCH', p, { reference: 'Redirect to the next parameter', tags: ['auth', 'login'] });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.example.reference, { text: 'Redirect to the next parameter' });
    assert.deepEqual(patched.body.example.tags, ['auth', 'login']);
    assert.equal(patched.body.example.link.key, 'claude.k1');
    assert.equal((await s.call('PATCH', p, { reference: null })).body.example.reference, null);
    assert.equal((await s.call('PATCH', p, { tags: ['bad tag!'] })).status, 400);
    assert.equal((await s.call('PATCH', p, { reference: 5 })).status, 400);
    assert.equal((await s.call('PATCH', p, { other: 1 })).status, 400);
    assert.equal((await s.call('PATCH', p, { tags: ['x'] }, { type: 'text/plain' })).status, 415);
    assert.equal((await s.call('PATCH', '/api/datasets/auth/examples/ex_0000000000000000', { tags: [] })).status, 404);
    assert.deepEqual((await s.call('DELETE', p)).body, { deleted: true });
    assert.equal((await s.call('DELETE', p)).status, 404);
    assert.deepEqual((await s.call('GET', '/api/datasets/auth')).body.examples, []);
  } finally {
    s.done();
  }
});

test('datasets api: export then import round-trips; a bad line is a 400 with reasons', async () => {
  const s = setup();
  try {
    await withExample(s);
    const out = await s.call('GET', '/api/datasets/auth/export');
    assert.equal(out.status, 200);
    assert.equal(out.type, 'application/x-ndjson; charset=utf-8');
    assert.equal(typeof out.body, 'string');
    assert.equal(out.body.trim().split('\n').length, 1);

    const imp = await s.call('POST', '/api/datasets/import', { slug: 'copy', name: 'Copy', jsonl: out.body });
    assert.equal(imp.status, 200);
    assert.equal(imp.body.added, 1);
    assert.equal(imp.body.dataset.slug, 'copy');
    assert.equal(imp.body.dataset.count, 1);
    const a = s.datasets.examples('auth')[0];
    const b = s.datasets.examples('copy')[0];
    assert.deepEqual(b.input, a.input);
    assert.deepEqual(b.output, a.output);

    const bad = await s.call('POST', '/api/datasets/import', { slug: 'broken', jsonl: `${out.body}{nope\n` });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.body.reasons) && bad.body.reasons.length === 1);
    assert.match(bad.body.reasons[0], /^line 2: /);
    assert.equal(s.datasets.get('broken'), null, 'nothing written');
    assert.equal((await s.call('POST', '/api/datasets/import', { slug: 'x', jsonl: 5 })).status, 400);
    assert.equal((await s.call('GET', '/api/datasets/nope/export')).status, 404);
  } finally {
    s.done();
  }
});

test('datasets api: an import body may be larger than 1 MB, up to the import limit', async () => {
  const s = setup();
  try {
    const big = 'y'.repeat(60000);
    const line = (i) =>
      JSON.stringify({ input: { messages: [{ role: 'user', text: `${i} ${big}` }] }, output: { text: 'a' } });
    const jsonl = Array.from({ length: 20 }, (_, i) => line(i)).join('\n');
    assert.ok(jsonl.length > 1e6);
    const r = await s.call('POST', '/api/datasets/import', { slug: 'big', jsonl });
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 20);
    // Any other route keeps the 1 MB body cap.
    assert.equal((await s.call('POST', '/api/datasets', { name: 'n', pad: 'z'.repeat(1.1e6) })).status, 413);
  } finally {
    s.done();
  }
});

test('datasets api: content off hides every text and refuses add, export and the preview', async () => {
  const s = setup();
  try {
    await withExample(s);
    // The same store files, read by an API with content viewing off.
    const api = createDatasetApi({
      datasets: s.datasets,
      experiments: s.experiments,
      runner: s.runner,
      replay: fakeReplay(),
      trace: fakeTrace(),
      contentOff: true,
      settings: { get: () => ({}), save: () => {} },
    });
    const call = (method, p, body) =>
      api.route({
        method,
        path: p,
        query: new URLSearchParams(),
        contentType: body === undefined ? undefined : 'application/json',
        readBody: async () => JSON.stringify(body),
      });
    await call('PATCH', `/api/datasets/auth/examples/${s.datasets.examples('auth')[0].id}`, { reference: 'ref text' });
    const list = await call('GET', '/api/datasets');
    assert.equal(list.body.content, false);
    const got = await call('GET', '/api/datasets/auth');
    const row = got.body.examples[0];
    assert.equal(row.output.text, null);
    assert.equal(row.reference.text, null);
    assert.equal(row.input.system, null);
    assert.ok(row.input.messages.every((m) => m.text === null));
    assert.equal(row.link.key, 'claude.k1');
    assert.doesNotMatch(JSON.stringify(got.body), /Fixed the redirect|npm test|ref text|login redirect/);

    const add = await call('POST', '/api/datasets/auth/examples', { items: [{ key: 'claude.k1', turn: 1 }] });
    assert.deepEqual([add.status, add.body], [403, { error: 'content viewing is off' }]);
    assert.equal((await call('GET', '/api/datasets/auth/export')).status, 403);
    const preview = await call('POST', '/api/experiments', {
      dataset: 'auth',
      models: ['ext/gpt'],
      evaluators: ['secret_leak'],
      preview: true,
    });
    assert.equal(preview.status, 403);

    // Tag edits, deletes and runs still work; the record comes back without its texts.
    const tags = await call('PATCH', `/api/datasets/auth/examples/${row.id}`, { tags: ['kept'] });
    assert.equal(tags.status, 200);
    assert.equal(tags.body.example.output.text, null);
    const started = await call('POST', '/api/experiments', {
      dataset: 'auth',
      models: ['ollama/qwen3'],
      evaluators: ['secret_leak'],
    });
    assert.equal(started.status, 202);
    s.runner.finish();
    for (let i = 0; i < 100 && api.running(); i++) await new Promise((r) => setImmediate(r));
    const rec = (await call('GET', `/api/experiments/${started.body.id}`)).body;
    assert.equal(rec.status, 'done');
    assert.equal(rec.perExample[0].output.text, null);
    assert.equal(rec.perExample[0].output.proposal.arguments, null);
    assert.equal(rec.perExample[0].output.proposal.name, 'Bash');
  } finally {
    s.done();
  }
});

test('datasets api: an experiment starts in the background, one at a time, and its record is kept', async () => {
  const s = setup();
  try {
    const row = await withExample(s);
    const body = { dataset: 'auth', models: ['ollama/qwen3'], evaluators: ['secret_leak', 'relevance'] };
    const first = await s.call('POST', '/api/experiments', body);
    assert.equal(first.status, 202);
    assert.deepEqual(first.body, { id: 'exp_0000000000000001', status: 'running' });
    assert.equal(s.api.running(), 'exp_0000000000000001');
    const opts = s.runner.calls[0];
    assert.deepEqual(
      opts.examples.map((e) => e.id),
      [row.id],
    );
    assert.equal(opts.dataset.slug, 'auth');
    assert.equal(opts.maxCostUSD, 0.5);
    assert.equal(opts.maxRequests, 100);

    assert.equal((await s.call('POST', '/api/experiments', body)).status, 409, 'another run in progress');
    const listed = (await s.call('GET', '/api/experiments')).body;
    assert.deepEqual(listed.running, {
      id: 'exp_0000000000000001',
      dataset: 'auth',
      done: 0,
      total: 1,
      requests: 0,
      cost: 0,
    });
    assert.equal(listed.models[0].name, 'ollama/qwen3');
    assert.ok(listed.evaluators.some((e) => e.id === 'reference_match'));
    const running = await s.call('GET', '/api/experiments/exp_0000000000000001');
    assert.deepEqual(running.body, {
      id: 'exp_0000000000000001',
      status: 'running',
      progress: { done: 0, total: 1, requests: 0, cost: 0 },
    });

    s.runner.finish();
    await s.idle();
    assert.equal(s.api.running(), null);
    const rec = (await s.call('GET', '/api/experiments/exp_0000000000000001')).body;
    assert.equal(rec.status, 'done');
    assert.equal(rec.perExample[0].output.text, 'replayed answer');
    const after = (await s.call('GET', '/api/experiments')).body;
    assert.equal(after.running, null);
    assert.equal(after.experiments.length, 1);
    assert.equal(after.experiments[0].examples, 1);
    assert.equal(Object.hasOwn(after.experiments[0], 'perExample'), false);

    assert.equal((await s.call('GET', '/api/experiments/exp_00000000000000ff')).status, 404);
    assert.equal((await s.call('GET', '/api/experiments/not-an-id')).status, 404);

    // A chosen subset of examples, and caps in range.
    const second = await s.call('POST', '/api/experiments', {
      ...body,
      examples: [row.id],
      maxCostUSD: 10,
      maxRequests: 1000,
    });
    assert.equal(second.status, 202);
    assert.equal(s.runner.calls[1].maxCostUSD, 10);
    assert.equal(s.runner.calls[1].maxRequests, 1000);
    // A runner failure is logged and kept as a stopped record.
    s.runner.fail();
    await s.idle();
    const failed = (await s.call('GET', `/api/experiments/${second.body.id}`)).body;
    assert.equal(failed.status, 'stopped');
    assert.equal(failed.stopped, 'error');
    assert.equal(s.logs.length, 1);
    assert.doesNotMatch(s.logs[0], /\/Users\//);
  } finally {
    s.done();
  }
});

test('datasets api: experiment requests are checked (models, evaluators, examples, caps)', async () => {
  const s = setup();
  try {
    const row = await withExample(s);
    const base = { dataset: 'auth', models: ['ollama/qwen3'], evaluators: ['secret_leak'] };
    const status = async (over) => (await s.call('POST', '/api/experiments', { ...base, ...over })).status;
    assert.equal(await status({ models: ['nope/model'] }), 400, 'an unknown model');
    assert.equal(await status({ models: ['ext/unpriced'] }), 400, 'an external model without a price');
    assert.equal(await status({ models: [] }), 400);
    assert.equal(await status({ models: ['ollama/qwen3', 'ollama/qwen3'] }), 400, 'distinct');
    assert.equal(await status({ models: ['a/1', 'a/2', 'a/3', 'a/4'] }), 400);
    assert.equal(await status({ evaluators: [] }), 400);
    assert.equal(await status({ evaluators: ['correction'] }), 400, 'not an experiment evaluator');
    assert.equal(await status({ evaluators: ['secret_leak', 'secret_leak'] }), 400);
    assert.equal(await status({ dataset: 'nope' }), 400);
    assert.equal(await status({ examples: [] }), 400);
    assert.equal(await status({ examples: ['ex_ffffffffffffffff'] }), 400);
    assert.equal(await status({ examples: [row.id, row.id] }), 400);
    assert.equal(await status({ maxCostUSD: 0 }), 400);
    assert.equal(await status({ maxCostUSD: 10.01 }), 400);
    assert.equal(await status({ maxCostUSD: '1' }), 400);
    assert.equal(await status({ maxRequests: 0 }), 400);
    assert.equal(await status({ maxRequests: 1001 }), 400);
    assert.equal(await status({ maxRequests: 2.5 }), 400);
    assert.equal(await status({ preview: 'yes' }), 400);
    assert.equal(await status({ other: 1 }), 400);
    assert.equal((await s.call('POST', '/api/experiments', base, { type: 'text/plain' })).status, 415);
    await s.call('POST', '/api/datasets', { name: 'Empty', slug: 'empty' });
    assert.equal(await status({ dataset: 'empty' }), 400, 'a dataset without examples');
    assert.equal(s.runner.calls.length, 0, 'nothing started');
  } finally {
    s.done();
  }
});

test('datasets api: an external model needs the preview, whose confirm then starts the run', async () => {
  const s = setup();
  try {
    await withExample(s);
    const body = { dataset: 'auth', models: ['ext/gpt', 'ollama/qwen3'], evaluators: ['secret_leak'] };
    const refused = await s.call('POST', '/api/experiments', body);
    assert.deepEqual(
      [refused.status, refused.body],
      [428, { error: 'preview what will be sent first', preview: true }],
    );
    assert.equal((await s.call('POST', '/api/experiments', { ...body, confirm: 'f'.repeat(32) })).status, 428);

    const p = await s.call('POST', '/api/experiments', { ...body, preview: true });
    assert.equal(p.status, 200);
    assert.equal(p.body.preview.length, 1, 'only the external model is previewed');
    assert.equal(p.body.preview[0].model, 'ext/gpt');
    const sent = JSON.stringify(p.body.preview[0].messages);
    assert.doesNotMatch(sent, new RegExp(EMAIL.replace(/\./g, '\\.')), 'personal data is masked');
    assert.match(sent, /‹email›/);
    assert.match(sent, /\[tool result: Bash\]/);
    assert.equal(typeof p.body.confirm, 'string');
    assert.equal(s.runner.calls.length, 0, 'a preview starts nothing');

    // The token is for this dataset, these examples and these models (in any order).
    const other = { ...body, models: ['ext/gpt'], confirm: p.body.confirm };
    assert.equal((await s.call('POST', '/api/experiments', other)).status, 428);
    const ok = await s.call('POST', '/api/experiments', {
      ...body,
      models: ['ollama/qwen3', 'ext/gpt'],
      confirm: p.body.confirm,
    });
    assert.equal(ok.status, 202);
    assert.equal(s.runner.calls.length, 1);
    s.runner.finish();
    await s.idle();
  } finally {
    s.done();
  }
});

test('datasets api: the settings route stores autoAdd and checks it', async () => {
  const s = setup();
  try {
    const defaults = { enabled: false, dataset: '', onFail: true, onBad: true };
    assert.deepEqual((await s.call('GET', '/api/datasets/settings')).body, { autoAdd: defaults });
    await s.call('POST', '/api/datasets', { name: 'Auth', slug: 'auth' });
    const saved = await s.call('POST', '/api/datasets/settings', { autoAdd: { enabled: true, dataset: 'auth' } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { autoAdd: { ...defaults, enabled: true, dataset: 'auth' } });
    assert.deepEqual(s.stored(), { autoAdd: { ...defaults, enabled: true, dataset: 'auth' } });
    assert.deepEqual(s.api.settings(), { autoAdd: { ...defaults, enabled: true, dataset: 'auth' } });
    const off = await s.call('POST', '/api/datasets/settings', { autoAdd: { onBad: false } });
    assert.equal(off.body.autoAdd.onBad, false);
    assert.equal(off.body.autoAdd.enabled, true, 'the other values are kept');

    assert.equal((await s.call('POST', '/api/datasets/settings', { autoAdd: { onFail: 'yes' } })).status, 400);
    assert.equal((await s.call('POST', '/api/datasets/settings', { autoAdd: { enabled: 1 } })).status, 400);
    assert.equal((await s.call('POST', '/api/datasets/settings', { autoAdd: { dataset: 'nope' } })).status, 400);
    assert.equal((await s.call('POST', '/api/datasets/settings', { autoAdd: { other: true } })).status, 400);
    assert.equal((await s.call('POST', '/api/datasets/settings', { other: {} })).status, 400);
    assert.equal((await s.call('POST', '/api/datasets/settings', { autoAdd: 'on' })).status, 400);
    assert.equal(s.stored().autoAdd.dataset, 'auth', 'a refused change saves nothing');
    // Off with no dataset is fine.
    const cleared = await s.call('POST', '/api/datasets/settings', { autoAdd: { enabled: false, dataset: '' } });
    assert.equal(cleared.status, 200);
  } finally {
    s.done();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Spawned server.js
// ---------------------------------------------------------------------------------------------------------------

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own (the trace tests use 5100-5899, the eval tests 5900-6399).
    const port = 6400 + Math.floor(Math.random() * 500);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
// Starts server.js on a free port of the range; tries again when another test took the port first.
async function startServer(env, { data = tmp('zp-ds-api-') } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
      },
      stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const base = `http://127.0.0.1:${port}`;
    const kill = async () => {
      if (!exited) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
    };
    const stop = async () => {
      await kill();
      fs.rmSync(data, { recursive: true, force: true });
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { port, data, base, child, stop };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  fs.rmSync(data, { recursive: true, force: true });
  throw new Error('could not start server.js on a free port');
}

function client(base, headers = {}) {
  const bodies = [];
  const call = async (p, { method = 'GET', body, extra = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    bodies.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text, type: r.headers.get('content-type') };
  };
  const post = (p, body) => call(p, { method: 'POST', body, extra: JSON_HEADERS });
  return { call, post, bodies };
}
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;

test('datasets api: demo datasets and experiments over HTTP, masked and path-free', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const list = await c.call('/api/datasets');
    assert.equal(list.status, 200);
    const slugs = list.json.datasets.map((d) => d.slug);
    assert.ok(slugs.includes('auth-regressions') && slugs.includes('pagination'));
    const got = await c.call('/api/datasets/auth-regressions');
    assert.equal(got.status, 200);
    assert.ok(got.json.examples.length >= 1);
    assert.doesNotMatch(got.text, /sk-ant/);
    assert.doesNotMatch(got.text, /\/Users\//);
    assert.match(got.text, /hidden›/, 'the fake key was masked when seeded');
    const linked = got.json.examples.find((e) => e.link);
    assert.ok(linked.link.key, 'the demo example links to its demo session');
    assert.doesNotMatch(got.text, /demo-claude-1/, 'no raw session id');

    const exps = await c.call('/api/experiments');
    assert.equal(exps.status, 200);
    assert.equal(exps.json.experiments.length, 2);
    assert.equal(exps.json.running, null);
    const stopped = exps.json.experiments.find((e) => e.stopped === 'cost cap');
    assert.ok(stopped, 'one run stopped at its cost cap');
    const rec = await c.call(`/api/experiments/${exps.json.experiments[0].id}`);
    assert.equal(rec.status, 200);
    assert.ok(Array.isArray(rec.json.perExample));

    const out = await c.call('/api/datasets/auth-regressions/export');
    assert.equal(out.status, 200);
    assert.match(out.type, /application\/x-ndjson/);
    assert.equal((await c.call('/api/datasets', { method: 'POST', body: { name: 'x' } })).status, 415);
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
  } finally {
    await s.stop();
  }
});

test('datasets api: a gateway API key is not a dashboard sign-in', async () => {
  const data = tmp('zp-ds-api-');
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const apiKey = gw.keys.create({ name: 'datasets', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 }).secret;
  gw.flush();
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  try {
    const bearer = client(s.base, { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey });
    for (const who of [client(s.base), bearer]) {
      for (const p of ['/api/datasets', '/api/experiments', '/api/datasets/settings'])
        assert.equal((await who.call(p)).status, 401, p);
      for (const p of ['/api/datasets', '/api/experiments', '/api/datasets/import'])
        assert.equal((await who.post(p, { name: 'x' })).status, 401, p);
    }

    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const c = client(s.base, { cookie });
    const created = await c.post('/api/datasets', { name: 'Signed in' });
    assert.equal(created.status, 200);
    assert.equal((await c.call('/api/datasets')).json.datasets[0].slug, 'signed-in');
    const file = path.join(data, '.data', 'datasets', 'index.json');
    assert.ok(fs.existsSync(file), 'the store lives in .data/datasets');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS);
  } finally {
    await s.stop();
  }
});
