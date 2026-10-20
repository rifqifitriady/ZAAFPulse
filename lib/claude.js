// Parses Claude Code transcripts (~/.claude/projects/**/*.jsonl) into usage events and
// quality/safety signals. Only counts, metadata and short masked snippets of flagged
// items are kept; full message text never leaves this module.
const fs = require('fs');
const path = require('path');
const os = require('os');
const sig = require('./signals');
const { readLines } = require('./trace/lines');

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

// Dedup key for one API response, shared by every copy of it: Claude Code writes a line per content
// block with the same message id, and resumed or forked sessions copy earlier lines into a new file.
// Message id + request id identify a response across files. Without a request id, a real Anthropic id
// (msg_…) is still unique per response but only trusted within its session; any other id (gateways can
// reuse one for every response) is also scoped to its timestamp. No message id: no dedup.
function usageKey(msgId, requestId, sid, ts) {
  if (!msgId) return null;
  if (requestId) return `${msgId}:${requestId}`;
  return msgId.startsWith('msg_') ? `${msgId}:@${sid}` : `${msgId}:@${sid}:${ts}`;
}

// Event extras the pricer needs (web searches, US-only inference), or null for the common case.
function usageExtra(u) {
  const ws = (u.server_tool_use && Number(u.server_tool_use.web_search_requests)) || 0;
  const geo = u.inference_geo === 'us' ? 'us' : null;
  if (!ws && !geo) return null;
  const x = {};
  if (ws) x.ws = ws;
  if (geo) x.geo = geo;
  return x;
}

// Cache writes split into 5-minute and 1-hour parts.
function cacheWrites(u) {
  const cw1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
  const cw5m =
    u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens != null
      ? u.cache_creation.ephemeral_5m_input_tokens
      : Math.max(0, (u.cache_creation_input_tokens || 0) - cw1h);
  return [cw5m, cw1h];
}

// The numbers one assistant message contributes to a usage row, so the trace explorer prices a chat
// span exactly as the parser prices the row. `model` carries the "-fast" suffix the pricer keys on.
function usageOf(m) {
  const u = (m && m.usage) || {};
  const [cw5m, cw1h] = cacheWrites(u);
  return {
    model: u.speed === 'fast' ? `${m.model}-fast` : m.model,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cw5m,
    cw1h,
    extra: usageExtra(u),
  };
}

async function parseFile(file) {
  const isSub = file.includes(`${path.sep}subagents${path.sep}`);
  const byMsg = new Map(); // usage key -> event row (streamed blocks repeat usage)
  const rows = []; // rows without a key are kept as they are
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
      promptTs: [], // when each typed prompt was sent, so a range counts only its own prompts
      tools: {},
      skills: {},
      agents: {},
      subagentFiles: 0,
      turns: [], // [byteStart, ts] per typed prompt, so the explorer can read one turn by range
      agentLinks: [], // tool_use id -> subagent id, from the tool_result that carries toolUseResult.agentId
    });

  const sink = new sig.SignalSink('claude');
  const grader = new sig.TurnGrader(sink);
  const toolNames = new Map(); // tool_use id -> tool name, to attribute results
  const seenUse = new Set();
  let lastSig = null;
  let repeat = 0;

  for await (const { text: line, start } of readLines(file)) {
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
      const link = o.toolUseResult && typeof o.toolUseResult === 'object' && o.toolUseResult.agentId;
      if (link) {
        const tu = o.message.content.find((b) => b.type === 'tool_result' && b.tool_use_id);
        if (tu) s.agentLinks.push({ toolUseId: tu.tool_use_id, agentId: String(link) });
      }
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
        s.turns.push([start, Number.isFinite(ts) ? ts : null]);
        if (Number.isFinite(ts)) s.promptTs.push(ts);
        sink.count(ts, 'prompts');
        if (sig.isCorrection(text, { afterAssistant: grader.hasActed(sid) })) {
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
    const g = usageOf(m);
    const key = usageKey(m.id, o.requestId, sid, ts);
    const sub = isSub ? 1 : 0;
    // Fast mode bills at premium rates, priced under "<model>-fast" (see usageOf).
    const row = [ts, 'claude', sid, g.model, g.input, g.output, g.cacheRead, g.cw5m, g.cw1h, sub, key, g.extra];
    if (!key) rows.push(row);
    else {
      const prev = byMsg.get(key);
      if (!prev || row[5] >= prev[5]) byMsg.set(key, row);
    }
    // An advisor model consulted during the turn reports its own usage in usage.iterations; the
    // message's own usage does not include it, so each advisor iteration is a separate request.
    const iters = Array.isArray(u.iterations) ? u.iterations : [];
    iters.forEach((it, i) => {
      if (!it || it.type !== 'advisor_message' || typeof it.model !== 'string' || !it.model) return;
      const [a5m, a1h] = cacheWrites(it);
      const akey = m.id ? usageKey(`${m.id}:advisor:${i}`, o.requestId, sid, ts) : null;
      const arow = [
        ts,
        'claude',
        sid,
        it.model,
        it.input_tokens || 0,
        it.output_tokens || 0,
        it.cache_read_input_tokens || 0,
        a5m,
        a1h,
        sub,
        akey,
        usageExtra(it),
      ];
      if (!akey) rows.push(arow);
      else {
        const prev = byMsg.get(akey);
        if (!prev || arow[5] >= prev[5]) byMsg.set(akey, arow);
      }
    });
  }

  grader.close();
  for (const s of Object.values(sessions)) {
    if (!s.project) s.project = projectFromDir(file);
    if (isSub) {
      s.subagentFiles = 1;
      s.agentId = path.basename(file, '.jsonl').replace(/^agent-/, '');
    }
  }
  return { events: [...byMsg.values(), ...rows], sessions, limits: null, signals: sink.result() };
}

module.exports = { id: 'claude', listFiles, parseFile, usageKey, usageOf };
