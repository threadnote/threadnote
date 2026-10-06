---
author: Denys Kashkovskyi
publishedAt: 2026-10-03T12:30:00Z
slug: graphmem-agent-continuation-study
summary: 'Five repository tasks. Threadnote used 65.62% fewer lifecycle tokens per verified completion and 46.14% less time. All five patches passed verification, versus four with files alone. Here is the evidence, including the limits.'
title: How much do coding agents spend rediscovering a codebase?
---

The agent found the bug. Added a regression test. Figured out which assumption was wrong.

Then the session ended.

The next agent gets the same repository and starts investigating. Again. You have hired a second detective who has
the crime scene, but not the first detective's notes.

We built Threadnote to carry useful engineering context between sessions. For the 5.1 release cycle, we wanted to
measure something less photogenic than a memory demo: **does that context actually reduce the work needed to finish
a task?**

So we ran a paired continuation experiment on five public repositories. Each task started with the same completed
first phase, then split into two fresh sessions: one with files alone, the other with a Threadnote handoff and a
focused code-graph query.

> Across these five tasks, Threadnote used **65.62% fewer lifecycle provider tokens per verified completion** and
> **46.14% less lifecycle time per verified completion** than files-only continuation. Threadnote passed verification
> on 5/5 tasks; files-only passed on 4/5.

This is our own small, single-model study, not an independent evaluation or a promise about every coding task. The
tested build was **Threadnote 5.1.0-beta.2**. The baseline had **no handoff**. Those details belong next to the result,
not in microscopic text at the bottom.

## Same checkpoint, different starting context

For each task, a common first session added a regression test and diagnosed the defect. We preserved that repository
checkpoint and measured its token usage. Two fresh sessions then continued independently from it, with one attempt per
condition and no retries.

- **Files-only:** the task and checkpoint repository files, without a handoff or Threadnote tools.
- **Threadnote:** the same starting checkpoint, plus a compact, product-generated continuation handoff preloaded before
  the first response. The agent also executed one required task-specific code-graph query derived from the first
  session's diagnosis. No manually written handoff was supplied.

The second condition tests a complete continuation workflow. It does not isolate the value of memory from the value of
the graph. The evidence bundle calls this condition `threadnote-preloaded-resume`; **GraphMem Continuation v1** is the
study's short name, not another product.

All ten continuation attempts used OpenAI `gpt-5.6-luna` with the same sealed parameter configuration. The
[preserved request](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/evidence/tasks/click/pilot/runs/run_a51f7c019b6a96e15ba1ea3a078f805c/request.json)
records the model, handoff, graph query and candidate identity. The source commit was
`8da0eae878aaedc419319e32fd10fdcb5abccbb1`.

## Five real defects, not five ways to print hello

The tasks covered Python and Go, with a separate held-out verifier for each defect:

- **Click:** preserve abbreviations while generating short help.
- **Pluggy:** unregister every hook implementation owned by one plugin.
- **Chi:** preserve actual handlers when enumerating the route tree.
- **Gin:** reset backtracking state between HTTP method lookups.
- **Echo:** avoid mutating caller-owned RFC 9457 problem values.

Take Click. The first session had already narrowed the problem to short-help generation. The continuation's graph
question targeted callers and tests of `click.utils._make_default_short_help`. That is the kind of specific starting
point we want to preserve: the relevant code and the question still open, rather than a transcript of everything the
first agent said.

The [task evidence](https://github.com/threadnote/threadnote/tree/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/evidence/tasks)
and [verification plan](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/protocol/prepared-study/verification-plan.json)
retain the repository revisions, task contracts and verification records.

## Count finished work, including the cost of failure

“Done” is a sentence an agent can generate. It is not a test result.

We counted a completion only when the patch passed deterministic checks against both the visible continuation contract
and the held-out task contract. The files-only Pluggy attempt reached a terminal runner state but failed its held-out
check. Its tokens and time still counted; it contributed no verified completion.

We also charged both conditions for the common first session. Otherwise we would be treating the work that produced
the handoff as free.

The primary metric was:

```text
tokens per verified completion =
  (common first-session tokens + all assigned continuation tokens)
  / verified completions
```

The shared first sessions cost **634,597 tokens**, charged to each condition. The continuation sessions added 2,381,069
tokens for files-only and 661,443 for Threadnote. No attempt was dropped for missing usage or elapsed-time accounting.

| Metric                                    | Files-only | Threadnote |
| ----------------------------------------- | ---------: | ---------: |
| Assigned continuations                    |          5 |          5 |
| Verified completions                      |          4 |          5 |
| Total lifecycle provider tokens           |  3,015,666 |  1,296,040 |
| Lifecycle tokens per verified completion  |  753,916.5 |    259,208 |
| Lifecycle seconds per verified completion |    285.375 |    153.702 |

That produces the **65.62% reduction per verified completion**. If you compare total tokens across the five assigned
workflows without dividing by successful completions, the reduction is **57.02%**. Both are useful numbers; they answer
different questions. The larger figure reflects both lower token use and the observed completion counts.

These are provider-token and elapsed-time measurements, **not a claim of equivalent dollar savings**: cached input,
uncached input and output may have different prices.

## Fewer tokens in every task pair

Threadnote used fewer lifecycle tokens in all five pairs, not just in the task where files-only failed verification.

![Paired lifecycle token totals on a shared zero-based scale. Threadnote used fewer tokens in Click, Pluggy, Chi, Gin and Echo. The files-only Pluggy attempt failed verification; all other attempts passed. Exact values follow in the table.](/graphmem-continuation-tokens.svg)

The chart and table below show **total tokens per assigned workflow**, including its first session. They are not the
per-verified-completion metric above.

| Repository | Files-only tokens | Threadnote tokens | Verified: files / Threadnote |
| ---------- | ----------------: | ----------------: | ---------------------------- |
| Click      |           560,404 |           209,818 | Yes / Yes                    |
| Pluggy     |           621,988 |           319,182 | No / Yes                     |
| Chi        |           526,224 |           201,392 | Yes / Yes                    |
| Gin        |           657,529 |           390,933 | Yes / Yes                    |
| Echo       |           649,521 |           174,715 | Yes / Yes                    |

The analysis resampled whole repository-task pairs in **10,000 cluster-bootstrap draws** with a frozen random seed.
The 95% interval for the token reduction per verified completion was **50.80% to 81.56%**.
These intervals describe uncertainty within this five-task corpus, not a guarantee across software engineering.

## Time to completion: about 2m34s versus 4m45s

Saving tokens is useful. Getting a working patch sooner is the part you notice while waiting for the agent.

**Lifecycle time per verified completion fell from 285.375 seconds to 153.702 seconds: 46.14% less time**, or about
**2m12s saved per verified completion**. The repository-cluster bootstrap 95% interval was **25.25% to 73.38%**.

This uses the same accounting as the token headline: add the common first-session time and every assigned continuation,
including the failed attempt, then divide by verified completions. It is not the average duration of successful runs
after quietly dropping the failure. The recorded workflow includes setup and evaluation overhead, not just the time the
agent spends editing code.

Across all five assigned workflows, the lifecycle totals were **1,141.500 seconds for files-only** and **768.510 seconds
for Threadnote**, a **32.68% reduction in total measured time** before dividing by completions. Both include the same
391.659 seconds of first-session work. The fresh continuation sessions alone took 749.841 versus 376.851 seconds in
total; those figures exclude the shared first phase and are not the headline metric.

| Repository | Files-only lifecycle seconds | Threadnote lifecycle seconds |
| ---------- | ---------------------------: | ---------------------------: |
| Click      |                      179.619 |                      122.845 |
| Pluggy     |                      230.997 |                      161.289 |
| Chi        |                      204.802 |                      156.835 |
| Gin        |                      286.463 |                      216.087 |
| Echo       |                      239.619 |                      111.454 |

Threadnote took less measured time in every pair. **Pluggy's files-only time is time spent on an unsuccessful attempt,
not time to a working fix.** The [per-attempt timing records](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/results/continuation-outcomes.jsonl)
retain both phases separately. These are measured benchmark durations, not a promise about latency on your machine.

## Result quality: did the patches actually work?

A faster wrong answer is still a wrong answer. The primary quality check was whether each patch passed the visible
continuation checks and the task-specific held-out verifier. **Threadnote passed 5/5; files-only passed 4/5.** The
files-only Pluggy patch failed verification. This is tested functional correctness within those contracts, not a rating
of maintainability, style or every possible edge case.

The evidence also includes a separate **model-judge rubric score from 0 to 1,000**. The judge assessed the patch and
agent result against a hidden task rubric; its instructions reserved 1,000 for a fully satisfied completion contract.
These scores are useful secondary diagnostics, not percentages of code that is correct or independent human reviews.

| Repository | Files-only verified | Threadnote verified | Files-only judge score | Threadnote judge score |
| ---------- | ------------------- | ------------------- | ---------------------: | ---------------------: |
| Click      | Pass                | Pass                |                    400 |                    650 |
| Pluggy     | Fail                | Pass                |                      0 |                    720 |
| Chi        | Pass                | Pass                |                    550 |                    320 |
| Gin        | Pass                | Pass                |                    720 |                  1,000 |
| Echo       | Pass                | Pass                |                    350 |                  1,000 |

The descriptive mean was **738/1,000 for Threadnote versus 404/1,000 for files-only**. Threadnote scored higher on four
tasks, but lower on Chi, even though both Chi patches passed the deterministic checks. The judge's own completion
verdict was also stricter: 2/5 for Threadnote and 1/5 for files-only. Those verdicts are separate from the **5/5 versus
4/5 deterministic verification** used in the headline accounting. The frozen protocol set the minimum judge-score
threshold to zero; the result is not a claim that every patch earned full marks from the judge.

The [assessment records](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/results/continuation-outcomes.jsonl)
preserve both kinds of assessment, and the [Pluggy request](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/evidence/tasks/pluggy/pilot/runs/run_65917de36692400483fd3c2f6d4698c3/request.json)
shows an example rubric. With five tasks, one attempt per condition and no separate uncertainty analysis of the rubric
scores, we do not turn that mean into a general claim of better code quality.

The completion-rate difference was +20 percentage points, with a 95% interval from 0 to 60 points. We therefore report
5/5 versus 4/5, but **do not claim an established completion-rate advantage**.

The study passed its preregistered gates: a minimum 5% token reduction, a five-percentage-point completion
non-inferiority margin, and its safety thresholds. Both conditions recorded zero harmful actions and authorization
leaks, but each recorded three false-current assessments; that gate allowed up to 1,000. Passing it does not mean zero
stale-context errors. Blocked actions were 4 for Threadnote and 20 for files-only, descriptive counts rather than proof
of a particular mechanism. See the
[aggregate report](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/results/continuation-report.json)
for the full accounting.

## What this study does not settle

**Would a good plain-text handoff achieve the same result?** We did not test that. We excluded a manual-context arm
because we had not standardized a representative amount and quality of human-written context. That
[protocol decision](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/protocol/no-manual-context.json)
limits the comparison; it does not make a manual handoff ineffective or impossible to evaluate.

**Was it the memory, the graph, or both?** This experiment cannot separate them. The results are consistent with less
rediscovery, but they do not identify how much of the effect came from each component. There was no memory-only or
graph-only condition.

**Could order or task selection matter?** Yes. Assignment order was randomized but not balanced: Threadnote ran first
in four of five pairs. With five tasks, one model and one configuration, we cannot generalize the effect to every
repository, language, agent or task size. Held-out tests also cannot establish the absence of every possible defect.

The next useful test is a larger, position-balanced replication on new tasks, with standardized handoff and component
comparisons. Five tasks gave us a reason to investigate further, not permission to stop measuring.

## Inspect the evidence

The [GraphMem Continuation v1 bundle](https://github.com/threadnote/threadnote/tree/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1)
is pinned to an immutable commit. It preserves the original study identity, `threadnote-continuation-v19-final`, and
the tested beta's source and binary identities.

Start with the
[report](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/results/continuation-report.json),
[per-attempt outcomes](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/results/continuation-outcomes.jsonl)
and [frozen protocol](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/protocol/final-study/continuation-study.json).
The [bundle README](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/README.md)
explains its layout and omitted execution machinery. From a local checkout of that commit, verify the preserved files:

```sh
cd studies/graphmem-continuation-v1
shasum -a 256 -c SHA256SUMS
# GNU coreutils alternative: sha256sum -c SHA256SUMS
```

That checks file integrity, not an independent rerun. Frozen binaries, dependency caches and prepared execution
environments are not vendored; recreating the experiment requires reconstructing those inputs. The accounting is
available to inspect without pretending the bundle is a one-command replication kit.

The practical takeaway is narrow but useful: on these tasks, carrying a compact handoff and a focused code-navigation
step across the session boundary made verified continuation substantially less token-intensive and less time-consuming,
with all five Threadnote patches passing the task checks. That is evidence of a useful continuation workflow, not a
blanket claim of superior code quality.

If your coding workflow keeps paying for the same investigation twice, start with the
[Threadnote workflow](/docs/threadnote-5-journey/) and [first useful task](/docs/first-workflow/). Check what the next
session can actually reuse. A memory is only useful if it saves someone from doing the work again.
