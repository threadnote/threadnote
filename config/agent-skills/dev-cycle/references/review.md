# Independent cycle review

Delegate review of the exact snapshot and bounded diff against acceptance, approved intent, repository guidance and evidence to background agents who did not implement that slice. Keep review read-only. The orchestrator coordinates review, routes findings and records the actual reports; it never reviews the source or counts itself as a reviewer, including when implementation was delegated.

Always spawn an independent background `correctness` reviewer for behavior, regressions, integration, failure handling, tests, scope and reported validation, plus a distinct background `simplicity` reviewer. Include both names in `selected`, with complete reports in `lanes`; simplicity alone is insufficient. `simplicity` checks needless abstractions, duplication, missed existing helpers, dead code, redundant state, and verbose or misleading comments/docs. Prefer the smallest equivalent design; retain justified safeguards. Require concrete source evidence and impact. Select other background specialists by risk and diff; never invent review output or replace a missing report with the orchestrator's assessment.

Review the full snapshot first, then deltas and prior findings; expand only for evidence gaps. Resolve prior active findings by stable identity and evidence, not the fixer's claim. Missing or failed selected-lane output blocks acceptance; never substitute an empty clean review.

Findings do not authorize changes, approve intent, permit publication or prove the whole product works. Record results for the exact snapshot; refresh after material source changes.
