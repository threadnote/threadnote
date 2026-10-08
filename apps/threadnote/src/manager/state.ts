import {Effect} from 'effect';
import {resolveEffectAiConfiguration} from '../effect/ai/consolidator.js';
import {SystemInfo} from '@threadnote/platform/system';
import {discoverLocalConsolidationModels} from './consolidation_models.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {currentPackageVersion, fetchLatestVersion, releaseSource} from '../release/index.js';
import {selectUpdateChannel} from '../release/channel.js';
import {findExecutable} from '../utils.js';
import {compareVersions, isDevelopmentBuildVersion} from '../release/version/compare.js';
import {readAutoUpdateStatus} from '../release/auto_update.js';

export const detectConsolidationAgents = Effect.fn('manager.detectConsolidationAgents')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const effectAi = yield* resolveEffectAiConfiguration(config, (yield* SystemInfo).environment());
  const nativeModels = yield* discoverLocalConsolidationModels(config.agentContextHome);
  const [codex, claude, cursor, copilot] = yield* Effect.all([
    findExecutable(['codex']),
    findExecutable(['claude']),
    findExecutable(['cursor-agent']),
    findExecutable(['copilot']),
  ]);
  return [
    {available: codex !== undefined, command: codex, id: 'codex', label: 'Codex'},
    {available: claude !== undefined, command: claude, id: 'claude', label: 'Claude'},
    {available: cursor !== undefined, command: cursor, id: 'cursor', label: 'Cursor'},
    {available: copilot !== undefined, command: copilot, id: 'copilot', label: 'Copilot'},
    {
      available: nativeModels.length > 0,
      command: nativeModels.find(model => model.isDefault)?.id ?? nativeModels[0]?.id,
      id: 'local-ai',
      label: 'Threadnote local AI',
    },
    {
      available: effectAi !== undefined,
      command: effectAi?.configuration.model,
      id: 'effect-ai',
      label: 'Configured remote AI',
    },
  ];
});

export function managerUpdateAvailable(currentVersion: string, latestVersion?: string): boolean {
  return (
    !isDevelopmentBuildVersion(currentVersion) &&
    latestVersion !== undefined &&
    compareVersions(latestVersion, currentVersion) > 0
  );
}

export const fetchManagerLatestVersion = Effect.fn('manager.fetchLatestVersion')(function* (
  currentVersion: string,
  source: string,
) {
  if (isDevelopmentBuildVersion(currentVersion)) return undefined;
  return yield* fetchLatestVersion(source, selectUpdateChannel(currentVersion)).pipe(
    Effect.orElseSucceed(() => undefined),
  );
});

export const readManagerRuntimeState = Effect.fn('manager.readRuntimeState')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const system = yield* SystemInfo;
  const [agents, autoUpdate, version] = yield* Effect.all([
    detectConsolidationAgents(config),
    readAutoUpdateStatus(),
    currentPackageVersion(),
  ]);
  const latestVersion = yield* fetchManagerLatestVersion(version, releaseSource(system.environment()));
  return {
    agents,
    autoUpdate,
    latestVersion,
    updateAvailable: managerUpdateAvailable(version, latestVersion),
    version,
  };
});
