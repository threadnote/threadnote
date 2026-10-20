# Review contract

## Packet and source identity

The main agent supplies absolute repo/graph roots, iteration directory, mode, previous iteration (if any), and `review-context.json`. That context includes the original task (or an explicit review-only objective), acceptance criteria, fixed scope/base, `snapshotTree`, applicable repo standards and recalled preferences, checks already run, known limitations, and pre-existing work outside scope.

Review iteration 1's entire `diff.patch` using `files.json`. For later iterations, use `delta.patch` and `delta-files.json` as the primary surface plus previous findings. Read enough relevant dependencies to validate behavior; incremental scope does not prohibit checking a caller affected by the fix. Do not repeat a full review of unrelated changes.

Read source from the saved tree (`git show <tree>:<path>`) or live files only while their identity is unchanged. For deleted files, inspect the previous/base tree and mark coordinates as base-side in the finding. Read relevant hunks and bounded context first; do not require whole-file reads based on an arbitrary line count. Generated, lock, configuration, and binary files may need specialized checks rather than full reads; do not assume they are harmless. Follow the main skill's graph rules for relationship questions.

## Reviewer selection and findings

Before delegating, write `agent-selection.json` with `selected` (lane names, always including `orchestrator`), `skipped` (lanes/reasons), and `mode` (`orchestrator-only`, `single`, `multi`). The reported coverage must match this selection exactly. Orchestrator-only is the default for small straightforward changes. Additional lanes must add meaningful coverage:

| Lane                     | When useful                                                                      |
| ------------------------ | -------------------------------------------------------------------------------- |
| generalist               | Behavior or invariants need an additional independent pass                       |
| security-correctness     | Auth/authz, injection, secrets, network/parsers, races, or validation boundaries |
| performance-architecture | Hot paths, queries, unbounded work, or significant structural changes            |
| test-quality             | Changed tests need scrutiny or important behavior lacks effective tests          |

Inherited root model, no reviewer override. Use available slots rather than a fixed fan-out. Descendant spawning unavailable/full: the orchestrator covers the selected concerns itself and records that choice. Reviewers must not modify source, index, or refs, run tests/builds, or contact VCS services. Only write artifacts in the assigned iteration directory. Return one completion report; do not narrate progress.

Report actionable defects introduced by the scoped changes and relevant unmet acceptance criteria. Each finding needs concrete evidence, a triggering scenario, and an observable impact. Do not turn preferences, speculative risk, or unrelated existing defects into blockers.

- `critical`: demonstrated serious security, irreversible data loss/corruption, or broad outage risk under credible conditions.
- `important`: concrete incorrect behavior, meaningful regression, unsafe boundary, or material performance/reliability problem requiring a fix before accepting the task.
- `minor`: valid local maintainability/clarity/test-quality problem with limited impact.
- `informational`: optional observation; does not require a fix.

Confidence is an integer estimate, not an automatic severity or rejection threshold. A blocker still needs evidence. Deduplicate by root cause and triggering behavior; nearby lines/categories alone are insufficient. Assign a run-unique ID (`F001`, `F002`, ...), preserve it through line movement, and never reuse it for a different defect. Merge corroborating evidence without mechanically taking the highest claimed severity/confidence.

For disputed blockers, seek one independent second opinion when useful. The orchestrator must resolve the actual evidence and explain the decision; one rejecting vote does not automatically dismiss a finding. Record rejected findings with their concrete reason. Check blocking suggestions against the original intent and obvious regressions before returning them.

## Artifacts

Save selected specialists' raw reports and parsed findings under the iteration directory. Preserve malformed output and identify the failed lane. Never replace a parse failure with `[]`. One bounded targeted recovery is allowed; incomplete lanes prevent an accepted verdict.

`findings.json` is an array. Each finding has:

```json
{
  "id": "F001",
  "file": "src/example.py",
  "line": 12,
  "severity": "important",
  "category": "correctness",
  "confidence": 95,
  "body": "Concrete defect and why it matters.",
  "trigger": "Inputs or conditions that reach the defect.",
  "impact": "Observable incorrect result.",
  "evidence": "Source/contract/check evidence supporting the claim.",
  "state": "new",
  "source": "orchestrator",
  "suggestion": "Optional proposed fix."
}
```

Allowed categories: `security`, `performance`, `architecture`, `quality`, `flaky-test`, `devex`, `correctness`. Paths are repo-relative; lines are positive source coordinates, not positions in a patch file. Optional `side: "base"` identifies deleted/base-side lines.

States: `new`, `carried`, `resolved`, `rejected`. Resolved/rejected entries also require `reason` with verification or rejection evidence. Downgrading a prior blocker to minor/informational also requires an evidence-based `reason`. Every prior active blocker must appear with the same ID and a disposition; do not silently omit it. Prior minors outside the delta may be omitted. A previously rejected finding must not reappear without new evidence, and retains its ID if reopened. Include prior resolutions/rejections when necessary to preserve identity history.

`review.json` records coverage and identity:

```json
{
  "status": "complete",
  "snapshotTree": "tree SHA from snapshot.json",
  "reviewMode": "full",
  "lanes": [{"name": "orchestrator", "status": "complete"}]
}
```

Include every selected lane, with `status: "failed"` / `"incomplete"` and diagnostic information when appropriate. Orchestrator-only still records its own lane. Do not mark complete before all selected lanes finish. Write `merged-review.md` with findings by severity and, on re-review, resolved/new/carried/rejected IDs and evidence. Source/disagreement dispositions belong in that report.

The **main agent** runs `validate-review` to derive `summary.json`. The helper checks snapshot identity, coverage completion, finding fields/IDs, and prior-blocker dispositions; it cannot prove the semantic correctness of reviewer reasoning. Its computed blocking count includes only active (`new`/`carried`) critical/important findings. Resolved/rejected entries remain in artifacts but do not block. An invalid review removes any old computed summary and exits unsuccessfully.

The parent verifies fixer rejection reasons and records `ignored.json` as entries with `id`, `reason`, and `evidence`. Supply it in subsequent review context. A fixer report alone cannot remove a blocker from the accepted verdict; it needs a recorded evidence-based disposition.

## Orchestrator prompt

Populate this with the actual packet, task, and directories; do not pass unresolved placeholders:

```text
Review the local changes for the dev-cycle run using the attached review contract.
Repo/graph root: {absolute root}
Iteration directory: {absolute iteration directory}
Review mode: {full or incremental}
Previous iteration: {absolute previous directory or none}
Task and acceptance criteria, standards/preferences, checks and scope:
  {absolute review-context.json path}
Snapshot manifest/diff/files: {absolute paths}
Delta/delta-files for incremental mode: {absolute paths or none}

You and any specialists inherit the root model; do not override it. Source and
Git state are read-only. No tests/builds or external posts. Only write artifacts
inside the assigned iteration directory. Work quietly; return one completion
report. Select the smallest sufficient review set within available capacity.
Account for every prior blocker by stable ID and evidence. Preserve failed lane
outputs and report incomplete coverage rather than an empty successful review.
Write agent-selection.json, findings.json, review.json, merged-review.md and any
selected lane reports. Do not write summary.json; the parent validates and
computes it. Return mode, coverage status, counts, artifact paths, and unresolved
limitations. Do not change source or fix findings.
```
