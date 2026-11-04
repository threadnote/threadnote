# Ordinary merge qualification

An ordinary integration can advance a phase's declared base while preserving
the reviewed predecessor in Git ancestry. It uses `ordinaryMergeQualificationV1`,
separately from the existing rebase-only `baseRequalification` witness.

Retrieve the installed `request-schema` for `cycle` / `snapshot` before authoring
the request. The new request requires `protocolVersion: 2`, `executorVersion: 1`,
the exact CAS revision, reviewed `previous`, exact `acceptedHead`, `reason`, and
explicit `userAuthority`. The nested input binds the exact prior/current HEADs,
current base commit, historical base label, current plan document hash, and a
complete, sorted `phaseOwnedPaths` array. Each owner lists literal paths already
authorized in the verified ready plan. Every changed path must list every phase
whose plan explicitly owns it. Wildcards cannot supply that permission.

The current tree and original baseline must be clean committed trees. The old
declared base must be an ancestor of the new base, the prior HEAD an ancestor of
the current HEAD, and the new base an ancestor of the current HEAD. Their merge
bases must equal those named ancestors. A moved base label is supported: the
old commit comes from the retained predecessor, never from resolving that label
again. Plan amendments still use the ordinary verified export and reconcile
flow; qualification grants no new path permissions.

The receipt preserves the meanings of `files` (baseline/current-base changed
audit union), `scopeFiles` (the full current-base changed set), and `incoming`
(the per-phase preserved/upstream subset). It separately records the exhaustive
disjoint partition into current-base changed paths and inherited-only upstream
paths. Every path has baseline, old-base, current-base, and current-tree mode/blob
evidence. An inherited path must differ from the baseline, differ between the
old and new bases, and equal the current base at HEAD. This complete upstream
proof is not the smaller `incoming` subset. Other phases' changed paths remain
in the explicit owner proof; they are never relabeled as incoming upstream work.

Review detail projects the complete current-base-to-tree patch for the selected
phase's explicit owners. A fresh full review is mandatory, including disposition
of prior findings. Prior snapshot, review, delivery, baseline, and plan records
remain immutable. The existing 256-path phase permission bounds and 128-file
source-inspection bound remain unchanged. Qualified current-base changed sets
are bounded at 256; the existing 8192-entry audit bound remains unchanged.

Before writing, the runtime validates and serializes the complete prospective
native workflow state with the writer's shared codec and fixed 64 MiB logical /
16 MiB stored limits. It then rechecks the current HEAD/tree, phase branch,
selected base, prior/baseline pins, and witnessed objects. A failed preflight or
fence writes no snapshot, journal, or new pin. Commit/tree retention uses
immutable refs and one Git transaction that also verifies the source/base/prior
refs. Native-state persistence consumes those exact prepared bytes and retains
the exact CAS check.

Retained-object checks, ancestry validation, source capture, and the final source
fence remain interruptible. The critical section starts at the atomic retention
transaction; that transaction, persistence, and recovery settle before interruption
can leave it. A late rename must never race pin cleanup.
If persistence reports failure, a fresh state read determines recovery. An exact
candidate revision proves admission and returns its receipt. Only the exact
original revision permits rollback: a conditional Git transaction deletes only
refs created by this attempt, checks every expected object, and never follows
symbolic refs. Pre-existing pins remain untouched. Unreadable or different state
retains the pins and reports `ordinary-merge-recovery-required`; failed conditional
cleanup reports the same code without claiming that cleanup completed. Inspect
the original run and snapshot refs before retrying either uncertain outcome.

## Compatibility

Ordinary and rebase requests keep request protocol 1 and snapshot manifest 1.
Only ordinary-merge qualification uses request protocol 2 and snapshot manifest
2, with a closed version-1 qualification receipt. The surrounding response
envelope remains executor/protocol 1. Readers must inspect the nested manifest
version: legacy literal-version-1 readers reject manifest 2 even if their
decoder normally strips unknown fields. New readers reject manifest 2 without
the proof, manifest 1 carrying the proof, or a manifest carrying both witness
kinds. Request schema discovery describes both envelope versions and their
semantic prerequisites. Upgrading is required before reading a run containing
the new manifest; silently dropping the capability is unsupported.
