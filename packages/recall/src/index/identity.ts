import {Effect} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import type {RecallEligibilityPolicy} from '../eligibility.js';
import {recallEligibilityPredicate} from './eligibility.js';
import type {RecallCandidate} from '../rank.js';
import {combineRecallSqlPredicates, recallIdentityUriScopePredicate} from './scope.js';

interface RecallIdentityConflictRow {
  readonly memory_id: string;
}

const IDENTITY_QUERY_BATCH_SIZE = 400;

export const initializeRecallIdentityIndex = Effect.fn('recall.initializeIdentityIndex')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory_identity_conflicts (
      memory_id TEXT PRIMARY KEY NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS documents_memory_identity
     ON documents(json_extract(candidate_json, '$.memoryId'), json_extract(candidate_json, '$.contentHash'))`,
  );
});

export function recallIndexMetadataIsCurrent(metadata: ReadonlyMap<string, string>): boolean {
  const contentGeneration = metadata.get('content_generation');
  const mutationSequence = metadata.get('mutation_sequence');
  return (
    contentGeneration !== undefined &&
    metadata.get('memory_identity_conflict_generation') === contentGeneration &&
    mutationSequence !== undefined &&
    mutationSequence === metadata.get('integrity_sequence')
  );
}

export const rebuildRecallIdentityConflicts = Effect.fn('recall.rebuildIdentityConflicts')(function* (
  sql: SqlClient.SqlClient,
  projection: 'lexical' | 'identity' = 'lexical',
) {
  const conflicts = projection === 'identity' ? 'identity_memory_conflicts' : 'memory_identity_conflicts';
  const documents = projection === 'identity' ? 'identity_documents' : 'documents';
  yield* sql.unsafe(`DELETE FROM ${conflicts}`);
  yield* sql.unsafe(`
    INSERT INTO ${conflicts} (memory_id)
    SELECT json_extract(candidate_json, '$.memoryId') AS memory_id
    FROM ${documents}
    WHERE json_type(candidate_json, '$.memoryId') = 'text'
      AND json_type(candidate_json, '$.contentHash') = 'text'
    GROUP BY json_extract(candidate_json, '$.memoryId')
    HAVING COUNT(DISTINCT json_extract(candidate_json, '$.contentHash')) > 1
  `);
});

/**
 * Resolve divergent identities against the full authorized lexical corpus,
 * independently of the bounded posting and candidate windows used by a query.
 */
export function createRecallIdentityConflictLoader(
  sql: SqlClient.SqlClient,
  projection: 'lexical' | 'identity' = 'lexical',
) {
  const cache = new Map<string, ReadonlySet<string>>();
  return Effect.fn('recall.loadIdentityConflicts')(function* (
    allowedUriScopes: readonly string[] | undefined,
    eligibility: RecallEligibilityPolicy | undefined,
    candidateMemoryIds: readonly string[],
  ) {
    const memoryIds = [...new Set(candidateMemoryIds)].sort();
    if (memoryIds.length === 0) return new Set<string>();
    const key = JSON.stringify([allowedUriScopes ?? null, eligibility ?? null, memoryIds]);
    const cached = cache.get(key);
    if (cached) return cached;

    const scope = combineRecallSqlPredicates(
      recallIdentityUriScopePredicate('d', allowedUriScopes),
      recallEligibilityPredicate('d', eligibility),
    );
    const rows: RecallIdentityConflictRow[] = [];
    for (let start = 0; start < memoryIds.length; start += IDENTITY_QUERY_BATCH_SIZE) {
      const batch = memoryIds.slice(start, start + IDENTITY_QUERY_BATCH_SIZE);
      const memoryIdParameters = batch.map(() => '?').join(', ');
      rows.push(
        ...(!scope.restricted
          ? yield* sql.unsafe<RecallIdentityConflictRow>(
              `SELECT memory_id
               FROM ${projection === 'identity' ? 'identity_memory_conflicts' : 'memory_identity_conflicts'}
               WHERE memory_id IN (${memoryIdParameters})
               ORDER BY memory_id`,
              batch,
            )
          : yield* sql.unsafe<RecallIdentityConflictRow>(
              `SELECT json_extract(d.candidate_json, '$.memoryId') AS memory_id
               FROM ${projection === 'identity' ? 'identity_documents' : 'documents'} AS d
               WHERE ${scope.sql}
                 AND json_extract(d.candidate_json, '$.memoryId') IN (${memoryIdParameters})
                 AND json_type(d.candidate_json, '$.memoryId') = 'text'
                 AND json_type(d.candidate_json, '$.contentHash') = 'text'
               GROUP BY json_extract(d.candidate_json, '$.memoryId')
               HAVING COUNT(DISTINCT json_extract(d.candidate_json, '$.contentHash')) > 1`,
              [...scope.params, ...batch],
            )),
      );
    }
    const conflicts = new Set(rows.map(row => row.memory_id));
    cache.set(key, conflicts);
    return conflicts;
  });
}

export function markRecallIdentityConflicts(
  candidates: readonly RecallCandidate[],
  conflictingMemoryIds: ReadonlySet<string>,
): readonly RecallCandidate[] {
  if (conflictingMemoryIds.size === 0) return candidates;
  return candidates.map(candidate =>
    candidate.memoryId && conflictingMemoryIds.has(candidate.memoryId)
      ? {...candidate, identityConflict: true}
      : candidate,
  );
}

export function identityProjectionMetadataIsCurrent(metadata: ReadonlyMap<string, string>): boolean {
  const generation = metadata.get('identity_content_generation');
  const sequence = metadata.get('identity_mutation_sequence');
  return (
    generation !== undefined &&
    metadata.get('identity_conflict_generation') === generation &&
    sequence !== undefined &&
    sequence === metadata.get('identity_integrity_sequence')
  );
}

const LEXICAL_PUBLICATION_METADATA = [
  'initialized',
  'canonical_mutation_generation',
  'content_generation',
  'memory_identity_conflict_generation',
  'integrity_sequence',
  'document_count',
  'include_inactive',
  'logical_document_count',
  'total_document_length',
  'logical_total_document_length',
  'oversized_document_count',
  'stale_generation',
  'validated_at',
  'source_validation_required',
] as const;

/** Supported-schema caller only: identity publication can leave a completely untouched lexical baseline. */
export const recallLexicalProjectionIsUntouched = Effect.fn('recall.lexicalProjectionIsUntouched')(function* (
  sql: SqlClient.SqlClient,
  metadata: ReadonlyMap<string, string>,
) {
  if (
    metadata.get('identity_initialized') !== 'true' ||
    !identityProjectionMetadataIsCurrent(metadata) ||
    !metadata.get('identity_content_generation') ||
    metadata.get('mutation_sequence') !== '0' ||
    LEXICAL_PUBLICATION_METADATA.some(key => metadata.has(key))
  )
    return false;
  // Read the logical FTS relation, whose shadow/config tables contain normal bootstrap rows.
  // Naming required columns also refuses missing or incompatible relations without repairing them.
  const rows = yield* sql.unsafe<{readonly has_rows: number}>(`SELECT
    EXISTS (SELECT id, uri, project, approved_authoritative, workspace_scope, source_path,
      source_modified_at, recorded_at, source_size, authority_policy_key, candidate_json,
      logical_key, document_length, memory_links_truncated FROM documents)
    OR EXISTS (SELECT term, document_id, field_weight, term_frequency FROM postings)
    OR EXISTS (SELECT rowid, content FROM exact_search)
    OR EXISTS (SELECT term, document_frequency FROM term_statistics)
    OR EXISTS (SELECT document_id, document_uri, citation_ordinal, selector_kind, selector_digest FROM code_links)
    OR EXISTS (SELECT source_document_id, source_uri, source_memory_id, target_memory_id,
      target_locator_digest, relation_type, relation_origin, relation_ordinal FROM memory_links)
    OR EXISTS (SELECT memory_id FROM memory_identity_conflicts)
    AS has_rows`);
  return rows[0]?.has_rows === 0;
});
