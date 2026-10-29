# Contributing to Threadnote

Thank you for improving Threadnote. Contributions to the CLI, MCP server, web manager, documentation, tests, and agent
workflows are welcome.

For a small fix, opening a focused pull request is usually enough. For a broad feature, behavior change, or migration,
open an issue first so the intended contract can be agreed before substantial implementation work begins.

## Development setup

You need:

- The exact Bun version pinned by the `packageManager` field in [`package.json`](./package.json).

Install dependencies and run the repository contract checks:

```bash
bun install --frozen-lockfile
bun run check:repo
```

`check:repo` prepares ignored Bazel declarations and website metadata, verifies
generated semantics and byte-stable regeneration, analyzes every target, runs the
Bazel/tooling contract tests, and applies workspace, lint, formatting, and type
checks. Fresh checkouts need no generated files committed to Git. Run the
narrowest Vitest or Bazel test target for the behavior you change.
The pull request runs the complete affected suite and platform matrix.

Run the source CLI or MCP server during development with:

```bash
bun run dev -- --help
bun run dev:mcp-server
```

Do not commit credentials, API keys, private memories, customer data, raw production logs, or a local Threadnote home.
Test fixtures must use synthetic data.

## Architecture expectations

Threadnote uses Effect 4 beta for infrastructure and orchestration. Preserve the capability, lifecycle, and runtime
boundaries below when changing the CLI, lifecycle, manager, MCP, command execution, HTTP, retry, or AI code.

Keep these invariants intact:

- The application constructs one Effect, provides the application layer once, and runs it once in `apps/threadnote/src/standalone.ts`.
  The signal-transparent diagnostics worker is a mutually exclusive root execution path, not a nested runtime.
- Independent build, benchmark, and evaluation scripts are separate executables and may run one top-level Effect. Their
  workflows still compose Effects internally and must not start a nested runtime.
- Library workflows return and compose Effects. Do not introduce internal `runSync`, `runPromise`, `runFork`,
  `runCallback`, `ManagedRuntime.make`, or repeated runtime boundaries.
- Expected failures belong in typed Effect error channels. Use defects for truly unexpected programmer errors.
- Use the shared `fromPromise`/`fromSync` adapters in `apps/threadnote/src/effect/errors.ts` for compatibility helpers; do not add
  module-local Promise-lifting helpers or a generic Promise bridge in the CLI.
- Use Effect's `Console` service for application output. Promise compatibility code must use the scoped adapter in
  `apps/threadnote/src/effect/console.ts`; raw `console.*` calls are rejected by the architecture tests.
- Use `Scope` or `acquireRelease` for servers, temporary directories, child processes, and other resources that require
  cleanup.
- MCP inputs use Effect Schema as the source for types, runtime validation, descriptions, and emitted JSON Schema.
- Pure transformations and React state may remain plain TypeScript when Effect would not improve composition or error
  handling.
- The release entrypoint is ESM and compiles to a bytecode-enabled standalone executable with the pinned Bun runtime.
- Use Effect's Bun platform services for filesystem, path, command, HTTP, terminal, server, socket, and SQLite access.
  Application and build-script code must not import `node:*` modules.
- Keep `effect`, `@effect/platform-bun`, `@effect/sql-sqlite-bun`, `@effect/vitest`, and
  `@effect/ai-openai-compat` pinned to the same exact beta.
- Effectful tests use `it.effect` and its property variants from `@effect/vitest`; `it.effect` already scopes each
  test. When an example explicitly needs a nested sub-scope, use `Effect.scoped` inside the returned Effect. Do not
  convert an Effect to a Promise or run it synchronously inside a Vitest callback.

Threadnote intentionally uses `effect/unstable/*`. API instability is acceptable, but an upgrade must update its
adapters and compatibility tests together.

## Tests and validation

Add or update the narrowest test that protects the behavior you changed. Unit tests cover pure logic and Effect
services; integration tests cover CLI, MCP, manager, lifecycle, and protocol boundaries.

Before opening a pull request, run:

```bash
bun run lint
bun run format:check
bun run typecheck
# Run only the focused Vitest or Bazel targets covering the change.
```

`typecheck` uses the pinned Bun runtime’s built-in checker for production, test, and website configurations.
`format:check` and `format:write` use `bun fmt` with the existing Prettier-compatible configuration and ignore file.
Effect diagnostics remain enforced by the patched Oxlint tools.

The six newly adopted Effect rules (`map-map-error-to-map-both`, `prefer-effect-array`, `prefer-effect-record`,
`prefer-effect-string`, `prefer-schema-tagged-error`, and `schema-class-missing-brand`) are errors in both lint configs.
The repository gate enforces them, plus unsafe type assertions, on added or modified TypeScript lines against the target
branch. Untracked files are entirely new. Editors show existing violations; their migration is separate work. All other
rules retain full-repository enforcement, including rejection of warnings. Fetch the target branch before running lint.

### Bazel CI selection

Pull-request CI computes the affected Bazel graph from the complete base/head diff. Colocated package tests are selected through their source closures, so `apps/website` changes do not run `packages/graph` tests. Shared dependency changes select all dependent checks. The Threadnote application suite is automatically grouped by feature with bounded target sizes and inferred repository inputs; `//apps/threadnote:test` expands to every generated group when a contributor explicitly runs the aggregate. Adding a normal test does not require editing Bazel metadata. Missing baselines, unrecognized inputs, or failed base/hash analysis select the complete valid head inventory. Invalid head preparation fails the planner.

The same inventory selects Actionlint, recall quality, Windows smoke, and release matrices. Selection and shard artifacts include generation fingerprints; workers reject mismatched head, source, or inventory. `tools/ci/bazel-select.mjs` writes the selection artifact and `tools/ci/bazel-run-selected.mjs` executes the Bun, Vitest, build, and native Go targets. The planner releases the matrix before the slower selector regression validation finishes, and the aggregate check requires both. Each of the eight CI runners executes one Bazel test target at a time so Vitest owns that runner's parallelism instead of competing with another test process. Selection determinism, monotonicity, generated grouping, inferred inputs, file additions, deletions, renames, and dependency-edge changes are covered by focused property and real Bazel tests.

Use the checked-in command aliases instead of installing Bazel or bazel-diff globally:

```bash
# Explicitly prepare or repair ignored BUILD files, inventory, and website metadata.
bun run bazel:generate

# Preview the targets and platform lanes affected relative to origin/main.
bun run bazel:affected

# Run one focused target. The `--` passes the Bazel command through Bun.
bun run bazel -- test //packages/graph:test
```

The supported wrapper and selection commands prepare a fresh checkout
automatically. Before invoking raw pinned Bazel directly, run
`bun run bazel:generate`. Direct `bun tools/bazel/generate.mjs --check` only
verifies existing output; it does not repair it.

Generated root, app, and package `BUILD.bazel` files and
`tools/bazel/targets.json` are ignored local artifacts. Do not edit or commit them.
Edit source, manifests, `tools/bazel/target-specs.mjs`, or shared rules and
regenerate. Handwritten resource, infrastructure, tooling, and training BUILD
files remain tracked. A branch based on a commit without the Bazel graph
will conservatively preview every target; after the migration lands, ordinary
base/head comparisons are selective.

### Local distribution end-to-end tests

Run the local-bin suite when a change affects any of the following:

- installation, CLI arguments, URI semantics, or datastore behavior;
- Threadnote CLI launchers or argument parsing;
- MCP schemas, forwarding, or native parity;
- manager APIs, shutdown, or Effect AI consolidation;
- sharing, memory lifecycle, pack import/export, packaging, or generated distribution bundles;
- Effect runtime, resource, interruption, or error-boundary behavior.

```bash
bun run test:e2e:local-bins
```

The suite uses a temporary Threadnote home, exercises the built standalone launchers, native SQLite and vector
indexes, the local model runtime, MCP stdio, and sharing, then removes the home. It must never use or mutate a
contributor's normal `~/.threadnote` state.

### Exact-HEAD global developer runtime

Before a long local benchmark or testing a host integration that launches the global `threadnote` command, install the
clean checked-out commit into the managed standalone location:

```bash
bun run dev:install-global -- --terminate-superseded --json
```

The installer refuses a dirty worktree, embeds the full source commit in a local-only version, validates the staged
executable and provenance receipt before atomic activation, and only terminates superseded processes whose start
identity still matches their lease. Long local benchmarks require this exact-HEAD receipt; do not rely on whichever
beta a launcher or editor process happened to start earlier. The exported fail-closed
`verifyManagedDevelopmentRuntimeForSource` verifier is the preflight for long benchmark harnesses; it returns the
sanitized version, source commit, executable digest, target, and runtime evidence without recording local paths.

The installer also records an opaque SHA-256 identity for the source checkout that owns the active global development
runtime. A different worktree must not silently replace it. After confirming its task has finished, transfer ownership
explicitly with `bun run dev:install-global -- --take-over-global-runtime`; the stored record never contains the local
checkout path.

## Changing MCP tools

Keep tool names and the default core toolset compact and backward-compatible. When adding or changing an input:

- define it with Effect Schema through the MCP adapter;
- preserve documented aliases when removing them would break existing agents;
- test emitted JSON Schema and runtime rejection;
- test the built native MCP server over stdio when the parameter affects runtime behavior;
- consider the context cost before adding a tool to the focused core surface.

## Documentation and generated output

Update documentation in the same pull request as behavior. Keep `README.md` concise and put architectural or
operational detail under `docs/`.

`dist/` is generated by `bun run build`; do not hand-edit it. Always run the build and release
checks when changing entrypoints, dependencies, manager UI code, or build scripts.

The public React website is developed separately with `bun run site:dev` and validated with
`bun run site:check && bun run site:build`. Its source lives under `apps/website/`, its ignored output is `site-dist/`, and
neither is part of a standalone release. See [`docs/website.md`](./docs/website.md).

## Pull requests

A pull request should explain:

- the problem and intended behavior;
- important design choices or compatibility constraints;
- tests and manual checks performed;
- migration, security, packaging, or documentation impact;
- any known limitation or follow-up work.

Keep unrelated refactors out of a focused fix. Preserve user changes already present in the worktree, and do not commit
generated local state or secrets.

By submitting a contribution, you agree that it is licensed under the repository's
[AGPL-3.0-or-later license](./LICENSE).
