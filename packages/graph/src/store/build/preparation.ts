import {Clock, DateTime, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  codeGraphUtf8ByteLength,
  saturatingCapacityAdd,
  saturatingCapacityMultiply,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '../../disk/capacity.js';
import {
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES,
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES,
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS,
} from '../../incremental/work.js';
import {isCodeGraphReferenceWithinCandidateBudget} from '../../fact/budget.js';
import {compareCodeUnits} from '../../ordering.js';
import {type CodeGraphDirectPersistentCapacityProtector, type CodeGraphStagingBatch} from '../models.js';
import {configureConnection, configureReconstructibleBuildDurability} from '../session.js';
import {
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  type RepositoryIdentity,
  CodeGraphStoreError,
} from '../../types.js';
import {type CodeGraphWorkspace} from '../../languages/types.js';
import {
  ACTIVATION_FILE_BATCH_ROWS,
  ACTIVATION_REFERENCE_BATCH_ROWS,
  type ActivationStagingObserver,
  assertPersistentBuildOwner,
  CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
  type CodeGraphWriterGate,
  isPersistedIncrementalResolutionClosure,
  persistedIncrementalProjectFilesMatch,
  persistedIncrementalSurfaceMatches,
  persistentBoundTextBytes,
  persistentFullInventoryCapacityBoundary,
  prepareAnalysisResolutionTables,
  type PreparedPersistedFullFactBatch,
  type PreparedPersistedFullWorkspace,
  preparePersistedFullResolutionViews,
  retainKnownRawContentAliases,
  registerPersistentMaterializationPlan,
  type SnapshotPromotionCapacityPlan,
  stageActivationEdges,
  stageActivationFiles,
  stageActivationSymbols,
  stageActivationSymbolTerms,
} from './core.js';
import {clearSnapshotOwnedRows} from '../cleanup_core.js';
import {chunk, sortedBy, symbolTerms, uniqueBy} from '../utilities.js';
import {type CodeGraphSqlQueryStatement} from '../visualization_sql.js';
import {
  normalizedReexportProvenance,
  prepareActivationTables,
  snapshotPromotionLeaseCapacity,
  stageActivationMonikers,
  stageActivationReferences,
} from '../staging_core.js';
import {promotionRemovedSnapshotId, stagePersistedFullFacts} from '../resolution/core.js';
import {selectReusableBaseReceipt} from '../queries.js';
import {CODE_GRAPH_FOLD_FORWARD_RECEIPT_VERSION} from '../models.js';
import {
  codeGraphColdIndexDeferralWorthwhile,
  deferCodeGraphQueryIndexesForColdBuild,
} from '../cold_index_deferral.js';

/** @internal Exposed for deterministic SQLite snapshot-contract tests. */

/**
 * Superseded persistent builds can own repository-sized durable tables. Reclaim
 * their exact identities before the replacement build starts, one transaction
 * at a time. The writer gate is released between pages so linked worktrees can
 * make progress; unlike best-effort detached cleanup, this required path waits
 * through contention until every still-eligible target is gone.
 */

const preparePersistedFullActivation = Effect.fn('codeGraph.preparePersistedFullActivation')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  expectedBatchCount?: number,
  ownerToken?: string,
  writerGate?: CodeGraphWriterGate,
  persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
) {
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  if (ownerToken === undefined) {
    return yield* CodeGraphStoreError.of('Persistent full-build ownership is required.');
  }
  // Persistent full builds keep repository-sized facts in durable tables.
  // Their connection-private tables are bounded to one resolution page, so
  // retaining those small B-trees in memory avoids temp-file pager and journal
  // I/O without risking repository-proportional RSS.
  yield* sql.unsafe('PRAGMA temp_store = MEMORY');
  yield* configureReconstructibleBuildDurability(sql);
  yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
  const snapshots = yield* sql<{readonly state: CodeGraphSnapshot['state']}>`
    SELECT state FROM snapshots WHERE id = ${snapshotId} LIMIT 1
  `;
  const state = snapshots[0]?.state;
  if (state === undefined) {
    return yield* CodeGraphStoreError.of(`Building snapshot ${snapshotId} is unavailable.`);
  }
  if (state === 'ready' || state === 'retired') {
    return yield* CodeGraphStoreError.of(`Snapshot ${snapshotId} cannot be materialized from ${state}.`);
  }
  if (state === 'failed') {
    // A caught failure is explicitly discarded. A process interruption leaves
    // the snapshot in `building`, whose committed batch receipts are resumed.
    yield* clearSnapshotOwnedRows(sql, snapshotId, runWrite, ownerToken);
    yield* runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
          yield* sql`
          UPDATE snapshots
          SET state = 'building', file_count = 0, symbol_count = 0, edge_count = 0,
              completed_at = NULL, failure_summary = NULL
          WHERE id = ${snapshotId} AND state = 'failed'
        `;
        }),
      ),
    );
  }
  if (expectedBatchCount !== undefined) {
    if (!Number.isSafeInteger(expectedBatchCount) || expectedBatchCount < 0) {
      return yield* CodeGraphStoreError.of('Persistent materialization batch count is invalid.');
    }
    const planCapacity: CodeGraphDirectPersistentCapacityBoundary = {
      finalFactBytes: 0,
      operation: 'register persistent code graph materialization plan',
      rowCount: 2,
    };
    const planTransaction = runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
          yield* registerPersistentMaterializationPlan(sql, snapshotId, ownerToken, expectedBatchCount);
        }),
      ),
    );
    yield* persistentCapacityProtector ? persistentCapacityProtector(planCapacity, planTransaction) : planTransaction;
    const stale = yield* sql<{readonly count: number}>`
      SELECT COUNT(*) AS count
      FROM building_materialization_batches
      WHERE snapshot_id = ${snapshotId} AND batch_index >= ${expectedBatchCount}
    `;
    if (Number(stale[0]?.count ?? 0) > 0) {
      return yield* CodeGraphStoreError.of('Persisted full-build batch receipts no longer match the inventory.');
    }
  }

  for (const batch of chunk(
    sortedBy(files, file => file.path),
    ACTIVATION_FILE_BATCH_ROWS,
  )) {
    const retainedBatch = yield* retainKnownRawContentAliases(sql, batch);
    const inventoryCapacity = persistentFullInventoryCapacityBoundary(snapshotId, retainedBatch);
    const inventoryTransaction = runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
          yield* sql.unsafe(
            `INSERT OR IGNORE INTO snapshot_files (
             snapshot_id, path, content_hash, raw_content_hash, language, mode, size, source
           ) VALUES ${retainedBatch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
            retainedBatch.flatMap(file => [
              snapshotId,
              file.path,
              file.contentHash,
              file.rawContentHash ?? null,
              file.language,
              file.mode,
              file.size,
              file.source,
            ]),
          );
          const rows = yield* sql.unsafe<{
            readonly content_hash: string;
            readonly language: string;
            readonly mode: string;
            readonly path: string;
            readonly raw_content_hash: string | null;
            readonly size: number;
            readonly source: CodeGraphInventoryFile['source'];
          }>(
            `SELECT path, content_hash, raw_content_hash, language, mode, size, source
           FROM snapshot_files
           WHERE snapshot_id = ? AND path IN (${retainedBatch.map(() => '?').join(', ')})`,
            [snapshotId, ...retainedBatch.map(file => file.path)],
          );
          const stored = new Map(rows.map(row => [row.path, row]));
          const mismatch = retainedBatch.find(file => {
            const row = stored.get(file.path);
            return (
              row === undefined ||
              row.content_hash !== file.contentHash ||
              row.raw_content_hash !== (file.rawContentHash ?? null) ||
              row.language !== file.language ||
              row.mode !== file.mode ||
              Number(row.size) !== file.size ||
              row.source !== file.source
            );
          });
          if (mismatch) {
            return yield* CodeGraphStoreError.of(`Persisted full-build inventory changed at ${mismatch.path}.`);
          }
        }),
      ),
    );
    yield* persistentCapacityProtector
      ? persistentCapacityProtector(inventoryCapacity, inventoryTransaction)
      : inventoryTransaction;
    yield* Effect.yieldNow;
  }
  const fileCounts = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count FROM snapshot_files WHERE snapshot_id = ${snapshotId}
  `;
  if (Number(fileCounts[0]?.count ?? -1) !== files.length) {
    return yield* CodeGraphStoreError.of('Persisted full-build inventory contains stale extra files.');
  }

  // Only the resolution cursor remains connection-private. All repository-sized
  // surfaces are durable and keyed by the still-invisible building snapshot.
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `);
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
  yield* sql.unsafe('DELETE FROM activation_state');
  yield* sql`
    INSERT INTO activation_state (key, value)
    VALUES ('mode', 'persisted-full'), ('snapshot_id', ${snapshotId}), ('owner_token', ${ownerToken})
  `;
  yield* preparePersistedFullResolutionViews(sql);
  // Production full builds discover their final batch count while attributed
  // facts are decoded. Known-count callers retain the existing eager-index
  // contract; only the dynamically finalized path enters cold deferral.
  if (expectedBatchCount === undefined && codeGraphColdIndexDeferralWorthwhile(files)) {
    yield* deferCodeGraphQueryIndexesForColdBuild(sql, snapshotId, ownerToken, runWrite);
  }
});

// Stay comfortably below SQLite's cross-platform parameter ceiling while
// avoiding thousands of statement preparations on production-sized graphs.

function preparePersistedFullWorkspace(
  snapshotId: string,
  workspace: CodeGraphWorkspace,
): PreparedPersistedFullWorkspace {
  const workspaces = workspace.workspaces.map(scope => ({
    diagnosticsJson: JSON.stringify(scope.diagnostics),
    scope,
  }));
  const projects = workspace.projects.map(project => ({
    diagnosticsJson: JSON.stringify(project.diagnostics),
    languagesJson: JSON.stringify(project.languages),
    project,
    sourceRootsJson: JSON.stringify(project.sourceRoots),
    workspaceRootsJson: JSON.stringify(project.workspaceRoots),
  }));
  let finalFactBytes = 0;
  let rowCount = 0;
  for (const entry of workspaces) {
    const {scope} = entry;
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      scope.id,
      scope.buildSystem,
      scope.name,
      scope.root,
      scope.provenance,
      entry.diagnosticsJson,
    ]);
    rowCount = saturatingCapacityAdd(rowCount, 1);
  }
  for (const entry of projects) {
    const {project} = entry;
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      project.id,
      project.workspaceId,
      project.buildSystem,
      project.kind,
      project.name,
      project.root,
      project.resolutionDomain,
      entry.languagesJson,
      entry.sourceRootsJson,
      entry.workspaceRootsJson,
      project.provenance,
      entry.diagnosticsJson,
    ]);
    rowCount = saturatingCapacityAdd(rowCount, 1);
    for (const dependency of project.dependencyDetails) {
      finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
        snapshotId,
        project.id,
        dependency.targetId,
        dependency.provenance,
        dependency.evidence,
      ]);
      rowCount = saturatingCapacityAdd(rowCount, 1);
    }
    for (const dependency of project.externalDependencies ?? []) {
      finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
        snapshotId,
        project.id,
        dependency.ecosystem,
        dependency.name,
        dependency.importAlias,
        dependency.kind,
        dependency.versionConstraint,
        dependency.evidence.path,
        dependency.evidence.span === undefined ? undefined : JSON.stringify(dependency.evidence.span),
      ]);
      rowCount = saturatingCapacityAdd(rowCount, 1);
    }
    for (const moniker of project.monikers ?? []) {
      finalFactBytes = persistentBoundTextBytes(finalFactBytes, [snapshotId, JSON.stringify(moniker)]);
      rowCount = saturatingCapacityAdd(rowCount, 1);
    }
  }
  return {
    capacity: {finalFactBytes, operation: 'stage persistent code graph workspace', rowCount},
    projects,
    workspaces,
  };
}

/**
 * Explicit deep-maintenance audit. Normal publication trusts the cumulative
 * counters committed with each resumable batch and never scans every posting.
 * This statement intentionally performs exact counts for tests and operator-
 * initiated evidence collection.
 */
export function codeGraphCompactLexicalDeepAuditStatement(snapshotId: string): CodeGraphSqlQueryStatement {
  return {
    parameters: [snapshotId],
    text: `SELECT
      format.posting_count AS expected_posting_count,
      format.symbol_count AS expected_symbol_count,
      format.term_count AS expected_term_count,
      (SELECT COUNT(*) FROM lexical_compact_postings AS posting
       WHERE posting.snapshot_key = compact.snapshot_key) AS posting_count,
      (SELECT COUNT(*) FROM lexical_compact_symbols AS symbol
       WHERE symbol.snapshot_key = compact.snapshot_key) AS symbol_count,
      (SELECT COUNT(*) FROM lexical_compact_terms AS term
       WHERE term.snapshot_key = compact.snapshot_key) AS term_count
    FROM lexical_storage_formats AS format
    JOIN lexical_compact_snapshots AS compact ON compact.snapshot_id = format.snapshot_id
    WHERE format.snapshot_id = ?
      AND format.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
    LIMIT 1`,
  };
}

function preparePersistedFullFactCapacity(batches: readonly CodeGraphStagingBatch[]): {
  readonly batches: readonly PreparedPersistedFullFactBatch[];
  readonly capacity: CodeGraphDirectPersistentCapacityBoundary;
} {
  let finalFactBytes = 0;
  let validFactBytes = true;
  let rowCount = 0;
  const prepared: PreparedPersistedFullFactBatch[] = [];
  for (const batch of batches) {
    if (batch.finalFactBytes === undefined || !Number.isSafeInteger(batch.finalFactBytes) || batch.finalFactBytes < 0) {
      validFactBytes = false;
    } else {
      finalFactBytes = saturatingCapacityAdd(finalFactBytes, batch.finalFactBytes);
    }
    const boundedReferences = sortedBy(
      batch.references.filter(isCodeGraphReferenceWithinCandidateBudget),
      reference => reference.edgeId,
    );
    const lookupRows = batch.symbols.reduce(
      (total, symbol) => saturatingCapacityAdd(total, symbol.lookupKeys?.length ?? 0),
      0,
    );
    const termsBySymbol = new Map<CodeGraphSymbol, readonly (readonly [string, number])[]>();
    let termPostings = 0;
    for (const symbol of batch.symbols) {
      const terms = termsBySymbol.get(symbol) ?? symbolTerms(symbol);
      termsBySymbol.set(symbol, terms);
      // Count each staged occurrence even if malformed caller input repeats
      // the same object identity. The later primary-key failure must never be
      // preceded by an under-sized capacity boundary.
      termPostings = saturatingCapacityAdd(termPostings, terms.length);
    }
    const reexportsByReferenceBatch = [...chunk(boundedReferences, ACTIVATION_REFERENCE_BATCH_ROWS)].map(references =>
      [
        ...uniqueBy(references.flatMap(normalizedReexportProvenance), reexport =>
          [reexport.sourcePath, reexport.localName, reexport.targetPath, reexport.importedName].join('\0'),
        ),
      ].sort(
        (left, right) =>
          compareCodeUnits(left.sourcePath, right.sourcePath) ||
          compareCodeUnits(left.localName, right.localName) ||
          compareCodeUnits(left.targetPath, right.targetPath) ||
          compareCodeUnits(left.importedName, right.importedName),
      ),
    );
    const reexportRows = reexportsByReferenceBatch.reduce(
      (total, reexports) => saturatingCapacityAdd(total, reexports.length),
      0,
    );
    rowCount = saturatingCapacityAdd(
      rowCount,
      // Durable symbols and their compact lexical dictionary rows.
      saturatingCapacityMultiply(batch.symbols.length, 2),
      lookupRows,
      // One compact-snapshot row may be attempted for each logical batch.
      1,
      // Every posting writes one posting row and can introduce at most one
      // compact term row.
      saturatingCapacityMultiply(termPostings, 2),
      batch.edges.length,
      batch.monikers?.length ?? 0,
      boundedReferences.length,
      reexportRows,
      // Analysis symbol/histogram groups cannot exceed their source rows.
      batch.symbols.length,
      batch.edges.length,
      // Analysis receipt, materialization receipt, and lexical counter.
      3,
    );
    prepared.push({batch, boundedReferences, reexportsByReferenceBatch, symbolTerms: termsBySymbol});
  }
  return {
    batches: prepared,
    capacity: {
      finalFactBytes: validFactBytes ? finalFactBytes : Number.NaN,
      operation: 'stage persistent code graph facts',
      rowCount,
    },
  };
}

const stagePersistedFullFactBatches = Effect.fn('codeGraph.stagePersistedFullFactBatches')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  batches: readonly CodeGraphStagingBatch[],
  observerForBatch: (batchIndex: number) => ActivationStagingObserver,
  prepared?: readonly PreparedPersistedFullFactBatch[],
) {
  if (batches.length === 0) return;
  if (
    prepared &&
    (prepared.length !== batches.length || prepared.some((entry, index) => entry.batch !== batches[index]))
  ) {
    return yield* CodeGraphStoreError.of('Prepared persistent materialization batches no longer match staged batches.');
  }
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    if (!Number.isSafeInteger(batch.batchIndex) || batch.batchIndex < 0) {
      return yield* CodeGraphStoreError.of('Persistent materialization batch identity is invalid.');
    }
    if (index > 0 && batch.batchIndex !== batches[index - 1].batchIndex + 1) {
      return yield* CodeGraphStoreError.of('Persistent materialization transaction batches must be contiguous.');
    }
  }

  const observers = new Map<number, ActivationStagingObserver>();
  const observer = (batchIndex: number) => {
    const existing = observers.get(batchIndex);
    if (existing) return existing;
    const created = observerForBatch(batchIndex);
    observers.set(batchIndex, created);
    return created;
  };
  const commitBatch = batches[batches.length - 1];
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        yield* stagePersistedFullFacts(
          sql,
          snapshotId,
          ownerToken,
          batch.batchIndex,
          batch.symbols,
          batch.edges,
          batch.references,
          observer(batch.batchIndex),
          true,
          prepared?.[index],
          batch.monikers ?? [],
        );
      }
      // The physical commit belongs to the group, not to every logical
      // receipt. Attach its timing to the final receipt so per-stage evidence
      // cannot count later batch work once for every earlier observer.
      yield* observer(commitBatch.batchIndex)('committing', 0, true);
    }),
  );
  yield* observer(commitBatch.batchIndex)('committed', 0, true);
});

const preparePersistedIncrementalActivation = Effect.fn('codeGraph.preparePersistedIncrementalActivation')(function* (
  baseSnapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
  options: {
    readonly deletedPaths?: readonly string[];
    readonly foldForward?: {
      readonly snapshotId: string;
      readonly stagedPayloadBytes: number;
      readonly stagedRows: number;
    };
    readonly resolutionClosure?: 'changed' | 'full' | 'project';
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const resolutionClosure = options.resolutionClosure ?? 'changed';
  if (!isPersistedIncrementalResolutionClosure(resolutionClosure)) return false;
  const deletedPaths = [...new Set(options.deletedPaths ?? [])];
  if (
    (files.length === 0 && (resolutionClosure === 'changed' || deletedPaths.length === 0)) ||
    facts.length !== files.length
  ) {
    return false;
  }
  const paths = new Set(files.map(file => file.path));
  const factPaths = new Set(facts.map(file => file.path));
  if (
    paths.size !== files.length ||
    factPaths.size !== facts.length ||
    factPaths.size !== paths.size ||
    [...paths].some(path => !factPaths.has(path))
  ) {
    return false;
  }
  if (deletedPaths.some(path => paths.has(path))) return false;
  // A committed dirty full root carries the same reusable receipt contract as
  // a clean root; layered dirty overlays remain excluded by the receipt query.
  if (!(yield* selectReusableBaseReceipt(baseSnapshotId, true))) return false;

  yield* prepareActivationTables(sql);
  const freshPaths = [...paths, ...deletedPaths];
  const freshPayloadBytes = options.foldForward
    ? yield* Effect.try({
        catch: () => undefined,
        try: () => codeGraphUtf8ByteLength(JSON.stringify([files, facts, deletedPaths])),
      }).pipe(Effect.orElseSucceed(() => undefined))
    : 0;
  if (freshPayloadBytes === undefined) return false;
  const foldForwardPaths = options.foldForward
    ? yield* stageFoldForwardCarry(sql, baseSnapshotId, options.foldForward, freshPaths, freshPayloadBytes)
    : undefined;
  if (options.foldForward && foldForwardPaths === undefined) {
    yield* prepareActivationTables(sql);
    return false;
  }
  const incrementalPaths = [...new Set([...(foldForwardPaths ?? []), ...freshPaths])].sort(compareCodeUnits);
  if (incrementalPaths.length > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES) {
    yield* prepareActivationTables(sql);
    return false;
  }
  for (const batch of chunk(incrementalPaths, ACTIVATION_FILE_BATCH_ROWS)) {
    yield* sql.unsafe(
      `INSERT INTO activation_incremental_paths (path)
       VALUES ${batch.map(() => '(?)').join(', ')}`,
      batch,
    );
  }
  yield* stageActivationFiles(sql, files);
  const symbols = facts.flatMap(file => file.symbols);
  yield* stageActivationSymbols(sql, symbols);
  yield* stageActivationSymbolTerms(sql, symbols);
  yield* stageActivationEdges(
    sql,
    facts.flatMap(file => file.edges),
  );
  yield* stageActivationReferences(
    sql,
    facts.flatMap(file => file.references ?? []),
  );
  yield* stageActivationMonikers(
    sql,
    facts.flatMap(file => file.monikers ?? []),
  );
  const stagedRowCounts = yield* sql<{readonly count: number}>`
    SELECT
      (SELECT COUNT(*) FROM activation_incremental_paths)
      + (SELECT COUNT(*) FROM activation_files)
      + (SELECT COUNT(*) FROM activation_symbols)
      + (SELECT COUNT(*) FROM activation_symbol_lookup)
      + (SELECT COUNT(*) FROM activation_symbol_terms)
      + (SELECT COUNT(*) FROM activation_edges)
      + (SELECT COUNT(*) FROM activation_references)
      + (SELECT COUNT(*) FROM activation_reference_candidates)
      + (SELECT COUNT(*) FROM activation_reexport_provenance)
      + (SELECT COUNT(*) FROM activation_monikers) AS count
  `;
  const stagedRows = Number(stagedRowCounts[0]?.count ?? Number.NaN);
  if (
    !Number.isSafeInteger(stagedRows) ||
    stagedRows <= 0 ||
    stagedRows > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS
  ) {
    yield* prepareActivationTables(sql);
    return false;
  }
  const safe =
    resolutionClosure === 'changed'
      ? yield* persistedIncrementalSurfaceMatches(sql, baseSnapshotId)
      : resolutionClosure === 'project'
        ? yield* persistedIncrementalProjectFilesMatch(sql, baseSnapshotId)
        : true;
  if (!safe) {
    yield* prepareActivationTables(sql);
    return false;
  }
  yield* sql`
    INSERT INTO activation_state (key, value)
    VALUES
      ('mode', 'persisted-delta'),
      ('base_snapshot_id', ${baseSnapshotId}),
      ('resolution_closure', ${resolutionClosure})
  `;
  return true;
});

const stageFoldForwardCarry = Effect.fn('codeGraph.stageFoldForwardCarry')(function* (
  sql: SqlClient.SqlClient,
  rootSnapshotId: string,
  expected: {readonly snapshotId: string; readonly stagedPayloadBytes: number; readonly stagedRows: number},
  freshPaths: readonly string[],
  freshPayloadBytes: number,
) {
  if (
    !Number.isSafeInteger(expected.stagedPayloadBytes) ||
    expected.stagedPayloadBytes < 0 ||
    !Number.isSafeInteger(expected.stagedRows) ||
    expected.stagedRows <= 0
  ) {
    return undefined;
  }
  const receipts = yield* sql<{
    readonly delta_path_count: number;
    readonly lookup_count: number;
    readonly reexport_count: number;
    readonly staged_payload_bytes: number;
    readonly staged_row_count: number;
  }>`
    SELECT proof.delta_path_count, proof.staged_row_count, proof.staged_payload_bytes,
      proof.lookup_count, proof.reexport_count
    FROM snapshot_fold_forward_receipts AS proof
    JOIN snapshots AS logical ON logical.id = proof.snapshot_id
    JOIN snapshots AS root ON root.id = proof.root_snapshot_id
    JOIN snapshot_reuse_receipts AS logical_receipt ON logical_receipt.snapshot_id = logical.id
    JOIN snapshot_reuse_receipts AS root_receipt ON root_receipt.snapshot_id = root.id
    WHERE proof.snapshot_id = ${expected.snapshotId}
      AND proof.root_snapshot_id = ${rootSnapshotId}
      AND proof.format_version = ${CODE_GRAPH_FOLD_FORWARD_RECEIPT_VERSION}
      AND logical.state = 'ready' AND logical.dirty = 0
      AND logical.base_snapshot_id = root.id
      AND root.state = 'ready' AND root.dirty = 0 AND root.base_snapshot_id IS NULL
      AND logical.extractor_set = root.extractor_set
      AND logical_receipt.workspace_fingerprint = root_receipt.workspace_fingerprint
      AND logical_receipt.file_set_fingerprint = root_receipt.file_set_fingerprint
    LIMIT 1
  `;
  const receipt = receipts[0];
  if (
    !receipt ||
    Number(receipt.staged_row_count) !== expected.stagedRows ||
    Number(receipt.staged_payload_bytes) !== expected.stagedPayloadBytes ||
    expected.stagedRows > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS ||
    expected.stagedPayloadBytes > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES
  ) {
    return undefined;
  }
  const priorPathRows = yield* sql<{readonly path: string}>`
    SELECT path FROM snapshot_fold_forward_paths
    WHERE snapshot_id = ${expected.snapshotId}
    ORDER BY path
  `;
  const priorPaths = priorPathRows.map(row => row.path);
  if (
    priorPaths.length !== Number(receipt.delta_path_count) ||
    priorPaths.length === 0 ||
    priorPaths.length > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES
  ) {
    return undefined;
  }
  const integrity = yield* sql<{
    readonly lookup_count: number;
    readonly reexport_count: number;
    readonly reexport_mismatch: number;
    readonly staged_rows: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM snapshot_fold_forward_symbol_lookup
       WHERE snapshot_id = ${expected.snapshotId}) AS lookup_count,
      (SELECT COUNT(*) FROM snapshot_reexport_provenance
       WHERE snapshot_id = ${expected.snapshotId}) AS reexport_count,
      (EXISTS (
        SELECT source_path, local_name, target_path, imported_name
        FROM snapshot_reexport_provenance
        WHERE snapshot_id = ${expected.snapshotId}
        EXCEPT
        SELECT root.source_path, root.local_name, root.target_path, root.imported_name
        FROM snapshot_fold_forward_paths AS path
        JOIN snapshot_reexport_provenance AS root
          ON root.snapshot_id = ${rootSnapshotId} AND root.source_path = path.path
        WHERE path.snapshot_id = ${expected.snapshotId}
      ) OR EXISTS (
        SELECT root.source_path, root.local_name, root.target_path, root.imported_name
        FROM snapshot_fold_forward_paths AS path
        JOIN snapshot_reexport_provenance AS root
          ON root.snapshot_id = ${rootSnapshotId} AND root.source_path = path.path
        WHERE path.snapshot_id = ${expected.snapshotId}
        EXCEPT
        SELECT source_path, local_name, target_path, imported_name
        FROM snapshot_reexport_provenance
        WHERE snapshot_id = ${expected.snapshotId}
      )) AS reexport_mismatch,
      (SELECT COUNT(*) FROM snapshot_fold_forward_paths WHERE snapshot_id = ${expected.snapshotId})
        + (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = ${expected.snapshotId})
        + (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ${expected.snapshotId})
        + (SELECT COUNT(*) FROM snapshot_fold_forward_symbol_lookup WHERE snapshot_id = ${expected.snapshotId})
        + (SELECT COUNT(*)
           FROM lexical_compact_snapshots AS compact
           JOIN lexical_compact_postings AS posting ON posting.snapshot_key = compact.snapshot_key
           WHERE compact.snapshot_id = ${expected.snapshotId})
        + (SELECT COUNT(*) FROM edges WHERE snapshot_id = ${expected.snapshotId})
        + (SELECT COUNT(*) FROM snapshot_reexport_provenance WHERE snapshot_id = ${expected.snapshotId})
        + (SELECT COUNT(*) FROM code_graph_monikers
           WHERE snapshot_id = ${expected.snapshotId} AND scheme <> 'package'
             AND evidence_path IN (
               SELECT path FROM snapshot_fold_forward_paths WHERE snapshot_id = ${expected.snapshotId}
             )) AS staged_rows
  `;
  const checked = integrity[0];
  if (
    !checked ||
    Number(checked.lookup_count) !== Number(receipt.lookup_count) ||
    Number(checked.reexport_count) !== Number(receipt.reexport_count) ||
    Number(checked.reexport_mismatch) !== 0 ||
    Number(checked.staged_rows) !== expected.stagedRows
  ) {
    return undefined;
  }
  if (!Number.isSafeInteger(freshPayloadBytes) || freshPayloadBytes < 0) return undefined;
  if (expected.stagedPayloadBytes + freshPayloadBytes > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES) {
    return undefined;
  }
  const fresh = new Set(freshPaths);
  const carryPaths = priorPaths.filter(path => !fresh.has(path));
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_fold_carry_paths (
      path TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('DELETE FROM activation_fold_carry_paths');
  for (const batch of chunk(carryPaths, ACTIVATION_FILE_BATCH_ROWS)) {
    yield* sql.unsafe(
      `INSERT INTO activation_fold_carry_paths (path) VALUES ${batch.map(() => '(?)').join(', ')}`,
      batch,
    );
  }
  yield* sql.unsafe(
    `INSERT INTO activation_files (path, content_hash, raw_content_hash, language, mode, size, source)
     SELECT file.path, file.content_hash, file.raw_content_hash, file.language, file.mode, file.size, file.source
     FROM snapshot_files AS file
     JOIN activation_fold_carry_paths AS carry ON carry.path = file.path
     WHERE file.snapshot_id = ?`,
    [expected.snapshotId],
  );
  yield* sql.unsafe(
    `INSERT INTO activation_symbols (
       id, content_hash, kind, name, qualified_name, path, language, arity, lookup_keys_json,
       resolution_domain, resolution_scope_id, package_name, exported, signature, documentation, span_json
     )
     SELECT symbol.id, symbol.content_hash, symbol.kind, symbol.name, symbol.qualified_name,
       symbol.path, symbol.language, symbol.arity, symbol.lookup_keys_json, symbol.resolution_domain,
       symbol.resolution_scope_id, symbol.package_name, symbol.exported, symbol.signature,
       symbol.documentation, symbol.span_json
     FROM symbols AS symbol
     JOIN activation_fold_carry_paths AS carry ON carry.path = symbol.path
     WHERE symbol.snapshot_id = ?`,
    [expected.snapshotId],
  );
  yield* sql.unsafe(
    `INSERT INTO activation_symbol_lookup (
       lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
     )
     SELECT lookup.lookup_key, lookup.symbol_id, lookup.resolution_domain, lookup.exported,
       lookup.provenance, lookup.evidence_edge_id, lookup.evidence_path
     FROM snapshot_fold_forward_symbol_lookup AS lookup
     JOIN activation_fold_carry_paths AS carry ON carry.path = lookup.evidence_path
     WHERE lookup.snapshot_id = ?`,
    [expected.snapshotId],
  );
  yield* sql.unsafe(
    `INSERT INTO activation_symbol_terms (term, symbol_id, weight)
     SELECT term.term, symbol.symbol_id, posting.weight
     FROM lexical_compact_snapshots AS compact
     JOIN lexical_compact_postings AS posting ON posting.snapshot_key = compact.snapshot_key
     JOIN lexical_compact_terms AS term
       ON term.snapshot_key = compact.snapshot_key AND term.term_key = posting.term_key
     JOIN lexical_compact_symbols AS symbol
       ON symbol.snapshot_key = compact.snapshot_key AND symbol.symbol_key = posting.symbol_key
     JOIN activation_symbols AS current ON current.id = symbol.symbol_id
     WHERE compact.snapshot_id = ?`,
    [expected.snapshotId],
  );
  yield* sql.unsafe(
    `INSERT INTO activation_edges (
       id, source_id, source_name, relation, target_id, target_name, provenance,
       confidence, evidence_path, evidence_span_json
     )
     SELECT edge.id, edge.source_id, edge.source_name, edge.relation, edge.target_id,
       edge.target_name, edge.provenance, edge.confidence, edge.evidence_path, edge.evidence_span_json
     FROM edges AS edge
     JOIN activation_fold_carry_paths AS carry ON carry.path = edge.evidence_path
     WHERE edge.snapshot_id = ?`,
    [expected.snapshotId],
  );
  yield* sql.unsafe(
    `INSERT INTO activation_reexport_provenance (source_path, local_name, target_path, imported_name)
     SELECT provenance.source_path, provenance.local_name, provenance.target_path, provenance.imported_name
     FROM snapshot_reexport_provenance AS provenance
     JOIN activation_fold_carry_paths AS carry ON carry.path = provenance.source_path
     WHERE provenance.snapshot_id = ?`,
    [expected.snapshotId],
  );
  yield* sql.unsafe(
    `INSERT INTO activation_monikers (
       id, version, scheme, role, kind, resolution_domain, identity, package_name, package_version,
       import_path, qualified_name, component_id, symbol_id, dependency_kind, evidence_path, evidence_span_json
     )
     SELECT moniker.id, moniker.version, moniker.scheme, moniker.role, moniker.kind,
       moniker.resolution_domain, moniker.identity, moniker.package_name, moniker.package_version,
       moniker.import_path, moniker.qualified_name, moniker.component_id, moniker.symbol_id,
       moniker.dependency_kind, moniker.evidence_path, moniker.evidence_span_json
     FROM code_graph_monikers AS moniker
     JOIN activation_fold_carry_paths AS carry ON carry.path = moniker.evidence_path
     WHERE moniker.snapshot_id = ? AND moniker.scheme <> 'package'`,
    [expected.snapshotId],
  );
  return priorPaths;
});

const replaceStagedModifiedFiles = Effect.fn('codeGraph.replaceStagedModifiedFiles')(function* (
  baseSnapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const staged = yield* sql<{readonly value: string}>`
    SELECT value FROM activation_state WHERE key = 'snapshot_id' LIMIT 1
  `;
  if (staged[0]?.value !== baseSnapshotId || files.length === 0 || facts.length !== files.length) return false;
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length || facts.some(file => !paths.has(file.path))) return false;
  yield* sql.unsafe('DELETE FROM activation_incremental_paths');
  for (const batch of chunk([...paths], ACTIVATION_FILE_BATCH_ROWS)) {
    yield* sql.unsafe(
      `INSERT INTO activation_incremental_paths (path)
       VALUES ${batch.map(() => '(?)').join(', ')}`,
      batch,
    );
  }
  const existing = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM activation_files AS file
    JOIN activation_incremental_paths AS changed ON changed.path = file.path
  `;
  if (Number(existing[0]?.count ?? 0) !== files.length) {
    yield* sql.unsafe('DELETE FROM activation_incremental_paths');
    return false;
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(`
        DELETE FROM activation_reference_candidates
        WHERE edge_id IN (
          SELECT edge.id
          FROM activation_edges AS edge
          JOIN activation_incremental_paths AS changed ON changed.path = edge.evidence_path
        )
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_references
        WHERE edge_id IN (
          SELECT edge.id
          FROM activation_edges AS edge
          JOIN activation_incremental_paths AS changed ON changed.path = edge.evidence_path
        )
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_edges
        WHERE evidence_path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_symbol_terms
        WHERE symbol_id IN (
          SELECT symbol.id
          FROM activation_symbols AS symbol
          JOIN activation_incremental_paths AS changed ON changed.path = symbol.path
        )
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_symbols
        WHERE path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_monikers
        WHERE scheme <> 'package'
          AND evidence_path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_files
        WHERE path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* stageActivationFiles(sql, files);
      const symbols = facts.flatMap(file => file.symbols);
      yield* stageActivationSymbols(sql, symbols);
      yield* stageActivationSymbolTerms(sql, symbols);
      yield* stageActivationEdges(
        sql,
        facts.flatMap(file => file.edges),
      );
      yield* stageActivationReferences(
        sql,
        facts.flatMap(file => file.references ?? []),
      );
      yield* stageActivationMonikers(
        sql,
        facts.flatMap(file => file.monikers ?? []),
      );
      yield* sql.unsafe('DELETE FROM activation_changed_symbol_ids');
      yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
      yield* sql.unsafe('DELETE FROM activation_state');
    }),
  );
  yield* sql.unsafe('DELETE FROM activation_incremental_paths');
  return true;
});

const prepareSnapshotPromotionCapacity = Effect.fn('codeGraph.prepareSnapshotPromotionCapacity')(function* (
  identity: RepositoryIdentity,
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const snapshot = yield* sql<{
    readonly scope_id: string;
  }>`SELECT scope_id FROM snapshots WHERE id = ${snapshotId} LIMIT 1`;
  const removedSnapshotId = yield* promotionRemovedSnapshotId(sql, identity.worktreeId, snapshot[0]?.scope_id);
  const leaseCapacity = yield* snapshotPromotionLeaseCapacity(
    sql,
    removedSnapshotId === undefined ? [snapshotId] : [snapshotId, removedSnapshotId],
    now,
  );
  const activatedAt = DateTime.formatIso(yield* DateTime.now);
  const fixedFactBytes = persistentBoundTextBytes(0, [
    identity.worktreeId,
    snapshot[0]?.scope_id ?? 'full-repository',
    snapshotId,
    activatedAt,
    'retired',
  ]);
  return {
    activatedAt,
    boundary: {
      finalFactBytes: saturatingCapacityAdd(fixedFactBytes, leaseCapacity.factBytes),
      operation: 'promote ready code graph snapshot',
      // One pointer upsert, one exact tombstone delete, one cleanup-epoch
      // delete, every currently observed incoming lease flag, at most one
      // removed-view lease baton, and at most one exact
      // displaced-leaf retirement.
      // Non-leaf history remains routine maintenance because proving a whole
      // descendant closure is not transaction-bounded.
      rowCount: saturatingCapacityAdd(leaseCapacity.rows, 5),
    },
    maximumLeaseFactBytes: leaseCapacity.factBytes,
    maximumLeaseRows: leaseCapacity.rows,
  } satisfies SnapshotPromotionCapacityPlan;
});

export {
  preparePersistedFullActivation,
  preparePersistedFullWorkspace,
  preparePersistedFullFactCapacity,
  stagePersistedFullFactBatches,
  preparePersistedIncrementalActivation,
  replaceStagedModifiedFiles,
  prepareSnapshotPromotionCapacity,
};
