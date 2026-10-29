import {Effect, FileSystem, Ref} from 'effect';
import {managerGraphBuildCatalog} from '@threadnote/graph/visualization';
import type {CodeGraphAutomaticCompactionStatus} from '@threadnote/graph/automatic/compaction';
import {graphStatusPollDelay} from '@threadnote/manager/graph';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {modelSetupObservationPaths} from '../models/setup.js';
import {autoUpdateObservationPath} from '../release/auto_update.js';
import {installedActiveReleaseObservationPath} from '../installations.js';
import {readManageableThreadnoteProcessDiagnostics} from '../process/diagnostics.js';
import {contextMaintenanceControlPath, contextMaintenanceStatePath} from '../memory/context/maintenance.js';
import {readManagerLiveProjects, type ManagerLive} from './live.js';
import {makeManagerLiveSources} from './live_sources.js';
import {makeHealthEnabledManagerLive} from './live_health_sources.js';
import {makeManagerLiveConsumerObservation} from './live_consumer_observation.js';
import {makeManagerGraphLiveObservation} from './live_graph_observation.js';
import {makeManagerProjectLiveObservation} from './live_project_observation.js';

/** Manager-owned live sources share one subscription lifecycle and publish through the same socket. */
export const makeManagerLiveObservationRuntime = Effect.fn('manager.liveObservationRuntime')(function* (
  config: RuntimeConfig,
  port: number,
  token: string,
  automaticCompactionStatus: Ref.Ref<CodeGraphAutomaticCompactionStatus>,
) {
  const environment = yield* Effect.context<
    | Effect.Services<ReturnType<typeof managerGraphBuildCatalog>>
    | Effect.Services<ReturnType<typeof readManageableThreadnoteProcessDiagnostics>>
  >();
  const current: {live?: ManagerLive} = {};
  const callbacks = {
    onInvalidate: (resource, revision) =>
      Effect.suspend(() => current.live?.publishResource(resource, revision) ?? Effect.void),
    onAvailability: (resource, available) =>
      Effect.suspend(() => current.live?.publishResourceAvailability(resource, available) ?? Effect.void),
  } satisfies Parameters<typeof makeManagerGraphLiveObservation>[1];
  const graph = yield* makeManagerGraphLiveObservation(config, callbacks);
  const project = yield* makeManagerProjectLiveObservation(config, callbacks);
  const observations = yield* makeManagerLiveConsumerObservation(config, callbacks, {
    modelPaths: yield* modelSetupObservationPaths(config.agentContextHome),
    runtimePaths: [yield* autoUpdateObservationPath(), yield* installedActiveReleaseObservationPath()],
    adapters: [graph, project],
  });
  const {live, healthHints} = yield* makeHealthEnabledManagerLive(config, {
    origin: `http://127.0.0.1:${port}`,
    token,
    projects: readManagerLiveProjects(yield* FileSystem.FileSystem, config.manifestPath),
    observations,
    snapshots: {
      processes: observations.processSnapshot.pipe(
        Effect.filterOrElse(
          snapshot => snapshot !== undefined,
          () => readManageableThreadnoteProcessDiagnostics(config),
        ),
        Effect.map(data => ({data, reconcileMilliseconds: 2_000})),
        Effect.provide(environment),
      ),
      'graph-status': Ref.get(automaticCompactionStatus).pipe(
        Effect.flatMap(status => managerGraphBuildCatalog(config.agentContextHome, status)),
        Effect.map(data => ({
          data,
          reconcileMilliseconds: graphStatusPollDelay(
            data.builds,
            data.maintenance,
            data.lifecyclePending,
            data.automaticCompaction,
          ),
        })),
        Effect.provide(environment),
      ),
    },
  });
  current.live = live;
  const sources = yield* makeManagerLiveSources({
    home: config.agentContextHome,
    account: config.account,
    maintenanceStatePath: yield* contextMaintenanceStatePath(config),
    maintenanceControlPath: yield* contextMaintenanceControlPath(config),
    manifestPath: config.manifestPath,
    onScopeChange: live.invalidateScope,
    onInvalidate: (topics, revision) =>
      Effect.all([live.publish(topics, revision), project.canonicalChanged(revision)], {discard: true}),
  });
  return {graph, project, observations, live, healthHints, sources};
});
