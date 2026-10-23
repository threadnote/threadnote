import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {codeGraphLiveObservationPaths} from '@threadnote/graph/live_catalog_observation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  makeManagerSourceObservation,
  managerSourceFilesProbe,
  type ManagerSourceCallbacks,
} from './live_source_observation.js';

export const observeManagerGraphSources = Effect.fn('manager.graphLive.sources')(function* (config: RuntimeConfig) {
  const sources = yield* codeGraphLiveObservationPaths(config.agentContextHome);
  const metadata = yield* managerSourceFilesProbe(sources.files, sources.directories);
  return {
    ...metadata,
    revision: sha256HexSync(JSON.stringify([metadata.revision, sources.statusRevision])),
    nextChangeAt: sources.nextChangeAt,
  };
});

export const makeManagerGraphLiveObservation = Effect.fn('manager.graphLive.observe')(function* (
  config: RuntimeConfig,
  callbacks: ManagerSourceCallbacks,
) {
  const resource = {topic: 'graph-status', scope: 'account'} as const;
  let graphSourcesAvailable = false;
  let processSourceAvailable = false;
  const observer = yield* makeManagerSourceObservation(
    ['graph-status'],
    {
      onInvalidate: (changed, revision) =>
        graphSourcesAvailable && processSourceAvailable ? callbacks.onInvalidate(changed, revision) : Effect.void,
      onAvailability: (changed, available) => {
        graphSourcesAvailable = available;
        return callbacks.onAvailability(changed, available && processSourceAvailable);
      },
    },
    () => observeManagerGraphSources(config),
  );
  let sequence = 0;
  return {
    ...observer,
    subscribe: (connectionKey: string, resources: Parameters<typeof observer.subscribe>[1]) =>
      observer
        .subscribe(connectionKey, resources)
        .pipe(
          Effect.map(unavailable =>
            processSourceAvailable
              ? unavailable
              : [
                  ...unavailable,
                  ...resources.filter(
                    item => item.topic === 'graph-status' && !unavailable.some(missing => missing.topic === item.topic),
                  ),
                ],
          ),
        ),
    processAvailability: (available: boolean) =>
      Effect.gen(function* () {
        if (processSourceAvailable === available) return;
        processSourceAvailable = available;
        yield* callbacks.onAvailability(resource, graphSourcesAvailable && available);
      }),
    processChanged: Effect.suspend(() => observer.invalidate(resource, `process:${++sequence}`)),
    compactionChanged: Effect.suspend(() => observer.invalidate(resource, `compaction:${++sequence}`)),
  };
});
