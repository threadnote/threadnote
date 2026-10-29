import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Clock, Context, Crypto, Deferred, Effect, Exit, FileSystem, Layer, Path, SynchronizedRef, Schema} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {maintainCodeGraphBuildHistoryUnit} from '../build_status.js';
import {
  cleanupMissingCodeGraphLocalProvenance,
  type CodeGraphLocalProvenanceCleanupResult,
} from '../local_provenance.js';
import {
  makeCodeGraphRemovedViewCleanupWorker,
  type CodeGraphRemovedViewCleanupPageResult,
  type CodeGraphRemovedViewCleanupWorkerResult,
} from '../removed_view/cleanup.js';
import {cleanupCodeGraphRemovedViewBuildStatusUnit} from '../removed_view/build_cleanup.js';
import {codeGraphLayout} from '../layout.js';
import {CodeGraphStore, type CodeGraphRoutineMaintenanceResult} from '../store.js';
import {
  codeGraphMaintenanceIntentActive,
  CodeGraphMaintenanceActiveError,
  withCodeGraphTargetWorktreeLock,
} from './gate.js';
import {
  CodeGraphStoreBusyError,
  CodeGraphStoreError,
  type RepositoryIdentity,
  type CodeGraphStoreFailure,
} from '../types.js';
import {
  CODE_GRAPH_ORDINARY_VECTOR_UNIT_DEADLINE_MILLISECONDS,
  type CodeGraphOrdinaryVectorMaintenanceUnitResult,
  runCodeGraphOrdinaryVectorMaintenanceUnit,
  withPreparedCodeGraphRemovedViewVectorUnit,
} from '../vector/maintenance.js';
import {makeLiveCodeGraphWorktreeReconciler} from '../worktree_reconciliation.js';
import {
  CODE_GRAPH_ORPHAN_PROVENANCE_CURSOR_RECOVERY_DIAGNOSTIC,
  makeLiveCodeGraphOrphanProvenanceCleaner,
} from '../orphan_provenance_cleanup.js';
import {inspectCodeGraphViewDatabaseTarget} from '../view_removal.js';
import {type CodeGraphStoragePressure} from '../storage/pressure.js';
import {codeGraphAnonymousTelemetryComponent, CodeGraphObservability} from '../runtime_ports.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT = 128;
export const CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_MILLISECONDS = 2_000;
export const CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_UNITS = 16;
export const CODE_GRAPH_MAINTENANCE_LANES = ['residual', 'reconciliation', 'ordinary'] as const;

export type CodeGraphMaintenanceLane = (typeof CODE_GRAPH_MAINTENANCE_LANES)[number];
export type {CodeGraphStoragePressure} from '../storage/pressure.js';
type CodeGraphMaintenanceStoragePressure = Extract<CodeGraphStoragePressure, 'critical' | 'elevated'>;

const CODE_GRAPH_MAINTENANCE_TRAILING = Symbol('codeGraphMaintenanceTrailing');

export interface CodeGraphRoutineMaintenanceTick {
  readonly allowIndexPreparation?: true;
  readonly anchorIdentity?: RepositoryIdentity;
  /** Scoped callers retain build-history sidecars for the selected graph view only. */
  readonly anchorScopeId?: string;
  /** Trusted local path resolved only after a missing-view candidate is observed. */
  readonly anchorPath?: string;
  /** One-shot foreground work can suppress the detached automatic tail. Defaults to true. */
  readonly automaticTail?: boolean;
  readonly checkoutId: string;
  readonly databasePath: string;
  /** Foreground probes can defer instead of joining an already-running unit. Defaults to true. */
  readonly joinActive?: boolean;
  /** Start the bounded lane cycle with physical reclaim under observed pressure. */
  readonly pressure?: CodeGraphMaintenanceStoragePressure;
  readonly threadnoteHome: string;
  readonly writerLockPath: string;
}

export interface CodeGraphMaintenanceCoordinatorShape {
  /** Run exactly one nonblocking Store routine unit without entering a target-worktree lane. */
  readonly kickOrdinary: (
    input: CodeGraphRoutineMaintenanceTick,
  ) => Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>;
  /** Run exactly one nonblocking missing-worktree reconciliation unit without rotating through other lanes. */
  readonly kickReconciliation: (
    input: CodeGraphRoutineMaintenanceTick,
  ) => Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>;
  /** Run exactly one nonblocking residual unit without starting a full maintenance round. */
  readonly kickResidual: (
    input: CodeGraphRoutineMaintenanceTick,
  ) => Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>;
  readonly request: (input: CodeGraphRoutineMaintenanceTick) => Effect.Effect<void>;
  readonly tick: (
    input: CodeGraphRoutineMaintenanceTick,
  ) => Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>;
}

export type CodeGraphRoutineMaintenanceRun = (
  input: CodeGraphRoutineMaintenanceTick,
) => Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>;

export interface CodeGraphMaintenanceLaneRuns {
  readonly ordinary: CodeGraphRoutineMaintenanceRun;
  readonly reconciliation: CodeGraphRoutineMaintenanceRun;
  readonly residual: CodeGraphRoutineMaintenanceRun;
}

export interface CodeGraphOrdinaryMaintenanceRuns {
  readonly routine: CodeGraphRoutineMaintenanceRun;
  readonly vector: (
    input: CodeGraphRoutineMaintenanceTick,
  ) => Effect.Effect<CodeGraphOrdinaryVectorMaintenanceUnitResult, CodeGraphStoreFailure>;
}

export type CodeGraphRoutineMaintenanceIntentCheck = (
  threadnoteHome: string,
) => Effect.Effect<boolean, CodeGraphStoreFailure>;

export interface CodeGraphMaintenanceCoordinatorInterlocks {
  /** @internal Deterministic cancellation barrier after request admission and before child handoff. */
  readonly afterRequestAdmission?: () => Effect.Effect<void>;
  /** @internal Deterministic monotonic clock for automatic-tail budget tests. */
  readonly monotonicMilliseconds?: () => number;
  /** @internal Closed terminal observation for detached maintenance work. */
  readonly onDeferredFailure?: (error: CodeGraphStoreFailure) => Effect.Effect<void>;
}

interface ActiveMaintenanceTick {
  readonly budget: MaintenanceExecutionBudget;
  readonly completion: Deferred.Deferred<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>;
  readonly databasePath: string;
  readonly input: CodeGraphRoutineMaintenanceTick;
}

interface MaintenanceExecutionBudget {
  readonly startedAt: number;
  readonly units: number;
}

interface PendingMaintenanceTick {
  readonly budget: MaintenanceExecutionBudget;
  readonly input: CodeGraphRoutineMaintenanceTick;
}

interface HomeMaintenanceState {
  readonly active: ActiveMaintenanceTick;
  readonly pending: ReadonlyMap<string, PendingMaintenanceTick>;
}

interface HomeMaintenanceLaneState {
  readonly cycleStartIndex?: number;
  readonly nextLaneIndex: number;
  readonly remaining: readonly [boolean, boolean, boolean];
}

interface MaintenanceLaneRunnerState {
  readonly databaseStates: ReadonlyMap<string, HomeMaintenanceLaneState>;
  readonly homeNextLaneIndexes: ReadonlyMap<string, number>;
}

interface OrdinaryMaintenanceRunnerEntry {
  readonly activeToken?: object;
  readonly next: 'routine' | 'vector';
  readonly routineRemaining: boolean;
  readonly vectorRemaining: boolean;
}

type MaintenanceLaneSelection =
  | {readonly databaseKey: string; readonly laneIndex: number; readonly state: 'selected'}
  | {readonly state: 'capacity-full'};

type MaintenanceTickDecision =
  | {readonly completion: ActiveMaintenanceTick['completion']; readonly state: 'join'}
  | {readonly state: 'deferred'}
  | {readonly completion: ActiveMaintenanceTick['completion']; readonly state: 'start'};

type MaintenanceRequestDecision =
  {readonly state: 'queued'} | {readonly completion: ActiveMaintenanceTick['completion']; readonly state: 'start'};

export class CodeGraphMaintenanceCoordinator extends Context.Service<
  CodeGraphMaintenanceCoordinator,
  CodeGraphMaintenanceCoordinatorShape
>()('@threadnote/graph/maintenance/coordinator/CodeGraphMaintenanceCoordinator') {
  static readonly layer = Layer.effect(
    CodeGraphMaintenanceCoordinator,
    Effect.gen(function* () {
      const store = yield* CodeGraphStore;
      const command = yield* CommandExecutor;
      const observability = yield* CodeGraphObservability;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      const reconciler = yield* makeLiveCodeGraphWorktreeReconciler();
      const orphanProvenanceCleaner = yield* makeLiveCodeGraphOrphanProvenanceCleaner();
      const runRoutineMaintenance = (input: CodeGraphRoutineMaintenanceTick) =>
        store.runRoutineMaintenance(input.databasePath, {
          checkoutId: input.checkoutId,
          threadnoteHome: input.threadnoteHome,
          writerLockPath: input.writerLockPath,
        });
      const runBuildHistoryMaintenance: CodeGraphRoutineMaintenanceRun = input => {
        const identity = input.anchorIdentity;
        if (identity === undefined || identity.checkoutId !== input.checkoutId) {
          return Effect.succeed(emptyMaintenanceResult());
        }
        const layout = codeGraphLayout(
          path,
          input.threadnoteHome,
          input.checkoutId,
          identity.worktreeId,
          input.anchorScopeId,
        );
        if (layout.databasePath !== input.databasePath) return Effect.succeed(emptyMaintenanceResult());
        return maintainCodeGraphBuildHistoryUnit(layout, identity.worktreeId).pipe(
          Effect.map(result => {
            if (result.state === 'complete') return emptyMaintenanceResult();
            if (result.state === 'deferred') {
              return {reason: 'status-sidecar-unavailable', state: 'deferred'} as const;
            }
            return {
              ...emptyMaintenanceResult(),
              cleanup: result.removedAbandoned === true ? ('build-status-history' as const) : ('none' as const),
              remaining: true,
            };
          }),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
        );
      };
      const revalidateResidualTarget = (input: {
        readonly checkoutId: string;
        readonly databasePath: string;
        readonly threadnoteHome: string;
      }) =>
        Effect.gen(function* () {
          const inspected = yield* inspectCodeGraphViewDatabaseTarget(input.threadnoteHome, input.checkoutId);
          if (inspected.state !== 'ready' || inspected.databasePath !== input.databasePath) {
            return yield* CodeGraphStoreError.of('Code graph cleanup database target changed.');
          }
          if (yield* codeGraphMaintenanceIntentActive(input.threadnoteHome)) {
            return yield* CodeGraphMaintenanceActiveError.of();
          }
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
        );
      const residualWorker = yield* makeCodeGraphRemovedViewCleanupWorker({
        authorize: (input, entry) =>
          store.authorizeRemovedViewCleanup(input.databasePath, entry, {
            beforeDatabaseOpen: () => revalidateResidualTarget(input),
            waitTimeoutMilliseconds: 0,
          }),
        claim: (input, nowMilliseconds, limit) =>
          store.claimRemovedViewCleanupCandidates(input.databasePath, nowMilliseconds, limit, {
            beforeDatabaseOpen: () => revalidateResidualTarget(input),
            waitTimeoutMilliseconds: 0,
          }),
        cleanupBuildStatusUnit: (input, entry) =>
          cleanupCodeGraphRemovedViewBuildStatusUnit(
            input.threadnoteHome,
            input.checkoutId,
            entry.worktreeId,
            entry.expectedSnapshotId,
            entry.cursorToken,
            ...(entry.scopeId === undefined ? [] : [{scopeId: entry.scopeId}]),
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
          ),
        cleanupProvenanceUnit: (input, entry) =>
          cleanupMissingCodeGraphLocalProvenance(
            input.threadnoteHome,
            {checkoutId: input.checkoutId, worktreeId: entry.worktreeId},
            {
              expectedEvidence: {
                checkoutId: input.checkoutId,
                recordDigest: entry.provenanceRecordDigest!,
                recordIdentity: entry.provenanceRecordIdentity!,
                repositoryId: entry.repositoryId!,
                worktreeId: entry.worktreeId,
              },
            },
          ).pipe(
            Effect.map(codeGraphRemovedViewProvenancePageResult),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(CommandExecutor, command),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
          ),
        monotonicMilliseconds: Effect.sync(() => performance.now()),
        nowMilliseconds: Clock.currentTimeMillis,
        sleep: milliseconds => Effect.sleep(milliseconds),
        update: (input, entry, update) =>
          store.updateRemovedViewCleanup(input.databasePath, entry, update, {
            beforeDatabaseOpen: () => revalidateResidualTarget(input),
            waitTimeoutMilliseconds: 0,
          }),
        withPreparedVectorUnit: (input, entry, preparation, use) =>
          entry.phase === 'vector-pointers'
            ? withPreparedCodeGraphRemovedViewVectorUnit(
                input,
                {...entry, phase: 'vector-pointers'},
                preparation,
                use,
              ).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, system),
              )
            : use(
                Effect.succeed({
                  blockedCode: 'invalid-sidecar',
                  retryAfterMilliseconds: 30_000,
                  state: 'deferred',
                }),
              ),
        withTargetLock: (input, worktreeId, effect, scopeId) =>
          withCodeGraphTargetWorktreeLock(input.threadnoteHome, input.checkoutId, worktreeId, effect, scopeId).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
          ),
      });
      const runResidualCleanup: CodeGraphRoutineMaintenanceRun = input =>
        residualWorker.tick(input).pipe(Effect.map(result => residualMaintenanceResult(result)));
      const runReconciliation: CodeGraphRoutineMaintenanceRun = input =>
        reconciler.tick(input).pipe(
          Effect.flatMap((result): Effect.Effect<CodeGraphRoutineMaintenanceResult> => {
            if (result.state === 'removed') {
              return Effect.succeed({
                cleanup: 'removed-worktree-view',
                expiredLeases: 0,
                remaining: true,
                retiredSnapshots: result.retiredSnapshots,
                rowsDeleted: 0,
                state: 'completed',
              } as const satisfies CodeGraphRoutineMaintenanceResult);
            }
            if (result.reason === 'external-maintenance') {
              return Effect.succeed({reason: 'external-maintenance', state: 'deferred'} as const);
            }
            if (result.state === 'deferred' && result.reason === 'writer-busy') {
              return Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const);
            }
            if (result.state === 'deferred' && result.reason === 'catalog-unavailable') {
              return Effect.succeed({reason: 'schema-unavailable', state: 'skipped'} as const);
            }
            return orphanProvenanceCleaner.tick(input).pipe(
              Effect.map((orphan): CodeGraphRoutineMaintenanceResult => {
                const diagnostics =
                  orphan.cursorRecovery === undefined
                    ? {}
                    : {diagnostics: [CODE_GRAPH_ORPHAN_PROVENANCE_CURSOR_RECOVERY_DIAGNOSTIC] as const};
                if (orphan.state === 'removed') {
                  return {
                    cleanup: 'orphan-provenance',
                    ...diagnostics,
                    expiredLeases: 0,
                    remaining: true,
                    retiredSnapshots: 0,
                    rowsDeleted: 0,
                    state: 'completed',
                  } as const satisfies CodeGraphRoutineMaintenanceResult;
                }
                if (orphan.reason === 'external-maintenance') {
                  return {reason: 'external-maintenance', ...diagnostics, state: 'deferred'} as const;
                }
                if (orphan.state === 'deferred' && orphan.reason === 'writer-busy') {
                  return {reason: 'writer-busy', ...diagnostics, state: 'deferred'} as const;
                }
                if (orphan.state === 'deferred' && orphan.reason === 'catalog-unavailable') {
                  return {reason: 'schema-unavailable', ...diagnostics, state: 'skipped'} as const;
                }
                return {...emptyMaintenanceResult(), ...diagnostics};
              }),
            );
          }),
        );
      const runReconciliationOrPreparationWithoutHistory: CodeGraphRoutineMaintenanceRun = input => {
        if (input.allowIndexPreparation !== true) return runReconciliation(input);
        return store
          .prepareWorktreeReconciliationIndexes(input.databasePath, {
            beforeDatabaseOpen: () =>
              Effect.gen(function* () {
                const inspected = yield* inspectCodeGraphViewDatabaseTarget(input.threadnoteHome, input.checkoutId);
                if (inspected.state !== 'ready' || inspected.databasePath !== input.databasePath) {
                  return yield* CodeGraphStoreError.of('Code graph database target changed before index preparation.');
                }
                if (yield* codeGraphMaintenanceIntentActive(input.threadnoteHome)) {
                  return yield* CodeGraphMaintenanceActiveError.of();
                }
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, system),
              ),
            waitTimeoutMilliseconds: 0,
          })
          .pipe(
            Effect.flatMap((result): Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure> =>
              result.state === 'prepared'
                ? Effect.succeed({
                    cleanup: 'reconciliation-index',
                    expiredLeases: 0,
                    remaining: true,
                    retiredSnapshots: 0,
                    rowsDeleted: 0,
                    state: 'completed',
                  } as const satisfies CodeGraphRoutineMaintenanceResult)
                : result.state === 'migration-ready'
                  ? store.initialize(input.databasePath, {waitTimeoutMilliseconds: 0}).pipe(
                      Effect.as({
                        cleanup: 'schema-migration',
                        expiredLeases: 0,
                        remaining: true,
                        retiredSnapshots: 0,
                        rowsDeleted: 0,
                        state: 'completed',
                      } as const satisfies CodeGraphRoutineMaintenanceResult),
                    )
                  : result.state === 'deferred'
                    ? Effect.succeed({reason: 'schema-unavailable', state: 'skipped'} as const)
                    : runReconciliation(input),
            ),
            Effect.catch((error): Effect.Effect<CodeGraphRoutineMaintenanceResult> =>
              Schema.is(CodeGraphMaintenanceActiveError)(error)
                ? Effect.succeed({reason: 'external-maintenance', state: 'deferred'} as const)
                : Schema.is(CodeGraphStoreBusyError)(error)
                  ? Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const)
                  : Effect.succeed({reason: 'schema-unavailable', state: 'skipped'} as const),
            ),
          );
      };
      const runReconciliationOrPreparation: CodeGraphRoutineMaintenanceRun = input =>
        runBuildHistoryMaintenance(input).pipe(
          Effect.filterOrElse(
            history => history.state === 'completed' && Boolean(history.remaining),
            history =>
              runReconciliationOrPreparationWithoutHistory(input).pipe(
                Effect.map(reconciliation =>
                  history.state === 'deferred' && maintenanceResultIsEmpty(reconciliation) ? history : reconciliation,
                ),
              ),
          ),
        );
      const runVectorMaintenance: CodeGraphOrdinaryMaintenanceRuns['vector'] = input =>
        Effect.sync(() => performance.now()).pipe(
          Effect.flatMap(startedAt =>
            runCodeGraphOrdinaryVectorMaintenanceUnit(
              {checkoutId: input.checkoutId, threadnoteHome: input.threadnoteHome},
              {
                deadlineMonotonicMilliseconds: startedAt + CODE_GRAPH_ORDINARY_VECTOR_UNIT_DEADLINE_MILLISECONDS,
                monotonicMilliseconds: () => performance.now(),
                reservationMode: 'nonblocking-one-attempt',
              },
            ),
          ),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
          Effect.mapError(() => CodeGraphStoreError.of('Could not maintain code graph vector retirement.')),
        );
      const runOrdinaryMaintenance = yield* makeCodeGraphOrdinaryMaintenanceRunner({
        routine: runRoutineMaintenance,
        vector: runVectorMaintenance,
      });
      const runMaintenanceLane = yield* makeCodeGraphMaintenanceLaneRunner({
        ordinary: runOrdinaryMaintenance,
        reconciliation: runReconciliationOrPreparation,
        residual: runResidualCleanup,
      });
      return yield* makeCodeGraphMaintenanceCoordinator(
        runMaintenanceLane,
        threadnoteHome =>
          codeGraphMaintenanceIntentActive(threadnoteHome).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
            Effect.mapError(() => CodeGraphStoreError.of('Could not inspect code graph maintenance coordination.')),
          ),
        {
          onDeferredFailure: error =>
            observability.backgroundFailure(codeGraphAnonymousTelemetryComponent(system.environment()), {
              operation: 'graph-maintenance',
              error,
            }),
        },
        runResidualCleanup,
        runRoutineMaintenance,
        runReconciliationOrPreparationWithoutHistory,
      );
    }),
  );
}

function residualMaintenanceResult(result: CodeGraphRemovedViewCleanupWorkerResult): CodeGraphRoutineMaintenanceResult {
  if (result.state === 'deferred') return {reason: 'writer-busy', state: 'deferred'};
  return {
    cleanup: result.progressed > 0 || result.advanced > 0 ? 'removed-worktree-view' : 'none',
    expiredLeases: 0,
    remaining: result.remaining,
    retiredSnapshots: 0,
    rowsDeleted: 0,
    state: 'completed',
  };
}

/** @internal Exact terminal/deferred policy for durable provenance cleanup. */
export function codeGraphRemovedViewProvenancePageResult(
  result: CodeGraphLocalProvenanceCleanupResult,
): CodeGraphRemovedViewCleanupPageResult {
  if (result.state === 'unavailable') {
    return {blockedCode: 'io-error', retryAfterMilliseconds: 1_000, state: 'deferred'};
  }
  if (result.state === 'preserved' && result.observedState !== 'stale' && result.observedState !== 'missing') {
    return {blockedCode: 'invalid-sidecar', retryAfterMilliseconds: 30_000, state: 'deferred'};
  }
  return {state: 'complete'};
}

/**
 * Rotate bounded maintenance starts per home while each database owns its
 * active full-round state. A cycle samples every lane once, then self-tails
 * only while a lane reports concrete remaining work. Active database rounds
 * are never evicted or allowed to consume another database's progress.
 */
export const makeCodeGraphMaintenanceLaneRunner = Effect.fn('codeGraph.makeMaintenanceLaneRunner')(function* (
  runs: CodeGraphMaintenanceLaneRuns,
) {
  const runnerState = yield* SynchronizedRef.make<MaintenanceLaneRunnerState>({
    databaseStates: new Map(),
    homeNextLaneIndexes: new Map(),
  });
  return (
    input: CodeGraphRoutineMaintenanceTick,
  ): Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure> =>
    Effect.gen(function* () {
      const selection = yield* SynchronizedRef.modify<MaintenanceLaneRunnerState, MaintenanceLaneSelection>(
        runnerState,
        current => selectMaintenanceLane(current, input),
      );
      if (selection.state === 'capacity-full') {
        return {reason: 'home-tick-active', state: 'deferred'} as const;
      }
      const {databaseKey, laneIndex} = selection;
      const lane = CODE_GRAPH_MAINTENANCE_LANES[laneIndex];
      const result = yield* runs[lane](input);
      const laneRemaining = result.state === 'completed' && result.remaining;
      const shouldContinue = yield* SynchronizedRef.modify<MaintenanceLaneRunnerState, boolean>(
        runnerState,
        current => {
          const existing = current.databaseStates.get(databaseKey);
          if (existing === undefined || existing.cycleStartIndex === undefined) return [false, current] as const;
          const remaining = [...existing.remaining] as [boolean, boolean, boolean];
          remaining[laneIndex] = laneRemaining;
          const advanced = (laneIndex + 1) % CODE_GRAPH_MAINTENANCE_LANES.length;
          const completedCycle = advanced === existing.cycleStartIndex;
          const hasRemaining = EffectArray.some(remaining, Boolean);
          const nextState: HomeMaintenanceLaneState =
            completedCycle && !hasRemaining
              ? {
                  nextLaneIndex: advanced,
                  remaining: [false, false, false],
                }
              : {...existing, nextLaneIndex: advanced, remaining};
          const databaseStates = new Map(current.databaseStates);
          databaseStates.delete(databaseKey);
          databaseStates.set(databaseKey, nextState);
          return [!completedCycle || hasRemaining, {...current, databaseStates}] as const;
        },
      );
      if (!shouldContinue) return result;
      return Object.defineProperty({...result}, CODE_GRAPH_MAINTENANCE_TRAILING, {value: true});
    });
});

/**
 * Alternate the home-global vector collector with the existing Store routine
 * collector. Each database retains only the bounded sublane bit and the two
 * concrete remaining signals; an active entry is never evicted.
 */
export const makeCodeGraphOrdinaryMaintenanceRunner = Effect.fn('codeGraph.makeOrdinaryMaintenanceRunner')(function* (
  runs: CodeGraphOrdinaryMaintenanceRuns,
) {
  const state = yield* SynchronizedRef.make(new Map<string, OrdinaryMaintenanceRunnerEntry>());
  return (
    input: CodeGraphRoutineMaintenanceTick,
  ): Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure> =>
    Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const key = maintenanceLaneDatabaseKey(input);
        const token = {};
        const selected = yield* SynchronizedRef.modify<
          Map<string, OrdinaryMaintenanceRunnerEntry>,
          OrdinaryMaintenanceRunnerEntry | undefined
        >(state, current => {
          const existing = current.get(key);
          if (existing?.activeToken !== undefined) return [undefined, current] as const;
          const next = new Map(current);
          if (existing === undefined && next.size >= CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT) {
            const inactive = EffectOption.getOrUndefined(
              EffectArray.findFirst([...next.entries()], ([, entry]) => entry.activeToken === undefined),
            );
            if (inactive === undefined) return [undefined, current] as const;
            next.delete(inactive[0]);
          }
          const entry = existing ?? {
            next: 'vector',
            routineRemaining: false,
            vectorRemaining: false,
          };
          next.delete(key);
          next.set(key, {...entry, activeToken: token});
          return [entry, next] as const;
        });
        if (selected === undefined) return {reason: 'home-tick-active', state: 'deferred'} as const;

        const storeState = (entry: OrdinaryMaintenanceRunnerEntry) =>
          SynchronizedRef.update(state, current => {
            const observed = current.get(key);
            if (observed?.activeToken !== token) return current;
            const next = new Map(current);
            next.delete(key);
            next.set(key, entry);
            return next;
          });
        const rotateAfterFailure = storeState({
          next: selected.next === 'vector' ? 'routine' : 'vector',
          routineRemaining: selected.routineRemaining,
          vectorRemaining: selected.vectorRemaining,
        });

        return yield* Effect.gen(function* () {
          if (selected.next === 'vector') {
            const exit = yield* restore(Effect.suspend(() => runs.vector(input))).pipe(Effect.exit);
            if (Exit.isFailure(exit)) {
              yield* rotateAfterFailure;
              return yield* Effect.failCause(exit.cause);
            }
            yield* storeState({
              next: 'routine',
              routineRemaining: selected.routineRemaining,
              vectorRemaining: exit.value.state === 'progress',
            });
            return {...emptyMaintenanceResult(), remaining: true};
          }

          const exit = yield* restore(Effect.suspend(() => runs.routine(input))).pipe(Effect.exit);
          if (Exit.isFailure(exit)) {
            yield* rotateAfterFailure;
            return yield* Effect.failCause(exit.cause);
          }
          const routineRemaining = exit.value.state === 'completed' && exit.value.remaining;
          yield* storeState({next: 'vector', routineRemaining, vectorRemaining: selected.vectorRemaining});
          const remaining = routineRemaining || selected.vectorRemaining;
          if (exit.value.state === 'completed') return {...exit.value, remaining};
          return remaining ? {...emptyMaintenanceResult(), remaining: true} : exit.value;
        }).pipe(Effect.ensuring(rotateAfterFailure));
      }),
    );
});

function selectMaintenanceLane(
  current: MaintenanceLaneRunnerState,
  input: CodeGraphRoutineMaintenanceTick,
): readonly [MaintenanceLaneSelection, MaintenanceLaneRunnerState] {
  const databaseKey = maintenanceLaneDatabaseKey(input);
  const existing = current.databaseStates.get(databaseKey);
  if (existing?.cycleStartIndex !== undefined) {
    return [{databaseKey, laneIndex: existing.nextLaneIndex, state: 'selected'}, current] as const;
  }

  const databaseStates = new Map(current.databaseStates);
  if (existing === undefined && databaseStates.size >= CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT) {
    const inactive = EffectOption.getOrUndefined(
      EffectArray.findFirst([...databaseStates.entries()], ([, candidate]) => candidate.cycleStartIndex === undefined),
    );
    if (inactive === undefined) return [{state: 'capacity-full'}, current] as const;
    databaseStates.delete(inactive[0]);
  }

  const homeNextLaneIndexes = new Map(current.homeNextLaneIndexes);
  if (
    !homeNextLaneIndexes.has(input.threadnoteHome) &&
    homeNextLaneIndexes.size >= CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT
  ) {
    const activeHomes = new Set(
      EffectArray.map(
        EffectArray.filter([...databaseStates.entries()], ([, candidate]) => candidate.cycleStartIndex !== undefined),
        ([key]) => maintenanceLaneHomeFromDatabaseKey(key),
      ),
    );
    const inactiveHome = EffectOption.getOrUndefined(
      EffectArray.findFirst([...homeNextLaneIndexes.keys()], home => !activeHomes.has(home)),
    );
    if (inactiveHome === undefined) return [{state: 'capacity-full'}, current] as const;
    homeNextLaneIndexes.delete(inactiveHome);
  }

  const laneIndex =
    input.pressure === undefined
      ? (homeNextLaneIndexes.get(input.threadnoteHome) ?? 0)
      : CODE_GRAPH_MAINTENANCE_LANES.indexOf('ordinary');
  homeNextLaneIndexes.delete(input.threadnoteHome);
  homeNextLaneIndexes.set(input.threadnoteHome, (laneIndex + 1) % CODE_GRAPH_MAINTENANCE_LANES.length);
  databaseStates.delete(databaseKey);
  databaseStates.set(databaseKey, {
    cycleStartIndex: laneIndex,
    nextLaneIndex: laneIndex,
    remaining: [false, false, false],
  });
  return [
    {databaseKey, laneIndex, state: 'selected'},
    {databaseStates, homeNextLaneIndexes},
  ] as const;
}

function maintenanceLaneDatabaseKey(input: CodeGraphRoutineMaintenanceTick): string {
  return `${input.threadnoteHome}\u0000${input.databasePath}`;
}

function maintenanceLaneHomeFromDatabaseKey(databaseKey: string): string {
  return Effect2.pipe(
    databaseKey,
    EffectString.slice(
      0,
      Effect2.pipe(
        databaseKey,
        EffectString.indexOf('\u0000'),
        Effect2.Option.getOrElse(() => -1),
      ),
    ),
  );
}

function emptyMaintenanceResult(): CodeGraphRoutineMaintenanceResult {
  return {
    cleanup: 'none',
    expiredLeases: 0,
    remaining: false,
    retiredSnapshots: 0,
    rowsDeleted: 0,
    state: 'completed',
  };
}

function maintenanceResultIsEmpty(result: CodeGraphRoutineMaintenanceResult): boolean {
  return result.state === 'completed' && result.cleanup === 'none' && !result.remaining;
}

/**
 * Coalesce callers for one database and retain a bounded insertion-order queue
 * for distinct databases without making their foreground callers await it.
 */
export const makeCodeGraphMaintenanceCoordinator = Effect.fn('codeGraph.makeMaintenanceCoordinator')(function* (
  run: CodeGraphRoutineMaintenanceRun,
  externalMaintenanceActive: CodeGraphRoutineMaintenanceIntentCheck = () => Effect.succeed(false),
  interlocks: CodeGraphMaintenanceCoordinatorInterlocks = {},
  kickResidual: CodeGraphRoutineMaintenanceRun = run,
  kickOrdinary: CodeGraphRoutineMaintenanceRun = run,
  kickReconciliation: CodeGraphRoutineMaintenanceRun = run,
) {
  const scope = yield* Effect.scope;
  const stateByHome = yield* SynchronizedRef.make(new Map<string, HomeMaintenanceState>());
  const monotonicMilliseconds = interlocks.monotonicMilliseconds ?? (() => performance.now());
  const onDeferredFailure = interlocks.onDeferredFailure;
  const newBudget = (): MaintenanceExecutionBudget => ({startedAt: monotonicMilliseconds(), units: 0});

  const execute = (
    input: CodeGraphRoutineMaintenanceTick,
    completion: ActiveMaintenanceTick['completion'],
    budget: MaintenanceExecutionBudget,
  ): Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure> =>
    Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const exit = yield* restore(
          externalMaintenanceActive(input.threadnoteHome).pipe(
            Effect.flatMap((active): Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure> =>
              active
                ? Effect.succeed({
                    reason: 'external-maintenance',
                    state: 'deferred',
                  } as const satisfies CodeGraphRoutineMaintenanceResult)
                : run(input),
            ),
          ),
        ).pipe(Effect.exit);
        const completedBudget = {...budget, units: budget.units + 1};
        const shouldTail =
          input.automaticTail !== false &&
          Exit.isSuccess(exit) &&
          automaticTailBudgetAvailable(completedBudget, monotonicMilliseconds()) &&
          ((exit.value as CodeGraphRoutineMaintenanceResult & {[CODE_GRAPH_MAINTENANCE_TRAILING]?: true})[
            CODE_GRAPH_MAINTENANCE_TRAILING
          ] === true ||
            ('remaining' in exit.value && exit.value.remaining === true));
        yield* Deferred.done(completion, exit);
        const nextCompletion = yield* Deferred.make<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>();
        const next = yield* SynchronizedRef.modify<
          Map<string, HomeMaintenanceState>,
          ActiveMaintenanceTick | undefined
        >(stateByHome, current => {
          const home = current.get(input.threadnoteHome);
          if (home?.active.completion !== completion) return [undefined, current] as const;
          const pending = new Map(home.pending);
          if (shouldTail) {
            const existing = pending.get(input.databasePath);
            pending.delete(input.databasePath);
            pending.set(input.databasePath, {
              budget: existing?.budget ?? completedBudget,
              input: mergeMaintenanceTick(input, existing?.input ?? input),
            });
          }
          const nextEntry = pending.entries().next().value;
          const updated = new Map(current);
          if (nextEntry === undefined) {
            updated.delete(input.threadnoteHome);
            return [undefined, updated] as const;
          }
          const [databasePath, queued] = nextEntry;
          pending.delete(databasePath);
          const active = {completion: nextCompletion, databasePath, ...queued};
          updated.set(input.threadnoteHome, {
            active,
            pending,
          });
          return [active, updated] as const;
        });
        if (next !== undefined) {
          yield* execute(next.input, next.completion, next.budget).pipe(
            Effect.tapError(error =>
              Effect.logWarning(`Deferred code graph maintenance failed (${error.code}).`).pipe(
                Effect.andThen(
                  onDeferredFailure === undefined
                    ? Effect.void
                    : Effect.suspend(() => onDeferredFailure(error)).pipe(Effect.ignoreCause),
                ),
              ),
            ),
            Effect.ignore,
            Effect.forkIn(scope),
            Effect.asVoid,
          );
        }
        return yield* restore(Deferred.await(completion));
      }),
    );

  const tick = (input: CodeGraphRoutineMaintenanceTick) =>
    Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>();
        const budget = newBudget();
        const decision = yield* SynchronizedRef.modify<Map<string, HomeMaintenanceState>, MaintenanceTickDecision>(
          stateByHome,
          current => {
            const home = current.get(input.threadnoteHome);
            if (home !== undefined) {
              const pending = new Map(home.pending);
              const decision: MaintenanceTickDecision =
                home.active.databasePath === input.databasePath && input.joinActive !== false
                  ? {completion: home.active.completion, state: 'join'}
                  : {state: 'deferred'};
              const existingPending = pending.get(input.databasePath);
              const needsAuthoritativeTrailing =
                decision.state === 'join' &&
                home.active.input.anchorIdentity === undefined &&
                input.anchorIdentity !== undefined;
              const needsPreparationTrailing =
                decision.state === 'join' &&
                home.active.input.allowIndexPreparation !== true &&
                input.allowIndexPreparation === true;
              const needsTrailing = needsAuthoritativeTrailing || needsPreparationTrailing;
              const ordinaryPendingCount = EffectArray.filter(
                [...pending.keys()],
                databasePath => databasePath !== home.active.databasePath,
              ).length;
              let changed = false;
              if (decision.state === 'deferred' && existingPending !== undefined) {
                pending.set(input.databasePath, {
                  budget,
                  input: mergeMaintenanceTick(existingPending.input, input),
                });
                changed = true;
              } else if (
                decision.state === 'deferred' &&
                ordinaryPendingCount < CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT - 1
              ) {
                pending.set(input.databasePath, {budget, input});
                changed = true;
              } else if (needsTrailing) {
                pending.set(input.databasePath, {
                  budget,
                  input: mergeMaintenanceTick(existingPending?.input ?? home.active.input, input),
                });
                changed = true;
              }
              if (!changed) return [decision, current] as const;
              const updated = new Map(current);
              updated.set(input.threadnoteHome, {...home, pending});
              return [decision, updated] as const;
            }
            const next = new Map(current);
            next.set(input.threadnoteHome, {
              active: {budget, completion: candidate, databasePath: input.databasePath, input},
              pending: new Map(),
            });
            return [{completion: candidate, state: 'start'}, next] as const;
          },
        );

        if (decision.state === 'deferred') {
          return {reason: 'home-tick-active', state: 'deferred'} as const;
        }
        if (decision.state === 'join') return yield* restore(Deferred.await(decision.completion));

        return yield* restore(execute(input, candidate, budget));
      }),
    );

  const request = (input: CodeGraphRoutineMaintenanceTick) =>
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>();
        const budget = newBudget();
        const decision = yield* SynchronizedRef.modify<Map<string, HomeMaintenanceState>, MaintenanceRequestDecision>(
          stateByHome,
          current => {
            const home = current.get(input.threadnoteHome);
            if (home === undefined) {
              const next = new Map(current);
              next.set(input.threadnoteHome, {
                active: {budget, completion: candidate, databasePath: input.databasePath, input},
                pending: new Map(),
              });
              return [{completion: candidate, state: 'start'}, next] as const;
            }
            const pending = new Map(home.pending);
            const existing = pending.get(input.databasePath);
            let changed = false;
            if (home.active.databasePath === input.databasePath) {
              pending.set(input.databasePath, {
                budget,
                input: mergeMaintenanceTick(existing?.input ?? home.active.input, input),
              });
              changed = true;
            } else if (existing !== undefined) {
              pending.set(input.databasePath, {budget, input: mergeMaintenanceTick(existing.input, input)});
              changed = true;
            } else {
              const ordinaryPendingCount = EffectArray.filter(
                [...pending.keys()],
                databasePath => databasePath !== home.active.databasePath,
              ).length;
              if (ordinaryPendingCount < CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT - 1) {
                pending.set(input.databasePath, {budget, input});
                changed = true;
              }
            }
            if (!changed) return [{state: 'queued'}, current] as const;
            const next = new Map(current);
            next.set(input.threadnoteHome, {...home, pending});
            return [{state: 'queued'}, next] as const;
          },
        );
        yield* interlocks.afterRequestAdmission?.() ?? Effect.void;
        if (decision.state === 'queued') return;
        yield* execute(input, decision.completion, budget).pipe(
          Effect.interruptible,
          Effect.tapError(error => Effect.logWarning(`Requested code graph maintenance failed (${error.code}).`)),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      }),
    );

  return CodeGraphMaintenanceCoordinator.of({kickOrdinary, kickReconciliation, kickResidual, request, tick});
});

function automaticTailBudgetAvailable(budget: MaintenanceExecutionBudget, observedAt: number): boolean {
  return (
    Number.isSafeInteger(budget.units) &&
    budget.units >= 0 &&
    budget.units < CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_UNITS &&
    Number.isFinite(budget.startedAt) &&
    budget.startedAt >= 0 &&
    Number.isFinite(observedAt) &&
    observedAt >= budget.startedAt &&
    observedAt - budget.startedAt < CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_MILLISECONDS
  );
}

function mergeMaintenanceTick(
  existing: CodeGraphRoutineMaintenanceTick | undefined,
  incoming: CodeGraphRoutineMaintenanceTick,
): CodeGraphRoutineMaintenanceTick {
  if (existing === undefined) return incoming;
  return {
    ...incoming,
    allowIndexPreparation:
      incoming.allowIndexPreparation === true || existing.allowIndexPreparation === true ? true : undefined,
    anchorIdentity: incoming.anchorIdentity ?? existing.anchorIdentity,
    anchorScopeId: incoming.anchorScopeId ?? existing.anchorScopeId,
    anchorPath: incoming.anchorPath ?? existing.anchorPath,
    pressure: strongestStoragePressure(existing.pressure, incoming.pressure),
  };
}

function strongestStoragePressure(
  left: CodeGraphMaintenanceStoragePressure | undefined,
  right: CodeGraphMaintenanceStoragePressure | undefined,
): CodeGraphMaintenanceStoragePressure | undefined {
  return left === 'critical' || right === 'critical' ? 'critical' : (left ?? right);
}
