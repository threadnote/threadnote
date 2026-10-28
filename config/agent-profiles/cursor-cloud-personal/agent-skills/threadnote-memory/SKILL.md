---
name: threadnote-memory
description: Store durable knowledge in an explicit Personal Cursor Cloud Git share and leave concise VM-local handoffs.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote memory in Personal Cursor Cloud

Store reusable decisions and contracts with `remember_context` and `kind: durable`. One MCP may expose several Git
shares, so pass `team` on every durable write when more than one is configured. Threadnote commits and pushes the write
only to that selected share. Use stable `project` and `topic` identities and update an existing memory with its exact
`replaceUri`; that URI must belong to the selected share.

Team environment selectors are optional restrictions. Without them, every registered writable share is available;
never infer a write target from an environment default. An exact `replaceUri` can identify its existing target share.

Relations and references on a durable write must stay within the selected share. Read targets before linking them and
use only `depends_on`, `evidence_for`, `references`, `related_to`, or `supersedes`. Shared code citations require an
already-ready exact-current graph; deferred private anchors are unavailable.

Use `kind: handoff` for status, checks, blockers, and next steps only when VM-local lifetime is acceptable. Personal
Cloud handoffs are not pushed and may disappear with the Cloud Agent. When another session must receive the closeout,
store a sanitized durable record in the intended share instead. Candidate review, separate publishing, Obsidian, and
maintenance tools are unavailable.

Never store secrets, credentials, customer data, or raw production logs. Do not write to an unconfigured share, cross
share boundaries, force synchronization, or treat a failed push as success.
<!-- END THREADNOTE USER INSTRUCTIONS -->
