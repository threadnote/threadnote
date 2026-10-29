import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, FileSystem, Layer, Path, Predicate, Schema, Scope, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ManagerLiveResource} from '@threadnote/manager/live/contracts';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {
  ManagerLiveConsumerChangeHints,
  makeManagerLiveConsumerObservation,
} from '../../src/manager/live_consumer_observation.js';
import {handleManagerWorksetRequest} from '../../src/manager/worksets.js';
import {makeManagerGraphLiveObservation} from '../../src/manager/live_graph_observation.js';
import {managerSourceFilesProbe} from '../../src/manager/live_source_observation.js';
import {modelSetupFileIdentity, sameModelSetupFile} from '@threadnote/inference/models/setup';
import {readBoundedProcessRegistrationNames} from '../../src/process/diagnostics.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';

const baseLayer = Layer.mergeAll(
  BunServices.layer,
  TestSystemInfoLayer,
  Layer.succeed(ChildEnvironmentPolicy, {
    preserveIntendedChild: environment => ({...environment}),
    sanitizeExternal: environment => ({...environment}),
  }),
);
const testLayer = Layer.mergeAll(baseLayer, CommandExecutor.layer.pipe(Layer.provide(baseLayer)));
const withLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(testLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));

const worksetJobId = (body: unknown): string | undefined => {
  if (!Predicate.isObject(body) || !Predicate.isObject(body.job)) return undefined;
  return typeof body.job.id === 'string' ? body.job.id : undefined;
};

const worksetJobs = (body: unknown): readonly unknown[] | undefined =>
  Predicate.isObject(body) && EffectArray.isArray(body.jobs) ? body.jobs : undefined;

describe('Manager consumer live observation', () => {
  effectIt.effect('observes atomic share changes, coalesces idle state, and releases watches', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-consumer-live-'});
      const directory = path.join(home, 'share');
      const teams = path.join(directory, 'teams.json');
      const pending = path.join(directory, 'auto-sync-pending-reindexes.json');
      yield* fs.makeDirectory(directory);
      yield* fs.writeFileString(teams, '{"teams":[]}');
      const changes: string[] = [];
      const availability: boolean[] = [];
      const unwatched: FileSystem.FileSystem = {...fs, watch: () => Stream.never};
      const broker = yield* makeManagerLiveConsumerObservation(runtimeConfigForTest({agentContextHome: home}), {
        onInvalidate: (_resource, revision) =>
          Effect.sync(() => {
            changes.push(revision);
          }),
        onAvailability: (_resource, available) =>
          Effect.sync(() => {
            availability.push(available);
          }),
      }).pipe(Effect.provideService(FileSystem.FileSystem, unwatched));
      const resource = {topic: 'share-conflicts' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('tab-a', [resource])).toEqual([]);
      expect(availability).toEqual([true]);
      const temporary = pending + '.tmp';
      yield* fs.writeFileString(temporary, '{"teams":{"one":[]}}');
      yield* fs.rename(temporary, pending);
      yield* broker.reconcileNow;
      expect(changes).toHaveLength(1);
      yield* broker.reconcileNow;
      expect(changes).toHaveLength(1);
      yield* TestClock.adjust('60 seconds');
      expect(changes).toHaveLength(1);
      yield* broker.release('tab-a');
      expect((yield* broker.diagnostics).resources).toBe(0);
      expect((yield* broker.diagnostics).watches).toBe(0);
    }).pipe(withLayer),
  );

  effectIt.effect('marks a non-file team configuration unavailable and recovers', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-consumer-availability-'});
      const directory = path.join(home, 'share');
      yield* fs.makeDirectory(directory);
      const teams = path.join(directory, 'teams.json');
      yield* fs.makeDirectory(teams);
      const seen: boolean[] = [];
      const broker = yield* makeManagerLiveConsumerObservation(runtimeConfigForTest({agentContextHome: home}), {
        onInvalidate: () => Effect.void,
        onAvailability: (_resource, available) =>
          Effect.sync(() => {
            seen.push(available);
          }),
      });
      const resource = {topic: 'share-conflicts' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('tab-a', [resource])).toEqual([resource]);
      yield* fs.remove(teams, {recursive: true});
      yield* fs.writeFileString(teams, '{}');
      yield* broker.reconcileNow;
      expect(seen).toEqual([true]);
      yield* fs.remove(teams);
      yield* fs.makeDirectory(teams);
      yield* broker.reconcileNow;
      expect(seen).toEqual([true, false]);
    }).pipe(withLayer),
  );

  effectIt.effect('caps process registration enumeration before reading an unbounded list', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-process-cap-'});
      for (let index = 1; index <= 260; index++) yield* fs.writeFileString(home + '/' + String(index) + '.json', '{}');
      const result = yield* readBoundedProcessRegistrationNames(home);
      expect(result.names).toHaveLength(256);
      expect(result.truncated).toBe(true);
    }).pipe(withLayer),
  );

  effectIt.effect('marks over-budget process observation unavailable and recovers after pruning', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-process-recovery-'});
      const directory = path.join(home, 'runtime', 'processes');
      yield* fs.makeDirectory(directory, {recursive: true});
      for (let index = 1; index <= 257; index++)
        yield* fs.writeFileString(path.join(directory, String(index) + '.json'), '{}');
      const seen: boolean[] = [];
      const broker = yield* makeManagerLiveConsumerObservation(runtimeConfigForTest({agentContextHome: home}), {
        onInvalidate: () => Effect.void,
        onAvailability: (_resource, available) =>
          Effect.sync(() => {
            seen.push(available);
          }),
      });
      const resource = {topic: 'processes' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('tab-a', [resource])).toEqual([resource]);
      yield* fs.remove(path.join(directory, '257.json'));
      yield* broker.reconcileNow;
      expect(seen).toContain(true);
    }).pipe(withLayer),
  );

  effectIt.effect('samples a registered process exit only while subscribed', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-process-live-'});
      const directory = path.join(home, 'runtime', 'processes');
      yield* fs.makeDirectory(directory, {recursive: true});
      const processId = 1_234_601;
      const startedAt = '2026-08-12T00:00:00.000Z';
      yield* fs.writeFileString(
        path.join(directory, String(processId) + '.json'),
        JSON.stringify({
          baseRole: 'mcp',
          currentOperation: 'mcp-server',
          parentProcessId: 42,
          processId,
          processStartIdentity: 'identity-a',
          role: 'mcp',
          schemaVersion: 1,
          startedAt,
          token: 'private-registration-token',
          updatedAt: startedAt,
        }),
      );
      let alive = true;
      const system = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId && alive,
        processStartIdentity: () => Effect.succeed('identity-a'),
      });
      const revisions: string[] = [];
      const broker = yield* makeManagerLiveConsumerObservation(runtimeConfigForTest({agentContextHome: home}), {
        onInvalidate: (_resource, revision) =>
          Effect.sync(() => {
            revisions.push(revision);
          }),
        onAvailability: () => Effect.void,
      }).pipe(Effect.provideService(SystemInfo, system));
      const resource = {topic: 'processes' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('tab-a', [resource])).toEqual([]);
      expect((yield* broker.processSnapshot)?.processes).toEqual([expect.objectContaining({processId})]);
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(0);
      alive = false;
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(1);
      expect((yield* broker.processSnapshot)?.processes).toEqual([]);
      yield* broker.release('tab-a');
      expect((yield* broker.diagnostics).resources).toBe(0);
    }).pipe(withLayer),
  );

  effectIt.effect('retains one process sampler for graph-only subscription and releases it', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-graph-process-live-'});
      const directory = path.join(home, 'runtime', 'processes');
      yield* fs.makeDirectory(directory, {recursive: true});
      const processId = 1_234_602;
      const startedAt = '2026-08-12T00:00:00.000Z';
      yield* fs.writeFileString(
        path.join(directory, String(processId) + '.json'),
        JSON.stringify({
          baseRole: 'mcp',
          currentOperation: 'mcp-server',
          parentProcessId: 42,
          processId,
          processStartIdentity: 'identity-b',
          role: 'mcp',
          schemaVersion: 1,
          startedAt,
          token: 'private-registration-token',
          updatedAt: startedAt,
        }),
      );
      let alive = true;
      const system = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId && alive,
        processStartIdentity: () => Effect.succeed('identity-b'),
      });
      let graphChanges = 0;
      const broker = yield* makeManagerLiveConsumerObservation(
        runtimeConfigForTest({agentContextHome: home}),
        {onInvalidate: () => Effect.void, onAvailability: () => Effect.void},
        {
          adapters: [
            {
              topics: ['graph-status'],
              subscribe: () => Effect.succeed([]),
              release: () => Effect.void,
              processChanged: Effect.sync(() => {
                graphChanges++;
              }),
            },
          ],
        },
      ).pipe(Effect.provideService(SystemInfo, system));
      const resource = {topic: 'graph-status' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('graph-tab', [resource])).toEqual([]);
      expect((yield* broker.diagnostics).resources).toBe(1);
      yield* broker.reconcileNow;
      expect(graphChanges).toBe(0);
      alive = false;
      yield* broker.reconcileNow;
      expect(graphChanges).toBe(1);
      yield* broker.release('graph-tab');
      expect((yield* broker.diagnostics).resources).toBe(0);
      expect((yield* broker.diagnostics).watches).toBe(0);
    }).pipe(withLayer),
  );

  effectIt.effect('gates graph-only availability on process coverage and invalidates on recovery', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-graph-process-recovery-'});
      const isolatedSystem = SystemInfo.of({
        ...system,
        environment: () => ({...system.environment(), THREADNOTE_INSTALL_ROOT: home}),
      });
      const directory = path.join(home, 'runtime', 'processes');
      yield* fs.makeDirectory(directory, {recursive: true});
      for (let index = 1; index <= 257; index++) yield* fs.makeDirectory(path.join(directory, `extra-${index}`));
      const graphResource = {topic: 'graph-status' as const, scope: 'account' as const};
      const availability: boolean[] = [];
      const revisions: string[] = [];
      const callbacks = {
        onInvalidate: (resource: ManagerLiveResource, revision: string) =>
          Effect.sync(() => {
            if (resource.topic === 'graph-status') revisions.push(revision);
          }),
        onAvailability: (resource: ManagerLiveResource, available: boolean) =>
          Effect.sync(() => {
            if (resource.topic === 'graph-status') availability.push(available);
          }),
      };
      const config = runtimeConfigForTest({agentContextHome: home});
      const graph = yield* makeManagerGraphLiveObservation(config, callbacks).pipe(
        Effect.provideService(SystemInfo, isolatedSystem),
      );
      const broker = yield* makeManagerLiveConsumerObservation(config, callbacks, {adapters: [graph]}).pipe(
        Effect.provideService(SystemInfo, isolatedSystem),
      );
      expect(yield* broker.subscribe('graph-tab', [graphResource])).toContainEqual(graphResource);
      expect(availability).not.toContain(true);
      yield* fs.remove(path.join(directory, 'extra-257'), {recursive: true});
      yield* broker.reconcileNow;
      expect(availability).toContain(true);
      expect(revisions.length).toBeGreaterThan(0);
      const stable = revisions.length;
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(stable);
      yield* fs.makeDirectory(path.join(directory, 'extra-257'));
      expect((yield* readBoundedProcessRegistrationNames(directory)).truncated).toBe(true);
      yield* broker.reconcileNow;
      expect(availability.at(-1)).toBe(false);
      expect(yield* broker.subscribe('graph-tab-two', [graphResource])).toContainEqual(graphResource);
    }).pipe(withLayer),
  );

  effectIt.effect('keeps supported sources stable when aggregate watch demand exceeds the limit', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-watch-budget-'});
      const share = path.join(home, 'share');
      const models = path.join(home, 'models');
      yield* fs.makeDirectory(share);
      yield* fs.makeDirectory(models);
      yield* fs.writeFileString(path.join(share, 'teams.json'), '{}');
      const seen: Array<{topic: string; available: boolean}> = [];
      const broker = yield* makeManagerLiveConsumerObservation(
        runtimeConfigForTest({agentContextHome: home}),
        {
          onInvalidate: () => Effect.void,
          onAvailability: (resource, available) =>
            Effect.sync(() => {
              seen.push({topic: resource.topic, available});
            }),
        },
        {
          modelPaths: [
            path.join(models, 'setup.json'),
            path.join(models, 'selection.json'),
            path.join(models, 'model.gguf'),
          ],
          watchLimit: 2,
        },
      );
      const shareResource = {topic: 'share-conflicts' as const, scope: 'account' as const};
      const modelResource = {topic: 'model-setup' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('share-tab', [shareResource])).toEqual([]);
      expect(yield* broker.subscribe('model-tab', [modelResource])).toEqual([modelResource]);
      expect(seen).toEqual([{topic: 'share-conflicts', available: true}]);
      for (let attempt = 0; attempt < 3; attempt++) yield* broker.reconcileNow;
      expect(seen).toEqual([{topic: 'share-conflicts', available: true}]);
      yield* broker.release('share-tab');
      yield* broker.reconcileNow;
      expect(seen).toContainEqual({topic: 'model-setup', available: true});
    }).pipe(withLayer),
  );

  effectIt.effect('admits replacement and waiting citation resources as capacity is released', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-resource-capacity-'});
      const available: string[] = [];
      const broker = yield* makeManagerLiveConsumerObservation(runtimeConfigForTest({agentContextHome: home}), {
        onInvalidate: () => Effect.void,
        onAvailability: resource =>
          Effect.sync(() => {
            if ('project' in resource) available.push(resource.project);
          }),
      });
      const old = Array.from({length: 32}, (_, index) => ({
        topic: 'citation-repair-jobs' as const,
        project: `old-${index}`,
      }));
      const replacement = {topic: 'citation-repair-jobs' as const, project: 'replacement'};
      const waiting = {topic: 'citation-repair-jobs' as const, project: 'waiting'};
      expect(yield* broker.subscribe('first', old)).toEqual([]);
      expect((yield* broker.diagnostics).resources).toBe(32);
      expect(yield* broker.subscribe('first', [replacement])).toEqual([]);
      expect((yield* broker.diagnostics).resources).toBe(1);
      expect(available).toContain('replacement');
      expect(yield* broker.subscribe('first', old)).toEqual([]);
      expect(yield* broker.subscribe('second', [waiting])).toEqual([waiting]);
      expect(available).not.toContain('waiting');
      yield* broker.release('first');
      expect(available).toContain('waiting');
      expect((yield* broker.diagnostics).resources).toBe(1);
      yield* broker.reconcileNow;
      expect(yield* broker.subscribe('second', [waiting])).toEqual([]);
    }).pipe(withLayer),
  );

  effectIt.effect('admits a hidden graph process dependency after citation capacity frees', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-hidden-process-capacity-'});
      const graphResource = {topic: 'graph-status' as const, scope: 'account' as const};
      const availability: boolean[] = [];
      const callbacks = {
        onInvalidate: () => Effect.void,
        onAvailability: (resource: ManagerLiveResource, available: boolean) =>
          Effect.sync(() => {
            if (resource.topic === 'graph-status') availability.push(available);
          }),
      };
      const config = runtimeConfigForTest({agentContextHome: home});
      const graph = yield* makeManagerGraphLiveObservation(config, callbacks);
      const broker = yield* makeManagerLiveConsumerObservation(config, callbacks, {adapters: [graph]});
      const occupied = Array.from({length: 32}, (_, index) => ({
        topic: 'citation-repair-jobs' as const,
        project: `occupied-${index}`,
      }));
      expect(yield* broker.subscribe('first', occupied)).toEqual([]);
      expect(yield* broker.subscribe('graph', [graphResource])).toContainEqual(graphResource);
      expect(availability).not.toContain(true);
      yield* broker.release('first');
      expect(availability).toContain(true);
      expect((yield* broker.diagnostics).resources).toBe(1);
      expect(yield* broker.subscribe('graph', [graphResource])).toEqual([]);
    }).pipe(withLayer),
  );

  effectIt.effect('tracks selected model artifact and runtime pointer metadata without reading payloads', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-model-runtime-live-'});
      const models = path.join(home, 'models');
      yield* fs.makeDirectory(models);
      const setup = path.join(models, 'setup.json');
      const selection = path.join(models, 'selection.json');
      const artifact = path.join(models, 'model.gguf');
      const automatic = path.join(home, 'auto-update.json');
      const active = path.join(home, 'active-release.json');
      const changes: string[] = [];
      const unwatched: FileSystem.FileSystem = {...fs, watch: () => Stream.never};
      const broker = yield* makeManagerLiveConsumerObservation(
        runtimeConfigForTest({agentContextHome: home}),
        {
          onInvalidate: resource =>
            Effect.sync(() => {
              changes.push(resource.topic);
            }),
          onAvailability: () => Effect.void,
        },
        {modelPaths: [setup, selection, artifact], runtimePaths: [automatic, active]},
      ).pipe(Effect.provideService(FileSystem.FileSystem, unwatched));
      const model = {topic: 'model-setup' as const, scope: 'account' as const};
      const runtime = {topic: 'runtime-updates' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('tab-a', [model, runtime])).toEqual([]);
      yield* fs.writeFileString(setup, '{}');
      yield* fs.writeFileString(artifact, 'model-bytes');
      yield* fs.writeFileString(active, '{}');
      yield* broker.reconcileNow;
      expect(changes).toContain('model-setup');
      expect(changes).toContain('runtime-updates');
      const idleCount = changes.length;
      yield* broker.reconcileNow;
      expect(changes).toHaveLength(idleCount);
      yield* broker.release('tab-a');
      expect((yield* broker.diagnostics).resources).toBe(0);
    }).pipe(withLayer),
  );

  effectIt.effect('tracks ctime-only model artifact changes in setup and generation source probes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-model-native-identity-'});
      const models = path.join(home, 'models');
      yield* fs.makeDirectory(models);
      const artifact = path.join(models, 'model.gguf');
      yield* fs.writeFileString(artifact, 'tiny', {mode: 0o600});
      const before = yield* modelSetupFileIdentity(artifact);
      expect(before).toBeDefined();
      const priorGeneration = yield* managerSourceFilesProbe([artifact], [], [artifact]);
      const revisions: string[] = [];
      const broker = yield* makeManagerLiveConsumerObservation(
        runtimeConfigForTest({agentContextHome: home}),
        {
          onInvalidate: (_resource, revision) =>
            Effect.sync(() => {
              revisions.push(revision);
            }),
          onAvailability: () => Effect.void,
        },
        {modelPaths: [path.join(models, 'setup.json'), path.join(models, 'selection.json'), artifact]},
      );
      const resource = {topic: 'model-setup' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('model-tab', [resource])).toEqual([]);
      yield* Effect.addFinalizer(() => fs.chmod(artifact, 0o600).pipe(Effect.orDie));
      yield* fs.chmod(artifact, 0o444);
      const after = yield* modelSetupFileIdentity(artifact);
      expect(after).toBeDefined();
      expect(after?.modifiedAtNs).toBe(before?.modifiedAtNs);
      expect(sameModelSetupFile(before!, after!)).toBe(false);
      expect((yield* managerSourceFilesProbe([artifact], [], [artifact])).revision).not.toBe(priorGeneration.revision);
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(1);
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(1);
    }).pipe(withLayer),
  );

  effectIt.effect('observes an empty workset catalog and an external manifest replacement', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-workset-live-'});
      const manifestPath = path.join(home, 'manifest.yaml');
      yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
      const revisions: string[] = [];
      const unwatched: FileSystem.FileSystem = {...fs, watch: () => Stream.never};
      const broker = yield* makeManagerLiveConsumerObservation(
        runtimeConfigForTest({agentContextHome: home, manifestPath}),
        {
          onInvalidate: (_resource, revision) =>
            Effect.sync(() => {
              revisions.push(revision);
            }),
          onAvailability: () => Effect.void,
        },
      ).pipe(Effect.provideService(FileSystem.FileSystem, unwatched));
      const resource = {topic: 'worksets' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('tab-a', [resource])).toEqual([]);
      const temporary = manifestPath + '.tmp';
      yield* fs.writeFileString(temporary, 'version: 1\nprojects: []\nworksets: []\n');
      yield* fs.rename(temporary, manifestPath);
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(1);
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(1);
    }).pipe(withLayer),
  );

  effectIt.effect('observes an external worktree edit used by workset status', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-workset-dirty-'});
      const repository = path.join(home, 'repository');
      yield* fs.makeDirectory(repository);
      yield* runCommandEffect('git', ['init', '-q', repository]);
      yield* fs.writeFileString(path.join(repository, 'README.md'), 'initial\n');
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
      const manifestPath = path.join(home, 'manifest.yaml');
      yield* fs.writeFileString(
        manifestPath,
        EffectArray.join(
          [
            'version: 1',
            'projects:',
            '  - name: sample',
            '    path: ' + repository,
            '    uri: threadnote://resources/repos/sample',
            '    seed: []',
            'worksets:',
            '  - name: all',
            '    projects: [sample]',
            '',
          ],
          '\n',
        ),
      );
      const revisions: string[] = [];
      const unwatched: FileSystem.FileSystem = {...fs, watch: () => Stream.never};
      const broker = yield* makeManagerLiveConsumerObservation(
        runtimeConfigForTest({agentContextHome: home, manifestPath}),
        {
          onInvalidate: (_resource, revision) =>
            Effect.sync(() => {
              revisions.push(revision);
            }),
          onAvailability: () => Effect.void,
        },
      ).pipe(Effect.provideService(FileSystem.FileSystem, unwatched));
      const resource = {topic: 'worksets' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('tab-a', [resource])).toEqual([]);
      yield* fs.writeFileString(path.join(repository, 'README.md'), 'changed\n');
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(1);
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(1);
    }).pipe(withLayer),
  );

  effectIt.effect('publishes workset start, progress, and terminal registry changes after mutation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'manager-workset-hooks-'});
      const home = path.join(root, 'home');
      const manifestPath = path.join(root, 'manifest.yaml');
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(
        manifestPath,
        EffectArray.join(
          [
            'version: 1',
            'projects:',
            '  - name: sample',
            '    path: ' + root,
            '    uri: threadnote://resources/repos/sample',
            '    seed: []',
            'worksets:',
            '  - name: all',
            '    projects: [sample]',
            '',
          ],
          '\n',
        ),
      );
      const config = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'test',
      } satisfies RuntimeConfig;
      const jobScope = yield* Scope.make();
      const contextKey = {};
      const progressReached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let mode: 'success' | 'failure' | 'block' = 'success';
      const changes: string[] = [];
      const hints = ManagerLiveConsumerChangeHints.of({
        publish: resource =>
          Effect.sync(() => {
            changes.push(resource.topic);
          }),
      });
      const request = (method: 'GET' | 'POST', endpoint: string, body: Record<string, unknown>) =>
        handleManagerWorksetRequest({
          body: Effect.succeed(body),
          config,
          contextKey,
          jobScope,
          method,
          prepareWorkset: (_config, workset, options) =>
            (
              options.onProgress?.({
                activity: {completed: 1, phase: 'scanning', total: 2, unit: 'files'},
                attempt: 1,
                completed: 0,
                elapsedMilliseconds: 1,
                maxAttempts: 2,
                message: 'Scanning',
                phase: 'indexing',
                project: 'sample',
                total: 1,
                type: 'code-graph-workset-progress',
                version: 1,
                workset,
              }) ?? Effect.void
            ).pipe(
              Effect.andThen(Deferred.succeed(progressReached, undefined)),
              Effect.andThen(
                Effect.suspend(() =>
                  mode === 'failure'
                    ? Effect.fail(TestError.make({message: 'simulated prepare failure'}))
                    : mode === 'block'
                      ? Effect.never
                      : Deferred.await(release),
                ),
              ),
              Effect.as({
                coverage: {complete: true, excluded: 0, failed: 0, missing: 0, ready: 1, requested: 1},
                manifestDigest: Effect2.pipe('d', EffectString.repeat(64)),
                members: [],
                state: 'ready' as const,
                type: 'code-graph-workset-prepare' as const,
                version: 1 as const,
                workset,
              }),
            ),
          url: new URL('http://127.0.0.1' + endpoint),
        }).pipe(Effect.provideService(ManagerLiveConsumerChangeHints, hints));
      const start = yield* request('POST', '/api/worksets/prepare', {workset: 'all'});
      if (!start) return yield* TestError.make({message: 'prepare route not handled'});
      expect(start?.status).toBe(202);
      expect(changes).toEqual(['worksets']);
      yield* Deferred.await(progressReached);
      expect(changes).toEqual(['worksets', 'worksets']);
      const id = worksetJobId(start.body);
      if (id === undefined) return yield* TestError.make({message: 'prepare job response has no id'});
      const running = yield* request('GET', `/api/worksets/jobs/${id}`, {});
      expect(running).toMatchObject({body: {job: {status: 'running', progress: {phase: 'indexing'}}}});
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow;
      const completed = yield* request('GET', `/api/worksets/jobs/${id}`, {});
      expect(completed).toMatchObject({body: {job: {status: 'completed'}}});
      expect(changes).toEqual(['worksets', 'worksets', 'worksets']);
      mode = 'failure';
      const failedStart = yield* request('POST', '/api/worksets/prepare', {workset: 'all'});
      if (!failedStart) return yield* TestError.make({message: 'failed prepare route not handled'});
      const failedId = worksetJobId(failedStart.body);
      if (failedId === undefined) return yield* TestError.make({message: 'failed prepare job response has no id'});
      yield* Effect.yieldNow;
      expect(yield* request('GET', `/api/worksets/jobs/${failedId}`, {})).toMatchObject({
        body: {job: {status: 'failed'}},
      });
      expect(changes.slice(-3)).toEqual(['worksets', 'worksets', 'worksets']);
      mode = 'block';
      const cancelledStart = yield* request('POST', '/api/worksets/prepare', {workset: 'all'});
      if (!cancelledStart) return yield* TestError.make({message: 'cancel prepare route not handled'});
      const cancelledId = worksetJobId(cancelledStart.body);
      if (cancelledId === undefined)
        return yield* TestError.make({message: 'cancelled prepare job response has no id'});
      yield* Effect.yieldNow;
      expect((yield* request('POST', '/api/worksets/jobs/cancel', {id: cancelledId}))?.status).toBe(202);
      yield* Effect.yieldNow;
      expect(yield* request('GET', `/api/worksets/jobs/${cancelledId}`, {})).toMatchObject({
        body: {job: {status: 'cancelled'}},
      });
      expect(changes.slice(-4)).toEqual(['worksets', 'worksets', 'worksets', 'worksets']);
      mode = 'success';
      for (let index = 0; index < 33; index++) {
        const next = yield* request('POST', '/api/worksets/prepare', {workset: 'all'});
        if (!next) return yield* TestError.make({message: 'trim prepare route not handled'});
        const nextId = worksetJobId(next.body);
        if (nextId === undefined) return yield* TestError.make({message: 'trimmed prepare job response has no id'});
        yield* Effect.yieldNow;
        expect(yield* request('GET', `/api/worksets/jobs/${nextId}`, {})).toMatchObject({
          body: {job: {status: 'completed'}},
        });
      }
      const listed = yield* request('GET', '/api/worksets/jobs', {});
      if (!listed) return yield* TestError.make({message: 'job list route not handled'});
      const jobs = worksetJobs(listed.body);
      if (jobs === undefined) return yield* TestError.make({message: 'job list response has no jobs'});
      expect(jobs).toHaveLength(32);
      yield* Scope.close(jobScope, Exit.void);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'publishes only to the subscribed citation project',
    {unrelated: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 100}))},
    ({unrelated}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-citation-live-'});
        const changes: string[] = [];
        const broker = yield* makeManagerLiveConsumerObservation(runtimeConfigForTest({agentContextHome: home}), {
          onInvalidate: (resource, revision) =>
            Effect.sync(() => {
              if ('project' in resource) changes.push(resource.project + ':' + revision);
            }),
          onAvailability: () => Effect.void,
        });
        const subscribed = {topic: 'citation-repair-jobs' as const, project: 'selected'};
        yield* broker.subscribe('tab-a', [subscribed]);
        for (let index = 0; index < unrelated; index++)
          yield* broker.hints.publish({topic: 'citation-repair-jobs', project: 'other'});
        yield* broker.hints.publish(subscribed);
        expect(changes).toEqual(['selected:1']);
      }).pipe(withLayer),
    {arbitrary: {runs: 24}},
  );
});

effectIt.effect('observes empty share configuration and later external creation without fallback polling', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-empty-share-'});
    const revisions: string[] = [];
    const broker = yield* makeManagerLiveConsumerObservation(runtimeConfigForTest({agentContextHome: home}), {
      onInvalidate: (_resource, revision) =>
        Effect.sync(() => {
          revisions.push(revision);
        }),
      onAvailability: () => Effect.void,
    }).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
    expect(yield* broker.subscribe('tab', [{topic: 'share-conflicts', scope: 'account'}])).toEqual([]);
    yield* broker.reconcileNow;
    expect(revisions).toHaveLength(0);
    const directory = path.join(home, 'share');
    const file = path.join(directory, 'teams.json');
    yield* fs.makeDirectory(directory);
    yield* fs.writeFileString(file, JSON.stringify({version: 1, teams: {}}));
    yield* broker.reconcileNow;
    expect(revisions).toHaveLength(1);
    yield* fs.remove(file);
    yield* broker.reconcileNow;
    expect(revisions).toHaveLength(2);
    yield* broker.reconcileNow;
    expect(revisions).toHaveLength(2);
  }).pipe(withLayer),
);
