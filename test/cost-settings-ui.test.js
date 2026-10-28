// Cost Control → Settings (public/costsettings.js), without a browser: the page's wiring, each panel's request body,
// drafts and their dirty state, the reasons' field marks, the locked page while the settings do not read, the Save
// flow against a fake server; then (Tasks 6-8) the panels' helpers and markup, and an audit for esc() (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// The page loads costview.js first: its helpers are globals there.
const V = require('../public/costview');
Object.assign(global, V);
const U = require('../public/costsettings');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const EVIL = '<img src=x onerror=alert(1)>';
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
  keys: [
    { id: 'key_ci', name: 'ci-bot' },
    { id: 'key_web', name: 'web' },
  ],
  ...over,
});
const clone = (v) => JSON.parse(JSON.stringify(v));
// A state for the markup builders, as the page starts with it, on a fixed day.
const ST = (over = {}) => ({
  ...clone(U.COST_SET),
  answer: ANSWER(),
  budgets: [],
  drafts: {},
  msg: {},
  marks: {},
  busy: {},
  preview: null,
  testPath: '',
  today: '2026-10-28',
  ...over,
});

test('the page is wired: sub-page, sidebar entry, script after costview.js, copy, and no quiet refresh', () => {
  const html = read('index.html');
  assert.match(
    html,
    /<a class="nav-sub" href="#cost\/budgets"[^\n]*\n\s*<a class="nav-sub" href="#cost\/settings" data-route="cost\/settings">Settings<\/a>/,
  );
  const at = html.indexOf('<script src="costsettings.js"></script>');
  assert.ok(
    at > html.indexOf('<script src="costview.js"></script>') && at < html.indexOf('<script src="app.js"></script>'),
  );
  assert.match(read('iso.js'), /\['budgets', 'Budgets'\],\s*\['settings', 'Settings'\],\s*\],/);
  assert.deepEqual(V.COST_SUBS[V.COST_SUBS.length - 1], ['settings', 'Settings']);
  assert.match(
    read('costview.js'),
    /settings: 'Cost centers and their rules, billing per source, the display currency, and restating past days\.'/,
  );
  // costRefresh mounts Settings on a load and never on the 60-second cycle.
  const calls = [];
  global.state = { sub: 'settings' };
  global.$ = (s) => (s === '#cost-app' ? { contains: () => false } : null);
  global.document = { hidden: false, activeElement: null };
  global.costMountSettings = () => calls.push('mount');
  try {
    V.costRefresh(true);
    assert.deepEqual(calls, []);
    V.costRefresh(false);
    assert.deepEqual(calls, ['mount']);
  } finally {
    global.costMountSettings = U.costMountSettings;
  }
});

test('each panel sends the saved settings with only its own fields replaced', () => {
  const rules = U.costSetFromSaved('rules', SAVED, SOURCES);
  rules.centers.push({ id: ' ops ', name: ' Ops ', isNew: true, idEdited: false });
  rules.folderRules.push({ glob: ' ~/ops/** ', center: 'ops' });
  rules.keyCenters.key_web = 'ops';
  const r = U.costSetBody('rules', SAVED, rules, SOURCES);
  assert.deepEqual(r.centers[2], { id: 'ops', name: 'Ops' }, 'trimmed, no form flags');
  assert.deepEqual(r.folderRules[1], { glob: '~/ops/**', center: 'ops' });
  assert.deepEqual(r.keyCenters, { key_ci: 'lab', key_web: 'ops' });
  assert.deepEqual([r.billing, r.currency], [SAVED.billing, SAVED.currency], 'the other sections as saved');

  const billing = U.costSetFromSaved('billing', SAVED, SOURCES);
  assert.deepEqual(billing.billing.claude, { mode: 'plan', plan: 'Max', feeUSD: '200', period: 'month' });
  assert.deepEqual(billing.billing.codex, { mode: 'metered', plan: '', feeUSD: '', period: 'month' });
  billing.billing.codex = { mode: 'plan', plan: ' Pro ', feeUSD: ' 20 ', period: 'year' };
  billing.billing.gateway = { mode: 'plan', plan: 'X', feeUSD: '', period: 'month' };
  const b = U.costSetBody('billing', SAVED, billing, SOURCES);
  assert.deepEqual(Object.keys(b.billing), SOURCES, 'every source written out');
  assert.deepEqual(b.billing.codex, { mode: 'plan', plan: 'Pro', feeUSD: 20, period: 'year' });
  assert.equal(b.billing.gateway.feeUSD, null, 'an empty fee is sent for the server to refuse');
  assert.deepEqual(b.billing.judge, { mode: 'metered' });
  assert.deepEqual(
    [b.centers, b.keyCenters, b.folderRules, b.currency],
    [SAVED.centers, SAVED.keyCenters, SAVED.folderRules, SAVED.currency],
  );

  const cur = U.costSetFromSaved('currency', SAVED, SOURCES);
  assert.deepEqual(cur.currency, { on: 'on', code: 'IDR', rates: [{ from: '2026-10-01', perUSD: '16250' }] });
  cur.currency.code = ' eur ';
  cur.currency.rates.unshift({ from: '2026-10-20', perUSD: '0.9' });
  const c = U.costSetBody('currency', SAVED, cur, SOURCES);
  assert.deepEqual(c.currency, {
    code: 'EUR',
    rates: [
      { from: '2026-10-01', perUSD: 16250 },
      { from: '2026-10-20', perUSD: 0.9 },
    ],
  });
  assert.equal(U.costSetBody('currency', SAVED, { currency: { ...cur.currency, on: 'off' } }, SOURCES).currency, null);
  assert.deepEqual(U.costSetFromSaved('currency', { ...SAVED, currency: null }, SOURCES).currency, {
    on: 'off',
    code: '',
    rates: [],
  });
  assert.equal(c.billing, SAVED.billing);
});

test('drafts: dirty only when the body would change; paths set fields; an empty key choice removes the mapping', () => {
  const d = U.costSetFromSaved('rules', SAVED, SOURCES);
  assert.equal(U.costSetDirty('rules', SAVED, null, SOURCES), false, 'no draft');
  assert.equal(U.costSetDirty('rules', SAVED, d, SOURCES), false, 'a draft equal to the saved values');
  U.costSetAssign(d, 'centers.0.name', ' Acme ');
  assert.equal(U.costSetDirty('rules', SAVED, d, SOURCES), false, 'spaces around a name are not a change');
  U.costSetAssign(d, 'folderRules.0.center', 'lab');
  assert.equal(d.folderRules[0].center, 'lab');
  assert.equal(U.costSetDirty('rules', SAVED, d, SOURCES), true);
  U.costSetAssign(d, 'keyCenters.key_web', 'acme');
  U.costSetAssign(d, 'keyCenters.key_ci', '');
  assert.deepEqual(d.keyCenters, { key_web: 'acme' });
  U.costSetAssign(d, '__proto__.polluted', 'x');
  U.costSetAssign(d, 'centers.9.name', 'x');
  assert.equal({}.polluted, undefined);
  assert.equal(d.centers.length, 2, 'a path to nothing is ignored');
  const billing = U.costSetFromSaved('billing', SAVED, SOURCES);
  U.costSetAssign(billing, 'billing.claude.feeUSD', '250');
  assert.equal(U.costSetDirty('billing', SAVED, billing, SOURCES), true);
});

test('reasons name fields: the path of each one that does, for the error mark', () => {
  assert.deepEqual(
    U.costSetReasonPaths([
      'folderRules[2].center: unknown cost center',
      'centers[0].id: lower-case letters, digits and dashes, up to 40',
      'keyCenters.key_a: unknown cost center',
      'billing.claude.plan: 1 to 60 characters',
      'currency.rates[1].perUSD: a number above 0',
      'at most 50 cost centers',
      'budget team: unknown cost center',
    ]),
    ['folderRules.2.center', 'centers.0.id', 'keyCenters.key_a', 'billing.claude.plan', 'currency.rates.1.perUSD'],
  );
  assert.deepEqual(U.costSetReasonPaths(null), []);
});

test('while the settings do not read: the banner with its reasons, every Save disabled', () => {
  const locked = ST({ answer: ANSWER({ error: 'the cost settings in config.json are invalid', reasons: [EVIL] }) });
  assert.equal(U.costSetLocked(locked.answer), true);
  assert.equal(U.costSetLocked(ANSWER()), false);
  const html = U.costSetPageHtml(locked);
  assert.match(html, /class="cost-banner warn"/);
  assert.match(html, /<li>&lt;img src=x onerror=alert\(1\)&gt;<\/li>/);
  assert.doesNotMatch(html, /<img/);
  assert.equal((html.match(/data-cost-set-panel="/g) || []).length, 4);
  for (const p of ['rules', 'billing', 'currency']) {
    const save = U.costSetSaveHtml(p, locked);
    assert.match(save, /data-cost-set-act="save"[^>]*disabled/, p);
    assert.match(save, /Fix config\.json first/);
    assert.doesNotMatch(U.costSetSaveHtml(p, ST()), /disabled/);
  }
  assert.equal(U.costSetBannerHtml(ANSWER()), '');
  assert.match(U.costSetPageHtml(ST()), /<details class="holo panel cost-set-panel" data-cost-set-panel="restate" >/);
});

test('save messages: applies from today with the Restate link, budgets with Open Budgets, all text escaped', () => {
  const ok = U.costSetMsgHtml({
    tone: 'ok',
    text: 'Saved. New costs follow these rules from today. To apply them to past days, use Restate.',
    restate: true,
  });
  assert.match(ok, /Saved\. New costs follow these rules from today\. To apply them to past days, use Restate\./);
  assert.match(ok, /data-cost-set-act="open-restate"/);
  const dep = U.costSetMsgHtml({
    tone: 'warn',
    text: EVIL,
    reasons: [`budget ${EVIL}: unknown cost center`],
    budgets: true,
  });
  assert.match(dep, /<a class="link-btn" href="#cost\/budgets">Open Budgets<\/a>/);
  assert.doesNotMatch(dep, /<img/);
  assert.equal(U.costSetMsgHtml(null), '');
});

// A fake server for the Save flow: each request is recorded and answered from `routes`.
function fakeServer(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = routes[`${opts.method || 'GET'} ${url}`];
    if (r instanceof Error) throw r;
    const out = typeof r === 'function' ? r() : r;
    return { status: out.status, json: async () => out.json };
  };
  return calls;
}
function resetState() {
  Object.assign(U.COST_SET, { answer: ANSWER(), drafts: {}, msg: {}, marks: {}, busy: {}, gen: 0 });
  global.state = { sub: 'settings' };
  global.$ = () => null; // nothing on screen: the flow only
  global.document = { querySelectorAll: () => [], querySelector: () => null, activeElement: null };
}

test('save: the settings are read again, the panel fields replace theirs, and success clears the draft', async () => {
  resetState();
  const elsewhere = { ...SAVED, currency: null }; // changed in another tab since the page loaded
  const calls = fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER({ settings: elsewhere }) },
    'POST /api/cost/settings': { status: 200, json: { settings: elsewhere } },
  });
  U.costSetEdit('billing', (d) => (d.billing.codex = { mode: 'plan', plan: 'Pro', feeUSD: '20', period: 'month' }));
  U.costSetEdit('rules', (d) => (d.centers[0].name = 'Acme Corp')); // another panel's draft: neither sent nor lost
  await U.costSetSave('billing');
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ['GET /api/cost/settings', 'POST /api/cost/settings'],
  );
  const body = calls[1].body;
  assert.equal(body.currency, null, 'the saved settings as read just before the POST');
  assert.equal(body.centers[0].name, 'Acme', 'the rules draft is not sent');
  assert.deepEqual(body.billing.codex, { mode: 'plan', plan: 'Pro', feeUSD: 20, period: 'month' });
  assert.equal(U.COST_SET.drafts.billing, undefined);
  assert.equal(U.COST_SET.drafts.rules.centers[0].name, 'Acme Corp');
  assert.equal(U.COST_SET.gen, 1);
  assert.equal(U.COST_SET.msg.billing.restate, true);
});

test('save: 400 marks the fields its reasons name; 409 shows budgets or CONFIG_BROKEN; a failure keeps the draft', async () => {
  resetState();
  let answer = {
    status: 400,
    json: { error: 'invalid cost settings', reasons: ['folderRules[0].center: unknown cost center'] },
  };
  fakeServer({ 'GET /api/cost/settings': { status: 200, json: ANSWER() }, 'POST /api/cost/settings': () => answer });
  U.costSetEdit('rules', (d) => (d.folderRules[0].center = 'gone'));
  await U.costSetSave('rules');
  assert.deepEqual(U.COST_SET.marks.rules, ['folderRules.0.center']);
  assert.deepEqual(U.COST_SET.msg.rules.reasons, ['folderRules[0].center: unknown cost center']);
  assert.ok(U.COST_SET.drafts.rules, 'the draft stays');
  answer = {
    status: 409,
    json: { error: 'budgets depend on these settings; edit or delete them first', reasons: ['budget team: x'] },
  };
  await U.costSetSave('rules');
  assert.equal(U.COST_SET.msg.rules.budgets, true);
  answer = { status: 409, json: { error: 'config.json could not be read; fix it first' } };
  await U.costSetSave('rules');
  assert.deepEqual(
    [U.COST_SET.msg.rules.text, U.COST_SET.msg.rules.budgets],
    ['config.json could not be read; fix it first', false],
  );
  fakeServer({ 'GET /api/cost/settings': new Error('network down') });
  await U.costSetSave('rules');
  assert.equal(U.COST_SET.msg.rules.text, 'network down');
  assert.ok(U.COST_SET.drafts.rules);
  assert.equal(U.COST_SET.gen, 0);
});

test('save: nothing is sent while the settings do not read, then or when read again', async () => {
  resetState();
  U.COST_SET.answer = ANSWER({ error: 'config.json could not be read, so the ledger pass waits until it does' });
  const calls = fakeServer({});
  await U.costSetSave('rules');
  assert.deepEqual(calls, []);
  resetState();
  const again = fakeServer({
    'GET /api/cost/settings': {
      status: 200,
      json: ANSWER({ error: 'the cost settings in config.json are invalid', reasons: ['centers must be a list'] }),
    },
  });
  await U.costSetSave('currency');
  assert.deepEqual(
    again.map((c) => c.method),
    ['GET'],
  );
  assert.equal(U.costSetLocked(U.COST_SET.answer), true);
  assert.deepEqual(U.COST_SET.msg.currency.reasons, ['centers must be a list']);
});

test('drafts outlive the page: leaving keeps them, and any unsaved one makes closing the tab ask', () => {
  resetState();
  assert.equal(U.costSetAnyDirty(), false);
  U.costSetEdit('currency', (d) => (d.currency.rates[0].perUSD = '16300'));
  U.costSetUnmount();
  assert.equal(U.COST_SET.drafts.currency.currency.rates[0].perUSD, '16300');
  assert.equal(U.costSetAnyDirty(), true);
  assert.match(
    U.costSetPageHtml(ST({ drafts: U.COST_SET.drafts })),
    /Unsaved changes <button[^>]*data-cost-set-act="discard" data-panel="currency"/,
  );
});
