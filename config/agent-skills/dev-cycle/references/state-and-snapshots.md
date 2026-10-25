# Cycle state and snapshots

Use native cycle state as authority. Start or resume the exact run and generation, verify checkout identity and source head, then inspect current plan and phase state. Never overwrite or reinterpret incompatible state; recover only the missing dependency.

Capture immutable source snapshots through native actions. Keep the review base fixed, distinguish pre-existing changes, and reconcile staged or uncommitted source without staging it as a side effect. Unmerged state, dirty submodules, missing objects, or mismatched heads are blockers to resolve explicitly.

The coordinator alone advances iterations and phases. Preserve prior validation, review, and delivery evidence. Any source drift invalidates verdicts that covered the changed source. Use final combined-tree validation for final acceptance.

If interrupted, resume from the last verified native receipt. Do not blindly repeat a write, regenerate a completed snapshot, delete receipts, or reuse stale review summaries. Report identity or recovery conflicts rather than bypassing them.
