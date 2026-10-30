// Cost Control follow-ups, the Settings page (public/costsettings.js, public/costview.js costCall): a Save warns when
// its panel changed elsewhere since the draft began, Run restate sends the preview's basis and handles the stale 409,
// cost requests time out, a move a key decides reads as the key, and rates repaint only when their order changed.
const test = require('node:test');
const assert = require('node:assert/strict');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const V = require('../public/costview');
Object.assign(global, V);
const U = require('../public/costsettings');

const SOURCES = ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab'];
const SAVED = {
  centers: [
    { id: 'acme', name: 'Acme' },
    { id: 'lab', name: 'Lab' },
  ],
  keyCenters: { key_ci: 'lab' },
  folderRules: [{ glob: '~/work/acme/**', center: 'acme' }],
  billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 200, period: 'month' } },
  currency: { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 16250 }] },
};
const ANSWER = (over = {}) => ({
  settings: SAVED,
  error: null,
  reasons: [],
  sources: SOURCES,
  unassigned: 'unassigned',
  keys: [{ id: 'key_ci', name: 'ci-bot' }],
  ...over,
});
const OUTSIDE =
  'These settings changed elsewhere since you started editing. Save again to replace them, or Discard to load them.';
const SLOW = 'The request took too long; try again';

function fakeServer(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = routes[`${opts.method || 'GET'} ${url}`];
    const out = typeof r === 'function' ? await r() : r;
    return { status: out.status, json: async () => out.json };
  };
  return calls;
}
function resetState() {
  Object.assign(U.COST_SET, { answer: ANSWER(), drafts: {}, bases: {}, msg: {}, marks: {}, busy: {}, gen: 0 });
  global.state = { sub: 'settings' };
  global.$ = () => null;
  global.document = { querySelectorAll: () => [], querySelector: () => null, activeElement: null };
}
const realFetch = global.fetch;
test.afterEach(() => (global.fetch = realFetch));

/* ---------- 1a: a panel changed elsewhere ---------- */

test('save: a panel changed elsewhere since the edit began is not posted; a second Save replaces it', async () => {
  resetState();
  const elsewhere = { ...SAVED, folderRules: [{ glob: '~/work/**', center: 'lab' }] };
  const calls = fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER({ settings: elsewhere }) },
    'POST /api/cost/settings': { status: 200, json: { settings: elsewhere } },
  });
  U.costSetEdit('rules', (d) => (d.centers[0].name = 'Acme Corp'));
  await U.costSetSave('rules');
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET'],
    'no POST',
  );
  assert.deepEqual(U.COST_SET.msg.rules, { tone: 'warn', text: OUTSIDE });
  assert.equal(U.COST_SET.drafts.rules.centers[0].name, 'Acme Corp', 'the draft stays');
  assert.equal(U.COST_SET.gen, 0);
  assert.equal(U.COST_SET.busy.rules, false);
  assert.equal(U.COST_SET.savesPending, 0);
  await U.costSetSave('rules');
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1, 'the second Save posts');
  assert.equal(posts[0].body.centers[0].name, 'Acme Corp');
  assert.equal(U.COST_SET.drafts.rules, undefined);
  assert.equal(U.COST_SET.bases.rules, undefined, 'a successful Save clears the base');
});

test('save: after the warning, Discard shows the settings as changed elsewhere', async () => {
  resetState();
  const elsewhere = { ...SAVED, folderRules: [{ glob: '~/work/**', center: 'lab' }] };
  fakeServer({ 'GET /api/cost/settings': { status: 200, json: ANSWER({ settings: elsewhere }) } });
  U.costSetEdit('rules', (d) => (d.centers[0].name = 'Acme Corp'));
  await U.costSetSave('rules');
  assert.equal(U.COST_SET.msg.rules.text, OUTSIDE);
  U.COST_SET_ACTIONS.discard({ dataset: { panel: 'rules' } });
  assert.deepEqual(U.costSetDraftOf('rules').folderRules, [{ glob: '~/work/**', center: 'lab' }]);
  assert.equal(U.costSetDraftOf('rules').centers[0].name, 'Acme');
});

test('save: no outside change posts at once; a change to another panel is not an outside change', async () => {
  resetState();
  const elsewhere = { ...SAVED, currency: null };
  const calls = fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER({ settings: elsewhere }) },
    'POST /api/cost/settings': { status: 200, json: { settings: elsewhere } },
  });
  U.costSetEdit('billing', (d) => (d.billing.codex = { mode: 'plan', plan: 'Pro', feeUSD: '20', period: 'month' }));
  await U.costSetSave('billing');
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET', 'POST'],
  );
  assert.equal(U.COST_SET.msg.billing.tone, 'ok');
});

test('save: the base is what the panel showed when its draft began; Discard clears it', () => {
  resetState();
  U.costSetEdit('currency', (d) => (d.currency.code = 'EUR'));
  const base = U.COST_SET.bases.currency;
  assert.ok(base, 'stored on the first edit');
  U.COST_SET.answer = ANSWER({ settings: { ...SAVED, currency: null } });
  U.costSetEdit('currency', (d) => (d.currency.code = 'USD'));
  assert.equal(U.COST_SET.bases.currency, base, 'a later edit keeps the first base');
  U.COST_SET_ACTIONS.discard({ dataset: { panel: 'currency' } });
  assert.equal(U.COST_SET.bases.currency, undefined);
});

/* ---------- 1b: the restate basis ---------- */

test('restate: Run sends the preview basis; a 409 marks the preview stale with the server message', async () => {
  resetState();
  const realToday = global.costToday;
  global.costToday = () => '2026-10-28';
  try {
    const r = U.COST_SET.restate;
    Object.assign(r, { from: '2026-10-01', to: '2026-10-27', preview: null, of: null, error: null, done: null });
    const said = 'the settings or prices changed since the preview; preview again';
    const calls = fakeServer({
      'POST /api/cost/restate/preview': {
        status: 200,
        json: { from: '2026-10-01', to: '2026-10-27', changed: 1, total: 2, basis: '0123456789abcdef' },
      },
      'POST /api/cost/restate': { status: 409, json: { error: said } },
    });
    await U.costSetRestatePreview();
    Object.assign(r, { reason: 'Acme', ack: true });
    await U.costSetRunRestate();
    assert.deepEqual(calls[1].body, {
      from: '2026-10-01',
      to: '2026-10-27',
      reason: 'Acme',
      confirm: true,
      basis: '0123456789abcdef',
    });
    assert.equal(r.error, said);
    assert.equal(U.costSetPreviewState(r, U.COST_SET.gen), 'stale-settings');
    assert.equal(U.costSetCanRun(r, U.COST_SET.gen, false, 0), false);
    const html = U.costSetRestateHtml({ ...U.COST_SET, today: '2026-10-28' });
    assert.match(html, /Settings changed: preview again/);
    assert.match(html, /data-cost-set-act="restate-run" disabled/);
    await U.costSetRestatePreview();
    assert.equal(U.costSetPreviewState(r, U.COST_SET.gen), 'fresh', 'a new preview is fresh again');
  } finally {
    global.costToday = realToday;
  }
});

/* ---------- 1c: timeouts ---------- */

test('costCall: a request that never answers times out with a plain message; a caller signal is kept', async () => {
  const seen = [];
  global.fetch = (url, opts = {}) => {
    seen.push(opts.signal);
    return new Promise(() => {});
  };
  await assert.rejects(V.costCall('/api/cost/status', { timeoutMs: 20 }), { message: SLOW });
  assert.ok(seen[0] instanceof AbortSignal, 'a timeout signal by default');
  const own = new AbortController();
  global.fetch = async (url, opts = {}) => {
    seen.push(opts.signal);
    return { status: 200, json: async () => ({ ok: true }) };
  };
  assert.deepEqual(await V.costCall('/x', { signal: own.signal }), { status: 200, json: { ok: true } });
  assert.equal(seen[1], own.signal, "the caller's signal, not a timeout");
});

test('a Save whose request times out does not block the next Save', async (t) => {
  resetState();
  const realTimeout = AbortSignal.timeout;
  t.after(() => (AbortSignal.timeout = realTimeout));
  AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);
  global.fetch = () => new Promise(() => {});
  U.costSetEdit('digest', (d) => (d.digest.enabled = true));
  await U.costSetSave('digest');
  assert.equal(U.COST_SET.msg.digest.text, SLOW);
  assert.equal(U.COST_SET.busy.digest, false);
  assert.equal(U.COST_SET.savesPending, 0);
  const calls = fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER() },
    'POST /api/cost/settings': { status: 200, json: { settings: SAVED } },
  });
  await U.costSetSave('digest');
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET', 'POST'],
    'the next Save runs',
  );
});

/* ---------- 1d: a move a key decides ---------- */

test('preview moves: a key-decided move reads as the key, with its project muted; a rule move as the project', () => {
  const html = U.costSetPreviewHtml({
    answer: ANSWER(),
    drafts: {},
    preview: {
      sent: SAVED,
      answer: {
        moves: [
          { project: '~/work/<x>', keyId: 'key_ci', keyName: 'ci-bot', listUSD: 2, from: 'lab', to: 'acme', by: 'key' },
          { project: null, keyId: 'key_gone', keyName: null, listUSD: 1, from: 'lab', to: 'acme', by: 'key' },
          { project: '~/work/acme', keyId: null, keyName: null, listUSD: 1, from: 'lab', to: 'acme', by: 'rule' },
        ],
        more: 0,
        unassigned: [],
        rules: [],
      },
    },
  });
  assert.match(html, /<td>Key: ci-bot <span class="muted">\(project ~\/work\/&lt;x&gt;\)<\/span><\/td>/);
  assert.match(html, /<td>Key: key_gone<\/td>/);
  assert.match(html, /<td>~\/work\/acme<\/td>/);
});

/* ---------- 1e: rates repaint only when their order changed ---------- */

test('currency save: rates already in order are not repainted; rates out of order are', async () => {
  const paints = async (rates) => {
    resetState();
    let n = 0;
    const host = {
      dataset: { costSetBody: 'currency' },
      set innerHTML(v) {
        n++;
      },
    };
    global.document = {
      querySelectorAll: (s) => (s === '#cost-app [data-cost-set-body]' ? [host] : []),
      querySelector: () => null,
      activeElement: null,
    };
    fakeServer({
      'GET /api/cost/settings': { status: 200, json: ANSWER() },
      'POST /api/cost/settings': { status: 400, json: { error: 'Invalid', reasons: [] } },
    });
    U.costSetEdit('currency', (d) => (d.currency.rates = rates));
    const before = n;
    await U.costSetSave('currency');
    return n - before;
  };
  const sorted = await paints([
    { from: '2026-10-01', perUSD: '16250' },
    { from: '2026-10-20', perUSD: '16400' },
  ]);
  const unsorted = await paints([
    { from: '2026-10-20', perUSD: '16400' },
    { from: '2026-10-01', perUSD: '16250' },
  ]);
  assert.equal(unsorted - sorted, 1, 'one more paint when the order changed');
  assert.equal(sorted, 1, 'only the busy paint of the Save itself');
});

/* ---------- fix round 1 ---------- */

const MAYBE = 'The restate may still be running; check the history before trying again';
const armRestate = () =>
  Object.assign(U.COST_SET.restate, {
    from: '2026-10-01',
    to: '2026-10-27',
    reason: 'why',
    ack: true,
    preview: { changed: 1, basis: '0123456789abcdef' },
    of: { from: '2026-10-01', to: '2026-10-27', gen: U.COST_SET.gen },
    running: false,
    loading: false,
    error: null,
    done: null,
  });

test('restate: Run gets a long time limit; a timeout says it may still be running and reloads the history', async (t) => {
  resetState();
  const realTimeout = AbortSignal.timeout;
  t.after(() => (AbortSignal.timeout = realTimeout));
  const asked = [];
  AbortSignal.timeout = (ms) => {
    asked.push(ms);
    return realTimeout.call(AbortSignal, 20);
  };
  const calls = [];
  global.fetch = (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    if (url === '/api/cost/restates') return Promise.resolve({ status: 200, json: async () => ({ restates: [] }) });
    return new Promise(() => {}); // the restate never answers
  };
  const r = armRestate();
  U.COST_SET.history = [{}];
  await U.costSetRunRestate();
  await new Promise((res) => setImmediate(res));
  assert.ok(asked[0] >= 5 * 60 * 1000, `the restate's time limit is long: ${asked[0]}`);
  assert.equal(r.error, MAYBE);
  assert.deepEqual([r.preview, r.of, r.ack, r.running], [null, null, false, false], 'Run is not armed again');
  assert.ok(calls.includes('GET /api/cost/restates'), 'the history reloads');
  // A network failure says the same.
  armRestate();
  global.fetch = (url) =>
    url === '/api/cost/restates'
      ? Promise.resolve({ status: 200, json: async () => ({ restates: [] }) })
      : Promise.reject(new TypeError('Failed to fetch'));
  await U.costSetRunRestate();
  assert.equal(U.COST_SET.restate.error, MAYBE);
});

test('save: typing during a Save keeps the draft on what was saved; its next Save posts without a warning', async () => {
  resetState();
  let server = JSON.parse(JSON.stringify(SAVED));
  let typed = false;
  const calls = fakeServer({
    'GET /api/cost/settings': () => ({ status: 200, json: ANSWER({ settings: server }) }),
    'POST /api/cost/settings': () => {
      server = calls[calls.length - 1].body; // the server keeps what it was sent
      if (!typed) {
        typed = true;
        U.costSetEdit('rules', (d) => (d.centers[0].name = 'Typed meanwhile'));
      }
      return { status: 200, json: { settings: server } };
    },
  });
  U.costSetEdit('rules', (d) => (d.centers[0].name = 'Sent'));
  await U.costSetSave('rules');
  assert.equal(U.COST_SET.drafts.rules.centers[0].name, 'Typed meanwhile', 'the draft is kept');
  await U.costSetSave('rules');
  assert.notEqual(U.COST_SET.msg.rules.text, OUTSIDE);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2, 'the second Save posts');
  assert.equal(posts[1].body.centers[0].name, 'Typed meanwhile');
});

test('a Save queued while another hangs runs once the first times out', async (t) => {
  resetState();
  const realTimeout = AbortSignal.timeout;
  t.after(() => (AbortSignal.timeout = realTimeout));
  AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);
  let first = true;
  const calls = [];
  global.fetch = (url, opts = {}) => {
    calls.push(opts.method || 'GET');
    if (first) {
      first = false;
      return new Promise(() => {}); // the first Save's read hangs
    }
    const json = opts.method === 'POST' ? { settings: SAVED } : ANSWER();
    return Promise.resolve({ status: 200, json: async () => json });
  };
  U.costSetEdit('rules', (d) => (d.centers[0].name = 'X'));
  U.costSetEdit('billing', (d) => (d.billing.codex = { mode: 'plan', plan: 'Pro', feeUSD: '20', period: 'month' }));
  const a = U.costSetSave('rules');
  const b = U.costSetSave('billing');
  assert.equal(U.COST_SET.savesPending, 2);
  await Promise.all([a, b]);
  assert.equal(U.COST_SET.msg.rules.text, SLOW);
  assert.equal(U.COST_SET.msg.billing.tone, 'ok');
  assert.deepEqual(calls, ['GET', 'GET', 'POST'], 'the queued Save read and posted after the first gave up');
  assert.equal(U.COST_SET.savesPending, 0);
});
