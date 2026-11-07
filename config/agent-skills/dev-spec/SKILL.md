---
name: dev-spec
description: Define and approve feature behavior, requirements, acceptance scenarios, domain concepts, and external contracts in connected Threadnote memories, then hand approved intent to dev-plan. Use before implementation planning or to revise a specification; discussing this skill does not start one.
---

# Dev Spec

Use Threadnote's current task authoring contract. Prefer MCP `workflow_task_author`; the CLI equivalent is `threadnote workflow-automation task-author`. Check `threadnote workflow-automation task-author --help` for the current operation options. Do not call raw workflow-automation JSON, invent fields, or create metadata, receipts, hashes, or version copies; provide substantive business content and use returned opaque references.

Start/resume authoring with `start`, then `read` the current document. Save changes against its current `authoringRef`; use `job` only when the current capability advertises it, retain its returned `jobRef`, inspect `status` and `result`, and independently read back completed output. On ambiguity, inspect/resume that same reference; do not retry as a new mutation.

Keep the draft private and substantive. Define stable requirements and observable acceptance scenarios; separate verified facts, decisions, and assumptions, and preserve material alternatives and rationale. Add domain or contract detail when useful; diagrams are optional. Present the exact full current content before recording the human's actual `approve`, `reject`, or `defer` response. Reviewer agreement is not user approval. Use only the current contract's required independent document review; do not repeat an already recorded human decision. Save and read back the approved document before handing it to planning. Do not write orchestrator handoff memories.
