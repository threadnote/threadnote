---
name: threadnote-context
description: Load relevant Threadnote decisions, handoffs, and graph-backed context before non-trivial work.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote context

Own the initial route for non-trivial repository work. Call MCP `context_brief` with task, absolute `callerCwd`, and mode
(`brief`, `locate`, `trace`, `impact`, `explain`, or `resume`); fallback:
`threadnote context brief --cwd <cwd> --task <task>`. Add known canonical `codeRefs` (repository-relative POSIX paths or
exact `cgs_` IDs). This is the Context Brief lifecycle.

Same active session/native context can continue without repeating brief/recall unless the work state is stale/missing, after
compaction/handoff/new agent, or the user explicitly asks. After handoff/new session use `mode=resume`; carry task, decisions,
verification, blockers, and next step, not history.

For memory retrieval/closeout use `threadnote-memory`, which owns `recall_context`, `read_context`, and handoff. Pointers
are not evidence until read. For graph work use `threadnote-code-graph`; routine exact-path/literal checks may skip it.

Reads: omit `responseFormat` for schema-aware text-only `agent` output; `read_context` adds non-duplicated metadata. Budgets
apply after formatting/truncation. Request `dual` for canonical structured content and inspect older schemas. Use
`memoryRefs`/typed `relationTypes` only for deliberate one-hop navigation. Follow citations through current graph/source;
historical or bounded results are provenance, not proof. Rerun retained selectors narrowly, inspect `graph-status`, and
never tight-poll active/queued/deferred refreshes.

If project coverage is partial, ambiguous, or excludes a path, follow its action; never silently widen. If unavailable,
disclose and search narrowly. Carry consequential anchors into the handoff.

<!-- END THREADNOTE USER INSTRUCTIONS -->
