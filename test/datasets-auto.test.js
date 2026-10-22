// Auto-add: failing judge verdicts and 👎 ratings copy their turn into the chosen dataset, tagged `auto`. A fake trace
// stands in for the logs; the dataset store is the real one in a temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatasetStore } = require('../lib/datasets/store');
const { createAutoAdd } = require('../lib/datasets/auto');

// Two sessions with a turn of text each; `empty` has none (a light source).
function fakeTrace() {
  const sessions = {
    'claude.k1': ['claude', 'sess-1'],
    'codex.k2': ['codex', 'sess-2'],
    'kiro.k3': ['kiro', 'sess-3'],
  };
  const calls = [];
  return {
    calls,
    keyFor(source, sid) {
      for (const [key, [s, id]] of Object.entries(sessions)) if (s === source && id === sid) return key;
      throw Object.assign(new Error('unknown session'), { status: 404 });
    },
    async example(key, turn) {
      calls.push([key, turn]);
      const [source, session] = sessions[key];
      if (source === 'kiro') return null;
      return {
        input: { system: null, messages: [{ role: 'user', text: `prompt ${turn}` }], tools: [] },
        output: { text: `answer ${turn}`, model: null },
        source: { source, session, turn, span: null },
      };
    },
  };
}

function setup({ enabled = true, dataset = 'auto-set', contentOff = false, onFail = true, onBad = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-auto-'));
  const datasets = createDatasetStore({ dir: path.join(dir, 'datasets') });
  datasets.create({ name: 'Auto set', slug: 'auto-set' });
  const cfg = { enabled, dataset, onFail, onBad };
  const logs = [];
  const trace = fakeTrace();
  const auto = createAutoAdd({ datasets, trace, settings: () => cfg, contentOff, log: (m) => logs.push(m) });
  const rows = () => datasets.examples('auto-set');
  return { dir, datasets, cfg, logs, trace, auto, rows, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const failing = (turn = 0, over = {}) => ({
  evaluator: 'relevance',
  kind: 'judge',
  label: 'off-topic',
  target: { source: 'claude', session: 'sess-1', turn, span: null },
  ...over,
});

test('auto-add: disabled adds nothing', async () => {
  const s = setup({ enabled: false });
  try {
    s.auto.onResult(failing());
    s.auto.onFeedback({ rating: 'bad', target: { source: 'claude', session: 'sess-1', turn: 0, span: null } });
    await s.auto.drain();
    assert.equal(s.rows().length, 0);
    assert.equal(s.trace.calls.length, 0, 'no trace read while it is off');
  } finally {
    s.done();
  }
});

test('auto-add: a failing judge verdict adds the turn tagged auto with its label', async () => {
  const s = setup();
  try {
    s.auto.onResult(failing(0));
    await s.auto.drain();
    const rows = s.rows();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].tags, ['auto']);
    assert.deepEqual(rows[0].evals, { relevance: 'off-topic' });
    assert.equal(rows[0].feedback, null);
    assert.deepEqual(rows[0].source, { source: 'claude', session: 'sess-1', turn: 0, span: null });
    assert.equal(s.auto.stats().added, 1);
    assert.equal(s.auto.stats().queued, 0);
  } finally {
    s.done();
  }
});

test('auto-add: a passing verdict, a code evaluator, a session verdict or onFail off add nothing', async () => {
  const s = setup();
  try {
    s.auto.onResult(failing(0, { label: 'relevant' }));
    s.auto.onResult(failing(1, { evaluator: 'secret_leak', kind: 'code', label: 'leaked' }));
    s.auto.onResult(failing(2, { evaluator: 'user_frustration', label: 'high' }));
    s.auto.onResult(failing(null));
    s.auto.onResult(null);
    s.auto.onResult({ evaluator: 'nope', label: 'x', target: { source: 'claude', session: 'sess-1', turn: 3 } });
    s.cfg.onFail = false;
    s.auto.onResult(failing(4));
    await s.auto.drain();
    assert.equal(s.rows().length, 0);
  } finally {
    s.done();
  }
});

test('auto-add: a bad rating adds the turn with feedback bad; a good one does not', async () => {
  const s = setup();
  try {
    s.auto.onFeedback({ rating: 'good', target: { source: 'codex', session: 'sess-2', turn: 0, span: null } });
    s.auto.onFeedback({ rating: 'bad', target: { source: 'codex', session: 'sess-2', turn: null, span: null } });
    s.auto.onFeedback({ rating: 'bad', target: { source: 'codex', session: 'sess-2', turn: 1, span: null } });
    await s.auto.drain();
    const rows = s.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].feedback, 'bad');
    assert.deepEqual(rows[0].tags, ['auto']);
    assert.deepEqual(rows[0].evals, {});
    assert.equal(rows[0].source.turn, 1);
    s.cfg.onBad = false;
    s.auto.onFeedback({ rating: 'bad', target: { source: 'codex', session: 'sess-2', turn: 2, span: null } });
    await s.auto.drain();
    assert.equal(s.rows().length, 1, 'onBad off');
  } finally {
    s.done();
  }
});

test('auto-add: the same turn twice is one example', async () => {
  const s = setup();
  try {
    s.auto.onResult(failing(0));
    s.auto.onResult(failing(0, { evaluator: 'faithfulness', label: 'unfaithful' }));
    s.auto.onFeedback({ rating: 'bad', target: { source: 'claude', session: 'sess-1', turn: 0, span: null } });
    assert.equal(s.auto.stats().queued, 1, 'deduplicated in the queue');
    await s.auto.drain();
    s.auto.onResult(failing(0));
    await s.auto.drain();
    const rows = s.rows();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].evals, { relevance: 'off-topic', faithfulness: 'unfaithful' });
    assert.equal(rows[0].feedback, 'bad');
  } finally {
    s.done();
  }
});

test('auto-add: content off adds nothing', async () => {
  const s = setup({ contentOff: true });
  try {
    s.auto.onResult(failing(0));
    s.auto.onFeedback({ rating: 'bad', target: { source: 'claude', session: 'sess-1', turn: 1, span: null } });
    await s.auto.drain();
    assert.equal(s.rows().length, 0);
    assert.equal(s.trace.calls.length, 0);
  } finally {
    s.done();
  }
});

test('auto-add: a missing dataset, an unknown session or a turn without text add nothing and never throw', async () => {
  const s = setup({ dataset: 'gone' });
  try {
    assert.doesNotThrow(() => s.auto.onResult(failing(0)));
    await s.auto.drain();
    assert.equal(s.rows().length, 0);
    assert.equal(s.logs.length, 1, 'logged once');
    s.auto.onResult(failing(1));
    await s.auto.drain();
    assert.equal(s.logs.length, 1, 'the same reason is not logged again');

    s.cfg.dataset = 'auto-set';
    s.auto.onResult(failing(0, { target: { source: 'claude', session: 'unknown', turn: 0, span: null } }));
    s.auto.onResult(failing(0, { target: { source: 'kiro', session: 'sess-3', turn: 0, span: null } }));
    await s.auto.drain();
    assert.equal(s.rows().length, 0);
    assert.ok(s.auto.stats().skipped >= 4);
  } finally {
    s.done();
  }
});

test('auto-add: the queue is bounded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-auto-'));
  try {
    const datasets = createDatasetStore({ dir: path.join(dir, 'datasets') });
    datasets.create({ name: 'Auto set', slug: 'auto-set' });
    let release;
    const gate = new Promise((r) => (release = r));
    const trace = {
      keyFor: () => 'claude.k1',
      example: async (key, turn) => {
        await gate;
        return {
          input: { system: null, messages: [{ role: 'user', text: 'p' }], tools: [] },
          output: { text: 'a', model: null },
          source: { source: 'claude', session: 'sess-1', turn, span: null },
        };
      },
    };
    const cfg = { enabled: true, dataset: 'auto-set', onFail: true, onBad: true };
    const auto = createAutoAdd({ datasets, trace, settings: () => cfg, max: 5 });
    for (let t = 0; t < 10; t++) auto.onResult(failing(t));
    assert.ok(auto.stats().queued <= 5);
    release();
    await auto.drain();
    assert.ok(datasets.examples('auto-set').length <= 6, 'one in flight plus the queue');
    assert.ok(auto.stats().skipped >= 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the hooks auto-add listens on ----
const { createEvalEngine } = require('../lib/evals/engine');
const { createEvalApi } = require('../lib/evals/api');
const { createEvalStore, createFeedbackStore } = require('../lib/evals/store');
const R = require('../lib/evals/registry');

test('hooks: the eval engine reports each stored judge result; a throwing listener does not stop judging', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-auto-hook-'));
  try {
    const MIN = 60e3;
    const T0 = new Date(2026, 9, 21, 10, 0, 0).getTime();
    const clock = { t: T0 };
    const entries = [];
    const seen = [];
    const engine = createEvalEngine({
      trace: {
        material: async (source, sid, turn) => ({
          material: { prompt: 'p', answer: 'a', tools: [], available: [] },
          target: { source, session: sid, turn, span: null },
          finishedAt: clock.t,
        }),
        materialSession: async () => null,
        sessions: () => [],
        sourceOf: (key) => ({ source: 'claude', sid: key }),
        keyFor: (source, sid) => sid,
        turnsOf: async () => [],
      },
      indexer: { entries: () => entries },
      models: {
        stop() {},
        resolve: async () => ({ ok: true, kind: 'ollama', model: 'qwen3:8b', provider: 'ollama' }),
        priced: () => true,
        priceOf: () => null,
        // The failing label (the last one), so the verdict is one auto-add would take.
        call: async (resolved, { schema }) => ({
          text: JSON.stringify({ label: schema.properties.label.enum.at(-1), explanation: 'off' }),
          usage: { input: 10, output: 5, cost: 0 },
        }),
      },
      store: createEvalStore({ file: path.join(dir, 'evals.jsonl') }),
      feedback: createFeedbackStore({ file: path.join(dir, 'feedback.jsonl') }),
      settings: () => ({
        judge: true,
        provider: 'auto',
        model: '',
        dailyCap: 500,
        costCapUSD: 1,
        evaluators: Object.fromEntries(
          R.EVALUATORS.filter((e) => e.kind === 'judge').map((e) => [e.id, e.id === 'relevance']),
        ),
      }),
      stateFile: path.join(dir, 'evals-state.json'),
      now: () => clock.t,
      onResult: (r) => {
        seen.push(r);
        if (seen.length === 1) throw new Error('listener broke');
      },
    });
    await engine.tick(); // the first tick records "since"
    clock.t += MIN;
    entries.push({
      file: '/x/claude/s.jsonl',
      source: 'claude',
      size: 1,
      mtimeMs: T0 + 4 * MIN,
      result: {
        sessions: {
          s: {
            turns: [
              [0, T0 + 2 * MIN],
              [0, T0 + 3 * MIN],
            ],
          },
        },
        signals: { events: [] },
      },
    });
    clock.t = T0 + 10 * MIN;
    await engine.tick();
    await engine.drain();
    assert.equal(seen.length, 2, 'both turns judged, although the listener threw on the first');
    for (const r of seen) {
      assert.equal(r.evaluator, 'relevance');
      assert.equal(r.label, 'off-topic');
      assert.equal(r.target.session, 's');
      assert.ok(r.id && r.key, 'the stored record');
    }
    assert.deepEqual(seen.map((r) => r.target.turn).sort(), [0, 1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hooks: the eval API reports each saved rating; a throwing listener does not fail the request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-auto-hook-'));
  try {
    const seen = [];
    let broken = false;
    const api = createEvalApi({
      trace: {
        sourceOf: () => ({ source: 'claude', sid: 'sess-1' }),
        turnsOf: async () => [{ index: 0 }, { index: 1 }],
      },
      engine: { kick() {} },
      feedback: createFeedbackStore({ file: path.join(dir, 'feedback.jsonl') }),
      settings: { get: () => ({}), save() {} },
      onFeedback: (r) => {
        seen.push(r);
        if (broken) throw new Error('listener broke');
      },
    });
    const post = (body) =>
      api.route({
        method: 'POST',
        path: '/api/feedback',
        query: new URLSearchParams(),
        contentType: 'application/json',
        readBody: async () => JSON.stringify(body),
      });
    assert.equal((await post({ key: 'k', turn: 1, rating: 'bad' })).status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].rating, 'bad');
    assert.deepEqual(seen[0].target, { source: 'claude', session: 'sess-1', turn: 1, span: null });
    broken = true;
    assert.equal((await post({ key: 'k', turn: 0, rating: 'good' })).status, 200);
    assert.equal(seen.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
