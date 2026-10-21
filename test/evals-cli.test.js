const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fakeServer, NO_JUDGE_PORTS, fakeClaude } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'zaafpulse.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'trace', 'claude', 'proj', 's1.jsonl');

// A temp HOME with one Claude Code session that went quiet an hour ago (so every turn is finished), and an empty
// data folder. Nothing here is this machine's own.
function rig(config, { fresh = false, lines } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-cli-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-cli-data-'));
  const proj = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 's1.jsonl');
  if (lines) fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8').split('\n').slice(0, lines).join('\n') + '\n');
  else fs.copyFileSync(FIXTURE, file);
  if (!fresh) {
    const hourAgo = new Date(Date.now() - 3600e3);
    fs.utimesSync(file, hourAgo, hourAgo);
  }
  if (config) fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  return { home, data };
}

// A stand-in Ollama: one model, and for every call the first (passing) label of the schema it was asked for.
function fakeOllama() {
  return fakeServer({
    'GET /api/tags': { body: { models: [{ name: 'qwen3:8b' }] } },
    'POST /api/chat': (req) => {
      const label = req.body.format.properties.label.enum[0];
      return { body: { message: { content: JSON.stringify({ label, explanation: 'looks fine' }) } } };
    },
  });
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

test('eval --judge judges every finished turn with the local model and prints the labels', async () => {
  const ollama = await fakeOllama();
  try {
    const r = rig();
    const res = await runCli(['eval', '--judge', '--session', 's1'], {
      ...r,
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url },
    });
    assert.equal(res.code, 0, res.err);
    for (const id of ['faithfulness', 'task_completion', 'tool_selection', 'relevance', 'user_frustration'])
      assert.match(res.out, new RegExp(id), id);
    assert.match(res.out, /\bfaithful\b/);
    assert.match(res.out, /complete/);
    assert.match(res.out, /qwen3:8b/);
    // Two turns times four turn evaluators, and one session verdict.
    assert.equal(ollama.requests.filter((q) => q.path === '/api/chat').length, 9);
    const stored = fs.readFileSync(path.join(r.data, '.data', 'evals.jsonl'), 'utf8').trim().split('\n');
    assert.equal(stored.length, 9);
    // A second run finds everything judged and asks the model for nothing more.
    const again = await runCli(['eval', '--judge', '--session', 's1'], {
      ...r,
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url },
    });
    assert.equal(again.code, 0, again.err);
    assert.equal(ollama.requests.filter((q) => q.path === '/api/chat').length, 9);
    assert.match(again.out, /faithfulness/);
  } finally {
    await ollama.close();
  }
});

test('eval --json prints an array of turn, evaluator and label, and --data picks the data folder', async () => {
  const ollama = await fakeOllama();
  try {
    const r = rig();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-cli-elsewhere-'));
    const args = ['eval', '--judge', '--session', 's1', '--source', 'claude', '--json', '--data', elsewhere];
    const res = await runCli(args, { ...r, env: { ZAAFPULSE_OLLAMA_URL: ollama.url } });
    assert.equal(res.code, 0, res.err);
    const rows = JSON.parse(res.out);
    assert.ok(Array.isArray(rows) && rows.length === 9, JSON.stringify(rows));
    assert.deepEqual(Object.keys(rows[0]).sort(), ['evaluator', 'explanation', 'label', 'model', 'turn']);
    assert.ok(rows.some((x) => x.evaluator === 'user_frustration' && x.turn === null));
    assert.deepEqual([...new Set(rows.map((x) => x.turn))].sort(), [0, 1, null]);
    assert.ok(fs.existsSync(path.join(elsewhere, '.data', 'evals.jsonl')));
    assert.equal(fs.existsSync(path.join(r.data, '.data', 'evals.jsonl')), false);
  } finally {
    await ollama.close();
  }
});

test('eval hides explanations when ZAAFPULSE_CONTENT=off', async () => {
  const ollama = await fakeOllama();
  try {
    const res = await runCli(['eval', '--judge', '--session', 's1', '--json'], {
      ...rig(),
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url, ZAAFPULSE_CONTENT: 'off' },
    });
    assert.equal(res.code, 0, res.err);
    assert.ok(JSON.parse(res.out).every((x) => x.explanation === null));
  } finally {
    await ollama.close();
  }
});

test('eval exits 2 when no local judge answers, and says how to get one', async () => {
  const res = await runCli(['eval', '--judge', '--session', 's1'], rig());
  assert.equal(res.code, 2, res.err);
  assert.match(res.err, /ollama pull qwen3:8b/);
  assert.equal(res.out.trim(), '');
});

test('eval exits 2 for a session it does not know', async () => {
  const ollama = await fakeOllama();
  try {
    const res = await runCli(['eval', '--judge', '--session', 'nope'], {
      ...rig(),
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url },
    });
    assert.equal(res.code, 2);
    assert.match(res.err, /unknown session/);
    assert.equal(ollama.requests.filter((q) => q.path === '/api/chat').length, 0);
  } finally {
    await ollama.close();
  }
});

test('eval refuses an external provider from the settings and sends nothing', async () => {
  const ollama = await fakeOllama();
  try {
    const res = await runCli(['eval', '--judge', '--session', 's1'], {
      ...rig({ evals: { provider: 'openrouter', model: 'some/model', externalConfirmed: 'openrouter' } }),
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url },
    });
    assert.equal(res.code, 2);
    assert.match(res.err, /external judges need the running dashboard/);
    assert.equal(ollama.requests.filter((q) => q.path === '/api/chat').length, 0);
  } finally {
    await ollama.close();
  }
});

test('eval follows the model chosen in the settings of the data folder', async () => {
  const ollama = await fakeServer({
    'GET /api/tags': { body: { models: [{ name: 'qwen3:8b' }, { name: 'mistral:7b' }] } },
    'POST /api/chat': (req) => ({
      body: {
        message: { content: JSON.stringify({ label: req.body.format.properties.label.enum[0], explanation: 'ok' }) },
      },
    }),
  });
  try {
    const res = await runCli(['eval', '--judge', '--session', 's1', '--json'], {
      ...rig({ evals: { model: 'mistral:7b' } }),
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url },
    });
    assert.equal(res.code, 0, res.err);
    assert.ok(JSON.parse(res.out).every((x) => x.model === 'mistral:7b'));
  } finally {
    await ollama.close();
  }
});

test('eval needs --judge and --session, and is in the usage text', async () => {
  const r = rig();
  const noJudge = await runCli(['eval', '--session', 's1'], r);
  assert.equal(noJudge.code, 2);
  assert.match(noJudge.err, /usage: zaafpulse eval --judge --session/);
  const noSession = await runCli(['eval', '--judge'], r);
  assert.equal(noSession.code, 2);
  const help = await runCli(['help'], r);
  assert.match(help.out, /zaafpulse eval --judge --session <id>/);
});

test('eval stops early and exits 2 when the daily cap is reached part-way', async () => {
  const ollama = await fakeOllama();
  try {
    const res = await runCli(['eval', '--judge', '--session', 's1'], {
      ...rig({ evals: { dailyCap: 1 } }),
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url },
    });
    assert.equal(res.code, 2, res.err);
    assert.match(res.err, /stopped early \(daily cap\)/);
    assert.equal(ollama.requests.filter((q) => q.path === '/api/chat').length, 1);
  } finally {
    await ollama.close();
  }
});

test('eval exits 1 when the session has no finished turn to judge', async () => {
  const ollama = await fakeOllama();
  try {
    // One turn, and the log was just written: that turn is still running.
    const res = await runCli(['eval', '--judge', '--session', 's1'], {
      ...rig(null, { fresh: true, lines: 4 }),
      env: { ZAAFPULSE_OLLAMA_URL: ollama.url },
    });
    assert.equal(res.code, 1, res.err);
    assert.match(res.err, /Nothing was judged/);
    assert.equal(ollama.requests.filter((q) => q.path === '/api/chat').length, 0);
  } finally {
    await ollama.close();
  }
});

test('eval refuses a --session or --source value that is really the next flag', async () => {
  const r = rig();
  const a = await runCli(['eval', '--judge', '--session', '--json'], r);
  assert.equal(a.code, 2);
  assert.match(a.err, /need a value that does not start with "-"/);
  const b = await runCli(['eval', '--judge', '--session', 's1', '--source', '--json'], r);
  assert.equal(b.code, 2);
  assert.match(b.err, /usage: zaafpulse eval/);
});

test('eval with Claude Code: refused until its preview was confirmed, then judged through the CLI', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-cli-claude-'));
  const log = path.join(bin, 'runs.jsonl');
  const env = { ZAAFPULSE_CLAUDE_BIN: fakeClaude(bin), FAKE_CLAUDE_LOG: log };
  const runs = () =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l && !l.includes('"version"')) : [];
  const args = ['eval', '--judge', '--session', 's1', '--json'];

  const refused = await runCli(args, { ...rig({ evals: { provider: 'claude-code', model: 'haiku' } }), env });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /confirm the Claude Code preview in Settings → Evals first/);
  assert.equal(runs().length, 0, 'nothing was sent');
  const other = { provider: 'claude-code', model: 'haiku', externalConfirmed: 'openrouter' };
  assert.equal((await runCli(args, { ...rig({ evals: other }), env })).code, 2);
  assert.equal(runs().length, 0);

  const ok = { evals: { provider: 'claude-code', model: 'haiku', externalConfirmed: 'claude-code' } };
  const res = await runCli(args, { ...rig(ok), env });
  assert.equal(res.code, 0, res.err);
  const rows = JSON.parse(res.out);
  assert.equal(rows.length, 9);
  assert.ok(rows.every((x) => x.model === 'claude-haiku-5-5'), 'the model that answered');
  assert.equal(runs().length, 9);
  assert.ok(runs().every((l) => JSON.parse(l).argv.includes('haiku')));

  // Confirmed, but no claude here: exit 2 with the reason.
  const missing = await runCli(args, { ...rig(ok) });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /Claude Code not found/);
  fs.rmSync(bin, { recursive: true, force: true });
});
