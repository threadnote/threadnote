# Native migration evidence for Threadnote 6.0.0

The release comparison starts at `212b1afa5f5564fceebb06de8d16b52e9ae421b2` on
`6.0.0`. It already includes the Rust recall reader, bounded native fact inflate,
and the subsequent fact validation and base64 improvements. The graph captures in
this directory measure where further work might help. A candidate needs its own
paired comparison before it can qualify.

## Phases

1. Measure the current release source. Use the generated 3,000-source,
   110,000-symbol profile and distinguish first use from warm samples. Record
   the observed stages, their scope, and the run-to-run spread. Treat source-mode
   diagnostics as baseline evidence. Governed release evidence requires its
   separately verified runtime and runner.
2. Use the existing decoder as the fact-replay baseline. [PR 1079] introduced
   bounded `node:zlib` inflate and added the v2 checkpoint compression profile.
   It retains v1 artifact reproduction and the logical digest. [PR 1094] removed
   repeated validation and base64 work. Both changes are ancestors of the
   release head.
3. Qualify the already-shipped [PR 1049] recall reader against the frozen TS66
   executable. Both Darwin profiles in the [first capture workflow run] hit
   the same setup failure. TS66 expects a v13 lexical index and the fixture
   only built v15. The run stopped before paired measurement. Build both
   schemas over the same canonical corpus, then rerun the matrix. A measured
   failure invokes the rollback decision in the original plan, with rollback
   scoped separately.
4. Use the evidence to decide which graph candidates merit an experiment.
   Require all eight recall profiles to qualify before expanding native vector
   scoring to graph search. Require stage attribution before proposing any
   other native graph work. Each eligible experiment needs an explicit
   read-only boundary, package ownership, and eight-profile payload plan.

## Measured baseline

[decision.json] records the source and fixture identities, first use, warm
spread, CPU observations, and measurement boundaries. The reduced fixture
produced 111,794 symbols from 3,000 source files. The forced-cached index
spent 2.295 s loading cached facts and 11.434 s in reference resolution.
The 2.611 s matching span included SQLite lookup and TypeScript work.

The separate production decoder took 1.257 s median for 4,926 rows. In
the instrumented arm, validation was the largest measured stage at 458 ms
and bounded inflate took 186 ms. Topology analysis took 5.679 s median
without instrumentation. The observed loader union included paging and
row decoding and accounted for a median 62.5% of the analysis body.

Synthetic graph vector requests took 186 ms at 10,000 vectors and 1.782 s
at 100,000 vectors, using warm uninstrumented medians. The largest share of
the instrumented request was outside SQLite spans. That residual combines
vector decoding, validation, scoring, merging, and runtime control. The
captures used injected query vectors and synthetic 768-dimensional rows.

[p4-decisions.json] defers all four graph candidates on the current evidence.

## Adoption gates

Use exact result parity and allow at most 10% sampled process-tree peak RSS
growth. Request-path comparisons need three alternating pairs of 30 warm
requests per arm, at least 20% primary p95 improvement, and no secondary p95
regression larger than the greater of 5 ms and 5%. Report first use separately.
Index-stage comparisons need at least five alternating pairs, at least 20%
median stage-wall improvement, and an improvement greater than the observed
baseline spread.

For a future native experiment, keep policy, authorization, writes, freshness,
deadlines, and cancellation in TypeScript. Cross the Bun/Rust boundary once
per read-only transaction or batch. Embedding inference, hashing, file walking,
lexical SQL, SQLite writes, memory links, Context Brief citations, and parsing
stay outside this candidate set.

[PR 1049]: https://github.com/threadnote/threadnote/pull/1049
[PR 1079]: https://github.com/threadnote/threadnote/pull/1079
[PR 1094]: https://github.com/threadnote/threadnote/pull/1094
[first capture workflow run]: https://github.com/threadnote/threadnote/actions/runs/45013759793
[decision.json]: decision.json
[p4-decisions.json]: p4-decisions.json
