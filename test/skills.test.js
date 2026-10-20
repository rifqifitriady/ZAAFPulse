const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const { createSkills, frontmatter } = require('../lib/gateway/skills');

const DIR = path.join(__dirname, '..', 'skills');

test('skills: every SKILL.md has matching frontmatter and only documents endpoints the gateway serves', async () => {
  const names = fs.readdirSync(DIR).filter((n) => fs.existsSync(path.join(DIR, n, 'SKILL.md')));
  assert.equal(names.length, 9);
  assert.ok(names.includes('zaafpulse'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-skills-'));
  const gateway = createGateway({
    dataDir,
    toolsHome: dataDir,
    getConfig: () => ({ gateway: { providers: [], defaults: {} } }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({ result: { content: [] } }) }),
  });
  gateway.setBrain({
    sources: () => [],
    graph: async () => ({ notes: [], edges: [], unresolved: [], source: { id: 'obsidian' } }),
  });
  const server = http.createServer(async (req, res) => {
    if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end('not a gateway route');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const n of names) {
      const text = fs.readFileSync(path.join(DIR, n, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      assert.equal(fm.name, n);
      assert.ok(fm.description.length > 80 && fm.description.length < 1024, n);
      // claude.ai rejects skill uploads whose frontmatter holds XML-like tags.
      assert.ok(!/[<>]/.test(fm.description), `${n}: no < or > in the description`);
      assert.match(n, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'Agent Skills name rules');
      assert.match(text, /ZAAFPULSE_URL/);
      assert.ok(!/zp_[A-Za-z0-9_-]{20,}/.test(text), `${n} contains what looks like a real key`);
      // Each documented path is answered by the gateway itself (any status but its "no route" 404 counts).
      for (const m of text.matchAll(/\$ZAAFPULSE_URL(\/[a-zA-Z0-9/._:<>-]+)/g)) {
        if (m[1].includes('...')) continue; // prose placeholder such as $ZAAFPULSE_URL/v1/...
        const p = m[1]
          .replace(/<run_id>/g, 'run_00')
          .replace(/<[^>]+>/g, 'x')
          .replace(/:generateContent.*/, ':generateContent');
        const noRoute = async (method) => {
          const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' } });
          const body = await r.text();
          return r.status === 404 && /no gateway route|not a gateway route/.test(body)
            ? `${method} ${r.status} ${body.slice(0, 60)}`
            : null;
        };
        const g = await noRoute('GET');
        const po = g ? await noRoute('POST') : null;
        assert.ok(!(g && po), `${n}: ${p} is not a gateway route (${g} / ${po})`);
      }
    }
    const idx = await (await fetch(`${base}/skills`)).text();
    assert.match(idx, /zaafpulse-collaborate: http:\/\/127\.0\.0\.1:\d+\/skills\/zaafpulse-collaborate\/SKILL\.md/);
    const one = await fetch(`${base}/skills/zaafpulse/SKILL.md`);
    assert.equal(one.status, 200);
    assert.match(one.headers.get('content-type'), /markdown/);
    assert.match(await one.text(), /^---\nname: zaafpulse\n/);
    assert.equal((await fetch(`${base}/skills/nope/SKILL.md`)).status, 404);
    assert.equal((await fetch(`${base}/skills/..%2Fpackage.json`)).status, 404);
    // The brain API needs the rag scope and returns structure, not text.
    const k = (scopes) => gateway.keys.create({ name: 'k', scopes }).secret;
    assert.equal(
      (await fetch(`${base}/v1/brain/sources`, { headers: { authorization: `Bearer ${k(['llm'])}` } })).status,
      403,
    );
    const ok = await fetch(`${base}/v1/brain/sources`, { headers: { authorization: `Bearer ${k(['rag'])}` } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});

test('skills: install into Claude Code marks our folders, never overwrites a user skill, and removes only ours', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-skills-home-'));
  fs.mkdirSync(path.join(home, '.claude/skills/zaafpulse-rag'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/skills/zaafpulse-rag/SKILL.md'), 'my own');
  const s = createSkills({ home, version: '9.9.9' });
  const r = s.install();
  assert.equal(r.installed.length, 8);
  assert.deepEqual(r.skipped, ['zaafpulse-rag']);
  assert.equal(fs.readFileSync(path.join(home, '.claude/skills/zaafpulse-rag/SKILL.md'), 'utf8'), 'my own');
  assert.equal(s.list().find((x) => x.name === 'zaafpulse').claude, 'installed');
  assert.equal(s.list().find((x) => x.name === 'zaafpulse-rag').claude, 'yours');
  fs.writeFileSync(path.join(home, '.claude/skills/zaafpulse-chat/SKILL.md'), 'older text');
  assert.equal(s.list().find((x) => x.name === 'zaafpulse-chat').claude, 'outdated');
  assert.equal(s.uninstall().removed.length, 8);
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/zaafpulse-rag/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills/zaafpulse')));
});

test('skills: frontmatter is read from CRLF files too', () => {
  assert.deepEqual(frontmatter('---\r\nname: a\r\ndescription: b c\r\n---\r\nbody'), { name: 'a', description: 'b c' });
  assert.deepEqual(frontmatter('\ufeff---\nname: a\n---\n'), { name: 'a' });
});

test('skills: CLAUDE_CONFIG_DIR and ~/.agents/skills; whole folders are copied, and an update replaces them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-skills-home-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-skills-src-'));
  fs.mkdirSync(path.join(src, 'zaafpulse', 'references'), { recursive: true });
  fs.writeFileSync(path.join(src, 'zaafpulse', 'SKILL.md'), '---\nname: zaafpulse\ndescription: d\n---\n');
  fs.writeFileSync(path.join(src, 'zaafpulse', 'references', 'api.md'), 'ref');
  const work = path.join(home, 'claude-work');
  const s = createSkills({ dir: src, home, env: { CLAUDE_CONFIG_DIR: work } });
  assert.deepEqual(s.roots(), { claude: '~/claude-work/skills', agents: '~/.agents/skills' });
  assert.deepEqual(s.install(), { installed: ['zaafpulse'], skipped: [], path: '~/claude-work/skills' });
  assert.equal(fs.readFileSync(path.join(work, 'skills', 'zaafpulse', 'references', 'api.md'), 'utf8'), 'ref');
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'the default folder is not used');
  assert.equal(s.list()[0].claude, 'installed');
  assert.equal(s.list()[0].agents, 'not installed');
  const r = s.install('agents');
  assert.equal(r.path, '~/.agents/skills');
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'zaafpulse', 'references', 'api.md')));
  // A changed reference file makes it outdated; installing again replaces the folder and drops stale files.
  fs.writeFileSync(path.join(src, 'zaafpulse', 'references', 'api.md'), 'ref v2');
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'zaafpulse', 'old.md'), 'stale');
  assert.equal(s.list()[0].agents, 'outdated');
  assert.equal(s.install('all').installed.length, 2);
  assert.equal(s.list()[0].agents, 'installed');
  assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'zaafpulse', 'old.md')));
  assert.throws(() => s.install('nowhere'), /unknown skills location/);
  assert.equal(s.uninstall().removed.length, 2);
  assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'zaafpulse')));
  // Without "env", a given home never reads this machine's CLAUDE_CONFIG_DIR.
  assert.equal(createSkills({ dir: src, home }).roots().claude, '~/.claude/skills');
});

test('skills: the dashboard install and remove pass the chosen location through', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-skills-target-'));
  const gateway = createGateway({
    dataDir: home,
    toolsHome: home,
    getConfig: () => ({ gateway: { providers: [], defaults: {} } }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({ result: { content: [] } }) }),
  });
  const has = (where) => fs.existsSync(path.join(home, where, 'skills', 'zaafpulse', 'SKILL.md'));
  await gateway.admin('skills', 'POST', { action: 'install', target: 'agents' });
  assert.deepEqual([has('.claude'), has('.agents')], [false, true]);
  await gateway.admin('skills', 'POST', { action: 'install' }); // no target: Claude Code, as before
  assert.deepEqual([has('.claude'), has('.agents')], [true, true]);
  await gateway.admin('skills', 'POST', { action: 'uninstall', target: 'claude' });
  assert.deepEqual([has('.claude'), has('.agents')], [false, true]);
  assert.match((await gateway.admin('skills', 'POST', { action: 'install', target: 'nowhere' })).errors[0], /target/);
  await gateway.admin('skills', 'POST', { action: 'uninstall' }); // no target: removes both
  assert.deepEqual([has('.claude'), has('.agents')], [false, false]);
  assert.deepEqual((await gateway.admin('', 'GET')).skillRoots, {
    claude: '~/.claude/skills',
    agents: '~/.agents/skills',
  });
});
