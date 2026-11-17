# Cycle state and snapshots

Use cycle state as authority. Start or resume the exact run and generation, verify checkout identity and source head, then inspect current plan and phase state. Never overwrite or reinterpret incompatible state; recover only the missing dependency.

Capture immutable source snapshots through actions. Keep the review base fixed, distinguish pre-existing changes, and reconcile staged or uncommitted source without staging it as a side effect. Unmerged state, dirty submodules, missing objects, or mismatched heads are blockers to resolve explicitly.

The coordinator alone advances iterations and phases. Preserve prior validation, review, and delivery evidence. Any source drift invalidates verdicts that covered the changed source. Use final combined-tree validation for final acceptance.

If interrupted, resume from the last verified receipt. Do not blindly repeat a write, regenerate a completed snapshot, delete receipts, or reuse stale review summaries. Report identity or recovery conflicts rather than bypassing them.

Each run has a profile. `standard`, the default for new runs, is strict only about business intent and review integrity: changing requirements, acceptance or the delivery target needs a confirmed intent, and every delivered tree needs its review and validation or an audited waiver. Ownership is derived: a file outside the planned paths is a `scope.out-of-plan` warning, a path-only plan edit needs no new confirmation and a path-only reconcile keeps the phase. Runs created before profiles, and runs switched with `task-action set-profile --profile strict`, keep every earlier gate. Loosening a run to `standard` needs the user's own authority statement.

Every refusal returns `gate`, `detail` and `next`; run the named next command instead of guessing a recovery. When a tool defect or a missing reviewer blocks an integrity or advisory gate, ask the user and record `task-action waive --gate <id> --reason <text> --user-authority <quote>` for the current tree. A waiver covers only that tree, is listed in delivery and closeout results, and never covers an intent change.
