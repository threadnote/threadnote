---
name: dev-spec
description: Interactively define feature behavior, requirements, acceptance scenarios, domain concepts and external contracts in connected Threadnote memories, then hand approved intent to dev-plan. Use before implementation planning or to revise a feature specification; discussing this skill does not start a feature spec.
---

# Dev Spec

Resource directory: {{THREADNOTE_SKILL_ROOT}}

Bundle directory: {{THREADNOTE_BUNDLE_ROOT}}

When these placeholders are rendered, use those absolute immutable resource roots. For an unprojected source `SKILL.md`, resolve this skill’s resource root from its containing directory and discover related skill roots through the host catalog. Directory-style `SKILL.md` and flat host entrypoints may have different locations; use the companion resource tree containing `scripts/` and `references/`. Resolve related skills through that same catalog and preserve their explicit resource roots. Run Python 3.10+ on POSIX or native Windows (`python3` on POSIX; `py -3` or `python` on Windows). Shell examples use POSIX quoting and line continuations; on PowerShell pass the same argument list with `&` for a quoted executable and use PowerShell continuation syntax or one line. Keep writable run state outside installed skill resources.

Help the user decide what a feature means. Threadnote is authoritative; local JSON and Markdown/Mermaid files are working drafts and previews. Own behavior, domain concepts, constraints and external contracts. `dev-plan` owns implementation architecture and phases; `dev-cycle` implements and verifies them. Spec approval alone does not authorize implementation or publication.

## Required persistence

On desktop, store the specification root and every domain, workflow, capability and contract artifact as private **durable** Threadnote memories, including drafts. Durability controls retention; `draft`, `ready` and verified implementation remain separate states. Saving these requested artifacts is part of the task and needs no additional Knowledge Delta approval. A session handoff is a separate memory and cannot substitute for the artifacts.

Once the draft has valid structure, run `save --draft` before requesting approval or pausing with substantive work. After an affirmative response, record the actual approval and save the approved revision in the same turn, before `export-plan`, implementation handoff or a completion response. If review or citation readiness blocks a ready save, persist the accepted intent with `--draft` and report the remaining gate; never silently leave it only in chat or local files.

Completion requires a successful save, verified child/root readback and recorded receipts. Return the actual `threadnote://` root URI and its saved state. A suggested command, preview or confirmation file is not proof of persistence. If saving fails, retain the draft/receipts, report the concrete failure and continue recovery; do not claim completion. Personal cloud's task-local storage is not durable—state that limitation and follow the profile contract without silently publishing private artifacts.

## Discover and interview

1. Use installed `threadnote-context` for the initial brief with task and absolute `callerCwd`. Read applicable repository guidance. Understand the goal and define the code/product scope before targeted recall. Inspect relevant existing behavior, callers, tests and public contracts; use `threadnote-code-graph` for unfamiliar relationships or evidence gaps. For greenfield work, state the known integration boundary and unknowns.
2. Use `threadnote-memory` to recall relevant decisions, constraints, earlier specs and reusable domain/architecture memories for that scope. Read useful results and relevant one-hop relations; verify current claims in source. Pin used memories with the satellite. Every artifact directly references the relevant recalled memories; an explained no-match is valid. A retrieved proposal is not a user decision.
3. Interview adaptively, usually one or two consequential questions at a time. Offer concrete examples and recommendations with tradeoffs. Separate source observations, user decisions and agent assumptions. Do not re-ask settled questions or ask what source can answer. Consider failure paths, permissions, compatibility and measurable constraints only where they affect behavior; do not invent targets. Resolve technical uncertainty through bounded read-only investigation or a disposable experiment before asking the user to choose.
4. Always capture stable requirement IDs and observable Given/When/Then acceptance scenarios. Add domain/data concepts, workflow/state or external-contract artifacts when they clarify the feature. Prefer concise Mermaid diagrams for relationships and transitions; retain exact text for obligations. A logical data model describes identity, cardinality and invariants, not tables or storage choices unless those are actual constraints. Compare alternatives when complexity, ownership or user experience materially differs.

## Refine and save

Use [contract.md](references/contract.md) to author the structured draft. The satellite handles inspection, hashes, traceability, previews, persistence and handoff. It cannot establish semantic completeness or obtain consent.

```sh
python3 "$SPEC_DIR/scripts/dev_spec.py" inspect --repo "$REPO" --path src/area --out "$RUN/scope.json"
python3 "$SPEC_DIR/scripts/dev_spec.py" init --id feature-name --project project --title "Feature name" --objective "Observable outcome" --cwd "$REPO" --focus "Affected behavior" --scope "$RUN/scope.json" --out "$RUN/spec.json"
python3 "$SPEC_DIR/scripts/dev_spec.py" pin --uri "$MEMORY_URI" --out "$RUN/source.json"
python3 "$SPEC_DIR/scripts/dev_spec.py" validate --spec "$RUN/spec.json"
python3 "$SPEC_DIR/scripts/dev_spec.py" render --spec "$RUN/spec.json" --out "$RUN/preview"
python3 "$SPEC_DIR/scripts/dev_spec.py" acceptance-packet --spec "$RUN/spec.json" --out "$RUN/acceptance.json"
python3 "$SPEC_DIR/scripts/dev_spec.py" save --spec "$RUN/spec.json" --state "$RUN/receipts.json" --draft
```

`init` is incomplete. Fill it through the interview; `save --draft` allows unresolved decisions once the basic structure is valid. Domain/workflow artifacts require Mermaid; other artifact kinds use diagrams where useful. `validate --mermaid-cli /absolute/path/to/mmdc` renders diagrams when an installed CLI is available; otherwise report type/fence checks only.

Substantial specs (multiple capabilities, material contract changes, migration, sensitive behavior or consequential uncertainty) get a quiet independent review using [review.md](references/review.md). The reviewer returns only its final artifact. Resolve important findings; use one targeted follow-up for material revisions.

Present the concise acceptance summary **and material optional artifact decisions** to the user. Require an actual affirmative response to the current intent before ready status; evidence-only refreshes do not require repeat approval. Never fabricate a confirmation or treat elapsed time, a preselected option or reviewer agreement as approval. After that response:

```sh
python3 "$SPEC_DIR/scripts/dev_spec.py" confirm --spec "$RUN/spec.json" --packet "$RUN/acceptance.json" --user-response "$ACTUAL_USER_RESPONSE" --out "$RUN/confirmation.json"
python3 "$SPEC_DIR/scripts/dev_spec.py" save --spec "$RUN/spec.json" --state "$RUN/receipts.json" --confirmation "$RUN/confirmation.json" --review "$RUN/review.json"
```

Omit `--review` for a justified small spec. Native code citations must bind to current source; `--defer-code-refs` is draft-only. New save receipts automatically bind a private workflow context beside the receipt; preserve that context and its pinned immutable helper generation through every handoff. Desktop legacy receipts remain supported. Personal Codex/Cursor cloud drafts are task-local; missing context is lost task state, not permission to bind a replacement. See [the persistence contract](references/contract.md#profile-binding-and-resume). Keep receipts for retries. A partial write is not a ready spec. Save a private `threadnote-memory` handoff with root URI, readiness, verification, limitations and next step. Sharing retains its separate authorization rule.

## Continue or revise

Read [workflow.md](references/workflow.md) for `dev-spec → dev-plan → dev-cycle` imports, revision handling and coordinated closeout. Use `load` to resume, `diff` to find changed obligations, and `export-plan` to transfer the pinned approved revision. Preserve IDs for unchanged obligations. Revisit behavior or key contracts with the user; downstream plans may resolve implementation details within that agreement.

At implementation closeout, preserve verified behavior/domain knowledge with current code references and an implemented-architecture link before retiring owned spec drafts. Desktop uses private durable memories. Personal cloud uses an allowlisted projection to the configured authorized Git share after concrete preview and explicit approval; see [coordinated closeout](references/workflow.md#personal-cloud-publication). The coordinator reconnects architecture to the verified knowledge. Do not rewrite approved intent to fit an implementation mismatch or retire unrelated recalled knowledge. These required artifacts are task outputs, separate from optional generalized Knowledge Delta proposals.

[sources.md](references/sources.md) records researched ideas and adaptations; ordinary spec work need not load it.
