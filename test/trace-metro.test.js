// The Trace Explorer's metro map (public/tracemetro.js): the pure geometry the canvas is drawn from.
const test = require('node:test');
const assert = require('node:assert/strict');
const { traceDemo } = require('../lib/demo');
const { mapNodes } = require('../public/traceview.js');
const {
  METRO_GAP,
  METRO_BACK,
  metroSmooth,
  metroLayout,
  metroCamera,
  metroProject,
  metroLabelled,
  metroHit,
  metroBar,
  metroTour,
  metroRideAt,
} = require('../public/tracemetro.js');

const demoNodes = () => mapNodes(traceDemo(Date.UTC(2026, 9, 20, 12)).skeletons['demo-claude-1'].spans);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const VIEW = { w: 600, h: 400, f: 380, height: 110, horizon: 0.27 };

test('metroSmooth: clamps and eases', () => {
  assert.equal(metroSmooth(-1), 0);
  assert.equal(metroSmooth(0), 0);
  assert.equal(metroSmooth(0.5), 0.5);
  assert.equal(metroSmooth(1), 1);
  assert.equal(metroSmooth(2), 1);
});

test('metroLayout: stations 120 apart in order, swaying along the line', () => {
  const lay = metroLayout([{ kind: 'session' }, { kind: 'turn' }, { kind: 'chat' }]);
  assert.deepEqual(
    lay.map((p) => p.z),
    [0, METRO_GAP, 2 * METRO_GAP],
  );
  lay.forEach((p, i) => {
    near(p.x, Math.sin(i * 0.85) * 80);
    assert.equal(p.branch, 0);
  });
});

test('metroLayout: a subagent sits on a side branch; subagents alternate sides', () => {
  const lay = metroLayout([{ kind: 'turn' }, { kind: 'agent' }, { kind: 'agent' }, { kind: 'tool' }]);
  assert.equal(lay[1].branch, 1);
  assert.equal(lay[1].x, 160);
  assert.equal(lay[2].branch, -1);
  assert.equal(lay[2].x, -160);
  assert.equal(lay[3].branch, 0);
  assert.equal(lay[2].z, 2 * METRO_GAP);
});

test('metroLayout: an empty or missing list gives no stations', () => {
  assert.deepEqual(metroLayout([]), []);
  assert.deepEqual(metroLayout(undefined), []);
});

test('metroCamera: 190 behind the station, leaning 55% towards its x; clamped at both ends', () => {
  const lay = [
    { x: 0, z: 0, branch: 0 },
    { x: 100, z: 120, branch: 0 },
  ];
  assert.deepEqual(metroCamera(lay, 0), { x: 0, z: -METRO_BACK });
  const half = metroCamera(lay, 0.5);
  near(half.x, 50 * 0.55);
  near(half.z, 60 - METRO_BACK);
  const end = metroCamera(lay, 7);
  near(end.x, 55); // 100 × 0.55 is 55.00000000000001 in floating point
  near(end.z, 120 - METRO_BACK);
  assert.deepEqual(metroCamera(lay, -3), { x: 0, z: -METRO_BACK });
  assert.deepEqual(metroCamera([], 0), { x: 0, z: -METRO_BACK });
});

test('metroProject: ahead lands on the centre column, behind is null, k shrinks with distance', () => {
  const cam = { x: 0, z: 0 };
  const a = metroProject(cam, { x: 0, z: 190 }, VIEW);
  near(a[0], 300);
  near(a[2], 2);
  near(a[1], 400 * 0.27 + 110 * 2);
  near(a[3], 190);
  const far = metroProject(cam, { x: 0, z: 950 }, VIEW);
  assert.ok(far[2] < a[2]);
  const up = metroProject(cam, { x: 0, y: 56, z: 190 }, VIEW);
  assert.ok(up[1] < a[1], 'a raised point is higher on screen');
  assert.equal(metroProject(cam, { x: 0, z: 10 }, VIEW), null);
  assert.equal(metroProject(cam, { x: 0, z: -50 }, VIEW), null);
});

test('metroLabelled: focus − 1 … focus + 2 clamped to the line, plus the selection', () => {
  assert.deepEqual(
    [...metroLabelled(10, 0, -1)].sort((a, b) => a - b),
    [0, 1, 2],
  );
  assert.deepEqual(
    [...metroLabelled(10, 5, -1)].sort((a, b) => a - b),
    [4, 5, 6, 7],
  );
  assert.deepEqual(
    [...metroLabelled(10, 9, -1)].sort((a, b) => a - b),
    [8, 9],
  );
  assert.deepEqual(
    [...metroLabelled(10, 5, 1)].sort((a, b) => a - b),
    [1, 4, 5, 6, 7],
  );
  assert.deepEqual(
    [...metroLabelled(10, 4.6, 99)].sort((a, b) => a - b),
    [4, 5, 6, 7],
  );
  assert.equal(metroLabelled(0, 0, 0).size, 0);
});

test('metroHit: inside the radius hits, outside misses, the nearest of two overlapping wins', () => {
  const pts = [[100, 100, 1, 300], null, [300, 300, 1, 500]];
  assert.equal(metroHit(pts, 110, 105), 0);
  assert.equal(metroHit(pts, 140, 100), -1);
  assert.equal(metroHit(pts, 300, 321), 2);
  const overlap = [
    [200, 200, 1, 600],
    [205, 200, 1, 400],
  ];
  assert.equal(metroHit(overlap, 202, 200), 1);
  assert.equal(metroHit([], 0, 0), -1);
});

test('metroBar: the demo turn gives fractions inside 0..1, one per timed step', () => {
  const nodes = demoNodes();
  const bar = metroBar(nodes);
  assert.ok(bar.length > 0);
  for (const s of bar) {
    assert.ok(nodes[s.i].kind !== 'session' && nodes[s.i].kind !== 'turn');
    assert.ok(s.left >= 0 && s.width >= 0 && s.left + s.width <= 1 + 1e-9, JSON.stringify(s));
  }
  assert.equal(Math.min(...bar.map((s) => s.left)), 0);
  near(Math.max(...bar.map((s) => s.left + s.width)), 1);
});

test('metroBar: a node without times is left out; a zero-length turn gives no NaN', () => {
  const bar = metroBar([
    { kind: 'turn', start: 0, end: 10 },
    { kind: 'tool', start: 0, end: 4 },
    { kind: 'tool', start: null, end: null },
    { kind: 'chat', start: 4, end: 10 },
  ]);
  assert.deepEqual(
    bar.map((s) => s.i),
    [1, 3],
  );
  near(bar[1].left, 0.4);
  near(bar[1].width, 0.6);
  const flat = metroBar([{ kind: 'tool', start: 5, end: 5 }]);
  assert.deepEqual(flat, [{ i: 0, left: 0, width: 0 }]);
  assert.deepEqual(metroBar(undefined), []);
});

test('metroTour: moves 1100 ms, rests 900 ms, rests 2 s at the end, fades and wraps', () => {
  const n = 4; // 3 moves of 2000 ms, then 2000 ms rest, 250 ms fade out, 250 ms fade in: 8500 ms
  assert.deepEqual(metroTour(0, n), { p: 0, fade: 0 });
  near(metroTour(550, n).p, 0.5);
  assert.deepEqual(metroTour(1100, n), { p: 1, fade: 0 });
  assert.deepEqual(metroTour(1999, n), { p: 1, fade: 0 });
  near(metroTour(2550, n).p, 1.5);
  assert.deepEqual(metroTour(6000, n), { p: 3, fade: 0 });
  assert.deepEqual(metroTour(7999, n), { p: 3, fade: 0 });
  const out = metroTour(8125, n);
  assert.equal(out.p, 3);
  near(out.fade, 0.5);
  const back = metroTour(8375, n);
  assert.equal(back.p, 0);
  near(back.fade, 0.5);
  assert.deepEqual(metroTour(8500, n), { p: 0, fade: 0 });
  near(metroTour(8500 + 550, n).p, 0.5);
});

test('metroTour: one station or none rests at 0; bad times count as 0', () => {
  assert.deepEqual(metroTour(5000, 1), { p: 0, fade: 0 });
  assert.deepEqual(metroTour(5000, 0), { p: 0, fade: 0 });
  assert.deepEqual(metroTour(NaN, 4), { p: 0, fade: 0 });
  assert.deepEqual(metroTour(-20, 4), { p: 0, fade: 0 });
});

test('metroRideAt: the ride time at which the camera rests at station k', () => {
  assert.equal(metroRideAt(0), 0);
  assert.equal(metroRideAt(-2), 0);
  assert.equal(metroRideAt(1), 1100);
  assert.equal(metroRideAt(3), 5100);
  for (const k of [1, 2, 3]) assert.equal(metroTour(metroRideAt(k), 5).p, k);
});
