## What this changes

<!-- One or two sentences. Link the issue if there is one: "Closes #123". -->

## Why

<!-- The problem it solves. For a metric change, what was wrong about the old numbers. -->

## How I verified it

<!--
What you ran and what you saw. For UI changes, a screenshot from demo mode (npm run demo), never from real data.
For installer or service changes, the OS you tried it on.
-->

## Checklist

- [ ] `npm test` passes
- [ ] New behaviour has a test, and tests do not touch the real Keychain, `config.json`, `.data/` or the network
- [ ] No new npm dependencies
- [ ] No secrets, personal paths, real hostnames or real data in code, tests, logs or screenshots
- [ ] Secrets go through the secret store, never into `config.json`, logs, errors or command lines
- [ ] Works on macOS, Linux and Windows (paths built with `path.join`, OS specifics in `lib/platform.js`)
- [ ] For UI changes: checked in light and dark theme and at a narrow width; screenshot attached
- [ ] Docs updated if behaviour or options changed (README, docs/install.md, skills)
