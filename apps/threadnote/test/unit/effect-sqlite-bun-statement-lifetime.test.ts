import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Deferred, Effect, Exit, Fiber} from 'effect';
import * as FC from 'fast-check';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect, vi} from 'vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = () => SqliteClient.layer({filename: ':memory:', disableWAL: true});

/** Keep native wrappers alive and require SQLite to close without outstanding statements. */
const observeStrictClose = Effect.acquireRelease(
  Effect.sync(() => {
    const statements: Array<ReturnType<Database['query']>> = [];
    const originalQuery = Database.prototype.query;
    const originalClose = Database.prototype.close;
    const observation = {closeAttempts: 0, statements, strictCloses: 0};
    const query = vi.spyOn(Database.prototype, 'query').mockImplementation(function (
      this: Database,
      ...args: Parameters<Database['query']>
    ) {
      const statement = Reflect.apply(originalQuery, this, args);
      statements.push(statement);
      return statement;
    });
    const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database) {
      observation.closeAttempts++;
      originalClose.call(this, true);
      observation.strictCloses++;
    });
    return {close, observation, query};
  }),
  ({close, query}) =>
    Effect.sync(() => {
      query.mockRestore();
      close.mockRestore();
    }),
).pipe(Effect.map(({observation}) => observation));

describe('Effect Bun SQLite statement lifetime without a package patch', () => {
  effectIt.effect('strictly closes a connection after more distinct queries than Bun caches', () =>
    Effect.gen(function* () {
      const observed = yield* observeStrictClose;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (let key = 0; key < 100; key++) {
          expect(yield* sql.unsafe(`SELECT ? AS value /* statement-${key} */`, [key])).toEqual([{value: key}]);
        }
        expect(yield* sql.unsafe('SELECT ? AS value /* statement-0 */', [101])).toEqual([{value: 101}]);
      }).pipe(provideTestLayer(layer()));
      expect(observed.statements.length).toBeGreaterThanOrEqual(100);
      expect(observed.closeAttempts).toBe(1);
      expect(observed.strictCloses).toBe(1);
    }),
  );

  effectIt.effect('strictly closes after nested rollback and interruption', () =>
    Effect.gen(function* () {
      const observed = yield* observeStrictClose;
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('CREATE TABLE entries(value INTEGER PRIMARY KEY)');
        for (let key = 0; key < 40; key++) yield* sql.unsafe(`SELECT ${key} /* transaction-${key} */`);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe('INSERT INTO entries VALUES (1)');
            const inner = yield* Effect.exit(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe('INSERT INTO entries VALUES (2)');
                  yield* sql.unsafe('INSERT INTO entries VALUES (1)');
                }),
              ),
            );
            expect(Exit.isFailure(inner)).toBe(true);
            expect(yield* sql.unsafe('SELECT value FROM entries ORDER BY value')).toEqual([{value: 1}]);
          }),
        );
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe('INSERT INTO entries VALUES (3)');
            yield* Deferred.succeed(ready, undefined);
            return yield* Effect.never;
          }),
        );
      }).pipe(provideTestLayer(layer()), Effect.forkChild);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expect(observed.closeAttempts).toBe(1);
      expect(observed.strictCloses).toBe(1);
    }),
  );

  fcEffectProp(
    effectIt,
    'preserves rows and blobs across query reuse, integer modes, and strict close',
    {
      operations: FC.array(
        FC.record({
          bytes: FC.uint8Array({maxLength: 16}),
          key: FC.integer({min: 0, max: 31}),
          mode: FC.constantFrom('rows', 'values', 'raw', 'unprepared', 'valuesUnprepared'),
          safe: FC.boolean(),
          value: FC.bigInt({min: -(1n << 60n), max: 1n << 60n}),
        }),
        {minLength: 24, maxLength: 48},
      ),
    },
    ({operations}) =>
      Effect.gen(function* () {
        const observed = yield* observeStrictClose;
        const retained: Array<{actual: unknown; expected: unknown}> = [];
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (let key = 0; key < 24; key++) {
            yield* sql.unsafe(`SELECT ? AS value, ? AS bytes /* property-${key} */`, [key, new Uint8Array()]);
          }
          for (const operation of operations) {
            const statement = sql.unsafe(`SELECT ? AS value, ? AS bytes /* property-${operation.key} */`, [
              operation.value,
              operation.bytes,
            ]);
            const effect = operation.mode === 'rows' ? statement : statement[operation.mode];
            const actual = yield* effect.pipe(Effect.provideService(SqlClient.SafeIntegers, operation.safe));
            const value = operation.safe ? operation.value : Number(operation.value);
            const bytes = Uint8Array.from(operation.bytes);
            const expected = operation.mode.startsWith('values') ? [[value, bytes]] : [{value, bytes}];
            expect(actual).toEqual(expected);
            retained.push({actual, expected});
          }
        }).pipe(provideTestLayer(layer()));
        for (const {actual, expected} of retained) expect(actual).toEqual(expected);
        expect(observed.closeAttempts).toBe(1);
        expect(observed.strictCloses).toBe(1);
      }),
    {fastCheck: {numRuns: 30}},
  );
});
