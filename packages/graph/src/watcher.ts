import {
  Cause,
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Semaphore,
  Stream,
  SynchronizedRef,
  Schema,
} from 'effect';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from './indexer.js';
import {codeGraphSnapshotAdmissionCurrent, observeCodeGraphAdmissionEnvironment} from './admission_freshness.js';
import {inventoryRepository, worktreeBuildRequestState} from './inventory.js';
import {codeGraphInventoryScopeEvidence} from './inventory/scope.js';
import {CodeGraphMaintenanceCoordinator} from './maintenance/coordinator.js';
import {CodeGraphStore, type CodeGraphRoutineMaintenanceResult, type CodeGraphStoreShape} from './store.js';
import {CommandExecutor, runCommandEffect, type CommandOptions} from '@threadnote/platform/command';
import {readExclusiveFileLockOwner} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import type {CommandResult} from '@threadnote/platform/command';
import type {
  CodeGraphDiskCapacityFailureEvidence,
  CodeGraphProgress,
  CodeGraphStoreFailureCode,
  CodeGraphStoreRecovery,
  RepositoryIdentity,
} from './types.js';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {
  CodeGraphDiskCapacityObservationError,
  CodeGraphDiskCapacityPressureError,
  CodeGraphRuntimeReconnectRequiredError,
} from './types.js';
import {
  currentCodeGraphBuildStatus,
  readCodeGraphBuildStatuses,
  type ObservedCodeGraphBuildStatus,
} from './build_status.js';
import {
  isCodeGraphIsolatedBuilderHost,
  isolatedBuilderFailureFromStatus,
  runIsolatedCodeGraphIndex,
} from './isolated/builder.js';
import {codeGraphLayout, codeGraphWorktreeSpawnLockPath} from './layout.js';
import {
  completeCodeGraphBackgroundDemand,
  deferCodeGraphBackgroundDemand,
  codeGraphRefreshDemandContinuity,
  enqueueCodeGraphBackgroundDemand,
  failCodeGraphBackgroundDemand,
  recoverCodeGraphBackgroundDemand,
  registerCodeGraphBackgroundDemand,
  resumeCodeGraphBackgroundDemand,
  observeCodeGraphBackgroundDemand,
  CodeGraphRefreshDemandSuperseded,
} from './refresh/demand.js';
import type {CodeGraphRefreshDemandRegistration, CodeGraphRefreshDemandState} from './refresh/demand_scheduler.js';
import {runCodeGraphLifecycleOpportunity} from './lifecycle/opportunity.js';
import {classifyCodeGraphStoreFailure} from './store/failure.js';
import {
  codeGraphEtaMeasurement,
  makeCodeGraphEtaTracker,
  observeCodeGraphEta,
  type CodeGraphEtaTracker,
} from './progress/eta.js';
import {resolveRepositoryIdentity} from './repository.js';
import {
  makeCodeGraphAutomaticRecoveryCoordinator,
  type CodeGraphAutomaticRecoveryAdmission,
  type CodeGraphAutomaticRecoveryCoordinatorShape,
} from './recovery_coordinator.js';
import {codeGraphAnonymousTelemetryComponent, CodeGraphObservability} from './runtime_ports.js';
import type {CodeGraphBuilderAdmissionClass} from './builder/admission.js';
import {codeGraphBuildRequestKey} from './indexer/build.js';
import {extractorSetIdentity} from './indexer/materialization.js';
import {CodeGraphLanguagePackRegistry, type CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import {codeGraphSnapshotMatchesCurrentLanguagePacks} from './query/snapshot_runtime.js';
import {codeGraphScopeAdmissionEvidence, type CodeGraphScopeApplicabilityEvidence} from './scope/applicability.js';
import {
  compileThreadnoteIgnore,
  isIgnoredByThreadnote,
  isOverlayAdmissionControlPath,
  readThreadnoteIgnoreSources,
  type CompiledIgnoreRule,
} from './threadnote_ignore.js';
import {makeKeyedBackgroundScheduler} from './watcher_resume_scheduler.js';
import {makeCodeGraphWatchReconciliation} from './watcher_reconciliation.js';
export {makeCodeGraphWatchReconciliation};

export interface CodeGraphWatchOptions {
  readonly admissionClass?: CodeGraphBuilderAdmissionClass;
  readonly cwd: string;
  readonly key: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>;
  readonly onRefreshed?: (symbols: number, edges: number) => Effect.Effect<void>;
  /** @internal private in-process equivalent of the isolated child environment token. */
  readonly refreshDemandToken?: string;
  /** @internal A single-use durable registration bound to its observed target. */
  readonly refreshDemandPrepared?: CodeGraphPreparedRefreshDemand;
  readonly project?: Pick<ProjectManifest, 'graph' | 'uri'> & {readonly name?: string};
  readonly threadnoteHome: string;
}

interface CodeGraphBackgroundTarget {
  readonly admissionFingerprint: string;
  readonly demandIdentity: {
    readonly checkoutId: string;
    readonly scopeId?: string;
    readonly threadnoteHome: string;
    readonly worktreeId: string;
  };
  readonly identity: RepositoryIdentity;
  readonly layout: ReturnType<typeof codeGraphLayout>;
  readonly overlay: {readonly dirty: boolean; readonly fingerprint?: string};
  readonly requestKey: string;
  readonly scopeEvidence?: CodeGraphScopeApplicabilityEvidence;
  readonly scopeId?: string;
}

/** @internal Never serialize a registration separately from the target it claimed. */
export interface CodeGraphPreparedRefreshDemand {
  readonly registration: CodeGraphRefreshDemandRegistration;
  readonly target: CodeGraphBackgroundTarget;
}

export interface CodeGraphProgressTiming {
  readonly buildId: string;
  readonly elapsedMilliseconds: number;
  readonly estimateConfidence?: 'high' | 'low' | 'medium';
  readonly estimateScope?: 'phase';
  readonly estimatedPhaseRemainingMilliseconds?: number;
  readonly lastProgressAgeMilliseconds: number;
  readonly phaseElapsedMilliseconds: number;
  readonly phaseStartedAtMilliseconds: number;
  readonly startedAtMilliseconds: number;
  readonly updatedAtMilliseconds: number;
}

export interface CodeGraphRefreshFailure {
  readonly code: CodeGraphStoreFailureCode;
  readonly evidence?: CodeGraphDiskCapacityFailureEvidence;
  readonly operation: 'refresh code graph';
  readonly recovery: CodeGraphStoreRecovery;
  readonly retryable: boolean;
}

export interface CodeGraphRefreshContinuity {
  readonly type: 'code-graph-refresh-continuity';
  readonly version: 1;
  readonly state: 'active' | 'queued' | 'deferred' | 'idle';
  readonly failure?: CodeGraphRefreshFailure;
  readonly queueToken?: string;
  readonly currentTargetToken?: string;
  readonly latestDesiredToken?: string;
  readonly retryAfterMilliseconds?: number;
}

export interface CodeGraphRefreshRequestReceipt {
  readonly requestState: 'started' | 'attached' | 'queued' | 'deferred';
  readonly refresh: CodeGraphRefreshContinuity;
}

export type CodeGraphRefreshStatus =
  | ({
      readonly progress?: CodeGraphProgress;
      readonly state: 'indexing';
      readonly timing: CodeGraphProgressTiming;
    } & {readonly refresh?: CodeGraphRefreshContinuity})
  | ({
      readonly edges: number;
      readonly state: 'ready';
      readonly symbols: number;
    } & {readonly refresh?: CodeGraphRefreshContinuity})
  | ({
      readonly failure: CodeGraphRefreshFailure;
      readonly state: 'deferred';
    } & {readonly refresh?: CodeGraphRefreshContinuity});

export interface CodeGraphWatcherMetrics {
  readonly activeRefreshKeys: number;
  readonly activeWatches: number;
  readonly executingRefreshes: number;
  readonly executingRefreshHighWater: number;
  readonly idleSweepFibers: 0 | 1;
  readonly maximumWatchers: number;
  readonly pendingTrailingRefreshes: number;
  readonly retainedStatuses: number;
}

export interface CodeGraphWatcherShape {
  readonly cachedStatus: (
    key: string,
    target?: Pick<CodeGraphWatchOptions, 'cwd' | 'project' | 'threadnoteHome'>,
  ) => Effect.Effect<Option.Option<CodeGraphRefreshStatus>>;
  readonly ensure: (options: CodeGraphWatchOptions) => Effect.Effect<void>;
  readonly metrics: Effect.Effect<CodeGraphWatcherMetrics>;
  readonly refresh: (options: CodeGraphWatchOptions) => Effect.Effect<boolean>;
  /** Registers background demand before scheduling; never waits for a build. */
  readonly request: (options: CodeGraphWatchOptions) => Effect.Effect<CodeGraphRefreshRequestReceipt, unknown>;
  readonly scheduleRequest?: (options: CodeGraphWatchOptions) => Effect.Effect<void>;
  /** Resumes existing durable background demand without creating new demand. */
  readonly resume?: (options: CodeGraphWatchOptions) => Effect.Effect<CodeGraphRefreshContinuity | undefined, unknown>;
  readonly scheduleResume?: (options: CodeGraphWatchOptions) => Effect.Effect<void>;
  readonly status: (
    key: string,
    target?: Pick<CodeGraphWatchOptions, 'cwd' | 'project' | 'threadnoteHome'>,
  ) => Effect.Effect<Option.Option<CodeGraphRefreshStatus>, unknown>;
  readonly watch: (options: CodeGraphWatchOptions) => Effect.Effect<void, unknown>;
}
export interface CodeGraphWatcherLifecycleOptions {
  readonly idleTimeoutMilliseconds?: number;
  readonly maximumWatchers?: number;
  readonly onRefreshFailure?: (failure: CodeGraphRefreshFailure) => Effect.Effect<void>;
  readonly sweepIntervalMilliseconds?: number;
}

export type CodeGraphWatchRun = (
  options: CodeGraphWatchOptions,
  initialRefresh: boolean,
  requestRefresh: () => Effect.Effect<void>,
) => Effect.Effect<void, unknown>;

export type CodeGraphRefreshRun = (options: CodeGraphWatchOptions) => Effect.Effect<void, unknown>;

export type CodeGraphPrepareRefreshRun = (options: CodeGraphWatchOptions) => Effect.Effect<CodeGraphWatchOptions>;

export type CodeGraphRecoveryRun = (
  options: CodeGraphWatchOptions,
  failure: CodeGraphRefreshFailure,
) => Effect.Effect<void, unknown>;

export interface CodeGraphWatchReconciliationHooks {
  readonly changeRefreshRequired?: Effect.Effect<boolean, unknown>;
  readonly periodicRefreshRequired: Effect.Effect<boolean, unknown>;
  readonly requestAfterChange: Effect.Effect<void, unknown>;
  readonly requestInitial?: Effect.Effect<void, unknown>;
  /** @internal Supplied by the production watcher; custom test watches may omit it. */
  readonly watchIgnorePolicy?: Effect.Effect<CodeGraphWatchIgnorePolicy, unknown>;
}

export interface CodeGraphWatchIgnorePolicy {
  readonly accepts: (repositoryPath: string) => Effect.Effect<boolean, unknown>;
  readonly reload: Effect.Effect<void, unknown>;
}

export interface CodeGraphAutomaticRecoveryIdentity extends Partial<RepositoryIdentity> {
  readonly checkoutId: string;
  readonly worktreeId: string;
}

export interface CodeGraphAutomaticRecoveryDependencies {
  readonly coordinator: CodeGraphAutomaticRecoveryCoordinatorShape;
  readonly resolveIdentity: (cwd: string) => Effect.Effect<CodeGraphAutomaticRecoveryIdentity, unknown>;
  readonly routineMaintenance: (
    options: CodeGraphWatchOptions,
    identity: CodeGraphAutomaticRecoveryIdentity,
  ) => Effect.Effect<CodeGraphRoutineMaintenanceResult, unknown>;
}

interface ActiveRefresh {
  readonly backgroundPendingOptions?: CodeGraphWatchOptions;
  /** Durable claimed work is never replaceable by ordinary coalescing. */
  readonly preparedPendingOptions?: CodeGraphWatchOptions;
  readonly completion: Deferred.Deferred<void, Error>;
  readonly currentAdmissionClass?: CodeGraphBuilderAdmissionClass;
  readonly latestOptions: CodeGraphWatchOptions;
  readonly pending: boolean;
  readonly wake: Deferred.Deferred<void>;
}

interface ActiveWatch {
  readonly cancel: Effect.Effect<void>;
  readonly generation: object;
  readonly lastUsedAt: number;
}

interface RefreshDecision {
  readonly completion: Deferred.Deferred<void, Error>;
  readonly start: boolean;
  readonly wake?: Deferred.Deferred<void>;
}

interface WatchStartDecision {
  readonly evicted: readonly [string, ActiveWatch][];
  readonly start: boolean;
}

interface ProgressTracker {
  buildId: string;
  etaTracker: CodeGraphEtaTracker;
  estimatedPhaseRemainingMilliseconds?: number;
  estimateConfidence?: CodeGraphProgressTiming['estimateConfidence'];
  phase?: CodeGraphProgress['phase'];
  phaseStartedAtMilliseconds: number;
  startedAtMilliseconds: number;
  updatedAtMilliseconds: number;
}

interface RefreshExecutionMetrics {
  readonly executing: number;
  readonly highWater: number;
}

class CodeGraphWatcherError extends Schema.TaggedError<CodeGraphWatcherError>()('CodeGraphWatcherError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export class CodeGraphRefreshRetryDeferred extends Schema.TaggedError<CodeGraphRefreshRetryDeferred>()(
  'CodeGraphRefreshRetryDeferred',
  {notBefore: Schema.Finite},
) {}

const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 30 * 60_000;
const DEFAULT_MAXIMUM_WATCHERS = 32;
const DEFAULT_SWEEP_INTERVAL_MILLISECONDS = 60_000;
const CODE_GRAPH_REFRESH_OPERATION = 'refresh code graph' as const;
const CODE_GRAPH_REFRESH_FAILURE_METADATA = {
  busy: {recovery: 'defer', retryable: true},
  'confirmed-corruption': {recovery: 'manual-rebuild', retryable: false},
  'incompatible-schema': {recovery: 'manual-migration', retryable: false},
  'no-space': {recovery: 'free-space', retryable: false},
  permission: {recovery: 'fix-permissions', retryable: false},
  'schema-additive': {recovery: 'migrate-additive', retryable: false},
  'transient-io': {recovery: 'retry-read-only', retryable: true},
  unknown: {recovery: 'diagnose', retryable: false},
} as const satisfies Record<CodeGraphStoreFailureCode, Pick<CodeGraphRefreshFailure, 'recovery' | 'retryable'>>;

/** Convert native/store failures into a bounded record that cannot retain paths or raw causes. */
export function codeGraphRefreshFailure(cause: unknown): CodeGraphRefreshFailure {
  const classified = classifyCodeGraphStoreFailure(CODE_GRAPH_REFRESH_OPERATION, cause);
  const code = Object.hasOwn(CODE_GRAPH_REFRESH_FAILURE_METADATA, classified.code) ? classified.code : 'unknown';
  const defaults = CODE_GRAPH_REFRESH_FAILURE_METADATA[code];
  const reconnectRequired = Schema.is(CodeGraphRuntimeReconnectRequiredError)(classified);
  const capacityFailure =
    Schema.is(CodeGraphDiskCapacityPressureError)(classified) ||
    Schema.is(CodeGraphDiskCapacityObservationError)(classified);
  return {
    code,
    ...(capacityFailure && classified.evidence !== undefined ? {evidence: classified.evidence} : {}),
    operation: CODE_GRAPH_REFRESH_OPERATION,
    recovery: reconnectRequired || capacityFailure ? classified.recovery : defaults.recovery,
    retryable: reconnectRequired || capacityFailure ? classified.retryable : defaults.retryable,
  };
}

function codeGraphRefreshFailureFromCause(cause: Cause.Cause<unknown>): CodeGraphRefreshFailure {
  return codeGraphRefreshFailure(Option.getOrUndefined(Cause.findErrorOption(cause)));
}

interface CodeGraphBackgroundDemandDriverTarget {
  readonly requestKey: string;
}

interface CodeGraphBackgroundDemandDriverSummary {
  readonly edges: number;
  readonly symbols: number;
}

type CodeGraphBackgroundDemandDriverOutcome =
  | {readonly notBefore: number; readonly type: 'deferred'}
  | {readonly type: 'idle'}
  | {readonly state: CodeGraphRefreshDemandState; readonly type: 'completed'}
  | {readonly state: CodeGraphRefreshDemandState; readonly type: 'superseded'}
  | {
      readonly cause: unknown;
      readonly failure: CodeGraphRefreshFailure;
      readonly state: CodeGraphRefreshDemandState;
      readonly type: 'failed';
    };

/**
 * Drives one durable latest-target lane. Registration and publication state
 * transitions stay uninterruptible, while the build itself remains
 * interruptible and releases its claim into the bounded retry schedule.
 *
 * @internal exported for deterministic production-driver tests.
 */
export function driveCodeGraphBackgroundDemand<Target extends CodeGraphBackgroundDemandDriverTarget>(input: {
  readonly complete: (target: Target, token: string) => Effect.Effect<CodeGraphRefreshDemandState, unknown, never>;
  readonly defer: (target: Target, token: string) => Effect.Effect<CodeGraphRefreshDemandState, unknown, never>;
  readonly fail: (target: Target, token: string) => Effect.Effect<CodeGraphRefreshDemandState, unknown, never>;
  readonly isSuperseded: (cause: unknown) => boolean;
  readonly observe: Effect.Effect<Target, unknown, never>;
  readonly onRefreshed: (summary: CodeGraphBackgroundDemandDriverSummary) => Effect.Effect<void, unknown, never>;
  /** @internal A durable claim paired with its exact preflight observation. */
  readonly prepared?: {readonly registration: CodeGraphRefreshDemandRegistration; readonly target: Target};
  readonly recover: (target: Target) => Effect.Effect<void, unknown, never>;
  readonly register: (target: Target) => Effect.Effect<CodeGraphRefreshDemandRegistration, unknown, never>;
  readonly run: (
    target: Target,
    token: string,
  ) => Effect.Effect<CodeGraphBackgroundDemandDriverSummary, unknown, never>;
}): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    let prepared = input.prepared;
    for (;;) {
      const target = prepared?.target ?? (yield* input.observe);
      const preparedRegistration = prepared?.registration;
      yield* input.recover(target);
      const outcome = yield* Effect.uninterruptibleMask(restore =>
        (preparedRegistration === undefined ? input.register(target) : Effect.succeed(preparedRegistration)).pipe(
          Effect.flatMap((demand): Effect.Effect<CodeGraphBackgroundDemandDriverOutcome, unknown, never> => {
            prepared = undefined;
            // Only the process that created the claim drives it. Attachments,
            // queued targets and delayed retries remain owned by their durable claim.
            if (demand.type === 'deferred') {
              return Effect.succeed({
                notBefore: demand.target.retry?.notBefore ?? 0,
                type: 'deferred' as const,
              });
            }

            if (demand.type !== 'claimed') return Effect.succeed({type: 'idle' as const});
            const token = demand.target.targetToken;
            const releaseInterruptedClaim = input.defer(target, token).pipe(Effect.asVoid);
            return restore(input.run(target, token)).pipe(
              Effect.map(summary => ({summary, type: 'completed' as const})),
              Effect.catchIf(input.isSuperseded, () =>
                input.fail(target, token).pipe(Effect.map(state => ({state, type: 'superseded' as const}))),
              ),
              Effect.catch(cause => {
                const failure = codeGraphRefreshFailure(cause);
                const transition = failure.retryable ? input.defer(target, token) : input.fail(target, token);
                return transition.pipe(Effect.map(state => ({cause, failure, state, type: 'failed' as const})));
              }),
              Effect.onInterrupt(() => releaseInterruptedClaim),
              Effect.filterOrElse(
                result => result.type !== 'completed',
                result => {
                  const completed = result as {
                    readonly summary: CodeGraphBackgroundDemandDriverSummary;
                    readonly type: 'completed';
                  };
                  return input.complete(target, token).pipe(
                    Effect.flatMap(state =>
                      restore(input.onRefreshed(completed.summary)).pipe(
                        Effect.catchCause(() =>
                          Effect.logWarning('Code graph refresh callback failed after durable publication completed.'),
                        ),
                        Effect.as({state, type: 'completed' as const}),
                      ),
                    ),
                  );
                },
              ),
            );
          }),
        ),
      );
      if (outcome.type === 'idle') return;
      if (outcome.type === 'deferred') {
        return yield* CodeGraphRefreshRetryDeferred.make({notBefore: outcome.notBefore});
      }
      if (outcome.type === 'superseded') continue;
      if (outcome.type === 'completed') {
        if (outcome.state.desired === undefined) return;
        continue;
      }
      const desired = outcome.state.desired;
      if (desired !== undefined && desired.targetKey !== target.requestKey) continue;
      if (desired?.retry !== undefined) {
        return yield* CodeGraphRefreshRetryDeferred.make({notBefore: desired.retry.notBefore});
      }
      return yield* Effect.fail(outcome.cause);
    }
  });
}

/** @internal exported for watcher refresh reuse tests. */
export function currentBackgroundRefreshSummary(
  target: CodeGraphBackgroundTarget,
  store: CodeGraphStoreShape,
  languagePacks: CodeGraphLanguagePackRegistryShape,
) {
  return Effect.gen(function* () {
    const ready = yield* store.readySnapshot(target.layout.databasePath, target.identity.worktreeId, target.scopeId);
    if (ready === undefined || codeGraphWatcherSnapshotStale(ready, target.identity, target.overlay)) return undefined;
    const provenance = yield* store.snapshotPackProvenance(target.layout.databasePath, ready.id);
    if (!codeGraphSnapshotMatchesCurrentLanguagePacks(ready, provenance, languagePacks)) return undefined;
    if (
      !(yield* codeGraphSnapshotAdmissionCurrent(
        target.layout,
        ready,
        target.admissionFingerprint,
        languagePacks,
        false,
        target.scopeEvidence === undefined ? undefined : codeGraphScopeAdmissionEvidence(target.scopeEvidence),
      ))
    ) {
      return undefined;
    }
    return {edges: ready.edgeCount, symbols: ready.symbolCount};
  });
}

export function codeGraphRefreshRequestReceipt(
  registration: CodeGraphRefreshDemandRegistration,
  continuity: CodeGraphRefreshContinuity,
): CodeGraphRefreshRequestReceipt {
  const requestState =
    registration.type === 'claimed' ? 'started' : registration.type === 'attached' ? 'attached' : registration.type;
  return {
    requestState,
    refresh: {
      ...continuity,
      // The receipt describes this request even when a newer desired target is
      // already visible in the sidecar.
      queueToken: registration.target.targetToken,
      ...(registration.type === 'claimed' ? {currentTargetToken: registration.target.targetToken} : {}),
    },
  };
}

/** @internal Keep an already-persisted claim live until local scheduling owns it. */
export const handoffCodeGraphPreparedDemand = Effect.fn('codeGraph.handoffPreparedDemand')(function* <E, R>(input: {
  readonly defer: Effect.Effect<unknown, unknown, R>;
  readonly receipt: CodeGraphRefreshRequestReceipt;
  readonly schedule: Effect.Effect<unknown, E, R>;
}) {
  return yield* Effect.uninterruptibleMask(() =>
    input.schedule.pipe(
      Effect.as(input.receipt),
      Effect.onError(() => input.defer.pipe(Effect.ignore)),
    ),
  );
});
export const makeCodeGraphResumeScheduler = Effect.fn('codeGraph.makeResumeScheduler')(function* (
  resume: (options: CodeGraphWatchOptions) => Effect.Effect<unknown, unknown>,
  onFailure: (failure: CodeGraphRefreshFailure) => Effect.Effect<void> = () => Effect.void,
  beforeFork?: Effect.Effect<void>,
) {
  return yield* makeKeyedBackgroundScheduler({
    ...(beforeFork === undefined ? {} : {beforeFork}),
    key: options => withCodeGraphWatcherScopeKey(options).key,
    onFailure: cause => onFailure(codeGraphRefreshFailureFromCause(cause)),
    run: resume,
  });
});
export class CodeGraphWatcher extends Context.Service<CodeGraphWatcher, CodeGraphWatcherShape>()(
  '@threadnote/graph/watcher/CodeGraphWatcher',
) {
  static readonly layer = Layer.effect(
    CodeGraphWatcher,
    Effect.gen(function* () {
      const observability = yield* CodeGraphObservability;
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const path = yield* Path.Path;
      const commandExecutor = yield* CommandExecutor;
      const systemInfo = yield* SystemInfo;
      const indexer = yield* CodeGraphIndexer;
      const languagePacks = yield* CodeGraphLanguagePackRegistry;
      const maintenance = yield* CodeGraphMaintenanceCoordinator;
      const store = yield* CodeGraphStore;
      const scope = yield* Effect.scope;
      const automaticRecovery = yield* makeCodeGraphAutomaticRecoveryCoordinator();
      const anonymousTelemetryComponent = codeGraphAnonymousTelemetryComponent(systemInfo.environment());
      const prewarmSemaphore = yield* Semaphore.make(1);
      const prewarmedCommits = yield* SynchronizedRef.make(new Set<string>());
      // MCP stdio must not own multi-hour index-repository work; spawn CLI graph index instead.
      // Prewarm stays in-process only for CLI watchers — MCP skips it so the stdio process
      // does not take the repository lock for secondary ensureCommit work.
      const isolateBuilder = isCodeGraphIsolatedBuilderHost(systemInfo);
      const schedulePrewarm = (options: CodeGraphWatchOptions) =>
        systemInfo.environment().THREADNOTE_CODE_GRAPH_PREWARM === '0'
          ? Effect.void
          : prewarmLikelyCleanSnapshots({
              commandExecutor,
              indexer,
              options,
              path,
              prewarmedCommits,
              prewarmSemaphore,
              store,
            }).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, systemInfo),
              Effect.forkIn(scope),
              Effect.asVoid,
            );
      const observeTarget = (options: CodeGraphWatchOptions) =>
        Effect.gen(function* () {
          const identity = yield* resolveRepositoryIdentity(options.cwd).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, systemInfo),
          );
          const scopedObservation =
            options.project?.graph === undefined
              ? undefined
              : yield* inventoryRepository(identity, {
                  includeOverlay: false,
                  languagePacks,
                  project: options.project,
                  scopeObservationOnly: true,
                }).pipe(
                  Effect.provideService(CommandExecutor, commandExecutor),
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, systemInfo),
                );
          const scope = scopedObservation?.scope;
          const overlay = yield* worktreeBuildRequestState(identity, options.threadnoteHome, scope).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, systemInfo),
          );
          const admission = yield* observeCodeGraphAdmissionEnvironment(identity).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, systemInfo),
          );
          const scopeEvidence =
            scopedObservation === undefined
              ? undefined
              : codeGraphInventoryScopeEvidence(
                  scopedObservation,
                  identity,
                  extractorSetIdentity(scopedObservation.files, languagePacks),
                  admission,
                );
          return {
            admissionFingerprint: admission,
            demandIdentity: {
              checkoutId: identity.checkoutId,
              ...(scope === undefined ? {} : {scopeId: scope.scopeKey}),
              threadnoteHome: options.threadnoteHome,
              worktreeId: identity.worktreeId,
            },
            identity,
            layout: codeGraphLayout(
              path,
              options.threadnoteHome,
              identity.checkoutId,
              identity.worktreeId,
              scope?.scopeKey,
            ),
            overlay,
            requestKey: codeGraphBuildRequestKey(identity, overlay, languagePacks, undefined, false, admission, scope),
            ...(scopeEvidence === undefined ? {} : {scopeEvidence}),
            ...(scope === undefined ? {} : {scopeId: scope.scopeKey}),
          };
        });
      const provideDemandServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, systemInfo),
        );
      const prepareRefresh: CodeGraphPrepareRefreshRun = options =>
        options.admissionClass !== 'background'
          ? Effect.succeed(options)
          : options.refreshDemandPrepared !== undefined
            ? Effect.succeed(options)
            : observeTarget(options).pipe(
                Effect.flatMap(target =>
                  provideDemandServices(enqueueCodeGraphBackgroundDemand(target.demandIdentity, target.requestKey)),
                ),
                Effect.catchCause(() =>
                  Effect.logWarning(
                    'Code graph background refresh intent could not be durably queued (unknown; recovery: retry).',
                  ),
                ),
                Effect.as(options),
              );
      const runBackgroundBuild = (options: CodeGraphWatchOptions, target: CodeGraphBackgroundTarget, token: string) =>
        currentBackgroundRefreshSummary(target, store, languagePacks).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.flatMap(current =>
            current !== undefined
              ? Effect.succeed(current)
              : isolateBuilder
                ? runIsolatedCodeGraphIndex({
                    admissionClass: 'background',
                    assertRuntimeSchemaCompatible: databasePath => store.assertRuntimeSchemaCompatible(databasePath),
                    cwd: options.cwd,
                    onProgress: options.onProgress,
                    ...(options.project === undefined ? {} : {project: options.project}),
                    refreshDemandToken: token,
                    requestKey: target.requestKey,
                    ...(target.scopeId === undefined ? {} : {scopeId: target.scopeId}),
                    threadnoteHome: options.threadnoteHome,
                  }).pipe(
                    Effect.provideService(CommandExecutor, commandExecutor),
                    Effect.provideService(Crypto.Crypto, crypto),
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.provideService(Path.Path, path),
                    Effect.provideService(SystemInfo, systemInfo),
                    Effect.map(summary => ({edges: summary.edges, symbols: summary.symbols})),
                  )
                : indexer
                    .index(
                      codeGraphWatcherRefreshIndexRequest({
                        ...options,
                        admissionClass: 'background',
                        refreshDemandToken: token,
                      }),
                    )
                    .pipe(
                      Effect.map(summary => ({
                        edges: summary.snapshot.edgeCount,
                        symbols: summary.snapshot.symbolCount,
                      })),
                    ),
          ),
        );
      const driveBackgroundDemand = (options: CodeGraphWatchOptions): Effect.Effect<void, unknown> =>
        driveCodeGraphBackgroundDemand({
          complete: (target, token) =>
            provideDemandServices(completeCodeGraphBackgroundDemand(target.demandIdentity, token, target.requestKey)),
          defer: (target, token) =>
            provideDemandServices(deferCodeGraphBackgroundDemand(target.demandIdentity, token, target.requestKey)),
          fail: (target, token) =>
            provideDemandServices(failCodeGraphBackgroundDemand(target.demandIdentity, token, target.requestKey)),
          isSuperseded: Schema.is(CodeGraphRefreshDemandSuperseded),
          observe: observeTarget(options),
          onRefreshed: summary => options.onRefreshed?.(summary.symbols, summary.edges) ?? Effect.void,
          recover: target =>
            Effect.gen(function* () {
              const build = yield* currentCodeGraphBuildStatus(target.layout, target.identity.worktreeId).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, systemInfo),
              );
              const spawnOwner = Option.getOrUndefined(
                yield* readExclusiveFileLockOwner(
                  fs,
                  codeGraphWorktreeSpawnLockPath(
                    path,
                    options.threadnoteHome,
                    target.identity.checkoutId,
                    target.identity.worktreeId,
                    target.scopeId,
                  ),
                ),
              );
              yield* provideDemandServices(
                recoverCodeGraphBackgroundDemand(target.demandIdentity, {
                  liveness: build?.observation.liveness === 'active' ? 'active' : 'inactive',
                  ...(build?.owner === undefined ? {} : {owner: build.owner}),
                  ...(build?.request?.key === undefined ? {} : {requestKey: build.request.key}),
                  ...(spawnOwner === undefined ? {} : {spawnOwner}),
                }),
              ).pipe(Effect.asVoid);
            }),
          prepared: options.refreshDemandPrepared,
          register: target =>
            provideDemandServices(registerCodeGraphBackgroundDemand(target.demandIdentity, target.requestKey)),
          run: (target, token) => runBackgroundBuild(options, target, token),
        });
      const refresh: CodeGraphRefreshRun = (options: CodeGraphWatchOptions) =>
        options.admissionClass === 'background'
          ? driveBackgroundDemand(options).pipe(Effect.andThen(isolateBuilder ? Effect.void : schedulePrewarm(options)))
          : isolateBuilder
            ? observeTarget(options).pipe(
                Effect.flatMap(target =>
                  runIsolatedCodeGraphIndex({
                    admissionClass: options.admissionClass,
                    assertRuntimeSchemaCompatible: databasePath => store.assertRuntimeSchemaCompatible(databasePath),
                    cwd: options.cwd,
                    onProgress: options.onProgress,
                    ...(options.project === undefined ? {} : {project: options.project}),
                    requestKey: target.requestKey,
                    ...(target.scopeId === undefined ? {} : {scopeId: target.scopeId}),
                    threadnoteHome: options.threadnoteHome,
                  }),
                ),
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, systemInfo),
                Effect.tap(summary => options.onRefreshed?.(summary.symbols, summary.edges) ?? Effect.void),
                Effect.asVoid,
              )
            : indexRepository(indexer, options).pipe(Effect.andThen(schedulePrewarm(options)));
      const resolveRecoveryIdentity = (cwd: string) =>
        resolveRepositoryIdentity(cwd).pipe(
          Effect.provideService(CommandExecutor, commandExecutor),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, systemInfo),
        );
      const requestWatchMaintenance = (options: CodeGraphWatchOptions) =>
        observeTarget(options).pipe(
          Effect.flatMap(target =>
            maintenance.request({
              allowIndexPreparation: true,
              anchorIdentity: target.identity,
              ...(target.scopeId === undefined ? {} : {anchorScopeId: target.scopeId}),
              checkoutId: target.layout.checkoutId,
              databasePath: target.layout.databasePath,
              threadnoteHome: options.threadnoteHome,
              writerLockPath: target.layout.databaseWriteLockPath,
            }),
          ),
        );
      const watchReconciliationHooks = (options: CodeGraphWatchOptions): CodeGraphWatchReconciliationHooks => ({
        watchIgnorePolicy: resolveRecoveryIdentity(options.cwd).pipe(
          Effect.flatMap(identity =>
            makeCodeGraphWatchIgnorePolicy(fs, path, identity.repoRoot, options.cwd).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(SystemInfo, systemInfo),
            ),
          ),
        ),
        changeRefreshRequired: Effect.gen(function* () {
          const target = yield* observeTarget(options);
          const ready = yield* store.readySnapshot(
            target.layout.databasePath,
            target.identity.worktreeId,
            target.scopeId,
          );
          if (ready === undefined) return true;
          const statuses = yield* readCodeGraphBuildStatuses(target.layout);
          return codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh(ready.id, statuses);
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, systemInfo),
        ),
        periodicRefreshRequired: Effect.gen(function* () {
          const target = yield* observeTarget(options);
          yield* requestWatchMaintenance(options);
          const ready = yield* store.readySnapshot(
            target.layout.databasePath,
            target.identity.worktreeId,
            target.scopeId,
          );
          if (ready === undefined) return true;
          const statuses = yield* readCodeGraphBuildStatuses(target.layout);
          if (!codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh(ready.id, statuses)) return false;
          return codeGraphWatcherSnapshotStale(ready, target.identity, target.overlay);
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, systemInfo),
        ),
        requestAfterChange: requestWatchMaintenance(options),
      });
      const run = (
        options: CodeGraphWatchOptions,
        initialRefresh: boolean,
        requestRefresh: () => Effect.Effect<void>,
      ) => watchRepository(fs, path, options, initialRefresh, requestRefresh, watchReconciliationHooks(options));
      const recover = (options: CodeGraphWatchOptions, failure: CodeGraphRefreshFailure) =>
        requestCodeGraphAutomaticRecovery(
          {
            coordinator: automaticRecovery,
            resolveIdentity: resolveRecoveryIdentity,
            routineMaintenance: (recoveryOptions, identity) =>
              observeTarget(recoveryOptions).pipe(
                Effect.flatMap(target =>
                  runCodeGraphLifecycleOpportunity({
                    maintenance,
                    opportunity: 'critical-error',
                    targets: [
                      {
                        // This production dependency is wired directly to
                        // resolveRepositoryIdentity above; test seams may retain
                        // the intentionally smaller recovery identity shape.
                        anchorIdentity: identity as RepositoryIdentity,
                        ...(target.scopeId === undefined ? {} : {anchorScopeId: target.scopeId}),
                        checkoutId: target.layout.checkoutId,
                        databasePath: target.layout.databasePath,
                      },
                    ],
                    threadnoteHome: recoveryOptions.threadnoteHome,
                  }),
                ),
                Effect.map(result =>
                  result.state === 'completed'
                    ? result.result
                    : ({reason: 'schema-unavailable', state: 'skipped'} as const),
                ),
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, systemInfo),
              ),
          },
          options,
          failure,
        ).pipe(Effect.asVoid);
      const watcher = yield* makeCodeGraphWatcher(
        run,
        refresh,
        {
          onRefreshFailure: failure =>
            observability.backgroundFailure(anonymousTelemetryComponent, {operation: 'graph-refresh', failure}),
        },
        recover,
        prepareRefresh,
      );
      const requestBackgroundDemand = (options: CodeGraphWatchOptions) =>
        Effect.gen(function* () {
          const target = yield* observeTarget({...options, admissionClass: 'background'});
          // Reconcile only the durable scheduling hint against the existing
          // build-status and spawn-lock liveness authorities before claim.
          const build = yield* currentCodeGraphBuildStatus(target.layout, target.identity.worktreeId).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, systemInfo),
          );
          const spawnOwner = Option.getOrUndefined(
            yield* readExclusiveFileLockOwner(
              fs,
              codeGraphWorktreeSpawnLockPath(
                path,
                options.threadnoteHome,
                target.identity.checkoutId,
                target.identity.worktreeId,
                target.scopeId,
              ),
            ),
          );
          const observed = {
            liveness: build?.observation.liveness === 'active' ? ('active' as const) : ('inactive' as const),
            ...(build?.owner === undefined ? {} : {owner: build.owner}),
            ...(build?.request?.key === undefined ? {} : {requestKey: build.request.key}),
            ...(spawnOwner === undefined ? {} : {spawnOwner}),
          };
          yield* provideDemandServices(recoverCodeGraphBackgroundDemand(target.demandIdentity, observed));
          return yield* Effect.uninterruptibleMask(() =>
            Effect.gen(function* () {
              const registration = yield* provideDemandServices(
                registerCodeGraphBackgroundDemand(target.demandIdentity, target.requestKey),
              );
              const continuity = codeGraphRefreshDemandContinuity(registration.state, yield* Clock.currentTimeMillis);
              const receipt = codeGraphRefreshRequestReceipt(registration, continuity);
              // Attachments and queued/deferred targets already have a durable
              // owner; starting another local driver would duplicate work.
              if (registration.type !== 'claimed') return receipt;
              const prepared = {registration, target} satisfies CodeGraphPreparedRefreshDemand;
              return yield* handoffCodeGraphPreparedDemand({
                // A failed handoff releases the exact persisted claim into
                // the retry lane; later work cannot pair its token to a new
                // observation.
                defer: provideDemandServices(
                  deferCodeGraphBackgroundDemand(
                    target.demandIdentity,
                    registration.target.targetToken,
                    target.requestKey,
                  ),
                ),
                receipt,
                schedule: watcher.refresh({
                  ...options,
                  admissionClass: 'background',
                  refreshDemandPrepared: prepared,
                }),
              });
            }),
          );
        });
      const resumeBackgroundDemand = (options: CodeGraphWatchOptions) =>
        Effect.gen(function* () {
          const target = yield* observeTarget({...options, admissionClass: 'background'});
          const build = yield* currentCodeGraphBuildStatus(target.layout, target.identity.worktreeId).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, systemInfo),
          );
          const spawnOwner = Option.getOrUndefined(
            yield* readExclusiveFileLockOwner(
              fs,
              codeGraphWorktreeSpawnLockPath(
                path,
                options.threadnoteHome,
                target.identity.checkoutId,
                target.identity.worktreeId,
                target.scopeId,
              ),
            ),
          );
          return yield* Effect.uninterruptibleMask(() =>
            Effect.gen(function* () {
              const registration = yield* provideDemandServices(
                resumeCodeGraphBackgroundDemand(target.demandIdentity, target.requestKey, {
                  liveness: build?.observation.liveness === 'active' ? 'active' : 'inactive',
                  ...(build?.owner === undefined ? {} : {owner: build.owner}),
                  ...(build?.request?.key === undefined ? {} : {requestKey: build.request.key}),
                  ...(spawnOwner === undefined ? {} : {spawnOwner}),
                }),
              );
              if (registration === undefined) return undefined;
              const continuity = codeGraphRefreshDemandContinuity(registration.state, yield* Clock.currentTimeMillis);
              const receipt = codeGraphRefreshRequestReceipt(registration, continuity);
              if (registration.type !== 'claimed') return receipt.refresh;
              const prepared = {registration, target} satisfies CodeGraphPreparedRefreshDemand;
              return (yield* handoffCodeGraphPreparedDemand({
                defer: provideDemandServices(
                  deferCodeGraphBackgroundDemand(
                    target.demandIdentity,
                    registration.target.targetToken,
                    target.requestKey,
                  ),
                ),
                receipt,
                schedule: watcher.refresh({
                  ...options,
                  admissionClass: 'background',
                  refreshDemandPrepared: prepared,
                }),
              })).refresh;
            }),
          );
        });
      const reportBackgroundFailure = (failure: CodeGraphRefreshFailure) =>
        observability.backgroundFailure(anonymousTelemetryComponent, {operation: 'graph-refresh', failure});
      const scheduleResume = yield* makeCodeGraphResumeScheduler(resumeBackgroundDemand, reportBackgroundFailure);
      const scheduleRequest = yield* makeCodeGraphResumeScheduler(requestBackgroundDemand, reportBackgroundFailure);
      return CodeGraphWatcher.of({
        ...watcher,
        cachedStatus: (key, target) => watcher.cachedStatus(key, target),
        request: requestBackgroundDemand,
        scheduleRequest,
        resume: resumeBackgroundDemand,
        scheduleResume,
        status: (key, target) =>
          watcher.cachedStatus(key, target).pipe(
            Effect.filterOrElse(
              current => Option.isSome(current) || target === undefined,
              () =>
                Effect.gen(function* () {
                  if (target === undefined) return Option.none();
                  const observed = yield* observeTarget({...target, key});
                  const persisted = yield* currentCodeGraphBuildStatus(observed.layout, observed.identity.worktreeId);
                  return persisted ? Option.some(persistedRefreshStatus(persisted)) : Option.none();
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(CommandExecutor, commandExecutor),
                  Effect.provideService(SystemInfo, systemInfo),
                ),
            ),
            Effect.flatMap(current =>
              Effect.suspend(() => {
                if (target === undefined) return Effect.succeed(current);
                return observeTarget({...target, key}).pipe(
                  Effect.flatMap(observed =>
                    provideDemandServices(
                      observeCodeGraphBackgroundDemand({
                        checkoutId: observed.identity.checkoutId,
                        ...(observed.scopeId === undefined ? {} : {scopeId: observed.scopeId}),
                        threadnoteHome: target.threadnoteHome,
                        worktreeId: observed.identity.worktreeId,
                      }),
                    ).pipe(
                      Effect.map(refresh =>
                        Option.map(current, status => (refresh.state === 'idle' ? status : {...status, refresh})),
                      ),
                      // Observation is a sidecar overlay, never a reason to
                      // discard an otherwise usable local/persisted status.
                      Effect.orElseSucceed(() => current),
                    ),
                  ),
                );
              }),
            ),
          ),
      });
    }),
  );
}

export const makeCodeGraphWatcher = Effect.fn('codeGraph.makeWatcher')(function* (
  run: CodeGraphWatchRun,
  refreshRun: CodeGraphRefreshRun,
  lifecycleOptions: CodeGraphWatcherLifecycleOptions = {},
  recoverRun: CodeGraphRecoveryRun = () => Effect.void,
  prepareRefresh: CodeGraphPrepareRefreshRun = options => Effect.succeed(options),
) {
  const scope = yield* Effect.scope;
  const idleTimeoutMilliseconds = positiveInteger(
    lifecycleOptions.idleTimeoutMilliseconds,
    DEFAULT_IDLE_TIMEOUT_MILLISECONDS,
  );
  const maximumWatchers = positiveInteger(lifecycleOptions.maximumWatchers, DEFAULT_MAXIMUM_WATCHERS);
  const onRefreshFailure = lifecycleOptions.onRefreshFailure;
  const sweepIntervalMilliseconds = positiveInteger(
    lifecycleOptions.sweepIntervalMilliseconds,
    DEFAULT_SWEEP_INTERVAL_MILLISECONDS,
  );
  const activeWatches = yield* SynchronizedRef.make(new Map<string, ActiveWatch>());
  const activeRefreshes = yield* SynchronizedRef.make(new Map<string, ActiveRefresh>());
  const refreshStatuses = yield* SynchronizedRef.make(new Map<string, CodeGraphRefreshStatus>());
  const refreshSemaphore = yield* Semaphore.make(2);
  const refreshExecutionMetrics = yield* Ref.make<RefreshExecutionMetrics>({executing: 0, highWater: 0});
  const refreshSequence = yield* Ref.make(0);
  const sweepStarted = yield* Ref.make(false);
  const setStatus = (key: string, status: CodeGraphRefreshStatus) =>
    SynchronizedRef.update(refreshStatuses, current => new Map(current).set(key, status));
  const removeStatuses = (keys: readonly string[]) =>
    keys.length === 0
      ? Effect.void
      : SynchronizedRef.update(refreshStatuses, current => {
          const next = new Map(current);
          for (const key of keys) next.delete(key);
          return next;
        });
  const trackedRefreshOptions = (options: CodeGraphWatchOptions, tracker: ProgressTracker): CodeGraphWatchOptions => ({
    ...options,
    onProgress: progress =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        observeProgress(tracker, progress, now);
        yield* setStatus(options.key, {
          progress,
          state: 'indexing',
          timing: progressTiming(tracker, now),
        });
        yield* options.onProgress?.(progress) ?? Effect.void;
      }),
    onRefreshed: (symbols, edges) =>
      setStatus(options.key, {edges, state: 'ready', symbols}).pipe(
        Effect.andThen(options.onRefreshed?.(symbols, edges) ?? Effect.void),
      ),
  });
  const removeWatch = (key: string, generation: object) =>
    SynchronizedRef.modify(activeWatches, current => {
      if (current.get(key)?.generation !== generation) return [false, current] as const;
      const next = new Map(current);
      next.delete(key);
      return [true, next] as const;
    }).pipe(Effect.flatMap(removed => (removed ? removeStatuses([key]) : Effect.void)));
  const touchWatch = (key: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* SynchronizedRef.update(activeWatches, current => {
        const existing = current.get(key);
        if (!existing) return current;
        const next = new Map(current);
        next.set(key, {...existing, lastUsedAt: now});
        return next;
      });
    });
  const runRefreshLoop = (
    key: string,
    completion: Deferred.Deferred<void, Error>,
    initialOptions: CodeGraphWatchOptions,
  ) =>
    Effect.gen(function* () {
      let options = initialOptions;
      let lastFailure: Error | undefined;
      for (;;) {
        const activeBeforeRun = (yield* SynchronizedRef.get(activeRefreshes)).get(key);
        const retryWake = activeBeforeRun?.wake;
        const startedAtMilliseconds = yield* Clock.currentTimeMillis;
        const sequence = yield* Ref.updateAndGet(refreshSequence, value => value + 1);
        const tracker = makeProgressTracker(startedAtMilliseconds, sequence);
        yield* setStatus(key, {
          state: 'indexing',
          timing: progressTiming(tracker, startedAtMilliseconds),
        });
        lastFailure = undefined;
        let retryNotBefore: number | undefined;
        yield* refreshSemaphore
          .withPermit(
            Effect.uninterruptibleMask(restore =>
              Ref.update(refreshExecutionMetrics, current => {
                const executing = current.executing + 1;
                return {executing, highWater: Math.max(current.highWater, executing)};
              }).pipe(
                Effect.andThen(restore(refreshRun(trackedRefreshOptions(options, tracker)))),
                Effect.ensuring(
                  Ref.update(refreshExecutionMetrics, current => ({
                    ...current,
                    executing: current.executing - 1,
                  })),
                ),
              ),
            ),
          )
          .pipe(
            Effect.catchCause(cause => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
              const error = Option.getOrUndefined(Cause.findErrorOption(cause));
              if (Schema.is(CodeGraphRefreshRetryDeferred)(error)) {
                retryNotBefore = error.notBefore;
                return setStatus(key, {
                  failure: {
                    code: 'busy',
                    operation: CODE_GRAPH_REFRESH_OPERATION,
                    recovery: 'defer',
                    retryable: true,
                  },
                  state: 'deferred',
                });
              }
              const failure = codeGraphRefreshFailureFromCause(cause);
              lastFailure = classifyCodeGraphStoreFailure(
                CODE_GRAPH_REFRESH_OPERATION,
                Option.getOrUndefined(Cause.findErrorOption(cause)),
              );
              return setStatus(key, {failure, state: 'deferred'}).pipe(
                Effect.andThen(
                  onRefreshFailure === undefined
                    ? Effect.void
                    : Effect.suspend(() => onRefreshFailure(failure)).pipe(Effect.ignoreCause),
                ),
                Effect.andThen(
                  Effect.logWarning(
                    `Code graph background refresh deferred (${failure.code}; recovery: ${failure.recovery}).`,
                  ),
                ),
                Effect.andThen(
                  recoverRun(options, failure).pipe(
                    Effect.catchCauseIf(
                      recoveryCause => !Cause.hasInterruptsOnly(recoveryCause),
                      () =>
                        Effect.logWarning(
                          'Code graph automatic recovery scheduling failed (unknown; recovery: diagnose).',
                        ),
                    ),
                    Effect.forkIn(scope),
                    Effect.asVoid,
                  ),
                ),
              );
            }),
          );
        if (retryNotBefore !== undefined) {
          const now = yield* Clock.currentTimeMillis;
          const deadline = Effect.sleep(Math.max(0, retryNotBefore - now));
          yield* retryWake === undefined ? deadline : Effect.raceFirst(deadline, Deferred.await(retryWake));
          const retryOptions = yield* SynchronizedRef.modify(activeRefreshes, current => {
            const active = current.get(key);
            if (!active || active.completion !== completion) return [undefined, current] as const;
            const next = new Map(current);
            next.set(key, {
              ...active,
              currentAdmissionClass: active.latestOptions.admissionClass,
              pending: false,
            });
            return [active.latestOptions, next] as const;
          });
          if (retryOptions === undefined) break;
          options = retryOptions;
          continue;
        }
        const nextOptions = yield* SynchronizedRef.modify(activeRefreshes, current => {
          const active = current.get(key);
          if (!active || active.completion !== completion) return [undefined, current] as const;
          const next = new Map(current);
          if (active.preparedPendingOptions !== undefined) {
            const preparedOptions = active.preparedPendingOptions;
            next.set(key, {
              ...active,
              currentAdmissionClass: 'background',
              latestOptions: active.pending ? active.latestOptions : preparedOptions,
              pending: active.pending,
              preparedPendingOptions: undefined,
            });
            return [preparedOptions, next] as const;
          }
          if (active.backgroundPendingOptions !== undefined) {
            next.set(key, {
              ...active,
              backgroundPendingOptions: undefined,
              currentAdmissionClass: 'background',
              latestOptions: active.backgroundPendingOptions,
              pending: false,
            });
            return [active.backgroundPendingOptions, next] as const;
          }
          if (active.pending) {
            next.set(key, {
              ...active,
              currentAdmissionClass: active.latestOptions.admissionClass,
              pending: false,
            });
            return [active.latestOptions, next] as const;
          }
          next.delete(key);
          return [undefined, next] as const;
        });
        if (!nextOptions) break;
        options = nextOptions;
      }
      if (lastFailure) {
        yield* Deferred.fail(completion, lastFailure);
      } else {
        yield* Deferred.succeed(completion, undefined);
      }
      if (!(yield* SynchronizedRef.get(activeWatches)).has(key)) yield* removeStatuses([key]);
    });
  const scheduleRefresh = (options: CodeGraphWatchOptions, queueTrailing: boolean) =>
    Effect.gen(function* () {
      const preparedOptions = yield* prepareRefresh(options);
      const candidate = yield* Deferred.make<void, Error>();
      const wakeCandidate = yield* Deferred.make<void>();
      const decision = yield* SynchronizedRef.modify(activeRefreshes, current => {
        const active = current.get(preparedOptions.key);
        if (active) {
          const incomingBackground = preparedOptions.admissionClass === 'background';
          const activeHandlesBackground = active.currentAdmissionClass === 'background';
          const claimedDemandNeedsTrailingDriver =
            preparedOptions.refreshDemandPrepared?.registration.type === 'claimed';
          const queueBackgroundAfterCurrent =
            incomingBackground && !activeHandlesBackground && !claimedDemandNeedsTrailingDriver;
          const ordinaryBackgroundAfterPrepared =
            incomingBackground && !claimedDemandNeedsTrailingDriver && active.preparedPendingOptions !== undefined;
          // A durable claim created by request() must get an iteration even
          // while a prior local loop is unwinding after clearing its own claim.
          const decision: RefreshDecision = {
            completion: active.completion,
            start: false,
            ...(incomingBackground ? {wake: active.wake} : {}),
          };
          const next = new Map(current);
          next.set(preparedOptions.key, {
            ...active,
            ...(queueBackgroundAfterCurrent ? {backgroundPendingOptions: preparedOptions} : {}),
            ...(claimedDemandNeedsTrailingDriver ? {preparedPendingOptions: preparedOptions} : {}),
            latestOptions:
              claimedDemandNeedsTrailingDriver || (activeHandlesBackground && !incomingBackground)
                ? active.latestOptions
                : preparedOptions,
            pending: queueTrailing || queueBackgroundAfterCurrent || ordinaryBackgroundAfterPrepared || active.pending,
            wake: incomingBackground ? wakeCandidate : active.wake,
          });
          return [decision, next] as const;
        }
        const next = new Map(current);
        next.set(preparedOptions.key, {
          completion: candidate,
          currentAdmissionClass: preparedOptions.admissionClass,
          latestOptions: preparedOptions,
          pending: false,
          wake: wakeCandidate,
        });
        const decision: RefreshDecision = {completion: candidate, start: true};
        return [decision, next] as const;
      });
      if (decision.wake !== undefined) yield* Deferred.succeed(decision.wake, undefined);
      if (decision.start) {
        yield* runRefreshLoop(preparedOptions.key, decision.completion, preparedOptions).pipe(Effect.forkIn(scope));
      }
      return decision;
    });
  const requestBackgroundRefresh = (options: CodeGraphWatchOptions, queueTrailing: boolean) =>
    scheduleRefresh({...options, admissionClass: 'background'}, queueTrailing).pipe(
      Effect.map(decision => decision.start),
    );
  const requestRefreshAndWait = (options: CodeGraphWatchOptions) =>
    scheduleRefresh(options, false).pipe(Effect.flatMap(decision => Deferred.await(decision.completion)));
  const cancelWatches = (entries: readonly [string, ActiveWatch][]) =>
    Effect.gen(function* () {
      yield* removeStatuses(entries.map(([key]) => key));
      yield* Effect.forEach(entries, ([, entry]) => entry.cancel, {concurrency: 1, discard: true});
    });
  const startSessionWatch = (options: CodeGraphWatchOptions) =>
    Effect.gen(function* () {
      yield* ensureIdleSweep;
      const now = yield* Clock.currentTimeMillis;
      const generation = {};
      const reservation: ActiveWatch = {cancel: Effect.void, generation, lastUsedAt: now};
      const decision = yield* SynchronizedRef.modify(activeWatches, current => {
        const existing = current.get(options.key);
        if (existing) {
          const next = new Map(current);
          next.set(options.key, {...existing, lastUsedAt: now});
          const decision: WatchStartDecision = {evicted: [], start: false};
          return [decision, next] as const;
        }
        const next = new Map(current);
        const evicted: [string, ActiveWatch][] = [];
        while (next.size >= maximumWatchers) {
          const oldest = oldestWatch(next);
          if (!oldest) break;
          next.delete(oldest[0]);
          evicted.push(oldest);
        }
        next.set(options.key, reservation);
        const decision: WatchStartDecision = {evicted, start: true};
        return [decision, next] as const;
      });
      yield* cancelWatches(decision.evicted);
      if (!decision.start) return;
      const fiber = yield* run(options, false, () => requestBackgroundRefresh(options, true).pipe(Effect.asVoid)).pipe(
        Effect.ensuring(removeWatch(options.key, generation)),
        Effect.forkIn(scope),
      );
      const installed = yield* SynchronizedRef.modify(activeWatches, current => {
        const active = current.get(options.key);
        if (active?.generation !== generation) return [false, current] as const;
        const next = new Map(current);
        next.set(options.key, {
          ...active,
          cancel: Fiber.interrupt(fiber).pipe(Effect.asVoid),
        });
        return [true, next] as const;
      });
      if (!installed) yield* Fiber.interrupt(fiber);
    });
  const sweepIdleWatches = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const refreshing = yield* SynchronizedRef.get(activeRefreshes);
    const expired = yield* SynchronizedRef.modify(activeWatches, current => {
      const next = new Map(current);
      const removed: [string, ActiveWatch][] = [];
      for (const entry of current) {
        if (!refreshing.has(entry[0]) && now - entry[1].lastUsedAt >= idleTimeoutMilliseconds) {
          next.delete(entry[0]);
          removed.push(entry);
        }
      }
      return [removed, next] as const;
    });
    yield* cancelWatches(expired);
  });
  const ensureIdleSweep = Ref.getAndSet(sweepStarted, true).pipe(
    Effect.flatMap(started =>
      started
        ? Effect.void
        : Effect.sleep(sweepIntervalMilliseconds).pipe(
            Effect.andThen(sweepIdleWatches),
            Effect.forever,
            Effect.forkIn(scope),
            Effect.asVoid,
          ),
    ),
  );
  const cachedStatus: CodeGraphWatcherShape['cachedStatus'] = (key, target) => {
    const routedKey = target === undefined ? key : withCodeGraphWatcherScopeKey({...target, key}).key;
    return Effect.gen(function* () {
      yield* touchWatch(routedKey);
      const current = (yield* SynchronizedRef.get(refreshStatuses)).get(routedKey);
      if (!current) return Option.none();
      const now = yield* Clock.currentTimeMillis;
      return Option.some(refreshStatusAt(current, now));
    });
  };

  return CodeGraphWatcher.of({
    cachedStatus,
    ensure: options => startSessionWatch(withCodeGraphWatcherScopeKey(options)),
    metrics: Effect.gen(function* () {
      const watches = yield* SynchronizedRef.get(activeWatches);
      const refreshes = yield* SynchronizedRef.get(activeRefreshes);
      const statuses = yield* SynchronizedRef.get(refreshStatuses);
      const execution = yield* Ref.get(refreshExecutionMetrics);
      const idleSweepStarted = yield* Ref.get(sweepStarted);
      let pendingTrailingRefreshes = 0;
      for (const refresh of refreshes.values()) {
        if (refresh.pending) pendingTrailingRefreshes += 1;
      }
      return {
        activeRefreshKeys: refreshes.size,
        activeWatches: watches.size,
        executingRefreshes: execution.executing,
        executingRefreshHighWater: execution.highWater,
        idleSweepFibers: idleSweepStarted ? 1 : 0,
        maximumWatchers,
        pendingTrailingRefreshes,
        retainedStatuses: statuses.size,
      };
    }),
    refresh: options => {
      const routed = withCodeGraphWatcherScopeKey(options);
      return Effect.gen(function* () {
        yield* touchWatch(routed.key);
        return yield* scheduleRefresh(
          {...routed, admissionClass: routed.admissionClass ?? 'current-required'},
          false,
        ).pipe(Effect.map(decision => decision.start));
      });
    },
    request: options => {
      const routed = withCodeGraphWatcherScopeKey(options);
      // Generic/test watchers have no durable sidecar.  Preserve the legacy
      // scheduling contract while exposing the same receipt shape.
      return Effect.gen(function* () {
        const started = yield* scheduleRefresh({...routed, admissionClass: 'background'}, false).pipe(
          Effect.map(decision => decision.start),
        );
        return {
          requestState: started ? ('started' as const) : ('attached' as const),
          refresh: {
            type: 'code-graph-refresh-continuity' as const,
            version: 1 as const,
            state: started ? ('active' as const) : ('queued' as const),
          },
        };
      });
    },
    status: cachedStatus,
    watch: options => {
      const routed = withCodeGraphWatcherScopeKey(options);
      return requestRefreshAndWait({...routed, admissionClass: 'current-required'}).pipe(
        Effect.andThen(run(routed, true, () => requestBackgroundRefresh(routed, true).pipe(Effect.asVoid))),
        Effect.ensuring(removeStatuses([routed.key])),
      );
    },
  });
});

/** Preserve historical keys for full graphs while preventing sibling scoped views from coalescing. */
function withCodeGraphWatcherScopeKey(options: CodeGraphWatchOptions): CodeGraphWatchOptions {
  return options.project?.graph === undefined ? options : {...options, key: `${options.key}\0${options.project.uri}`};
}

/** @internal Keep identity resolution inside the already-detached failure hook. */
export const requestCodeGraphAutomaticRecovery = Effect.fn('codeGraph.requestAutomaticRecovery')(function* (
  dependencies: CodeGraphAutomaticRecoveryDependencies,
  options: CodeGraphWatchOptions,
  failure: CodeGraphRefreshFailure,
) {
  if (failure.code !== 'schema-additive') {
    return yield* dependencies.coordinator.request({failureCode: failure.code, recoveryKey: options.key});
  }
  if (/^[0-9a-f]{64}$/u.test(options.key)) {
    const routineMaintenance = dependencies.resolveIdentity(options.cwd).pipe(
      Effect.flatMap(identity =>
        identity.worktreeId === options.key
          ? dependencies.routineMaintenance(options, identity)
          : Effect.fail(
              CodeGraphWatcherError.make({
                message: 'Code graph recovery identity changed before maintenance admission.',
              }),
            ),
      ),
    );
    return yield* dependencies.coordinator
      .request({failureCode: failure.code, recoveryKey: options.key, routineMaintenance})
      .pipe(Effect.tap(logAutomaticRecoveryAdmission));
  }
  const identity = yield* dependencies.resolveIdentity(options.cwd);
  return yield* dependencies.coordinator
    .request({
      failureCode: failure.code,
      recoveryKey: identity.worktreeId,
      routineMaintenance: dependencies.routineMaintenance(options, identity),
    })
    .pipe(Effect.tap(logAutomaticRecoveryAdmission));
});

function logAutomaticRecoveryAdmission(admission: CodeGraphAutomaticRecoveryAdmission): Effect.Effect<void> {
  return admission.state === 'scheduled'
    ? Effect.logInfo('Code graph automatic recovery maintenance scheduled (schema-additive).')
    : Effect.void;
}

function oldestWatch(watches: ReadonlyMap<string, ActiveWatch>): [string, ActiveWatch] | undefined {
  let oldest: [string, ActiveWatch] | undefined;
  for (const entry of watches) {
    if (!oldest || entry[1].lastUsedAt < oldest[1].lastUsedAt) oldest = entry;
  }
  return oldest;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;
}

function makeProgressTracker(startedAtMilliseconds: number, sequence: number): ProgressTracker {
  return {
    buildId: `${startedAtMilliseconds.toString(36)}-${sequence.toString(36)}`,
    etaTracker: makeCodeGraphEtaTracker(),
    phaseStartedAtMilliseconds: startedAtMilliseconds,
    startedAtMilliseconds,
    updatedAtMilliseconds: startedAtMilliseconds,
  };
}

function observeProgress(tracker: ProgressTracker, progress: CodeGraphProgress, now: number): void {
  if (tracker.phase !== progress.phase) {
    tracker.phase = progress.phase;
    tracker.phaseStartedAtMilliseconds = now;
  }
  const eta = observeCodeGraphEta(tracker.etaTracker, codeGraphEtaMeasurement(progress), now);
  tracker.etaTracker = eta.tracker;
  const estimate = Option.getOrUndefined(eta.estimate);
  tracker.estimatedPhaseRemainingMilliseconds = estimate?.remainingMilliseconds;
  tracker.estimateConfidence = estimate?.confidence;
  tracker.updatedAtMilliseconds = now;
}

function roundUpToSecond(milliseconds: number): number {
  return Math.ceil(Math.max(0, milliseconds) / 1_000) * 1_000;
}

function progressTiming(tracker: ProgressTracker, now: number): CodeGraphProgressTiming {
  return {
    buildId: tracker.buildId,
    elapsedMilliseconds: Math.max(0, now - tracker.startedAtMilliseconds),
    ...(tracker.estimateConfidence ? {estimateConfidence: tracker.estimateConfidence} : {}),
    ...(tracker.estimatedPhaseRemainingMilliseconds === undefined
      ? {}
      : {
          estimatedPhaseRemainingMilliseconds: tracker.estimatedPhaseRemainingMilliseconds,
          estimateScope: 'phase' as const,
        }),
    lastProgressAgeMilliseconds: Math.max(0, now - tracker.updatedAtMilliseconds),
    phaseElapsedMilliseconds: Math.max(0, now - tracker.phaseStartedAtMilliseconds),
    phaseStartedAtMilliseconds: tracker.phaseStartedAtMilliseconds,
    startedAtMilliseconds: tracker.startedAtMilliseconds,
    updatedAtMilliseconds: tracker.updatedAtMilliseconds,
  };
}

function refreshStatusAt(status: CodeGraphRefreshStatus, now: number): CodeGraphRefreshStatus {
  if (status.state !== 'indexing') return status;
  const lastProgressAgeMilliseconds = Math.max(0, now - status.timing.updatedAtMilliseconds);
  const estimate = status.timing.estimatedPhaseRemainingMilliseconds;
  const adjustedEstimate =
    estimate === undefined || lastProgressAgeMilliseconds >= estimate
      ? undefined
      : roundUpToSecond(estimate - lastProgressAgeMilliseconds);
  const {
    estimateConfidence: _estimateConfidence,
    estimatedPhaseRemainingMilliseconds: _estimatedPhaseRemainingMilliseconds,
    estimateScope: _estimateScope,
    ...timing
  } = status.timing;
  return {
    ...status,
    timing: {
      ...timing,
      elapsedMilliseconds: Math.max(0, now - status.timing.startedAtMilliseconds),
      ...(adjustedEstimate === undefined
        ? {}
        : {
            estimateConfidence: status.timing.estimateConfidence,
            estimatedPhaseRemainingMilliseconds: adjustedEstimate,
            estimateScope: 'phase' as const,
          }),
      lastProgressAgeMilliseconds,
      phaseElapsedMilliseconds: Math.max(0, now - status.timing.phaseStartedAtMilliseconds),
    },
  };
}

/** @internal Pure new-host projection from the persisted child build receipt. */
export function persistedRefreshStatus(status: ObservedCodeGraphBuildStatus): CodeGraphRefreshStatus {
  if (status.observation.liveness === 'completed' && status.result) {
    return {edges: status.result.edges, state: 'ready', symbols: status.result.symbols};
  }
  if (status.observation.liveness === 'failed' || status.observation.liveness === 'abandoned') {
    return {
      failure: codeGraphRefreshFailure(
        isolatedBuilderFailureFromStatus(
          status.error,
          status.error?.summary ?? 'Code graph build stopped before completion.',
        ),
      ),
      state: 'deferred',
    };
  }
  const startedAtMilliseconds = Date.parse(status.timestamps.startedAt);
  const phaseStartedAtMilliseconds = Date.parse(status.timestamps.phaseStartedAt);
  const updatedAtMilliseconds = Date.parse(status.timestamps.updatedAt);
  const now = Date.parse(status.timestamps.heartbeatAt) + status.observation.heartbeatAgeMilliseconds;
  return {
    state: 'indexing',
    timing: {
      buildId: status.buildId,
      elapsedMilliseconds: Math.max(0, now - startedAtMilliseconds),
      ...(status.eta
        ? {
            estimateConfidence: status.eta.confidence,
            estimatedPhaseRemainingMilliseconds: status.eta.remainingMilliseconds,
            estimateScope: 'phase' as const,
          }
        : {}),
      lastProgressAgeMilliseconds: Math.max(0, now - updatedAtMilliseconds),
      phaseElapsedMilliseconds: Math.max(0, now - phaseStartedAtMilliseconds),
      phaseStartedAtMilliseconds,
      startedAtMilliseconds,
      updatedAtMilliseconds,
    },
  };
}

const PREWARM_REFS = [
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
  'refs/heads/main',
  'refs/heads/master',
] as const;

/** @internal Deterministic and property-tested admission for bounded prewarming. */
export function prewarmCandidatesFromRefOutput(output: string, currentCommit: string, maximum = 2): readonly string[] {
  const limit = Number.isSafeInteger(maximum) && maximum > 0 ? Math.min(maximum, 2) : 2;
  return [
    ...new Set(
      output
        .split(/\r?\n/u)
        .map(value => value.trim().toLowerCase())
        .filter(value => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value) && value !== currentCommit.toLowerCase()),
    ),
  ].slice(0, limit);
}

export const prewarmLikelyCleanSnapshots = Effect.fn('codeGraph.prewarmLikelyCleanSnapshots')(function* (input: {
  readonly commandExecutor: {
    readonly execute: (
      executable: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => Effect.Effect<CommandResult, unknown>;
  };
  readonly indexer: CodeGraphIndexerShape;
  readonly options: CodeGraphWatchOptions;
  readonly path: Path.Path;
  readonly prewarmedCommits: SynchronizedRef.SynchronizedRef<Set<string>>;
  readonly prewarmSemaphore: Semaphore.Semaphore;
  readonly store: CodeGraphStoreShape;
}) {
  if (input.options.project?.graph !== undefined) return;
  const identity = yield* resolveRepositoryIdentity(input.options.cwd);
  const refs = yield* input.commandExecutor.execute(
    'git',
    ['-C', identity.repoRoot, 'for-each-ref', '--format=%(objectname)', ...PREWARM_REFS],
    {allowFailure: true, maxOutputBytes: 16 * 1024, timeoutMs: 10_000},
  );
  const commits = prewarmCandidatesFromRefOutput(refs.stdout, identity.headCommit);
  if (commits.length === 0) return;
  const layout = codeGraphLayout(input.path, input.options.threadnoteHome, identity.checkoutId, identity.worktreeId);
  yield* input.prewarmSemaphore.withPermit(
    Effect.forEach(
      commits,
      commit =>
        Effect.gen(function* () {
          const key = `${identity.checkoutId}:${commit}`;
          const reserved = yield* SynchronizedRef.modify(input.prewarmedCommits, current => {
            if (current.has(key)) return [false, current] as const;
            const next = new Set(current);
            if (next.size >= 64) next.delete(next.values().next().value!);
            next.add(key);
            return [true, next] as const;
          });
          if (!reserved) return;
          yield* input.indexer
            .ensureCommit({
              commit,
              cwd: input.options.cwd,
              threadnoteHome: input.options.threadnoteHome,
            })
            .pipe(
              Effect.flatMap(lease => input.store.releaseSnapshotLease(layout.databasePath, lease.leaseToken)),
              Effect.catchCause(cause => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                const failure = codeGraphRefreshFailureFromCause(cause);
                return SynchronizedRef.update(input.prewarmedCommits, current => {
                  const next = new Set(current);
                  next.delete(key);
                  return next;
                }).pipe(
                  Effect.andThen(
                    Effect.logDebug(`Code graph prewarm deferred (${failure.code}; recovery: ${failure.recovery}).`),
                  ),
                );
              }),
            );
        }),
      {concurrency: 1, discard: true},
    ),
  );
});

const indexRepository = (indexer: CodeGraphIndexerShape, options: CodeGraphWatchOptions) =>
  indexer
    .index(codeGraphWatcherRefreshIndexRequest(options))
    .pipe(
      Effect.tap(
        summary => options.onRefreshed?.(summary.snapshot.symbolCount, summary.snapshot.edgeCount) ?? Effect.void,
      ),
    );

/** Watcher-driven refresh never owns embedding; explicit `graph index` still does. */
export function codeGraphWatcherRefreshIndexRequest(options: CodeGraphWatchOptions): {
  readonly admissionClass?: CodeGraphBuilderAdmissionClass;
  readonly cwd: string;
  readonly ensureVectors: false;
  readonly onProgress: CodeGraphWatchOptions['onProgress'];
  readonly project?: CodeGraphWatchOptions['project'];
  readonly refreshDemandToken?: string;
  readonly threadnoteHome: string;
} {
  return {
    ...(options.admissionClass === undefined ? {} : {admissionClass: options.admissionClass}),
    cwd: options.cwd,
    ensureVectors: false,
    onProgress: options.onProgress,
    ...(options.project === undefined ? {} : {project: options.project}),
    ...(options.refreshDemandToken === undefined ? {} : {refreshDemandToken: options.refreshDemandToken}),
    threadnoteHome: options.threadnoteHome,
  };
}

/** @internal Exported for deterministic watch-failure/reconciliation tests. */
export const watchRepository = Effect.fn('codeGraph.watchRepository')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  options: CodeGraphWatchOptions,
  _initialRefresh: boolean,
  requestRefresh: () => Effect.Effect<void>,
  reconciliationHooks: CodeGraphWatchReconciliationHooks = {
    periodicRefreshRequired: Effect.succeed(true),
    requestAfterChange: Effect.void,
  },
) {
  yield* (reconciliationHooks.requestInitial ?? reconciliationHooks.requestAfterChange).pipe(
    Effect.catch(() => Effect.logWarning('Code graph initial maintenance scheduling failed; watch remains active.')),
  );
  const ignorePolicy = yield* (reconciliationHooks.watchIgnorePolicy ?? Effect.succeed(ALLOW_ALL_WATCH_POLICY)).pipe(
    Effect.orElseSucceed(() => ALLOW_ALL_WATCH_POLICY),
  );
  const changes = fs.watch(options.cwd, {recursive: true}).pipe(
    Stream.filterEffect(event => {
      const relative = relevantWatchPath(path, options.cwd, event.path);
      return relative === undefined ? Effect.succeed(false) : ignorePolicy.accepts(relative);
    }),
    Stream.debounce('750 millis'),
    Stream.map(() => 'change' as const),
    Stream.catchCause(cause =>
      Cause.hasInterruptsOnly(cause)
        ? Stream.failCause(cause)
        : Stream.fromEffect(
            Effect.logWarning('Code graph filesystem watch stopped; periodic reconciliation remains active.'),
          ),
    ),
  );
  const reconciliation = Stream.fromSchedule(Schedule.spaced('5 minutes')).pipe(Stream.map(() => 'periodic' as const));
  const {reconcile, scheduleSettled: scheduleSettledReconciliation} = yield* makeCodeGraphWatchReconciliation({
    probe: reconciliationHooks.periodicRefreshRequired,
    reload: ignorePolicy.reload,
    requestRefresh,
  });
  yield* Stream.merge(changes, reconciliation).pipe(
    Stream.runForEach(event =>
      event === 'change'
        ? reconciliationHooks.requestAfterChange.pipe(
            Effect.catch(() =>
              Effect.logWarning('Code graph change maintenance scheduling failed; refresh remains active.'),
            ),
            Effect.andThen(
              (reconciliationHooks.changeRefreshRequired ?? Effect.succeed(true)).pipe(
                Effect.match({
                  onFailure: () => false,
                  onSuccess: refreshRequired => refreshRequired,
                }),
                Effect.flatMap(refreshRequired => (refreshRequired ? requestRefresh() : Effect.void)),
              ),
            ),
            Effect.andThen(scheduleSettledReconciliation),
          )
        : reconcile,
    ),
  );
});

export function codeGraphWatcherSnapshotStale(
  snapshot: {readonly commit: string; readonly dirty: boolean; readonly overlayFingerprint?: string},
  identity: Pick<RepositoryIdentity, 'headCommit'>,
  overlay: {readonly dirty: boolean; readonly fingerprint?: string},
): boolean {
  return (
    snapshot.commit !== identity.headCommit ||
    snapshot.dirty !== overlay.dirty ||
    (overlay.dirty && snapshot.overlayFingerprint !== overlay.fingerprint)
  );
}

/**
 * Background watch/timer work is admitted only after the current ready base
 * was produced by a successful bounded overlay assessment. Missing or full
 * outcomes remain fail-closed until an explicit current-only request records a
 * new result.
 */
export function codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh(
  readySnapshotId: string,
  statuses: readonly Pick<ObservedCodeGraphBuildStatus, 'materialization' | 'result' | 'state' | 'timestamps'>[],
): boolean {
  const matching = statuses.filter(
    status => status.state === 'completed' && status.result?.snapshotId === readySnapshotId,
  );
  const latest = matching.sort((left, right) => {
    const leftTime = Date.parse(left.timestamps.completedAt ?? left.timestamps.updatedAt);
    const rightTime = Date.parse(right.timestamps.completedAt ?? right.timestamps.updatedAt);
    return rightTime - leftTime;
  })[0];
  return latest?.result?.overlayAssessment?.outcome === 'overlay-success';
}

const ALLOW_ALL_WATCH_POLICY: CodeGraphWatchIgnorePolicy = {
  accepts: () => Effect.succeed(true),
  reload: Effect.void,
};

interface WatchIgnoreState {
  readonly gitDecisions: ReadonlyMap<string, boolean>;
  readonly rules: readonly CompiledIgnoreRule[];
}

const WATCH_GIT_IGNORE_CACHE_LIMIT = 1_024;

/** @internal Use the inventory ignore union before debounce and maintenance scheduling. */
export const makeCodeGraphWatchIgnorePolicy = Effect.fn('codeGraph.makeWatchIgnorePolicy')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoRoot: string,
  watchCwd = repoRoot,
) {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const sources = yield* readThreadnoteIgnoreSources(fs, path, repoRoot);
  const state = yield* Ref.make<WatchIgnoreState>({
    gitDecisions: new Map(),
    rules: compileThreadnoteIgnore(sources.committed, sources.local),
  });
  const reload = Effect.gen(function* () {
    const updated = yield* readThreadnoteIgnoreSources(fs, path, repoRoot);
    yield* Ref.set(state, {
      gitDecisions: new Map(),
      rules: compileThreadnoteIgnore(updated.committed, updated.local),
    });
  }).pipe(Effect.provideService(SystemInfo, system));
  return {
    accepts: (watchPath: string) =>
      Effect.gen(function* () {
        const repositoryPath = path.relative(repoRoot, path.join(watchCwd, watchPath)).split(path.sep).join('/');
        if (isOverlayAdmissionControlPath(repositoryPath)) {
          yield* reload;
          return true;
        }
        const current = yield* Ref.get(state);
        if (isIgnoredByThreadnote(repositoryPath, current.rules)) return false;
        const prefixes = repositoryPath.split('/').map((_, index, segments) => segments.slice(0, index + 1).join('/'));
        if (prefixes.some(prefix => current.gitDecisions.get(prefix) === true)) return false;
        const unknown = prefixes.filter(prefix => !current.gitDecisions.has(prefix));
        if (unknown.length === 0) return true;
        const checked = yield* runCommandEffect(
          'git',
          ['-C', repoRoot, '-c', 'core.ignorecase=false', 'check-ignore', '--no-index', '-z', '--stdin'],
          {
            allowFailure: true,
            input: new TextEncoder().encode(`${unknown.join('\0')}\0`),
            maxOutputBytes: 0,
            timeoutMs: 0,
          },
        ).pipe(
          Effect.map(result => new Set(result.stdout.split('\0').filter(Boolean))),
          Effect.orElseSucceed(() => new Set<string>()),
        );
        yield* Ref.update(state, previous => {
          const gitDecisions = new Map(previous.gitDecisions);
          for (const prefix of unknown) {
            if (gitDecisions.size >= WATCH_GIT_IGNORE_CACHE_LIMIT) {
              gitDecisions.delete(gitDecisions.keys().next().value ?? '');
            }
            gitDecisions.set(prefix, checked.has(prefix));
          }
          return {...previous, gitDecisions};
        });
        return !prefixes.some(prefix => checked.has(prefix));
      }).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, system)),
    reload,
  } satisfies CodeGraphWatchIgnorePolicy;
});

function relevantWatchPath(path: Path.Path, cwd: string, eventPath: string): string | undefined {
  const absolute = path.isAbsolute(eventPath) ? eventPath : path.join(cwd, eventPath);
  const relative = path.relative(cwd, absolute);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  const segments = relative.split(path.sep);
  return segments.some(
    segment =>
      segment.startsWith('.') &&
      segment !== '.gitignore' &&
      segment !== '.threadnoteignore' &&
      segment !== '.threadnoteignore.local',
  )
    ? undefined
    : relative;
}
