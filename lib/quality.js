// Rolls per-file quality/safety signals up into one time range.
const path = require('path');
const { CATEGORY } = require('./signals');

const DAY = 86400000;
// Failures the logs can pin on the model: acting on a target that does not exist (hallucination)
// and misusing a tool (process). A failed command or test is not counted: tests are run in order to
// see them fail (a TDD red run, a check before a fix), and a build error usually lives in the code
// being worked on. Unclassified tool errors, network problems and your rejections are not counted
// either. See docs/quality-metrics.md.
const MODEL_FAULT = ['hallucination', 'process'];
const COUNTERS = [
  'calls',
  'results',
  'failures',
  'external',
  'prompts',
  'injExternal',
  'injLocal',
  'secrets',
  'risky',
  'corrections',
  'interrupts',
  'apiErrors',
  'refusals',
  'compactions',
  'loops',
  'relTurns',
  'relSum',
  'faithClaims',
  'faithGrounded',
];

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dayStart = (key) => new Date(`${key}T00:00:00`).getTime();

function summarizeQuality(results, sessions, { start, end, prevStart }) {
  const blank = () => ({ ...Object.fromEntries(COUNTERS.map((c) => [c, 0])), cats: {}, kinds: {} });
  const cur = blank();
  const prev = blank();
  const daily = {};
  const events = [];
  const toolStats = {};

  for (const r of results) {
    const s = r.signals;
    if (!s) continue;
    for (const [k, d] of Object.entries(s.days)) {
      const t = dayStart(k);
      const into = t >= start && t <= end ? cur : t >= prevStart && t < start ? prev : null;
      if (!into) continue;
      for (const c of COUNTERS) into[c] += d[c] || 0;
      for (const [c, n] of Object.entries(d.cats || {})) into.cats[c] = (into.cats[c] || 0) + n;
      for (const [c, n] of Object.entries(d.kinds || {})) into.kinds[c] = (into.kinds[c] || 0) + n;
      if (into === cur) {
        const row = (daily[k] ||= {
          calls: 0,
          results: 0,
          failures: 0,
          modelFailures: 0,
          cats: {},
          relTurns: 0,
          relSum: 0,
          faithClaims: 0,
          faithGrounded: 0,
        });
        row.calls += d.calls || 0;
        row.results += d.results || 0;
        row.failures += d.failures || 0;
        for (const c of ['relTurns', 'relSum', 'faithClaims', 'faithGrounded']) row[c] += d[c] || 0;
        for (const [c, n] of Object.entries(d.cats || {})) {
          row.cats[c] = (row.cats[c] || 0) + n;
          if (MODEL_FAULT.includes(c)) row.modelFailures += n;
        }
      }
    }
    for (const e of s.events) {
      if (e.ts < start || e.ts > end) continue;
      const sess = sessions.get(`${e.tool}:${e.sid}`);
      const proj = sess && sess.project ? path.basename(sess.project) : '';
      events.push({ ...e, project: proj });
      if (e.kind === 'error') {
        const t = (toolStats[e.source] ||= { tool: e.source, calls: 0, failures: 0, modelFailures: 0 });
        t.failures++;
        if (MODEL_FAULT.includes(e.category)) t.modelFailures++;
      }
    }
  }

  // Calls per tool come from session tallies (sessions active in range).
  for (const s of sessions.values()) {
    if (!s.last || s.last < start || s.first > end) continue;
    for (const [tool, n] of Object.entries(s.tools || {})) {
      const t = (toolStats[tool] ||= { tool, calls: 0, failures: 0, modelFailures: 0 });
      t.calls += n;
    }
  }

  const modelFaults = (x) => MODEL_FAULT.reduce((a, c) => a + (x.cats[c] || 0), 0);
  const accuracy = (x) => (x.results ? 1 - modelFaults(x) / x.results : null);
  const days = [];
  for (let t = start; t <= end; t += DAY) {
    const k = dayKey(t);
    const d = daily[k] || {
      calls: 0,
      results: 0,
      failures: 0,
      modelFailures: 0,
      cats: {},
      relTurns: 0,
      relSum: 0,
      faithClaims: 0,
      faithGrounded: 0,
    };
    days.push({
      date: k,
      ...d,
      accuracy: d.results ? 1 - d.modelFailures / d.results : null,
      relevance: d.relTurns ? d.relSum / d.relTurns : null,
      faithfulness: d.faithClaims ? d.faithGrounded / d.faithClaims : null,
    });
  }
  events.sort((a, b) => b.ts - a.ts);
  const byKind = (kind, n = 60) => events.filter((e) => e.kind === kind).slice(0, n);
  const hallucinations = cur.cats.hallucination || 0;

  const relevance = (x) => (x.relTurns ? x.relSum / x.relTurns : null);
  const faithfulness = (x) => (x.faithClaims ? x.faithGrounded / x.faithClaims : null);
  return {
    accuracy: accuracy(cur),
    prevAccuracy: accuracy(prev),
    prevResults: prev.results, // how many results prevAccuracy rests on (`results` is the current range's)
    relevance: {
      score: relevance(cur),
      prev: relevance(prev),
      turns: cur.relTurns,
      low: events.filter((e) => e.kind === 'relevance').length,
    },
    faithfulness: {
      score: faithfulness(cur),
      prev: faithfulness(prev),
      claims: cur.faithClaims,
      grounded: cur.faithGrounded,
      unsupported: cur.faithClaims - cur.faithGrounded,
    },
    calls: cur.calls,
    results: cur.results,
    failures: cur.failures,
    modelFailures: modelFaults(cur),
    categories: Object.entries(CATEGORY).map(([id, label]) => ({
      id,
      label,
      count: cur.cats[id] || 0,
      modelFault: MODEL_FAULT.includes(id),
    })),
    kinds: Object.entries(cur.kinds)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    hallucinations,
    prevHallucinations: prev.cats.hallucination || 0,
    hallucinationRate: cur.calls ? (hallucinations / cur.calls) * 1000 : 0,
    injection: {
      external: cur.injExternal,
      local: cur.injLocal,
      prevExternal: prev.injExternal,
      externalCalls: cur.external,
    },
    corrections: {
      prompts: cur.prompts,
      corrections: cur.corrections,
      interrupts: cur.interrupts,
      rejections: cur.cats.rejection || 0,
      rate: cur.prompts ? (cur.corrections + cur.interrupts) / cur.prompts : 0,
      prevRate: prev.prompts ? (prev.corrections + prev.interrupts) / prev.prompts : 0,
    },
    safety: { secrets: cur.secrets, risky: cur.risky },
    reliability: {
      apiErrors: cur.apiErrors,
      refusals: cur.refusals,
      compactions: cur.compactions,
      loops: cur.loops,
      environment: cur.cats.environment || 0,
    },
    daily: days,
    tools: Object.values(toolStats)
      .filter((t) => t.calls >= 5)
      .map((t) => ({ ...t, failureRate: t.modelFailures / t.calls }))
      .sort((a, b) => b.modelFailures - a.modelFailures)
      .slice(0, 10),
    events: {
      error: byKind('error', 80),
      hallucination: events.filter((e) => e.category === 'hallucination').slice(0, 60),
      injection: byKind('injection'),
      secret: byKind('secret'),
      risky: byKind('risky'),
      correction: byKind('correction'),
      interrupt: byKind('interrupt', 20),
      apiError: byKind('apiError', 30),
      refusal: byKind('refusal', 20),
      loop: byKind('loop', 30),
      compaction: byKind('compaction', 20),
      relevance: byKind('relevance', 40),
      unsupported: byKind('unsupported', 40),
    },
    feed: events.filter((e) => e.kind !== 'error' || e.category === 'hallucination').slice(0, 40),
  };
}

module.exports = { summarizeQuality, MODEL_FAULT };
