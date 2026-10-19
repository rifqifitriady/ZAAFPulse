// Parses Claude Code transcripts (~/.claude/projects/**/*.jsonl) into usage events and
// quality/safety signals. Only counts, metadata and short masked snippets of flagged
// items are kept; full message text never leaves this module.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const sig = require('./signals');

const ROOT = path.join(os.homedir(), '.claude', 'projects');

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
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(ROOT, 0);
  return out;
}

function projectFromDir(file) {
  const rel = path.relative(ROOT, file).split(path.sep)[0] || '';
  return rel.replace(/^-/, '/').replace(/-/g, '/');
}

// A prompt the person typed, not a system-injected user turn.
const INJECTED = /^\s*(<task-notification>|<local-command|\[Request interrupted|Caveat:)/;
const userText = (m) =>
  typeof m.content === 'string'
    ? m.content
    : ((Array.isArray(m.content) && m.content.find((b) => b.type === 'text')) || {}).text || '';
function isTypedPrompt(o) {
  const m = o.message;
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly || !m || m.role !== 'user') return false;
  const text = userText(m);
  return text.trim() !== '' && !INJECTED.test(text);
}
const resultText = (b) =>
  typeof b.content === 'string'
    ? b.content
    : Array.isArray(b.content)
      ? b.content.map((x) => x.text || '').join('\n')
      : '';

async function parseFile(file) {
  const isSub = file.includes(`${path.sep}subagents${path.sep}`);
  const byMsg = new Map(); // message id -> event row (streamed blocks repeat usage)
  const sessions = {};
  const fallbackSession = path.basename(file, '.jsonl');

  const session = (id) =>
    (sessions[id] ||= {
      tool: 'claude',
      project: null,
      entrypoint: null,
      branch: null,
      first: null,
      last: null,
      prompts: 0,
      tools: {},
      skills: {},
      agents: {},
      subagentFiles: 0,
    });

  const sink = new sig.SignalSink('claude');
  const grader = new sig.TurnGrader(sink);
  const toolNames = new Map(); // tool_use id -> tool name, to attribute results
  const seenUse = new Set();
  let lastSig = null;
  let repeat = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const isAssistant = line.includes('"type":"assistant"');
    const isUser = !isAssistant && line.includes('"type":"user"');
    if (!isAssistant && !isUser) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const sid = o.sessionId || fallbackSession;
    const s = session(sid);
    const ts = Date.parse(o.timestamp);
    if (Number.isFinite(ts)) {
      if (!s.first || ts < s.first) s.first = ts;
      if (!s.last || ts > s.last) s.last = ts;
    }
    if (o.cwd && !s.project) s.project = o.cwd;
    if (o.entrypoint && !s.entrypoint) s.entrypoint = o.entrypoint;
    if (o.gitBranch && !s.branch) s.branch = o.gitBranch;

    const isResult =
      isUser &&
      o.message &&
      Array.isArray(o.message.content) &&
      o.message.content.some((b) => b.type === 'tool_result');
    if (isResult) {
      for (const b of Array.isArray(o.message && o.message.content) ? o.message.content : []) {
        if (b.type !== 'tool_result') continue;
        const tool = toolNames.get(b.tool_use_id) || 'unknown';
        const text = resultText(b);
        grader.toolResult(sid, text);
        sink.count(ts, 'results');
        if (b.is_error) {
          const [category, kind] = sig.classifyError(text, tool);
          sink.failure(ts, category, kind);
          sink.event({ ts, sid, kind: 'error', category, label: kind, source: tool, text: sig.snippet(text) });
        }
        if (text.length > 30) {
          const inj = sig.scanInjection(text);
          if (inj) {
            const external = sig.isExternalTool(tool);
            sink.count(ts, external ? 'injExternal' : 'injLocal');
            sink.event({
              ts,
              sid,
              kind: 'injection',
              label: inj.label,
              external,
              source: tool,
              text: sig.snippet(text, inj.at),
            });
          }
          for (const label of sig.scanSecrets(text)) {
            sink.count(ts, 'secrets');
            sink.event({ ts, sid, kind: 'secret', label, source: tool, text: `${label} appeared in ${tool} output` });
          }
        }
      }
      continue;
    }

    if (isUser) {
      if (o.isCompactSummary) {
        sink.count(ts, 'compactions');
        sink.event({
          ts,
          sid,
          kind: 'compaction',
          label: 'Context compacted',
          text: 'The conversation filled its context window and was summarised.',
        });
      }
      const text = o.message ? userText(o.message) : '';
      if (/^\s*\[Request interrupted by user/.test(text)) {
        sink.count(ts, 'interrupts');
        sink.event({ ts, sid, kind: 'interrupt', label: 'You interrupted', text: 'Stopped the model mid-turn' });
      }
      if (isTypedPrompt(o)) grader.prompt(ts, sid, text);
      if (!isSub && isTypedPrompt(o)) {
        s.prompts++;
        sink.count(ts, 'prompts');
        if (sig.isCorrection(text)) {
          sink.count(ts, 'corrections');
          sink.event({ ts, sid, kind: 'correction', label: 'Correction prompt', text: sig.snippet(text, 0, 140) });
        }
      }
      continue;
    }

    const m = o.message;
    if (o.isApiErrorMessage) {
      sink.count(ts, 'apiErrors');
      sink.event({ ts, sid, kind: 'apiError', label: 'API error', text: sig.snippet(m ? userText(m) : '', 0, 140) });
      continue;
    }
    if (!m || !m.usage || !m.model || m.model === '<synthetic>') continue;
    if (m.stop_reason === 'refusal') {
      sink.count(ts, 'refusals');
      sink.event({ ts, sid, kind: 'refusal', label: 'Model refused', text: m.model });
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'text' && b.text) {
        const k = `${m.id}:${b.text.length}:${b.text.slice(0, 40)}`;
        if (!seenUse.has(k)) {
          seenUse.add(k);
          grader.reply(b.text);
        }
      }
      if (b.type !== 'tool_use' || seenUse.has(b.id)) continue;
      grader.toolInput(sid, JSON.stringify(b.input || {}));
      seenUse.add(b.id);
      toolNames.set(b.id, b.name);
      sink.count(ts, 'calls');
      if (sig.isExternalTool(b.name)) sink.count(ts, 'external');
      const sigKey = b.name + JSON.stringify(b.input || {});
      repeat = sigKey === lastSig ? repeat + 1 : 0;
      lastSig = sigKey;
      if (repeat === 2) {
        sink.count(ts, 'loops');
        sink.event({
          ts,
          sid,
          kind: 'loop',
          label: 'Repeated identical call',
          source: b.name,
          text: `${b.name} called 3+ times in a row with the same input`,
        });
      }
      if (b.name === 'Bash' && b.input && typeof b.input.command === 'string') {
        for (const label of sig.scanRisky(b.input.command)) {
          sink.count(ts, 'risky');
          sink.event({ ts, sid, kind: 'risky', label, source: 'Bash', text: sig.snippet(b.input.command, 0, 140) });
        }
      }
      s.tools[b.name] = (s.tools[b.name] || 0) + 1;
      if (b.name === 'Skill' && b.input && b.input.skill) s.skills[b.input.skill] = (s.skills[b.input.skill] || 0) + 1;
      if ((b.name === 'Agent' || b.name === 'Task') && b.input) {
        const a = b.input.subagent_type || 'general-purpose';
        s.agents[a] = (s.agents[a] || 0) + 1;
      }
    }
    const u = m.usage;
    const cw1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
    const cw5m =
      u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens != null
        ? u.cache_creation.ephemeral_5m_input_tokens
        : Math.max(0, (u.cache_creation_input_tokens || 0) - cw1h);
    const key = (m.id || o.uuid) + (o.requestId || '');
    const row = [
      ts,
      'claude',
      sid,
      m.model,
      u.input_tokens || 0,
      u.output_tokens || 0,
      u.cache_read_input_tokens || 0,
      cw5m,
      cw1h,
      isSub ? 1 : 0,
    ];
    const prev = byMsg.get(key);
    if (!prev || row[5] >= prev[5]) byMsg.set(key, row);
  }

  grader.close();
  for (const s of Object.values(sessions)) {
    if (!s.project) s.project = projectFromDir(file);
    if (isSub) s.subagentFiles = 1;
  }
  return { events: [...byMsg.values()], sessions, limits: null, signals: sink.result() };
}

module.exports = { id: 'claude', listFiles, parseFile };
