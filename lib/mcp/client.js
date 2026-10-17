// Minimal MCP client over Streamable HTTP: initialize, list tools, call tools. Replies may come
// back as JSON or as a server-sent event stream; the stream is read only until our reply arrives.
const PROTOCOL = '2025-06-18';

async function readSse(res, id) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let msg;
      try { msg = JSON.parse(data); } catch { continue; }
      if (msg && msg.id === id) return msg; // leaving the loop cancels the rest of the stream
    }
  }
  return null;
}

function createClient({ url, headers = {}, mask = (s) => s, timeoutMs = 30000, fetchImpl = fetch, clientInfo = { name: 'ai-command-center', version: '1.0.0' } }) {
  let session = null;
  let protocol = null;
  let nextId = 1;
  let ready = null;

  async function post(msg) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(session ? { 'mcp-session-id': session } : {}),
          ...(protocol ? { 'mcp-protocol-version': protocol } : {}),
          ...headers,
        },
        body: JSON.stringify(msg),
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) session = sid;
      if (!res.ok) throw new Error(`HTTP ${res.status} from upstream MCP: ${(await res.text()).slice(0, 300)}`);
      if (!('id' in msg)) { await res.text(); return null; }
      const type = res.headers.get('content-type') || '';
      const reply = type.includes('text/event-stream') ? await readSse(res, msg.id) : JSON.parse(await res.text());
      if (!reply) throw new Error('upstream MCP sent no reply');
      if (reply.error) throw new Error(`upstream MCP error ${reply.error.code}: ${reply.error.message}`);
      return reply.result;
    } catch (err) {
      throw new Error(mask(err.name === 'AbortError' ? `upstream MCP timed out after ${timeoutMs / 1000}s` : err.cause ? `${err.message}: ${err.cause.code || err.cause.message}` : err.message));
    } finally {
      clearTimeout(timer);
    }
  }

  async function init() {
    const r = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo } });
    protocol = (r && r.protocolVersion) || PROTOCOL;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }
  const initialize = () => (ready ||= init().catch((err) => { ready = null; session = null; throw err; }));

  async function request(method, params) {
    await initialize();
    try {
      return await post({ jsonrpc: '2.0', id: nextId++, method, params });
    } catch (err) {
      if (!/HTTP 404/.test(err.message) || !session) throw err;
      session = null; ready = null; // session expired upstream: start a new one once
      await initialize();
      return post({ jsonrpc: '2.0', id: nextId++, method, params });
    }
  }

  async function listTools() {
    const tools = [];
    let cursor;
    do {
      const r = await request('tools/list', cursor ? { cursor } : {});
      tools.push(...((r && r.tools) || []));
      cursor = r && r.nextCursor;
    } while (cursor && tools.length < 1000);
    return tools;
  }

  return { initialize, listTools, callTool: (name, args) => request('tools/call', { name, arguments: args || {} }) };
}

module.exports = { createClient };
