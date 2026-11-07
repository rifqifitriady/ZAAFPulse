// Dashboard users (AI Governance 4) on the Compliance page: the access_roles control (lib/governance/controls.js). In
// place when sign-in is required and no account has gone unused for over 90 days; partial when one has (an access
// review is due), naming the count only; off without sign-in; unknown when the accounts file cannot be read. Its
// clauses: EU AI Act Art. 26(2), NIST AI RMF GOVERN 2.1, ISO/IEC 42001 A.3.
const test = require('node:test');
const assert = require('node:assert/strict');
const { controls, CATALOGUE } = require('../lib/governance/controls');

const NOW = Date.UTC(2026, 10, 4, 12);
const DAY = 864e5;
const at = (days) => new Date(NOW - days * DAY).toISOString();
const roles = (accounts) => controls({ now: NOW, accounts }).find((c) => c.id === 'access_roles');

test('access_roles: in place, partial with the count of unused accounts, off without sign-in, unknown unread', () => {
  const c = CATALOGUE.find((x) => x.id === 'access_roles');
  assert.deepEqual([c.title, c.link, c.part], ['Dashboard roles and access reviews', '#settings/users', 'accounts']);
  assert.deepEqual(
    roles({ mode: 'password', state: 'ok', users: [] }).clauses.map((x) => `${x.framework} ${x.ref} ${x.title}`),
    [
      'eu-ai-act Art. 26(2) Human oversight assigned to competent persons',
      'nist-ai-rmf GOVERN 2.1 Roles and responsibilities documented',
      'iso-42001 A.3 Internal organization',
    ],
  );
  const pick = (r) => [r.status, r.evidence];
  assert.deepEqual(pick(roles({ mode: 'password', state: 'ok', users: [] })), ['in place', ['the owner only']]);
  const users = [
    { role: 'viewer', disabled: false, createdAt: at(200), lastLoginAt: at(3) },
    { role: 'reviewer', disabled: false, createdAt: at(10), lastLoginAt: null },
    { role: 'viewer', disabled: true, createdAt: at(400), lastLoginAt: null },
  ];
  assert.deepEqual(pick(roles({ mode: 'local', state: 'ok', users })), [
    'in place',
    ['the owner and 2 accounts (1 reviewer, 1 viewer)', '1 account disabled'],
  ]);
  // A viewer last seen 91 days ago, a reviewer created 120 days ago who never signed in: two unused.
  users[0].lastLoginAt = at(91);
  users[1].createdAt = at(120);
  const partial = roles({ mode: 'password', state: 'ok', users });
  assert.deepEqual(pick(partial), [
    'partial',
    [
      'the owner and 2 accounts (1 reviewer, 1 viewer)',
      '1 account disabled',
      '2 accounts unused for over 90 days: an access review is due',
    ],
  ]);
  // Exactly 90 days is not over 90.
  assert.equal(
    roles({ mode: 'password', state: 'ok', users: [{ role: 'viewer', lastLoginAt: at(90) }] }).status,
    'in place',
  );
  assert.deepEqual(pick(roles({ mode: 'none', state: 'ok', users })), [
    'off',
    ['sign-in: no sign-in, so no accounts or roles'],
  ]);
  assert.deepEqual(pick(roles({ mode: 'password', state: 'unreadable', users: [] })), [
    'unknown',
    ['users.json could not be read'],
  ]);
  assert.deepEqual(pick(controls({ now: NOW }).find((x) => x.id === 'access_roles')), [
    'unknown',
    ['could not be read'],
  ]);
});
