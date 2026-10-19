// Fetching addresses that someone else typed (a URL to ingest, a link in a document) without letting
// them reach this machine or its network: loopback, private, link-local and cloud-metadata addresses are
// refused, every redirect is checked again, the body is capped and the request times out. Addresses
// the owner configures on purpose (Ollama, a local Qdrant) use plain fetch, not this.
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');

const MAX_REDIRECTS = 5;

// True for addresses a public URL must never resolve to.
function isPrivateAddress(ip) {
  let a = String(ip).toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7); // IPv4-mapped IPv6
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return (
      p === 0 ||
      p === 10 ||
      p === 127 || // this network, private, loopback
      (p === 100 && q >= 64 && q <= 127) || // carrier-grade NAT
      (p === 169 && q === 254) || // link-local, cloud metadata
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 192 && q === 0) || // IETF protocol assignments
      (p === 198 && (q === 18 || q === 19)) || // benchmarking
      p >= 224 // multicast and reserved
    );
  }
  if (net.isIPv6(a))
    return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || /^64:ff9b:/.test(a);
  return true; // not an address at all
}

async function assertPublic(url, { lookup = dns.lookup } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('not a valid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http:// and https:// URLs can be fetched');
  if (u.username || u.password) throw new Error('URLs with a user name or password are not fetched');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new Error(`${host} does not resolve`);
  const bad = addrs.find((x) => isPrivateAddress(x.address));
  if (bad) throw new Error(`${host} points to a private or local address (${bad.address}); it is not fetched`);
  return { url: u, address: addrs[0].address, family: addrs[0].family || net.isIP(addrs[0].address) };
}

// One request to an address that was already checked; the connection is pinned to that address so a
// second DNS answer (DNS rebinding) cannot send it elsewhere.
function requestPinned({ url, address, family }, { headers, signal, maxBytes }) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers,
        signal,
        lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        servername: url.hostname,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new Error(`the page is larger than ${Math.round(maxBytes / 1048576)} MB`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// GET for untrusted URLs. Returns { status, ok, headers, url, text } with at most maxBytes of body.
async function safeFetch(url, { headers = {}, timeoutMs = 20000, maxBytes = 5 * 1024 * 1024, lookup } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = await assertPublic(current, { lookup });
      const r = await requestPinned(target, { headers, signal: ctl.signal, maxBytes });
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        current = new URL(r.headers.location, current).toString();
        continue;
      }
      return {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        headers: r.headers,
        url: current,
        text: r.body.toString('utf8'),
      };
    }
    throw new Error('too many redirects');
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'timed out' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { safeFetch, assertPublic, isPrivateAddress };
