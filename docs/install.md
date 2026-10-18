# Installing ZAAFPulse

ZAAFPulse runs on these systems:

- **macOS** 12 or newer
- **Linux**: Ubuntu, Debian, RHEL 8/9, Rocky, AlmaLinux, Fedora, Amazon Linux, SUSE and Alpine, on x64, arm64, ppc64le or s390x
- **Windows** 10/11, on x64 or arm64

It needs Node.js 18 or newer and no npm packages. The installers bring their own Node.js when the system has none.

## Pick a way

| You want | Do this |
|---|---|
| It on your laptop | `curl -fsSL https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.sh \| sh` (macOS/Linux) or `irm https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.ps1 \| iex` (Windows PowerShell) |
| A shared server | `curl -fsSL …/install.sh \| sudo sh -s -- --server` |
| Containers | `docker compose up -d` with [compose.yaml](../compose.yaml) |
| One file, no installer | a `zaafpulse-<version>-<os>-<cpu>` binary from [Releases](https://github.com/rifqifitriady/ZAAFPulse/releases) |
| To hack on it | `git clone …`, then `npm start` |

## The installers

### macOS and Linux: `install.sh`

```bash
curl -fsSL https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.sh | sh
```

The installer:

1. Uses your `node` if it is 18 or newer. Otherwise it downloads the official Node.js 24 LTS for your OS and CPU from nodejs.org and checks it against the published SHA-256 sums.
2. Downloads the latest ZAAFPulse release (or `main` when there is none) and keeps only the app files.
3. Adds the `zaafpulse` command.
4. Starts ZAAFPulse in the background, and again at every login or boot.

| | As your user | As root (`sudo`) on Linux |
|---|---|---|
| App | `~/.local/share/zaafpulse/app` | `/opt/zaafpulse/app` |
| Node.js (if downloaded) | `~/.local/share/zaafpulse/node` | `/opt/zaafpulse/node` |
| Command | `~/.local/bin/zaafpulse` (added to PATH in your shell profile) | `/usr/local/bin/zaafpulse` |
| Data | macOS: `~/Library/Application Support/ZAAFPulse`; Linux: `~/.local/share/zaafpulse/data` | `/var/lib/zaafpulse` (owned by the `zaafpulse` system user) |
| Background | macOS: LaunchAgent `com.zaaf.aipulse.server`; Linux: systemd user service `zaafpulse` | systemd service `zaafpulse`, running as the `zaafpulse` user with `ProtectSystem`, `ProtectHome` and `NoNewPrivileges` |

The options go after `sh -s --`:

| Option | |
|---|---|
| `--server` | Listen on all interfaces (`0.0.0.0`) and ask for the admin password |
| `--host ADDR` / `--port N` | Listen on a specific address and port (default `127.0.0.1:4777`) |
| `--version v1.2.0` | A specific release, or `main` |
| `--source DIR` | Install from a local copy (offline, or to test changes) |
| `--no-service` | Do not start it in the background |
| `--no-modify-path` | Leave your shell profile alone |
| `--uninstall [--purge]` | Remove it; `--purge` also deletes the data |

On Alpine (musl), install Node.js first with `apk add nodejs`.

On Linux the user service keeps running after you log out only with lingering enabled. The installer tries to enable it; if that fails, run `sudo loginctl enable-linger $USER`.

Machines without systemd (some containers, WSL1) get the command but no service. Run `zaafpulse start` under your own supervisor instead.

### Windows: `install.ps1`

In PowerShell (no administrator needed):

```powershell
irm https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.ps1 | iex
```

With options:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rifqifitriady/ZAAFPulse/main/install.ps1))) -Server -Port 4777
```

Where things go:

- The app goes in `%LOCALAPPDATA%\ZAAFPulse\app`, and a downloaded Node.js in `%LOCALAPPDATA%\ZAAFPulse\node`.
- The `zaafpulse` command is added to your user PATH.
- Data lives in `%APPDATA%\ZAAFPulse`.

How it runs:

- ZAAFPulse starts now and at every logon, through a hidden launcher in your Startup folder. The launcher restarts it if it exits.
- A Start menu shortcut opens the dashboard.
- `-System` (from an elevated PowerShell) runs it instead as a Task Scheduler task at boot, as SYSTEM, for a server that has no logged-on user.

Other options: `-HostAddress`, `-Version`, `-Source`, `-NoService`, `-Uninstall [-Purge]`.

## Single-file executables

Each [release](https://github.com/rifqifitriady/ZAAFPulse/releases) has one file per platform, with `SHA256SUMS.txt`:

| File | For |
|---|---|
| `zaafpulse-<v>-darwin-arm64` / `-darwin-x64` | macOS on Apple silicon or Intel |
| `zaafpulse-<v>-linux-x64` / `-linux-arm64` | Linux on glibc (not Alpine) |
| `zaafpulse-<v>-win-x64.exe` / `-win-arm64.exe` | Windows 10/11 |

```bash
chmod +x zaafpulse-1.0.0-linux-x64
./zaafpulse-1.0.0-linux-x64                      # http://localhost:4777
./zaafpulse-1.0.0-linux-x64 service install      # run in the background and at startup
```

The file contains Node.js and the app. On first run it unpacks the app into your cache folder (`~/Library/Caches/ZAAFPulse`, `~/.cache/zaafpulse` or `%LOCALAPPDATA%\ZAAFPulse\app`) and runs it from there. All `zaafpulse` commands work the same way.

The binaries are not notarized or code-signed:

- **macOS:** a browser download is quarantined. Run `xattr -d com.apple.quarantine zaafpulse-*` once, or download with `curl`.
- **Windows:** SmartScreen asks once; choose *More info → Run anyway*.

To build them yourself: `node scripts/build-single.js` builds this machine's target, or `node scripts/build-single.js linux-x64 win-x64` builds others. macOS targets need a Mac. Pushing a `v*` tag builds all six in GitHub Actions and attaches them to a release.

## Docker

```bash
echo "ZAAFPULSE_ADMIN_PASSWORD=$(openssl rand -base64 18)" > .env
echo "ZAAFPULSE_MASTER_KEY=$(openssl rand -base64 32)" >> .env
docker compose up -d
```

The image is `node:24-alpine` with only the app files. It runs as the unprivileged `node` user and has a healthcheck.

- **Data:** everything lives in the `/data` volume, including the encrypted secret file.
- **`ZAAFPULSE_MASTER_KEY`:** encrypts provider and integration keys. Without it, a key file is created in the volume.
- **Reverse proxy:** set `ZAAFPULSE_PUBLIC_URL` and `ZAAFPULSE_TRUST_PROXY=1` when ZAAFPulse sits behind one.

## Server mode

ZAAFPulse listens on `127.0.0.1` unless told otherwise. Any other address turns on server mode:

- **Admin password:** the dashboard and its `/api` need one. Set it with `zaafpulse set-password` (stored as a scrypt hash) or with `ZAAFPULSE_ADMIN_PASSWORD` (or `ZAAFPULSE_ADMIN_PASSWORD_FILE`). ZAAFPulse does not start without one.
- **Sessions:** a session is an HttpOnly, SameSite=Strict cookie, which is also `Secure` over HTTPS. It lasts 12 hours and is renewed while it is used.
- **Wrong passwords:** five wrong guesses from one address lock sign-in for five minutes.
- **Apps:** `/v1`, `/mcp` and `/a2a` need ZAAFPulse API keys, as they always have.
- **Host names:** server mode accepts any host name. To restrict it, set `ZAAFPULSE_ALLOWED_HOSTS=ai.example.com,10.0.0.5`.

### HTTPS

Choose one of these:

- **Built in:** `ZAAFPULSE_TLS_CERT=/path/fullchain.pem ZAAFPULSE_TLS_KEY=/path/privkey.pem`.
- **Reverse proxy:** use nginx, Caddy or Traefik in front, with ZAAFPulse on `127.0.0.1`, plus `ZAAFPULSE_TRUST_PROXY=1` and `ZAAFPULSE_PUBLIC_URL=https://ai.example.com`.

```nginx
location / {
  proxy_pass http://127.0.0.1:4777;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto https;
  proxy_buffering off;           # streaming answers (SSE)
}
```

Open the port on the firewall:

| OS | Command |
|---|---|
| RHEL family | `firewall-cmd --add-port=4777/tcp --permanent && firewall-cmd --reload` |
| Ubuntu | `ufw allow 4777/tcp` |
| Windows (elevated) | `New-NetFirewallRule -DisplayName ZAAFPulse -Direction Inbound -Protocol TCP -LocalPort 4777 -Action Allow` |

## Where secrets are kept

| OS | Store |
|---|---|
| macOS | the login Keychain |
| Linux desktop | the system keyring through `secret-tool` (GNOME Keyring, KWallet) |
| Linux server, Docker | `.data/secrets.json`, encrypted with AES-256-GCM |
| Windows | `.data/secrets.json`, encrypted with AES-256-GCM, with its key sealed by Windows DPAPI for your user |

For the encrypted file:

- The key comes from `ZAAFPULSE_MASTER_KEY` or `ZAAFPULSE_MASTER_KEY_FILE`. Otherwise ZAAFPulse creates `.data/secret.key`, readable only by its user.
- Each value is bound to its name, so values cannot be swapped between names.

To choose a store explicitly, set `ZAAFPULSE_SECRET_STORE=keychain|libsecret|file`.

`config.json` only ever holds references to secrets, never their values.

## Commands

```text
zaafpulse [start] [--host H] [--port P] [--data DIR] [--demo] [--open]
zaafpulse set-password
zaafpulse service install|uninstall|status|restart [--system]
zaafpulse status | doctor | open | version | help
zaafpulse register-mcp <claude|kiro|antigravity|all> [--remove]
zaafpulse mcp
```

## Environment variables

| Variable | Default | |
|---|---|---|
| `ZAAFPULSE_HOST` | `127.0.0.1` | Address to listen on; anything else is server mode |
| `ZAAFPULSE_PORT` | `4777` | Port (`PORT` also works) |
| `ZAAFPULSE_DATA` | see the tables above | Folder for `config.json`, `.data/` and `.cache/` |
| `ZAAFPULSE_ADMIN_PASSWORD` (`_FILE`) | | Admin password for server mode |
| `ZAAFPULSE_AUTH` | | `1` requires sign-in even on 127.0.0.1 |
| `ZAAFPULSE_TLS_CERT`, `ZAAFPULSE_TLS_KEY` | | PEM files for built-in HTTPS |
| `ZAAFPULSE_PUBLIC_URL` | | The address apps should use, shown in snippets |
| `ZAAFPULSE_TRUST_PROXY` | | `1` behind a reverse proxy (X-Forwarded-For and -Proto) |
| `ZAAFPULSE_ALLOWED_HOSTS` | | Comma-separated host names to accept in server mode |
| `ZAAFPULSE_SECRET_STORE` | per OS | `keychain`, `libsecret` or `file` |
| `ZAAFPULSE_MASTER_KEY` (`_FILE`) | | Key for the encrypted secret file |
| `DEMO` | | `1` for synthetic data |

## What works where

| | macOS | Linux | Windows |
|---|---|---|---|
| Claude Code and Codex usage, cost and quality | ✓ | ✓ | ✓ |
| Live monitor (running AI apps, CPU, memory) | ✓ `ps`, `vm_stat` | ✓ `/proc` | ✓ CIM |
| Second brain: Obsidian vault discovery | ✓ | ✓ (also Flatpak and Snap) | ✓ |
| Agent Gateway, agents, workflows, RAG, MCP, A2A | ✓ | ✓ | ✓ |
| Register the MCP server in Claude Code, Kiro, Antigravity | ✓ | ✓ | ✓ |
| Code tools setup | ✓ | ✓ | ✓ |
| Background service | LaunchAgent | systemd (user or system) | Startup folder, or Task Scheduler as SYSTEM |

On a server, the usage pages show the Claude Code and Codex logs of the user ZAAFPulse runs as. A system service has none, so it serves mainly as the agent gateway and agentic workspace.
