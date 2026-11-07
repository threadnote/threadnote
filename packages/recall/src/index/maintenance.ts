import {Cause, Context, Effect, FileSystem, Option, Path, Schema, Semaphore} from 'effect';
import {makeReadDeadline, withinReadDeadline, type ReadDeadline} from '@threadnote/platform/read_deadline';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {
  readRecallLexicalDemand,
  recallLexicalDemandKey,
  RecallLexicalDemandUnavailable,
  requestRecallLexicalRefresh,
  type RecallLexicalScope,
} from '../background/lexical-demand.js';
import {RECALL_INVENTORY_POLICY_VERSION} from './freshness.js';
import {RecallReadyReadIncomplete} from './read_policy.js';

type MaintenanceOutcome = 'queued' | 'unavailable';
interface MissingSnapshot {
  readonly databasePath: string;
  readonly schemaVersion: number;
}
interface MissingAttempt extends MissingSnapshot {
  readonly generation: string;
  readonly policyVersion: string;
  readonly reconcile: boolean;
  outcome: MaintenanceOutcome;
  revision?: string;
}
interface ScopedMaintenance {
  deadline?: ReadDeadline;
  readonly semaphore: Semaphore.Semaphore;
  readonly scopes: Map<string, {reconcile: boolean; missing?: MissingAttempt}>;
}
const CurrentMaintenance = Context.Reference<ScopedMaintenance | undefined>('recall/ReadySectionsMaintenance', {
  defaultValue: () => undefined,
});

/** Only the closed sections operation opts in; each evaluation owns a fresh guard. */
export function withReadyRecallMaintenanceScope<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    return yield* effect.pipe(Effect.provideService(CurrentMaintenance, {semaphore, scopes: new Map()}));
  });
}

// Missing databases have no realPath. Resolve their nearest existing ancestor,
// including symlinks, without walking beyond this fixed lexical layout depth.
const physicalMissingDatabase = Effect.fn('recall.physicalMissingDatabase')(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let ancestor = filename;
  for (let depth = 0; depth < 5; depth++) {
    const real = yield* fs.realPath(ancestor).pipe(
      Effect.asSome,
      Effect.catchTag('PlatformError', error =>
        error.reason._tag === 'NotFound' ? Effect.succeed(Option.none<string>()) : Effect.fail(error),
      ),
    );
    if (Option.isSome(real)) return path.join(real.value, path.relative(ancestor, filename));
    ancestor = path.dirname(ancestor);
  }
  return yield* RecallLexicalDemandUnavailable.make({message: 'Missing lexical database path could not be resolved.'});
});

const scopedRequest = Effect.fn('recall.scopedMaintenanceRequest')(function* (
  state: ScopedMaintenance,
  scope: RecallLexicalScope,
  reconcile: boolean,
  missing: MissingSnapshot | undefined,
) {
  return yield* state.semaphore.withPermit(
    Effect.gen(function* () {
      state.deadline ??= yield* makeReadDeadline(100);
      return yield* withinReadDeadline(
        state.deadline,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.realPath(scope.agentContextHome);
          scope = {...scope, agentContextHome: home};
          const key = JSON.stringify([home, recallLexicalDemandKey(scope)]);
          const entry = state.scopes.get(key) ?? {reconcile: false};
          state.scopes.set(key, entry);
          entry.reconcile ||= reconcile;
          const observation = missing
            ? {
                ...missing,
                databasePath: yield* physicalMissingDatabase(missing.databasePath),
                generation: yield* readCanonicalMutationGeneration(fs, path, home, scope.account),
                policyVersion: RECALL_INVENTORY_POLICY_VERSION,
                reconcile: entry.reconcile,
              }
            : undefined;
          const previous = entry.missing;
          if (
            previous &&
            observation &&
            previous.databasePath === observation.databasePath &&
            previous.schemaVersion === observation.schemaVersion &&
            previous.policyVersion === observation.policyVersion &&
            previous.generation === observation.generation &&
            previous.reconcile === observation.reconcile
          ) {
            if (previous.outcome === 'unavailable') return 'unavailable' as const;
            const pending = yield* readRecallLexicalDemand(scope).pipe(Effect.orElseSucceed(() => undefined));
            if (
              previous.revision !== undefined &&
              pending?.revision === previous.revision &&
              pending.failures < 8 &&
              pending.sourceGeneration === observation.generation &&
              (!entry.reconcile || pending.reconcile === true) &&
              (yield* readCanonicalMutationGeneration(fs, path, home, scope.account)) === observation.generation
            )
              return 'queued' as const;
          }
          // Non-missing observations never reuse demand. In particular, a later
          // canonical mismatch must retain its stronger reconciliation request.
          const attempt: MissingAttempt | undefined = observation
            ? {...observation, outcome: 'unavailable'}
            : undefined;
          entry.missing = attempt;
          const revision = yield* requestRecallLexicalRefresh(scope, {reconcile: entry.reconcile});
          if (attempt) {
            attempt.outcome = 'queued';
            attempt.revision = revision === 'current' ? undefined : revision;
          }
          return 'queued' as const;
        }),
      );
    }),
  );
});

/** One bounded metadata attempt per read, including errors after query completion. */
export function makeReadyRecallMaintenance(scope: RecallLexicalScope) {
  let attempted = false;
  let outcome: MaintenanceOutcome = 'unavailable';
  const request = (reconcile = false, missing?: MissingSnapshot) =>
    Effect.suspend(() => {
      if (attempted) return Effect.succeed(outcome);
      attempted = true;
      return Effect.gen(function* () {
        const shared = yield* CurrentMaintenance;
        return yield* shared
          ? scopedRequest(shared, scope, reconcile, missing)
          : requestRecallLexicalRefresh(scope, {reconcile}).pipe(
              Effect.timeout('100 millis'),
              Effect.as('queued' as const),
            );
      }).pipe(
        Effect.interruptible,
        Effect.orElseSucceed(() => 'unavailable' as const),
        Effect.tap(value =>
          Effect.sync(() => {
            outcome = value;
          }),
        ),
      );
    });
  return {
    request,
    missing: (databasePath: string, schemaVersion: number) => request(false, {databasePath, schemaVersion}),
    onError: (cause: Cause.Cause<unknown>) => {
      if (attempted || Cause.hasInterrupts(cause)) return Effect.void;
      const error = Option.getOrUndefined(Cause.findErrorOption(cause));
      if (Schema.is(RecallReadyReadIncomplete)(error) && error.maintenance === undefined) return Effect.void;
      return request(Schema.is(RecallReadyReadIncomplete)(error) && error.maintenance === 'reconcile').pipe(
        Effect.asVoid,
      );
    },
  };
}

export function retainReadyRecallMaintenance(error: RecallReadyReadIncomplete, stale: boolean) {
  return RecallReadyReadIncomplete.make({
    message: error.message,
    ...(error.maintenance === 'reconcile'
      ? {maintenance: 'reconcile' as const}
      : stale
        ? {maintenance: 'refresh' as const}
        : {}),
  });
}
