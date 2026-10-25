import {Clock, Effect, FileSystem, Option} from 'effect';
import {deferCodeGraphVectorCompletion} from '../vector/publication.js';
import type {CodeGraphEmbeddingIndexShape} from '../embedding.js';
import {currentSnapshotReusableBaseReceipt, reusableBaseFileSetFingerprint} from './incremental.js';
import {verifyCommittedIndexInput} from './input/verification.js';
import {
  CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS,
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
  const currentPackProvenance = input.languagePacks.activePackProvenance(input.inventory.files.map(file => file.path));
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
          id: input.logicalSnapshotId,
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
