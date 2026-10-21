// A read-only view of the eval results for the MCP tool: the pass rate of each evaluator and the latest failures,
// as ids and labels. No explanation, no text, no session id; a failure names its session by the process's trace
// key. Nothing here can judge: the summary comes from an engine that has no model and is never started.
const R = require('./registry');
const { codeResults } = require('./code');
const { createEvalEngine } = require('./engine');

const FAILURES = 20;
const MAX_SESSIONS = 100; // sessions whose code results are looked at, newest first
const isSub = (file) => /[\\/]subagents[\\/]/.test(file || '');
const NO_MODEL = { resolve: async () => ({ ok: false, waiting: true, reason: 'read-only' }) };

// The sessions of the log files the indexer holds, with their turn times.
function sessionsOf(entries) {
  const out = new Map();
  for (const en of entries || []) {
    if ((en.source !== 'claude' && en.source !== 'codex') || isSub(en.file)) continue;
    for (const [sid, sess] of Object.entries((en.result && en.result.sessions) || {})) {
      const turns = (sess && sess.turns) || [];
      const k = `${en.source}|${sid}`;
      if (!out.has(k) || turns.length > out.get(k).turns.length) out.set(k, { source: en.source, sid, turns });
    }
  }
  return [...out.values()];
}
const lastTurn = (s) => s.turns.reduce((m, t) => (Number.isFinite(t[1]) && t[1] > m ? t[1] : m), -Infinity);

const ratesOf = (sum) =>
  R.EVALUATORS.map((e) => ({ id: e.id, kind: e.kind, rate: sum[e.id].rate, total: sum[e.id].total }));

function evalsOverview({ store, indexer, keyFor, from = 0, to = Infinity }) {
  const entries = () => (indexer && indexer.entries()) || [];
  const engine = createEvalEngine({
    indexer,
    store,
    feedback: { get: () => null },
    models: NO_MODEL,
    demo: false,
  });
  const evaluators = ratesOf(engine.summary({ from, to }).evaluators);

  // Candidates: the latest judge verdict of each target, and the code results of the newest sessions.
  const found = [];
  const latest = new Map();
  for (const r of store.all()) {
    const e = R.get(r.evaluator);
    if (!e || e.kind !== 'judge' || !r.target) continue;
    const k = `${R.targetKey(r.target)}|${r.evaluator}`;
    if (!latest.has(k) || (r.ts || 0) >= (latest.get(k).ts || 0)) latest.set(k, r);
  }
  for (const r of latest.values()) {
    const ts = Number.isFinite(r.finishedAt) ? r.finishedAt : r.ts;
    if (r.label !== R.get(r.evaluator).pass && ts >= from && ts < to) {
      const { source, session } = r.target;
      found.push({ source, session, turn: r.target.turn ?? null, evaluator: r.evaluator, label: r.label, ts });
    }
  }
  const all = entries();
  const recent = sessionsOf(all)
    .filter((s) => lastTurn(s) >= from)
    .sort((a, b) => lastTurn(b) - lastTurn(a))
    .slice(0, MAX_SESSIONS);
  for (const s of recent) {
    for (const r of codeResults(all, { source: s.source, session: s.sid })) {
      const e = R.get(r.evaluator);
      const ts = s.turns[r.target.turn] && s.turns[r.target.turn][1];
      if (r.label !== e.pass && Number.isFinite(ts) && ts >= from && ts < to) {
        const { evaluator, label } = r;
        found.push({ source: s.source, session: s.sid, turn: r.target.turn, evaluator, label, ts });
      }
    }
  }
  found.sort((a, b) => b.ts - a.ts);

  const failures = [];
  for (const f of found) {
    if (failures.length >= FAILURES) break;
    let key;
    try {
      key = keyFor(f.source, f.session);
    } catch {
      continue; // a session this process does not list cannot be named
    }
    if (key) failures.push({ key, source: f.source, turn: f.turn, evaluator: f.evaluator, label: f.label, ts: f.ts });
  }
  return { evaluators, failures };
}

// Demo mode: the synthetic results of the demo data, for the synthetic sessions. No file is read.
function demoOverview({ trace, from = 0 }) {
  const d = require('../demo').evalsDemo();
  const found = [];
  for (const row of trace.sessions()) {
    const { source, sid } = trace.sourceOf(row.key);
    for (const r of d.results({ source, session: sid })) {
      if (r.label !== R.get(r.evaluator).pass && r.ts >= from) {
        const turn = r.target.turn ?? null;
        found.push({ key: row.key, source, turn, evaluator: r.evaluator, label: r.label, ts: r.ts });
      }
    }
  }
  found.sort((a, b) => b.ts - a.ts);
  return { evaluators: ratesOf(d.summary({ from }).evaluators), failures: found.slice(0, FAILURES) };
}

module.exports = { evalsOverview, demoOverview };
