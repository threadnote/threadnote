import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {boundedRecallPhysicalCandidateLimit} from './query.js';
import {recallEligibilityPolicyRestrictsCandidates, type RecallEligibilityPolicy} from '../eligibility.js';
import {recallEligibilityPredicate} from './eligibility.js';
import {
  POSTING_BM25_LENGTH_NORMALIZATION,
  POSTING_BM25_SATURATION,
  POSTING_IDENTIFIER_WEIGHT,
  postingInverseDocumentFrequency,
} from './lexical.js';
import {
  combineRecallSqlPredicates,
  recallUriScopePredicate,
  recallWorkspaceScopePredicate,
  type RecallSqlPredicate,
  type RecallWorkspaceScopeMode,
} from './scope.js';
import type {RecallCorpusStatistics} from '../rank.js';

export interface RecallDocumentSampleRow {
  readonly candidate_json: string;
  readonly id: number;
  readonly uri: string;
}

export interface RecallPostingSelectionRow {
  readonly document_id: number;
  readonly document_length: number;
  readonly field_weight: number;
  readonly term: string;
  readonly term_frequency: number;
  readonly uri: string;
}

interface RecallRecentDocumentRow extends RecallDocumentSampleRow {
  readonly logical_key: string;
  readonly recorded_at: string;
}

const RECALL_RECENCY_MAX_PAGES_PER_TERM = 4;

export function normalizedRecallRecordedAt(timestamp: string | undefined): string | null {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function selectRecallDocumentRows(
  sql: SqlClient.SqlClient,
  column: 'id' | 'uri',
  values: readonly (number | string)[],
) {
  return Effect.gen(function* () {
    const rows: RecallDocumentSampleRow[] = [];
    for (let index = 0; index < values.length; index += 400) {
      const batch = values.slice(index, index + 400);
      rows.push(
        ...(yield* sql<RecallDocumentSampleRow>`
          SELECT id, uri, candidate_json FROM documents WHERE ${sql.in(column, batch)}
        `),
      );
    }
    return rows;
  });
}

/** Exact indexed lookup for bounded stable memory aliases; URI authorization stays in SQL. */
export function selectRecallDocumentRowsByMemoryIds(
  sql: SqlClient.SqlClient,
  memoryIds: readonly string[],
  allowedUriScopes: readonly string[] | undefined,
  eligibility: RecallEligibilityPolicy | undefined,
) {
  return Effect.gen(function* () {
    const rows: RecallDocumentSampleRow[] = [];
    const scope = combineRecallSqlPredicates(
      recallUriScopePredicate('d', allowedUriScopes),
      recallEligibilityPredicate('d', eligibility),
    );
    for (let index = 0; index < memoryIds.length; index += 400) {
      const batch = memoryIds.slice(index, index + 400);
      const parameters = batch.map(() => '?').join(', ');
      rows.push(
        ...(yield* sql.unsafe<RecallDocumentSampleRow>(
          `SELECT d.id, d.uri, d.candidate_json
           FROM documents AS d
           WHERE ${scope.sql}
             AND json_extract(d.candidate_json, '$.memoryId') IN (${parameters})
           ORDER BY d.uri`,
          [...scope.params, ...batch],
        )),
      );
    }
    return rows;
  });
}

export function selectTopRecallPostingsByTerms(
  sql: SqlClient.SqlClient,
  terms: readonly string[],
  allowedUriScopes: readonly string[] | undefined,
  eligibility: RecallEligibilityPolicy | undefined,
  project: string | undefined,
  workspaceScope: string | undefined,
  workspaceScopeMode: RecallWorkspaceScopeMode | undefined,
  postingPoolLimit: number,
  corpusStatistics: RecallCorpusStatistics,
) {
  if (terms.length === 0) return Effect.succeed<readonly RecallPostingSelectionRow[]>([]);
  const uriScope = recallUriScopePredicate('d', allowedUriScopes);
  const workspace = recallWorkspaceScopePredicate('d', workspaceScope, workspaceScopeMode);
  const scope = combineRecallSqlPredicates(
    uriScope,
    recallEligibilityPredicate('d', eligibility),
    recallProjectPredicate('d', project),
    workspace,
  );
  const queryTermValues = terms.map(() => '(?, ?)').join(', ');
  const queryTermParameters = terms.flatMap(term => [term, postingInverseDocumentFrequency(term, corpusStatistics)]);
  const indexHint = uriScope.restricted
    ? ' INDEXED BY documents_uri'
    : workspace.restricted
      ? ' INDEXED BY documents_workspace_scope_uri'
      : '';
  const postingsFirst = workspaceScopeMode === 'sibling';
  const fromClause =
    scope.restricted && !postingsFirst
      ? `documents AS d${indexHint}
       INNER JOIN postings AS p ON p.document_id = d.id
       INNER JOIN query_terms AS q ON q.term = p.term`
      : `query_terms AS q
       INNER JOIN postings AS p ON p.term = q.term
       INNER JOIN documents AS d ON d.id = p.document_id`;
  return sql.unsafe<RecallPostingSelectionRow>(
    `WITH query_terms(term, inverse_document_frequency) AS (
       VALUES ${queryTermValues}
     ),
     scored AS (
       SELECT
         p.term,
         p.document_id,
         p.field_weight,
         p.term_frequency,
         d.document_length,
         d.uri,
         (
           q.inverse_document_frequency * (
             (CAST(p.term_frequency AS REAL) * ?)
             / (
               CAST(p.term_frequency AS REAL)
               + ? * (
                 ?
                 + ? * (CAST(d.document_length AS REAL) / ?)
               )
             )
           )
           + CAST(p.field_weight AS REAL) / ?
         ) AS score
       FROM ${fromClause}
       WHERE ${scope.sql}
     ),
     ranked AS (
       SELECT
         term,
         document_id,
         field_weight,
         term_frequency,
         document_length,
         uri,
         ROW_NUMBER() OVER (
           PARTITION BY term
           ORDER BY score DESC, field_weight DESC, uri ASC
         ) AS term_rank
       FROM scored
     )
     SELECT term, document_id, field_weight, term_frequency, document_length, uri
     FROM ranked
     WHERE term_rank <= ?
     ORDER BY term ASC, term_rank ASC`,
    [
      ...queryTermParameters,
      POSTING_BM25_SATURATION + 1,
      POSTING_BM25_SATURATION,
      1 - POSTING_BM25_LENGTH_NORMALIZATION,
      POSTING_BM25_LENGTH_NORMALIZATION,
      Math.max(1, corpusStatistics.averageDocumentLength),
      POSTING_IDENTIFIER_WEIGHT,
      ...scope.params,
      postingPoolLimit,
    ],
  );
}

/**
 * Bounded lexical admission lane ordered by canonical memory timestamp. URI,
 * project, authority, and workspace predicates are applied before LIMIT; file
 * mtimes never participate in temporal recall. Each selected term reads at
 * most four `limit`-sized pages, paging only when aliases leave too few
 * distinct logical candidates for the protected reserve.
 */
export function selectRecallRecentTopicalDocuments(
  sql: SqlClient.SqlClient,
  terms: readonly string[],
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly eligibility?: RecallEligibilityPolicy;
    readonly limit: number;
    readonly minimumLogicalCandidates: number;
    readonly project?: string;
    readonly workspaceScope?: string;
    readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
  },
) {
  const limit = Math.max(0, Math.floor(options.limit));
  if (limit === 0 || terms.length === 0) return Effect.succeed<readonly RecallDocumentSampleRow[]>([]);
  const scope = combineRecallSqlPredicates(
    recallUriScopePredicate('d', options.allowedUriScopes),
    recallEligibilityPredicate('d', options.eligibility),
    recallProjectPredicate('d', options.project),
    recallWorkspaceScopePredicate('d', options.workspaceScope, options.workspaceScopeMode),
  );
  const minimumLogicalCandidates = Math.min(limit, Math.max(1, Math.floor(options.minimumLogicalCandidates)));
  return Effect.gen(function* () {
    const selected: RecallRecentDocumentRow[] = [];
    for (const term of terms) {
      const termRows: RecallRecentDocumentRow[] = [];
      const logicalKeys = new Set<string>();
      for (let page = 0; page < RECALL_RECENCY_MAX_PAGES_PER_TERM; page += 1) {
        const rows = yield* sql.unsafe<RecallRecentDocumentRow>(
          `SELECT d.id, d.uri, d.candidate_json, d.logical_key, d.recorded_at
           FROM postings AS p
           CROSS JOIN documents AS d ON d.id = p.document_id
           WHERE p.term = ?
             AND d.recorded_at IS NOT NULL
             AND ${scope.sql}
           ORDER BY d.recorded_at DESC, d.uri ASC
           LIMIT ? OFFSET ?`,
          [term, ...scope.params, limit, page * limit],
        );
        termRows.push(...rows);
        rows.forEach(row => logicalKeys.add(row.logical_key));
        if (rows.length < limit || logicalKeys.size >= minimumLogicalCandidates) break;
      }
      // Keep physical aliases in the bounded pool so the ordinary logical
      // deduplicator can retain authorized equivalent URIs.
      selected.push(...termRows);
    }
    return selected;
  });
}

export function recallProjectMatches(project: string | undefined, candidateProject: string | undefined): boolean {
  const normalizedProject = project?.trim().toLowerCase();
  return !normalizedProject || candidateProject?.trim().toLowerCase() === normalizedProject;
}

export function recallProjectPredicate(alias: string, project: string | undefined): RecallSqlPredicate {
  const normalizedProject = project?.trim().toLowerCase();
  return normalizedProject
    ? {params: [normalizedProject], restricted: true, sql: `${alias}.project = ?`}
    : {params: [], restricted: false, sql: '1 = 1'};
}

export function selectRecallDocumentSample(
  sql: SqlClient.SqlClient,
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly eligibility?: RecallEligibilityPolicy;
    readonly limit?: number;
    readonly project?: string;
    readonly workspaceScope?: string;
    readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
  },
) {
  const normalizedLimit = options.limit === undefined ? undefined : Math.max(0, Math.floor(options.limit));
  if (normalizedLimit === 0) return Effect.succeed<readonly RecallDocumentSampleRow[]>([]);
  const scope = combineRecallSqlPredicates(
    recallUriScopePredicate('d', options.allowedUriScopes),
    recallEligibilityPredicate('d', options.eligibility),
    recallProjectPredicate('d', options.project),
    recallWorkspaceScopePredicate('d', options.workspaceScope, options.workspaceScopeMode),
  );
  const physicalLimit =
    normalizedLimit === undefined ? undefined : boundedRecallPhysicalCandidateLimit(normalizedLimit);
  const bounded = physicalLimit === undefined ? '' : ' LIMIT ?';
  const order = normalizedLimit === undefined ? 'd.uri' : 'd.source_modified_at DESC, d.uri';
  return sql.unsafe<RecallDocumentSampleRow>(
    `SELECT d.id, d.uri, d.candidate_json
     FROM documents AS d
     WHERE ${scope.sql}
     ORDER BY ${order}${bounded}`,
    [...scope.params, ...(physicalLimit === undefined ? [] : [physicalLimit])],
  );
}

/** Cheaply reject an empty project/workspace lane before scoring its query postings. */
export function recallSelectionHasDocuments(
  sql: SqlClient.SqlClient,
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly eligibility?: RecallEligibilityPolicy;
    readonly project?: string;
    readonly workspaceScope?: string;
    readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
  },
) {
  const scope = combineRecallSqlPredicates(
    recallUriScopePredicate('d', options.allowedUriScopes),
    recallEligibilityPredicate('d', options.eligibility),
    recallProjectPredicate('d', options.project),
    recallWorkspaceScopePredicate('d', options.workspaceScope, options.workspaceScopeMode),
  );
  return sql
    .unsafe<{readonly present: number}>(
      `SELECT 1 AS present FROM documents AS d WHERE ${scope.sql} LIMIT 1`,
      scope.params,
    )
    .pipe(Effect.map(rows => rows.length > 0));
}

export function selectRecallQueryTermStatistics(
  sql: SqlClient.SqlClient,
  terms: readonly string[],
  corpusStatistics: RecallCorpusStatistics,
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly eligibility?: RecallEligibilityPolicy;
    readonly project?: string;
    readonly workspaceScope?: string;
    readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
  },
) {
  if (
    (!options.allowedUriScopes || options.allowedUriScopes.length === 0) &&
    !recallEligibilityPolicyRestrictsCandidates(options.eligibility) &&
    options.project === undefined &&
    options.workspaceScope === undefined
  ) {
    return Effect.succeed<RecallCorpusStatistics>(corpusStatistics);
  }
  return Effect.gen(function* () {
    const uriScope = recallUriScopePredicate('d', options.allowedUriScopes);
    const workspace = recallWorkspaceScopePredicate('d', options.workspaceScope, options.workspaceScopeMode);
    const scope = combineRecallSqlPredicates(
      uriScope,
      recallEligibilityPredicate('d', options.eligibility),
      recallProjectPredicate('d', options.project),
      workspace,
    );
    const indexHint = uriScope.restricted
      ? ' INDEXED BY documents_uri'
      : workspace.restricted
        ? ' INDEXED BY documents_workspace_scope_uri'
        : '';
    const aggregateRows = yield* sql.unsafe<{
      readonly document_count: number;
      readonly total_document_length: number;
    }>(
      `SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length
       FROM (
         SELECT d.logical_key, MAX(d.document_length) AS document_length
         FROM documents AS d${indexHint}
         WHERE ${scope.sql}
         GROUP BY d.logical_key
       )`,
      scope.params,
    );
    // A URI range hint prevents rowid lookup from a matching term posting and
    // can rescan the authorized range for each match. Keep authorization in
    // WHERE while allowing that lookup; retain workspace-only access plans.
    const frequencyIndexHint = uriScope.restricted ? '' : indexHint;
    const frequencies: Array<{readonly document_frequency: number; readonly term: string}> = [];
    for (let index = 0; index < terms.length; index += 300) {
      const batch = terms.slice(index, index + 300);
      frequencies.push(
        ...(yield* sql.unsafe<{readonly document_frequency: number; readonly term: string}>(
          `SELECT p.term, COUNT(DISTINCT d.logical_key) AS document_frequency
           FROM documents AS d${frequencyIndexHint}
           INNER JOIN postings AS p ON p.document_id = d.id
           WHERE p.term IN (${batch.map(() => '?').join(', ')})
             AND ${scope.sql}
           GROUP BY p.term`,
          [...batch, ...scope.params],
        )),
      );
    }
    const documentCount = aggregateRows[0]?.document_count ?? 0;
    const totalDocumentLength = aggregateRows[0]?.total_document_length ?? 0;
    return {
      averageDocumentLength: documentCount === 0 ? 1 : totalDocumentLength / documentCount,
      documentCount,
      documentFrequency: Object.fromEntries(frequencies.map(row => [row.term, row.document_frequency])),
      totalDocumentLength,
    } satisfies RecallCorpusStatistics;
  });
}

/** Conservative proof that the topical query returned every possible logical match. */
export function recallQuerySelectionIsExhaustive(input: {
  readonly candidateDecodeLimit: number;
  readonly deduplicatedCandidateCount: number;
  readonly documentFrequency: Readonly<Record<string, number>>;
  readonly indexedQueryTerms: readonly string[];
  readonly postingPoolLimit: number;
  readonly postingTerms: readonly string[];
  readonly queryTerms: readonly string[];
  readonly rankedDocumentCount: number;
  readonly resultLimit: number;
}): boolean {
  const postingCountByTerm = new Map<string, number>();
  for (const term of input.postingTerms) postingCountByTerm.set(term, (postingCountByTerm.get(term) ?? 0) + 1);
  const indexedTermsWithPostings = input.indexedQueryTerms.filter(term => (input.documentFrequency[term] ?? 0) > 0);
  return (
    input.queryTerms.length === indexedTermsWithPostings.length &&
    input.queryTerms.every(term => (postingCountByTerm.get(term) ?? 0) < input.postingPoolLimit) &&
    input.rankedDocumentCount <= input.candidateDecodeLimit &&
    input.deduplicatedCandidateCount <= input.resultLimit
  );
}
