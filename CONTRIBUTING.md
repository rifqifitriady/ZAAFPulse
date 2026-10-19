# Contributing to ZAAFPulse

Thanks for taking the time. ZAAFPulse reads some of the most private data on a machine: AI transcripts, notes, API keys. So a change has to do more than work. It also has to keep that data where it belongs.

You do not need to get everything below right, and it is fine if this is your first contribution. Say so in the pull request and we will help.

## Before you start

- **Something small and obvious** (a typo, a broken link, a clear bug): send the pull request. No issue needed.
- **A new page, connector, provider, agent, workflow, or anything touching the gateway, secrets or sign-in**: open an issue first and describe the approach. It takes a few minutes and saves you from rewriting something later.
- **An existing issue**: comment on it so two people do not build the same thing. You can start before anyone replies.
- **A security problem**: do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Getting set up

You need Node.js 18 or newer and nothing else. ZAAFPulse has no npm dependencies.

Fork the repository, then:

```bash
git clone https://github.com/YOUR-USERNAME/ZAAFPulse.git
cd ZAAFPulse
git remote add upstream https://github.com/rifqifitriady/ZAAFPulse.git
git checkout -b your-branch-name
npm run demo        # synthetic data on http://localhost:4778, safe for screenshots
npm start           # your own logs on http://localhost:4777
```

| Command | What it does |
|---|---|
| `npm start` | Run with your real data |
| `npm run demo` | Run with seeded synthetic data and an offline scripted model; it never reads your logs, Keychain or config |
| `npm test` | Run the whole suite with `node:test` |
| `npm run media` | Regenerate the README screenshots and GIFs from demo data (needs Chrome and ffmpeg) |
| `node bin/zaafpulse.js doctor` | Check the OS, Node.js, data folder, secret store and service |
| `node scripts/build-single.js` | Build a single-file executable for this machine into `dist/` |

## How the project is laid out

```text
server.js            HTTP server, dashboard API, server mode (sign-in, TLS)
mcp.js               stdio MCP server that AI clients start
bin/zaafpulse.js     the zaafpulse command
lib/                 readers (claude.js, codex.js, processes.js), aggregation, quality signals,
                     platform.js, secret-store.js, auth.js, service.js, connectors
lib/gateway/         Agent Gateway: keys, providers and router, translation, agents, orchestrator,
                     collaboration, workflows, RAG, A2A, code tools, skills
lib/brain/           second-brain sources and graphs
public/              the dashboard: plain HTML, CSS and browser JavaScript, no build step
skills/              Agent Skills (SKILL.md) served at /skills
test/                node:test suites
docs/                install guide, integrations, README media
```

## The rules that matter most

1. **Data stays on the machine.** Nothing is sent anywhere except to providers, sources and integrations the user configured. Request logs keep counts and timings, never prompt or note text. No telemetry and no analytics.
2. **Secrets never touch disk in plain text.** `config.json` holds references only (`{ "keychain": … }` or `{ "env": … }`), and values go through `lib/secret-store.js`. Never log a secret, put it in an error message (use `secrets.mask`), pass it on a command line, or write it into a service file.
3. **No dependencies.** Use Node's standard library and the browser's APIs. If you think a package is truly needed, open an issue first.
4. **The numbers have to be true.** Usage, cost and quality figures come from what the logs actually say. A metric that only looks plausible is a bug.
5. **Safe by default.** The server listens on 127.0.0.1. Anything reachable from the network requires sign-in or an API key. A change that writes to a user's files (coding-tool configs, MCP client configs, skills) needs an explicit click or command, plus a backup or revert.

## Code style

- Write code that reads like the code around it: plain CommonJS, small functions, the same naming and comment density.
- Comments explain *why*, or what a non-obvious piece of logic is for. They should not narrate the code line by line.
- UI text is short, plain and specific. Say "API key", not "credential artifact".
- Keep it cross-platform. ZAAFPulse runs on macOS, Linux and Windows:
  - Build paths with `path.join`, never with `/`.
  - Put OS differences in `lib/platform.js`, `lib/secret-store.js` or `lib/service.js`.
  - Spawn processes with argument arrays, not shell strings.

## Tests

- Every change that adds behaviour adds or updates a test in `test/`.
- Tests must not touch the real Keychain, `config.json`, `.data/` or the network. Use temporary folders, `test/helpers.js` and the fake servers in it.
- CI runs the platform tests on macOS, Ubuntu and Windows. A change that depends on path separators or the shell will show up there.

```bash
npm test
```

## Screenshots and demo data

- Screenshots and GIFs come only from demo mode (`npm run media`). Never commit a screenshot of real data.
- Demo data lives in `lib/demo.js` and `lib/demo-gateway.js` and must stay fictional: no real people, customers, hosts or keys.

## Pull requests

- Keep each one focused on a single change. Explain what changed, why, and how you tested it.
- Run `npm test`, and for UI changes look at the page in light and dark themes and at a narrow width.
- Check your diff for secrets, personal paths and real hostnames before pushing.
- Commits are merged with a merge commit; you do not need to squash.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE) and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
