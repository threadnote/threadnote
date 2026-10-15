import {Cause, Effect, Option, Schema} from 'effect';
import {CodeGraphScopeRoutingError} from '../scope/routing.js';
import {classifyCodeGraphStoreFailure} from '../store/failure.js';
import {
  CodeGraphDiskCapacityObservationError,
  CodeGraphDiskCapacityPressureError,
  CodeGraphRuntimeReconnectRequiredError,
  type CodeGraphStoreFailureCode,
} from '../types.js';
import type {CodeGraphRefreshFailure} from '../watcher.js';
import type {CodeGraphRefreshDemandRegistration, CodeGraphRefreshDemandState} from './demand_scheduler.js';

export class CodeGraphRefreshRetryBlocked extends Schema.TaggedError<CodeGraphRefreshRetryBlocked>()(
  'CodeGraphRefreshRetryBlocked',
  {message: Schema.String},
) {}

export class CodeGraphRefreshRetryDeferred extends Schema.TaggedError<CodeGraphRefreshRetryDeferred>()(
  'CodeGraphRefreshRetryDeferred',
  {notBefore: Schema.Finite},
) {}

export const CODE_GRAPH_REFRESH_OPERATION = 'refresh code graph' as const;
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
    ...(Schema.is(CodeGraphScopeRoutingError)(cause) || Schema.is(CodeGraphRefreshRetryBlocked)(cause)
      ? {reobserveTarget: true as const}
      : {}),
    recovery: reconnectRequired || capacityFailure ? classified.recovery : defaults.recovery,
    retryable: reconnectRequired || capacityFailure ? classified.retryable : defaults.retryable,
  };
}

export function codeGraphRefreshFailureFromCause(cause: Cause.Cause<unknown>): CodeGraphRefreshFailure {
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
  | {readonly blocked?: true; readonly notBefore: number; readonly type: 'deferred'}
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
  readonly defer: (
    target: Target,
    token: string,
    blocked?: boolean,
  ) => Effect.Effect<CodeGraphRefreshDemandState, unknown, never>;
  readonly fail: (target: Target, token: string) => Effect.Effect<CodeGraphRefreshDemandState, unknown, never>;
  readonly isSuperseded: (cause: unknown) => boolean;
  readonly isRouteMismatch?: (cause: unknown) => boolean;
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
                ...(demand.target.retry?.blocked ? {blocked: true as const} : {}),
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
                input.defer(target, token).pipe(Effect.map(state => ({state, type: 'superseded' as const}))),
              ),
              Effect.catch(cause => {
                const failure = codeGraphRefreshFailure(cause);
                const transition = input.isRouteMismatch?.(cause)
                  ? input.defer(target, token, true)
                  : failure.retryable
                    ? input.defer(target, token)
                    : input.fail(target, token);
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
        if (outcome.blocked)
          return yield* CodeGraphRefreshRetryBlocked.make({
            message: 'Graph refresh target is blocked until its configuration or runtime changes.',
          });
        return yield* CodeGraphRefreshRetryDeferred.make({notBefore: outcome.notBefore});
      }
      if (outcome.type === 'superseded') {
        const desired = outcome.state.desired;
        if (desired !== undefined && desired.targetKey !== target.requestKey) continue;
        const latest = yield* input.observe;
        if (latest.requestKey !== target.requestKey) continue;
        if (desired?.retry !== undefined) {
          return yield* CodeGraphRefreshRetryDeferred.make({notBefore: desired.retry.notBefore});
        }
        // A foreign owner or an already-released claim cannot authorize another child.
        return;
      }
      if (outcome.type === 'completed') {
        if (outcome.state.desired === undefined) return;
        continue;
      }
      const desired = outcome.state.desired;
      if (desired !== undefined && desired.targetKey !== target.requestKey) continue;
      if (desired?.retry?.blocked) return yield* Effect.fail(outcome.cause);
      if (desired?.retry !== undefined) {
        return yield* CodeGraphRefreshRetryDeferred.make({notBefore: desired.retry.notBefore});
      }
      return yield* Effect.fail(outcome.cause);
    }
  });
}
