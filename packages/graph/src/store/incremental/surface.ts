import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from '../../fact/budget.js';
import {hasSameCodeGraphResolutionSurface, type CodeGraphResolutionSurfaceSymbol} from '../../resolution/surface.js';
import {
  persistedIncrementalBaseSymbolsStatement,
  persistedIncrementalChangedFilesStatement,
  persistedIncrementalReexportMismatchStatement,
} from './plan.js';

interface PersistedIncrementalSurfaceSymbolRow {
  readonly arity: unknown;
  readonly exported: unknown;
  readonly id: unknown;
  readonly kind: unknown;
  readonly language: unknown;
  readonly lookup_keys_json: unknown;
  readonly name: unknown;
  readonly package_name: unknown;
  readonly path: unknown;
  readonly qualified_name: unknown;
  readonly resolution_domain: unknown;
  readonly resolution_scope_id: unknown;
}

// One changed-file overlay is admitted only when its complete attributed facts
// fit the 8 MiB transaction ceiling. Sixty-four bytes is deliberately below
// the JSON size of the required symbol fields, so this cap cannot reject an
// admitted overlay while keeping corrupt staging tables bounded.
const PERSISTED_INCREMENTAL_SURFACE_MAX_SYMBOL_ROWS = Math.floor(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM / 64);

const persistedIncrementalSurfaceMatches = Effect.fn('codeGraph.persistedIncrementalSurfaceMatches')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string,
) {
  const changedFilesStatement = persistedIncrementalChangedFilesStatement(baseSnapshotId);
  const changedFiles = yield* sql.unsafe<{readonly expected: number; readonly present: number}>(
    changedFilesStatement.text,
    changedFilesStatement.parameters,
  );
  if (Number(changedFiles[0]?.expected ?? 0) !== Number(changedFiles[0]?.present ?? -1)) return false;
  const rowLimit = PERSISTED_INCREMENTAL_SURFACE_MAX_SYMBOL_ROWS + 1;
  const currentRows = yield* sql<PersistedIncrementalSurfaceSymbolRow>`
    SELECT
      arity, exported, id, kind, language, lookup_keys_json, name,
      package_name, path, qualified_name, resolution_domain, resolution_scope_id
    FROM activation_symbols
    ORDER BY id
    LIMIT ${rowLimit}
  `;
  const baseRowsStatement = persistedIncrementalBaseSymbolsStatement(baseSnapshotId, rowLimit);
  const baseRows = yield* sql.unsafe<PersistedIncrementalSurfaceSymbolRow>(
    baseRowsStatement.text,
    baseRowsStatement.parameters,
  );
  if (
    currentRows.length > PERSISTED_INCREMENTAL_SURFACE_MAX_SYMBOL_ROWS ||
    baseRows.length > PERSISTED_INCREMENTAL_SURFACE_MAX_SYMBOL_ROWS
  ) {
    return false;
  }
  const currentSymbols = decodePersistedIncrementalSurfaceSymbols(currentRows);
  const baseSymbols = decodePersistedIncrementalSurfaceSymbols(baseRows);
  if (
    currentSymbols === undefined ||
    baseSymbols === undefined ||
    !hasSameCodeGraphResolutionSurface(baseSymbols, currentSymbols)
  ) {
    return false;
  }
  // Sparse raw-fact attribution can be more conservative than the original
  // full batch. Require exact changed-path re-export publication in SQLite so
  // an optimistic preassessment falls closed before persisted-delta reuse.
  const reexportStatement = persistedIncrementalReexportMismatchStatement(baseSnapshotId);
  const reexportMismatch = yield* sql.unsafe<{readonly mismatch: number}>(
    reexportStatement.text,
    reexportStatement.parameters,
  );
  return Number(reexportMismatch[0]?.mismatch ?? 1) === 0;
});

function decodePersistedIncrementalSurfaceSymbols(
  rows: readonly PersistedIncrementalSurfaceSymbolRow[],
): readonly CodeGraphResolutionSurfaceSymbol[] | undefined {
  const symbols: CodeGraphResolutionSurfaceSymbol[] = [];
  for (const row of rows) {
    const symbol = decodePersistedIncrementalSurfaceSymbol(row);
    if (symbol === undefined) return undefined;
    symbols.push(symbol);
  }
  return symbols;
}

function decodePersistedIncrementalSurfaceSymbol(
  row: PersistedIncrementalSurfaceSymbolRow,
): CodeGraphResolutionSurfaceSymbol | undefined {
  if (
    !isNonEmptyString(row.id) ||
    !isNonEmptyString(row.kind) ||
    !isNonEmptyString(row.language) ||
    !isNonEmptyString(row.name) ||
    !isNonEmptyString(row.path) ||
    !isNonEmptyString(row.qualified_name) ||
    (row.exported !== 0 && row.exported !== 1) ||
    (row.arity !== null && (typeof row.arity !== 'number' || !Number.isSafeInteger(row.arity) || row.arity < 0)) ||
    !isOptionalString(row.package_name) ||
    !isOptionalString(row.resolution_domain) ||
    !isOptionalString(row.resolution_scope_id)
  ) {
    return undefined;
  }
  const lookupKeys = decodePersistedIncrementalLookupKeys(row.lookup_keys_json);
  if (lookupKeys === undefined) return undefined;
  return {
    ...(row.arity === null ? {} : {arity: row.arity}),
    exported: row.exported === 1,
    id: row.id,
    kind: row.kind,
    language: row.language,
    lookupKeys,
    name: row.name,
    ...(row.package_name === null ? {} : {packageName: row.package_name}),
    path: row.path,
    qualifiedName: row.qualified_name,
    ...(row.resolution_domain === null ? {} : {resolutionDomain: row.resolution_domain}),
    ...(row.resolution_scope_id === null ? {} : {resolutionScopeId: row.resolution_scope_id}),
  };
}

function decodePersistedIncrementalLookupKeys(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'string' || value.length > CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some(key => typeof key !== 'string' || key.length === 0 || key.length > 4_096) ||
      new Set(parsed).size !== parsed.length
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is null | string {
  return value === null || typeof value === 'string';
}

export {persistedIncrementalSurfaceMatches};
