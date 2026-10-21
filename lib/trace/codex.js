// Codex adapter for the trace explorer. Turn byte ranges come from the index (lib/codex.js parseFile);
// a turn's spans are built by reading only that range. No text is kept: spans carry a reference to where
// their text sits (src: 'codex'), read on demand by lib/trace/content.js.
const path = require('path');
const { readLines } = require('./lines');
const { MAX_READ } = require('./content');
const { spanId, span, commandName } = require('./model');
const sig = require('../signals');
const { makePricer, DEFAULT_PRICING, eventParts } = require('../pricing');
const { commandOf, shellOutput } = require('../codex');

const sumCounts = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const mineOf = (e, sid) => ((e.result.signals && e.result.signals.events) || []).filter((x) => x.sid === sid);

// `pricing` is the owner's price list (config.json), the same one the dashboard's totals use.
function sessions(entries, { pricing } = {}) {
  const out = new Map();
  for (const e of entries) {
    if (e.source !== 'codex') continue;
    for (const [sid, s] of Object.entries(e.result.sessions || {})) {
      if (!s.turns || !s.turns.length) continue;
      const mine = mineOf(e, sid);
      out.set(sid, {
        id: sid,
        source: 'codex',
        title: null, // read on demand from the first turn (no text in the index)
        project: s.project,
        branch: s.branch,
        start: s.first,
        end: s.last,
        turns: s.turns.length,
        tools: sumCounts(s.tools),
        errors: mine.filter((x) => x.kind === 'error').length,
        cost: 0,
        flags: { errors: mine.some((x) => x.kind === 'error'), loop: mine.some((x) => x.kind === 'loop'), injection: mine.some((x) => x.kind === 'injection') },
        file: e.file,
        size: e.size,
      });
    }
  }
  const pricer = makePricer(pricing || DEFAULT_PRICING);
  for (const e of entries) {
    if (e.source !== 'codex') continue;
    for (const row of e.result.events || []) {
      const r = out.get(row[2]);
      if (r) r.cost += eventParts(pricer, row).reduce((a, b) => a + b, 0);
    }
  }
  return [...out.values()];
}

// A missing or malformed timestamp is null, never NaN, so it cannot leak into a span's times.
const tsOf = (o) => {
  const t = Date.parse(o.timestamp);
  return Number.isFinite(t) ? t : null;
};
const maxTs = (a, b) => (Number.isFinite(a) ? (Number.isFinite(b) ? Math.max(a, b) : a) : Number.isFinite(b) ? b : null);

// Lines the adapter looks at; the rest (reasoning blobs, world state, ...) are skipped without parsing.
const WANTED = /"type":"(response_item|token_count|agent_message|turn_aborted|turn_context)"/;
// The same exit-code test the parser applies to a tool result.
const FAILED = /^\s*Script failed|"exit_code":\s*[1-9]|Exit code:? [1-9]|Process exited with code [1-9]/;

const outputText = (out) =>
  typeof out === 'string' ? out : Array.isArray(out) ? out.map((x) => (x && x.text) || '').join('\n') : out && typeof out === 'object' ? JSON.stringify(out) : '';

// A short label for what the tool touches: the command's first word or a file name, never more.
function targetOf(args) {
  let a;
  try {
    a = JSON.parse(args);
  } catch {
    a = null;
  }
  if (a && typeof a === 'object') {
    if (a.command != null || a.cmd != null) return commandName(commandOf(args));
    const p = a.file_path || a.path;
    return p ? path.basename(String(p)) : null;
  }
  const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(args || ''); // apply_patch
  return m ? path.basename(m[1].trim()) : null;
}

// The four counts of a token_count block. OpenAI counts cached tokens and cache writes inside input.
const fieldsOf = (u) => ({
  input: u.input_tokens || 0,
  cached: u.cached_input_tokens || 0,
  written: u.cache_write_input_tokens || u.cache_creation_input_tokens || u.cache_creation_tokens || 0,
  output: u.output_tokens || 0,
});

const isAssistantMessage = (p) => p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content) && p.content.some((b) => b && b.type === 'output_text' && b.text);

// Parse one turn's byte range into chat and tool spans under `parent`.
async function spansOf(file, range, sid, parent, ctx) {
  const tools = new Map(); // call_id -> tool span
  const out = [];
  // A model call is a run of output lines (assistant messages, tool calls) up to the next tool result. Most
  // logs measure each one with a token_count line, but many have a single token_count for the whole log:
  // a call nothing measured still shows, as a chat with no usage and no cost.
  let call = null; // the call being read: { s, e, from, ts, model, reply }
  const unmeasured = []; // calls a tool result ended, not measured yet
  let lastReply = null; // the last assistant message of the turn: the answer
  let lastEdge = ctx.turnTs; // where the next chat began
  let aborted = false;
  let model = ctx.model;
  // The usage of one token_count line as a pricing row, or null when it adds nothing. The parser has
  // already written a row for each line it counted (against the right baseline, even after a fork's
  // copied history), so that row is used when it is there. Otherwise (a log without total_tokens or
  // last_token_usage, which the parser skips) the cumulative total is diffed against the previous one.
  let prev = ctx.baseline;
  let rowAt = 0;
  const usageRow = (info, ts) => {
    const total = info && info.total_token_usage;
    const last = info && info.last_token_usage;
    if (!total && !last) return null;
    const t = total && fieldsOf(total);
    const matched = ctx.rows[rowAt] && ctx.rows[rowAt][0] === ts ? ctx.rows[rowAt++] : null;
    let d = null;
    if (matched) d = { input: matched[4] + matched[6] + matched[7], cached: matched[6], written: matched[7], output: matched[5] };
    else if (t && prev && t.input >= prev.input && t.output >= prev.output) d = { input: t.input - prev.input, cached: t.cached - prev.cached, written: t.written - prev.written, output: t.output - prev.output };
    else if (t && !prev) d = t;
    else if (last) d = fieldsOf(last); // the total went backwards or is missing: this request's own count
    if (t) prev = t;
    if (!d || (!d.input && !d.output)) return null;
    const cached = Math.min(d.cached, d.input);
    const written = Math.min(d.written, d.input - cached);
    return [ts, 'codex', ctx.sid, model, d.input - cached - written, d.output, cached, written, 0, 0, null, matched ? matched[11] : null];
  };
  // An output line of the model: it opens a call or extends the one being read. `reply`: it is assistant text.
  const output = (s, e, ts, reply) => {
    if (!call) call = { s, e, from: lastEdge, ts, model, reply: null };
    call.e = e;
    call.ts = maxTs(call.ts, ts);
    if (reply) call.reply = { s: call.reply ? call.reply.s : s, e };
  };
  // Calls nothing measured become chats without usage (the model is the one turn_context named).
  const flush = () => {
    for (const c of unmeasured.splice(0)) {
      const st = Number.isFinite(c.from) && (!Number.isFinite(c.ts) || c.from <= c.ts) ? c.from : c.ts;
      out.push(
        span({
          id: spanId(file, 'chat', c.s),
          parent,
          kind: 'chat',
          op: 'chat',
          name: `chat ${c.model}`,
          start: st,
          end: c.ts,
          model: c.model,
          provider: 'openai',
          text: c.reply && { f: file, s: c.reply.s, e: c.reply.e, k: 'reply', i: null, src: 'codex' },
        }),
      );
    }
  };
  for await (const { text, start, end } of readLines(file, range)) {
    if (!WANTED.test(text)) continue;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      o = null;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      out.push(span({ id: spanId(file, start, 'bad'), parent, kind: 'unknown', op: 'unknown', name: 'unreadable line', start: null, status: 'unknown', text: { f: file, s: start, e: end, k: 'raw' } }));
      continue;
    }
    const ts = tsOf(o);
    const p = o.payload && typeof o.payload === 'object' ? o.payload : {};
    const ref = (k, i, s = start, e = end) => ({ f: file, s, e, k, i, src: 'codex' });
    if (o.type === 'turn_context') {
      if (p.model) model = p.model;
    } else if (p.type === 'token_count') {
      const row = usageRow(p.info, ts);
      if (!row) continue;
      // It measures the call it follows: the one being read, else the last one a tool result ended.
      const target = call || unmeasured.pop() || null;
      flush();
      const from = target ? target.from : lastEdge;
      out.push(
        span({
          id: spanId(file, 'chat', target ? target.s : start),
          parent,
          kind: 'chat',
          op: 'chat',
          name: `chat ${row[3]}`,
          start: Number.isFinite(from) && from <= ts ? from : ts,
          end: ts,
          model: row[3],
          provider: 'openai',
          usage: { input: row[4], output: row[5], cacheRead: row[6], cacheWrite5m: row[7], cacheWrite1h: row[8] },
          cost: eventParts(ctx.pricer, row).reduce((a, b) => a + b, 0),
          text: target && target.reply && ref('reply', null, target.reply.s, target.reply.e),
        }),
      );
      lastEdge = ts;
      call = null;
    } else if (isAssistantMessage(p) || (p.type === 'agent_message' && typeof p.message === 'string' && p.message)) {
      output(start, end, ts, true);
      lastReply = { s: start, e: end, ts };
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      output(start, end, ts, false);
      const name = p.name || 'tool';
      const args = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : '';
      const id = p.call_id || `@${start}`;
      if (tools.has(id)) continue;
      const t = span({ id: spanId(file, 'tool', id), parent, kind: 'tool', op: 'execute_tool', name: `execute_tool ${name}`, start: ts, tool: { name, target: targetOf(args) }, status: 'running', text: ref('tool_input', p.call_id || null) });
      tools.set(id, t);
      out.push(t);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      // A tool result is the next request's input: the call that asked for it is over.
      if (call) unmeasured.push(call);
      call = null;
      if (Number.isFinite(ts)) lastEdge = ts;
      const t = tools.get(p.call_id);
      if (!t) continue;
      const body = outputText(p.output);
      t.end = ts;
      t.status = FAILED.test(body) ? 'error' : 'ok';
      t.result = ref('tool_output', p.call_id);
      if (t.status === 'error') t.signals = [sig.classifyError(shellOutput(body), t.tool.name)[0]];
    } else if (p.type === 'web_search_call') {
      output(start, end, ts, false);
      out.push(span({ id: spanId(file, 'tool', 'ws', start), parent, kind: 'tool', op: 'execute_tool', name: 'execute_tool web_search', start: ts, end: ts, tool: { name: 'web_search', target: null }, status: 'ok', text: ref('tool_input', null) }));
    } else if (p.type === 'turn_aborted') {
      aborted = true;
    }
  }
  if (call) unmeasured.push(call);
  flush();
  return { spans: out, lastReply, aborted };
}

async function skeleton(entry, sid, { turn, entries = [], pricing } = {}) {
  const s = entry.result.sessions && entry.result.sessions[sid];
  if (!s || !s.turns || !s.turns.length) throw Object.assign(new Error('unknown session'), { status: 404 });
  const turns = s.turns.map(([start, ts], index) => ({ index, start, ts }));
  const n = turn == null ? turns.length - 1 : Math.max(0, Math.min(turns.length - 1, turn));
  const range = { start: turns[n].start, end: n + 1 < turns.length ? turns[n + 1].start : entry.size };
  // The usage rows the parser wrote for this turn, in file order, and the running total and model
  // before it (summed from the rows of the turns above, so no earlier part of the log is read).
  const mine = (entry.result.events || []).filter((r) => r[2] === sid && Number.isFinite(r[0]));
  const from = turns[n].ts;
  const next = n + 1 < turns.length ? turns[n + 1].ts : null;
  const before = from == null ? [] : mine.filter((r) => r[0] < from);
  const rows = mine.filter((r) => (from == null || r[0] >= from) && (next == null || r[0] < next));
  const baseline = before.length
    ? before.reduce((a, r) => ({ input: a.input + r[4] + r[6] + r[7], cached: a.cached + r[6], written: a.written + r[7], output: a.output + r[5] }), { input: 0, cached: 0, written: 0, output: 0 })
    : null;
  const ctx = { sid, rows, baseline, model: (before.length && before[before.length - 1][3]) || 'codex', turnTs: from, pricer: makePricer(pricing || DEFAULT_PRICING) };
  const root = span({ id: spanId(entry.file, sid, 'session'), kind: 'session', op: 'invoke_agent', name: 'invoke_agent codex', start: s.first, end: s.last });
  // The prompt is found among the turn's user messages (several are injected context), so its ref spans
  // the whole turn, up to the most one read may be.
  const promptEnd = Math.min(range.end, range.start + MAX_READ);
  const turnSpan = span({ id: spanId(entry.file, sid, 'turn', turns[n].start), parent: root.id, kind: 'turn', op: 'invoke_agent', name: `turn ${n + 1}`, start: turns[n].ts, text: { f: entry.file, s: range.start, e: promptEnd, k: 'prompt', i: null, src: 'codex' } });
  const body = await spansOf(entry.file, range, sid, turnSpan.id, ctx);
  turnSpan.end = body.spans.reduce((a, x) => maxTs(a, x.end), turnSpan.start);
  if (body.aborted) {
    turnSpan.status = 'error';
    turnSpan.signals = ['interrupted'];
  }
  const spans = [root, turnSpan, ...body.spans];
  const r = body.lastReply;
  if (r) spans.push(span({ id: spanId(entry.file, sid, 'answer', range.start), parent: turnSpan.id, kind: 'answer', op: 'chat', name: 'answer', start: maxTs(r.ts, turnSpan.start), end: maxTs(r.ts, turnSpan.start), text: { f: entry.file, s: r.s, e: r.e, k: 'reply', i: null, src: 'codex' } }));
  for (const t of spans) if (t.status === 'running') t.status = 'unknown';
  return { session: { id: sid, source: 'codex', project: s.project, branch: s.branch, start: s.first, end: s.last }, turns, spans };
}

module.exports = { id: 'codex', sessions, skeleton };
