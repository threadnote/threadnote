# R5 local performance and native platform results

The frozen candidate passed all four performance cases on the Apple M1 Max. Native CI passed the reader checks on all eight release targets.

For this candidate, the workstation supplies the latency and memory evidence. Native CI supplies evidence for the reader and its compiled worker on each supported target.
The earlier hosted performance campaign remains available for comparison. [Hosted results](https://github.com/threadnote/threadnote/blob/5882dc7db71256f4d1151059fa6da527388f2515/apps/threadnote/test/evaluation/candidates/native-vector-reader-production/writer-qualification/results.md)

## Local measurements

Each cell gives TS66 first and Rust second. The three p95 and peak memory pairs follow run order. Memory covers the sampled process tree.

| Case | First use (ms) | Exact warm requests | Warm p95 (ms), by round | Peak RSS (MiB), by round | Local result |
| --- | ---: | ---: | --- | --- | --- |
| 100,000 dense | 539.5 / 547.5 | 90 / 90 | 544.6 / 407.6 · 526.2 / 378.1 · 548.5 / 376.2 | 2385.1 / 2285.1 · 2392.5 / 2305.4 · 2390.5 / 2313.0 | Pass |
| 100,000 tied | 594.6 / 644.3 | 90 / 90 | 557.0 / 412.0 · 565.5 / 411.6 · 543.2 / 425.0 | 2600.6 / 2525.0 · 2609.9 / 2522.9 · 2611.8 / 2529.4 | Pass |
| 10,000 dense | 225.2 / 258.2 | 90 / 90 | 220.3 / 171.3 · 220.0 / 169.6 · 242.2 / 202.8 | 1105.3 / 1065.6 · 1110.6 / 1070.4 · 1111.4 / 1068.4 | Pass |
| 10,000 tied | 216.9 / 281.3 | 90 / 90 | 226.6 / 188.6 · 215.1 / 174.9 · 216.1 / 171.5 | 1288.0 / 1244.8 · 1286.1 / 1229.8 · 1278.7 / 1224.0 | Pass |

At 100K dense, warm p95 fell by 25.2%, 28.1%, and 31.4% across the three rounds.
Each reader returned exact results within the deadline on all 364 requests. Rust took 8–64 ms longer on first use across the four cases.
Rust used 2.9–4.4% less peak memory in each paired round. Both readers met the 100K dense deadline, so a Rust-only completion claim does not apply.

The host ran macOS 27.3 (26C5035r) with 10 logical CPUs and 64 GiB of RAM. Other workstation processes ran during capture.
The 31 available CPU samples showed 42–81% idle time, with a median of 62%. Sampling started during the first case.
These measurements describe this host. The 100K completion rate on other hardware remains a separate question.

## Inputs and limits

The candidate was `305e147754fd3088dd0b8ce46c495840fe0affdf`, tree `8cdbb3b7c5a7cb5edac7810a702baf8af8bf7903`. It includes the chunk-ordered writer and the Rust allocation change from [#1157](https://github.com/threadnote/threadnote/pull/1157).
The independently compiled TypeScript baseline was `66f4c1d8baed033ec484f4db2895ea2252b4e2d0`. Both arms used Bun 1.4.4, the same BGE inference bytes, and the same vector database for each case.
The model had 384 dimensions and SHA-256 `f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804`.
The comparison measures both readers on the candidate layout. A separate experiment compared the two writer layouts with one fixed reader.

The four cases ran one at a time. Each arm made one first-use request and three rounds of 30 warm requests. Arm order alternated between rounds.
Each request retained the 2,000 ms deadline and the 1,100 ms cleanup reserve. The reference check covers the query digest and every ordered URI and score.
The local verifier checked source, payload, model, fixture, engine identity and all 24 sampler records. It recomputed p95 with the nearest-rank rule.

The 100K dense case requires at least 20% lower warm p95 in every round. Both 10K cases allow an increase of at most the greater of 5 ms and 5%.
The 100K tied case requires exact completion. All four cases limit Rust peak RSS to 110% of the paired TS66 peak.

The frozen source needed `CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=none` for build-time host dependencies on this macOS version. The target release profile used its original settings and Rust 1.89.0.
The local projection retains sample times, source identities, original capture hashes and sampler hashes. [Local measurements](./local-results.json)

## Native platform checks

CI built the release payload on each native target. It verified the required native reader and checked its target, commit and tree before the tests.
Each job ran five numeric tests against the reference implementation and eleven tests through the compiled worker. These cover exact ranking, Unicode ties, authorization, freshness, cancellation, and child cleanup.

| Native target | Numeric tests | Compiled worker tests | CI result |
| --- | ---: | ---: | --- |
| `bun-darwin-arm64` | 5/5 | 11/11 | [Pass](https://github.com/threadnote/threadnote/actions/runs/45229994337/job/137886627557) |
| `bun-darwin-x64` | 5/5 | 11/11 | [Pass](https://github.com/threadnote/threadnote/actions/runs/45229994337/job/137886627506) |
| `bun-linux-arm64` | 5/5 | 11/11 | [Pass](https://github.com/threadnote/threadnote/actions/runs/45229994337/job/137886627166) |
| `bun-linux-arm64-musl` | 5/5 | 11/11 | [Pass](https://github.com/threadnote/threadnote/actions/runs/45229994337/job/137886627816) |
| `bun-linux-x64-baseline` | 5/5 | 11/11 | [Pass](https://github.com/threadnote/threadnote/actions/runs/45229994337/job/137886627537) |
| `bun-linux-x64-baseline-musl` | 5/5 | 11/11 | [Pass](https://github.com/threadnote/threadnote/actions/runs/45229994337/job/137886627612) |
| `bun-windows-arm64` | 5/5 | 11/11 | [Pass](https://github.com/threadnote/threadnote/actions/runs/45229994337/job/137886627957) |
| `bun-windows-x64-baseline` | 5/5 | 11/11 | [Pass](https://github.com/threadnote/threadnote/actions/runs/45229994337/job/137892043081) |

On its first attempt, Windows x64 reported `EBUSY` when the test removed its temporary directory. The log showed no scoring or worker-exit assertion failure.
The lock owner is unknown. The retry rebuilt the same source and passed the same tests. The two Windows builds had different binary hashes. [First Windows attempt](https://github.com/threadnote/threadnote/actions/runs/45229994337/job/137886627900)

The platform projection retains both Windows attempts, the per-test results, native library hashes and GitHub archive digests. [Platform evidence](./platform-results.json)
