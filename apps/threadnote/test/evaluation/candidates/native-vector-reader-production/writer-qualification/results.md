# R5 qualification of the chunk-ordered writer and Rust reader

R5 blocks release adoption of this candidate. 1 of eight targets passed all four numeric R5 cases. 14 of 32 cases passed the numeric gates. 1 additional cases met the separate 100K deadline-completion rule.

[Qualification run](https://github.com/threadnote/threadnote/actions/runs/45206621938) and [two-case preflight](https://github.com/threadnote/threadnote/actions/runs/45203720958).

## Results by target

| Target | 10K dense | 10K tied | 100K dense | 100K tied |
| --- | --- | --- | --- | --- |
| [bun-darwin-arm64](https://github.com/threadnote/threadnote/actions/runs/45206621938/job/137803976430) | Pass | Pass | Incomplete requests | Incomplete requests |
| [bun-darwin-x64](https://github.com/threadnote/threadnote/actions/runs/45206621938/job/137803976531) | Incomplete requests | Incomplete requests | Incomplete requests | Incomplete requests |
| [bun-linux-arm64](https://github.com/threadnote/threadnote/actions/runs/45206621938/job/137803976777) | Pass | Pass | Pass | Pass |
| [bun-linux-arm64-musl](https://github.com/threadnote/threadnote/actions/runs/45206621938/job/137803976035) | Pass | Pass | Rust completion | Incomplete requests |
| [bun-linux-x64-baseline](https://github.com/threadnote/threadnote/actions/runs/45206621938/job/137803976583) | Pass | Pass | Incomplete requests | Pass |
| [bun-linux-x64-baseline-musl](https://github.com/threadnote/threadnote/actions/runs/45206621938/job/137803976651) | Pass | Pass | Pass | Incomplete requests |
| [bun-windows-arm64](https://github.com/threadnote/threadnote/actions/runs/45221576606/job/137856938452) | Incomplete requests | Telemetry | Engine check timed out | Engine check timed out |
| [bun-windows-x64-baseline](https://github.com/threadnote/threadnote/actions/runs/45214473594/job/137831768807) | Telemetry | Telemetry | Incomplete requests | Incomplete requests |

All 32 cases ran. Thirty produced warm samples. On Windows ARM64, both 100K cases stopped at the independent engine check. Both readers exhausted their budgets at first use. The Rust proof request timed out on both databases. No warm samples exist for those two cases.

Linux ARM64 with glibc passed all four numeric cases. At 100K dense it reduced p95 by 31.3% to 31.9%. Rust returned exact results on all 16 first uses and all 1,440 warm requests across Linux. On Linux ARM64 musl, the separate completion rule passed at 100K dense. At 100K tied, Rust also completed every request on that target. The separate rule applies only to dense vectors.

Windows used fresh native runners after the original checkout changed the benchmark bytes from LF to CRLF. The byte check rejected those original captures. The matrix retains their archive identifiers and hashes.

Pass means both readers returned exact results and all three pairs met the case limits. Rust completion means Rust met the deadline on all 91 requests and TS66 exhausted its budget on all 91.

Incomplete requests means a first or warm request failed. The capture retains each failure. A telemetry entry means the process samples did not meet the evidence requirements. A p95 or RSS entry identifies a measured limit that the candidate exceeded.

The [Intel deadline trace](./intel-deadline.md) records the last worker phase for six separate 100K requests. Three reached the native call without a return marker. Two completed the native call before the request expired. One stopped before the worker decoded the score request.

## Method

The candidate was `305e147754fd3088dd0b8ce46c495840fe0affdf` with tree `8cdbb3b7c5a7cb5edac7810a702baf8af8bf7903`. The TS66 baseline was `66f4c1d8baed033ec484f4db2895ea2252b4e2d0`. Both readers used the same candidate-built vector database on each host. These runs cannot isolate the effect of the writer.

Each reader made one first-use request and 90 warm requests per case. The three paired rounds contained 30 requests per reader. Each query had a 2,000 ms deadline and a 1,100 ms cleanup reserve. The reference hashes cover the normalized query and ordered URI/score pairs.

At 100K dense, Rust must reduce warm p95 by at least 20% in each pair. At 10K, the allowed increase is the greater of 5 ms and 5%. At 100K tied, R5 requires complete requests without a separate latency ratio. All numeric cases require a peak for the process tree within 110% of TS66 in each pair.

A TS66 timeout leaves comparative p95 and memory for completed work unavailable. The separate deadline rule applies only to 100K dense. These runs retain timeouts and outliers.

## Exact requests and numeric gates

First-use and warm counts below use TS66/Rust order. Peak memory comparisons require complete telemetry and comparable completed work.

| Target | Case | Exact first use | Exact warm | p95 per round, TS66/Rust (ms) | Peak RSS per round, TS66/Rust (MiB) |
| --- | --- | --- | --- | --- | --- |
| bun-darwin-arm64 | 10000-dense | 1/1 | 90/90 | 348.5/182.4, 229.0/173.8, 223.1/225.2 | 995.5/955.8, 993.8/961.2, 1002.9/961.9 |
| bun-darwin-arm64 | 10000-tied | 1/1 | 90/90 | 640.5/361.7, 359.9/278.2, 309.4/303.8 | 1009.5/975.8, 1009.6/973.8, 1009.4/975.3 |
| bun-darwin-arm64 | 100000-dense | 0/0 | 17/44 | —/—, —/—, —/— | 2139.2/2045.6, 1978.9/1911.1, 1893.0/1757.8 |
| bun-darwin-arm64 | 100000-tied | 0/0 | 47/66 | —/—, —/—, —/— | 2275.2/2201.5, 2279.3/2201.1, 2265.0/2190.7 |
| bun-darwin-x64 | 10000-dense | 1/1 | 82/89 | 879.8/737.9, —/—, —/677.1 | 1055.8/1025.5, 1063.4/—, 1062.9/1028.7 |
| bun-darwin-x64 | 10000-tied | 1/1 | 89/90 | 756.7/689.6, —/589.7, 681.4/653.5 | 1207.8/1163.4, 1212.4/1175.6, 1216.0/1171.8 |
| bun-darwin-x64 | 100000-dense | 0/0 | 0/0 | —/—, —/—, —/— | 2017.9/1942.0, 2022.5/1939.8, 2024.9/1936.6 |
| bun-darwin-x64 | 100000-tied | 0/0 | 0/16 | —/—, —/—, —/— | 2156.2/2081.0, 2161.6/2080.6, 2160.7/2083.0 |
| bun-linux-arm64 | 10000-dense | 1/1 | 90/90 | 372.6/268.9, 373.1/275.8, 367.9/273.8 | 484.2/449.6, 497.9/447.2, 500.6/475.3 |
| bun-linux-arm64 | 10000-tied | 1/1 | 90/90 | 385.5/278.0, 368.7/276.8, 373.0/276.4 | 487.6/453.7, 512.1/454.3, 524.2/484.2 |
| bun-linux-arm64 | 100000-dense | 1/1 | 90/90 | 867.7/592.8, 859.8/585.2, 857.1/588.7 | 809.3/770.7, 811.5/769.7, 844.1/753.0 |
| bun-linux-arm64 | 100000-tied | 1/1 | 90/90 | 847.8/593.3, 854.2/590.3, 851.7/597.6 | 811.4/772.1, 814.2/770.2, 845.0/753.4 |
| bun-linux-arm64-musl | 10000-dense | 1/1 | 90/90 | 488.6/375.8, 497.9/384.5, 496.8/381.6 | 488.5/452.3, 508.6/465.1, 499.9/477.4 |
| bun-linux-arm64-musl | 10000-tied | 1/1 | 90/90 | 478.5/363.7, 486.5/359.3, 479.5/376.1 | 489.0/450.5, 523.1/464.1, 580.3/446.6 |
| bun-linux-arm64-musl | 100000-dense | 0/1 | 0/90 | —/674.5, —/665.7, —/676.8 | 812.6/774.5, 822.1/759.5, 1140.8/775.5 |
| bun-linux-arm64-musl | 100000-tied | 0/1 | 0/90 | —/717.7, —/711.6, —/703.1 | 812.1/774.4, 1131.9/753.5, 834.8/1188.0 |
| bun-linux-x64-baseline | 10000-dense | 1/1 | 90/90 | 302.9/227.5, 309.0/230.2, 309.9/228.1 | 500.2/463.5, 505.5/463.2, 527.7/486.6 |
| bun-linux-x64-baseline | 10000-tied | 1/1 | 90/90 | 310.3/234.9, 302.8/232.7, 309.7/225.7 | 498.4/467.8, 500.2/461.9, 526.6/489.4 |
| bun-linux-x64-baseline | 100000-dense | 1/1 | 84/90 | 673.8/459.2, —/456.7, 667.2/445.2 | 825.0/764.3, 843.7/784.3, 825.8/786.0 |
| bun-linux-x64-baseline | 100000-tied | 1/1 | 90/90 | 641.9/451.1, 639.5/443.3, 654.7/454.9 | 823.1/755.5, 847.2/786.8, 827.1/771.1 |
| bun-linux-x64-baseline-musl | 10000-dense | 1/1 | 90/90 | 349.6/272.0, 351.2/256.8, 356.5/259.6 | 495.1/454.8, 505.0/454.3, 499.6/464.9 |
| bun-linux-x64-baseline-musl | 10000-tied | 1/1 | 90/90 | 360.4/279.8, 346.8/254.6, 359.1/261.2 | 495.4/461.8, 506.4/457.1, 514.0/479.7 |
| bun-linux-x64-baseline-musl | 100000-dense | 1/1 | 90/90 | 769.3/513.7, 760.5/518.6, 764.4/522.7 | 817.7/763.8, 832.0/776.9, 831.5/771.4 |
| bun-linux-x64-baseline-musl | 100000-tied | 1/1 | 85/90 | —/545.3, 788.1/551.9, 780.9/546.7 | 823.2/778.0, 823.4/780.3, 850.8/773.7 |
| bun-windows-arm64 | 10000-dense | 1/1 | 89/90 | 670.6/508.4, 631.5/463.3, —/466.2 | —/—, —/—, —/— |
| bun-windows-arm64 | 10000-tied | 1/1 | 90/90 | 684.8/550.0, 671.0/559.3, 670.5/509.9 | —/—, —/—, —/— |
| bun-windows-arm64 | 100000-dense | Engine check timed out | — | — | — |
| bun-windows-arm64 | 100000-tied | Engine check timed out | — | — | — |
| bun-windows-x64-baseline | 10000-dense | 1/1 | 90/90 | 742.5/627.9, 642.0/508.0, 641.9/513.7 | —/—, —/—, —/— |
| bun-windows-x64-baseline | 10000-tied | 1/1 | 90/90 | 745.9/550.9, 656.6/555.9, 633.2/505.1 | —/—, —/406.4, —/— |
| bun-windows-x64-baseline | 100000-dense | 0/0 | 0/0 | —/—, —/—, —/— | —/—, —/—, —/— |
| bun-windows-x64-baseline | 100000-tied | 0/0 | 0/0 | —/—, —/—, —/— | —/—, —/—, —/— |

The memory columns include observed peaks for interrupted work. A dash indicates an unavailable measurement.

## Evidence

The [matrix](./matrix.json) retains the per-case outcome, first-use observations, exact warm counts, and measurements for each pair. Each case records its source run, archive identifier, and SHA-256 digest. The downloaded archives contain the original samples, setup checks, and process telemetry.

### Windows memory evidence

On x64, 264 of 1,874 process polls failed. Only one of 24 warm arms had complete memory evidence. A separate two-document diagnostic rejected nine polls during 60 successful requests. Six lookups lost a descendant after enumeration. Three failed a later identity or liveness check. The original aggregate counters do not identify the cause of individual failed polls. [Sampler diagnostic](https://github.com/threadnote/threadnote/actions/runs/45223128492/artifacts/14842701065)

### Windows setup attempts

Two exact-source ARM64 attempts ended before their measured cases. The TS66 engine check timed out on both hosts. The Rust engine check also timed out on the second host. The final driver records the setup result and executes each full case independently.

The permanent workflow fix enforces LF and checks the benchmark bytes before dependency installation. It merged into [main](https://github.com/threadnote/threadnote/pull/1171) and [6.0.0](https://github.com/threadnote/threadnote/pull/1172).

- [ARM64 setup 45214748915](https://github.com/threadnote/threadnote/actions/runs/45214748915/artifacts/14839695585) · `sha256:3b42e34e20ef28cf1c83f8657aad38f70b038f195334bf683d0fff4773fca6fc`
- [ARM64 setup 45218690743](https://github.com/threadnote/threadnote/actions/runs/45218690743/artifacts/14841895887) · `sha256:a0f38eb07a244889e508dcc15e144351cc01196e7c0ec8ee5993bae0412c825a`

### Accepted and original capture archives

- [Original bun-windows-arm64, rejected source bytes](https://github.com/threadnote/threadnote/actions/runs/45206621938/artifacts/14837333326) · `sha256:a0c875fcba0aba347cbdf860a1dfa744f2fa8692ff6b3ae6efb326b1760aec40`
- [Original bun-windows-x64-baseline, rejected source bytes](https://github.com/threadnote/threadnote/actions/runs/45206621938/artifacts/14837476928) · `sha256:9bc05e9afdfa6efe278e56f677f5989d290b5abc2671203070c4c750d91cbadd`

Every qualifying or fully sampled case matched the frozen inputs, engine discriminator, result reference, and sampler sidecars. All 180 sidecars for the 30 fully sampled cases matched the capture records.

- [bun-darwin-arm64 (45203720958)](https://github.com/threadnote/threadnote/actions/runs/45203720958/artifacts/14831604975) · `sha256:b68ac552b765ed5004c53fa89bad148daae279c54eabbbc54277e35fb0e7a431`
- [bun-darwin-arm64 (45206621938)](https://github.com/threadnote/threadnote/actions/runs/45206621938/artifacts/14834549024) · `sha256:cb48cefec507f59822d9ae595c8980cc07982df52ecea9072325bfbfac405d39`
- [bun-darwin-x64 (45206621938)](https://github.com/threadnote/threadnote/actions/runs/45206621938/artifacts/14835958196) · `sha256:6b06b5cf5eb7ea2772531bb8ad15ffcf51d354d0ef4b5b3288b1242620241c8f`
- [bun-linux-arm64 (45206621938)](https://github.com/threadnote/threadnote/actions/runs/45206621938/artifacts/14835204078) · `sha256:6fdfe843fe5944a35560c0f8650801482ad6bafce5044d72ecd41f83a281f314`
- [bun-linux-arm64-musl (45206621938)](https://github.com/threadnote/threadnote/actions/runs/45206621938/artifacts/14834667747) · `sha256:8bd8d07f58a0405729ca4ff67ba31a3452e7668e83d4a9163f41b90b291057a5`
- [bun-linux-arm64-musl (45203720958)](https://github.com/threadnote/threadnote/actions/runs/45203720958/artifacts/14833936418) · `sha256:283df8001cf75b8f0a7201e60a59aa9b23322c88d919ff167cc80ac8c78bee5b`
- [bun-linux-x64-baseline (45206621938)](https://github.com/threadnote/threadnote/actions/runs/45206621938/artifacts/14836275487) · `sha256:53787b22218813fe6e9c5f355230e5da74b521b0c0603d695fc1052527f73b9e`
- [bun-linux-x64-baseline-musl (45206621938)](https://github.com/threadnote/threadnote/actions/runs/45206621938/artifacts/14834773165) · `sha256:2f2d6afc2bf58d3b2432eab2987610dc4af65bc5bac52b75db95a20ca4d1d667`
- [bun-windows-arm64 (45221576606)](https://github.com/threadnote/threadnote/actions/runs/45221576606/artifacts/14845705873) · `sha256:2aae3a703ac951ef1de2068345663ce0a90f4bd31044c4de64fe7bef0dd1ad36`
- [bun-windows-x64-baseline (45214473594)](https://github.com/threadnote/threadnote/actions/runs/45214473594/artifacts/14840178767) · `sha256:71c788300624b714dd3109188228963c12b97788476fafea1bf3e0348d3047ef`
