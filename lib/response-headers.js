// The headers of an answer: a route may add a Content-Disposition (a download), nothing else. The type, no-store and the
// security headers are set last, so no route header can replace or duplicate them.
function responseHeaders(type, extra, security) {
  const add = {};
  for (const [k, v] of Object.entries(extra || {}))
    if (k.toLowerCase() === 'content-disposition') add['Content-Disposition'] = v;
  return { ...add, 'Content-Type': type, 'Cache-Control': 'no-store', ...security };
}

module.exports = { responseHeaders };
