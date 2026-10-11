import {Clock, Crypto, DateTime, Effect, FileSystem, Option, Path, PlatformError, Predicate, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runtimeTextDirectoryNamePage, SystemInfo} from '@threadnote/platform/system';
import {
  captureCodeGraphGitWorktreeRegistration,
  observeCodeGraphRecordedWorktreePaths,
  parseCodeGraphGitWorktreeRegistration,
  sameCodeGraphGitWorktreeRegistration,
  type CodeGraphGitWorktreeRegistration,
} from './git/worktree/registration.js';
import {classifyCodeGraphLifecycle} from './lifecycle/classification.js';
import {normalizeRepositoryBranchName, resolveRepositoryIdentityDetail} from './repository.js';
import {codeGraphLocalProvenanceLockPath} from './layout.js';
import type {RepositoryIdentity} from './types.js';

class CodeGraphLocalProvenanceError extends Schema.TaggedError<CodeGraphLocalProvenanceError>()(
  'CodeGraphLocalProvenanceError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const LOCAL_CONTEXT_DIRECTORY = 'local-context';
const LOCAL_WORKTREES_DIRECTORY = 'worktrees';
const LOCAL_PROVENANCE_LEGACY_SCHEMA_VERSION = 1 as const;
const LOCAL_PROVENANCE_SCHEMA_VERSION = 2 as const;
const LOCAL_PROVENANCE_BYTES_LIMIT = 8 * 1_024;
const LOCAL_PATH_LENGTH_LIMIT = 4_096;
const LOCAL_PROVENANCE_REFRESH_MILLISECONDS = 5 * 60_000;
export const CODE_GRAPH_LOCAL_PROVENANCE_INVENTORY_ENTRY_LIMIT = 4_096;
const HASH_ID = /^[0-9a-f]{64}$/;
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type CodeGraphLocalAssociationState = 'invalid' | 'legacy-unknown' | 'missing' | 'stale' | 'verified';

export interface CodeGraphLocalAssociation {
  readonly available: boolean;
  readonly branch?: string;
  /** Home-abbreviated path for trusted local human interfaces. */
  readonly displayPath?: string;
  readonly observedAt?: string;
  /** Canonical local path. This shape is restricted to trusted local CLI and Manager responses. */
  readonly path?: string;
  readonly state: CodeGraphLocalAssociationState;
}

export interface CodeGraphLocalAssociationTarget {
  readonly checkoutId: string;
  readonly repositoryId?: string;
  readonly worktreeId: string;
}

interface CodeGraphLocalProvenanceRecordBase {
  readonly branch?: string;
  readonly canonicalWorktreePath: string;
  readonly checkoutId: string;
  readonly headCommit?: string;
  readonly observedAt: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
}

export interface CodeGraphLocalProvenanceRecordV1 extends CodeGraphLocalProvenanceRecordBase {
  readonly schemaVersion: typeof LOCAL_PROVENANCE_LEGACY_SCHEMA_VERSION;
}

export interface CodeGraphLocalProvenanceRecordV2 extends CodeGraphLocalProvenanceRecordBase {
  readonly registration: CodeGraphGitWorktreeRegistration;
  readonly schemaVersion: typeof LOCAL_PROVENANCE_SCHEMA_VERSION;
}

export type CodeGraphLocalProvenanceRecord = CodeGraphLocalProvenanceRecordV1 | CodeGraphLocalProvenanceRecordV2;

export type CodeGraphLocalReconciliationEvidence =
  | {readonly state: 'invalid' | 'legacy-unknown'}
  | {
      readonly checkoutId: string;
      readonly recordDigest: string;
      readonly recordIdentity: string;
      readonly registration: CodeGraphGitWorktreeRegistration;
      readonly repositoryId: string;
      readonly state: 'verified';
      readonly worktreeId: string;
    };

/** Path-free, exact v2 authority token for automatic missing-worktree reconciliation. */
export type CodeGraphMissingWorktreeReconciliationEvidence =
  | {readonly state: 'invalid' | 'legacy-unknown' | 'main' | 'present'}
  | {
      readonly checkoutId: string;
      readonly recordDigest: string;
      readonly recordIdentity: string;
      readonly registration: Extract<CodeGraphGitWorktreeRegistration, {readonly kind: 'linked'}>;
      readonly repositoryId: string;
      readonly state: 'missing';
      readonly worktreeId: string;
    };

/** Private path-bearing token used only as input to the killable authority worker. */
export type CodeGraphWorktreeReconciliationEvidenceCandidate =
  | {readonly state: 'invalid' | 'legacy-unknown' | 'main'}
  | {
      readonly canonicalWorktreePath: string;
      readonly checkoutId: string;
      readonly evidenceToken: string;
      readonly recordDigest: string;
      readonly recordIdentity: string;
      readonly registration: Extract<CodeGraphGitWorktreeRegistration, {readonly kind: 'linked'}>;
      readonly repositoryId: string;
      readonly state: 'candidate';
      readonly worktreeId: string;
    };

export interface CodeGraphLocalProvenanceObservationOptions {
  /** @internal Deterministic race seam used to verify the final pre-publication identity check. */
  readonly beforePublishValidation?: () => Effect.Effect<void, unknown>;
}

export interface ResolveCodeGraphLocalAssociationOptions extends CodeGraphLocalProvenanceObservationOptions {
  /** @internal Validate a freshly resolved identity before any association is observed. */
  readonly validateIdentity?: (identity: RepositoryIdentity) => Effect.Effect<void, unknown>;
}

export interface CodeGraphLocalProvenanceCleanupOptions {
  /** @internal Deterministic race seam before the required final missing-path observation. */
  readonly beforeFinalObservation?: () => Effect.Effect<void, unknown>;
  /** @internal Deterministic race seam before the final identity check and exact derived-file removal. */
  readonly beforeRemove?: () => Effect.Effect<void, unknown>;
  /** @internal Deterministic seam after final identity proof while the shared provenance lock remains held. */
  readonly afterFinalValidation?: () => Effect.Effect<void, unknown>;
  /** Exact path-free token captured before the caller's destructive core operation. */
  readonly expectedEvidence?: CodeGraphLocalProvenanceCleanupEvidence;
}

export interface CodeGraphLocalProvenanceCleanupEvidence {
  readonly checkoutId: string;
  readonly recordDigest: string;
  readonly recordIdentity: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
}

export interface CodeGraphMissingWorktreeReconciliationOptions {
  /** @internal Deterministic race seam before the final missing-path observation. */
  readonly beforeFinalMissingObservation?: () => Effect.Effect<void, unknown>;
}

export type CodeGraphLocalProvenanceCleanupResult =
  | {readonly state: 'not-found' | 'removed' | 'unavailable'}
  | {
      readonly observedState: CodeGraphLocalAssociationState;
      readonly state: 'preserved';
    };

export type CodeGraphLocalProvenanceInventory =
  {readonly state: 'ready'; readonly worktreeIds: readonly string[]} | {readonly state: 'unavailable'};

/**
 * List one checkout's private provenance identities without returning paths or
 * reading record contents. The closed absolute entry ceiling keeps automatic
 * maintenance bounded; overflow and containment ambiguity fail closed.
 */
export const inspectCodeGraphLocalProvenanceInventory = Effect.fn('codeGraph.inspectLocalProvenanceInventory')(
  function* (threadnoteHome: string, checkoutId: string) {
    if (!HASH_ID.test(checkoutId)) {
      return {state: 'unavailable'} as const satisfies CodeGraphLocalProvenanceInventory;
    }
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkoutRoot = yield* inspectCheckoutRoot(fs, path, threadnoteHome, checkoutId);
      if (checkoutRoot === undefined) {
        return {state: 'ready', worktreeIds: []} as const satisfies CodeGraphLocalProvenanceInventory;
      }
      const localContext = path.join(checkoutRoot, LOCAL_CONTEXT_DIRECTORY);
      if (Option.isSome(yield* fs.readLink(localContext).pipe(Effect.option))) {
        return {state: 'unavailable'} as const satisfies CodeGraphLocalProvenanceInventory;
      }
      if (!(yield* fs.exists(localContext))) {
        return {state: 'ready', worktreeIds: []} as const satisfies CodeGraphLocalProvenanceInventory;
      }
      const canonicalContext = yield* inspectPrivateContainedDirectory(fs, path, checkoutRoot, localContext);
      const worktrees = path.join(canonicalContext, LOCAL_WORKTREES_DIRECTORY);
      if (Option.isSome(yield* fs.readLink(worktrees).pipe(Effect.option))) {
        return {state: 'unavailable'} as const satisfies CodeGraphLocalProvenanceInventory;
      }
      if (!(yield* fs.exists(worktrees))) {
        return {state: 'ready', worktreeIds: []} as const satisfies CodeGraphLocalProvenanceInventory;
      }
      const canonicalWorktrees = yield* inspectPrivateContainedDirectory(fs, path, canonicalContext, worktrees);
      const page = yield* runtimeTextDirectoryNamePage(
        canonicalWorktrees,
        CODE_GRAPH_LOCAL_PROVENANCE_INVENTORY_ENTRY_LIMIT,
      );
      if (page.overflow) {
        return {state: 'unavailable'} as const satisfies CodeGraphLocalProvenanceInventory;
      }
      const worktreeIds = page.names
        .filter(name => /^[0-9a-f]{64}\.json$/.test(name))
        .map(name => name.slice(0, -5))
        .sort();
      return {state: 'ready', worktreeIds} as const satisfies CodeGraphLocalProvenanceInventory;
    }).pipe(Effect.orElseSucceed(() => ({state: 'unavailable'}) as const satisfies CodeGraphLocalProvenanceInventory));
  },
);

/**
 * Persist a path only after the caller resolved the complete Git identity. Failures are represented
 * as a path-free state so provenance remains supplemental and cannot break graph reads or builds.
 */
export const recordVerifiedCodeGraphLocalAssociation = Effect.fn('codeGraph.recordVerifiedLocalAssociation')(function* (
  threadnoteHome: string,
  identity: RepositoryIdentity,
  options: CodeGraphLocalProvenanceObservationOptions = {},
) {
  const verified = yield* resolveMatchingRepositoryIdentity(identity).pipe(Effect.option);
  if (Option.isNone(verified)) return unavailableAssociation('invalid');
  return yield* recordResolvedCodeGraphLocalAssociation(
    threadnoteHome,
    verified.value.identity,
    options,
    verified.value.gitDirectory,
  );
});

/** Resolve and observe in one effect so cadence hits execute only one complete Git identity resolution. */
export const resolveAndRecordCodeGraphLocalAssociation = Effect.fn('codeGraph.resolveAndRecordLocalAssociation')(
  function* (threadnoteHome: string, cwd: string, options: ResolveCodeGraphLocalAssociationOptions = {}) {
    const resolved = yield* resolveRepositoryIdentityDetail(cwd);
    const identity = resolved.identity;
    yield* options.validateIdentity?.(identity) ?? Effect.void;
    const association = yield* recordResolvedCodeGraphLocalAssociation(
      threadnoteHome,
      identity,
      options,
      resolved.gitDirectory,
    );
    return {association, identity};
  },
);

export const withCodeGraphLocalProvenanceLock = Effect.fn('codeGraph.withLocalProvenanceLock')(function* <A, E, R>(
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  waitTimeoutMilliseconds: number,
  effect: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withExclusiveFileLock(
    fs,
    codeGraphLocalProvenanceLockPath(path, threadnoteHome, checkoutId, worktreeId),
    {
      retryIntervalMilliseconds: 10,
      staleAfterMilliseconds: 120_000,
      waitTimeoutMilliseconds,
    },
    effect,
  );
});

const recordResolvedCodeGraphLocalAssociation = Effect.fn('codeGraph.recordResolvedLocalAssociation')(function* (
  threadnoteHome: string,
  identity: RepositoryIdentity,
  options: CodeGraphLocalProvenanceObservationOptions,
  observedGitDirectory?: string,
) {
  return yield* withCodeGraphLocalProvenanceLock(
    threadnoteHome,
    identity.checkoutId,
    identity.worktreeId,
    5_000,
    recordResolvedCodeGraphLocalAssociationUnlocked(threadnoteHome, identity, options, observedGitDirectory),
  ).pipe(Effect.orElseSucceed(() => unavailableAssociation('invalid')));
});

const recordResolvedCodeGraphLocalAssociationUnlocked = Effect.fn('codeGraph.recordResolvedLocalAssociationUnlocked')(
  function* (
    threadnoteHome: string,
    identity: RepositoryIdentity,
    options: CodeGraphLocalProvenanceObservationOptions,
    observedGitDirectory?: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    const directory = yield* ensureLocalWorktreeDirectory(fs, path, threadnoteHome, identity.checkoutId).pipe(
      Effect.option,
    );
    if (Option.isNone(directory)) return unavailableAssociation('invalid');
    const target = path.join(directory.value, `${identity.worktreeId}.json`);
    if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return unavailableAssociation('invalid');
    const existing = yield* readObservedRecordWithoutResolution(fs, target, {
      checkoutId: identity.checkoutId,
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
    });
    const now = yield* Clock.currentTimeMillis;
    const registration = yield* captureCodeGraphGitWorktreeRegistration(identity, observedGitDirectory).pipe(
      Effect.option,
    );
    if (Option.isNone(registration)) return unavailableAssociation('invalid');
    if (
      existing?.canonicalWorktreePath === identity.repoRoot &&
      existing.headCommit === identity.headCommit &&
      existing.branch === identity.branch &&
      existing.schemaVersion === LOCAL_PROVENANCE_SCHEMA_VERSION &&
      sameCodeGraphGitWorktreeRegistration(existing.registration, registration.value) &&
      now - Date.parse(existing.observedAt) >= 0 &&
      now - Date.parse(existing.observedAt) < LOCAL_PROVENANCE_REFRESH_MILLISECONDS
    ) {
      return yield* associationForRecord(path, existing, 'verified');
    }

    const record = {
      ...(identity.branch === undefined ? {} : {branch: identity.branch}),
      canonicalWorktreePath: identity.repoRoot,
      checkoutId: identity.checkoutId,
      headCommit: identity.headCommit,
      observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      registration: registration.value,
      repositoryId: identity.repositoryId,
      schemaVersion: LOCAL_PROVENANCE_SCHEMA_VERSION,
      worktreeId: identity.worktreeId,
    } satisfies CodeGraphLocalProvenanceRecord;
    const content = `${JSON.stringify(record)}\n`;
    if (new TextEncoder().encode(content).byteLength > LOCAL_PROVENANCE_BYTES_LIMIT) {
      return unavailableAssociation('invalid');
    }

    const temporary = path.join(
      directory.value,
      `.${identity.worktreeId}.${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}.tmp`,
    );
    const written = yield* Effect.gen(function* () {
      yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
      yield* fs.chmod(temporary, 0o600);
      yield* syncFile(fs, temporary);
      const revalidated = yield* inspectPrivateContainedDirectory(
        fs,
        path,
        path.dirname(directory.value),
        directory.value,
      );
      if (revalidated !== directory.value) {
        return yield* CodeGraphLocalProvenanceError.make({
          message: 'Code graph local provenance directory changed during observation.',
        });
      }
      if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
        return yield* CodeGraphLocalProvenanceError.make({
          message: 'Code graph local provenance target is a symbolic link.',
        });
      }
      yield* options.beforePublishValidation?.() ?? Effect.void;
      const finalIdentity = yield* resolveMatchingRepositoryIdentity(identity);
      const finalRegistration = yield* captureCodeGraphGitWorktreeRegistration(
        finalIdentity.identity,
        finalIdentity.gitDirectory,
      );
      if (!sameCodeGraphGitWorktreeRegistration(record.registration, finalRegistration)) {
        return yield* CodeGraphLocalProvenanceError.make({
          message: 'Code graph local provenance registration changed during observation.',
        });
      }
      yield* fs.rename(temporary, target);
      yield* syncDirectory(fs, directory.value);
    }).pipe(
      Effect.onError(() => fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
      Effect.option,
    );
    return Option.isSome(written)
      ? yield* associationForRecord(path, record, 'verified')
      : unavailableAssociation('invalid');
  },
);

/**
 * Read and re-resolve one private association. A live Manager context may repair only the exact
 * checkout/worktree/repository tuple; no filesystem search or hash reversal is attempted.
 */
export const readCodeGraphLocalAssociation = Effect.fn('codeGraph.readLocalAssociation')(function* (
  threadnoteHome: string,
  target: CodeGraphLocalAssociationTarget,
  liveWorktreePath?: string,
) {
  const current = yield* readPersistedCodeGraphLocalAssociation(threadnoteHome, target);
  if (current.state === 'verified' || liveWorktreePath === undefined) return current;
  const resolved = yield* resolveAndRecordCodeGraphLocalAssociation(threadnoteHome, liveWorktreePath, {
    validateIdentity: identity =>
      identity.checkoutId === target.checkoutId &&
      identity.worktreeId === target.worktreeId &&
      (target.repositoryId === undefined || identity.repositoryId === target.repositoryId)
        ? Effect.void
        : Effect.fail(
            CodeGraphLocalProvenanceError.make({
              message: 'Live worktree identity does not match the requested graph association.',
            }),
          ),
  }).pipe(Effect.option);
  return Option.isSome(resolved) && resolved.value.association.state === 'verified'
    ? resolved.value.association
    : current;
});

export const readPersistedCodeGraphLocalAssociation = Effect.fn('codeGraph.readPersistedLocalAssociation')(function* (
  threadnoteHome: string,
  target: CodeGraphLocalAssociationTarget,
) {
  return yield* readPersistedCodeGraphLocalAssociationUnchecked(threadnoteHome, target).pipe(
    Effect.orElseSucceed(() => unavailableAssociation('invalid')),
  );
});

/**
 * Read private registration evidence without probing the remembered worktree path. Legacy records
 * remain valid for trusted display, but are deliberately unusable as automatic deletion evidence.
 */
export const readCodeGraphLocalReconciliationEvidence = Effect.fn('codeGraph.readLocalReconciliationEvidence')(
  function* (threadnoteHome: string, target: CodeGraphLocalAssociationTarget) {
    return yield* readCodeGraphLocalReconciliationEvidenceUnchecked(threadnoteHome, target).pipe(
      Effect.orElseSucceed(() => ({state: 'invalid'}) as const satisfies CodeGraphLocalReconciliationEvidence),
    );
  },
);

/**
 * Return missing authority only while the exact private v2 record is stable
 * across the missing-path observation. This never resolves Git from the
 * remembered path and never returns that path to the caller.
 */
export const readMissingCodeGraphWorktreeReconciliationEvidence = Effect.fn(
  'codeGraph.readMissingWorktreeReconciliationEvidence',
)(function* (
  threadnoteHome: string,
  target: CodeGraphLocalAssociationTarget,
  options: CodeGraphMissingWorktreeReconciliationOptions = {},
) {
  const initial = yield* readCodeGraphWorktreeReconciliationEvidenceCandidate(threadnoteHome, target);
  if (initial.state !== 'candidate') return initial;
  yield* options.beforeFinalMissingObservation?.() ?? Effect.void;
  const observed = yield* observeCodeGraphRecordedWorktreePaths([initial.canonicalWorktreePath]);
  if (observed.state !== 'complete') {
    return {state: 'invalid'} as const satisfies CodeGraphMissingWorktreeReconciliationEvidence;
  }
  if (observed.pathStates[0] !== 'missing') {
    return {state: 'present'} as const satisfies CodeGraphMissingWorktreeReconciliationEvidence;
  }
  const final = yield* readCodeGraphWorktreeReconciliationEvidenceCandidate(threadnoteHome, target);
  if (final.state !== 'candidate' || !sameCodeGraphWorktreeReconciliationEvidenceCandidate(initial, final)) {
    return {state: 'invalid'} as const satisfies CodeGraphMissingWorktreeReconciliationEvidence;
  }
  return {
    checkoutId: final.checkoutId,
    recordDigest: final.recordDigest,
    recordIdentity: final.recordIdentity,
    registration: final.registration,
    repositoryId: final.repositoryId,
    state: 'missing',
    worktreeId: final.worktreeId,
  } satisfies CodeGraphMissingWorktreeReconciliationEvidence;
});

export const readCodeGraphWorktreeReconciliationEvidenceCandidate = Effect.fn(
  'codeGraph.readWorktreeReconciliationEvidenceCandidate',
)(function* (threadnoteHome: string, target: CodeGraphLocalAssociationTarget) {
  if (!validTarget(target)) {
    return {state: 'invalid'} as const satisfies CodeGraphWorktreeReconciliationEvidenceCandidate;
  }
  return yield* withCodeGraphLocalProvenanceLock(
    threadnoteHome,
    target.checkoutId,
    target.worktreeId,
    0,
    Effect.gen(function* () {
      const evidence = yield* readCodeGraphLocalReconciliationEvidenceUnchecked(threadnoteHome, target);
      if (evidence.state !== 'verified') return evidence;
      if (evidence.registration.kind !== 'linked') {
        return {state: 'main'} as const satisfies CodeGraphWorktreeReconciliationEvidenceCandidate;
      }
      const initial = yield* readLocalProvenanceCleanupCandidate(threadnoteHome, target);
      if (initial === undefined || !reconciliationEvidenceMatchesCandidate(evidence, initial)) {
        return {state: 'invalid'} as const satisfies CodeGraphWorktreeReconciliationEvidenceCandidate;
      }
      const final = yield* readLocalProvenanceCleanupCandidate(threadnoteHome, target);
      if (final === undefined || !sameLocalProvenanceCleanupCandidate(initial, final)) {
        return {state: 'invalid'} as const satisfies CodeGraphWorktreeReconciliationEvidenceCandidate;
      }
      return {
        canonicalWorktreePath: final.record.canonicalWorktreePath,
        checkoutId: evidence.checkoutId,
        evidenceToken: sha256HexSync(
          `threadnote-worktree-reconciliation-evidence-v1\0${evidence.recordDigest}\0${evidence.recordIdentity}`,
        ),
        recordDigest: evidence.recordDigest,
        recordIdentity: evidence.recordIdentity,
        registration: evidence.registration,
        repositoryId: evidence.repositoryId,
        state: 'candidate',
        worktreeId: evidence.worktreeId,
      } satisfies CodeGraphWorktreeReconciliationEvidenceCandidate;
    }),
  ).pipe(
    Effect.orElseSucceed(
      () => ({state: 'invalid'}) as const satisfies CodeGraphWorktreeReconciliationEvidenceCandidate,
    ),
  );
});

export function sameCodeGraphWorktreeReconciliationEvidenceCandidate(
  left: Extract<CodeGraphWorktreeReconciliationEvidenceCandidate, {readonly state: 'candidate'}>,
  right: Extract<CodeGraphWorktreeReconciliationEvidenceCandidate, {readonly state: 'candidate'}>,
): boolean {
  return (
    left.canonicalWorktreePath === right.canonicalWorktreePath &&
    left.checkoutId === right.checkoutId &&
    left.evidenceToken === right.evidenceToken &&
    left.recordDigest === right.recordDigest &&
    left.recordIdentity === right.recordIdentity &&
    left.repositoryId === right.repositoryId &&
    left.worktreeId === right.worktreeId &&
    sameCodeGraphGitWorktreeRegistration(left.registration, right.registration)
  );
}

/**
 * Capture one exact path-free cleanup token while holding the provenance lock.
 * Callers must release this lock before entering the database writer gate.
 */
export const captureCodeGraphLocalProvenanceCleanupEvidence = Effect.fn(
  'codeGraph.captureLocalProvenanceCleanupEvidence',
)(function* (threadnoteHome: string, target: CodeGraphLocalAssociationTarget) {
  if (!validTarget(target)) return undefined;
  return yield* withCodeGraphLocalProvenanceLock(
    threadnoteHome,
    target.checkoutId,
    target.worktreeId,
    0,
    Effect.gen(function* () {
      const evidence = yield* readCodeGraphLocalReconciliationEvidenceUnchecked(threadnoteHome, target);
      if (evidence.state !== 'verified') return undefined;
      const initial = yield* readLocalProvenanceCleanupCandidate(threadnoteHome, target);
      const final = yield* readLocalProvenanceCleanupCandidate(threadnoteHome, target);
      if (
        initial === undefined ||
        final === undefined ||
        !reconciliationEvidenceMatchesCandidate(evidence, initial) ||
        !sameLocalProvenanceCleanupCandidate(initial, final)
      ) {
        return undefined;
      }
      return {
        checkoutId: evidence.checkoutId,
        recordDigest: evidence.recordDigest,
        recordIdentity: evidence.recordIdentity,
        repositoryId: evidence.repositoryId,
        worktreeId: evidence.worktreeId,
      } satisfies CodeGraphLocalProvenanceCleanupEvidence;
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * Delete only a private derived provenance sidecar whose recorded worktree is
 * still missing and whose complete file/content identity has not changed.
 * Source, Git, and remembered worktree paths are observation-only.
 */
const cleanupMissingCodeGraphLocalProvenanceUnsafe = Effect.fn('codeGraph.cleanupMissingLocalProvenanceUnsafe')(
  function* (
    threadnoteHome: string,
    target: CodeGraphLocalAssociationTarget,
    options: CodeGraphLocalProvenanceCleanupOptions = {},
  ) {
    if (!validTarget(target)) return {state: 'unavailable'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    const evidence = yield* readCodeGraphLocalReconciliationEvidence(threadnoteHome, target);
    if (evidence.state !== 'verified') {
      if (
        evidence.state === 'legacy-unknown' &&
        options.expectedEvidence !== undefined &&
        validLocalProvenanceCleanupEvidenceTarget(options.expectedEvidence, target) &&
        (yield* codeGraphLocalProvenanceSidecarAbsent(threadnoteHome, target))
      ) {
        return {state: 'not-found'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
      }
      return {
        observedState: evidence.state,
        state: 'preserved',
      } as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    const initial = yield* readLocalProvenanceCleanupCandidate(threadnoteHome, target);
    if (initial === undefined) {
      return {state: 'not-found'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    if (
      options.expectedEvidence !== undefined &&
      !localProvenanceCleanupEvidenceMatchesCandidate(options.expectedEvidence, initial)
    ) {
      return {observedState: 'stale', state: 'preserved'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    if (!(yield* recordedWorktreePathMissing(initial.record.canonicalWorktreePath))) {
      return {observedState: 'stale', state: 'preserved'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }

    yield* options.beforeFinalObservation?.() ?? Effect.void;
    const observed = yield* readLocalProvenanceCleanupCandidate(threadnoteHome, target);
    if (observed === undefined) {
      return {state: 'not-found'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    if (!sameLocalProvenanceCleanupCandidate(initial, observed)) {
      return {observedState: 'stale', state: 'preserved'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    if (!(yield* recordedWorktreePathMissing(observed.record.canonicalWorktreePath))) {
      return {observedState: 'stale', state: 'preserved'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }

    yield* options.beforeRemove?.() ?? Effect.void;
    const final = yield* readLocalProvenanceCleanupCandidate(threadnoteHome, target);
    if (final === undefined) {
      return {state: 'not-found'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    if (
      !sameLocalProvenanceCleanupCandidate(initial, final) ||
      !(yield* recordedWorktreePathMissing(final.record.canonicalWorktreePath))
    ) {
      return {observedState: 'stale', state: 'preserved'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    const fs = yield* FileSystem.FileSystem;
    if (Option.isSome(yield* fs.readLink(final.file).pipe(Effect.option))) {
      return {observedState: 'invalid', state: 'preserved'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    yield* options.afterFinalValidation?.() ?? Effect.void;
    const owned = yield* readLocalProvenanceCleanupCandidate(threadnoteHome, target);
    if (
      owned === undefined ||
      !sameLocalProvenanceCleanupCandidate(initial, owned) ||
      !(yield* recordedWorktreePathMissing(owned.record.canonicalWorktreePath))
    ) {
      return {observedState: 'stale', state: 'preserved'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    if (
      classifyCodeGraphLifecycle({authority: 'proven-disposable', state: 'orphaned-sidecar'}).disposition !== 'reclaim'
    ) {
      return {observedState: 'stale', state: 'preserved'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
    }
    yield* fs.remove(final.file, {force: false});
    return {state: 'removed'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
  },
);

const codeGraphLocalProvenanceSidecarAbsent = Effect.fn('codeGraph.localProvenanceSidecarAbsent')(function* (
  threadnoteHome: string,
  target: CodeGraphLocalAssociationTarget,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkoutRoot = yield* inspectCheckoutRoot(fs, path, threadnoteHome, target.checkoutId);
  if (checkoutRoot === undefined) return true;

  const localContext = path.join(checkoutRoot, LOCAL_CONTEXT_DIRECTORY);
  if (Option.isSome(yield* fs.readLink(localContext).pipe(Effect.option))) return false;
  if (!(yield* fs.exists(localContext))) return true;
  const canonicalContext = yield* inspectPrivateContainedDirectory(fs, path, checkoutRoot, localContext);
  const worktrees = path.join(canonicalContext, LOCAL_WORKTREES_DIRECTORY);
  if (Option.isSome(yield* fs.readLink(worktrees).pipe(Effect.option))) return false;
  if (!(yield* fs.exists(worktrees))) return true;
  const canonicalWorktrees = yield* inspectPrivateContainedDirectory(fs, path, canonicalContext, worktrees);

  const file = path.join(canonicalWorktrees, `${target.worktreeId}.json`);
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return false;
  if (Option.isSome(yield* optionOnNotFound(fs.stat(file)))) return false;
  return Option.isNone(yield* fs.readLink(file).pipe(Effect.option)) && !(yield* fs.exists(file));
});

export const cleanupMissingCodeGraphLocalProvenance = Effect.fn('codeGraph.cleanupMissingLocalProvenance')(function* (
  threadnoteHome: string,
  target: CodeGraphLocalAssociationTarget,
  options: CodeGraphLocalProvenanceCleanupOptions = {},
) {
  if (!validTarget(target)) return {state: 'unavailable'} as const satisfies CodeGraphLocalProvenanceCleanupResult;
  return yield* withCodeGraphLocalProvenanceLock(
    threadnoteHome,
    target.checkoutId,
    target.worktreeId,
    0,
    cleanupMissingCodeGraphLocalProvenanceUnsafe(threadnoteHome, target, options),
  ).pipe(Effect.orElseSucceed(() => ({state: 'unavailable'}) as const satisfies CodeGraphLocalProvenanceCleanupResult));
});

interface LocalProvenanceCleanupCandidate {
  readonly content: string;
  readonly file: string;
  readonly record: CodeGraphLocalProvenanceRecordV2;
  readonly recordDigest: string;
  readonly recordIdentity: string;
}

const readLocalProvenanceCleanupCandidate = Effect.fn('codeGraph.readLocalProvenanceCleanupCandidate')(function* (
  threadnoteHome: string,
  target: CodeGraphLocalAssociationTarget,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const checkoutRoot = yield* inspectCheckoutRoot(fs, path, threadnoteHome, target.checkoutId);
  if (checkoutRoot === undefined) return undefined;
  const localContext = path.join(checkoutRoot, LOCAL_CONTEXT_DIRECTORY);
  if (Option.isSome(yield* fs.readLink(localContext).pipe(Effect.option)) || !(yield* fs.exists(localContext))) {
    return undefined;
  }
  const canonicalContext = yield* inspectPrivateContainedDirectory(fs, path, checkoutRoot, localContext);
  const worktrees = path.join(canonicalContext, LOCAL_WORKTREES_DIRECTORY);
  if (Option.isSome(yield* fs.readLink(worktrees).pipe(Effect.option)) || !(yield* fs.exists(worktrees))) {
    return undefined;
  }
  const canonicalWorktrees = yield* inspectPrivateContainedDirectory(fs, path, canonicalContext, worktrees);
  const file = path.join(canonicalWorktrees, `${target.worktreeId}.json`);
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)) || !(yield* fs.exists(file))) return undefined;
  const info = yield* fs.stat(file);
  if (
    info.type !== 'File' ||
    Number(info.size) > LOCAL_PROVENANCE_BYTES_LIMIT ||
    (system.platform !== 'win32' && (info.mode & 0o777) !== 0o600)
  ) {
    return yield* CodeGraphLocalProvenanceError.make({
      message: 'Code graph local provenance cleanup target is invalid.',
    });
  }
  const content = yield* readBoundedObservedRegularFile(fs, file, info);
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return yield* CodeGraphLocalProvenanceError.make({message: 'Code graph local provenance cleanup target changed.'});
  }
  const record = parseCodeGraphLocalProvenanceRecordJson(content, target);
  if (record?.schemaVersion !== LOCAL_PROVENANCE_SCHEMA_VERSION) return undefined;
  if (!isCanonicalAbsolutePath(path, record.canonicalWorktreePath)) {
    return yield* CodeGraphLocalProvenanceError.make({
      message: 'Code graph local provenance cleanup record is invalid.',
    });
  }
  const recordDigest = sha256HexSync(content);
  return {
    content,
    file,
    record,
    recordDigest,
    recordIdentity: localProvenanceRecordIdentity(info, recordDigest),
  } satisfies LocalProvenanceCleanupCandidate;
});

const recordedWorktreePathMissing = Effect.fn('codeGraph.recordedWorktreePathMissing')(
  (canonicalWorktreePath: string) =>
    observeCodeGraphRecordedWorktreePaths([canonicalWorktreePath]).pipe(
      Effect.map(observation => observation.state === 'complete' && observation.pathStates[0] === 'missing'),
    ),
);

function sameLocalProvenanceCleanupCandidate(
  left: LocalProvenanceCleanupCandidate,
  right: LocalProvenanceCleanupCandidate,
): boolean {
  return (
    left.file === right.file &&
    left.content === right.content &&
    left.recordDigest === right.recordDigest &&
    left.recordIdentity === right.recordIdentity &&
    left.record.checkoutId === right.record.checkoutId &&
    left.record.worktreeId === right.record.worktreeId &&
    left.record.repositoryId === right.record.repositoryId &&
    left.record.canonicalWorktreePath === right.record.canonicalWorktreePath &&
    left.record.observedAt === right.record.observedAt &&
    left.record.headCommit === right.record.headCommit &&
    sameCodeGraphGitWorktreeRegistration(left.record.registration, right.record.registration)
  );
}

function localProvenanceCleanupEvidenceMatchesCandidate(
  evidence: CodeGraphLocalProvenanceCleanupEvidence,
  candidate: LocalProvenanceCleanupCandidate,
): boolean {
  return (
    evidence.checkoutId === candidate.record.checkoutId &&
    evidence.worktreeId === candidate.record.worktreeId &&
    evidence.repositoryId === candidate.record.repositoryId &&
    evidence.recordDigest === candidate.recordDigest &&
    evidence.recordIdentity === candidate.recordIdentity
  );
}

function validLocalProvenanceCleanupEvidenceTarget(
  evidence: CodeGraphLocalProvenanceCleanupEvidence,
  target: CodeGraphLocalAssociationTarget,
): boolean {
  return (
    evidence.checkoutId === target.checkoutId &&
    evidence.worktreeId === target.worktreeId &&
    (target.repositoryId === undefined || evidence.repositoryId === target.repositoryId) &&
    HASH_ID.test(evidence.repositoryId) &&
    HASH_ID.test(evidence.recordDigest) &&
    HASH_ID.test(evidence.recordIdentity)
  );
}

function reconciliationEvidenceMatchesCandidate(
  evidence: Extract<CodeGraphLocalReconciliationEvidence, {readonly state: 'verified'}>,
  candidate: LocalProvenanceCleanupCandidate,
): boolean {
  return (
    evidence.checkoutId === candidate.record.checkoutId &&
    evidence.worktreeId === candidate.record.worktreeId &&
    evidence.repositoryId === candidate.record.repositoryId &&
    evidence.recordDigest === candidate.recordDigest &&
    evidence.recordIdentity === candidate.recordIdentity &&
    sameCodeGraphGitWorktreeRegistration(evidence.registration, candidate.record.registration)
  );
}

const readCodeGraphLocalReconciliationEvidenceUnchecked = Effect.fn(
  'codeGraph.readLocalReconciliationEvidenceUnchecked',
)(function* (threadnoteHome: string, target: CodeGraphLocalAssociationTarget) {
  if (!validTarget(target)) return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const checkoutRoot = yield* inspectCheckoutRoot(fs, path, threadnoteHome, target.checkoutId).pipe(Effect.option);
  if (Option.isNone(checkoutRoot)) return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  if (checkoutRoot.value === undefined) {
    return {state: 'legacy-unknown'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }

  const localContext = path.join(checkoutRoot.value, LOCAL_CONTEXT_DIRECTORY);
  if (Option.isSome(yield* fs.readLink(localContext).pipe(Effect.option))) {
    return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  if (!(yield* fs.exists(localContext))) {
    return {state: 'legacy-unknown'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  const canonicalContext = yield* inspectPrivateContainedDirectory(fs, path, checkoutRoot.value, localContext).pipe(
    Effect.option,
  );
  if (Option.isNone(canonicalContext)) {
    return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  const worktrees = path.join(canonicalContext.value, LOCAL_WORKTREES_DIRECTORY);
  if (Option.isSome(yield* fs.readLink(worktrees).pipe(Effect.option))) {
    return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  if (!(yield* fs.exists(worktrees))) {
    return {state: 'legacy-unknown'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  const canonicalWorktrees = yield* inspectPrivateContainedDirectory(fs, path, canonicalContext.value, worktrees).pipe(
    Effect.option,
  );
  if (Option.isNone(canonicalWorktrees)) {
    return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }

  const file = path.join(canonicalWorktrees.value, `${target.worktreeId}.json`);
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  if (!(yield* fs.exists(file))) {
    return {state: 'legacy-unknown'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  const info = yield* optionOnNotFound(fs.stat(file));
  if (Option.isNone(info)) {
    return {state: 'legacy-unknown'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  if (
    info.value.type !== 'File' ||
    Number(info.value.size) > LOCAL_PROVENANCE_BYTES_LIMIT ||
    (system.platform !== 'win32' && (info.value.mode & 0o777) !== 0o600)
  ) {
    return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  const content = yield* optionOnNotFound(readBoundedObservedRegularFile(fs, file, info.value));
  if (Option.isNone(content)) {
    return {state: 'legacy-unknown'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  const record = parseCodeGraphLocalProvenanceRecordJson(content.value, target);
  if (record === undefined) return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  if (!isCanonicalAbsolutePath(path, record.canonicalWorktreePath)) {
    return {state: 'invalid'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  if (record.schemaVersion !== LOCAL_PROVENANCE_SCHEMA_VERSION) {
    return {state: 'legacy-unknown'} as const satisfies CodeGraphLocalReconciliationEvidence;
  }
  const recordDigest = sha256HexSync(content.value);
  return {
    checkoutId: record.checkoutId,
    recordDigest,
    recordIdentity: localProvenanceRecordIdentity(info.value, recordDigest),
    registration: record.registration,
    repositoryId: record.repositoryId,
    state: 'verified',
    worktreeId: record.worktreeId,
  } as const satisfies CodeGraphLocalReconciliationEvidence;
});

const readPersistedCodeGraphLocalAssociationUnchecked = Effect.fn('codeGraph.readPersistedLocalAssociationUnchecked')(
  function* (threadnoteHome: string, target: CodeGraphLocalAssociationTarget) {
    if (!validTarget(target)) return unavailableAssociation('invalid');
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const checkoutRoot = yield* inspectCheckoutRoot(fs, path, threadnoteHome, target.checkoutId).pipe(Effect.option);
    if (Option.isNone(checkoutRoot)) return unavailableAssociation('invalid');
    if (checkoutRoot.value === undefined) return unavailableAssociation('legacy-unknown');

    const localContext = path.join(checkoutRoot.value, LOCAL_CONTEXT_DIRECTORY);
    if (Option.isSome(yield* fs.readLink(localContext).pipe(Effect.option))) {
      return unavailableAssociation('invalid');
    }
    if (!(yield* fs.exists(localContext))) return unavailableAssociation('legacy-unknown');
    const canonicalContext = yield* inspectPrivateContainedDirectory(fs, path, checkoutRoot.value, localContext).pipe(
      Effect.option,
    );
    if (Option.isNone(canonicalContext)) return unavailableAssociation('invalid');
    const worktrees = path.join(canonicalContext.value, LOCAL_WORKTREES_DIRECTORY);
    if (Option.isSome(yield* fs.readLink(worktrees).pipe(Effect.option))) {
      return unavailableAssociation('invalid');
    }
    if (!(yield* fs.exists(worktrees))) return unavailableAssociation('legacy-unknown');
    const canonicalWorktrees = yield* inspectPrivateContainedDirectory(
      fs,
      path,
      canonicalContext.value,
      worktrees,
    ).pipe(Effect.option);
    if (Option.isNone(canonicalWorktrees)) return unavailableAssociation('invalid');

    const file = path.join(canonicalWorktrees.value, `${target.worktreeId}.json`);
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return unavailableAssociation('invalid');
    if (!(yield* fs.exists(file))) return unavailableAssociation('legacy-unknown');
    const info = yield* optionOnNotFound(fs.stat(file));
    if (Option.isNone(info)) return unavailableAssociation('legacy-unknown');
    if (
      info.value.type !== 'File' ||
      Number(info.value.size) > LOCAL_PROVENANCE_BYTES_LIMIT ||
      (system.platform !== 'win32' && (info.value.mode & 0o777) !== 0o600)
    ) {
      return unavailableAssociation('invalid');
    }
    const content = yield* optionOnNotFound(readBoundedObservedRegularFile(fs, file, info.value));
    if (Option.isNone(content)) return unavailableAssociation('legacy-unknown');
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return unavailableAssociation('invalid');
    const parsed = parseCodeGraphLocalProvenanceRecordJson(content.value, target);
    if (!parsed) return unavailableAssociation('invalid');

    if (!isCanonicalAbsolutePath(path, parsed.canonicalWorktreePath)) return unavailableAssociation('invalid');
    if (!(yield* fs.exists(parsed.canonicalWorktreePath))) {
      return yield* associationForRecord(path, parsed, 'missing');
    }
    const worktreeInfo = yield* optionOnNotFound(fs.stat(parsed.canonicalWorktreePath));
    if (Option.isNone(worktreeInfo)) return yield* associationForRecord(path, parsed, 'missing');
    if (worktreeInfo.value.type !== 'Directory') return unavailableAssociation('stale');
    const canonicalWorktreePath = yield* optionOnNotFound(fs.realPath(parsed.canonicalWorktreePath));
    if (Option.isNone(canonicalWorktreePath)) return yield* associationForRecord(path, parsed, 'missing');
    if (canonicalWorktreePath.value !== parsed.canonicalWorktreePath) return unavailableAssociation('stale');
    const now = yield* Clock.currentTimeMillis;
    const age = now - Date.parse(parsed.observedAt);
    if (age >= 0 && age < LOCAL_PROVENANCE_REFRESH_MILLISECONDS) {
      return yield* associationForRecord(path, parsed, 'verified');
    }
    const resolved = yield* resolveRepositoryIdentityDetail(parsed.canonicalWorktreePath).pipe(Effect.option);
    if (
      Option.isNone(resolved) ||
      resolved.value.identity.repoRoot !== parsed.canonicalWorktreePath ||
      resolved.value.identity.checkoutId !== parsed.checkoutId ||
      resolved.value.identity.worktreeId !== parsed.worktreeId ||
      resolved.value.identity.repositoryId !== parsed.repositoryId
    ) {
      return unavailableAssociation('stale');
    }
    return yield* recordResolvedCodeGraphLocalAssociation(
      threadnoteHome,
      resolved.value.identity,
      {},
      resolved.value.gitDirectory,
    );
  },
);

export function parseCodeGraphLocalProvenanceRecordJson(
  content: string,
  target?: CodeGraphLocalAssociationTarget,
): CodeGraphLocalProvenanceRecord | undefined {
  if (new TextEncoder().encode(content).byteLength > LOCAL_PROVENANCE_BYTES_LIMIT) return undefined;
  try {
    return parseCodeGraphLocalProvenanceRecord(JSON.parse(content), target);
  } catch {
    return undefined;
  }
}

export function parseCodeGraphLocalProvenanceRecord(
  value: unknown,
  target?: CodeGraphLocalAssociationTarget,
): CodeGraphLocalProvenanceRecord | undefined {
  if (!Predicate.isObject(value)) return undefined;
  if (
    (value.schemaVersion !== LOCAL_PROVENANCE_LEGACY_SCHEMA_VERSION &&
      value.schemaVersion !== LOCAL_PROVENANCE_SCHEMA_VERSION) ||
    !isHash(value.checkoutId) ||
    !isHash(value.worktreeId) ||
    !isHash(value.repositoryId) ||
    !isCanonicalTimestamp(value.observedAt) ||
    !isLocalPath(value.canonicalWorktreePath) ||
    (value.headCommit !== undefined && (typeof value.headCommit !== 'string' || !COMMIT_ID.test(value.headCommit))) ||
    (value.branch !== undefined && !isBranchName(value.branch))
  ) {
    return undefined;
  }
  const registration =
    value.schemaVersion === LOCAL_PROVENANCE_SCHEMA_VERSION
      ? parseCodeGraphGitWorktreeRegistration(value.registration)
      : undefined;
  if (value.schemaVersion === LOCAL_PROVENANCE_SCHEMA_VERSION && registration === undefined) return undefined;
  if (
    target !== undefined &&
    (value.checkoutId !== target.checkoutId ||
      value.worktreeId !== target.worktreeId ||
      (target.repositoryId !== undefined && value.repositoryId !== target.repositoryId))
  ) {
    return undefined;
  }
  const base = {
    ...(value.branch === undefined ? {} : {branch: value.branch}),
    canonicalWorktreePath: value.canonicalWorktreePath,
    checkoutId: value.checkoutId,
    ...(value.headCommit === undefined ? {} : {headCommit: value.headCommit}),
    observedAt: value.observedAt,
    repositoryId: value.repositoryId,
    worktreeId: value.worktreeId,
  };
  return value.schemaVersion === LOCAL_PROVENANCE_SCHEMA_VERSION
    ? {...base, registration: registration!, schemaVersion: LOCAL_PROVENANCE_SCHEMA_VERSION}
    : {...base, schemaVersion: LOCAL_PROVENANCE_LEGACY_SCHEMA_VERSION};
}

export function privacySafeCodeGraphLocalAssociation(
  association: CodeGraphLocalAssociation,
): Pick<CodeGraphLocalAssociation, 'available' | 'state'> {
  return {available: association.available, state: association.state};
}

export function codeGraphLocalAssociationLabel(association: CodeGraphLocalAssociation): string {
  return association.displayPath ?? association.state.replaceAll('-', ' ');
}

function validTarget(target: CodeGraphLocalAssociationTarget): boolean {
  return (
    HASH_ID.test(target.checkoutId) &&
    HASH_ID.test(target.worktreeId) &&
    (target.repositoryId === undefined || HASH_ID.test(target.repositoryId))
  );
}

function resolveMatchingRepositoryIdentity(identity: RepositoryIdentity) {
  return Effect.gen(function* () {
    if (!validTarget(identity) || !COMMIT_ID.test(identity.headCommit)) {
      return yield* CodeGraphLocalProvenanceError.make({message: 'Code graph local provenance identity is invalid.'});
    }
    const resolvedDetail = yield* resolveRepositoryIdentityDetail(identity.repoRoot);
    const resolved = resolvedDetail.identity;
    if (
      resolved.repoRoot !== identity.repoRoot ||
      resolved.gitCommonDirectory !== identity.gitCommonDirectory ||
      resolved.checkoutId !== identity.checkoutId ||
      resolved.worktreeId !== identity.worktreeId ||
      resolved.repositoryId !== identity.repositoryId ||
      resolved.headCommit !== identity.headCommit ||
      resolved.branch !== identity.branch
    ) {
      return yield* CodeGraphLocalProvenanceError.make({
        message: 'Code graph local provenance identity changed before observation.',
      });
    }
    return resolvedDetail;
  });
}

function readObservedRecordWithoutResolution(
  fs: FileSystem.FileSystem,
  file: string,
  target: CodeGraphLocalAssociationTarget,
) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(file))) return undefined;
    const system = yield* SystemInfo;
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return undefined;
    const before = yield* fs.stat(file);
    if (
      before.type !== 'File' ||
      Number(before.size) > LOCAL_PROVENANCE_BYTES_LIMIT ||
      (system.platform !== 'win32' && (before.mode & 0o777) !== 0o600)
    ) {
      return undefined;
    }
    const content = yield* readBoundedObservedRegularFile(fs, file, before);
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return undefined;
    return parseCodeGraphLocalProvenanceRecordJson(content, target);
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function ensureLocalWorktreeDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
) {
  return Effect.gen(function* () {
    if (!HASH_ID.test(checkoutId))
      return yield* CodeGraphLocalProvenanceError.make({message: 'Code graph checkout identity is invalid.'});
    const canonicalHome = yield* fs.realPath(threadnoteHome);
    const indexes = yield* ensureContainedDirectory(fs, path, canonicalHome, 'indexes', false);
    const codeGraph = yield* ensureContainedDirectory(fs, path, indexes, 'code-graph', false);
    const repositories = yield* ensureContainedDirectory(fs, path, codeGraph, 'repositories', true);
    const checkoutRoot = yield* ensureContainedDirectory(fs, path, repositories, checkoutId, true);
    const localContext = yield* ensureContainedDirectory(fs, path, checkoutRoot, LOCAL_CONTEXT_DIRECTORY, true);
    return yield* ensureContainedDirectory(fs, path, localContext, LOCAL_WORKTREES_DIRECTORY, true);
  });
}

function inspectCheckoutRoot(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
): Effect.Effect<string | undefined, Error> {
  return Effect.gen(function* () {
    const canonicalHome = yield* fs.realPath(threadnoteHome);
    const indexes = yield* inspectOptionalContainedDirectory(fs, path, canonicalHome, 'indexes');
    if (indexes === undefined) return undefined;
    const codeGraph = yield* inspectOptionalContainedDirectory(fs, path, indexes, 'code-graph');
    if (codeGraph === undefined) return undefined;
    const repositories = yield* inspectOptionalContainedDirectory(fs, path, codeGraph, 'repositories');
    if (repositories === undefined) return undefined;
    return yield* inspectOptionalContainedDirectory(fs, path, repositories, checkoutId);
  });
}

function ensureContainedDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  canonicalParent: string,
  name: string,
  privateDirectory: boolean,
) {
  return Effect.gen(function* () {
    const directory = path.join(canonicalParent, name);
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* CodeGraphLocalProvenanceError.make({
        message: 'Code graph local provenance directory is a symbolic link.',
      });
    }
    yield* fs.makeDirectory(directory, {recursive: true, mode: privateDirectory ? 0o700 : 0o755});
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* CodeGraphLocalProvenanceError.make({
        message: 'Code graph local provenance directory is a symbolic link.',
      });
    }
    const canonical = yield* inspectContainedDirectory(fs, path, canonicalParent, directory);
    if (privateDirectory) yield* fs.chmod(canonical, 0o700);
    return canonical;
  });
}

function inspectOptionalContainedDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  canonicalParent: string,
  name: string,
) {
  return Effect.gen(function* () {
    const directory = path.join(canonicalParent, name);
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* CodeGraphLocalProvenanceError.make({
        message: 'Code graph local provenance directory is a symbolic link.',
      });
    }
    if (!(yield* fs.exists(directory))) return undefined;
    return yield* inspectContainedDirectory(fs, path, canonicalParent, directory);
  });
}

function inspectPrivateContainedDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  canonicalParent: string,
  directory: string,
) {
  return Effect.gen(function* () {
    const canonical = yield* inspectContainedDirectory(fs, path, canonicalParent, directory);
    const info = yield* fs.stat(canonical);
    const system = yield* SystemInfo;
    const mode = system.platform === 'win32' ? 0o700 : info.mode;
    if ((mode & 0o777) === 0o700) return canonical;
    return yield* CodeGraphLocalProvenanceError.make({
      message: 'Code graph local provenance directory permissions are not private.',
    });
  });
}

function inspectContainedDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  canonicalParent: string,
  directory: string,
) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* CodeGraphLocalProvenanceError.make({
        message: 'Code graph local provenance directory is a symbolic link.',
      });
    }
    const info = yield* fs.stat(directory);
    if (info.type !== 'Directory') {
      return yield* CodeGraphLocalProvenanceError.make({
        message: 'Code graph local provenance path is not a directory.',
      });
    }
    const canonical = yield* fs.realPath(directory);
    if (path.dirname(canonical) !== canonicalParent || path.basename(canonical) !== path.basename(directory)) {
      return yield* CodeGraphLocalProvenanceError.make({
        message: 'Code graph local provenance path escaped its checkout.',
      });
    }
    return canonical;
  });
}

function associationForRecord(path: Path.Path, record: CodeGraphLocalProvenanceRecord, state: 'missing' | 'verified') {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    return {
      available: state === 'verified',
      ...(record.branch === undefined ? {} : {branch: record.branch}),
      displayPath: homeAbbreviatedPath(path, system.homeDirectory, record.canonicalWorktreePath),
      observedAt: record.observedAt,
      path: record.canonicalWorktreePath,
      state,
    } satisfies CodeGraphLocalAssociation;
  });
}

function unavailableAssociation(state: Exclude<CodeGraphLocalAssociationState, 'verified'>) {
  return {available: false, state} satisfies CodeGraphLocalAssociation;
}

function homeAbbreviatedPath(path: Path.Path, homeDirectory: string, candidate: string): string {
  const relative = path.relative(homeDirectory, candidate);
  if (relative === '') return '~';
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return `~${path.sep}${relative}`;
  return candidate;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_ID.test(value);
}

function isBranchName(value: unknown): value is string {
  return typeof value === 'string' && normalizeRepositoryBranchName(value) === value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isLocalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LOCAL_PATH_LENGTH_LIMIT &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\'))
  );
}

function isCanonicalAbsolutePath(path: Path.Path, candidate: string): boolean {
  return path.isAbsolute(candidate) && path.normalize(candidate) === candidate;
}

function sameObservedRegularFile(before: FileSystem.File.Info, after: FileSystem.File.Info): boolean {
  const beforeInode = Option.getOrUndefined(before.ino);
  const afterInode = Option.getOrUndefined(after.ino);
  const beforeMtime = Option.getOrUndefined(before.mtime)?.getTime();
  const afterMtime = Option.getOrUndefined(after.mtime)?.getTime();
  return (
    before.type === 'File' &&
    after.type === 'File' &&
    before.dev === after.dev &&
    beforeInode !== undefined &&
    afterInode !== undefined &&
    beforeInode === afterInode &&
    before.size === after.size &&
    before.mode === after.mode &&
    beforeMtime !== undefined &&
    afterMtime !== undefined &&
    beforeMtime === afterMtime
  );
}

function localProvenanceRecordIdentity(info: FileSystem.File.Info, recordDigest: string): string {
  return sha256HexSync(
    [
      'threadnote-code-graph-local-provenance-file-v1',
      recordDigest,
      String(info.dev),
      String(Option.getOrUndefined(info.ino)),
      String(info.size),
      String(info.mode),
      String(Option.getOrUndefined(info.mtime)?.getTime()),
    ].join('\0'),
  );
}

function readBoundedObservedRegularFile(fs: FileSystem.FileSystem, file: string, pathInfoBefore: FileSystem.File.Info) {
  return Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* fs.open(file, {flag: 'r'});
      const openedInfoBefore = yield* opened.stat;
      const pathInfoOpened = yield* fs.stat(file);
      if (
        !sameObservedRegularFile(pathInfoBefore, openedInfoBefore) ||
        !sameObservedRegularFile(pathInfoBefore, pathInfoOpened)
      ) {
        return yield* CodeGraphLocalProvenanceError.make({
          message: 'Code graph local provenance changed while opening it.',
        });
      }
      if (Number(openedInfoBefore.size) > LOCAL_PROVENANCE_BYTES_LIMIT) {
        return yield* CodeGraphLocalProvenanceError.make({
          message: 'Code graph local provenance exceeds its bounded read limit.',
        });
      }

      const bytes = new Uint8Array(LOCAL_PROVENANCE_BYTES_LIMIT + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Number(yield* opened.read(bytes.subarray(offset)));
        if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - offset) {
          return yield* CodeGraphLocalProvenanceError.make({
            message: 'Code graph local provenance returned an invalid bounded read size.',
          });
        }
        if (count === 0) break;
        offset += count;
      }

      const openedInfoAfter = yield* opened.stat;
      const pathInfoAfter = yield* fs.stat(file);
      if (
        !sameObservedRegularFile(pathInfoBefore, openedInfoAfter) ||
        !sameObservedRegularFile(pathInfoBefore, pathInfoAfter)
      ) {
        return yield* CodeGraphLocalProvenanceError.make({
          message: 'Code graph local provenance changed during its bounded read.',
        });
      }
      if (offset > LOCAL_PROVENANCE_BYTES_LIMIT || BigInt(offset) !== openedInfoBefore.size) {
        return yield* CodeGraphLocalProvenanceError.make({
          message: 'Code graph local provenance changed size during its bounded read.',
        });
      }
      return yield* Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, offset)),
        catch: cause =>
          CodeGraphLocalProvenanceError.make({cause, message: 'Code graph local provenance is not valid UTF-8.'}),
      });
    }),
  );
}

function optionOnNotFound<A, E>(effect: Effect.Effect<A, E>) {
  return effect.pipe(
    Effect.asSome,
    Effect.catchIf(
      error => error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound',
      () => Effect.succeedNone,
    ),
  );
}

function syncFile(fs: FileSystem.FileSystem, file: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(file, {flag: 'r'}).pipe(
      Effect.flatMap(handle => handle.sync),
      Effect.ignore,
    ),
  );
}

function syncDirectory(fs: FileSystem.FileSystem, directory: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(directory, {flag: 'r'}).pipe(
      Effect.flatMap(handle => handle.sync),
      Effect.ignore,
    ),
  );
}
