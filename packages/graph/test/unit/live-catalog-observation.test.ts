import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {describe, expect} from 'vitest';
import {codeGraphLiveObservationPaths} from '../../src/live_catalog_observation.js';
import {CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS, type CodeGraphBuildStatus} from '../../src/build_status.js';
import {readCodeGraphLocalAssociation} from '../../src/local_provenance.js';
import {observeManagerGraphCatalogStatus} from '../../src/manager/catalog_revision.js';
import {CodeGraphStore} from '../../src/store.js';
import type {CodeGraphStoreShape} from '../../src/store/shape.js';
import {CODE_GRAPH_SCHEMA_VERSION} from '../../src/types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const TestLayer = Layer.mergeAll(
  BunServices.layer,
  Layer.succeed(
    SystemInfo,
    SystemInfo.of({
      architecture: 'x64',
      availableDiskBytes: () => Effect.die('unexpected disk capacity query'),
      currentDirectory: () => process.cwd(),
      environment: () => process.env,
      developmentEntrypoint: '/test/threadnote.ts',
      intendedChildEnvironment: environment => environment,
      executablePath: process.execPath,
      homeDirectory: '/unused',
      hardwareInfo: Effect.succeed({
        cpuModel: 'test',
        memoryBytes: 1,
        effectiveMemoryBytes: 1,
        operatingSystem: 'test',
      }),
      isProcessRunning: () => false,
      memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
      processStartIdentity: () => Effect.as(Effect.void, undefined),
      runtimeVersion: Bun.version,
      pathDelimiter: process.platform === 'win32' ? ';' : ':',
      platform: process.platform,
      processId: process.pid,
      processArguments: process.argv,
      readLine: () => () => undefined,
      signalProcess: () => undefined,
      setExitCode: () => undefined,
      setEnvironmentVariable: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      tempDirectory: '/tmp',
      userName: 'test',
    }),
  ),
  Layer.succeed(
    CommandExecutor,
    CommandExecutor.of({
      execute: () => Effect.die('live observation must not execute Git'),
      executeStreaming: () => Effect.die('live observation must not execute Git'),
    }),
  ),
);

function liveCatalogStore(adapter: Pick<CodeGraphStoreShape, 'loadActiveViewIdentities'>): CodeGraphStoreShape {
  // @ts-expect-error -- The catalog projection uses only loadActiveViewIdentities from this store test double.
  return adapter;
}

describe('graph live source inventory', () => {
  effectIt.layer(TestLayer)(it => {
    it.effect(
      'covers removed idle worktrees independently of local compaction and matches the catalog projection',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs
            .makeTempDirectoryScoped({prefix: 'graph-live-provenance-'})
            .pipe(Effect.flatMap(fs.realPath));
          const checkoutId = Effect2.pipe('a', EffectString.repeat(64)),
            worktreeId = Effect2.pipe('b', EffectString.repeat(64)),
            repositoryId = Effect2.pipe('c', EffectString.repeat(64));
          const repository = path.join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
          const context = path.join(repository, 'local-context');
          const directory = path.join(context, 'worktrees');
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          yield* fs.chmod(context, 0o700);
          const worktree = path.join(home, 'remembered-worktree');
          yield* fs.makeDirectory(worktree);
          const file = path.join(directory, `${worktreeId}.json`);
          const content = JSON.stringify({
            schemaVersion: 2,
            checkoutId,
            worktreeId,
            repositoryId,
            canonicalWorktreePath: worktree,
            observedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
            registration: {kind: 'main'},
          });
          yield* fs.writeFileString(file, content, {mode: 0o600});
          yield* fs.writeFileString(
            path.join(repository, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`),
            'no database reads in live observer',
          );
          const projection = observeManagerGraphCatalogStatus(home).pipe(
            Effect.provideService(
              CodeGraphStore,
              liveCatalogStore({
                loadActiveViewIdentities: () => Effect.succeed([{repositoryId, worktreeId, snapshotId: 'fixture'}]),
              }),
            ),
          );
          const before = yield* codeGraphLiveObservationPaths(home);
          expect(before.files).toContain(file);
          expect(before.directories).toContain(worktree);
          expect(before.directories).toContain(path.dirname(worktree));
          expect(yield* projection).toMatchObject({repositoryCount: 1, lifecyclePending: false});
          expect((yield* readCodeGraphLocalAssociation(home, {checkoutId, worktreeId})).state).toBe('verified');
          yield* fs.remove(worktree, {recursive: true});
          const removed = yield* codeGraphLiveObservationPaths(home);
          expect(removed.statusRevision).not.toBe(before.statusRevision);
          expect((yield* projection).lifecyclePending).toBe(true);
          expect((yield* readCodeGraphLocalAssociation(home, {checkoutId, worktreeId})).state).toBe('missing');
          yield* fs.makeDirectory(worktree);
          expect((yield* codeGraphLiveObservationPaths(home)).statusRevision).not.toBe(removed.statusRevision);
          expect((yield* projection).lifecyclePending).toBe(false);
          // The observer never renews the owner's identity trust or writes the private record.
          expect(yield* fs.readFileString(file)).toBe(content);
          yield* TestClock.adjust('5 minutes');
          expect((yield* codeGraphLiveObservationPaths(home).pipe(Effect.result))._tag).toBe('Failure');
          expect(yield* fs.readFileString(file)).toBe(content);
        }),
    );
    it.effect('tracks active build heartbeat deadlines and drops the clock at terminal publication', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-live-clock-'});
        const directory = path.join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          Effect2.pipe('a', EffectString.repeat(64)),
          'build-status',
          Effect2.pipe('b', EffectString.repeat(64)),
        );
        yield* fs.makeDirectory(directory, {recursive: true});
        const now = yield* Clock.currentTimeMillis;
        const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));
        const status: CodeGraphBuildStatus = {
          buildId: Effect2.pipe('c', EffectString.repeat(32)),
          counters: {},
          identity: {
            checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
            worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
            repositoryId: Effect2.pipe('d', EffectString.repeat(64)),
            commit: Effect2.pipe('e', EffectString.repeat(40)),
          },
          owner: {processId: 42, runtime: 'bun', runtimeVersion: 'fixture'},
          phase: 'materializing',
          schemaVersion: 1,
          state: 'running',
          timestamps: {
            heartbeatAt: timestamp,
            lastProgressAt: timestamp,
            phaseStartedAt: timestamp,
            startedAt: timestamp,
            updatedAt: timestamp,
          },
        };
        const file = path.join(directory, `${status.buildId}.json`);
        yield* fs.writeFileString(file, JSON.stringify(status));
        const active = yield* codeGraphLiveObservationPaths(home);
        expect(active.files).toContain(file);
        expect(active.nextChangeAt).toBe(now + CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS + 1);
        yield* fs.writeFileString(
          file + '.tmp',
          JSON.stringify({...status, state: 'completed', timestamps: {...status.timestamps, completedAt: timestamp}}),
        );
        yield* fs.rename(file + '.tmp', file);
        const terminal = yield* codeGraphLiveObservationPaths(home);
        expect(terminal.nextChangeAt).toBeUndefined();
        expect(terminal.statusRevision).not.toBe(active.statusRevision);
        yield* fs.writeFileString(file, Effect2.pipe(' ', EffectString.repeat(64 * 1024 + 1)));
        expect((yield* codeGraphLiveObservationPaths(home).pipe(Effect.result))._tag).toBe('Failure');
      }),
    );
    it.effect('covers publication, WAL, stale markers and maintenance without opening graph databases', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-live-paths-'});
        const repository = path.join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          Effect2.pipe('a', EffectString.repeat(64)),
        );
        yield* fs.makeDirectory(path.join(repository, 'stale'), {recursive: true});
        for (const name of ['graph-v42.sqlite', 'graph-v42.sqlite-wal', 'graph-v42.sqlite-shm', 'stale/a.stale'])
          yield* fs.writeFileString(path.join(repository, name), 'deliberately not SQLite');
        const result = yield* codeGraphLiveObservationPaths(home);
        expect(result.files).toContain(path.join(repository, 'graph-v42.sqlite'));
        expect(result.files).toContain(path.join(repository, 'graph-v42.sqlite-wal'));
        expect(result.files).toContain(path.join(repository, 'stale/a.stale'));
        expect(result.files).not.toContain(path.join(repository, 'graph-v42.sqlite-shm'));
        expect(
          EffectArray.some(result.files, file =>
            Effect2.pipe(file, EffectString.endsWith('maintenance-status-v1.json')),
          ),
        ).toBe(true);
        expect(result.nextChangeAt).toBeUndefined();
      }),
    );
    it.effect('fails closed for an over-budget repository directory and linked source tree', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-live-cap-'});
        const root = path.join(home, 'indexes', 'code-graph', 'repositories');
        yield* fs.makeDirectory(root, {recursive: true});
        for (let index = 0; index < 65; index++) yield* fs.writeFileString(path.join(root, `noise-${index}`), '');
        expect((yield* codeGraphLiveObservationPaths(home).pipe(Effect.result))._tag).toBe('Failure');
        yield* fs.remove(root, {recursive: true});
        yield* fs.symlink(home, root);
        expect((yield* codeGraphLiveObservationPaths(home).pipe(Effect.result))._tag).toBe('Failure');
      }),
    );
    it.effect('caps the combined file inventory even without any build-status documents', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-live-file-cap-'});
        for (const id of ['a', 'b', 'c']) {
          const repository = path.join(
            home,
            'indexes',
            'code-graph',
            'repositories',
            Effect2.pipe(id, EffectString.repeat(64)),
          );
          yield* fs.makeDirectory(repository, {recursive: true});
          for (let index = 0; index < 180; index++)
            yield* fs.writeFileString(path.join(repository, `graph-v${index}.sqlite`), 'metadata-only');
        }
        expect((yield* codeGraphLiveObservationPaths(home).pipe(Effect.result))._tag).toBe('Failure');
      }),
    );
    it.effect('rejects an over-budget private provenance inventory before opening records', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-live-provenance-cap-'});
        const context = path.join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          Effect2.pipe('a', EffectString.repeat(64)),
          'local-context',
        );
        const directory = path.join(context, 'worktrees');
        yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
        yield* fs.chmod(context, 0o700);
        for (let index = 0; index < 33; index++) yield* fs.writeFileString(path.join(directory, `noise-${index}`), '');
        expect((yield* codeGraphLiveObservationPaths(home).pipe(Effect.result))._tag).toBe('Failure');
      }),
    );
  });
});
