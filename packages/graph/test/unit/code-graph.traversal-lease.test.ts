import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {prepareSnapshotPromotionCapacity} from '../../src/store/build/preparation.js';
import {retireReadySnapshotsIfUnused} from '../../src/store/cleanup_core.js';
import {acquireSnapshotLease, releaseSnapshotLease} from '../../src/store/leases.js';
import {selectEdgesByIds, selectTraversalEdgesForNodes} from '../../src/store/queries.js';
import {promoteSnapshot} from '../../src/store/resolution.js';
import {initializeSchema} from '../../src/store/schema/initialization.js';
import {pruneRetiredSnapshotRowsPage} from '../../src/store/view_cleanup.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, type RepositoryIdentity} from '../../src/types.js';

const base = `cgsn_${'1'.repeat(40)}`;
const selected = `cgsn_${'2'.repeat(40)}`;
const replacement = `cgsn_${'3'.repeat(40)}`;
const span = {column: 1, endColumn: 2, endLine: 1, line: 1};

effectIt.layer(BunServices.layer)(it => {
  it.effect('keeps selected overlay and impact-base evidence through promotion and leased cleanup', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-traversal-lease-'});
      const identity: RepositoryIdentity = {
        caseMode: 'sensitive',
        checkoutId: 'a'.repeat(64),
        displayName: 'traversal-lease-fixture',
        gitCommonDirectory: root,
        headCommit: '1'.repeat(40),
        objectFormat: 'sha1',
        repoRoot: root,
        repositoryId: 'b'.repeat(64),
        worktreeId: 'c'.repeat(64),
      };
      const database = yield* Layer.build(SqliteClient.layer({filename: path.join(root, 'graph.sqlite')}));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* initializeSchema(sql);
        yield* sql`INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
        VALUES (${identity.repositoryId}, 'fixture', 'sha1', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
        for (const id of [base, selected, replacement]) {
          yield* sql`INSERT INTO snapshots (
          id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
          extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
          edge_count, started_at, completed_at
        ) VALUES (
          ${id}, ${identity.repositoryId}, ${identity.worktreeId}, ${identity.headCommit}, ${id},
          ${id === selected ? base : null}, 'fixture', ${id === base ? 0 : 1}, ${id === base ? null : id},
          'ready', 0, 0, 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
        )`;
          yield* sql`INSERT INTO snapshot_extractor_generations (snapshot_id, generation)
          VALUES (${id}, ${CODE_GRAPH_EXTRACTOR_GENERATION})`;
        }
        yield* insertEdge(base, 'first', 'start', 'middle', 'src/base.ts');
        yield* insertEdge(base, 'second', 'middle', 'target', 'src/base-second.ts');
        yield* insertEdge(selected, 'second', 'middle', 'target', 'src/selected.ts');
        yield* insertEdge(base, 'removed', 'survivor', 'deleted-symbol', 'src/deleted.ts');
        yield* sql`INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id) VALUES (${selected}, 'removed')`;
        yield* insertEdge(replacement, 'first', 'start', 'middle', 'src/replacement-first.ts');
        yield* insertEdge(replacement, 'second', 'middle', 'target', 'src/replacement-second.ts');
        yield* promoteSnapshot(identity, selected, yield* prepareSnapshotPromotionCapacity(identity, selected));

        yield* Effect.acquireUseRelease(
          acquireSnapshotLease(base, 60_000, 'base-reader', false),
          () =>
            Effect.gen(function* () {
              yield* Effect.acquireUseRelease(
                acquireSnapshotLease(selected, 60_000, 'selected-reader', false),
                () =>
                  Effect.gen(function* () {
                    const first = yield* selectTraversalEdgesForNodes(selected, ['start'], 'outgoing', 10, [
                      'resolved',
                    ]);
                    const second = yield* selectTraversalEdgesForNodes(selected, ['middle'], 'outgoing', 10, [
                      'resolved',
                    ]);
                    const recovery = yield* selectTraversalEdgesForNodes(base, ['deleted-symbol'], 'incoming', 10, [
                      'resolved',
                    ]);
                    const pathIds = [...first, ...second].map(edge => edge.id);
                    expect(pathIds).toEqual(['first', 'second']);
                    expect(recovery.map(edge => edge.id)).toEqual(['removed']);

                    yield* promoteSnapshot(
                      identity,
                      replacement,
                      yield* prepareSnapshotPromotionCapacity(identity, replacement),
                    );
                    expect(
                      yield* retireReadySnapshotsIfUnused(sql, [selected, base], yield* Clock.currentTimeMillis),
                    ).toBe(0);
                    expect(yield* pruneRetiredSnapshotRowsPage(sql)).toEqual({deleted: 0, remaining: false});
                    expect(
                      yield* sql`SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ${identity.worktreeId}`,
                    ).toEqual([{snapshot_id: replacement}]);
                    expect(
                      (yield* selectEdgesByIds(selected, pathIds)).map(edge => [
                        edge.id,
                        edge.evidencePath,
                        edge.evidenceSpan,
                      ]),
                    ).toEqual([
                      ['first', 'src/base.ts', span],
                      ['second', 'src/selected.ts', span],
                    ]);
                    expect(
                      (yield* selectEdgesByIds(
                        base,
                        recovery.map(edge => edge.id),
                      )).map(edge => edge.evidencePath),
                    ).toEqual(['src/deleted.ts']);
                    expect(
                      yield* selectTraversalEdgesForNodes(selected, ['deleted-symbol'], 'incoming', 10, ['resolved']),
                    ).toEqual([]);
                    expect((yield* selectEdgesByIds(replacement, pathIds)).map(edge => edge.evidencePath)).toEqual([
                      'src/replacement-first.ts',
                      'src/replacement-second.ts',
                    ]);
                  }),
                token => releaseSnapshotLease(token).pipe(Effect.orDie),
              );
              yield* drainRetiredSnapshot(selected);
              expect(yield* sql`SELECT id FROM snapshots WHERE id = ${selected}`).toEqual([]);
              expect(yield* sql`SELECT id FROM edges WHERE snapshot_id = ${selected}`).toEqual([]);
              expect(yield* retireReadySnapshotsIfUnused(sql, [base], yield* Clock.currentTimeMillis)).toBe(0);
              expect((yield* selectEdgesByIds(base, ['removed']))[0]?.evidencePath).toBe('src/deleted.ts');
            }),
          token => releaseSnapshotLease(token).pipe(Effect.orDie),
        );

        expect(yield* retireReadySnapshotsIfUnused(sql, [base], yield* Clock.currentTimeMillis)).toBe(1);
        yield* drainRetiredSnapshot(base);
        expect(yield* sql`SELECT id FROM snapshots WHERE id IN (${base}, ${selected})`).toEqual([]);
        expect(yield* sql`SELECT id FROM edges WHERE snapshot_id IN (${base}, ${selected})`).toEqual([]);
        expect(yield* sql`SELECT token FROM snapshot_leases`).toEqual([]);
        expect(yield* sql`SELECT state FROM snapshots WHERE id = ${replacement}`).toEqual([{state: 'ready'}]);
        expect(yield* sql.unsafe('PRAGMA foreign_key_check')).toEqual([]);
      }).pipe(Effect.provide(database));
    }),
  );
});

const insertEdge = Effect.fn('test.insertLeasedEdge')(function* (
  snapshotId: string,
  id: string,
  sourceId: string,
  targetId: string,
  evidencePath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO edges (
    snapshot_id, id, source_id, source_name, relation, target_id, target_name,
    provenance, confidence, evidence_path, evidence_span_json
  ) VALUES (
    ${snapshotId}, ${id}, ${sourceId}, ${sourceId}, 'calls', ${targetId}, ${targetId},
    'resolved', 1, ${evidencePath}, ${JSON.stringify(span)}
  )`;
});

const drainRetiredSnapshot = Effect.fn('test.drainRetiredSnapshot')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  for (let page = 0; page < 10; page += 1) {
    if (!(yield* pruneRetiredSnapshotRowsPage(sql, snapshotId)).remaining) return;
  }
  expect.fail('Tiny retired snapshot fixture exceeded ten cleanup pages.');
});
