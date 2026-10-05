import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';
import {initializeSchema} from '@threadnote/graph/store/schema/initialization';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '@threadnote/graph/types';
import {CODE_GRAPH_SCHEMA_INITIALIZATION_CURRENT_CONTRACT_REVISION} from '@threadnote/graph/store/schema/revision';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from '@threadnote/graph/store/build/core';
import {
  CODE_GRAPH_SCOPE_QUERY_INDEX_DEFINITIONS,
  inspectCodeGraphQueryIndexes,
} from '@threadnote/graph/store/query/indexes';
import {selectRecentReadySnapshotsForRepository} from '@threadnote/graph/store/queries';
import {provideTestLayer} from '../helpers/effect-layer.js';

const repositoryId = 'a'.repeat(64);
const scopeId = `code-graph-scope:${'7'.padStart(64, '0')}`;
const layer = SqliteClient.layer({filename: ':memory:'});

describe('scope-aware graph snapshot query indexes', () => {
  effectIt.effect(
    'bounds hot predicates to a selected scope among 2000 sibling scopes and preserves recent ordering',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* initializeSchema(sql);
        yield* sql`INSERT INTO repositories VALUES (${repositoryId}, 'test', 'sha1', '2026-09-20', '2026-09-20')`;
        yield* sql.unsafe(
          `WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 20000)
        INSERT INTO snapshots (id, repository_id, worktree_id, scope_id, commit_id, graph_content_id, extractor_set, dirty,
          state, file_count, symbol_count, edge_count, started_at, completed_at)
        SELECT printf('cgsn_%040x', value), ?, ?, printf('code-graph-scope:%064x', value % 2000), printf('%040x', value % 5),
          printf('content-%d', value % 5), 'extractor', 0, 'ready', 0, 0, 0, '2026-09-20T00:00:00.000Z',
          printf('2026-09-20T00:00:%02d.000Z', value % 60) FROM sequence`,
          [repositoryId, 'b'.repeat(64)],
        );
        yield* sql.unsafe(
          `INSERT INTO lexical_storage_formats (snapshot_id, format_version, posting_count, symbol_count, term_count, created_at)
        SELECT id, ?, 0, 0, 0, '2026-09-20T00:00:00.000Z' FROM snapshots`,
          [CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION],
        );
        yield* sql.unsafe('ANALYZE');
        const recent = yield* selectRecentReadySnapshotsForRepository(repositoryId, scopeId);
        const expected = Array.from({length: 10}, (_, index) => 7 + 2000 * index)
          .sort((left, right) => (right % 60) - (left % 60) || left - right)
          .slice(0, 8)
          .map(value => `cgsn_${value.toString(16).padStart(40, '0')}`);
        expect(recent.map(snapshot => snapshot.id)).toEqual(expected);
        const queries = [
          {name: 'snapshots_scope_recent_ready', predicate: '', order: 'completed_at DESC, id'},
          {name: 'snapshots_scope_commit_ready', predicate: "AND commit_id = 'commit'", order: 'completed_at DESC, id'},
          {
            name: 'snapshots_scope_reusable',
            predicate: "AND base_snapshot_id IS NULL AND extractor_set = 'extractor'",
            order: 'completed_at DESC, id',
          },
          {
            name: 'snapshots_scope_reusable_content',
            predicate:
              "AND base_snapshot_id IS NULL AND graph_content_id = 'content-2' AND extractor_set = 'extractor'",
            order: 'completed_at DESC, id',
          },
          {
            name: 'snapshots_scope_reusable_commit',
            predicate: "AND base_snapshot_id IS NULL AND commit_id = 'commit'",
            order: 'completed_at DESC, id',
          },
        ];
        for (const query of queries) {
          const plan = yield* sql.unsafe<{readonly detail: string}>(
            `EXPLAIN QUERY PLAN SELECT * FROM snapshots
          WHERE repository_id = ? AND scope_id = ? AND state = 'ready' AND dirty = 0 ${query.predicate}
          ORDER BY ${query.order} LIMIT 8`,
            [repositoryId, scopeId],
          );
          expect(plan.map(row => row.detail).join('\n')).toContain(
            `USING INDEX ${query.name} (repository_id=? AND scope_id=?`,
          );
          expect(plan.some(row => row.detail.includes('USE TEMP B-TREE'))).toBe(false);
        }
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('upgrades a prior initialization receipt without retiring current scoped or full snapshots', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      yield* sql`INSERT INTO repositories VALUES (${repositoryId}, 'test', 'sha1', '2026-09-20', '2026-09-20')`;
      for (const [index, selectedScope] of ['full-repository', scopeId].entries()) {
        const id = `cgsn_${String(index).repeat(40)}`;
        yield* sql`INSERT INTO snapshots (id, repository_id, worktree_id, scope_id, commit_id, extractor_set, dirty,
          state, file_count, symbol_count, edge_count, started_at)
          VALUES (${id}, ${repositoryId}, ${'b'.repeat(64)}, ${selectedScope}, 'commit', 'extractor', 0, 'ready', 0, 0, 0, '2026-09-20T00:00:00.000Z')`;
        yield* sql`INSERT INTO snapshot_extractor_generations VALUES (${id}, ${CODE_GRAPH_EXTRACTOR_GENERATION})`;
        yield* sql`INSERT INTO active_snapshots VALUES (${'b'.repeat(64)}, ${selectedScope}, ${id}, '2026-09-20T00:00:00.000Z')`;
      }
      const authorityBefore = yield* sql.unsafe('SELECT * FROM active_snapshots ORDER BY scope_id');
      for (const definition of CODE_GRAPH_SCOPE_QUERY_INDEX_DEFINITIONS)
        yield* sql.unsafe(`DROP INDEX ${definition.name}`);
      yield* sql`UPDATE schema_initialization_receipt SET contract_revision = ${CODE_GRAPH_SCHEMA_INITIALIZATION_CURRENT_CONTRACT_REVISION - 1}`;
      yield* initializeSchema(sql);
      expect((yield* inspectCodeGraphQueryIndexes(sql, CODE_GRAPH_SCOPE_QUERY_INDEX_DEFINITIONS)).missing).toEqual([]);
      expect(yield* sql.unsafe('SELECT * FROM active_snapshots ORDER BY scope_id')).toEqual(authorityBefore);
      expect(yield* sql.unsafe("SELECT count(*) AS count FROM snapshots WHERE state = 'ready'")).toEqual([{count: 2}]);
      const before = yield* sql.unsafe('PRAGMA schema_version');
      yield* initializeSchema(sql);
      expect(yield* sql.unsafe('PRAGMA schema_version')).toEqual(before);
      yield* sql.unsafe('DROP INDEX snapshots_scope_reusable');
      yield* sql.unsafe('CREATE INDEX snapshots_scope_reusable ON snapshots(repository_id, completed_at)');
      const failure = yield* initializeSchema(sql).pipe(Effect.exit);
      expect(failure._tag).toBe('Failure');
      expect(String(failure)).toContain('query index schema is incompatible');
    }).pipe(provideTestLayer(layer)),
  );
});
