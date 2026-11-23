# Intel macOS 100K deadline diagnosis

On Intel macOS, both readers returned zero exact results in the 90 warm dense requests. The Rust worker reached the score operation on 88 requests. For these 88 requests, the median allowance was 662 ms and the median observed duration was 702 ms. The state worker took a median of 226 ms across all 90 requests. [Qualification capture](https://github.com/threadnote/threadnote/actions/runs/45206621938/artifacts/14835958196)

## Last observed phase

Six diagnostic requests used the same candidate, native payload, dataset recipe, runner class, and production deadline. Each request recorded phase markers as the child executed. All six timed out. The score allowance below is what remained after the state operation and query preparation. [Diagnostic capture](https://github.com/threadnote/threadnote/actions/runs/45219196265/artifacts/14842166205)

| Request | State worker, ms | Score allowance, ms | Last score marker before termination | Observed native call, ms |
| ---: | ---: | ---: | --- | ---: |
| 0 | 841 | 45 | Worker entry, before request decode | — |
| 1 | 302 | 583 | Canonical row selection began | 382 |
| 2 | 395 | 485 | Native call began | — |
| 3 | 449 | 403 | Native call began | — |
| 4 | 357 | 525 | Native call returned | 374 |
| 5 | 272 | 614 | Native call began | — |

A missing return marker leaves the full call duration unknown. Two calls returned before the deadline expired. One of those requests reached canonical row selection. These observations place the failures on both sides of the native call.

The state worker decoded its request 69–148 ms after its entry marker. It wrote the reply 116–210 ms after decoding. Additional wall time falls outside these two intervals. The measurements do not attribute that time to a specific operation.

## Engineering implication

The next experiment should target the state request before scoring. Compare a matched prototype with the current two-worker path. Measure the score allowance recovered, the number of exact completions, and the time spent in canonical validation. Preserve the existing authorization, freshness, cancellation, cleanup, and deadline rules. The six timeouts do not predict how many extra completions such a change would produce.

## Limits

The diagnostic writes synchronous phase markers. These writes can affect timing. The six requests ran before the tiny engine check. The traced executable passed that check, but the uninstrumented candidate timed out. This prevented the subsequent paired diagnostic rounds. The separate qualification capture established the actual production engine and measured all 90 warm requests. A first diagnostic attempt also stopped at its tiny engine check before it could record a traced 100K request. [First attempt](https://github.com/threadnote/threadnote/actions/runs/45215269325/artifacts/14840270799)

The verified archive SHA-256 is `7742af75fb35d3d47101af303d1691c8d3b5fdb670d64a805ff7a86546bd6afc`. The first attempt's archive SHA-256 is `4bfafe96a96115a402d72309e7c9764699e80bf4d0843873ac6ff2f3eb4a839e`.
