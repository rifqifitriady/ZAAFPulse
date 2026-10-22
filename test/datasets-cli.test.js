const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fakeServer, NO_JUDGE_PORTS } = require('./helpers');
const { createDatasetStore } = require('../lib/datasets/store');
const { parseRequirement, checkRequirements, DATASET_USAGE } = require('../lib/datasets/cli');

const BIN = path.join(__dirname, '..', 'bin', 'zaafpulse.js');
const REFERENCE = 'the redirect keeps next';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A stand-in OpenAI-compatible server for both gateway providers: every call answers `text`. `hold` keeps the
// reply back until released, for the signal test.
async function fakeUpstream(text, { hold = null } = {}) {
  return fakeServer({
    'POST /chat/completions': async () => {
      if (hold) await hold;
      return {
        body: {
          choices: [{ message: { role: 'assistant', content: text } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        },
      };
    },
  });
}

// A stand-in Ollama for the judge: the first (passing) label of the schema it was asked for.
function fakeOllama() {
  return fakeServer({
    'GET /api/tags': { body: { models: [{ name: 'qwen3:8b' }] } },
    'POST /api/chat': (req) => {
      const label = req.body.format.properties.label.enum[0];
      return { body: { message: { content: JSON.stringify({ label, explanation: 'looks fine' }) } } };
    },
  });
}

// A temp HOME and a data folder with one private and one external provider (both the fake upstream), and the
// dataset auth-regressions: three examples, turns 0 to 2, each with the reference text.
function rig(upstream, { evals } = {}) {
  const home = tmp('ds-cli-home-');
  const data = tmp('ds-cli-data-');
  const config = {
    gateway: {
      providers: [
        { id: 'local', preset: 'custom', tier: 'private', baseUrl: upstream.url, models: ['qwen3'] },
        {
          id: 'openai',
          preset: 'custom',
          tier: 'external',
          approved: true,
          baseUrl: upstream.url,
          models: ['gpt-6.1'],
        },
      ],
    },
    ...(evals ? { evals } : {}),
  };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  const store = createDatasetStore({ dir: path.join(data, '.data', 'datasets') });
  store.create({ name: 'Auth regressions' });
  const { added } = store.add(
    'auth-regressions',
    [0, 1, 2].map((turn) => ({
      source: { source: 'claude', session: 's1', turn, span: null },
      input: {
        system: null,
        messages: [{ role: 'user', text: `fix the login redirect, case ${turn}` }],
        tools: [{ name: 'Read', description: '' }],
      },
      output: { text: 'Changed the redirect.', model: null },
      reference: { text: REFERENCE },
    })),
  );
  assert.equal(added.length, 3);
  return { home, data };
}

function runCli(args, { home, data, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ZAAFPULSE_DATA: data, ...NO_JUDGE_PORTS, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const records = (data) => {
  const file = path.join(data, '.data', 'experiments.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
};
const calls = (upstream) => upstream.requests.filter((q) => q.path === '/chat/completions').length;
const GATE = ['eval', '--dataset', 'auth-regressions', '--model', 'local/qwen3'];

// ---------------------------------------------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------------------------------------------

test('parseRequirement reads <evaluator>>=<0..1> and <evaluator>><0..1>, and nothing else', () => {
  assert.deepEqual(parseRequirement('reference_match>=0.8'), {
    evaluator: 'reference_match',
    op: '>=',
    threshold: 0.8,
  });
  assert.deepEqual(parseRequirement('task_completion>0.75'), {
    evaluator: 'task_completion',
    op: '>',
    threshold: 0.75,
  });
  assert.deepEqual(parseRequirement('secret_leak>=1'), { evaluator: 'secret_leak', op: '>=', threshold: 1 });
  assert.deepEqual(parseRequirement('secret_leak>=1.00'), { evaluator: 'secret_leak', op: '>=', threshold: 1 });
  assert.deepEqual(parseRequirement('relevance>0'), { evaluator: 'relevance', op: '>', threshold: 0 });
  for (const bad of [
    'reference_match=0.8',
    'reference_match>=1.5',
    'reference_match>=.8',
    'reference_match<=0.8',
    'Reference_match>=0.8',
    '>=0.8',
    'reference_match>=',
    'reference_match >= 0.8',
    'reference_match>=0.8x',
    '',
    null,
    undefined,
    42,
  ])
    assert.equal(parseRequirement(bad), null, String(bad));
});

test('checkRequirements gives one row per requirement and model; a missing rate is not ok', () => {
  const summary = {
    models: {
      'local/qwen3': { evaluators: { reference_match: { pass: 5, total: 6, rate: 5 / 6 } } },
      'lms/phi': { evaluators: { reference_match: { pass: 4, total: 5, rate: 0.8 } } },
      'other/x': { evaluators: { reference_match: { pass: 0, total: 0, rate: null } } },
    },
  };
  const reqs = [
    { evaluator: 'reference_match', op: '>=', threshold: 0.8 },
    { evaluator: 'reference_match', op: '>', threshold: 0.8 },
  ];
  const rows = checkRequirements(summary, reqs, ['local/qwen3', 'lms/phi', 'other/x', 'gone/y']);
  assert.equal(rows.length, 8);
  assert.deepEqual(Object.keys(rows[0]), ['evaluator', 'model', 'op', 'threshold', 'rate', 'pass', 'total', 'ok']);
  const ok = (model, op) => rows.find((r) => r.model === model && r.op === op).ok;
  assert.equal(ok('local/qwen3', '>='), true);
  assert.equal(ok('local/qwen3', '>'), true);
  assert.equal(ok('lms/phi', '>='), true, '0.8 meets >= 0.8');
  assert.equal(ok('lms/phi', '>'), false, '0.8 does not meet > 0.8');
  assert.equal(ok('other/x', '>='), false, 'no rate');
  const gone = rows.find((r) => r.model === 'gone/y');
  assert.deepEqual(gone, {
    evaluator: 'reference_match',
    model: 'gone/y',
    op: '>=',
    threshold: 0.8,
    rate: null,
    pass: 0,
    total: 0,
    ok: false,
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------

test('eval --dataset --ci exits 0 when the requirement holds, prints the table and stores the record', async () => {
  const up = await fakeUpstream(`Done: ${REFERENCE}.`);
  try {
    const r = rig(up);
    const res = await runCli([...GATE, '--require', 'reference_match>=0.8', '--ci'], r);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /EVALUATOR\s+MODEL\s+PASS RATE\s+REQUIRED\s+RESULT/);
    assert.match(res.out, /reference_match\s+local\/qwen3\s+100\.0% \(3\/3\)\s+>= 0\.80\s+pass/);
    assert.equal(calls(up), 3);
    const recs = records(r.data);
    assert.equal(recs.length, 1);
    assert.match(recs[0].id, /^exp_[0-9a-f]{16}$/);
    assert.equal(recs[0].dataset, 'auth-regressions');
    assert.equal(recs[0].status, 'done');
    assert.equal(recs[0].perExample.length, 3);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(r.data, '.data', 'experiments.jsonl')).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    await up.close();
  }
});

test('eval --dataset --ci exits 1 and prints FAIL when the requirement does not hold', async () => {
  const up = await fakeUpstream('I changed something else.');
  try {
    const r = rig(up);
    const res = await runCli([...GATE, '--require', 'reference_match>=0.8', '--ci'], r);
    assert.equal(res.code, 1, res.err);
    assert.match(res.out, /reference_match\s+local\/qwen3\s+0\.0% \(0\/3\)\s+>= 0\.80\s+FAIL/);
    assert.equal(records(r.data).length, 1);
    // Without --ci the run is reported and the exit is 0.
    const plain = await runCli([...GATE, '--require', 'reference_match>=0.8'], r);
    assert.equal(plain.code, 0, plain.err);
    assert.match(plain.out, /FAIL/);
  } finally {
    await up.close();
  }
});

test('eval --dataset with no --require runs the three code evaluators and checks nothing', async () => {
  const up = await fakeUpstream(`Done: ${REFERENCE}.`);
  try {
    const res = await runCli([...GATE, '--ci'], rig(up));
    assert.equal(res.code, 0, res.err);
    for (const id of ['reference_match', 'secret_leak', 'risky_command']) assert.match(res.out, new RegExp(id), id);
    assert.match(res.out, /secret_leak\s+local\/qwen3\s+100\.0% \(3\/3\)\s+-\s+-/);
  } finally {
    await up.close();
  }
});

test('eval --dataset exits 2 on configuration errors and sends nothing', async () => {
  const up = await fakeUpstream(REFERENCE);
  try {
    const r = rig(up);
    const cases = [
      [['eval', '--dataset', 'nope', '--model', 'local/qwen3'], /unknown dataset/],
      [[...GATE, '--require', 'nope>=0.5'], /unknown evaluator "nope"/],
      [[...GATE, '--require', 'reference_match=0.8'], /--require/],
      [[...GATE, '--require', 'reference_match>=1.5'], /--require/],
      [['eval', '--dataset', 'auth-regressions', '--model', 'openai/gpt-6.1'], /external models need the dashboard/],
      [['eval', '--dataset', 'auth-regressions', '--model', 'router/x'], /unknown model router\/x/],
      [[...GATE, '--require', 'task_completion>=0.7'], /judge unavailable: /],
      [['eval', '--dataset', 'auth-regressions'], /--model/],
      [[...GATE, '--model', 'a/b', '--model', 'c/d', '--model', 'e/f'], /at most 3/],
      [[...GATE, '--model', 'local/qwen3'], /distinct/],
      [[...GATE, '--max-cost', '0'], /--max-cost/],
      [[...GATE, '--max-cost', '10.5'], /--max-cost/],
      [[...GATE, '--max-requests', '0'], /--max-requests/],
      [[...GATE, '--max-requests', '2.5'], /--max-requests/],
      [[...GATE, '--max-requests', '1001'], /--max-requests/],
      [['eval', '--dataset', '--ci', '--model', 'local/qwen3'], /usage: zaafpulse eval --dataset/],
      [[...GATE, '--model', '--json'], /usage: zaafpulse eval --dataset/],
    ];
    for (const [args, re] of cases) {
      for (const ci of [[], ['--ci']]) {
        const res = await runCli([...args, ...ci], r);
        assert.equal(res.code, 2, `${args.join(' ')} ${ci.join(' ')}: ${res.err}`);
        assert.match(res.err, re, args.join(' '));
        assert.equal(res.out.trim(), '', args.join(' '));
      }
    }
    assert.equal(calls(up), 0, 'nothing was replayed');
    assert.equal(records(r.data).length, 0, 'nothing was recorded');
  } finally {
    await up.close();
  }
});

test('eval --dataset refuses a judge evaluator when the settings select an external judge', async () => {
  const up = await fakeUpstream(REFERENCE);
  const ollama = await fakeOllama();
  try {
    const r = rig(up, { evals: { provider: 'openrouter', model: 'x/y', externalConfirmed: 'openrouter' } });
    const res = await runCli([...GATE, '--require', 'task_completion>=0.7', '--ci'], {
      ...r,
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url },
    });
    assert.equal(res.code, 2, res.err);
    assert.match(res.err, /judge unavailable: .*external judges need the running dashboard/);
    assert.equal(calls(up), 0);
    assert.equal(ollama.requests.filter((q) => q.path === '/api/chat').length, 0);
  } finally {
    await up.close();
    await ollama.close();
  }
});

test('eval --dataset judges with the local model when a judge evaluator is required', async () => {
  const up = await fakeUpstream('I fixed the redirect and ran the tests.');
  const ollama = await fakeOllama();
  try {
    const r = rig(up);
    const res = await runCli([...GATE, '--require', 'task_completion>=0.7', '--ci'], {
      ...r,
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url },
    });
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /task_completion\s+local\/qwen3\s+100\.0% \(3\/3\)\s+>= 0\.70\s+pass/);
    assert.equal(ollama.requests.filter((q) => q.path === '/api/chat').length, 3);
    // The judge calls count against the data folder's daily judge budget, as the dashboard's do.
    const state = JSON.parse(fs.readFileSync(path.join(r.data, '.data', 'evals-state.json'), 'utf8'));
    assert.equal(state.count, 3);
  } finally {
    await up.close();
    await ollama.close();
  }
});

test('eval --dataset --json prints one machine-readable report', async () => {
  const up = await fakeUpstream(`Done: ${REFERENCE}.`);
  try {
    const r = rig(up);
    const res = await runCli([...GATE, '--require', 'reference_match>=0.8', '--json', '--ci'], r);
    assert.equal(res.code, 0, res.err);
    const report = JSON.parse(res.out);
    assert.deepEqual(Object.keys(report), [
      'ok',
      'dataset',
      'models',
      'experiment',
      'stopped',
      'usage',
      'evaluators',
      'requirements',
    ]);
    assert.equal(report.ok, true);
    assert.equal(report.dataset, 'auth-regressions');
    assert.deepEqual(report.models, ['local/qwen3']);
    assert.equal(report.experiment, records(r.data)[0].id);
    assert.equal(report.stopped, null);
    assert.deepEqual(Object.keys(report.usage), ['requests', 'cost']);
    assert.equal(report.usage.requests, 3);
    assert.deepEqual(report.evaluators['local/qwen3'].reference_match, { pass: 3, total: 3, rate: 1 });
    assert.deepEqual(Object.keys(report.requirements[0]), [
      'evaluator',
      'model',
      'op',
      'threshold',
      'rate',
      'pass',
      'total',
      'ok',
    ]);
    assert.equal(report.requirements[0].ok, true);
  } finally {
    await up.close();
  }
});

test('eval --dataset --data DIR wins over ZAAFPULSE_DATA: the dataset is read and the record written there', async () => {
  const up = await fakeUpstream(REFERENCE);
  try {
    const a = rig(up);
    const b = tmp('ds-cli-empty-');
    const res = await runCli([...GATE, '--require', 'reference_match>=0.8', '--ci', '--data', a.data], {
      home: a.home,
      data: b,
    });
    assert.equal(res.code, 0, res.err);
    assert.equal(records(a.data).length, 1);
    assert.equal(fs.existsSync(path.join(b, '.data', 'experiments.jsonl')), false);
    assert.equal(fs.existsSync(path.join(b, '.data', 'datasets')), false);
  } finally {
    await up.close();
  }
});

test('eval --dataset --ci exits 1 when the run stops at the request cap', async () => {
  const up = await fakeUpstream(REFERENCE);
  try {
    const r = rig(up);
    const res = await runCli([...GATE, '--require', 'reference_match>=0.5', '--max-requests', '2', '--ci'], r);
    assert.equal(res.code, 1, res.err);
    assert.match(res.err, /stopped early at the request cap/);
    assert.equal(calls(up), 2);
    const [rec] = records(r.data);
    assert.equal(rec.status, 'stopped');
    assert.equal(rec.stopped, 'request cap');
    assert.deepEqual(rec.caps, { maxCostUSD: 0.5, maxRequests: 2 });
    const json = await runCli([...GATE, '--max-requests', '2', '--json'], r);
    assert.equal(json.code, 0, 'without --ci an early stop is reported, not failed');
    assert.equal(JSON.parse(json.out).stopped, 'request cap');
    assert.equal(JSON.parse(json.out).ok, false);
  } finally {
    await up.close();
  }
});

// A CI gate must not pass because a flag at the end lost its value (`--ci --require` would check nothing).
test('eval --dataset exits 2 when a value flag is the last argument or is followed by a flag', async () => {
  const up = await fakeUpstream(REFERENCE);
  try {
    const r = rig(up);
    const cases = [
      [...GATE, '--ci', '--require'],
      [...GATE, '--ci', '--max-requests'],
      [...GATE, '--ci', '--max-cost'],
      [...GATE, '--ci', '--model'],
      [...GATE, '--ci', '--data'],
      [...GATE, '--data', '--ci'],
      [...GATE, '--ci', '--dataset'],
    ];
    for (const args of cases) {
      const res = await runCli(args, r);
      assert.equal(res.code, 2, `${args.join(' ')}: ${res.err}`);
      assert.ok(res.err.includes(DATASET_USAGE), args.join(' '));
      assert.equal(res.out.trim(), '', args.join(' '));
    }
    assert.equal(calls(up), 0, 'nothing was replayed');
    assert.equal(records(r.data).length, 0, 'nothing was recorded');
  } finally {
    await up.close();
  }
});

test('eval --dataset is in the help and the usage text', async () => {
  const up = await fakeUpstream(REFERENCE);
  try {
    const r = rig(up);
    const help = await runCli(['help'], r);
    assert.match(help.out, /zaafpulse eval --dataset <slug> --model <provider\/model>/);
    const res = await runCli(['eval', '--dataset', 'auth-regressions'], r);
    assert.equal(res.code, 2);
    assert.ok(res.err.includes(DATASET_USAGE), res.err);
  } finally {
    await up.close();
  }
});

test(
  'eval --dataset: SIGINT or SIGTERM stops the run and exits 130',
  { skip: process.platform === 'win32' },
  async () => {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      let release;
      const hold = new Promise((x) => (release = x));
      const up = await fakeUpstream(REFERENCE, { hold });
      try {
        const r = rig(up);
        const child = spawn(process.execPath, [BIN, ...GATE, '--ci'], {
          env: { ...process.env, HOME: r.home, USERPROFILE: r.home, ZAAFPULSE_DATA: r.data, ...NO_JUDGE_PORTS },
          stdio: 'ignore',
        });
        const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        for (let i = 0; i < 200 && calls(up) === 0; i++) await new Promise((x) => setTimeout(x, 25));
        assert.equal(calls(up), 1, `${sig}: the first replay call started`);
        child.kill(sig);
        assert.deepEqual(await done, { code: 130, signal: null }, sig);
        assert.equal(calls(up), 1, `${sig}: no further call`);
        assert.equal(records(r.data).length, 0, `${sig}: no record of an interrupted run`);
      } finally {
        release();
        await up.close();
      }
    }
  },
);
