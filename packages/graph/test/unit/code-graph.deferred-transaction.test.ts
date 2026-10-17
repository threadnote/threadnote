import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';
import {withCodeGraphDeferredTransaction} from '@threadnote/graph/store/session';
import {TestError} from '@threadnote/testing/test-error';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-deferred-transaction-'});
  const context = yield* Layer.build(SqliteClient.layer({filename: path.join(directory, 'graph.sqlite')}));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* sql`CREATE TEMP TABLE evidence (value INTEGER)`;
  const transaction = <A, E, R>(program: Effect.Effect<A, E, R>) => withCodeGraphDeferredTransaction(sql, program);
  const select = sql<{readonly value: number}>`SELECT value FROM evidence ORDER BY value`;
  return {select, sql, transaction};
});

describe('code graph deferred transactions', () => {
  effectIt.layer(BunServices.layer)(it => {
    it.effect('rolls back a failed nested savepoint while preserving the enclosing temporary transaction', () =>
      Effect.gen(function* () {
        const {select, sql, transaction} = yield* fixture;
        yield* transaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO evidence VALUES (1)`;
            const failed = yield* transaction(
              sql`INSERT INTO evidence VALUES (2)`.pipe(
                Effect.andThen(Effect.fail(TestError.make({message: 'nested failure'}))),
              ),
            ).pipe(Effect.result);
            expect(failed._tag).toBe('Failure');
            expect(yield* select).toEqual([{value: 1}]);
            yield* transaction(sql`INSERT INTO evidence VALUES (3)`);
          }),
        );
        expect(yield* select).toEqual([{value: 1}, {value: 3}]);
      }).pipe(TestClock.withLive),
    );

    it.effect('uses the native wrapper when nested inside a native transaction', () =>
      Effect.gen(function* () {
        const {select, sql, transaction} = yield* fixture;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO evidence VALUES (1)`;
            const failed = yield* transaction(
              sql`INSERT INTO evidence VALUES (2)`.pipe(
                Effect.andThen(Effect.fail(TestError.make({message: 'native nested failure'}))),
              ),
            ).pipe(Effect.result);
            expect(failed._tag).toBe('Failure');
            yield* transaction(transaction(sql`INSERT INTO evidence VALUES (3)`));
          }),
        );
        expect(yield* select).toEqual([{value: 1}, {value: 3}]);
      }).pipe(TestClock.withLive),
    );

    it.effect('rolls back failed and interrupted temporary work before connection reuse', () =>
      Effect.gen(function* () {
        const {select, sql, transaction} = yield* fixture;
        const failed = yield* transaction(
          sql`INSERT INTO evidence VALUES (1)`.pipe(Effect.andThen(Effect.fail(TestError.make({message: 'failure'})))),
        ).pipe(Effect.result);
        expect(failed._tag).toBe('Failure');
        const entered = yield* Deferred.make<void>();
        const fiber = yield* transaction(
          sql`INSERT INTO evidence VALUES (2)`.pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        yield* sql.withTransaction(sql`INSERT INTO evidence VALUES (3)`);
        expect(yield* transaction(select)).toEqual([{value: 3}]);
      }).pipe(TestClock.withLive),
    );
  });
});
