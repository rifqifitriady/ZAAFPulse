// A minimal PostgreSQL client for reading pgvector tables, no dependencies: TLS (sslmode=require/prefer),
// trust, cleartext, MD5 and SCRAM-SHA-256 authentication, and the simple query protocol (text results).
// Read-only use: the brain connector only runs SELECTs it builds itself.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function parseUrl(u) {
  const x = new URL(u);
  if (!/^postgres(ql)?:$/.test(x.protocol)) throw new Error('use a postgres:// connection URL');
  return {
    host: x.hostname || '127.0.0.1',
    port: Number(x.port) || 5432,
    user: decodeURIComponent(x.username || 'postgres'),
    password: decodeURIComponent(x.password || ''),
    database: decodeURIComponent((x.pathname || '/').slice(1) || x.username || 'postgres'),
    sslmode: x.searchParams.get('sslmode') || 'prefer',
  };
}
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
function msg(type, body) {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4);
  return type ? Buffer.concat([Buffer.from(type), len, body]) : Buffer.concat([len, body]);
}
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

async function connect(url, { timeoutMs = 10000 } = {}) {
  const cfg = parseUrl(url);
  let sock = net.connect(cfg.port, cfg.host);
  await new Promise((ok, fail) => {
    sock.once('connect', ok);
    sock.once('error', fail);
    setTimeout(() => fail(new Error('connection timed out')), timeoutMs).unref();
  });
  if (cfg.sslmode !== 'disable') {
    const req = Buffer.alloc(8);
    req.writeInt32BE(8);
    req.writeInt32BE(80877103, 4);
    sock.write(req);
    const answer = await new Promise((ok, fail) => {
      sock.once('data', (d) => ok(String.fromCharCode(d[0])));
      sock.once('error', fail);
    });
    if (answer === 'S') {
      sock = tls.connect({
        socket: sock,
        servername: net.isIP(cfg.host) ? undefined : cfg.host,
        rejectUnauthorized: cfg.sslmode === 'verify-full',
      });
      await new Promise((ok, fail) => {
        sock.once('secureConnect', ok);
        sock.once('error', fail);
      });
    } else if (cfg.sslmode === 'require' || cfg.sslmode === 'verify-full')
      throw new Error('the server does not accept TLS');
  }
  let buf = Buffer.alloc(0);
  const waiting = [];
  let ended = null;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    pump();
  });
  sock.on('error', (e) => {
    ended = e;
    while (waiting.length) waiting.shift().fail(e);
  });
  sock.on('close', () => {
    ended ||= new Error('connection closed');
    while (waiting.length) waiting.shift().fail(ended);
  });
  const queue = [];
  function pump() {
    while (buf.length >= 5) {
      const len = buf.readInt32BE(1);
      if (buf.length < len + 1) break;
      queue.push({ type: String.fromCharCode(buf[0]), body: buf.subarray(5, len + 1) });
      buf = buf.subarray(len + 1);
    }
    while (queue.length && waiting.length) waiting.shift().ok(queue.shift());
  }
  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : ended
        ? Promise.reject(ended)
        : new Promise((ok, fail) => waiting.push({ ok, fail }));
  const errorOf = (body) => {
    const f = {};
    let i = 0;
    while (i < body.length && body[i]) {
      const k = String.fromCharCode(body[i]);
      const end = body.indexOf(0, i + 1);
      f[k] = body.toString('utf8', i + 1, end);
      i = end + 1;
    }
    return new Error(f.M || 'postgres error');
  };

  const params = Buffer.concat([
    Buffer.from([0, 3, 0, 0]),
    cstr('user'),
    cstr(cfg.user),
    cstr('database'),
    cstr(cfg.database),
    cstr('application_name'),
    cstr('zaafpulse-brain'),
    Buffer.from([0]),
  ]);
  sock.write(msg(null, params));
  let scram = null;
  for (;;) {
    const m = await next();
    if (m.type === 'E') {
      sock.destroy();
      throw errorOf(m.body);
    }
    if (m.type === 'R') {
      const code = m.body.readInt32BE(0);
      if (code === 0) continue;
      if (code === 3) sock.write(msg('p', cstr(cfg.password)));
      else if (code === 5) {
        const inner = crypto
          .createHash('md5')
          .update(cfg.password + cfg.user)
          .digest('hex');
        sock.write(
          msg('p', cstr(`md5${crypto.createHash('md5').update(inner).update(m.body.subarray(4, 8)).digest('hex')}`)),
        );
      } else if (code === 10) {
        if (!m.body.toString().includes('SCRAM-SHA-256')) throw new Error('unsupported SASL mechanism');
        const nonce = crypto.randomBytes(18).toString('base64');
        const first = `n=,r=${nonce}`;
        scram = { nonce, first };
        const data = Buffer.from(`n,,${first}`);
        const len = Buffer.alloc(4);
        len.writeInt32BE(data.length);
        sock.write(msg('p', Buffer.concat([cstr('SCRAM-SHA-256'), len, data])));
      } else if (code === 11) {
        const server = m.body.subarray(4).toString();
        const a = Object.fromEntries(server.split(',').map((kv) => [kv[0], kv.slice(2)]));
        if (!a.r || !a.r.startsWith(scram.nonce)) throw new Error('SCRAM nonce mismatch');
        const salted = crypto.pbkdf2Sync(cfg.password, Buffer.from(a.s, 'base64'), Number(a.i), 32, 'sha256');
        const clientKey = hmac(salted, 'Client Key');
        const stored = crypto.createHash('sha256').update(clientKey).digest();
        const without = `c=biws,r=${a.r}`;
        const auth = `${scram.first},${server},${without}`;
        const sig = hmac(stored, auth);
        const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
        scram.serverSig = hmac(hmac(salted, 'Server Key'), auth).toString('base64');
        sock.write(msg('p', Buffer.from(`${without},p=${proof.toString('base64')}`)));
      } else if (code === 12) {
        if (!m.body.subarray(4).toString().includes(`v=${scram.serverSig}`))
          throw new Error('SCRAM server signature mismatch');
      } else throw new Error(`unsupported authentication (code ${code})`);
      continue;
    }
    if (m.type === 'Z') break;
  }
  return {
    // Simple query: rows as objects of text values (null for SQL NULL).
    async query(sql) {
      sock.write(msg('Q', cstr(sql)));
      let fields = [];
      const rows = [];
      let err = null;
      for (;;) {
        const m = await next();
        if (m.type === 'T') {
          const n = m.body.readInt16BE(0);
          let i = 2;
          fields = [];
          for (let k = 0; k < n; k++) {
            const end = m.body.indexOf(0, i);
            fields.push(m.body.toString('utf8', i, end));
            i = end + 1 + 18;
          }
        } else if (m.type === 'D') {
          const n = m.body.readInt16BE(0);
          let i = 2;
          const row = {};
          for (let k = 0; k < n; k++) {
            const len = m.body.readInt32BE(i);
            i += 4;
            row[fields[k]] = len < 0 ? null : m.body.toString('utf8', i, i + len);
            if (len > 0) i += len;
          }
          rows.push(row);
        } else if (m.type === 'E') err = errorOf(m.body);
        else if (m.type === 'Z') {
          if (err) throw err;
          return rows;
        }
      }
    },
    end() {
      try {
        sock.write(msg('X', Buffer.alloc(0)));
      } catch {
        /* closed */
      }
      sock.end();
    },
  };
}

module.exports = { connect, parseUrl };
