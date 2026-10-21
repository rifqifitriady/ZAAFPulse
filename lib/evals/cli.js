// `zaafpulse eval --judge --session <id>`: judge one session from the terminal, with no dashboard running. It wires
// the same parts as server.js (index, trace registry, models, stores, engine) but never a gateway, so only a local
// model can answer. Exit 0: judged. Exit 2: no judge, an unknown session or an external provider. Exit 1: nothing
// came of it for another reason.
const fs = require('fs');
const path = require('path');
const { Indexer } = require('../indexer');
const { createTrace, contentDefaultOff } = require('../trace');
const { createEvalEngine } = require('./engine');
const { createEvalStore, createFeedbackStore } = require('./store');
const { createModels } = require('./models');
const { createEvalApi } = require('./api');

const LOCAL = ['auto', 'ollama', 'lmstudio'];
const SOURCES = ['claude', 'codex'];
const USAGE = 'usage: zaafpulse eval --judge --session <id> [--source claude|codex] [--data DIR] [--json]';
const NO_JUDGE =
  'No local judge model is available. Install Ollama and run `ollama pull qwen3:8b`, or start LM Studio with a model loaded.';

function readConfig(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

// Left-aligned columns, two spaces apart.
function table(head, rows) {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  return all.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd()).join('\n');
}

// Returns the exit code. `out` and `err` write a line to stdout and stderr.
async function runEval({ session, source, json = false, dir, env = process.env, out, err }) {
  const config = readConfig(dir);
  const dataDir = path.join(dir, '.data');
  const indexer = new Indexer([require('../claude'), require('../codex')], path.join(dir, '.cache', 'index.json'));
  await indexer.refresh();
  // Text is read from the agent log folders only, as in the server.
  const trace = createTrace({
    indexer,
    roots: [...require('../claude').ROOTS, ...require('../codex').ROOTS],
    light: [],
    contentOff: contentDefaultOff(env, false),
  });
  const feedback = createFeedbackStore({ file: path.join(dataDir, 'feedback.jsonl') });
  // The settings object the dashboard uses, so a missing value means the same default here. Nothing saves from here.
  const api = createEvalApi({
    trace,
    engine: { kick() {} },
    feedback,
    gateway: null,
    settings: {
      get: () => config.evals,
      save: () => {
        throw new Error('settings are read-only here');
      },
    },
  });
  const settings = api.settings();
  if (!LOCAL.includes(settings.provider)) {
    err(
      'This data folder selects an external provider, and external judges need the running dashboard ' +
        '(its gateway and its preview step).',
    );
    return 2;
  }
  if (!settings.judge) {
    err('Judging is switched off in the settings of this data folder.');
    return 2;
  }
  const models = createModels({ settings: api.settings });
  const resolved = await models.resolve();
  if (!resolved.ok) {
    err(NO_JUDGE);
    return 2;
  }
  // Which source holds the session: the one named, else the first that knows the id.
  const found = (SOURCES.includes(source) ? [source] : source ? [] : SOURCES).find((s) => {
    try {
      trace.keyFor(s, session);
      return true;
    } catch {
      return false;
    }
  });
  if (!found) {
    err(`unknown session "${session}" in the Claude Code and Codex logs${source ? ` (source ${source})` : ''}`);
    return 2;
  }
  const engine = createEvalEngine({
    trace,
    indexer,
    models,
    store: createEvalStore({ file: path.join(dataDir, 'evals.jsonl') }),
    feedback,
    settings: api.settings,
    stateFile: path.join(dataDir, 'evals-state.json'),
    log: (m) => err(m),
  });
  if (!json) err(`Judging with ${resolved.kind} ${resolved.model} ...`);
  const queued = await engine.enqueueSession(found, session);
  await engine.drain();
  const status = await engine.status();
  const showText = !contentDefaultOff(env, false);
  const rows = engine
    .results({ source: found, session })
    .filter((r) => r.kind === 'judge')
    .map((r) => ({
      turn: r.target.turn ?? null,
      evaluator: r.evaluator,
      label: r.label,
      model: (r.judge && r.judge.model) || null,
      explanation: showText && typeof r.explanation === 'string' ? r.explanation : null,
    }));
  if (json) out(JSON.stringify(rows, null, 2));
  else if (rows.length) {
    // Turns count from 1 here, like the explorer; --json counts from 0, like the API.
    const turn = (r) => (r.turn === null ? 'session' : r.turn + 1);
    const body = rows.map((r) => [turn(r), r.evaluator, r.label, r.model || '']);
    out(table(['TURN', 'EVALUATOR', 'LABEL', 'MODEL'], body));
  }
  if (queued.sessionDeferred) err('The session verdict waits until the session has been quiet for 30 minutes.');
  if (status.queue > 0 || status.paused) {
    err(`Judging stopped early${status.paused ? ` (${status.paused})` : ''}; ${status.queue} job(s) were left.`);
    return 2;
  }
  if (!rows.length) {
    err('Nothing was judged: the session has no finished turn yet, or the model gave no valid answer.');
    return 1;
  }
  return 0;
}

module.exports = { runEval, USAGE };
