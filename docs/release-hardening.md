# Release hardening: tag rules and immutable releases

Two repository settings make a published release permanent. **Both were switched on on 2026-10-20** with the commands below, run once from a shell where `gh` is signed in with admin rights on `rifqifitriady/ZAAFPulse` (the `repo` scope is enough). They are kept here so the settings can be checked, recreated or undone.

Applied on 2026-10-20 and checked right after:

| Setting | Check | Result |
|---|---|---|
| Tag ruleset "Release tags are permanent" (id 25452193) | `gh api repos/rifqifitriady/ZAAFPulse/rulesets/25452193 --jq '{target, enforcement, include: .conditions.ref_name.include, rules: [.rules[].type], bypass: .bypass_actors}'` | `{"bypass":[],"enforcement":"active","include":["refs/tags/v*"],"rules":["update","deletion","non_fast_forward"],"target":"tag"}` |
| Immutable releases | `gh api repos/rifqifitriady/ZAAFPulse/immutable-releases` | `{"enabled":true,"enforced_by_owner":false}` |

Releases v1.0.0 to v1.0.3 were published before the switch and stay `immutable: false`.

Why this matters: the `v1.0.3` tag was moved after the release was published (from `1306279` to `f2b198d`). Anyone who checked out the tag before the move got different code than people who checked it out after, and nothing in GitHub stopped it. The release workflow now refuses to create tags (`gh release create --verify-tag`). The two settings below stop the remaining cases: a person or a token moving or deleting a tag, and release files being swapped after publication.

## State on 2026-10-20 before the change (read-only checks)

| Check | Command | Result |
|---|---|---|
| Repository | `gh api repos/rifqifitriady/ZAAFPulse --jq '{visibility, owner: .owner.type}'` | public, owned by a user |
| Rulesets | `gh api repos/rifqifitriady/ZAAFPulse/rulesets` | `[]` (none) |
| Immutable releases | `gh api repos/rifqifitriady/ZAAFPulse/immutable-releases` | `{"enabled":false,"enforced_by_owner":false}` |
| Existing releases | `gh api repos/rifqifitriady/ZAAFPulse/releases --jq '.[] \| {tag_name, immutable}'` | v1.0.0 to v1.0.3, all `immutable: false` |
| v1.0.3 tag | `gh api repos/rifqifitriady/ZAAFPulse/git/ref/tags/v1.0.3 --jq .object.sha` | `f2b198da4ee974ed18e11265c42c4388aa5da741` |

The two endpoints used below are in GitHub's published REST description ([github/rest-api-description](https://github.com/github/rest-api-description)): `POST /repos/{owner}/{repo}/rulesets` accepts `target: "tag"`, and `/repos/{owner}/{repo}/immutable-releases` has `GET` (check), `PUT` (enable, `204`) and `DELETE` (disable, `204`). Both need admin access to the repository.

## 1. Tag ruleset: `v*` tags can be created but never moved or deleted

```bash
gh api --method POST repos/rifqifitriady/ZAAFPulse/rulesets --input - <<'EOF'
{
  "name": "Release tags are permanent",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": { "include": ["refs/tags/v*"], "exclude": [] }
  },
  "rules": [
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
EOF
# HTTP 201, prints the new ruleset; note its "id"
```

- There is no `creation` rule, so pushing a new `v*` tag still works and starts the release workflow.
- `bypass_actors` is empty on purpose: the owner cannot move a tag either. To fix a bad tag, ship the next patch version (CONTRIBUTING.md, "Releases").
- The rule also covers the existing tags `v1.0.0` to `v1.0.3`.

Verify:

```bash
gh api repos/rifqifitriady/ZAAFPulse/rulesets \
  --jq '.[] | select(.target == "tag") | {id, name, enforcement}'
# expected: {"enforcement":"active","id":<ID>,"name":"Release tags are permanent"}

gh api repos/rifqifitriady/ZAAFPulse/rulesets/<ID> \
  --jq '{target, enforcement, include: .conditions.ref_name.include, rules: [.rules[].type], bypass: .bypass_actors}'
# expected: {"bypass":[],"enforcement":"active","include":["refs/tags/v*"],"rules":["update","deletion","non_fast_forward"],"target":"tag"}
```

Do not test the rule by pushing a test tag that matches `v*`. Once the rule is active, such a tag cannot be deleted again.

## 2. Immutable releases: files and tag lock when a release is published

```bash
gh api --method PUT repos/rifqifitriady/ZAAFPulse/immutable-releases
# HTTP 204, no output
```

Verify:

```bash
gh api repos/rifqifitriady/ZAAFPulse/immutable-releases
# expected: {"enabled":true,"enforced_by_owner":false}
```

What changes:

- The setting applies only to releases published from now on. v1.0.0 to v1.0.3 stay mutable, but the ruleset above still protects their tags.
- Once a release is published, its files cannot be replaced or deleted. Its tag cannot be moved or deleted while the release exists, and its tag name can never be used again.
- The title and release notes can still be edited.
- GitHub adds a release attestation.
- The release workflow is already compatible. `gh release create` with files creates a draft, uploads every file and only then publishes, so the release is complete before it locks. This is what GitHub recommends, and the code is in `cli/cli` `pkg/cmd/release/create/create.go`.

After the next release (replace `vX.Y.Z`), check:

```bash
gh api repos/rifqifitriady/ZAAFPulse/releases/tags/vX.Y.Z --jq '{tag_name, immutable}'
# expected: {"immutable":true,"tag_name":"vX.Y.Z"}
gh release verify vX.Y.Z --repo rifqifitriady/ZAAFPulse
gh release verify-asset vX.Y.Z zaafpulse-X.Y.Z-linux-x64 --repo rifqifitriady/ZAAFPulse
```

## Undo (only if something has to be reverted)

```bash
gh api --method DELETE repos/rifqifitriady/ZAAFPulse/rulesets/<ID>
gh api --method DELETE repos/rifqifitriady/ZAAFPulse/immutable-releases
```

Turning immutable releases off does not unlock releases that were already published as immutable.

## Local clones

A clone fetched before the tag moved still has `v1.0.3` at `1306279`. To align it with GitHub, run `git fetch origin --tags --force`. Once the ruleset is active, a push of the old tag is rejected anyway.
