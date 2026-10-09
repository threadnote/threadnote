# Integration sync

Threadnote uses one on-demand sync coordinator per canonical data home. The CLI,
Manager and MCP clients share it. The coordinator runs bounded source work with
Effect fibers; integrations do not each keep a resident process.

Recall requests a refresh, then searches eligible local snapshots without waiting
for provider network calls. Repeated requests coalesce. A refresh can finish after
the recall that requested it, and source refresh intervals still apply. Use
`threadnote source sync <id> --apply` or Manager's **Sync now** to wait for one
bounded sync result. Large imports can report progress and continue in further
quanta. A sync without `--apply` remains a local preview.

## Durable work and recovery

The provider-neutral runtime stores desired work and receipts in a private SQLite
database under `<home>/threadnote/integration-coordinator`. Effect's
`PersistedQueue` delivers source jobs with generation-based IDs. A completed job's
deduplication entry cannot suppress the next refresh generation. Delivery is at
least once: providers retain their source locks, incremental checkpoints,
configuration fingerprints, access epochs and publication fences so interrupted
work can safely resume.

A canonical-home process lock admits one coordinator. The process exits after an
idle period; a later request starts it again. Pending jobs and retry deadlines
survive process exit. It does not continuously poll every connected account.

The scheduler admits two source quanta concurrently by default and keeps work
for the same source or credential identity serialized. HTTP admission is shared by
background sync, explicit sync and discovery requests. Provider, account and
method counters and provider cooldowns are persisted, so restarting a process or
adding another source cannot reset them. Effect's rate limiter coordinates live
requests; durable admission state remains authoritative after restart. Account
partitions use opaque credential fingerprints. The provider-wide ceiling also
applies across different tokens, conservatively sharing capacity across accounts.

Explicit sync has a finite wait deadline. A client timeout does not revoke
already queued work. If a coordinator restarts before delivering a live provider
result, the client reports that retry is needed instead of returning an incomplete
result as success.

## Credentials and access

Credentials are never stored in jobs or receipts. Environment bindings pass over
an authenticated loopback endpoint into bounded worker memory; protected local
credentials are read through the provider's existing checks. A caller's missing
environment binding clears the previous binding rather than silently using an
old token. Configuration and credential identity are checked before work runs.

Queued refresh does not make stale or revoked evidence eligible. Existing source
policy continues to deny disabled, removed, reconfigured, expired or quarantined
resources in recall and direct reads. Authentication loss detected during sync
still denies affected snapshots. An offline cache cannot immediately detect a
permission change at the remote provider.

Each provider owns its bounded work adapter and checkpoint format. Obsidian
background scans persist traversal progress and reconcile removals only after a
complete traversal. Directory resume can enumerate preceding names again; file
inspection, hashing and content reads are bounded per quantum. Remote providers retain their request, response-size, origin,
redirect and time limits. Shared admission adds coordination across callers to
those provider-specific safety boundaries.
