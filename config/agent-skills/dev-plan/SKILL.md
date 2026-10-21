---
name: dev-plan
description: Create or revise a code-grounded feature development plan in Threadnote, with separate current and target architecture diagrams and connected, verifiable implementation phases. Use for feature planning and design before implementation; discussing this skill does not start a feature plan.
---

# Dev Plan

Resource directory: {{THREADNOTE_SKILL_ROOT}}

Bundle directory: {{THREADNOTE_BUNDLE_ROOT}}

When these placeholders are rendered, use those absolute immutable resource roots. For an unprojected source `SKILL.md`, resolve this skill’s resource root from its containing directory and discover related skill roots through the host catalog. Directory-style `SKILL.md` and flat host entrypoints may have different locations; use the companion resource tree containing `scripts/` and `references/`. Resolve related skills through that same catalog and preserve their explicit resource roots. Run Python 3.10+ on POSIX or native Windows (`python3` on POSIX; `py -3` or `python` on Windows). Shell examples use POSIX quoting and line continuations; on PowerShell pass the same argument list with `&` for a quoted executable and use PowerShell continuation syntax or one line. Keep writable run state outside installed skill resources.

Produce a plan another agent can implement without rediscovering important decisions. Threadnote is authoritative; local files are working drafts or generated previews. Planning does not start implementation or authorize publication.

## Required persistence

On desktop, store the root plan, current and target architecture, phases and navigation indexes as private **durable** Threadnote memories, including drafts. Durable retention does not make a proposed design approved or implemented; preserve its explicit readiness and verification state. These are requested task artifacts, so save them directly without a separate Knowledge Delta approval. Keep the session handoff separate.

Once the draft has valid structure, run `save --draft` before presenting it for approval or pausing with substantive work. After approval or a requested revision, save the exact resulting plan in the same turn before handing off to dev-cycle or reporting completion. If a ready save is blocked by review, open questions or current citations, save a draft and identify the remaining gate. Never defer artifact storage until implementation closeout.

Completion requires verified child/root readback and save receipts. Return the actual `threadnote://` root URI and saved readiness; local files, previews, a proposed save command or a session handoff are insufficient. Recover failed or interrupted writes without claiming completion. Personal cloud's task-local save is not durable—disclose the limitation and follow its profile contract without silently publishing private artifacts.

## Workflow

When the task has an approved dev-spec, read its pinned root and artifacts instead of restarting the behavioral interview. Use `dev_spec.py export-plan` followed by `dev_plan.py from-spec`; preserve feature/requirement/scenario identities and upstream obligations. Discover the installed dev-spec path from the skill catalog. Read its `references/workflow.md` for the shared contract; an import initializes an incomplete plan, not a finished design. Standalone planning remains supported.

1. **Understand and scope.** Establish the outcome and constraints. Use installed `threadnote-context` for the initial `context_brief` with task and absolute `callerCwd`. Read applicable repository instructions. Define the affected area using source and `threadnote-code-graph` for unfamiliar relationships; exact paths go directly to source. Respect graph coverage and freshness.
2. **Recall after scoping.** Use `threadnote-memory` to recall decisions, constraints, prior attempts and preferences with project, cwd and scoped task/path/symbol terms. Read useful pointers and relevant typed one-hop neighbors. Verify current claims in source. Distinguish reusable constraints from historical or task-specific instructions. Pin actually used memories with the satellite. Each artifact must directly reference the relevant recalled memories through native Threadnote relations. Empty relevant context is valid; do not attach unrelated results.
3. **Explain the current system.** Read the implementation, meaningful callers/consumers, tests and contracts for the affected flow. Produce a separate **current architecture** artifact: concise ownership/runtime diagram, key invariants, verified source anchors and consequential unknowns. A file list is not understanding. For greenfield work, show the integration boundary or explicitly state that none exists.
4. **Resolve consequential choices.** Interview adaptively, usually one or two questions at a time, with recommendations and concrete tradeoffs. Do not ask what code can answer. Compare structurally different designs when complexity, ownership or rollout materially differs. Resolve technical unknowns with a bounded read-only investigation or disposable experiment; record its result and limits.
5. **Describe the final solution.** Produce a separate **target architecture** artifact: final structure and behavior, key contracts, decisions and rationale. Prefer Mermaid flow, sequence, state or ER diagrams. Distinguish existing, modified, new and removed components. Cite current code through native `codeRefs`; proposed components have planned paths, never invented graph handles.
6. **Plan the transition.** Specify outcomes, affected code, key contracts and verification; leave routine implementation choices open. Split large work into independently verifiable outcomes, preferably safe PR boundaries. Each prefix must preserve a working system. Use a dependency DAG; a chain is a valid DAG. Multi-phase plans store each phase separately; one phase stays in the root. Map requirements to phase acceptance. Include compatibility/migration sequencing when relevant.
7. **Validate and review.** Use the satellite for mechanical checks and previews. Substantial plans (multiple phases, significant ownership/contract changes, migration or consequential uncertainty) get one independent review following [review.md](references/review.md). The reviewer is quiet and returns only its final artifact. Fix material findings; a material revision may get one targeted follow-up. Avoid endless review or model self-grades as proof.
8. **Save and hand off.** Complete the required durable artifact save with native citations and typed links. Observed architecture is factual context; target architecture and execution plans retain their proposed state. The satellite writes children before the root, verifies readback and records receipts. A partial write is not a stored, ready plan. Finish with the separate private `threadnote-memory` handoff: saved root URI, readiness, checks, limitations and next step. Sharing and unrelated durable knowledge promotion retain their existing authorization rules.

## Satellite

Python 3.10+ on POSIX or native Windows and the installed `threadnote` CLI support persistence. Use MCP for semantic graph/context work and the satellite for repetitive mechanics. Commands use structured files, not shell-interpolated memory text.

```sh
python3 "$SKILL_DIR/scripts/dev_plan.py" inspect --repo "$REPO" --path src/area --path tests/area --out "$RUN/scope.json"
python3 "$SKILL_DIR/scripts/dev_plan.py" init --scope "$RUN/scope.json" --id feature-name --project project --title "Feature name" --objective "Observable outcome" --out "$RUN/plan.json"
python3 "$SKILL_DIR/scripts/dev_plan.py" pin --uri "$MEMORY_URI" --out "$RUN/source.json"
python3 "$SKILL_DIR/scripts/dev_plan.py" validate --plan "$RUN/plan.json"
python3 "$SKILL_DIR/scripts/dev_plan.py" render --plan "$RUN/plan.json" --out "$RUN/preview"
python3 "$SKILL_DIR/scripts/dev_plan.py" save --plan "$RUN/plan.json" --state "$RUN/receipts.json" --draft
python3 "$SKILL_DIR/scripts/dev_plan.py" review-packet --plan "$RUN/plan.json" --out "$RUN/review-input.json"
python3 "$SKILL_DIR/scripts/dev_plan.py" save --plan "$RUN/plan.json" --state "$RUN/receipts.json" --review "$RUN/review.json"
```

Read [contract.md](references/contract.md) when authoring, saving, resuming or revising. New saves bind a private workflow context beside the receipts; preserve its locator and immutable helper generation through spec/plan/cycle exports. Personal Codex/Cursor cloud artifacts are task-local, and missing bound state blocks resume rather than starting a replacement binding. Desktop legacy receipts remain supported. `init` creates an incomplete draft, not a ready plan. Omit `--review` for a justified small plan. `save --draft` stores unresolved work without claiming readiness. Native citations are strict by default; `--defer-code-refs` requires `--draft` when current graph evidence is unavailable. Disclose pending anchors and finalize them before readiness.

`--mermaid-cli /absolute/path/to/mmdc` on `validate` enables actual Mermaid syntax/render verification. Without it, checks cover diagram type and fences only; report that limit. Do not install a renderer merely for a cosmetic check.

## Revision and execution boundary

Every plan includes mandatory implementation closeout: reconcile the target with actual source, bind current code-graph references including newly created symbols, preserve verified implemented architecture, then archive the obsolete baseline and completed planning artifacts. Desktop saves private durable knowledge with `scripts/closeout.py`; personal Codex/Cursor cloud uses `scripts/workflow.py` to preview an allowlisted projection to the configured authorized Git share, record explicit sharing approval, publish and verify the whole graph. Use [the closeout contract](references/contract.md#implementation-closeout). A successful native citation binding and readback must precede retirement. Relevant prior-memory links survive in the implemented architecture; archived URIs remain available as history.

`load` rebuilds a draft from a saved root. `diff` identifies changed artifacts/phases and affected descendants. Refresh source evidence when it changes. Revise affected phases within the agreed goal; ask the user about scope or key-contract changes. Preserve historical observations as history. Re-review consequential changes and save with receipts.

Dependencies describe design requirements, not scheduling or publication permission. Optional `export-dev-cycle` binds explicit delivery and branch choices into the installed dev-cycle phase format. It does not run dev-cycle, create branches, commit, push or share memories.

For spec-backed plans, use `scripts/workflow.py` at implementation closeout instead of calling architecture closeout alone. It carries actual dev-cycle acceptance evidence into verified spec/domain memories, binds current code, retires owned drafts and reconnects implemented architecture to active behavioral knowledge. The shared workflow is documented in the installed dev-spec's `references/workflow.md`. Keep the exported `spec`, `acceptanceRefs`, memory pins and completion fields intact across handoffs. Revise approved behavior upstream; revise architecture/phases here within the agreed goal.

## Artifact quality

- Current architecture explains what exists; target architecture explains the final solution; phases explain how to get there.
- Prefer a small diagram and terse contracts/acceptance over an essay. Keep consequential unknowns visible.
- Each artifact's `contextRefs` selects relevant read-and-pinned prior memories. Explain no-match cases with `contextNote`. The reviewer checks semantic relevance, not just link presence.
- Choose the few decisive native `codeRefs` per artifact, within Threadnote limits. Planned paths are distinct from existing graph anchors.
- Scripts check structure, links and freshness. Agents establish semantic understanding, requirement coverage and safe phase boundaries.
- [Sources](references/sources.md) records upstream ideas and adaptations; ordinary planning does not need to load it.
