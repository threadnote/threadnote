# Phase map and drift guards

Use for multi-phase work or a plan stored as connected Threadnote memories. Current user intent and checked-in guidance remain authoritative. Read the root plan and only the current/dependency phase's connected memories; do not infer the plan from snippets or traverse all relations. For dev-plan roots use its `export-dev-cycle` satellite to create `plan.json` and canonical memory content, including for a single planned phase. Preserve optional `featureId`, `spec`, `acceptanceRefs` and `completion` fields: these bind approved dev-spec behavior to phase verification and are included in drift checks. Other plans may be mapped faithfully without inventing phases or replacing acceptance.

Minimal example (use actual agreed URIs, SHA-256 pins and branches):

```json
{
  "objective": "Deliver safe incremental changes",
  "delivery": "pr",
  "planMemoryUris": ["threadnote://actual/root-plan"],
  "memoryHashes": {"threadnote://actual/root-plan": "SHA256 of canonical memory content"},
  "phases": [
    {
      "id": "foundation",
      "title": "Backward compatible parser foundation",
      "dependsOn": [],
      "memoryUris": [],
      "allowedPaths": ["src/parser/", "tests/parser/"],
      "acceptanceCriteria": ["Existing documents still load", "Parser accepts both supported formats"],
      "safeToMergeReason": "Existing readers and behavior remain supported",
      "branch": "feature/parser-foundation",
      "baseBranch": "main",
      "status": "pending"
    }
  ]
}
```

Each real phase has acceptance, owned paths, a safe product boundary and optional memory URIs. Dependencies form a DAG; unknown dependencies/cycles fail validation. For a real stack, the child targets the parent branch; independent phases target the regular base. `delivery` is `local`, `commit` or `pr` according to the task; a plan cannot expand publication permissions.

For spec-backed work, preserve exact approved scenario criteria and their `acceptanceRefs` mappings. Behavioral/contract changes require a revised approved dev-spec and reconciled dev-plan; implementation fixes against unchanged acceptance stay in dev-cycle. `ready` retains `validationFile`, `validationHash` and `validationPlanHash`. Keep those files: dev-plan's `workflow.py` consumes actual phase evidence to close the spec/architecture memory lifecycle. Follow the installed dev-spec's `references/workflow.md` for that coordinated closeout.

Save canonical memory content actually read from MCP in private `memory-content.json`: `{ "threadnote://URI": "canonical content" }`. Pin its SHA-256 in `memoryHashes`. Strip volatile transport metadata consistently; do not hash search snippets. Local plans use empty URI/hash collections. At phase start/resume, re-read the relevant sources and compare pins. Changed memory needs reconciliation against user intent, a recorded revision and fresh packets, not blind acceptance or endless refusal.

```sh
python3 "$SKILL_DIR/scripts/phase_state.py" validate-plan --plan "$RUN_DIR/plan.json"
python3 "$SKILL_DIR/scripts/phase_state.py" next --plan "$RUN_DIR/plan.json"
python3 "$SKILL_DIR/scripts/phase_state.py" packet --plan "$RUN_DIR/plan.json" \
  --phase "$PHASE_ID" --memories "$RUN_DIR/memory-content.json" --output "$PHASE_DIR/phase-packet.json"
```

The packet pins definition hash, scope, dependencies, acceptance, branch/base and read URIs. Pass it, original intent, actual preferences and relevant prevention checks to workers. `active` means resume the recorded work/worker, not dispatch a duplicate. The orchestrator alone updates plan/progress; workers return edits and reports. Record worker IDs/checkpoints before changing context.

Before accepting implementation/review, check changed files and the current plan:

```sh
python3 "$SKILL_DIR/scripts/phase_state.py" check-phase --plan "$RUN_DIR/plan.json" \
  --packet "$PHASE_DIR/phase-packet.json" --snapshot "$ITER_DIR"
```

Out-of-phase files, definition drift, stale phases and blocked dependencies fail. Do not edit the map just to pass: distinguish user steering from scope creep, reconcile, regenerate packets and revalidate affected work. After tests/review, record the [implementation satellite's](../skills/dev-cycle-implementation/SKILL.md) validation schema, then:

```sh
python3 "$SKILL_DIR/scripts/phase_state.py" ready --plan "$RUN_DIR/plan.json" \
  --packet "$PHASE_DIR/phase-packet.json" --snapshot "$FINAL_DIR" \
  --validation "$PHASE_DIR/validation.json" --review "$ITER_DIR"
# Incremental: add --previous-review "$PREV_ITER_DIR".
# Eligible skip: replace --review with --review-skipped "concrete classification/reason".
```

`ready` checks live source identity, exact acceptance coverage, successful check evidence, working product state and matching phase/plan/review identity; it marks the phase locally `validated`. It cannot prove a claimed check actually ran: keep command evidence and independent review. It never marks published, CI-green or merged.

Maintain dynamic fields: `worktree`, `baseSha`, `headSha`, `validatedTree`, `prUrl`, `watchStateDir`, `watchWorkerId`, `heartbeatId`, `learning.memoryUris`, `handledDeliveryIds`, and checkpoint/iteration budget. These do not alter the static plan hash. Keep manual test steps/fixture details in phase validation/delivery records for concrete closeout instructions.

On a parent failure, unexpected head, changed base or rejected assumption:

```sh
python3 "$SKILL_DIR/scripts/phase_state.py" invalidate --plan "$RUN_DIR/plan.json" \
  --phase "$AFFECTED_PHASE" --reason "event/head and concrete failed assumption"
```

Affected phases and transitive descendants become stale, preventing readiness until reconciled. Merged history is not rewritten: add a corrective phase. Deliberately reconcile source/base/plan, reactivate eligible phases, regenerate packets and rerun affected checks/review; preserve budgets and evidence. Independent work may continue. Parent local validation allows dependent implementation during CI; parent failure prevents claiming child readiness.
