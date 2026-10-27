import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import * as Statement from 'effect/sql/Statement';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {loadRecallIndexData, recallIndexDatabaseFilename, withRecallDatabaseSession} from '@threadnote/recall/index';
import {useRecallDatabase} from '../../src/index/database.js';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'recall-session-test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => ({...environment}),
        sanitizeExternal: environment => ({...environment}),
      }),
    ),
  ),
);
const base = Layer.mergeAll(
  BunServices.layer,
  system,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const dependencies = Layer.merge(base, ResourceStore.layer.pipe(Layer.provide(base)));
const provideServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(dependencies).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const memory = (text: string) => `MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_session_duplicate\n\n${text}`;

const coldFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-cold-schema-'});
  const config = {account: 'local', agentContextHome: home, user: 'me'};
  const store = yield* ResourceStore;
  const uri = 'threadnote://user/me/memories/durable/source.md';
  yield* store.write({account: config.account, home, user: config.user}, uri, memory('cold schema needle'), {
    mode: 'create',
  });
  const filename = recallIndexDatabaseFilename(false);
  return {
    fs,
    path,
    home,
    config,
    store,
    uri,
    database: path.join(home, 'indexes', 'lexical', filename),
    pointer: path.join(home, 'indexes', 'lexical', filename.replace(/\.sqlite$/, '.pointer.json')),
    lock: path.join(home, 'locks', 'indexes', 'lexical', `${filename}.lock`),
    load: loadRecallIndexData(config, {includeInactive: false}),
  };
});

const readDatabase = <A>(file: string, read: (database: Database) => A) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Database(file)),
    database => Effect.sync(() => read(database)),
    database => Effect.sync(() => database.close()),
  );
const nativeQuery = Database.prototype.query;
type NativeStatement = ReturnType<typeof nativeQuery>;
const observingQueries = <A, E, R>(
  observe: (database: Database, text: string, statement: NativeStatement) => NativeStatement | void,
  program: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(Database.prototype, 'query').mockImplementation(function (this: Database, text: string) {
        const statement = nativeQuery.call(this, text);
        return observe(this, text.trim().replace(/\s+/g, ' '), statement) ?? statement;
      }),
    ),
    () => program,
    spy => Effect.sync(() => spy.mockRestore()),
  );
const schemaObjects = (database: Database) => database.query('SELECT name FROM main.sqlite_schema ORDER BY name').all();
const isSchemaDdl = (text: string) => /^CREATE (?:TABLE|VIRTUAL TABLE|INDEX|TRIGGER) IF NOT EXISTS /u.test(text);

it.effect.each(['empty', 'partial', 'explicit-full'] as const)(
  'initializes %s schemas without changing the warm schema path',
  initial =>
    Effect.gen(function* () {
      const f = yield* coldFixture;
      const baseline = yield* Effect.scoped(
        Layer.build(SqliteClient.layer({filename: f.path.join(f.home, 'pristine.sqlite')})).pipe(
          Effect.flatMap(context =>
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return {
                journal: yield* sql.unsafe('PRAGMA journal_mode'),
                synchronous: yield* sql.unsafe<{synchronous: number}>('PRAGMA synchronous'),
              };
            }).pipe(Effect.provide(context)),
          ),
        ),
      );
      expect(baseline.journal).toEqual([{journal_mode: 'wal'}]);
      if (initial === 'partial') {
        yield* f.fs.makeDirectory(f.path.dirname(f.database), {recursive: true});
        yield* readDatabase(f.database, database => database.run('CREATE TABLE sentinel (value TEXT)'));
      }
      let phase = 'initial';
      const observed: {phase: string; text: string; transaction: boolean}[] = [];
      yield* observingQueries(
        (database, text) => {
          // Configure only this disposable test connection before application initialization.
          if (initial === 'explicit-full' && text === 'PRAGMA foreign_keys = ON')
            database.run('PRAGMA synchronous = FULL');
          observed.push({phase, text, transaction: database.inTransaction});
          if (text.startsWith('CREATE TABLE IF NOT EXISTS metadata')) {
            expect(nativeQuery.call(database, 'PRAGMA journal_mode').get()).toEqual({journal_mode: 'wal'});
            expect(nativeQuery.call(database, 'PRAGMA synchronous').get()).toEqual({
              synchronous: initial === 'explicit-full' ? 2 : baseline.synchronous[0]?.synchronous,
            });
            expect(nativeQuery.call(database, 'PRAGMA foreign_keys').get()).toEqual({foreign_keys: 1});
          }
        },
        Effect.gen(function* () {
          expect((yield* f.load).candidates[0]?.text).toContain('cold schema needle');
          const schema = yield* readDatabase(f.database, schemaObjects);
          expect(schema).toContainEqual({name: 'exact_search_data'});
          expect(schema).toContainEqual({name: 'memory_links_integrity_delete'});
          if (initial === 'partial') expect(schema).toContainEqual({name: 'sentinel'});
          phase = 'warm';
          expect((yield* f.load).candidates[0]?.text).toContain('cold schema needle');
          expect(yield* readDatabase(f.database, schemaObjects)).toEqual(schema);
          yield* readDatabase(f.database, database => {
            expect(
              database.query("SELECT rowid FROM exact_search WHERE exact_search MATCH 'needle'").all(),
            ).toHaveLength(1);
            const before = database.query("SELECT value FROM metadata WHERE key = 'mutation_sequence'").get();
            database.run('UPDATE documents SET recorded_at = recorded_at');
            expect(database.query("SELECT value FROM metadata WHERE key = 'mutation_sequence'").get()).not.toEqual(
              before,
            );
          });
        }),
      );
      const initialDdl = observed.filter(row => row.phase === 'initial' && isSchemaDdl(row.text));
      expect(initialDdl).toHaveLength(37);
      expect(initialDdl.every(row => row.transaction === (initial !== 'partial'))).toBe(true);
      const bootstrap = observed.filter(
        row =>
          row.phase === 'initial' &&
          ((row.text.startsWith('INSERT INTO metadata') && row.text.endsWith('ON CONFLICT(key) DO NOTHING')) ||
            row.text.includes("WHERE key = 'schema_version'")),
      );
      expect(bootstrap).toHaveLength(3);
      expect(bootstrap.every(row => row.transaction === (initial !== 'partial'))).toBe(true);
      const warm = observed.filter(row => row.phase === 'warm');
      expect(warm.filter(row => isSchemaDdl(row.text))).toHaveLength(37);
      expect(warm.some(row => row.text === 'BEGIN IMMEDIATE')).toBe(false);
      expect(warm.filter(row => isSchemaDdl(row.text)).every(row => !row.transaction)).toBe(true);
      expect(observed.filter(row => row.text.startsWith('PRAGMA ')).every(row => !row.transaction)).toBe(true);
      expect(observed.some(row => row.text.includes("WHERE key = 'schema_version'") && row.phase === 'warm')).toBe(
        true,
      );
      expect(yield* f.fs.exists(f.lock)).toBe(false);
    }).pipe(TestClock.withLive, provideServices),
);

it.effect.each(['failure', 'interruption'] as const)('rolls back late schema %s including FTS and triggers', mode =>
  Effect.gen(function* () {
    const f = yield* coldFixture;
    const entered = yield* Deferred.make<void>();
    const transformer: Statement.Transformer = (statement, sql) =>
      Effect.gen(function* () {
        if (statement.compile()[0].includes('CREATE TRIGGER IF NOT EXISTS memory_links_integrity_delete')) {
          yield* Deferred.succeed(entered, undefined);
          if (mode === 'interruption') return yield* Effect.never;
          return sql.unsafe('SELECT * FROM missing_cold_schema_fixture');
        }
        return statement;
      });
    const first = yield* f.load.pipe(
      Effect.provideService(Statement.CurrentTransformer, transformer),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    const exit =
      mode === 'interruption'
        ? yield* Fiber.interrupt(first).pipe(Effect.andThen(Fiber.await(first)))
        : yield* Fiber.await(first);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(mode === 'interruption');
      if (mode === 'failure') expect(Cause.pretty(exit.cause)).toContain('missing_cold_schema_fixture');
    }
    expect(yield* readDatabase(f.database, schemaObjects)).toEqual([]);
    expect(yield* f.fs.exists(f.pointer)).toBe(false);
    expect(yield* f.fs.exists(f.lock)).toBe(false);
    expect((yield* f.load).candidates[0]?.text).toContain('cold schema needle');
  }).pipe(TestClock.withLive, provideServices),
);

it.effect.each(['before-commit', 'lost-response', 'failed-cleanup'] as const)(
  'preserves schema commit semantics for %s',
  mode =>
    Effect.gen(function* () {
      const f = yield* coldFixture;
      let injected = false;
      let rollbacks = 0;
      const exit = yield* observingQueries((_database, text, statement) => {
        if (text === 'ROLLBACK') {
          rollbacks++;
          if (mode === 'failed-cleanup') throw new Error('schema rollback cleanup failed');
        }
        if (text !== 'COMMIT' || injected) return;
        injected = true;
        if (mode !== 'lost-response') throw new Error('schema commit rejected before execution');
        return new Proxy(statement, {
          get(target, key) {
            if (key === 'all')
              return (...args: Parameters<typeof target.all>) => {
                target.all(...args);
                throw new Error('schema successful commit response lost');
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }, f.load).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(injected).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(mode === 'failed-cleanup');
        expect(Cause.hasFails(exit.cause)).toBe(mode !== 'failed-cleanup');
        expect(Cause.pretty(exit.cause)).toContain(mode === 'lost-response' ? 'response lost' : 'commit rejected');
        if (mode === 'failed-cleanup') expect(Cause.pretty(exit.cause)).toContain('rollback cleanup failed');
      }
      expect(rollbacks).toBe(mode === 'lost-response' ? 0 : 1);
      const schema = yield* readDatabase(f.database, schemaObjects);
      if (mode === 'lost-response') expect(schema).toContainEqual({name: 'memory_links_integrity_delete'});
      else expect(schema).toEqual([]);
      expect(yield* f.fs.exists(f.lock)).toBe(false);
      expect(yield* f.fs.exists(f.pointer)).toBe(false);
      expect((yield* f.load).candidates[0]?.text).toContain('cold schema needle');
    }).pipe(TestClock.withLive, provideServices),
);

it.effect.each(['full-client', 'already-open', 'interrupted-waiter'] as const)(
  'serializes cold schema with a concurrent %s caller',
  mode =>
    Effect.gen(function* () {
      const f = yield* coldFixture;
      const entered = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const start = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      let writer: Database | undefined;
      let preopened: Database | undefined;
      let begins = 0;
      const ddlClients = new Set<Database>();
      const fs = FileSystem.make({
        ...f.fs,
        writeFile: (path, text, options) =>
          f.fs
            .writeFile(path, text, options)
            .pipe(Effect.tapError(() => (path === f.lock ? Deferred.succeed(waiting, undefined) : Effect.void))),
      });
      const pause: Statement.Transformer = statement =>
        Effect.gen(function* () {
          if (statement.compile()[0].includes('CREATE TABLE IF NOT EXISTS metadata')) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(proceed);
          }
          return statement;
        });
      yield* observingQueries(
        (database, text) => {
          if (text === 'BEGIN IMMEDIATE') {
            writer ??= database;
            begins++;
          }
          if (text.includes("'preopened'")) preopened = database;
          if (isSchemaDdl(text)) ddlClients.add(database);
        },
        Effect.gen(function* () {
          if (mode === 'already-open') {
            yield* fs.makeDirectory(f.path.dirname(f.database), {recursive: true});
            yield* readDatabase(f.database, () => undefined);
          }
          const second = yield* withRecallDatabaseSession(
            Effect.gen(function* () {
              if (mode === 'already-open')
                yield* useRecallDatabase(
                  f.database,
                  Effect.flatMap(SqlClient.SqlClient, sql =>
                    sql.unsafe("SELECT name FROM main.sqlite_schema WHERE 'preopened' = 'preopened' LIMIT 1"),
                  ),
                );
              yield* Deferred.succeed(ready, undefined);
              yield* Deferred.await(start);
              return yield* f.load;
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(ready);
          const first = yield* f.load.pipe(
            Effect.provideService(Statement.CurrentTransformer, pause),
            Effect.forkChild,
          );
          yield* Deferred.await(entered);
          expect(writer?.inTransaction).toBe(true);
          const token = yield* fs.readFileString(f.lock);
          yield* Deferred.succeed(start, undefined);
          const contention = yield* Effect.raceFirst(
            Deferred.await(waiting).pipe(Effect.as('waiting')),
            Fiber.await(second).pipe(Effect.as('caller-ended-before-contention')),
          );
          expect(contention).toBe('waiting');
          expect(begins).toBe(1);
          if (mode === 'interrupted-waiter') {
            yield* Fiber.interrupt(second);
            expect(yield* fs.readFileString(f.lock)).toBe(token);
          }
          yield* Deferred.succeed(proceed, undefined);
          const result = yield* Fiber.join(first);
          expect(result.candidates[0]?.text).toContain('cold schema needle');
          if (mode !== 'interrupted-waiter') {
            const concurrent = yield* Fiber.join(second);
            expect(concurrent.candidates).toEqual(result.candidates);
          }
          if (mode === 'already-open') {
            if (!preopened) throw new Error('Expected the independently opened retained client.');
            expect(ddlClients.has(preopened)).toBe(true);
          }
          expect(yield* fs.exists(f.lock)).toBe(false);
          expect((yield* f.load).candidates).toEqual(result.candidates);
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      );
    }).pipe(TestClock.withLive, provideServices),
);

it.effect('rolls back a failed cold version assertion before publishing a guarded replacement', () =>
  Effect.gen(function* () {
    const f = yield* coldFixture;
    let changed = false;
    let publications = 0;
    const wrongVersion: Statement.Transformer = (statement, sql) => {
      if (!changed && statement.compile()[0].includes("WHERE key = 'schema_version'")) {
        changed = true;
        return Effect.succeed(sql.unsafe("SELECT 'schema_version' AS key, '2' AS value"));
      }
      return Effect.succeed(statement);
    };
    const fs = FileSystem.make({
      ...f.fs,
      rename: (from, to) =>
        Effect.gen(function* () {
          if (to === f.pointer) {
            publications++;
            expect(yield* readDatabase(f.database, schemaObjects)).toEqual([]);
          }
          yield* f.fs.rename(from, to);
        }),
    });
    const result = yield* f.load.pipe(
      Effect.provideService(Statement.CurrentTransformer, wrongVersion),
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    expect(result.candidates[0]?.text).toContain('cold schema needle');
    expect(changed).toBe(true);
    expect(publications).toBe(1);
    expect(yield* f.fs.exists(f.lock)).toBe(false);
  }).pipe(TestClock.withLive, provideServices),
);

it.effect('reuses the held index lock after a raced active pointer selects an empty database', () =>
  Effect.gen(function* () {
    const f = yield* coldFixture;
    yield* f.load;
    yield* readDatabase(f.database, database =>
      database.run("UPDATE metadata SET value = '2' WHERE key = 'schema_version'"),
    );
    const relative = 'generations/raced.sqlite';
    const target = f.path.join(f.home, 'indexes', 'lexical', relative);
    yield* f.fs.makeDirectory(f.path.dirname(target), {recursive: true});
    yield* readDatabase(target, () => undefined);
    const pointer = `${JSON.stringify({version: 1, database: relative})}\n`;
    let locks = 0;
    let publications = 0;
    const fs = FileSystem.make({
      ...f.fs,
      writeFile: (path, content, options) =>
        Effect.gen(function* () {
          if (path === f.lock && options?.flag === 'wx') {
            expect(++locks).toBe(1);
            yield* f.fs.writeFileString(f.pointer, pointer);
          }
          yield* f.fs.writeFile(path, content, options);
        }),
      rename: (from, to) =>
        Effect.gen(function* () {
          if (to === f.pointer) publications++;
          yield* f.fs.rename(from, to);
        }),
    });
    expect((yield* f.load.pipe(Effect.provideService(FileSystem.FileSystem, fs))).candidates[0]?.text).toContain(
      'cold schema needle',
    );
    expect(locks).toBe(1);
    expect(publications).toBe(0);
    expect(yield* f.fs.readFileString(f.pointer)).toBe(pointer);
    expect(yield* f.fs.exists(f.lock)).toBe(false);
    yield* readDatabase(target, database => {
      expect(database.query('PRAGMA journal_mode').get()).toEqual({journal_mode: 'wal'});
      expect(database.query("SELECT value FROM metadata WHERE key = 'initialized'").get()).toEqual({value: 'true'});
    });
    expect((yield* f.load).candidates[0]?.text).toContain('cold schema needle');
  }).pipe(TestClock.withLive, provideServices),
);

it.effect('observes canonical mutations and new identity conflicts within the same session', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-currentness-'});
    const config = {account: 'local', agentContextHome: home, user: 'me'};
    const location = {account: config.account, home, user: config.user};
    const store = yield* ResourceStore;
    const first = 'threadnote://user/me/memories/durable/first.md';
    const second = 'threadnote://user/me/memories/durable/second.md';
    yield* store.write(location, first, memory('original needle'), {mode: 'create'});
    // Establish the file before the scoped session, so the first session query
    // can prove its pre/post-open identity and retain the actual SQLite client.
    yield* loadRecallIndexData(config, {includeInactive: false});
    const close = vi.spyOn(Database.prototype, 'close');
    yield* withRecallDatabaseSession(
      Effect.gen(function* () {
        const initial = yield* loadRecallIndexData(config, {includeInactive: false});
        expect(initial.candidates).toHaveLength(1);
        expect(initial.candidates[0]?.identityConflict).not.toBe(true);
        yield* store.write(location, first, memory('changed canonical needle'), {mode: 'replace'});
        const changed = yield* loadRecallIndexData(config, {includeInactive: false});
        expect(changed.candidates[0]?.text).toContain('changed canonical needle');
        expect(changed.generation).not.toBe(initial.generation);
        yield* store.write(location, second, memory('conflicting needle'), {mode: 'create'});
        const conflict = yield* loadRecallIndexData(config, {includeInactive: false});
        expect(conflict.candidates).toHaveLength(2);
        expect(conflict.candidates.every(candidate => candidate.identityConflict)).toBe(true);
        expect(close).toHaveBeenCalledTimes(0);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => close.mockRestore())));
  }).pipe(TestClock.withLive, provideServices),
);

it.effect(
  'closes recovery replacements and removes auxiliaries before publishing the pointer, then resolves it again',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-recovery-session-'});
      const config = {account: 'local', agentContextHome: home, user: 'me'};
      const store = yield* ResourceStore;
      const uri = 'threadnote://user/me/memories/durable/source.md';
      yield* store.write({account: config.account, home, user: config.user}, uri, memory('recovery needle'), {
        mode: 'create',
      });
      yield* loadRecallIndexData(config, {includeInactive: false});
      const databasePath = paths.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
      const closes: string[] = [];
      const original = Database.prototype.close;
      const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database, ...args) {
        closes.push(this.filename);
        return original.apply(this, args);
      });
      let publications = 0;
      const observing = FileSystem.make({
        ...fs,
        rename: (source, target) =>
          Effect.gen(function* () {
            if (target.endsWith('.pointer.json')) {
              const pointer = yield* Schema.decodeUnknownEffect(Schema.Struct({database: Schema.String}))(
                JSON.parse(yield* fs.readFileString(source)),
              ).pipe(Effect.orDie);
              const replacement = paths.join(home, 'indexes', 'lexical', pointer.database);
              expect(closes).toContain(replacement);
              expect(yield* fs.exists(`${replacement}-wal`)).toBe(false);
              expect(yield* fs.exists(`${replacement}-shm`)).toBe(false);
              const journal = yield* Effect.sync(() => {
                const database = new Database(replacement, {readonly: true});
                try {
                  return database.query('PRAGMA journal_mode').get();
                } finally {
                  database.close();
                }
              });
              expect(journal).toEqual({journal_mode: 'delete'});
              publications++;
            }
            yield* fs.rename(source, target);
          }),
      });
      yield* withRecallDatabaseSession(
        Effect.gen(function* () {
          yield* loadRecallIndexData(config, {includeInactive: false});
          yield* useRecallDatabase(
            databasePath,
            Effect.flatMap(SqlClient.SqlClient, sql =>
              sql.unsafe("UPDATE metadata SET value = '2' WHERE key = 'schema_version'"),
            ),
          );
          const recovered = yield* loadRecallIndexData(config, {includeInactive: false});
          expect(recovered.candidates[0]?.text).toContain('recovery needle');
          expect(publications).toBe(1);
          // A corrupt old generation must not be reused after pointer publication.
          const next = yield* loadRecallIndexData(config, {includeInactive: false});
          expect(next.candidates[0]?.text).toContain('recovery needle');
          expect(publications).toBe(1);
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, observing),
        Effect.ensuring(Effect.sync(() => close.mockRestore())),
      );
    }).pipe(TestClock.withLive, provideServices),
);
