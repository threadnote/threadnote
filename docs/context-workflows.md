# Threadnote 5 context workflows reference

This is the technical reference for Threadnote 5’s context lifecycle. For a first task, install Threadnote, connect one
catalog-supported coding-agent environment, and give it a normal engineering task. The installed instructions and
skills automatically start with a Context Brief and prepare closeout; you verify exact local code and review the
Knowledge Delta the agent presents. Git sharing and a second-agent proof are optional team steps after that journey.

Threadnote 5 is a source-verifiable context compiler for engineering work. Its core loop is deliberately small:

1. An agent automatically starts non-trivial work with a bounded Context Brief and cited current-code evidence.
2. At meaningful task closeout, the agent writes a private handoff and, when the task produced reusable knowledge,
   prepares an optional Knowledge Delta for review.
3. A person approves, edits, defers, or rejects each proposed change.
4. Context health and Context Check make stale or conflicting knowledge visible before it misleads another task.
5. Verified procedures provide reviewed workflows alongside factual decisions.

This release track is local-first and provider-neutral. It does not create an organization account, require an
organization service, or add agent-brand switches. Organization productization remains a separate track.

## Workset lifecycle

Use the CLI for the normal definition lifecycle. Definitions are explicit and do not build graphs; use `prepare` when
you want to publish repository evidence.

```sh
threadnote workset create checkout --project checkout-api --project checkout-web \
  --description "Checkout API and client"
threadnote workset list --json
threadnote workset show checkout --json
threadnote workset update checkout --name checkout-platform --description "Checkout platform" \
  --project checkout-api --project checkout-web --json
threadnote workset prepare checkout-platform --json
threadnote workset status checkout-platform --json
threadnote workset delete checkout-platform --confirm --json
```

Use `--clear-description` when removing a description. JSON is useful for scripts and contains the same bounded
definition, preparation, or status receipt as the human-readable command. A definition change does not build a graph;
prepare is the only lifecycle command that indexes or refreshes repositories. The seed manifest remains available for
advanced/manual workflows, but it is not needed for ordinary Workset creation and maintenance.

## One-command local setup

Preview the complete local setup plan for one catalog surface, then apply the same deterministic plan:

```sh
threadnote setup <surface>
threadnote setup <surface> --apply
threadnote setup <surface> --undo
threadnote setup <surface> --undo --apply
```

The orchestrator resolves the current Git repository, initializes Threadnote's local core, merges the seed manifest,
seeds only that project, installs or repairs the selected catalog adapter and its declared hooks, builds a current code
graph, runs structured doctor checks, and finishes with a real Context Brief. Completion requires fresh, complete graph
coverage for the one requested repository and at least one source-evidence card or contract accounted for by projection,
whether returned or reported in the nonnegative projection-omission counts.

Setup uses a built-in general repository-orientation task for that final verification brief. It is not needed to start
normal work after the agent restarts.

Preview is non-mutating. Apply writes a private `SetupReceiptV1` under `$THREADNOTE_HOME/setup/` with a deterministic
plan hash, per-operation input hashes and attempts, subsystem receipt references, and bounded recovery IDs. It never
stores task text, instructions, seed content, Context Brief content, source code, or logs. An interrupted or failed
plan can be rerun safely: completed operations are retained and only incomplete work resumes. Reapplying a completed
unchanged plan is a receipt-backed no-op and does not add another setup-completion event.

Undo is preview-first and follows the receipt's reverse dependency order. It removes only unchanged files and managed
surface artifacts that the setup receipt proves were created by setup; pre-existing manifests, integrations, and user
customizations are never rollback targets. Interrupted rollback persists its remaining undo IDs and is safe to retry.

Choose one coding-agent environment from `threadnote agents list`; the catalog calls its declared integration a surface. Catalog-only surfaces fail with their
manual guidance instead of being presented as managed. `--scope` is available for managed JSON adapters; compatibility
adapters retain their established user-scope lifecycle, and explicit `--scope user` is equivalent to omitting the flag.
This command does not configure composer, team sharing, or any organization service.

## Project guidance into agent surfaces

Threadnote can import existing repository guidance for review, then project approved durable knowledge into an
agent's native project instructions. Verified targets and explicit safety holds are declared by the canonical agent
catalog, so support stays aligned with the adapters that implement it. Native instructions remain authoritative for
the host, while Threadnote avoids creating a second canonical copy.

Preview an import and, only when explicitly applied, create or reuse a private Knowledge Delta candidate review:

```sh
threadnote guidance import <surface> --project <name> [--cwd <path>] [--apply] [--json]
```

Import never approves or publishes a candidate. Project explicitly selected active durable memories into the
adapter-declared project target with a managed block and provenance:

```sh
threadnote guidance project <surface> --project <name> \
  --memory <uri> [--memory <uri> ...] [--cwd <path>] [--apply] [--force] [--json]
```

Projection is preview-first and deterministic: source memories are ordered stably, and the managed block records
provenance and hashes. A conflict requires `--force`; even forced projection never overwrites unmanaged text.
Receipts belong to the physical project target, so agents that share `AGENTS.md` also share one block and one receipt.
Projection status distinguishes `current`, `missing`, `modified`, `stale`, and `evidence-unavailable`:

```sh
threadnote guidance status <surface> --project <name> [--cwd <path>] [--json]
```

`threadnote agents list` exposes the project-guidance status and target for each catalog entry, or the catalog's
specific reason that safe automated projection is not yet available.

Remove is also preview-first and preserves unmanaged content. `--force` is required only when resolving a managed
target conflict:

```sh
threadnote guidance remove <surface> --project <name> [--cwd <path>] [--apply] [--force] [--json]
```

Guidance drift is included in context health and Context Check, so modified or stale projections remain visible rather
than silently becoming agent instructions. A second agent surface can consume the same approved Threadnote knowledge
without maintaining separate canonical copies.

## Closeout and Knowledge Delta

Installed agent skills perform this closeout lifecycle without a special user command: the agent writes the required
private handoff, prepares the optional Knowledge Delta, and asks you to decide its candidates. The commands below are
the lower-level inspection and scripting interface.

The existing MCP tools remain the compatibility surface: `review_session_context` creates a review and
`apply_memory_candidates` applies one explicit decision. Their structured results now include a bounded
`KnowledgeDeltaV1` projection. It contains at most three items and identifies the item type, source evidence,
comparison reason, confidence, proposed destination, recommendation, and exact mutation preview.

The local CLI exposes the same review state:

```sh
threadnote closeout preview --review-id <review-id>
threadnote closeout preview --review-id <review-id> --json
threadnote closeout apply \
  --review-id <review-id> \
  --revision <revision> \
  --candidate-id <candidate-id> \
  --action approve \
  --operation create \
  --approved
```

Preview is read-only. Apply is revision-checked and requires an explicit action; approving a write additionally
requires `--approved`. Use `--edited-text` to approve an edited proposal and `--replace-uri` when replacing an existing
memory. A Knowledge Delta is not an unconditional memory write: keep personal handoffs local, and publish shared
durable knowledge only through the existing reviewed Git share workflow.

An applied durable candidate can also be exported as a provider-neutral Git proposal after a second, explicit shared
approval:

```sh
threadnote share propose \
  --review-id <review-id> \
  --revision <revision> \
  --candidate-id <candidate-id> \
  --approved
threadnote share propose ... --output ./knowledge-delta-proposal.json
```

The default prints canonical JSON and writes nothing. `--output` writes only the local artifact; neither mode creates a
branch, commit, pull request, provider object, or network request. The proposal binds the exact review revision, base
commit, configured team, portable remote repository identity, approved personal source hash, and absent-or-exact shared
target precondition. It preserves portable relations and stable shared identity, including when a personally created
candidate proposes replacing an existing shared record. Agents with the core MCP toolset can request the same read-only
artifact with `share_propose`.

## Context health

Inspect active records in one project with the read-only health command:

```sh
threadnote context health --project <project>
threadnote context health --project <project> --json
threadnote context health --project <project> --kind durable
threadnote context health --project <project> --topic <exact-topic>
threadnote context health --project <project> --finding-category citation-changed
```

Agents using the full MCP toolset can request the same bounded report with `context_health`, passing the project and
an absolute `callerCwd`. Both surfaces accept exact `kind`, `topic`, and `findingCategory` selectors. Supplied fields are
always a strict intersection: adding a field cannot widen the result. Selector text is trimmed, limited to 256 UTF-8
bytes, and rejects control characters; otherwise topics remain literal so every valid stored topic stays selectable.
The MCP adapter is read-only and does not prepare a graph or record a local value event.

The `ContextHealthReportV1` planner reports expired validity, overdue `review_after`, changed or missing code citations,
missing or inactive relation targets, exact duplicates, and contradictions or possible duplicates in pending candidates.
Its additive version-2 maintenance projection separates decisions, automatic work, historical evidence, and coverage.
Severity, confidence, and repairability are separate fields. Findings are deterministic and bounded. A citation that
has not been checked because of a batch limit contributes to coverage, rather than becoming another issue.

The health report remains read-only. Automatic maintenance uses a separate persistent worker to make proven safe,
private structural repairs and record recovery receipts. Changed engineering claims, ambiguous matches, and shared
canonical changes require review. Unavailable current evidence remains unverified; recovering an original snapshot
preserves historical provenance without certifying that the memory is correct today.

Reports are bounded. If findings are omitted, the report returns an opaque `nextCursor`; pass it as `--after` (or MCP
`after`) with the unchanged exact category/kind/topic intersection to retrieve the next deterministic page without
duplicates. Cursors are bound to the ordered filtered evidence and fail closed when invalid or stale. Partial or
unavailable semantic evidence leaves health `unknown`: surfaced findings are still actionable, but the run cannot
establish that the project is clean. Selector runs do not write a value-health snapshot, so a narrow view cannot mark
unselected findings as resolved. Kind/topic selectors exclude unrelated project-global candidate and guidance evidence;
category-only selectors may still surface matching project-global evidence.

Foreground health reads reuse background citation receipts only while the memory, repository source, published graph,
and validation policy still match. Cold or changed evidence is queued for background checks and reports the remaining work as
deferred coverage. Opening Home or another findings page does not wait for a full-corpus recovery scan; the maintenance
worker advances that scan independently.

Use the installed `threadnote-health` skill for a scoped decision that automatic maintenance cannot resolve. The agent
compares the claim with current source and historical evidence, applies an exact authorized repair, or returns a
concrete choice. Repeated runs with unchanged evidence leave one waiting outcome instead of another failure record.

Automatic maintenance resumes from local checkpoints during normal CLI, MCP, and Manager use. It processes bounded
batches fairly across projects. Inspect progress or control the same worker with:

```sh
threadnote context maintain --action status --json
threadnote context maintain --project <project> --max-records 16 --json
threadnote context maintain --action pause
threadnote context maintain --action resume
threadnote context maintain --action packet --case-id <case-id> --json
threadnote context maintain --action undo --receipt-id <receipt-id>
```

Pause is persistent. Undo uses the retained receipt and checks the current memory revision; a conflicting later edit
requires review. Automatic work never publishes shared knowledge. Manager presents decision cards, evidence coverage,
grouped waiting causes, and recent changes instead of counting every skipped citation as a failure.

The full local MCP toolset exposes `context_maintenance_status`, `context_maintain`, and
`context_maintenance_packet`. The status response provides stable case IDs; the packet binds a selected case to its
memory and evidence revisions for a scoped `threadnote-health` session. Automatic local maintenance also runs when
the core toolset is selected. Explicitly scoped or remote read-only sessions do not acquire local maintenance authority.

Preview the bounded repair plan separately from the read-only health report, then apply one exact proposal only after
reviewing its content-bound revision:

```sh
threadnote context repair preview --project <project> --json
threadnote context repair preview --project <project> --kind handoff
threadnote context repair preview --project <project> --finding-category citation-changed
threadnote context repair apply \
  --project <project> \
  --kind handoff \
  --proposal-id <proposal-id> \
  --revision <revision> \
  --approved
```

Apply must repeat the exact normalized selector used for preview, including every supplied category, kind, and topic.
For a continued page, this includes the exact `after` cursor. Omitting or changing any part cannot rediscover or apply
the selector-bound proposal.

Only personal durable, handoff, and incident records receive automatic archive proposals. A relation to a direct
personal URI proven missing or inactive can produce an exact relation-removal proposal. Shared targets and stable
identity aliases remain review-only because their liveness is not one local URI precondition; preferences, smoke
records, citation repairs, guidance drift, and ambiguous findings are also review-only. Apply rechecks project and
canonical content hashes, preserves stable identity and unrelated relations, and records a private recovery journal so
the same revision can be retried safely. The full MCP toolset exposes the same split through read-only
`context_health_repair_preview` and destructive `context_health_repair_apply`; the latter also requires explicit
approval.

Semantic analysis reports the two opposing records without inferring which one is stale: its left/right order is only
canonical ordering. First preview without a direction, then explicitly bind a reviewed direction to that exact report:

```sh
threadnote context repair preview \
  --project <project> \
  --contradiction-id <semantic-contradiction-id> \
  --report-revision <report-revision> \
  --stale-uri <canonical-personal-uri> \
  --current-uri <canonical-personal-uri> \
  --json
```

All four direction fields are required together. They must identify the two analyzer records in the same canonical
personal scope; omission or a stale report revision never counts as approval. Preview can then include a review-only
`supersede-memory` suggestion only when both exact personal durable records carry valid stable memory IDs. The plan
binds the direction, selected proposal IDs, proposal revisions, and both record hashes into the Knowledge Delta
approval tuple; it does not apply the semantic judgment. A downstream reviewed lifecycle operation must keep the stale
record's memory ID in `status: superseded` history with `archived_from` provenance instead of silently deleting or
overwriting it.

## Context Check

Run the provider-neutral, read-only check for one project. `--base` is optional and selects the comparison base:

```sh
threadnote context check --project <name>
threadnote context check --project <name> --base <ref> --format json
threadnote context check --project <name> --base <ref> --format sarif
```

The versioned `ContextCheckReportV2` projection combines direct citations of changed tracked or untracked paths with
exact-current reverse graph impact, active conflicts, cited-document gaps, and at most eight content-free capture
advisories. Deletions and renames include their source paths. The check never prepares a graph. Missing, stale, partial,
timed-out, or truncated graph evidence is retained as an explicit warning. When the directly observable checks find no
problem, that graph-only warning is non-fatal and does not claim transitive coverage. Reports with findings or other
required evidence gaps still fail closed. It has stable finding fingerprints and JSON/SARIF projections. Its exit
classes are:

| Exit | Meaning                                                                   |
| ---: | ------------------------------------------------------------------------- |
|  `0` | No actionable finding; any graph-only coverage gap is an explicit warning |
|  `1` | An affected, actionable finding exists                                    |
|  `2` | Invocation is invalid or required evidence is unavailable                 |

JSON contains categories, severities, repairability, and stable fingerprints; SARIF carries stable rule IDs, levels, and
fingerprints. Neither format contains memory bodies, source fragments, paths, queries, or repository identities. Do not
treat a partial or unavailable evidence result as a clean check.

`clean-with-evidence-warning` identifies the non-fatal graph-only case in JSON and text output. SARIF emits a warning
for it. Consumers may continue to parse legacy `ContextCheckReportV1` payloads, whose unavailable graph evidence retains
the former exit-2 classification.

See [Context CI](context-ci.md) for the provider-neutral job pattern and a minimal GitHub Actions example.

## Value report

Recall now surfaces local feedback in the normal result workflow. In Manager, every ranked pointer offers `Useful`,
`Wrong`, `Pin`, `Dismiss`, and `Applied`; `Applied` means the item materially informed a plan or change rather than only
looking relevant. MCP recall responses advertise the same `recall_feedback` actions. CLI users can record one directly:

```sh
threadnote recall-feedback <threadnote://uri> --query '<original query>' --action applied --project <project>
```

Only a SHA-256 query fingerprint is stored. Pins require a project scope. Applied feedback is independently counted,
deduplicated, and decayed; existing v1 feedback remains readable.

The local value report is count-only, visible in Manager, and works independently of telemetry:

```sh
threadnote value report
threadnote value report --project <project> --period 14 --json
threadnote value report export --project <project> --period 14
threadnote value report export --project <project> --period 14 --apply
threadnote value report retention --days 90
threadnote value report retention --days 90 --apply
threadnote value report delete --feedback --events --exports
threadnote value report delete --feedback --events --exports --apply
```

`ValueReportV1` summarizes a bounded period of Context Brief attempts, code-anchor coverage, estimated tokens,
follow-up operations, recall feedback, Knowledge Delta outcomes, health activity, and setup activation outcomes. Setup
metrics include applied starts, terminal failures, completions, supported-agent reuse, and median time to the first
verified Context Brief. Project filtering affects local aggregation only; the project label is not emitted in the
report. The report has `scope: local`.

Retention and deletion are preview-first. `retention` reports how many feedback and value events a one-time policy
would remove, while `--apply` performs that exact bounded prune. `delete` requires explicit categories (or `--all`)
and removes nothing until `--apply`; feedback, count-only value events, and explicit export bundles can be selected
independently. The Manager Value view exposes the same local report, preview, and apply controls.

A fresh successful `setup <surface> --apply` or direct `agents install <surface> --apply` contributes one setup
completion. Each setup apply that enters work contributes one start and then either a failure or a completion timing;
hard interruption can leave a start without a terminal event. Reusing an already-current supported surface, or
installing a second distinct supported surface, also contributes one reuse count. Preview, undo, repair, remove, and
receipt-backed idempotent setup operations do not start a setup attempt, and the local value ledger stores no surface
identifier.

No query text, memory text, source code, paths, repository names, stable user ID, or raw logs are part of this report.
Telemetry remains separately disabled by default and follows the consent contract in [Optional anonymous telemetry](telemetry.md).

`value report export` prints the exact closed `threadnote.value-report-export.v1` design-partner bundle by default and
writes nothing. `--apply` stores the same bounded field set as a private, content-addressed JSON file under
`$THREADNOTE_HOME/exports/value-reports/` and prints its local path. The bundle wraps only `ValueReportV1` aggregate
fields plus its export schema, type, and version; project filters affect selection but never appear in its content or
filename.

## Memory schema v5 maintenance metadata

Memory documents may now carry two optional maintenance fields:

```yaml
owner: platform-team
review_after: 2026-12-31
```

`owner` is an opaque person or team label, not an organization identity. `review_after` is an ISO calendar date or
canonical ISO instant. The
fields support health triage; they do not change authority, lifecycle, relation, or code-citation semantics. Existing
v4 memories remain readable and can be migrated deterministically to v5 without inventing either field. Review or
retire records explicitly; Threadnote does not silently renew stale knowledge.

## Verified procedures

Procedures remain versioned shared artifacts, not a new memory kind. Manifest schema v2 records an artifact ID and semantic
version, SHA-256, compatible capability/surface IDs, owner and review date, dependencies, a bounded summary and task
keywords, a stable or preview rollout percentage, verification commands or fixtures, and related durable memory IDs.
A successful receipt binds verification to the exact manifest hash. Stable rollouts require stable semantic versions.
Schema v1 manifests remain valid for local verification and status, but publication and Context Brief admission require
the reviewed discovery and rollout metadata in v2.

Verify an author-selected local manifest with a preview by default:

```sh
threadnote procedure verify <manifest> --json
threadnote procedure verify <manifest> --apply --artifact <file> \
  --fixture smoke=fixtures/smoke \
  --fixture integration=fixtures/integration
threadnote procedure verify <manifest> --apply --artifact <file> --dry-run
```

Execution requires both `--apply` and `--artifact <file>`. `--fixture id=path` may be repeated. `--preview` or
`--dry-run` overrides `--apply`, so those modes never execute commands or write. Verification is bounded and local;
downloaded or otherwise untrusted procedures are never executed automatically.

Inspect status without mutation:

```sh
threadnote procedure status <manifest> --artifact <file>
threadnote procedure status <manifest> --artifact <file> \
  --receipt <receipt.json> --surface <surface-id> --capability <capability-id> \
  --available-manifest <newer-manifest> --json
```

Status is read-only and reports `current`, `incompatible`, `locally-modified`, `unverified`, or `update-available`.
Update detection is explicit and local: pass a separately acquired manifest with `--available-manifest`; status never
downloads or executes it.

Publish only exact current verification evidence into a configured Git share. Preview is the default and is read-only:

```sh
threadnote procedure publish <manifest> --artifact <file> --receipt <receipt.json>
threadnote procedure publish <manifest> --artifact <file> --receipt <receipt.json> \
  --apply --approved --proposal-id <preview-id> --push
```

Publication rechecks the receipt, manifest, artifact hash, secret/local-path scrubber, selected team, and exact proposal
under the shared-repository lock. Inputs must be regular, non-symbolic-link, BOM-free, NUL-free strict UTF-8 text: manifests and
receipts are capped at 256 KiB and the artifact is capped at 1 MiB. It stores the exact text bytes as three immutable
files under a stable artifact-ID/version path and refuses a same-version content conflict; unrelated Git files and index
entries are not committed or rewritten. Push is separately explicit. MCP exposes the same boundary as
`procedure_publish_preview` and `procedure_publish_apply` in the full toolset; the default bounded core toolset uses the
CLI so adding publication does not inflate every agent's startup schema.

Context Brief can admit at most four task-relevant, currently verified procedures for the active catalog surface. It
matches only capabilities that the public agent catalog marks managed, applies deterministic cohort rollout, selects
the highest admitted semantic version, and requires an exact dependency closure. Dependency metadata precedes its
root procedure. The brief contains only bounded reviewed metadata and `verified-procedure-git-share` provenance—never
artifact bodies or verification commands—and downloaded procedures are never executed automatically. Use
`threadnote context brief ... --surface <catalog-selector>` to override the runtime surface explicitly.
Procedure-bearing briefs use Context Brief response schema v4, projector schema v4, and agent-view schema v2. Older
wire versions remain readable but reject a procedure field instead of silently dropping it. Bounded discovery records
`procedure-evidence-unavailable`, `procedure-evidence-truncated`, or `procedure-version-conflict` coverage gaps when it
cannot establish a complete trustworthy procedure set.

## Trust boundary

The canonical source remains local files and the user-configured Git share. Previews describe exact proposed bytes but
do not mutate canonical memory. Applies are guarded by optimistic revisions and content preconditions. Sharing keeps
the personal source until scrub, verification, commit, and push succeed; credentials, customer data, local paths, and
raw production logs must never be stored in memory or exported. These workflows do not replace repository review,
CODEOWNERS policy, or human judgment about whether a cited interpretation is correct.
