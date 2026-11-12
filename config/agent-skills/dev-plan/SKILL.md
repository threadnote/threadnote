---
name: dev-plan
description: Turn approved feature intent into a code-grounded architecture and verifiable implementation phases connected to Threadnote memories. Use after dev-spec or for a requested implementation plan; discussing this skill does not start a plan.
---

# Dev Plan

Use Threadnote's current task authoring contract. Prefer MCP `workflow_task_author`; the CLI equivalent is `threadnote workflow-automation task-author`. Check `threadnote workflow-automation task-author --help` for the current operation options. Do not use raw workflow-automation JSON or invent fields. Supply substantive plan content; runtime owns metadata and receipts, while returned opaque references carry continuations.

Read the exact approved spec revision and current relevant source. Preserve requirements, acceptance, constraints, decisions, and exclusions. Describe current and target architecture, dependencies, phase outcomes, owned scope, acceptance, and checks. Make each acceptance criterion and validation check provable at its stage; place future PR CI and merge gates in PR delivery and watch, after local validation. Keep routine implementation choices open; record material alternatives and rationale. Use the design challenge when risk warrants it, capturing the evidence-based judgment. Diagrams are optional.

When choosing phase owners, inspect dependencies and include foreseeable related E2E tests, fixtures, and shared helpers up front. Enumerate exact regular-file paths; directory and glob owners are unsupported, and implementation work packets authorize only their exact files.

Save against the current authoring reference and independently read back completed output. Use a returned `jobRef` and its `status`/`result` only when the current capability advertises the job operation; resume or cancel with that same reference. On ambiguity, inspect the existing operation before any new mutation. Present the exact full plan before recording the human's actual decision and any required independent review. Approval already recorded remains valid; do not ask generically again. Export/admit only through the current authoring operation and returned reference. Do not write orchestrator handoff memories.

When the user asks to transfer a ready approved plan to a team, use `workflow_task_author` with `command: "share"`, its current `authoringRef`, `callerCwd`, and the selected writable `team`. The result is one `sharedPlanRef`. The runtime verifies and copies the linked specification and eligible evidence before publishing that reference; the original plan, specification and active run stay private and usable. Share only with the user's requested team. A recipient starts work with `workflow_task_start` using that reference, its own checkout, installation target, local branch/base bindings, delivery mode, actual user instruction, and accepted recipient review. The recipient receives locally authored spec and plan roots and its own run; donor approval and run fields are provenance only. If source evidence differs, update and review the plan against the recipient checkout before retrying.
