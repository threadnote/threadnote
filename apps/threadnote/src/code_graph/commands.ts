import {Array as EffectArray} from 'effect';
import {Clock, Console, Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {startProgress, withProgressLine} from '../cli_ui.js';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import {readExclusiveFileLockOwner} from '@threadnote/platform/file/lock';
import {
  runtimeFileDescriptorStatSync,
  runtimePathStatSync,
  runtimePlatform,
  SystemInfo,
  type RuntimeNativeFileStat,
} from '@threadnote/platform/system';
import {healAnchorsAfterWorksetPrepare} from '../memory/deferred/code_anchor_recovery.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {
  formatCodeGraphCompactProgressLine,
  formatCodeGraphPurgeProgressLine,
  formatCodeGraphRepairProgressLine,
  makeCodeGraphHumanProgressReporter,
} from '@threadnote/graph/cli/progress';
import {makeCodeGraphJsonProgressReporter} from '@threadnote/graph/json_progress';
import {codeGraphLayout, codeGraphWorktreeLockPath} from '@threadnote/graph/layout';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {
  repairCodeGraphIndexes,
  inspectObsoleteCodeGraphStores,
  purgeAllCodeGraphIndexes,
  purgeCodeGraphIndex,
  purgeObsoleteCodeGraphStores,
  type CodeGraphRepairCompletion,
  type ObsoleteCodeGraphStoreInventory,
} from '@threadnote/graph/maintenance';
import {CodeGraphQueryService, observationFromCodeGraphStatus, renderCodeGraphResult} from '@threadnote/graph/query';
import {
  repositoryChangesSince,
  repositoryIdentityMatchesExpectation,
  resolveRepositoryIdentity,
} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {
  CodeGraphProgress,
  CodeGraphQueryOptions,
  CodeGraphStatus,
  RepositoryIdentityExpectation,
} from '@threadnote/graph/types';
export {runCodeGraphWatch} from '@threadnote/graph/commands/watch';
import {
  CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV,
  CODE_GRAPH_REFRESH_SCOPE_ROUTE_ENV,
  resolveCodeGraphScopeRoute,
} from '@threadnote/graph/scope/routing';
import {
  findCodeGraphWorksetPath,
  inspectCodeGraphWorksetTopology,
  traceCodeGraphWorksetImpact,
  type CodeGraphWorksetTopologyResultV1,
} from '@threadnote/graph/cross_repository/runtime';
import type {CodeGraphCrossRepositoryTraversalResultV1} from '@threadnote/graph/cross_repository/traversal';
import {
  continueCodeGraphWorksetQueryV2,
  queryCodeGraphWorksetV2,
  resolveCodeGraphQualifiedRefTarget,
} from '@threadnote/graph/workset/query_v2';
import {
  inspectCodeGraphWorksetStatus,
  prepareCodeGraphWorkset,
  type CodeGraphWorksetPrepareResultV1,
  type CodeGraphWorksetStatusResultV1,
} from '@threadnote/graph/workset_catalog/workset';
import {makeCodeGraphWorksetJsonProgressReporter} from '@threadnote/graph/workset/progress';
import {CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV} from '@threadnote/graph/workset_catalog/isolated_prepare';
import {analyzeCodeGraphReadIsolated, CodeGraphAnalysisReadTimedOut} from '@threadnote/graph/isolated/analysis';
import {
  renderCodeGraphAnalysis,
  renderCodeGraphReport,
  type CodeGraphAnalysisView,
} from '@threadnote/graph/analysis/render';
import {
  CODE_GRAPH_CLI_READ_RETRY_MILLISECONDS,
  CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS,
  codeGraphCliUsesBorrowedContinuity,
  codeGraphCliReadPlan,
  type CodeGraphCliFreshnessPolicy,
  type CodeGraphCliReadPlan,
} from '@threadnote/graph/cli/freshness';
import {exportCodeGraph, type CodeGraphExportFormat, type CodeGraphExportLimit} from '@threadnote/graph/export';
import {readCodeGraphBuildStatuses, selectCodeGraphBuildStatuses} from '@threadnote/graph/build_status';
import {compactCodeGraphStorage, inspectCodeGraphStorage, type CodeGraphStorage} from '@threadnote/graph/storage';
import {
  resolveCodeGraphStatusOptions,
  serializeCodeGraphStatusV5,
  type CodeGraphStatusObservedLock,
} from '@threadnote/graph/status/projection';
import {
  codeGraphEtaBasisLabel as etaBasisLabel,
  formatCodeGraphStatusDuration as formatStatusDuration,
  renderCodeGraphBuildCounters as renderBuildCounters,
  renderCodeGraphReadySnapshotStatus as renderReadySnapshotStatus,
} from '@threadnote/graph/status/render';
import {inspectAllCodeGraphsLocal, renderCodeGraphDiagnostics} from '@threadnote/graph/diagnostics';
import {
  readCodeGraphCliWithContinuity,
  resolveCodeGraphCliReadContinuity,
} from '@threadnote/graph/commands/read_continuity';
export {runCodeGraphInventory} from './commands/inventory.js';
import {removeCodeGraphView} from '@threadnote/graph/view_removal';
import {
  codeGraphViewRemovalTargetFailure,
  renderCodeGraphViewRemovalResult,
  serializeCodeGraphViewRemovalResult,
} from './view_removal_output.js';
import {
  codeGraphSnapshotPurgeTargetFailure,
  purgeCodeGraphSnapshot,
  renderCodeGraphSnapshotPurgeResult,
  serializeCodeGraphSnapshotPurgeResult,
} from '@threadnote/graph/snapshot/purge';

import * as EffectString from 'effect/String';
import {
  activeBatchNumber,
  formatBytes,
  formatMilliseconds,
  materializationDiskWarning,
  materializationStageLabel,
  renderFallbackAssessment,
  renderFallbackBoundary,
  renderMaterializationRows,
} from './materialization_output.js';
import * as Effect2 from 'effect';

interface CwdOption {
  readonly cwd?: string;
}
export {CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS, codeGraphCliReadPlan, codeGraphCliUsesBorrowedContinuity};
export type {CodeGraphCliFreshnessPolicy, CodeGraphCliReadPlan};

class CodeGraphCommandError extends Schema.TaggedError<CodeGraphCommandError, {readonly brand: unique symbol}>()(
  'CodeGraphCommandError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export function defaultCodeGraphCliFreshness(
  operation: CodeGraphQueryOptions['operation'],
): Exclude<CodeGraphCliFreshnessPolicy, 'allow-stale'> {
  return operation === 'impact' || operation === 'path' ? 'current' : 'ready';
}

interface CodeGraphCliReadState {
  readonly budgetMilliseconds?: number;
  readonly freshness: CodeGraphStatus['freshness'];
  readonly freshnessPolicy: CodeGraphCliFreshnessPolicy;
  readonly operation: CodeGraphQueryOptions['operation'];
  readonly reason: 'no-ready-snapshot' | 'read-timeout';
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly retryAfterMilliseconds: number;
  readonly snapshot?: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly id: string;
  };
  readonly state: 'timed-out' | 'unavailable';
  readonly type: 'code-graph-query-state';
  readonly version: 1;
}

function codeGraphCliReadState(
  status: CodeGraphStatus,
  policy: CodeGraphCliFreshnessPolicy,
  operation: CodeGraphQueryOptions['operation'],
  reason: CodeGraphCliReadState['reason'],
  budgetMilliseconds?: number,
): CodeGraphCliReadState {
  return {
    ...(budgetMilliseconds === undefined ? {} : {budgetMilliseconds}),
    freshness: status.freshness,
    freshnessPolicy: policy,
    operation,
    reason,
    repository: {
      displayName: status.identity.displayName,
      repositoryId: status.identity.repositoryId,
    },
    retryAfterMilliseconds: CODE_GRAPH_CLI_READ_RETRY_MILLISECONDS,
    ...(status.readySnapshot
      ? {
          snapshot: {
            commit: status.readySnapshot.commit,
            dirty: status.readySnapshot.dirty,
            id: status.readySnapshot.id,
          },
        }
      : {}),
    state: reason === 'read-timeout' ? 'timed-out' : 'unavailable',
    type: 'code-graph-query-state',
    version: 1,
  };
}

function renderCodeGraphCliReadState(state: CodeGraphCliReadState): string {
  if (state.state === 'unavailable') {
    return (
      'No ready code graph snapshot is available. Retry after indexing, or use --freshness ready/current to allow ' +
      'this command to start a bounded refresh.\n'
    );
  }
  const readyHint =
    state.snapshot === undefined
      ? ' Run graph index, then retry, or rerun with a larger --read-timeout-ms.'
      : ' A ready snapshot remains available; retry with --freshness ready to inspect it without waiting.';
  return (
    `Code graph ${state.freshnessPolicy} read exceeded Threadnote's ` +
    `${(state.budgetMilliseconds ?? CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS) / 1_000}-second foreground budget.${readyHint}\n`
  );
}

interface ExpectedRepositoryIdentityOption {
  readonly expectedIdentity?: RepositoryIdentityExpectation;
}

export interface CodeGraphExportInterlock {
  readonly afterOutputCheck?: () => Effect.Effect<void>;
  readonly beforeLink?: (temporaryPath: string) => Effect.Effect<void>;
  readonly beforePublish?: (temporaryPath: string) => Effect.Effect<void>;
}

export const runCodeGraphRepair = Effect.fn('codeGraph.command.repair')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly all?: boolean;
    readonly checkoutId?: string;
    readonly deep?: boolean;
    readonly dryRun?: boolean;
    readonly json?: boolean;
  },
) {
  if (options.all && (options.checkoutId !== undefined || options.cwd !== undefined)) {
    return yield* CodeGraphCommandError.make({message: 'Use --all by itself, without --checkout-id or --cwd.'});
  }
  if (options.checkoutId !== undefined && options.cwd !== undefined) {
    return yield* CodeGraphCommandError.make({message: 'Use either --checkout-id or --cwd, not both.'});
  }
  const targetCheckoutId = options.all
    ? undefined
    : (options.checkoutId ?? (yield* resolveRepositoryIdentity(yield* commandCwd(options.cwd))).checkoutId);
  let completion: CodeGraphRepairCompletion | undefined;
  const summary = options.json
    ? yield* repairCodeGraphIndexes(
        config.agentContextHome,
        options.dryRun === true,
        undefined,
        result => Effect.sync(() => void (completion = result)),
        {migrateSchema: true, mode: options.deep ? 'deep' : 'quick', targetCheckoutId},
      )
    : yield* withProgressLine(
        formatCodeGraphRepairProgressLine({current: 0, phase: 'checking', total: 1}, options.dryRun === true),
        update =>
          repairCodeGraphIndexes(
            config.agentContextHome,
            options.dryRun === true,
            progress => update(formatCodeGraphRepairProgressLine(progress, options.dryRun === true)),
            result => Effect.sync(() => void (completion = result)),
            {migrateSchema: true, mode: options.deep ? 'deep' : 'quick', targetCheckoutId},
          ),
      );
  if (options.json) {
    yield* writeFinalCliOutput(
      JSON.stringify({
        doctor: completion?.doctorCheck ?? null,
        ...(targetCheckoutId === undefined ? {all: true} : {checkoutId: targetCheckoutId}),
        dryRun: options.dryRun === true,
        mode: options.deep ? 'deep' : 'quick',
        summary,
        type: 'code-graph-repair',
        version: 1,
      }),
    );
    return;
  }
  yield* Console.log(
    `${options.dryRun ? 'Would repair' : 'Repaired'} ${summary.databases} native code graph database(s): ` +
      `${summary.migratedDatabases} schema migration(s), ${summary.deferredDatabases} deferred, ` +
      `${summary.discarded} disposable rebuild(s), ${summary.removedIncompleteSnapshots} incomplete snapshot(s), ` +
      `${summary.removedTemporaryFiles} temporary graph file(s).`,
  );
  if (completion) {
    yield* Console.log(
      `${Effect2.pipe(completion.doctorCheck.status, EffectString.toUpperCase)} native code graph: ${completion.doctorCheck.detail}`,
    );
  }
});

export const runCodeGraphDiagnostics = Effect.fn('codeGraph.command.diagnostics')(function* (
  config: RuntimeConfig,
  options: {readonly analyze?: boolean; readonly deep?: boolean; readonly json?: boolean},
) {
  const report = yield* inspectAllCodeGraphsLocal(config.agentContextHome, {
    analyze: options.analyze,
    deep: options.deep,
    onProgress: options.json
      ? undefined
      : progress =>
          Console.log(
            `${progress.phase === 'analyzing' ? 'Analyzing' : options.deep ? 'Deep-checking' : 'Checking'} native code graph database ${progress.current}/${progress.total}.`,
          ),
  });
  yield* writeFinalCliOutput(
    options.json ? JSON.stringify(report) : Effect2.pipe(renderCodeGraphDiagnostics(report), EffectString.trimEnd),
  );
});

interface CodeGraphExportTemporaryIdentity {
  readonly birthtimeMilliseconds: number;
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly modifiedAtMilliseconds: number;
  readonly size: bigint;
}

export const runCodeGraphStatus = Effect.fn('codeGraph.command.status')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly buildLimit?: number;
    readonly json?: boolean;
    readonly languagePackLimit?: number;
    readonly project?: string;
  },
) {
  const statusOptions = resolveCodeGraphStatusOptions(options);
  if (statusOptions.error !== undefined) {
    return yield* CodeGraphCommandError.make({message: statusOptions.error});
  }
  const cwd = yield* commandCwd(options.cwd);
  const path = yield* Path.Path;
  const query = yield* CodeGraphQueryService;
  const ready = yield* query.status(config.agentContextHome, cwd, {
    manifestPath: config.manifestPath,
    ...(options.project === undefined ? {} : {project: options.project}),
  });
  const identity = ready.identity;
  const statusScopeKey = observationFromCodeGraphStatus(ready)?.projectScope?.scope?.scopeKey;
  const layout = codeGraphLayout(
    path,
    config.agentContextHome,
    identity.checkoutId,
    identity.worktreeId,
    statusScopeKey ?? ready.readySnapshot?.scopeId,
  );
  const obsoleteStores = yield* inspectObsoleteCodeGraphStores(config.agentContextHome, identity.checkoutId);
  const storage = yield* inspectCodeGraphStorage(config.agentContextHome, identity.checkoutId);
  const statuses = yield* readCodeGraphBuildStatuses(layout);
  const selection = selectCodeGraphBuildStatuses(statuses);
  const waitingFor = (reason: string) =>
    Option.getOrUndefined(
      EffectArray.findFirst(
        statuses,
        status => status.observation.liveness === 'active' && status.state === 'queued' && status.subphase === reason,
      ),
    );
  const waitingRepository =
    Option.getOrUndefined(
      EffectArray.findFirst(
        statuses,
        status =>
          status.identity.worktreeId === identity.worktreeId &&
          status.observation.liveness === 'active' &&
          status.state === 'queued' &&
          status.subphase === 'repository-lock',
      ),
    ) ?? waitingFor('repository-lock');
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const observeLock = (lockPath: string) =>
    Effect.gen(function* () {
      const observed = yield* readExclusiveFileLockOwner(fs, lockPath);
      if (Option.isNone(observed)) {
        return (yield* fs.exists(lockPath))
          ? ({state: 'unverified'} satisfies CodeGraphStatusObservedLock)
          : ({state: 'available'} satisfies CodeGraphStatusObservedLock);
      }
      const owner = observed.value;
      if (!owner.processStartIdentity || !system.isProcessRunning(owner.processId)) {
        return {state: 'unverified'} satisfies CodeGraphStatusObservedLock;
      }
      const currentStartIdentity = yield* system.processStartIdentity(owner.processId);
      return currentStartIdentity === owner.processStartIdentity
        ? ({owner: {processId: owner.processId}, state: 'active'} satisfies CodeGraphStatusObservedLock)
        : ({state: 'unverified'} satisfies CodeGraphStatusObservedLock);
    });
  const locks = {
    ...(waitingFor('database-writer') ? {databaseWriter: yield* observeLock(layout.databaseWriteLockPath)} : {}),
    ...(waitingRepository
      ? {
          repository: {
            ...(yield* observeLock(
              codeGraphWorktreeLockPath(
                path,
                config.agentContextHome,
                identity.checkoutId,
                waitingRepository.identity.worktreeId,
              ),
            )),
            worktreeId: waitingRepository.identity.worktreeId,
          },
        }
      : {}),
  };
  const buildStatuses = selection.builds;
  const current =
    Option.getOrUndefined(
      EffectArray.findFirst(buildStatuses, status => status.identity.worktreeId === identity.worktreeId),
    ) ??
    Option.getOrUndefined(EffectArray.findFirst(buildStatuses, status => status.observation.liveness === 'active'));
  const queuedWorktreeIds = [...new Set(EffectArray.map(selection.waiters, status => status.identity.worktreeId))];
  if (options.json) {
    yield* writeFinalCliOutput(
      serializeCodeGraphStatusV5(
        selection,
        identity.worktreeId,
        statusOptions.buildLimit,
        statusOptions.languagePackLimit,
        {
          databasePath: layout.databasePath,
          identity,
          languagePacks: ready.languagePacks,
          // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
          ...(Object.keys(locks).length === 0 ? {} : {locks}),
          obsoleteStores,
          ...(ready.projectCoverage === undefined ? {} : {projectCoverage: ready.projectCoverage}),
          readySnapshot: ready.readySnapshot ?? null,
          stale: ready.stale,
          ...(ready.semantic === undefined ? {} : {semantic: ready.semantic}),
          storage,
        },
      ),
    );
    return;
  }
  if (ready.semantic !== undefined) yield* Console.log(`Semantic vectors: ${ready.semantic.state}`);
  if (current !== undefined) {
    yield* Console.log(`Repository: ${identity.displayName}`);
    yield* Console.log(`Database: ${layout.databasePath}`);
    yield* renderObsoleteStoreStatus(obsoleteStores);
    yield* renderActiveStorageStatus(storage);
    if (!current) {
      yield* Console.log(`Build status: ${buildStatuses.length} other worktree build(s) observed.`);
      yield* renderReadySnapshotStatus(ready);
      return;
    }
    yield* Console.log(
      `Build: ${current.state} · ${current.observation.liveness}${current.coordination?.progressSilent ? ' (progress silent)' : ''} · ${current.phase}/${current.subphase ?? 'unknown'}`,
    );
    yield* Console.log(
      `Owner: PID ${current.owner.processId} · Bun ${current.owner.runtimeVersion} · ` +
        `heartbeat ${formatStatusDuration(current.observation.heartbeatAgeMilliseconds)} ago`,
    );
    if (current.scheduling?.queue) {
      const queue = current.scheduling.queue;
      yield* Console.log(
        `Admission: ${queue.admissionClass} · ${current.scheduling.admittedAt ? 'admitted' : `queue ${queue.position}/${queue.size}`} · enqueued ${queue.enqueuedAt}`,
      );
    }
    if (current.scheduling?.blocker) yield* Console.log(`Waiting for: ${current.scheduling.blocker}`);
    if (current.scheduling?.phaseMilliseconds) {
      yield* Console.log(
        `Phase time: ${EffectArray.join(
          EffectArray.map(
            // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
            Object.entries(current.scheduling.phaseMilliseconds),
            ([phase, milliseconds]) => `${phase} ${formatStatusDuration(milliseconds)}`,
          ),
          ' · ',
        )}`,
      );
    }
    if (locks.databaseWriter) {
      yield* Console.log(
        locks.databaseWriter.state === 'active'
          ? `Database writer lock: PID ${locks.databaseWriter.owner.processId} · inspect with threadnote processes`
          : `Database writer lock: ${locks.databaseWriter.state}`,
      );
    }
    if (locks.repository) {
      const label =
        locks.repository.worktreeId === identity.worktreeId
          ? 'Repository lock'
          : `Repository lock (worktree ${Effect2.pipe(locks.repository.worktreeId, EffectString.slice(0, 8))})`;
      yield* Console.log(
        locks.repository.state === 'active'
          ? `${label}: PID ${locks.repository.owner.processId} · inspect with threadnote processes`
          : `${label}: ${locks.repository.state}`,
      );
    }
    const counters = renderBuildCounters(current);
    if (counters) yield* Console.log(`Progress: ${counters}`);
    if (current.activity) {
      const activity = current.activity;
      const details = EffectArray.filter(
        [
          `${activity.stage} ${activity.language}`,
          formatBytes(activity.bytes),
          `batch ${activity.batchCompleted}/${activity.batchTotal}`,
          activity.parseMilliseconds === undefined
            ? undefined
            : `parse ${formatMilliseconds(activity.parseMilliseconds)}`,
          activity.persistMilliseconds === undefined
            ? undefined
            : `persist ${formatMilliseconds(activity.persistMilliseconds)}`,
          activity.degraded ? 'metadata fallback' : undefined,
        ],
        (value): value is string => value !== undefined,
      );
      yield* Console.log(`Current activity: ${EffectArray.join(details, ' · ')}`);
    }
    if (current.materialization?.activity) {
      const activity = current.materialization.activity;
      const details = EffectArray.filter(
        [
          materializationStageLabel(activity.stage),
          `batch ${activeBatchNumber(activity.batchCompleted, activity.batchTotal)}/${activity.batchTotal}`,
          `${formatBytes(activity.sourceBytes)} source`,
          activity.cachedFactBytes === undefined ? undefined : `${formatBytes(activity.cachedFactBytes)} cached facts`,
          activity.factsBytes === undefined ? undefined : `${formatBytes(activity.factsBytes)} final facts`,
          renderMaterializationRows(activity.rows),
          activity.elapsedMilliseconds === undefined
            ? `active ${formatStatusDuration(Math.max(0, (yield* Clock.currentTimeMillis) - Date.parse(activity.startedAt)))}`
            : `batch ${formatMilliseconds(activity.elapsedMilliseconds)}`,
          activity.stageElapsedMilliseconds === undefined
            ? undefined
            : `stage ${formatMilliseconds(activity.stageElapsedMilliseconds)}`,
          activity.transactionMilliseconds === undefined
            ? undefined
            : `transaction ${formatMilliseconds(activity.transactionMilliseconds)}`,
        ],
        (value): value is string => value !== undefined,
      );
      yield* Console.log(`Current activity: ${EffectArray.join(details, ' · ')}`);
    }
    if (current.activation?.activity) {
      const activity = current.activation.activity;
      const details = EffectArray.filter(
        [
          Effect2.pipe(activity.stage, EffectString.replaceAll('-', ' ')),
          activity.state,
          activity.rows === undefined ? undefined : `${activity.rows.toLocaleString()} rows`,
          `stage ${formatMilliseconds(activity.stageElapsedMilliseconds)}`,
          `total ${formatMilliseconds(activity.elapsedMilliseconds)}`,
          activity.transactionMilliseconds === undefined
            ? undefined
            : `transaction ${formatMilliseconds(activity.transactionMilliseconds)}`,
        ],
        (value): value is string => value !== undefined,
      );
      yield* Console.log(`Current activity: activating · ${EffectArray.join(details, ' · ')}`);
    }
    if (current.resolution?.activity) {
      const activity = current.resolution.activity;
      const details = [
        `pass ${activity.pass}`,
        `page ${activity.pageCompleted}/${activity.pageTotal}`,
        `${activity.referencesCompleted.toLocaleString()}/${activity.referencesTotal.toLocaleString()} references`,
        `${activity.referencesExamined.toLocaleString()} cumulative examined`,
        `${activity.resolved.toLocaleString()} linked`,
        `${activity.aliasesDiscovered.toLocaleString()} aliases`,
        `match ${formatMilliseconds(activity.matchingMilliseconds)}`,
        `transactions ${formatMilliseconds(activity.transactionMilliseconds)}`,
        `total ${formatMilliseconds(activity.elapsedMilliseconds)}`,
      ];
      yield* Console.log(`Reference resolution: ${EffectArray.join(details, ' · ')}`);
    }
    if (current.materialization?.metrics) {
      const metrics = current.materialization.metrics;
      const details = EffectArray.filter(
        [
          metrics.mode === undefined
            ? undefined
            : `${Effect2.pipe(metrics.mode, EffectString.replaceAll('-', ' '))} materialization`,
          metrics.fallbackReason === undefined
            ? undefined
            : `incremental fallback: ${Effect2.pipe(metrics.fallbackReason, EffectString.replaceAll('-', ' '))}`,
          renderFallbackAssessment(metrics.fallbackAssessment),
          renderFallbackBoundary(metrics.fallbackBoundary),
          `${metrics.batchesCompleted}/${metrics.batchesTotal} batches committed`,
          `${formatBytes(metrics.sourceBytesCompleted)}/${formatBytes(metrics.sourceBytesTotal)} source`,
          metrics.cachedFactBytesCompleted === undefined
            ? undefined
            : `${formatBytes(metrics.cachedFactBytesCompleted)}${
                metrics.cachedFactBytesTotal === undefined ? '' : `/${formatBytes(metrics.cachedFactBytesTotal)}`
              } cached facts`,
          metrics.factsBytesCompleted === undefined
            ? undefined
            : `${formatBytes(metrics.factsBytesCompleted)}${
                metrics.factsBytesTotal === undefined ? '' : `/${formatBytes(metrics.factsBytesTotal)}`
              } final facts`,
          renderMaterializationRows(metrics.rows),
          metrics.loadingMilliseconds === undefined
            ? undefined
            : `load ${formatMilliseconds(metrics.loadingMilliseconds)}`,
          metrics.attributionMilliseconds === undefined
            ? undefined
            : `attribute ${formatMilliseconds(metrics.attributionMilliseconds)}`,
          metrics.transactionMilliseconds === undefined
            ? undefined
            : `transactions ${formatMilliseconds(metrics.transactionMilliseconds)}`,
        ],
        (value): value is string => value !== undefined,
      );
      yield* Console.log(`Materialized: ${EffectArray.join(details, ' · ')}`);
      if (metrics.subphaseMilliseconds) {
        const subphases = metrics.subphaseMilliseconds;
        yield* Console.log(
          `Materialization detail: compute ${formatMilliseconds(subphases.attributionCompute)} · ` +
            `serialize ${formatMilliseconds(subphases.shardSerialization)} · ` +
            `persist shards ${formatMilliseconds(subphases.shardPersistence)} · ` +
            `associate shards ${formatMilliseconds(subphases.shardAssociation)} · ` +
            `prepare batches ${formatMilliseconds(subphases.factBatchPreparation)}`,
        );
      }
      if (metrics.storage) {
        const storage = metrics.storage;
        const storageDetails = EffectArray.filter(
          [
            storage.materializationMode === undefined
              ? undefined
              : `${Effect2.pipe(storage.materializationMode, EffectString.replaceAll('-', ' '))} materialization`,
            storage.durableDatabaseBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableDatabaseBytes)} allocated durable pages`,
            storage.durableDatabaseHighWaterBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableDatabaseHighWaterBytes)} allocated-page high-water`,
            storage.durableDatabaseGrowthHighWaterBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableDatabaseGrowthHighWaterBytes)} main-database growth`,
            storage.durableFilesystemHighWaterBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableFilesystemHighWaterBytes)} DB + sidecars high-water`,
            storage.durableSidecarDatabaseHighWaterBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableSidecarDatabaseHighWaterBytes)} sorted-sidecar high-water`,
            storage.durableSidecarJournalHighWaterBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableSidecarJournalHighWaterBytes)} sidecar journal high-water`,
            storage.durableSidecarWalHighWaterBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableSidecarWalHighWaterBytes)} sidecar WAL high-water`,
            storage.durableWalHighWaterBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableWalHighWaterBytes)} WAL high-water`,
            storage.durableJournalHighWaterBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableJournalHighWaterBytes)} rollback-journal high-water`,
            `${formatBytes(storage.temporaryDatabaseBytes)} current TEMP database`,
            `${formatBytes(storage.temporaryDatabaseHighWaterBytes)} TEMP database high-water`,
            storage.estimatedRequiredBytes === undefined
              ? undefined
              : `${formatBytes(storage.estimatedRequiredBytes)} combined estimate`,
            storage.estimatedTemporaryFilesystemRequiredBytes === undefined
              ? undefined
              : `${formatBytes(storage.estimatedTemporaryFilesystemRequiredBytes)} TEMP-filesystem requirement`,
            storage.estimatedDurableFilesystemRequiredBytes === undefined
              ? undefined
              : `${formatBytes(storage.estimatedDurableFilesystemRequiredBytes)} graph-filesystem requirement`,
            storage.estimatedTemporaryDatabaseBytes === undefined
              ? undefined
              : `${formatBytes(storage.estimatedTemporaryDatabaseBytes)} estimated TEMP`,
            storage.estimatedDurableSnapshotBytes === undefined
              ? undefined
              : `${formatBytes(storage.estimatedDurableSnapshotBytes)} estimated snapshot/WAL`,
            storage.estimatedJournalBytes === undefined
              ? undefined
              : `${formatBytes(storage.estimatedJournalBytes)} estimated journals`,
            storage.estimatedConcurrentBuildBytes === undefined
              ? undefined
              : `${formatBytes(storage.estimatedConcurrentBuildBytes)} concurrent-build allowance`,
            storage.filesystemsShared === true ? 'TEMP and graph database share a filesystem' : undefined,
            storage.temporaryAvailableBytes === undefined
              ? undefined
              : `${formatBytes(storage.temporaryAvailableBytes)} available for TEMP`,
            storage.durableAvailableBytes === undefined
              ? undefined
              : `${formatBytes(storage.durableAvailableBytes)} available for graph database`,
            storage.estimateBasis === undefined
              ? undefined
              : `estimate from ${Effect2.pipe(storage.estimateBasis, EffectString.replaceAll('-', ' '))}`,
          ],
          (value): value is string => value !== undefined,
        );
        yield* Console.log(
          `Materialization storage: ${EffectArray.join(storageDetails, ' · ')} · rollback journals excluded from TEMP totals`,
        );
        const diskWarning = materializationDiskWarning(storage);
        if (diskWarning) yield* Console.log(`Warning: ${diskWarning}`);
      }
    }
    if (current.timings) {
      yield* Console.log(
        `Phase timings: read ${formatMilliseconds(current.timings.readingMilliseconds)} · ` +
          `parse ${formatMilliseconds(current.timings.extractionMilliseconds)} · ` +
          (current.timings.serializationMilliseconds === undefined
            ? ''
            : `serialize ${formatMilliseconds(current.timings.serializationMilliseconds)} · `) +
          `persist ${formatMilliseconds(current.timings.persistenceMilliseconds)}`,
      );
    }
    if (current.extraction?.metrics) {
      const metrics = current.extraction.metrics;
      const workPercentage =
        metrics.workUnitsTotal === 0 ? 0 : Math.min(100, (metrics.workUnitsCompleted / metrics.workUnitsTotal) * 100);
      yield* Console.log(
        `Extraction: ${formatBytes(metrics.sourceBytesCompleted)}/${formatBytes(metrics.sourceBytesTotal)} source · ` +
          `${formatBytes(metrics.factsBytesCompleted)} emitted facts · ${workPercentage.toFixed(1)}% class-weighted work`,
      );
    }
    const lastProgressAge = Math.max(
      0,
      (yield* Clock.currentTimeMillis) - Date.parse(current.timestamps.lastProgressAt),
    );
    if (current.eta && current.eta.confidence !== 'low' && lastProgressAge <= 15_000) {
      yield* Console.log(
        `Phase ETA: about ${formatStatusDuration(current.eta.remainingMilliseconds)} ` +
          `(${current.eta.confidence} confidence${current.eta.basis ? `, ${etaBasisLabel(current.eta.basis)}` : ''})`,
      );
    } else if (current.eta) {
      yield* Console.log(
        lastProgressAge > 15_000
          ? 'Phase ETA: paused while progress is silent.'
          : 'Phase ETA: stabilizing from completed batch output.',
      );
    }
    if (current.result) {
      yield* Console.log(
        `Ready snapshot: ${current.result.snapshotId} · ${current.result.files} files · ` +
          `${current.result.symbols} symbols · ${current.result.edges} edges`,
      );
    }
    if (current.error) yield* Console.log(`Error: ${current.error.summary}`);
    if (selection.waiters.length > 0) {
      yield* Console.log(
        `Waiters: ${selection.waiters.length} process(es) across ${queuedWorktreeIds.length} worktree(s)`,
      );
    }
    if (!current.result) yield* renderReadySnapshotStatus(ready);
    return;
  }
  const status = ready;
  yield* Console.log(`Repository: ${status.identity.displayName}`);
  yield* Console.log(`Database: ${status.databasePath}`);
  yield* renderObsoleteStoreStatus(obsoleteStores);
  yield* renderActiveStorageStatus(storage);
  yield* Console.log(
    `Language packs: ${EffectArray.join(
      EffectArray.map(
        status.languagePacks,
        pack => `${pack.id}@${pack.version} [${EffectArray.join(pack.languages, ', ')}]`,
      ),
      '; ',
    )}`,
  );
  if (!status.readySnapshot) {
    yield* Console.log('Ready snapshot: none');
    return;
  }
  yield* Console.log(
    `Ready snapshot: ${status.readySnapshot.id} · ${status.readySnapshot.fileCount} files · ` +
      `${status.readySnapshot.symbolCount} symbols · ${status.readySnapshot.edgeCount} edges`,
  );
  yield* Console.log(
    `Source: ${Effect2.pipe(status.readySnapshot.commit, EffectString.slice(0, 12))}${status.readySnapshot.dirty ? ' + dirty overlay' : ''} · ${
      status.stale ? 'stale' : 'current'
    }`,
  );
});

function renderObsoleteStoreStatus(inventory: ObsoleteCodeGraphStoreInventory): Effect.Effect<void> {
  if (inventory.fileCount === 0 && inventory.unsafeEntryCount === 0) return Effect.void;
  const versions = EffectArray.flatMap(inventory.checkouts, checkout => checkout.versions);
  const versionSummary = EffectArray.join(
    EffectArray.map(
      [...new Set(versions)].sort((left, right) => left - right),
      version => `v${version}`,
    ),
    ', ',
  );
  return Console.log(
    `Obsolete stores: ${inventory.fileCount} file(s), ${inventory.bytes} byte(s)` +
      (versionSummary ? ` (${versionSummary})` : '') +
      (inventory.unsafeEntryCount > 0
        ? `; ${inventory.unsafeEntryCount} unsafe obsolete-shaped entry/entries require manual review`
        : '') +
      '; remove verified files explicitly with `threadnote graph purge --obsolete`.',
  );
}

function renderActiveStorageStatus(storage: CodeGraphStorage): Effect.Effect<void> {
  if (storage.state === 'missing') return Effect.void;
  return Effect.gen(function* () {
    yield* Console.log(
      `Storage: ${formatBytes(storage.databaseBytes)} database · ${formatBytes(storage.walBytes)} WAL · ` +
        `${formatBytes(storage.journalBytes)} journal · ${formatBytes(storage.shmBytes)} SHM · ` +
        `${formatBytes(storage.temporaryBytes)} TEMP · ${formatBytes(storage.filesystemBytes)} filesystem · ` +
        `${formatBytes(storage.totalBytes)} observed total`,
    );
    if (storage.pageStorage.state === 'deferred') {
      yield* Console.log('Page storage: deferred while an active graph build owns the checkout lock.');
      return;
    }
    if (storage.pageStorage.state === 'unavailable') {
      yield* Console.log(
        'Page storage: unavailable because the database is busy or unreadable; exact file sizes remain valid.',
      );
      return;
    }
    const page = storage.pageStorage;
    yield* Console.log(
      `Reclaimable: ${formatBytes(page.reclaimableBytes)} (${formatPercent(page.reclaimableRatio)}; ` +
        `${page.freelistPages}/${page.pageCount} pages at ${page.pageSize} byte(s)/page)`,
    );
    if (
      page.fragmentedBytes !== undefined &&
      page.fragmentationRatio !== undefined &&
      page.compactionOpportunityBytes !== undefined &&
      page.compactionOpportunityRatio !== undefined
    ) {
      yield* Console.log(
        `Fragmented: ${formatBytes(page.fragmentedBytes)} (${formatPercent(page.fragmentationRatio)}); ` +
          `combined compaction opportunity ${formatBytes(page.compactionOpportunityBytes)} ` +
          `(${formatPercent(page.compactionOpportunityRatio)}).`,
      );
    }
    yield* Console.log(
      `Compaction: ${page.threshold.recommended ? 'recommended' : 'not needed'}; threshold is ` +
        `${formatBytes(page.threshold.minimumReclaimableBytes)} and ` +
        `${formatPercent(page.threshold.minimumReclaimableRatio)} free or fragmented` +
        (page.threshold.reason === 'freelist-and-fragmentation' ? '; fragmentation crossed the threshold.' : '.'),
    );
  });
}

function formatPercent(ratio: number): string {
  return `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;
}

export const runCodeGraphIndex = Effect.fn('codeGraph.command.index')(function* (
  config: RuntimeConfig,
  options: CwdOption &
    ExpectedRepositoryIdentityOption & {
      readonly full?: boolean;
      readonly json?: boolean;
      readonly noVectors?: boolean;
      readonly backgroundVectors?: boolean;
      readonly project?: string;
    },
) {
  const indexer = yield* CodeGraphIndexer;
  const cwd = yield* commandCwd(options.cwd);
  const system = yield* SystemInfo;
  const route = yield* resolveCodeGraphScopeRoute(
    config.manifestPath,
    cwd,
    options.project,
    system.environment()[CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV],
    system.environment()[CODE_GRAPH_REFRESH_SCOPE_ROUTE_ENV] === 'full' ? 'full' : undefined,
  );
  const identity = yield* resolveRepositoryIdentity(cwd);
  if (options.expectedIdentity && !repositoryIdentityMatchesExpectation(identity, options.expectedIdentity)) {
    return yield* CodeGraphCommandError.make({
      message: 'Repository identity does not match the requested graph target.',
    });
  }
  const vectorPolicy = options.noVectors === true ? 'off' : options.backgroundVectors === true ? 'background' : 'wait';
  if (options.json) {
    const reportProgress = yield* makeCodeGraphJsonProgressReporter({
      displayName: identity.displayName,
      repositoryId: identity.repositoryId,
    });
    const summary = yield* indexer.index({
      cwd,
      vectorPolicy,
      ...(options.expectedIdentity ? {expectedIdentity: options.expectedIdentity} : {}),
      force: options.full,
      onProgress: reportProgress,
      ...(route.state === 'selected' ? {project: route.project} : {}),
      threadnoteHome: config.agentContextHome,
    });
    yield* writeFinalCliOutput(JSON.stringify({type: 'code-graph-index', version: 1, ...summary}));
    return;
  }
  yield* Console.log(`Indexing code graph: ${identity.displayName}`);
  const formatProgress = yield* makeCodeGraphHumanProgressReporter();
  const summary = yield* withProgressLine('Scanning repository source from Git.', update =>
    indexer
      .index({
        cwd,
        vectorPolicy,
        ...(options.expectedIdentity ? {expectedIdentity: options.expectedIdentity} : {}),
        force: options.full,
        onProgress: state => formatProgress(state).pipe(Effect.flatMap(update)),
        ...(route.state === 'selected' ? {project: route.project} : {}),
        threadnoteHome: config.agentContextHome,
      })
      .pipe(
        Effect.tap(summary =>
          update(
            `Ready · ${summary.snapshot.fileCount} files · ${summary.snapshot.symbolCount} symbols · ` +
              `${summary.snapshot.edgeCount} edges`,
          ),
        ),
      ),
  );
  yield* Console.log(
    `Code graph ready for ${summary.identity.displayName}: ${summary.snapshot.fileCount} file(s), ` +
      `${summary.snapshot.symbolCount} symbol(s), ${summary.snapshot.edgeCount} relationship(s); ` +
      `${summary.reusedFiles} file(s) reused.`,
  );
  if (summary.semantic !== undefined) yield* Console.log(`Semantic vectors: ${summary.semantic.state}`);
});

export const runCodeGraphWorksetPrepare = Effect.fn('codeGraph.command.worksetPrepare')(function* (
  config: RuntimeConfig,
  options: {readonly concurrency?: number; readonly json?: boolean; readonly name: string},
) {
  const system = yield* SystemInfo;
  const isolateBuilds = system.environment()[CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV] === '1';
  const result = options.json
    ? yield* prepareCodeGraphWorkset(config, options.name, {
        concurrency: options.concurrency,
        isolateBuilds,
        onProgress: yield* makeCodeGraphWorksetJsonProgressReporter(),
      })
    : yield* Effect.acquireUseRelease(
        startProgress(`Preparing workset ${options.name}.`),
        progress =>
          prepareCodeGraphWorkset(config, options.name, {
            concurrency: options.concurrency,
            isolateBuilds,
            onProgress: event => progress.update(event.message),
          }),
        progress => progress.stop.pipe(Effect.ignore),
      );
  if (result.state === 'ready') {
    yield* healAnchorsAfterWorksetPrepare(config, result.workset);
  }
  yield* writeFinalCliOutput(
    options.json
      ? JSON.stringify(result)
      : Effect2.pipe(renderCodeGraphWorksetPrepareResult(result), EffectString.trimEnd),
  );
  if (result.state === 'failed') {
    return yield* CodeGraphCommandError.make({
      message: 'Workset preparation was incomplete; the previous published catalog generation was preserved.',
    });
  }
});

export const runCodeGraphWorksetStatus = Effect.fn('codeGraph.command.worksetStatus')(function* (
  config: RuntimeConfig,
  options: {readonly json?: boolean; readonly name: string},
) {
  const result = yield* inspectCodeGraphWorksetStatus(config, options.name);
  yield* writeFinalCliOutput(
    options.json
      ? JSON.stringify(result)
      : Effect2.pipe(renderCodeGraphWorksetStatusResult(result), EffectString.trimEnd),
  );
});

export function renderCodeGraphWorksetPrepareResult(result: CodeGraphWorksetPrepareResultV1): string {
  const lines = [
    `Workset prepare: ${result.workset}`,
    `State: ${result.state}`,
    `Coverage: ${result.coverage.ready}/${result.coverage.requested} ready (${result.coverage.complete ? 'complete' : 'incomplete'})`,
  ];
  for (const member of result.members) {
    lines.push(
      member.state === 'ready'
        ? `- ${member.project}: ready (${member.symbolCount} routing symbols)`
        : member.state === 'failed'
          ? `- ${member.project}: failed (${member.reason}; ${member.detail.code}; ${member.detail.summary})`
          : `- ${member.project}: ${member.state} (${member.reason})`,
    );
  }
  if (!result.coverage.complete) {
    lines.push(
      `Warning: published coverage is incomplete (${result.coverage.failed} failed, ${result.coverage.missing} missing, ${result.coverage.excluded} excluded).`,
    );
  }
  if (result.bridges !== undefined) {
    lines.push(
      `Bridges: ${result.bridges.state} (${result.bridges.bridgeCount} resolved, ${result.bridges.rejectionCount} rejected, ${result.bridges.monikerCount} monikers)`,
    );
    for (const warning of result.bridges.warnings) lines.push(`Warning: ${warning}`);
  }
  if (result.published !== undefined) lines.push(`Published generation: ${result.published.id}`);
  return `${EffectArray.join(lines, '\n')}\n`;
}

export function renderCodeGraphWorksetStatusResult(result: CodeGraphWorksetStatusResultV1): string {
  const lines = [
    `Workset status: ${result.workset}`,
    `Catalog: ${result.catalog.state}${result.catalog.generation ? ` (${result.catalog.generation.id})` : ''}`,
    `Coverage: ${result.coverage.current}/${result.coverage.requested} current`,
  ];
  if (result.bridges !== undefined) {
    lines.push(
      `Bridges: ${result.bridges.coverage.state} (${result.bridges.bridgeCount} resolved, ${result.bridges.coverage.rejectionCount} rejected)`,
    );
  }
  for (const member of result.members) {
    lines.push(`- ${member.project}: ${member.state}${member.reason ? ` (${member.reason})` : ''}`);
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return `${EffectArray.join(lines, '\n')}\n`;
}

export const runCodeGraphAnalysis = Effect.fn('codeGraph.command.analysis')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly communityId?: string;
    readonly freshness?: CodeGraphCliFreshnessPolicy;
    readonly includeHeuristic?: boolean;
    readonly includeModelAssociations?: boolean;
    readonly json?: boolean;
    readonly memberLimit?: number;
    readonly project?: string;
    readonly readTimeoutMilliseconds?: number;
    readonly view: CodeGraphAnalysisView;
  },
) {
  const budgetMilliseconds = options.readTimeoutMilliseconds ?? CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS;
  const deadline = (yield* Clock.currentTimeMillis) + budgetMilliseconds;
  const cwd = yield* commandCwd(options.cwd);
  const communityId = Effect2.pipe(options.communityId, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (
    options.view === 'community' &&
    !Effect2.pipe(communityId, effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect2.pipe(
            effectOptionalString,
            EffectString.match(/^cgc_[a-f0-9]{32}$/),
            Effect2.Option.getOrElse(() => null),
          ),
    )
  ) {
    return yield* CodeGraphCommandError.make({
      message: 'Community drill-down requires --community-id with a stable cgc_ identifier from graph communities.',
    });
  }
  const freshness = options.freshness ?? 'ready';
  const resolution = yield* analyzeCodeGraphReadIsolated({
    cwd,
    threadnoteHome: config.agentContextHome,
    manifestPath: config.manifestPath,
    project: options.project,
    freshness,
    refresh: true,
    operation: options.view,
    communityId,
    memberLimit: options.memberLimit,
    includeHeuristic: options.includeHeuristic,
    includeModelAssociations: options.includeModelAssociations,
    deadlineMilliseconds: deadline,
  }).pipe(Effect.catchIf(Schema.is(CodeGraphAnalysisReadTimedOut), () => Effect.void));
  if (resolution === undefined || resolution.state !== 'ready') {
    const state = {
      type: 'code-graph-analysis-state',
      version: 1,
      operation: options.view,
      freshnessPolicy: freshness,
      freshness: resolution?.status?.freshness ?? 'unavailable',
      state: resolution?.state ?? 'timed-out',
      reason: resolution?.reason ?? 'read-timeout',
      ...(resolution === undefined ? {budgetMilliseconds} : {}),
      ...(resolution?.status?.readySnapshot === undefined ? {} : {snapshot: resolution.status.readySnapshot}),
      ...(resolution?.state === 'failed' ? {failure: resolution.failure} : {}),
      retryAfterMilliseconds: 1000,
    };
    yield* writeFinalCliOutput(
      options.json
        ? JSON.stringify(state)
        : `Code graph analysis ${state.state}: ${state.reason}${resolution?.state === 'failed' ? ` (${resolution.failure.code}; recovery: ${resolution.failure.recovery})` : ''}. No analysis result was returned. Retry graph analyze with --freshness ready/current or run graph index.`,
    );
    return;
  }
  const status = {
    freshness: resolution.status.freshness,
    freshnessPolicy: freshness,
    repository: {
      displayName: resolution.status.identity.displayName,
      repositoryId: resolution.status.identity.repositoryId,
    },
  };
  const result = resolution.result;
  if (options.json) {
    yield* writeFinalCliOutput(
      JSON.stringify({
        freshness: status.freshness,
        freshnessPolicy: status.freshnessPolicy,
        type: 'code-graph-analysis',
        repository: status.repository,
        result,
        version: 1,
      }),
    );
    return;
  }
  const rendered = Effect2.pipe(
    renderCodeGraphAnalysis(result, options.view),
    EffectString.trimEnd,
    EffectString.split('\n'),
  );
  rendered.splice(1, 0, `Snapshot freshness: ${status.freshness} (requested ${status.freshnessPolicy})`);
  yield* writeFinalCliOutput(EffectArray.join(rendered, '\n'));
});

export const runCodeGraphReport = Effect.fn('codeGraph.command.report')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly includeHeuristic?: boolean;
    readonly includeModelAssociations?: boolean;
    readonly output: string;
    readonly readTimeoutMilliseconds?: number;
  },
) {
  const deadline =
    (yield* Clock.currentTimeMillis) + (options.readTimeoutMilliseconds ?? CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const output = path.resolve(options.output);
  if (yield* fs.exists(output))
    return yield* CodeGraphCommandError.make({message: `Report output already exists: ${output}`});
  const resolution = yield* analyzeCodeGraphReadIsolated({
    cwd,
    threadnoteHome: config.agentContextHome,
    manifestPath: config.manifestPath,
    freshness: 'current',
    refresh: true,
    operation: 'full',
    includeHeuristic: options.includeHeuristic,
    includeModelAssociations: options.includeModelAssociations,
    deadlineMilliseconds: deadline,
  }).pipe(
    Effect.mapError(() =>
      CodeGraphCommandError.make({
        message:
          'The bounded graph report read failed or timed out. No analysis result was returned. Run graph index explicitly, then retry, or rerun with a larger --read-timeout-ms. The report output was not created.',
      }),
    ),
  );
  if (resolution.state !== 'ready')
    return yield* CodeGraphCommandError.make({
      message: `Graph report is ${resolution.state}: ${resolution.reason}${resolution.state === 'failed' ? ` (${resolution.failure.code}; recovery: ${resolution.failure.recovery})` : ''}. The report output was not created.`,
    });
  const status = {
    repository: {
      displayName: resolution.status.identity.displayName,
      repositoryId: resolution.status.identity.repositoryId,
    },
  };
  const result = resolution.result;
  yield* fs.makeDirectory(path.dirname(output), {recursive: true});
  let ownsOutput = false;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(output, {flag: 'wx', mode: 0o600});
      ownsOutput = true;
      yield* file.writeAll(new TextEncoder().encode(renderCodeGraphReport(result, status.repository)));
      yield* file.sync;
    }),
  ).pipe(Effect.onError(() => (ownsOutput ? fs.remove(output, {force: true}).pipe(Effect.ignore) : Effect.void)));
  yield* Console.log(
    `Wrote code graph report for ${status.repository.displayName}: ${output}${
      result.coverage.complete ? '' : ' (partial analysis; see report warnings)'
    }`,
  );
});

export const runCodeGraphInspect = Effect.fn('codeGraph.command.inspect')(function* (
  config: RuntimeConfig,
  options: CwdOption &
    Omit<CodeGraphQueryOptions, 'cwd'> & {
      readonly baseCommit?: string;
      readonly freshness?: CodeGraphCliFreshnessPolicy;
      readonly json?: boolean;
      /** @internal Tests can exercise the foreground timeout without waiting for the public budget. */
      readonly readTimeoutMilliseconds?: number;
      readonly budgetTokens?: number;
      readonly cursor?: string;
      readonly seedQueries?: readonly string[];
      readonly workset?: string;
    },
) {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Keep native optional chaining so the branch narrows `options.workset`.
  if (options.workset?.trim()) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This read uses the value narrowed by the guard above.
    const worksetName = options.workset.trim();
    if (options.operation === 'path') {
      const result = yield* findCodeGraphWorksetPath(config, {
        from: options.from ?? '',
        maxDepth: options.depth,
        maxEdges: options.edgeLimit,
        to: options.to ?? '',
        worksetName,
      });
      yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderCodeGraphWorksetTraversal(result));
      return;
    }
    if (options.operation === 'impact') {
      const query = Effect2.pipe(options.query, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      );
      if (!query) return yield* CodeGraphCommandError.make({message: 'A workset impact trace requires --query.'});
      const result = yield* traceCodeGraphWorksetImpact(config, {
        maxDepth: options.depth,
        maxEdges: options.edgeLimit,
        query,
        worksetName,
      });
      yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderCodeGraphWorksetTraversal(result));
      return;
    }
    if (options.operation !== 'query') {
      return yield* CodeGraphCommandError.make({message: '--workset is valid for graph query, path, and impact.'});
    }
    const cursor = Effect2.pipe(options.cursor, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    const projected = cursor
      ? yield* continueCodeGraphWorksetQueryV2(config, {
          cursor,
          maximumEstimatedTokens: options.budgetTokens,
        })
      : yield* queryCodeGraphWorksetV2(config, {
          depth: options.depth,
          edgeLimit: options.edgeLimit,
          includeHeuristic: options.includeHeuristic,
          includeModelAssociations: options.includeModelAssociations,
          maximumEstimatedTokens: options.budgetTokens,
          nodeLimit: options.nodeLimit,
          packageName: options.packageName,
          query:
            Effect2.pipe(options.query, effectOptionalString =>
              effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
            ) || (yield* CodeGraphCommandError.make({message: 'A workset graph query requires --query or --cursor.'})),
          worksetName,
        });
    yield* writeFinalCliOutput(
      options.json ? JSON.stringify(projected.structuredContent) : Effect2.pipe(projected.text, EffectString.trimEnd),
    );
    return;
  }
  if (
    Effect2.pipe(options.cursor, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) ||
    options.budgetTokens !== undefined
  ) {
    return yield* CodeGraphCommandError.make({message: '--cursor and --budget-tokens require --workset.'});
  }
  if (
    options.operation === 'query' &&
    !Effect2.pipe(options.query, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  ) {
    return yield* CodeGraphCommandError.make({message: 'A graph query requires --query.'});
  }
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Keep optional-chain narrowing for the qualified node identifier.
  const qualifiedTarget = options.nodeId?.startsWith('cgr_')
    ? yield* resolveCodeGraphQualifiedRefTarget(config, options.nodeId, options.cwd, options.project)
    : undefined;
  const effectiveOptions =
    qualifiedTarget === undefined ? options : {...options, cwd: qualifiedTarget.cwd, nodeId: qualifiedTarget.nodeId};
  const service = yield* CodeGraphQueryService;
  const cwd = yield* commandCwd(effectiveOptions.cwd);
  const freshness = options.freshness ?? defaultCodeGraphCliFreshness(options.operation);
  const initialStatus = yield* service.status(config.agentContextHome, cwd, {
    manifestPath: config.manifestPath,
    ...(options.project === undefined ? {} : {project: options.project}),
  });
  const {borrowedContinuity, readPlan, status, statusObservation} = yield* resolveCodeGraphCliReadContinuity(
    config,
    service,
    initialStatus,
    options.operation,
    freshness,
  );
  if (readPlan.unavailable) {
    const unavailable = codeGraphCliReadState(status, freshness, options.operation, 'no-ready-snapshot');
    yield* writeFinalCliOutput(
      options.json
        ? JSON.stringify(unavailable)
        : Effect2.pipe(renderCodeGraphCliReadState(unavailable), EffectString.trimEnd),
    );
    return;
  }
  const inspect = (
    plan: CodeGraphCliReadPlan,
    reuseStatusObservation: boolean,
    onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>,
  ) =>
    service.inspect({
      ...effectiveOptions,
      cwd,
      manifestPath: config.manifestPath,
      onProgress,
      refresh: plan.refresh,
      ...(reuseStatusObservation ? {statusObservation} : {}),
      strictFreshness: plan.strictFreshness,
      threadnoteHome: config.agentContextHome,
    });
  const reportProgress = effectiveOptions.json ? yield* makeCodeGraphJsonProgressReporter() : undefined;
  const formatProgress = effectiveOptions.json ? undefined : yield* makeCodeGraphHumanProgressReporter();
  const read = readCodeGraphCliWithContinuity({borrowedContinuity, readPlan}, (plan, reuseStatusObservation) =>
    effectiveOptions.json
      ? inspect(plan, reuseStatusObservation, reportProgress)
      : plan.refresh
        ? withProgressLine('Scanning repository source from Git.', update =>
            inspect(plan, reuseStatusObservation, state => formatProgress!(state).pipe(Effect.flatMap(update))),
          )
        : inspect(plan, reuseStatusObservation),
  );
  const readTimeoutMilliseconds = options.readTimeoutMilliseconds ?? CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS;
  const result = yield* read.pipe(
    Effect.asSome,
    Effect.timeoutOrElse({
      duration: readTimeoutMilliseconds,
      orElse: () => Effect.succeedNone,
    }),
  );
  if (Option.isNone(result)) {
    const timedOut = codeGraphCliReadState(
      status,
      freshness,
      options.operation,
      'read-timeout',
      readTimeoutMilliseconds,
    );
    yield* writeFinalCliOutput(
      options.json
        ? JSON.stringify(timedOut)
        : Effect2.pipe(renderCodeGraphCliReadState(timedOut), EffectString.trimEnd),
    );
    return;
  }
  const output = result.value.borrowedContinuity
    ? {
        ...result.value.result,
        warnings: [
          ...result.value.result.warnings,
          'Serving compatible shared graph evidence. Run graph index to create a current snapshot for this worktree.',
        ],
      }
    : result.value.result;
  yield* writeFinalCliOutput(
    options.json ? JSON.stringify(output) : Effect2.pipe(renderCodeGraphResult(output), EffectString.trimEnd),
  );
});

export const runCodeGraphWorksetTopology = Effect.fn('codeGraph.command.worksetTopology')(function* (
  config: RuntimeConfig,
  options: {
    readonly edgeLimit?: number;
    readonly json?: boolean;
    readonly nodeLimit?: number;
    readonly workset: string;
  },
) {
  const result = yield* inspectCodeGraphWorksetTopology(config, {
    maxEdges: options.edgeLimit,
    maxNodes: options.nodeLimit,
    worksetName: options.workset,
  });
  yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderCodeGraphWorksetTopology(result));
});

export function renderCodeGraphWorksetTraversal(result: CodeGraphCrossRepositoryTraversalResultV1): string {
  const lines = [
    `Workset ${result.direction === 'forward' ? 'path' : 'impact'}: ${result.generationId}`,
    `Stop: ${result.stop.reason}${result.stop.complete ? ' (complete)' : ' (partial)'}`,
    `Coverage: ${result.coverage.endpointsVisited} endpoints, ${result.coverage.acceptedLocalEdges} local edges, ${result.coverage.acceptedBridgeEdges} bridges`,
  ];
  for (const edge of result.edges) {
    lines.push(
      `- ${traversalEndpointLabel(edge.source)} --${edge.relation}/${edge.provenance.kind}--> ${traversalEndpointLabel(edge.target)}`,
    );
  }
  return `${EffectArray.join(lines, '\n')}\n`;
}

export function renderCodeGraphWorksetTopology(result: CodeGraphWorksetTopologyResultV1): string {
  const lines = [`Workset topology: ${result.workset}`, `State: ${result.state}`];
  if (result.bridgeSet !== undefined) {
    lines.push(
      `Bridges: ${result.bridgeSet.bridgeCount} (${result.bridgeSet.coverage.state}; generation ${result.bridgeSet.generationId})`,
    );
  }
  if (result.topology !== undefined) {
    lines.push(
      `Topology: ${result.topology.nodes.length} nodes, ${result.topology.edges.length} aggregate edges${result.topology.coverage.complete ? '' : ' (partial)'}`,
    );
    for (const edge of result.topology.edges) {
      lines.push(`- ${edge.sourceNodeId} -> ${edge.targetNodeId}: ${edge.bridgeCount} declared bridge(s)`);
    }
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return `${EffectArray.join(lines, '\n')}\n`;
}

function traversalEndpointLabel(endpoint: CodeGraphCrossRepositoryTraversalResultV1['visited'][number]): string {
  return `${endpoint.repositoryKey}:${
    endpoint.reference.kind === 'component' ? endpoint.reference.componentId : endpoint.reference.ref
  }`;
}

export const runCodeGraphImpact = Effect.fn('codeGraph.command.impact')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly base?: string;
    readonly depth?: number;
    readonly edgeLimit?: number;
    readonly json?: boolean;
    readonly nodeLimit?: number;
    readonly project?: string;
    readonly query?: string;
    readonly workset?: string;
  },
) {
  if (
    Effect2.pipe(options.workset, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  ) {
    if (
      !Effect2.pipe(options.query, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      )
    ) {
      return yield* CodeGraphCommandError.make({
        message: 'A workset impact trace requires --query with a qualified endpoint.',
      });
    }
    yield* runCodeGraphInspect(config, {...options, operation: 'impact'});
    return;
  }
  const cwd = yield* commandCwd(options.cwd);
  const changes = Effect2.pipe(options.query, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  )
    ? undefined
    : yield* repositoryChangesSince(cwd, options.base ?? 'HEAD~1');
  const input =
    Effect2.pipe(options.query, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) || EffectArray.join(changes!.paths, ' ');
  yield* runCodeGraphInspect(config, {
    ...options,
    baseCommit: changes?.baseCommit,
    cwd,
    operation: 'impact',
    query: input,
    seedQueries: changes?.paths,
  });
});

export const runCodeGraphPurge = Effect.fn('codeGraph.command.purge')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly all?: boolean;
    readonly apply?: boolean;
    readonly approval?: string;
    readonly checkoutId?: string;
    readonly dryRun?: boolean;
    readonly json?: boolean;
    readonly obsolete?: boolean;
    readonly snapshotId?: string;
    readonly waitTimeoutMilliseconds?: number;
  },
) {
  const path = yield* Path.Path;
  if (options.all && (options.checkoutId !== undefined || options.obsolete || options.snapshotId !== undefined)) {
    return yield* CodeGraphCommandError.make({
      message: 'Use --all by itself, without --checkout-id, --obsolete, or --snapshot-id.',
    });
  }
  if (options.checkoutId !== undefined && options.cwd !== undefined) {
    return yield* CodeGraphCommandError.make({message: 'Use either --checkout-id or --cwd, not both.'});
  }
  if (options.snapshotId !== undefined) {
    if (options.obsolete || options.all || options.dryRun) {
      return yield* CodeGraphCommandError.make({message: 'Use --snapshot-id without --all, --obsolete, or --dry-run.'});
    }
    const snapshotId = options.snapshotId;
    let checkoutId = options.checkoutId;
    if (checkoutId === undefined) {
      const cwd = yield* commandCwd(options.cwd);
      checkoutId = (yield* resolveRepositoryIdentity(cwd)).checkoutId;
    }
    const result = options.json
      ? yield* purgeCodeGraphSnapshot(
          config.agentContextHome,
          {checkoutId, snapshotId},
          {apply: options.apply === true, approvalDigest: options.approval},
        )
      : yield* withProgressLine(formatCodeGraphPurgeProgressLine({phase: 'acquiring-gates'}), () =>
          purgeCodeGraphSnapshot(
            config.agentContextHome,
            {checkoutId, snapshotId},
            {apply: options.apply === true, approvalDigest: options.approval},
          ),
        );
    yield* writeFinalCliOutput(
      options.json ? serializeCodeGraphSnapshotPurgeResult(result) : renderCodeGraphSnapshotPurgeResult(result),
    );
    const failure = codeGraphSnapshotPurgeTargetFailure(result);
    if (failure) return yield* Effect.fail(failure);
    return;
  }
  if (options.apply || options.approval !== undefined || options.json) {
    return yield* CodeGraphCommandError.make({message: 'Use --apply, --approval, or --json only with --snapshot-id.'});
  }
  if (options.obsolete) {
    let checkoutId = options.checkoutId;
    if (checkoutId === undefined) {
      const cwd = yield* commandCwd(options.cwd);
      checkoutId = (yield* resolveRepositoryIdentity(cwd)).checkoutId;
    }
    const targetCheckoutId = checkoutId;
    const summary = yield* withProgressLine(
      formatCodeGraphPurgeProgressLine({dryRun: options.dryRun === true, phase: 'acquiring-gates'}),
      update =>
        purgeObsoleteCodeGraphStores(config.agentContextHome, targetCheckoutId, {
          dryRun: options.dryRun === true,
          onProgress: progress => update(formatCodeGraphPurgeProgressLine(progress)),
        }),
    );
    const action = options.dryRun ? 'Would remove' : 'Removed';
    yield* Console.log(
      `${action} ${summary.fileCount} verified obsolete code graph file(s), ${summary.bytes} byte(s), ` +
        `from checkout ${Effect2.pipe(summary.checkoutId, EffectString.slice(0, 12))}` +
        (summary.versions.length > 0
          ? ` (schema ${EffectArray.join(
              EffectArray.map(summary.versions, version => `v${version}`),
              ', ',
            )})`
          : '') +
        '.',
    );
    return;
  }
  if (options.all) {
    const root = path.join(config.agentContextHome, 'indexes', 'code-graph');
    if (options.dryRun) {
      yield* Console.log(`Would remove derived code graph indexes: ${root}`);
      return;
    }
    const removed = yield* withProgressLine(formatCodeGraphPurgeProgressLine({phase: 'acquiring-gates'}), update =>
      purgeAllCodeGraphIndexes(config.agentContextHome, progress => update(formatCodeGraphPurgeProgressLine(progress))),
    );
    yield* Console.log(`Removed derived code graph indexes: ${removed}`);
    return;
  }
  if (options.checkoutId !== undefined) {
    const checkoutId = options.checkoutId;
    const summary = yield* withProgressLine(
      formatCodeGraphPurgeProgressLine({dryRun: options.dryRun === true, phase: 'acquiring-gates'}),
      update =>
        purgeCodeGraphIndex(config.agentContextHome, checkoutId, {
          dryRun: options.dryRun === true,
          onProgress: progress => update(formatCodeGraphPurgeProgressLine(progress)),
          waitTimeoutMilliseconds: options.waitTimeoutMilliseconds,
        }),
    );
    if (!summary.existed) {
      yield* Console.log(
        `No derived code graph index exists for checkout ${Effect2.pipe(summary.checkoutId, EffectString.slice(0, 12))}.`,
      );
      return;
    }
    yield* Console.log(
      `${options.dryRun ? 'Would remove' : 'Removed'} derived code graph index for checkout ${Effect2.pipe(summary.checkoutId, EffectString.slice(0, 12))}.`,
    );
    return;
  }
  const service = yield* CodeGraphQueryService;
  const cwd = yield* commandCwd(options.cwd);
  if (options.dryRun) {
    const status = yield* service.status(config.agentContextHome, cwd);
    yield* Console.log(`Would remove derived code graph indexes: ${path.dirname(status.databasePath)}`);
    return;
  }
  const repositoryRoot = yield* withProgressLine(formatCodeGraphPurgeProgressLine({phase: 'acquiring-gates'}), update =>
    service.purge(config.agentContextHome, cwd, progress => update(formatCodeGraphPurgeProgressLine(progress))),
  );
  yield* Console.log(`Removed derived code graph indexes: ${repositoryRoot}`);
});

export const runCodeGraphRemoveView = Effect.fn('codeGraph.command.removeView')(function* (
  config: RuntimeConfig,
  options: {
    readonly apply?: boolean;
    readonly checkoutId: string;
    readonly json?: boolean;
    readonly snapshotId: string;
    readonly worktreeId: string;
  },
) {
  const path = yield* Path.Path;
  const maintenance = yield* CodeGraphMaintenanceCoordinator;
  const layout = codeGraphLayout(path, config.agentContextHome, options.checkoutId, options.worktreeId);
  const result = yield* removeCodeGraphView(
    config.agentContextHome,
    {
      checkoutId: options.checkoutId,
      snapshotId: options.snapshotId,
      worktreeId: options.worktreeId,
    },
    {
      afterRemoval: input =>
        maintenance
          .kickResidual({
            checkoutId: input.checkoutId,
            databasePath: input.databasePath,
            threadnoteHome: input.threadnoteHome,
            writerLockPath: layout.databaseWriteLockPath,
          })
          .pipe(Effect.asVoid),
      apply: options.apply === true,
    },
  );
  yield* writeFinalCliOutput(
    options.json ? serializeCodeGraphViewRemovalResult(result) : renderCodeGraphViewRemovalResult(result),
  );
  const targetFailure = codeGraphViewRemovalTargetFailure(result);
  if (targetFailure) return yield* Effect.fail(targetFailure);
});

export const runCodeGraphCompact = Effect.fn('codeGraph.command.compact')(function* (
  config: RuntimeConfig,
  options: CwdOption &
    ExpectedRepositoryIdentityOption & {readonly dryRun?: boolean; readonly force?: boolean; readonly json?: boolean},
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  if (options.expectedIdentity && !repositoryIdentityMatchesExpectation(identity, options.expectedIdentity)) {
    return yield* CodeGraphCommandError.make({
      message: 'Repository identity does not match the requested graph target.',
    });
  }
  const summary = options.json
    ? yield* compactCodeGraphStorage(config.agentContextHome, identity.checkoutId, {
        dryRun: options.dryRun === true,
        force: options.force,
      })
    : yield* withProgressLine(formatCodeGraphCompactProgressLine('inspecting'), update =>
        compactCodeGraphStorage(config.agentContextHome, identity.checkoutId, {
          dryRun: options.dryRun === true,
          force: options.force,
          onProgress: phase => update(formatCodeGraphCompactProgressLine(phase)),
        }),
      );
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify({type: 'code-graph-compaction', version: 1, ...summary}));
    return;
  }
  switch (summary.action) {
    case 'deferred':
      yield* Console.log(
        `Code graph compaction deferred: ${
          summary.reason === 'active-build'
            ? 'an active build owns this checkout'
            : 'another maintenance task is active'
        }.`,
      );
      return;
    case 'missing':
      yield* Console.log('No active code graph database exists for this checkout.');
      return;
    case 'not-needed':
      yield* Console.log('Code graph compaction is below the reviewed reclaimable-space threshold.');
      if (summary.before) yield* renderActiveStorageStatus(summary.before);
      return;
    case 'would-compact':
      yield* Console.log(
        `Would compact the active code graph and reclaim about ${formatBytes(summary.reclaimedBytes)}.`,
      );
      if (summary.before) yield* renderActiveStorageStatus(summary.before);
      return;
    case 'compacted':
      yield* Console.log(`Compacted the active code graph and reclaimed ${formatBytes(summary.reclaimedBytes)}.`);
      if (summary.after) yield* renderActiveStorageStatus(summary.after);
  }
});

export const runCodeGraphExport = Effect.fn('codeGraph.command.export')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly edgeLimit?: CodeGraphExportLimit | string;
    readonly format: CodeGraphExportFormat;
    readonly interlock?: CodeGraphExportInterlock;
    readonly nodeLimit?: CodeGraphExportLimit | string;
    readonly output: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const identity = yield* resolveRepositoryIdentity(yield* commandCwd(options.cwd));
  const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
  const store = yield* CodeGraphStore;
  const snapshot = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
  if (!snapshot) {
    return yield* CodeGraphCommandError.make({
      message: 'No ready native code graph snapshot exists. Run `threadnote graph index` before exporting.',
    });
  }
  const output = path.resolve(options.output);
  if (yield* fs.exists(output))
    return yield* CodeGraphCommandError.make({message: `Export output already exists: ${output}`});
  yield* options.interlock?.afterOutputCheck?.() ?? Effect.void;
  const edgeLimit = yield* parseCodeGraphExportLimit(options.edgeLimit, '--edge-limit');
  const nodeLimit = yield* parseCodeGraphExportLimit(options.nodeLimit, '--node-limit');
  const parent = path.dirname(output);
  yield* fs.makeDirectory(parent, {recursive: true});
  const temporary = path.join(parent, `.${path.basename(output)}.${yield* crypto.randomUUIDv4()}.tmp`);
  const summary = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
      return yield* Effect.gen(function* () {
        const encoder = new TextEncoder();
        const rendered = yield* exportCodeGraph({
          databasePath: layout.databasePath,
          ...(edgeLimit === undefined ? {} : {edgeLimit}),
          format: options.format,
          ...(nodeLimit === undefined ? {} : {nodeLimit}),
          repository: {displayName: identity.displayName, repositoryId: identity.repositoryId},
          snapshotId: snapshot.id,
          write: content => file.writeAll(encoder.encode(content)),
        });
        yield* file.sync;
        // Capture the final stable metadata only after every byte and its metadata have reached the file.
        const publicationIdentity = yield* requireExportTemporaryIdentity(file);
        yield* verifyOwnedExportTemporary(fs, temporary, publicationIdentity);
        yield* options.interlock?.beforePublish?.(temporary) ?? Effect.void;
        yield* verifyOwnedExportTemporary(fs, temporary, publicationIdentity);
        yield* options.interlock?.beforeLink?.(temporary) ?? Effect.void;
        const linked = yield* fs.link(temporary, output).pipe(Effect.result);
        if (linked._tag === 'Failure') {
          if (yield* fs.exists(output)) {
            return yield* CodeGraphCommandError.make({message: `Export output already exists: ${output}`});
          }
          return yield* linked.failure;
        }
        yield* verifyPublishedExportOutput(fs, output, publicationIdentity);
        yield* syncExportDirectory(fs, parent);
        yield* removeOwnedExportTemporary(fs, temporary, publicationIdentity);
        yield* syncExportDirectory(fs, parent);
        return rendered;
      }).pipe(
        // The descriptor stays open through verification and publication, preventing inode reuse in that window.
        Effect.ensuring(removeOpenedExportTemporary(fs, temporary, file)),
      );
    }),
  );
  yield* Console.log(
    `Exported ${summary.nodes.written} node(s) and ${summary.edges.written} relationship(s) as ${summary.format}: ${output}`,
  );
});

function commandCwd(value: string | undefined) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return path.resolve(
      Effect2.pipe(value, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || system.currentDirectory(),
    );
  });
}

function parseCodeGraphExportLimit(
  value: CodeGraphExportLimit | string | undefined,
  flag: '--edge-limit' | '--node-limit',
): Effect.Effect<CodeGraphExportLimit | undefined, Error> {
  if (value === undefined || value === 'all') return Effect.succeed(value);
  const parsed = typeof value === 'number' ? value : Number(Effect2.pipe(value, EffectString.trim));
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    (typeof value === 'string' && !/^\d+$/.test(Effect2.pipe(value, EffectString.trim)))
  ) {
    return Effect.fail(CodeGraphCommandError.make({message: `${flag} must be "all" or a non-negative safe integer.`}));
  }
  return Effect.succeed(parsed);
}

function verifyOwnedExportTemporary(
  fs: FileSystem.FileSystem,
  temporary: string,
  expected: CodeGraphExportTemporaryIdentity,
) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(temporary).pipe(Effect.option))) {
      return yield* CodeGraphCommandError.make({message: 'Export temporary path was replaced by a symbolic link.'});
    }
    const current = yield* exportTemporaryIdentityAtPath(fs, temporary);
    if (Option.isNone(current) || !sameExportFile(expected, current.value)) {
      return yield* CodeGraphCommandError.make({
        message: 'Export temporary path no longer identifies the private output file.',
      });
    }
  });
}

function verifyPublishedExportOutput(
  fs: FileSystem.FileSystem,
  output: string,
  expected: CodeGraphExportTemporaryIdentity,
) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(output).pipe(Effect.option))) {
      yield* fs.remove(output, {force: true});
      return yield* CodeGraphCommandError.make({message: 'Export publication did not link the private output file.'});
    }
    const identity = yield* exportTemporaryIdentityAtPath(fs, output);
    if (
      Option.isSome(identity) &&
      sameExportFile(expected, identity.value) &&
      Option.isNone(yield* fs.readLink(output).pipe(Effect.option))
    ) {
      return;
    }
    if (Option.isSome(yield* fs.readLink(output).pipe(Effect.option))) {
      yield* fs.remove(output, {force: true});
      return yield* CodeGraphCommandError.make({message: 'Export publication did not link the private output file.'});
    }
    if (Option.isSome(identity)) yield* removeOwnedExportTemporary(fs, output, identity.value);
    return yield* CodeGraphCommandError.make({message: 'Export publication did not link the private output file.'});
  });
}

function removeOwnedExportTemporary(
  fs: FileSystem.FileSystem,
  temporary: string,
  expected: CodeGraphExportTemporaryIdentity,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(temporary).pipe(Effect.option))) return;
    const currentIdentity = yield* exportTemporaryIdentityAtPath(fs, temporary);
    if (Option.isSome(currentIdentity) && sameExportFile(expected, currentIdentity.value)) {
      yield* fs.remove(temporary, {force: true});
    }
  }).pipe(Effect.ignore);
}

function removeOpenedExportTemporary(
  fs: FileSystem.FileSystem,
  temporary: string,
  file: FileSystem.File,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const identity = yield* exportTemporaryIdentityFromFile(file);
    if (Option.isSome(identity)) yield* removeOwnedExportTemporary(fs, temporary, identity.value);
  }).pipe(Effect.ignore);
}

function requireExportTemporaryIdentity(file: FileSystem.File) {
  return Effect.flatMap(exportTemporaryIdentityFromFile(file), identity =>
    Effect.fromOption(identity, () =>
      CodeGraphCommandError.make({
        message: 'Export temporary file has insufficient identity metadata for safe publication.',
      }),
    ),
  );
}

function exportTemporaryIdentity(info: FileSystem.File.Info): Option.Option<CodeGraphExportTemporaryIdentity> {
  const birthtime = Option.getOrUndefined(info.birthtime);
  const ino = Option.getOrUndefined(info.ino);
  const modifiedAt = Option.getOrUndefined(info.mtime);
  return info.type !== 'File' || birthtime === undefined || ino === undefined || modifiedAt === undefined
    ? Option.none()
    : Option.some({
        birthtimeMilliseconds: birthtime.getTime(),
        dev: String(info.dev),
        ino: String(ino),
        mode: info.mode,
        modifiedAtMilliseconds: modifiedAt.getTime(),
        size: info.size,
      });
}

function nativeExportTemporaryIdentity(stat: RuntimeNativeFileStat): Option.Option<CodeGraphExportTemporaryIdentity> {
  if (!stat.isFile() || stat.ino <= 0n) return Option.none();
  const birthtimeMilliseconds = stat.birthtime.getTime();
  const modifiedAtMilliseconds = stat.mtime.getTime();
  const mode = Number(stat.mode);
  if (
    !Number.isFinite(birthtimeMilliseconds) ||
    !Number.isFinite(modifiedAtMilliseconds) ||
    !Number.isSafeInteger(mode)
  ) {
    return Option.none();
  }
  return Option.some({
    birthtimeMilliseconds,
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode,
    modifiedAtMilliseconds,
    size: stat.size,
  });
}

function exportTemporaryIdentityFromFile(file: FileSystem.File) {
  return Effect.gen(function* () {
    if (runtimePlatform !== 'win32') return exportTemporaryIdentity(yield* file.stat);
    // Effect's File.Info stores inode numbers as safe JS numbers. Windows file
    // IDs can exceed that range, so compare the open descriptor's native ID.
    const fd = 'fd' in file ? file.fd : undefined;
    if (typeof fd !== 'number' || !Number.isSafeInteger(fd)) return Option.none();
    return yield* Effect.sync(() => {
      try {
        return nativeExportTemporaryIdentity(runtimeFileDescriptorStatSync(fd));
      } catch {
        return Option.none();
      }
    });
  });
}

function exportTemporaryIdentityAtPath(fs: FileSystem.FileSystem, path: string) {
  return Effect.gen(function* () {
    if (runtimePlatform !== 'win32') {
      const info = yield* fs.stat(path).pipe(Effect.option);
      return Option.flatMap(info, exportTemporaryIdentity);
    }
    return yield* Effect.sync(() => {
      try {
        return nativeExportTemporaryIdentity(runtimePathStatSync(path));
      } catch {
        return Option.none();
      }
    });
  });
}

function sameExportFile(
  expected: CodeGraphExportTemporaryIdentity,
  current: CodeGraphExportTemporaryIdentity,
): boolean {
  return (
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    expected.size === current.size &&
    expected.mode === current.mode &&
    expected.modifiedAtMilliseconds === current.modifiedAtMilliseconds &&
    expected.birthtimeMilliseconds === current.birthtimeMilliseconds
  );
}

function syncExportDirectory(fs: FileSystem.FileSystem, directory: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(directory, {flag: 'r'}).pipe(
      Effect.flatMap(file => file.sync),
      Effect.ignore,
    ),
  );
}
