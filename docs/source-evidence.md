# Retained evidence for derived memories

A synced integration resource can change after you use it to make a decision. Accepting a derived memory can retain the exact sanitized text you reviewed, so you can later inspect what supported that memory.

GitHub, Linear, Pocket and Superhuman Docs use the same local MCP flow. Obsidian has its own [note inspection and acceptance tools](obsidian.md).

1. Sync the configured source, then find the imported chunk through recall or source search.
2. Call `inspect_source_evidence({resourceUri: "<canonical external chunk URI>"})` and review the sanitized text.
3. Call `derive_from_source` with the exact supporting `fragment`, your reviewed memory `text`, `project`, `topic`, and every expected identity returned by inspection.
4. Later call `read_source_evidence({memoryUri: "<accepted memory URI>"})` to inspect the retained fragment and the current revision status.

For example, the acceptance arguments are:

```js
{
  resourceUri: inspected.resourceUri,
  fragment: "Exact supporting text from the inspected sanitized content.",
  expectedSourceInstanceId: inspected.sourceInstanceId,
  expectedAccessHash: inspected.accessHash,
  expectedRevisionHash: inspected.revisionHash,
  expectedContentHash: inspected.contentHash,
  expectedRendererVersion: inspected.rendererVersion,
  expectedSanitizerVersion: inspected.sanitizerVersion,
  text: "The reviewed decision this text supports.",
  project: "engineering",
  topic: "decision",
  retentionDays: 90
}
```

Acceptance rejects a changed revision, changed access identity, or a fragment absent from the inspected text. The memory and its citation remain private. Replacements must preserve the citation; sharing and consolidation cannot silently discard it or publish the private supporting text.

## Reading the result

`historical: available` means the exact accepted fragment is retained. `currentRevision` reports `same`, `changed`, `removed`, or `unknown` independently. A changed or removed current chunk can still have available historical support. Neither a retained fragment nor a matching current revision proves that the derived claim still applies.

Historical access follows the current local source configuration, credential and synced access receipts. Pausing or removing the source, credential rotation, source-instance replacement, document quarantine, or an observed permission denial withholds retained text. GitHub repository denial generations prevent a later permission regrant from reviving an old denied citation. These checks do not make a live remote permission request. Sync the source to observe remote changes.

Pins expire 90 days after acceptance by default; `retentionDays` accepts 1–365 days. Each account/provider/source has a limit of 256 unexpired pins and 64 MiB. Capacity rejects new acceptance instead of evicting promised support. Expired pins can be pruned on later acceptance. Explicit source removal deletes that account's retained pins. Missing, expired, revoked or corrupt evidence returns its status without supporting text.

Only sanitized imported chunks are retained. The 512 KiB chunk limit and 8192-byte fragment limit keep acceptance bounded; large source documents may require choosing a smaller imported chunk.

## Automatic ordinary-memory updates

Ordinary memory assessment and bounded background drafts work without enrollment or an Obsidian source. Threadnote
uses accessible evidence and keeps missing, partial or unavailable support explicit. A prepared draft requires a full
content and support preview plus explicit confirmation before changing the saved memory. Shared ownership and
source access still apply. See [automatic memory care](memory-code-citations.md#automatic-memory-care).

The specialized note and dependency workflows below remain available for their existing explicit capture and
metadata approvals; they are not prerequisites for ordinary automatic assessment.

## Advanced maintained private notes

The first imported maintenance adapter supports an already-derived private
Obsidian memory backed by exactly one note and source instance. Enroll its
paragraph support, inspect a changed note, explicitly capture the selected
current fragment, then separately approve the complete memory preview. Capture
does not approve prose. Original and active evidence retain separate identities
and deadlines; reads and retries cannot extend them. Source revocation withholds
old persisted review text, and sharing/export/projection refuse the private root
and nested evidence. See the [note maintenance workflow](obsidian.md#review-a-changed-note-without-rewriting-its-history).

## Review additional code dependencies

A legacy enrolled code topic's declared-source maintenance observes only its declared support.
New files are not discovered or added automatically. Dependency expansion is a
separate metadata approval: it leaves every paragraph, support decision, origin
citation and accepted mapping intact.

In Manager, choose the code topic's dependency action, select existing source
seeds, then inspect an explicitly bounded one-hop neighborhood. Choose the exact
eligible endpoints to add. Configuration files are independent explicit
repository-relative selections, labeled configuration; no graph relationship
is invented for them. Syntactic, heuristic and model links are suggestions and
cannot establish dependency authority. Empty selection never means select all.

The CLI exposes the same workflow:

```bash
threadnote context topic dependencies inspect --uri <memory-uri> --cwd <checkout> --project <graph-project> --json
threadnote context topic dependencies inspect --uri <memory-uri> --cwd <checkout> --project <graph-project> --input scope.json --json
threadnote context topic dependencies preview --uri <memory-uri> --cwd <checkout> --project <graph-project> --input selected.json --json > preview.json
threadnote context topic dependencies apply --preview preview.json --revision <exact-revision> --digest <exact-digest> --approved
# If an unwritten interrupted reservation expires, explicitly supersede its exact approval:
threadnote context topic dependencies restart --preview preview.json --revision <old-revision> --digest <old-digest> --approved --json > fresh-preview.json
# Read fresh-preview.json, then approve its new revision and digest separately.
```

The bounded selection input contains version `1`, depth exactly `1`, the
inspected project/root/configuration digest, exact seed IDs, direction
(`outgoing` by default), allowed edge kinds/provenances, minimum confidence,
node/edge ceilings, selected node IDs and explicit configuration paths. Inspect
returns seed choices and, once seeds are selected, eligible endpoint labels and
real omissions. Manager presents these as choices; agents may use the typed MCP
dependency-expansion tool. Save private CLI preview files privately because
their approval proof can contain local checkout paths.

Preview retains no new evidence and writes no memory or review journal. It
shows selected additions, scope/coverage, omissions, metadata changes and the
full unchanged topic. Apply requires that exact revision and digest, rechecks
the target and the current source/graph/project/configuration proof, retains the
selected evidence and writes once. A repeated exact apply recovers its private
receipt. A pending older topic draft becomes stale when this metadata changes.

Expansion requires a clean checkout and a complete current ready graph for the
chosen project; it never starts indexing. Exhaustive coverage means only the
requested one-hop neighborhood, not the whole repository. Partial, bounded,
timed-out, missing or ambiguous evidence refuses approval. Reconfigure and
preview explicitly rather than increasing limits implicitly. Equivalent older
graph snapshots remain eligible when the existing project admission proves
their configured inputs are current.

The eight-citation total includes retained origins, accepted support and new
selections. Capacity refuses expansion rather than pruning history. Subsequent
ordinary maintenance compares this explicit enlarged set; it does not repeat
graph discovery or treat an old expansion receipt as proof of current freshness.

An interrupted dependency approval keeps its original 90-day evidence reservation on every retry. After it expires, restart is available only while the topic and exact source proof still match the unwritten preview. Restart preserves the old receipt and returns a fresh full preview; it captures nothing and requires a separate approval to apply. The Manager offers this action when recovery is available. At most eight explicit restarts are allowed for one unchanged selection.

Reserved captures preserve all physical historical capsules, including expired ones, and refuse if their combined count or bytes would exceed the existing limits. An already captured capsule with the same identity that has expired cannot be renewed through restart. That case remains unavailable under the retention policy; changing an unrelated selection does not restore its evidence.
