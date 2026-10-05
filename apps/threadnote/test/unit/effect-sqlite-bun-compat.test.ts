import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Cause, Effect, Exit, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';

describe('Effect 4 Bun SQLite transaction compatibility', () => {
  effectIt.effect('keeps read-only transactions deferred while writable transactions reserve the writer lock', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-effect-sqlite-compat-'});
        const databasePath = path.join(root, 'fixture.sqlite');
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.exec("CREATE TABLE entries (value TEXT NOT NULL); INSERT INTO entries VALUES ('ready');");
          } finally {
            database.close(false);
          }
        });

        const readOnly = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe('PRAGMA query_only = ON');
          const rows = yield* sql.withTransaction(
            Effect.all(
              [
                sql.unsafe<{readonly count: number}>('SELECT COUNT(*) AS count FROM entries'),
                sql.unsafe<{readonly value: string}>('SELECT value FROM entries'),
              ],
              {concurrency: 1},
            ),
          );
          const writeExit = yield* Effect.exit(
            sql.withTransaction(sql.unsafe("INSERT INTO entries VALUES ('forbidden')")),
          );
          return {rows, writeExit};
        }).pipe(
          provideTestLayer(
            SqliteClient.layer({
              busyTimeout: 0,
              create: false,
              disableWAL: true,
              filename: databasePath,
              readonly: true,
              readwrite: false,
            }),
          ),
        );

        expect(readOnly.rows).toEqual([[{count: 1}], [{value: 'ready'}]]);
        expect(Exit.isFailure(readOnly.writeExit)).toBe(true);
        if (Exit.isFailure(readOnly.writeExit)) {
          expect(String(Cause.squash(readOnly.writeExit.cause))).toContain('Failed to execute statement');
        }

        const blockingWriter = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(databasePath, {create: false, strict: true})),
          database =>
            Effect.sync(() => {
              try {
                database.exec('ROLLBACK');
              } catch {
                // The transaction may already be absent on an assertion path.
              }
              database.close(false);
            }),
        );
        yield* Effect.sync(() => blockingWriter.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;'));
        const writableExit = yield* Effect.exit(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql.withTransaction(sql.unsafe('SELECT value FROM entries'));
          }).pipe(
            provideTestLayer(
              SqliteClient.layer({
                busyTimeout: 0,
                create: false,
                disableWAL: true,
                filename: databasePath,
                readwrite: true,
              }),
            ),
          ),
        );
        expect(Exit.isFailure(writableExit)).toBe(true);
        if (Exit.isFailure(writableExit)) {
          expect(String(Cause.squash(writableExit.cause))).toContain('Failed to execute statement');
        }
      }),
    ).pipe(provideTestLayer(BunServices.layer), TestClock.withLive),
  );
});
