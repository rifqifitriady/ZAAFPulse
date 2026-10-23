// Append-only JSON-lines log (mode 0600). For MCP tool calls: time, integration, tool, ok, duration and argument names.
// Argument values are never written. Rotates at 5 MB, keeping one previous file.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;

function createAudit(file) {
  return {
    record(entry) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); // a folder it creates is the owner's only
        try {
          if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
        } catch {
          /* no file yet */
        }
        fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 }); // only the owner reads it
      } catch {
        /* auditing must never break a tool call */
      }
    },
    tail(n = 100) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      const out = [];
      for (const line of text.trimEnd().split('\n').slice(-n).reverse()) {
        try {
          out.push(JSON.parse(line));
        } catch {
          /* partial line while another process writes */
        }
      }
      return out;
    },
  };
}

module.exports = { createAudit };
