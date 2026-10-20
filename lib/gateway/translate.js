// Format translation for the gateway. OpenAI Chat Completions is the pivot: requests in the Anthropic
// Messages, OpenAI Responses or Gemini formats become chat requests, the answer (whole or streamed) is
// turned back into the caller's format, and providers that speak Anthropic natively get their requests
// translated the other way. So Claude Code (/v1/messages), Codex (/v1/responses) and Gemini CLI
// (/v1beta/models/*) can use any provider. Nothing here impersonates a client: no injected system
// prompts, no fake headers, and usage is reported exactly as the provider counted it.
const crypto = require('crypto');

const rid = (p) => `${p}${crypto.randomBytes(12).toString('hex')}`;
const json = (s, fallback = {}) => {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s || '{}');
  } catch {
    return fallback;
  }
};
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
// Symbol keys survive object spread but never reach JSON.stringify, so they ride along on a translated
// request without being sent. SOFT lists fields the gateway added that a target may not accept (the
// caller drops them per provider); DROPPED lists request features nothing upstream can serve.
const SOFT = Symbol.for('zaafpulse.softFields');
const DROPPED = Symbol.for('zaafpulse.dropped');
const tag = (body, soft, dropped) => {
  if (soft.length) body[SOFT] = soft;
  body[DROPPED] = dropped;
  return body;
};
// A request the gateway cannot translate faithfully: 400, not a silent change.
const bad = (message) => Object.assign(new Error(message), { status: 400, type: 'invalid_request_error' });
// Anthropic thinking budget ↔ OpenAI reasoning effort. Anthropic needs at least 1024 thinking tokens.
const EFFORT_BUDGET = { low: 2048, medium: 8192, high: 16384, xhigh: 32000 };
const effortOfBudget = (n) => (n < 4096 ? 'low' : n < 16384 ? 'medium' : 'high');
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
      : '';

// finish_reason ↔ stop_reason ↔ Gemini finishReason
const TO_ANTHROPIC_STOP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};
const FROM_ANTHROPIC_STOP = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};
const TO_GEMINI_FINISH = { stop: 'STOP', length: 'MAX_TOKENS', tool_calls: 'STOP', content_filter: 'SAFETY' };

// OpenAI usage → the numbers each format reports. Anthropic input_tokens excludes cache reads.
function usageParts(u = {}) {
  const prompt = u.prompt_tokens || 0;
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    prompt,
    cached,
    output: u.completion_tokens || 0,
    reasoning: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
  };
}

/* ======================= Anthropic Messages → OpenAI chat ======================= */
function imageUrlOf(block) {
  const s = block.source || {};
  return s.type === 'base64' ? `data:${s.media_type};base64,${s.data}` : s.url || '';
}
// Anthropic-defined client tools have a fixed schema; the client still runs them, so any model can call them.
const ANTHROPIC_CLIENT_TOOLS = [
  {
    match: /^bash_\d+/,
    description: 'Run a shell command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, restart: { type: 'boolean' } },
    },
  },
  {
    match: /^text_editor_\d+/,
    description: 'View, create and edit files: commands view, create, str_replace and insert.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'undo_edit'] },
        path: { type: 'string' },
        file_text: { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        insert_line: { type: 'integer' },
        insert_text: { type: 'string' },
        view_range: { type: 'array', items: { type: 'integer' } },
      },
      required: ['command', 'path'],
    },
  },
];
function anthropicToOpenAI(b) {
  const messages = [];
  const dropped = [];
  const system =
    typeof b.system === 'string'
      ? b.system
      : Array.isArray(b.system)
        ? b.system.map((x) => x.text || '').join('\n\n')
        : '';
  if (system) messages.push({ role: 'system', content: system });
  for (const m of b.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      const text = blocks
        .filter((x) => x.type === 'text')
        .map((x) => x.text)
        .join('');
      // Server tool calls (web search, code execution) ran at Anthropic and have no tool result in this
      // history; as function calls they would be left unanswered, which OpenAI rejects.
      const calls = blocks
        .filter((x) => x.type === 'tool_use')
        .map((x) => ({
          id: x.id,
          type: 'function',
          function: { name: x.name, arguments: JSON.stringify(x.input || {}) },
        }));
      messages.push({
        role: 'assistant',
        content: text || (calls.length ? null : ''),
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    // A user turn: tool results first (they answer the previous assistant turn), then the rest. A chat
    // tool message holds text only, so images from a tool result go into the user message that follows.
    const images = [];
    const parts = [];
    for (const x of blocks) {
      if (x.type === 'tool_result') {
        const items = typeof x.content === 'string' ? [{ type: 'text', text: x.content }] : x.content || [];
        const out = items
          .map((c) => {
            if (c.type === 'text') return c.text;
            if (c.type !== 'image') return '';
            images.push({ type: 'image_url', image_url: { url: imageUrlOf(c) } });
            return '[image: attached to the next user message]';
          })
          .join('\n');
        messages.push({ role: 'tool', tool_call_id: x.tool_use_id, content: x.is_error ? `[error] ${out}` : out });
      } else if (x.type === 'text') parts.push({ type: 'text', text: x.text });
      else if (x.type === 'image') parts.push({ type: 'image_url', image_url: { url: imageUrlOf(x) } });
      else if (x.type === 'document' && x.source && x.source.type === 'text')
        parts.push({ type: 'text', text: x.source.data || '' });
    }
    parts.unshift(...images);
    if (parts.length)
      messages.push({
        role: 'user',
        content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts,
      });
  }
  const tools = [];
  for (const t of b.tools || []) {
    const fixed = t.type && ANTHROPIC_CLIENT_TOOLS.find((x) => x.match.test(t.type));
    if (t.input_schema || t.type === 'custom' || !t.type)
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      });
    else if (fixed)
      tools.push({
        type: 'function',
        function: { name: t.name, description: fixed.description, parameters: fixed.parameters },
      });
    // Server tools (web search, web fetch, code execution) and computer use run inside Anthropic's API.
    else dropped.push(`tool ${t.name || t.type}`);
  }
  const tc = b.tool_choice;
  if (
    tc &&
    tc.type === 'tool' &&
    (b.tools || []).some((t) => t.name === tc.name && !tools.some((f) => f.function.name === t.name))
  )
    throw bad(`tool_choice names "${tc.name}", a tool only Anthropic's own API can run`);
  const toolChoice = !tc
    ? undefined
    : tc.type === 'any'
      ? 'required'
      : tc.type === 'tool'
        ? { type: 'function', function: { name: tc.name } }
        : tc.type === 'none'
          ? 'none'
          : 'auto';
  // Extended thinking and effort → reasoning_effort, sent only to models known to take it (SOFT).
  const oc = b.output_config || {};
  const th = b.thinking || {};
  let effort =
    th.type === 'enabled' ? effortOfBudget(Number(th.budget_tokens) || 0) : th.type === 'adaptive' ? 'medium' : null;
  if (oc.effort) effort = oc.effort === 'max' || oc.effort === 'xhigh' ? 'high' : oc.effort;
  if (effort && !EFFORTS.has(effort)) effort = null;
  const format =
    oc.format && oc.format.type === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: 'output', schema: oc.format.schema || {}, strict: true } }
      : null;
  return tag(
    {
      model: b.model,
      messages,
      ...(b.max_tokens ? { max_tokens: b.max_tokens } : {}),
      ...(b.temperature != null ? { temperature: b.temperature } : {}),
      ...(b.top_p != null ? { top_p: b.top_p } : {}),
      ...(b.stop_sequences && b.stop_sequences.length ? { stop: b.stop_sequences } : {}),
      ...(tools.length ? { tools } : {}),
      ...(tools.length && toolChoice ? { tool_choice: toolChoice } : {}),
      ...(tools.length && tc && tc.disable_parallel_tool_use ? { parallel_tool_calls: false } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(format ? { response_format: format } : {}),
      stream: !!b.stream,
    },
    effort ? ['reasoning_effort'] : [],
    dropped,
  );
}

function openAIToAnthropic(j, model) {
  const choice = (j.choices && j.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: textOf(msg.content) });
  for (const tc of msg.tool_calls || [])
    content.push({
      type: 'tool_use',
      id: tc.id || rid('toolu_'),
      name: tc.function.name,
      input: json(tc.function.arguments),
    });
  const u = usageParts(j.usage);
  return {
    id: rid('msg_'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: TO_ANTHROPIC_STOP[choice.finish_reason] || ((msg.tool_calls || []).length ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, u.prompt - u.cached),
      output_tokens: u.output,
      cache_read_input_tokens: u.cached,
      cache_creation_input_tokens: 0,
    },
  };
}

// OpenAI chunks → Anthropic SSE events. push(chunk) and finish() return strings to write.
function anthropicStream(model) {
  let started = false;
  let open = null;
  let index = -1;
  let stop = null;
  let usage = {};
  const tools = new Map();
  const id = rid('msg_');
  const out = [];
  const start = () => {
    if (started) return;
    started = true;
    out.push(
      sse('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      sse('ping', { type: 'ping' }),
    );
  };
  const close = () => {
    if (open) {
      out.push(sse('content_block_stop', { type: 'content_block_stop', index }));
      open = null;
    }
  };
  const drain = () => out.splice(0).join('');
  return {
    push(c) {
      start();
      if (c.usage) usage = c.usage;
      const ch = c.choices && c.choices[0];
      if (!ch) return drain();
      const d = ch.delta || {};
      if (d.content) {
        if (!open || open.type !== 'text') {
          close();
          index++;
          open = { type: 'text' };
          out.push(
            sse('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'text', text: '' },
            }),
          );
        }
        out.push(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: d.content },
          }),
        );
      }
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? 0;
        // A new id at a known index is a new call: some providers send parallel calls all at index 0.
        if (!tools.has(k) || (tc.id && tools.get(k).up && tools.get(k).up !== tc.id)) {
          close();
          index++;
          const t = { id: tc.id || rid('toolu_'), up: tc.id, index };
          tools.set(k, t);
          open = { type: 'tool', k };
          out.push(
            sse('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'tool_use', id: t.id, name: (tc.function && tc.function.name) || '', input: {} },
            }),
          );
        }
        const args = tc.function && tc.function.arguments;
        if (args)
          out.push(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: tools.get(k).index,
              delta: { type: 'input_json_delta', partial_json: args },
            }),
          );
      }
      if (ch.finish_reason) stop = ch.finish_reason;
      return drain();
    },
    finish() {
      start();
      close();
      const u = usageParts(usage);
      out.push(
        sse('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: TO_ANTHROPIC_STOP[stop] || (tools.size ? 'tool_use' : 'end_turn'),
            stop_sequence: null,
          },
          usage: {
            input_tokens: Math.max(0, u.prompt - u.cached),
            output_tokens: u.output,
            cache_read_input_tokens: u.cached,
          },
        }),
        sse('message_stop', { type: 'message_stop' }),
      );
      return drain();
    },
    ping: () => sse('ping', { type: 'ping' }),
    error: (message) => sse('error', { type: 'error', error: { type: 'api_error', message } }),
  };
}

/* ======================= OpenAI chat → Anthropic Messages (native providers) ======================= */
function imageBlockOf(url) {
  const mm = String(url || '').match(/^data:([^;]+);base64,(.*)$/);
  return mm
    ? { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } }
    : { type: 'image', source: { type: 'url', url } };
}
// OpenAI content (a string or parts) → Anthropic text and image blocks.
function blocksOf(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url') out.push(imageBlockOf((p.image_url && p.image_url.url) || ''));
  }
  return out;
}
function openAIToAnthropicRequest(b) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of b.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      // Anthropic tool results take images as well as text.
      const blocks = blocksOf(m.content);
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: blocks.some((x) => x.type === 'image') ? blocks : textOf(m.content),
        },
      ]);
      continue;
    }
    const blocks = blocksOf(m.content);
    if (m.role === 'assistant')
      for (const tc of m.tool_calls || [])
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: json(tc.function.arguments) });
    if (blocks.length) push(m.role === 'assistant' ? 'assistant' : 'user', blocks);
  }
  const tools = (b.tools || [])
    .filter((t) => t.type === 'function')
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
  const tc = b.tool_choice;
  let toolChoice =
    tc === 'required'
      ? { type: 'any' }
      : tc === 'none'
        ? { type: 'none' }
        : tc && tc.function
          ? { type: 'tool', name: tc.function.name }
          : tc === 'auto'
            ? { type: 'auto' }
            : undefined;
  if (tools.length && b.parallel_tool_calls === false && (!toolChoice || toolChoice.type !== 'none'))
    toolChoice = { ...(toolChoice || { type: 'auto' }), disable_parallel_tool_use: true };
  // Structured output: json_schema maps to output_config.format. Anthropic has no schema-less JSON mode.
  const rf = b.response_format;
  let outputFormat = null;
  if (rf && rf.type === 'json_object')
    throw bad('response_format json_object is not supported by Anthropic providers; send a json_schema');
  if (rf && rf.type === 'json_schema') {
    const schema = rf.json_schema && rf.json_schema.schema;
    if (!schema || typeof schema !== 'object') throw bad('response_format json_schema needs json_schema.schema');
    outputFormat = { type: 'json_schema', schema };
  }
  const requested = b.max_completion_tokens || b.max_tokens;
  let maxTokens = requested || 8192;
  // reasoning_effort → an extended-thinking budget. Anthropic rejects thinking with a forced tool, and a
  // tool loop in progress would need the earlier thinking blocks (with signatures) that chat history cannot
  // carry, so thinking is left off in those cases.
  const last = messages[messages.length - 1];
  const inToolLoop =
    last && last.role === 'user' && last.content.some((x) => x.type === 'tool_result') && messages.length > 1;
  let thinking = null;
  const budget = EFFORT_BUDGET[b.reasoning_effort];
  if (budget && !inToolLoop && (!toolChoice || ['auto', 'none'].includes(toolChoice.type))) {
    if (!requested) maxTokens = Math.max(maxTokens, budget + 8192);
    const room = Math.min(budget, maxTokens - 1024);
    if (room >= 1024) thinking = { type: 'enabled', budget_tokens: room };
  }
  // OpenAI temperature runs 0-2, Anthropic's 0-1; recent Claude models refuse temperature and top_p
  // together, and thinking takes neither.
  const temperature = b.temperature != null ? Math.min(1, Math.max(0, Number(b.temperature) || 0)) : null;
  return {
    model: b.model,
    max_tokens: maxTokens,
    messages,
    ...(system.length ? { system: system.join('\n\n') } : {}),
    ...(!thinking && temperature != null ? { temperature } : {}),
    ...(!thinking && temperature == null && b.top_p != null ? { top_p: b.top_p } : {}),
    ...(b.stop ? { stop_sequences: [].concat(b.stop) } : {}),
    ...(tools.length ? { tools } : {}),
    ...(tools.length && toolChoice ? { tool_choice: toolChoice } : {}),
    ...(thinking ? { thinking } : {}),
    ...(outputFormat ? { output_config: { format: outputFormat } } : {}),
    ...(b.stream ? { stream: true } : {}),
  };
}
function anthropicUsageToOpenAI(u = {}) {
  const cached = u.cache_read_input_tokens || 0;
  const prompt = (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output_tokens || 0,
    total_tokens: prompt + (u.output_tokens || 0),
    prompt_tokens_details: { cached_tokens: cached },
  };
}
function anthropicResponseToOpenAI(j, model) {
  const text = (j.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  const calls = (j.content || [])
    .filter((c) => c.type === 'tool_use')
    .map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }));
  // Thinking goes out as reasoning_content, the field the streamed answer already uses.
  const thinking = (j.content || [])
    .filter((c) => c.type === 'thinking')
    .map((c) => c.thinking || '')
    .join('');
  return {
    id: j.id || rid('chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(thinking ? { reasoning_content: thinking } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: FROM_ANTHROPIC_STOP[j.stop_reason] || 'stop',
      },
    ],
    usage: anthropicUsageToOpenAI(j.usage),
  };
}
// Anthropic SSE event (parsed data object) → OpenAI chunks.
function anthropicEventsToOpenAI(model) {
  const id = rid('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);
  let usage = {};
  const blocks = new Map();
  let toolN = -1;
  const chunk = (delta, finish = null, extra = {}) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  return (ev) => {
    if (ev.type === 'message_start') {
      usage = { ...(ev.message && ev.message.usage) };
      return [chunk({ role: 'assistant', content: '' })];
    }
    if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
      toolN++;
      blocks.set(ev.index, toolN);
      return [
        chunk({
          tool_calls: [
            {
              index: toolN,
              id: ev.content_block.id,
              type: 'function',
              function: { name: ev.content_block.name, arguments: '' },
            },
          ],
        }),
      ];
    }
    if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta') return [chunk({ content: d.text })];
      if (d.type === 'thinking_delta') return [chunk({ reasoning_content: d.thinking })];
      if (d.type === 'input_json_delta' && blocks.has(ev.index))
        return [chunk({ tool_calls: [{ index: blocks.get(ev.index), function: { arguments: d.partial_json } }] })];
      return [];
    }
    if (ev.type === 'message_delta') {
      usage = { ...usage, ...(ev.usage || {}) };
      return [chunk({}, FROM_ANTHROPIC_STOP[ev.delta && ev.delta.stop_reason] || 'stop')];
    }
    if (ev.type === 'message_stop')
      return [
        { id, object: 'chat.completion.chunk', created, model, choices: [], usage: anthropicUsageToOpenAI(usage) },
      ];
    if (ev.type === 'error') return [{ error: ev.error || { message: 'upstream error' } }];
    return [];
  };
}

/* ======================= OpenAI Responses → OpenAI chat ======================= */
function responsesToOpenAI(b) {
  // Conversation state lives with OpenAI; a chat provider sees only what this request carries.
  if (b.previous_response_id)
    throw bad('previous_response_id needs a provider with the native Responses API; send the full input instead');
  const messages = [];
  const custom = new Set();
  const dropped = [];
  if (b.instructions) messages.push({ role: 'system', content: b.instructions });
  const items = typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : b.input || [];
  let pending = null; // an assistant message that collects text and consecutive tool calls
  const flush = () => {
    if (pending) {
      messages.push(pending);
      pending = null;
    }
  };
  const assistant = () => (pending ||= { role: 'assistant', content: null, tool_calls: [] });
  for (const it of items) {
    const type = it.type || 'message';
    if (type === 'message') {
      const parts = typeof it.content === 'string' ? [{ type: 'input_text', text: it.content }] : it.content || [];
      const text = parts
        .filter((p) => /text$/.test(p.type || 'text'))
        .map((p) => p.text || '')
        .join('');
      if (it.role === 'assistant') {
        const a = assistant();
        a.content = (a.content || '') + text;
        continue;
      }
      flush();
      const images = parts.filter((p) => p.type === 'input_image');
      const role = it.role === 'developer' || it.role === 'system' ? 'system' : 'user';
      messages.push({
        role,
        content:
          images.length && role === 'user'
            ? [
                ...(text ? [{ type: 'text', text }] : []),
                ...images.map((p) => ({ type: 'image_url', image_url: { url: p.image_url || '' } })),
              ]
            : text,
      });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      if (type === 'custom_tool_call') custom.add(it.name);
      assistant().tool_calls.push({
        id: it.call_id,
        type: 'function',
        function: {
          name: it.name,
          arguments: type === 'custom_tool_call' ? JSON.stringify({ input: it.input || '' }) : it.arguments || '{}',
        },
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      flush();
      messages.push({
        role: 'tool',
        tool_call_id: it.call_id,
        content:
          typeof it.output === 'string'
            ? it.output
            : Array.isArray(it.output)
              ? it.output.map((o) => o.text || '').join('\n')
              : JSON.stringify(it.output || ''),
      });
    } else if (type === 'item_reference')
      throw bad('item_reference needs a provider with the native Responses API; send the item itself');
    // reasoning and other item types carry nothing a chat model can use
  }
  flush();
  for (const m of messages) if (m.tool_calls && !m.tool_calls.length) delete m.tool_calls;
  // Custom (freeform) tools become functions with one string argument; the answer turns back into a custom call.
  const tools = (b.tools || [])
    .map((t) => {
      if (t.type === 'function')
        return {
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: t.parameters || { type: 'object', properties: {} },
          },
        };
      if (t.type === 'custom') {
        custom.add(t.name);
        return {
          type: 'function',
          function: {
            name: t.name,
            description: `${t.description || ''} Put the whole raw input in the "input" string.`.trim(),
            parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
          },
        };
      }
      // Built-in tools (web_search, file_search, code_interpreter, …) run inside OpenAI's API.
      dropped.push(`tool ${t.type}`);
      return null;
    })
    .filter(Boolean);
  const tc = b.tool_choice;
  if (tc && typeof tc === 'object' && !tc.name && !['auto', 'none', 'required'].includes(tc.type))
    throw bad(`tool_choice ${tc.type} needs a provider with the native Responses API`);
  const effort = b.reasoning && EFFORTS.has(b.reasoning.effort) ? b.reasoning.effort : null;
  const f = b.text && b.text.format;
  const format =
    f && f.type === 'json_schema'
      ? {
          type: 'json_schema',
          json_schema: {
            name: f.name || 'output',
            schema: f.schema || {},
            ...(f.strict != null ? { strict: f.strict } : {}),
            ...(f.description ? { description: f.description } : {}),
          },
        }
      : f && f.type === 'json_object'
        ? { type: 'json_object' }
        : null;
  const body = tag(
    {
      model: b.model,
      messages,
      ...(b.max_output_tokens ? { max_tokens: b.max_output_tokens } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(format ? { response_format: format } : {}),
      ...(b.temperature != null ? { temperature: b.temperature } : {}),
      ...(b.top_p != null ? { top_p: b.top_p } : {}),
      ...(tools.length
        ? {
            tools,
            ...(tc && typeof tc === 'string'
              ? { tool_choice: tc }
              : tc && tc.name
                ? { tool_choice: { type: 'function', function: { name: tc.name } } }
                : {}),
            ...(b.parallel_tool_calls != null ? { parallel_tool_calls: b.parallel_tool_calls } : {}),
          }
        : {}),
      stream: !!b.stream,
    },
    effort ? ['reasoning_effort'] : [],
    dropped,
  );
  return { body, custom };
}
function responsesUsage(u) {
  const p = usageParts(u);
  return {
    input_tokens: p.prompt,
    input_tokens_details: { cached_tokens: p.cached },
    output_tokens: p.output,
    output_tokens_details: { reasoning_tokens: p.reasoning },
    total_tokens: p.prompt + p.output,
  };
}
function toolItem(tc, custom, status = 'completed') {
  const name = tc.function.name;
  if (custom.has(name))
    return {
      type: 'custom_tool_call',
      id: rid('ctc_'),
      call_id: tc.id,
      name,
      input: String(json(tc.function.arguments, {}).input ?? tc.function.arguments ?? ''),
      status,
    };
  return {
    type: 'function_call',
    id: rid('fc_'),
    call_id: tc.id || rid('call_'),
    name,
    arguments: tc.function.arguments || '{}',
    status,
  };
}
function openAIToResponses(j, model, custom = new Set()) {
  const choice = (j.choices && j.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];
  if (msg.content)
    output.push({
      type: 'message',
      id: rid('msg_'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textOf(msg.content), annotations: [] }],
    });
  for (const tc of msg.tool_calls || []) output.push(toolItem(tc, custom));
  const incomplete = choice.finish_reason === 'length';
  return {
    id: rid('resp_'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    model,
    output,
    output_text: textOf(msg.content),
    usage: responsesUsage(j.usage),
  };
}
// OpenAI chunks → Responses streaming events (the set Codex reads: created, output_item.added/done,
// output_text.delta, function_call_arguments.delta/done, completed or incomplete).
function responsesStream(model, custom = new Set()) {
  const id = rid('resp_');
  const created = Math.floor(Date.now() / 1000);
  let seq = 0;
  let started = false;
  let usage = {};
  let finish = null;
  const output = [];
  let text = null;
  const tools = new Map(); // stream index → the call now streaming at that index
  const calls = []; // every call, in output order
  const out = [];
  const ev = (type, data) => out.push(sse(type, { type, sequence_number: seq++, ...data }));
  const base = (status) => ({ id, object: 'response', created_at: created, status, model, output: [] });
  const start = () => {
    if (started) return;
    started = true;
    ev('response.created', { response: base('in_progress') });
    ev('response.in_progress', { response: base('in_progress') });
  };
  const closeText = () => {
    if (!text) return;
    const item = {
      type: 'message',
      id: text.id,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: text.buf, annotations: [] }],
    };
    ev('response.output_text.done', { item_id: text.id, output_index: text.oi, content_index: 0, text: text.buf });
    ev('response.content_part.done', {
      item_id: text.id,
      output_index: text.oi,
      content_index: 0,
      part: item.content[0],
    });
    ev('response.output_item.done', { output_index: text.oi, item });
    output[text.oi] = item;
    text = null;
  };
  const drain = () => out.splice(0).join('');
  return {
    push(c) {
      start();
      if (c.usage) usage = c.usage;
      const ch = c.choices && c.choices[0];
      if (!ch) return drain();
      const d = ch.delta || {};
      if (d.content) {
        if (!text) {
          text = { id: rid('msg_'), oi: output.length, buf: '' };
          output.push(null);
          ev('response.output_item.added', {
            output_index: text.oi,
            item: { type: 'message', id: text.id, status: 'in_progress', role: 'assistant', content: [] },
          });
          ev('response.content_part.added', {
            item_id: text.id,
            output_index: text.oi,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
        }
        text.buf += d.content;
        ev('response.output_text.delta', {
          item_id: text.id,
          output_index: text.oi,
          content_index: 0,
          delta: d.content,
        });
      }
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? 0;
        // A new id at a known index is a new call (parallel calls that all arrive at index 0).
        if (!tools.has(k) || (tc.id && tools.get(k).up && tools.get(k).up !== tc.id)) {
          closeText();
          const t = {
            oi: output.length,
            id: tc.id || rid('call_'),
            up: tc.id,
            name: (tc.function && tc.function.name) || '',
            args: '',
          };
          tools.set(k, t);
          calls.push(t);
          output.push(null);
          const item = toolItem({ id: t.id, function: { name: t.name, arguments: '' } }, custom, 'in_progress');
          t.itemId = item.id;
          ev('response.output_item.added', {
            output_index: t.oi,
            item: custom.has(t.name) ? { ...item, input: '' } : item,
          });
        }
        const t = tools.get(k);
        const a = (tc.function && tc.function.arguments) || '';
        if (tc.function && tc.function.name && !t.name) t.name = tc.function.name;
        if (a) {
          t.args += a;
          if (!custom.has(t.name))
            ev('response.function_call_arguments.delta', { item_id: t.itemId, output_index: t.oi, delta: a });
        }
      }
      if (ch.finish_reason) finish = ch.finish_reason;
      return drain();
    },
    finish() {
      start();
      closeText();
      for (const t of calls) {
        const item = {
          ...toolItem({ id: t.id, function: { name: t.name, arguments: t.args || '{}' } }, custom),
          id: t.itemId,
        };
        if (item.type === 'function_call')
          ev('response.function_call_arguments.done', {
            item_id: t.itemId,
            output_index: t.oi,
            arguments: item.arguments,
          });
        ev('response.output_item.done', { output_index: t.oi, item });
        output[t.oi] = item;
      }
      const incomplete = finish === 'length';
      const response = {
        ...base(incomplete ? 'incomplete' : 'completed'),
        output: output.filter(Boolean),
        usage: responsesUsage(usage),
        ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      };
      ev(incomplete ? 'response.incomplete' : 'response.completed', { response });
      return drain();
    },
    error: (message) => {
      const e = sse('response.failed', {
        type: 'response.failed',
        sequence_number: seq++,
        response: { ...base('failed'), error: { code: 'upstream_error', message } },
      });
      return e;
    },
  };
}

/* ======================= Gemini generateContent → OpenAI chat ======================= */
const lowerTypes = (s) =>
  Array.isArray(s)
    ? s.map(lowerTypes)
    : s && typeof s === 'object'
      ? Object.fromEntries(
          Object.entries(s).map(([k, v]) => [
            k,
            k === 'type' && typeof v === 'string' ? v.toLowerCase() : lowerTypes(v),
          ]),
        )
      : s;
function geminiToOpenAI(b, model, stream) {
  const messages = [];
  const pending = new Map();
  let n = 0;
  const sys = b.systemInstruction || b.system_instruction;
  if (sys) messages.push({ role: 'system', content: (sys.parts || []).map((p) => p.text || '').join('\n') });
  for (const c of b.contents || []) {
    const parts = c.parts || [];
    if (c.role === 'model') {
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join('');
      const calls = parts
        .filter((p) => p.functionCall)
        .map((p) => {
          const id = p.functionCall.id || `call_${n++}_${p.functionCall.name}`;
          (pending.get(p.functionCall.name) || pending.set(p.functionCall.name, []).get(p.functionCall.name)).push(id);
          return {
            id,
            type: 'function',
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
          };
        });
      messages.push({
        role: 'assistant',
        content: text || (calls.length ? null : ''),
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const user = [];
    for (const p of parts) {
      if (p.functionResponse) {
        const q = pending.get(p.functionResponse.name) || [];
        messages.push({
          role: 'tool',
          tool_call_id: p.functionResponse.id || q.shift() || `call_${p.functionResponse.name}`,
          content: JSON.stringify(p.functionResponse.response ?? {}),
        });
      } else if (p.text) user.push({ type: 'text', text: p.text });
      else if (p.inlineData || p.inline_data) {
        const d = p.inlineData || p.inline_data;
        user.push({ type: 'image_url', image_url: { url: `data:${d.mimeType || d.mime_type};base64,${d.data}` } });
      }
    }
    if (user.length)
      messages.push({
        role: 'user',
        content: user.every((p) => p.type === 'text') ? user.map((p) => p.text).join('\n') : user,
      });
  }
  const decls = (b.tools || []).flatMap((t) => t.functionDeclarations || t.function_declarations || []);
  const tools = decls.map((f) => ({
    type: 'function',
    function: {
      name: f.name,
      description: f.description || '',
      parameters: lowerTypes(f.parameters || f.parametersJsonSchema || { type: 'object', properties: {} }),
    },
  }));
  const g = b.generationConfig || b.generation_config || {};
  return {
    model,
    messages,
    ...(g.maxOutputTokens ? { max_tokens: g.maxOutputTokens } : {}),
    ...(g.temperature != null ? { temperature: g.temperature } : {}),
    ...(g.topP != null ? { top_p: g.topP } : {}),
    ...(g.stopSequences && g.stopSequences.length ? { stop: g.stopSequences } : {}),
    ...(tools.length ? { tools } : {}),
    stream: !!stream,
  };
}
function geminiUsage(u) {
  const p = usageParts(u);
  return {
    promptTokenCount: p.prompt,
    candidatesTokenCount: p.output,
    totalTokenCount: p.prompt + p.output,
    ...(p.cached ? { cachedContentTokenCount: p.cached } : {}),
  };
}
function openAIToGemini(j, model) {
  const choice = (j.choices && j.choices[0]) || {};
  const msg = choice.message || {};
  const parts = [];
  if (msg.content) parts.push({ text: textOf(msg.content) });
  for (const tc of msg.tool_calls || [])
    parts.push({ functionCall: { name: tc.function.name, args: json(tc.function.arguments) } });
  return {
    candidates: [
      {
        content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
        finishReason: TO_GEMINI_FINISH[choice.finish_reason] || 'STOP',
        index: 0,
      },
    ],
    usageMetadata: geminiUsage(j.usage),
    modelVersion: model,
  };
}
function geminiStream(model) {
  const tools = new Map();
  const calls = [];
  let finish = null;
  let usage = null;
  const data = (o) => `data: ${JSON.stringify(o)}\n\n`;
  return {
    push(c) {
      if (c.usage) usage = c.usage;
      const ch = c.choices && c.choices[0];
      if (!ch) return '';
      const d = ch.delta || {};
      let out = '';
      if (d.content)
        out += data({
          candidates: [{ content: { role: 'model', parts: [{ text: d.content }] }, index: 0 }],
          modelVersion: model,
        });
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? 0;
        let t = tools.get(k);
        if (!t || (tc.id && t.up && t.up !== tc.id)) {
          t = { name: '', args: '', up: tc.id };
          tools.set(k, t);
          calls.push(t);
        }
        if (tc.function && tc.function.name) t.name = tc.function.name;
        if (tc.function && tc.function.arguments) t.args += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
      return out;
    },
    finish() {
      const parts = calls.map((t) => ({ functionCall: { name: t.name, args: json(t.args) } }));
      return data({
        candidates: [
          {
            content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
            finishReason: TO_GEMINI_FINISH[finish] || 'STOP',
            index: 0,
          },
        ],
        ...(usage ? { usageMetadata: geminiUsage(usage) } : {}),
        modelVersion: model,
      });
    },
    error: (message) => data({ error: { code: 502, message, status: 'UNAVAILABLE' } }),
  };
}

// A provider that answered a streaming request with one JSON body: the same answer as stream chunks.
function wholeToChunks(j) {
  const ch = (j.choices && j.choices[0]) || {};
  const m = ch.message || {};
  const delta = {
    role: 'assistant',
    ...(m.content ? { content: textOf(m.content) } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls.map((tc, index) => ({ index, ...tc })) } : {}),
  };
  return [
    { choices: [{ index: 0, delta }] },
    { choices: [{ index: 0, delta: {}, finish_reason: ch.finish_reason || 'stop' }] },
    ...(j.usage ? [{ choices: [], usage: j.usage }] : []),
  ];
}

// Rough token count (about 4 characters per token) for count_tokens endpoints; tools and images included.
function estimateTokens(body) {
  return Math.max(1, Math.ceil(JSON.stringify(body || {}).length / 4));
}

// Reads an SSE byte stream and calls onEvent(eventName, dataString) for each complete event.
async function readSse(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) await onEvent(event, data.join('\n'));
    }
  }
}

module.exports = {
  anthropicToOpenAI,
  openAIToAnthropic,
  anthropicStream,
  openAIToAnthropicRequest,
  anthropicResponseToOpenAI,
  anthropicEventsToOpenAI,
  anthropicUsageToOpenAI,
  responsesToOpenAI,
  openAIToResponses,
  responsesStream,
  geminiToOpenAI,
  openAIToGemini,
  geminiStream,
  estimateTokens,
  readSse,
  wholeToChunks,
  SOFT,
  DROPPED,
  TO_ANTHROPIC_STOP,
  FROM_ANTHROPIC_STOP,
};
