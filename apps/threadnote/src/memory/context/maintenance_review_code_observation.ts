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
    type Read = () => Effect.Effect<CodeGraphStatus, unknown>;
    const observations = new Map<string, {readonly read: Read; readonly status: CodeGraphStatus}>();
    const observe = (key: () => string, options: Parameters<typeof query.status>[2], read: Read) =>
      Effect.gen(function* () {
        // Preserve observers and maintenance behavior, and never turn unavailable/stale evidence into authority.
        if (
          options?.observeWorktree !== true ||
          options.requestMaintenance !== false ||
          options.afterIdentityObserved ||
          options.telemetry ||
          options.telemetryPhase ||
          options.telemetryWorktreeDisposition
        )
          return yield* read();
        const currentKey = key();
        const prior = observations.get(currentKey);
        if (prior) return prior.status;
        const current = yield* read();
        if (!current.stale && current.freshness === 'current' && current.readySnapshot && observations.size < 32)
          observations.set(currentKey, {read, status: current});
        return current;
      });
    const status: typeof query.status = (...args) => {
      const [home, cwd, options] = args;
      return observe(
        () => JSON.stringify(['status', home, cwd, options?.manifestPath, options?.project]),
        options,
        () => query.status(...args),
      );
    };
    const observed = {
      ...query,
      status,
      ...(typeof query.statusForPublishedIdentity !== 'function'
        ? {}
        : {
            statusForPublishedIdentity: ((...args) => {
              const [home, cwd, expected, options] = args;
              return observe(
                () =>
                  JSON.stringify([
                    'published-identity',
                    home,
                    cwd,
                    expected.checkoutId,
                    expected.repositoryId,
                    expected.worktreeId,
                    options?.manifestPath,
                    options?.project,
                  ]),
                options,
                () => query.statusForPublishedIdentity(...args),
              );
            }) satisfies typeof query.statusForPublishedIdentity,
          }),
    };
    const result = yield* read.pipe(Effect.provideService(CodeGraphQueryService, observed));
    for (const observation of observations.values()) {
      const current = yield* observation.read();
      if (current.stale || current.freshness !== 'current' || identity(current) !== identity(observation.status))
        return yield* AutomaticReviewCodeObservationChanged.make({
          message: 'The reviewed code source or its current project access changed. Reload the exact review.',
        });
    }
    return result;
  });
}
