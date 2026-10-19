// Shared test helpers: a fake HTTP server that records requests, and secrets without Keychain.
const http = require('http');
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

module.exports = { fakeServer, secretsFor };
