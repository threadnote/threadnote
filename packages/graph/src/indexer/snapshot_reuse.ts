import {
  isLexicalV2Snapshot,
  lexicalPhysicalSnapshotIdentity,
  lexicalViewBindingFor,
  lexicalSnapshotLayoutMode,
} from '../store/lexical_projection.js';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {CodeGraphProcessActivity} from '../runtime_ports.js';
import type {CodeGraphBuildResourceCoordinator} from '../build/resources.js';
import type {CodeGraphIndexOptions} from './types.js';
import type {CodeGraphRetiredSnapshotCleanupProgress} from '../store/models.js';
import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, Option} from 'effect';
import {deferCodeGraphVectorCompletion} from '../vector/publication.js';
import type {CodeGraphEmbeddingIndexShape} from '../embedding.js';
import {currentSnapshotReusableBaseReceipt, reusableBaseFileSetFingerprint} from './incremental.js';
import {verifyCommittedIndexInput} from './input/verification.js';
import {
  CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS,
  CODE_GRAPH_LOCK_OPTIONS,
  extractorSetIdentity,
  graphContentIdentity,
  messageOf,
  promoteReadySnapshotWithCapacity,
  verifyIndexInput,
} from './materialization.js';
import {sameEffectiveCodeGraphInventory} from './shared.js';
import type {DirectPersistentCapacityProtection, ReusableCleanSnapshotAttempt} from './types.js';
import type {CodeGraphInventory} from '../inventory.js';
import {assessCodeGraphLanguagePackDelta} from '../languages/provenance.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import type {CodeGraphLayout} from '../layout.js';
import type {CodeGraphStoreShape} from '../store.js';
import type {CodeGraphIndexSummary, CodeGraphProgress, CodeGraphSnapshot, RepositoryIdentity} from '../types.js';

export interface ReusableCleanSnapshotInput {
  readonly capacityProtection: DirectPersistentCapacityProtection;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
  readonly existing: CodeGraphSnapshot | undefined;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly logicalSnapshotId: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly persistentMaterializationTransactionBatchLimit?: 1 | 4;
  readonly requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string};
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}

export const prepareReadyAnalysisSummary = Effect.fn('codeGraph.prepareReadyAnalysisSummary')(function* (input: {
  readonly databasePath: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly snapshotId: string;
  readonly store: CodeGraphStoreShape;
}) {
  yield* input.onProgress?.({
    phase: 'activating',
    snapshotId: input.snapshotId,
    subphase: 'summarizing-analysis',
  }) ?? Effect.void;
  return yield* (
    typeof input.store.ensureAnalysisSummary === 'function'
      ? input.store.ensureAnalysisSummary(input.databasePath, input.snapshotId)
      : Effect.succeed(false)
  ).pipe(
    Effect.ensuring(
      (
        input.onProgress?.({phase: 'activating', snapshotId: input.snapshotId, subphase: 'complete'}) ?? Effect.void
      ).pipe(Effect.ignore),
    ),
  );
});

export const reuseReadySnapshot = Effect.fn('codeGraph.reuseReadySnapshot')(function* (input: {
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
  readonly identity: RepositoryIdentity;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly reusedFiles: number;
  readonly skippedFiles: number;
  readonly snapshot: CodeGraphSnapshot;
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
  readonly totalFiles: number;
}) {
  yield* input.onProgress?.({phase: 'activating', snapshotId: input.snapshot.id, subphase: 'structural-ready'}) ??
    Effect.void;
  let analysisSummaryFailure: string | undefined;
  const analysisSummaryBackfilled = input.snapshot.dirty
    ? yield* (
        input.onProgress?.({phase: 'activating', snapshotId: input.snapshot.id, subphase: 'complete'}) ?? Effect.void
      ).pipe(Effect.as(false))
    : yield* prepareReadyAnalysisSummary({
        databasePath: input.layout.databasePath,
        onProgress: input.onProgress,
        snapshotId: input.snapshot.id,
        store: input.store,
      }).pipe(
        Effect.catch(cause =>
          Effect.sync(() => {
            analysisSummaryFailure = messageOf(cause);
            return false;
          }),
        ),
      );
  const diagnostics: string[] = analysisSummaryBackfilled
    ? ['Built the persisted whole-graph analysis summary for this reused snapshot.']
    : analysisSummaryFailure
      ? [`Whole-graph analysis summary will be retried lazily: ${analysisSummaryFailure}`]
      : [];
  if (!input.ensureVectors) {
    const vectorCheck = yield* input.embedding
      .check(input.threadnoteHome, input.layout, input.snapshot.id)
      .pipe(Effect.catch(cause => Effect.succeed({reason: messageOf(cause), state: 'unavailable'} as const)));
    if (vectorCheck.state !== 'ready') {
      diagnostics.push(
        `Vector graph retrieval unavailable: ${vectorCheck.reason ?? 'vectors are not yet materialized'}`,
      );
    }
    return {
      diagnostics,
      durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
      identity: input.identity,
      materialization: {
        mode: 'reused-snapshot',
        stagedFiles: 0,
        totalFiles: input.totalFiles,
      },
      reusedFiles: input.reusedFiles,
      skippedFiles: input.skippedFiles,
      snapshot: input.snapshot,
    } satisfies CodeGraphIndexSummary;
  }
  const summary = {
    diagnostics,
    durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
    identity: input.identity,
    materialization: {
      mode: 'reused-snapshot',
      stagedFiles: 0,
      totalFiles: input.totalFiles,
    },
    reusedFiles: input.reusedFiles,
    skippedFiles: input.skippedFiles,
    snapshot: input.snapshot,
  } satisfies CodeGraphIndexSummary;
  return yield* deferCodeGraphVectorCompletion({...input, summary});
});

/**
 * A dirty physical root may become the exact next clean commit without any
 * graph-producing input changing. Reuse it only with exact persisted evidence.
 */
export const attemptCommittedDirtyRootAlias = Effect.fn('codeGraph.attemptCommittedDirtyRootAlias')(function* (
  input: ReusableCleanSnapshotInput,
  workspace: CodeGraphWorkspace,
) {
  const existing = input.existing;
  if (
    !existing?.dirty ||
    existing.baseSnapshotId !== undefined ||
    existing.overlayFingerprint === undefined ||
    !input.store.reusableOverlayBase ||
    !input.store.activateCleanSnapshotAlias
  ) {
    return Option.none<ReusableCleanSnapshotAttempt>();
  }
  const extractorSet = extractorSetIdentity(input.inventory.files, input.languagePacks);
  if (existing.extractorSet !== extractorSet) return Option.none<ReusableCleanSnapshotAttempt>();
  const candidate = yield* input.store.reusableOverlayBase(
    input.layout.databasePath,
    input.identity.repositoryId,
    extractorSet,
    existing.overlayFingerprint,
  );
  if (
    !candidate ||
    candidate.snapshot.id !== existing.id ||
    !sameEffectiveCodeGraphInventory(candidate.files, input.inventory.files) ||
    candidate.receipt.workspaceFingerprint !== workspace.fingerprint ||
    candidate.receipt.fileSetFingerprint !== reusableBaseFileSetFingerprint(input.inventory.files)
  ) {
    return Option.none<ReusableCleanSnapshotAttempt>();
  }
  const factored = isLexicalV2Snapshot(candidate.snapshot.id);
  if (factored) {
    // Decoder syntax alone grants no alias capability: re-read the published
    // receipt and its recomputed actual/logical/layout binding first.
    const current = yield* input.store.currentLexicalReadySnapshotById(
      input.layout.databasePath,
      candidate.snapshot.id,
    );
    if (
      !current ||
      !current.dirty ||
      current.baseSnapshotId !== undefined ||
      !['full', 'direct'].includes(lexicalSnapshotLayoutMode(current) ?? '')
    ) {
      return Option.none<ReusableCleanSnapshotAttempt>();
    }
  }
  const currentPackProvenance = input.languagePacks.activePackProvenance(
    EffectArray.map(input.inventory.files, file => file.path),
  );
  const packDelta = assessCodeGraphLanguagePackDelta(candidate.receipt.packProvenance, currentPackProvenance);
  if (packDelta.mode === 'fallback' || packDelta.changedPackIds.length > 0) {
    return Option.none<ReusableCleanSnapshotAttempt>();
  }
  const lease = yield* input.store
    .acquireSnapshotLease(input.layout.databasePath, candidate.snapshot.id, CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS)
    .pipe(Effect.option);
  if (Option.isNone(lease)) return Option.none<ReusableCleanSnapshotAttempt>();
  return yield* Effect.acquireUseRelease(
    Effect.succeed(lease.value),
    () =>
      Effect.gen(function* () {
        const alias: CodeGraphSnapshot = {
          baseSnapshotId: candidate.snapshot.id,
          commit: input.identity.headCommit,
          dirty: false,
          edgeCount: candidate.snapshot.edgeCount,
          extractorSet,
          fileCount: candidate.snapshot.fileCount,
          graphContentId: graphContentIdentity(extractorSet, input.inventory.files),
          id: factored
            ? lexicalPhysicalSnapshotIdentity(input.logicalSnapshotId, 'alias', candidate.snapshot.id)
            : input.logicalSnapshotId,
          repositoryId: input.identity.repositoryId,
          state: 'ready',
          symbolCount: candidate.snapshot.symbolCount,
          worktreeId: input.identity.worktreeId,
        };
        const receipt = currentSnapshotReusableBaseReceipt(input.inventory, workspace, currentPackProvenance);
        yield* input.onProgress?.({phase: 'activating', snapshotId: alias.id, subphase: 'validating-input'}) ??
          Effect.void;
        yield* verifyIndexInput(input.identity, true, input.threadnoteHome, input.requestedOverlay);
        yield* input.store.activateCleanSnapshotAlias!(
          input.layout.databasePath,
          input.identity,
          alias,
          candidate.snapshot.id,
          receipt,
          {
            ...(factored
              ? {lexicalBinding: lexicalViewBindingFor(alias.id, input.logicalSnapshotId, candidate.snapshot.id)}
              : {}),
            exactBaseFiles: input.inventory.files,
            expectedBaseGraphContentId: candidate.snapshot.graphContentId ?? candidate.snapshot.id,
          },
        );
        yield* input.onProgress?.({phase: 'activating', snapshotId: alias.id, subphase: 'promoting'}) ?? Effect.void;
        yield* verifyCommittedIndexInput({
          databasePath: input.layout.databasePath,
          identity: input.identity,
          physicalSnapshotId: candidate.snapshot.id,
          requestedOverlay: input.requestedOverlay,
          snapshotId: alias.id,
          store: input.store,
          threadnoteHome: input.threadnoteHome,
        });
        yield* promoteReadySnapshotWithCapacity(input, alias.id);
        yield* input.onProgress?.({phase: 'activating', snapshotId: alias.id, subphase: 'promoting'}) ?? Effect.void;
        yield* verifyCommittedIndexInput({
          databasePath: input.layout.databasePath,
          identity: input.identity,
          physicalSnapshotId: candidate.snapshot.id,
          requestedOverlay: input.requestedOverlay,
          snapshotId: alias.id,
          store: input.store,
          threadnoteHome: input.threadnoteHome,
        });
        return Option.some<ReusableCleanSnapshotAttempt>({
          mode: 'complete',
          summary: yield* reuseReadySnapshot({
            embedding: input.embedding,
            ensureVectors: input.ensureVectors,
            identity: input.identity,
            layout: input.layout,
            onProgress: input.onProgress,
            reusedFiles: input.inventory.files.length,
            skippedFiles: input.inventory.skipped,
            snapshot: alias,
            startedAt: input.startedAt,
            store: input.store,
            threadnoteHome: input.threadnoteHome,
            totalFiles: input.inventory.files.length,
          }),
        });
      }),
    token => input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.ignore),
  );
});

export function retiredSnapshotCleanupReporter(onProgress: CodeGraphIndexOptions['onProgress']) {
  return (progress: CodeGraphRetiredSnapshotCleanupProgress) =>
    (
      onProgress?.({
        completed: progress.snapshotsCompleted,
        pagesCompleted: progress.pagesCompleted,
        phase: 'reclaiming',
        rowsDeleted: progress.rowsDeleted,
        total: progress.snapshotsTotal,
        unit: 'snapshots',
      }) ?? Effect.void
    ).pipe(Effect.ignore);
}

export function withCodeGraphProcessLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  onContention: () => Effect.Effect<void>,
  builderOperation: string,
  effect: Effect.Effect<A, E, R>,
  coordination?: {
    readonly onAcquired: () => Effect.Effect<void, never>;
    readonly onCompleted: () => Effect.Effect<void, never>;
  },
) {
  return Effect.flatMap(CodeGraphProcessActivity, activity =>
    activity.withActivity(
      'graph-waiter',
      'repository-lock',
      withExclusiveFileLock(
        fs,
        lockPath,
        {
          ...CODE_GRAPH_LOCK_OPTIONS,
          onContention,
          ...(coordination ? {onAcquired: coordination.onAcquired, onCompleted: coordination.onCompleted} : {}),
        },
        activity.withActivity('graph-builder', builderOperation, effect),
      ),
    ),
  );
}

export function writerSessionOptions(
  layout: CodeGraphLayout,
  options: Pick<CodeGraphIndexOptions, 'onProgress' | 'onSqliteWriterConfigured' | 'sqliteWriterTuning'>,
  resumeProgress: () => Effect.Effect<void, unknown>,
  resources?: CodeGraphBuildResourceCoordinator,
) {
  return {
    cleanupCompletedBuildRows: true,
    ...(options.onSqliteWriterConfigured ? {onSqliteWriterConfigured: options.onSqliteWriterConfigured} : {}),
    onWriterContention: () =>
      (resources?.assertWriterMayWait ?? Effect.void).pipe(
        Effect.orDie,
        Effect.andThen(options.onProgress?.({phase: 'waiting', reason: 'database-writer'}) ?? Effect.void),
        Effect.ignore,
      ),
    onWriterAcquired: () =>
      (resources?.acquireWriter ?? Effect.void).pipe(Effect.orDie, Effect.andThen(resumeProgress()), Effect.ignore),
    onWriterReleased: () => (resources?.releaseWriter ?? Effect.void).pipe(Effect.orDie),
    sqliteWriterTuning: {
      reconstructibleBuildSynchronous: 'normal' as const,
      ...options.sqliteWriterTuning,
    },
    writerLockPath: layout.databaseWriteLockPath,
  } as const;
}
