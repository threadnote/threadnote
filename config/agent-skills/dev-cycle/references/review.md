# Independent cycle review

Review the exact snapshot and bounded diff against acceptance, approved intent, repository guidance and evidence. Keep review read-only; check behavior, regressions, security, failure handling, tests, scope and reported validation.

Always include `orchestrator` and a separate `simplicity` reviewer in `selected`, with complete reports in `lanes`. `simplicity` checks needless abstractions, duplication, missed existing helpers, dead code, redundant state, and verbose or misleading comments/docs. Prefer the smallest equivalent design; retain justified safeguards. Require concrete source evidence and impact. Select other specialists by risk and diff; never invent review output.

Review the full snapshot first, then deltas and prior findings; expand only for evidence gaps. Resolve prior active findings by stable identity and evidence, not the fixer's claim. Missing or failed selected-lane output blocks acceptance; never substitute an empty clean review.

Findings do not authorize changes, approve intent, permit publication or prove the whole product works. Record results for the exact snapshot; refresh after material source changes.
