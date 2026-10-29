import {Array as EffectArray} from 'effect';
import {Clock, Effect, Logger, Schema, Stdio, Stream} from 'effect';
import {CommandExecutor, CommandTimedOut} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {CodeGraphAnalysis, CodeGraphAnalysisDeferred, type CodeGraphAnalysisResult} from '../analysis.js';
import {codeGraphAnalysisLimitsForView} from '../analysis/render.js';
import {codeGraphRefreshFailure, type CodeGraphRefreshFailure} from '../watcher.js';
import {CodeGraphIndexer} from '../indexer.js';
import {codeGraphCliReadPlan} from '../cli/freshness.js';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '../query.js';
import {discloseCodeGraphAnalysisProjectCoverage, type CodeGraphQueryScope} from '../query/scope.js';
import type {CodeGraphStatus} from '../types.js';
import {CODE_GRAPH_ANALYSIS_WORKER_ARGUMENT} from '../worker_protocol.js';
import type {CodeGraphQueryTelemetryObservation, CodeGraphQueryTelemetryObserver} from '../query/contract.js';
import {
  codeGraphIsolatedQueryTelemetryRecorder,
  decodeCodeGraphIsolatedQueryTelemetry,
  replayCodeGraphIsolatedQueryTelemetry,
  impactQueryWorkerEnvironment,
  impactQueryWorkerInvocation,
} from './impact_query.js';

const MAXIMUM_INPUT_BYTES = 16 * 1_024;
const MAXIMUM_OUTPUT_BYTES = 64 * 1_024 * 1_024;
const MAXIMUM_FINALIZATION_MILLISECONDS = 2_000;
const finitePositive = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));
const AnalysisRequest = Schema.Struct({
  protocol: Schema.Literal(1),
  refresh: Schema.optional(Schema.Boolean),
  cwd: Schema.String,
  threadnoteHome: Schema.String,
  manifestPath: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  freshness: Schema.Literals(['current', 'ready', 'allow-stale']),
  operation: Schema.Literals([
    'stats',
    'communities',
    'community',
    'groups',
    'hubs',
    'surprises',
    'confidence',
    'full',
  ]),
  deadlineMilliseconds: finitePositive,
  communityId: Schema.optional(Schema.String),
  memberLimit: Schema.optional(Schema.Int),
  includeHeuristic: Schema.optional(Schema.Boolean),
  includeModelAssociations: Schema.optional(Schema.Boolean),
  limits: Schema.optional(
    Schema.Struct({
      communities: Schema.optional(Schema.Int),
      communityMembers: Schema.optional(Schema.Int),
      components: Schema.optional(Schema.Int),
      confidenceFindings: Schema.optional(Schema.Int),
      hubs: Schema.optional(Schema.Int),
      memberships: Schema.optional(Schema.Int),
      relationshipGroupMembers: Schema.optional(Schema.Int),
      relationshipGroups: Schema.optional(Schema.Int),
      surprisingLinks: Schema.optional(Schema.Int),
    }),
  ),
  budget: Schema.optional(
    Schema.Struct({
      maxNodes: Schema.optional(Schema.Int),
      maxEdges: Schema.optional(Schema.Int),
      maxEdgeVisits: Schema.optional(Schema.Int),
    }),
  ),
});

export type CodeGraphAnalysisReadInput = Omit<typeof AnalysisRequest.Type, 'protocol'>;
export type CodeGraphAnalysisReadResult =
  | ({
      readonly status: CodeGraphStatus;
      readonly project?: CodeGraphQueryScope['project'];
    } & (
      | {readonly state: 'ready'; readonly result: CodeGraphAnalysisResult}
      | {readonly state: 'unavailable'; readonly reason: 'no-ready-snapshot' | 'current-snapshot-unavailable'}
      | {readonly state: 'deferred'; readonly reason: 'writer-contention'}
    ))
  | {
      readonly state: 'failed';
      readonly reason: 'read-failed';
      readonly failure: CodeGraphRefreshFailure;
      readonly status?: CodeGraphStatus;
    };

export class CodeGraphAnalysisReadTimedOut extends Schema.TaggedError<
  CodeGraphAnalysisReadTimedOut,
  {readonly brand: unique symbol}
>()('CodeGraphAnalysisReadTimedOut', {message: Schema.String}) {}
export class CodeGraphAnalysisReadError extends Schema.TaggedError<
  CodeGraphAnalysisReadError,
  {readonly brand: unique symbol}
>()('CodeGraphAnalysisReadError', {message: Schema.String}) {}

/** Status, selection, native reads, and strict re-observation all run in the deadline-owned child. */
export const serveCodeGraphAnalysisRead = Effect.fn('codeGraph.serveAnalysisRead')(function* (
  input: CodeGraphAnalysisReadInput,
  options: {readonly telemetry?: CodeGraphQueryTelemetryObserver} = {},
) {
  const query = yield* CodeGraphQueryService;
  let project: CodeGraphQueryScope['project'] | undefined;
  const statusOptions = {
    project: input.project,
    manifestPath: input.manifestPath,
    requestMaintenance: false,
    telemetry: options.telemetry,
    afterIdentityObserved: (_identity: CodeGraphStatus['identity'], selected?: CodeGraphQueryScope['project']) =>
      Effect.sync(() => {
        project = selected;
      }),
  };
  let status = yield* query.status(input.threadnoteHome, input.cwd, statusOptions);
  if (input.freshness === 'current' && (status.stale || status.readySnapshot === undefined)) {
    status = yield* query.attachSharedReadySnapshot(input.threadnoteHome, status.identity, status, {
      allowBorrowedStale: false,
      requestMaintenance: false,
      telemetry: options.telemetry,
    });
  }
  project ??= observationFromCodeGraphStatus(status)?.projectScope?.project;
  if (input.refresh && codeGraphCliReadPlan(input.freshness, status).refresh) {
    const indexer = yield* CodeGraphIndexer;
    const failure = yield* indexer
      .index({
        cwd: input.cwd,
        threadnoteHome: input.threadnoteHome,
        ensureVectors: false,
        ...(project === undefined ? {} : {project}),
      })
      .pipe(
        Effect.as(undefined),
        Effect.catch(error => Effect.succeed(codeGraphRefreshFailure(error))),
      );
    if (failure !== undefined) return {state: 'failed' as const, reason: 'read-failed' as const, failure, status};
    status = yield* query.status(input.threadnoteHome, input.cwd, statusOptions);
  }
  const selection = {status, ...(project === undefined ? {} : {project})};
  const plan = codeGraphCliReadPlan(input.freshness, status);
  if (
    plan.unavailable ||
    plan.refresh ||
    status.readySnapshot === undefined ||
    (input.freshness === 'current' && status.freshness !== 'current')
  ) {
    return {
      ...selection,
      state: 'unavailable' as const,
      reason:
        status.readySnapshot === undefined ? ('no-ready-snapshot' as const) : ('current-snapshot-unavailable' as const),
    };
  }
  const now = yield* Clock.currentTimeMillis;
  const remaining = input.deadlineMilliseconds - now;
  if (remaining <= 1) return yield* CodeGraphAnalysisReadTimedOut.make({message: 'Analysis read deadline expired.'});
  // Leave room for lease cleanup, current-mode re-observation, and the JSON response.
  const finalization = Math.min(MAXIMUM_FINALIZATION_MILLISECONDS, Math.max(1, Math.floor(remaining / 5)));
  const computeDeadline = input.deadlineMilliseconds - finalization;
  const analysis = yield* CodeGraphAnalysis;
  const result = yield* analysis
    .analyze({
      allowedProvenances: [
        'declared',
        'resolved',
        'syntactic',
        ...(input.includeHeuristic ? ['heuristic' as const] : []),
        ...(input.includeModelAssociations ? ['model' as const] : []),
      ],
      budget: {...input.budget, maxDurationMilliseconds: computeDeadline - now},
      communityId: input.communityId,
      databasePath: status.databasePath,
      deadlineMilliseconds: computeDeadline,
      limits: input.limits ?? codeGraphAnalysisLimitsForView(input.operation, input.memberLimit),
      snapshot: status.readySnapshot,
    })
    .pipe(Effect.catchIf(Schema.is(CodeGraphAnalysisDeferred), () => Effect.void));
  if (result === undefined) return {...selection, state: 'deferred' as const, reason: 'writer-contention' as const};
  if (input.freshness === 'current') {
    const final = yield* query.status(input.threadnoteHome, input.cwd, statusOptions);
    if (final.stale || final.freshness !== 'current' || final.readySnapshot?.id !== status.readySnapshot.id) {
      return {
        ...selection,
        status: final,
        state: 'unavailable' as const,
        reason: 'current-snapshot-unavailable' as const,
      };
    }
  }
  return {
    ...selection,
    state: 'ready' as const,
    result: discloseCodeGraphAnalysisProjectCoverage(result, status.projectCoverage),
  };
});

export const analyzeCodeGraphReadIsolated = Effect.fn('codeGraph.analysisReadIsolated')(function* (
  input: CodeGraphAnalysisReadInput,
  options: {
    readonly onTelemetryObservation?: (observation: CodeGraphQueryTelemetryObservation) => Effect.Effect<void>;
  } = {},
) {
  const remaining = input.deadlineMilliseconds - (yield* Clock.currentTimeMillis);
  const timeout = CodeGraphAnalysisReadTimedOut.make({message: 'Analysis read deadline expired.'});
  if (remaining <= 0) return yield* timeout;
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const request = {protocol: 1, ...input};
  if (!Schema.is(AnalysisRequest)(request))
    return yield* CodeGraphAnalysisReadError.make({message: 'Invalid analysis worker request.'});
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  if (bytes.byteLength > MAXIMUM_INPUT_BYTES)
    return yield* CodeGraphAnalysisReadError.make({message: 'Analysis worker request is too large.'});
  const invocation = impactQueryWorkerInvocation(system);
  const result = yield* command
    .execute(invocation.executable, [...invocation.arguments.slice(0, -1), CODE_GRAPH_ANALYSIS_WORKER_ARGUMENT], {
      env: impactQueryWorkerEnvironment(system.environment(), input.threadnoteHome),
      input: bytes,
      maxOutputBytes: MAXIMUM_OUTPUT_BYTES,
      timeoutMs: remaining,
    })
    .pipe(
      Effect.mapError(error =>
        Schema.is(CommandTimedOut)(error)
          ? timeout
          : CodeGraphAnalysisReadError.make({message: 'Analysis worker failed.'}),
      ),
      Effect.timeoutOrElse({duration: remaining, orElse: () => Effect.fail(timeout)}),
    );
  const response = yield* Effect.try({
    try: () => {
      const response: unknown = JSON.parse(result.stdout);
      if (!isRecord(response) || response.protocol !== 1 || response.ok !== true || !validReadResult(response.result)) {
        throw new Error('Invalid response');
      }
      const telemetry = decodeCodeGraphIsolatedQueryTelemetry(response.telemetry);
      if (telemetry === undefined) throw new Error('Invalid telemetry');
      return {result: response.result, telemetry};
    },
    catch: () => CodeGraphAnalysisReadError.make({message: 'Analysis worker returned an invalid response.'}),
  });
  yield* replayCodeGraphIsolatedQueryTelemetry(response.telemetry, options.onTelemetryObservation);
  return response.result;
});

function validReadResult(value: unknown): value is CodeGraphAnalysisReadResult {
  if (isRecord(value) && value.state === 'failed' && value.reason === 'read-failed')
    return (
      isRecord(value.failure) && typeof value.failure.code === 'string' && typeof value.failure.retryable === 'boolean'
    );
  if (!isRecord(value) || !isRecord(value.status) || !isRecord(value.status.identity)) return false;
  if (value.state === 'ready') return isRecord(value.result) && isRecord(value.result.snapshot);
  return (
    (value.state === 'unavailable' &&
      (value.reason === 'no-ready-snapshot' || value.reason === 'current-snapshot-unavailable')) ||
    (value.state === 'deferred' && value.reason === 'writer-contention')
  );
}

export const codeGraphAnalysisWorkerProgram = (threadnoteHome: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const content = yield* stdio.stdin.pipe(
      Stream.decodeText,
      Stream.runFoldEffect(
        () => '',
        (content, chunk) => {
          const next = content + chunk;
          return new TextEncoder().encode(next).byteLength > MAXIMUM_INPUT_BYTES
            ? Effect.fail(CodeGraphAnalysisReadError.make({message: 'Analysis worker input is too large.'}))
            : Effect.succeed(next);
        },
      ),
    );
    const request = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: () => CodeGraphAnalysisReadError.make({message: 'Invalid analysis input.'}),
    });
    const telemetry: CodeGraphQueryTelemetryObservation[] = [];
    const response =
      !Schema.is(AnalysisRequest)(request) || request.threadnoteHome !== threadnoteHome
        ? {protocol: 1, ok: false}
        : yield* serveCodeGraphAnalysisRead(request, {
            telemetry: codeGraphIsolatedQueryTelemetryRecorder(telemetry),
          }).pipe(
            Effect.match({
              onFailure: error => ({
                protocol: 1,
                ok: true,
                result: {state: 'failed', reason: 'read-failed', failure: codeGraphRefreshFailure(error)},
              }),
              onSuccess: result => ({protocol: 1, ok: true, result}),
            }),
          );
    const bytes = new TextEncoder().encode(JSON.stringify({...response, telemetry: telemetry.slice(-8)}));
    if (bytes.byteLength > MAXIMUM_OUTPUT_BYTES)
      return yield* CodeGraphAnalysisReadError.make({message: 'Analysis worker output is too large.'});
    yield* Stream.run(Stream.make(bytes), stdio.stdout({endOnDone: false}));
  }).pipe(Effect.ignore, Effect.provideService(Logger.LogToStderr, true));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
