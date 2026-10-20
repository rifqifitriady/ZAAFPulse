#!/usr/bin/env node
// Precision, recall and F1 of the quality and safety detectors on the labelled corpus in
// test/fixtures/signals (written by hand, synthetic; see docs/quality-metrics.md).
//   node scripts/eval-signals.js                       the current lib/signals.js
//   node scripts/eval-signals.js --compare f2b198d     the same corpus against signals.js at a git ref
//   node scripts/eval-signals.js --set blind           one set: dev, holdout, blind (or all)
//   node scripts/eval-signals.js --misses              list every wrong verdict
//   node scripts/eval-signals.js --json                machine-readable output
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'signals');
const DETECTORS = ['corrections', 'injection', 'secrets', 'risky', 'hallucination'];

// Secrets are stored as <<SECRET:type>> so no secret-shaped string sits in the repository (push
// protection and secret scanners would trip on it). Values are random-looking but seeded.
function fakeSecrets() {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const from = (chars, n) => Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join('');
  const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const alnum = AZ + AZ.toLowerCase() + '0123456789';
  const b64u = (s) => Buffer.from(s).toString('base64url');
  const p = (...parts) => parts.join('');
  return {
    anthropic: () => p('sk-', 'ant-api03-', from(alnum + '_-', 93), 'AA'),
    openai: () => p('sk-', 'proj-', from(alnum + '_-', 64)),
    openrouter: () => p('sk-', 'or-v1-', from('0123456789abcdef', 64)),
    aws: () => p('AK', 'IA', from(AZ + '234567', 16)),
    github: () => p('gh', 'p_', from(alnum, 36)),
    'github-fine': () => p('github', '_pat_', from(alnum, 22), '_', from(alnum, 59)),
    slack: () => p('xo', 'xb-', from('0123456789', 12), '-', from('0123456789', 13), '-', from(alnum, 24)),
    google: () => p('AI', 'za', from(alnum + '_-', 35)),
    stripe: () => p('sk', '_live_', from(alnum, 32)),
    'stripe-test': () => p('sk', '_test_', from(alnum, 32)),
    huggingface: () => p('h', 'f_', from(alnum, 34)),
    jwt: () =>
      [
        b64u('{"alg":"HS256","typ":"JWT"}'),
        b64u(`{"sub":"${from(alnum, 8)}","iat":1760000000}`),
        from(alnum + '_-', 43),
      ].join('.'),
    'private-key': () => p('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
    'db-url': () => p('postgres', '://app_user:', from(alnum, 20), '@db.internal:5432/app'),
    'mongo-url': () => p('mongodb+srv', '://svc:', from(alnum, 18), '@cluster0.ab1cd.mongodb.net/prod'),
    'redis-url': () => p('rediss', '://default:', from(alnum, 24), '@cache.internal:6380'),
  };
}

function expand(text, gen) {
  return String(text).replace(/<<SECRET:([\w-]+)>>/g, (m, type) => {
    if (!gen[type]) throw new Error(`unknown secret placeholder ${m}`);
    return gen[type]();
  });
}

// Items per detector. Sets: "dev" (test/fixtures/signals/<detector>.json, written with the
// detectors), "holdout" (holdout.json, written by someone who never saw the detectors; scored once,
// then used for tuning) and "blind" (blind.json, written the same way and never tuned on).
// `set` is one of those names or "all".
const SETS = { holdout: 'holdout.json', blind: 'blind.json' };
function loadCorpus(set = 'all') {
  const gen = fakeSecrets();
  const out = Object.fromEntries(DETECTORS.map((d) => [d, []]));
  if (set === 'all' || set === 'dev')
    for (const d of DETECTORS)
      for (const it of JSON.parse(fs.readFileSync(path.join(FIXTURES, `${d}.json`), 'utf8')))
        out[d].push({ ...it, set: 'dev' });
  for (const [name, file] of Object.entries(SETS)) {
    if (set !== 'all' && set !== name) continue;
    const h = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    for (const d of DETECTORS) for (const it of h[d] || []) out[d].push({ ...it, set: name });
  }
  for (const it of out.secrets) it.text = expand(it.text, gen);
  return out;
}

const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// Runs one detector on one item: { flag, labels }.
function detect(sig, d, it) {
  if (d === 'corrections')
    return { flag: !!sig.isCorrection(it.text, { afterAssistant: it.after !== false }), labels: [] };
  if (d === 'injection') {
    const r = sig.scanInjection(it.text);
    return { flag: !!r, labels: r ? r.categories || [r.id] : [] };
  }
  if (d === 'secrets') {
    const r = sig.scanSecrets(it.text);
    return { flag: r.length > 0, labels: r };
  }
  if (d === 'risky') {
    const r = sig.scanRisky(it.cmd);
    return { flag: r.length > 0, labels: r };
  }
  const [category, kind] = sig.classifyError(it.text, it.tool);
  return { flag: category === 'hallucination', labels: category === 'hallucination' ? [kind] : [] };
}

// Labels are checked for secrets, risky commands and hallucination kinds (exact set), and for
// injection as "every expected category was recorded".
function labelOk(d, it, got) {
  const want = asList(it.label ?? it.kind ?? it.categories);
  if (!want.length) return true;
  if (d === 'injection') return want.every((w) => got.labels.includes(w));
  return want.length === got.labels.length && want.every((w) => got.labels.includes(w));
}

function evaluate(sig, corpus) {
  const report = {};
  for (const d of DETECTORS) {
    const m = { n: 0, tp: 0, fp: 0, fn: 0, tn: 0, labelled: 0, labelsOk: 0, misses: [] };
    for (const it of corpus[d]) {
      const got = detect(sig, d, it);
      m.n++;
      if (it.expect && got.flag) {
        m.tp++;
        if (asList(it.label ?? it.kind ?? it.categories).length) {
          m.labelled++;
          if (labelOk(d, it, got)) m.labelsOk++;
          else m.misses.push({ why: 'label', got: got.labels, it });
        }
      } else if (it.expect) {
        m.fn++;
        m.misses.push({ why: 'missed', it });
      } else if (got.flag) {
        m.fp++;
        m.misses.push({ why: 'false positive', got: got.labels, it });
      } else m.tn++;
    }
    m.precision = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 1;
    m.recall = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 1;
    m.f1 = m.precision + m.recall ? (2 * m.precision * m.recall) / (m.precision + m.recall) : 0;
    m.labelAccuracy = m.labelled ? m.labelsOk / m.labelled : null;
    report[d] = m;
  }
  return report;
}

// signals.js as it was at a git ref, loaded from a temporary copy.
function signalsAt(ref) {
  const src = execFileSync('git', ['-C', ROOT, 'show', `${ref}:lib/signals.js`], { encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-signals-'));
  const file = path.join(dir, 'signals.js');
  fs.writeFileSync(file, src);
  try {
    return require(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pct = (x) => (x == null ? '  —  ' : `${(x * 100).toFixed(0).padStart(3)}%`);

function main() {
  const arg = (n) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : null;
  };
  const set = arg('set') || 'all';
  const ref = arg('compare');
  const corpus = loadCorpus(set);
  const after = evaluate(require(path.join(ROOT, 'lib', 'signals')), corpus);
  const before = ref ? evaluate(signalsAt(ref), corpus) : null;
  if (process.argv.includes('--json')) {
    const strip = (r) =>
      r && Object.fromEntries(Object.entries(r).map(([d, m]) => [d, { ...m, misses: m.misses.length }]));
    console.log(JSON.stringify({ set, compare: ref, before: strip(before), after: strip(after) }, null, 2));
    return;
  }
  console.log(`corpus: ${set} · ${DETECTORS.map((d) => `${d} ${corpus[d].length}`).join(' · ')}`);
  const head = before
    ? 'detector        n   precision      recall          F1          labels'
    : 'detector        n   precision  recall   F1     labels';
  console.log(head);
  for (const d of DETECTORS) {
    const a = after[d];
    const cell = (k) => (before ? `${pct(before[d][k])} → ${pct(a[k])}` : pct(a[k]));
    console.log(
      `${d.padEnd(14)} ${String(a.n).padStart(3)}   ${cell('precision').padEnd(before ? 14 : 9)} ${cell('recall').padEnd(before ? 14 : 7)} ${cell('f1').padEnd(before ? 14 : 6)} ${cell('labelAccuracy')}`,
    );
  }
  if (process.argv.includes('--misses'))
    for (const d of DETECTORS)
      for (const x of after[d].misses)
        console.log(
          `  ${d} · ${x.why}${x.got ? ` ${JSON.stringify(x.got)}` : ''} · [${x.it.set}] ${JSON.stringify(x.it.text || x.it.cmd).slice(0, 110)}`,
        );
}

if (require.main === module) main();

module.exports = { loadCorpus, evaluate, detect, DETECTORS };
