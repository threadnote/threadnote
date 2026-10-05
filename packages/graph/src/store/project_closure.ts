import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {compareCodeUnits} from '../ordering.js';
import {configureConnection} from './session.js';
import type {CodeGraphSqlQueryStatement} from './visualization_sql.js';
import type {CodeGraphInventoryFile} from '../types.js';

export const SNAPSHOT_PROJECT_CLOSURE_MAX_FILES = 128;
const SNAPSHOT_PROJECT_CLOSURE_MAX_PREFIXES = 256;

/**
 * Canonicalize non-empty repository directory prefixes and discard descendants
 * already covered by an ancestor. An empty project root would select the whole
 * repository and therefore remains ineligible for sparse closure admission.
 */
export function boundedSnapshotProjectPrefixes(prefixes: readonly string[]): readonly string[] | undefined {
  if (prefixes.length === 0 || prefixes.length > SNAPSHOT_PROJECT_CLOSURE_MAX_PREFIXES) return undefined;
  const ordered = [...new Set(prefixes)].sort(compareCodeUnits);
  if (
    ordered.some(prefix => {
      const segments = prefix.split('/');
      return (
        prefix.length === 0 ||
        prefix.length > 4_096 ||
        prefix.includes('\0') ||
        prefix.includes('\\') ||
        prefix.startsWith('/') ||
        segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
      );
    })
  ) {
    return undefined;
  }
  const roots: string[] = [];
  for (const prefix of ordered) {
    if (roots.some(root => prefix === root || prefix.startsWith(`${root}/`))) continue;
    roots.push(prefix);
  }
  return roots;
}

export function codeGraphSnapshotProjectClosureStatement(
  snapshotId: string,
  roots: readonly string[],
): CodeGraphSqlQueryStatement {
  const ranges = roots.flatMap(root => [`${root}/`, `${root}0`]);
  return {
    parameters: [...ranges, snapshotId, SNAPSHOT_PROJECT_CLOSURE_MAX_FILES + 1],
    text: `WITH requested(lower, upper) AS (
        VALUES ${roots.map(() => '(?, ?)').join(', ')}
      )
      SELECT file.content_hash, file.language, file.mode, file.path, file.size, file.source
      FROM requested
      CROSS JOIN snapshot_files AS file INDEXED BY sqlite_autoindex_snapshot_files_1
      WHERE file.snapshot_id = ?
        AND file.path >= requested.lower
        AND file.path < requested.upper
      LIMIT ?`,
  };
}

/**
 * Load at most one bounded project closure from the persisted snapshot. The
 * primary key begins with (snapshot_id, path), so every prefix is an indexed
 * half-open path range. The extra row is an overflow sentinel, never partial
 * closure evidence.
 */
export const selectSnapshotProjectClosureFiles = Effect.fn('codeGraph.selectSnapshotProjectClosureFiles')(function* (
  snapshotId: string,
  prefixes: readonly string[],
) {
  const roots = boundedSnapshotProjectPrefixes(prefixes);
  if (roots === undefined) return undefined;
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const statement = codeGraphSnapshotProjectClosureStatement(snapshotId, roots);
  const rows = yield* sql.unsafe<{
    readonly content_hash: string;
    readonly language: string;
    readonly mode: string;
    readonly path: string;
    readonly size: number;
    readonly source: string;
  }>(statement.text, statement.parameters);
  if (
    rows.length === 0 ||
    rows.length > SNAPSHOT_PROJECT_CLOSURE_MAX_FILES ||
    rows.some(row => row.source !== 'commit')
  ) {
    return undefined;
  }
  const filesByPath = new Map(rows.map(row => [row.path, row]));
  if (filesByPath.size !== rows.length) return undefined;
  return [...filesByPath.values()]
    .sort((left, right) => compareCodeUnits(left.path, right.path))
    .map(file => ({
      blobId: `snapshot:${file.content_hash}`,
      contentHash: file.content_hash,
      language: file.language,
      mode: file.mode,
      path: file.path,
      size: Number(file.size),
      source: 'commit' as const,
    })) satisfies readonly CodeGraphInventoryFile[];
});
