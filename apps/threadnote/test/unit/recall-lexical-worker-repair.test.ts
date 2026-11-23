import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {ResourceStore} from '@threadnote/store/resource-store';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {writeModelSelection} from '@threadnote/inference/models/selection';
import {ensureRecallEmbeddingsReceipt, readRecallEmbeddingDemand} from '@threadnote/recall/background/demand';
import {
  expireRecallIndexValidation,
  loadRecallIndexData,
  readRecallIndexData,
  recallIndexDatabaseFilename,
  recallIndexStatus,
} from '@threadnote/recall/index';
import {readRecallStaleMarker} from '@threadnote/recall/index/stale_marker';
import {recallReadStateWarnings} from '@threadnote/recall/warning';
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
  it.effect('rebuilds an inactive snapshot that status cannot trust and clears its forced marker', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* ResourceStore;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'lexical-worker-repair-'}));
      const config = {account: 'local', user: 'me', agentContextHome: home};
      const scope = {...config, includeInactive: true};
      const write = (id: number, body: string) =>
        store.mutateChecked(
          {account: 'local', user: 'me', home},
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
      yield* write(0, 'indexed before the damage');
      yield* loadRecallIndexData(config, {includeInactive: true, memoryIds: []});
      // An interrupted publication or an older writer leaves metadata that status cannot trust.
      const database = path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(true));
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new Database(database)),
        db => Effect.sync(() => db.run("UPDATE metadata SET value = 'interrupted' WHERE key = 'integrity_sequence'")),
        db => Effect.sync(() => db.close()),
      );
      yield* write(1, 'written after the damage');
      yield* expireRecallIndexValidation(home, true);
      expect(yield* recallIndexStatus(config, true)).toMatchObject({ready: false});
      expect(yield* readRecallStaleMarker(fs, database)).toMatchObject({forceRefresh: true});

      const unavailable = yield* readRecallIndexData(config, {includeInactive: true, memoryIds: ['tn_1']}).pipe(
        Effect.flip,
      );
      expect(unavailable).toMatchObject({_tag: 'RecallReadyReadUnavailable'});

      expect(yield* runRecallLexicalWorkerUnit(scope)).toMatchObject({state: 'complete'});
      expect(yield* recallIndexStatus(config, true)).toMatchObject({ready: true, documentCount: 2});
      expect(yield* readRecallStaleMarker(fs, database)).toMatchObject({forceRefresh: false, invalidatedUris: []});
      const recalled = yield* readRecallIndexData(config, {includeInactive: true, memoryIds: ['tn_1']});
      expect(EffectArray.map(recalled.candidates, candidate => candidate.memoryId)).toEqual(['tn_1']);
      expect(recallReadStateWarnings(recalled.readState)).toEqual([]);
    }).pipe(TestClock.withLive),
  );
  it.effect('queues vector reuse after recall prepares a missing active schema', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'lexical-worker-upgrade-'}));
      const scope = {account: 'local', user: 'me', agentContextHome: home, includeInactive: false};
      const memory = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable');
      yield* fs.makeDirectory(memory, {recursive: true});
      yield* fs.writeFileString(
        path.join(memory, 'evidence.md'),
        'MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_evidence\n\nAlbatross evidence',
      );
      yield* loadRecallIndexData(scope, {includeInactive: false, memoryIds: []});
      const index = path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
      yield* fs.rename(index, path.join(path.dirname(index), 'active-v15.sqlite'));
      yield* writeModelSelection(home, {version: 1, roles: {}, purposes: {recall: 'bge-small-en-v1.5-q8'}});

      const missed = yield* readRecallIndexData(scope, {includeInactive: false, query: 'Albatross'}).pipe(Effect.flip);
      expect(missed).toMatchObject({_tag: 'RecallReadyReadUnavailable'});
      expect((yield* readRecallEmbeddingDemand(scope))?.desired).toBeUndefined();
      expect(yield* runRecallLexicalWorkerUnit(scope)).toMatchObject({state: 'complete'});
      expect(yield* recallIndexStatus(scope)).toMatchObject({ready: true, documentCount: 1});

      const pending = (yield* readRecallEmbeddingDemand(scope))?.desired;
      expect(pending).toBeDefined();
      expect(yield* ensureRecallEmbeddingsReceipt(scope)).toMatchObject({...pending, disposition: 'coalesced'});
      expect((yield* readRecallEmbeddingDemand(scope))?.desired).toEqual(pending);
    }).pipe(TestClock.withLive),
  );
});
