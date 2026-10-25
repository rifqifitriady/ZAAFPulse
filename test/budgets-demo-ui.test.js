const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { costDemo, monitorsDemo } = require('../lib/demo');
const { createCost } = require('../lib/cost');
const { createBudgetService } = require('../lib/cost/budget-service');
const { alertLine, monBudgetChange } = require('../public/monitorsview');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const NOW = new Date(2026, 9, 22, 15).getTime(); // a Thursday afternoon, 70 % into October

test('demo budgets come in mixed states: used up and blocking, projected in IDR, without data', () => {
  const d = costDemo(NOW);
  assert.deepEqual(
    d.settings.budgets.map((b) => b.id),
    ['acme-gateway', 'team', 'research-week'],
  );
  const cost = createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => NOW, nocase: false });
  const svc = createBudgetService({
    getSettings: () => d.settings,
    getLegacy: () => ({ monthlyBudgetUSD: 1000, keys: [] }),
    cost,
    home: HOME,
    now: () => NOW,
    nocase: false,
    demo: { noData: d.budgetNoData },
  });
  assert.equal(svc.list().complete, true, 'the demo list validates');
  const v = Object.fromEntries(svc.evaluate().map((x) => [x.id, x]));
  assert.deepEqual([v['acme-gateway'].state, v['acme-gateway'].enforce], ['exceeded', 'block']);
  assert.equal(v.team.projected, true);
  assert.notEqual(v.team.state, 'exceeded');
  assert.equal(v.team.currency, 'IDR');
  assert.equal(v['research-week'].state, 'no_data');
  assert.match(v['research-week'].reason, /\(demo\)/);
  assert.equal(v['legacy-monthly'].legacy, 'monthlyBudgetUSD');
  const alerts = monitorsDemo(NOW).alerts.filter((a) => a.rule === 'budget');
  assert.deepEqual(
    alerts.map((a) => [a.instance, a.state, a.title, a.period]),
    [
      ['acme-gateway', 'exceeded', 'Acme gateway key', 'month'],
      ['team', 'warn_80', 'Whole team', 'month'],
    ],
  );
});

test('the demo team alert agrees with the team budget: same period, same state, projected alike', () => {
  const at = [
    NOW, // the 22nd, 15:00: the month
    new Date(2026, 10, 1, 23, 30).getTime(), // Sunday 23:30 on the 1st: no span fits, so the month, not projected
    new Date(2026, 11, 1, 0, 5).getTime(), // the 1st at 00:05: no span fits
    new Date(2026, 10, 2, 12).getTime(), // Monday noon on the 2nd: the day
    new Date(2026, 10, 7, 7, 30).getTime(), // Saturday 07:30 on the 7th: the week
    new Date(2026, 10, 2, 3).getTime(), // Monday 03:00 on the 2nd: no span fits
  ];
  for (const t of at) {
    const d = costDemo(t);
    const cost = createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => t, nocase: false });
    const svc = createBudgetService({
      getSettings: () => d.settings,
      getLegacy: () => ({ monthlyBudgetUSD: 1000, keys: [] }),
      cost,
      home: HOME,
      now: () => t,
      nocase: false,
      demo: { noData: d.budgetNoData },
    });
    const team = svc.evaluate().find((x) => x.id === 'team');
    const alert = monitorsDemo(t).alerts.find((a) => a.rule === 'budget' && a.instance === 'team');
    const when = new Date(t).toString();
    assert.equal(alert.period, team.period, `period at ${when}`);
    assert.equal(alert.state, team.state, `state at ${when}`);
    assert.equal(team.state, 'warn_80', `state at ${when}`);
    assert.equal(alert.projected, team.projected, `projected at ${when}`);
    assert.ok(Math.abs(team.percent - alert.value) < 0.05, `percent ${team.percent} at ${when}`);
  }
});

test('the bell and drawer: a budget alert names the budget, the share and the period', () => {
  const b = (over = {}) => ({
    id: 'a1',
    ts: 1,
    rule: 'budget',
    ruleTitle: 'Budget',
    instance: 'abc',
    sessionKey: null,
    title: 'Team',
    value: 82.4,
    threshold: 80,
    state: 'warn_80',
    previous: 'warn_50',
    period: 'month',
    projected: false,
    ...over,
  });
  const l = alertLine(b(), []);
  assert.equal(l.text, 'Budget · Passed 80% · 82.4% of the budget this month · Team');
  assert.deepEqual([l.kind, l.tone, l.href], ['change', 'warn', null]);
  assert.deepEqual(monBudgetChange(b({ state: 'exceeded', previous: 'warn_80' })), { change: 'Used up', tone: 'bad' });
  assert.deepEqual(monBudgetChange(b({ state: 'ok', previous: 'exceeded' })), {
    change: 'Back under its levels',
    tone: 'good',
  });
  assert.deepEqual(monBudgetChange(b({ state: 'warn_50', previous: 'exceeded' })), {
    change: 'Back to 50%',
    tone: 'good',
  });
  assert.deepEqual(monBudgetChange(b({ state: 'warn_50', previous: 'warn_50', projected: true })), {
    change: 'Projected to pass its amount',
    tone: 'warn',
  });
  assert.equal(alertLine(b({ period: 'week' }), []).measure, '82.4% of the budget this week');
  assert.equal(alertLine(b({ period: 'decade' }), []).measure, '82.4% of the budget this period');
  assert.equal(alertLine(b({ ruleTitle: null }), []).title, 'Budget', 'the rule title without the server one');
});

test('the old budget fields say where budgets are managed', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /Manage in Budgets/);
  assert.match(app, /monthlyBudgetManaged \? 'disabled' : ''/);
  assert.match(app, /\.\.\.\(cfg\.monthlyBudgetManaged \? \{\} : \{ monthlyBudgetUSD:/, 'a managed field is not sent');
  const gw = fs.readFileSync(path.join(__dirname, '..', 'public', 'gatewayview.js'), 'utf8');
  assert.match(gw, /Manage in Budgets/);
});
