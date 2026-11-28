# Upgrade to Threadnote 5

If you already use Threadnote 4, follow the website’s [Upgrade from Threadnote 4](https://threadnote.io/docs/upgrade-from-4/) guide: update in place with `threadnote update --check`, `threadnote update`, then `threadnote doctor`. This preserves `~/.threadnote`, existing memories, verified models, and registered integrations; do not delete your home, rewrite v4 memories, or reinstall MCP by hand. Run `threadnote setup <surface> --apply` later only when you want to adopt or verify a repository.

For Threadnote 3/OpenViking homes, use the legacy migration below. The website’s stable [Upgrade from 3.x](https://threadnote.io/docs/upgrade-from-3/) path remains the user migration guide.

## Memory schema v5

Threadnote 5 adds optional `owner` and `review_after` maintenance metadata to memory documents. `owner` is an opaque
person or team label; `review_after` is an ISO calendar date or canonical ISO instant used by context health. These fields do not alter memory
authority, lifecycle, relations, or code-citation meaning.

Older v4 documents remain readable. The v4-to-v5 migration is deterministic and only upgrades the schema header; it
never invents an owner or review date. A document without either field remains valid after migration. Downgrading to a
release that does not understand schema v5 requires preserving the original v4 copy and following that release's
documented migration path; do not hand-edit a canonical shared record to bypass schema validation.

Review overdue or expired records with `threadnote context health --project <name>` before deciding whether to replace,
archive, or retain them. Health is a read-only planner and does not silently change records.

## Legacy 3.x home migration

Threadnote 4 owns `~/.threadnote`. The legacy 3.x home is input to a one-time, non-destructive migration and is not a
runtime dependency.

```sh
threadnote migrate
threadnote migrate --apply
```

Post-update prompts are evidence-driven. A fresh current install, an empty or runtime-only `~/.openviking`, and a home
with completed matching receipts produce no migration prompt or manual follow-up command. Threadnote rechecks the
evidence under the post-update lock before announcing or running an action.

The eligibility probe is bounded and does not enumerate an arbitrary legacy-home fan-out. It recognizes the default
`local` account, the account and user currently selected by `THREADNOTE_ACCOUNT` / `THREADNOTE_USER`, canonical
resource and memory roots, seed state, managed-share metadata, model candidates, and resumable receipts. If a legacy
installation used a non-default account that is no longer selected, run the migration with that identity once, for
example `THREADNOTE_ACCOUNT=<old-account> THREADNOTE_USER=<old-user> threadnote migrate --apply`.

Upgrades from earlier 4.0 betas do not depend on `~/.openviking` still existing. The same migration command resumes a
pending receipt, flattens the short-lived `~/.threadnote/data/viking/<account>` layout, and adopts a verified model from
the earlier `~/.threadnote/threadnote/models/` layout. Completed receipts make each step idempotent. Lexical, vector,
and code-graph SQLite stores are derived data: repair validates their schema, and incompatible or stale indexes rebuild
from canonical files or current repository source instead of treating old database bytes as canonical migration input.
Canonical account moves use the same per-account mutation lock as normal agent writes. Threadnote moves material files
individually, keeps OS/runtime metadata out of canonical data, and never recursively deletes the old beta tree. Empty
directories and ignored metadata may therefore remain under `data/viking` as a non-authoritative scaffold; eligibility
ignores it, while any later material write there is preserved and reported as a conflict instead of being deleted.

The migration:

1. inventories canonical resources, memories, seed state, share metadata, and applicable settings;
2. rejects absolute symlinks and relative symlinks or paths that escape the source;
3. excludes server, interpreter-environment, PID, socket, cache, and transient files;
4. checks target free space for source bytes plus a bounded safety margin;
5. copies into a staging sibling of the final home, or performs a no-overwrite resumable recovery when beta.1 already
   created `~/.threadnote`;
6. records source size, modification time, and SHA-256;
7. verifies every staged hash and detects source changes during the copy;
8. isolates legacy Git share worktrees under `share/worktrees/`, rewrites their Git pointers, and retains a separate
   canonical Markdown copy;
9. records and verifies the transformed staging-tree hash;
10. writes a checksummed migration receipt;
11. atomically promotes the staging directory;
12. flattens canonical content to `~/.threadnote/data/<account>` without recursively deleting the old beta scaffold;
13. adopts any verified 3.x managed GGUF generation model into the role-aware model store and preserves its selection;
14. installs and selects the core BGE embedding model if no valid embedding selection already exists;
15. rebuilds the derived lexical SQLite and vector indexes from the migrated canonical content.

Interrupted staging and beta-home recovery are resumable. Re-running after success is idempotent. If an earlier beta
already wrote or subsequently updated a resource at the same logical canonical `data/` path, that current Threadnote
copy wins while the older copy remains available in the untouched legacy home. The recovery receipt records how many
current entries were preserved. An existing managed-share checkout is one atomic authority boundary: when its owned
worktree points at its owned Git directory, recovery preserves the entire current repository rather than overlaying
individual legacy Git files. This covers the index and split indexes, refs and packed refs, objects and packs, reflogs,
configuration, hooks, in-progress operation state, linked-worktree administration, and future Git repository entries
without relying on a filename allowlist. The complete legacy repository remains byte-for-byte available under
`~/.openviking`. A partial gitdir/worktree pair left by an interrupted earlier beta is recoverable only when every
existing entry is a byte-for-byte subset of that preserved legacy repository (allowing only Threadnote's deterministic
Git-pointer and worktree-path rewrites). Known transient Git operation files and locks do not establish authority and are
removed from a legacy-derived partial copy. The owner-executable bit must also match the deterministic legacy copy.
Recovery holds the same cross-process share lock used by agents, stages and verifies missing files outside the repository,
and atomically installs them before rechecking the legacy source. Any other current-only or different file, unsafe entry
type, or unrelated Git pointer still stops recovery before copying.
When neither half exists, the eligible legacy checkout is migrated using the normal transient-file exclusions. Disjoint
account trees are merged, identical overlaps are verified, and different non-canonical settings or metadata outside
managed repositories still stop the migration instead of being overwritten. The source is never automatically removed.

The standalone installer separately retires verified executable dependencies after activating the new release. It can
stop and uninstall a detected npm-distributed Threadnote package, including an early Node-based 4.0 beta, remove a
Threadnote-owned OpenViking uv/pipx/user-local pip tool, and unload the `io.threadnote.openviking` LaunchAgent. This
cleanup does not remove `~/.openviking`, its models, canonical resources, memories, or migration receipts. A rollback
that needs the old executable runtime must reinstall Threadnote 3/OpenViking and point it at the preserved home.

After promotion:

```sh
threadnote doctor
threadnote recall "latest handoff"
threadnote models list
threadnote index status
```

Lexical and vector recall are immediately available after install or repair completes. Both indexes are derived data
under `~/.threadnote/indexes/`; canonical memories and resources remain ordinary files under
`~/.threadnote/data/<account>`.

## Incremental recall vectors

An existing vector database works after the update. If the previous generation lacks an authorization identity, the background refresh uses a full walk.
`threadnote index status` and `threadnote doctor --dry-run` show `last refresh none` until the first refresh completes.
If you purge the vector database, the purge also removes its refresh history.

## Release-engineering reference: 4.7 to 5.0 evidence comparison

This section is release-engineering reference, not a user migration procedure. The optional local release-readiness procedure preserves a separate 4.7 capture and requires the
baseline version, commit, and executable hash outside that artifact. A generic receipt wrapper can
never admit a release: final evidence needs independently parsed source-native receipts. The v5
matrix includes the exact five-field closeout, verified procedures, activation/ValueReport reuse,
provider-neutral proposals, and read-only local scheduling plus configured Git-team health
aggregation. A downgrade is safe only when the same fixture records readable data or an explicit
safe refusal. See [`docs/release-readiness.md`](release-readiness.md) for commands.
