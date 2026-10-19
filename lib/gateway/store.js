// Small JSON stores for gateway data that must survive restarts (.data/, git-ignored):
// API keys, agents, sessions and memory. Writes are atomic and debounced.
const fs = require('fs');
const path = require('path');

function jsonStore(file, fallback) {
  let value;
  let timer = null;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    value = typeof fallback === 'function' ? fallback() : structuredClone(fallback);
  }
  const flush = () => {
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    get: () => value,
    set(next) {
      value = next;
      this.save(true);
    },
    // now=true writes immediately (keys, agents); otherwise within a second (sessions).
    save(now = false) {
      if (now) {
        clearTimeout(timer);
        flush();
      } else if (!timer) timer = setTimeout(flush, 1000);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    },
  };
}

// Append-only JSONL with a size cap (keeps one rotated file).
function jsonlLog(file, maxBytes = 10 * 1024 * 1024) {
  return {
    append(entry) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
          if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
        } catch {
          /* new file */
        }
        fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      } catch {
        /* logging must never break a request */
      }
    },
    read() {
      const out = [];
      for (const f of [`${file}.1`, file]) {
        let text = '';
        try {
          text = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            out.push(JSON.parse(line));
          } catch {
            /* partial line */
          }
        }
      }
      return out;
    },
  };
}

module.exports = { jsonStore, jsonlLog };
