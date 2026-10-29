import {Array as EffectArray} from 'effect';
import {Clock, Crypto, DateTime, Effect, FileSystem, Option, Path, Predicate, Schema, Stdio, Stream} from 'effect';
import {CommandExecutor, type CommandExecutionError} from '@threadnote/platform/command';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runtimeTextDirectoryNamePage, SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {CODE_GRAPH_COMPACTION_WORKER_ARGUMENT} from '@threadnote/graph/worker_protocol';
import {
  CODE_GRAPH_AUTOMATIC_COMPACTION_COOLDOWN_MILLISECONDS,
  CODE_GRAPH_AUTOMATIC_COMPACTION_DEFERRED_COOLDOWN_MILLISECONDS,
  CODE_GRAPH_AUTOMATIC_COMPACTION_FAILURE_COOLDOWN_MILLISECONDS,
  CODE_GRAPH_AUTOMATIC_COMPACTION_LOW_YIELD_BYTES,
  CODE_GRAPH_AUTOMATIC_COMPACTION_LOW_YIELD_COOLDOWN_MILLISECONDS,
  claimCodeGraphAutomaticCompactionCandidate,
  codeGraphAutomaticCompactionCandidateAllowed,
  codeGraphAutomaticCompactionCooldownMilliseconds,
  recordCodeGraphAutomaticCompactionAttempt,
} from './compaction_receipt.js';
import {codeGraphAutomaticCompactionSchedulerLockPath, codeGraphRepositoriesRoot} from '../layout.js';
import {compareCodeUnits} from '../ordering.js';
import {CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES} from '../store/session.js';
import {CODE_GRAPH_SCHEMA_VERSION} from '../types.js';
import {
  codeGraphCompactionRequiredFreeBytes,
  compactCodeGraphStorage,
  inspectCodeGraphStorage,
  type CodeGraphActiveStorage,
  type CodeGraphCompactionSummary,
} from '../storage.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class CodeGraphAutomaticCompactionError extends Schema.TaggedError<
  CodeGraphAutomaticCompactionError,
  {readonly brand: unique symbol}
>()('CodeGraphAutomaticCompactionError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export const CODE_GRAPH_AUTOMATIC_COMPACTION_INITIAL_DELAY_MILLISECONDS = 15_000;
export const CODE_GRAPH_AUTOMATIC_COMPACTION_INTERVAL_MILLISECONDS = 60_000;
export const CODE_GRAPH_AUTOMATIC_COMPACTION_LEADERSHIP_RETRY_MILLISECONDS = 60_000;
export const CODE_GRAPH_AUTOMATIC_COMPACTION_DATABASE_LIMIT = 128;
const CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL = 1;
export const CODE_GRAPH_AUTOMATIC_COMPACTION_INPUT_BYTES_MAXIMUM = 16 * 1_024;
const CODE_GRAPH_AUTOMATIC_COMPACTION_OUTPUT_BYTES_MAXIMUM = 4 * 1_024;
const CODE_GRAPH_AUTOMATIC_COMPACTION_SCHEDULER_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 20_000,
  recoverReusedProcessIdImmediately: true,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 60_000,
  useCanonicalProcessStartIdentity: true,
  waitTimeoutMilliseconds: 0,
  windowsSharingViolationRetryLimit: 4,
} as const;

export {
  CODE_GRAPH_AUTOMATIC_COMPACTION_COOLDOWN_MILLISECONDS,
  CODE_GRAPH_AUTOMATIC_COMPACTION_DEFERRED_COOLDOWN_MILLISECONDS,
  CODE_GRAPH_AUTOMATIC_COMPACTION_FAILURE_COOLDOWN_MILLISECONDS,
  CODE_GRAPH_AUTOMATIC_COMPACTION_LOW_YIELD_BYTES,
  CODE_GRAPH_AUTOMATIC_COMPACTION_LOW_YIELD_COOLDOWN_MILLISECONDS,
  claimCodeGraphAutomaticCompactionCandidate,
  codeGraphAutomaticCompactionCandidateAllowed,
  codeGraphAutomaticCompactionCooldownMilliseconds,
  recordCodeGraphAutomaticCompactionAttempt,
};

export interface CodeGraphAutomaticCompactionCandidate {
  readonly checkoutId: string;
  /** `journal` is checkpoint-only; `compact` retains the established VACUUM path. */
  readonly operation?: 'compact' | 'journal';
  readonly opportunityBytes: number;
  readonly opportunityRatio: number;
}

export interface CodeGraphAutomaticCompactionResult {
  readonly action: CodeGraphCompactionSummary['action'];
  readonly checkoutId: string;
  readonly reason?: CodeGraphCompactionSummary['reason'];
  readonly reclaimedBytes: number;
}

export type CodeGraphAutomaticCompactionStatus =
  | {readonly state: 'idle'}
  | {readonly startedAt: string; readonly state: 'inspecting'}
  | {
      readonly checkoutId: string;
      readonly opportunityBytes: number;
      readonly startedAt: string;
      readonly state: 'running';
    }
  | {
      readonly action: 'no-candidate' | 'not-needed' | 'missing';
      readonly completedAt: string;
      readonly inspected: number;
      readonly inspectionFailures: number;
      readonly state: 'completed';
    }
  | {
      readonly action: 'compacted';
      readonly checkoutId: string;
      readonly completedAt: string;
      readonly reclaimedBytes: number;
      readonly startedAt: string;
      readonly state: 'completed';
    }
  | {
      readonly checkoutId: string;
      readonly completedAt: string;
      readonly reason: 'active-build' | 'active-maintenance';
      readonly startedAt: string;
      readonly state: 'deferred';
    }
  | {
      readonly checkoutId?: string;
      readonly completedAt: string;
      readonly reason: 'compaction-failed' | 'inspection-failed';
      readonly startedAt: string;
      readonly state: 'failed';
    };

interface CodeGraphAutomaticCompactionWorkerRequest {
  readonly checkoutId: string;
  readonly force: boolean;
  readonly operation: 'compact' | 'journal' | 'probe';
  readonly protocol: 1;
  readonly threadnoteHome: string;
}

type CodeGraphAutomaticCompactionWorkerResponse =
  | {readonly ok: false; readonly protocol: 1}
  | {readonly ok: true; readonly protocol: 1; readonly result: CodeGraphAutomaticCompactionResult};

function automaticCompactionHasDiskHeadroom(storage: CodeGraphActiveStorage): boolean {
  return (
    storage.availableBytes !== undefined && storage.availableBytes >= codeGraphCompactionRequiredFreeBytes(storage)
  );
}

export interface CodeGraphAutomaticCompactionDependencies<R = never> {
  readonly candidateAllowed?: (
    threadnoteHome: string,
    candidate: CodeGraphAutomaticCompactionCandidate,
  ) => Effect.Effect<boolean, never, R>;
  readonly compact: (
    threadnoteHome: string,
    checkoutId: string,
    options?: {readonly operation: 'compact' | 'journal'},
  ) => Effect.Effect<CodeGraphAutomaticCompactionResult, unknown, R>;
  readonly claimCandidate?: (
    threadnoteHome: string,
    candidate: CodeGraphAutomaticCompactionCandidate,
  ) => Effect.Effect<boolean, never, R>;
  readonly inspect: (
    threadnoteHome: string,
    checkoutId: string,
  ) => Effect.Effect<CodeGraphActiveStorage | {readonly state: 'missing'}, unknown, R>;
  readonly listCheckoutIds: (threadnoteHome: string) => Effect.Effect<readonly string[], unknown, R>;
  readonly onCandidate?: (candidate: CodeGraphAutomaticCompactionCandidate) => Effect.Effect<void, never, R>;
  readonly recordAttempt?: (
    threadnoteHome: string,
    candidate: CodeGraphAutomaticCompactionCandidate,
    result: CodeGraphAutomaticCompactionResult | undefined,
  ) => Effect.Effect<void, never, R>;
}

export type CodeGraphAutomaticCompactionPassResult =
  | {
      readonly inspected: number;
      readonly inspectionFailures: number;
      readonly nextOffset: number;
      readonly state: 'no-candidate';
    }
  | {
      readonly candidate: CodeGraphAutomaticCompactionCandidate;
      readonly inspected: number;
      readonly inspectionFailures: number;
      readonly nextOffset: number;
      readonly result: CodeGraphAutomaticCompactionResult;
      readonly state: 'attempted';
    };

/** Select one largest reviewed reclaim opportunity; ties are stable across enumeration order. */
export function selectCodeGraphAutomaticCompactionCandidate(
  candidates: readonly CodeGraphAutomaticCompactionCandidate[],
): CodeGraphAutomaticCompactionCandidate | undefined {
  return [...candidates].sort(
    (left, right) =>
      right.opportunityBytes - left.opportunityBytes ||
      right.opportunityRatio - left.opportunityRatio ||
      compareCodeUnits(left.checkoutId, right.checkoutId),
  )[0];
}

/** @internal Rotate by one so every database eventually enters the bounded inspection window. */
export function codeGraphAutomaticCompactionCheckoutWindow(
  allCheckoutIds: readonly string[],
  offset: number,
): {readonly checkoutIds: readonly string[]; readonly nextOffset: number} {
  if (allCheckoutIds.length === 0) return {checkoutIds: [], nextOffset: 0};
  const normalizedOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset % allCheckoutIds.length : 0;
  const rotatedCheckoutIds = [...allCheckoutIds.slice(normalizedOffset), ...allCheckoutIds.slice(0, normalizedOffset)];
  return {
    checkoutIds: rotatedCheckoutIds.slice(0, CODE_GRAPH_AUTOMATIC_COMPACTION_DATABASE_LIMIT),
    nextOffset: (normalizedOffset + 1) % allCheckoutIds.length,
  };
}

export const runCodeGraphAutomaticCompactionPassWith = Effect.fn('codeGraph.automaticCompactionPassWith')(function* <R>(
  dependencies: CodeGraphAutomaticCompactionDependencies<R>,
  threadnoteHome: string,
  options: {readonly offset?: number} = {},
) {
  const allCheckoutIds = EffectArray.filter(
    [...new Set(yield* dependencies.listCheckoutIds(threadnoteHome))],
    checkoutId => /^[0-9a-f]{64}$/u.test(checkoutId),
  ).sort(compareCodeUnits);
  const offset =
    allCheckoutIds.length === 0 || !Number.isSafeInteger(options.offset) || (options.offset ?? 0) < 0
      ? 0
      : (options.offset ?? 0) % allCheckoutIds.length;
  const {checkoutIds, nextOffset} = codeGraphAutomaticCompactionCheckoutWindow(allCheckoutIds, offset);
  const observations = yield* Effect.forEach(
    checkoutIds,
    checkoutId =>
      dependencies.inspect(threadnoteHome, checkoutId).pipe(
        Effect.map(storage => ({checkoutId, storage})),
        Effect.orElseSucceed(() => undefined),
      ),
    {concurrency: 2},
  );
  const inspectionFailures = EffectArray.filter(observations, observation => observation === undefined).length;
  const rankedCandidates = [
    ...EffectArray.flatMap(observations, observation => {
      if (observation === undefined || observation.storage.state !== 'available') {
        return [];
      }
      // A checkpoint can reclaim WAL allocation, but cannot shrink a dormant
      // rollback journal. Writers bound that separately with journal_size_limit.
      const reclaimableSidecarBytes = observation.storage.walBytes;
      const pageStorage = observation.storage.pageStorage;
      const vacuumOpportunity =
        pageStorage.state === 'available' &&
        pageStorage.threshold.reason === 'freelist' &&
        automaticCompactionHasDiskHeadroom(observation.storage)
          ? {bytes: pageStorage.reclaimableBytes, ratio: pageStorage.reclaimableRatio}
          : undefined;
      const requiresJournalReclamation = reclaimableSidecarBytes > CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES;
      if (vacuumOpportunity === undefined && !requiresJournalReclamation) return [];
      return [
        {
          checkoutId: observation.checkoutId,
          operation: vacuumOpportunity ? 'compact' : 'journal',
          opportunityBytes: vacuumOpportunity
            ? vacuumOpportunity.bytes
            : reclaimableSidecarBytes - CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES,
          opportunityRatio: vacuumOpportunity
            ? vacuumOpportunity.ratio
            : reclaimableSidecarBytes / Math.max(1, observation.storage.filesystemBytes),
        } satisfies CodeGraphAutomaticCompactionCandidate,
      ];
    }),
  ].sort(
    (left, right) =>
      right.opportunityBytes - left.opportunityBytes ||
      right.opportunityRatio - left.opportunityRatio ||
      compareCodeUnits(left.checkoutId, right.checkoutId),
  );
  let candidate: CodeGraphAutomaticCompactionCandidate | undefined;
  for (const ranked of rankedCandidates) {
    if (yield* dependencies.candidateAllowed?.(threadnoteHome, ranked) ?? Effect.succeed(true)) {
      candidate = ranked;
      break;
    }
  }
  const inspected = checkoutIds.length - inspectionFailures;
  if (candidate === undefined) {
    return {
      inspected,
      inspectionFailures,
      nextOffset,
      state: 'no-candidate',
    } satisfies CodeGraphAutomaticCompactionPassResult;
  }
  const claimed = yield* dependencies.claimCandidate?.(threadnoteHome, candidate) ?? Effect.succeed(true);
  if (!claimed) {
    return {
      inspected,
      inspectionFailures,
      nextOffset,
      state: 'no-candidate',
    } satisfies CodeGraphAutomaticCompactionPassResult;
  }
  yield* dependencies.onCandidate?.(candidate) ?? Effect.void;
  const result = yield* dependencies
    .compact(threadnoteHome, candidate.checkoutId, {operation: candidate.operation ?? 'compact'})
    .pipe(Effect.tapError(() => dependencies.recordAttempt?.(threadnoteHome, candidate, undefined) ?? Effect.void));
  yield* dependencies.recordAttempt?.(threadnoteHome, candidate, result) ?? Effect.void;
  return {
    candidate,
    inspected,
    inspectionFailures,
    nextOffset,
    result,
    state: 'attempted',
  } satisfies CodeGraphAutomaticCompactionPassResult;
});

/** Run synchronous SQLite VACUUM in a killable child so Manager's event loop remains responsive. */
export const compactCodeGraphStorageIsolated: (
  threadnoteHome: string,
  checkoutId: string,
  options?: {readonly force?: boolean; readonly operation?: 'compact' | 'journal' | 'probe'},
) => Effect.Effect<
  CodeGraphAutomaticCompactionResult,
  CodeGraphAutomaticCompactionError | CommandExecutionError,
  CommandExecutor | SystemInfo
> = Effect.fn('codeGraph.compactStorageIsolated')(function* (
  threadnoteHome: string,
  checkoutId: string,
  options: {readonly force?: boolean; readonly operation?: 'compact' | 'journal' | 'probe'} = {},
) {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const invocation = codeGraphAutomaticCompactionWorkerInvocation(system);
  const request = {
    checkoutId,
    force: options.force === true,
    operation: options.operation ?? 'compact',
    protocol: CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL,
    threadnoteHome,
  } satisfies CodeGraphAutomaticCompactionWorkerRequest;
  const environment = automaticCompactionWorkerEnvironment(system.environment(), threadnoteHome);
  const result = yield* command.execute(invocation.executable, invocation.arguments, {
    env: environment,
    input: new TextEncoder().encode(`${JSON.stringify(request)}\n`),
    maxOutputBytes: CODE_GRAPH_AUTOMATIC_COMPACTION_OUTPUT_BYTES_MAXIMUM,
    timeoutMs: 0,
  });
  const response = decodeAutomaticCompactionWorkerResponse(result.stdout, checkoutId);
  if (response === undefined || !response.ok) {
    return yield* CodeGraphAutomaticCompactionError.make({message: 'Isolated code graph compaction failed.'});
  }
  return response.result;
});

/** @internal Preserve only host variables required to bootstrap the same-privilege worker. */
export function automaticCompactionWorkerEnvironment(
  source: NodeJS.ProcessEnv,
  threadnoteHome: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    THREADNOTE_CODE_GRAPH_COMPACTION_WORKER: '1',
    THREADNOTE_HOME: threadnoteHome,
  };
  for (const key of [
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'PATH',
    'PATHEXT',
    'ComSpec',
    'COMSPEC',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
  ] as const) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export const runCodeGraphAutomaticCompactionPass = Effect.fn('codeGraph.automaticCompactionPass')(function* (
  threadnoteHome: string,
  options: {
    readonly offset?: number;
    readonly onCandidate?: (candidate: CodeGraphAutomaticCompactionCandidate) => Effect.Effect<void>;
  } = {},
) {
  const dependencies = productionAutomaticCompactionDependencies(options.onCandidate);
  return yield* runCodeGraphAutomaticCompactionPassWith(dependencies, threadnoteHome, options);
});

export const runCodeGraphAutomaticCompactionLoopWith = Effect.fn('codeGraph.automaticCompactionLoopWith')(function* <R>(
  dependencies: CodeGraphAutomaticCompactionDependencies<R>,
  threadnoteHome: string,
  onStatus: (status: CodeGraphAutomaticCompactionStatus) => Effect.Effect<void, never, R>,
  timing: {
    readonly initialDelayMilliseconds?: number;
    readonly intervalMilliseconds?: number;
  } = {},
) {
  yield* Effect.sleep(timing.initialDelayMilliseconds ?? CODE_GRAPH_AUTOMATIC_COMPACTION_INITIAL_DELAY_MILLISECONDS);
  let offset = 0;
  while (true) {
    const startedAtMilliseconds = yield* Clock.currentTimeMillis;
    const startedAt = DateTime.formatIso(DateTime.makeUnsafe(startedAtMilliseconds));
    yield* onStatus({startedAt, state: 'inspecting'});
    let attemptedCandidate: CodeGraphAutomaticCompactionCandidate | undefined;
    const outcome: CodeGraphAutomaticCompactionPassResult | undefined = yield* runCodeGraphAutomaticCompactionPassWith(
      {
        ...dependencies,
        onCandidate: candidate =>
          Effect.gen(function* () {
            attemptedCandidate = candidate;
            yield* dependencies.onCandidate?.(candidate) ?? Effect.void;
            yield* onStatus({
              checkoutId: candidate.checkoutId,
              opportunityBytes: candidate.opportunityBytes,
              startedAt,
              state: 'running',
            });
          }),
      },
      threadnoteHome,
      {offset},
    ).pipe(Effect.match({onFailure: () => undefined, onSuccess: result => result}));
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    if (outcome === undefined) {
      yield* onStatus({
        ...(attemptedCandidate === undefined ? {} : {checkoutId: attemptedCandidate.checkoutId}),
        completedAt,
        reason: attemptedCandidate === undefined ? 'inspection-failed' : 'compaction-failed',
        startedAt,
        state: 'failed',
      });
    } else {
      offset = outcome.nextOffset;
      if (outcome.state === 'no-candidate') {
        yield* onStatus(
          outcome.inspected === 0 && outcome.inspectionFailures > 0
            ? {completedAt, reason: 'inspection-failed', startedAt, state: 'failed'}
            : {
                action: 'no-candidate',
                completedAt,
                inspected: outcome.inspected,
                inspectionFailures: outcome.inspectionFailures,
                state: 'completed',
              },
        );
      } else if (outcome.result.action === 'deferred') {
        yield* onStatus({
          checkoutId: outcome.candidate.checkoutId,
          completedAt,
          reason: outcome.result.reason ?? 'active-maintenance',
          startedAt,
          state: 'deferred',
        });
      } else if (outcome.result.action === 'compacted') {
        yield* onStatus({
          action: 'compacted',
          checkoutId: outcome.candidate.checkoutId,
          completedAt,
          reclaimedBytes: outcome.result.reclaimedBytes,
          startedAt,
          state: 'completed',
        });
      } else {
        yield* onStatus({
          action: outcome.result.action === 'would-compact' ? 'not-needed' : outcome.result.action,
          completedAt,
          inspected: outcome.inspected,
          inspectionFailures: outcome.inspectionFailures,
          state: 'completed',
        });
      }
    }
    yield* Effect.sleep(timing.intervalMilliseconds ?? CODE_GRAPH_AUTOMATIC_COMPACTION_INTERVAL_MILLISECONDS);
  }
});

/**
 * Manager is a long-lived, user-visible owner for safe opportunistic compaction.
 * Each pass attempts at most one database and the storage boundary independently
 * fences active builders, maintenance, snapshot receipts, and disk headroom.
 */
export const runCodeGraphAutomaticCompactionLoop = Effect.fn('codeGraph.automaticCompactionLoop')(function* (
  threadnoteHome: string,
  onStatus: (status: CodeGraphAutomaticCompactionStatus) => Effect.Effect<void> = () => Effect.void,
) {
  return yield* runCodeGraphAutomaticCompactionLoopWith(
    productionAutomaticCompactionDependencies(),
    threadnoteHome,
    onStatus,
  );
});

/**
 * Keep the bounded home-wide inventory single-owner across Manager and MCP
 * processes. Contenders never inspect storage and retry after a bounded delay
 * so they can take over when the owner exits.
 */
export const runCodeGraphAutomaticCompactionSchedulerWith = Effect.fn('codeGraph.automaticCompactionSchedulerWith')(
  function* <R>(
    dependencies: CodeGraphAutomaticCompactionDependencies<R>,
    threadnoteHome: string,
    onStatus: (status: CodeGraphAutomaticCompactionStatus) => Effect.Effect<void, never, R>,
    timing: {
      readonly initialDelayMilliseconds?: number;
      readonly intervalMilliseconds?: number;
      readonly leadershipRetryMilliseconds?: number;
    } = {},
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const retryMilliseconds =
      timing.leadershipRetryMilliseconds ?? CODE_GRAPH_AUTOMATIC_COMPACTION_LEADERSHIP_RETRY_MILLISECONDS;
    const lockPath = codeGraphAutomaticCompactionSchedulerLockPath(path, threadnoteHome);
    while (true) {
      const led = yield* withExclusiveFileLock(
        fs,
        lockPath,
        CODE_GRAPH_AUTOMATIC_COMPACTION_SCHEDULER_LOCK_OPTIONS,
        runCodeGraphAutomaticCompactionLoopWith(dependencies, threadnoteHome, onStatus, timing).pipe(Effect.as(true)),
      ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed(false)));
      if (led) return;
      yield* Effect.sleep(retryMilliseconds);
    }
  },
);

/** Start the recoverable, cross-process automatic-compaction scheduler. */
export const runCodeGraphAutomaticCompactionScheduler = Effect.fn('codeGraph.automaticCompactionScheduler')(function* (
  threadnoteHome: string,
  onStatus: (status: CodeGraphAutomaticCompactionStatus) => Effect.Effect<void> = () => Effect.void,
) {
  return yield* runCodeGraphAutomaticCompactionSchedulerWith(
    productionAutomaticCompactionDependencies(),
    threadnoteHome,
    onStatus,
  );
});

function productionAutomaticCompactionDependencies(
  onCandidate?: (candidate: CodeGraphAutomaticCompactionCandidate) => Effect.Effect<void>,
): CodeGraphAutomaticCompactionDependencies<
  CommandExecutor | Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo
> {
  return {
    candidateAllowed: codeGraphAutomaticCompactionCandidateAllowed,
    claimCandidate: claimCodeGraphAutomaticCompactionCandidate,
    compact: compactCodeGraphStorageIsolated,
    inspect: (home, checkoutId) => inspectCodeGraphStorage(home, checkoutId),
    listCheckoutIds: listCodeGraphAutomaticCompactionCheckoutIds,
    onCandidate,
    recordAttempt: recordCodeGraphAutomaticCompactionAttempt,
  };
}

/** @internal Bounded inventory; overflow is explicit instead of silently starving tail repositories. */
export const listCodeGraphAutomaticCompactionCheckoutIds = Effect.fn('codeGraph.listAutomaticCompactionCheckoutIds')(
  function* (threadnoteHome: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
    if (Option.isSome(yield* fs.readLink(repositories).pipe(Effect.option))) {
      return yield* CodeGraphAutomaticCompactionError.make({
        message: 'Code graph repository storage is not a directory.',
      });
    }
    if (!(yield* fs.exists(repositories))) return [];
    const page = yield* runtimeTextDirectoryNamePage(repositories, CODE_GRAPH_AUTOMATIC_COMPACTION_DATABASE_LIMIT);
    if (page.overflow) {
      return yield* CodeGraphAutomaticCompactionError.make({
        message: 'Automatic code graph compaction inventory exceeded its bounded repository limit.',
      });
    }
    const checkoutIds: string[] = [];
    const pageNames = page.names;
    for (const checkoutId of EffectArray.filter(
      pageNames,
      (name, __effectArrayIndex) => __effectArrayIndex in pageNames && /^[0-9a-f]{64}$/u.test(name),
    ).sort(compareCodeUnits)) {
      const repositoryRoot = path.join(repositories, checkoutId);
      if (Option.isSome(yield* fs.readLink(repositoryRoot).pipe(Effect.option))) continue;
      const repositoryInfo = yield* fs.stat(repositoryRoot).pipe(Effect.option);
      if (Option.isNone(repositoryInfo) || repositoryInfo.value.type !== 'Directory') continue;
      const database = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      if (Option.isSome(yield* fs.readLink(database).pipe(Effect.option))) continue;
      const databaseInfo = yield* fs.stat(database).pipe(Effect.option);
      if (Option.isSome(databaseInfo) && databaseInfo.value.type === 'File') checkoutIds.push(checkoutId);
    }
    return checkoutIds;
  },
);

/** Internal standalone worker. Synchronous SQLite work stays outside Manager's JS event loop. */
export const codeGraphAutomaticCompactionWorkerProgram = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const content = yield* readBoundedAutomaticCompactionWorkerInput(stdio);
  const request = decodeAutomaticCompactionWorkerRequest(content);
  let response: CodeGraphAutomaticCompactionWorkerResponse;
  if (request === undefined) {
    response = {ok: false, protocol: CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL};
  } else if (request.operation === 'probe') {
    response = yield* compactCodeGraphStorage(request.threadnoteHome, request.checkoutId, {
      dryRun: true,
      force: request.force,
    }).pipe(
      Effect.map(automaticCompactionResult),
      Effect.match({onFailure: automaticCompactionWorkerFailure, onSuccess: automaticCompactionWorkerSuccess}),
    );
  } else {
    response = yield* compactCodeGraphStorage(request.threadnoteHome, request.checkoutId, {
      dryRun: false,
      force: request.force,
      ...(request.operation === 'journal' ? {operation: 'automatic-journal' as const} : {}),
    }).pipe(
      Effect.map(automaticCompactionResult),
      Effect.match({onFailure: automaticCompactionWorkerFailure, onSuccess: automaticCompactionWorkerSuccess}),
    );
  }
  yield* Stream.run(
    Stream.make(new TextEncoder().encode(`${JSON.stringify(response)}\n`)),
    stdio.stdout({endOnDone: false}),
  );
}).pipe(Effect.ignore);

function automaticCompactionWorkerFailure(): CodeGraphAutomaticCompactionWorkerResponse {
  return {ok: false, protocol: CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL};
}

function automaticCompactionWorkerSuccess(
  result: CodeGraphAutomaticCompactionResult,
): CodeGraphAutomaticCompactionWorkerResponse {
  return {ok: true, protocol: CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL, result};
}

function automaticCompactionResult(summary: CodeGraphCompactionSummary): CodeGraphAutomaticCompactionResult {
  return {
    action: summary.action,
    checkoutId: summary.checkoutId,
    ...(summary.reason === undefined ? {} : {reason: summary.reason}),
    reclaimedBytes: summary.reclaimedBytes,
  };
}

function readBoundedAutomaticCompactionWorkerInput(stdio: Stdio.Stdio): Effect.Effect<string, Error> {
  const encoder = new TextEncoder();
  return stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => ({chunks: [] as string[], size: 0}),
      (state, chunk) => {
        const size = state.size + encoder.encode(chunk).byteLength;
        if (size > CODE_GRAPH_AUTOMATIC_COMPACTION_INPUT_BYTES_MAXIMUM) {
          return Effect.fail(
            CodeGraphAutomaticCompactionError.make({message: 'Code graph compaction request was too large.'}),
          );
        }
        state.chunks.push(chunk);
        return Effect.succeed({chunks: state.chunks, size});
      },
    ),
    Effect.map(state => EffectArray.join(state.chunks, '')),
  );
}

/** @internal Strict worker protocol decoder used by focused transport tests. */
export function decodeAutomaticCompactionWorkerRequest(
  content: string,
): CodeGraphAutomaticCompactionWorkerRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(Effect2.pipe(content, EffectString.trim));
    if (!Predicate.isObject(parsed)) return undefined;
    const record = parsed;
    if (
      record.protocol !== CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL ||
      typeof record.threadnoteHome !== 'string' ||
      record.threadnoteHome.length === 0 ||
      record.threadnoteHome.length > 8_192 ||
      Effect2.pipe(record.threadnoteHome, EffectString.includes('\0')) ||
      !automaticCompactionAbsolutePath(record.threadnoteHome) ||
      typeof record.checkoutId !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(record.checkoutId) ||
      typeof record.force !== 'boolean' ||
      !isAutomaticCompactionOperation(record.operation)
    ) {
      return undefined;
    }
    return {
      checkoutId: record.checkoutId,
      force: record.force,
      operation: record.operation,
      protocol: CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL,
      threadnoteHome: record.threadnoteHome,
    };
  } catch {
    return undefined;
  }
}

/** @internal Strict worker protocol decoder used by focused transport tests. */
export function decodeAutomaticCompactionWorkerResponse(
  content: string,
  expectedCheckoutId?: string,
): CodeGraphAutomaticCompactionWorkerResponse | undefined {
  try {
    const parsed: unknown = JSON.parse(Effect2.pipe(content, EffectString.trim));
    if (!Predicate.isObject(parsed)) return undefined;
    const record = parsed;
    if (record.protocol !== CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL || typeof record.ok !== 'boolean') {
      return undefined;
    }
    if (!record.ok) return {ok: false, protocol: CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL};
    if (!Predicate.isObject(record.result)) return undefined;
    const result = record.result;
    if (
      !isAutomaticCompactionAction(result.action) ||
      typeof result.checkoutId !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(result.checkoutId) ||
      (expectedCheckoutId !== undefined && result.checkoutId !== expectedCheckoutId) ||
      typeof result.reclaimedBytes !== 'number' ||
      !Number.isSafeInteger(result.reclaimedBytes) ||
      result.reclaimedBytes < 0 ||
      (result.reason !== undefined && !isAutomaticCompactionReason(result.reason)) ||
      (result.action === 'deferred' ? result.reason === undefined : result.reason !== undefined)
    ) {
      return undefined;
    }
    return {
      ok: true,
      protocol: CODE_GRAPH_AUTOMATIC_COMPACTION_PROTOCOL,
      result: {
        action: result.action,
        checkoutId: result.checkoutId,
        ...(result.reason === undefined ? {} : {reason: result.reason}),
        reclaimedBytes: result.reclaimedBytes,
      },
    };
  } catch {
    return undefined;
  }
}

function automaticCompactionAbsolutePath(value: string): boolean {
  return (
    Effect2.pipe(value, EffectString.startsWith('/')) ||
    Effect2.pipe(value, EffectString.startsWith('\\\\')) ||
    /^[A-Za-z]:[/\\]/u.test(value)
  );
}

function isAutomaticCompactionAction(value: unknown): value is CodeGraphAutomaticCompactionResult['action'] {
  return (
    value === 'compacted' ||
    value === 'deferred' ||
    value === 'missing' ||
    value === 'not-needed' ||
    value === 'would-compact'
  );
}

function isAutomaticCompactionOperation(
  value: unknown,
): value is CodeGraphAutomaticCompactionWorkerRequest['operation'] {
  return value === 'compact' || value === 'journal' || value === 'probe';
}

function isAutomaticCompactionReason(
  value: unknown,
): value is NonNullable<CodeGraphAutomaticCompactionResult['reason']> {
  return value === 'active-build' || value === 'active-maintenance';
}

/** @internal Re-invoke either the compiled binary or the current development standalone. */
export function codeGraphAutomaticCompactionWorkerInvocation(
  system: Pick<SystemInfoShape, 'executablePath' | 'processArguments' | 'developmentEntrypoint'>,
): {
  readonly arguments: readonly string[];
  readonly executable: string;
} {
  const executableName = Effect2.pipe(
    Effect2.pipe(system.executablePath, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  if (executableName !== 'bun' && executableName !== 'bun.exe') {
    return {arguments: [CODE_GRAPH_COMPACTION_WORKER_ARGUMENT], executable: system.executablePath};
  }
  const currentScript = system.processArguments[1];
  const standaloneScript =
    currentScript && /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/iu.test(currentScript)
      ? currentScript
      : system.developmentEntrypoint;
  return {
    arguments: [standaloneScript, CODE_GRAPH_COMPACTION_WORKER_ARGUMENT],
    executable: system.executablePath,
  };
}
