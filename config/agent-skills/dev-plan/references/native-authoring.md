# Native authoring

Start a new run, or resume with its original run ID and pinned generation. Send JSON on stdin to `threadnote workflow-automation`. Require `authoringVersion: 1` from `capabilities`, then initialize feature/project/title, generation and profile.

Authoring requests include `protocolVersion: 1`, `executorVersion: 1`, `action: "authoring"`, `runId`, `generation` and `command`.

## Ground and construct

- `schema`: obtain document shapes and versioned templates. Keep structured data authoritative; omit empty optional sections.
- `graph-ready`: prepare the same checkout before unfamiliar discovery. `scope-inspect` verifies readiness and reads explicit existing paths. Use `literalOnly: true` for known paths/literals. Retry stale/busy evidence within bounds; disclose genuine unavailability.
- `pin`: read an admitted URI and retain its exact identity/revision.
- Specs preserve requirement/scenario IDs and actual human confirmation. Plans preserve current/target architecture, dependencies, acceptance and design decisions.
- `from-spec`: verify a ready native spec export and carry its approved requirements/scenarios into the supplied plan draft.

## Save before approval or pauses

Use `save` with `document`, `ready: false`, and `expectedRevision: null` initially. Later saves include root URI and exact revision. Desktop roots/children are private durable memories. Personal Codex/Cursor cloud drafts remain task-local and can be lost with the workspace.

After a human response, save the changed intent in the same turn. Spec `confirm` requires actual `userResponse` and `userDecision: "approve" | "reject" | "defer"`; reject/defer grants no approval.

Ready specs need matching approval. Substantial documents need accepted review of their exact hash. Open questions or missing plan decisions block readiness. A ready request blocked only by readiness gates still saves a draft and returns blockers. Report actual readiness. Resolve structural, source or ownership errors before saving.

Writes are child-first/root-last with exact revision checks and readback. Retry the same save, or `recover` with original inputs. `load` does not recover implicitly. Preserve the original run, binding and receipts.

## Consider alternatives

For competing designs or consequential uncertainty, use `challenge-packet` and one independent reviewer. Request at most two high-level alternatives, tradeoffs and code evidence—not another plan. Routine settled work may record `designRisk: "routine"` with a skip reason.

The orchestrator records stable decision IDs, selected approach, alternatives, rationale and affected phases, then saves. An adopted change updates target/phases and affected review.

## Read and hand off

- `load`, review and acceptance packets are compact. Request `detail: "document"` only when needed.
- `read`: outline first, then a section by `sectionId`, byte cursor and source digest. Read one decision using `artifactId: "decisions"` and `decisionId`.
- Full structured source/history stays linked behind compact views.
- `export-plan`, `export-dev-cycle` and `closeout-input` require a ready root and preserve spec IDs, bindings, acceptance mappings and closeout obligations. Supply authorized branch/delivery choices. Export grants no implementation/publication authority.
