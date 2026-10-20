# Structured spec and persistence contract

Use `init` for the exact JSON shape. Python 3.10+ on POSIX or native Windows, Git/rg for inspection and the installed Threadnote CLI support the satellites. Use MCP for semantic recall/graph navigation. No network model call or package installation is hidden in a satellite.

| Field                                                  | Meaning                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`, `id`, `project`, `title`, `objective` | Version 1; stable feature slug and identity shared by all three skills                                                                                 |
| `callerCwd`, `focus`, `scope`                          | Absolute checkout; behavioral focus; `inspect` result with existing paths and file hashes. Null scope is allowed for genuinely source-free work        |
| `observations`                                         | Verified facts about current behavior, with concise source provenance                                                                                  |
| `actors`, `inScope`, `outOfScope`, `constraints`       | String arrays; actors and in-scope outcomes are required                                                                                               |
| `requirements`                                         | `{id, behavior, priority: must/should/could, change: added/modified/removed/preserved}`; modified/removed also require `previousBehavior` and `reason` |
| `scenarios`                                            | `{id, requirementIds, given, when, then}`; every requirement must have observable acceptance                                                           |
| `assumptions`                                          | `{statement, basis, authority: user/evidence/agent}`; consequential unconfirmed assumptions become questions                                           |
| `questions`                                            | `{id, question, impact, disposition: open/deferred-to-plan}`; only implementation questions may be deferred                                            |
| `artifacts`                                            | Adaptive connected artifacts; omit irrelevant kinds                                                                                                    |
| `recall`                                               | `{queries: [...], sources: [{uri, sha256, usedFor}]}`; record a scoped no-match query too                                                              |
| `contextRefs`, `contextNote`, `codeRefs`               | Per-artifact relevant memory URIs, no-match explanation and up to eight existing native graph anchors                                                  |
| `review`                                               | `{required: boolean, reason}`; explicit complexity classification                                                                                      |

IDs are stable, unique and alphanumeric with hyphens/underscores. Feature IDs are lowercase slugs. Preserve requirement/scenario IDs when revising the same obligation. Native symbol handles need `codeRefPaths: {handle: inspectedPath}`. Proposed components never receive invented graph handles.

An optional artifact:

```json
{
  "id": "reservation-state",
  "kind": "workflow",
  "title": "Reservation lifecycle",
  "summary": "A reservation can be confirmed once or expire.",
  "requirementIds": ["R1"],
  "diagram": "stateDiagram-v2\n  Pending --> Confirmed: confirm\n  Pending --> Expired: deadline",
  "sections": [{"title": "Invariants", "items": ["Confirmed and expired are mutually exclusive."]}],
  "contextRefs": [],
  "contextNote": "Scoped recall returned no applicable prior decision.",
  "codeRefs": []
}
```

Kinds: `domain`, `workflow`, `contract`, `capability`. Domain/workflow require raw Mermaid without fences. Domain sections typically describe identity, relationships and invariants; contract sections describe observable inputs/outputs, errors, compatibility and ownership. Capture nonfunctional requirements as testable obligations only when relevant and supported by user/source evidence.

## Ready and revision semantics

`validate` checks structure, coverage, links and source freshness. `validate --ready --confirmation FILE [--review FILE]` additionally checks no open behavioral questions, current user confirmation and current substantial-review outcome. It does not prove semantics. `acceptance-packet` includes full spec, concise summary, `specHash` and `intentHash`. Show material domain/workflow/contract decisions along with the summary; use `render` for their previews. `confirm` records an actual user response against the packet's intent hash, never generates approval.

Semantic changes to requirements, scenarios, optional artifact content, constraints or assumptions invalidate confirmation. Refreshing scope, observations, graph anchors or recall evidence does not. Full spec changes invalidate an independent review. `diff --before FILE --after FILE` reports ID changes and whether intent needs confirmation. Keep latest root URI in the private handoff so subsequent sessions resume the intended revision; old immutable roots are history, not permission to ignore newer user intent.

```sh
python3 "$SPEC_DIR/scripts/dev_spec.py" load --root "$SPEC_URI" --out "$RUN/spec.json" --state "$RUN/receipts.json"
python3 "$SPEC_DIR/scripts/dev_spec.py" review-packet --spec "$RUN/spec.json" --out "$RUN/review-input.json"
python3 "$SPEC_DIR/scripts/dev_spec.py" save --spec "$RUN/spec.json" --state "$RUN/receipts.json" --draft
```

Resume also reads the saved root's confirmation/review data when reusing unchanged decisions; `load` restores spec and receipts, not separate approval files. Draft persistence permits unresolved decisions but still requires meaningful requirements/scenarios, scope provenance, recall and review classification. Local incomplete drafts need not be persisted as ready memories.

## Threadnote mechanics

Each artifact links directly to its relevant read-and-pinned prior memories. Native relations are limited to 16 per memory, code anchors to eight. Reserve one relation for final implemented architecture. Root child links consume relation capacity; narrow an oversized feature rather than dropping meaningful provenance. The dev-plan importer accepts at most thirteen upstream artifact memories (root included) to leave room for planning relations. Save uses private handoff memories, immutable child versions, child-first/root-last writes and exact readback. No local preview overrides Threadnote.

Receipts record run ownership, hashes, destinations and retired URI maps. Keep them until closeout completes. Writes preflight the exact destination and journal its previous content, allowing safe retry after a lost response. `--recover-uri` supplies a native returned URI when an interrupted operation relocated the resource. A concurrent edit blocks reconciliation. Do not delete receipts to bypass a failed transaction. Source and memory drift require inspection, reconciliation and regenerated packets.

The structured payload is embedded with a version marker; the human-readable body must match it. Edit through `load` and `save`. Normalized native envelopes and the known archived-body prefix do not change payload identity. Current citations are strict on ready/verified output; deferred citations remain draft-only. Graph maintenance uses the installed Threadnote workflow, never fake hashes.

At closeout the coordinator creates verified durable behavior/domain artifacts, binds current code and links implemented architecture, then archives only owned drafts/history. Native relations target active memories; archived history uses body links and URI maps. Verification preserves approved intent; deviations must be resolved or explicitly agreed before completion. Optional general lessons/policy promotion retain their separate approval path.
