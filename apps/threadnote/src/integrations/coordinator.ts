import {Array as EffectArray, Console, Context, Effect, Layer} from 'effect';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  SourceCoordinator,
  SourceCoordinatorError,
  type SourceWorkRegistration,
} from '@threadnote/integration-core/source-coordinator';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';
import {makeCoordinatorClientLayer, runCoordinatorWorker} from '@threadnote/integration-runtime/coordinator-transport';
export {coordinatorWorkerFailureMessage} from '@threadnote/integration-runtime/coordinator-transport';
import {obsidianSourceWork} from '@threadnote/integration-obsidian/source';
import {superhumanSourceWork} from '@threadnote/integration-superhuman/source';
import {pocketSourceWork} from '@threadnote/integration-pocket/source';
import {githubSourceWork} from '@threadnote/integration-github/source';
import {linearSourceWork} from '@threadnote/integration-linear/source';
import {INTEGRATION_SYNC_WORKER_ARGUMENT} from '../worker_protocol.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const sourceRecallDeferredWarning =
  'Source data was saved, but recall refresh is deferred. Run threadnote repair.';

export function withSourceRecallCompletion<R>(
  registration: SourceWorkRegistration<R>,
): SourceWorkRegistration<R | Effect.Services<ReturnType<typeof refreshRecallDerivedIndexesAfterCanonicalMutation>>> {
  return {
    ...registration,
    completion: {
      deferredWarning: sourceRecallDeferredWarning,
      run: (config: RuntimeConfig) =>
        refreshRecallDerivedIndexesAfterCanonicalMutation(config, []).pipe(
          Effect.map(outcome => (outcome.state === 'deferred' ? [sourceRecallDeferredWarning] : [])),
        ),
    },
  };
}

const sourceWorkProviders = [
  obsidianSourceWork,
  superhumanSourceWork,
  pocketSourceWork,
  linearSourceWork,
  githubSourceWork,
] as const;

export const sourceWorkRegistrations = EffectArray.map(sourceWorkProviders, registration =>
  withSourceRecallCompletion(registration),
);

export function withSourceRecallWarnings(coordinator: Context.Service.Shape<typeof SourceCoordinator>) {
  return SourceCoordinator.of({
    ...coordinator,
    sync: (config, sourceId) =>
      coordinator
        .sync(config, sourceId)
        .pipe(
          Effect.tap(reply =>
            reply.warnings.includes(sourceRecallDeferredWarning)
              ? Console.warn(sourceRecallDeferredWarning)
              : Effect.void,
          ),
        ),
  });
}

export function integrationSyncWorkerInvocation(
  executablePath: string,
  developmentEntrypoint: string,
  home: string,
): {readonly executable: string; readonly arguments: readonly string[]} {
  const executableName = Effect2.pipe(
    Effect2.pipe(executablePath, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  return {
    executable: executablePath,
    arguments: [
      ...(executableName === 'bun' || executableName === 'bun.exe' ? [developmentEntrypoint] : []),
      INTEGRATION_SYNC_WORKER_ARGUMENT,
      '--home',
      home,
    ],
  };
}

const spawnIntegrationSyncWorker = Effect.fn('source.coordinator.spawn')(function* (config: RuntimeConfig) {
  const system = yield* SystemInfo;
  const invocation = integrationSyncWorkerInvocation(
    system.executablePath,
    system.developmentEntrypoint,
    config.agentContextHome,
  );
  const started = yield* runDetachedCommandEffect(invocation.executable, invocation.arguments, {
    env: {...system.environment(), THREADNOTE_HOME: config.agentContextHome},
  });
  if (!started) return yield* SourceCoordinatorError.make({message: 'Could not start the source sync coordinator.'});
});

const coordinatorClientLayer = makeCoordinatorClientLayer({
  registrations: sourceWorkProviders,
  spawnWorker: spawnIntegrationSyncWorker,
});

export const integrationCoordinatorClientLayer = Layer.effectContext(
  Effect.gen(function* () {
    const context = yield* Layer.build(coordinatorClientLayer);
    return Context.add(context, SourceCoordinator, withSourceRecallWarnings(Context.get(context, SourceCoordinator)));
  }),
);

export function runIntegrationSyncWorker(config: RuntimeConfig) {
  return runCoordinatorWorker({config, registrations: sourceWorkRegistrations});
}
