// Parses OpenAI Codex rollouts (~/.codex/sessions/**/*.jsonl) into usage events.
// OpenAI counts cached tokens inside input_tokens, so they are split out here.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const sig = require('./signals');

const outputText = (out) => (typeof out === 'string' ? out
  : Array.isArray(out) ? out.map((x) => x.text || '').join('\n') : out && typeof out === 'object' ? JSON.stringify(out) : '');

const ROOT = path.join(os.homedir(), '.codex', 'sessions');

function listFiles() {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 5) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(ROOT, 0);
  return out;
}

async function parseFile(file) {
  const events = [];
  let sid = path.basename(file, '.jsonl');
  const s = {
    tool: 'codex', project: null, entrypoint: null, branch: null,
    first: null, last: null, prompts: 0, tools: {}, skills: {}, agents: {}, subagentFiles: 0,
  };
  let model = 'codex';
  let prevTotal = null;
  let limits = null;
  // Older builds log user_message per turn, newer ones task_started; take whichever is present.
  let userMessages = 0;
  let tasks = 0;
  const sink = new sig.SignalSink('codex');
  const grader = new sig.TurnGrader(sink);
  const toolNames = new Map(); // call_id -> tool name

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!/"type":"(session_meta|turn_context|token_count|user_message|agent_message|task_started|function_call|custom_tool_call|function_call_output|custom_tool_call_output)"/.test(line)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    const ts = Date.parse(o.timestamp);
    if (Number.isFinite(ts)) {
      if (!s.first || ts < s.first) s.first = ts;
      if (!s.last || ts > s.last) s.last = ts;
    }
    if (o.type === 'session_meta') {
      sid = p.id || p.session_id || sid;
      s.project = p.cwd || s.project;
      s.entrypoint = p.originator || p.source || null;
      if (p.git && p.git.branch) s.branch = p.git.branch;
    } else if (o.type === 'turn_context') {
      if (p.model) model = p.model;
      if (p.cwd && !s.project) s.project = p.cwd;
    } else if (p.type === 'user_message') {
      userMessages++;
      const text = typeof p.message === 'string' ? p.message : '';
      if (text) grader.prompt(ts, sid, text);
      if (text && sig.isCorrection(text)) { sink.count(ts, 'corrections'); sink.event({ ts, sid, kind: 'correction', label: 'Correction prompt', text: sig.snippet(text, 0, 140) }); }
    } else if (p.type === 'agent_message') {
      grader.reply(typeof p.message === 'string' ? p.message : '');
    } else if (p.type === 'task_started') {
      tasks++;
      sink.count(ts, 'prompts');
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const name = p.name || 'tool';
      s.tools[name] = (s.tools[name] || 0) + 1;
      if (p.call_id) toolNames.set(p.call_id, name);
      sink.count(ts, 'calls');
      if (sig.isExternalTool(name)) sink.count(ts, 'external');
      const cmd = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : '';
      grader.toolInput(sid, cmd);
      for (const label of sig.scanRisky(cmd)) {
        sink.count(ts, 'risky');
        sink.event({ ts, sid, kind: 'risky', label, source: name, text: sig.snippet(cmd, 0, 140) });
      }
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const tool = toolNames.get(p.call_id) || 'tool';
      const text = outputText(p.output);
      grader.toolResult(sid, text);
      sink.count(ts, 'results');
      if (/^\s*Script failed|"exit_code":\s*[1-9]|Exit code:? [1-9]|Process exited with code [1-9]/.test(text)) {
        const [category, kind] = sig.classifyError(text, tool);
        sink.failure(ts, category, kind);
        sink.event({ ts, sid, kind: 'error', category, label: kind, source: tool, text: sig.snippet(text) });
      }
      const inj = text.length > 30 && sig.scanInjection(text);
      if (inj) {
        sink.count(ts, 'injLocal');
        sink.event({ ts, sid, kind: 'injection', label: inj.label, external: false, source: tool, text: sig.snippet(text, inj.at) });
      }
      for (const label of sig.scanSecrets(text)) {
        sink.count(ts, 'secrets');
        sink.event({ ts, sid, kind: 'secret', label, source: tool, text: `${label} appeared in ${tool} output` });
      }
    } else if (p.type === 'token_count') {
      if (p.rate_limits && Number.isFinite(ts)) limits = { ts, ...p.rate_limits };
      const info = p.info;
      if (!info) continue;
      const total = info.total_token_usage;
      let d = info.last_token_usage;
      if (total && prevTotal && total.total_tokens >= prevTotal.total_tokens) {
        if (total.total_tokens === prevTotal.total_tokens) continue; // repeated snapshot
        d = {};
        for (const k of Object.keys(total)) d[k] = (total[k] || 0) - (prevTotal[k] || 0);
      }
      if (total) prevTotal = total;
      if (!d) continue;
      const cached = d.cached_input_tokens || 0;
      events.push([ts, 'codex', sid, model, Math.max(0, (d.input_tokens || 0) - cached),
        d.output_tokens || 0, cached, d.cache_write_input_tokens || 0, 0, 0]);
    }
  }
  grader.close();
  s.prompts = Math.max(userMessages, tasks);
  // Signals were recorded before the session id was known; attach the final id.
  for (const e of sink.events) e.sid = sid;
  return { events, sessions: { [sid]: s }, limits, signals: sink.result() };
}

module.exports = { id: 'codex', listFiles, parseFile };
