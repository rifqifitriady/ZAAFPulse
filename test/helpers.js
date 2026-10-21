// Shared test helpers: a fake HTTP server that records requests, secrets without Keychain, and a fake `claude`.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createSecrets } = require('../lib/secrets');

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// routes: { 'GET /path': { status?, body?, headers? } | (req) => same | Promise<same> }
async function fakeServer(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const r = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: body ? safeJson(body) : null,
      };
      requests.push(r);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"error":"no route"}');
      }
      const out = (await (typeof handler === 'function' ? handler(r) : handler)) || {};
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

const secretsFor = (env = {}) =>
  createSecrets({
    env,
    exec: () => {
      throw new Error('no keychain in tests');
    },
  });

// The judge models are looked for at Ollama's and LM Studio's ports once the server has indexed. A spawned server.js
// must not reach the machine's own ones, so tests point both at a closed port (9, discard) with these.
// The Claude Code judge is looked for on PATH and in the usual install folders; a spawned server.js is pointed at a
// file that does not exist, so it never finds (or starts) the machine's own claude.
const NO_CLAUDE = path.join(__dirname, 'fixtures', 'no-claude-here', 'claude');
const NO_JUDGE_PORTS = {
  ZAAFPULSE_OLLAMA_URL: 'http://127.0.0.1:9',
  ZAAFPULSE_LMSTUDIO_URL: 'http://127.0.0.1:9',
  ZAAFPULSE_CLAUDE_BIN: NO_CLAUDE,
};

// A stand-in for the Claude Code CLI. FAKE_CLAUDE_MODE picks what it does, FAKE_CLAUDE_LOG (a file outside its working
// folder) records each run: argv, the working folder and what it held, stdin, and which variables it saw.
const FAKE_CLAUDE = String.raw`
const fs = require('fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const log = (rec) =>
  process.env.FAKE_CLAUDE_LOG && fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(rec) + '\n');
// A --version that ignores SIGTERM and takes its time: only SIGKILL ends it.
const versionHang = args[0] === '--version' && mode === 'stubborn-version';
if (versionHang) {
  process.on('SIGTERM', () => {});
  log({ version: true, file: __filename, pid: process.pid });
  setTimeout(() => process.exit(0), 8000);
} else if (args[0] === '--version') {
  log({ version: true, file: __filename });
  if (mode === 'noversion') process.exit(1);
  if (mode === 'plainversion') {
    process.stdout.write('2.1.0\n');
    process.exit(0);
  }
  process.stdout.write((process.env.FAKE_CLAUDE_VERSION || '2.1.302') + ' (Claude Code)\n');
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  if (versionHang) return;
  log({
    argv: args,
    cwd: process.cwd(),
    entries: fs.readdirSync(process.cwd()),
    stdin: input,
    pid: process.pid,
    vars: Object.keys(process.env).filter((k) => k === 'CLAUDECODE' || k.startsWith('ZAAFPULSE_')),
  });
  const at = args.indexOf('--json-schema');
  const schema = at >= 0 ? JSON.parse(args[at + 1]) : {};
  const label = ((schema.properties || {}).label || {}).enum ? schema.properties.label.enum[0] : 'ok';
  const verdict = { label, explanation: 'fake verdict' };
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1500, cache_read_input_tokens: 100, output_tokens: 40 };
  const cost = process.env.FAKE_CLAUDE_COST === undefined ? 0.0005 : Number(process.env.FAKE_CLAUDE_COST);
  const base = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: cost,
    usage,
    modelUsage: { 'claude-haiku-5-5': { costUSD: cost }, 'claude-side-model': { costUSD: 0 } },
    num_turns: 2,
  };
  const out = (j) => process.stdout.write(JSON.stringify(j));
  // A helper that inherits stdout and stderr keeps the pipes open after this process is gone.
  const helper = () => {
    const h = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    h.unref(); // this process may exit; the helper stays, holding the pipes
    log({ helper: h.pid });
  };
  const answer = { ...base, result: JSON.stringify(verdict), structured_output: verdict };
  if (mode === 'ok' || mode === 'noversion' || mode === 'plainversion') out(answer);
  else if (mode === 'result') out({ ...base, result: JSON.stringify(verdict) });
  else if (mode === 'nocost') out({ ...base, total_cost_usd: undefined, structured_output: verdict });
  else if (mode === 'error') {
    out({ ...base, is_error: true, result: 'Failed for someone@example.com in /Users/someone/.claude/x.json' });
    process.exitCode = 1;
  } else if (mode === 'limit') {
    out({ ...base, is_error: true, result: 'Claude AI usage limit reached' });
    process.exitCode = 1;
  } else if (mode === 'maxturns') out({ ...base, subtype: 'error_max_turns' });
  else if (mode === 'signedout') {
    out({ ...base, is_error: true, api_error_status: 401, result: 'OAuth token has expired' });
    process.exitCode = 1;
  } else if (mode === 'orphan') {
    helper();
    setInterval(() => {}, 1000);
  } else if (mode === 'orphan-answer') {
    helper();
    out(answer);
  } else if (mode === 'echo-env') {
    const names = (process.env.FAKE_CLAUDE_ECHO || '').split(',').filter(Boolean);
    log({ echo: Object.fromEntries(names.map((n) => [n, process.env[n] ?? null])) });
    out({ ...base, structured_output: verdict });
  }
  else if (mode === 'crash') {
    process.stderr.write('boom in /Users/someone/secret/file.js\n');
    process.exit(3);
  } else if (mode === 'garbage') process.stdout.write('not json at all');
  else if (mode === 'flood') {
    const chunk = 'x'.repeat(65536);
    for (let i = 0; i < 40; i++) process.stdout.write(chunk);
  } else if (mode === 'hang') setInterval(() => {}, 1000);
  else if (mode === 'stubborn') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
});
`;
// Writes the fake into `dir`: an executable named `claude` on POSIX, `claude.js` (run through Node) on Windows,
// where a .cmd wrapper could only be started through a shell.
function fakeClaude(dir, name = process.platform === 'win32' ? 'claude.js' : 'claude') {
  const file = path.join(dir, name);
  const node = /\s/.test(process.execPath) ? '/usr/bin/env node' : process.execPath;
  const shebang = name.endsWith('.js') ? '' : `#!${node}\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, shebang + FAKE_CLAUDE, { mode: 0o755 });
  // Discovery refuses a binary that others can write, whatever the umask of the machine running the tests.
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(file, 0o755);
  return file;
}

// What a child process needs on Windows to start at all (SystemRoot), find programs (PATHEXT) and a temp folder (TEMP,
// TMP), for tests that hand a child an env of their own instead of process.env. Only the names that are set.
const WIN_ENV = ['SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'TEMP', 'TMP'];
const winEnv = () => Object.fromEntries(WIN_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

module.exports = { fakeServer, secretsFor, NO_JUDGE_PORTS, fakeClaude, winEnv };
