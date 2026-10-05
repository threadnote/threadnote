# Threadnote development instructions

Threadnote must dogfood itself. Every agent doing non-trivial work in this repository must use the current Threadnote
installation as part of the task instead of treating Threadnote only as code being edited. Repository files and the
nearest checked-in guidance remain authoritative.

## Monorepo contributor path

- Read `docs/monorepo.md` before placing new production code or tests. Product
  composition belongs in `apps/threadnote`, website work in `apps/website`, and
  reusable capabilities in the owning private package.
- Colocate package tests under that package's `test/` directory. Keep only
  cross-domain application tests under `apps/threadnote/test`.
- Never hand-edit generated `BUILD.bazel` files or `tools/bazel/targets.json`.
  Change source, manifests, or `tools/bazel/target-specs.mjs`, then run
  `bun run bazel:generate`.
- Before Bazel generation or repository checks, prepare website metadata with
  `bun apps/website/tools/site-prepared-metadata.ts --output apps/website/.bazel-inputs/metadata.json`.
  This ignored input is required even for non-website changes because generation
  validates every target's declared data.
- Run `bun run check:repo` for repository contracts and use
  `bun run bazel -- test <label>` for the narrowest affected target. Use
  `bun run bazel:affected` to inspect the base/head selection before a pull
  request.

## Dogfood Threadnote on every task

- At the start, call `recall_context` with `project: threadnote` and the absolute `callerCwd`, then read the relevant
  `threadnote://` records it returns.
- Use Threadnote's own `inspect_code_graph` for focused current-source relationships and `analyze_code_graph` for
  repository-wide structure when those tools are relevant. Use exact text or path search for literals and verification.
- Graph-first applies to unfamiliar local source and relationship claims. State an explicit bounded skip for an
  already-known exact path or symbol, a remote review without a checkout, or purely visual/binary evidence Threadnote
  cannot interpret; use the graph if scope expands. Treat package-local absence as a hint, and named workset results as
  per-repository evidence from existing ready snapshots rather than proof or implicit cold indexing.
- Store reusable decisions and contracts as durable memory. Store current status, checks, blockers, and next steps as a
  handoff before pausing or ending meaningful work.
- Publish reviewed durable feature memory to the default team during closeout without a separate approval request.
  Never publish handoffs or preferences.
- Use stable project/topic identities and update an existing memory with `replaceUri`; do not create timestamped
  duplicates. Never store secrets, credentials, customer data, or raw production logs.
- Prefer the Threadnote MCP tools. If they are unavailable, use the `threadnote` CLI as the fallback and treat the
  unavailability as a dogfooding issue: file a privacy-safe GitHub issue rather than a Threadnote issue ledger.

## Use Effect-aware test tooling

When writing Effect code, inspect `@repos/effect/` when that reference checkout is available for examples of idiomatic
usage, tests, module structure, and API design. If it is absent, use the installed `effect` and `@effect/vitest` package
sources and `@effect/vitest/ai-docs`, together with existing tests in the owning package, as the Effect reference.

Threadnote application and runtime behavior is predominantly Effect code. Tests whose primary program under test is an
`Effect` must use the Effect Vitest integration from `@effect/vitest` rather than wrapping the program with
`Effect.runPromise`, `runEffect`, or another Promise bridge inside a plain async Vitest test.

- Import `it as effectIt` from `@effect/vitest` and use `effectIt.effect` for Effect examples; it already scopes
  the test. When an example explicitly needs a nested sub-scope, use `Effect.scoped` inside the returned Effect,
  and use `effectIt.effect.prop` for Effect properties.
- Provide the narrow test layer explicitly. Use `ApplicationLayer` only for integration behavior that genuinely needs
  the application service graph; prefer focused service layers for unit tests.
- Keep setup, synchronization, assertions, and cleanup inside the returned Effect. Use `Effect.acquireUseRelease`,
  `Effect.ensuring`, `Scope`, `Deferred`, and Effect interruption instead of Promise `try/finally` or manually running
  nested Effects.
- Effect tests use the test clock. Apply `TestClock.withLive` only when exercising real processes, SQLite leases,
  wall-clock deadlines, or other behavior that deliberately needs live time; otherwise advance `TestClock`
  deterministically.
- Plain `it`/`test` and explicit Promise execution remain appropriate when the contract being tested is itself a
  Promise/Node callback boundary, operating-system child process, external CLI protocol, or non-Effect code. Do not
  convert those tests merely for uniform syntax.
- When touching an existing plain async test that principally calls `runEffect(Effect...)`, convert that test to the
  Effect Vitest integration as part of the change unless a boundary exception above applies.

## Seek property-based testing opportunities

During development, always assess whether changed behavior has general properties that example tests alone would
underspecify. Look especially for round trips, idempotence, determinism, ordering, monotonicity, parser and serializer
boundaries, state-machine transitions, incremental-versus-clean equivalence, and non-mutation guarantees.

- When a meaningful property exists, add a bounded Fast-check property to the normal Vitest suite. Prefer generators
  that shrink well and assertions against an independent model or invariant rather than reimplementing production code.
- Keep focused example-based regression tests for important concrete failures, even when a property test also covers the
  broader contract.
- Do not force property tests onto static copy, one-off wiring, or behavior with no useful input space or invariant.
  Close out the task by stating which property-testing opportunity was added, or why none was appropriate.

## Let pull-request CI run the full suite

Do not run the complete test suite locally. Run focused tests and checks that cover the changed behavior, then open the
pull request and use CI as the authoritative full-suite run. Investigate and fix any CI failure before merge.

## Install logic changes globally

After changing runtime or product logic, do not stop after tests. This includes behavior under `apps/` or `packages/`, runtime-facing
scripts, installer/updater behavior, MCP behavior, storage, indexing, plugin lifecycle, and release payload logic.

1. Run the checks appropriate to the change.
2. Commit the intended change and make the worktree clean; the development installer deliberately refuses dirty or
   non-HEAD source.
3. Run `bun run dev:install-global` from this checkout. It builds, installs, activates, and doctor-verifies the exact
   HEAD as the global development Threadnote binary.
4. Exercise the affected flow through the globally installed `threadnote` command and record the smoke result in the
   task handoff.

The development installer records an opaque checkout identity and refuses to replace a global development runtime
owned by another worktree. When another agent holds it, resolve the owning worktree to that agent's active thread and
ask the agent explicitly whether you may take over the global installation. Do not bypass the guard until the owning
agent confirms release; if the thread cannot be found or reached, ask the user to coordinate. After that confirmation,
an intentional handoff can use `bun run dev:install-global -- --take-over-global-runtime`.

This development machine has a single Threadnote user. After installing exact HEAD, terminate any superseded
Threadnote processes with `bun run dev:install-global -- --terminate-superseded`; no separate process-owner approval is
needed. This does not relax the active-worktree ownership guard above.

Documentation-only and test-only changes do not require a global binary reinstall unless they alter a packaged runtime
contract or expose a suspected runtime problem.

## Contributor workflow skills

Checked-in project skills live in `.cursor/skills/`. Use them for exact-HEAD global install, patch-release preparation,
focused testing, and dogfood closeout instead of re-deriving this file or `docs/releasing.md`. Product skills shipped to
users stay in `config/agent-skills/`.

Use `.cursor/skills/release-signoff/SKILL.md` for prerelease manual E2E signoff. It owns low-cost worker orchestration
and reporting; `docs/prerelease-manual-e2e-dogfood-matrix.md` owns test scenarios and expected results.

## Never ignore dogfooding issues

Any unexpected behavior encountered while using Threadnote itself is product evidence, not disposable tooling noise.
Do not silently bypass it or omit it from closeout.

- Reproduce it with the smallest safe case, investigate the responsible code or state, and fix it when it is in scope.
  If it cannot be fixed in the current task, record the blocker and the safest bounded workaround in the task handoff
  and in a privacy-safe GitHub issue.
- GitHub issues are the source of truth for product and dogfood defects. Do not maintain a Threadnote
  `topic: dogfood-issues` ledger. The previous durable ledger is archived.
- Keep issue evidence privacy-safe and bounded: affected commit/version, symptom, minimal reproduction, expected versus
  actual behavior, diagnosis, workaround if any, and verification. Do not paste secrets, credentials, customer data, or
  raw production logs.
- If Threadnote returns an error, also prepare a privacy-safe `threadnote report-issue` preview after investigation.
  Create a public GitHub issue only with explicit user approval.
