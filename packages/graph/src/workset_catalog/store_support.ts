import {DateTime, Effect, Exit, FileSystem, Path, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import * as SqlClient from 'effect/sql/SqlClient';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
  codeGraphEvidenceCardId,
  codeGraphQualifiedRefHandle,
  codeGraphWorksetContinuationHandle,
  type CodeGraphWorksetQueryResultV2,
} from '../workset/evidence.js';
import {useDatabaseDirect} from '../store/session.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION,
  codeGraphWorksetCatalogLayout,
  type CodeGraphWorksetCatalogLayout,
} from './layout.js';
import {
  codeGraphWorksetRoutingProjectionDigestAppendCanonical,
  codeGraphWorksetRoutingProjectionDigestComplete,
  codeGraphWorksetRoutingProjectionDigestStart,
} from './projection.js';
import {codeGraphWorksetResultSequenceDigest, type PreparedCodeGraphWorksetResultSequenceV1} from './result_set.js';
import {codeGraphWorksetRoutingExactKeys} from './routing_normalization.js';
import {decodeWorksetScopeRow, validateWorksetScopeReadSchema, type WorksetScopeRow} from './scope_receipt.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_PAGE_SIZE_BYTES,
  configureCodeGraphWorksetCatalogReadConnection,
  initializeCodeGraphWorksetCatalogSchema,
  inspectCodeGraphWorksetCatalogPageSize,
  inspectCodeGraphWorksetCatalogSchemaVersion,
} from './schema.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphQualifiedRefRecordV1,
  type CodeGraphWorksetCatalogGenerationReceiptV1,
  type CodeGraphWorksetCatalogHealthV1,
  type CodeGraphWorksetRoutingProjectionReceiptV1,
  type CodeGraphWorksetRoutingProjectionDigestStateV1,
  type CodeGraphWorksetRoutingSymbolV1,
  type CodeGraphWorksetRoutingTermV1,
} from './types.js';

const CATALOG_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;
const PROJECTION_INSERT_BATCH_SIZE = 256;
export {CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM} from './projection/storage.js';
const CATALOG_RETIREMENT_LIMIT_MAXIMUM = 1_000;
const GENERATION_ID = /^cgwg_[0-9a-f]{40}$/u;
const QUALIFIED_REF = /^cgr_[0-9a-f]{40}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const LOCAL_NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RESULT_SET_MAINTENANCE_LIMIT_MAXIMUM = CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsMaximum;

interface GenerationRow {
  readonly generation_digest: unknown;
  readonly id: unknown;
  readonly manifest_digest: unknown;
  readonly member_count: unknown;
  readonly state: unknown;
  readonly workset_name: unknown;
}

interface GenerationMemberRow extends WorksetScopeRow {
  readonly member_repository_id: unknown;
  readonly member_snapshot_id: unknown;
  readonly ordinal: unknown;
  readonly projection_digest: unknown;
  readonly repository_id: unknown;
  readonly repository_key: unknown;
  readonly snapshot_id: unknown;
  readonly worktree_id: unknown;
}

interface ProjectionRow extends WorksetScopeRow {
  readonly checkout_id: unknown;
  readonly commit_id: unknown;
  readonly component_count: unknown;
  readonly extractor_generation: unknown;
  readonly projection_digest: unknown;
  readonly projector_version: unknown;
  readonly repository_id: unknown;
  readonly snapshot_digest: unknown;
  readonly snapshot_id: unknown;
  readonly state: unknown;
  readonly symbol_count: unknown;
  readonly worktree_id: unknown;
}

interface RoutingSymbolRow {
  readonly exported: unknown;
  readonly kind: unknown;
  readonly language: unknown;
  readonly name: unknown;
  readonly node_id: unknown;
  readonly package_name: unknown;
  readonly path: unknown;
  readonly qualified_name: unknown;
  readonly span_column: unknown;
  readonly span_end_column: unknown;
  readonly span_end_line: unknown;
  readonly span_line: unknown;
}

interface RoutingLookupKeyRow {
  readonly lookup_key: unknown;
  readonly node_id: unknown;
}

interface RoutingTermRow {
  readonly node_id: unknown;
  readonly term: unknown;
  readonly weight: unknown;
}

interface RoutingExactKeyRow {
  readonly exact_key: unknown;
  readonly key_kind: unknown;
  readonly node_id: unknown;
}

interface QualifiedRefRow {
  readonly created_at: unknown;
  readonly node_id: unknown;
  readonly ref: unknown;
  readonly repository_id: unknown;
}

interface ResultSetRow {
  readonly card_count: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly envelope_bytes: unknown;
  readonly envelope_digest: unknown;
  readonly envelope_json: unknown;
  readonly generation_digest: unknown;
  readonly generation_id: unknown;
  readonly generation_state: unknown;
  readonly id: unknown;
  readonly offset: unknown;
  readonly projector_version: unknown;
  readonly result_set_token: unknown;
  readonly sequence_digest: unknown;
  readonly stored_generation_digest: unknown;
  readonly total_bytes: unknown;
  readonly workset_name: unknown;
}

export function withCatalogWriter<A, E, R>(
  threadnoteHome: string,
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
    return yield* withExclusiveFileLock(
      fs,
      layout.lockPath,
      CATALOG_LOCK_OPTIONS,
      Effect.gen(function* () {
        yield* fs.makeDirectory(layout.root, {recursive: true, mode: 0o700});
        const result = yield* useCatalogWriteDatabase(
          layout.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* initializeCodeGraphWorksetCatalogSchema(sql);
            return yield* use(sql);
          }),
        );
        yield* fs.chmod(layout.databasePath, 0o600);
        yield* removeObsoleteCatalogFiles(fs, path, threadnoteHome);
        return result;
      }),
    );
  }).pipe(mapCatalogError('write workset catalog'));
}

function removeObsoleteCatalogFiles(fs: FileSystem.FileSystem, path: Path.Path, threadnoteHome: string) {
  const obsoleteDatabases = [2, 3].map(version =>
    path.join(threadnoteHome, 'indexes', 'code-graph', 'worksets', `catalog-v${String(version)}.sqlite`),
  );
  return Effect.forEach(
    obsoleteDatabases.flatMap(database => [database, `${database}-journal`, `${database}-shm`, `${database}-wal`]),
    candidate => fs.remove(candidate, {force: true}),
    {concurrency: 1, discard: true},
  );
}

export function withCatalogReader<A, E, R>(
  threadnoteHome: string,
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
    if (!(yield* fs.exists(layout.databasePath))) return undefined;
    return yield* useCatalogReadDatabase(
      layout.databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* configureCodeGraphWorksetCatalogReadConnection(sql);
        yield* validateWorksetScopeReadSchema(sql);
        return yield* use(sql);
      }),
    );
  }).pipe(mapCatalogError('read workset catalog'));
}

/** @internal Shared by generation-qualified additive catalog stores. */
export const withCodeGraphWorksetCatalogWriter = withCatalogWriter;

/** @internal Shared by generation-qualified additive catalog readers. */
export const withCodeGraphWorksetCatalogReader = withCatalogReader;

export function selectProjectionForSnapshot(
  sql: SqlClient.SqlClient,
  receipt: CodeGraphWorksetRoutingProjectionReceiptV1,
) {
  return sql
    .unsafe<ProjectionRow>(
      `SELECT projection_digest, repository_id, checkout_id, worktree_id, snapshot_id,
              snapshot_digest, commit_id, extractor_generation, projector_version,
              component_count, symbol_count, state, scope_id, definition_digest, closure_digest, completeness
       FROM repository_snapshots
       WHERE checkout_id = ? AND worktree_id = ? AND snapshot_id = ? AND projector_version = ?
       LIMIT 1`,
      [receipt.checkoutId, receipt.worktreeId, receipt.snapshotId, receipt.projectorVersion],
    )
    .pipe(Effect.flatMap(rows => (rows.length === 0 ? succeedUndefined : decodeProjectionMetadata(rows[0]))));
}

export function selectProjectionByDigest(sql: SqlClient.SqlClient, projectionDigest: string) {
  return sql
    .unsafe<ProjectionRow>(
      `SELECT projection_digest, repository_id, checkout_id, worktree_id, snapshot_id,
              snapshot_digest, commit_id, extractor_generation, projector_version,
              component_count, symbol_count, state, scope_id, definition_digest, closure_digest, completeness
       FROM repository_snapshots WHERE projection_digest = ? LIMIT 1`,
      [projectionDigest],
    )
    .pipe(Effect.flatMap(rows => (rows.length === 0 ? succeedUndefined : decodeProjectionMetadata(rows[0]))));
}

export function projectionState(sql: SqlClient.SqlClient, projectionDigest: string) {
  return selectProjectionByDigest(sql, projectionDigest).pipe(Effect.map(row => row?.state));
}

export function dropQueuedReferencedProjections(sql: SqlClient.SqlClient, limit: number) {
  if (limit === 0) return Effect.void;
  return sql.unsafe(
    `DELETE FROM routing_projection_retirements
     WHERE projection_digest IN (
       SELECT q.projection_digest FROM routing_projection_retirements AS q
       WHERE EXISTS (
         SELECT 1 FROM workset_generation_members AS m
         WHERE m.projection_digest = q.projection_digest
       )
       ORDER BY q.requested_at, q.projection_digest
       LIMIT ?
     )`,
    [limit],
  );
}

export function insertProjectionHeader(
  sql: SqlClient.SqlClient,
  receipt: CodeGraphWorksetRoutingProjectionReceiptV1,
  now: string,
  reservedLogicalBytes: number,
  stagingToken: string,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO repository_snapshots (
           projection_digest, repository_id, checkout_id, worktree_id, snapshot_id,
           snapshot_digest, commit_id, extractor_generation, projector_version,
           component_count, symbol_count, state, created_at, scope_id, definition_digest, closure_digest, completeness
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?)`,
        [
          receipt.projectionDigest,
          receipt.repositoryId,
          receipt.checkoutId,
          receipt.worktreeId,
          receipt.snapshotId,
          receipt.snapshotDigest,
          receipt.commitId,
          receipt.extractorGeneration,
          receipt.projectorVersion,
          receipt.componentCount,
          receipt.symbolCount,
          now,
          receipt.scopeId,
          receipt.definitionDigest ?? null,
          receipt.closureDigest ?? null,
          receipt.completeness,
        ],
      );
      yield* sql.unsafe(
        `UPDATE catalog_capacity
         SET projection_logical_bytes = projection_logical_bytes + ?
         WHERE singleton = 1 AND projection_logical_bytes <= ? - bridge_logical_bytes`,
        [reservedLogicalBytes, CODE_GRAPH_WORKSET_CATALOG_LIMITS.catalogPhysicalBytesMaximum - reservedLogicalBytes],
      );
      if ((yield* changes(sql)) !== 1) {
        return yield* CodeGraphWorksetCatalogError.of(
          'capacity',
          'The home-global routing projection catalog is full.',
        );
      }
      yield* sql.unsafe(
        `INSERT INTO routing_projection_storage (
           projection_digest, logical_bytes, reserved_bytes, staging_token
         ) VALUES (?, 0, ?, ?)`,
        [receipt.projectionDigest, reservedLogicalBytes, stagingToken],
      );
      yield* sql.unsafe(
        `INSERT INTO routing_projection_retirements (projection_digest, requested_at)
         VALUES (?, ?)`,
        [receipt.projectionDigest, now],
      );
    }),
  );
}

export function projectionReceipt(
  metadata: Effect.Success<ReturnType<typeof decodeProjectionMetadata>>,
): CodeGraphWorksetRoutingProjectionReceiptV1 {
  return {
    ...metadata.scope,
    checkoutId: metadata.checkout_id,
    commitId: metadata.commit_id,
    componentCount: metadata.component_count,
    extractorGeneration: metadata.extractor_generation,
    projectionDigest: metadata.projection_digest,
    projectorVersion: metadata.projector_version,
    repositoryId: metadata.repository_id,
    snapshotDigest: metadata.snapshot_digest,
    snapshotId: metadata.snapshot_id,
    symbolCount: metadata.symbol_count,
    worktreeId: metadata.worktree_id,
  };
}

export function insertRoutingSymbol(
  sql: SqlClient.SqlClient,
  projectionDigest: string,
  symbol: CodeGraphWorksetRoutingSymbolV1,
) {
  return Effect.gen(function* () {
    const exactKeys = codeGraphWorksetRoutingExactKeys(symbol);
    if (exactKeys.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.exactKeysPerSymbol) {
      return yield* CodeGraphWorksetCatalogError.of(
        'invalid-input',
        `Workset routing symbol ${symbol.nodeId} has too many normalized exact keys.`,
      );
    }
    yield* sql.unsafe(
      `INSERT INTO routing_symbols (
         projection_digest, node_id, kind, language, exported, package_name, path,
         name, qualified_name, span_line, span_column, span_end_line, span_end_column
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectionDigest,
        symbol.nodeId,
        symbol.kind,
        symbol.language,
        symbol.exported ? 1 : 0,
        symbol.packageName ?? null,
        symbol.path,
        symbol.name,
        symbol.qualifiedName,
        symbol.span.line,
        symbol.span.column,
        symbol.span.endLine,
        symbol.span.endColumn,
      ],
    );
    yield* Effect.forEach(
      symbol.lookupKeys,
      lookupKey =>
        sql.unsafe(
          `INSERT INTO routing_lookup_keys (projection_digest, node_id, lookup_key)
           VALUES (?, ?, ?)`,
          [projectionDigest, symbol.nodeId, lookupKey],
        ),
      {concurrency: 1, discard: true},
    );
    yield* Effect.forEach(
      symbol.terms,
      term =>
        sql.unsafe(
          `INSERT INTO routing_terms (projection_digest, node_id, term, weight)
           VALUES (?, ?, ?, ?)`,
          [projectionDigest, symbol.nodeId, term.term, term.weight],
        ),
      {concurrency: 1, discard: true},
    );
    yield* Effect.forEach(
      exactKeys,
      key =>
        sql.unsafe(
          `INSERT INTO routing_exact_keys (projection_digest, node_id, key_kind, exact_key)
           VALUES (?, ?, ?, ?)`,
          [projectionDigest, symbol.nodeId, key.kind, key.exactKey],
        ),
      {concurrency: 1, discard: true},
    );
  });
}

export function loadAndValidateProjection(sql: SqlClient.SqlClient, projectionDigest: string, requireReady = false) {
  return Effect.gen(function* () {
    const projectionRows = yield* sql.unsafe<ProjectionRow>(
      `SELECT projection_digest, repository_id, checkout_id, worktree_id, snapshot_id,
              snapshot_digest, commit_id, extractor_generation, projector_version,
              component_count, symbol_count, state, scope_id, definition_digest, closure_digest, completeness
       FROM repository_snapshots
       WHERE projection_digest = ?
       LIMIT 1`,
      [projectionDigest],
    );
    if (projectionRows.length !== 1) return yield* corrupt('Routing projection metadata is missing.');
    const metadata = yield* decodeProjectionMetadata(projectionRows[0]);
    if (requireReady && metadata.state !== 'ready') {
      return yield* corrupt('Routing projection is not ready for publication.');
    }
    if (metadata.symbol_count > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
      return yield* corrupt('Routing projection symbol count exceeds the supported bound.');
    }
    let digestState: CodeGraphWorksetRoutingProjectionDigestStateV1 = codeGraphWorksetRoutingProjectionDigestStart();
    let afterNodeId = '';
    for (;;) {
      const symbolRows = yield* sql.unsafe<RoutingSymbolRow>(
        `SELECT node_id, kind, language, exported, package_name, path, name, qualified_name,
                span_line, span_column, span_end_line, span_end_column
         FROM routing_symbols
         WHERE projection_digest = ? AND node_id > ?
         ORDER BY node_id
         LIMIT ?`,
        [projectionDigest, afterNodeId, PROJECTION_INSERT_BATCH_SIZE],
      );
      if (symbolRows.length === 0) break;
      const nodeIds = symbolRows.map(row => requiredText(row.node_id, 'node identity'));
      const placeholders = nodeIds.map(() => '?').join(', ');
      const termRows = yield* sql.unsafe<RoutingTermRow>(
        `SELECT node_id, term, weight FROM routing_terms
         WHERE projection_digest = ? AND node_id IN (${placeholders})
         ORDER BY node_id, term
         LIMIT ?`,
        [projectionDigest, ...nodeIds, nodeIds.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol + 1],
      );
      const lookupKeyRows = yield* sql.unsafe<RoutingLookupKeyRow>(
        `SELECT node_id, lookup_key FROM routing_lookup_keys
         WHERE projection_digest = ? AND node_id IN (${placeholders})
         ORDER BY node_id, lookup_key
         LIMIT ?`,
        [projectionDigest, ...nodeIds, nodeIds.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol + 1],
      );
      const exactKeyRows = yield* sql.unsafe<RoutingExactKeyRow>(
        `SELECT node_id, key_kind, exact_key FROM routing_exact_keys
         WHERE projection_digest = ? AND node_id IN (${placeholders})
         ORDER BY node_id, key_kind, exact_key
         LIMIT ?`,
        [projectionDigest, ...nodeIds, nodeIds.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.exactKeysPerSymbol + 1],
      );
      if (
        termRows.length > nodeIds.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol ||
        lookupKeyRows.length > nodeIds.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol ||
        exactKeyRows.length > nodeIds.length * CODE_GRAPH_WORKSET_CATALOG_LIMITS.exactKeysPerSymbol
      ) {
        return yield* corrupt('Routing projection page surface exceeds its supported bound.');
      }
      const terms = new Map<string, CodeGraphWorksetRoutingTermV1[]>();
      for (const row of termRows) {
        const nodeId = requiredText(row.node_id, 'routing term node identity');
        const values = terms.get(nodeId) ?? [];
        values.push({term: requiredText(row.term, 'routing term'), weight: requiredNumber(row.weight, 'term weight')});
        terms.set(nodeId, values);
      }
      const lookupKeys = new Map<string, string[]>();
      for (const row of lookupKeyRows) {
        const nodeId = requiredText(row.node_id, 'lookup key node identity');
        const values = lookupKeys.get(nodeId) ?? [];
        values.push(requiredText(row.lookup_key, 'lookup key'));
        lookupKeys.set(nodeId, values);
      }
      const exactKeys = new Map<string, string[]>();
      for (const row of exactKeyRows) {
        const nodeId = requiredText(row.node_id, 'exact-key node identity');
        const values = exactKeys.get(nodeId) ?? [];
        values.push(`${requiredText(row.key_kind, 'exact-key kind')}\0${requiredText(row.exact_key, 'exact key')}`);
        exactKeys.set(nodeId, values);
      }
      const symbols: CodeGraphWorksetRoutingSymbolV1[] = [];
      for (const row of symbolRows) {
        const nodeId = requiredText(row.node_id, 'node identity');
        const symbol = yield* decodeRoutingSymbol(row, lookupKeys.get(nodeId) ?? [], terms.get(nodeId) ?? []);
        const expectedExactKeys = codeGraphWorksetRoutingExactKeys(symbol).map(key => `${key.kind}\0${key.exactKey}`);
        if (JSON.stringify(exactKeys.get(nodeId) ?? []) !== JSON.stringify(expectedExactKeys)) {
          return yield* corrupt('Routing projection normalized exact-key validation failed.');
        }
        symbols.push(symbol);
      }
      digestState = yield* Effect.try({
        try: () => codeGraphWorksetRoutingProjectionDigestAppendCanonical(digestState, symbols),
        catch: cause => corrupt('Stored routing projection symbols are invalid.', cause),
      });
      afterNodeId = nodeIds.at(-1)!;
      if (symbolRows.length < PROJECTION_INSERT_BATCH_SIZE) break;
      yield* Effect.yieldNow;
    }
    if (digestState.symbolCount !== metadata.symbol_count) {
      return yield* corrupt('Routing projection symbol count is inconsistent.');
    }
    const receipt = projectionReceipt(metadata);
    const {projectionDigest: _projectionDigest, ...header} = receipt;
    const actualDigest = yield* Effect.try({
      try: () => codeGraphWorksetRoutingProjectionDigestComplete(header, digestState),
      catch: cause => corrupt('Stored routing projection metadata is invalid.', cause),
    });
    if (actualDigest !== projectionDigest) {
      return yield* corrupt('Routing projection integrity validation failed.');
    }
    return {receipt, state: metadata.state};
  });
}

export function decodeProjectionMetadata(row: ProjectionRow) {
  return validateStored(() => {
    const state = requiredText(row.state, 'projection state');
    if (state !== 'ready' && state !== 'reclaiming' && state !== 'staging') {
      throw corrupt('Routing projection state is invalid.');
    }
    const projectionDigest = requiredText(row.projection_digest, 'projection digest');
    const repositoryId = requiredText(row.repository_id, 'repository identity');
    const checkoutId = requiredText(row.checkout_id, 'checkout identity');
    const worktreeId = requiredText(row.worktree_id, 'worktree identity');
    const snapshotDigest = requiredText(row.snapshot_digest, 'snapshot digest');
    const commitId = requiredText(row.commit_id, 'commit identity');
    const projectorVersion = requiredInteger(row.projector_version, 'projector version');
    const extractorGeneration = requiredInteger(row.extractor_generation, 'extractor generation');
    const symbolCount = requiredInteger(row.symbol_count, 'symbol count');
    if (
      ![projectionDigest, repositoryId, checkoutId, worktreeId, snapshotDigest].every(value =>
        /^[0-9a-f]{64}$/u.test(value),
      ) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commitId) ||
      projectorVersion !== CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION ||
      extractorGeneration < 1 ||
      symbolCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection
    ) {
      throw corrupt('Routing projection metadata is invalid.');
    }
    return {
      scope: decodeWorksetScopeRow(row),
      checkout_id: checkoutId,
      commit_id: commitId,
      component_count: requiredInteger(row.component_count, 'component count'),
      extractor_generation: extractorGeneration,
      projection_digest: projectionDigest,
      projector_version: projectorVersion,
      repository_id: repositoryId,
      snapshot_digest: snapshotDigest,
      snapshot_id: requiredText(row.snapshot_id, 'snapshot identity'),
      state,
      symbol_count: symbolCount,
      worktree_id: worktreeId,
    } as const;
  });
}

export function decodeRoutingSymbol(
  row: RoutingSymbolRow,
  lookupKeys: readonly string[],
  terms: readonly CodeGraphWorksetRoutingTermV1[],
) {
  return validateStored(() => {
    const exported = requiredInteger(row.exported, 'exported flag');
    if (exported !== 0 && exported !== 1) throw corrupt('Routing symbol exported flag is invalid.');
    return {
      exported: exported === 1,
      kind: requiredText(row.kind, 'symbol kind'),
      language: requiredText(row.language, 'symbol language'),
      lookupKeys,
      name: requiredText(row.name, 'symbol name'),
      nodeId: requiredText(row.node_id, 'node identity'),
      ...(row.package_name === null ? {} : {packageName: requiredText(row.package_name, 'package name')}),
      path: requiredText(row.path, 'evidence path'),
      qualifiedName: requiredText(row.qualified_name, 'qualified symbol name'),
      span: {
        column: requiredInteger(row.span_column, 'span column'),
        endColumn: requiredInteger(row.span_end_column, 'span end column'),
        endLine: requiredInteger(row.span_end_line, 'span end line'),
        line: requiredInteger(row.span_line, 'span line'),
      },
      terms,
    } satisfies CodeGraphWorksetRoutingSymbolV1;
  });
}

export function decodeQualifiedRef(row: QualifiedRefRow) {
  return validateStored(() => {
    const ref = requiredText(row.ref, 'qualified reference');
    const repositoryId = requiredText(row.repository_id, 'qualified reference repository identity');
    const nodeId = requiredText(row.node_id, 'qualified reference node identity');
    const createdAt = canonicalIso(requiredText(row.created_at, 'qualified reference creation instant'));
    if (
      !QUALIFIED_REF.test(ref) ||
      !SHA256_HEX.test(repositoryId) ||
      !LOCAL_NODE_ID.test(nodeId) ||
      codeGraphQualifiedRefHandle({nodeId, repositoryId}) !== ref
    ) {
      throw corrupt('Stored qualified graph reference is invalid.');
    }
    return {createdAt, nodeId, ref, repositoryId} satisfies CodeGraphQualifiedRefRecordV1;
  });
}

export function validateResultSetIdentityInput(result: CodeGraphWorksetQueryResultV2, projectorVersion: number): void {
  assertInputText(result.workset.name, 'workset name', 256);
  validateGenerationIdentity(result.workset.generation);
  resultSetProjectorVersion(projectorVersion);
  if (projectorVersion !== CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION) {
    throw CodeGraphWorksetCatalogError.of(
      'incompatible',
      'The workset result-set projector version is incompatible with this runtime.',
    );
  }
}

export function validateGenerationIdentity(generation: {readonly digest: string; readonly id: string}): void {
  if (
    !GENERATION_ID.test(generation.id) ||
    !SHA256_HEX.test(generation.digest) ||
    generation.id !== `cgwg_${generation.digest.slice(0, 40)}`
  ) {
    throw invalid('Workset catalog generation identity is invalid.');
  }
}

export function validateResultSetGenerationForRegistration(
  sql: SqlClient.SqlClient,
  result: CodeGraphWorksetQueryResultV2,
) {
  return Effect.gen(function* () {
    const generation = yield* selectGeneration(sql, result.workset.generation.id);
    if (generation === undefined) {
      return yield* CodeGraphWorksetCatalogError.of(
        'missing',
        'The workset result-set catalog generation does not exist.',
      );
    }
    if (
      generation.generation_digest !== result.workset.generation.digest ||
      generation.workset_name !== result.workset.name ||
      generation.state !== 'ready' ||
      !(yield* generationIsPublished(sql, result.workset.generation.id, result.workset.name))
    ) {
      return yield* CodeGraphWorksetCatalogError.of(
        'stale',
        'The workset result set must be registered against the current published catalog generation.',
      );
    }
  });
}

export function validateResultSetReferences(
  sql: SqlClient.SqlClient,
  generationId: string,
  sequence: PreparedCodeGraphWorksetResultSequenceV1,
) {
  return Effect.gen(function* () {
    const members = yield* loadGenerationMembers(sql, generationId);
    const membersByKey = new Map(members.map(member => [member.repository_key, member] as const));
    const expectedOwners = new Map<string, Set<string>>();
    for (const prepared of sequence.cards) {
      const member = membersByKey.get(prepared.card.repositoryKey);
      if (member === undefined) {
        return yield* CodeGraphWorksetCatalogError.of(
          'stale',
          `Result card repository ${prepared.card.repositoryKey} is not in the pinned workset generation.`,
        );
      }
      if (prepared.card.id !== codeGraphEvidenceCardId(prepared.card.ref, member.snapshot_id, member.worktree_id)) {
        return yield* CodeGraphWorksetCatalogError.of(
          'invalid-input',
          `Result card ${prepared.card.id} does not match its qualified reference and pinned snapshot.`,
        );
      }
      for (const [ref, repositoryKeys] of prepared.referencedRepositories) {
        const existing = expectedOwners.get(ref) ?? new Set<string>();
        for (const repositoryKey of repositoryKeys) existing.add(repositoryKey);
        expectedOwners.set(ref, existing);
      }
    }
    const registered = new Map<string, CodeGraphQualifiedRefRecordV1>();
    const refs = [...expectedOwners.keys()].sort(compareText);
    for (let offset = 0; offset < refs.length; offset += PROJECTION_INSERT_BATCH_SIZE) {
      const page = refs.slice(offset, offset + PROJECTION_INSERT_BATCH_SIZE);
      if (page.length === 0) continue;
      const rows = yield* sql.unsafe<QualifiedRefRow>(
        `SELECT ref, repository_id, node_id, created_at
         FROM qualified_refs
         WHERE ref IN (${page.map(() => '?').join(', ')})
         ORDER BY ref`,
        page,
      );
      for (const row of rows) {
        const record = yield* decodeQualifiedRef(row);
        registered.set(record.ref, record);
      }
    }
    for (const [ref, repositoryKeys] of expectedOwners) {
      const record = registered.get(ref);
      if (record === undefined) {
        return yield* CodeGraphWorksetCatalogError.of(
          'missing',
          `Qualified reference ${ref} must be registered before persisting a continuation.`,
        );
      }
      for (const repositoryKey of repositoryKeys) {
        const member = membersByKey.get(repositoryKey);
        if (member === undefined || member.repository_id !== record.repositoryId) {
          return yield* CodeGraphWorksetCatalogError.of(
            'invalid-input',
            `Qualified reference ${ref} is isolated to a different repository.`,
          );
        }
      }
    }
  });
}

export function decodeResultSetRow(row: ResultSetRow) {
  return validateStored(() => {
    const id = requiredText(row.id, 'result set identity');
    const generation = {
      digest: requiredText(row.generation_digest, 'result set generation digest'),
      id: requiredText(row.generation_id, 'result set generation identity'),
    };
    validateGenerationIdentity(generation);
    const storedGenerationDigest = requiredText(row.stored_generation_digest, 'stored generation digest');
    if (storedGenerationDigest !== generation.digest) throw corrupt('Result-set generation receipt is inconsistent.');
    const generationState = requiredText(row.generation_state, 'result-set generation state');
    if (generationState !== 'ready' && generationState !== 'retired') {
      throw corrupt('Result-set generation is not published or retired.');
    }
    const resultSetToken = requiredText(row.result_set_token, 'result set token');
    const sequenceDigest = requiredText(row.sequence_digest, 'result sequence digest');
    const envelopeJson = requiredText(row.envelope_json, 'result-set envelope JSON');
    const envelopeBytes = requiredInteger(row.envelope_bytes, 'result-set envelope byte count');
    const envelopeDigest = requiredText(row.envelope_digest, 'result-set envelope digest');
    const cardCount = requiredInteger(row.card_count, 'result set card count');
    const totalBytes = requiredInteger(row.total_bytes, 'result set total bytes');
    const offset = requiredInteger(row.offset, 'continuation offset');
    if (
      !/^cgwrs_[0-9a-f]{40}$/u.test(id) ||
      !SHA256_HEX.test(resultSetToken) ||
      !SHA256_HEX.test(sequenceDigest) ||
      !SHA256_HEX.test(envelopeDigest) ||
      envelopeBytes < 1 ||
      envelopeBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum ||
      cardCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardsMaximum ||
      totalBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum ||
      offset > cardCount
    ) {
      throw corrupt('Stored workset result-set metadata is invalid.');
    }
    return {
      cardCount,
      createdAt: canonicalIso(requiredText(row.created_at, 'result set creation instant')),
      envelopeBytes,
      envelopeDigest,
      envelopeJson,
      expiresAt: canonicalIso(requiredText(row.expires_at, 'result set expiry instant')),
      generation,
      generationState,
      id,
      offset,
      projectorVersion: requiredInteger(row.projector_version, 'result-set projector version'),
      resultSetToken,
      sequenceDigest,
      totalBytes,
      worksetName: requiredText(row.workset_name, 'result-set workset name'),
    };
  });
}

export function storedResultSetSequenceReceipt(sql: SqlClient.SqlClient, resultSetId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{
      readonly card_bytes: unknown;
      readonly card_digest: unknown;
      readonly ordinal: unknown;
    }>(
      `SELECT ordinal, card_bytes, card_digest
       FROM result_cards
       WHERE result_set_id = ?
       ORDER BY ordinal
       LIMIT ?`,
      [resultSetId, CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardsMaximum + 1],
    );
    return yield* validateStored(() => {
      if (rows.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardsMaximum) {
        throw corrupt('Stored workset result-set card count exceeds the supported bound.');
      }
      let bytes = 0;
      const digests: string[] = [];
      rows.forEach((row, ordinal) => {
        if (requiredInteger(row.ordinal, 'result card ordinal') !== ordinal) {
          throw corrupt('Stored workset result-set ordinals are not contiguous.');
        }
        bytes += requiredInteger(row.card_bytes, 'result card byte count');
        const digest = requiredText(row.card_digest, 'result card digest');
        if (!SHA256_HEX.test(digest)) throw corrupt('Stored result card digest is invalid.');
        digests.push(digest);
      });
      if (bytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum) {
        throw corrupt('Stored workset result-set bytes exceed the supported bound.');
      }
      return {bytes, count: rows.length, digest: codeGraphWorksetResultSequenceDigest(digests)};
    });
  });
}

export function readStoredResultSetCursor(
  sql: SqlClient.SqlClient,
  resultSet: Effect.Success<ReturnType<typeof decodeResultSetRow>>,
  offset: number,
) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{readonly cursor: unknown}>(
      'SELECT cursor FROM result_set_cursors WHERE result_set_id = ? AND offset = ? LIMIT 1',
      [resultSet.id, offset],
    );
    if (rows.length !== 1) return yield* corrupt('Stored workset continuation boundary is missing.');
    const cursor = requiredText(rows[0].cursor, 'continuation cursor');
    const expected = codeGraphWorksetContinuationHandle({
      generationDigest: resultSet.generation.digest,
      offset,
      projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
      resultSetToken: resultSet.resultSetToken,
    });
    if (cursor !== expected) return yield* corrupt('Stored workset continuation boundary is corrupt.');
    return cursor;
  });
}

export function deleteExpiredResultSets(sql: SqlClient.SqlClient, now: string, limit: number) {
  if (limit === 0) return Effect.succeed(0);
  return Effect.gen(function* () {
    yield* sql.unsafe(
      `DELETE FROM result_sets
       WHERE id IN (
         SELECT id FROM result_sets
         WHERE expires_at <= ?
         ORDER BY expires_at, created_at, id
         LIMIT ?
       )`,
      [now, limit],
    );
    return yield* changes(sql);
  });
}

export function resultSetCapacity(sql: SqlClient.SqlClient) {
  return sql
    .unsafe<{readonly bytes: unknown; readonly count: unknown}>(
      'SELECT COALESCE(SUM(total_bytes), 0) AS bytes, COUNT(*) AS count FROM result_sets',
    )
    .pipe(
      Effect.flatMap(rows =>
        validateStored(() => {
          if (rows.length !== 1) throw corrupt('Result-set capacity query returned an invalid row set.');
          return {
            bytes: requiredInteger(rows[0].bytes, 'result-set capacity bytes'),
            count: requiredInteger(rows[0].count, 'result-set capacity count'),
          };
        }),
      ),
    );
}

export function loadGenerationMembers(sql: SqlClient.SqlClient, generationId: string) {
  return sql
    .unsafe<GenerationMemberRow>(
      `SELECT m.ordinal, m.repository_key, m.repository_id AS member_repository_id,
              m.snapshot_id AS member_snapshot_id, p.*
       FROM workset_generation_members AS m
       JOIN repository_snapshots AS p ON p.projection_digest = m.projection_digest
       WHERE m.generation_id = ?
       ORDER BY m.ordinal
       LIMIT ?`,
      [generationId, CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration + 1],
    )
    .pipe(
      Effect.flatMap(rows =>
        validateStored(() =>
          rows.map((row, index) => {
            if (rows.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration) {
              throw corrupt('Workset generation member count exceeds the supported bound.');
            }
            const ordinal = requiredInteger(row.ordinal, 'generation member ordinal');
            if (ordinal !== index) throw corrupt('Workset generation member ordinals are not contiguous.');
            return {
              ...decodeWorksetScopeRow(row),
              ordinal,
              projection_digest: requiredText(row.projection_digest, 'projection digest'),
              repository_id: requiredText(row.member_repository_id, 'repository identity'),
              repository_key: requiredText(row.repository_key, 'repository key'),
              snapshot_id: requiredText(row.member_snapshot_id, 'snapshot identity'),
              worktree_id: requiredText(row.worktree_id, 'worktree identity'),
            };
          }),
        ),
      ),
    );
}

export function selectGeneration(sql: SqlClient.SqlClient, generationId: string) {
  return sql
    .unsafe<GenerationRow>(
      `SELECT id, workset_name, manifest_digest, generation_digest, state, member_count
       FROM workset_generations WHERE id = ? LIMIT 1`,
      [generationId],
    )
    .pipe(Effect.flatMap(rows => (rows.length === 0 ? succeedUndefined : decodeGenerationRow(rows[0]))));
}

export function decodeGenerationRow(row: GenerationRow) {
  return validateStored(() => {
    const state = requiredText(row.state, 'generation state');
    if (state !== 'ready' && state !== 'retired' && state !== 'staging') {
      throw corrupt('Workset generation state is invalid.');
    }
    const generationDigest = requiredText(row.generation_digest, 'generation digest');
    const id = requiredText(row.id, 'generation identity');
    const manifestDigest = requiredText(row.manifest_digest, 'manifest digest');
    const memberCount = requiredInteger(row.member_count, 'generation member count');
    if (
      !/^[0-9a-f]{64}$/u.test(generationDigest) ||
      !GENERATION_ID.test(id) ||
      !/^[0-9a-f]{64}$/u.test(manifestDigest) ||
      memberCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration
    ) {
      throw corrupt('Workset generation metadata is invalid.');
    }
    return {
      generation_digest: generationDigest,
      id,
      manifest_digest: manifestDigest,
      member_count: memberCount,
      state,
      workset_name: requiredText(row.workset_name, 'workset name'),
    } as const;
  });
}

export function generationReceipt(
  generation: Effect.Success<ReturnType<typeof decodeGenerationRow>>,
): CodeGraphWorksetCatalogGenerationReceiptV1 {
  if (generation.state === 'retired') throw corrupt('Retired generation cannot produce an active receipt.');
  return {
    digest: generation.generation_digest,
    id: generation.id,
    manifestDigest: generation.manifest_digest,
    memberCount: generation.member_count,
    state: generation.state,
    worksetName: generation.workset_name,
  };
}

export function generationIsPublished(sql: SqlClient.SqlClient, generationId: string, worksetName: string) {
  return rowCount(
    sql,
    'SELECT COUNT(*) AS count FROM published_worksets WHERE workset_name = ? AND generation_id = ?',
    [worksetName, generationId],
  ).pipe(Effect.map(count => count === 1));
}

export function initializeCatalogLayout(fs: FileSystem.FileSystem, layout: CodeGraphWorksetCatalogLayout) {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(layout.root, {recursive: true, mode: 0o700});
    yield* useCatalogWriteDatabase(
      layout.databasePath,
      Effect.gen(function* () {
        yield* initializeCodeGraphWorksetCatalogSchema(yield* SqlClient.SqlClient);
      }),
    );
    yield* fs.chmod(layout.databasePath, 0o600);
  });
}

export function inspectCatalogLayout(
  fs: FileSystem.FileSystem,
  layout: CodeGraphWorksetCatalogLayout,
): Effect.Effect<CodeGraphWorksetCatalogHealthV1, unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(layout.databasePath))) return {state: 'missing'} as const;
    const inspected = yield* Effect.exit(
      useCatalogReadDatabase(
        layout.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* configureCodeGraphWorksetCatalogReadConnection(sql);
          const schemaVersion = yield* inspectCodeGraphWorksetCatalogSchemaVersion(sql);
          if (schemaVersion !== CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION) {
            return {schemaVersion: schemaVersion ?? 0, state: 'incompatible'} as const;
          }
          const pageSize = yield* inspectCodeGraphWorksetCatalogPageSize(sql);
          if (pageSize !== CODE_GRAPH_WORKSET_CATALOG_PAGE_SIZE_BYTES) {
            return {schemaVersion, state: 'incompatible'} as const;
          }
          if (Exit.isFailure(yield* Effect.exit(validateWorksetScopeReadSchema(sql)))) {
            return {detail: 'Workset scope receipt schema validation failed.', state: 'corrupt'} as const;
          }
          const quick = yield* sql.unsafe<{readonly quick_check: unknown}>('PRAGMA quick_check');
          if (quick.length !== 1 || quick[0]?.quick_check !== 'ok') {
            return {detail: 'SQLite integrity validation failed.', state: 'corrupt'} as const;
          }
          const [projectionCount, publishedWorksets, readyGenerations, stagingGenerations] = yield* Effect.all(
            [
              rowCount(sql, 'SELECT COUNT(*) AS count FROM repository_snapshots'),
              rowCount(sql, 'SELECT COUNT(*) AS count FROM published_worksets'),
              rowCount(sql, "SELECT COUNT(*) AS count FROM workset_generations WHERE state = 'ready'"),
              rowCount(sql, "SELECT COUNT(*) AS count FROM workset_generations WHERE state = 'staging'"),
            ],
            {concurrency: 1},
          );
          return {
            projectionCount,
            publishedWorksets,
            readyGenerations,
            schemaVersion,
            stagingGenerations,
            state: 'ok',
          } as const;
        }),
      ),
    );
    if (Exit.isSuccess(inspected)) return inspected.value;
    const category = storageCauseCategory(inspected.cause);
    return category === 'corrupt'
      ? ({detail: 'SQLite reported malformed catalog data.', state: 'corrupt'} as const)
      : ({detail: 'The catalog could not be inspected safely.', state: 'unavailable'} as const);
  });
}

export function removeCatalogFiles(fs: FileSystem.FileSystem, layout: CodeGraphWorksetCatalogLayout) {
  return Effect.forEach(
    [layout.databasePath, `${layout.databasePath}-wal`, `${layout.databasePath}-shm`, `${layout.databasePath}-journal`],
    candidate => fs.remove(candidate, {force: true}),
    {concurrency: 1, discard: true},
  );
}

export function useCatalogWriteDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return useDatabaseDirect(databasePath, effect);
}

export function useCatalogReadDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return useDatabaseDirect(databasePath, effect, true);
}

export function rowCount(sql: SqlClient.SqlClient, statement: string, parameters: readonly unknown[] = []) {
  return sql.unsafe<{readonly count: unknown}>(statement, parameters).pipe(
    Effect.flatMap(rows =>
      validateStored(() => {
        if (rows.length !== 1) throw corrupt('Catalog count query returned an invalid row set.');
        return requiredInteger(rows[0].count, 'row count');
      }),
    ),
  );
}

export function changes(sql: SqlClient.SqlClient) {
  return rowCount(sql, 'SELECT changes() AS count');
}

export const currentIsoInstant = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export function readLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CODE_GRAPH_WORKSET_CATALOG_LIMITS.readPageMaximum) {
    throw invalid(
      `Workset catalog read limit must be between 1 and ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.readPageMaximum}.`,
    );
  }
  return limit;
}

export function retirementLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > CATALOG_RETIREMENT_LIMIT_MAXIMUM) {
    throw invalid(`Workset catalog retirement limit must be between 0 and ${CATALOG_RETIREMENT_LIMIT_MAXIMUM}.`);
  }
  return limit;
}

export function resultSetTtlMilliseconds(value: number | undefined): number {
  const ttl = value ?? CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetTtlMillisecondsDefault;
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    ttl > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetTtlMillisecondsMaximum
  ) {
    throw invalid(
      `Workset result-set TTL must be between 1 and ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetTtlMillisecondsMaximum} milliseconds.`,
    );
  }
  return ttl;
}

export function resultSetProjectorVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw invalid('Workset result-set projector version is invalid.');
  }
  return value;
}

export function resultSetPageLimit(value: number | undefined): number {
  const limit = value ?? 24;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetPageMaximum) {
    throw invalid(
      `Workset result-set page limit must be between 1 and ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetPageMaximum}.`,
    );
  }
  return limit;
}

export function resultSetMaintenanceLimit(value: number | undefined): number {
  const limit = value ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > RESULT_SET_MAINTENANCE_LIMIT_MAXIMUM) {
    throw invalid(
      `Workset result-set maintenance limit must be between 0 and ${RESULT_SET_MAINTENANCE_LIMIT_MAXIMUM}.`,
    );
  }
  return limit;
}

export function canonicalIso(value: string | undefined): string {
  if (value === undefined) throw new Error('Workset catalog instant is missing.');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('Workset catalog instant must be a canonical ISO value.');
  }
  return value;
}

export function optionalIsoInstant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalid('Workset catalog staging cutoff must be a canonical ISO instant.');
  }
  return value;
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw corrupt(`Catalog ${label} is invalid.`);
  return value;
}

export function requiredInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw corrupt(`Catalog ${label} is invalid.`);
  }
  return parsed;
}

export function requiredNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw corrupt(`Catalog ${label} is invalid.`);
  return parsed;
}

export function assertInputText(value: string, label: string, maximumBytes: number): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    containsControlCharacter(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw invalid(`Workset catalog ${label} is invalid.`);
  }
}

export function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function routingRowKey(ordinal: number, nodeId: string): string {
  return `${ordinal}\0${nodeId}`;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateInput<A>(evaluate: () => A): Effect.Effect<A, CodeGraphWorksetCatalogError> {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      Schema.is(CodeGraphWorksetCatalogError)(cause)
        ? cause
        : CodeGraphWorksetCatalogError.of('invalid-input', 'Workset catalog input is invalid.', {cause}),
  });
}

export function validateStored<A>(evaluate: () => A): Effect.Effect<A, CodeGraphWorksetCatalogError> {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      Schema.is(CodeGraphWorksetCatalogError)(cause)
        ? cause
        : CodeGraphWorksetCatalogError.of('corrupt', 'Workset catalog data is invalid.', {cause}),
  });
}

export function mapCatalogError(operation: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(cause => {
        if (Schema.is(CodeGraphWorksetCatalogError)(cause)) return cause;
        const category = storageCauseCategory(cause);
        return CodeGraphWorksetCatalogError.of(
          category,
          category === 'busy'
            ? `Timed out waiting to ${operation}.`
            : category === 'corrupt'
              ? `Cannot ${operation} because the disposable catalog is corrupt.`
              : `Unable to ${operation}.`,
          {cause},
        );
      }),
    );
}

export function storageCauseCategory(cause: unknown): 'busy' | 'corrupt' | 'storage' {
  const detail = String(cause).toLowerCase();
  if (detail.includes('locked') || detail.includes('busy') || detail.includes('filelocktimeout')) return 'busy';
  if (
    detail.includes('malformed') ||
    detail.includes('not a database') ||
    detail.includes('no such table') ||
    detail.includes('database disk image is malformed')
  ) {
    return 'corrupt';
  }
  return 'storage';
}

export function invalid(message: string): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('invalid-input', message);
}

export function corrupt(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('corrupt', message, cause === undefined ? undefined : {cause});
}
