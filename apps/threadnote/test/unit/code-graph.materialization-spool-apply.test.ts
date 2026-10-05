import {provideTestLayer} from '../helpers/effect-layer.js';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES} from '@threadnote/graph/materialization/spool/apply_surfaces';
import {
  applyCodeGraphMaterializationSpoolSurfacePage,
  assertCodeGraphMaterializationSpoolApplyComplete,
  registerCodeGraphMaterializationSpoolApply,
} from '@threadnote/graph/store/materialization/spool_apply';

effectIt.effect('commits a main-database page and its exact apply cursor atomically', () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe('PRAGMA foreign_keys = ON');
    yield* sql.unsafe('CREATE TABLE snapshots (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL)');
    yield* sql.unsafe(`CREATE TABLE snapshot_build_owners (
        snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        owner_token TEXT NOT NULL
      ) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TABLE building_materialization_spool_surfaces (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        surface_index INTEGER NOT NULL,
        spool_identity TEXT NOT NULL,
        surface_name TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        next_page_index INTEGER NOT NULL,
        applied_row_count INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        PRIMARY KEY (snapshot_id, surface_index),
        UNIQUE (snapshot_id, surface_name)
      ) WITHOUT ROWID`);
    yield* sql.unsafe('CREATE TABLE applied_symbols (id INTEGER PRIMARY KEY NOT NULL)');
    yield* sql.unsafe("INSERT INTO snapshots (id, state) VALUES ('snapshot', 'building')");
    yield* sql.unsafe("INSERT INTO snapshot_build_owners (snapshot_id, owner_token) VALUES ('snapshot', 'owner')");
    const identity = 'a'.repeat(64);
    const plan = CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.map((surface, index) => ({
      name: surface.name,
      rowCount: index === 0 ? 3 : 0,
    }));
    const invalidIdentity = yield* registerCodeGraphMaterializationSpoolApply(
      sql,
      'snapshot',
      'owner',
      'invalid',
      plan,
    ).pipe(Effect.flip);
    expect(invalidIdentity.message).toContain('identity is invalid');
    expect(yield* registerCodeGraphMaterializationSpoolApply(sql, 'snapshot', 'owner', identity, plan)).toBe(
      'registered',
    );
    expect(yield* registerCodeGraphMaterializationSpoolApply(sql, 'snapshot', 'owner', identity, plan)).toBe('resumed');

    const mismatch = yield* applyCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', 'owner', identity, 0, () =>
      sql.unsafe('INSERT INTO applied_symbols (id) VALUES (1), (2)'),
    ).pipe(Effect.flip);
    expect(mismatch.message).toContain('lost 1 row');
    expect(yield* sql.unsafe('SELECT COUNT(*) AS count FROM applied_symbols')).toEqual([{count: 0}]);

    expect(
      yield* applyCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', 'owner', identity, 0, () =>
        sql.unsafe('INSERT INTO applied_symbols (id) VALUES (1), (2), (3)'),
      ),
    ).toMatchObject({afterRowid: 0, rowCount: 3, state: 'applied', surfaceIndex: 0, surfaceName: 'symbols'});
    let replayWriterCalled = false;
    expect(
      yield* applyCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', 'owner', identity, 0, () =>
        Effect.sync(() => {
          replayWriterCalled = true;
        }),
      ),
    ).toMatchObject({rowCount: 3, state: 'complete'});
    expect(replayWriterCalled).toBe(false);
    yield* assertCodeGraphMaterializationSpoolApplyComplete(sql, 'snapshot', 'owner', identity);
  }).pipe(
    provideTestLayer(
      SqliteClient.layer({
        disableWAL: true,
        filename: ':memory:',
      }),
    ),
  ),
);
