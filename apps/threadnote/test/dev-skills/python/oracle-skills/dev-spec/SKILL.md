---
name: dev-spec
description: Interactively define feature behavior, requirements, acceptance scenarios, domain concepts and external contracts in connected Threadnote memories, then hand approved intent to dev-plan. Use before implementation planning or to revise a feature specification; discussing this skill does not start a feature spec.
---

# Dev Spec

Resource directory: {{THREADNOTE_SKILL_ROOT}}

Bundle directory: {{THREADNOTE_BUNDLE_ROOT}}

Use these roots for scripts and references. If unrendered, resolve the skill root through the host catalog. Resume with the run's pinned generation. Keep writable run files outside installed resources. The current helper requires Python 3.10+ (`python3` on POSIX; `py -3` or `python` on Windows).

Define behavior, domain concepts, constraints and external contracts. `dev-plan` defines architecture and phases; `dev-cycle` implements and verifies them. Approval of a spec does not authorize implementation or publication. Threadnote is authoritative; local files are drafts and previews.

## Work

1. Use `threadnote-context` for the initial brief and read repository guidance. Inspect relevant behavior, callers, tests and contracts. Use `threadnote-code-graph` for unfamiliar relationships or evidence gaps; exact known paths can be read directly.
2. Use `threadnote-memory` to recall relevant decisions and prior work. Read and verify useful results, then pin used memories. Link each artifact to relevant memories; explain scoped no-match results.
3. Interview adaptively. Separate source facts, user decisions and assumptions. Capture stable requirement IDs and observable Given/When/Then scenarios. Add domain, workflow or contract artifacts when useful. Present material alternatives and tradeoffs; the user decides behavior.
4. Use [contract](references/contract.md) and the helper's `--help` for the schema and commands. Inspect scope, initialize, validate and render. `init` is incomplete. Use current source citations; defer only for drafts. Domain/workflow diagrams use raw Mermaid. For a native run, follow [native authoring](../dev-plan/references/native-authoring.md) and require runtime `authoringVersion: 1`.
5. Save a meaningful private durable draft on desktop with `save --draft` before asking approval or pausing. Cloud saves are private task-local handoffs and may be lost with the workspace; disclose this limitation.
6. Present the acceptance summary and material optional-artifact decisions. Ready status requires actual human approval of the current intent; reviewer agreement or silence is not approval. After approval, record it with `confirm` and save that revision in the same turn. If review or citations block readiness, keep the accepted intent as a draft and report the blocker. Use an independent review for substantial specs; resolve material findings.
7. Verify child and root readback and receipts before reporting completion. Return the saved root URI and readiness. Preserve the same run context and generation for retries; recover interrupted writes rather than starting over. Keep a private handoff with URI, verification, limits and next step.

Use `load` to resume, `diff` to inspect changes, and `export-plan` to hand the pinned approved intent to `dev-plan`. See [workflow](references/workflow.md) for revision and implementation closeout. At closeout, preserve verified behavior with current code citations and implemented architecture before retiring owned drafts. Cloud publication requires a concrete preview and separate explicit sharing approval. Do not revise approved intent silently or retire unrelated memories.
