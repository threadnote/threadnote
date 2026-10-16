# Maintained topic memories: implementation tracker

This tracks [RFC #756](https://github.com/threadnote/threadnote/issues/756) against
the [connected implementation plan](https://github.com/Kashkovsky/threadnote-share/blob/main/durable/projects/threadnote/rfc-756-implementation-plan.md).
Supporting issues #752–#755 are resolved foundations. The initial experiment
maintains one existing code-backed durable topic through the existing review and
publication workflow.

| Phase | Scope                                                                | Status                         | Completion evidence                                                                           |
| ----- | -------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| 1     | Enrollment, exact paragraph support, declared dependencies, baseline | Local verification in progress | Memory contracts, enrollment CLI, regression/property tests, synthetic Context Health fixture |
| 2     | Resumable change routing and bounded old/new evidence packets        | Pending                        | Relevant/no-op/unknown routing, restart and finite catch-up                                   |
| 3     | Selected-model synthesis and deterministic draft validation          | Pending                        | Supported focused edits, preservation, explicit failure/no-change outcomes                    |
| 4     | Candidate review, evidence fences, metadata preservation, recovery   | Pending                        | Public-entrypoint race/fault tests and shared proposal boundary                               |
| 5     | Manager, CLI/MCP parity and accepted-only Context Brief              | Pending                        | Complete review loop and reuse from another surface                                           |
| 6     | Longitudinal comparison and rollout decision                         | Pending                        | Correctness, traceability, reviewer effort and total cost versus manual maintenance           |
| 7     | Imported evidence and wider dependency coverage                      | Gated                          | Phase 6 go decision; reuse #755 retention/access contracts                                    |

Each phase is reviewed and verified before merge. Tests begin with the contracts;
evaluation begins in Phase 1 rather than after product implementation. No phase
completion implies proof of every engineering claim or automatic publication.

## Phase 1 contract

Enrollment adds a versioned `topic_maintenance` header to an existing active
personal durable memory. The body, identity, citations, relations, authority,
owner and other metadata remain intact. The header binds every paragraph by
ordinal and content hash, including duplicate paragraphs, and records its
descriptive/normative/historical role and explicit direct/contextual/unresolved
support. Scope and validity annotations are author supplied.

Dependencies refer to existing exact code citation IDs. Configuration or called
code can be declared explicitly. Coverage is always `declared-only`; neither
enrollment nor a complete citation scan discovers every relevant dependency.
The pilot accepts one repository with at most eight clean retained citations,
64 paragraphs and 32 KiB of manifest data. Bounds reject instead of truncate.

Canonical memory schema 9 protects the new header. Schemas 5–8 migrate without
discarding existing structured provenance. Malformed or body-stale manifests
remain visible and prevent precise freshness claims and unsafe rewrites. Until
reviewed topic updates are implemented in Phase 4, generic replacements cannot
change an enrolled body, manifest, or citations. Metadata-only edits preserve
the enrollment.

## Enrollment CLI

First inspect an existing memory and its citation IDs:

```sh
threadnote context topic inspect --uri tn_topic --json
```

Write a JSON input file outside the supporting Git worktree. Include one
decision for every blank-line-delimited paragraph, including headings:

```json
{
  "paragraphs": [
    {"role": "descriptive", "support": "direct", "citationIds": ["tncc_<citation ID from inspect>"]},
    {"role": "normative", "support": "unresolved", "citationIds": []}
  ],
  "additionalDependencies": [{"kind": "configuration", "citationId": "tncc_<configuration citation ID>"}]
}
```

Preview is read-only for accepted memory. It requires a clean committed
repository, exact-current citation evidence and recoverable historical support.
It never starts indexing; prepare the existing graph explicitly when needed.

```sh
threadnote context topic preview --uri tn_topic --cwd /path/to/repo --input /path/to/support.json --json
threadnote context topic enroll --uri tn_topic --cwd /path/to/repo --input /path/to/support.json --content-hash <preview hash> --revision <preview revision> --approved --json
```

Approval binds the target content, final support decisions and observed source
revision. A changed target, source or input requires another preview. Repeating
the same successful enrollment leaves the record unchanged. A source change
during the write reports a conflict after storing enrollment; inspect its
freshness before use. Enrollment does not rewrite the accepted explanation.

## Reproducible baseline

`apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/baseline.json`
contains the initial source bytes, five-paragraph accepted explanation, exact
support mapping, explicit configuration dependency, one source change and probe
questions. Its values describe a synthetic fixture rather than production
Threadnote timeouts. The application enrollment tests materialize and commit
those sources, capture real citations, then exercise the native store and graph.

The manual arm reads the accepted memory and old/new code, edits only the
current-behavior paragraph through today's remember workflow, and checks every
probe. The historical timeout and unrelated paragraphs stay unchanged. Record
CLI latency separately from reviewer time; reviewer time is unknown until
measured with a human. An isolated manual run on installed 5.2.1 preserved stable identity, historical
support and unrelated paragraphs. Six measured CLI operations took 1.716 seconds;
this excludes source/index setup and unmeasured human review. It establishes a
reproducible comparison arm, not a product improvement claim.

The same fixture and probes feed the later synthesis
comparison, including old-knowledge retention.

## Boundaries for subsequent phases

Change notifications are hints; exact source revisions establish evidence.
Models propose focused drafts and cannot assign authority or mutate canonical
memory. Revalidation without prose changes requires evidence review. Candidate
approval must cover final edited content and metadata, with source checks and
recoverable application state. Shared updates reuse existing Git review policy.

Phase 7 requires a measured go decision from Phase 6. Imported-source retention
already exists; its maintenance adapter must preserve current access receipts,
historical/current distinctions and bounded retention. New source discovery and
arbitrary transitive graph coverage are separate extensions.
