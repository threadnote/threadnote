# Memory-to-code citations

Threadnote 4.4 can bind a durable memory or handoff to exact file or symbol evidence from the current code graph. The
stored citation records what Threadnote observed at write time. A Context Brief later checks that immutable evidence
against an already-ready current graph and returns a disposable validation receipt.

Code citations are optional. Existing uncited memories remain recallable after upgrading.

## Consolidation in Manager

Consolidation reviews evidence against the final draft, one paragraph at a time. Choose direct support, context only,
or explicitly unsupported for each paragraph. For supported paragraphs, select the source fragments and the individual
code citations or relations that apply. Editing the draft clears its reviews, and unresolved reviews block Apply.

Only selected direct support becomes active citations and relations. The result also stores the source revision hashes,
captured fragments, and review decisions as derivation history. Those retained fragments remain inspectable after source
cleanup. More than eight selected citations, sixteen selected relations, or the bounded provenance budget blocks Apply;
split the consolidation or revise its evidence selection explicitly.

Apply saves and verifies the result before cleaning up sources. A changed source revision produces a conflict. Cleanup
retries reuse the saved result and its deterministic archives; select the result and use **Resume saved source cleanup**
after a Manager restart. An active relation to an input keeps that input available. Shared sources require explicit
cleanup approval.

Consolidation provenance uses memory schema v6. Older writers refuse to rewrite these results; use an upgraded writer
to preserve the reviewed evidence.

Derivation history is personal workflow provenance and is excluded from shared publication, ingest, and replacement
payloads. Shared copies keep the approved prose, portable active citations, and stable memory relations allowed by
the existing sharing policy. Citation refreshes and relation removals on a private consolidated result require a new
evidence review; health repair cannot change those active bindings while retaining the original receipt.

## Organization remote Context Brief v1

The organization HTTP composer has a deployment-scoped, read-only `context_brief` v1 projection. It is not a
replacement for the repository-local Context Brief. It accepts a task, authorized project, and an optional list of up
to eight canonical `{repositoryId, path}` anchors. The remote service converts each anchor into an opaque selector and
uses it only to rank already-authorized memories in the same share and project.

Remote links are capture-time provenance. The service does not inspect or clone the caller checkout and never reports
that a citation is current, exact, or relocated. Read the returned canonical memory, then validate its graph reference
with `threadnote-local inspect_code_graph` or a local Context Brief before relying on it. The result reports supplied
anchor coverage and gaps, keeps durable memories separate from active handoffs, and keeps the complete response within
the 800–1,500 token Context Brief budget.

The PostgreSQL backlink table is a private, rebuildable current-head index of selector digests. It excludes repository
IDs, paths, graph IDs, commits, hashes, and citation bodies. Canonical memory revisions remain authoritative: a direct
match is projected only after the service rereads the exact PostgreSQL body or Git revision and confirms the indexed
selector still occurs there. Upgrade repair uses the bounded, resumable outbox worker rather than scanning a whole
share on request or at startup. While repair is pending, the response marks unverified anchors as unresolved instead
of reporting them as unmatched; a completed bounded selector search is required before the service reports absence.

## Capture citations

The CLI accepts repeatable `--code-ref` flags on `remember` and `handoff`. Run the command from the checkout whose
current graph should be used:

```sh
threadnote remember \
  --kind durable \
  --project payments \
  --topic retry-contract \
  --code-ref src/payments/retry.ts \
  --code-ref cgs_… \
  --text "Retries preserve the original idempotency key."

threadnote handoff \
  --project payments \
  --topic retry-rollout \
  --code-ref cgr_… \
  --task "Roll out the retry contract" \
  --tests "bun test payments" \
  --next-step "Review the remaining caller"
```

The MCP tools `remember_context` and `review_session_context` accept `codeRefs`. An absolute `callerCwd` is required
when references are present:

```json
{
  "kind": "durable",
  "project": "payments",
  "topic": "retry-contract",
  "callerCwd": "/workspace/payments",
  "codeRefs": ["src/payments/retry.ts", "cgs_…"],
  "text": "Retries preserve the original idempotency key."
}
```

Pass that payload to `remember_context`. Supported references are:

- a safe repository-relative POSIX path present in the exact-current graph, which creates a file citation;
- a local `cgs_` graph handle, which normally creates a symbol citation;
- a repository-qualified `cgr_` handle, which selects its bound repository and symbol.

Callers supply locators, not hashes, status, snapshot data, or raw citation JSON. Threadnote first tries to resolve every
reference against an exact-current ready graph and derives citations internally. Capture is deduplicated and atomic.
Invalid, absent, ambiguous, or racing references fail the write; a retryable graph-readiness failure follows the
private store-now/anchor-later policy below.

Path references are graph locators, not arbitrary tracked-file readers. A tracked file that is outside the graph
inventory cannot be cited by path; choose a path or stable handle that is present in the exact-current graph.

Capture never starts or refreshes indexing. Check the graph first and prepare it explicitly when needed:

```sh
threadnote graph status
threadnote graph index --no-vectors
```

Private active writes with `codeRefs` default to store-now/anchor-later. Exact capture is still attempted first. Only
a retryable missing, stale, deferred, or racing graph-admission failure stores the active memory without citations and
stages the requested locators in the private outbox. This matches the common agent closeout path: memory storage does
not wait for graph preparation.

`--defer-code-refs` and MCP `citationPolicy: "defer"` remain accepted as explicit compatibility spellings:

```sh
threadnote remember \
  --kind durable \
  --project payments \
  --topic retry-contract \
  --code-ref src/payments/retry.ts \
  --defer-code-refs \
  --text "Retries preserve the original idempotency key."
```

```json
{
  "kind": "durable",
  "project": "payments",
  "topic": "retry-contract",
  "callerCwd": "/workspace/payments",
  "codeRefs": ["src/payments/retry.ts"],
  "citationPolicy": "defer",
  "text": "Retries preserve the original idempotency key."
}
```

Threadnote still attempts exact capture first. Only a retryable missing/stale/deferred-graph failure activates the
deferred path. The canonical active personal memory is stored immediately without citations, while the requested
locators and the caller's explicit code-reference authorization enter a private 0600 local outbox outside recall and sharing. The MCP
receipt reports `memoryStored: true`, `citationsFinalized: false`, a bounded pending count, and graph-preparation
guidance; it never exposes the locators, checkout path, or repository identity.

Use `--require-current-code-refs` or MCP `citationPolicy: "require-current"` when the memory must fail before writing
unless every locator has exact-current evidence. That strict policy also remains the default for shared writes, because
pending locators are private-only. A strict MCP failure returns a `memory-code-citation-write-recovery` receipt with
`writeApplied: false` and `indexingStarted: false`; it never starts graph preparation itself.
Inactive memories cannot own pending anchors, so they also use strict capture unless made active first.

After explicit graph preparation, Threadnote opportunistically retries matching private intents in a small,
repository/worktree-scoped batch. A successful `graph index` retries local intents, a successful `workset prepare`
retries matching Workset intents, and the next repository-local Context Brief with `codeRefs` performs a bounded
same-request retry before reading backlinks. These recovery paths never start or request indexing and never allow an
automatic failure to fail graph publication or a fail-soft Context Brief.

If an intent remains pending, call `remember_context` with the same content and the receipt's `memoryUri` as
`replaceUri`, or run the explicit repair finalizer:

```sh
threadnote graph index --no-vectors
threadnote finalize-code-refs --uri threadnote://user/me/memories/durable/projects/payments/retry-contract.md
```

The core MCP toolset also exposes `finalize_code_refs`. Automatic and explicit finalization share the same engine: it
recaptures only from an already-ready exact-current graph, verifies the original repository/worktree identity, and
uses a memory-content compare-and-swap before adding citations. The body, memory identity, creation/update timestamps,
and lifecycle remain unchanged; `source_observed_at` records the later citation-capture time. Until finalization
succeeds, Context Brief may still find the memory through ordinary task recall, but it cannot return a code-to-memory
backlink or describe the pending locator as citation evidence.

Finalization distinguishes retryable graph readiness from a locator that is absent from an exact-current graph. A
readiness result carries `recoveryAction: "prepare-current-graph"` and `retryable: true`. An absent path or symbol
carries privacy-safe `code: "code-reference-unresolved"`, `recoveryAction: "replace-memory-code-refs"`, and
`retryable: false`; replace the same memory with corrected graph-indexed `codeRefs`. The receipt never echoes the
private locator or checkout path, and the original pending intent remains available for that correction.

Replacement without code references, archive, expiration, deletion, and an explicit uncited publish cancel the
pending intent. A changed memory or repository identity becomes a bounded conflict rather than an overwrite. Deferred
anchors are supported only for active personal memories; shared and remote writes remain strict.

A newly written memory accepts at most eight citations. Each canonical citation line is limited to 8 KiB and total
citation metadata to 64 KiB.

## Capture and validation are different records

The citation persisted in schema-v4 memory is immutable capture-time evidence. It includes the repository identity,
source commit and snapshot, dirty state, extractor identity, repository-relative path, and file hash. A symbol citation
also includes its indexed locator, span, and a hash of the canonical source fragment. Threadnote derives a stable
`tncc_` identity from those fields.

Current status is deliberately not persisted in the memory. Each Context Brief computes a validation receipt for the
selected snapshot. The receipt may name the observed path and snapshot, but it is disposable and is recomputed for a
later brief. Finding a relocation never edits the original citation.

This distinction matters: a citation says which code evidence was captured. Even an `exact` receipt does not prove
that a natural-language memory is a correct interpretation of that code.

## Freshness states

Each citation receives one status:

| Status      | Meaning                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `exact`     | The same file bytes or symbol fragment remain at the captured locator.                                         |
| `relocated` | One deterministic, unique match contains the same evidence at a different path, node, or span.                 |
| `changed`   | The captured locator or unique successor contains different cited evidence.                                    |
| `deleted`   | Complete exact-current coverage finds neither the original evidence nor one deterministic relocation.          |
| `unknown`   | Validation cannot make an authoritative claim because evidence is unavailable, ambiguous, invalid, or bounded. |

Memory freshness is aggregated conservatively:

1. Any `changed` or `deleted` citation makes the memory `stale`.
2. Otherwise, any `unknown` citation makes freshness `unknown`.
3. Otherwise, `exact` and `relocated` citations make the memory `fresh`.

`relocated` therefore means the evidence survived but its stored locator is stale. Context Brief returns a
`stale-link` issue while keeping the memory fresh. Review the current locator and recapture the citation when you next
replace the memory.

Precise current evidence supersedes commit-only freshness. A memory captured at an older commit can remain fresh when
its cited bytes are still exact or uniquely relocated. Conversely, Threadnote refuses to infer `exact` or `deleted`
from a missing, stale, deferred, failed, racing, incomplete, or ambiguous graph; those cases are `unknown`.

## Context Brief v3

Run a small repository-scoped code-anchored request:

```sh
threadnote context brief \
  --task "Trace checkout retries and check the remembered contract" \
  --code-ref src/checkout/retries.ts \
  --budget-tokens 1250 \
  --json
```

The equivalent MCP input is:

```json
{
  "task": "Trace checkout retries and check the remembered contract",
  "callerCwd": "/workspace/checkout-api",
  "codeRefs": ["src/checkout/retries.ts"],
  "budgetTokens": 1250
}
```

For a prepared Workset, omit `codeRefs` in this milestone:

```sh
threadnote workset prepare checkout
threadnote context brief \
  --task "Trace checkout retries across services" \
  --workset checkout \
  --mode trace \
  --json
```

After an agent discovers code, repeat `--code-ref` up to eight times with a canonical graph-indexed
repository-relative path (no `./`, `..`, empty segment, or backslash) or an exact local `cgs_<32 lowercase hex>`
symbol. The MCP `codeRefs` input accepts one string or an array with the same eight-occurrence limit. Exact duplicates
are deduplicated; noncanonical equivalents, malformed handles, absolute paths, and `cgr_` handles fail as actionable
argument errors before graph or memory retrieval starts. Context Brief retrieves memories whose immutable citations
explicitly link to those anchors alongside the ordinary task-text recall lane. It does not infer semantic links from
nearby code. Combining otherwise valid `codeRefs` with a Workset scope remains an explicit unsupported coverage gap.
Requests with nonempty `codeRefs` emit Context Brief v3; task-only requests retain the v2 output contract.
Durable memories can optionally include four single-line fields near the start of the body:

```text
Applies to: edits to the checkout retry path
Invariant: a retry must preserve the original request identity
Avoid: replacing the identity when scheduling the next attempt
Verify: run the focused retry-state test after editing
```

When a requested code anchor directly matches an exact, current citation, Context Brief can show these as a bounded
`actionCard` alongside the memory URI and citation receipts. The card is author-supplied evidence, never an executable
instruction. Stale, relocated, unknown, and merely topical memories do not get a promoted card. Under a tight response
budget, Threadnote drops the optional card before sacrificing graph cards, memory links, coverage, or recovery steps;
read the URI for the full decision.

Claude Code users who run `threadnote install-hooks claude --apply` get a selective `PreToolUse` hook for `Edit` and
`Write`. Before an edit to an existing repository file, it injects up to two exact-current, directly cited memories
with any available action card and verification hint. Unlinked files and unavailable lookups pass through without
injection. `threadnote code-brief-hook --diagnostic` reports only a closed delivery status on stderr for troubleshooting;
it never logs file paths or memory content. This hook does not run for shell-based edits or in hosts without an
equivalent pre-edit hook.
The public task is limited to 4,096 UTF-8 bytes, repository `callerCwd` to 4,096 bytes, and project and Workset names
to 256 bytes each; MCP schema descriptions, CLI help, and validation failures expose the same exact bounds.
The v3 projection summarizes direct-link coverage as `coverage.memory.codeAnchors` with `requested`, `resolved`,
`matchedMemories`, and `complete`. When resolution is partial, `unresolvedOrdinals` identifies every failed zero-based
position in the deduplicated request without echoing its private selector; correct or remove those positions and
rerun. A directly selected memory carries `selectionBasis: "code-citation"` and may expose
bounded `codeRelations` entries with only the anchor ordinal, citation ID, file-or-symbol kind, and validation status.
The ordinary compact projection keeps the strongest relation. When multiple memories share requested anchors,
Threadnote may expose the overlap-connected current relations needed to prove that the cohort was admitted atomically;
the public array remains capped at the eight-request anchor limit.
Coverage describes explicit citations in the authorized indexed corpus, not semantic completeness; raw selectors,
repository IDs, paths, hashes, commits, and snapshots stay private.

The combined MCP text-plus-structured response and CLI projection accept `budgetTokens` or `--budget-tokens` from 800
through 1,500, defaulting to 1,250. Values below 800 are rejected before any evidence dependency runs. When graph
cards are omitted and continuation becomes `rerun-required`, both MCP result channels retain the same exact
`inspect-node` follow-up so an agent always has a bounded narrowing action instead of an unusable truncation notice.
With repository `codeRefs`, `locate` resolves the exact selected source nodes instead of allowing a task-semantic
metadata match to displace them. For `trace` and `impact`, direct imports, exports, re-exports, and tests are protected
before the graph edge limit and the first retained contract is co-ranked with that selector. Under maximum-budget
code-linked pressure, Threadnote
keeps memory, the incident direct contract, and the selector as one protected bundle when the memory has a valid stable
identity; it may omit the redundant graph card. Projected contract evidence paths are bounded to 48 UTF-8 bytes and
carry `pathTruncated: true` when shortened, so a valid long repository path cannot consume the recovery budget
silently. Modern v3 memory pointers use the bounded `threadnote://memory/<memory_id>` selector. `read_context`, CLI
`read`, MCP `resources/read`, and Manager resolve that selector only inside the caller-authorized active corpus and
recheck the live document's `memory_id` after relocation before returning bytes. The canonical storage URI therefore
does not have to fit in or survive beyond the brief. A legacy cited memory without a valid identity retains its
canonical URI when it fits; otherwise the protected bundle fails soft to a
`stable-memory-identity-unavailable` gap plus the exact graph selector. Task-only v2 output keeps canonical URIs.
When detailed citation receipts, summary, and relations are elided to guarantee the protected v3 bundle, both channels
report `citationDetailsOmitted: true`.
Coverage gaps participate in the deterministic projection too: the first gap remains visible and
`coverage.omissions.coverageGaps` reports how many additional gap codes did not fit.
Ready-graph reads use one shared two-retry budget for the whole brief and retry only storage failures explicitly marked
retryable. If the ready snapshot remains unreadable, its known ready coverage and citation fence survive and both MCP
channels retain a bounded `graph-status` diagnostic instead of returning an actionless empty graph.

Inverse citation lookup has an independent bounded selector scan. When that scan cannot exhaust a selector prefix and
the corresponding result lane remains unfilled, Context Brief adds `code-anchor-recall-truncated` to `gaps`. This is an
abstention receipt: deeper eligible links may have been omitted, so it is not evidence that no cited memory exists. A
true no-memory result requires resolved anchor coverage and no truncation gap. If
`code-anchor-recall-no-active-memory` appears alongside `code-anchor-recall-truncated`, it means no active match was
found in the examined candidates; the truncation still governs any conclusion about the unexamined prefix.
`coverage.memory.codeAnchors.complete` describes anchor resolution, so always inspect `gaps` separately for recall
completeness.

Context Brief retrieves bounded graph and memory evidence first, then validates citations for the selected
memories. Returned durable decisions and handoffs keep `freshness` beside the memory excerpt and may include
`preciseStatus`, `citationReceipts`, and related entries in `stalenessAndConflicts`. MCP `structuredContent` and
`threadnote context brief --json` retain the full v2/v3 audit projection. MCP text content and the plain CLI return
parseable `context-brief-agent-view` v1 JSON: a compact, decision-equivalent view with selected graph identities,
memory excerpts and authority/trust, citation actions, coverage gaps, issues, follow-ups, and continuation. This dual
contract supports clients that expose only one MCP result channel; consumers must not assume both channels reach the
model. The combined MCP text-plus-structured UTF-8 size is still charged to the requested response budget.
When MCP selects `responseFormat: "agent"`, the view also starts with a bounded `answer` derived only from evidence
retained in that response. A task-only `locate` brief returns a fixed useful core: two source cards when available, the
matching recovery action, and required coverage receipts. It does not spend a larger caller budget on extra cards or
optional memory and relationship metadata; the answer names at most the two retained paths. If no source card fits,
the answer explicitly says that direct evidence was not retained and mentions recovery only when a recovery action is
present. Explicit `dual` responses and the plain CLI keep their prior audit projection without this synthetic answer,
preserving compatibility for structured consumers.

Validation reads only already-ready exact-current repository snapshots. A Workset brief checks citations only in its
configured member paths and does not fan out cold builds. Missing or stale members remain explicit unknown coverage;
run `threadnote workset prepare <name>` yourself when current evidence is required.

The hard bounds are:

- 24 selected memory candidates;
- eight citations per memory;
- 96 citation validations per brief;
- 32 cited repositories;
- validation concurrency of four;
- 1,250 estimated output tokens by default and 1,500 maximum.

Work beyond a bound becomes an explicit `unknown` receipt or output omission, never a repository-wide scan or a
silent freshness claim.

## Existing v1 and uncited memories

Threadnote does not require a citation migration. Schema-v1, schema-v2, schema-v3, and unversioned memories continue
through the normal recall ranking and can appear in Context Brief. They do not receive fabricated precise receipts.

When an uncited memory has a valid `sourceCommit` and exactly one repository snapshot resolves, Context Brief retains
the existing coarse commit comparison. Otherwise its freshness is `unknown`. The memory is still returned; an upgrade
does not turn legacy recall into an empty result.

New and rewritten records use schema v4. Upgrade every writer that may replace a shared cited memory before publishing
schema-v4 citations: an older writer does not understand the repeated `code_citation` header and may drop it while
reformatting the record.

## Replacement and candidate review

Citation evidence is bound to the prose that was reviewed:

- replacement with `codeRefs` or `--code-ref` captures new evidence;
- replacement without code references clears old citations and reports `clearedCodeCitations` or a CLI message;
- citations are never silently inherited across edited prose;
- `review_session_context` captures optional `codeRefs` at review time;
- an approved candidate keeps those reviewed immutable citations rather than recapturing them during approval.

Read the old memory and current source before replacing a stale claim. Threadnote does not automatically repair a
relocated link or rewrite natural-language memory.

## Sharing restrictions

Code citations are preserved across a supported sharing boundary; Threadnote never silently strips them. A cited
memory is publishable only when all citations:

- were captured from clean committed source;
- use a portable remote repository identity; and
- contain valid canonical metadata.

Dirty-worktree, local-only, or malformed citations block publishing. Commit the cited source and recapture before
sharing. The ordinary content scrubber, preview, confirmation, and active-durable-only rules still apply. See
[Team sharing](share.md).

A memory with a private pending anchor is also blocked from publication. Prepare and finalize it first. The CLI may
instead pass `--allow-uncited-pending-code-refs` as an explicit decision to publish the currently uncited canonical
memory and discard the private intent; MCP callers can make the same decision by replacing the memory without
`codeRefs` before publication. Pending locators never cross the sharing boundary.

## Optional telemetry

Anonymous telemetry remains disabled by default and requires explicit consent for schema v6. A successful Context
Brief may report only closed local/workset scope, task-only-v2/code-anchored-v3 contract, phase timings including the
code-linked-memory lane, returned lane, bounded code-anchor coverage/gap/recovery classes, citation validation
coverage/result classes, a closed unknown reason, output truncation, and power-of-two count buckets. Deferred citation
finalization may report only its closed trigger/result and power-of-two latency/work buckets. It never exports memory
text or identity, citation IDs, tasks, paths, symbols, selectors, repository or Workset identity, commits, snapshots,
hashes, exact private counts, or raw errors. Failed and interrupted briefs or finalization passes do not emit
result-derived classifications.

Telemetry can diagnose latency, coverage, abstention, and warning trends; it cannot prove citation correctness or the
absence of stale memory. See [Optional anonymous telemetry](telemetry.md).
