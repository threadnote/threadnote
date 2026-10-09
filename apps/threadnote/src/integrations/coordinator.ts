import {Effect} from 'effect';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {SourceCoordinatorError} from '@threadnote/integration-core/source-coordinator';
import {makeCoordinatorClientLayer, runCoordinatorWorker} from '@threadnote/integration-runtime/coordinator-transport';
import {obsidianSourceWork} from '@threadnote/integration-obsidian/source';
import {superhumanSourceWork} from '@threadnote/integration-superhuman/source';
import {pocketSourceWork} from '@threadnote/integration-pocket/source';
import {githubSourceWork} from '@threadnote/integration-github/source';
import {linearSourceWork} from '@threadnote/integration-linear/source';
import {INTEGRATION_SYNC_WORKER_ARGUMENT} from '../worker_protocol.js';

export const sourceWorkRegistrations = [
  obsidianSourceWork,
  superhumanSourceWork,
  pocketSourceWork,
  linearSourceWork,
  githubSourceWork,
] as const;

export function integrationSyncWorkerInvocation(
  executablePath: string,
  developmentEntrypoint: string,
  home: string,
): {readonly executable: string; readonly arguments: readonly string[]} {
  const executableName = executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
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

export const integrationCoordinatorClientLayer = makeCoordinatorClientLayer({
  registrations: sourceWorkRegistrations,
  spawnWorker: spawnIntegrationSyncWorker,
});

export function runIntegrationSyncWorker(config: RuntimeConfig) {
  return runCoordinatorWorker({config, registrations: sourceWorkRegistrations});
}
