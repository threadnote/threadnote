# Native cycle API

Send one JSON request to `threadnote workflow-automation`. Use protocol/executor version `1`, action `cycle`, and the run's pinned `runId` and `generation`. Read `command: schema` for the current request contract; continue its UTF-8 pages with the returned digest and offset.

Initialize from a verified native authoring `export-dev-cycle` result before implementation; this pins the first phase's source. Run `begin-phase` on each later phase's declared branch before editing or dispatching workers. `inspect` returns the state revision; include it as `expectedRevision` on mutations. State belongs to the bound private home. Requests cannot select a state file.

| Command                                | Purpose                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `validate-plan`, `init`, `reconcile`   | Verify the ready plan and retain material phase provenance.                               |
| `begin-phase`                          | Pin the next phase's original source before implementation; never reset it during review. |
| `next`                                 | Deliver an accepted phase first; otherwise implement the next eligible phase.             |
| `packet`                               | Verify ready graph, source anchors, ownership, checks, model and effort before dispatch.  |
| `snapshot`, `check-phase`              | Pin immutable source without changing the contributor's index or worktree.                |
| `validate-review`, `ready`             | Retain complete review coverage, resolve blockers and bind acceptance to the exact tree.  |
| `publication-ready`, `record-delivery` | Verify the committed tree and record the authorized delivery and owned watcher.           |
| `invalidate`, `resume-phase`           | Retain prior proofs and reconcile affected work after failures or source drift.           |
| `detail`                               | Read hash-bound pages of manifests, patches, reviews, attempts or phase evidence.         |
| `learning-packet`, `closeout-packet`   | Retrieve phase experience and verified plan completion inputs.                            |

An open PR with pending CI permits the next phase after its accepted commit and owned watcher handoff. Failed acceptance or unexpected source changes require reconciliation. Empty or partial checks never establish merge readiness.

Keep pre-existing unowned work outside phase commits. Snapshots preserve it as separate evidence; shared delivery requires a clean isolated phase checkout.

Keep one continuous review history per phase. `extend-reviews` requires recorded human authority. Oversized responses return an explicit continuation; retrieve the needed detail instead of loading the entire run.
