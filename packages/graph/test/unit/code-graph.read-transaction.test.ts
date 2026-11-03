import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';
import {
  CodeGraphDatabaseSession,
  withCodeGraphDeferredTransaction,
  withCodeGraphReadTransaction,
  withFreshCodeGraphReadTransaction,
} from '@threadnote/graph/store/session';
import {CodeGraphStoreBusyError} from '@threadnote/graph/types';
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
  return {databasePath, read, select, sql};
});

describe('code graph read transactions', () => {
  effectIt.layer(BunServices.layer)(it => {
    it.effect('preserves typed busy failures and pure or mixed interruption at the fresh-reader boundary', () =>
      Effect.gen(function* () {
        const {databasePath} = yield* fixture;
        const busy = CodeGraphStoreBusyError.of('fixture busy');
        const typed = yield* withFreshCodeGraphReadTransaction(databasePath, Effect.fail(busy)).pipe(Effect.result);
        expect(typed._tag).toBe('Failure');
        if (typed._tag === 'Failure') expect(typed.failure).toBe(busy);
        const defect = {code: 'SQLITE_BUSY', message: 'private fixture path'};
        const translated = yield* withFreshCodeGraphReadTransaction(databasePath, Effect.die(defect)).pipe(
          Effect.result,
        );
        expect(translated).toMatchObject({failure: {code: 'busy', retryable: true, recovery: 'defer'}});
        for (const cause of [
          Cause.interrupt(123),
          Cause.combine(Cause.interrupt(123), Cause.die(defect)),
          Cause.combine(Cause.interrupt(123), Cause.fail(busy)),
        ]) {
          const exit = yield* withFreshCodeGraphReadTransaction(databasePath, Effect.failCause(cause)).pipe(
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasInterrupts(exit.cause)).toBe(true);
            expect(Cause.hasDies(exit.cause)).toBe(Cause.hasDies(cause));
            expect(Cause.hasFails(exit.cause)).toBe(Cause.hasFails(cause));
          }
        }
      }).pipe(TestClock.withLive),
    );
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

    it.effect('preserves nested temporary savepoints inside an existing deferred read', () =>
      Effect.gen(function* () {
        const {read, sql} = yield* fixture;
        yield* sql`CREATE TEMP TABLE staged (value INTEGER)`;
        yield* read(
          Effect.gen(function* () {
            yield* sql`INSERT INTO staged VALUES (1)`;
            const failed = yield* withCodeGraphDeferredTransaction(
              sql,
              sql`INSERT INTO staged VALUES (2)`.pipe(
                Effect.andThen(Effect.fail(TestError.make({message: 'temporary failure'}))),
              ),
            ).pipe(Effect.result);
            expect(failed._tag).toBe('Failure');
            expect(yield* sql`SELECT value FROM staged`).toEqual([{value: 1}]);
          }),
        );
        yield* sql.withTransaction(sql`INSERT INTO evidence VALUES (2)`);
      }).pipe(TestClock.withLive),
    );
  });
});
