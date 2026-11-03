// Gateway guardrails (AI Governance 1): maskPii's two options for the gateway. `home: false` leaves home-folder paths
// alone (coding agents send real paths), `counts` reports how many emails, phone numbers and IP addresses were masked.
// Without options it masks exactly as before (the judge path, rule S4).
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskPii } = require('../lib/evals/pii');

const TEXT = 'mail ana@example.com from /Users/ana/app or C:\\Users\\ana\\x, call +62 812-3456-7890, ssh 10.0.0.7';

test('pii options: without options the judge path is unchanged', () => {
  assert.equal(maskPii(TEXT), 'mail ‹email› from /Users/‹user›/app or C:\\Users\\‹user›\\x, call ‹phone›, ssh ‹ip›');
});

test('pii options: home false leaves home folders as they are and still masks the rest', () => {
  assert.equal(
    maskPii(TEXT, { home: false }),
    'mail ‹email› from /Users/ana/app or C:\\Users\\ana\\x, call ‹phone›, ssh ‹ip›',
  );
  assert.equal(maskPii('cd /home/dev-01/src', { home: false }), 'cd /home/dev-01/src');
});

test('pii options: counts are per kind, only for what was masked, and add up across calls', () => {
  const counts = {};
  maskPii('a@b.io c@d.io on 127.0.0.1 and 192.168.1.2, fe80::1ff:fe23:4567:890a, a[1::2], +1 (415) 555-0172', {
    home: false,
    counts,
  });
  assert.deepEqual(counts, { email: 2, ip: 2, phone: 1 });
  maskPii('one more x@y.dev', { counts });
  assert.equal(counts.email, 3);
  const none = {};
  assert.equal(maskPii('version 2026-10-21 and 1.2.3', { counts: none }), 'version 2026-10-21 and 1.2.3');
  assert.deepEqual(none, {});
});
