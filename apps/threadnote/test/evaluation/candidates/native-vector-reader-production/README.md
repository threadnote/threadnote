# Native vector reader production evidence

Status: **unqualified**. The native-only all-eight rollout remains blocked by the approved R5 gates. Historical optional-native diagnostics are preserved without relabeling. The earlier SQLite/Rust pilot and the source-mode diagnostic are supporting experiments, not production qualification.

The reusable capture is a mode of the existing vector benchmark:

```sh
bun scripts/benchmark-recall-vectors.ts \
  --production-path --pairs 3 --samples 30 \
  --documents 100000 --distribution dense \
  --model-file /absolute/path/to/the/pinned/bge-small-en-v1.5-q8.gguf \
  --distribution-root /absolute/path/to/frozen/native-dist \
  --baseline-distribution-root /absolute/path/to/frozen/ts66-dist \
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

For a private clone of the genuine installed Darwin baseline, omit `--baseline-source-root`; the command verifies its original receipt and records origin `verified-development-install` with that unchanged receipt before overlay staging. Keep an untouched original clone separately. This records existing evidence and does not invent a clean CI build.

Stage the candidate's genuine hash-verified inference overlay into the private baseline using the owning inference assembler, then freeze both inputs. Original source/executable/release identity, original component inventory, shared overlay and final assembled inventory remain distinct. Both arms must have identical verified inference bytes. The shared warm parent loads the staged module from the frozen candidate input path using the existing engine host/environment foreground, context and GPU policy; its native module remains available for the whole runtime lifetime, including Windows DLL loading. Missing real inference on any profile blocks that profile.

A separate tiny SQLite VIEW discriminates the actual native engine without instrumenting product code or changing measured data. The frozen TS baseline must reject its malformed vectors and the native candidate must return the exact scalar-oracle result. Candidate payload absence is a capability failure, never a TypeScript fallback.
Each measured request calls `selectedSemanticScores` using the actual compiled ready-read worker boundary. Real pinned query inference stays in a scoped warm parent runtime. Both owned worker calls, DB opening/transactions, payload loading, IPC, independent authorization and lexical checks, canonical result validation and closing fences remain inside the clock. The existing 2000ms query deadline and 1100ms cleanup reserve stay unchanged. Synthetic normalized document embeddings permit reproducible dense and tied fixtures; every vector has a legitimate individually materialized canonical memory and published lexical metadata.

Release/install-style `--version` verification of each actual executable path runs before model initialization and is recorded as executable setup. It is neither a cold nor a warm semantic query. The original unverified-path startup failures remain in diagnostic evidence. Parent runtime initialization, model initialization and first full semantic requests are reported separately from warm samples. They are never relabeled as warm. Each pair reverses arm order. Independent Float32LE scalar full-sort results and exact query-vector hashes are computed outside measured requests, and every successful result must match the exact URI/score iteration order. Every failed request remains in the artifact; no sample is replaced or trimmed. Missing/failed samples withhold p95 and qualification evidence. Semantic/parity, ownership, source, model or fixture violations fail capture after preserving evidence. Budget failures remain recorded as unqualified; `--fail-on-budget` additionally makes unmet case gates fail the command.

The existing external sampler observes the recursive parent/child process tree during each warm arm. Its temporary-directory scan is restricted to a tiny owned telemetry directory, so it does not walk the canonical corpus or distribution during timing. All sampler availability, sampling failures and gaps remain in the artifact. Windows uses one bounded persistent PowerShell/CIM collector with process creation identities and recursive current working sets; no parent-only substitute is accepted. The sampler excludes its complete instrumentation subtree and confirms helper cleanup. The separate citation observer remains unsupported on Windows. Parent memory counters at each arm start disclose the benchmark process footprint, including any resident fixture-setup memory; the reported RSS scope is the complete observed process tree. Short smokes can legitimately lack process samples and cannot qualify. Temporary distributions and the canonical corpus are scoped to one case and removed after capture; only JSON and sampler evidence are retained.

Captures bind the actual compiled candidate commit/tree/target, strict native manifest and payload bytes, parent Bun version, executed benchmark source, relevant current runtime source, configuration, model and fixture hashes. Adding result JSON or prose afterward does not relabel the captured commit or require another feature build. Changed runtime, inference, harness or sampler code invalidates the relevant source binding.

R5 remains unchanged:

- At least three paired runs of 30 warm requests per arm, with dense and tied controls on every one of the eight native release profiles: Darwin ARM64/x64, Linux GNU and musl ARM64/x64, and Windows ARM64/x64.
- At least 20% p95 improvement for the primary 100k dense case.
- No 10k p95 regression larger than `max(5ms, 5%)`.
- No process-tree sampled peak RSS growth larger than 10%.
- Exact output/query/scalar-oracle parity, separately reported first use, and all existing deadlines and ownership/freshness/authorization fences.

Each capture reports only its case gates. Its `qualified` field stays false because a single case cannot establish all eight profiles and all controls. `decision.json` records the overall adoption decision; `platform-results.json` lists every required profile as pending until native-host evidence is captured. `local-results.json` currently contains diagnostic observations and failures; `linux-results.json` explicitly records the unrun qualification. No formal R5 pass is claimed.

A two-document Darwin correctness probe confirmed that the unchanged TS66 executable accepts a genuine shared inference overlay, retains its original receipt, runs real staged BGE inference and the actual owned worker under the unchanged 2s deadline, and matches exact ordered scalar/query results. Original and hybrid inventories remained unchanged. `local-results.json` records that compatibility proof separately; it contains no performance qualification.
