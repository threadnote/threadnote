---
name: dev-plan
description: Turn approved feature intent into a code-grounded architecture and verifiable implementation phases connected to Threadnote memories. Use after dev-spec or for a requested implementation plan; discussing this skill does not start a plan.
---

# Dev Plan

Use Threadnote's current task authoring contract. Prefer MCP `workflow_task_author`; the CLI equivalent is `threadnote workflow-automation task-author`. Check `threadnote workflow-automation task-author --help` for the current operation options. Do not use raw workflow-automation JSON or invent fields. Supply substantive plan content; runtime owns metadata and receipts, while returned opaque references carry continuations.

Read the exact approved spec revision and current relevant source. Preserve requirements, acceptance, constraints, decisions, and exclusions. Describe current and target architecture, dependencies, phase outcomes, owned scope, acceptance, and checks. Keep routine implementation choices open; record material alternatives and rationale. Use the design challenge when risk warrants it, capturing the evidence-based judgment. Diagrams are optional.

Save against the current authoring reference and independently read back completed output. Use a returned `jobRef` and its `status`/`result` only when the current capability advertises the job operation; resume or cancel with that same reference. On ambiguity, inspect the existing operation before any new mutation. Present the exact full plan before recording the human's actual decision and any required independent review. Approval already recorded remains valid; do not ask generically again. Export/admit only through the current authoring operation and returned reference. Do not write orchestrator handoff memories.
