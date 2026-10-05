import {Effect, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runBinaryCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {codeGraphCommittedContentHash} from '../content_identity.js';
import {decodeStoredCodeGraphFact} from '../fact/storage.js';
import {decodeCodeGraphInventoryReuseReceipt} from '../inventory/reuse.js';
import {CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION} from '../inventory/policy.js';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from '../store/build/core.js';
import {
  CODE_GRAPH_RESOLUTION_SURFACE_VERSION,
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  type CodeGraphInventoryReuseReceipt,
} from '../store/models.js';
import {CodeGraphStore} from '../store.js';
import {edgeFromRow, snapshotFromRow, symbolFromRow} from '../store/rows.js';
import {type EdgeRow, type SnapshotRow, type SymbolRow} from '../store/internal_models.js';
import {observeCleanRepositoryWorktree, revalidateRepositoryIdentityFence} from '../repository.js';
import {
  CODE_GRAPH_EXTRACTOR_GENERATION,
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphEdge,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  type RepositoryIdentity,
} from '../types.js';
import {compareCodeUnits} from '../ordering.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';
import {codeGraphCheckpointFileFactCacheIdentity} from './file_fact_identity.js';
import {
  CODE_GRAPH_CHECKPOINT_ATTRIBUTION_CONTENT_BYTES_MAXIMUM,
  CODE_GRAPH_CHECKPOINT_ATTRIBUTION_FILES_MAXIMUM,
  CODE_GRAPH_CHECKPOINT_ATTRIBUTION_SOURCE_BYTES_MAXIMUM,
  compareCodeGraphCheckpointRecordOrderKeys,
  compareCodeGraphCheckpointRecords,
  emptyCodeGraphCheckpointCounts,
  isSafeCodeGraphCheckpointPath,
  parseCodeGraphCheckpointMetadataV1,
  parseCodeGraphCheckpointRecordV1,
  type CodeGraphCheckpointAbiInputV1,
  type CodeGraphCheckpointCountsV1,
  type CodeGraphCheckpointCoverageV1,
  type CodeGraphCheckpointMetadataV1,
  type CodeGraphCheckpointPortableInventoryV1,
  type CodeGraphCheckpointRecordV1,
  type CodeGraphCheckpointReuseV1,
  type CodeGraphCheckpointSpanV1,
} from './schema.js';

const CodeGraphCheckpointSpanSchema = Schema.Struct({
  column: Schema.Int,
  endColumn: Schema.Int,
  endLine: Schema.Int,
  line: Schema.Int,
});
const isCodeGraphCheckpointSpan = Schema.is(CodeGraphCheckpointSpanSchema);

export const CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS = 30 * 60_000;
export const CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_RENEWAL_INTERVAL_MILLISECONDS = 10 * 60_000;
export const CODE_GRAPH_CHECKPOINT_PROJECTION_DEFAULT_PAGE_SIZE = 1_000;
export const CODE_GRAPH_CHECKPOINT_PROJECTION_MAXIMUM_PAGE_SIZE = 1_000;

const FILE_FACT_PAGE_SIZE_MAXIMUM = 8;
const LANGUAGE_PACK_PROVENANCE_MAXIMUM = 1_024;
export const CODE_GRAPH_CHECKPOINT_GIT_PATHSPEC_BYTES_MAXIMUM = 64 * 1_024;
const GIT_TREE_OUTPUT_BYTES_MAXIMUM = 256 * 1_024;

export class CodeGraphCheckpointProjectionError extends Schema.TaggedError<CodeGraphCheckpointProjectionError>()(
  'CodeGraphCheckpointProjectionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export interface CodeGraphCheckpointProjectionRequest<E = never, R = never> {
  readonly abi: CodeGraphCheckpointAbiInputV1;
  readonly databasePath: string;
  readonly identity: RepositoryIdentity;
  readonly pageSize?: number;
  readonly snapshotId: string;
  /** Called exactly once, inside the same SQLite read transaction as every record page. */
  readonly writeMetadata: (metadata: CodeGraphCheckpointMetadataV1) => Effect.Effect<void, E, R>;
  /** Receives non-empty pages in canonical checkpoint order. */
  readonly writeRecords: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>;
}

export interface CodeGraphCheckpointProjectionSummary {
  readonly counts: CodeGraphCheckpointCountsV1;
  readonly metadata: CodeGraphCheckpointMetadataV1;
  readonly snapshotId: string;
}

interface ProjectionFenceRow extends SnapshotRow {
  readonly alias_count: number;
  readonly file_set_fingerprint: string;
  readonly generation: number;
  readonly inventory_receipt_json: unknown;
  readonly lexical_format_version: number;
  readonly lexical_posting_count: number;
  readonly lexical_symbol_count: number;
  readonly lexical_term_count: number;
  readonly lookup_count: number;
  readonly repository_display_name: string;
  readonly repository_object_format: string;
  readonly reexport_count: number;
  readonly reuse_extractor_set: string;
  readonly reuse_format_version: number;
  readonly resolution_surface_version: number;
  readonly workspace_fingerprint: string;
}

interface PackProvenanceRow {
  readonly cache_identity: string;
  readonly derivation_identity: string;
  readonly pack_id: string;
  readonly resolution_domain: string;
  readonly resolution_version: string;
}

interface SnapshotFileRow {
  readonly content_hash: string;
  readonly language: string;
  readonly mode: string;
  readonly path: string;
  readonly raw_content_hash: unknown;
  readonly size: number;
  readonly source: string;
}

interface GitTreeEntry {
  readonly blobId: string;
  readonly mode: string;
  readonly path: string;
  readonly size: number;
}

interface FileFactRow {
  readonly content_hash: string;
  readonly extractor_set: string;
  readonly facts_json: string;
  readonly path: string;
  readonly path_hint: string;
  readonly shard_content_hash: string;
}

interface WorkspaceScopeRow {
  readonly build_system: string;
  readonly diagnostics_json: string;
  readonly id: string;
  readonly name: string;
  readonly provenance: 'declared' | 'inferred';
  readonly root: string;
}

interface WorkspaceComponentRow {
  readonly build_system: string;
  readonly diagnostics_json: string;
  readonly id: string;
  readonly kind: 'module' | 'package' | 'project' | 'target';
  readonly languages_json: string;
  readonly name: string;
  readonly provenance: 'declared' | 'inferred';
  readonly resolution_domain: string;
  readonly root: string;
  readonly source_roots_json: string;
  readonly workspace_id: string;
  readonly workspace_roots_json: string;
}

interface WorkspaceDependencyRow {
  readonly evidence: unknown;
  readonly provenance: 'declared' | 'inferred';
  readonly source_component_id: string;
  readonly target_component_id: string;
}

interface WorkspaceExternalDependencyRow {
  readonly dependency_kind: 'development' | 'optional' | 'peer' | 'runtime';
  readonly ecosystem: 'npm';
  readonly evidence_path: string;
  readonly evidence_span_json: unknown;
  readonly import_alias: string;
  readonly package_name: string;
  readonly source_component_id: string;
  readonly version_constraint: string;
}

interface SymbolLookupRow {
  readonly evidence_edge_id: unknown;
  readonly evidence_path: unknown;
  readonly exported: number;
  readonly lookup_key: string;
  readonly provenance: 'alias' | 'symbol';
  readonly resolution_domain: string;
  readonly symbol_id: string;
}

interface ReexportRow {
  readonly imported_name: string;
  readonly local_name: string;
  readonly source_path: string;
  readonly target_path: string;
}

interface MonikerRow {
  readonly component_id: unknown;
  readonly dependency_kind: unknown;
  readonly evidence_path: string;
  readonly evidence_span_json: string;
  readonly id: string;
  readonly identity: string;
  readonly import_path: unknown;
  readonly kind: string;
  readonly package_name: unknown;
  readonly package_version: unknown;
  readonly qualified_name: unknown;
  readonly resolution_domain: string;
  readonly role: 'export' | 'import';
  readonly scheme: 'package' | 'protobuf';
  readonly symbol_id: unknown;
  readonly version: number;
}

interface LexicalRow {
  readonly symbol_id: string;
  readonly term: string;
  readonly weight: number;
}

/**
 * Streams one self-contained logical checkpoint projection without hydrating a graph in memory.
 *
 * The caller owns transport spooling and final output publication. This function owns the
 * exact-clean Git fences, snapshot lease, one SQLite read transaction, bounded keyset pages,
 * logical-row validation, and canonical record ordering.
 */
export function projectCodeGraphCheckpointV1<E, R>(request: CodeGraphCheckpointProjectionRequest<E, R>) {
  return Effect.gen(function* () {
    const pageSize = yield* attemptProjection('Checkpoint projection request is invalid.', () => {
      validateProjectionIdentity(request.identity);
      return normalizePageSize(request.pageSize);
    });
    const store = yield* CodeGraphStore;
    yield* observeExactCleanRepository(request.identity, 'before');
    const selected = yield* store.readySnapshotById(request.databasePath, request.snapshotId);
    if (selected === undefined) {
      return yield* CodeGraphCheckpointProjectionError.make({
        message: `Ready snapshot ${request.snapshotId} was not found.`,
      });
    }
    yield* attemptProjection('Checkpoint source snapshot is invalid.', () =>
      validateSelectedSnapshot(selected, request.identity),
    );
    const lease = yield* store.acquireSnapshotLease(
      request.databasePath,
      selected.id,
      CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS,
    );
    const renewLease = Effect.sleep(CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_RENEWAL_INTERVAL_MILLISECONDS).pipe(
      Effect.andThen(
        store.renewSnapshotLease(request.databasePath, lease, CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS),
      ),
      Effect.forever,
    );
    const projection = store
      .withSession(request.databasePath, projectInReadTransaction(request, selected, pageSize), {readOnly: true})
      .pipe(Effect.tap(() => observeExactCleanRepository(request.identity, 'after')));
    return yield* Effect.raceFirst(projection, renewLease).pipe(
      Effect.ensuring(store.releaseSnapshotLease(request.databasePath, lease).pipe(Effect.ignore)),
    );
  });
}

function projectInReadTransaction<E, R>(
  request: CodeGraphCheckpointProjectionRequest<E, R>,
  selected: CodeGraphSnapshot,
  pageSize: number,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const openingFence = yield* loadProjectionFence(sql, selected.id);
        const snapshot = yield* attemptProjection('Checkpoint source snapshot is malformed.', () => {
          const parsed = snapshotFromRow(openingFence);
          validateSelectedSnapshot(parsed, request.identity);
          return parsed;
        });
        const inventory = decodeCodeGraphInventoryReuseReceipt(openingFence.inventory_receipt_json);
        if (inventory === undefined) {
          return yield* projectionFailure('The selected snapshot has no valid reusable inventory receipt.');
        }
        const packs = yield* loadPackProvenance(sql, snapshot.id);
        yield* attemptProjection('Checkpoint source fence is invalid.', () =>
          validateFence(openingFence, snapshot, request.identity, request.abi, packs),
        );
        const attributionGitEntries = yield* loadGitTreeEntries(
          request.identity,
          snapshot.commit,
          inventory.attributionFiles,
        );
        const metadata = yield* parseProjectionMetadata(
          request.abi,
          request.identity,
          snapshot,
          openingFence,
          inventory,
          attributionGitEntries,
        );
        yield* request.writeMetadata(metadata);

        const counts = emptyCodeGraphCheckpointCounts();
        let previous: CodeGraphCheckpointRecordV1 | undefined;
        const emit = (records: readonly CodeGraphCheckpointRecordV1[]) =>
          Effect.gen(function* () {
            if (records.length === 0) return;
            const parsed = yield* Effect.try({
              try: () => records.map(parseCodeGraphCheckpointRecordV1),
              catch: cause => projectionError('Checkpoint projection produced an invalid logical record.', cause),
            });
            for (const record of parsed) {
              if (previous !== undefined && compareCodeGraphCheckpointRecords(previous, record) >= 0) {
                return yield* projectionFailure(`Checkpoint projection record order changed at ${record.kind}.`);
              }
              counts[record.kind] += 1;
              previous = record;
            }
            yield* request.writeRecords(parsed);
          });

        const filePathDigest = new Bun.CryptoHasher('sha256');
        const factPathDigest = new Bun.CryptoHasher('sha256');
        yield* streamFiles(sql, request.identity, snapshot, pageSize, filePathDigest, emit);
        yield* streamFileFacts(sql, snapshot, Math.min(pageSize, FILE_FACT_PAGE_SIZE_MAXIMUM), factPathDigest, emit);
        if (counts.file !== counts['file-fact'] || filePathDigest.digest('hex') !== factPathDigest.digest('hex')) {
          return yield* projectionFailure('Checkpoint materialized file-fact coverage is incomplete.');
        }
        yield* streamWorkspaceScopes(sql, snapshot.id, pageSize, emit);
        yield* streamWorkspaceComponents(sql, snapshot.id, pageSize, emit);
        yield* streamWorkspaceDependencies(sql, snapshot.id, pageSize, emit);
        yield* streamWorkspaceExternalDependencies(sql, snapshot.id, pageSize, emit);
        yield* streamSymbols(sql, snapshot.id, pageSize, emit);
        const aliases = yield* streamSymbolLookups(sql, snapshot.id, pageSize, emit);
        yield* streamReexports(sql, snapshot.id, pageSize, emit);
        yield* streamEdges(sql, snapshot.id, pageSize, emit);
        yield* streamMonikers(sql, snapshot.id, pageSize, emit);
        yield* streamLexical(sql, snapshot.id, pageSize, emit);
        yield* emit(
          packs.map(pack => ({
            cacheIdentity: pack.cache_identity,
            derivationIdentity: pack.derivation_identity,
            id: pack.pack_id,
            kind: 'pack-provenance' as const,
            resolutionDomain: pack.resolution_domain,
            resolutionVersion: pack.resolution_version,
          })),
        );

        yield* attemptProjection('Checkpoint projection counts are invalid.', () =>
          validateProjectedCounts(counts, aliases, openingFence, snapshot, packs.length),
        );
        yield* validateLexicalCounts(sql, snapshot.id, openingFence);
        const closingFence = yield* loadProjectionFence(sql, selected.id);
        const fenceChanged = yield* attemptProjection(
          'Checkpoint source fence could not be compared.',
          () => projectionFenceDigest(openingFence) !== projectionFenceDigest(closingFence),
        );
        if (fenceChanged) {
          return yield* projectionFailure('The ready snapshot changed during checkpoint projection.');
        }
        return {
          counts: {...counts},
          metadata,
          snapshotId: snapshot.id,
        } satisfies CodeGraphCheckpointProjectionSummary;
      }),
    );
  });
}

function normalizePageSize(value: number | undefined): number {
  const pageSize = value ?? CODE_GRAPH_CHECKPOINT_PROJECTION_DEFAULT_PAGE_SIZE;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > CODE_GRAPH_CHECKPOINT_PROJECTION_MAXIMUM_PAGE_SIZE
  ) {
    throw CodeGraphCheckpointProjectionError.make({
      message: `Checkpoint projection page size must be an integer from 1 to ${CODE_GRAPH_CHECKPOINT_PROJECTION_MAXIMUM_PAGE_SIZE}.`,
    });
  }
  return pageSize;
}

function validateProjectionIdentity(identity: RepositoryIdentity): void {
  if (identity.remoteIdentity === undefined) {
    throw CodeGraphCheckpointProjectionError.make({
      message: 'Portable checkpoints require a credential-free remote repository identity.',
    });
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(identity.headCommit)) {
    throw CodeGraphCheckpointProjectionError.make({message: 'Checkpoint repository HEAD is not a Git object ID.'});
  }
}

function validateSelectedSnapshot(snapshot: CodeGraphSnapshot, identity: RepositoryIdentity): void {
  if ((snapshot.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) {
    throw CodeGraphCheckpointProjectionError.make({
      message:
        'Checkpoint v1 export supports only the full repository graph; scoped graph transport requires a verified scope receipt.',
    });
  }
  if (
    snapshot.state !== 'ready' ||
    snapshot.dirty ||
    snapshot.baseSnapshotId !== undefined ||
    snapshot.repositoryId !== identity.repositoryId ||
    snapshot.commit !== identity.headCommit
  ) {
    throw CodeGraphCheckpointProjectionError.make({
      message: 'Checkpoint export requires the exact ready CLEAN root snapshot for the current repository HEAD.',
    });
  }
  if (snapshot.graphContentId === undefined) {
    throw CodeGraphCheckpointProjectionError.make({
      message: 'Checkpoint source snapshot has no graph content identity.',
    });
  }
}

function observeExactCleanRepository(identity: RepositoryIdentity, phase: 'after' | 'before') {
  return Effect.gen(function* () {
    const observed = yield* revalidateRepositoryIdentityFence(identity.repoRoot, identity);
    if (
      observed.repositoryId !== identity.repositoryId ||
      observed.checkoutId !== identity.checkoutId ||
      observed.worktreeId !== identity.worktreeId ||
      observed.headCommit !== identity.headCommit ||
      observed.objectFormat !== identity.objectFormat
    ) {
      return yield* projectionFailure(`Repository identity changed ${phase} checkpoint projection.`);
    }
    if ((yield* observeCleanRepositoryWorktree(observed.repoRoot)) === undefined) {
      return yield* projectionFailure(`Repository worktree was not clean ${phase} checkpoint projection.`);
    }
  });
}

function loadProjectionFence(sql: SqlClient.SqlClient, snapshotId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<ProjectionFenceRow>(
      `SELECT snapshot.*,
              repository.display_name AS repository_display_name,
              repository.object_format AS repository_object_format,
              generation.generation,
              receipt.format_version AS reuse_format_version,
              receipt.resolution_surface_version,
              receipt.extractor_set AS reuse_extractor_set,
              receipt.workspace_fingerprint,
              receipt.file_set_fingerprint,
              receipt.lookup_count,
              receipt.alias_count,
              receipt.reexport_count,
              receipt.inventory_receipt_json,
              lexical.format_version AS lexical_format_version,
              lexical.posting_count AS lexical_posting_count,
              lexical.symbol_count AS lexical_symbol_count,
              lexical.term_count AS lexical_term_count
       FROM snapshots AS snapshot
       JOIN repositories AS repository ON repository.id = snapshot.repository_id
       JOIN snapshot_extractor_generations AS generation ON generation.snapshot_id = snapshot.id
       JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
       JOIN lexical_storage_formats AS lexical ON lexical.snapshot_id = snapshot.id
       WHERE snapshot.id = ?
       LIMIT 2`,
      [snapshotId],
    );
    if (rows.length !== 1) {
      return yield* projectionFailure('The selected snapshot is not a complete reusable checkpoint root.');
    }
    return rows[0];
  });
}

function loadPackProvenance(sql: SqlClient.SqlClient, snapshotId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<PackProvenanceRow>(
      `SELECT pack_id, cache_identity, derivation_identity, resolution_domain, resolution_version
       FROM snapshot_pack_provenance
       WHERE snapshot_id = ?
       ORDER BY pack_id COLLATE BINARY
       LIMIT ?`,
      [snapshotId, LANGUAGE_PACK_PROVENANCE_MAXIMUM + 1],
    );
    if (rows.length > LANGUAGE_PACK_PROVENANCE_MAXIMUM) {
      return yield* projectionFailure('Checkpoint language-pack provenance exceeds the bounded maximum.');
    }
    return rows;
  });
}

function validateFence(
  row: ProjectionFenceRow,
  snapshot: CodeGraphSnapshot,
  identity: RepositoryIdentity,
  abi: CodeGraphCheckpointAbiInputV1,
  packs: readonly PackProvenanceRow[],
): void {
  if (
    row.repository_display_name !== identity.displayName ||
    row.repository_object_format !== identity.objectFormat ||
    row.generation < CODE_GRAPH_EXTRACTOR_GENERATION ||
    row.reuse_format_version !== CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION ||
    row.resolution_surface_version !== CODE_GRAPH_RESOLUTION_SURFACE_VERSION ||
    row.reuse_extractor_set !== snapshot.extractorSet ||
    row.lexical_format_version !== CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION ||
    abi.graphSchemaVersion !== CODE_GRAPH_SCHEMA_VERSION ||
    abi.inventoryPolicyVersion !== CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION ||
    abi.lexicalLogicalFormatVersion !== CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION
  ) {
    throw CodeGraphCheckpointProjectionError.make({
      message: 'Checkpoint source ABI or reusable snapshot receipt is incompatible.',
    });
  }
  const persistedPacks = packs.map(pack => ({
    cacheIdentity: pack.cache_identity,
    derivationIdentity: pack.derivation_identity,
    id: pack.pack_id,
    resolutionDomain: pack.resolution_domain,
    resolutionVersion: pack.resolution_version,
  }));
  if (JSON.stringify(persistedPacks) !== JSON.stringify(abi.languagePacks)) {
    throw CodeGraphCheckpointProjectionError.make({
      message: 'Checkpoint ABI language-pack provenance does not match the ready snapshot.',
    });
  }
}

function parseProjectionMetadata(
  abi: CodeGraphCheckpointAbiInputV1,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  fence: ProjectionFenceRow,
  inventory: CodeGraphInventoryReuseReceipt,
  attributionGitEntries: ReadonlyMap<string, GitTreeEntry>,
) {
  return Effect.try({
    try: () =>
      parseCodeGraphCheckpointMetadataV1({
        abi,
        coverage: codeGraphCheckpointCoverage(snapshot.fileCount, inventory),
        repository: {
          caseMode: identity.caseMode,
          displayName: identity.displayName,
          objectFormat: identity.objectFormat,
          repositoryId: identity.repositoryId,
        },
        reuse: portableReuse(fence, inventory, attributionGitEntries, identity.objectFormat),
        source: {
          commit: snapshot.commit,
          extractorSet: snapshot.extractorSet,
          graphContentId: snapshot.graphContentId!,
        },
      }),
    catch: cause => projectionError('Checkpoint metadata could not be projected safely.', cause),
  });
}

export function codeGraphCheckpointCoverage(
  eligibleFiles: number,
  inventory: Pick<CodeGraphInventoryReuseReceipt, 'policyExclusions' | 'skipped'>,
): CodeGraphCheckpointCoverageV1 {
  if (
    !Number.isSafeInteger(eligibleFiles) ||
    eligibleFiles < 0 ||
    inventory.policyExclusions.files > inventory.skipped
  ) {
    throw CodeGraphCheckpointProjectionError.make({message: 'Checkpoint inventory coverage is inconsistent.'});
  }
  const reasons: Array<CodeGraphCheckpointCoverageV1['reasons'][number]> = inventory.policyExclusions.reasons
    .filter(reason => reason.files > 0)
    .map(reason => ({bytes: reason.bytes, code: reason.reason, files: reason.files}));
  const residual = inventory.skipped - inventory.policyExclusions.files;
  if (residual > 0) reasons.push({bytes: 0, code: 'inventory-other', files: residual});
  reasons.sort((left, right) => compareCodeUnits(left.code, right.code));
  return {
    eligibleFiles,
    excludedFiles: inventory.skipped,
    reasons,
    state: inventory.skipped === 0 ? 'complete' : 'partial',
  };
}

function portableReuse(
  fence: ProjectionFenceRow,
  inventory: CodeGraphInventoryReuseReceipt,
  attributionGitEntries: ReadonlyMap<string, GitTreeEntry>,
  objectFormat: RepositoryIdentity['objectFormat'],
): CodeGraphCheckpointReuseV1 {
  const portable = portableInventory(inventory, attributionGitEntries, objectFormat);
  const portableBytes = portable.attributionFiles.reduce(
    (totals, file) => ({content: totals.content + file.size, source: totals.source + file.blobSize}),
    {content: 0, source: 0},
  );
  const inventoryIsPortable =
    portable.attributionFiles.length <= CODE_GRAPH_CHECKPOINT_ATTRIBUTION_FILES_MAXIMUM &&
    portableBytes.content <= CODE_GRAPH_CHECKPOINT_ATTRIBUTION_CONTENT_BYTES_MAXIMUM &&
    portableBytes.source <= CODE_GRAPH_CHECKPOINT_ATTRIBUTION_SOURCE_BYTES_MAXIMUM;
  return {
    fileSetFingerprint: fence.file_set_fingerprint,
    formatVersion: fence.reuse_format_version,
    ...(inventoryIsPortable ? {inventory: portable} : {}),
    resolutionSurfaceVersion: fence.resolution_surface_version,
    workspaceFingerprint: fence.workspace_fingerprint,
  };
}

function portableInventory(
  inventory: CodeGraphInventoryReuseReceipt,
  attributionGitEntries: ReadonlyMap<string, GitTreeEntry>,
  objectFormat: RepositoryIdentity['objectFormat'],
): CodeGraphCheckpointPortableInventoryV1 {
  return {
    attributionFiles: inventory.attributionFiles.map(file => {
      const git = attributionGitEntries.get(file.path);
      if (
        git === undefined ||
        git.blobId !== file.blobId ||
        git.mode !== file.mode ||
        codeGraphCommittedContentHash(objectFormat, git.blobId) !== file.contentHash
      ) {
        throw CodeGraphCheckpointProjectionError.make({
          message: `Checkpoint attribution context does not match exact commit path ${file.path}.`,
        });
      }
      return {
        blobId: file.blobId,
        blobSize: git.size,
        contentHash: file.contentHash,
        language: file.language,
        mode: file.mode,
        path: file.path,
        size: file.size,
        source: 'commit' as const,
      };
    }),
    contract: inventory.contract,
    ...(inventory.diagnostics.length === 0 ? {} : {diagnostics: inventory.diagnostics}),
    includeOpaqueCorpusAssets: inventory.includeOpaqueCorpusAssets,
    policyExclusions: {
      ...inventory.policyExclusions,
      reasons: [...inventory.policyExclusions.reasons].sort((left, right) =>
        compareCodeUnits(left.reason, right.reason),
      ),
    },
    skipped: inventory.skipped,
    version: inventory.version,
    workspace: {
      ...inventory.workspace,
      projects: [...inventory.workspace.projects].sort((left, right) => compareCodeUnits(left.id, right.id)),
      workspaces: [...inventory.workspace.workspaces].sort((left, right) => compareCodeUnits(left.id, right.id)),
    },
  };
}

function streamFiles<E, R>(
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  pageSize: number,
  pathDigest: Bun.CryptoHasher,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamSingleCursorPages(
    undefined,
    cursor =>
      sql.unsafe<SnapshotFileRow>(
        `SELECT path, content_hash, raw_content_hash, language, mode, size, source
         FROM snapshot_files
         WHERE snapshot_id = ? AND (? IS NULL OR path > ? COLLATE BINARY)
         ORDER BY path COLLATE BINARY
         LIMIT ?`,
        [snapshot.id, cursor ?? null, cursor ?? null, pageSize],
      ),
    row => row.path,
    rows =>
      Effect.gen(function* () {
        const gitEntries = yield* loadGitTreeEntries(identity, snapshot.commit, rows);
        const records = yield* attemptProjection('Checkpoint file metadata is malformed.', () =>
          rows.map(row => {
            const git = gitEntries.get(row.path);
            if (
              git === undefined ||
              row.source !== 'commit' ||
              git.mode !== row.mode ||
              git.size !== Number(row.size) ||
              codeGraphCommittedContentHash(identity.objectFormat, git.blobId) !== row.content_hash
            ) {
              throw CodeGraphCheckpointProjectionError.make({
                message: `Checkpoint file metadata does not match exact commit path ${row.path}.`,
              });
            }
            updatePathDigest(pathDigest, row.path);
            const rawContentHash = optionalText(row.raw_content_hash);
            return {
              blobId: git.blobId,
              contentHash: row.content_hash,
              kind: 'file' as const,
              language: row.language,
              mode: row.mode,
              path: row.path,
              ...(rawContentHash === undefined ? {} : {rawContentHash}),
              size: Number(row.size),
              source: 'commit' as const,
            };
          }),
        );
        yield* emit(records);
      }),
  );
}

function loadGitTreeEntries<T extends {readonly path: string}>(
  identity: RepositoryIdentity,
  commit: string,
  files: readonly T[],
) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    if (files.some(file => !isSafeCodeGraphCheckpointPath(file.path))) {
      return yield* projectionFailure('Checkpoint source contains an unsafe repository path.');
    }
    const entries = new Map<string, GitTreeEntry>();
    const batches = yield* attemptProjection('Checkpoint Git path batching failed.', () =>
      codeGraphCheckpointGitPathBatches(files),
    );
    for (const batch of batches) {
      const result = yield* runBinaryCommandEffect(
        'git',
        ['-C', identity.repoRoot, 'ls-tree', '-l', '-z', '--full-tree', commit, '--', ...batch.map(file => file.path)],
        {
          env: {...system.environment(), GIT_LITERAL_PATHSPECS: '1'},
          maxOutputBytes: GIT_TREE_OUTPUT_BYTES_MAXIMUM,
          timeoutMs: 30_000,
        },
      );
      const observed = yield* Effect.try({
        try: () => parseGitTreeEntries(result.stdout, identity.objectFormat),
        catch: cause => projectionError('Exact-commit Git file metadata is malformed.', cause),
      });
      for (const [path, entry] of observed) {
        if (entries.has(path)) return yield* projectionFailure('Exact-commit Git file metadata is duplicated.');
        entries.set(path, entry);
      }
    }
    if (entries.size !== files.length || files.some(file => !entries.has(file.path))) {
      return yield* projectionFailure('Exact-commit Git file metadata is incomplete.');
    }
    return entries;
  });
}

/** Split literal Git pathspec arguments under a reviewed byte ceiling, independently of row-page tuning. */
export function codeGraphCheckpointGitPathBatches<T extends {readonly path: string}>(
  files: readonly T[],
): readonly (readonly T[])[] {
  const encoder = new TextEncoder();
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const file of files) {
    // One byte accounts for argv's terminating NUL. Fixed Git arguments stay
    // outside this budget and leave ample space below the platform ARG_MAX.
    const pathBytes = encoder.encode(file.path).byteLength + 1;
    if (pathBytes > CODE_GRAPH_CHECKPOINT_GIT_PATHSPEC_BYTES_MAXIMUM) {
      throw CodeGraphCheckpointProjectionError.make({message: 'Checkpoint Git path exceeds the pathspec byte budget.'});
    }
    if (batch.length > 0 && bytes > CODE_GRAPH_CHECKPOINT_GIT_PATHSPEC_BYTES_MAXIMUM - pathBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += pathBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function parseGitTreeEntries(
  output: Uint8Array,
  objectFormat: RepositoryIdentity['objectFormat'],
): ReadonlyMap<string, GitTreeEntry> {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(output);
  if (text.length === 0) return new Map();
  if (!text.endsWith('\0'))
    throw CodeGraphCheckpointProjectionError.make({message: 'Git tree output is not NUL terminated.'});
  const entries = new Map<string, GitTreeEntry>();
  const objectIdPattern = objectFormat === 'sha1' ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u;
  for (const encoded of text.slice(0, -1).split('\0')) {
    const separator = encoded.indexOf('\t');
    const metadata = /^(\d{6}) ([a-z]+) ([0-9a-f]+) +(\d+)$/u.exec(encoded.slice(0, separator));
    if (separator < 0 || metadata === null) {
      throw CodeGraphCheckpointProjectionError.make({message: 'Git tree entry is malformed.'});
    }
    const [, mode, type, blobId, encodedSize] = metadata;
    const path = encoded.slice(separator + 1);
    const size = Number(encodedSize);
    if (
      !/^\d{6}$/u.test(mode) ||
      type !== 'blob' ||
      !objectIdPattern.test(blobId) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !isSafeCodeGraphCheckpointPath(path) ||
      entries.has(path)
    ) {
      throw CodeGraphCheckpointProjectionError.make({message: 'Git tree entry is invalid.'});
    }
    entries.set(path, {blobId, mode, path, size});
  }
  return entries;
}

function streamFileFacts<E, R>(
  sql: SqlClient.SqlClient,
  snapshot: CodeGraphSnapshot,
  pageSize: number,
  pathDigest: Bun.CryptoHasher,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamSingleCursorPages(
    undefined,
    cursor =>
      sql.unsafe<FileFactRow>(
        `SELECT file.path, file.content_hash, shard.content_hash AS shard_content_hash,
                shard.path_hint, shard.extractor_set, shard.facts_json
         FROM snapshot_files AS file
         JOIN snapshot_file_shards AS association
           ON association.snapshot_id = file.snapshot_id AND association.path = file.path
         JOIN materialized_file_shards AS shard ON shard.id = association.shard_id
         WHERE file.snapshot_id = ? AND (? IS NULL OR file.path > ? COLLATE BINARY)
         ORDER BY file.path COLLATE BINARY
         LIMIT ?`,
        [snapshot.id, cursor ?? null, cursor ?? null, pageSize],
      ),
    row => row.path,
    rows =>
      Effect.gen(function* () {
        const records = yield* Effect.try({
          try: () =>
            rows.map(row => {
              if (
                row.path_hint !== row.path ||
                row.extractor_set !== snapshot.extractorSet ||
                row.shard_content_hash !== row.content_hash
              ) {
                throw CodeGraphCheckpointProjectionError.make({
                  message: `Materialized checkpoint fact provenance changed for ${row.path}.`,
                });
              }
              const facts = decodeStoredCodeGraphFact(row.facts_json, row.path).facts;
              updatePathDigest(pathDigest, row.path);
              return {
                cacheIdentity: codeGraphCheckpointFileFactCacheIdentity(facts),
                factRole: 'materialized' as const,
                facts,
                kind: 'file-fact' as const,
                path: row.path,
              };
            }),
          catch: cause => projectionError('Materialized checkpoint file facts are invalid.', cause),
        });
        yield* emit(records);
      }),
  );
}

function streamWorkspaceScopes<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamSingleCursorPages(
    undefined,
    cursor =>
      sql.unsafe<WorkspaceScopeRow>(
        `SELECT id, build_system, name, root, provenance, diagnostics_json
         FROM workspace_scopes
         WHERE snapshot_id = ? AND (? IS NULL OR id > ? COLLATE BINARY)
         ORDER BY id COLLATE BINARY
         LIMIT ?`,
        [snapshotId, cursor ?? null, cursor ?? null, pageSize],
      ),
    row => row.id,
    rows =>
      decodeAndEmit(
        rows,
        row => ({
          buildSystem: row.build_system,
          diagnostics: parseStringArray(row.diagnostics_json, 'workspace diagnostics'),
          id: row.id,
          kind: 'workspace-scope',
          name: row.name,
          provenance: row.provenance,
          root: row.root,
        }),
        emit,
        'workspace scopes',
      ),
  );
}

function streamWorkspaceComponents<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamSingleCursorPages(
    undefined,
    cursor =>
      sql.unsafe<WorkspaceComponentRow>(
        `SELECT id, workspace_id, build_system, kind, name, root, resolution_domain,
                languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
         FROM workspace_components
         WHERE snapshot_id = ? AND (? IS NULL OR id > ? COLLATE BINARY)
         ORDER BY id COLLATE BINARY
         LIMIT ?`,
        [snapshotId, cursor ?? null, cursor ?? null, pageSize],
      ),
    row => row.id,
    rows =>
      decodeAndEmit(
        rows,
        row => ({
          buildSystem: row.build_system,
          componentKind: row.kind,
          diagnostics: parseStringArray(row.diagnostics_json, 'component diagnostics'),
          id: row.id,
          kind: 'workspace-component',
          languages: parseStringArray(row.languages_json, 'component languages'),
          name: row.name,
          provenance: row.provenance,
          resolutionDomain: row.resolution_domain,
          root: row.root,
          sourceRoots: parseStringArray(row.source_roots_json, 'component source roots'),
          workspaceId: row.workspace_id,
          workspaceRoots: parseStringArray(row.workspace_roots_json, 'component workspace roots'),
        }),
        emit,
        'workspace components',
      ),
  );
}

function streamWorkspaceDependencies<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamCompositeCursorPages(
    undefined,
    cursor =>
      sql.unsafe<WorkspaceDependencyRow>(
        `SELECT source_component_id, target_component_id, provenance, evidence
         FROM workspace_component_dependencies
         WHERE snapshot_id = ?
           AND (? IS NULL OR (source_component_id, target_component_id, provenance) > (?, ?, ?))
         ORDER BY source_component_id COLLATE BINARY, target_component_id COLLATE BINARY, provenance COLLATE BINARY
         LIMIT ?`,
        [snapshotId, cursor?.[0] ?? null, ...(cursor ?? ['', '', '']), pageSize],
      ),
    row => [row.source_component_id, row.target_component_id, row.provenance],
    rows =>
      emit(
        rows.map(row => {
          const evidence = optionalText(row.evidence);
          return {
            ...(evidence === undefined ? {} : {evidence}),
            kind: 'workspace-dependency' as const,
            provenance: row.provenance,
            sourceComponentId: row.source_component_id,
            targetComponentId: row.target_component_id,
          };
        }),
      ),
  );
}

function streamWorkspaceExternalDependencies<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamCompositeCursorPages(
    undefined,
    cursor =>
      sql.unsafe<WorkspaceExternalDependencyRow>(
        `SELECT source_component_id, ecosystem, package_name, import_alias, dependency_kind,
                version_constraint, evidence_path, evidence_span_json
         FROM workspace_external_dependencies
         WHERE snapshot_id = ?
           AND (? IS NULL OR (
             source_component_id, ecosystem, package_name, import_alias,
             dependency_kind, version_constraint, evidence_path
           ) > (?, ?, ?, ?, ?, ?, ?))
         ORDER BY source_component_id COLLATE BINARY, ecosystem COLLATE BINARY, package_name COLLATE BINARY,
                  import_alias COLLATE BINARY, dependency_kind COLLATE BINARY,
                  version_constraint COLLATE BINARY, evidence_path COLLATE BINARY
         LIMIT ?`,
        [snapshotId, cursor?.[0] ?? null, ...(cursor ?? ['', '', '', '', '', '', '']), pageSize],
      ),
    row => [
      row.source_component_id,
      row.ecosystem,
      row.package_name,
      row.import_alias,
      row.dependency_kind,
      row.version_constraint,
      row.evidence_path,
    ],
    rows =>
      decodeAndEmit(
        rows,
        row => {
          const evidenceSpan = parseOptionalSpan(row.evidence_span_json, 'external dependency evidence span');
          return {
            dependencyKind: row.dependency_kind,
            ecosystem: row.ecosystem,
            evidencePath: row.evidence_path,
            ...(evidenceSpan === undefined ? {} : {evidenceSpan}),
            importAlias: row.import_alias,
            kind: 'workspace-external-dependency',
            packageName: row.package_name,
            sourceComponentId: row.source_component_id,
            versionConstraint: row.version_constraint,
          };
        },
        emit,
        'workspace external dependencies',
      ),
  );
}

function streamSymbols<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamSingleCursorPages(
    undefined,
    cursor =>
      sql.unsafe<SymbolRow>(
        `SELECT id, content_hash, kind, name, qualified_name, path, language, arity,
                lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
                exported, signature, documentation, span_json
         FROM symbols
         WHERE snapshot_id = ? AND (? IS NULL OR id > ? COLLATE BINARY)
         ORDER BY id COLLATE BINARY
         LIMIT ?`,
        [snapshotId, cursor ?? null, cursor ?? null, pageSize],
      ),
    row => row.id,
    rows => decodeAndEmit(rows, row => symbolRecord(symbolFromRow(row)), emit, 'symbols'),
  );
}

function symbolRecord(symbol: CodeGraphSymbol): CodeGraphCheckpointRecordV1 {
  return {
    ...(symbol.arity === undefined ? {} : {arity: symbol.arity}),
    contentHash: symbol.contentHash,
    ...(symbol.documentation === undefined ? {} : {documentation: symbol.documentation}),
    exported: symbol.exported,
    id: symbol.id,
    kind: 'symbol',
    language: symbol.language,
    ...(symbol.lookupKeys === undefined ? {} : {lookupKeys: symbol.lookupKeys}),
    name: symbol.name,
    ...(symbol.packageName === undefined ? {} : {packageName: symbol.packageName}),
    path: symbol.path,
    qualifiedName: symbol.qualifiedName,
    ...(symbol.resolutionDomain === undefined ? {} : {resolutionDomain: symbol.resolutionDomain}),
    ...(symbol.resolutionScopeId === undefined ? {} : {resolutionScopeId: symbol.resolutionScopeId}),
    ...(symbol.signature === undefined ? {} : {signature: symbol.signature}),
    span: symbol.span,
    symbolKind: symbol.kind,
  };
}

function streamSymbolLookups<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    let aliases = 0;
    yield* streamCompositeCursorPages(
      undefined,
      cursor =>
        sql.unsafe<SymbolLookupRow>(
          `SELECT lookup_key, symbol_id, resolution_domain, exported, provenance,
                  evidence_edge_id, evidence_path
           FROM snapshot_symbol_lookup
           WHERE snapshot_id = ? AND (? IS NULL OR (lookup_key, symbol_id) > (?, ?))
           ORDER BY lookup_key COLLATE BINARY, symbol_id COLLATE BINARY
           LIMIT ?`,
          [snapshotId, cursor?.[0] ?? null, ...(cursor ?? ['', '']), pageSize],
        ),
      row => [row.lookup_key, row.symbol_id],
      rows =>
        Effect.gen(function* () {
          aliases += rows.filter(row => row.provenance === 'alias').length;
          yield* emit(
            rows.map(row => {
              const evidenceEdgeId = optionalText(row.evidence_edge_id);
              const evidencePath = optionalText(row.evidence_path);
              return {
                ...(evidenceEdgeId === undefined ? {} : {evidenceEdgeId}),
                ...(evidencePath === undefined ? {} : {evidencePath}),
                exported: row.exported === 1,
                kind: 'symbol-lookup' as const,
                lookupKey: row.lookup_key,
                provenance: row.provenance,
                resolutionDomain: row.resolution_domain,
                symbolId: row.symbol_id,
              };
            }),
          );
        }),
    );
    return aliases;
  });
}

function streamReexports<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamCompositeCursorPages(
    undefined,
    cursor =>
      sql.unsafe<ReexportRow>(
        `SELECT source_path, local_name, target_path, imported_name
         FROM snapshot_reexport_provenance
         WHERE snapshot_id = ?
           AND (? IS NULL OR (source_path, local_name, target_path, imported_name) > (?, ?, ?, ?))
         ORDER BY source_path COLLATE BINARY, local_name COLLATE BINARY,
                  target_path COLLATE BINARY, imported_name COLLATE BINARY
         LIMIT ?`,
        [snapshotId, cursor?.[0] ?? null, ...(cursor ?? ['', '', '', '']), pageSize],
      ),
    row => [row.source_path, row.local_name, row.target_path, row.imported_name],
    rows =>
      emit(
        rows.map(row => ({
          importedName: row.imported_name,
          kind: 'reexport' as const,
          localName: row.local_name,
          sourcePath: row.source_path,
          targetPath: row.target_path,
        })),
      ),
  );
}

function streamEdges<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamSingleCursorPages(
    undefined,
    cursor =>
      sql.unsafe<EdgeRow>(
        `SELECT id, source_id, source_name, relation, target_id, target_name,
                provenance, confidence, evidence_path, evidence_span_json
         FROM edges
         WHERE snapshot_id = ? AND (? IS NULL OR id > ? COLLATE BINARY)
         ORDER BY id COLLATE BINARY
         LIMIT ?`,
        [snapshotId, cursor ?? null, cursor ?? null, pageSize],
      ),
    row => row.id,
    rows => decodeAndEmit(rows, row => edgeRecord(edgeFromRow(row)), emit, 'edges'),
  );
}

function edgeRecord(edge: CodeGraphEdge): CodeGraphCheckpointRecordV1 {
  return {
    confidence: edge.confidence,
    evidencePath: edge.evidencePath,
    evidenceSpan: edge.evidenceSpan,
    id: edge.id,
    kind: 'edge',
    provenance: edge.provenance,
    relation: edge.relation,
    ...(edge.sourceId === undefined ? {} : {sourceId: edge.sourceId}),
    sourceName: edge.sourceName,
    ...(edge.targetId === undefined ? {} : {targetId: edge.targetId}),
    targetName: edge.targetName,
  };
}

function streamMonikers<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamSingleCursorPages(
    undefined,
    cursor =>
      sql.unsafe<MonikerRow>(
        `SELECT moniker.id, moniker.version, moniker.scheme, moniker.role, moniker.kind,
                moniker.resolution_domain, moniker.identity, moniker.package_name,
                moniker.package_version, moniker.import_path, moniker.qualified_name,
                moniker.component_id, moniker.symbol_id, moniker.dependency_kind,
                moniker.evidence_path, moniker.evidence_span_json
         FROM code_graph_monikers AS moniker
         LEFT JOIN snapshot_files AS evidence
           ON evidence.snapshot_id = moniker.snapshot_id AND evidence.path = moniker.evidence_path
         LEFT JOIN workspace_components AS component
           ON component.snapshot_id = moniker.snapshot_id AND component.id = moniker.component_id
         LEFT JOIN symbols AS symbol
           ON symbol.snapshot_id = moniker.snapshot_id AND symbol.id = moniker.symbol_id
         WHERE moniker.snapshot_id = ?
           AND evidence.path IS NOT NULL
           AND (moniker.component_id IS NULL OR component.id IS NOT NULL)
           AND (moniker.symbol_id IS NULL OR symbol.id IS NOT NULL)
           AND (? IS NULL OR moniker.id > ? COLLATE BINARY)
         ORDER BY moniker.id COLLATE BINARY
         LIMIT ?`,
        [snapshotId, cursor ?? null, cursor ?? null, pageSize],
      ),
    row => row.id,
    rows =>
      decodeAndEmit(
        rows,
        row => ({
          ...optionalFields({
            componentId: row.component_id,
            dependencyKind: row.dependency_kind,
            importPath: row.import_path,
            packageName: row.package_name,
            packageVersion: row.package_version,
            qualifiedName: row.qualified_name,
            symbolId: row.symbol_id,
          }),
          evidencePath: row.evidence_path,
          evidenceSpan: parseRequiredSpan(row.evidence_span_json, 'moniker evidence span'),
          id: row.id,
          identity: row.identity,
          kind: 'moniker',
          monikerKind: row.kind,
          resolutionDomain: row.resolution_domain,
          role: row.role,
          scheme: row.scheme,
          version: Number(row.version),
        }),
        emit,
        'monikers',
      ),
  );
}

function streamLexical<E, R>(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pageSize: number,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
) {
  return streamCompositeCursorPages(
    undefined,
    cursor =>
      sql.unsafe<LexicalRow>(
        `SELECT term.term, symbol.symbol_id, posting.weight
         FROM lexical_compact_snapshots AS compact
         JOIN lexical_compact_postings AS posting ON posting.snapshot_key = compact.snapshot_key
         JOIN lexical_compact_terms AS term
           ON term.snapshot_key = compact.snapshot_key AND term.term_key = posting.term_key
         JOIN lexical_compact_symbols AS symbol
           ON symbol.snapshot_key = compact.snapshot_key AND symbol.symbol_key = posting.symbol_key
         WHERE compact.snapshot_id = ? AND (? IS NULL OR (term.term, symbol.symbol_id) > (?, ?))
         ORDER BY term.term COLLATE BINARY, symbol.symbol_id COLLATE BINARY
         LIMIT ?`,
        [snapshotId, cursor?.[0] ?? null, ...(cursor ?? ['', '']), pageSize],
      ),
    row => [row.term, row.symbol_id],
    rows =>
      emit(
        rows.map(row => ({
          kind: 'lexical' as const,
          symbolId: row.symbol_id,
          term: row.term,
          weight: Number(row.weight),
        })),
      ),
  );
}

function streamSingleCursorPages<Row, LoadE, LoadR, AcceptE, AcceptR>(
  initialCursor: string | undefined,
  load: (cursor: string | undefined) => Effect.Effect<readonly Row[], LoadE, LoadR>,
  cursorOf: (row: Row) => string,
  accept: (rows: readonly Row[]) => Effect.Effect<void, AcceptE, AcceptR>,
) {
  return Effect.gen(function* () {
    let cursor = initialCursor;
    for (;;) {
      const rows = yield* load(cursor);
      if (rows.length === 0) return;
      yield* accept(rows);
      const next = cursorOf(rows.at(-1)!);
      if (cursor !== undefined && compareCheckpointTuples([next], [cursor]) <= 0) {
        return yield* projectionFailure('Checkpoint keyset cursor did not advance.');
      }
      cursor = next;
    }
  });
}

function streamCompositeCursorPages<Row, Cursor extends readonly string[], LoadE, LoadR, AcceptE, AcceptR>(
  initialCursor: Cursor | undefined,
  load: (cursor: Cursor | undefined) => Effect.Effect<readonly Row[], LoadE, LoadR>,
  cursorOf: (row: Row) => Cursor,
  accept: (rows: readonly Row[]) => Effect.Effect<void, AcceptE, AcceptR>,
) {
  return Effect.gen(function* () {
    let cursor = initialCursor;
    for (;;) {
      const rows = yield* load(cursor);
      if (rows.length === 0) return;
      yield* accept(rows);
      const next = cursorOf(rows.at(-1)!);
      if (cursor !== undefined && compareCheckpointTuples(next, cursor) <= 0) {
        return yield* projectionFailure('Checkpoint composite keyset cursor did not advance.');
      }
      cursor = next;
    }
  });
}

function compareCheckpointTuples(left: readonly string[], right: readonly string[]): number {
  return compareCodeGraphCheckpointRecordOrderKeys({identity: left, kind: 'file'}, {identity: right, kind: 'file'});
}

function decodeAndEmit<Row, E, R>(
  rows: readonly Row[],
  map: (row: Row) => CodeGraphCheckpointRecordV1,
  emit: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, E, R>,
  label: string,
) {
  return Effect.try({
    try: () => rows.map(map),
    catch: cause => projectionError(`Checkpoint ${label} are malformed.`, cause),
  }).pipe(Effect.flatMap(emit));
}

function validateProjectedCounts(
  counts: CodeGraphCheckpointCountsV1,
  aliases: number,
  fence: ProjectionFenceRow,
  snapshot: CodeGraphSnapshot,
  packCount: number,
): void {
  if (
    counts.file !== snapshot.fileCount ||
    counts.symbol !== snapshot.symbolCount ||
    counts.edge !== snapshot.edgeCount ||
    counts['symbol-lookup'] !== Number(fence.lookup_count) ||
    aliases !== Number(fence.alias_count) ||
    counts.reexport !== Number(fence.reexport_count) ||
    counts.lexical !== Number(fence.lexical_posting_count) ||
    counts['pack-provenance'] !== packCount
  ) {
    throw CodeGraphCheckpointProjectionError.make({
      message: 'Checkpoint logical surface counts do not match ready receipts.',
    });
  }
}

function validateLexicalCounts(sql: SqlClient.SqlClient, snapshotId: string, fence: ProjectionFenceRow) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{
      readonly posting_count: number;
      readonly symbol_count: number;
      readonly term_count: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM lexical_compact_postings AS posting
          WHERE posting.snapshot_key = compact.snapshot_key) AS posting_count,
         (SELECT COUNT(*) FROM lexical_compact_symbols AS symbol
          WHERE symbol.snapshot_key = compact.snapshot_key) AS symbol_count,
         (SELECT COUNT(*) FROM lexical_compact_terms AS term
          WHERE term.snapshot_key = compact.snapshot_key) AS term_count
       FROM lexical_compact_snapshots AS compact
       WHERE compact.snapshot_id = ?
       LIMIT 2`,
      [snapshotId],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      Number(row?.posting_count) !== Number(fence.lexical_posting_count) ||
      Number(row?.symbol_count) !== Number(fence.lexical_symbol_count) ||
      Number(row?.term_count) !== Number(fence.lexical_term_count)
    ) {
      return yield* projectionFailure('Checkpoint compact lexical receipt is inconsistent.');
    }
  });
}

function projectionFenceDigest(row: ProjectionFenceRow): string {
  return sha256HexSync(
    JSON.stringify({
      aliasCount: row.alias_count,
      baseSnapshotId: row.base_snapshot_id,
      commit: row.commit_id,
      completedAt: row.completed_at,
      dirty: row.dirty,
      edgeCount: row.edge_count,
      extractorSet: row.extractor_set,
      fileCount: row.file_count,
      fileSetFingerprint: row.file_set_fingerprint,
      generation: row.generation,
      graphContentId: row.graph_content_id,
      id: row.id,
      inventory: sha256HexSync(typeof row.inventory_receipt_json === 'string' ? row.inventory_receipt_json : ''),
      lexicalFormat: row.lexical_format_version,
      lexicalPostings: row.lexical_posting_count,
      lexicalSymbols: row.lexical_symbol_count,
      lexicalTerms: row.lexical_term_count,
      lookupCount: row.lookup_count,
      repositoryId: row.repository_id,
      reexportCount: row.reexport_count,
      resolutionSurfaceVersion: row.resolution_surface_version,
      reuseFormatVersion: row.reuse_format_version,
      state: row.state,
      symbolCount: row.symbol_count,
      workspaceFingerprint: row.workspace_fingerprint,
    }),
  );
}

function updatePathDigest(hasher: Bun.CryptoHasher, path: string): void {
  hasher.update(`${new TextEncoder().encode(path).byteLength}:`);
  hasher.update(path);
  hasher.update('\0');
}

function parseStringArray(value: string, label: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw CodeGraphCheckpointProjectionError.make({message: `Checkpoint ${label} are invalid.`});
  }
  return parsed;
}

function parseOptionalJson(value: unknown, label: string): unknown | undefined {
  const text = optionalText(value);
  return text === undefined ? undefined : parseRequiredJson(text, label);
}

function parseOptionalSpan(value: unknown, label: string): CodeGraphCheckpointSpanV1 | undefined {
  const parsed = parseOptionalJson(value, label);
  if (parsed === undefined) return undefined;
  if (!isCodeGraphCheckpointSpan(parsed))
    throw CodeGraphCheckpointProjectionError.make({message: `Checkpoint ${label} is invalid.`});
  return parsed;
}

function parseRequiredSpan(value: string, label: string): CodeGraphCheckpointSpanV1 {
  const parsed = parseRequiredJson(value, label);
  if (!isCodeGraphCheckpointSpan(parsed))
    throw CodeGraphCheckpointProjectionError.make({message: `Checkpoint ${label} is invalid.`});
  return parsed;
}

function parseRequiredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw projectionError(`Checkpoint ${label} is invalid.`, cause);
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalFields(values: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])),
  );
}

function projectionError(message: string, cause: unknown): CodeGraphCheckpointProjectionError {
  return CodeGraphCheckpointProjectionError.make({
    message: cause instanceof Error && cause.message.length > 0 ? `${message} ${cause.message}` : message,
  });
}

function attemptProjection<A>(message: string, attempt: () => A) {
  return Effect.try({
    try: attempt,
    catch: cause => (Schema.is(CodeGraphCheckpointProjectionError)(cause) ? cause : projectionError(message, cause)),
  });
}

function projectionFailure(message: string): Effect.Effect<never, CodeGraphCheckpointProjectionError> {
  return Effect.fail(CodeGraphCheckpointProjectionError.make({message: message}));
}
