import {Context, Effect} from 'effect';
import {
  CurrentResourceRecallInvalidationObserver,
  makeResourceRecallInvalidationObservation,
  type ResourceRecallInvalidationReceipt,
} from '@threadnote/store/resource/recall-invalidation';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';
import {withRecallDatabaseSession} from '@threadnote/recall/index';

type Config = Parameters<typeof refreshRecallDerivedIndexesAfterCanonicalMutation>[0];
type Batch = {
  readonly config: Config;
  readonly uris: Set<string>;
  readonly observation: ReturnType<typeof makeResourceRecallInvalidationObservation>;
  active: boolean;
};
const CurrentWorkflowRecallBatch = Context.Reference<Batch | undefined>('threadnote/CurrentWorkflowRecallBatch', {
  defaultValue: () => undefined,
});
const register = (config: Config, uris: readonly string[], phase: 'expect' | 'verify') =>
  Effect.gen(function* () {
    const batch = yield* CurrentWorkflowRecallBatch;
    if (
      !batch?.active ||
      batch.config.agentContextHome !== config.agentContextHome ||
      batch.config.account !== config.account ||
      batch.config.user !== config.user ||
      batch.config.manifestPath !== config.manifestPath
    )
      return false;
    // A hook names affected resources, including source/destination aliases.
    // Count each URI once here; separate hook calls remain separate mutations.
    const affectedUris = [...new Set(uris)];
    for (const uri of affectedUris) batch.uris.add(uri);
    batch.observation[phase](affectedUris);
    return true;
  });

/** Callback injection keeps lifecycle tests independent of recall storage/model services. */
export const makeWorkflowRecallRefresh = <R>(
  refresh: (
    config: Config,
    uris: readonly string[],
    receipt?: ResourceRecallInvalidationReceipt,
  ) => Effect.Effect<unknown, never, R>,
) => {
  const flush = (batch: Batch, cleanup: boolean) =>
    Effect.suspend(() => {
      // Revoke inherited tokens before scanning; release must not retry a normal flush.
      batch.active = false;
      const uris = [...batch.uris];
      batch.uris.clear();
      const receipt = batch.observation.finish(!cleanup, uris);
      if (!uris.length) return Effect.void;
      const complete = refresh(batch.config, uris, receipt);
      return cleanup
        ? complete.pipe(
            Effect.interruptible,
            Effect.timeout('5 seconds'),
            Effect.catchCause(() =>
              Effect.logWarning(
                'Canonical memory was committed, but derived recall indexes could not be refreshed. Run threadnote repair.',
              ),
            ),
          )
        : complete.pipe(Effect.asVoid);
    });
  return {
    track: (config: Config, uris: readonly string[]) => register(config, uris, 'expect').pipe(Effect.asVoid),
    verified: (config: Config, uris: readonly string[]) => register(config, uris, 'verify').pipe(Effect.asVoid),
    refresh: (config: Config, uris: readonly string[]) =>
      register(config, uris, 'verify').pipe(
        Effect.flatMap(queued => (queued ? Effect.void : refresh(config, uris).pipe(Effect.asVoid))),
      ),
    withBatch: <A, E, R2>(config: Config, program: Effect.Effect<A, E, R2>) =>
      Effect.acquireUseRelease(
        Effect.sync((): Batch => ({
          config: {
            account: config.account,
            agentContextHome: config.agentContextHome,
            user: config.user,
            manifestPath: config.manifestPath,
          },
          uris: new Set(),
          observation: makeResourceRecallInvalidationObservation({
            home: config.agentContextHome,
            account: config.account,
            user: config.user,
          }),
          active: true,
        })),
        batch =>
          program.pipe(
            Effect.provideService(CurrentWorkflowRecallBatch, batch),
            Effect.provideService(CurrentResourceRecallInvalidationObserver, batch.observation.observer),
            Effect.tap(() => flush(batch, false)),
            withRecallDatabaseSession,
          ),
        batch => flush(batch, true),
      ),
  };
};

const workflowRecallRefresh = makeWorkflowRecallRefresh(refreshRecallDerivedIndexesAfterCanonicalMutation);
export const trackPotentialWorkflowMutation = workflowRecallRefresh.track;
export const verifyWorkflowMutation = workflowRecallRefresh.verified;
export const refreshWorkflowRecall = workflowRecallRefresh.refresh;
export const withWorkflowRecallRefreshBatch = workflowRecallRefresh.withBatch;
