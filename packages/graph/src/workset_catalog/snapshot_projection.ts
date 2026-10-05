import {Cause, Effect, Option, Predicate, Ref, Result, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from '../store/build/core.js';
import {classifyCodeGraphStoreFailure} from '../store/failure.js';
import {effectiveSnapshotParameters, effectiveSymbolsCte} from '../store/query/core.js';
import type {CodeGraphStoreShape} from '../store/shape.js';
import type {CodeGraphSnapshot} from '../types.js';
import {readSnapshotWorksetScopeReceipt, worksetScopeReceiptsMatch} from './scope_receipt.js';
import {
  codeGraphWorksetRoutingProjectionDigestAppendCanonical,
  codeGraphWorksetRoutingProjectionDigestComplete,
  codeGraphWorksetRoutingProjectionDigestStart,
  createCodeGraphWorksetRoutingProjection,
  normalizeCodeGraphWorksetRoutingSymbol,
} from './projection.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM,
  codeGraphWorksetRoutingProjectionLogicalBytesAppend,
  codeGraphWorksetRoutingProjectionPages,
} from './projection/storage.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogSpanV1,
  type CodeGraphWorksetRoutingProjectionV1,
  type CodeGraphWorksetRoutingProjectionReceiptV1,
  type CodeGraphWorksetRoutingSymbolV1,
  type CodeGraphWorksetRoutingTermV1,
  type CodeGraphWorksetScopeReceiptV1,
} from './types.js';

const DEFAULT_PAGE_SIZE = 256;
const MAXIMUM_PAGE_SIZE = CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM;
const DEFAULT_LEASE_MILLISECONDS = 2 * 60_000;
const MINIMUM_LEASE_MILLISECONDS = 30_000;
const MAXIMUM_LEASE_MILLISECONDS = 10 * 60_000;
const MAXIMUM_LOOKUP_JSON_BYTES = 256 * 1_024;
const MAXIMUM_SPAN_JSON_BYTES = 4 * 1_024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const PROJECTION_LOOKUP_TABLE = 'workset_projection_lookup';
const PROJECTION_TERMS_TABLE = 'workset_projection_terms';
const PROJECTION_LOOKUP_MATERIALIZATION_SQL = `WITH effective_lookup AS (
  SELECT lookup.symbol_id, lookup.lookup_key
  FROM snapshot_symbol_lookup AS lookup
  WHERE lookup.snapshot_id = ?
  UNION ALL
  SELECT lookup.symbol_id, lookup.lookup_key
  FROM snapshot_symbol_lookup AS lookup
  WHERE lookup.snapshot_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM symbols AS overrides
      WHERE overrides.snapshot_id = ? AND overrides.id = lookup.symbol_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM snapshot_symbol_deletions AS deletions
      WHERE deletions.snapshot_id = ? AND deletions.symbol_id = lookup.symbol_id
    )
)
INSERT INTO temp.${PROJECTION_LOOKUP_TABLE} (symbol_id, lookup_key)
SELECT symbol_id, lookup_key
FROM effective_lookup
WHERE TRUE
ON CONFLICT(symbol_id, lookup_key) DO NOTHING`;
const PROJECTION_TERMS_MATERIALIZATION_SQL = `WITH effective_terms AS (
  SELECT legacy.symbol_id, legacy.term, legacy.weight
  FROM symbol_terms AS legacy
  WHERE legacy.snapshot_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM lexical_storage_formats AS storage
      WHERE storage.snapshot_id = legacy.snapshot_id
    )
  UNION ALL
  SELECT compact_symbol.symbol_id, compact_term.term, posting.weight
  FROM lexical_compact_snapshots AS compact_snapshot
  JOIN lexical_storage_formats AS storage
    ON storage.snapshot_id = compact_snapshot.snapshot_id
   AND storage.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
  JOIN lexical_compact_terms AS compact_term
    ON compact_term.snapshot_key = compact_snapshot.snapshot_key
  JOIN lexical_compact_postings AS posting
    ON posting.snapshot_key = compact_snapshot.snapshot_key
   AND posting.term_key = compact_term.term_key
  JOIN lexical_compact_symbols AS compact_symbol
    ON compact_symbol.snapshot_key = compact_snapshot.snapshot_key
   AND compact_symbol.symbol_key = posting.symbol_key
  WHERE compact_snapshot.snapshot_id = ?
  UNION ALL
  SELECT legacy.symbol_id, legacy.term, legacy.weight
  FROM symbol_terms AS legacy
  WHERE legacy.snapshot_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM lexical_storage_formats AS storage
      WHERE storage.snapshot_id = legacy.snapshot_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM symbols AS overrides
      WHERE overrides.snapshot_id = ? AND overrides.id = legacy.symbol_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM snapshot_symbol_deletions AS deletions
      WHERE deletions.snapshot_id = ? AND deletions.symbol_id = legacy.symbol_id
    )
  UNION ALL
  SELECT compact_symbol.symbol_id, compact_term.term, posting.weight
  FROM lexical_compact_snapshots AS compact_snapshot
  JOIN lexical_storage_formats AS storage
    ON storage.snapshot_id = compact_snapshot.snapshot_id
   AND storage.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
  JOIN lexical_compact_terms AS compact_term
    ON compact_term.snapshot_key = compact_snapshot.snapshot_key
  JOIN lexical_compact_postings AS posting
    ON posting.snapshot_key = compact_snapshot.snapshot_key
   AND posting.term_key = compact_term.term_key
  JOIN lexical_compact_symbols AS compact_symbol
    ON compact_symbol.snapshot_key = compact_snapshot.snapshot_key
   AND compact_symbol.symbol_key = posting.symbol_key
  WHERE compact_snapshot.snapshot_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM symbols AS overrides
      WHERE overrides.snapshot_id = ? AND overrides.id = compact_symbol.symbol_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM snapshot_symbol_deletions AS deletions
      WHERE deletions.snapshot_id = ? AND deletions.symbol_id = compact_symbol.symbol_id
    )
)
INSERT INTO temp.${PROJECTION_TERMS_TABLE} (symbol_id, term, weight)
SELECT symbol_id, term, weight
FROM effective_terms
WHERE TRUE
ON CONFLICT(symbol_id, term) DO UPDATE
SET weight = MAX(${PROJECTION_TERMS_TABLE}.weight, excluded.weight)`;

export interface CodeGraphReadySnapshotRoutingProjectionInputV1 {
  readonly scopeId?: string;
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly leaseDurationMilliseconds?: number;
  readonly pageSize?: number;
  readonly repositoryId: string;
  /** When omitted, project the active ready snapshot for `worktreeId`. */
  readonly snapshotId?: string;
  /** @internal Test/benchmark observer for the largest live normalized symbol page. */
  readonly observeBufferedSymbols?: (count: number) => void;
  /** @internal Test/benchmark observer for the session-local reverse routing surface. */
  readonly observePreparedRoutingSurface?: (counts: {readonly lookupKeys: number; readonly terms: number}) => void;
  readonly worktreeId: string;
}

export interface CodeGraphReadySnapshotRoutingProjectionStatsV1 {
  readonly componentCount: number;
  readonly dependencyCount: number;
  readonly lookupKeysOmitted: number;
  readonly lookupKeysObserved: number;
  readonly pagesRead: number;
  readonly symbolsRead: number;
  readonly termsOmitted: number;
  readonly termsObserved: number;
}

export interface CodeGraphReadySnapshotRoutingProjectionBuildV1 {
  readonly projection: CodeGraphWorksetRoutingProjectionV1;
  readonly stats: CodeGraphReadySnapshotRoutingProjectionStatsV1;
}

export interface CodeGraphReadySnapshotRoutingProjectionScopedBuildV1 extends CodeGraphReadySnapshotRoutingProjectionBuildV1 {
  /** Refresh and verify the still-scoped source-snapshot lease before publication. */
  readonly assertLease: Effect.Effect<void, CodeGraphWorksetCatalogError>;
}

export interface CodeGraphReadySnapshotRoutingProjectionStreamBuildV1 {
  readonly assertLease: Effect.Effect<void, CodeGraphWorksetCatalogError>;
  readonly receipt: CodeGraphWorksetRoutingProjectionReceiptV1;
  readonly stats: CodeGraphReadySnapshotRoutingProjectionStatsV1;
}

export interface CodeGraphReadySnapshotRoutingProjectionSinkV1<E, R> {
  readonly append: (
    projectionDigest: string,
    stagingToken: string,
    symbols: readonly CodeGraphWorksetRoutingSymbolV1[],
  ) => Effect.Effect<void, E, R>;
  readonly begin: (
    receipt: CodeGraphWorksetRoutingProjectionReceiptV1,
    reservedLogicalBytes: number,
  ) => Effect.Effect<{readonly state: 'ready'} | {readonly stagingToken: string; readonly state: 'staging'}, E, R>;
  readonly complete: (projectionDigest: string, stagingToken: string) => Effect.Effect<void, E, R>;
}

interface SnapshotProjectionRow {
  readonly scope: CodeGraphWorksetScopeReceiptV1;
  readonly base_snapshot_id: unknown;
  readonly commit_id: unknown;
  readonly dirty: unknown;
  readonly edge_count: unknown;
  readonly extractor_set: unknown;
  readonly graph_content_id: unknown;
  readonly overlay_fingerprint: unknown;
  readonly repository_id: unknown;
  readonly snapshot_id: unknown;
  readonly symbol_count: unknown;
}

interface ExtractorGenerationRow {
  readonly generation: unknown;
}

interface CountRow {
  readonly count: unknown;
}

interface SymbolProjectionRow {
  readonly exported: unknown;
  readonly id: unknown;
  readonly kind: unknown;
  readonly language: unknown;
  readonly lookup_keys_json: unknown;
  readonly name: unknown;
  readonly package_name: unknown;
  readonly path: unknown;
  readonly qualified_name: unknown;
  readonly span_json: unknown;
}

interface LookupProjectionRow {
  readonly lookup_key: unknown;
  readonly symbol_id: unknown;
}

interface TermProjectionRow {
  readonly symbol_id: unknown;
  readonly term: unknown;
  readonly weight: unknown;
}

interface AnalysisReceiptRow {
  readonly digest: unknown;
  readonly edge_count: unknown;
  readonly symbol_count: unknown;
  readonly version: unknown;
}

interface ComponentReceiptRow {
  readonly digest: unknown;
  readonly edge_count: unknown;
  readonly row_count: unknown;
  readonly version: unknown;
}

interface LexicalReceiptRow {
  readonly format_version: unknown;
  readonly posting_count: unknown;
  readonly snapshot_id: unknown;
  readonly symbol_count: unknown;
  readonly term_count: unknown;
}

interface MutableProjectionStats {
  componentCount: number;
  dependencyCount: number;
  lookupKeysOmitted: number;
  lookupKeysObserved: number;
  pagesRead: number;
  symbolsRead: number;
  termsOmitted: number;
  termsObserved: number;
}

/**
 * Derive a compact workset routing projection from one active ready snapshot.
 *
 * The snapshot is leased before the read-only session opens. The session reads
 * only routing metadata and keyset-pages symbol rows; source bodies,
 * documentation, signatures, and file contents are never selected.
 */
export const buildCodeGraphReadySnapshotRoutingProjectionScoped = Effect.fn(
  'codeGraphWorksetCatalog.buildReadySnapshotProjectionScoped',
)(function* (store: CodeGraphStoreShape, input: CodeGraphReadySnapshotRoutingProjectionInputV1) {
  const normalized = yield* normalizeInput(input);
  const selected = yield* store
    .readySnapshot(normalized.databasePath, normalized.worktreeId, normalized.scopeId)
    .pipe(Effect.mapError(cause => storage('Unable to select a ready code graph snapshot.', cause)));
  if (!selected) {
    return yield* missing('No active ready code graph snapshot exists for this worktree.');
  }
  if (normalized.snapshotId !== undefined && selected.id !== normalized.snapshotId) {
    return yield* missing('The requested ready snapshot is not active for this worktree.');
  }
  if (selected.repositoryId !== normalized.repositoryId || selected.state !== 'ready') {
    return yield* corrupt('The active ready snapshot has inconsistent repository provenance.');
  }
  if (selected.symbolCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
    return yield* invalid('The ready snapshot has more symbols than one routing projection can represent.');
  }

  const lease = yield* Effect.acquireRelease(
    store
      .acquireSnapshotLease(normalized.databasePath, selected.id, normalized.leaseDurationMilliseconds)
      .pipe(Effect.mapError(cause => storage('Unable to lease the ready code graph snapshot.', cause))),
    lease => store.releaseSnapshotLease(normalized.databasePath, lease).pipe(Effect.ignore),
  );
  const renewalFailure = yield* Ref.make<unknown | undefined>(undefined);
  const renewalIntervalMilliseconds = Math.max(1_000, Math.floor(normalized.leaseDurationMilliseconds / 3));
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(renewalIntervalMilliseconds).pipe(
        Effect.andThen(store.renewSnapshotLease(normalized.databasePath, lease, normalized.leaseDurationMilliseconds)),
      ),
    ).pipe(Effect.catchCause(cause => Ref.set(renewalFailure, Cause.squash(cause)))),
  );
  const built = yield* store
    .withSession(normalized.databasePath, readProjection(selected, normalized), {
      readOnly: true,
    })
    .pipe(
      Effect.mapError(cause =>
        Schema.is(CodeGraphWorksetCatalogError)(cause)
          ? cause
          : storage('Unable to read the ready code graph routing surface.', cause),
      ),
    );
  const assertLease = Ref.get(renewalFailure).pipe(
    Effect.flatMap(failure =>
      failure === undefined
        ? store
            .renewSnapshotLease(normalized.databasePath, lease, normalized.leaseDurationMilliseconds)
            .pipe(Effect.mapError(cause => storage('The routing projection snapshot lease is no longer valid.', cause)))
        : Effect.fail(storage('The routing projection snapshot lease could not be renewed.', failure)),
    ),
    Effect.andThen(
      store
        .readySnapshot(normalized.databasePath, normalized.worktreeId, normalized.scopeId)
        .pipe(Effect.mapError(cause => storage('Unable to revalidate the routing projection snapshot.', cause))),
    ),
    Effect.flatMap(active =>
      active?.id === selected.id && active.repositoryId === selected.repositoryId
        ? Effect.void
        : Effect.fail(missing('The routing projection snapshot is no longer active for its worktree.')),
    ),
  );
  return {...built, assertLease} satisfies CodeGraphReadySnapshotRoutingProjectionScopedBuildV1;
});

/** Two-pass, page-bounded projection: digest first, then append the same leased snapshot to a sink. */
export const streamCodeGraphReadySnapshotRoutingProjectionScoped = Effect.fn(
  'codeGraphWorksetCatalog.streamReadySnapshotProjectionScoped',
)(function* <E, R>(
  store: CodeGraphStoreShape,
  input: CodeGraphReadySnapshotRoutingProjectionInputV1,
  sink: CodeGraphReadySnapshotRoutingProjectionSinkV1<E, R>,
) {
  const normalized = yield* normalizeInput(input);
  const selected = yield* store
    .readySnapshot(normalized.databasePath, normalized.worktreeId, normalized.scopeId)
    .pipe(Effect.mapError(cause => storage('Unable to select a ready code graph snapshot.', cause)));
  if (!selected) return yield* missing('No active ready code graph snapshot exists for this worktree.');
  if (normalized.snapshotId !== undefined && selected.id !== normalized.snapshotId) {
    return yield* missing('The requested ready snapshot is not active for this worktree.');
  }
  if (selected.repositoryId !== normalized.repositoryId || selected.state !== 'ready') {
    return yield* corrupt('The active ready snapshot has inconsistent repository provenance.');
  }
  if (selected.symbolCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
    return yield* invalid('The ready snapshot has more symbols than one routing projection can represent.');
  }
  const lease = yield* Effect.acquireRelease(
    store
      .acquireSnapshotLease(normalized.databasePath, selected.id, normalized.leaseDurationMilliseconds)
      .pipe(Effect.mapError(cause => storage('Unable to lease the ready code graph snapshot.', cause))),
    lease => store.releaseSnapshotLease(normalized.databasePath, lease).pipe(Effect.ignore),
  );
  const renewalFailure = yield* Ref.make<unknown | undefined>(undefined);
  const renewalIntervalMilliseconds = Math.max(1_000, Math.floor(normalized.leaseDurationMilliseconds / 3));
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(renewalIntervalMilliseconds).pipe(
        Effect.andThen(store.renewSnapshotLease(normalized.databasePath, lease, normalized.leaseDurationMilliseconds)),
      ),
    ).pipe(Effect.catchCause(cause => Ref.set(renewalFailure, Cause.squash(cause)))),
  );
  const built = yield* store
    .withSession(normalized.databasePath, readProjectionStreamed(selected, normalized, sink), {readOnly: true})
    .pipe(
      Effect.mapError(cause =>
        Schema.is(CodeGraphWorksetCatalogError)(cause)
          ? cause
          : storage('Unable to stream the ready code graph routing surface.', cause),
      ),
    );
  const assertLease = Ref.get(renewalFailure).pipe(
    Effect.flatMap(failure =>
      failure === undefined
        ? store
            .renewSnapshotLease(normalized.databasePath, lease, normalized.leaseDurationMilliseconds)
            .pipe(Effect.mapError(cause => storage('The routing projection snapshot lease is no longer valid.', cause)))
        : Effect.fail(storage('The routing projection snapshot lease could not be renewed.', failure)),
    ),
    Effect.andThen(
      store
        .readySnapshot(normalized.databasePath, normalized.worktreeId, normalized.scopeId)
        .pipe(Effect.mapError(cause => storage('Unable to revalidate the routing projection snapshot.', cause))),
    ),
    Effect.flatMap(active =>
      active?.id === selected.id && active.repositoryId === selected.repositoryId
        ? Effect.void
        : Effect.fail(missing('The routing projection snapshot is no longer active for its worktree.')),
    ),
  );
  return {...built, assertLease} satisfies CodeGraphReadySnapshotRoutingProjectionStreamBuildV1;
});

/** Build one projection and release its lease when the projection returns. */
export const buildCodeGraphReadySnapshotRoutingProjection = Effect.fn(
  'codeGraphWorksetCatalog.buildReadySnapshotProjection',
)(function* (store: CodeGraphStoreShape, input: CodeGraphReadySnapshotRoutingProjectionInputV1) {
  const {assertLease: _assertLease, ...built} = yield* buildCodeGraphReadySnapshotRoutingProjectionScoped(
    store,
    input,
  ).pipe(Effect.scoped);
  return built;
});

function readProjection(selected: CodeGraphSnapshot, input: NormalizedProjectionInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* configureProjectionTemporaryStorage(sql);
    const before = yield* selectProjectionSnapshot(
      sql,
      selected.id,
      input.repositoryId,
      input.worktreeId,
      input.scopeId,
    );
    validateSelectedSnapshot(before, selected);
    const baseSnapshotId = optionalText(before.base_snapshot_id, 'base snapshot identity');
    const extractorGeneration = yield* selectExtractorGeneration(sql, selected.id);
    const componentCount = yield* selectCount(
      sql,
      'SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ?',
      [selected.id],
      'workspace component count',
    );
    const dependencyCount = yield* selectCount(
      sql,
      'SELECT COUNT(*) AS count FROM workspace_component_dependencies WHERE snapshot_id = ?',
      [selected.id],
      'workspace dependency count',
    );
    const analysisReceipt = yield* selectAnalysisReceipt(sql, selected.id);
    const componentReceipt = yield* selectComponentReceipt(sql, selected.id);
    const lexicalReceipts = yield* selectLexicalReceipts(sql, selected.id, baseSnapshotId);
    const expectedSymbolCount = safeCount(before.symbol_count, 'snapshot symbol count');
    validateOptionalReceipts(
      analysisReceipt,
      componentReceipt,
      lexicalReceipts,
      expectedSymbolCount,
      safeCount(before.edge_count, 'snapshot edge count'),
    );
    if (expectedSymbolCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
      return yield* invalid('The ready snapshot has more symbols than one routing projection can represent.');
    }
    yield* prepareCodeGraphWorksetProjectionRoutingSurface(
      sql,
      selected.id,
      baseSnapshotId,
      input.observePreparedRoutingSurface,
    );

    const stats: MutableProjectionStats = {
      componentCount,
      dependencyCount,
      lookupKeysOmitted: 0,
      lookupKeysObserved: 0,
      pagesRead: 0,
      symbolsRead: 0,
      termsOmitted: 0,
      termsObserved: 0,
    };
    const symbols: CodeGraphWorksetRoutingSymbolV1[] = [];
    let afterNodeId = '';
    for (;;) {
      const page = yield* selectSymbolPage(sql, selected.id, baseSnapshotId, afterNodeId, input.pageSize);
      if (page.length === 0) break;
      stats.pagesRead += 1;
      const nodeIds = page.map(row => requiredText(row.id, 'symbol identity'));
      const lookupRows = yield* selectLookupRows(sql, nodeIds);
      const termRows = yield* selectTermRows(sql, nodeIds);
      const lookupBySymbol = groupLookupRows(lookupRows);
      const termsBySymbol = groupTermRows(termRows);

      for (const row of page) {
        const nodeId = requiredText(row.id, 'symbol identity');
        const intrinsicLookupKeys = decodeLookupKeys(row.lookup_keys_json);
        const routedLookupKeys = selectLookupKeys(intrinsicLookupKeys, lookupBySymbol.get(nodeId) ?? [], stats);
        const routedTerms = selectTerms(termsBySymbol.get(nodeId) ?? [], stats);
        symbols.push({
          exported: booleanInteger(row.exported, 'symbol exported state'),
          kind: requiredText(row.kind, 'symbol kind'),
          language: requiredText(row.language, 'symbol language'),
          lookupKeys: routedLookupKeys,
          name: requiredText(row.name, 'symbol name'),
          nodeId,
          ...(row.package_name === null ? {} : {packageName: requiredText(row.package_name, 'symbol package name')}),
          path: requiredText(row.path, 'symbol path'),
          qualifiedName: requiredText(row.qualified_name, 'symbol qualified name'),
          span: decodeSpan(row.span_json),
          terms: routedTerms,
        });
      }
      stats.symbolsRead += page.length;
      afterNodeId = nodeIds.at(-1)!;
      if (page.length < input.pageSize) break;
      yield* Effect.yieldNow;
    }
    if (symbols.length !== expectedSymbolCount || symbols.length !== selected.symbolCount) {
      return yield* corrupt('The effective routing symbol count does not match the ready snapshot receipt.');
    }

    const after = yield* selectProjectionSnapshot(
      sql,
      selected.id,
      input.repositoryId,
      input.worktreeId,
      input.scopeId,
    );
    if (!sameSnapshotProjectionRow(before, after)) {
      return yield* corrupt('The active ready snapshot changed while its routing projection was read.');
    }
    const snapshotDigest = readySnapshotProjectionDigest({
      baseSnapshotId,
      commitId: requiredText(before.commit_id, 'snapshot commit identity'),
      componentCount,
      dependencyCount,
      dirty: booleanInteger(before.dirty, 'snapshot dirty state'),
      extractorGeneration,
      extractorSet: requiredText(before.extractor_set, 'snapshot extractor set'),
      graphContentId: optionalText(before.graph_content_id, 'graph content identity'),
      lookupKeysObserved: stats.lookupKeysObserved,
      overlayFingerprint: optionalText(before.overlay_fingerprint, 'snapshot overlay fingerprint'),
      repositoryId: input.repositoryId,
      snapshotId: selected.id,
      symbolCount: symbols.length,
      termsObserved: stats.termsObserved,
    });
    const projection = yield* Effect.try({
      try: () =>
        createCodeGraphWorksetRoutingProjection({
          ...before.scope,
          checkoutId: input.checkoutId,
          commitId: requiredText(before.commit_id, 'snapshot commit identity'),
          componentCount,
          extractorGeneration,
          projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
          repositoryId: input.repositoryId,
          snapshotDigest,
          snapshotId: selected.id,
          symbols,
          worktreeId: input.worktreeId,
        }),
      catch: cause => corrupt('The ready snapshot contains an invalid routing projection surface.', cause),
    });
    return {projection, stats: {...stats}};
  }).pipe(
    Effect.catchCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      const failure = Cause.findErrorOption(cause);
      if (Option.isSome(failure)) return Effect.fail(failure.value);
      const defect = Cause.findDefect(cause);
      if (Result.isSuccess(defect) && Schema.is(CodeGraphWorksetCatalogError)(defect.success)) {
        return Effect.fail(defect.success);
      }
      return Effect.fail(corrupt('The ready snapshot routing surface could not be decoded.', Cause.squash(cause)));
    }),
  );
}

function readProjectionStreamed<E, R>(
  selected: CodeGraphSnapshot,
  input: NormalizedProjectionInput,
  sink: CodeGraphReadySnapshotRoutingProjectionSinkV1<E, R>,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* configureProjectionTemporaryStorage(sql);
    const before = yield* selectProjectionSnapshot(
      sql,
      selected.id,
      input.repositoryId,
      input.worktreeId,
      input.scopeId,
    );
    validateSelectedSnapshot(before, selected);
    const baseSnapshotId = optionalText(before.base_snapshot_id, 'base snapshot identity');
    const extractorGeneration = yield* selectExtractorGeneration(sql, selected.id);
    const componentCount = yield* selectCount(
      sql,
      'SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ?',
      [selected.id],
      'workspace component count',
    );
    const dependencyCount = yield* selectCount(
      sql,
      'SELECT COUNT(*) AS count FROM workspace_component_dependencies WHERE snapshot_id = ?',
      [selected.id],
      'workspace dependency count',
    );
    const expectedSymbolCount = safeCount(before.symbol_count, 'snapshot symbol count');
    validateOptionalReceipts(
      yield* selectAnalysisReceipt(sql, selected.id),
      yield* selectComponentReceipt(sql, selected.id),
      yield* selectLexicalReceipts(sql, selected.id, baseSnapshotId),
      expectedSymbolCount,
      safeCount(before.edge_count, 'snapshot edge count'),
    );
    yield* prepareCodeGraphWorksetProjectionRoutingSurface(
      sql,
      selected.id,
      baseSnapshotId,
      input.observePreparedRoutingSurface,
    );
    const stats = projectionStats(componentCount, dependencyCount);
    let reservedLogicalBytes = 0;
    const firstPass = yield* scanProjectionSymbolPages(sql, selected.id, baseSnapshotId, input, stats, symbols =>
      Effect.try({
        try: () => {
          reservedLogicalBytes = codeGraphWorksetRoutingProjectionLogicalBytesAppend(reservedLogicalBytes, symbols);
        },
        catch: cause =>
          Schema.is(CodeGraphWorksetCatalogError)(cause)
            ? cause
            : corrupt('The routing projection storage charge is invalid.', cause),
      }),
    );
    if (firstPass.symbolCount !== expectedSymbolCount || firstPass.symbolCount !== selected.symbolCount) {
      return yield* corrupt('The effective routing symbol count does not match the ready snapshot receipt.');
    }
    yield* validateProjectionSnapshotUnchanged(sql, selected, input, before);
    const snapshotDigest = readySnapshotProjectionDigest({
      baseSnapshotId,
      commitId: requiredText(before.commit_id, 'snapshot commit identity'),
      componentCount,
      dependencyCount,
      dirty: booleanInteger(before.dirty, 'snapshot dirty state'),
      extractorGeneration,
      extractorSet: requiredText(before.extractor_set, 'snapshot extractor set'),
      graphContentId: optionalText(before.graph_content_id, 'graph content identity'),
      lookupKeysObserved: stats.lookupKeysObserved,
      overlayFingerprint: optionalText(before.overlay_fingerprint, 'snapshot overlay fingerprint'),
      repositoryId: input.repositoryId,
      snapshotId: selected.id,
      symbolCount: expectedSymbolCount,
      termsObserved: stats.termsObserved,
    });
    const header = {
      ...before.scope,
      checkoutId: input.checkoutId,
      commitId: requiredText(before.commit_id, 'snapshot commit identity'),
      componentCount,
      extractorGeneration,
      projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
      repositoryId: input.repositoryId,
      snapshotDigest,
      snapshotId: selected.id,
      symbolCount: expectedSymbolCount,
      worktreeId: input.worktreeId,
    } as const;
    const projectionDigest = yield* Effect.try({
      try: () => codeGraphWorksetRoutingProjectionDigestComplete(header, firstPass),
      catch: cause => corrupt('The ready snapshot contains an invalid streamed projection surface.', cause),
    });
    const receipt = {...header, projectionDigest} satisfies CodeGraphWorksetRoutingProjectionReceiptV1;
    const begun = yield* sink.begin(receipt, reservedLogicalBytes);
    if (begun.state === 'staging') {
      // Re-read the immutable source surface for the verification/publication
      // pass. Reusing the first TEMP projection would make lookup/term drift
      // invisible to the existing cross-pass digest fence.
      yield* prepareCodeGraphWorksetProjectionRoutingSurface(
        sql,
        selected.id,
        baseSnapshotId,
        input.observePreparedRoutingSurface,
      );
      const verificationStats = projectionStats(componentCount, dependencyCount);
      const secondPass = yield* scanProjectionSymbolPages(
        sql,
        selected.id,
        baseSnapshotId,
        input,
        verificationStats,
        symbols => appendBoundedProjectionPages(sink, projectionDigest, begun.stagingToken, symbols),
      );
      if (
        codeGraphWorksetRoutingProjectionDigestComplete(header, secondPass) !== projectionDigest ||
        JSON.stringify(verificationStats) !== JSON.stringify(stats)
      ) {
        return yield* corrupt('The ready snapshot routing projection changed between streaming passes.');
      }
      yield* validateProjectionSnapshotUnchanged(sql, selected, input, before);
      yield* sink.complete(projectionDigest, begun.stagingToken);
    }
    return {receipt, stats: {...stats}};
  }).pipe(
    Effect.catchCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      const failure = Cause.findErrorOption(cause);
      if (Option.isSome(failure)) return Effect.fail(failure.value);
      const defect = Cause.findDefect(cause);
      if (Result.isSuccess(defect) && Schema.is(CodeGraphWorksetCatalogError)(defect.success)) {
        return Effect.fail(defect.success);
      }
      return Effect.fail(corrupt('The ready snapshot routing surface could not be streamed.', Cause.squash(cause)));
    }),
  );
}

function projectionStats(componentCount: number, dependencyCount: number): MutableProjectionStats {
  return {
    componentCount,
    dependencyCount,
    lookupKeysOmitted: 0,
    lookupKeysObserved: 0,
    pagesRead: 0,
    symbolsRead: 0,
    termsOmitted: 0,
    termsObserved: 0,
  };
}

function appendBoundedProjectionPages<E, R>(
  sink: CodeGraphReadySnapshotRoutingProjectionSinkV1<E, R>,
  projectionDigest: string,
  stagingToken: string,
  symbols: readonly CodeGraphWorksetRoutingSymbolV1[],
) {
  return Effect.gen(function* () {
    for (const page of codeGraphWorksetRoutingProjectionPages(symbols)) {
      yield* sink.append(projectionDigest, stagingToken, page);
    }
  });
}

function scanProjectionSymbolPages<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  input: NormalizedProjectionInput,
  stats: MutableProjectionStats,
  emit: (symbols: readonly CodeGraphWorksetRoutingSymbolV1[]) => Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    let digestState = codeGraphWorksetRoutingProjectionDigestStart();
    let afterNodeId = '';
    for (;;) {
      const page = yield* selectSymbolPage(sql, snapshotId, baseSnapshotId, afterNodeId, input.pageSize);
      if (page.length === 0) break;
      stats.pagesRead += 1;
      const nodeIds = page.map(row => requiredText(row.id, 'symbol identity'));
      const lookupBySymbol = groupLookupRows(yield* selectLookupRows(sql, nodeIds));
      const termsBySymbol = groupTermRows(yield* selectTermRows(sql, nodeIds));
      const symbols: CodeGraphWorksetRoutingSymbolV1[] = page.map(row => {
        const nodeId = requiredText(row.id, 'symbol identity');
        return normalizeCodeGraphWorksetRoutingSymbol({
          exported: booleanInteger(row.exported, 'symbol exported state'),
          kind: requiredText(row.kind, 'symbol kind'),
          language: requiredText(row.language, 'symbol language'),
          lookupKeys: selectLookupKeys(decodeLookupKeys(row.lookup_keys_json), lookupBySymbol.get(nodeId) ?? [], stats),
          name: requiredText(row.name, 'symbol name'),
          nodeId,
          ...(row.package_name === null ? {} : {packageName: requiredText(row.package_name, 'symbol package name')}),
          path: requiredText(row.path, 'symbol path'),
          qualifiedName: requiredText(row.qualified_name, 'symbol qualified name'),
          span: decodeSpan(row.span_json),
          terms: selectTerms(termsBySymbol.get(nodeId) ?? [], stats),
        });
      });
      const appendedState = yield* Effect.try({
        try: () => codeGraphWorksetRoutingProjectionDigestAppendCanonical(digestState, symbols),
        catch: cause => corrupt('The ready snapshot contains an invalid routing projection page.', cause),
      });
      input.observeBufferedSymbols?.(symbols.length);
      yield* emit(symbols);
      digestState = appendedState;
      stats.symbolsRead += symbols.length;
      afterNodeId = nodeIds.at(-1)!;
      if (page.length < input.pageSize) break;
      yield* Effect.yieldNow;
    }
    return digestState;
  });
}

function validateProjectionSnapshotUnchanged(
  sql: SqlClient.SqlClient,
  selected: CodeGraphSnapshot,
  input: NormalizedProjectionInput,
  before: SnapshotProjectionRow,
) {
  return Effect.gen(function* () {
    const after = yield* selectProjectionSnapshot(
      sql,
      selected.id,
      input.repositoryId,
      input.worktreeId,
      input.scopeId,
    );
    if (!sameSnapshotProjectionRow(before, after)) {
      return yield* corrupt('The active ready snapshot changed while its routing projection was read.');
    }
  });
}

interface NormalizedProjectionInput {
  readonly scopeId?: string;
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly leaseDurationMilliseconds: number;
  readonly pageSize: number;
  readonly observeBufferedSymbols?: (count: number) => void;
  readonly observePreparedRoutingSurface?: (counts: {readonly lookupKeys: number; readonly terms: number}) => void;
  readonly repositoryId: string;
  readonly snapshotId?: string;
  readonly worktreeId: string;
}

function normalizeInput(
  input: CodeGraphReadySnapshotRoutingProjectionInputV1,
): Effect.Effect<NormalizedProjectionInput, CodeGraphWorksetCatalogError> {
  return Effect.try({
    try: () => {
      if (!SHA256_HEX.test(input.checkoutId)) throw invalid('Workset projection checkout identity is invalid.');
      if (!SHA256_HEX.test(input.repositoryId)) throw invalid('Workset projection repository identity is invalid.');
      if (!SHA256_HEX.test(input.worktreeId)) throw invalid('Workset projection worktree identity is invalid.');
      if (
        typeof input.databasePath !== 'string' ||
        input.databasePath.length === 0 ||
        input.databasePath.includes('\0')
      ) {
        throw invalid('Workset projection database path is invalid.');
      }
      if (
        input.snapshotId !== undefined &&
        (input.snapshotId.length === 0 || input.snapshotId.length > 256 || input.snapshotId.includes('\0'))
      ) {
        throw invalid('Workset projection snapshot identity is invalid.');
      }
      const pageSize = boundedInteger(input.pageSize, DEFAULT_PAGE_SIZE, 1, MAXIMUM_PAGE_SIZE, 'page size');
      const leaseDurationMilliseconds = boundedInteger(
        input.leaseDurationMilliseconds,
        DEFAULT_LEASE_MILLISECONDS,
        MINIMUM_LEASE_MILLISECONDS,
        MAXIMUM_LEASE_MILLISECONDS,
        'lease duration',
      );
      return {
        scopeId: input.scopeId,
        checkoutId: input.checkoutId,
        databasePath: input.databasePath,
        leaseDurationMilliseconds,
        pageSize,
        ...(input.observeBufferedSymbols === undefined ? {} : {observeBufferedSymbols: input.observeBufferedSymbols}),
        ...(input.observePreparedRoutingSurface === undefined
          ? {}
          : {observePreparedRoutingSurface: input.observePreparedRoutingSurface}),
        repositoryId: input.repositoryId,
        ...(input.snapshotId === undefined ? {} : {snapshotId: input.snapshotId}),
        worktreeId: input.worktreeId,
      };
    },
    catch: cause =>
      Schema.is(CodeGraphWorksetCatalogError)(cause)
        ? cause
        : invalid('Workset routing projection input is invalid.', cause),
  });
}

function selectProjectionSnapshot(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  repositoryId: string,
  worktreeId: string,
  scopeId = 'full-repository',
) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<Omit<SnapshotProjectionRow, 'scope'>>(
      `SELECT snapshot.id AS snapshot_id, snapshot.repository_id, snapshot.commit_id,
              snapshot.graph_content_id, snapshot.base_snapshot_id, snapshot.extractor_set,
              snapshot.dirty, snapshot.overlay_fingerprint, snapshot.symbol_count,
              snapshot.edge_count
       FROM active_snapshots AS active
       JOIN snapshots AS snapshot ON snapshot.id = active.snapshot_id
       WHERE active.worktree_id = ?
         AND active.scope_id = ?
         AND active.snapshot_id = ?
         AND snapshot.repository_id = ?
         AND snapshot.scope_id = active.scope_id
         AND snapshot.state = 'ready'
         AND NOT EXISTS (
           SELECT 1 FROM removed_views AS removed
           WHERE removed.worktree_id = active.worktree_id
             AND removed.scope_id = active.scope_id
             AND removed.expected_snapshot_id = active.snapshot_id
         )
       LIMIT 2`,
      [worktreeId, scopeId, snapshotId, repositoryId],
    );
    if (rows.length !== 1) {
      return yield* missing('The selected snapshot is no longer an active ready worktree view.');
    }
    const scope = yield* readSnapshotWorksetScopeReceipt(sql, snapshotId, scopeId);
    return {...rows[0], scope};
  });
}

function validateSelectedSnapshot(row: SnapshotProjectionRow, selected: CodeGraphSnapshot): void {
  if (
    requiredText(row.snapshot_id, 'snapshot identity') !== selected.id ||
    row.scope.scopeId !== (selected.scopeId ?? 'full-repository') ||
    requiredText(row.repository_id, 'repository identity') !== selected.repositoryId ||
    requiredText(row.commit_id, 'snapshot commit identity') !== selected.commit ||
    safeCount(row.symbol_count, 'snapshot symbol count') !== selected.symbolCount ||
    safeCount(row.edge_count, 'snapshot edge count') !== selected.edgeCount ||
    booleanInteger(row.dirty, 'snapshot dirty state') !== selected.dirty
  ) {
    throw corrupt('The leased snapshot metadata changed before projection began.');
  }
}

function selectExtractorGeneration(sql: SqlClient.SqlClient, snapshotId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<ExtractorGenerationRow>(
      'SELECT generation FROM snapshot_extractor_generations WHERE snapshot_id = ? LIMIT 2',
      [snapshotId],
    );
    if (rows.length !== 1) {
      return yield* corrupt('The ready snapshot has no unique extractor-generation receipt.');
    }
    const generation = safeCount(rows[0].generation, 'extractor generation');
    if (generation < 1) return yield* corrupt('The ready snapshot extractor generation is invalid.');
    return generation;
  });
}

function selectCount(sql: SqlClient.SqlClient, statement: string, parameters: readonly unknown[], label: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<CountRow>(statement, parameters);
    if (rows.length !== 1) return yield* corrupt(`The ${label} is unavailable.`);
    return safeCount(rows[0].count, label);
  });
}

function selectSymbolPage(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  afterNodeId: string,
  limit: number,
) {
  return sql.unsafe<SymbolProjectionRow>(
    `${effectiveSymbolsCte()}
     SELECT id, kind, name, qualified_name, path, language, lookup_keys_json,
            package_name, exported, span_json
     FROM effective_symbols
     WHERE id > ?
     ORDER BY id
     LIMIT ?`,
    [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), afterNodeId, limit],
  );
}

function selectLookupRows(sql: SqlClient.SqlClient, nodeIds: readonly string[]) {
  if (nodeIds.length === 0) return Effect.succeed([] as readonly LookupProjectionRow[]);
  return sql.unsafe<LookupProjectionRow>(
    `SELECT symbol_id, lookup_key
     FROM temp.${PROJECTION_LOOKUP_TABLE}
     WHERE symbol_id IN (${nodeIds.map(() => '?').join(', ')})
     ORDER BY symbol_id, lookup_key`,
    nodeIds,
  );
}

export interface CodeGraphWorksetProjectionTemporaryStorageSettings {
  readonly journalMode: 'memory';
  readonly maximumBytes: number;
  readonly maximumPages: number;
  readonly pageSizeBytes: number;
  readonly storage: 'file';
}

/**
 * The enclosing store session opens main with SQLite's read-only flag. Select
 * file-backed TEMP storage under the per-projection envelope; preparation
 * relaxes the additional query_only belt only for connection-local writes.
 * @internal
 */
export const configureCodeGraphWorksetProjectionTemporaryStorage = Effect.fn(
  'codeGraphWorksetCatalog.configureProjectionTemporaryStorage',
)(function* (
  sql: SqlClient.SqlClient,
  maximumBytes: number = CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionBytesMaximum,
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return yield* invalid('Workset projection temporary storage bound is invalid.');
  }
  yield* sql.unsafe('PRAGMA query_only = OFF');
  return yield* Effect.gen(function* () {
    yield* sql.unsafe('PRAGMA temp_store = FILE');
    if ((yield* selectProjectionTemporaryPragma(sql, 'temp_store')) !== 1) {
      return yield* temporaryStorageIncompatible();
    }
    // The surface is disposable and rebuilt after any failed statement. Keep
    // its rollback journal off disk so max_page_count bounds physical TEMP
    // growth instead of leaving a second repository-sized journal beside it.
    yield* sql.unsafe('PRAGMA temp.journal_mode = MEMORY');
    if ((yield* selectProjectionTemporaryTextPragma(sql, 'journal_mode')) !== 'memory') {
      return yield* temporaryStorageIncompatible();
    }
    const pageSizeBytes = yield* selectProjectionTemporaryPragma(sql, 'page_size');
    const maximumPages = Math.floor(maximumBytes / pageSizeBytes);
    if (!Number.isSafeInteger(maximumPages) || maximumPages < 1) {
      return yield* temporaryStorageIncompatible();
    }
    yield* sql.unsafe(`PRAGMA temp.max_page_count = ${String(maximumPages)}`);
    const configuredMaximumPages = yield* selectProjectionTemporaryPragma(sql, 'max_page_count');
    if (configuredMaximumPages !== maximumPages) {
      return yield* temporaryStorageIncompatible();
    }
    return {
      journalMode: 'memory',
      maximumBytes: configuredMaximumPages * pageSizeBytes,
      maximumPages: configuredMaximumPages,
      pageSizeBytes,
      storage: 'file',
    } satisfies CodeGraphWorksetProjectionTemporaryStorageSettings;
  }).pipe(Effect.ensuring(sql.unsafe('PRAGMA query_only = ON').pipe(Effect.orDie)));
});

function configureProjectionTemporaryStorage(sql: SqlClient.SqlClient) {
  return configureCodeGraphWorksetProjectionTemporaryStorage(sql).pipe(Effect.asVoid);
}

function selectProjectionTemporaryTextPragma(sql: SqlClient.SqlClient, pragma: 'journal_mode') {
  return sql.unsafe<Record<string, unknown>>(`PRAGMA temp.${pragma}`).pipe(
    Effect.flatMap(rows => {
      const value = rows[0]?.[pragma];
      return typeof value === 'string' && value.length > 0
        ? Effect.succeed(value.toLowerCase())
        : Effect.fail(temporaryStorageIncompatible());
    }),
  );
}

function selectProjectionTemporaryPragma(
  sql: SqlClient.SqlClient,
  pragma: 'max_page_count' | 'page_size' | 'temp_store',
) {
  const statement = pragma === 'temp_store' ? 'PRAGMA temp_store' : `PRAGMA temp.${pragma}`;
  return sql.unsafe<Record<string, unknown>>(statement).pipe(
    Effect.flatMap(rows => {
      const value = rows[0]?.[pragma];
      const parsed = typeof value === 'bigint' ? Number(value) : value;
      return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0
        ? Effect.succeed(parsed)
        : Effect.fail(temporaryStorageIncompatible());
    }),
  );
}

function temporaryStorageIncompatible(): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of(
    'incompatible',
    'SQLite temporary routing storage cannot enforce the bounded projection capacity.',
  );
}

function projectionLookupParameters(snapshotId: string, baseId: string): readonly string[] {
  return [snapshotId, baseId, snapshotId, snapshotId];
}

function projectionTermsParameters(snapshotId: string, baseId: string): readonly string[] {
  return [snapshotId, snapshotId, baseId, snapshotId, snapshotId, baseId, snapshotId, snapshotId];
}

interface ProjectionPreparationQueryPlanRow {
  readonly detail: unknown;
}

/** @internal Inspect the exact materialization statements after the TEMP target tables exist. */
export const inspectCodeGraphWorksetProjectionPreparationQueryPlan = Effect.fn(
  'codeGraphWorksetCatalog.inspectProjectionPreparationQueryPlan',
)(function* (sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  const baseId = baseSnapshotId ?? '';
  const [lookupRows, termRows] = yield* Effect.all(
    [
      sql.unsafe<ProjectionPreparationQueryPlanRow>(
        `EXPLAIN QUERY PLAN ${PROJECTION_LOOKUP_MATERIALIZATION_SQL}`,
        projectionLookupParameters(snapshotId, baseId),
      ),
      sql.unsafe<ProjectionPreparationQueryPlanRow>(
        `EXPLAIN QUERY PLAN ${PROJECTION_TERMS_MATERIALIZATION_SQL}`,
        projectionTermsParameters(snapshotId, baseId),
      ),
    ] as const,
    {concurrency: 1},
  );
  return {
    lookup: lookupRows.map(row => requiredText(row.detail, 'routing lookup query-plan detail')),
    terms: termRows.map(row => requiredText(row.detail, 'routing term query-plan detail')),
  };
});

/**
 * Materialize one symbol-first TEMP projection of the immutable routing surface.
 *
 * Compact postings and resolved lookup keys are deliberately stored routing-
 * key-first for graph search. A routing projection asks the inverse question
 * for every symbol page. Running those inverse joins page-by-page makes SQLite
 * scan or probe the complete key domains repeatedly. This read-only session
 * instead scans the selected snapshots once into file-backed TEMP storage,
 * then both digest/publication passes use symbol-first TEMP primary keys
 * without adding persistent graph indexes or graph-build write amplification.
 */
export const prepareCodeGraphWorksetProjectionRoutingSurface = Effect.fn(
  'codeGraphWorksetCatalog.prepareProjectionRoutingSurface',
)(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  observe?: (counts: {readonly lookupKeys: number; readonly terms: number}) => void,
) {
  yield* Effect.gen(function* () {
    yield* sql.unsafe('PRAGMA query_only = OFF');
    const counts = yield* Effect.gen(function* () {
      yield* sql.unsafe(`DROP TABLE IF EXISTS temp.${PROJECTION_LOOKUP_TABLE}`);
      yield* sql.unsafe(`DROP TABLE IF EXISTS temp.${PROJECTION_TERMS_TABLE}`);
      yield* sql.unsafe(`CREATE TEMP TABLE ${PROJECTION_LOOKUP_TABLE} (
      symbol_id TEXT NOT NULL,
      lookup_key TEXT NOT NULL,
      PRIMARY KEY (symbol_id, lookup_key)
    ) WITHOUT ROWID`);
      const baseId = baseSnapshotId ?? '';
      yield* sql.unsafe(PROJECTION_LOOKUP_MATERIALIZATION_SQL, projectionLookupParameters(snapshotId, baseId));
      const lookupKeys =
        observe === undefined
          ? 0
          : yield* selectTemporaryRowCount(sql, PROJECTION_LOOKUP_TABLE, 'routing lookup preparation');

      yield* sql.unsafe(`CREATE TEMP TABLE ${PROJECTION_TERMS_TABLE} (
      symbol_id TEXT NOT NULL,
      term TEXT NOT NULL,
      weight INTEGER NOT NULL,
      PRIMARY KEY (symbol_id, term)
    ) WITHOUT ROWID`);
      yield* sql.unsafe(PROJECTION_TERMS_MATERIALIZATION_SQL, projectionTermsParameters(snapshotId, baseId));
      return observe === undefined
        ? undefined
        : {
            lookupKeys,
            terms: yield* selectTemporaryRowCount(sql, PROJECTION_TERMS_TABLE, 'routing term preparation'),
          };
    }).pipe(Effect.ensuring(sql.unsafe('PRAGMA query_only = ON').pipe(Effect.orDie)));
    if (counts !== undefined) observe?.(counts);
  }).pipe(Effect.mapError(projectionTemporaryStorageFailure));
});

function projectionTemporaryStorageFailure(cause: unknown): unknown {
  if (Schema.is(CodeGraphWorksetCatalogError)(cause)) return cause;
  const classified = classifyCodeGraphStoreFailure('prepare workset routing projection temporary storage', cause);
  return classified.code === 'no-space'
    ? CodeGraphWorksetCatalogError.of(
        'capacity',
        'The temporary routing projection reached its bounded storage envelope.',
        {cause},
      )
    : cause;
}

function selectTemporaryRowCount(sql: SqlClient.SqlClient, table: string, label: string) {
  return Effect.gen(function* () {
    if (table !== PROJECTION_LOOKUP_TABLE && table !== PROJECTION_TERMS_TABLE) {
      return yield* corrupt(`The ${label} table is invalid.`);
    }
    const rows = yield* sql.unsafe<CountRow>(`SELECT COUNT(*) AS count FROM temp.${table}`);
    if (rows.length !== 1) return yield* corrupt(`The ${label} count is unavailable.`);
    return safeCount(rows[0].count, `${label} count`);
  });
}

function selectTermRows(sql: SqlClient.SqlClient, nodeIds: readonly string[]) {
  if (nodeIds.length === 0) return Effect.succeed([] as readonly TermProjectionRow[]);
  return sql.unsafe<TermProjectionRow>(
    `SELECT symbol_id, term, weight
     FROM temp.${PROJECTION_TERMS_TABLE}
     WHERE symbol_id IN (${nodeIds.map(() => '?').join(', ')})
     ORDER BY symbol_id, weight DESC, term`,
    nodeIds,
  );
}

function selectAnalysisReceipt(sql: SqlClient.SqlClient, snapshotId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<AnalysisReceiptRow>(
      `SELECT version, symbol_count, edge_count, digest
       FROM snapshot_analysis_summary_receipts WHERE snapshot_id = ? LIMIT 2`,
      [snapshotId],
    );
    if (rows.length > 1) return yield* corrupt('The snapshot analysis receipt is not unique.');
    return rows[0] ? normalizedAnalysisReceipt(rows[0]) : undefined;
  });
}

function selectComponentReceipt(sql: SqlClient.SqlClient, snapshotId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<ComponentReceiptRow>(
      `SELECT version, row_count, edge_count, digest
       FROM snapshot_component_edge_aggregate_receipts WHERE snapshot_id = ? LIMIT 2`,
      [snapshotId],
    );
    if (rows.length > 1) return yield* corrupt('The snapshot component receipt is not unique.');
    return rows[0] ? normalizedComponentReceipt(rows[0]) : undefined;
  });
}

function selectLexicalReceipts(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<LexicalReceiptRow>(
      `SELECT snapshot_id, format_version, posting_count, symbol_count, term_count
       FROM lexical_storage_formats
       WHERE snapshot_id IN (?, ?)
       ORDER BY snapshot_id`,
      [snapshotId, baseSnapshotId ?? ''],
    );
    return rows.map(row => ({
      formatVersion: safeCount(row.format_version, 'lexical format version'),
      postingCount: safeCount(row.posting_count, 'lexical posting count'),
      snapshotId: requiredText(row.snapshot_id, 'lexical snapshot identity'),
      symbolCount: safeCount(row.symbol_count, 'lexical symbol count'),
      termCount: safeCount(row.term_count, 'lexical term count'),
    }));
  });
}

function groupLookupRows(rows: readonly LookupProjectionRow[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const nodeId = requiredText(row.symbol_id, 'lookup symbol identity');
    const values = grouped.get(nodeId) ?? [];
    values.push(requiredText(row.lookup_key, 'symbol lookup key'));
    grouped.set(nodeId, values);
  }
  return grouped;
}

function groupTermRows(rows: readonly TermProjectionRow[]): Map<string, CodeGraphWorksetRoutingTermV1[]> {
  const grouped = new Map<string, CodeGraphWorksetRoutingTermV1[]>();
  for (const row of rows) {
    const nodeId = requiredText(row.symbol_id, 'term symbol identity');
    const term = requiredText(row.term, 'symbol routing term');
    const weight = finiteNumber(row.weight, 'symbol routing term weight');
    const values = grouped.get(nodeId) ?? [];
    values.push({term, weight});
    grouped.set(nodeId, values);
  }
  return grouped;
}

function selectLookupKeys(
  intrinsic: readonly string[],
  resolved: readonly string[],
  stats: MutableProjectionStats,
): readonly string[] {
  const intrinsicKeys = [...new Set(intrinsic)].sort(compareText);
  const intrinsicSet = new Set(intrinsicKeys);
  const aliasKeys = [...new Set(resolved)].filter(key => !intrinsicSet.has(key)).sort(compareText);
  const all = [...intrinsicKeys, ...aliasKeys];
  stats.lookupKeysObserved += all.length;
  stats.lookupKeysOmitted += Math.max(0, all.length - CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol);
  return all.slice(0, CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol);
}

function selectTerms(
  terms: readonly CodeGraphWorksetRoutingTermV1[],
  stats: MutableProjectionStats,
): readonly CodeGraphWorksetRoutingTermV1[] {
  const unique = new Map<string, number>();
  for (const term of terms) unique.set(term.term, Math.max(unique.get(term.term) ?? 0, term.weight));
  const ranked = [...unique]
    .map(([term, weight]) => ({term, weight}))
    .sort((left, right) => right.weight - left.weight || compareText(left.term, right.term));
  stats.termsObserved += ranked.length;
  stats.termsOmitted += Math.max(0, ranked.length - CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol);
  return ranked.slice(0, CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol);
}

function decodeLookupKeys(value: unknown): readonly string[] {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAXIMUM_LOOKUP_JSON_BYTES) {
    throw corrupt('A ready snapshot symbol has an invalid lookup-key surface.');
  }
  const parsed = parseJson(value, 'symbol lookup-key surface');
  if (!Array.isArray(parsed)) throw corrupt('A ready snapshot symbol has an invalid lookup-key surface.');
  return parsed.map(candidate => requiredText(candidate, 'symbol lookup key'));
}

function decodeSpan(value: unknown): CodeGraphWorksetCatalogSpanV1 {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAXIMUM_SPAN_JSON_BYTES) {
    throw corrupt('A ready snapshot symbol has an invalid evidence span.');
  }
  const parsed = parseJson(value, 'symbol evidence span');
  if (!Predicate.isObject(parsed)) {
    throw corrupt('A ready snapshot symbol has an invalid evidence span.');
  }
  const record = parsed;
  return {
    column: safeCount(record.column, 'symbol span column'),
    endColumn: safeCount(record.endColumn, 'symbol span end column'),
    endLine: safeCount(record.endLine, 'symbol span end line'),
    line: safeCount(record.line, 'symbol span line'),
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw corrupt(`The ${label} is not valid JSON.`, cause);
  }
}

function normalizedAnalysisReceipt(row: AnalysisReceiptRow) {
  return {
    digest: requiredText(row.digest, 'analysis receipt digest'),
    edgeCount: safeCount(row.edge_count, 'analysis edge count'),
    symbolCount: safeCount(row.symbol_count, 'analysis symbol count'),
    version: safeCount(row.version, 'analysis receipt version'),
  };
}

function validateOptionalReceipts(
  analysis: ReturnType<typeof normalizedAnalysisReceipt> | undefined,
  component: ReturnType<typeof normalizedComponentReceipt> | undefined,
  lexical: readonly {
    readonly formatVersion: number;
    readonly postingCount: number;
    readonly snapshotId: string;
    readonly symbolCount: number;
    readonly termCount: number;
  }[],
  symbolCount: number,
  edgeCount: number,
): void {
  if (
    analysis !== undefined &&
    (analysis.version !== 1 ||
      !SHA256_HEX.test(analysis.digest) ||
      analysis.symbolCount !== symbolCount ||
      analysis.edgeCount !== edgeCount)
  ) {
    throw corrupt('The ready snapshot analysis receipt is inconsistent.');
  }
  if (component !== undefined && (component.version !== 1 || !SHA256_HEX.test(component.digest))) {
    throw corrupt('The ready snapshot component receipt is inconsistent.');
  }
  if (lexical.some(receipt => receipt.formatVersion !== CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION)) {
    throw corrupt('The ready snapshot lexical receipt is incompatible.');
  }
}

function normalizedComponentReceipt(row: ComponentReceiptRow) {
  return {
    digest: requiredText(row.digest, 'component receipt digest'),
    edgeCount: safeCount(row.edge_count, 'component edge count'),
    rowCount: safeCount(row.row_count, 'component row count'),
    version: safeCount(row.version, 'component receipt version'),
  };
}

function readySnapshotProjectionDigest(input: {
  readonly baseSnapshotId: string | undefined;
  readonly commitId: string;
  readonly componentCount: number;
  readonly dependencyCount: number;
  readonly dirty: boolean;
  readonly extractorGeneration: number;
  readonly extractorSet: string;
  readonly graphContentId: string | undefined;
  readonly lookupKeysObserved: number;
  readonly overlayFingerprint: string | undefined;
  readonly repositoryId: string;
  readonly snapshotId: string;
  readonly symbolCount: number;
  readonly termsObserved: number;
}): string {
  return sha256HexSync(
    JSON.stringify([
      'threadnote-ready-code-graph-routing-source-v1',
      input.repositoryId,
      input.snapshotId,
      input.graphContentId ?? null,
      input.baseSnapshotId ?? null,
      input.commitId,
      input.dirty ? 1 : 0,
      input.overlayFingerprint ?? null,
      input.extractorSet,
      input.extractorGeneration,
      input.symbolCount,
      input.componentCount,
      input.dependencyCount,
      input.lookupKeysObserved,
      input.termsObserved,
    ]),
  );
}

function sameSnapshotProjectionRow(left: SnapshotProjectionRow, right: SnapshotProjectionRow): boolean {
  return (
    worksetScopeReceiptsMatch(left.scope, right.scope) &&
    left.snapshot_id === right.snapshot_id &&
    left.repository_id === right.repository_id &&
    left.commit_id === right.commit_id &&
    left.graph_content_id === right.graph_content_id &&
    left.base_snapshot_id === right.base_snapshot_id &&
    left.extractor_set === right.extractor_set &&
    left.dirty === right.dirty &&
    left.overlay_fingerprint === right.overlay_fingerprint &&
    left.symbol_count === right.symbol_count &&
    left.edge_count === right.edge_count
  );
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw corrupt(`The ${label} is invalid.`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredText(value, label);
}

function safeCount(value: unknown, label: string): number {
  const count = typeof value === 'bigint' ? Number(value) : value;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw corrupt(`The ${label} is invalid.`);
  }
  return count;
}

function finiteNumber(value: unknown, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw corrupt(`The ${label} is invalid.`);
  return number;
}

function booleanInteger(value: unknown, label: string): boolean {
  const integer = typeof value === 'bigint' ? Number(value) : value;
  if (integer !== 0 && integer !== 1) throw corrupt(`The ${label} is invalid.`);
  return integer === 1;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`Workset projection ${label} is invalid.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('invalid-input', message, cause === undefined ? undefined : {cause});
}

function missing(message: string): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('missing', message);
}

function corrupt(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('corrupt', message, cause === undefined ? undefined : {cause});
}

function storage(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('storage', message, cause === undefined ? undefined : {cause});
}
