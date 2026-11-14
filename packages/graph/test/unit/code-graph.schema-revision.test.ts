import * as EffectString from 'effect/String';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {hasCodeGraphEmbeddingDemand, enqueueCodeGraphEmbeddingDemandSql} from '@threadnote/graph/vector/demand';
import {CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL} from '@threadnote/graph/store/schema/contracts';
import {Array as EffectArray} from 'effect';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {dirname, join} from '@threadnote/testing/node-path';
import {fileURLToPath} from '@threadnote/testing/node-url';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_CORE_SCHEMA_VERSION,
  CODE_GRAPH_PERSISTENT_SCHEMA_CHECKPOINT_PREDECESSOR,
  CODE_GRAPH_PERSISTENT_SCHEMA_CITATION_PREDECESSOR,
  CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT,
  CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS,
  CODE_GRAPH_PROTOCOL_VERSIONS,
  CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION,
  codeGraphPersistentSchemaIsCurrent,
  codeGraphPersistentSchemaMigrationPending,
  codeGraphPersistentSchemaSupports,
  codeGraphRuntimeSchemaRequiresReconnect,
  observeCodeGraphPersistentSchemaRevision,
  planCodeGraphPersistentSchemaUpgrade,
} from '@threadnote/graph/store/schema/revision';

const graphSourceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../src');

const historicalProfiles = [
  [2, 'build-owner-plan', 'rebuild-extensions'],
  [3, 'reference-candidate', 'retire-legacy-references-and-rebuild'],
  [4, 'legacy-lexical', 'rebuild-extensions'],
  [5, 'compact-lexical', 'rebuild-extensions'],
  [6, 'content-shards', 'bridge-build-owner-instance'],
  [7, 'build-owner-instance', 'adopt-current-contract'],
  [8, 'removed-view-cleanup', 'adopt-current-contract'],
  [9, 'component-aggregates', 'adopt-current-contract'],
  [10, 'query-indexes', 'adopt-current-contract'],
  [11, 'evidence-cross-repository', 'adopt-current-contract'],
  [12, 'file-blob-authority', 'adopt-current-contract'],
  [13, 'inventory-reuse', 'rebuild-extensions'],
  [14, 'transient-spool', 'adopt-current-contract'],
  [15, 'sorted-spool-citation-predecessor', 'adopt-current-contract'],
  [16, 'citation-alias-checkpoint-predecessor', 'extend-checkpoint-import'],
  [17, 'checkpoint-import', 'extend-graph-scope-authority'],
  [18, 'graph-scope-authority', 'extend-embedding-demand'],
  [19, 'embedding-demand', 'extend-factored-lexical'],
  [20, 'factored-lexical', 'current'],
] as const;

describe('code graph schema revision entity', () => {
  it('pins every released persistent revision to its named upgrade route', () => {
    expect(
      EffectArray.map(CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS, value => [value.value, value.key, value.upgradeRoute]),
    ).toEqual(historicalProfiles);
    expect(CODE_GRAPH_PERSISTENT_SCHEMA_CITATION_PREDECESSOR.value).toBe(15);
    expect(CODE_GRAPH_PERSISTENT_SCHEMA_CHECKPOINT_PREDECESSOR.value).toBe(16);
    expect(CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT.value).toBe(20);
  });

  it('keeps storage, receipt, artifact, reuse, resolution, and Manager versions distinct', () => {
    expect(CODE_GRAPH_CORE_SCHEMA_VERSION).toBe(3);
    expect(CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION).toEqual({
      citationAliasPredecessor: 2,
      foldForwardPredecessor: 3,
      endpointIndexPredecessor: 4,
      current: 8,
    });
    expect(CODE_GRAPH_PROTOCOL_VERSIONS).toEqual({
      checkpointArtifact: 1,
      checkpointImport: 1,
      checkpointRecordSchema: 1,
      checkpointSemantic: 2,
      inventoryReuseReceipt: 2,
      managerCatalogRevision: 2,
      resolutionSurface: 1,
      reusableBaseReceipt: 2,
    });
  });

  it('preserves the deliberately non-arithmetic r13 and predecessor behavior', () => {
    expect(codeGraphPersistentSchemaSupports(12, 'direct-current-contract-adoption')).toBe(true);
    expect(codeGraphPersistentSchemaSupports(13, 'direct-current-contract-adoption')).toBe(false);
    expect(codeGraphPersistentSchemaSupports(14, 'direct-current-contract-adoption')).toBe(true);
    expect(codeGraphPersistentSchemaSupports(15, 'citation-released-predecessor-authority')).toBe(true);
    expect(codeGraphPersistentSchemaSupports(15, 'citation-column-predecessor-authority')).toBe(false);
    expect(codeGraphPersistentSchemaSupports(16, 'citation-column-predecessor-authority')).toBe(true);
  });

  it('round-trips every historical integer and canonical SQLite string through one profile', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS), profile => {
        expect(observeCodeGraphPersistentSchemaRevision(profile.value)).toEqual({profile, state: 'known'});
        expect(observeCodeGraphPersistentSchemaRevision(String(profile.value))).toEqual({profile, state: 'known'});
        expect(codeGraphPersistentSchemaIsCurrent(profile.value)).toBe(profile.key === 'factored-lexical');
        expect(codeGraphPersistentSchemaMigrationPending(profile.value)).toBe(
          profile.lifecycle === 'background-readable',
        );
        const plan = planCodeGraphPersistentSchemaUpgrade(profile.value);
        expect(plan.state).toBe(profile.key === 'factored-lexical' ? 'ready' : 'upgrade');
        if (plan.state !== 'ready' && plan.state !== 'upgrade')
          throw new Error('Historical revision plan unavailable.');
        expect(plan.route).toBe(profile.upgradeRoute);
      }),
      {numRuns: 64},
    );
  });

  it('classifies future observations monotonically without treating malformed values as newer', () => {
    fc.assert(
      fc.property(fc.integer({max: 1_000, min: 1}), increment => {
        const future = CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT.value + increment;
        expect(observeCodeGraphPersistentSchemaRevision(future)).toEqual({state: 'newer', value: future});
        expect(planCodeGraphPersistentSchemaUpgrade(future)).toEqual({state: 'reject-newer', value: future});
        expect(codeGraphRuntimeSchemaRequiresReconnect(CODE_GRAPH_CORE_SCHEMA_VERSION, future)).toBe(true);
      }),
      {numRuns: 64},
    );
    expect(observeCodeGraphPersistentSchemaRevision('016')).toEqual({state: 'invalid', value: '016'});
    expect(observeCodeGraphPersistentSchemaRevision(-1)).toEqual({state: 'invalid', value: -1});
    expect(codeGraphRuntimeSchemaRequiresReconnect(undefined, undefined)).toBe(false);
  });

  it('keeps semantic revision checks behind the revision entity', async () => {
    const governedFiles = [
      'maintenance.ts',
      'store/diagnostics.ts',
      'store/file_alias_schema.ts',
      'store/health.ts',
      'store/leases.ts',
      'store/maintenance_core.ts',
      'store/reconciliation.ts',
      'store/reconciliation/preparation.ts',
      'store/schema/core.ts',
      'store/schema/migration.ts',
      'store/schema/receipt.ts',
    ];
    const subject = String.raw`(?:recordedRevision|persistentExtensionSchemaRevision|revision\.value|receipt\.contract_revision|receipt\.persistent_extension_revision)`;
    const numericRevision = String.raw`(?:[2-9]|1[0-8])`;
    const leftComparison = new RegExp(String.raw`\b${subject}\s*(?:===|!==|<=|>=|<|>)\s*${numericRevision}\b`, 'u');
    const rightComparison = new RegExp(String.raw`\b${numericRevision}\s*(?:===|!==|<=|>=|<|>)\s*${subject}\b`, 'u');
    for (const file of governedFiles) {
      const source = await readFile(join(graphSourceRoot, file), 'utf8');
      expect(source, file).not.toMatch(leftComparison);
      expect(source, file).not.toMatch(rightComparison);
      expect(source, file).not.toMatch(/CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION\s*[+-]/u);
    }
  });
});

effectIt.layer(SqliteClient.layer({filename: ':memory:'}))(test => {
  test.effect(
    'retains known19/20 readonly demand capability while mutation requires current20 and future schemas refuse',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('CREATE TABLE schema_metadata(key TEXT PRIMARY KEY,value TEXT)');
        yield* sql.unsafe(CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL);
        yield* sql.unsafe('CREATE TABLE snapshots(id TEXT,scope_id TEXT,state TEXT)');
        yield* sql.unsafe(
          'CREATE TABLE active_snapshots(worktree_id TEXT,scope_id TEXT,snapshot_id TEXT,activated_at TEXT)',
        );
        yield* sql.unsafe('CREATE TABLE removed_views(worktree_id TEXT,scope_id TEXT,expected_snapshot_id TEXT)');
        const target = {
          worktreeId: EffectString.repeat(64)('a'),
          snapshotId: 'cgsn_' + EffectString.repeat(40)('b'),
          activatedAt: '2026-01-01T00:00:00.000Z',
        };
        yield* sql.unsafe("INSERT INTO snapshots VALUES(?,'full-repository','ready')", [target.snapshotId]);
        yield* sql.unsafe("INSERT INTO active_snapshots VALUES(?,'full-repository',?,?)", [
          target.worktreeId,
          target.snapshotId,
          target.activatedAt,
        ]);
        yield* sql.unsafe("INSERT INTO embedding_demand VALUES(?,'full-repository',?,?,'queued',0,0,NULL,NULL,NULL)", [
          target.worktreeId,
          target.snapshotId,
          target.activatedAt,
        ]);
        for (const revision of [19, 20, 21]) {
          yield* sql.unsafe("INSERT OR REPLACE INTO schema_metadata VALUES('persistent_extension_schema_revision',?)", [
            String(revision),
          ]);
          const before = yield* sql.unsafe('SELECT * FROM embedding_demand');
          if (revision <= 20) expect(yield* hasCodeGraphEmbeddingDemand(sql)).toBe(true);
          else expect((yield* hasCodeGraphEmbeddingDemand(sql).pipe(Effect.flip)).message).toContain('unsupported');
          expect(yield* sql.unsafe('SELECT * FROM embedding_demand')).toEqual(before);
          if (revision === 20) expect((yield* enqueueCodeGraphEmbeddingDemandSql(sql, target)).state).toBe('queued');
          else
            expect((yield* enqueueCodeGraphEmbeddingDemandSql(sql, target).pipe(Effect.flip)).message).toContain(
              revision === 19 ? 'requires write preparation' : 'unsupported',
            );
          expect(yield* sql.unsafe('SELECT * FROM embedding_demand')).toEqual(before);
        }
      }),
  );
});
