import {Array as EffectArray, Option as EffectOption} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, Exit, Layer} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {selectEdgesByIds, selectTraversalEdgesForNodes} from '@threadnote/graph/store/queries';

const span = JSON.stringify({column: 1, endColumn: 2, endLine: 1, line: 1});
const databaseLayer = SqliteClient.layer({filename: ':memory:'});
function withDatabase<A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) {
  return Effect.gen(function* () {
    const context = yield* Layer.build(databaseLayer);
    return yield* program.pipe(Effect.provideContext(context));
  });
}

const seedDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`CREATE TABLE snapshots (id TEXT PRIMARY KEY, state TEXT, base_snapshot_id TEXT)`);
  yield* sql.unsafe(`INSERT INTO snapshots VALUES ('base', 'ready', NULL), ('overlay', 'ready', 'base')`);
  yield* sql.unsafe(`CREATE TABLE edges (
    snapshot_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT, source_name TEXT NOT NULL,
    relation TEXT NOT NULL, target_id TEXT, target_name TEXT NOT NULL,
    provenance TEXT NOT NULL, confidence REAL NOT NULL, evidence_path TEXT NOT NULL,
    evidence_span_json TEXT NOT NULL, PRIMARY KEY (snapshot_id, id)
  ) WITHOUT ROWID`);
  yield* sql.unsafe(`CREATE INDEX edges_source ON edges (snapshot_id, source_id, relation)`);
  yield* sql.unsafe(`CREATE INDEX edges_target_resolved ON edges (snapshot_id, target_id, relation)
    WHERE target_id IS NOT NULL`);
  yield* sql.unsafe(`CREATE TABLE snapshot_edge_deletions (
    snapshot_id TEXT NOT NULL, edge_id TEXT NOT NULL, PRIMARY KEY (snapshot_id, edge_id)
  ) WITHOUT ROWID`);
});

const insertEdge = Effect.fn('test.insertEdge')(function* (
  snapshot: string,
  id: string,
  evidencePath: string,
  evidenceSpan: string = span,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO edges VALUES (
    ${snapshot}, ${id}, 'source', 'source', 'calls', 'target', 'target', 'resolved', 1,
    ${evidencePath}, ${evidenceSpan}
  )`;
});

describe('selected graph edge hydration', () => {
  effectIt.effect('returns empty traversal admissions without looking up a snapshot', () =>
    Effect.gen(function* () {
      expect(yield* selectTraversalEdgesForNodes('missing', [], 'both', 10, ['resolved'])).toEqual([]);
      expect(yield* selectTraversalEdgesForNodes('missing', ['source'], 'both', 0, ['resolved'])).toEqual([]);
      expect(yield* selectTraversalEdgesForNodes('missing', ['source'], 'both', 10, [])).toEqual([]);
    }).pipe(withDatabase),
  );

  effectIt.effect('hydrates every unique requested ID in order across bounded SQL batches', () =>
    Effect.gen(function* () {
      yield* seedDatabase;
      const ids = Array.from({length: 405}, (_, index) => `edge-${index}`);
      for (const id of ids) yield* insertEdge('base', id, 'src/base.ts');
      yield* insertEdge('overlay', ids[402], 'src/override.ts');
      const requested = [...ids].reverse();
      const edges = yield* selectEdgesByIds('overlay', [...requested, requested[0]]);
      expect(EffectArray.map(edges, edge => edge.id)).toEqual(requested);
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(edges, edge => edge.id === ids[402]))?.evidencePath,
      ).toBe('src/override.ts');
      expect(EffectArray.every(edges, edge => edge.evidenceSpan.line === 1)).toBe(true);
    }).pipe(withDatabase),
  );

  effectIt.effect('fails closed for deleted or absent selected evidence', () =>
    Effect.gen(function* () {
      yield* seedDatabase;
      yield* insertEdge('base', 'deleted', 'src/base.ts');
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO snapshot_edge_deletions VALUES ('overlay', 'deleted')`;
      for (const id of ['deleted', 'missing']) {
        const result = yield* Effect.exit(selectEdgesByIds('overlay', [id]));
        expect(Exit.isFailure(result)).toBe(true);
      }
      expect(yield* selectEdgesByIds('overlay', [])).toEqual([]);
    }).pipe(withDatabase),
  );

  effectIt.effect('does not decode evidence during traversal and rejects corrupt selected evidence', () =>
    Effect.gen(function* () {
      yield* seedDatabase;
      yield* insertEdge('base', 'edge', 'src/base.ts', 'invalid span');
      const projected = yield* selectTraversalEdgesForNodes('overlay', ['source'], 'outgoing', 10, ['resolved']);
      expect(projected).toEqual([
        {id: 'edge', sourceId: 'source', targetId: 'target', relation: 'calls', provenance: 'resolved', confidence: 1},
      ]);
      const hydrated = yield* Effect.exit(selectEdgesByIds('overlay', ['edge']));
      expect(Exit.isFailure(hydrated)).toBe(true);
    }).pipe(withDatabase),
  );
});
