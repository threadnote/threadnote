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
