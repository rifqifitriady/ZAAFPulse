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

## Who can open the dashboard

There are three sign-in modes. ZAAFPulse picks one by itself:

| Mode | When | How you get in |
|---|---|---|
| **none** | 127.0.0.1 on a single-user machine (the default on a laptop) | Open http://localhost:4777 |
| **local** | Linux with other login users, or `ZAAFPULSE_AUTH=local` | `zaafpulse open`. It writes a one-time code into your private data folder, and the browser swaps it for a 30-day cookie. Other accounts and their programs cannot get in. |
| **password** | Any address but 127.0.0.1, a reverse proxy (`ZAAFPULSE_TRUST_PROXY`, `ZAAFPULSE_PUBLIC_URL` or `ZAAFPULSE_ALLOWED_HOSTS`), or `ZAAFPULSE_AUTH=1` | The admin password |

On a shared machine, or for extra safety on your own, set `ZAAFPULSE_AUTH=local`.

While sign-in is off, ZAAFPulse refuses requests that carry proxy headers (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Via`). It also refuses browser requests whose `Origin` or `Referer` names another host, and cross-site requests.

This catches the usual proxy mistakes and any browser that reaches the dashboard through a proxy. It cannot catch a non-browser client behind a proxy that strips all those headers and rewrites the Host to `localhost`: such a client looks exactly like a program on this machine.

**Any reverse proxy in front of ZAAFPulse needs sign-in.** Set `ZAAFPULSE_TRUST_PROXY=1` and an admin password, or use `ZAAFPULSE_AUTH=local`.

## Server mode

ZAAFPulse listens on `127.0.0.1` unless told otherwise. Any other address, or a reverse proxy in front of it, turns on password sign-in:

- **Admin password:** the dashboard and its `/api` need one. Set it with `zaafpulse set-password` (stored as a scrypt hash) or with `ZAAFPULSE_ADMIN_PASSWORD` (or `ZAAFPULSE_ADMIN_PASSWORD_FILE`). ZAAFPulse does not start without one.
- **Sessions:** a session is an HttpOnly, SameSite=Strict cookie, which is also `Secure` over HTTPS. It lasts 12 hours and is renewed while it is used, up to 7 days.
- **Wrong passwords:**
  - One sign-in is checked at a time per address. Every attempt counts before it is checked, so parallel guessing does not help.
  - Five failures lock that address for five minutes.
  - Fifty failures from all addresses together lock sign-in for everyone for five minutes.
  - Behind a proxy, the address is the right-most `X-Forwarded-For` entry, and IPv6 addresses count per /64.
- **Apps:** `/v1`, `/mcp` and `/a2a` need ZAAFPulse API keys, as they always have.
- **Host names:** with sign-in on, any host name is accepted. To restrict it, set `ZAAFPULSE_ALLOWED_HOSTS=ai.example.com,10.0.0.5`.
- **Browser protection:** every dashboard response carries a strict Content-Security-Policy, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

## Built-in safeguards

- **Stored secrets stay with their address.** Changing the URL of a provider, integration or second-brain source requires entering its secret again. A stored key is never sent to a new host.
- **Secret references:**
  - In the dashboard, a secret is either pasted (it is then saved for that entry only) or kept as it is.
  - Pointing an entry at another secret item or at an environment variable is done by hand in `config.json`. A dashboard user, or a program that reaches it, cannot borrow a secret that was saved for something else.
  - References may only name ZAAFPulse's own items (`acc.*`), and never ZAAFPulse's own settings (`ZAAFPULSE_*`, which hold the admin password and master key).
  - A remote A2A agent's token comes from a `ZP_SECRET_…` environment variable. It is only sent to the address it was set for.
  - Credentials never follow a redirect to another host.
- **Agents and tools:**
  - An agent can only run the integration tools in its allow list.
  - A key needs the `mcp` scope for its agents to use integration tools.
  - Tools that change something run only after a person approves the exact call:
    - In a workflow step with an approval gate, the agent first proposes its actions (tool and arguments). Nothing changes yet.
    - The run waits until you approve those calls in the dashboard, all of them or some by number.
    - Only the approved calls run, exactly as proposed.
    - Outside such a step the agent describes the change instead of making it.
  - Approving is a person's decision in the dashboard. An app's API key may reject or stop its own run, but approves it only when the key has **May approve its own paused runs** (for a pipeline that has its own human approval).
  - Notes agents save under one API key are not visible to another key.
  - A key can be limited to some knowledge bases, which applies to `/v1/knowledge` and to the agents run with that key.
  - A key with a monthly budget can only use models whose spend can be counted: a list price, or a private model on your own hardware. Its embeddings count toward the budget too.
- **Approvals:** approving a paused run keeps the limits of the key that started it. A run of a deleted, revoked or expired key cannot continue.
- **URL ingestion:** URLs given to the RAG service cannot reach this machine, private networks or cloud metadata, including through redirects or a second DNS answer. Pages are capped at 5 MB. For an on-premises intranet, set `ZAAFPULSE_ALLOW_PRIVATE_URLS=1`.
- **Files are private.** Everything ZAAFPulse creates in its data folder is readable only by its own account.
- **Installer integrity:**
  - The installers verify each release's source package against `SHA256SUMS.txt`.
  - They stop when it cannot be verified; only v1.0.0 predates the checksums.
  - They never fall back to the development branch unless you ask (`--version main`).
  - The checksum comes from the same GitHub release, so it protects against damaged or altered downloads, not against a compromised GitHub account.
  - From 1.0.3 every release file also has a build-provenance attestation (Sigstore), signed as made by this repository's release workflow from a specific commit. Check one with `gh attestation verify zaafpulse-1.0.3-linux-x64 --repo rifqifitriady/ZAAFPulse`. A file uploaded by hand, even with a stolen token, has no valid attestation.
- **Verify a download yourself:**
  - Checksum: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` on macOS, `sha256sum -c SHA256SUMS.txt --ignore-missing` on Linux, or `(Get-FileHash zaafpulse-<v>-win-x64.exe).Hash` on Windows, compared with its line in `SHA256SUMS.txt`.
  - Origin: `gh attestation verify <file> --repo rifqifitriady/ZAAFPulse` shows the workflow and commit that built it.
  - Releases published after immutable releases are switched on also pass `gh release verify v<v> --repo rifqifitriady/ZAAFPulse` and `gh release verify-asset v<v> <file> --repo rifqifitriady/ZAAFPulse`. The files and tag of such a release cannot be changed after publication.
  - Version tags are never moved. A fix ships as a new version.
- **Single-file executables check themselves** (releases after 1.0.3). Each binary carries the SHA-256 of every app file inside it. On every start it checks the unpacked copy in the cache folder against those hashes. A file that was changed, removed or added is restored from the binary before anything runs, and the binary stops with an error when that is not possible.

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
| `ZAAFPULSE_AUTH` | automatic | `1` (password), `local` (only this OS account, with `zaafpulse open`) or `none` |
| `ZAAFPULSE_ALLOW_PRIVATE_URLS` | | `1` lets RAG URL ingestion fetch private and intranet addresses |
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
