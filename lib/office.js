// What each agent is doing right now, for the 3D office on the AI Squad page.
// Reads only the tail of transcripts written in the last half hour. Keeps tool names, file
// basenames, command names, hostnames and states; never message text.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const CODEX_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const WINDOW_MS = 30 * 60 * 1000; // sessions written in this window are on the floor
const TAIL_BYTES = 512 * 1024;
const MIN = 60 * 1000;

// Where an agent goes in the office for each kind of tool.
function zoneFor(tool) {
  if (!tool) return 'code';
  if (/^mcp__/.test(tool)) return 'tools';
  if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/.test(tool)) return 'code';
  if (/^(Read|Grep|Glob|LS|NotebookRead|view_image)$/.test(tool)) return 'read';
  if (/^(Bash|BashOutput|KillShell|KillBash|exec|shell|local_shell|exec_command|unified_exec|write_stdin)$/.test(tool)) return 'terminal';
  if (/^(WebFetch|WebSearch|web_search|web_fetch)$/i.test(tool)) return 'web';
  if (/^(Task|Agent|TodoWrite|TaskCreate|TaskUpdate|EnterPlanMode|ExitPlanMode|update_plan|Skill|AskUserQuestion)$/.test(tool)) return 'meeting';
  return 'code';
}

// A short, non-sensitive target for a tool call: a file name, a command name or a hostname.
function targetFor(tool, input) {
  if (!input || typeof input !== 'object') return '';
  const file = input.file_path || input.notebook_path || input.path;
  if (typeof file === 'string' && /^(Edit|Write|MultiEdit|NotebookEdit|Read|NotebookRead|LS)$/.test(tool)) return path.basename(file);
  if (tool === 'Bash' && typeof input.command === 'string') return commandName(input.command);
  if (tool === 'WebFetch' && typeof input.url === 'string') { try { return new URL(input.url).hostname; } catch { return ''; } }
  if ((tool === 'Task' || tool === 'Agent') && typeof input.subagent_type === 'string') return input.subagent_type;
  if (tool === 'Skill' && typeof input.skill === 'string') return input.skill;
  return '';
}

// First real command of a shell line: skips `cd dir &&`, VAR=value prefixes and subshell syntax.
function commandName(cmd) {
  for (const part of String(cmd).split(/&&|\|\||;|\||\n/)) {
    const sub = part.match(/\$\(\s*([\w./-]+)/); // C=$(ls …) -> ls
    const words = part.trim().split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !/^[({]$/.test(w) && !w.startsWith('-'));
    const w = sub ? sub[1] : (words[0] || '').replace(/^[("'$]+/, '').replace(/[)"';]+$/, '');
    if (w && w !== 'cd' && /^[\w./-]+$/.test(w)) return path.basename(w);
  }
  return '';
}

function tailLines(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // first line is cut
    return lines;
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function recentFiles(root, depth, since, accept = () => true) {
  const out = [];
  const walk = (dir, d) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && d < depth) walk(p, d + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl') && accept(p)) {
        try { const m = fs.statSync(p).mtimeMs; if (m >= since) out.push({ file: p, mtime: m }); } catch { /* vanished */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

// Turn the tool calls, pending calls and last turn into one state the office can show.
function decide(a, now) {
  const age = now - a.lastTs;
  const pending = [...a.pending.values()].sort((x, y) => y.ts - x.ts)[0];
  if (pending && /^(AskUserQuestion|request_user_input(_async)?)$/.test(pending.tool)) {
    a.state = 'waiting'; // it asked you a question
    a.activity = { tool: pending.tool, target: '' };
  } else if (pending && age < 15 * MIN) {
    // A file edit or fetch that has had no result for a while is almost always a permission prompt.
    const slow = /^(Bash|BashOutput|exec|shell|exec_command|unified_exec|Task|Agent)$/.test(pending.tool);
    a.state = !slow && now - pending.ts > 45 * 1000 ? 'approval' : 'working';
    a.activity = { tool: pending.tool, target: pending.target };
  } else if (a.lastKind === 'user' && age < 5 * MIN) {
    a.state = 'thinking';
    a.activity = a.lastTool ? { tool: a.lastTool.tool, target: a.lastTool.target } : null;
  } else if (a.lastKind === 'done' && age < WINDOW_MS) {
    a.state = a.kind === 'subagent' ? 'done' : 'waiting';
    a.activity = null;
  } else {
    a.state = 'idle';
    a.activity = null;
  }
  a.zone = { working: zoneFor(a.activity?.tool), approval: 'help', thinking: a.activity ? zoneFor(a.activity.tool) : 'code', waiting: 'help', done: 'meeting', idle: 'lounge' }[a.state];
  delete a.pending; delete a.lastKind; delete a.lastTool;
  return a;
}

function blankAgent(fields) {
  return { kind: 'session', parent: null, project: '', branch: '', model: '', agentType: '', lastTs: 0, startTs: 0, events: [], pending: new Map(), lastKind: null, lastTool: null, ...fields };
}

function parseClaude(file, fields, now) {
  const a = blankAgent({ tool: 'claude', ...fields });
  for (const line of tailLines(file)) {
    const isAssistant = line.includes('"type":"assistant"');
    if (!isAssistant && !line.includes('"type":"user"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (!a.startTs) a.startTs = ts;
    a.lastTs = Math.max(a.lastTs, ts);
    if (o.cwd) a.project = path.basename(o.cwd);
    if (o.gitBranch) a.branch = o.gitBranch;
    const m = o.message || {};
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (isAssistant) {
      if (m.model && m.model !== '<synthetic>') a.model = m.model;
      for (const b of blocks) {
        if (b.type !== 'tool_use') continue;
        const ev = { ts, tool: b.name, target: targetFor(b.name, b.input), zone: zoneFor(b.name) };
        a.events.push(ev); a.pending.set(b.id, ev); a.lastTool = ev;
      }
      a.lastKind = m.stop_reason === 'end_turn' ? 'done' : m.stop_reason === 'tool_use' ? 'tool' : 'assistant';
    } else {
      for (const b of blocks) if (b.type === 'tool_result') a.pending.delete(b.tool_use_id);
      a.lastKind = 'user';
    }
  }
  return a;
}

function parseCodex(file, now) {
  const a = blankAgent({ tool: 'codex', id: `codex:${path.basename(file, '.jsonl')}` });
  // session_meta (with cwd) sits at the top of the file, beyond the tail.
  for (const line of tailLines(file, 16 * 1024).slice(0, 3)) {
    try { const o = JSON.parse(line); if (o.type === 'session_meta') { a.project = path.basename(o.payload.cwd || ''); a.branch = o.payload.git?.branch || ''; } } catch { /* partial */ }
  }
  for (const line of tailLines(file)) {
    if (!/"type":"(turn_context|function_call|custom_tool_call|function_call_output|custom_tool_call_output|task_started|task_complete|user_message|agent_message)"/.test(line)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    const p = o.payload || {};
    if (!a.startTs) a.startTs = ts;
    a.lastTs = Math.max(a.lastTs, ts);
    if (p.type === 'turn_context' || o.type === 'turn_context') { if (p.model) a.model = p.model; continue; }
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let args = {};
      try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || {}; } catch { /* not JSON */ }
      const cmd = Array.isArray(args.command) ? args.command.slice(-1)[0] : args.cmd || args.command;
      const target = typeof cmd === 'string' ? commandName(cmd) : '';
      const ev = { ts, tool: p.name, target, zone: zoneFor(p.name) };
      a.events.push(ev); a.pending.set(p.call_id, ev); a.lastTool = ev; a.lastKind = 'tool';
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      a.pending.delete(p.call_id); a.lastKind = 'user';
    } else if (p.type === 'task_started' || p.type === 'user_message') {
      a.lastKind = 'user';
    } else if (p.type === 'task_complete') {
      a.lastKind = 'done'; a.pending.clear();
    }
  }
  return a;
}

function summarizeAgent(a, now) {
  const recent = a.events.filter((e) => now - e.ts < 10 * MIN);
  const zones = {};
  for (const e of recent) zones[e.zone] = (zones[e.zone] || 0) + 1;
  const out = decide(a, now);
  out.calls10m = recent.length;
  out.zones10m = zones;
  out.feed = a.events.slice(-8).reverse();
  return out;
}

function snapshot(now = Date.now()) {
  const since = now - WINDOW_MS;
  const agents = [];
  for (const { file } of recentFiles(CLAUDE_ROOT, 4, since)) {
    const parts = path.relative(CLAUDE_ROOT, file).split(path.sep);
    if (parts.includes('subagents')) {
      const parent = parts[parts.indexOf('subagents') - 1];
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* older builds */ }
      const a = parseClaude(file, { id: `claude:${parent}:${path.basename(file, '.jsonl')}`, kind: 'subagent', parent: `claude:${parent}`, agentType: meta.agentType || 'subagent' }, now);
      if (a.lastTs) agents.push(summarizeAgent(a, now));
    } else {
      const a = parseClaude(file, { id: `claude:${path.basename(file, '.jsonl')}` }, now);
      if (a.lastTs) agents.push(summarizeAgent(a, now));
    }
  }
  for (const { file } of recentFiles(CODEX_ROOT, 4, since)) {
    const a = parseCodex(file, now);
    if (a.lastTs) agents.push(summarizeAgent(a, now));
  }
  // Subagents inherit the parent's project; finished ones leave the floor after two minutes.
  const byId = new Map(agents.map((a) => [a.id, a]));
  const floor = agents.filter((a) => {
    if (a.kind !== 'subagent') return true;
    const p = byId.get(a.parent);
    if (p) { a.project = a.project || p.project; a.model = a.model || p.model; }
    return a.state !== 'done' || now - a.lastTs < 2 * MIN;
  });
  floor.sort((x, y) => y.lastTs - x.lastTs);
  const perMinute = Array(15).fill(0); // tool calls per minute, oldest first
  for (const a of floor) for (const e of a.events) { const m = Math.floor((now - e.ts) / MIN); if (m < 15) perMinute[14 - m]++; }
  for (const a of floor) delete a.events;
  const feed = floor.flatMap((a) => a.feed.map((e) => ({ ...e, agent: a.id }))).sort((x, y) => y.ts - x.ts).slice(0, 40);
  return { ts: now, agents: floor, feed, perMinute };
}

// Synthetic office for DEMO=1: a few sessions and subagents in every state.
function demoSnapshot(now = Date.now()) {
  const t = Math.floor(now / 15000); // activities rotate every 15 seconds
  const cycle = [['Edit', 'app.js'], ['Read', 'README.md'], ['Bash', 'npm'], ['WebFetch', 'developer.mozilla.org'], ['Grep', ''], ['Write', 'styles.css']];
  const pick = (i) => cycle[(t + i) % cycle.length];
  const mk = (id, fields, i) => {
    const [tool, target] = pick(i);
    const a = { id, kind: 'session', parent: null, branch: 'main', agentType: '', startTs: now - (40 + i * 7) * MIN, lastTs: now - 4000, calls10m: 12 + i * 5, ...fields };
    a.activity = a.state === 'working' || a.state === 'thinking' ? { tool, target } : null;
    a.zone = { working: zoneFor(tool), thinking: zoneFor(tool), approval: 'help', waiting: 'help', idle: 'lounge', done: 'meeting' }[a.state];
    if (a.state === 'approval') a.activity = { tool: 'Edit', target: 'config.json' };
    a.zones10m = { code: 6 + i, read: 4, terminal: 3 + (i % 2), web: i % 3 };
    a.feed = cycle.map(([tl, tg], k) => ({ ts: now - (k * 40 + i * 9) * 1000, tool: tl, target: tg, zone: zoneFor(tl) }));
    return a;
  };
  const agents = [
    mk('claude:demo-1', { tool: 'claude', project: 'acme-web', model: 'claude-opus-5-5', state: 'working' }, 0),
    mk('claude:demo-2', { tool: 'claude', project: 'data-pipeline', model: 'claude-sonnet-5', state: 'working' }, 2),
    mk('claude:demo-1:a1', { tool: 'claude', kind: 'subagent', parent: 'claude:demo-1', agentType: 'code-reviewer', project: 'acme-web', model: 'claude-haiku-5', state: 'working' }, 4),
    mk('claude:demo-1:a2', { tool: 'claude', kind: 'subagent', parent: 'claude:demo-1', agentType: 'Explore', project: 'acme-web', model: 'claude-haiku-5', state: 'working' }, 1),
    mk('claude:demo-3', { tool: 'claude', project: 'mobile-app', model: 'claude-opus-5-5', state: 'waiting', lastTs: now - 3 * MIN }, 3),
    mk('claude:demo-4', { tool: 'claude', project: 'infra-terraform', model: 'claude-sonnet-5', state: 'approval', lastTs: now - 70 * 1000 }, 5),
    mk('codex:demo-5', { tool: 'codex', project: 'design-system', model: 'gpt-5.6-sol', state: 'thinking' }, 2),
    mk('claude:demo-6', { tool: 'claude', project: 'docs-site', model: 'claude-haiku-5', state: 'idle', lastTs: now - 22 * MIN }, 1),
  ];
  const feed = agents.flatMap((a) => a.feed.map((e) => ({ ...e, agent: a.id }))).sort((x, y) => y.ts - x.ts).slice(0, 40);
  const perMinute = Array.from({ length: 15 }, (_, i) => 4 + ((i * 7 + t) % 9));
  return { ts: now, agents, feed, perMinute };
}

module.exports = { snapshot, demoSnapshot, zoneFor, targetFor, commandName, decide, tailLines, recentFiles, CLAUDE_ROOT, CODEX_ROOT };
