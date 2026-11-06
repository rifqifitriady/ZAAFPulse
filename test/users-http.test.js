// Dashboard users and roles (AI Governance 4) through a spawned server.js in password mode: the owner (the legacy
// { password } sign-in) adds a viewer and a reviewer; each must change the password first; the viewer reads the
// Governance pages and exports evidence but is refused a setting, trace content and a gateway action; the reviewer saves
// an inventory review and reads runs but cannot change a setting; a new role or a disabled account ends the sessions;
// every entry names the account. Ports 10200-10399 are this file's own; a temp data folder is also HOME.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS } = require('./helpers');
const { createUserStore } = require('../lib/users/store');
const { localLoginCode } = require('../lib/auth');

const ROOT = path.join(__dirname, '..');
const ADMIN = 'correct horse battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 10200 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

// Starts server.js on a free port of the range (again when another test took the port first); stopped and its data
// folder removed when the test ends. `seed(data)` writes files into the data folder before the server starts; Claude
// Code's logs are read from <data>/.claude/projects.
async function startServer(t, env = {}, seed = null) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-http-'));
    if (seed) seed(data);
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '1',
        ZAAFPULSE_ADMIN_PASSWORD: ADMIN,
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
        CLAUDE_CONFIG_DIR: path.join(data, '.claude'),
        CODEX_HOME: path.join(data, '.codex'),
        XDG_CONFIG_HOME: path.join(data, '.config'),
        APPDATA: path.join(data, 'AppData', 'Roaming'),
      },
      stdio: 'ignore',
    });
    let exited = false;
    const gone = new Promise((r) => child.on('exit', () => r((exited = true))));
    const stop = async () => {
      if (!exited) child.kill();
      await gone;
      fs.rmSync(data, { recursive: true, force: true });
    };
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await sleep(200);
        if (!exited) {
          t.after(stop);
          return { base, data, alive: () => !exited };
        }
      } catch {
        await sleep(150);
      }
    }
    await stop();
  }
  throw new Error('could not start server.js on a free port');
}
// One request: JSON in and out (text when the answer is not JSON). `as` is a signed-in browser's cookie.
async function call(s, p, { method = 'GET', body, as } = {}) {
  const r = await fetch(s.base + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(as ? { cookie: as, origin: s.base } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: json === null ? text : json, text, headers: r.headers };
}
async function signIn(s, body) {
  const r = await call(s, '/api/login', { method: 'POST', body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}
function entries(s) {
  const dir = path.join(s.data, '.data', 'audit');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^governance-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
const VERA = 'vera password 01';
const REX = 'rex password 001';

test('owner, viewer and reviewer: what each may do, the mustChange gate, and every entry names the account', async (t) => {
  const s = await startServer(t);
  const owner = await signIn(s, { password: ADMIN }); // the sign-in of before still works
  for (const body of [
    { action: 'create', name: 'vera', display: 'Vera', role: 'viewer', password: 'vera first 0001' },
    { action: 'create', name: 'rex', display: 'Rex', role: 'reviewer', password: 'rex first 00001' },
  ])
    assert.equal((await call(s, '/api/users', { method: 'POST', body, as: owner })).status, 200);
  const listed = await call(s, '/api/users', { as: owner });
  assert.deepEqual(
    listed.body.users.map((u) => [u.name, u.role, u.mustChange]),
    [
      ['rex', 'reviewer', true],
      ['vera', 'viewer', true],
    ],
  );
  const file = path.join(s.data, '.data', 'users.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // The viewer: the new password first; until then everything but the password route is refused.
  let vera = await signIn(s, { name: 'vera', password: 'vera first 0001' });
  const first = await call(s, '/api/summary', { as: vera });
  assert.deepEqual([first.status, first.body], [403, { error: 'change your password first' }]);
  const session = await call(s, '/api/session', { as: vera });
  assert.deepEqual([session.body.user, session.body.role, session.body.mustChange], ['vera', 'viewer', true]);
  const change = { method: 'POST', body: { current: 'vera first 0001', next: VERA }, as: vera };
  assert.equal((await call(s, '/api/account/password', change)).status, 200);
  assert.equal((await call(s, '/api/session', { as: vera })).body.mustChange, false);
  // Reads of metadata, the Governance pages and the evidence export.
  for (const p of [
    '/api/summary',
    '/api/config',
    '/api/governance/inventory',
    '/api/governance/controls',
    '/api/governance/audit',
    '/api/governance/audit/status',
    '/api/governance/evidence?format=md',
    '/api/cost/status',
    '/api/trace/sources',
    '/api/trace/sessions',
    '/api/evals/summary',
    '/api/datasets',
    '/api/monitors',
  ])
    assert.equal((await call(s, p, { as: vera })).status, 200, p);
  // The gateway, redacted: the built-in agents have no system prompt here.
  const gw = await call(s, '/api/gateway', { as: vera });
  assert.ok(gw.body.agents.length > 0 && gw.body.agents.every((a) => !('systemPrompt' in a)));
  const ownerGw = await call(s, '/api/gateway', { as: owner });
  assert.ok(ownerGw.body.agents.some((a) => typeof a.systemPrompt === 'string'));
  // Refused: a setting, trace content, a gateway action, the accounts, a review.
  const refused = [
    ['/api/config', { method: 'POST', body: { userName: 'Eve' } }],
    ['/api/trace/content?id=ci_00', {}],
    ['/api/evals', {}],
    ['/api/gateway/keys', { method: 'POST', body: { action: 'create', name: 'mine' } }],
    ['/api/gateway/knowledge', { method: 'POST', body: { action: 'search', id: 'kb', query: 'x' } }],
    ['/api/users', {}],
    ['/api/governance/inventory', { method: 'POST', body: { id: 'app:claude', owner: 'Vera' } }],
  ];
  for (const [p, opts] of refused) {
    const r = await call(s, p, { ...opts, as: vera });
    assert.deepEqual([r.status, r.body], [403, { error: 'your role cannot do this' }], p);
  }
  assert.equal((await call(s, '/api/config', { as: owner })).body.userName !== 'Eve', true);

  // The reviewer: a review and the runs, but no setting and no new run.
  let rex = await signIn(s, { name: 'rex', password: 'rex first 00001' });
  const rexChange = { method: 'POST', body: { current: 'rex first 00001', next: REX }, as: rex };
  assert.equal((await call(s, '/api/account/password', rexChange)).status, 200);
  const review = { id: 'app:claude', owner: 'Rex', risk: 'limited' };
  const saved = await call(s, '/api/governance/inventory', { method: 'POST', body: review, as: rex });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const runs = await call(s, '/api/gateway/collab', { method: 'POST', body: { action: 'list' }, as: rex });
  assert.deepEqual([runs.status, runs.body.runs], [200, []]);
  const resume = { action: 'resume', id: 'run_none', approve: true };
  assert.deepEqual((await call(s, '/api/gateway/collab', { method: 'POST', body: resume, as: rex })).body, {
    errors: ['no such run'],
  });
  assert.equal((await call(s, '/api/users/names', { as: rex })).status, 200);
  for (const [p, body] of [
    ['/api/config', { userName: 'Rex' }],
    ['/api/gateway/collab', { action: 'start', task: 'x' }],
    ['/api/governance/settings', { audit: { retentionMonths: 24 } }],
  ])
    assert.equal((await call(s, p, { method: 'POST', body, as: rex })).status, 403, p);

  // A new role ends the reviewer's sessions; a disabled account cannot sign in again.
  const toViewer = { action: 'update', name: 'rex', role: 'viewer' };
  assert.equal((await call(s, '/api/users', { method: 'POST', body: toViewer, as: owner })).status, 200);
  assert.equal((await call(s, '/api/summary', { as: rex })).status, 401);
  rex = await signIn(s, { name: 'rex', password: REX });
  assert.equal((await call(s, '/api/session', { as: rex })).body.role, 'viewer');
  const off = { action: 'update', name: 'vera', disabled: true };
  assert.equal((await call(s, '/api/users', { method: 'POST', body: off, as: owner })).status, 200);
  assert.equal((await call(s, '/api/summary', { as: vera })).status, 401);
  const again = await call(s, '/api/login', { method: 'POST', body: { name: 'vera', password: VERA } });
  assert.deepEqual([again.status, again.body], [401, { error: 'wrong name or password' }]);
  vera = null;

  // The entries: who acted, by account and role; the refused reads too; never a password.
  const all = entries(s);
  const of = (action) => all.filter((e) => e.action === action);
  assert.deepEqual(
    of('user.create').map((e) => [e.target.id, e.actor.user, e.actor.role]),
    [
      ['vera', 'owner', 'owner'],
      ['rex', 'owner', 'owner'],
    ],
  );
  assert.deepEqual(
    of('account.password_change').map((e) => [e.target.id, e.actor.user]),
    [
      ['vera', 'vera'],
      ['rex', 'rex'],
    ],
  );
  assert.deepEqual(
    of('user.update').map((e) => e.changes),
    [[{ path: 'role', from: 'reviewer', to: 'viewer' }], [{ path: 'disabled', from: false, to: true }]],
  );
  const veraRefused = all.filter((e) => e.actor.user === 'vera' && e.outcome === 'refused');
  assert.deepEqual(
    veraRefused.map((e) => [e.action, e.status]),
    [
      ['GET /api/summary', 403],
      ['POST /api/config', 403],
      ['GET /api/trace/content', 403],
      ['GET /api/evals', 403],
      ['POST /api/gateway/keys', 403],
      ['POST /api/gateway/knowledge', 403],
      ['GET /api/users', 403],
      ['POST /api/governance/inventory', 403],
    ],
  );
  assert.ok(veraRefused.every((e) => e.actor.role === 'viewer' && e.actor.mode === 'password'));
  assert.deepEqual(
    of('auth.login').map((e) => [e.actor.user, e.actor.role]),
    [
      ['owner', 'owner'],
      ['vera', 'viewer'],
      ['rex', 'reviewer'],
      ['rex', 'viewer'],
    ],
  );
  assert.deepEqual(of('auth.login_failed').at(-1).target, { type: 'user', id: 'vera' });
  const review0 = all.find((e) => e.action === 'POST /api/governance/inventory' && e.outcome === 'ok');
  assert.deepEqual([review0.actor.user, review0.actor.role], ['rex', 'reviewer']);
  const text = JSON.stringify(all);
  for (const secret of [VERA, REX, 'vera first 0001', 'rex first 00001', ADMIN])
    assert.ok(!text.includes(secret), secret);
  // The Compliance page counts the accounts that may sign in (no name).
  const controls = await call(s, '/api/governance/controls', { as: owner });
  const roles = controls.body.controls.find((c) => c.id === 'access_roles');
  assert.deepEqual(
    [roles.status, roles.evidence],
    ['in place', ['the owner and 1 account (0 reviewers, 1 viewer)', '1 account disabled']],
  );
  // The audit list by account.
  const byRex = await call(s, '/api/governance/audit?user=rex&limit=500', { as: owner });
  assert.equal(byRex.status, 200);
  assert.ok(byRex.body.entries.length > 0 && byRex.body.entries.every((e) => e.actor.user === 'rex'));
  assert.ok(s.alive());
});

test('a viewer: a throttled password change, settings without folders, owner-only query values', async (t) => {
  const s = await startServer(t);
  const owner = await signIn(s, { password: ADMIN });
  const made = { action: 'create', name: 'vera', role: 'viewer', password: 'vera first 0001' };
  assert.equal((await call(s, '/api/users', { method: 'POST', body: made, as: owner })).status, 200);
  // Five wrong current passwords hold this session for 15 minutes, the right one too.
  const first = await signIn(s, { name: 'vera', password: 'vera first 0001' });
  const wrong = { method: 'POST', body: { current: 'not my password', next: VERA }, as: first };
  for (let i = 0; i < 5; i++) assert.equal((await call(s, '/api/account/password', wrong)).status, 400);
  const right = { method: 'POST', body: { current: 'vera first 0001', next: VERA } };
  const held = await call(s, '/api/account/password', { ...right, as: first });
  assert.deepEqual([held.status, held.body], [429, { error: 'too many wrong passwords; try again in 15 min' }]);
  // Another session has its own count; the change ends the held one.
  const vera = await signIn(s, { name: 'vera', password: 'vera first 0001' });
  assert.equal((await call(s, '/api/account/password', { ...right, as: vera })).status, 200);
  assert.equal((await call(s, '/api/session', { as: first })).body.signedIn, false);
  // The settings: the name, the budget and the prices only (the owner's has the folders too).
  const mine = await call(s, '/api/config', { as: vera });
  assert.deepEqual(Object.keys(mine.body).sort(), ['monthlyBudgetUSD', 'pricing', 'userName']);
  assert.ok('vaultPaths' in (await call(s, '/api/config', { as: owner })).body);
  assert.deepEqual((await call(s, '/api/gateway/logs', { as: vera })).body, { entries: [] });
  // The OpenRouter account and a trace title search are the owner's; so is any path not in its plain form.
  for (const p of [
    '/api/openrouter?section=account',
    '/api/openrouter',
    '/api/trace/sessions?q=secret',
    '/API/config',
    '/api//config',
  ]) {
    const r = await call(s, p, { as: vera });
    assert.deepEqual([r.status, r.body], [403, { error: 'your role cannot do this' }], p);
  }
  assert.equal((await call(s, '/api/trace/sessions?q=', { as: vera })).status, 200);
  const refused = entries(s).filter((e) => e.actor.user === 'vera' && e.outcome === 'refused');
  assert.deepEqual(
    refused.map((e) => [e.action, e.status]),
    [
      ...Array(5).fill(['POST /api/account/password', 400]),
      ['POST /api/account/password', 429],
      ['GET /api/openrouter', 403],
      ['GET /api/openrouter', 403],
      ['GET /api/trace/sessions', 403],
      ['GET /API/config', 403],
      ['GET /api//config', 403],
    ],
  );
  assert.ok(!JSON.stringify(entries(s)).includes('vera first 0001') && !JSON.stringify(entries(s)).includes(VERA));
  assert.ok(s.alive());
});

test('without sign-in there are no accounts; the owner is everyone and the Users page is off', async (t) => {
  const s = await startServer(t, { ZAAFPULSE_AUTH: 'none', ZAAFPULSE_ADMIN_PASSWORD: '' });
  assert.deepEqual((await call(s, '/api/users')).body, { mode: 'none', state: 'off', users: [] });
  const create = { action: 'create', name: 'vera', role: 'viewer', password: VERA };
  assert.deepEqual((await call(s, '/api/users', { method: 'POST', body: create })).body, {
    error: 'accounts need sign-in: ZAAFPULSE_AUTH=none has no accounts',
  });
  const session = await call(s, '/api/session');
  assert.deepEqual([session.body.accounts, session.body.user, session.body.role], [false, 'owner', 'owner']);
  assert.ok(s.alive());
});

// A Claude Code session of a minute ago in <data>/.claude/projects: a prompt, a shell command run, then a file edit
// still waiting for its result (the office and the timeline show it as the current activity). Every value a viewer
// must never see is in SEEDED; the owner sees them where each view carries one.
const SEEDED = {
  branch: 'fix/acme-breach-cve',
  file: 'acme-merger-plan.md',
  command: 'deploy-acme.sh',
  prompt: 'the acme merger prompt',
  runtime: 'llama-acme-server',
  token: 'tok=acme1234',
};
function seedLogs(data) {
  const dir = path.join(data, '.claude', 'projects', '-work-shop');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 60e3;
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const meta = { cwd: path.join(data, 'work', 'shop'), gitBranch: SEEDED.branch, sessionId: 'sess-1' };
  const usage = { input_tokens: 10, output_tokens: 5 };
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const lines = [
    { ...meta, type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: SEEDED.prompt } },
    {
      ...meta,
      type: 'assistant',
      uuid: 'a1',
      timestamp: at(1),
      message: {
        id: 'm1',
        model: 'claude-x',
        stop_reason: 'tool_use',
        usage,
        content: [use('t1', 'Bash', { command: `/opt/bin/${SEEDED.command} --now` })],
      },
    },
    {
      ...meta,
      type: 'user',
      uuid: 'u2',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    },
    {
      ...meta,
      type: 'assistant',
      uuid: 'a2',
      timestamp: at(3),
      message: {
        id: 'm2',
        model: 'claude-x',
        stop_reason: 'tool_use',
        usage,
        content: [use('t2', 'Edit', { file_path: path.join(data, 'work', 'shop', SEEDED.file) })],
      },
    },
  ];
  fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const runtime = {
    id: 'qwen',
    command: [path.join(data, 'bin', SEEDED.runtime), '--port', '18082'],
    port: 18082,
    health: `http://127.0.0.1:18082/health?${SEEDED.token}`,
  };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ localRuntimes: [runtime] }));
  // Claude Code's own config: an MCP server set up for one project folder (the inventory names the folder).
  const folder = path.join(data, 'work', 'acme-client-folder');
  const claudeJson = { projects: { [folder]: { mcpServers: { github: { command: 'npx', args: ['github-mcp'] } } } } };
  fs.writeFileSync(path.join(data, '.claude', '.claude.json'), JSON.stringify(claudeJson));
}
const leaks = (text) =>
  Object.entries(SEEDED)
    .filter(([, v]) => text.includes(v))
    .map(([k]) => k);
const VIEWS = [
  '/api/office',
  '/api/timeline',
  '/api/summary',
  '/api/logs',
  '/api/trace/sessions',
  '/api/runtimes/config',
];

test("a viewer's live views carry no branch, file name, command, prompt or token; the owner's do", async (t) => {
  const s = await startServer(t, {}, seedLogs);
  const owner = await signIn(s, { password: ADMIN });
  const made = { action: 'create', name: 'vera', role: 'viewer', password: 'vera first 0001' };
  assert.equal((await call(s, '/api/users', { method: 'POST', body: made, as: owner })).status, 200);
  const vera = await signIn(s, { name: 'vera', password: 'vera first 0001' });
  const change = { current: 'vera first 0001', next: VERA };
  assert.equal((await call(s, '/api/account/password', { method: 'POST', body: change, as: vera })).status, 200);
  const seen = {};
  for (const p of VIEWS) {
    const [mine, hers] = [await call(s, p, { as: owner }), await call(s, p, { as: vera })];
    assert.deepEqual([mine.status, hers.status], [200, 200], p);
    assert.deepEqual(leaks(hers.text), [], `${p}: ${hers.text.slice(0, 400)}`);
    seen[p] = leaks(mine.text);
  }
  // The owner's views: the branch and the file in the office, the file and the command in the timeline and the logs,
  // the health URL's token in the runtimes (server mode shows no command line).
  assert.deepEqual(seen['/api/office'].sort(), ['branch', 'command', 'file']);
  assert.deepEqual(seen['/api/timeline'].sort(), ['command', 'file']);
  assert.deepEqual(seen['/api/logs'].sort(), ['command', 'file']);
  assert.ok(seen['/api/summary'].includes('branch'), String(seen['/api/summary']));
  assert.deepEqual(seen['/api/runtimes/config'], ['token']);
  // The integrations without the MCP command line; the inventory without the AI clients' file paths.
  const integrations = [
    await call(s, '/api/integrations', { as: owner }),
    await call(s, '/api/integrations', { as: vera }),
  ];
  assert.deepEqual(
    integrations.map((r) => [r.status, typeof r.body.mcpCommand]),
    [
      [200, 'string'],
      [200, 'undefined'],
    ],
  );
  const inventory = [await call(s, '/api/governance/inventory', { as: owner })];
  inventory.push(await call(s, '/api/governance/inventory', { as: vera }));
  const where = (r) => ['acme-client-folder', '.claude.json'].filter((x) => r.text.includes(x));
  assert.deepEqual(inventory.map(where), [['acme-client-folder', '.claude.json'], []]);
  const github = inventory.map((r) => r.body.items.find((i) => i.id === 'mcp:github'));
  assert.deepEqual([github[1].name, github[1].clients, github[1].command], ['github', ['Claude Code'], 'npx']);
  // A change's values are the owner's: the viewer's audit list and export name the setting only.
  const rename = { method: 'POST', body: { userName: 'Acme Owner Name' }, as: owner };
  assert.equal((await call(s, '/api/config', rename)).status, 200);
  const audit = (p, as) => call(s, p, { as });
  const lists = [await audit('/api/governance/audit?action=config.change', owner)];
  lists.push(await audit('/api/governance/audit?action=config.change', vera));
  assert.deepEqual(
    lists.map((r) => r.body.entries[0].changes.find((c) => c.path === 'userName')),
    [{ path: 'userName', from: null, to: 'Acme Owner Name' }, { path: 'userName' }],
  );
  const csv = await audit('/api/governance/audit/export?format=csv&user=owner', vera);
  assert.ok(csv.text.includes('config.change') && !csv.text.includes('Acme Owner Name'), csv.text);
  assert.ok((await audit('/api/governance/audit/export?format=csv', owner)).text.includes('Acme Owner Name'));
  assert.ok(s.alive());
});

test("local mode: a viewer's local model entries carry no command line or health URL; the owner's do", async (t) => {
  const s = await startServer(t, { ZAAFPULSE_AUTH: 'local', ZAAFPULSE_ADMIN_PASSWORD: '' }, (data) => {
    seedLogs(data);
    const store = createUserStore({ file: path.join(data, '.data', 'users.json') });
    store.create({ name: 'vera', role: 'viewer', password: 'vera first 0001' });
    store.changePassword('vera', VERA);
  });
  const local = await fetch(`${s.base}/auth/local?code=${localLoginCode(s.data)}`, { redirect: 'manual' });
  assert.equal(local.status, 200);
  const owner = local.headers.get('set-cookie').split(';')[0];
  const vera = await signIn(s, { name: 'vera', password: VERA });
  const seen = {};
  for (const p of VIEWS) {
    const [mine, hers] = [await call(s, p, { as: owner }), await call(s, p, { as: vera })];
    assert.deepEqual([mine.status, hers.status], [200, 200], p);
    assert.deepEqual(leaks(hers.text), [], `${p}: ${hers.text.slice(0, 400)}`);
    seen[p] = leaks(mine.text);
  }
  assert.deepEqual(seen['/api/runtimes/config'].sort(), ['runtime', 'token']);
  const entry = (await call(s, '/api/runtimes/config', { as: vera })).body.entries[0];
  assert.deepEqual([entry.id, entry.command, entry.health, entry.healthUsed], ['qwen', null, null, null]);
  assert.ok(s.alive());
});

test("a viewer's refused requests: at most 30 entries a minute, the answer is a 403 every time", async (t) => {
  const s = await startServer(t);
  const owner = await signIn(s, { password: ADMIN });
  const made = { action: 'create', name: 'vera', role: 'viewer', password: 'vera first 0001' };
  assert.equal((await call(s, '/api/users', { method: 'POST', body: made, as: owner })).status, 200);
  const vera = await signIn(s, { name: 'vera', password: 'vera first 0001' });
  const change = { current: 'vera first 0001', next: VERA };
  assert.equal((await call(s, '/api/account/password', { method: 'POST', body: change, as: vera })).status, 200);
  for (let i = 0; i < 40; i++) assert.equal((await call(s, `/api/brain/graph?i=${i}`, { as: vera })).status, 403);
  const refused = entries(s).filter((e) => e.actor.user === 'vera' && e.outcome === 'refused');
  assert.equal(refused.filter((e) => e.action === 'GET /api/brain/graph').length, 30);
  // The owner is never counted: the owner's requests are not refused.
  assert.equal((await call(s, '/api/users', { as: owner })).status, 200);
  assert.ok(s.alive());
});
