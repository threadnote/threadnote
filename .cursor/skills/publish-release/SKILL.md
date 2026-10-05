---
name: publish-release
description: Prepare a Threadnote stable or beta release (version bump, curated notes, PR, then tag after merge). Use when cutting a release, writing .github/release-notes, running release:prepare, or publishing a standalone release.
---

# Publish a release

Authority: `docs/releasing.md`. This skill is the mechanical path only.

Local heavy-tail attestation is optional and is not a publication gate for stable or beta releases. Do not wait for
workstation capacity or three local samples before tagging. Required CI, functional dogfood, signing, and immutable
publication gates remain unchanged.

## Execution agent

Delegate patch-release preparation and post-merge publication to one `gpt-5.6-terra` agent with `low` reasoning effort. Keep `docs/releasing.md` authoritative: the agent must satisfy every applicable gate and stop on a failed or missing prerequisite rather than treating this delegation as permission to bypass it.

## Prepare (this PR)

1. Write `.github/release-notes/vX.Y.Z.md` first. Start with `## What's new`, then one user-visible opening sentence (social-card headline ≤ 240 characters after the `Threadnote X.Y.Z` prefix). No validation/checks section. Follow `v4.6.4`–`v4.6.6`.
2. Dry-run, then apply:

```sh
bun run release:prepare -- --patch --dry-run --json
bun run release:prepare -- --version X.Y.Z --json
```

`--patch` increments the checked-in `package.json` patch. The script refuses missing/invalid notes and does not commit,
push, merge, or tag.

3. Commit notes + `package.json` on the release PR. Let CI run the full suite.

## Numbered beta

Any canonical safe-integer base version can have a numbered beta: `X.Y.Z-beta.N` with `N >= 1`. Write its matching
notes first, then run:

```sh
bun run release:prepare -- --version X.Y.Z-beta.N --dry-run --json
bun run release:prepare -- --version X.Y.Z-beta.N --json
```

Merge through protected `main`. Immediately before tagging, confirm the reviewed commit is present on current
`origin/main`, then push `vX.Y.Z-beta.N`. The publisher rechecks protected-main provenance and the immutable remote tag
immediately before release creation, and marks the GitHub Release as a prerelease. Never use a beta tag for a stable release.

## After merge

Tagging happens **after** the release commit is on protected main, not from the PR branch:

1. Confirm HEAD is that exact reviewed commit and matches `package.json` + `vX.Y.Z.md`.
2. `git tag vX.Y.Z` and push the tag immediately. Do not land another main commit in between.
3. Do not create the GitHub Release by hand. Wait for `Publish standalone release`.
4. If tagging cannot finish promptly, stop the release window rather than continuing main work under unreleased stable wording.

## Do not

- Skip hooks, force-push, or move a `v*` tag.
- Treat Context Brief / Memory Connections / code-memory-link scale jobs as optional when those surfaces changed; `docs/releasing.md` lists the gates.
- Mention contributor-only skills in user-facing notes unless the website needs a line.

---
