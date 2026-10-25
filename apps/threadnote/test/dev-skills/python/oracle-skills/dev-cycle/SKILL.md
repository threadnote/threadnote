---
name: dev-cycle
description: Implement, review, validate, and learn from development work; deliver commits and working PRs or PR stacks when in scope. Use for $dev-cycle, /dev-cycle, or iterative development requests. Discussing/editing this skill does not start a cycle.
---

# Dev Cycle

Implement the approved task through review, validation, delivery and learning.

Resource directory: {{THREADNOTE_SKILL_ROOT}}

Bundle directory: {{THREADNOTE_BUNDLE_ROOT}}

Use these roots for scripts/references; otherwise locate the resource directory through the host catalog. Resume with the run's pinned generation. Keep run files outside installed resources. Scripts require Python 3.10+; adapt command syntax to the host shell.

## Execution

1. Resolve scope, repository instructions, existing work and acceptance. Use `threadnote-context` for bounded context and relevant preferences. Prepare the graph before unfamiliar source investigation; check exact known paths directly.
2. For a Threadnote plan, use dev-plan's `export-dev-cycle` map. Preserve spec IDs, acceptance mappings, memory pins and closeout requirements. Follow [phase mapping](references/phases.md). A small standalone task needs one cycle.
3. Implement the selected phase. Capture an immutable snapshot, review, fix blockers and validate. Use [implementation](references/implementation.md) and [state/snapshots](references/state-and-snapshots.md). Preserve existing edits and staging.
4. Deliver that phase: validated commit → publication gate → phase PR → owned watcher → recorded delivery. Run `next` and immediately continue eligible approved work while CI/review runs. Missing delivery needs completion; actual parent failures or head changes need reconciliation. Do not wait for merge alone. See [delivery](references/delivery.md).
5. Save a private handoff at each phase boundary. Preserve phase artifacts until all phases pass combined acceptance. Complete verified spec/architecture closeout through dev-spec's workflow reference before retiring owned drafts.

## Capacity and review

Handle small changes directly. Delegate only useful, non-overlapping slices. A detailed, verified plan starts with the cheapest sufficient advertised implementer at low effort; escalate for demonstrated uncertainty. Select capability and effort separately. Reviewers inherit the root model/effort. See [delegation](references/delegation.md).

Reviews are read-only. Default: five reviews per phase; honor explicit extensions and preserve history across pushes. First review covers the phase; later reviews cover deltas and prior blockers. Repeat only for critical/important findings. Polish minors once, validate, then deliver. Use [review](references/review.md).

Record actual checks. Missing/failed checks, stale source or incomplete acceptance cannot pass. Behavior changes return to dev-spec; architecture changes within the goal return to dev-plan.

## Delivery and feedback

Respect local-only scope and existing authorization. Commit/push/open PRs when authorized; merge, force-push and destructive actions need separate authority. Before a substantive feature PR, publish current feature memory to the verified team and retain its receipt; small fixes may record an exemption. See [feature memory](references/feature-memory.md).

Use [watch-pr](../watch-pr/SKILL.md) after publication. One collector owns polling; an owned consumer handles signals. Investigate actionable feedback, fix, validate and push within scope. Continue other eligible phases. Arrange current-chat wakeup before ending with active monitoring.

Keep implementation logs in artifacts; communicate decisions, blockers and host-required updates. Capture observed corrections through [learning](references/learning.md). Optional policy/preferences/Knowledge Deltas use [closeout decisions](references/closeout.md); do not re-request approval already given for the same scope.

## Result

Report changes, phase/PR links, actual checks, remaining limitations and monitoring ownership. Distinguish local validation, CI pending and merged. Include concrete user-test steps when useful.
