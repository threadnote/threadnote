# Threadnote token-efficiency historical corpus v1

This reviewed corpus freezes six unedited historical GitHub task packets against six independent public repositories. Each task uses the first parent before the known fix as its held-out checkout. The known fix is retained only for corpus admission and hidden-verifier calibration; it is never exposed to the coding agent.

All tasks use the `historical-as-issued` variant. The corpus therefore makes no claim that synthetic exact-name, paraphrase, absent-answer, conflicting-records, or dirty-worktree conditions were materialized. Repository clusters are independent at the project level, so clustered confidence intervals do not treat multiple revisions of one project as independent evidence.

The prompt is GitHub's title, two LF bytes, and the unedited body with CRLF normalized to LF. The body is retained separately as manual context when context exists. Context sufficiency was independently reviewed from the title and body alone, without solutions or provider outcomes. The tasks cover `none`, `lacking`, `sufficient`, and `excessive`; strata remain descriptive.

One linked memory per task was authored by a source-only reviewer using a Git archive of the pre-fix tree without Git history, task prompt, network, or known fix. During local materialization, each exact body must become a managed Threadnote memory with its corpus citation finalized against the pinned base revision.

## Local materialization

Ignored local artifacts live under `.context/token-efficiency-corpus-v1`: clean checkouts, graph databases, managed memories, homes, credentials, binaries, and outcomes. The committed corpus contains no credentials or transcripts.

The preparer calibrates the hidden verifier with the pinned verifier environment:

```sh
.context/token-efficiency-corpus-v1/verifier-venv/bin/python \
  apps/threadnote/test/evaluation/corpora/token-efficiency-historical-v1/verifiers/verify.py \
  <h11|hpack|attrs|click|werkzeug|packaging> /absolute/path/to/checkout
```

Admission requires exit 1 at the pinned base and exit 0 at the known fix. Preparation emits a hash-closed `verification-plan.json` bound into the study, runtime, adapter configurations, requests, observations, outcome ledger, and report. After each candidate patch is captured, the adapter reruns the task verifier in a credential-free, network-denied Seatbelt sandbox. Exit 0 is a deterministic completion; the verifier's explicit exit-1 diagnostic is a task failure and keeps its token cost; timeout, output overflow, sandbox denial, artifact drift, or any malformed diagnostic is an infrastructure failure that aborts before the immutable outcome ledger advances.

The macOS verifier sandbox permits host file metadata plus read-only access to the pinned Python environment, candidate checkout, verifier runner, and required system runtime trees. It denies network access and restricts writes to a fresh per-run verifier directory. Receipts bind the verifier environment—including resolved symlink target bytes—interpreter, runner, sandbox executable, plan, candidate artifact, diagnostic, and task identity; the claim is therefore scoped to that sealed local runtime rather than cross-operating-system bitwise reproducibility.

The blinded rubric judge remains a secondary sensitivity measure. Publication gates require non-inferiority for both deterministic completion and the hybrid verifier-plus-judge completion rate, and the report exposes both verifier-pass/judge-fail and verifier-fail/judge-pass disagreement cells.

The experiment runs from the base; fix checkouts are used only during preparation calibration and are never mounted into the agent or judge environment.

## Delivery calibration and pilot invalidation

The initial September 2026 pilot is development evidence, not a token-savings result. Seven of its ten Threadnote calls failed because the proxy required the agent to reproduce the task prompt byte-for-byte. The old adapter checked call count, not successful delivery. It also classified declined commands as harmful actions and returned the context body twice (text plus structured content). Keep its v3 ledger and transcripts unchanged; do not resume that manifest, silently migrate its metrics, or pool those observations with a corrected run.

Proxy v2 binds the task internally to the immutable packet. Its public tool schema has no task argument. It returns one canonical JSON text body, preserving graph and memory evidence, plus private receipt metadata binding the body hash, frozen prompt hash, run nonce, runtime manifest, and prepared graph/memory identities. The adapter requires exactly one successful, non-error response and checks every receipt field against the sealed request and delivered text. A failed, absent, duplicate, or mismatched response aborts before judging or appending an outcome. Captured patches, provider usage, the agent checkpoint (`.jsonl.agent.jsonl`), and a failure transcript remain diagnostic evidence; they must be disclosed separately from completed study observations. Never treat an aborted infrastructure run as zero-cost or selectively retry it inside an already interpreted study.

Outcome schema v5 requires separate `safety.blockedActions` telemetry and non-overlapping preparation, agent-task, deterministic-verifier, judge-setup, and judge-turn timings whose sum is the end-to-end lifecycle window; token-efficiency report schema v3 displays blocked actions. Declined attempts still contribute their provider tokens but are not executed harm. Actual harmful actions, authorization leaks, false-current outcomes, invalidity, and task failures retain their existing gates. Older outcomes are explicitly rejected by the new parser. Use the original revision when reproducing historical reports.

Before spending on a new study, calibrate exact formatted prompts and all three context arms against isolated copies of the frozen homes, verify delivery receipts through MCP and the adapter, and confirm useful graph/memory coverage. Passing delivery checks alone is not evidence that context helps. The unblinded six-task pilot is now development/calibration material; a confirmatory article claim needs a newly sealed, untouched evaluation corpus, declared accounting and thresholds, and a fresh manifest after harness and product changes are fixed.

`provenance.json` records identities, revisions, prompt sources, licensing, context assessments, and verifier selectors. `corpus.json` is the exact evaluator input. The local preparation plan is generated only after the final Threadnote 5.0.6 release commit, exact local binary, ready graph homes, managed memory IDs, known-fix checkouts, and the pinned verifier environment are known.

## Interactive treatments and exploratory pilot

The next local pilot is pinned to the published production **5.0.7** macOS arm64 release, not a development build. Preparation v3 accepts an explicit reviewed `threadnote.productionRelease` record binding the immutable GitHub tag, source commit, archive and executable SHA-256 values. Production mode requires the exact clean release source, package version and plain `threadnote v5.0.7` output plus the binary digest; a version string alone is not provenance. Its `threadnote.lockFile` is the verified complete release archive, preserving adjacent parser/native-runtime assets during isolated staging. Legacy local 5.0.6 preparation retains its separate exact-commit contract. Do not mix observations across these runtime identities. The production hashes and source commit were verified against the [immutable published release](https://github.com/Kashkovsky/threadnote/releases/tag/v5.0.7); they are intentionally platform-specific.

Preparation v3 explicitly declares its active arms; the primary setup selects `files`, `threadnote-graph`, and `threadnote-compact`. The stable latter name now denotes the interactive graph-plus-memory treatment, not a brief-only treatment. The manifest binds the selected subset and a v3 schedule. All five arm definitions remain available for generic studies; `threadnote-source` is an optional, distinct one-shot diagnostic and is not selected in the primary setup. A three-arm confirmatory schedule requires at least six repetitions to preserve complete position counterbalancing. This does not authorize executing that schedule when only a pilot was requested.

Adapter/config v4 and context-proxy v5 expose the following model-facing tools:

| Treatment                  | Initial call        | Optional follow-ups                                     |
| -------------------------- | ------------------- | ------------------------------------------------------- |
| Files only                 | None                | File reads/search and edits only                        |
| Graph                      | One `context_brief` | `inspect_code_graph`, `analyze_code_graph`              |
| Graph plus memory          | One `context_brief` | Same graph tools, plus `recall_context`, `read_context` |
| Optional source diagnostic | One `context_brief` | None                                                    |

Both interactive arms bind graph requests to the same prepared repository and pinned executable. Only the memory arm can read its isolated prepared memories. Remote worksets, arbitrary project/root overrides, writes, and unprepared memory namespaces are not exposed. Graph evidence refers to prepared snapshots; agents must verify current files after edits. The memory-enabled brief can change evidence selection as well as add memories, so graph-plus-memory versus graph measures the incremental **memory-enabled workflow**, not a pure identical-graph-dose memory effect.

Generic interactive studies retain a sealed allowance of up to four follow-up calls. Continuation treatments allow at most one optional follow-up after the required brief, and instructions require a named evidence gap before spending it. The proxy enforces the allowance; the adapter independently rejects transcripts that exceed it.

Every call has one text evidence body and an audit receipt binding its original arguments, tool name, result hash, success flag, frozen task, run, manifest and prepared context identities. The initial brief must succeed exactly once before follow-ups. Authenticated follow-up errors remain in the transcript and cumulative task usage. Skills are not installed in the isolated agent home; brief evaluator instructions and tool schemas still have token cost. This setup does not measure normal installed-skill startup, background-agent or warm-continuation overhead.

The isolated app-server uses a no-network workspace-write sandbox, while a one-shot client policy reviews every prompted command and file change before accepting it. The policy rejects additional filesystem/network permissions and validates current app-server action shapes, repository containment, bounded diffs, and the literal shell program. Before any provider turn, the adapter reads a tracked source file, applies and removes a disposable repository-local file, and proves representative out-of-root, network, expansion, and outside-write actions remain denied. Its receipt is retained beside the transcript, and repository integrity is rechecked afterward. The read grammar still permits only a narrow `git diff` form with no revisions, arbitrary options, external diff driver, or out-of-repository paths.

Verifier admission is behavioral, not known-patch identity matching. The attrs check accepts alternative implementations that preserve the shared `evolve` metadata and replacement semantics. The Click check covers strict non-string equality plus empty-string, sequence, enum, dynamic and boolean formatting. The Werkzeug check requires strict static acceptance of standalone and bound decorators and exercises both runtime call shapes plus HTTP-exception conversion; a minimal local `markupsafe` test shim supplies only the dependency surface needed by those wrapper checks. Base revisions must still fail and known fixes pass before a bundle is sealed.

For the next harder development calibration, task selection is preregistered before outcomes using relationship depth, discovery burden, acceptance breadth, and historical production-change surface. The selected task is Werkzeug `tsk_40aa8260ce35eb0588e0d85f`: its concise prompt requires reconciling static overloads with an existing variadic runtime wrapper, while the strengthened oracle checks both contracts. This known corpus is already unblinded development material, so the selection is useful for product calibration but cannot support a held-out article claim.

For exactly one attempt per primary variant on a common task, prepare a fresh bundle and invoke the separate pilot path:

```sh
bun scripts/run-matched-evaluation.ts \
  --corpus /absolute/fresh-study/corpus.json \
  --manifest /absolute/fresh-study/manifest.json \
  --runtime /absolute/fresh-study/runtime.json \
  --study /absolute/fresh-study/study.json \
  --pilot-task tsk_1c391a7896906b29202da55b \
  --pilot-directory /absolute/fresh-pilot
```

The pilot seals three first-repetition rows in frozen schedule order before execution, refuses resume/retry, and writes a descriptive `pilot-report.json` separately from the full-study ledger. Task choice must be recorded before outcomes. Include failed attempts and their checkpoint usage; missing usage is unknown, never zero. Compare deterministic completion first, then provider input/cached/output tokens, wall time, tool selection and evidence use. One task and one attempt per arm do not support confidence intervals, reliable memory attribution or a general token-savings claim. Preserve the frozen original pilot unchanged and do not pool either exploratory run with a later held-out confirmatory study.
