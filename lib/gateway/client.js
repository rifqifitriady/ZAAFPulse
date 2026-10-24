// Which coding tool sent a gateway request, and whether it came from this machine. Claude Code or Codex here keeps its
// own logs, which the cost ledger counts already, so their gateway lines are tagged and the ledger skips them. Only the
// label is stored, never the raw User-Agent.

function clientOf(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent) return null;
  if (/^claude-cli\//i.test(userAgent)) return 'claude-code';
  if (/^codex_cli_rs\//i.test(userAgent) || /^codex\//i.test(userAgent)) return 'codex';
  return null;
}

// 127.0.0.0/8, ::1 and the IPv4-mapped form of 127.x (a dual-stack listener reports that).
const LOOPBACK = /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i;
const isLoopback = (address) => typeof address === 'string' && (address === '::1' || LOOPBACK.test(address));

// The optional usage-line fields for one request: `client` when it is a known tool, `local: true` from loopback.
function clientTag(req) {
  const client = clientOf(req && req.headers && req.headers['user-agent']);
  const local = isLoopback(req && req.socket && req.socket.remoteAddress);
  return { ...(client ? { client } : {}), ...(local ? { local: true } : {}) };
}

module.exports = { clientOf, isLoopback, clientTag };
