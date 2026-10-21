# State and source snapshots

## Start a run

Resolve the Git root and initial `HEAD` before creating directories. Choose mode/scope from the original status, ignoring only existing dev-cycle state. Read any existing `.context/dev-cycle/active.json` before creating a new run. Never edit tracked `.gitignore` or use the real index for snapshots. Run Git inspections with `git --no-optional-locks ...` (or `GIT_OPTIONAL_LOCKS=0`), including `status` and `diff --check`.

Use a fresh UUID for `RUN_ID` and `RUN_DIR=$GIT_ROOT/.context/dev-cycle/$RUN_ID`. Set `SKILL_DIR` from the loaded skill location. Capture the initial source before feature work:

```bash
python3 "$SKILL_DIR/scripts/dev_cycle.py" snapshot \
  --repo "$GIT_ROOT" --output "$RUN_DIR/baseline" --base "$INITIAL_HEAD"
```

The helper validates the checkout/base before writes and adds `/.context/dev-cycle/` to the local Git exclude file. It copies the real index into a disposable temporary index, updates that copy from the current working tree, and writes immutable blob/tree objects. It creates no commits or refs and leaves the real index byte-for-byte unchanged. Keep snapshots local: they may contain the same sensitive source content as the working tree.

For end-to-end staging preservation, compare staged paths/modes/blob IDs and conflict stages (`git --no-optional-locks ls-files --stage -z`), not just raw index checksums. `--no-optional-locks` reduces optional writes; some commands (including working-tree `diff --check`) may still refresh cached stat metadata. Record a cache-only difference but do not classify it as a staging mutation or failed source validation. A changed staged entry is a real discrepancy and must be reconciled before completion. Prefer tree-to-tree whitespace checks after snapshotting.

Choose and persist `baseTree`:

- Implement: `baseline/snapshot.json.tree`. Its diff against initial HEAD records pre-existing work; subsequent task diffs exclude unchanged existing edits, even within the same file.
- Review-only, uncommitted: initial HEAD's tree.
- Review-only, branch: the tree of the resolved merge base, fixed for the run. Later snapshots include uncommitted fixes against this same base.

`snapshot` captures the combined filesystem state, not a separate review of every intermediate staged version. Preserve staging during local work; use `git diff --cached` to identify differences from the reviewed filesystem when relevant. If staged/unstaged edits cancel, disclose that the staged version was not reviewed. Only the orchestrator may stage owned validated changes for an in-scope commit, preferably in an isolated phase checkout; snapshotting itself never stages them.

Dirty submodule content cannot be represented by the parent Git tree; the helper stops and requires a separate cycle in that checkout. Committed submodule pointer updates are included. Unmerged indexes stop capture. Ignored untracked files are excluded, while already indexed files remain eligible. A helper error is not an empty diff.

## Session checkpoint

After baseline capture, write `session.json` in the run directory and atomically update `.context/dev-cycle/active.json` to `{ "runId": "..." }`. Use temporary files and replace, so readers never accept partial JSON. Do not run concurrent cycles in one checkout; check existing workers before taking ownership of an unfinished run.

Session fields:

```json
{
  "schemaVersion": 2,
  "runId": "UUID",
  "repo": "/absolute/checkout",
  "head": "initial commit SHA",
  "graphCallerCwd": "/absolute/checkout",
  "mode": "implement",
  "scope": "task",
  "task": "original request",
  "acceptanceCriteria": [],
  "baseTree": "fixed Git tree SHA",
  "baselineDir": "baseline",
  "status": "planning",
  "phase": "baseline-captured",
  "nextIteration": 1,
  "maxIterations": 5,
  "iterations": [],
  "validation": []
}
```

The main agent alone allocates iterations and updates state. Before starting a review iteration, check the cap, append an iteration record with its number/directory/phase, and advance `nextIteration` once. Do not increment it again after fixes. Record snapshot identity when capture succeeds, agent IDs when spawned, accepted review artifacts when validated, finding dispositions, and completed fix/check results. Status/phase must identify the next dependency, not just say “reviewing” throughout the loop.

The helper writes snapshot artifacts before publishing `snapshot.json` last. An iteration lacking that manifest is incomplete. Existing snapshot directories cannot be overwritten. `files.json` and `delta-files.json` are JSON arrays of repository-relative paths, including deleted files; do not parse whitespace-delimited filenames. Binary changes are present in the patch. Source deltas use `git diff previousTree currentTree`, with no patch-of-patches fallback.

Mapped work also records `planPath`, `phaseId`, `planHash`, and its phase delivery ledger (commit/tree/base/PR/watch/experience URIs). Each phase has its own baseline and bounded review history. Do not reuse another phase's base or reset the budget after a push.

The shared plan maps each phase to its `cycleRunId` and absolute `cycleDir`. On a phase transition, preserve the finished session and create a fresh run/baseline for the next phase in its checkout. Update that checkout's active pointer without overwriting the previous cycle. Keep earlier watchers and their consumer ownership in the shared delivery map. A watching PR does not prevent a new phase cycle in another checkout; later feedback resumes the original phase's session and budget.

## Resume

1. Read the active run/session; verify schema, checkout identity, initial HEAD, fixed base/tree availability, and last completed phase. Preserve incompatible legacy state and explain that it cannot safely resume; start a separate run rather than deleting it.
2. If a recorded worker is still active, wait or reconnect instead of spawning a duplicate. Recover only the missing dependency. A completed snapshot is reused, never regenerated in place.
3. Run `check` against the last source checkpoint. If interrupted during implementation/fixing, compare current source against that checkpoint and reconcile completed edits before continuing. Do not roll them back or blindly repeat the feature/fix. If interrupted during review, source drift invalidates acceptance of that verdict.
4. If artifacts exist but the session update was interrupted, validate their identity/schema before marking the phase complete. Missing/malformed review artifacts permit one targeted recovery; otherwise mark `review_failed`. Never reuse a stale summary after a failed validation.
5. A recorded validated commit intentionally advances HEAD: reconcile its exact SHA/tree with the phase delivery ledger, then use `snapshot`/`check --accepted-head EXACT_SHA` where needed. The flag never bypasses source identity or the fixed review base, and must not silence an unexpected-head error. Unrecorded HEAD/base changes or pruned objects require fresh reconciliation; preserve artifacts without blindly reusing old verdicts. A new task may start a separate run after workers are reconciled.

Final validation uses `RUN_DIR/final` (or a fresh `final-N` if a check required more edits), the same base, and `validation.json` keyed by the final tree. Validation snapshots do not consume review iterations. The latest accepted review verdict covers blocking fixes; the final snapshot may additionally contain once-only minor polish.
