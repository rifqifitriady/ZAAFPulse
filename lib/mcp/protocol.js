// MCP over stdio: newline-delimited JSON-RPC 2.0. Only the server half this app needs:
// initialize, ping and tools. Diagnostics go to stderr; stdout carries protocol messages only.
const readline = require('readline');

// Newest first. 2025-11-25 adds nothing a tools-only server must do: icons, tasks, elicitation and sampling
// changes are optional or client-side, and input errors already come back as tool results with isError.
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function createServer({ name, title, version, instructions, listTools, callTool, log = () => {} }) {
  async function handle(msg) {
    // A response (to a request we never send) is never answered either: replying could loop two peers.
    if (
      msg &&
      typeof msg === 'object' &&
      !Array.isArray(msg) &&
      msg.jsonrpc === '2.0' &&
      msg.method === undefined &&
      'id' in msg &&
      ('result' in msg || 'error' in msg)
    )
      return null;
    if (
      !msg ||
      typeof msg !== 'object' ||
      Array.isArray(msg) ||
      msg.jsonrpc !== '2.0' ||
      typeof msg.method !== 'string'
    ) {
      return fail(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid request');
    }
    if (!('id' in msg)) return null; // notification: never answered
    const { id, method } = msg;
    const params = msg.params == null ? {} : msg.params; // null is sent by some clients for "no params"
    if (typeof params !== 'object') return fail(id, -32602, 'params must be an object');
    try {
      switch (method) {
        case 'initialize': {
          const asked = params.protocolVersion;
          return ok(id, {
            protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, ...(title ? { title } : {}), version },
            ...(instructions ? { instructions } : {}),
          });
        }
        case 'ping':
          return ok(id, {});
        case 'tools/list':
          return ok(id, { tools: await listTools() });
        case 'tools/call': {
          if (typeof params.name !== 'string') return fail(id, -32602, 'params.name is required');
          const args = params.arguments == null ? {} : params.arguments;
          if (typeof args !== 'object' || Array.isArray(args))
            return fail(id, -32602, 'params.arguments must be an object');
          const r = await callTool(params.name, args);
          return r.error ? fail(id, r.error.code, r.error.message) : ok(id, r.result);
        }
        default:
          return fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      log(`error in ${method}: ${err.stack || err.message}`);
      return fail(id, -32603, 'Internal error');
    }
  }

  async function handleLine(line) {
    const text = line.trim();
    if (!text) return null;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return JSON.stringify(fail(null, -32700, 'Parse error'));
    }
    const reply = await handle(msg);
    return reply ? JSON.stringify(reply) : null;
  }

  // Resolves once input ends and every pending reply has been written.
  function serve(input = process.stdin, output = process.stdout) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const pending = new Set();
    rl.on('line', (line) => {
      const p = handleLine(line).then((out) => {
        if (out) output.write(out + '\n');
      });
      pending.add(p);
      p.finally(() => pending.delete(p));
    });
    return new Promise((resolve) => rl.on('close', () => Promise.allSettled([...pending]).then(() => resolve())));
  }

  return { handle, handleLine, serve };
}

module.exports = { createServer, SUPPORTED_VERSIONS };
