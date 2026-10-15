import {Cause, Clock, Crypto, Effect, Exit, FileSystem, Option, Path, Predicate, Schema, Stdio, Stream} from 'effect';
import {CommandExecutor, CommandTimedOut, type CommandExecutionError} from '@threadnote/platform/command';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {CODE_GRAPH_IMPACT_QUERY_WORKER_ARGUMENT} from '@threadnote/graph/worker_protocol';
import {CodeGraphQueryService, observationFromCodeGraphStatus, type CodeGraphInspectOptions} from '../query.js';
import {
  codeGraphInspectionAllowsStaleReady,
  codeGraphInspectionNeedsReadyAttachment,
  codeGraphInspectionObservation,
  codeGraphInspectionObservesWorktree,
} from '../query/contract.js';
import type {
  CodeGraphQueryTelemetryObservation,
  CodeGraphQueryTelemetryObserver,
  CodeGraphQueryTelemetryPhase,
  CodeGraphQueryTelemetryStage,
  CodeGraphQueryTelemetryStageDisposition,
  CodeGraphStatusObservation,
} from '../query/contract.js';
import {codeGraphQueryScopeReceipt, type CodeGraphQueryScope, type CodeGraphQueryScopeReceipt} from '../query/scope.js';
import {
  codeGraphQueryAnonymousTelemetrySnapshotSelection,
  codeGraphQueryAnonymousTelemetrySnapshotSurface,
  type CodeGraphQueryAnonymousTelemetrySnapshotSurface,
} from '../query/telemetry_snapshot.js';
import {codeGraphScopeAdmitsPath} from '../scope/applicability.js';
import {observeCodeGraphBackgroundDemand, type CodeGraphRefreshDemandIdentity} from '../refresh/demand.js';
import {resolveRepositoryIdentity} from '../repository.js';
import {CodeGraphSnapshotUnavailable, type CodeGraphQueryResult, type RepositoryIdentity} from '../types.js';
import type {CodeGraphRefreshContinuity} from '../watcher.js';

const CODE_GRAPH_IMPACT_QUERY_PROTOCOL = 1 as const;
const CODE_GRAPH_IMPACT_QUERY_INPUT_BYTES_MAXIMUM = 256 * 1_024;
const CODE_GRAPH_IMPACT_QUERY_OUTPUT_BYTES_MAXIMUM = 2 * 1_024 * 1_024;
const CODE_GRAPH_IMPACT_QUERY_TEXT_BYTES_MAXIMUM = 64 * 1_024;
const CODE_GRAPH_IMPACT_QUERY_SEED_LIMIT = 200;
const CODE_GRAPH_REFRESH_CONTINUITY_OBSERVATION_TIMEOUT_MILLISECONDS = 1_000;
const CODE_GRAPH_IMPACT_QUERY_CHANGED_PATHS_SELECTOR = 'changed paths';
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const CODE_GRAPH_SNAPSHOT_ID_PATTERN = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;
export const CODE_GRAPH_IMPACT_QUERY_TIMEOUT_MILLISECONDS = 20_000;
export const CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS = 50_000;

type CodeGraphIsolatedQueryOperation = CodeGraphQueryResult['operation'];

interface CodeGraphImpactQueryRequest {
  readonly project?: string;
  readonly manifestPath?: string;
  readonly baseCommit?: string;
  readonly borrowedSnapshotId?: string;
  readonly cwd: string;
  readonly depth?: number;
  readonly direction?: 'both' | 'incoming' | 'outgoing';
  /** Full-pipeline discovery: the worker runs status, selection, and read. Never combined with parent-selected snapshots. */
  readonly discover?: boolean;
  readonly edgeLimit: number;
  readonly from?: string;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeId?: string;
  readonly nodeLimit: number;
  readonly operation: CodeGraphIsolatedQueryOperation;
  readonly packageName?: string;
  readonly projectScopeReceipt?: CodeGraphQueryScopeReceipt;
  readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL;
  readonly query: string;
  /** Exact parent-selected ready snapshot; avoids repeating discovery in the worker. */
  readonly readySnapshotId?: string;
  /** Original count retained when the transport bounds changed-path content. */
  readonly seedQueryCount?: number;
  readonly seedQueries?: readonly string[];
  /** Parent-observed read strictness; absent keeps the operation default. */
  readonly strictFreshness?: boolean;
  readonly symbol?: string;
  readonly threadnoteHome: string;
  readonly to?: string;
  /** Parent-observed worktree state reused instead of re-observing in the worker. */
  readonly overlay?: CodeGraphStatusObservation['overlay'];
}

type CodeGraphImpactQueryResponse =
  | {
      readonly ok: true;
      readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL;
      readonly result: CodeGraphQueryResult;
      /** Present only for discovery reads; reuse reads keep selection parent-side. */
      readonly status?: CodeGraphImpactQueryReadStatus;
      readonly telemetry: readonly CodeGraphQueryTelemetryObservation[];
    }
  | {
      readonly ok: false;
      readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL;
      readonly telemetry: readonly CodeGraphQueryTelemetryObservation[];
    }
  | {
      readonly ok: false;
      readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL;
      readonly telemetry: readonly CodeGraphQueryTelemetryObservation[];
      readonly unavailable: 'no-ready-snapshot';
      readonly identity: {
        readonly repoRoot: string;
        readonly worktreeId: string;
      };
    };

export interface CodeGraphImpactQueryReadStatus {
  readonly refresh?: CodeGraphRefreshContinuity;
  readonly stale: boolean;
  readonly readySnapshotId?: string;
  readonly surface: CodeGraphQueryAnonymousTelemetrySnapshotSurface;
  readonly worktreeId: string;
  readonly repoRoot: string;
}

export interface IsolatedCodeGraphImpactQueryInput {
  readonly project?: string;
  readonly manifestPath?: string;
  readonly baseCommit?: string;
  readonly cwd: string;
  readonly depth?: number;
  readonly edgeLimit: number;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeLimit: number;
  readonly query: string;
  readonly seedQueries?: readonly string[];
  readonly threadnoteHome: string;
}

export interface IsolatedCodeGraphQueryInput {
  readonly project?: string;
  readonly manifestPath?: string;
  readonly baseCommit?: string;
  readonly borrowedSnapshotId?: string;
  readonly cwd: string;
  readonly depth?: number;
  readonly direction?: 'both' | 'incoming' | 'outgoing';
  /** Full-pipeline discovery: the worker runs status, selection, and read. Never combined with parent-selected snapshots. */
  readonly discover?: boolean;
  readonly edgeLimit: number;
  readonly from?: string;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeId?: string;
  readonly nodeLimit: number;
  readonly operation: CodeGraphIsolatedQueryOperation;
  readonly packageName?: string;
  /** Parent-observed scope is reduced to a compact receipt at the worker boundary. */
  readonly projectScope?: CodeGraphQueryScope;
  readonly query?: string;
  /** Exact ready snapshot selected by the parent status pass. */
  readonly readySnapshotId?: string;
  /** Original count retained when the caller removes outside-scope changed paths. */
  readonly seedQueryCount?: number;
  readonly seedQueries?: readonly string[];
  /** Parent-observed read strictness; absent keeps the operation default. */
  readonly strictFreshness?: boolean;
  readonly symbol?: string;
  readonly threadnoteHome: string;
  readonly to?: string;
  /** Parent-observed worktree state reused instead of re-observing in the worker. */
  readonly overlay?: CodeGraphStatusObservation['overlay'];
}

/**
 * Discovery read input. No parent-selected snapshots, scope, overlay, or
 * strictness: the worker discovers everything in-child so the calling
 * thread never touches SQLite.
 */
export interface IsolatedCodeGraphReadInput extends Omit<
  IsolatedCodeGraphQueryInput,
  'borrowedSnapshotId' | 'overlay' | 'projectScope' | 'readySnapshotId' | 'strictFreshness'
> {
  readonly discover: true;
}

export interface IsolatedCodeGraphReadUnavailable {
  readonly unavailable: 'no-ready-snapshot';
  readonly identity: {
    readonly repoRoot: string;
    readonly worktreeId: string;
  };
}

export class IsolatedCodeGraphImpactQueryError extends Schema.TaggedError<IsolatedCodeGraphImpactQueryError>()(
  'IsolatedCodeGraphImpactQueryError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export class IsolatedCodeGraphImpactQueryTimedOut extends Schema.TaggedError<IsolatedCodeGraphImpactQueryTimedOut>()(
  'IsolatedCodeGraphImpactQueryTimedOut',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const executeIsolatedQueryWorker = Effect.fn('codeGraph.executeIsolatedQuery')(function* (
  input: IsolatedCodeGraphQueryInput,
  options: {
    readonly timeoutMilliseconds?: number;
  } = {},
) {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const timeoutMilliseconds = boundedTimeout(
    options.timeoutMilliseconds,
    CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS,
  );
  const request = yield* Effect.try({
    try: () => encodeImpactQueryRequest(input),
    catch: cause =>
      Schema.is(IsolatedCodeGraphImpactQueryError)(cause)
        ? cause
        : IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query request is invalid.'}),
  });
  const invocation = impactQueryWorkerInvocation(system);
  const timeout = IsolatedCodeGraphImpactQueryTimedOut.make({message: 'Isolated code graph query timed out.'});
  return yield* command
    .execute(invocation.executable, invocation.arguments, {
      env: impactQueryWorkerEnvironment(system.environment(), input.threadnoteHome),
      input: request,
      maxOutputBytes: CODE_GRAPH_IMPACT_QUERY_OUTPUT_BYTES_MAXIMUM,
      timeoutMs: timeoutMilliseconds,
    })
    .pipe(
      Effect.mapError((error: CommandExecutionError) =>
        Schema.is(CommandTimedOut)(error)
          ? timeout
          : IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query failed.'}),
      ),
      Effect.timeoutOrElse({duration: timeoutMilliseconds, orElse: () => Effect.fail(timeout)}),
    );
});

/**
 * Execute graph reads outside the MCP event loop. Bun SQLite calls are
 * synchronous, so an in-process busy or cold query can stall the MCP control plane.
 */
export const inspectCodeGraphIsolated = Effect.fn('codeGraph.queryIsolated')(function* (
  input: IsolatedCodeGraphQueryInput,
  options: {
    readonly onTelemetryObservation?: (observation: CodeGraphQueryTelemetryObservation) => Effect.Effect<void>;
    readonly timeoutMilliseconds?: number;
  } = {},
) {
  const result = yield* executeIsolatedQueryWorker(input, options);
  const response = decodeImpactQueryResponse(result.stdout);
  if (response === undefined) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query failed.'});
  }
  yield* replayCodeGraphIsolatedQueryTelemetry(response.telemetry, options.onTelemetryObservation);
  if (!response.ok || response.result.operation !== input.operation) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query failed.'});
  }
  return response.result;
});

export const inspectCodeGraphImpactIsolated = Effect.fn('codeGraph.impactQueryIsolated')(
  (input: IsolatedCodeGraphImpactQueryInput, options: {readonly timeoutMilliseconds?: number} = {}) =>
    inspectCodeGraphIsolated(
      {...input, operation: 'impact'},
      {
        timeoutMilliseconds:
          options.timeoutMilliseconds === undefined
            ? CODE_GRAPH_IMPACT_QUERY_TIMEOUT_MILLISECONDS
            : Math.min(options.timeoutMilliseconds, CODE_GRAPH_IMPACT_QUERY_TIMEOUT_MILLISECONDS),
      },
    ),
);

export const inspectCodeGraphReadIsolated = Effect.fn('codeGraph.readIsolated')(function* (
  input: IsolatedCodeGraphReadInput,
  options: {
    readonly onTelemetryObservation?: (observation: CodeGraphQueryTelemetryObservation) => Effect.Effect<void>;
    readonly timeoutMilliseconds?: number;
  } = {},
) {
  if ((input as {readonly discover?: unknown}).discover !== true) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Discovery reads require discover:true.'});
  }
  const result = yield* executeIsolatedQueryWorker(input, options);
  const response = decodeImpactQueryResponse(result.stdout);
  if (response === undefined) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query failed.'});
  }
  yield* replayCodeGraphIsolatedQueryTelemetry(response.telemetry, options.onTelemetryObservation);
  if (!response.ok) {
    if ('unavailable' in response) {
      const verdict: IsolatedCodeGraphReadUnavailable = {
        unavailable: response.unavailable,
        identity: response.identity,
      };
      return verdict;
    }
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query failed.'});
  }
  if (response.result.operation !== input.operation) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query failed.'});
  }
  if (response.status === undefined) {
    return yield* IsolatedCodeGraphImpactQueryError.make({
      message: 'Isolated code graph discovery read omitted its status summary.',
    });
  }
  return {result: response.result, status: response.status};
});

export const serveCodeGraphDiscoveryRead = Effect.fn('codeGraph.serveDiscoveryRead')(function* (
  request: CodeGraphImpactQueryRequest,
  options: {
    readonly observeRefresh?: (
      identity: CodeGraphRefreshDemandIdentity,
    ) => Effect.Effect<CodeGraphRefreshContinuity | undefined, unknown>;
    readonly telemetry?: CodeGraphQueryTelemetryObserver;
  } = {},
) {
  const query = yield* CodeGraphQueryService;
  const statusOptions = {
    manifestPath: request.manifestPath,
    observeWorktree: codeGraphInspectionObservesWorktree(request.operation),
    project: request.project,
    requestMaintenance: false,
    telemetry: options.telemetry,
  };
  const read = (status: import('../types.js').CodeGraphStatus) =>
    Effect.gen(function* () {
      const attached = codeGraphInspectionNeedsReadyAttachment(status)
        ? yield* query.attachSharedReadySnapshot(request.threadnoteHome, status.identity, status, {
            allowBorrowedStale: codeGraphInspectionAllowsStaleReady(request.operation),
            requestMaintenance: false,
            telemetry: options.telemetry,
          })
        : status;
      if (attached.readySnapshot === undefined) {
        return {
          unavailable: 'no-ready-snapshot' as const,
          identity: {repoRoot: attached.identity.repoRoot, worktreeId: attached.identity.worktreeId},
        };
      }
      const observation = codeGraphInspectionObservation(observationFromCodeGraphStatus(attached), request.operation);
      const scopedSeedQueries = request.seedQueries?.filter(candidate =>
        codeGraphScopeAdmitsPath(observation?.projectScope?.scope, candidate),
      );
      const result = yield* query
        .inspect({
          project: request.project,
          manifestPath: request.manifestPath,
          ...(request.baseCommit === undefined ? {} : {baseCommit: request.baseCommit}),
          ...(request.operation === 'impact' ? {baseCommitPolicy: 'ready-only' as const} : {}),
          cwd: request.cwd,
          depth: request.depth,
          direction: request.direction,
          edgeLimit: request.edgeLimit,
          from: request.from,
          includeHeuristic: request.includeHeuristic,
          includeModelAssociations: request.includeModelAssociations,
          nodeId: request.nodeId,
          nodeLimit: request.nodeLimit,
          operation: request.operation,
          packageName: request.packageName,
          query:
            request.operation === 'impact'
              ? impactQueryTransportSelector(request.query, request.seedQueries)
              : request.query,
          refresh: false,
          requestMaintenance: false,
          seedQueryCount: scopedSeedQueries?.length,
          seedQueries: scopedSeedQueries,
          ...(observation === undefined ? {} : {statusObservation: observation}),
          symbol: request.symbol,
          threadnoteHome: request.threadnoteHome,
          to: request.to,
        })
        .pipe(
          Effect.catchIf(
            (error: unknown) => Schema.is(CodeGraphSnapshotUnavailable)(error),
            () =>
              Effect.succeed({
                unavailable: 'no-ready-snapshot' as const,
                identity: {repoRoot: attached.identity.repoRoot, worktreeId: attached.identity.worktreeId},
              }),
          ),
        );
      if (typeof result === 'object' && result !== null && 'unavailable' in result) return result;
      const scopeId = observation?.projectScope?.scope?.scopeKey;
      const refresh =
        options.observeRefresh === undefined
          ? undefined
          : yield* options
              .observeRefresh({
                checkoutId: attached.identity.checkoutId,
                ...(scopeId === undefined ? {} : {scopeId}),
                threadnoteHome: request.threadnoteHome,
                worktreeId: attached.identity.worktreeId,
              })
              .pipe(Effect.orElseSucceed(() => undefined));
      const selection = codeGraphQueryAnonymousTelemetrySnapshotSelection(status, attached);
      const surface = codeGraphQueryAnonymousTelemetrySnapshotSurface(attached, selection);
      return {
        result,
        status: {
          ...(refresh === undefined || refresh.state === 'idle' ? {} : {refresh}),
          stale: attached.stale,
          ...(attached.readySnapshot === undefined ? {} : {readySnapshotId: attached.readySnapshot.id}),
          surface:
            surface.selection === 'none'
              ? surface
              : {
                  freshness: surface.freshness,
                  selection: surface.selection,
                  snapshot: {
                    edgeCount: surface.snapshot.edgeCount,
                    fileCount: surface.snapshot.fileCount,
                    symbolCount: surface.snapshot.symbolCount,
                  },
                },
          worktreeId: attached.identity.worktreeId,
          repoRoot: attached.identity.repoRoot,
        },
      };
    });
  return yield* query.withStatusSession === undefined
    ? query.status(request.threadnoteHome, request.cwd, statusOptions).pipe(Effect.flatMap(read))
    : query.withStatusSession(request.threadnoteHome, request.cwd, undefined, statusOptions, read);
});

/** Internal standalone worker. Input and output are bounded one-document JSON over stdio. */
export const codeGraphImpactQueryWorkerProgram = (threadnoteHome: string) =>
  Effect.gen(function* () {
    const request = yield* readImpactQueryWorkerRequest;
    const query = yield* CodeGraphQueryService;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const telemetry: CodeGraphQueryTelemetryObservation[] = [];
    const observeRefresh = (identity: CodeGraphRefreshDemandIdentity) =>
      observeCodeGraphBackgroundDemand(identity).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(SystemInfo, system),
        Effect.timeoutOption(CODE_GRAPH_REFRESH_CONTINUITY_OBSERVATION_TIMEOUT_MILLISECONDS),
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
    const response =
      request === undefined || request.threadnoteHome !== threadnoteHome
        ? ({ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL, telemetry} as const)
        : request.discover === true
          ? yield* serveCodeGraphDiscoveryRead(request, {
              observeRefresh,
              telemetry: codeGraphIsolatedQueryTelemetryRecorder(telemetry),
            }).pipe(
              Effect.match({
                onFailure: () => ({ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL, telemetry}) as const,
                onSuccess: (served): CodeGraphImpactQueryResponse =>
                  'unavailable' in served
                    ? {
                        ok: false,
                        protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
                        telemetry,
                        unavailable: served.unavailable,
                        identity: served.identity,
                      }
                    : {
                        ok: true,
                        protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
                        result: served.result,
                        status: served.status,
                        telemetry,
                      },
              }),
            )
          : yield* Effect.gen(function* () {
              const options = impactQueryWorkerInspectOptions(request, threadnoteHome);
              const statusObservation = impactQueryWorkerStatusObservation(
                request,
                yield* resolveRepositoryIdentity(request.cwd),
              );
              return yield* query.inspect({
                ...options,
                ...(statusObservation === undefined ? {} : {statusObservation}),
                telemetry: codeGraphIsolatedQueryTelemetryRecorder(telemetry),
              });
            }).pipe(
              Effect.match({
                onFailure: () => ({ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL, telemetry}) as const,
                onSuccess: result =>
                  ({
                    ok: true,
                    protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
                    result,
                    telemetry,
                  }) as const satisfies CodeGraphImpactQueryResponse,
              }),
            );
    yield* writeImpactQueryWorkerResponse(response);
  }).pipe(Effect.ignore);

/** @internal Keep the bounded read worker incapable of starting base-commit indexing. */
export function impactQueryWorkerInspectOptions(
  request: CodeGraphImpactQueryRequest,
  threadnoteHome: string,
): CodeGraphInspectOptions {
  return {
    project: request.project,
    manifestPath: request.manifestPath,
    ...(request.baseCommit === undefined ? {} : {baseCommit: request.baseCommit}),
    ...(request.operation === 'impact' ? {baseCommitPolicy: 'ready-only' as const} : {}),
    cwd: request.cwd,
    depth: request.depth,
    direction: request.direction,
    edgeLimit: request.edgeLimit,
    from: request.from,
    includeHeuristic: request.includeHeuristic,
    includeModelAssociations: request.includeModelAssociations,
    nodeId: request.nodeId,
    nodeLimit: request.nodeLimit,
    operation: request.operation,
    packageName: request.packageName,
    query: request.query,
    deferProjectScopePresentation: request.projectScopeReceipt !== undefined,
    readyScopeReceipt: request.projectScopeReceipt,
    refresh: false,
    requestMaintenance: false,
    seedQueryCount: request.seedQueryCount,
    seedQueries: request.seedQueries,
    strictFreshness: request.strictFreshness ?? (request.operation === 'impact' || request.operation === 'path'),
    symbol: request.symbol,
    threadnoteHome,
    to: request.to,
  };
}

function encodeImpactQueryRequest(input: IsolatedCodeGraphQueryInput): Uint8Array {
  const seedQueries = input.seedQueries?.slice(0, CODE_GRAPH_IMPACT_QUERY_SEED_LIMIT);
  const projectScopeReceipt = codeGraphQueryScopeReceipt(input.projectScope);
  const request = {
    ...(input.project === undefined ? {} : {project: input.project}),
    ...(input.manifestPath === undefined ? {} : {manifestPath: input.manifestPath}),
    ...(input.baseCommit === undefined ? {} : {baseCommit: input.baseCommit}),
    ...(input.borrowedSnapshotId === undefined ? {} : {borrowedSnapshotId: input.borrowedSnapshotId}),
    cwd: input.cwd,
    ...(input.depth === undefined ? {} : {depth: input.depth}),
    ...(input.direction === undefined ? {} : {direction: input.direction}),
    ...(input.discover === undefined ? {} : {discover: input.discover}),
    edgeLimit: input.edgeLimit,
    ...(input.from === undefined ? {} : {from: input.from}),
    ...(input.includeHeuristic === undefined ? {} : {includeHeuristic: input.includeHeuristic}),
    ...(input.includeModelAssociations === undefined ? {} : {includeModelAssociations: input.includeModelAssociations}),
    ...(input.nodeId === undefined ? {} : {nodeId: input.nodeId}),
    nodeLimit: input.nodeLimit,
    operation: input.operation,
    ...(input.packageName === undefined ? {} : {packageName: input.packageName}),
    ...(projectScopeReceipt === undefined ? {} : {projectScopeReceipt}),
    protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
    query:
      input.operation === 'impact' ? impactQueryTransportSelector(input.query, input.seedQueries) : (input.query ?? ''),
    ...(input.readySnapshotId === undefined ? {} : {readySnapshotId: input.readySnapshotId}),
    ...(input.seedQueries === undefined
      ? {}
      : {seedQueries, seedQueryCount: input.seedQueryCount ?? input.seedQueries.length}),
    ...(input.strictFreshness === undefined ? {} : {strictFreshness: input.strictFreshness}),
    ...(input.symbol === undefined ? {} : {symbol: input.symbol}),
    threadnoteHome: input.threadnoteHome,
    ...(input.to === undefined ? {} : {to: input.to}),
    ...(input.overlay === undefined ? {} : {overlay: input.overlay}),
  } satisfies CodeGraphImpactQueryRequest;
  if (!validImpactQueryRequest(request)) {
    throw IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query request is invalid.'});
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(request)}\n`);
  if (bytes.byteLength > CODE_GRAPH_IMPACT_QUERY_INPUT_BYTES_MAXIMUM) {
    throw IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph impact query request is too large.'});
  }
  return bytes;
}

const readImpactQueryWorkerRequest = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const encoder = new TextEncoder();
  const state = yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => ({chunks: [] as string[], size: 0}),
      (current, chunk) => {
        const size = current.size + encoder.encode(chunk).byteLength;
        if (size > CODE_GRAPH_IMPACT_QUERY_INPUT_BYTES_MAXIMUM) {
          return Effect.fail(
            IsolatedCodeGraphImpactQueryError.make({message: 'Impact query worker input is too large.'}),
          );
        }
        current.chunks.push(chunk);
        return Effect.succeed({chunks: current.chunks, size});
      },
    ),
  );
  return decodeImpactQueryRequest(state.chunks.join(''));
});

const writeImpactQueryWorkerResponse = Effect.fn('codeGraph.impactQueryWorker.write')(function* (
  response: CodeGraphImpactQueryResponse,
) {
  const stdio = yield* Stdio.Stdio;
  const bytes = new TextEncoder().encode(`${JSON.stringify(response)}\n`);
  if (bytes.byteLength > CODE_GRAPH_IMPACT_QUERY_OUTPUT_BYTES_MAXIMUM) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Impact query worker output is too large.'});
  }
  yield* Stream.run(Stream.make(bytes), stdio.stdout({endOnDone: false}));
});

/** @internal Protocol decoder retained for bounded property coverage. */
export function decodeImpactQueryRequest(content: string): CodeGraphImpactQueryRequest | undefined {
  if (new TextEncoder().encode(content).byteLength > CODE_GRAPH_IMPACT_QUERY_INPUT_BYTES_MAXIMUM) return undefined;
  try {
    const parsed: unknown = JSON.parse(content.trim());
    return validImpactQueryRequest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validImpactQueryRequest(value: unknown): value is CodeGraphImpactQueryRequest {
  if (!Predicate.isObject(value)) return false;
  const record = value;
  if (
    record.protocol !== CODE_GRAPH_IMPACT_QUERY_PROTOCOL ||
    !isCodeGraphIsolatedQueryOperation(record.operation) ||
    !validProtocolText(record.cwd) ||
    !validProtocolText(record.threadnoteHome) ||
    !validProtocolText(record.query, true) ||
    (record.project !== undefined && !validProtocolText(record.project)) ||
    (record.manifestPath !== undefined && !validProtocolText(record.manifestPath)) ||
    (record.borrowedSnapshotId !== undefined && !validSnapshotId(record.borrowedSnapshotId)) ||
    !boundedInteger(record.nodeLimit, 1, 200) ||
    !boundedInteger(record.edgeLimit, 1, 500) ||
    (record.depth !== undefined && !boundedInteger(record.depth, 0, 8)) ||
    (record.direction !== undefined && !['both', 'incoming', 'outgoing'].includes(String(record.direction))) ||
    (record.from !== undefined && !validProtocolText(record.from)) ||
    (record.includeHeuristic !== undefined && typeof record.includeHeuristic !== 'boolean') ||
    (record.includeModelAssociations !== undefined && typeof record.includeModelAssociations !== 'boolean') ||
    (record.nodeId !== undefined && !validProtocolText(record.nodeId)) ||
    (record.packageName !== undefined && !validProtocolText(record.packageName)) ||
    (record.projectScopeReceipt !== undefined && !validCodeGraphQueryScopeReceipt(record.projectScopeReceipt)) ||
    (record.readySnapshotId !== undefined && !validSnapshotId(record.readySnapshotId)) ||
    (record.seedQueryCount !== undefined && !boundedInteger(record.seedQueryCount, 0, Number.MAX_SAFE_INTEGER)) ||
    (record.symbol !== undefined && !validProtocolText(record.symbol)) ||
    (record.to !== undefined && !validProtocolText(record.to)) ||
    (record.strictFreshness !== undefined && typeof record.strictFreshness !== 'boolean') ||
    (record.overlay !== undefined && !validWorktreeOverlay(record.overlay)) ||
    (record.discover !== undefined && typeof record.discover !== 'boolean') ||
    (record.baseCommit !== undefined &&
      (typeof record.baseCommit !== 'string' || !GIT_OBJECT_ID_PATTERN.test(record.baseCommit)))
  ) {
    return false;
  }
  if (
    record.borrowedSnapshotId !== undefined &&
    record.readySnapshotId !== undefined &&
    record.borrowedSnapshotId !== record.readySnapshotId
  ) {
    return false;
  }
  if (
    record.discover === true &&
    (record.borrowedSnapshotId !== undefined ||
      record.readySnapshotId !== undefined ||
      record.projectScopeReceipt !== undefined ||
      record.overlay !== undefined ||
      record.strictFreshness !== undefined)
  ) {
    return false;
  }
  const seeds = record.seedQueries;
  if (seeds === undefined && record.seedQueryCount !== undefined) return false;
  if (seeds !== undefined) {
    if (record.operation !== 'impact' || !Array.isArray(seeds) || seeds.length > CODE_GRAPH_IMPACT_QUERY_SEED_LIMIT) {
      return false;
    }
    const seedQueryCount = record.seedQueryCount ?? seeds.length;
    if (
      seedQueryCount < seeds.length ||
      !seeds.every(value => validProtocolText(value)) ||
      (record.query === '' && seedQueryCount === 0)
    ) {
      return false;
    }
  }
  return validOperationSelectors({
    from: record.from,
    nodeId: record.nodeId,
    operation: record.operation,
    query: record.query,
    seedQueryCount: record.seedQueryCount,
    symbol: record.symbol,
    to: record.to,
  });
}

/** @internal Reuse the parent's bounded discovery without trusting its Git identity. */
export function impactQueryWorkerStatusObservation(
  request: CodeGraphImpactQueryRequest,
  identity: RepositoryIdentity,
): CodeGraphStatusObservation | undefined {
  const selectedSnapshotId = request.readySnapshotId ?? request.borrowedSnapshotId;
  if (selectedSnapshotId === undefined) return undefined;
  return {
    ...(selectedSnapshotId === undefined ? {} : {borrowedSnapshotId: selectedSnapshotId}),
    identity,
    ...(request.overlay === undefined ? {} : {overlay: request.overlay}),
  };
}

function validOperationSelectors(
  request: Pick<
    CodeGraphImpactQueryRequest,
    'from' | 'nodeId' | 'operation' | 'query' | 'seedQueryCount' | 'symbol' | 'to'
  >,
): boolean {
  switch (request.operation) {
    case 'query':
      return request.query !== '';
    case 'node':
    case 'neighbors':
      return request.nodeId !== undefined;
    case 'path':
      return request.from !== undefined && request.to !== undefined;
    case 'explain':
      return request.symbol !== undefined || request.query !== '';
    case 'impact':
      return request.query !== '' || (request.seedQueryCount ?? 0) > 0;
  }
}

function isCodeGraphIsolatedQueryOperation(value: unknown): value is CodeGraphIsolatedQueryOperation {
  return ['explain', 'impact', 'neighbors', 'node', 'path', 'query'].includes(String(value));
}

function validSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && CODE_GRAPH_SNAPSHOT_ID_PATTERN.test(value);
}

function validCodeGraphQueryScopeReceipt(value: unknown): value is CodeGraphQueryScopeReceipt {
  if (!Predicate.isObject(value) || !Predicate.isObject(value.scope) || !Predicate.isObject(value.evidence)) {
    return false;
  }
  const scope = value.scope;
  const evidence = value.evidence;
  return (
    validProtocolText(scope.closureDigest) &&
    validProtocolText(scope.definitionDigest) &&
    /^[0-9a-f]{64}$/u.test(String(scope.membershipDigest)) &&
    validProtocolText(scope.scopeKey) &&
    validProtocolText(evidence.catalogFingerprint) &&
    validProtocolText(evidence.closureDigest) &&
    validProtocolText(evidence.definitionDigest) &&
    validProtocolText(evidence.extractorSet) &&
    validProtocolText(evidence.inventoryFingerprint) &&
    validProtocolText(evidence.observedCommit) &&
    (evidence.overlayFingerprint === undefined || validProtocolText(evidence.overlayFingerprint)) &&
    validProtocolText(evidence.policyFingerprint) &&
    validProtocolText(evidence.repositoryId) &&
    validProtocolText(evidence.scopeKey) &&
    validProtocolText(evidence.worktreeId) &&
    evidence.scopeKey === scope.scopeKey &&
    evidence.definitionDigest === scope.definitionDigest &&
    evidence.closureDigest === scope.closureDigest
  );
}

export function codeGraphIsolatedQueryTelemetryRecorder(
  observations: CodeGraphQueryTelemetryObservation[],
): CodeGraphQueryTelemetryObserver {
  const record = (
    phase: CodeGraphQueryTelemetryPhase,
    stage: CodeGraphQueryTelemetryStage,
    durationMilliseconds: number,
    outcome: CodeGraphQueryTelemetryObservation['outcome'],
    disposition?: CodeGraphQueryTelemetryStageDisposition,
  ) =>
    Effect.sync(() => {
      observations.push({
        ...(disposition === undefined ? {} : {disposition}),
        durationMilliseconds,
        outcome,
        phase,
        stage,
      });
    });
  return {
    skip: (phase, stage) => record(phase, stage, 0, 'success', 'skipped'),
    stage: (phase, stage, effect, disposition) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(effect);
        const durationMilliseconds = Math.min(
          CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS,
          Math.max(0, Math.floor((yield* Clock.currentTimeMillis) - startedAt)),
        );
        const outcome = Exit.isSuccess(exit)
          ? 'success'
          : Cause.hasInterruptsOnly(exit.cause)
            ? 'interrupted'
            : 'failure';
        yield* record(phase, stage, durationMilliseconds, outcome, disposition);
        return Exit.isSuccess(exit) ? exit.value : yield* Effect.failCause(exit.cause);
      }),
  };
}

export const replayCodeGraphIsolatedQueryTelemetry = Effect.fn('codeGraph.replayIsolatedQueryTelemetry')(function* (
  observations: readonly CodeGraphQueryTelemetryObservation[],
  observe: ((observation: CodeGraphQueryTelemetryObservation) => Effect.Effect<void>) | undefined,
) {
  if (observe === undefined) return;
  yield* Effect.forEach(observations, observe, {discard: true});
});

/** @internal Seed paths carry default diff impact semantics; never duplicate them into the selector field. */
export function impactQueryTransportSelector(
  query: string | undefined,
  seedQueries: readonly string[] | undefined,
): string {
  return seedQueries?.length ? CODE_GRAPH_IMPACT_QUERY_CHANGED_PATHS_SELECTOR : (query ?? '');
}

function validWorktreeOverlay(value: unknown): value is NonNullable<CodeGraphImpactQueryRequest['overlay']> {
  return (
    Predicate.isObject(value) &&
    typeof value.dirty === 'boolean' &&
    (value.fingerprint === undefined || validProtocolText(value.fingerprint))
  );
}

function validProtocolText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).byteLength <= CODE_GRAPH_IMPACT_QUERY_TEXT_BYTES_MAXIMUM
  );
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function boundedTimeout(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function decodeImpactQueryResponse(content: string): CodeGraphImpactQueryResponse | undefined {
  try {
    const parsed: unknown = JSON.parse(content.trim());
    if (!Predicate.isObject(parsed)) return undefined;
    const record = parsed;
    if (record.protocol !== CODE_GRAPH_IMPACT_QUERY_PROTOCOL || typeof record.ok !== 'boolean') return undefined;
    const telemetry = decodeCodeGraphIsolatedQueryTelemetry(record.telemetry);
    if (telemetry === undefined) return undefined;
    if (!record.ok) {
      if (record.unavailable === undefined) {
        return {ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL, telemetry};
      }
      if (record.unavailable !== 'no-ready-snapshot' || !Predicate.isObject(record.identity)) return undefined;
      const identity = record.identity;
      if (!validProtocolText(identity.repoRoot) || !validProtocolText(identity.worktreeId)) return undefined;
      return {
        ok: false,
        protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
        telemetry,
        unavailable: 'no-ready-snapshot' as const,
        identity: {repoRoot: identity.repoRoot, worktreeId: identity.worktreeId},
      };
    }
    if (!validImpactQueryResult(record.result)) return undefined;
    const status = decodeImpactQueryReadStatus(record.status);
    if (status === undefined && record.status !== undefined) return undefined;
    return {
      ok: true,
      protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
      result: record.result,
      ...(status === undefined ? {} : {status}),
      telemetry,
    };
  } catch {
    return undefined;
  }
}

function decodeImpactQueryReadStatus(value: unknown): CodeGraphImpactQueryReadStatus | undefined {
  if (value === undefined) return undefined;
  if (!Predicate.isObject(value) || typeof value.stale !== 'boolean') return undefined;
  // Snapshot ids share the worker receipt format; a format change fails discovery reads closed here.
  if (value.readySnapshotId !== undefined && !validSnapshotId(value.readySnapshotId)) return undefined;
  if (!validProtocolText(value.worktreeId) || !validProtocolText(value.repoRoot)) return undefined;
  if (!Predicate.isObject(value.surface)) return undefined;
  const surface = value.surface;
  if (
    surface.selection !== 'none' &&
    surface.selection !== 'active' &&
    surface.selection !== 'borrowed' &&
    surface.selection !== 'promoted'
  ) {
    return undefined;
  }
  const refresh = decodeImpactQueryRefreshContinuity(value.refresh);
  if (value.refresh !== undefined && refresh === undefined) return undefined;
  if (surface.selection === 'none') {
    if (surface.freshness !== undefined || surface.snapshot !== undefined) return undefined;
    return {
      ...(refresh === undefined ? {} : {refresh}),
      stale: value.stale,
      surface: {selection: 'none'},
      worktreeId: value.worktreeId,
      repoRoot: value.repoRoot,
    };
  }
  if (surface.freshness !== 'current' && surface.freshness !== 'stale' && surface.freshness !== 'deferred') {
    return undefined;
  }
  if (!Predicate.isObject(surface.snapshot)) return undefined;
  const snapshot = surface.snapshot;
  if (
    !boundedInteger(snapshot.edgeCount, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(snapshot.fileCount, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(snapshot.symbolCount, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return undefined;
  }
  return {
    ...(refresh === undefined ? {} : {refresh}),
    stale: value.stale,
    ...(value.readySnapshotId === undefined ? {} : {readySnapshotId: value.readySnapshotId}),
    surface: {
      freshness: surface.freshness,
      selection: surface.selection,
      snapshot: {edgeCount: snapshot.edgeCount, fileCount: snapshot.fileCount, symbolCount: snapshot.symbolCount},
    },
    worktreeId: value.worktreeId,
    repoRoot: value.repoRoot,
  };
}

function decodeImpactQueryRefreshContinuity(value: unknown): CodeGraphRefreshContinuity | undefined {
  if (value === undefined) return undefined;
  if (
    !Predicate.isObject(value) ||
    value.type !== 'code-graph-refresh-continuity' ||
    value.version !== 1 ||
    !['active', 'queued', 'deferred', 'idle'].includes(String(value.state)) ||
    value.failure !== undefined
  ) {
    return undefined;
  }
  const decodeToken = (token: unknown): string | undefined | null =>
    token === undefined ? undefined : typeof token === 'string' && /^cgdq_[0-9a-f]{32}$/u.test(token) ? token : null;
  const currentTargetToken = decodeToken(value.currentTargetToken);
  const latestDesiredToken = decodeToken(value.latestDesiredToken);
  const queueToken = decodeToken(value.queueToken);
  if (currentTargetToken === null || latestDesiredToken === null || queueToken === null) return undefined;
  if (
    value.retryAfterMilliseconds !== undefined &&
    (typeof value.retryAfterMilliseconds !== 'number' ||
      !boundedInteger(value.retryAfterMilliseconds, 0, Number.MAX_SAFE_INTEGER))
  ) {
    return undefined;
  }
  const retryAfterMilliseconds =
    typeof value.retryAfterMilliseconds === 'number' ? value.retryAfterMilliseconds : undefined;
  if (value.state === 'active') {
    if (currentTargetToken === undefined || queueToken !== undefined || retryAfterMilliseconds !== undefined)
      return undefined;
    return {
      type: 'code-graph-refresh-continuity',
      version: 1,
      state: 'active',
      currentTargetToken,
      ...(latestDesiredToken === undefined ? {} : {latestDesiredToken}),
    };
  }
  if (value.state === 'queued' || value.state === 'deferred') {
    if (
      currentTargetToken !== undefined ||
      queueToken === undefined ||
      latestDesiredToken === undefined ||
      (value.state === 'deferred' && retryAfterMilliseconds === undefined)
    ) {
      return undefined;
    }
    return {
      type: 'code-graph-refresh-continuity',
      version: 1,
      state: value.state,
      queueToken,
      latestDesiredToken,
      ...(retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds}),
    };
  }
  if (
    currentTargetToken !== undefined ||
    queueToken !== undefined ||
    latestDesiredToken !== undefined ||
    retryAfterMilliseconds !== undefined
  ) {
    return undefined;
  }
  return {type: 'code-graph-refresh-continuity', version: 1, state: 'idle'};
}

export function decodeCodeGraphIsolatedQueryTelemetry(
  value: unknown,
): readonly CodeGraphQueryTelemetryObservation[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const observations: CodeGraphQueryTelemetryObservation[] = [];
  for (const observation of value) {
    if (!Predicate.isObject(observation)) return undefined;
    if (
      !boundedInteger(observation.durationMilliseconds, 0, CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS) ||
      !['failure', 'interrupted', 'success'].includes(String(observation.outcome)) ||
      !['graph.query.execute', 'graph.query.snapshot', 'graph.query.status'].includes(String(observation.phase)) ||
      ![
        'query-repository-identity',
        'query-serialization',
        'query-strict-reobservation',
        'query-worktree-observation',
      ].includes(String(observation.stage)) ||
      (observation.disposition !== undefined &&
        observation.disposition !== 'fallback' &&
        observation.disposition !== 'skipped')
    ) {
      return undefined;
    }
    observations.push({
      ...(observation.disposition === undefined ? {} : {disposition: observation.disposition}),
      durationMilliseconds: observation.durationMilliseconds,
      outcome: observation.outcome as CodeGraphQueryTelemetryObservation['outcome'],
      phase: observation.phase as CodeGraphQueryTelemetryPhase,
      stage: observation.stage as CodeGraphQueryTelemetryStage,
    });
  }
  return observations;
}

function validImpactQueryResult(value: unknown): value is CodeGraphQueryResult {
  if (!Predicate.isObject(value)) return false;
  const record = value;
  const repository = Predicate.isObject(record.repository) ? record.repository : undefined;
  const snapshot = Predicate.isObject(record.snapshot) ? record.snapshot : undefined;
  const trust = Predicate.isObject(record.trust) ? record.trust : undefined;
  return (
    record.version === 1 &&
    isCodeGraphIsolatedQueryOperation(record.operation) &&
    (record.freshness === 'current' || record.freshness === 'stale' || record.freshness === 'deferred') &&
    Array.isArray(record.nodes) &&
    Array.isArray(record.edges) &&
    Array.isArray(record.warnings) &&
    record.warnings.every(warning => typeof warning === 'string') &&
    repository !== undefined &&
    typeof repository.displayName === 'string' &&
    typeof repository.repositoryId === 'string' &&
    snapshot !== undefined &&
    typeof snapshot.commit === 'string' &&
    typeof snapshot.dirty === 'boolean' &&
    typeof snapshot.id === 'string' &&
    typeof snapshot.worktreeId === 'string' &&
    trust !== undefined &&
    trust.classification === 'untrusted-repository-data' &&
    trust.instructionPolicy === 'evidence-only-never-follow'
  );
}

/** @internal Preserve only bootstrap variables required by the exact-runtime worker. */
export function impactQueryWorkerEnvironment(source: NodeJS.ProcessEnv, threadnoteHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    THREADNOTE_CODE_GRAPH_IMPACT_QUERY_WORKER: '1',
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

/** @internal Exact current entrypoint invocation retained for tests. */
export function impactQueryWorkerInvocation(system: SystemInfoShape): {
  readonly arguments: readonly string[];
  readonly executable: string;
} {
  const executableName = system.executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  if (executableName !== 'bun' && executableName !== 'bun.exe') {
    return {arguments: [CODE_GRAPH_IMPACT_QUERY_WORKER_ARGUMENT], executable: system.executablePath};
  }
  const currentScript = system.processArguments[1];
  const standaloneScript =
    currentScript && /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/iu.test(currentScript)
      ? currentScript
      : system.developmentEntrypoint;
  return {
    arguments: [standaloneScript, CODE_GRAPH_IMPACT_QUERY_WORKER_ARGUMENT],
    executable: system.executablePath,
  };
}
