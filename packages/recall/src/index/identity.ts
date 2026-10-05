import {Effect} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import type {RecallEligibilityPolicy} from '../eligibility.js';
import {recallEligibilityPredicate} from './eligibility.js';
import type {RecallCandidate} from '../rank.js';
import {combineRecallSqlPredicates, recallUriScopePredicate} from './scope.js';

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
) {
  yield* sql.unsafe('DELETE FROM memory_identity_conflicts');
  yield* sql.unsafe(`
    INSERT INTO memory_identity_conflicts (memory_id)
    SELECT json_extract(candidate_json, '$.memoryId') AS memory_id
    FROM documents
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
export function createRecallIdentityConflictLoader(sql: SqlClient.SqlClient) {
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
      recallUriScopePredicate('d', allowedUriScopes),
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
               FROM memory_identity_conflicts
               WHERE memory_id IN (${memoryIdParameters})
               ORDER BY memory_id`,
              batch,
            )
          : yield* sql.unsafe<RecallIdentityConflictRow>(
              `SELECT json_extract(d.candidate_json, '$.memoryId') AS memory_id
               FROM documents AS d
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
