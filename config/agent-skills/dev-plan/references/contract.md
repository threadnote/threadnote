# Artifact and lifecycle contract

Use `init` to obtain the schema; fill its actual values rather than inventing another format. All paths are relative to the inspected repository unless explicitly described as absolute.

## Authoring

| Field                              | Meaning                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id / project / title / objective` | Stable feature ID, Threadnote namespace, readable title and observable outcome.                                                                                                                                                                                                                                            |
| `scope`                            | Exact output of `inspect` after defining the relevant code area. Includes cwd, selected paths, file hashes and observed Git HEAD. Add newly inspected existing paths by refreshing the snapshot.                                                                                                                           |
| `requirements`                     | Unique `id` and testable `behavior`. Preserve the user's goals; do not expand scope automatically.                                                                                                                                                                                                                         |
| `recall.queries`                   | The targeted recall queries actually run after scoping.                                                                                                                                                                                                                                                                    |
| `recall.sources`                   | Objects returned by `pin`, with `role` and `usedFor` filled. Roles: `constraint`, `decision`, `history`, `task`, `preference`. Read them with Threadnote before treating them as evidence.                                                                                                                                 |
| `contextRefs`                      | On root, current, target and every phase: actual URIs selected from those pinned sources. All artifacts get direct native `references` links to their relevant existing memories. If none is relevant, give a concrete `contextNote`.                                                                                      |
| `codeRefs`                         | On each artifact: up to eight inspected repository files or returned graph handles. For handles, also provide `codeRefPaths: {"actual-handle": "inspected/path"}` from the graph result so snapshot checks cover the cited source. Native save verifies graph citations. New planned code cannot be cited until it exists. |
| `current`                          | `summary`, raw Mermaid `diagram`, `invariants`, `unknowns` and the common context/citation fields. Describe observations.                                                                                                                                                                                                  |
| `target`                           | `summary`, raw Mermaid `diagram`, `contracts`, `decisions` and common fields. Each decision has `choice` and `rationale`; include alternatives only when meaningful. Describe the final solution.                                                                                                                          |
| `phases`                           | Unique `id`, `title`, `outcome`, `dependsOn`, `affectedPaths`, `newPaths`, `contracts`, `acceptance`, `safeBoundary` and common fields. Optional raw Mermaid `diagram`.                                                                                                                                                    |
| `acceptance`                       | Unique phase-local `id`, observable `criterion`, concrete `verification` and covered `requirements` IDs. Every requirement must be covered. This is planned verification, not a claim that checks have run.                                                                                                                |
| `openQuestions`                    | Unresolved consequential questions; these prevent ready status but allow a saved draft.                                                                                                                                                                                                                                    |
| `review`                           | `required` and a concrete `reason`. Multiple phases always require review. Set true for substantial single-phase design as described in the skill.                                                                                                                                                                         |

Use repository directory paths ending in `/` when the phase intentionally owns a directory. New paths must be explicit; a later phase can modify a path introduced by its dependency. Existing scoped files must match their hashes at validation/save. Changes to unrelated repository files do not invalidate the plan solely because HEAD moved.

Diagrams are raw Mermaid without Markdown fences. Current and target diagrams are required; the phase dependency diagram is generated. A small phase need not repeat a diagram already explained by the target and phase map. The satellite validates types/fences, not semantic correctness; optional `validate --mermaid-cli` performs actual render checks.

## Storage and resume

The canonical memory body includes a compact `dev-plan:v1` data comment. It contains data, not executable instructions. Readable Markdown and Mermaid are generated from that data; optional local previews omit the comment. Do not independently edit the rendered body: `load` detects divergence and requires reconciliation rather than silently discarding edits.

On desktop, current architecture is private durable factual context; proposed target architecture and execution plans are private handoff artifacts. Personal Codex/Cursor cloud stores all planning roles as private task-local native handoffs, including the baseline. These can be lost with an ephemeral workspace. Org/corporate and remote-hybrid profiles are unsupported. Being saved does not mean implemented or durably shared.

New `save --state FILE` runs automatically select `FILE.workflow-context.json`, unless a context is inherited or explicitly selected. This private context pins identity, repository, home, profile, workflow run and immutable helper generation. It and the receipt journal drive typed `threadnote workflow-memory` JSON operations, stable operation IDs, expected native revisions and exact readback. The locator travels outside reviewed hashes through spec imports, a draft sidecar and cycle exports. Preserve all of them outside installed resources. Resume with the same generation's explicit resource roots; a flat native entrypoint does not locate its scripts.

For bound reads use global `--workflow-context FILE` before the subcommand, for example `dev_plan.py --workflow-context FILE load --root URI --out FILE --state FILE`. Runtime configuration normally selects the initial profile/share; `--workflow-profile desktop|codex-cloud-personal|cursor-cloud-personal` and `--workflow-team TEAM` are initial-binding selectors, while `--workflow-generation` is a checked pin. Missing context/native binding or a changed identity/generation blocks resume: restore the original state, never create a replacement binding to claim recovery. Existing unbound desktop receipts retain legacy behavior and cannot be reinterpreted as cloud receipts.

Save order is current → target → dependency-ordered phases → root. Typed `references` preserve prior memory context; `depends_on` connects phase dependencies. A multi-phase root is a compact index; a single phase is contained in its root. Large roots use navigation index memories to stay within Threadnote's native relation limit. Native code references are separate metadata, not only text links.

Versioned child artifacts and a root written last prevent readers from seeing an incomplete new generation through the previous root. Each new run has its own namespace, so a reused feature ID cannot overwrite another plan. Keep the receipt file. Writes are read back; unchanged artifacts are reused. Prior generations are recorded in the root and retired at closeout too. A local lock prevents two satellite saves sharing a receipt file. Bound writes additionally enforce native expected revisions; legacy desktop receipts retain their original exact-content recovery. Reconcile concurrent edits rather than bypassing receipts or CAS conflicts.

`save --draft --defer-code-refs` explicitly saves pending private citations. It cannot produce a ready plan. When source/graph evidence is ready, reconcile the draft, then save without deferral. Do not fabricate graph handles or weaken the citation policy to claim readiness.

Before writing, the native dry run checks citations and returns the exact destination; the satellite records that destination's previous content hash. After an interrupted write, `recover --state receipts.json` reads that destination. It records a matching completed write, or clears the pending attempt only if the destination is unchanged. Unexpected content remains blocked for reconciliation. `--uri ACTUAL_URI` supports explicit recovery from a returned or recalled pointer. No destination is guessed, and a read failure other than native not-found is not treated as absence. Do not run concurrent writers during recovery.

```sh
python3 "$SKILL_DIR/scripts/dev_plan.py" load --root "$ROOT_URI" --out "$RUN/plan.json" --state "$RUN/receipts.json"
python3 "$SKILL_DIR/scripts/dev_plan.py" diff --before "$RUN/previous.json" --after "$RUN/plan.json"
```

Refresh scoped source evidence before revising a stale architecture. Target/current design changes conservatively flag dependent phases. The diff reports changes to the objective, requirements or target contracts for user discussion. The agent still judges semantic changes not captured by simple field comparison.

## Implementation closeout

This is part of every generated plan's completion contract. The implementing session should:

1. Verify every phase's actual acceptance result.
2. Inspect the implemented system and reconcile the target with deviations. Produce a concise **implemented architecture** diagram and contracts.
3. Obtain current graph references for the actual files/symbols, including newly created components. Re-read relevant prior memories and retain direct context references.
4. Run the profile-appropriate closeout satellite. Desktop saves and reads back private durable architecture with strict current native citations **before** retiring the old baseline. Personal cloud uses the coordinated projection/approval/Git-publication path below; it never publishes raw planning records.
5. Archive only this plan's baseline, provisional target, root and phase/index artifacts, including prior revisions, after verified replacement. Record returned archived URIs in private receipts. Desktop implemented memories retain superseded architecture links and an archive map; personal-cloud publication excludes private history/URI maps. Native relations target active knowledge. Relevant authorized active prior memories retain direct native `references`; completed execution material remains private history.

For personal Codex/Cursor cloud, export a cycle map and use the installed dev-spec's `references/workflow.md` for `workflow.py prepare`, `publication-preview`, `publication-approve` and `finish`, including architecture-only plans. Preview contains concrete projected content, destinations and source commit; record only the user's actual Approve/Defer/Reject against its `approvalDigest`. The configured authorized Git share receives approved verified knowledge, not private snapshots/history/receipts or unpublished links. All final native/Git graph readbacks must pass before either spec or plan draft set is retired. Pending push/readback resumes with the same completion directory and approved graph after remediation; neither local durable fallback nor a fresh binding is recovery. Desktop commands below retain their existing semantics; raw cloud `closeout.py` completion is blocked.

Only artifacts created by this plan are archived automatically. Other recalled architecture may cover a broader area: verify its whole scope is superseded before retiring it through native Threadnote lifecycle tools. Never archive unrelated context or delete architectural knowledge merely because it was recalled.

Prepare `implemented.json`:

```json
{
  "summary": "How the implemented system works",
  "diagram": "flowchart LR\n  Entry --> VerifiedComponent",
  "invariants": ["An observed invariant"],
  "unknowns": [],
  "contracts": ["The final externally meaningful contract"],
  "deviations": ["Material differences from the proposed design, or an empty list"],
  "codeRefs": ["actual/current/source.py"],
  "contextRefs": [],
  "contextNote": "No applicable prior memories were found for this scope.",
  "scope": {},
  "recallSources": []
}
```

Replace `scope` with a fresh `inspect` output. Fill `recallSources` with current pins for the referenced memories; omit the field to reuse unchanged plan pins. The source snapshot must include the implemented area. References must be actual current graph anchors, not the provisional plan's list copied blindly.

Prepare `completion-evidence.json`:

```json
{
  "rootHash": "SHA-256 digest of the exact root artifact record",
  "scopeHash": "SHA-256 digest of the fresh scope object",
  "architectureVerification": "What source/flows were inspected and what was verified",
  "phases": [
    {
      "id": "deliver",
      "status": "complete",
      "acceptance": [{"id": "A1", "evidence": "Actual test/command result or observed behavior, with artifact path"}]
    }
  ]
}
```

Use `closeout-input` to obtain hashes and an evidence skeleton automatically; fill evidence rather than calculating hashes by hand.

```sh
python3 "$SKILL_DIR/scripts/dev_plan.py" closeout-input --root "$ROOT_URI" --scope "$RUN/implemented-scope.json" --out "$RUN/closeout"
python3 "$SKILL_DIR/scripts/closeout.py" --root "$ROOT_URI" --implemented "$RUN/closeout/implemented.json" --evidence "$RUN/closeout/evidence.json" --state "$RUN/closeout/receipts.json"
```

The script checks coverage and source identity; it cannot prove that an agent really ran the described checks. Native `--require-current-code-refs` verifies the code binding. If citations cannot be bound, retain the existing architecture and report closeout pending. Resume the same closeout receipt after interruptions: exact destination readback reconciles completed or unchanged writes, including the final update after archival. `--recover-uri` handles an ambiguous archive with an actual returned or recalled URI. Archiving relocates URIs and adds a native preface, which is normalized only for a confirmed archived read. The implemented memory retains an archive map for historical navigation; old literal links inside archived documents are not rewritten.

## Dev-cycle handoff

`export-dev-cycle` requires a ready, active root and explicit branch/base bindings for every phase:

```json
{"deliver": {"branch": "feature/example", "baseBranch": "main"}}
```

```sh
python3 "$SKILL_DIR/scripts/dev_plan.py" --workflow-context "$WORKFLOW_CONTEXT" export-dev-cycle --root "$ROOT_URI" --delivery local --bindings "$RUN/branches.json" --out "$RUN/dev-cycle"
```

For legacy desktop omit the global context option. It emits `plan.json` and canonical body-only `memory-content.json` with SHA-256 pins, compatible with the installed phase helper. Bound exports also preserve `workflowContext` outside intent hashes; retain the original context and helper resource roots. Native CLI transport metadata is stripped consistently. Supply only delivery authorization already given by the user. The generated root memory and export both carry the mandatory architecture closeout instruction; dev-plan does not run implementation itself.
