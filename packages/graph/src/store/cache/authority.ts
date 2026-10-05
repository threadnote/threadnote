import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {tableExists} from '../session.js';
import {CodeGraphStoreError} from '../../types.js';

export const CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE = 'file_blob_authority';

export const CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} (
    extractor_set TEXT NOT NULL,
    path_hint TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    blob_id TEXT,
    reuse_class TEXT,
    PRIMARY KEY (extractor_set, path_hint, content_hash)
  ) WITHOUT ROWID
`;

function authorityExpression(prefix = ''): string {
  return `CASE
    WHEN json_valid(${prefix}facts_json)
    THEN json_extract(${prefix}facts_json, '$.path') = ${prefix}path_hint
    ELSE 0
  END`;
}

const CODE_GRAPH_FILE_BLOB_AUTHORITY_TRIGGERS = [
  {
    name: 'file_blobs_authority_insert',
    sql: `CREATE TRIGGER IF NOT EXISTS file_blobs_authority_insert
   AFTER INSERT ON file_blobs
   WHEN (${authorityExpression('NEW.')}) = 1
   BEGIN
     INSERT INTO ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} (
       extractor_set, path_hint, content_hash, blob_id, reuse_class
     ) VALUES (NEW.extractor_set, NEW.path_hint, NEW.content_hash, NEW.blob_id, NEW.reuse_class);
   END`,
  },
  {
    name: 'file_blobs_authority_delete',
    sql: `CREATE TRIGGER IF NOT EXISTS file_blobs_authority_delete
   AFTER DELETE ON file_blobs
   BEGIN
     DELETE FROM ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE}
     WHERE extractor_set = OLD.extractor_set
       AND path_hint = OLD.path_hint
       AND content_hash = OLD.content_hash;
   END`,
  },
  {
    name: 'file_blobs_authority_update',
    sql: `CREATE TRIGGER IF NOT EXISTS file_blobs_authority_update
   AFTER UPDATE OF content_hash, extractor_set, path_hint, blob_id, reuse_class, facts_json ON file_blobs
   BEGIN
     DELETE FROM ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE}
     WHERE extractor_set = OLD.extractor_set
       AND path_hint = OLD.path_hint
       AND content_hash = OLD.content_hash;
     INSERT INTO ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} (
       extractor_set, path_hint, content_hash, blob_id, reuse_class
     )
     SELECT NEW.extractor_set, NEW.path_hint, NEW.content_hash, NEW.blob_id, NEW.reuse_class
     WHERE (${authorityExpression('NEW.')}) = 1;
   END`,
  },
] as const;

export const CODE_GRAPH_FILE_BLOB_AUTHORITY_TRIGGER_SQL = CODE_GRAPH_FILE_BLOB_AUTHORITY_TRIGGERS.map(
  trigger => trigger.sql,
);

const CODE_GRAPH_FILE_BLOB_AUTHORITY_BACKFILL_SQL = `
  INSERT INTO ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} (
    extractor_set, path_hint, content_hash, blob_id, reuse_class
  )
  SELECT extractor_set, path_hint, content_hash, blob_id, reuse_class
  FROM file_blobs
  WHERE (${authorityExpression()}) = 1
`;

/**
 * Publishes the narrow cache-authority projection and backfills it only when
 * first created. Triggers keep later mutations atomic with their source row.
 */
export const ensureCodeGraphFileBlobAuthority = Effect.fn('codeGraph.ensureFileBlobAuthority')(function* (
  sql: SqlClient.SqlClient,
) {
  if (!(yield* tableExists(sql, 'file_blobs'))) return;
  const expected = new Map([
    [CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE, {sql: CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE_SQL, type: 'table'}],
    ...CODE_GRAPH_FILE_BLOB_AUTHORITY_TRIGGERS.map(
      trigger => [trigger.name, {sql: trigger.sql, type: 'trigger'}] as const,
    ),
  ]);
  const observed = yield* sql.unsafe<{readonly name: unknown; readonly sql: unknown; readonly type: unknown}>(
    `SELECT name, type, sql
     FROM sqlite_master
     WHERE name IN (${[...expected].map(() => '?').join(', ')})`,
    [...expected.keys()],
  );
  const conflictingObject = observed.some(row => {
    const contract = typeof row.name === 'string' ? expected.get(row.name) : undefined;
    return contract === undefined || row.type !== contract.type;
  });
  if (conflictingObject) {
    return yield* CodeGraphStoreError.of('Code graph file cache authority schema is incompatible.');
  }
  const current =
    observed.length === expected.size &&
    observed.every(row => {
      const contract = expected.get(String(row.name));
      return contract !== undefined && normalizedSchemaSql(row.sql) === normalizedSchemaSql(contract.sql);
    });
  if (current) return;

  for (const trigger of CODE_GRAPH_FILE_BLOB_AUTHORITY_TRIGGERS) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  }
  yield* sql.unsafe(`DROP TABLE IF EXISTS ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE}`);
  yield* sql.unsafe(CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE_SQL);
  for (const trigger of CODE_GRAPH_FILE_BLOB_AUTHORITY_TRIGGER_SQL) yield* sql.unsafe(trigger);
  yield* sql.unsafe(CODE_GRAPH_FILE_BLOB_AUTHORITY_BACKFILL_SQL);
});

function normalizedSchemaSql(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
        .replace(/\bIF\s+NOT\s+EXISTS\b/giu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase()
    : undefined;
}
