const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readToolRoutes, routeOf, originOf } = require('../lib/toolroutes');

// A fake home with ~/.claude/settings.json and ~/.codex/config.toml as given (null leaves the file out).
function fakeHome({ settings = null, toml = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-toolroutes-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  if (settings !== null)
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings),
    );
  if (toml !== null) fs.writeFileSync(path.join(home, '.codex', 'config.toml'), toml);
  return home;
}

const CODEX_TOML = `model_provider = "zaafpulse"
model = "router/coding"

[profiles.fast]
model_provider = "other"

[model_providers.other]
base_url = "https://elsewhere.example.com/v1"

[model_providers.zaafpulse]
name = "ZAAFPulse"
base_url = "http://localhost:3030/v1" # the dashboard
wire_api = "responses"
experimental_bearer_token = "zp-secret"
`;

test('readToolRoutes reads the base URL origins of Claude Code and Codex from a fake home', () => {
  const home = fakeHome({
    settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3030/anthropic?x=1', ANTHROPIC_AUTH_TOKEN: 'zp-k' } },
    toml: CODEX_TOML,
  });
  assert.deepEqual(readToolRoutes({ home, env: {} }), {
    claude: 'http://127.0.0.1:3030',
    codex: 'http://localhost:3030',
  });
});

test('readToolRoutes honours CLAUDE_CONFIG_DIR and CODEX_HOME, and explicit dirs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-toolroutes-'));
  const cdir = path.join(home, 'cc');
  const xdir = path.join(home, 'cx');
  fs.mkdirSync(cdir);
  fs.mkdirSync(xdir);
  fs.writeFileSync(
    path.join(cdir, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://a.b:8443' } }),
  );
  fs.writeFileSync(
    path.join(xdir, 'config.toml'),
    'model_provider = "x"\n[model_providers.x]\nbase_url = "http://r:9/v1"\n',
  );
  assert.deepEqual(readToolRoutes({ home, env: { CLAUDE_CONFIG_DIR: cdir, CODEX_HOME: xdir } }), {
    claude: 'https://a.b:8443',
    codex: 'http://r:9',
  });
  assert.deepEqual(readToolRoutes({ home: '/nonexistent', env: {}, claudeDir: cdir, codexHome: xdir }), {
    claude: 'https://a.b:8443',
    codex: 'http://r:9',
  });
});

test('readToolRoutes gives null for a missing file, bad JSON, no base URL, and TOML without base_url', () => {
  assert.deepEqual(readToolRoutes({ home: fakeHome(), env: {} }), { claude: null, codex: null });
  assert.deepEqual(readToolRoutes({ home: fakeHome({ settings: '{ not json', toml: 'model_provider = ' }), env: {} }), {
    claude: null,
    codex: null,
  });
  assert.deepEqual(
    readToolRoutes({
      home: fakeHome({
        settings: { env: { OTHER: 1 } },
        toml: 'model_provider = "x"\n[model_providers.x]\nname = "X"\n[model_providers.y]\nbase_url = "http://y:1"\n',
      }),
      env: {},
    }),
    { claude: null, codex: null },
  );
  // No model_provider at the top level: Codex uses its built-in OpenAI provider.
  assert.deepEqual(
    readToolRoutes({ home: fakeHome({ toml: '[model_providers.x]\nbase_url = "http://x:1"\n' }), env: {} }).codex,
    null,
  );
  // A model_provider inside a table is not the top-level one.
  assert.deepEqual(
    readToolRoutes({
      home: fakeHome({ toml: '[profiles.p]\nmodel_provider = "x"\n[model_providers.x]\nbase_url = "http://x:1"\n' }),
      env: {},
    }).codex,
    null,
  );
  // Settings that are JSON but not an object, and a base URL that is not a URL.
  assert.equal(readToolRoutes({ home: fakeHome({ settings: '[1]' }), env: {} }).claude, null);
  assert.equal(
    readToolRoutes({ home: fakeHome({ settings: { env: { ANTHROPIC_BASE_URL: 'nope' } } }), env: {} }).claude,
    null,
  );
});

test('a URL holding credentials gives its origin only', () => {
  const home = fakeHome({
    settings: { env: { ANTHROPIC_BASE_URL: 'https://user:pass@proxy.example.com:8443/v1/secret?token=abc#x' } },
    toml: 'model_provider = "x"\n[model_providers."x"]\nbase_url = \'http://me:pw@127.0.0.1:20128/v1?key=k\'\n',
  });
  const r = readToolRoutes({ home, env: {} });
  assert.deepEqual(r, { claude: 'https://proxy.example.com:8443', codex: 'http://127.0.0.1:20128' });
  assert.doesNotMatch(JSON.stringify(r), /user|pass|secret|token|pw|key/);
});

test('originOf keeps protocol, host and port only, and refuses what is not http(s)', () => {
  assert.equal(originOf('http://localhost:3030/v1'), 'http://localhost:3030');
  assert.equal(originOf('https://api.anthropic.com'), 'https://api.anthropic.com');
  assert.equal(originOf('file:///etc/passwd'), null);
  assert.equal(originOf(''), null);
  assert.equal(originOf(42), null);
});

test('routeOf: the gateway, a router, or direct; localhost equals 127.0.0.1', () => {
  const ctx = {
    baseUrl: 'http://localhost:3030',
    routers: [
      { id: 'omniroute', baseUrl: 'http://localhost:20128' },
      { id: 'nine', baseUrl: 'http://127.0.0.1:20129/v1' },
    ],
  };
  assert.equal(routeOf('http://127.0.0.1:3030', ctx), 'gateway');
  assert.equal(routeOf('http://localhost:3030', ctx), 'gateway');
  assert.equal(routeOf('http://127.0.0.1:20128', ctx), 'omniroute');
  assert.equal(routeOf('http://localhost:20129', ctx), 'nine');
  assert.equal(routeOf('http://127.0.0.1:3031', ctx), null);
  assert.equal(routeOf('https://127.0.0.1:3030', ctx), null);
  assert.equal(routeOf('https://api.anthropic.com', ctx), null);
  assert.equal(routeOf(null, ctx), null);
  assert.equal(routeOf('http://localhost:80', { baseUrl: 'http://127.0.0.1', routers: [] }), 'gateway');
  assert.equal(routeOf('http://localhost:3030', {}), null);
  assert.equal(routeOf('http://localhost:3030', { baseUrl: 'bad', routers: [{ id: 'x' }, null] }), null);
});
