import {Effect, FileSystem} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  parseMemoryDocument,
  type MemoryRecord,
  type MemoryRelation,
  type MemoryRelationType,
} from '@threadnote/memory/document';
import {isMemoryId, memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {parseResourceId} from '@threadnote/store/resource-id';
import {recallCandidateIsEligible, type RecallEligibilityPolicy} from '../eligibility.js';
import {recallEligibilityPredicate} from '../index/eligibility.js';
import {
  combineRecallSqlPredicates,
  recallUriMatchesScopes,
  recallUriScopePredicate,
  type RecallSqlPredicate,
} from '../index/scope.js';

export const MAX_INDEXED_MEMORY_LINKS_PER_SOURCE = 64;

export type RecallMemoryLinkOrigin = 'evidence' | 'references' | 'relation' | 'supersedes';

export interface IndexedRecallMemoryLink {
  readonly relationOrdinal: number;
  readonly relationOrigin: RecallMemoryLinkOrigin;
  readonly relationType: MemoryRelationType;
  readonly sourceMemoryId: string;
  /** Stable identity selectors use this field directly. Legacy locators are resolved during refresh. */
  readonly targetMemoryId: string;
  /** Present for every legacy canonical URI, including when its current target resolves. */
  readonly targetLocatorDigest: string;
}

export interface IndexedRecallMemoryLinkProjection {
  readonly links: readonly IndexedRecallMemoryLink[];
  readonly truncated: boolean;
}

export interface RecallMemoryLinkSeed {
  readonly memoryId: string;
  readonly requestedOrdinal: number;
}

/** @internal A receipt-proved stable identity for one live ID-less canonical source. */
export interface RecallMemoryLinkWitnessedSource extends RecallMemoryLinkSeed {
  readonly uri: string;
}

export interface RecallMemoryLinkMatch {
  readonly direction: 'incoming' | 'outgoing';
  readonly relationOrdinal: number;
  readonly relationOrigin: RecallMemoryLinkOrigin;
  readonly relationType: MemoryRelationType;
  readonly requestedOrdinal: number;
  readonly sourceMemoryId: string;
  readonly sourceUri: string;
  readonly targetMemoryId?: string;
}

export interface RecallMemoryLinkQueryOptions {
  readonly allowedUriScopes?: readonly string[];
  /** @internal Restricts traversal lanes when a caller only needs one direction. */
  readonly directions?: readonly ('incoming' | 'outgoing')[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly includeInactive?: boolean;
  readonly limit?: number;
  /** @internal Bounds each seed lane independently before the fair global slice. */
  readonly limitPerSeed?: number;
  readonly memorySeeds: readonly RecallMemoryLinkSeed[];
  readonly onCanonicalMismatch?: (count: number) => void;
  /** @internal Reuses canonical records already proved while selecting source edges. */
  readonly onCanonicalRecords?: (records: readonly MemoryRecord[]) => void;
  /** @internal Reports every attempted canonical source reread after the bounded SQL selection. */
  readonly onCanonicalReread?: (count: number) => void;
  /** @internal Reports bounded SQL selector rows, including the one-row truncation probe. */
  readonly onRawRows?: (count: number) => void;
  readonly onSearchTruncated?: (seedOrdinals: readonly number[]) => void;
  readonly relationTypes?: readonly MemoryRelationType[];
  /** @internal Restricts canonical source edges to memories current at this instant. */
  readonly sourceCurrentAt?: Date;
  /** @internal Enables an exact-URI outgoing lane only for receipt-witnessed ID-less premises. */
  readonly witnessedSources?: readonly RecallMemoryLinkWitnessedSource[];
}

interface RecallMemoryLinkSelectionRow {
  readonly relation_ordinal: number;
  readonly relation_origin: RecallMemoryLinkOrigin;
  readonly relation_type: MemoryRelationType;
  readonly requested_ordinal: number;
  readonly requested_memory_id: string;
  readonly source_memory_id: string;
  readonly source_path: string;
  readonly source_status: string;
  readonly source_uri: string;
  readonly source_valid_from: string;
  readonly source_valid_to: string;
  readonly target_locator_digest: string;
  readonly target_memory_id: string;
}

interface RecallMemoryLinkRankedMatch extends RecallMemoryLinkMatch {
  readonly laneRank: number;
}

export interface RecallMemoryLinkRawSelectionQuery {
  readonly params: readonly (number | string)[];
  readonly sql: string;
}

interface RecallMemoryLinkSelectionContext {
  readonly relationParams: readonly MemoryRelationType[];
  readonly relationPredicate: string;
  readonly scope: RecallSqlPredicate;
  readonly sourcePredicate: string;
}

interface RecallMemoryLinkCanonicalSelectionResult {
  readonly canonicalMismatch: boolean;
  readonly match?: RecallMemoryLinkMatch;
}

const RECALL_MEMORY_LINK_CANONICAL_BACKFILL_FACTOR = 4;
const RECALL_MEMORY_LINK_CANONICAL_READ_BATCH_SIZE = 16;
const RECALL_MEMORY_LINK_CANONICAL_READ_CONCURRENCY = 16;
const RECALL_MEMORY_LINK_SEED_QUERY_BATCH_SIZE = 32;
const RECALL_MEMORY_LINK_QUERY_PARAMETER_BUDGET = 900;

interface OriginRelation extends MemoryRelation {
  readonly ordinal: number;
  readonly origin: RecallMemoryLinkOrigin;
}

/** Project canonical metadata into privacy-safe, rebuildable memory-edge selectors. */
export function deriveIndexedRecallMemoryLinks(
  memory: ReturnType<typeof parseMemoryDocument>,
): IndexedRecallMemoryLinkProjection {
  if (!memory) return {links: [], truncated: false};
  const sourceMemoryId = isMemoryId(memory.metadata.memoryId ?? '') ? memory.metadata.memoryId! : '';
  // Preserve explicit authoring and supersession before lower-priority legacy
  // provenance so a noisy imported header cannot starve currentness evidence.
  const relations: OriginRelation[] = [
    ...(memory.metadata.supersedes
      ? [{ordinal: 0, origin: 'supersedes' as const, type: 'supersedes' as const, uri: memory.metadata.supersedes}]
      : []),
    ...(memory.metadata.relations ?? []).map((relation, ordinal) => ({
      ...relation,
      ordinal,
      origin: 'relation' as const,
    })),
    ...(memory.metadata.references ?? []).map((uri, ordinal) => ({
      ordinal,
      origin: 'references' as const,
      type: 'references' as const,
      uri,
    })),
    ...(memory.metadata.evidence ?? []).flatMap((uri, ordinal) =>
      uri.startsWith('threadnote://')
        ? [{ordinal, origin: 'evidence' as const, type: 'evidence_for' as const, uri}]
        : [],
    ),
  ];
  const projected = relations.flatMap(relation => {
    let uri: string;
    try {
      uri = parseResourceId(relation.uri).canonicalUri;
    } catch {
      return [];
    }
    const targetMemoryId = memoryIdFromIdentityAlias(uri);
    return [
      {
        relationOrdinal: relation.ordinal,
        relationOrigin: relation.origin,
        relationType: relation.type,
        sourceMemoryId,
        targetLocatorDigest: targetMemoryId === undefined ? memoryLinkLocatorDigest(uri) : '',
        targetMemoryId: targetMemoryId ?? '',
      } satisfies IndexedRecallMemoryLink,
    ];
  });
  const selected = projected.slice(0, MAX_INDEXED_MEMORY_LINKS_PER_SOURCE);
  return {
    links: selected,
    truncated: projected.length > selected.length,
  };
}

/** Domain separation prevents these private locator hashes from being confused with other selectors. */
export function memoryLinkLocatorDigest(uri: string): string {
  const canonicalUri = parseResourceId(uri).canonicalUri;
  return sha256HexSync(JSON.stringify({kind: 'memory-link-locator', uri: canonicalUri, version: 1}));
}

/** @internal Build the exact bounded compound selector used by production and query-plan tests. */
export function buildBoundedRecallMemoryLinkRawQuery(
  direction: 'incoming' | 'outgoing',
  memorySeeds: readonly RecallMemoryLinkSeed[],
  options: Pick<
    RecallMemoryLinkQueryOptions,
    'allowedUriScopes' | 'eligibility' | 'includeInactive' | 'relationTypes' | 'sourceCurrentAt'
  >,
  queryLimit: number,
): RecallMemoryLinkRawSelectionQuery | undefined {
  const seeds = normalizeMemoryLinkSeeds(memorySeeds);
  if (!Number.isSafeInteger(queryLimit) || queryLimit < 1 || seeds.length === 0) return undefined;
  return buildBoundedRecallMemoryLinkRawQueryWithContext(
    direction,
    seeds,
    memoryLinkSelectionContext(options),
    queryLimit,
  );
}

/**
 * Select exact one-hop rows through the source/target indexes, then prove each
 * row against its canonical source document before it can reach a caller.
 */
export const selectRecallMemoryLinks = Effect.fn('recall.selectMemoryLinks')(function* (
  sql: SqlClient.SqlClient,
  options: RecallMemoryLinkQueryOptions,
) {
  const seeds = normalizeMemoryLinkSeeds(options.memorySeeds);
  const limit = boundedRecallMemoryLinkResultLimit(options.limit);
  if (seeds.length === 0 || limit === 0) return [] satisfies readonly RecallMemoryLinkMatch[];
  const perSeedLimit = boundedRecallMemoryLinkPerSeedLimit(options.limitPerSeed ?? limit);
  if (perSeedLimit === 0) return [] satisfies readonly RecallMemoryLinkMatch[];
  const scanLimit = perSeedLimit * RECALL_MEMORY_LINK_CANONICAL_BACKFILL_FACTOR;
  const selectionContext = memoryLinkSelectionContext(options);
  const selected: RecallMemoryLinkRankedMatch[] = [];
  const truncatedSeeds = new Set<number>();
  let canonicalMismatchCount = 0;
  let canonicalRereadCount = 0;
  let rawRowCount = 0;
  const fs = yield* FileSystem.FileSystem;
  const canonicalMemoryByPath = new Map<string, MemoryRecord | undefined>();
  const verifiedCanonicalRecordsByUri = new Map<string, MemoryRecord>();

  const parametersPerSeed = 4 + selectionContext.scope.params.length + selectionContext.relationParams.length;
  const seedQueryBatchSize = Math.max(
    1,
    Math.min(
      RECALL_MEMORY_LINK_SEED_QUERY_BATCH_SIZE,
      Math.floor(RECALL_MEMORY_LINK_QUERY_PARAMETER_BUDGET / parametersPerSeed),
    ),
  );
  const directions = normalizeMemoryLinkDirections(options.directions);
  const witnessedSourceBySeed = normalizeWitnessedMemoryLinkSources(options.witnessedSources ?? [], seeds);
  for (const direction of directions) {
    const rowsBySeed = new Map<string, RecallMemoryLinkSelectionRow[]>();
    for (let offset = 0; offset < seeds.length; offset += seedQueryBatchSize) {
      const seedBatch = seeds.slice(offset, offset + seedQueryBatchSize);
      const query = buildBoundedRecallMemoryLinkRawQueryWithContext(
        direction,
        seedBatch,
        selectionContext,
        scanLimit + 1,
      );
      if (query === undefined) continue;
      const rows = yield* sql.unsafe<RecallMemoryLinkSelectionRow>(query.sql, query.params);
      rawRowCount += rows.length;
      for (const row of rows) {
        const key = memoryLinkSeedKey(row.requested_memory_id, row.requested_ordinal);
        const seedRows = rowsBySeed.get(key) ?? [];
        seedRows.push(row);
        rowsBySeed.set(key, seedRows);
      }
      if (direction === 'outgoing') {
        const witnessedBatch = seedBatch.flatMap(seed => {
          const witnessed = witnessedSourceBySeed.get(memoryLinkSeedKey(seed.memoryId, seed.requestedOrdinal));
          return witnessed === undefined ? [] : [witnessed];
        });
        const witnessedQuery = buildBoundedWitnessedRecallMemoryLinkRawQueryWithContext(
          witnessedBatch,
          selectionContext,
          scanLimit + 1,
        );
        if (witnessedQuery !== undefined) {
          const witnessedRows = yield* sql.unsafe<RecallMemoryLinkSelectionRow>(
            witnessedQuery.sql,
            witnessedQuery.params,
          );
          rawRowCount += witnessedRows.length;
          for (const row of witnessedRows) {
            const key = memoryLinkSeedKey(row.requested_memory_id, row.requested_ordinal);
            const seedRows = rowsBySeed.get(key) ?? [];
            seedRows.push(row);
            rowsBySeed.set(key, seedRows);
          }
        }
      }
    }
    for (const seed of seeds) {
      const seedRows = rowsBySeed.get(memoryLinkSeedKey(seed.memoryId, seed.requestedOrdinal)) ?? [];
      if (seedRows.length > scanLimit) truncatedSeeds.add(seed.requestedOrdinal);
      const boundedRows = seedRows.slice(0, scanLimit);
      const verified: RecallMemoryLinkMatch[] = [];
      let attemptedRowCount = 0;
      while (attemptedRowCount < boundedRows.length && verified.length < perSeedLimit) {
        const batchSize = Math.min(
          RECALL_MEMORY_LINK_CANONICAL_READ_BATCH_SIZE,
          perSeedLimit - verified.length,
          boundedRows.length - attemptedRowCount,
        );
        const batch = boundedRows.slice(attemptedRowCount, attemptedRowCount + batchSize);
        attemptedRowCount += batch.length;
        const unreadPaths = [
          ...new Map(
            batch
              .filter(row => !canonicalMemoryByPath.has(row.source_path))
              .map(row => [row.source_path, row] as const),
          ).values(),
        ];
        canonicalRereadCount += unreadPaths.length;
        const newlyRead = yield* Effect.forEach(
          unreadPaths,
          row =>
            fs.readFileString(row.source_path).pipe(
              Effect.map(content => [row.source_path, parseMemoryDocument(row.source_uri, content)] as const),
              Effect.orElseSucceed(() => [row.source_path, undefined] as const),
            ),
          {concurrency: RECALL_MEMORY_LINK_CANONICAL_READ_CONCURRENCY},
        );
        for (const [sourcePath, memory] of newlyRead) canonicalMemoryByPath.set(sourcePath, memory);
        const batchResults: RecallMemoryLinkCanonicalSelectionResult[] = batch.map(row => {
          const memory = canonicalMemoryByPath.get(row.source_path);
          const witnessedSource = witnessedSourceBySeed.get(
            memoryLinkSeedKey(row.requested_memory_id, row.requested_ordinal),
          );
          const isWitnessedSource =
            direction === 'outgoing' &&
            row.source_memory_id === '' &&
            witnessedSource?.uri === row.source_uri &&
            canonicalWitnessedMemoryLinkSourceMatches(row.source_uri, memory, options);
          if (!isWitnessedSource && !canonicalMemoryLinkSourceMatches(row.source_uri, memory, options)) {
            return {canonicalMismatch: true};
          }
          if (!canonicalMemoryLinkSourceLifecycleMatchesRow(memory, row)) {
            return {canonicalMismatch: true};
          }
          if (!canonicalMemoryLinkSourceLifecycleIsSelected(memory, options)) {
            return {canonicalMismatch: false};
          }
          const link = deriveIndexedRecallMemoryLinks(memory).links.find(candidate =>
            indexedMemoryLinkMatchesRow(candidate, row),
          );
          if (!link) return {canonicalMismatch: true};
          verifiedCanonicalRecordsByUri.set(
            memory.uri,
            isWitnessedSource
              ? {...memory, metadata: {...memory.metadata, memoryId: witnessedSource.memoryId}}
              : memory,
          );
          return {
            canonicalMismatch: false,
            match: {
              direction,
              relationOrdinal: row.relation_ordinal,
              relationOrigin: row.relation_origin,
              relationType: row.relation_type,
              requestedOrdinal: seed.requestedOrdinal,
              sourceMemoryId: isWitnessedSource ? witnessedSource.memoryId : row.source_memory_id,
              sourceUri: row.source_uri,
              ...(row.target_memory_id ? {targetMemoryId: row.target_memory_id} : {}),
            },
          };
        });
        canonicalMismatchCount += batchResults.filter(result => result.canonicalMismatch).length;
        verified.push(...batchResults.flatMap(result => (result.match === undefined ? [] : [result.match])));
      }
      if (seedRows.length > attemptedRowCount) truncatedSeeds.add(seed.requestedOrdinal);
      selected.push(...verified.map((match, laneRank) => ({...match, laneRank})));
    }
  }

  if (canonicalMismatchCount > 0) options.onCanonicalMismatch?.(canonicalMismatchCount);
  if (verifiedCanonicalRecordsByUri.size > 0) {
    options.onCanonicalRecords?.([...verifiedCanonicalRecordsByUri.values()]);
  }
  if (canonicalRereadCount > 0) options.onCanonicalReread?.(canonicalRereadCount);
  if (rawRowCount > 0) options.onRawRows?.(rawRowCount);
  const ranked = selected.sort(
    (left, right) =>
      left.laneRank - right.laneRank ||
      left.requestedOrdinal - right.requestedOrdinal ||
      compareText(left.direction, right.direction) ||
      compareText(left.relationType, right.relationType) ||
      compareText(left.sourceUri, right.sourceUri) ||
      left.relationOrdinal - right.relationOrdinal,
  );
  for (const omitted of ranked.slice(limit)) truncatedSeeds.add(omitted.requestedOrdinal);
  if (truncatedSeeds.size > 0) options.onSearchTruncated?.([...truncatedSeeds].sort((a, b) => a - b));
  return ranked.slice(0, limit).map(({laneRank: _laneRank, ...match}) => match);
});

function canonicalMemoryLinkSourceMatches(
  uri: string,
  memory: ReturnType<typeof parseMemoryDocument>,
  options: RecallMemoryLinkQueryOptions,
): memory is NonNullable<ReturnType<typeof parseMemoryDocument>> {
  return (
    memory !== undefined &&
    isMemoryId(memory.metadata.memoryId ?? '') &&
    recallUriMatchesScopes(uri, options.allowedUriScopes) &&
    (options.eligibility === undefined || recallCandidateIsEligible(options.eligibility, memory.metadata))
  );
}

function canonicalWitnessedMemoryLinkSourceMatches(
  uri: string,
  memory: ReturnType<typeof parseMemoryDocument>,
  options: RecallMemoryLinkQueryOptions,
): memory is NonNullable<ReturnType<typeof parseMemoryDocument>> {
  return (
    memory !== undefined &&
    memory.metadata.memoryId === undefined &&
    (memory.metadata.status ?? 'active') === 'active' &&
    recallUriMatchesScopes(uri, options.allowedUriScopes) &&
    (options.eligibility === undefined || recallCandidateIsEligible(options.eligibility, memory.metadata))
  );
}

function canonicalMemoryLinkSourceLifecycleMatchesRow(
  memory: MemoryRecord,
  row: RecallMemoryLinkSelectionRow,
): boolean {
  return (
    (memory.metadata.status ?? 'active') === row.source_status &&
    (memory.metadata.validFrom ?? '') === row.source_valid_from &&
    (memory.metadata.validTo ?? '') === row.source_valid_to
  );
}

function canonicalMemoryLinkSourceLifecycleIsSelected(
  memory: MemoryRecord,
  options: RecallMemoryLinkQueryOptions,
): boolean {
  return options.sourceCurrentAt !== undefined
    ? canonicalMemoryLinkSourceIsCurrent(memory, options.sourceCurrentAt)
    : options.includeInactive === true || (memory.metadata.status ?? 'active') === 'active';
}

function canonicalMemoryLinkSourceIsCurrent(memory: MemoryRecord, now: Date): boolean {
  if ((memory.metadata.status ?? 'active') !== 'active') return false;
  const nowTime = now.getTime();
  const validFrom = memory.metadata.validFrom === undefined ? undefined : Date.parse(memory.metadata.validFrom);
  const validTo = memory.metadata.validTo === undefined ? undefined : Date.parse(memory.metadata.validTo);
  if (validFrom !== undefined && (!Number.isFinite(validFrom) || nowTime < validFrom)) return false;
  if (validTo !== undefined && (!Number.isFinite(validTo) || nowTime > validTo)) return false;
  return true;
}

function indexedMemoryLinkMatchesRow(link: IndexedRecallMemoryLink, row: RecallMemoryLinkSelectionRow): boolean {
  return (
    link.sourceMemoryId === row.source_memory_id &&
    link.relationType === row.relation_type &&
    link.relationOrigin === row.relation_origin &&
    link.relationOrdinal === row.relation_ordinal &&
    (row.target_locator_digest
      ? link.targetLocatorDigest === row.target_locator_digest
      : link.targetMemoryId === row.target_memory_id)
  );
}

function normalizeMemoryLinkSeeds(seeds: readonly RecallMemoryLinkSeed[]): readonly RecallMemoryLinkSeed[] {
  const selected = new Map<string, RecallMemoryLinkSeed>();
  for (const seed of seeds) {
    if (!isMemoryId(seed.memoryId) || !Number.isSafeInteger(seed.requestedOrdinal) || seed.requestedOrdinal < 0)
      continue;
    const current = selected.get(seed.memoryId);
    if (!current || seed.requestedOrdinal < current.requestedOrdinal) selected.set(seed.memoryId, seed);
  }
  return [...selected.values()].sort(
    (left, right) => left.requestedOrdinal - right.requestedOrdinal || compareText(left.memoryId, right.memoryId),
  );
}

function normalizeWitnessedMemoryLinkSources(
  sources: readonly RecallMemoryLinkWitnessedSource[],
  seeds: readonly RecallMemoryLinkSeed[],
): ReadonlyMap<string, RecallMemoryLinkWitnessedSource> {
  const allowedSeeds = new Set(seeds.map(seed => memoryLinkSeedKey(seed.memoryId, seed.requestedOrdinal)));
  const candidates = new Map<string, Map<string, RecallMemoryLinkWitnessedSource>>();
  for (const source of sources) {
    const key = memoryLinkSeedKey(source.memoryId, source.requestedOrdinal);
    if (!allowedSeeds.has(key)) continue;
    let uri: string;
    try {
      uri = parseResourceId(source.uri).canonicalUri;
    } catch {
      continue;
    }
    if (uri !== source.uri) continue;
    const byUri = candidates.get(key) ?? new Map<string, RecallMemoryLinkWitnessedSource>();
    byUri.set(uri, source);
    candidates.set(key, byUri);
  }
  return new Map(
    [...candidates].flatMap(([key, byUri]) => (byUri.size === 1 ? [[key, [...byUri.values()][0]] as const] : [])),
  );
}

function boundedRecallMemoryLinkResultLimit(limit: number | undefined): number {
  if (limit === undefined) return 8;
  if (!Number.isFinite(limit)) return 0;
  return Math.min(512, Math.max(0, Math.floor(limit)));
}

function boundedRecallMemoryLinkPerSeedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.min(64, Math.max(0, Math.floor(limit)));
}

function normalizeMemoryLinkDirections(
  directions: readonly ('incoming' | 'outgoing')[] | undefined,
): readonly ('outgoing' | 'incoming')[] {
  if (directions === undefined) return ['outgoing', 'incoming'];
  const selected = new Set(directions);
  return (['outgoing', 'incoming'] as const).filter(direction => selected.has(direction));
}

function memoryLinkSelectionContext(
  options: Pick<
    RecallMemoryLinkQueryOptions,
    'allowedUriScopes' | 'eligibility' | 'includeInactive' | 'relationTypes' | 'sourceCurrentAt'
  >,
): RecallMemoryLinkSelectionContext {
  const relationParams = options.relationTypes ?? [];
  return {
    relationParams,
    relationPredicate:
      relationParams.length > 0 ? `AND memory_link.relation_type IN (${relationParams.map(() => '?').join(', ')})` : '',
    scope: combineRecallSqlPredicates(
      recallUriScopePredicate('document', options.allowedUriScopes),
      recallEligibilityPredicate('document', options.eligibility),
    ),
    sourcePredicate:
      options.sourceCurrentAt !== undefined || options.includeInactive === true
        ? '1 = 1'
        : "COALESCE(json_extract(document.candidate_json, '$.status'), 'active') = 'active'",
  };
}

function buildBoundedRecallMemoryLinkRawQueryWithContext(
  direction: 'incoming' | 'outgoing',
  seeds: readonly RecallMemoryLinkSeed[],
  context: RecallMemoryLinkSelectionContext,
  queryLimit: number,
): RecallMemoryLinkRawSelectionQuery | undefined {
  if (!Number.isSafeInteger(queryLimit) || queryLimit < 1 || seeds.length === 0) return undefined;
  // The private cached source URI follows the same canonical ordering as the
  // selector index. Sorting a joined document URI would visit an entire dense
  // neighborhood before LIMIT; the equality join still verifies the cached URI.
  const selectorColumn = direction === 'outgoing' ? 'source_memory_id' : 'target_memory_id';
  const selectorIndex = direction === 'outgoing' ? 'memory_links_source' : 'memory_links_target';
  // SQLite requires the explicit partial-index predicate; equality to a
  // bound non-empty memory ID is not enough for it to prove eligibility.
  const selectorIndexPredicate = direction === 'incoming' ? "AND memory_link.target_memory_id <> ''" : '';
  const selectorQueries = seeds.map(
    () => `SELECT * FROM (
      SELECT
        memory_link.source_memory_id,
        memory_link.target_memory_id,
        memory_link.target_locator_digest,
        memory_link.relation_type,
        memory_link.relation_origin,
        memory_link.relation_ordinal,
        document.uri AS source_uri,
        document.source_path,
        COALESCE(json_extract(document.candidate_json, '$.status'), 'active') AS source_status,
        COALESCE(json_extract(document.candidate_json, '$.validFrom'), '') AS source_valid_from,
        COALESCE(json_extract(document.candidate_json, '$.validTo'), '') AS source_valid_to,
        ? AS requested_ordinal,
        ? AS requested_memory_id
      FROM memory_links AS memory_link INDEXED BY ${selectorIndex}
      INNER JOIN documents AS document ON document.id = memory_link.source_document_id
        AND document.uri = memory_link.source_uri
      WHERE memory_link.${selectorColumn} = ?
        ${selectorIndexPredicate}
        AND ${context.scope.sql}
        ${context.relationPredicate}
        AND ${context.sourcePredicate}
      ORDER BY
        memory_link.relation_type COLLATE BINARY,
        memory_link.source_uri COLLATE BINARY,
        memory_link.relation_origin COLLATE BINARY,
        memory_link.relation_ordinal,
        memory_link.target_memory_id COLLATE BINARY,
        memory_link.target_locator_digest COLLATE BINARY
      LIMIT ?
    )`,
  );
  return {
    params: seeds.flatMap(seed => [
      seed.requestedOrdinal,
      seed.memoryId,
      seed.memoryId,
      ...context.scope.params,
      ...context.relationParams,
      queryLimit,
    ]),
    sql: `SELECT * FROM (${selectorQueries.join(' UNION ALL ')}) AS selected_links
      ORDER BY
        requested_ordinal,
        requested_memory_id COLLATE BINARY,
        relation_type COLLATE BINARY,
        source_uri COLLATE BINARY,
        relation_origin COLLATE BINARY,
        relation_ordinal,
        target_memory_id COLLATE BINARY,
        target_locator_digest COLLATE BINARY`,
  };
}

function buildBoundedWitnessedRecallMemoryLinkRawQueryWithContext(
  sources: readonly RecallMemoryLinkWitnessedSource[],
  context: RecallMemoryLinkSelectionContext,
  queryLimit: number,
): RecallMemoryLinkRawSelectionQuery | undefined {
  if (!Number.isSafeInteger(queryLimit) || queryLimit < 1 || sources.length === 0) return undefined;
  const selectorQueries = sources.map(
    () => `SELECT * FROM (
      SELECT
        memory_link.source_memory_id,
        memory_link.target_memory_id,
        memory_link.target_locator_digest,
        memory_link.relation_type,
        memory_link.relation_origin,
        memory_link.relation_ordinal,
        document.uri AS source_uri,
        document.source_path,
        COALESCE(json_extract(document.candidate_json, '$.status'), 'active') AS source_status,
        COALESCE(json_extract(document.candidate_json, '$.validFrom'), '') AS source_valid_from,
        COALESCE(json_extract(document.candidate_json, '$.validTo'), '') AS source_valid_to,
        ? AS requested_ordinal,
        ? AS requested_memory_id
      FROM documents AS document
      INNER JOIN memory_links AS memory_link ON memory_link.source_document_id = document.id
      WHERE document.uri = ?
        AND memory_link.source_memory_id = ''
        AND ${context.scope.sql}
        ${context.relationPredicate}
        AND ${context.sourcePredicate}
      ORDER BY
        memory_link.relation_type COLLATE BINARY,
        memory_link.relation_origin COLLATE BINARY,
        memory_link.relation_ordinal,
        memory_link.target_memory_id COLLATE BINARY,
        memory_link.target_locator_digest COLLATE BINARY
      LIMIT ?
    )`,
  );
  return {
    params: sources.flatMap(source => [
      source.requestedOrdinal,
      source.memoryId,
      source.uri,
      ...context.scope.params,
      ...context.relationParams,
      queryLimit,
    ]),
    sql: `SELECT * FROM (${selectorQueries.join(' UNION ALL ')}) AS selected_links
      ORDER BY
        requested_ordinal,
        requested_memory_id COLLATE BINARY,
        relation_type COLLATE BINARY,
        source_uri COLLATE BINARY,
        relation_origin COLLATE BINARY,
        relation_ordinal,
        target_memory_id COLLATE BINARY,
        target_locator_digest COLLATE BINARY`,
  };
}

function memoryLinkSeedKey(memoryId: string, requestedOrdinal: number): string {
  return `${requestedOrdinal}\u0000${memoryId}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
