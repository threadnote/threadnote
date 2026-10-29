import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, Path, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {codeGraphRepositoryLockPath} from '../layout.js';
import {
  awaitCodeGraphWorktreeBuilds,
  withCodeGraphMaintenanceRegistration,
  withCodeGraphReportedMaintenanceIntent,
} from '../maintenance/gate.js';
import {compareCodeUnits} from '../ordering.js';
import {
  CodeGraphStore,
  type CodeGraphSnapshotPurgeGraphBlockerCode,
  type CodeGraphSnapshotPurgeGraphEvidence,
  type CodeGraphSnapshotPurgeStoreResult,
} from '../store.js';
import {CodeGraphStoreBusyError, type CodeGraphSnapshot} from '../types.js';
import {
  inspectCodeGraphSnapshotVectorEvidence,
  type CodeGraphSnapshotVectorBlockerCode,
  type CodeGraphSnapshotVectorEvidence,
  withCodeGraphSnapshotVectorEvidenceLocks,
} from '../vector/maintenance.js';
import {inspectCodeGraphViewDatabaseTarget} from '../view_removal.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class CodeGraphSnapshotPurgeError extends Schema.TaggedError<
  CodeGraphSnapshotPurgeError,
  {readonly brand: unique symbol}
>()('CodeGraphSnapshotPurgeError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const HASH_ID = /^[0-9a-f]{64}$/u;
const SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;
const APPROVAL_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export type CodeGraphSnapshotPurgeBlockerCode =
  CodeGraphSnapshotPurgeGraphBlockerCode | CodeGraphSnapshotVectorBlockerCode;

export interface CodeGraphSnapshotPurgeBlocker {
  readonly code: CodeGraphSnapshotPurgeBlockerCode;
  readonly message: string;
}

export interface CodeGraphSnapshotPurgeTarget {
  readonly checkoutId: string;
  readonly snapshotId: string;
}

export interface CodeGraphSnapshotPurgeOptions {
  readonly apply?: boolean;
  readonly approvalDigest?: string;
  /** @internal Deterministic race seam after every outer maintenance/vector gate. */
  readonly afterMaintenanceGates?: () => Effect.Effect<void, unknown>;
}

export interface CodeGraphSnapshotPurgeApprovalProjection {
  readonly activeViewIds: readonly string[];
  readonly buildOwnerIds: readonly string[];
  readonly childSnapshotIds: readonly string[];
  readonly cleanupEpochs: readonly string[];
  readonly graphEvidenceDigest: string;
  readonly liveLeases: readonly {readonly expiresAt: number; readonly identity: string}[];
  readonly operation: 'code-graph-snapshot-purge';
  readonly snapshot: CodeGraphSnapshot;
  readonly vectorEvidenceDigest: string;
  readonly version: 1;
}

export interface CodeGraphSnapshotPurgeActionResult {
  readonly applied: boolean;
  readonly approvalDigest?: string;
  readonly blockers: readonly CodeGraphSnapshotPurgeBlocker[];
  readonly checkoutId: string;
  readonly cleanupState?: 'completed' | 'deferred';
  readonly eligible: boolean;
  readonly evidence?: {
    readonly activeViewCount: number;
    readonly buildOwnerCount: number;
    readonly childSnapshotCount: number;
    readonly cleanupCount: number;
    readonly liveLeaseCount: number;
    readonly vectorActivePointerCount: number;
    readonly vectorDatabaseCount: number;
    readonly vectorGenerationCount: number;
  };
  readonly remaining?: boolean;
  readonly rowsDeleted?: number;
  readonly snapshotId: string;
  readonly state: 'approval-required' | 'blocked' | 'not-found' | 'purged' | 'ready' | 'retired' | 'state-changed';
  readonly type: 'code-graph-snapshot-purge';
  readonly version: 1;
}

export const purgeCodeGraphSnapshot = Effect.fn('codeGraph.purgeSnapshotAction')(function* (
  threadnoteHome: string,
  target: CodeGraphSnapshotPurgeTarget,
  options: CodeGraphSnapshotPurgeOptions = {},
) {
  yield* validateSnapshotPurgeTarget(target);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const inspected = yield* inspectCodeGraphViewDatabaseTarget(threadnoteHome, target.checkoutId);
  if (inspected.state === 'missing') return missingResult(target);

  if (options.apply !== true) {
    const nowMilliseconds = yield* Clock.currentTimeMillis;
    const graph = yield* store.observeSnapshotPurge(inspected.databasePath, target.snapshotId, nowMilliseconds);
    if (graph.state === 'not-found') return missingResult(target);
    const vectors = yield* inspectCodeGraphSnapshotVectorEvidence(
      inspected.canonicalHome,
      target.checkoutId,
      target.snapshotId,
    );
    return observedResult(target, false, graph.evidence, vectors);
  }

  if (options.approvalDigest === undefined || !APPROVAL_DIGEST.test(options.approvalDigest)) {
    return approvalRequiredResult(target);
  }

  const lockOptions = {
    retryIntervalMilliseconds: 1,
    staleAfterMilliseconds: 120_000,
    waitTimeoutMilliseconds: 0,
  } as const;
  return yield* withCodeGraphMaintenanceRegistration(
    inspected.canonicalHome,
    withCodeGraphReportedMaintenanceIntent(
      inspected.canonicalHome,
      {
        checkoutId: target.checkoutId,
        operation: 'selected-snapshot-purge',
        snapshotId: target.snapshotId,
      },
      {completed: 0, phase: 'acquiring-gates', total: 5},
      reporter =>
        withExclusiveFileLock(
          fs,
          codeGraphRepositoryLockPath(path, inspected.canonicalHome, target.checkoutId),
          lockOptions,
          Effect.gen(function* () {
            yield* reporter.progress({completed: 1, phase: 'waiting-builders', total: 5});
            yield* awaitCodeGraphWorktreeBuilds(inspected.canonicalHome, target.checkoutId, 0);
            yield* reporter.progress({completed: 2, phase: 'verifying-vectors', total: 5});
            return yield* withCodeGraphSnapshotVectorEvidenceLocks(
              inspected.canonicalHome,
              target.checkoutId,
              target.snapshotId,
              lockedVectors =>
                Effect.gen(function* () {
                  yield* reporter.progress({completed: 3, phase: 'verifying-graph', total: 5});
                  yield* options.afterMaintenanceGates?.() ?? Effect.void;
                  // Re-read while all model locks remain held so the approval is
                  // bound to the final vector state immediately before Store CAS.
                  const vectors = lockedVectors.blockers.includes('vector-unverifiable')
                    ? lockedVectors
                    : yield* inspectCodeGraphSnapshotVectorEvidence(
                        inspected.canonicalHome,
                        target.checkoutId,
                        target.snapshotId,
                      );
                  const nowMilliseconds = yield* Clock.currentTimeMillis;
                  const graph = yield* store.observeSnapshotPurge(
                    inspected.databasePath,
                    target.snapshotId,
                    nowMilliseconds,
                  );
                  if (graph.state === 'not-found') return stateChangedResult(target);
                  const current = observedResult(target, false, graph.evidence, vectors);
                  if (current.approvalDigest !== options.approvalDigest || !current.eligible) {
                    return {
                      ...current,
                      applied: false,
                      state: 'state-changed',
                    } satisfies CodeGraphSnapshotPurgeActionResult;
                  }
                  yield* reporter.progress({completed: 4, phase: 'retiring-and-cleaning', total: 5});
                  const core = yield* store.purgeSnapshot(
                    inspected.databasePath,
                    target.snapshotId,
                    graph.evidence.graphEvidenceDigest,
                    nowMilliseconds,
                    {
                      beforeDatabaseOpen: () =>
                        inspectCodeGraphViewDatabaseTarget(inspected.canonicalHome, target.checkoutId).pipe(
                          Effect.flatMap(currentTarget =>
                            currentTarget.state === 'ready' && currentTarget.databasePath === inspected.databasePath
                              ? Effect.void
                              : Effect.fail(
                                  CodeGraphSnapshotPurgeError.make({
                                    message: 'Code graph database target changed before snapshot purge.',
                                  }),
                                ),
                          ),
                          Effect.provideService(FileSystem.FileSystem, fs),
                          Effect.provideService(Path.Path, path),
                        ),
                      waitTimeoutMilliseconds: 0,
                    },
                  );
                  return storeResult(target, graph.evidence, vectors, core);
                }),
            );
          }),
        ),
    ),
    0,
  ).pipe(
    Effect.catchIf(isFileLockTimeout, () =>
      Effect.fail(
        CodeGraphStoreBusyError.of('Code graph maintenance is busy.', {
          operation: 'purge selected code graph snapshot',
        }),
      ),
    ),
  );
});

export function codeGraphSnapshotPurgeApprovalDigest(projection: CodeGraphSnapshotPurgeApprovalProjection): string {
  const canonical = {
    activeViewIds: [...projection.activeViewIds].sort(compareCodeUnits),
    buildOwnerIds: [...projection.buildOwnerIds].sort(compareCodeUnits),
    childSnapshotIds: [...projection.childSnapshotIds].sort(compareCodeUnits),
    cleanupEpochs: [...projection.cleanupEpochs].sort(compareCodeUnits),
    graphEvidenceDigest: projection.graphEvidenceDigest,
    liveLeases: [...projection.liveLeases].sort(
      (left, right) => left.expiresAt - right.expiresAt || compareCodeUnits(left.identity, right.identity),
    ),
    operation: projection.operation,
    snapshot: {
      baseSnapshotId: projection.snapshot.baseSnapshotId ?? null,
      commit: projection.snapshot.commit,
      completedAt: projection.snapshot.completedAt ?? null,
      dirty: projection.snapshot.dirty,
      edgeCount: projection.snapshot.edgeCount,
      extractorSet: projection.snapshot.extractorSet,
      fileCount: projection.snapshot.fileCount,
      graphContentId: projection.snapshot.graphContentId ?? null,
      id: projection.snapshot.id,
      overlayFingerprint: projection.snapshot.overlayFingerprint ?? null,
      repositoryId: projection.snapshot.repositoryId,
      state: projection.snapshot.state,
      symbolCount: projection.snapshot.symbolCount,
      worktreeId: projection.snapshot.worktreeId,
    },
    vectorEvidenceDigest: projection.vectorEvidenceDigest,
    version: projection.version,
  };
  return `sha256:${sha256HexSync(`code-graph-snapshot-purge-approval-v1\n${JSON.stringify(canonical)}`)}`;
}

export function serializeCodeGraphSnapshotPurgeResult(result: CodeGraphSnapshotPurgeActionResult): string {
  return JSON.stringify(result);
}

export function renderCodeGraphSnapshotPurgeResult(result: CodeGraphSnapshotPurgeActionResult): string {
  const target = `checkout ${Effect2.pipe(result.checkoutId, EffectString.slice(0, 12))}, snapshot ${result.snapshotId}`;
  if (result.state === 'not-found') return `Selected code graph snapshot was not found for ${target}.`;
  if (result.state === 'approval-required') {
    return `Snapshot purge for ${target} requires the approval digest from a fresh preview.`;
  }
  if (result.state === 'state-changed') {
    return `Refusing to purge ${target}: safety evidence changed after preview.`;
  }
  if (result.state === 'blocked') {
    return EffectArray.join(
      [
        `Refusing to purge ${target}: the snapshot is not isolated.`,
        ...EffectArray.map(result.blockers, blocker => `Blocker [${blocker.code}]: ${blocker.message}`),
      ],
      '\n',
    );
  }
  if (result.applied) {
    return `Purged selected code graph snapshot for ${target}; physical cleanup ${result.cleanupState ?? 'deferred'}.`;
  }
  return EffectArray.join(
    [`Would purge selected code graph snapshot for ${target}.`, `Approval: ${result.approvalDigest ?? 'unavailable'}`],
    '\n',
  );
}

export function codeGraphSnapshotPurgeTargetFailure(result: CodeGraphSnapshotPurgeActionResult): Error | undefined {
  if (result.state === 'not-found')
    return CodeGraphSnapshotPurgeError.make({message: 'The selected code graph snapshot does not exist.'});
  if (result.state === 'approval-required')
    return CodeGraphSnapshotPurgeError.make({message: 'A fresh snapshot purge approval digest is required.'});
  if (result.state === 'state-changed')
    return CodeGraphSnapshotPurgeError.make({message: 'The selected snapshot changed; preview it again.'});
  if (result.state === 'blocked') {
    return CodeGraphSnapshotPurgeError.make({
      message: `The selected snapshot is protected: ${EffectArray.join(
        EffectArray.map(result.blockers, blocker => blocker.code),
        ', ',
      )}.`,
    });
  }
  return undefined;
}

function observedResult(
  target: CodeGraphSnapshotPurgeTarget,
  applied: boolean,
  graph: CodeGraphSnapshotPurgeGraphEvidence,
  vectors: CodeGraphSnapshotVectorEvidence,
): CodeGraphSnapshotPurgeActionResult {
  const blockers = EffectArray.map([...graph.blockers, ...vectors.blockers].sort(compareCodeUnits), blockerDetail);
  const eligible = blockers.length === 0;
  const approvalDigest = eligible
    ? codeGraphSnapshotPurgeApprovalDigest(approvalProjection(graph, vectors))
    : undefined;
  return {
    applied,
    ...(approvalDigest === undefined ? {} : {approvalDigest}),
    blockers,
    checkoutId: target.checkoutId,
    eligible,
    evidence: evidenceSummary(graph, vectors),
    snapshotId: target.snapshotId,
    state: eligible ? (graph.snapshot.state === 'retired' ? 'retired' : 'ready') : 'blocked',
    type: 'code-graph-snapshot-purge',
    version: 1,
  };
}

function storeResult(
  target: CodeGraphSnapshotPurgeTarget,
  graph: CodeGraphSnapshotPurgeGraphEvidence,
  vectors: CodeGraphSnapshotVectorEvidence,
  core: CodeGraphSnapshotPurgeStoreResult,
): CodeGraphSnapshotPurgeActionResult {
  if (core.state === 'not-found') return stateChangedResult(target);
  if (core.state === 'blocked' || core.state === 'state-changed') {
    const current = observedResult(target, false, core.evidence, vectors);
    return {...current, state: core.state};
  }
  if (!('cleanupState' in core)) return stateChangedResult(target);
  return {
    applied: true,
    approvalDigest: codeGraphSnapshotPurgeApprovalDigest(approvalProjection(graph, vectors)),
    blockers: [],
    checkoutId: target.checkoutId,
    cleanupState: core.cleanupState,
    eligible: true,
    evidence: evidenceSummary(graph, vectors),
    remaining: core.remaining,
    rowsDeleted: core.rowsDeleted,
    snapshotId: target.snapshotId,
    state: core.state,
    type: 'code-graph-snapshot-purge',
    version: 1,
  };
}

function approvalProjection(
  graph: CodeGraphSnapshotPurgeGraphEvidence,
  vectors: CodeGraphSnapshotVectorEvidence,
): CodeGraphSnapshotPurgeApprovalProjection {
  return {
    activeViewIds: graph.activeViewIds,
    buildOwnerIds: graph.buildOwnerIds,
    childSnapshotIds: graph.childSnapshotIds,
    cleanupEpochs: graph.cleanupEpochs,
    graphEvidenceDigest: graph.graphEvidenceDigest,
    liveLeases: graph.liveLeases,
    operation: 'code-graph-snapshot-purge',
    snapshot: graph.snapshot,
    vectorEvidenceDigest: vectors.vectorEvidenceDigest,
    version: 1,
  };
}

function evidenceSummary(graph: CodeGraphSnapshotPurgeGraphEvidence, vectors: CodeGraphSnapshotVectorEvidence) {
  return {
    activeViewCount: graph.activeViewIds.length,
    buildOwnerCount: graph.buildOwnerIds.length,
    childSnapshotCount: graph.childSnapshotIds.length,
    cleanupCount: graph.cleanupEpochs.length,
    liveLeaseCount: graph.liveLeases.length,
    vectorActivePointerCount: vectors.activePointerCount,
    vectorDatabaseCount: vectors.databasesInspected,
    vectorGenerationCount: vectors.generationCount,
  };
}

function blockerDetail(code: CodeGraphSnapshotPurgeBlockerCode): CodeGraphSnapshotPurgeBlocker {
  const messages: Record<CodeGraphSnapshotPurgeBlockerCode, string> = {
    'active-view': 'An active graph view still points to this snapshot.',
    'alias-snapshot': 'The selected row is an overlay/alias snapshot.',
    'base-required': 'Another snapshot still requires this snapshot as its base.',
    'build-owned': 'An active or recoverable build still owns this snapshot.',
    'cleanup-pending': 'Removed-view cleanup still references this snapshot.',
    'live-lease': 'A reader lease still protects this snapshot.',
    'unsupported-state': 'Only isolated ready or retired snapshots can be purged.',
    'vector-active': 'A live vector pointer still references this snapshot.',
    'vector-unverifiable': 'Vector sidecar safety could not be verified completely.',
  };
  return {code, message: messages[code]};
}

function missingResult(target: CodeGraphSnapshotPurgeTarget): CodeGraphSnapshotPurgeActionResult {
  return {
    applied: false,
    blockers: [],
    checkoutId: target.checkoutId,
    eligible: false,
    snapshotId: target.snapshotId,
    state: 'not-found',
    type: 'code-graph-snapshot-purge',
    version: 1,
  };
}

function approvalRequiredResult(target: CodeGraphSnapshotPurgeTarget): CodeGraphSnapshotPurgeActionResult {
  return {
    applied: false,
    blockers: [],
    checkoutId: target.checkoutId,
    eligible: false,
    snapshotId: target.snapshotId,
    state: 'approval-required',
    type: 'code-graph-snapshot-purge',
    version: 1,
  };
}

function stateChangedResult(target: CodeGraphSnapshotPurgeTarget): CodeGraphSnapshotPurgeActionResult {
  return {
    applied: false,
    blockers: [],
    checkoutId: target.checkoutId,
    eligible: false,
    snapshotId: target.snapshotId,
    state: 'state-changed',
    type: 'code-graph-snapshot-purge',
    version: 1,
  };
}

const validateSnapshotPurgeTarget = Effect.fn('codeGraph.validateSnapshotPurgeTarget')(function* (
  target: CodeGraphSnapshotPurgeTarget,
) {
  if (!HASH_ID.test(target.checkoutId)) {
    return yield* CodeGraphSnapshotPurgeError.make({
      message: 'Code graph checkout identity must be 64 lowercase hexadecimal characters.',
    });
  }
  if (!SNAPSHOT_ID.test(target.snapshotId)) {
    return yield* CodeGraphSnapshotPurgeError.make({message: 'Code graph snapshot identity is invalid.'});
  }
});
