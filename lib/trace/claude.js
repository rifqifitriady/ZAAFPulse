// Claude Code adapter for the trace explorer. Sessions come from the index; a turn's spans are built
// by reading only that turn's byte range (and the small subagent files it links to). No text is kept:
// spans carry a reference to where their text sits, read on demand by lib/trace/content.js.
const path = require('path');
const { readLines } = require('./lines');
const { spanId, span } = require('./model');
const sig = require('../signals');
const { makePricer, DEFAULT_PRICING, eventParts } = require('../pricing');

const isSubFile = (file) => file.includes(`${path.sep}subagents${path.sep}`);

function sessions(entries) {
  const out = new Map();
  for (const e of entries) {
    if (e.source !== 'claude' || isSubFile(e.file)) continue;
    for (const [sid, s] of Object.entries(e.result.sessions || {})) {
      if (!s.turns || !s.turns.length) continue;
      const sig2 = (e.result.signals && e.result.signals.events) || [];
      const mine = sig2.filter((x) => x.sid === sid);
      out.set(sid, {
        id: sid,
        source: 'claude',
        title: null, // read on demand from the first turn (no text in the index)
        project: s.project,
        branch: s.branch,
        start: s.first,
        end: s.last,
        turns: s.turns.length,
        tools: Object.values(s.tools || {}).reduce((a, b) => a + b, 0),
        errors: mine.filter((x) => x.kind === 'error').length,
        cost: 0,
        flags: { errors: mine.some((x) => x.kind === 'error'), loop: mine.some((x) => x.kind === 'loop'), injection: mine.some((x) => x.kind === 'injection') },
        file: e.file,
        size: e.size,
      });
    }
  }
  // Cost from the usage rows (main and subagent files of the same session).
  const pricer = makePricer(DEFAULT_PRICING);
  for (const e of entries) {
    if (e.source !== 'claude') continue;
    for (const row of e.result.events || []) {
      const r = out.get(row[2]);
      if (r) r.cost += eventParts(pricer, row).reduce((a, b) => a + b, 0);
    }
  }
  return [...out.values()];
}

const tsOf = (o) => Date.parse(o.timestamp);

// Parse one transcript range into chat and tool spans under `parent`.
async function spansOf(file, range, sid, parent, ctx, depth) {
  const chats = new Map(); // message id -> chat span
  const tools = new Map(); // tool_use id -> tool span
  const out = [];
  let lastChat = null;
  let lastText = null;
  for await (const { text, start, end } of readLines(file, range)) {
    if (!text.includes('"type":"assistant"') && !text.includes('"type":"user"')) continue;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      out.push(span({ id: spanId(file, start, 'bad'), parent, kind: 'unknown', op: 'unknown', name: 'unreadable line', start: null, status: 'unknown', text: { f: file, s: start, e: end, k: 'raw' } }));
      continue;
    }
    const ts = tsOf(o);
    const m = o.message;
    if (o.type === 'assistant' && m && m.model && m.model !== '<synthetic>') {
      let c = chats.get(m.id);
      if (!c) {
        c = span({ id: spanId(file, 'chat', m.id || start), parent, kind: 'chat', op: 'chat', name: `chat ${m.model}`, start: ts, end: ts, model: m.model, provider: 'anthropic', usage: null, text: { f: file, s: start, e: end, k: 'reply', i: m.id } });
        chats.set(m.id, c);
        out.push(c);
      }
      c.end = Math.max(c.end || ts, ts);
      c.text.e = Math.max(c.text.e, end);
      const u = m.usage || {};
      const usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite5m: 0, cacheWrite1h: 0 };
      if (!c.usage || usage.output >= c.usage.output) {
        c.usage = usage;
        const row = [ts, 'claude', sid, m.model, usage.input, usage.output, usage.cacheRead, 0, 0, 0, null, null];
        c.cost = eventParts(ctx.pricer, row).reduce((a, b) => a + b, 0);
      }
      lastChat = c;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text' && b.text) lastText = { f: file, s: start, e: end, k: 'reply', i: m.id };
        if (b.type !== 'tool_use' || tools.has(b.id)) continue;
        const agentId = ctx.links.get(b.id);
        const kind = agentId ? 'agent' : 'tool';
        const label = agentId ? (b.input && b.input.subagent_type) || 'subagent' : b.name;
        const t = span({ id: spanId(file, 'tool', b.id), parent, kind, op: agentId ? 'invoke_agent' : 'execute_tool', name: agentId ? `invoke_agent ${label}` : `execute_tool ${b.name}`, start: ts, tool: { name: b.name, target: targetOf(b) }, status: 'running', text: { f: file, s: start, e: end, k: 'tool_input', i: b.id } });
        tools.set(b.id, t);
        out.push(t);
        if (agentId && depth < 4) {
          const sub = ctx.subFiles.get(agentId);
          if (sub) out.push(...(await spansOf(sub, {}, sid, t.id, ctx, depth + 1)).spans);
        }
      }
    } else if (o.type === 'user' && m && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const t = tools.get(b.tool_use_id);
        if (!t) continue;
        t.end = ts;
        t.status = b.is_error ? 'error' : 'ok';
        t.result = { f: file, s: start, e: end, k: 'tool_output', i: b.tool_use_id };
        if (b.is_error) {
          const txt = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '';
          t.signals = [sig.classifyError(txt, t.tool.name)[0]];
        }
      }
    }
  }
  return { spans: out, lastChat, lastText };
}

function targetOf(b) {
  const i = b.input || {};
  const p = i.file_path || i.path || i.notebook_path || '';
  if (p) return path.basename(String(p));
  if (typeof i.command === 'string') return i.command.trim().split(/\s+/)[0];
  if (i.url) {
    try {
      return new URL(i.url).host;
    } catch {
      return null;
    }
  }
  return null;
}

async function skeleton(entry, sid, { turn, entries = [], pricing } = {}) {
  const s = entry.result.sessions[sid];
  const turns = s.turns.map(([start, ts], index) => ({ index, start, ts }));
  const n = turn == null ? turns.length - 1 : Math.max(0, Math.min(turns.length - 1, turn));
  const range = { start: turns[n].start, end: n + 1 < turns.length ? turns[n + 1].start : entry.size };
  const links = new Map((s.agentLinks || []).map((l) => [l.toolUseId, l.agentId]));
  const subFiles = new Map();
  for (const e of entries) if (isSubFile(e.file) && e.result.sessions[sid] && e.result.sessions[sid].agentId) subFiles.set(e.result.sessions[sid].agentId, e.file);
  const ctx = { links, subFiles, pricer: makePricer(pricing || DEFAULT_PRICING) };
  const root = span({ id: spanId(entry.file, sid, 'session'), kind: 'session', op: 'invoke_agent', name: 'invoke_agent claude-code', start: s.first, end: s.last });
  const turnSpan = span({ id: spanId(entry.file, sid, 'turn', turns[n].start), parent: root.id, kind: 'turn', op: 'invoke_agent', name: `turn ${n + 1}`, start: turns[n].ts, text: { f: entry.file, s: range.start, e: range.start, k: 'prompt' } });
  const body = await spansOf(entry.file, range, sid, turnSpan.id, ctx, 0);
  turnSpan.end = Math.max(turnSpan.start || 0, ...body.spans.map((x) => x.end || 0));
  const spans = [root, turnSpan, ...body.spans];
  if (body.lastText) spans.push(span({ id: spanId(entry.file, sid, 'answer', range.start), parent: turnSpan.id, kind: 'answer', op: 'chat', name: 'answer', start: body.lastChat.end, end: body.lastChat.end, text: body.lastText }));
  for (const t of spans) if (t.status === 'running') t.status = 'unknown';
  return { session: { id: sid, source: 'claude', project: s.project, branch: s.branch, start: s.first, end: s.last }, turns, spans };
}

module.exports = { id: 'claude', sessions, skeleton };
