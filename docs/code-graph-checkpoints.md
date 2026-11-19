# Portable code graph checkpoints

Threadnote can move one verified native code graph between local installations as a file. Checkpoints are a manual,
offline transport: they do not require a Threadnote account, a Workset, or a hosted artifact service.

## Export

Index the repository at a clean commit, then export to a new path:

```sh
threadnote graph index
threadnote graph checkpoint export --output ./threadnote-graph.cgcp
```

Export accepts only the exact ready, clean root snapshot for the current `HEAD`. The repository must have a
credential-free remote identity such as `github.com/org/repository`; absolute local paths, configured remote credential
material, dirty source state, worktree identifiers, and raw source-file bytes are not embedded. Checkpoints do contain
source-derived names, signatures, and documentation, so a secret embedded in source can be carried into the artifact.
Existing output files are never overwritten.

The v1 artifact uses canonical JSON metadata, independently compressed deterministic chunks, and SHA-256 identities
for the artifact, every chunk, the logical record stream, and its runtime ABI. Export reads SQLite through one
transaction in bounded pages, verifies committed file identities against Git, and fences the repository before and
after projection. Re-exporting the same compatible graph produces the same bytes and digest.

Each header names the compression profile of its chunks. New exports use `threadnote-gzip-v2`, which compresses with
Bun's bundled libdeflate. Checkpoints exported before this profile use `threadnote-gzip-v1`, which compresses with
fflate. Both profiles decode the same way, and the logical digest does not depend on the profile. The artifact digest
does depend on it, so re-exporting an unchanged graph with v2 gives a new artifact digest.

## Inspect and verify

`inspect` authenticates the exact artifact bytes against an expected digest and validates its bounded framing without
inflating graph records:

```sh
threadnote graph checkpoint inspect \
  --input ./threadnote-graph.cgcp \
  --expected-digest sha256:<digest>
```

Omitting `--expected-digest` computes the artifact digest but does not establish trust in who supplied it. Use
`verify` when the compressed records must also be inflated and checked for chunk digests, gzip integrity, canonical
schema, global ordering, counts, coverage, and logical digest:

```sh
threadnote graph checkpoint verify \
  --input ./threadnote-graph.cgcp \
  --expected-digest sha256:<digest>
```

Both commands reject direct symbolic-link inputs and fail if the opened pathname identity or metadata changes.

## Import

Run import from a checkout of the same repository:

```sh
threadnote graph checkpoint import \
  --input ./threadnote-graph.cgcp \
  --expected-digest sha256:<digest>
```

Import never fetches source or executes repository code. The source commit must already exist in the receiver's local
Git object database. Before any graph row is staged, Threadnote checks the repository identity, object format,
case-sensitivity policy, runtime ABI, artifact and logical integrity, and every declared file against the exact local
Git tree. A second decoding pass stages only already-verified bounded chunks, and one transaction publishes the ready
snapshot and immutable import receipt. Interrupted or rejected imports remain unreachable.

Publication depends on receiver state:

| Receiver state                                 | Result                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Exact source commit and clean worktree         | Activate the imported snapshot directly                                  |
| Exact source commit with local changes         | Build the current dirty graph, reusing the imported base when compatible |
| Current commit descends from the source commit | Build the current graph, reusing the imported base when compatible       |
| Divergent history                              | Keep the verified snapshot inactive for later compatible reuse           |

Repeated imports reuse the same logical snapshot instead of duplicating it. An explicitly supplied digest records
`expected-descriptor-verified` trust; a locally inspected artifact without one records `local-unverified` trust.

## Compatibility and existing memories

Checkpoint compatibility is explicit. The ABI binds the graph schema, checkpoint semantics, lexical format, inventory
policy, workspace model, reference-resolution surface, and exact language-pack derivation identities. An incompatible
runtime fails before staging rather than guessing that its rows are equivalent.

Releases before `threadnote-gzip-v2` reject a v2 checkpoint or shared delta at header validation. Upgrade the receiver
before importing an artifact from a newer exporter. A newer receiver still imports v1 artifacts.

Portable checkpoints affect only Threadnote's disposable native code-graph store. Existing schema-v1 memories,
uncited legacy memories, canonical `threadnote://` URIs, recall indexing, and team memory files are neither migrated nor
filtered by checkpoint operations. Recall continues to read those memories at coarse or unknown citation freshness.
A Workset remains optional and is used only for explicitly prepared multi-repository evidence.

Checkpoint v1 exports only a full-repository graph. Exporting a dependency-scoped project graph fails closed because
v1 cannot carry the verified scope receipt needed to establish what the artifact covers. Rebuild the scoped graph on
the receiving checkout, or clear that project's scope and export a full graph when portable transfer is required.

## Operational boundaries

- Treat the expected artifact digest like a release checksum and obtain it independently from the checkpoint file.
- Keep the source commit locally available; import deliberately disables lazy Git fetching.
- Checkpoints contain derived source structure, names, signatures, and documentation. Review their destination as you
  would any potentially sensitive internal architecture artifact. Absolute local paths, configured remote credential
  material, and raw source-file bytes are omitted, but source-embedded secrets can still appear in derived fields.
- Use `--json` on every checkpoint command for a versioned machine-readable receipt.
