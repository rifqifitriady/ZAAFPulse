# Security Policy

ZAAFPulse runs on your own machine or server. It has no cloud service, no accounts of ours and no telemetry. It does handle sensitive data:

- AI transcripts
- notes from your second brain
- provider and integration API keys
- the agent gateway that apps call with ZAAFPulse API keys

A vulnerability here can hurt a real person, so please report it privately.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/rifqifitriady/ZAAFPulse/security/advisories/new) on this repository (Security → Report a vulnerability). Please do not open a public issue, discussion or pull request for a security problem.

Please include:

- the version (`zaafpulse version`) and OS;
- whether it runs on 127.0.0.1 (the default) or in server mode;
- the steps to reproduce, and what an attacker gains.

What to expect:

- A first response within 7 days.
- An assessment and a plan within 14 days.
- A fix as fast as its severity calls for. We coordinate the disclosure date with you and credit you in the release notes, unless you prefer otherwise.

Please do not report findings from automated scanners without checking that they are real and reachable in ZAAFPulse.

## Supported versions

| Version | Supported |
|---|---|
| 1.x (latest release and `main`) | ✓ |
| older | ✗ |

## What is in scope

- Bypassing dashboard sign-in in server mode, session fixation or theft, getting around the sign-in lockout.
- Calling the gateway (`/v1`, `/mcp`, `/a2a`) without a valid API key, or beyond a key's scopes, models, agents, budget or rate limit.
- Secrets leaking in plain text, for example:
  - into `config.json`, logs, error messages, the dashboard, service files or process lists;
  - by weakening the encrypted secret file.
- Reading or writing files outside the data folder (path traversal), or making the server fetch internal addresses it should not (SSRF), for example through URL ingestion or provider URLs.
- Cross-site requests or DNS rebinding that reach the dashboard API from a web page.
- Prompt or tool-result injection that makes an agent or MCP tool reveal secrets or perform writes the user did not allow.
- Tampering with the installers or single-file builds, or checksum checks that can be bypassed.

## Out of scope

- Anything that needs an attacker to already control your user account or machine.
- Running ZAAFPulse in server mode on the open internet without TLS, against the guidance in [docs/install.md](docs/install.md).
- Model answers that are wrong or unsafe without crossing a security boundary (that is a quality issue; please open a normal issue).
- Rate limits of third-party providers, and issues in those providers' own services.

## Keeping your installation safe

- **Stay on 127.0.0.1** unless you need server mode. For server mode, use a strong admin password (`zaafpulse set-password`) and HTTPS (built-in TLS or a reverse proxy).
- **Give each app its own API key** with the narrowest scopes, allowed models and agents, and a monthly budget. Revoke keys you no longer use (Endpoint → API keys).
- **Never paste keys into `config.json`, issues or chats.** If a key leaks, revoke it at once and create a new one.
- **Keep ZAAFPulse current:** run the installer again, or download the latest release.
