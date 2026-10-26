import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
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
