---
name: dev-cycle
description: Implement, review, validate, and close out development work through durable Threadnote phases, verified delivery, and owned PR watch. Use for implementation or iterative development; discussing this skill does not start a cycle.
---

# Dev Cycle

The orchestrator owns handoff memories. Background agents report results and artifact links directly; they do not store handoff memories. Include this boundary in delegated prompts.

Resources: `{{THREADNOTE_SKILL_ROOT}}`; bundle: `{{THREADNOTE_BUNDLE_ROOT}}`. Use these pinned roots for linked files and generation identity. In an unrendered checkout, use this skill directory and its parent. Start with the [native bootstrap]({{THREADNOTE_BUNDLE_ROOT}}/dev-cycle/references/native-bootstrap.md).

Use native workflow-automation JSON actions for cycle state, phase delivery, watch, and closeout. Retrieve only the current action schema from the installed runtime. Do not use legacy local scripts or invent fields. The runtime owns receipts, CAS, publication authority, durable dispositions, and acknowledgement rules.

1. Start with `threadnote-context`, repository guidance, and a fresh current source graph. Read the plan root plus only the current and dependency phase evidence. Preserve approved requirements, exclusions, prior phase state, and delivery history. Use `threadnote-code-graph` for unfamiliar relationships or unresolved evidence gaps; use exact-path reads for known code.
2. Implement one working, reviewable phase slice at a time. Use the cheapest sufficient implementation approach and effort; escalate only for demonstrated uncertainty. Keep root review independent and run a separate required `simplicity` reviewer for slop, duplication and simpler equivalent designs. Select other specialist lanes by risk and diff under the [review contract]({{THREADNOTE_SKILL_ROOT}}/references/review.md). Avoid fixed model brands and unnecessary context or progress narration.
3. Validate the actual current tree and every acceptance obligation. Preserve assertions and evidence; never claim unrun checks. For substantive PR work, refresh the feature memory before publication and read back its full rationale and actual implementation, including if authorization to share was already granted.
4. Before creating a PR, recall user preferences and apply any PR-description style. For multiphase features in GitHub repositories, prefer stacked phase PRs. When authorized, deliver the phase, record its verified commit/PR receipt, and start or transfer the sole native watch collector with a leased consumer that can wake this chat. Then immediately continue the next eligible phase; do not wait for CI, a draft, or merge. Reconcile real failed checks and head changes when they arrive.
5. The watch consumer must persist each disposition before acknowledging its delivery. Acknowledgement never resolves work; preserve open or blocked work across acknowledgements. Before ending an active watch turn, ensure the supported current-chat wakeup owns consumption. Stop the collector only at a terminal outcome or cancellation, after preserving pending work.
6. Finish with the native closeout flow: current combined-source evidence, full rationale, implemented architecture, independent durable readback, and retirement of only owned drafts. Do not mark completion from a PR merge or CI signal alone. Personal cloud knowledge remains task-local until the user approves the exact publication and native readback verifies it.

Use the linked references for [phases]({{THREADNOTE_SKILL_ROOT}}/references/phases.md), [review]({{THREADNOTE_SKILL_ROOT}}/references/review.md), [delivery]({{THREADNOTE_SKILL_ROOT}}/references/delivery.md), [watch handoff]({{THREADNOTE_BUNDLE_ROOT}}/watch-pr/SKILL.md), and [closeout]({{THREADNOTE_SKILL_ROOT}}/references/closeout.md). Follow host-required progress reporting, otherwise keep implementation quiet and return a concise evidence-based result.
