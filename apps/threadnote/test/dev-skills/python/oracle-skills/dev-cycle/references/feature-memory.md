# Team feature memory before PR creation

Apply to substantive features, new workflows/interfaces and meaningful multi-phase behavior. Small localized bug fixes/maintenance may skip with a concrete reason. Do not create a detailed feature document just to satisfy a checkbox for a one-line fix. Conversely, a feature cannot be relabeled a small fix to bypass sharing.

Before the first/each new phase PR (including draft), prepare or update detailed feature memory: user problem and behavior, architecture/interfaces, important invariants/edge cases, phase/dependency and safe rollout boundaries, actual validation/manual fixture steps, current implementation state and remaining planned work. Label implemented/verified versus planned explicitly; phase 1 does not prove phase 2. Cite current source commits and relevant plan memories. Keep private preferences, handoffs, customer data, secrets and raw logs out of the shared feature record.

Determine the relevant team from verified repo/project ownership and existing shared plan/context. Never default to every team or guess an audience. Use `threadnote-memory` for durable creation/promotion and sharing. Honor existing explicit authorization for this feature/team. If a new approval is needed, finish implementation/validation and prepare the exact memory/audience preview, then queue the decision for [interactive closeout](closeout.md). Hold PR creation until required approval/publication succeeds; other eligible work may continue. Explain the exact skill requirement when confirmation is necessary; do not ask again for existing authorization.

`share_publish(preview=true, team=..., uri=...)` can preview a personal durable. Real publication needs the actual non-preview publish/push result, followed by reading the returned shared memory to verify team/content/revision. Do not publish handoffs/preferences or treat an unapplied Knowledge Delta as shared. Preserve the five-field review approval flow where applicable. The tool may move/remove the personal source after publishing: update plan/feature pointers to the returned canonical shared URI, re-read it and refresh any affected pins. Never keep relying on a vanished private URI.

Record this `featureMemory` object in `plan.json`:

```json
{
  "required": true,
  "reason": "Substantive parser feature",
  "team": "verified-team",
  "uri": "threadnote://actual/shared/feature-memory",
  "revision": "hash/version of canonical shared content",
  "receipt": {
    "status": "published",
    "team": "verified-team",
    "uri": "threadnote://actual/shared/feature-memory",
    "revision": "same current content revision",
    "sourceCommit": "validated phase headSha",
    "remoteCommit": "actual team publication commit/receipt"
  }
}
```

An exempt record instead has `required: false`, `classification: "small-fix"` (or `"maintenance"`) and a concrete `reason`. Ensure the phase is validated, commit/head is recorded and the plan's `delivery` is `pr`, then:

```sh
python3 "$SKILL_DIR/scripts/phase_state.py" publication-ready \
  --plan "$RUN_DIR/plan.json" --phase "$PHASE_ID"
```

The helper rejects missing, draft, wrong-team, stale-revision or wrong-head receipts and unexplained feature exemptions. It checks the ledger, not the remote service: the orchestrator must retain/verify the real MCP result and shared read; never fabricate a receipt. Pending sharing blocks opening the PR, not other eligible development. Existing PR follow-up fixes need a feature-memory update when they materially change the documented behavior/design; do not manufacture another PR or duplicate memory for every CI retry.

For a tiny single PR, avoid the stack schema: use `publication.json` containing `delivery: "pr"`, `phase: {id, status: "validated", headSha}`, and the required/exempt `featureMemory` object. Run `publication-ready --publication "$PHASE_DIR/publication.json" --phase "$PHASE_ID"` instead of `--plan`. The same real validation and sharing/exemption rules apply.
