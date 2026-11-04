import {Array as EffectArray, Cause, Context, Effect, Exit, FileSystem, Layer, Option, Path, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {CommandCleanupUnconfirmed, CommandExecutor, CommandTimedOut} from '@threadnote/platform/command';
import {
  makeReadDeadline,
  isReadCleanupUnconfirmed,
  hasReadCleanupUnconfirmed,
  readDeadlineRemaining,
  withinReadDeadline,
  ReadDeadlineExceeded,
  type ReadDeadline,
} from '@threadnote/platform/read_deadline';
import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import {readRecallLexicalDemand} from '@threadnote/recall/background/lexical-demand';
import {SystemInfo} from '@threadnote/platform/system';
import {
  RecallReadyReadBoundary,
  RecallReadyReadBoundaryError,
  recallReadyReadResponseSchema,
  type RecallReadyReadRequest,
} from '@threadnote/recall/read_boundary';
import {
  RECALL_READY_READ_INPUT_BYTES,
  RECALL_READY_READ_OUTPUT_BYTES,
  recallReadyReadBinding,
} from './ready_read_worker.js';
import {RECALL_READY_READ_WORKER_ARGUMENT} from '../worker_protocol.js';

export const RECALL_READY_READ_MILLISECONDS = 2_000;
/** Actual CLI/MCP composition opts in; injected services and explicit writers keep direct semantics. */
export class ReadyRecallReadWorkerAdmission extends Context.Service<
  ReadyRecallReadWorkerAdmission,
  {readonly enabled: true}
>()('@threadnote/threadnote/recall/ready_read_boundary/ReadyRecallReadWorkerAdmission') {}
export const readyRecallReadWorkerAdmissionLayer = Layer.succeed(ReadyRecallReadWorkerAdmission, {enabled: true});
import {ReadDeadlineContext as ReadyRecallReadDeadline} from '@threadnote/platform/read_deadline';
export {ReadDeadlineContext as ReadyRecallReadDeadline} from '@threadnote/platform/read_deadline';
// The supported spawner may spend up to one second checking the group after KILL.
// Stop compute before that reserve; zero CommandExecutor timeouts mean unbounded.
const CLEANUP_AND_DECODE_RESERVE_MILLISECONDS = 1_100;

export function readyReadWorkerInvocation(executable: string, entrypoint: string) {
  const name = EffectString.toLowerCase(
    EffectString.split('/')(EffectString.replaceAll('\\', '/')(executable)).at(-1) ?? '',
  );
  return {
    executable,
    arguments: [...(name === 'bun' || name === 'bun.exe' ? [entrypoint] : []), RECALL_READY_READ_WORKER_ARGUMENT],
  };
}

export const makeReadyRecallReadBoundary = Effect.fn('recall.makeReadyReadBoundary')(function* (
  deadline: ReadDeadline,
) {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const wake = yield* RecallEmbeddingWakePort;
  const maintenanceContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const invocation = readyReadWorkerInvocation(system.executablePath, system.developmentEntrypoint);
  const wakeQueuedMaintenance = (request: RecallReadyReadRequest, requested?: boolean) => {
    if (
      !wake ||
      requested === false ||
      (requested !== true &&
        ['status', 'generation', 'vector-readiness', 'vector-state', 'vector-scores'].includes(request.operation))
    )
      return Effect.void;
    return withinReadDeadline(
      deadline,
      Effect.gen(function* () {
        // A worker interrupted after durable enqueue may not have returned its wake bit.
        // Read only this request's bounded demand receipt; never enqueue a new revision here.
        if (requested === undefined) {
          const variants =
            request.operation === 'memory-connections'
              ? [false, true]
              : ['includeInactive' in request.options ? request.options.includeInactive : false];
          const demands = yield* Effect.forEach(variants, includeInactive =>
            readRecallLexicalDemand({
              ...request.config,
              includeInactive,
            }),
          );
          if (!EffectArray.some(demands, demand => demand?.revision !== undefined)) return;
        }
        yield* wake(request.config.agentContextHome);
      }),
    ).pipe(
      Effect.timeout('50 millis'),
      Effect.catchCause(cause => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void)),
      Effect.provide(maintenanceContext),
    );
  };
  return RecallReadyReadBoundary.of({
    read: request =>
      Effect.gen(function* () {
        if ((yield* readDeadlineRemaining(deadline, CLEANUP_AND_DECODE_RESERVE_MILLISECONDS)) <= 0)
          return yield* RecallReadyReadBoundaryError.make({reason: 'budget-exhausted'});
        const input = yield* Effect.try({
          try: () => new TextEncoder().encode(JSON.stringify(request)),
          catch: () => RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'}),
        });
        if (input.byteLength > RECALL_READY_READ_INPUT_BYTES)
          return yield* RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
        const timeoutMs = yield* readDeadlineRemaining(deadline, CLEANUP_AND_DECODE_RESERVE_MILLISECONDS);
        if (timeoutMs <= 0) return yield* RecallReadyReadBoundaryError.make({reason: 'budget-exhausted'});
        const result = yield* command
          .execute(invocation.executable, invocation.arguments, {
            env: {...system.environment(), THREADNOTE_HOME: request.config.agentContextHome},
            input,
            maxOutputBytes: RECALL_READY_READ_OUTPUT_BYTES,
            timeoutMs,
            forceKillAfterMilliseconds: 0,
            sensitiveOutput: true,
            verifyOwnedProcessExit: system.platform === 'win32' ? 'leader' : 'group',
          })
          .pipe(
            Effect.mapError(error =>
              RecallReadyReadBoundaryError.make({
                reason: Schema.is(CommandCleanupUnconfirmed)(error)
                  ? 'cleanup-unconfirmed'
                  : Schema.is(CommandTimedOut)(error)
                    ? 'budget-exhausted'
                    : 'worker-failed',
              }),
            ),
          );
        // Only scoped command completion is usable; no detached ownership or late output.
        const response = yield* Schema.decodeEffect(Schema.fromJsonString(recallReadyReadResponseSchema), {
          onExcessProperty: 'error',
        })(result.stdout).pipe(Effect.mapError(() => RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'})));
        if (response.binding !== recallReadyReadBinding(request) || response.operation !== request.operation)
          return yield* RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
        yield* wakeQueuedMaintenance(request, response.maintenanceRequested);
        if ((yield* readDeadlineRemaining(deadline)) <= 0)
          return yield* RecallReadyReadBoundaryError.make({reason: 'budget-exhausted'});
        return response;
      }).pipe(
        Effect.onError(cause => {
          if (Cause.hasInterrupts(cause)) return Effect.void;
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          return Schema.is(RecallReadyReadBoundaryError)(error) && error.reason === 'cleanup-unconfirmed'
            ? Effect.void
            : wakeQueuedMaintenance(request);
        }),
      ),
  });
});

/** One inclusive request deadline, reused by exact lookup, ranking, and every fallback read. */
export function withReadyRecallReadBoundary<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: {readonly boundProgram?: boolean} = {},
) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(RecallReadyReadBoundary))) return yield* effect;
    if (Option.isNone(yield* Effect.serviceOption(ReadyRecallReadWorkerAdmission))) return yield* effect;
    const deadline = yield* makeReadDeadline(RECALL_READY_READ_MILLISECONDS);
    const boundary = yield* makeReadyRecallReadBoundary(deadline);
    return yield* (options.boundProgram ? withinReadDeadline(deadline, effect) : effect).pipe(
      Effect.provideService(RecallReadyReadBoundary, boundary),
      Effect.provideService(ReadyRecallReadDeadline, deadline),
    );
  });
}

/** Optional inference/refinement cannot consume the reserve needed to return completed evidence. */
export function optionalReadyRecallRead<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: {readonly closingReadMilliseconds?: number} = {},
) {
  return Effect.gen(function* () {
    const deadline = yield* Effect.serviceOption(ReadyRecallReadDeadline);
    const optional = <B, F, S>(program: Effect.Effect<B, F, S>) =>
      program.pipe(
        Effect.matchEffect({
          onSuccess: value => Effect.succeedSome(value),
          onFailure: error => (isReadCleanupUnconfirmed(error) ? Effect.fail(error) : Effect.succeed(Option.none<B>())),
        }),
      );
    if (Option.isNone(deadline)) return yield* optional(effect);
    const available = yield* readDeadlineRemaining(deadline.value, CLEANUP_AND_DECODE_RESERVE_MILLISECONDS);
    // Reserve the observed model-free read cost before admitting optional refinement.
    // This consumes the existing compute allowance; neither deadline nor cleanup reserve changes.
    const remaining = Math.max(0, available - Math.max(0, options.closingReadMilliseconds ?? 0));
    if (remaining <= 0) return Option.none<A>();
    let cleanupFailure: Cause.Cause<E> | undefined;
    const exit = yield* effect.pipe(
      Effect.onExit(exit =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && hasReadCleanupUnconfirmed(exit.cause)) cleanupFailure = exit.cause;
        }),
      ),
      Effect.timeoutOrElse({duration: remaining, orElse: () => Effect.fail(ReadDeadlineExceeded.make({}))}),
      Effect.flatMap(value =>
        readDeadlineRemaining(deadline.value, CLEANUP_AND_DECODE_RESERVE_MILLISECONDS).pipe(
          Effect.flatMap(left => (left > 0 ? Effect.succeed(value) : Effect.fail(ReadDeadlineExceeded.make({})))),
        ),
      ),
      Effect.exit,
    );
    if (cleanupFailure !== undefined) return yield* Effect.failCause(cleanupFailure);
    return yield* optional(Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value));
  });
}

/** Private transport inspection for focused request-binding tests. */
export const readyRecallReadRequestBinding = (request: RecallReadyReadRequest) => recallReadyReadBinding(request);
