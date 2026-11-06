// A request's body, read once: the role check reads a gateway admin body for its action and the route reads it again,
// so both act on the same text and the same parsed object (its action). keep(req, text) is told the text once it is
// all read (server.js keeps a short one for the audit entry of a dashboard change).
function createBodyReader({ keep = () => {} } = {}) {
  const reads = new WeakMap(); // req -> { max, text }: the limit of the first read and its promise
  function readOnce(req, max) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > max) {
          req.destroy();
          reject(new Error('too large'));
        }
      });
      req.on('end', () => {
        keep(req, data);
        resolve(data);
      });
    });
  }
  // readBody(req, max = 1e6) -> a Promise of the text; over `max` characters it rejects with "too large". A later read
  // that allows more than the first one throws: the body was cut at the first limit, so it could not be what it wants.
  function readBody(req, max = 1e6) {
    const r = reads.get(req);
    if (r && max > r.max) throw new Error(`body already read with a limit of ${r.max} characters`);
    if (r) return r.text;
    const text = readOnce(req, max);
    reads.set(req, { max, text });
    return text;
  }
  // The body parsed once.
  const parsed = new WeakMap();
  function jsonBody(req) {
    if (!parsed.has(req)) parsed.set(req, readBody(req).then(JSON.parse));
    return parsed.get(req);
  }
  return { readBody, jsonBody };
}

module.exports = { createBodyReader };
