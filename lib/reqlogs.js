// Recent model requests and error traces from the tail of transcripts written in the last few
// hours, for the Logs page. Each request carries its stream of events (block types, sizes, tool
// names and targets) but never the text itself; error traces use the masked snippets of signals.js.
const path = require('path');
const sig = require('./signals');
const { tailLines, recentFiles, targetFor, zoneFor, CLAUDE_ROOT, CODEX_ROOT } = require('./office');

const WINDOW_MS = 3 * 3600 * 1000;
const MAX_FILES = 30;
const TAIL_BYTES = 1024 * 1024;

const textLen = (b) =>
  typeof b.text === 'string' ? b.text.length : typeof b.thinking === 'string' ? b.thinking.length : 0;
const resultText = (b) =>
  typeof b.content === 'string'
    ? b.content
    : Array.isArray(b.content)
      ? b.content.map((x) => x.text || '').join('\n')
      : '';
const promptText = (m) =>
  typeof m.content === 'string'
    ? m.content
    : ((Array.isArray(m.content) && m.content.find((b) => b.type === 'text')) || {}).text || '';

function parseClaude(file, agent) {
  const requests = [];
  const errors = [];
  const byMsg = new Map();
  const toolOf = new Map();
  let inputs = [];
  let inputTs = null;
  for (const line of tailLines(file, TAIL_BYTES)) {
    const isAssistant = line.includes('"type":"assistant"');
    if (!isAssistant && !line.includes('"type":"user"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (o.cwd && !agent.project) agent.project = path.basename(o.cwd);
    const m = o.message || {};
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (o.isApiErrorMessage) {
      errors.push({
        ts,
        kind: 'api',
        agent: agent.name(),
        tool: agent.tool, // 'claude' | 'codex': the topology draws it as a failed request to that tool's provider
        source: 'API',
        label: 'API error',
        text: sig.snippet(promptText(m), 0, 160),
      });
      continue;
    }
    if (!isAssistant) {
      // What feeds the next request: tool results and typed prompts (size only).
      if (inputTs === null || byMsg.size) {
        inputs = [];
        byMsg.clear();
      }
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue;
        const tool = toolOf.get(b.tool_use_id) || 'tool';
        const text = resultText(b);
        inputs.push({ type: 'tool_result', tool, ok: !b.is_error, size: text.length });
        if (b.is_error) {
          const [category, kind] = sig.classifyError(text, tool);
          errors.push({
            ts,
            kind: 'tool',
            agent: agent.name(),
            source: tool,
            label: kind,
            category,
            text: sig.snippet(text, 0, 160),
          });
          const req = requests.find((r) => r.blocks.some((x) => x.id === b.tool_use_id));
          if (req) req.toolErrors++;
        }
      }
      if (!o.isMeta && !o.isCompactSummary && m.role === 'user' && !blocks.some((b) => b.type === 'tool_result')) {
        const text = promptText(m);
        if (/^\s*\[Request interrupted/.test(text))
          errors.push({
            ts,
            kind: 'interrupt',
            agent: agent.name(),
            source: 'You',
            label: 'Interrupted',
            text: 'You stopped the model mid-turn',
          });
        else if (text.trim()) inputs.push({ type: o.isCompactSummary ? 'summary' : 'prompt', size: text.length });
      }
      inputTs = ts;
      continue;
    }
    if (!m.model || m.model === '<synthetic>') continue;
    const key = m.id || o.uuid;
    let r = byMsg.get(key);
    if (!r) {
      r = {
        id: `${agent.id}:${key}`,
        ts,
        end: ts,
        source: agent.tool,
        agentId: agent.id,
        kind: agent.kind,
        model: m.model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        ttftMs: inputTs ? ts - inputTs : null,
        durationMs: null,
        stop: null,
        inputs,
        blocks: [],
        toolErrors: 0,
      };
      byMsg.set(key, r);
      requests.push(r);
    }
    r.end = Math.max(r.end, ts);
    if (m.stop_reason) r.stop = m.stop_reason;
    const u = m.usage || {};
    if ((u.output_tokens || 0) >= r.output) {
      r.input = u.input_tokens || 0;
      r.output = u.output_tokens || 0;
      r.cacheRead = u.cache_read_input_tokens || 0;
      r.cacheWrite = u.cache_creation_input_tokens || 0;
    }
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        toolOf.set(b.id, b.name);
        r.blocks.push({
          ts,
          type: 'tool_use',
          id: b.id,
          tool: b.name,
          target: targetFor(b.name, b.input),
          zone: zoneFor(b.name),
        });
      } else if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking')
        r.blocks.push({ ts, type: b.type, size: textLen(b) });
    }
  }
  for (const r of requests) {
    r.durationMs = r.ttftMs != null ? r.end - r.ts + r.ttftMs : null;
    r.status =
      r.stop === 'refusal' ? 'refused' : r.stop === 'max_tokens' ? 'truncated' : r.toolErrors ? 'tool error' : 'ok';
    r.agent = agent.name();
    delete r.end;
  }
  return { requests, errors };
}

function parseCodex(file, agent) {
  const requests = [];
  const errors = [];
  let blocks = [];
  let inputs = [];
  let inputTs = null;
  let firstTs = null;
  let prevTotal = null;
  let model = 'codex';
  const toolOf = new Map();
  for (const line of tailLines(file, TAIL_BYTES)) {
    if (
      !/"type":"(turn_context|token_count|user_message|function_call|custom_tool_call|function_call_output|custom_tool_call_output|reasoning|message|session_meta)"/.test(
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
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    const p = o.payload || {};
    if (o.type === 'session_meta' && p.cwd) agent.project = path.basename(p.cwd);
    if (o.type === 'turn_context' && p.model) model = p.model;
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      firstTs = firstTs || ts;
      toolOf.set(p.call_id, p.name);
      blocks.push({ ts, type: 'tool_use', tool: p.name, target: '', zone: zoneFor(p.name) });
    } else if (
      p.type === 'reasoning' ||
      (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant')
    ) {
      firstTs = firstTs || ts;
      blocks.push({ ts, type: p.type === 'reasoning' ? 'thinking' : 'text', size: 0 });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
      const failed = /"exit_code":\s*[1-9]|Process exited with code [1-9]/.test(out);
      inputs.push({ type: 'tool_result', tool: toolOf.get(p.call_id) || 'tool', ok: !failed, size: out.length });
      if (failed)
        errors.push({
          ts,
          kind: 'tool',
          agent: agent.name(),
          source: toolOf.get(p.call_id) || 'tool',
          label: 'Command failed',
          text: sig.snippet(out, 0, 160),
        });
      inputTs = ts;
    } else if (p.type === 'user_message') {
      inputs.push({ type: 'prompt', size: (p.message || '').length });
      inputTs = ts;
    } else if (p.type === 'token_count' && p.info) {
      const tot = p.info.total_token_usage;
      let d = p.info.last_token_usage;
      if (tot && prevTotal) {
        if (tot.total_tokens === prevTotal.total_tokens) continue;
        d = {};
        for (const k of Object.keys(tot)) d[k] = (tot[k] || 0) - (prevTotal[k] || 0);
      }
      if (tot) prevTotal = tot;
      if (!d || !firstTs) continue;
      requests.push({
        id: `${agent.id}:${ts}`,
        ts: firstTs,
        source: 'codex',
        agentId: agent.id,
        kind: 'session',
        agent: agent.name(),
        model,
        input: Math.max(0, (d.input_tokens || 0) - (d.cached_input_tokens || 0)),
        output: d.output_tokens || 0,
        cacheRead: d.cached_input_tokens || 0,
        cacheWrite: 0,
        ttftMs: inputTs ? firstTs - inputTs : null,
        durationMs: inputTs ? ts - inputTs : null,
        stop: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        inputs,
        blocks,
        toolErrors: 0,
        status: 'ok',
      });
      blocks = [];
      inputs = [];
      firstTs = null;
    }
  }
  return { requests, errors };
}

function logs(now = Date.now()) {
  const files = [...recentFiles(CLAUDE_ROOT, 4, now - WINDOW_MS), ...recentFiles(CODEX_ROOT, 4, now - WINDOW_MS)]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES);
  const requests = [];
  const errors = [];
  const projects = {};
  for (const { file } of files) {
    const isCodex = file.startsWith(CODEX_ROOT);
    const parts = path.relative(isCodex ? CODEX_ROOT : CLAUDE_ROOT, file).split(path.sep);
    const sub = parts.includes('subagents');
    const id = isCodex
      ? `codex:${path.basename(file, '.jsonl')}`
      : sub
        ? `claude:${parts[parts.indexOf('subagents') - 1]}:${path.basename(file, '.jsonl')}`
        : `claude:${path.basename(file, '.jsonl')}`;
    let agentType = '';
    if (sub) {
      try {
        agentType =
          JSON.parse(require('fs').readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || '';
      } catch {
        /* older builds */
      }
    }
    const agent = {
      id,
      tool: isCodex ? 'codex' : 'claude',
      kind: sub ? 'subagent' : 'session',
      project: '',
      name() {
        return sub ? agentType || 'subagent' : this.project || 'session';
      },
    };
    const r = isCodex ? parseCodex(file, agent) : parseClaude(file, agent);
    projects[id] = agent.project;
    for (const x of r.requests) if (now - x.ts < WINDOW_MS) requests.push(x);
    for (const x of r.errors) if (now - x.ts < WINDOW_MS) errors.push(x);
  }
  requests.sort((a, b) => b.ts - a.ts);
  errors.sort((a, b) => b.ts - a.ts);
  return { ts: now, windowMs: WINDOW_MS, requests: requests.slice(0, 400), errors: errors.slice(0, 150) };
}

module.exports = { logs };

// Synthetic requests and errors for DEMO=1, shaped like logs().
function demoLogs(now = Date.now()) {
  let seed = Math.floor(now / 5000);
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const agents = [
    ['claude:demo-1', 'acme-web', 'claude-opus-5-5', 'session'],
    ['claude:demo-1:a1', 'code-reviewer', 'claude-haiku-5', 'subagent'],
    ['claude:demo-2', 'data-pipeline', 'claude-sonnet-5', 'session'],
    ['codex:demo-5', 'design-system', 'gpt-5.6-sol', 'session'],
  ];
  const tools = [
    ['Read', 'app.js'],
    ['Edit', 'styles.css'],
    ['Bash', 'npm'],
    ['Grep', ''],
    ['WebFetch', 'developer.mozilla.org'],
    ['Write', 'README.md'],
  ];
  const requests = Array.from({ length: 120 }, (_, i) => {
    const [id, name, model, kind] = agents[i % agents.length];
    const [tool, target] = tools[Math.floor(r() * tools.length)];
    const ts = now - i * 45000 - Math.floor(r() * 20000);
    const ttft = 600 + Math.floor(r() * 5000);
    const err = r() < 0.06;
    return {
      id: `${id}:${i}`,
      ts,
      source: id.split(':')[0],
      agentId: id,
      kind,
      agent: name,
      model,
      input: Math.floor(r() * 40),
      output: 20 + Math.floor(r() * 1800),
      cacheRead: 40000 + Math.floor(r() * 160000),
      cacheWrite: Math.floor(r() * 3000),
      ttftMs: ttft,
      durationMs: ttft + Math.floor(r() * 9000),
      stop: r() < 0.8 ? 'tool_use' : 'end_turn',
      inputs: [{ type: i % 7 ? 'tool_result' : 'prompt', tool: 'Bash', ok: true, size: 200 + Math.floor(r() * 4000) }],
      blocks: [
        { ts, type: 'thinking', size: 300 + Math.floor(r() * 2000) },
        { ts, type: 'text', size: 80 + Math.floor(r() * 400) },
        { ts, type: 'tool_use', tool, target, zone: zoneFor(tool) },
      ],
      toolErrors: err ? 1 : 0,
      status: err ? 'tool error' : 'ok',
    };
  });
  const errors = requests
    .filter((x) => x.toolErrors)
    .map((x) => ({
      ts: x.ts + 1500,
      kind: 'tool',
      agent: x.agent,
      source: 'Bash',
      label: 'Command or test failed',
      category: 'model',
      text: 'Exit code 1 · npm ERR! Test failed. See above for more details.',
    }));
  errors.push({
    ts: now - 26 * 60000,
    kind: 'api',
    agent: 'data-pipeline',
    tool: 'claude',
    source: 'API',
    label: 'API error',
    text: 'API Error: 529 Overloaded · retrying in 4s',
  });
  return { ts: now, windowMs: WINDOW_MS, requests, errors: errors.sort((a, b) => b.ts - a.ts) };
}

module.exports.demoLogs = demoLogs;
