# Bounded Rust vector experiment

No native payload or default switch is enabled. `THREADNOTE_NATIVE_VECTOR_EXPERIMENT=1`
explicitly selects the experimental recall page scorer; unavailable native capability
fails visibly. The default remains TypeScript. SQLite selection, authorization,
transactions, query normalization, publication fences, aliases and URI aggregation
remain in the existing Effect flow.

Build with `bun scripts/build-native-vector-search.ts`. Run the two
`packages/inference/test/native-vector-search*.test.ts` suites with the explicit
environment selector. Cargo output belongs under `.context/native-vector-target`;
use `cargo test --locked --manifest-path packages/inference/native-vector/Cargo.toml
--target-dir .context/native-vector-target` for the native test.

The raw Node-API export accepts seven arguments and exposes no AbortSignal or native
task cancellation. The adapter drains its original owned task before interruption
finishes. This avoids napi2's unsafe queued-task cancellation completion path.
Admission allows two tasks; recall selects at most 400 rows
per page. This does not promise instantaneous cancellation or a scheduling deadline.

`first-rust-10k-dense.raw` preserves the unchanged runner's original JSON bytes from
clean source `364fe1e4414ce0acb221fb55f1ea8f0dc1cb3a06`. The summary records its
explicit invocation and retained native library checksum. Real pinned query inference,
SQLite, packing, native copies/scheduling and aggregation were measured together.
Three diagnostic samples on a shared macOS host passed the existing scalar oracle;
they establish execution and parity, with no speedup or qualification claim.

The default-off `include_native_recall_vector_pair` workflow compares pinned P2
`217edfe1e2d3d358a4ff761bab93fb26f27ff98d` and its exact candidate commit serially on
one Linux VM. Three counterbalanced replicas collect 30 warm requests and separately
labeled observer controls per arm for 10k/100k dense/tied cases, using each checkout's
verified committed model. `capture.ts` leaves the benchmark and raw JSON unchanged;
companions record the selector, clean source fences, native library/Cargo lock digests,
raw artifact checksum and actual exit status. No model download is performed.

Adoption remains gated on at least 20% complete warm primary-request p95 improvement
against P2, secondary regression at most max(5ms, 5%), RSS growth at most 10%, and
exact parity for each platform/component. The paired CI capture has not run yet.
