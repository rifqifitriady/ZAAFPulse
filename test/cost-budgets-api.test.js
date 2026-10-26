// test/cost-budgets-api.test.js (in process; Task 8 adds the spawned server in test/budgets-http.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { createBudgetService } = require('../lib/cost/budget-service');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\/|~[\\/]/;
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-budgets-api-'));
const BASE = {
  centers: [{ id: 'acme', name: 'Acme' }],
  currency: { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 16000 }] },
};
const ACME = {
  id: 'acme-key',
  name: 'Acme key',
  scope: { dim: 'key', value: 'key_a' },
  period: 'month',
  amount: 0.004,
  enforce: 'block',
};

function setup({
  budgets = [ACME],
  monthly = 1,
  keys = [{ id: 'key_b', name: 'Lab', budgetUSD: 2 }],
  saveThrows = false,
  onChangeThrows = false,
} = {}) {
  const dir = tmp();
  const st = { saved: { ...BASE, budgets }, monthly, keys, t: at(22), saves: [], changes: 0, pauseOff: null };
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const cost = createCost({
    dir: path.join(dir, 'cost'),
    gatewayLog,
    getPricing: () => PRICE_A,
    getSettings: () => st.saved,
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const budgetsSvc = createBudgetService({
    getSettings: () => st.saved,
    getLegacy: () => ({ monthlyBudgetUSD: st.monthly, keys: st.keys }),
    cost,
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const api = createCostApi({
    cost,
    settings: { get: () => st.saved, save: (v) => (st.saved = v) },
    listKeys: () => st.keys,
    home: HOME,
    now: () => st.t,
    budgets: budgetsSvc,
    budgetStore: {
      save: (list, clears) => {
        if (saveThrows)
          throw Object.assign(new Error(`could not write ${HOME}\\zp\\config.json or C:\\zp\\config.json`), {
            status: 500,
          });
        st.saved = { ...st.saved, budgets: list };
        st.saves.push(clears);
        if (clears.clearMonthly) st.monthly = 0;
        if (clears.clearKey) st.keys = st.keys.map((k) => (k.id === clears.clearKey ? { ...k, budgetUSD: null } : k));
      },
    },
    pauseOff: () => st.pauseOff,
    onChange: () => {
      st.changes++;
      budgetsSvc.invalidate();
      if (onChangeThrows) throw new Error(`refresh failed at ${HOME}/zp`);
    },
  });
  const bodies = [];
  const call = async (method, p, { body, type = 'application/json' } = {}) => {
    const res = await api.route({
      method,
      path: p,
      query: new URLSearchParams(),
      contentType: type,
      readBody: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
    });
    if (res) bodies.push(JSON.stringify(res.body));
    return res;
  };
  const line = (ts) =>
    fs.appendFileSync(
      gatewayLog,
      JSON.stringify({
        ts,
        keyId: 'key_a',
        provider: 'p',
        model: 'claude-sonnet-5-5',
        kind: 'chat',
        input: 1000,
        output: 100,
      }) + '\n',
    );
  return { st, cost, budgetsSvc, call, bodies, line };
}
const byId = (r) => Object.fromEntries(r.body.budgets.map((b) => [b.id, b]));

test('GET budgets: saved and legacy budgets with spent, percent, state, period bounds and legacy', async () => {
  const s = setup();
  s.line(at(22, 9));
  s.cost.update();
  const r = await s.call('GET', '/api/cost/budgets');
  assert.equal(r.status, 200);
  const b = byId(r);
  assert.deepEqual(Object.keys(b).sort(), ['acme-key', 'legacy-key-key_b', 'legacy-monthly']);
  const acme = b['acme-key'];
  for (const k of 'spent spentUSD amountUSD percent projected state from to periodKey legacy'.split(' '))
    assert.ok(k in acme, k);
  assert.deepEqual(
    [acme.state, acme.percent, acme.from, acme.to, acme.legacy],
    ['warn_50', 75, '2026-10-01', '2026-10-31', null],
  );
  assert.equal(b['legacy-monthly'].legacy, 'monthlyBudgetUSD');
  assert.equal(b['legacy-key-key_b'].legacy, 'keyBudget');
  assert.equal(b['legacy-key-key_b'].enforce, 'block');
  assert.deepEqual(
    [r.body.error, r.body.reasons, r.body.guard, r.body.kept],
    [null, [], { error: null, problems: [] }, { error: null }],
  );
});

test('POST budgets: creates and updates one budget; 400 with reasons; 409 for a pause while agent control is off', async () => {
  const s = setup();
  const team = { id: 'team', name: 'Team', scope: 'global', period: 'week', amount: 160000, currency: 'IDR' };
  const made = await s.call('POST', '/api/cost/budgets', { body: team });
  assert.equal(made.status, 200);
  assert.deepEqual([made.body.budget.id, made.body.budget.currency, made.body.budget.amountUSD], ['team', 'IDR', 10]);
  assert.deepEqual(
    s.st.saved.budgets.map((b) => b.id),
    ['acme-key', 'team'],
  );
  assert.equal(s.st.changes, 1);
  const edited = await s.call('POST', '/api/cost/budgets', { body: { ...ACME, amount: 1 } });
  assert.equal(edited.status, 200);
  assert.deepEqual(
    s.st.saved.budgets.map((b) => [b.id, b.amount]),
    [
      ['acme-key', 1],
      ['team', 160000],
    ],
    'in place',
  );
  for (const [body, re] of [
    [{ ...team, scope: { dim: 'team', value: 'x' } }, /scope\.dim/],
    [{ ...team, scope: { dim: 'model', value: '' } }, /scope\.value/],
    [{ ...team, amount: 0 }, /amount/],
    [{ ...team, currency: 'EUR' }, /currency: USD or IDR/],
    [{ ...team, enforce: 'block', scope: { dim: 'project', value: '~/x' } }, /enforce: block/],
    [{ ...team, enforce: 'block', scope: { dim: 'source', value: 'codex' } }, /enforce: block/],
    [{ ...team, enforce: 'pause', scope: { dim: 'key', value: 'key_a' } }, /enforce: pause/],
    [{ ...team, enforce: 'pause', scope: { dim: 'provider', value: 'groq' } }, /enforce: pause/],
    [{ ...team, legacy: 'keyBudget' }, /legacy/],
  ]) {
    const r = await s.call('POST', '/api/cost/budgets', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, 'invalid budget');
    assert.match(r.body.reasons.join(' | '), re);
  }
  s.st.pauseOff = 'agent control is off on this server';
  const paused = await s.call('POST', '/api/cost/budgets', { body: { ...team, enforce: 'pause' } });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /agent control is off/);
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: { ...team, enforce: 'none' } })).status, 200);
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: team, type: 'text/plain' })).status, 415);
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: '[1]' })).status, 400);
});

test('editing a legacy budget saves it and clears the old setting; a delete clears it too', async () => {
  const s = setup();
  const monthly = { id: 'legacy-monthly', name: 'Team month', scope: 'global', period: 'month', amount: 60 };
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: monthly })).status, 200);
  assert.deepEqual(s.st.saves.at(-1), { clearMonthly: true, clearKey: null });
  assert.equal(s.st.monthly, 0);
  let b = byId(await s.call('GET', '/api/cost/budgets'));
  assert.deepEqual([b['legacy-monthly'].amount, b['legacy-monthly'].legacy], [60, null], 'listed once, as saved');
  const key = {
    id: 'legacy-key-key_b',
    name: 'Lab key',
    scope: { dim: 'key', value: 'key_b' },
    period: 'month',
    amount: 3,
    enforce: 'block',
  };
  assert.equal((await s.call('POST', '/api/cost/budgets', { body: key })).status, 200);
  assert.deepEqual(s.st.saves.at(-1), { clearMonthly: false, clearKey: 'key_b' });
  assert.equal(s.st.keys[0].budgetUSD, null);
  assert.deepEqual((await s.call('POST', '/api/cost/budgets/acme-key/delete', { body: {} })).body, {
    deleted: 'acme-key',
  });
  b = byId(await s.call('GET', '/api/cost/budgets'));
  assert.equal('acme-key' in b, false);
  const fresh = setup({ budgets: [] });
  assert.equal((await fresh.call('POST', '/api/cost/budgets/legacy-key-key_b/delete', { body: {} })).status, 200);
  assert.deepEqual(
    fresh.st.saves.at(-1),
    { clearMonthly: false, clearKey: 'key_b' },
    'a legacy delete clears its old setting',
  );
  assert.equal((await fresh.call('POST', '/api/cost/budgets/nope/delete', { body: {} })).status, 404);
  assert.equal((await fresh.call('GET', '/api/cost/budgets/nope/delete')).status, 405);
  assert.equal(
    (await fresh.call('POST', '/api/cost/budgets/legacy-monthly/delete', { body: {}, type: 'text/plain' })).status,
    415,
  );
});

test('a saved list that does not validate: listed with its reasons, changes refused until it is fixed', async () => {
  const s = setup();
  assert.equal((await s.call('GET', '/api/cost/budgets')).status, 200); // the list read once while it was valid
  s.st.saved = { ...BASE, budgets: [ACME, { id: 'x' }] };
  const r = await s.call('GET', '/api/cost/budgets');
  assert.equal(r.status, 200);
  assert.match(r.body.error, /the last valid list is in force/);
  assert.ok(r.body.reasons.some((x) => /budgets\[1\]/.test(x)));
  assert.ok('acme-key' in byId(r), 'the last valid list is still in force');
  const post = await s.call('POST', '/api/cost/budgets', { body: ACME });
  assert.equal(post.status, 409);
  assert.equal((await s.call('POST', '/api/cost/budgets/acme-key/delete', { body: {} })).status, 409);
  assert.deepEqual(s.st.saved.budgets.length, 2, 'the hand edit is left as it is');
});

test('the settings save keeps the budgets; errors are path-free', async () => {
  const s = setup();
  const r = await s.call('POST', '/api/cost/settings', { body: { centers: [{ id: 'acme', name: 'Acme Corp' }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(
    s.st.saved.budgets.map((b) => b.id),
    ['acme-key'],
  );
  assert.equal(s.st.saved.centers[0].name, 'Acme Corp');
  assert.ok(s.st.changes >= 1);
  const broken = setup({ saveThrows: true });
  const fail = await broken.call('POST', '/api/cost/budgets', { body: { ...ACME, amount: 2 } });
  assert.equal(fail.status, 500);
  assert.match(fail.body.error, /\[path\]/);
  for (const b of [...s.bodies, ...broken.bodies]) assert.doesNotMatch(b, PATHS, b);
});

test('the guard problems are listed per budget, path-free', async () => {
  const s = setup();
  s.budgetsSvc.reportGuard(`the ledger month could not be read at ${HOME}/zp/.data/cost; requests are let through`, [
    { budget: 'acme-key', reason: `ledger unread at ${HOME}\\zp\\.data and C:\\zp\\cost`, since: at(22, 8) },
    { budget: null, reason: 'the budget list could not be read', since: at(22, 9) },
  ]);
  const r = await s.call('GET', '/api/cost/budgets');
  assert.equal(r.status, 200);
  assert.match(r.body.guard.error, /requests are let through/);
  assert.deepEqual(
    r.body.guard.problems.map((p) => [p.budget, p.since]),
    [
      ['acme-key', at(22, 8)],
      [null, at(22, 9)],
    ],
  );
  assert.match(r.body.guard.problems[0].reason, /^ledger unread at \[path\]/);
  assert.equal(r.body.guard.problems[1].reason, 'the budget list could not be read');
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS, b);
});

test('400 reasons are path-free in the budget and the settings saves', async () => {
  const s = setup();
  const names = [`${HOME}/secret`, 'C:\\Users\\x\\y', '~\\secret\\a'];
  const extra = Object.fromEntries(names.map((n) => [n, 1]));
  const budget = await s.call('POST', '/api/cost/budgets', { body: { ...ACME, ...extra } });
  assert.equal(budget.status, 400);
  assert.equal(budget.body.reasons.filter((x) => /^unknown field: \[path\]/.test(x)).length, 3);
  const cfg = await s.call('POST', '/api/cost/settings', { body: { ...BASE, ...extra } });
  assert.equal(cfg.status, 400);
  assert.equal(cfg.body.reasons.filter((x) => /^unknown field: \[path\]/.test(x)).length, 3);
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS, b);
});

test('a settings save that would make a saved budget invalid is refused until the budget is changed', async () => {
  const center = {
    id: 'acme-c',
    name: 'Acme center',
    scope: { dim: 'center', value: 'acme' },
    period: 'month',
    amount: 5,
  };
  const idr = { id: 'team-idr', name: 'Team', scope: 'global', period: 'week', amount: 160000, currency: 'IDR' };
  const s = setup({ budgets: [center, idr] });
  const before = JSON.stringify(s.st.saved);
  const noCenter = await s.call('POST', '/api/cost/settings', { body: { ...BASE, centers: [] } });
  assert.equal(noCenter.status, 409);
  assert.equal(noCenter.body.error, 'budgets depend on these settings; edit or delete them first');
  assert.deepEqual(noCenter.body.reasons, ['budget acme-c: scope.value: unknown cost center']);
  const noCurrency = await s.call('POST', '/api/cost/settings', { body: { ...BASE, currency: null } });
  assert.equal(noCurrency.status, 409);
  assert.deepEqual(noCurrency.body.reasons, ['budget team-idr: currency: USD']);
  assert.equal(JSON.stringify(s.st.saved), before, 'nothing is written on a refusal');
  assert.equal(s.st.changes, 0);
  assert.equal((await s.call('POST', '/api/cost/budgets/acme-c/delete', { body: {} })).status, 200);
  assert.equal((await s.call('POST', '/api/cost/settings', { body: { ...BASE, centers: [] } })).status, 200);
  assert.deepEqual(s.st.saved.centers, []);
  assert.equal((await s.call('POST', '/api/cost/budgets/team-idr/delete', { body: {} })).status, 200);
  assert.equal((await s.call('POST', '/api/cost/settings', { body: { ...BASE, currency: null } })).status, 200);
  assert.deepEqual(s.st.saved.budgets, [], 'the list stays as the budget routes left it');
});

test('the settings check: skipped while the saved list is a broken hand edit; its 409 reasons stop at 50', async () => {
  const onAcme = (i) => ({
    id: `c${i}`,
    name: `Center ${i}`,
    scope: { dim: 'center', value: 'acme' },
    period: 'month',
    amount: 5,
  });
  // A hand edit that does not validate: a settings save is the owner's way to fix it, so it is not checked.
  const s = setup({ budgets: [onAcme(0)] });
  assert.equal((await s.call('GET', '/api/cost/budgets')).status, 200);
  s.st.saved = { ...BASE, budgets: [onAcme(0), { id: 'x' }] };
  const r = await s.call('POST', '/api/cost/settings', { body: { ...BASE, centers: [] } });
  assert.equal(r.status, 200, 'not checked while the saved list does not validate');
  assert.deepEqual(s.st.saved.centers, []);
  assert.equal(s.st.saved.budgets.length, 2, 'the hand edit is kept as it is');
  // 80 budgets on the center: the refusal lists 50 of them.
  const many = setup({ budgets: Array.from({ length: 80 }, (_, i) => onAcme(i)) });
  const refused = await many.call('POST', '/api/cost/settings', { body: { ...BASE, centers: [] } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reasons.length, 50);
  assert.equal(refused.body.reasons[49], 'budget c49: scope.value: unknown cost center');
});

test('a restate refreshes the budgets; the 101st budget is refused with reasons; editing at the limit is not', async () => {
  const s = setup();
  const r = await s.call('POST', '/api/cost/restate', {
    body: { from: '2026-10-01', to: '2026-10-21', reason: 'new prices', confirm: true },
  });
  assert.equal(r.status, 200);
  assert.equal(s.st.changes, 1);
  const many = Array.from({ length: 100 }, (_, i) => ({ ...ACME, id: `b${i}`, enforce: 'none' }));
  const full = setup({ budgets: many });
  const over = await full.call('POST', '/api/cost/budgets', { body: { ...ACME, id: 'b100' } });
  assert.equal(over.status, 400);
  assert.deepEqual(over.body, { error: 'invalid budget', reasons: ['at most 100 budgets'] });
  assert.equal(full.st.saves.length, 0);
  assert.equal((await full.call('POST', '/api/cost/budgets', { body: { ...ACME, id: 'b99', amount: 2 } })).status, 200);
});

test('an onChange that throws never fails the request', async () => {
  const s = setup({ onChangeThrows: true });
  const r = await s.call('POST', '/api/cost/budgets', { body: { ...ACME, amount: 2 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.budget.amount, 2);
  assert.equal(s.st.changes, 1);
  assert.equal((await s.call('POST', '/api/cost/budgets/acme-key/delete', { body: {} })).status, 200);
});

test("a view's reason is path-free; its project folder is kept as ~", async () => {
  const view = {
    id: 'proj',
    name: 'Project',
    scope: { dim: 'project', value: '~/work/app' },
    state: 'no_data',
    reason: `the ledger month could not be read at ${HOME}/zp/.data/cost/2026-10.jsonl or C:\\zp\\cost`,
  };
  const status = { error: null, reasons: [], guard: null, guardProblems: [], kept: null };
  const api = createCostApi({
    cost: {},
    settings: { get: () => ({}), save: () => {} },
    home: HOME,
    budgets: { evaluate: () => [view], status: () => status },
  });
  const r = await api.route({ method: 'GET', path: '/api/cost/budgets', query: new URLSearchParams() });
  assert.equal(r.status, 200);
  assert.match(r.body.budgets[0].reason, /^the ledger month could not be read at \[path\]/);
  assert.doesNotMatch(r.body.budgets[0].reason, PATHS);
  assert.equal(r.body.budgets[0].scope.value, '~/work/app');
});
