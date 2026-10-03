---
name: threadnote-health
description: Resolve scoped Threadnote context-health decisions that automatic maintenance cannot safely complete, including ambiguous citations and conflicting engineering claims.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote health

Use for a requested maintenance session or a scoped health decision packet. Incomplete coverage during an ordinary coding
task does not authorize a corpus rewrite. Use `threadnote-context` for initial routing, `threadnote-code-graph` for unfamiliar
source relationships, and `threadnote-memory` to retrieve evidence and leave a private handoff.

Read local cases with `context_maintenance_status`, then fetch the selected `caseId` with
`context_maintenance_packet`. CLI fallback: `threadnote context maintain --action status --json`, then
`threadnote context maintain --action packet --case-id <case-id> --json`. These tools require the full local MCP toolset;
use the installed CLI when that toolset is unavailable.

Compact status retains bounded pages. Follow `page.caseNextCursor` and `page.receiptNextCursor` with the same project
and corresponding `caseCursor`/`receiptCursor` selector (CLI: `--case-cursor`/`--receipt-cursor`). An exact `caseId` or
`receiptId` status selector reads retained details. A stale generation requires restarting from the first page.

Read the selected case and its memory pointers. Confirm project, absolute `callerCwd`, evidence revision, and operations
available on this surface before editing. Refresh a stale packet. Shared or remote authority does not imply access to local
personal storage.

Packets identify the stable family/slot and exact citation or relation target, original citation provenance, content hash,
source revision, attempted recovery ladder, policy and budget. Read their bounded evidence excerpts with their hashes,
coverage and provenance. `supportsCitation=false` means current bytes need claim review; historical bytes never become
current proof. Keep excerpts bounded and verify revisions again after asynchronous reads before proposing a change.

Compare the engineering claim with authoritative current source and recoverable historical evidence. A new citation hash
does not validate old prose. An old snapshot proves historical provenance, not current source. Accept a relocation only
when the target is uniquely and exactly verified; ambiguous or fuzzy matches require a specific decision.

Choose the smallest supported outcome: restore an exact citation, correct the claim, designate an explicit successor,
classify the memory as historical, or retire it under its lifecycle policy. Preserve memory identity, unrelated body
sections, unknown metadata, useful independent anchors, and every valid relation. Unreadable targets are not absent.
Do not recreate a deleted user worktree merely to recover a reference.

Use the tool-returned revision-bound repair workflow. Apply deterministic private changes inside the session's existing
authorization. Ask only for a concrete unresolved semantic choice or an action outside that scope. Shared canonical
changes use reviewed publication; never export personal context or silently publish a maintenance outcome.

For `ownerProposal`, inspect only its exact selected canonical edits and expected shared content/base revision. This is a
read-only proposal, not local repair authorization. The owner verifies team target authority, reviews the selected shared
change through `review_session_context`, explicitly approves/applies the exact candidate, then explicitly approves
`share_propose` with applied candidate IDs and the current review revision. That exporter binds the shared Git base and
target content without publishing it. Refresh changed or unavailable base evidence before owner publication review.

Recheck the affected case and source after mutation. A successful write is not a resolved issue. Record what changed,
verified postconditions, remaining uncertainty, and the event or evidence needed next. If the evidence is unchanged and
no safe repair exists, leave one waiting/deferred outcome and stop; do not repeat the same repair or create another
failure memory. Return a specific evidence-backed choice instead of an unexplained “citation unknown”.

Do not store secrets, credentials, customer data, or raw production logs. Finish with a concise private handoff that
references the selected cases and verification. This skill does not install schedules or expand publication permissions.
<!-- END THREADNOTE USER INSTRUCTIONS -->
