import {Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  codeGraphBlobExtractionReuseClass,
  codeGraphStoredBlobReuseCacheKey,
  type CodeGraphBlobReuseFile,
} from '../../blob_reuse.js';
import {configureConnection} from '../session.js';
import {CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} from '../cache/authority.js';
import {CODE_GRAPH_STORED_FACT_CODEC, storedCodeGraphFactRawBytesSql} from '../../fact/storage.js';
import {type CodeGraphProvenance, CodeGraphStoreError} from '../../types.js';
import {sqlTextOption} from '../utilities.js';
import {type CodeGraphSqlQueryStatement} from '../visualization_sql.js';

function selectFileBlobMetadataBatch(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphBlobReuseFile[],
  extractorSet: string,
) {
  if (files.length === 0) {
    return Effect.succeed([] as readonly {readonly facts_bytes: number; readonly path_hint: string}[]);
  }
  return sql.unsafe<{readonly facts_bytes: number; readonly path_hint: string}>(
    `SELECT path_hint, ${storedCodeGraphFactRawBytesSql('facts_json')} AS facts_bytes
     FROM file_blobs
     WHERE extractor_set = ?
       AND (${files.map(() => '(content_hash = ? AND path_hint = ?)').join(' OR ')})`,
    [extractorSet, ...files.flatMap(file => [file.contentHash, file.path])],
  );
}

interface ReusableFileBlobRow {
  readonly facts_bytes: number;
  readonly facts_json: string;
  readonly path_hint: string;
  readonly target_path: string;
}

function selectReusableFileBlobMetadataBatch(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphBlobReuseFile[],
  extractorSet: string,
) {
  const targets = reusableFileBlobTargets(files);
  if (targets.length === 0) {
    return Effect.succeed([] as readonly Pick<ReusableFileBlobRow, 'facts_bytes' | 'target_path'>[]);
  }
  return sql.unsafe<Pick<ReusableFileBlobRow, 'facts_bytes' | 'target_path'>>(
    `${reusableFileBlobTargetCte(targets)}
     SELECT requested.target_path,
            CASE
              WHEN json_extract(blob.facts_json, '$.codec') = '${CODE_GRAPH_STORED_FACT_CODEC}'
              THEN MAX(
                ${storedCodeGraphFactRawBytesSql('blob.facts_json')},
                ${storedCodeGraphFactRawBytesSql('blob.facts_json')} +
                  CAST(json_extract(blob.facts_json, '$.pathOccurrences') AS INTEGER) *
                  (length(CAST(substr(json_quote(requested.target_path), 2,
                    length(json_quote(requested.target_path)) - 2) AS BLOB)) -
                   length(CAST(substr(json_quote(blob.path_hint), 2,
                    length(json_quote(blob.path_hint)) - 2) AS BLOB)))
              )
              ELSE MAX(
                length(CAST(blob.facts_json AS BLOB)),
                length(CAST(replace(
                  blob.facts_json,
                  substr(json_quote(blob.path_hint), 2, length(json_quote(blob.path_hint)) - 2),
                  substr(json_quote(requested.target_path), 2, length(json_quote(requested.target_path)) - 2)
                ) AS BLOB))
              )
            END AS facts_bytes
     FROM requested
     JOIN file_blobs AS blob ON ${reusableFileBlobJoin('blob')}
     WHERE blob.extractor_set = ?
       AND blob.path_hint <> requested.target_path
       AND json_valid(blob.facts_json)
       AND json_extract(blob.facts_json, '$.path') = blob.path_hint
       AND blob.path_hint = (${reusableFileBlobFirstDonorSubquery()})`,
    [...reusableFileBlobTargetParameters(targets), extractorSet],
  );
}

function selectReusableFileBlobBatch(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphBlobReuseFile[],
  extractorSet: string,
) {
  const targets = reusableFileBlobTargets(files);
  if (targets.length === 0) return Effect.succeed([] as readonly ReusableFileBlobRow[]);
  return sql.unsafe<ReusableFileBlobRow>(
    `${reusableFileBlobTargetCte(targets)}
     SELECT requested.target_path, blob.path_hint, blob.facts_json,
            ${storedCodeGraphFactRawBytesSql('blob.facts_json')} AS facts_bytes
     FROM requested
     JOIN file_blobs AS blob ON ${reusableFileBlobJoin('blob')}
     WHERE blob.extractor_set = ?
       AND blob.path_hint <> requested.target_path
       AND json_valid(blob.facts_json)
       AND json_extract(blob.facts_json, '$.path') = blob.path_hint
       AND blob.path_hint = (${reusableFileBlobFirstDonorSubquery()})`,
    [...reusableFileBlobTargetParameters(targets), extractorSet],
  );
}

interface ReusableFileBlobTarget {
  readonly blobId: string;
  readonly contentHash: string;
  readonly language: string;
  readonly path: string;
  readonly reuseClass: string;
}

function reusableFileBlobTargets(files: readonly CodeGraphBlobReuseFile[]): readonly ReusableFileBlobTarget[] {
  return files.flatMap(file => {
    const reuseClass = codeGraphBlobExtractionReuseClass(file);
    return reuseClass === undefined
      ? []
      : [
          {
            blobId: file.blobId!,
            contentHash: file.contentHash,
            language: file.language!,
            path: file.path,
            reuseClass,
          },
        ];
  });
}

function reusableFileBlobTargetCte(targets: readonly ReusableFileBlobTarget[]): string {
  return `WITH requested(target_path, content_hash, blob_id, reuse_class) AS (
    VALUES ${targets.map(() => '(?, ?, ?, ?)').join(', ')}
  )`;
}

function reusableFileBlobTargetParameters(targets: readonly ReusableFileBlobTarget[]): readonly string[] {
  return targets.flatMap(target => [target.path, target.contentHash, target.blobId, target.reuseClass]);
}

function reusableFileBlobJoin(alias: string): string {
  return `${alias}.blob_id = requested.blob_id
    AND ${alias}.content_hash = requested.content_hash
    AND ${alias}.reuse_class = requested.reuse_class`;
}

function reusableFileBlobFirstDonorSubquery(): string {
  return `SELECT MIN(donor.path_hint)
    FROM file_blobs AS donor
    WHERE ${reusableFileBlobJoin('donor')}
      AND donor.extractor_set = blob.extractor_set
      AND donor.path_hint <> requested.target_path
      AND json_valid(donor.facts_json)
      AND json_extract(donor.facts_json, '$.path') = donor.path_hint`;
}

export function codeGraphCachedCommittedFileKeysStatement(
  extractorSet: string,
  files?: readonly {readonly contentHash: string; readonly path: string}[],
): CodeGraphSqlQueryStatement {
  const targetPredicate =
    files === undefined
      ? ''
      : files.length === 0
        ? ' AND 0'
        : ` AND (${files.map(() => '(path_hint = ? AND content_hash = ?)').join(' OR ')})`;
  return {
    parameters: [extractorSet, ...(files?.flatMap(file => [file.path, file.contentHash]) ?? [])],
    text: `SELECT
      CASE
        WHEN typeof(blob_id) = 'text' AND length(CAST(blob_id AS BLOB)) IN (40, 64) THEN blob_id
        ELSE NULL
      END AS blob_id,
      content_hash,
      path_hint,
      CASE
        WHEN typeof(reuse_class) = 'text' AND length(CAST(reuse_class AS BLOB)) <= 128 THEN reuse_class
        ELSE NULL
      END AS reuse_class
    FROM ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE}
    WHERE extractor_set = ?${targetPredicate}`,
  };
}

const selectCachedCommittedFileKeys = Effect.fn('codeGraph.selectCachedCommittedFileKeys')(function* (
  extractorSet: string,
  files?: readonly {readonly contentHash: string; readonly path: string}[],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const statement = codeGraphCachedCommittedFileKeysStatement(extractorSet, files);
  const rows = yield* sql.unsafe<{
    readonly blob_id: unknown;
    readonly content_hash: string;
    readonly path_hint: string;
    readonly reuse_class: unknown;
  }>(statement.text, statement.parameters);
  const keys = new Set(rows.map(row => `${row.path_hint}\0${row.content_hash}\0${extractorSet}`));
  for (const row of rows) {
    if (
      typeof row.blob_id !== 'string' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(row.blob_id) ||
      typeof row.reuse_class !== 'string' ||
      !/^structured-object-v1:(?:json|jsonc|yaml):full$/u.test(row.reuse_class)
    ) {
      continue;
    }
    keys.add(codeGraphStoredBlobReuseCacheKey(row.blob_id, row.content_hash, extractorSet, row.reuse_class));
  }
  return keys;
});

function effectiveSymbolsCte(): string {
  return `WITH effective_symbols AS (
    SELECT current_symbols.*
    FROM symbols AS current_symbols
    WHERE current_symbols.snapshot_id = ?
    UNION ALL
    SELECT base_symbols.*
    FROM symbols AS base_symbols
    WHERE base_symbols.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM symbols AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_symbol_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
      )
  )`;
}

function effectiveEdgesCte(): string {
  return `WITH effective_edges AS (
    SELECT current_edges.*
    FROM edges AS current_edges
    WHERE current_edges.snapshot_id = ?
    UNION ALL
    SELECT base_edges.*
    FROM edges AS base_edges
    WHERE base_edges.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM edges AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_edge_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
      )
  )`;
}

function effectiveGraphCtes(): string {
  return `WITH effective_symbols AS (
    SELECT current_symbols.*
    FROM symbols AS current_symbols
    WHERE current_symbols.snapshot_id = ?
    UNION ALL
    SELECT base_symbols.*
    FROM symbols AS base_symbols
    WHERE base_symbols.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM symbols AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_symbol_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
      )
  ), effective_edges AS (
    SELECT current_edges.*
    FROM edges AS current_edges
    WHERE current_edges.snapshot_id = ?
    UNION ALL
    SELECT base_edges.*
    FROM edges AS base_edges
    WHERE base_edges.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM edges AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_edge_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
      )
  )`;
}

function effectiveGraphParameters(snapshotId: string, baseSnapshotId: string | undefined): readonly string[] {
  return [
    ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
    ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  ];
}

function effectiveSnapshotParameters(snapshotId: string, baseSnapshotId: string | undefined): readonly string[] {
  return [snapshotId, baseSnapshotId ?? '', snapshotId, snapshotId];
}

const selectBaseSnapshotId = Effect.fn('codeGraph.selectBaseSnapshotId')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  const rows = yield* sql<{readonly base_snapshot_id: unknown}>`
    SELECT base_snapshot_id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  if (!rows[0]) return yield* CodeGraphStoreError.of(`Ready snapshot ${snapshotId} was not found.`);
  return Option.getOrUndefined(sqlTextOption(rows[0].base_snapshot_id));
});

const EXACT_SYMBOL_FIELDS = [
  {column: 'name', index: 'symbols_name_nocase', insensitiveRank: 4, sensitiveRank: 6},
  {column: 'qualified_name', index: 'symbols_qualified_nocase', insensitiveRank: 3, sensitiveRank: 5},
  {column: 'path', index: 'symbols_path_nocase', insensitiveRank: 1, sensitiveRank: 2},
] as const;

/**
 * Build exact-match candidates with the equality predicate inside every
 * current/base branch. Keeping the predicate outside effectiveSymbolsCte()
 * makes SQLite scan every symbol in a large snapshot before applying LIMIT.
 */
export function codeGraphExactSymbolQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  query: string,
  limit: number,
): CodeGraphSqlQueryStatement {
  const branches: string[] = [];
  const parameters: Array<number | string> = [];
  for (const field of EXACT_SYMBOL_FIELDS) {
    branches.push(`SELECT current_symbols.*,
        CASE WHEN current_symbols.${field.column} = ? THEN ${field.sensitiveRank} ELSE ${field.insensitiveRank} END AS exact_rank
      FROM symbols AS current_symbols INDEXED BY ${field.index}
      WHERE current_symbols.snapshot_id = ?
        AND current_symbols.${field.column} = ? COLLATE NOCASE`);
    parameters.push(query, snapshotId, query);
    branches.push(`SELECT base_symbols.*,
        CASE WHEN base_symbols.${field.column} = ? THEN ${field.sensitiveRank} ELSE ${field.insensitiveRank} END AS exact_rank
      FROM symbols AS base_symbols INDEXED BY ${field.index}
      WHERE base_symbols.snapshot_id = ?
        AND base_symbols.${field.column} = ? COLLATE NOCASE
        AND NOT EXISTS (
          SELECT 1 FROM symbols AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
        )`);
    parameters.push(query, baseSnapshotId ?? '', query, snapshotId, snapshotId);
  }
  parameters.push(Math.max(1, Math.min(500, Math.floor(limit))));
  return {
    parameters,
    text: `WITH exact_candidates AS (
        ${branches.join('\n        UNION ALL\n        ')}
      ),
      ranked_exact_symbols AS (
        SELECT exact_candidates.*,
          ROW_NUMBER() OVER (PARTITION BY id ORDER BY exact_rank DESC) AS exact_row
        FROM exact_candidates
      )
      SELECT ranked_exact_symbols.*,
        CASE exact_rank
          WHEN 6 THEN 100 WHEN 5 THEN 99 WHEN 4 THEN 98
          WHEN 3 THEN 97 WHEN 2 THEN 90 ELSE 89
        END AS score
      FROM ranked_exact_symbols
      WHERE exact_row = 1
      ORDER BY exact_rank DESC, exported DESC,
        CASE kind
          WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'protocol' THEN 2
          WHEN 'struct' THEN 3 WHEN 'enum' THEN 4 WHEN 'type_alias' THEN 5
          WHEN 'function' THEN 6 WHEN 'method' THEN 7 WHEN 'constructor' THEN 8
          WHEN 'module' THEN 9 WHEN 'package' THEN 10 WHEN 'field' THEN 11
          WHEN 'property' THEN 12 ELSE 13
        END,
        name, path, id
      LIMIT ?`,
  };
}

function legacyLexicalTermBranch(alias: string, placeholders: string, base: boolean): string {
  const suppression = base
    ? `AND NOT EXISTS (
         SELECT 1 FROM symbols AS overrides
         WHERE overrides.snapshot_id = ? AND overrides.id = ${alias}.symbol_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM snapshot_symbol_deletions AS deletions
         WHERE deletions.snapshot_id = ? AND deletions.symbol_id = ${alias}.symbol_id
       )`
    : '';
  const termPredicate = placeholders.length === 0 ? '' : `AND ${alias}.term IN (${placeholders})`;
  return `SELECT ${alias}.term, ${alias}.symbol_id, ${alias}.weight
    FROM symbol_terms AS ${alias} INDEXED BY sqlite_autoindex_symbol_terms_1
    WHERE ${alias}.snapshot_id = ?
      ${termPredicate}
      AND NOT EXISTS (
        SELECT 1 FROM lexical_storage_formats AS storage
        WHERE storage.snapshot_id = ${alias}.snapshot_id
      )
      ${suppression}`;
}

export type CodeGraphSymbolPathClass = 'documentation' | 'implementation' | 'test';

/**
 * Product names such as MCP tool identifiers appear verbatim in test fixtures
 * and agent-instruction documents as well as in the code that implements them.
 * Those copies match a bare symbol query just as strongly, so they are demoted
 * unless the query itself asks for a test or a document.
 */
const SYMBOL_PATH_CLASS_SCORE_MULTIPLIERS: Readonly<Record<CodeGraphSymbolPathClass, number>> = {
  documentation: 0.55,
  implementation: 1,
  test: 0.7,
};

const DOCUMENTATION_PATH_DIRECTORIES = new Set(['doc', 'docs', 'documentation']);

const DOCUMENTATION_PATH_EXTENSIONS = new Set(['.adoc', '.markdown', '.md', '.mdx', '.rst', '.txt']);

const TEST_PATH_DIRECTORIES = new Set([
  '__mocks__',
  '__tests__',
  'fixtures',
  'spec',
  'specs',
  'test',
  'testdata',
  'tests',
]);

const DOCUMENTATION_QUERY_TERMS = new Set([
  'adoc',
  'doc',
  'docs',
  'documentation',
  'guide',
  'markdown',
  'md',
  'mdx',
  'readme',
  'rst',
]);

const TEST_QUERY_TERMS = new Set([
  '__mocks__',
  '__tests__',
  'fixture',
  'fixtures',
  'mock',
  'mocks',
  'spec',
  'specs',
  'test',
  'testdata',
  'tests',
]);

const SIDE_EFFECT_OWNER_KINDS = new Set(['constructor', 'function', 'method']);

const SIDE_EFFECT_OWNER_TERMS = new Set([
  'activate',
  'apply',
  'clear',
  'close',
  'delete',
  'dismiss',
  'erase',
  'invalidate',
  'logout',
  'perform',
  'purge',
  'remove',
  'reset',
  'revoke',
  'save',
  'sync',
  'terminate',
  'update',
  'wipe',
]);

const TEST_FILE_NAME_PATTERN = /(?:^|[._-])(?:spec|test)s?\.[^.]+$/;

export function codeGraphSymbolPathClass(path: string): CodeGraphSymbolPathClass {
  const segments = path.replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean);
  const fileName = segments.at(-1) ?? '';
  const directories = segments.slice(0, -1);
  const extensionIndex = fileName.lastIndexOf('.');
  const extension = extensionIndex === -1 ? '' : fileName.slice(extensionIndex);
  if (
    DOCUMENTATION_PATH_EXTENSIONS.has(extension) ||
    directories.some(segment => DOCUMENTATION_PATH_DIRECTORIES.has(segment))
  ) {
    return 'documentation';
  }
  if (directories.some(segment => TEST_PATH_DIRECTORIES.has(segment)) || TEST_FILE_NAME_PATTERN.test(fileName)) {
    return 'test';
  }
  return 'implementation';
}

export function codeGraphSymbolPathScoreMultiplier(path: string, queryTerms: readonly string[]): number {
  const pathClass = codeGraphSymbolPathClass(path);
  if (pathClass === 'implementation') return 1;
  const requestedTerms = pathClass === 'test' ? TEST_QUERY_TERMS : DOCUMENTATION_QUERY_TERMS;
  return queryTerms.some(term => requestedTerms.has(term)) ? 1 : SYMBOL_PATH_CLASS_SCORE_MULTIPLIERS[pathClass];
}

/** Prefer production methods that own a mutation or lifecycle transition over lexical copies of that behavior. */
export function codeGraphSymbolSearchScoreMultiplier(
  path: string,
  kind: string,
  name: string,
  queryTerms: readonly string[],
): number {
  const pathMultiplier = codeGraphSymbolPathScoreMultiplier(path, queryTerms);
  if (
    codeGraphSymbolPathClass(path) !== 'implementation' ||
    queryTerms.some(term => TEST_QUERY_TERMS.has(term) || DOCUMENTATION_QUERY_TERMS.has(term)) ||
    !SIDE_EFFECT_OWNER_KINDS.has(kind)
  ) {
    return pathMultiplier;
  }
  const nameTerms = name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter(Boolean);
  return nameTerms.some(term => SIDE_EFFECT_OWNER_TERMS.has(term)) ? pathMultiplier * 1.12 : pathMultiplier;
}

function searchSymbolKindOrder(kind: string): number {
  switch (kind) {
    case 'class':
      return 0;
    case 'interface':
      return 1;
    case 'protocol':
      return 2;
    case 'struct':
      return 3;
    case 'enum':
      return 4;
    case 'type_alias':
      return 5;
    case 'function':
      return 6;
    case 'method':
      return 7;
    case 'constructor':
      return 8;
    case 'module':
      return 9;
    case 'package':
      return 10;
    case 'field':
      return 11;
    case 'property':
      return 12;
    default:
      return 13;
  }
}

export function codeGraphSymbolsByIdsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  ids: readonly string[],
): CodeGraphSqlQueryStatement {
  const uniqueIds = [...new Set(ids)].slice(0, 400);
  const placeholders = uniqueIds.map(() => '?').join(', ');
  return {
    parameters: [snapshotId, ...uniqueIds, baseSnapshotId ?? '', ...uniqueIds, snapshotId, snapshotId],
    text: `WITH matching_symbols AS (
      SELECT current_symbols.*
      FROM symbols AS current_symbols INDEXED BY sqlite_autoindex_symbols_1
      WHERE current_symbols.snapshot_id = ?
        AND current_symbols.id IN (${placeholders})
      UNION ALL
      SELECT base_symbols.*
      FROM symbols AS base_symbols INDEXED BY sqlite_autoindex_symbols_1
      WHERE base_symbols.snapshot_id = ?
        AND base_symbols.id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM symbols AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
        )
    )
    SELECT * FROM matching_symbols
    ORDER BY path, qualified_name, id`,
  };
}

export function isCanonicalAbsoluteBazelLabel(value: string): boolean {
  return /^(?:@@?[^/\\\s:]+)?\/\/[^\\\s:]*:[^\\\s:]+$/u.test(value);
}

function normalizeExactSearchPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (isCanonicalAbsoluteBazelLabel(trimmed)) return undefined;
  const normalized = trimmed
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
  return normalized.includes('/') ? normalized : undefined;
}

function effectiveAdjacentEdgesCte(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  allowedProvenances: readonly CodeGraphProvenance[],
  branchLimit?: number,
): CodeGraphSqlQueryStatement {
  const ids = [...new Set(nodeIds)].slice(0, 500);
  const provenances = [...new Set(allowedProvenances)];
  const idPlaceholders = ids.map(() => '?').join(', ');
  const provenancePlaceholders = provenances.map(() => '?').join(', ');
  const axes =
    direction === 'incoming'
      ? ([{column: 'target_id', index: 'edges_target_resolved'}] as const)
      : direction === 'outgoing'
        ? ([{column: 'source_id', index: 'edges_source'}] as const)
        : ([
            {column: 'source_id', index: 'edges_source'},
            {column: 'target_id', index: 'edges_target_resolved'},
          ] as const);
  const branches: string[] = [];
  const parameters: Array<number | string> = [];
  const boundedBranchLimit =
    branchLimit === undefined ? undefined : Math.max(1, Math.min(5_000, Math.floor(branchLimit)));
  for (const axis of axes) {
    const currentBranch = `SELECT current_edges.*
      FROM edges AS current_edges INDEXED BY ${axis.index}
      WHERE current_edges.snapshot_id = ?
        AND current_edges.${axis.column} IN (${idPlaceholders})
        AND current_edges.${axis.column} IS NOT NULL
        AND current_edges.provenance IN (${provenancePlaceholders})`;
    branches.push(
      boundedBranchLimit === undefined
        ? currentBranch
        : `SELECT * FROM (${currentBranch}
          ORDER BY ${edgePriorityOrder('current_edges')}
          LIMIT ?)`,
    );
    parameters.push(snapshotId, ...ids, ...provenances);
    if (boundedBranchLimit !== undefined) parameters.push(boundedBranchLimit);
    const baseBranch = `SELECT base_edges.*
      FROM edges AS base_edges INDEXED BY ${axis.index}
      WHERE base_edges.snapshot_id = ?
        AND base_edges.${axis.column} IN (${idPlaceholders})
        AND base_edges.${axis.column} IS NOT NULL
        AND base_edges.provenance IN (${provenancePlaceholders})
        AND NOT EXISTS (
          SELECT 1 FROM edges AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_edge_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
        )`;
    branches.push(
      boundedBranchLimit === undefined
        ? baseBranch
        : `SELECT * FROM (${baseBranch}
          ORDER BY ${edgePriorityOrder('base_edges')}
          LIMIT ?)`,
    );
    parameters.push(baseSnapshotId ?? '', ...ids, ...provenances, snapshotId, snapshotId);
    if (boundedBranchLimit !== undefined) parameters.push(boundedBranchLimit);
  }
  return {
    parameters,
    // UNION (rather than UNION ALL) is needed only for `both`: a self-loop is
    // found through both directional indexes but remains one logical edge.
    text: `WITH adjacent_edges AS (
      ${branches.join(direction === 'both' ? '\n      UNION\n      ' : '\n      UNION ALL\n      ')}
    )`,
  };
}

function edgePriorityOrder(alias: string): string {
  return `CASE WHEN ${alias}.source_id IS NULL OR ${alias}.target_id IS NULL THEN 1 ELSE 0 END,
    CASE ${alias}.provenance WHEN 'heuristic' THEN 1 WHEN 'model' THEN 1 ELSE 0 END,
    CASE ${alias}.relation
      WHEN 'exports' THEN 0
      WHEN 'imports' THEN 0
      WHEN 'reexports' THEN 0
      WHEN 'tests' THEN 0
      ELSE 1
    END,
    CASE ${alias}.provenance WHEN 'declared' THEN 0 WHEN 'resolved' THEN 1 WHEN 'syntactic' THEN 2 ELSE 3 END,
    ${alias}.confidence DESC, ${alias}.source_name, ${alias}.relation, ${alias}.target_name, ${alias}.id`;
}

/** Build bounded adjacency SQL whose branches seek the directional indexes. */
export function codeGraphAdjacencyQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
): CodeGraphSqlQueryStatement {
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  const adjacent = effectiveAdjacentEdgesCte(
    snapshotId,
    baseSnapshotId,
    nodeIds,
    direction,
    allowedProvenances,
    safeLimit,
  );
  return {
    parameters: [...adjacent.parameters, safeLimit],
    text: `${adjacent.text}
      SELECT * FROM adjacent_edges
      ORDER BY ${edgePriorityOrder('adjacent_edges')}
      LIMIT ?`,
  };
}

export function codeGraphDirectEdgeQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  sourceId: string,
  targetId: string,
  allowedProvenances: readonly CodeGraphProvenance[],
): CodeGraphSqlQueryStatement {
  const provenances = [...new Set(allowedProvenances)];
  const placeholders = provenances.map(() => '?').join(', ');
  return {
    parameters: [
      snapshotId,
      sourceId,
      targetId,
      ...provenances,
      baseSnapshotId ?? '',
      sourceId,
      targetId,
      ...provenances,
      snapshotId,
      snapshotId,
    ],
    text: `WITH direct_edges AS (
      SELECT current_edges.*
      FROM edges AS current_edges INDEXED BY edges_endpoints
      WHERE current_edges.snapshot_id = ?
        AND current_edges.source_id = ?
        AND current_edges.target_id = ?
        AND current_edges.provenance IN (${placeholders})
      UNION ALL
      SELECT base_edges.*
      FROM edges AS base_edges INDEXED BY edges_endpoints
      WHERE base_edges.snapshot_id = ?
        AND base_edges.source_id = ?
        AND base_edges.target_id = ?
        AND base_edges.provenance IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM edges AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_edge_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
        )
    )
    SELECT * FROM direct_edges
    ORDER BY ${edgePriorityOrder('direct_edges')}
    LIMIT 1`,
  };
}

export {
  selectBaseSnapshotId,
  effectiveSnapshotParameters,
  effectiveSymbolsCte,
  ReusableFileBlobTarget,
  reusableFileBlobTargets,
  reusableFileBlobJoin,
  ReusableFileBlobRow,
  reusableFileBlobTargetCte,
  reusableFileBlobTargetParameters,
  reusableFileBlobFirstDonorSubquery,
  effectiveEdgesCte,
  legacyLexicalTermBranch,
  selectFileBlobMetadataBatch,
  selectReusableFileBlobMetadataBatch,
  selectReusableFileBlobBatch,
  effectiveGraphCtes,
  effectiveGraphParameters,
  EXACT_SYMBOL_FIELDS,
  SYMBOL_PATH_CLASS_SCORE_MULTIPLIERS,
  DOCUMENTATION_PATH_DIRECTORIES,
  DOCUMENTATION_PATH_EXTENSIONS,
  TEST_PATH_DIRECTORIES,
  DOCUMENTATION_QUERY_TERMS,
  TEST_QUERY_TERMS,
  SIDE_EFFECT_OWNER_KINDS,
  SIDE_EFFECT_OWNER_TERMS,
  TEST_FILE_NAME_PATTERN,
  searchSymbolKindOrder,
  normalizeExactSearchPath,
  edgePriorityOrder,
  effectiveAdjacentEdgesCte,
  selectCachedCommittedFileKeys,
};
