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

## Cite a note when accepting a derived memory

The local MCP `derive_from_obsidian` tool accepts a **private durable memory** and
pins the exact sanitized imported revision that supported it. First apply a
source sync, then call `inspect_obsidian_note` with the source ID and
vault-relative path. It returns the sanitized text plus source instance, note
ID, sanitizer version, and sanitized revision SHA-256 from one locked read.
Review that text and pass its exact identity and a supporting fragment to
`derive_from_obsidian`. The tool rejects a fragment that is absent, a changed
reviewed revision or note identity, a stale sync, an excluded note, or an
unsafe note.
For example:

```text
inspect_obsidian_note({sourceId: "engineering", relativePath: "Engineering/Decision.md"})

derive_from_obsidian({
  sourceId: "engineering",
  relativePath: "Engineering/Decision.md",
  expectedSourceInstanceId: "<instance from inspect>",
  expectedNoteId: "<note ID from inspect>",
  expectedRevisionHash: "<sanitized SHA-256 from inspect>",
  expectedSanitizerVersion: "<sanitizer contract from inspect>",
  fragment: "Use the token mediator.",
  text: "The architecture decision uses the token mediator.",
  project: "threadnote",
  topic: "token-mediator"
})
```

`read_context` exposes the resulting `obsidian_evidence` citation identity in
the memory header. Call `read_source_evidence({memoryUri: "<returned memory URI>"})`
to inspect its historical supporting fragment and a **freshly observed**
current sanitized revision comparison. `same` means the current note has the
same sanitized bytes; it does not establish that the derived claim is still
applicable. `changed`, `removed`, and `unknown` likewise do not automatically
supersede a memory. An unsynced edit or deletion is observed by this reader.
After a later sync drops a deleted note's identity from current state, the
comparison may become `unknown`; historical support remains inspectable until
expiry while Threadnote avoids inferring a current match from a reused path.

Each citation records a source instance, stable note ID, path at capture,
sanitizer contract (`scrubber-redact-v1`), sanitized revision hash, fragment
hash/offsets, and expiry. The cited bytes are pinned privately under
Threadnote's Obsidian source state, separate from the changing external index.
These citations are part of the versioned memory schema. Older writers refuse
newer schemas rather than silently lose the citation.
Only cited notes are pinned. The default retention is 90 days; callers may set
`retentionDays` from 1 to 365. A source accepts at most 256 unexpired pins and
64 MiB of pinned data; capture fails at capacity rather than evicting a promised
pin. Expiry makes evidence unavailable immediately. Expired files are removed
when that source is read or captured; an idle installation may retain the file
past logical expiry until the next such operation. The memory citation identity
remains after expiry or missing storage, with an explicit unavailable state.

Note identity survives a rename when the filesystem supplies an unambiguous
file identity. A different file reusing an old path receives a new note ID.
Where filesystem identity is unavailable or ambiguous, the importer assigns a
new ID rather than guessing. An applied sync upgrades older source state before
capture. The reader never re-sanitizes raw vault text as a fallback for missing
historical evidence. Disabling/removing a source, changing its access selection
or vault, or replacing a removed source ID revokes historical content access;
removing a source also deletes its pins. Private cited memories cannot be
published to a shared memory repository until a separate approved evidence
publication path exists. Derived prose remains private unless deliberately
published through a supported policy.

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
