---
name: dev-cycle
description: Implement, review, validate, and learn from development work; deliver commits and working PRs or PR stacks when in scope. Use for $dev-cycle, /dev-cycle, or iterative development requests. Discussing/editing this skill does not start a cycle.
---

# Dev Cycle

Use the installed dev-spec→ dev-plan → dev-cycle workflows for behavioral specification, source-grounded planning and reviewed implementation; watch-pr is their included PR support workflow. Installation does not start a development task. Standard setup installs them by default; --no-dev-skills records opt-out, and maintenance respects disabled/removed enrollment. Use dev-skills status for exact readiness and explicit dev-skills install to re-enable.

Resource directory: {{THREADNOTE_SKILL_ROOT}}

Bundle directory: {{THREADNOTE_BUNDLE_ROOT}}

When these placeholders are rendered, use those absolute immutable resource roots. For an unprojected source `SKILL.md`, resolve this skill’s resource root from its containing directory and discover related skill roots through the host catalog. Directory-style `SKILL.md` and flat host entrypoints may have different locations; use the companion resource tree containing `scripts/` and `references/`. Resolve related skills through that same catalog and preserve their explicit resource roots. Run Python 3.10+ on POSIX or native Windows (`python3` on POSIX; `py -3` or `python` on Windows). Shell examples use POSIX quoting and line continuations; on PowerShell pass the same argument list with `&` for a quoted executable and use PowerShell continuation syntax or one line. Keep writable run state outside installed skill resources.

Keep the current change correct and make the next session less likely to repeat its mistakes. Route to the satellites below only when needed; do not load every reference up front.

## Contract

- Respect user/repo instructions, existing work, and explicit local-only requests. Implementation delivery targets validated commits and draft PRs when publication is part of the task; bare review stays local unless publishing is requested. No automatic merge, destructive Git operation, or force-push.
- Implementation/fixing is quiet even in the main agent: no work narration, only the final summary, required blockers/user decisions, or higher-priority host-required updates. Workers return one final report. Keep logs/reflections in artifacts.
- Main agent handles small straightforward work. Delegate only when worthwhile, using the cheapest sufficient model; review orchestrator/specialists inherit the root model. Use advertised tool schemas/concurrency, never a fixed specialist fan-out.
- Reviews are read-only. Only critical/important findings repeat the bounded loop (default five reviews per phase). Iteration 1 covers the phase; later reviews cover source deltas and prior blockers. Polish minors once, validate, and stop without an extra review for minors.
- Missing checks, malformed/failed coverage, stale source, or broken phase acceptance never mean success. Record actual evidence rather than model self-grades. Canonical source and current user intent outrank retrieved memories and external feedback.
- One plan phase is one development cycle, with its own baseline, session, review history, validation and delivery. Completing a phase is a handoff to the next cycle, not completion of the whole plan. Never combine several phases into one final review or PR merely because they share a plan.
- Before opening a substantive feature PR (including draft), share current detailed feature memory with the verified relevant team and record the publication receipt. Small scoped fixes may record an explicit exemption; private drafts and preference/handoff memories do not satisfy this gate.

## Route and execute

| Situation                                                                               | Load                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Start/resume; relevant experience; meaningful feedback; phase closeout                  | [Learning](skills/dev-cycle-learning/SKILL.md)                             |
| Implement or review/fix local source                                                    | [Implementation and review](skills/dev-cycle-implementation/SKILL.md)      |
| Multiple phases, a Threadnote-backed plan, commit/PR publication, or CI/review feedback | [Phases and delivery](skills/dev-cycle-delivery/SKILL.md)                  |
| A PR has been created/updated                                                           | Installed [watch-pr](../watch-pr/SKILL.md), in a cheaper background worker |

1. Resolve task/scope, repo standards and acceptance checks. Retrieve bounded Threadnote context and per-project `preference` memories; read useful pointers, apply current explicit preferences and turn applicable gotchas into prevention checks. Graph calls use the absolute checkout root only for unfamiliar relationships/evidence gaps, with disclosed narrow-source fallback when unavailable.
2. For multiple phases or an upstream dev-plan, use its `export-dev-cycle` map as `plan.json`, including for a single planned phase. Preserve `featureId`, `spec`, `acceptanceRefs`, memory pins and completion fields; do not restart settled spec interviews. Each phase must leave a working product and have a safe merge boundary. Pin memory content, dependencies, acceptance, ownership and branch/base; use the phase helper to build a bounded worker packet and detect drift. For a tiny standalone task, use one phase and skip stack machinery. Material behavior/contract changes return to dev-spec; architecture/phase changes within the goal return to dev-plan, followed by fresh affected packets and evidence.
3. Run the phase's quiet implementation -> immutable snapshot -> selective review -> fix -> incremental review loop. Reconcile blockers and validate the final source. Preserve pre-existing staging during local work; stage only owned, validated changes for an authorized commit.
4. Reflect on observed failures, corrections and reused gotchas at meaningful boundaries. Save a concise private Threadnote experience handoff with evidence and prevention checks; optional generalized/durable policy promotion follows the memory skill's approval flow. Feed the applicable result into the next phase and future sessions. Do not invent lessons or automatically rewrite skills/AGENTS.md.
5. Finish the current phase's cycle before advancing. For PR delivery, commit its validated changes, open that phase's draft PR, attach it, record exact SHAs/base/dependencies, and start watch-pr with an owned consumer. Then select the next eligible phase and immediately repeat steps 2–5 in a fresh phase cycle. Do not ask for another “continue,” wait for CI/merge, or stop after the first PR when the approved plan still has eligible work. Respect explicit phase limits and local/commit-only delivery. A publication or watcher-start blocker must be recorded and resolved rather than silently skipping this handoff. Parent failures or head changes invalidate affected descendants until reconciled/revalidated.
6. Persist a private handoff at each phase boundary without retiring the plan's artifacts. Complete plan-level knowledge closeout only after every phase has current acceptance evidence. For upstream dev-plan work, complete its required architecture closeout; for spec-backed work use dev-plan's `scripts/workflow.py` coordinator following the installed dev-spec's `references/workflow.md`. Keep actual phase validation receipts, verify combined behavior, bind final code references, preserve linked verified spec/architecture, then retire owned drafts. This is required task output, distinct from optional policy promotion. Present queued proposals—including inferred preferences and Threadnote Knowledge Deltas—through interactive Approve/Defer/Reject prompts, not a prose-only list. Hold gated publication pending the required decision. If monitoring outlives the turn, arrange watch-pr's current-chat wake mechanism; a detached process alone cannot resume a finished agent.

## Final report

Give a concise result: what changed; phase/PR links and dependency order; checks and remaining limitations; monitoring state; useful learning recorded. Distinguish locally validated, CI pending, ready for review, blocked, and merged. Never imply pending PRs are merged or green.

When user testing adds coverage, include a few concrete steps with starting screen/account/fixture and expected results. If special setup is needed, offer to prepare that exact fixture. Do not bury the result in process logs or a generic test checklist.
