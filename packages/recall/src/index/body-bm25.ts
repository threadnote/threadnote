import {Array as EffectArray, Clock, Effect, String as EffectString} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {stripGeneratedMemoryHygieneSources} from '@threadnote/memory/hygiene/provenance';
import {uriSegment} from '@threadnote/workspace/manifest';
import type {RecallEligibilityPolicy} from '../eligibility.js';
import type {RecallCandidate} from '../rank.js';
import {RECALL_FUSION_WINDOW} from '../rank-fusion.js';
import {recallEligibilityPredicate} from './eligibility.js';
import {readyRecallSelectionPolicy} from './read_policy.js';
import {normalizedRecallRecordedAt, recallProjectPredicate} from './selection.js';
import {
  combineRecallSqlPredicates,
  normalizeRecallUriScopes,
  recallIdentityUriScopePredicate,
  recallUriScopePredicate,
  recallWorkspaceScopePredicate,
  type RecallSqlPredicate,
  type RecallWorkspaceScopeMode,
} from './scope.js';

export interface RecallBodyBm25Options {
  /** Canonical team roots positively authorized by the caller for this account. */
  readonly allowedSharedUriScopes?: readonly string[];
  readonly allowedUriScopes?: readonly string[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly includeInactive: boolean;
  readonly project?: string;
  readonly query: string;
  readonly workspaceScope?: string;
  readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
}

const STAGED_DOCUMENTS = 'recall_stage_body_documents';
const STAGED_POSTINGS = 'recall_stage_body_postings';
const STAGED_TOKENIZER = 'recall_stage_body_tokenizer';
const STAGED_TERMS = 'recall_stage_body_terms';

export function initializeRecallBodyBm25(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS body_bm25_documents (
        document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        valid_from INTEGER,
        valid_to INTEGER,
        document_length INTEGER NOT NULL CHECK (document_length >= 0)
      )
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS body_bm25_postings (
        term TEXT NOT NULL,
        document_id INTEGER NOT NULL REFERENCES body_bm25_documents(document_id) ON DELETE CASCADE,
        term_frequency INTEGER NOT NULL CHECK (term_frequency > 0),
        PRIMARY KEY (term, document_id)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe('CREATE INDEX IF NOT EXISTS body_bm25_postings_document_id ON body_bm25_postings(document_id)');
  });
}

export function initializeRecallBodyBm25Staging(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql.unsafe(`
      CREATE TEMP TABLE ${STAGED_DOCUMENTS} (
        id INTEGER PRIMARY KEY,
        uri TEXT UNIQUE NOT NULL,
        active INTEGER NOT NULL,
        valid_from INTEGER,
        valid_to INTEGER
      )
    `);
    yield* sql.unsafe(`
      CREATE VIRTUAL TABLE temp.${STAGED_TOKENIZER} USING fts5(body, tokenize = 'unicode61', content = '')
    `);
    yield* sql.unsafe(`
      CREATE VIRTUAL TABLE temp.${STAGED_TERMS} USING fts5vocab(${STAGED_TOKENIZER}, 'instance')
    `);
    yield* sql.unsafe(`
      CREATE TEMP TABLE ${STAGED_POSTINGS} (
        document_id INTEGER NOT NULL,
        term TEXT NOT NULL,
        term_frequency INTEGER NOT NULL,
        PRIMARY KEY (document_id, term)
      ) WITHOUT ROWID
    `);
  });
}

export function dropRecallBodyBm25Staging(sql: SqlClient.SqlClient) {
  return Effect.forEach(
    [STAGED_POSTINGS, STAGED_TERMS, STAGED_TOKENIZER, STAGED_DOCUMENTS],
    table => sql.unsafe(`DROP TABLE IF EXISTS temp.${table}`),
    {discard: true},
  );
}

function recallMemoryRoot(user: string): string {
  return `threadnote://user/${uriSegment(user)}/memories`;
}

function validityTimestamp(value: string | undefined): number | null {
  const iso = normalizedRecallRecordedAt(value);
  return iso === null ? null : Date.parse(iso);
}

/** Tokenize precisely the redacted canonical memory body, not its indexed discovery fields. */
export function stageRecallBodyBm25(sql: SqlClient.SqlClient, user: string, candidates: readonly RecallCandidate[]) {
  const memoryPrefix = `${recallMemoryRoot(user)}/`;
  const documents = EffectArray.filter(
    candidates,
    candidate => candidate.kind !== undefined && EffectString.startsWith(memoryPrefix)(candidate.uri),
  );
  if (documents.length === 0) return Effect.void;

  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{readonly id: number; readonly uri: string}>(
      `INSERT INTO temp.${STAGED_DOCUMENTS} (uri, active, valid_from, valid_to)
       VALUES ${EffectArray.join(
         EffectArray.map(documents, () => '(?, ?, ?, ?)'),
         ', ',
       )}
       RETURNING id, uri`,
      EffectArray.flatMap(documents, document => [
        document.uri,
        document.status === undefined || document.status === 'active' ? 1 : 0,
        validityTimestamp(document.validFrom),
        validityTimestamp(document.validTo),
      ]),
    );
    const rowIdByUri = new Map(EffectArray.map(rows, row => [row.uri, row.id] as const));
    yield* sql.unsafe(
      `INSERT INTO temp.${STAGED_TOKENIZER} (rowid, body)
       VALUES ${EffectArray.join(
         EffectArray.map(documents, () => '(?, ?)'),
         ', ',
       )}`,
      EffectArray.flatMap(documents, document => [
        rowIdByUri.get(document.uri)!,
        stripGeneratedMemoryHygieneSources(document.text),
      ]),
    );
  });
}

/** Expand only changed documents and finish tokenization before the main publication transaction. */
export function stageRecallBodyBm25TermFrequencies(sql: SqlClient.SqlClient) {
  return sql.unsafe(`
    INSERT INTO temp.${STAGED_POSTINGS} (document_id, term, term_frequency)
    SELECT doc, term, COUNT(*)
    FROM temp.${STAGED_TERMS}
    GROUP BY doc, term
  `);
}

export function publishRecallBodyBm25(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql.unsafe(`
      INSERT INTO body_bm25_documents (document_id, active, valid_from, valid_to, document_length)
      SELECT d.id, b.active, b.valid_from, b.valid_to, COALESCE((
        SELECT SUM(p.term_frequency)
        FROM temp.${STAGED_POSTINGS} AS p
        WHERE p.document_id = b.id
      ), 0)
      FROM temp.${STAGED_DOCUMENTS} AS b
      CROSS JOIN documents AS d ON d.uri = b.uri
    `);
    yield* sql.unsafe(`
      INSERT INTO body_bm25_postings (term, document_id, term_frequency)
      SELECT p.term, d.id, p.term_frequency
      FROM temp.${STAGED_DOCUMENTS} AS b
      CROSS JOIN documents AS d ON d.uri = b.uri
      CROSS JOIN temp.${STAGED_POSTINGS} AS p ON p.document_id = b.id
    `);
  });
}

function hardUriScope(alias: string, allowed: readonly string[] | undefined): RecallSqlPredicate {
  // Short explicit scopes give SQLite indexed URI ranges. Use the compact
  // predicate for longer lists to stay below SQLite's expression-depth limit.
  return allowed !== undefined && allowed.length <= 16
    ? recallUriScopePredicate(alias, allowed)
    : recallIdentityUriScopePredicate(alias, allowed);
}

function eligibleMemoryUriScope(
  alias: string,
  user: string,
  authorizedRoots: readonly string[] | undefined,
): RecallSqlPredicate {
  const memoryRoot = recallMemoryRoot(user);
  const sharedRoot = `${memoryRoot}/shared`;
  const teamPrefix = `${sharedRoot}/`;
  const teams = EffectArray.filter(normalizeRecallUriScopes(authorizedRoots ?? []), uri => {
    const team = EffectString.slice(teamPrefix.length)(uri);
    return EffectString.startsWith(teamPrefix)(uri) && team.length > 0 && !EffectString.includes('/')(team);
  });
  const personal = {
    params: [`${memoryRoot}/`, `${memoryRoot}0`, teamPrefix, `${sharedRoot}0`],
    restricted: true,
    sql: `${alias}.uri >= ? AND ${alias}.uri < ? AND (${alias}.uri < ? OR ${alias}.uri >= ?)`,
  };
  if (teams.length === 0) return personal;
  const authorized = hardUriScope(alias, teams);
  return {
    params: [...personal.params, ...authorized.params],
    restricted: true,
    sql: `(${personal.sql}) OR (${authorized.sql})`,
  };
}

/**
 * Compute the FTS5 BM25 formula over eligible logical documents only. The FTS5
 * extension supplies both tokenizers. Indexed term rows supply TF, while the
 * authorized scope supplies the document count, mean length, and DF.
 */
export const selectRecallBodyBm25 = Effect.fn('recall.selectBodyBm25')(function* (
  sql: SqlClient.SqlClient,
  user: string,
  options: RecallBodyBm25Options,
) {
  if (options.includeInactive) return undefined;
  // Only successfully indexed documents belong to the body corpus. The
  // lexical snapshot separately records files that exceed its source limit.
  yield* sql.unsafe("CREATE VIRTUAL TABLE temp.recall_body_query USING fts5(body, tokenize = 'unicode61')");
  yield* sql`INSERT INTO temp.recall_body_query (body) VALUES (${options.query})`;
  yield* sql.unsafe("CREATE VIRTUAL TABLE temp.recall_body_query_terms USING fts5vocab(recall_body_query, 'row')");
  const terms = yield* sql<{readonly term: string}>`SELECT term FROM temp.recall_body_query_terms ORDER BY term`;
  yield* sql.unsafe('DROP TABLE temp.recall_body_query_terms');
  yield* sql.unsafe('DROP TABLE temp.recall_body_query');
  if (terms.length === 0) return [];

  const scope = combineRecallSqlPredicates(
    eligibleMemoryUriScope('d', user, options.allowedSharedUriScopes),
    hardUriScope('d', options.allowedUriScopes),
    // The URI fence excludes external rows. Newly indexed preferences already
    // use a null project, so this predicate never reads the candidate JSON.
    recallEligibilityPredicate('d', readyRecallSelectionPolicy(options.eligibility), false),
    recallProjectPredicate('d', options.project),
    recallWorkspaceScopePredicate('d', options.workspaceScope, options.workspaceScopeMode),
  );
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* sql.unsafe<{readonly uri: string}>(
    `WITH eligible AS MATERIALIZED (
       -- SQLite takes bare columns from the row with the minimum URI.
       SELECT d.id, MIN(d.uri COLLATE BINARY) AS uri, b.document_length
       FROM documents AS d
       CROSS JOIN body_bm25_documents AS b ON b.document_id = d.id
       WHERE ${scope.sql}
         AND b.active = 1
         AND (b.valid_from IS NULL OR b.valid_from <= ?)
         AND (b.valid_to IS NULL OR b.valid_to >= ?)
       GROUP BY d.logical_key
     ), corpus AS (
       SELECT COUNT(*) AS n, AVG(document_length) AS avg_length FROM eligible
     ), terms AS MATERIALIZED (
       SELECT value AS term FROM json_each(?)
     ), matches AS MATERIALIZED (
       -- A narrow authorized corpus can probe the primary key directly.
       SELECT e.id, p.term, p.term_frequency AS tf
       FROM corpus
       CROSS JOIN eligible AS e
       CROSS JOIN terms AS q
       CROSS JOIN body_bm25_postings AS p ON p.term = q.term AND p.document_id = e.id
       WHERE corpus.n <= 64
       UNION ALL
       SELECT e.id, p.term, p.term_frequency AS tf
       FROM corpus
       CROSS JOIN terms AS q
       CROSS JOIN body_bm25_postings AS p ON p.term = q.term
       INNER JOIN eligible AS e ON e.id = p.document_id
       WHERE corpus.n > 64
     ), idf AS (
       SELECT m.term,
         CASE WHEN 2 * COUNT(*) >= corpus.n THEN 0.000001
           ELSE ln((corpus.n - COUNT(*) + 0.5) / (COUNT(*) + 0.5))
         END AS weight
       FROM matches AS m
       CROSS JOIN corpus
       GROUP BY m.term
     )
     SELECT e.uri
     FROM matches AS m
     INNER JOIN idf ON idf.term = m.term
     INNER JOIN eligible AS e ON e.id = m.id
     CROSS JOIN corpus
     GROUP BY m.id
     ORDER BY SUM(
       idf.weight * (
         m.tf * 2.2 / (m.tf + 1.2 * (0.25 + 0.75 * e.document_length / corpus.avg_length))
       )
       ORDER BY m.term COLLATE BINARY
     ) DESC, e.uri COLLATE BINARY
     LIMIT ?`,
    [...scope.params, now, now, JSON.stringify(EffectArray.map(terms, row => row.term)), RECALL_FUSION_WINDOW],
  );
  return EffectArray.map(rows, row => row.uri);
});
