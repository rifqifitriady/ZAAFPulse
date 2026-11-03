// Governance inventory (AI Governance 3): the MCP scan (lib/governance/mcp-scan.js) over a fixture file for every
// client lib/mcp-clients.js knows, read through an injected reader, so no real config is ever touched. Env values,
// headers, other arguments, tokens and URL paths never come out; a file that cannot be read is "unreadable" and the
// others are still listed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanClients, parseJsonc, commandOf, packageOf, originOf } = require('../lib/governance/mcp-scan');
const { clients } = require('../lib/mcp-clients');
const register = require('../scripts/register-mcp');

const HOME = '/home/ana';
const FILES = clients(HOME, { env: {}, platform: 'linux' });
const SECRETS = [
  'SECRET-ENV-VALUE-1',
  'SECRET-HEADER-2',
  'SECRET-ARG-3',
  'SECRET-PASS-4',
  'SECRET-QUERY-5',
  'ghp_SECRETTOKEN6abcdefghijklmnop',
  'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  '/sse',
];
const secretEntry = {
  command: 'npx',
  args: ['-y', '@acme/mcp-server@1.2.0', '--token', 'SECRET-ARG-3'],
  env: { ACME_TOKEN: 'SECRET-ENV-VALUE-1' },
};
const remote = {
  url: 'https://user:SECRET-PASS-4@mcp.example.com/sse?key=SECRET-QUERY-5',
  headers: { Authorization: 'Bearer SECRET-HEADER-2' },
};
const ours = { command: '/usr/bin/node', args: ['/opt/zaafpulse/mcp.js'], env: { ZAAFPULSE_DATA: '/srv/zp' } };
const fixture = () => ({
  [FILES.claude.file]: JSON.stringify({
    mcpServers: { acme: secretEntry, zaafpulse: ours },
    projects: {
      '/home/ana/code/shop': { mcpServers: { db: { command: 'uvx', args: ['mcp-server-postgres', 'postgres://x'] } } },
      '/srv/other': { mcpServers: {} },
    },
  }),
  [FILES.kiro.file]: JSON.stringify({
    mcpServers: {
      tokens: { command: 'mytool', args: ['ghp_SECRETTOKEN6abcdefghijklmnop', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'] },
    },
  }),
  [FILES.cursor.file]: JSON.stringify({ mcpServers: { remote } }),
  [FILES.vscode.file]: `{
    // VS Code keeps its servers under "servers"
    "servers": {
      "github": {
        "type": "http",
        "url": "https://api.githubcopilot.com/mcp/",
        "headers": { "Authorization": "Bearer SECRET-HEADER-2" }
      },
      "files": {
        "type": "stdio",
        "command": "C:\\\\Program Files\\\\nodejs\\\\npx.cmd",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/ana"],
      },
    },
    /* a trailing comma and a "// not a comment" in a string */ "note": "a // b ,}",
  }`,
  [FILES['claude-desktop'].file]:
    '\ufeff{"mcpServers":{"acme":{"command":"npx","args":["-y","@acme/mcp-server@1.2.0"]}}}',
  [FILES.codex.file]: [
    'model = "gpt-5"',
    '',
    '[mcp_servers.docs]',
    'command = "npx"',
    'args = ["-y", "@docs/mcp", "--key", "SECRET-ARG-3"]',
    '',
    '[mcp_servers.docs.env]',
    'DOCS_KEY = "SECRET-ENV-VALUE-1"',
    '',
    '[mcp_servers.linear]',
    'url = "https://mcp.linear.app/sse?token=SECRET-QUERY-5"',
    '',
  ].join('\n'),
  [FILES.gemini.file]: '{ "mcpServers": { "ctx": { "httpUrl": "http://127.0.0.1:8811/mcp" } }, }',
  [FILES.windsurf.file]: JSON.stringify({ mcpServers: { surf: { serverUrl: 'https://surf.example.com/mcp' } } }),
  [FILES.zed.file]:
    '{ "context_servers": { "old-style": { "command": ' +
    '{ "path": "/usr/local/bin/uvx", "args": ["mcp-server-time"] } } } }',
  [FILES.antigravity.file]: '{ "mcpServers": ', // torn: unreadable
});
const reader = (files) => (f) => (Object.hasOwn(files, f) ? files[f] : null);

test('JSONC: comments and trailing commas go, strings are left alone, a BOM and an empty file are fine', () => {
  assert.deepEqual(parseJsonc('{ // one\n "a": [1, 2,], /* two */ "b": "x // y ,}" , }'), {
    a: [1, 2],
    b: 'x // y ,}',
  });
  assert.deepEqual(parseJsonc('\ufeff{"a":"\\"/*"}'), { a: '"/*' });
  assert.deepEqual(parseJsonc(''), {});
  assert.deepEqual(parseJsonc('null'), {});
  assert.throws(() => parseJsonc('{ /* open'), /comment is not closed/);
  assert.throws(() => parseJsonc('{ "a": }'), SyntaxError);
});

test('the parts kept of a server: the base name, the first package, the origin', () => {
  assert.equal(commandOf('npx -y @x/y'), 'npx');
  assert.equal(commandOf('C:\\Program Files\\nodejs\\node.exe'), 'node.exe');
  assert.equal(commandOf('/opt/my tool/run --token abc'), null);
  assert.equal(commandOf(''), null);
  assert.equal(packageOf(['-y', '@scope/pkg', 'other']), '@scope/pkg');
  assert.equal(packageOf(['/abs/path/server.js', 'mcp-server-fetch']), 'mcp-server-fetch');
  assert.equal(packageOf(['ghp_SECRETTOKEN6abcdefghijklmnop', 'sk-abc', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6']), null);
  assert.equal(originOf('https://u:p@h.example.com:8443/x?y=1'), 'https://h.example.com:8443');
  assert.equal(originOf('file:///etc/passwd'), null);
  assert.equal(originOf('not a url'), null);
});

test('scan: every client file is read, with names, transports, base names, packages and origins only', () => {
  const out = scanClients({ home: HOME, env: {}, platform: 'linux', read: reader(fixture()) });
  const by = Object.fromEntries(out.map((c) => [c.client, c]));
  assert.deepEqual(Object.keys(by).sort(), [
    'antigravity',
    'claude',
    'claude-desktop',
    'codex',
    'cursor',
    'gemini',
    'kiro',
    'vscode',
    'windsurf',
    'zed',
  ]);
  assert.deepEqual(by.claude, {
    client: 'claude',
    name: 'Claude Code',
    file: '~/.claude.json',
    state: 'ok',
    servers: [
      {
        name: 'acme',
        transport: 'stdio',
        command: 'npx',
        package: '@acme/mcp-server@1.2.0',
        origin: null,
        ours: false,
      },
      { name: 'zaafpulse', transport: 'stdio', command: 'node', package: null, origin: null, ours: true },
      {
        name: 'db',
        transport: 'stdio',
        command: 'uvx',
        package: 'mcp-server-postgres',
        origin: null,
        ours: false,
        project: '~/code/shop',
      },
    ],
  });
  assert.deepEqual(by.kiro.servers, [
    { name: 'tokens', transport: 'stdio', command: 'mytool', package: null, origin: null, ours: false },
  ]);
  assert.deepEqual(by.cursor.servers, [
    { name: 'remote', transport: 'http', command: null, package: null, origin: 'https://mcp.example.com', ours: false },
  ]);
  assert.deepEqual(
    by.vscode.servers.map((s) => [s.name, s.transport, s.command, s.package, s.origin]),
    [
      ['github', 'http', null, null, 'https://api.githubcopilot.com'],
      ['files', 'stdio', 'npx.cmd', '@modelcontextprotocol/server-filesystem', null],
    ],
  );
  assert.equal(by.vscode.file, '~/.config/Code/User/mcp.json');
  assert.deepEqual(
    by.codex.servers.map((s) => [s.name, s.transport, s.command, s.package, s.origin]),
    [
      ['docs', 'stdio', 'npx', '@docs/mcp', null],
      ['linear', 'http', null, null, 'https://mcp.linear.app'],
    ],
  );
  assert.equal(by['claude-desktop'].servers[0].package, '@acme/mcp-server@1.2.0');
  assert.equal(by.gemini.servers[0].origin, 'http://127.0.0.1:8811');
  assert.equal(by.windsurf.servers[0].origin, 'https://surf.example.com');
  assert.deepEqual(by.zed.servers[0], {
    name: 'old-style',
    transport: 'stdio',
    command: 'uvx',
    package: 'mcp-server-time',
    origin: null,
    ours: false,
  });
  assert.deepEqual(by.antigravity, {
    client: 'antigravity',
    name: 'Antigravity',
    file: '~/.gemini/config/mcp_config.json',
    state: 'unreadable',
    servers: [],
  });
  const text = JSON.stringify(out);
  for (const s of SECRETS) assert.ok(!text.includes(s), `${s} must not come out`);
  assert.ok(!text.includes('/home/ana'), 'folders only as ~ paths');
});

test('scan: an unreadable file, or dotted mcp_servers keys in Codex, is unreadable; a missing file is left out', () => {
  const files = {
    [FILES.cursor.file]: JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'a-mcp'] } } }),
    [FILES.codex.file]: 'mcp_servers.x.command = "npx"\n',
    [FILES.kiro.file]: JSON.stringify({ mcpServers: ['not', 'an', 'object'] }),
    [FILES.zed.file]: '[1, 2]',
  };
  const read = (f) => {
    if (f === FILES.claude.file) throw Object.assign(new Error(`EACCES: ${f}`), { code: 'EACCES' });
    return reader(files)(f);
  };
  const out = scanClients({ home: HOME, env: {}, platform: 'linux', read });
  assert.deepEqual(
    out.map((c) => [c.client, c.state, c.servers.length]),
    [
      ['claude', 'unreadable', 0],
      ['kiro', 'unreadable', 0],
      ['cursor', 'ok', 1],
      ['codex', 'unreadable', 0],
      ['zed', 'unreadable', 0],
    ],
  );
  assert.ok(!JSON.stringify(out).includes('EACCES'), 'no error text, which can hold a path');
});

test('scan: Windows home folders are ~ in either slash and any case; the table is the one register-mcp uses', () => {
  const home = 'C:\\Users\\Ana';
  const win = clients(home, { env: { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' }, platform: 'win32' });
  const files = {
    [win.claude.file]: JSON.stringify({
      projects: { 'c:/users/ana/Code/app': { mcpServers: { x: { command: 'npx', args: ['x-mcp'] } } } },
    }),
  };
  const out = scanClients({
    home,
    env: { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' },
    platform: 'win32',
    read: reader(files),
  });
  assert.equal(out[0].file, '~\\.claude.json');
  assert.equal(out[0].servers[0].project, '~/Code/app');
  assert.deepEqual(Object.keys(register.clients(HOME, { env: {} })), Object.keys(FILES));
  assert.equal(register.isOurs, require('../lib/mcp-clients').isOurs);
});
