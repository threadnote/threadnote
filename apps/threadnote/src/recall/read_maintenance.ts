import {Context, Effect, Layer, Schema} from 'effect';
import {
  requestRecallLexicalRefresh,
  type RecallLexicalScope,
  type RecallReadMaintenanceWork,
} from '@threadnote/recall/background/lexical-demand';
import {syncSourcesBeforeRecall} from '@threadnote/integration-core/source-sync';
import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import {syncSharedReposBeforeAgentRead} from '../effect/share.js';
import {
  deferredCodeAnchorRouteHasPending,
  finalizeDeferredCodeAnchorsForRoute,
} from '../memory/deferred/code_anchor.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export class RecallReadMaintenanceUnavailable extends Schema.TaggedError<
  RecallReadMaintenanceUnavailable,
  {readonly brand: unique symbol}
>()('RecallReadMaintenanceUnavailable', {message: Schema.String}) {}
/** The home host stays model-independent; production composition owns application capabilities. */
export const RecallReadMaintenancePort = Context.Reference<
  ((scope: RecallLexicalScope) => Effect.Effect<'complete' | 'pending', unknown>) | undefined
>('@threadnote/threadnote/recall/ReadMaintenancePort', {defaultValue: () => undefined});
export const deferRecallReadMaintenance = Effect.fn('recall.deferReadMaintenance')(function* (
  config: RuntimeConfig,
  work: RecallReadMaintenanceWork,
) {
  let persisted = false;
  return yield* Effect.gen(function* () {
    if (
      work.kind === 'anchors' &&
      !(yield* deferredCodeAnchorRouteHasPending(config, {
        kind: 'repository',
        callerCwd: work.callerCwd,
        repositoryId: work.repositoryId,
        worktreeId: work.worktreeId,
      }))
    )
      return 'current' as const;
    const wake = yield* RecallEmbeddingWakePort;
    const value = yield* requestRecallLexicalRefresh({...config, includeInactive: false, work}).pipe(
      Effect.provideService(RecallEmbeddingWakePort, home =>
        Effect.sync(() => {
          // requestRecallLexicalRefresh reaches this port only after durable
          // publication and the demand lock's release finalizer have completed.
          persisted = true;
        }).pipe(Effect.andThen(() => (wake ? wake(home) : Effect.void))),
      ),
    );
    return value === 'current' ? ('current' as const) : ('queued' as const);
  }).pipe(
    Effect.timeout('100 millis'),
    // A slow best-effort wake cannot revoke this request's durable acceptance.
    // External interruption still propagates; only ordinary failures are recovered.
    Effect.orElseSucceed(() => (persisted ? ('queued' as const) : ('unavailable' as const))),
  );
});
const run = Effect.fn('recall.readMaintenance')(function* (scope: RecallLexicalScope) {
  if (!scope.manifestPath || !scope.work)
    return yield* RecallReadMaintenanceUnavailable.make({
      message: 'Optional recall maintenance configuration is unavailable.',
    });
  const config: RuntimeConfig = {...scope, manifestPath: scope.manifestPath, agentId: 'threadnote'};
  if (scope.work.kind === 'synchronize') {
    const shared = yield* syncSharedReposBeforeAgentRead(config, scope.work.teams);
    const sources = scope.work.sources ? yield* syncSourcesBeforeRecall(config) : undefined;
    if (shared.warnings.length || sources?.warnings.length)
      return yield* RecallReadMaintenanceUnavailable.make({message: 'Optional recall synchronization requires retry.'});
    return 'deferred' in shared && shared.deferred ? ('pending' as const) : ('complete' as const);
  }
  const receipt = yield* finalizeDeferredCodeAnchorsForRoute(
    config,
    {
      kind: 'repository',
      callerCwd: scope.work.callerCwd,
      repositoryId: scope.work.repositoryId,
      worktreeId: scope.work.worktreeId,
    },
    {limit: 4, preferredCodeRefs: scope.work.codeRefs, waitTimeoutMilliseconds: 0},
  );
  return receipt.state === 'completed' && receipt.pendingCount === 0 ? ('complete' as const) : ('pending' as const);
});
export const recallReadMaintenanceLayer = Layer.effect(
  RecallReadMaintenancePort,
  Effect.gen(function* () {
    const services = yield* Effect.context<Effect.Services<ReturnType<typeof run>>>();
    return (scope: RecallLexicalScope) => run(scope).pipe(Effect.provide(services));
  }),
);
