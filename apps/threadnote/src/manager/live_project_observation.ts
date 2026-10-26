import {invalidateManagerReviewReadiness} from './review_actionability.js';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {managerLiveResourceKey, type ManagerLiveResource} from '@threadnote/manager/live/contracts';
import {candidateReviewObservationPaths} from '@threadnote/memory/candidate';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readSettledCanonicalMutationGeneration} from '@threadnote/store/resource/settled_revision';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {draftQueueObservationDirectory} from '../memory/context/maintenance_draft_queue.js';
import {automaticPreparationObservationDirectory} from '../memory/context/maintenance_preparation_state.js';
import {contextMaintenanceStatePath} from '../memory/context/maintenance.js';
import {selectedGenerationObservationPaths} from '../models/setup.js';
import {makeManagerHealthLiveSources, type ManagerHealthObservation} from './live_health_sources.js';
import {
  makeManagerSourceObservation,
  managerSourceDirectoryFiles,
  managerSourceFilesProbe,
  type ManagerSourceCallbacks,
} from './live_source_observation.js';

// The health observer admits at most 32 selectors. Retain one overflow selector to refuse coverage, never trim it.
const HEALTH_SOURCE_LIMIT = 32;
type HealthSelector = ManagerHealthObservation['citations'][number];

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
  const accountSourceProjects = new Set<string>();
  const retainedHealthInputs = new Map<string, ManagerHealthObservation>();
  let wake = Effect.void;
  let healthInvalidate = (_project: string, _revision: string): Effect.Effect<void> => Effect.void;
  const health = yield* makeManagerHealthLiveSources(config, {
    onInvalidate: (project, revision) =>
      Effect.gen(function* () {
        invalidateManagerReviewReadiness(config);
        healthRevisions.set(project, revision);
        yield* healthInvalidate(project, revision);
      }),
    onAvailability: (project, available) =>
      Effect.gen(function* () {
        invalidateManagerReviewReadiness(config);
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
        'project' in resource
          ? healthRevisions.get(resource.project)
          : JSON.stringify([[...healthRevisions].sort(), [...healthAvailable].sort()]);
      return {
        ...probe,
        revision: sha256HexSync(JSON.stringify([probe.revision, canonical, healthRevision])),
        nextChangeAt: clocks.get(managerLiveResourceKey(resource)),
      };
    }),
  );
  wake = observer.wake;
  healthInvalidate = (project, revision) =>
    Effect.all(
      [
        observer.invalidate({topic: 'home', scope: 'account'}, revision),
        observer.invalidate({topic: 'home', project}, revision),
        observer.invalidate({topic: 'automatic-memory', project}, revision),
      ],
      {discard: true},
    );
  const connections = new Map<string, readonly ManagerLiveResource[]>();
  const accountSubscribed = () =>
    [...connections.values()].some(resources =>
      resources.some(resource => resource.topic === 'home' && 'scope' in resource),
    );
  const syncAccountSources = Effect.gen(function* () {
    if (!accountSubscribed()) {
      accountSourceProjects.clear();
      yield* health.release('review-account-sources');
    } else yield* health.subscribe('review-account-sources', [...accountSourceProjects]);
  });
  const prune = () => {
    const retained = new Set([...connections.values()].flat().map(managerLiveResourceKey));
    for (const key of clocks.keys()) if (!retained.has(key)) clocks.delete(key);
    const projects = new Set(
      [...connections.values()].flatMap(resources =>
        resources.flatMap(resource => ('project' in resource ? [resource.project] : [])),
      ),
    );
    for (const project of accountSourceProjects) projects.add(project);
    for (const project of retainedHealthInputs.keys()) if (!projects.has(project)) retainedHealthInputs.delete(project);
    for (const project of healthAvailable.keys())
      if (!projects.has(project)) {
        healthAvailable.delete(project);
        healthRevisions.delete(project);
      }
  };
  return {
    ...observer,
    reviewReadiness: (project: string) =>
      (retainedHealthInputs.get(project)?.citations.length ?? 0) > HEALTH_SOURCE_LIMIT
        ? false
        : healthAvailable.get(project),
    healthHints: {
      register: (project: string, observation: Parameters<typeof health.hints.register>[1]) =>
        Effect.gen(function* () {
          if (accountSubscribed() && (accountSourceProjects.has(project) || accountSourceProjects.size < 8)) {
            accountSourceProjects.add(project);
            yield* syncAccountSources;
          }
          const retained =
            accountSourceProjects.has(project) ||
            [...connections.values()].some(resources =>
              resources.some(resource => 'project' in resource && resource.project === project),
            );
          if (!retained) return;
          const cwd = yield* fs.realPath(observation.cwd).pipe(Effect.orElseSucceed(() => observation.cwd));
          const previous = retainedHealthInputs.get(project);
          const sameRoot = previous?.cwd === cwd;
          const key = (citation: HealthSelector) => `${citation.repositoryId}:${citation.sourceCommit}`;
          const citations = new Map((sameRoot ? previous.citations : []).map(citation => [key(citation), citation]));
          for (const citation of observation.citations) {
            const identity = key(citation);
            if (citations.has(identity)) continue;
            if (citations.size > HEALTH_SOURCE_LIMIT) break;
            // A Pick type does not remove the extra fields of a full citation at runtime.
            citations.set(identity, {repositoryId: citation.repositoryId, sourceCommit: citation.sourceCommit});
          }
          const now = yield* Clock.currentTimeMillis;
          const deadlines = [sameRoot ? previous.nextChangeAt : undefined, observation.nextChangeAt].filter(
            (value): value is number => value !== undefined && Number.isFinite(value) && value > now,
          );
          const input: ManagerHealthObservation = {
            cwd,
            citations: [...citations.values()].sort((a, b) => key(a).localeCompare(key(b))),
            ...(deadlines.length ? {nextChangeAt: Math.min(...deadlines)} : {}),
          };
          retainedHealthInputs.set(project, input);
          yield* health.hints.register(project, input);
        }),
    },
    clockHints: {
      register: (topic: 'home' | 'automatic-memory', project: string, nextChangeAt?: number) =>
        Effect.gen(function* () {
          const resource = topic === 'home' && !project ? {topic, scope: 'account' as const} : {topic, project};
          if (!observer.hasResource(resource)) return;
          const key = managerLiveResourceKey(resource);
          const contributed = nextChangeAt !== undefined && Number.isFinite(nextChangeAt) ? nextChangeAt : undefined;
          const current = clocks.get(key);
          const now = yield* Clock.currentTimeMillis;
          const next =
            current !== undefined && current > now
              ? contributed === undefined
                ? current
                : Math.min(current, contributed)
              : contributed;
          if (clocks.get(key) === next) return;
          if (next === undefined) clocks.delete(key);
          else clocks.set(key, next);
          yield* observer.wake;
        }),
    },
    subscribe: (connection: string, requested: readonly ManagerLiveResource[]) =>
      Effect.gen(function* () {
        const resources = requested.filter(
          resource => resource.topic === 'home' || resource.topic === 'automatic-memory',
        );
        connections.set(connection, resources);
        yield* syncAccountSources;
        prune();
        yield* health.subscribe(
          connection,
          resources.flatMap(resource => ('project' in resource ? [resource.project] : [])),
        );
        return yield* observer.subscribe(connection, resources);
      }),
    release: (connection: string) =>
      Effect.gen(function* () {
        connections.delete(connection);
        yield* syncAccountSources;
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
