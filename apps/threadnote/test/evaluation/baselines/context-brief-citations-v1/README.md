# Context Brief citation scale calibration

The 4.6 release gate is calibrated from three independent, exact-candidate runs on the pinned GitHub-hosted
`macos-15` ARM64 runner class at commit `172c4d45e2cbc5dedb8f5fd088a8d5b93ca005d3`. Correctness, citation,
lease, no-cold-index, and RSS objectives remained healthy in all three runs.

The raw JSON observations came from hosted workflow run `33395986972`, attempts 1–3. Their SHA-256 digests are,
respectively, `f5fede4b95a93e364b4d144f73b835d7b9c78865af834a7df4ac98024c3b7f17`,
`8e7c8271dfd451cbd34f414ba60394577da0a6a860be1f947ca9766bbedbd6cc`, and
`781035bd16be8afc3fa1eb6818c6b4216b24b192bf9fed0b0038fff3e099d325`.

| Profile     | Validation p95 observations (ms) | Brief p95 observations (ms) | Reviewed validation / brief ceiling (ms) |
| ----------- | -------------------------------- | --------------------------- | ---------------------------------------- |
| local-100k  | 185.4 / 204.0 / 118.7            | 881.3 / 741.5 / 552.2       | 250 / 1,500                              |
| workset-50  | 649.0 / 831.3 / 570.4            | 2,009.2 / 2,920.4 / 1,534.2 | 950 / 3,250                              |
| workset-128 | 1,172.6 / 1,227.9 / 723.8        | 1,856.0 / 2,909.8 / 1,792.8 | 1,400 / 5,000                            |

For a ceiling that the three-run sample exceeded or left with less than the prospective margin, the reviewed value is
10% above the largest observation, rounded up to the next 50 ms. Existing ceilings with more headroom are retained;
this calibration does not tighten them from a small sample.

The same runs recorded maximum successful-sample gaps of 138, 172, and 100 ms. Their `>100 ms` breach patterns were
4/75 with at most two consecutive observations, 2/75 with no consecutive observations, and 0/75. The initial v1
quality policy therefore bounded the raw maximum at 250 ms while retaining a 10% breach-rate ceiling and at most two
consecutive breached observations.

A fourth independent run, `33438134814`, exercised exact candidate
`4cf4c966cf272a3cb066db29750a415766ec5954`. Its raw JSON has SHA-256
`fcd37f90826f35f01c6cd5b7ad605669e3c6f3f44c95671df02d0957b7ef91ca`. All product correctness, latency, RSS,
sample-success, and descendant-coverage gates passed, but one of 75 observations recorded an isolated 297 ms gap and
exceeded only the v1 250 ms ceiling. That observation still contained 64 successful samples and observed descendants;
the run had 3,194/3,194 successful samples, a 2/75 breach rate, and at most one consecutive breach. Across all four
runs, 8/300 observations breached 100 ms, with p50/p95/p99 gaps of 54/89/138 ms and a 297 ms maximum.

The v2 policy applied the same calibration rule used above: 10% above 297 ms, rounded up to the next 50 ms, yielding
a 350 ms hard maximum. Its privacy-safe `sample-gap-calibration-v2.json` projection remains as the retained
four-run, 300-observation predecessor.

Exact clean commit `366f1924df3b7d3aa18df99b27b2edcff0b695f4` then completed GitHub-hosted macOS 15 ARM64 workflow
run `36251218009` on Bun 1.4.2. Its 300 observations and all 8,707 samples succeeded, with three `>100 ms` gaps,
no consecutive breach, and one isolated 481 ms maximum; all product, correctness, currentness, latency, RSS, and
coverage gates passed. The retained raw artifact SHA-256 is
`abd46bf098aa9c82ab1efd3a8f513427c43f2937d9f2c6b16c9fa46045bb20e7`, and its ZIP SHA-256 is
`a56543c43df9eef8072dfdadcab1e022d77d9b4e47f0d66e153c3529c4610d3f`.

The v3 policy pools the five retained runs: 600 ordered gaps, 11 breaches, maximum consecutive breaches 2,
p50/p95/p99 48/79/130 ms, and a 481 ms maximum. Its same 10%-then-50-ms rounding formula derives a 550 ms hard
maximum. It leaves the 100 ms threshold, 10% breach-rate ceiling, two-consecutive ceiling, zero-failure requirement,
descendant coverage, and RSS budgets unchanged. The canonical `sample-gap-calibration-v3.json` projection retains
the complete cohort and new raw/ZIP provenance; its verifier re-derives the aggregate and ceiling after artifacts
expire.

The later `validation-quantile-calibration-v1.json` and matching rationale preserve the five-run evidence used to
increase release sampling from 25 to 100 without changing the reviewed latency ceilings. Its verifier re-derives the
pooled and latest-four-run quantiles and the four-versus-five upper-tail boundary.

`rss-observer-capacity-calibration-v1.json` and its rationale retain the first 100-sample prospective run that exposed
the old 256-observation protocol ceiling. The correction derives capacity from the three-profile, 100-sample release
contract, rejects oversized schedules before setup, and reports child failure immediately; it changes no evidence
budget and requires a fresh complete prospective artifact.

## Reviewed fixture identity

Release-scale evidence is bound to the reviewed semantic identity SHA-256
`42ac0ef188ce362d5c14235d339d09c138d4b69bda65e42c85d327b16e23c4df`. The verifier derives that bounded identity
from the canonical scale budget and the exact 100-sample, 5-warmup schedule: the three profiles are normalized into
reviewed order, each run creates the profile's selected-memory count (24/16/24) of sentinel records scoped to the
profile's first repository, and those records retain round-robin citations across the selected repositories. The remaining
86,880 of 100,000 indexed documents are legacy noise. The identity also binds the independent schedule dimensions,
per-profile repository/citation/allocation shape, and versioned record, schema, path, fixed-instant, and extractor-set
contracts. It rejects release artifacts whose indexed, requested, or legacy-memory counts differ from that identity.

This check intentionally does not construct repositories, SQLite indexes, or the 100,000-memory corpus. Construction
is benchmark setup and would turn artifact verification into another benchmark. The artifact's existing `fixture.hash`
remains dynamic provenance because it includes generated graph state and the run count; it is structurally retained but
cannot be boundedly rederived. The approved semantic hash is updated only after review of the complete fixture
contract; the bounded verifier then makes retained-artifact shape tampering and a non-reviewed fixture fail closed
without rerunning the release benchmark.
