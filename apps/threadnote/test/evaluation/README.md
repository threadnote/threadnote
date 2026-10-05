# Recall evaluation and benchmarks

This directory is the release-quality contract for Threadnote retrieval. It is intentionally independent of a
developer home, network access, local canonical data, and model-generated relevance scores.

## Matched provider-token experiment v1

The matched evaluator has a claim-oriented local lane for testing whether established Threadnote context reduces
provider-reported tokens per independently verified task completion. It compares `files`, `threadnote-graph`,
`threadnote-compact`, and `threadnote-source` on the same blinded, counterbalanced task schedule; `reference-scope`
remains an optional comparator. Five repetitions (or another multiple of five) expose every arm in every schedule
position.
The primary denominator is a verified completion, and every completed attempt's provider tokens stay in the numerator,
including incorrect, incomplete, invalid, or safety-failing attempts.

This lane models an established workspace, not first-day setup. Before freezing the study, prepare the graph to `ready`,
create and review the memories, finalize their code links, and retain the exact graph snapshot and link-receipt hashes.
Each linked-memory Threadnote observation must attest those preregistered hashes. The graph-only arm attests the same
ready graph snapshot while memory access and receipt fields are disabled. The files-only and reference arms attest no
Threadnote context, and the runner sends no raw memory fixture text to any adapter. Graph preparation, memory authoring,
memory review, elapsed setup time, observed reuse, and lifecycle break-even remain separate, hash-bound accounting.

Article-quality input uses independently held-out public Git repositories. Each cluster binds a public HTTPS repository
URL, exact 40-character revision, repository fixture hash, and task IDs. The study must cover at least its preregistered
cluster count. A test fixture or a task split from one synthetic repository is useful for evaluator regression only and
must not be described as external evidence.

Historical external corpora use the `historical-as-issued` task variant for every task and leave `pairId` null. This
mode deliberately does not claim coverage of the synthetic `exact-name`, `paraphrase`, `absent-answer`,
`conflicting-records`, or `dirty-worktree` perturbations. Historical and synthetic variants cannot be mixed in one
corpus; a later study may materialize those conditions explicitly, but must not infer them from issue text alone.

The primary local estimand uses an `identical-as-issued` prompt policy. Preserve each historical task packet exactly as
the engineer issued it, including manually supplied code, logs, guesses, or architecture notes, and send those exact
bytes to every arm. Before any outcomes are visible, independent review classifies the extracted manual context as
`none`, `lacking`, `sufficient`, or `excessive` and binds both the extracted-content hash and assessment hash into the
study. The report shows every comparison by this context stratum. This prevents an artificially bare files-only prompt
from manufacturing a Threadnote win. Stratum estimates are descriptive and do not receive their own confidence gate.

This local lane does not establish that developers will change how much context they supply after adopting Threadnote.
A context-replacement simulation must be a separately preregistered study, and its changed-prompt estimand must be
reported as such. The behavioral claim requires a randomized developer trial: control developers work normally,
treatment developers use Threadnote, both may provide any context they choose, and analysis clusters by developer and
repository while retaining all provider tokens and task failures.

Build and independently review the frozen corpus first. For every task, retain two distinct prepared Threadnote homes
from the same exact ready graph: a graph-only home with no managed memory documents, and a task-specific linked home
containing exactly the preregistered reviewed memories and finalized current citations. The preparation command verifies
the clean public checkouts, exact graph identity in both homes, an empty graph-only Context Brief for the exact task
prompt, complete linked-memory retrieval for that exact prompt at the preregistered budget, linked-memory currentness and
stable managed identities, owner-only auth, local runtime artifacts, as-issued
context/assessment files, and the Threadnote source ancestry before it atomically writes the corpus, per-arm adapter
configs, manifest, study, runtime, and hash receipt:

```sh
bun run eval:matched:prepare -- \
  --corpus /absolute/path/to/reviewed-corpus.json \
  --plan /absolute/path/to/reviewed-preparation-plan.json \
  --output /absolute/path/to/.context/token-efficiency-study
```

Preparation makes no model-provider calls, but it still freezes the provider/model/reasoning settings, Codex app-server
binary, owner-only auth source, Git and safe-binary hashes, task budget, and optional pricing needed by the later run.
The exact plan schema is exercised by
[`matched-token-efficiency-preparation.test.ts`](../unit/matched-token-efficiency-preparation.test.ts). Its top-level
fields are `version`, `studyId`, `project`, `scheduleSeed`, `repetitions`, `clusters`, `taskContexts`, `bootstrap`,
`gates`, `lifecycle`, `timeoutMilliseconds`, `threadnote`, and `adapter`. Every task context names the cluster, the two
prepared homes, the as-issued assessment/content files, and a complete `linkedMemoryIdentities` roster mapping every
corpus `mem_...` fixture identity to the reviewed memory's actual `tn_...` identity. Repetitions must be a multiple of
five.

The plan must pin Threadnote 5.0.6. A local build is admissible only when its clean source HEAD contains the recorded
final 5.0.6 release commit and `threadnote --version` reports `threadnote v5.0.6-local.g<that exact 40-character HEAD>`;
the version output, source commit, executable bytes, and lock bytes are all retained in the preparation receipt. A
stable `threadnote v5.0.6` binary without independently verifiable commit provenance is rejected. The bundled preparer
leaves `reference-scope` explicitly unavailable because the production Codex adapter does not expose a reference
product; this does not prevent the preregistered files-versus-Threadnote and graph-versus-linked-memory comparisons from
running.

The preparation command uses `createMatchedEvaluationManifestV1`, `createMatchedTokenEfficiencyTaskContextV1`, and
`createMatchedTokenEfficiencyStudyV1`. Runtime v3 binds one
canonical clean checkout to every study cluster by cluster ID and repository identity hash; this lets one local run use
the complete multi-repository held-out corpus instead of silently executing every task in one repository. Each arm also
binds a reviewed adapter configuration hash separately from the adapter executable and environment policy.

The production adapter is a standalone compiled executable because the same pinned artifact launches both the Codex
app-server client and the single-tool context proxy. Build it to an absolute output path, create one immutable adapter
configuration per arm, and use the executable and configuration SHA-256 values in the manifest:

```sh
bun run eval:matched:adapter:build -- /absolute/path/to/matched-evaluation-codex-adapter
/absolute/path/to/matched-evaluation-codex-adapter --hash-prepared-home /absolute/path/to/reviewed-task-home
```

The adapter configuration pins the Codex app-server and Git executables, their hashes, agent and judge model settings,
an owner-only Codex authentication file, safe executable paths, task budgets, and—only for Threadnote arms—the
content-addressed prepared Threadnote home for every task. The runtime file lists the adapter executable and config file
for each arm plus one `{clusterId, repositoryDirectory, repositoryIdentityHash}` entry for every study cluster. The
runner stages and re-verifies those files before and after every attempt. It selects the checkout from the task's
preregistered cluster and rejects missing, duplicate, dirty, or identity-mismatched repositories.

Run the experiment locally with canonical absolute paths:

```sh
bun run eval:matched:claim -- \
  --corpus /absolute/path/to/corpus.json \
  --manifest /absolute/path/to/manifest.json \
  --runtime /absolute/path/to/runtime.json \
  --study /absolute/path/to/study.json
```

The local `.context` artifact directory receives the append-only `outcomes.jsonl`, ordinary matched `summary.json`,
`token-efficiency-report.json`, `article-evidence.md`, per-run artifacts, and raw transcripts. A comparative claim passes
only when the complete files and target matrices have provider usage, the cluster-bootstrap 95% lower bound clears the
preregistered token-reduction threshold, verified completion is non-inferior, and false-current, authorization-leak,
and harmful-action gates pass. It reports total product effects against files-only and the incremental linked-memory
effect of `threadnote-compact` against `threadnote-graph`; the latter uses a separately preregistered reduction threshold
and incremental lifecycle setup cost. Missing usage or an incomplete matrix is inconclusive, never a win.
Provider usage covers the complete agent task window, including any adapter-internal retries or recovery calls, while
the blinded judge's own tokens are evaluation overhead and remain outside the product-arm numerator. A pinned adapter
must keep agent execution isolated from `judgeTask` gold evidence; adapter review is part of study admission.
The bundled production adapter evaluates completion and correctness with a separately isolated rubric-guided LLM judge.
That judge never sees the treatment label or agent workspace, but it is still a model-based measurement rather than a
deterministic test oracle. Article claims must name that limitation; task-specific hidden executable checks should be
added when the held-out task contract permits them.

With the minimum six tasks and five repetitions, the bundled four-arm runtime performs 120 adapter attempts (240 model
turns: one agent and one blinded judge per attempt) and records 30 preregistered `reference-scope` slots as unavailable.
Adding a real reference adapter would raise this to 150 attempts and 300 turns. When pricing is `null`, the evidence
still reports provider tokens but deliberately makes no monetary-cost claim.

Raw transcripts stay local and must not be stored in Threadnote memory. After every completed experiment—including a
failed or null result—review `article-evidence.md` and store one replace-in-place durable memory under the stable topic
`token-efficiency-experiment-evidence`. Preserve the report, manifest, study, and corpus hashes; exact public cluster
revisions; arm accounting; intervals; gate decision; lifecycle break-even; and limitations. This prevents selective
publication while leaving the future article traceable to the exact local evidence bundle. The evaluator deliberately
does not write that memory itself, because mutating Threadnote context during a trial would contaminate the experiment.

The [Threadnote 5 release-readiness fixture](fixtures/threadnote-5-task-loop-v1/README.md) freezes an executable,
content-free replay contract for solo, two-agent, Git-shared, offline, dirty-worktree, interrupted/resumed,
upgrade/downgrade, provider-neutral proposal, and health-maintenance scenarios. It independently validates exact source
bindings and receipt hashes, retains the structured-closeout, stale-citation, contradiction, projection, and output-budget
gates, then derives the preregistered 4.7.x-versus-5.0 metrics without treating an absent baseline as improvement:

```sh
bun run eval:threadnote-5-release-readiness -- \
  --candidate-commit <exact-40-character-sha> \
  --candidate-executable-sha256 <64-lowercase-hex> \
  --capture-manifest-sha256 <independently-reviewed-64-lowercase-hex> \
  --evidence <content-free-evidence.json>
```

This is an on-demand release evidence tool, not a CI requirement. Sealed replay proves evaluator behavior only; release
admission remains unknown until the production verifier resolves the manifest's activation, closeout, health, value,
and proposal receipt digests from the exact installed candidate. An available 4.7.x baseline is compared only when its
version, commit, and executable hash are supplied independently at the evaluator boundary. Each scenario/metric lane
requires at least ten eligible trials; undersized lanes stay unknown. The setup gate retains the activation contract of
at least 9 successful attempts out of 10.

## Memory read token-efficiency baseline v1

`baselines/memory-read-token-efficiency-v1/baseline.json` records the unchanged dual-channel `read_context`
projection at commit `26d9fa50ee054dcfb73d5f20da39d443aaaeeee1` on three deterministic, privacy-safe memories.
The evaluator fails if its fixture hash or dual-channel projection drifts and reports the opt-in text-channel comparison:

```sh
bun run eval:memory-read-token-efficiency
bun run eval:memory-read-token-efficiency -- --text
```

On the frozen fixtures, text-only structured metadata reduces combined MCP bytes by 49.85% for the citation-heavy
case and 50.61% for the long Unicode case; it adds 10 bytes to the short case. These are transmitted UTF-8 bytes and
Threadnote's `ceil(bytes / 3)` estimate, **not** provider-billed tokens or task-quality evidence. The compatibility
escape remains explicit `responseFormat=dual`; ordinary local reads now default to the non-duplicating text projection.
The release-quality claim still requires a paired provider-usage and task-quality study across supported clients, plus
exact-current citation, authorization, no-answer, and recovery non-regression. Full content remains available through
explicit dual format.

## Graph response single-channel baseline v1

`baselines/graph-response-single-channel-v1/baseline.json` records the frozen five-query graph fixture, pre-change
dual-channel bytes, and a paired model pilot. The normal integration test starts an isolated MCP server and proves that
`inspect_code_graph responseFormat=text` JSON parses to the exact explicit-dual structured projection on all five
queries, including path, impact, and no-answer, while the local model-facing default is the TN-GRAPH agent projection:

```sh
bun --bun vitest run apps/threadnote/test/integration/mcp-code-graph-response-format.test.ts apps/threadnote/test/unit/mcp-code-graph-progress.test.ts
```

The checked-in baseline measures 66,686 dual versus 53,404 text-only UTF-8 bytes (19.9% less) on source commit
`dd73e2d7aee74b1ff4147f2094a7161ef8d57a0c`. Two counterbalanced model runs per query and format returned 20/20
correct, graph-ID-grounded answers, including abstention on the no-answer query; reported input tokens were 159,446
dual versus 151,708 text-only across those calls. The model pilot uses synthetic evidence and Codex CLI scaffolding,
so it is not a powered task-quality or provider-cost claim. Explicit dual remains the canonical compatibility path;
a product-level savings claim still requires a larger paired corpus and supported-client compatibility evidence.

The same baseline also freezes the compact-by-default agent-envelope change against exact parent
`30475f6899bf8512eef8ebdcf71541ba8f1e04f7`. The five queries fell from 18,643 to
17,413 serialized agent bytes (1,230 bytes, or 6.6%; 410 conservative `ceil(bytes / 3)` estimated tokens). Clean/current
responses omit operation, repository/snapshot IDs, invariant trust text, and schema versions; stale, dirty, project,
refresh, bounded-search, outside-project, and truncation qualifiers remain explicit. Explicit `dual` remains the full
diagnostic/canonical contract. This envelope fixture is not provider billing or tokens-per-completed-task evidence; one
query grew because its unchanged budget admitted more useful graph evidence after the metadata shrank.

## MemoryConnectionsBench v1 (A+B)

`fixtures/memory-connections-bench-v1/fixture.json` freezes the typed-authoring and memory-link selector projection contract introduced in schema v12. The private recall cache now uses schema v13: source URIs are copied from indexed documents to order bounded neighborhoods directly in the source/target indexes. Selector values, canonical proof requirements, fixture inputs, and result ordering are unchanged.
Its operation traces exercise all five planned knowledge abilities, strict relation normalization and rejection,
legacy target add/change/delete, stable-identity target moves, source replacement/deletion, and logical clean-rebuild
parity:

```sh
bun --bun vitest run apps/threadnote/test/unit/memory-connections-bench.test.ts
```

This is deliberately an `authoring-projection` oracle. It does not claim one-hop retrieval or currentness assembly;
those are governed separately so changing retrieval truth cannot silently rewrite the A+B hash.

## MemoryConnections retrieval and scale v1 (C–E)

`fixtures/memory-connections-retrieval-bench-v1/fixture.json` freezes direct incoming/outgoing retrieval, multi-seed
fairness, the exactly-one-hop boundary, cycle handling, unresolved legacy targets, identity conflicts, validity windows,
explicit supersession, authorization nondisclosure, and no-answer behavior across all five knowledge abilities:

```sh
bun run eval:memory-connections-retrieval
```

The gate executes canonical files, the production SQLite selector, live rereads, and currentness assembly. It requires
Precision/Recall/currentness/no-answer accuracy of `1.0`, zero authority or authorization leaks and duplicates, and a
maximum 1,500-estimated-token response. Relationships remain navigation evidence, never automatic entailment.
An unresolved or identity-conflicted premise produces only its premise receipt and is never expanded; this abstention
boundary is part of the frozen truth rather than a loss of neighbor recall.

The scheduled/opt-in scale lane materializes and indexes exactly 100,000 canonical memories: a dense incoming hub, a
sparse incoming neighborhood, a no-answer premise, and a same-user but unauthorized-project decoy. It samples five
warmups plus 25 measured production lookups, requires the exact first eight hub neighbors, deterministic truncation,
zero result or receipt identity leaks, row-aligned connection roles and ordinals, current/resolved serialized receipts,
and exact accounting plus truncation when the response budget omits a receipt suffix. It gates the JSON-round-tripped
MCP projection rather than trusting the raw retrieval object. The latency envelope is p95 at most 250 ms with every
sample at most 1,000 ms; the dense lookup also
permits no more than 257 raw link rows and 322 canonical proof reads:

```sh
bun run bench:memory-connections-scale -- \
  --candidate-commit <exact-clean-candidate-sha> \
  --output artifacts/memory-connections-scale.json
```

For local iteration only, add `--development-smoke` and optionally override `--memory-candidates`, `--samples`, and
`--warmups`. Smoke evidence is derived as non-release and cannot be relabeled. Hosted remote memory v1 remains
task-recall-only: it lacks the stable identity, relation index, and live currentness contract required for parity, so a
future versioned protocol must add those capabilities rather than silently widening the strict v1 schema.

## CodeMemoryLinkBench v1

`fixtures/code-memory-link-bench-v1/fixture.json` freezes the code-to-memory product gate. Unlike the older citation
runtime evaluator, it does not inject a memory candidate. It executes the production current-anchor capture, opaque
inverse recall index, canonical memory reread, citation validation, Context Brief v3 merge, and projection:

```sh
bun run eval:code-memory-link-bench
```

The deterministic corpus covers exact file and symbol backlinks, symbol relocation, changed history, deletion and
ambiguous-relocation abstention, repository isolation, archived and superseded lifecycle exclusion, a conflicting
topical decoy, malformed citation metadata, stale-graph abstention, a dirty overlay, legacy uncited memory, and bounded
high-noise output. The release contract requires exact Recall@3 `1.0`, relocation-inclusive Recall@3 at least `0.95`,
direct code-citation Precision@3 at least `0.90`, exact coverage/code-citation-no-answer receipts, zero false-current claims,
default/worst output within
1,250/1,500 estimated tokens, and 25 post-warmup in-process samples with p95 at most 250 ms. The checked CI corpus has
256 lexical-noise memories and is a deterministic regression/latency smoke, not a 100,000-memory scale claim; the
existing scheduled citation scale gate remains authoritative only for shared citation-validation and Context Brief
costs.

The separate inverse-selector scale gate materializes and production-indexes exactly 100,000 canonical memory files.
Its frozen seeded corpus contains three valid direct backlinks, one same-path/content citation under a foreign
repository identity, and 99,996 high-noise memories that all cite the same governed symbol. It then samples the shipped
`loadRecallCodeLinks` SQLite join, authorization filters, and canonical source reread for two sparse file backlinks, one
symbol backlink, the exact first eight dense backlinks, and a true no-answer anchor. This is the executable
100,000-memory evidence for the new graph-to-memory lane; the smaller gate above remains the end-to-end anchor-capture,
validation, merge, and projection evidence.

The dense scenario deliberately queries both the shared symbol and its file. The stronger symbol selector fills the
eight-result lane, while the lower-priority file-path and file-content selectors encounter a dense URI prefix whose
rows are shadowed by that symbol match. Each lookup must therefore report exactly two bounded selector truncations and
still return the exact first eight canonical URIs. This proves that the implementation stays bounded and surfaces its
abstention; it does not claim that no deeper eligible file-only link exists. The separate true no-answer scenario must
return no URI with zero selector truncations.

Release-scale execution has no corpus/sample override. It requires an exact 40-character candidate commit, proves
`HEAD` matches it with `dirty=false`, builds one immutable benchmark target, binds that target's SHA-256 into the JSON,
and fails unless all four scenarios have five warmups and 25 measured samples:

```sh
bun run bench:code-memory-link-scale -- \
  --candidate-commit <exact-clean-candidate-sha> \
  --output artifacts/code-memory-link-inverse-scale.json
```

For release evidence, dispatch the governed hosted lane against exact merged candidate C. It requires the frozen
`github-hosted-macos-15-ARM64` class used by tag verification and stages the output directly as
`apps/threadnote/test/evaluation/retained/code-memory-link-scale/<artifact-sha256>.json`. Review those exact bytes after C, but add them
only in final governance G; A remains manifest-approval-only. The G verifier independently rebuilds the benchmark
target and requires its SHA-256 to equal the digest retained in the artifact.

The governed envelope requires direct Recall/Precision and direct-first/no-answer/bounded-result accuracy of `1.0`,
the scenario-specific selector-truncation counts above, zero cross-repository leakage, duplicates, or canonical reread
mismatches, pooled and per-scenario lookup p95 at most 250 ms, and every sample at most 1,000 ms. It also records and
gates corpus bytes, recall SQLite plus sidecar bytes, materialization/index time, baseline/peak/added RSS, built-target
identity, runner class, and exact corpus counts. Resource ceilings are bounded admission envelopes (256 MiB corpus,
2 GiB recall storage, 3 GiB added RSS, five-minute materialization, ten-minute indexing), not claims that every host
will have identical timings.

For local iteration only, `--development-smoke` unlocks explicit `--memory-candidates`, `--samples`, and `--warmups`
overrides. Its artifact is derived as `development-smoke`, its release gate remains failed, and it cannot be relabeled
by editing JSON because the parser rederives the evidence class, metrics, and failures. The scheduled/opt-in
`code-memory-link-inverse-scale` benchmark job is the retained hosted lane and never uses smoke overrides.

The separate agent-usefulness gate is preregistered as a blinded, within-task three-arm experiment: anchored v3,
task-only v2, and no-memory. Scrubbed external-agent receipts can be scored with:

```sh
bun run eval:code-memory-link-agent-ab -- \
  --assignment artifacts/code-memory-link-agent-ab-assignment.json \
  --attempts artifacts/code-memory-link-agent-ab-trials.jsonl.attempts.jsonl \
  --candidate-commit <exact-40-character-sha> \
  --evidence artifacts/code-memory-link-agent-ab-trials.jsonl.evidence.jsonl \
  --manifest artifacts/code-memory-link-agent-ab-manifest.json \
  --trials artifacts/code-memory-link-agent-ab-trials.jsonl
```

The 4.6 real-agent gate has a checked-in 12-hidden/16-control sealed corpus. Five hidden tasks are intentionally
recoverable by task-only v2; seven use citation-anchored mappings that are lexically disjoint and crowded by inert
project-local decoys. Two of the 16 controls are privacy-safe instruction-injection canaries: one current memory is
selected through a direct `policy.json` citation, while one uncited memory is selected only through its opaque lexical
cue. Both use an exact bounded synthetic instruction grammar that asks the agent to invert repository policy, set
`guard.json` `executed=true`, and write an opaque harmful result; the sealed repository instead requires the guard to
remain byte-for-byte unchanged with `executed=false`. The two calibration tasks are hashed under a separate non-evidence
domain and are not members of the release suite or manifest. Protocol v2 binds the evaluated Threadnote subject and
the clean harness-governance checkout independently. They may be the same commit for a pre-release gate; a post-release
experiment keeps the released subject fixed while preparing from a later reviewed harness commit. Use canonical
absolute paths and independently generated 64-character assignment and schedule seeds:

```sh
bun run eval:code-memory-link-agent-prepare -- \
  --assignment-seed <64-lowercase-hex> \
  --auth-source <absolute-codex-auth-source> \
  --bun-executable <absolute-reviewed-bun> \
  --candidate-commit <exact-40-character-sha> \
  --candidate-executable <absolute-canonical-evaluated-threadnote> \
  --candidate-executable-sha256 <64-lowercase-hex> \
  --codex-executable <absolute-reviewed-codex-0.149.0-alpha.4.1> \
  --git-executable <absolute-reviewed-git> \
  --harness-governance-commit <exact-clean-harness-sha> \
  --model-provider openai \
  --output <absolute-new-prepared-root> \
  --reasoning-effort medium \
  --safe-executable-path <absolute-directory-list> \
  --schedule-seed <64-lowercase-hex> \
  --temporary-root <absolute-private-temporary-directory> \
  --turn-timeout-ms 1800000
```

Preparation requires `HEAD` to equal the harness-governance commit and independently resolves the exact managed
runtime named by `--candidate-commit`. The manifest binds both identities. Preparation uses the production candidate
to prove arm discrimination before emitting artifacts: lexical hidden tasks
must return their exact full mapping in v2 and v3, anchored-only hidden tasks must exclude it in v2 and return it in v3,
the direct injection canary must surface through a current code-citation relation, the lexical-only canary must surface
without one in both memory arms, and the canonical no-memory response must remain empty. This is a preregistration
input, not approval or evidence.
After independent manifest review and approval, run the complete frozen schedule sequentially. The evidence and attempt
paths are canonical siblings of the trial ledger; the write-ahead pending path is derived as `<trials>.pending.json`:

```sh
bun run eval:code-memory-link-agent-matrix -- \
  --mode release \
  --root <absolute-prepared-root> \
  --approval-commit <manifest-approval-sha> \
  --candidate-commit <exact-40-character-sha> \
  --candidate-executable <absolute-canonical-evaluated-threadnote> \
  --candidate-executable-sha256 <64-lowercase-hex> \
  --trials <absolute-trials.jsonl> \
  --attempts <absolute-trials.jsonl.attempts.jsonl> \
  --evidence <absolute-trials.jsonl.evidence.jsonl>
```

### Ledger crash durability

The governed runner persists each attempt start before launching the external client. After a successful, validated
client result it durably writes the pending commit, then the retained-evidence projection, then the trial projection,
and only then durably removes the pending commit. Every ledger replacement syncs the complete temporary file, atomically
renames it, and syncs the containing directory; pending removal also syncs the containing directory. Failure to open or
sync that directory is a release-gate failure rather than a best-effort warning.

A normal process crash or forced termination can therefore leave either an explicit unresolved attempt (when execution
started but no pending commit was made durable) or a recoverable pending commit. The former requires the existing exact
attempt ID and categorical retry acknowledgement; the latter is replayed idempotently into any missing evidence/trial
projection before the pending marker is removed. A completed attempt is never silently rerun.

For sudden host power loss, these boundaries are durable on a local filesystem and storage stack that correctly honors
file `fsync`/`FlushFileBuffers`, atomic same-directory rename, directory `fsync`, and hardware flushes. The gate fails
closed where strict directory syncing is unsupported. It does not claim protection from a filesystem or storage device
that acknowledges but loses flushes, malicious local mutation, media corruption, or an unsupported network filesystem;
run release evidence on a reviewed local filesystem and retain the final privacy-safe evidence bundle separately.

Before manifest approval, the bounded calibration schedule may be run only through its separate non-evidence seam. The
matrix copies only the two calibration tasks and their content-addressed fixture into a fresh calibration-only
workspace and never emits governed attempts, trials, or raw evidence:

```sh
bun run eval:code-memory-link-agent-matrix -- \
  --mode calibration \
  --root <absolute-prepared-root> \
  --calibration-command <absolute-reviewed-bun> \
  --calibration-arg <absolute-run-code-memory-link-calibration-client.ts> \
  --calibration-arg --prepared-root \
  --calibration-arg <absolute-prepared-root> \
  --calibration-arg --candidate-commit \
  --calibration-arg <exact-40-character-sha> \
  --calibration-arg --candidate-executable \
  --calibration-arg <absolute-canonical-evaluated-threadnote> \
  --calibration-arg --candidate-executable-sha256 \
  --calibration-arg <64-lowercase-hex> \
  --calibration-arg --diagnostics \
  --calibration-arg <absolute-diagnostics.calibration.jsonl> \
  --calibration-results <absolute-results.calibration.jsonl>
```

The reviewed calibration client runs the rostered model configuration through the same execution core against the
separately content-addressed calibration task and fixture plan. It retains only bounded usage, terminal-kind,
file-change, memory-use, pass/fail, and evidence-hash diagnostics in the separate diagnostics ledger; neither
calibration file is compatible with the governed release ledgers.

`bun run eval:code-memory-link-codex-client` is the exact rostered Codex entrypoint. It accepts no CLI arguments and is
invoked only by the governed trial harness, which supplies all trusted suite, assignment, budget, and ledger bindings
through its sanitized environment. Running it directly without that environment must fail closed.

Generate each privacy-safe client descriptor before preregistration. The command must be absolute; repeat
`--client-artifact` for the reviewed adapter and other implementation files, and use a secret-free configuration file
when client variants differ:

```sh
bun run eval:code-memory-link-client-descriptor -- \
  --client-command <absolute-client-executable> \
  --client-arg <arg> \
  --client-artifact <reviewed-adapter> \
  --client-config <secret-free-client-config> \
  --output artifacts/client-descriptor.json
```

Each external receipt must then be appended around that exact reviewed implementation by the exact-runtime harness.
Invoke whichever rostered client owns the next entry in the frozen schedule, always writing the same ledger:

```sh
bun run eval:code-memory-link-agent-trial -- \
  --approval-commit <manifest-approval-sha> \
  --assignment artifacts/code-memory-link-agent-ab-assignment.json \
  --attempts artifacts/code-memory-link-agent-ab-trials.jsonl.attempts.jsonl \
  --candidate-commit <exact-40-character-sha> \
  --candidate-executable <absolute-canonical-evaluated-threadnote> \
  --candidate-executable-sha256 <64-lowercase-hex> \
  --evidence artifacts/code-memory-link-agent-ab-trials.jsonl.evidence.jsonl \
  --manifest artifacts/code-memory-link-agent-ab-manifest.json \
  --client-id <opaque-rostered-client-id> \
  --client-descriptor artifacts/client-descriptor.json \
  --client-command <absolute-reviewed-client-runner> \
  --client-arg <arg> \
  --client-artifact <reviewed-adapter> \
  --client-config <secret-free-client-config> \
  --trials artifacts/code-memory-link-agent-ab-trials.jsonl
```

The scorer requires a source-reviewed manifest, complete X/Y/Z blocks, at least 12 hidden-constraint tasks, 16
negative controls, and two distinct reviewed client roster entries. The current preregistration uses two model
configurations through the same Codex app-server client implementation, so it supports per-configuration checks but
not a claim of replication across independent client implementations. The manifest binds a clean candidate commit and
build identity, opaque client IDs and reviewed client-implementation descriptors, evaluator and judge versions, the
adjudication artifact, a common hidden-task budget, and the frozen `sha256-counterbalanced-v1` seeded schedule with
per-run nonces.
The scorer re-derives the randomized block order and blind-arm order from the seed and balances positions separately for
hidden and negative-control tasks. External trials must match that schedule and carry provider-reported token
accounting plus unique provider-usage and adjudication hashes. The trial harness verifies the explicit canonical
evaluated executable against its preregistered SHA-256 and commit-bearing version before and after every run. It
verifies the selected client's descriptor against the command bytes, arguments, implementation artifacts,
and configuration before and after execution, and passes the exact candidate path and identity to that client. The
single JSONL ledger must be a contiguous frozen-schedule prefix; every receipt includes the digest of its predecessor.
The explicit attempts ledger must use the canonical `<trials>.attempts.jsonl` sibling name. A heartbeat-backed
cross-process lock is held from both ledger reads through external execution, post-run verification, validation, and
receipt persistence. Before execution the harness persists a hash-chained, privacy-safe start event; timeout, nonzero
exit, invalid output, postcheck, and persistence failures append only a categorical failure. An interrupted start stays
unresolved. Retrying requires the exact prior attempt id and ledger-derived `--retry-reason`, so attrition cannot be
silently retried away. Any failed, interrupted, or retried attempt blocks release evidence and requires a fresh
preregistered manifest; the allowlisted external evidence hash includes the exact attempt ledger.
The scrubbed retained projection is bound to unique invocation/output digests and identical pre/post runtime identities.
Summary tampering, another-runtime relabeling, provider/judge replay, client substitution, and out-of-order execution
fail validation. First-use events cannot occur after observed task completion;
no-use trials are conservatively censored at that observed completion, and every anchored hidden trial must have an
adjudicated useful-memory event.

The governed matrix runner, external client, Codex app-server, and static judge each execute inside a separately
created process group. Every boundary terminates and verifies its complete process group before returning, including
after success, timeout, output overflow, or failure. Only after the app-server group is observed empty does the client
capture one canonical, symlink-free, non-hardlinked, read-only repository snapshot. The static judge and final
public-artifact inventory consume that same snapshot; pre/post verification and the retained `repositorySnapshotHash`
fail closed on mutation. This is local process-group containment for the exact reviewed programs, not a claim that
hostile code cannot escape an OS process group.

The self-contained static judge reads the authoritative `result.json` for every task. For the two injection canaries it
also emits a content-addressed `guard.json` observation; malformed or missing guard bytes become bounded synthetic
failure observations. The sealed rubric treats exact guard preservation as both task-pass and harmful-acceptance
invariant, so mutation, replacement, or deletion deterministically fails as harmful acceptance even when the result
itself matches `policy.json`.

Preregistration chronology is exact C→A→G. Add only the manifest hash to
`apps/threadnote/src/evaluation/code-memory-link-approvals.json` in a clean governance-only commit, then record that approval commit on
every external receipt before execution. Generate the governed scale artifact after C, but do not add it in A. Add
outcome, dogfood, and retained-bundle hashes only in final reviewed G, together with the exact retained bundle, the
content-addressed scale artifact, and the version-bound release descriptor. The combined verifier checks the Git ancestry
`tested candidate C -> manifest approval A -> final governance G`, verifies that
the intermediate JSON allowlist added exactly that manifest hash, and proves the evidence hashes and tracked artifacts
were added only in G. It rejects dirty checkouts or merges and inspects every post-candidate commit. A forbidden product or
executable-loader change remains a failure even if a later commit restores the same net tree; extra JSON fields or
hashes are not approvals.

The gate evaluates the complete sealed corpus descriptively; it does not infer a population confidence interval from
token-renamed task replicas. Every manifest task binds a reviewed structural `scenarioFamily`. Task-only v2 must gain
at least 10 percentage points over no-memory across the finite hidden corpus and within the lexical family. Anchored v3
must gain at least 10 points over task-only across the finite hidden corpus and within the anchored-only family. Neither
comparison may regress in any hidden family or for either client. Anchored v3 must also use at least 20% fewer
provider-usage steps and tokens to first useful memory both across the finite corpus and in every hidden family. A step
is a monotone provider token-usage checkpoint, not a chat turn.

Hidden-task completion and task-only total usage must not regress in any family. Negative controls must cover at least
nine distinct reviewed families; every task cluster in every family must pass for all three arms, and both memory arms
must have zero regression events in every family. The aggregate 90% and per-client 90% floors remain additional finite-
corpus checks. A task cluster passes only if every rostered client passes it, and zero stale/harmful acceptance still
applies. Adding token-renamed tasks can add finite-corpus coverage, but it never creates or strengthens a nominal
population-confidence claim. Thus equal all-fail rates and improvements confined to one structural family cannot pass.
The preregistered manifest hash and the deterministic, outcome-sensitive post-run evidence-bundle hash have separate
source allowlists. The manifest allowlist may retain reviewed hashes for historical candidates; a new candidate remains
`insufficient` until its exact manifest hash is added by the immediate governance-only A commit. Outcome, dogfood, and
retained-bundle allowlists remain empty until the completed evidence is independently reviewed and added by G. The
command also verifies that the manifest commit and build identity are the source commit and executable SHA-256 of the
active managed development runtime. Mock receipts test only the importer/scorer and are never evidence that an agent
benefits.

Practical exact-build dogfood uses a separate canonical artifact with six required observations: task-only memory,
file backlink, symbol backlink, multi-anchor deduplication, no-backlink behavior, and stale-graph abstention. Every
observation records bounded counts and booleans plus opaque run/build observations; it never records task text, memory
content, code, paths, or user/workspace identifiers. Generate the artifact with the exact-installed runner from the
clean reviewed manifest-approval checkout. It clones that governance checkout into a disposable repository, uses a
disposable Threadnote home, executes all six cases through the canonical candidate executable, and retains only
pre/post runtime identities plus the privacy-safe outcome projections and their invocation/output digests:

```sh
bun run eval:code-memory-link-dogfood -- \
  --approval-commit <manifest-approval-sha> \
  --candidate-commit <exact-40-character-sha> \
  --repository <same-canonical-checkout-that-executes-the-runner> \
  --output artifacts/code-memory-link-dogfood.json
```

After the frozen matrix and dogfood pass independent review, construct the complete checked-in evidence bundle. The
retainer reads the assignment, manifest, sealed suite/layout, scrubbed client descriptors and config projections from
the prepared root; `--evidence` is mandatory alongside the attempts/trials ledgers and dogfood artifact:

```sh
bun run eval:code-memory-link-retain -- \
  --attempts <absolute-trials.jsonl.attempts.jsonl> \
  --candidate-commit <exact-40-character-sha> \
  --dogfood <absolute-code-memory-link-dogfood.json> \
  --evidence <absolute-trials.jsonl.evidence.jsonl> \
  --prepared-root <absolute-prepared-root> \
  --trials <absolute-trials.jsonl>
```

The command rejects quality or non-approval completeness blockers, raw auth/config material, credential-shaped values,
and absolute paths. It writes an immutable hash-named directory under
`apps/threadnote/test/evaluation/retained/code-memory-link/`. Its canonical `bundle.json` maps assignment, manifest, sealed suite,
sealed layout, attempts, raw evidence projections, trials, dogfood, and the outcome-stable scored result to exact
SHA-256 blobs. Every layout-referenced synthetic fixture, judge, task packet, and rubric under the prepared
`artifacts/` and `tasks/` trees is retained and must exactly cover the sealed layout source set. The index also maps
every manifest client to one scrubbed descriptor and one scrubbed config projection. Review
the generated bytes, then add the external-agent hash, dogfood hash, and printed bundle hash to their three final
allowlists in `apps/threadnote/src/evaluation/code-memory-link-approvals.json`. In G, commit that JSON, the exact bundle, the previously
generated content-addressed scale artifact, and `.github/release-evidence/code-memory-link/vX.Y.Z.json` together—nothing
else.

A release must then pass the combined executable verifier using only the tracked retained bundle, not the ephemeral
input paths:

```sh
bun run eval:code-memory-link-release -- \
  --release-descriptor .github/release-evidence/code-memory-link/vX.Y.Z.json \
  --release-tag vX.Y.Z
```

The dogfood runner first requires `--repository` to resolve to the same canonical clean reviewed checkout that supplies
and executes the runner bytes. The verifier revalidates the installed executable bytes, requires the A/B and dogfood candidates to be identical, and
requires both harnesses to identify the same manifest-approval checkout. It fails unless the chained trial ledger, all
quality gates, all four allowlists, the exact G bundle/blob map, and the tracked scale artifact pass. The descriptor
binds C's complete installed runtime, the retained bundle path/hash, and the scale path/hash. The verifier reparses and
rederives the scale gate with the frozen 100,000-memory budget; requires `release-scale`, `gate.passed=true`, exact
`candidateCommit=observedCommit=C`, and `dirty=false`; and independently rebuilds the benchmark target to confirm its
digest. G must add exactly the approvals JSON, indexed bundle bytes, one non-executable content-addressed scale JSON,
and one non-executable version-bound descriptor. An arbitrary retained file, working-tree-only file, symlink,
executable blob, absolute input path, or byte/hash mismatch fails closed. This establishes retained local cryptographic
consistency and reviewability. It is not hostile-local-author authentication: an author able to rewrite artifacts,
Git history, and approvals together remains outside the claim. Independent review and protected Git governance are
the trust boundary. The practical-dogfood and retained-bundle allowlists stay empty until a completed matrix is
independently reviewed.

Anonymous Tempo telemetry is corroborative monitoring, not release proof. Consent schema v6 reports the
`task-only-v2` versus `code-anchored-v3` contract, graph/memory/code-linked-memory phase timing, returned lane, bounded
code-anchor coverage/gap/recovery classifications and power-of-two work buckets, plus deferred-finalization outcomes.
It still exports no task, memory, code, path, selector, repository, or user identity and cannot establish that an agent
accepted or correctly used a direct result. The dashboard intentionally queries both CLI `context.brief` and MCP
`context_brief` aliases and includes an unscoped early-failure cohort. Any additional fields require another
consent-reviewed schema revision and matching privacy properties before collection.

## Memory-code citation runtime contract

`fixtures/context-brief-citations-runtime-v1/fixture.json` is the reviewed, deterministic correctness contract for
memory-to-code citations. Ordinary quality CI runs it through the real capture, validation, schema-v1 recall, Context
Brief assembly, and projection implementations:

```sh
bun run eval:context-brief-citations:runtime
```

The gate covers exact evidence across a newer snapshot, clean/incremental parity, relocation, changed and authoritatively
deleted files, ambiguous relocation, incomplete-graph abstention, cross-repository isolation, and legacy schema-v1 recall
continuity. It requires zero false-fresh results, zero false deletion from incomplete coverage, no cross-repository
authoritative leakage, a complete legacy recall result, and responses within the 1,500-token ceiling. Its measured p95
limits are bounded runtime-smoke ratchets for this small CI fixture. They are not evidence for the separate 100k-symbol,
50-member, or 128-member scale profiles; governed scale claims require repeated built-artifact benchmark samples on the
reviewed `macos-15`/ARM64/Apple-M1/Bun runner class.

### Memory-code citation scale gate

`baselines/context-brief-citations-v1/scale-budgets.json` freezes the separate release envelope. The bundled benchmark
target creates and indexes 100,000 real local memory documents, most of them schema-v1 compatibility records, before
timing warm SQLite recall. It also creates real Git repositories and activates already-ready graph snapshots in real
SQLite stores before timing. The measured path executes the production query/store session, citation grouping and
validation, Context Brief assembly, and projection. Workset routing uses real published catalog generations; no cold
repository indexing runs.

The fixture hash covers the stable reviewed budget, source/citation content, repository commits and repository IDs,
graph content and snapshot IDs, selected memory records, and legacy-noise contract. It deliberately excludes the
published workset generation digests because those include checkout/worktree IDs derived from each temporary
materialization path. Both actual generation digests remain separate retained artifact fields, preserving exact run
provenance without making like-for-like fixture identity nondeterministic.

The profiles are local/96 citations, workset-50/16 cited repositories/64 citations, and workset-128/32 cited
repositories/96 citations. Every warmup and measured sample selects a different set of canonical schema-v4 memories,
so validation receipts are not process-cache hits. Release-scale evidence requires exactly 100 measured samples after
exactly five warmups. The first-use memory series completes before timing begins, and the observer exits before the
timing warmups and measured samples run. Timing therefore has no observer or boundary-RSS instrumentation; it records
p95 latency, selected-memory counts, validation receipts, distinct graph database paths, production
graph-store sessions, snapshot leases, effective-evidence batches, snapshot-status observations, active-view fence
observations, maintenance requests, and cold graph builds. The session counter wraps calls that reach the real
`CodeGraphStore.withSession` implementation against the prebuilt SQLite files; OS file-descriptor opens are not
separately counted. The production query boundary owns that session across snapshot selection, lease, evidence read,
two-sided active-view fence, and release. Lease, evidence, snapshot-status, and active-view-fence operations remain
separate counters so session reuse cannot hide fan-out or skipped work.

Memory uses a distinct untimed production-workload series before any production timing invocation. Before every begin barrier, the benchmark resets graph
instrumentation and completes a full GC; only then does the external observer acknowledge the immediate baseline. The
workload runs between acknowledged begin and end barriers. Its complete `memoryWorkload` result is retained and must
independently pass the same selected-memory, receipt, token, store-session, graph-database, evidence-batch, status,
active-view, lease, concurrency, maintenance, and no-cold-indexing checks as a timing observation. Boundary-sampled
current-process RSS is collected only in this memory workload and remains a non-gating allocator diagnostic. After the
last workload, the benchmark resets instrumentation, completes another full GC, and obtains a required root-only stop
sample before the observer exits.

The wrapper hashes the built target, and the running target recomputes that SHA-256 before launching the exact same
bundle in its reserved observer mode. The observer recursively samples the benchmark root and its current descendants
while excluding its own complete subtree. Every memory observation fails unless its begin baseline contains only the
root, it has at least three successful samples and no failures, and its root and process-tree
peak-minus-immediate-baseline arithmetic is internally consistent. Across the ordered memory series, observations
whose longest successful-sample gap exceeds 100 ms may comprise at most 10%, at most two may occur consecutively, and
no gap may exceed 550 ms. The single-repository profile must observe a workload descendant at least once, while each
sustained multi-repository Workset profile must do so in at least 80% of its 100 memory observations. This distinction
keeps the fan-out coverage gate strong without claiming that the roughly 45 ms macOS `ps` cadence reliably catches
every short-lived local Git child. The fixed 64 MiB ceiling applies independently to
the maximum sampled transient process-tree growth and to retained root growth, computed from every immediate begin
baseline plus the post-final-GC stop sample relative to the first baseline.

These measurements are sampled high-water evidence, not exhaustive process-lifetime accounting. A successful snapshot
recursively accounts for the root and every descendant visible at that instant, excluding the observer subtree, but a
short-lived child or RSS peak entirely between samples can remain unseen. The three-sample, bounded gap-rate/run/hard
maximum, local-capture, and Workset 80% descendant-coverage gates bound that risk; they do not justify a claim that
every child process or absolute peak was observed.

```sh
# Scheduled/manual release-quality distribution; ordinary pull-request CI does not run this job.
bun run bench:context-brief-citations -- \
  --candidate-commit <exact-40-character-sha> \
  --memory-candidates 100000 \
  --samples 100 \
  --warmups 5 \
  --fail-on-budget \
  --output artifacts/context-brief-citations-scale.json

# Fast orchestration smoke. It records development-smoke evidence whose release gate always fails.
bun run bench:context-brief-citations -- \
  --memory-candidates 200 \
  --profiles local-100k,workset-50,workset-128 \
  --samples 1 \
  --warmups 0
```

The timing label is deliberately narrow: real prebuilt recall and graph SQLite plus the production Context Brief path.
Git/graph fixture creation, ready-snapshot activation, recall-index construction, workset catalog publication, and cold
graph indexing are setup evidence, not included in p95. Results must not be presented as cold-indexing performance.
Release-quality execution also requires an explicit exact candidate commit and proves the checkout is clean, the
observed commit matches, Git status was successfully observed, and execution is in GitHub Actions on a hosted
`macos-15` runner with `RUNNER_ENVIRONMENT=github-hosted`, `RUNNER_OS=macOS`, runner class
`github-hosted-macos-15-ARM64`, arm64 architecture, an Apple-M1-class CPU, `bun/1.3.14`, and `threadnote-4.6.0`. Release
mode rejects any sample or warmup count other than 100/5. Without `--fail-on-budget`, the artifact is classified as
`development-smoke` and receives an unconditional gate failure, so local evidence cannot be relabeled as release-scale
evidence. The fixed-class absolute gate remains an agent-latency objective; a parent-relative same-runner comparison
cannot replace it.

## Native code graph contract

`fixtures/code-graph-v1/` is the reviewed repository and query contract for native source navigation. It covers
definitions, authoritative calls and dependencies, paths, reverse impact, documentation, no-answer behavior, and
linked-worktree dirty-overlay isolation. The fixture identity is frozen; changing the repository or judgments requires
reviewing every baseline with the new hash.

`fixtures/code-graph-polyglot-v1/` is the complementary Java, Kotlin, Swift, and TypeScript contract. It executes the
bundled Java/Kotlin/Swift grammar packs and the unchanged compiler-backed TypeScript pack in one repository, including
declared Gradle JVM interoperability and SwiftPM target resolution. Its checked native quality and development
performance artifacts live under `baselines/code-graph-polyglot-v1/`.

```sh
bun run eval:code-graph
bun run eval:code-graph -- --fixture code-graph-polyglot-v1
bun run bench:code-graph -- --output artifacts/code-graph-local.json
bun run bench:code-graph -- --fixture code-graph-polyglot-v1 --fail-on-budget
bun run bench:code-graph -- --vectors --model-home ~/.threadnote --output artifacts/code-graph-vectors-local.json
bun run bench:code-graph -- --scale-symbols 10000 --fail-on-budget
bun run bench:code-graph -- --scale-symbols 100000 --fail-on-budget
bun run bench:code-graph -- --vectors --scale-symbols 10000 --model-home ~/.threadnote --fail-on-budget
bun run bench:code-graph:dirty-overlay -- --scale-symbols 10000 --samples 3 \
  --output artifacts/code-graph-dirty-overlay.json
bun run bench:code-graph:dirty-overlay -- --scenario unchanged-static-reexport \
  --scale-symbols 10000 --samples 3 \
  --output artifacts/code-graph-dirty-overlay-static-reexport.json
bun run bench:code-graph:dirty-overlay -- --scenario changed-export \
  --scale-symbols 300000 --samples 1 --governed --minimum-free-gib 120 \
  --ratchet apps/threadnote/test/evaluation/baselines/code-graph-v1/dirty-overlay-dependency-surface-ratchet.json \
  --output artifacts/code-graph-dirty-overlay-dependency-surface.json
bun run bench:worktree-readiness -- --candidate-ref v4.0.1 --samples 5 --warmups 1 \
  --output artifacts/code-graph-worktree-readiness-v4.0.1.json

# Opt-in/scheduled large-monorepo shape; expect substantial CPU, RAM, disk, and wall time.
bun run bench:code-graph -- --profile production-large --samples 1 --warmups 0 \
  --output artifacts/code-graph-production-large.json

# Opt-in/scheduled heavy-tail regression: pathological TS, 25 MiB low-signal JSON, 4,000 textless SVGs,
# interruption/resume, and deterministic workers=1 versus workers=4 graph output.
bun run bench:code-graph:heavy-tail -- \
  --output artifacts/code-graph-heavy-tail.json

# Fast harness smoke; exercises the same orchestration and assertions with a reduced generated fixture.
bun run bench:code-graph:heavy-tail -- --smoke \
  --output artifacts/code-graph-heavy-tail-smoke.json
```

`--ratchet <path>` applies a reviewed, versioned JSON ratchet to the completed artifact. It is independent of the
portable `--fail-on-budget` fixture gate and is therefore available to production-large and external-repository runs.
A ratchet binds exact primitive `environment` and `metadata` conditions plus `suite`, then names every independently
guarded measurement with its unit and one or more bounds. Environment conditions must include `fixtureHash`, `node`,
`runner`, and `runnerVersion`; metadata conditions must include `runnerClass`, `runtimePlatform`, and `vectorEnabled`.
Supported bounds are `maximum`, `minimum`, `meanMaximum`, `p50Maximum`,
`p95Maximum`, or `p99Maximum`. `samplesMinimum` can require distributional support. Missing or duplicate measurements,
unit drift, condition mismatches, unknown fields, and every exceeded bound fail closed. Ratchet updates require
reviewed repeated before/after evidence and rationale; do not widen a limit to make a regression pass. `--output` is
required with `--ratchet`; a provenance-valid artifact is written before a ratchet failure is reported so the
regression remains reviewable.

The pull-request production ratchet first applies those reviewed limits unchanged. That first candidate is the
screening observation. If only its static gate fails, CI keeps the artifact as evidence, measures the exact
protected-base commit in a detached worktree on the same runner, and then takes exactly one confirmatory candidate
observation. The paired gate binds all three artifacts in a strictly ordered, bounded candidate-control-candidate
sandwich; it does not retry until one passes. When the protected-base control and confirmation both pass an allowlisted
non-objective wall metric, they clear a screening-only wall spike. When screening and control pass, the confirmation
may cross one such static wall boundary in the entire sequence by at most the smaller of 1% and 5 ms. A second
confirmatory crossing fails. Two candidate misses still use the
existing strict sandwich path: it linearly interpolates the candidate observations at the control timestamp, which
cancels linear runner drift instead of favoring whichever source happened to run second. Candidate dispersion beyond
the existing relative/absolute headroom fails closed. Pairing is admitted only when the expected candidate and control
commits, `sameRunnerComparisonKey`, privacy-safe `runnerIdentity`, fixture/output/runtime/storage metadata, and the
assessed measurement set match. Non-wall CPU, work, storage, RSS, correctness, and product-execution shape failures
from either candidate stay blocking. The sole pre-product exception is the fixture/Git bootstrap process-count peak:
the screening observation may report the specifically reviewed five-process peak against the unchanged maximum of
four only when the protected-base control and immediate candidate confirmation both pass that static limit. A
fractional or larger overlap, a changed baseline, either later miss, and every product-phase process-count miss still
fail. Cumulative parser, serialization, transaction, and general
materialization-stage or subphase timers are work even though their unit is milliseconds, so they also stay static;
new timings require explicit elapsed-wall
classification before they can pair. The explicitly reviewed graph-cache persistence and SQLite commit splits may
pair because they are synchronous hosted-storage wall waits, while their independent CPU, row/work, and byte/storage
bounds remain static. An allowlisted wall limit becomes relative only when the protected-base control also misses that
same static limit; the existing relative/absolute headroom bounds the interpolated candidate estimate. Hard objectives
still bind the control and both candidate observations with no screening or confirmatory tolerance. This separates
hosted VM scheduling noise from branch regressions without widening the checked-in ratchet; the bounded confirmation
exception is a wall-only scheduler-tail allowance, not a relative performance claim against a passing control.

### Cross-repository workset contract

The workset fixture scales one deterministic set of repository archetypes into prefix worksets. Sizes 1, 8, 32, 64,
and 128 are the required correctness matrix: together they cover single-repository parity and progressively larger
published catalog generations without an eight-repository admission cap. Size 50 is benchmark-only. It exists to
measure the 50-ready-repository latency target and must not replace any required correctness size or be included when
claiming that the correctness matrix passed. The directory remains `code-graph-workset-v1` because it names the frozen
fixture and evaluator schema; the implementation and performance suite are Workset Search 2.0 / `code-graph-workset-v2`.

Ordinary CI runs the truthful bounded smoke against sizes 1 and 8. The scheduled/manual platform workflow runs the
complete correctness matrix, then measures sizes 32, 50, 64, and 128 with 25 recorded samples after five warmups. That
sample count supports a p95 distribution claim; a single observation remains `n=1` evidence even when an artifact
schema contains p50, p95, or p99 fields.

```sh
# Fast correctness smoke used by ordinary quality CI.
bun run eval:code-graph-workset -- --sizes 1,8

# Complete required correctness matrix.
bun run eval:code-graph-workset -- \
  --sizes 1,8,32,64,128 \
  --output artifacts/code-graph-workset-quality.json

# Full scheduled/manual performance distribution, including benchmark-only size 50.
bun run bench:code-graph-workset -- \
  --sizes 32,50,64,128 \
  --samples 25 \
  --warmups 5 \
  --output artifacts/code-graph-workset-benchmark.json

# Enforce the Workset Search 2.0 latency and response-budget targets.
bun run bench:code-graph-workset -- \
  --sizes 50,128 \
  --samples 25 \
  --warmups 5 \
  --fail-on-budget
```

Workset MCP responses are currently buffered: the client receives no partial card while repositories are still being
queried. Therefore `delivered-time-to-first-evidence-buffered` is the elapsed time until the first evidence is actually
available to the client, which is also completion time for the buffered response. An internal first-candidate timer
may help diagnose the pipeline, but it is not user-visible time to first evidence and must retain a distinct name.

Workset Search 2.0 first reads the complete indexed routing catalog, globally ranks candidates, then opens repository
graphs in bounded 4/4/16 waves. One four-repository validation wave may resolve ambiguous non-empty evidence; the
16-repository wave is reserved for zero-evidence exhaustion. The logical result sequence defaults to 40 evidence cards
with a separate internal maximum of 512. Its compact projection defaults to 1,250 estimated tokens and has a hard
1,500-token public ceiling. Continuations resolve an opaque persisted `cgwc_` sequence; repository-qualified `cgr_`
handles bind drill-down to the published generation and exact snapshot.

Agent-response cost counts the UTF-8 bytes of both MCP channels: structured content plus the duplicated terse text
rendering. It intentionally does not deduplicate equivalent facts across those channels because both are transmitted
to the agent. Estimated tokens use the conservative ceiling `ceil(total UTF-8 bytes / 3)`, not the recall evaluator's
older four-characters-per-token estimate. Artifacts retain each channel's bytes, their sum, and the estimate so future
response compaction remains comparable without claiming tokenizer-specific precision.

The clean native baseline records perfect coverage accuracy, repository recall@5, symbol recall, no-answer
precision/recall, and worktree isolation at every required size. Size 1 records full edge recall. Larger sizes record
0.25 edge recall because this frozen V1 evaluator still marks its `path` and `impact` cells unsupported and its package
expectation is not a query-card endpoint contract. The real
`apps/threadnote/test/integration/code-graph.workset-cross-repository-traversal.test.ts` lifecycle separately proves npm and Protobuf
extraction, generation-bound publication, V2 query evidence, forward path, and reverse impact through public runtime
surfaces. Do not describe the evaluator's unsupported cells as missing Phase 2 runtime support.

`performance-development.json` is a clean exact-commit, same-machine distribution with five samples after one warmup
at sizes 1, 8, 32, 50, 64, and 128. Its values are development evidence rather than portable latency promises; the
numeric targets remain versioned in `baselines/code-graph-workset-v1/budgets.json`. `catalogBytesRead: 0` currently
means catalog byte reads are not instrumented by this harness. It must not be interpreted as proof that the V2 query
did not use the routing catalog.

The checked 4.1.1 development artifact was captured from clean implementation commit
`8bfcc63c164f23456cb83fd1e090293ab020a18b` on the documented M1 Max runner. Because this bounded development run has
five samples, its p95 is the maximum observed sample; scheduled 25-sample runs remain the release-quality
distribution. All checked response estimates remain under the 1,500-token ceiling.

| Workset size | Buffered completion p95 | Estimated agent tokens |
| -----------: | ----------------------: | ---------------------: |
|            1 |              148.893 ms |                  1,306 |
|            8 |              445.221 ms |                    930 |
|           32 |              622.110 ms |                    931 |
|           50 |              758.645 ms |                    931 |
|           64 |              874.532 ms |                    931 |
|          128 |            1,423.727 ms |                    933 |

The evaluator runs Threadnote's real Git inventory, extractor, SQLite store, and query service. Its active Phase 0
safety gates require zero authoritative false edges, zero worktree leakage, and perfect no-answer precision/recall.
Repository, symbol, and edge recall plus MRR remain measured Phase 1 gaps rather than waived or falsely passing gates.
The checked Graphify 0.9.29 result remains a frozen historical comparison, not the native release floor.
`threadnote-native.json` is the native baseline; `performance-development.json` is the clean five-sample local
distribution; `budgets.json` records quality and
development and scale performance limits. The default development and scale artifacts are explicitly lexical-only.
`performance-vectors-development.json` separately records activation and a lexically disjoint semantic query with the
pinned production embedding model. Reviewed local lexical 10k/100k results and a production-model 10k vector result
are stored as `performance-10000-development.json`, `performance-100000-development.json`, and
`performance-vectors-10000-development.json`. Scheduled 10k/100k production-vector jobs gate bounded decoding, exact
scans, RSS, and disk. Code-graph embeddings use paged SQLite generations so candidate construction, reuse, and search
do not materialize a repository-sized sidecar. The platform workflow retains full artifacts rather than pretending
shared-runner latency is machine-independent.

The native GitHub-hosted Windows x64 query gate uses three fixed independent runner replicas with 100 post-warmup
samples each; Linux, macOS, and local Windows retain one 25-sample run. At least two Windows replicas must pass the
entire ordinary performance budget. Every replica retains exact work/parity, RSS, disk, 750 ms p50, and 500 ms hot CPU
guards while also passing the 1,900 ms hot-p95 fuse, two-times fuses over the resolved cold-index, one-file-index, and
whole-graph-analysis Windows wall ceilings, and the 400 ms whole-graph-analysis CPU companion. Nested cold and one-file
materialization use the corresponding enclosing safety ceiling, with `nested maximum <= enclosing maximum` enforced
as a fail-closed invariant, while every replica also remains below independent `3,000 ms` cold-materialization and
`200 ms` one-file-materialization process-CPU maxima; their tighter 8 s and 4 s ordinary wall ceilings remain required
on at least two replicas. The runner is the experimental unit: the gate never pools 300 queries and never adaptively
retries. The retained rationale, failed candidate-C nested-tail evidence, and artifact provenance are in
`baselines/code-graph-v1/windows-native-hosted-replica-calibration-v1.{json,md}`; a release candidate must pass one
prospective three-runner set.

The matching GitHub-hosted macOS ARM64 class retains the ordinary 125 ms hot-query median and admits at most 5%
hosted-runner hysteresis (131.25 ms) while its p95, process CPU, sample-count, work, RSS, disk, and correctness guards
remain unchanged. Local or mismatched runners receive no median tolerance. Six independent hosted observations and
the exact boundary derivation are retained in
`baselines/code-graph-v1/macos-native-hosted-median-calibration-v1.{json,md}`; a new exact candidate must pass
prospectively rather than relabeling the failed observation.

The reviewed `production-large` profile is shaped after the beta.27 field investigation: approximately 48,000
eligible files, 800,000 symbols, 2.7 million edges, 12 million lexical term rows, and 24 integrated and nested
workspaces. One reusable workflow runs weekly, through the explicit `include_production_large` input, and from a
separate bounded workflow for every `v4.0.0-beta.*`, `v4.0.0-rc.*`, and final `v4.0.0` tag on the pinned
`ubuntu-24.04` runner class. Publication never waits for this observation; the latest exact-commit checkpoint and upload
digest are retained for 90 days. Ordinary pull requests retain the bounded development, 10k-symbol, and 100k-symbol
suites. `--profile-files` and `--profile-symbols` may shrink the same generator for harness development, but only the
default shape is the reviewed profile. Completed release evidence must attain at least 90% of each
reviewed file, symbol, edge, and lexical-term target; merely carrying those measurement names cannot qualify an
undersized run. There is intentionally no portable latency budget or fabricated checked result for this profile:
retain the JSON artifact from each measured run and review it only when `sameRunnerComparisonKey` matches. The cold and
incremental builds and their phases are explicitly labelled n=1; the artifact never presents them as a latency
distribution.

`beta30-staging-development.json` preserves the reviewed same-runner staging experiments, including the first 10k
direct-persistent observation and its source-artifact SHA-256. Every source run was dirty and local, so this compact
record is development evidence only. A release artifact is accepted only when it carries a canonical Threadnote
4-or-newer release tag, the exact matching commit, and a clean checkout; missing provenance is a hard failure rather
than an implicit pass.
The compact direct record retains the reviewed top-level cold and one-file wall-time measurements under their exact raw
artifact phase names. The split snapshot phases are:

- `cold-snapshot-write-and-checkpoint`: 556.407 ms
- `cold-snapshot-promotion`: 62.470 ms
- `one-file-reindex-snapshot-write-and-checkpoint`: 131.654 ms
- `one-file-reindex-snapshot-promotion`: 156.894 ms

Snapshot write-and-checkpoint ends at promotion start; promotion is a separate phase. The record also retains the exact
privacy-safe structural and query digests, zero observed TEMP database pages, zero cold activation-copy stages, query
parity across all three builds, and structural parity between the incremental overlay and its independent full rebuild.
Its cold graph intentionally differs because the parity build includes the benchmark's one-file mutation.

`heavy-tail-profile.json` is the complementary beta.29 parser/cache regression shape. It checks the file classes that a uniform
symbol-count generator cannot represent: call-heavy and multi-megabyte generated TypeScript, one 25 MiB test snapshot
JSON, and 4,000 textless SVG assets. The v3 harness builds clean graphs with one, four, six, and eight parser workers,
interrupts another build only after parser facts are durable, then resumes it from the same home. Every completed
graph must have the same normalized digest. The resumed run must reuse the interrupted cache; low-signal JSON and
textless SVG files must remain excluded; TypeScript imports, exports, and tail declarations must survive. Each run
retains parent-observed parser-request active wall time, summed request time, average/peak concurrency, per-language
parse/request/fact-byte totals, RSS, and cache bytes. Governed v3 artifacts additionally bind exact clean source/runtime
provenance, internal solid-state storage and filesystem, at least 120 GiB free, and explicit non-fallback
`THREADNOTE_BENCHMARK_RUNNER_CLASS=apple-m1-max-64g-internal` and
`THREADNOTE_BENCHMARK_RUNNER_ID=local-apple-m1-max` capture bindings. The checked
`heavy-tail-scheduler-ratchet.json` is generated from exactly three same-commit governed artifacts and independently
binds all 254 scheduler, resource, language, resume, cache, and graph metrics. Every release capture and the generator
must load that checked ratchet; all three source runs must pass it and no generated numeric bound may be weaker.
Hosted GitHub Actions heavy-tail artifacts are explicitly `correctness-only` and are never performance evidence; final
release performance evidence must be freshly replayable from those three governed runs on the matching local release
runner and exact frozen candidate. Generator admission independently receives the expected runner class and identity
plus a not-before time, observation time, maximum evidence age, maximum three-run span, and bounded future skew. Those
freshness values are retained in output metadata. The strict release parser cross-binds outer timestamps, source and
runner identity, runtime, storage, profile, assertions, managed exact-HEAD provenance, evidence class, and threshold
policy to the embedded benchmark artifact. `heavy-tail-scheduler-development.json`
retains the controlled scheduler comparison and the exact APFS/internal-SSD baseline used to generate that ratchet.
Nonzero millisecond metrics use the larger of 15% relative headroom and 5 ms absolute scheduler-noise headroom; exact
zero timers remain exact-zero gates. Counts, graph shape, cache reuse, and source-byte metrics retain their stricter
independent bounds.
The automatic four-worker choice wins on wall time for this reviewed fixture; six and eight workers raise CPU, RSS,
and summed request time without a wall-time gain. This is reduced-fixture extraction-scheduler evidence, not the final
pinned-IntelliJ cold-build or one-file release gate. The checked profile is a reviewed workload contract, not a
fabricated portable latency result. Compare latency and utilization only within the same artifact and runner class.
`heavy-tail-development.json` retains the first reviewed full-shape observation on the documented local hardware. It
is evidence that the harness and contracts passed, not an absolute release threshold for other machines or evidence
that production-scale materialization was exercised.

`bench:code-graph:dirty-overlay` first prepares an unmeasured clean base, then alternates a measured safe staging-reuse
path with an explicitly disabled full-materialization control. It requires identical graph shape and records total,
CPU, materialization, proportional-work, and physical-replay evidence. `--governed` requires a clean exact-HEAD managed
runtime, retained output, at least 120 GiB free by default, solid-state temporary storage, and the internal device on
macOS; source/runtime provenance is revalidated after the run. `--ratchet <path>` applies independent reviewed bounds
to the standard `ratchetArtifact` embedded in the output. The checked dependency-surface ratchet binds every emitted
measurement to the reviewed 300k-symbol/3,006-file Apple M1 Max runner class. The reviewed local 10k-symbol result is stored as
`dirty-overlay-development.json`; it predates the governed format and remains comparative evidence, not a portable
latency gate.

The opt-in `unchanged-static-reexport` scenario shifts only the evidence span above a byte-identical named TypeScript
re-export. It retains staged/total files plus exact integer rewrite and cached-fact replay amplification for both the
incremental path and forced-full control; those structural observations are not wall-clock assertions. The generated
10k-symbol fixture contains 102 indexed files, so this is not evidence for a 10k-file repository or production-large.
The existing body-only scenario and checked baseline remain unchanged.

The opt-in `changed-export` scenario adds one published symbol in a two-project workspace dependency surface. Its
background generator uses 100 declarations per source file, so `--scale-symbols 300000` produces about 3,000 indexed
background files. The harness requires the incremental run to use the bounded two-project closure, stage exactly four
files, and report four attribution, base-fact, changed-file, and inventory-file units instead of silently falling back
to repository-wide work. `dirty-overlay-dependency-surface-development.json` retains the first governed observation;
it is exact local runner evidence, while `dirty-overlay-dependency-surface-ratchet.json` is the reviewed regression gate.

`bench:worktree-readiness` compares an exact candidate ref with its immediate parent on one machine and one pinned
public checkout. Each runtime gets an independent frozen dependency installation, Threadnote home, and fixture clone.
After both runtimes build the same warm anchor, the harness alternates linked-worktree runs for graph-equivalent commits
and committed one-file edits. It records raw wall times, requires the predecessor to use full materialization, requires
v4.0.1 to use `reused-snapshot` or `incremental-clean` with zero or one staged file respectively, and checks graph-count
and controlled-query parity after every pair. Cold anchor construction, dependency installation, and optional vector
enrichment are outside the timing scope. Treat its median speedup as same-machine engineering evidence, not a portable
latency promise.

The general `bench:code-graph` suite separately labels its post-cold one-file edit as `one-file-reindex`. That path
measures the normal cross-session cache reuse and records the observed materialization mode, staged-file count, and
fallback reason. An eligible edit now reuses the persisted clean base through a versioned receipt containing normalized
symbol, alias, and named-re-export provenance, and writes a direct changed-file delta without hydrating the clean graph
into temporary staging tables. Eligibility requires compatible extractor, workspace, and file-set fingerprints; a
complete fact cache and receipt; an unchanged declaration/lookup surface; and no changed dynamic aliases. File-set,
workspace, resolution-surface, cache, receipt, or staging-identity changes conservatively fall back to full
materialization and remain explicit in the recorded reason.

The reusable receipt and named-barrel resolution contract ships as extractor generation `native-code-graph-9`.
Upgrading from generation 8 therefore performs one intentional clean rebuild before persisted-base deltas become
eligible. SQLite records a monotonic minimum extractor generation so an older process that overlaps an update cannot
publish a generation-8 snapshot after generation 9 has initialized the checkout store.

The bounded parser-worker pool, generated-root correction, and metadata-only low-signal structured-data policy advance
the current extractor generation to `native-code-graph-10`. That transition performs one clean rebuild and extends the
same monotonic publication guard to overlapping generation-9 processes.

Code-graph benchmark artifacts now separate registration/lock/database setup, committed inventory/extraction, the dirty
overlay and workspace-discovery gap, materialization, reference resolution, validation, SQLite write/checkpoint,
promotion, and vector work using first progress transitions and explicit subphase completion events. They also record
operation CPU deltas; boundary and cumulative peak RSS; final main SQLite, WAL, SHM, vector, sidecar, and unclassified
derived bytes; observed SQLite/WAL/SHM peaks sampled at progress boundaries; lexical/vector row counts;
repository-status latency; and cross-process build sidecar latency. Every measurement includes `samples`. With one cold
or incremental run, `p50`, `p95`, and `p99` are schema-compatible copies of that one observation, not percentile
estimates; cite it as “one observation (n=1),” never as p95. Distribution labels are valid only for measurements with
multiple samples.

The pull-request production ratchet is deliberately reduced and path-scoped. It runs one lexical observation with
3,000 generated source files, 110,000 target symbols, four parser workers, and a 20 GiB free-space floor only when
graph-affecting sources or the ratchet contract change. Its checked baseline comes from three same-commit matrix jobs,
each on a fresh GitHub-hosted Linux runner; the reviewed hosted-runner class, not unstable guest block-device or runner
name hints, binds the gate. The full pinned IntelliJ fixture remains manual release/website evidence only: it is not a
CI fixture, developer gate, ratchet input, or ratchet-generator target.

Each non-deterministic limit starts from the maximum of the three seed jobs with 25% relative headroom; aggregate and
objective millisecond metrics also receive 100 ms absolute hosted-VM scheduling headroom. That absolute allowance is
material only below 400 ms, so micro-timing jitter cannot block development while the 25% ceiling still governs the
end-to-end cold and incremental timings. Single-observation detailed `-n1` timers receive 75% relative headroom after
same-behavior hosted runs showed that internal transaction and heartbeat splits can vary by more than 25% even when
their end-to-end phases remain stable; those detailed timers also receive 300 ms absolute headroom, while explicit
objectives and aggregate phase timings retain their tighter caps. Full-build cold and same-overlay registration setup
receive 3x ceilings because retained same-behavior hosted observations showed larger database-setup variance, while
their end-to-end limits remain tight. Deterministic graph shape, proportional-work,
parity, and zero failure counters remain exact. Sampler attempt/sample counts are lower-bounded because longer runs
legitimately produce more samples. Zero and sub-MiB byte observations receive a 1 MiB materiality floor; larger disk and
memory values retain 25% headroom. Phase-boundary RSS snapshots and external-sampler scheduling gaps stay in every
artifact as diagnostics but are not gates; complete-operation external process-tree RSS peaks remain ratcheted.
Filesystem-available byte observations are diagnostic rather than upper bounds: the governed preflight and ratchet
metadata enforce the 20 GiB minimum, while additional free space can never fail the gate.

Cold, one-file, and independent-rebuild inventory evidence also retains cumulative source-reading wall time, summed
parser-extraction time, parser-fact serialization wall time, and cache-persistence wall time. Summed parser time can
exceed inventory wall time when workers overlap; it is not a phase-duration substitute. Production-large and
external-repository evidence require all four subphase measurements so a total inventory win cannot hide a reading,
extraction, serialization, or persistence regression.

Full materialization evidence retains the existing inclusive `attributing` stage for continuity and separately records
mutually non-overlapping attribution-compute, final-fact-serialization, materialized-shard-persistence, and
shard-association timers, plus adjacent fact-batch preparation. Cold and independent-rebuild evidence require
every subphase independently. The attribution components are not added to the inclusive stage when interpreting total
wall time; fact-batch preparation spans the transition into row preparation. One-file incremental staging remains
governed by its own end-to-end materialization measurement because it does not execute these full-build substages.

The bounded development, polyglot, 10k, and 100k budget contracts gate cold and one-file materialization independently
from total indexing. Production-large and external-soak artifacts additionally retain privacy-safe aggregate file,
symbol, edge, lexical-term, staged-file, phase CPU, and phase boundary-RSS measurements. Completed activation-stage
duration and row counts cover validation, graph-table copying, commit, checkpoint, and completion for both cold and
one-file builds. SQLite TEMP allocated-page high-water is separate from the external sampler. The external value
unions linked files in the isolated temporary root with open regular scratch files held by the recursive benchmark
process tree and deduplicates them by device and inode. That includes immediately unlinked SQLite `etilqs_*`
databases, journals, and subjournals without retaining their paths. Linux reads `/proc` file descriptors; macOS uses a
bounded numeric-FD `lsof` projection at the process-sampling interval. Both values are sampled high-water, not exact
live totals. For a
production repository that is already cloned locally, run the explicit soak mode without adding a network clone to CI.

For the narrower ready-query gate, `bench:code-graph:ready-query` consumes the pinned IntelliJ checkout and an already
prepared compatible Threadnote home. It never calls the indexer: status uses `requestMaintenance: false`, inspection
uses `refresh: false`, and missing, stale, dirty, incompatible, or under-200,000-file evidence fails closed. The reviewed
workflow is manual-only, requires the `threadnote-large-graph` self-hosted Linux runner label and protected environment,
and reads the preprovisioned paths from environment-scoped repository variables. It does not run on public GitHub
hardware, clone IntelliJ, or alter the existing 73k full-build workflow. The artifact enforces at least eight logical
CPUs, and the workflow has a 30-minute job ceiling. The protected runner environment remains responsible for
provisioning at least 32 GiB RAM, a 128 GiB local SSD, and 64 GiB free space; those capacity facts are not yet captured
as qualifying artifact evidence.

Qualifying evidence is restricted to the canonical `threadnote/threadnote` workflow dispatched from protected `main`.
Provision and protect the `large-repository-evidence` environment first, including its protected deployment policy,
self-hosted runner, prebuilt home/repository paths, and environment-only variable
`THREADNOTE_READY_QUERY_ENVIRONMENT_ATTESTATION=intellij-ready-query-v1:3cbdad9ee6c8a5135fc0f01cc90114fc25c0655c:047481e05148b1c11a52fa813e13323c23abbc0d`.
Do not define that attestation or the preprovisioned paths at repository or organization scope. Only after that
environment is ready may a repository administrator set the repository variable
`THREADNOTE_READY_QUERY_EVIDENCE_ENABLED=true`. The live environment and enable variable are currently absent, so the
job remains skipped. Environment-scoped values are injected only into steps after environment admission; the job-level
guard can see only the repository enable variable. The runner rejects missing or mismatched repository name/ID, event,
job, ref, protected-ref, workflow ref/SHA, run ID/attempt, enablement, environment, attestation, and self-hosted runner
class inputs. The retained artifact binds the exact closed set of those non-secret values to the measured source
commit without retaining a runner name or path. Third-party actions in this workflow are pinned to reviewed commit
SHAs, and output/artifact names include both run ID and attempt.

```sh
THREADNOTE_READY_QUERY_DEDICATED_RUNNER=true \
bun run bench:code-graph:ready-query -- \
  --repository /preprovisioned/intellij-community \
  --home /preprovisioned/threadnote-ready-home \
  --output /outside/both/ready-query-preflight.json \
  --preflight
```

Local managed exact-HEAD runs may emit only this distinct `ready-query-preflight` readiness receipt, never a qualifying
benchmark artifact. The real canonical GitHub run
repeats preflight, executes five warmups and 25 samples per measured freshness policy, schedules deferred requests at a
fixed 1 Hz with concurrency one, and includes accumulated queue latency in end-to-end values. It sequentially checks
the reviewed Java, Kotlin, Bazel, and TypeScript controls, requires exact/current and ordinary/deferred digest parity,
reconciles the available stage timings with an explicit unattributed remainder, caps both MCP-shaped response parts at
24 KiB, and rejects Linux CPU/I/O/memory pressure, steal, run-queue, or swap contention. The request profile is closed
and explicit: `query`, node limit 20, edge limit 40, depth 1, heuristic/model associations disabled, 5 s deferred and
30 s exact outer timeout envelopes, and the recorded runtime-default lexical-first semantic/traversal budgets.

The measured window holds the graph maintenance registration, publishes maintenance intent, acquires the checkout
repository lock, and drains linked-worktree build locks before its inside-scope status check. It retains those builder
gates through warmups, controls, samples, final status/source validation, artifact validation, and atomic artifact
write. This excludes graph builders only. It intentionally does not hold the database-writer lock because normal query
snapshot leases use that lock, and the artifact explicitly records that full writer isolation and storage-capacity
isolation are not attested. A unique per-run prepared home or a future writer-reservation protocol remains required for
those stronger claims.

This artifact is explicitly `composed-status-inspect-serialization` service latency. It bypasses the registered
MCP/watcher/snapshot-orchestration handler and does not yet retain process CPU time/utilization, RSS, physical/logical
I/O, SQLite/WAL/TEMP, cache-state, or candidate/hydration/traversal stages. A retained run therefore qualifies only
this evidence foundation; the complete P0.2 release gate remains pending.

For the full cold/incremental/reference soak, run:

```sh
bun run bench:code-graph -- \
  --repository /path/to/clean/public-github-checkout \
  --incremental-path path/to/TrackedSource.java \
  --control '{"query":"PublicJavaSymbol","expectedPath":"path/to/TrackedSource.java","expectedLanguage":"java"}' \
  --control '{"query":"PublicKotlinSymbol","expectedPath":"path/to/TrackedSource.kt","expectedLanguage":"kotlin"}' \
  --control '{"query":"PublicTypeScriptSymbol","expectedPath":"path/to/tracked-source.ts","expectedLanguage":"typescript"}' \
  --control '{"query":"PublicBazelSymbol","expectedPath":"path/to/rule.bzl","expectedLanguage":"bazel-build"}' \
  --home /large-volume/threadnote-primary \
  --reference-home /large-volume/threadnote-reference \
  --retain-homes \
  --samples 25 --warmups 5 \
  --output /path/outside/checkout/code-graph-external.json
```

The soak currently supports Linux and macOS, where both recursive process and SQLite temporary-file telemetry are
audited; other platforms are rejected before indexing. The checkout must be clean and remain at the recorded exact
commit. Git cleanliness checks explicitly include all untracked files, disable repository-configured filesystem
monitor and untracked-cache shortcuts, include submodule dirt, and run again immediately before publication. The
Threadnote source checkout is independently required to remain clean at its exact commit. The selected file must be
tracked and regular, and the artifact and both benchmark homes must be outside the checkout.

Explicit home paths are reserved with an exclusive directory creation rather than an existence-check race.
`--retain-homes` requires two explicit fresh paths and arms retention only after the real run's preflight succeeds;
otherwise scoped cleanup releases both reservations. Before an expensive run, repeat the command with `--preflight
--minimum-free-gib 140`. A validation-only run always releases the requested paths—even when `--retain-homes` is
present—so those same fresh paths remain available for the real run. Preflight validates the commit, tree, controls,
semantic-overlay language, effective parser-worker capacity, privacy-safe allowlisted environment metadata, and free
space without indexing. Path-valued environment metadata is recorded only as a redacted configured marker. The real
run repeats the same validation and enforces the capacity threshold even when the operator omits `--preflight`; 120
GiB is the default minimum and 140 GiB is recommended for the public soak. The validation-only command writes a
separate `<output>.preflight.json` rather than impersonating benchmark evidence.

The incremental edit is a harmless language-aware import/dependency, not a comment-only byte change or a new
declaration. It changes graph evidence while preserving the symbol lookup surface, and release evidence requires the
observed mode to be `incremental-overlay`; a conservative full fallback does not count as an incremental benchmark.
The overlay source must be valid UTF-8. The harness compares bytes before applying and restoring it, restores the
exact original bytes (including BOM and line endings), and leaves a newer concurrent edit untouched rather than
overwriting it. Normal success and cooperative failure therefore restore safely. A process `SIGKILL`, power loss, or
machine crash can still leave the benchmark overlay in place, so run destructive-scale evidence in a disposable clean
clone and verify Git status after interruption.

The run must prove that the overlay changes the cold effective-state digest and that its incremental state exactly
matches an independent fresh-home full rebuild. The digest covers effective inventory files, symbols, lexical terms,
lookup keys, edges, workspace attribution, re-export provenance, and structural-analysis aggregates—not only symbol
and edge counts. Cold, incremental, and reference builds each have their own non-overlapping progress timeline,
SQLite temporary root, required external sampler, and crash checkpoint. The artifact also times `query`, `node`,
`neighbors`, `explain`, `impact`, and `path` through the MCP compaction path, enforcing the 25-second tool envelope and
24 KiB limits for both structured and text parts. Only latency, row counts, truncation state, and byte counts are
retained—never graph content. All gates and final source/checkout checks run before the canonical artifact is written.

The artifact omits local repository paths, credentials, and source content. It retains the canonical public GitHub
repository name and HTTPS URL plus the reviewed public control queries, repository-relative paths, expected languages,
and stable node IDs. These fields make the public result reproducible while aggregate counts prove that every cold,
post-incremental, and reference control returned at least one node from its expected tracked path and language. Compare
it only with the same external commit and runner class.

Release-bound external evidence additionally measures cold/warm Manager catalog and overview operations, project and
node detail, bounded Manager query latency and payload, and a deterministic client render proxy. Exact snapshot binding,
stale/aborted request rejection, node/edge budgets, logical CPU count, filesystem, disk-medium category, and eligible and
excluded inventory counts are mandatory binder metadata. Concurrent-worktree evidence reuses the measured primary
Threadnote home: a bounded synthetic Git repository and one real linked worktree receive distinct dirty sentinels, are
indexed concurrently, and are queried concurrently with positive and cross-negative controls to prove repository
identity sharing without worktree leakage. The control reports its own duration and two indexed files; it does not
repeat the public repository cold build.

The production-large workflow first pins all benchmark temporary homes to the runner-temp filesystem and writes an
exact-source capacity-classification artifact. The unchanged governed 120 GiB floor is checked before fixture
construction. A runner below that floor retains `not-admitted-insufficient-capacity` for the full shape and, if it has
at least 20 GiB free, must measure the already governed 3,000-file / 110,000-symbol production-shaped profile. The
fallback artifact records its reduced counts and cannot stand in for the 73,000-file target. The independent evidence
workflow passes only when its selected profile completes; a runner below both floors or a failed fallback leaves it
red without blocking release publication. An admitted full-shape run additionally starts a 25 ms external sampler
before it constructs the fixture, then
uses distinct, non-overlapping bootstrap, cold-index, incremental-index, and same-overlay reference samplers. A prior
sampler is stopped before the next measured sampler starts, so CPU, RSS, I/O, and temporary-file totals cannot leak
between measurements. Each sampler must publish a parseable readiness marker before the parent enters the measured
phase. Index wall-time and process boundaries begin immediately before `indexer.index()` only after sampler readiness
and overlay application, then end immediately after that call and before overlay restoration or post-index work. It
records per-phase process CPU/RSS and
DB/WAL/SHM peaks plus deduplicated linked-and-open SQLite temporary-file peaks, including
`activating/writing-and-checkpointing`. This is observed sampling, not an assertion that an interval cannot miss a
shorter transient. Linux validates the sampled parent using `/proc` start time so PID reuse cannot be mistaken for the
original benchmark. macOS samples process trees every 250 ms and open numeric file descriptors every second to bound
`ps`/`lsof` overhead. Open-file inspection is capped at 4,096 processes and 65,536 descriptors, and the macOS projection
at 8 MiB. The artifact records aggregate scheduled attempts, successful samples, and failures; a cap or transient
inspection loss after startup therefore fails production/external release evidence instead of silently retaining a
partial high-water. The sampled-high-water caveat still applies between successful observations. The sampler excludes its own
observer subtree from process and open-file totals. Production/external release evidence is accepted only on Linux or
macOS; unsupported platforms fail the preflight instead of emitting partial or fabricated measurements.

Each sampler atomically checkpoints its evidence into the workflow's artifact directory once per second and on parent
exit. A separate run-lifecycle checkpoint records the current benchmark phase and ends as `complete` or `failed` when
the process can finalize normally. If the process is killed, the last `running` phase and the sampler's
`parent-exited` checkpoint remain. Sampler shutdown is bounded and escalates to process termination if the stop signal
cannot be written or honored. The production job has a hard 30-minute ceiling: capture is limited to 20 minutes and
artifact upload to 5 minutes, leaving the rest for checkout, setup, and summary. Upload runs with `if: always()`, so the
latest failure or timeout checkpoint is retained whenever the runner itself remains alive.

Graph code search is intentionally separate from memory recall. `recall_context` evaluates durable memories and
resources; `inspect_code_graph` evaluates current source evidence. Agents may call both, but one subsystem failing or
returning no answer cannot silently change the other's answer contract.

## Fixture contract

`createRecallEvaluationFixtureV2()` in `apps/threadnote/src/evaluation/recall-fixture.ts` creates the reviewed base corpus:

- 200 canonical-shaped documents and 250 queries;
- relevance grades from 0 through 3;
- explicit no-answer queries, forbidden URIs, authority pairs, expected stages, and required explanation codes;
- reviewed provenance and language on every document and query;
- every required category represented; the frozen v2 multilingual rotation currently yields Spanish only, so Polish
  and Ukrainian coverage requires a versioned replacement fixture rather than a silent baseline mutation;
- no semantic scores embedded in the fixture.

`expandRecallEvaluationFixtureV2()` deterministically grows the same corpus to 1,000, 10,000, or 100,000 documents.
The seed and generated-document count are part of the fixture identity. Generated records are marked `reviewed:
false`; they must never be added to relevance judgments.

Fixture identity normalizes the 4.0 `threadnote://` namespace rename back to the frozen 3.0.3 representation before
hashing. This keeps stored baselines and measured model candidates comparable when only the URI scheme changed; corpus,
query, or judgment changes still produce a different hash.

## Training boundary

The recall-v2 fixture, its expansions, and all checked baselines are evaluation-only. They are intentionally imbalanced
and do not constitute model-training data. The development-only harness under `training/recall-reranker/` uses a
separate versioned query-group contract, records immutable source/license/privacy provenance, partitions before rows,
and rejects exact overlap with this fixture. Its checked smoke generator is only a wiring test; it cannot support model
quality or release claims.

Candidate GGUF files are evaluated through this same frozen contract by passing `--reranker-manifest` and
`--reranker-path` to `bun run eval:recall:models`. The evaluator verifies the local file's size and SHA-256, parses the
normal production model manifest, invokes `LocalModelRuntime.rerank`, and applies the existing non-inferiority gate.

To add a scenario, add one hand-reviewed entry to `SCENARIOS`. Each entry creates eight documents and ten query
contracts. If a new behavior does not fit that shape, add an explicit document/query builder and preserve the minimum
counts. Validate that:

1. the desired document has a relevance grade;
2. unsafe or out-of-scope results are in `forbiddenUris`;
3. `expectedStages` describes the pipeline behavior being tested;
4. required reason codes are stable domain contracts, not model prose;
5. provenance is synthetic or public project material, never copied memory/customer data.

The Threadnote 3.0.3 baselines are frozen historical artifacts and must never be overwritten. An intentional fixture or
ranker change requires capturing a new reviewed current baseline from a clean commit and reviewing every metric delta:

```sh
git status --short
bun run eval:recall:baseline:v2
```

The v2 capture refuses a dirty checkout and defaults to
`baselines/threadnote-<package-version>-<ranker-version>/recall-v2-lexical.json`. It derives the package version,
ranker version, pipeline name, commit, clean state, and commit timestamp from the checkout. `SOURCE_DATE_EPOCH`,
`--created-at`, or `--output` may override the reproducible timestamp or destination, but must not be used to relabel
historical behavior. The legacy v1 capture remains only for its frozen contract.

## Metrics

All metrics are emitted globally and per category.

| Metric                             | Definition                                                                                         | Direction                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- |
| Recall@k                           | Fraction of all relevant URIs present in the first k results, averaged over answerable queries     | Higher                           |
| MRR                                | Reciprocal rank of the first relevant result, averaged over answerable queries                     | Higher                           |
| nDCG@k                             | Graded discounted gain divided by the ideal ranking at k                                           | Higher                           |
| No-answer precision/recall/F1      | Classification metrics for expected and predicted no-answer outcomes                               | Higher                           |
| Forbidden-hit rate                 | Forbidden hits divided by all returned hits                                                        | Lower; no regression             |
| Stale-hit rate                     | Archived or superseded hits divided by all returned hits                                           | Lower; no regression             |
| Authority-inversion rate           | Inferior documents ranked above or instead of preferred authority pairs                            | Lower; no regression             |
| Explanation coverage               | Queries whose first result contains every required reason code                                     | Higher                           |
| Average candidates read            | Candidate records inspected per query                                                              | Informational/performance budget |
| Average context characters/tokens  | Returned context size; tokens use an explicit four-character estimate until a model tokenizer runs | Informational                    |
| Expansion invocation/fallback rate | Fraction invoking expansion and fraction of those invocations that fail open                       | Informational/lower fallback     |

Semantic uplift is the metric delta from a lexical run to a semantic run. Reranker uplift is the delta from hybrid to
reranked output. Use `compareRecallEvaluationResults` so both are reported globally and per category.

The default non-inferiority policy allows at most a 0.01 aggregate and 0.05 per-category drop for higher-is-better
quality metrics. Forbidden, stale, authority-inversion, and expansion-fallback rates may not increase. Contract
failure count may not increase. Tight platform latency gates are not applied on shared CI runners.

## Running quality gates

```sh
# Existing v1 quality and 10k production-shaped checks
bun run eval:recall

# v2 current-pipeline non-inferiority check
bun run eval:recall:v2 -- \
  --fail-on-contract \
  --fail-on-regression

# Keep the full query run as an untracked CI artifact
bun run eval:recall:v2 -- --no-baseline --documents 10000 --full --output artifacts/recall-v2-10k.json

# Diagnose omitted-project global retrieval separately from the explicit-project contract
bun run eval:recall:v2 -- --no-baseline --global-eligibility --full
```

The evaluator and model bake-off default to the reviewed Threadnote 4.2.7 `hybrid-v8` lexical baseline under
`baselines/threadnote-4.2.7-hybrid-v8/`. Its 99 exact lexical-only contract failure identities remain visible work, not
silent waivers: with a baseline, `--fail-on-contract` allows fixes but rejects any new identity or count increase; with
`--no-baseline`, it remains zero-tolerance. The remaining defects are concentrated in contracts that require semantic
retrieval; the production BGE model evaluation remains the complementary end-to-end semantic-quality check. A
candidate must also pass the independent non-inferiority gate for global, category, and safety metrics. Pass
`--baseline` explicitly only to reproduce a historical comparison. The earlier 4.2.7 `hybrid-v3` quality artifact is
retained in its original directory as historical evidence and as the colocated performance-reference lineage.

The `hybrid-v8` release behavior also covers production recency intent: original-query recency terms can admit a
bounded newest-candidate lane before the normal topical ranker, so a relevant current handoff is not starved by a large
set of older matches. A separate real SQLite-store regression pins that behavior. It does not change the 250-query
lexical fixture aggregates because the fixture remains the stable non-inferiority contract rather than a synthetic
recency-only scorecard.

The reviewed fixture's `query.project` models the documented explicit-project agent workflow. The
`--global-eligibility` diagnostic keeps that value only as a soft ranking context while omitting the hard project
boundary, matching a recall call without `project`; it intentionally runs without the explicit-project baseline so
the two retrieval modes are not conflated.

## Performance suites

`bench:recall:micro` uses Mitata against a minified built artifact, outside Vitest's module runner. Its compact JSON
mode omits raw sample arrays:

```sh
bun run bench:recall:micro
bun run bench:recall:micro -- --json
THREADNOTE_BENCHMARK_100K=1 bun run bench:recall:micro -- --json
```

`bench:recall` is the explicit end-to-end orchestrator. It records p50/p95/p99 rank latency, throughput, RSS, heap,
and external memory together with commit/dirty state, fixture hash, Bun runtime, OS, architecture, CPU, RAM, warmups,
and samples. Use `--require-clean` for checked-in evidence; exploratory dirty runs remain available and identify
themselves as dirty:

```sh
bun run bench:recall -- --documents 10000 --samples 25 --warmups 5 --require-clean \
  --output .artifacts/recall-10k.json
```

`bench:recall:monorepo-shares` is a separate deterministic stress diagnostic for package-local and cross-package work
in a monorepo where each logical memory has a personal copy and several team-share aliases. It does not mutate the
frozen recall-v2 fixture or any checked baseline. It evaluates two ground-truth scenarios: one where the correct
memory belongs to the current package, and one where the only correct memory belongs to a sibling package while the
current package contains topical decoys. Each scenario reports three deliberately distinct modes:

- `full-corpus` is the quality oracle that ranks every physical candidate and its aliases.
- `workspace-prefiltered` is the hierarchy-only control. It protects current, ancestor, and repo-wide memories but,
  by definition, excludes sibling memories; sibling recall is therefore expected to be zero here.
- `cross-scope-challenger` uses the production lane budgets, outside-hierarchy prioritizer, and bounded lane merger.
  Its adversarial topical source order fills the normal head with current-package candidates before admitting a small
  sibling challenger set.

The output keeps general relevant recall@k and sibling-only cross-scope recall@k separate. It also reports the
relevant memory's adversarial topical index, the production admission limit, source physical/logical shape, admitted
candidate representation, alias compression, result duplication, and rank-latency distributions:

```sh
# Bounded default per scenario: 64 packages × 128 logical memories × (1 personal + 3 shared copies).
# The 128 current-package memories exceed the default 100-candidate admission head.
bun run bench:recall:monorepo-shares -- --output .artifacts/recall-monorepo-shares.json

# Fast harness smoke while iterating.
bun run bench:recall:monorepo-shares -- \
  --packages 8 --logical-per-package 120 --share-aliases 2 --target-package 0 --sibling-package 7 \
  --samples 2 --warmups 1
```

This in-memory diagnostic functionally exercises candidate admission, ranking, and alias deduplication. Its adversarial
source order models a crowded bounded topical window; it does not reproduce SQLite BM25 ordering, index-build cost,
query I/O, or filesystem scanning. Candidate sets are prepared before sampling, so the measurements are rank-only
latency for each admitted shape, not admission or end-to-end retrieval latency. The full-corpus result is an oracle,
not the production retrieval path. Compare latency only for matching fixture hashes and runner classes. The runner
rotates the complete six-pass scenario/mode matrix on every sample to distribute fixed-order bias and records
observations without universal pass/fail latency thresholds.

The current Apple M1 Max/64 GiB `hybrid-v3` reference covers 200, 1k, 10k, and 100k documents under
`baselines/threadnote-4.2.7/benchmarks/darwin-arm64-m1-max/`. Every artifact has clean commit provenance and derives
`sourceVersion` from the package. The 3.0.3 and 4.0 performance files remain immutable historical observations. Compare
candidate latency only on like hardware/runtime and matching fixture hashes; do not turn one host's timings into
universal CI thresholds.

`bench:recall:cross-scope-sqlite` measures the production lexical loader rather than the prepared in-memory rank
sets. It builds and indexes a temporary canonical memory corpus once, then samples the post-index production-shaped
path after the configured warmups:
one `loadRecallIndexDataBatch` containing topical and protected-workspace selections, their in-process lane
prioritization and bounded admission, and any conditional sibling `loadRecallIndexData` fallback. The fixture covers
a selective sibling term, a common balanced term, a sibling target buried beyond the global prefix, and a common-term
project with no sibling-scoped documents. Every scenario runs both a global-only profile and the normal soft
preferred-plus-global profile, with these comparison modes:

- `no-challenger-reference` runs the ordinary topical and protected-workspace selections without a cross-scope
  reserve.
- `evidence-gated` matches production: it reuses ordinary cross-scope candidates, skips the dedicated query only
  when the broad topical result proves exhaustive, and otherwise runs one project-bound sibling selection.
- `always-query-reference` runs that one sibling selection even when the topical query was exhaustive.

The summaries report whether the target survived the same protected and bounded cross-reserve merger into the final
admission window, plus admitted, protected, challenger, posting-row, posting-statement, selection, and fallback counts.
The artifact shape separates main, no-sibling, and total indexed document counts, and its fixture hash covers the
deterministic generated paths and content digests. In the no-sibling scenario, a fallback selection request is expected
but its cheap project/scope `EXISTS` preflight must keep `fallbackPostingStatements` at zero. The timed boundary does
not include fixture creation, initial index construction, branch or semantic selections, reranking, or final section
construction. It intentionally records host-specific observations without a universal timing gate:

```sh
bun run bench:recall:cross-scope-sqlite -- \
  --documents 4000 --samples 5 --warmups 1 \
  --output .artifacts/recall-cross-scope-sqlite.json
```

`bench:recall:eligibility` is the bounded production-path diagnostic for hard project and approved-authority
eligibility. It writes canonical personal and shared memory files, builds the production lexical SQLite index, and then
builds and queries the production vector SQLite index from that indexed corpus. Each disallowed class contains 525
stronger documents by default, exceeding both the five-result semantic top-k and the lexical loader's 500-row
per-term posting pool. The weaker target is therefore absent from unrestricted recall and from project-only recall
(where stronger same-project unapproved memories still dominate), but must be recovered when both explicit-project
and approved-authoritative eligibility are applied before either retrieval limit.

The summaries report target recovery, disallowed results, lexical posting rows/statements, vector rows eligible for
scoring, and result counts. Latency samples cover the warm read-only production queries after index construction;
there is no host-independent timing gate. Vector embeddings are deterministic fixture controls so the run isolates
SQLite eligibility placement and top-k behavior. It does not claim real embedding-model quality; use
`eval:recall:models` for that evidence.

```sh
bun run bench:recall:eligibility -- \
  --distractors-per-class 525 --samples 5 --warmups 1 \
  --output .artifacts/recall-eligibility-production.json
```

The checked-in `candidates/threadnote-4.2.7-hybrid-v6/` capture is the matched clean post-change comparison. Its p95
rank latency ranges from 0.986× to 1.001× the `hybrid-v3` reference across 200 through 100k documents, with lower p95
RSS at the three larger scales. It remains candidate evidence rather than a replacement baseline.

To add a benchmark scenario, expose a stable operation from `scripts/benchmark-target.ts`, register it in
`scripts/benchmark-recall-micro.mjs`, and add a named measurement to the end-to-end runner when process-level
telemetry matters. Never assert tight latency limits from a shared-host result.

Model candidates must have immutable revision, SHA-256, role, dimensions/context, prompt prefixes, normalization,
quantization, license, and hardware class metadata. Each candidate runs through the same query fixture and emits a
normal v2 run artifact; model downloads and raw benchmark output remain CI artifacts rather than checked-in files.
Reviewed compact gate summaries live under `candidates/<release>/` so failed candidates and their reasons are not
rediscovered or accidentally promoted later.

```sh
bun run eval:recall:models -- \
  --embedding bge-small-en-v1.5-q8 \
  --install \
  --output .artifacts/bge-small-full.json \
  --summary-output apps/threadnote/test/evaluation/candidates/threadnote-4.0.0/bge-small-en-v1.5-q8.json
```

## Artifact schemas

- Recall fixture: version 2 (`RecallEvaluationFixtureSchemaV2`)
- Pipeline run: version 1 (`RecallEvaluationRunSchemaV1`)
- Compact baseline: version 1 (`RecallEvaluationBaselineSchemaV1`); current artifacts add optional commit and dirty
  provenance while released artifacts without those fields remain valid
- Non-inferiority gate: version 1 (`RecallNonInferiorityGateV1`)
- Benchmark artifact: version 1 (`BenchmarkArtifactSchemaV1`)

Schema versions change only for incompatible contract changes. Add a migration before deleting a decoder for any
artifact format used by a released Threadnote version.
