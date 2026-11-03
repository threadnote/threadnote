import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {ResourceStore} from '@threadnote/store/resource-store';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {readRecallLexicalDemand, requestRecallLexicalRefresh} from '@threadnote/recall/background/lexical-demand';
import {runRecallLexicalWorkerUnit} from '../../src/recall/embedding_worker.js';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
    ),
  ),
);
const platform = Layer.mergeAll(BunServices.layer, cryptoLayer, system, recallResourceInvalidationLayer);
const services = ResourceStore.layer.pipe(Layer.provideMerge(platform));

effectIt.layer(services)(it => {
  for (const mutation of ['write-other', 'delete-hydrated'] as const)
    for (const newerDemand of [false, true])
      it.effect(`retains ${newerDemand ? 'newer' : 'same'} demand without failure backoff after ${mutation}`, () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* ResourceStore;
          const temporaryHome = yield* fs.makeTempDirectoryScoped({prefix: 'lexical-worker-superseded-'});
          const home = yield* fs.realPath(temporaryHome);
          const scope = {account: 'local', user: 'me', agentContextHome: home, includeInactive: false};
          const location = {account: 'local', user: 'me', home};
          const write = (id: number, body: string) =>
            store.mutateChecked(
              location,
              [
                {
                  type: 'write',
                  uri: `threadnote://user/me/memories/durable/${id}.md`,
                  content: `MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_${id}\nsource_agent_client: test\ntimestamp: 2026-11-03T00:00:00.000Z\n\n${body}`,
                  options: {mode: 'upsert'},
                },
              ],
              Effect.void,
            );
          yield* write(0, 'old');
          yield* loadRecallIndexData(scope, {includeInactive: false, memoryIds: []});
          yield* write(0, 'prepared');
          yield* requestRecallLexicalRefresh(scope);
          const original = yield* readRecallLexicalDemand(scope);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const target = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', '0.md');
          let calls = 0;
          const observed = FileSystem.FileSystem.of({
            ...fs,
            realPath: filename => {
              if (filename !== target || ++calls !== (mutation === 'delete-hydrated' ? 2 : 1))
                return fs.realPath(filename);
              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(fs.realPath(filename)),
              );
            },
          });
          const worker = yield* runRecallLexicalWorkerUnit(scope).pipe(
            Effect.provideService(FileSystem.FileSystem, observed),
            Effect.forkScoped,
          );
          let latest = original;
          yield* Effect.gen(function* () {
            yield* Deferred.await(entered).pipe(Effect.timeout('3 seconds'));
            if (mutation === 'delete-hydrated')
              yield* store.mutateChecked(
                location,
                [{type: 'remove', uri: 'threadnote://user/me/memories/durable/0.md'}],
                Effect.void,
              );
            else yield* write(1, 'new canonical revision');
            if (newerDemand) yield* requestRecallLexicalRefresh(scope);
            latest = yield* readRecallLexicalDemand(scope);
            if (newerDemand) expect(latest?.revision).not.toBe(original?.revision);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
          expect(yield* Fiber.join(worker)).toMatchObject({state: 'checkpointed', reason: 'source-changed'});
          const pending = yield* readRecallLexicalDemand(scope);
          expect(pending?.revision).toBe(latest?.revision);
          expect(pending?.revision).toBeDefined();
          expect(pending?.failures).toBe(0);
          expect(pending?.notBefore).toBeUndefined();
          expect(pending?.completedAt).toBeUndefined();
          expect(yield* runRecallLexicalWorkerUnit(scope)).toMatchObject({state: 'complete'});
          expect((yield* readRecallLexicalDemand(scope))?.revision).toBeUndefined();
        }).pipe(TestClock.withLive),
      );
});
