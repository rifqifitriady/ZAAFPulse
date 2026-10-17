const test = require('node:test');
const assert = require('node:assert/strict');
const { secretsFor } = require('./helpers');
const { createIntegrations } = require('../lib/integrations');
const { tool, S } = require('../lib/connectors/base');

let healthCalls = 0;
const fake = {
  type: 'fake',
  create(id, cfg) {
    if (cfg.broken) throw new Error('bad config key-abcdef');
    return {
      tools: [
        tool('read', 'Read', { q: S.str('Query'), n: S.int('N') }, async (a) => ({ got: a.q ?? null }), { required: [] }),
        tool('need', 'Needs q', { q: S.str('Query') }, async (a) => a.q, { required: ['q'] }),
        tool('write', 'Write', {}, async () => 'done', { write: true, annotations: { destructiveHint: false } }),
        tool('boom', 'Fails', {}, async () => { throw new Error('upstream said key-abcdef'); }),
        tool('big', 'Large', {}, async () => 'x'.repeat(60000)),
      ],
      health: async () => { healthCalls++; return { ok: true, latencyMs: 3 }; },
    };
  },
};
const accFake = { type: 'acc', create: () => ({ tools: [], health: async () => ({ ok: true, latencyMs: 0 }) }) };
const build = (integrations, extra = {}) => {
  const secrets = secretsFor({ K: 'key-abcdef' });
  secrets.resolve({ env: 'K' });
  return createIntegrations({ config: { integrations }, secrets, connectors: { fake, acc: accFake }, ...extra });
};

test('prefixes tools and hides write tools without allowWrite', async () => {
  const names = (await build({ one: { type: 'fake' }, two: { type: 'fake', allowWrite: true } }).listTools()).map((t) => t.name);
  assert.ok(names.includes('one_read'));
  assert.ok(!names.includes('one_write'));
  assert.ok(names.includes('two_write'));
});

test('annotations mark read and write tools', async () => {
  const tools = await build({ two: { type: 'fake', allowWrite: true } }).listTools();
  assert.equal(tools.find((t) => t.name === 'two_read').annotations.readOnlyHint, true);
  assert.deepEqual(tools.find((t) => t.name === 'two_write').annotations, { readOnlyHint: false, destructiveHint: false });
});

test('a broken, unknown, disabled or badly named integration does not affect the others', async () => {
  const reg = build({ bad: { type: 'fake', broken: true }, odd: { type: 'nope' }, off: { type: 'fake', enabled: false }, 'Bad_Id': { type: 'fake' }, good: { type: 'fake' } });
  const st = Object.fromEntries((await reg.status()).map((s) => [s.id, s]));
  assert.equal(st.bad.state, 'error');
  assert.equal(st.bad.error, 'bad config ***');
  assert.match(st.odd.error, /unknown type "nope"/);
  assert.equal(st.off.state, 'disabled');
  assert.match(st.Bad_Id.error, /id must match/);
  assert.equal(st.good.state, 'ok');
  assert.equal(st.good.tools, 4);
  assert.equal(st.acc.state, 'ok');
});

test('validates arguments before running', async () => {
  const reg = build({ one: { type: 'fake' } });
  const text = async (name, args) => (await reg.callTool(name, args)).result.content[0].text;
  assert.match(await text('one_need', {}), /missing required argument "q"/);
  assert.match(await text('one_read', { zzz: 1 }), /unknown argument "zzz"/);
  assert.match(await text('one_read', { n: 1.5 }), /"n" must be integer/);
  assert.match(await text('one_read', { q: 7 }), /"q" must be string/);
  assert.equal((await reg.callTool('one_need', {})).result.isError, true);
});

test('returns JSON text, masks errors and audits argument names only', async () => {
  const entries = [];
  const reg = build({ one: { type: 'fake' } }, { audit: { record: (e) => entries.push(e) } });
  const ok = await reg.callTool('one_read', { q: 'secret question' });
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { got: 'secret question' });
  const bad = await reg.callTool('one_boom', {});
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.content[0].text, 'upstream said ***');
  assert.deepEqual(entries.map((e) => [e.integration, e.tool, e.ok, e.args]), [['one', 'one_read', true, ['q']], ['one', 'one_boom', false, []]]);
  assert.ok(!JSON.stringify(entries).includes('secret question'));
});

test('unknown tools are protocol errors', async () => {
  assert.equal((await build({}).callTool('nope_x', {})).error.code, -32602);
});

test('caps large results', async () => {
  const text = (await build({ one: { type: 'fake' } }).callTool('one_big', {})).result.content[0].text;
  assert.ok(Buffer.byteLength(text) < 52 * 1024);
  assert.match(text, /truncated: 59 KB result cut to 50 KB/);
});

test('caches health for a minute unless asked for a fresh check', async () => {
  let t = 1000;
  const reg = build({ one: { type: 'fake' } }, { now: () => t });
  healthCalls = 0;
  await reg.status({ only: 'one' }); await reg.status({ only: 'one' });
  assert.equal(healthCalls, 1);
  await reg.status({ only: 'one', fresh: true });
  assert.equal(healthCalls, 2);
  t += 61000;
  await reg.status({ only: 'one' });
  assert.equal(healthCalls, 3);
});
