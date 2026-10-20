---
author: Denys Kashkovskyi
publishedAt: 2026-10-20T17:00:00Z
slug: keeping-agent-memory-current
summary: Threadnote’s source-driven memory experiment exposed a gap between safe updates and useful answers. What failed, what we changed, and why review still matters.
title: Keeping agent memory current takes more than a rewrite
---

A coding agent remembers that a service times out after 30 seconds. The implementation changes to 60 seconds. The next
agent finds the old explanation, complete with a citation, and confidently repeats 30.

Finding that the source changed is only the beginning. The explanation may also contain a policy, a historical
decision, and facts about another environment. Updating one number must not quietly rewrite those paragraphs. Keeping
the old explanation untouched preserves the mistake.

That is the problem behind [Threadnote RFC #756](https://github.com/threadnote/threadnote/issues/756): use changes in
declared supporting evidence to propose a focused update to an existing topic memory, then let a reviewer inspect
and approve the result.

We built the workflow and tested an early version over a sequence of source changes. **The completed synthetic study
returned HOLD.** The six accepted maintained writes passed the audited storage and preservation checks, but downstream
answers still contained substantial errors. That distinction shaped the work behind Threadnote 5.3. The experiment
did not establish human time savings, lower total cost, or general semantic correctness.

## A memory contains different kinds of statements

Consider an explanation with these three statements:

| Statement                                              | What a source change can tell us                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| “The production timeout is 30 seconds.”                | A directly supporting configuration change may justify a factual update. |
| “Timeout changes require an operational review.”       | A new numeric value does not revoke this policy.                         |
| “We selected 30 seconds after the original load test.” | This can remain true as history after the current value changes.         |

The workflow records paragraph roles: descriptive, normative, and historical. It also records whether the cited
evidence directly supports a paragraph, supplies context, or leaves support unresolved. Automatic proposals are
limited to directly supported descriptive paragraphs; policy and history remain protected.

These labels constrain a proposal. They do not prove that the paragraph is true, that its evidence is sufficient, or
that the model understood the change. The reviewer still needs the source quotations and the complete proposed
memory. The [review implementation](https://github.com/threadnote/threadnote/pull/825) accounts for every eligible
paragraph with an update, an unchanged-support decision, or an unresolved decision.

Original evidence and current support also serve different purposes. The original citation records where the
explanation came from. An approved support update records what now supports it. Preserving the first should not force
the system to keep treating it as the current implementation.

## What the experiment actually compared

The [completed run](https://github.com/threadnote/threadnote/pull/818) used one synthetic repository, 50 chronological
source events, two repetitions, and four declared conditions: **400 recorded slots**. It ran against source commit
`bc8a6ef4ca601c81dc2d9bea9f1e26abdede7f80`, before the later refinements described below.

The conditions had materially different boundaries:

- **Scripted manual:** deterministic fact repairs through ordinary memory replacement. No human reviewer performed
  this condition.
- **Maintained local:** real local Gemma draft generation, a fixture-specific reviewer, public approval or rejection,
  and writes to canonical memory.
- **Naive local:** real local Gemma rewrites of the text evaluated by the experiment. After bootstrap, those rewrites
  did not replace durable memory.
- **Maintained alternate:** no alternate synthesis backend was configured and permitted. Retained source observations
  and local answer diagnostics do not constitute an alternate-provider comparison.

The downstream answering step received the evaluated topic once, plus the same bounded public source projection.
That tests answers from **a topic plus selected source excerpts**. It does not test the complete production retrieval
workflow or memory alone.

The fixed condition order, two correlated repetitions, and single synthetic repository limit the result. Hundreds of
questions in one trajectory are not hundreds of independent real-world tasks.

## The approval boundary held in the audited writes

The maintained condition issued 54 draft commands. Forty-three completed with drafts; six resulted in accepted writes,
and 37 were refused and closed through public rejection.

All six accepted writes matched their approved previews and preserved the checked identity, immutable origins,
protected content, and current registered facts. Only two changed the production timeout from 30 to 60. The other four
refreshed evidence bindings without a new production-value change. Calling these “six successful factual repairs”
would overstate what happened. Eight other slots lacked a current-event observation within the bounded wait, leaving
their final readbacks unknown. The [published study summary](https://github.com/threadnote/threadnote/pull/818) retains
the accepted-write findings and the experiment’s limits.

The refused proposals matter too. Some changed protected prose. Others repaired a number while leaving another
registered fact stale. Refusing those proposals protected accepted memory, but it also left work undone.

The other conditions need equally careful language. The scripted manual condition made 32 ordinary storage writes
that failed the study’s strict original-provenance preservation check; that does not establish irrecoverable loss of
all historical evidence. The naive condition made 60 generations and changed its evaluated text 34 times. Those were
not 34 unsafe durable-memory writes.

## Safe acceptance did not produce reliable answers

For a like-for-like descriptive comparison, the three configured conditions shared 528 primary question positions
each. Missing observations stay in that denominator:

| Condition        | Correct | Wrong assertion | Incorrect abstention | Needs adjudication | Missing |
| ---------------- | ------: | --------------: | -------------------: | -----------------: | ------: |
| Scripted manual  |     330 |               6 |                  192 |                  0 |       0 |
| Maintained local |     252 |              45 |                  173 |                  2 |      56 |
| Naive local      |     138 |               8 |                  382 |                  0 |       0 |

An incorrect abstention means the answer withheld a fact it should have supplied. A wrong assertion means it supplied
an incorrect fact. Both fail the task, but they are different failures. Neither count is a count of unsafe accepted
memory writes. These are the shared-denominator results reported with
[the evaluation](https://github.com/threadnote/threadnote/pull/818), not a claim of a statistically established winner.

We also found a coverage problem. Across all 66 jointly answered primary event positions, the compared source bytes
and questions matched, but the configuration excerpts were omitted throughout. Equal inputs can still be incomplete
inputs. The answer therefore depended in part on whether the evaluated topic had retained or repaired the needed
fact.

This made separate measurements essential: Was the source present? Was it selected? Did generation repair the topic?
Did review accept the right proposal? Did the final answer use the available evidence correctly?

## Earlier failures changed how we evaluated later updates

Three earlier executions stopped after 119, 131, and 154 slots. They remain invalid diagnostics, separate from the
completed run. We did not combine them or rescore them under a later policy.

The first consumed a cached scheduler result before the topic received its current turn. The second left a refused
public review open, blocking later proposals. The third assumed that earlier updates had succeeded when deciding
which edits were permissible.

That last mistake exposed a useful lesson. Suppose a memory still says 30 because its previous update failed, while
the source has since moved from 60 to 90. A reviewer that assumes the memory already says 60 can reject a legitimate
catch-up or overlook other stale claims.

For the fourth run, we registered the review policy before execution: derive permitted repairs from the **actual
accepted memory** and eligible current source. Protect already-current facts, policy, history, and unrelated content.
Require existing registered direct claims to be current before acceptance. This fixture-specific reviewer is an
evaluation tool, not a general semantic verifier built into the product. The
[evaluation change](https://github.com/threadnote/threadnote/pull/818) preserves both the correction and the earlier
negative evidence.

Fault coverage needed the same discipline. The planned source-race apply case was refused before reaching apply;
defer/resume was also not reached in the completed comparison. Eighty unsupported-fault slots remained
diagnostic-only. A scenario’s name in a test plan does not prove that its intended transition ran.

## What changed after that result

The follow-up work narrowed generated edits and strengthened review accounting. It made source inclusion and omission
visible in evaluation helpers, added separate full-source and memory-only diagnostic inputs, and exercised review
transitions independently of generation. These were changes to the product and its verification, not retroactive
improvements to the completed study. See the [first follow-up](https://github.com/threadnote/threadnote/pull/820).

Later work required a disposition for every directly supported descriptive paragraph and preserved the reviewer’s
selected support even when prose stayed unchanged. It also retained bounded private generation diagnostics.
Incorrect and misleading proposals still occurred, including text copied from instructions embedded in source.
Structural validity did not make those proposals trustworthy. The
[review-accounting change](https://github.com/threadnote/threadnote/pull/825) explicitly retains that limitation.

The opt-in workflow then expanded to one private Obsidian note and explicitly selected one-hop code dependencies or
configuration files. Imported evidence requires approval of the inspected excerpt and separate approval of the final
memory. Private imported provenance remains excluded from sharing and export. Dependency expansion requires a
reviewed selection and adequate coverage evidence; it does not discover every semantic dependency automatically.
Those boundaries are described in the [scope-expansion change](https://github.com/threadnote/threadnote/pull/826).

The original study’s HOLD remains the result for that measured version. Subsequent engineering progress does not
convert it into a positive benchmark or establish human benefit.

## What a reviewer should be able to see

For an enrolled topic, the useful review sequence is concrete:

1. Inspect the declared evidence and the change that triggered attention.
2. Compare each proposed factual edit with its supporting quotation.
3. Check unchanged claims, policy, history, and the complete final memory.
4. Approve that exact preview, or edit, defer, or reject it.

Approval is bound to the reviewed memory, proposal revision, and supporting evidence. If relevant source or target
state changes, the old approval must stop authorizing a write. Applying a private update and publishing knowledge to
a team remain separate decisions.

That makes the work inspectable. Whether it makes review faster or improves answers on real projects still needs a
genuine human pilot. The synthetic manual condition cannot answer that question. Neither command timings nor zero
recorded provider charges establish total cost: reviewer effort, local compute, missing usage, and correction work
still matter.

## Evidence and limits

The public trail starts with [RFC #756](https://github.com/threadnote/threadnote/issues/756), the
[completed experiment and reproduction commands](https://github.com/threadnote/threadnote/pull/818), and the later
implementation changes linked above. The
[measured evaluation source](https://github.com/threadnote/threadnote/blob/bc8a6ef4ca601c81dc2d9bea9f1e26abdede7f80/apps/threadnote/src/evaluation/topic-maintenance-longitudinal.ts)
is pinned to the original commit. Model-free replay reproduced the recorded summary; replay is not an independent
rerun.

The original raw archive, failed trials, and private research notes are preserved separately and are not published
with this article. The public summary and source support inspection of the method and reported findings, but they
are not a complete public replication package.

The next useful evidence is varied real topics, genuine reviewers, complete usage and effort accounting, and
prospectively registered comparisons. Until then, source-driven maintenance is a way to put a bounded proposed change
in front of a reviewer. A current citation, a valid draft, an approved write, and a useful answer each need their own
evidence.
