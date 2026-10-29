const test = require('node:test');
const assert = require('node:assert/strict');
const { responseHeaders } = require('../lib/response-headers');

test('response headers: a route adds Content-Disposition only; type, no-store and security headers stay ours', () => {
  const h = responseHeaders(
    'text/csv',
    {
      'Content-Disposition': 'attachment; filename="a.csv"',
      'Cache-Control': 'public',
      'cache-control': 'public',
      'x-frame-options': 'ALLOWALL',
      'Content-Type': 'text/html',
    },
    { 'X-Frame-Options': 'DENY' },
  );
  assert.deepEqual(h, {
    'Content-Disposition': 'attachment; filename="a.csv"',
    'Content-Type': 'text/csv',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
  });
  assert.deepEqual(responseHeaders('application/json', undefined, {}), {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
});

test('response headers: Content-Disposition in two casings goes out once, under its canonical name', () => {
  const h = responseHeaders(
    'text/csv',
    { 'content-disposition': 'attachment; filename="a.csv"', 'CONTENT-DISPOSITION': 'attachment; filename="b.csv"' },
    {},
  );
  assert.deepEqual(
    Object.keys(h).filter((k) => k.toLowerCase() === 'content-disposition'),
    ['Content-Disposition'],
  );
  assert.equal(h['Content-Disposition'], 'attachment; filename="b.csv"');
});
