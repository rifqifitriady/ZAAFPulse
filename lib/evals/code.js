// Code evaluators: turn the signal events the index already records into per-turn eval results, on demand.
// Evidence is { tool, label } only; event text (snippets) is never copied.
const R = require('./registry');

const CODE = R.EVALUATORS.filter((e) => e.kind === 'code');
const MAX_EVIDENCE = 5;
const isSub = (file) => /[\\/]subagents[\\/]/.test(file || '');

// Turn i owns [turns[i].ts, turns[i+1].ts). Events before the first turn, or in a session with no turns, go to
// turn 0; turns without a timestamp are skipped when searching.
function turnOf(turns, ts) {
  let found = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i][1];
    if (Number.isFinite(t) && t <= ts) found = i;
  }
  return found;
}

// Group events by "source|sid" and keep the turns of the main (non-subagent) file; subagent files are keyed by the
// parent sid, so their events land on the parent's turns.
function groupSessions(entries, only) {
  const groups = new Map();
  for (const en of entries || []) {
    const r = en.result;
    if (!r) continue;
    const add = (sid) => {
      const key = `${en.source}|${sid}`;
      if (!groups.has(key)) groups.set(key, { source: en.source, session: sid, turns: [], events: [] });
      return groups.get(key);
    };
    for (const [sid, s] of Object.entries(r.sessions || {})) {
      if (only && (en.source !== only.source || sid !== only.session)) continue;
      const g = add(sid);
      if (!isSub(en.file) && !g.turns.length && s && s.turns && s.turns.length) g.turns = s.turns;
    }
    for (const ev of (r.signals && r.signals.events) || []) {
      if (only && (en.source !== only.source || ev.sid !== only.session)) continue;
      add(ev.sid).events.push(ev);
    }
  }
  return [...groups.values()];
}

const ev2code = (ev) => {
  if (ev.kind === 'secret') return 'secret_leak';
  if (ev.kind === 'risky') return 'risky_command';
  if (ev.kind === 'injection') return 'prompt_injection';
  if (ev.kind === 'loop') return 'tool_loop';
  if (ev.kind === 'error' && ev.category === 'hallucination') return 'non_existent_target';
  if (ev.kind === 'correction') return 'correction';
  return null;
};

// Per turn and evaluator: { label, evidence }. Returns an array indexed by turn of Map(evaluatorId -> hit).
function evaluateSession(g) {
  const n = Math.max(g.turns.length, 1);
  const hits = Array.from({ length: n }, () => new Map());
  for (const ev of g.events) {
    const id = ev2code(ev);
    if (!id || !Number.isFinite(ev.ts)) continue;
    let turn = turnOf(g.turns, ev.ts);
    // A correction prompt starts turn n+1 and says turn n was wrong.
    if (id === 'correction') turn -= 1;
    if (turn < 0) continue;
    const h = hits[turn];
    if (!h.has(id)) h.set(id, []);
    h.get(id).push(ev);
  }
  return hits.map((h) => {
    const out = new Map();
    for (const e of CODE) {
      const list = h.get(e.id);
      if (!list) {
        out.set(e.id, { label: e.pass, evidence: [] });
        continue;
      }
      let label = e.labels[e.labels.length - 1];
      if (e.id === 'prompt_injection') label = list.some((x) => x.external === true) ? 'external' : 'local';
      const seen = new Set();
      const evidence = [];
      for (const x of list) {
        const item = { tool: x.source || null, label: x.label || x.category || null };
        const k = `${item.tool}\u0000${item.label}`;
        if (seen.has(k) || evidence.length >= MAX_EVIDENCE) continue;
        seen.add(k);
        evidence.push(item);
      }
      out.set(e.id, { label, evidence });
    }
    return out;
  });
}

function codeResults(entries, { source, session }) {
  const g = groupSessions(entries, { source, session })[0];
  if (!g) return [];
  const out = [];
  evaluateSession(g).forEach((byEval, turn) => {
    for (const e of CODE) {
      const { label, evidence } = byEval.get(e.id);
      out.push({ target: { source, session, turn }, evaluator: e.id, label, score: R.scoreOf(e, label), evidence });
    }
  });
  return out;
}

const dayOf = (ts) => {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function codeSummary(entries, { from, to }) {
  const sum = {};
  for (const e of CODE) sum[e.id] = { pass: 0, total: 0, days: {} };
  for (const g of groupSessions(entries)) {
    if (!g.turns.length) continue;
    const per = evaluateSession(g);
    g.turns.forEach(([, ts], i) => {
      if (!Number.isFinite(ts) || ts < from || ts >= to) return;
      const day = dayOf(ts);
      for (const e of CODE) {
        const s = sum[e.id];
        const d = s.days[day] || (s.days[day] = { pass: 0, total: 0 });
        const pass = per[i].get(e.id).label === e.pass ? 1 : 0;
        s.total++;
        d.total++;
        s.pass += pass;
        d.pass += pass;
      }
    });
  }
  return sum;
}

module.exports = { codeResults, codeSummary };
