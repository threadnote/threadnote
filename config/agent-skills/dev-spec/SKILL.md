---
name: dev-spec
description: Define and approve feature behavior, requirements, acceptance scenarios, domain concepts, and external contracts in connected Threadnote memories, then hand approved intent to dev-plan. Use before implementation planning or to revise a specification; discussing this skill does not start one.
---

# Dev Spec

The orchestrator owns handoff memories. Background agents report results and artifact links directly; they do not store handoff memories. Include this boundary in delegated prompts.

Resources: `{{THREADNOTE_SKILL_ROOT}}`; bundle: `{{THREADNOTE_BUNDLE_ROOT}}`. Use these pinned roots for linked files and generation identity. In an unrendered checkout, use this skill directory and its parent. Start with the [native bootstrap]({{THREADNOTE_BUNDLE_ROOT}}/dev-cycle/references/native-bootstrap.md).

Use the installed Threadnote workflow-automation JSON interface as the authority for schemas and actions. Retrieve only the capability and command schema needed for this step; do not copy full schemas into prompts or invent fields. Keep private drafts in the native run. Runtime receipts, compare-and-swap, approval, and readback govern persistence.

When `capabilities.operations` includes `job`, use it for a heavy supported authoring save from clean committed source: discover the job command schema, submit the exact save work once, retain its `jobId`, and inspect `status`/`result`. `accepted` means durable admission; wait for `completed` and independently load/read the saved root before ready or export. Apply the same flow to supported heavy closeout prepare/finish and retain publication guards. Cancel or resume with the same ID; use synchronous actions for unsupported or dirty source.

1. Start with `threadnote-context` and repository guidance. Prepare and verify the current checkout’s ready graph before unfamiliar graph discovery; then read bounded outlines, sections and evidence. Use `threadnote-code-graph` only for unfamiliar relationships or evidence gaps; exact known paths can be read directly. Use `threadnote-memory` to find relevant decisions, verify and pin those used, and record scoped no-match results.
2. Interview only where behavior is undecided. Separate verified facts, user decisions, and assumptions. Define stable requirement IDs and observable Given/When/Then acceptance scenarios. Keep implementation choices for planning. Capture considered alternatives and rationale in the durable authoring artifacts; this is part of native authoring, not an optional afterthought.
3. Use the native authoring actions to inspect scope, create or resume the draft, validate, render, and review it. Keep citations current. Add domain, workflow, or contract artifacts only when they clarify behavior; diagrams use raw Mermaid.
4. Before pausing, persist a meaningful private draft and verify native readback. A scaffold without useful requirements and acceptance is not a durable draft. Resume with the same run and pinned generation; recover interrupted writes instead of starting another run.
5. Present the concise acceptance summary, material alternatives, and unresolved decisions. A ready spec requires explicit human approval of the exact current intent and any required independent review; silence or reviewer agreement is not approval. If approval is already authorized and recorded, do not ask again. Save the approved revision and verify root and child readback before handing it to `dev-plan`.
6. Preserve approved behavior through implementation. At closeout, use the native closeout flow to create current-code-backed behavior and implemented-architecture knowledge, read it back independently, and retire only drafts owned by this run. Personal cloud work remains task-local until the user approves the exact publication and the runtime verifies it.

Use [review]({{THREADNOTE_SKILL_ROOT}}/references/review.md) for an independent spec review and [workflow]({{THREADNOTE_SKILL_ROOT}}/references/workflow.md) for handoff and closeout. Keep the final handoff private and concise, with verified URIs, readiness, limitations, and next action.
