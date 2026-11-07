# Vector experiment: native DEFER

Do not ship this Rust vector implementation. Linux's measured comparison fails the
unchanged R5 gates; macOS has only negative descriptive local evidence and remains
unqualified. This decision concerns this bounded vector implementation and these
platform measurements, not Rust generally or any other experiment.

This delivery contains evidence only. The prototype remains frozen at
[`0b9419ba499076a2260437e81d0ca4f94749791f`](https://github.com/threadnote/threadnote/tree/0b9419ba499076a2260437e81d0ca4f94749791f)
for reproduction. Do not merge its crate, dependencies, adapter, builder, executable
capture companion, native payload or experimental workflow job.

## Linux: measured failure

The [public CI artifact](https://github.com/threadnote/threadnote/actions/runs/42996460997/artifacts/13845263550)
contains 24 raw captures and their provenance companions from one serial Linux VM:
AMD EPYC 7763, four logical processors, Bun 1.4.4, Rust 1.80.1. Reference TypeScript
is `217edfe1e2d3d358a4ff761bab93fb26f27ff98d`; Rust is the frozen prototype above.
Both include Bun crypto. Each 10k/100k dense/tied cell has three paired replicas,
30 warm requests, 30 separate observer-disabled controls and one first-use request
per arm. Replicas 1 and 3 execute TypeScript then Rust; replica 2 reverses the order.

Requests include the verified committed BGE model's real query inference,
authorized SQLite reads, packing, native copies/scheduling, scoring and aggregation.
The corpus uses synthetic document embeddings. Model, runtime, fixture,
configuration and exact ordered-result digests match within every pair. Source and
native-library opening/closing fences are clean and stable; raw hashes match the
companions. All outliers are retained.

The gates stay fixed: at least 20% lower complete primary-request p95, secondary
regression at most max(5ms, 5% of reference p95), process-tree peak RSS growth at
most 10%, and exact parity for each component/platform independently.

- None of the 12 paired comparisons improves warm p95 by 20%. The declared primary
  100k/dense case fails that gate in all three replicas.
- Four of six 10k secondary comparisons exceed their allowed regression.
- Four of 12 comparisons exceed the RSS gate; maximum sampled process-tree growth
  is 14.00%.
- All 12 cross-arm ordered-result digests match. Correctness does not override the
  failed performance/resource gates.

| Vectors | Distribution | Replica | TS p95 ms | Rust p95 ms | Rust latency change | Tree RSS change |
| ------- | ------------ | ------- | --------- | ----------- | ------------------- | --------------- |
| 10k     | dense        | 1       | 85.78     | 91.72       | +6.92%              | +12.20%         |
| 10k     | dense        | 2       | 85.22     | 105.38      | +23.65%             | +9.15%          |
| 10k     | dense        | 3       | 85.08     | 90.21       | +6.03%              | +8.24%          |
| 10k     | tied         | 1       | 93.19     | 93.52       | +0.35%              | +7.75%          |
| 10k     | tied         | 2       | 86.74     | 88.15       | +1.62%              | +5.76%          |
| 10k     | tied         | 3       | 90.30     | 95.46       | +5.71%              | +12.48%         |
| 100k    | dense        | 1       | 663.26    | 639.30      | -3.61%              | +6.37%          |
| 100k    | dense        | 2       | 650.91    | 619.52      | -4.82%              | +13.65%         |
| 100k    | dense        | 3       | 629.81    | 629.42      | -0.06%              | +9.34%          |
| 100k    | tied         | 1       | 657.96    | 614.84      | -6.55%              | +14.00%         |
| 100k    | tied         | 2       | 630.15    | 618.02      | -1.92%              | +7.22%          |
| 100k    | tied         | 3       | 648.89    | 638.70      | -1.57%              | +8.16%          |

`linux-paired-results.json` preserves every cell's statistics, warm/control/CPU/
first-use arrays, stage summary arrays, counts, identities, source/binary/Cargo/raw
hashes, sampler availability/gaps and per-pair gate outcomes. The unchanged runner
selects the sorted element at floor(n × quantile), capped at n−1; it does not
interpolate or trim. SQL span union and mixed reader residual percentiles are not
additive; the residual includes control/transaction overhead, not pure math.
First-use is after fixture construction, not cold process/filesystem latency.
Sampled RSS can miss peaks.

## macOS: descriptive local negative result

Two counterbalanced 100k/dense local pairs use five warm requests and five controls
per arm on a shared M1 Max host. Rust's observed medians are 473.63 versus 423.81ms
(+11.76%) and 458.41 versus 432.65ms (+5.95%). Controls also favor TypeScript.
Exact outputs and source/model/runtime/raw fences match. External activity and
all outliers remain recorded in `local-rust-comparison.json`. These five-sample
results are an early discriminator, not p95 qualification.

The separate P2 legacy/optimized comparison is retained at
`../vector-typescript/local-comparison.json`. Its observed direction reverses
with order and large shared-host outliers remain: P2 is +6.44% in one pair and
-7.55% in the other. A causal full-request P2 benefit is unproven. This recall case
does not establish graph blob-path performance, and results from separate capture
windows cannot establish a causal Rust-versus-legacy ranking. The Linux reference
is explicitly the P2 candidate, not relabeled the best proven TypeScript baseline.

## Retention and reproduction

`decision.json` records the vector-only DEFER decision and unchanged gates. The
public artifact expires on December 11, 2026; its GitHub-provided archive SHA256 is
retained alongside hashes for every raw capture and companion. Permanent JSON
projections retain metrics, sample arrays and identity metadata without private
paths or user content. Full local captures/provenance remain with the frozen
prototype; they are not copied into delivery.

For a replay, use a separate checkout of the frozen prototype and its documented
builder/paired workflow with Bun 1.4.4, Rust 1.80.1 and the committed SHA-verified
model. The model is not downloaded by the measurement. Reproduction tooling stays
in that historical prototype, not the delivered tree. No further vector benchmarks,
profiles or Rust optimization are authorized by this negative result.
