// Scoring a replayed output: the evaluators an experiment can run, their labels and the summary per model. Code
// evaluators run here and cost nothing; judge evaluators go to the eval engine's judge (judgeMaterial), which keeps
// its own caps and its single lane.
const R = require('../evals/registry');
const sig = require('../signals');
const { maskText } = require('./shape');

const fromRegistry = (id) => {
  const e = R.get(id);
  return { id, kind: e.kind, title: e.title, labels: [...e.labels], pass: e.pass };
};
// Pass label first, as in the registry. reference_match lives here only: every registry code evaluator is emitted
// for every turn of every session, and most turns have no reference.
const EXPERIMENT_EVALUATORS = [
  { id: 'reference_match', kind: 'code', title: 'Reference match', labels: ['match', 'no_match'], pass: 'match' },
  fromRegistry('secret_leak'),
  fromRegistry('risky_command'),
  fromRegistry('faithfulness'),
  fromRegistry('task_completion'),
  fromRegistry('tool_selection'),
  fromRegistry('relevance'),
];
const BY_ID = new Map(EXPERIMENT_EVALUATORS.map((e) => [e.id, e]));
const getExperimentEvaluator = (id) => BY_ID.get(id) || null;

const normalize = (t) =>
  String(t ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
function referenceMatch(output, reference) {
  const ref = normalize(reference);
  if (!ref) return null;
  const out = normalize(output);
  return out === ref || out.includes(ref) ? 'match' : 'no_match';
}
const referenceOf = (example) => (example && example.reference && example.reference.text) || '';
const hasReference = (example) => !!normalize(referenceOf(example));

// The command a proposed tool call would run, when its JSON arguments hold one.
function proposedCommand(proposal) {
  if (!proposal || typeof proposal.arguments !== 'string') return null;
  let args;
  try {
    args = JSON.parse(proposal.arguments);
  } catch {
    return null;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  return null;
}

// secret_leak reads the raw model text (before masking), or a key the model echoed would be hidden from it.
function codeLabel(id, { rawText, proposal } = {}) {
  if (id === 'secret_leak') {
    const args = proposal && typeof proposal.arguments === 'string' ? proposal.arguments : '';
    return sig.scanSecrets(String(rawText ?? '') + '\n' + args).length ? 'leaked' : 'clean';
  }
  if (id === 'risky_command') {
    const cmd = proposedCommand(proposal);
    return cmd !== null && sig.scanRisky(cmd).length ? 'risky' : 'safe';
  }
  return null;
}

// What a judge reads for one replayed output, in the shape trace.material gives for a turn. The recorded tool results
// stand for the turn's tool outcomes; the proposal was never run, so it has no output.
function judgeMaterialOf(example, result) {
  const input = (example && example.input) || {};
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const output = result && result.output;
  const tools = messages
    .filter((m) => m && m.role === 'tool')
    .map((m) => ({ name: m.name || 'tool', target: null, status: 'ok', output: m.text || '' }));
  if (output && output.proposal) {
    tools.push({ name: output.proposal.name, target: null, status: 'proposed', output: '' });
  }
  return {
    prompt: messages
      .filter((m) => m && m.role === 'user')
      .map((m) => m.text || '')
      .join('\n\n'),
    answer: (output && output.text) || '',
    tools,
    available: (Array.isArray(input.tools) ? input.tools : []).map((t) => t && t.name).filter(Boolean),
  };
}

const verdict = (e, label) => {
  if (!e.labels.includes(label)) return null;
  const score = e.id === 'reference_match' ? (label === 'match' ? 1 : 0) : R.scoreOf(R.get(e.id), label);
  return { label, score, pass: label === e.pass };
};

// One result scored by each evaluator. An errored replay has nothing to score: every evaluator is null and no judge
// is asked. reference_match is left out entirely for an example without a reference (it does not apply there).
async function scoreResult({ example, result, evaluators, judge }) {
  const out = {};
  const output = (result && result.output) || null;
  const errored = !result || !!result.error;
  let material = null;
  for (const id of evaluators || []) {
    const e = getExperimentEvaluator(id);
    if (!e) continue;
    if (id === 'reference_match' && !hasReference(example)) continue;
    if (errored) {
      out[id] = null;
      continue;
    }
    if (id === 'reference_match') {
      // The whole answer, masked like the reference was: the stored output is capped and could lose the middle.
      const text = typeof result.rawText === 'string' ? maskText(result.rawText) : (output && output.text) || '';
      out[id] = verdict(e, referenceMatch(text, referenceOf(example)));
    } else if (e.kind === 'code') {
      out[id] = verdict(e, codeLabel(id, { rawText: result.rawText, proposal: output && output.proposal }));
    } else {
      material = material || judgeMaterialOf(example, result);
      let reply = null;
      try {
        reply = typeof judge === 'function' ? await judge(id, material) : null;
      } catch {
        reply = null;
      }
      out[id] = reply && reply.ok ? verdict(e, reply.label) : null;
    }
  }
  return out;
}

// Pass rates per model and evaluator (R9). Every attempted row counts in the total, so an errored replay or a missing
// verdict lowers the rate; reference_match counts only the examples that have a reference.
function summarize(perExample, { models = [], evaluators = [], examples = [] } = {}) {
  const withRef = new Set((examples || []).filter(hasReference).map((x) => x.id));
  const ids = (evaluators || []).filter((id) => getExperimentEvaluator(id));
  const out = {};
  for (const model of models || []) {
    const rows = (perExample || []).filter((r) => r && r.model === model);
    const answered = rows.filter((r) => !r.error && Number.isFinite(r.ms));
    const evs = {};
    for (const id of ids) {
      const e = getExperimentEvaluator(id);
      const counted = id === 'reference_match' ? rows.filter((r) => withRef.has(r.exampleId)) : rows;
      const pass = counted.filter((r) => {
        const v = r.labels && r.labels[id];
        return !!v && v.label === e.pass;
      }).length;
      evs[id] = { pass, total: counted.length, rate: counted.length ? pass / counted.length : null };
    }
    out[model] = {
      requests: rows.length,
      cost: rows.reduce((n, r) => n + (Number.isFinite(r.cost) ? r.cost : 0), 0),
      ms: answered.length ? answered.reduce((n, r) => n + r.ms, 0) / answered.length : null,
      errors: rows.filter((r) => r.error).length,
      proposals: rows.filter((r) => r.output && r.output.proposal).length,
      evaluators: evs,
    };
  }
  return { models: out };
}

module.exports = {
  EXPERIMENT_EVALUATORS,
  getExperimentEvaluator,
  normalize,
  referenceMatch,
  codeLabel,
  judgeMaterialOf,
  scoreResult,
  summarize,
};
