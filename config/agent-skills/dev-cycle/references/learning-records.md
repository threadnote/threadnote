# Learning record automation

Use this only when meaningful feedback produced a lesson; routine success needs only the normal private phase handoff. `reflection.json` contains facts/evidence pointers, never raw logs or sensitive data:

```json
{
  "project": "working-area-name",
  "callerCwd": "/absolute/phase/checkout",
  "task": "Original task",
  "phaseId": "parser",
  "sourceCommit": "current commit SHA",
  "retrieved": [
    {
      "uri": "threadnote://actual/read/pointer",
      "disposition": "used",
      "check": "test_empty_record",
      "outcome": "prevented"
    }
  ],
  "lessons": [
    {
      "scope": "record parser; current format/version",
      "trigger": "An empty record reaches parseRecord",
      "cause": "First field was accessed before checking length",
      "correction": "Validate the record length before field access",
      "preventiveCheck": "tests/parser.test: empty record case",
      "failureEvidence": "phase/checks/before.json: test failed on original source tree",
      "successEvidence": "phase/checks/after.json: same test passed on corrected tree",
      "status": "verified"
    }
  ],
  "nextStep": "Recall the parser gotcha and run its prevention check before related edits"
}
```

Use `observed` until the external before/after check exists. A verified failure/correction is still scoped experience; it does not establish a universal rule. `sourceCommit` plus the evidence files must identify the tested source tree even when the fix is not committed yet. Include repository-relative current citations in the actual Threadnote write where available, following `threadnote-memory`; the script does not invent graph handles.

```sh
python3 "$SKILL_DIR/scripts/phase_state.py" learning-packet \
  --reflection "$PHASE_DIR/reflection.json" --output "$PHASE_DIR/learning-packet.json"
```

Inspect/sanitize the generated `handoff`, call `remember_context` with that JSON through MCP, then save the returned URI in `learning.memoryUris` and the phase handoff. CLI fallback is allowed only when MCP is unavailable. No output means no confirmed memory write; keep the pending packet and disclose that learning has not been persisted. A native private handoff is the automatic observation record; do not invoke durable candidate application/share tools from this script.

Before writing, recall/read an existing matching phase/gotcha record if one exists. Use its returned canonical URI as `replaceUri`, and preserve still-valid facts/relations. Record both new evidence and invalidated advice; do not silently overwrite a contradiction. `verifiedLessonIds` and `metrics` are computed by the helper. Append actual retrieval outcomes in the next relevant session so prevention/recurrence can be assessed rather than counting memory volume.

If a lesson warrants durable policy, queue its evidence during the run. At closeout use `review_session_context` with the required five-field Knowledge Delta and source evidence, then request the interactive decision defined in [closeout](closeout.md). Leave candidates unapplied until explicit approval. This optional promotion must not prevent private experience recording or otherwise complete phase implementation.

For a human project preference, optional `projectPreferences` entries contain `key`, `value`, `source` and `authority` (`explicit-user`/`confirmed-user`), plus a read `replaceUri` when updating. Review that evidence and write each generated `preferences` payload separately as private `kind: "preference"` with the exact project. `preferenceCandidates` are unconfirmed suggestions, not tool-write arguments. Preferences and experience handoffs are never the team-shared feature memory required before a substantive PR.
