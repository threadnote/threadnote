# Semantic operations and reversible upgrades

Semantic analysis is optional. Graph queries, citations and memories use their existing storage and remain available
without an enabled semantic profile, a provider SDK or a semantic coordinator. A coordinator starts only for an explicit
analysis request. Removing or disabling the semantic configuration never deletes user content or writer recovery evidence.

The current providers are experimental host candidates. `semantic capabilities` is a distribution catalog, not an
installation check. All candidates remain `productionQualified:false`; licensing, redistribution and the complete
platform/capability matrix remain release gates. Kotlin and the first-party editor LSP integration are deferred.

## Inspect a workspace

Pass a bounded JSON request on stdin to `threadnote semantic doctor --json` or `threadnote semantic status --json`:

```json
{"version": 1, "callerCwd": "/absolute/worktree"}
```

`doctor` checks the private profile and exact configured provider/runtime/SDK artifacts. It may execute the pinned Node
runtime's bounded `--version` check, but never starts an analysis provider, installs a package, downloads an SDK, accepts
terms or executes a repository build. Optional `language` selects one supported language for inspection. `status` skips
artifact checks and reports shared admission counts, numeric resource observations and, when available, failures from
the exact compiled runtime's existing coordinator. It never starts or repairs a coordinator. A source-mode runtime or
an unavailable diagnostic connection reports `not-assessed`, which is not proof that every older runtime has stopped.

Responses distinguish missing, disabled, invalid, incompatible and untrusted profiles, provide a next action and expose
supported state versions. Provider faults include a bounded cause and pinned-artifact setup action. Status exposes no
source text, host artifact paths, provider stderr, environment values, bootstrap tokens or writer capabilities. Detailed
source-bearing query responses remain confined to their authorized caller. Repository request fields cannot grant build,
macro or dependency-download permission; operational commands reject such fields.

## Configure or disable deliberately

`threadnote semantic setup --json` accepts the inspection request plus a `profile` conforming to the existing private host
profile schema: `version`, `enabled`, canonical `worktree` file URI and the host `catalog`. The catalog supplies exact local
artifact paths and SHA-256 digests using the existing TypeScript, Python, Go, Rust or Java candidate contracts. The
qualification basis is [the provider lock](../config/semantic-providers/qualification-lock.json); an upstream `latest`
version is never selected. No providers are bundled by this command.

Private profile read/publication uses the existing native descriptor, ownership, identity and ACL boundary, available on
the current Darwin arm64 candidate. This is not production qualification. Missing or unsupported ACL proof fails closed. Publication requires a canonical private
data home and private descendants; `0700`/`0600` mode bits alone never prove ACL privacy. Unexpected grants are refused
without changing permissions. This restriction does not qualify another platform or require semantic analysis for graph
and memory use.

Setup defaults to a preview. Add `apply:true` to save the verified profile. Replacing a different known profile also
requires `expectedDigest`, obtained as `profileDigest` from inspection. A repeated request with the same exact supported
profile is idempotent. Native exclusive creation never replaces an existing profile, and known replacement uses guarded
private staging and rename. The guard checks file ACLs before writing private bytes and rechecks the setup lease, parent
identity and expected prior profile during publication. An unconfirmed publication returns `indeterminate`: inspect the
retained state before an explicit retry, since an error is not proof of no write. Interrupted or unknown private staging
is retained rather than guessed to be disposable recovery evidence. Setup never repairs permissions or overwrites
unsupported/unknown state. If artifact verification fails, the prior working profile remains intact.

To disable, pass the current digest to `threadnote semantic disable --json`:

```json
{"version": 1, "callerCwd": "/absolute/worktree", "apply": true, "expectedDigest": "digest-from-status"}
```

Without `apply:true`, disable previews the action. Disable marks the known profile disabled and fences subsequent
admission/publication through the existing profile checks. It does not signal arbitrary processes, remove caches,
retire writer authority or delete journals. An already running coordinator follows its existing bounded cleanup and
idle lifecycle. Graph and memory need no semantic process. Reactivation uses explicit setup with the current digest.

## Budgets and pressure

The shared private admission ledger coordinates clients and runtime generations within one canonical data home.
Current defaults are eight provider reservations per home, four per workspace, two concurrent imports, 32 admission
tickets, four running queries per session and 32 admitted/queued session requests. Query defaults are 10 seconds with a
45-second maximum. Session and empty coordinator idle expiry are 600,000 milliseconds, checked on a one-second sweep.
The admission wait budget is finite (at most 120 seconds); file-lock acquisition and owned cleanup have their own
bounded budgets. A request deadline cancels pending protocol work; cleanup can continue after the response deadline.

New providers also wait when sampled RSS of registered provider leaders reaches 2 GiB per home. Observations are cached
for at most one second while the registered identities remain the same. Admission sampling fits the remaining wait
budget, capped at 500 milliseconds per sample; inspection sampling is capped at 1.5 seconds. Pressure does not kill
existing healthy work or start unlimited retries. Eligible FIFO admission skips a workspace blocked by its own cap, so
an unrelated ready workspace can progress when shared capacity is available. Expiry/cancellation removes its ticket.

This is a soft admission policy, not an OS memory ceiling. It covers registered provider leaders, not compiler children,
detached descendants, transient allocation peaks or unregistered startup intervals. Missing counters or uncertain
identity remain `unknown` with `rssBytes:null`; count limits continue to apply. The defaults require bounded candidate
measurements and platform qualification before a production claim. A 15–30 second idle sample measures short-term CPU,
RSS and process stability; it does not prove ten-minute idle retirement.

## Recovery and rollback

Transport cleanup uses the existing owned POSIX process group: graceful shutdown, bounded wait, termination and then
kill escalation. Positive drain and closed-stdio receipts are required to release capacity. An uncertain instance,
permission denial or failed drain keeps its reservation occupied/quarantined. After two session faults, reattachment
stops; status retains the bounded cause and next action. Inspect owned process trees and correct prerequisites before
restarting an idle coordinator. Never release capacity merely because a PID looks old or a leader exited. Windows
process-tree containment and deliberately detached descendants remain unqualified.

Profile, bootstrap, admission, proposal and apply-journal schemas are independently versioned. Unsupported versions or
unknown mutable ledger fields refuse before rewrite, including status, acquisition and release. Keep the original bytes
and use a supporting client or restore a separately verified compatible configuration. Do not clear an incompatible
ledger, migrate unknown records or remove recovery files to make an older binary start. Derived caches can be rebuilt
only when identified separately from profiles, user content and recovery records; these operations do not provide a
recursive semantic-directory cleanup command.

Analysis attachment identities can change with compiled runtime bytes. Source-writer authority remains the same
OS-account namespace and `threadnote-writer-v1` protocol across homes, overlapping roots and runtime generations. A
protocol bump must not create a second source-writer authority. Existing `semantic change status` and `semantic change
recover` reconcile the original operation with its private writer handle; recovery never replays writes or overwrites
later user edits. Unknown/indeterminate operation evidence and successful acknowledgements survive failed retries and
rollback. Disable and setup never retire that authority or reinterpret its journals.
