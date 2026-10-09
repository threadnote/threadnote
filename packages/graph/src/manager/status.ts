import {DateTime, Effect, Option} from 'effect';
import type {CodeGraphAutomaticCompactionStatus} from '../automatic/compaction.js';
import {
  readAllCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
  type ObservedCodeGraphBuildStatus,
} from '../build_status.js';
import {runCodeGraphLifecycleOpportunity} from '../lifecycle/opportunity.js';
import {observeManagerGraphCatalogStatus} from './catalog_revision.js';
import {CodeGraphMaintenanceCoordinator} from '../maintenance/coordinator.js';
import {observeCodeGraphMaintenanceStatus, type CodeGraphMaintenanceStatus} from '../maintenance/gate.js';
import {compareCodeUnits} from '../ordering.js';
import {codeGraphCompactionRequiredFreeBytes, inspectCodeGraphStorage, type CodeGraphStorage} from '../storage.js';
import {projectManagerGraphReconciliationStatus, type ManagerGraphReconciliationStatus} from './reconciliation.js';
import type {CodeGraphLifecycleOpportunityResult} from '../lifecycle/opportunity.js';

export type {ManagerGraphReconciliationStatus} from './reconciliation.js';

export const MANAGER_GRAPH_STORAGE_STATUS_LIMIT = 8;

export type ManagerGraphPageStorageSummary =
  | {
      readonly allocatedBytes: number;
      readonly automaticCompaction: 'eligible' | 'not-needed' | 'space-unknown' | 'waiting-for-space';
      readonly compactionOpportunityBytes?: number;
      readonly inUseBytes: number;
      readonly reclaimableRatio: number;
      readonly requiredFreeBytes?: number;
      readonly reusableBytes: number;
      readonly state: 'available';
    }
  | {readonly reason: 'active-build'; readonly state: 'deferred'}
  | {readonly reason: 'database-busy-or-unreadable'; readonly state: 'unavailable'};

export type ManagerGraphStorageSummary =
  | {readonly state: 'missing' | 'unavailable'}
  | {
      readonly databaseBytes: number;
      readonly pageStorage: ManagerGraphPageStorageSummary;
      readonly physicalBytes: number;
      readonly sidecarBytes: number;
      readonly state: 'available';
    };

/** Privacy-safe storage totals for Manager; the database path never crosses the API boundary. */
export function managerGraphStorageSummary(storage: CodeGraphStorage): ManagerGraphStorageSummary {
  if (storage.state === 'missing') return {state: 'missing'};
  const pageStorage: ManagerGraphPageStorageSummary = (() => {
    if (storage.pageStorage.state !== 'available') return storage.pageStorage;
    const allocatedBytes = storage.pageStorage.pageCount * storage.pageStorage.pageSize;
    const requiredFreeBytes = codeGraphCompactionRequiredFreeBytes(storage);
    const automaticCompaction =
      storage.pageStorage.threshold.reason !== 'freelist'
        ? 'not-needed'
        : storage.availableBytes === undefined
          ? 'space-unknown'
          : storage.availableBytes >= requiredFreeBytes
            ? 'eligible'
            : 'waiting-for-space';
    return {
      allocatedBytes,
      automaticCompaction,
      ...(storage.pageStorage.compactionOpportunityBytes === undefined
        ? {}
        : {compactionOpportunityBytes: storage.pageStorage.compactionOpportunityBytes}),
      inUseBytes: Math.max(0, allocatedBytes - storage.pageStorage.reclaimableBytes),
      reclaimableRatio: storage.pageStorage.reclaimableRatio,
      ...(automaticCompaction === 'waiting-for-space' ? {requiredFreeBytes} : {}),
      reusableBytes: storage.pageStorage.reclaimableBytes,
      state: 'available',
    };
  })();
  return {
    databaseBytes: storage.databaseBytes,
    pageStorage,
    physicalBytes: storage.filesystemBytes,
    sidecarBytes: Math.max(0, storage.filesystemBytes - storage.databaseBytes),
    state: 'available',
  };
}

export interface ManagerGraphBuildCatalog {
  readonly automaticCompaction?: CodeGraphAutomaticCompactionStatus;
  readonly builds: readonly ObservedCodeGraphBuildStatus[];
  readonly catalogRevision?: string;
  readonly lifecyclePending: boolean;
  readonly maintenance?: CodeGraphMaintenanceStatus;
  readonly reconciliation?: ManagerGraphReconciliationStatus;
  readonly queuedWorktreeIds: readonly string[];
  readonly storage: Readonly<Record<string, ManagerGraphStorageSummary>>;
  readonly waiterCount: number;
  readonly waiters: readonly ObservedCodeGraphBuildStatus[];
}

/** Bounded live status plus one non-tailing missing-view reconciliation opportunity. */
export const managerGraphBuildCatalog = Effect.fn('codeGraph.managerBuildCatalog')(function* (
  threadnoteHome: string,
  automaticCompaction?: CodeGraphAutomaticCompactionStatus,
) {
  const selection = selectCodeGraphBuildStatuses(yield* readAllCodeGraphBuildStatuses(threadnoteHome));
  const maintenance = yield* observeCodeGraphMaintenanceStatus(threadnoteHome).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const active = [...selection.builds, ...selection.waiters].some(
    status => status.state === 'queued' || status.state === 'running',
  );
  let statusObservation =
    active || maintenance !== undefined
      ? undefined
      : yield* observeManagerGraphCatalogStatus(threadnoteHome).pipe(Effect.orElseSucceed(() => undefined));
  const lifecycleMaintenance = yield* Effect.serviceOption(CodeGraphMaintenanceCoordinator);
  let lifecycleResult: CodeGraphLifecycleOpportunityResult | undefined;
  if (statusObservation?.lifecyclePending === true && Option.isSome(lifecycleMaintenance)) {
    lifecycleResult = yield* runCodeGraphLifecycleOpportunity({
      maintenance: lifecycleMaintenance.value,
      opportunity: 'status',
      targets: statusObservation.lifecycleTargets,
      threadnoteHome,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (
      lifecycleResult?.state === 'completed' &&
      lifecycleResult.result.state === 'completed' &&
      lifecycleResult.result.cleanup === 'removed-worktree-view'
    ) {
      statusObservation = yield* observeManagerGraphCatalogStatus(threadnoteHome).pipe(
        Effect.orElseSucceed(() => undefined),
      );
    }
  }
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const reconciliation = projectManagerGraphReconciliationStatus({
    activeBuild: active,
    checkedAt,
    ...(lifecycleResult === undefined ? {} : {lifecycleResult}),
    maintenance: maintenance !== undefined,
    ...(statusObservation === undefined ? {} : {observation: statusObservation}),
  });
  const catalogRevision = statusObservation?.catalogRevision;
  const checkoutIds = managerGraphStorageStatusCheckoutIds([...selection.builds, ...selection.waiters]);
  const storage = Object.fromEntries(
    yield* Effect.forEach(
      checkoutIds,
      checkoutId =>
        inspectCodeGraphStorage(threadnoteHome, checkoutId).pipe(
          Effect.map(observation => [checkoutId, managerGraphStorageSummary(observation)] as const),
          Effect.orElseSucceed(() => [checkoutId, {state: 'unavailable'}] as const),
        ),
      {concurrency: 2},
    ),
  );
  return {
    ...(automaticCompaction === undefined ? {} : {automaticCompaction}),
    builds: selection.builds,
    ...(catalogRevision === undefined ? {} : {catalogRevision}),
    lifecyclePending: statusObservation?.lifecyclePending === true,
    ...(maintenance === undefined ? {} : {maintenance}),
    reconciliation,
    queuedWorktreeIds: [...new Set(selection.waiters.map(status => status.identity.worktreeId))],
    storage,
    waiterCount: selection.waiters.length,
    waiters: selection.waiters,
  } satisfies ManagerGraphBuildCatalog;
});

/** Active builds win the bounded storage-inspection budget; recent receipts follow deterministically. */
export function managerGraphStorageStatusCheckoutIds(
  statuses: readonly {
    readonly identity: Pick<ObservedCodeGraphBuildStatus['identity'], 'checkoutId'>;
    readonly state: ObservedCodeGraphBuildStatus['state'];
    readonly timestamps: Pick<ObservedCodeGraphBuildStatus['timestamps'], 'lastProgressAt'>;
  }[],
): readonly string[] {
  const ordered = [...statuses].sort((left, right) => {
    const leftActive = left.state === 'queued' || left.state === 'running';
    const rightActive = right.state === 'queued' || right.state === 'running';
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    const byRecency = compareCodeUnits(right.timestamps.lastProgressAt, left.timestamps.lastProgressAt);
    return byRecency || compareCodeUnits(left.identity.checkoutId, right.identity.checkoutId);
  });
  const checkoutIds: string[] = [];
  const seen = new Set<string>();
  for (const status of ordered) {
    const {checkoutId} = status.identity;
    if (!/^[0-9a-f]{64}$/u.test(checkoutId) || seen.has(checkoutId)) continue;
    seen.add(checkoutId);
    checkoutIds.push(checkoutId);
    if (checkoutIds.length >= MANAGER_GRAPH_STORAGE_STATUS_LIMIT) break;
  }
  return checkoutIds;
}
