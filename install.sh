#!/bin/sh
# ZAAFPulse installer for macOS and Linux (Ubuntu, Debian, RHEL, Rocky, AlmaLinux, Fedora, Amazon Linux,
# SUSE, Alpine …). One command:
#
#   curl -fsSL https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.sh | sh
#
# Server (listen on the network, sign-in required; as root it becomes a systemd system service):
#
#   curl -fsSL https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.sh | sudo sh -s -- --server
#
# Options: --server  --host ADDR  --port N  --version TAG|main  --source DIR (a local copy, offline)
#          --no-service  --no-modify-path
#          --uninstall [--purge]
# What it does: uses Node.js 18+ if you have it, else downloads the official Node.js LTS (checksum
# verified) into the install folder; downloads ZAAFPulse; adds the `zaafpulse` command; starts it as a
# background service (launchd, or systemd). Nothing else on the system is changed.
set -eu

REPO="rifqifitriady/ZAAFPulse"
VERSION=""; SOURCE=""; HOST=""; PORT=""; SERVER=0; SERVICE=1; MODIFY_PATH=1; UNINSTALL=0; PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER=1; HOST="${HOST:-0.0.0.0}" ;;
    --host) HOST="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --version) VERSION="$2"; shift ;;
    --source) SOURCE="$2"; shift ;;
    --no-service) SERVICE=0 ;;
    --no-modify-path) MODIFY_PATH=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
fetch() { if have curl; then curl -fsSL --retry 3 "$1" -o "$2"; elif have wget; then wget -qO "$2" "$1"; else die "curl or wget is required"; fi; }
fetch_text() { if have curl; then curl -fsSL --retry 3 "$1"; else wget -qO- "$1"; fi; }
sha256() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in Darwin) PLAT=darwin ;; Linux) PLAT=linux ;; *) die "unsupported OS $OS (Windows: use install.ps1)" ;; esac
case "$ARCH" in x86_64|amd64) NARCH=x64 ;; aarch64|arm64) NARCH=arm64 ;; armv7l) NARCH=armv7l ;; ppc64le) NARCH=ppc64le ;; s390x) NARCH=s390x ;; *) die "unsupported CPU $ARCH" ;; esac

if [ "$(id -u)" = 0 ] && [ "$PLAT" = linux ]; then
  ROOT_INSTALL=1; PREFIX="/opt/zaafpulse"; BIN_DIR="/usr/local/bin"
else
  ROOT_INSTALL=0; PREFIX="${ZAAFPULSE_PREFIX:-$HOME/.local/share/zaafpulse}"; BIN_DIR="$HOME/.local/bin"
fi
LAUNCHER="$BIN_DIR/zaafpulse"

if [ "$UNINSTALL" = 1 ]; then
  if [ -x "$LAUNCHER" ]; then
    if [ "$ROOT_INSTALL" = 1 ]; then "$LAUNCHER" service uninstall --system || true; else "$LAUNCHER" service uninstall || true; fi
  fi
  rm -rf "$PREFIX" "$LAUNCHER"
  say "ZAAFPulse removed from $PREFIX."
  if [ "$PURGE" = 1 ]; then
    if [ "$ROOT_INSTALL" = 1 ]; then rm -rf /var/lib/zaafpulse; userdel zaafpulse 2>/dev/null || true
    elif [ "$PLAT" = darwin ]; then rm -rf "$HOME/Library/Application Support/ZAAFPulse"
    else rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/zaafpulse"; fi
    say "Data removed too."
  else
    say "Your data (config, keys, history) was kept. Add --purge to delete it."
  fi
  exit 0
fi

# ---- Node.js: yours if it is 18 or newer, else the official LTS in $PREFIX/node ----
NODE=""
if have node && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then
  NODE="$(command -v node)"
  # A system service runs as the zaafpulse user, which cannot read a Node.js under /root or /home.
  case "$NODE" in /root/*|/home/*) [ "$ROOT_INSTALL" = 1 ] && NODE="" ;; esac
  [ -n "$NODE" ] && say "Using Node.js $(node -v) at $NODE"
fi
if [ -z "$NODE" ] && [ -x "$PREFIX/node/bin/node" ]; then NODE="$PREFIX/node/bin/node"; say "Using bundled Node.js $("$NODE" -v)"; fi
if [ -z "$NODE" ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
    die "Alpine/musl: install Node.js first (apk add nodejs), then run this again."
  fi
  say "Downloading Node.js LTS for $PLAT-$NARCH"
  TMP_NODE="$(mktemp -d)"
  SUMS="$(fetch_text https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)"
  FILE="$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v[0-9.]+-$PLAT-$NARCH\.tar\.gz$" | head -n1)"
  [ -n "$FILE" ] || die "no official Node.js build for $PLAT-$NARCH"
  fetch "https://nodejs.org/dist/latest-v24.x/$FILE" "$TMP_NODE/$FILE"
  WANT="$(printf '%s\n' "$SUMS" | grep "  $FILE\$" | cut -d' ' -f1)"
  [ "$(sha256 "$TMP_NODE/$FILE")" = "$WANT" ] || die "Node.js checksum mismatch"
  mkdir -p "$PREFIX"; rm -rf "$PREFIX/node"
  tar -xzf "$TMP_NODE/$FILE" -C "$TMP_NODE"; mv "$TMP_NODE/${FILE%.tar.gz}" "$PREFIX/node"; rm -rf "$TMP_NODE"
  NODE="$PREFIX/node/bin/node"; say "Node.js $("$NODE" -v) installed in $PREFIX/node"
fi

# ---- ZAAFPulse: the latest release (checksum verified), or main only when asked for ----
if [ -z "$VERSION" ] && [ -z "$SOURCE" ]; then
  VERSION="$(fetch_text "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1 || true)"
  [ -n "$VERSION" ] || die "could not find the latest release on GitHub; try again, or install the development version with --version main"
fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ -n "$SOURCE" ]; then
  SRC="$(cd "$SOURCE" && pwd)"; say "Installing ZAAFPulse from $SRC"
elif [ "$VERSION" = main ] || [ "$VERSION" = master ]; then
  warn "Installing the development branch ($VERSION): not a release, not checksum-verified."
  fetch "https://codeload.github.com/$REPO/tar.gz/refs/heads/$VERSION" "$TMP/app.tar.gz"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP"
  SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n1)"
else
  say "Downloading ZAAFPulse $VERSION"
  REL="https://github.com/$REPO/releases/download/$VERSION"
  NAME="zaafpulse-${VERSION#v}-source.tar.gz"
  if fetch "$REL/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt" 2>/dev/null && grep -q "  $NAME\$" "$TMP/SHA256SUMS.txt"; then
    fetch "$REL/$NAME" "$TMP/app.tar.gz"
    WANT="$(grep "  $NAME\$" "$TMP/SHA256SUMS.txt" | cut -d' ' -f1)"
    [ "$(sha256 "$TMP/app.tar.gz")" = "$WANT" ] || die "checksum mismatch for $NAME: the download was changed or damaged"
    say "Checksum verified ($NAME)"
  elif [ "$VERSION" = v1.0.0 ]; then
    warn "Release $VERSION predates checksummed packages; downloading the tag without verification."
    fetch "https://codeload.github.com/$REPO/tar.gz/refs/tags/$VERSION" "$TMP/app.tar.gz"
  else
    die "could not get a verified package for $VERSION (SHA256SUMS.txt missing or unreachable); nothing was installed"
  fi
  mkdir "$TMP/x" && tar -xzf "$TMP/app.tar.gz" -C "$TMP/x"
  SRC="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -n1)"
fi
[ -f "$SRC/bin/zaafpulse.js" ] || die "the download does not look like ZAAFPulse"
mkdir -p "$PREFIX"; rm -rf "$PREFIX/app.new"; mkdir "$PREFIX/app.new"
# The app only: no docs, media or tests.
for item in bin lib public skills scripts server.js mcp.js package.json config.example.json README.md LICENSE; do
  [ -e "$SRC/$item" ] && cp -R "$SRC/$item" "$PREFIX/app.new/"
done
rm -rf "$PREFIX/app.old"; [ -d "$PREFIX/app" ] && mv "$PREFIX/app" "$PREFIX/app.old"
mv "$PREFIX/app.new" "$PREFIX/app"; rm -rf "$PREFIX/app.old"
[ "$ROOT_INSTALL" = 1 ] && chmod -R a+rX "$PREFIX"

# ---- the zaafpulse command ----
mkdir -p "$BIN_DIR"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE" "$PREFIX/app/bin/zaafpulse.js" "\$@"
EOF
chmod 755 "$LAUNCHER"
say "Command installed: $LAUNCHER"
if [ "$ROOT_INSTALL" = 0 ] && [ "$MODIFY_PATH" = 1 ]; then
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *)
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ]; then
        grep -qs 'zaafpulse' "$rc" || printf '\n# ZAAFPulse\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
      fi
    done
    say "Added ~/.local/bin to PATH in your shell profile (open a new terminal, or: export PATH=\"\$HOME/.local/bin:\$PATH\")" ;;
  esac
fi

# ---- server mode: an admin password before the first start ----
if [ -n "$HOST" ]; then export ZAAFPULSE_HOST="$HOST"; fi
if [ -n "$PORT" ]; then export ZAAFPULSE_PORT="$PORT"; fi
if [ -n "$HOST" ] && [ "$HOST" != 127.0.0.1 ] && [ "$HOST" != localhost ]; then
  if [ -n "${ZAAFPULSE_ADMIN_PASSWORD:-}" ]; then
    printf '%s\n' "$ZAAFPULSE_ADMIN_PASSWORD" | "$LAUNCHER" set-password
  elif [ -r /dev/tty ]; then
    say "Server mode: choose the dashboard admin password"
    "$LAUNCHER" set-password < /dev/tty
  else
    warn "Server mode needs an admin password: run \`zaafpulse set-password\`, then \`zaafpulse service restart\`."
  fi
fi

# ---- background service ----
if [ "$SERVICE" = 1 ]; then
  if [ "$ROOT_INSTALL" = 1 ]; then "$LAUNCHER" service install --system || warn "Service not installed; start it yourself with: zaafpulse start"
  else "$LAUNCHER" service install || warn "Service not installed; start it yourself with: zaafpulse start"; fi
fi

P="${PORT:-4777}"
echo
say "ZAAFPulse is installed."
if [ -n "$HOST" ] && [ "$HOST" != 127.0.0.1 ]; then
  echo "    Dashboard:  http://$(uname -n):$P   (sign in with the admin password)"
  have firewall-cmd && echo "    Firewall:   sudo firewall-cmd --add-port=$P/tcp --permanent && sudo firewall-cmd --reload"
  have ufw && echo "    Firewall:   sudo ufw allow $P/tcp"
  echo "    Use HTTPS in production: a reverse proxy, or ZAAFPULSE_TLS_CERT and ZAAFPULSE_TLS_KEY."
else
  echo "    Dashboard:  http://localhost:$P"
fi
echo "    Commands:   zaafpulse status | doctor | open | service restart | help"
echo "    Uninstall:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh -s -- --uninstall"
