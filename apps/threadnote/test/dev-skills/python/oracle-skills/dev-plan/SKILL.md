---
name: dev-plan
description: Create or revise a code-grounded feature development plan in Threadnote, with separate current and target architecture diagrams and connected, verifiable implementation phases. Use for feature planning and design before implementation; discussing this skill does not start a feature plan.
---

# Dev Plan

Resource directory: {{THREADNOTE_SKILL_ROOT}}

Bundle directory: {{THREADNOTE_BUNDLE_ROOT}}

Use these roots for scripts and references. If unrendered, resolve the skill root through the host catalog. Resume with the run's pinned generation. Keep writable run files outside installed resources. The current helper requires Python 3.10+ (`python3` on POSIX; `py -3` or `python` on Windows).

Ground an implementable plan in source and connected Threadnote memories. Planning does not authorize implementation or publication. Threadnote is authoritative; local files are drafts.

## Plan

1. If an approved spec exists, read its pinned root. Use `dev_spec.py export-plan` and `dev_plan.py from-spec`; preserve requirement/scenario IDs. The import is an incomplete plan.
2. Use `threadnote-context` for the initial brief. Read repository guidance, code, callers, tests and contracts. Use `threadnote-code-graph` for unfamiliar relationships or evidence gaps; read known paths directly.
3. After scoping, use `threadnote-memory` to recall relevant decisions. Verify claims in source, pin used memories and link relevant memories to each artifact; explain no-match results.
4. Describe current and target architecture separately. Cite exact current graph anchors or inspected paths; use planned paths for new components. Record contracts, unknowns, and material alternatives. The orchestrator judges suggestions, chooses or adapts the design, and records rationale and affected phases.
5. Define verifiable phases with outcomes, paths, contracts, dependencies and acceptance mapped to requirements/scenarios. Leave routine choices open. Plan compatibility or data migration when the feature requires it.
6. Validate structure and citations. Get an independent review for substantial plans and resolve material findings. Save a meaningful private durable desktop draft before approval or pausing. Cloud saves are private task-local and may be lost; disclose this.
7. Save the exact approved or requested revision in the same turn, before handoff. Ready status requires review when required and current citations. If blocked, save a draft and report why. Verify child/root readback and receipts; return URI and readiness. Keep the same context/generation for retries and recover interrupted writes. Keep the session handoff separate.

Use `scripts/dev_plan.py --help` and [contract.md](references/contract.md) for commands and structure. For a native authoring run, follow [native authoring](references/native-authoring.md) and require `authoringVersion: 1` from the installed runtime. Without `--mermaid-cli`, report that diagram checks cover types/fences only.

## Execution and closeout

Use `load`, `diff` and `export-dev-cycle` to resume, inspect affected work and pass explicit delivery/branch choices. Export does not create branches or publish. See [the workflow](../dev-spec/references/workflow.md) for spec-backed closeout.

Closeout verifies acceptance on final source, records implemented architecture/deviations and current citations, then preserves verified behavior before retiring only this plan's artifacts. Desktop saves private durable knowledge. Cloud requires an allowlisted preview and separate explicit sharing approval; keep private drafts until readback succeeds. See [the closeout contract](references/contract.md#implementation-closeout). Keep unrelated memories.
