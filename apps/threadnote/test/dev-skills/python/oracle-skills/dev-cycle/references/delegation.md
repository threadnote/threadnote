# Delegation

Delegation is authorized when running this workflow. Discussing or modifying the skill is not a request to run the workflow on an unrelated checkout. Use the host’s advertised native subagents when available; external PAL/Claude/other CLI validators require an explicit user request for cross-model validation, and their output stays in the run artifacts.

Assess spawn overhead, task clarity, file ownership, complexity, and useful parallelism before each delegation. Small local implementation/fix work belongs in the main agent. Otherwise use the fewest independent slices (usually one). Concurrent slices must not edit the same files; dependent or overlapping work is sequential. Review the integration and use the main agent for straightforward follow-ups when sufficient.

## Model and reasoning-effort selection

Choose model capability and reasoning effort separately for each implementation or fix slice. Assess the decisions still unresolved after reading the phase packet and verifying its source anchors. A large feature, many files, a high-effort parent, or a long plan does not by itself justify an expensive implementer.

A packet is ready for lower-effort execution when it supplies concrete acceptance criteria, current code anchors and a local implementation pattern, settled interfaces and design decisions, bounded file ownership/dependencies, and focused validation commands. Verify the relevant anchors against the current checkout; detail alone is not evidence that the plan is current or complete. Resolve missing context in the parent or a bounded investigation, then reassess the implementation slice.

| Remaining work in the slice                                                                         | Starting model and effort                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Ready packet; mechanical or established-pattern changes, including across multiple files            | Cheapest sufficient advertised model, explicitly at low reasoning effort                                                  |
| Ready packet; bounded implementation reasoning beyond a mechanical pattern                          | Sufficient standard model at low effort; a cheaper model remains appropriate when its advertised capability is sufficient |
| Moderate unresolved interactions or uncertain implementation approach                               | Sufficient standard model at medium effort; narrow the uncertainty before handing off routine edits                       |
| Unresolved architecture, subtle security/correctness invariants, or complex cross-cutting reasoning | Sufficient frontier model or parent model, with higher effort justified by the concrete unresolved risk                   |
| Review orchestrator or any reviewer specialist                                                      | Inherit root model and effort; omit overrides                                                                             |

Use the host's advertised models and supported effort values. Set implementation effort explicitly when the tool exposes it, so the parent's high effort is not inherited accidentally. If `low` is unavailable, choose the nearest supported setting sufficient for the task. If effort control is absent, omit the unsupported field and record that only model selection was possible. Do not invent prices, model rankings, or a fixed cross-host model ladder. User-selected models/effort take precedence. If the host cannot satisfy or verify an explicit requirement, keep the work in a compliant parent or report the limitation before delegating; do not claim the requirement was met. When capability information is insufficient, use a known sufficient option and record the uncertainty.

Review the first completed bounded slice before assigning more work at the same capacity. Escalate for demonstrated reasoning limits: repeated misunderstanding of the supplied contract, inability to reconcile verified evidence, or newly exposed complexity. Supply the failure evidence and try one targeted increase in effort or model capability; do not increase both automatically. Ordinary test failures, missing tools, stale anchors, or infrastructure failures first need diagnosis/context repair, not a larger model. If the revised assignment still cannot satisfy acceptance, return it to the parent for decomposition or replanning within the existing cycle budget. Reassess later independent slices rather than making an escalation the new global default. Validation and independent review requirements stay unchanged.

Inspect this session's actual spawn schema and allowed models. Adapt names, messages, model selection, reasoning effort and context inheritance to that schema. When supported, use a self-contained prompt without inherited history for model/effort overrides. Do not pass unsupported fields from another host. Quiet mode is a prompt instruction unless the schema exposes a matching option. Include enough task context when not forking history, and pass actual recalled preferences.

Honor the active-agent limit, counting the main agent and orchestrator. Do not wait for an impossible fan-out: batch independent lanes or let the orchestrator cover the concerns itself. Wait on dependent completion without status polling. Implementation/fixing stays quiet even in the parent, except required blockers/decisions or higher-priority host updates; return a concise final report instead of work narration.

Record delegated implementation in `implementation-plan.json`, and fixes in the current iteration's `fix-plan.json`: slice ID, goal/finding IDs, allowed files, chosen model/tier, requested reasoning effort (or unsupported), remaining uncertainty, and selection reason. Record any escalation with its observed trigger and result. Save worker IDs/phase in the session for recovery. Workers return files touched, behavior changed, exact checks/results, unresolved issues, and dispositions for assigned findings.

## Implementer/fixer prompt

Supply the exact task, acceptance criteria and allowed files. Fixers also receive stable finding IDs, complete bodies/evidence, and iteration context:

```text
Complete this one implementation/fix slice for a local dev-cycle run.
Repo and graph callerCwd: {absolute Git root}
Slice: {ID and concrete goal}
Task and acceptance criteria: {original intent and verifiable criteria}
Verified plan/code anchors and local pattern: {current paths/symbols and relevant behavior}
Settled decisions and remaining uncertainty: {contracts, approach, dependencies, open questions}
Focused validation: {commands and expected observable results}
Allowed files: {non-overlapping ownership set}
Assigned findings, if fixing: {stable IDs, bodies, triggers, impacts, evidence}
Applicable instructions/preferences: {paths and actual recalled guidance}

Edit only this slice; preserve existing work/staging. Follow applicable repo
instructions and the skill's graph-first investigation rules. Do not commit,
push, create a PR/MR, or modify review artifacts. If another file is necessary,
report the dependency so ownership can be reassigned rather than racing another
worker. Run focused checks and record their commands/results. If a finding is
invalid or conflicts with intent, report concrete evidence without changing it.
Work quietly. Return one completion report with files changed, behavior,
checks/results, finding dispositions, and remaining limitations.
```
