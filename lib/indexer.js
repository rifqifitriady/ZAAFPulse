// Keeps parsed results per log file, keyed by mtime+size, so a rescan only re-reads
// files that changed. The cache holds token counts and metadata, never message text.
const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 7; // 7: usage dedup keys, price extras, prompt times, Codex fork replay skipped
const CONCURRENCY = 6;

class Indexer {
  constructor(sources, cacheFile) {
    this.sources = sources;
    this.cacheFile = cacheFile;
    this.files = {};
    this.state = { indexing: false, total: 0, done: 0, lastScan: null, lastDurationMs: null, errors: 0 };
    this.version = 0; // bumps whenever data changes, used to memoize summaries
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.version === CACHE_VERSION) this.files = c.files;
    } catch {
      /* first run */
    }
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
    let changed = false;
    for (const f of Object.keys(this.files))
      if (!seen.has(f)) {
        delete this.files[f];
        changed = true;
      }

    this.state.total = work.length;
    this.state.done = 0;
    let i = 0;
    const worker = async () => {
      while (i < work.length) {
        const { file, src, st } = work[i++];
        try {
          const result = await src.parseFile(file);
          this.files[file] = { source: src.id, mtimeMs: st.mtimeMs, size: st.size, result };
          changed = true;
        } catch {
          this.state.errors++;
        }
        this.state.done++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (changed) {
      this.version++;
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = this.cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files: this.files }));
      fs.renameSync(tmp, this.cacheFile);
    }
    this.state.indexing = false;
    this.state.lastScan = Date.now();
    this.state.lastDurationMs = Date.now() - started;
  }

  results() {
    return Object.values(this.files).map((f) => f.result);
  }
}

module.exports = { Indexer };
