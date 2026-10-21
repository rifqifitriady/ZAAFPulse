// The HTTP side of the local evals: /api/evals/* and /api/feedback. server.js puts this behind the dashboard
// sign-in and sends what `route` returns; nothing here touches the socket. A client names a session by its opaque
// trace key (never a raw session id), results carry labels and a capped explanation, and the only route that
// returns transcript text is the preview, which shows the masked prompt the owner is about to allow.
const R = require('./registry');
const { buildPrompt } = require('./judge');
const { externalSystem } = require('./models');

const DAY = 86400e3;
const MAX_VALUE = 512; // nothing a client sends for a key, a provider or a range is longer than this
const MAX_MODEL = 200;
const MAX_TURN = 1e6;
const MAX_MODELS = 500;
const LOCAL = ['auto', 'ollama', 'lmstudio'];
const JUDGES = R.EVALUATORS.filter((e) => e.kind === 'judge');
const SETTINGS = ['judge', 'provider', 'model', 'dailyCap', 'costCapUSD', 'evaluators'];

const fail = (status, message) => Object.assign(new Error(message), { status });
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const reply = (status, body) => ({ status, body });
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// A query value that must be a whole number >= 0 (a turn): undefined when absent, NaN when bad.
const wholeParam = (v) => (v == null || v === '' ? undefined : /^\d{1,15}$/.test(v) ? Number(v) : NaN);

function createEvalApi({ trace, engine, feedback, gateway, settings, contentOff = false, now = Date.now } = {}) {
  // ---- settings: what is stored, and what the engine and the page see ----
  const stored = () => {
    const s = settings.get();
    return isObject(s) ? s : {};
  };
  function current() {
    const s = stored();
    const on = isObject(s.evaluators) ? s.evaluators : {};
    return {
      judge: s.judge !== false,
      provider: typeof s.provider === 'string' && s.provider ? s.provider : 'auto',
      model: typeof s.model === 'string' ? s.model : '',
      dailyCap: num(s.dailyCap, 500),
      costCapUSD: num(s.costCapUSD, 1),
      evaluators: Object.fromEntries(JUDGES.map((e) => [e.id, on[e.id] !== false])),
      externalConfirmed: typeof s.externalConfirmed === 'string' && s.externalConfirmed ? s.externalConfirmed : null,
    };
  }
  // The local kinds, then every usable gateway provider. The gateway's own safe view: ids, labels and model
  // names, never an address or a key.
  function providers() {
    const out = [
      { id: 'auto', label: 'Automatic (local first)', kind: 'auto', models: [] },
      { id: 'ollama', label: 'Ollama', kind: 'local', models: [] },
      { id: 'lmstudio', label: 'LM Studio', kind: 'local', models: [] },
    ];
    for (const p of (gateway && gateway.judge && gateway.judge.providers()) || []) {
      if (LOCAL.includes(p.id)) continue;
      const models = Array.isArray(p.models) ? p.models.filter((m) => typeof m === 'string').slice(0, MAX_MODELS) : [];
      out.push({ id: p.id, label: String(p.label || p.id), kind: 'external', models });
    }
    return out;
  }
  const isExternal = (id) => typeof id === 'string' && providers().some((p) => p.kind === 'external' && p.id === id);

  // The changes in a settings request, or a 400. Only the named settings count; a typo is refused, not ignored.
  function parseSettings(body) {
    if (!isObject(body)) throw fail(400, 'bad request body');
    for (const k of Object.keys(body)) if (!SETTINGS.includes(k)) throw fail(400, 'unknown setting');
    const patch = {};
    if (body.judge !== undefined) {
      if (typeof body.judge !== 'boolean') throw fail(400, 'judge must be true or false');
      patch.judge = body.judge;
    }
    if (body.provider !== undefined) {
      const p = body.provider;
      if (typeof p !== 'string' || p.length > MAX_VALUE) throw fail(400, 'bad provider');
      if (!LOCAL.includes(p) && !isExternal(p)) throw fail(400, 'unknown provider');
      patch.provider = p;
    }
    if (body.model !== undefined) {
      if (typeof body.model !== 'string' || body.model.length > MAX_MODEL)
        throw fail(400, 'model must be text up to 200 characters');
      patch.model = body.model;
    }
    if (body.dailyCap !== undefined) {
      const n = body.dailyCap;
      if (!(Number.isInteger(n) && n >= 1 && n <= 10000))
        throw fail(400, 'dailyCap must be a whole number from 1 to 10000');
      patch.dailyCap = n;
    }
    if (body.costCapUSD !== undefined) {
      const n = body.costCapUSD;
      if (!(typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100))
        throw fail(400, 'costCapUSD must be from 0 to 100');
      patch.costCapUSD = n;
    }
    if (body.evaluators !== undefined) {
      if (!isObject(body.evaluators)) throw fail(400, 'evaluators must be an object');
      const ev = {};
      for (const [id, on] of Object.entries(body.evaluators)) {
        // Code evaluators always run; only a judge evaluator can be switched.
        if (!JUDGES.some((e) => e.id === id)) throw fail(400, 'unknown evaluator');
        if (typeof on !== 'boolean') throw fail(400, 'an evaluator is true or false');
        ev[id] = on;
      }
      patch.evaluators = ev;
    }
    return patch;
  }

  function saveSettings(patch) {
    const old = stored();
    const next = { ...old, ...patch };
    if (patch.evaluators) {
      next.evaluators = { ...(isObject(old.evaluators) ? old.evaluators : {}), ...patch.evaluators };
    }
    // A confirmation belongs to one provider: choosing another one asks for a new preview.
    if (patch.provider !== undefined && patch.provider !== current().provider) delete next.externalConfirmed;
    settings.save(next);
    engine.kick();
  }

  // ---- shapes ----
  // A result for the page: no session id, no target. An explanation comes from a model reading the text, so it is
  // hidden with the rest of the content when content viewing is off; the label and score stay.
  function resultRow(r) {
    const e = R.get(r.evaluator);
    if (!e || !r.target) return null;
    const j = isObject(r.judge) ? r.judge : null;
    return {
      evaluator: e.id,
      kind: e.kind,
      scope: e.scope,
      turn: Number.isInteger(r.target.turn) ? r.target.turn : null,
      label: r.label,
      score: num(r.score, null),
      pass: r.label === e.pass,
      explanation: !contentOff && typeof r.explanation === 'string' ? r.explanation : null,
      judge: j ? { kind: j.kind || null, model: j.model || null, provider: j.provider || null } : null,
      trimmed: !!r.trimmed,
      evidence: Array.isArray(r.evidence)
        ? r.evidence.slice(0, 5).map((x) => ({ tool: (x && x.tool) || null, label: (x && x.label) || null }))
        : [],
      ts: num(r.ts, null),
    };
  }
  const feedbackRow = (f) => ({
    id: f.id,
    turn: Number.isInteger(f.target.turn) ? f.target.turn : null,
    rating: f.rating,
    note: f.note,
    ts: f.ts,
    updatedAt: f.updatedAt,
  });

  // ---- query and body checks ----
  function target(q) {
    for (const k of ['key', 'turn', 'range']) {
      if ((q.get(k) || '').length > MAX_VALUE) throw fail(400, 'query value too long');
    }
    const turn = wholeParam(q.get('turn'));
    if (Number.isNaN(turn) || turn > MAX_TURN) throw fail(400, 'bad turn');
    const { source, sid } = trace.sourceOf(q.get('key'));
    return { source, session: sid, turn };
  }
  const keyOf = (body) => {
    if (typeof body.key !== 'string' || !body.key) throw fail(400, 'session key required');
    if (body.key.length > MAX_VALUE) throw fail(400, 'key too long');
    return body.key;
  };

  // ---- routes ----
  function results(q) {
    const t = target(q);
    const rows = engine.results(t.turn === undefined ? { source: t.source, session: t.session } : t);
    return reply(200, { results: rows.map(resultRow).filter(Boolean) });
  }
  function summary(q) {
    const days = wholeParam(q.get('range'));
    if (Number.isNaN(days)) throw fail(400, 'bad range');
    const range = days === undefined ? 7 : Math.min(30, Math.max(1, days));
    return reply(200, engine.summary({ from: now() - range * DAY }));
  }
  async function run(body) {
    const { source, sid } = trace.sourceOf(keyOf(body));
    return reply(200, await engine.enqueueSession(source, sid));
  }
  // A turn the session does not have is a client mistake, not a record to keep.
  const hasTurn = async (key, turn) => turn < (await trace.turnsOf(key)).length;
  async function feedbackGet(q) {
    const t = target(q);
    if (t.turn === undefined) {
      return reply(200, { feedback: feedback.forSession(t.source, t.session).map(feedbackRow) });
    }
    if (!(await hasTurn(q.get('key'), t.turn))) return reply(200, { feedback: [] });
    const f = feedback.get(R.targetKey({ source: t.source, session: t.session, turn: t.turn, span: null }));
    return reply(200, { feedback: f ? [feedbackRow(f)] : [] });
  }
  async function feedbackPost(body) {
    const key = keyOf(body);
    const { source, sid } = trace.sourceOf(key);
    const turn = body.turn === undefined || body.turn === null ? null : body.turn;
    if (turn !== null && !(Number.isInteger(turn) && turn >= 0 && turn <= MAX_TURN)) throw fail(400, 'bad turn');
    if (turn !== null && !(await hasTurn(key, turn))) throw fail(400, 'bad turn');
    // The store checks the rating and the note (at most 2,000 characters) and keeps what is omitted.
    const rec = feedback.set({
      target: { source, session: sid, turn, span: null },
      rating: body.rating,
      note: body.note,
    });
    return reply(200, rec ? feedbackRow(rec) : { cleared: true });
  }
  const settingsGet = () => reply(200, { ...current(), providers: providers() });
  function settingsPost(body) {
    saveSettings(parseSettings(body));
    return settingsGet();
  }

  // The exact masked text that would go to a provider, for the latest finished turn of the session and the first
  // judge evaluator that is switched on. Showing it is what confirms the provider: only after the text was built
  // does the setting change, and the engine sends nothing to that provider before. It is for the provider the
  // owner has selected, so the setting is saved first.
  async function preview(body) {
    const key = keyOf(body);
    const provider = body.provider;
    if (typeof provider !== 'string' || provider.length > MAX_VALUE || !isExternal(provider))
      throw fail(400, 'provider must be a configured external provider');
    if (provider !== current().provider) throw fail(400, 'save this provider in the settings first');
    // The text is transcript content: while content viewing is off, nobody reads it here.
    if (contentOff) throw fail(403, 'content viewing is off');
    const { source, sid } = trace.sourceOf(key);
    const on = current().evaluators;
    const evaluator = JUDGES.find((e) => e.scope === 'turn' && on[e.id]);
    if (!evaluator) throw fail(400, 'no turn evaluator is switched on');
    // The turn the engine would judge: a turn still running is not shown.
    const latest = await engine.latestFinishedTurn(source, sid);
    if (latest === null) throw fail(400, 'no finished turn yet');
    const m = await trace.material(source, sid, latest);
    if (!m) throw fail(400, 'this session has no text to judge');
    const built = buildPrompt(evaluator, m.material);
    saveSettings({ externalConfirmed: provider });
    // The system text as an external provider receives it, with the schema line the models adapter adds.
    return reply(200, {
      system: externalSystem(built.system, built.schema),
      user: built.user,
      evaluator: evaluator.id,
      turn: m.target.turn,
    });
  }

  const GET = {
    '/api/evals': (q) => results(q),
    '/api/evals/summary': (q) => summary(q),
    '/api/evals/status': async () => reply(200, await engine.status()),
    '/api/evals/settings': () => settingsGet(),
    '/api/feedback': (q) => feedbackGet(q),
  };
  const POST = {
    '/api/evals/run': run,
    '/api/evals/settings': settingsPost,
    '/api/evals/preview': preview,
    '/api/feedback': feedbackPost,
  };

  // `req` is { method, path, query, contentType, readBody }. Returns { status, body }, or null when the path is
  // not an eval route, so server.js can go on to the next one.
  async function route(req) {
    const p = req.path;
    if (p !== '/api/feedback' && p !== '/api/evals' && !p.startsWith('/api/evals/')) return null;
    if (!Object.hasOwn(GET, p) && !Object.hasOwn(POST, p)) return reply(404, { error: 'unknown route' });
    const post = Object.hasOwn(POST, p) && req.method === 'POST';
    if (!(post || (Object.hasOwn(GET, p) && req.method === 'GET'))) return reply(405, { error: 'method not allowed' });
    try {
      if (!post) return await GET[p](req.query);
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
      let body;
      try {
        body = JSON.parse(await req.readBody());
      } catch (e) {
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      if (!isObject(body)) return reply(400, { error: 'bad request body' });
      return await POST[p](body);
    } catch (e) {
      const status = e && e.status;
      // A message with a status is ours or the trace registry's and holds no path; anything else is a plain 500.
      if (Number.isInteger(status) && status >= 400 && status <= 599) return reply(status, { error: e.message });
      return reply(500, { error: 'eval request failed' });
    }
  }

  return { route, settings: current };
}

module.exports = { createEvalApi };
