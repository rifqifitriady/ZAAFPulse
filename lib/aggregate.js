// Turns cached per-file results into the dashboard payload for one time range.
const path = require('path');
const { makePricer } = require('./pricing');
const { summarizeQuality } = require('./quality');

const DAY = 86400000;
const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' };

function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function inc(obj, k, n = 1) { obj[k] = (obj[k] || 0) + n; }
function addAll(into, from) { for (const [k, v] of Object.entries(from || {})) inc(into, k, v); }
function top(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}
function blank() { return { calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; }
function addUsage(t, e, cost) {
  const cw = e[7] + e[8];
  t.calls++; t.input += e[4]; t.output += e[5]; t.cacheRead += e[6]; t.cacheWrite += cw;
  t.tokens += e[4] + e[5] + e[6] + cw; t.cost += cost;
}

function mergeSessions(results) {
  const map = new Map();
  for (const r of results) {
    for (const [sid, s] of Object.entries(r.sessions || {})) {
      const key = `${s.tool}:${sid}`;
      const m = map.get(key);
      if (!m) { map.set(key, { ...s, id: sid, tools: { ...s.tools }, skills: { ...s.skills }, agents: { ...s.agents } }); continue; }
      m.prompts += s.prompts;
      m.subagentFiles += s.subagentFiles;
      if (s.first && (!m.first || s.first < m.first)) m.first = s.first;
      if (s.last && (!m.last || s.last > m.last)) m.last = s.last;
      m.project = m.project || s.project;
      m.entrypoint = m.entrypoint || s.entrypoint;
      m.branch = m.branch || s.branch;
      addAll(m.tools, s.tools); addAll(m.skills, s.skills); addAll(m.agents, s.agents);
    }
  }
  return map;
}

function summarize(results, { rangeDays, pricing, now = Date.now() }) {
  const pricer = makePricer(pricing);
  const end = now;
  const all = rangeDays === 'all';
  let start = all ? Infinity : startOfDay(now - (rangeDays - 1) * DAY);
  const sessions = mergeSessions(results);

  const events = [];
  let limits = null;
  for (const r of results) {
    for (const e of r.events) events.push(e);
    if (r.limits && (!limits || r.limits.ts > limits.ts)) limits = r.limits;
  }
  if (all) start = startOfDay(events.reduce((m, e) => Math.min(m, e[0]), now));
  const span = end - start;
  const prevStart = start - span;
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();

  const cur = blank(); const prev = blank();
  let monthCost = 0;
  const monthDays = {};
  const costParts = [0, 0, 0, 0];
  const curSessions = new Set(); const prevSessions = new Set();
  const byTool = {}; const byModel = {}; const bySession = {}; const days = {};
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const unpriced = new Set();
  const lastActive = {};

  for (const e of events) {
    const [ts, tool, sid, model] = e;
    if (!Number.isFinite(ts)) continue;
    const parts = pricer.parts(model, e[4], e[5], e[6], e[7], e[8]);
    const cost = parts[0] + parts[1] + parts[2] + parts[3];
    lastActive[tool] = Math.max(lastActive[tool] || 0, ts);
    if (ts >= monthStart && ts <= end) { monthCost += cost; inc(monthDays, dayKey(ts), cost); }
    const skey = `${tool}:${sid}`;
    if (ts >= prevStart && ts < start) { addUsage(prev, e, cost); prevSessions.add(skey); continue; }
    if (ts < start || ts > end) continue;

    addUsage(cur, e, cost);
    for (let i = 0; i < 4; i++) costParts[i] += parts[i];
    curSessions.add(skey);
    if (!pricer.priced(model)) unpriced.add(model);
    addUsage(byTool[tool] ||= { ...blank(), sessions: new Set(), models: {} }, e, cost);
    byTool[tool].sessions.add(skey);
    inc(byTool[tool].models, model);
    addUsage(byModel[`${tool}|${model}`] ||= { ...blank(), tool, model }, e, cost);

    const ss = (bySession[skey] ||= { ...blank(), models: {}, subCalls: 0, first: ts, last: ts });
    addUsage(ss, e, cost);
    inc(ss.models, model);
    if (e[9]) ss.subCalls++;
    ss.first = Math.min(ss.first, ts); ss.last = Math.max(ss.last, ts);

    const dk = dayKey(ts);
    const d = (days[dk] ||= {});
    const dt = (d[tool] ||= { tokens: 0, cost: 0, calls: 0, sessions: new Set() });
    dt.tokens += e[4] + e[5] + e[6] + e[7] + e[8]; dt.cost += cost; dt.calls++; dt.sessions.add(skey);
    const dd = new Date(ts);
    heat[dd.getDay()][dd.getHours()]++;
  }

  // Daily series, one row per calendar day so gaps show as zero.
  const tools = Object.keys(TOOL_NAMES);
  const daily = [];
  for (let t = start; t <= end; t += DAY) {
    const k = dayKey(t);
    const row = { date: k };
    for (const tool of tools) {
      const v = days[k] && days[k][tool];
      row[tool] = v ? { tokens: v.tokens, cost: v.cost, calls: v.calls, sessions: v.sessions.size } : { tokens: 0, cost: 0, calls: 0, sessions: 0 };
    }
    daily.push(row);
  }

  const toolTally = {}; const skillTally = {}; const agentTally = {};
  const projects = {};
  const entrypoints = {};
  let prompts = 0;
  const sessionRows = [];
  for (const [skey, st] of Object.entries(bySession)) {
    const s = sessions.get(skey) || { tool: skey.split(':')[0], id: skey.split(':')[1], tools: {}, skills: {}, agents: {}, prompts: 0 };
    addAll(toolTally, s.tools); addAll(skillTally, s.skills); addAll(agentTally, s.agents);
    prompts += s.prompts || 0;
    inc(entrypoints, (s.entrypoint || 'unknown').replace(/^claude-/, ''));
    // Codex desktop gives each chat its own dated folder; group them as one project.
    const proj = (s.project || 'unknown').replace(/(\/Documents\/Codex)\/\d{4}-\d{2}-\d{2}\/.*$/, '$1');
    const p = (projects[proj] ||= { ...blank(), path: proj, name: path.basename(proj) || proj, sessions: 0, tools: {}, last: 0 });
    p.sessions++; p.calls += st.calls; p.tokens += st.tokens; p.output += st.output; p.cost += st.cost;
    inc(p.tools, s.tool); p.last = Math.max(p.last, st.last);
    sessionRows.push({
      id: s.id, tool: s.tool, project: path.basename(s.project || proj) || proj, projectPath: s.project || proj,
      entrypoint: s.entrypoint, branch: s.branch, start: st.first, end: st.last,
      prompts: s.prompts || 0, calls: st.calls, subCalls: st.subCalls, tokens: st.tokens, output: st.output, cost: st.cost,
      model: top(st.models, 1)[0]?.name, models: Object.keys(st.models),
      subagents: Object.values(s.agents || {}).reduce((a, b) => a + b, 0),
    });
  }
  sessionRows.sort((a, b) => b.end - a.end);

  const nowD = new Date(now);
  const daysInMonth = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate();
  const daysElapsed = (now - monthStart) / DAY;
  const monthDaily = [];
  for (let dd = 1; dd <= nowD.getDate(); dd++) {
    const k = dayKey(new Date(nowD.getFullYear(), nowD.getMonth(), dd).getTime());
    monthDaily.push({ date: k, cost: monthDays[k] || 0 });
  }

  return {
    generatedAt: now,
    range: { days: rangeDays, start, end, prevStart },
    kpis: {
      sessions: curSessions.size, prevSessions: prevSessions.size,
      tokens: cur.tokens, prevTokens: prev.tokens, output: cur.output,
      cost: cur.cost, prevCost: prev.cost, calls: cur.calls, prevCalls: prev.calls,
      prompts, monthCost,
      cacheHitRate: cur.input + cur.cacheRead + cur.cacheWrite > 0 ? cur.cacheRead / (cur.input + cur.cacheRead + cur.cacheWrite) : 0,
      subagentCalls: sessionRows.reduce((a, s) => a + s.subCalls, 0),
      composition: { input: cur.input, output: cur.output, cacheRead: cur.cacheRead, cacheWrite: cur.cacheWrite },
      costParts: { input: costParts[0], output: costParts[1], cacheRead: costParts[2], cacheWrite: costParts[3] },
    },
    month: { daily: monthDaily, daysInMonth, daysElapsed, projected: daysElapsed > 0 ? (monthCost / daysElapsed) * daysInMonth : 0 },
    entrypoints: top(entrypoints, 6),
    topCostSessions: [...sessionRows].sort((a, b) => b.cost - a.cost).slice(0, 5),
    daily,
    heatmap: heat,
    tools: tools.map((id) => {
      const t = byTool[id];
      return {
        id, name: TOOL_NAMES[id], lastActive: lastActive[id] || null,
        calls: t ? t.calls : 0, tokens: t ? t.tokens : 0, output: t ? t.output : 0, cost: t ? t.cost : 0,
        sessions: t ? t.sessions.size : 0, models: t ? top(t.models, 4) : [],
      };
    }),
    models: Object.values(byModel).map((m) => ({ ...m, priced: pricer.priced(m.model) })).sort((a, b) => b.tokens - a.tokens),
    projects: Object.values(projects).sort((a, b) => b.tokens - a.tokens),
    sessions: sessionRows.slice(0, 300),
    totalSessions: sessionRows.length,
    toolUse: top(toolTally, 12),
    skills: top(skillTally, 12),
    subagents: top(agentTally, 12),
    unpriced: [...unpriced],
    quality: summarizeQuality(results, sessions, { start, end, prevStart }),
    codexLimits: limits,
  };
}

module.exports = { summarize };
