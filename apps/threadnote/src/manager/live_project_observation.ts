import {Effect, FileSystem, Path} from 'effect';
import {managerLiveResourceKey, type ManagerLiveResource} from '@threadnote/manager/live/contracts';
import {candidateReviewObservationPaths} from '@threadnote/memory/candidate';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readSettledCanonicalMutationGeneration} from '@threadnote/store/resource/settled_revision';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {draftQueueObservationDirectory} from '../memory/context/maintenance_draft_queue.js';
import {automaticPreparationObservationDirectory} from '../memory/context/maintenance_preparation_state.js';
import {contextMaintenanceStatePath} from '../memory/context/maintenance.js';
import {selectedGenerationObservationPaths} from '../models/setup.js';
import {makeManagerHealthLiveSources} from './live_health_sources.js';
import {
  makeManagerSourceObservation,
  managerSourceDirectoryFiles,
  managerSourceFilesProbe,
  type ManagerSourceCallbacks,
} from './live_source_observation.js';

/** Source clocks for project projections. Full health/value/model projections run only in REST readers. */
export const makeManagerProjectLiveObservation = Effect.fn('manager.projectLive.observe')(function* (
  config: RuntimeConfig,
  callbacks: ManagerSourceCallbacks,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const healthAvailable = new Map<string, boolean>();
  const healthRevisions = new Map<string, string>();
  const clocks = new Map<string, number>();
  let wake = Effect.void;
  let healthInvalidate = (_project: string, _revision: string): Effect.Effect<void> => Effect.void;
  const health = yield* makeManagerHealthLiveSources(config, {
    onInvalidate: (project, revision) =>
      Effect.gen(function* () {
        healthRevisions.set(project, revision);
        yield* healthInvalidate(project, revision);
      }),
    onAvailability: (project, available) =>
      Effect.gen(function* () {
        healthAvailable.set(project, available);
        yield* wake;
      }),
  });
  const observer = yield* makeManagerSourceObservation(['home', 'automatic-memory'], callbacks, resource =>
    Effect.gen(function* () {
      if (resource.topic === 'home' && 'project' in resource && !healthAvailable.get(resource.project))
        return undefined;
      const reviews = yield* candidateReviewObservationPaths(config.agentContextHome);
      if (reviews.state !== 'ready') return undefined;
      const files = [...reviews.files, yield* contextMaintenanceStatePath(config), config.manifestPath];
      let nativeArtifactFiles: readonly string[] = [];
      const directories = [reviews.directory, path.dirname(reviews.directory), config.agentContextHome];
      if (resource.topic === 'home' && 'project' in resource) {
        files.push(
          path.join(config.agentContextHome, 'value', 'value-events-v1.jsonl'),
          path.join(config.agentContextHome, 'feedback', 'recall-events-v1.jsonl'),
        );
      }
      if (resource.topic === 'automatic-memory') {
        const queue = yield* draftQueueObservationDirectory(config);
        const preparation = yield* automaticPreparationObservationDirectory(config);
        const generationSources = yield* selectedGenerationObservationPaths(config.agentContextHome);
        nativeArtifactFiles = generationSources.slice(2);
        files.push(
          path.join(queue, 'queue.json'),
          ...(yield* managerSourceDirectoryFiles(queue, name => /^target-[a-f0-9]{64}\.json$/.test(name))),
          ...(yield* managerSourceDirectoryFiles(preparation, name => /^[a-f0-9]{64}\.json$/.test(name))),
          ...generationSources,
        );
        directories.push(queue, preparation, path.dirname(queue), path.dirname(preparation));
      }
      const probe = yield* managerSourceFilesProbe(files, directories, nativeArtifactFiles);
      // Use the same post-commit fence as canonical health invalidations. Never watch the transient lock itself.
      const canonical = yield* readSettledCanonicalMutationGeneration(
        fs,
        path,
        config.agentContextHome,
        config.account,
      );
      const healthRevision =
        resource.topic === 'home' && 'project' in resource ? healthRevisions.get(resource.project) : undefined;
      return {
        ...probe,
        revision: sha256HexSync(JSON.stringify([probe.revision, canonical, healthRevision])),
        nextChangeAt: clocks.get(managerLiveResourceKey(resource)),
      };
    }),
  );
  wake = observer.wake;
  healthInvalidate = (project, revision) => observer.invalidate({topic: 'home', project}, revision);
  const connections = new Map<string, readonly ManagerLiveResource[]>();
  const prune = () => {
    const retained = new Set([...connections.values()].flat().map(managerLiveResourceKey));
    for (const key of clocks.keys()) if (!retained.has(key)) clocks.delete(key);
    const projects = new Set(
      [...connections.values()].flatMap(resources =>
        resources.flatMap(resource => (resource.topic === 'home' && 'project' in resource ? [resource.project] : [])),
      ),
    );
    for (const project of healthAvailable.keys())
      if (!projects.has(project)) {
        healthAvailable.delete(project);
        healthRevisions.delete(project);
      }
  };
  return {
    ...observer,
    healthHints: health.hints,
    clockHints: {
      register: (topic: 'home' | 'automatic-memory', project: string, nextChangeAt?: number) =>
        Effect.suspend(() => {
          const resource = {topic, project} as const;
          if (!observer.hasResource(resource)) return Effect.void;
          const key = managerLiveResourceKey(resource);
          const next = nextChangeAt !== undefined && Number.isFinite(nextChangeAt) ? nextChangeAt : undefined;
          if (clocks.get(key) === next) return Effect.void;
          if (next === undefined) clocks.delete(key);
          else clocks.set(key, next);
          return observer.wake;
        }),
    },
    subscribe: (connection: string, requested: readonly ManagerLiveResource[]) =>
      Effect.gen(function* () {
        const resources = requested.filter(
          resource => resource.topic === 'home' || resource.topic === 'automatic-memory',
        );
        connections.set(connection, resources);
        prune();
        yield* health.subscribe(
          connection,
          resources.flatMap(resource => (resource.topic === 'home' && 'project' in resource ? [resource.project] : [])),
        );
        return yield* observer.subscribe(connection, resources);
      }),
    release: (connection: string) =>
      Effect.gen(function* () {
        connections.delete(connection);
        prune();
        yield* health.release(connection);
        yield* observer.release(connection);
      }),
    canonicalChanged: (revision: string) =>
      Effect.gen(function* () {
        const resources = new Map(
          [...connections.values()].flat().map(resource => [managerLiveResourceKey(resource), resource]),
        );
        for (const resource of resources.values()) yield* observer.invalidate(resource, revision);
        yield* observer.wake;
      }),
  };
});
