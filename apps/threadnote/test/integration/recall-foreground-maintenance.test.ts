import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  String as EffectString,
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {
  loadRecallIndexData,
  readRecallIndexData,
  readRecallIndexDataBatch,
  readRecallExactMatches,
  readRecallMemoryIdentities,
  readRecallCodeLinks,
  readRecallMemoryLinks,
  recallIndexDatabaseFilename,
  recallIndexStatus,
  expireRecallIndexValidation,
} from '@threadnote/recall/index';
import {requestRecallLexicalRefresh, readRecallLexicalDemand} from '@threadnote/recall/background/lexical-demand';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {withSharedRepositoryLock} from '../../src/effect/share/lock.js';
import {recallReadMaintenanceLayer} from '../../src/recall/read_maintenance.js';
import {runRecallLexicalWorkerUnit} from '../../src/recall/embedding_worker.js';

const platform = Layer.mergeAll(
  BunServices.layer,
  cryptoLayer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
        Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
      ),
    ),
  ),
);
// oxlint-disable-next-line effecttsgo/strict-effect-provide -- This is the scoped test entry point with one focused platform layer.
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(platform), TestClock.withLive);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-maintenance-'});
  const config = {account: 'local', agentContextHome: home, user: 'me'};
  const directory = path.join(home, 'data', 'local', 'resources');
  yield* fs.makeDirectory(directory, {recursive: true});
  yield* fs.writeFileString(path.join(directory, 'alpha.md'), '# Alpha\nalpha sentinel');
  yield* loadRecallIndexData(config, {includeInactive: false});
  return {fs, path, config, directory};
});
describe('foreground reads and lexical maintenance', () => {
  effectIt.effect('reconciles raw canonical drift once even when freshness epochs were not changed', () =>
    Effect.gen(function* () {
      const {fs, path, config, directory} = yield* fixture;
      const scope = {...config, includeInactive: false};
      const filename = path.join(directory, 'alpha.md');
      const before = yield* recallIndexStatus(config, false);
      yield* fs.writeFileString(filename, '# Alpha\nreplacement sentinel');
      expect((yield* recallIndexStatus(config, false)).ready).toBe(true);
      expect((yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'})).candidates).toEqual([]);
      expect((yield* readRecallLexicalDemand(scope))?.reconcile).toBe(true);
      expect((yield* runRecallLexicalWorkerUnit(scope)).state).toBe('complete');
      const ready = yield* readRecallIndexData(config, {includeInactive: false, query: 'replacement'});
      expect(EffectArray.map(ready.candidates, candidate => candidate.uri)).toEqual([
        'threadnote://resources/alpha.md',
      ]);
      expect(ready.readState).toEqual({freshness: 'current', maintenance: 'unneeded'});
      expect((yield* readRecallLexicalDemand(scope))?.revision).toBeUndefined();
      expect((yield* recallIndexStatus(config, false)).generation).not.toBe(before.generation);
      expect((yield* runRecallLexicalWorkerUnit(scope)).state).toBe('complete');
      expect(yield* fs.exists(path.join(config.agentContextHome, 'models'))).toBe(false);
    }).pipe(provide),
  );
  effectIt.effect(
    'reads one complete last-ready WAL snapshot while an independent SQLite writer is held',
    () =>
      Effect.gen(function* () {
        const {fs, path, config} = yield* fixture;
        const uri = 'threadnote://resources/alpha.md';
        yield* expireRecallIndexValidation(config.agentContextHome, false, [uri]);
        const filename = path.join(config.agentContextHome, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
        const script = `import {Database} from 'bun:sqlite';
        import {Effect, FileSystem} from 'effect';
        import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
        import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
        await Effect.runPromise(Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const options = {retryIntervalMilliseconds: 5, staleAfterMilliseconds: 30000, waitTimeoutMilliseconds: 1000};
          yield* withExclusiveFileLock(fs, Bun.argv[2], options,
            withExclusiveFileLock(fs, Bun.argv[3], options, Effect.promise(async () => {
              const db = new Database(Bun.argv[1]); db.exec('BEGIN IMMEDIATE');
              db.exec('DELETE FROM exact_search'); db.exec('DELETE FROM documents');
              console.log('held'); await Bun.stdin.text(); db.exec('ROLLBACK'); db.close();
            })));
        }).pipe(Effect.provide(ApplicationLayer)));`;
        const lexicalLock = path.join(
          config.agentContextHome,
          'locks',
          'indexes',
          'lexical',
          recallIndexDatabaseFilename(false) + '.lock',
        );
        const canonicalLock = path.join(
          config.agentContextHome,
          'locks',
          'resources',
          config.account,
          'mutations.lock',
        );
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            Bun.spawn([process.execPath, '--eval', script, filename, lexicalLock, canonicalLock], {
              stdin: 'pipe',
              stdout: 'pipe',
              stderr: 'pipe',
            }),
          ),
          child =>
            Effect.gen(function* () {
              const reader = child.stdout.getReader();
              const ready = yield* Effect.promise(() => reader.read());
              expect(new TextDecoder().decode(ready.value)).toContain('held');
              reader.releaseLock();
              const started = performance.now();
              const result = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'});
              expect(EffectArray.map(result.candidates, candidate => candidate.uri)).toEqual([uri]);
              expect(result.readState?.freshness).toBe('stale');
              const batch = yield* readRecallIndexDataBatch(config, {
                includeInactive: false,
                selections: [{query: 'alpha'}, {query: 'sentinel'}],
              });
              expect(EffectArray.map(batch, data => data.generation)).toEqual([result.generation, result.generation]);
              expect(
                yield* readRecallExactMatches(config, {
                  includeInactive: false,
                  terms: ['alpha'],
                  uriScopes: ['threadnote://resources'],
                }),
              ).toEqual([{uri, terms: ['alpha']}]);
              expect(
                (yield* readRecallMemoryIdentities(config, {
                  allowedUriScopes: ['threadnote://user/me/memories'],
                  memoryIds: ['tn_missing'],
                }).pipe(Effect.result))._tag,
              ).toBe('Failure');
              expect(
                yield* readRecallMemoryLinks(config, {
                  includeInactive: false,
                  memorySeeds: [{memoryId: 'tn_missing', requestedOrdinal: 0}],
                }),
              ).toEqual([]);
              expect(
                yield* readRecallCodeLinks(config, {
                  includeInactive: false,
                  anchors: [
                    {
                      version: 1,
                      id: 'fixture',
                      extractorSet: 'fixture',
                      path: 'alpha.ts',
                      repositoryId: 'fixture',
                      repositoryIdentityKind: 'local',
                      sourceCommit: 'fixture',
                      sourceDirty: false,
                      sourceSnapshotId: 'fixture',
                      target: {kind: 'file'},
                      fileContentHash: {algorithm: 'sha256', value: EffectString.repeat(64)('a')},
                    },
                  ],
                }),
              ).toEqual([]);
              expect(performance.now() - started).toBeLessThan(1000);
              expect((yield* fs.stat(filename)).type).toBe('File');
            }),
          child =>
            Effect.promise(async () => {
              child.kill();
              await child.exited;
            }),
        );
      }).pipe(provide),
    10_000,
  );
  effectIt.effect('completes lexical demand without any model services or model installation', () =>
    Effect.gen(function* () {
      const {fs, path, config, directory} = yield* fixture;
      yield* fs.writeFileString(path.join(directory, 'beta.md'), '# Beta\nbeta sentinel');
      yield* expireRecallIndexValidation(config.agentContextHome, false, ['threadnote://resources/beta.md']);
      const scope = {...config, includeInactive: false};
      yield* requestRecallLexicalRefresh(scope);
      const result = yield* runRecallLexicalWorkerUnit(scope);
      expect(result.state).toBe('complete');
      expect((yield* readRecallLexicalDemand(scope))?.revision).toBeUndefined();
      const ready = yield* readRecallIndexData(config, {includeInactive: false, query: 'beta'});
      expect(EffectArray.map(ready.candidates, candidate => candidate.uri)).toEqual(['threadnote://resources/beta.md']);
      expect(yield* fs.exists(path.join(config.agentContextHome, 'models'))).toBe(false);
      expect(yield* fs.exists(path.join(config.agentContextHome, 'recall', 'embedding-demand-v1'))).toBe(false);
    }).pipe(provide),
  );
});

effectIt.effect(
  'retains durable synchronization while a shared writer is held and completes after release',
  () =>
    Effect.gen(function* () {
      const {fs, path, config: basic} = yield* fixture;
      const config = {
        ...basic,
        agentId: 'threadnote',
        manifestPath: path.join(basic.agentContextHome, 'manifest.yaml'),
      };
      yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      yield* loadRecallIndexData(config, {includeInactive: false, memoryIds: []});
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* withSharedRepositoryLock(
        config,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const scope = {...config, includeInactive: false, work: {kind: 'synchronize' as const, sources: false}};
      const revision = yield* requestRecallLexicalRefresh(scope);
      const port = yield* Layer.build(recallReadMaintenanceLayer);
      const deferred = yield* runRecallLexicalWorkerUnit(scope).pipe(Effect.provide(port));
      expect(deferred).toMatchObject({state: 'deferred', reason: 'read-maintenance-pending'});
      expect((yield* readRecallLexicalDemand(scope))?.revision).toBe(revision);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      const clock = yield* Clock.Clock;
      const later = (yield* Clock.currentTimeMillis) + 10_000;
      const complete = yield* runRecallLexicalWorkerUnit(scope).pipe(
        Effect.provide(port),
        Effect.provideService(Clock.Clock, {
          currentTimeMillis: Effect.succeed(later),
          currentTimeMillisUnsafe: () => later,
          currentTimeNanos: clock.currentTimeNanos,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          sleep: duration => clock.sleep(duration),
        }),
      );
      expect(complete.state).toBe('complete');
      expect((yield* readRecallLexicalDemand(scope))?.revision).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  10_000,
);
