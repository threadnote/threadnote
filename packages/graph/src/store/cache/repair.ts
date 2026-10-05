import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import type {CodeGraphInventoryFile} from '../../types.js';

/**
 * Quarantine only exact cache tuples that failed bounded payload validation.
 * Cache rows are reconstructible; deleting every generation for the same
 * (path, content) pair forces ordinary inventory admission to re-extract the
 * committed blob without touching unrelated cache authority.
 */
export const discardInvalidCachedFacts = Effect.fn('codeGraph.discardInvalidCachedFacts')(function* (
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
) {
  if (files.length === 0 || files.length > 200) return;
  const sql = yield* SqlClient.SqlClient;
  for (let offset = 0; offset < files.length; offset += 100) {
    const batch = files.slice(offset, offset + 100);
    yield* sql.unsafe(
      `DELETE FROM file_blobs
       WHERE ${batch.map(() => '(path_hint = ? AND content_hash = ?)').join(' OR ')}`,
      batch.flatMap(file => [file.path, file.contentHash]),
    );
  }
});
