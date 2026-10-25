# Independent cycle review

Review the exact source snapshot and bounded diff against task acceptance, approved intent, repository guidance, and relevant evidence. Keep review read-only. Check behavior, regressions, security, failure handling, tests, scope, and whether reported validation actually ran.

The orchestrator may select a separate `simplicity` reviewer like any other specialist lane. It checks unnecessary abstractions or boilerplate, duplication (DRY), and simpler equivalent designs. Require concrete source evidence and impact; retain justified safeguards. Record selected lanes and results.

Review the full snapshot initially, then the source delta and prior findings; expand only for evidence gaps. Account for prior active findings by stable identity and evidence. Do not treat a fixer’s claim as disposition. Missing or failed output from a selected lane blocks acceptance; never turn it into an empty clean review.

Review findings do not authorize changes, approve user intent, permit publication, or prove the whole product works. Coordinator records the result for the exact snapshot and refreshes review when source changes materially.
