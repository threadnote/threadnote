import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Deferred, Effect, FileSystem, Path, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runCommandEffect} from '@threadnote/platform/command';
import {resourceAccountMutationLockPath, resourceAccountMutationLockPolicy} from '@threadnote/store/resource/lock';
import {advanceCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {makeManagerProjectLiveObservation} from '../../src/manager/live_project_observation.js';
import {draftQueueObservationDirectory} from '../../src/memory/context/maintenance_draft_queue.js';
import {automaticPreparationObservationDirectory} from '../../src/memory/context/maintenance_preparation_state.js';
import {selectedGenerationObservationPaths} from '../../src/models/setup.js';
import {buildLocalValueReport} from '../../src/value_report/commands.js';
import {ManagerConsumerClockHints} from '../../src/manager/live_consumer_sources.js';
import {ManagerHealthObservationHints} from '../../src/manager/live_health_sources.js';
import {handleManagerHomeRequest} from '../../src/manager/home.js';
import {makeManagerGraphLiveObservation} from '../../src/manager/live_graph_observation.js';

describe('Manager project live integration', () => {
  effectIt.effect('invalidates graph status when an external process removes a remembered worktree', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs
        .makeTempDirectoryScoped({prefix: 'manager-graph-worktree-'})
        .pipe(Effect.flatMap(fs.realPath));
      const checkoutId = 'a'.repeat(64),
        worktreeId = 'b'.repeat(64);
      const context = path.join(home, 'indexes', 'code-graph', 'repositories', checkoutId, 'local-context');
      const directory = path.join(context, 'worktrees');
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
      yield* fs.chmod(context, 0o700);
      const worktree = path.join(home, 'remembered-worktree');
      yield* fs.makeDirectory(worktree);
      yield* fs.writeFileString(
        path.join(directory, `${worktreeId}.json`),
        JSON.stringify({
          schemaVersion: 2,
          checkoutId,
          worktreeId,
          repositoryId: 'c'.repeat(64),
          canonicalWorktreePath: worktree,
          observedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          registration: {kind: 'main'},
        }),
        {mode: 0o600},
      );
      const changes: string[] = [];
      const observer = yield* makeManagerGraphLiveObservation(
        {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          user: 'tester',
          manifestPath: path.join(home, 'manifest.yaml'),
        },
        {
          onInvalidate: resource =>
            Effect.sync(() => {
              changes.push(resource.topic);
            }),
          onAvailability: () => Effect.void,
        },
      ).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
      yield* observer.processAvailability(true);
      expect(yield* observer.subscribe('graph-tab', [{topic: 'graph-status', scope: 'account'}])).toEqual([]);
      yield* observer.reconcileNow;
      expect(changes).toEqual([]);
      yield* fs.remove(worktree, {recursive: true});
      // Lost filesystem watch and no local compaction callbacks: bounded reconciliation still covers removal.
      yield* observer.reconcileNow;
      expect(changes).toEqual(['graph-status']);
      yield* observer.reconcileNow;
      expect(changes).toEqual(['graph-status']);
      yield* observer.release('graph-tab');
      expect(yield* observer.diagnostics).toEqual({resources: 0, connections: 0, watches: 0});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('bootstraps project Home observation from its authoritative REST projection', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-home-live-'});
      const repository = path.join(home, 'repository');
      yield* runCommandEffect('git', ['init', '-q', repository]);
      yield* fs.writeFileString(path.join(repository, 'README.md'), 'disposable Home fixture\n');
      yield* runCommandEffect('git', ['-C', repository, 'add', 'README.md']);
      yield* runCommandEffect('git', [
        '-C',
        repository,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'initial',
      ]);
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        user: 'tester',
        manifestPath: path.join(home, 'manifest.yaml'),
      };
      yield* fs.writeFileString(
        config.manifestPath,
        `version: 1\nprojects:\n  - name: alpha\n    path: ${repository}\n    uri: threadnote://resources/repos/alpha\n    seed: []\n`,
      );
      const available = yield* Deferred.make<void>();
      const resource = {topic: 'home', project: 'alpha'} as const;
      const observer = yield* makeManagerProjectLiveObservation(config, {
        onInvalidate: () => Effect.void,
        onAvailability: (changed, supported) =>
          changed.topic === 'home' && 'project' in changed && changed.project === 'alpha' && supported
            ? Deferred.succeed(available, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      expect(yield* observer.subscribe('home-tab', [resource])).toEqual([resource]);
      let registrations = 0;
      const response = yield* handleManagerHomeRequest({
        config,
        method: 'GET',
        url: new URL('http://localhost/api/home?project=alpha'),
      }).pipe(
        Effect.provideService(ManagerHealthObservationHints, {
          register: (project, observation) =>
            Effect.sync(() => {
              registrations++;
            }).pipe(Effect.andThen(observer.healthHints.register(project, observation))),
        }),
        Effect.provideService(ManagerConsumerClockHints, observer.clockHints),
      );
      expect(response?.status).toBe(200);
      expect(registrations, JSON.stringify(response?.body)).toBe(1);
      yield* Deferred.await(available).pipe(Effect.timeout('5 seconds'));
      expect(yield* observer.subscribe('home-tab', [resource])).toEqual([]);
      yield* observer.release('home-tab');
      expect(yield* observer.diagnostics).toEqual({resources: 0, connections: 0, watches: 0});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'observes settled canonical, queue, preparation and model changes without querying report projections',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-project-live-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          user: 'tester',
          manifestPath: path.join(home, 'manifest.yaml'),
        };
        yield* fs.writeFileString(config.manifestPath, 'projects: []\n');
        const changes: string[] = [];
        const observer = yield* makeManagerProjectLiveObservation(config, {
          onInvalidate: resource =>
            Effect.sync(() => {
              changes.push(resource.topic);
            }),
          onAvailability: () => Effect.void,
        }).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
        const homeResource = {topic: 'home', scope: 'account'} as const;
        const automatic = {topic: 'automatic-memory', project: 'alpha'} as const;
        expect(yield* observer.subscribe('tab', [homeResource, automatic])).toEqual([]);
        const queue = yield* draftQueueObservationDirectory(config);
        const preparation = yield* automaticPreparationObservationDirectory(config);
        const modelPaths = yield* selectedGenerationObservationPaths(home);
        const sources = [
          path.join(queue, 'queue.json'),
          path.join(queue, `target-${'a'.repeat(64)}.json`),
          path.join(preparation, `${'b'.repeat(64)}.json`),
          modelPaths.at(-1)!,
        ];
        for (const file of sources) {
          yield* fs.makeDirectory(path.dirname(file), {recursive: true});
          yield* fs.writeFileString(file + '.tmp', 'metadata-only-fixture');
          yield* fs.rename(file + '.tmp', file);
          const before = changes.length;
          yield* observer.reconcileNow;
          expect(changes.slice(before)).toEqual(['automatic-memory']);
        }
        yield* withExclusiveFileLock(
          fs,
          resourceAccountMutationLockPath(path, home, 'local'),
          resourceAccountMutationLockPolicy,
          advanceCanonicalMutationGeneration(fs, path, home, 'local'),
        );
        const before = changes.length;
        yield* observer.reconcileNow;
        expect(changes.slice(before).sort()).toEqual(['automatic-memory', 'home']);
        yield* observer.reconcileNow;
        expect(changes).toHaveLength(before + 2);
        yield* observer.release('tab');
        expect(yield* observer.diagnostics).toEqual({resources: 0, connections: 0, watches: 0});
        yield* observer.clockHints.register('automatic-memory', 'alpha', 1234);
        expect(yield* observer.diagnostics).toEqual({resources: 0, connections: 0, watches: 0});
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('registers the next rolling value-window boundary from already-loaded feedback', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-value-clock-'});
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        user: 'tester',
        manifestPath: path.join(home, 'manifest.yaml'),
      };
      const calls: Array<{topic: string; project: string; next?: number}> = [];
      const now = yield* Clock.currentTimeMillis;
      const timestamp = now - 30 * 86_400_000 + 1000;
      yield* fs.makeDirectory(path.join(home, 'feedback'));
      yield* fs.writeFileString(
        path.join(home, 'feedback', 'recall-events-v1.jsonl'),
        JSON.stringify({
          version: 1,
          action: 'useful',
          project: 'alpha',
          queryFingerprint: 'fixture',
          rankerVersion: 'fixture',
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(timestamp)),
          uri: 'threadnote://user/tester/memories/durable/projects/alpha/example.md',
        }) + '\n',
      );
      const report = yield* buildLocalValueReport(config, {project: 'alpha', period: 30}).pipe(
        Effect.provideService(ManagerConsumerClockHints, {
          register: (topic, project, next) =>
            Effect.sync(() => {
              calls.push({topic, project, next});
            }),
        }),
      );
      expect(report.feedback.useful).toBe(1);
      expect(calls).toEqual([{topic: 'home', project: 'alpha', next: now + 1001}]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
