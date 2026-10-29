import {Array as EffectArray} from 'effect';
import {Clock, Crypto, DateTime, Effect, FileSystem, Option, Path, PlatformError, Ref, Schema, Semaphore} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readExclusiveFileLockOwner, type FileLockOwner} from '@threadnote/platform/file/lock';
import {runtimeTextDirectoryNamePage, SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import type {CodeGraphBuildOwnerIdentity} from './build/owner.js';
import {codeGraphBuildStatusError, parseCodeGraphBuildStatus} from './build_status/codec.js';
import {sameProcessOwner} from './build_status/coordination.js';
import {
  annotateBuildCoordinationByWorktree,
  annotateCheckoutBuildCoordination,
} from './build_status/coordination_reader.js';
import {codeGraphProgressTimings} from './build_status/timings.js';
import {
  accountCodeGraphBuildScheduling,
  observeCodeGraphBuildAdmission,
  observeCodeGraphBuildResource,
} from './build_status/scheduling.js';
import type {CodeGraphBuilderAdmissionQueue} from './builder/admission_scheduler.js';
import {
  CODE_GRAPH_BUILD_HASH_ID as HASH_ID,
  CODE_GRAPH_BUILD_ID as BUILD_ID,
  CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION,
  codeGraphFailedBuildStatusRemovable,
  isBuildStatusRecord as isRecord,
  isBuildStatusText as isText,
} from './build_status/validation.js';
import {classifyCodeGraphLifecycle, type CodeGraphLifecycleProtection} from './lifecycle/classification.js';
import {codeGraphRepositoriesRoot, type CodeGraphLayout} from './layout.js';
import {codeGraphScopeViewKey} from './scope/identity.js';
import {
  codeGraphEtaMeasurement,
  estimateCodeGraphEta,
  makeCodeGraphEtaTracker,
  observeCodeGraphEta,
  type CodeGraphEtaTracker,
} from './progress/eta.js';
export {calibratedCodeGraphEtaConfidence} from './progress/eta.js';
import {
  CODE_GRAPH_SLOW_FILE_THRESHOLD_MILLISECONDS,
  CODE_GRAPH_TOP_SLOW_FILE_LIMIT,
  codeGraphPathExtension,
  codeGraphSourceSizeBucket,
  retainCodeGraphSlowFileTelemetry,
} from './progress/telemetry.js';
import {
  type CodeGraphOverlayFallbackReason,
  type CodeGraphProgress,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from './types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import type {
  CodeGraphBuildCounters,
  CodeGraphBuildActivity,
  CodeGraphBuildExtraction,
  CodeGraphBuildMaterialization,
  CodeGraphBuildActivation,
  CodeGraphBuildResolution,
  CodeGraphBuildRegistration,
  CodeGraphBuildStatus,
  ObservedCodeGraphBuildStatus,
  CodeGraphBuildReporter,
  CodeGraphBuildHistoryPruneResult,
  CodeGraphBuildHistoryPruneOptions,
} from './build_status/contracts.js';
export type {
  CodeGraphBuildCounters,
  CodeGraphBuildState,
  CodeGraphBuildLiveness,
  CodeGraphBuildActivity,
  CodeGraphBuildExtraction,
  CodeGraphBuildTimings,
  CodeGraphBuildMaterialization,
  CodeGraphBuildCapacityFailure,
  CodeGraphBuildError,
  CodeGraphBuildActivation,
  CodeGraphBuildResolution,
  CodeGraphBuildRegistration,
  CodeGraphBuildStatus,
  ObservedCodeGraphBuildStatus,
  CodeGraphBuildStatusSelection,
  CodeGraphBuildReporter,
  CodeGraphBuildOwnerStatusCorroboration,
  CodeGraphBuildHistoryPruneResult,
  CodeGraphBuildHistoryPruneOptions,
} from './build_status/contracts.js';
import {compareObservedBuildStatus} from './build_status/selection.js';
export {selectCodeGraphBuildStatuses} from './build_status/selection.js';
export {codeGraphBuildStatusError, parseCodeGraphBuildStatus} from './build_status/codec.js';
export {CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION} from './build_status/validation.js';
export const CODE_GRAPH_BUILD_HEARTBEAT_INTERVAL_MILLISECONDS = 2_000;
export const CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS = 250;
export const CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS = 15_000;

class CodeGraphBuildStatusError extends Schema.TaggedError<
  CodeGraphBuildStatusError,
  {readonly brand: unique symbol}
>()('CodeGraphBuildStatusError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

interface ReporterState {
  readonly accountedAtMilliseconds: number;
  readonly etaTracker: CodeGraphEtaTracker;
  readonly lastPersistedAtMilliseconds: number;
  readonly status: CodeGraphBuildStatus;
}

interface ProcessObservation {
  readonly isRunning: boolean;
  readonly nowMilliseconds: number;
  readonly processStartIdentity?: string;
}

const STATUS_DIRECTORY = 'build-status';
const STATUS_FILE_BYTES_LIMIT = 64 * 1_024;
const STATUS_HISTORY_PER_WORKTREE = 8;
const BUILD_HISTORY_CURSOR_FILE = '.history-prune-cursor';
const BUILD_HISTORY_CURSOR_TEMPORARY_FILE = '.history-prune-cursor.tmp';
const BUILD_HISTORY_CURSOR_FILE_BYTES_LIMIT = 256;
const BUILD_HISTORY_CURSOR_SCHEMA_VERSION = 1 as const;
export const CODE_GRAPH_BUILD_HISTORY_STATUS_LIMIT = 10_000;
/** Paired status/context files plus the durable cursor and its recoverable temporary. */
export const CODE_GRAPH_BUILD_HISTORY_DIRECTORY_ENTRY_LIMIT = CODE_GRAPH_BUILD_HISTORY_STATUS_LIMIT * 2 + 2;
/** Primary status reads plus two exact status/context rechecks stay below 2 MiB. */
export const CODE_GRAPH_BUILD_HISTORY_STATUS_PAGE_LIMIT = 29;
const MANAGER_CONTEXT_FILE_BYTES_LIMIT = 8 * 1_024;
const MANAGER_CONTEXT_SCHEMA_VERSION = 1 as const;
const BUILD_HISTORY_INVALID_RETRY_MILLISECONDS = 30_000;
const BUILD_HISTORY_IO_RETRY_MILLISECONDS = 1_000;
const BUILD_STATUS_FILE = /^([0-9a-f-]{16,64})\.json$/;
const BUILD_STATUS_VIEW_DIRECTORY = /^[0-9a-f]{64}(?:\.scope-[0-9a-f]{64})?$/;

export const makeCodeGraphBuildReporter = Effect.fn('codeGraph.buildStatus.makeReporter')(function* (
  identity: RepositoryIdentity,
  layout: CodeGraphLayout,
  request?: {readonly key: string},
  historyPruneOptions: CodeGraphBuildHistoryPruneOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const buildId = Effect2.pipe(yield* crypto.randomUUIDv4(), EffectString.toLowerCase);
  const pathHashSalt = Effect2.pipe(yield* crypto.randomUUIDv4(), EffectString.toLowerCase);
  const startedAtMilliseconds = yield* Clock.currentTimeMillis;
  const startedAt = DateTime.formatIso(DateTime.makeUnsafe(startedAtMilliseconds));
  const processStartIdentity = yield* system.processStartIdentity(system.processId);
  const file = codeGraphBuildStatusPath(path, layout, identity.worktreeId, buildId);
  let writeSequence = 0;
  const reporterHistoryAuthority = {
    current: undefined as BuildHistoryDirectoryAuthority | undefined,
  };
  const state = yield* Ref.make<ReporterState>({
    accountedAtMilliseconds: startedAtMilliseconds,
    etaTracker: makeCodeGraphEtaTracker(),
    lastPersistedAtMilliseconds: 0,
    status: {
      buildId,
      counters: {},
      identity: {
        checkoutId: identity.checkoutId,
        commit: Effect2.pipe(identity.headCommit, EffectString.slice(0, 12)),
        displayName: boundedText(identity.displayName, 256),
        repositoryId: identity.repositoryId,
        ...(layout.scopeId === undefined ? {} : {scopeId: layout.scopeId}),
        worktreeId: identity.worktreeId,
      },
      owner: {
        processId: system.processId,
        ...(processStartIdentity ? {processStartIdentity} : {}),
        runtime: 'bun',
        runtimeVersion: boundedText(system.runtimeVersion, 64),
      },
      phase: 'registering',
      ...(request ? {request} : {}),
      schemaVersion: CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION,
      scheduling: {phaseMilliseconds: {}, waitMilliseconds: {}},
      state: 'running',
      subphase: 'registration',
      worktreeLockHeld: false,
      timestamps: {
        heartbeatAt: startedAt,
        lastProgressAt: startedAt,
        phaseStartedAt: startedAt,
        startedAt,
        updatedAt: startedAt,
      },
    },
  });
  const semaphore = yield* Semaphore.make(1);
  const persist = (
    update: (current: ReporterState, now: number) => ReporterState,
    force: boolean | ((current: ReporterState) => boolean),
  ) =>
    semaphore
      .withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const current = yield* Ref.get(state);
          const shouldForce = typeof force === 'function' ? force(current) : force;
          const next = update(accountCodeGraphBuildScheduling(current, now), now);
          yield* Ref.set(state, next);
          if (
            !shouldForce &&
            now - next.lastPersistedAtMilliseconds < CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS
          ) {
            return;
          }
          const persisted = {...next, lastPersistedAtMilliseconds: now};
          yield* Ref.set(state, persisted);
          writeSequence += 1;
          if (reporterHistoryAuthority.current !== undefined) {
            yield* revalidateBuildHistoryDirectoryAuthority(fs, reporterHistoryAuthority.current);
          }
          yield* writeCodeGraphBuildStatus(fs, path, file, persisted.status, writeSequence, writeSequence === 1);
        }),
      )
      .pipe(Effect.ignore);

  yield* persist(current => current, true);
  yield* writeCodeGraphManagerContext(fs, path, file, buildId, identity.repoRoot, identity.branch).pipe(Effect.ignore);
  reporterHistoryAuthority.current = Option.getOrUndefined(
    yield* inspectBuildHistoryDirectory(fs, path, layout, identity.worktreeId).pipe(Effect.option),
  );

  const complete = (
    snapshot: CodeGraphSnapshot,
    reusedFiles: number,
    skippedFiles: number,
    overlayAssessment?: {
      readonly outcome: 'overlay-success' | CodeGraphOverlayFallbackReason;
    },
  ) =>
    persist((current, now) => {
      const timestamp = new Date(now).toISOString();
      return {
        ...current,
        status: {
          ...current.status,
          activation: undefined,
          activity: undefined,
          counters: {
            edges: snapshot.edgeCount,
            reused: reusedFiles,
            skipped: skippedFiles,
            symbols: snapshot.symbolCount,
            total: snapshot.fileCount,
            unit: 'files',
          },
          eta: undefined,
          materialization: current.status.materialization?.metrics
            ? {metrics: current.status.materialization.metrics}
            : undefined,
          resolution: undefined,
          result: {
            dirty: snapshot.dirty,
            edges: snapshot.edgeCount,
            files: snapshot.fileCount,
            ...(overlayAssessment ? {overlayAssessment} : {}),
            snapshotId: snapshot.id,
            symbols: snapshot.symbolCount,
          },
          state: 'completed',
          scheduling: {
            ...current.status.scheduling,
            blocker: undefined,
            resource: undefined,
          },
          subphase: 'ready',
          timings: undefined,
          timestamps: {
            ...current.status.timestamps,
            completedAt: timestamp,
            heartbeatAt: timestamp,
            lastProgressAt: timestamp,
            updatedAt: timestamp,
          },
        },
      };
    }, true).pipe(
      Effect.ensuring(removeCodeGraphManagerContext(fs, path, file, buildId, reporterHistoryAuthority.current)),
      Effect.andThen(
        pruneCodeGraphBuildHistory(
          fs,
          path,
          system,
          layout,
          identity.worktreeId,
          buildId,
          historyPruneOptions,
          reporterHistoryAuthority.current,
        ),
      ),
    );

  return {
    admission: (queue?: CodeGraphBuilderAdmissionQueue) =>
      persist(
        (current, now) => ({
          ...current,
          status: observeCodeGraphBuildAdmission(current.status, queue, now),
        }),
        current => queue === undefined || current.status.scheduling?.queue === undefined,
      ),
    complete: summary =>
      complete(
        summary.snapshot,
        summary.reusedFiles,
        summary.skippedFiles,
        summary.snapshot.dirty && summary.materialization?.mode === 'incremental-overlay'
          ? {outcome: 'overlay-success'}
          : summary.snapshot.dirty && summary.materialization?.mode === 'full'
            ? {
                outcome: summary.materialization.fallbackReason ?? 'staging-unavailable',
              }
            : undefined,
      ),
    completeSnapshot: snapshot => complete(snapshot, 0, 0),
    fail: cause =>
      persist((current, now) => {
        const timestamp = new Date(now).toISOString();
        return {
          ...current,
          status: {
            ...current.status,
            activation: undefined,
            activity: undefined,
            error: codeGraphBuildStatusError(cause),
            eta: undefined,
            materialization: current.status.materialization?.metrics
              ? {metrics: current.status.materialization.metrics}
              : undefined,
            resolution: undefined,
            state: 'failed',
            scheduling: {
              ...current.status.scheduling,
              blocker: undefined,
              resource: undefined,
            },
            subphase: 'failed',
            timings: undefined,
            timestamps: {
              ...current.status.timestamps,
              completedAt: timestamp,
              heartbeatAt: timestamp,
              lastProgressAt: timestamp,
              updatedAt: timestamp,
            },
          },
        };
      }, true).pipe(
        Effect.ensuring(removeCodeGraphManagerContext(fs, path, file, buildId, reporterHistoryAuthority.current)),
        Effect.andThen(
          pruneCodeGraphBuildHistory(
            fs,
            path,
            system,
            layout,
            identity.worktreeId,
            buildId,
            historyPruneOptions,
            reporterHistoryAuthority.current,
          ),
        ),
      ),
    heartbeat: Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(CODE_GRAPH_BUILD_HEARTBEAT_INTERVAL_MILLISECONDS);
        const current = yield* Ref.get(state);
        if (current.status.state === 'completed' || current.status.state === 'failed') return;
        yield* persist((latest, now) => {
          const timestamp = new Date(now).toISOString();
          const eta = estimateCodeGraphEta(latest.etaTracker, now).estimate;
          return {
            ...latest,
            status: {
              ...latest.status,
              eta: Option.getOrUndefined(
                Option.map(eta, value => ({
                  ...value,
                  scope: 'phase' as const,
                })),
              ),
              timestamps: {
                ...latest.status.timestamps,
                heartbeatAt: timestamp,
                updatedAt: timestamp,
              },
            },
          };
        }, true);
      }
    }),
    ownerIdentity: {
      buildId,
      processId: system.processId,
      ...(processStartIdentity ? {processStartIdentity} : {}),
    },
    markWorktreeLockHeld: held =>
      persist(
        (current, now) => ({
          ...current,
          status: {
            ...current.status,
            timestamps: {
              ...current.status.timestamps,
              updatedAt: new Date(now).toISOString(),
            },
            worktreeLockHeld: held,
          },
        }),
        true,
      ),
    progress: progress =>
      persist(
        (current, now) => observeProgress(current, progress, now, pathHashSalt),
        current => {
          const measured = Option.getOrUndefined(codeGraphEtaMeasurement(progress));
          const persistedCompleted = current.status.counters.completed ?? -1;
          return (
            current.status.phase !== progress.phase ||
            (progress.phase === 'scanning' && progress.completed > persistedCompleted) ||
            (progress.phase === 'activating' && current.status.subphase !== progressSubphase(progress)) ||
            (progress.phase === 'materializing' &&
              (current.status.subphase !== progressSubphase(progress) || progress.completed > persistedCompleted)) ||
            (progress.phase === 'reclaiming' &&
              progress.pagesCompleted > (current.status.counters.pagesCompleted ?? -1)) ||
            (progress.phase === 'resolving' &&
              progress.subphase === 'references' &&
              progress.activity !== undefined &&
              (current.status.resolution?.activity.pass !== progress.activity.pass ||
                current.status.resolution.activity.pageCompleted !== progress.activity.pageCompleted)) ||
            (measured?.completed ?? -1) >= (measured?.total ?? 0)
          );
        },
      ),
    resource: resource =>
      persist(
        current => ({
          ...current,
          status: observeCodeGraphBuildResource(current.status, resource),
        }),
        true,
      ),
  } satisfies CodeGraphBuildReporter;
});

export const readCodeGraphBuildStatuses = Effect.fn('codeGraph.buildStatus.readCheckout')(function* (
  layout: CodeGraphLayout,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statuses =
    layout.scopeId === undefined
      ? EffectArray.filter(
          yield* readBuildStatusesBelow(fs, path, path.join(layout.repositoryRoot, STATUS_DIRECTORY)),
          status => status.identity.scopeId === undefined,
        )
      : yield* readWorktreeStatuses(
          fs,
          path,
          path.join(layout.repositoryRoot, STATUS_DIRECTORY, codeGraphScopeViewKey(layout.worktreeId, layout.scopeId)),
        );
  return yield* annotateCheckoutBuildCoordination(fs, path, layout, statuses);
});

/**
 * Corroborate an exact durable owner tuple when its local status document is
 * present. Missing history is allowed; malformed or mismatching present state
 * refuses automatic reclamation.
 */
export const corroborateCodeGraphBuildOwnerStatus = Effect.fn('codeGraph.buildStatus.corroborateOwner')(function* (
  layout: CodeGraphLayout,
  worktreeId: string,
  owner: CodeGraphBuildOwnerIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = codeGraphBuildStatusPath(path, layout, worktreeId, owner.buildId);
  if (!(yield* fs.exists(file))) return 'absent' as const;
  const parsed = yield* Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return undefined;
    const info = yield* fs.stat(file);
    if (info.type !== 'File' || Number(info.size) > STATUS_FILE_BYTES_LIMIT) return undefined;
    return parseCodeGraphBuildStatus(JSON.parse(yield* fs.readFileString(file)));
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (parsed === undefined) return 'mismatch' as const;
  return parsed.buildId === owner.buildId &&
    parsed.identity.checkoutId === layout.checkoutId &&
    parsed.identity.scopeId === layout.scopeId &&
    parsed.identity.worktreeId === worktreeId &&
    parsed.owner.processId === owner.processId &&
    parsed.owner.processStartIdentity === owner.processStartIdentity
    ? ('matches' as const)
    : ('mismatch' as const);
});

/** @internal Pure admission boundary for the capped status/context directory. */
export function codeGraphBuildHistoryInventory(page: {
  readonly names: readonly string[];
  readonly overflow: boolean;
}): readonly string[] | undefined {
  if (page.overflow || page.names.length > CODE_GRAPH_BUILD_HISTORY_DIRECTORY_ENTRY_LIMIT) return undefined;
  const names = page.names;
  const statusNames = EffectArray.filter(
    names,
    (name, __effectArrayIndex) => __effectArrayIndex in names && BUILD_STATUS_FILE.test(name),
  ).sort();
  return statusNames.length <= CODE_GRAPH_BUILD_HISTORY_STATUS_LIMIT ? statusNames : undefined;
}

/**
 * Inspect one bounded history page and remove at most one exact terminal,
 * expired-failed, or abandoned status/context pair. Progress cursors let
 * ordinary maintenance advance when a page contains no safe candidate.
 */
export const pruneCodeGraphBuildHistoryUnit = Effect.fn('codeGraph.buildStatus.pruneHistoryUnit')(function* (
  layout: CodeGraphLayout,
  worktreeId: string,
  protectedBuildId?: string,
  cursorToken?: string,
  options: CodeGraphBuildHistoryPruneOptions = {},
) {
  if (
    !HASH_ID.test(layout.checkoutId) ||
    !HASH_ID.test(worktreeId) ||
    layout.worktreeId !== worktreeId ||
    (protectedBuildId !== undefined && !BUILD_ID.test(protectedBuildId)) ||
    (cursorToken !== undefined && parseBuildHistoryCursor(cursorToken) === undefined)
  ) {
    return invalidBuildHistoryResult();
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return yield* Effect.gen(function* () {
    const authority = yield* inspectBuildHistoryDirectory(fs, path, layout, worktreeId);
    if (authority === undefined) {
      return {
        state: 'complete',
      } as const satisfies CodeGraphBuildHistoryPruneResult;
    }
    return yield* pruneCodeGraphBuildHistoryUnitWithServices(
      fs,
      path,
      system,
      layout,
      worktreeId,
      protectedBuildId,
      cursorToken,
      options,
      authority,
    );
  }).pipe(Effect.catch(cause => Effect.succeed(classifyBuildHistoryFailure(cause))));
});

/**
 * Run one cursor-backed history page without requiring a successor reporter.
 * Ordinary maintenance uses this to converge abandoned nonterminal sidecars
 * and expired failed receipts.
 */
export const maintainCodeGraphBuildHistoryUnit = Effect.fn('codeGraph.buildStatus.maintainHistoryUnit')(function* (
  layout: CodeGraphLayout,
  worktreeId: string,
  options: CodeGraphBuildHistoryPruneOptions = {},
) {
  if (!HASH_ID.test(layout.checkoutId) || !HASH_ID.test(worktreeId) || layout.worktreeId !== worktreeId) {
    return invalidBuildHistoryResult();
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return yield* Effect.gen(function* () {
    const authority = yield* inspectBuildHistoryDirectory(fs, path, layout, worktreeId);
    if (authority === undefined)
      return {
        state: 'complete',
      } as const satisfies CodeGraphBuildHistoryPruneResult;
    return yield* runPersistedCodeGraphBuildHistoryUnit(
      fs,
      path,
      system,
      layout,
      worktreeId,
      undefined,
      options,
      authority,
    );
  }).pipe(Effect.catch(cause => Effect.succeed(classifyBuildHistoryFailure(cause))));
});

export const readAllCodeGraphBuildStatuses = Effect.fn('codeGraph.buildStatus.readAll')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = codeGraphRepositoriesRoot(path, threadnoteHome);
  if (!(yield* regularDirectory(fs, root))) return [];
  const statuses = yield* Effect.forEach(
    EffectArray.filter(
      yield* fs.readDirectory(root),
      __effectArrayValue2 => !!(name => HASH_ID.test(name))(__effectArrayValue2),
    ).sort(),
    checkoutId =>
      readBuildStatusesBelow(fs, path, path.join(root, checkoutId, STATUS_DIRECTORY)).pipe(
        Effect.flatMap(statuses => annotateBuildCoordinationByWorktree(fs, path, threadnoteHome, checkoutId, statuses)),
        Effect.flatMap(statuses => attachCodeGraphManagerContexts(fs, path, root, checkoutId, statuses)),
      ),
    {concurrency: 8},
  );
  return statuses.flat().sort(compareObservedBuildStatus);
});

export const currentCodeGraphBuildStatus = Effect.fn('codeGraph.buildStatus.current')(function* (
  layout: CodeGraphLayout,
  worktreeId: string,
) {
  const statuses = EffectArray.filter(
    yield* readCodeGraphBuildStatuses(layout),
    status => status.identity.worktreeId === worktreeId,
  );
  return statuses.sort(compareObservedBuildStatus)[0];
});

export function observeCodeGraphBuildStatus(
  status: CodeGraphBuildStatus,
  observation: ProcessObservation,
): ObservedCodeGraphBuildStatus {
  const heartbeat = Date.parse(status.timestamps.heartbeatAt);
  const heartbeatAgeMilliseconds = Number.isFinite(heartbeat)
    ? Math.max(0, observation.nowMilliseconds - heartbeat)
    : Number.POSITIVE_INFINITY;
  if (status.state === 'completed') {
    return {
      ...status,
      observation: {heartbeatAgeMilliseconds, liveness: 'completed'},
    };
  }
  if (status.state === 'failed') {
    return {
      ...status,
      observation: {heartbeatAgeMilliseconds, liveness: 'failed'},
    };
  }
  if (!observation.isRunning) {
    return {
      ...status,
      observation: {
        heartbeatAgeMilliseconds,
        liveness: 'abandoned',
        reason: 'owner-exited',
      },
    };
  }
  if (
    status.owner.processStartIdentity &&
    observation.processStartIdentity &&
    status.owner.processStartIdentity !== observation.processStartIdentity
  ) {
    return {
      ...status,
      observation: {
        heartbeatAgeMilliseconds,
        liveness: 'abandoned',
        reason: 'pid-reused',
      },
    };
  }
  if (heartbeatAgeMilliseconds > CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS) {
    return {
      ...status,
      observation: {
        heartbeatAgeMilliseconds,
        liveness: 'stalled',
        reason: 'heartbeat-stale',
      },
    };
  }
  return {
    ...status,
    observation: {heartbeatAgeMilliseconds, liveness: 'active'},
  };
}

/** @internal Pure destructive-admission boundary for nonterminal build-status cleanup. */
export function codeGraphAbandonedBuildStatusRemovable(
  status: ObservedCodeGraphBuildStatus,
  lockOwner: FileLockOwner | undefined,
  protectedBuildId?: string,
): boolean {
  const protections: CodeGraphLifecycleProtection[] = [];
  if (status.buildId === protectedBuildId) protections.push('active-pin');
  if (lockOwner !== undefined && sameProcessOwner(status, lockOwner)) protections.push('active-writer');
  const authorityProven =
    status.state !== 'completed' && status.state !== 'failed' && status.observation.liveness === 'abandoned';
  return (
    classifyCodeGraphLifecycle({
      authority: authorityProven ? 'proven-disposable' : 'unproven',
      protections,
      state: 'abandoned-build',
    }).disposition === 'reclaim'
  );
}

function observeBuildHistoryCandidate(system: SystemInfoShape, status: CodeGraphBuildStatus, nowMilliseconds: number) {
  if (status.state === 'completed' || status.state === 'failed') {
    return Effect.succeed(
      observeCodeGraphBuildStatus(status, {
        isRunning: false,
        nowMilliseconds,
      }),
    );
  }
  const isRunning = system.isProcessRunning(status.owner.processId);
  return (isRunning ? system.processStartIdentity(status.owner.processId) : Effect.void).pipe(
    Effect.map(processStartIdentity =>
      observeCodeGraphBuildStatus(status, {
        isRunning,
        nowMilliseconds,
        ...(processStartIdentity === undefined ? {} : {processStartIdentity}),
      }),
    ),
  );
}

function observeProgress(
  current: ReporterState,
  progress: CodeGraphProgress,
  now: number,
  pathHashSalt: string,
): ReporterState {
  const timestamp = new Date(now).toISOString();
  const phaseChanged = current.status.phase !== progress.phase;
  const etaObservation = observeCodeGraphEta(current.etaTracker, codeGraphEtaMeasurement(progress), now);
  const eta = Option.getOrUndefined(
    Option.map(etaObservation.estimate, value => ({
      ...value,
      scope: 'phase' as const,
    })),
  );
  return {
    ...current,
    etaTracker: etaObservation.tracker,
    status: {
      ...current.status,
      activation: progressActivation(current.status.activation, progress, timestamp),
      activity: progressActivity(progress),
      counters: progressCounters(progress),
      eta,
      extraction: progressExtraction(current.status.extraction, progress, pathHashSalt),
      materialization: progressMaterialization(current.status.materialization, progress, timestamp),
      phase: progress.phase,
      registration: progressRegistration(progress),
      resolution: progressResolution(current.status.resolution, progress, timestamp),
      state: progress.phase === 'waiting' ? 'queued' : 'running',
      scheduling: {
        ...current.status.scheduling,
        blocker: progress.phase === 'waiting' ? progress.reason : undefined,
      },
      subphase: progressSubphase(progress),
      timings: codeGraphProgressTimings(current.status, progress),
      timestamps: {
        ...current.status.timestamps,
        heartbeatAt: timestamp,
        lastProgressAt: timestamp,
        phaseStartedAt: phaseChanged ? timestamp : current.status.timestamps.phaseStartedAt,
        updatedAt: timestamp,
      },
    },
  };
}

function progressActivation(
  current: CodeGraphBuildActivation | undefined,
  progress: CodeGraphProgress,
  timestamp: string,
): CodeGraphBuildActivation | undefined {
  if (progress.phase !== 'activating') return undefined;
  if (!progress.activity) return current;
  return {
    activity: {
      ...progress.activity,
      startedAt: current?.activity.stage === progress.activity.stage ? current.activity.startedAt : timestamp,
    },
  };
}

function progressResolution(
  current: CodeGraphBuildResolution | undefined,
  progress: CodeGraphProgress,
  timestamp: string,
): CodeGraphBuildResolution | undefined {
  if (progress.phase !== 'resolving' || progress.subphase !== 'references') return undefined;
  if (!progress.activity) return current;
  return {
    activity: {
      ...progress.activity,
      // elapsedMilliseconds and the aggregate counters span every alias pass,
      // so their timestamp must remain phase-scoped as well. The pass number
      // already identifies the current bounded denominator.
      startedAt: current?.activity.startedAt ?? timestamp,
    },
  };
}

function progressRegistration(progress: CodeGraphProgress): CodeGraphBuildRegistration | undefined {
  return progress.phase === 'registering' && progress.activity ? {activity: progress.activity} : undefined;
}

function progressSubphase(progress: CodeGraphProgress): string {
  if ('subphase' in progress && typeof progress.subphase === 'string') return boundedText(progress.subphase, 64);
  switch (progress.phase) {
    case 'activating':
      return progress.activity?.stage ?? 'snapshot';
    case 'embedding':
      return 'vectors';
    case 'materializing':
      return progress.activity?.stage ?? 'facts';
    case 'registering':
      return progress.activity?.stage ?? 'registration';
    case 'reclaiming':
      return 'superseded-snapshots';
    case 'scanning':
      return progress.activity?.stage ?? 'inventory';
    case 'waiting':
      return progress.reason ?? 'repository-lock';
  }
}

function progressMaterialization(
  current: CodeGraphBuildMaterialization | undefined,
  progress: CodeGraphProgress,
  timestamp: string,
): CodeGraphBuildMaterialization | undefined {
  if (progress.phase !== 'materializing') return current?.metrics ? {metrics: current.metrics} : undefined;
  if (!progress.activity && !progress.metrics) {
    return progress.completed >= progress.total ? undefined : current;
  }
  const previousActivity = current?.activity;
  const activity = progress.activity
    ? {
        ...progress.activity,
        startedAt:
          previousActivity?.stage === progress.activity.stage &&
          previousActivity.batchCompleted === progress.activity.batchCompleted
            ? previousActivity.startedAt
            : timestamp,
      }
    : undefined;
  return {
    ...(activity ? {activity} : {}),
    ...(progress.metrics ? {metrics: progress.metrics} : current?.metrics ? {metrics: current.metrics} : {}),
  };
}

function progressActivity(progress: CodeGraphProgress): CodeGraphBuildActivity | undefined {
  if (progress.phase !== 'scanning' || !progress.activity) return undefined;
  const activity = progress.activity;
  return {
    batchCompleted: activity.batchCompleted,
    batchTotal: activity.batchTotal,
    bytes: activity.bytes,
    ...(activity.classifier === undefined ? {} : {classifier: boundedText(activity.classifier, 64)}),
    ...(activity.degraded === undefined ? {} : {degraded: activity.degraded}),
    ...(activity.factsBytes === undefined ? {} : {factsBytes: activity.factsBytes}),
    language: boundedText(activity.language, 64),
    ...(activity.parseMilliseconds === undefined ? {} : {parseMilliseconds: activity.parseMilliseconds}),
    ...(activity.persistMilliseconds === undefined ? {} : {persistMilliseconds: activity.persistMilliseconds}),
    ...(activity.relations === undefined ? {} : {relations: activity.relations}),
    ...(activity.role === undefined ? {} : {role: boundedText(activity.role, 64)}),
    ...(activity.sizeBucket === undefined ? {} : {sizeBucket: activity.sizeBucket}),
    stage: activity.stage,
    ...(activity.symbols === undefined ? {} : {symbols: activity.symbols}),
  };
}

function progressExtraction(
  current: CodeGraphBuildExtraction | undefined,
  progress: CodeGraphProgress,
  pathHashSalt: string,
): CodeGraphBuildExtraction | undefined {
  if (progress.phase !== 'scanning' || progress.activity?.stage !== 'extracting') {
    return current;
  }
  const activity = progress.activity;
  const durationMilliseconds = activity.parseMilliseconds;
  if (durationMilliseconds === undefined) return current;
  const currentTop = current?.topSlowFiles ?? [];
  const slowestRetained = currentTop.at(-1)?.durationMilliseconds;
  const retainCandidate =
    durationMilliseconds > 0 &&
    (currentTop.length < CODE_GRAPH_TOP_SLOW_FILE_LIMIT ||
      slowestRetained === undefined ||
      durationMilliseconds >= slowestRetained);
  const topSlowFiles = retainCandidate
    ? retainCodeGraphSlowFileTelemetry(currentTop, {
        classifier: boundedText(activity.classifier ?? 'unmatched', 64),
        ...(activity.degraded === undefined ? {} : {degraded: activity.degraded}),
        durationMilliseconds,
        extension: codeGraphPathExtension(activity.path),
        ...(activity.factsBytes === undefined ? {} : {factsBytes: activity.factsBytes}),
        language: boundedText(activity.language, 64),
        pathHash: sha256HexSync(`code-graph-slow-file-v1\n${pathHashSalt}\n${activity.path}`),
        ...(activity.relations === undefined ? {} : {relations: activity.relations}),
        role: boundedText(activity.role ?? 'unmatched', 64),
        sizeBucket: activity.sizeBucket ?? codeGraphSourceSizeBucket(activity.bytes),
        sourceBytes: activity.bytes,
        ...(activity.symbols === undefined ? {} : {symbols: activity.symbols}),
      })
    : currentTop;
  return {
    completedFiles: (current?.completedFiles ?? 0) + 1,
    ...(progress.metrics ? {metrics: progress.metrics} : current?.metrics ? {metrics: current.metrics} : {}),
    slowFiles:
      (current?.slowFiles ?? 0) + (durationMilliseconds >= CODE_GRAPH_SLOW_FILE_THRESHOLD_MILLISECONDS ? 1 : 0),
    topSlowFiles,
  };
}

function progressCounters(progress: CodeGraphProgress): CodeGraphBuildCounters {
  switch (progress.phase) {
    case 'scanning':
      return {
        accepted: progress.accepted,
        completed: progress.completed,
        excluded: progress.excluded,
        skipped: progress.skipped,
        total: progress.total,
        unit: progress.unit,
      };
    case 'materializing':
      return {
        completed: progress.completed,
        reused: progress.reused,
        total: progress.total,
        unit: progress.unit,
      };
    case 'reclaiming':
      return {
        completed: progress.completed,
        pagesCompleted: progress.pagesCompleted,
        rowsDeleted: progress.rowsDeleted,
        total: progress.total,
        unit: progress.unit,
      };
    case 'resolving':
      return progress.subphase === 'complete'
        ? {
            edges: progress.edges,
            resolved: progress.resolved,
            symbols: progress.symbols,
          }
        : progress.activity
          ? {
              completed: progress.activity.referencesCompleted,
              resolved: progress.activity.resolved,
              total: progress.activity.referencesTotal,
              unit: 'references',
            }
          : {};
    case 'embedding':
      return {
        completed: progress.completed,
        embedded: progress.embedded,
        reused: progress.reused,
        total: progress.total,
        unit: progress.unit,
      };
    default:
      return {};
  }
}

function codeGraphBuildStatusPath(
  path: Path.Path,
  layout: CodeGraphLayout,
  worktreeId: string,
  buildId: string,
): string {
  if (!HASH_ID.test(worktreeId) || !BUILD_ID.test(buildId))
    throw CodeGraphBuildStatusError.make({
      message: 'Code graph build identity is invalid.',
    });
  return path.join(
    layout.repositoryRoot,
    STATUS_DIRECTORY,
    codeGraphScopeViewKey(worktreeId, layout.scopeId),
    `${buildId}.json`,
  );
}

function writeCodeGraphBuildStatus(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  status: CodeGraphBuildStatus,
  sequence: number,
  initializeDirectory: boolean,
) {
  return Effect.gen(function* () {
    const directory = path.dirname(file);
    if (initializeDirectory) {
      yield* ensurePrivateRegularDirectory(fs, path, directory);
    } else if (!(yield* regularDirectory(fs, directory))) {
      return yield* CodeGraphBuildStatusError.make({
        message: 'Code graph build status directory was removed.',
      });
    }
    if ((yield* fs.readLink(file).pipe(Effect.option))._tag === 'Some') {
      return yield* CodeGraphBuildStatusError.make({
        message: 'Code graph build status path is a symbolic link.',
      });
    }
    const temporary = path.join(directory, `.${status.buildId}.${sequence}.tmp`);
    const content = `${JSON.stringify(status)}\n`;
    if (new TextEncoder().encode(content).byteLength > STATUS_FILE_BYTES_LIMIT) {
      return yield* CodeGraphBuildStatusError.make({
        message: 'Code graph build status exceeded its bounded sidecar size.',
      });
    }
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
    yield* fs
      .rename(temporary, file)
      .pipe(Effect.onError(() => fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  });
}

function codeGraphManagerContextPath(path: Path.Path, statusFile: string, buildId: string): string {
  return path.join(path.dirname(statusFile), `${buildId}.manager-context`);
}

function writeCodeGraphManagerContext(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  statusFile: string,
  buildId: string,
  worktreePath: string,
  branch?: string,
) {
  return Effect.gen(function* () {
    if (!isText(worktreePath, 4_096)) return;
    const file = codeGraphManagerContextPath(path, statusFile, buildId);
    if ((yield* fs.readLink(file).pipe(Effect.option))._tag === 'Some') return;
    const temporary = path.join(path.dirname(file), `.${buildId}.manager-context.tmp`);
    const content = `${JSON.stringify({
      ...(branch !== undefined && isText(branch, 1_024) ? {branch} : {}),
      buildId,
      schemaVersion: MANAGER_CONTEXT_SCHEMA_VERSION,
      worktreePath,
    })}\n`;
    if (new TextEncoder().encode(content).byteLength > MANAGER_CONTEXT_FILE_BYTES_LIMIT) return;
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
    yield* fs
      .rename(temporary, file)
      .pipe(Effect.onError(() => fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  });
}

function removeCodeGraphManagerContext(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  statusFile: string,
  buildId: string,
  authority: BuildHistoryDirectoryAuthority | undefined,
) {
  return Effect.gen(function* () {
    if (authority === undefined) return;
    yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
    const file = codeGraphManagerContextPath(path, statusFile, buildId);
    const observed = yield* readBuildHistoryManagerContext(fs, file, buildId);
    if (observed === undefined) return;
    yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
    yield* fs.remove(file, {force: false});
  }).pipe(Effect.ignore);
}

function attachCodeGraphManagerContexts(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoriesRoot: string,
  checkoutId: string,
  statuses: readonly ObservedCodeGraphBuildStatus[],
) {
  return Effect.forEach(
    statuses,
    status => {
      const statusFile = path.join(
        repositoriesRoot,
        checkoutId,
        STATUS_DIRECTORY,
        codeGraphScopeViewKey(status.identity.worktreeId, status.identity.scopeId),
        `${status.buildId}.json`,
      );
      const contextFile = codeGraphManagerContextPath(path, statusFile, status.buildId);
      if (status.state === 'completed' || status.state === 'failed' || status.observation.liveness === 'abandoned') {
        return Effect.succeed(status);
      }
      return readCodeGraphManagerContext(fs, contextFile, status.buildId).pipe(
        Effect.map(context => (context ? {...status, managerContext: context} : status)),
      );
    },
    {concurrency: 8},
  );
}

function readCodeGraphManagerContext(fs: FileSystem.FileSystem, file: string, buildId: string) {
  return Effect.gen(function* () {
    if ((yield* fs.readLink(file).pipe(Effect.option))._tag === 'Some') return undefined;
    const info = yield* fs.stat(file);
    if (info.type !== 'File' || Number(info.size) > MANAGER_CONTEXT_FILE_BYTES_LIMIT) return undefined;
    const value: unknown = JSON.parse(yield* fs.readFileString(file));
    if (
      !isRecord(value) ||
      value.schemaVersion !== MANAGER_CONTEXT_SCHEMA_VERSION ||
      value.buildId !== buildId ||
      !isText(value.worktreePath, 4_096) ||
      (value.branch !== undefined && !isText(value.branch, 1_024))
    ) {
      return undefined;
    }
    return {
      ...(value.branch === undefined ? {} : {branch: value.branch}),
      worktreePath: value.worktreePath,
    };
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function ensurePrivateRegularDirectory(fs: FileSystem.FileSystem, path: Path.Path, directory: string) {
  return Effect.gen(function* () {
    const parent = path.dirname(directory);
    yield* fs.makeDirectory(parent, {recursive: true, mode: 0o700});
    if ((yield* fs.readLink(parent).pipe(Effect.option))._tag === 'Some') {
      return yield* CodeGraphBuildStatusError.make({
        message: 'Code graph build status parent is a symbolic link.',
      });
    }
    yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    if ((yield* fs.readLink(directory).pipe(Effect.option))._tag === 'Some') {
      return yield* CodeGraphBuildStatusError.make({
        message: 'Code graph build status directory is a symbolic link.',
      });
    }
  });
}

function readBuildStatusesBelow(fs: FileSystem.FileSystem, path: Path.Path, root: string) {
  return Effect.gen(function* () {
    if (!(yield* regularDirectory(fs, root))) return [];
    const worktrees = EffectArray.filter(
      yield* fs.readDirectory(root),
      __effectArrayValue2 => !!(name => BUILD_STATUS_VIEW_DIRECTORY.test(name))(__effectArrayValue2),
    ).sort();
    const groups = yield* Effect.forEach(
      worktrees,
      worktreeId => readWorktreeStatuses(fs, path, path.join(root, worktreeId)),
      {concurrency: 8},
    );
    return groups.flat().sort(compareObservedBuildStatus);
  }).pipe(Effect.orElseSucceed(() => [] as readonly ObservedCodeGraphBuildStatus[]));
}

function readWorktreeStatuses(fs: FileSystem.FileSystem, path: Path.Path, directory: string) {
  return Effect.gen(function* () {
    if (!(yield* regularDirectory(fs, directory))) return [];
    const files = EffectArray.filter(
      yield* fs.readDirectory(directory),
      __effectArrayValue2 =>
        !!(name =>
          BUILD_ID.test(Effect2.pipe(name, EffectString.slice(0, -5))) &&
          Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue2),
    ).sort();
    const statuses = yield* Effect.forEach(files, name => readStatusFile(fs, path.join(directory, name)), {
      concurrency: 8,
    });
    const expectedViewKey = path.basename(directory);
    return EffectArray.filter(
      statuses,
      (status): status is ObservedCodeGraphBuildStatus =>
        status !== undefined &&
        codeGraphScopeViewKey(status.identity.worktreeId, status.identity.scopeId) === expectedViewKey,
    );
  });
}

function readStatusFile(fs: FileSystem.FileSystem, file: string) {
  return Effect.gen(function* () {
    if ((yield* fs.readLink(file).pipe(Effect.option))._tag === 'Some') return undefined;
    const info = yield* fs.stat(file);
    if (info.type !== 'File' || Number(info.size) > STATUS_FILE_BYTES_LIMIT) return undefined;
    const parsed = parseCodeGraphBuildStatus(JSON.parse(yield* fs.readFileString(file)));
    if (!parsed) return undefined;
    const nowMilliseconds = yield* Clock.currentTimeMillis;
    if (parsed.state === 'completed' || parsed.state === 'failed') {
      return observeCodeGraphBuildStatus(parsed, {
        isRunning: false,
        nowMilliseconds,
      });
    }
    const system = yield* SystemInfo;
    const isRunning = system.isProcessRunning(parsed.owner.processId);
    const processStartIdentity = isRunning ? yield* system.processStartIdentity(parsed.owner.processId) : undefined;
    return observeCodeGraphBuildStatus(parsed, {
      isRunning,
      nowMilliseconds,
      processStartIdentity,
    });
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function pruneCodeGraphBuildHistory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  layout: CodeGraphLayout,
  worktreeId: string,
  protectedBuildId: string,
  options: CodeGraphBuildHistoryPruneOptions,
  authority: BuildHistoryDirectoryAuthority | undefined,
) {
  if (authority === undefined) return Effect.void;
  return runPersistedCodeGraphBuildHistoryUnit(
    fs,
    path,
    system,
    layout,
    worktreeId,
    protectedBuildId,
    options,
    authority,
  ).pipe(
    Effect.catch(() => Effect.void),
    Effect.asVoid,
  );
}

const runPersistedCodeGraphBuildHistoryUnit = Effect.fn('codeGraph.buildStatus.runPersistedHistoryUnit')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  layout: CodeGraphLayout,
  worktreeId: string,
  protectedBuildId: string | undefined,
  options: CodeGraphBuildHistoryPruneOptions,
  authority: BuildHistoryDirectoryAuthority,
) {
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  if (options.beforeCursorRecovery !== undefined) yield* options.beforeCursorRecovery();
  const persistedCursor = yield* recoverPersistedBuildHistoryCursor(fs, path, authority);
  const result = yield* pruneCodeGraphBuildHistoryUnitWithServices(
    fs,
    path,
    system,
    layout,
    worktreeId,
    protectedBuildId,
    persistedCursor?.cursorToken,
    options,
    authority,
  );
  if (options.beforeCursorMutation !== undefined) yield* options.beforeCursorMutation();
  if (result.state !== 'progress' || parseBuildHistoryCursor(result.cursorToken)?.mode !== 'scan') {
    yield* removePersistedBuildHistoryCursor(fs, authority, persistedCursor);
    return result;
  }
  yield* writePersistedBuildHistoryCursor(fs, path, authority, persistedCursor, result.cursorToken);
  return result;
});

interface ObservedBuildHistorySidecar {
  readonly content: string;
  readonly file: string;
  readonly info: FileSystem.File.Info;
}

interface BuildHistoryCandidate extends ObservedBuildHistorySidecar {
  readonly status: CodeGraphBuildStatus;
}

type BuildHistoryLockObservation =
  | {readonly state: 'absent'}
  | {readonly owner: FileLockOwner; readonly state: 'present'}
  | {readonly state: 'unavailable'};

interface PersistedBuildHistoryCursor extends ObservedBuildHistorySidecar {
  readonly cursorToken: string;
}

interface FrozenBuildHistoryDirectory {
  readonly canonicalPath: string;
  readonly info: FileSystem.File.Info;
  readonly path: string;
}

interface BuildHistoryDirectoryAuthority {
  readonly directory: FrozenBuildHistoryDirectory;
  readonly repositoryRoot: FrozenBuildHistoryDirectory;
  readonly statusRoot: FrozenBuildHistoryDirectory;
}

type BuildHistoryCursor = {readonly mode: 'reset'} | {readonly afterBuildId: string; readonly mode: 'scan'};

class InvalidBuildHistorySidecarError extends Schema.TaggedError<
  InvalidBuildHistorySidecarError,
  {readonly brand: unique symbol}
>()('InvalidBuildHistorySidecarError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const pruneCodeGraphBuildHistoryUnitWithServices = Effect.fn('codeGraph.buildStatus.pruneHistoryUnitUnsafe')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  layout: CodeGraphLayout,
  worktreeId: string,
  protectedBuildId: string | undefined,
  cursorToken: string | undefined,
  options: CodeGraphBuildHistoryPruneOptions,
  authority: BuildHistoryDirectoryAuthority,
) {
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  const directory = authority.directory.path;
  const inventoryPage = yield* runtimeTextDirectoryNamePage(
    directory,
    CODE_GRAPH_BUILD_HISTORY_DIRECTORY_ENTRY_LIMIT,
  ).pipe(
    Effect.mapError(cause =>
      cause instanceof TypeError
        ? InvalidBuildHistorySidecarError.make({
            message: 'Build history inventory contains a non-text name.',
          })
        : cause,
    ),
  );
  const statusNames = codeGraphBuildHistoryInventory(inventoryPage);
  if (statusNames === undefined) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history inventory exceeded its limit.',
    });
  }
  const parsedCursor = cursorToken === undefined ? undefined : parseBuildHistoryCursor(cursorToken);
  const afterBuildId = parsedCursor?.mode === 'scan' ? parsedCursor.afterBuildId : undefined;
  if (afterBuildId !== undefined && !statusNames.includes(`${afterBuildId}.json`)) {
    return {
      cursorToken: buildHistoryResetCursor(),
      state: 'progress',
    } as const;
  }
  const remainingNames = EffectArray.filter(statusNames, name =>
    afterBuildId === undefined ? true : name > `${afterBuildId}.json`,
  );
  const pageNames = remainingNames.slice(0, CODE_GRAPH_BUILD_HISTORY_STATUS_PAGE_LIMIT);
  if (pageNames.length === 0) {
    return {
      state: 'complete',
    } as const satisfies CodeGraphBuildHistoryPruneResult;
  }

  const candidates = yield* Effect.forEach(
    pageNames,
    name => readBuildHistoryCandidate(fs, path, path.join(directory, name), layout.checkoutId, worktreeId),
    {concurrency: 4},
  );
  if (EffectArray.some(candidates, candidate => candidate === undefined)) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history changed during its bounded page.',
    });
  }
  const completeCandidates: BuildHistoryCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate !== undefined) completeCandidates.push(candidate);
  }
  const lockPath = path.join(layout.worktreeLockRoot, `${worktreeId}.lock`);
  const initialLock = yield* inspectBuildHistoryLock(fs, lockPath);
  const nowMilliseconds = yield* Clock.currentTimeMillis;
  const observedCandidates = yield* Effect.forEach(
    completeCandidates,
    candidate =>
      observeBuildHistoryCandidate(system, candidate.status, nowMilliseconds).pipe(
        Effect.map(status => ({candidate, status})),
      ),
    {concurrency: 4},
  );
  const ranked = [...observedCandidates].sort((left, right) =>
    compareBuildHistoryCandidate(left.candidate, right.candidate),
  );
  const abandoned =
    initialLock.state === 'unavailable'
      ? undefined
      : Option.getOrUndefined(
          EffectArray.findFirst(
            [...ranked].reverse(),
            __effectArrayValue =>
              !!(observed =>
                codeGraphAbandonedBuildStatusRemovable(
                  observed.status,
                  initialLock.state === 'present' ? initialLock.owner : undefined,
                  protectedBuildId,
                ))(__effectArrayValue),
          ),
        );
  const expiredFailed = Option.getOrUndefined(
    EffectArray.findFirst(
      [...ranked].reverse(),
      __effectArrayValue =>
        !!(observed => codeGraphFailedBuildStatusRemovable(observed.status, protectedBuildId))(__effectArrayValue),
    ),
  );
  const terminal =
    statusNames.length <= STATUS_HISTORY_PER_WORKTREE
      ? undefined
      : Option.getOrUndefined(
          EffectArray.findFirst(
            ranked.slice(STATUS_HISTORY_PER_WORKTREE).reverse(),
            observed =>
              observed.status.buildId !== protectedBuildId &&
              (observed.status.state === 'completed' || observed.status.state === 'failed'),
          ),
        );
  const selected = abandoned ?? expiredFailed ?? terminal;
  if (selected === undefined) {
    const hasMore = remainingNames.length > pageNames.length;
    const lastBuildId = Effect2.pipe(pageNames.at(-1), effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect2.pipe(effectOptionalString, EffectString.slice(0, -'.json'.length)),
    );
    return hasMore && lastBuildId !== undefined
      ? ({
          cursorToken: buildHistoryScanCursor(lastBuildId),
          state: 'progress',
        } as const)
      : ({state: 'complete'} as const);
  }
  const candidate = selected.candidate;
  const removalKind = abandoned === selected ? ('abandoned' as const) : ('terminal' as const);

  const contextFile = codeGraphManagerContextPath(path, candidate.file, candidate.status.buildId);
  const initialContext = yield* readBuildHistoryManagerContext(fs, contextFile, candidate.status.buildId);
  if (options.beforeFinalStatusObservation !== undefined) yield* options.beforeFinalStatusObservation();
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  const finalStatus = yield* readBuildHistoryCandidate(fs, path, candidate.file, layout.checkoutId, worktreeId);
  const finalContext = yield* readBuildHistoryManagerContext(fs, contextFile, candidate.status.buildId);
  if (
    finalStatus === undefined ||
    !sameBuildHistorySidecar(candidate, finalStatus) ||
    !sameOptionalBuildHistorySidecar(initialContext, finalContext)
  ) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history authority changed.',
    });
  }
  if (removalKind === 'abandoned') {
    const finalLock = yield* inspectBuildHistoryLock(fs, lockPath);
    const finalObserved = yield* observeBuildHistoryCandidate(
      system,
      finalStatus.status,
      yield* Clock.currentTimeMillis,
    );
    if (
      finalLock.state === 'unavailable' ||
      !codeGraphAbandonedBuildStatusRemovable(
        finalObserved,
        finalLock.state === 'present' ? finalLock.owner : undefined,
        protectedBuildId,
      )
    ) {
      return yield* InvalidBuildHistorySidecarError.make({
        message: 'Build history owner changed.',
      });
    }
  }

  if (finalContext !== undefined) {
    yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
    yield* fs.remove(contextFile, {force: false});
  }
  if (options.afterManagerContextRemoval !== undefined) yield* options.afterManagerContextRemoval();
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  const ownedStatus = yield* readBuildHistoryCandidate(fs, path, candidate.file, layout.checkoutId, worktreeId);
  const remainingContext = yield* readBuildHistoryManagerContext(fs, contextFile, candidate.status.buildId);
  if (ownedStatus === undefined || !sameBuildHistorySidecar(candidate, ownedStatus) || remainingContext !== undefined) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history changed before removal.',
    });
  }
  if (removalKind === 'abandoned') {
    const ownedLock = yield* inspectBuildHistoryLock(fs, lockPath);
    const ownedObserved = yield* observeBuildHistoryCandidate(
      system,
      ownedStatus.status,
      yield* Clock.currentTimeMillis,
    );
    if (
      ownedLock.state === 'unavailable' ||
      !codeGraphAbandonedBuildStatusRemovable(
        ownedObserved,
        ownedLock.state === 'present' ? ownedLock.owner : undefined,
        protectedBuildId,
      )
    ) {
      return yield* InvalidBuildHistorySidecarError.make({
        message: 'Build history owner changed before removal.',
      });
    }
  }
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  yield* fs.remove(candidate.file, {force: false});
  return {
    cursorToken: buildHistoryResetCursor(),
    ...(removalKind === 'abandoned' ? {removedAbandoned: true as const} : {}),
    state: 'progress',
  } as const;
});

const inspectBuildHistoryDirectory = Effect.fn('codeGraph.buildStatus.inspectHistoryDirectory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  layout: CodeGraphLayout,
  worktreeId: string,
) {
  const repositoryRoot = yield* freezeBuildHistoryDirectory(fs, layout.repositoryRoot);
  if (repositoryRoot === undefined) return undefined;
  const statusRoot = yield* freezeBuildHistoryDirectory(fs, path.join(layout.repositoryRoot, STATUS_DIRECTORY));
  if (statusRoot === undefined) return undefined;
  if (statusRoot.canonicalPath !== path.join(repositoryRoot.canonicalPath, STATUS_DIRECTORY)) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history status root escaped containment.',
    });
  }
  const viewKey = codeGraphScopeViewKey(worktreeId, layout.scopeId);
  const directory = yield* freezeBuildHistoryDirectory(fs, path.join(statusRoot.path, viewKey));
  if (directory === undefined) return undefined;
  if (directory.canonicalPath !== path.join(statusRoot.canonicalPath, viewKey)) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history worktree escaped containment.',
    });
  }
  return {
    directory,
    repositoryRoot,
    statusRoot,
  } satisfies BuildHistoryDirectoryAuthority;
});

const freezeBuildHistoryDirectory = Effect.fn('codeGraph.buildStatus.freezeHistoryDirectory')(function* (
  fs: FileSystem.FileSystem,
  directory: string,
) {
  if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history directory is a symbolic link.',
    });
  }
  const info = yield* optionalBuildHistoryFileInfo(fs, directory);
  if (info === undefined) return undefined;
  if (info.type !== 'Directory') {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history path is not a directory.',
    });
  }
  const canonicalPath = yield* fs.realPath(directory);
  const confirmed = yield* fs.stat(directory);
  if (!sameBuildHistoryDirectoryInfo(info, confirmed)) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history directory changed while freezing.',
    });
  }
  return {
    canonicalPath,
    info,
    path: directory,
  } satisfies FrozenBuildHistoryDirectory;
});

const revalidateBuildHistoryDirectoryAuthority = Effect.fn('codeGraph.buildStatus.revalidateHistoryDirectory')(
  function* (fs: FileSystem.FileSystem, authority: BuildHistoryDirectoryAuthority) {
    for (const frozen of [authority.repositoryRoot, authority.statusRoot, authority.directory]) {
      if (Option.isSome(yield* fs.readLink(frozen.path).pipe(Effect.option))) {
        return yield* InvalidBuildHistorySidecarError.make({
          message: 'Build history directory became a symlink.',
        });
      }
      const current = yield* optionalBuildHistoryFileInfo(fs, frozen.path);
      if (
        current === undefined ||
        !sameBuildHistoryDirectoryInfo(frozen.info, current) ||
        (yield* fs.realPath(frozen.path)) !== frozen.canonicalPath
      ) {
        return yield* InvalidBuildHistorySidecarError.make({
          message: 'Build history directory authority changed.',
        });
      }
    }
  },
);

const readBuildHistoryCandidate = Effect.fn('codeGraph.buildStatus.readHistoryCandidate')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  checkoutId: string,
  worktreeId: string,
) {
  const observed = yield* readBoundedBuildHistorySidecar(fs, file, STATUS_FILE_BYTES_LIMIT);
  if (observed === undefined) return undefined;
  const status = yield* Effect.try({
    try: () => parseCodeGraphBuildStatus(JSON.parse(observed.content)),
    catch: () =>
      InvalidBuildHistorySidecarError.make({
        message: 'Build history status is invalid JSON.',
      }),
  });
  if (
    status === undefined ||
    status.identity.checkoutId !== checkoutId ||
    status.identity.worktreeId !== worktreeId ||
    path.basename(file) !== `${status.buildId}.json`
  ) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history status authority is invalid.',
    });
  }
  return {...observed, status} satisfies BuildHistoryCandidate;
});

const inspectBuildHistoryLock = Effect.fn('codeGraph.buildStatus.inspectHistoryLock')(function* (
  fs: FileSystem.FileSystem,
  lockPath: string,
) {
  if (!(yield* fs.exists(lockPath))) return {state: 'absent'} as const satisfies BuildHistoryLockObservation;
  const owner = yield* readExclusiveFileLockOwner(fs, lockPath);
  return Option.match(owner, {
    onNone: () => ({state: 'unavailable'}) as const,
    onSome: value => ({owner: value, state: 'present'}) as const,
  });
});

const readBuildHistoryManagerContext = Effect.fn('codeGraph.buildStatus.readHistoryManagerContext')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  buildId: string,
) {
  const observed = yield* readBoundedBuildHistorySidecar(fs, file, MANAGER_CONTEXT_FILE_BYTES_LIMIT);
  if (observed === undefined) return undefined;
  const valid = yield* Effect.try({
    try: () => {
      const value: unknown = JSON.parse(observed.content);
      return (
        isRecord(value) &&
        value.schemaVersion === MANAGER_CONTEXT_SCHEMA_VERSION &&
        value.buildId === buildId &&
        isText(value.worktreePath, 4_096) &&
        (value.branch === undefined || isText(value.branch, 1_024))
      );
    },
    catch: () =>
      InvalidBuildHistorySidecarError.make({
        message: 'Build history Manager context is invalid JSON.',
      }),
  });
  if (!valid) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history Manager context is invalid.',
    });
  }
  return observed;
});

const readBoundedBuildHistorySidecar = Effect.fn('codeGraph.buildStatus.readBoundedHistorySidecar')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  bytesLimit: number,
) {
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history sidecar is a symbolic link.',
    });
  }
  const pathInfo = yield* optionalBuildHistoryFileInfo(fs, file);
  if (pathInfo === undefined) return undefined;
  if (pathInfo.type !== 'File' || Number(pathInfo.size) > bytesLimit || (pathInfo.mode & 0o077) !== 0) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history sidecar is not a bounded file.',
    });
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* fs.open(file, {flag: 'r'});
      const openedBefore = yield* opened.stat;
      const pathOpened = yield* fs.stat(file);
      if (!sameBuildHistoryFileInfo(pathInfo, openedBefore) || !sameBuildHistoryFileInfo(pathInfo, pathOpened)) {
        return yield* InvalidBuildHistorySidecarError.make({
          message: 'Build history sidecar changed while opening.',
        });
      }

      const bytes = new Uint8Array(bytesLimit + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Number(yield* opened.read(bytes.subarray(offset)));
        if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - offset) {
          return yield* InvalidBuildHistorySidecarError.make({
            message: 'Build history read size is invalid.',
          });
        }
        if (count === 0) break;
        offset += count;
      }
      const openedAfter = yield* opened.stat;
      const pathAfter = yield* fs.stat(file);
      if (
        !sameBuildHistoryFileInfo(pathInfo, openedAfter) ||
        !sameBuildHistoryFileInfo(pathInfo, pathAfter) ||
        offset > bytesLimit ||
        BigInt(offset) !== pathInfo.size
      ) {
        return yield* InvalidBuildHistorySidecarError.make({
          message: 'Build history sidecar changed during read.',
        });
      }
      const content = yield* Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, offset)),
        catch: () =>
          InvalidBuildHistorySidecarError.make({
            message: 'Build history sidecar is not valid UTF-8.',
          }),
      });
      return {
        content,
        file,
        info: pathInfo,
      } satisfies ObservedBuildHistorySidecar;
    }),
  );
});

const readPersistedBuildHistoryCursor = Effect.fn('codeGraph.buildStatus.readPersistedHistoryCursor')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
) {
  const file = path.join(directory, BUILD_HISTORY_CURSOR_FILE);
  const observed = yield* readBoundedBuildHistorySidecar(fs, file, BUILD_HISTORY_CURSOR_FILE_BYTES_LIMIT);
  if (observed === undefined) return undefined;
  const cursorToken = parsePersistedBuildHistoryCursor(observed.content);
  if (cursorToken === undefined) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history cursor is invalid.',
    });
  }
  return {...observed, cursorToken} satisfies PersistedBuildHistoryCursor;
});

const recoverPersistedBuildHistoryCursor = Effect.fn('codeGraph.buildStatus.recoverPersistedHistoryCursor')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  authority: BuildHistoryDirectoryAuthority,
) {
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  const directory = authority.directory.path;
  const persisted = yield* readPersistedBuildHistoryCursor(fs, path, directory);
  const temporaryFile = path.join(directory, BUILD_HISTORY_CURSOR_TEMPORARY_FILE);
  const temporary = yield* readBoundedBuildHistorySidecar(fs, temporaryFile, BUILD_HISTORY_CURSOR_FILE_BYTES_LIMIT);
  if (temporary === undefined) return persisted;
  if (persisted !== undefined) {
    yield* removeObservedBuildHistorySidecar(fs, authority, temporary);
    return persisted;
  }

  const cursorToken = parsePersistedBuildHistoryCursor(temporary.content);
  if (cursorToken === undefined) {
    yield* removeObservedBuildHistorySidecar(fs, authority, temporary);
    return undefined;
  }
  const concurrent = yield* readPersistedBuildHistoryCursor(fs, path, directory);
  if (concurrent !== undefined) {
    yield* removeObservedBuildHistorySidecar(fs, authority, temporary);
    return concurrent;
  }
  const currentTemporary = yield* readBoundedBuildHistorySidecar(
    fs,
    temporaryFile,
    BUILD_HISTORY_CURSOR_FILE_BYTES_LIMIT,
  );
  if (currentTemporary === undefined || !sameBuildHistorySidecar(temporary, currentTemporary)) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history cursor temporary changed.',
    });
  }
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  yield* fs.rename(temporaryFile, path.join(directory, BUILD_HISTORY_CURSOR_FILE));
  const promoted = yield* readPersistedBuildHistoryCursor(fs, path, directory);
  if (promoted === undefined || promoted.cursorToken !== cursorToken) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history cursor promotion failed.',
    });
  }
  return promoted;
});

const writePersistedBuildHistoryCursor = Effect.fn('codeGraph.buildStatus.writePersistedHistoryCursor')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  authority: BuildHistoryDirectoryAuthority,
  observed: PersistedBuildHistoryCursor | undefined,
  cursorToken: string,
) {
  if (observed?.cursorToken === cursorToken) return;
  if (parseBuildHistoryCursor(cursorToken)?.mode !== 'scan') {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history cursor progress is invalid.',
    });
  }
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  const directory = authority.directory.path;
  const file = path.join(directory, BUILD_HISTORY_CURSOR_FILE);
  const temporary = path.join(directory, BUILD_HISTORY_CURSOR_TEMPORARY_FILE);
  const content = `${JSON.stringify({cursorToken, schemaVersion: BUILD_HISTORY_CURSOR_SCHEMA_VERSION})}\n`;
  if (new TextEncoder().encode(content).byteLength > BUILD_HISTORY_CURSOR_FILE_BYTES_LIMIT) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history cursor exceeded its size limit.',
    });
  }
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
  const latest = yield* readPersistedBuildHistoryCursor(fs, path, directory);
  if (!sameOptionalBuildHistorySidecar(observed, latest)) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history cursor changed before update.',
    });
  }
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  yield* fs.rename(temporary, file);
});

const removePersistedBuildHistoryCursor = Effect.fn('codeGraph.buildStatus.removePersistedHistoryCursor')(function* (
  fs: FileSystem.FileSystem,
  authority: BuildHistoryDirectoryAuthority,
  observed: PersistedBuildHistoryCursor | undefined,
) {
  if (observed === undefined) return;
  yield* removeObservedBuildHistorySidecar(fs, authority, observed);
});

const removeObservedBuildHistorySidecar = Effect.fn('codeGraph.buildStatus.removeObservedHistorySidecar')(function* (
  fs: FileSystem.FileSystem,
  authority: BuildHistoryDirectoryAuthority,
  observed: ObservedBuildHistorySidecar,
) {
  const current = yield* readBoundedBuildHistorySidecar(fs, observed.file, BUILD_HISTORY_CURSOR_FILE_BYTES_LIMIT);
  if (current === undefined || !sameBuildHistorySidecar(observed, current)) {
    return yield* InvalidBuildHistorySidecarError.make({
      message: 'Build history sidecar changed before removal.',
    });
  }
  yield* revalidateBuildHistoryDirectoryAuthority(fs, authority);
  yield* fs.remove(observed.file, {force: false});
});

function parsePersistedBuildHistoryCursor(content: string): string | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) &&
      value.schemaVersion === BUILD_HISTORY_CURSOR_SCHEMA_VERSION &&
      typeof value.cursorToken === 'string' &&
      parseBuildHistoryCursor(value.cursorToken)?.mode === 'scan'
      ? value.cursorToken
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalBuildHistoryFileInfo(fs: FileSystem.FileSystem, file: string) {
  return fs.stat(file).pipe(
    Effect.map(info => info as FileSystem.File.Info | undefined),
    Effect.catchIf(
      error => error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound',
      () => Effect.void,
    ),
  );
}

function sameBuildHistorySidecar(left: ObservedBuildHistorySidecar, right: ObservedBuildHistorySidecar): boolean {
  return left.file === right.file && left.content === right.content && sameBuildHistoryFileInfo(left.info, right.info);
}

function sameOptionalBuildHistorySidecar(
  left: ObservedBuildHistorySidecar | undefined,
  right: ObservedBuildHistorySidecar | undefined,
): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameBuildHistorySidecar(left, right);
}

function sameBuildHistoryFileInfo(left: FileSystem.File.Info, right: FileSystem.File.Info): boolean {
  return (
    left.type === 'File' &&
    right.type === 'File' &&
    left.dev === right.dev &&
    Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino) &&
    left.size === right.size &&
    left.mode === right.mode &&
    Option.getOrUndefined(left.mtime)?.getTime() === Option.getOrUndefined(right.mtime)?.getTime()
  );
}

function sameBuildHistoryDirectoryInfo(left: FileSystem.File.Info, right: FileSystem.File.Info): boolean {
  return (
    left.type === 'Directory' &&
    right.type === 'Directory' &&
    left.dev === right.dev &&
    Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino) &&
    left.mode === right.mode
  );
}

function compareBuildHistoryCandidate(left: BuildHistoryCandidate, right: BuildHistoryCandidate): number {
  const leftModifiedAt = Option.getOrUndefined(left.info.mtime)?.getTime() ?? 0;
  const rightModifiedAt = Option.getOrUndefined(right.info.mtime)?.getTime() ?? 0;
  return (
    rightModifiedAt - leftModifiedAt ||
    Date.parse(right.status.timestamps.updatedAt) - Date.parse(left.status.timestamps.updatedAt) ||
    Effect2.pipe(right.status.buildId, EffectString.localeCompare(left.status.buildId))
  );
}

function parseBuildHistoryCursor(cursorToken: string): BuildHistoryCursor | undefined {
  if (cursorToken === 'bh1:r') return {mode: 'reset'};
  const fields = Effect2.pipe(cursorToken, EffectString.split(':'));
  return fields.length === 3 && fields[0] === 'bh1' && fields[1] === 's' && BUILD_ID.test(fields[2])
    ? {afterBuildId: fields[2], mode: 'scan'}
    : undefined;
}

function buildHistoryResetCursor(): string {
  return 'bh1:r';
}

function buildHistoryScanCursor(buildId: string): string {
  return `bh1:s:${buildId}`;
}

function classifyBuildHistoryFailure(cause: unknown): CodeGraphBuildHistoryPruneResult {
  if (Schema.is(InvalidBuildHistorySidecarError)(cause)) return invalidBuildHistoryResult();
  if (cause instanceof PlatformError.PlatformError && cause.reason._tag === 'PermissionDenied') {
    return {
      blockedCode: 'permission-denied',
      retryAfterMilliseconds: 30_000,
      state: 'deferred',
    };
  }
  return {
    blockedCode: 'io-error',
    retryAfterMilliseconds: BUILD_HISTORY_IO_RETRY_MILLISECONDS,
    state: 'deferred',
  };
}

function invalidBuildHistoryResult(): CodeGraphBuildHistoryPruneResult {
  return {
    blockedCode: 'invalid-sidecar',
    retryAfterMilliseconds: BUILD_HISTORY_INVALID_RETRY_MILLISECONDS,
    state: 'deferred',
  };
}

function regularDirectory(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(directory))) return false;
    if ((yield* fs.readLink(directory).pipe(Effect.option))._tag === 'Some') return false;
    return (yield* fs.stat(directory)).type === 'Directory';
  }).pipe(Effect.orElseSucceed(() => false));
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${Effect2.pipe(value, EffectString.slice(0, Math.max(0, maximum - 1)))}…`;
}
