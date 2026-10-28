---
name: dev-plan
description: Turn approved feature intent into a code-grounded architecture and verifiable implementation phases connected to Threadnote memories. Use after dev-spec or for a requested implementation plan; discussing this skill does not start a plan.
---

# Dev Plan

The orchestrator owns handoff memories. Background agents report results and artifact links directly; they do not store handoff memories. Include this boundary in delegated prompts.

Resources: `{{THREADNOTE_SKILL_ROOT}}`; bundle: `{{THREADNOTE_BUNDLE_ROOT}}`. Use these pinned roots for linked files and generation identity. In an unrendered checkout, use this skill directory and its parent. Start with the [native bootstrap]({{THREADNOTE_BUNDLE_ROOT}}/dev-cycle/references/native-bootstrap.md).

Use the installed Threadnote workflow-automation JSON interface as the authority for schemas and actions. Retrieve only the capability and command schema needed now. Do not reproduce full schemas, use legacy local scripts, or invent request fields. Runtime receipts, compare-and-swap, approval, and readback govern persistence.

1. Start with `threadnote-context` and repository guidance. Prepare and verify the current checkout’s ready graph before unfamiliar graph discovery; then read the ready spec, bounded outlines, relevant sections and source evidence. Use `threadnote-code-graph` only for unfamiliar relationships or evidence gaps. Use `threadnote-memory` to verify and pin applicable decisions and record scoped no-match results.
2. Resume or import the exact approved spec revision. Preserve its requirements, scenarios, constraints, decisions, and exclusions. Inspect the relevant current code before proposing components. Produce distinct current and target architecture diagrams and phases that name outcomes, scope, dependencies, acceptance, and real checks.
3. Keep routine implementation choices open. Record considered alternatives and their rationale in the durable plan. Use the native challenge packet to classify design risk: record a justified routine skip, otherwise send it to one separate challenger before final review. The challenger returns at most two high-level alternatives with evidence and tradeoffs; the orchestrator records an accept/reject/adapt judgment and rationale against approved intent. Do not replace native authoring’s durable alternatives with a separate optional artifact.
4. Validate scenario coverage, source citations, dependencies, and phase boundaries. A meaningful private draft must be saved and read back before pausing. Ready status requires current evidence, explicit approval of the exact plan intent, and any required independent review. Existing user authorization persists; do not ask generic permission or “continue?” again.
5. Export the persisted plan through the native workflow for `dev-cycle`, preserving identity and bindings. Export does not authorize publication. Keep context and run identity stable through retries; recover interrupted writes instead of starting over.
6. Close out through the native workflow only after all planned phases and final combined-source acceptance are verified. Preserve full rationale and implemented choices in linked durable knowledge, independently read back every output, and retire only drafts owned by the run. Personal cloud content stays task-local until exact publication approval and verified native publication.

See [contract]({{THREADNOTE_SKILL_ROOT}}/references/contract.md) for planning invariants, [native authoring]({{THREADNOTE_SKILL_ROOT}}/references/native-authoring.md) for the bounded JSON workflow, and [review]({{THREADNOTE_SKILL_ROOT}}/references/review.md) for independent challenge. Keep the handoff concise and evidence-backed.
