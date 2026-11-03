// Governance audit log (AI Governance 2): the Monitors rules audit_degraded and audit_chain_broken
// (lib/monitors/rules.js), the engine's input for them (lib/monitors/index.js) and their words on the Monitors page.
// The alerts carry a count or a seq and a fixed reason, never anything from an entry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RULES, evaluate } = require('../lib/monitors/rules');
const { createMonitors } = require('../lib/monitors');
const { createMonitorState } = require('../lib/monitors/state');

const NOW = new Date(2026, 10, 3, 12).getTime();
const rule = (id) => RULES.find((r) => r.id === id);
const run = (id, snap) => evaluate(rule(id), {}, snap, NOW);

test('the rules: aggregate, on by default, never pausing, no parameters', () => {
  assert.deepEqual(
    ['audit_degraded', 'audit_chain_broken'].map((id) => {
      const r = rule(id);
      return [r.title, r.kind, r.params, r.defaultOn({}), r.mayAutoPause];
    }),
    [
      ['Audit log degraded', 'aggregate', {}, true, false],
      ['Audit chain broken', 'aggregate', {}, true, false],
    ],
  );
  assert.equal(
    rule('audit_degraded').describe,
    'The governance audit log cannot write its entries; changes go ahead unrecorded until it can.',
  );
  assert.equal(
    rule('audit_chain_broken').describe,
    'The daily check of the governance audit log found an entry changed, missing or out of order, or the audit key replaced.',
  );
});

test('audit_degraded: triggered while writing fails, its value the entries missed', () => {
  const one = (snap) => run('audit_degraded', snap)[0];
  assert.deepEqual(one({ audit: { degraded: { since: 'x', missed: 3 }, lastVerify: null } }), {
    instance: 'all',
    sessionId: null,
    state: 'triggered',
    value: 3,
    threshold: 1,
  });
  assert.equal(one({ audit: { degraded: null, lastVerify: null } }).state, 'ok');
  assert.equal(one({}).state, 'no_data');
});

test('audit_chain_broken: triggered by a failed verify, titled with its reason only; no verify yet is no_data', () => {
  const one = (v) => run('audit_chain_broken', { audit: { degraded: null, lastVerify: v } })[0];
  assert.deepEqual(one({ ok: false, brokenAt: 41, reason: 'entry changed', at: 'x' }), {
    instance: 'all',
    sessionId: null,
    state: 'triggered',
    value: 41,
    threshold: null,
    title: 'entry changed',
  });
  assert.deepEqual(
    [one({ ok: false, brokenAt: null, reason: 'key missing' }).value, one({ ok: false, reason: 'odd <b>' }).title],
    [0, undefined],
  );
  assert.equal(one({ ok: true, checked: 9 }).state, 'ok');
  assert.equal(one(null).state, 'no_data');
});

test('audit_chain_broken: a rekey alerts for 7 days from its entry, with its seq; a broken chain comes first', () => {
  const one = (v) => run('audit_chain_broken', { audit: { degraded: null, lastVerify: v } })[0];
  const ago = (days) => new Date(NOW - days * 864e5).toISOString();
  const rekeyed = { ok: true, checked: 9, from: 1, to: 9, rekeyedAt: 7, rekeyedTs: ago(2) };
  assert.deepEqual(one(rekeyed), {
    instance: 'all',
    sessionId: null,
    state: 'triggered',
    value: 7,
    threshold: null,
    title: 'rekeyed',
  });
  assert.equal(one({ ...rekeyed, rekeyedTs: ago(8) }).state, 'ok');
  assert.equal(one({ ...rekeyed, rekeyedTs: 'not a time' }).state, 'triggered'); // unknown age: loud
  assert.equal(one({ ...rekeyed, unverified: 6 }).title, 'rekeyed');
  assert.deepEqual(
    [one({ ok: false, brokenAt: 3, reason: 'entry changed', rekeyedAt: 7, rekeyedTs: ago(1) })].map((r) => [
      r.value,
      r.title,
    ]),
    [[3, 'entry changed']],
  );
});

test('the Monitors page words', () => {
  const { monMeasure } = require('../public/monitorsview');
  assert.equal(monMeasure('audit_degraded', 1, 1), '1 audit entry not written');
  assert.equal(monMeasure('audit_degraded', 4, 1), '4 audit entries not written');
  assert.equal(monMeasure('audit_chain_broken', 41, null), 'broken at entry 41');
  assert.equal(monMeasure('audit_chain_broken', 0, null), 'cannot be checked');
  assert.equal(monMeasure('audit_chain_broken', 7, null, 'rekeyed'), 'key replaced at entry 7');
});

test('engine: the audit status is read on each aggregate pass and a broken chain alerts once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-mon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: NOW };
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => clock.t,
  });
  const sent = [];
  let status = { months: [], degraded: null, lastVerify: { ok: false, brokenAt: 7, reason: 'chain broken' } };
  const monitors = createMonitors({
    indexer: { results: () => [] },
    office: { snapshot: () => ({ agents: [] }), demoSnapshot: () => ({ agents: [] }) },
    evals: { summary: () => ({ evaluators: {} }) },
    config: () => ({}),
    state,
    channels: { notify: async (alert) => sent.push(alert) },
    now: () => clock.t,
    auditStatus: () => status,
  });
  await monitors.tickAggregate();
  const broken = sent.filter((a) => a.rule === 'audit_chain_broken');
  assert.deepEqual(
    broken.map((a) => [a.state, a.value, a.title]),
    [['triggered', 7, 'chain broken']],
  );
  assert.equal(sent.filter((a) => a.rule === 'audit_degraded').length, 0);
  status = { months: [], degraded: { since: 'x', missed: 2 }, lastVerify: status.lastVerify };
  clock.t += 60e3;
  await monitors.tickAggregate();
  assert.equal(sent.filter((a) => a.rule === 'audit_chain_broken').length, 1, 'still broken: no second alert');
  assert.deepEqual(
    sent.filter((a) => a.rule === 'audit_degraded').map((a) => [a.state, a.value]),
    [['triggered', 2]],
  );
});
