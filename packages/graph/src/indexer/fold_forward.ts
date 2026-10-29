import {Array as EffectArray} from 'effect';
import {Effect, Option} from 'effect';
import type {CommittedBaseResult} from './types.js';
import {planCodeGraphIncrementalFoldForwardPaths} from '../incremental/work.js';
import type {CodeGraphReusableCleanBase, CodeGraphReusableFoldForwardBase, CodeGraphStoreShape} from '../store.js';

export function foldForwardLogicalCandidate(base: CodeGraphReusableFoldForwardBase): CodeGraphReusableCleanBase {
  return {
    files: base.logicalFiles,
    receipt: base.rootReceipt,
    snapshot: base.logicalSnapshot,
  };
}

export const acquireFoldForwardBaseLeases = Effect.fn('codeGraph.acquireFoldForwardBaseLeases')(function* (
  store: CodeGraphStoreShape,
  databasePath: string,
  physicalSnapshotId: string,
  durationMilliseconds: number,
  logicalSnapshotId?: string,
) {
  const physical = yield* store
    .acquireSnapshotLease(databasePath, physicalSnapshotId, durationMilliseconds)
    .pipe(Effect.option);
  if (Option.isNone(physical))
    return Option.none<{readonly additional: readonly string[]; readonly physical: string}>();
  const physicalToken = yield* Effect.acquireRelease(Effect.succeed(physical.value), token =>
    store.releaseSnapshotLease(databasePath, token).pipe(Effect.ignore),
  );
  if (logicalSnapshotId === undefined) {
    return Option.some({additional: [], physical: physicalToken});
  }
  const logical = yield* store
    .acquireSnapshotLease(databasePath, logicalSnapshotId, durationMilliseconds)
    .pipe(Effect.option);
  if (Option.isNone(logical)) return Option.none();
  const logicalToken = yield* Effect.acquireRelease(Effect.succeed(logical.value), token =>
    store.releaseSnapshotLease(databasePath, token).pipe(Effect.ignore),
  );
  return Option.some({additional: [logicalToken], physical: physicalToken});
});

export function foldForwardCommittedBase(
  base: CodeGraphReusableFoldForwardBase,
  leaseTokens: {readonly additional: readonly string[]; readonly physical: string},
): CommittedBaseResult {
  return {
    additionalLeaseTokens: leaseTokens.additional,
    diagnostics: [
      `Dirty snapshot compared against clean delta ${base.logicalSnapshot.id} and folded its prior changes over root ${base.rootSnapshot.id}.`,
    ],
    foldForward: {
      logicalSnapshotId: base.logicalSnapshot.id,
      priorDeltaPaths: base.priorDeltaPaths,
      priorStagedPayloadBytes: base.priorStagedPayloadBytes,
      priorStagedRows: base.priorStagedRows,
    },
    leaseToken: Option.some(leaseTokens.physical),
    snapshot: base.rootSnapshot,
    stagingReusable: false,
  };
}

export function persistedBaseCommittedBase(
  candidate: CodeGraphReusableCleanBase,
  physicalSnapshot: CodeGraphReusableCleanBase['snapshot'],
  physicalLeaseToken: string,
  headCommit: string,
): CommittedBaseResult {
  return {
    diagnostics: [
      `Dirty snapshot reused compatible persisted base ${candidate.snapshot.id} without first building commit ${headCommit}.`,
    ],
    leaseToken: Option.some(physicalLeaseToken),
    snapshot: physicalSnapshot,
    stagingReusable: false,
  };
}

export function foldForwardPreparationOptions(foldForward: CommittedBaseResult['foldForward']): {
  readonly foldForward?: {
    readonly logicalSnapshotId: string;
    readonly priorStagedPayloadBytes: number;
    readonly priorStagedRows: number;
  };
} {
  return foldForward
    ? {
        foldForward: {
          logicalSnapshotId: foldForward.logicalSnapshotId,
          priorStagedPayloadBytes: foldForward.priorStagedPayloadBytes,
          priorStagedRows: foldForward.priorStagedRows,
        },
      }
    : {};
}

export function foldForwardMaterializationCounts(
  priorPaths: readonly string[],
  freshFiles: readonly {readonly path: string}[],
  deletedPaths: readonly string[] = [],
): {readonly carriedFiles: number; readonly freshStagedFiles: number; readonly stagedFiles: number} | undefined {
  const freshPaths = [...EffectArray.map(freshFiles, file => file.path), ...deletedPaths];
  const plan = planCodeGraphIncrementalFoldForwardPaths(priorPaths, freshPaths);
  return plan
    ? {
        carriedFiles: plan.carriedPaths.length,
        freshStagedFiles: freshFiles.length,
        stagedFiles: plan.cumulativePaths.length,
      }
    : undefined;
}
