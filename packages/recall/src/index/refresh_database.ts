import {Array as EffectArray, Clock, DateTime, Effect, FileSystem, Path, Predicate} from 'effect';
import {runtimeReadBoundedStableRegularFile} from '@threadnote/platform/system';
import {applicationError, fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import * as EffectString from 'effect/String';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  isExternalResourceUri,
  parseExternalResourceIdentity,
  readExternalDocumentManifest,
} from '@threadnote/store/external-resource';
import {parseMemoryDocument} from '@threadnote/memory/document';
import type {RecallIndexConfig, RecallIndexProgress} from '../index.js';
import {deriveIndexedRecallCodeLinks} from '../code_links.js';
import {deriveIndexedRecallMemoryLinks} from '../memory/links.js';
import {recallDocumentTerms} from '../rank.js';
import {indexCandidate, recallExactSearchText} from './candidate.js';
import {loadCanonicalResourcePolicy, verifyCanonicalResource} from './canonical_resource.js';
import {
  recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh,
  recallLogicalScope,
  RECALL_INVENTORY_POLICY_VERSION,
} from './freshness.js';
import * as RecallIndexIdentity from './identity.js';
import {candidatePostings} from './lexical.js';
import {captureRecallSourceInput, normalizeRecallHydrationChanges, recallRefreshSuperseded} from './refresh_cut.js';
import {numericMetadata} from './read_policy.js';
import type {RecallStaleMarker} from './stale_marker.js';
import {
  countRecallSourceChanges,
  MAX_INDEXED_FILE_BYTES,
  forEachChangedRecallSourcePage,
  hashRecallRefreshGeneration,
  insertIndexedRecallSources,
  RECALL_REFRESH_AFFECTED_TERM_TABLE,
  RECALL_REFRESH_INDEXED_CODE_LINK_TABLE,
  RECALL_REFRESH_INDEXED_DOCUMENT_TABLE,
  RECALL_REFRESH_INDEXED_MEMORY_LINK_TABLE,
  RECALL_REFRESH_INDEXED_POSTING_TABLE,
  RECALL_REFRESH_REPLACED_DOCUMENT_TABLE,
  RECALL_REFRESH_SOURCE_TABLE,
  stageRecallRefreshAffectedTerms,
  scanRecallSources,
  tryStageTouchedRecallSources,
  recallSourceIsIntentionallyExcluded,
  recallSourceIsWithinIndexRoots,
  type IndexedRecallSource,
} from './refresh.js';

export interface RecallRefreshBase {
  readonly metadata: ReadonlyMap<string, string>;
  readonly staleMarker: RecallStaleMarker | undefined;
  readonly canonicalMutationGeneration: string;
  readonly policyInputProof: string | undefined;
}

/** TEMP-only preparation; callers supply a deferred snapshot without publication locks. */
export const prepareRecallDatabase = Effect.fn('recall.prepareDatabase')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallIndexConfig,
  includeInactive: boolean,
  forceRefresh: boolean,
  base: RecallRefreshBase,
  mode: {readonly kind: 'full'} | {readonly kind: 'touched'; readonly contentGeneration: string},
  onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>,
) {
  const previousMetadata = base.metadata;
  const staleMarker = base.staleMarker;
  const staleGeneration = staleMarker?.generation;
  const canonicalMutationGeneration = base.canonicalMutationGeneration;
  const markerChanged = previousMetadata.get('stale_generation') !== (staleGeneration ?? '');
  const canonicalMutationGenerationChanged =
    (previousMetadata.get('canonical_mutation_generation') ?? '') !== canonicalMutationGeneration;
  const canonicalMutationContinuityAllowsIncrementalRefresh =
    recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh({
      ...(staleMarker?.canonicalMutationGeneration === undefined
        ? {}
        : {markerCurrentGeneration: staleMarker.canonicalMutationGeneration}),
      ...(staleMarker?.previousCanonicalMutationGeneration === undefined
        ? {}
        : {markerPreviousGeneration: staleMarker.previousCanonicalMutationGeneration}),
      observedGeneration: canonicalMutationGeneration,
      persistedGeneration: previousMetadata.get('canonical_mutation_generation') ?? '',
    });
  const invalidatedUris = markerChanged ? new Set(staleMarker?.invalidatedUris ?? []) : new Set<string>();
  const forceFromMarker = markerChanged && staleMarker?.forceRefresh === true;
  let canonicalResourcePolicy = yield* loadCanonicalResourcePolicy(
    config,
    input => new Error(input.message, {cause: input.cause}),
    mode.kind === 'touched' ? invalidatedUris : undefined,
  );
  const touched =
    mode.kind === 'touched'
      ? yield* tryStageTouchedRecallSources(
          sql,
          fs,
          path,
          config,
          {includeInactive, canonicalResourcePolicy, invalidatedUris},
          mode.contentGeneration,
        )
      : undefined;
  if (mode.kind === 'touched' && touched === undefined)
    canonicalResourcePolicy = yield* loadCanonicalResourcePolicy(
      config,
      input => new Error(input.message, {cause: input.cause}),
    );
  const sourceScan =
    touched === undefined
      ? {
          ...(yield* scanRecallSources(
            sql,
            fs,
            path,
            config,
            includeInactive,
            canonicalResourcePolicy,
            invalidatedUris,
          )),
          mode: 'full' as const,
          forceAllSources: mode.kind === 'touched',
        }
      : {...touched, mode: 'touched' as const, forceAllSources: false};
  const forceAllSources =
    forceRefresh ||
    sourceScan.forceAllSources ||
    forceFromMarker ||
    (canonicalMutationGenerationChanged && !canonicalMutationContinuityAllowsIncrementalRefresh);
  const refreshCounts = yield* countRecallSourceChanges(sql, forceAllSources);
  yield* onProgress?.({
    completed: 0,
    phase: 'indexing',
    scanned: sourceScan.scannedSourceCount,
    total: refreshCounts.changedSourceCount,
  }) ?? Effect.void;
  let indexedSourceCount = 0;
  const sourceInputs = new Map(sourceScan.omittedSourceInputs);
  yield* forEachChangedRecallSourcePage(sql, forceAllSources, page =>
    Effect.gen(function* () {
      const indexedSources = yield* Effect.forEach(
        page,
        source =>
          Effect.gen(function* () {
            if ((yield* fs.realPath(source.path)) !== source.path) return yield* recallRefreshSuperseded();
            const input = yield* captureRecallSourceInput(source.path);
            const expected = input.info;
            if (
              !expected ||
              expected.size !== BigInt(source.size) ||
              (source.modifiedAt !== undefined &&
                Number(expected.mtimeNs / 1_000_000n) !==
                  DateTime.toEpochMillis(DateTime.makeUnsafe(source.modifiedAt)))
            )
              return yield* recallRefreshSuperseded();
            const bytes = yield* fromPromiseInterruptibleAwaiting(
              () =>
                runtimeReadBoundedStableRegularFile(
                  source.path,
                  Math.min(MAX_INDEXED_FILE_BYTES, Number(expected.size)),
                  expected,
                ),
              cause => applicationError('recall.source-read', cause),
            ).pipe(
              Effect.catchIf(
                error =>
                  Predicate.isObject(error.cause) &&
                  '_tag' in error.cause &&
                  error.cause._tag === 'SystemOperationError' &&
                  (EffectString.startsWith('Target changed')(error.message) ||
                    EffectString.startsWith('Target is not')(error.message)),
                () => Effect.fail(recallRefreshSuperseded()),
              ),
            );
            if (
              (yield* captureRecallSourceInput(source.path)).key !== input.key ||
              (yield* fs.realPath(source.path)) !== source.path
            )
              return yield* recallRefreshSuperseded();
            sourceInputs.set(source.path, input.key);
            const content = new TextDecoder().decode(bytes);
            const canonicalResource = yield* verifyCanonicalResource(fs, source.uri, content, canonicalResourcePolicy);
            const memory = isExternalResourceUri(source.uri) ? undefined : parseMemoryDocument(source.uri, content);
            const externalIdentity = parseExternalResourceIdentity(source.uri);
            const externalManifest =
              externalIdentity === undefined
                ? undefined
                : yield* readExternalDocumentManifest(
                    {home: config.agentContextHome, account: config.account, user: config.user},
                    externalIdentity.sourceId,
                    externalIdentity.documentId,
                  );
            const candidate = indexCandidate(
              source.uri,
              content,
              canonicalResource,
              memory,
              externalManifest?.fetchedAt,
            );
            const memoryLinkProjection = deriveIndexedRecallMemoryLinks(memory);
            const postings = candidatePostings(candidate);
            return {
              candidate,
              codeLinks: deriveIndexedRecallCodeLinks(memory?.metadata.codeCitations ?? []),
              documentLength: recallDocumentTerms(candidate).length,
              exactSearchText: recallExactSearchText(candidate),
              memoryLinks: memoryLinkProjection.links,
              memoryLinksTruncated: memoryLinkProjection.truncated,
              postings,
              source,
            } satisfies IndexedRecallSource;
          }).pipe(normalizeRecallHydrationChanges),
        {concurrency: 16},
      );
      yield* insertIndexedRecallSources(sql, indexedSources);
      indexedSourceCount += indexedSources.length;
      yield* onProgress?.({
        completed: indexedSourceCount,
        phase: 'indexing',
        scanned: sourceScan.scannedSourceCount,
        total: refreshCounts.changedSourceCount,
      }) ?? Effect.void;
    }),
  );
  const previousContentGeneration = previousMetadata.get('content_generation');
  const contentGeneration =
    refreshCounts.changedSourceCount === 0 && refreshCounts.removedSourceCount === 0 && previousContentGeneration
      ? previousContentGeneration
      : yield* hashRecallRefreshGeneration(sql, previousContentGeneration);
  const previousValidatedAt = numericMetadata(previousMetadata, 'validated_at');
  const now = yield* Clock.currentTimeMillis;
  const rebindingScope =
    sourceScan.mode === 'full' &&
    previousMetadata.has('logical_scope') &&
    previousMetadata.get('logical_scope') !== recallLogicalScope(config, includeInactive);
  let removedCursor: string | undefined;
  for (;;) {
    const removed = yield* sql.unsafe<{readonly uri: string; readonly source_path: string}>(
      `
      SELECT d.uri,d.source_path FROM documents AS d
      LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS s ON s.uri=d.uri
      WHERE s.uri IS NULL ${removedCursor === undefined ? '' : 'AND d.uri COLLATE BINARY > ? COLLATE BINARY'}
      ORDER BY d.uri COLLATE BINARY LIMIT 256`,
      removedCursor === undefined ? [] : [removedCursor],
    );
    yield* Effect.forEach(
      removed,
      row =>
        Effect.gen(function* () {
          if (sourceInputs.has(row.source_path)) return;
          const input = yield* captureRecallSourceInput(row.source_path);
          if (input.info?.isFile()) {
            const physical = rebindingScope ? yield* fs.realPath(row.source_path).pipe(Effect.option) : undefined;
            const outsideReboundScope =
              physical !== undefined &&
              physical._tag === 'Some' &&
              physical.value === path.normalize(row.source_path) &&
              !recallSourceIsWithinIndexRoots(config, path, row.uri, physical.value);
            if (
              !outsideReboundScope &&
              !recallSourceIsIntentionallyExcluded(config, path, includeInactive, row.uri, row.source_path)
            )
              return yield* recallRefreshSuperseded();
          }
          sourceInputs.set(row.source_path, input.key);
        }),
      {concurrency: 16, discard: true},
    );
    if (removed.length < 256) break;
    removedCursor = removed.at(-1)!.uri;
  }
  yield* stageRecallRefreshAffectedTerms(sql);
  return {
    staleGeneration,
    canonicalMutationGeneration,
    policyInputProof: base.policyInputProof,
    sourceScan,
    refreshCounts,
    contentGeneration,
    previousValidatedAt,
    now,
    sourceInputs,
  };
});

export type PreparedRecallDatabase = Effect.Success<ReturnType<typeof prepareRecallDatabase>>;

/** Main-table publication only; caller owns the fresh write transaction and complete source-cut CAS. */
export const publishPreparedRecallDatabase = Effect.fn('recall.publishPreparedDatabase')(function* (
  sql: SqlClient.SqlClient,
  config: RecallIndexConfig,
  includeInactive: boolean,
  prepared: PreparedRecallDatabase,
) {
  const {staleGeneration, canonicalMutationGeneration, sourceScan, contentGeneration, previousValidatedAt, now} =
    prepared;
  yield* sql.unsafe(`
    DELETE FROM exact_search
    WHERE rowid IN (SELECT document_id FROM temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE})
  `);
  yield* sql.unsafe(`
    DELETE FROM documents
    WHERE id IN (SELECT document_id FROM temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE})
  `);
  yield* sql.unsafe(`
    INSERT INTO documents (
      uri,
      project,
      approved_authoritative,
      workspace_scope,
      source_path,
      source_modified_at,
      recorded_at,
      source_size,
      authority_policy_key,
      candidate_json,
      logical_key,
      document_length,
      memory_links_truncated
    )
    SELECT
      indexed.uri,
      indexed.project,
      indexed.approved_authoritative,
      indexed.workspace_scope,
      source.source_path,
      source.source_modified_at,
      indexed.recorded_at,
      source.source_size,
      source.authority_policy_key,
      indexed.candidate_json,
      indexed.logical_key,
      indexed.document_length,
      indexed.memory_links_truncated
    FROM temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} AS indexed
    INNER JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = indexed.uri
    ORDER BY indexed.uri COLLATE BINARY
  `);
  yield* sql.unsafe(`
    INSERT INTO exact_search (rowid, content)
    SELECT document.id, indexed.exact_search_text
    FROM temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} AS indexed
    INNER JOIN documents AS document ON document.uri = indexed.uri
    ORDER BY indexed.uri COLLATE BINARY
  `);
  yield* sql.unsafe(`
    INSERT INTO code_links (document_id, document_uri, citation_ordinal, selector_kind, selector_digest)
    SELECT document.id, document.uri, code_link.citation_ordinal, code_link.selector_kind, code_link.selector_digest
    FROM temp.${RECALL_REFRESH_INDEXED_CODE_LINK_TABLE} AS code_link
    INNER JOIN documents AS document ON document.uri = code_link.uri
    ORDER BY
      document.id,
      code_link.citation_ordinal,
      code_link.selector_kind COLLATE BINARY,
      code_link.selector_digest COLLATE BINARY
  `);
  yield* sql.unsafe(`
    INSERT INTO memory_links (
      source_document_id,
      source_uri,
      source_memory_id,
      target_memory_id,
      target_locator_digest,
      relation_type,
      relation_origin,
      relation_ordinal
    )
    SELECT
      document.id,
      document.uri,
      memory_link.source_memory_id,
      memory_link.target_memory_id,
      memory_link.target_locator_digest,
      memory_link.relation_type,
      memory_link.relation_origin,
      memory_link.relation_ordinal
    FROM temp.${RECALL_REFRESH_INDEXED_MEMORY_LINK_TABLE} AS memory_link
    INNER JOIN documents AS document ON document.uri = memory_link.uri
    ORDER BY
      document.id,
      memory_link.relation_origin COLLATE BINARY,
      memory_link.relation_ordinal,
      memory_link.relation_type COLLATE BINARY,
      memory_link.target_memory_id COLLATE BINARY,
      memory_link.target_locator_digest COLLATE BINARY
  `);
  yield* sql.unsafe(`
    INSERT INTO postings (term, document_id, field_weight, term_frequency)
    SELECT posting.term, document.id, posting.field_weight, posting.term_frequency
    FROM temp.${RECALL_REFRESH_INDEXED_POSTING_TABLE} AS posting
    INNER JOIN documents AS document ON document.uri = posting.uri
    ORDER BY posting.term COLLATE BINARY, document.id
  `);
  yield* RecallIndexIdentity.rebuildRecallIdentityConflicts(sql);
  yield* resolveLegacyRecallMemoryLinks(sql);
  yield* sql.unsafe(`
    DELETE FROM term_statistics
    WHERE term IN (SELECT term FROM temp.${RECALL_REFRESH_AFFECTED_TERM_TABLE})
  `);
  yield* sql.unsafe(`
    INSERT INTO term_statistics (term, document_frequency)
    SELECT posting.term, COUNT(DISTINCT document.logical_key)
    FROM postings AS posting
    INNER JOIN documents AS document ON document.id = posting.document_id
    WHERE posting.term IN (SELECT term FROM temp.${RECALL_REFRESH_AFFECTED_TERM_TABLE})
    GROUP BY posting.term
  `);
  const aggregate = yield* sql<{
    readonly document_count: number;
    readonly total_document_length: number | null;
  }>`
    SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length
    FROM documents
  `;
  const documentCount = aggregate[0]?.document_count ?? 0;
  const totalDocumentLength = aggregate[0]?.total_document_length ?? 0;
  const logicalAggregate = yield* sql<{
    readonly document_count: number;
    readonly total_document_length: number | null;
  }>`
    SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length
    FROM (
      SELECT logical_key, MAX(document_length) AS document_length
      FROM documents
      GROUP BY logical_key
    )
  `;
  const logicalDocumentCount = logicalAggregate[0]?.document_count ?? 0;
  const logicalTotalDocumentLength = logicalAggregate[0]?.total_document_length ?? 0;
  const metadataEntries = [
    ['canonical_mutation_generation', canonicalMutationGeneration],
    ['content_generation', contentGeneration],
    ['inventory_policy_version', RECALL_INVENTORY_POLICY_VERSION],
    ['inventory_policy_content_generation', contentGeneration],
    ['source_policy_inputs', prepared.policyInputProof ?? ''],
    ['document_count', String(documentCount)],
    ['include_inactive', includeInactive ? 'true' : 'false'],
    ['logical_scope', recallLogicalScope(config, includeInactive)],
    ['logical_scope_content_generation', contentGeneration],
    ['initialized', 'true'],
    ['memory_identity_conflict_generation', contentGeneration],
    ['logical_document_count', String(logicalDocumentCount)],
    ['logical_total_document_length', String(logicalTotalDocumentLength)],
    ['oversized_document_count', String(sourceScan.skippedOversizedDocumentCount)],
    ['stale_generation', staleGeneration ?? ''],
    ['total_document_length', String(totalDocumentLength)],
    ['validated_at', String(Math.max(now, previousValidatedAt + 1))],
  ] as const;
  yield* sql.unsafe(
    `INSERT INTO metadata (key, value) VALUES ${EffectArray.join(
      EffectArray.map(metadataEntries, () => '(?, ?)'),
      ', ',
    )}
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    metadataEntries.flat(),
  );
  yield* sql.unsafe(`
    INSERT INTO metadata (key, value)
    SELECT 'integrity_sequence', value FROM metadata WHERE key = 'mutation_sequence'
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  return documentCount;
});

/**
 * Legacy URI edges retain only a locator digest. Re-resolve every such row
 * against the exact corpus staged for this database so target add/delete/move
 * operations converge with a clean rebuild even when the source is unchanged.
 */
const resolveLegacyRecallMemoryLinks = Effect.fn('recall.resolveLegacyMemoryLinks')(function* (
  sql: SqlClient.SqlClient,
) {
  const resolvedTarget = `(SELECT json_extract(target.candidate_json, '$.memoryId')
    FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS target_source
    INNER JOIN documents AS target ON target.uri = target_source.uri
    WHERE target_source.uri_locator_digest = memory_links.target_locator_digest
      AND json_type(target.candidate_json, '$.memoryId') = 'text'
      AND COALESCE(json_extract(target.candidate_json, '$.status'), 'active') = 'active'
      AND length(json_extract(target.candidate_json, '$.memoryId')) BETWEEN 4 AND 131
      AND substr(json_extract(target.candidate_json, '$.memoryId'), 1, 3) = 'tn_'
      AND substr(json_extract(target.candidate_json, '$.memoryId'), 4) NOT GLOB '*[^A-Za-z0-9_-]*'
      AND NOT EXISTS (
        SELECT 1 FROM memory_identity_conflicts AS conflict
        WHERE conflict.memory_id = json_extract(target.candidate_json, '$.memoryId')
      )
      AND (
        SELECT COUNT(*) FROM documents AS identity_document
        WHERE json_extract(identity_document.candidate_json, '$.memoryId') =
          json_extract(target.candidate_json, '$.memoryId')
      ) = 1
    ORDER BY target.uri COLLATE BINARY
    LIMIT 1)`;
  yield* sql.unsafe(`
    UPDATE memory_links
    SET target_memory_id = COALESCE(${resolvedTarget}, '')
    WHERE target_locator_digest <> ''
      AND target_memory_id <> COALESCE(${resolvedTarget}, '')
  `);
});
