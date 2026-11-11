# Native vector reader production evidence

Status: **unqualified**. Private candidate execution is implemented; shipping adoption remains blocked by the approved R5 gates. The earlier SQLite/Rust pilot and the source-mode diagnostic are supporting experiments, not production qualification.

The reusable capture is a mode of the existing vector benchmark:

```sh
bun scripts/benchmark-recall-vectors.ts \
  --production-path --pairs 3 --samples 30 \
  --documents 100000 --distribution dense \
  --model-file /absolute/path/to/the/pinned/bge-small-en-v1.5-q8.gguf \
  --distribution-root /absolute/path/to/frozen/dist \
  --output /absolute/path/to/capture.json
```

Run the four cases serially: `100000/dense`, `100000/tied`, `10000/dense`, and `10000/tied`. The workflow owns model-cache availability and building a strict compiled candidate; the benchmark never downloads a model or builds native code. The model must match the builtin BGE SHA256. `--output` is required. Smaller `--documents`, `--samples` and `--pairs` support bounded setup smokes and discriminators, and are marked diagnostic.

The input distribution must remain frozen throughout capture. Both owned temporary distributions hardlink its immutable files; the baseline omits only `runtime/vector-reader`. No linked file is written. Inventories before and after capture prove identical executable and common asset bytes. Each child resolves its own adjacent payload through the ordinary standalone loader. A separate tiny SQLite VIEW discriminates the actual native engine without instrumenting product code or changing measured data. The baseline must reject its malformed vectors and the native candidate must return the exact scalar-oracle result.

Each measured request calls `selectedSemanticScores` using the actual compiled ready-read worker boundary. Real pinned query inference stays in a scoped warm parent runtime. Both owned worker calls, DB opening/transactions, payload loading, IPC, independent authorization and lexical checks, canonical result validation and closing fences remain inside the clock. The existing 2000ms query deadline and 1100ms cleanup reserve stay unchanged. Synthetic normalized document embeddings permit reproducible dense and tied fixtures; every vector has a legitimate individually materialized canonical memory and published lexical metadata.

Release/install-style `--version` verification of each actual executable path runs before model initialization and is recorded as executable setup. It is neither a cold nor a warm semantic query. The original unverified-path startup failures remain in diagnostic evidence. Model initialization and first full semantic requests are reported separately from warm samples. They are never relabeled as warm. Each pair reverses arm order. Independent Float32LE scalar full-sort results and exact query-vector hashes are computed outside measured requests, and every successful result must match the exact URI/score iteration order. Every failed request remains in the artifact; no sample is replaced or trimmed. Missing/failed samples withhold p95 and qualification evidence. Semantic/parity, ownership, source, model or fixture violations fail capture after preserving evidence. Budget failures remain recorded as unqualified; `--fail-on-budget` additionally makes unmet case gates fail the command.

The existing external sampler observes the recursive parent/child process tree during each warm arm. Its temporary-directory scan is restricted to a tiny owned telemetry directory, so it does not walk the canonical corpus or distribution during timing. All sampler availability, sampling failures and gaps remain in the artifact. Parent memory counters at each arm start disclose the benchmark process footprint, including any resident fixture-setup memory; the reported RSS scope is the complete observed process tree. Short smokes can legitimately lack process samples and cannot qualify. Temporary distributions and the canonical corpus are scoped to one case and removed after capture; only JSON and sampler evidence are retained.

Captures bind the actual compiled candidate commit/tree/target, strict native manifest and payload bytes, parent Bun version, executed benchmark source, relevant current runtime source, configuration, model and fixture hashes. Adding result JSON or prose afterward does not relabel the captured commit or require another feature build. Changed runtime, inference, harness or sampler code invalidates the relevant source binding.

R5 remains unchanged:

- At least three paired runs of 30 warm requests per arm, with dense and tied controls on Darwin ARM64 and Linux x64.
- At least 20% p95 improvement for the primary 100k dense case.
- No 10k p95 regression larger than `max(5ms, 5%)`.
- No process-tree sampled peak RSS growth larger than 10%.
- Exact output/query/scalar-oracle parity, separately reported first use, and all existing deadlines and ownership/freshness/authorization fences.

Each capture reports only its case gates. Its `qualified` field stays false because a single case cannot establish both platforms and all controls. `decision.json` records the overall adoption decision. `local-results.json` currently contains diagnostic observations and failures; `linux-results.json` explicitly records the unrun qualification. No formal R5 pass is claimed.
