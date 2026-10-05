import {DateTime, Effect, Path, Predicate, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {compareCodeUnits} from '../ordering.js';
import {codeGraphWorksetCatalogLayout} from '../workset_catalog/layout.js';
import {changes} from '../workset_catalog/store_support.js';
import {CODE_GRAPH_WORKSET_CATALOG_LIMITS, CodeGraphWorksetCatalogError} from '../workset_catalog/types.js';
import {withCodeGraphWorksetCatalogReader, withCodeGraphWorksetCatalogWriter} from '../workset_catalog/store.js';
import {
  CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_VERSION,
  CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION,
  type CodeGraphBridgeEndpointReferenceV1,
  type CodeGraphBridgeEndpointV1,
  type CodeGraphCrossRepositoryBridgeV1,
} from './resolver.js';

const GENERATION_ID = /^cgwg_[0-9a-f]{40}$/u;
const BRIDGE_ID = /^cgb_[0-9a-f]{64}$/u;
const MONIKER_ID = /^cgm_[0-9a-f]{64}$/u;
const REPOSITORY_ID = /^[0-9a-f]{64}$/u;
const COMPONENT_ID = /^cgp_[0-9a-f]{32}$/u;
const QUALIFIED_REF = /^cgr_[0-9a-f]{40}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_REPOSITORY_KEY_BYTES = 4_096;
const MAX_SNAPSHOT_ID_BYTES = 256;
const MAX_IDENTITY_BYTES = 8_192;
const MAX_EVIDENCE_PATH_BYTES = 4_096;
const BRIDGE_SET_DISK_SAFETY_BYTES = 512 * 1_024 * 1_024;
const BRIDGE_ROW_STORAGE_OVERHEAD_BYTES = 1_024;
const BRIDGE_SET_WRITE_AMPLIFICATION = 2;
const BRIDGE_SET_DIGEST_DOMAIN = 'threadnote-cross-repository-bridge-set-v1';

export interface CodeGraphCrossRepositoryEndpointKeyV1 {
  readonly reference: CodeGraphBridgeEndpointReferenceV1;
  readonly repositoryId: string;
  readonly snapshotId: string;
}

export interface CodeGraphCrossRepositoryRepositorySnapshotKeyV1 {
  readonly repositoryId: string;
  readonly snapshotId: string;
}

export interface CodeGraphCrossRepositoryBridgeCursorV1 {
  readonly bridgeId: string;
  readonly ordinal: number;
}

export const CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_DIAGNOSTIC_CODES = [
  'lease-validation-failed',
  'moniker-read-failed',
  'moniker-read-incomplete',
  'resolver-failed',
  'resolver-rejections',
  'snapshot-drift',
] as const;
export type CodeGraphCrossRepositoryBridgeDiagnosticCodeV1 =
  (typeof CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_DIAGNOSTIC_CODES)[number];

export interface CodeGraphCrossRepositoryBridgeCoverageV1 {
  /** Fixed diagnostic codes deliberately carry no source path or repository name. */
  readonly diagnostics: readonly CodeGraphCrossRepositoryBridgeDiagnosticCodeV1[];
  readonly failedRepositoryCount: number;
  readonly rejectionCount: number;
  readonly repositoriesRead: number;
  readonly repositoryCount: number;
  readonly state: 'complete' | 'failed' | 'partial';
}

export interface CodeGraphCrossRepositoryBridgeSetReceiptV1 {
  readonly bridgeCount: number;
  readonly coverage: CodeGraphCrossRepositoryBridgeCoverageV1;
  readonly digest: string;
  readonly generationId: string;
  readonly replacedAt: string;
  readonly resolverVersion: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION;
  readonly state: 'published' | 'staged';
  readonly worksetName: string;
}

export interface CodeGraphCrossRepositoryBridgePageV1 {
  readonly bridgeSetDigest: string;
  readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly coverage: CodeGraphCrossRepositoryBridgeCoverageV1;
  readonly generationId: string;
  readonly next?: CodeGraphCrossRepositoryBridgeCursorV1;
  readonly resolverVersion: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION;
  readonly totalBridges: number;
  readonly worksetName: string;
}

export interface CodeGraphCrossRepositoryBridgeSetSummaryV1 {
  readonly bridgeCount: number;
  readonly coverage: CodeGraphCrossRepositoryBridgeCoverageV1;
  readonly digest: string;
  readonly generationId: string;
  readonly resolverVersion: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION;
  readonly worksetName: string;
}

interface GenerationRow {
  readonly id: unknown;
  readonly state: unknown;
  readonly workset_name: unknown;
}

interface GenerationMemberRow {
  readonly repository_id: unknown;
  readonly repository_key: unknown;
  readonly snapshot_id: unknown;
}

interface BridgeSetRow {
  readonly bridge_bytes: unknown;
  readonly bridge_count: unknown;
  readonly bridge_set_digest: unknown;
  readonly coverage_state: unknown;
  readonly diagnostic_codes_json: unknown;
  readonly failed_repository_count: unknown;
  readonly generation_id: unknown;
  readonly resolver_version: unknown;
  readonly rejection_count: unknown;
  readonly repositories_read: unknown;
  readonly repository_count: unknown;
  readonly workset_name: unknown;
}

interface BridgeRow {
  readonly bridge_bytes: unknown;
  readonly bridge_digest: unknown;
  readonly bridge_id: unknown;
  readonly bridge_json: unknown;
  readonly identity: unknown;
  readonly moniker_kind: unknown;
  readonly ordinal: unknown;
  readonly provenance: unknown;
  readonly relation: unknown;
  readonly resolution_domain: unknown;
  readonly resolver_reason: unknown;
  readonly resolver_version: unknown;
  readonly scheme: unknown;
  readonly source_evidence_path: unknown;
  readonly source_moniker_id: unknown;
  readonly source_reference: unknown;
  readonly source_reference_kind: unknown;
  readonly source_repository_id: unknown;
  readonly source_repository_key: unknown;
  readonly source_snapshot_id: unknown;
  readonly target_evidence_path: unknown;
  readonly target_moniker_id: unknown;
  readonly target_reference: unknown;
  readonly target_reference_kind: unknown;
  readonly target_repository_id: unknown;
  readonly target_repository_key: unknown;
  readonly target_snapshot_id: unknown;
}

interface PreparedBridge {
  readonly bridge: CodeGraphCrossRepositoryBridgeV1;
  readonly bytes: number;
  readonly digest: string;
  readonly json: string;
}

interface PreparedBridgeSet {
  readonly bridges: readonly PreparedBridge[];
  readonly digest: string;
  readonly totalBytes: number;
}

interface StoredBridgeFootprint {
  readonly bridgeCount: number;
  readonly totalBytes: number;
}

/**
 * Atomically replace the complete bridge set for one deterministic generation.
 * A staged generation stays invisible. A ready generation must still be the
 * published pointer for its workset, so retired snapshots cannot gain edges.
 */
export const replaceCodeGraphWorksetCatalogBridgeSet = Effect.fn('codeGraphCrossRepository.replaceCatalogBridgeSet')(
  function* (
    threadnoteHome: string,
    input: {
      readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
      readonly coverage?: Omit<CodeGraphCrossRepositoryBridgeCoverageV1, 'repositoryCount'> & {
        readonly repositoryCount?: number;
      };
      /** @internal Deterministic capacity probe used by focused storage tests. */
      readonly diskCapacityAvailableBytes?: (target: string) => Effect.Effect<number | undefined, unknown>;
      readonly generationId: string;
    },
  ) {
    const prepared = yield* validateInput(() => prepareBridgeSet(input));
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
    return yield* withCodeGraphWorksetCatalogWriter(threadnoteHome, sql =>
      Effect.gen(function* () {
        const generation = yield* loadWritableGeneration(sql, input.generationId);
        const members = yield* loadGenerationMemberIdentities(sql, input.generationId);
        yield* validateInput(() => validateBridgeMembership(prepared.bridges, members));
        const coverage = yield* validateInput(() =>
          prepareCoverage(input.coverage, members.length, prepared.bridges.length),
        );
        const stored = yield* loadStoredBridgeFootprint(sql, input.generationId);
        const requiredFreeBytes = yield* validateInput(() =>
          codeGraphCrossRepositoryBridgeReplacementRequiredFreeBytes({
            existingBridgeBytes: stored.totalBytes,
            existingBridgeCount: stored.bridgeCount,
            replacementBridgeBytes: prepared.totalBytes,
            replacementBridgeCount: prepared.bridges.length,
          }),
        );
        yield* verifyBridgeReplacementDiskCapacity(
          input.diskCapacityAvailableBytes ?? (target => system.availableDiskBytes(target)),
          layout.root,
          requiredFreeBytes,
        );
        const replacedAt = yield* currentIsoInstant;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const capacities = yield* sql.unsafe<{
              readonly bridge_logical_bytes: unknown;
              readonly projection_logical_bytes: unknown;
            }>(
              `SELECT bridge_logical_bytes, projection_logical_bytes
               FROM catalog_capacity WHERE singleton = 1 LIMIT 1`,
            );
            if (capacities.length !== 1) {
              return yield* corrupt('Catalog capacity receipt is missing.');
            }
            const bridgeLogicalBytes = requiredInteger(
              capacities[0].bridge_logical_bytes,
              'catalog bridge logical bytes',
            );
            const projectionLogicalBytes = requiredInteger(
              capacities[0].projection_logical_bytes,
              'catalog projection logical bytes',
            );
            const nextBridgeLogicalBytes = bridgeLogicalBytes - stored.totalBytes + prepared.totalBytes;
            if (
              nextBridgeLogicalBytes < 0 ||
              nextBridgeLogicalBytes + projectionLogicalBytes >
                CODE_GRAPH_WORKSET_CATALOG_LIMITS.catalogPhysicalBytesMaximum
            ) {
              return yield* CodeGraphWorksetCatalogError.of('capacity', 'The home-global workset catalog is full.');
            }
            yield* sql.unsafe(
              `UPDATE catalog_capacity SET bridge_logical_bytes = ?
               WHERE singleton = 1 AND bridge_logical_bytes = ?`,
              [nextBridgeLogicalBytes, bridgeLogicalBytes],
            );
            if ((yield* changes(sql)) !== 1) {
              return yield* corrupt('Catalog bridge capacity receipt changed unexpectedly.');
            }
            yield* sql.unsafe('DELETE FROM cross_repository_bridge_sets WHERE generation_id = ?', [input.generationId]);
            yield* sql.unsafe(
              `INSERT INTO cross_repository_bridge_sets (
               generation_id, resolver_version, bridge_count, bridge_bytes, bridge_set_digest,
               coverage_state, repository_count, repositories_read,
               failed_repository_count, rejection_count, diagnostic_codes_json,
               replaced_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                input.generationId,
                CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION,
                prepared.bridges.length,
                prepared.totalBytes,
                prepared.digest,
                coverage.state,
                coverage.repositoryCount,
                coverage.repositoriesRead,
                coverage.failedRepositoryCount,
                coverage.rejectionCount,
                JSON.stringify(coverage.diagnostics),
                replacedAt,
              ],
            );
            for (let ordinal = 0; ordinal < prepared.bridges.length; ordinal += 1) {
              yield* insertBridge(sql, input.generationId, ordinal, prepared.bridges[ordinal]);
            }
          }),
        );
        return {
          bridgeCount: prepared.bridges.length,
          coverage,
          digest: prepared.digest,
          generationId: input.generationId,
          replacedAt,
          resolverVersion: CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION,
          state: generation.state === 'ready' ? ('published' as const) : ('staged' as const),
          worksetName: generation.worksetName,
        };
      }),
    );
  },
);

/** Lightweight status receipt; it never scans bridge rows or exposes evidence paths. */
export const readPublishedCodeGraphWorksetCatalogBridgeSetSummary = Effect.fn(
  'codeGraphCrossRepository.readPublishedCatalogBridgeSetSummary',
)(function* (threadnoteHome: string, generationId: string) {
  yield* validateInput(() => {
    if (!GENERATION_ID.test(generationId)) throw invalid('Bridge generation identity is invalid.');
  });
  return yield* withCodeGraphWorksetCatalogReader(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const bridgeSet = yield* loadPublishedBridgeSet(sql, generationId);
        if (bridgeSet === undefined) return undefined;
        return {
          bridgeCount: bridgeSet.bridgeCount,
          coverage: bridgeSet.coverage,
          digest: bridgeSet.digest,
          generationId: bridgeSet.generationId,
          resolverVersion: bridgeSet.resolverVersion,
          worksetName: bridgeSet.worksetName,
        } satisfies CodeGraphCrossRepositoryBridgeSetSummaryV1;
      }),
    ),
  );
});

/**
 * Read one indexed endpoint page from a currently published generation. The
 * generation ID pins all returned snapshot evidence and prevents a new
 * published pointer from being mixed into an in-flight traversal.
 */
export const readCodeGraphWorksetCatalogBridgePage = Effect.fn('codeGraphCrossRepository.readCatalogBridgePage')(
  function* (
    threadnoteHome: string,
    input: {
      readonly after?: CodeGraphCrossRepositoryBridgeCursorV1;
      readonly direction: 'incoming' | 'outgoing';
      readonly endpoint: CodeGraphCrossRepositoryEndpointKeyV1;
      readonly generationId: string;
      readonly limit?: number;
    },
  ) {
    const request = yield* validateInput(() => validateReadRequest(input));
    return yield* withCodeGraphWorksetCatalogReader(threadnoteHome, sql =>
      sql.withTransaction(
        Effect.gen(function* () {
          const bridgeSet = yield* loadPublishedBridgeSet(sql, request.generationId);
          if (bridgeSet === undefined) return undefined;
          const memberCount = yield* countEndpointMembership(sql, request.generationId, request.endpoint);
          if (memberCount !== 1) {
            return yield* CodeGraphWorksetCatalogError.of(
              'stale',
              'The requested bridge endpoint is not a unique member of the published generation.',
            );
          }
          const prefix = request.direction === 'outgoing' ? 'source' : 'target';
          const rows = yield* sql.unsafe<BridgeRow>(
            `SELECT ordinal, bridge_id, identity, moniker_kind, relation, scheme,
                  resolution_domain, provenance, resolver_reason, resolver_version,
                  source_repository_id, source_repository_key, source_snapshot_id,
                  source_moniker_id, source_reference_kind, source_reference,
                  source_evidence_path, target_repository_id, target_repository_key,
                  target_snapshot_id, target_moniker_id, target_reference_kind,
                  target_reference, target_evidence_path, bridge_json, bridge_bytes,
                  bridge_digest
           FROM cross_repository_bridges
           WHERE generation_id = ?
             AND ${prefix}_repository_id = ?
             AND ${prefix}_snapshot_id = ?
             AND ${prefix}_reference_kind = ?
             AND ${prefix}_reference = ?
             AND (ordinal > ? OR (ordinal = ? AND bridge_id > ?))
           ORDER BY ordinal, bridge_id
           LIMIT ?`,
            [
              request.generationId,
              request.endpoint.repositoryId,
              request.endpoint.snapshotId,
              referenceKind(request.endpoint.reference),
              referenceValue(request.endpoint.reference),
              request.after?.ordinal ?? -1,
              request.after?.ordinal ?? -1,
              request.after?.bridgeId ?? '',
              request.limit + 1,
            ],
          );
          const visible = rows.slice(0, request.limit);
          const decoded: CodeGraphCrossRepositoryBridgeV1[] = [];
          let previous: CodeGraphCrossRepositoryBridgeCursorV1 | undefined;
          for (const row of visible) {
            const entry = yield* decodeStoredBridge(row);
            if (
              previous !== undefined &&
              (entry.ordinal < previous.ordinal ||
                (entry.ordinal === previous.ordinal && compareCodeUnits(entry.bridge.id, previous.bridgeId) <= 0))
            ) {
              return yield* corrupt('Stored bridge endpoint order is invalid.');
            }
            previous = {bridgeId: entry.bridge.id, ordinal: entry.ordinal};
            decoded.push(entry.bridge);
          }
          const last = visible.at(-1);
          const next =
            rows.length > request.limit && last !== undefined
              ? {
                  bridgeId: requiredText(last.bridge_id, 'bridge identity'),
                  ordinal: requiredInteger(last.ordinal, 'bridge ordinal'),
                }
              : undefined;
          return {
            bridgeSetDigest: bridgeSet.digest,
            bridges: decoded,
            coverage: bridgeSet.coverage,
            generationId: bridgeSet.generationId,
            ...(next === undefined ? {} : {next}),
            resolverVersion: bridgeSet.resolverVersion,
            totalBridges: bridgeSet.bridgeCount,
            worksetName: bridgeSet.worksetName,
          } satisfies CodeGraphCrossRepositoryBridgePageV1;
        }),
      ),
    );
  },
);

/**
 * Read bridges incident to one exact generation member. This uses the same
 * source/target endpoint indexes as exact traversal, but deliberately omits
 * the reference suffix so Workset Search can expand from a routed repository
 * without scanning the generation-wide bridge table.
 */
export const readCodeGraphWorksetCatalogRepositoryBridgePage = Effect.fn(
  'codeGraphCrossRepository.readCatalogRepositoryBridgePage',
)(function* (
  threadnoteHome: string,
  input: {
    readonly after?: CodeGraphCrossRepositoryBridgeCursorV1;
    readonly direction: 'incoming' | 'outgoing';
    readonly generationId: string;
    readonly limit?: number;
    readonly repository: CodeGraphCrossRepositoryRepositorySnapshotKeyV1;
  },
) {
  const request = yield* validateInput(() => validateRepositoryReadRequest(input));
  return yield* withCodeGraphWorksetCatalogReader(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const bridgeSet = yield* loadPublishedBridgeSet(sql, request.generationId);
        if (bridgeSet === undefined) return undefined;
        const memberCount = yield* countRepositoryMembership(sql, request.generationId, request.repository);
        if (memberCount !== 1) {
          return yield* CodeGraphWorksetCatalogError.of(
            'stale',
            'The requested bridge repository snapshot is not a unique member of the published generation.',
          );
        }
        const prefix = request.direction === 'outgoing' ? 'source' : 'target';
        const rows = yield* sql.unsafe<BridgeRow>(
          `SELECT ordinal, bridge_id, identity, moniker_kind, relation, scheme,
                  resolution_domain, provenance, resolver_reason, resolver_version,
                  source_repository_id, source_repository_key, source_snapshot_id,
                  source_moniker_id, source_reference_kind, source_reference,
                  source_evidence_path, target_repository_id, target_repository_key,
                  target_snapshot_id, target_moniker_id, target_reference_kind,
                  target_reference, target_evidence_path, bridge_json, bridge_bytes,
                  bridge_digest
           FROM cross_repository_bridges
           WHERE generation_id = ?
             AND ${prefix}_repository_id = ?
             AND ${prefix}_snapshot_id = ?
             AND (ordinal > ? OR (ordinal = ? AND bridge_id > ?))
           ORDER BY ordinal, bridge_id
           LIMIT ?`,
          [
            request.generationId,
            request.repository.repositoryId,
            request.repository.snapshotId,
            request.after?.ordinal ?? -1,
            request.after?.ordinal ?? -1,
            request.after?.bridgeId ?? '',
            request.limit + 1,
          ],
        );
        return yield* decodeBridgePageRows(rows, request.limit, bridgeSet);
      }),
    ),
  );
});

/** Bounded generation-wide bridge scan used by repository topology summaries. */
export const readCodeGraphWorksetCatalogBridgeGenerationPage = Effect.fn(
  'codeGraphCrossRepository.readCatalogBridgeGenerationPage',
)(function* (
  threadnoteHome: string,
  input: {
    readonly after?: CodeGraphCrossRepositoryBridgeCursorV1;
    readonly generationId: string;
    readonly limit?: number;
  },
) {
  const request = yield* validateInput(() => validateGenerationReadRequest(input));
  return yield* withCodeGraphWorksetCatalogReader(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const bridgeSet = yield* loadPublishedBridgeSet(sql, request.generationId);
        if (bridgeSet === undefined) return undefined;
        const rows = yield* sql.unsafe<BridgeRow>(
          `SELECT ordinal, bridge_id, identity, moniker_kind, relation, scheme,
                  resolution_domain, provenance, resolver_reason, resolver_version,
                  source_repository_id, source_repository_key, source_snapshot_id,
                  source_moniker_id, source_reference_kind, source_reference,
                  source_evidence_path, target_repository_id, target_repository_key,
                  target_snapshot_id, target_moniker_id, target_reference_kind,
                  target_reference, target_evidence_path, bridge_json, bridge_bytes,
                  bridge_digest
           FROM cross_repository_bridges
           WHERE generation_id = ?
             AND (ordinal > ? OR (ordinal = ? AND bridge_id > ?))
           ORDER BY ordinal, bridge_id
           LIMIT ?`,
          [
            request.generationId,
            request.after?.ordinal ?? -1,
            request.after?.ordinal ?? -1,
            request.after?.bridgeId ?? '',
            request.limit + 1,
          ],
        );
        return yield* decodeBridgePageRows(rows, request.limit, bridgeSet);
      }),
    ),
  );
});

function prepareBridgeSet(input: {
  readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly generationId: string;
}): PreparedBridgeSet {
  if (!GENERATION_ID.test(input.generationId)) throw invalid('Bridge generation identity is invalid.');
  if (!Array.isArray(input.bridges) || input.bridges.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration) {
    throw invalid('Bridge set exceeds the supported generation bound.');
  }
  const byId = new Map<string, PreparedBridge>();
  let totalBytes = 0;
  for (const value of input.bridges) {
    const bridge = parseCanonicalBridge(value);
    const json = JSON.stringify(bridge);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes < 1 || bytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgeRecordBytesMaximum) {
      throw invalid('Bridge record exceeds the supported byte bound.');
    }
    if (byId.has(bridge.id)) throw invalid('Bridge set contains a duplicate identity.');
    totalBytes += bytes;
    if (totalBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgeSetBytesMaximum) {
      throw invalid('Bridge set exceeds the supported aggregate byte bound.');
    }
    byId.set(bridge.id, {bridge, bytes, digest: sha256HexSync(json), json});
  }
  const bridges = [...byId.values()].sort((left, right) => compareBridges(left.bridge, right.bridge));
  const digest = new Bun.CryptoHasher('sha256');
  digest.update(BRIDGE_SET_DIGEST_DOMAIN);
  for (const entry of bridges) {
    digest.update('\n');
    digest.update(entry.json);
  }
  return {bridges, digest: digest.digest('hex'), totalBytes};
}

/**
 * Conservative WAL/database headroom for replacing one bounded bridge set.
 * Counts account for normalized columns and endpoint indexes without reading
 * payloads into memory; byte totals account for both the old and new JSON.
 */
export function codeGraphCrossRepositoryBridgeReplacementRequiredFreeBytes(input: {
  readonly existingBridgeBytes: number;
  readonly existingBridgeCount: number;
  readonly replacementBridgeBytes: number;
  readonly replacementBridgeCount: number;
}): number {
  for (const [label, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(`Bridge ${label} is invalid.`);
  }
  if (
    input.existingBridgeBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgeSetBytesMaximum ||
    input.replacementBridgeBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgeSetBytesMaximum ||
    input.replacementBridgeCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration ||
    input.existingBridgeCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration
  ) {
    throw invalid('Bridge replacement footprint exceeds the supported bound.');
  }
  const rows = input.existingBridgeCount + input.replacementBridgeCount;
  const logicalBytes =
    input.existingBridgeBytes + input.replacementBridgeBytes + rows * BRIDGE_ROW_STORAGE_OVERHEAD_BYTES;
  const safetyBytes = Math.max(BRIDGE_SET_DISK_SAFETY_BYTES, Math.ceil(logicalBytes * 0.1));
  const requiredBytes = logicalBytes * BRIDGE_SET_WRITE_AMPLIFICATION + safetyBytes;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < BRIDGE_SET_DISK_SAFETY_BYTES) {
    throw invalid('Bridge replacement storage requirement exceeds the supported byte range.');
  }
  return requiredBytes;
}

function loadStoredBridgeFootprint(sql: SqlClient.SqlClient, generationId: string) {
  return sql
    .unsafe<{readonly bridge_count: unknown; readonly bridge_bytes: unknown}>(
      `SELECT bridge_count, bridge_bytes FROM cross_repository_bridge_sets
       WHERE generation_id = ? LIMIT 1`,
      [generationId],
    )
    .pipe(
      Effect.flatMap(rows =>
        validateStored(() => {
          if (rows.length === 0) return {bridgeCount: 0, totalBytes: 0} satisfies StoredBridgeFootprint;
          if (rows.length !== 1) throw corrupt('Stored bridge footprint query returned an invalid row set.');
          const bridgeCount = requiredInteger(rows[0].bridge_count, 'stored bridge count');
          const totalBytes = requiredInteger(rows[0].bridge_bytes, 'stored bridge byte count');
          if (
            bridgeCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration ||
            totalBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgeSetBytesMaximum
          ) {
            throw corrupt('Stored bridge footprint exceeds the supported bound.');
          }
          return {bridgeCount, totalBytes} satisfies StoredBridgeFootprint;
        }),
      ),
    );
}

function verifyBridgeReplacementDiskCapacity(
  probe: (target: string) => Effect.Effect<number | undefined, unknown>,
  target: string,
  requiredBytes: number,
) {
  return probe(target).pipe(
    Effect.mapError(cause =>
      CodeGraphWorksetCatalogError.of(
        'storage',
        `Could not inspect free disk space before bridge publication. Verify at least ${String(requiredBytes)} bytes are free and retry; the catalog was not modified.`,
        {cause},
      ),
    ),
    Effect.flatMap(availableBytes => {
      if (availableBytes === undefined) {
        return Effect.fail(
          CodeGraphWorksetCatalogError.of(
            'storage',
            `Could not determine free disk space before bridge publication. Verify at least ${String(requiredBytes)} bytes are free and retry; the catalog was not modified.`,
          ),
        );
      }
      if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
        return Effect.fail(
          CodeGraphWorksetCatalogError.of('storage', 'The free disk space probe returned an invalid result.'),
        );
      }
      if (availableBytes < requiredBytes) {
        return Effect.fail(
          CodeGraphWorksetCatalogError.of(
            'capacity',
            `Bridge publication needs ${String(requiredBytes)} bytes free, but only ${String(availableBytes)} bytes are available. Free disk space and retry; the catalog was not modified.`,
          ),
        );
      }
      return Effect.void;
    }),
  );
}

function loadWritableGeneration(sql: SqlClient.SqlClient, generationId: string) {
  return sql
    .unsafe<GenerationRow>(`SELECT id, workset_name, state FROM workset_generations WHERE id = ? LIMIT 1`, [
      generationId,
    ])
    .pipe(
      Effect.flatMap(rows =>
        validateStored(() => {
          if (rows.length !== 1) {
            throw CodeGraphWorksetCatalogError.of('missing', 'The bridge generation does not exist.');
          }
          const state = requiredText(rows[0].state, 'generation state');
          const worksetName = requiredText(rows[0].workset_name, 'workset name');
          if (state !== 'staging' && state !== 'ready') {
            throw CodeGraphWorksetCatalogError.of('stale', 'A retired generation cannot receive bridges.');
          }
          return {state, worksetName};
        }),
      ),
      Effect.filterOrElse(
        generation => generation.state === 'staging',
        generation =>
          sql
            .unsafe<{readonly count: unknown}>(
              'SELECT COUNT(*) AS count FROM published_worksets WHERE workset_name = ? AND generation_id = ?',
              [generation.worksetName, generationId],
            )
            .pipe(
              Effect.flatMap(rows =>
                validateStored(() => {
                  if (requiredInteger(rows[0]?.count, 'published pointer count') !== 1) {
                    throw CodeGraphWorksetCatalogError.of(
                      'stale',
                      'A ready generation must remain published while its bridge set is replaced.',
                    );
                  }
                  return generation;
                }),
              ),
            ),
      ),
    );
}

function loadGenerationMemberIdentities(sql: SqlClient.SqlClient, generationId: string) {
  return sql
    .unsafe<GenerationMemberRow>(
      `SELECT repository_id, repository_key, snapshot_id
       FROM workset_generation_members
       WHERE generation_id = ?
       ORDER BY ordinal
       LIMIT ?`,
      [generationId, CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration + 1],
    )
    .pipe(
      Effect.flatMap(rows =>
        validateStored(() => {
          if (rows.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration) {
            throw corrupt('Bridge generation member count exceeds the supported bound.');
          }
          return rows.map(row => ({
            repositoryId: requiredText(row.repository_id, 'repository identity'),
            repositoryKey: requiredText(row.repository_key, 'repository key'),
            snapshotId: requiredText(row.snapshot_id, 'snapshot identity'),
          }));
        }),
      ),
    );
}

function validateBridgeMembership(
  bridges: readonly PreparedBridge[],
  members: readonly {readonly repositoryId: string; readonly repositoryKey: string; readonly snapshotId: string}[],
) {
  const memberBySnapshot = new Map<string, string>();
  for (const member of members) {
    const key = endpointSnapshotKey(member.repositoryId, member.snapshotId);
    if (memberBySnapshot.has(key)) throw invalid('Bridge generation contains an ambiguous repository snapshot.');
    memberBySnapshot.set(key, member.repositoryKey);
  }
  for (const {bridge} of bridges) {
    for (const endpoint of [bridge.source, bridge.target]) {
      const memberKey = memberBySnapshot.get(endpointSnapshotKey(endpoint.repositoryId, endpoint.snapshotId));
      if (memberKey === undefined || memberKey !== endpoint.repositoryKey) {
        throw invalid('Every bridge endpoint must match one repository snapshot in its generation.');
      }
    }
  }
}

function insertBridge(sql: SqlClient.SqlClient, generationId: string, ordinal: number, prepared: PreparedBridge) {
  const bridge = prepared.bridge;
  return sql.unsafe(
    `INSERT INTO cross_repository_bridges (
       generation_id, ordinal, bridge_id, identity, moniker_kind, relation, scheme,
       resolution_domain, provenance, resolver_reason, resolver_version,
       source_repository_id, source_repository_key, source_snapshot_id,
       source_moniker_id, source_reference_kind, source_reference, source_evidence_path,
       target_repository_id, target_repository_key, target_snapshot_id,
       target_moniker_id, target_reference_kind, target_reference, target_evidence_path,
       bridge_json, bridge_bytes, bridge_digest
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generationId,
      ordinal,
      bridge.id,
      bridge.identity,
      bridge.kind,
      bridge.relation,
      bridge.source.reference.kind === 'component' ? 'package' : 'protobuf',
      bridge.resolutionDomain,
      bridge.provenance,
      bridge.resolver.reason,
      bridge.resolver.version,
      bridge.source.repositoryId,
      bridge.source.repositoryKey,
      bridge.source.snapshotId,
      bridge.source.monikerId,
      referenceKind(bridge.source.reference),
      referenceValue(bridge.source.reference),
      bridge.source.evidence.path,
      bridge.target.repositoryId,
      bridge.target.repositoryKey,
      bridge.target.snapshotId,
      bridge.target.monikerId,
      referenceKind(bridge.target.reference),
      referenceValue(bridge.target.reference),
      bridge.target.evidence.path,
      prepared.json,
      prepared.bytes,
      prepared.digest,
    ],
  );
}

function loadPublishedBridgeSet(sql: SqlClient.SqlClient, generationId: string) {
  return sql
    .unsafe<BridgeSetRow>(
      `SELECT s.generation_id, s.resolver_version, s.bridge_count,
              s.bridge_bytes, s.bridge_set_digest, s.coverage_state, s.repository_count,
              s.repositories_read, s.failed_repository_count, s.rejection_count,
              s.diagnostic_codes_json, g.workset_name
       FROM cross_repository_bridge_sets AS s
       JOIN workset_generations AS g ON g.id = s.generation_id AND g.state = 'ready'
       JOIN published_worksets AS p
         ON p.generation_id = g.id AND p.workset_name = g.workset_name
       WHERE s.generation_id = ?
       LIMIT 1`,
      [generationId],
    )
    .pipe(
      Effect.flatMap(rows =>
        rows.length === 0
          ? succeedUndefined
          : validateStored(() => {
              const row = rows[0];
              const resolverVersion = requiredInteger(row.resolver_version, 'bridge resolver version');
              const bridgeCount = requiredInteger(row.bridge_count, 'bridge count');
              const bridgeBytes = requiredInteger(row.bridge_bytes, 'bridge byte count');
              const digest = requiredText(row.bridge_set_digest, 'bridge-set digest');
              const id = requiredText(row.generation_id, 'bridge generation identity');
              const coverage = decodeCoverage(row);
              if (
                resolverVersion !== CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION ||
                bridgeCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration ||
                bridgeBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgeSetBytesMaximum ||
                !SHA256_HEX.test(digest) ||
                !GENERATION_ID.test(id)
              ) {
                throw corrupt('Published bridge-set metadata is invalid.');
              }
              return {
                bridgeCount,
                coverage,
                digest,
                generationId: id,
                resolverVersion,
                worksetName: requiredText(row.workset_name, 'workset name'),
              };
            }),
      ),
    );
}

function prepareCoverage(
  input:
    | (Omit<CodeGraphCrossRepositoryBridgeCoverageV1, 'repositoryCount'> & {readonly repositoryCount?: number})
    | undefined,
  generationRepositoryCount: number,
  bridgeCount: number,
): CodeGraphCrossRepositoryBridgeCoverageV1 {
  const coverage = canonicalCoverage(
    input === undefined
      ? {
          diagnostics: [],
          failedRepositoryCount: 0,
          rejectionCount: 0,
          repositoriesRead: generationRepositoryCount,
          repositoryCount: generationRepositoryCount,
          state: 'complete',
        }
      : {...input, repositoryCount: input.repositoryCount ?? generationRepositoryCount},
  );
  if (coverage.repositoryCount !== generationRepositoryCount) {
    throw invalid('Bridge coverage repository count must match its generation.');
  }
  if (coverage.state !== 'complete' && bridgeCount !== 0) {
    throw invalid('An incomplete bridge coverage receipt cannot publish a subset of edges.');
  }
  return coverage;
}

function decodeCoverage(row: BridgeSetRow): CodeGraphCrossRepositoryBridgeCoverageV1 {
  const diagnosticsJson = requiredText(row.diagnostic_codes_json, 'bridge diagnostic codes');
  let diagnostics: unknown;
  try {
    diagnostics = JSON.parse(diagnosticsJson) as unknown;
  } catch (cause) {
    throw corrupt('Stored bridge diagnostic codes are invalid.', cause);
  }
  const coverage = canonicalCoverage({
    diagnostics,
    failedRepositoryCount: requiredInteger(row.failed_repository_count, 'failed bridge repository count'),
    rejectionCount: requiredInteger(row.rejection_count, 'bridge rejection count'),
    repositoriesRead: requiredInteger(row.repositories_read, 'bridge repositories read'),
    repositoryCount: requiredInteger(row.repository_count, 'bridge repository count'),
    state: requiredText(row.coverage_state, 'bridge coverage state'),
  });
  if (JSON.stringify(coverage.diagnostics) !== diagnosticsJson) {
    throw corrupt('Stored bridge diagnostic codes are not canonical.');
  }
  return coverage;
}

function canonicalCoverage(value: {
  readonly diagnostics: unknown;
  readonly failedRepositoryCount: unknown;
  readonly rejectionCount: unknown;
  readonly repositoriesRead: unknown;
  readonly repositoryCount: unknown;
  readonly state: unknown;
}): CodeGraphCrossRepositoryBridgeCoverageV1 {
  const state = oneOf(value.state, ['complete', 'failed', 'partial'] as const, 'coverage state');
  const repositoryCount = boundedCount(
    value.repositoryCount,
    'coverage repository count',
    0,
    CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration,
  );
  const repositoriesRead = boundedCount(value.repositoriesRead, 'coverage repositories read', 0, repositoryCount);
  const failedRepositoryCount = boundedCount(
    value.failedRepositoryCount,
    'coverage failed repository count',
    0,
    repositoryCount,
  );
  const rejectionCount = boundedCount(
    value.rejectionCount,
    'coverage rejection count',
    0,
    CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration,
  );
  if (!Array.isArray(value.diagnostics)) throw invalid('Bridge coverage diagnostics are invalid.');
  const diagnostics = [
    ...new Set(
      value.diagnostics.map(diagnostic =>
        oneOf(diagnostic, CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_DIAGNOSTIC_CODES, 'coverage diagnostic'),
      ),
    ),
  ].sort(compareCodeUnits);
  if (
    repositoriesRead + failedRepositoryCount > repositoryCount ||
    (state === 'complete' && (repositoriesRead !== repositoryCount || failedRepositoryCount !== 0)) ||
    (state !== 'complete' && (failedRepositoryCount === 0 || diagnostics.length === 0))
  ) {
    throw invalid('Bridge coverage counts are inconsistent.');
  }
  return {diagnostics, failedRepositoryCount, rejectionCount, repositoriesRead, repositoryCount, state};
}

function countEndpointMembership(
  sql: SqlClient.SqlClient,
  generationId: string,
  endpoint: CodeGraphCrossRepositoryEndpointKeyV1,
) {
  return countRepositoryMembership(sql, generationId, endpoint);
}

function countRepositoryMembership(
  sql: SqlClient.SqlClient,
  generationId: string,
  repository: CodeGraphCrossRepositoryRepositorySnapshotKeyV1,
) {
  return sql
    .unsafe<{readonly count: unknown}>(
      `SELECT COUNT(*) AS count
       FROM workset_generation_members
       WHERE generation_id = ? AND repository_id = ? AND snapshot_id = ?`,
      [generationId, repository.repositoryId, repository.snapshotId],
    )
    .pipe(Effect.flatMap(rows => validateStored(() => requiredInteger(rows[0]?.count, 'endpoint member count'))));
}

function decodeStoredBridge(row: BridgeRow) {
  return validateStored(() => {
    const json = requiredText(row.bridge_json, 'bridge JSON');
    const bytes = requiredInteger(row.bridge_bytes, 'bridge byte count');
    const digest = requiredText(row.bridge_digest, 'bridge digest');
    if (
      bytes !== Buffer.byteLength(json, 'utf8') ||
      bytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgeRecordBytesMaximum ||
      !SHA256_HEX.test(digest) ||
      digest !== sha256HexSync(json)
    ) {
      throw corrupt('Stored bridge payload integrity is invalid.');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(json) as unknown;
    } catch (cause) {
      throw corrupt('Stored bridge JSON is invalid.', cause);
    }
    const bridge = parseCanonicalBridge(decoded);
    if (JSON.stringify(bridge) !== json || !storedColumnsMatch(row, bridge)) {
      throw corrupt('Stored bridge columns do not match their canonical payload.');
    }
    return {bridge, ordinal: requiredInteger(row.ordinal, 'bridge ordinal')};
  });
}

function decodeBridgePageRows(
  rows: readonly BridgeRow[],
  limit: number,
  bridgeSet: {
    readonly bridgeCount: number;
    readonly coverage: CodeGraphCrossRepositoryBridgeCoverageV1;
    readonly digest: string;
    readonly generationId: string;
    readonly resolverVersion: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION;
    readonly worksetName: string;
  },
) {
  return Effect.gen(function* () {
    const visible = rows.slice(0, limit);
    const bridges: CodeGraphCrossRepositoryBridgeV1[] = [];
    let previous: CodeGraphCrossRepositoryBridgeCursorV1 | undefined;
    for (const row of visible) {
      const entry = yield* decodeStoredBridge(row);
      if (
        previous !== undefined &&
        (entry.ordinal < previous.ordinal ||
          (entry.ordinal === previous.ordinal && compareCodeUnits(entry.bridge.id, previous.bridgeId) <= 0))
      ) {
        return yield* corrupt('Stored bridge order is invalid.');
      }
      previous = {bridgeId: entry.bridge.id, ordinal: entry.ordinal};
      bridges.push(entry.bridge);
    }
    const last = visible.at(-1);
    const next =
      rows.length > limit && last !== undefined
        ? {
            bridgeId: requiredText(last.bridge_id, 'bridge identity'),
            ordinal: requiredInteger(last.ordinal, 'bridge ordinal'),
          }
        : undefined;
    return {
      bridgeSetDigest: bridgeSet.digest,
      bridges,
      coverage: bridgeSet.coverage,
      generationId: bridgeSet.generationId,
      ...(next === undefined ? {} : {next}),
      resolverVersion: bridgeSet.resolverVersion,
      totalBridges: bridgeSet.bridgeCount,
      worksetName: bridgeSet.worksetName,
    } satisfies CodeGraphCrossRepositoryBridgePageV1;
  });
}

function storedColumnsMatch(row: BridgeRow, bridge: CodeGraphCrossRepositoryBridgeV1): boolean {
  return (
    row.bridge_id === bridge.id &&
    row.identity === bridge.identity &&
    row.moniker_kind === bridge.kind &&
    row.relation === bridge.relation &&
    row.scheme === (bridge.source.reference.kind === 'component' ? 'package' : 'protobuf') &&
    row.resolution_domain === bridge.resolutionDomain &&
    row.provenance === bridge.provenance &&
    row.resolver_reason === bridge.resolver.reason &&
    Number(row.resolver_version) === bridge.resolver.version &&
    endpointColumnsMatch(row, 'source', bridge.source) &&
    endpointColumnsMatch(row, 'target', bridge.target)
  );
}

function endpointColumnsMatch(row: BridgeRow, side: 'source' | 'target', endpoint: CodeGraphBridgeEndpointV1): boolean {
  return (
    row[`${side}_repository_id`] === endpoint.repositoryId &&
    row[`${side}_repository_key`] === endpoint.repositoryKey &&
    row[`${side}_snapshot_id`] === endpoint.snapshotId &&
    row[`${side}_moniker_id`] === endpoint.monikerId &&
    row[`${side}_reference_kind`] === referenceKind(endpoint.reference) &&
    row[`${side}_reference`] === referenceValue(endpoint.reference) &&
    row[`${side}_evidence_path`] === endpoint.evidence.path
  );
}

function parseCanonicalBridge(value: unknown): CodeGraphCrossRepositoryBridgeV1 {
  const bridge = exactRecord(
    value,
    [
      'confidence',
      'id',
      'identity',
      'kind',
      'provenance',
      'relation',
      'resolutionDomain',
      'resolver',
      'source',
      'target',
      'version',
    ],
    'bridge',
  );
  const resolver = exactRecord(bridge.resolver, ['name', 'reason', 'version'], 'resolver');
  const source = parseEndpoint(bridge.source, 'import');
  const target = parseEndpoint(bridge.target, 'export');
  const kind = oneOf(bridge.kind, ['package', 'file', 'message', 'service', 'rpc'] as const, 'bridge kind');
  const relation = oneOf(bridge.relation, ['depends_on', 'imports'] as const, 'bridge relation');
  const resolutionDomain = oneOf(bridge.resolutionDomain, ['package:npm', 'protobuf'] as const, 'resolution domain');
  const reason = oneOf(
    resolver.reason,
    ['declared-npm-package-compatible', 'exact-protobuf-identity'] as const,
    'resolver reason',
  );
  const identity = boundedText(bridge.identity, 'bridge identity', MAX_IDENTITY_BYTES);
  const id = boundedText(bridge.id, 'bridge ID', 68);
  if (
    bridge.version !== CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_VERSION ||
    bridge.confidence !== 1 ||
    bridge.provenance !== 'declared' ||
    resolver.name !== 'threadnote-native-moniker' ||
    resolver.version !== CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION ||
    !BRIDGE_ID.test(id) ||
    source.identity !== identity ||
    target.identity !== identity ||
    source.repositoryId === target.repositoryId
  ) {
    throw invalid('Bridge fields are not canonical.');
  }
  const packageBridge = kind === 'package';
  if (
    (packageBridge &&
      (relation !== 'depends_on' ||
        resolutionDomain !== 'package:npm' ||
        reason !== 'declared-npm-package-compatible' ||
        source.reference.kind !== 'component' ||
        target.reference.kind !== 'component')) ||
    (!packageBridge &&
      (relation !== 'imports' ||
        resolutionDomain !== 'protobuf' ||
        reason !== 'exact-protobuf-identity' ||
        source.reference.kind !== 'qualified-ref' ||
        target.reference.kind !== 'qualified-ref'))
  ) {
    throw invalid('Bridge scheme, relation, and endpoint fields are inconsistent.');
  }
  const canonical: CodeGraphCrossRepositoryBridgeV1 = {
    confidence: 1,
    id,
    identity,
    kind,
    provenance: 'declared',
    relation,
    resolutionDomain,
    resolver: {name: 'threadnote-native-moniker', reason, version: CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION},
    source,
    target,
    version: CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_VERSION,
  };
  if (id !== bridgeIdentity(canonical)) throw invalid('Bridge identity does not bind its endpoint snapshots.');
  if (!structurallyEqual(value, canonical)) throw invalid('Bridge fields are not in canonical form.');
  return canonical;
}

function parseEndpoint(value: unknown, expectedRole: 'export' | 'import'): CodeGraphBridgeEndpointV1 {
  const endpoint = exactRecord(
    value,
    ['evidence', 'identity', 'monikerId', 'reference', 'repositoryId', 'repositoryKey', 'role', 'snapshotId'],
    'endpoint',
  );
  const evidence = exactRecord(endpoint.evidence, ['path', 'span'], 'evidence');
  const span = exactRecord(evidence.span, ['column', 'endColumn', 'endLine', 'line'], 'evidence span');
  const parsedSpan = {
    column: nonNegativeInteger(span.column, 'span column', 1),
    endColumn: nonNegativeInteger(span.endColumn, 'span end column', 1),
    endLine: nonNegativeInteger(span.endLine, 'span end line', 1),
    line: nonNegativeInteger(span.line, 'span line', 1),
  };
  if (
    parsedSpan.endLine < parsedSpan.line ||
    (parsedSpan.endLine === parsedSpan.line && parsedSpan.endColumn < parsedSpan.column)
  ) {
    throw invalid('Bridge evidence span is invalid.');
  }
  const role = oneOf(endpoint.role, ['export', 'import'] as const, 'endpoint role');
  if (role !== expectedRole) throw invalid('Bridge endpoint direction is invalid.');
  const repositoryId = boundedText(endpoint.repositoryId, 'repository identity', 64);
  const monikerId = boundedText(endpoint.monikerId, 'moniker identity', 68);
  if (!REPOSITORY_ID.test(repositoryId) || !MONIKER_ID.test(monikerId)) {
    throw invalid('Bridge endpoint identity is invalid.');
  }
  return {
    evidence: {
      path: relativeEvidencePath(evidence.path),
      span: parsedSpan,
    },
    identity: boundedText(endpoint.identity, 'endpoint identity', MAX_IDENTITY_BYTES),
    monikerId,
    reference: parseReference(endpoint.reference),
    repositoryId,
    repositoryKey: boundedText(endpoint.repositoryKey, 'repository key', MAX_REPOSITORY_KEY_BYTES),
    role,
    snapshotId: boundedText(endpoint.snapshotId, 'snapshot identity', MAX_SNAPSHOT_ID_BYTES),
  };
}

function parseReference(value: unknown): CodeGraphBridgeEndpointReferenceV1 {
  const record = recordValue(value, 'endpoint reference');
  if (record.kind === 'component') {
    exactKeys(record, ['componentId', 'kind'], 'component reference');
    const componentId = boundedText(record.componentId, 'component identity', 36);
    if (!COMPONENT_ID.test(componentId)) throw invalid('Bridge component reference is invalid.');
    return {componentId, kind: 'component'};
  }
  if (record.kind === 'qualified-ref') {
    exactKeys(record, ['kind', 'ref'], 'qualified reference');
    const ref = boundedText(record.ref, 'qualified reference', 44);
    if (!QUALIFIED_REF.test(ref)) throw invalid('Bridge qualified reference is invalid.');
    return {kind: 'qualified-ref', ref};
  }
  throw invalid('Bridge endpoint reference kind is invalid.');
}

function bridgeIdentity(bridge: CodeGraphCrossRepositoryBridgeV1): string {
  return `cgb_${sha256HexSync(
    [
      'threadnote-code-graph-cross-repository-bridge-v1',
      bridge.resolver.version,
      bridge.resolutionDomain,
      bridge.kind,
      bridge.identity,
      bridge.source.repositoryId,
      bridge.source.snapshotId,
      bridge.source.monikerId,
      bridge.target.repositoryId,
      bridge.target.snapshotId,
      bridge.target.monikerId,
    ].join('\0'),
  )}`;
}

function compareBridges(left: CodeGraphCrossRepositoryBridgeV1, right: CodeGraphCrossRepositoryBridgeV1): number {
  return (
    compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
    compareCodeUnits(left.identity, right.identity) ||
    compareCodeUnits(left.source.repositoryKey, right.source.repositoryKey) ||
    compareCodeUnits(left.target.repositoryKey, right.target.repositoryKey) ||
    compareCodeUnits(left.id, right.id)
  );
}

function validateReadRequest(input: {
  readonly after?: CodeGraphCrossRepositoryBridgeCursorV1;
  readonly direction: 'incoming' | 'outgoing';
  readonly endpoint: CodeGraphCrossRepositoryEndpointKeyV1;
  readonly generationId: string;
  readonly limit?: number;
}) {
  if (!GENERATION_ID.test(input.generationId)) throw invalid('Bridge generation identity is invalid.');
  if (input.direction !== 'incoming' && input.direction !== 'outgoing') {
    throw invalid('Bridge read direction is invalid.');
  }
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CODE_GRAPH_WORKSET_CATALOG_LIMITS.readPageMaximum) {
    throw invalid('Bridge read limit is invalid.');
  }
  const endpoint = parseEndpointKey(input.endpoint);
  if (
    input.after !== undefined &&
    (!Number.isSafeInteger(input.after.ordinal) ||
      input.after.ordinal < 0 ||
      input.after.ordinal >= CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration ||
      !BRIDGE_ID.test(input.after.bridgeId))
  ) {
    throw invalid('Bridge read cursor is invalid.');
  }
  return {...input, endpoint, limit};
}

function validateRepositoryReadRequest(input: {
  readonly after?: CodeGraphCrossRepositoryBridgeCursorV1;
  readonly direction: 'incoming' | 'outgoing';
  readonly generationId: string;
  readonly limit?: number;
  readonly repository: CodeGraphCrossRepositoryRepositorySnapshotKeyV1;
}) {
  const validated = validateGenerationReadRequest(input);
  if (input.direction !== 'incoming' && input.direction !== 'outgoing') {
    throw invalid('Bridge read direction is invalid.');
  }
  const repository = exactRecord(input.repository, ['repositoryId', 'snapshotId'], 'repository snapshot key');
  const repositoryId = boundedText(repository.repositoryId, 'repository identity', 64);
  if (!REPOSITORY_ID.test(repositoryId)) throw invalid('Bridge repository identity is invalid.');
  return {
    ...validated,
    direction: input.direction,
    repository: {
      repositoryId,
      snapshotId: boundedText(repository.snapshotId, 'snapshot identity', MAX_SNAPSHOT_ID_BYTES),
    },
  };
}

function validateGenerationReadRequest(input: {
  readonly after?: CodeGraphCrossRepositoryBridgeCursorV1;
  readonly generationId: string;
  readonly limit?: number;
}) {
  if (!GENERATION_ID.test(input.generationId)) throw invalid('Bridge generation identity is invalid.');
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CODE_GRAPH_WORKSET_CATALOG_LIMITS.readPageMaximum) {
    throw invalid('Bridge read limit is invalid.');
  }
  if (
    input.after !== undefined &&
    (!Number.isSafeInteger(input.after.ordinal) ||
      input.after.ordinal < 0 ||
      input.after.ordinal >= CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration ||
      !BRIDGE_ID.test(input.after.bridgeId))
  ) {
    throw invalid('Bridge read cursor is invalid.');
  }
  return {...input, limit};
}

function parseEndpointKey(value: unknown): CodeGraphCrossRepositoryEndpointKeyV1 {
  const endpoint = exactRecord(value, ['reference', 'repositoryId', 'snapshotId'], 'endpoint key');
  const repositoryId = boundedText(endpoint.repositoryId, 'repository identity', 64);
  if (!REPOSITORY_ID.test(repositoryId)) throw invalid('Bridge endpoint repository identity is invalid.');
  return {
    reference: parseReference(endpoint.reference),
    repositoryId,
    snapshotId: boundedText(endpoint.snapshotId, 'snapshot identity', MAX_SNAPSHOT_ID_BYTES),
  };
}

function relativeEvidencePath(value: unknown): string {
  const path = boundedText(value, 'evidence path', MAX_EVIDENCE_PATH_BYTES).normalize('NFC').replaceAll('\\', '/');
  if (path.startsWith('/') || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw invalid('Bridge evidence path is invalid.');
  }
  return path;
}

function endpointSnapshotKey(repositoryId: string, snapshotId: string): string {
  return `${repositoryId}\0${snapshotId}`;
}

function referenceKind(reference: CodeGraphBridgeEndpointReferenceV1): 'component' | 'qualified-ref' {
  return reference.kind;
}

function referenceValue(reference: CodeGraphBridgeEndpointReferenceV1): string {
  return reference.kind === 'component' ? reference.componentId : reference.ref;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string') throw invalid(`Bridge ${label} is invalid.`);
  const normalized = value.normalize('NFC').trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > maximumBytes ||
    [...normalized].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)
  ) {
    throw invalid(`Bridge ${label} is invalid.`);
  }
  return normalized;
}

function nonNegativeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw invalid(`Bridge ${label} is invalid.`);
  }
  return value;
}

function boundedCount(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`Bridge ${label} is invalid.`);
  }
  return value;
}

function oneOf<const Values extends readonly string[]>(value: unknown, values: Values, label: string): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw invalid(`Bridge ${label} is invalid.`);
  return value;
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  label: string,
): Readonly<Record<string, unknown>> {
  const record = recordValue(value, label);
  exactKeys(record, keys, label);
  return record;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid(`Bridge ${label} fields are invalid.`);
  }
}

function recordValue(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!Predicate.isObject(value)) {
    throw invalid(`Bridge ${label} is invalid.`);
  }
  return value;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (!Predicate.isObject(left) || !Predicate.isObject(right)) return false;
  const leftRecord = left;
  const rightRecord = right;
  const leftKeys = Object.keys(leftRecord).sort(compareCodeUnits);
  const rightKeys = Object.keys(rightRecord).sort(compareCodeUnits);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]))
  );
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw corrupt(`Catalog ${label} is invalid.`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw corrupt(`Catalog ${label} is invalid.`);
  }
  return parsed;
}

function validateInput<A>(evaluate: () => A): Effect.Effect<A, CodeGraphWorksetCatalogError> {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      Schema.is(CodeGraphWorksetCatalogError)(cause)
        ? cause
        : CodeGraphWorksetCatalogError.of('invalid-input', 'Cross-repository bridge input is invalid.', {cause}),
  });
}

function validateStored<A>(evaluate: () => A): Effect.Effect<A, CodeGraphWorksetCatalogError> {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      Schema.is(CodeGraphWorksetCatalogError)(cause)
        ? cause
        : CodeGraphWorksetCatalogError.of('corrupt', 'Cross-repository bridge data is invalid.', {cause}),
  });
}

function invalid(message: string): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('invalid-input', message);
}

function corrupt(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('corrupt', message, cause === undefined ? undefined : {cause});
}

const currentIsoInstant = DateTime.now.pipe(Effect.map(DateTime.formatIso));
