import {Effect, Predicate} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION,
  type CodeGraphCheckpointImportBuildInput,
  type CodeGraphCheckpointCoverageSummary,
  type CodeGraphCheckpointImportReceipt,
  type CodeGraphCheckpointImportReceiptInput,
  type CodeGraphCheckpointImportRecordPage,
  type CodeGraphLanguagePackProvenance,
} from './models.js';
import {
  CodeGraphStoreError,
  isCodeGraphStoreError,
  type CodeGraphEdge,
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
} from '../types.js';
import {
  CODE_GRAPH_CHECKPOINT_RECORD_KINDS,
  emptyCodeGraphCheckpointCounts,
  parseCodeGraphCheckpointRecordV1,
  type CodeGraphCheckpointRecordKind,
  type CodeGraphCheckpointRecordV1,
} from '../checkpoint/schema.js';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {parseCodeGraphMonikerV1} from '../cross_repository/monikers.js';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import {ensureBoundedCodeGraphFact} from '../fact/budget.js';
import {decodeStoredCodeGraphFact, encodeStoredCodeGraphFact} from '../fact/storage.js';
import {materializedFileShardIdentity} from './cache.js';
import {stagePersistedFullFacts} from './resolution/core.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';

interface CheckpointImportRow {
  readonly abi_algorithm: unknown;
  readonly abi_digest: unknown;
  readonly artifact_algorithm: unknown;
  readonly artifact_digest: unknown;
  readonly artifact_media_type: unknown;
  readonly artifact_size: unknown;
  readonly base_logical_digest: unknown;
  readonly coverage_json: unknown;
  readonly format_version: unknown;
  readonly logical_algorithm: unknown;
  readonly logical_digest: unknown;
  readonly recorded_at: unknown;
  readonly snapshot_id: unknown;
  readonly source_commit_id: unknown;
  readonly source_graph_content_id: unknown;
  readonly source_repository_id: unknown;
  readonly trust: unknown;
}

interface CheckpointSnapshotAuthorityRow {
  readonly base_snapshot_id: unknown;
  readonly commit_id: unknown;
  readonly dirty: unknown;
  readonly graph_content_id: unknown;
  readonly repository_id: unknown;
  readonly scope_id: unknown;
  readonly state: unknown;
}

interface CheckpointImportBuildPlanRow {
  readonly expected_batch_count: unknown;
  readonly expected_counts_json: unknown;
  readonly expected_pack_provenance_json: unknown;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAXIMUM_CHECKPOINT_TEXT_BYTES = 16 * 1_048_576;

function invalid(message: string): CodeGraphStoreError {
  return CodeGraphStoreError.of(message);
}

function boundedNonEmptyText(value: string, maximumBytes: number): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}

function validateCoverage(coverage: CodeGraphCheckpointCoverageSummary): void {
  if (
    (coverage.state !== 'complete' && coverage.state !== 'partial') ||
    !Number.isSafeInteger(coverage.eligibleFiles) ||
    coverage.eligibleFiles < 0 ||
    !Number.isSafeInteger(coverage.excludedFiles) ||
    coverage.excludedFiles < 0 ||
    !Array.isArray(coverage.reasons) ||
    coverage.reasons.length > 1_024
  ) {
    throw invalid('Code graph checkpoint coverage is invalid.');
  }
  const codes = new Set<string>();
  let reasonFiles = 0;
  for (const reason of coverage.reasons) {
    if (
      !boundedNonEmptyText(reason.code, 256) ||
      codes.has(reason.code) ||
      !Number.isSafeInteger(reason.files) ||
      reason.files < 0 ||
      !Number.isSafeInteger(reason.bytes) ||
      reason.bytes < 0
    ) {
      throw invalid('Code graph checkpoint coverage reason is invalid.');
    }
    codes.add(reason.code);
    if (reason.files > Number.MAX_SAFE_INTEGER - reasonFiles) {
      throw invalid('Code graph checkpoint coverage reason totals overflow.');
    }
    reasonFiles += reason.files;
  }
  if (
    reasonFiles !== coverage.excludedFiles ||
    (coverage.excludedFiles === 0 ? coverage.state !== 'complete' : coverage.state !== 'partial')
  ) {
    throw invalid('Code graph checkpoint coverage totals are inconsistent.');
  }
}

/** Codec-independent receipt validation at the local persistence boundary. */
export function validateCodeGraphCheckpointImportReceiptInput(input: CodeGraphCheckpointImportReceiptInput): void {
  if (
    input.formatVersion !== CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION ||
    input.abi.algorithm !== 'sha256' ||
    !SHA256_HEX.test(input.abi.digest) ||
    input.logical.algorithm !== 'sha256' ||
    !SHA256_HEX.test(input.logical.digest) ||
    input.artifact.algorithm !== 'sha256' ||
    !SHA256_HEX.test(input.artifact.digest) ||
    !Number.isSafeInteger(input.artifact.size) ||
    input.artifact.size < 0 ||
    !boundedNonEmptyText(input.artifact.mediaType, 512) ||
    input.baseLogicalDigest !== null ||
    !SHA256_HEX.test(input.source.repositoryId) ||
    !COMMIT_ID.test(input.source.commit) ||
    !boundedNonEmptyText(input.source.graphContentId, 512) ||
    (input.trust !== 'local-unverified' && input.trust !== 'expected-descriptor-verified')
  ) {
    throw invalid('Code graph checkpoint import receipt is invalid.');
  }
  validateCoverage(input.coverage);
}

function encodedCoverage(coverage: CodeGraphCheckpointCoverageSummary): string {
  const encoded = JSON.stringify({
    state: coverage.state,
    eligibleFiles: coverage.eligibleFiles,
    excludedFiles: coverage.excludedFiles,
    reasons: coverage.reasons.map(reason => ({code: reason.code, files: reason.files, bytes: reason.bytes})),
  });
  if (Buffer.byteLength(encoded, 'utf8') > MAXIMUM_CHECKPOINT_TEXT_BYTES) {
    throw invalid('Code graph checkpoint coverage is too large.');
  }
  return encoded;
}

function decodedCoverage(value: unknown): CodeGraphCheckpointCoverageSummary {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAXIMUM_CHECKPOINT_TEXT_BYTES) {
    throw invalid('Stored code graph checkpoint coverage is invalid.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw invalid('Stored code graph checkpoint coverage is invalid.');
  }
  if (!Predicate.isObject(decoded)) {
    throw invalid('Stored code graph checkpoint coverage is invalid.');
  }
  const object = decoded;
  if (!Array.isArray(object.reasons)) throw invalid('Stored code graph checkpoint coverage is invalid.');
  const reasons: CodeGraphCheckpointCoverageSummary['reasons'][number][] = [];
  for (const reason of object.reasons) {
    if (!Predicate.isObject(reason)) throw invalid('Stored code graph checkpoint coverage is invalid.');
    if (typeof reason.bytes !== 'number' || typeof reason.code !== 'string' || typeof reason.files !== 'number') {
      throw invalid('Stored code graph checkpoint coverage is invalid.');
    }
    reasons.push({bytes: reason.bytes, code: reason.code, files: reason.files});
  }
  const state = coverageState(object.state);
  if (typeof object.eligibleFiles !== 'number' || typeof object.excludedFiles !== 'number') {
    throw invalid('Stored code graph checkpoint coverage is invalid.');
  }
  const coverage = {
    eligibleFiles: object.eligibleFiles,
    excludedFiles: object.excludedFiles,
    reasons,
    state,
  };
  validateCoverage(coverage);
  return coverage;
}

function receiptColumns(input: CodeGraphCheckpointImportReceiptInput) {
  validateCodeGraphCheckpointImportReceiptInput(input);
  return {
    abiAlgorithm: input.abi.algorithm,
    abiDigest: input.abi.digest,
    artifactAlgorithm: input.artifact.algorithm,
    artifactDigest: input.artifact.digest,
    artifactMediaType: input.artifact.mediaType,
    artifactSize: input.artifact.size,
    baseLogicalDigest: input.baseLogicalDigest,
    coverageJson: encodedCoverage(input.coverage),
    formatVersion: input.formatVersion,
    logicalAlgorithm: input.logical.algorithm,
    logicalDigest: input.logical.digest,
    sourceCommitId: input.source.commit,
    sourceGraphContentId: input.source.graphContentId,
    sourceRepositoryId: input.source.repositoryId,
    trust: input.trust,
  } as const;
}

function encodedRecordCounts(input: CodeGraphCheckpointImportBuildInput): string {
  if (!Number.isSafeInteger(input.batchCount) || input.batchCount < 0) {
    throw invalid('Code graph checkpoint import batch count is invalid.');
  }
  const counts = Object.fromEntries(
    CODE_GRAPH_CHECKPOINT_RECORD_KINDS.map(kind => {
      const count = input.recordCounts[kind];
      if (!Number.isSafeInteger(count) || count < 0) {
        throw invalid(`Code graph checkpoint ${kind} record count is invalid.`);
      }
      return [kind, count];
    }),
  );
  return JSON.stringify(counts);
}

function decodedRecordCounts(value: unknown): Readonly<Record<CodeGraphCheckpointRecordKind, number>> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw invalid('Stored code graph checkpoint record counts are invalid.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw invalid('Stored code graph checkpoint record counts are invalid.');
  }
  if (!Predicate.isObject(decoded)) {
    throw invalid('Stored code graph checkpoint record counts are invalid.');
  }
  const object = decoded;
  if (
    Object.keys(object).length !== CODE_GRAPH_CHECKPOINT_RECORD_KINDS.length ||
    CODE_GRAPH_CHECKPOINT_RECORD_KINDS.some(
      kind => typeof object[kind] !== 'number' || !Number.isSafeInteger(object[kind]) || object[kind] < 0,
    )
  ) {
    throw invalid('Stored code graph checkpoint record counts are invalid.');
  }
  const counts = emptyCodeGraphCheckpointCounts();
  for (const kind of CODE_GRAPH_CHECKPOINT_RECORD_KINDS) {
    const count = object[kind];
    if (typeof count !== 'number') throw invalid('Stored code graph checkpoint record counts are invalid.');
    counts[kind] = count;
  }
  return counts;
}

function encodedPackProvenance(input: CodeGraphCheckpointImportBuildInput): string {
  const packs = validatePackProvenance(input.packProvenance);
  const encoded = JSON.stringify(packs);
  if (Buffer.byteLength(encoded, 'utf8') > MAXIMUM_CHECKPOINT_TEXT_BYTES) {
    throw invalid('Code graph checkpoint pack provenance is too large.');
  }
  return encoded;
}

function decodedPackProvenance(value: unknown): readonly CodeGraphLanguagePackProvenance[] {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAXIMUM_CHECKPOINT_TEXT_BYTES) {
    throw invalid('Stored code graph checkpoint pack provenance is invalid.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw invalid('Stored code graph checkpoint pack provenance is invalid.');
  }
  return validatePackProvenance(decoded);
}

function validatePackProvenance(value: unknown): readonly CodeGraphLanguagePackProvenance[] {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw invalid('Code graph checkpoint pack provenance is invalid.');
  }
  let previousId: string | undefined;
  const packs: CodeGraphLanguagePackProvenance[] = [];
  for (const candidate of value) {
    if (!Predicate.isObject(candidate)) {
      throw invalid('Code graph checkpoint pack provenance is invalid.');
    }
    const pack = candidate;
    if (
      Object.keys(pack).sort().join(',') !== 'cacheIdentity,derivationIdentity,id,resolutionDomain,resolutionVersion' ||
      typeof pack.id !== 'string' ||
      !/^[a-z][a-z0-9-]*$/u.test(pack.id) ||
      (previousId !== undefined && pack.id <= previousId) ||
      typeof pack.cacheIdentity !== 'string' ||
      !SHA256_HEX.test(pack.cacheIdentity) ||
      typeof pack.derivationIdentity !== 'string' ||
      !SHA256_HEX.test(pack.derivationIdentity) ||
      typeof pack.resolutionDomain !== 'string' ||
      !boundedNonEmptyText(pack.resolutionDomain, 16_384) ||
      typeof pack.resolutionVersion !== 'string' ||
      !boundedNonEmptyText(pack.resolutionVersion, 16_384)
    ) {
      throw invalid('Code graph checkpoint pack provenance is invalid.');
    }
    previousId = pack.id;
    packs.push({
      cacheIdentity: pack.cacheIdentity,
      derivationIdentity: pack.derivationIdentity,
      id: pack.id,
      resolutionDomain: pack.resolutionDomain,
      resolutionVersion: pack.resolutionVersion,
    });
  }
  return packs;
}

function receiptFromRow(row: CheckpointImportRow): CodeGraphCheckpointImportReceipt {
  if (
    row.abi_algorithm !== 'sha256' ||
    typeof row.abi_digest !== 'string' ||
    row.artifact_algorithm !== 'sha256' ||
    typeof row.artifact_digest !== 'string' ||
    typeof row.artifact_media_type !== 'string' ||
    (row.base_logical_digest !== null && typeof row.base_logical_digest !== 'string') ||
    Number(row.format_version) !== CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION ||
    row.logical_algorithm !== 'sha256' ||
    typeof row.logical_digest !== 'string' ||
    typeof row.source_commit_id !== 'string' ||
    typeof row.source_graph_content_id !== 'string' ||
    typeof row.source_repository_id !== 'string' ||
    (row.trust !== 'local-unverified' && row.trust !== 'expected-descriptor-verified')
  ) {
    throw invalid('Stored code graph checkpoint import receipt is invalid.');
  }
  const input: CodeGraphCheckpointImportReceiptInput = {
    abi: {algorithm: row.abi_algorithm, digest: row.abi_digest},
    artifact: {
      algorithm: row.artifact_algorithm,
      digest: row.artifact_digest,
      mediaType: row.artifact_media_type,
      size: Number(row.artifact_size),
    },
    baseLogicalDigest: row.base_logical_digest,
    coverage: decodedCoverage(row.coverage_json),
    formatVersion: CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION,
    logical: {algorithm: row.logical_algorithm, digest: row.logical_digest},
    source: {
      commit: row.source_commit_id,
      graphContentId: row.source_graph_content_id,
      repositoryId: row.source_repository_id,
    },
    trust: row.trust,
  };
  validateCodeGraphCheckpointImportReceiptInput(input);
  if (typeof row.snapshot_id !== 'string' || typeof row.recorded_at !== 'string') {
    throw invalid('Stored code graph checkpoint import receipt is invalid.');
  }
  return {...input, importedAt: row.recorded_at, snapshotId: row.snapshot_id};
}

function sameReceiptInput(
  left: CodeGraphCheckpointImportReceiptInput,
  right: CodeGraphCheckpointImportReceiptInput,
): boolean {
  return JSON.stringify(receiptColumns(left)) === JSON.stringify(receiptColumns(right));
}

const selectCheckpointImportRow = Effect.fn('codeGraph.selectCheckpointImportRow')(function* (
  sql: SqlClient.SqlClient,
  table: 'checkpoint_import_builds' | 'checkpoint_import_receipts',
  snapshotId: string,
) {
  const timestamp = table === 'checkpoint_import_builds' ? 'started_at' : 'imported_at';
  const rows = yield* sql.unsafe<CheckpointImportRow>(
    `SELECT snapshot_id, format_version, source_repository_id, source_commit_id,
       source_graph_content_id, abi_algorithm, abi_digest, logical_algorithm, logical_digest,
       base_logical_digest, artifact_algorithm, artifact_digest, artifact_size,
       artifact_media_type, coverage_json, trust, ${timestamp} AS recorded_at
     FROM ${table} WHERE snapshot_id = ?
       AND EXISTS (SELECT 1 FROM snapshots WHERE id = snapshot_id AND scope_id = ?)
     LIMIT 2`,
    [snapshotId, CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY],
  );
  if (rows.length > 1) return yield* invalid('Code graph checkpoint import authority is invalid.');
  return rows[0] ? receiptFromRow(rows[0]) : undefined;
});

const assertSnapshotAuthority = Effect.fn('codeGraph.assertCheckpointSnapshotAuthority')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  input: CodeGraphCheckpointImportReceiptInput,
  acceptedState: 'building' | 'ready',
) {
  const rows = yield* sql.unsafe<CheckpointSnapshotAuthorityRow>(
    `SELECT repository_id, commit_id, graph_content_id, base_snapshot_id, dirty, state, scope_id
     FROM snapshots WHERE id = ? LIMIT 2`,
    [snapshotId],
  );
  const row = rows[0];
  if (row !== undefined && row.scope_id !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) {
    return yield* invalid(
      'Checkpoint v1 import supports only the full repository graph; scoped graph transport requires a verified scope receipt.',
    );
  }
  if (
    rows.length !== 1 ||
    row?.state !== acceptedState ||
    Number(row.dirty) !== 0 ||
    row.base_snapshot_id !== null ||
    row.repository_id !== input.source.repositoryId ||
    row.commit_id !== input.source.commit ||
    row.graph_content_id !== input.source.graphContentId
  ) {
    return yield* invalid(`Code graph checkpoint receipt requires a matching ${acceptedState} clean root.`);
  }
});

export const bindCheckpointImportBuild = Effect.fn('codeGraph.bindCheckpointImportBuild')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  input: CodeGraphCheckpointImportBuildInput,
  startedAt: string,
) {
  const prepared = yield* Effect.try({
    catch: cause => (isCodeGraphStoreError(cause) ? cause : invalid('Code graph checkpoint receipt is invalid.')),
    try: () => ({
      columns: receiptColumns(input),
      countsJson: encodedRecordCounts(input),
      packsJson: encodedPackProvenance(input),
    }),
  });
  const {columns} = prepared;
  yield* assertSnapshotAuthority(sql, snapshotId, input, 'building');
  const owner = yield* sql<{readonly expected_batch_count: unknown}>`
    UPDATE snapshot_build_owners
    SET expected_batch_count = COALESCE(expected_batch_count, ${input.batchCount})
    WHERE snapshot_id = ${snapshotId}
      AND (expected_batch_count IS NULL OR expected_batch_count = ${input.batchCount})
    RETURNING expected_batch_count
  `;
  if (owner.length !== 1 || Number(owner[0]?.expected_batch_count) !== input.batchCount) {
    return yield* invalid('Checkpoint import requires a matching persistent build owner plan.');
  }
  yield* sql`
    INSERT INTO building_lexical_counters (
      snapshot_id, completed_batch_count, posting_count, symbol_count, term_count
    ) VALUES (${snapshotId}, 0, 0, 0, 0)
    ON CONFLICT(snapshot_id) DO NOTHING
  `;
  const existing = yield* selectCheckpointImportRow(sql, 'checkpoint_import_builds', snapshotId);
  if (existing !== undefined) {
    const plan = yield* sql.unsafe<{
      readonly expected_batch_count: unknown;
      readonly expected_counts_json: unknown;
      readonly expected_pack_provenance_json: unknown;
    }>(
      `SELECT expected_batch_count, expected_counts_json, expected_pack_provenance_json
       FROM checkpoint_import_builds WHERE snapshot_id = ? LIMIT 2`,
      [snapshotId],
    );
    if (
      plan.length === 1 &&
      Number(plan[0]?.expected_batch_count) === input.batchCount &&
      plan[0]?.expected_counts_json === prepared.countsJson &&
      plan[0]?.expected_pack_provenance_json === prepared.packsJson &&
      sameReceiptInput(existing, input)
    ) {
      return {state: 'already-bound'} as const;
    }
    return yield* invalid(`Checkpoint import ${snapshotId} is already bound to different content.`);
  }
  yield* sql`
    INSERT INTO checkpoint_import_builds (
      snapshot_id, format_version, source_repository_id, source_commit_id, source_graph_content_id,
      abi_algorithm, abi_digest, logical_algorithm, logical_digest, base_logical_digest,
      artifact_algorithm, artifact_digest, artifact_size, artifact_media_type, coverage_json, trust,
      expected_batch_count, expected_counts_json, expected_pack_provenance_json, started_at
    ) VALUES (
      ${snapshotId}, ${columns.formatVersion}, ${columns.sourceRepositoryId}, ${columns.sourceCommitId},
      ${columns.sourceGraphContentId}, ${columns.abiAlgorithm}, ${columns.abiDigest},
      ${columns.logicalAlgorithm}, ${columns.logicalDigest}, ${columns.baseLogicalDigest},
      ${columns.artifactAlgorithm}, ${columns.artifactDigest}, ${columns.artifactSize},
      ${columns.artifactMediaType}, ${columns.coverageJson}, ${columns.trust}, ${input.batchCount},
      ${prepared.countsJson}, ${prepared.packsJson}, ${startedAt}
    )
  `;
  return {state: 'bound'} as const;
});

/** Verify a building import binding before the existing relational publication checks run. */
export const assertCheckpointImportBuild = Effect.fn('codeGraph.assertCheckpointImportBuild')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  input: CodeGraphCheckpointImportReceiptInput,
) {
  yield* Effect.try({
    catch: cause => (isCodeGraphStoreError(cause) ? cause : invalid('Code graph checkpoint receipt is invalid.')),
    try: () => validateCodeGraphCheckpointImportReceiptInput(input),
  });
  yield* assertSnapshotAuthority(sql, snapshotId, input, 'building');
  const binding = yield* selectCheckpointImportRow(sql, 'checkpoint_import_builds', snapshotId);
  if (binding === undefined || !sameReceiptInput(binding, input)) {
    return yield* invalid(`Checkpoint import ${snapshotId} has no matching build binding.`);
  }
});

const checkpointImportBuildPlan = Effect.fn('codeGraph.checkpointImportBuildPlan')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  const rows = yield* sql.unsafe<CheckpointImportBuildPlanRow>(
    `SELECT expected_batch_count, expected_counts_json, expected_pack_provenance_json
     FROM checkpoint_import_builds WHERE snapshot_id = ? LIMIT 2`,
    [snapshotId],
  );
  if (rows.length !== 1) {
    return yield* invalid(`Checkpoint import ${snapshotId} has no unique build plan.`);
  }
  const expectedBatchCount = Number(rows[0]?.expected_batch_count);
  if (!Number.isSafeInteger(expectedBatchCount) || expectedBatchCount < 0) {
    return yield* invalid('Stored code graph checkpoint batch count is invalid.');
  }
  return {
    expectedBatchCount,
    packProvenance: decodedPackProvenance(rows[0]?.expected_pack_provenance_json),
    recordCounts: decodedRecordCounts(rows[0]?.expected_counts_json),
  };
});

function checkpointSymbol(record: Extract<CodeGraphCheckpointRecordV1, {readonly kind: 'symbol'}>): CodeGraphSymbol {
  const {kind: _recordKind, symbolKind, ...symbol} = record;
  return {...symbol, kind: symbolKind};
}

function checkpointEdge(record: Extract<CodeGraphCheckpointRecordV1, {readonly kind: 'edge'}>): CodeGraphEdge {
  const {kind: _recordKind, ...edge} = record;
  return edge;
}

function checkpointMoniker(
  record: Extract<CodeGraphCheckpointRecordV1, {readonly kind: 'moniker'}>,
): CodeGraphMonikerV1 {
  const {evidencePath, evidenceSpan, kind: _recordKind, monikerKind, ...moniker} = record;
  return parseCodeGraphMonikerV1({
    ...moniker,
    evidence: {path: evidencePath, span: evidenceSpan},
    kind: monikerKind,
  });
}

function coverageState(value: unknown): CodeGraphCheckpointCoverageSummary['state'] {
  if (value === 'complete' || value === 'partial') return value;
  throw invalid('Stored code graph checkpoint coverage is invalid.');
}

function samePackProvenance(
  record: Extract<CodeGraphCheckpointRecordV1, {readonly kind: 'pack-provenance'}>,
  expected: CodeGraphLanguagePackProvenance,
): boolean {
  return (
    record.cacheIdentity === expected.cacheIdentity &&
    record.derivationIdentity === expected.derivationIdentity &&
    record.id === expected.id &&
    record.resolutionDomain === expected.resolutionDomain &&
    record.resolutionVersion === expected.resolutionVersion
  );
}

const stageCheckpointSupplementalRecord = Effect.fn('codeGraph.stageCheckpointSupplementalRecord')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  extractorSet: string,
  record: CodeGraphCheckpointRecordV1,
  now: string,
) {
  switch (record.kind) {
    case 'file': {
      const file: CodeGraphInventoryFile = record;
      yield* sql`
        INSERT INTO snapshot_files (
          snapshot_id, path, content_hash, raw_content_hash, language, mode, size, source
        ) VALUES (
          ${snapshotId}, ${file.path}, ${file.contentHash}, ${file.rawContentHash ?? null},
          ${file.language}, ${file.mode}, ${file.size}, ${file.source}
        )
      `;
      return;
    }
    case 'file-fact': {
      const files = yield* sql<{
        readonly content_hash: string;
        readonly path: string;
      }>`
        SELECT path, content_hash FROM snapshot_files
        WHERE snapshot_id = ${snapshotId} AND path = ${record.path} LIMIT 2
      `;
      if (files.length !== 1 || record.facts.path !== record.path) {
        return yield* invalid(`Checkpoint file fact ${record.path} has no matching inventory row.`);
      }
      const bounded = yield* Effect.try({
        catch: () => invalid(`Checkpoint file fact ${record.path} exceeds the materialized fact boundary.`),
        try: () => ensureBoundedCodeGraphFact(record.facts),
      });
      const encoded = encodeStoredCodeGraphFact(bounded);
      const shardId = materializedFileShardIdentity(
        files[0].content_hash,
        extractorSet,
        record.cacheIdentity,
        record.path,
      );
      yield* sql`
        INSERT INTO materialized_file_shards (
          id, content_hash, extractor_set, derivation_identity, path_hint, facts_json, created_at, last_used_at
        ) VALUES (
          ${shardId}, ${files[0].content_hash}, ${extractorSet}, ${record.cacheIdentity}, ${record.path},
          ${encoded.json}, ${now}, ${now}
        )
        ON CONFLICT(id) DO NOTHING
      `;
      const stored = yield* sql<{
        readonly content_hash: string;
        readonly derivation_identity: string;
        readonly extractor_set: string;
        readonly facts_json: string;
        readonly path_hint: string;
      }>`
        SELECT content_hash, extractor_set, derivation_identity, path_hint, facts_json
        FROM materialized_file_shards WHERE id = ${shardId} LIMIT 2
      `;
      const storedMetadataMatches =
        stored.length === 1 &&
        stored[0]?.content_hash === files[0].content_hash &&
        stored[0]?.extractor_set === extractorSet &&
        stored[0]?.derivation_identity === record.cacheIdentity &&
        stored[0]?.path_hint === record.path;
      if (
        !storedMetadataMatches ||
        !checkpointStoredFactMatches(stored[0].facts_json, encoded.json, bounded.facts, record.path)
      ) {
        return yield* invalid(`Checkpoint file fact ${record.path} conflicts with cached content.`);
      }
      yield* sql`
        INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id)
        VALUES (${snapshotId}, ${record.path}, ${shardId})
      `;
      return;
    }
    case 'workspace-scope':
      yield* sql`
        INSERT INTO workspace_scopes (
          snapshot_id, id, build_system, name, root, provenance, diagnostics_json
        ) VALUES (
          ${snapshotId}, ${record.id}, ${record.buildSystem}, ${record.name}, ${record.root},
          ${record.provenance}, ${JSON.stringify(record.diagnostics)}
        )
      `;
      return;
    case 'workspace-component':
      yield* sql`
        INSERT INTO workspace_components (
          snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
          languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
        ) VALUES (
          ${snapshotId}, ${record.id}, ${record.workspaceId}, ${record.buildSystem}, ${record.componentKind},
          ${record.name}, ${record.root}, ${record.resolutionDomain}, ${JSON.stringify(record.languages)},
          ${JSON.stringify(record.sourceRoots)}, ${JSON.stringify(record.workspaceRoots)}, ${record.provenance},
          ${JSON.stringify(record.diagnostics)}
        )
      `;
      return;
    case 'workspace-dependency':
      yield* sql`
        INSERT INTO workspace_component_dependencies (
          snapshot_id, source_component_id, target_component_id, provenance, evidence
        ) VALUES (
          ${snapshotId}, ${record.sourceComponentId}, ${record.targetComponentId}, ${record.provenance},
          ${record.evidence ?? null}
        )
      `;
      return;
    case 'workspace-external-dependency':
      yield* sql`
        INSERT INTO workspace_external_dependencies (
          snapshot_id, source_component_id, ecosystem, package_name, import_alias, dependency_kind,
          version_constraint, evidence_path, evidence_span_json
        ) VALUES (
          ${snapshotId}, ${record.sourceComponentId}, ${record.ecosystem}, ${record.packageName},
          ${record.importAlias}, ${record.dependencyKind}, ${record.versionConstraint}, ${record.evidencePath},
          ${record.evidenceSpan === undefined ? null : JSON.stringify(record.evidenceSpan)}
        )
      `;
      return;
    case 'symbol-lookup': {
      yield* sql`
        INSERT INTO snapshot_symbol_lookup (
          snapshot_id, lookup_key, symbol_id, resolution_domain, exported, provenance,
          evidence_edge_id, evidence_path
        ) VALUES (
          ${snapshotId}, ${record.lookupKey}, ${record.symbolId}, ${record.resolutionDomain},
          ${record.exported ? 1 : 0}, ${record.provenance}, ${record.evidenceEdgeId ?? null},
          ${record.evidencePath ?? null}
        )
        ON CONFLICT(snapshot_id, lookup_key, symbol_id) DO NOTHING
      `;
      const rows = yield* sql<{
        readonly evidence_edge_id: string | null;
        readonly evidence_path: string | null;
        readonly exported: number;
        readonly provenance: string;
        readonly resolution_domain: string;
      }>`
        SELECT resolution_domain, exported, provenance, evidence_edge_id, evidence_path
        FROM snapshot_symbol_lookup
        WHERE snapshot_id = ${snapshotId} AND lookup_key = ${record.lookupKey} AND symbol_id = ${record.symbolId}
        LIMIT 2
      `;
      if (
        rows.length !== 1 ||
        rows[0]?.resolution_domain !== record.resolutionDomain ||
        Number(rows[0]?.exported) !== (record.exported ? 1 : 0) ||
        rows[0]?.provenance !== record.provenance ||
        rows[0]?.evidence_edge_id !== (record.evidenceEdgeId ?? null) ||
        rows[0]?.evidence_path !== (record.evidencePath ?? null)
      ) {
        return yield* invalid('Checkpoint symbol lookup conflicts with materialized graph facts.');
      }
      return;
    }
    case 'reexport':
      yield* sql`
        INSERT INTO snapshot_reexport_provenance (
          snapshot_id, source_path, local_name, target_path, imported_name
        ) VALUES (
          ${snapshotId}, ${record.sourcePath}, ${record.localName}, ${record.targetPath}, ${record.importedName}
        )
        ON CONFLICT(snapshot_id, source_path, local_name, target_path, imported_name) DO NOTHING
      `;
      return;
    case 'lexical': {
      const rows = yield* sql.unsafe<{readonly weight: unknown}>(
        `SELECT posting.weight
         FROM lexical_compact_snapshots AS snapshot
         JOIN lexical_compact_terms AS term ON term.snapshot_key = snapshot.snapshot_key
         JOIN lexical_compact_postings AS posting
           ON posting.snapshot_key = snapshot.snapshot_key AND posting.term_key = term.term_key
         JOIN lexical_compact_symbols AS symbol
           ON symbol.snapshot_key = snapshot.snapshot_key AND symbol.symbol_key = posting.symbol_key
         WHERE snapshot.snapshot_id = ? AND term.term = ? AND symbol.symbol_id = ?
         LIMIT 2`,
        [snapshotId, record.term, record.symbolId],
      );
      if (rows.length !== 1 || Number(rows[0]?.weight) !== record.weight) {
        return yield* invalid('Checkpoint lexical record differs from ABI-compatible materialization.');
      }
      return;
    }
    case 'pack-provenance':
      yield* sql`
        INSERT INTO snapshot_pack_provenance (
          snapshot_id, pack_id, cache_identity, derivation_identity, resolution_domain, resolution_version
        ) VALUES (
          ${snapshotId}, ${record.id}, ${record.cacheIdentity}, ${record.derivationIdentity},
          ${record.resolutionDomain}, ${record.resolutionVersion}
        )
      `;
      return;
    case 'symbol':
    case 'edge':
    case 'moniker':
      return;
  }
});

export function checkpointStoredFactMatches(
  existing: string,
  incomingEncoded: string,
  incomingFacts: CodeGraphFileFacts,
  path: string,
): boolean {
  if (existing === incomingEncoded) return true;
  try {
    return canonicalJson(decodeStoredCodeGraphFact(existing, path).facts) === canonicalJson(incomingFacts);
  } catch {
    return false;
  }
}

export const stageCheckpointImportRecordPage = Effect.fn('codeGraph.stageCheckpointImportRecordPage')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  page: CodeGraphCheckpointImportRecordPage,
  completedAt: string,
) {
  if (
    !Number.isSafeInteger(page.batchIndex) ||
    page.batchIndex < 0 ||
    page.digest.algorithm !== 'sha256' ||
    !SHA256_HEX.test(page.digest.digest)
  ) {
    return yield* invalid('Code graph checkpoint import record page is invalid.');
  }
  const records = yield* Effect.try({
    catch: () => invalid('Code graph checkpoint import record page is invalid.'),
    try: () => page.records.map(record => parseCodeGraphCheckpointRecordV1(record)),
  });
  if (records.length === 0) {
    return yield* invalid('Code graph checkpoint import record page must not be empty.');
  }
  const plan = yield* checkpointImportBuildPlan(sql, snapshotId);
  const expectedPacks = new Map(plan.packProvenance.map(pack => [pack.id, pack] as const));
  for (const record of records) {
    if (record.kind !== 'pack-provenance') continue;
    const expected = expectedPacks.get(record.id);
    if (expected === undefined || !samePackProvenance(record, expected)) {
      return yield* invalid('Checkpoint record pack provenance differs from its immutable build plan.');
    }
  }
  const existing = yield* sql.unsafe<{
    readonly batch_digest: unknown;
    readonly digest_algorithm: unknown;
    readonly record_count: unknown;
  }>(
    `SELECT digest_algorithm, batch_digest, record_count
     FROM checkpoint_import_batches WHERE snapshot_id = ? AND batch_index = ? LIMIT 2`,
    [snapshotId, page.batchIndex],
  );
  if (existing.length > 0) {
    if (
      existing.length === 1 &&
      existing[0]?.digest_algorithm === 'sha256' &&
      existing[0]?.batch_digest === page.digest.digest &&
      Number(existing[0]?.record_count) === records.length
    ) {
      return {records: records.length, state: 'already-staged'} as const;
    }
    return yield* invalid(`Checkpoint import batch ${page.batchIndex} conflicts with durable content.`);
  }
  if (page.batchIndex >= plan.expectedBatchCount) {
    return yield* invalid(`Checkpoint import batch ${page.batchIndex} exceeds its build plan.`);
  }
  const authority = yield* sql.unsafe<{
    readonly extractor_set: unknown;
    readonly owner_token: unknown;
    readonly state: unknown;
  }>(
    `SELECT snapshot.state, snapshot.extractor_set, owner.owner_token
     FROM snapshots AS snapshot
     JOIN snapshot_build_owners AS owner ON owner.snapshot_id = snapshot.id
     JOIN checkpoint_import_builds AS import ON import.snapshot_id = snapshot.id
     WHERE snapshot.id = ? LIMIT 2`,
    [snapshotId],
  );
  if (
    authority.length !== 1 ||
    authority[0]?.state !== 'building' ||
    authority[0]?.owner_token !== ownerToken ||
    typeof authority[0]?.extractor_set !== 'string'
  ) {
    return yield* invalid('Code graph checkpoint import build ownership changed.');
  }
  const staged = yield* sql.unsafe<{
    readonly count: unknown;
    readonly maximum: unknown;
    readonly minimum: unknown;
  }>(
    `SELECT COUNT(*) AS count, MIN(batch_index) AS minimum, MAX(batch_index) AS maximum
     FROM checkpoint_import_batches WHERE snapshot_id = ?`,
    [snapshotId],
  );
  const stagedCount = Number(staged[0]?.count ?? -1);
  if (
    stagedCount !== page.batchIndex ||
    (stagedCount === 0
      ? staged[0]?.minimum !== null || staged[0]?.maximum !== null
      : Number(staged[0]?.minimum) !== 0 || Number(staged[0]?.maximum) !== stagedCount - 1)
  ) {
    return yield* invalid('Checkpoint import batches must be staged in contiguous order.');
  }
  const symbols = records.filter(
    (record): record is Extract<CodeGraphCheckpointRecordV1, {readonly kind: 'symbol'}> => record.kind === 'symbol',
  );
  const edges = records.filter(
    (record): record is Extract<CodeGraphCheckpointRecordV1, {readonly kind: 'edge'}> => record.kind === 'edge',
  );
  const monikers = records.filter(
    (record): record is Extract<CodeGraphCheckpointRecordV1, {readonly kind: 'moniker'}> => record.kind === 'moniker',
  );
  yield* stagePersistedFullFacts(
    sql,
    snapshotId,
    ownerToken,
    page.batchIndex,
    symbols.map(checkpointSymbol),
    edges.map(checkpointEdge),
    [],
    () => Effect.void,
    true,
    undefined,
    monikers.map(checkpointMoniker),
  );
  for (const record of records) {
    yield* stageCheckpointSupplementalRecord(sql, snapshotId, authority[0].extractor_set, record, completedAt);
  }
  yield* sql`
    INSERT INTO checkpoint_import_batches (
      snapshot_id, batch_index, digest_algorithm, batch_digest, record_count, completed_at
    ) VALUES (
      ${snapshotId}, ${page.batchIndex}, ${page.digest.algorithm}, ${page.digest.digest},
      ${records.length}, ${completedAt}
    )
  `;
  return {records: records.length, state: 'staged'} as const;
});

export const verifyCheckpointImportRecordCounts = Effect.fn('codeGraph.verifyCheckpointImportRecordCounts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  const plan = yield* checkpointImportBuildPlan(sql, snapshotId);
  const rows = yield* sql.unsafe<Record<CodeGraphCheckpointRecordKind | 'batches', unknown>>(
    `SELECT
        (SELECT COUNT(*) FROM checkpoint_import_batches WHERE snapshot_id = ?) AS batches,
        (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = ?) AS file,
        (SELECT COUNT(*) FROM snapshot_file_shards WHERE snapshot_id = ?) AS "file-fact",
        (SELECT COUNT(*) FROM workspace_scopes WHERE snapshot_id = ?) AS "workspace-scope",
        (SELECT COUNT(*) FROM workspace_components WHERE snapshot_id = ?) AS "workspace-component",
        (SELECT COUNT(*) FROM workspace_component_dependencies WHERE snapshot_id = ?) AS "workspace-dependency",
        (SELECT COUNT(*) FROM workspace_external_dependencies WHERE snapshot_id = ?) AS "workspace-external-dependency",
        (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ?) AS symbol,
        (SELECT COUNT(*) FROM snapshot_symbol_lookup WHERE snapshot_id = ?) AS "symbol-lookup",
        (SELECT COUNT(*) FROM snapshot_reexport_provenance WHERE snapshot_id = ?) AS reexport,
        (SELECT COUNT(*) FROM edges WHERE snapshot_id = ?) AS edge,
        (SELECT COUNT(*) FROM code_graph_monikers WHERE snapshot_id = ?) AS moniker,
        (SELECT COUNT(*)
           FROM lexical_compact_snapshots AS snapshot
           JOIN lexical_compact_postings AS posting ON posting.snapshot_key = snapshot.snapshot_key
          WHERE snapshot.snapshot_id = ?) AS lexical,
        (SELECT COUNT(*) FROM snapshot_pack_provenance WHERE snapshot_id = ?) AS "pack-provenance"`,
    Array.from({length: 14}, () => snapshotId),
  );
  const row = rows[0];
  if (row === undefined || Number(row.batches) !== plan.expectedBatchCount) {
    return yield* invalid('Checkpoint import has incomplete record batches.');
  }
  for (const kind of CODE_GRAPH_CHECKPOINT_RECORD_KINDS) {
    if (Number(row[kind]) !== plan.recordCounts[kind]) {
      return yield* invalid(`Checkpoint import ${kind} record count does not match its header.`);
    }
  }
  const persistedPacks = yield* sql<{
    readonly cache_identity: string;
    readonly derivation_identity: string;
    readonly pack_id: string;
    readonly resolution_domain: string;
    readonly resolution_version: string;
  }>`
    SELECT pack_id, cache_identity, derivation_identity, resolution_domain, resolution_version
    FROM snapshot_pack_provenance
    WHERE snapshot_id = ${snapshotId}
    ORDER BY pack_id
  `;
  if (
    persistedPacks.length !== plan.packProvenance.length ||
    persistedPacks.some((pack, index) => {
      const expected = plan.packProvenance[index];
      return (
        expected === undefined ||
        pack.pack_id !== expected.id ||
        pack.cache_identity !== expected.cacheIdentity ||
        pack.derivation_identity !== expected.derivationIdentity ||
        pack.resolution_domain !== expected.resolutionDomain ||
        pack.resolution_version !== expected.resolutionVersion
      );
    })
  ) {
    return yield* invalid('Checkpoint import pack provenance does not match its immutable build plan.');
  }
  const invalidEndpoints = yield* sql.unsafe<{readonly count: unknown}>(
    `SELECT
        (SELECT COUNT(*)
           FROM workspace_components AS component
           LEFT JOIN workspace_scopes AS workspace
             ON workspace.snapshot_id = component.snapshot_id AND workspace.id = component.workspace_id
          WHERE component.snapshot_id = ? AND workspace.id IS NULL)
        + (SELECT COUNT(*)
             FROM workspace_component_dependencies AS dependency
             LEFT JOIN workspace_components AS source
               ON source.snapshot_id = dependency.snapshot_id AND source.id = dependency.source_component_id
             LEFT JOIN workspace_components AS target
               ON target.snapshot_id = dependency.snapshot_id AND target.id = dependency.target_component_id
            WHERE dependency.snapshot_id = ? AND (source.id IS NULL OR target.id IS NULL))
        + (SELECT COUNT(*)
             FROM workspace_external_dependencies AS dependency
             LEFT JOIN workspace_components AS source
               ON source.snapshot_id = dependency.snapshot_id AND source.id = dependency.source_component_id
             LEFT JOIN snapshot_files AS evidence
               ON evidence.snapshot_id = dependency.snapshot_id AND evidence.path = dependency.evidence_path
            WHERE dependency.snapshot_id = ? AND (source.id IS NULL OR evidence.path IS NULL))
        + (SELECT COUNT(*)
             FROM symbols AS symbol
             LEFT JOIN snapshot_files AS file
               ON file.snapshot_id = symbol.snapshot_id AND file.path = symbol.path
            WHERE symbol.snapshot_id = ? AND file.path IS NULL)
        + (SELECT COUNT(*)
             FROM snapshot_symbol_lookup AS lookup
             LEFT JOIN symbols AS symbol
               ON symbol.snapshot_id = lookup.snapshot_id AND symbol.id = lookup.symbol_id
             LEFT JOIN edges AS evidence
               ON evidence.snapshot_id = lookup.snapshot_id AND evidence.id = lookup.evidence_edge_id
            WHERE lookup.snapshot_id = ?
              AND (symbol.id IS NULL OR (lookup.evidence_edge_id IS NOT NULL AND evidence.id IS NULL)))
        + (SELECT COUNT(*)
             FROM snapshot_reexport_provenance AS reexport
             LEFT JOIN snapshot_files AS source
               ON source.snapshot_id = reexport.snapshot_id AND source.path = reexport.source_path
             LEFT JOIN snapshot_files AS target
               ON target.snapshot_id = reexport.snapshot_id AND target.path = reexport.target_path
            WHERE reexport.snapshot_id = ? AND (source.path IS NULL OR target.path IS NULL))
        + (SELECT COUNT(*)
             FROM edges AS edge
             LEFT JOIN snapshot_files AS evidence
               ON evidence.snapshot_id = edge.snapshot_id AND evidence.path = edge.evidence_path
            WHERE edge.snapshot_id = ? AND evidence.path IS NULL)
        + (SELECT COUNT(*)
             FROM code_graph_monikers AS moniker
             LEFT JOIN snapshot_files AS evidence
               ON evidence.snapshot_id = moniker.snapshot_id AND evidence.path = moniker.evidence_path
             LEFT JOIN workspace_components AS component
               ON component.snapshot_id = moniker.snapshot_id AND component.id = moniker.component_id
             LEFT JOIN symbols AS symbol
               ON symbol.snapshot_id = moniker.snapshot_id AND symbol.id = moniker.symbol_id
            WHERE moniker.snapshot_id = ?
              AND (evidence.path IS NULL
                OR (moniker.component_id IS NOT NULL AND component.id IS NULL)
                OR (moniker.symbol_id IS NOT NULL AND symbol.id IS NULL))) AS count`,
    Array.from({length: 8}, () => snapshotId),
  );
  const invalidEndpointCount = Number(invalidEndpoints[0]?.count ?? -1);
  if (!Number.isSafeInteger(invalidEndpointCount) || invalidEndpointCount !== 0) {
    return yield* invalid('Checkpoint import contains dangling relational endpoints.');
  }
});

function receiptInputFromReceipt(receipt: CodeGraphCheckpointImportReceipt): CodeGraphCheckpointImportReceiptInput {
  const {importedAt: _importedAt, snapshotId: _snapshotId, ...input} = receipt;
  return input;
}

/** Called inside the ready-state transaction after all relational invariants passed. */
export const publishCheckpointImportReceipt = Effect.fn('codeGraph.publishCheckpointImportReceipt')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  input: CodeGraphCheckpointImportReceiptInput,
  importedAt: string,
) {
  const columns = receiptColumns(input);
  const existing = yield* selectCheckpointImportRow(sql, 'checkpoint_import_receipts', snapshotId);
  if (existing !== undefined) {
    if (sameReceiptInput(existing, input)) return existing;
    return yield* invalid(`Checkpoint import receipt ${snapshotId} conflicts with immutable content.`);
  }
  yield* sql`
    INSERT INTO checkpoint_import_receipts (
      snapshot_id, format_version, source_repository_id, source_commit_id, source_graph_content_id,
      abi_algorithm, abi_digest, logical_algorithm, logical_digest, base_logical_digest,
      artifact_algorithm, artifact_digest, artifact_size, artifact_media_type, coverage_json, trust, imported_at
    ) VALUES (
      ${snapshotId}, ${columns.formatVersion}, ${columns.sourceRepositoryId}, ${columns.sourceCommitId},
      ${columns.sourceGraphContentId}, ${columns.abiAlgorithm}, ${columns.abiDigest},
      ${columns.logicalAlgorithm}, ${columns.logicalDigest}, ${columns.baseLogicalDigest},
      ${columns.artifactAlgorithm}, ${columns.artifactDigest}, ${columns.artifactSize},
      ${columns.artifactMediaType}, ${columns.coverageJson}, ${columns.trust}, ${importedAt}
    )
  `;
  yield* sql`DELETE FROM checkpoint_import_builds WHERE snapshot_id = ${snapshotId}`;
  return {...input, importedAt, snapshotId} satisfies CodeGraphCheckpointImportReceipt;
});

export const recordReadyCheckpointImportReceipt = Effect.fn('codeGraph.recordReadyCheckpointImportReceipt')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  input: CodeGraphCheckpointImportReceiptInput,
  importedAt: string,
) {
  yield* assertSnapshotAuthority(sql, snapshotId, input, 'ready');
  const existing = yield* selectCheckpointImportRow(sql, 'checkpoint_import_receipts', snapshotId);
  if (existing !== undefined) {
    if (!sameReceiptInput(receiptInputFromReceipt(existing), input)) {
      return yield* invalid(`Checkpoint import receipt ${snapshotId} conflicts with immutable content.`);
    }
    return {receipt: existing, state: 'already-recorded'} as const;
  }
  const receipt = yield* publishCheckpointImportReceipt(sql, snapshotId, input, importedAt);
  return {receipt, state: 'recorded'} as const;
});

export const readCheckpointImportReceipt = Effect.fn('codeGraph.readCheckpointImportReceipt')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  return yield* selectCheckpointImportRow(sql, 'checkpoint_import_receipts', snapshotId);
});

export const selectReadySnapshotByLogicalDigest = Effect.fn('codeGraph.selectReadySnapshotByLogicalDigest')(function* (
  sql: SqlClient.SqlClient,
  repositoryId: string,
  logicalDigest: string,
  abiDigest?: string,
) {
  if (!SHA256_HEX.test(repositoryId) || !SHA256_HEX.test(logicalDigest) || (abiDigest && !SHA256_HEX.test(abiDigest))) {
    return yield* invalid('Code graph checkpoint logical-digest lookup is invalid.');
  }
  const rows = yield* sql.unsafe<{
    readonly base_snapshot_id: string | null;
    readonly commit_id: string;
    readonly completed_at: string | null;
    readonly dirty: number;
    readonly edge_count: number;
    readonly extractor_set: string;
    readonly file_count: number;
    readonly graph_content_id: string | null;
    readonly id: string;
    readonly overlay_fingerprint: string | null;
    readonly repository_id: string;
    readonly scope_id: string;
    readonly state: CodeGraphSnapshot['state'];
    readonly symbol_count: number;
    readonly worktree_id: string;
  }>(
    `SELECT snapshot.*
       FROM checkpoint_import_receipts AS receipt
       JOIN snapshots AS snapshot ON snapshot.id = receipt.snapshot_id
       WHERE receipt.source_repository_id = ?
         AND receipt.logical_algorithm = 'sha256'
         AND receipt.logical_digest = ?
         AND (? IS NULL OR receipt.abi_digest = ?)
         AND snapshot.state = 'ready'
         AND snapshot.dirty = 0
         AND snapshot.base_snapshot_id IS NULL
         AND snapshot.scope_id = ?
       ORDER BY receipt.imported_at DESC, receipt.snapshot_id
       LIMIT 1`,
    [repositoryId, logicalDigest, abiDigest ?? null, abiDigest ?? null, CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    baseSnapshotId: row.base_snapshot_id ?? undefined,
    commit: row.commit_id,
    completedAt: row.completed_at ?? undefined,
    dirty: Number(row.dirty) === 1,
    edgeCount: Number(row.edge_count),
    extractorSet: row.extractor_set,
    fileCount: Number(row.file_count),
    graphContentId: row.graph_content_id ?? undefined,
    id: row.id,
    overlayFingerprint: row.overlay_fingerprint ?? undefined,
    repositoryId: row.repository_id,
    state: row.state,
    symbolCount: Number(row.symbol_count),
    worktreeId: row.worktree_id,
  } satisfies CodeGraphSnapshot;
});
