// Keeps parsed results per log file, keyed by mtime+size, so a rescan only re-reads
// files that changed. The cache holds token counts and metadata, never message text.
//
// Speed (numbers in docs/performance.md):
//  - Parsing is CPU-bound, so a large batch is spread over worker threads. A worker needs a file it
//    can require: the parser's module is found through require.cache, which also holds when the app
//    runs as the single-file build (scripts/sea-main.js unpacks real files and requires them). Any
//    source without a module file, or a worker that fails, falls back to parsing in this thread.
//  - The cache is a base file plus an append-only journal of changed entries, so one growing session
//    no longer rewrites every entry each minute. The journal is folded into the base when it grows.
const fs = require('fs');
const os = require('os');
const path = require('path');

// 8: usage dedup keys, price extras, prompt times, Codex fork replay skipped; detector labels and categories
// reworked (signals.js); journal
const CACHE_VERSION = 8;
const CONCURRENCY = 6; // in-thread parses in flight (they overlap file reads)
const WORKER_MIN_BYTES = 8e6; // smaller batches (a rescan) are parsed in this thread
const JOURNAL_MIN_COMPACT = 8e6;
const WORKER_SCRIPT = path.join(__dirname, 'index-worker.js');

// ZAAFPULSE_INDEX_WORKERS: 0 turns the pool off; a number sets its size.
function poolSize(override) {
  const env = override ?? process.env.ZAAFPULSE_INDEX_WORKERS;
  if (env != null && env !== '') return Math.max(0, Math.min(16, parseInt(env, 10) || 0));
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(0, Math.min(4, cores - 1));
}

// The module file whose exported parseFile is this function, or null.
const moduleCache = new WeakMap();
function moduleOf(fn) {
  if (typeof fn !== 'function') return null;
  if (moduleCache.has(fn)) return moduleCache.get(fn);
  let found = null;
  for (const [file, m] of Object.entries(require.cache))
    if (m && m.exports && m.exports.parseFile === fn && fs.existsSync(file)) {
      found = file;
      break;
    }
  moduleCache.set(fn, found);
  return found;
}

class Indexer {
  constructor(sources, cacheFile, opts = {}) {
    this.sources = sources;
    this.cacheFile = cacheFile;
    this.journalFile = cacheFile + '.journal';
    this.opts = opts; // { workers, workerScript, workerMinBytes } for tests and benchmarks
    this.files = {};
    this.state = {
      indexing: false,
      total: 0,
      done: 0,
      lastScan: null,
      lastDurationMs: null,
      errors: 0,
      workers: 0,
    };
    this.version = 0; // bumps whenever data changes, used to memoize summaries
    this.gen = 0;
    this.baseBytes = 0;
    this.journalBytes = 0;
    this.load();
  }

  load() {
    let base = null;
    try {
      const raw = fs.readFileSync(this.cacheFile, 'utf8');
      base = JSON.parse(raw);
      this.baseBytes = raw.length;
    } catch {
      return; // first run
    }
    if (!base || base.version !== CACHE_VERSION) return;
    this.files = base.files || {};
    this.gen = base.gen || 0;
    let journal = '';
    try {
      journal = fs.readFileSync(this.journalFile, 'utf8');
    } catch {
      return;
    }
    this.journalBytes = journal.length;
    // Entries from an older generation were already folded into the base; a torn last line
    // (a crash mid-append) fails to parse and is skipped.
    for (const line of journal.split('\n')) {
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.v !== CACHE_VERSION || j.g !== this.gen || typeof j.f !== 'string') continue;
      if (j.e) this.files[j.f] = j.e;
      else delete this.files[j.f];
    }
  }

  // Writes the changed entries: appended to the journal, or a fresh base when the journal has
  // grown past half the base (or there is no base of this version yet).
  save(changed) {
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    const lines = [...changed].map(
      (f) => JSON.stringify({ v: CACHE_VERSION, g: this.gen, f, e: this.files[f] || null }) + '\n',
    );
    const add = lines.reduce((a, l) => a + l.length, 0);
    const compact = !this.baseBytes || this.journalBytes + add > Math.max(JOURNAL_MIN_COMPACT, this.baseBytes / 2);
    if (!compact) {
      fs.appendFileSync(this.journalFile, lines.join(''));
      this.journalBytes += add;
      return;
    }
    this.gen++;
    const raw = JSON.stringify({ version: CACHE_VERSION, gen: this.gen, files: this.files });
    const tmp = this.cacheFile + '.tmp';
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, this.cacheFile);
    this.baseBytes = raw.length;
    // A journal left behind by a crash here belongs to the previous generation and is ignored.
    fs.rmSync(this.journalFile, { force: true });
    this.journalBytes = 0;
  }

  async refresh() {
    if (this.state.indexing) return;
    const started = Date.now();
    this.state.indexing = true;
    const work = [];
    const seen = new Set();
    for (const src of this.sources) {
      for (const file of src.listFiles()) {
        seen.add(file);
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        const c = this.files[file];
        if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) work.push({ file, src, st });
      }
    }
    const changed = new Set();
    for (const f of Object.keys(this.files))
      if (!seen.has(f)) {
        delete this.files[f];
        changed.add(f);
      }

    this.state.total = work.length;
    this.state.done = 0;
    this.state.workers = 0;
    const store = ({ file, src, st }, result) => {
      this.files[file] = { source: src.id, mtimeMs: st.mtimeMs, size: st.size, result };
      changed.add(file);
    };
    try {
      const local = await this.parseInWorkers(work, store);
      let i = 0;
      const worker = async () => {
        while (i < local.length) {
          const job = local[i++];
          try {
            store(job, await job.src.parseFile(job.file));
          } catch {
            this.state.errors++;
          }
          this.state.done++;
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));

      if (changed.size) {
        this.version++;
        this.save(changed);
      }
    } finally {
      this.state.indexing = false;
    }
    this.state.lastScan = Date.now();
    this.state.lastDurationMs = Date.now() - started;
  }

  // Parses what it can on worker threads and returns the jobs left for this thread.
  async parseInWorkers(work, store) {
    const size = poolSize(this.opts.workers);
    const jobs = [];
    const local = [];
    for (const job of work) {
      const mod = moduleOf(job.src.parseFile);
      if (mod) jobs.push({ ...job, mod });
      else local.push(job);
    }
    const bytes = jobs.reduce((a, j) => a + j.st.size, 0);
    if (size < 1 || jobs.length < 2 || bytes < (this.opts.workerMinBytes ?? WORKER_MIN_BYTES)) return work;
    let Worker;
    try {
      ({ Worker } = require('worker_threads'));
    } catch {
      return work;
    }
    // Largest first, so one big file does not finish last on its own.
    jobs.sort((a, b) => b.st.size - a.st.size);
    const queue = jobs.slice();
    const script = this.opts.workerScript || WORKER_SCRIPT;
    const runOne = () =>
      new Promise((resolve) => {
        let w;
        let current = null;
        let ready = false;
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          if (current) local.push(current); // the job it was on is retried here
          current = null;
          if (!ready) local.push(...queue.splice(0)); // could not start: parse the rest here
          if (w) w.terminate().catch(() => {});
          resolve();
        };
        const next = () => {
          current = queue.shift() || null;
          if (!current) return done();
          w.postMessage({ file: current.file, mod: current.mod });
        };
        try {
          w = new Worker(script);
        } catch {
          return done();
        }
        w.on('message', (m) => {
          if (m && m.ready) {
            ready = true;
            this.state.workers++;
            return next();
          }
          if (!current) return;
          if (m && m.error) this.state.errors++;
          else store(current, m.result);
          this.state.done++;
          current = null;
          next();
        });
        w.on('error', done);
        w.on('exit', done);
      });
    await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, runOne));
    return local;
  }

  results() {
    return Object.values(this.files).map((f) => f.result);
  }
}

module.exports = { Indexer, CACHE_VERSION };
