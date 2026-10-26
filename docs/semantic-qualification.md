# Semantic provider and editor qualification

P00 is **incomplete**. This slice supplies disposable feasibility probes and a candidate ledger. It does not enable a
Threadnote semantic service, ship providers, certify production support, or complete any release gate on its own.

The current release scope is TypeScript/JavaScript, Python, Go, Rust and Java. Kotlin is deferred by the user's
2026-10-26 direction. Kotlin JVM, mixed Java/Kotlin, Android and Kotlin Multiplatform qualification are outside the
current release gates. Existing Kotlin observations remain in the ledger as historical evidence; they do not qualify
Java or block its independent qualification.

## Ownership and execution

- `scripts/qualify-semantic-providers.ts` runs an explicitly selected, already available executable against a temporary
  two-file TypeScript, Python or Java Maven project. It never installs a provider or applies its returned edits.
- `scripts/qualify-semantic-editors.ts` launches an explicitly selected VS Code or Cursor CLI with an isolated temporary
  workspace, profile, extension directory and test extension. All mutations target disposable dirty buffers.
- `tools/semantic/semantic_*` contains test transport, independent fixed-fixture oracles and owned-process
  cleanup. These are qualification helpers, not the production semantic transport, writer or recovery implementation.
- `config/semantic-providers/qualification-lock.json` records candidate versions, artifact provenance, license sources,
  observed results and unresolved platform cells. Every provider remains `productionQualified: false`.
- Bazel declares `vscode` as a host-supplied module for the exact editor fixture file. It is provided by the real extension
  host, not an npm dependency. Other sources importing `vscode` still require explicit ownership.

These probes are an operator-run experiment, not a sandbox for untrusted executables. They do not accept an EULA, obtain
credentials, activate a license, install tools globally, or approve repository build execution. The editor runs with a fresh
profile and telemetry disabled, but this is not a network-isolation guarantee. Select trusted local binaries deliberately.

To run a provider probe, prepare a local config outside the repository:

```json
{
  "id": "basedpyright",
  "version": "1.40.2",
  "language": "python",
  "command": "/absolute/path/to/basedpyright-langserver",
  "args": ["--stdio"]
}
```

Use `language: "typescript"` for the TypeScript fixture. A Node-based adapter uses the Node executable as `command` and
its adapter entrypoint plus `--stdio` in `args`. Optional `settings` supplies the probe's initialization/configuration
payload. The declared version is operator input; its presence does not prove the installed package version. The report's
executable hash identifies the launcher, which can be a runtime or wrapper. Retain the corresponding verified package or
archive digest and toolchain evidence when promoting a candidate.

```sh
bun scripts/qualify-semantic-providers.ts --probe --config /absolute/probe.json --output /absolute/provider-report.json
bun scripts/qualify-semantic-editors.ts --probe --editor /absolute/editor-cli --output /absolute/editor-report.json
```

Java uses `language: "java"`, the selected Java executable as `command`, and an explicit JDT LS launcher/configuration in
`args`. Set `configurationTemplate` to the platform-specific server configuration directory. The harness copies only its
`config.ini` into a new `{scratch}/configuration`; it does not reuse mutable server state. The literal `{scratch}` in an
argument expands to the disposable directory. Use it for `-Duser.home={scratch}/home`,
`-Dmaven.repo.local={scratch}/m2`, `-configuration {scratch}/configuration`, and `-data {scratch}/data`. Set
`-Dosgi.install.area` to the distribution's file URI and `-jar` to its exact Equinox launcher. Supply Java settings under
`settings.java`; the tested fixture enables Maven import and disables Gradle import/autobuild. This deliberately authored
fixture is authorized to import; it does not establish policy enforcement for an untrusted project. Java initialization and
requests have 120-second and 60-second deadlines respectively. Project language level is 21; this exact server distribution
requires runtime Java25 even though its upstream README still states Java21.

No provider discovery, download or automatic execution follows from opening the ledger. Reports belong outside the source
checkout. Failed assertions or incomplete process cleanup produce a nonzero exit status. Keep reports private when they
include local executable paths or diagnostic output.

## What the probes establish

The provider fixture opens saved text, sends unsaved `didChange` version 2 to both files, and queries the changed view.
Definition must resolve from the dependent file to the exact declaration. References must equal the complete expected
occurrence set. Rename must transform every fixture file to the expected bytes, preserving unrelated content and CRLF;
stale explicit document versions, duplicate targets, conflicting edit representations, resource operations, invalid ranges
and incomplete previews fail the oracle. TypeScript includes a supplementary Unicode character before the declaration to
exercise UTF-16 positions. All fixtures contain Unicode and CRLF. Source files on disk must remain unchanged.

The editor fixture exercises actual `TextEditor.edit` calls in a real host: dirty-buffer application, version rejection
when a competing edit reaches the host first, partial application when the next target changes, a simulated ownership
transfer, and an in-memory idempotent retry. A local negative branch returns no edit for an unqualified client. That branch
**does not test a real LSP capability exchange**, and the fixture's ownership counter and retry cache do not establish
cross-process authority, durable journaling or crash recovery. Standard LSP rename, resource operations, production commands
and extension packaging remain unqualified.

Owned POSIX process groups are checked after the launcher exits so remaining descendants cannot be mistaken for clean
shutdown. Cleanup waits, sends termination to the owned group, escalates within a bounded interval and reports whether the
group drained. An undrained group leaves its disposable workspace intact for diagnosis. A temporary permission denial means the group is still potentially alive. A provider requiring forced
cleanup does not pass the clean-shutdown assertion. The helper does not contain descendants that deliberately detach into
another group. Windows process-tree containment is unqualified; direct-child exit cannot pass this cleanup gate.

Provider shutdown has independent deadlines for the protocol handshake and exit observation. If termination cannot be
confirmed, the receipt reports an unknown exit and undrained cleanup, the scratch workspace is retained, and pipe/child
handles are released so the harness can terminate. Both runners handle SIGINT and SIGTERM with bounded owned-group cleanup
and an interrupted receipt; a second signal does not restart cleanup. The signal handler has an eight-second outer deadline.
SIGKILL, a runtime crash, power loss, or an unresponsive event loop cannot execute JavaScript cleanup. Those cases can leave
detached children or scratch state and require external process supervision before lifecycle qualification.

## Evidence so far

Observations below are limited to macOS arm64 on 2026-10-26. They are partial feasibility evidence, not a production support
matrix or a promise that the same provider works for every project.

| Candidate / host                                                        | Observed evidence                                                                                                                 | Still unqualified                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| TypeScript Language Server 6.0.2 with TypeScript 6.0.3 and Node 24.19.0 | Exact unsaved definition, references and complete rename; CRLF/UTF-16 oracle; unchanged disk; clean owned process-group shutdown  | JavaScript fixtures, diagnostics, hover/symbols/actions, project variants and all final product behavior    |
| Basedpyright 1.40.2 with Python 3.12.13                                 | Exact unsaved definition, references and complete rename; unchanged disk; clean owned process-group shutdown                      | Interpreter changes, dynamic-analysis limits, diagnostics/actions and final product behavior                |
| Native TypeScript 7.0.2                                                 | Earlier unsaved references/rename evidence; file-watcher teardown panicked                                                        | Not selected for the initial pilot; shutdown remains a blocker                                              |
| Python LSP Server 1.15.0 with pylsp-rope 0.1.17                         | Earlier probe omitted the unsaved dependent reference and changed CRLF during rename                                              | Rejected for the initial Python pilot                                                                       |
| VS Code 1.137.0 and Cursor 3.22.7 (host API 1.128.0)                    | Disposable host fixtures passed dirty edits and injected race scenarios; owned process groups drained                             | All production integration guarantees remain unqualified                                                    |
| gopls v0.24.0                                                           | Source artifact pinned                                                                                                            | Executable/toolchain and real Go process probe have not run                                                 |
| rust-analyzer 2026-10-26                                                | Candidate archive digests recorded                                                                                                | Toolchain/project and real Rust process probe have not run                                                  |
| JDT LS 1.63.0-202610191322 with Temurin 25.0.5+8                        | Exact dirty definition, references and rename in a Maven fixture; unchanged disk; clean owned shutdown. Java21 failed at startup. | Gradle, other core capabilities, build/import policy, distribution qualification and final product behavior |
| Kotlin LSP                                                              | Earlier distributions could not complete the EULA/expiry checks; no terms accepted or expiry bypassed                             | Deferred; historical investigation only                                                                     |

The required platform inventory follows `scripts/release-targets.ts`; all cells other than the bounded macOS arm64
observations remain unqualified. A recorded artifact hash or license link is provenance, not evidence of working binaries,
headless permission or redistribution compliance.

## Remaining P00 and release gates

1. Implement and execute real Go and Rust probes using verified executables and matching toolchains. Extend the Java
   Maven pilot to the required project/capability matrix, including Gradle; mixed-language qualification remains deferred.
2. Complete legal, headless-use and redistribution qualification for every selected provider and dependency. Freeze the
   tested candidate/platform versions without treating an upstream capability list as evidence.
3. Exercise the approved capability/project matrix, including JavaScript, diagnostics, symbols, hover, representative
   edit-based actions and relevant project boundaries. The current two-file oracle covers only navigation and rename.
4. Prove policy enforcement for build imports, macro execution and dependency download. The disposable harness's refusal
   of provider `workspace/applyEdit` is not a production authorization policy.
5. Qualify lifecycle and platform behavior, including Windows process-tree ownership, timeouts, provider crashes, restart
   generations and resource limits. Deliberately detached descendants require an additional containment strategy.
6. Implement and validate the product's stable writer authority, conditional file/buffer mutations, complete preview,
   durable journal, interruption recovery and real generic/first-party LSP capability negotiation. Editor feasibility
   does not discharge those obligations.
7. Run final conformance through the shipped MCP, CLI and editor surfaces after implementation. Interrupted setup/upgrades,
   coexistence, rollback, production performance and completed-task token-efficiency evidence remain later product gates.

Focused local verification uses `apps/threadnote/test/unit/semantic-provider-qualification.test.ts` and the Bazel source
closure regression. The transport suite includes a bounded property test for arbitrary JSON values and transport chunking,
plus malformed-frame, timeout/cancellation, Unicode/CRLF, incomplete-result and orphaned-descendant regressions. Full product
and platform suites belong to their implementation phases and CI; passing this focused suite does not complete P00.
