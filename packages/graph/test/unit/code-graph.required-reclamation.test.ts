import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {initializeSchema} from '@threadnote/graph/store/schema/initialization';
import {useDatabaseDirect} from '@threadnote/graph/store/session';
import {makeRetiredSnapshotReclamationPage} from '@threadnote/graph/store/staging_core';

const TARGET = 'retired-target';

describe('required snapshot reclamation pages', () => {
  effectIt.effect('pages multiple large targets without sorting their remaining payload', () =>
    withRows(0, sql =>
      Effect.gen(function* () {
        const targets = ['earlier-a', 'earlier-b', TARGET];
        for (const id of targets) {
          if (id !== TARGET) yield* cloneSnapshot(sql, id);
          yield* insertCandidates(sql, id, 30_001);
        }
        const {observedSql, statements} = observeCandidateDeletes(sql);
        const reclaim = makeRetiredSnapshotReclamationPage(observedSql, targets);
        expect((yield* reclaim).rowsDeleted).toBe(5_000);
        yield* assertIndexedPages(sql, statements);
        expect(statements).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect('keeps every snapshot-owned table page indexed across multiple targets', () =>
    withRows(0, sql =>
      Effect.gen(function* () {
        yield* cloneSnapshot(sql, 'earlier-a');
        yield* cloneSnapshot(sql, 'earlier-b');
        const {observedSql, statements} = observeCandidateDeletes(sql);
        yield* makeRetiredSnapshotReclamationPage(observedSql, [TARGET, 'earlier-a', 'earlier-b']);
        expect(statements.length).toBeGreaterThan(20);
        yield* assertIndexedPages(sql, statements);
      }),
    ),
  );

  fcEffectProp(
    effectIt,
    'skips newly leased targets and drains the same finite debt after restart in any target order',
    {
      rows: fc.tuple(fc.integer({min: 5_001, max: 8_001}), fc.nat({max: 8_001}), fc.nat({max: 8_001})),
      reverse: fc.boolean(),
    },
    ({rows, reverse}) =>
      withRows(0, sql =>
        Effect.gen(function* () {
          const targets = ['earlier-a', 'earlier-b', TARGET];
          for (const [index, id] of targets.entries()) {
            if (id !== TARGET) yield* cloneSnapshot(sql, id);
            yield* insertCandidates(sql, id, rows[index]);
          }
          const request = reverse ? [...targets].reverse() : targets;
          const reclaim = makeRetiredSnapshotReclamationPage(sql, request);
          expect((yield* reclaim).rowsDeleted).toBe(5_000);
          yield* sql.unsafe('INSERT INTO snapshot_leases (token, snapshot_id, expires_at) VALUES (?, ?, ?)', [
            'new-reader',
            targets[0],
            60_000,
          ]);
          const restarted = makeRetiredSnapshotReclamationPage(sql, [...request].reverse());
          let deleted = 5_000;
          for (;;) {
            const page = yield* restarted;
            deleted += page.rowsDeleted;
            expect(page.rowsDeleted).toBeLessThanOrEqual(20_000);
            const protectedRows = yield* sql.unsafe<{readonly count: number}>(
              'SELECT COUNT(*) AS count FROM building_reference_candidates WHERE snapshot_id = ?',
              [targets[0]],
            );
            expect(protectedRows[0].count).toBe(rows[0] - 5_000);
            if (page.complete) break;
          }
          expect(yield* sql.unsafe('SELECT id FROM snapshots')).toEqual([{id: targets[0]}]);
          yield* sql.unsafe('DELETE FROM snapshot_leases WHERE token = ?', ['new-reader']);
          const final = makeRetiredSnapshotReclamationPage(sql, request);
          for (;;) {
            const page = yield* final;
            deleted += page.rowsDeleted;
            if (page.complete) break;
          }
          expect(deleted).toBe(rows.reduce((sum, count) => sum + count, 0) + targets.length);
          expect(yield* final).toEqual({complete: true, rowsDeleted: 0});
          expect(yield* sql.unsafe('SELECT id FROM snapshots')).toEqual([]);
          expect(yield* sql.unsafe('PRAGMA foreign_key_check')).toEqual([]);
        }),
      ),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect('grows fast pages up to the existing table limit', () =>
    withRows(35_001, sql =>
      Effect.gen(function* () {
        const reclaim = makeRetiredSnapshotReclamationPage(sql, [TARGET]);
        const pages = [];
        for (;;) {
          const page = yield* reclaim;
          pages.push(page.rowsDeleted);
          if (page.complete) break;
        }
        expect(pages).toEqual([5_000, 10_000, 20_000, 1, 1]);
        expect(yield* sql.unsafe('PRAGMA foreign_key_check')).toEqual([]);
      }),
    ),
  );

  effectIt.effect('retains the smaller symbol cap while growing compact lexical pages', () =>
    withRows(0, sql =>
      Effect.gen(function* () {
        yield* sql.unsafe(
          `WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 15_001)
          INSERT INTO symbols (
            snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
            lookup_keys_json, exported, span_json
          ) SELECT ?, printf('symbol-%08d', n), 'hash', 'function', 'name', 'name', 'file.ts',
            'typescript', '[]', 0, '{}' FROM rows`,
          [TARGET],
        );
        yield* sql.unsafe('INSERT INTO lexical_compact_snapshots (snapshot_id) VALUES (?)', [TARGET]);
        yield* sql.unsafe(
          `WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 35_001)
          INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
          SELECT (SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ?), n, n, 1 FROM rows`,
          [TARGET],
        );
        const reclaim = makeRetiredSnapshotReclamationPage(sql, [TARGET]);
        const pages = [];
        for (;;) {
          const page = yield* reclaim;
          pages.push(page.rowsDeleted);
          if (page.complete) break;
        }
        expect(pages).toEqual([5_000, 10_000, 20_000, 1, 1, 2_000, 4_000, 5_000, 4_001, 1]);
        expect(yield* sql.unsafe('PRAGMA foreign_key_check')).toEqual([]);
      }),
    ),
  );

  effectIt.effect('keeps single-row metadata pages bounded below the adaptive minimum', () =>
    withRows(0, sql =>
      Effect.gen(function* () {
        for (const id of ['other-a', 'other-b']) {
          yield* cloneSnapshot(sql, id);
        }
        yield* sql.unsafe(`INSERT INTO building_lexical_counters (
          snapshot_id, completed_batch_count, posting_count, symbol_count, term_count
        ) SELECT id, 0, 0, 0, 0 FROM snapshots`);
        const reclaim = makeRetiredSnapshotReclamationPage(sql, [TARGET, 'other-a', 'other-b']);
        const pages = [];
        for (;;) {
          const page = yield* reclaim;
          pages.push(page.rowsDeleted);
          if (page.complete) break;
        }
        expect(pages).toEqual([1, 1, 1, 1, 1, 1]);
      }),
    ),
  );

  fcEffectProp(
    effectIt,
    'preserves a newly leased snapshot between pages and converges after restart',
    {rows: fc.integer({min: 5_001, max: 40_001})},
    ({rows}) =>
      withRows(rows, sql =>
        Effect.gen(function* () {
          const reclaim = makeRetiredSnapshotReclamationPage(sql, [TARGET]);
          expect((yield* reclaim).rowsDeleted).toBe(5_000);
          yield* sql.unsafe('INSERT INTO snapshot_leases (token, snapshot_id, expires_at) VALUES (?, ?, ?)', [
            'new-reader',
            TARGET,
            60_000,
          ]);
          expect(yield* reclaim).toEqual({complete: true, rowsDeleted: 0});
          const remaining = yield* sql.unsafe<{readonly count: number}>(
            'SELECT COUNT(*) AS count FROM snapshot_file_deletions WHERE snapshot_id = ?',
            [TARGET],
          );
          expect(remaining[0]?.count).toBe(rows - 5_000);
          yield* sql.unsafe('DELETE FROM snapshot_leases WHERE token = ?', ['new-reader']);

          const restarted = makeRetiredSnapshotReclamationPage(sql, [TARGET]);
          let reclaimed = 5_000;
          for (;;) {
            const page = yield* restarted;
            expect(page.rowsDeleted).toBeLessThanOrEqual(20_000);
            reclaimed += page.rowsDeleted;
            if (page.complete) break;
          }
          expect(reclaimed).toBe(rows + 1);
          expect(yield* restarted).toEqual({complete: true, rowsDeleted: 0});
          expect(yield* sql.unsafe('SELECT id FROM snapshots')).toEqual([]);
          expect(yield* sql.unsafe('PRAGMA foreign_key_check')).toEqual([]);
        }),
      ),
    {fastCheck: {numRuns: 12}},
  );
});

type ObservedStatement = {readonly text: string; readonly parameters: readonly unknown[]};

function observeCandidateDeletes(sql: SqlClient.SqlClient) {
  const statements: ObservedStatement[] = [];
  const observedSql = new Proxy(sql, {
    get(target, key, receiver) {
      if (key !== 'unsafe') return Reflect.get(target, key, receiver);
      return (text: string, parameters: readonly unknown[] = []) => {
        if (text.startsWith('DELETE FROM') && text.includes(' AS candidate')) statements.push({text, parameters});
        return sql.unsafe(text, parameters);
      };
    },
  });
  return {observedSql, statements};
}

function assertIndexedPages(sql: SqlClient.SqlClient, statements: readonly ObservedStatement[]) {
  return Effect.gen(function* () {
    for (const statement of statements) {
      const plan = yield* sql.unsafe<{readonly detail: string}>(
        `EXPLAIN QUERY PLAN ${statement.text}`,
        statement.parameters,
      );
      expect(
        plan.some(row => row.detail.includes('TEMP B-TREE')),
        statement.text,
      ).toBe(false);
      expect(
        plan.some(row => row.detail.startsWith('SEARCH candidate ') && row.detail.includes('(snapshot_id=?)')),
        statement.text,
      ).toBe(true);
    }
  });
}

function cloneSnapshot(sql: SqlClient.SqlClient, id: string) {
  return sql.unsafe(
    `INSERT INTO snapshots (
      id, repository_id, worktree_id, commit_id, extractor_set, dirty, state,
      file_count, symbol_count, edge_count, started_at
    ) SELECT ?, repository_id, worktree_id, commit_id, extractor_set, dirty, state,
      file_count, symbol_count, edge_count, started_at FROM snapshots WHERE id = ?`,
    [id, TARGET],
  );
}

function insertCandidates(sql: SqlClient.SqlClient, id: string, rows: number) {
  if (rows === 0) return Effect.void;
  return sql.unsafe(
    `WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < ?)
    INSERT INTO building_reference_candidates (snapshot_id, edge_id, tier, lookup_key)
    SELECT ?, printf('edge-%08d', n), 0, printf('lookup-%08d', n) FROM rows`,
    [rows, id],
  );
}

function withRows<A, E, R>(rows: number, use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>) {
  return useDatabaseDirect(
    ':memory:',
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      yield* sql.unsafe(`INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
      VALUES ('repository', 'fixture', 'sha1', '', '')`);
      yield* sql.unsafe(
        `INSERT INTO snapshots (
      id, repository_id, worktree_id, commit_id, extractor_set, dirty, state,
      file_count, symbol_count, edge_count, started_at
    ) VALUES (?, 'repository', 'worktree', 'commit', 'extractor', 0, 'retired', 0, 0, 0, '')`,
        [TARGET],
      );
      if (rows > 0) {
        yield* sql.unsafe(
          `WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < ?)
        INSERT INTO snapshot_file_deletions (snapshot_id, path)
        SELECT ?, printf('file-%08d', n) FROM rows`,
          [rows, TARGET],
        );
      }
      return yield* use(sql);
    }),
  );
}
