import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';
import {CodeGraphDatabaseSession, withCodeGraphReadTransaction} from '@threadnote/graph/store/session';
import {TestError} from '@threadnote/testing/test-error';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-read-transaction-'});
  const databasePath = path.join(directory, 'graph.sqlite');
  yield* Effect.sync(() => {
    const database = new Database(databasePath);
    try {
      database.exec('PRAGMA journal_mode=WAL; CREATE TABLE evidence (value INTEGER); INSERT INTO evidence VALUES (1)');
    } finally {
      database.close();
    }
  });
  const context = yield* Layer.build(SqliteClient.layer({filename: databasePath, create: false, disableWAL: true}));
  const sql = Context.get(context, SqlClient.SqlClient);
  const session = CodeGraphDatabaseSession.of({
    databasePath,
    detachedCleanupRequest: {completedBuild: false, completedSnapshotId: undefined, routinePhysical: false},
    reconstructibleDurabilityConfigured: false,
    schemaInitialized: false,
    sql,
  });
  const read = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    withCodeGraphReadTransaction(
      {withSession: () => Effect.die('An existing read session must be reused.')},
      databasePath,
      program,
    ).pipe(Effect.provideService(CodeGraphDatabaseSession, session));
  const select = sql<{readonly value: number}>`SELECT value FROM evidence ORDER BY value`;
  return {read, select, sql};
});

describe('code graph read transactions', () => {
  effectIt.layer(BunServices.layer)(it => {
    it.effect('reuses existing native and nested read transactions without competing semaphore tags', () =>
      Effect.gen(function* () {
        const {read, select, sql} = yield* fixture;
        expect(yield* read(read(select))).toEqual([{value: 1}]);
        expect(yield* sql.withTransaction(read(select))).toEqual([{value: 1}]);
        yield* sql.withTransaction(sql`INSERT INTO evidence VALUES (2)`);
        expect(yield* read(select)).toEqual([{value: 1}, {value: 2}]);
      }).pipe(TestClock.withLive),
    );

    it.effect('rolls back failed and interrupted reads before the writable session is reused', () =>
      Effect.gen(function* () {
        const {read, select, sql} = yield* fixture;
        const failure = yield* read(
          select.pipe(Effect.andThen(Effect.fail(TestError.make({message: 'read failed'})))),
        ).pipe(Effect.result);
        expect(failure._tag).toBe('Failure');
        yield* sql.withTransaction(sql`INSERT INTO evidence VALUES (2)`);

        const entered = yield* Deferred.make<void>();
        const fiber = yield* read(
          select.pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never)),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        yield* sql.withTransaction(sql`INSERT INTO evidence VALUES (3)`);
        expect(yield* read(select)).toEqual([{value: 1}, {value: 2}, {value: 3}]);
      }).pipe(TestClock.withLive),
    );
  });
});
