import {Clock, Effect, Option} from 'effect';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';
import {codeGraphScopeAuthorityInstalled} from './scope/schema.js';
import * as SqlClient from 'effect/sql/SqlClient';
import {type CodeGraphBlobReuseFile} from '../blob_reuse.js';
import {codeGraphUtf8ByteLength} from '../disk/capacity.js';
import {decodeStoredCodeGraphFact, storedCodeGraphFactRawBytesSql} from '../fact/storage.js';
import {compareCodeUnits} from '../ordering.js';
import {decodeCodeGraphInventoryReuseReceipt} from '../inventory/reuse.js';
import {relocateStructuredSchemaFacts} from '../languages/schemas/extractor.js';
import {
  CODE_GRAPH_RESOLUTION_SURFACE_VERSION,
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  CODE_GRAPH_FOLD_FORWARD_RECEIPT_VERSION,
  type CodeGraphEdgeCursor,
  type CodeGraphReusableBaseReceipt,
  type CodeGraphReusableCleanBase,
  type CodeGraphReusableCleanBaseSlice,
  type CodeGraphReusableFoldForwardBase,
  type CodeGraphReusableReexport,
  type CodeGraphReusableReexportSeed,
  type LoadedCodeGraphFacts,
  type StoredCodeGraph,
} from './models.js';
import {configureConnection, tableExists} from './session.js';
import {
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphProvenance,
  CodeGraphStoreError,
} from '../types.js';
import {type EdgeRow, type FileBlobRow, type SnapshotRow, type SymbolRow} from './internal_models.js';
import {edgeFromRow, snapshotFromRow, symbolFromRow} from './rows.js';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from './build/core.js';
import {
  boundedPageLimit,
  chunk,
  codeGraphIdentitySelectors,
  normalizedTerms,
  sqlTextOption,
  uniqueBy,
} from './utilities.js';
import {
  codeGraphAdjacencyQueryStatement,
  codeGraphDirectEdgeQueryStatement,
  codeGraphExactSymbolQueryStatement,
  codeGraphSymbolSearchScoreMultiplier,
  codeGraphSymbolsByIdsQueryStatement,
  effectiveEdgesCte,
  effectiveSnapshotParameters,
  effectiveSymbolsCte,
  legacyLexicalTermBranch,
  normalizeExactSearchPath,
  reusableFileBlobTargets,
  searchSymbolKindOrder,
  selectBaseSnapshotId,
  selectFileBlobMetadataBatch,
  selectReusableFileBlobBatch,
  selectReusableFileBlobMetadataBatch,
} from './query/core.js';
import {materializedFileShardIdentity} from './cache.js';
import {type CodeGraphSqlQueryStatement} from './visualization_sql.js';
import {selectSnapshotPackProvenance} from './pack_provenance.js';

const selectReadySnapshot = Effect.fn('codeGraph.selectReadySnapshot')(function* (
  worktreeId: string,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'active_snapshots')) || !(yield* tableExists(sql, 'snapshots'))) return undefined;
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const scoped = yield* codeGraphScopeAuthorityInstalled(sql);
  if (!scoped && scopeId !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) return undefined;
  const rows = yield* sql.unsafe<SnapshotRow>(
    `SELECT snapshots.*
     FROM active_snapshots
     JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
     WHERE active_snapshots.worktree_id = ?
       ${scoped ? 'AND active_snapshots.scope_id = ?' : ''}
       AND snapshots.state = 'ready'
       ${
         removedViewsAvailable
           ? `AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active_snapshots.worktree_id
                  ${scoped ? 'AND removed.scope_id = active_snapshots.scope_id' : ''}
                  AND removed.expected_snapshot_id = active_snapshots.snapshot_id
              )`
           : ''
       }
     LIMIT 1`,
    scoped ? [worktreeId, scopeId] : [worktreeId],
  );
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReadySnapshotById = Effect.fn('codeGraph.selectReadySnapshotById')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'snapshots'))) return undefined;
  const rows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectCurrentLexicalReadySnapshotById = Effect.fn('codeGraph.selectCurrentLexicalReadySnapshotById')(function* (
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'snapshots')) || !(yield* tableExists(sql, 'lexical_storage_formats'))) {
    return undefined;
  }
  const rows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots
    WHERE id = ${snapshotId} AND state = 'ready'
      AND EXISTS (
        SELECT 1 FROM lexical_storage_formats AS lexical
        WHERE lexical.snapshot_id = snapshots.id
          AND lexical.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
      )
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReadySnapshotForCommit = Effect.fn('codeGraph.selectReadySnapshotForCommit')(function* (
  repositoryId: string,
  commit: string,
  extractorSet?: string,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'snapshots')) || !(yield* tableExists(sql, 'lexical_storage_formats'))) {
    return undefined;
  }
  const scopeColumn = sql.unsafe((yield* codeGraphScopeAuthorityInstalled(sql)) ? 'scope_id' : "'full-repository'");
  const rows = yield* sql<SnapshotRow>`
    SELECT *
    FROM snapshots
    WHERE repository_id = ${repositoryId}
      AND commit_id = ${commit}
      AND ${scopeColumn} = ${scopeId}
      AND dirty = 0
      AND (${extractorSet ?? null} IS NULL OR extractor_set = ${extractorSet ?? null})
      AND state = 'ready'
      AND EXISTS (
        SELECT 1 FROM lexical_storage_formats AS lexical
        WHERE lexical.snapshot_id = snapshots.id
          AND lexical.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
      )
    ORDER BY completed_at DESC, id
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectRecentReadySnapshotsForRepository = Effect.fn('codeGraph.selectRecentReadySnapshotsForRepository')(
  function* (repositoryId: string, scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) {
    const sql = yield* SqlClient.SqlClient;
    yield* configureConnection(sql);
    if (!(yield* tableExists(sql, 'snapshots')) || !(yield* tableExists(sql, 'lexical_storage_formats'))) {
      return [];
    }
    const scopeColumn = sql.unsafe((yield* codeGraphScopeAuthorityInstalled(sql)) ? 'scope_id' : "'full-repository'");
    const rows = yield* sql<SnapshotRow>`
    SELECT *
    FROM snapshots
    WHERE repository_id = ${repositoryId}
      AND ${scopeColumn} = ${scopeId}
      AND dirty = 0
      AND state = 'ready'
      AND EXISTS (
        SELECT 1 FROM lexical_storage_formats AS lexical
        WHERE lexical.snapshot_id = snapshots.id
          AND lexical.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
      )
    ORDER BY completed_at DESC, id
    LIMIT 8
  `;
    return rows.map(snapshotFromRow);
  },
);

const selectReusableCleanBase = Effect.fn('codeGraph.selectReusableCleanBase')(function* (
  repositoryId: string,
  extractorSet: string,
  workspaceFingerprint: string,
  fileSetFingerprint: string,
  graphContentId?: string,
  preferredCommitGroups?: readonly (readonly string[])[],
  allowExtractorMismatch = false,
  workspaceProjectsJson = '[]',
  excludedSnapshotIds: readonly string[] = [],
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const excluded = new Set(excludedSnapshotIds);
  const extractorPredicate = allowExtractorMismatch
    ? sql.unsafe('1 = 1')
    : sql`snapshot.extractor_set = ${extractorSet}`;
  const scopeColumn = sql.unsafe(
    (yield* codeGraphScopeAuthorityInstalled(sql)) ? 'snapshot.scope_id' : "'full-repository'",
  );
  if (graphContentId !== undefined && !allowExtractorMismatch) {
    const exactCandidates = yield* sql<SnapshotRow>`
      SELECT snapshot.*
      FROM snapshots AS snapshot
      JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
      WHERE snapshot.repository_id = ${repositoryId}
        AND ${scopeColumn} = ${scopeId}
        AND ${extractorPredicate}
        AND snapshot.state = 'ready'
        AND snapshot.dirty = 0
        AND snapshot.base_snapshot_id IS NULL
        AND snapshot.graph_content_id = ${graphContentId}
        AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
        AND receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
      ORDER BY
        CASE WHEN receipt.workspace_fingerprint = ${workspaceFingerprint} THEN 0 ELSE 1 END,
        (SELECT COUNT(*) FROM json_each(${workspaceProjectsJson}) AS project
         WHERE json_extract(
           CASE WHEN json_valid(receipt.component_surfaces_json) THEN receipt.component_surfaces_json ELSE '{}' END,
           '$.' || json_quote(json_extract(project.value, '$.id'))
         ) = json(project.value)) DESC,
        CASE WHEN receipt.file_set_fingerprint = ${fileSetFingerprint} THEN 0 ELSE 1 END,
        snapshot.completed_at DESC,
        snapshot.id
      LIMIT 8
    `;
    const exact = yield* loadFirstReusableCleanBase(exactCandidates.filter(candidate => !excluded.has(candidate.id)));
    if (exact !== undefined) return exact;
  }

  if (preferredCommitGroups !== undefined) {
    const seen = new Set<string>();
    const normalizedGroups = preferredCommitGroups.slice(0, 512).map(group =>
      group.filter(commit => {
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit) || seen.has(commit)) return false;
        seen.add(commit);
        return true;
      }),
    );
    const candidateCommits = normalizedGroups.flat();
    const availableRows =
      candidateCommits.length === 0
        ? []
        : yield* sql<{readonly commit_id: string}>`
      SELECT DISTINCT snapshot.commit_id
      FROM snapshots AS snapshot
      JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
      WHERE snapshot.repository_id = ${repositoryId}
        AND ${scopeColumn} = ${scopeId}
        AND ${extractorPredicate}
        AND snapshot.state = 'ready'
        AND snapshot.dirty = 0
        AND snapshot.base_snapshot_id IS NULL
        AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
        AND receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
        AND receipt.workspace_fingerprint = ${workspaceFingerprint}
        AND ${sql.in('commit_id', candidateCommits)}
    `;
    const available = new Set(availableRows.map(row => row.commit_id));
    for (const group of normalizedGroups) {
      const matches = group.filter(commit => available.has(commit));
      if (matches.length === 0) continue;
      // Equally near commits on different merge branches are not interchangeable evidence.
      if (matches.length !== 1) break;
      const candidates = yield* sql<SnapshotRow>`
        SELECT snapshot.*
        FROM snapshots AS snapshot
        JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
        WHERE snapshot.repository_id = ${repositoryId}
        AND ${scopeColumn} = ${scopeId}
          AND ${extractorPredicate}
          AND snapshot.state = 'ready'
          AND snapshot.dirty = 0
          AND snapshot.base_snapshot_id IS NULL
          AND snapshot.commit_id = ${matches[0]}
          AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
          AND receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
          AND receipt.workspace_fingerprint = ${workspaceFingerprint}
        ORDER BY
          CASE WHEN snapshot.extractor_set = ${extractorSet} THEN 0 ELSE 1 END,
          CASE WHEN receipt.file_set_fingerprint = ${fileSetFingerprint} THEN 0 ELSE 1 END,
          snapshot.completed_at DESC,
          snapshot.id
        LIMIT 8
      `;
      const candidate = yield* loadFirstReusableCleanBase(candidates.filter(row => !excluded.has(row.id)));
      if (candidate !== undefined) return candidate;
    }
  }

  const legacyCandidates = yield* sql<SnapshotRow>`
    SELECT snapshot.*
    FROM snapshots AS snapshot
    JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
    WHERE snapshot.repository_id = ${repositoryId}
        AND ${scopeColumn} = ${scopeId}
      AND ${extractorPredicate}
      AND snapshot.state = 'ready'
      AND snapshot.dirty = 0
      AND snapshot.base_snapshot_id IS NULL
      AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
      AND receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
    ORDER BY
      CASE WHEN receipt.workspace_fingerprint = ${workspaceFingerprint} THEN 0 ELSE 1 END,
      (SELECT COUNT(*) FROM json_each(${workspaceProjectsJson}) AS project
       WHERE json_extract(
         CASE WHEN json_valid(receipt.component_surfaces_json) THEN receipt.component_surfaces_json ELSE '{}' END,
         '$.' || json_quote(json_extract(project.value, '$.id'))
       ) = json(project.value)) DESC,
      CASE WHEN snapshot.extractor_set = ${extractorSet} THEN 0 ELSE 1 END,
      CASE WHEN receipt.file_set_fingerprint = ${fileSetFingerprint} THEN 0 ELSE 1 END,
      snapshot.completed_at DESC,
      snapshot.id
    LIMIT 8
  `;
  return yield* loadFirstReusableCleanBase(legacyCandidates.filter(candidate => !excluded.has(candidate.id)));
});

const selectReusableCleanBaseForCommit = Effect.fn('codeGraph.selectReusableCleanBaseForCommit')(function* (
  repositoryId: string,
  commit: string,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const scopeColumn = sql.unsafe(
    (yield* codeGraphScopeAuthorityInstalled(sql)) ? 'snapshot.scope_id' : "'full-repository'",
  );
  const candidates = yield* sql<SnapshotRow>`
    SELECT snapshot.*
    FROM snapshots AS snapshot
    JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
    WHERE snapshot.repository_id = ${repositoryId}
      AND snapshot.commit_id = ${commit}
      AND ${scopeColumn} = ${scopeId}
      AND snapshot.state = 'ready'
      AND snapshot.dirty = 0
      AND snapshot.base_snapshot_id IS NULL
      AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
      AND receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
      AND receipt.inventory_receipt_json IS NOT NULL
    ORDER BY snapshot.completed_at DESC, snapshot.id
    LIMIT 8
  `;
  return yield* loadFirstReusableCleanBase(candidates);
});

export function reusableCleanBaseSlicePaths(paths: readonly string[]): readonly string[] | undefined {
  if (
    paths.length === 0 ||
    paths.length > 200 ||
    paths.some(path => {
      const segments = path.split('/');
      return (
        path.length === 0 ||
        path.length > 4_096 ||
        path.includes('\0') ||
        path.includes('\\') ||
        path.startsWith('/') ||
        segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
      );
    })
  ) {
    return undefined;
  }
  const requestedPaths = [...new Set(paths)].sort(compareCodeUnits);
  return requestedPaths.length === paths.length ? requestedPaths : undefined;
}

const selectReusableCleanBaseForCommitPaths = Effect.fn('codeGraph.selectReusableCleanBaseForCommitPaths')(function* (
  repositoryId: string,
  commit: string,
  paths: readonly string[],
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const requestedPaths = reusableCleanBaseSlicePaths(paths);
  if (requestedPaths === undefined) return undefined;
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const scopeColumn = sql.unsafe(
    (yield* codeGraphScopeAuthorityInstalled(sql)) ? 'snapshot.scope_id' : "'full-repository'",
  );
  const candidates = yield* sql<SnapshotRow>`
      SELECT snapshot.*
      FROM snapshots AS snapshot
      JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
      WHERE snapshot.repository_id = ${repositoryId}
        AND snapshot.commit_id = ${commit}
      AND ${scopeColumn} = ${scopeId}
        AND snapshot.state = 'ready'
        AND snapshot.dirty = 0
        AND snapshot.base_snapshot_id IS NULL
        AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
        AND receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
        AND receipt.inventory_receipt_json IS NOT NULL
      ORDER BY snapshot.completed_at DESC, snapshot.id
      LIMIT 8
    `;
  const requested = JSON.stringify(requestedPaths);
  for (const row of candidates) {
    const receipt = yield* selectReusableBaseReceipt(row.id);
    if (!receipt) continue;
    const files = yield* sql<{
      readonly content_hash: string;
      readonly language: string;
      readonly mode: string;
      readonly path: string;
      readonly size: number;
      readonly source: string;
    }>`
        SELECT file.content_hash, file.language, file.mode, file.path, file.size, file.source
        FROM json_each(${requested}) AS requested
        JOIN snapshot_files AS file
          ON file.snapshot_id = ${row.id}
         AND file.path = CAST(requested.value AS TEXT)
        ORDER BY file.path
      `;
    const filesByPath = new Map(files.map(file => [file.path, file]));
    if (files.length !== requestedPaths.length || filesByPath.size !== requestedPaths.length) continue;
    const orderedFiles: Array<(typeof files)[number]> = [];
    for (const path of requestedPaths) {
      const file = filesByPath.get(path);
      if (file !== undefined) orderedFiles.push(file);
    }
    if (orderedFiles.length !== requestedPaths.length) continue;
    if (files.some(file => file.source !== 'commit')) continue;
    return {
      files: orderedFiles.map(file => ({
        blobId: `snapshot:${file.content_hash}`,
        contentHash: file.content_hash,
        language: file.language,
        mode: file.mode,
        path: file.path,
        size: Number(file.size),
        source: 'commit' as const,
      })),
      receipt,
      snapshot: snapshotFromRow(row),
    } satisfies CodeGraphReusableCleanBaseSlice;
  }
  return undefined;
});

const selectExistingSnapshotFilePaths = Effect.fn('codeGraph.selectExistingSnapshotFilePaths')(function* (
  snapshotId: string,
  paths: readonly string[],
) {
  if (paths.length > 4_096) return undefined;
  if (paths.length === 0) return [];
  const requestedPaths = [...new Set(paths)].sort(compareCodeUnits);
  if (requestedPaths.length !== paths.length) return undefined;
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const requested = JSON.stringify(requestedPaths);
  const rows = yield* sql<{readonly path: string}>`
    SELECT file.path
    FROM json_each(${requested}) AS requested
    JOIN snapshot_files AS file
      ON file.snapshot_id = ${snapshotId}
     AND file.path = CAST(requested.value AS TEXT)
  `;
  const found = new Set(rows.map(row => row.path));
  return requestedPaths.filter(path => found.has(path));
});

const selectReusableOverlayBase = Effect.fn('codeGraph.selectReusableOverlayBase')(function* (
  repositoryId: string,
  extractorSet: string,
  overlayFingerprint: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const candidates = yield* sql<SnapshotRow>`
    SELECT snapshot.*
    FROM snapshots AS snapshot
    JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
    WHERE snapshot.repository_id = ${repositoryId}
      AND snapshot.extractor_set = ${extractorSet}
      AND snapshot.state = 'ready'
      AND snapshot.dirty = 1
      AND snapshot.base_snapshot_id IS NULL
      AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
      AND receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
    ORDER BY CASE WHEN snapshot.overlay_fingerprint = ${overlayFingerprint} THEN 0 ELSE 1 END,
             CASE WHEN EXISTS (
               SELECT 1 FROM snapshot_leases AS lease
               WHERE lease.snapshot_id = snapshot.id
                 AND lease.token GLOB 'retained-base:*'
                 AND lease.expires_at > ${now}
             ) THEN 0 ELSE 1 END,
             snapshot.completed_at DESC,
             snapshot.id
    LIMIT 8
  `;
  return yield* loadFirstReusableOverlayBase(candidates);
});

const loadFirstReusableCleanBase = Effect.fn('codeGraph.loadFirstReusableCleanBase')(function* (
  candidates: readonly SnapshotRow[],
) {
  const sql = yield* SqlClient.SqlClient;
  for (const row of candidates) {
    const receipt = yield* selectReusableBaseReceipt(row.id);
    if (!receipt) continue;
    const files = yield* sql<{
      readonly content_hash: string;
      readonly language: string;
      readonly mode: string;
      readonly path: string;
      readonly size: number;
      readonly source: string;
    }>`
    SELECT content_hash, language, mode, path, size, source
    FROM snapshot_files
    WHERE snapshot_id = ${row.id}
    ORDER BY path
  `;
    if (files.length !== Number(row.file_count) || files.some(file => file.source !== 'commit')) continue;
    return {
      files: files.map(file => ({
        blobId: `snapshot:${file.content_hash}`,
        contentHash: file.content_hash,
        language: file.language,
        mode: file.mode,
        path: file.path,
        size: Number(file.size),
        source: 'commit' as const,
      })),
      receipt,
      snapshot: snapshotFromRow(row),
    } satisfies CodeGraphReusableCleanBase;
  }
  return undefined;
});

const loadFirstReusableOverlayBase = Effect.fn('codeGraph.loadFirstReusableOverlayBase')(function* (
  candidates: readonly SnapshotRow[],
) {
  const sql = yield* SqlClient.SqlClient;
  for (const row of candidates) {
    const receipt = yield* selectReusableBaseReceipt(row.id, true);
    if (!receipt) continue;
    const files = yield* sql<{
      readonly content_hash: string;
      readonly language: string;
      readonly mode: string;
      readonly path: string;
      readonly size: number;
      readonly source: string;
    }>`
      SELECT content_hash, language, mode, path, size, source
      FROM snapshot_files
      WHERE snapshot_id = ${row.id}
      ORDER BY path
    `;
    if (
      files.length !== Number(row.file_count) ||
      files.some(file => file.source !== 'commit' && file.source !== 'worktree')
    ) {
      continue;
    }
    return {
      files: files.map(file => ({
        blobId: `snapshot:${file.content_hash}`,
        contentHash: file.content_hash,
        language: file.language,
        mode: file.mode,
        path: file.path,
        size: Number(file.size),
        source: persistedFileSource(file.source),
      })),
      receipt,
      snapshot: snapshotFromRow(row),
    } satisfies CodeGraphReusableCleanBase;
  }
  return undefined;
});

function persistedFileSource(source: string): 'commit' | 'worktree' {
  if (source === 'commit' || source === 'worktree') return source;
  throw CodeGraphStoreError.of('Stored code graph snapshot file source is invalid.');
}

const selectReusableBaseReceipt = Effect.fn('codeGraph.selectReusableBaseReceipt')(function* (
  snapshotId: string,
  allowDirtyRoot = false,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<{
    readonly alias_count: number;
    readonly file_set_fingerprint: string;
    readonly format_version: number;
    readonly lookup_count: number;
    readonly inventory_receipt_json: string | null;
    readonly reexport_count: number;
    readonly resolution_surface_version: number;
    readonly snapshot_id: string;
    readonly workspace_fingerprint: string;
  }>`
    SELECT receipt.*
    FROM snapshot_reuse_receipts AS receipt
    JOIN snapshots AS snapshot ON snapshot.id = receipt.snapshot_id
    WHERE receipt.snapshot_id = ${snapshotId}
      AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
      AND receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
      AND receipt.extractor_set = snapshot.extractor_set
      AND snapshot.state = 'ready'
      AND (${allowDirtyRoot ? 1 : 0} = 1 OR snapshot.dirty = 0)
      AND snapshot.base_snapshot_id IS NULL
      AND EXISTS (
        SELECT 1 FROM lexical_storage_formats AS lexical
        WHERE lexical.snapshot_id = receipt.snapshot_id
          AND lexical.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
      )
      AND (
        receipt.lookup_count = 0 OR EXISTS (
          SELECT 1 FROM snapshot_symbol_lookup AS lookup
          WHERE lookup.snapshot_id = receipt.snapshot_id
        )
      )
      AND (
        receipt.alias_count = 0 OR EXISTS (
          SELECT 1 FROM snapshot_symbol_lookup AS lookup
          WHERE lookup.snapshot_id = receipt.snapshot_id AND lookup.provenance = 'alias'
        )
      )
      AND (
        receipt.reexport_count = 0 OR EXISTS (
          SELECT 1 FROM snapshot_reexport_provenance AS provenance
          WHERE provenance.snapshot_id = receipt.snapshot_id
        )
      )
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  const packProvenance = yield* selectSnapshotPackProvenance(snapshotId);
  if (packProvenance === undefined) return undefined;
  const lookupCount = Number(row.lookup_count);
  const aliasCount = Number(row.alias_count);
  const reexportCount = Number(row.reexport_count);
  // Receipt rows and their lookup/provenance rows are committed in one SQLite
  // transaction. Avoid recounting the repository-wide lookup tables on every
  // one-file overlay; integrity checks belong to doctor/repair, not the hot path.
  if (
    !Number.isSafeInteger(lookupCount) ||
    lookupCount < 0 ||
    !Number.isSafeInteger(aliasCount) ||
    aliasCount < 0 ||
    aliasCount > lookupCount ||
    !Number.isSafeInteger(reexportCount) ||
    reexportCount < 0
  ) {
    return undefined;
  }
  const inventory = decodeCodeGraphInventoryReuseReceipt(row.inventory_receipt_json);
  return {
    aliasCount,
    fileSetFingerprint: row.file_set_fingerprint,
    formatVersion: Number(row.format_version),
    lookupCount,
    ...(inventory === undefined ? {} : {inventory}),
    packProvenance,
    reexportCount,
    resolutionSurfaceVersion: Number(row.resolution_surface_version),
    snapshotId: row.snapshot_id,
    workspaceFingerprint: row.workspace_fingerprint,
  } satisfies CodeGraphReusableBaseReceipt;
});

const selectReusableFoldForwardBase = Effect.fn('codeGraph.selectReusableFoldForwardBase')(function* (
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const candidates = yield* sql<SnapshotRow & {readonly root_snapshot_id: string}>`
    SELECT logical.*, proof.root_snapshot_id
    FROM snapshots AS logical
    JOIN snapshot_fold_forward_receipts AS proof ON proof.snapshot_id = logical.id
    JOIN snapshot_reuse_receipts AS logical_receipt ON logical_receipt.snapshot_id = logical.id
    JOIN snapshots AS root ON root.id = proof.root_snapshot_id
    JOIN snapshot_reuse_receipts AS root_receipt ON root_receipt.snapshot_id = root.id
    WHERE logical.id = ${snapshotId}
      AND logical.state = 'ready'
      AND logical.dirty = 0
      AND logical.base_snapshot_id = proof.root_snapshot_id
      AND proof.format_version = ${CODE_GRAPH_FOLD_FORWARD_RECEIPT_VERSION}
      AND root.state = 'ready'
      AND root.dirty = 0
      AND root.base_snapshot_id IS NULL
      AND logical.extractor_set = root.extractor_set
      AND logical_receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
      AND logical_receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
      AND logical_receipt.extractor_set = logical.extractor_set
      AND logical_receipt.workspace_fingerprint = root_receipt.workspace_fingerprint
      AND logical_receipt.file_set_fingerprint = root_receipt.file_set_fingerprint
      AND logical_receipt.inventory_receipt_json IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM lexical_storage_formats AS lexical
        WHERE lexical.snapshot_id = logical.id
          AND lexical.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
      )
    LIMIT 1
  `;
  const logicalRow = candidates[0];
  if (!logicalRow) return undefined;
  const rootSnapshotId = logicalRow.root_snapshot_id;
  const rootRows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${rootSnapshotId} AND state = 'ready' LIMIT 1
  `;
  const rootRow = rootRows[0];
  if (!rootRow) return undefined;
  const rootReceipt = yield* selectReusableBaseReceipt(rootSnapshotId);
  if (!rootReceipt) return undefined;
  const proofRows = yield* sql<{
    readonly delta_path_count: number;
    readonly lookup_count: number;
    readonly reexport_count: number;
    readonly staged_payload_bytes: number;
    readonly staged_row_count: number;
  }>`
    SELECT delta_path_count, staged_row_count, staged_payload_bytes, lookup_count, reexport_count
    FROM snapshot_fold_forward_receipts
    WHERE snapshot_id = ${snapshotId} AND root_snapshot_id = ${rootSnapshotId}
    LIMIT 1
  `;
  const proof = proofRows[0];
  if (!proof) return undefined;
  const counts = [
    Number(proof.delta_path_count),
    Number(proof.staged_row_count),
    Number(proof.staged_payload_bytes),
    Number(proof.lookup_count),
    Number(proof.reexport_count),
  ];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0) || counts[0] === 0 || counts[1] === 0) {
    return undefined;
  }
  const priorPaths = yield* sql<{readonly path: string}>`
    SELECT path FROM snapshot_fold_forward_paths
    WHERE snapshot_id = ${snapshotId}
    ORDER BY path
  `;
  if (priorPaths.length !== counts[0]) return undefined;
  const integrity = yield* sql<{
    readonly invalid_lookup_paths: number;
    readonly lookup_count: number;
    readonly reexport_count: number;
    readonly reexport_mismatch: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM snapshot_fold_forward_symbol_lookup AS lookup
       WHERE lookup.snapshot_id = ${snapshotId}
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_fold_forward_paths AS path
           WHERE path.snapshot_id = lookup.snapshot_id AND path.path = lookup.evidence_path
         )) AS invalid_lookup_paths,
      (SELECT COUNT(*) FROM snapshot_fold_forward_symbol_lookup
       WHERE snapshot_id = ${snapshotId}) AS lookup_count,
      (SELECT COUNT(*) FROM snapshot_reexport_provenance
       WHERE snapshot_id = ${snapshotId}) AS reexport_count,
      (EXISTS (
        SELECT source_path, local_name, target_path, imported_name
        FROM snapshot_reexport_provenance
        WHERE snapshot_id = ${snapshotId}
        EXCEPT
        SELECT root.source_path, root.local_name, root.target_path, root.imported_name
        FROM snapshot_fold_forward_paths AS path
        JOIN snapshot_reexport_provenance AS root
          ON root.snapshot_id = ${rootSnapshotId} AND root.source_path = path.path
        WHERE path.snapshot_id = ${snapshotId}
      ) OR EXISTS (
        SELECT root.source_path, root.local_name, root.target_path, root.imported_name
        FROM snapshot_fold_forward_paths AS path
        JOIN snapshot_reexport_provenance AS root
          ON root.snapshot_id = ${rootSnapshotId} AND root.source_path = path.path
        WHERE path.snapshot_id = ${snapshotId}
        EXCEPT
        SELECT source_path, local_name, target_path, imported_name
        FROM snapshot_reexport_provenance
        WHERE snapshot_id = ${snapshotId}
      )) AS reexport_mismatch
  `;
  const checked = integrity[0];
  if (
    !checked ||
    Number(checked.invalid_lookup_paths) !== 0 ||
    Number(checked.lookup_count) !== counts[3] ||
    Number(checked.reexport_count) !== counts[4] ||
    Number(checked.reexport_mismatch) !== 0
  ) {
    return undefined;
  }
  const logicalFiles = yield* sql<{
    readonly content_hash: string;
    readonly language: string;
    readonly mode: string;
    readonly path: string;
    readonly size: number;
    readonly source: string;
  }>`
    SELECT root.content_hash, root.language, root.mode, root.path, root.size, root.source
    FROM snapshot_files AS root
    WHERE root.snapshot_id = ${rootSnapshotId}
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_files AS current
        WHERE current.snapshot_id = ${snapshotId} AND current.path = root.path
      )
    UNION ALL
    SELECT current.content_hash, current.language, current.mode, current.path, current.size, current.source
    FROM snapshot_files AS current
    WHERE current.snapshot_id = ${snapshotId}
    ORDER BY path
  `;
  if (
    logicalFiles.length !== Number(logicalRow.file_count) ||
    logicalFiles.length !== Number(rootRow.file_count) ||
    logicalFiles.some(file => file.source !== 'commit')
  ) {
    return undefined;
  }
  return {
    logicalFiles: logicalFiles.map(file => ({
      blobId: `snapshot:${file.content_hash}`,
      contentHash: file.content_hash,
      language: file.language,
      mode: file.mode,
      path: file.path,
      size: Number(file.size),
      source: 'commit' as const,
    })),
    logicalSnapshot: snapshotFromRow(logicalRow),
    priorDeltaPaths: priorPaths.map(row => row.path),
    priorStagedPayloadBytes: counts[2],
    priorStagedRows: counts[1],
    rootReceipt,
    rootSnapshot: snapshotFromRow(rootRow),
  } satisfies CodeGraphReusableFoldForwardBase;
});

const selectReusableReexports = Effect.fn('codeGraph.selectReusableReexports')(function* (
  snapshotId: string,
  seeds: readonly CodeGraphReusableReexportSeed[],
  maxRows = Number.MAX_SAFE_INTEGER,
  allowDirtyRoot = false,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* selectReusableBaseReceipt(snapshotId, allowDirtyRoot))) return undefined;
  const uniqueSeeds = uniqueBy(seeds, seed => `${seed.path}\0${seed.name}`);
  if (uniqueSeeds.length === 0) return [];
  if (!Number.isSafeInteger(maxRows) || maxRows < 0) return undefined;
  const output = new Map<string, CodeGraphReusableReexport>();
  for (const batch of chunk(uniqueSeeds, 200)) {
    if (output.size > maxRows) return undefined;
    const queryLimit = maxRows === Number.MAX_SAFE_INTEGER ? maxRows : maxRows + 1;
    const rows = yield* sql.unsafe<{
      readonly imported_name: string;
      readonly local_name: string;
      readonly source_path: string;
      readonly target_path: string;
    }>(
      `WITH RECURSIVE
       requested(path, name) AS (VALUES ${batch.map(() => '(?, ?)').join(', ')}),
       closure(source_path, local_name, target_path, imported_name) AS (
         SELECT provenance.source_path, provenance.local_name,
           provenance.target_path, provenance.imported_name
         FROM snapshot_reexport_provenance AS provenance
         JOIN requested
           ON requested.path = provenance.source_path AND requested.name = provenance.local_name
         WHERE provenance.snapshot_id = ?
         UNION
         SELECT provenance.source_path, provenance.local_name,
           provenance.target_path, provenance.imported_name
         FROM snapshot_reexport_provenance AS provenance
         JOIN closure
           ON closure.target_path = provenance.source_path
          AND closure.imported_name = provenance.local_name
         WHERE provenance.snapshot_id = ?
         LIMIT ?
       )
       SELECT source_path, local_name, target_path, imported_name
       FROM closure
       ORDER BY source_path, local_name, target_path, imported_name
       LIMIT ?`,
      [...batch.flatMap(seed => [seed.path, seed.name]), snapshotId, snapshotId, queryLimit, queryLimit],
    );
    if (rows.length > maxRows) {
      return rows.map(row => ({
        importedName: row.imported_name,
        localName: row.local_name,
        sourcePath: row.source_path,
        targetPath: row.target_path,
      }));
    }
    for (const row of rows) {
      const value = {
        importedName: row.imported_name,
        localName: row.local_name,
        sourcePath: row.source_path,
        targetPath: row.target_path,
      } satisfies CodeGraphReusableReexport;
      output.set(`${value.sourcePath}\0${value.localName}\0${value.targetPath}\0${value.importedName}`, value);
      if (output.size > maxRows) return [...output.values()];
    }
  }
  return [...output.values()].sort((left, right) =>
    compareCodeUnits(
      `${left.sourcePath}\0${left.localName}\0${left.targetPath}\0${left.importedName}`,
      `${right.sourcePath}\0${right.localName}\0${right.targetPath}\0${right.importedName}`,
    ),
  );
});

const selectCachedFacts = Effect.fn('codeGraph.selectCachedFacts')(function* (
  files: readonly CodeGraphBlobReuseFile[],
  extractorSet: string,
  decode: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const output = new Map<string, CodeGraphFileFacts>();
  const bytesByPath = new Map<string, number>();
  const keys = new Set<string>();
  let bytes = 0;
  for (const batch of chunk(files, 300)) {
    if (!decode) {
      const rows = yield* selectFileBlobMetadataBatch(sql, batch, extractorSet);
      for (const row of rows) {
        keys.add(row.path_hint);
        const factBytes = Number(row.facts_bytes);
        bytes += factBytes;
        bytesByPath.set(row.path_hint, factBytes);
      }
      const missing = batch.filter(file => !keys.has(file.path));
      const reusableRows = yield* selectReusableFileBlobMetadataBatch(sql, missing, extractorSet);
      for (const row of reusableRows) {
        if (keys.has(row.target_path)) continue;
        keys.add(row.target_path);
        const factBytes = Number(row.facts_bytes);
        bytes += factBytes;
        bytesByPath.set(row.target_path, factBytes);
      }
      continue;
    }
    const rows = yield* selectFileBlobBatch(sql, batch, extractorSet);
    for (const row of rows) {
      const bounded = decodeStoredCodeGraphFactOption(row.facts_json, row.path_hint);
      if (bounded === undefined) continue;
      output.set(row.path_hint, bounded.facts);
      keys.add(row.path_hint);
      const factBytes = bounded.bytes;
      bytes += factBytes;
      bytesByPath.set(row.path_hint, factBytes);
    }
    const missing = batch.filter(file => !keys.has(file.path));
    const reusableRows = yield* selectReusableFileBlobBatch(sql, missing, extractorSet);
    const filesByPath = new Map(reusableFileBlobTargets(missing).map(file => [file.path, file]));
    for (const row of reusableRows) {
      if (keys.has(row.target_path)) continue;
      const file = filesByPath.get(row.target_path);
      if (file === undefined) continue;
      const relocated = relocateStoredCodeGraphFactOption(row.facts_json, row.path_hint, file);
      if (relocated === undefined) continue;
      output.set(row.target_path, relocated.facts);
      keys.add(row.target_path);
      bytes += relocated.bytes;
      bytesByPath.set(row.target_path, relocated.bytes);
    }
  }
  return {bytes, bytesByPath, facts: output, keys} satisfies LoadedCodeGraphFacts;
});

interface MaterializedShardDonor {
  readonly exactGeneration: boolean;
  readonly snapshotId: string;
}

/** @internal Exposed so regression tests can verify the requested-first access plan. */
export function codeGraphCompleteMaterializedShardDonorStatement(
  snapshotId: string,
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
  derivationIdentity: string,
): CodeGraphSqlQueryStatement {
  const requested = JSON.stringify(
    files.map(file => ({
      contentHash: file.contentHash,
      id: materializedFileShardIdentity(file.contentHash, extractorSet, derivationIdentity, file.path),
      path: file.path,
    })),
  );
  return {
    parameters: [requested, snapshotId, extractorSet, derivationIdentity],
    text: `SELECT COUNT(*) AS association_count,
                  COALESCE(snapshot.graph_content_id, snapshot.id) AS graph_content_id
           FROM json_each(?) AS requested
           CROSS JOIN snapshots AS snapshot
           CROSS JOIN snapshot_file_shards AS association
           CROSS JOIN materialized_file_shards AS shard
           WHERE snapshot.id = ?
             AND snapshot.extractor_set = ?
             AND association.snapshot_id = snapshot.id
             AND association.path = json_extract(requested.value, '$.path')
             AND shard.id = association.shard_id
             AND shard.id = json_extract(requested.value, '$.id')
             AND shard.content_hash = json_extract(requested.value, '$.contentHash')
             AND shard.path_hint = association.path
             AND shard.extractor_set = snapshot.extractor_set
             AND shard.derivation_identity = ?
           GROUP BY snapshot.id, snapshot.graph_content_id`,
  };
}

const selectCompleteMaterializedShardDonor = Effect.fn('codeGraph.selectCompleteMaterializedShardDonor')(function* (
  sql: SqlClient.SqlClient,
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
  derivationIdentity: string,
  currentGraphContentId: string,
  snapshotIds: readonly string[],
) {
  if (files.length === 0 || new Set(files.map(file => file.path)).size !== files.length) return undefined;
  for (const snapshotId of [...new Set(snapshotIds)].slice(0, 2)) {
    const statement = codeGraphCompleteMaterializedShardDonorStatement(
      snapshotId,
      files,
      extractorSet,
      derivationIdentity,
    );
    const rows = yield* sql.unsafe<{
      readonly association_count: number;
      readonly graph_content_id: string;
    }>(statement.text, statement.parameters);
    const row = rows[0];
    if (
      row !== undefined &&
      Number(row.association_count) === files.length &&
      typeof row.graph_content_id === 'string'
    ) {
      return {
        exactGeneration: row.graph_content_id === currentGraphContentId,
        snapshotId,
      } satisfies MaterializedShardDonor;
    }
  }
  return undefined;
});

const selectMaterializedFileShards = Effect.fn('codeGraph.selectMaterializedFileShards')(function* (
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
  derivationIdentity: string,
  provenance?: {
    readonly currentGraphContentId: string;
    readonly snapshotIds: readonly string[];
  },
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const donor = provenance
    ? yield* selectCompleteMaterializedShardDonor(
        sql,
        files,
        extractorSet,
        derivationIdentity,
        provenance.currentGraphContentId,
        provenance.snapshotIds,
      )
    : undefined;
  const output = new Map<string, CodeGraphFileFacts>();
  const bytesByPath = new Map<string, number>();
  const materializedShardIdsByPath = new Map<string, string>();
  const keys = new Set<string>();
  let bytes = 0;
  for (const batch of chunk(files, 200)) {
    if (batch.length === 0) continue;
    const rows = yield* sql.unsafe<{
      readonly content_hash: string;
      readonly facts_bytes: number;
      readonly facts_json: string;
      readonly id: string;
      readonly path_hint: string;
    }>(
      `SELECT shard.id, shard.content_hash, shard.path_hint, shard.facts_json,
              ${storedCodeGraphFactRawBytesSql('shard.facts_json')} AS facts_bytes
       FROM materialized_file_shards AS shard
       ${
         provenance === undefined
           ? ''
           : `JOIN snapshot_file_shards AS association
                ON association.snapshot_id = ?
               AND association.path = shard.path_hint
               AND association.shard_id = shard.id`
       }
       WHERE shard.extractor_set = ? AND shard.derivation_identity = ?
         AND (${batch.map(() => '(shard.content_hash = ? AND shard.path_hint = ?)').join(' OR ')})
         ${provenance !== undefined && donor === undefined ? 'AND 0' : ''}`,
      [
        ...(provenance === undefined ? [] : [donor?.snapshotId ?? '']),
        extractorSet,
        derivationIdentity,
        ...batch.flatMap(file => [file.contentHash, file.path]),
      ],
    );
    for (const row of rows) {
      const bounded = decodeStoredCodeGraphFactOption(row.facts_json, row.path_hint);
      if (
        bounded === undefined ||
        bounded.facts.path !== row.path_hint ||
        row.id !== materializedFileShardIdentity(row.content_hash, extractorSet, derivationIdentity, row.path_hint)
      ) {
        continue;
      }
      output.set(row.path_hint, bounded.facts);
      materializedShardIdsByPath.set(row.path_hint, row.id);
      keys.add(row.path_hint);
      const factBytes = bounded.bytes;
      bytes += factBytes;
      bytesByPath.set(row.path_hint, factBytes);
    }
  }
  return {
    bytes,
    bytesByPath,
    ...(provenance === undefined ? {} : {exactGenerationFiles: donor?.exactGeneration === true ? output.size : 0}),
    facts: output,
    keys,
    materializedShardIdsByPath,
  } satisfies LoadedCodeGraphFacts;
});

const selectSnapshotMaterializedFileShards = Effect.fn('codeGraph.selectSnapshotMaterializedFileShards')(function* (
  snapshotId: string,
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
) {
  const output = new Map<string, CodeGraphFileFacts>();
  const bytesByPath = new Map<string, number>();
  const keys = new Set<string>();
  let bytes = 0;
  if (files.length === 0 || new Set(files.map(file => file.path)).size !== files.length) {
    return {bytes, bytesByPath, facts: output, keys} satisfies LoadedCodeGraphFacts;
  }
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  for (const batch of chunk(files, 200)) {
    const requested = JSON.stringify(batch.map(file => ({contentHash: file.contentHash, path: file.path})));
    const rows = yield* sql<{
      readonly content_hash: string;
      readonly derivation_identity: string;
      readonly extractor_set: string;
      readonly facts_json: string;
      readonly id: string;
      readonly path_hint: string;
    }>`
        SELECT shard.id, shard.content_hash, shard.extractor_set, shard.derivation_identity,
               shard.path_hint, shard.facts_json
        FROM json_each(${requested}) AS requested
        JOIN snapshots AS snapshot
          ON snapshot.id = ${snapshotId}
         AND snapshot.state = 'ready'
        JOIN snapshot_files AS file
          ON file.snapshot_id = snapshot.id
         AND file.path = json_extract(requested.value, '$.path')
         AND file.content_hash = json_extract(requested.value, '$.contentHash')
        JOIN snapshot_file_shards AS association
          ON association.snapshot_id = file.snapshot_id
         AND association.path = file.path
        JOIN materialized_file_shards AS shard
          ON shard.id = association.shard_id
         AND shard.content_hash = file.content_hash
         AND shard.path_hint = file.path
         AND shard.extractor_set = snapshot.extractor_set
      `;
    for (const row of rows) {
      const bounded = decodeStoredCodeGraphFactOption(row.facts_json, row.path_hint);
      if (
        bounded === undefined ||
        row.id !==
          materializedFileShardIdentity(row.content_hash, row.extractor_set, row.derivation_identity, row.path_hint)
      ) {
        continue;
      }
      output.set(row.path_hint, bounded.facts);
      keys.add(row.path_hint);
      bytes += bounded.bytes;
      bytesByPath.set(row.path_hint, bounded.bytes);
    }
  }
  return {bytes, bytesByPath, facts: output, keys} satisfies LoadedCodeGraphFacts;
});

function decodeStoredCodeGraphFactOption(json: string, path: string) {
  try {
    return decodeStoredCodeGraphFact(json, path);
  } catch {
    // Cached graph facts are disposable; malformed rows are ignored and rebuilt.
    return undefined;
  }
}

function relocateStoredCodeGraphFactOption(
  json: string,
  sourcePath: string,
  file: Pick<CodeGraphInventoryFile, 'contentHash' | 'language' | 'path'>,
): {readonly bytes: number; readonly facts: CodeGraphFileFacts} | undefined {
  try {
    const bounded = decodeStoredCodeGraphFact(json, sourcePath);
    const facts = relocateStructuredSchemaFacts(file, bounded.facts);
    return facts === undefined ? undefined : {bytes: codeGraphUtf8ByteLength(JSON.stringify(facts)), facts};
  } catch {
    // Malformed or incompatible donors cannot satisfy the target path.
    return undefined;
  }
}

function selectFileBlobBatch(sql: SqlClient.SqlClient, files: readonly CodeGraphBlobReuseFile[], extractorSet: string) {
  if (files.length === 0) {
    return Effect.succeed([] as readonly (FileBlobRow & {readonly facts_bytes: number; readonly path_hint: string})[]);
  }
  return sql.unsafe<FileBlobRow & {readonly facts_bytes: number; readonly path_hint: string}>(
    `SELECT blob_id, content_hash, path_hint, reuse_class, facts_json,
            ${storedCodeGraphFactRawBytesSql('facts_json')} AS facts_bytes
     FROM file_blobs
     WHERE extractor_set = ?
       AND (${files.map(() => '(content_hash = ? AND path_hint = ?)').join(' OR ')})`,
    [extractorSet, ...files.flatMap(file => [file.contentHash, file.path])],
  );
}

const selectStoredGraph = Effect.fn('codeGraph.selectStoredGraph')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const snapshots = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready'
  `;
  const snapshot = snapshots[0];
  if (!snapshot) return yield* CodeGraphStoreError.of(`Ready snapshot ${snapshotId} was not found.`);
  const baseSnapshotId = Option.getOrUndefined(sqlTextOption(snapshot.base_snapshot_id));
  const [symbolRows, edgeRows] = yield* Effect.all(
    [
      selectAllEffectiveSymbols(sql, snapshotId, baseSnapshotId),
      selectAllEffectiveEdges(sql, snapshotId, baseSnapshotId),
    ],
    {concurrency: 1},
  );
  return {
    edges: edgeRows.map(edgeFromRow),
    snapshot: snapshotFromRow(snapshot),
    symbols: symbolRows.map(symbolFromRow),
  } satisfies StoredCodeGraph;
});

const selectStoredSymbols = Effect.fn('codeGraph.selectStoredSymbols')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return (yield* selectAllEffectiveSymbols(sql, snapshotId, baseSnapshotId)).map(symbolFromRow);
});

function selectAllEffectiveSymbols(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return sql.unsafe<SymbolRow>(
    `${effectiveSymbolsCte()}
     SELECT * FROM effective_symbols
     ORDER BY path, qualified_name, id`,
    effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  );
}

function selectAllEffectiveEdges(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return sql.unsafe<EdgeRow>(
    `${effectiveEdgesCte()}
     SELECT * FROM effective_edges
     ORDER BY source_name, relation, target_name, id`,
    effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  );
}

const selectEdgePage = Effect.fn('codeGraph.selectEdgePage')(function* (
  snapshotId: string,
  cursor: CodeGraphEdgeCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = cursor
    ? yield* sql.unsafe<EdgeRow>(
        `${effectiveEdgesCte()}
         SELECT * FROM effective_edges
         WHERE (source_name, relation, target_name, id) > (?, ?, ?, ?)
         ORDER BY source_name, relation, target_name, id
         LIMIT ?`,
        [
          ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
          cursor.sourceName,
          cursor.relation,
          cursor.targetName,
          cursor.id,
          boundedPageLimit(limit),
        ],
      )
    : yield* sql.unsafe<EdgeRow>(
        `${effectiveEdgesCte()}
         SELECT * FROM effective_edges
         ORDER BY source_name, relation, target_name, id
         LIMIT ?`,
        [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), boundedPageLimit(limit)],
      );
  return rows.map(edgeFromRow);
});

const selectSearchSymbols = Effect.fn('codeGraph.selectSearchSymbols')(function* (
  snapshotId: string,
  query: string,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return yield* selectSearchSymbolsWithSql(sql, snapshotId, baseSnapshotId, query, limit);
});

interface SearchSymbolRow extends SymbolRow {
  readonly exact_rank: number;
  readonly rankingScore?: number;
  readonly score: number;
}

/** Keep exact predicates inside each branch so SQLite does not scan every symbol before LIMIT. */

function compactLexicalTermBranch(alias: string, placeholders: string, base: boolean): string {
  const suppression = base
    ? `AND NOT EXISTS (
         SELECT 1 FROM symbols AS overrides
         WHERE overrides.snapshot_id = ? AND overrides.id = ${alias}_symbols.symbol_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM snapshot_symbol_deletions AS deletions
         WHERE deletions.snapshot_id = ? AND deletions.symbol_id = ${alias}_symbols.symbol_id
       )`
    : '';
  const termPredicate = placeholders.length === 0 ? '' : `AND ${alias}_terms.term IN (${placeholders})`;
  return `SELECT ${alias}_terms.term, ${alias}_symbols.symbol_id, ${alias}_postings.weight
    FROM lexical_compact_snapshots AS ${alias}_snapshot
    JOIN lexical_storage_formats AS ${alias}_format
      ON ${alias}_format.snapshot_id = ${alias}_snapshot.snapshot_id
     AND ${alias}_format.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
    JOIN lexical_compact_terms AS ${alias}_terms INDEXED BY sqlite_autoindex_lexical_compact_terms_1
      ON ${alias}_terms.snapshot_key = ${alias}_snapshot.snapshot_key
    CROSS JOIN lexical_compact_postings AS ${alias}_postings
    CROSS JOIN lexical_compact_symbols AS ${alias}_symbols
    WHERE ${alias}_snapshot.snapshot_id = ?
      AND ${alias}_postings.snapshot_key = ${alias}_snapshot.snapshot_key
      AND ${alias}_postings.term_key = ${alias}_terms.term_key
      AND ${alias}_symbols.snapshot_key = ${alias}_snapshot.snapshot_key
      AND ${alias}_symbols.symbol_key = ${alias}_postings.symbol_key
      ${termPredicate}
      ${suppression}`;
}

export function codeGraphEffectiveSymbolTermsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
): CodeGraphSqlQueryStatement {
  const baseId = baseSnapshotId ?? '';
  return {
    parameters: [snapshotId, snapshotId, baseId, snapshotId, snapshotId, baseId, snapshotId, snapshotId],
    text: `WITH effective_terms AS (
      ${legacyLexicalTermBranch('current_legacy_terms', '', false)}
      UNION ALL
      ${compactLexicalTermBranch('current_compact', '', false)}
      UNION ALL
      ${legacyLexicalTermBranch('base_legacy_terms', '', true)}
      UNION ALL
      ${compactLexicalTermBranch('base_compact', '', true)}
    )
    SELECT term, symbol_id, weight FROM effective_terms
    ORDER BY term, symbol_id`,
  };
}

/** Build lexical candidates across independently versioned current/base snapshots. */
export function codeGraphTermCandidateQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  terms: readonly string[],
  limit: number,
): CodeGraphSqlQueryStatement {
  const uniqueTerms = [...new Set(terms)].slice(0, 24);
  const placeholders = uniqueTerms.map(() => '?').join(', ');
  const baseId = baseSnapshotId ?? '';
  return {
    parameters: [
      snapshotId,
      ...uniqueTerms,
      snapshotId,
      ...uniqueTerms,
      baseId,
      ...uniqueTerms,
      snapshotId,
      snapshotId,
      baseId,
      ...uniqueTerms,
      snapshotId,
      snapshotId,
      Math.max(1, Math.min(2_000, Math.floor(limit))),
    ],
    text: `WITH effective_terms AS (
      ${legacyLexicalTermBranch('current_legacy_terms', placeholders, false)}
      UNION ALL
      ${compactLexicalTermBranch('current_compact', placeholders, false)}
      UNION ALL
      ${legacyLexicalTermBranch('base_legacy_terms', placeholders, true)}
      UNION ALL
      ${compactLexicalTermBranch('base_compact', placeholders, true)}
    )
    SELECT symbol_id, SUM(weight) AS score
    FROM effective_terms
    GROUP BY symbol_id
    ORDER BY score DESC, symbol_id
    LIMIT ?`,
  };
}

/**
 * Product names such as MCP tool identifiers appear verbatim in test fixtures
 * and agent-instruction documents as well as in the code that implements them.
 * Those copies match a bare symbol query just as strongly, so they are demoted
 * unless the query itself asks for a test or a document.
 */

function searchSymbolRowComparator(
  queryTerms: readonly string[],
): (left: SearchSymbolRow, right: SearchSymbolRow) => number {
  return (left, right) =>
    codeGraphSymbolSearchScoreMultiplier(right.path, right.kind, right.name, queryTerms) -
      codeGraphSymbolSearchScoreMultiplier(left.path, left.kind, left.name, queryTerms) ||
    right.exact_rank - left.exact_rank ||
    (right.rankingScore ?? right.score) - (left.rankingScore ?? left.score) ||
    right.exported - left.exported ||
    searchSymbolKindOrder(left.kind) - searchSymbolKindOrder(right.kind) ||
    compareCodeUnits(left.name, right.name) ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.id, right.id);
}

const selectSymbolsByIdsWithSql = Effect.fn('codeGraph.selectSymbolsByIdsWithSql')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  ids: readonly string[],
) {
  const output: SymbolRow[] = [];
  for (const values of chunk([...new Set(ids)], 400)) {
    const statement = codeGraphSymbolsByIdsQueryStatement(snapshotId, baseSnapshotId, values);
    const rows = yield* sql.unsafe<SymbolRow>(statement.text, statement.parameters);
    output.push(...rows);
  }
  return output;
});

const selectSearchSymbolsWithSql = Effect.fn('codeGraph.selectSearchSymbolsWithSql')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  query: string,
  limit: number,
) {
  const terms = normalizedTerms(query).slice(0, 24);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const compareRows = searchSymbolRowComparator(terms);
  const rankedNode = (row: SearchSymbolRow) => ({
    ...symbolFromRow(row),
    score: Math.max(
      0,
      Math.min(1, (row.score / 100) * codeGraphSymbolSearchScoreMultiplier(row.path, row.kind, row.name, terms)),
    ),
  });
  const exactPath = normalizeExactSearchPath(query);
  const exactStatement = codeGraphExactSymbolQueryStatement(snapshotId, baseSnapshotId, exactPath ?? query, safeLimit);
  const exactRows = [...(yield* sql.unsafe<SearchSymbolRow>(exactStatement.text, exactStatement.parameters))];
  if (
    exactPath !== undefined &&
    exactRows.some(row => normalizeExactSearchPath(row.path)?.toLocaleLowerCase() === exactPath.toLocaleLowerCase())
  ) {
    return [...exactRows].sort(compareRows).slice(0, safeLimit).map(rankedNode);
  }
  for (const selector of codeGraphIdentitySelectors(query)) {
    const statement = codeGraphExactSymbolQueryStatement(snapshotId, baseSnapshotId, selector, safeLimit);
    exactRows.push(...(yield* sql.unsafe<SearchSymbolRow>(statement.text, statement.parameters)));
  }
  const candidateLimit = Math.min(2_000, Math.max(100, safeLimit * 20));
  const termStatement =
    terms.length === 0
      ? undefined
      : codeGraphTermCandidateQueryStatement(snapshotId, baseSnapshotId, terms, candidateLimit);
  const termCandidates =
    termStatement === undefined
      ? []
      : yield* sql.unsafe<{readonly score: number; readonly symbol_id: string}>(
          termStatement.text,
          termStatement.parameters,
        );
  const termScores = new Map(termCandidates.map(candidate => [candidate.symbol_id, Number(candidate.score)]));
  const termRows = (yield* selectSymbolsByIdsWithSql(
    sql,
    snapshotId,
    baseSnapshotId,
    termCandidates.map(candidate => candidate.symbol_id),
  )).map(row => ({...row, score: termScores.get(row.id) ?? 0}));
  const exactEvidence = new Map<string, Pick<SearchSymbolRow, 'exact_rank' | 'score'>>();
  for (const row of exactRows) {
    const current = exactEvidence.get(row.id);
    exactEvidence.set(row.id, {
      exact_rank: Math.max(current?.exact_rank ?? 0, row.exact_rank),
      score: Math.max(current?.score ?? 0, row.score),
    });
  }
  const byId = new Map<string, SearchSymbolRow>();
  for (const row of [...termRows.map(row => ({...row, exact_rank: 0})), ...exactRows]) {
    const current = byId.get(row.id);
    if (!current || compareRows(row, current) < 0) byId.set(row.id, row);
  }
  const ranked = [...byId.values()]
    .map(row => {
      const exact = exactEvidence.get(row.id);
      return {
        ...row,
        exact_rank: exact?.exact_rank ?? 0,
        rankingScore: termScores.get(row.id) ?? exact?.score ?? row.score,
        score: exact?.score ?? termScores.get(row.id) ?? row.score,
      };
    })
    .sort(compareRows);
  const exactIds = new Set(exactEvidence.keys());
  // Admit exact identities before the bounded page is truncated, then retain
  // the established path and side-effect-owner ordering within that page.
  const reservedExact = ranked.filter(row => exactIds.has(row.id)).slice(0, safeLimit);
  const selected = [
    ...reservedExact,
    ...ranked.filter(row => !exactIds.has(row.id)).slice(0, safeLimit - reservedExact.length),
  ].sort(compareRows);
  return selected.map(rankedNode);
});

const selectSearchSymbolsMany = Effect.fn('codeGraph.selectSearchSymbolsMany')(function* (
  snapshotId: string,
  queries: readonly string[],
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return yield* Effect.forEach(
    queries,
    query => selectSearchSymbolsWithSql(sql, snapshotId, baseSnapshotId, query, limit),
    {concurrency: 1},
  );
});

const selectSymbolsByIds = Effect.fn('codeGraph.selectSymbolsByIds')(function* (
  snapshotId: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return (yield* selectSymbolsByIdsWithSql(sql, snapshotId, baseSnapshotId, ids)).map(symbolFromRow);
});

/** Build bounded adjacency SQL whose branches seek the directional indexes. */

const selectEdgesForNodes = Effect.fn('codeGraph.selectEdgesForNodes')(function* (
  snapshotId: string,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  if (nodeIds.length === 0 || limit <= 0 || allowedProvenances.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const ids = [...new Set(nodeIds)].slice(0, 500);
  const statement = codeGraphAdjacencyQueryStatement(
    snapshotId,
    baseSnapshotId,
    ids,
    direction,
    limit,
    allowedProvenances,
  );
  const rows = yield* sql.unsafe<EdgeRow>(statement.text, statement.parameters);
  return rows.map(edgeFromRow);
});

const selectDirectEdgeBetweenNodes = Effect.fn('codeGraph.selectDirectEdgeBetweenNodes')(function* (
  snapshotId: string,
  sourceId: string,
  targetId: string,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  if (allowedProvenances.length === 0) return undefined;
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const statement = codeGraphDirectEdgeQueryStatement(
    snapshotId,
    baseSnapshotId,
    sourceId,
    targetId,
    allowedProvenances,
  );
  const rows = yield* sql.unsafe<EdgeRow>(statement.text, statement.parameters);
  return rows[0] ? edgeFromRow(rows[0]) : undefined;
});

function representativeEdgeRows(
  pages: readonly {readonly nodeId: string; readonly rows: readonly EdgeRow[]}[],
  limit: number,
): readonly EdgeRow[] {
  const output = new Map<string, EdgeRow>();
  const coveredNodes = new Set<string>();
  for (const page of pages) {
    const representative = page.rows[0];
    if (!representative) continue;
    coveredNodes.add(page.nodeId);
    if (!output.has(representative.id) && output.size < limit) output.set(representative.id, representative);
  }
  if (output.size >= limit) return [...output.values()];
  const remaining = pages
    .flatMap(page => page.rows.slice(coveredNodes.has(page.nodeId) ? 1 : 0))
    .sort(compareEdgeRowsByPriority);
  for (const row of remaining) {
    if (!output.has(row.id)) output.set(row.id, row);
    if (output.size >= limit) break;
  }
  return [...output.values()];
}

function compareEdgeRowsByPriority(left: EdgeRow, right: EdgeRow): number {
  const provenanceRank = (value: CodeGraphProvenance): number =>
    value === 'declared' ? 0 : value === 'resolved' ? 1 : value === 'syntactic' ? 2 : 3;
  return (
    provenanceRank(left.provenance) - provenanceRank(right.provenance) ||
    Number(right.confidence) - Number(left.confidence) ||
    compareCodeUnits(left.source_name, right.source_name) ||
    compareCodeUnits(left.relation, right.relation) ||
    compareCodeUnits(left.target_name, right.target_name) ||
    compareCodeUnits(left.id, right.id)
  );
}

export {
  selectReusableBaseReceipt,
  selectReusableFoldForwardBase,
  selectReusableCleanBaseForCommit,
  selectReusableCleanBaseForCommitPaths,
  selectExistingSnapshotFilePaths,
  selectAllEffectiveSymbols,
  SearchSymbolRow,
  compactLexicalTermBranch,
  selectSymbolsByIdsWithSql,
  selectFileBlobBatch,
  selectAllEffectiveEdges,
  searchSymbolRowComparator,
  selectSearchSymbolsWithSql,
  compareEdgeRowsByPriority,
  representativeEdgeRows,
  selectReadySnapshot,
  selectReadySnapshotById,
  selectCurrentLexicalReadySnapshotById,
  selectReadySnapshotForCommit,
  selectRecentReadySnapshotsForRepository,
  selectReusableCleanBase,
  selectReusableOverlayBase,
  selectReusableReexports,
  selectCachedFacts,
  selectMaterializedFileShards,
  selectSnapshotMaterializedFileShards,
  selectStoredGraph,
  selectStoredSymbols,
  selectEdgePage,
  selectSearchSymbols,
  selectSearchSymbolsMany,
  selectSymbolsByIds,
  selectEdgesForNodes,
  selectDirectEdgeBetweenNodes,
};
