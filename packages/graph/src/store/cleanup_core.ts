import {Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {compareCodeUnits} from '../ordering.js';
import {
  type CodeGraphSnapshotPurgeGraphBlockerCode,
  type CodeGraphSnapshotPurgeGraphEvidence,
  type CodeGraphSnapshotPurgeLeaseEvidence,
  type CodeGraphSnapshotPurgeObservationResult,
} from './models.js';
import {MAXIMUM_CANONICAL_DATE_MILLISECONDS} from './removed/view_schema_contracts.js';
import {LEGACY_BUILDING_REFERENCES_V3_TABLE} from './schema/contracts.js';
import {tableExists} from './session.js';
import {CodeGraphStoreError} from '../types.js';
import {CODE_GRAPH_SNAPSHOT_ID} from './reconciliation/core.js';
import {type SnapshotRow} from './internal_models.js';
import {snapshotFromRow} from './rows.js';
import {lastStatementChangeCount, nextPersistentActivationBatchRows} from './activation/core.js';
import {type CodeGraphSqlQueryStatement} from './visualization_sql.js';
import {
  assertPersistentBuildOwner,
  type CodeGraphWriterGate,
  type CompactLexicalSnapshotKeyRow,
  validatedCompactLexicalCount,
} from './build/core.js';

const CODE_GRAPH_SNAPSHOT_PURGE_EVIDENCE_LIMIT = 1_024;

const validateSnapshotPurgeInput = Effect.fn('codeGraph.validateSnapshotPurgeInput')(function* (
  snapshotId: string,
  nowMilliseconds: number,
) {
  if (!CODE_GRAPH_SNAPSHOT_ID.test(snapshotId)) {
    return yield* CodeGraphStoreError.of('Code graph snapshot purge identity is invalid.');
  }
  if (
    !Number.isSafeInteger(nowMilliseconds) ||
    nowMilliseconds < 0 ||
    nowMilliseconds > MAXIMUM_CANONICAL_DATE_MILLISECONDS
  ) {
    return yield* CodeGraphStoreError.of('Code graph snapshot purge observation time is invalid.');
  }
});

const observeSnapshotPurge = Effect.fn('codeGraph.observeSnapshotPurge')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  nowMilliseconds: number,
) {
  yield* validateSnapshotPurgeInput(snapshotId, nowMilliseconds);
  const snapshots = yield* sql.unsafe<SnapshotRow>('SELECT * FROM snapshots WHERE id = ? LIMIT 2', [snapshotId]);
  if (snapshots.length === 0) {
    return {snapshotId, state: 'not-found'} satisfies CodeGraphSnapshotPurgeObservationResult;
  }
  if (snapshots.length !== 1) {
    return yield* CodeGraphStoreError.of('Code graph snapshot purge target is ambiguous.');
  }
  const snapshot = snapshotFromRow(snapshots[0]);
  const boundedLimit = CODE_GRAPH_SNAPSHOT_PURGE_EVIDENCE_LIMIT + 1;
  const [activeRows, childRows, leaseRows, ownerRows, cleanupRows] = yield* Effect.all(
    [
      sql.unsafe<{readonly worktree_id: unknown; readonly scope_id: string}>(
        `SELECT CASE
           WHEN typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
             AND worktree_id NOT GLOB '*[^0-9a-f]*'
           THEN worktree_id ELSE NULL END AS worktree_id, scope_id
         FROM active_snapshots WHERE snapshot_id = ? ORDER BY worktree_id LIMIT ?`,
        [snapshotId, boundedLimit],
      ),
      sql.unsafe<{readonly id: unknown}>(
        `SELECT CASE
           WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) BETWEEN 45 AND 67
           THEN id ELSE NULL END AS id
         FROM snapshots WHERE base_snapshot_id = ? ORDER BY id LIMIT ?`,
        [snapshotId, boundedLimit],
      ),
      sql.unsafe<{readonly expires_at: unknown; readonly token: unknown}>(
        `SELECT
           CASE WHEN typeof(token) = 'text' AND length(CAST(token AS BLOB)) BETWEEN 1 AND 4096
             AND instr(token, char(0)) = 0 THEN token ELSE NULL END AS token,
           CASE WHEN typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND ${MAXIMUM_CANONICAL_DATE_MILLISECONDS}
             THEN expires_at ELSE NULL END AS expires_at
         FROM snapshot_leases INDEXED BY snapshot_leases_snapshot_expiry
         WHERE snapshot_id = ? AND expires_at > ?
         ORDER BY expires_at, token LIMIT ?`,
        [snapshotId, nowMilliseconds, boundedLimit],
      ),
      sql.unsafe<{
        readonly build_id: unknown;
        readonly claimed_at: unknown;
        readonly logical_snapshot_id: unknown;
        readonly owner_token: unknown;
        readonly process_id: unknown;
        readonly process_start_identity: unknown;
      }>(
        `SELECT
           CASE WHEN typeof(owner.owner_token) = 'text'
                  AND length(CAST(owner.owner_token AS BLOB)) BETWEEN 1 AND 4096
                THEN owner.owner_token ELSE NULL END AS owner_token,
           CASE WHEN typeof(owner.claimed_at) = 'text'
                  AND length(CAST(owner.claimed_at AS BLOB)) BETWEEN 1 AND 64
                THEN owner.claimed_at ELSE NULL END AS claimed_at,
           CASE WHEN typeof(instance.build_id) = 'text'
                  AND length(CAST(instance.build_id AS BLOB)) BETWEEN 1 AND 1024
                THEN instance.build_id ELSE NULL END AS build_id,
           CASE WHEN typeof(instance.process_id) = 'integer' AND instance.process_id > 0
                THEN instance.process_id ELSE NULL END AS process_id,
           CASE WHEN instance.process_start_identity IS NULL THEN NULL
                WHEN typeof(instance.process_start_identity) = 'text'
                  AND length(CAST(instance.process_start_identity AS BLOB)) BETWEEN 1 AND 1024
                THEN instance.process_start_identity ELSE 0 END AS process_start_identity,
           CASE WHEN typeof(instance.logical_snapshot_id) = 'text'
                  AND length(CAST(instance.logical_snapshot_id AS BLOB)) BETWEEN 45 AND 67
                THEN instance.logical_snapshot_id ELSE NULL END AS logical_snapshot_id
         FROM snapshot_build_owners AS owner
         LEFT JOIN snapshot_build_owner_instances AS instance ON instance.snapshot_id = owner.snapshot_id
         WHERE owner.snapshot_id = ? LIMIT 2`,
        [snapshotId],
      ),
      sql.unsafe<{
        readonly epoch: unknown;
        readonly phase: unknown;
        readonly revision: unknown;
        readonly worktree_id: unknown;
      }>(
        `SELECT
           CASE WHEN typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
             AND worktree_id NOT GLOB '*[^0-9a-f]*' THEN worktree_id ELSE NULL END AS worktree_id,
           CASE WHEN typeof(epoch) = 'integer' AND epoch BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
             THEN epoch ELSE NULL END AS epoch,
           CASE WHEN typeof(revision) = 'integer' AND revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
             THEN revision ELSE NULL END AS revision,
           CASE WHEN typeof(phase) = 'text' AND phase IN ('vector-pointers', 'build-status', 'provenance', 'complete')
             THEN phase ELSE NULL END AS phase
         FROM removed_view_cleanup
         WHERE expected_snapshot_id = ? AND phase <> 'complete'
         ORDER BY worktree_id, epoch LIMIT ?`,
        [snapshotId, boundedLimit],
      ),
    ] as const,
    {concurrency: 1},
  );
  if (
    activeRows.length > CODE_GRAPH_SNAPSHOT_PURGE_EVIDENCE_LIMIT ||
    childRows.length > CODE_GRAPH_SNAPSHOT_PURGE_EVIDENCE_LIMIT ||
    leaseRows.length > CODE_GRAPH_SNAPSHOT_PURGE_EVIDENCE_LIMIT ||
    ownerRows.length > 1 ||
    cleanupRows.length > CODE_GRAPH_SNAPSHOT_PURGE_EVIDENCE_LIMIT
  ) {
    return yield* CodeGraphStoreError.of('Code graph snapshot purge evidence exceeded its bound.');
  }
  const activeViewIds: string[] = [];
  for (const row of activeRows) {
    if (typeof row.worktree_id !== 'string' || !/^[0-9a-f]{64}$/u.test(row.worktree_id)) {
      return yield* CodeGraphStoreError.of('Code graph snapshot purge evidence is invalid.');
    }
    activeViewIds.push(row.scope_id === 'full-repository' ? row.worktree_id : `${row.worktree_id}|${row.scope_id}`);
  }
  const childSnapshotIds: string[] = [];
  for (const row of childRows) {
    if (typeof row.id !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(row.id)) {
      return yield* CodeGraphStoreError.of('Code graph snapshot purge evidence is invalid.');
    }
    childSnapshotIds.push(row.id);
  }
  const liveLeases: CodeGraphSnapshotPurgeLeaseEvidence[] = [];
  for (const row of leaseRows) {
    if (typeof row.token !== 'string' || typeof row.expires_at !== 'number' || !Number.isSafeInteger(row.expires_at)) {
      return yield* CodeGraphStoreError.of('Code graph snapshot purge evidence is invalid.');
    }
    liveLeases.push({expiresAt: row.expires_at, identity: sha256HexSync(`snapshot-purge-lease\n${row.token}`)});
  }
  const buildOwnerIds: string[] = [];
  for (const row of ownerRows) {
    if (
      typeof row.owner_token !== 'string' ||
      typeof row.claimed_at !== 'string' ||
      (row.build_id !== null && typeof row.build_id !== 'string') ||
      (row.process_id !== null && !Number.isSafeInteger(row.process_id)) ||
      (row.process_start_identity !== null && typeof row.process_start_identity !== 'string') ||
      (row.logical_snapshot_id !== null && typeof row.logical_snapshot_id !== 'string')
    ) {
      return yield* CodeGraphStoreError.of('Code graph snapshot purge evidence is invalid.');
    }
    buildOwnerIds.push(
      sha256HexSync(
        `snapshot-purge-owner\n${JSON.stringify([
          row.owner_token,
          row.claimed_at,
          row.build_id,
          row.process_id,
          row.process_start_identity,
          row.logical_snapshot_id,
        ])}`,
      ),
    );
  }
  const cleanupEpochs: string[] = [];
  for (const row of cleanupRows) {
    if (
      typeof row.worktree_id !== 'string' ||
      !Number.isSafeInteger(row.epoch) ||
      !Number.isSafeInteger(row.revision) ||
      typeof row.phase !== 'string'
    ) {
      return yield* CodeGraphStoreError.of('Code graph snapshot purge evidence is invalid.');
    }
    cleanupEpochs.push(
      sha256HexSync(`snapshot-purge-cleanup\n${JSON.stringify([row.worktree_id, row.epoch, row.revision, row.phase])}`),
    );
  }
  const blockers: CodeGraphSnapshotPurgeGraphBlockerCode[] = [];
  if (activeViewIds.length > 0) blockers.push('active-view');
  if (snapshot.baseSnapshotId !== undefined) blockers.push('alias-snapshot');
  if (childSnapshotIds.length > 0) blockers.push('base-required');
  if (buildOwnerIds.length > 0) blockers.push('build-owned');
  if (cleanupEpochs.length > 0) blockers.push('cleanup-pending');
  if (liveLeases.length > 0) blockers.push('live-lease');
  if (snapshot.state !== 'ready' && snapshot.state !== 'retired') blockers.push('unsupported-state');
  blockers.sort(compareCodeUnits);
  const evidenceWithoutDigest = {
    activeViewIds: [...activeViewIds].sort(compareCodeUnits),
    blockers,
    buildOwnerIds: [...buildOwnerIds].sort(compareCodeUnits),
    childSnapshotIds: [...childSnapshotIds].sort(compareCodeUnits),
    cleanupEpochs: [...cleanupEpochs].sort(compareCodeUnits),
    liveLeases: [...liveLeases].sort(
      (left, right) => left.expiresAt - right.expiresAt || compareCodeUnits(left.identity, right.identity),
    ),
    snapshot,
  };
  const graphEvidenceDigest = sha256HexSync(
    `code-graph-snapshot-purge-graph-v1\n${JSON.stringify(snapshotPurgeGraphProjection(evidenceWithoutDigest))}`,
  );
  return {
    evidence: {...evidenceWithoutDigest, graphEvidenceDigest},
    snapshotId,
    state: 'observed',
  } satisfies CodeGraphSnapshotPurgeObservationResult;
});

function snapshotPurgeGraphProjection(evidence: Omit<CodeGraphSnapshotPurgeGraphEvidence, 'graphEvidenceDigest'>) {
  return {
    activeViewIds: evidence.activeViewIds,
    blockers: evidence.blockers,
    buildOwnerIds: evidence.buildOwnerIds,
    childSnapshotIds: evidence.childSnapshotIds,
    cleanupEpochs: evidence.cleanupEpochs,
    liveLeases: evidence.liveLeases,
    snapshot: {
      baseSnapshotId: evidence.snapshot.baseSnapshotId ?? null,
      commit: evidence.snapshot.commit,
      completedAt: evidence.snapshot.completedAt ?? null,
      dirty: evidence.snapshot.dirty,
      edgeCount: evidence.snapshot.edgeCount,
      extractorSet: evidence.snapshot.extractorSet,
      fileCount: evidence.snapshot.fileCount,
      graphContentId: evidence.snapshot.graphContentId ?? null,
      id: evidence.snapshot.id,
      overlayFingerprint: evidence.snapshot.overlayFingerprint ?? null,
      repositoryId: evidence.snapshot.repositoryId,
      state: evidence.snapshot.state,
      symbolCount: evidence.snapshot.symbolCount,
      worktreeId: evidence.snapshot.worktreeId,
    },
  };
}

const retireReadySnapshotsIfUnused = Effect.fn('codeGraph.retireReadySnapshotsIfUnused')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
  now: number,
) {
  const candidates = [...new Set(snapshotIds)];
  if (candidates.length === 0) return 0;
  const statement = codeGraphExactSnapshotRetirementStatement(candidates, now);
  yield* sql.unsafe(statement.text, statement.parameters);
  return yield* lastStatementChangeCount(sql);
});

/** @internal Target-rooted exact retirement retained for deterministic query-plan regressions. */
export function codeGraphExactSnapshotRetirementStatement(
  snapshotIds: readonly string[],
  now: number,
): CodeGraphSqlQueryStatement {
  const candidates = [...new Set(snapshotIds)];
  const placeholders = candidates.map(() => '?').join(', ');
  return {
    parameters: [...candidates, now],
    text: `UPDATE snapshots AS candidate
    SET state = 'retired'
    WHERE candidate.id IN (${placeholders})
      AND candidate.state = 'ready'
      AND NOT EXISTS (
        SELECT 1
        FROM active_snapshots AS active
        WHERE active.snapshot_id = candidate.id
          AND NOT EXISTS (
            SELECT 1
            FROM removed_views AS removed
            WHERE removed.worktree_id = active.worktree_id
              AND removed.expected_snapshot_id = active.snapshot_id
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM snapshot_leases AS lease
        WHERE lease.snapshot_id = candidate.id
          AND lease.expires_at > ?
      )
      AND NOT EXISTS (
        SELECT 1
        FROM snapshots AS child INDEXED BY snapshots_base_state_id
        WHERE child.base_snapshot_id = candidate.id
        LIMIT 1
      )`,
  };
}

interface CompactLexicalCleanupSpec {
  readonly batchRows: number;
  readonly indexName?: string;
  readonly keyColumns: readonly string[];
  readonly maximumBatchRows: number;
  readonly table: 'lexical_compact_postings' | 'lexical_compact_symbols' | 'lexical_compact_terms';
}

const COMPACT_LEXICAL_CLEANUP_SPECS: readonly CompactLexicalCleanupSpec[] = [
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_key', 'term_key', 'symbol_key'],
    maximumBatchRows: 20_000,
    table: 'lexical_compact_postings',
  },
  {
    batchRows: 5_000,
    indexName: 'sqlite_autoindex_lexical_compact_symbols_1',
    keyColumns: ['snapshot_key', 'symbol_id'],
    maximumBatchRows: 20_000,
    table: 'lexical_compact_symbols',
  },
  {
    batchRows: 5_000,
    indexName: 'sqlite_autoindex_lexical_compact_terms_1',
    keyColumns: ['snapshot_key', 'term'],
    maximumBatchRows: 20_000,
    table: 'lexical_compact_terms',
  },
];

function compactLexicalCleanupPageStatement(
  spec: CompactLexicalCleanupSpec,
  snapshotKey: number,
  batchRows: number,
  retiredSnapshotId: Option.Option<string>,
): CodeGraphSqlQueryStatement {
  const key = `(${spec.keyColumns.join(', ')})`;
  const retirement = Option.match(retiredSnapshotId, {
    onNone: () => ({parameters: [] as readonly string[], predicate: ''}),
    onSome: snapshotId => ({
      parameters: [snapshotId],
      predicate: `AND EXISTS (
        SELECT 1
        FROM lexical_compact_snapshots AS compact
        JOIN snapshots AS snapshot ON snapshot.id = compact.snapshot_id
        WHERE compact.snapshot_key = candidate.snapshot_key
          AND compact.snapshot_id = ?
          AND snapshot.state = 'retired'
      )`,
    }),
  });
  return {
    parameters: [snapshotKey, ...retirement.parameters, batchRows],
    text: `DELETE FROM ${spec.table}
      WHERE ${key} IN (
        SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
        FROM ${spec.table} AS candidate${spec.indexName ? ` INDEXED BY ${spec.indexName}` : ''}
        WHERE candidate.snapshot_key = ?
          ${retirement.predicate}
        ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
        LIMIT ?
      )`,
  };
}

/** @internal Exact indexed cleanup statement retained for query-plan regression tests. */
export function codeGraphCompactLexicalCleanupPageStatement(
  table: CompactLexicalCleanupSpec['table'],
  snapshotKey: number,
  batchRows: number,
): CodeGraphSqlQueryStatement {
  const spec = COMPACT_LEXICAL_CLEANUP_SPECS.find(candidate => candidate.table === table);
  if (spec === undefined) throw new Error(`Unknown compact lexical cleanup table: ${table}`);
  return compactLexicalCleanupPageStatement(spec, snapshotKey, batchRows, Option.none());
}

const clearCompactLexicalSnapshotRows = Effect.fn('codeGraph.clearCompactLexicalSnapshotRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  writerGate?: CodeGraphWriterGate,
  ownerToken?: string,
) {
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  const compactRows = yield* sql<CompactLexicalSnapshotKeyRow>`
    SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ${snapshotId} LIMIT 1
  `;
  const compactSnapshotKey = compactRows[0]
    ? yield* validatedCompactLexicalCount(compactRows[0].snapshot_key, 'cleanup snapshot key')
    : undefined;
  for (const spec of COMPACT_LEXICAL_CLEANUP_SPECS) {
    if (compactSnapshotKey === undefined) break;
    let batchRows: number = spec.batchRows;
    for (;;) {
      const startedAt = performance.now();
      const deleted = yield* runWrite(
        sql.withTransaction(
          Effect.gen(function* () {
            if (ownerToken !== undefined) yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
            const statement = compactLexicalCleanupPageStatement(spec, compactSnapshotKey, batchRows, Option.none());
            yield* sql.unsafe(statement.text, statement.parameters);
            return yield* lastStatementChangeCount(sql);
          }),
        ),
      );
      if (deleted === 0) break;
      batchRows = nextPersistentActivationBatchRows(
        batchRows,
        Math.max(0, performance.now() - startedAt),
        spec.maximumBatchRows,
      );
      yield* Effect.yieldNow;
    }
  }
  yield* runWrite(
    sql.withTransaction(
      Effect.gen(function* () {
        if (ownerToken !== undefined) yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
        yield* sql`DELETE FROM lexical_storage_formats WHERE snapshot_id = ${snapshotId}`;
        yield* sql`DELETE FROM lexical_compact_snapshots WHERE snapshot_id = ${snapshotId}`;
      }),
    ),
  );
});

const pruneRetiredCompactLexicalRows = Effect.fn('codeGraph.pruneRetiredCompactLexicalRows')(function* (
  sql: SqlClient.SqlClient,
  writerGate: CodeGraphWriterGate,
  snapshotId?: string,
) {
  for (;;) {
    const targets = yield* sql<CompactLexicalSnapshotKeyRow & {readonly snapshot_id: string}>`
      SELECT compact.snapshot_key, compact.snapshot_id
      FROM lexical_compact_snapshots AS compact
      JOIN snapshots AS snapshot ON snapshot.id = compact.snapshot_id
      WHERE snapshot.state = 'retired'
        AND (${snapshotId ?? null} IS NULL OR snapshot.id = ${snapshotId ?? null})
      ORDER BY compact.snapshot_id
      LIMIT 1
    `;
    const target = targets[0];
    if (target === undefined) break;
    const compactSnapshotKey = yield* validatedCompactLexicalCount(target.snapshot_key, 'cleanup snapshot key');
    for (const spec of COMPACT_LEXICAL_CLEANUP_SPECS) {
      let batchRows: number = spec.batchRows;
      for (;;) {
        const startedAt = performance.now();
        const deleted = yield* writerGate(
          sql.withTransaction(
            Effect.gen(function* () {
              const statement = compactLexicalCleanupPageStatement(
                spec,
                compactSnapshotKey,
                batchRows,
                Option.some(target.snapshot_id),
              );
              yield* sql.unsafe(statement.text, statement.parameters);
              return yield* lastStatementChangeCount(sql);
            }),
          ),
        );
        if (deleted === 0) break;
        batchRows = nextPersistentActivationBatchRows(
          batchRows,
          Math.max(0, performance.now() - startedAt),
          spec.maximumBatchRows,
        );
        yield* Effect.yieldNow;
      }
    }
    const metadataDeleted = yield* writerGate(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(
            `DELETE FROM lexical_storage_formats
             WHERE snapshot_id = ?
               AND EXISTS (SELECT 1 FROM snapshots WHERE id = ? AND state = 'retired')`,
            [target.snapshot_id, target.snapshot_id],
          );
          const formatRows = yield* lastStatementChangeCount(sql);
          yield* sql.unsafe(
            `DELETE FROM lexical_compact_snapshots
             WHERE snapshot_key = ? AND snapshot_id = ?
               AND EXISTS (SELECT 1 FROM snapshots WHERE id = ? AND state = 'retired')`,
            [compactSnapshotKey, target.snapshot_id, target.snapshot_id],
          );
          return formatRows + (yield* lastStatementChangeCount(sql));
        }),
      ),
    );
    if (metadataDeleted === 0) {
      // The snapshot stopped being retired between pages. The next selection
      // either chooses another target or observes that cleanup is complete.
      yield* Effect.yieldNow;
    }
  }
});

const purgeSnapshotTerms = Effect.fn('codeGraph.purgeSnapshotTerms')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  // Legacy snapshots retain their original text postings. Compact rows are
  // reclaimed separately in bounded snapshot-key pages before this backstop.
  yield* sql`DELETE FROM symbol_terms WHERE snapshot_id = ${snapshotId}`;
});

interface RetiredSnapshotCleanupSpec {
  readonly batchRows: number;
  readonly keyColumns: readonly string[];
  readonly maximumBatchRows: number;
  readonly table: string;
}

const RETIRED_SNAPSHOT_CLEANUP_SPECS = [
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id', 'tier', 'lookup_key'],
    maximumBatchRows: 20_000,
    table: 'building_reference_candidates',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id'],
    maximumBatchRows: 20_000,
    table: LEGACY_BUILDING_REFERENCES_V3_TABLE,
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id'],
    maximumBatchRows: 20_000,
    table: 'building_references',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'lookup_key', 'symbol_id'],
    maximumBatchRows: 20_000,
    table: 'snapshot_symbol_lookup',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'term', 'symbol_id'],
    maximumBatchRows: 20_000,
    table: 'symbol_terms',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'id'],
    maximumBatchRows: 20_000,
    table: 'edges',
  },
  {
    batchRows: 2_000,
    keyColumns: ['snapshot_id', 'id'],
    maximumBatchRows: 5_000,
    table: 'symbols',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'path'],
    maximumBatchRows: 20_000,
    table: 'snapshot_file_shards',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'path'],
    maximumBatchRows: 20_000,
    table: 'snapshot_files',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'source_path', 'local_name', 'target_path', 'imported_name'],
    maximumBatchRows: 20_000,
    table: 'snapshot_reexport_provenance',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'id'],
    maximumBatchRows: 20_000,
    table: 'code_graph_monikers',
  },
  {
    batchRows: 5_000,
    keyColumns: [
      'snapshot_id',
      'source_component_id',
      'ecosystem',
      'package_name',
      'import_alias',
      'dependency_kind',
      'version_constraint',
      'evidence_path',
    ],
    maximumBatchRows: 20_000,
    table: 'workspace_external_dependencies',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'source_component_id', 'target_component_id', 'provenance'],
    maximumBatchRows: 20_000,
    table: 'workspace_component_dependencies',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'id'],
    maximumBatchRows: 20_000,
    table: 'workspace_components',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'id'],
    maximumBatchRows: 20_000,
    table: 'workspace_scopes',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'symbol_id'],
    maximumBatchRows: 20_000,
    table: 'snapshot_symbol_deletions',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id'],
    maximumBatchRows: 20_000,
    table: 'snapshot_edge_deletions',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'path'],
    maximumBatchRows: 20_000,
    table: 'snapshot_file_deletions',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'batch_index'],
    maximumBatchRows: 20_000,
    table: 'building_materialization_batches',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'batch_index'],
    maximumBatchRows: 20_000,
    table: 'building_analysis_batches',
  },
  {
    batchRows: 1,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1,
    table: 'building_lexical_counters',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'language', 'kind'],
    maximumBatchRows: 20_000,
    table: 'snapshot_analysis_symbol_counts',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'provenance', 'relation', 'confidence', 'endpoint_state'],
    maximumBatchRows: 20_000,
    table: 'snapshot_analysis_edge_histogram',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'provenance', 'relation'],
    maximumBatchRows: 20_000,
    table: 'snapshot_analysis_edge_counts',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1_000,
    table: 'snapshot_component_edge_aggregate_receipts',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'source_component_id', 'target_component_id', 'provenance', 'relation'],
    maximumBatchRows: 20_000,
    table: 'snapshot_component_edge_aggregates',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1_000,
    table: 'snapshot_analysis_summary_receipts',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1_000,
    table: 'snapshot_reuse_receipts',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'lookup_key', 'symbol_id'],
    maximumBatchRows: 20_000,
    table: 'snapshot_fold_forward_symbol_lookup',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'path'],
    maximumBatchRows: 20_000,
    table: 'snapshot_fold_forward_paths',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1_000,
    table: 'snapshot_fold_forward_receipts',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id', 'pack_id'],
    maximumBatchRows: 1_000,
    table: 'snapshot_pack_provenance',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1_000,
    table: 'snapshot_extractor_generations',
  },
] as const satisfies readonly RetiredSnapshotCleanupSpec[];

const clearSnapshotOwnedRows = Effect.fn('codeGraph.clearSnapshotOwnedRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  writerGate?: CodeGraphWriterGate,
  ownerToken?: string,
) {
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  yield* clearCompactLexicalSnapshotRows(sql, snapshotId, runWrite, ownerToken);
  for (const spec of RETIRED_SNAPSHOT_CLEANUP_SPECS) {
    if (spec.table === LEGACY_BUILDING_REFERENCES_V3_TABLE && !(yield* tableExists(sql, spec.table))) continue;
    let batchRows: number = spec.batchRows;
    for (;;) {
      const startedAt = performance.now();
      const deleted = yield* runWrite(
        sql.withTransaction(
          Effect.gen(function* () {
            if (ownerToken !== undefined) yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
            const key = `(${spec.keyColumns.join(', ')})`;
            yield* sql.unsafe(
              `DELETE FROM ${spec.table}
             WHERE ${key} IN (
               SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               FROM ${spec.table} AS candidate
               WHERE candidate.snapshot_id = ?
               ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               LIMIT ?
             )`,
              [snapshotId, batchRows],
            );
            const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
            return Number(changes[0]?.count ?? 0);
          }),
        ),
      );
      if (!Number.isSafeInteger(deleted) || deleted < 0) {
        return yield* CodeGraphStoreError.of('Snapshot reset returned an invalid row count.');
      }
      if (deleted === 0) break;
      batchRows = nextPersistentActivationBatchRows(
        batchRows,
        Math.max(0, performance.now() - startedAt),
        spec.maximumBatchRows,
      );
      yield* Effect.yieldNow;
    }
  }
});

interface RetiredSnapshotCleanupPage {
  readonly deleted: number;
  readonly remaining: boolean;
}

const pruneUnreferencedFileBlobs = Effect.fn('codeGraph.pruneUnreferencedFileBlobs')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`
    DELETE FROM file_blobs
    WHERE NOT EXISTS (
      SELECT 1
      FROM snapshot_files
      WHERE snapshot_files.path = file_blobs.path_hint
        AND snapshot_files.content_hash = file_blobs.content_hash
    )
      AND NOT (
        file_blobs.blob_id IS NOT NULL
        AND file_blobs.reuse_class IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM snapshot_files WHERE snapshot_files.content_hash = file_blobs.content_hash
        )
      )
  `;
});

const pruneCachedFileBlobs = Effect.fn('codeGraph.pruneCachedFileBlobs')(function* (
  sql: SqlClient.SqlClient,
  acceptedExtractorSets?: readonly string[],
) {
  if (acceptedExtractorSets === undefined) {
    yield* pruneUnreferencedFileBlobs(sql);
    yield* pruneUnreferencedMaterializedFileShards(sql);
    return;
  }
  if (acceptedExtractorSets.length === 0) {
    return yield* CodeGraphStoreError.of('At least one active extractor cache is required.');
  }
  yield* sql.unsafe(
    `DELETE FROM file_blobs
     WHERE extractor_set NOT IN (${acceptedExtractorSets.map(() => '?').join(', ')})
        OR (
          NOT EXISTS (
            SELECT 1
            FROM snapshot_files
            WHERE snapshot_files.path = file_blobs.path_hint
              AND snapshot_files.content_hash = file_blobs.content_hash
          )
          AND NOT (
            file_blobs.blob_id IS NOT NULL
            AND file_blobs.reuse_class IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM snapshot_files WHERE snapshot_files.content_hash = file_blobs.content_hash
            )
          )
        )`,
    acceptedExtractorSets,
  );
  yield* pruneUnreferencedMaterializedFileShards(sql);
});

const pruneUnreferencedMaterializedFileShards = Effect.fn('codeGraph.pruneUnreferencedMaterializedFileShards')(
  function* (sql: SqlClient.SqlClient) {
    yield* sql.unsafe(`
      DELETE FROM materialized_file_shards
      WHERE NOT EXISTS (
        SELECT 1 FROM snapshot_file_shards WHERE snapshot_file_shards.shard_id = materialized_file_shards.id
      )
    `);
  },
);

export {
  purgeSnapshotTerms,
  CompactLexicalCleanupSpec,
  COMPACT_LEXICAL_CLEANUP_SPECS,
  compactLexicalCleanupPageStatement,
  clearCompactLexicalSnapshotRows,
  pruneUnreferencedFileBlobs,
  CODE_GRAPH_SNAPSHOT_PURGE_EVIDENCE_LIMIT,
  validateSnapshotPurgeInput,
  snapshotPurgeGraphProjection,
  observeSnapshotPurge,
  retireReadySnapshotsIfUnused,
  pruneRetiredCompactLexicalRows,
  RetiredSnapshotCleanupSpec,
  RETIRED_SNAPSHOT_CLEANUP_SPECS,
  clearSnapshotOwnedRows,
  RetiredSnapshotCleanupPage,
  pruneUnreferencedMaterializedFileShards,
  pruneCachedFileBlobs,
};
