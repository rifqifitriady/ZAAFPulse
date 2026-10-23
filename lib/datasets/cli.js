// `zaafpulse eval --dataset <slug> --model <provider/model>`: replay a dataset against gateway models from the
// terminal and check pass rates, as a CI quality gate. It wires its own gateway on the data folder (read-only: no
// config or key is written) and, when a judge evaluator is required, the judge as `zaafpulse eval --judge` does: a
// local model, or Claude Code once its preview was confirmed in the dashboard. External replay models need the
// dashboard's preview, so they are refused here. Exit 2: a configuration error. With --ci, exit 1 when a requirement
// fails or the run stopped early. Otherwise 0.
const crypto = require('crypto');
const path = require('path');
const otel = require('../otel');
const { createGateway } = require('../gateway');
const { createSecrets } = require('../secrets');
const { createModels } = require('../evals/models');
const { createClaude } = require('../evals/claude-cli');
const { createEvalEngine } = require('../evals/engine');
const { createEvalStore, createFeedbackStore } = require('../evals/store');
const { createEvalApi } = require('../evals/api');
const { judgeGate, readConfig } = require('../evals/cli');
const { createDatasetStore } = require('./store');
const { createExperimentStore } = require('./experiments');
const { createReplayRunner, REPLAY_DEFAULTS } = require('./replay');
const { EXPERIMENT_EVALUATORS, getExperimentEvaluator } = require('./score');

const DATASET_USAGE =
  'usage: zaafpulse eval --dataset <slug> --model <provider/model> [--model …] [--require <evaluator>>=<0..1>]… ' +
  '[--max-cost USD] [--max-requests N] [--json] [--ci] [--data DIR]';
const REQUIREMENT = /^([a-z_]+)(>=|>)(0(?:\.\d+)?|1(?:\.0+)?)$/;
const MAX_MODELS = 3;
const CODE_DEFAULT = ['reference_match', 'secret_leak', 'risky_command'];
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const STOPPED = { 'request cap': 'the request cap', 'cost cap': 'the cost cap', cancelled: 'a cancel' };

function parseRequirement(text) {
  const m = typeof text === 'string' ? REQUIREMENT.exec(text) : null;
  return m ? { evaluator: m[1], op: m[2], threshold: Number(m[3]) } : null;
}

// One row per requirement and model. A model with no rate (nothing counted) does not meet any requirement.
function checkRequirements(summary, requirements, models) {
  const rows = [];
  for (const req of requirements || [])
    for (const model of models || []) {
      const s = summary && summary.models && summary.models[model];
      const e = (s && s.evaluators && s.evaluators[req.evaluator]) || {};
      const rate = Number.isFinite(e.rate) ? e.rate : null;
      const ok = rate !== null && (req.op === '>=' ? rate >= req.threshold : rate > req.threshold);
      const { evaluator, op, threshold } = req;
      rows.push({ evaluator, model, op, threshold, rate, pass: e.pass || 0, total: e.total || 0, ok });
    }
  return rows;
}

// R8 ranges. A value from the command line is text; only a plain decimal number is read.
function capOf(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
}
const validCost = (n) => Number.isFinite(n) && n > 0 && n <= 10;
const validRequests = (n) => Number.isInteger(n) && n >= 1 && n <= 1000;

// Left-aligned columns, two spaces apart (as the judge command prints).
function table(head, rows) {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  return all
    .map((r) =>
      r
        .map((c, i) => String(c).padEnd(w[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
const rateText = (e) => (e && Number.isFinite(e.rate) ? `${(e.rate * 100).toFixed(1)}% (${e.pass}/${e.total})` : '-');
const thresholdText = (t) => (String(t).length > 4 ? String(t) : t.toFixed(2));

// Everything that can be refused before any wiring: the flags themselves.
function checkFlags({ dataset, models, requires, maxCostUSD, maxRequests }) {
  if (typeof dataset !== 'string' || !dataset) return `${DATASET_USAGE}\n--dataset needs a dataset slug.`;
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return `${DATASET_USAGE}\nGive at least one --model <provider/model>.`;
  if (list.length > MAX_MODELS) return `at most ${MAX_MODELS} --model values`;
  if (new Set(list).size !== list.length) return 'the --model values must be distinct';
  const requirements = [];
  for (const text of requires || []) {
    const req = parseRequirement(text);
    if (!req)
      return `bad --require "${text}": write <evaluator>>=<0..1> or <evaluator>><0..1>, e.g. reference_match>=0.8`;
    if (!getExperimentEvaluator(req.evaluator))
      return `unknown evaluator "${req.evaluator}"; one of ${EXPERIMENT_EVALUATORS.map((e) => e.id).join(', ')}`;
    requirements.push(req);
  }
  const cost = capOf(maxCostUSD, REPLAY_DEFAULTS.maxCostUSD);
  if (!validCost(cost)) return '--max-cost must be more than 0 and at most 10 (US dollars)';
  const requests = capOf(maxRequests, REPLAY_DEFAULTS.maxRequests);
  if (!validRequests(requests)) return '--max-requests must be a whole number from 1 to 1000';
  return { requirements, maxCostUSD: cost, maxRequests: requests };
}

// Returns the exit code. `out` and `err` write a line to stdout and stderr.
async function runDatasetEval({
  dataset,
  models = [],
  requires = [],
  json = false,
  ci = false,
  maxCostUSD,
  maxRequests,
  dir,
  env = process.env,
  out,
  err,
}) {
  const flags = checkFlags({ dataset, models, requires, maxCostUSD, maxRequests });
  if (typeof flags === 'string') {
    err(flags);
    return 2;
  }
  const { requirements } = flags;
  const dataDir = path.join(dir, '.data');
  const datasets = createDatasetStore({ dir: path.join(dataDir, 'datasets'), log: () => {} });
  const meta = datasets.get(dataset);
  if (!meta) {
    err(`unknown dataset "${dataset}" in ${path.join(dataDir, 'datasets')}`);
    return 2;
  }
  const examples = datasets.examples(meta.slug);
  if (!examples.length) {
    err(`the dataset "${meta.slug}" has no examples`);
    return 2;
  }
  // The required evaluators in the order given; with none, the code evaluators (free, no judge).
  const evaluators = requirements.length ? [...new Set(requirements.map((r) => r.evaluator))] : CODE_DEFAULT;

  const config = readConfig(dir);
  const version = require('../../package.json').version;
  // Replay goes through a gateway like the dashboard's, so usage, cost and OTLP export apply; it never writes config.
  otel.init({ getConfig: () => config, secrets: createSecrets(), version });
  const readOnly = () => {
    throw new Error('read-only here');
  };
  const gateway = createGateway({
    dataDir,
    getConfig: () => config,
    writeGatewayConfig: readOnly,
    secrets: createSecrets(),
    resolveSecret: readOnly,
    getPricing: () => config.pricing,
    // Replay declares tools and never runs one.
    getIntegrations: () => ({
      listTools: async () => [],
      callTool: async () => {
        throw new Error('no tools in replay');
      },
    }),
    version,
  });
  const replay = gateway.replay;
  try {
    for (const m of models) {
      const tier = replay.tierOf(m);
      if (!tier) {
        err(`unknown model ${m}: name a provider/model of the gateway (no alias or route)`);
        return 2;
      }
      if (tier === 'external') {
        err(`${m}: external models need the dashboard and its preview (Datasets → Replay)`);
        return 2;
      }
    }
    const judge = await judgeFor({ evaluators, config, dataDir, env, err });
    if (typeof judge === 'number') return judge;
    return await replayRun(
      { meta, examples, models, evaluators, requirements, flags, judge, replay, dataDir },
      {
        json,
        ci,
        out,
        err,
      },
    );
  } finally {
    await otel.reset();
  }
}

// The judge for judge evaluators: the eval engine's, wired as `zaafpulse eval --judge` wires it (no gateway, so a
// local model or a confirmed Claude Code). Its calls share evals-state.json, so they count against the data
// folder's daily judge budget. Returns an exit code when a judge evaluator is required and no judge may run.
async function judgeFor({ evaluators, config, dataDir, env, err }) {
  const none = { call: async () => ({ ok: false, reason: 'no judge' }), stop() {} };
  if (!evaluators.some((id) => getExperimentEvaluator(id).kind === 'judge')) return none;
  const feedback = createFeedbackStore({ file: path.join(dataDir, 'feedback.jsonl') });
  // The settings object the dashboard uses, so a missing value means the same default here. Nothing saves from here.
  const api = createEvalApi({
    trace: null,
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
  const claude = createClaude({ env });
  const gate = judgeGate(settings, claude);
  if (gate) {
    err(`judge unavailable: ${gate}`);
    return 2;
  }
  const models = createModels({
    settings: api.settings,
    claude,
    ...(env.ZAAFPULSE_OLLAMA_URL ? { ollamaUrl: env.ZAAFPULSE_OLLAMA_URL } : {}),
    ...(env.ZAAFPULSE_LMSTUDIO_URL ? { lmstudioUrl: env.ZAAFPULSE_LMSTUDIO_URL } : {}),
  });
  const resolved = await models.resolve();
  if (!resolved.ok) {
    err(`judge unavailable: ${resolved.reason || 'no local judge model (Ollama or LM Studio) answers'}`);
    return 2;
  }
  // Only judgeMaterial is used: no trace is read and nothing is written to the eval store.
  const engine = createEvalEngine({
    trace: null,
    indexer: null,
    models,
    store: createEvalStore({ file: path.join(dataDir, 'evals.jsonl') }),
    feedback,
    settings: api.settings,
    stateFile: path.join(dataDir, 'evals-state.json'),
    log: (m) => err(m),
  });
  return { call: (id, material, opts) => engine.judgeMaterial(id, material, opts), stop: () => engine.stop() };
}

async function replayRun(ctx, { json, ci, out, err }) {
  const { meta, examples, models, evaluators, requirements, flags, judge, replay, dataDir } = ctx;
  const ctl = new AbortController();
  // Ctrl-C, a kill or a closed terminal: the run is cancelled, a running judge call (a Claude Code process leads its
  // own group and would outlive this one) is killed, and nothing is recorded for the unfinished run.
  const onSignal = () => {
    try {
      ctl.abort();
      judge.stop();
    } finally {
      process.exit(130);
    }
  };
  for (const sig of SIGNALS) process.on(sig, onSignal);
  let record;
  try {
    if (!json) err(`Replaying ${examples.length} example(s) of ${meta.slug} against ${models.join(', ')} ...`);
    const runner = createReplayRunner({ replay, judge: judge.call });
    record = await runner.run({
      id: 'exp_' + crypto.randomBytes(8).toString('hex'),
      dataset: meta,
      examples,
      models,
      evaluators,
      maxCostUSD: flags.maxCostUSD,
      maxRequests: flags.maxRequests,
      signal: ctl.signal,
    });
  } catch (e) {
    err(`The replay failed: ${(e && e.message) || e}`);
    return 1;
  } finally {
    for (const sig of SIGNALS) process.removeListener(sig, onSignal);
  }
  // The same store as the dashboard's, so its 0600 file, record bound and line limit apply.
  try {
    createExperimentStore({ file: path.join(dataDir, 'experiments.jsonl') }).append(record);
  } catch {
    err('Could not store the experiment record in experiments.jsonl.');
  }

  const rows = checkRequirements(record.summary, requirements, record.models);
  const ok = rows.every((r) => r.ok) && !record.stopped;
  const perModel = record.summary.models;
  if (json) {
    const evals = {};
    for (const m of record.models) evals[m] = { ...perModel[m].evaluators };
    out(
      JSON.stringify(
        {
          ok,
          dataset: meta.slug,
          models: record.models,
          experiment: record.id,
          stopped: record.stopped,
          usage: { requests: record.usage.requests, cost: record.usage.cost },
          evaluators: evals,
          requirements: rows,
        },
        null,
        2,
      ),
    );
  } else {
    const body = [];
    for (const id of evaluators)
      for (const m of record.models) {
        const e = perModel[m].evaluators[id];
        const reqs = rows.filter((r) => r.evaluator === id && r.model === m);
        if (!reqs.length) body.push([id, m, rateText(e), '-', '-']);
        for (const r of reqs)
          body.push([id, m, rateText(e), `${r.op} ${thresholdText(r.threshold)}`, r.ok ? 'pass' : 'FAIL']);
      }
    out(table(['EVALUATOR', 'MODEL', 'PASS RATE', 'REQUIRED', 'RESULT'], body));
  }
  if (record.stopped) {
    const done = record.usage.requests;
    const total = examples.length * models.length;
    err(
      `The run stopped early at ${STOPPED[record.stopped] || record.stopped}; ${done} of ${total} replays were done.`,
    );
  }
  return ci && !ok ? 1 : 0;
}

module.exports = { DATASET_USAGE, parseRequirement, checkRequirements, runDatasetEval };
