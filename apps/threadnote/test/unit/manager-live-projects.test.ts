import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Deferred, Effect, FileSystem, Path, Schema, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, vi} from 'vitest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runCommandEffect} from '@threadnote/platform/command';
import {resourceAccountMutationLockPath, resourceAccountMutationLockPolicy} from '@threadnote/store/resource/lock';
import {advanceCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as healthSources from '../../src/manager/live_health_sources.js';
import {makeManagerProjectLiveObservation} from '../../src/manager/live_project_observation.js';
import {draftQueueObservationDirectory} from '../../src/memory/context/maintenance_draft_queue.js';
import {automaticPreparationObservationDirectory} from '../../src/memory/context/maintenance_preparation_state.js';
import {selectedGenerationObservationPaths} from '../../src/models/setup.js';
import {buildLocalValueReport} from '../../src/value_report/commands.js';
import {ManagerConsumerClockHints} from '../../src/manager/live_consumer_sources.js';
import {ManagerHealthObservationHints} from '../../src/manager/live_health_sources.js';
import {handleManagerHomeRequest} from '../../src/manager/home.js';
import {makeManagerGraphLiveObservation} from '../../src/manager/live_graph_observation.js';

const registrationFixture = Effect.fn('managerProjectRegistration.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-project-registration-'});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: `${home}/manifest.yaml`,
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  let available = yield* Deferred.make<void>();
  let underlyingReady = false;
  let unavailableEvents = 0;
  let latest: healthSources.ManagerHealthObservation | undefined;
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      vi.spyOn(healthSources, 'makeManagerHealthLiveSources').mockImplementation((_config, callbacks) =>
        healthSources.makeManagerHealthLiveRegistry({
          observe: (_project, input) =>
            Effect.sync(() => {
              latest = input;
              return {revision: 'unchanged-source', directories: []};
            }),
          onInvalidate: callbacks.onInvalidate,
          onAvailability: (project, ready) =>
            callbacks.onAvailability(project, ready).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  underlyingReady = ready;
                  if (ready) yield* Deferred.succeed(available, undefined);
                  else unavailableEvents++;
                }),
              ),
            ),
        }),
      ),
    ),
    spy => Effect.sync(() => spy.mockRestore()),
  );
  const observer = yield* makeManagerProjectLiveObservation(config, {
    onInvalidate: () => Effect.void,
    onAvailability: () => Effect.void,
  }).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
  const subscribe = () => observer.subscribe('review-registration', [{topic: 'home', scope: 'account'}]);
  yield* subscribe();
  const register = (citations: healthSources.ManagerHealthObservation['citations'], forceAwait = false) =>
    Effect.gen(function* () {
      available = yield* Deferred.make<void>();
      yield* observer.healthHints.register('alpha', {cwd: home, citations});
      if (forceAwait || !underlyingReady) yield* Deferred.await(available);
    });
  return {observer, subscribe, register, latest: () => latest, unavailableEvents: () => unavailableEvents};
});

describe('Manager project live integration', () => {
  effectIt.effect('refuses selector overflow without trimming coverage and clears retained selectors on release', () =>
    Effect.gen(function* () {
      const f = yield* registrationFixture();
      const selector = (index: number) => ({
        repositoryId: 'a'.repeat(64),
        sourceCommit: index.toString(16).padStart(40, '0'),
      });
      yield* f.register(Array.from({length: 32}, (_, index) => selector(index)));
      expect(f.latest()?.citations).toHaveLength(32);
      expect(f.observer.reviewReadiness('alpha')).toBe(true);
      for (let index = 32; index < 40; index++) yield* f.register([selector(index)]);
      // One real excess selector is a bounded refusal frame; the existing observer cannot admit >32 sources.
      expect(f.latest()?.citations).toHaveLength(33);
      expect(f.observer.reviewReadiness('alpha')).toBe(false);
      yield* f.observer.release('review-registration');
      expect(f.observer.reviewReadiness('alpha')).toBeUndefined();
      yield* f.subscribe();
      yield* f.register([selector(0)], true);
      expect(f.latest()?.citations).toEqual([selector(0)]);
      expect(f.observer.reviewReadiness('alpha')).toBe(true);
      yield* f.observer.release('review-registration');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'retains a deterministic normalized selector union without mutation or replay invalidation',
    {
      entries: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 7}))).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(12),
      ),
    },
    ({entries}) =>
      Effect.gen(function* () {
        const f = yield* registrationFixture();
        const inputs = entries.map((entry, index) => ({
          repositoryId: 'a'.repeat(64),
          sourceCommit: entry.toString(16).padStart(40, '0'),
          path: `irrelevant-${index}.ts`,
          sourceSnapshotId: `snapshot-${index}`,
        }));
        const before = JSON.stringify(inputs);
        for (const input of inputs) yield* f.register([input]);
        const settledUnavailable = f.unavailableEvents();
        for (const input of [...inputs].reverse()) yield* f.register([input]);
        const expected = [...new Set(entries)]
          .sort((a, b) => a - b)
          .map(entry => ({repositoryId: 'a'.repeat(64), sourceCommit: entry.toString(16).padStart(40, '0')}));
        expect(f.latest()?.citations).toEqual(expected);
        expect(f.unavailableEvents()).toBe(settledUnavailable);
        expect(JSON.stringify(inputs)).toBe(before);
        yield* f.observer.release('review-registration');
      }).pipe(provideTestLayer(ApplicationLayer)),
    {arbitrary: {runs: 30}},
  );

  effectIt.effect('observes job-declared source projects for All reviews and releases them with the account view', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-account-review-source-'});
      const root = `${home}/repository`;
      yield* fs.makeDirectory(root);
      yield* runCommandEffect('git', ['init', '--quiet', root]);
      yield* fs.writeFileString(`${root}/source.ts`, 'export const value = 1;\n');
      yield* runCommandEffect('git', ['-C', root, 'add', '.']);
      yield* runCommandEffect('git', [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ]);
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        user: 'tester',
        manifestPath: `${home}/manifest.yaml`,
      };
      yield* fs.writeFileString(
        config.manifestPath,
        `version: 1\nprojects:\n  - name: alpha\n    path: ${root}\n    uri: threadnote://resources/repos/alpha\n    seed: []\n`,
      );
      const changed = yield* Deferred.make<void>();
      const observer = yield* makeManagerProjectLiveObservation(config, {
        onInvalidate: resource =>
          resource.topic === 'home' && 'scope' in resource
            ? Deferred.succeed(changed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        onAvailability: () => Effect.void,
      });
      expect(observer.reviewReadiness('alpha')).toBeUndefined();
      expect(yield* observer.subscribe('all-reviews', [{topic: 'home', scope: 'account'}])).toEqual([]);
      yield* observer.healthHints.register('alpha', {cwd: root, citations: []});
      yield* Deferred.await(changed).pipe(Effect.timeout('5 seconds'));
      expect(observer.reviewReadiness('alpha')).toBe(true);
      yield* observer.release('all-reviews');
      expect(observer.reviewReadiness('alpha')).toBeUndefined();
      expect(yield* observer.diagnostics).toEqual({resources: 0, connections: 0, watches: 0});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('wakes account Reviews at the earliest contributed finite retry boundary', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-review-clock-'});
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        user: 'tester',
        manifestPath: `${home}/manifest.yaml`,
      };
      yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      const changes: string[] = [];
      const observer = yield* makeManagerProjectLiveObservation(config, {
        onInvalidate: resource =>
          Effect.sync(() => {
            changes.push(resource.topic);
          }),
        onAvailability: () => Effect.void,
      }).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
      const resource = {topic: 'home', scope: 'account'} as const;
      expect(yield* observer.subscribe('reviews', [resource])).toEqual([]);
      const now = yield* Clock.currentTimeMillis;
      yield* observer.clockHints.register('home', '', now + 1_000);
      yield* observer.clockHints.register('home', '', now + 60_000);
      yield* observer.reconcileNow;
      changes.length = 0;
      yield* TestClock.adjust(1_100);
      yield* observer.reconcileNow;
      expect(changes).toContain('home');
      yield* observer.release('reviews');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

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
