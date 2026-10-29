import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import * as SqlError from 'effect/sql/SqlError';
import {compareCodeUnits} from '../../ordering.js';
import {
  PERSISTENT_EXTENSION_TABLES,
  type PersistentExtensionTableContract,
  type PersistentExtensionTableInspection,
  type SqliteForeignKeyRow,
  type SqliteIndexInfoRow,
  type SqliteIndexListRow,
  type SqliteTableColumnRow,
} from './contracts.js';
import {CodeGraphStoreError} from '../../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function persistentExtensionTableInspection(
  sql: SqlClient.SqlClient,
  contract: PersistentExtensionTableContract,
): Effect.Effect<PersistentExtensionTableInspection, SqlError.SqlError> {
  return Effect.gen(function* () {
    const definitions = yield* sql<{readonly sql: string}>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${contract.name} LIMIT 1
    `;
    const definition = definitions[0]?.sql;
    if (definition === undefined) {
      return {compatible: false, exists: false, group: contract.group, name: contract.name};
    }
    const columns = yield* sql.unsafe<SqliteTableColumnRow>(`PRAGMA table_info("${contract.name}")`);
    const foreignKeys = yield* sql.unsafe<SqliteForeignKeyRow>(`PRAGMA foreign_key_list("${contract.name}")`);
    const indexes =
      contract.uniqueKeys === undefined
        ? []
        : yield* sql.unsafe<SqliteIndexListRow>(`PRAGMA index_list("${contract.name}")`);
    const compatibleColumns =
      columns.length === contract.columns.length &&
      EffectArray.every(columns, (column, index) => {
        const expected = contract.columns[index];
        return (
          expected !== undefined &&
          Number(column.cid) === index &&
          column.name === expected.name &&
          Effect2.pipe(column.type, EffectString.toUpperCase) === expected.type &&
          Number(column.notnull) === Number(expected.notNull) &&
          Number(column.pk) === expected.primaryKeyPosition &&
          column.dflt_value == null
        );
      });
    const expectedForeignKeys = contract.foreignKeys ?? [
      {from: 'snapshot_id', onDelete: 'CASCADE', table: 'snapshots', to: 'id'},
    ];
    const actualForeignKeys = EffectArray.map(foreignKeys, key => ({
      from: key.from,
      onDelete: Effect2.pipe(key.on_delete, EffectString.toUpperCase),
      table: key.table,
      to: key.to,
    })).sort(
      (left, right) =>
        compareCodeUnits(left.from, right.from) ||
        compareCodeUnits(left.table, right.table) ||
        compareCodeUnits(left.to, right.to),
    );
    const normalizedExpectedForeignKeys = EffectArray.map([...expectedForeignKeys], key => ({
      ...key,
      onDelete: Effect2.pipe(key.onDelete, EffectString.toUpperCase),
    })).sort(
      (left, right) =>
        compareCodeUnits(left.from, right.from) ||
        compareCodeUnits(left.table, right.table) ||
        compareCodeUnits(left.to, right.to),
    );
    const compatibleForeignKeys =
      actualForeignKeys.length === normalizedExpectedForeignKeys.length &&
      EffectArray.every(actualForeignKeys, (key, index) => {
        const expected = normalizedExpectedForeignKeys[index];
        return (
          expected !== undefined &&
          key.from === expected.from &&
          key.table === expected.table &&
          key.to === expected.to &&
          key.onDelete === expected.onDelete
        );
      });
    const actualUniqueKeys: (readonly string[])[] = [];
    for (const index of indexes) {
      if (Number(index.unique) !== 1 || Number(index.partial) !== 0) continue;
      const escapedIndexName = Effect2.pipe(index.name, EffectString.replaceAll('"', '""'));
      const indexedColumns = yield* sql.unsafe<SqliteIndexInfoRow>(`PRAGMA index_info("${escapedIndexName}")`);
      actualUniqueKeys.push(
        EffectArray.map(
          [...indexedColumns].sort((left, right) => Number(left.seqno) - Number(right.seqno)),
          column => column.name,
        ),
      );
    }
    const compatibleUniqueKeys = EffectArray.every(contract.uniqueKeys ?? [], expected =>
      EffectArray.some(
        actualUniqueKeys,
        actual =>
          actual.length === expected.length && EffectArray.every(actual, (column, index) => column === expected[index]),
      ),
    );
    const compatibleDefinition = EffectArray.every(contract.requiredDefinitionPatterns ?? [], pattern =>
      pattern.test(definition),
    );
    const expectsWithoutRowid = contract.withoutRowid ?? true;
    return {
      compatible:
        compatibleColumns &&
        compatibleForeignKeys &&
        compatibleUniqueKeys &&
        compatibleDefinition &&
        /\bWITHOUT\s+ROWID\b/i.test(definition) === expectsWithoutRowid,
      exists: true,
      group: contract.group,
      name: contract.name,
    };
  });
}

export const inspectPersistentExtensionTables = Effect.fn('codeGraph.inspectPersistentExtensionTables')(function* (
  sql: SqlClient.SqlClient,
) {
  return yield* Effect.forEach(PERSISTENT_EXTENSION_TABLES, contract =>
    persistentExtensionTableInspection(sql, contract),
  );
});

export const codeGraphPersistentExtensionSchemaCompatible = Effect.fn('codeGraph.persistentExtensionSchemaCompatible')(
  function* (sql: SqlClient.SqlClient) {
    const inspections = yield* inspectPersistentExtensionTables(sql);
    return EffectArray.every(inspections, inspection => inspection.exists && inspection.compatible);
  },
);

export const validatePersistentExtensionTables = Effect.fn('codeGraph.validatePersistentExtensionTables')(function* (
  sql: SqlClient.SqlClient,
) {
  const inspections = yield* inspectPersistentExtensionTables(sql);
  const incompatible = EffectArray.filter(inspections, inspection => !inspection.exists || !inspection.compatible);
  if (incompatible.length > 0) {
    return yield* CodeGraphStoreError.of(
      `Code graph persistent extension schema is incompatible: ${EffectArray.join(
        EffectArray.map(incompatible, table => table.name),
        ', ',
      )}.`,
    );
  }
});
