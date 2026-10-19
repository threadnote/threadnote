# Delegation

Delegation is authorized when running this workflow. Discussing or modifying the skill is not a request to run the workflow on an unrelated checkout. Use the host’s advertised native subagents when available; external PAL/Claude/other CLI validators require an explicit user request for cross-model validation, and their output stays in the run artifacts.

Assess spawn overhead, task clarity, file ownership, complexity, and useful parallelism before each delegation. Small local implementation/fix work belongs in the main agent. Otherwise use the fewest independent slices (usually one). Concurrent slices must not edit the same files; dependent or overlapping work is sequential. Review the integration and use the main agent for straightforward follow-ups when sufficient.

## Model and tool selection

| Slice                                                                  | Model choice                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Mechanical, well-specified, local pattern                              | Cheapest advertised model sufficient for that work                             |
| Typical multi-file feature or moderate reasoning                       | Sufficient standard/default model; prefer cheaper than parent when appropriate |
| Ambiguous design, security-sensitive logic, complex cross-cutting work | Sufficient frontier model or inherit parent                                    |
| Review orchestrator or any reviewer specialist                         | Inherit root model; omit overrides                                             |

Choose for demonstrated capability needs, not just file count. Do not demote a complex task to an insufficient model because the preferred slug is unavailable. Do not invent prices/rankings; use host-advertised capability/cost information where available, otherwise choose a known sufficient option and explain the uncertainty. One next-tier retry is reasonable for a capability failure; ordinary repo/test failures are not evidence that the model is underpowered.

Inspect this session's actual spawn schema and allowed models. Adapt names, messages, model selection and context inheritance to that schema. When supported, use a self-contained prompt without inherited history for a model override. Do not pass unsupported fields from another host. Quiet mode is a prompt instruction unless the schema exposes a matching option. Include enough task context when not forking history, and pass actual recalled preferences.

Honor the active-agent limit, counting the main agent and orchestrator. Do not wait for an impossible fan-out: batch independent lanes or let the orchestrator cover the concerns itself. Wait on dependent completion without status polling. Implementation/fixing stays quiet even in the parent, except required blockers/decisions or higher-priority host updates; return a concise final report instead of work narration.

Record delegated implementation in `implementation-plan.json`, and fixes in the current iteration's `fix-plan.json`: slice ID, goal/finding IDs, allowed files, chosen model/tier, and reason. Save worker IDs/phase in the session for recovery. Workers return files touched, behavior changed, exact checks/results, unresolved issues, and dispositions for assigned findings.

## Implementer/fixer prompt

Supply the exact task, acceptance criteria and allowed files. Fixers also receive stable finding IDs, complete bodies/evidence, and iteration context:

```text
Complete this one implementation/fix slice for a local dev-cycle run.
Repo and graph callerCwd: {absolute Git root}
Slice: {ID and concrete goal}
Task and acceptance criteria: {original intent and verifiable criteria}
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
