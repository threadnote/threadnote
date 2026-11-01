# Semantic provider and editor qualification

This dossier records disposable P00 feasibility probes, later phase-labelled component evidence and a candidate ledger. It does not enable a Threadnote semantic
service, ship providers, certify production support, or complete a release gate on its own. Native cycle receipts own
phase acceptance; every provider's `productionQualified` flag remains false.

The current release scope is TypeScript/JavaScript, Python, Go, Rust and Java. Kotlin is deferred by the user's
2026-10-26 direction. Kotlin JVM, mixed Java/Kotlin, Android and Kotlin Multiplatform qualification are outside the
current release gates. Existing Kotlin observations remain in the ledger as historical evidence; they do not qualify
Java or block its independent qualification.

## Ownership and execution

- `scripts/qualify-semantic-providers.ts` runs an explicitly selected, already available executable against a temporary
  two-file TypeScript, JavaScript, Python, Go, Rust or Java project. It never installs a provider or applies returned edits.
  Optional Rust build-script and Java Gradle fixtures contain deliberately authored execution markers.
- `scripts/qualify-semantic-editors.ts` launches an explicitly selected VS Code or Cursor CLI with an isolated temporary
  workspace, profile, extension directory and test extension. All mutations target disposable dirty buffers.
- `tools/semantic/semantic_*` contains test transport, independent fixed-fixture oracles and owned-process
  cleanup. These are qualification helpers, not the production semantic transport, writer or recovery implementation.
- `config/semantic-providers/qualification-lock.json` records candidate versions, artifact provenance, license sources,
  observed results and unresolved platform cells. Selected candidates and source-bound report digests are explicit.
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

Use `language: "typescript"` or `"javascript"` for the TypeScript Language Server fixtures. A Node-based adapter uses the Node executable as `command` and
its adapter entrypoint plus `--stdio` in `args`. Optional `settings` supplies the probe's initialization/configuration
payload. The declared version is operator input; its presence does not prove the installed package version. The report's
executable hash identifies the launcher, which can be a runtime or wrapper. Retain the corresponding verified package or
archive digest and toolchain evidence when promoting a candidate.

The local config is strict: unknown keys and mismatched fixture/language combinations fail before a provider starts.
`fixture` defaults to `"standard"`. `"java-gradle"` and `"rust-build-script"` additionally require the Boolean
`expectedBuildExecution`. Select actual provider settings separately: an expectation does not enable or disable execution.
After a bounded settling period and provider shutdown, the report compares the marker with that expectation. An unexpected
marker value fails. An absent marker is evidence for this authored fixture and observation window, not a sandbox guarantee.

Reports bind their config and harness, fixture, transport, assertion and process helper bytes with SHA-256. Keep earlier
reports when a harness changes. A launcher hash can identify `/usr/bin/env` rather than the provider; the ledger separately
pins the tested Go/Rust executables and toolchains.

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

For `fixture: "java-gradle"`, provide the verified local Gradle distribution through
`settings.java.import.gradle.home`, disable wrapper use, select offline operation, and set its user home to
`"{scratch}/gradle"`. The fixture writes a one-second daemon idle timeout there. The enabled and denied experiments change
`settings.java.import.gradle.enabled` and set the corresponding `expectedBuildExecution`; neither proves production
authorization for arbitrary projects. `{scratch}` expands in argument strings and settings string values, preserving JSON
syntax and object keys, including paths containing backslashes or quotes.

Go uses `language: "go"` and a matching local Go toolchain for the authored module. Rust uses `language: "rust"`, a verified
rust-analyzer executable, Cargo/rustc and rust-src. The recorded Rust fixture runs Cargo offline with a fresh Cargo home.
`fixture: "rust-build-script"` writes a local marker from `build.rs`; compare enabled and denied
`settings.cargo.buildScripts.enable` runs. Procedural macro execution is a separate, unresolved matrix cell.

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

Rust project readiness has a 60-second budget; each request is clamped to the remaining time rather than adding a final
20-second overrun. At most 32 observations are retained alongside the total attempt count. Before stopping Rust, the probe
also waits up to 30 seconds for a non-error quiescent status using the pinned provider's
[documented status notification](https://github.com/rust-lang/rust-analyzer/blob/2026-10-26/docs/book/src/contributing/lsp-extensions.md#server-status).
This fixture teardown signal does not replace the exact definition/reference/rename oracles or establish production
readiness. Panic observations survive arbitrary stderr chunks and truncation of the retained 4096-character diagnostic
tail. Clean shutdown requires a successful shutdown response and `exit` write within one two-second handshake budget,
an observed zero exit and closed stdio before releasing handles. Input write errors remain failures through that closure,
including errors emitted after a successful write callback. Stdio closure has a separate two-second deadline. Logged Rust panics, failed or skipped
shutdown handshakes and unknown exits fail qualification even when the leader reports exit code zero.

The editor fixture exercises actual `TextEditor.edit` calls in a real host: dirty-buffer application, version rejection
when a competing edit reaches the host first, partial application when the next target changes, a simulated ownership
transfer, and an in-memory idempotent retry. A local framed JSON-RPC prototype also exchanges `initialize`/`initialized`
messages. Generic clients and forged bridge capabilities receive no edit commands; a stolen proposal ID cannot authorize
application from another connection. A private one-use fixture capability admits one bridge channel, which receives only
an opaque proposal and applies it through the real conditional editor operation. Retry preserves the edited versions.

The prototype commands, private capability, ownership counter and retry cache are test scaffolding. They do not establish
production bridge enrollment, cross-process writer authority, durable journaling or crash recovery. Standard LSP mutation,
resource operations, production commands and extension packaging remain unqualified.

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

| Candidate / host                                                        | Observed evidence                                                                                                                                                                     | Still unqualified                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| TypeScript Language Server 6.0.2 with TypeScript 6.0.3 and Node 24.19.0 | TypeScript and JavaScript dirty definition, complete references/rename; CRLF/UTF-16 oracle; unchanged disk; clean owned shutdown                                                      | Diagnostics, hover/symbols/actions, project variants and final product behavior                                        |
| Basedpyright 1.40.2 with Python 3.12.13                                 | Exact unsaved definition, references and complete rename; unchanged disk; clean owned process-group shutdown                                                                          | Interpreter changes, dynamic-analysis limits, diagnostics/actions and final product behavior                           |
| Native TypeScript 7.0.2                                                 | Earlier unsaved references/rename evidence; file-watcher teardown panicked                                                                                                            | Not selected for the initial pilot; shutdown remains a blocker                                                         |
| Python LSP Server 1.15.0 with pylsp-rope 0.1.17                         | Earlier probe omitted the unsaved dependent reference and changed CRLF during rename                                                                                                  | Rejected for the initial Python pilot                                                                                  |
| VS Code 1.137.0 and Cursor 3.22.7 (host API 1.128.0)                    | Disposable host fixtures passed dirty edits and injected race scenarios; owned process groups drained                                                                                 | All production integration guarantees remain unqualified                                                               |
| gopls v0.24.0 with Go 1.27.3                                            | Verified local build/source and toolchain; exact dirty definition, two references and complete rename; unchanged source; clean owned shutdown                                         | Other project/capability/platform cells and final product behavior                                                     |
| rust-analyzer 2026-10-26 (0.3.3097) with Rust/Cargo 1.99.1              | Exact dirty definition, four references and rename; enabled/denied build-script markers; quiescent teardown without panic or forced cleanup                                           | Earlier immediate teardown panics retained; procedural macros, other project/platform cells and final product behavior |
| JDT LS 1.63.0-202610191322 with Temurin 25.0.5+8 and Gradle 9.8.2       | Exact dirty definition, three references and rename in Maven/Gradle fixtures; enabled/denied Gradle import markers; unchanged source; clean owned shutdown. Java21 failed at startup. | Other capabilities, production build/import policy, distribution qualification and final product behavior              |
| Kotlin LSP                                                              | Earlier distributions could not complete the EULA/expiry checks; no terms accepted or expiry bypassed                                                                                 | Deferred; historical investigation only                                                                                |

The required platform inventory follows `scripts/release-targets.ts`; all cells other than the bounded macOS arm64
observations remain unqualified. A recorded artifact hash or license link is provenance, not evidence of working binaries,
headless permission or redistribution compliance.

License inspection matched the pinned TypeScript Language Server artifact's Apache-2.0 **and** MIT portions, the
Basedpyright wheel's MIT text and gopls source's BSD-3-Clause text to their tagged upstream files. The ledger records those
digests and rust-analyzer's dual-license source texts. Java distribution notice inventory and Rust binary dependency
attribution remain release work; this inspection is not redistribution approval. No provider is bundled here.

## Remaining product and release qualification

The pilots do not discharge the following requirements. Their unresolved cells remain explicit release blockers.

1. Complete project/capability variants beyond the bounded Go, Rust, Java Maven/Gradle and other two-file pilots;
   mixed Java/Kotlin qualification remains deferred.
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

Focused local verification uses `apps/threadnote/test/unit/semantic-provider-qualification.test.ts`,
`semantic-probe-lifecycle.test.ts` and the Bazel source closure regression. Properties cover arbitrary JSON framing/chunking
and non-mutating, idempotent settings expansion. Regressions cover the overall readiness deadline, bounded observations,
logged panics despite exit zero, malformed frames, cancellation, Unicode/CRLF, incomplete results and owned descendants.
The ledger test covers all release platform/language cells and prohibits advertising a pilot as production support. Full
product/platform suites belong to their implementation phases and CI; these checks do not certify the release.

## P05 private Java component evidence

The Java ledger preserves the P00 observations and records later evidence separately under `phaseEvidence`. These
observations use the source-pinned private coordinator and actual JDT LS 1.63.0-202610191322 on macOS arm64, with separate
Temurin runtime Java 25.0.5+8 and project Java 21.0.13+9 SDKs. They contribute to P05; native phase acceptance remains
pending and `productionQualified` remains false for every provider.

The retained Maven 1.0 and Gradle 2.0 dependency fixtures each import existing main and test roots into a sealed prepared
model before private analysis. Actual results cover definition, references, unapplied rename previews, hover, symbols,
completion, signature, source type definition, call hierarchy, diagnostics and complete inline import-action previews.
A separate Maven fixture uses typed Alpha and Beta receivers in the same file and requires the exact Alpha declaration
and call-site reference locations. A retained-result audit also rejects a deliberate substitution of the same-file Beta
call, which a count-and-filename check would miss.

The focused diagnostic sequence observes one added error, the identical error in a nonempty `remaining` delta, then one
resolution after an unsaved document-version-2 import fix. The resolution binds the prior and current observations; the
prior observation is refused as stale and a repeated fixed-view read does not duplicate the resolution. The prepared
quickfix remains unapplied. Source, SDK and offline-cache digests are conserved, admission is empty, and the known owned
processes are positively absent before the disposable fixture is removed. Endpoint child OS exit codes are not exposed;
parent command exit and known-process absence are separate evidence.

Report hashes in the ledger identify private operator evidence. They are not phase receipts or public benchmark claims.
These fixtures establish bounded component behavior, with no general repository execution authorization, OS sandbox,
public setup issuer, editor integration, edit application, additional platform or aggregate-memory qualification. Kotlin
remains deferred and P09 editor work is skipped; shared guarded-edit safety remains required.

### Selected Java distribution licensing

The exact selected-artifact inventory covers 111 JDT distribution JARs, the legal trees of both Temurin SDKs, and Gradle
9.8.2 with its 348 JARs. It records file/entry hashes, packaged legal notices and declared manifest/POM license metadata.
A missing conventional license filename is a review gap, not proof that an artifact has no license. Wrapped/transitive
components still require mapping to the applicable notices and permitted-use evidence.

The upstream [JDT LS source license](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.63.0/LICENSE) is EPL-2.0.
[Adoptium describes Temurin binaries](https://adoptium.net/docs/faq) as GPLv2 with the Classpath Exception and directs users
to the included licenses. Both exact local SDKs include their own NOTICE and third-party legal trees. The
[Gradle 9.8.2 root license](https://github.com/gradle/gradle/blob/v9.8.2/LICENSE) is Apache-2.0; its packaged LICENSE and
NOTICE also identify third-party terms. A source project's root license alone does not qualify every bundled component.

Selected-profile license review remains pending; redistribution is release-gated. The runtime's Java status reports that
pending state alongside its exact platform and separate SDK requirements. No distribution approval or paid-entitlement
claim follows from the component probes or this inventory.
