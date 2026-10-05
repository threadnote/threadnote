import {Effect, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {codeGraphLayout} from '../layout.js';
import {useReadOnlyDatabase} from '../store/session.js';
import {CODE_GRAPH_SNAPSHOT_ID} from '../store/reconciliation/core.js';
import type {RepositoryIdentity} from '../types.js';
import {parseCodeGraphMonikerV1} from './monikers.js';
import type {CodeGraphMonikerV1} from './types.js';

export const CODE_GRAPH_SNAPSHOT_MONIKER_PAGE_SIZE_DEFAULT = 512;
export const CODE_GRAPH_SNAPSHOT_MONIKERS_MAXIMUM_DEFAULT = 20_000;
export const CODE_GRAPH_SNAPSHOT_MONIKERS_MAXIMUM_HARD = 100_000;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAXIMUM_PAGE_SIZE = 1_024;
const MAXIMUM_SPAN_JSON_BYTES = 4 * 1_024;

export class CodeGraphSnapshotMonikerError extends Schema.TaggedError<CodeGraphSnapshotMonikerError>()(
  'CodeGraphSnapshotMonikerError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    code: Schema.Literals(['corrupt', 'invalid-input', 'limit-exceeded', 'snapshot-missing']),
    message: Schema.String,
  },
) {
  static of(
    code: 'corrupt' | 'invalid-input' | 'limit-exceeded' | 'snapshot-missing',
    message: string,
    options?: ErrorOptions,
  ): CodeGraphSnapshotMonikerError {
    return CodeGraphSnapshotMonikerError.make({
      code,
      message,
      ...(options?.cause === undefined ? {} : {cause: options.cause}),
    });
  }
}

export interface CodeGraphSnapshotMonikerReadInputV1 {
  readonly maximumMonikers?: number;
  readonly pageSize?: number;
  readonly repositoryId: string;
  readonly snapshotId: string;
}

export interface CodeGraphReadySnapshotMonikerReadInputV1 extends Omit<
  CodeGraphSnapshotMonikerReadInputV1,
  'repositoryId'
> {
  readonly identity: Pick<RepositoryIdentity, 'checkoutId' | 'repositoryId' | 'worktreeId'>;
  readonly threadnoteHome: string;
}

interface SnapshotRow {
  readonly repository_id: unknown;
  readonly state: unknown;
}

export interface CodeGraphStoredMonikerRowV1 {
  readonly component_id: unknown;
  readonly dependency_kind: unknown;
  readonly evidence_path: unknown;
  readonly evidence_span_json: unknown;
  readonly id: unknown;
  readonly identity: unknown;
  readonly import_path: unknown;
  readonly kind: unknown;
  readonly package_name: unknown;
  readonly package_version: unknown;
  readonly qualified_name: unknown;
  readonly resolution_domain: unknown;
  readonly role: unknown;
  readonly scheme: unknown;
  readonly symbol_id: unknown;
  readonly version: unknown;
}

/**
 * Read canonical monikers from one exact ready snapshot. The caller must keep
 * the snapshot leased for the lifetime of this read. Snapshot provenance is
 * checked both before and after keyset paging so a retired or replaced source
 * cannot be stitched into a newly published workset generation.
 */
export const readCodeGraphSnapshotMonikers = Effect.fn('codeGraph.crossRepository.readSnapshotMonikers')(function* (
  databasePath: string,
  input: CodeGraphSnapshotMonikerReadInputV1,
) {
  const normalized = normalizeInput(input);
  return yield* useReadOnlyDatabase(databasePath, readSnapshotMonikers(normalized)).pipe(
    Effect.mapError(cause =>
      Schema.is(CodeGraphSnapshotMonikerError)(cause)
        ? cause
        : CodeGraphSnapshotMonikerError.of('corrupt', 'Unable to read snapshot monikers.', {cause}),
    ),
  );
});

/** Resolve the authoritative checkout database and read one already-leased ready snapshot. */
export const readCodeGraphReadySnapshotMonikers = Effect.fn('codeGraph.crossRepository.readReadySnapshotMonikers')(
  function* (input: CodeGraphReadySnapshotMonikerReadInputV1) {
    const path = yield* Path.Path;
    const layout = codeGraphLayout(path, input.threadnoteHome, input.identity.checkoutId, input.identity.worktreeId);
    return yield* readCodeGraphSnapshotMonikers(layout.databasePath, {
      ...(input.maximumMonikers === undefined ? {} : {maximumMonikers: input.maximumMonikers}),
      ...(input.pageSize === undefined ? {} : {pageSize: input.pageSize}),
      repositoryId: input.identity.repositoryId,
      snapshotId: input.snapshotId,
    });
  },
);

/** @internal Exported for focused storage-contract tests. */
export function readCodeGraphSnapshotMonikersFromSql(
  sql: SqlClient.SqlClient,
  input: CodeGraphSnapshotMonikerReadInputV1,
) {
  return readSnapshotMonikers(normalizeInput(input)).pipe(Effect.provideService(SqlClient.SqlClient, sql));
}

/** Decode one storage row through the same strict canonical parser as ingest. */
export function codeGraphMonikerFromStorageRow(row: CodeGraphStoredMonikerRowV1): CodeGraphMonikerV1 {
  try {
    const scheme = requiredText(row.scheme, 'scheme');
    const common = {
      evidence: {
        path: requiredText(row.evidence_path, 'evidence path'),
        span: parseSpan(row.evidence_span_json),
      },
      id: requiredText(row.id, 'moniker identity'),
      identity: requiredText(row.identity, 'resolved identity'),
      kind: requiredText(row.kind, 'kind'),
      role: requiredText(row.role, 'role'),
      version: requiredInteger(row.version, 'version'),
    };
    const value =
      scheme === 'package'
        ? {
            ...common,
            componentId: requiredText(row.component_id, 'component identity'),
            ...(optionalText(row.dependency_kind, 'dependency kind') === undefined
              ? {}
              : {dependencyKind: optionalText(row.dependency_kind, 'dependency kind')}),
            packageName: requiredText(row.package_name, 'package name'),
            ...(optionalText(row.package_version, 'package version') === undefined
              ? {}
              : {packageVersion: optionalText(row.package_version, 'package version')}),
            resolutionDomain: requiredText(row.resolution_domain, 'resolution domain'),
            scheme,
          }
        : {
            ...common,
            ...(optionalText(row.import_path, 'import path') === undefined
              ? {}
              : {importPath: optionalText(row.import_path, 'import path')}),
            ...(optionalText(row.package_name, 'package name') === undefined
              ? {}
              : {packageName: optionalText(row.package_name, 'package name')}),
            ...(optionalText(row.qualified_name, 'qualified name') === undefined
              ? {}
              : {qualifiedName: optionalText(row.qualified_name, 'qualified name')}),
            resolutionDomain: requiredText(row.resolution_domain, 'resolution domain'),
            scheme,
            symbolId: requiredText(row.symbol_id, 'symbol identity'),
          };
    return parseCodeGraphMonikerV1(value);
  } catch (cause) {
    if (Schema.is(CodeGraphSnapshotMonikerError)(cause)) throw cause;
    throw CodeGraphSnapshotMonikerError.of('corrupt', 'A stored code graph moniker is not canonical.', {cause});
  }
}

interface NormalizedInput {
  readonly maximumMonikers: number;
  readonly pageSize: number;
  readonly repositoryId: string;
  readonly snapshotId: string;
}

function normalizeInput(input: CodeGraphSnapshotMonikerReadInputV1): NormalizedInput {
  if (!SHA256_HEX.test(input.repositoryId)) {
    throw CodeGraphSnapshotMonikerError.of('invalid-input', 'Snapshot moniker repository identity is invalid.');
  }
  if (!CODE_GRAPH_SNAPSHOT_ID.test(input.snapshotId)) {
    throw CodeGraphSnapshotMonikerError.of('invalid-input', 'Snapshot moniker snapshot identity is invalid.');
  }
  return {
    maximumMonikers: boundedInteger(
      input.maximumMonikers,
      CODE_GRAPH_SNAPSHOT_MONIKERS_MAXIMUM_DEFAULT,
      1,
      CODE_GRAPH_SNAPSHOT_MONIKERS_MAXIMUM_HARD,
      'maximum monikers',
    ),
    pageSize: boundedInteger(
      input.pageSize,
      CODE_GRAPH_SNAPSHOT_MONIKER_PAGE_SIZE_DEFAULT,
      1,
      MAXIMUM_PAGE_SIZE,
      'page size',
    ),
    repositoryId: input.repositoryId,
    snapshotId: input.snapshotId,
  };
}

function readSnapshotMonikers(input: NormalizedInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* assertReadySnapshot(sql, input);
    const output: CodeGraphMonikerV1[] = [];
    let afterId = '';
    while (true) {
      const limit = Math.min(input.pageSize, input.maximumMonikers - output.length + 1);
      const rows = yield* sql.unsafe<CodeGraphStoredMonikerRowV1>(
        `SELECT id, version, scheme, role, kind, resolution_domain, identity,
                package_name, package_version, import_path, qualified_name,
                component_id, symbol_id, dependency_kind, evidence_path,
                evidence_span_json
         FROM code_graph_monikers
         WHERE snapshot_id = ? AND id > ?
         ORDER BY id
         LIMIT ?`,
        [input.snapshotId, afterId, limit],
      );
      if (output.length + rows.length > input.maximumMonikers) {
        return yield* CodeGraphSnapshotMonikerError.of(
          'limit-exceeded',
          `The ready snapshot exceeds the ${input.maximumMonikers} moniker bridge limit.`,
        );
      }
      for (const row of rows) output.push(codeGraphMonikerFromStorageRow(row));
      if (rows.length < limit) break;
      afterId = requiredText(rows.at(-1)!.id, 'moniker identity');
      yield* Effect.yieldNow;
    }
    yield* assertReadySnapshot(sql, input);
    return output;
  });
}

function assertReadySnapshot(sql: SqlClient.SqlClient, input: NormalizedInput) {
  return sql
    .unsafe<SnapshotRow>('SELECT repository_id, state FROM snapshots WHERE id = ? LIMIT 1', [input.snapshotId])
    .pipe(
      Effect.flatMap(rows => {
        const row = rows[0];
        if (row === undefined) {
          return Effect.fail(
            CodeGraphSnapshotMonikerError.of('snapshot-missing', 'The bridge source snapshot no longer exists.'),
          );
        }
        if (row.repository_id !== input.repositoryId || row.state !== 'ready') {
          return Effect.fail(
            CodeGraphSnapshotMonikerError.of(
              'snapshot-missing',
              'The bridge source snapshot is no longer ready for the expected repository.',
            ),
          );
        }
        return Effect.void;
      }),
    );
}

function parseSpan(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAXIMUM_SPAN_JSON_BYTES) {
    throw CodeGraphSnapshotMonikerError.of('corrupt', 'A stored moniker evidence span is invalid.');
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw CodeGraphSnapshotMonikerError.of('corrupt', 'A stored moniker evidence span is invalid.', {cause});
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw CodeGraphSnapshotMonikerError.of('corrupt', `Stored moniker ${label} is invalid.`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredText(value, label);
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw CodeGraphSnapshotMonikerError.of('corrupt', `Stored moniker ${label} is invalid.`);
  }
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw CodeGraphSnapshotMonikerError.of(
      'invalid-input',
      `Snapshot moniker ${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return resolved;
}
