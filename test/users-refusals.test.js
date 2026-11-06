// Dashboard users (AI Governance 4): refused requests in the audit log, at most 30 per account a minute
// (lib/users/refusals.js); past that one audit.refused_dropped entry a minute with the count left out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRefusalLog, LIMIT, WINDOW_MS } = require('../lib/users/refusals');

function setup() {
  let at = Date.UTC(2026, 10, 7, 9);
  const written = [];
  const log = createRefusalLog({ record: (e) => (written.push(e), e), now: () => at });
  return { log, written, advance: (ms) => (at += ms) };
}
const vera = { via: 'dashboard', user: 'vera', role: 'viewer' };
const entry = (i) => ({ action: 'GET /api/brain', outcome: 'refused', status: 403, i, actor: vera });

test('30 refusals a minute per account are written; the rest are counted and named once the minute is over', () => {
  assert.deepEqual([LIMIT, WINDOW_MS], [30, 60e3]);
  const s = setup();
  const kept = [];
  for (let i = 0; i < 45; i++) kept.push(s.log.refused('vera', entry(i)));
  assert.deepEqual([kept.filter(Boolean).length, s.written.length], [30, 30]);
  assert.deepEqual(
    s.written.map((e) => e.i),
    [...Array(30).keys()],
  );
  // Another account has a limit of its own.
  assert.equal(s.log.refused('rex', entry(99)).i, 99);
  s.advance(59e3);
  s.log.flush();
  assert.equal(s.written.length, 31, 'the minute is not over yet');
  s.advance(1e3);
  s.log.flush();
  assert.deepEqual(s.written.slice(31), [
    {
      action: 'audit.refused_dropped',
      outcome: 'refused',
      target: { type: 'user', id: 'vera' },
      dropped: 15,
      actor: vera,
    },
  ]);
  // A new minute: written again; a minute with nothing left out adds no count entry.
  assert.equal(s.log.refused('vera', entry(100)).i, 100);
  s.advance(60e3);
  s.log.flush();
  assert.equal(s.written.filter((e) => e.action === 'audit.refused_dropped').length, 1);
});

test('the count of a minute that is over is written by the next refusal too, before it', () => {
  const s = setup();
  for (let i = 0; i < 32; i++) s.log.refused('vera', entry(i));
  s.advance(61e3);
  assert.equal(s.log.refused('vera', entry(40)).i, 40);
  assert.deepEqual(
    s.written.slice(30).map((e) => [e.action, e.dropped ?? e.i]),
    [
      ['audit.refused_dropped', 2],
      ['GET /api/brain', 40],
    ],
  );
});
