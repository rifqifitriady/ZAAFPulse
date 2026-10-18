// ZAAFPulse Agent Gateway on 127.0.0.1. Public endpoints need a ZAAFPulse API key:
//   GET  /v1/models                 provider models plus agent/<id> and agent/auto, as the key allows
//   POST /v1/chat/completions       OpenAI format, streaming; model "provider/model", or "agent/<id>"
//                                   for a domain agent, or "agent/auto" for the orchestrator
//   POST /v1/embeddings             passthrough to the provider
//   GET  /v1/agents · POST /v1/agents/<id>/run · POST /v1/orchestrate
//   GET  /v1/sessions · GET|DELETE /v1/sessions/<id>
//   POST /mcp                       MCP (JSON-RPC over HTTP) with every integration tool, "mcp" scope
//   GET  /v1/knowledge · POST /v1/knowledge/<id>/search · POST /v1/knowledge/<id>/documents   RAG, "rag" scope
//   GET  /v1/workflows · POST /v1/workflows/<id>/run                                          "agents" scope
//   POST /v1/collaborate            a multi-agent run: pattern auto|parallel|vote|debate|review|group|handoff|
//                                   workflow|agent, with effort, budget and pattern options ("agents" scope)
//   GET  /v1/runs · GET /v1/runs/<id> · POST /v1/runs/<id>/cancel · POST /v1/runs/<id>/resume (approval)
//   GET  /.well-known/agent-card.json · POST /a2a   Agent2Agent protocol (JSON-RPC + SSE), "agents" scope
//   POST /v1/messages (+ /count_tokens)   Anthropic Messages, for Claude Code         } translated to any provider,
//   POST /v1/responses                    OpenAI Responses, for Codex                  } "llm" scope; keys also work as
//   POST /v1beta/models/<m>:generateContent | :streamGenerateContent | :countTokens   } x-api-key or x-goog-api-key
//   Long tool results are shortened before they go upstream (token saver; header x-zp-token-saver: off).
//   GET  /v1/brain/sources · /v1/brain/search?q= · /v1/brain/graph?source=   second brain, read only, "rag" scope
//   GET  /skills · /skills/<name>/SKILL.md   agent skills that teach an AI to use all of this (no key: docs only)
// Chat completions also take model "collab/<pattern>" to run a collaboration pattern from any OpenAI client.
// Model names may be router/<name> routes, which fall back across their targets on errors.
// The dashboard manages providers, keys, agents, sessions and memory through admin() (no key; the
// dashboard API itself is localhost-only and host-checked).
const path = require('path');
const { jsonStore } = require('./store');
const { createKeys, allows } = require('./keys');
const tr = require('./translate');
const { saveTokens } = require('./rtk');
const { createProviders, cleanProvider, cleanRoute, PRESETS } = require('./providers');
const { createKnowledge } = require('./knowledge');
const { createWorkflows } = require('./workflows');
const { createUsage } = require('./usage');
const { createSessions, createMemory } = require('./memory');
const { createAgents } = require('./agents');
const { createOrchestrator } = require('./orchestrator');
const { createCollab } = require('./collab');
const { createA2A } = require('./a2a');
const { createTools } = require('./tools');
const { createSkills } = require('./skills');
const { createServer: createMcp } = require('../mcp/protocol');

const MAX_BODY = 20 * 1024 * 1024;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-api-key, x-goog-api-key, x-zp-session, x-zp-token-saver, anthropic-version, anthropic-beta, a2a-version, a2a-extensions', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-expose-headers': 'x-zp-session, retry-after' };

class HttpError extends Error { constructor(status, message, type = 'invalid_request_error') { super(message); this.status = status; this.type = type; } }

// resolveSecret(providerId, input, current) turns a secret input (keep/keychain/env/store) into a reference.
function createGateway({ dataDir, getConfig, writeGatewayConfig, secrets, resolveSecret, getPricing, getIntegrations, version = '1.0.0', now = Date.now, baseUrl = 'http://127.0.0.1:4777', toolsHome, fetchImpl }) {
  const keyStore = jsonStore(path.join(dataDir, 'keys.json'), { keys: [] });
  const agentStore = jsonStore(path.join(dataDir, 'agents.json'), { agents: [] });
  const sessionStore = jsonStore(path.join(dataDir, 'sessions.json'), { sessions: [] });
  const memoryStore = jsonStore(path.join(dataDir, 'memory.json'), { memory: [] });
  const workflowStore = jsonStore(path.join(dataDir, 'workflows.json'), { workflows: [] });
  const runStore = jsonStore(path.join(dataDir, 'runs.json'), { runs: [] });
  const keys = createKeys(keyStore, { now });
  const providers = createProviders({ getConfig, secrets, ...(fetchImpl ? { fetchImpl } : {}) });
  const usage = createUsage({ file: path.join(dataDir, 'gateway-usage.jsonl'), getPricing, now });
  const sessions = createSessions(sessionStore, { now });
  const memory = createMemory(memoryStore, { now });
  const agents = createAgents(agentStore);
  const workflows = createWorkflows(workflowStore);
  const gwcfg = () => (getConfig() || {}).gateway || {};
  const defaults = () => ({ model: '', plannerModel: '', codeModel: '', ...(gwcfg().defaults || {}) });

  const checkBudget = (keyId) => {
    const k = keyId && keyStore.get().keys.find((x) => x.id === keyId);
    if (k && k.budgetUSD != null && usage.monthSpend(k.id) >= k.budgetUSD) throw new HttpError(402, `monthly budget of $${k.budgetUSD} reached for this key`, 'insufficient_quota');
  };
  const usageOf = (j) => ({ input: j.usage?.prompt_tokens || 0, output: j.usage?.completion_tokens || 0, cached: j.usage?.prompt_tokens_details?.cached_tokens || 0 });

  // Non-streaming model call used by agents and the planner; logged and billed to the key.
  // Errors worth trying the next route target for: overload, rate limit, timeouts and server errors.
  const retryable = (status) => status === 408 || status === 429 || status >= 500;
  const targetsFor = (model, k) => {
    const list = providers.resolveAll(model, { privateOnly: !!(k && k.privateOnly) });
    if (!list.length) throw new HttpError(404, providers.whyNot(model, { privateOnly: !!(k && k.privateOnly) }));
    return list;
  };

  // Non-streaming model call used by agents and the planner; logged and billed to the key.
  async function llm({ model, messages, tools, keyId, agent, sessionId, temperature }) {
    const k = keyId && keyStore.get().keys.find((x) => x.id === keyId);
    if (k) { const why = keys.authorize(k, { model }); if (why) throw new HttpError(403, why, 'permission_error'); }
    checkBudget(keyId);
    let last = null;
    for (const target of targetsFor(model, k)) {
      const started = now();
      let r; try { r = await callChat(target, { messages, ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}), ...(Number.isFinite(temperature) ? { temperature } : {}) }); }
      catch (err) { usage.record({ keyId: keyId || 'dashboard', provider: target.provider.id, model, agent, sessionId, status: 599, ms: now() - started, error: err.message, kind: 'agent' }); last = new HttpError(502, err.message, 'upstream_error'); continue; }
      const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch { /* error page */ }
      const u = usageOf(j);
      const entry = usage.record({ keyId: keyId || 'dashboard', provider: target.provider.id, model, routedTo: target.name !== model ? target.name : undefined, agent, sessionId, status: r.status, ms: now() - started, input: u.input, output: u.output, cached: u.cached, kind: 'agent' });
      if (r.ok) return { message: j.choices && j.choices[0] && j.choices[0].message, usage: { input: u.input, output: u.output, cost: entry.cost }, routedTo: target.name };
      last = new HttpError(r.status === 401 || r.status === 403 ? 502 : r.status, secrets.mask(`${target.provider.id} returned ${r.status}: ${(j.error && j.error.message) || text.slice(0, 300)}`), 'upstream_error');
      if (!retryable(r.status)) break;
    }
    throw last;
  }

  // Embeddings for the RAG service (and /v1/embeddings): batched, logged, with route fallback.
  async function embed(model, input, keyId = null) {
    let last = null;
    for (const target of targetsFor(model, null)) {
      const started = now();
      try {
        const r = await providers.request(target.provider, '/embeddings', { body: { model: target.model, input } });
        const j = await r.json().catch(() => ({}));
        usage.record({ keyId: keyId || 'dashboard', provider: target.provider.id, model, kind: 'embeddings', status: r.status, ms: now() - started, input: j.usage?.prompt_tokens || 0, output: 0 });
        if (r.ok && Array.isArray(j.data)) return j.data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
        last = new Error(`${target.provider.id} returned ${r.status}: ${(j.error && j.error.message) || 'no embeddings'}`);
        if (!retryable(r.status)) break;
      } catch (err) { last = err; }
    }
    throw new Error(secrets.mask(last ? last.message : 'no embedding target'));
  }
  const knowledge = createKnowledge({ dir: path.join(dataDir, 'kb'), embed: (m, texts) => embed(m, texts), now });

  // Integrations are read lazily so a config change (a new integration) reaches agents at once.
  const realOrchestrator = createOrchestrator({ agents, memory, knowledge, integrations: { listTools: () => getIntegrations().listTools(), callTool: (n, a) => getIntegrations().callTool(n, a) }, llm, getDefaults: defaults });
  const collab = createCollab({ agents, orchestrator: realOrchestrator, llm, getDefaults: defaults, sessions, workflows, store: runStore, now });
  const a2a = createA2A({ collab, sessions, agents, workflows, version });
  const codeTools = createTools(toolsHome ? { home: toolsHome } : {});
  const skills = createSkills({ version, ...(toolsHome ? { home: toolsHome } : {}) });
  let brain = null; // set by the server once the second-brain sources exist (setBrain)

  const mcp = createMcp({ name: 'zaafpulse-gateway', version, instructions: 'ZAAFPulse over HTTP: every integration tool configured in ZAAFPulse (AI usage, Dynatrace, n8n, OpenRouter, ...).',
    listTools: () => getIntegrations().listTools(), callTool: (n, a) => getIntegrations().callTool(n, a) });

  /* ---------- public endpoints ---------- */
  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new HttpError(413, 'request body over 20 MB'); chunks.push(c); }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'body is not valid JSON'); }
  }
  const json = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra }); res.end(JSON.stringify(body)); };
  const fail = (res, err) => json(res, err.status || 500, { error: { message: err.message, type: err.type || 'server_error' } }, err.status === 429 && err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {});

  function authed(req, scope) {
    const header = req.headers.authorization || '';
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : req.headers['x-api-key'] || req.headers['x-goog-api-key'] || new URL(req.url, 'http://x').searchParams.get('key') || undefined;
    const a = keys.authenticate(secret); if (a.error) throw new HttpError(a.status, a.error, 'authentication_error');
    const why = keys.authorize(a.key, { scope }); if (why) throw new HttpError(403, why, 'permission_error');
    const wait = keys.rateLimit(a.key); if (wait) throw Object.assign(new HttpError(429, `rate limit of ${a.key.rpm} requests per minute reached`, 'rate_limit_error'), { retryAfter: wait });
    return a.key;
  }
  const agentAllowed = (key) => (id) => !keys.authorize(key, { agent: id });
  const ctxFor = (key) => ({ keyId: key.id, allowAgent: agentAllowed(key), privateOnly: !!key.privateOnly });
  // A collaboration run for an API caller: 400 on a bad spec, 403 when the spec names an agent the key may not use.
  async function runFor(key, spec, extra = {}) {
    const r = await collab.run(spec, { ...ctxFor(key), ...extra });
    if (r.errors) throw new HttpError(r.errors.some((e) => /may not use/.test(e)) ? 403 : 400, r.errors.join('; '), r.errors.some((e) => /may not use/.test(e)) ? 'permission_error' : 'invalid_request_error');
    return r.run;
  }
  // The orchestrate/workflow response keeps its old fields (answer, plan, steps, usage) next to the run.
  const runReply = (run) => ({ ...run, run_id: run.id, usage: { input: run.spent.input, output: run.spent.output, cost: run.spent.cost, requests: run.spent.requests }, sessionId: run.contextId });

  async function modelsFor(key) {
    const out = [];
    // Only usable providers (enabled; external ones approved), and only private ones for a private-only key.
    for (const p of providers.list().filter((x) => providers.usable(x) && (!key.privateOnly || providers.tierOf(x) === 'private'))) {
      let ms = []; try { ms = await providers.models(p); } catch { ms = p.models || []; }
      for (const m of ms) { const id = `${p.id}/${m}`; if (!keys.authorize(key, { model: id })) out.push({ id, object: 'model', owned_by: p.id }); }
      for (const alias of Object.keys(p.aliases || {})) if (!keys.authorize(key, { model: alias })) out.push({ id: alias, object: 'model', owned_by: p.id });
    }
    for (const r of providers.routes()) if (!keys.authorize(key, { model: r.name }) && providers.resolveAll(r.name, { privateOnly: !!key.privateOnly }).length) out.push({ id: r.name, object: 'model', owned_by: 'router', description: r.description || r.targets.join(' → ') });
    if (key.scopes.includes('agents')) {
      out.push({ id: 'agent/auto', object: 'model', owned_by: 'zaafpulse', description: 'Orchestrator: plans and routes to domain agents' });
      for (const [id, p] of Object.entries(collab.PATTERNS)) if (!['agent', 'workflow', 'auto'].includes(id)) out.push({ id: `collab/${id}`, object: 'model', owned_by: 'zaafpulse', description: `${p.name}: ${p.description}` });
      for (const a of agents.enabled()) if (agentAllowed(key)(a.id)) out.push({ id: `agent/${a.id}`, object: 'model', owned_by: 'zaafpulse', description: a.description });
    }
    return out;
  }

  // agent/<id> or agent/auto through chat completions: last user message is the task, the session
  // comes from the x-zp-session header (or `user`), and the reply is an OpenAI-shaped completion.
  async function agentCompletion(req, res, key, body) {
    const isCollab = body.model.startsWith('collab/');
    const id = isCollab ? 'auto' : body.model.slice('agent/'.length);
    const pattern = isCollab ? body.model.slice('collab/'.length) : 'auto';
    const why = keys.authorize(key, { scope: 'agents' }); if (why) throw new HttpError(403, why, 'permission_error');
    if (isCollab && (!collab.PATTERNS[pattern] || ['agent', 'workflow'].includes(pattern))) throw new HttpError(404, `no collaboration pattern "${pattern}"; use collab/<${Object.keys(collab.PATTERNS).filter((p) => !['agent', 'workflow'].includes(p)).join('|')}>`);
    if (id !== 'auto' && (!agents.get(id) || !agents.get(id).enabled)) throw new HttpError(404, `no enabled agent "${id}"`);
    if (id !== 'auto' && !agentAllowed(key)(id)) throw new HttpError(403, `this key may not use agent "${id}"`, 'permission_error');
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const last = [...msgs].reverse().find((m) => m.role === 'user');
    const task = last ? (typeof last.content === 'string' ? last.content : (last.content || []).map((c) => c.text || '').join('\n')) : '';
    if (!task) throw new HttpError(400, 'messages must include a user message');
    const opened = sessions.open(req.headers['x-zp-session'] || body.user, { keyId: key.id, agent: id, title: task });
    if (opened.error) throw new HttpError(403, opened.error, 'permission_error');
    const s = opened.session;
    let text; let u;
    if (id === 'auto') {
      const run = await runFor(key, { ...(body.zp && typeof body.zp === 'object' ? body.zp : {}), pattern, task }, { session: s });
      if (run.state === 'failed') throw new HttpError(run.errorStatus || 502, run.error, 'upstream_error');
      text = run.answer || (run.pending ? run.pending.question : ''); u = run.spent;
    } else {
      const r = await realOrchestrator.runAgent(agents.get(id), task, { ...ctxFor(key), session: s, history: s.messages });
      sessions.append(s, { role: 'user', content: task }, { role: 'assistant', content: r.text, agent: id }); text = r.text; u = r.usage;
    }
    const completion = { id: `chatcmpl-zp-${now()}`, object: 'chat.completion', created: Math.floor(now() / 1000), model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output } };
    if (!body.stream) return json(res, 200, completion, { 'x-zp-session': s.id });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', ...CORS, 'x-zp-session': s.id });
    res.write(`data: ${JSON.stringify({ id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: completion.usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  }

  /* ---------- the proxy core: model mapping, token saver, fallback, translation ---------- */
  // Tool clients send their own model names (claude-sonnet-…, gpt-…-codex, gemini-…). A name that is not
  // a provider model, alias or route goes through the model map (glob → model), then any usable provider
  // that lists that bare model, then defaults.codeModel and defaults.model.
  function mapModel(name) {
    const n = String(name || '');
    if (n && (providers.routes().some((r) => r.name === n) || providers.resolve(n))) return n;
    for (const m of gwcfg().modelMap || []) if (m && m.match && m.to && allows([m.match], n)) return m.to;
    for (const p of providers.list().filter((x) => providers.usable(x))) if (providers.cachedModels(p).includes(n)) return `${p.id}/${n}`;
    return defaults().codeModel || defaults().model || n;
  }
  // One upstream chat call in OpenAI format. Providers that speak Anthropic natively get a translated
  // request, and their answer comes back as an OpenAI-shaped Response (JSON or SSE).
  async function callChat(t, body, { signal } = {}) {
    const p = t.provider;
    if (providers.formatOf(p) !== 'anthropic') return providers.request(p, '/chat/completions', { body: { ...body, model: t.model }, signal });
    const { stream_options: _drop, ...rest } = body;
    const r = await providers.request(p, '/messages', { body: tr.openAIToAnthropicRequest({ ...rest, model: t.model }), signal });
    if (!r.ok) return r;
    if (!body.stream) { const j = await r.json(); return new Response(JSON.stringify(tr.anthropicResponseToOpenAI(j, body.model)), { status: 200, headers: { 'content-type': 'application/json' } }); }
    const conv = tr.anthropicEventsToOpenAI(body.model); const enc = new TextEncoder();
    const out = new ReadableStream({ async start(ctrl) {
      try { await tr.readSse(r.body, (ev, data) => { let o; try { o = JSON.parse(data); } catch { return; } for (const c of conv(o)) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`)); }); ctrl.enqueue(enc.encode('data: [DONE]\n\n')); } catch { /* upstream closed */ }
      ctrl.close();
    } });
    return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  const tokenSaverOn = (req) => gwcfg().tokenSaver !== false && String(req.headers['x-zp-token-saver'] || '').toLowerCase() !== 'off';
  // Authorize, map the model, save tokens, then try route targets until one answers (before any byte is sent).
  async function proxyChat(req, key, body, { format = 'openai', signal } = {}) {
    if (typeof body.model !== 'string' || !body.model) throw new HttpError(400, 'model is required');
    const model = format === 'openai' ? body.model : mapModel(body.model);
    const why = keys.authorize(key, { scope: 'llm', model }); if (why) throw new HttpError(403, why, 'permission_error');
    const targets = targetsFor(model, key);
    checkBudget(key.id);
    const rtk = tokenSaverOn(req) ? saveTokens(body, 'openai') : null;
    const started = now(); const stream = !!body.stream;
    let target; let r; let lastErr = null;
    for (const t of targets) {
      const upstreamBody = { ...body, ...(stream && providers.streamUsage(t.provider) ? { stream_options: { ...(body.stream_options || {}), include_usage: true } } : {}) };
      try { r = await callChat(t, upstreamBody, { signal }); target = t; } catch (err) { lastErr = err; usage.record({ keyId: key.id, provider: t.provider.id, model, kind: 'chat', format, stream, status: 599, ms: now() - started, error: err.message }); continue; }
      if (r.ok || !retryable(r.status) || t === targets[targets.length - 1]) break;
      usage.record({ keyId: key.id, provider: t.provider.id, model, routedTo: t.name, kind: 'chat', format, stream, status: r.status, ms: now() - started, error: 'fell back to the next route target' });
      await r.body?.cancel?.().catch(() => {});
    }
    if (!target) throw new HttpError(502, secrets.mask(lastErr ? lastErr.message : 'no provider answered'), 'upstream_error');
    const base = { keyId: key.id, provider: target.provider.id, model, ...(model !== body.model ? { requested: String(body.model).slice(0, 80) } : {}), routedTo: target.name !== model ? target.name : undefined,
      kind: 'chat', format, stream, ...(rtk ? { savedTokens: rtk.savedTokens } : {}) };
    return { target, r, started, base, model, rtk };
  }
  // Reads an upstream OpenAI SSE body and calls onChunk for each parsed chunk; returns usage and TTFT.
  async function pumpChunks(r, started, onChunk) {
    let ttft = null; let u = { input: 0, output: 0, cached: 0 };
    await tr.readSse(r.body, async (ev, data) => {
      if (data === '[DONE]') return; let c; try { c = JSON.parse(data); } catch { return; }
      const d = c.choices && c.choices[0] && c.choices[0].delta;
      if (ttft == null && d && (d.content || d.tool_calls)) ttft = now() - started;
      if (c.usage) u = usageOf(c);
      await onChunk(c);
    });
    return { ttft, u };
  }
  const abortOnClose = (req, res) => { const ctl = new AbortController(); req.on('close', () => { if (!res.writableEnded) ctl.abort(); }); return ctl; };

  async function chatCompletion(req, res, key, body) {
    if (typeof body.model !== 'string') throw new HttpError(400, 'model is required');
    if (body.model.startsWith('agent/') || body.model.startsWith('collab/')) return agentCompletion(req, res, key, body);
    const ctl = abortOnClose(req, res);
    const { r, started, base } = await proxyChat(req, key, body, { signal: ctl.signal });
    if (!body.stream || !r.ok || !r.body) {
      const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
      const u = j ? usageOf(j) : { input: 0, output: 0, cached: 0 };
      usage.record({ ...base, status: r.status, ms: now() - started, ...u, error: r.ok ? undefined : secrets.mask(((j && j.error && j.error.message) || text).slice(0, 200)) });
      if (j && r.ok) j.model = body.model;
      res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
      return res.end(j ? JSON.stringify(j) : text);
    }
    // Stream: pass bytes through as they arrive; read usage and time to first token on the way.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...CORS });
    let buf = ''; let ttft = null; let u = { input: 0, output: 0, cached: 0 };
    const reader = r.body.getReader(); const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        res.write(Buffer.from(value));
        buf += dec.decode(value, { stream: true });
        let nl; while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
          try { const c = JSON.parse(line.slice(5)); if (ttft == null && c.choices && c.choices[0] && c.choices[0].delta && (c.choices[0].delta.content || c.choices[0].delta.tool_calls)) ttft = now() - started; if (c.usage) u = usageOf(c); } catch { /* partial */ }
        }
      }
    } catch { /* client went away */ }
    res.end();
    usage.record({ ...base, status: 200, ms: now() - started, ttft, ...u });
  }

  // A request in another format: translated to chat, answered by any provider, translated back.
  // out: { whole(json) → body, stream() → { push, finish, error, ping? }, error(status, message) → body, sseType }
  async function translated(req, res, key, oai, out) {
    const ctl = abortOnClose(req, res);
    const { r, started, base } = await proxyChat(req, key, oai, { format: out.format, signal: ctl.signal });
    if (!r.ok) {
      const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
      const msg = secrets.mask(((j && j.error && (j.error.message || j.error)) || text || `HTTP ${r.status}`).toString().slice(0, 300));
      usage.record({ ...base, status: r.status, ms: now() - started, error: msg });
      return json(res, r.status, out.error(r.status, msg));
    }
    if (!oai.stream) {
      const j = await r.json().catch(() => ({}));
      usage.record({ ...base, status: 200, ms: now() - started, ...usageOf(j) });
      return json(res, 200, out.whole(j));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...CORS });
    const s = out.stream();
    // Anthropic clients expect pings while the model thinks; they keep idle connections alive.
    const ping = s.ping ? setInterval(() => { if (!res.writableEnded) res.write(s.ping()); }, 10000) : null;
    let result = { ttft: null, u: { input: 0, output: 0, cached: 0 } };
    try {
      if (s.ping) res.write(s.ping());
      const onChunk = (c) => { if (c.error) throw new Error(c.error.message || 'upstream error'); const w = s.push(c); if (w) res.write(w); };
      if (/json/.test(r.headers.get('content-type') || '')) {
        const j = await r.json(); for (const c of tr.wholeToChunks(j)) onChunk(c);
        result = { ttft: now() - started, u: usageOf(j) };
      } else result = await pumpChunks(r, started, onChunk);
      res.write(s.finish());
    } catch (err) { if (!res.writableEnded) res.write(s.error(secrets.mask(err.message))); } finally { if (ping) clearInterval(ping); }
    res.end();
    usage.record({ ...base, status: 200, ms: now() - started, ttft: result.ttft, ...result.u });
  }

  async function brainApi(kind, q) {
    if (kind === 'sources') return { object: 'list', data: brain.sources().map((x) => ({ id: x.id, type: x.type, label: x.label, name: x.name, family: x.family, enabled: x.enabled, notes: x.cached ? x.cached.notes : null })) };
    const g = await brain.graph(q.get('source') || (kind === 'search' ? 'all' : 'obsidian'));
    if (g.error) throw new HttpError(502, g.error);
    const limit = Math.max(1, Math.min(kind === 'search' ? 100 : 2000, Number(q.get('limit')) || (kind === 'search' ? 20 : 300)));
    const out = new Map(); const back = new Map();
    for (const [a, b] of g.edges) { (out.get(a) || out.set(a, []).get(a)).push(b); (back.get(b) || back.set(b, []).get(b)).push(a); }
    const card = (n) => ({ id: n.id, name: n.name, source: n.source || (g.source && g.source.id), group: n.sourceGroup || n.group, para: n.para || null, tags: n.tags || [], url: n.url || null, modified: n.modified, inLinks: n.inLinks, outLinks: n.outLinks, ...(n.xy ? { xy: n.xy } : {}) });
    if (kind === 'search') {
      const term = String(q.get('q') || '').trim().toLowerCase(); if (!term) throw new HttpError(400, 'q is required');
      const hits = g.notes.filter((n) => n.name.toLowerCase().includes(term) || (n.tags || []).some((t) => String(t).toLowerCase().includes(term)))
        .sort((a, b) => (b.name.toLowerCase().startsWith(term) - a.name.toLowerCase().startsWith(term)) || (b.inLinks + b.outLinks) - (a.inLinks + a.outLinks)).slice(0, limit);
      const titles = (ids) => (ids || []).slice(0, 10).map((i) => g.notes[i] && g.notes[i].name).filter(Boolean);
      return { object: 'list', source: g.source, total: hits.length, data: hits.map((n) => ({ ...card(n), links: titles(out.get(n.id)), backlinks: titles(back.get(n.id)) })) };
    }
    const keep = [...g.notes].sort((a, b) => (b.inLinks + b.outLinks) - (a.inLinks + a.outLinks)).slice(0, limit); const ids = new Set(keep.map((n) => n.id));
    return { source: g.source, layout: g.layout, total: g.notes.length, notes: keep.map(card), edges: g.edges.filter(([a, b]) => ids.has(a) && ids.has(b)),
      hubs: keep.slice(0, 10).map((n) => n.name), orphans: g.notes.filter((n) => !n.inLinks && !n.outLinks).length, unresolved: (g.unresolved || []).slice(0, 20) };
  }

  const anthropicError = (status, message) => ({ type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message } });
  async function messagesApi(req, res, key, body) {
    if (!Array.isArray(body.messages)) throw Object.assign(new HttpError(400, 'messages is required'), { format: 'anthropic' });
    // Same-format passthrough when the model maps to a native Anthropic provider: nothing is lost in translation.
    const model = mapModel(body.model);
    const first = providers.resolveAll(model, { privateOnly: !!key.privateOnly })[0];
    if (first && providers.formatOf(first.provider) === 'anthropic' && model === first.name) return anthropicPassthrough(req, res, key, body, first, model);
    return translated(req, res, key, tr.anthropicToOpenAI({ ...body, model: body.model }), { format: 'anthropic', whole: (j) => tr.openAIToAnthropic(j, body.model), stream: () => tr.anthropicStream(body.model), error: anthropicError });
  }
  async function anthropicPassthrough(req, res, key, body, t, model) {
    const why = keys.authorize(key, { scope: 'llm', model }); if (why) throw Object.assign(new HttpError(403, why, 'permission_error'), { format: 'anthropic' });
    checkBudget(key.id);
    const ctl = abortOnClose(req, res); const started = now();
    const rtk = tokenSaverOn(req) ? saveTokens(body, 'anthropic') : null;
    const r = await providers.request(t.provider, '/messages', { body: { ...body, model: t.model }, signal: ctl.signal });
    const base = { keyId: key.id, provider: t.provider.id, model, requested: String(body.model).slice(0, 80), kind: 'chat', format: 'anthropic', stream: !!body.stream, ...(rtk ? { savedTokens: rtk.savedTokens } : {}) };
    if (!body.stream || !r.ok) {
      const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
      const u = j && j.usage ? usageOf({ usage: tr.anthropicUsageToOpenAI(j.usage) }) : {};
      usage.record({ ...base, status: r.status, ms: now() - started, ...u, error: r.ok ? undefined : secrets.mask(text.slice(0, 200)) });
      res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }); return res.end(text);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...CORS });
    let au = {}; let ttft = null;
    try {
      await tr.readSse(r.body, (ev, data) => {
        res.write(`event: ${ev}\ndata: ${data}\n\n`);
        try { const o = JSON.parse(data); if (o.type === 'message_start') au = { ...o.message.usage }; if (o.type === 'message_delta') au = { ...au, ...o.usage }; if (ttft == null && o.type === 'content_block_delta') ttft = now() - started; } catch { /* keep going */ }
      });
    } catch { /* client or upstream went away */ }
    res.end();
    usage.record({ ...base, status: 200, ms: now() - started, ttft, ...usageOf({ usage: tr.anthropicUsageToOpenAI(au) }) });
  }

  async function responsesApi(req, res, key, body) {
    const { body: oai, custom } = tr.responsesToOpenAI(body);
    return translated(req, res, key, oai, { format: 'responses', whole: (j) => tr.openAIToResponses(j, body.model, custom), stream: () => tr.responsesStream(body.model, custom),
      error: (status, message) => ({ error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code: null } }) });
  }

  async function geminiApi(req, res, key, model, action, body) {
    const stream = action === 'streamGenerateContent';
    const oai = tr.geminiToOpenAI(body, model, stream);
    return translated(req, res, key, oai, { format: 'gemini', whole: (j) => tr.openAIToGemini(j, model), stream: () => tr.geminiStream(model),
      error: (status, message) => ({ error: { code: status, message, status: status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE' } }) });
  }

  async function embeddings(req, res, key, body) {
    const why = keys.authorize(key, { scope: 'llm', model: body.model }); if (why) throw new HttpError(403, why, 'permission_error');
    const target = targetsFor(body.model, key)[0];
    checkBudget(key.id);
    const started = now(); const r = await providers.request(target.provider, '/embeddings', { body: { ...body, model: target.model } });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
    usage.record({ keyId: key.id, provider: target.provider.id, model: body.model, kind: 'embeddings', status: r.status, ms: now() - started, input: j?.usage?.prompt_tokens || 0, output: 0 });
    res.writeHead(r.status, { 'content-type': 'application/json', ...CORS }); res.end(text);
  }

  // true when the request was a gateway request (handled here), false to let the dashboard handle it.
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!(p.startsWith('/v1/') || p.startsWith('/v1beta/') || p === '/mcp' || p === '/a2a' || p === '/.well-known/agent-card.json' || p === '/.well-known/agent.json' || p === '/skills' || p.startsWith('/skills/'))) return false;
    const format = p.startsWith('/v1/messages') ? 'anthropic' : p.startsWith('/v1beta/') ? 'gemini' : 'openai';
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
    try {
      // Agent skills: documentation for AI agents, served from this version; no key, nothing secret in them.
      if (p === '/skills' || p === '/skills/') { res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', ...CORS }); res.end(skills.index(`http://${req.headers.host || '127.0.0.1'}`)); return true; }
      const sk = p.match(/^\/skills\/([a-z0-9-]{1,40})(?:\/SKILL\.md)?$/);
      if (sk) { const text = skills.read(sk[1]); if (!text) throw new HttpError(404, `no skill "${sk[1]}"`); res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', ...CORS }); res.end(text); return true; }
      // Second brain, read only: titles, links and structure, never note text.
      const br = p.match(/^\/v1\/brain\/(sources|search|graph)$/);
      if (br && req.method === 'GET') { authed(req, 'rag'); if (!brain) throw new HttpError(503, 'the second brain is not available'); json(res, 200, await brainApi(br[1], url.searchParams)); return true; }
      // Agent card: public discovery (the gateway only listens on this machine); calls still need a key.
      if (p.startsWith('/.well-known/')) { if (req.method !== 'GET') throw new HttpError(405, 'GET the agent card'); json(res, 200, a2a.card(`http://${req.headers.host || '127.0.0.1'}`)); return true; }
      if (p === '/a2a') {
        if (req.method !== 'POST') throw new HttpError(405, 'POST JSON-RPC to /a2a; the agent card is at /.well-known/agent-card.json');
        const key = authed(req, 'agents');
        let body; try { body = await readJson(req); } catch (err) { json(res, 200, a2a.rpcError(null, err.status === 413 ? 'invalid' : 'parse', err.message)); return true; }
        const reply = await a2a.rpc(body, { key, ctx: ctxFor(key), res, headers: CORS });
        if (reply) json(res, 200, reply, { 'content-type': 'application/json' });
        return true;
      }
      if (p === '/mcp') {
        if (req.method !== 'POST') throw new HttpError(405, 'POST JSON-RPC to /mcp');
        authed(req, 'mcp');
        const body = await readJson(req);
        const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => mcp.handle(m)))).filter(Boolean);
        if (!replies.length) { res.writeHead(202, CORS); res.end(); return true; }
        json(res, 200, Array.isArray(body) ? replies : replies[0], { 'mcp-session-id': 'zaafpulse' });
        return true;
      }
      if (p === '/v1/models' && req.method === 'GET') { const key = authed(req, null); json(res, 200, { object: 'list', data: await modelsFor(key) }); return true; }
      if (p === '/v1/chat/completions' && req.method === 'POST') { const key = authed(req, null); await chatCompletion(req, res, key, await readJson(req)); return true; }
      // Claude Code, Codex and Gemini CLI: their own wire formats, translated to any provider.
      if (p === '/v1/messages' && req.method === 'POST') { const key = authed(req, 'llm'); await messagesApi(req, res, key, await readJson(req)); return true; }
      if (p === '/v1/messages/count_tokens' && req.method === 'POST') { authed(req, 'llm'); const b = await readJson(req); json(res, 200, { input_tokens: tr.estimateTokens({ system: b.system, messages: b.messages, tools: b.tools }) }); return true; }
      if ((p === '/v1/responses') && req.method === 'POST') { const key = authed(req, 'llm'); await responsesApi(req, res, key, await readJson(req)); return true; }
      if (p === '/v1beta/models' && req.method === 'GET') { const key = authed(req, 'llm'); json(res, 200, { models: (await modelsFor(key)).filter((m) => !m.id.startsWith('agent/') && !m.id.startsWith('collab/')).map((m) => ({ name: `models/${m.id}`, displayName: m.id, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] })) }); return true; }
      const gem = p.match(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/);
      if (gem && req.method === 'POST') {
        const key = authed(req, 'llm'); const body = await readJson(req); const model = decodeURIComponent(gem[1]);
        if (gem[2] === 'countTokens') { json(res, 200, { totalTokens: tr.estimateTokens(body.contents || body.generateContentRequest || body) }); return true; }
        await geminiApi(req, res, key, model, gem[2], body); return true;
      }
      if (p === '/v1/embeddings' && req.method === 'POST') { const key = authed(req, 'llm'); await embeddings(req, res, key, await readJson(req)); return true; }
      if (p === '/v1/agents' && req.method === 'GET') {
        const key = authed(req, 'agents');
        json(res, 200, { object: 'list', data: agents.enabled().filter((a) => agentAllowed(key)(a.id)).map((a) => ({ id: a.id, name: a.name, domain: a.domain, description: a.description, model: a.model || defaults().model })) }); return true;
      }
      const run = p.match(/^\/v1\/agents\/([a-z0-9-]+)\/run$/);
      if (run && req.method === 'POST') {
        const key = authed(req, 'agents'); const a = agents.get(run[1]);
        if (!a || !a.enabled) throw new HttpError(404, `no enabled agent "${run[1]}"`);
        if (!agentAllowed(key)(a.id)) throw new HttpError(403, `this key may not use agent "${a.id}"`, 'permission_error');
        const body = await readJson(req); if (!body.input) throw new HttpError(400, 'input is required');
        const o = sessions.open(body.session_id, { keyId: key.id, agent: a.id, title: body.input }); if (o.error) throw new HttpError(403, o.error, 'permission_error');
        const r = await realOrchestrator.runAgent(a, String(body.input), { ...ctxFor(key), session: o.session, history: o.session.messages });
        sessions.append(o.session, { role: 'user', content: body.input }, { role: 'assistant', content: r.text, agent: a.id });
        json(res, 200, { ...r, session_id: o.session.id }, { 'x-zp-session': o.session.id }); return true;
      }
      if (p === '/v1/orchestrate' && req.method === 'POST') {
        const key = authed(req, 'agents'); const body = await readJson(req); if (!body.task) throw new HttpError(400, 'task is required');
        const o = sessions.open(body.session_id, { keyId: key.id, agent: 'auto', title: body.task }); if (o.error) throw new HttpError(403, o.error, 'permission_error');
        const run = await runFor(key, { ...body, pattern: 'auto', task: String(body.task) }, { session: o.session });
        json(res, 200, { ...runReply(run), session_id: o.session.id }, { 'x-zp-session': o.session.id }); return true;
      }
      if (p === '/v1/collaborate' && req.method === 'POST') {
        const key = authed(req, 'agents'); const body = await readJson(req);
        const o = sessions.open(body.session_id, { keyId: key.id, agent: `collab:${body.pattern || 'auto'}`, title: body.task || body.input });
        if (o.error) throw new HttpError(403, o.error, 'permission_error');
        if (body.async) {
          const s = collab.start(body, { ...ctxFor(key), session: o.session });
          if (s.errors) throw new HttpError(s.errors.some((e) => /may not use/.test(e)) ? 403 : 400, s.errors.join('; '));
          s.done.catch(() => {}); json(res, 202, collab.summary(s.run), { 'x-zp-session': o.session.id }); return true;
        }
        const run = await runFor(key, body, { session: o.session });
        json(res, 200, { ...runReply(run), session_id: o.session.id }, { 'x-zp-session': o.session.id }); return true;
      }
      if (p === '/v1/runs' && req.method === 'GET') { const key = authed(req, 'agents'); json(res, 200, { object: 'list', data: collab.list({ keyId: key.id, contextId: url.searchParams.get('session_id') || undefined }).map(collab.summary) }); return true; }
      const runM = p.match(/^\/v1\/runs\/(run_[a-f0-9]+)(?:\/(cancel|resume))?$/);
      if (runM) {
        const key = authed(req, 'agents');
        if (!runM[2] && req.method === 'GET') { const r = collab.get(runM[1], key.id); if (!r) throw new HttpError(404, 'no such run'); json(res, 200, runReply(r)); return true; }
        if (runM[2] === 'cancel' && req.method === 'POST') { const c = collab.cancel(runM[1], key.id); if (c.error === 'not-found') throw new HttpError(404, 'no such run'); if (c.error) throw new HttpError(409, `the run is already ${c.run.state}`); json(res, 200, collab.summary(c.run)); return true; }
        if (runM[2] === 'resume' && req.method === 'POST') {
          const body = await readJson(req); const c = collab.resume(runM[1], { approve: body.approve !== false, note: body.note }, ctxFor(key));
          if (c.error === 'not-found') throw new HttpError(404, 'no such run'); if (c.error) throw new HttpError(409, `the run is ${c.run.state}, not waiting for approval`);
          json(res, 200, runReply(await c.done)); return true;
        }
      }
      if (p === '/v1/knowledge' && req.method === 'GET') { authed(req, 'rag'); json(res, 200, { object: 'list', data: knowledge.list() }); return true; }
      const kb = p.match(/^\/v1\/knowledge\/([a-z0-9-]+)\/(search|documents)$/);
      if (kb && req.method === 'POST') {
        authed(req, 'rag'); const body = await readJson(req);
        if (kb[2] === 'search') { if (!body.query) throw new HttpError(400, 'query is required'); const r = await knowledge.search(kb[1], String(body.query), Math.min(20, body.k || 5)); if (r.errors) throw new HttpError(404, r.errors[0]); json(res, 200, r); return true; }
        const r = await knowledge.ingest(kb[1], { title: body.title, content: body.content, kind: body.kind, source: body.source || 'api' }); if (r.errors) throw new HttpError(400, r.errors[0]); json(res, 200, r); return true;
      }
      if (p === '/v1/workflows' && req.method === 'GET') { authed(req, 'agents'); json(res, 200, { object: 'list', data: workflows.list() }); return true; }
      const wf = p.match(/^\/v1\/workflows\/([a-z0-9-]+)\/run$/);
      if (wf && req.method === 'POST') {
        const key = authed(req, 'agents'); const w = workflows.get(wf[1]); if (!w) throw new HttpError(404, `no workflow "${wf[1]}"`);
        const body = await readJson(req); if (!body.input) throw new HttpError(400, 'input is required');
        const run = await runFor(key, { ...body, pattern: 'workflow', workflow: w.id, task: String(body.input) });
        json(res, 200, { ...runReply(run), workflow: w.id }); return true;
      }
      if (p === '/v1/sessions' && req.method === 'GET') { const key = authed(req, 'agents'); json(res, 200, { object: 'list', data: sessions.list(key.id) }); return true; }
      const ses = p.match(/^\/v1\/sessions\/(ses_[a-f0-9]+)$/);
      if (ses) {
        const key = authed(req, 'agents');
        if (req.method === 'DELETE') { if (!sessions.remove(ses[1], key.id)) throw new HttpError(404, 'no such session'); json(res, 200, { id: ses[1], deleted: true }); return true; }
        const s = sessions.get(ses[1], key.id); if (!s) throw new HttpError(404, 'no such session');
        json(res, 200, { id: s.id, agent: s.agent, createdAt: s.createdAt, lastActive: s.lastActive, messages: s.messages }); return true;
      }
      throw new HttpError(404, `no gateway route ${req.method} ${p}`);
    } catch (err) {
      const e = err.status ? err : new HttpError(502, secrets.mask(err.message), 'upstream_error');
      if (!res.headersSent && (err.format || format) === 'anthropic') json(res, e.status, anthropicError(e.status, e.message), e.status === 429 && e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {});
      else if (!res.headersSent && format === 'gemini') json(res, e.status, { error: { code: e.status, message: e.message, status: e.status === 401 ? 'UNAUTHENTICATED' : e.status === 403 ? 'PERMISSION_DENIED' : e.status === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT' } });
      else if (!res.headersSent) fail(res, e);
      else res.end();
      return true;
    }
  }

  /* ---------- dashboard admin ---------- */
  const pubProvider = (p) => ({ id: p.id, preset: p.preset, baseUrl: p.baseUrl, models: p.models || [], aliases: p.aliases || {}, enabled: p.enabled !== false, tier: providers.tierOf(p), approved: providers.tierOf(p) === 'private' || p.approved !== false,
    format: providers.formatOf(p), auth: p.auth ? { type: p.auth.type, tokenUrl: p.auth.tokenUrl, clientId: p.auth.clientId, scope: p.auth.scope, grant: p.auth.grant } : { type: 'key' },
    apiKey: p.apiKey ? (p.apiKey.keychain ? { keychain: p.apiKey.keychain } : p.apiKey.env ? { env: p.apiKey.env } : null) : null });

  async function admin(route, method, body = {}) {
    const all = (getConfig() || {}).gateway || {};
    if (route === '' && method === 'GET') {
      return { presets: PRESETS, providers: (all.providers || []).map(pubProvider), defaults: defaults(), keys: keys.list(), agents: agents.list(), sessions: sessions.list(),
        memory: memory.list({ limit: 300 }), usage: usage.summary(), spend: Object.fromEntries(keys.list().map((k) => [k.id, usage.monthSpend(k.id)])), builtinTools: realOrchestrator.BUILTIN_TOOLS.map((t) => t.name).concat(realOrchestrator.extraTools),
        routes: providers.routes(), knowledge: knowledge.list(), workflows: workflows.list(), workflowCatalog: workflows.catalog(), patterns: collab.PATTERNS, effort: collab.EFFORT, runs: collab.list({ limit: 40 }).map(collab.summary),
        skills: skills.list(), quota: providers.quota(), tools: codeTools.list(baseUrl).map((t) => ({ ...t, snippet: codeTools.snippet(t.id, baseUrl, 'zp_YOUR_KEY', defaults().codeModel || defaults().model || '') })), baseUrl, settings: { tokenSaver: gwcfg().tokenSaver !== false, modelMap: gwcfg().modelMap || [] } };
    }
    if (route === 'logs') return { entries: usage.recent(300) };
    if (route === 'keys') {
      if (body.action === 'create') return keys.create(body);
      if (body.action === 'update') return keys.update(body.id, body);
      if (body.action === 'revoke') return keys.revoke(body.id);
      if (body.action === 'delete') return keys.remove(body.id);
    }
    if (route === 'providers') {
      const list = all.providers || [];
      if (body.action === 'save') {
        const existing = list.find((p) => p.id === (body.originalId || body.id));
        const { errors, value } = cleanProvider(body, existing);
        if (errors.length) return { errors };
        if (!existing && list.some((p) => p.id === value.id)) return { errors: [`a provider called "${value.id}" already exists`] };
        try { value.apiKey = body.secret ? resolveSecret(value.id, body.secret, existing && existing.apiKey) : existing ? existing.apiKey : undefined; } catch (err) { return { errors: [err.message] }; }
        if (!value.apiKey) delete value.apiKey;
        const next = existing ? list.map((p) => (p === existing ? value : p)) : [...list, value];
        writeGatewayConfig({ ...all, providers: next });
        return { provider: pubProvider(value), test: await providers.test(value) };
      }
      if (body.action === 'delete') { writeGatewayConfig({ ...all, providers: list.filter((p) => p.id !== body.id) }); return { id: body.id }; }
      const p = list.find((x) => x.id === body.id); if (!p) return { errors: ['no such provider'] };
      if (body.action === 'test') return providers.test(p);
      if (body.action === 'models') { try { return { models: await providers.models(p, true) }; } catch (err) { return { errors: [secrets.mask(err.message)] }; } }
    }
    if (route === 'routes') {
      const list = all.routes || [];
      if (body.action === 'save') { const { errors, value } = cleanRoute(body); if (errors.length) return { errors }; const next = [...list.filter((r) => r.name !== (body.originalName || value.name)), value]; writeGatewayConfig({ ...all, routes: next }); return { route: value }; }
      if (body.action === 'delete') { writeGatewayConfig({ ...all, routes: list.filter((r) => r.name !== body.name) }); return { name: body.name }; }
    }
    if (route === 'approve') {
      const list = all.providers || []; const p = list.find((x) => x.id === body.id); if (!p) return { errors: ['no such provider'] };
      writeGatewayConfig({ ...all, providers: list.map((x) => (x === p ? { ...x, approved: body.approved !== false } : x)) }); return { id: p.id, approved: body.approved !== false };
    }
    if (route === 'knowledge') {
      if (body.action === 'create') return knowledge.create(body);
      if (body.action === 'update') return knowledge.update(body.id, body);
      if (body.action === 'delete') return knowledge.remove(body.id) ? { id: body.id } : { errors: ['no such knowledge base'] };
      if (body.action === 'get') return knowledge.get(body.id) || { errors: ['no such knowledge base'] };
      if (body.action === 'ingest') return knowledge.ingest(body.id, body);
      if (body.action === 'ingest-url') {
        if (!/^https?:\/\/[^\s]+$/.test(body.url || '')) return { errors: ['url must start with http:// or https://'] };
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
        try { const r = await fetch(body.url, { signal: ctl.signal, headers: { accept: 'text/html,text/plain,application/json' } }); if (!r.ok) return { errors: [`HTTP ${r.status} from ${body.url}`] };
          const type = r.headers.get('content-type') || ''; const text = await r.text();
          return knowledge.ingest(body.id, { title: body.title || body.url, content: text, kind: /html/.test(type) ? 'html' : /json/.test(type) ? 'json' : 'text', source: body.url });
        } catch (err) { return { errors: [err.name === 'AbortError' ? 'timed out' : err.message] }; } finally { clearTimeout(t); }
      }
      if (body.action === 'remove-doc') return knowledge.removeDoc(body.id, body.docId) ? { ok: true } : { errors: ['no such document'] };
      if (body.action === 'reindex') { try { return await knowledge.reindex(body.id); } catch (err) { return { errors: [err.message] }; } }
      if (body.action === 'search') return knowledge.search(body.id, String(body.query || ''), body.k || 5);
    }
    if (route === 'workflows') {
      if (body.action === 'save') return workflows.save(body);
      if (body.action === 'delete') return workflows.remove(body.id) ? { id: body.id } : { errors: ['no such workflow'] };
      if (body.action === 'restore') { const w = workflows.restore(body.id); return w ? { workflow: w } : { errors: ['not a built-in workflow'] }; }
      if (body.action === 'run') { const w = workflows.get(body.id); if (!w) return { errors: ['no such workflow'] }; const r = await collab.run({ pattern: 'workflow', workflow: w.id, task: String(body.input || '') }, {}); return r.errors ? r : { ...runReply(r.run), workflow: w.id }; }
    }
    if (route === 'collab') {
      // The dashboard starts runs without waiting and polls them (runs as the dashboard: no key, no key budget).
      if (body.action === 'start') { const s = collab.start(body, { session: body.sessionId ? sessions.get(body.sessionId) : null }); if (s.errors) return s; s.done.catch(() => {}); return { run: s.run }; }
      if (body.action === 'get') { const r = collab.get(body.id); return r ? { run: r } : { errors: ['no such run'] }; }
      if (body.action === 'list') return { runs: collab.list({ limit: 100 }).map(collab.summary) };
      if (body.action === 'cancel') { const c = collab.cancel(body.id); return c.error ? { errors: [c.error === 'not-found' ? 'no such run' : `the run is already ${c.run.state}`] } : { run: c.run }; }
      if (body.action === 'resume') { const c = collab.resume(body.id, { approve: body.approve !== false, note: body.note }, {}); if (c.error) return { errors: [c.error === 'not-found' ? 'no such run' : 'the run is not waiting for approval'] }; c.done.catch(() => {}); return { run: c.run }; }
    }
    if (route === 'defaults') { writeGatewayConfig({ ...all, defaults: { model: String(body.model || '').trim(), plannerModel: String(body.plannerModel || '').trim(), codeModel: String(body.codeModel ?? defaults().codeModel ?? '').trim() } }); return { defaults: defaults() }; }
    if (route === 'settings') {
      // Token saver on/off and the model map for tool clients ({ match: "claude-*", to: "router/coding" }).
      const modelMap = Array.isArray(body.modelMap) ? body.modelMap.map((m) => ({ match: String(m.match || '').trim().slice(0, 80), to: String(m.to || '').trim().slice(0, 120) })).filter((m) => m.match && m.to).slice(0, 30) : all.modelMap || [];
      writeGatewayConfig({ ...all, tokenSaver: body.tokenSaver === undefined ? all.tokenSaver !== false : body.tokenSaver !== false, modelMap });
      return { settings: { tokenSaver: (getConfig().gateway || {}).tokenSaver !== false, modelMap } };
    }
    if (route === 'quota') {
      // Balances are fetched on request (OpenRouter, DeepSeek, Moonshot, SiliconFlow); rate limits come from answers.
      await Promise.all(providers.list().filter((p) => providers.usable(p) && PRESETS[p.preset] && PRESETS[p.preset].balance).map((p) => providers.balance(p)));
      return { quota: providers.quota() };
    }
    if (route === 'skills') {
      if (body.action === 'install') return skills.install();
      if (body.action === 'uninstall') return skills.uninstall();
      // One key for agents using the skills (all four scopes), shown once with the two exports they need.
      if (body.action === 'key') { const made = keys.create({ name: 'tool:skills', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 600 }); if (made.errors) return made; return { secret: made.secret, snippet: `export ZAAFPULSE_URL=${baseUrl}\nexport ZAAFPULSE_KEY=${made.secret}` }; }
    }
    if (route === 'tools') {
      const t = codeTools.TOOLS.find((x) => x.id === body.id);
      if (!t) return { errors: ['no such tool'] };
      if (t.unsupported) return { errors: [t.unsupported] };
      const model = String(body.model || defaults().codeModel || defaults().model || '').trim();
      if (body.action === 'revert') {
        const r = codeTools.revert(t.id); if (r.errors) return r;
        for (const k of keys.list()) if (k.name === `tool:${t.id}` && !k.revokedAt) keys.revoke(k.id); // the tool's key goes with it
        return r;
      }
      if (body.action === 'apply' || body.action === 'key') {
        // One key per tool (llm scope), so a tool can be cut off without touching anything else.
        const made = keys.create({ name: `tool:${t.id}`, scopes: ['llm'], rpm: 600 }); if (made.errors) return made;
        if (body.action === 'key') return { secret: made.secret, snippet: codeTools.snippet(t.id, baseUrl, made.secret, model) };
        try { const r = codeTools.apply(t.id, baseUrl, made.secret, model); if (r.errors) { keys.remove(made.key.id); return r; } return { ...r, key: made.key }; } catch (err) { keys.remove(made.key.id); return { errors: [err.message] }; }
      }
    }
    if (route === 'agents') {
      if (body.action === 'save') return agents.save(body);
      if (body.action === 'delete') return agents.remove(body.id) ? { id: body.id } : { errors: ['no such agent'] };
      if (body.action === 'reset') return agents.reset(body.id) ? { agent: agents.get(body.id) } : { errors: ['not a template'] };
    }
    if (route === 'sessions') {
      if (body.action === 'get') { const s = sessions.get(body.id); return s ? { session: s } : { errors: ['no such session'] }; }
      if (body.action === 'delete') return sessions.remove(body.id) ? { id: body.id } : { errors: ['no such session'] };
    }
    if (route === 'memory') {
      if (body.action === 'save') return memory.save({ text: body.text, scope: body.scope || 'global', source: 'dashboard' });
      if (body.action === 'delete') return memory.remove(body.id) ? { id: body.id } : { errors: ['no such note'] };
    }
    if (route === 'playground') {
      // Runs as the dashboard (no key, no budget); only on an explicit click, because it spends tokens.
      const o = sessions.open(body.sessionId, { keyId: 'dashboard', agent: body.mode === 'agent' ? body.agent : 'auto', title: body.input });
      if (body.mode === 'orchestrate') { const r = await collab.run({ pattern: 'auto', task: String(body.input || '') }, { session: o.session }); return r.errors ? r : { ...runReply(r.run), answer: r.run.answer || r.run.error || '' }; }
      if (body.mode === 'agent') {
        const a = agents.get(body.agent); if (!a) return { errors: ['no such agent'] };
        const r = await realOrchestrator.runAgent(a, String(body.input || ''), { keyId: null, session: o.session, history: o.session.messages });
        sessions.append(o.session, { role: 'user', content: body.input }, { role: 'assistant', content: r.text, agent: a.id });
        return { ...r, sessionId: o.session.id };
      }
      const r = await llm({ model: body.model, messages: [{ role: 'user', content: String(body.input || '') }], keyId: null, agent: 'playground' });
      return { text: (r.message && r.message.content) || '', usage: r.usage };
    }
    return { errors: [`unknown gateway admin route ${method} ${route}`] };
  }

  return { setBrain: (b) => { brain = b; }, skills, handle, admin, keys, providers, usage, sessions, memory, agents, knowledge, workflows, embed, collab, a2a, orchestrator: realOrchestrator, flush: () => [keyStore, agentStore, sessionStore, memoryStore, workflowStore, runStore].forEach((s) => s.flush()) };
}

module.exports = { createGateway, HttpError };
