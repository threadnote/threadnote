import {Array as EffectArray, Effect, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {projectResolutionLookupKeyIdentity, type ProjectResolutionLookupKey} from '../../incremental/closure.js';
import {chunk} from '../utilities.js';
import {CANDIDATE_PAGE_PROTOCOL_SHA} from './candidate_pages.js';
import {readCandidateKeyWavePages} from './candidate_page_read.js';
import {PROJECT_INCREMENTAL_CLOSURE_MAX_FILES} from '../../incremental/closure.js';
import {CODE_GRAPH_RESOLUTION_SURFACE_VERSION, CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION} from '../models.js';
import {
  PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_ASSOCIATIONS,
  PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVATIONS,
  PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES,
  PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS,
  PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES,
  PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS,
  resolutionCandidateLookupKeyClosure,
  type ProjectResolutionCandidateClosure,
  type ProjectResolutionCandidateScanFallbackDetail,
  type ProjectResolutionReexportKeys,
} from './candidate_closure.js';
import {
  RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES,
  RESOLUTION_CANDIDATE_INDEX_VERSION,
  resolutionCandidateIndexSchemaReady,
  resolutionCandidateAuthorityToken,
  type ResolutionCandidateIndexIdentity,
  type ResolutionCandidateIndexQuery,
} from './candidate_index.js';

interface IndexReceiptRow {
  readonly base_snapshot_id: string | null;
  readonly root_snapshot_id: string | null;
  readonly version: number;
  readonly file_count: number;
  readonly state: string;
  readonly snapshot_extractor: string;
  readonly extractor_set: string;
  readonly snapshot_content: string;
  readonly graph_content_id: string;
  readonly snapshot_files: number;
}

const matchingReceipt = Effect.fn('codeGraph.matchingCandidateReceipt')(function* (
  sql: SqlClient.SqlClient,
  input: ResolutionCandidateIndexIdentity,
  authorityToken: string,
) {
  const rows = yield* sql<IndexReceiptRow>`
    SELECT receipt.*, snapshot.base_snapshot_id, snapshot.state, snapshot.extractor_set AS snapshot_extractor,
      snapshot.graph_content_id AS snapshot_content, snapshot.file_count AS snapshot_files
    FROM snapshot_candidate_receipts AS receipt JOIN snapshots AS snapshot ON snapshot.id = receipt.snapshot_id
    JOIN snapshot_candidate_generations AS generation ON generation.snapshot_id = receipt.snapshot_id
      AND generation.kind = 'receipt' AND generation.path = ''
    JOIN snapshot_candidate_authority AS authority ON authority.singleton = 1 AND authority.state = 'ready'
      AND authority.token = generation.authority_token AND authority.token = ${authorityToken}
    JOIN snapshot_candidate_synopsis_snapshots AS page_snapshot ON page_snapshot.snapshot_id = receipt.snapshot_id
      AND page_snapshot.authority_token = ${authorityToken} AND page_snapshot.protocol_sha = ${CANDIDATE_PAGE_PROTOCOL_SHA}
      AND page_snapshot.format_version = 4
    JOIN snapshot_candidate_synopsis_receipts AS page_receipt ON page_receipt.snapshot_key = page_snapshot.snapshot_key
      AND page_receipt.authority_token = ${authorityToken} AND page_receipt.protocol_sha = ${CANDIDATE_PAGE_PROTOCOL_SHA}
      AND page_receipt.format_version = 4 AND page_receipt.file_count = receipt.file_count
    WHERE receipt.snapshot_id = ${input.snapshotId}
      AND receipt.workspace_fingerprint = ${input.workspaceFingerprint}
      AND receipt.file_set_fingerprint = ${input.fileSetFingerprint} LIMIT 1`;
  const row = rows[0];
  return row &&
    (row.state === 'ready' || row.state === 'retired') &&
    row.version === RESOLUTION_CANDIDATE_INDEX_VERSION &&
    Number.isSafeInteger(row.file_count) &&
    row.file_count >= 0 &&
    row.file_count === row.snapshot_files &&
    row.extractor_set === row.snapshot_extractor &&
    row.graph_content_id === row.snapshot_content &&
    row.root_snapshot_id === row.base_snapshot_id
    ? row
    : undefined;
});

interface CandidateIndexLayers {
  readonly rootId: string;
  readonly deltaId?: string;
}
const layerResult = (rootId: string, deltaId?: string): CandidateIndexLayers => ({
  rootId,
  ...(deltaId === undefined ? {} : {deltaId}),
});

/** One physical root plus at most one complete delta. Exact clean aliases need no duplicated index. */
export const resolutionCandidateIndexLayers = Effect.fn('codeGraph.candidateIndexLayers')(function* (
  sql: SqlClient.SqlClient,
  input: ResolutionCandidateIndexIdentity,
  authorityToken: string,
) {
  const own = yield* matchingReceipt(sql, input, authorityToken);
  if (own?.root_snapshot_id === null) return layerResult(input.snapshotId);
  if (own !== undefined) {
    const rootId = own.root_snapshot_id;
    const root = yield* matchingReceipt(sql, {...input, snapshotId: rootId}, authorityToken);
    return root?.root_snapshot_id === null ? layerResult(rootId, input.snapshotId) : undefined;
  }
  const aliases = yield* sql<{readonly base_snapshot_id: string}>`
    SELECT alias.base_snapshot_id FROM snapshots AS alias
    JOIN snapshots AS root ON root.id = alias.base_snapshot_id
    JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = alias.id
    WHERE alias.id = ${input.snapshotId} AND alias.state = 'ready' AND root.state IN ('ready', 'retired')
      AND root.base_snapshot_id IS NULL AND alias.dirty = 0
      AND alias.extractor_set = root.extractor_set AND alias.file_count = root.file_count
      AND alias.symbol_count = root.symbol_count AND alias.edge_count = root.edge_count
      AND receipt.workspace_fingerprint = ${input.workspaceFingerprint}
      AND receipt.file_set_fingerprint = ${input.fileSetFingerprint}
      AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
      AND receipt.resolution_surface_version = ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}
      AND receipt.extractor_set = alias.extractor_set
      AND NOT EXISTS (SELECT 1 FROM snapshot_symbol_lookup WHERE snapshot_id = alias.id)
      AND NOT EXISTS (SELECT 1 FROM snapshot_files WHERE snapshot_id = alias.id)
      AND NOT EXISTS (SELECT 1 FROM snapshot_file_deletions WHERE snapshot_id = alias.id)
    LIMIT 1`;
  const alias = aliases[0];
  if (!alias) return undefined;
  const root = yield* matchingReceipt(sql, {...input, snapshotId: alias.base_snapshot_id}, authorityToken);
  return root?.root_snapshot_id === null ? layerResult(alias.base_snapshot_id) : undefined;
});

const KeySchema = Schema.Struct({key: Schema.String, resolutionDomain: Schema.String});
const ReexportSchema = Schema.Struct({
  aliases: Schema.Array(KeySchema),
  candidates: Schema.Array(KeySchema),
  sourcePath: Schema.String,
});
const identity = (key: ProjectResolutionLookupKey) => projectResolutionLookupKeyIdentity(key.resolutionDomain, key.key);
const bound = (
  detail: ProjectResolutionCandidateScanFallbackDetail,
  observed: number,
  limit: number,
  requiredAtDecision?: number,
) =>
  ({
    mode: 'fallback',
    reason: 'project-closure-unbounded',
    detail,
    observed,
    limit,
    ...(requiredAtDecision === undefined ? {} : {requiredAtDecision}),
  }) as const;

/** No full-fact metadata/decode is needed to find complete affected reference paths. */
export const selectResolutionCandidateIndexClosure = Effect.fn('codeGraph.selectCandidateIndexClosure')(function* (
  sql: SqlClient.SqlClient,
  input: ResolutionCandidateIndexQuery,
) {
  if (
    !Number.isSafeInteger(input.maximumSelectedFiles) ||
    input.maximumSelectedFiles < 0 ||
    input.maximumSelectedFiles > PROJECT_INCREMENTAL_CLOSURE_MAX_FILES
  )
    return {mode: 'fallback', reason: 'cache-incomplete'} as const;
  if (!(yield* resolutionCandidateIndexSchemaReady(sql))) return undefined;
  const authorityToken = yield* resolutionCandidateAuthorityToken(sql);
  if (!authorityToken) return undefined;
  const layers = yield* resolutionCandidateIndexLayers(sql, input, authorityToken);
  if (!layers) return undefined;
  const sources = [layers.rootId, ...(layers.deltaId ? [layers.deltaId] : [])];
  const queried = new Set<string>();
  const paths = new Set<string>();
  const reexportPaths = new Set<string>();
  const reexports: ProjectResolutionReexportKeys[] = [];
  let associationsRead = 0;
  let observations = 0;
  let bitTests = 0;
  let bytesRead = 0;
  let keysQueried = 0;
  let reexportKeys = 0;
  let reexportBytes = 0;
  let reexportCount = 0;
  const chargeReexport = (reexport: ProjectResolutionReexportKeys) => {
    reexportCount += 1;
    reexportKeys += reexport.aliases.length + reexport.candidates.length;
    reexportBytes += EffectArray.reduce(
      [...reexport.aliases, ...reexport.candidates],
      0,
      (n, key) => n + Buffer.byteLength(identity(key)),
    );
    if (reexportCount > PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS)
      return bound('candidate-reexports', reexportCount, PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS);
    if (reexportKeys > PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS)
      return bound(
        'candidate-reexport-lookup-keys',
        reexportKeys,
        PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS,
      );
    if (reexportBytes > PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES)
      return bound('candidate-reexport-key-bytes', reexportBytes, PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES);
  };
  for (const reexport of input.additionalReexports) {
    const exceeded = chargeReexport(reexport);
    if (exceeded) return exceeded;
  }
  const masked = (snapshotId: string) => (snapshotId === layers.rootId ? layers.deltaId : undefined);
  let closure = resolutionCandidateLookupKeyClosure(input.initialLookupKeys, input.additionalReexports);
  for (;;) {
    if (closure.mode === 'fallback') return closure;
    const keys = new Map<string, ProjectResolutionLookupKey>();
    for (const key of input.initialLookupKeys) keys.set(identity(key), key);
    for (const reexport of [...input.additionalReexports, ...reexports]) {
      for (const key of [...reexport.aliases, ...reexport.candidates]) keys.set(identity(key), key);
    }
    const wave: ProjectResolutionLookupKey[] = [];
    for (const id of closure.identities) {
      if (queried.has(id)) continue;
      const key = keys.get(id);
      if (!key) return undefined;
      queried.add(id);
      wave.push(key);
      keysQueried += 1;
      bytesRead += Buffer.byteLength(id);
    }
    const progressed = wave.length > 0;
    if (bytesRead > PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES)
      return bound(
        'candidate-projection-observed-key-bytes',
        bytesRead,
        PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES,
      );
    for (const snapshotId of sources) {
      const before = {associations: associationsRead, observations, bytes: bytesRead};
      const selected = yield* readCandidateKeyWavePages(
        sql,
        snapshotId,
        masked(snapshotId),
        wave,
        PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_ASSOCIATIONS - associationsRead,
        PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES - bytesRead,
        input.maximumSelectedFiles,
        authorityToken,
        PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVATIONS - observations,
      );
      if (!selected) return undefined;
      associationsRead += selected.associations;
      observations += selected.observations;
      bitTests += selected.bitTests;
      bytesRead += selected.bytes;
      if (selected.exceeded === 'rows')
        return bound(
          'candidate-projection-associations',
          associationsRead,
          PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_ASSOCIATIONS,
          selected.requiredAtDecision === undefined ? undefined : before.associations + selected.requiredAtDecision,
        );
      if (selected.exceeded === 'observations')
        return bound(
          'candidate-projection-observations',
          observations,
          PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVATIONS,
          selected.requiredAtDecision === undefined ? undefined : before.observations + selected.requiredAtDecision,
        );
      if (selected.exceeded === 'bytes')
        return bound(
          'candidate-projection-observed-key-bytes',
          bytesRead,
          PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES,
          selected.requiredAtDecision === undefined ? undefined : before.bytes + selected.requiredAtDecision,
        );
      for (const path of selected.paths) paths.add(path);
      if (selected.exceeded === 'files' || paths.size > input.maximumSelectedFiles)
        return bound(
          'candidate-selected-files',
          Math.max(paths.size, input.maximumSelectedFiles + 1),
          input.maximumSelectedFiles,
        );
    }
    for (const path of paths) {
      if (reexportPaths.has(path)) continue;
      reexportPaths.add(path);
      for (const snapshotId of sources) {
        const mask = masked(snapshotId);
        // Complete cursor AND payload UTF8 are admitted against the remaining shared budget in SQL.
        let afterEdge: string | undefined;
        for (;;) {
          const before = bytesRead;
          const selected = yield* readCandidateReexportRow(
            sql,
            snapshotId,
            path,
            mask,
            afterEdge,
            PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES - bytesRead,
          );
          if (!selected) return undefined;
          bytesRead += selected.bytes;
          if (selected.exceeded)
            return bound(
              'candidate-projection-observed-key-bytes',
              bytesRead,
              PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES,
              before + selected.requiredAtDecision,
            );
          const row = selected.row;
          if (!row) break;
          const decoded = yield* Effect.try((): unknown => JSON.parse(row.payload_json)).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (!Schema.is(ReexportSchema)(decoded) || decoded.sourcePath !== path) return undefined;
          afterEdge = row.edge_id;
          reexports.push(decoded);
          const exceeded = chargeReexport(decoded);
          if (exceeded) return exceeded;
        }
      }
    }
    closure = resolutionCandidateLookupKeyClosure(input.initialLookupKeys, [
      ...input.additionalReexports,
      ...reexports,
    ]);
    if (closure.mode === 'fallback') return closure;
    if (!progressed || EffectArray.every([...closure.identities], key => queried.has(key))) break;
  }
  const aliases = new Map<string, ProjectResolutionLookupKey>();
  for (const reexport of [...input.additionalReexports, ...reexports])
    for (const key of reexport.aliases) aliases.set(identity(key), key);
  const conflicts = new Set<string>();
  for (const page of chunk([...aliases.values()], 64)) {
    for (const key of page) {
      keysQueried += 1;
      for (const snapshotId of sources) {
        const mask = masked(snapshotId);
        const rows = yield* sql`
          SELECT 1 FROM snapshot_symbol_lookup AS lookup
          WHERE snapshot_id = ${snapshotId} AND lookup_key = ${key.key} AND resolution_domain = ${key.resolutionDomain}
            AND provenance = 'symbol' AND NOT EXISTS (SELECT 1 FROM snapshot_files AS replacement
              WHERE replacement.snapshot_id = ${mask ?? null} AND replacement.path = lookup.evidence_path)
            AND NOT EXISTS (SELECT 1 FROM snapshot_file_deletions AS deletion WHERE deletion.snapshot_id = ${mask ?? null} AND deletion.path = lookup.evidence_path) LIMIT 1`;
        if (rows.length > 0) conflicts.add(identity(key));
      }
      bytesRead += Buffer.byteLength(identity(key));
      if (bytesRead > PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES)
        return bound(
          'candidate-projection-observed-key-bytes',
          bytesRead,
          PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES,
        );
    }
  }
  if ((yield* resolutionCandidateAuthorityToken(sql)) !== authorityToken) return undefined;
  const retained = yield* resolutionCandidateIndexLayers(sql, input, authorityToken);
  if (!retained || retained.rootId !== layers.rootId || retained.deltaId !== layers.deltaId) return undefined;
  return {
    mode: 'eligible',
    paths: [...paths].sort(),
    reexports,
    affectedAliasLookupIdentities: closure.aliasIdentities,
    directAliasSymbolConflictIdentities: conflicts,
    factBytes: 0,
    scannedFiles: 0,
    lookupKeys: closure.identities.size,
    candidateIndex: {keysQueried, associationsRead, reexportsRead: reexports.length, bytesRead, observations, bitTests},
  } satisfies Extract<ProjectResolutionCandidateClosure, {readonly mode: 'eligible'}>;
});

/** Scalar admission precedes BOTH complete cursor and payload hydration/JSON parsing. */
export const readCandidateReexportRow = Effect.fn('codeGraph.readCandidateReexportRow')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  path: string,
  mask: string | undefined,
  afterEdge: string | undefined,
  maximumBytes: number,
) {
  // 128 query/sentinel + 64 for the two scalar lengths and row status, before driver materialization.
  const metadataBytes = 192;
  if (maximumBytes < metadataBytes) return {bytes: 0, exceeded: true as const, requiredAtDecision: metadataBytes};
  const available = maximumBytes - metadataBytes;
  const rows = yield* sql.unsafe<{
    readonly edge_bytes: number;
    readonly payload_bytes: number;
    readonly edge_id: string | null;
    readonly payload_json: string | null;
  }>(
    `SELECT length(CAST(edge_id AS BLOB)) AS edge_bytes,
    length(CAST(payload_json AS BLOB)) AS payload_bytes,
    CASE WHEN length(CAST(payload_json AS BLOB)) <= ?
      AND length(CAST(edge_id AS BLOB)) + length(CAST(payload_json AS BLOB)) <= ? THEN edge_id ELSE NULL END AS edge_id,
    CASE WHEN length(CAST(payload_json AS BLOB)) <= ?
      AND length(CAST(edge_id AS BLOB)) + length(CAST(payload_json AS BLOB)) <= ? THEN payload_json ELSE NULL END AS payload_json
    FROM snapshot_candidate_reexports AS candidate
    WHERE snapshot_id = ? AND evidence_path = ? ${afterEdge === undefined ? '' : 'AND edge_id > ?'}
      AND NOT EXISTS (SELECT 1 FROM snapshot_files AS replacement
        WHERE replacement.snapshot_id = ? AND replacement.path = candidate.evidence_path)
      AND NOT EXISTS (SELECT 1 FROM snapshot_file_deletions AS deletion
        WHERE deletion.snapshot_id = ? AND deletion.path = candidate.evidence_path)
    ORDER BY candidate.edge_id LIMIT 1`,
    [
      RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES,
      available,
      RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES,
      available,
      snapshotId,
      path,
      ...(afterEdge === undefined ? [] : [afterEdge]),
      mask ?? null,
      mask ?? null,
    ],
  );
  const row = rows[0];
  if (!row) return {bytes: metadataBytes};
  if (
    !Number.isSafeInteger(row.edge_bytes) ||
    row.edge_bytes < 0 ||
    !Number.isSafeInteger(row.payload_bytes) ||
    row.payload_bytes < 0 ||
    row.payload_bytes > RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES
  )
    return undefined;
  const bytes = metadataBytes + row.edge_bytes + row.payload_bytes;
  if (!Number.isSafeInteger(bytes)) return undefined;
  if (bytes > maximumBytes) return {bytes: metadataBytes, exceeded: true as const, requiredAtDecision: bytes};
  if (
    row.edge_id === null ||
    row.payload_json === null ||
    Buffer.byteLength(row.edge_id) !== row.edge_bytes ||
    Buffer.byteLength(row.payload_json) !== row.payload_bytes
  )
    return undefined;
  return {bytes, row: {edge_id: row.edge_id, payload_json: row.payload_json}};
});
