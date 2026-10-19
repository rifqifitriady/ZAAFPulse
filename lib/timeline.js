// Timeline of agent activity for the Time page: one lane per session or subagent, made of tool
// segments (call to result), thinking gaps (input to the model's next output) and waiting gaps
// (finished turn to your next prompt), plus markers for prompts, errors, compactions and interrupts.
// Parsed lanes are cached per file by mtime and size, so a refresh only re-reads changed files.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { recentFiles, targetFor, zoneFor, CLAUDE_ROOT, CODEX_ROOT } = require('./office');

const ASKS = /^(AskUserQuestion|request_user_input(_async)?)$/;
const MAX_WAIT_MS = 30 * 60 * 1000; // a waiting gap longer than this is drawn as idle (empty)
const cache = new Map();

async function readLines(file, onLine) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) onLine(line);
}

async function parseClaude(file) {
  const lane = { segments: [], marks: [], project: '', model: '' };
  const open = new Map();
  let inputTs = null;
  let endTs = null;
  await readLines(file, (line) => {
    const isAssistant = line.includes('"type":"assistant"');
    if (!isAssistant && !line.includes('"type":"user"')) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) return;
    if (o.cwd) lane.project = path.basename(o.cwd);
    const m = o.message || {};
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (o.isApiErrorMessage) {
      lane.marks.push([ts, 'error', 'API error']);
      return;
    }
    if (isAssistant) {
      if (m.model && m.model !== '<synthetic>') lane.model = m.model;
      if (inputTs !== null) {
        if (ts - inputTs > 500) lane.segments.push([inputTs, ts, 'think']);
        inputTs = null;
      }
      for (const b of blocks) if (b.type === 'tool_use') open.set(b.id, [ts, b.name, targetFor(b.name, b.input)]);
      if (m.stop_reason === 'end_turn') endTs = ts;
      return;
    }
    let prompt = false;
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      const s = open.get(b.tool_use_id);
      if (!s) continue;
      open.delete(b.tool_use_id);
      if (ASKS.test(s[1])) {
        lane.segments.push([s[0], ts, 'wait']);
        continue;
      } // a question to you is waiting, not tool time
      lane.segments.push([s[0], ts, 'tool', zoneFor(s[1]), s[1], s[2], b.is_error ? 0 : 1]);
      if (b.is_error) lane.marks.push([ts, 'error', `${s[1]} failed`]);
    }
    const text = typeof m.content === 'string' ? m.content : (blocks.find((b) => b.type === 'text') || {}).text || '';
    if (o.isCompactSummary) lane.marks.push([ts, 'compact', 'Context compacted']);
    else if (/^\s*\[Request interrupted/.test(text)) lane.marks.push([ts, 'interrupt', 'You interrupted']);
    else if (!o.isMeta && m.role === 'user' && text.trim() && !blocks.some((b) => b.type === 'tool_result')) {
      prompt = true;
      lane.marks.push([ts, 'prompt', 'You prompted']);
    }
    if (prompt && endTs !== null && ts - endTs < MAX_WAIT_MS) lane.segments.push([endTs, ts, 'wait']);
    if (prompt) endTs = null;
    inputTs = ts;
  });
  // Tool calls still running: open-ended, drawn up to now.
  for (const [, s] of open)
    lane.segments.push(ASKS.test(s[1]) ? [s[0], null, 'wait'] : [s[0], null, 'tool', zoneFor(s[1]), s[1], s[2], 1]);
  if (inputTs !== null) lane.segments.push([inputTs, null, 'think']);
  if (endTs !== null) lane.segments.push([endTs, null, 'wait']);
  return lane;
}

async function parseCodex(file) {
  const lane = { segments: [], marks: [], project: '', model: '' };
  const open = new Map();
  let inputTs = null;
  let endTs = null;
  await readLines(file, (line) => {
    if (
      !/"type":"(session_meta|turn_context|function_call|custom_tool_call|function_call_output|custom_tool_call_output|user_message|task_complete|reasoning|message)"/.test(
        line,
      )
    )
      return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) return;
    const p = o.payload || {};
    if (o.type === 'session_meta' && p.cwd) lane.project = path.basename(p.cwd);
    if (o.type === 'turn_context' && p.model) lane.model = p.model;
    const output =
      p.type === 'function_call' ||
      p.type === 'custom_tool_call' ||
      p.type === 'reasoning' ||
      (p.type === 'message' && p.role === 'assistant');
    if (output && inputTs !== null) {
      if (ts - inputTs > 500) lane.segments.push([inputTs, ts, 'think']);
      inputTs = null;
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call') open.set(p.call_id, [ts, p.name]);
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const s = open.get(p.call_id);
      if (s) {
        open.delete(p.call_id);
        lane.segments.push(ASKS.test(s[1]) ? [s[0], ts, 'wait'] : [s[0], ts, 'tool', zoneFor(s[1]), s[1], '', 1]);
      }
      inputTs = ts;
    } else if (p.type === 'user_message') {
      lane.marks.push([ts, 'prompt', 'You prompted']);
      if (endTs !== null && ts - endTs < MAX_WAIT_MS) lane.segments.push([endTs, ts, 'wait']);
      endTs = null;
      inputTs = ts;
    } else if (p.type === 'task_complete') endTs = ts;
  });
  for (const [, s] of open) lane.segments.push([s[0], null, 'tool', zoneFor(s[1]), s[1], '', 1]);
  if (endTs !== null) lane.segments.push([endTs, null, 'wait']);
  return lane;
}

async function timeline(hours = 6, now = Date.now()) {
  const start = now - hours * 3600 * 1000;
  const files = [...recentFiles(CLAUDE_ROOT, 4, start), ...recentFiles(CODEX_ROOT, 4, start)];
  const lanes = [];
  for (const { file, mtime } of files) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    const isCodex = file.startsWith(CODEX_ROOT);
    let c = cache.get(file);
    if (!c || c.mtime !== mtime || c.size !== size) {
      c = { mtime, size, lane: await (isCodex ? parseCodex(file) : parseClaude(file)) };
      cache.set(file, c);
    }
    const parts = path.relative(isCodex ? CODEX_ROOT : CLAUDE_ROOT, file).split(path.sep);
    const sub = parts.includes('subagents');
    let agentType = '';
    if (sub) {
      try {
        agentType = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || '';
      } catch {
        /* older builds */
      }
    }
    const parent = sub ? `claude:${parts[parts.indexOf('subagents') - 1]}` : null;
    const id = isCodex
      ? `codex:${path.basename(file, '.jsonl')}`
      : sub
        ? `${parent}:${path.basename(file, '.jsonl')}`
        : `claude:${path.basename(file, '.jsonl')}`;
    // Clip to the window. Open-ended segments: a running tool or thinking gap only while the file is
    // still being written; a trailing wait for at most 30 minutes, and never for a finished subagent.
    const live = now - mtime < 10 * 60 * 1000;
    const end = (s) => {
      if (s[1] !== null) return s[1];
      if (s[2] === 'wait') return sub ? s[0] : Math.min(now, s[0] + MAX_WAIT_MS);
      return live ? now : s[0];
    };
    const segments = c.lane.segments
      .map((s) => [Math.max(s[0], start), Math.min(end(s), now), ...s.slice(2)])
      .filter((s) => s[1] > start && s[1] > s[0]);
    const marks = c.lane.marks.filter((m) => m[0] >= start);
    if (!segments.length && !marks.length) continue;
    lanes.push({
      id,
      tool: isCodex ? 'codex' : 'claude',
      kind: sub ? 'subagent' : 'session',
      parent,
      agentType,
      project: c.lane.project,
      model: c.lane.model,
      first: Math.min(...segments.map((s) => s[0]), ...marks.map((m) => m[0])),
      last: Math.max(...segments.map((s) => s[1]), ...marks.map((m) => m[0])),
      segments,
      marks,
    });
  }
  for (const f of cache.keys()) if (!files.some((x) => x.file === f)) cache.delete(f);
  // Parents first by start time, each followed by its subagents.
  const sessions = lanes.filter((l) => l.kind === 'session').sort((a, b) => a.first - b.first);
  const ordered = [];
  for (const s of sessions) {
    ordered.push(s);
    ordered.push(...lanes.filter((l) => l.parent === s.id).sort((a, b) => a.first - b.first));
  }
  ordered.push(...lanes.filter((l) => l.kind === 'subagent' && !sessions.some((s) => s.id === l.parent)));
  for (const l of ordered)
    if (l.kind === 'subagent' && !l.project) l.project = (lanes.find((p) => p.id === l.parent) || {}).project || '';
  return { ts: now, start, hours, lanes: ordered };
}

module.exports = { timeline };

// Synthetic lanes for DEMO=1, shaped like timeline().
function demoTimeline(hours = 6, now = Date.now()) {
  const start = now - hours * 3600 * 1000;
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const zones = [
    ['code', 'Edit', 'app.js'],
    ['read', 'Read', 'README.md'],
    ['terminal', 'Bash', 'npm'],
    ['web', 'WebFetch', 'mdn'],
    ['meeting', 'Task', 'code-reviewer'],
  ];
  const mk = (id, project, kind, parent, agentType, from, to) => {
    const segments = [];
    const marks = [];
    let t = Math.max(start, from);
    while (t < to) {
      if (r() < 0.12 && kind === 'session') {
        const w = 120000 + r() * 900000;
        segments.push([t, Math.min(to, t + w), 'wait']);
        t += w;
        marks.push([t, 'prompt', 'You prompted']);
        continue;
      }
      const think = 2000 + r() * 12000;
      segments.push([t, Math.min(to, t + think), 'think']);
      t += think;
      const [zone, tool, target] = zones[Math.floor(r() * zones.length)];
      const d = 1500 + r() * (zone === 'terminal' ? 60000 : 9000);
      const ok = r() > 0.05;
      segments.push([t, Math.min(to, t + d), 'tool', zone, tool, target, ok ? 1 : 0]);
      if (!ok) marks.push([t + d, 'error', `${tool} failed`]);
      t += d;
    }
    return {
      id,
      tool: id.split(':')[0],
      kind,
      parent,
      agentType,
      project,
      model: 'claude-opus-5-5',
      first: Math.max(start, from),
      last: to,
      segments,
      marks,
    };
  };
  const h = 3600000;
  const lanes = [
    mk('claude:demo-1', 'acme-web', 'session', null, '', now - 5 * h, now),
    mk('claude:demo-1:a1', 'acme-web', 'subagent', 'claude:demo-1', 'code-reviewer', now - 2.2 * h, now - 1.4 * h),
    mk('claude:demo-1:a2', 'acme-web', 'subagent', 'claude:demo-1', 'Explore', now - 40 * 60000, now),
    mk('claude:demo-2', 'data-pipeline', 'session', null, '', now - 3.5 * h, now - 0.5 * h),
    mk('codex:demo-5', 'design-system', 'session', null, '', now - 1.6 * h, now),
  ];
  lanes[0].marks.push([now - 3 * h, 'compact', 'Context compacted']);
  return { ts: now, start, hours, lanes };
}

module.exports.demoTimeline = demoTimeline;
