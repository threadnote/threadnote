import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, type ResolvedCodeGraphIndexScope} from '@threadnote/graph/index_scope';
import {initializeSchema} from '@threadnote/graph/store/schema/initialization';
import {selectActiveViewFence} from '@threadnote/graph/store/active_views';
import {legacyCodeGraphAuthorityStatements} from '@threadnote/graph/test/helpers/code-graph-legacy-authority';
import {removeActiveView} from '@threadnote/graph/store/view_cleanup';
import {
  recordScopeApplicability,
  selectScopeApplicability,
  selectSnapshotScopeReceipt,
} from '@threadnote/graph/store/scope/applicability';
import {
  claimRemovedViewCleanupCandidates,
  claimWorktreeReconciliationCandidates,
} from '@threadnote/graph/store/reconciliation';
import {migrateCodeGraphScopeAuthority} from '@threadnote/graph/store/scope/schema';
import {promoteSnapshot} from '@threadnote/graph/store/resolution';
import {prepareSnapshotPromotionCapacity} from '@threadnote/graph/store/build/preparation';
import {type RepositoryIdentity} from '@threadnote/graph/types';

const worktreeId = 'a'.repeat(64);
const repositoryId = 'b'.repeat(64);
const timestamp = '2026-09-20T00:00:00.000Z';
const snapshotId = (index: number) => `cgsn_${index.toString(16).padStart(40, '0')}`;
const identity: RepositoryIdentity = {
  repositoryId,
  worktreeId,
  checkoutId: repositoryId,
  repoRoot: '/fixture',
  gitCommonDirectory: '/fixture/.git',
  headCommit: 'commit',
  caseMode: 'sensitive',
  displayName: 'fixture',
  objectFormat: 'sha1',
};

const seedSnapshot = Effect.fn('test.seedScopedSnapshot')(function* (index: number, scopeId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
    VALUES (${repositoryId}, 'fixture', 'sha1', ${timestamp}, ${timestamp}) ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO snapshots (id, repository_id, worktree_id, commit_id, extractor_set, dirty,
    state, file_count, symbol_count, edge_count, started_at, scope_id)
    VALUES (${snapshotId(index)}, ${repositoryId}, ${worktreeId}, 'commit', 'extractor', 0,
      'ready', 0, 0, 0, ${timestamp}, ${scopeId})`;
  yield* sql`INSERT INTO snapshot_extractor_generations (snapshot_id, generation)
    SELECT ${snapshotId(index)}, CAST(value AS INTEGER) FROM schema_metadata WHERE key = 'minimum_extractor_generation'`;
});

describe('composite code graph scope authority', () => {
  effectIt.effect('rolls back interrupted composite-table migration and retries without losing authority', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      yield* seedSnapshot(1, CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY);
      yield* sql`INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
        VALUES (${worktreeId}, ${snapshotId(1)}, ${timestamp})`;
      for (const statement of legacyCodeGraphAuthorityStatements) yield* sql.unsafe(statement);
      const fault = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* migrateCodeGraphScopeAuthority(sql);
            return yield* Effect.fail('injected migration interruption');
          }),
        )
        .pipe(Effect.exit);
      expect(fault._tag).toBe('Failure');
      expect(yield* sql.unsafe("SELECT 1 FROM pragma_table_info('snapshots') WHERE name = 'scope_id'")).toEqual([]);
      expect(yield* sql`SELECT snapshot_id FROM active_snapshots`).toEqual([{snapshot_id: snapshotId(1)}]);
      yield* initializeSchema(sql);
      expect((yield* selectActiveViewFence(worktreeId))?.snapshotId).toBe(snapshotId(1));
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  effectIt.effect('refuses a newer persistent authority revision before schema mutation', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      yield* sql`UPDATE schema_metadata SET value = '19' WHERE key = 'persistent_extension_schema_revision'`;
      const before = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
      expect((yield* initializeSchema(sql).pipe(Effect.exit))._tag).toBe('Failure');
      expect(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`).toEqual(before);
      expect(yield* sql`SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'`).toEqual([
        {value: '19'},
      ]);
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  effectIt.effect('migrates exact r17 authority without rewriting ready facts or cleanup epochs', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      yield* seedSnapshot(1, CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY);
      yield* sql`INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
        VALUES (${worktreeId}, ${snapshotId(1)}, ${timestamp})`;
      yield* sql`INSERT INTO symbols (snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
        lookup_keys_json, exported, span_json)
        VALUES (${snapshotId(1)}, 'symbol', 'content', 'function', 'retained', 'retained', 'src/a.ts', 'typescript', '[]', 1, '{}')`;
      yield* sql`INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at)
        VALUES (${'d'.repeat(64)}, ${snapshotId(2)}, ${timestamp})`;
      yield* sql`INSERT INTO removed_view_cleanup (worktree_id, expected_snapshot_id, removed_at, epoch,
        phase, revision, attempts, next_attempt_at, updated_at)
        VALUES (${'d'.repeat(64)}, ${snapshotId(2)}, ${timestamp}, 1, 'vector-pointers', 7, 2, 0, ${timestamp})`;
      for (const statement of legacyCodeGraphAuthorityStatements) yield* sql.unsafe(statement);
      const factsBefore = yield* sql`SELECT * FROM symbols`;
      const rootPageBefore = yield* sql`SELECT rootpage FROM sqlite_master WHERE name = 'symbols'`;
      yield* initializeSchema(sql);
      expect(yield* sql`SELECT * FROM symbols`).toEqual(factsBefore);
      expect(yield* sql`SELECT rootpage FROM sqlite_master WHERE name = 'symbols'`).toEqual(rootPageBefore);
      expect((yield* selectActiveViewFence(worktreeId))?.snapshotId).toBe(snapshotId(1));
      expect(yield* sql`SELECT scope_id, state FROM snapshots`).toEqual([
        {scope_id: CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, state: 'ready'},
      ]);
      expect(yield* sql`SELECT scope_id, completeness FROM snapshot_scope_receipts`).toEqual([
        {scope_id: CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, completeness: 'legacy-full'},
      ]);
      expect(yield* sql`SELECT scope_id, epoch, revision, attempts FROM removed_view_cleanup`).toEqual([
        {scope_id: CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, epoch: 1, revision: 7, attempts: 2},
      ]);
      expect(yield* sql.unsafe('PRAGMA foreign_key_check')).toEqual([]);
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  effectIt.effect('keeps full and project pointers independent in one worktree', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      const scopes = [CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, `code-graph-scope:${'c'.repeat(64)}`];
      for (const [index, scopeId] of scopes.entries()) {
        yield* seedSnapshot(index, scopeId);
        yield* sql`INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
          VALUES (${worktreeId}, ${scopeId}, ${snapshotId(index)}, ${timestamp})`;
      }
      expect((yield* selectActiveViewFence(worktreeId))?.snapshotId).toBe(snapshotId(0));
      expect((yield* selectActiveViewFence(worktreeId, scopes[1]))?.snapshotId).toBe(snapshotId(1));
      yield* initializeSchema(sql);
      expect(yield* sql`SELECT scope_id FROM active_snapshots ORDER BY scope_id`).toHaveLength(2);
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  effectIt.effect('removes only one scope and reconciles sibling pointers and tombstones independently', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      const scopeId = `code-graph-scope:${'c'.repeat(64)}`;
      for (const [index, scope] of [CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, scopeId].entries()) {
        yield* seedSnapshot(index, scope);
        yield* sql`INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
          VALUES (${worktreeId}, ${scope}, ${snapshotId(index)}, ${timestamp})`;
      }
      const candidates = yield* claimWorktreeReconciliationCandidates(sql, 1);
      const next = yield* claimWorktreeReconciliationCandidates(sql, 1);
      expect([...candidates, ...next].map(row => row.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY).sort()).toEqual(
        [CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, scopeId].sort(),
      );
      const result = yield* removeActiveView(sql, worktreeId, snapshotId(1), false, undefined, scopeId);
      expect(result.state).toBe('removed');
      expect((yield* selectActiveViewFence(worktreeId))?.snapshotId).toBe(snapshotId(0));
      expect(yield* selectActiveViewFence(worktreeId, scopeId)).toBeUndefined();
      const cleanup = yield* claimRemovedViewCleanupCandidates(sql, Date.parse(timestamp), 2);
      expect(cleanup).toHaveLength(1);
      expect(cleanup[0]?.scopeId).toBe(scopeId);
      expect(yield* sql`SELECT scope_id FROM removed_views`).toEqual([{scope_id: scopeId}]);
      expect(yield* sql`SELECT scope_id FROM removed_view_cleanup`).toEqual([{scope_id: scopeId}]);
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  effectIt.effect('promotes one scope without displacing full or sibling graph pointers', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      const scopeId = `code-graph-scope:${'c'.repeat(64)}`;
      for (const [index, scope] of [CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, scopeId, scopeId].entries()) {
        yield* seedSnapshot(index, scope);
        if (index === 2) continue;
        yield* sql`INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
          VALUES (${worktreeId}, ${scope}, ${snapshotId(index)}, ${timestamp})`;
      }
      yield* promoteSnapshot(identity, snapshotId(2), yield* prepareSnapshotPromotionCapacity(identity, snapshotId(2)));
      expect((yield* selectActiveViewFence(worktreeId))?.snapshotId).toBe(snapshotId(0));
      expect((yield* selectActiveViewFence(worktreeId, scopeId))?.snapshotId).toBe(snapshotId(2));
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  effectIt.effect('binds observed applicability to the exact current pointer and rejects cross-scope replay', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      const scopeKey = `code-graph-scope:${'c'.repeat(64)}`;
      yield* seedSnapshot(1, scopeKey);
      yield* sql`INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
        VALUES (${worktreeId}, ${scopeKey}, ${snapshotId(1)}, ${timestamp})`;
      const evidence = {
        repositoryId,
        worktreeId,
        scopeKey,
        definitionDigest: 'definition',
        closureDigest: 'closure',
        inventoryFingerprint: 'inventory',
        extractorSet: 'extractor',
        policyFingerprint: 'policy',
        observedCommit: 'commit',
        catalogFingerprint: 'catalog',
      };
      yield* recordScopeApplicability(snapshotId(1), evidence);
      expect(yield* selectScopeApplicability(worktreeId, scopeKey)).toEqual({...evidence, snapshotId: snapshotId(1)});
      expect(yield* selectScopeApplicability(worktreeId)).toBeUndefined();
      const replay = yield* recordScopeApplicability(snapshotId(1), {
        ...evidence,
        scopeKey: CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
      }).pipe(Effect.exit);
      expect(replay._tag).toBe('Failure');
      yield* sql`DELETE FROM active_snapshots WHERE worktree_id = ${worktreeId} AND scope_id = ${scopeKey}`;
      expect(yield* selectScopeApplicability(worktreeId, scopeKey)).toBeUndefined();
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  effectIt.effect('round-trips bounded project membership as an order-independent receipt', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      const scopeKey = `code-graph-scope:${'c'.repeat(64)}`;
      yield* seedSnapshot(1, scopeKey);
      yield* sql`INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
        VALUES (${worktreeId}, ${scopeKey}, ${snapshotId(1)}, ${timestamp})`;
      const first = '1'.repeat(64);
      const last = 'f'.repeat(64);
      const definitionDigest = 'd'.repeat(64);
      const closureDigest = 'e'.repeat(64);
      const evidence = {
        repositoryId,
        worktreeId,
        scopeKey,
        definitionDigest,
        closureDigest,
        inventoryFingerprint: 'inventory',
        extractorSet: 'extractor',
        policyFingerprint: 'policy',
        observedCommit: 'commit',
        catalogFingerprint: 'catalog',
      };
      const scope = {
        admittedPrefixes: ['apps/a'],
        closureDigest,
        completeness: 'complete',
        controlPaths: [],
        definitionDigest,
        diagnostics: [],
        includedProjectIds: [last, first],
        rootProjectIds: [last],
        scopeKey,
      } satisfies ResolvedCodeGraphIndexScope;

      yield* recordScopeApplicability(snapshotId(1), evidence, scope);

      expect(yield* selectSnapshotScopeReceipt(snapshotId(1), scopeKey)).toMatchObject({
        includedProjectIds: [first, last],
        rootProjectIds: [last],
      });
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  effectIt.effect('rejects a scope receipt that exceeds the reader byte budget before writing authority', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeSchema(sql);
      const scopeKey = `code-graph-scope:${'c'.repeat(64)}`;
      yield* seedSnapshot(1, scopeKey);
      yield* sql`INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
        VALUES (${worktreeId}, ${scopeKey}, ${snapshotId(1)}, ${timestamp})`;
      const definitionDigest = 'd'.repeat(64);
      const closureDigest = 'e'.repeat(64);
      const includedProjectIds = Array.from(
        {length: 1_025},
        (_, index) => `${index.toString().padStart(6, '0')}${'x'.repeat(4_090)}`,
      );
      const attempt = yield* recordScopeApplicability(
        snapshotId(1),
        {
          repositoryId,
          worktreeId,
          scopeKey,
          definitionDigest,
          closureDigest,
          inventoryFingerprint: 'inventory',
          extractorSet: 'extractor',
          policyFingerprint: 'policy',
          observedCommit: 'commit',
          catalogFingerprint: 'catalog',
        },
        {
          admittedPrefixes: ['apps/a'],
          closureDigest,
          completeness: 'complete',
          controlPaths: [],
          definitionDigest,
          diagnostics: [],
          includedProjectIds,
          rootProjectIds: [includedProjectIds[0]],
          scopeKey,
        },
      ).pipe(Effect.exit);

      expect(attempt._tag).toBe('Failure');
      expect(yield* sql`SELECT 1 FROM scope_applicability`).toEqual([]);
      expect(yield* sql`SELECT 1 FROM snapshot_scope_receipts`).toEqual([]);
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  fcEffectProp(
    effectIt,
    'replacing one composite pointer never mutates sibling scopes',
    {scopeNumbers: fc.uniqueArray(fc.integer({min: 1, max: 99}), {minLength: 2, maxLength: 6})},
    ({scopeNumbers}) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* initializeSchema(sql);
        for (const value of scopeNumbers) {
          const scopeId = `code-graph-scope:${value.toString(16).padStart(64, '0')}`;
          yield* seedSnapshot(value, scopeId);
          yield* sql`INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
            VALUES (${worktreeId}, ${scopeId}, ${snapshotId(value)}, ${timestamp})`;
        }
        const before = yield* sql`SELECT * FROM active_snapshots ORDER BY scope_id`;
        const scopeId = `code-graph-scope:${(scopeNumbers[0] ?? 1).toString(16).padStart(64, '0')}`;
        yield* seedSnapshot(100, scopeId);
        yield* sql`INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
          VALUES (${worktreeId}, ${scopeId}, ${snapshotId(100)}, ${timestamp})
          ON CONFLICT(worktree_id, scope_id) DO UPDATE SET snapshot_id = excluded.snapshot_id`;
        const after = yield* sql`SELECT * FROM active_snapshots ORDER BY scope_id`;
        expect(after).toEqual(
          before.map(row => (row.scope_id === scopeId ? {...row, snapshot_id: snapshotId(100)} : row)),
        );
      }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
    {fastCheck: {numRuns: 12}},
  );
});
