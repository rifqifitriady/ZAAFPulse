// Cost Control → Budgets (public/costview.js): labels, ordering, the badge, the id from a name, the enforcement
// choices against the server's rules, the form to the request body, the status banners and the card and form markup;
// the bell's "Open in Budgets" link (public/monitorsview.js) and the budget id it reads from /api/alerts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const B = require('../lib/cost/budgets');
const { NO_JUDGE_PORTS } = require('./helpers');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
global.costRingSvg = require('../public/costcharts').costRingSvg; // the page loads costcharts.js beside it
const U = require('../public/costview');
const { alertLine, monAlertsBody } = require('../public/monitorsview');

const EVIL = '<img src=x onerror=alert(1)>';
const CTX = {
  centers: { platform: 'Platform' },
  keys: { key_a1: 'ci-bot' },
  display: 'IDR',
  sources: ['claude', 'gateway'],
};
const view = (over = {}) => ({
  id: 'team',
  name: 'Team',
  scope: 'global',
  period: 'month',
  amount: 100,
  currency: 'USD',
  measure: 'list',
  thresholds: [50, 80],
  projection: true,
  enforce: 'none',
  legacy: null,
  from: '2026-10-01',
  to: '2026-10-31',
  state: 'ok',
  projected: false,
  spent: 12.5,
  percent: 12.5,
  reason: null,
  ...over,
});

test('labels: the scope with names, the period with its dates', () => {
  assert.equal(U.costScopeLabel('global', CTX), 'Global');
  assert.equal(U.costScopeLabel({ dim: 'center', value: 'platform' }, CTX), 'Center · Platform');
  assert.equal(U.costScopeLabel({ dim: 'center', value: 'unassigned' }, CTX), 'Center · Unassigned');
  assert.equal(U.costScopeLabel({ dim: 'key', value: 'key_a1' }, CTX), 'Key · ci-bot');
  assert.equal(U.costScopeLabel({ dim: 'key', value: 'key_zz' }, CTX), 'Key · key_zz');
  assert.equal(U.costScopeLabel({ dim: 'source', value: 'claude' }, CTX), 'Source · Claude Code');
  assert.equal(U.costScopeLabel({ dim: 'project', value: '~/acme' }, CTX), 'Project · ~/acme');
  assert.equal(U.costPeriodLabel(view()), 'Month · 1–31 Oct');
  assert.equal(
    U.costPeriodLabel(view({ period: 'week', from: '2026-10-26', to: '2026-11-01' })),
    'Week · 26 Oct – 1 Nov',
  );
  assert.equal(U.costPeriodLabel(view({ period: 'day', from: '2026-10-27', to: '2026-10-27' })), 'Day · 27 Oct');
});

test('ordering, tones and the badge: riskiest first; used up or projected over count', () => {
  const list = [
    view({ id: 'a', state: 'ok', percent: 10 }),
    view({ id: 'b', state: 'warn_80', percent: 85 }),
    view({ id: 'c', state: 'exceeded', percent: 120 }),
    view({ id: 'd', state: 'ok', percent: 40, projected: true }),
    view({ id: 'e', state: 'no_data', percent: null }),
  ];
  assert.deepEqual(
    U.costBudgetOrder(list).map((b) => b.id),
    ['c', 'd', 'b', 'a', 'e'],
  );
  assert.deepEqual(['ok', 'warn_50', 'exceeded', 'no_data'].map(U.costTone), ['ok', 'warn', 'exceeded', 'none']);
  assert.equal(U.costBadgeCount(list), 2);
  assert.equal(U.costBadgeCount(null), 0);
});

test('the id of a new budget comes from its name, with a suffix when taken', () => {
  assert.equal(U.costIdFrom('Whole Team!'), 'whole-team');
  assert.equal(U.costIdFrom('  Ácme — gateway  '), 'acme-gateway'); // accents are dropped, not the letter
  assert.equal(U.costIdFrom('Ácme Gateway'), 'acme-gateway');
  assert.equal(U.costIdFrom('Crème brûlée'), 'creme-brulee');
  assert.equal(U.costIdFrom(''), 'budget');
  assert.equal(U.costIdFrom('***'), 'budget');
  assert.equal(U.costIdFrom('Team', ['team', 'team-2']), 'team-3');
  assert.equal(U.costIdFrom('constructor'), 'constructor-2');
  assert.equal(U.costIdFrom('x'.repeat(90)).length, 60);
  for (const n of ['Whole Team!', '', 'constructor', 'a'.repeat(90), '-x-']) {
    const r = B.validateBudget({ id: U.costIdFrom(n), name: 'n', scope: 'global', period: 'month', amount: 1 }, {});
    assert.ok(r.ok, `${n}: ${JSON.stringify(r.errors)}`);
  }
});

test('enforcement choices match the server: block and pause are offered exactly where lib/cost/budgets.js allows them', () => {
  const scopes = ['global'];
  for (const dim of B.DIMS)
    for (const value of ['x', 'gateway', 'claude', 'codex', 'judge']) scopes.push({ dim, value });
  for (const scope of scopes) {
    const o = Object.fromEntries(U.costEnforceOptions(scope).map((x) => [x.value, x]));
    const what = JSON.stringify(scope);
    assert.equal(o.none.ok, true, what);
    assert.equal(o.block.ok, B.mayBlock(scope), `block ${what}`);
    assert.equal(o.pause.ok, B.mayPause(scope), `pause ${what}`);
    if (!o.block.ok) assert.match(o.block.why, /gateway requests only/);
    if (!o.pause.ok) assert.match(o.pause.why, /local agent only/);
  }
});

test('the form to the request body: the server accepts it; a bad field is named before sending', () => {
  const f = {
    name: ' Team ',
    dim: 'center',
    value: 'platform',
    period: 'week',
    amount: '120.5',
    currency: 'IDR',
    measure: 'billed',
    warn1: '60',
    warn2: '',
    projection: false,
    enforce: 'pause',
  };
  const r = U.costFormBody(f, { id: 'team' });
  assert.deepEqual(r, {
    ok: true,
    body: {
      id: 'team',
      name: 'Team',
      scope: { dim: 'center', value: 'platform' },
      period: 'week',
      amount: 120.5,
      currency: 'IDR',
      measure: 'billed',
      thresholds: [60],
      projection: false,
      enforce: 'pause',
    },
  });
  const v = B.validateBudget(r.body, { currency: 'IDR', centers: ['platform'], home: '/home/o' });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(
    U.costFormBody({ ...f, dim: 'global', value: 'ignored', projection: 'on' }, { id: 'x' }).body.scope,
    'global',
  );
  const bad = U.costFormBody(
    { name: '', dim: 'project', value: ' ', period: 'year', amount: '0', warn1: '80', warn2: '50', enforce: 'block' },
    { id: 'x' },
  );
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [
    'Name: 1 to 60 characters',
    'Project: name one',
    'Period: day, week or month',
    'Amount: a number above 0',
    'Warning levels: whole numbers from 1 to 99, the second above the first',
    'Enforcement: block reaches gateway requests only: not a project or a local source',
  ]);
  assert.deepEqual(U.costFormBody({ ...f, warn1: '', warn2: '' }, { id: 't' }).body.thresholds, []);
});

test('status banners: a hand edit that does not validate, the kept list, the guard letting requests through', () => {
  assert.deepEqual(
    U.costBudgetBanners({
      budgets: [],
      error: null,
      reasons: [],
      guard: { error: null, problems: [] },
      kept: { error: null },
    }),
    [],
  );
  const out = U.costBudgetBanners(
    {
      budgets: [],
      error: 'budgets in config.json are invalid; the last valid list is in force',
      reasons: ['budgets[0].amount: a number above 0, up to 1e12'],
      guard: {
        error: null,
        problems: [
          { budget: 'acme', reason: 'no rates for IDR', since: null },
          { budget: null, reason: 'the list did not read', since: null },
        ],
      },
      kept: { error: 'the last valid budget list could not be kept' },
    },
    { budgets: [{ id: 'acme', name: 'Acme key' }] },
  );
  assert.deepEqual(
    out.map((b) => [b.tone, b.title, b.lines, b.note || null]),
    [
      [
        'warn',
        'budgets in config.json are invalid; the last valid list is in force',
        ['budgets[0].amount: a number above 0, up to 1e12'],
        'Fix config.json first',
      ],
      ['muted', 'the last valid budget list could not be kept', [], null],
      [
        'warn',
        'The gateway is letting requests through for these budgets',
        ['Acme key · no rates for IDR', 'All budgets · the list did not read'],
        null,
      ],
    ],
  );
});

test('a card: ring, name, scope, period, spent of amount and chips; no data shows the reason; names are text', () => {
  const card = U.costBudgetCardHtml(
    view({
      id: 'acme',
      name: EVIL,
      scope: { dim: 'key', value: 'key_a1' },
      state: 'exceeded',
      percent: 125,
      spent: 1.13,
      amount: 0.9,
      enforce: 'block',
      legacy: 'keyBudget',
    }),
    CTX,
    false,
  );
  assert.match(card, /data-cost-card="acme"/);
  assert.match(card, /tone-exceeded/);
  assert.match(card, /Key · ci-bot/);
  assert.match(card, /<b>\$1\.13<\/b> of \$0\.90/);
  for (const chip of ['Usage value', 'Blocks gateway', 'From old settings'])
    assert.match(card, new RegExp(`>${chip}<`));
  assert.match(card, />125%</);
  assert.doesNotMatch(card, /<img/);
  const none = U.costBudgetCardHtml(
    view({ state: 'no_data', percent: null, spent: null, reason: `no ${EVIL} rate` }),
    CTX,
    false,
  );
  assert.match(none, /no &lt;img src=x onerror=alert\(1\)&gt; rate/);
  assert.match(none, /stroke-dasharray="3 4"/);
  const locked = U.costBudgetCardHtml(view(), CTX, true);
  assert.equal((locked.match(/disabled/g) || []).length, 2, 'Edit and Delete wait for the fix');
});

test('the form: a new budget shows the id from its name; a legacy one says the old setting is cleared', () => {
  const add = U.costFormHtml(null, CTX, ['budget']);
  assert.match(add, /<code id="cost-form-id">budget-2<\/code>/);
  assert.match(add, /<option value="IDR"/);
  assert.match(add, /name="warn1" type="number" min="1" max="99" step="1" value="50"/);
  assert.match(add, /data-cost-id=""/);
  const legacy = U.costFormHtml(
    view({
      id: 'legacy-key-key_a1',
      name: EVIL,
      scope: { dim: 'key', value: 'key_a1' },
      enforce: 'block',
      legacy: 'keyBudget',
    }),
    CTX,
    [],
  );
  assert.match(
    legacy,
    /Saving moves this budget out of the old setting \(monthly budget \/ key budget\), which is cleared\./,
  );
  assert.match(legacy, /data-cost-id="legacy-key-key_a1"/);
  assert.match(
    legacy,
    /value="pause" {2}disabled> Pause the costliest local agent <small>pause reaches a local agent only/,
  );
  assert.match(legacy, /value="block" checked >/);
  assert.doesNotMatch(legacy, /<img/);
});

test('the bell: a budget alert links to its card in Budgets', () => {
  const a = {
    id: 'a1',
    ts: 1,
    rule: 'budget',
    ruleTitle: 'Budget',
    instance: 'opaque',
    budget: 'team-1',
    sessionKey: null,
    title: 'Team',
    value: 82.4,
    threshold: 80,
    state: 'warn_80',
    previous: 'warn_50',
    period: 'month',
    projected: false,
  };
  const l = alertLine(a, []);
  assert.equal(l.budgetHref, '#cost/budgets?focus=team-1');
  assert.equal(l.href, null);
  assert.equal(alertLine({ ...a, budget: '../x' }, []).budgetHref, undefined);
  assert.equal(alertLine({ ...a, budget: undefined }, []).budgetHref, undefined);
  // No time: the row's time needs app.js's date helpers, which the drawer has and Node does not.
  assert.match(
    monAlertsBody({ alerts: [{ ...a, ts: null }], loaded: true, error: '', readAt: 0 }),
    /href="#cost\/budgets\?focus=team-1">Open in Budgets →<\/a>/,
  );
});

test('Budgets is wired: the sidebar link, the sub-page, the badge at start and on the refresh cycle', () => {
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  assert.match(pub('index.html'), /<a class="nav-sub" href="#cost\/budgets" data-route="cost\/budgets">Budgets<\/a>/);
  assert.match(pub('iso.js'), /\['value', 'Value'\],\s*\['budgets', 'Budgets'\],/);
  const app = pub('app.js');
  assert.match(app, /monMountBell\(\);[^\n]*\n\s*costBadge\(\);/);
  // The badge refreshes on the cycle even when the summary does not load: it is called before the await.
  assert.match(app, /setInterval\(async \(\) => \{\n\s*costBadge\(\);[^\n]*\n\s*await loadSummary\(\);/);
  const css = pub('styles.css');
  for (const c of ['.cost-card', '.cost-card.cost-focus', '.cost-drawer', '.cost-radio.off'])
    assert.ok(css.includes(c), c);
});

/* ---------- fix round 1: the page's lifecycle against stubs ---------- */

// A stub page: the router's sub-page, the deck's elements and fetch, restored after each test.
function stubPage(sub) {
  const saved = { $: global.$, state: global.state, document: global.document, fetch: global.fetch };
  const calls = [];
  // The body's DOM calls: a quiet refresh that fails adds a note (`kids`) in front of what is on screen.
  const kids = [];
  const body = {
    isConnected: true,
    innerHTML: 'BREAKDOWN',
    kids,
    // `kids` are the body's own children; `nested` sit deeper (the table's own skeleton inside #cost-table).
    // ":scope > .x" matches a child only; ".x" matches at any depth, as the DOM does.
    nested: [],
    querySelector(sel) {
      const has = (k, cls) => k.className.split(' ').includes(cls);
      for (const part of sel.split(',').map((x) => x.trim())) {
        const own = part.startsWith(':scope > ');
        const cls = part.replace(':scope > ', '').slice(1);
        const hit = (own ? kids : [...kids, ...this.nested]).find((k) => has(k, cls));
        if (hit) return hit;
      }
      return null;
    },
    prepend: (el) => kids.unshift(el),
  };
  const app = { contains: () => false };
  global.state = { sub };
  global.document = {
    hidden: false,
    activeElement: null,
    createElement: (tag) => ({
      tag,
      className: '',
      textContent: '',
      attrs: {},
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
    }),
  };
  global.$ = (s) => (s === '#cost-body' ? body : s === '#cost-app' ? app : null);
  global.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.reject(new Error('offline'));
  };
  const restore = () => Object.assign(global, saved);
  return { calls, body, restore };
}

test('a reload after a save or a delete paints only into the Budgets page', async () => {
  const p = stubPage('breakdown'); // the owner moved on while the request was out
  try {
    const req = U.COST.req;
    await U.costMountBudgets(true);
    assert.equal(p.calls.length, 0, 'no budgets request for another sub-page');
    assert.equal(p.body.innerHTML, 'BREAKDOWN', 'the other page is untouched');
    assert.equal(U.COST.req, req, "the other page's own load is not dropped");
    global.state.sub = 'budgets';
    await U.costMountBudgets(false);
    assert.ok(p.calls.length > 0);
    assert.match(p.body.innerHTML, /Could not load this page: offline/);
  } finally {
    p.restore();
  }
});

test('the quiet refresh waits while the form drawer or a delete confirmation is open', async () => {
  const p = stubPage('budgets');
  try {
    U.COST.form = { id: null, isNew: true, opener: null };
    await U.costRefresh(true);
    U.COST.form = null;
    U.COST.confirm = 'team';
    await U.costRefresh(true);
    assert.equal(p.calls.length, 0, 'nothing reloaded under an open form or confirmation');
    assert.equal(p.body.innerHTML, 'BREAKDOWN');
    U.COST.confirm = null;
    await U.costRefresh(true);
    assert.ok(p.calls.length > 0, 'with neither open, the quiet refresh loads');
  } finally {
    U.COST.form = null;
    U.COST.confirm = null;
    p.restore();
  }
});

test('a delete answer clears only its own confirmation', async () => {
  const p = stubPage('breakdown'); // the reload after it is skipped: this test is about the confirmation
  try {
    let answer;
    global.fetch = () => new Promise((r) => (answer = r));
    U.COST.confirm = 'a';
    const pending = U.costDelete('a');
    U.COST.confirm = 'b'; // the owner asked to delete another card meanwhile
    answer({ status: 200, json: async () => ({ ok: true }) });
    await pending;
    assert.equal(U.COST.confirm, 'b');
    global.fetch = () => Promise.resolve({ status: 200, json: async () => ({ ok: true }) });
    await U.costDelete('b');
    assert.equal(U.COST.confirm, null);
  } finally {
    U.COST.confirm = null;
    p.restore();
  }
});

test('a failed delete never paints budget cards into another sub-page', async () => {
  const p = stubPage(''); // the owner moved to Overview while the delete was out
  const savedIcon = global.icon;
  const savedBudgets = U.COST.budgets;
  try {
    global.icon = () => '';
    p.body.querySelectorAll = () => [];
    global.document.querySelectorAll = () => [];
    U.COST.budgets = { budgets: [view()] };
    U.COST.confirm = 'team';
    await U.costDelete('team'); // fetch rejects: the error path repaints
    assert.equal(p.body.innerHTML, 'BREAKDOWN', 'Overview is untouched');
    U.costPaintBudgets();
    assert.equal(p.body.innerHTML, 'BREAKDOWN');
    global.state.sub = 'budgets';
    U.costPaintBudgets();
    assert.match(p.body.innerHTML, /data-cost-card="team"/, 'on Budgets the cards are painted');
  } finally {
    global.icon = savedIcon;
    U.COST.budgets = savedBudgets;
    U.COST.confirm = null;
    U.COST.cardMsg = {};
    p.restore();
  }
});

test('a failed quiet refresh keeps the figures on screen with a note; a load that fails shows the error and Retry', async () => {
  for (const sub of ['', 'breakdown', 'value', 'budgets']) {
    const p = stubPage(sub);
    try {
      global.fetch = () => Promise.reject(new Error(EVIL));
      p.body.innerHTML = 'FIGURES';
      await U.costRefresh(true);
      assert.equal(p.body.innerHTML, 'FIGURES', `${sub || 'overview'}: the last figures stay`);
      assert.equal(p.body.kids.length, 1);
      const note = p.body.kids[0];
      assert.equal(note.tag, 'p');
      assert.match(note.className, /cost-stale/);
      assert.equal(note.attrs.role, 'status');
      // Text, never markup: the message cannot add elements.
      assert.equal(note.textContent, 'Could not refresh: ' + EVIL + '. Showing the last figures.');
      await U.costRefresh(true);
      assert.equal(p.body.kids.length, 1, 'a second failure reuses the note');

      // A page still on its skeleton or its error panel has no figures to keep: the error panel shows.
      p.body.kids.length = 0;
      p.body.kids.push({ className: 'skeleton' });
      await U.costRefresh(true);
      assert.match(p.body.innerHTML, /Could not load this page: &lt;img/);

      p.body.kids.length = 0;
      p.body.innerHTML = 'FIGURES';
      await U.costRefresh(false);
      assert.match(p.body.innerHTML, /Could not load this page: &lt;img src=x onerror=alert\(1\)&gt;/);
      assert.match(p.body.innerHTML, /data-cost-retry/);
    } finally {
      p.restore();
    }
  }
});

test("a failed quiet refresh keeps Breakdown while only the table's own skeleton is loading", async () => {
  const p = stubPage('breakdown');
  try {
    global.fetch = () => Promise.reject(new Error('offline'));
    p.body.innerHTML = 'FIGURES';
    p.body.nested.push({ className: 'skeleton' }); // the table's request is still out
    await U.costRefresh(true);
    assert.equal(p.body.innerHTML, 'FIGURES', 'the page stays');
    assert.equal(p.body.kids.length, 1);
    assert.equal(p.body.kids[0].textContent, 'Could not refresh: offline. Showing the last figures.');
  } finally {
    p.restore();
  }
});

test('the delete confirmation names the old setting only for a budget from old settings', () => {
  try {
    U.COST.confirm = 'team';
    const plain = U.costBudgetCardHtml(view(), CTX, false);
    assert.match(plain, /Delete budget &quot;Team&quot;\?<\/p>/);
    assert.doesNotMatch(plain, /old settings also clears/);
    const legacy = U.costBudgetCardHtml(view({ legacy: 'monthlyBudgetUSD' }), CTX, false);
    assert.match(legacy, /Delete budget &quot;Team&quot;\? A budget from old settings also clears that setting\.<\/p>/);
  } finally {
    U.COST.confirm = null;
  }
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-budgets-ui-'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own: 9000-9199 (test/cost-view-api.test.js takes 8800-8999; no other test uses either).
    const port = 9000 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

test('over HTTP: the demo budget alerts name their budget for the link, path-free', async () => {
  const data = tmp();
  // Never the network: no price list fetch (the demo does not fetch either).
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ pricingSync: { enabled: false } }));
  let child = null;
  try {
    let base = null;
    for (let attempt = 0; attempt < 6 && !base; attempt++) {
      const port = await freePort();
      child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: '',
          ZAAFPULSE_CLAUDE_DIRS: '',
          XDG_CONFIG_HOME: '',
          CODEX_HOME: '',
          ...NO_JUDGE_PORTS,
          DEMO: '1',
          ZAAFPULSE_AUTH: 'none',
          ZAAFPULSE_CONTENT: '',
          ZAAFPULSE_PORT: String(port),
          ZAAFPULSE_DATA: data,
          HOME: data,
          USERPROFILE: data,
        },
        stdio: 'ignore',
      });
      for (let i = 0; i < 80 && child.exitCode === null; i++) {
        try {
          await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) });
          // An answer could come from another process on the port: trust it only while our child is still up
          // (a child that lost the port exits).
          await new Promise((r) => setTimeout(r, 200));
          if (child.exitCode === null) base = `http://127.0.0.1:${port}`;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (!base && child.exitCode === null) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
    }
    assert.ok(base, 'the demo server started');
    const text = await (await fetch(`${base}/api/alerts`)).text();
    const rows = JSON.parse(text).alerts.filter((a) => a.rule === 'budget');
    assert.deepEqual(rows.map((a) => a.budget).sort(), ['acme-gateway', 'team']);
    assert.ok(
      rows.every((a) => a.instance !== a.budget),
      'the instance id stays opaque',
    );
    assert.doesNotMatch(text, /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//);
  } finally {
    if (child && child.exitCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
    fs.rmSync(data, { recursive: true, force: true });
  }
});
