# Troubleshooting

## The executable does not start

Threadnote releases are standalone executables with an embedded Bun runtime; users do not need Bun, Node, npm, or
Python installed. Verify the immutable release and archive checksum, then run `threadnote doctor --dry-run`. On macOS,
`codesign --verify --strict --verbose=2 "$(command -v threadnote)"` checks the Developer ID signature. Threadnote 4.6
Windows builds are unsigned, so Windows may display a SmartScreen warning; the PowerShell installer instead verifies
the immutable GitHub release and its SHA-256 checksum before activation.

In Codex CLI's `workspace-write` sandbox, `threadnote --version` can run without modifying the installation. Other
commands pin their version with a process lease in the installation root. If the sandbox denies that write, Threadnote
reports the root instead of exiting silently. For a controlled CLI run, include that root as a writable directory with
`codex exec --sandbox workspace-write --add-dir "$HOME/.local/share/threadnote"`; substitute `THREADNOTE_INSTALL_ROOT`
when the installation uses a custom root. The Threadnote MCP integration is the normal path for agent context work.

If an older npm-based Threadnote command shadows the standalone launcher, compare every result from
`command -v -a threadnote` on POSIX or `Get-Command threadnote -All` in PowerShell. The standalone installer removes
verified npm-distributed Threadnote installations automatically, including early Node-based 4.0 betas. If it warns
that a package manager could not remove one, run the exact printed uninstall command and rerun the installer. Threadnote
does not remove unverified third-party files. Threadnote 3 cannot install v4 through `threadnote update`; a fresh
standalone install is the supported upgrade path.

The bootstrap defaults to stable-only selection. Pass the beta flag to select the newest immutable release across both
stable and prerelease builds; this can install stable when it is newer than every prerelease:

```sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh -s -- --beta
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.ps1))) -Beta
```

A prerelease installation follows this inclusive beta channel for ordinary updates. After it graduates to stable,
unflagged updates infer stable-only selection again; use `threadnote update --beta` to explicitly re-enter preview
selection.

The PowerShell installer supports the official unsigned Windows x64 and arm64 archives published with Threadnote 4.6.

## GitHub update checks return HTTP 403

GitHub's unauthenticated REST API limit is shared by all processes using the same public IP. On older Threadnote
builds, an open Manager page can query the releases API every three seconds and exhaust that limit. Close the Manager
page until upgrading; newer builds use a local heartbeat instead.

For official release checks, Threadnote uses `GH_TOKEN`, then `GITHUB_TOKEN`, or the active `github.com` identity from
`gh auth token` when available. Check the identity without printing the token with
`gh auth status --active --hostname github.com`; run `gh auth login --hostname github.com` if needed. Without a GitHub
identity, release checks remain public and may need to wait until GitHub's rate-limit reset. Credentials are never sent
to a custom release source.

## The installer finished but `threadnote` is not found

The POSIX launcher lives in `~/.local/bin`. When that directory is absent from `PATH`, the standalone installer adds an
idempotent entry to the detected zsh, bash, fish, or POSIX shell profile. A child installer cannot modify the shell that
launched it, so either open a new terminal or apply the command printed by the installer:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

For fish, use:

```fish
set -gx PATH "$HOME/.local/bin" $PATH
```

The absolute command printed at the end of installation also works immediately, for example
`"$HOME/.local/bin/threadnote" doctor --dry-run`. A custom `THREADNOTE_BIN_DIR` is never added to a profile
automatically; add that directory to `PATH` yourself or use its absolute launcher path.

On Windows, launchers live in `%LOCALAPPDATA%\Threadnote\bin` (or `THREADNOTE_BIN_DIR`). The installer writes
`threadnote.cmd` for cmd.exe and PowerShell plus an extensionless `threadnote` for Git Bash and other MSYS shells, and
the same pair for `threadnote-mcp-server`. Git Bash does not apply PATHEXT, so `threadnote` needs that extensionless
file. `threadnote repair` recreates a missing managed launcher. After install, open a new terminal if `threadnote` is
still not found; the installer also prepends the default bin directory to the Windows user `PATH`.

## Start and stop do not launch a service

Threadnote 4 owns no daemon. `threadnote start` verifies the on-demand runtime and `threadnote stop` is a compatibility
no-op. Use `threadnote doctor` for storage, index, and model diagnostics.

## Cursor does not load the Threadnote instructions

Run `threadnote mcp-install cursor --apply`, then reload Cursor. The command registers Cursor and installs the MCP entry,
`~/.cursor/rules/threadnote.mdc`, and the Threadnote skills under `~/.cursor/skills`. A Marketplace-managed Threadnote
plugin is accepted as an alternative instruction provider; when detected, Threadnote installs the skills but removes
its duplicate managed user-rule block.

Run `threadnote doctor` afterward. Doctor checks Cursor only when it has a registered or legacy-inferred Threadnote MCP
integration. Merely having Cursor installed is healthy and does not require either Threadnote MCP or the optional
Marketplace plugin.

If an older Threadnote doctor or a dedicated plugin-package check reports `~/.cursor/plugins/local/threadnote`, fully
quit Cursor and move only that unsupported local copy aside before installing through the Marketplace. Threadnote does
not remove it automatically. If model access is affected on a managed device, preserve needed settings and coordinate
with the Cursor administrator or Cursor support before clearing broader application state.

## Collect production logs for support

Run `threadnote logs` to list the available files. Threadnote writes JSON Lines operational diagnostics under
`~/.threadnote/logs/threadnote.log`, rotates at 1 MiB, and retains five rotated files (`threadnote.log.1` through
`threadnote.log.5`). Appends and rotation are serialized both within one process and across concurrent agent
processes.

The log schema is intentionally narrower than console output: it includes the Threadnote and embedded Bun versions,
operating system and architecture, CLI command or MCP tool name, duration, outcome, and typed failure name. It never
records command arguments, environment values, memory content, recall queries or results, MCP request/response
payloads, or exception messages. Help, dry-run, implicit preview, and `report-issue` commands do not write logs.
Logging starts only after Threadnote owns a valid home, never creates a home before migration, and is best-effort so a
logging failure cannot fail the command.

Review the files before attaching them to a support report. The active file is newest; numbered files are progressively
older.

For failures that are difficult to reproduce, optional anonymous telemetry can correlate allowlisted command and MCP
tool outcomes during one agent session. It is off by default. Run `threadnote telemetry enable` to preview the data and
destination, then rerun with `--apply` only if you consent. Use `threadnote telemetry status` to inspect the effective
state and `threadnote telemetry disable --apply` to revoke it. To keep telemetry enabled when future releases expand
the versioned data contract, apply consent with `threadnote telemetry enable --auto-accept --apply`; without that flag,
new data categories continue to fail closed until reviewed. Telemetry never replaces the local logs or an explicit
support report; see [Optional anonymous telemetry](./telemetry.md).

Create a Threadnote GitHub issue through an exact public preview:

```sh
threadnote report-issue \
  --title "Short failure summary" \
  --body "What happened, what was expected, and how to reproduce it"
```

Preview does not require GitHub CLI. For submission, install it from [cli.github.com](https://cli.github.com/) (or use
`brew install gh` on macOS / `winget install --id GitHub.cli` on Windows), authenticate with `gh auth login`, and rerun
with `--apply --approval sha256:...` using the approval digest printed by the preview. Threadnote refuses submission if
the title, body, diagnostics, or selected log excerpt changed after review. Add `--include-logs` only when you want the
newest valid production-log entries embedded in the issue. Threadnote re-parses those JSONL entries through a strict
field allowlist, omits older entries beyond the issue-body budget, and never posts raw command output. The request body
is passed to `gh api` through an owner-only temporary file rather than process arguments.

## Home or migration problems

The owned home defaults to `~/.threadnote`. Check for an accidental override:

```sh
echo "$THREADNOTE_HOME"
threadnote doctor
threadnote migrate
```

`THREADNOTE_HOME` and `--home` select the data home for memories, indexes, logs, models, and related configuration.
They do not relocate the standalone installation: the executable, active-release pointer, update policy, process leases,
and release pruning are installation-scoped because every data home uses the same installed command. Consequently,
`threadnote install --home <temporary-home>` can still maintain and prune the shared standalone installation.

For a disposable test or chaos run that invokes `install`, isolate both roots. `THREADNOTE_INSTALL_ROOT` is an advanced
managed-install and test control, not a setting to copy into ordinary agent configuration:

```sh
THREADNOTE_INSTALL_ROOT=/path/to/temporary/install-root \
  threadnote install --home /path/to/temporary/threadnote-home --no-start
```

`migrate` is a dry run unless `--apply` is present. It never deletes the legacy source. An interrupted copy can be
resumed; a promoted target has a checksummed receipt. If the target is unrelated or free space is insufficient,
migration stops before promotion.

The standalone installer removes verified obsolete runtimes, not legacy data. It may uninstall the old global
Threadnote package, the Threadnote-owned OpenViking uv/pipx/user-pip tool, and the macOS
`io.threadnote.openviking` LaunchAgent. It never deletes `~/.openviking`; run `threadnote migrate --apply` to import
that source into the native Threadnote 4 home.

## Forget cannot remove a resource subtree

`threadnote forget --dry-run <uri>` inspects the same exact target as apply. A directory preview says it will remove a
resource subtree; apply then removes that directory and its descendants recursively while preserving siblings.
Anchored resources and broad namespace or collection roots are refused, so use the unanchored URI of the narrowest
directory you intend to remove.

A genuine mutation-lock failure identifies the local owner PID when available. Wait for that operation, inspect
`threadnote processes`, and run `threadnote doctor --dry-run` if the owner is stale or unknown. Filesystem removal
errors are reported as removal errors rather than being mislabeled as lock failures.

## Seed is slow or skips files

Threadnote applies the packaged `.threadnoteignore` while walking the filesystem, before entering ignored directories.
The default rules exclude dependency and build caches such as `node_modules/` and `.nx/`. Broad patterns also skip every
directory whose name starts with `.`, while an explicitly named manifest pattern such as `.github/**` or `.claude/**`
still includes that directory.

Each project is limited to 20,000 candidates, 250,000 visited non-ignored entries, and 4 MiB per file. Narrow the
project's seed patterns or extend `.threadnoteignore` if a limit is reported. A failed project no longer prevents later
projects from being processed, but the command returns a failure after writing the completed project state.

The final summary reports safety skips and project failures. Local POSIX home paths are redacted from every seeded text
file. Windows paths such as `C:/Users/...`, Git-Bash paths such as `/c/Users/...`, and WSL paths such as
`/mnt/c/Users/...` are retained because they describe portable path conventions rather than a macOS home.

## Semantic recall is unavailable

The core BGE embedding model and vector index are installed automatically by `threadnote install`. Repair their
derived state without selecting a model manually:

```sh
threadnote repair
threadnote models list
threadnote models runtime
threadnote models verify bge-small-en-v1.5-q8
threadnote index status
threadnote index verify
```

The initial model download requires HTTPS access to the manifest’s pinned repository revision and resumes after an
interruption. Repeat installs preserve a verified existing model. A checksum mismatch deletes the invalid partial file
and never activates it. Lexical recall remains available if native inference is temporarily unavailable, while
`threadnote doctor` reports the missing core capability as a failure.

MCP semantic recall waits up to 30 seconds before falling back to deterministic lexical recall. A timed-out native
request keeps its admission slot until it finishes, so repeated recalls cannot start overlapping semantic work.

The runtime requests prebuilt `node-llama-cpp` binaries only. If `models runtime` reports that no compatible prebuilt
binary exists, install the Threadnote archive matching your operating system and architecture; Threadnote will not
silently compile one.

Install and repair also retire the old 3.x Python local-AI daemon after migration. Threadnote signals a process only
after its legacy receipt, loopback health response, PID, launch ID, model ID, and token-derived proof all agree.
Unverified or unresponsive PIDs are left untouched with a warning.

## Threadnote shows several processes or uses more memory than expected

Each active stdio client owns one MCP process, and semantic work lazily starts one crash-isolated local-model worker
below that parent. Run `threadnote processes` to see a bounded privacy-safe inventory with role, parent PID, age,
current operation, and RSS. The output excludes command lines, working directories, repository names, prompts, and
model input.

The Processes tab in `threadnote manage` presents the same bounded registered-runtime inventory and refreshes while
workers start and stop. Its stop icon requires confirmation and is bound to the exact private registration and operating
system start identity shown in that row; it refuses stale, replaced, legacy, or unverifiable processes. The Manager
process hosting the page is intentionally protected. Isolated automatic-compaction and deep-diagnostics workers appear
there only while their operation is alive, so seeing only Manager after compaction completes is expected.

`ROLE` is how the process was started and never changes: ordinary roles include `mcp`, `cli`, and `manager`; dedicated
workers include `graph-parser-worker`, `graph-compaction-worker`, `graph-diagnostics-worker`, and
`local-model-worker`. While a process builds or waits for a code graph, the role it is temporarily acting as is
appended, as in `cli (graph-builder)` for a dedicated `threadnote graph index` run or `mcp (graph-waiter)` for an MCP
server queued behind another build. A process is therefore identifiable by its own identity and by the graph work it
currently owns.

An unused model worker unloads after five minutes by default. Set
`THREADNOTE_LOCAL_MODEL_WORKER_IDLE_TIMEOUT_MS=<milliseconds>` before starting the client to use a different idle
window; `0` disables idle eviction. Closing the stdio client closes both its MCP server and worker.

Code graph vector builds can use up to eight embedding contexts on CPU and divide the detected math-core thread budget
between them. The native runtime caps the pool on smaller CPUs; a model with GPU layers, or unknown offload state,
stays on one context. Ordinary recall and semantic-query embeddings remain serial by default. Set
`THREADNOTE_EMBEDDING_CONTEXTS=1`, `2`, `4`, or `8` to override every embedding session in that process; prefix only
the `threadnote graph index` command to limit the override to a graph build. `1` is the low-memory rollback.

## An index rebuild was interrupted

Re-run `threadnote repair` or `threadnote index rebuild`. The lexical and vector SQLite databases are disposable and
rebuilt from canonical Markdown after corruption. Vector values are content-addressed, so a retry reuses every valid
value already written. A changed active mapping is committed in one SQLite transaction only after every required
vector is present; an interrupted embedding run leaves the previous mapping available.

If repair stops on an unrelated host-instruction conflict, run `threadnote repair --core-only --no-post-update` to
rebuild core state and indexes without changing host instructions, managed hooks, or MCP settings. The host warning
remains for a separate integration repair; `--core-only` takes precedence over any `--mcp` selection.

`threadnote repair --deep` runs a full SQLite integrity check over each derived native code graph. Large monorepo
graphs can take time to scan, and a pause at one database means SQLite is still reading that database's pages. Use the
home-wide graph commands when the issue is isolated to native code graphs:

```sh
threadnote graph diagnostics --analyze --json
threadnote graph repair --all --dry-run
threadnote graph repair --all
```

`graph diagnostics` does not depend on the current directory. Its default health pass is quick; add `--deep` only when
you need full SQLite integrity and foreign-key checks. `graph repair --all` immediately applies pending persistent
schema migrations instead of waiting for a later graph query, while also keeping its default pass quick. Add `--deep`
to discard an unreadable or corrupt derived graph database after the full check; its source repository and Threadnote
memories are untouched, and the next graph query rebuilds the disposable graph.

```sh
threadnote index verify
threadnote index rebuild
```

## Code graph indexing or a language pack fails

The native graph supports compiler-backed TypeScript/JavaScript and structural Java, Kotlin, Swift, Bash, C, C++, C#,
Dart, Elixir, Go, HCL/Terraform, Julia, Lua, Objective-C, PHP, PowerShell, Python, Ruby, Rust, Scala, Solidity, Svelte,
SystemVerilog/Verilog, Vue, Zig, Apex, Fortran, and Razor without invoking repository build tools. The standalone
archive bundles checksum-verified grammar WASM for the AST-backed structural packs. Apex, Fortran, and Razor are
bounded deterministic text-structural packs and do not claim AST coverage. Threadnote also has deterministic
extractors for common schema/configuration formats and local document corpora. Check the disposable graph and rebuild
it with:

```sh
threadnote graph status
threadnote graph inventory
threadnote doctor --dry-run
threadnote graph index --full
```

`threadnote graph status --json` emits the bounded version 5 machine projection. By default it returns at most four
compact build summaries, four compact waiter summaries, four queued worktree IDs, and four rich language-pack records.
The top-level `build` is an exact `buildId`/`worktreeId`/`index` selector into `builds`, so the selected current-worktree
or active record is retained without serializing it twice. Summaries keep state, phase, counters, ETA/error/result,
freshness observation, timestamps, and bounded live activity; detailed extraction, materialization, owner, and local
Manager fields stay out of machine output. Each list has exact `total`, `returned`, and `omitted` counts under
`projection`. Use `--build-limit <1..32>` or `--language-pack-limit <1..64>` with `--json` when an operator needs a
larger bounded sample. Human status and Manager continue to use the complete internal activity and pack catalogs.

`threadnote graph inventory` is a non-mutating, aggregate-only admission preview. It reports exact file and byte totals
for eligible and skipped inputs, grouped by language, file role, language-pack classifier, and decision reason. The
breakdown makes SVG, heavy/generated JSON, Git ignore, committed `.threadnoteignore`, and uncommitted
`.threadnoteignore.local` decisions visible while separately
showing admitted TypeScript, package manifests, Nx configuration, and TypeScript configuration. The two Threadnote ignore
files use the same pattern syntax and are combined as a union, so a path ignored in either file is skipped. Keep
`.threadnoteignore.local` uncommitted for machine-specific extra excludes in large monorepos. Add `--json` for the
versioned path-free payload. Ordinary source blobs are not hydrated; Threadnote reads only the small resolution
manifests needed to apply the same declared-source-root rules as indexing.

For mixed file-set changes, an existing file from a resolver domain without a declared project can still be rewritten
locally when its cached before/after facts prove that published symbol lookup keys and static re-export aliases are
unchanged. Added or deleted files in such an unowned domain, a changed published surface, incomplete cache evidence, or
an exceeded scan/rewrite bound still triggers a correctness-preserving full materialization. In oversized declared
projects, Threadnote performs one bounded candidate scan in the current file context so imports that become resolvable
after a module is added are included in the incremental rewrite.

Interactive indexing rewrites one compact status line (TTY `\r`) with phase, counts, and an ETA when available. File
paths and per-file parse/persist timings stay out of scrollback. Generated roots such as `node_modules`, `dist`, `build`, `out`, hidden caches, and
`bazel-*` are pruned before reads. SVG and snapshot/golden/fixture or generated JSON/JSONC are excluded before blob
reads and hashing. Generic JSON/JSONC at or above 256 KiB is also excluded, while recognized package, Nx, TypeScript,
schema, and configuration inputs remain eligible below their separate 1 MiB safety cap.

A large cold MCP inspection can return `state: "indexing"` with measured phase progress, an optional phase-scoped
estimate, and adaptive retry timing. When a compatible ready snapshot exists, query, node, neighbors, and explain may
return stale cards while continuity is `active`, `queued`, or `deferred`; continue bounded discovery and verify exact
literals in source. Retry only before strict current or relationship claims, or when no usable cards survive—do not
tight-poll. Path, impact, and exact-current citations remain strict. Analysis defaults to current evidence and permits
explicit `freshness: ready` or `freshness: allow-stale` for compatible snapshots of the selected project. There is no repository-size admission
limit and no daemon to start. Nested Maven, Gradle, SwiftPM, and Xcode scopes are detected statically. Dynamic build
logic and ambiguous dependencies remain syntactic rather than being guessed. Bazel workspaces, packages, targets,
loads, and labels are also detected statically from `WORKSPACE*`, `MODULE.bazel`, `BUILD*`, `.bzl`, `.axl`, and
`.bazelrc` (including Aspect CLI sources under `.aspect/`); Threadnote never invokes Bazel or evaluates Starlark
macros.

Use `threadnote graph query --package <exact-package> --query <terms>` when a monorepo question is explicitly
package-local. Its bounded examined/matched counts make a zero-result useful as an absence hint, but never as proof of
repository-wide absence. For a named seed-manifest workset, `threadnote graph query --workset <name> --query <terms>`
uses Workset Search 2.0 to route normal task text, not a public DSL, across the complete published generation with no
eight-repository admission cap. It globally ranks catalog candidates, then opens only the strongest repositories in
bounded adaptive batches. The public logical evidence sequence defaults to 40 cards and has a separate 512-card
internal safety maximum. That search breadth is independent from the compact response projection, which defaults to
1,250 estimated tokens and accepts at most 1,500. Every returned card identifies its repository and exact snapshot;
unavailable members remain explicit, and queries never cold-index repositories as a fan-out side effect.

Android `res` XML and Apple plist, storyboard, XIB, and asset-catalog metadata contribute explicit searchable resource
wiring. Binary images remain metadata-only: no query result may be used to infer pixel bounds, visual appearance, OCR,
or other image semantics Threadnote did not extract.

Manager keeps ready graph views readable while another process owns the graph writer. A `lease-deferred` notice means
snapshot retention was postponed by that active build, not that the database or ready snapshot is unhealthy; retry
after the build completes. A graph detail request that cannot safely retain its snapshot returns HTTP 409 with
`retryAfterMilliseconds`, and Manager exposes a bounded request failure with a **Try again** action instead of waiting
indefinitely. A `lease-failed` notice indicates a non-contention storage problem; run `threadnote doctor --dry-run`
before retrying.

Likewise, `threadnote graph diagnostics` reports an actively owned checkout as `Health: deferred`: inspection was
skipped for that pass, rather than finding the database unhealthy. Its ready-snapshot and indexed-view counts continue
to describe the inventoried graph state, so `0 ready` is not inferred merely because health inspection was deferred.

For whole-repository topology, call MCP `analyze_code_graph` or run `threadnote graph analyze --view full`. Analysis
has no repository-size admission cap. The MCP surface independently caps topology retention at 100,000 symbols,
500,000 distinct relationships, and 1,000,000 relationship visits; larger snapshots still return aggregate statistics,
with topology explicitly marked partial or unavailable. CLI and Manager analysis keep their complete snapshot-derived
budgets. MCP structured content and rendered text each have an independent deterministic 24 KiB UTF-8 envelope with
output coverage and omission metadata. Reaching any analysis or response budget does not imply that the stored
snapshot was truncated. Manager shows statistics, community drill-down, structural groups, confidence, hubs, and
cross-community signals only after **Analyze** is selected.

If a current analysis is waiting for refresh, request MCP `analyze_code_graph` with `freshness: ready`, or use
`threadnote graph analyze --view groups --freshness ready --project <selected-project>`. This accepts an existing
compatible snapshot and reports its freshness. On a cold project, `ready` permits a bounded refresh; it cannot provide
analysis from another project's snapshot. Use `allow-stale` to prevent indexing and receive `no-ready-snapshot` when
none is available. A historical complete project-coverage receipt is not proof of a readable ready snapshot.

Ordinary MCP inspection and analysis use a 55-second total budget, including their finalization reserve.
MCP tools use this fixed deadline and do not accept a per-request timeout override. CLI `--read-timeout-ms` bounds the analysis read including snapshot selection and cleanup. Writer
contention returns a deferred state; a refresh failure carries its recovery information. Check those states before
treating transport success as completed analysis, and respect retry guidance.

Capacity reporting distinguishes the advisory whole-build estimate from measured reservations around bounded database
writes. A large cached-fact estimate can warn without rejecting every write. Actual capacity failures retain the model,
required and available bytes by filesystem, active reservations, and selected scope in their recovery details. Physical
space exhaustion requires freeing space; contention with another reservation defers the build. Repeated analysis reads
preserve that failure and its backoff instead of repeatedly launching the same blocked refresh.

Document extraction is deliberately local and deterministic. PDFs, OpenXML/OpenDocument files, EPUB, text documents,
notebooks, and text-based diagram formats contribute extractable text and links. A scanned PDF, image, audio file, or
video is indexed as an asset with deterministic metadata only: Threadnote does not perform OCR, image understanding,
transcription, or video analysis. An extraction diagnostic for one such asset does not mean the rest of the graph
failed. Any corpus artifact over 64 MiB is intentionally kept as metadata only instead of being rejected or
semantically decompressed. OpenXML, OpenDocument, and EPUB expand only selected text entries, bounded to 16 MiB per
entry and 64 MiB cumulatively; crossing a budget falls back to asset metadata. These are per-artifact extraction
safety budgets, not repository or graph-size limits.

For a portable artifact, `threadnote graph export --format json|graphml|html|svg --output <new-file>` never overwrites
an existing file. JSON, GraphML, and HTML default to the complete snapshot. SVG defaults to 300 nodes and 1,000 edges;
pass `--node-limit all --edge-limit all` only when an intentionally large SVG is acceptable. Export limits affect the
artifact, not graph admission or snapshot coverage. `threadnote graph report --output <new-file.md>` produces a
deterministic architecture report and likewise refuses to overwrite.

If doctor reports a missing or mismatched grammar asset, reinstall or update the standalone archive for the current
platform. Threadnote never downloads parser grammars at runtime. Repair may discard and rebuild graph SQLite files, but
it does not modify the repository or canonical memories.

A Manager card labeled **Unassociated graph storage** has neither a verified local repository folder nor a ready
queryable snapshot. If the repository still exists, run `threadnote graph index --cwd <path>` from that folder and
refresh Manager. If the database is obsolete, preview and purge it instead; graph databases are derived data and
purging does not remove repository files or canonical memories.

## MCP does not appear in the agent

```sh
threadnote mcp-install codex --apply
threadnote doctor
```

Then start a fresh agent session. Replace `codex` with the relevant client. Threadnote supports local stdio MCP only;
there is no HTTP endpoint, bearer token, host, or port to configure.

## Recall quality changed

Run the reviewed current release gate before changing ranking weights, chunking, model manifests, or fixture
judgments:

```sh
bun run eval:recall:v2 -- \
  --fail-on-regression --fail-on-contract
```

The evaluator defaults to the Threadnote 4.2.7 `hybrid-v8` quality baseline. Inspect global and per-category deltas.
Safety metrics cannot regress, and `--fail-on-contract` allows fixes to the 99 reviewed lexical-only failures but
rejects any new failure identity or count increase. Pass `--no-baseline` to make the same flag require zero contract
failures. Use `--no-baseline --global-eligibility` to diagnose omitted-project retrieval separately; it intentionally
does not compare that broader retrieval contract against the explicit-project gate.

For a rank-performance change, use the clean Apple M1 Max `hybrid-v3` artifacts at 200, 1k, 10k, and 100k under
`apps/threadnote/test/evaluation/baselines/threadnote-4.2.7/benchmarks/darwin-arm64-m1-max/`. Capture the candidate with
`bun run bench:recall -- --require-clean` using the reference artifact's document count, seed, warmups, and samples.
Compare only when hardware, runtime, and fixture hash match; the checked-in timings are not cross-platform limits.
