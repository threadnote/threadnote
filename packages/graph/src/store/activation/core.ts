import {Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {type CodeGraphActivationStage, type CodeGraphActivationProgressCallback} from '../models.js';
import {LEGACY_BUILDING_REFERENCES_V3_TABLE} from '../schema/contracts.js';
import {persistedIncrementalFactCountsStatement} from '../incremental/plan.js';
import {tableExists} from '../session.js';
import {type CodeGraphSnapshot, CodeGraphStoreError} from '../../types.js';

type ActivationProgressObserver = (
  stage: CodeGraphActivationStage,
  state: 'completed' | 'progress' | 'started',
  rows?: number,
  transactionMilliseconds?: number,
) => Effect.Effect<void, never>;

function activationProgressObserver(
  onProgress: CodeGraphActivationProgressCallback | undefined,
): ActivationProgressObserver {
  const startedAt = performance.now();
  const stageStartedAt = new Map<CodeGraphActivationStage, number>();
  return (stage, state, rows, transactionMilliseconds) =>
    Effect.gen(function* () {
      const now = performance.now();
      if (state === 'started') stageStartedAt.set(stage, now);
      const stageStart = stageStartedAt.get(stage) ?? now;
      yield* onProgress?.({
        elapsedMilliseconds: Math.max(0, now - startedAt),
        ...(rows === undefined ? {} : {rows}),
        stage,
        stageElapsedMilliseconds: state === 'started' ? 0 : Math.max(0, now - stageStart),
        state,
        ...(transactionMilliseconds === undefined ? {} : {transactionMilliseconds}),
      }) ?? Effect.void;
      // SQLite statements are synchronous under Bun. Yield at every observable
      // boundary so the independent heartbeat and progress writer can run.
      yield* Effect.yieldNow;
    });
}

interface PersistentActivationCopySpec {
  readonly batchRows: number;
  readonly columns: readonly string[];
  readonly destinationTable: string;
  readonly keyColumns: readonly string[];
  readonly maximumBatchRows: number;
  readonly sourceTable: string;
  readonly tally?: {
    readonly column: string;
    readonly value: string;
  };
}

interface PersistentActivationCopyResult {
  readonly rows: number;
  readonly talliedRows: number;
}

const PERSISTENT_ACTIVATION_COPY_SPECS = {
  edges: {
    batchRows: 10_000,
    columns: [
      'id',
      'source_id',
      'source_name',
      'relation',
      'target_id',
      'target_name',
      'provenance',
      'confidence',
      'evidence_path',
      'evidence_span_json',
    ],
    destinationTable: 'edges',
    keyColumns: ['id'],
    maximumBatchRows: 40_000,
    sourceTable: 'activation_edges',
  },
  files: {
    batchRows: 10_000,
    columns: ['path', 'content_hash', 'raw_content_hash', 'language', 'mode', 'size', 'source'],
    destinationTable: 'snapshot_files',
    keyColumns: ['path'],
    maximumBatchRows: 40_000,
    sourceTable: 'activation_files',
  },
  lookupKeys: {
    batchRows: 10_000,
    columns: [
      'lookup_key',
      'symbol_id',
      'resolution_domain',
      'exported',
      'provenance',
      'evidence_edge_id',
      'evidence_path',
    ],
    destinationTable: 'snapshot_symbol_lookup',
    keyColumns: ['lookup_key', 'symbol_id'],
    maximumBatchRows: 40_000,
    sourceTable: 'activation_symbol_lookup',
    tally: {column: 'provenance', value: 'alias'},
  },
  reexports: {
    batchRows: 10_000,
    columns: ['source_path', 'local_name', 'target_path', 'imported_name'],
    destinationTable: 'snapshot_reexport_provenance',
    keyColumns: ['source_path', 'local_name', 'target_path', 'imported_name'],
    maximumBatchRows: 40_000,
    sourceTable: 'activation_reexport_provenance',
  },
  symbols: {
    batchRows: 5_000,
    columns: [
      'id',
      'content_hash',
      'kind',
      'name',
      'qualified_name',
      'path',
      'language',
      'arity',
      'lookup_keys_json',
      'resolution_domain',
      'resolution_scope_id',
      'package_name',
      'exported',
      'signature',
      'documentation',
      'span_json',
    ],
    destinationTable: 'symbols',
    keyColumns: ['id'],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_symbols',
  },
  terms: {
    batchRows: 10_000,
    columns: ['term', 'symbol_id', 'weight'],
    destinationTable: 'symbol_terms',
    keyColumns: ['term', 'symbol_id'],
    maximumBatchRows: 50_000,
    sourceTable: 'activation_symbol_terms',
  },
  monikers: {
    batchRows: 5_000,
    columns: [
      'id',
      'version',
      'scheme',
      'role',
      'kind',
      'resolution_domain',
      'identity',
      'package_name',
      'package_version',
      'import_path',
      'qualified_name',
      'component_id',
      'symbol_id',
      'dependency_kind',
      'evidence_path',
      'evidence_span_json',
    ],
    destinationTable: 'code_graph_monikers',
    keyColumns: ['id'],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_monikers',
  },
  workspaceComponents: {
    batchRows: 5_000,
    columns: [
      'id',
      'workspace_id',
      'build_system',
      'kind',
      'name',
      'root',
      'resolution_domain',
      'languages_json',
      'source_roots_json',
      'workspace_roots_json',
      'provenance',
      'diagnostics_json',
    ],
    destinationTable: 'workspace_components',
    keyColumns: ['id'],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_workspace_components',
  },
  workspaceDependencies: {
    batchRows: 5_000,
    columns: ['source_component_id', 'target_component_id', 'provenance', 'evidence'],
    destinationTable: 'workspace_component_dependencies',
    keyColumns: ['source_component_id', 'target_component_id', 'provenance'],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_workspace_dependencies',
  },
  workspaceExternalDependencies: {
    batchRows: 5_000,
    columns: [
      'source_component_id',
      'ecosystem',
      'package_name',
      'import_alias',
      'dependency_kind',
      'version_constraint',
      'evidence_path',
      'evidence_span_json',
    ],
    destinationTable: 'workspace_external_dependencies',
    keyColumns: [
      'source_component_id',
      'ecosystem',
      'package_name',
      'import_alias',
      'dependency_kind',
      'version_constraint',
      'evidence_path',
    ],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_workspace_external_dependencies',
  },
  workspaceScopes: {
    batchRows: 5_000,
    columns: ['id', 'build_system', 'name', 'root', 'provenance', 'diagnostics_json'],
    destinationTable: 'workspace_scopes',
    keyColumns: ['id'],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_workspace_scopes',
  },
} as const satisfies Readonly<Record<string, PersistentActivationCopySpec>>;

const PERSISTENT_ACTIVATION_BATCH_TARGET_MILLISECONDS = 3_000;

const PERSISTENT_ACTIVATION_BATCH_DEADBAND_MIN_MILLISECONDS = 2_000;

const PERSISTENT_ACTIVATION_BATCH_DEADBAND_MAX_MILLISECONDS = 5_000;

const PERSISTENT_ACTIVATION_BATCH_MIN_ROWS = 250;

/**
 * Adapt copy pages toward a three-second transaction while retaining a wide
 * margin below the 15-second build heartbeat threshold. Growth is limited to
 * 2x per observation so a fast region cannot immediately create an oversized
 * synchronous SQLite statement in the next, denser B-tree region.
 */
export function nextPersistentActivationBatchRows(
  currentRows: number,
  transactionMilliseconds: number,
  maximumRows: number,
): number {
  const current = Math.max(PERSISTENT_ACTIVATION_BATCH_MIN_ROWS, Math.floor(currentRows));
  const maximum = Math.max(current, Math.floor(maximumRows));
  if (!Number.isFinite(transactionMilliseconds) || transactionMilliseconds < 0) {
    return Math.max(PERSISTENT_ACTIVATION_BATCH_MIN_ROWS, Math.floor(current / 200) * 100);
  }
  if (
    transactionMilliseconds >= PERSISTENT_ACTIVATION_BATCH_DEADBAND_MIN_MILLISECONDS &&
    transactionMilliseconds <= PERSISTENT_ACTIVATION_BATCH_DEADBAND_MAX_MILLISECONDS
  ) {
    return Math.min(current, maximum);
  }
  const duration = Math.max(1, transactionMilliseconds);
  const target = Math.floor((current * PERSISTENT_ACTIVATION_BATCH_TARGET_MILLISECONDS) / duration);
  const growthBounded = Math.min(current * 2, target);
  const rounded = Math.floor(growthBounded / 100) * 100;
  return Math.max(PERSISTENT_ACTIVATION_BATCH_MIN_ROWS, Math.min(maximum, rounded));
}

/**
 * Copies one final-table partition in bounded keyset transactions. The target
 * snapshot remains `building`, so committed chunks are invisible to normal
 * readers while SQLite can checkpoint and the heartbeat can run between them.
 */
const copyPersistentActivationRows = Effect.fn('codeGraph.copyPersistentActivationRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  spec: PersistentActivationCopySpec,
  stage: CodeGraphActivationStage,
  observe: ActivationProgressObserver,
  initialRowsCompleted = 0,
) {
  let cursor = Option.none<readonly string[]>();
  let batchRows = spec.batchRows;
  let rowsCompleted = 0;
  let talliedRows = 0;
  for (;;) {
    const previousCursor = cursor;
    const transactionStartedAt = performance.now();
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const cursorPredicate = Option.match(cursor, {
          onNone: () => '',
          onSome: () =>
            spec.keyColumns.length === 1
              ? `WHERE ${spec.keyColumns[0]} > ?`
              : `WHERE (${spec.keyColumns.join(', ')}) > (${spec.keyColumns.map(() => '?').join(', ')})`,
        });
        const parameters = [snapshotId, ...Option.getOrElse(cursor, () => []), batchRows];
        yield* sql.unsafe(
          `INSERT INTO ${spec.destinationTable} (snapshot_id, ${spec.columns.join(', ')})
           SELECT ?, ${spec.columns.join(', ')}
           FROM ${spec.sourceTable}
           ${cursorPredicate}
           ORDER BY ${spec.keyColumns.join(', ')}
           LIMIT ?`,
          parameters,
        );
        const changed = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
        const inserted = Number(changed[0]?.count ?? 0);
        if (!Number.isSafeInteger(inserted) || inserted < 0) {
          return yield* CodeGraphStoreError.of('Persistent activation returned an invalid row count.');
        }
        if (inserted === 0) {
          return {cursor: Option.none<readonly string[]>(), inserted, tallied: 0};
        }
        const last = yield* sql.unsafe<Record<string, unknown>>(
          `SELECT ${spec.keyColumns.join(', ')}
           FROM ${spec.destinationTable}
           WHERE snapshot_id = ?
           ORDER BY ${spec.keyColumns.map(column => `${column} DESC`).join(', ')}
           LIMIT 1`,
          [snapshotId],
        );
        const row = last[0];
        if (!row) {
          return yield* CodeGraphStoreError.of('Persistent activation lost its keyset cursor.');
        }
        const nextCursor = spec.keyColumns.map(column => row[column]);
        if (nextCursor.some(value => typeof value !== 'string')) {
          return yield* CodeGraphStoreError.of('Persistent activation returned an invalid keyset cursor.');
        }
        const validatedCursor: string[] = [];
        for (const value of nextCursor) {
          if (typeof value !== 'string') {
            return yield* CodeGraphStoreError.of('Persistent activation returned an invalid keyset cursor.');
          }
          validatedCursor.push(value);
        }
        let tallied = 0;
        if (spec.tally) {
          const lowerPredicate = Option.match(previousCursor, {
            onNone: () => '',
            onSome: () =>
              spec.keyColumns.length === 1
                ? `${spec.keyColumns[0]} > ? AND `
                : `(${spec.keyColumns.join(', ')}) > (${spec.keyColumns.map(() => '?').join(', ')}) AND `,
          });
          const upperPredicate =
            spec.keyColumns.length === 1
              ? `${spec.keyColumns[0]} <= ?`
              : `(${spec.keyColumns.join(', ')}) <= (${spec.keyColumns.map(() => '?').join(', ')})`;
          const tallyRows = yield* sql.unsafe<{readonly count: number}>(
            `SELECT COUNT(*) AS count
             FROM ${spec.sourceTable}
             WHERE ${lowerPredicate}${upperPredicate}
               AND ${spec.tally.column} = ?`,
            [...Option.getOrElse(previousCursor, () => []), ...validatedCursor, spec.tally.value],
          );
          tallied = Number(tallyRows[0]?.count ?? 0);
          if (!Number.isSafeInteger(tallied) || tallied < 0 || tallied > inserted) {
            return yield* CodeGraphStoreError.of('Persistent activation returned an invalid tally.');
          }
        }
        return {cursor: Option.some(validatedCursor), inserted, tallied};
      }),
    );
    if (result.inserted === 0) break;
    cursor = result.cursor;
    rowsCompleted += result.inserted;
    talliedRows += result.tallied;
    const transactionMilliseconds = Math.max(0, performance.now() - transactionStartedAt);
    yield* observe(stage, 'progress', initialRowsCompleted + rowsCompleted, transactionMilliseconds);
    batchRows = nextPersistentActivationBatchRows(batchRows, transactionMilliseconds, spec.maximumBatchRows);
  }
  return {rows: rowsCompleted, talliedRows} satisfies PersistentActivationCopyResult;
});

const resetSnapshotAnalysisSummary = Effect.fn('codeGraph.resetSnapshotAnalysisSummary')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql`DELETE FROM snapshot_analysis_summary_receipts WHERE snapshot_id = ${snapshotId}`;
  yield* sql`DELETE FROM snapshot_analysis_edge_counts WHERE snapshot_id = ${snapshotId}`;
  yield* sql`DELETE FROM snapshot_analysis_edge_histogram WHERE snapshot_id = ${snapshotId}`;
  yield* sql`DELETE FROM snapshot_analysis_symbol_counts WHERE snapshot_id = ${snapshotId}`;
});

const materializeSnapshotAnalysisEdgeCounts = Effect.fn('codeGraph.materializeSnapshotAnalysisEdgeCounts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql`DELETE FROM snapshot_analysis_edge_counts WHERE snapshot_id = ${snapshotId}`;
  yield* sql.unsafe(
    `INSERT INTO snapshot_analysis_edge_counts (
       snapshot_id, provenance, relation, count, confidence_invalid, confidence_total,
       lowest_confidence, confidence_high, confidence_medium, confidence_low,
       unresolved_endpoint_count, self_loop_count, review_finding_count
     )
     SELECT ?, provenance, relation,
       SUM(count),
       0,
       SUM(confidence * count),
       MIN(confidence),
       SUM(CASE WHEN confidence >= 0.9 THEN count ELSE 0 END),
       SUM(CASE WHEN confidence >= 0.6 AND confidence < 0.9 THEN count ELSE 0 END),
       SUM(CASE WHEN confidence < 0.6 THEN count ELSE 0 END),
       SUM(CASE WHEN endpoint_state = 1 THEN count ELSE 0 END),
       SUM(CASE WHEN endpoint_state = 2 THEN count ELSE 0 END),
       SUM(CASE WHEN confidence < CASE provenance
         WHEN 'declared' THEN 0.9
         WHEN 'resolved' THEN 0.9
         WHEN 'syntactic' THEN 0.7
         WHEN 'heuristic' THEN 0.45
         WHEN 'model' THEN 0.35
       END THEN count ELSE 0 END)
     FROM snapshot_analysis_edge_histogram
     WHERE snapshot_id = ? AND count > 0
     GROUP BY provenance, relation`,
    [snapshotId, snapshotId],
  );
});

const materializeCleanSnapshotAnalysisSummary = Effect.fn('codeGraph.materializeCleanSnapshotAnalysisSummary')(
  function* (sql: SqlClient.SqlClient, snapshot: CodeGraphSnapshot) {
    yield* resetSnapshotAnalysisSummary(sql, snapshot.id);
    yield* sql`
    INSERT INTO snapshot_analysis_symbol_counts (snapshot_id, language, kind, count)
    SELECT ${snapshot.id}, language, kind, COUNT(*)
    FROM symbols WHERE snapshot_id = ${snapshot.id}
    GROUP BY language, kind
  `;
    yield* sql`
    INSERT INTO snapshot_analysis_edge_histogram (
      snapshot_id, provenance, relation, confidence, endpoint_state, count
    )
    SELECT ${snapshot.id}, provenance, relation, confidence,
      CASE
        WHEN source_id IS NULL OR target_id IS NULL THEN 1
        WHEN source_id = target_id THEN 2
        ELSE 0
      END,
      COUNT(*)
    FROM edges WHERE snapshot_id = ${snapshot.id}
    GROUP BY provenance, relation, confidence,
      CASE
        WHEN source_id IS NULL OR target_id IS NULL THEN 1
        WHEN source_id = target_id THEN 2
        ELSE 0
      END
  `;
    yield* materializeSnapshotAnalysisEdgeCounts(sql, snapshot.id);
  },
);

const materializeOverlaySnapshotAnalysisSummary = Effect.fn('codeGraph.materializeOverlaySnapshotAnalysisSummary')(
  function* (sql: SqlClient.SqlClient, snapshot: CodeGraphSnapshot, baseSnapshotId: string) {
    yield* resetSnapshotAnalysisSummary(sql, snapshot.id);
    yield* sql.unsafe(
      `WITH affected(id) AS (
       SELECT id FROM symbols WHERE snapshot_id = ?
       UNION
       SELECT symbol_id FROM snapshot_symbol_deletions WHERE snapshot_id = ?
     ),
     contributions(language, kind, count) AS (
       SELECT language, kind, count
       FROM snapshot_analysis_symbol_counts WHERE snapshot_id = ?
       UNION ALL
       SELECT language, kind, COUNT(*)
       FROM symbols WHERE snapshot_id = ? GROUP BY language, kind
       UNION ALL
       SELECT base.language, base.kind, -COUNT(*)
       FROM affected
       JOIN symbols AS base ON base.snapshot_id = ? AND base.id = affected.id
       GROUP BY base.language, base.kind
     )
     INSERT INTO snapshot_analysis_symbol_counts (snapshot_id, language, kind, count)
     SELECT ?, language, kind, SUM(count)
     FROM contributions
     GROUP BY language, kind
     HAVING SUM(count) > 0`,
      [snapshot.id, snapshot.id, baseSnapshotId, snapshot.id, baseSnapshotId, snapshot.id],
    );
    yield* sql.unsafe(
      `WITH affected(id) AS (
       SELECT id FROM edges WHERE snapshot_id = ?
       UNION
       SELECT edge_id FROM snapshot_edge_deletions WHERE snapshot_id = ?
     ),
     contributions(provenance, relation, confidence, endpoint_state, count) AS (
       SELECT provenance, relation, confidence, endpoint_state, count
       FROM snapshot_analysis_edge_histogram WHERE snapshot_id = ?
       UNION ALL
       SELECT provenance, relation, confidence,
         CASE
           WHEN source_id IS NULL OR target_id IS NULL THEN 1
           WHEN source_id = target_id THEN 2
           ELSE 0
         END,
         COUNT(*)
       FROM edges WHERE snapshot_id = ?
       GROUP BY provenance, relation, confidence,
         CASE
           WHEN source_id IS NULL OR target_id IS NULL THEN 1
           WHEN source_id = target_id THEN 2
           ELSE 0
         END
       UNION ALL
       SELECT base.provenance, base.relation, base.confidence,
         CASE
           WHEN base.source_id IS NULL OR base.target_id IS NULL THEN 1
           WHEN base.source_id = base.target_id THEN 2
           ELSE 0
         END,
         -COUNT(*)
       FROM affected
       JOIN edges AS base ON base.snapshot_id = ? AND base.id = affected.id
       GROUP BY base.provenance, base.relation, base.confidence,
         CASE
           WHEN base.source_id IS NULL OR base.target_id IS NULL THEN 1
           WHEN base.source_id = base.target_id THEN 2
           ELSE 0
         END
     )
     INSERT INTO snapshot_analysis_edge_histogram (
       snapshot_id, provenance, relation, confidence, endpoint_state, count
     )
     SELECT ?, provenance, relation, confidence, endpoint_state, SUM(count)
     FROM contributions
     GROUP BY provenance, relation, confidence, endpoint_state
     HAVING SUM(count) > 0`,
      [snapshot.id, snapshot.id, baseSnapshotId, snapshot.id, baseSnapshotId, snapshot.id],
    );
    yield* materializeSnapshotAnalysisEdgeCounts(sql, snapshot.id);
  },
);

const lastStatementChangeCount = Effect.fn('codeGraph.lastStatementChangeCount')(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
  const count = Number(rows[0]?.count ?? -1);
  if (!Number.isSafeInteger(count) || count < 0) {
    return yield* CodeGraphStoreError.of('SQLite returned an invalid changed-row count.');
  }
  return count;
});

const ACTIVATION_EDGE_VALIDATION_PAGE_ROWS = 50_000;

const PERSISTENT_ACTIVATION_ENDPOINT_VALIDATION_PAGE_ROWS = 100_000;

type CodeGraphEdgeEndpoint = 'source' | 'target';

/**
 * Validate staged edge endpoints in bounded primary-key pages. A single
 * anti-join over a multi-million-row graph can keep SQLite in `step()` long
 * enough for an otherwise healthy owner to approach the stale-build window.
 * Page aggregates preserve the same invariant while giving the status writer
 * a regular heartbeat without hydrating every edge in JavaScript.
 */
const validateStagedEdgeSymbols = Effect.fn('codeGraph.validateStagedEdgeSymbols')(function* (
  sql: SqlClient.SqlClient,
  observe: ReturnType<typeof activationProgressObserver>,
) {
  let cursor = Option.none<string>();
  let examined = 0;
  while (true) {
    const cursorPredicate = Option.isSome(cursor) ? 'WHERE id > ?' : '';
    const rows = yield* sql.unsafe<{
      readonly cursor: string;
      readonly invalid_id: string;
      readonly rows_examined: number;
    }>(
      `
      WITH page AS (
        SELECT id, source_id, target_id
        FROM activation_edges
        ${cursorPredicate}
        ORDER BY id
        LIMIT ?
      )
      SELECT
        COALESCE(MAX(page.id), '') AS cursor,
        COALESCE(MIN(
          CASE
            WHEN (page.source_id IS NOT NULL AND source_symbol.id IS NULL)
              OR (page.target_id IS NOT NULL AND target_symbol.id IS NULL)
            THEN page.id
          END
        ), '') AS invalid_id,
        COUNT(*) AS rows_examined
      FROM page
      LEFT JOIN activation_symbols AS source_symbol ON source_symbol.id = page.source_id
      LEFT JOIN activation_symbols AS target_symbol ON target_symbol.id = page.target_id
      `,
      [...Option.toArray(cursor), ACTIVATION_EDGE_VALIDATION_PAGE_ROWS],
    );
    const page = rows[0];
    const rowsExamined = Number(page?.rows_examined ?? 0);
    if (!Number.isSafeInteger(rowsExamined) || rowsExamined < 0) {
      return yield* CodeGraphStoreError.of('Staged edge validation returned an invalid row count.');
    }
    if (page?.invalid_id) {
      return yield* CodeGraphStoreError.of(`Code graph edge ${page.invalid_id} references a missing symbol.`);
    }
    if (rowsExamined === 0) return examined;
    if (typeof page?.cursor !== 'string' || (Option.isSome(cursor) && page.cursor <= cursor.value)) {
      return yield* CodeGraphStoreError.of('Staged edge validation cursor did not advance.');
    }
    cursor = Option.some(page.cursor);
    examined += rowsExamined;
    yield* observe('validating-input', 'progress', examined);
    if (rowsExamined < ACTIVATION_EDGE_VALIDATION_PAGE_ROWS) return examined;
  }
});

const countPersistedFullReuseRows = Effect.fn('codeGraph.countPersistedFullReuseRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  observe: ActivationProgressObserver,
) {
  let lookupCursor = Option.none<readonly [string, string]>();
  let lookupCount = 0;
  let aliasCount = 0;
  for (;;) {
    const predicate = Option.isSome(lookupCursor) ? 'AND (lookup_key > ? OR (lookup_key = ? AND symbol_id > ?))' : '';
    const rows = yield* sql.unsafe<{
      readonly aliases: number;
      readonly last_lookup_key: string;
      readonly last_symbol_id: string;
      readonly rows_examined: number;
    }>(
      `WITH page AS (
         SELECT lookup_key, symbol_id, provenance
         FROM snapshot_symbol_lookup
         WHERE snapshot_id = ? ${predicate}
         ORDER BY lookup_key, symbol_id
         LIMIT ?
       )
       SELECT COUNT(*) AS rows_examined,
         COALESCE(SUM(CASE WHEN provenance = 'alias' THEN 1 ELSE 0 END), 0) AS aliases,
         COALESCE(MAX(lookup_key), '') AS last_lookup_key,
         COALESCE((
           SELECT symbol_id FROM page
           ORDER BY lookup_key DESC, symbol_id DESC LIMIT 1
         ), '') AS last_symbol_id
       FROM page`,
      [
        snapshotId,
        ...(Option.isSome(lookupCursor) ? [lookupCursor.value[0], lookupCursor.value[0], lookupCursor.value[1]] : []),
        ACTIVATION_EDGE_VALIDATION_PAGE_ROWS,
      ],
    );
    const page = rows[0];
    const pageRows = Number(page?.rows_examined ?? 0);
    if (pageRows === 0) break;
    lookupCount += pageRows;
    aliasCount += Number(page?.aliases ?? 0);
    const next = [page?.last_lookup_key ?? '', page?.last_symbol_id ?? ''] as const;
    if (
      Option.isSome(lookupCursor) &&
      (next[0] < lookupCursor.value[0] || (next[0] === lookupCursor.value[0] && next[1] <= lookupCursor.value[1]))
    ) {
      return yield* CodeGraphStoreError.of('Persistent lookup count cursor did not advance.');
    }
    lookupCursor = Option.some(next);
    yield* observe('validating-input', 'progress', lookupCount);
    if (pageRows < ACTIVATION_EDGE_VALIDATION_PAGE_ROWS) break;
  }
  const reexportRows = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM snapshot_reexport_provenance
    WHERE snapshot_id = ${snapshotId}
  `;
  return {
    aliasCount,
    lookupCount,
    reexportCount: Number(reexportRows[0]?.count ?? 0),
  };
});

const PERSISTED_FULL_RESOLUTION_DRAIN_SPECS = [
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
] as const;

const COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS = [
  ...PERSISTED_FULL_RESOLUTION_DRAIN_SPECS,
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id', 'batch_index'],
    maximumBatchRows: 5_000,
    table: 'building_materialization_batches',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id', 'batch_index'],
    maximumBatchRows: 5_000,
    table: 'building_analysis_batches',
  },
  {
    batchRows: 1,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1,
    table: 'building_lexical_counters',
  },
] as const;

export function completedPersistentBuildDrainPageStatement(
  spec: (typeof COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS)[number],
  batchRows: number,
  snapshotId?: string,
) {
  const key = `(${spec.keyColumns.join(', ')})`;
  return {
    text: `DELETE FROM ${spec.table}
           WHERE ${key} IN (
             SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
             FROM ${spec.table} AS candidate
             WHERE candidate.snapshot_id IN (
               SELECT snapshot.id FROM snapshots AS snapshot
               WHERE snapshot.state <> 'building'${snapshotId === undefined ? '' : ' AND snapshot.id = ?'}
             )
             ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
             LIMIT ?
           )`,
    parameters: snapshotId === undefined ? [batchRows] : [snapshotId, batchRows],
  };
}

interface CompletedBuildCleanupPage {
  readonly deleted: number;
}

/** Reclaim exactly one bounded build-only table page, if one is available. */
const drainCompletedPersistentBuildRowsPage = Effect.fn('codeGraph.drainCompletedPersistentBuildRowsPage')(function* (
  sql: SqlClient.SqlClient,
) {
  for (const spec of COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS) {
    // A killed schema publisher can leave an additive extension absent. A
    // routine tick skips it; ordinary indexing owns extension publication.
    if (!(yield* tableExists(sql, spec.table))) continue;
    const statement = completedPersistentBuildDrainPageStatement(spec, spec.batchRows);
    const deleted = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(statement.text, statement.parameters);
        return yield* lastStatementChangeCount(sql);
      }),
    );
    if (!Number.isSafeInteger(deleted) || deleted < 0) {
      return yield* CodeGraphStoreError.of('Completed build cleanup returned an invalid count.');
    }
    if (deleted > 0) return {deleted} satisfies CompletedBuildCleanupPage;
  }
  return {deleted: 0} satisfies CompletedBuildCleanupPage;
});

const dropPersistedFullResolutionViews = Effect.fn('codeGraph.dropPersistedFullResolutionViews')(function* (
  sql: SqlClient.SqlClient,
) {
  for (const name of [
    'persisted_full_reference_candidate_delete',
    'persisted_full_reference_delete',
    'persisted_full_edge_delete',
    'persisted_full_edge_insert',
    'persisted_full_lookup_insert',
  ] as const) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS temp.${name}`);
  }
  for (const name of [
    'activation_reference_candidates',
    'activation_references',
    'activation_edges',
    'activation_symbol_lookup',
    'activation_symbols',
  ] as const) {
    yield* sql.unsafe(`DROP VIEW IF EXISTS temp.${name}`);
  }
  yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
  yield* sql.unsafe('DELETE FROM activation_state');
});

const persistedIncrementalFactCounts = Effect.fn('codeGraph.persistedIncrementalFactCounts')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string,
) {
  const statement = persistedIncrementalFactCountsStatement(baseSnapshotId);
  const rows = yield* sql.unsafe<{
    readonly edges: number;
    readonly files: number;
    readonly symbols: number;
  }>(statement.text, statement.parameters);
  const row = rows[0];
  if (!row) return yield* CodeGraphStoreError.of(`Reusable base ${baseSnapshotId} is unavailable.`);
  const counts = {
    edges: Number(row.edges),
    files: Number(row.files),
    symbols: Number(row.symbols),
  };
  if (Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0)) {
    return yield* CodeGraphStoreError.of('Persisted incremental graph counts are invalid.');
  }
  return counts;
});

export {
  lastStatementChangeCount,
  ActivationProgressObserver,
  activationProgressObserver,
  PersistentActivationCopySpec,
  PersistentActivationCopyResult,
  resetSnapshotAnalysisSummary,
  materializeSnapshotAnalysisEdgeCounts,
  ACTIVATION_EDGE_VALIDATION_PAGE_ROWS,
  PERSISTENT_ACTIVATION_ENDPOINT_VALIDATION_PAGE_ROWS,
  CodeGraphEdgeEndpoint,
  PERSISTENT_ACTIVATION_COPY_SPECS,
  PERSISTENT_ACTIVATION_BATCH_TARGET_MILLISECONDS,
  PERSISTENT_ACTIVATION_BATCH_DEADBAND_MIN_MILLISECONDS,
  PERSISTENT_ACTIVATION_BATCH_DEADBAND_MAX_MILLISECONDS,
  PERSISTENT_ACTIVATION_BATCH_MIN_ROWS,
  copyPersistentActivationRows,
  materializeCleanSnapshotAnalysisSummary,
  materializeOverlaySnapshotAnalysisSummary,
  validateStagedEdgeSymbols,
  countPersistedFullReuseRows,
  PERSISTED_FULL_RESOLUTION_DRAIN_SPECS,
  COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS,
  CompletedBuildCleanupPage,
  drainCompletedPersistentBuildRowsPage,
  dropPersistedFullResolutionViews,
  persistedIncrementalFactCounts,
};
