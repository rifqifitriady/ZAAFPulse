// Cost Control 3b: what a change of the cost settings, or a restate, would do, from rows the caller read. Pure: no I/O,
// no clock. The Settings page draws these answers (POST /api/cost/settings/preview, POST /api/cost/restate/preview).
const { compile, globToRegExp, UNASSIGNED } = require('./rules');

const MAX_MOVES = 50;
const MAX_UNASSIGNED = 20;
const MAX_CENTER_MOVES = 20;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const usd = (v) => Math.round(v * 1e8) / 1e8;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// The case rule compile() uses unless told otherwise: folders compare without case on macOS and Windows.
const nocaseOf = (opts) =>
  opts && typeof opts.nocase === 'boolean'
    ? opts.nocase
    : process.platform === 'darwin' || process.platform === 'win32';

/**
 * The effect of `draft` against `saved` (both validated settings) on the last 30 days of rows
 * (`cost.ledger({ groupBy: ['project', 'keyId'] }).rows`), and where `testPath` (a `~` path, or null) goes.
 * `keys` names gateway keys ([{ id, name }]) for the moves; each move says what decided it, `by: 'key' | 'rule'`.
 */
function settingsPreview({ saved, draft, rows = [], testPath = null, keys = [], compileOpts } = {}) {
  const nocase = nocaseOf(compileOpts);
  const before = compile(saved, { nocase });
  const after = compile(draft, { nocase });
  const names = new Map(keys.map((k) => [k.id, k.name]));
  const globs = draft.folderRules.map((r) => globToRegExp(r.glob, { nocase }));
  const firstRule = (p) => globs.findIndex((re) => re.test(p));

  const moves = [];
  const projects = new Map(); // project -> usage value, for the rows the folder rules decide under the draft
  for (const r of rows) {
    const row = { project: r.project ?? null, keyId: r.keyId ?? null };
    const from = before.centerOf(row);
    const to = after.centerOf(row);
    const keyed = !!row.keyId && Object.hasOwn(draft.keyCenters, row.keyId);
    // A key decides the move when the draft maps it, or the saved settings did and the draft no longer does.
    const wasKeyed = !!row.keyId && Object.hasOwn(saved.keyCenters, row.keyId);
    if (from !== to)
      moves.push({
        project: row.project,
        keyId: row.keyId,
        keyName: row.keyId ? names.get(row.keyId) || null : null,
        listUSD: usd(num(r.listUSD)),
        from,
        to,
        by: keyed || wasKeyed ? 'key' : 'rule',
      });
    if (row.project && !keyed) projects.set(row.project, (projects.get(row.project) || 0) + num(r.listUSD));
  }
  moves.sort(
    (a, b) =>
      b.listUSD - a.listUSD ||
      cmp(String(a.project ?? ''), String(b.project ?? '')) ||
      cmp(a.keyId ?? '', b.keyId ?? ''),
  );

  // Each project's deciding rule under the draft, then each rule's status from the projects it matches.
  const first = new Map([...projects.keys()].map((p) => [p, firstRule(p)]));
  const rules = globs.map((re, index) => {
    const hits = [...projects.keys()].filter((p) => re.test(p));
    if (!hits.length) return { index, status: 'none', by: null };
    if (hits.some((p) => first.get(p) === index)) return { index, status: 'ok', by: null };
    return { index, status: 'shadowed', by: Math.min(...hits.map((p) => first.get(p))) };
  });

  const unassigned = [...projects]
    .filter(([p]) => first.get(p) < 0)
    .map(([project, v]) => ({ project, listUSD: usd(v) }))
    .sort((a, b) => b.listUSD - a.listUSD || cmp(a.project, b.project))
    .slice(0, MAX_UNASSIGNED);

  // A path is tested as a project: the rules decide, a key mapping does not apply.
  let test = null;
  if (typeof testPath === 'string' && testPath) {
    const i = firstRule(testPath);
    test = i < 0 ? { center: UNASSIGNED, rule: null } : { center: draft.folderRules[i].center, rule: i };
  }
  return {
    moves: moves.slice(0, MAX_MOVES),
    more: Math.max(0, moves.length - MAX_MOVES),
    rules,
    unassigned,
    test,
  };
}

/** A restate preview (cost.restatePreview) summed for the page: rows that change, usage value before and after, and
 *  the usage value that changes center, per (old center, new center) pair. */
function restateSummary({
  rows = [],
  total = null,
  billing = [],
  versionsBefore = [],
  version = null,
  newPrices = false,
} = {}) {
  let beforeUSD = 0;
  let afterUSD = 0;
  const pairs = new Map();
  for (const x of rows) {
    beforeUSD += num(x.before.listUSD);
    afterUSD += num(x.after.listUSD);
    const from = x.before.center ?? UNASSIGNED;
    const to = x.after.center ?? UNASSIGNED;
    if (from === to) continue;
    const k = JSON.stringify([from, to]);
    const m = pairs.get(k) || { from, to, listUSD: 0 };
    m.listUSD += num(x.after.listUSD);
    pairs.set(k, m);
  }
  const moves = [...pairs.values()]
    .map((m) => ({ ...m, listUSD: usd(m.listUSD) }))
    .sort((a, b) => b.listUSD - a.listUSD || cmp(a.from, b.from) || cmp(a.to, b.to))
    .slice(0, MAX_CENTER_MOVES);
  return {
    changed: rows.length,
    total,
    beforeUSD: usd(beforeUSD),
    afterUSD: usd(afterUSD),
    moves,
    versionsBefore,
    version,
    newPrices: !!newPrices,
    billing,
  };
}

module.exports = { settingsPreview, restateSummary, MAX_MOVES, MAX_UNASSIGNED, MAX_CENTER_MOVES };
