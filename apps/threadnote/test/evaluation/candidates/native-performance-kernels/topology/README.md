# Typed DSU storage experiment: defer shipping

The existing topology implementation already assigns dense numeric node indices and uses numeric, path-compressed union-by-rank sets. This experiment replaced only the two DSUs' parent/rank `number[]` storage with geometrically grown `Uint32Array`/`Uint8Array`, starting at16 retained nodes. It did not change root tie-breaking, iteration/checkpoints, string-ID lookup Maps, degree counters, edge streaming, budgets or presentation.

**The runtime experiment was reverted. Current TypeScript remains the baseline.** A small model-only timing difference does not establish a worthwhile full-operation or allocation improvement. No native topology implementation or performance qualification is implied.

## Observed first case

Base source is `2d7a73c71a866a6bd86f227bef1f73831ab39b46`, including merged Bun crypto. [Experimental patch](typed-dsu-experiment.patch) exactly matches captured diff SHA256 `2487b90a049b733044dc16afca1a5374f51fbe05fad865bd704cd7315423e965`. The candidate was deliberately uncommitted; its source/diff/script hashes were unchanged across the diagnostic. This is not clean-source qualification evidence.

The existing scaling model supplies20k nodes/30k edges with257-row pages through `pagedAnalysisStore`. Fixture construction and fake-store sorting, followed by explicit GC, occurred outside each algorithm clock. A20-node setup case first passed exact output parity. Two serial pairs then counterbalanced order in one process:

| Pair | Order               | Baseline ms | Typed DSU ms |
| ---- | ------------------- | ----------: | -----------: |
| 1    | baseline, candidate |  237.762334 |   221.342917 |
| 2    | candidate, baseline |  205.010625 |   187.753208 |

Every call completed with exactly matching full output digest `955c3377aa329a5463c3db53c0e5c705fbb4be7e6296bf0c40830472f662df75` after excluding only reported duration. Page/row/visit counts also matched. [Raw bounded observations](typed-dsu-first-pairs.json) retain both pairs, source/fixture identities and pointwise memory samples without trimming.

The observed model timing difference was about6.9–8.4%, with substantial first/second-call variation. Two pairs cannot separate JIT, order and allocator effects or establish a p95 gate. Pointwise heap deltas were approximately64.6/67.4/65.3/66.1MB in execution order; external-memory deltas were0.25/0.90/0.87/0.10MB. They show no clear allocation win and are neither allocated-byte volume nor peak/process-tree RSS. No SQL, canonical database writer, lease, CLI or model inference was exercised.

Focused validation of the exact prototype passed:

```sh
bun --bun vitest run packages/graph/test/unit/code-graph.analysis.property.test.ts packages/graph/test/unit/code-graph.analysis.scaling.test.ts
```

Three tests passed, including the existing independent BFS/permutation/page-size and bounded-coverage properties plus20k-node scaling case. No full suite, global installation or new production test hook was used.

## Decision boundary

P1's real180914-node operation took about10.5–11.3s, including7.7–8.4s of loader spans and a2.75–2.86s mixed computation/control residual. That residual is not pure DSU work. This model does not attribute it or justify extrapolating a full-boundary improvement. Keep the current implementation until representative whole-operation evidence demonstrates a worthwhile gain; retain the original exact-parity,20% primary p95, secondary/noise and process-tree RSS gates for any later native adoption. This is a bounded negative shipping decision, not a measured Rust failure or completed qualifying pilot.
