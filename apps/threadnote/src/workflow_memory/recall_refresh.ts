import {Context, Effect} from 'effect';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';

type Config = Parameters<typeof refreshRecallDerivedIndexesAfterCanonicalMutation>[0];
type Batch = {readonly config: Config; readonly uris: Set<string>; active: boolean};
const CurrentWorkflowRecallBatch = Context.Reference<Batch | undefined>('threadnote/CurrentWorkflowRecallBatch', {
  defaultValue: () => undefined,
});
const register = (config: Config, uris: readonly string[]) =>
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
    for (const uri of uris) batch.uris.add(uri);
    return true;
  });

/** Callback injection keeps lifecycle tests independent of recall storage/model services. */
export const makeWorkflowRecallRefresh = <R>(
  refresh: (config: Config, uris: readonly string[]) => Effect.Effect<unknown, never, R>,
) => {
  const flush = (batch: Batch, cleanup: boolean) =>
    Effect.suspend(() => {
      // Revoke inherited tokens before scanning; release must not retry a normal flush.
      batch.active = false;
      const uris = [...batch.uris];
      batch.uris.clear();
      if (!uris.length) return Effect.void;
      const complete = refresh(batch.config, uris);
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
    track: (config: Config, uris: readonly string[]) => register(config, uris).pipe(Effect.asVoid),
    refresh: (config: Config, uris: readonly string[]) =>
      register(config, uris).pipe(
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
          active: true,
        })),
        batch =>
          program.pipe(
            Effect.provideService(CurrentWorkflowRecallBatch, batch),
            Effect.tap(() => flush(batch, false)),
          ),
        batch => flush(batch, true),
      ),
  };
};

const workflowRecallRefresh = makeWorkflowRecallRefresh(refreshRecallDerivedIndexesAfterCanonicalMutation);
export const trackPotentialWorkflowMutation = workflowRecallRefresh.track;
export const refreshWorkflowRecall = workflowRecallRefresh.refresh;
export const withWorkflowRecallRefreshBatch = workflowRecallRefresh.withBatch;
