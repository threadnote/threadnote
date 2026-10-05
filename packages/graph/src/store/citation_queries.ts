import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  CODE_GRAPH_CITATION_QUERY_MAX_MATCHES_PER_TARGET,
  CODE_GRAPH_CITATION_QUERY_MAX_TARGETS,
  selectCodeGraphCitationContentHashTargets,
  type CodeGraphCitationFileRelocationFallbackV1,
  type CodeGraphEffectiveFileHashMatches,
  type CodeGraphEffectiveFilePathObservation,
  type CodeGraphEffectiveSnapshotCitationEvidence,
  type CodeGraphEffectiveSnapshotCitationEvidenceRequest,
  type CodeGraphEffectiveSymbolLocatorMatches,
  type CodeGraphSymbolSemanticLocatorV1,
} from '../citation/primitives.js';
import {configureConnection} from './session.js';
import {selectBaseSnapshotId} from './query/core.js';
import {decodeCodeGraphInventoryReuseReceipt} from '../inventory/reuse.js';
import type {SymbolRow} from './internal_models.js';
import {symbolFromRow} from './rows.js';
import type {CodeGraphInventoryFile} from '../types.js';
import {CodeGraphStoreError} from '../types.js';
import type {CodeGraphSqlQueryStatement} from './visualization_sql.js';
import {selectSymbolsByIdsWithSql} from './queries.js';

interface EffectiveFileRow {
  readonly content_hash: string;
  readonly language: string;
  readonly match_rank?: number;
  readonly mode: string;
  readonly path: string;
  readonly raw_content_hash: string | null;
  readonly request_index: number;
  readonly size: number;
  readonly source: 'commit' | 'worktree';
}

interface EffectiveFilePathRow {
  readonly content_hash: string | null;
  readonly language: string | null;
  readonly mode: string | null;
  readonly path: string | null;
  readonly raw_content_hash: string | null;
  readonly request_index: number;
  readonly requested_path: string;
  readonly size: number | null;
  readonly source: 'commit' | 'worktree' | null;
}

interface EffectiveSemanticSymbolRow extends SymbolRow {
  readonly locator_index: number;
  readonly match_rank: number;
}

interface CitationInventoryCoverageRow {
  readonly base_snapshot_id: string | null;
  readonly dirty: number;
  readonly inventory_snapshot_id: string | null;
  readonly inventory_receipt_json: string | null;
}

export function codeGraphEffectiveFilesByPathsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  paths: readonly string[],
): CodeGraphSqlQueryStatement {
  return {
    parameters: [JSON.stringify(paths), snapshotId, baseSnapshotId ?? '', snapshotId, snapshotId],
    text: `WITH requested(request_index, path) AS (
      SELECT CAST(key AS INTEGER), CAST(value AS TEXT)
      FROM json_each(?)
    ), matching_files AS (
      SELECT requested.request_index, current_files.*
      FROM requested
      CROSS JOIN snapshot_files AS current_files INDEXED BY sqlite_autoindex_snapshot_files_1
      WHERE current_files.snapshot_id = ? AND current_files.path = requested.path
      UNION ALL
      SELECT requested.request_index, base_files.*
      FROM requested
      CROSS JOIN snapshot_files AS base_files INDEXED BY sqlite_autoindex_snapshot_files_1
      WHERE base_files.snapshot_id = ? AND base_files.path = requested.path
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_files AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.path = base_files.path
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_file_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.path = base_files.path
      )
    )
    SELECT requested.request_index, requested.path AS requested_path,
      matching_files.path, matching_files.content_hash, matching_files.raw_content_hash, matching_files.language,
      matching_files.mode, matching_files.size, matching_files.source
    FROM requested
    LEFT JOIN matching_files ON matching_files.request_index = requested.request_index
    ORDER BY requested.request_index`,
  };
}

export function codeGraphEffectiveFilesByContentHashesQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  contentHashes: readonly string[],
  limitPerHash: number,
): CodeGraphSqlQueryStatement {
  return {
    parameters: [
      JSON.stringify(contentHashes),
      snapshotId,
      snapshotId,
      baseSnapshotId ?? '',
      snapshotId,
      snapshotId,
      baseSnapshotId ?? '',
      snapshotId,
      snapshotId,
      limitPerHash + 1,
    ],
    text: `WITH requested(request_index, content_hash) AS (
      SELECT CAST(key AS INTEGER), CAST(value AS TEXT)
      FROM json_each(?)
    ), matching_files AS (
      SELECT requested.request_index, current_files.*
      FROM requested
      CROSS JOIN snapshot_files AS current_files INDEXED BY snapshot_files_content_hash
      WHERE current_files.content_hash = requested.content_hash AND current_files.snapshot_id = ?
      UNION ALL
      SELECT requested.request_index, current_files.*
      FROM requested
      CROSS JOIN snapshot_files AS current_files INDEXED BY snapshot_files_raw_content_hash
      WHERE current_files.raw_content_hash = requested.content_hash
        AND current_files.raw_content_hash IS NOT NULL
        AND current_files.raw_content_hash IS NOT current_files.content_hash
        AND current_files.snapshot_id = ?
      UNION ALL
      SELECT requested.request_index, base_files.*
      FROM requested
      CROSS JOIN snapshot_files AS base_files INDEXED BY snapshot_files_content_hash
      WHERE base_files.content_hash = requested.content_hash AND base_files.snapshot_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_files AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.path = base_files.path
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_file_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.path = base_files.path
        )
      UNION ALL
      SELECT requested.request_index, base_files.*
      FROM requested
      CROSS JOIN snapshot_files AS base_files INDEXED BY snapshot_files_raw_content_hash
      WHERE base_files.raw_content_hash = requested.content_hash
        AND base_files.raw_content_hash IS NOT NULL
        AND base_files.raw_content_hash IS NOT base_files.content_hash
        AND base_files.snapshot_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_files AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.path = base_files.path
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_file_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.path = base_files.path
        )
    ), ranked_files AS (
      SELECT matching_files.*,
        ROW_NUMBER() OVER (PARTITION BY request_index ORDER BY path) AS match_rank
      FROM matching_files
    )
    SELECT * FROM ranked_files
    WHERE match_rank <= ?
    ORDER BY request_index, match_rank`,
  };
}

export function codeGraphEffectiveSymbolsBySemanticLocatorsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  locators: readonly CodeGraphSymbolSemanticLocatorV1[],
  limitPerLocator: number,
): CodeGraphSqlQueryStatement {
  return {
    parameters: [
      JSON.stringify(locators),
      snapshotId,
      baseSnapshotId ?? '',
      snapshotId,
      snapshotId,
      limitPerLocator + 1,
    ],
    text: `WITH requested(locator_index, language, kind, name, qualified_name) AS (
      SELECT CAST(key AS INTEGER),
        CAST(json_extract(value, '$.language') AS TEXT),
        CAST(json_extract(value, '$.kind') AS TEXT),
        CAST(json_extract(value, '$.name') AS TEXT),
        CAST(json_extract(value, '$.qualifiedName') AS TEXT)
      FROM json_each(?)
    ), matching_symbols AS (
      SELECT requested.locator_index, current_symbols.*
      FROM requested
      CROSS JOIN symbols AS current_symbols INDEXED BY symbols_qualified_nocase
      WHERE current_symbols.snapshot_id = ?
        AND current_symbols.qualified_name = requested.qualified_name COLLATE NOCASE
        AND current_symbols.qualified_name = requested.qualified_name COLLATE BINARY
        AND current_symbols.language = requested.language COLLATE BINARY
        AND current_symbols.kind = requested.kind COLLATE BINARY
        AND current_symbols.name = requested.name COLLATE BINARY
      UNION ALL
      SELECT requested.locator_index, base_symbols.*
      FROM requested
      CROSS JOIN symbols AS base_symbols INDEXED BY symbols_qualified_nocase
      WHERE base_symbols.snapshot_id = ?
        AND base_symbols.qualified_name = requested.qualified_name COLLATE NOCASE
        AND base_symbols.qualified_name = requested.qualified_name COLLATE BINARY
        AND base_symbols.language = requested.language COLLATE BINARY
        AND base_symbols.kind = requested.kind COLLATE BINARY
        AND base_symbols.name = requested.name COLLATE BINARY
        AND NOT EXISTS (
          SELECT 1 FROM symbols AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
        )
    ), ranked_symbols AS (
      SELECT matching_symbols.*,
        ROW_NUMBER() OVER (PARTITION BY locator_index ORDER BY path, id) AS match_rank
      FROM matching_symbols
    )
    SELECT * FROM ranked_symbols
    WHERE match_rank <= ?
    ORDER BY locator_index, match_rank`,
  };
}

export const selectEffectiveSnapshotFilesByPaths = Effect.fn('codeGraph.selectEffectiveSnapshotFilesByPaths')(
  function* (snapshotId: string, inputPaths: readonly string[]) {
    const paths = yield* validateCitationPaths(inputPaths);
    if (paths.length === 0) return [];
    const sql = yield* SqlClient.SqlClient;
    yield* configureConnection(sql);
    const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
    const logicalSource = yield* selectLogicalSnapshotFileSource(sql, snapshotId);
    const statement = codeGraphEffectiveFilesByPathsQueryStatement(snapshotId, baseSnapshotId, paths);
    const rows = yield* sql.unsafe<EffectiveFilePathRow>(statement.text, statement.parameters);
    return filePathObservationsFromRows(rows, logicalSource);
  },
);

export const selectEffectiveSnapshotFilesByContentHashes = Effect.fn(
  'codeGraph.selectEffectiveSnapshotFilesByContentHashes',
)(function* (snapshotId: string, inputContentHashes: readonly string[], requestedLimitPerHash: number) {
  const contentHashes = yield* validateCitationContentHashes(inputContentHashes);
  const limitPerHash = yield* validateMatchLimit(requestedLimitPerHash);
  if (contentHashes.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const logicalSource = yield* selectLogicalSnapshotFileSource(sql, snapshotId);
  const statement = codeGraphEffectiveFilesByContentHashesQueryStatement(
    snapshotId,
    baseSnapshotId,
    contentHashes,
    limitPerHash,
  );
  const rows = yield* sql.unsafe<EffectiveFileRow>(statement.text, statement.parameters);
  return fileHashMatchesFromRows(contentHashes, rows, limitPerHash, logicalSource);
});

export const selectEffectiveSnapshotSymbolsBySemanticLocators = Effect.fn(
  'codeGraph.selectEffectiveSnapshotSymbolsBySemanticLocators',
)(function* (
  snapshotId: string,
  inputLocators: readonly CodeGraphSymbolSemanticLocatorV1[],
  requestedLimitPerLocator: number,
) {
  const locators = yield* validateSemanticLocators(inputLocators);
  const limitPerLocator = yield* validateMatchLimit(requestedLimitPerLocator);
  if (locators.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const statement = codeGraphEffectiveSymbolsBySemanticLocatorsQueryStatement(
    snapshotId,
    baseSnapshotId,
    locators,
    limitPerLocator,
  );
  const rows = yield* sql.unsafe<EffectiveSemanticSymbolRow>(statement.text, statement.parameters);
  return symbolLocatorMatchesFromRows(locators, rows, limitPerLocator);
});

/**
 * Run every citation observation against one ready snapshot using one SQLite
 * session. Statements remain independently bounded so an adapter can request
 * all capture/validation primitives without connection-level N+1 behavior.
 */
export const selectEffectiveSnapshotCitationEvidence = Effect.fn('codeGraph.selectEffectiveSnapshotCitationEvidence')(
  function* (snapshotId: string, request: CodeGraphEffectiveSnapshotCitationEvidenceRequest) {
    const fileRelocationFallbacks = yield* validateCitationFileRelocationFallbacks(
      request.fileRelocationFallbacks ?? [],
    );
    const eagerPaths = yield* validateCitationPaths(request.paths ?? []);
    const paths = yield* validateCitationPaths([
      ...new Set([...eagerPaths, ...fileRelocationFallbacks.map(fallback => fallback.path)]),
    ]);
    const eagerContentHashes = yield* validateCitationContentHashes(request.contentHashes ?? []);
    yield* validateCitationContentHashes([
      ...new Set([...eagerContentHashes, ...fileRelocationFallbacks.map(fallback => fallback.contentHash)]),
    ]);
    const symbolIds = yield* validateCitationSymbolIds(request.symbolIds ?? []);
    const semanticLocators = yield* validateSemanticLocators(request.semanticLocators ?? []);
    const limitPerContentHash = yield* validateMatchLimit(request.limitPerContentHash ?? 2);
    const limitPerSemanticLocator = yield* validateMatchLimit(request.limitPerSemanticLocator ?? 2);
    const sql = yield* SqlClient.SqlClient;
    yield* configureConnection(sql);
    const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
    const coverageRows = yield* sql<CitationInventoryCoverageRow>`
      SELECT snapshot.base_snapshot_id, snapshot.dirty,
        receipt.snapshot_id AS inventory_snapshot_id, receipt.inventory_receipt_json
      FROM snapshots AS snapshot
      LEFT JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
      WHERE snapshot.id = ${snapshotId} AND snapshot.state = 'ready'
      LIMIT 1
    `;
    const coverageRow = coverageRows[0];
    const logicalSource =
      coverageRow !== undefined && Number(coverageRow.dirty) === 0 ? ('commit' as const) : undefined;
    const inventoryReceipt = decodeCodeGraphInventoryReuseReceipt(coverageRow?.inventory_receipt_json ?? null);
    const fileInventoryCoverage =
      coverageRow !== undefined &&
      Number(coverageRow.dirty) === 0 &&
      coverageRow.inventory_snapshot_id === snapshotId &&
      inventoryReceipt?.skipped === 0
        ? ('complete' as const)
        : ('incomplete' as const);

    const pathRows =
      paths.length === 0
        ? []
        : yield* executeStatement<EffectiveFilePathRow>(
            sql,
            codeGraphEffectiveFilesByPathsQueryStatement(snapshotId, baseSnapshotId, paths),
          );
    const contentHashes = selectCodeGraphCitationContentHashTargets(
      eagerContentHashes,
      fileRelocationFallbacks,
      new Set(pathRows.flatMap(row => (row.path === null ? [] : [row.requested_path]))),
    );
    const hashRows =
      contentHashes.length === 0
        ? []
        : yield* executeStatement<EffectiveFileRow>(
            sql,
            codeGraphEffectiveFilesByContentHashesQueryStatement(
              snapshotId,
              baseSnapshotId,
              contentHashes,
              limitPerContentHash,
            ),
          );
    const symbolRows =
      symbolIds.length === 0 ? [] : yield* selectSymbolsByIdsWithSql(sql, snapshotId, baseSnapshotId, symbolIds);
    const semanticRows =
      semanticLocators.length === 0
        ? []
        : yield* executeStatement<EffectiveSemanticSymbolRow>(
            sql,
            codeGraphEffectiveSymbolsBySemanticLocatorsQueryStatement(
              snapshotId,
              baseSnapshotId,
              semanticLocators,
              limitPerSemanticLocator,
            ),
          );

    return {
      fileInventoryCoverage,
      filesByContentHashes: fileHashMatchesFromRows(contentHashes, hashRows, limitPerContentHash, logicalSource),
      filesByPaths: filePathObservationsFromRows(pathRows, logicalSource),
      symbolsByIds: symbolRows.map(symbolFromRow),
      symbolsBySemanticLocators: symbolLocatorMatchesFromRows(semanticLocators, semanticRows, limitPerSemanticLocator),
    } satisfies CodeGraphEffectiveSnapshotCitationEvidence;
  },
);

function filePathObservationsFromRows(
  rows: readonly EffectiveFilePathRow[],
  logicalSource?: CodeGraphInventoryFile['source'],
): readonly CodeGraphEffectiveFilePathObservation[] {
  return rows.map(row => ({
    ...(row.path === null ? {} : {file: inventoryFileFromRow(row as EffectiveFileRow, logicalSource)}),
    path: row.requested_path,
  }));
}

function fileHashMatchesFromRows(
  contentHashes: readonly string[],
  rows: readonly EffectiveFileRow[],
  limitPerHash: number,
  logicalSource?: CodeGraphInventoryFile['source'],
): readonly CodeGraphEffectiveFileHashMatches[] {
  const pages = contentHashes.map(contentHash => ({
    contentHash,
    files: [] as CodeGraphInventoryFile[],
    truncated: false,
  }));
  for (const row of rows) {
    const page = pages[row.request_index];
    if (page === undefined) continue;
    if ((row.match_rank ?? 0) > limitPerHash) page.truncated = true;
    else page.files.push(inventoryFileFromRow(row, logicalSource));
  }
  return pages;
}

function symbolLocatorMatchesFromRows(
  locators: readonly CodeGraphSymbolSemanticLocatorV1[],
  rows: readonly EffectiveSemanticSymbolRow[],
  limitPerLocator: number,
): readonly CodeGraphEffectiveSymbolLocatorMatches[] {
  const pages = locators.map(locator => ({
    locator,
    symbols: [] as ReturnType<typeof symbolFromRow>[],
    truncated: false,
  }));
  for (const row of rows) {
    const page = pages[row.locator_index];
    if (page === undefined) continue;
    if (Number(row.match_rank) > limitPerLocator) page.truncated = true;
    else page.symbols.push(symbolFromRow(row));
  }
  return pages;
}

function executeStatement<A extends object>(sql: SqlClient.SqlClient, statement: CodeGraphSqlQueryStatement) {
  return sql.unsafe<A>(statement.text, statement.parameters);
}

function inventoryFileFromRow(
  row: EffectiveFileRow,
  logicalSource: CodeGraphInventoryFile['source'] = row.source,
): CodeGraphInventoryFile {
  return {
    blobId: `snapshot:${row.content_hash}`,
    contentHash: row.content_hash,
    language: row.language,
    mode: row.mode,
    path: row.path,
    ...(row.raw_content_hash === null ? {} : {rawContentHash: row.raw_content_hash}),
    size: Number(row.size),
    source: logicalSource,
  };
}

/** A clean logical alias makes physically reused overlay bytes commit-authoritative. */
const selectLogicalSnapshotFileSource = Effect.fn('codeGraph.selectLogicalSnapshotFileSource')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  const rows = yield* sql<{readonly dirty: number}>`
    SELECT dirty FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  return rows[0] !== undefined && Number(rows[0].dirty) === 0 ? ('commit' as const) : undefined;
});

function validateCitationPaths(paths: readonly string[]) {
  return validateUniqueTargets(paths, path => path, validCitationPath, 'repository-relative code graph path');
}

function validateCitationContentHashes(contentHashes: readonly string[]) {
  return validateUniqueTargets(
    contentHashes,
    contentHash => contentHash,
    validCitationContentHash,
    'SHA-256 code graph content hash',
  );
}

function validateCitationFileRelocationFallbacks(fallbacks: readonly CodeGraphCitationFileRelocationFallbackV1[]) {
  return validateUniqueTargets(
    fallbacks,
    fallback => `${fallback.path}\0${fallback.contentHash}`,
    fallback =>
      typeof fallback === 'object' &&
      fallback !== null &&
      validCitationPath(fallback.path) &&
      validCitationContentHash(fallback.contentHash),
    'code graph file relocation fallback',
  );
}

function validCitationPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 4_096 &&
    !path.includes('\0') &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function validCitationContentHash(contentHash: unknown): contentHash is string {
  return typeof contentHash === 'string' && /^[0-9a-f]{64}$/u.test(contentHash);
}

function validateCitationSymbolIds(symbolIds: readonly string[]) {
  return validateUniqueTargets(
    symbolIds,
    symbolId => symbolId,
    symbolId =>
      typeof symbolId === 'string' && symbolId.length > 0 && symbolId.length <= 512 && !symbolId.includes('\0'),
    'code graph symbol ID',
  );
}

function validateSemanticLocators(locators: readonly CodeGraphSymbolSemanticLocatorV1[]) {
  return validateUniqueTargets(
    locators,
    locator => JSON.stringify([locator.version, locator.language, locator.kind, locator.name, locator.qualifiedName]),
    locator =>
      typeof locator === 'object' &&
      locator !== null &&
      locator.version === 1 &&
      validLocatorField(locator.language, 256) &&
      validLocatorField(locator.kind, 256) &&
      validLocatorField(locator.name, 1_024) &&
      validLocatorField(locator.qualifiedName, 4_096),
    'code graph semantic locator',
  );
}

function validLocatorField(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumBytes && !value.includes('\0');
}

function validateUniqueTargets<T>(
  values: readonly T[],
  key: (value: T) => string,
  valid: (value: T) => boolean,
  description: string,
) {
  if (values.length > CODE_GRAPH_CITATION_QUERY_MAX_TARGETS) {
    return Effect.fail(
      CodeGraphStoreError.of(
        `A citation query accepts at most ${CODE_GRAPH_CITATION_QUERY_MAX_TARGETS} ${description}s.`,
      ),
    );
  }
  const output: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!valid(value)) return Effect.fail(CodeGraphStoreError.of(`Citation query ${description} is invalid.`));
    const identity = key(value);
    if (!seen.has(identity)) {
      seen.add(identity);
      output.push(value);
    }
  }
  return Effect.succeed(output);
}

function validateMatchLimit(limit: number) {
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= CODE_GRAPH_CITATION_QUERY_MAX_MATCHES_PER_TARGET
    ? Effect.succeed(limit)
    : Effect.fail(
        CodeGraphStoreError.of(
          `A citation query per-target limit must be between 1 and ${CODE_GRAPH_CITATION_QUERY_MAX_MATCHES_PER_TARGET}.`,
        ),
      );
}
