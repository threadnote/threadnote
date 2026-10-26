# Spec handoff and closeout

## Handoff to planning

Export only the approved, current spec revision through native authoring. `dev-plan` must preserve requirement IDs, scenario criteria, constraints, exclusions, decisions, and the pinned source/memory evidence. The imported plan remains a draft until its architecture and phases are complete and reviewed.

Changing approved behavior requires returning to the user for a revised spec. Do not alter the upstream intent block to hide drift. Implementation details that stay within the approved outcome belong in the plan.

## Feature closeout

After all phases, refresh code evidence for the final combined source. Verify every approved scenario against the actual final tree; stale phase receipts cannot validate later changed code. The native closeout action derives and validates its own input from the persisted run, cycle, and source evidence.

Read the concrete closeout proposal. Desktop closeout creates behavior and implemented-architecture knowledge, verifies it independently, then archives only drafts owned by the authoring run. Preserve full rationale and actual implementation in durable documents; link architecture to the decision index and decisions. Personal cloud publication projects approved knowledge, requires explicit approval of the exact preview, and verifies all published nodes before retiring owned drafts. Cloud work remains private/task-local until that approval.

If inputs drift or a write is interrupted, resume the same native run and transaction. Recover the original operation and verify readback; do not start a second transaction or bypass a failed gate. Retain unrelated memories and all drafts when a required step fails.
