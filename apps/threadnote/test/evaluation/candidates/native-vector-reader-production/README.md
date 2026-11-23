# Native vector reader production evidence

The approved release decision promotes the qualified reader and writer changes to 6.0.0 on all eight native targets.

## R5 qualification for 6.0.0

R5 uses local performance measurements and native CI contract tests. The performance comparison used candidate `305e147754fd3088dd0b8ce46c495840fe0affdf` and the independently built TypeScript baseline `66f4c1d8baed033ec484f4db2895ea2252b4e2d0` (TS66).
The candidate orders vector writes by chunk ID and reduces Rust allocations for discarded hits.
Both readers used identical verified inference bytes and the same candidate-built vector database for each case. [Frozen R5 report](https://github.com/threadnote/threadnote/blob/13d0581e4741cf7aff157974a65262b612c2bf45/apps/threadnote/test/evaluation/candidates/native-vector-reader-production/local-performance-platform-validation/results.md)

The local runs covered dense and tied cases at 10,000 and 100,000 documents.
Each case used three paired rounds of 30 warm requests per reader. All four cases passed on an Apple M1 Max. Both readers returned exact results within the original deadline on all 364 requests per reader.
For 100K dense, Rust reduced warm p95 by 25.2%, 28.1%, and 31.4% across the three rounds.
Rust took 8–64 ms longer on first use across the four cases. Rust used 2.9–4.4% less peak process-tree RSS across the twelve paired rounds.

The local gates require at least 20% lower warm p95 in each 100K dense round.
Each 10K case permits a p95 increase up to the greater of 5 ms and 5%.
Each 100K tied round requires exact completion. Each pair permits up to 10% higher peak process-tree RSS.
Every case requires exact query and scalar-oracle parity within the original deadline.

All eight native release targets passed five numeric tests and eleven compiled worker tests on the frozen candidate.
The first Windows x64 attempt reported `EBUSY` during temporary directory removal. The retry passed on the same source.
These CI tests establish native reader compatibility and worker behavior. The measured latency and RSS apply to the M1 Max host.
The release head requires its own CI results. [Native CI results](https://github.com/threadnote/threadnote/blob/13d0581e4741cf7aff157974a65262b612c2bf45/apps/threadnote/test/evaluation/candidates/native-vector-reader-production/local-performance-platform-validation/results.md#native-platform-checks)

## Production capture method

The reusable capture is a mode of the existing vector benchmark:

```sh
bun scripts/benchmark-recall-vectors.ts \
  --production-path --pairs 3 --samples 30 \
  --documents 100000 --distribution dense \
  --model-file /absolute/path/to/the/pinned/bge-small-en-v1.5-q8.gguf \
  --distribution-root /absolute/path/to/frozen/native-dist \
  --baseline-distribution-root /absolute/path/to/frozen/ts66-dist \
  --baseline-source-root /absolute/path/to/clean/ts66-checkout \
  --output /absolute/path/to/capture.json
```

Run the four cases serially: `100000/dense`, `100000/tied`, `10000/dense`, and `10000/tied`. The workflow owns model-cache availability and building a strict compiled candidate; the benchmark never downloads a model or builds native code. The model must match the builtin BGE SHA256. `--output` is required. Smaller `--documents`, `--samples` and `--pairs` support bounded setup smokes and discriminators, and are marked diagnostic.

Both input distributions must remain frozen throughout capture. The TypeScript semantic baseline is independently built from commit `66f4c1d8baed033ec484f4db2895ea2252b4e2d0`; candidate and baseline have separate executable/source/asset identities. Owned physical copies retain complete before/after inventories. The harness never hardlinks a globally installed payload or executes its original path. Private homes and install roots isolate worker execution.

The original Darwin development installation can be authenticated with its genuine receipt and complete payload inventory; its old release metadata has no `sourceIdentity` and is never rewritten. A CI baseline build records benchmark-only provenance, not an installation receipt. Before staging an inference overlay, record the clean original build using:

```sh
bun scripts/benchmark-recall-vectors.ts --write-baseline-provenance \
  --baseline-source-root /absolute/path/to/clean/ts66-checkout \
  --baseline-install-command "bun install --frozen-lockfile --ignore-scripts" \
  --baseline-distribution-root /absolute/path/to/ts66-dist
```

CI baseline dependency installation disables lifecycle scripts to prevent an implicit llama build/download. Musl baseline builds additionally use `--libc=glibc` to stage the original GNU optional package as build input only; provenance records that exact command, and the GNU closure is replaced before runtime capture. Candidate installation stays native to its target.

The capture also requires the clean exact TS66 checkout with its frozen dependencies installed. Before timing any request, the candidate and TS66 production lexical writers index the same canonical files. The harness requires both lexical indexes to report the same ready corpus generation and expected document count. Both compiled workers read one shared vector database and use their own lexical schema for readiness and authorization. The capture checks both lexical database hashes alongside the vector database hash.

When recording provenance for a private clone of the genuine installed Darwin baseline, omit `--baseline-source-root` from the `--write-baseline-provenance` command. That command verifies the original receipt and records origin `verified-development-install` with the unchanged receipt before overlay staging. Keep an untouched original clone separately. The production capture command requires the clean TS66 checkout for lexical preparation.

Stage the candidate's genuine hash-verified inference overlay into the private baseline using the owning inference assembler, then freeze both inputs. Original source/executable/release identity, original component inventory, shared overlay and final assembled inventory remain distinct. Both arms must have identical verified inference bytes. The shared warm parent loads the staged module from the frozen candidate input path using the existing engine host/environment foreground, context and GPU policy; its native module remains available for the whole runtime lifetime, including Windows DLL loading. Missing real inference on any profile blocks that profile.

A separate tiny SQLite VIEW discriminates the actual native engine without instrumenting product code or changing measured data. The frozen TS baseline must reject its malformed vectors and the native candidate must return the exact scalar-oracle result. Candidate payload absence is a capability failure, never a TypeScript fallback.
Each measured request calls `selectedSemanticScores` using the actual compiled ready-read worker boundary. Real pinned query inference stays in a scoped warm parent runtime. Both owned worker calls, DB opening/transactions, payload loading, IPC, independent authorization and lexical checks, canonical result validation and closing fences remain inside the clock. The existing 2000ms query deadline and 1100ms cleanup reserve stay unchanged. Synthetic normalized document embeddings permit reproducible dense and tied fixtures; every vector has a legitimate individually materialized canonical memory and published lexical metadata.

Release/install-style `--version` verification of each actual executable path runs before model initialization and is recorded as executable setup. It is neither a cold nor a warm semantic query. The original unverified-path startup failures remain in diagnostic evidence. Parent runtime initialization, model initialization and first full semantic requests are reported separately from warm samples. They are never relabeled as warm. Each pair reverses arm order. Independent Float32LE scalar full-sort results and exact query-vector hashes are computed outside measured requests, and every successful result must match the exact URI/score iteration order. Every failed request remains in the artifact; no sample is replaced or trimmed. Missing/failed samples withhold p95 and qualification evidence. Semantic/parity, ownership, source, model or fixture violations fail capture after preserving evidence. Budget failures remain recorded as unqualified; `--fail-on-budget` additionally makes unmet case gates fail the command.

The existing external sampler observes the recursive parent/child process tree during each warm arm. Its temporary-directory scan is restricted to a tiny owned telemetry directory, so it does not walk the canonical corpus or distribution during timing. All sampler availability, sampling failures and gaps remain in the artifact. Windows uses one bounded persistent PowerShell/CIM collector with process creation identities and recursive current working sets; no parent-only substitute is accepted. The sampler excludes its complete instrumentation subtree and confirms helper cleanup. The separate citation observer remains unsupported on Windows. Parent memory counters at each arm start disclose the benchmark process footprint, including any resident fixture-setup memory; the reported RSS scope is the complete observed process tree. Short smokes can legitimately lack process samples and cannot qualify. Temporary distributions and the canonical corpus are scoped to one case and removed after capture; only JSON and sampler evidence are retained.

Captures bind the actual compiled candidate commit/tree/target, strict native manifest and payload bytes, parent Bun version, executed benchmark source, relevant current runtime source, configuration, model and fixture hashes. Adding result JSON or prose afterward does not relabel the captured commit or require another feature build. Changed runtime, inference, harness or sampler code invalidates the relevant source binding.

### Historical hosted campaign

The earlier qualification plan required performance captures on all eight native profiles. The hosted campaign remains available for reference. [Hosted results](https://github.com/threadnote/threadnote/blob/5882dc7db71256f4d1151059fa6da527388f2515/apps/threadnote/test/evaluation/candidates/native-vector-reader-production/writer-qualification/results.md)

### Capture status fields

The capture tool also reports `deadlineCompletion` version 1. For 100k dense only, the `candidate-only-deadline-completion` outcome requires three or more complete matched pairs, at least 30 exact warm sample IDs per arm in every pair, and exactly one sample-0 first-use observation per arm. Rust must return exact independent query and scalar-oracle digests within the original 2000ms deadline on every request. TS66 must exhaust that same budget on every first-use and warm request, as recorded from the typed ready-read boundary error. Both arms need complete process-tree RSS telemetry, executable and engine proof, verified provenance, and closing source, model, fixture and distribution fences.

The deadline-completion outcome reports comparative p95 and comparable completed-work RSS as unavailable. The raw sampled process-tree peaks remain available for inspecting the workload that actually ran. This evidence has no effect on the numeric case gates, the exit status under `--fail-on-budget`, or the overall adoption decision.

Each capture reports its own case gates. The per-capture `qualified` field stays false because the capture covers only one case.

### Historical capture files

The root `platform-results.json`, `local-results.json`, and `linux-results.json` retain historical capture status. The current release decision is in `decision.json`.

A two-document Darwin correctness probe confirmed that the unchanged TS66 executable accepts a genuine shared inference overlay, retains its original receipt, runs real staged BGE inference and the actual owned worker under the unchanged 2s deadline, and matches exact ordered scalar/query results. Original and hybrid inventories remained unchanged. `local-results.json` records that compatibility proof separately; it contains no performance qualification.
