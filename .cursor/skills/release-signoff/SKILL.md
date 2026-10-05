---
name: release-signoff
description: Run Threadnote's manual prerelease E2E dogfooding matrix through the global installation with multiple low-cost agents, save candidate-bound results, and return GO or NO-GO. Use for release signoff or prerelease regression testing, not release publication or token-efficiency experiments.
---

# Release signoff

Own execution and reporting, not product fixes or publication. Never merge, tag, publish, edit the article, or silently
widen permissions. A GO is evidence for a named scope, not authorization to release.

## 1. Establish the run

Read repository `AGENTS.md`, `docs/prerelease-manual-e2e-dogfood-matrix.md` and this skill's
`assets/signoff-template.md`. The matrix is the only scenario/oracle/pass-criteria source; do not duplicate its cases
here. Use current checked-in release requirements for authoritative gates, not remembered historical policy.
Use applicable Threadnote context and memory routing; exact-path preparation does not require a graph query.

- Select the reviewed exact source commit, version, phase (`prerelease` or `postpublication`), beta/stable scope,
  platform/client lanes, changed surfaces, and optional integrations. If unspecified, inventory all matrix IDs and
  plan complete applicable functional coverage; never infer a narrow smoke is a complete release signoff.
- Create `docs/release-signoff-<version>-<short-sha>-<phase>.md` from the template immediately, initially NO-GO / IN
  PROGRESS. If candidate identity is unavailable, use `docs/release-signoff-pending.md` and record that blocker.
  Honor an explicit user-selected report location. A requested simulation/evidence-packet review is assessment-only:
  use only supplied evidence, label the report simulated, and do not install, spawn execution workers, write product
  context or claim actual matrix execution. This exception never turns an incomplete packet into release GO.
  Keep raw bounded evidence in a private, ignored `.context/release-signoff/<run-id>/` or user-selected private directory.
  The docs report contains only privacy-safe summaries and relative artifact locators, never secrets or personal paths.
  Keep report writes in a separate coordinator/reporting checkout when installing from an exact-HEAD source checkout;
  an untracked docs report must not dirty the frozen build source or be committed merely to satisfy the installer.
- Pin the matrix revision/hash. Expand each ID into its required lane/surface entries, initially NOT RUN. Assign each
  entry exactly one owner. P1 beta deferrals need the release owner's explicit scope review; stable requires complete
  applicable functional coverage. Conditional advertised features are required; absent environments are BLOCKED.
  Record publication-dependent checks as NOT RUN in a separate postpublication schedule, not as prerequisites that
  make a prerelease verdict circular. Optional observations never become gates.

## 2. Freeze the global installation

Resolve the canonical `threadnote` launcher, real executable, version, SHA-256, payload/runtime identity and provenance
to the selected source SHA in each environment. Use `bun run dev:runtime-status -- --json` for ownership diagnostics
when applicable. If installation is needed, follow the sibling `install-global` skill; only the coordinator installs.
Respect active-worktree ownership and obtain explicit release before any takeover. A blocked owner or pending fix
means save NO-GO with the blocker, not install around the guard.

All CLI, MCP and Manager executions must use this globally installed candidate. Separate test data homes are allowed;
source runners, local `dist`, direct handlers and alternate per-test binaries are not equivalent evidence. A disposable
OS account/VM has its own global installation; record it independently. Verify actual MCP/Manager process identity
and test-home binding, reconnect/reinitialize real clients after installation, and retire superseded owned processes.
Do not use the graph's repository snapshot commit as executable provenance.

Record identity before and after every execution wave and each scenario; launcher and supervised process binding
must be checked, not assumed from `--version` alone. Candidate drift invalidates dependent rows. Freeze updates
through supported policy. No source edits, install changes or shared host-configuration changes during parallel waves.
For coordinator-owned upgrade/downgrade/uninstall cases, record the planned baseline-to-candidate transition;
intentional transitions are not drift. Verify restoration before any subsequent functional wave.

## 3. Coordinate low-cost workers

Use multiple low-cost background agents, normally `gpt-6-luna` with `reasoning_effort: low`, `fork_turns: none`.
Keep one coordinator plus at most three active workers, within available slots. Queue/reuse workers for additional
independent lanes; reserve a genuinely fresh agent for section 4's B. If that model is unavailable, request a permitted
low-cost alternative; do not silently switch to a costly model. If delegation is unavailable, record BLOCKED rather
than claiming the multi-agent matrix ran. Do not create user-owned sidebar chats for these subtasks.

Partition by state domain, not merely case count:

| Owner                 | Default queue                                                                                               | Isolation / exclusive authority                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Coordinator           | Candidate and oracles; sections 4, 5, 6, 18 release delivery; required CI/Stage 3; adjudication and cleanup | Sole global-install/shared host-config writer; lifecycle, payload fault tests and Stage 3 serialized              |
| Memory worker         | Sections 7, 8, 14, 15; section 11 except WRK-04/WRK-05                                                      | Own synthetic corpus, home, repo clone and MCP client profile; graph setup/coherence dependencies completed first |
| Graph worker          | Sections 9, 10; WRK-04/WRK-05                                                                               | Own F1–F3 clones/home/graph store and multi-repo workset dependencies; one graph builder writer per scope         |
| UI/integration worker | Sections 12, 13, 16, 17; section 18 SAFE cases when isolation permits                                       | Own home, disposable account/client/browser profile and Manager port; only approved fixture destinations          |

This is a queue suggestion, not coverage proof. Generate the exhaustive ID/lane assignment from the actual matrix;
explicitly assign cross-cutting rows and avoid double ownership. Reuse already-built fixtures only within their owner
domain. If accounts/profiles/ports cannot be isolated, serialize the affected cases. A different `THREADNOTE_HOME`
alone does not isolate the install root, launcher, agent settings or browser. CLI/MCP/Manager parity within one home
runs sequentially. Serialize team participants and approved graph enrollment when they share a remote/store.

Complete environment smoke and the section 4 A→B journey before broad parallel waves. B starts only after A stops,
with no forked history, A transcript, manually pasted handoff, test oracle or implementation answer. Give B only the
normal continuation request, synthetic repository and normal access to its shared Threadnote home. The coordinator
keeps hidden oracles and grades afterwards. A worker who already observed A cannot serve as fresh B.

### Worker assignment contract

Send each worker only this contract, assigned matrix sections/IDs, safety/evidence criteria (sections 1–3 and 19),
and necessary current task context. Do not require every worker to load the full matrix or all Threadnote skills.
Applicable repo/skill routing still applies; exact tasks do not justify redundant broad discovery.

```text
Run ID; model; candidate version/source SHA/global executable hash and runtime identity:
Assigned scenario IDs, lanes/surfaces, dependencies and oracle checks (evaluator-only for fresh B):
Absolute callerCwd; owned fixture/home/client/account/profile/port; isolation and write boundaries:
Evidence directory; worker ledger path; supported deadlines and cleanup margin:
External-action approvals (default none); coordinator contact and escalation conditions:
```

Workers verify global/process identity and preconditions, execute real assigned surfaces, independently check semantic
results and before/after invariants, and append evidence-bound rows using the template's per-case schema. Report
PASS / FAIL / BLOCKED / NOT RUN / justified N/A; never convert refusal, exit zero or unavailable evidence into PASS.
Keep writes within owned fixtures. Do not install/update/repair/uninstall or mutate shared host settings. Stop the
affected family on a safety failure, drift or broken prerequisite; send the smallest privacy-safe reproducer and leave
dependent rows BLOCKED. Write a concise private handoff, not a shared durable issue ledger.

After workers finish, pause them before coordinator-only lifecycle/host mutations in a disposable environment.
Restore/reverify the frozen candidate afterwards and run final surviving-lane checks. Cleanup only exact owned
resources, preserving unresolved-defect evidence. Never uninstall or corrupt the developer's actual installation.

## 4. Consolidate and decide

Read every worker ledger and inspect bounded primary artifacts; missing evidence for claimed PASS stays BLOCKED
until verified. Check assignment completeness, runtime identity, independent oracles and cleanup. Separate planning
audits from product executions, CI evidence from manual results, and parallel contention latency from performance
claims. Record unavailable usage counters as unavailable; no token-savings claim from this functional matrix.
Missing candidate/process/fixture identity receipts also mean BLOCKED even if semantics were observed. Mark
drift-affected entries BLOCKED and rerun them under the frozen candidate. Unrepresented entries remain NOT RUN;
if a supplied packet cannot establish exhaustive counts, label its counts partial and full coverage unknown rather
than inventing totals. Unexecuted optional observations remain NOT RUN, reported separately from required gates.

For a new defect, investigate minimally and prepare a privacy-safe `threadnote report-issue` preview on errors. If the
human authorized a designated fixing chat, send candidate/row, exact synthetic repro, expected/actual, mutation check,
bounded evidence and retest needs; request dev-cycle, focused tests, ownership-coordinated global smoke and a PR.
Otherwise report/request that coordination. Public issue creation still needs explicit human approval. Do not
hardcode a personal chat ID or initiate an unapproved external write.

Apply matrix section 19 and exact-candidate release gates. Return GO only when every required entry in the declared
phase/scope has verified passing evidence, allowed omissions have explicit review, and no unresolved blocking defect,
drift, missing environment or required gate remains. Do not claim release-wide GO from one platform. A narrower
smoke may pass while release signoff remains NO-GO; state that distinction. After a fix, start a new candidate report
and rerun the reproducer, affected families and critical journey; never relabel old-SHA evidence.

Save the signoff even on early blockage or interruption, with counts, uncovered scope, defects, gate references,
postpublication schedule and next actions. Update a private Threadnote handoff. Do not auto-commit or publish reports.
Return: `GO` or `NO-GO`, candidate + phase/scope, outcome counts, top blockers and the absolute report link.
