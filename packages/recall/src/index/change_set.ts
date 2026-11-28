import {Array as EffectArray, Effect} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {sqlPlaceholders} from '../vector/generation-compatibility.js';
import {readRecallChangesSince, type RecallChangeEntry} from './change_log.js';

/**
 * The changed set of a lexical index since one generation: the change-log entries and the current URIs
 * that share an identity with them. The masked vector read and the delta vector build both read it.
 */
export type RecallMaskLexicalInputs =
  | {
      readonly state: 'known';
      readonly contentGeneration: string;
      readonly changed: readonly RecallChangeEntry[];
      /** Current URIs whose memory ID or content hash equals a value before or after a change. */
      readonly identityUris: readonly string[];
    }
  | {readonly state: 'unknown' | 'over-cap'};

const lexicalNotKnown = (state: 'unknown' | 'over-cap'): RecallMaskLexicalInputs => ({state});

/** Identity values of the changed entries, before and after each change. */
function recallChangeIdentityValues(changed: readonly RecallChangeEntry[]) {
  const memoryIds = new Set<string>();
  const contentHashes = new Set<string>();
  for (const entry of changed) {
    for (const value of [entry.beforeMemoryId, entry.afterMemoryId]) if (value) memoryIds.add(value);
    for (const value of [entry.beforeContentHash, entry.afterContentHash]) if (value) contentHashes.add(value);
  }
  return {memoryIds: [...memoryIds].sort(), contentHashes: [...contentHashes].sort()};
}

/** The changed set from one open snapshot of a lexical index, at most `cap` URIs of each kind. */
export const readRecallMaskLexicalSnapshot = Effect.fn('recall.readMaskLexicalSnapshot')(function* (
  sql: SqlClient.SqlClient,
  fromGeneration: string,
  cap: number,
) {
  const changes = yield* readRecallChangesSince(sql, fromGeneration);
  if (changes.state === 'unknown') return lexicalNotKnown('unknown');
  if (changes.changed.length > cap) return lexicalNotKnown('over-cap');
  const {memoryIds, contentHashes} = recallChangeIdentityValues(changes.changed);
  const clauses = [
    ...(memoryIds.length === 0 ? [] : [`memory_id IN (${sqlPlaceholders(memoryIds.length)})`]),
    ...(contentHashes.length === 0 ? [] : [`content_hash IN (${sqlPlaceholders(contentHashes.length)})`]),
  ];
  // No index serves content_hash alone (about 4 ms warm for 6,200 rows); adding one needs a lexical version bump.
  const rows =
    clauses.length === 0
      ? []
      : yield* sql.unsafe<{readonly uri: string}>(
          `SELECT uri FROM documents WHERE ${EffectArray.join(clauses, ' OR ')} ORDER BY uri LIMIT ?`,
          [...memoryIds, ...contentHashes, cap + 1],
        );
  if (rows.length > cap) return lexicalNotKnown('over-cap');
  const known: RecallMaskLexicalInputs = {
    state: 'known',
    contentGeneration: changes.contentGeneration,
    changed: changes.changed,
    identityUris: EffectArray.map(rows, row => row.uri),
  };
  return known;
});
