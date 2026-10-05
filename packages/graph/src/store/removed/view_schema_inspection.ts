import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  REMOVED_VIEWS_TABLE_SQL,
  REMOVED_VIEW_CLEANUP_COLUMNS,
  REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL,
  REMOVED_VIEW_CLEANUP_TABLE_SQL,
  REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
} from './view_schema_contracts.js';
import {
  REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
  SCHEMA_METADATA_TABLE_SQL,
  type SchemaMetadataMaximumRows,
  inspectBoundedSchemaMetadataValue,
} from '../schema/metadata.js';
import {normalizeSchemaDefinition} from '../schema/normalization.js';
import {codeGraphScopeAuthorityInstalled, codeGraphScopeAuthoritySchemaCompatible} from '../scope/schema.js';

export const removedViewAuthorityTableState = Effect.fn('codeGraph.removedViewAuthorityTableState')(function* (
  sql: SqlClient.SqlClient,
) {
  if (yield* codeGraphScopeAuthorityInstalled(sql)) {
    return (yield* codeGraphScopeAuthoritySchemaCompatible(sql, ['removed_views']))
      ? ('compatible' as const)
      : ('incompatible' as const);
  }
  const objects = yield* sql.unsafe<{
    readonly name: unknown;
    readonly sql: unknown;
    readonly sql_bytes: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 512 THEN sql
              ELSE NULL
            END AS sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = 'removed_views' COLLATE NOCASE
     LIMIT 2`,
  );
  if (objects.length === 0) return 'absent' as const;
  const object = objects[0];
  if (
    objects.length !== 1 ||
    object?.name !== 'removed_views' ||
    object.type !== 'table' ||
    object.tbl_name !== 'removed_views' ||
    typeof object.sql_bytes !== 'number' ||
    !Number.isSafeInteger(object.sql_bytes) ||
    object.sql_bytes > 512 ||
    typeof object.sql !== 'string' ||
    normalizeSchemaDefinition(object.sql) !== normalizeSchemaDefinition(REMOVED_VIEWS_TABLE_SQL)
  ) {
    return 'incompatible' as const;
  }
  const columns = yield* sql.unsafe<{
    readonly dflt_value: unknown;
    readonly hidden: unknown;
    readonly name: unknown;
    readonly notnull: unknown;
    readonly pk: unknown;
    readonly type: unknown;
  }>(`SELECT * FROM pragma_table_xinfo('removed_views') LIMIT 4`);
  const expected = [
    {name: 'worktree_id', pk: 1},
    {name: 'expected_snapshot_id', pk: 0},
    {name: 'removed_at', pk: 0},
  ] as const;
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const contract = expected[index];
      return (
        contract === undefined ||
        column.name !== contract.name ||
        column.type !== 'TEXT' ||
        column.notnull !== 1 ||
        column.pk !== contract.pk ||
        column.hidden !== 0 ||
        column.dflt_value !== null
      );
    }) ||
    (yield* sql.unsafe(`SELECT 1 FROM pragma_foreign_key_list('removed_views') LIMIT 1`)).length !== 0
  ) {
    return 'incompatible' as const;
  }
  const indexes = yield* sql.unsafe<{
    readonly name: unknown;
    readonly origin: unknown;
    readonly partial: unknown;
    readonly unique: unknown;
  }>(`SELECT name, origin, partial, "unique" AS "unique" FROM pragma_index_list('removed_views') LIMIT 2`);
  if (
    indexes.length !== 1 ||
    indexes[0]?.name !== 'sqlite_autoindex_removed_views_1' ||
    indexes[0]?.origin !== 'pk' ||
    indexes[0]?.unique !== 1 ||
    indexes[0]?.partial !== 0
  ) {
    return 'incompatible' as const;
  }
  const primary = yield* sql.unsafe<{
    readonly cid: unknown;
    readonly coll: unknown;
    readonly desc: unknown;
    readonly key: unknown;
    readonly name: unknown;
    readonly seqno: unknown;
  }>(`SELECT * FROM pragma_index_xinfo('sqlite_autoindex_removed_views_1') LIMIT 4`);
  return primary.length === 3 &&
    primary[0]?.seqno === 0 &&
    primary[0]?.cid === 0 &&
    primary[0]?.name === 'worktree_id' &&
    primary[0]?.desc === 0 &&
    primary[0]?.coll === 'BINARY' &&
    primary[0]?.key === 1 &&
    primary
      .slice(1)
      .every(
        (column, index) =>
          column.seqno === index + 1 &&
          column.cid === index + 1 &&
          column.name === expected[index + 1]?.name &&
          column.desc === 0 &&
          column.coll === 'BINARY' &&
          column.key === 0,
      )
    ? ('compatible' as const)
    : ('incompatible' as const);
});

export const removedViewCleanupSchemaState = Effect.fn('codeGraph.removedViewCleanupSchemaState')(function* (
  sql: SqlClient.SqlClient,
) {
  if (yield* codeGraphScopeAuthorityInstalled(sql)) {
    return (yield* codeGraphScopeAuthoritySchemaCompatible(sql, [
      'removed_view_cleanup',
      'removed_view_cleanup_due',
      ...REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.map(trigger => trigger.name),
    ]))
      ? ('compatible' as const)
      : ('incompatible' as const);
  }
  const objects = yield* sql.unsafe<{
    readonly name: string;
    readonly sql: string | null;
    readonly sql_bytes: number | null;
    readonly tbl_name: string;
    readonly type: string;
  }>(
    `SELECT type, name, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql
              ELSE NULL
            END AS sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE lower(name) IN ('removed_view_cleanup', 'removed_view_cleanup_due')
        OR (type = 'trigger' AND tbl_name = 'removed_views' COLLATE NOCASE)
     ORDER BY name, type
     LIMIT 6`,
  );
  const expectedNames = new Set([
    'removed_view_cleanup',
    'removed_view_cleanup_due',
    ...REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.map(trigger => trigger.name),
  ]);
  if (
    objects.some(
      object =>
        object.name !== object.name.toLowerCase() ||
        !expectedNames.has(object.name) ||
        typeof object.sql_bytes !== 'number' ||
        !Number.isSafeInteger(object.sql_bytes) ||
        object.sql_bytes > 8192,
    )
  ) {
    return 'incompatible' as const;
  }
  const tables = objects.filter(object => object.name === 'removed_view_cleanup');
  const dueObjects = objects.filter(object => object.name === 'removed_view_cleanup_due');
  const triggerObjects = objects.filter(object =>
    REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.some(trigger => trigger.name === object.name),
  );
  if (tables.length === 0) {
    return dueObjects.length === 0 && triggerObjects.length === 0 ? ('absent' as const) : ('incompatible' as const);
  }
  if (
    tables.length !== 1 ||
    tables[0]?.type !== 'table' ||
    tables[0]?.tbl_name !== 'removed_view_cleanup' ||
    typeof tables[0]?.sql !== 'string' ||
    dueObjects.some(object => object.type !== 'index' || object.tbl_name !== 'removed_view_cleanup') ||
    triggerObjects.length !== REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.length ||
    REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.some(expected => {
      const observed = triggerObjects.find(object => object.name === expected.name);
      return (
        observed?.type !== 'trigger' ||
        observed.tbl_name !== 'removed_views' ||
        typeof observed.sql !== 'string' ||
        normalizeSchemaDefinition(observed.sql) !== normalizeSchemaDefinition(expected.sql)
      );
    })
  ) {
    return 'incompatible' as const;
  }
  const columns = yield* sql.unsafe<{
    readonly hidden: number;
    readonly name: string;
    readonly notnull: number;
    readonly pk: number;
    readonly type: string;
  }>(`SELECT * FROM pragma_table_xinfo('removed_view_cleanup') LIMIT ${REMOVED_VIEW_CLEANUP_COLUMNS.length + 1}`);
  const compatibleColumns =
    columns.length === REMOVED_VIEW_CLEANUP_COLUMNS.length &&
    columns.every((column, index) => {
      const expected = REMOVED_VIEW_CLEANUP_COLUMNS[index];
      return (
        expected !== undefined &&
        Number(column.hidden) === 0 &&
        column.name === expected.name &&
        column.type.toUpperCase() === expected.type &&
        Number(column.notnull) === Number(expected.notNull) &&
        Number(column.pk) === expected.primaryKeyPosition
      );
    });
  const compatibleDefinition =
    normalizeSchemaDefinition(tables[0].sql) === normalizeSchemaDefinition(REMOVED_VIEW_CLEANUP_TABLE_SQL);
  const foreignKeys = yield* sql.unsafe(`SELECT 1 FROM pragma_foreign_key_list('removed_view_cleanup') LIMIT 1`);
  const triggers = yield* sql.unsafe(
    `SELECT name FROM sqlite_master
     WHERE type = 'trigger' AND tbl_name = 'removed_view_cleanup' COLLATE NOCASE
     LIMIT 1`,
  );
  if (!compatibleColumns || !compatibleDefinition || foreignKeys.length !== 0 || triggers.length !== 0) {
    return 'incompatible' as const;
  }

  const indexes = yield* sql.unsafe<{
    readonly name: string;
    readonly origin: string;
    readonly partial: number;
    readonly unique: number;
  }>(`SELECT name, origin, partial, "unique" AS "unique"
      FROM pragma_index_list('removed_view_cleanup') LIMIT 3`);
  const primary = indexes.find(index => index.origin === 'pk');
  const due = indexes.find(index => index.name === 'removed_view_cleanup_due');
  if (due === undefined) {
    // Building this index over an existing queue would be unbounded startup
    // work. Revision 8 creates the empty table and index atomically instead.
    return 'incompatible' as const;
  }
  if (primary?.name !== 'sqlite_autoindex_removed_view_cleanup_1') return 'incompatible' as const;
  const primaryColumns = yield* sql.unsafe<{
    readonly coll: unknown;
    readonly desc: unknown;
    readonly key: unknown;
    readonly name: unknown;
    readonly seqno: unknown;
  }>(
    `SELECT seqno, name, desc, coll, key
     FROM pragma_index_xinfo('sqlite_autoindex_removed_view_cleanup_1')
     LIMIT ${REMOVED_VIEW_CLEANUP_COLUMNS.length + 1}`,
  );
  if (
    primaryColumns.length !== REMOVED_VIEW_CLEANUP_COLUMNS.length ||
    primaryColumns.some(
      (column, index) =>
        column.seqno !== index ||
        column.name !== REMOVED_VIEW_CLEANUP_COLUMNS[index]?.name ||
        column.desc !== 0 ||
        column.coll !== 'BINARY' ||
        column.key !== (index < 2 ? 1 : 0),
    )
  ) {
    return 'incompatible' as const;
  }
  return dueObjects.length === 1 &&
    indexes.length === 2 &&
    primary !== undefined &&
    Number(primary.unique) === 1 &&
    Number(primary.partial) === 0 &&
    Number(due.unique) === 0 &&
    due.origin === 'c' &&
    Number(due.partial) === 1 &&
    normalizeSchemaDefinition(dueObjects[0]?.sql ?? '') ===
      normalizeSchemaDefinition(REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL)
    ? ('compatible' as const)
    : ('incompatible' as const);
});

export const removedViewCleanupRecordedRevision = Effect.fn('codeGraph.removedViewCleanupRecordedRevision')(function* (
  sql: SqlClient.SqlClient,
  maximumMetadataRows: SchemaMetadataMaximumRows = REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
) {
  const metadataObjects = yield* sql.unsafe<{
    readonly name: unknown;
    readonly sql: unknown;
    readonly sql_bytes: unknown;
    readonly sql_type: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 256 THEN sql
              ELSE NULL
            END AS sql,
            typeof(sql) AS sql_type,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = 'schema_metadata' COLLATE NOCASE
     ORDER BY type
     LIMIT 2`,
  );
  if (metadataObjects.length === 0) return {metadataPresent: false, state: 'missing'};
  if (
    metadataObjects.length !== 1 ||
    metadataObjects[0]?.name !== 'schema_metadata' ||
    metadataObjects[0]?.type !== 'table' ||
    metadataObjects[0]?.tbl_name !== 'schema_metadata' ||
    metadataObjects[0]?.sql_type !== 'text' ||
    typeof metadataObjects[0]?.sql_bytes !== 'number' ||
    !Number.isSafeInteger(metadataObjects[0].sql_bytes) ||
    metadataObjects[0].sql_bytes > 256 ||
    typeof metadataObjects[0]?.sql !== 'string' ||
    normalizeSchemaDefinition(metadataObjects[0].sql) !== normalizeSchemaDefinition(SCHEMA_METADATA_TABLE_SQL)
  ) {
    return {state: 'invalid'};
  }
  const columns = yield* sql.unsafe<{
    readonly dflt_value: unknown;
    readonly hidden: unknown;
    readonly name: unknown;
    readonly notnull: unknown;
    readonly pk: unknown;
    readonly type: unknown;
  }>(`SELECT * FROM pragma_table_xinfo('schema_metadata') LIMIT 3`);
  if (
    columns.length !== 2 ||
    columns[0]?.name !== 'key' ||
    columns[0]?.type !== 'TEXT' ||
    Number(columns[0]?.notnull) !== 1 ||
    Number(columns[0]?.pk) !== 1 ||
    Number(columns[0]?.hidden) !== 0 ||
    columns[0]?.dflt_value !== null ||
    columns[1]?.name !== 'value' ||
    columns[1]?.type !== 'TEXT' ||
    Number(columns[1]?.notnull) !== 1 ||
    Number(columns[1]?.pk) !== 0 ||
    Number(columns[1]?.hidden) !== 0 ||
    columns[1]?.dflt_value !== null
  ) {
    return {state: 'invalid'};
  }
  const indexes = yield* sql.unsafe<{
    readonly name: unknown;
    readonly origin: unknown;
    readonly partial: unknown;
    readonly unique: unknown;
  }>(`SELECT name, origin, partial, "unique" AS "unique" FROM pragma_index_list('schema_metadata') LIMIT 2`);
  if (
    indexes.length !== 1 ||
    indexes[0]?.name !== 'sqlite_autoindex_schema_metadata_1' ||
    indexes[0]?.origin !== 'pk' ||
    Number(indexes[0]?.unique) !== 1 ||
    Number(indexes[0]?.partial) !== 0
  ) {
    return {state: 'invalid'};
  }
  const keyIndex = yield* sql.unsafe<{
    readonly cid: unknown;
    readonly coll: unknown;
    readonly desc: unknown;
    readonly key: unknown;
    readonly name: unknown;
    readonly seqno: unknown;
  }>(`SELECT * FROM pragma_index_xinfo('sqlite_autoindex_schema_metadata_1') LIMIT 3`);
  if (
    keyIndex.length !== 2 ||
    Number(keyIndex[0]?.seqno) !== 0 ||
    Number(keyIndex[0]?.cid) !== 0 ||
    keyIndex[0]?.name !== 'key' ||
    Number(keyIndex[0]?.desc) !== 0 ||
    keyIndex[0]?.coll !== 'BINARY' ||
    Number(keyIndex[0]?.key) !== 1 ||
    Number(keyIndex[1]?.seqno) !== 1 ||
    Number(keyIndex[1]?.cid) !== -1 ||
    keyIndex[1]?.name !== null ||
    Number(keyIndex[1]?.desc) !== 0 ||
    keyIndex[1]?.coll !== 'BINARY' ||
    Number(keyIndex[1]?.key) !== 0
  ) {
    return {state: 'invalid'};
  }
  const foreignKeys = yield* sql.unsafe(`SELECT 1 FROM pragma_foreign_key_list('schema_metadata') LIMIT 1`);
  const triggers = yield* sql.unsafe(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'schema_metadata' COLLATE NOCASE LIMIT 1",
  );
  if (foreignKeys.length !== 0 || triggers.length !== 0) return {state: 'invalid'};

  const revision = yield* inspectBoundedSchemaMetadataValue(
    sql,
    'persistent_extension_schema_revision',
    16,
    maximumMetadataRows,
  );
  if (revision.state === 'missing') return {metadataPresent: true, state: 'missing'};
  if (
    revision.state === 'invalid' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(revision.value) ||
    !Number.isSafeInteger(Number(revision.value))
  ) {
    return {state: 'invalid'};
  }
  return {state: 'recorded', value: Number(revision.value)};
});
