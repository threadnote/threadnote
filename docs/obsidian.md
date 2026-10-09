# Obsidian bridge

Threadnote can use Obsidian as an optional human-facing surface without an
Obsidian plugin. The bridge is local-only and experimental:

- allowlisted vault notes can become untrusted external recall sources;
- selected Threadnote memories can appear as generated, read-only Obsidian
  notes and Bases;
- a projected `threadnote://` memory can be opened in Obsidian;
- explicitly marked notes in one configured Inbox can form memory candidates
  for the normal agent review workflow.

Threadnote remains authoritative for memory identity, lifecycle, trust,
provenance, recall, and sharing. Source indexing does not create memories, and
editing a projected note does not update Threadnote.

## Configure a read-only source

Choose the smallest useful allowlist. Threadnote always excludes `.obsidian/**`
and `.trash/**`; a configured Inbox and a managed projection in the same vault
are also excluded automatically.

```bash
threadnote source add --type obsidian --id engineering \
  --vault "/path/to/Engineering Vault" \
  --include "Engineering/**" \
  --exclude "Engineering/Private/**" \
  --inbox "Threadnote Inbox"

# Inspect the normalized configuration, then persist it.
threadnote source add --type obsidian --id engineering \
  --vault "/path/to/Engineering Vault" \
  --include "Engineering/**" \
  --exclude "Engineering/Private/**" \
  --inbox "Threadnote Inbox" \
  --apply
```

Inventory and manual sync remain available for inspection and troubleshooting:

```bash
threadnote source inventory engineering
threadnote source sync engineering
threadnote source sync engineering --apply
threadnote source status engineering
threadnote recall --query "mobile authentication token mediator"
```

Every non-dry-run CLI recall and MCP `recall_context` requests a background
refresh of enabled sources, then searches the eligible local snapshot immediately.
The shared coordinator coalesces requests and applies only detected additions,
updates, and removals. A refresh may finish after the recall that requested it.
Use `source sync --apply` to wait for an explicit sync result. See
[Integration sync](integration-sync.md) for work limits and restart behavior.

The explicit `source sync` command is a dry run unless `--apply` is passed.
Automatic and explicit sync use the same boundary checks: they read Markdown
files only, reject boundary escapes and symlinks, block likely credentials,
redact local path leaks in a sanitized copy, and atomically commit that copy to
Threadnote's native store under:

```text
threadnote://resources/external/obsidian/<source-id>/<vault-relative-path>
```

The vault itself is never modified. Recall derives `authority: external` and
`trust: untrusted` from this URI boundary, regardless of source frontmatter, and
warns that the result is not authoritative guidance.

Background filesystem watching is intentionally not part of the bridge.
Demand-driven background refresh keeps the indexed snapshot current while
ensuring every refresh goes through the same inventory and safety boundary.

After a background refresh or an explicit applied sync, normal CLI and MCP recall
searches include matching vault notes. Results retain their external/untrusted
warnings and canonical `threadnote://resources/external/obsidian/...` URI.

## Publish selected Threadnote memories into Obsidian

```bash
threadnote projection add --type obsidian --id engineering-memory \
  --vault "/path/to/Engineering Vault" \
  --folder Threadnote
threadnote projection add --type obsidian --id engineering-memory \
  --vault "/path/to/Engineering Vault" \
  --folder Threadnote \
  --apply

threadnote projection publish engineering-memory \
  --uri threadnote://user/example/memories/durable/projects/threadnote/obsidian.md
threadnote projection publish engineering-memory \
  --uri threadnote://user/example/memories/durable/projects/threadnote/obsidian.md \
  --apply

# Repeat --uri to publish several selected memories.
threadnote projection publish engineering-memory \
  --uri <first-threadnote-memory-uri> \
  --uri <second-threadnote-memory-uri> \
  --apply

# Refresh only memories already selected for this projection.
threadnote projection sync engineering-memory --apply
threadnote projection status engineering-memory
```

A new projection selects no memories. `publish` adds only the canonical memory
URIs supplied with `--uri`; it never scans the rest of the memory corpus for
export. The default projection policy accepts active durable memories and
handoffs, including shared memories. Repeat `--kind` or `--status` when
configuring the projection to allow another lifecycle class, and pass
`--no-shared` to prevent shared memories from being selected.

Agent sessions use the same contract through the core `obsidian_publish` MCP
tool. The tool previews by default. The agent sets `apply: true` only after the
user has selected the memory URIs and destination projection.

Prototype configurations created before explicit selection remain in
`all matching (legacy)` mode so an upgrade cannot silently remove their
generated notes. Re-run `projection add` with the same id, vault, and folder
plus `--apply` to migrate that projection to an empty explicit selection, then
publish the desired memory URIs.

The managed folder contains:

```text
Threadnote/
  Memories/<project>/<kind>/<topic>--<stable-id>.md
  Views/*.base
  README.md
  .threadnote-projection-v1.json
```

Generated notes contain a managed marker, stable memory ID, canonical
`threadnote://` URI, lifecycle metadata, source hash, evidence, and relation links.
Threadnote secret-scans rendered output before writing it.

Publish and sync never overwrite an unmanaged file. If a previously generated
file was edited, status reports drift and preserves it. `--force` can regenerate
or remove only paths already recorded as managed by that projection.

## Open a recalled memory

```bash
threadnote open \
  threadnote://user/example/memories/durable/projects/threadnote/obsidian.md
```

If the memory appears in multiple projections, choose one:

```bash
threadnote open <threadnote-uri> --projection engineering-memory
```

Threadnote prefers the official Obsidian CLI and falls back to the registered
`obsidian://open` URI handler. See Obsidian's
[CLI](https://obsidian.md/help/cli) and
[URI](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI)
documentation for the underlying application contracts.

## Form candidates from an Inbox

Inbox scanning is the only vault-to-memory writeback path. It scans only direct
Markdown children of the configured Inbox. An eligible note has:

```yaml
---
threadnote_candidate: true
kind: durable
project: threadnote
topic: example
---
The candidate memory body.
```

Supported kinds are `durable`, `handoff`, and `preference`. Durable notes may
set `category: decision` or `category: invariant`; `evidence` may be a list of
pointers. Content cannot claim trusted authority, approved status, or an actor.

```bash
threadnote inbox scan --source engineering
threadnote inbox scan --source engineering --apply
```

The first command previews comparison results. `--apply` creates candidate
reviews; it does not create or replace a durable memory. The agent presents
those reviews in its normal closeout workflow, and they are also visible in the
Manager Candidate Inbox. The user still approves, edits, defers, or rejects each
operation. Repeated scans of unchanged notes are idempotent.

## Removal and troubleshooting

```bash
threadnote projection remove engineering-memory
threadnote projection remove engineering-memory --apply
threadnote source remove engineering
threadnote source remove engineering --apply
```

Projection removal deletes only unchanged managed files. Source removal deletes
only its external index and private connector state. Both preserve the vault
and authoritative Threadnote memories.

If a sync reports drift, inspect the changed projected note before choosing
`--force`. If Obsidian Sync is also active, let it settle before refreshing the
projection to avoid observing a partially synchronized managed folder. If a
source note is skipped, remove the reported credential category or narrow the
allowlist; diagnostics never print the matching secret or note body.
