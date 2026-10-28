# Delegation and review ownership

Keep implementation, coordination, and review distinct. Choose the cheapest sufficient implementation method and effort; keep root review independent and at its configured model/effort. Do not hard-code model brands or reasoning levels. Always run the separate `simplicity` reviewer; select other specialists under the [review contract](review.md). Delegate bounded scopes.

Give each worker one scope, concrete acceptance, read/write boundaries, and output location. Do not duplicate ownership of a checkout or mutate shared plan state concurrently. The coordinator alone advances phase state, accepts evidence, records delivery, and integrates results.

Worker prompts must require results and artifact links back to the orchestrator, with no handoff-memory writes. The orchestrator records the task handoff once.

Review source and evidence against the task, current graph, and approved intent. A reviewer cannot approve for the user, authorize publication, or substitute for tests. Keep messages concise; relay blockers with exact evidence and next action.
