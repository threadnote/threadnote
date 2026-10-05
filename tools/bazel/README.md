# Bun and Bazel compatibility gate

The normal contributor entrypoints are:

```sh
bun apps/website/tools/site-prepared-metadata.ts --output apps/website/.bazel-inputs/metadata.json
bun run bazel:generate
bun run bazel:check
bun run bazel:affected
bun run bazel -- test //packages/graph:test
```

These commands download the pinned tools when needed. Contributors and agents do
not install Bazel, Bun toolchains, or bazel-diff globally. Generated BUILD files
and `targets.json` must be regenerated rather than edited directly.

Prepare website metadata before generation or declaration checks, even for
non-website changes: the inventory includes the website build's declared input.
The metadata file is ignored by Git and absent in a fresh checkout.

Run the focused gate without installing Bazel globally:

```sh
bun tools/bazel/run.ts test //tools/bazel/spike:all
```

The bootstrap verifies Bazel 9.2.0 against release SHA-256 digests. Bzlmod fetches
Bun 1.4.2 with platform-specific SHA-256 pins. The initial supported hosts are macOS
and glibc Linux on arm64/x64; this gate does not replace release cross-compilation
or the existing Windows checks.

## Rule contract

`bun_library` declares `srcs`, `data`, and `deps`. Private workspace packages include
their `package.json` and exported source files in `srcs`. A consuming target names
the library in `deps`; the runner creates a stage-local package link, so ordinary
workspace imports and package exports work without paths back into the checkout.

`bun_test` executes pinned Bun with `runner_args`. Vitest targets pass `--bun`, the explicit
`node_modules/vitest/vitest.mjs` entrypoint, and their config and test paths. Tests
use Vitest 5 and the existing Effect integration, not Bun's test runner. Bazel
`--test_arg` is forwarded. `bun_action` uses the same inputs and executes a build
command; `{output}` expands to its declared `out_dir` tree artifact.

`bun_workspace_test` is reserved for repository-contract tests that inspect Git
objects and refs. It remains a Bazel target with exact declared inputs for impact
selection, but runs without caching from the checkout with `local` and
`no-sandbox` tags. The PostgreSQL suite remains staged and carries only the
`requires-network` execution tag so it can reach the CI service on localhost.
Website source, unit, typecheck, and build targets remain sandboxed.

The standalone distribution build is also local because its macOS output invokes
the host Xcode compiler. Its source and dependency inputs remain explicit, and
the ordinary TypeScript, website, package, and infrastructure actions stay
sandboxed.

Both rules copy declared inputs into an isolated staging tree. They do not inspect
Git, use checkout `node_modules`, execute package scripts, or escape through
`BUILD_WORKSPACE_DIRECTORY`. Environment values are declared in `env`; HOME,
temporary files, and Bun/Node executable lookup default to the stage. The runner
also exposes `/usr/bin` and `/bin` for integration tests that exercise host tools
such as Git. Build and test actions run sandboxed with network access disabled.
Fetching occurs only in the repository rule.

The npm repository installs the single root `bun.lock` with `--frozen-lockfile`,
`--ignore-scripts`, and an explicit hoisted linker. Add every workspace manifest
to `bun.install(workspace_manifests = [...])` in `MODULE.bazel`. Only manifests are
copied into the fetched repository; workspace source is supplied by library
targets. Missing required third-party dependencies fail the repository generation.

`@npm//:vitest`, `@npm//:@effect/vitest`, and other package labels expose that
package's installed transitive dependency closure, including available optional
platform packages and peers. Targets do not receive a repository-wide
`node_modules` input. Cycles are flattened deterministically. Source changes do
not trigger dependency installation; manifest/lock/toolchain changes do.

The explicit prepare step matches root `prepare`'s compiler contract:
`effect-tsgo patch --no-typescript --oxlint`. Husky and arbitrary lifecycle scripts
are excluded. The gate checks ordinary TypeScript, Effect diagnostics, and equality
of patched Oxlint/tsgolint native artifacts with their pinned Effect distributions.

## Gates

| Target                           | Contract                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `effect_sqlite_test`             | Bun-hosted Effect Vitest, scoped SQLite, workspace exports, unrelated graph inputs absent |
| `parser_native_test`             | Parser WASM loaded in a Bun worker; native resvg resolution and rendering                 |
| `typecheck_patch_test`           | TypeScript, Effect diagnostics, patched native Oxlint/tsgolint                            |
| `standalone` / `standalone_test` | Declared standalone compile output executes without npm inputs                            |
| `dependency_closure_test`        | Cycle regression and bounded property tests against independent reachability model        |

The fixtures exercise toolchain compatibility independently from the production
targets. The generated graph also owns the colocated Vitest inventory, native Go
telemetry tests, and build/check actions.

## Alternatives reviewed

[Aspect rules_js](https://github.com/aspect-build/rules_js) provides mature npm
dependency linking and workspace support but uses a pnpm-based installation
model. Adopting it directly would require choosing a different lockfile contract
or maintaining a generated translation; this gate preserves the sole Bun lock.

The current [rules_bun](https://github.com/tomato-bazel/rules_bun) Bun-native route
exposes the complete installed tree, accepts only one package manifest, and uses
`bun test`; its `bun_run` deliberately uses the live checkout. Its audited
[version table](https://github.com/tomato-bazel/rules_bun/blob/main/bun/private/known_versions.bzl)
pins 1.3.14 and the extension permits unverified other versions. Those contracts
do not satisfy Threadnote's per-target Vitest/Bun 1.4.2 requirements without an
adaptation. The small local rules keep this compatibility surface reviewable.

No paid Aspect service, remote cache, or managed workflow is required. The local
rules deliberately defer remote execution across platforms. Bazel caching is
separate from CI target selection.

## Production targets and selective CI

`target-specs.mjs` names the production entrypoints. `generate.mjs` follows static
TypeScript/JavaScript imports and explicit private-package exports, then emits
separate readable `BUILD.bazel` files and `targets.json`. Website source and data
directories are explicitly scoped to that app. Filesystem reads, generated inputs,
and package assets that are not imports must be declared in `data`, `dataRoots`,
or `npm`; the generator is not a proof of arbitrary dynamic JavaScript behavior.
Adding a target requires auditing those boundaries and executing it sandboxed.

Generated package declarations use `export_package_files` with package-local
top-level globs. This keeps source visibility automatic as files are added while
each `bun_test` and `bun_action` retains its exact, generated `srcs` closure. The
export globs grant visibility only; they are not broad target dependencies.

```sh
bun apps/website/tools/site-prepared-metadata.ts --output apps/website/.bazel-inputs/metadata.json
bun tools/bazel/generate.mjs
bun tools/bazel/generate.mjs --check
bun tools/bazel/run.ts test //apps/website:test //apps/website:typecheck
bun tools/bazel/run.ts build //apps/website:build
```

The website build consumes that ignored JSON as a declared input. Its Git-aware
producer runs before Bazel; build actions never inspect Git history. Git-backed
release producer tests remain in the website suite. Website tests exercise the
shared evidence package without depending on the graph runtime. Every package
test suite has a package-owned target. Application tests are split into the
ordinary suite, PostgreSQL integration, and the existing long-running groups.
Telemetry infrastructure also has native `rules_go` targets.

The `CI` workflow first checks generated declarations and computes base/head graph hashes with SHA-pinned
[bazel-diff 49.1.0](https://github.com/Tinder/bazel-diff/releases/tag/v49.1.0), and
then greedily balances executable targets across at most eight parallel Bazel
jobs. Each job runs one Bazel test target at a time so target-internal Vitest
workers do not compete with another test process. PostgreSQL tests share one service-enabled shard, which may also carry ordinary targets. Platform and evaluation jobs consume outputs from the
same authoritative plan and run alongside the Bazel shards. Selector regression validation runs alongside them instead of delaying matrix fanout. The selector uses a disposable detached baseline
worktree; the caller's checkout and HEAD are unchanged. Selection JSON and graph
hashes, plus the exact shard plan, are retained as workflow artifacts.

```sh
bun tools/ci/bazel-select.mjs --base origin/main
bun tools/ci/bazel-plan-shards.mjs
bun tools/ci/bazel-run-selected.mjs
bun tools/bazel/verify-selection.mjs
```

Missing baseline graphs, invalid diff output, unmapped changed paths, and tooling
failures select every target. Both baseline and head ownership inventories
participate, so deleted and renamed files remain recognized. Generated BUILD files
and the inventory are accepted only after source-closure verification. Build-rule,
toolchain, manifest, lockfile, and other unmodeled changes conservatively broaden
selection. A new source file under a declared website source directory changes
only its package's declarations; no shared generated `.bzl` couples graph targets
to those additions.

`verify-selection.mjs` uses the real Bazel/bazel-diff executables against a tiny
isolated graph. It checks edits, additions, renames, deletions, new dependency
edges, and a website tsconfig-only change using the production target declarations.
It also runs the website target with empty action cache and verifies that no
graph test is selected. Bounded property tests independently check import-closure
reachability and selection determinism/monotonicity.

No remote cache is configured. If one is introduced later, restrict writes to
trusted CI, give untrusted pull requests read-only access or no access, and measure
the benefit before making it part of the required workflow.

## Benchmark orchestration boundary

`//:platform_benchmark_preflight` is a correctness target, not a performance
capture. It declares the Platform benchmark workflow, harness, provenance,
failure, sampler, and recall-runner contracts and runs their deterministic tests.
The Platform benchmarks workflow executes this target as an independent job.
Scheduled and manual benchmark runs own that job; pull requests execute the
target once through affected-target Bazel CI.

Measured jobs remain direct Bun commands on their selected GitHub-hosted runner.
They do not depend on the Bazel preflight and must not be moved behind
`bazel test` or a cached/sandboxed Bazel action without a focused experiment that
proves cold/warm measurement parity. Bazel staging, HOME/TMPDIR isolation,
caching, and process-launch overhead are valid for correctness tests but are not
part of the benchmark measurement environment.
