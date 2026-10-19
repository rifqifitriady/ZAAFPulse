const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecrets, isRef } = require('../lib/secrets');

test('resolves env references', () => {
  const s = createSecrets({ env: { DT: 'dt0c01.abcdef' } });
  assert.equal(s.resolve({ env: 'DT' }, 'token'), 'dt0c01.abcdef');
});

test('resolves keychain references through the security tool', () => {
  const calls = [];
  const s = createSecrets({
    env: {},
    exec: (cmd, args) => {
      calls.push([cmd, ...args]);
      return 'kc-secret-value\n';
    },
  });
  assert.equal(s.resolve({ keychain: 'acc.x' }), 'kc-secret-value');
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-s', 'acc.x', '-w']);
});

test('rejects plain-text secrets', () => {
  assert.throws(
    () => createSecrets({ env: {} }).resolve('abc', 'apiKey'),
    /apiKey: plain-text secrets are not allowed/,
  );
});

test('reports missing env variables and keychain items', () => {
  const s = createSecrets({
    env: {},
    exec: () => {
      throw new Error('exit 44');
    },
  });
  assert.throws(() => s.resolve({ env: 'NOPE' }), /NOPE is not set/);
  assert.throws(() => s.resolve({ keychain: 'acc.none' }), /"acc.none" not found/);
});

test('an absent reference means not configured', () => {
  assert.equal(createSecrets({ env: {} }).resolve(undefined), null);
});

test('masks every resolved value', () => {
  const s = createSecrets({ env: { K: 'super-secret-123' } });
  s.resolve({ env: 'K' });
  assert.equal(s.mask('401: bad key super-secret-123 here'), '401: bad key *** here');
});

test('isRef recognises references only', () => {
  assert.equal(isRef({ env: 'A' }), true);
  assert.equal(isRef({ keychain: 'a' }), true);
  assert.equal(isRef('a'), false);
  assert.equal(isRef({ value: 'a' }), false);
});
