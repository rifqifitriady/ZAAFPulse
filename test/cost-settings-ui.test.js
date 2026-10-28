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
    const out = typeof r === 'function' ? await r() : r;
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

test('save: typing while the Save runs keeps the draft; an untouched draft goes', async () => {
  resetState();
  const calls = fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER() },
    'POST /api/cost/settings': () => {
      U.costSetEdit('rules', (d) => (d.centers[0].name = 'Typed meanwhile'));
      return { status: 200, json: { settings: SAVED } };
    },
  });
  U.costSetEdit('rules', (d) => (d.centers[0].name = 'Sent'));
  await U.costSetSave('rules');
  assert.equal(calls[1].body.centers[0].name, 'Sent');
  assert.equal(U.COST_SET.drafts.rules.centers[0].name, 'Typed meanwhile', 'the later typing is not lost');
  assert.equal(U.costSetAnyDirty(), true);
});

test('save: a panel without a draft sends nothing, keeps gen, and says so', async () => {
  resetState();
  const elsewhere = { ...SAVED, currency: null }; // config.json changed by hand since the page loaded
  const calls = fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER({ settings: elsewhere }) },
    'POST /api/cost/settings': { status: 200, json: { settings: elsewhere } },
  });
  await U.costSetSave('rules');
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET'],
    'no POST',
  );
  assert.equal(U.COST_SET.gen, 0);
  assert.equal(U.COST_SET.msg.rules.text, 'Nothing to save.');
  assert.equal(U.COST_SET.busy.rules, false);
});

test('save: a new center whose id went out is fixed even when the draft is kept', async () => {
  resetState();
  fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER() },
    'POST /api/cost/settings': () => {
      U.costSetEdit('rules', (d) => (d.folderRules[0].glob = 'typed/**')); // typing during the Save keeps the draft
      return { status: 200, json: { settings: SAVED } };
    },
  });
  U.costSetEdit('rules', (d) =>
    d.centers.push({ id: 'newco', name: 'Newco', isNew: true, idEdited: false, prevId: '' }),
  );
  await U.costSetSave('rules');
  const c = U.COST_SET.drafts.rules.centers.find((x) => x.id === 'newco');
  assert.ok(c, 'the draft is kept');
  assert.equal(c.isNew, false, 'its id is fixed');
});

test('save: two panels saved at once go one after another, the second carrying the first result', async () => {
  resetState();
  let server = clone(SAVED);
  const order = [];
  const calls = fakeServer({
    'GET /api/cost/settings': () => {
      order.push('GET');
      return { status: 200, json: ANSWER({ settings: clone(server) }) };
    },
    'POST /api/cost/settings': () => {
      order.push('POST');
      return { status: 200, json: { settings: server } };
    },
  });
  const post = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const out = await post(url, opts);
    if (opts.method === 'POST') server = JSON.parse(opts.body); // the server keeps what it was sent
    return out;
  };
  U.costSetEdit('billing', (d) => (d.billing.codex = { mode: 'plan', plan: 'Pro', feeUSD: '20', period: 'month' }));
  U.costSetEdit('currency', (d) => (d.currency.code = 'EUR'));
  await Promise.all([U.costSetSave('billing'), U.costSetSave('currency')]);
  assert.deepEqual(order, ['GET', 'POST', 'GET', 'POST']);
  const second = calls.filter((c) => c.method === 'POST')[1].body;
  assert.equal(second.billing.codex.plan, 'Pro', 'the first Save is kept by the second');
  assert.equal(second.currency.code, 'EUR');
});

test('unmount while a Save runs does not re-enable its Save button', async () => {
  resetState();
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = fakeServer({
    'GET /api/cost/settings': async () => {
      await gate;
      return { status: 200, json: ANSWER() };
    },
    'POST /api/cost/settings': { status: 200, json: { settings: SAVED } },
  });
  U.costSetEdit('rules', (d) => (d.centers[0].name = 'X'));
  const run = U.costSetSave('rules');
  U.costSetUnmount();
  assert.equal(U.COST_SET.busy.rules, true);
  await U.costSetSave('rules'); // refused while the first runs
  release();
  await run;
  assert.equal(U.COST_SET.busy.rules, false, 'the Save clears its own flag');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

/* ---------- Task 6: cost centers & rules, the preview ---------- */

const R = require('../lib/cost/rules');

test('center id from a name: lower-case, suffixed when taken, never unassigned or a reserved name, always valid', () => {
  assert.equal(U.costSetCenterId('Client: Acme'), 'client-acme');
  assert.equal(U.costSetCenterId('Ácme Ünïon'), 'acme-union');
  assert.equal(U.costSetCenterId('Acme', ['acme']), 'acme-2');
  assert.equal(U.costSetCenterId('Acme', ['acme', 'acme-2']), 'acme-3');
  assert.equal(U.costSetCenterId('Unassigned'), 'unassigned-2');
  assert.equal(U.costSetCenterId('Constructor'), 'constructor-2');
  assert.equal(U.costSetCenterId('  ***  '), 'center');
  const long = 'x'.repeat(45);
  assert.equal(U.costSetCenterId(long).length, 40);
  assert.equal(U.costSetCenterId(long, [U.costSetCenterId(long)]), 'x'.repeat(38) + '-2');
  for (const name of ['Client: Acme', 'Unassigned', '', long, '__proto__', 'a'.repeat(80)]) {
    const id = U.costSetCenterId(name, ['a'.repeat(40)]);
    assert.ok(R.validate({ centers: [{ id, name: 'N' }] }).ok, `${name} → ${id}`);
  }
});

test('Used by and Delete: a key or a rule blocks the delete and is named; budgets alone do not block it', () => {
  const d = U.costSetFromSaved('rules', SAVED, SOURCES);
  const budgets = [
    { id: 'team', name: 'Team', scope: { dim: 'center', value: 'acme' } },
    { id: 'g', name: 'All', scope: 'global' },
  ];
  const use = U.costSetCenterUse(d, ANSWER().keys, budgets);
  assert.deepEqual(use.lab, { keys: ['ci-bot'], rules: [], budgets: [] });
  assert.deepEqual(use.acme, { keys: [], rules: [1], budgets: ['Team'] });
  assert.equal(U.costSetDeleteBlock(use.lab), 'In use: key ci-bot');
  assert.equal(U.costSetUsedBy(use.acme), 'Rule #1, Budget Team');
  assert.equal(U.costSetUsedBy(undefined), '—');
  const html = U.costSetRulesHtml(ST({ budgets }));
  assert.match(html, /data-cost-set-act="del-center" data-i="0" disabled title="In use: rule #1"/);
  assert.match(html, /data-cost-set-act="del-center" data-i="1" disabled title="In use: key ci-bot"/);
  d.folderRules = [];
  d.keyCenters = {};
  const free = U.costSetRulesHtml(ST({ budgets, drafts: { rules: d } }));
  assert.match(
    free,
    /data-cost-set-act="del-center" data-i="0"  title="Budgets use it: the Save is refused until they change"/,
  );
  assert.match(free, /data-cost-set-act="del-center" data-i="1"  title=""/);
});

test('rules panel: saved ids read-only, new ids editable, key choices, a gone key, rule order buttons, limits', () => {
  const d = U.costSetFromSaved('rules', SAVED, SOURCES);
  d.centers.push({ id: 'ops', name: 'Ops', isNew: true, idEdited: false, prevId: 'ops' });
  d.keyCenters.key_gone = 'ops';
  d.folderRules.push({ glob: '~/ops/**', center: 'ops' });
  const html = U.costSetRulesHtml(ST({ drafts: { rules: d } }));
  assert.match(html, /<td><code>acme<\/code><\/td>/);
  assert.match(html, /data-cost-set-field="rules:centers\.2\.id" data-cost-set-repaint maxlength="40" value="ops"/);
  assert.match(
    html,
    /<option value="" >Folder rules decide<\/option><option value="acme" >Acme<\/option><option value="lab" selected>Lab<\/option>/,
  );
  assert.match(
    html,
    /Key no longer exists[\s\S]*<code>key_gone<\/code><span>→ Ops<\/span><button[^>]*data-cost-set-act="remove-key" data-i="0"/,
  );
  assert.match(html, /data-cost-set-act="rule-up" data-i="0" disabled/);
  assert.match(html, /data-cost-set-act="rule-down" data-i="1" disabled/);
  assert.match(html, /A key's center always wins over folder rules\./);
  assert.match(html, /The first matching rule wins; a path no rule matches is Unassigned\./);
  const many = { ...d, centers: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, name: `C${i}` })) };
  assert.match(
    U.costSetRulesHtml(ST({ drafts: { rules: many } })),
    /data-cost-set-act="add-center" disabled title="At most 50 cost centers"/,
  );
  const none = { centers: [], keyCenters: {}, folderRules: [] };
  assert.match(
    U.costSetRulesHtml(ST({ drafts: { rules: none } })),
    /data-cost-set-act="add-rule" disabled title="Add a cost center first"/,
  );
  const marked = U.costSetRulesHtml(ST({ drafts: { rules: d }, marks: { rules: ['folderRules.1.center'] } }));
  assert.match(marked, /data-cost-set-field="rules:folderRules\.1\.center" aria-invalid="true"/);
});

test('Create rule: the glob of the folder and everything below it, appended with the focus on its center', () => {
  assert.equal(U.costSetRuleGlob('~/work/acme'), '~/work/acme/**');
  assert.equal(U.costSetRuleGlob('~/work/acme/'), '~/work/acme/**');
  assert.ok(R.globToRegExp(U.costSetRuleGlob('~/work/acme')).test('~/work/acme'));
  resetState();
  U.COST_SET.preview = {
    sent: SAVED,
    answer: { moves: [], more: 0, rules: [], unassigned: [{ project: '~/play', listUSD: 2 }], test: null },
  };
  global.reduceMotion = { matches: true };
  U.COST_SET_ACTIONS['create-rule']({ dataset: { i: '0' } });
  assert.deepEqual(U.COST_SET.drafts.rules.folderRules[1], { glob: '~/play/**', center: '' });
  clearTimeout(U.COST_SET.previewTimer);
});

test('a new center: its id follows its name until typed, and the keys and rules that chose it follow the id', () => {
  resetState();
  U.COST_SET_ACTIONS['add-center']();
  const d = U.COST_SET.drafts.rules;
  const field = { hasAttribute: () => false };
  d.centers[2].name = 'Ops Team';
  U.costSetRulesInput(field, 'rules', 'centers.2.name');
  assert.equal(d.centers[2].id, 'ops-team');
  d.folderRules.push({ glob: '~/ops/**', center: 'ops-team' });
  d.keyCenters.key_web = 'ops-team';
  d.centers[2].name = 'Ops';
  U.costSetRulesInput(field, 'rules', 'centers.2.name');
  assert.deepEqual([d.centers[2].id, d.folderRules[1].center, d.keyCenters.key_web], ['ops', 'ops', 'ops']);
  d.centers[2].id = 'operations';
  U.costSetRulesInput(field, 'rules', 'centers.2.id');
  d.centers[2].name = 'Something else';
  U.costSetRulesInput(field, 'rules', 'centers.2.name');
  assert.deepEqual([d.centers[2].id, d.folderRules[1].center], ['operations', 'operations'], 'a typed id stays');
  U.costSetRulesInput(field, 'rules', 'centers.0.name');
  assert.equal(d.centers[0].id, 'acme', 'a saved id never changes');
  clearTimeout(U.COST_SET.previewTimer);
});

const ANSWERED = (over = {}) => ({
  sent: SAVED,
  answer: {
    from: '2026-09-29',
    to: '2026-10-28',
    unread: [],
    moves: [
      { project: EVIL, keyId: null, keyName: null, listUSD: 12, from: 'unassigned', to: 'acme' },
      { project: null, keyId: 'key_ci', keyName: 'ci-bot', listUSD: 3, from: 'lab', to: 'gone' },
    ],
    more: 4,
    rules: [{ index: 0, status: 'shadowed', by: 0 }],
    unassigned: [{ project: '~/play', listUSD: 2 }],
    test: { center: 'acme', rule: 0 },
    ...over,
  },
});

test('preview: moves with names, "and N more", Unassigned with Create rule, the test path, all escaped', () => {
  const html = U.costSetPreviewHtml(ST({ preview: ANSWERED() }));
  assert.match(
    html,
    /<td>&lt;img src=x onerror=alert\(1\)&gt;<\/td><td class="num">\$12\.00<\/td><td>Unassigned → Acme<\/td>/,
  );
  assert.match(html, /<td>Key: ci-bot<\/td><td class="num">\$3\.00<\/td><td>Lab → gone<\/td>/);
  assert.match(html, /and 4 more/);
  assert.match(
    html,
    /<span>~\/play<\/span><span class="num">\$2\.00<\/span><button[^>]*data-cost-set-act="create-rule" data-i="0"/,
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(
    U.costSetPreviewHtml(ST({ preview: ANSWERED({ moves: [], more: 0 }) })),
    /No project or key changes center\./,
  );
  const bad = U.costSetPreviewHtml(ST({ preview: { sent: SAVED, reasons: [EVIL] } }));
  assert.match(bad, /does not validate[\s\S]*<li>&lt;img/);
  const failed = U.costSetPreviewHtml(ST({ preview: { error: 'a ledger month could not be read' } }));
  assert.match(failed, /a ledger month could not be read<\/p><button[^>]*data-cost-set-act="retry-preview">Retry/);
  assert.equal(U.costSetTestHtml(ST({ preview: ANSWERED(), testPath: '' })), '');
  assert.equal(
    U.costSetTestHtml(ST({ preview: { ...ANSWERED(), path: '~/work/acme/web' }, testPath: '~/work/acme/web' })),
    '<p>Acme · rule #1 <code>~/work/acme/**</code></p>',
  );
  assert.equal(
    U.costSetTestHtml(
      ST({ preview: { ...ANSWERED({ test: { center: 'unassigned', rule: null } }), path: '~/x' }, testPath: '~/x' }),
    ),
    '<p>Unassigned, no rule matches</p>',
  );
});

test('rule warnings: none and shadowed beside their rule, only for the draft the preview was asked for', () => {
  const none = ST({ preview: ANSWERED({ rules: [{ index: 0, status: 'none', by: null }] }) });
  assert.equal(U.costSetWarnText(none, 0), 'Matches nothing in the last 30 days');
  const two = { ...SAVED, folderRules: [...SAVED.folderRules, { glob: '~/work/acme/web/**', center: 'lab' }] };
  const sh = ST({
    answer: ANSWER({ settings: two }),
    preview: {
      sent: two,
      answer: {
        ...ANSWERED().answer,
        rules: [
          { index: 0, status: 'ok', by: null },
          { index: 1, status: 'shadowed', by: 0 },
        ],
      },
    },
  });
  assert.equal(U.costSetWarnText(sh, 1), 'Never used: rule #1 above takes every path it matches');
  assert.equal(U.costSetWarnText(sh, 0), '');
  const edited = U.costSetFromSaved('rules', two, SOURCES);
  edited.folderRules[1].glob = '~/elsewhere/**';
  assert.equal(
    U.costSetWarnText({ ...sh, drafts: { rules: edited } }, 1),
    '',
    'an answer for an older draft says nothing',
  );
});

test('a typed new id passes through a saved center id without taking its keys, and clearing it keeps references', () => {
  resetState();
  U.COST_SET_ACTIONS['add-center']();
  const d = U.COST_SET.drafts.rules;
  const field = { hasAttribute: () => false };
  const c = d.centers[2];
  c.name = 'x';
  U.costSetRulesInput(field, 'rules', 'centers.2.name'); // id x, references to it follow
  d.keyCenters.key_web = 'x';
  d.folderRules.push({ glob: '~/x/**', center: 'x' });
  for (const id of ['a', 'ac', 'acm', 'acme', 'acme-', 'acme-w', 'acme-web']) {
    c.id = id;
    U.costSetRulesInput(field, 'rules', 'centers.2.id');
  }
  assert.equal(d.keyCenters.key_ci, 'lab');
  assert.equal(d.folderRules[0].center, 'acme', 'the saved center keeps its rule');
  assert.equal(d.keyCenters.key_web, 'acme-web');
  assert.equal(d.folderRules[1].center, 'acme-web');
  c.id = '';
  U.costSetRulesInput(field, 'rules', 'centers.2.id');
  assert.equal(d.keyCenters.key_web, 'acme-web', 'an emptied id does not blank references');
  c.id = 'ops';
  U.costSetRulesInput(field, 'rules', 'centers.2.id');
  assert.deepEqual([d.keyCenters.key_web, d.folderRules[1].center], ['ops', 'ops']);
  clearTimeout(U.COST_SET.previewTimer);
});

test('after Up/Down to the first or last place the keyboard goes to the button still enabled', () => {
  assert.deepEqual(U.costSetMoveFocus('rule-up', 0, 3), [
    ['data-cost-set-act', 'rule-down'],
    ['data-i', '0'],
  ]);
  assert.deepEqual(U.costSetMoveFocus('rule-up', 1, 3), [
    ['data-cost-set-act', 'rule-up'],
    ['data-i', '1'],
  ]);
  assert.deepEqual(U.costSetMoveFocus('rule-down', 2, 3), [
    ['data-cost-set-act', 'rule-up'],
    ['data-i', '2'],
  ]);
  assert.deepEqual(U.costSetMoveFocus('rule-down', 1, 3), [
    ['data-cost-set-act', 'rule-down'],
    ['data-i', '1'],
  ]);
});

test('the test path result is shown only for the path it was asked for', () => {
  clearTimeout(U.COST_SET.previewTimer);
  U.COST_SET.previewTimer = null;
  const p = { ...ANSWERED(), path: '~/work/acme/web' };
  assert.equal(U.costSetTestHtml(ST({ preview: p, testPath: '~/work/acme/we' })), '');
});

test('preview requests: the draft and test path are sent; an older answer never replaces a newer one', async (t) => {
  resetState();
  const realFetch = global.fetch;
  t.after(() => (global.fetch = realFetch));
  const pending = [];
  global.fetch = (url, opts) =>
    new Promise((res) =>
      pending.push({ url, body: JSON.parse(opts.body), res: (json) => res({ status: 200, json: async () => json }) }),
    );
  U.costSetEdit('rules', (d) => d.folderRules.push({ glob: ' ~/x/** ', center: 'lab' }));
  U.COST_SET.testPath = ' ~/x/y ';
  const first = U.costSetRunPreview();
  const second = U.costSetRunPreview();
  assert.equal(pending[0].url, '/api/cost/settings/preview');
  assert.deepEqual(pending[0].body.settings.folderRules[1], { glob: '~/x/**', center: 'lab' });
  assert.equal(pending[0].body.testPath, '~/x/y');
  pending[1].res({ moves: [], more: 0, rules: [], unassigned: [], test: null, tag: 'newer' });
  await second;
  pending[0].res({ moves: [], more: 0, rules: [], unassigned: [], test: null, tag: 'older' });
  await first;
  assert.equal(U.COST_SET.preview.answer.tag, 'newer');
  const third = U.costSetRunPreview();
  U.costSetUnmount(); // leaving the page drops the answer in flight
  pending[2].res({ tag: 'gone' });
  await third;
  assert.equal(U.COST_SET.preview.answer.tag, 'newer');
});

/* ---------- Task 7: billing and display currency ---------- */

test('billing: one row per source, Metered or Plan; a plan shows its three fields and the line on what it means', () => {
  const html = U.costSetBillingHtml(ST());
  for (const label of ['Claude Code', 'Codex', 'Gateway', 'Judge', 'Replay', 'Collaboration'])
    assert.match(html, new RegExp(`<b>${label}</b>`));
  assert.match(html, /data-src="claude" data-mode="plan" aria-pressed="true">Plan/);
  assert.match(html, /data-src="codex" data-mode="metered" aria-pressed="true">Metered/);
  assert.match(html, /data-cost-set-field="billing:billing\.claude\.plan" maxlength="60" value="Max"/);
  assert.match(
    html,
    /data-cost-set-field="billing:billing\.claude\.feeUSD" type="number" min="0" max="1000000" step="any" value="200"/,
  );
  assert.match(html, /<option value="month" selected>Month<\/option><option value="year" >Year<\/option>/);
  assert.equal(
    (
      html.match(
        /The plan fee is spread over the days of its period and counted as paid\. Usage on this source counts as usage value only\./g,
      ) || []
    ).length,
    1,
    'only under a plan',
  );
  assert.doesNotMatch(html, /billing\.codex\.plan/, 'a metered source has no plan fields');
  const evil = U.costSetFromSaved('billing', SAVED, SOURCES);
  evil.billing.claude.plan = EVIL;
  assert.doesNotMatch(U.costSetBillingHtml(ST({ drafts: { billing: evil } })), /<img/);
});

test('billing: the switch keeps a typed plan; a source missing from the saved billing shows as Metered', () => {
  resetState();
  U.COST_SET.answer = ANSWER({ settings: { ...SAVED, billing: {} } });
  U.COST_SET_ACTIONS.mode({ dataset: { src: 'codex', mode: 'plan' } });
  U.COST_SET.drafts.billing.billing.codex.plan = 'Pro';
  U.COST_SET_ACTIONS.mode({ dataset: { src: 'codex', mode: 'metered' } });
  U.COST_SET_ACTIONS.mode({ dataset: { src: 'codex', mode: 'plan' } });
  assert.deepEqual(U.COST_SET.drafts.billing.billing.codex, { mode: 'plan', plan: 'Pro', feeUSD: '', period: 'month' });
  assert.match(
    U.costSetBillingHtml(ST({ answer: ANSWER({ settings: { ...SAVED, billing: {} } }) })),
    /data-src="claude" data-mode="metered" aria-pressed="true"/,
  );
});

test("today's rate: the rule of rateFor, from the draft's valid rows; the line and the note", () => {
  const rates = [
    { from: '2026-10-01', perUSD: '16250' },
    { from: '2026-10-20', perUSD: '16420' },
    { from: '2026-11-01', perUSD: '17000' }, // not yet
    { from: '2026-10-25', perUSD: '' }, // not a rate yet
    { from: '2026-10-26', perUSD: '0' },
  ];
  const hit = U.costSetRateToday(rates, '2026-10-28');
  assert.deepEqual(hit, { from: '2026-10-20', perUSD: 16420 });
  const valid = rates.filter((r) => Number(r.perUSD) > 0).map((r) => ({ from: r.from, perUSD: Number(r.perUSD) }));
  for (const day of [
    '2026-09-30',
    '2026-10-01',
    '2026-10-19',
    '2026-10-20',
    '2026-10-31',
    '2026-11-01',
    '2027-01-01',
  ]) {
    const mine = U.costSetRateToday(rates, day);
    assert.equal(mine ? mine.perUSD : null, R.rateFor({ rates: valid }, day), day);
  }
  assert.equal(
    U.costSetRateLine('idr', { from: '2026-10-01', perUSD: 16250 }),
    'Today: 1 USD = 16,250 IDR (rate from 2026-10-01)',
  );
  assert.equal(U.costSetRateLine('IDR', null), 'Today: no rate starts on or before today.');
  const html = U.costSetCurrencyHtml(ST());
  assert.match(html, /data-on="on" aria-pressed="true">USD \+ display currency/);
  assert.match(html, /Today: 1 USD = 16,250 IDR \(rate from 2026-10-01\)/);
  assert.match(
    html,
    /Rates convert at read time: a change here also changes how past days read in this currency\. USD amounts never change\./,
  );
  assert.match(html, /data-cost-set-field="currency:currency\.rates\.0\.perUSD" value="16250"/);
});

test('currency: USD only hides the code and rates; Add appends a rate from today, Delete removes it; 1000 at most', () => {
  const off = U.costSetCurrencyHtml(ST({ answer: ANSWER({ settings: { ...SAVED, currency: null } }) }));
  assert.match(off, /data-on="off" aria-pressed="true">USD only/);
  assert.doesNotMatch(off, /currency\.code|Today:/);
  resetState();
  global.costToday = () => '2026-10-28';
  try {
    U.COST_SET_ACTIONS['add-rate']();
    assert.deepEqual(U.COST_SET.drafts.currency.currency.rates[1], { from: '2026-10-28', perUSD: '' });
    U.COST_SET_ACTIONS['del-rate']({ dataset: { i: '0' } });
    assert.deepEqual(U.COST_SET.drafts.currency.currency.rates, [{ from: '2026-10-28', perUSD: '' }]);
    U.COST_SET_ACTIONS['cur-on']({ dataset: { on: 'off' } });
    assert.equal(U.costSetBody('currency', SAVED, U.COST_SET.drafts.currency, SOURCES).currency, null);
  } finally {
    global.costToday = V.costToday;
  }
  const many = {
    currency: {
      on: 'on',
      code: 'IDR',
      rates: Array.from({ length: 1000 }, (_, i) => ({ from: '2026-10-01', perUSD: String(i + 1) })),
    },
  };
  assert.match(
    U.costSetCurrencyHtml(ST({ drafts: { currency: many } })),
    /data-cost-set-act="add-rate" disabled title="At most 1000 rates"/,
  );
});

test('currency save: rates are sorted in the draft first, so a 400 names the right row; Delete clears the marks', async (t) => {
  resetState();
  const realFetch = global.fetch;
  const realToday = global.costToday;
  t.after(() => {
    global.fetch = realFetch;
    global.costToday = realToday;
  });
  global.costToday = () => '2026-10-28';
  const saved = {
    ...SAVED,
    currency: {
      code: 'IDR',
      rates: [
        { from: '2026-10-01', perUSD: 16250 },
        { from: '2026-11-01', perUSD: 17000 },
      ],
    },
  };
  U.COST_SET.answer = ANSWER({ settings: saved });
  fakeServer({
    'GET /api/cost/settings': { status: 200, json: ANSWER({ settings: saved }) },
    'POST /api/cost/settings': {
      status: 400,
      json: { error: 'Invalid', reasons: ['currency.rates[1].perUSD: must be above 0'] },
    },
  });
  U.COST_SET_ACTIONS['add-rate']();
  assert.equal(U.COST_SET.drafts.currency.currency.rates[2].from, '2026-10-28', 'appended at the end');
  await U.costSetSave('currency');
  const rows = U.COST_SET.drafts.currency.currency.rates;
  assert.deepEqual(
    rows.map((r) => r.from),
    ['2026-10-01', '2026-10-28', '2026-11-01'],
  );
  assert.deepEqual(U.COST_SET.marks.currency, ['currency.rates.1.perUSD']);
  assert.equal(rows[1].perUSD, '', 'the marked row is the one with the empty fee');
  U.COST_SET_ACTIONS['del-rate']({ dataset: { i: '1' } });
  assert.deepEqual(U.COST_SET.marks.currency, []);
});

test('the rateFor parity also holds for rows typed out of date order', () => {
  const rates = [
    { from: '2026-10-20', perUSD: '16420' },
    { from: '2026-10-01', perUSD: '16250' },
  ];
  const sorted = rates.map((r) => ({ from: r.from, perUSD: Number(r.perUSD) })).sort(U.costSetByFrom);
  for (const day of ['2026-09-30', '2026-10-01', '2026-10-19', '2026-10-20', '2026-12-01']) {
    const mine = U.costSetRateToday(rates, day);
    assert.equal(mine ? mine.perUSD : null, R.rateFor({ rates: sorted }, day), day);
  }
});

/* ---------- Task 8: restate, history, and the esc() audit ---------- */

test('restate range: the first of the month to yesterday; on the 1st, the previous month; the server checks', () => {
  assert.deepEqual(U.costSetRestateRange('2026-10-28'), { from: '2026-10-01', to: '2026-10-27' });
  assert.deepEqual(U.costSetRestateRange('2026-11-01'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(U.costSetRestateRange('2027-01-01'), { from: '2026-12-01', to: '2026-12-31' });
  const t = '2026-10-28';
  assert.equal(U.costSetRestateCheck('2026-10-01', '2026-10-27', t), null);
  assert.equal(U.costSetRestateCheck('2026-10-01', '', t), 'from and to are dates (YYYY-MM-DD)');
  assert.equal(U.costSetRestateCheck('2026-02-30', '2026-03-01', t), 'from and to are dates (YYYY-MM-DD)');
  assert.equal(U.costSetRestateCheck('2026-10-20', '2026-10-10', t), 'from must be on or before to');
  assert.equal(U.costSetRestateCheck('2025-09-01', '2026-10-27', t), 'at most 400 days at a time');
  assert.equal(U.costSetRestateCheck('2025-09-23', '2026-10-27', t), null, '400 days exactly');
  assert.equal(
    U.costSetRestateCheck('2026-10-01', '2026-10-28', t),
    'today follows the current prices and rules already; restate up to yesterday',
  );
});

test('restate staleness: a range edit or a Save since the preview; Run needs fresh, a reason, the box, readable settings', () => {
  const base = {
    from: '2026-10-01',
    to: '2026-10-27',
    reason: 'Acme rule',
    ack: true,
    preview: { changed: 1 },
    of: { from: '2026-10-01', to: '2026-10-27', gen: 2 },
  };
  assert.equal(U.costSetPreviewState(base, 2), 'fresh');
  assert.equal(U.costSetPreviewState({ ...base, to: '2026-10-26' }, 2), 'stale-range');
  assert.equal(U.costSetPreviewState(base, 3), 'stale-settings');
  assert.equal(U.costSetPreviewState({ ...base, preview: null }, 2), 'none');
  assert.equal(U.costSetCanRun(base, 2, false), true);
  assert.equal(U.costSetCanRun(base, 3, false), false, 'a Save since the preview');
  assert.equal(U.costSetCanRun({ ...base, from: '2026-10-02' }, 2, false), false, 'the range changed');
  assert.equal(U.costSetCanRun({ ...base, reason: '  ' }, 2, false), false);
  assert.equal(U.costSetCanRun({ ...base, reason: 'x'.repeat(201) }, 2, false), false);
  assert.equal(U.costSetCanRun({ ...base, ack: false }, 2, false), false);
  assert.equal(U.costSetCanRun(base, 2, true), false, 'settings that do not read');
  assert.equal(U.costSetCanRun({ ...base, running: true }, 2, false), false);
  const html = (r, gen = 2) => U.costSetRestateHtml(ST({ restate: { ...base, ...r }, gen, history: [] }));
  assert.match(html({}), /data-cost-set-act="restate-run" >Run restate/);
  assert.match(html({}, 3), /Settings changed: preview again[\s\S]*data-cost-set-act="restate-run" disabled/);
  assert.match(html({ to: '2026-10-26' }), /Range changed: preview again/);
  assert.match(
    html({ to: '2026-10-28' }),
    /restate up to yesterday[\s\S]*data-cost-set-act="restate-preview" disabled/,
  );
});

test('restate preview: rows, usage before → after, center moves, prices, billing; no change says so', () => {
  const centers = SAVED.centers;
  const billing = [
    { source: 'claude', mode: 'plan', plan: EVIL, feeUSD: 200, period: 'month' },
    { source: 'codex', mode: 'metered' },
  ];
  const p = {
    changed: 3,
    total: 40,
    beforeUSD: 10,
    afterUSD: 12.5,
    moves: [{ from: 'unassigned', to: 'acme', listUSD: 7 }],
    versionsBefore: [1, 2],
    version: null,
    newPrices: true,
    billing,
  };
  const html = U.costSetRestateSummaryHtml(p, centers);
  assert.match(html, /Rows: 3 ledger rows change, out of 40 in the range\./);
  assert.match(html, /Usage value: \$10\.00 → \$12\.50 \(\+\$2\.50\)/);
  assert.match(html, /<li>Unassigned → Acme: \$7\.00<\/li>/);
  assert.match(html, /Prices: version 1, version 2 → today&#39;s prices, not yet recorded as a version/);
  assert.match(html, /Claude Code: Plan &lt;img src=x onerror=alert\(1\)&gt;, \$200\.00 per month; Codex: Metered/);
  assert.doesNotMatch(html, /<img/);
  assert.match(
    U.costSetRestateSummaryHtml({ ...p, newPrices: false, version: 3 }, centers),
    /Prices: version 1, version 2 → version 3/,
  );
  const none = U.costSetRestateSummaryHtml({ ...p, changed: 0, moves: [], versionsBefore: [] }, centers);
  assert.match(
    none,
    /Billing set over the range:[\s\S]*No ledger row changes\. The billing above is still set over the range\./,
  );
  assert.doesNotMatch(none, /Rows:/);
  assert.match(
    U.costSetRestateHtml(ST()),
    /Restate recomputes a past range with today&#39;s prices, rules and billing, and records the result as a correction\. It cannot be undone\. Today is never restated: it follows the current settings already\./,
  );
});

test('restate requests: preview then run with the previewed range and reason; history newest first, escaped', async () => {
  resetState();
  global.costToday = () => '2026-10-28';
  const r = U.COST_SET.restate;
  Object.assign(r, {
    from: '2026-10-01',
    to: '2026-10-27',
    reason: '',
    ack: false,
    preview: null,
    of: null,
    error: null,
    done: null,
  });
  const history = [
    {
      ts: Date.UTC(2026, 9, 28, 9),
      from: '2026-10-01',
      to: '2026-10-27',
      reason: EVIL,
      priceVersion: 2,
      rows: 3,
      billing: [],
    },
  ];
  const calls = fakeServer({
    'POST /api/cost/restate/preview': {
      status: 200,
      json: {
        from: '2026-10-01',
        to: '2026-10-27',
        changed: 3,
        total: 9,
        beforeUSD: 1,
        afterUSD: 2,
        moves: [],
        versionsBefore: [1],
        version: 2,
        newPrices: false,
        billing: [],
      },
    },
    'POST /api/cost/restate': { status: 200, json: { correction: { rows: [{}, {}, {}] }, overrides: [] } },
    'GET /api/cost/restates': { status: 200, json: { restates: history } },
  });
  try {
    await U.costSetRestatePreview();
    assert.deepEqual(r.of, { from: '2026-10-01', to: '2026-10-27', gen: 0 });
    await U.costSetRunRestate();
    assert.equal(calls.length, 1, 'no run without a reason and the box');
    U.costSetRestateInput({ dataset: { costSetRestate: 'reason' }, value: ' Acme rule ' }, 'input');
    U.costSetRestateInput({ dataset: { costSetRestate: 'ack' }, checked: true }, 'input');
    U.costSetRestateInput({ dataset: { costSetRestate: 'to' }, value: '2026-10-20' }, 'input');
    assert.equal(r.to, '2026-10-27', 'a date applies on change, not while typed');
    await U.costSetRunRestate();
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(calls[0].body, { from: '2026-10-01', to: '2026-10-27' });
    assert.deepEqual(calls[1].body, { from: '2026-10-01', to: '2026-10-27', reason: 'Acme rule', confirm: true });
    assert.equal(r.done, 'Restated: 3 rows');
    assert.deepEqual([r.preview, r.reason, r.ack], [null, '', false]);
    assert.equal(calls[2].url, '/api/cost/restates');
    const html = U.costSetHistoryHtml(U.COST_SET);
    assert.match(
      html,
      /<td>2026-10-01 – 2026-10-27<\/td><td>&lt;img src=x onerror=alert\(1\)&gt;<\/td><td class="num">3<\/td><td class="num">2<\/td>/,
    );
    assert.match(U.costSetHistoryHtml({ history: [] }), /No restate yet\./);
    assert.match(
      U.costSetHistoryHtml({ historyError: 'the ledger corrections could not be read' }),
      /could not be read<\/p><button[^>]*data-cost-set-act="retry-history"/,
    );
  } finally {
    global.costToday = V.costToday;
  }
});

test('restate errors: the server path-free message; a newer request drops an older answer', async () => {
  resetState();
  global.costToday = () => '2026-10-28';
  const r = U.COST_SET.restate;
  Object.assign(r, { from: '2026-10-01', to: '2026-10-27', preview: null, of: null, error: null });
  fakeServer({
    'POST /api/cost/restate/preview': {
      status: 503,
      json: { error: 'ledger month 2026-10 could not be read', code: 'LEDGER_MONTH_UNREAD' },
    },
  });
  try {
    await U.costSetRestatePreview();
    assert.equal(r.error, 'ledger month 2026-10 could not be read');
    assert.equal(r.preview, null);
    const pending = [];
    global.fetch = () => new Promise((res) => pending.push(res));
    const a = U.costSetRestatePreview();
    const b = U.costSetRestatePreview();
    pending[1]({ status: 200, json: async () => ({ changed: 0, tag: 'newer' }) });
    await b;
    pending[0]({ status: 200, json: async () => ({ changed: 0, tag: 'older' }) });
    await a;
    assert.equal(r.preview.tag, 'newer');
  } finally {
    global.costToday = V.costToday;
  }
});

test('costsettings.js builds no markup from server or owner text without esc() (S1), and every name is cost-prefixed', () => {
  const src = read('costsettings.js');
  const CONTENT =
    /\.(name|reason|reasons|project|model|center|provider|source|plan|label|title|text|error|message|id|key|keyId|keyName|value|code|currency|cur|from|to|note|dim|budget|glob|perUSD|feeUSD|period|testPath)$/;
  const bare = [...src.matchAll(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)].map((m) => m[1]).filter((e) => CONTENT.test(e));
  assert.deepEqual(bare, [], 'content interpolated without esc()');
  for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g))
    assert.doesNotMatch(m[1], /^\s*[\w$.]+\.(message|error|reason|name|text|project)\s*$/, `innerHTML = ${m[1]}`);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\son[a-z]+=["`']/);
  for (const [, name] of src.matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(name, /^(?:cost|COST)/, `${name}: starts with cost`);
  // Loads in Node without a DOM (this file required it above) and every panel has a body.
  assert.deepEqual(Object.keys(U.COST_SET_BODIES).sort(), ['billing', 'currency', 'restate', 'rules']);
  for (const p of ['rules', 'billing', 'currency', 'restate'])
    assert.ok(U.costSetPageHtml(ST()).includes(`data-cost-set-body="${p}"`));
});

test('restate: the history loads once, Open Restate fills this month, a request in flight blocks the others', async (t) => {
  resetState();
  const realFetch = global.fetch;
  const realToday = global.costToday;
  t.after(() => {
    global.fetch = realFetch;
    global.costToday = realToday;
  });
  global.costToday = () => '2026-11-01';
  Object.assign(U.COST_SET, { history: null, historyError: null, historyLoading: false });
  Object.assign(U.COST_SET.open, { restate: false });
  const calls = fakeServer({ 'GET /api/cost/restates': { status: 200, json: { restates: [] } } });
  // Opened by hand, then a settings load while the request is in flight: one request.
  const first = U.costSetLoadHistory();
  assert.equal(U.COST_SET.historyLoading, true);
  U.COST_SET_ACTIONS['open-restate']();
  await first;
  assert.equal(calls.length, 1, 'no second request while the first is in flight');
  assert.deepEqual(
    [U.COST_SET.restate.from, U.COST_SET.restate.to],
    ['2026-10-01', '2026-10-31'],
    'on the 1st: last month',
  );
  assert.equal(U.COST_SET.open.restate, true);
  U.COST_SET_ACTIONS['open-restate']();
  assert.equal(calls.length, 1, 'held history is not loaded again');
  const base = { from: 'a', to: 'b', reason: 'x', ack: true, preview: {}, of: { from: 'a', to: 'b', gen: 0 } };
  assert.equal(U.costSetCanRun({ ...base, loading: true }, 0, false), false, 'a preview in flight');
  // A preview request is ignored while a run is in flight.
  Object.assign(U.COST_SET.restate, { from: '2026-10-01', to: '2026-10-27', running: true });
  await U.costSetRestatePreview();
  assert.equal(calls.length, 1, 'no preview request during a run');
  U.COST_SET.restate.running = false;
});

test('restate: Run waits for a Save in flight; leaving the page during a run clears the held confirmation', async (t) => {
  resetState();
  const realFetch = global.fetch;
  t.after(() => (global.fetch = realFetch));
  const r = U.COST_SET.restate;
  const arm = () =>
    Object.assign(r, {
      from: '2026-10-01',
      to: '2026-10-27',
      reason: 'why',
      ack: true,
      preview: { changed: 1 },
      of: { from: '2026-10-01', to: '2026-10-27', gen: U.COST_SET.gen },
      running: false,
      loading: false,
    });
  arm();
  assert.equal(U.costSetCanRun(r, U.COST_SET.gen, false, 0), true);
  assert.equal(U.costSetCanRun(r, U.COST_SET.gen, false, 1), false, 'a Save is pending');
  // A Save started and not answered: Run is refused and drawn disabled.
  const pending = [];
  global.fetch = (url, opts = {}) => new Promise((res) => pending.push({ url, method: opts.method || 'GET', res }));
  const save = U.costSetSave('rules');
  assert.equal(U.COST_SET.savesPending, 1);
  assert.match(
    U.costSetRestateHtml(ST({ restate: { ...r }, savesPending: 1 })),
    /data-cost-set-act="restate-run" disabled/,
  );
  await U.costSetRunRestate();
  assert.equal(pending.filter((p) => p.url === '/api/cost/restate').length, 0, 'no restate while a Save is pending');
  pending[0].res({ status: 500, json: async () => ({ error: 'no' }) });
  await save;
  assert.equal(U.COST_SET.savesPending, 0, 'the Save answered');
  // Leaving the page during a run: nothing is left to click again, and the history reloads.
  arm();
  U.COST_SET.history = [{}];
  global.fetch = () => new Promise(() => {});
  const run = U.costSetRunRestate();
  assert.equal(r.running, true);
  U.costSetUnmount();
  assert.deepEqual(
    [r.running, r.preview, r.of, r.reason, r.ack, U.COST_SET.history],
    [false, null, null, '', false, null],
  );
  void run;
});
