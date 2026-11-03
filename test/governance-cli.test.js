// Governance audit log (AI Governance 2): `zaafpulse set-password` leaves an auth.password_set event in
// .data/audit/pending (the CLI never writes the chain itself); the server's store records it with the cli actor and
// removes the file. Nothing of the password is in either.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createGovernanceAudit, keySource } = require('../lib/governance/audit');

test('set-password: the event waits in pending/ and becomes an entry with the cli actor', (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-cli-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'zaafpulse.js'), 'set-password', '--stdin'],
    {
      input: 'correct horse battery\n',
      env: { ...process.env, ZAAFPULSE_DATA: data, HOME: data, USERPROFILE: data },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const dir = path.join(data, '.data', 'audit');
  const files = fs.readdirSync(path.join(dir, 'pending'));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(dir, 'pending', files[0]), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['action', 'ts']);
  assert.ok(!text.includes('horse'));
  assert.deepEqual(fs.readdirSync(dir), ['pending'], 'no chain, no key from the CLI');
  const audit = createGovernanceAudit({ dir, getKey: keySource({ dir }) });
  assert.equal(audit.importPending(), 1);
  const e = audit.list({}).entries[0];
  assert.deepEqual([e.action, e.actor, typeof e.occurredAt], ['auth.password_set', { via: 'cli' }, 'string']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pending')), []);
});
