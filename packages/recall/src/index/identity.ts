import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import type {RecallEligibilityPolicy} from '../eligibility.js';
import {recallEligibilityPredicate} from './eligibility.js';
import type {RecallCandidate} from '../rank.js';
import {combineRecallSqlPredicates, recallIdentityUriScopePredicate} from './scope.js';

interface RecallIdentityConflictRow {
  readonly memory_id: string;
}

const IDENTITY_QUERY_BATCH_SIZE = 400;
export const RECALL_IDENTITY_COLUMN_SCHEMA_VERSION = '2';

export const initializeRecallIdentityIndex = Effect.fn('recall.initializeIdentityIndex')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory_identity_conflicts (
      memory_id TEXT PRIMARY KEY NOT NULL
    ) WITHOUT ROWID
  `);
  const metadataTables = yield* sql.unsafe<{readonly present: number}>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'metadata' LIMIT 1",
  );
  const hasMetadata = metadataTables.length > 0;
  const inspectState = Effect.gen(function* () {
    const columns = yield* sql.unsafe<{readonly name: string}>("PRAGMA table_info('documents')");
    const hasMemoryId = EffectArray.some(columns, column => column.name === 'memory_id');
    const hasContentHash = EffectArray.some(columns, column => column.name === 'content_hash');
    const hasLogicalKeyAndLength =
      EffectArray.some(columns, column => column.name === 'logical_key') &&
      EffectArray.some(columns, column => column.name === 'document_length');
    const metadataRows = hasMetadata
      ? yield* sql.unsafe<{readonly key: string; readonly value: string}>(
          "SELECT key, value FROM metadata WHERE key IN ('memory_identity_schema_version', 'mutation_sequence', 'integrity_sequence')",
        )
      : [];
    const metadata = new Map(EffectArray.map(metadataRows, row => [row.key, row.value] as const));
    const indexRows = yield* sql.unsafe<{readonly name: string; readonly sql: string | null}>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('documents_memory_identity', 'documents_logical_key')",
    );
    const indexSqlByName = new Map(EffectArray.map(indexRows, row => [row.name, row.sql ?? undefined] as const));
    const existingIndexSql = indexSqlByName.get('documents_memory_identity');
    const legacyExpressionIndex =
      existingIndexSql !== undefined && Effect2.pipe(existingIndexSql, EffectString.includes('json_extract'));
    const logicalKeyIndexSql = indexSqlByName.get('documents_logical_key');
    const legacyLogicalKeyIndex =
      hasLogicalKeyAndLength &&
      logicalKeyIndexSql !== undefined &&
      !Effect2.pipe(logicalKeyIndexSql, EffectString.includes('document_length'));
    const needsIdentityMigration =
      !hasMemoryId ||
      !hasContentHash ||
      legacyExpressionIndex ||
      (hasMetadata && metadata.get('memory_identity_schema_version') !== RECALL_IDENTITY_COLUMN_SCHEMA_VERSION);
    return {
      hasContentHash,
      hasLogicalKeyAndLength,
      hasMemoryId,
      legacyLogicalKeyIndex,
      metadata,
      needsIdentityMigration,
      needsMigration: needsIdentityMigration || legacyLogicalKeyIndex,
    };
  });

  const ensureIndexes = (hasLogicalKeyAndLength: boolean) =>
    Effect.gen(function* () {
      yield* sql.unsafe(
        'CREATE INDEX IF NOT EXISTS documents_memory_identity ON documents(memory_id, content_hash, uri)',
      );
      if (hasLogicalKeyAndLength) {
        yield* sql.unsafe(
          'CREATE INDEX IF NOT EXISTS documents_logical_key ON documents(logical_key, document_length)',
        );
      }
    });

  const initial = yield* inspectState;
  if (!initial.needsMigration) {
    yield* ensureIndexes(initial.hasLogicalKeyAndLength);
    return;
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const txState = yield* inspectState;
      if (!txState.needsMigration) {
        yield* ensureIndexes(txState.hasLogicalKeyAndLength);
        return;
      }
      const beforeMutationSequence = txState.metadata.get('mutation_sequence');
      const wasIntegrityCurrent =
        beforeMutationSequence !== undefined && beforeMutationSequence === txState.metadata.get('integrity_sequence');
      if (txState.needsIdentityMigration) {
        if (!txState.hasMemoryId) yield* sql.unsafe('ALTER TABLE documents ADD COLUMN memory_id TEXT');
        if (!txState.hasContentHash) yield* sql.unsafe('ALTER TABLE documents ADD COLUMN content_hash TEXT');
        yield* sql.unsafe(`
          UPDATE documents
          SET
            memory_id = CASE WHEN json_type(candidate_json, '$.memoryId') = 'text' THEN json_extract(candidate_json, '$.memoryId') ELSE NULL END,
            content_hash = CASE WHEN json_type(candidate_json, '$.contentHash') = 'text' THEN json_extract(candidate_json, '$.contentHash') ELSE NULL END
          WHERE memory_id IS NOT (CASE WHEN json_type(candidate_json, '$.memoryId') = 'text' THEN json_extract(candidate_json, '$.memoryId') ELSE NULL END)
             OR content_hash IS NOT (CASE WHEN json_type(candidate_json, '$.contentHash') = 'text' THEN json_extract(candidate_json, '$.contentHash') ELSE NULL END)
        `);
        yield* sql.unsafe('DROP INDEX IF EXISTS documents_memory_identity');
      }
      if (txState.legacyLogicalKeyIndex) yield* sql.unsafe('DROP INDEX IF EXISTS documents_logical_key');
      yield* ensureIndexes(txState.hasLogicalKeyAndLength);
      if (txState.needsIdentityMigration) yield* rebuildRecallIdentityConflicts(sql);
      if (hasMetadata) {
        yield* sql.unsafe(
          `INSERT INTO metadata (key, value)
           VALUES ('memory_identity_schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [RECALL_IDENTITY_COLUMN_SCHEMA_VERSION],
        );
        if (wasIntegrityCurrent) {
          yield* sql.unsafe(`
            INSERT INTO metadata (key, value)
            SELECT 'integrity_sequence', value FROM metadata WHERE key = 'mutation_sequence'
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `);
        }
      }
    }),
  );
});

export function recallIndexMetadataIsCurrent(metadata: ReadonlyMap<string, string>): boolean {
  const contentGeneration = metadata.get('content_generation');
  const mutationSequence = metadata.get('mutation_sequence');
  return (
    contentGeneration !== undefined &&
    metadata.get('memory_identity_conflict_generation') === contentGeneration &&
    metadata.get('memory_identity_schema_version') === RECALL_IDENTITY_COLUMN_SCHEMA_VERSION &&
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
    SELECT memory_id
    FROM documents
    WHERE memory_id IS NOT NULL
      AND content_hash IS NOT NULL
    GROUP BY memory_id
    HAVING COUNT(DISTINCT content_hash) > 1
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
      recallIdentityUriScopePredicate('d', allowedUriScopes),
      recallEligibilityPredicate('d', eligibility, 'd.content_hash'),
    );
    const rows: RecallIdentityConflictRow[] = [];
    for (let start = 0; start < memoryIds.length; start += IDENTITY_QUERY_BATCH_SIZE) {
      const batch = memoryIds.slice(start, start + IDENTITY_QUERY_BATCH_SIZE);
      const memoryIdParameters = EffectArray.join(
        EffectArray.map(batch, () => '?'),
        ', ',
      );
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
              `SELECT d.memory_id AS memory_id
               FROM documents AS d
               WHERE ${scope.sql}
                 AND d.memory_id IN (${memoryIdParameters})
                 AND d.memory_id IS NOT NULL
                 AND d.content_hash IS NOT NULL
               GROUP BY d.memory_id
               HAVING COUNT(DISTINCT d.content_hash) > 1`,
              [...scope.params, ...batch],
            )),
      );
    }
    const conflicts = new Set(EffectArray.map(rows, row => row.memory_id));
    cache.set(key, conflicts);
    return conflicts;
  });
}

export function markRecallIdentityConflicts(
  candidates: readonly RecallCandidate[],
  conflictingMemoryIds: ReadonlySet<string>,
): readonly RecallCandidate[] {
  if (conflictingMemoryIds.size === 0) return candidates;
  return EffectArray.map(candidates, candidate =>
    candidate.memoryId && conflictingMemoryIds.has(candidate.memoryId)
      ? {...candidate, identityConflict: true}
      : candidate,
  );
}
