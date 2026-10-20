// Parses OpenAI Codex rollouts (~/.codex/sessions/**/*.jsonl) into usage events.
// OpenAI counts cached tokens (and cache writes) inside input_tokens, so they are split out here.
const fs = require('fs');
const path = require('path');
const os = require('os');
const sig = require('./signals');
const { readLines } = require('./trace/lines');

const outputText = (out) =>
  typeof out === 'string'
    ? out
    : Array.isArray(out)
      ? out.map((x) => x.text || '').join('\n')
      : out && typeof out === 'object'
        ? JSON.stringify(out)
        : '';

// Older Codex shell results are JSON ({"output": "...", "metadata": {"exit_code": 2}}). The command's own output,
// with its exit code, is what classifyError reads, so a probe like `ls dist` is seen at the start of a line.
function shellOutput(text) {
  if (!text.startsWith('{"output"')) return text;
  try {
    const j = JSON.parse(text);
    if (typeof j.output !== 'string') return text;
    const code = j.metadata && j.metadata.exit_code;
    return Number.isInteger(code) ? `${j.output}\nExit code ${code}` : j.output;
  } catch {
    return text;
  }
}

const ROOT = path.join(os.homedir(), '.codex', 'sessions');

// A forked or spawned session starts by copying its parent's history, token counts included, with
// timestamps rewritten to the fork instant and written in one burst; the child's own first turn
// follows a real pause. Lines within this gap of the previous replayed line are the parent's.
const REPLAY_GAP_MS = 1000;

// Tools whose results come from the web (Codex names: web_search, web.run, fetch, server.fetch).
const isExternal = (name) =>
  sig.isExternalTool(name) ||
  /^(web([._-]?(search|fetch|run|open))?|fetch|browser[\w.-]*)$|(__|\.)(web_?search|web_?fetch|fetch)$/i.test(
    name || '',
  );

// The command a shell tool call runs. Codex passes JSON arguments such as
// {"command":["bash","-lc","sudo rm -rf x"]} or {"cmd":"ls"}; the shell script after -c/-lc is the
// command itself. Anything else is scanned as written.
function commandOf(raw) {
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    return raw;
  }
  const c = a && typeof a === 'object' ? (a.command ?? a.cmd) : null;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return raw;
  const parts = c.filter((x) => typeof x === 'string');
  const i = parts.findIndex((x) => /^-[a-z]*c$/.test(x));
  return i >= 0 && i < parts.length - 1 ? parts.slice(i + 1).join(' ') : parts.join(' ');
}

// The parent a session was forked or spawned from, if any.
function parentOf(p) {
  const spawn = p.source && typeof p.source === 'object' && p.source.subagent;
  const parent =
    p.forked_from_id ||
    (spawn && typeof spawn === 'object' && spawn.thread_spawn && spawn.thread_spawn.parent_thread_id);
  return typeof parent === 'string' && parent ? parent : null;
}

function listFiles() {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
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
    tool: 'codex',
    project: null,
    entrypoint: null,
    branch: null,
    first: null,
    last: null,
    prompts: 0,
    promptTs: [],
    turns: [], // [byteStart, ts] per turn, for the trace explorer; chosen after the loop
    forkedFrom: null,
    tools: {},
    skills: {},
    agents: {},
    subagentFiles: 0,
  };
  let model = 'codex';
  let prevTotal = null;
  let limits = null;
  // Older builds log user_message per turn, newer ones task_started; take whichever is present.
  const userMessageTs = [];
  const taskTs = [];
  const userTurns = []; // turn starts by user_message / by task_started; fork replay never reaches either
  const taskTurns = [];
  let userMessages = 0;
  let tasks = 0;
  let meta = false; // the first session_meta is this session's; later ones are copied from the parent
  let replay = null; // { edge } while a fork's copied history is being read
  let webSearches = 0; // web_search_call items since the last token count, billed per call
  const sink = new sig.SignalSink('codex');
  const grader = new sig.TurnGrader(sink);
  const toolNames = new Map(); // call_id -> tool name

  for await (const { text: line, start } of readLines(file)) {
    if (
      !/"type":"(session_meta|turn_context|token_count|user_message|agent_message|task_started|function_call|custom_tool_call|function_call_output|custom_tool_call_output|web_search_call)"/.test(
        line,
      )
    )
      continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload || {};
    const ts = Date.parse(o.timestamp);
    if (o.type === 'session_meta') {
      if (meta) continue;
      meta = true;
      sid = p.id || p.session_id || sid;
      s.project = p.cwd || s.project;
      s.entrypoint = p.originator || p.source || null;
      if (typeof s.entrypoint !== 'string') s.entrypoint = null;
      if (p.git && p.git.branch) s.branch = p.git.branch;
      const parent = parentOf(p);
      if (parent && parent !== sid) {
        s.forkedFrom = parent;
        replay = { edge: Number.isFinite(ts) ? ts : null };
      }
      if (Number.isFinite(ts)) s.first = s.last = ts;
      continue;
    }
    if (replay) {
      if (!Number.isFinite(ts)) {
        /* undated line inside the copied history */
      } else if (replay.edge === null || ts <= replay.edge + REPLAY_GAP_MS) {
        replay.edge = Math.max(replay.edge ?? ts, ts);
      } else replay = null;
    }
    if (replay) {
      // Copied history: keep the model and the cumulative baseline, count nothing.
      if (o.type === 'turn_context' && p.model) model = p.model;
      if (p.type === 'token_count' && p.info && p.info.total_token_usage) prevTotal = p.info.total_token_usage;
      continue;
    }
    if (Number.isFinite(ts)) {
      if (!s.first || ts < s.first) s.first = ts;
      if (!s.last || ts > s.last) s.last = ts;
    }
    if (o.type === 'turn_context') {
      if (p.model) model = p.model;
      if (p.cwd && !s.project) s.project = p.cwd;
    } else if (p.type === 'user_message') {
      userMessages++;
      userTurns.push([start, Number.isFinite(ts) ? ts : null]);
      if (Number.isFinite(ts)) userMessageTs.push(ts);
      const text = typeof p.message === 'string' ? p.message : '';
      if (text) grader.prompt(ts, sid, text);
      if (text && sig.isCorrection(text, { afterAssistant: grader.hasActed(sid) })) {
        sink.count(ts, 'corrections');
        sink.event({ ts, sid, kind: 'correction', label: 'Correction prompt', text: sig.snippet(text, 0, 140) });
      }
    } else if (p.type === 'agent_message') {
      grader.reply(typeof p.message === 'string' ? p.message : '');
    } else if (p.type === 'task_started') {
      tasks++;
      taskTurns.push([start, Number.isFinite(ts) ? ts : null]);
      if (Number.isFinite(ts)) taskTs.push(ts);
      sink.count(ts, 'prompts');
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const name = p.name || 'tool';
      s.tools[name] = (s.tools[name] || 0) + 1;
      if (p.call_id) toolNames.set(p.call_id, name);
      sink.count(ts, 'calls');
      if (isExternal(name)) sink.count(ts, 'external');
      const args = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : '';
      grader.toolInput(sid, args);
      const cmd = commandOf(args);
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
        // Only commands get here (an exit code), so a call whose name was not seen is a shell call too.
        const [category, kind] = sig.classifyError(shellOutput(text), toolNames.get(p.call_id) || 'shell');
        sink.failure(ts, category, kind);
        sink.event({ ts, sid, kind: 'error', category, label: kind, source: tool, text: sig.snippet(text) });
      }
      const inj = text.length > 30 && sig.scanInjection(text);
      if (inj) {
        const external = isExternal(tool);
        sink.count(ts, external ? 'injExternal' : 'injLocal');
        sink.event({
          ts,
          sid,
          kind: 'injection',
          label: inj.label,
          categories: inj.categories,
          external,
          source: tool,
          text: sig.snippet(text, inj.at),
        });
      }
      for (const label of sig.scanSecrets(text)) {
        sink.count(ts, 'secrets');
        sink.event({ ts, sid, kind: 'secret', label, source: tool, text: `${label} appeared in ${tool} output` });
      }
    } else if (p.type === 'web_search_call') {
      // Codex's built-in web search is a response item, not a function call.
      s.tools.web_search = (s.tools.web_search || 0) + 1;
      sink.count(ts, 'calls');
      sink.count(ts, 'external');
      webSearches++;
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
      const input = d.input_tokens || 0;
      const cached = Math.min(d.cached_input_tokens || 0, input);
      const written = Math.min(
        d.cache_write_input_tokens || d.cache_creation_input_tokens || d.cache_creation_tokens || 0,
        input - cached,
      );
      const row = [
        ts,
        'codex',
        sid,
        model,
        input - cached - written,
        d.output_tokens || 0,
        cached,
        written,
        0,
        0,
        null,
        null,
      ];
      if (webSearches) {
        row[11] = { ws: webSearches };
        webSearches = 0;
      }
      events.push(row);
    }
  }
  grader.close();
  s.prompts = Math.max(userMessages, tasks);
  // Same choice as the prompt count: user_message when present, else task_started (a log with both has one turn each)
  s.turns = userTurns.length ? userTurns : taskTurns;
  s.promptTs = userMessageTs.length >= taskTs.length ? userMessageTs : taskTs;
  // Signals were recorded before the session id was known; attach the final id.
  for (const e of sink.events) e.sid = sid;
  return { events, sessions: { [sid]: s }, limits, signals: sink.result() };
}

module.exports = { id: 'codex', ROOT, listFiles, parseFile, commandOf, shellOutput, isExternal };
