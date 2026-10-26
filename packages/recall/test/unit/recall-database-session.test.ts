import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it} from '@effect/vitest';
import {Cause, Context, Effect, Fiber, FileSystem, Layer, Option, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {expect, vi} from 'vitest';
import {useRecallDatabase, withRecallDatabaseSession} from '../../src/index/database.js';

const marker = Effect.flatMap(SqlClient.SqlClient, sql =>
  sql
    .unsafe<{name: string}>("SELECT name FROM sqlite_temp_master WHERE name = 'session_marker'")
    .pipe(Effect.map(rows => rows.length > 0)),
);
const mark = Effect.flatMap(SqlClient.SqlClient, sql => sql.unsafe('CREATE TEMP TABLE session_marker (value TEXT)'));
const fixture = <A, E, R>(program: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({prefix: 'recall-session-'});
    const path = paths.join(directory, 'recall.sqlite');
    yield* useRecallDatabase(
      path,
      Effect.flatMap(SqlClient.SqlClient, sql => sql.unsafe('CREATE TABLE data (value TEXT)')),
    );
    return yield* program(path);
  }).pipe(program =>
    Effect.scoped(
      Layer.build(BunServices.layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))),
    ),
  );

it.effect('keeps ordinary queries fresh and closes a retained client only after its batch', () =>
  fixture(path =>
    Effect.gen(function* () {
      yield* useRecallDatabase(path, mark);
      expect(yield* useRecallDatabase(path, marker)).toBe(false);
      const close = vi.spyOn(Database.prototype, 'close');
      yield* Effect.gen(function* () {
        yield* withRecallDatabaseSession(
          Effect.gen(function* () {
            yield* useRecallDatabase(path, mark);
            expect(yield* useRecallDatabase(path, marker)).toBe(true);
            expect(close).toHaveBeenCalledTimes(0);
            expect(yield* useRecallDatabase(path, marker, false)).toBe(false);
            expect(close).toHaveBeenCalledTimes(1);
            expect(yield* useRecallDatabase(path, marker)).toBe(true);
          }),
        );
        expect(close).toHaveBeenCalledTimes(2);
        expect(yield* useRecallDatabase(path, marker)).toBe(false);
      }).pipe(Effect.ensuring(Effect.sync(() => close.mockRestore())));
    }),
  ),
);

it.effect.prop(
  'evicts failed or interrupted TEMP state before the next query',
  {
    failures: Schema.Array(Schema.Boolean).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  },
  ({failures}) =>
    fixture(path =>
      withRecallDatabaseSession(
        Effect.gen(function* () {
          for (const interrupted of failures) {
            expect(yield* useRecallDatabase(path, marker)).toBe(false);
            const exit = yield* useRecallDatabase(
              path,
              mark.pipe(Effect.andThen(interrupted ? Effect.interrupt : Effect.fail('query failed'))),
            ).pipe(Effect.exit);
            expect(exit._tag).toBe('Failure');
          }
          expect(yield* useRecallDatabase(path, marker)).toBe(false);
        }),
      ),
    ),
  {arbitrary: {runs: 8}},
);

it.effect('keeps reentrant, child and nested sessions independent and revokes inherited tokens', () =>
  fixture(path =>
    Effect.gen(function* () {
      let inherited: Context.Context<never> | undefined;
      yield* withRecallDatabaseSession(
        Effect.gen(function* () {
          yield* useRecallDatabase(path, mark);
          inherited = yield* Effect.context<never>();
          const child = yield* useRecallDatabase(path, marker).pipe(Effect.forkChild);
          expect(yield* Fiber.join(child)).toBe(false);
          yield* useRecallDatabase(
            path,
            Effect.gen(function* () {
              expect(yield* marker).toBe(true);
              expect(yield* useRecallDatabase(path, marker)).toBe(false);
            }),
          );
          expect(yield* withRecallDatabaseSession(useRecallDatabase(path, marker))).toBe(false);
          expect(yield* useRecallDatabase(path, marker)).toBe(true);
        }),
      );
      if (!inherited) throw new Error('Missing captured session context');
      expect(yield* useRecallDatabase(path, marker).pipe(Effect.provide(inherited))).toBe(false);
    }),
  ),
);

it.effect('falls back to fresh scopes when file identity is missing or unsafe', () =>
  fixture(path =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const ino of [Option.none<number>(), Option.some(0), Option.some(Number.MAX_SAFE_INTEGER + 1)]) {
        const uncertain = FileSystem.make({
          ...fs,
          stat: value => fs.stat(value).pipe(Effect.map(info => ({...info, ino}))),
        });
        yield* withRecallDatabaseSession(
          Effect.gen(function* () {
            yield* useRecallDatabase(path, mark);
            expect(yield* useRecallDatabase(path, marker)).toBe(false);
          }),
        ).pipe(Effect.provideService(FileSystem.FileSystem, uncertain));
      }
    }),
  ),
);

it.effect('does not serve an old client after a same-path replacement', () =>
  fixture(path =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const replacement = `${path}.replacement`;
      yield* useRecallDatabase(
        replacement,
        Effect.flatMap(SqlClient.SqlClient, sql => sql.unsafe('CREATE TABLE replacement (id TEXT)')),
      );
      yield* withRecallDatabaseSession(
        Effect.gen(function* () {
          yield* useRecallDatabase(path, mark);
          expect(yield* useRecallDatabase(path, marker)).toBe(true);
          yield* fs.rename(path, `${path}.old`);
          yield* fs.rename(replacement, path);
          expect(yield* useRecallDatabase(path, marker)).toBe(false);
          const rows = yield* useRecallDatabase(
            path,
            Effect.flatMap(SqlClient.SqlClient, sql =>
              sql.unsafe<{name: string}>("SELECT name FROM sqlite_master WHERE name = 'replacement'"),
            ),
          );
          expect(rows).toHaveLength(1);
        }),
      );
    }),
  ),
);

it.effect('falls back to fresh scopes if a database, auxiliary or directory admission probe is denied', () =>
  fixture(path =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const denied of [path, `${path}-wal`, `${path}-shm`, 'directory']) {
        let refusals = 0;
        const restricted = FileSystem.make({
          ...fs,
          access: (value, options) => {
            if (denied === 'directory') {
              refusals++;
              return fs.access(`${path}.missing`, options);
            }
            return fs.access(value, options);
          },
          open: (value, options) => {
            if (value === denied) {
              refusals++;
              return fs.open(`${path}.missing`, {flag: 'r'});
            }
            return fs.open(value, options);
          },
        });
        yield* withRecallDatabaseSession(
          Effect.gen(function* () {
            yield* useRecallDatabase(path, mark);
            expect(
              yield* useRecallDatabase(path, marker).pipe(Effect.provideService(FileSystem.FileSystem, restricted)),
            ).toBe(false);
            expect(refusals).toBeGreaterThan(0);
            expect(yield* useRecallDatabase(path, marker)).toBe(false);
          }),
        );
      }
    }),
  ),
);

it.effect('propagates close defects and revokes the token before closing', () =>
  fixture(path =>
    Effect.gen(function* () {
      const original = Database.prototype.close;
      let inherited: Context.Context<never> | undefined;
      const close = vi.spyOn(Database.prototype, 'close').mockImplementationOnce(function (this: Database, ...args) {
        original.apply(this, args);
        throw new Error('session close defect');
      });
      yield* Effect.gen(function* () {
        const exit = yield* withRecallDatabaseSession(
          Effect.gen(function* () {
            inherited = yield* Effect.context<never>();
            yield* useRecallDatabase(path, mark);
          }),
        ).pipe(Effect.exit);
        expect(exit._tag).toBe('Failure');
        if (!inherited) throw new Error('Missing captured session context');
        expect(yield* useRecallDatabase(path, marker).pipe(Effect.provide(inherited))).toBe(false);
        expect(close).toHaveBeenCalledTimes(2);
      }).pipe(Effect.ensuring(Effect.sync(() => close.mockRestore())));
    }),
  ),
);

it.effect('evicts an interrupted admission probe and retains a query failure alongside a close defect', () =>
  fixture(path =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* withRecallDatabaseSession(
        Effect.gen(function* () {
          yield* useRecallDatabase(path, mark);
          const interrupted = FileSystem.make({...fs, access: () => Effect.interrupt});
          expect(
            (yield* useRecallDatabase(path, marker).pipe(
              Effect.provideService(FileSystem.FileSystem, interrupted),
              Effect.exit,
            ))._tag,
          ).toBe('Failure');
          expect(yield* useRecallDatabase(path, marker)).toBe(false);
          const original = Database.prototype.close;
          const close = vi.spyOn(Database.prototype, 'close').mockImplementationOnce(function (
            this: Database,
            ...args
          ) {
            original.apply(this, args);
            throw new Error('query close defect');
          });
          yield* Effect.gen(function* () {
            const exit = yield* useRecallDatabase(path, Effect.fail('original query failure')).pipe(Effect.exit);
            expect(exit._tag).toBe('Failure');
            if (exit._tag === 'Failure') {
              const message = Cause.pretty(exit.cause);
              expect(message).toContain('original query failure');
              expect(message).toContain('query close defect');
            }
            expect(yield* useRecallDatabase(path, marker)).toBe(false);
          }).pipe(Effect.ensuring(Effect.sync(() => close.mockRestore())));
        }),
      );
    }),
  ),
);

if (process.platform !== 'win32') {
  it.effect('evicts when database write permission is revoked before a query', () =>
    fixture(path =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* withRecallDatabaseSession(
          Effect.gen(function* () {
            yield* useRecallDatabase(path, mark);
            yield* fs.chmod(path, 0o400);
            const exit = yield* useRecallDatabase(path, marker).pipe(Effect.exit);
            const fresh = yield* useRecallDatabase(path, marker, false).pipe(Effect.exit);
            expect(exit._tag).toBe(fresh._tag);
            // SQLite can admit a read-only fallback even with readwrite requested.
            // Match that fresh behavior, but never serve the old writable handle.
            if (exit._tag === 'Success') expect(exit.value).toBe(false);
            yield* fs.chmod(path, 0o600);
            expect(yield* useRecallDatabase(path, marker)).toBe(false);
          }),
        ).pipe(Effect.ensuring(fs.chmod(path, 0o600).pipe(Effect.orDie)));
      }),
    ),
  );
}
