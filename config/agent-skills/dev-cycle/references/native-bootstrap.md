# Workflow bootstrap

Run `threadnote workflow-automation` from the absolute checkout root. Send JSON on stdin using a temporary file or host stdin API; parse the JSON response. Keep documents out of shell arguments.

## Discover and bind

Check capabilities:

```json
{"protocolVersion": 1, "executorVersion": 1, "action": "capabilities"}
```

Discover only the next command's schema and `semanticPrerequisites`; no run is needed:

```json
{
  "protocolVersion": 1,
  "executorVersion": 1,
  "action": "request-schema",
  "topic": "authoring",
  "command": "save",
  "maxBytes": 4096
}
```

`schemaPage.text` is JSON. Continue with `offsetBytes: schemaPage.nextOffsetBytes` and the same `sourceDigest`, topic and command until null; assemble only when needed. Decoding envelopes and bounded prerequisites do not replace runtime admission or approval checks.

Initialize once with this immutable bundle's digest as `generation`; preserve run ID, generation, profile, project, feature and checkout on resume:

```json
{
  "protocolVersion": 1,
  "executorVersion": 1,
  "action": "init",
  "runId": "feature-run",
  "project": "project-id",
  "featureId": "feature-id",
  "generation": "<bundle digest>",
  "profile": "desktop"
}
```

Personal cloud tasks use the configured `codex-cloud-personal` or `cursor-cloud-personal` profile and team. Inspect existing runs; repair identity or capability failures without replacing the run.

## Author and verify

Repeat `protocolVersion`, `executorVersion`, `runId` and `generation`; use the discovered `action` and `command`.

1. Before unfamiliar discovery, consume a current `graph-ready` receipt. Exact path/literal reads may skip graph; stale or partial evidence cannot justify broad discovery.
2. Discover `authoring-document` with `kind: spec` or `plan` only when needed. Build from verified evidence. Run `authoring validate`, then `save` with the complete `document`, `ready: false` and initially `expectedRevision: null`; updates use the current root revision. Recover interrupted operations without erasing receipts.
3. `authoring load` reads the returned root summary. Read an artifact's outline with `authoring read` and `artifactId`, then required `detail: section`/`sectionId` pages with digest checks. Verify children and rationale before claiming durability. Full `detail: document` is only for export or revision.
4. Specs require `acceptance-packet`, the actual human response via `confirm`, and that confirmation in the ready save. Plans retain exact user approval and required independent review. Drafts, silence and clean review are not approval.
5. Export ready specs with `export-plan`; `from-spec` consumes that exact packet. Ready plans use `export-dev-cycle` with delivery mode and phase branch/base bindings.

## Implement, watch and close out

Use bounded packets and exact snapshot review/validation. Get CAS `expectedRevision` from `cycle inspect`, including before `cycle init`. Discover the next cycle command's prerequisites for snapshot/attempt IDs and detail budgets; retrieve `cycle-plan`, `cycle-validation` or `cycle-review` payload schemas only as needed. Preserve rejected attempts. Record accepted delivery and owned watch before continuing the next eligible phase; pending CI or merge alone does not stop implementation.

Watch uses `watchId` and leased `consumerId`, not a run envelope. Own one collector and a verified event-driven host wakeup; relay and inspect evidence. Idle polling and subscription maintenance run in the runtime, without recurring model tasks. Persist dispositions before ACK. Keep unresolved `work`, update via `work-disposition`, and stop/record terminal collectors.

After all phases and current combined-source acceptance, discover `closeout-proposal` as needed and use `validation-input`, `prepare`, `finish`. Independently read every durable output before retiring owned drafts. Personal cloud requires exact `publication-preview` approval and verified Git readback; task-local drafts are not cloud durability.
