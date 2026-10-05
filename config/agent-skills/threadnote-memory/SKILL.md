---
name: threadnote-memory
description: Preserve reusable Threadnote decisions and concise work handoffs after meaningful work or before transfer.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote memory

Use for memory-specific retrieval and closeout. Retrieve with `recall_context` using project + absolute `callerCwd`, then
read every relevant `threadnote://` pointer with `read_context`; pointers are not evidence until read.

Close out in order:

1. Always write the required private handoff directly with `remember_context(kind=handoff)`, e.g.
   `remember_context({"kind":"handoff","project":"threadnote","topic":"active-task","callerCwd":"/abs/repo","text":"Status, checks, blockers, and next steps."})`.
   Prefer labeled `task`, `decisions`/`invariants`, `verification`, `blockers`/`risks`, and `next_step` fields so a fresh
   agent can resume without rereading the full record.
   Only add `observed`, `anchors`, `attempted`, `unresolved`, and `avoid_repeat` fields from direct evidence.
   Use stable project/topic + `replaceUri`; omit `keywords` and `regenerateKeywords` for handoff writes. On replacement,
   `clearKeywords` is the only keyword control and removes preserved legacy keywords.
2. Only when the session produced reusable durable knowledge, preview a five-field Knowledge Delta (`decisions` +
   `rationale`, `constraints`, `verificationPerformed`, `knowledgeInvalidated`, `unresolvedRisks`) with a complete
   `review_session_context` call containing task, outcome, project, `callerCwd`, `sourceCommit`, and those fields. Candidates
   need `sourceCommit`, `sourceSessionId`, or an evidence pointer.
3. Treat the Knowledge Delta and returned candidates as one optional review lifecycle. Present them and call
   `apply_memory_candidates` only after explicit `approve` (optionally with `editedText`), `defer`, or `reject`; without a
   user decision leave candidates unapplied. If no reusable durable delta exists, stop after the handoff. Never auto-apply
   or auto-share proposals.

Use `kind: durable` for reusable decisions/contracts and `kind: handoff` for status/checks/blockers/next steps. Stable
identities + `replaceUri` prevent duplicates. Confirm before durable sharing. Author `relations` only from read memories or
explicit review evidence; a replacement supplies the complete set, so carry forward every still-valid relation.

For code-work handoffs, put 1-4 key changed paths or graph handles in `codeRefs`; without citations compact exact-current
resume cannot activate. Cite verification. Current writes use `citationPolicy: "require-current"` or
`--require-current-code-refs`; private pending anchors use `citationPolicy: "defer"` or `--defer-code-refs`, then
`finalize_code_refs` or `threadnote finalize-code-refs`. Replace unresolved locators; never share pending anchors.
Publish approved durable memory with `share_publish`; use `share_propose` only for applied reviewed deltas.

Maintenance: `threadnote context check --project <name>` checks direct citations. Health uses
`context_health`, `context_health_aggregate`, `context_health_repair_preview`, `context_health_repair_apply`,
`context_metadata_preview`, `context_metadata_apply`, and `context_health_schedule`. Record `recall_feedback`; inspect
`threadnote value report`. `procedure_publish_preview` precedes approved `procedure_publish_apply`; verify with
`threadnote procedure verify <manifest>`. Use `threadnote guidance import`, `threadnote guidance project`,
`complete_activation_retrieval_proof`, and `threadnote_guide`; procedures never auto-execute and tool-returned actions guide
uncommon recovery.

Do not store secrets, credentials, customer data, or raw production logs. Never publish handoffs/preferences, overwrite
conflicting changes, or force synchronization without explicit approval.

<!-- END THREADNOTE USER INSTRUCTIONS -->
