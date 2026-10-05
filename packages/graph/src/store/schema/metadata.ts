import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {codeGraphRuntimeSchemaRequiresReconnect} from './revision.js';
import {tableExists} from '../session.js';
import {CodeGraphRuntimeReconnectRequiredError, CodeGraphStoreError} from '../../types.js';

export const REMOVED_VIEW_CLEANUP_LEGACY_MAXIMUM_METADATA_ROWS = 64;
export const REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS = 66;
export type SchemaMetadataMaximumRows = 66 | 67;

export const SCHEMA_METADATA_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`;

export const inspectBoundedSchemaMetadataRowCount = Effect.fn('codeGraph.inspectBoundedSchemaMetadataRowCount')(
  function* (
    sql: SqlClient.SqlClient,
    maximumRows: SchemaMetadataMaximumRows = REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
  ) {
    const rows = yield* sql.unsafe(`SELECT 1 FROM schema_metadata LIMIT ${maximumRows + 1}`);
    return rows.length > maximumRows ? undefined : rows.length;
  },
);

export const inspectBoundedSchemaMetadataValue = Effect.fn('codeGraph.inspectBoundedSchemaMetadataValue')(function* (
  sql: SqlClient.SqlClient,
  key: string,
  maximumValueBytes: number,
  maximumRows: SchemaMetadataMaximumRows = REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
) {
  if ((yield* inspectBoundedSchemaMetadataRowCount(sql, maximumRows)) === undefined) {
    return {state: 'invalid'} as const;
  }
  const rows = yield* sql.unsafe<{
    readonly bounded_key: unknown;
    readonly bounded_value: unknown;
    readonly key_bytes: unknown;
    readonly key_type: unknown;
    readonly value_bytes: unknown;
    readonly value_type: unknown;
  }>(
    `SELECT
       CASE
         WHEN typeof(key) = 'text' AND length(CAST(key AS BLOB)) <= ? THEN key
         ELSE NULL
       END AS bounded_key,
       CASE
         WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ? THEN value
         ELSE NULL
       END AS bounded_value,
       typeof(key) AS key_type,
       length(CAST(key AS BLOB)) AS key_bytes,
       typeof(value) AS value_type,
       length(CAST(value AS BLOB)) AS value_bytes
     FROM schema_metadata
     WHERE key = ? COLLATE NOCASE
     LIMIT 3`,
    [key.length, maximumValueBytes, key],
  );
  if (rows.length === 0) return {state: 'missing'} as const;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.bounded_key !== key ||
    row.key_type !== 'text' ||
    row.key_bytes !== key.length ||
    row.value_type !== 'text' ||
    typeof row.value_bytes !== 'number' ||
    !Number.isSafeInteger(row.value_bytes) ||
    row.value_bytes < 0 ||
    row.value_bytes > maximumValueBytes ||
    typeof row.bounded_value !== 'string'
  ) {
    return {state: 'invalid'} as const;
  }
  return {state: 'recorded', value: row.bounded_value} as const;
});

const inspectRuntimeSchemaMetadataVersion = Effect.fn('codeGraph.inspectRuntimeSchemaMetadataVersion')(function* (
  sql: SqlClient.SqlClient,
  key: 'persistent_extension_schema_revision' | 'schema_version',
) {
  const rows = yield* sql.unsafe<{
    readonly bounded_key: unknown;
    readonly bounded_value: unknown;
    readonly key_bytes: unknown;
    readonly key_type: unknown;
    readonly value_bytes: unknown;
    readonly value_type: unknown;
  }>(
    `SELECT
       CASE
         WHEN typeof(key) = 'text' AND length(CAST(key AS BLOB)) <= ? THEN key
         ELSE NULL
       END AS bounded_key,
       CASE
         WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= 16 THEN value
         ELSE NULL
       END AS bounded_value,
       typeof(key) AS key_type,
       length(CAST(key AS BLOB)) AS key_bytes,
       typeof(value) AS value_type,
       length(CAST(value AS BLOB)) AS value_bytes
     FROM schema_metadata
     WHERE key = ? COLLATE NOCASE
     LIMIT 3`,
    [key.length, key],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.bounded_key !== key ||
    row.key_type !== 'text' ||
    row.key_bytes !== key.length ||
    row.value_type !== 'text' ||
    typeof row.value_bytes !== 'number' ||
    !Number.isSafeInteger(row.value_bytes) ||
    row.value_bytes < 1 ||
    row.value_bytes > 16 ||
    typeof row.bounded_value !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,14})$/u.test(row.bounded_value)
  ) {
    return yield* CodeGraphStoreError.of('Code graph runtime schema metadata is invalid.', {
      operation: 'check code graph runtime compatibility',
    });
  }
  const version = Number(row.bounded_value);
  if (!Number.isSafeInteger(version) || version < 0) {
    return yield* CodeGraphStoreError.of('Code graph runtime schema metadata is invalid.', {
      operation: 'check code graph runtime compatibility',
    });
  }
  return version;
});

export const assertCodeGraphRuntimeSchemaCompatible = Effect.fn('codeGraph.assertRuntimeSchemaCompatible')(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!(yield* tableExists(sql, 'schema_metadata'))) return;
    const schemaVersion = yield* inspectRuntimeSchemaMetadataVersion(sql, 'schema_version');
    const persistentExtensionRevision = yield* inspectRuntimeSchemaMetadataVersion(
      sql,
      'persistent_extension_schema_revision',
    );
    if (codeGraphRuntimeSchemaRequiresReconnect(schemaVersion, persistentExtensionRevision)) {
      return yield* CodeGraphRuntimeReconnectRequiredError.of({operation: 'check code graph runtime compatibility'});
    }
  },
);
