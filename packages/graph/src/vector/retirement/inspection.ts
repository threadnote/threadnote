import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Effect, Layer} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
  CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL,
  CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS,
  CODE_GRAPH_VECTOR_REUSE_INDEX_SQL,
  CODE_GRAPH_VECTORS_TABLE_SQL,
  CodeGraphVectorRetirementError,
  MAXIMUM_SAFE_INTEGER_SQL,
  VECTOR_CORE_TABLE_NAMES,
  VECTOR_GENERATION_BYTES,
  VECTOR_RETIREMENT_TABLE_NAMES,
  VECTOR_RETIREMENT_TRIGGER_SQL_BYTES,
  VECTOR_SNAPSHOT_BYTES,
  sqliteStringLiteral,
} from './schema.js';

export interface CodeGraphVectorRetirementMarker {
  readonly deleteAuthorized: boolean;
  readonly generation: string;
  readonly pageRevision: number;
  readonly retiredByWorktreeId?: string;
  readonly retirementId: number;
  readonly snapshotId: string;
}

export interface CodeGraphVectorPageStorage {
  readonly freelistBytes: number;
  readonly journalMode: 'delete' | 'wal';
  readonly pageSize: number;
  readonly walAutoCheckpointPages: number;
}

/** @internal Frozen manifest for the released-v2 pointer-index bridge. */
export interface LegacyPointerIndexPlan {
  readonly finalFactBytes: number;
  readonly rows: readonly {readonly generation: string; readonly worktreeId: string}[];
  readonly storage: CodeGraphVectorPageStorage;
}

export function codeGraphVectorRetirementLegacyPointerProbeStatement() {
  return {
    parameters: [CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_ROWS + 1] as const,
    text: `SELECT
       CASE
         WHEN typeof(worktree_id) = 'text'
          AND length(CAST(worktree_id AS BLOB)) = 64
          AND worktree_id NOT GLOB '*[^0-9a-f]*'
         THEN worktree_id ELSE NULL
       END AS worktree_id,
       CASE
         WHEN typeof(generation) = 'text'
          AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
          AND instr(generation, char(0)) = 0
         THEN generation ELSE NULL
       END AS generation,
       length(CAST(worktree_id AS BLOB)) + length(CAST(generation AS BLOB)) AS identity_bytes
     FROM vector_pointers
     ORDER BY vector_pointers.worktree_id
     LIMIT ?`,
  };
}

export interface ExpectedVectorIndexColumn {
  readonly cid: number;
  readonly coll: 'BINARY';
  readonly desc: 0;
  readonly key: 0 | 1;
  readonly name: string | null;
}

export interface ExpectedVectorIndex {
  readonly columns: readonly ExpectedVectorIndexColumn[];
  readonly name: string;
  readonly origin: 'c' | 'pk' | 'u';
  readonly partial: 0 | 1;
  readonly unique: 0 | 1;
}

export interface ExpectedVectorForeignKey {
  readonly from: string;
  readonly id: number;
  readonly match: 'NONE';
  readonly onDelete: 'CASCADE' | 'NO ACTION';
  readonly onUpdate: 'NO ACTION';
  readonly seq: number;
  readonly table: string;
  readonly to: string;
}

export const rowIdPayload = {cid: -1, coll: 'BINARY', desc: 0, key: 0, name: null} as const;

export const VECTOR_GENERATION_INDEXES = [
  {
    columns: [{cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'generation'}, rowIdPayload],
    name: 'sqlite_autoindex_vector_generations_1',
    origin: 'pk',
    partial: 0,
    unique: 1,
  },
] as const satisfies readonly ExpectedVectorIndex[];

export const VECTOR_POINTER_PRIMARY_INDEX = {
  columns: [{cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'worktree_id'}, rowIdPayload],
  name: 'sqlite_autoindex_vector_pointers_1',
  origin: 'pk',
  partial: 0,
  unique: 1,
} as const satisfies ExpectedVectorIndex;

export const VECTOR_POINTER_INDEXES_WITHOUT_GENERATION = [VECTOR_POINTER_PRIMARY_INDEX] as const;
export const VECTOR_POINTER_INDEXES = [
  VECTOR_POINTER_PRIMARY_INDEX,
  {
    columns: [{cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'generation'}, rowIdPayload],
    name: 'vector_pointer_generation_lookup',
    origin: 'c',
    partial: 0,
    unique: 0,
  },
] as const satisfies readonly ExpectedVectorIndex[];

export const VECTOR_ROW_INDEXES = [
  {
    columns: [
      {cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'generation'},
      {cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'symbol_id'},
      {cid: 2, coll: 'BINARY', desc: 0, key: 0, name: 'fingerprint'},
      {cid: 3, coll: 'BINARY', desc: 0, key: 0, name: 'vector'},
    ],
    name: 'sqlite_autoindex_vectors_1',
    origin: 'pk',
    partial: 0,
    unique: 1,
  },
  {
    columns: [
      {cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'generation'},
      {cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'symbol_id'},
      {cid: 2, coll: 'BINARY', desc: 0, key: 1, name: 'fingerprint'},
    ],
    name: 'vector_reuse_lookup',
    origin: 'c',
    partial: 0,
    unique: 0,
  },
] as const satisfies readonly ExpectedVectorIndex[];

export const VECTOR_RETIREMENT_STATE_INDEXES = [
  {
    columns: [
      {cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'singleton'},
      {cid: 1, coll: 'BINARY', desc: 0, key: 0, name: 'admission_cursor'},
      {cid: 2, coll: 'BINARY', desc: 0, key: 0, name: 'generation_revision'},
      {cid: 3, coll: 'BINARY', desc: 0, key: 0, name: 'admission_scan_revision'},
      {cid: 4, coll: 'BINARY', desc: 0, key: 0, name: 'clean_generation_revision'},
      {cid: 5, coll: 'BINARY', desc: 0, key: 0, name: 'pointer_delete_worktree_id'},
      {cid: 6, coll: 'BINARY', desc: 0, key: 0, name: 'pointer_delete_generation'},
      {cid: 7, coll: 'BINARY', desc: 0, key: 0, name: 'pointer_delete_snapshot_id'},
    ],
    name: 'sqlite_autoindex_vector_retirement_state_1',
    origin: 'pk',
    partial: 0,
    unique: 1,
  },
] as const satisfies readonly ExpectedVectorIndex[];

export const VECTOR_RETIREMENT_MARKER_INDEXES = [
  {
    columns: [{cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'generation'}, rowIdPayload],
    name: 'sqlite_autoindex_vector_generation_retirements_1',
    origin: 'u',
    partial: 0,
    unique: 1,
  },
  {
    columns: [
      {cid: 3, coll: 'BINARY', desc: 0, key: 1, name: 'retired_by_worktree_id'},
      {cid: 2, coll: 'BINARY', desc: 0, key: 1, name: 'snapshot_id'},
      {cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'generation'},
      {cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'retirement_id'},
      rowIdPayload,
    ],
    name: 'vector_generation_retirement_association',
    origin: 'c',
    partial: 1,
    unique: 0,
  },
] as const satisfies readonly ExpectedVectorIndex[];

export const VECTOR_POINTER_FOREIGN_KEYS = [
  {
    from: 'generation',
    id: 0,
    match: 'NONE',
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION',
    seq: 0,
    table: 'vector_generations',
    to: 'generation',
  },
] as const satisfies readonly ExpectedVectorForeignKey[];

export const VECTOR_ROW_FOREIGN_KEYS = VECTOR_POINTER_FOREIGN_KEYS;

export const boundedVectorUserTableNames = Effect.fn('codeGraph.boundedVectorUserTableNames')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe<{readonly name: unknown}>(
    `SELECT CASE
       WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name ELSE NULL
     END AS name
     FROM sqlite_master
     WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
     LIMIT ?`,
    [VECTOR_CORE_TABLE_NAMES.length + VECTOR_RETIREMENT_TABLE_NAMES.length + 1],
  );
  if (rows.some(row => typeof row.name !== 'string')) return undefined;
  return rows.map(row => String(row.name));
});

export function sameStringSet(observed: readonly string[] | undefined, expected: readonly string[]): boolean {
  return (
    observed !== undefined &&
    observed.length === expected.length &&
    [...observed].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

export const exactVectorIndexSet = Effect.fn('codeGraph.exactVectorIndexSet')(function* (
  sql: SqlClient.SqlClient,
  tableName: string,
  expected: readonly ExpectedVectorIndex[],
) {
  const rows = yield* sql.unsafe<{
    readonly name: unknown;
    readonly origin: unknown;
    readonly partial: unknown;
    readonly unique_value: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name ELSE NULL END AS name,
       CASE WHEN origin IN ('c', 'pk', 'u') THEN origin ELSE NULL END AS origin,
       partial,
       "unique" AS unique_value
     FROM pragma_index_list(${sqliteStringLiteral(tableName)})
     LIMIT ?`,
    [expected.length + 1],
  );
  if (rows.length !== expected.length) return false;
  const byName = [...expected].sort((left, right) => left.name.localeCompare(right.name));
  const observed = [...rows].sort((left, right) => String(left.name).localeCompare(String(right.name)));
  for (let index = 0; index < byName.length; index += 1) {
    const definition = byName[index];
    const row = observed[index];
    if (
      row?.name !== definition.name ||
      row.origin !== definition.origin ||
      row.partial !== definition.partial ||
      row.unique_value !== definition.unique
    ) {
      return false;
    }
    const columns = yield* sql.unsafe<{
      readonly cid: unknown;
      readonly coll: unknown;
      readonly desc_value: unknown;
      readonly key_value: unknown;
      readonly name: unknown;
      readonly seqno: unknown;
    }>(
      `SELECT seqno, cid,
              CASE WHEN name IS NULL THEN NULL
                   WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name
                   ELSE 0 END AS name,
              "desc" AS desc_value,
              CASE WHEN coll = 'BINARY' THEN coll ELSE NULL END AS coll,
              "key" AS key_value
       FROM pragma_index_xinfo(${sqliteStringLiteral(definition.name)})
       LIMIT ?`,
      [definition.columns.length + 1],
    );
    if (
      columns.length !== definition.columns.length ||
      columns.some((column, columnIndex) => {
        const expectedColumn = definition.columns[columnIndex];
        return (
          column.seqno !== columnIndex ||
          column.cid !== expectedColumn?.cid ||
          column.name !== expectedColumn.name ||
          column.desc_value !== expectedColumn.desc ||
          column.coll !== expectedColumn.coll ||
          column.key_value !== expectedColumn.key
        );
      })
    ) {
      return false;
    }
  }
  return true;
});

export const exactVectorForeignKeys = Effect.fn('codeGraph.exactVectorForeignKeys')(function* (
  sql: SqlClient.SqlClient,
  tableName: string,
  expected: readonly ExpectedVectorForeignKey[],
) {
  const rows = yield* sql.unsafe<{
    readonly from_column: unknown;
    readonly id: unknown;
    readonly match_value: unknown;
    readonly on_delete: unknown;
    readonly on_update: unknown;
    readonly seq: unknown;
    readonly table_name: unknown;
    readonly to_column: unknown;
  }>(
    `SELECT id, seq,
            CASE WHEN typeof("table") = 'text' AND length(CAST("table" AS BLOB)) <= 128
                 THEN "table" ELSE NULL END AS table_name,
            CASE WHEN typeof("from") = 'text' AND length(CAST("from" AS BLOB)) <= 128
                 THEN "from" ELSE NULL END AS from_column,
            CASE WHEN typeof("to") = 'text' AND length(CAST("to" AS BLOB)) <= 128
                 THEN "to" ELSE NULL END AS to_column,
            on_update, on_delete, "match" AS match_value
     FROM pragma_foreign_key_list(${sqliteStringLiteral(tableName)})
     LIMIT ?`,
    [expected.length + 1],
  );
  return (
    rows.length === expected.length &&
    rows.every((row, index) => {
      const definition = expected[index];
      return (
        row.id === definition?.id &&
        row.seq === definition.seq &&
        row.table_name === definition.table &&
        row.from_column === definition.from &&
        row.to_column === definition.to &&
        row.on_update === definition.onUpdate &&
        row.on_delete === definition.onDelete &&
        row.match_value === definition.match
      );
    })
  );
});

export const codeGraphVectorCoreSchemaState = Effect.fn('codeGraph.vectorCoreSchemaState')(function* (
  sql: SqlClient.SqlClient,
) {
  const expected = [
    {name: 'vector_generations', sql: CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL, type: 'table'},
    {name: 'vector_pointers', sql: CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL, type: 'table'},
    {name: 'vectors', sql: CODE_GRAPH_VECTORS_TABLE_SQL, type: 'table'},
    {name: 'vector_reuse_lookup', sql: CODE_GRAPH_VECTOR_REUSE_INDEX_SQL, type: 'index'},
  ] as const;
  for (const object of expected) {
    const rows = yield* boundedSchemaObjects(sql, object.name, 2);
    if (
      rows.length !== 1 ||
      rows[0]?.name !== object.name ||
      rows[0]?.type !== object.type ||
      normalizeSchemaDefinition(String(rows[0]?.sql ?? '')) !== normalizeSchemaDefinition(object.sql)
    ) {
      return 'incompatible' as const;
    }
  }
  const userTables = yield* boundedVectorUserTableNames(sql);
  const allowedTables = new Set<string>([...VECTOR_CORE_TABLE_NAMES, ...VECTOR_RETIREMENT_TABLE_NAMES]);
  if (
    userTables === undefined ||
    VECTOR_CORE_TABLE_NAMES.some(name => !userTables.includes(name)) ||
    userTables.some(name => !allowedTables.has(name))
  ) {
    return 'incompatible' as const;
  }
  if (
    !(yield* exactVectorIndexSet(sql, 'vector_generations', VECTOR_GENERATION_INDEXES)) ||
    !(yield* exactVectorIndexSet(sql, 'vectors', VECTOR_ROW_INDEXES)) ||
    !(yield* exactVectorForeignKeys(sql, 'vector_generations', [])) ||
    !(yield* exactVectorForeignKeys(sql, 'vector_pointers', VECTOR_POINTER_FOREIGN_KEYS)) ||
    !(yield* exactVectorForeignKeys(sql, 'vectors', VECTOR_ROW_FOREIGN_KEYS))
  ) {
    return 'incompatible' as const;
  }
  const pointerIndexesReady = yield* exactVectorIndexSet(sql, 'vector_pointers', VECTOR_POINTER_INDEXES);
  const pointerIndexesLegacy = yield* exactVectorIndexSet(
    sql,
    'vector_pointers',
    VECTOR_POINTER_INDEXES_WITHOUT_GENERATION,
  );
  if (!pointerIndexesReady && !pointerIndexesLegacy) return 'incompatible' as const;
  const pointerIndex = yield* boundedSchemaObjects(sql, 'vector_pointer_generation_lookup', 2);
  if (pointerIndex.length === 0) {
    return pointerIndexesLegacy ? ('missing-pointer-index' as const) : ('incompatible' as const);
  }
  if (
    pointerIndex.length !== 1 ||
    pointerIndex[0]?.name !== 'vector_pointer_generation_lookup' ||
    pointerIndex[0]?.type !== 'index' ||
    normalizeSchemaDefinition(String(pointerIndex[0]?.sql ?? '')) !==
      normalizeSchemaDefinition(CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL)
  ) {
    return 'incompatible' as const;
  }
  return pointerIndexesReady ? ('ready' as const) : ('incompatible' as const);
});

export const codeGraphVectorCoreSchemaCurrent = Effect.fn('codeGraph.vectorCoreSchemaCurrent')(function* (
  sql: SqlClient.SqlClient,
) {
  return (yield* codeGraphVectorCoreSchemaState(sql)) === 'ready';
});

export const inspectLegacyPointerIndexPlan = Effect.fn('codeGraph.inspectLegacyVectorPointerIndexPlan')(function* (
  sql: SqlClient.SqlClient,
) {
  const statement = codeGraphVectorRetirementLegacyPointerProbeStatement();
  const observed = yield* sql.unsafe<{
    readonly generation: unknown;
    readonly identity_bytes: unknown;
    readonly worktree_id: unknown;
  }>(statement.text, statement.parameters);
  if (observed.length > CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_ROWS) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector pointer index exceeds its bounded migration limit.',
    });
  }
  let finalFactBytes = 0;
  const rows: Array<{readonly generation: string; readonly worktreeId: string}> = [];
  for (const row of observed) {
    if (
      typeof row.worktree_id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.worktree_id) ||
      typeof row.generation !== 'string' ||
      !validBoundedText(row.generation, VECTOR_GENERATION_BYTES) ||
      !Number.isSafeInteger(row.identity_bytes) ||
      Number(row.identity_bytes) <= 64
    ) {
      return yield* CodeGraphVectorRetirementError.make({
        message: 'Code graph vector pointer index manifest is invalid.',
      });
    }
    finalFactBytes += Number(row.identity_bytes);
    if (!Number.isSafeInteger(finalFactBytes) || finalFactBytes > CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_BYTES) {
      return yield* CodeGraphVectorRetirementError.make({
        message: 'Code graph vector pointer index exceeds its bounded byte limit.',
      });
    }
    rows.push({generation: row.generation, worktreeId: row.worktree_id});
  }
  return {finalFactBytes, rows, storage: yield* inspectVectorPageStorageSql(sql)} satisfies LegacyPointerIndexPlan;
});

export function sameLegacyPointerIndexPlan(left: LegacyPointerIndexPlan, right: LegacyPointerIndexPlan): boolean {
  return (
    left.finalFactBytes === right.finalFactBytes &&
    sameVectorPageStorage(left.storage, right.storage) &&
    left.rows.length === right.rows.length &&
    left.rows.every(
      (row, index) =>
        row.worktreeId === right.rows[index]?.worktreeId && row.generation === right.rows[index]?.generation,
    )
  );
}

export const codeGraphVectorRetirementSchemaState = Effect.fn('codeGraph.vectorRetirementSchemaState')(function* (
  sql: SqlClient.SqlClient,
) {
  const expected = [
    {name: 'vector_retirement_state', sql: CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL, type: 'table'},
    {name: 'vector_generation_retirements', sql: CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL, type: 'table'},
    {
      name: 'vector_generation_retirement_association',
      sql: CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL,
      type: 'index',
    },
    ...CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS.map(trigger => ({
      name: trigger.name,
      sql: trigger.sql,
      type: 'trigger' as const,
    })),
  ];
  const observed: Array<'absent' | 'current' | 'incompatible'> = [];
  for (const object of expected) {
    const rows = yield* boundedSchemaObjects(sql, object.name, 2);
    if (rows.length === 0) {
      observed.push('absent');
      continue;
    }
    observed.push(
      rows.length === 1 &&
        rows[0]?.name === object.name &&
        rows[0]?.type === object.type &&
        normalizeSchemaDefinition(String(rows[0]?.sql ?? '')) === normalizeSchemaDefinition(object.sql)
        ? 'current'
        : 'incompatible',
    );
  }
  const triggerRows = yield* sql.unsafe<{readonly name: unknown; readonly tbl_name: unknown}>(
    `SELECT
       CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name ELSE NULL END AS name,
       CASE WHEN typeof(tbl_name) = 'text' AND length(CAST(tbl_name AS BLOB)) <= 64 THEN tbl_name ELSE NULL END AS tbl_name
     FROM sqlite_master
     WHERE type = 'trigger'
       AND tbl_name COLLATE NOCASE IN (
         'vector_retirement_state',
         'vector_generation_retirements',
         'vector_generations',
         'vector_pointers',
         'vectors'
       )
     LIMIT ?`,
    [CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS.length + 1],
  );
  if (observed.every(state => state === 'absent')) {
    const userTables = yield* boundedVectorUserTableNames(sql);
    const sequenceTable = yield* boundedSchemaObjects(sql, 'sqlite_sequence', 2);
    return triggerRows.length === 0 && sequenceTable.length === 0 && sameStringSet(userTables, VECTOR_CORE_TABLE_NAMES)
      ? ('absent' as const)
      : ('incompatible' as const);
  }
  if (!observed.every(state => state === 'current')) return 'incompatible' as const;
  const userTables = yield* boundedVectorUserTableNames(sql);
  if (
    !sameStringSet(userTables, [...VECTOR_CORE_TABLE_NAMES, ...VECTOR_RETIREMENT_TABLE_NAMES]) ||
    !(yield* exactVectorIndexSet(sql, 'vector_retirement_state', VECTOR_RETIREMENT_STATE_INDEXES)) ||
    !(yield* exactVectorIndexSet(sql, 'vector_generation_retirements', VECTOR_RETIREMENT_MARKER_INDEXES)) ||
    !(yield* exactVectorForeignKeys(sql, 'vector_retirement_state', [])) ||
    !(yield* exactVectorForeignKeys(sql, 'vector_generation_retirements', []))
  ) {
    return 'incompatible' as const;
  }
  const expectedTriggerNames = [
    ...CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS.map(
      trigger => `${trigger.name}\0${vectorRetirementTriggerTarget(trigger.name)}`,
    ),
  ].sort();
  const observedTriggerNames = triggerRows
    .map(row =>
      typeof row.name === 'string' && typeof row.tbl_name === 'string' ? `${row.name}\0${row.tbl_name}` : '',
    )
    .sort();
  if (
    observedTriggerNames.length !== expectedTriggerNames.length ||
    observedTriggerNames.some((name, index) => name !== expectedTriggerNames[index])
  ) {
    return 'incompatible' as const;
  }
  const stateRows = yield* sql.unsafe<{
    readonly admission_cursor: unknown;
    readonly admission_scan_revision: unknown;
    readonly clean_generation_revision: unknown;
    readonly generation_revision: unknown;
    readonly pointer_delete_present: unknown;
    readonly singleton: unknown;
  }>(
    `SELECT singleton,
            CASE
              WHEN admission_cursor IS NULL THEN NULL
              WHEN typeof(admission_cursor) = 'text'
               AND length(CAST(admission_cursor AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
               AND instr(admission_cursor, char(0)) = 0
              THEN admission_cursor ELSE 0
            END AS admission_cursor,
            CASE
              WHEN typeof(generation_revision) = 'integer'
               AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
              THEN generation_revision ELSE NULL
            END AS generation_revision,
            CASE
              WHEN admission_scan_revision IS NULL THEN NULL
              WHEN typeof(admission_scan_revision) = 'integer'
               AND admission_scan_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
              THEN admission_scan_revision ELSE -1
            END AS admission_scan_revision,
            CASE
              WHEN clean_generation_revision IS NULL THEN NULL
              WHEN typeof(clean_generation_revision) = 'integer'
               AND clean_generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
              THEN clean_generation_revision ELSE -1
            END AS clean_generation_revision,
            CASE
              WHEN pointer_delete_worktree_id IS NULL
               AND pointer_delete_generation IS NULL
               AND pointer_delete_snapshot_id IS NULL
              THEN 0 ELSE 1
            END AS pointer_delete_present
     FROM vector_retirement_state LIMIT 2`,
  );
  if (
    stateRows.length !== 1 ||
    stateRows[0]?.singleton !== 1 ||
    !Number.isSafeInteger(stateRows[0]?.generation_revision) ||
    Number(stateRows[0]?.generation_revision) < 0 ||
    (stateRows[0]?.admission_scan_revision !== null &&
      (!Number.isSafeInteger(stateRows[0]?.admission_scan_revision) ||
        Number(stateRows[0]?.admission_scan_revision) < 0 ||
        Number(stateRows[0]?.admission_scan_revision) > Number(stateRows[0]?.generation_revision))) ||
    (stateRows[0]?.clean_generation_revision !== null &&
      (!Number.isSafeInteger(stateRows[0]?.clean_generation_revision) ||
        Number(stateRows[0]?.clean_generation_revision) < 0 ||
        Number(stateRows[0]?.clean_generation_revision) > Number(stateRows[0]?.generation_revision))) ||
    (stateRows[0]?.admission_cursor === null) !== (stateRows[0]?.admission_scan_revision === null) ||
    (stateRows[0]?.admission_scan_revision !== null &&
      stateRows[0]?.clean_generation_revision !== null &&
      Number(stateRows[0]?.clean_generation_revision) > Number(stateRows[0]?.admission_scan_revision)) ||
    (stateRows[0]?.clean_generation_revision !== null &&
      Number(stateRows[0]?.clean_generation_revision) === Number(stateRows[0]?.generation_revision) &&
      (stateRows[0]?.admission_cursor !== null || stateRows[0]?.admission_scan_revision !== null)) ||
    stateRows[0]?.pointer_delete_present !== 0 ||
    (stateRows[0]?.admission_cursor !== null &&
      (typeof stateRows[0]?.admission_cursor !== 'string' ||
        !validBoundedText(stateRows[0].admission_cursor, VECTOR_GENERATION_BYTES)))
  ) {
    return 'incompatible' as const;
  }
  const sequenceRows = yield* sql.unsafe<{
    readonly name: unknown;
    readonly seq: unknown;
    readonly seq_type: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(name) = 'text'
              AND name = 'vector_generation_retirements'
            THEN name ELSE NULL END AS name,
       CASE
         WHEN typeof(seq) = 'integer' AND seq BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
         THEN seq ELSE NULL
       END AS seq,
       typeof(seq) AS seq_type
     FROM sqlite_sequence
     WHERE name = 'vector_generation_retirements' COLLATE NOCASE
     LIMIT 2`,
  );
  const maximumRows = yield* sql.unsafe<{readonly maximum: unknown}>(
    `SELECT CASE
       WHEN typeof(retirement_id) = 'integer'
        AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
       THEN retirement_id ELSE NULL
     END AS maximum
     FROM vector_generation_retirements
     ORDER BY retirement_id DESC
     LIMIT 1`,
  );
  const maximum = maximumRows.length === 0 ? null : maximumRows[0]?.maximum;
  if (
    sequenceRows.length !== 1 ||
    sequenceRows[0]?.name !== 'vector_generation_retirements' ||
    sequenceRows[0]?.seq_type !== 'integer' ||
    !Number.isSafeInteger(sequenceRows[0]?.seq) ||
    Number(sequenceRows[0]?.seq) < 0 ||
    (maximum !== null &&
      (!Number.isSafeInteger(maximum) || Number(maximum) <= 0 || Number(sequenceRows[0]?.seq) < Number(maximum)))
  ) {
    return 'incompatible' as const;
  }
  return 'ready' as const;
});

export const selectVectorRetirementMarker = Effect.fn('codeGraph.selectVectorRetirementMarker')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
) {
  const rows = yield* sql.unsafe<{
    readonly delete_authorized: unknown;
    readonly generation: unknown;
    readonly page_revision: unknown;
    readonly retired_by_worktree_id: unknown;
    readonly retirement_id: unknown;
    readonly snapshot_id: unknown;
  }>(
    `SELECT
       CASE
         WHEN typeof(retirement_id) = 'integer'
          AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
         THEN retirement_id ELSE NULL
       END AS retirement_id,
       CASE
         WHEN typeof(generation) = 'text'
          AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
          AND instr(generation, char(0)) = 0
         THEN generation ELSE NULL
       END AS generation,
       CASE
         WHEN typeof(snapshot_id) = 'text'
          AND length(CAST(snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
          AND instr(snapshot_id, char(0)) = 0
         THEN snapshot_id ELSE NULL
       END AS snapshot_id,
       CASE
         WHEN retired_by_worktree_id IS NULL THEN NULL
         WHEN typeof(retired_by_worktree_id) = 'text'
          AND length(CAST(retired_by_worktree_id AS BLOB)) = 64
          AND retired_by_worktree_id NOT GLOB '*[^0-9a-f]*'
         THEN retired_by_worktree_id ELSE 0
       END AS retired_by_worktree_id,
       CASE
         WHEN typeof(page_revision) = 'integer'
          AND page_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
         THEN page_revision ELSE NULL
       END AS page_revision,
       CASE
         WHEN typeof(delete_authorized) = 'integer' AND delete_authorized IN (0, 1)
         THEN delete_authorized ELSE NULL
       END AS delete_authorized
     FROM vector_generation_retirements
     WHERE generation = ? LIMIT 2`,
    [generation],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(row?.retirement_id) ||
    Number(row?.retirement_id) <= 0 ||
    typeof row?.generation !== 'string' ||
    !validBoundedText(row.generation, VECTOR_GENERATION_BYTES) ||
    typeof row?.snapshot_id !== 'string' ||
    !validBoundedText(row.snapshot_id, VECTOR_SNAPSHOT_BYTES) ||
    (row?.retired_by_worktree_id !== null &&
      (typeof row?.retired_by_worktree_id !== 'string' || !/^[0-9a-f]{64}$/.test(row.retired_by_worktree_id))) ||
    !Number.isSafeInteger(row?.page_revision) ||
    Number(row?.page_revision) < 0 ||
    (row?.delete_authorized !== 0 && row?.delete_authorized !== 1)
  ) {
    return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector retirement marker is invalid.'});
  }
  return {
    deleteAuthorized: row.delete_authorized === 1,
    generation: row.generation,
    pageRevision: Number(row.page_revision),
    ...(typeof row.retired_by_worktree_id === 'string' ? {retiredByWorktreeId: row.retired_by_worktree_id} : {}),
    retirementId: Number(row.retirement_id),
    snapshotId: row.snapshot_id,
  } satisfies CodeGraphVectorRetirementMarker;
});

export const selectCodeGraphVectorRetirementMarker = selectVectorRetirementMarker;

export function useExistingVectorDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        create: false,
        disableWAL: true,
        filename: databasePath,
        readwrite: true,
      }),
    ).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

export function vectorRetirementTriggerTarget(
  name: (typeof CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS)[number]['name'],
): string {
  if (name.includes('_marker_')) return 'vector_generation_retirements';
  if (name.includes('_pointer_')) return 'vector_pointers';
  if (name.includes('_generation_')) return 'vector_generations';
  return 'vectors';
}

export function useReadOnlyVectorDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        create: false,
        disableWAL: true,
        filename: databasePath,
        readonly: true,
        readwrite: false,
      }),
    ).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

/** @internal Read-only frozen pager tuple for a separately protected cursor publication. */
export const inspectCodeGraphVectorPageStorage = Effect.fn('codeGraph.inspectVectorPageStorage')(function* (
  databasePath: string,
) {
  return yield* useReadOnlyVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* inspectVectorPageStorageSql(sql);
    }),
  );
});

export const inspectVectorPageStorageSql = Effect.fn('codeGraph.inspectVectorPageStorageSql')(function* (
  sql: SqlClient.SqlClient,
) {
  const [pageSizeRows, freelistRows, walRows, journalRows] = yield* Effect.all(
    [
      sql.unsafe<{readonly page_size: unknown}>('PRAGMA page_size'),
      sql.unsafe<{readonly freelist_count: unknown}>('PRAGMA freelist_count'),
      sql.unsafe<{readonly wal_autocheckpoint: unknown}>('PRAGMA wal_autocheckpoint'),
      sql.unsafe<{readonly journal_mode: unknown}>('PRAGMA journal_mode'),
    ] as const,
    {concurrency: 1},
  );
  const pageSize = pageSizeRows[0]?.page_size;
  const freelistPages = freelistRows[0]?.freelist_count;
  const walAutoCheckpointPages = walRows[0]?.wal_autocheckpoint;
  const journalMode = journalRows[0]?.journal_mode;
  if (
    !Number.isSafeInteger(pageSize) ||
    Number(pageSize) <= 0 ||
    !Number.isSafeInteger(freelistPages) ||
    Number(freelistPages) < 0 ||
    !Number.isSafeInteger(walAutoCheckpointPages) ||
    Number(walAutoCheckpointPages) <= 0 ||
    (journalMode !== 'delete' && journalMode !== 'wal')
  ) {
    return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector page storage is invalid.'});
  }
  const freelistBytes = Number(pageSize) * Number(freelistPages);
  if (!Number.isSafeInteger(freelistBytes)) {
    return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector page storage is invalid.'});
  }
  return {
    freelistBytes,
    journalMode,
    pageSize: Number(pageSize),
    walAutoCheckpointPages: Number(walAutoCheckpointPages),
  } as const satisfies CodeGraphVectorPageStorage;
});

export function sameVectorPageStorage(left: CodeGraphVectorPageStorage, right: CodeGraphVectorPageStorage): boolean {
  return (
    left.freelistBytes === right.freelistBytes &&
    left.pageSize === right.pageSize &&
    left.walAutoCheckpointPages === right.walAutoCheckpointPages &&
    left.journalMode === right.journalMode
  );
}

export function vectorRetirementPageAuthorityBytes(marker: CodeGraphVectorRetirementMarker): number {
  return (
    new TextEncoder().encode(marker.generation).byteLength +
    new TextEncoder().encode(marker.snapshotId).byteLength +
    (marker.retiredByWorktreeId === undefined ? 0 : 64) +
    256
  );
}

export function boundedRetirementLimit(requestedLimit: number): number {
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw CodeGraphVectorRetirementError.make({message: 'Code graph vector retirement page limit is invalid.'});
  }
  return Math.min(requestedLimit, CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS);
}

export function validBoundedText(value: string, maximumBytes: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

export const boundedSchemaObjects = Effect.fn('codeGraph.boundedVectorSchemaObjects')(function* (
  sql: SqlClient.SqlClient,
  name: string,
  limit: number,
) {
  return yield* sql.unsafe<{
    readonly name: unknown;
    readonly sql: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type,
            CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= ? THEN sql ELSE NULL END AS sql
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT ?`,
    [VECTOR_RETIREMENT_TRIGGER_SQL_BYTES, name, limit],
  );
});

export function normalizeSchemaDefinition(value: string): string {
  const quoted: string[] = [];
  let unquoted = '';
  for (let index = 0; index < value.length; index += 1) {
    const opener = value[index];
    const closer = opener === '[' ? ']' : opener;
    if (opener !== "'" && opener !== '"' && opener !== '`' && opener !== '[') {
      unquoted += opener;
      continue;
    }
    const start = index;
    for (index += 1; index < value.length; index += 1) {
      if (value[index] !== closer) continue;
      if (closer !== ']' && value[index + 1] === closer) {
        index += 1;
        continue;
      }
      break;
    }
    quoted.push(value.slice(start, Math.min(index + 1, value.length)));
    unquoted += `\u0000${quoted.length - 1}\u0000`;
  }
  return unquoted
    .toLowerCase()
    .replace(/\bif not exists\b/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1')
    .trim()
    .split('\u0000')
    .map((segment, index) => (index % 2 === 1 ? (quoted[Number(segment)] ?? '') : segment))
    .join('');
}

export const lastStatementChangeCount = Effect.fn('codeGraph.vectorRetirementChangeCount')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe<{readonly count: unknown}>('SELECT changes() AS count');
  const count = rows[0]?.count;
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector retirement change count is invalid.',
    });
  }
  return Number(count);
});
