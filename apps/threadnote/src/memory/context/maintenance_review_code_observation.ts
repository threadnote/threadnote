import {Effect, Option, Schema} from 'effect';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {codeGraphQueryScopeReceipt} from '@threadnote/graph/query/scope';
import type {CodeGraphStatus} from '@threadnote/graph/types';

class AutomaticReviewCodeObservationChanged extends Schema.TaggedError<
  AutomaticReviewCodeObservationChanged,
  {readonly brand: unique symbol}
>()('AutomaticReviewCodeObservationChanged', {message: Schema.String}) {}

function identity(status: CodeGraphStatus) {
  const observation = observationFromCodeGraphStatus(status);
  return JSON.stringify([
    status.databasePath,
    status.identity,
    status.readySnapshot,
    status.projectCoverage,
    codeGraphQueryScopeReceipt(observation?.projectScope),
  ]);
}

/** One verification owns its observations; a separate live closing fence must validate every reused snapshot. */
export function withAutomaticReviewCodeObservations<A, E, R>(read: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const service = yield* Effect.serviceOption(CodeGraphQueryService);
    if (Option.isNone(service)) return yield* read;
    const query = service.value;
    type Arguments = Parameters<typeof query.status>;
    const observations = new Map<string, {readonly args: Arguments; readonly status: CodeGraphStatus}>();
    const status: typeof query.status = (...args) =>
      Effect.gen(function* () {
        const [home, cwd, options] = args;
        // Preserve observers and maintenance behavior, and never turn unavailable/stale evidence into authority.
        if (
          options?.observeWorktree !== true ||
          options.requestMaintenance !== false ||
          options.afterIdentityObserved ||
          options.telemetry ||
          options.telemetryPhase ||
          options.telemetryWorktreeDisposition
        )
          return yield* query.status(...args);
        const key = JSON.stringify([home, cwd, options.manifestPath, options.project]);
        const prior = observations.get(key);
        if (prior) return prior.status;
        const current = yield* query.status(...args);
        if (!current.stale && current.freshness === 'current' && current.readySnapshot && observations.size < 32)
          observations.set(key, {args, status: current});
        return current;
      });
    const result = yield* read.pipe(Effect.provideService(CodeGraphQueryService, {...query, status}));
    for (const observation of observations.values()) {
      const current = yield* query.status(...observation.args);
      if (current.stale || current.freshness !== 'current' || identity(current) !== identity(observation.status))
        return yield* AutomaticReviewCodeObservationChanged.make({
          message: 'The reviewed code source or its current project access changed. Reload the exact review.',
        });
    }
    return result;
  });
}
