import {Effect} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';
import {CodeGraphWorksetCatalogError, type CodeGraphWorksetScopeReceiptV1} from './types.js';

export function normalizeWorksetScopeReceipt(input: CodeGraphWorksetScopeReceiptV1): CodeGraphWorksetScopeReceiptV1 {
  const scopeId = input.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY;
  if (scopeId === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) {
    if (
      input.definitionDigest !== undefined ||
      input.closureDigest !== undefined ||
      (input.completeness !== undefined && input.completeness !== 'legacy-full')
    ) {
      throw CodeGraphWorksetCatalogError.of(
        'invalid-input',
        'A full Workset receipt must use the canonical legacy-full scope.',
      );
    }
    return {scopeId, completeness: 'legacy-full'};
  }
  if (
    !/^code-graph-scope:[0-9a-f]{64}$/u.test(scopeId) ||
    !/^[0-9a-f]{64}$/u.test(input.definitionDigest ?? '') ||
    !/^[0-9a-f]{64}$/u.test(input.closureDigest ?? '') ||
    (input.completeness !== 'complete' && input.completeness !== 'partial')
  ) {
    throw CodeGraphWorksetCatalogError.of('invalid-input', 'The scoped Workset receipt is missing or invalid.');
  }
  return {
    scopeId,
    definitionDigest: input.definitionDigest,
    closureDigest: input.closureDigest,
    completeness: input.completeness,
  };
}

/** Empty suffix preserves all pre-scope full projection and generation identities. */
export function worksetScopeDigestFields(input: CodeGraphWorksetScopeReceiptV1): readonly unknown[] {
  const scope = normalizeWorksetScopeReceipt(input);
  return scope.scopeId === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY
    ? []
    : ['workset-scope-v1', scope.scopeId, scope.definitionDigest, scope.closureDigest, scope.completeness];
}

export function worksetScopeReceiptsMatch(
  left: CodeGraphWorksetScopeReceiptV1,
  right: CodeGraphWorksetScopeReceiptV1,
): boolean {
  try {
    return JSON.stringify(worksetScopeDigestFields(left)) === JSON.stringify(worksetScopeDigestFields(right));
  } catch {
    return false;
  }
}

export interface WorksetScopeRow {
  readonly scope_id: unknown;
  readonly definition_digest: unknown;
  readonly closure_digest: unknown;
  readonly completeness: unknown;
}

export function decodeWorksetScopeRow(row: WorksetScopeRow): CodeGraphWorksetScopeReceiptV1 {
  // Pristine v4 readers have no scope columns; connection admission validates that legacy schema first.
  if ([row.scope_id, row.definition_digest, row.closure_digest, row.completeness].every(value => value === undefined)) {
    return normalizeWorksetScopeReceipt({});
  }
  if (
    typeof row.scope_id !== 'string' ||
    typeof row.completeness !== 'string' ||
    (row.definition_digest !== null && typeof row.definition_digest !== 'string') ||
    (row.closure_digest !== null && typeof row.closure_digest !== 'string')
  ) {
    throw CodeGraphWorksetCatalogError.of('corrupt', 'Stored Workset scope receipt is missing or invalid.');
  }
  try {
    return normalizeWorksetScopeReceipt({
      scopeId: row.scope_id,
      ...(row.definition_digest === null ? {} : {definitionDigest: row.definition_digest}),
      ...(row.closure_digest === null ? {} : {closureDigest: row.closure_digest}),
      completeness: row.completeness as CodeGraphWorksetScopeReceiptV1['completeness'],
    });
  } catch (cause) {
    throw CodeGraphWorksetCatalogError.of('corrupt', 'Stored Workset scope receipt is inconsistent.', {cause});
  }
}

export function validateWorksetScopeReadSchema(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const versions = yield* sql.unsafe<{readonly value: unknown}>(
      "SELECT value FROM catalog_metadata WHERE key = 'scope_receipt_version'",
    );
    const columns = yield* sql.unsafe<{readonly name: string}>('PRAGMA table_info(repository_snapshots)');
    const present = columns.filter(column =>
      ['scope_id', 'definition_digest', 'closure_digest', 'completeness'].includes(column.name),
    ).length;
    if (versions.length === 0 && present === 0) return;
    if (versions.length !== 1 || versions[0].value !== '1' || present !== 4) {
      return yield* CodeGraphWorksetCatalogError.of(
        'corrupt',
        'The Workset scope receipt schema is incomplete or incompatible.',
      );
    }
  });
}

export function readSnapshotWorksetScopeReceipt(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  scopeId: string | undefined,
) {
  if (scopeId === undefined || scopeId === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) {
    return Effect.succeed(normalizeWorksetScopeReceipt({}));
  }
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<WorksetScopeRow>(
      'SELECT scope_id, definition_digest, closure_digest, completeness FROM snapshot_scope_receipts WHERE snapshot_id = ?',
      [snapshotId],
    );
    if (rows.length !== 1 || rows[0].scope_id !== scopeId) {
      return yield* CodeGraphWorksetCatalogError.of('corrupt', 'The selected snapshot has no matching scope receipt.');
    }
    return yield* Effect.try({
      try: () => decodeWorksetScopeRow(rows[0]),
      catch: cause =>
        CodeGraphWorksetCatalogError.of('corrupt', 'The selected snapshot scope receipt is invalid.', {cause}),
    });
  });
}

/** Additive migration retains v4 full projections and publication identities. */
export function migrateWorksetScopeReceipts(sql: SqlClient.SqlClient) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const columns = yield* sql.unsafe<{readonly name: string}>('PRAGMA table_info(repository_snapshots)');
      const names = new Set(columns.map(column => column.name));
      const versions = yield* sql.unsafe<{readonly value: unknown}>(
        "SELECT value FROM catalog_metadata WHERE key = 'scope_receipt_version'",
      );
      const additions = [
        ['scope_id', "TEXT NOT NULL DEFAULT 'full-repository'"],
        ['definition_digest', 'TEXT'],
        ['closure_digest', 'TEXT'],
        ['completeness', "TEXT NOT NULL DEFAULT 'legacy-full'"],
      ];
      if (
        (versions.length === 0 && additions.some(([name]) => names.has(name))) ||
        (versions.length > 0 && (versions[0].value !== '1' || additions.some(([name]) => !names.has(name))))
      ) {
        return yield* CodeGraphWorksetCatalogError.of(
          'corrupt',
          'The Workset scope receipt schema is incomplete or incompatible.',
        );
      }
      for (const [name, definition] of additions) {
        if (!names.has(name)) yield* sql.unsafe(`ALTER TABLE repository_snapshots ADD COLUMN ${name} ${definition}`);
      }
      yield* sql.unsafe(
        "INSERT INTO catalog_metadata (key, value) VALUES ('scope_receipt_version', '1') ON CONFLICT(key) DO NOTHING",
      );
    }),
  );
}
