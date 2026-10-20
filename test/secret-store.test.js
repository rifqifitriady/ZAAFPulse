// The command line ZAAFPulse feeds to `security -i` (macOS Keychain), checked without touching the real
// Keychain: security -i reads 4095-byte chunks and runs what follows a boundary as a new command (review
// finding F2), so the line has a hard byte cap; quoting and the keyring path are checked as well.
const test = require('node:test');
const assert = require('node:assert/strict');
const { keychainAddLine, keychainBackend, libsecretBackend, KEYCHAIN_LINE_MAX } = require('../lib/secret-store');

// How security -i reads one double-quoted argument: \x stands for x.
const unquote = (q) => q.slice(1, -1).replace(/\\(.)/g, '$1');

test('keychain: quotes and backslashes in a secret stay inside its one argument', () => {
  const value = 'a"b\\c" -w "x\\';
  const line = keychainAddLine('acc.n8n', value);
  assert.equal(line, 'add-generic-password -U -a ai-command-center -s "acc.n8n" -w "a\\"b\\\\c\\" -w \\"x\\\\"\n');
  const arg = line.slice(line.indexOf('-w ') + 3, -1);
  assert.equal(unquote(arg), value);
  assert.equal(line.split('\n').length, 2, 'exactly one command');
});

test('keychain: a secret that would push the line past the cap is refused, counted in UTF-8 bytes', () => {
  assert.ok(KEYCHAIN_LINE_MAX < 4095 - 512, 'well below the 4095-byte chunk of security -i');
  // The probe that showed the bug: the bytes past 4095 ran as a second command.
  const smuggled = 'A'.repeat(4095) + 'show-keychain-info /nonexistent/INJECTED';
  assert.throws(() => keychainAddLine('acc.x', smuggled), /too long/);
  // 1600 characters but 3200 bytes: a character count would let this through.
  assert.throws(() => keychainAddLine('acc.x', 'é'.repeat(1600)), /too long/);
  // Quoting counts too: 1600 quotes become 3200 bytes.
  assert.throws(() => keychainAddLine('acc.x', '"'.repeat(1600)), /too long/);
  // The largest real secret, a Google service account JSON (one line), still fits.
  const sa = JSON.stringify({
    type: 'service_account',
    project_id: 'my-project',
    private_key_id: 'f'.repeat(40),
    private_key: `-----BEGIN PRIVATE KEY-----\n${'M'.repeat(1624)}\n-----END PRIVATE KEY-----\n`,
    client_email: 'zaafpulse@my-project.iam.gserviceaccount.com',
    client_id: '1'.repeat(21),
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/zaafpulse%40my-project.iam.gserviceaccount.com',
  });
  assert.ok(Buffer.byteLength(keychainAddLine('acc.gw-vertex', sa)) <= KEYCHAIN_LINE_MAX);
});

test('keychain: control characters and odd item names are refused before security runs', () => {
  for (const v of ['a\nadd-generic-password -s evil', 'a\rb', 'a\0b', 'a\x7fb'])
    assert.throws(() => keychainAddLine('acc.x', v), /line breaks or control/, JSON.stringify(v));
  for (const s of ['', '-x', 'acc x', 'acc"x', 'acc.x\n'])
    assert.throws(() => keychainAddLine(s, 'v'), /not a valid secret name/, JSON.stringify(s));
});

test('keychain: set feeds the line on stdin, never as an argument, and never spawns for a refused secret', () => {
  const calls = [];
  const kc = keychainBackend({
    exec: () => '',
    spawn: (cmd, args, opts) => (calls.push({ cmd, args, input: opts.input }), { status: 0, stderr: '' }),
  });
  kc.set('acc.n8n', 'sk-123456');
  assert.deepEqual(calls, [
    {
      cmd: 'security',
      args: ['-i'],
      input: 'add-generic-password -U -a ai-command-center -s "acc.n8n" -w "sk-123456"\n',
    },
  ]);
  assert.throws(() => kc.set('acc.n8n', 'x'.repeat(5000)), /too long/);
  assert.equal(calls.length, 1);
});

test('libsecret: the secret goes over stdin and the name is one checked argument', () => {
  const calls = [];
  const ls = libsecretBackend({
    spawn: (cmd, args, opts) => (calls.push({ cmd, args, input: opts.input }), { status: 0, stdout: '', stderr: '' }),
  });
  ls.set('acc.brain-nt', 'tok"en\nwith; $(stuff)');
  assert.equal(calls[0].cmd, 'secret-tool');
  assert.deepEqual(calls[0].args, [
    'store',
    '--label=ZAAFPulse acc.brain-nt',
    'service',
    'zaafpulse',
    'key',
    'acc.brain-nt',
  ]);
  assert.equal(calls[0].input, 'tok"en\nwith; $(stuff)');
  assert.throws(() => ls.set('--all', 'v'), /not a valid secret name/);
  assert.throws(() => ls.get('-h'), /not a valid secret name/);
  assert.equal(calls.length, 1);
});
