import {Clock, DateTime, Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {codeGraphUtf8ByteLength, saturatingCapacityAdd} from '../disk/capacity.js';
import {isCodeGraphReferenceWithinCandidateBudget} from '../fact/budget.js';
import {
  compactReferenceLookupTiers,
  codeGraphMaterializationMonikerRows,
  normalizedReexportProvenance,
  parseTypeScriptPathNameLookupKey,
  type CompactedReferenceLookupTiers,
} from '../materialization/rows.js';
import {compareCodeUnits} from '../ordering.js';
import {type CodeGraphRetiredSnapshotCleanupProgressCallback} from './models.js';
import {LEGACY_BUILDING_REFERENCES_V3_TABLE} from './schema/contracts.js';
import {CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS, tableExists} from './session.js';
import {
  type CodeGraphEdge,
  type CodeGraphProvenance,
  type CodeGraphReference,
  type CodeGraphSymbol,
  CodeGraphStoreError,
} from '../types.js';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import {canonicalCodeGraphMonikers} from '../cross_repository/monikers.js';
import {
  ACTIVATION_REFERENCE_BATCH_ROWS,
  ACTIVATION_REFERENCE_CANDIDATE_BATCH_ROWS,
  activationInsertClause,
  type ActivationInsertMode,
  type ActivationStagingObserver,
  type CodeGraphWriterGate,
  type CompactActivationSymbolSelection,
  type CompactLexicalFormatReceipt,
  type CompactLexicalSnapshotKeyRow,
  ensureCompactLexicalSnapshot,
  type PersistedAnalysisBatchReceipt,
  prepareAnalysisResolutionTables,
  validatedCompactLexicalCount,
} from './build/core.js';
import {chunk, sortedBy, uniqueBy} from './utilities.js';
import {
  COMPACT_LEXICAL_CLEANUP_SPECS,
  compactLexicalCleanupPageStatement,
  RETIRED_SNAPSHOT_CLEANUP_SPECS,
} from './cleanup_core.js';
import {lastStatementChangeCount, nextPersistentActivationBatchRows} from './activation/core.js';
import {
  boundedSnapshotLeaseProjection,
  type BoundedSnapshotLeaseRow,
  decodeSnapshotLeaseManifest,
} from './maintenance_core.js';

/**
 * Superseded persistent builds can own repository-sized durable tables. Reclaim
 * their exact identities before the replacement build starts, one transaction
 * at a time. The writer gate is released between pages so linked worktrees can
 * make progress; unlike best-effort detached cleanup, this required path waits
 * through contention until every still-eligible target is gone.
 */
const reclaimRetiredSnapshotRows = Effect.fn('codeGraph.reclaimRetiredSnapshotRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
  writerGate: CodeGraphWriterGate,
  onProgress?: CodeGraphRetiredSnapshotCleanupProgressCallback,
) {
  const targets = [...new Set(snapshotIds)].sort(compareCodeUnits);
  if (targets.length === 0) return;
  const targetBatches = [...chunk(targets, 100)];
  let pagesCompleted = 0;
  let rowsDeleted = 0;
  let snapshotsCompleted = 0;
  yield* onProgress?.({
    pagesCompleted,
    rowsDeleted,
    snapshotsCompleted,
    snapshotsTotal: targets.length,
  }) ?? Effect.void;
  for (let index = 0; index < targetBatches.length; index += 1) {
    const targetBatch = targetBatches[index];
    const reclaimPage = makeRetiredSnapshotReclamationPage(sql, targetBatch);
    for (;;) {
      const page = yield* writerGate(reclaimPage);
      pagesCompleted += 1;
      rowsDeleted += page.rowsDeleted;
      if (page.complete) snapshotsCompleted += targetBatch.length;
      yield* onProgress?.({
        pagesCompleted,
        rowsDeleted,
        snapshotsCompleted,
        snapshotsTotal: targets.length,
      }) ?? Effect.void;
      if (page.complete) break;
      yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
    }
    if (index + 1 < targetBatches.length) {
      yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
    }
  }
});

export function makeRetiredSnapshotReclamationPage(sql: SqlClient.SqlClient, snapshotIds: readonly string[]) {
  const batchRowsByTable = new Map<string, number>();
  return Effect.gen(function* () {
    // Run inside the writer gate so lock contention cannot shrink the next page.
    const startedAt = yield* Clock.currentTimeMillis;
    const page = yield* sql.withTransaction(reclaimRetiredSnapshotPage(sql, snapshotIds, batchRowsByTable));
    if (page.table !== undefined) {
      batchRowsByTable.set(
        page.table,
        Math.min(
          page.maximumBatchRows,
          nextPersistentActivationBatchRows(
            page.batchRows,
            Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
            page.maximumBatchRows,
          ),
        ),
      );
    }
    return {complete: page.complete, rowsDeleted: page.rowsDeleted};
  });
}

const reclaimRetiredSnapshotPage = Effect.fn('codeGraph.reclaimRetiredSnapshotPage')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
  batchRowsByTable: ReadonlyMap<string, number> = new Map(),
) {
  const now = yield* Clock.currentTimeMillis;
  const snapshotPlaceholders = snapshotIds.map(() => '?').join(', ');
  const compactTargets = yield* sql.unsafe<CompactLexicalSnapshotKeyRow & {readonly snapshot_id: string}>(
    `SELECT compact.snapshot_key, compact.snapshot_id
     FROM lexical_compact_snapshots AS compact
     JOIN snapshots AS snapshot ON snapshot.id = compact.snapshot_id
     WHERE snapshot.id IN (${snapshotPlaceholders})
       AND snapshot.state = 'retired'
       AND snapshot.id NOT IN (SELECT snapshot_id FROM active_snapshots)
       AND snapshot.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?)
       AND snapshot.id NOT IN (
         SELECT base_snapshot_id
         FROM snapshots
         WHERE base_snapshot_id IS NOT NULL
           AND id IN (
             SELECT snapshot_id FROM active_snapshots
             UNION
             SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?
           )
       )
     ORDER BY compact.snapshot_id
     LIMIT 1`,
    [...snapshotIds, now, now],
  );
  const compactTarget = compactTargets[0];
  if (compactTarget !== undefined) {
    const compactSnapshotKey = yield* validatedCompactLexicalCount(compactTarget.snapshot_key, 'cleanup snapshot key');
    for (const spec of COMPACT_LEXICAL_CLEANUP_SPECS) {
      const batchRows = batchRowsByTable.get(spec.table) ?? spec.batchRows;
      const statement = compactLexicalCleanupPageStatement(spec, compactSnapshotKey, batchRows, Option.none());
      yield* sql.unsafe(statement.text, statement.parameters);
      const deleted = yield* lastStatementChangeCount(sql);
      if (deleted > 0)
        return {
          complete: false,
          rowsDeleted: deleted,
          table: spec.table,
          batchRows,
          maximumBatchRows: spec.maximumBatchRows,
        };
    }
    yield* sql.unsafe('DELETE FROM lexical_storage_formats WHERE snapshot_id = ?', [compactTarget.snapshot_id]);
    const formatsDeleted = yield* lastStatementChangeCount(sql);
    yield* sql.unsafe('DELETE FROM lexical_compact_snapshots WHERE snapshot_key = ? AND snapshot_id = ?', [
      compactSnapshotKey,
      compactTarget.snapshot_id,
    ]);
    const snapshotsDeleted = yield* lastStatementChangeCount(sql);
    const metadataDeleted = formatsDeleted + snapshotsDeleted;
    if (metadataDeleted > 0) return {complete: false, rowsDeleted: metadataDeleted};
  }
  for (const spec of RETIRED_SNAPSHOT_CLEANUP_SPECS) {
    if (spec.table === LEGACY_BUILDING_REFERENCES_V3_TABLE && !(yield* tableExists(sql, spec.table))) continue;
    const batchRows = batchRowsByTable.get(spec.table) ?? spec.batchRows;
    const key = `(${spec.keyColumns.join(', ')})`;
    yield* sql.unsafe(
      `DELETE FROM ${spec.table}
       WHERE ${key} IN (
         SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
         FROM ${spec.table} AS candidate
         JOIN snapshots AS snapshot ON snapshot.id = candidate.snapshot_id
         WHERE candidate.snapshot_id IN (${snapshotPlaceholders})
           AND snapshot.state = 'retired'
           AND snapshot.id NOT IN (SELECT snapshot_id FROM active_snapshots)
           AND snapshot.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?)
           AND snapshot.id NOT IN (
             SELECT base_snapshot_id
             FROM snapshots
             WHERE base_snapshot_id IS NOT NULL
               AND id IN (
                 SELECT snapshot_id FROM active_snapshots
                 UNION
                 SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?
               )
           )
         ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
         LIMIT ?
       )`,
      [...snapshotIds, now, now, batchRows],
    );
    const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
    const deleted = Number(changes[0]?.count ?? 0);
    if (!Number.isSafeInteger(deleted) || deleted < 0) {
      return yield* CodeGraphStoreError.of('Retired snapshot cleanup returned an invalid row count.');
    }
    if (deleted > 0)
      return {
        complete: false,
        rowsDeleted: deleted,
        table: spec.table,
        batchRows,
        maximumBatchRows: spec.maximumBatchRows,
      };
  }
  yield* sql.unsafe(
    `DELETE FROM snapshots
     WHERE id IN (
       SELECT snapshot.id
       FROM snapshots AS snapshot
       WHERE snapshot.id IN (${snapshotPlaceholders})
         AND snapshot.state = 'retired'
         AND snapshot.id NOT IN (SELECT snapshot_id FROM active_snapshots)
         AND snapshot.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?)
         AND snapshot.id NOT IN (
           SELECT base_snapshot_id
           FROM snapshots
           WHERE base_snapshot_id IS NOT NULL
             AND id IN (
               SELECT snapshot_id FROM active_snapshots
               UNION
               SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?
             )
         )
       ORDER BY snapshot.id
       LIMIT 100
     )`,
    [...snapshotIds, now, now],
  );
  const removed = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
  const removedCount = Number(removed[0]?.count ?? 0);
  if (!Number.isSafeInteger(removedCount) || removedCount < 0) {
    return yield* CodeGraphStoreError.of('Retired snapshot cleanup returned an invalid count.');
  }
  const remaining = yield* sql.unsafe<{readonly present: number}>(
    `SELECT EXISTS(
       SELECT 1
       FROM snapshots AS snapshot
       WHERE snapshot.id IN (${snapshotPlaceholders})
         AND snapshot.state = 'retired'
         AND snapshot.id NOT IN (SELECT snapshot_id FROM active_snapshots)
         AND snapshot.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?)
         AND snapshot.id NOT IN (
           SELECT base_snapshot_id
           FROM snapshots
           WHERE base_snapshot_id IS NOT NULL
             AND id IN (
               SELECT snapshot_id FROM active_snapshots
               UNION
               SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?
             )
         )
       LIMIT 1
     ) AS present`,
    [...snapshotIds, now, now],
  );
  return {complete: Number(remaining[0]?.present ?? 0) === 0, rowsDeleted: removedCount};
});

const prepareActivationTables = Effect.fn('codeGraph.prepareActivationTables')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA temp_store = FILE');
  yield* sql.unsafe('PRAGMA temp.cache_size = -64');
  yield* sql.unsafe('PRAGMA temp.cache_spill = 16');
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      raw_content_hash TEXT,
      language TEXT NOT NULL,
      mode TEXT NOT NULL,
      size INTEGER NOT NULL,
      source TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbols (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      arity INTEGER,
      lookup_keys_json TEXT NOT NULL,
      resolution_domain TEXT,
      resolution_scope_id TEXT,
      package_name TEXT,
      exported INTEGER NOT NULL,
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_scopes (
      id TEXT PRIMARY KEY,
      build_system TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_components (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      build_system TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      languages_json TEXT NOT NULL,
      source_roots_json TEXT NOT NULL,
      workspace_roots_json TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_dependencies (
      source_component_id TEXT NOT NULL,
      target_component_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      evidence TEXT,
      PRIMARY KEY (source_component_id, target_component_id, provenance)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_external_dependencies (
      source_component_id TEXT NOT NULL,
      ecosystem TEXT NOT NULL,
      package_name TEXT NOT NULL,
      import_alias TEXT NOT NULL,
      dependency_kind TEXT NOT NULL,
      version_constraint TEXT NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT,
      PRIMARY KEY (
        source_component_id, ecosystem, package_name, import_alias, dependency_kind,
        version_constraint, evidence_path
      )
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_monikers (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      scheme TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      identity TEXT NOT NULL,
      package_name TEXT,
      package_version TEXT,
      import_path TEXT,
      qualified_name TEXT,
      component_id TEXT,
      symbol_id TEXT,
      dependency_kind TEXT,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbol_lookup (
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (lookup_key, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_references (
      edge_id TEXT PRIMARY KEY,
      resolution_domain TEXT NOT NULL,
      exported_only INTEGER NOT NULL,
      alias_lookup_keys_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_reexport_provenance (
      source_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      imported_name TEXT NOT NULL,
      PRIMARY KEY (source_path, local_name, target_path, imported_name)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_reference_candidates (
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      lookup_key TEXT NOT NULL,
      PRIMARY KEY (edge_id, tier, lookup_key)
    ) WITHOUT ROWID
  `);
  // Resolution is explicitly bounded by an edge-id range. The table primary
  // key serves that access path, while activation_symbol_lookup serves the
  // lookup-key join. A second lookup-key-first index was never selected by the
  // resolver and doubled random B-tree maintenance during full ingestion.
  yield* sql.unsafe('DROP INDEX IF EXISTS temp.activation_reference_candidates_lookup');
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_resolved_reference_batch (
      old_edge_id TEXT PRIMARY KEY,
      new_edge_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL
    ) WITHOUT ROWID
  `);
  yield* prepareAnalysisResolutionTables(sql);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbol_terms (
      term TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (term, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(
    'CREATE TEMP TABLE IF NOT EXISTS activation_changed_symbol_ids (id TEXT PRIMARY KEY) WITHOUT ROWID',
  );
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_incremental_paths (
      path TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('DELETE FROM activation_state');
  yield* sql.unsafe('DELETE FROM activation_files');
  yield* sql.unsafe('DELETE FROM activation_workspace_scopes');
  yield* sql.unsafe('DELETE FROM activation_workspace_components');
  yield* sql.unsafe('DELETE FROM activation_workspace_dependencies');
  yield* sql.unsafe('DELETE FROM activation_workspace_external_dependencies');
  yield* sql.unsafe('DELETE FROM activation_monikers');
  yield* sql.unsafe('DELETE FROM activation_symbols');
  yield* sql.unsafe('DELETE FROM activation_symbol_lookup');
  yield* sql.unsafe('DELETE FROM activation_edges');
  yield* sql.unsafe('DELETE FROM activation_references');
  yield* sql.unsafe('DELETE FROM activation_reexport_provenance');
  yield* sql.unsafe('DELETE FROM activation_reference_candidates');
  yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
  yield* sql.unsafe('DELETE FROM activation_analysis_edge_affected_ids');
  yield* sql.unsafe('DELETE FROM activation_analysis_edge_before');
  yield* sql.unsafe('DELETE FROM activation_symbol_terms');
  yield* sql.unsafe('DELETE FROM activation_changed_symbol_ids');
  yield* sql.unsafe('DELETE FROM activation_incremental_paths');
});

const copyActivationCompactLexicalFacts = Effect.fn('codeGraph.copyActivationCompactLexicalFacts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  selection: CompactActivationSymbolSelection,
) {
  const snapshotKey = yield* ensureCompactLexicalSnapshot(sql, snapshotId);
  const symbolJoin =
    selection === 'changed' ? 'JOIN activation_changed_symbol_ids AS changed ON changed.id = symbol.id' : '';
  const termJoin =
    selection === 'changed' ? 'JOIN activation_changed_symbol_ids AS changed ON changed.id = posting.symbol_id' : '';
  yield* sql.unsafe(
    `INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id)
     SELECT ?, symbol.id
     FROM activation_symbols AS symbol
     ${symbolJoin}
     ORDER BY symbol.id`,
    [snapshotKey],
  );
  const symbolCount = yield* lastStatementChangeCount(sql);
  yield* sql.unsafe(
    `INSERT OR IGNORE INTO lexical_compact_terms (snapshot_key, term)
     SELECT DISTINCT ?, posting.term
     FROM activation_symbol_terms AS posting
     ${termJoin}
     ORDER BY posting.term`,
    [snapshotKey],
  );
  const termCount = yield* lastStatementChangeCount(sql);
  yield* sql.unsafe(
    `INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
     SELECT ?, terms.term_key, symbols.symbol_key, posting.weight
     FROM activation_symbol_terms AS posting
     ${termJoin}
     JOIN lexical_compact_terms AS terms
       ON terms.snapshot_key = ? AND terms.term = posting.term
     JOIN lexical_compact_symbols AS symbols
       ON symbols.snapshot_key = ? AND symbols.symbol_id = posting.symbol_id
     ORDER BY terms.term_key, symbols.symbol_key`,
    [snapshotKey, snapshotKey, snapshotKey],
  );
  const postingCount = yield* lastStatementChangeCount(sql);
  const expectedRows = yield* sql.unsafe<{readonly count: number | bigint}>(
    `SELECT COUNT(*) AS count
     FROM activation_symbol_terms AS posting
     ${termJoin}`,
  );
  const expectedPostings = yield* validatedCompactLexicalCount(expectedRows[0]?.count ?? 0, 'staged posting count');
  if (postingCount !== expectedPostings) {
    return yield* CodeGraphStoreError.of(
      `Compact lexical activation lost ${expectedPostings - postingCount} posting(s).`,
    );
  }
  return {postingCount, symbolCount, termCount} satisfies CompactLexicalFormatReceipt;
});

function stageActivationReferences(
  sql: SqlClient.SqlClient,
  references: readonly CodeGraphReference[],
  mode: ActivationInsertMode = 'upsert',
  observer?: ActivationStagingObserver,
) {
  return Effect.gen(function* () {
    const boundedReferences = references.filter(isCodeGraphReferenceWithinCandidateBudget);
    yield* observer?.('references', 0, true) ?? Effect.void;
    for (const batch of chunk(
      sortedBy(boundedReferences, reference => reference.edgeId),
      ACTIVATION_REFERENCE_BATCH_ROWS,
    )) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO activation_references (
          edge_id, resolution_domain, exported_only, alias_lookup_keys_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(reference => [
          reference.edgeId,
          reference.resolutionDomain,
          reference.exportedOnly === true ? 1 : 0,
          JSON.stringify(reference.aliasLookupKeys ?? []),
        ]),
      );
      yield* observer?.('references', batch.length) ?? Effect.void;
      const candidates = [
        ...uniqueBy(
          batch.flatMap(reference =>
            reference.lookupTiers.flatMap((tier, tierIndex) =>
              tier.map(key => [reference.edgeId, tierIndex, key] as const),
            ),
          ),
          row => `${row[0]}\0${row[1]}\0${row[2]}`,
        ),
      ].sort(
        (left, right) =>
          compareCodeUnits(left[0], right[0]) || left[1] - right[1] || compareCodeUnits(left[2], right[2]),
      );
      yield* observer?.('reference-candidates', 0, true) ?? Effect.void;
      for (const candidateBatch of chunk(candidates, ACTIVATION_REFERENCE_CANDIDATE_BATCH_ROWS)) {
        yield* sql.unsafe(
          `${activationInsertClause(mode)} INTO activation_reference_candidates (
            edge_id, tier, lookup_key
          ) VALUES ${candidateBatch.map(() => '(?, ?, ?)').join(', ')}`,
          candidateBatch.flat(),
        );
        yield* observer?.('reference-candidates', candidateBatch.length) ?? Effect.void;
      }
      const reexports = [
        ...uniqueBy(batch.flatMap(normalizedReexportProvenance), reexport =>
          [reexport.sourcePath, reexport.localName, reexport.targetPath, reexport.importedName].join('\0'),
        ),
      ].sort(
        (left, right) =>
          compareCodeUnits(left.sourcePath, right.sourcePath) ||
          compareCodeUnits(left.localName, right.localName) ||
          compareCodeUnits(left.targetPath, right.targetPath) ||
          compareCodeUnits(left.importedName, right.importedName),
      );
      yield* observer?.('reexports', 0, true) ?? Effect.void;
      for (const reexportBatch of chunk(reexports, ACTIVATION_REFERENCE_BATCH_ROWS)) {
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO activation_reexport_provenance (
            source_path, local_name, target_path, imported_name
          ) VALUES ${reexportBatch.map(() => '(?, ?, ?, ?)').join(', ')}`,
          reexportBatch.flatMap(reexport => [
            reexport.sourcePath,
            reexport.localName,
            reexport.targetPath,
            reexport.importedName,
          ]),
        );
        yield* observer?.('reexports', reexportBatch.length) ?? Effect.void;
      }
    }
    yield* observer?.('references', 0, true) ?? Effect.void;
    yield* observer?.('reference-candidates', 0, true) ?? Effect.void;
    yield* observer?.('reexports', 0, true) ?? Effect.void;
  });
}

function stageActivationMonikers(
  sql: SqlClient.SqlClient,
  monikers: readonly CodeGraphMonikerV1[],
  mode: ActivationInsertMode = 'insert',
) {
  return Effect.gen(function* () {
    for (const batch of chunk(canonicalCodeGraphMonikers(monikers), 500)) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO activation_monikers (
          id, version, scheme, role, kind, resolution_domain, identity,
          package_name, package_version, import_path, qualified_name, component_id,
          symbol_id, dependency_kind, evidence_path, evidence_span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(moniker => [
          moniker.id,
          moniker.version,
          moniker.scheme,
          moniker.role,
          moniker.kind,
          moniker.resolutionDomain,
          moniker.identity,
          'packageName' in moniker ? (moniker.packageName ?? null) : null,
          'packageVersion' in moniker ? (moniker.packageVersion ?? null) : null,
          'importPath' in moniker ? (moniker.importPath ?? null) : null,
          'qualifiedName' in moniker ? (moniker.qualifiedName ?? null) : null,
          'componentId' in moniker ? (moniker.componentId ?? null) : null,
          'symbolId' in moniker ? (moniker.symbolId ?? null) : null,
          'dependencyKind' in moniker ? (moniker.dependencyKind ?? null) : null,
          moniker.evidence.path,
          JSON.stringify(moniker.evidence.span),
        ]),
      );
    }
  });
}

function stageSnapshotMonikers(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  monikers: readonly CodeGraphMonikerV1[],
  mode: ActivationInsertMode = 'insert',
) {
  return Effect.gen(function* () {
    for (const batch of chunk(codeGraphMaterializationMonikerRows(monikers), 500)) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO code_graph_monikers (
          snapshot_id, id, version, scheme, role, kind, resolution_domain, identity,
          package_name, package_version, import_path, qualified_name, component_id,
          symbol_id, dependency_kind, evidence_path, evidence_span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(moniker => [
          snapshotId,
          moniker.id,
          moniker.version,
          moniker.scheme,
          moniker.role,
          moniker.kind,
          moniker.resolutionDomain,
          moniker.identity,
          moniker.packageName,
          moniker.packageVersion,
          moniker.importPath,
          moniker.qualifiedName,
          moniker.componentId,
          moniker.symbolId,
          moniker.dependencyKind,
          moniker.evidencePath,
          moniker.evidenceSpanJson,
        ]),
      );
    }
  });
}

const persistedFullBatchFingerprint = Effect.fn('codeGraph.persistedFullBatchFingerprint')(function* (
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
  monikers: readonly CodeGraphMonikerV1[] = [],
) {
  const digest = new Bun.CryptoHasher('sha256');
  let rows = 0;
  const update = (kind: 'edge' | 'moniker' | 'reference' | 'symbol', value: readonly unknown[]) => {
    digest.update(kind);
    digest.update('\0');
    digest.update(JSON.stringify(value));
    digest.update('\n');
  };
  for (const edge of sortedBy(edges, edge => edge.id)) {
    update('edge', [
      edge.id,
      edge.sourceId,
      edge.sourceName,
      edge.relation,
      edge.targetId,
      edge.targetName,
      edge.provenance,
      edge.confidence,
      edge.evidencePath,
      edge.evidenceSpan,
    ]);
    if ((rows += 1) % 1_024 === 0) yield* Effect.yieldNow;
  }
  for (const reference of sortedBy(references, reference => reference.edgeId)) {
    update('reference', [
      reference.edgeId,
      reference.resolutionDomain,
      reference.exportedOnly === true,
      reference.lookupTiers,
      reference.aliasLookupKeys ?? [],
      reference.relation,
      reference.evidencePath,
    ]);
    if ((rows += 1) % 1_024 === 0) yield* Effect.yieldNow;
  }
  for (const moniker of canonicalCodeGraphMonikers(monikers)) {
    update('moniker', [moniker]);
    if ((rows += 1) % 1_024 === 0) yield* Effect.yieldNow;
  }
  for (const symbol of sortedBy(symbols, symbol => symbol.id)) {
    update('symbol', [
      symbol.id,
      symbol.contentHash,
      symbol.kind,
      symbol.name,
      symbol.qualifiedName,
      symbol.path,
      symbol.language,
      symbol.packageName,
      symbol.arity,
      symbol.lookupKeys ?? [],
      symbol.resolutionDomain,
      symbol.resolutionScopeId,
      symbol.exported,
      symbol.signature,
      symbol.documentation,
      symbol.span,
    ]);
    if ((rows += 1) % 1_024 === 0) yield* Effect.yieldNow;
  }
  return digest.digest('hex');
});

interface PersistedFullBatchReceipt {
  readonly batch_fingerprint: string;
  readonly candidate_count: number;
  readonly edge_count: number;
  readonly lookup_count: number;
  readonly reference_count: number;
  readonly reexport_count: number;
  readonly symbol_count: number;
  readonly term_count: number;
}

interface AnalysisEdgeHistogramDelta {
  readonly confidence: number;
  readonly count: number;
  readonly endpointState: 0 | 1 | 2;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
}

const stagePersistedAnalysisBatch = Effect.fn('codeGraph.stagePersistedAnalysisBatch')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  batchIndex: number,
  batchFingerprint: string,
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
) {
  const existing = yield* sql<PersistedAnalysisBatchReceipt>`
    SELECT batch_fingerprint, symbol_count, edge_count
    FROM building_analysis_batches
    WHERE snapshot_id = ${snapshotId} AND batch_index = ${batchIndex}
    LIMIT 1
  `;
  if (existing[0]) {
    if (
      existing[0].batch_fingerprint !== batchFingerprint ||
      Number(existing[0].symbol_count) !== symbols.length ||
      Number(existing[0].edge_count) !== edges.length
    ) {
      return yield* CodeGraphStoreError.of('Persisted analysis batch contents changed; discard and rebuild it.');
    }
    return;
  }

  const symbolCounts = new Map<string, {count: number; kind: string; language: string}>();
  for (const symbol of symbols) {
    const key = `${symbol.language}\0${symbol.kind}`;
    const current = symbolCounts.get(key) ?? {count: 0, kind: symbol.kind, language: symbol.language};
    current.count += 1;
    symbolCounts.set(key, current);
  }
  for (const batch of chunk([...symbolCounts.values()], 400)) {
    yield* sql.unsafe(
      `INSERT INTO snapshot_analysis_symbol_counts (snapshot_id, language, kind, count)
       VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}
       ON CONFLICT(snapshot_id, language, kind) DO UPDATE SET
         count = snapshot_analysis_symbol_counts.count + excluded.count`,
      batch.flatMap(row => [snapshotId, row.language, row.kind, row.count]),
    );
  }

  const edgeCounts = aggregateEdgeHistogram(edges);
  for (const batch of chunk(edgeCounts, 400)) {
    yield* sql.unsafe(
      `INSERT INTO snapshot_analysis_edge_histogram (
         snapshot_id, provenance, relation, confidence, endpoint_state, count
       ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT(snapshot_id, provenance, relation, confidence, endpoint_state) DO UPDATE SET
         count = snapshot_analysis_edge_histogram.count + excluded.count`,
      batch.flatMap(row => [snapshotId, row.provenance, row.relation, row.confidence, row.endpointState, row.count]),
    );
  }
  yield* sql`
    INSERT INTO building_analysis_batches (
      snapshot_id, batch_index, batch_fingerprint, symbol_count, edge_count, completed_at
    ) VALUES (
      ${snapshotId}, ${batchIndex}, ${batchFingerprint}, ${symbols.length}, ${edges.length},
      ${DateTime.formatIso(yield* DateTime.now)}
    )
  `;
});

function aggregateEdgeHistogram(edges: readonly CodeGraphEdge[]): readonly AnalysisEdgeHistogramDelta[] {
  const counts = new Map<string, AnalysisEdgeHistogramDelta>();
  for (const edge of edges) {
    const endpointState = analysisEndpointState(edge.sourceId, edge.targetId);
    const key = `${edge.provenance}\0${edge.relation}\0${edge.confidence}\0${endpointState}`;
    const current = counts.get(key);
    counts.set(
      key,
      current
        ? {...current, count: current.count + 1}
        : {
            confidence: edge.confidence,
            count: 1,
            endpointState,
            provenance: edge.provenance,
            relation: edge.relation,
          },
    );
  }
  return [...counts.values()].sort(
    (left, right) =>
      compareCodeUnits(left.provenance, right.provenance) ||
      compareCodeUnits(left.relation, right.relation) ||
      left.confidence - right.confidence ||
      left.endpointState - right.endpointState,
  );
}

function analysisEndpointState(sourceId: string | undefined, targetId: string | undefined): 0 | 1 | 2 {
  if (sourceId === undefined || targetId === undefined) return 1;
  return sourceId === targetId ? 2 : 0;
}

const REEXPORT_CLOSURE_SEED_PAGE_ROWS = 100;

const REEXPORT_CLOSURE_PAGE_MAXIMUM_ROWS = 10_000;

export interface CodeGraphPersistentReferencePageLimits {
  readonly candidateCount: number;
  readonly payloadBytes: number;
  readonly references: number;
}

const snapshotPromotionLeaseCapacity = Effect.fn('codeGraph.snapshotPromotionLeaseCapacity')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
  now: number,
) {
  const candidates = [...new Set(snapshotIds)];
  let factBytes = 0;
  let rows = 0;
  for (const candidate of candidates) {
    const leaseRows = yield* sql.unsafe<BoundedSnapshotLeaseRow & {readonly lease_rowid: unknown}>(
      `SELECT
         CASE WHEN typeof(lease.rowid) = 'integer' AND lease.rowid BETWEEN 1 AND 9007199254740991
           THEN lease.rowid ELSE NULL END AS lease_rowid,
         ${boundedSnapshotLeaseProjection('lease')}
       FROM snapshot_leases AS lease INDEXED BY snapshot_leases_snapshot_expiry
       WHERE lease.snapshot_id = ? AND lease.expires_at > ?
       ORDER BY lease.expires_at
       LIMIT 1`,
      [candidate, now],
    );
    if (leaseRows.length === 0) continue;
    const lease = decodeSnapshotLeaseManifest(leaseRows[0]);
    if (
      lease === undefined ||
      lease.snapshotId !== candidate ||
      typeof leaseRows[0]?.lease_rowid !== 'number' ||
      !Number.isSafeInteger(leaseRows[0].lease_rowid) ||
      leaseRows[0].lease_rowid <= 0
    ) {
      return yield* CodeGraphStoreError.of('Ready snapshot promotion lease capacity is invalid.');
    }
    rows += 1;
    factBytes = saturatingCapacityAdd(
      factBytes,
      saturatingCapacityAdd(codeGraphUtf8ByteLength(lease.token), codeGraphUtf8ByteLength(candidate)),
    );
  }
  return {factBytes, rows};
});

export {
  copyActivationCompactLexicalFacts,
  snapshotPromotionLeaseCapacity,
  reclaimRetiredSnapshotPage,
  reclaimRetiredSnapshotRows,
  prepareActivationTables,
  persistedFullBatchFingerprint,
  PersistedFullBatchReceipt,
  AnalysisEdgeHistogramDelta,
  analysisEndpointState,
  aggregateEdgeHistogram,
  stagePersistedAnalysisBatch,
  CompactedReferenceLookupTiers,
  compactReferenceLookupTiers,
  parseTypeScriptPathNameLookupKey,
  normalizedReexportProvenance,
  stageActivationReferences,
  stageActivationMonikers,
  stageSnapshotMonikers,
  REEXPORT_CLOSURE_SEED_PAGE_ROWS,
  REEXPORT_CLOSURE_PAGE_MAXIMUM_ROWS,
};
