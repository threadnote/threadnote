# Native bootstrap

Run `threadnote workflow-automation` in the absolute checkout root. Send one JSON request on stdin; parse its JSON response. Keep request bodies in temporary files or use the host's stdin API. Do not put documents into shell arguments.

## Discover and bind

Check the installed runtime:

```json
{"protocolVersion": 1, "executorVersion": 1, "action": "capabilities"}
```

Fetch only the next decoding envelope; no run is needed for discovery:

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

`schemaPage.text` contains JSON text. Continue with `offsetBytes: schemaPage.nextOffsetBytes` and the same `sourceDigest`, topic and command until the offset is null. Assemble pages only when the whole schema is needed. Runtime refinements, command prerequisites and approval checks remain authoritative.

Initialize once using the digest of this skill's immutable bundle directory as `generation`. Keep the same run ID, generation, profile, project, feature and checkout on resume:

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

Use the configured `codex-cloud-personal` or `cursor-cloud-personal` profile and team for personal cloud tasks. Inspect an existing run instead of initializing a replacement. Failed identity or capability checks require repair, not a new run.

## Author and verify

For run actions, repeat `protocolVersion`, `executorVersion`, `runId` and `generation`. Set `action` and `command` from the requested schema.

1. Before unfamiliar graph discovery, call `action: graph-ready` and consume its current ready receipt. Exact known path/literal reads need no graph. Stale or partial evidence cannot justify broad discovery.
2. Request `topic: authoring-document` with `kind: spec` or `plan`; other payload topics are `cycle-plan`, `cycle-validation`, `cycle-review` and `closeout-proposal`. Build requirements, scenarios or plan phases from verified evidence. Use `authoring validate`, then `save` with `ready: false`, the complete `document` and `expectedRevision: null` for the first save. On update, use the current root revision. Recover the same interrupted operation; do not erase receipts.
3. Read the returned root URI with `authoring load` for the summary. Use `authoring read` with `artifactId` for an outline, then `detail: section` and `sectionId` for required content. Continue digest-checked pages. Verify required children and rationale before claiming durability. Load `detail: document` only when an export or revision needs the full document.
4. For specs, present `acceptance-packet`, record the actual human response through `confirm`, and pass its confirmation into the ready save. For plans, retain exact user approval and any required independent review. A draft, silence or a clean review is not approval.
5. Export a ready spec with `export-plan`; planning uses `from-spec` with that exact packet. Export the ready plan with `export-dev-cycle`, explicit delivery mode and phase branch/base bindings.

## Implement, watch and close out

Use bounded cycle packets and exact snapshot review/validation. CAS mutations use the current cycle revision. Record the phase's accepted delivery and owned watch before starting the next eligible phase; pending CI or merge alone does not stop implementation.

Watch requests use `watchId` and a leased `consumerId`, not a run envelope. Start one collector, attach the supported current-chat wakeup, relay and inspect evidence. Persist every disposition before ACK; keep unresolved work in `work`, update it through `work-disposition`, and stop/record terminal collectors.

After all phases and current combined-source acceptance, use closeout `validation-input`, `prepare` and `finish`. Read every durable output independently before owned drafts retire. Personal cloud closeout requires exact `publication-preview` approval and verified Git readback; task-local drafts alone are not cloud durability.
