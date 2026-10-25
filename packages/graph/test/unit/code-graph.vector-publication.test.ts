import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {withCodeGraphDatabaseWriteLock} from '../../src/maintenance/gate.js';
import * as SqlClient from 'effect/sql/SqlClient';
import {expect} from 'vitest';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {SystemInfo} from '@threadnote/platform/system';
import {captureCodeGraphVectorPublication} from '../../src/vector/publication.js';
import {codeGraphLayout} from '../../src/layout.js';
import type {CodeGraphStoreShape} from '../../src/store.js';
import type {CodeGraphSnapshot} from '../../src/types.js';

const firstId = `cgsn_${'1'.repeat(40)}`;
const secondId = `cgsn_${'2'.repeat(40)}`;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-publication-fence-'});
  const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
  const context = yield* Layer.build(SqliteClient.layer({filename: ':memory:'}));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* sql.unsafe(
    'CREATE TABLE active_snapshots (worktree_id TEXT PRIMARY KEY, snapshot_id TEXT, activated_at TEXT)',
  );
  yield* sql.unsafe('INSERT INTO active_snapshots VALUES (?, ?, ?)', [
    layout.worktreeId,
    firstId,
    '2026-01-01T00:00:00.000Z',
  ]);
  let ready = true;
  const snapshot: CodeGraphSnapshot = {
    id: firstId,
    repositoryId: 'a'.repeat(64),
    worktreeId: layout.worktreeId,
    state: 'ready',
    dirty: false,
    commit: 'c'.repeat(40),
    extractorSet: 'test',
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
  };
  const store = {
    withSession: <A, E, R>(_path: string, program: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
      Effect.provide(program, context),
    readySnapshot: () => Effect.succeed(ready ? snapshot : undefined),
  } as unknown as CodeGraphStoreShape;
  const capture = captureCodeGraphVectorPublication({store, layout, threadnoteHome: home, snapshot});
  return {
    sql,
    capture,
    home,
    layout,
    purge: () => {
      ready = false;
    },
  };
});

const system = Layer.succeed(SystemInfo, {
  processId: process.pid,
  platform: process.platform,
  processStartIdentity: () => Effect.void,
  isProcessRunning: () => true,
} as never);
effectIt.layer(Layer.merge(BunServices.layer, system))(it => {
  it.effect('holds the actual graph writer gate through attachment commit', () =>
    Effect.gen(function* () {
      const {capture, home, layout} = yield* fixture;
      const publication = yield* capture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const attachment = yield* Effect.forkScoped(
        publication.attach(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
      );
      yield* Deferred.await(entered);
      let mutated = false;
      const mutation = withCodeGraphDatabaseWriteLock(
        home,
        layout.checkoutId,
        Effect.sync(() => {
          mutated = true;
        }),
        0,
      );
      expect((yield* mutation.pipe(Effect.result))._tag).toBe('Failure');
      expect(mutated).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(attachment);
      yield* mutation;
      expect(mutated).toBe(true);
    }).pipe(TestClock.withLive),
  );
  for (const change of ['new-snapshot', 'ABA', 'purge', 'model-switch'] as const) {
    it.effect(`rejects ${change} before committing a stale vector pointer`, () =>
      Effect.gen(function* () {
        const {sql, capture, home, purge} = yield* fixture;
        const publication = yield* capture;
        yield* publication.validate;
        if (change === 'purge') purge();
        else if (change === 'model-switch') {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(path.join(home, 'models'), {recursive: true});
          // Use the production selection contract, rather than a publication-local model flag.
          const catalogContext = yield* Layer.build(LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS));
          const catalog = Context.get(catalogContext, LocalModelCatalog);
          yield* selectLocalModel(home, catalog, 'embedding', 'bge-small-en-v1.5-q8');
        } else {
          yield* sql.unsafe('UPDATE active_snapshots SET snapshot_id = ?, activated_at = ?', [
            secondId,
            '2026-01-01T00:00:00.001Z',
          ]);
          if (change === 'ABA')
            yield* sql.unsafe('UPDATE active_snapshots SET snapshot_id = ?, activated_at = ?', [
              firstId,
              '2026-01-01T00:00:00.002Z',
            ]);
        }
        expect((yield* publication.validate.pipe(Effect.result))._tag).toBe('Failure');
        let committed = false;
        expect(
          (yield* publication
            .attach(
              Effect.sync(() => {
                committed = true;
              }),
            )
            .pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(committed).toBe(false);
      }),
    );
  }
});
