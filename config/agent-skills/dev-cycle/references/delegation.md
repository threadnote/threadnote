# Delegation and review ownership

Keep implementation, coordination, and review distinct. Every implementation slice belongs to a background agent; the orchestrator prepares and coordinates the work but does not implement source. Choose the cheapest available model and reasoning effort sufficient for the task, considering its scope, uncertainty, and the guidance supplied. When a task is well-scoped and the orchestrator has enough context to give a useful packet, do not default to an equal-capacity worker. If the host cannot select a lower-cost model or effort, retain background ownership and use the available choice without claiming it is cheaper. Do not hard-code model brands or reasoning levels.

Escalate capacity only after a concrete failed attempt or a specific technical uncertainty shows the current choice is insufficient. Name the evidence and reason for the escalation in the work record; ordinary failure, missing tooling, or stale context calls for diagnosis or repair first. If the uncertainty remains, re-scope or decompose the work with the orchestrator rather than silently shifting implementation back to it. Reassess independently for later slices.

Give every implementation worker a bounded packet containing the objective; exact scope and source anchors; relevant constraints, contracts, and settled decisions; acceptance criteria and checks; ownership/read-write boundaries; and the expected result/artifact location. Include unresolved uncertainty explicitly. The packet should supply enough context for the worker to act without rediscovering the plan or broad source relationships.

Require quiet mode in every implementation-worker prompt and in prompts to any descendants. Omit routine narration, plans, progress reports, success announcements, log dumps, and reprints of existing artifacts. Return a concise result with artifact links and checks, plus actionable blockers, questions, or failures. Quiet mode must not suppress a needed question or material failure.

The orchestrator owns memory/state updates, reviews, and delivery. Those coordination responsibilities do not justify taking over source implementation. The orchestrator never performs source review. Always spawn an independent background `correctness` reviewer and a distinct background `simplicity` reviewer; neither may have implemented the slice. Select other background specialists under the [review contract](review.md). Delegate bounded scopes.

Do not duplicate ownership of a checkout or mutate shared plan state concurrently. The coordinator alone advances phase state, accepts evidence, records delivery, and integrates results.

Worker prompts must require results and artifact links back to the orchestrator, with no handoff-memory writes. The orchestrator records the task handoff once.

Background reviewers check source and evidence against the task, current graph, and approved intent. A reviewer cannot approve for the user, authorize publication, or substitute for tests. Keep messages concise; relay blockers with exact evidence and next action.
