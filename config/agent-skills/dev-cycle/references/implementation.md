# Implementation and review

Resolve `SKILL_DIR` to the parent dev-cycle bundle, not this reference. Read [state/snapshots](state-and-snapshots.md) when starting/resuming. Load [review contract](review.md) only when review is needed; [delegation](delegation.md) only when assigning agents.

## Establish the phase

Resolve Git root/HEAD and applicable ancestor/package instructions before writes. Inspect the active run before creating a new one. Choose intent-based mode before state changes: implementation task -> initial source snapshot as base; review current edits -> initial HEAD tree; review a clean branch -> fixed merge base (honor explicit/stack base, otherwise verified origin default then main/master fallbacks). Missing base requires a focused clarification. Review-only still fixes valid findings; publication follows the delivery contract.

For a mapped plan, run `phase_state.py next` before dispatching or starting phase implementation. If it returns `action: deliver`, finish that completed phase's PR/watcher handoff through the delivery reference first; only `action: implement` starts the returned phase. Do not bypass a pending handoff with a cached packet or a different independent phase. Scope this entire cycle to exactly one phase. Use a fresh run and baseline for a new phase, and resume its existing run for fixes or feedback. Never implement the next phase inside the current phase's source/review snapshot. After successful validation, hand this phase to delivery for its commit/PR and watcher; the orchestrator then starts the next eligible phase's own cycle.

State verifiable acceptance before implementation, then work quietly, including in the foreground. Write diagnostics, check results and reflection facts to artifacts; do not narrate implementation. A required decision/blocker and higher-priority host updates remain exceptions. Reuse actual recalled preferences and relevant prior gotchas; workers receive the task, acceptance, owned files, bounded phase packet and applicable prevention checks.

Use Threadnote graph query/explain before unfamiliar relationship/impact investigation, then verify source using stable nodes/adjacency. Every graph call uses the absolute phase checkout root, including monorepos. Exact paths/literals need no graph. During indexing do independent work and retry after the suggested delay; unavailable graph -> disclose and search narrowly. Memory project tags in `front-end-web-monorepo` use the working area (`docs`, `director`), while graph cwd remains the checkout root.

Implement small straightforward work directly. Otherwise use [delegation](delegation.md) to choose model and reasoning effort separately for the fewest independently owned slices. A detailed plan with verified anchors, settled decisions and focused checks should normally start at low effort on the cheapest sufficient advertised model; justify higher capacity by the remaining uncertainty, not the phase size or parent settings. Preserve existing work/staging. Integrate and validate interactions; the main agent may finish straightforward follow-ups. Workers record observed failures, actual corrections and checks for the orchestrator's learning step; they do not independently publish memory or policy.

## Snapshot and review

The main agent owns iteration allocation and checkpoints. Before exceeding five reviews per phase, stop as stalled; persist this budget across CI/review feedback and pushes. Capture immutable source trees with:

```sh
python3 "$SKILL_DIR/scripts/dev_cycle.py" snapshot --repo "$GIT_ROOT" \
  --output "$ITER_DIR" --base "$BASE_TREE"
# Later iterations: --previous "$PREV_ITER_DIR"
```

For mapped phases run `phase_state.py check-phase` with the plan, phase packet and snapshot before review. Classify the actual first snapshot: metadata with no runtime/build/workflow/security effects and harmless additive tests may use direct validation. Changed expectations, weakened assertions, discovery changes or regression-concealing fixtures require review. Record a concrete skip reason. Later empty/test-only deltas still require prior-blocker verification; an initially empty diff also needs implementation acceptance checks.

Write `review-context.json`: original task, acceptance, scope/base/tree, phase ID/plan hash if mapped, instructions/preferences, applicable gotcha checks, existing-work exclusions, check results and limitations. Spawn one root-model orchestrator, or review directly and disclose if agents are unavailable. The orchestrator chooses 0-N useful specialists; small straightforward diffs normally need none. Iteration 1 reviews the entire scoped snapshot; later iterations review source deltas, affected dependencies and prior blocking IDs with at most one extra specialist. No repeated full fan-out.

Reviewers cannot edit source/index/refs or run builds/tests. They write only assigned iteration artifacts. Preserve malformed/failed lane reports and allow one targeted recovery; a second failure is `review_failed`, not `[]`. Only the parent accepts a verdict after:

```sh
python3 "$SKILL_DIR/scripts/dev_cycle.py" check --repo "$GIT_ROOT" --snapshot "$ITER_DIR"
python3 "$SKILL_DIR/scripts/dev_cycle.py" validate-review --iteration "$ITER_DIR"
# Incremental validate-review: --previous "$PREV_ITER_DIR"
```

The helper derives counts and verifies coverage/prior blockers. Source drift requires reconciliation and a new snapshot. After a recorded commit, `--accepted-head EXACT_SHA` is allowed only as described in delivery/state guidance; it never bypasses the source-tree check.

## Fix, reflect and validate

Verify evidence and intent before fixing. Keep finding IDs through line movement; record invalid findings in `ignored.json` with evidence, never silently drop them. Disagreement requires evidence, not a vote. Fix critical then important findings directly when straightforward, otherwise in non-overlapping worker slices. A scope conflict requires a user decision after useful independent work. Capture minimal failure/correction/prevention facts for the learning reference after meaningful feedback; do not ask for hidden reasoning transcripts.

Blocking fixes -> focused checks -> next incremental review. No blockers -> valid minor polish once -> final checks, without another review just for minors. Same blocking IDs with neither a relevant source change nor new supporting evidence means stalled. Do not treat line movement or an assertion weakened to green as progress.

Capture `final` (or fresh `final-N`) against the same base, then run applicable focused tests/lint/types/build/UI checks. Immutable-tree whitespace checks use `git diff --check "$BASE_TREE" "$FINAL_TREE"`. Results can be reused only while inputs remain unchanged. Check final source identity after checks. New blockers exposed by checks re-enter the same bounded loop; unresolved unavailable/failed required checks mean incomplete.

Record `validation.json` with `snapshotTree`, `status: "passed"`, `productState: "working"`, `checks` (command/result/evidence), `acceptance` (criterion/result/evidence), and `reviewTree` when reviewed. For a mapped phase run `phase_state.py ready` before delivery. Snapshot/validation completion is distinct from commit, PR CI, approval and merge readiness.
