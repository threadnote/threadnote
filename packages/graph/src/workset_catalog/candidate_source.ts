import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {
  CodeGraphWorksetCatalogCandidateLaneV1,
  CodeGraphWorksetCatalogCandidatePageV1,
  CodeGraphWorksetCatalogCandidateRequestV1,
  CodeGraphWorksetCatalogCandidateSourceV1,
} from '../workset/router.js';
import {codeGraphWorksetCatalogLayout} from './layout.js';
import {normalizeCodeGraphWorksetRoutingExactKey} from './routing_normalization.js';
import {configureCodeGraphWorksetCatalogReadConnection} from './schema.js';
import {readPublishedCodeGraphWorksetCatalogGeneration} from './store.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogRoutingSymbolRecordV1,
  type CodeGraphWorksetRoutingTermV1,
} from './types.js';

const SOURCE_CURSOR_PREFIX = 'cgwsc_';
const SOURCE_CURSOR_VERSION = 1;
const CANDIDATE_LIMIT_MAXIMUM = 512;
const QUERY_BYTES_MAXIMUM = 4_096;
const QUERY_TERM_BYTES_MAXIMUM = 256;
const QUERY_TERMS_MAXIMUM = 32;
const SOURCE_CURSOR_BYTES_MAXIMUM = 2_048;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const GENERATION_ID = /^cgwg_[0-9a-f]{40}$/u;
const NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;

interface CandidateRow {
  readonly catalog_rank: unknown;
  readonly exported: unknown;
  readonly kind: unknown;
  readonly language: unknown;
  readonly name: unknown;
  readonly node_id: unknown;
  readonly ordinal: unknown;
  readonly package_name: unknown;
  readonly path: unknown;
  readonly projection_digest: unknown;
  readonly qualified_name: unknown;
  readonly repository_id: unknown;
  readonly repository_key: unknown;
  readonly snapshot_id: unknown;
  readonly span_column: unknown;
  readonly span_end_column: unknown;
  readonly span_end_line: unknown;
  readonly span_line: unknown;
}

interface ExactCandidateRow extends CandidateRow {
  readonly lane_priority: unknown;
}

interface LexicalCandidateRow extends CandidateRow {
  readonly matched_term_count: unknown;
  readonly matched_term_weight: unknown;
}

interface CoverageRow {
  readonly actual_member_count: unknown;
  readonly generation_id: unknown;
  readonly member_count: unknown;
  readonly ready_member_count: unknown;
}

interface LookupRow {
  readonly lookup_key: unknown;
  readonly node_id: unknown;
  readonly ordinal: unknown;
}

interface TermRow {
  readonly node_id: unknown;
  readonly ordinal: unknown;
  readonly term: unknown;
  readonly weight: unknown;
}

interface ExactCursor {
  readonly catalogRank: number;
  readonly exported: number;
  readonly generationId: string;
  readonly lane: 'exact';
  readonly maximumHitsPerMember: number;
  readonly nodeId: string;
  readonly ordinal: number;
  readonly priority: number;
  readonly queryDigest: string;
  readonly worksetName: string;
}

interface LexicalCursor {
  readonly catalogRank: number;
  readonly exported: number;
  readonly generationId: string;
  readonly lane: 'lexical';
  readonly matchedTermCount: number;
  readonly matchedTermWeight: number;
  readonly maximumHitsPerMember: number;
  readonly nodeId: string;
  readonly ordinal: number;
  readonly queryDigest: string;
  readonly worksetName: string;
}

type CandidateCursor = ExactCursor | LexicalCursor;

/**
 * Capture the filesystem services once and expose the service-free candidate
 * boundary expected by the router.
 */
export const makeCodeGraphWorksetCatalogCandidateSource = Effect.fn('codeGraphWorksetCatalog.makeCandidateSource')(
  function* (threadnoteHome: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const databasePath = codeGraphWorksetCatalogLayout(path, threadnoteHome).databasePath;
    const readGeneration = (worksetName: string) =>
      readPublishedCodeGraphWorksetCatalogGeneration(threadnoteHome, worksetName).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    return {
      mode: 'catalog-index',
      readExactCandidates: request => readCandidatePage(fs, databasePath, request, 'exact'),
      readGeneration,
      readLexicalCandidates: request => readCandidatePage(fs, databasePath, request, 'lexical'),
    } satisfies CodeGraphWorksetCatalogCandidateSourceV1;
  },
);

function readCandidatePage(
  fs: FileSystem.FileSystem,
  databasePath: string,
  request: CodeGraphWorksetCatalogCandidateRequestV1,
  lane: CodeGraphWorksetCatalogCandidateLaneV1,
) {
  return Effect.gen(function* () {
    const normalized = yield* validateRequest(request, lane);
    if (!(yield* fs.exists(databasePath))) {
      return yield* CodeGraphWorksetCatalogError.of('missing', 'The workset catalog does not exist.');
    }
    const read = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* configureCodeGraphWorksetCatalogReadConnection(sql);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const memberCount = yield* readCompleteCoverage(sql, normalized);
          const coverage = {
            consideredMemberCount: memberCount,
            eligibleMemberCount: memberCount,
            state: 'complete' as const,
          };
          if (lane === 'lexical' && normalized.query.terms.length === 0) {
            return {coverage, generationId: normalized.generationId, hits: [], lane};
          }
          const {cursor, ...requestWithoutCursor} = normalized;
          const rows =
            lane === 'exact'
              ? yield* selectExactCandidates(
                  sql,
                  cursor === undefined
                    ? requestWithoutCursor
                    : cursor.lane === 'exact'
                      ? {...requestWithoutCursor, cursor}
                      : (() => {
                          throw corrupt('Exact candidate request cursor is invalid.');
                        })(),
                )
              : yield* selectLexicalCandidates(
                  sql,
                  cursor === undefined
                    ? requestWithoutCursor
                    : cursor.lane === 'lexical'
                      ? {...requestWithoutCursor, cursor}
                      : (() => {
                          throw corrupt('Lexical candidate request cursor is invalid.');
                        })(),
                );
          const visible = rows.slice(0, normalized.limit);
          const surfaces = yield* loadCandidateSurfaces(sql, visible);
          const hits = yield* decodeHits(visible, surfaces);
          const last = visible.at(-1);
          return {
            coverage,
            generationId: normalized.generationId,
            hits,
            lane,
            ...(rows.length > normalized.limit && last !== undefined
              ? {next: encodeCursor(normalized, lane, last)}
              : {}),
          } satisfies CodeGraphWorksetCatalogCandidatePageV1;
        }),
      );
    });
    return yield* Effect.scoped(
      Layer.build(
        SqliteClient.layer({
          create: false,
          disableWAL: true,
          filename: databasePath,
          readonly: true,
          readwrite: false,
        }),
      ).pipe(Effect.flatMap(context => read.pipe(Effect.provide(context)))),
    );
  }).pipe(mapCandidateError(`read ${lane} workset candidates`));
}

function readCompleteCoverage(sql: SqlClient.SqlClient, request: CodeGraphWorksetCatalogCandidateRequestV1) {
  return sql
    .unsafe<CoverageRow>(
      `SELECT g.id AS generation_id, g.member_count,
              COUNT(m.ordinal) AS actual_member_count,
              COALESCE(SUM(CASE WHEN p.state = 'ready' THEN 1 ELSE 0 END), 0) AS ready_member_count
       FROM published_worksets AS published
       JOIN workset_generations AS g ON g.id = published.generation_id
       LEFT JOIN workset_generation_members AS m ON m.generation_id = g.id
       LEFT JOIN repository_snapshots AS p ON p.projection_digest = m.projection_digest
       WHERE published.workset_name = ? AND g.state = 'ready'
       GROUP BY g.id, g.member_count
       LIMIT 1`,
      [request.worksetName],
    )
    .pipe(
      Effect.flatMap(rows =>
        validateStored(() => {
          if (rows.length === 0) {
            throw CodeGraphWorksetCatalogError.of('missing', 'No published workset generation exists.');
          }
          const generationId = requiredText(rows[0].generation_id, 'generation identity');
          if (generationId !== request.generationId) {
            throw CodeGraphWorksetCatalogError.of('stale', 'The published workset generation changed.');
          }
          const declared = requiredInteger(rows[0].member_count, 'generation member count');
          const actual = requiredInteger(rows[0].actual_member_count, 'actual generation member count');
          const ready = requiredInteger(rows[0].ready_member_count, 'ready generation member count');
          if (
            declared > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration ||
            actual !== declared ||
            ready !== declared
          ) {
            throw corrupt('Published workset generation coverage is incomplete.');
          }
          return declared;
        }),
      ),
    );
}

function selectExactCandidates(
  sql: SqlClient.SqlClient,
  request: CodeGraphWorksetCatalogCandidateRequestV1 & {readonly cursor?: ExactCursor},
) {
  const cursor = request.cursor;
  const after =
    cursor === undefined
      ? ''
      : `WHERE lane_priority > ?
           OR (lane_priority = ? AND exported < ?)
           OR (lane_priority = ? AND exported = ? AND ordinal > ?)
           OR (lane_priority = ? AND exported = ? AND ordinal = ? AND node_id > ?)`;
  const afterParameters =
    cursor === undefined
      ? []
      : [
          cursor.priority,
          cursor.priority,
          cursor.exported,
          cursor.priority,
          cursor.exported,
          cursor.ordinal,
          cursor.priority,
          cursor.exported,
          cursor.ordinal,
          cursor.nodeId,
        ];
  return sql.unsafe<ExactCandidateRow>(
    `WITH matching AS (
       SELECT m.ordinal, keys.projection_digest, keys.node_id, symbols.exported,
              CASE keys.key_kind
                WHEN 'lookup-key' THEN 0
                WHEN 'qualified-name' THEN 1
                WHEN 'name' THEN 2
                WHEN 'path' THEN 3
                WHEN 'package' THEN 4
                WHEN 'path-suffix' THEN 5
                ELSE 6
              END AS lane_priority
       FROM routing_exact_keys AS keys INDEXED BY routing_exact_keys_exact
       JOIN workset_generation_members AS m
         ON m.projection_digest = keys.projection_digest AND m.generation_id = ?
       JOIN routing_symbols AS symbols
         ON symbols.projection_digest = keys.projection_digest AND symbols.node_id = keys.node_id
       WHERE keys.exact_key = ?
     ), deduplicated AS (
       SELECT ordinal, projection_digest, node_id, MAX(exported) AS exported,
              MIN(lane_priority) AS lane_priority
       FROM matching
       GROUP BY ordinal, projection_digest, node_id
     ), member_ranked AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY ordinal
         ORDER BY lane_priority, exported DESC, node_id
       ) AS member_rank
       FROM deduplicated
     ), fair AS (
       SELECT ordinal, projection_digest, node_id, exported, lane_priority
       FROM member_ranked
       WHERE member_rank <= ?
     ), ranked AS (
       SELECT *, ROW_NUMBER() OVER (
         ORDER BY lane_priority, exported DESC, ordinal, node_id
       ) AS catalog_rank
       FROM fair
     ), selected AS (
       SELECT * FROM ranked
       ${after}
       ORDER BY lane_priority, exported DESC, ordinal, node_id
       LIMIT ?
     )
     SELECT selected.catalog_rank, selected.lane_priority, selected.ordinal,
            members.repository_key, members.repository_id, members.snapshot_id,
            selected.projection_digest, symbols.node_id, symbols.kind, symbols.language,
            symbols.exported, symbols.package_name, symbols.path, symbols.name,
            symbols.qualified_name, symbols.span_line, symbols.span_column,
            symbols.span_end_line, symbols.span_end_column
     FROM selected
     JOIN workset_generation_members AS members
       ON members.generation_id = ? AND members.ordinal = selected.ordinal
     JOIN routing_symbols AS symbols
       ON symbols.projection_digest = selected.projection_digest AND symbols.node_id = selected.node_id
     ORDER BY selected.lane_priority, selected.exported DESC, selected.ordinal, selected.node_id`,
    [
      request.generationId,
      request.query.canonical,
      request.maximumHitsPerMember,
      ...afterParameters,
      request.limit + 1,
      request.generationId,
    ],
  );
}

function selectLexicalCandidates(
  sql: SqlClient.SqlClient,
  request: CodeGraphWorksetCatalogCandidateRequestV1 & {readonly cursor?: LexicalCursor},
) {
  const cursor = request.cursor;
  const termPlaceholders = request.query.terms.map(() => '?').join(', ');
  const after =
    cursor === undefined
      ? ''
      : `WHERE matched_term_count < ?
           OR (matched_term_count = ? AND matched_term_weight < ?)
           OR (matched_term_count = ? AND matched_term_weight = ? AND exported < ?)
           OR (matched_term_count = ? AND matched_term_weight = ? AND exported = ? AND ordinal > ?)
           OR (matched_term_count = ? AND matched_term_weight = ? AND exported = ? AND ordinal = ? AND node_id > ?)`;
  const afterParameters =
    cursor === undefined
      ? []
      : [
          cursor.matchedTermCount,
          cursor.matchedTermCount,
          cursor.matchedTermWeight,
          cursor.matchedTermCount,
          cursor.matchedTermWeight,
          cursor.exported,
          cursor.matchedTermCount,
          cursor.matchedTermWeight,
          cursor.exported,
          cursor.ordinal,
          cursor.matchedTermCount,
          cursor.matchedTermWeight,
          cursor.exported,
          cursor.ordinal,
          cursor.nodeId,
        ];
  return sql.unsafe<LexicalCandidateRow>(
    `WITH matching AS (
       SELECT m.ordinal, terms.projection_digest, terms.node_id, MAX(symbols.exported) AS exported,
              COUNT(*) AS matched_term_count, SUM(terms.weight) AS matched_term_weight
       FROM routing_terms AS terms INDEXED BY routing_terms_term
       JOIN workset_generation_members AS m
         ON m.projection_digest = terms.projection_digest AND m.generation_id = ?
       JOIN routing_symbols AS symbols
         ON symbols.projection_digest = terms.projection_digest AND symbols.node_id = terms.node_id
       WHERE terms.term IN (${termPlaceholders})
       GROUP BY m.ordinal, terms.projection_digest, terms.node_id
     ), member_ranked AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY ordinal
         ORDER BY matched_term_count DESC, matched_term_weight DESC, exported DESC, node_id
       ) AS member_rank
       FROM matching
     ), fair AS (
       SELECT ordinal, projection_digest, node_id, exported, matched_term_count, matched_term_weight
       FROM member_ranked
       WHERE member_rank <= ?
     ), ranked AS (
       SELECT *, ROW_NUMBER() OVER (
         ORDER BY matched_term_count DESC, matched_term_weight DESC, exported DESC, ordinal, node_id
       ) AS catalog_rank
       FROM fair
     ), selected AS (
       SELECT * FROM ranked
       ${after}
       ORDER BY matched_term_count DESC, matched_term_weight DESC, exported DESC, ordinal, node_id
       LIMIT ?
     )
     SELECT selected.catalog_rank, selected.matched_term_count, selected.matched_term_weight,
            selected.ordinal, members.repository_key, members.repository_id, members.snapshot_id,
            selected.projection_digest, symbols.node_id, symbols.kind, symbols.language,
            symbols.exported, symbols.package_name, symbols.path, symbols.name,
            symbols.qualified_name, symbols.span_line, symbols.span_column,
            symbols.span_end_line, symbols.span_end_column
     FROM selected
     JOIN workset_generation_members AS members
       ON members.generation_id = ? AND members.ordinal = selected.ordinal
     JOIN routing_symbols AS symbols
       ON symbols.projection_digest = selected.projection_digest AND symbols.node_id = selected.node_id
     ORDER BY selected.matched_term_count DESC, selected.matched_term_weight DESC,
              selected.exported DESC, selected.ordinal, selected.node_id`,
    [
      request.generationId,
      ...request.query.terms,
      request.maximumHitsPerMember,
      ...afterParameters,
      request.limit + 1,
      request.generationId,
    ],
  );
}

function loadCandidateSurfaces(sql: SqlClient.SqlClient, rows: readonly CandidateRow[]) {
  if (rows.length === 0) {
    return Effect.succeed({
      lookupKeys: new Map<string, string[]>(),
      terms: new Map<string, CodeGraphWorksetRoutingTermV1[]>(),
    });
  }
  const values = rows.map(() => '(?, ?, ?)').join(', ');
  const parameters = rows.flatMap(row => [row.ordinal, row.projection_digest, row.node_id]);
  return Effect.gen(function* () {
    const lookupRows = yield* sql.unsafe<LookupRow>(
      `WITH selected(ordinal, projection_digest, node_id) AS (VALUES ${values})
       SELECT selected.ordinal, selected.node_id, keys.lookup_key
       FROM selected
       JOIN routing_lookup_keys AS keys
         ON keys.projection_digest = selected.projection_digest AND keys.node_id = selected.node_id
       ORDER BY selected.ordinal, selected.node_id, keys.lookup_key
       LIMIT ?`,
      [...parameters, rows.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol + 1],
    );
    const termRows = yield* sql.unsafe<TermRow>(
      `WITH selected(ordinal, projection_digest, node_id) AS (VALUES ${values})
       SELECT selected.ordinal, selected.node_id, terms.term, terms.weight
       FROM selected
       JOIN routing_terms AS terms
         ON terms.projection_digest = selected.projection_digest AND terms.node_id = selected.node_id
       ORDER BY selected.ordinal, selected.node_id, terms.term
       LIMIT ?`,
      [...parameters, rows.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol + 1],
    );
    return yield* validateStored(() => {
      if (lookupRows.length > rows.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol) {
        throw corrupt('Candidate lookup-key surface exceeds its bound.');
      }
      if (termRows.length > rows.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol) {
        throw corrupt('Candidate lexical surface exceeds its bound.');
      }
      const lookupKeys = new Map<string, string[]>();
      for (const row of lookupRows) {
        const key = rowKey(requiredInteger(row.ordinal, 'lookup ordinal'), requiredText(row.node_id, 'lookup node'));
        const entries = lookupKeys.get(key) ?? [];
        entries.push(requiredText(row.lookup_key, 'lookup key'));
        lookupKeys.set(key, entries);
      }
      const terms = new Map<string, CodeGraphWorksetRoutingTermV1[]>();
      for (const row of termRows) {
        const key = rowKey(requiredInteger(row.ordinal, 'term ordinal'), requiredText(row.node_id, 'term node'));
        const entries = terms.get(key) ?? [];
        const weight = requiredNumber(row.weight, 'term weight');
        if (weight <= 0 || weight > 1_000) throw corrupt('Candidate term weight is invalid.');
        entries.push({term: requiredText(row.term, 'term'), weight});
        terms.set(key, entries);
      }
      return {lookupKeys, terms};
    });
  });
}

function decodeHits(
  rows: readonly CandidateRow[],
  surfaces: {
    readonly lookupKeys: ReadonlyMap<string, readonly string[]>;
    readonly terms: ReadonlyMap<string, readonly CodeGraphWorksetRoutingTermV1[]>;
  },
) {
  return validateStored(() =>
    rows.map(row => {
      const ordinal = requiredInteger(row.ordinal, 'candidate ordinal');
      const nodeId = requiredText(row.node_id, 'candidate node identity');
      if (!NODE_ID.test(nodeId)) throw corrupt('Candidate node identity is invalid.');
      const projectionDigest = requiredDigest(row.projection_digest, 'candidate projection digest');
      const repositoryId = requiredDigest(row.repository_id, 'candidate repository identity');
      const exported = requiredInteger(row.exported, 'candidate exported flag');
      if (exported !== 0 && exported !== 1) throw corrupt('Candidate exported flag is invalid.');
      const line = requiredInteger(row.span_line, 'candidate span line');
      const endLine = requiredInteger(row.span_end_line, 'candidate span end line');
      if (endLine < line) throw corrupt('Candidate span is invalid.');
      const key = rowKey(ordinal, nodeId);
      const symbol: CodeGraphWorksetCatalogRoutingSymbolRecordV1 = {
        exported: exported === 1,
        kind: requiredText(row.kind, 'candidate kind'),
        language: requiredText(row.language, 'candidate language'),
        lookupKeys: surfaces.lookupKeys.get(key) ?? [],
        name: requiredText(row.name, 'candidate name'),
        nodeId,
        ordinal,
        ...(row.package_name === null ? {} : {packageName: requiredText(row.package_name, 'candidate package name')}),
        path: requiredText(row.path, 'candidate path'),
        projectionDigest,
        qualifiedName: requiredText(row.qualified_name, 'candidate qualified name'),
        repositoryId,
        repositoryKey: requiredText(row.repository_key, 'candidate repository key'),
        snapshotId: requiredText(row.snapshot_id, 'candidate snapshot identity'),
        span: {
          column: requiredInteger(row.span_column, 'candidate span column'),
          endColumn: requiredInteger(row.span_end_column, 'candidate span end column'),
          endLine,
          line,
        },
        terms: surfaces.terms.get(key) ?? [],
      };
      return {catalogRank: positiveInteger(row.catalog_rank, 'candidate catalog rank'), symbol};
    }),
  );
}

function validateRequest(
  request: CodeGraphWorksetCatalogCandidateRequestV1,
  lane: CodeGraphWorksetCatalogCandidateLaneV1,
) {
  return Effect.try({
    try: () => {
      assertText(request.worksetName, 'workset name', 256);
      if (!GENERATION_ID.test(request.generationId)) throw invalid('Candidate generation identity is invalid.');
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > CANDIDATE_LIMIT_MAXIMUM) {
        throw invalid('Candidate limit is invalid.');
      }
      if (
        !Number.isSafeInteger(request.maximumHitsPerMember) ||
        request.maximumHitsPerMember < 1 ||
        request.maximumHitsPerMember > request.limit
      ) {
        throw invalid('Candidate per-member bound is invalid.');
      }
      assertText(request.query.canonical, 'canonical query', QUERY_BYTES_MAXIMUM);
      if (normalizeCodeGraphWorksetRoutingExactKey(request.query.canonical) !== request.query.canonical) {
        throw invalid('Candidate canonical query is not normalized.');
      }
      if (!SHA256_HEX.test(request.query.digest)) throw invalid('Candidate query digest is invalid.');
      if (request.query.terms.length > QUERY_TERMS_MAXIMUM) throw invalid('Candidate query has too many terms.');
      const terms = [...new Set(request.query.terms)];
      for (const term of terms) assertText(term, 'query term', QUERY_TERM_BYTES_MAXIMUM);
      const expectedDigest = sha256HexSync(
        JSON.stringify(['threadnote-workset-router-query-v1', request.query.canonical, [...terms].sort(compareText)]),
      );
      if (expectedDigest !== request.query.digest) throw invalid('Candidate query digest does not match its terms.');
      const cursor = request.after === undefined ? undefined : decodeCursor(request.after, request, lane);
      return {...request, cursor, query: {...request.query, terms}};
    },
    catch: cause =>
      Schema.is(CodeGraphWorksetCatalogError)(cause)
        ? cause
        : CodeGraphWorksetCatalogError.of('invalid-input', 'Candidate request is invalid.', {cause}),
  });
}

function encodeCursor(
  request: CodeGraphWorksetCatalogCandidateRequestV1,
  lane: CodeGraphWorksetCatalogCandidateLaneV1,
  row: CandidateRow,
): string {
  const common = [
    SOURCE_CURSOR_VERSION,
    lane,
    request.worksetName,
    request.generationId,
    request.query.digest,
    request.maximumHitsPerMember,
    positiveInteger(row.catalog_rank, 'candidate catalog rank'),
  ];
  const payload =
    lane === 'exact'
      ? [
          ...common,
          requiredInteger(exactCandidateRow(row).lane_priority, 'exact lane priority'),
          requiredInteger(row.exported, 'candidate exported flag'),
          requiredInteger(row.ordinal, 'candidate ordinal'),
          requiredText(row.node_id, 'candidate node identity'),
        ]
      : [
          ...common,
          positiveInteger(lexicalCandidateRow(row).matched_term_count, 'matched term count'),
          requiredNumber(lexicalCandidateRow(row).matched_term_weight, 'matched term weight'),
          requiredInteger(row.exported, 'candidate exported flag'),
          requiredInteger(row.ordinal, 'candidate ordinal'),
          requiredText(row.node_id, 'candidate node identity'),
        ];
  const cursor = `${SOURCE_CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  if (Buffer.byteLength(cursor, 'utf8') > SOURCE_CURSOR_BYTES_MAXIMUM) {
    throw corrupt('Candidate cursor exceeds its bound.');
  }
  return cursor;
}

function decodeCursor(
  cursor: string,
  request: CodeGraphWorksetCatalogCandidateRequestV1,
  lane: CodeGraphWorksetCatalogCandidateLaneV1,
): CandidateCursor {
  assertText(cursor, 'candidate cursor', SOURCE_CURSOR_BYTES_MAXIMUM);
  if (!cursor.startsWith(SOURCE_CURSOR_PREFIX)) throw invalid('Candidate cursor is invalid.');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor.slice(SOURCE_CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  } catch (cause) {
    throw invalid('Candidate cursor is invalid.', cause);
  }
  const expectedLength = lane === 'exact' ? 11 : 12;
  if (!Array.isArray(value) || value.length !== expectedLength || value[0] !== SOURCE_CURSOR_VERSION) {
    throw invalid('Candidate cursor version is incompatible.');
  }
  if (
    value[1] !== lane ||
    value[2] !== request.worksetName ||
    value[3] !== request.generationId ||
    value[4] !== request.query.digest ||
    value[5] !== request.maximumHitsPerMember
  ) {
    throw CodeGraphWorksetCatalogError.of('stale', 'Candidate cursor does not belong to this request.');
  }
  const common = {
    catalogRank: positiveInteger(value[6], 'cursor catalog rank'),
    generationId: request.generationId,
    maximumHitsPerMember: request.maximumHitsPerMember,
    queryDigest: request.query.digest,
    worksetName: request.worksetName,
  };
  if (lane === 'exact') {
    const nodeId = requiredText(value[10], 'cursor node identity');
    if (!NODE_ID.test(nodeId)) throw invalid('Candidate cursor node identity is invalid.');
    return {
      ...common,
      exported: binaryInteger(value[8], 'cursor exported flag'),
      lane,
      nodeId,
      ordinal: requiredInteger(value[9], 'cursor ordinal'),
      priority: requiredInteger(value[7], 'cursor lane priority'),
    };
  }
  const nodeId = requiredText(value[11], 'cursor node identity');
  if (!NODE_ID.test(nodeId)) throw invalid('Candidate cursor node identity is invalid.');
  return {
    ...common,
    exported: binaryInteger(value[9], 'cursor exported flag'),
    lane,
    matchedTermCount: positiveInteger(value[7], 'cursor matched term count'),
    matchedTermWeight: positiveNumber(value[8], 'cursor matched term weight'),
    nodeId,
    ordinal: requiredInteger(value[10], 'cursor ordinal'),
  };
}

function rowKey(ordinal: number, nodeId: string): string {
  return `${String(ordinal)}\0${nodeId}`;
}

function exactCandidateRow(row: CandidateRow): ExactCandidateRow {
  if (!('lane_priority' in row)) throw corrupt('Exact candidate row is invalid.');
  return row;
}

function lexicalCandidateRow(row: CandidateRow): LexicalCandidateRow {
  if (!('matched_term_count' in row) || !('matched_term_weight' in row)) {
    throw corrupt('Lexical candidate row is invalid.');
  }
  return row;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertText(value: unknown, label: string, maximumBytes: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    containsControlCharacter(value)
  ) {
    throw invalid(`Candidate ${label} is invalid.`);
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw corrupt(`Catalog ${label} is invalid.`);
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredText(value, label);
  if (!SHA256_HEX.test(digest)) throw corrupt(`Catalog ${label} is invalid.`);
  return digest;
}

function requiredInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw corrupt(`Catalog ${label} is invalid.`);
  }
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = requiredInteger(value, label);
  if (parsed < 1) throw corrupt(`Catalog ${label} is invalid.`);
  return parsed;
}

function binaryInteger(value: unknown, label: string): number {
  const parsed = requiredInteger(value, label);
  if (parsed !== 0 && parsed !== 1) throw corrupt(`Catalog ${label} is invalid.`);
  return parsed;
}

function requiredNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw corrupt(`Catalog ${label} is invalid.`);
  return parsed;
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = requiredNumber(value, label);
  if (parsed <= 0) throw corrupt(`Catalog ${label} is invalid.`);
  return parsed;
}

function validateStored<A>(evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      Schema.is(CodeGraphWorksetCatalogError)(cause)
        ? cause
        : CodeGraphWorksetCatalogError.of('corrupt', 'Candidate catalog data is invalid.', {cause}),
  });
}

function invalid(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('invalid-input', message, cause === undefined ? undefined : {cause});
}

function corrupt(message: string): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('corrupt', message);
}

function mapCandidateError(operation: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(cause => {
        if (Schema.is(CodeGraphWorksetCatalogError)(cause)) return cause;
        const detail = String(cause).toLowerCase();
        const reason = detail.includes('locked') || detail.includes('busy') ? 'busy' : 'storage';
        return CodeGraphWorksetCatalogError.of(
          reason,
          reason === 'busy' ? `Timed out waiting to ${operation}.` : `Unable to ${operation}.`,
          {cause},
        );
      }),
    );
}
