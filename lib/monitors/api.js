// The HTTP side of the monitors: /api/monitors/*, /api/alerts and /api/agents/*. server.js puts this behind the
// dashboard sign-in (never a gateway API key, MCP or A2A) and sends what `route` returns; nothing here touches the
// socket. No response carries a raw session id or a file path: a session is named by its opaque trace key, a rule
// instance by an id that means nothing outside this server, and a candidate's folder and command start at ~ and are
// clipped. Every agent action comes from the owner (`by: 'owner'`); the control module checks the target again.
const crypto = require('crypto');
const { RULES, ruleById } = require('./rules');
const { isRef } = require('../secrets');
const { detectDocker, sameProcess } = require('../agents/control');
const { isEndedSession } = require('./index');

const MAX_VALUE = 512; // nothing a client sends for a key or a query value is longer than this
const MAX_SECRET = 4096; // a pasted webhook URL or header list
const MAX_SHOWN = 200; // a candidate's folder and command, as shown
const MAX_ALERTS = 500;
const SNOOZE = { '1h': 3600e3, '1d': 86400e3 };
const SOURCES = ['claude', 'codex']; // the sources an alert's session can come from (the live office has these two)
// Bounds per parameter; `above` means the value must be more than `min`. An integer parameter is a count.
const PARAM_RANGE = {
  limitUSD: { min: 0, max: 1e6 }, // 0: the daily limit comes from the monthly budget
  maxUSD: { min: 0, max: 1e6 },
  maxCalls: { min: 1, max: 1e6, int: true },
  stuckMin: { min: 0, max: 1440, above: true },
  dropPoints: { min: 0, max: 100 },
  minPassRate: { min: 0, max: 1 },
  minSamples: { min: 1, max: 1e6, int: true },
  windowMin: { min: 0, max: 1440, above: true },
};
const RULE_FIELDS = ['enabled', 'params', 'autoPause', 'snooze', 'instance'];
const CHANNEL_FIELDS = ['desktop', 'webhookRef', 'webhookHeadersRef'];
const ACTION_FIELDS = ['key', 'pid', 'startTime', 'confirm'];
const SECRET_MODES = ['store', 'keep', 'none', 'keychain', 'env'];
const ACTIONS = ['pause', 'resume', 'stop'];
const TASKKILL_HINT = 'Windows asked the app to close and it did not. Close it from its own window.';

const fail = (status, message) => Object.assign(new Error(message), { status });
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const reply = (status, body) => ({ status, body });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const wholeParam = (v) => (v == null || v === '' ? undefined : /^\d{1,15}$/.test(v) ? Number(v) : NaN);
const onlyFields = (body, allowed) => {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw fail(400, `unknown field: ${k.slice(0, 40)}`);
};
// Absolute paths in a message from elsewhere (a secret store, the network stack) become [path].
const PATHLIKE = /(?:[A-Za-z]:\\[^\s"'`]*|(?<![\w:/.])\/(?:[\w.@~-]+\/)+[\w.@~-]*)/g;

function createMonitorApi({
  state,
  monitors,
  channels,
  control,
  trace,
  // (source, sid) -> { cwd, first } of an indexed session, or null.
  sessionInfo = () => null,
  // { get() -> { desktop, webhook: { url, headers? } | null, problem }, save({ desktop, webhook }) }
  channelSettings,
  // (field 'url' | 'headers', input, current) -> a secret reference or undefined (lib/integration-config secretResolver)
  resolveSecret,
  checkUrl = () => {},
  checkHeaders = () => {},
  demo = null, // { candidates(source, sid), paused } in demo mode
  // Agent control is refused: 'server' (server mode or password sign-in; true means the same) or 'no-sign-in'.
  agentsOff = false,
  // In a container agent control is refused too (lib/agents/control.js): true/false, a function, or undefined to
  // look once, on first use, the same way the control module does.
  inDocker,
  notifyOff = false, // ZAAFPULSE_NOTIFY=off: the test button sends nothing
  home = '',
  platform = process.platform,
  // rule ids replaced by budgets (server.js): not listed, not counted, not changed
  retired = [],
  now = Date.now,
} = {}) {
  const RETIRED = new Set(retired);
  const active = () => RULES.filter((r) => !RETIRED.has(r.id));
  const salt = crypto.randomBytes(16);
  let docker = inDocker;
  const dockerOn = () => {
    if (docker === undefined) docker = detectDocker();
    return typeof docker === 'function' ? !!docker() : !!docker;
  };
  // Why agent control is off here, or null when it is on: 'server' (server mode or password sign-in),
  // 'no-sign-in' (ZAAFPULSE_AUTH=none) or 'docker'. Demo mode signals nothing, so a demo in a container still shows
  // the controls.
  const offReason = () =>
    agentsOff === 'no-sign-in' ? 'no-sign-in' : agentsOff ? 'server' : !demo && dockerOn() ? 'docker' : null;
  const OFF_TEXT = {
    server: 'agent control is off on this server',
    'no-sign-in': 'agent control is off without a dashboard sign-in',
    docker: 'agent control is off in Docker',
  };
  // The 403 of the agent routes: server mode keeps its own wording.
  const actOffText = (reason) => (reason === 'server' ? 'agent control is off in server mode' : OFF_TEXT[reason]);
  const scrub = (msg) => {
    let s = String(msg == null ? '' : msg);
    if (home && home.length > 1) s = s.split(home).join('~');
    return s.replace(PATHLIKE, '[path]').slice(0, 300);
  };
  // Shown to the owner: the home folder as ~, one line, clipped.
  const shown = (v) => {
    if (typeof v !== 'string') return null;
    let s = v;
    if (home && home.length > 1) {
      if (platform === 'win32') s = s.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '~');
      else s = s.split(home).join('~');
    }
    return s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_SHOWN);
  };

  // A rule instance as the page names it: 'all' for an aggregate rule, else an id derived from the session (or the
  // budget, whatever its id) that cannot be turned back into it.
  const instanceId = (rule, instance) =>
    instance === 'all' && rule !== 'budget'
      ? 'all'
      : crypto.createHmac('sha256', salt).update(`${rule}|${instance}`).digest('hex').slice(0, 20);

  // The trace key of a raw session id, or null when the explorer does not list it. One request asks once per id.
  // A poll never forces the trace listing to be rebuilt: a session not listed yet has no key until the next listing.
  function keyMemo() {
    const memo = new Map();
    return (sid) => {
      if (typeof sid !== 'string' || !sid) return null;
      if (memo.has(sid)) return memo.get(sid);
      let key = null;
      for (const source of SOURCES) {
        try {
          key = trace.keyFor(source, sid, { rebuild: false });
          if (key) break;
        } catch {
          key = null;
        }
      }
      memo.set(sid, key);
      return key;
    };
  }

  // ---- rules ----
  // A live session that ended (not seen for a minute) is left off the cards and the counts; its alerts stay. The demo
  // store is seeded once and no pass ever updates it, so nothing in it ends.
  const shownStates = () => {
    if (demo) return state.states();
    const t = now();
    return state.states().filter((e) => !isEndedSession(e, t));
  };

  function ruleRow(rule, all, keyOf) {
    const s = state.settings(rule.id);
    const until = state.ruleSnooze(rule.id);
    const instances = s.enabled
      ? all
          .filter((e) => e.rule === rule.id)
          .map((e) => ({
            instance: instanceId(rule.id, e.instance),
            sessionKey: rule.kind === 'live' ? keyOf(e.sessionId) : null,
            title: e.title || null,
            state: e.state,
            value: isNum(e.value) ? e.value : null,
            threshold: isNum(e.threshold) ? e.threshold : null,
            since: isNum(e.since) && e.since > 0 ? e.since : null,
            snoozedUntil: e.snoozeUntil || null,
          }))
      : [];
    const has = (st) => instances.some((i) => i.state === st);
    let overall = 'no_data';
    if (!s.enabled) overall = 'off';
    else if (until) overall = 'snoozed';
    else if (has('triggered')) overall = 'triggered';
    else if (has('ok')) overall = 'ok';
    else if (instances.length && instances.every((i) => i.state === 'snoozed')) overall = 'snoozed';
    return {
      id: rule.id,
      title: rule.title,
      describe: rule.describe,
      kind: rule.kind,
      enabled: s.enabled,
      params: { ...rule.params, ...s.params },
      defaults: { ...rule.params },
      autoPause: s.autoPause,
      // With agent control off no rule may pause an agent, so the page hides the setting.
      mayAutoPause: rule.mayAutoPause && !offReason(),
      state: overall,
      snoozedUntil: until,
      instances,
    };
  }

  function channelsView() {
    let c = {};
    try {
      c = channelSettings.get() || {};
    } catch {
      c = {};
    }
    const w = c.webhook;
    return {
      desktop: c.desktop !== false,
      webhook: { configured: !!w, headers: !!(w && w.headers), problem: c.problem || null },
      // false in demo mode and with ZAAFPULSE_NOTIFY=off: nothing is sent, whatever the settings say.
      sending: !demo && !notifyOff,
    };
  }

  function list() {
    const all = shownStates();
    const keyOf = keyMemo();
    return reply(200, { rules: active().map((r) => ruleRow(r, all, keyOf)), channels: channelsView() });
  }

  function checkParams(rule, params) {
    if (!isObject(params)) throw fail(400, 'params must be an object');
    for (const [k, v] of Object.entries(params)) {
      if (!Object.hasOwn(rule.params, k)) throw fail(400, `unknown parameter: ${k.slice(0, 40)}`);
      if (v === null) continue; // back to the default
      const r = PARAM_RANGE[k];
      const okNum = isNum(v) && v <= r.max && (r.above ? v > r.min : v >= r.min) && (!r.int || Number.isInteger(v));
      if (!okNum) {
        const what = r.int ? 'a whole number' : 'a number';
        throw fail(
          400,
          `${k} must be ${what} ${r.above ? 'above' : 'from'} ${r.min} ${r.above ? 'up to' : 'to'} ${r.max}`,
        );
      }
    }
  }

  function setRule(id, body) {
    if (RETIRED.has(id)) throw fail(410, `${id} is replaced by budgets (docs/cost.md#budgets)`);
    const rule = RULES.find((r) => r.id === id);
    if (!rule) throw fail(404, 'unknown rule');
    onlyFields(body, RULE_FIELDS);
    const patch = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw fail(400, 'enabled must be true or false');
      patch.enabled = body.enabled;
    }
    if (body.params !== undefined) {
      checkParams(rule, body.params);
      // The stored parameters are replaced as a whole by state.js: keep the others the owner set.
      patch.params = { ...state.settings(id).params, ...body.params };
    }
    if (body.autoPause !== undefined) {
      if (typeof body.autoPause !== 'boolean') throw fail(400, 'autoPause must be true or false');
      if (body.autoPause && !rule.mayAutoPause) throw fail(400, `${id} cannot pause an agent`);
      if (body.autoPause && offReason()) throw fail(409, OFF_TEXT[offReason()]);
      patch.autoPause = body.autoPause;
    }
    let snooze;
    if (body.snooze !== undefined) {
      if (body.snooze !== null && !Object.hasOwn(SNOOZE, body.snooze))
        throw fail(400, "snooze must be '1h', '1d' or null");
      snooze = { ms: body.snooze === null ? 0 : SNOOZE[body.snooze], instance: null };
    }
    if (body.instance !== undefined && body.instance !== null) {
      if (!snooze) throw fail(400, 'instance goes with snooze');
      if (typeof body.instance !== 'string' || body.instance.length > 64) throw fail(400, 'bad instance');
      const e = state.states().find((x) => x.rule === id && instanceId(id, x.instance) === body.instance);
      if (!e) throw fail(404, 'unknown instance');
      snooze.instance = e.instance;
    }
    if (!Object.keys(patch).length && !snooze) throw fail(400, 'nothing to change');
    // Everything is checked before anything is saved.
    if (Object.keys(patch).length) state.setSettings(id, patch);
    if (snooze) state.snooze(id, snooze.instance, snooze.ms);
    return reply(200, ruleRow(rule, shownStates(), keyMemo()));
  }

  // ---- channels ----
  // A secret field as the integrations form sends it ({ mode, value | service | name }), or a reference itself.
  function secretInput(v, field) {
    if (v === null) return { mode: 'none' };
    if (isRef(v))
      return v.keychain !== undefined ? { mode: 'keychain', service: v.keychain } : { mode: 'env', name: v.env };
    if (typeof v === 'string') throw fail(400, `${field} must be a secret reference, not the plain value`);
    if (!isObject(v) || !SECRET_MODES.includes(v.mode))
      throw fail(400, `${field}: expected { mode, ... } or a secret reference`);
    for (const k of ['value', 'service', 'name']) {
      if (v[k] !== undefined && (typeof v[k] !== 'string' || v[k].length > MAX_SECRET))
        throw fail(400, `${field}: bad ${k}`);
    }
    return v;
  }

  function resolve(field, input, current, label) {
    try {
      return resolveSecret(field, input, current);
    } catch (e) {
      if (e && Number.isInteger(e.status)) throw fail(e.status, scrub(e.message));
      throw fail(400, `${label}: ${scrub(e && e.message)}`);
    }
  }

  function setChannels(body) {
    onlyFields(body, CHANNEL_FIELDS);
    if (!Object.keys(body).length) throw fail(400, 'nothing to change');
    if (body.desktop !== undefined && typeof body.desktop !== 'boolean')
      throw fail(400, 'desktop must be true or false');
    const urlIn = body.webhookRef === undefined ? null : secretInput(body.webhookRef, 'webhookRef');
    const headersIn =
      body.webhookHeadersRef === undefined ? null : secretInput(body.webhookHeadersRef, 'webhookHeadersRef');
    // A pasted value is checked before it is stored, so a bad URL never reaches the secret store.
    const check = (input, fn, label) => {
      if (!input || input.mode !== 'store') return;
      try {
        fn(input.value || '');
      } catch (e) {
        throw fail(400, scrub(e && e.message) || `${label} is not valid`);
      }
    };
    check(urlIn, checkUrl, 'the webhook URL');
    check(headersIn, checkHeaders, 'the webhook headers');
    const cur = channelSettings.get() || {};
    const was = cur.webhook || null;
    // The checks that need no secret store come first, so a refusal never leaves a stored secret behind. Whether
    // there will be a URL is read from the input itself, before anything is resolved.
    const hasUrl = !!(was && was.url);
    let willHaveUrl = hasUrl;
    if (urlIn) {
      if (urlIn.mode === 'none') willHaveUrl = false;
      else if (urlIn.mode === 'keep') willHaveUrl = hasUrl;
      else if (urlIn.mode === 'store') willHaveUrl = !!urlIn.value;
      else willHaveUrl = !!(urlIn.mode === 'keychain' ? urlIn.service : urlIn.name);
    }
    if (headersIn && headersIn.mode !== 'none' && !willHaveUrl) throw fail(400, 'set the webhook URL first');
    // Both fields are resolved (this is where a pasted secret is stored) before the settings are touched. The headers
    // go first: if they fail, no new URL secret is left behind. A cleared URL leaves the old headers secret in the
    // store, since the store has no delete.
    const headersRef = headersIn ? resolve('headers', headersIn, was && was.headers, 'webhookHeadersRef') : undefined;
    const urlRef = urlIn ? resolve('url', urlIn, was && was.url, 'webhookRef') : undefined;
    let webhook = was ? { ...was } : null;
    if (urlIn) webhook = urlRef ? { ...(webhook || {}), url: urlRef } : null;
    if (headersIn) {
      if (!webhook && headersIn.mode !== 'none') throw fail(400, 'set the webhook URL first');
      if (webhook) {
        if (headersRef) webhook.headers = headersRef;
        else delete webhook.headers;
      }
    }
    const desktop = body.desktop !== undefined ? body.desktop : cur.desktop !== false;
    try {
      channelSettings.save({ desktop, webhook });
    } catch (e) {
      // 409: config.json does not parse and was left as it is (server.js saveConfigSections; a path-free message).
      if (e && e.status === 409) throw fail(409, scrub(e.message));
      throw fail(500, 'the settings could not be saved');
    }
    return reply(200, channelsView());
  }

  async function testChannel(body) {
    onlyFields(body, ['kind']);
    if (body.kind !== 'desktop' && body.kind !== 'webhook') throw fail(400, "kind must be 'desktop' or 'webhook'");
    if (demo) return reply(200, { ok: true, demo: true });
    if (notifyOff)
      return reply(200, { ok: false, error: 'notifications are off on this server (ZAAFPULSE_NOTIFY=off)' });
    let r;
    try {
      r = (await channels.test(body.kind)) || {};
    } catch (e) {
      r = { ok: false, error: e && e.message };
    }
    return reply(200, r.ok ? { ok: true } : { ok: false, error: scrub(r.error || 'the test was not sent') });
  }

  // ---- alerts ----
  function alerts(q) {
    for (const k of ['since', 'limit'])
      if ((q.get(k) || '').length > MAX_VALUE) throw fail(400, 'query value too long');
    const since = wholeParam(q.get('since'));
    if (Number.isNaN(since)) throw fail(400, 'since must be a time in milliseconds');
    const limit = wholeParam(q.get('limit'));
    if (Number.isNaN(limit) || limit === 0 || limit > MAX_ALERTS)
      throw fail(400, `limit must be from 1 to ${MAX_ALERTS}`);
    const keyOf = keyMemo();
    const rows = state.alerts({ since, limit }).map((a) => {
      const rule = ruleById(a.rule);
      const row = {
        id: typeof a.id === 'string' ? a.id : null,
        ts: isNum(a.ts) ? a.ts : null,
        rule: a.rule,
        ruleTitle: rule ? rule.title : null,
        instance: instanceId(a.rule, a.instance),
        sessionKey: keyOf(a.sessionId),
        title: typeof a.title === 'string' ? a.title : null,
        value: isNum(a.value) ? a.value : null,
        threshold: isNum(a.threshold) ? a.threshold : null,
      };
      if (a.rule === 'budget') {
        row.period = ['day', 'week', 'month'].includes(a.period) ? a.period : null;
        row.projected = a.projected === true;
      }
      // An automatic pause outcome: what happened, by code. Its reason text is not sent; the page words the code.
      if (a.action !== undefined) return { ...row, action: a.action, ok: a.ok === true, code: a.code || null };
      return { ...row, state: a.state, previous: a.previous || null };
    });
    return reply(200, { alerts: rows });
  }

  // ---- status ----
  async function status() {
    let st = {};
    try {
      st = (await monitors.status()) || {};
    } catch {
      st = {};
    }
    const counts = { ok: 0, triggered: 0, no_data: 0, snoozed: 0 };
    for (const s of shownStates()) {
      if (s.rule === 'budget' || RETIRED.has(s.rule)) continue;
      if (Object.hasOwn(counts, s.state) && state.settings(s.rule).enabled) counts[s.state]++;
    }
    const keyOf = keyMemo();
    const paused = (demo ? demo.paused : st.paused) || [];
    return reply(200, {
      enabled: active().some((r) => state.settings(r.id).enabled),
      lastAggregate: st.lastAggregate || null,
      lastLive: st.lastLive || null,
      counts,
      paused: paused.map((p) => ({
        pid: p.pid,
        startTime: p.startTime,
        app: p.app || null,
        by: p.by || null,
        since: p.since || null,
        sessionKey: keyOf(p.sessionId),
      })),
      agents: { available: !offReason(), pause: platform !== 'win32', reason: offReason() },
    });
  }

  // ---- agents ----
  const keyParam = (v) => {
    if (typeof v !== 'string' || !v) throw fail(400, 'session key required');
    if (v.length > MAX_VALUE) throw fail(400, 'key too long');
    return v;
  };

  async function candidates(q) {
    if (agentsOff) throw fail(403, actOffText(offReason()));
    if (offReason() === 'docker') throw fail(403, OFF_TEXT.docker);
    const key = keyParam(q.get('key'));
    const { source, sid } = trace.sourceOf(key);
    const canPause = platform !== 'win32';
    // Before the demo answer: a session no agent runs says so in demo mode too.
    if (!SOURCES.includes(source)) return reply(200, { candidates: [], canPause, reason: 'unsupported' });
    if (demo) return reply(200, { candidates: demo.candidates(source, sid), canPause });
    const info = sessionInfo(source, sid);
    if (!info || typeof info.cwd !== 'string' || !info.cwd || !isNum(info.first))
      return reply(200, { candidates: [], canPause, reason: 'not-indexed' });
    const list = (await control.candidates({ cwd: info.cwd, firstTs: info.first, source })) || [];
    let paused = [];
    if (list.length) {
      try {
        paused = (await control.paused()) || [];
      } catch {
        paused = [];
      }
    }
    return reply(200, {
      candidates: list.map((c) => ({
        pid: c.pid,
        startTime: c.startTime,
        app: c.app,
        cwd: shown(c.cwd),
        command: shown(c.command),
        paused: paused.some((p) => sameProcess(p, c)),
      })),
      canPause,
    });
  }

  async function act(action, body) {
    if (agentsOff) throw fail(403, actOffText(offReason()));
    if (offReason() === 'docker') throw fail(403, OFF_TEXT.docker);
    onlyFields(body, ACTION_FIELDS);
    const key = body.key === undefined || body.key === null ? null : keyParam(body.key);
    const { pid, startTime } = body;
    if (!(Number.isInteger(pid) && pid > 1 && pid < 2 ** 31)) throw fail(400, 'pid must be a whole number above 1');
    if (!(isNum(startTime) && startTime >= 0)) throw fail(400, 'startTime must be a time in milliseconds');
    if (body.confirm !== undefined && typeof body.confirm !== 'boolean')
      throw fail(400, 'confirm must be true or false');
    if (action === 'stop' && body.confirm !== true) throw fail(400, 'stopping an agent needs confirm: true');
    // The session is only for the audit line; the control module checks the process itself.
    const sid = key ? trace.sourceOf(key).sid : null;
    if (demo) return reply(200, { ok: true, demo: true, action, pid, startTime });
    let r;
    try {
      r = await control[action]({ pid, startTime }, { by: 'owner', sessionId: sid });
    } catch (e) {
      const st = e && e.status;
      if (![400, 403, 409, 501, 502].includes(st)) throw fail(500, 'the agent could not be controlled');
      return reply(st, { error: scrub(e.message), ...(st === 502 ? { hint: TASKKILL_HINT } : {}) });
    }
    const out = { ok: true, action: r.action, pid: r.pid, startTime: r.startTime, app: r.app };
    if (r.signal !== undefined) out.signal = r.signal;
    if (r.exited !== undefined) out.exited = r.exited;
    return reply(200, out);
  }

  // ---- routes ----
  const GET = {
    '/api/monitors': () => list(),
    '/api/monitors/status': () => status(),
    '/api/alerts': (q) => alerts(q),
    '/api/agents/candidates': (q) => candidates(q),
  };
  const POST = {
    '/api/monitors/channels': setChannels,
    '/api/monitors/test': testChannel,
    '/api/agents/pause': (b) => act('pause', b),
    '/api/agents/resume': (b) => act('resume', b),
    '/api/agents/stop': (b) => act('stop', b),
  };
  const RULE_PATH = /^\/api\/monitors\/([a-z_]{1,40})$/;

  // `req` is { method, path, query, contentType, readBody }. Returns { status, body }, or null when the path is not
  // one of these routes, so server.js can go on to the next one.
  async function route(req) {
    const p = req.path;
    const ours =
      p === '/api/monitors' ||
      p.startsWith('/api/monitors/') ||
      p === '/api/alerts' ||
      p.startsWith('/api/alerts/') ||
      p.startsWith('/api/agents/');
    if (!ours) return null;
    const rule = !Object.hasOwn(GET, p) && !Object.hasOwn(POST, p) ? p.match(RULE_PATH) : null;
    if (!Object.hasOwn(GET, p) && !Object.hasOwn(POST, p) && !rule) return reply(404, { error: 'unknown route' });
    const isPost = (Object.hasOwn(POST, p) || !!rule) && req.method === 'POST';
    if (!(isPost || (Object.hasOwn(GET, p) && req.method === 'GET')))
      return reply(405, { error: 'method not allowed' });
    try {
      if (!isPost) return await GET[p](req.query);
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
      let body;
      try {
        body = JSON.parse(await req.readBody());
      } catch (e) {
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      if (!isObject(body)) return reply(400, { error: 'bad request body' });
      if (rule) return setRule(rule[1], body);
      return await POST[p](body);
    } catch (e) {
      const st = e && e.status;
      // A message with a status is ours, state.js's or the trace registry's and holds no path; anything else is a 500.
      if (Number.isInteger(st) && st >= 400 && st <= 599) return reply(st, { error: scrub(e.message) });
      return reply(500, { error: 'monitor request failed' });
    }
  }

  return { route };
}

module.exports = { createMonitorApi, PATHLIKE };
