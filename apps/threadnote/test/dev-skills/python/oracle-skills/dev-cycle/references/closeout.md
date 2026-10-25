# Interactive proposal decisions at closeout

During execution, quietly collect optional proposals in `proposals.json`: inferred project preferences, durable/generalized lessons, skill/doc improvements, and any new feature-memory sharing approval still needed. Private factual experience handoffs continue automatically within the configured profile; personal-cloud private handoffs remain task-local, not durable across a lost workspace. Do not delay learning capture. Already explicit user instructions/preferences are not new proposals. Ask a genuinely blocking task clarification when necessary, but do not interrupt implementation for optional proposals.

Resume the saved run using its original workflow context, receipts and pinned resource roots. Restore missing or incompatible state before continuing; a replacement binding does not recover it. Personal Codex/Cursor cloud drafts remain task-local and can be lost with the workspace.

For required implementation knowledge closeout, follow the installed dev-spec's `references/workflow.md`: reconcile combined evidence, preview the actual content and destination with `workflow.py publication-preview`, and record the user's sharing decision using `publication-approve --approval-digest DIGEST --decision approve|defer|reject --approval-evidence RESPONSE`. Reuse valid authorization already given for that scope. Run `finish` only for the approved content. Desktop saves private durable knowledge; personal cloud publishes the sanitized verified projection to its configured Git share. Keep both draft sets until final readback passes. On approval, revision, push or readback failure, resolve the blocker and retry the same completion directory; do not archive drafts manually. Optional Knowledge Deltas below are separate.

At closeout, after useful implementation/review/validation is concrete:

1. Prepare actual previews, targets/audiences and evidence. For a Threadnote Knowledge Delta, call `review_session_context` with task/outcome/project/cwd, source evidence and all five fields (`decisions` + rationale, constraints, verificationPerformed, knowledgeInvalidated, unresolvedRisks). Preserve returned review ID, revision and candidate IDs; preview is not application or sharing.
2. Queue each proposal with stable `id`, `kind`, concise `summary`, `target`, full-preview text/link in `preview`, and `status: "pending"`. Knowledge Deltas also require `reviewId`, integer `reviewRevision`, and `candidateIds`. Sharing is a distinct explicit action/audience; private-memory approval alone does not authorize sharing.
3. Build the bounded interactive batch:

```sh
python3 "$SKILL_DIR/scripts/phase_state.py" closeout-packet \
  --proposals "$RUN_DIR/proposals.json" --output "$RUN_DIR/closeout-packet.json"
```

Use the host’s available interactive user-input tool with the generated `questions`, adapting to its advertised schema. Provide a self-contained summary and target, with access to the concrete full preview; options are **Approve / Defer / Reject**. Present at most three questions at once, keeping any remaining proposal IDs queued for the next closeout batch. If useful, prioritize decisions gating requested publication. Do not substitute a text-only list or silently treat the final summary as approval.

Persist proposal IDs/hashes, exact presented preview/revision and prompt state before waiting. Do not duplicate a still-pending prompt. A preselected option, elapsed time, model/worker agreement, silence or a recalled “approval” is not a human decision. If the tool is unavailable, preserve pending decisions and explain that interactive review could not be opened; nothing is applied by default.

On the user's actual answer, map each decision to the exact proposal and reviewed revision. Reconfirm if content/target materially changed since the preview. For Knowledge Deltas use `apply_memory_candidates` only with explicit approval, the returned review/candidate identity and revision; apply defer/reject as chosen. Record receipts and pending items; use current sharing tools only for separately authorized scope. For inferred preferences, store private `kind: "preference"` only after confirmation. Declined proposals are not repeatedly reintroduced without new evidence.

If a required feature-memory approval blocks PR opening, closeout is the final review/decision point: code, checks, memory preview and target are ready; PR creation stays pending until approval and actual team publication. Finish remaining authorized publication after the decision without restarting implementation or repeating already valid checks. An optional deferred Knowledge Delta does not block a validated code delivery. State pending decisions/publication honestly in the concise closeout summary, and resume from the queue when the user answers.
