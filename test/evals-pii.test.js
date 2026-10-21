const test = require('node:test');
const assert = require('node:assert/strict');
const { maskPii } = require('../lib/evals/pii');
const R = require('../lib/evals/registry');
const { buildPrompt } = require('../lib/evals/judge');

test('pii: emails', () => {
  assert.equal(maskPii('mail jane.doe+evals@example.co.id now'), 'mail ‹email› now');
  assert.equal(maskPii('<A.B@Sub.Example.COM>'), '<‹email›>');
  assert.equal(maskPii('npm i @scope/pkg lodash@4.17.21'), 'npm i @scope/pkg lodash@4.17.21');
});

test('pii: IPv4 and IPv6 addresses, but not loopback or the any address', () => {
  assert.equal(maskPii('ssh 192.168.1.20 and 10.0.0.7:8080'), 'ssh ‹ip› and ‹ip›:8080');
  assert.equal(maskPii('on 127.0.0.1:11434 and 0.0.0.0:3000'), 'on 127.0.0.1:11434 and 0.0.0.0:3000');
  assert.equal(maskPii('v6 2001:db8:85a3:0:0:8a2e:370:7334 here'), 'v6 ‹ip› here');
  assert.equal(maskPii('fe80::1ff:fe23:4567:890a%en0'), '‹ip›%en0');
  assert.equal(maskPii('[2001:db8::1]:443 or fe80::1'), '[‹ip›]:443 or ‹ip›');
  assert.equal(maskPii('local ::1 stays'), 'local ::1 stays');
  assert.equal(maskPii('999.1.1.1 is not an address'), '999.1.1.1 is not an address');
});

test('pii: phone numbers with separators or a leading +', () => {
  assert.equal(maskPii('call +62 812-3456-7890.'), 'call ‹phone›.');
  assert.equal(maskPii('call +6281234567890 now'), 'call ‹phone› now');
  assert.equal(maskPii('office (021) 555 1234 ext'), 'office ‹phone› ext');
  assert.equal(maskPii('US 555-123-4567'), 'US ‹phone›');
  assert.equal(maskPii('call +1 (415) 555-0172 or +62-22-4230031'), 'call ‹phone› or ‹phone›');
  assert.equal(maskPii('mobile 0812-3456-7890'), 'mobile ‹phone›');
});

test('pii: the user name in home-folder paths, any case and either slash', () => {
  assert.equal(maskPii('open /Users/rifqi/Github/app/a.js'), 'open /Users/‹user›/Github/app/a.js');
  assert.equal(maskPii('cd /home/dev-01/src'), 'cd /home/‹user›/src');
  assert.equal(maskPii('file:///users/Rifqi/x'), 'file:///users/‹user›/x');
  assert.equal(maskPii('C:\\Users\\Rifqi\\proj'), 'C:\\Users\\‹user›\\proj');
  assert.equal(maskPii('"c:\\\\users\\\\rifqi\\\\proj"'), '"c:\\\\users\\\\‹user›\\\\proj"');
  assert.equal(maskPii('C:\\Users\\John Smith\\Desktop'), 'C:\\Users\\‹user›\\Desktop');
  assert.equal(maskPii('D:/USERS/ana/x'), 'D:/USERS/‹user›/x');
  assert.equal(maskPii('ls /Users/rifqi'), 'ls /Users/‹user›');
});

test('pii: no false positives on versions, ports, hashes, dates, times, ids and URL paths', () => {
  const keep = [
    'node 18.19.1 and semver 1.2.3-beta.4, v10.24.1',
    'listening on localhost:11434 and :1234',
    'commit 34e9cb3 and 9f2c1d0a7b6e5f4d3c2b1a0e9f8d7c6b5a4f3e2d',
    'sha256 1234567890abcdef1234567890abcdef',
    'at 2026-10-21T10:00:00Z and 2026-10-21 10:00:00, 21/10/2026',
    'dates 2026-10-21 and 2026.10.21',
    'ts 1792000000000 and id 4815162342 and 123456789012',
    'GET https://api.example.com/users/42/profile and /api/home/feed',
    'clock 10:00:00 and Foo::bar and std::vector and a[1::2]',
    'mac aa:bb:cc:dd:ee:ff',
  ];
  for (const s of keep) assert.equal(maskPii(s), s, s);
});

test('pii: the per-call tag and the prompt shape survive the pass', () => {
  const material = {
    prompt: 'Ask jane@example.com about 192.168.1.20',
    answer: 'Done in /Users/jane/app',
    tools: [{ name: 'Bash', target: 'ssh 10.1.2.3', status: 'ok', output: 'call 0812-3456-7890' }],
    available: ['Bash'],
  };
  for (const id of ['faithfulness', 'task_completion', 'tool_selection', 'relevance']) {
    const built = buildPrompt(R.get(id), material);
    const tag = built.user.match(/<(untrusted-[0-9a-f]{16}) /)[1];
    const masked = maskPii(built.user);
    assert.equal(masked.split(tag).length, built.user.split(tag).length, `${id}: every tag kept`);
    assert.equal(maskPii(built.system), built.system, `${id}: the system text has nothing to mask`);
    assert.doesNotMatch(masked, /jane|192\.168|10\.1\.2\.3|3456/);
  }
  assert.equal(maskPii(null), '');
  assert.equal(maskPii(undefined), '');
});

// The preview is what confirms an external provider, so it must show exactly what the provider then receives.
test('pii: the preview equals the external payload and is masked; a local judge gets the full text', async () => {
  const { createEvalApi } = require('../lib/evals/api');
  const { createModels } = require('../lib/evals/models');
  const material = {
    prompt: 'Email jane.doe@example.com the logs from 192.168.1.20',
    answer: 'Sent from /Users/jane/app to +62 812-3456-7890.',
    tools: [{ name: 'Bash', target: 'scp C:\\Users\\Jane\\a.log', status: 'ok', output: 'at fe80::1ff:fe23:4567:8' }],
    available: ['Bash'],
  };
  const sent = [];
  const gateway = {
    judge: {
      providers: () => [{ id: 'cloud', label: 'Cloud', models: ['big-1'] }],
      hasPrice: () => true,
      complete: async ({ messages }) => {
        sent.push(messages);
        return { text: '{}', usage: { input: 1, output: 1, cost: 0 } };
      },
    },
  };
  let saved = { provider: 'cloud', model: 'big-1' };
  const api = createEvalApi({
    trace: {
      sourceOf: () => ({ source: 'claude', sid: 's' }),
      material: async () => ({ material, target: { source: 'claude', session: 's', turn: 0, span: null } }),
    },
    engine: { latestFinishedTurn: async () => 0, kick: () => {} },
    feedback: {},
    gateway,
    settings: { get: () => saved, save: (s) => (saved = s) },
  });
  const r = await api.route({
    method: 'POST',
    path: '/api/evals/preview',
    query: new URLSearchParams(),
    contentType: 'application/json',
    readBody: async () => JSON.stringify({ key: 'k', provider: 'cloud' }),
  });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body.system + r.body.user, /jane|Jane|192\.168|3456|fe80/);
  assert.match(r.body.user, /‹user›.*‹phone›/s);

  const closed = 'http://127.0.0.1:9';
  const models = createModels({ settings: () => saved, gateway, ollamaUrl: closed, lmstudioUrl: closed });
  const built = buildPrompt(R.get(r.body.evaluator), material);
  await models.call(await models.resolve(), built);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], [
    { role: 'system', content: r.body.system },
    { role: 'user', content: r.body.user },
  ]);

  // A local judge keeps the full text.
  let body;
  const local = createModels({
    settings: () => ({ provider: 'ollama', model: 'qwen3:8b' }),
    gateway: { judge: { providers: () => [] } },
    fetchImpl: async (url, init) => {
      if (init && init.method === 'POST') body = JSON.parse(init.body);
      return { ok: true, json: async () => (body ? { message: { content: '{}' } } : { models: [] }) };
    },
  });
  await local.call(await local.resolve(), built);
  assert.equal(body.messages[1].content, built.user);
  assert.match(body.messages[1].content, /\/Users\/jane\/app to \+62 812-3456-7890/);
});

// Re-review on real material: number runs that are not phone numbers, versions after a letter or a slash, and
// image names with an @2x suffix.
test('pii: dot-grouped, decimal and space-separated numbers are not phone numbers', () => {
  const keep = [
    'revenue 11.927.074.289 and 851.933.719',
    'scores 769.563 697.129',
    'size 1080 1080 24 and 01 02 03 04 05',
    'mobile 0812 3456 7890 written with spaces only',
    'US 555.123.4567 with dots only',
  ];
  for (const s of keep) assert.equal(maskPii(s), s, s);
});

test('pii: a four-part version after a letter, a slash or an @ is not an address', () => {
  const keep = ['brew openjdk@21/21.0.12.1', 'LibreOffice26.2.4.2', 'path /opt/1.2.3.4/bin', 'pkg@1.2.3.4'];
  for (const s of keep) assert.equal(maskPii(s), s, s);
  // A bare four-part version still looks like an address (documented), and a URL host is still masked.
  assert.equal(maskPii('LibreOffice 26.2.4.2'), 'LibreOffice ‹ip›');
  const urls = 'http://10.0.0.5:8080/x and //192.168.1.9/share';
  assert.equal(maskPii(urls), 'http://‹ip›:8080/x and //‹ip›/share');
});

test('pii: image names with @2x are not emails, and an email is still found', () => {
  const keep = ['icon@2x.png', 'logo@3x.JPG', 'hero@2x.webp and a@1.5x.svg', 'sprite@2x.gif', 'photo@2x.jpeg'];
  for (const s of keep) assert.equal(maskPii(s), s, s);
  assert.equal(maskPii('icon@3x.retina.png'), 'icon@3x.retina.png');
  assert.equal(maskPii('mail ops@example.com.'), 'mail ‹email›.');
  assert.equal(maskPii('to a.b@mail.example.org'), 'to ‹email›');
});

test('pii: a long run without an @ is masked in linear time', () => {
  for (const run of ['a'.repeat(24000), 'a.b-'.repeat(6000), '1'.repeat(24000), '1.2-3 '.repeat(4000)]) {
    const t0 = process.hrtime.bigint();
    assert.equal(maskPii(run), run);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 20, `${run.slice(0, 8)}… took ${ms.toFixed(1)} ms`);
  }
});
