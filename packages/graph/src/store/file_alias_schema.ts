import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {normalizeSchemaDefinition} from './schema/normalization.js';
import {inspectBoundedSchemaMetadataValue} from './schema/metadata.js';
import {
  CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE,
  CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE_SQL,
  CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM,
  CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM,
  nextCodeGraphSqliteSchemaVersion,
} from './schema/receipt.js';
import {
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphSnapshotFileCitationBaseIndexState,
  type CodeGraphSnapshotFileCitationSchemaState,
  CodeGraphStoreError,
} from '../types.js';
import {
  CODE_GRAPH_PERSISTENT_SCHEMA_CITATION_PREDECESSOR,
  CODE_GRAPH_SCHEMA_INITIALIZATION_CITATION_PREDECESSOR_CONTRACT_REVISION,
  codeGraphPersistentSchemaMigrationPending,
  codeGraphPersistentSchemaProfile,
  codeGraphPersistentSchemaSupports,
} from './schema/revision.js';

interface CodeGraphReferenceIndex {
  readonly columns: readonly string[];
  readonly definition: string;
  readonly name: string;
  readonly table: string;
}

export const CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX = {
  columns: ['path', 'content_hash'],
  definition: 'CREATE INDEX snapshot_files_blob ON snapshot_files(path, content_hash)',
  name: 'snapshot_files_blob',
  table: 'snapshot_files',
} as const satisfies CodeGraphReferenceIndex;

export const CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX = {
  columns: ['content_hash'],
  definition: 'CREATE INDEX snapshot_files_content_hash ON snapshot_files(content_hash)',
  name: 'snapshot_files_content_hash',
  table: 'snapshot_files',
} as const satisfies CodeGraphReferenceIndex;

export const CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX = {
  columns: ['raw_content_hash'],
  definition:
    'CREATE INDEX snapshot_files_raw_content_hash ON snapshot_files(raw_content_hash) WHERE raw_content_hash IS NOT NULL',
  name: 'snapshot_files_raw_content_hash',
  table: 'snapshot_files',
} as const satisfies CodeGraphReferenceIndex;

export const CODE_GRAPH_RAW_CONTENT_ALIAS_INDEX = CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX.name;
export const CODE_GRAPH_RAW_CONTENT_ALIAS_INDEX_SQL = CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX.definition;

const CODE_GRAPH_SNAPSHOT_FILES_RELEASED_TABLE_SQL = `
  CREATE TABLE snapshot_files (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    mode TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    source TEXT NOT NULL CHECK (source IN ('commit', 'worktree')),
    PRIMARY KEY (snapshot_id, path)
  ) WITHOUT ROWID
`;

export const CODE_GRAPH_SNAPSHOT_FILES_CURRENT_TABLE_SQL = `
  CREATE TABLE snapshot_files (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    raw_content_hash TEXT,
    language TEXT NOT NULL,
    mode TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    source TEXT NOT NULL CHECK (source IN ('commit', 'worktree')),
    PRIMARY KEY (snapshot_id, path)
  ) WITHOUT ROWID
`;

/** SQLite's exact table definition after adding the v16 alias to a released v15 table. */
const CODE_GRAPH_SNAPSHOT_FILES_MIGRATED_TABLE_SQL = `
  CREATE TABLE snapshot_files (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    mode TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    source TEXT NOT NULL CHECK (source IN ('commit', 'worktree')),
    raw_content_hash TEXT,
    PRIMARY KEY (snapshot_id, path)
  ) WITHOUT ROWID
`;

export interface CodeGraphSnapshotFileCitationSchemaInspection {
  readonly baseIndexes: CodeGraphSnapshotFileCitationBaseIndexState;
  readonly state: CodeGraphSnapshotFileCitationSchemaState;
}

export interface CodeGraphSnapshotFileCitationSchemaAuthorization {
  readonly allowColumnAuthority: boolean;
  readonly allowReleasedAuthority: boolean;
}

function citationSchemaInspection(
  baseIndexes: CodeGraphSnapshotFileCitationBaseIndexState,
  state: CodeGraphSnapshotFileCitationSchemaState,
): CodeGraphSnapshotFileCitationSchemaInspection {
  return {baseIndexes, state};
}

/** Exact row-preserving admission shared by repair preview and initialization. */
export function codeGraphSnapshotFileCitationSchemaMigrationPreserves(
  revision: number | undefined,
  state: CodeGraphSnapshotFileCitationSchemaState,
  baseIndexes: CodeGraphSnapshotFileCitationBaseIndexState,
): boolean {
  if (baseIndexes === 'incompatible') return false;
  const citationState = codeGraphPersistentSchemaProfile(revision)?.citationState;
  if (citationState === 'released-predecessor') {
    return (
      state === 'released-absent' ||
      state === 'released-absent-with-authority' ||
      state === 'released-absent-with-predecessor-authority' ||
      state === 'column-only' ||
      state === 'current'
    );
  }
  if (citationState === 'column-predecessor') {
    return (
      state === 'released-absent' ||
      state === 'released-absent-with-predecessor-authority' ||
      state === 'column-only' ||
      state === 'column-only-with-predecessor-authority' ||
      state === 'current'
    );
  }
  if (citationState !== 'current') return false;
  return (
    state === 'released-absent' ||
    state === 'released-absent-with-predecessor-authority' ||
    state === 'column-only' ||
    state === 'column-only-with-predecessor-authority' ||
    (baseIndexes === 'missing' && state === 'current')
  );
}

/** Exact citation-schema admission; other extension migrations retain their own authority rules. */
export function codeGraphSnapshotFileCitationSchemaMigrationAdmitted(
  revision: number | undefined,
  state: CodeGraphSnapshotFileCitationSchemaState,
  baseIndexes: CodeGraphSnapshotFileCitationBaseIndexState,
): boolean {
  if (baseIndexes === 'incompatible') return false;
  switch (state) {
    case 'released-absent-with-authority':
      return codeGraphPersistentSchemaMigrationPending(revision);
    case 'released-absent-with-predecessor-authority':
      return codeGraphPersistentSchemaSupports(revision, 'citation-released-predecessor-authority');
    case 'column-only-with-predecessor-authority':
      return codeGraphPersistentSchemaSupports(revision, 'citation-column-predecessor-authority');
    case 'column-only-with-authority':
    case 'incompatible':
      return false;
    default:
      return true;
  }
}

export const codeGraphCacheReferenceIndexState = Effect.fn('codeGraph.cacheReferenceIndexState')(function* (
  sql: SqlClient.SqlClient,
  index: CodeGraphReferenceIndex,
) {
  const definitions = yield* sql.unsafe<{
    readonly bounded_sql: unknown;
    readonly name: unknown;
    readonly sql_bytes: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 1024 THEN sql
              ELSE NULL
            END AS bounded_sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT 2`,
    [index.name],
  );
  if (definitions.length === 0) return 'missing' as const;
  const definition = definitions[0];
  if (
    definitions.length !== 1 ||
    definition?.name !== index.name ||
    definition.type !== 'index' ||
    definition.tbl_name !== index.table ||
    typeof definition.sql_bytes !== 'number' ||
    !Number.isSafeInteger(definition.sql_bytes) ||
    definition.sql_bytes > 1024 ||
    typeof definition.bounded_sql !== 'string' ||
    normalizeSchemaDefinition(definition.bounded_sql) !== normalizeSchemaDefinition(index.definition)
  ) {
    return 'incompatible' as const;
  }
  const xinfo = yield* sql.unsafe<{
    readonly coll: unknown;
    readonly desc: unknown;
    readonly key: unknown;
    readonly name: unknown;
    readonly seqno: unknown;
  }>(`SELECT seqno, name, desc, coll, key FROM pragma_index_xinfo(?) LIMIT 8`, [index.name]);
  const keyColumns = xinfo
    .filter(column => Number(column.key) === 1)
    .sort((left, right) => Number(left.seqno) - Number(right.seqno));
  return xinfo.length > 0 &&
    xinfo.length < 8 &&
    keyColumns.length === index.columns.length &&
    keyColumns.every(
      (column, columnIndex) =>
        column.name === index.columns[columnIndex] &&
        typeof column.coll === 'string' &&
        column.coll.toUpperCase() === 'BINARY' &&
        column.desc === 0,
    )
    ? ('ready' as const)
    : ('incompatible' as const);
});

const snapshotAuthorityState = Effect.fn('codeGraph.snapshotAuthorityState')(function* (
  sql: SqlClient.SqlClient,
  includeSnapshotFiles = false,
) {
  const objects = yield* sql.unsafe<{readonly name: unknown; readonly type: unknown}>(
    `SELECT name, type
       FROM sqlite_master
       WHERE name = 'snapshots' COLLATE NOCASE
          OR name = 'active_snapshots' COLLATE NOCASE
          OR (${includeSnapshotFiles ? '1' : '0'} = 1 AND name = 'snapshot_files' COLLATE NOCASE)
       LIMIT 4`,
  );
  if (
    objects.length > (includeSnapshotFiles ? 3 : 2) ||
    objects.some(
      object =>
        object.type !== 'table' ||
        (object.name !== 'snapshots' &&
          object.name !== 'active_snapshots' &&
          (!includeSnapshotFiles || object.name !== 'snapshot_files')),
    )
  ) {
    return 'incompatible' as const;
  }
  for (const table of [
    'snapshots',
    'active_snapshots',
    ...(includeSnapshotFiles ? (['snapshot_files'] as const) : []),
  ] as const) {
    if (!objects.some(object => object.name === table)) continue;
    const authority = yield* sql.unsafe<{readonly present: unknown}>(`SELECT 1 AS present FROM ${table} LIMIT 1`);
    if (authority.length > 0) return 'present' as const;
  }
  return 'absent' as const;
});

const predecessorInitializationReceiptPresent = Effect.fn('codeGraph.predecessorInitializationReceiptPresent')(
  function* (sql: SqlClient.SqlClient, cookieTransition: 'next' | 'same') {
    const definitions = yield* sql.unsafe<{readonly name: unknown; readonly sql: unknown; readonly type: unknown}>(
      `SELECT name,
              CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 2048 THEN sql ELSE NULL END AS sql,
              type
       FROM sqlite_master
       WHERE name = '${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE}' COLLATE NOCASE
       LIMIT 2`,
    );
    if (
      definitions.length !== 1 ||
      definitions[0]?.name !== CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE ||
      definitions[0].type !== 'table' ||
      typeof definitions[0].sql !== 'string' ||
      normalizeSchemaDefinition(definitions[0].sql) !==
        normalizeSchemaDefinition(CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE_SQL)
    ) {
      return false;
    }
    const receipts = yield* sql.unsafe<{
      readonly contract_revision: unknown;
      readonly contract_revision_type: unknown;
      readonly core_schema_version: unknown;
      readonly core_schema_version_type: unknown;
      readonly persistent_extension_revision: unknown;
      readonly persistent_extension_revision_type: unknown;
      readonly singleton: unknown;
      readonly singleton_type: unknown;
      readonly sqlite_schema_version: unknown;
      readonly sqlite_schema_version_type: unknown;
    }>(
      `SELECT CASE WHEN typeof(singleton) = 'integer' THEN singleton ELSE NULL END AS singleton,
              typeof(singleton) AS singleton_type,
              CASE WHEN typeof(contract_revision) = 'integer' THEN contract_revision ELSE NULL END
                AS contract_revision,
              typeof(contract_revision) AS contract_revision_type,
              CASE WHEN typeof(core_schema_version) = 'integer' THEN core_schema_version ELSE NULL END
                AS core_schema_version,
              typeof(core_schema_version) AS core_schema_version_type,
              CASE
                WHEN typeof(persistent_extension_revision) = 'integer' THEN persistent_extension_revision
                ELSE NULL
              END AS persistent_extension_revision,
              typeof(persistent_extension_revision) AS persistent_extension_revision_type,
              CASE WHEN typeof(sqlite_schema_version) = 'integer' THEN sqlite_schema_version ELSE NULL END
                AS sqlite_schema_version,
              typeof(sqlite_schema_version) AS sqlite_schema_version_type
       FROM ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE}
       LIMIT 2`,
    );
    const receipt = receipts[0];
    const schemaVersions = yield* sql.unsafe<{readonly schema_version: unknown}>('PRAGMA schema_version');
    const schemaVersion = schemaVersions[0]?.schema_version;
    const receiptSchemaVersion = receipt?.sqlite_schema_version;
    const expectedSchemaVersion =
      typeof receiptSchemaVersion === 'number' && Number.isSafeInteger(receiptSchemaVersion)
        ? cookieTransition === 'same'
          ? receiptSchemaVersion
          : nextCodeGraphSqliteSchemaVersion(receiptSchemaVersion)
        : undefined;
    return (
      receipts.length === 1 &&
      receipt?.singleton_type === 'integer' &&
      receipt?.singleton === 1 &&
      receipt.contract_revision_type === 'integer' &&
      receipt.contract_revision === CODE_GRAPH_SCHEMA_INITIALIZATION_CITATION_PREDECESSOR_CONTRACT_REVISION &&
      receipt.core_schema_version_type === 'integer' &&
      receipt.core_schema_version === CODE_GRAPH_SCHEMA_VERSION &&
      receipt.persistent_extension_revision_type === 'integer' &&
      // The raw-content citation alias was introduced by revision 16. Its
      // interruption receipt is therefore permanently bound to revision 15,
      // even after later additive extension revisions are introduced.
      receipt.persistent_extension_revision === CODE_GRAPH_PERSISTENT_SCHEMA_CITATION_PREDECESSOR.value &&
      receipt.sqlite_schema_version_type === 'integer' &&
      typeof receiptSchemaVersion === 'number' &&
      Number.isSafeInteger(receiptSchemaVersion) &&
      receiptSchemaVersion >= CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM &&
      receiptSchemaVersion <= CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM &&
      typeof schemaVersion === 'number' &&
      Number.isSafeInteger(schemaVersion) &&
      schemaVersion === expectedSchemaVersion
    );
  },
);

const snapshotFileSchemaObjectsExact = Effect.fn('codeGraph.snapshotFileSchemaObjectsExact')(function* (
  sql: SqlClient.SqlClient,
) {
  const indexes = yield* sql.unsafe<{
    readonly name: unknown;
    readonly origin: unknown;
    readonly partial: unknown;
    readonly unique: unknown;
  }>(
    `SELECT name, origin, partial, "unique" AS "unique"
     FROM pragma_index_list('snapshot_files')
     LIMIT 5`,
  );
  const expected = new Map<string, {readonly origin: string; readonly partial: number; readonly unique: number}>([
    ['sqlite_autoindex_snapshot_files_1', {origin: 'pk', partial: 0, unique: 1}],
    [CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX.name, {origin: 'c', partial: 0, unique: 0}],
    [CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX.name, {origin: 'c', partial: 0, unique: 0}],
    [CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX.name, {origin: 'c', partial: 1, unique: 0}],
  ]);
  if (
    indexes.length >= 5 ||
    indexes.some(index => {
      if (typeof index.name !== 'string') return true;
      const contract = expected.get(index.name);
      return (
        contract === undefined ||
        index.origin !== contract.origin ||
        index.partial !== contract.partial ||
        index.unique !== contract.unique
      );
    }) ||
    !indexes.some(index => index.name === 'sqlite_autoindex_snapshot_files_1')
  ) {
    return false;
  }
  const triggers = yield* sql.unsafe(
    `SELECT 1
     FROM sqlite_master
     WHERE type = 'trigger' AND tbl_name = 'snapshot_files' COLLATE NOCASE
     LIMIT 1`,
  );
  return triggers.length === 0;
});

export const inspectCodeGraphSnapshotFileCitationSchema = Effect.fn('codeGraph.inspectSnapshotFileCitationSchema')(
  function* (sql: SqlClient.SqlClient) {
    const tables = yield* sql.unsafe<{
      readonly bounded_sql: unknown;
      readonly name: unknown;
      readonly sql_bytes: unknown;
      readonly type: unknown;
    }>(
      `SELECT name, type,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 4096 THEN sql
              ELSE NULL
            END AS bounded_sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
       FROM sqlite_master
       WHERE name = 'snapshot_files' COLLATE NOCASE
       LIMIT 2`,
    );
    if (tables.length === 0) {
      return (yield* snapshotAuthorityState(sql)) === 'absent'
        ? citationSchemaInspection('missing', 'table-absent')
        : citationSchemaInspection('incompatible', 'incompatible');
    }
    const table = tables[0];
    if (
      tables.length !== 1 ||
      table?.name !== 'snapshot_files' ||
      table.type !== 'table' ||
      typeof table.sql_bytes !== 'number' ||
      !Number.isSafeInteger(table.sql_bytes) ||
      table.sql_bytes > 4096 ||
      typeof table.bounded_sql !== 'string'
    ) {
      return citationSchemaInspection('incompatible', 'incompatible');
    }
    const normalizedTable = normalizeSchemaDefinition(table.bounded_sql);
    const releasedTable = normalizedTable === normalizeSchemaDefinition(CODE_GRAPH_SNAPSHOT_FILES_RELEASED_TABLE_SQL);
    const currentTable = [
      CODE_GRAPH_SNAPSHOT_FILES_CURRENT_TABLE_SQL,
      CODE_GRAPH_SNAPSHOT_FILES_MIGRATED_TABLE_SQL,
    ].some(definition => normalizedTable === normalizeSchemaDefinition(definition));
    if (!releasedTable && !currentTable) return citationSchemaInspection('incompatible', 'incompatible');

    const columns = yield* sql.unsafe<{
      readonly dflt_value: unknown;
      readonly hidden: unknown;
      readonly name: unknown;
      readonly notnull: unknown;
      readonly pk: unknown;
      readonly type: unknown;
    }>(
      `SELECT name, type, "notnull" AS "notnull", dflt_value, pk, hidden
       FROM pragma_table_xinfo('snapshot_files')
       WHERE name = 'raw_content_hash' COLLATE NOCASE
       LIMIT 2`,
    );
    const column = columns[0];
    const columnCurrent =
      columns.length === 1 &&
      column?.name === 'raw_content_hash' &&
      column.type === 'TEXT' &&
      column.notnull === 0 &&
      column.dflt_value === null &&
      column.pk === 0 &&
      column.hidden === 0;
    if ((releasedTable && columns.length !== 0) || (currentTable && !columnCurrent)) {
      return citationSchemaInspection('incompatible', 'incompatible');
    }

    const baseIndexes = yield* Effect.all(
      [
        codeGraphCacheReferenceIndexState(sql, CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX),
        codeGraphCacheReferenceIndexState(sql, CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX),
      ],
      {concurrency: 1},
    );
    const rawIndex = yield* codeGraphCacheReferenceIndexState(
      sql,
      CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX,
    );
    const authorityState = yield* snapshotAuthorityState(sql, true);
    if (authorityState === 'incompatible') return citationSchemaInspection('incompatible', 'incompatible');
    const releasedAuthorityState = releasedTable && authorityState === 'present';
    const aliasState = releasedTable
      ? rawIndex === 'missing'
        ? releasedAuthorityState
          ? (yield* predecessorInitializationReceiptPresent(sql, 'same'))
            ? ('released-absent-with-predecessor-authority' as const)
            : ('released-absent-with-authority' as const)
          : ('released-absent' as const)
        : ('incompatible' as const)
      : rawIndex === 'missing'
        ? authorityState === 'present'
          ? (yield* predecessorInitializationReceiptPresent(sql, 'next'))
            ? ('column-only-with-predecessor-authority' as const)
            : ('column-only-with-authority' as const)
          : ('column-only' as const)
        : rawIndex === 'ready'
          ? ('current' as const)
          : ('incompatible' as const);
    if (aliasState === 'incompatible' || !(yield* snapshotFileSchemaObjectsExact(sql))) {
      return citationSchemaInspection('incompatible', 'incompatible');
    }
    return citationSchemaInspection(
      baseIndexes.some(state => state === 'incompatible')
        ? 'incompatible'
        : baseIndexes.some(state => state === 'missing')
          ? authorityState === 'present'
            ? 'incompatible'
            : 'missing'
          : 'current',
      aliasState,
    );
  },
);

export const codeGraphSnapshotFileCitationSchemaState = Effect.fn('codeGraph.snapshotFileCitationSchemaState')(
  function* (sql: SqlClient.SqlClient) {
    return (yield* inspectCodeGraphSnapshotFileCitationSchema(sql)).state;
  },
);

export const prepareCodeGraphSnapshotFileCitationSchema = Effect.fn('codeGraph.prepareSnapshotFileCitationSchema')(
  function* (sql: SqlClient.SqlClient, revision: number | undefined) {
    const inspection = yield* inspectCodeGraphSnapshotFileCitationSchema(sql);
    const authoritySensitive =
      inspection.state === 'released-absent-with-authority' ||
      inspection.state === 'released-absent-with-predecessor-authority' ||
      inspection.state === 'column-only-with-authority' ||
      inspection.state === 'column-only-with-predecessor-authority';
    if (
      inspection.state === 'incompatible' ||
      inspection.state === 'table-absent' ||
      inspection.baseIndexes === 'incompatible' ||
      (authoritySensitive &&
        !codeGraphSnapshotFileCitationSchemaMigrationAdmitted(revision, inspection.state, inspection.baseIndexes))
    ) {
      return {state: 'incompatible'} as const;
    }
    if (inspection.baseIndexes !== 'missing') {
      return {citationSchema: inspection.state, state: 'ready'} as const;
    }
    for (const index of [
      CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX,
      CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX,
    ]) {
      const indexState = yield* codeGraphCacheReferenceIndexState(sql, index);
      if (indexState === 'incompatible') return {state: 'incompatible'} as const;
      if (indexState !== 'missing') continue;
      yield* sql.unsafe(index.definition);
      if ((yield* codeGraphCacheReferenceIndexState(sql, index)) !== 'ready') {
        return yield* CodeGraphStoreError.of('Code graph snapshot file citation index changed during setup.');
      }
      return {index: index.name, state: 'prepared'} as const;
    }
    return yield* CodeGraphStoreError.of('Code graph snapshot file citation schema changed during setup.');
  },
);

export const assertCodeGraphSnapshotFileCitationSchemaMigratable = Effect.fn(
  'codeGraph.assertSnapshotFileCitationSchemaMigratable',
)(function* (sql: SqlClient.SqlClient) {
  const inspection = yield* inspectCodeGraphSnapshotFileCitationSchema(sql);
  if (inspection.state === 'incompatible' || inspection.baseIndexes === 'incompatible') {
    return yield* CodeGraphStoreError.of('Code graph snapshot file citation schema is incompatible.');
  }
  const revisionObservation = yield* inspectBoundedSchemaMetadataValue(sql, 'persistent_extension_schema_revision', 16);
  const revisionValue = revisionObservation.state === 'recorded' ? revisionObservation.value : undefined;
  const revision =
    typeof revisionValue === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(revisionValue) ? Number(revisionValue) : undefined;
  const authoritySensitive =
    inspection.state === 'released-absent-with-authority' ||
    inspection.state === 'released-absent-with-predecessor-authority' ||
    inspection.state === 'column-only-with-authority' ||
    inspection.state === 'column-only-with-predecessor-authority';
  if (
    authoritySensitive &&
    !codeGraphSnapshotFileCitationSchemaMigrationAdmitted(revision, inspection.state, inspection.baseIndexes)
  ) {
    return yield* CodeGraphStoreError.of('Code graph snapshot file citation schema is incompatible.');
  }
  return {
    allowColumnAuthority: inspection.state === 'column-only-with-predecessor-authority',
    allowReleasedAuthority:
      inspection.state === 'released-absent-with-authority' ||
      inspection.state === 'released-absent-with-predecessor-authority',
  } satisfies CodeGraphSnapshotFileCitationSchemaAuthorization;
});

export const ensureCodeGraphSnapshotFileCitationSchema = Effect.fn('codeGraph.ensureSnapshotFileCitationSchema')(
  function* (sql: SqlClient.SqlClient, authorization: CodeGraphSnapshotFileCitationSchemaAuthorization) {
    const before = yield* inspectCodeGraphSnapshotFileCitationSchema(sql);
    const columnAuthority =
      before.state === 'column-only-with-authority' || before.state === 'column-only-with-predecessor-authority';
    const releasedAuthority =
      before.state === 'released-absent-with-authority' ||
      before.state === 'released-absent-with-predecessor-authority';
    if (
      before.state === 'incompatible' ||
      before.baseIndexes === 'incompatible' ||
      (columnAuthority && !authorization.allowColumnAuthority) ||
      (releasedAuthority && !authorization.allowReleasedAuthority)
    ) {
      return yield* CodeGraphStoreError.of('Code graph snapshot file citation schema is incompatible.');
    }
    yield* sql.unsafe(
      CODE_GRAPH_SNAPSHOT_FILES_CURRENT_TABLE_SQL.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'),
    );
    for (const index of [
      CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX,
      CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX,
    ]) {
      yield* sql.unsafe(index.definition.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS'));
    }
    const alias = before.state === 'table-absent' ? 'column-only' : before.state;
    if (
      alias === 'released-absent' ||
      alias === 'released-absent-with-authority' ||
      alias === 'released-absent-with-predecessor-authority'
    ) {
      yield* sql.unsafe('ALTER TABLE snapshot_files ADD COLUMN raw_content_hash TEXT');
    }
    if (alias !== 'current') yield* sql.unsafe(CODE_GRAPH_RAW_CONTENT_ALIAS_INDEX_SQL);
    const after = yield* inspectCodeGraphSnapshotFileCitationSchema(sql);
    if (after.state !== 'current' || after.baseIndexes !== 'current') {
      return yield* CodeGraphStoreError.of('Code graph snapshot file citation schema is unavailable.');
    }
  },
);
