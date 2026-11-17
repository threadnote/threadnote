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
});
