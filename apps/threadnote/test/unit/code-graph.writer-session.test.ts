import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';
import {CodeGraphStore, type CodeGraphSqliteWriterSettings} from '@threadnote/graph/store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code graph writer session configuration', () => {
  effectIt.effect('does not re-report a connection for normal-only build durability', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-writer-session-'});
      const observed: CodeGraphSqliteWriterSettings[] = [];
      const store = yield* CodeGraphStore;
      yield* store.withSession(path.join(root, 'graph.sqlite'), store.initialize(path.join(root, 'graph.sqlite')), {
        onSqliteWriterConfigured: settings => Effect.sync(() => observed.push(settings)),
        sqliteWriterTuning: {reconstructibleBuildSynchronous: 'normal'},
        writerLockPath: path.join(root, 'writer.lock'),
      });

      expect(observed.filter(settings => settings.phase === 'connection')).toHaveLength(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reapplies an explicit WAL checkpoint override after schema initialization', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-writer-session-'});
      const databasePath = path.join(root, 'graph.sqlite');
      const observed: CodeGraphSqliteWriterSettings[] = [];
      const store = yield* CodeGraphStore;
      const walAutoCheckpointPages = yield* store.withSession(
        databasePath,
        Effect.gen(function* () {
          yield* store.initialize(databasePath);
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<{readonly wal_autocheckpoint: number}>('PRAGMA wal_autocheckpoint');
          return Number(rows[0]?.wal_autocheckpoint);
        }),
        {
          onSqliteWriterConfigured: settings => Effect.sync(() => observed.push(settings)),
          sqliteWriterTuning: {walAutoCheckpointPages: 137},
          writerLockPath: path.join(root, 'writer.lock'),
        },
      );

      expect(walAutoCheckpointPages).toBe(137);
      expect(observed.filter(settings => settings.phase === 'connection')).toHaveLength(2);
      expect(observed.at(-1)?.walAutoCheckpointPages).toBe(137);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
