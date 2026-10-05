import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY,
  REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY,
} from '../removed/view_schema_contracts.js';
import {normalizeSchemaDefinition} from './normalization.js';
import {
  REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
  inspectBoundedSchemaMetadataRowCount,
  inspectBoundedSchemaMetadataValue,
} from './metadata.js';
import {tableExists} from '../session.js';
import {CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES, CODE_GRAPH_SCOPE_CURSOR_PATTERN} from '../scope/cursor.js';
import {
  CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION,
  CODE_GRAPH_SCHEMA_INITIALIZATION_CURRENT_CONTRACT_REVISION,
  CODE_GRAPH_SQLITE_SCHEMA_COOKIE,
  codeGraphPersistentSchemaIsCurrent,
} from './revision.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CODE_GRAPH_SCHEMA_VERSION, CodeGraphStoreError} from '../../types.js';

// Bump when the full initializer gains a required invariant that is not
// already represented by a main-schema DDL change or one of the exact mutable
// metadata observations below.
export const CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION =
  CODE_GRAPH_SCHEMA_INITIALIZATION_CURRENT_CONTRACT_REVISION;
export const CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE = 'schema_initialization_receipt';
// SQLite stores the schema cookie as a signed 32-bit database-header integer.
export const CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM = CODE_GRAPH_SQLITE_SCHEMA_COOKIE.maximum;
export const CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM = CODE_GRAPH_SQLITE_SCHEMA_COOKIE.minimum;

/** @internal SQLite advances the signed 32-bit schema cookie with wraparound. */
export function nextCodeGraphSqliteSchemaVersion(schemaVersion: number): number {
  return schemaVersion === CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM
    ? CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM
    : schemaVersion + 1;
}

export const CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE} (
    singleton INTEGER NOT NULL CHECK (singleton = 1),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    core_schema_version INTEGER NOT NULL CHECK (core_schema_version >= 0),
    persistent_extension_revision INTEGER NOT NULL CHECK (persistent_extension_revision >= 0),
    sqlite_schema_version INTEGER NOT NULL CHECK (
      sqlite_schema_version BETWEEN ${CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM}
        AND ${CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM}
    ),
    PRIMARY KEY (singleton)
  ) WITHOUT ROWID
`;

export interface CodeGraphSchemaInitializationReceiptObservation {
  readonly metadataCoreSchemaVersion: number;
  readonly metadataMinimumExtractorGeneration: number;
  readonly metadataPersistentExtensionRevision: number;
  readonly metadataRemovedViewCleanupCursorCurrent: boolean;
  readonly metadataRemovedViewCleanupCursorRecorded: boolean;
  readonly metadataRemovedViewCleanupEpochCurrent: boolean;
  readonly metadataRowCount: number;
  readonly observedSqliteSchemaVersion: number;
  readonly receiptContractRevision: number;
  readonly receiptCoreSchemaVersion: number;
  readonly receiptPersistentExtensionRevision: number;
  readonly receiptSqliteSchemaVersion: number;
}

/** @internal Exact pure admission used by the persistent fast-path property. */
export function currentCodeGraphSchemaInitializationReceipt(
  observation: CodeGraphSchemaInitializationReceiptObservation,
): boolean {
  return (
    Number.isSafeInteger(observation.observedSqliteSchemaVersion) &&
    observation.observedSqliteSchemaVersion >= CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM &&
    observation.observedSqliteSchemaVersion <= CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM &&
    observation.receiptContractRevision === CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION &&
    observation.receiptCoreSchemaVersion === CODE_GRAPH_SCHEMA_VERSION &&
    codeGraphPersistentSchemaIsCurrent(observation.receiptPersistentExtensionRevision) &&
    observation.receiptSqliteSchemaVersion === observation.observedSqliteSchemaVersion &&
    observation.metadataCoreSchemaVersion === CODE_GRAPH_SCHEMA_VERSION &&
    codeGraphPersistentSchemaIsCurrent(observation.metadataPersistentExtensionRevision) &&
    Number.isSafeInteger(observation.metadataMinimumExtractorGeneration) &&
    observation.metadataMinimumExtractorGeneration >= CODE_GRAPH_EXTRACTOR_GENERATION &&
    observation.metadataRemovedViewCleanupEpochCurrent &&
    observation.metadataRemovedViewCleanupCursorCurrent &&
    Number.isSafeInteger(observation.metadataRowCount) &&
    observation.metadataRowCount >= 0 &&
    observation.metadataRowCount <=
      (observation.metadataRemovedViewCleanupCursorRecorded
        ? REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS
        : REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - 1)
  );
}

/**
 * Admits a previously validated schema without replaying every no-op DDL and
 * migration inspection. Ordinary main-schema DDL and VACUUM advance SQLite's
 * persistent schema cookie; authority metadata is checked separately because
 * DML does not.
 */
export const codeGraphSchemaInitializationReceiptCurrent = Effect.fn('codeGraph.schemaInitializationReceiptCurrent')(
  function* (sql: SqlClient.SqlClient) {
    const definitions = yield* schemaInitializationReceiptDefinitions(sql);
    if (definitions.length > 0 && !schemaInitializationReceiptDefinitionCurrent(definitions)) {
      return yield* CodeGraphStoreError.of('Code graph schema initialization receipt is incompatible.');
    }
    if (definitions.length === 0 || !(yield* tableExists(sql, 'schema_metadata'))) return false;
    const receiptRows = yield* sql.unsafe<{
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
      `SELECT
       CASE WHEN typeof(singleton) = 'integer' THEN singleton ELSE NULL END AS singleton,
       CASE WHEN typeof(contract_revision) = 'integer' THEN contract_revision ELSE NULL END AS contract_revision,
       CASE WHEN typeof(core_schema_version) = 'integer' THEN core_schema_version ELSE NULL END AS core_schema_version,
       CASE
         WHEN typeof(persistent_extension_revision) = 'integer' THEN persistent_extension_revision
         ELSE NULL
       END AS persistent_extension_revision,
       CASE
         WHEN typeof(sqlite_schema_version) = 'integer' THEN sqlite_schema_version
         ELSE NULL
       END AS sqlite_schema_version,
       typeof(singleton) AS singleton_type,
       typeof(contract_revision) AS contract_revision_type,
       typeof(core_schema_version) AS core_schema_version_type,
       typeof(persistent_extension_revision) AS persistent_extension_revision_type,
       typeof(sqlite_schema_version) AS sqlite_schema_version_type
     FROM ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE}
     LIMIT 2`,
    );
    const receipt = receiptRows[0];
    if (
      receiptRows.length !== 1 ||
      receipt?.singleton_type !== 'integer' ||
      Number(receipt.singleton) !== 1 ||
      receipt.contract_revision_type !== 'integer' ||
      receipt.core_schema_version_type !== 'integer' ||
      receipt.persistent_extension_revision_type !== 'integer' ||
      receipt.sqlite_schema_version_type !== 'integer'
    ) {
      return false;
    }
    const metadataRowCount = yield* inspectBoundedSchemaMetadataRowCount(sql);
    if (metadataRowCount === undefined || metadataRowCount > REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS) {
      return false;
    }
    const coreSchemaVersion = yield* exactMetadataInteger(sql, 'schema_version');
    const persistentExtensionRevision = yield* exactMetadataInteger(sql, 'persistent_extension_schema_revision');
    const minimumExtractorGeneration = yield* exactMetadataInteger(sql, 'minimum_extractor_generation');
    const cleanupMetadata = yield* currentMutableCleanupMetadata(sql);
    if (
      coreSchemaVersion === undefined ||
      persistentExtensionRevision === undefined ||
      minimumExtractorGeneration === undefined
    ) {
      return false;
    }
    const sqliteSchemaVersion = yield* mainSchemaVersion(sql);
    return currentCodeGraphSchemaInitializationReceipt({
      metadataCoreSchemaVersion: coreSchemaVersion,
      metadataMinimumExtractorGeneration: minimumExtractorGeneration,
      metadataPersistentExtensionRevision: persistentExtensionRevision,
      metadataRemovedViewCleanupCursorCurrent: cleanupMetadata.cursorCurrent,
      metadataRemovedViewCleanupCursorRecorded: cleanupMetadata.cursorRecorded,
      metadataRemovedViewCleanupEpochCurrent: cleanupMetadata.epochCurrent,
      metadataRowCount,
      observedSqliteSchemaVersion: sqliteSchemaVersion,
      receiptContractRevision: Number(receipt.contract_revision),
      receiptCoreSchemaVersion: Number(receipt.core_schema_version),
      receiptPersistentExtensionRevision: Number(receipt.persistent_extension_revision),
      receiptSqliteSchemaVersion: Number(receipt.sqlite_schema_version),
    });
  },
);

/** Records only after the full initializer has validated and repaired every contract. */
export const recordCodeGraphSchemaInitializationReceipt = Effect.fn('codeGraph.recordSchemaInitializationReceipt')(
  function* (sql: SqlClient.SqlClient) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* schemaInitializationReceiptDefinitions(sql);
        if (existing.length > 0 && !schemaInitializationReceiptDefinitionCurrent(existing)) {
          return yield* CodeGraphStoreError.of('Code graph schema initialization receipt is incompatible.');
        }
        yield* sql.unsafe(CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE_SQL);
        const sqliteSchemaVersion = yield* mainSchemaVersion(sql);
        yield* sql.unsafe(
          `INSERT INTO ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE} (
           singleton, contract_revision, core_schema_version,
           persistent_extension_revision, sqlite_schema_version
         ) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           contract_revision = excluded.contract_revision,
           core_schema_version = excluded.core_schema_version,
           persistent_extension_revision = excluded.persistent_extension_revision,
           sqlite_schema_version = excluded.sqlite_schema_version`,
          [
            CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION,
            CODE_GRAPH_SCHEMA_VERSION,
            CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION,
            sqliteSchemaVersion,
          ],
        );
        if (!(yield* codeGraphSchemaInitializationReceiptCurrent(sql))) {
          return yield* CodeGraphStoreError.of('Code graph schema initialization receipt is invalid.');
        }
      }),
    );
  },
);

function schemaInitializationReceiptDefinitions(sql: SqlClient.SqlClient) {
  return sql.unsafe<{readonly name: unknown; readonly sql: unknown; readonly type: unknown}>(
    `SELECT
       CASE
         WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= ? THEN name
         ELSE NULL
       END AS name,
       type,
       CASE
         WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 2048 THEN sql
         ELSE NULL
       END AS sql
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT 2`,
    [CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE.length, CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE],
  );
}

function schemaInitializationReceiptDefinitionCurrent(
  rows: readonly {readonly name: unknown; readonly sql: unknown; readonly type: unknown}[],
): boolean {
  return (
    rows.length === 1 &&
    rows[0]?.name === CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE &&
    rows[0]?.type === 'table' &&
    typeof rows[0]?.sql === 'string' &&
    normalizeSchemaDefinition(rows[0].sql) ===
      normalizeSchemaDefinition(CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE_SQL)
  );
}

const mainSchemaVersion = Effect.fn('codeGraph.mainSchemaVersion')(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql.unsafe<{readonly schema_version: unknown}>('PRAGMA main.schema_version');
  const value = Number(rows[0]?.schema_version);
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(value) ||
    value < CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM ||
    value > CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM
  ) {
    return yield* CodeGraphStoreError.of('Code graph SQLite schema version is invalid.');
  }
  return value;
});

function exactMetadataInteger(sql: SqlClient.SqlClient, key: string) {
  return inspectBoundedSchemaMetadataValue(sql, key, 16).pipe(
    Effect.map(value => {
      if (value.state !== 'recorded' || !/^(?:0|[1-9][0-9]{0,14})$/u.test(value.value)) return undefined;
      const parsed = Number(value.value);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }),
  );
}

const currentMutableCleanupMetadata = Effect.fn('codeGraph.currentMutableCleanupMetadata')(function* (
  sql: SqlClient.SqlClient,
) {
  const epoch = yield* inspectBoundedSchemaMetadataValue(sql, REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY, 16);
  const cursor = yield* inspectBoundedSchemaMetadataValue(
    sql,
    REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY,
    CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES,
  );
  return {
    cursorCurrent:
      cursor.state === 'missing' || (cursor.state === 'recorded' && CODE_GRAPH_SCOPE_CURSOR_PATTERN.test(cursor.value)),
    cursorRecorded: cursor.state === 'recorded',
    epochCurrent:
      epoch.state === 'recorded' &&
      /^(?:0|[1-9][0-9]*)$/u.test(epoch.value) &&
      Number.isSafeInteger(Number(epoch.value)),
  } as const;
});
