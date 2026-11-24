---
name: threadnote-code-graph
description: Investigate unfamiliar local source relationships with Threadnote's code graph before broad text search.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote code graph

Use only for unfamiliar source relationships, unresolved evidence gaps, or repo instructions; exact-path/literal checks go
directly to source.

Construct local payloads once and completely: both tools require absolute `callerCwd` + `operation`; never probe empty or
partial. Examples:

- `inspect_code_graph({"callerCwd":"/abs/repo","operation":"query","query":"exclusive file lock"})`
- `analyze_code_graph({"callerCwd":"/abs/repo","operation":"stats","freshness":"allow-stale"})`

Selectors: `query` -> `query`; `node`/`neighbors` -> `nodeId`; `explain` -> `symbol` or `query`; `path` -> `from` + `to`;
`impact` normally -> `query`; analysis `community` also needs `communityId`. Correct the same payload after validation
names a missing key.

`query` discovers; `node`/`neighbors` round-trip `cgs_`/`cgr_`; `explain` expands symbols; `path` connects local `cgs_` or
qualified Workset endpoints; `impact` finds reverse dependencies; `topology` summarizes Worksets. `analyze_code_graph`
supports `stats`, `communities`, `community`, `groups`, `hubs`, `surprises`, `confidence`, and `full`. Verify exact source.

Freshness defaults to `current`. `ready` can use stale evidence or refresh. `allow-stale` never indexes.
A missing graph returns `no-ready-snapshot`.
Use current evidence for exact path, impact, or citation claims. Follow recovery guidance. Avoid rapid checks.

For local `inspect_code_graph`, omit `responseFormat` for schema-aware text-only `agent` output; budgets apply after
formatting/truncation. Analysis is bounded text. Worksets lack agent projection and default to lossless JSON; request `dual`
for canonical structured content and inspect older schemas (`text`/`dual`).

For Mermaid, set `output: "mermaid"` on a local query. Follow any resource instructions.

`context_brief.codeRefs` accept repository-relative POSIX paths or lowercase `cgs_<32 hex>` IDs, not `cgr_`. Follow retained
selectors when truncated; bounded cards cannot prove absence. During indexing verify stale/deferred evidence against source;
retry strict current/relationship claims or unusable cards.

Preserve the Context Brief `project` selector and `projectCoverage`. Project graphs cover configured roots, forward dependencies, and explicit
includes, not repository-wide absence. For `outside-project-graph`, partial coverage, or ambiguity, follow returned actions;
never guess, silently widen, or force a full rebuild.

For fresher Workset evidence run `threadnote workset prepare <name>`. If unavailable, disclose and search narrowly. Skip
graph for remote reviews without a checkout or binary/visual evidence. Carry consequential graph anchors into the memory
handoff.

<!-- END THREADNOTE USER INSTRUCTIONS -->
