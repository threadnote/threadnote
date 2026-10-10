import {CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV} from '../scope/routing.js';
import {Clock, Crypto, Effect, FileSystem, Option, Path, Ref, Schema} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {isFileLockTimeout, readExclusiveFileLockOwner, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {pollUntilEffect} from '@threadnote/platform/time';

import {
  CODE_GRAPH_BUILD_HEARTBEAT_INTERVAL_MILLISECONDS,
  CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  currentCodeGraphBuildStatus,
  type CodeGraphBuildStatus,
  type ObservedCodeGraphBuildStatus,
} from '../build_status.js';
import {codeGraphLayout, codeGraphWorktreeSpawnLockPath} from '../layout.js';
import {resolveRepositoryIdentity} from '../repository.js';
import {
  CodeGraphDiskCapacityObservationError,
  CodeGraphDiskCapacityPressureError,
  type CodeGraphProgress,
  type RepositoryIdentity,
} from '../types.js';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {CODE_GRAPH_BUILDER_ADMISSION_CLASS_ENV, type CodeGraphBuilderAdmissionClass} from '../builder/admission.js';
import {CODE_GRAPH_REFRESH_DEMAND_SUPERSEDED_EXIT_CODE, CodeGraphRefreshDemandSuperseded} from '../refresh/demand.js';

class IsolatedBuilderError extends Schema.TaggedError<IsolatedBuilderError>()('IsolatedBuilderError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const isolatedBuilderPromise = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  fromPromiseInterruptible(evaluate, cause =>
    IsolatedBuilderError.make({
      cause,
      message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
  );

/** Match the child heartbeat cadence so MCP does not oversample process-liveness probes. */
export const BUILD_STATUS_POLL_MILLISECONDS = CODE_GRAPH_BUILD_HEARTBEAT_INTERVAL_MILLISECONDS;
/** Give up awaiting a wedged foreign builder after this much continuous stall. */
export const EXISTING_BUILDER_STALLED_TIMEOUT_MILLISECONDS = CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS * 4;
/** Allow an atomically-renamed completion sidecar a short, bounded window to become observable after child exit. */
export const ISOLATED_BUILDER_RESULT_GRACE_MILLISECONDS = 2_000;
export const ISOLATED_BUILDER_RESULT_POLL_MILLISECONDS = 100;
export const ISOLATED_BUILDER_SPAWN_OBSERVATION_MILLISECONDS = 10_000;
export const ISOLATED_BUILDER_SPAWN_LOCK_WAIT_MILLISECONDS = 30_000;
const STDERR_TAIL_LIMIT_BYTES = 4 * 1024;

export interface CodeGraphIsolatedBuilderSpawnPlan {
  readonly arguments: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly executable: string;
}

export interface CodeGraphIsolatedBuilderProcess {
  readonly exited: Promise<number>;
  readonly kill: () => void;
  readonly processId: number;
  readonly stderrTail?: () => string;
}

export type CodeGraphIsolatedBuilderSpawner = (
  plan: CodeGraphIsolatedBuilderSpawnPlan,
) => CodeGraphIsolatedBuilderProcess | Promise<CodeGraphIsolatedBuilderProcess>;

export interface CodeGraphIsolatedBuilderOptions {
  /** Read-only guard that must complete before an isolated child can be observed or spawned. */
  readonly assertRuntimeSchemaCompatible: (databasePath: string) => Effect.Effect<void, unknown>;
  readonly cwd: string;
  readonly admissionClass?: CodeGraphBuilderAdmissionClass;
  /** Forward an explicit clean rebuild to the child CLI. */
  readonly full?: boolean;
  /** Bind Manager's selected manifest and reject configuration drift in the child. */
  readonly manifestPath?: string;
  readonly manifestRevision?: string;
  /** Preserve MCP/workset structural-only indexing unless the caller explicitly enables vectors. */
  readonly noVectors?: boolean;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  /** Carries the configured view through the pre-spawn status/lock routing. */
  readonly project?: Pick<ProjectManifest, 'graph' | 'uri'> & {readonly name?: string};
  /** @internal Deterministic shared-sidecar seam for cross-host spawn tests. */
  readonly readStatus?: Effect.Effect<ObservedCodeGraphBuildStatus | undefined, unknown>;
  /** Privacy-safe build request identity used for exact completed-result reuse. */
  readonly requestKey?: string;
  /** Opaque private coordination claim. Never included in build-status or MCP output. */
  readonly refreshDemandToken?: string;
  /** Resolved opaque view key; absent retains historical full-view sidecars. */
  readonly scopeId?: string;
  /** @internal Deterministic identity seam for pre-spawn compatibility tests. */
  readonly resolveIdentity?: (cwd: string) => Effect.Effect<RepositoryIdentity, unknown>;
  readonly spawn?: CodeGraphIsolatedBuilderSpawner;
  readonly spawnPlan?: (
    system: SystemInfoShape,
    options: {
      readonly admissionClass?: CodeGraphBuilderAdmissionClass;
      readonly cwd: string;
      readonly full?: boolean;
      readonly manifestPath?: string;
      readonly manifestRevision?: string;
      readonly noVectors?: boolean;
      readonly project?: string;
      readonly refreshDemandToken?: string;
      readonly threadnoteHome: string;
    },
  ) => CodeGraphIsolatedBuilderSpawnPlan;
  readonly threadnoteHome: string;
}

export interface CodeGraphIsolatedBuilderResult {
  readonly dirty: boolean;
  readonly edges: number;
  readonly files: number;
  readonly requestKey?: string;
  readonly snapshotId: string;
  readonly symbols: number;
}

function executableBaseName(executablePath: string): string | undefined {
  return executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
}

/** True when this OS process hosts MCP stdio and must not run heavy graph builds in-process. */
export function isCodeGraphIsolatedBuilderHost(
  system: Pick<SystemInfoShape, 'executablePath' | 'processArguments'>,
): boolean {
  const executableName = executableBaseName(system.executablePath);
  if (executableName?.startsWith('threadnote-mcp-server') === true) return true;
  // Mirror apps/threadnote/src/standalone.ts: user args start at argv[2] for both scripts and compiled binaries.
  return system.processArguments.slice(2)[0] === 'mcp-server';
}

/**
 * Re-invoke the current Threadnote entrypoint as a CLI `graph index` child.
 * Uses `--no-vectors` by default so MCP watcher refresh matches in-process `ensureVectors: false`.
 * Never targets the MCP launcher; MCP stdio stays free for recall and other tools.
 * Interrupted MCP hosts detach and leave the child running so a later refresh can re-attach.
 */
export function codeGraphIsolatedBuilderSpawnPlan(
  system: SystemInfoShape,
  options: {
    readonly admissionClass?: CodeGraphBuilderAdmissionClass;
    readonly cwd: string;
    readonly full?: boolean;
    readonly manifestPath?: string;
    readonly manifestRevision?: string;
    readonly noVectors?: boolean;
    readonly project?: string;
    readonly refreshDemandToken?: string;
    readonly threadnoteHome: string;
  },
): CodeGraphIsolatedBuilderSpawnPlan {
  const script = developmentStandaloneScript(system);
  return {
    arguments: [
      ...Option.toArray(script),
      '--home',
      options.threadnoteHome,
      ...(options.manifestPath === undefined ? [] : ['--manifest', options.manifestPath]),
      'graph',
      'index',
      ...(options.full === true ? ['--full'] : []),
      ...(options.noVectors === false ? [] : ['--no-vectors']),
      ...(options.project === undefined ? [] : ['--project', options.project]),
      '--cwd',
      options.cwd,
    ],
    environment: {
      ...system.intendedChildEnvironment(system.environment(), 'graph-builder'),
      [CODE_GRAPH_BUILDER_ADMISSION_CLASS_ENV]: options.admissionClass ?? 'current-required',
      ...(options.refreshDemandToken === undefined
        ? {}
        : {THREADNOTE_CODE_GRAPH_REFRESH_DEMAND_TOKEN: options.refreshDemandToken}),
      [CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV]: options.manifestRevision,
      THREADNOTE_HOME: options.threadnoteHome,
    },
    executable: system.executablePath,
  };
}

/** Reconstruct MCP-facing progress from the child's privacy-safe build-status sidecar. */
export function codeGraphProgressFromBuildStatus(
  status: Pick<
    CodeGraphBuildStatus,
    | 'activation'
    | 'counters'
    | 'materialization'
    | 'phase'
    | 'registration'
    | 'resolution'
    | 'scheduling'
    | 'subphase'
    | 'timings'
  >,
): CodeGraphProgress {
  const counters = status.counters;
  switch (status.phase) {
    case 'registering':
      return {
        ...(status.registration ? {activity: status.registration.activity} : {}),
        phase: 'registering',
      };
    case 'waiting':
      return {
        ...(status.scheduling?.queue && !status.scheduling.admittedAt ? {admission: status.scheduling.queue} : {}),
        phase: 'waiting',
        ...(status.subphase === 'database-writer' ||
        status.subphase === 'disk-capacity' ||
        status.subphase === 'home-builder-cap' ||
        status.subphase === 'repository-lock' ||
        status.subphase === 'request-lock' ||
        status.subphase === 'snapshot-build'
          ? {reason: status.subphase}
          : {}),
      };
    case 'reclaiming':
      return {
        completed: counters.completed ?? 0,
        pagesCompleted: counters.pagesCompleted ?? 0,
        phase: 'reclaiming',
        rowsDeleted: counters.rowsDeleted ?? 0,
        total: counters.total ?? 0,
        unit: 'snapshots',
      };
    case 'scanning':
      return {
        accepted: counters.accepted ?? 0,
        completed: counters.completed ?? 0,
        excluded: counters.excluded ?? 0,
        phase: 'scanning',
        skipped: counters.skipped ?? 0,
        ...(status.timings
          ? {timings: {...status.timings, serializationMilliseconds: status.timings.serializationMilliseconds ?? 0}}
          : {}),
        total: counters.total ?? 0,
        unit: 'files',
      };
    case 'materializing': {
      // Strip persisted-only `startedAt`; keep the progress-facing activity fields.
      const activity = status.materialization?.activity;
      return {
        ...(activity
          ? {
              activity: {
                batchCompleted: activity.batchCompleted,
                batchTotal: activity.batchTotal,
                sourceBytes: activity.sourceBytes,
                stage: activity.stage,
              },
            }
          : {}),
        completed: counters.completed ?? 0,
        ...(status.materialization?.metrics ? {metrics: status.materialization.metrics} : {}),
        phase: 'materializing',
        reused: counters.reused ?? 0,
        total: counters.total ?? 0,
        unit: 'files',
      };
    }
    case 'resolving':
      if (status.subphase === 'complete') {
        return {
          edges: counters.edges ?? 0,
          phase: 'resolving',
          resolved: counters.resolved ?? 0,
          subphase: 'complete',
          symbols: counters.symbols ?? 0,
        };
      }
      return {
        ...(status.resolution?.activity ? {activity: omitStartedAt(status.resolution.activity)} : {}),
        phase: 'resolving',
        subphase: 'references',
      };
    case 'activating':
      return {
        ...(status.activation?.activity ? {activity: omitStartedAt(status.activation.activity)} : {}),
        phase: 'activating',
        // Sidecar has no snapshot id until completion; placeholder is not a durable identity.
        snapshotId: 'building',
        ...(status.subphase === 'complete' ||
        status.subphase === 'promoting' ||
        status.subphase === 'structural-ready' ||
        status.subphase === 'summarizing-analysis' ||
        status.subphase === 'validating-input' ||
        status.subphase === 'writing-and-checkpointing'
          ? {subphase: status.subphase}
          : {}),
      };
    case 'embedding':
      return {
        completed: counters.completed ?? 0,
        embedded: counters.embedded ?? 0,
        phase: 'embedding',
        reused: counters.reused ?? 0,
        total: counters.total ?? 0,
        unit: 'symbols',
      };
    case 'sharing':
      return {
        phase: 'sharing',
        subphase:
          status.subphase === 'applying-deltas' ||
          status.subphase === 'building-local-overlay' ||
          status.subphase === 'discovering-shared-base' ||
          status.subphase === 'downloading-checkpoint'
            ? status.subphase
            : 'discovering-shared-base',
      };
    default: {
      const _exhaustive: never = status.phase;
      throw IsolatedBuilderError.make({message: `Unsupported code graph progress phase: ${String(_exhaustive)}`});
    }
  }
}

/**
 * Run `graph index --no-vectors` in a child CLI process and mirror its build-status sidecar.
 * On interruption the child is detached (not killed) so a later MCP refresh can re-attach.
 */
export const runIsolatedCodeGraphIndex: (
  options: CodeGraphIsolatedBuilderOptions,
) => Effect.Effect<
  CodeGraphIsolatedBuilderResult,
  unknown,
  CommandExecutor | Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo
> = Effect.fn('codeGraph.isolatedBuilder.run')(function* (options: CodeGraphIsolatedBuilderOptions) {
  const system = yield* SystemInfo;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const identity = yield* options.resolveIdentity?.(options.cwd) ?? resolveRepositoryIdentity(options.cwd);
  const layout = codeGraphLayout(
    path,
    options.threadnoteHome,
    identity.checkoutId,
    identity.worktreeId,
    options.scopeId,
  );
  yield* options.assertRuntimeSchemaCompatible(layout.databasePath);
  const plan = (options.spawnPlan ?? codeGraphIsolatedBuilderSpawnPlan)(system, {
    admissionClass: options.admissionClass,
    cwd: options.cwd,
    full: options.full,
    ...(options.manifestPath === undefined ? {} : {manifestPath: options.manifestPath}),
    ...(options.manifestRevision === undefined ? {} : {manifestRevision: options.manifestRevision}),
    noVectors: options.noVectors,
    project: options.project?.name,
    refreshDemandToken: options.refreshDemandToken,
    threadnoteHome: options.threadnoteHome,
  });
  yield* assertIsolatedBuilderPlanEffect(plan);

  const readStatus = options.readStatus ?? currentCodeGraphBuildStatus(layout, identity.worktreeId);
  const spawn = options.spawn ?? spawnIsolatedBuilderProcess;
  const spawnLockPath = codeGraphWorktreeSpawnLockPath(
    path,
    options.threadnoteHome,
    identity.checkoutId,
    identity.worktreeId,
    options.scopeId,
  );
  const admission = yield* withExclusiveFileLock(
    fs,
    spawnLockPath,
    {
      heartbeatIntervalMilliseconds: 5_000,
      recoverReusedProcessIdImmediately: true,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
      useCanonicalProcessStartIdentity: true,
      waitTimeoutMilliseconds: ISOLATED_BUILDER_SPAWN_LOCK_WAIT_MILLISECONDS,
    },
    Effect.gen(function* () {
      const existing = yield* readStatus;
      if (shouldAwaitExistingBuilder(existing, system.processId)) {
        return {
          compatible: isolatedBuilderRequestMatches(existing!, options.requestKey),
          mode: 'attach' as const,
        };
      }
      if (
        existing?.observation.liveness === 'completed' &&
        existing.result &&
        isolatedBuilderRequestMatches(existing, options.requestKey)
      ) {
        return {mode: 'completed' as const, result: existing.result};
      }

      const priorBuildId = existing?.buildId;
      // Detach on interruption: do not kill multi-hour builds when the MCP host goes idle or reconnects.
      const child = yield* isolatedBuilderPromise('Could not spawn isolated code graph builder', () =>
        Promise.resolve(spawn(plan)),
      );
      const startup = yield* Effect.raceFirst(
        pollUntilEffect(statusOwnedBy(readStatus, child.processId, priorBuildId), {
          intervalMs: ISOLATED_BUILDER_RESULT_POLL_MILLISECONDS,
          timeoutMs: ISOLATED_BUILDER_SPAWN_OBSERVATION_MILLISECONDS,
        }).pipe(Effect.map(observed => ({observed, type: 'status' as const}))),
        isolatedBuilderPromise('Could not await isolated code graph builder startup', () => child.exited).pipe(
          Effect.map(exitCode => ({exitCode, type: 'exit' as const})),
        ),
      );
      if (startup.type === 'exit') {
        if (startup.exitCode === CODE_GRAPH_REFRESH_DEMAND_SUPERSEDED_EXIT_CODE)
          return yield* CodeGraphRefreshDemandSuperseded.make({
            message: 'Code graph refresh demand was superseded before build status publication.',
          });
        if (startup.exitCode !== 0)
          return yield* IsolatedBuilderError.make({
            message: isolatedBuilderFailureMessage(startup.exitCode, undefined, child.stderrTail?.()),
          });
        return {compatible: false, mode: 'attach' as const};
      }
      const observed = startup.observed;
      return isolatedBuilderOwnedAdmission(observed, child, priorBuildId);
    }),
  ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed({compatible: false, mode: 'attach' as const})));

  // The spawn lock is released before either branch waits for repository-sized work.
  if (admission.mode === 'completed') {
    return {
      dirty: admission.result.dirty,
      edges: admission.result.edges,
      files: admission.result.files,
      ...(options.requestKey === undefined ? {} : {requestKey: options.requestKey}),
      snapshotId: admission.result.snapshotId,
      symbols: admission.result.symbols,
    };
  }
  if (admission.mode === 'attach') {
    const attached = yield* awaitExistingBuilder(readStatus, options.onProgress, {
      startupGraceMilliseconds: ISOLATED_BUILDER_SPAWN_OBSERVATION_MILLISECONDS,
    });
    if (admission.compatible) return attached;
    // The owner built a different request. Its completed snapshot is now a
    // retained-base candidate; re-enter spawn admission so one waiter applies
    // this request's bounded delta while the rest attach to that new owner.
    return yield* Effect.suspend(() => runIsolatedCodeGraphIndex(options));
  }

  const {child, priorBuildId} = admission;
  const observedBuildId = yield* Ref.make<string | undefined>(undefined);
  if (admission.mode === 'spawned') yield* Ref.set(observedBuildId, admission.observedBuildId);

  const exitCode = yield* Effect.raceFirst(
    isolatedBuilderPromise('Could not await isolated code graph builder', () => child.exited),
    mirrorBuildStatusProgress(
      readStatus,
      child.processId,
      priorBuildId,
      observedBuildId,
      options.onProgress,
      readExclusiveFileLockOwner(fs, layout.databaseWriteLockPath),
    ),
  );

  if (exitCode !== 0) {
    if (exitCode === CODE_GRAPH_REFRESH_DEMAND_SUPERSEDED_EXIT_CODE)
      return yield* CodeGraphRefreshDemandSuperseded.make({message: 'Code graph refresh demand was superseded.'});
    // A failed child is never rescued by a later sidecar; only enrich its failure with the exact owned status.
    const failed = yield* statusOwnedBy(readStatus, child.processId, priorBuildId, yield* Ref.get(observedBuildId));
    return yield* isolatedBuilderFailureFromStatus(
      failed?.error,
      isolatedBuilderFailureMessage(exitCode, failed?.error?.summary, child.stderrTail?.()),
    );
  }

  return yield* awaitOwnedIsolatedBuilderResult(
    readStatus,
    child.processId,
    priorBuildId,
    yield* Ref.get(observedBuildId),
  );
});

/** @internal Pure exit/result contract for unit tests. */
export function isolatedBuilderFailureMessage(
  exitCode: number,
  errorSummary: string | undefined,
  stderrTail: string | undefined,
): string {
  if (errorSummary) return errorSummary;
  const stderr = stderrTail?.trim();
  if (stderr) return `isolated graph index exited with code ${exitCode}: ${stderr.slice(0, 500)}`;
  return `isolated graph index exited with code ${exitCode}`;
}

/** @internal Rehydrates the child's typed capacity failure after the process boundary. */
export function isolatedBuilderFailureFromStatus(
  error: CodeGraphBuildStatus['error'] | undefined,
  fallbackMessage: string,
): IsolatedBuilderError | CodeGraphDiskCapacityObservationError | CodeGraphDiskCapacityPressureError {
  const capacity = error?.capacity;
  if (capacity?.code === 'no-space') {
    return CodeGraphDiskCapacityPressureError.of(capacity.operation, capacity.evidence);
  }
  if (capacity?.code === 'transient-io') {
    return CodeGraphDiskCapacityObservationError.of(capacity.evidence);
  }
  return IsolatedBuilderError.make({message: fallbackMessage});
}

/** @internal Pure success contract for unit tests. */
export function isolatedBuilderResultFromCompletedStatus(
  status: Pick<ObservedCodeGraphBuildStatus, 'request' | 'result'> | undefined,
): Effect.Effect<CodeGraphIsolatedBuilderResult, Error> {
  if (status?.result) {
    return Effect.succeed({
      dirty: status.result.dirty,
      edges: status.result.edges,
      files: status.result.files,
      ...(status.request?.key === undefined ? {} : {requestKey: status.request.key}),
      snapshotId: status.result.snapshotId,
      symbols: status.result.symbols,
    });
  }
  return Effect.fail(
    IsolatedBuilderError.make({message: 'isolated graph index finished without writing a build result'}),
  );
}

/** @internal Bounded completion-sidecar grace used after a successful isolated child exit. */
export function awaitOwnedIsolatedBuilderResult<E, R>(
  readStatus: Effect.Effect<ObservedCodeGraphBuildStatus | undefined, E, R>,
  childProcessId: number,
  priorBuildId: string | undefined,
  observedBuildId?: string,
  options: {
    readonly pollMilliseconds?: number;
    readonly timeoutMilliseconds?: number;
  } = {},
): Effect.Effect<CodeGraphIsolatedBuilderResult, E | Error, R> {
  return Effect.gen(function* () {
    let expectedBuildId = observedBuildId;
    const completed = yield* pollUntilEffect(
      readStatus.pipe(
        Effect.map(status => {
          if (!status || !statusBelongsToChild(status, childProcessId, priorBuildId, expectedBuildId)) {
            return undefined;
          }
          expectedBuildId ??= status.buildId;
          return status.result ? status : undefined;
        }),
      ),
      {
        intervalMs: options.pollMilliseconds ?? ISOLATED_BUILDER_RESULT_POLL_MILLISECONDS,
        timeoutMs: options.timeoutMilliseconds ?? ISOLATED_BUILDER_RESULT_GRACE_MILLISECONDS,
      },
    );
    return yield* isolatedBuilderResultFromCompletedStatus(completed);
  });
}

function omitStartedAt<T extends {readonly startedAt: string}>(value: T): Omit<T, 'startedAt'> {
  const {startedAt: _startedAt, ...rest} = value;
  return rest;
}

export function shouldAwaitExistingBuilder(
  status: ObservedCodeGraphBuildStatus | undefined,
  currentProcessId: number,
): boolean {
  if (!status) return false;
  if (status.observation.liveness !== 'active' && status.observation.liveness !== 'stalled') return false;
  return status.owner.processId !== currentProcessId;
}

export function isolatedBuilderRequestMatches(
  status: Pick<ObservedCodeGraphBuildStatus, 'request'>,
  requestKey: string | undefined,
): boolean {
  return requestKey !== undefined && status.request?.key === requestKey;
}

/** @internal Preserve detached child ownership when status publication is delayed. */
export function isolatedBuilderOwnedAdmission(
  observed: ObservedCodeGraphBuildStatus | undefined,
  child: CodeGraphIsolatedBuilderProcess,
  priorBuildId: string | undefined,
) {
  return observed === undefined
    ? ({child, mode: 'starting', priorBuildId} as const)
    : ({child, mode: 'spawned', observedBuildId: observed.buildId, priorBuildId} as const);
}

export function statusBelongsToChild(
  status: ObservedCodeGraphBuildStatus,
  childProcessId: number,
  priorBuildId: string | undefined,
  expectedBuildId?: string,
): boolean {
  if (status.owner.processId !== childProcessId) return false;
  if (priorBuildId && status.buildId === priorBuildId) return false;
  return expectedBuildId === undefined || status.buildId === expectedBuildId;
}

/** @internal Exported for unit tests. */
export function assertIsolatedBuilderPlan(plan: CodeGraphIsolatedBuilderSpawnPlan): void {
  const executableName = executableBaseName(plan.executable);
  if (executableName?.startsWith('threadnote-mcp-server') === true) {
    throw IsolatedBuilderError.make({message: 'Isolated graph builder must not spawn the MCP launcher executable.'});
  }
  const graphAt = plan.arguments.indexOf('graph');
  if (graphAt < 0 || plan.arguments[graphAt + 1] !== 'index') {
    throw IsolatedBuilderError.make({message: 'Isolated graph builder spawn plan must invoke `graph index`.'});
  }
  if (plan.arguments.slice(0, graphAt).includes('mcp-server')) {
    throw IsolatedBuilderError.make({message: 'Isolated graph builder must not spawn an MCP server child.'});
  }
}

function assertIsolatedBuilderPlanEffect(plan: CodeGraphIsolatedBuilderSpawnPlan) {
  return Effect.try({
    try: () => assertIsolatedBuilderPlan(plan),
    catch: cause =>
      Schema.is(IsolatedBuilderError)(cause)
        ? cause
        : IsolatedBuilderError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
  });
}

function spawnIsolatedBuilderProcess(plan: CodeGraphIsolatedBuilderSpawnPlan): CodeGraphIsolatedBuilderProcess {
  // stdout must stay ignored: the parent's stdout is the MCP JSON-RPC transport.
  const child = Bun.spawn({
    cmd: [plan.executable, ...plan.arguments],
    env: {...plan.environment},
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'ignore',
  });
  const stderrChunks: Uint8Array[] = [];
  let stderrBytes = 0;
  const reader = (async () => {
    try {
      for await (const chunk of child.stderr as AsyncIterable<Uint8Array>) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.byteLength;
        while (stderrBytes > STDERR_TAIL_LIMIT_BYTES && stderrChunks.length > 1) {
          const dropped = stderrChunks.shift();
          if (dropped) stderrBytes -= dropped.byteLength;
        }
      }
    } catch {
      // Child may close stderr before the reader settles.
    }
  })();
  void reader;
  return {
    exited: child.exited,
    kill: () => {
      try {
        child.kill();
      } catch {
        // Native teardown can close the process before kill settles.
      }
    },
    processId: child.pid,
    stderrTail: () => {
      if (stderrChunks.length === 0) return '';
      const merged = new Uint8Array(stderrBytes);
      let offset = 0;
      for (const chunk of stderrChunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(merged);
    },
  };
}

function statusOwnedBy<E, R>(
  readStatus: Effect.Effect<ObservedCodeGraphBuildStatus | undefined, E, R>,
  childProcessId: number,
  priorBuildId: string | undefined,
  expectedBuildId?: string,
) {
  return readStatus.pipe(
    Effect.map(status =>
      status && statusBelongsToChild(status, childProcessId, priorBuildId, expectedBuildId) ? status : undefined,
    ),
  );
}

function awaitExistingBuilder<E, R>(
  readStatus: Effect.Effect<ObservedCodeGraphBuildStatus | undefined, E, R>,
  onProgress: CodeGraphIsolatedBuilderOptions['onProgress'],
  options: {readonly startupGraceMilliseconds?: number} = {},
) {
  return Effect.gen(function* () {
    const stalledStartedAt = yield* Ref.make<number | undefined>(undefined);
    const startedAt = yield* Clock.currentTimeMillis;
    for (;;) {
      const status = yield* readStatus;
      if (!status) {
        const now = yield* Clock.currentTimeMillis;
        if (now - startedAt < (options.startupGraceMilliseconds ?? 0)) {
          yield* emitProgress(onProgress, {phase: 'registering'});
          yield* Effect.sleep(ISOLATED_BUILDER_RESULT_POLL_MILLISECONDS);
          continue;
        }
        return yield* IsolatedBuilderError.make({
          message: 'Existing code graph builder status disappeared before completion.',
        });
      }
      if (status.observation.liveness === 'completed' && status.result) {
        return {
          dirty: status.result.dirty,
          edges: status.result.edges,
          files: status.result.files,
          ...(status.request?.key === undefined ? {} : {requestKey: status.request.key}),
          snapshotId: status.result.snapshotId,
          symbols: status.result.symbols,
        } satisfies CodeGraphIsolatedBuilderResult;
      }
      if (status.observation.liveness === 'completed') {
        return yield* IsolatedBuilderError.make({
          message: 'Existing code graph builder completed without writing a build result.',
        });
      }
      if (status.observation.liveness !== 'active' && status.observation.liveness !== 'stalled') {
        return yield* isolatedBuilderFailureFromStatus(
          status.error,
          status.error?.summary ?? 'Existing code graph builder stopped before completion.',
        );
      }
      if (status.observation.liveness === 'stalled') {
        const now = yield* Clock.currentTimeMillis;
        const started = yield* Ref.modify(stalledStartedAt, current => {
          const next = current ?? now;
          return [next, next] as const;
        });
        if (now - started >= EXISTING_BUILDER_STALLED_TIMEOUT_MILLISECONDS) {
          return yield* IsolatedBuilderError.make({
            message: 'Existing code graph builder stalled without progress; retry the refresh.',
          });
        }
      } else {
        yield* Ref.set(stalledStartedAt, undefined);
      }
      yield* emitProgress(onProgress, codeGraphProgressFromBuildStatus(status));
      yield* Effect.sleep(BUILD_STATUS_POLL_MILLISECONDS);
    }
  });
}

function mirrorBuildStatusProgress<E, R>(
  readStatus: Effect.Effect<ObservedCodeGraphBuildStatus | undefined, E, R>,
  childProcessId: number,
  priorBuildId: string | undefined,
  observedBuildId: Ref.Ref<string | undefined>,
  onProgress: CodeGraphIsolatedBuilderOptions['onProgress'],
  writerOwner: Effect.Effect<Option.Option<{readonly processId: number}>>,
) {
  // Never succeed or fail: only the child's exit should settle the race. Progress errors must not kill the build.
  return Effect.forever(
    Effect.gen(function* () {
      const status = yield* statusOwnedBy(
        readStatus,
        childProcessId,
        priorBuildId,
        yield* Ref.get(observedBuildId),
      ).pipe(Effect.orElseSucceed(() => undefined as ObservedCodeGraphBuildStatus | undefined));
      if (status) {
        yield* Ref.update(observedBuildId, current => current ?? status.buildId);
        yield* emitProgress(onProgress, codeGraphProgressFromBuildStatus(status));
      } else {
        const owner = yield* writerOwner;
        yield* emitProgress(
          onProgress,
          Option.isSome(owner) ? {phase: 'waiting', reason: 'database-writer'} : {phase: 'registering'},
        );
      }
      yield* Effect.sleep(BUILD_STATUS_POLL_MILLISECONDS);
    }).pipe(Effect.ignoreCause),
  );
}

function emitProgress(onProgress: CodeGraphIsolatedBuilderOptions['onProgress'], progress: CodeGraphProgress) {
  return onProgress?.(progress) ?? Effect.void;
}

/** @internal Resolve the development script prefix used by isolated exact-runtime children. */
export function developmentStandaloneScript(system: SystemInfoShape): Option.Option<string> {
  const executableName = executableBaseName(system.executablePath);
  if (executableName !== 'bun' && executableName !== 'bun.exe') return Option.none();
  const candidate = system.processArguments[1];
  if (candidate && /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/i.test(candidate)) {
    return Option.some(candidate);
  }
  return Option.some(system.developmentEntrypoint);
}
