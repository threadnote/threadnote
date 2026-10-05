import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {compareCodeUnits} from '../../ordering.js';
import {
  PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES,
  PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES,
  type PersistedFullReferencePageRow,
  referenceCandidateEncoder,
  type ResolvableActivationReferenceRow,
} from '../build/core.js';
import {type EdgeRow} from '../internal_models.js';
import {chunk} from '../utilities.js';
import {CodeGraphStoreError, isCodeGraphStoreError, type CodeGraphStoreFailure} from '../../types.js';
import {type CodeGraphSqlQueryStatement} from '../visualization_sql.js';

const PERSISTENT_LOOKUP_PAIR_BATCH_ROWS = 256;
const PERSISTENT_LOOKUP_RAW_MATCH_ROWS = 10_000;
const PERSISTENT_TARGET_SYMBOL_BATCH_ROWS = 400;

export type PersistedLookupPair = readonly [lookupKey: string, resolutionDomain: string];

export interface PersistedLookupSummary {
  readonly exportedSymbolCount: number;
  readonly lookupKey: string;
  readonly maximumExportedSymbolId?: string;
  readonly maximumSymbolId?: string;
  readonly minimumExportedSymbolId?: string;
  readonly minimumSymbolId?: string;
  readonly resolutionDomain: string;
  readonly symbolCount: number;
}

export interface PersistedReferenceResolutionInput {
  readonly edgeId: string;
  readonly exportedOnly: boolean;
  readonly lookupTiers: readonly (readonly string[])[];
  readonly relation: string;
  readonly resolutionDomain: string;
  readonly sourceId?: string;
}

export interface PersistedReferenceResolutionSelection {
  readonly edgeId: string;
  readonly symbolId: string;
}

interface DecodedPersistedReference {
  readonly edgeId: string;
  readonly lookupTiers: readonly (readonly string[])[];
}

interface PersistedReferenceMetadataRow extends EdgeRow {
  readonly alias_lookup_keys_json: string;
  readonly exported_only: number;
  readonly resolution_domain: string;
}

interface PersistedLookupMatchRow {
  readonly exported: number;
  readonly lookup_key: string;
  readonly resolution_domain: string;
  readonly symbol_id: string;
}

interface PersistedLookupAggregateRow {
  readonly exported_symbol_count: number;
  readonly lookup_key: string;
  readonly maximum_exported_symbol_id: string | null;
  readonly maximum_symbol_id: string | null;
  readonly minimum_exported_symbol_id: string | null;
  readonly minimum_symbol_id: string | null;
  readonly resolution_domain: string;
  readonly symbol_count: number;
}

interface PersistedTargetSymbolRow {
  readonly exported: number;
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly resolution_domain: unknown;
}

/**
 * Probe a bounded set of exact lookup-key/domain pairs without reconstructing
 * candidate or summary TEMP B-trees. The extra row is an overflow sentinel;
 * callers split overflowing batches and aggregate only a pathological singleton.
 */
export function codeGraphPersistentLookupMatchStatement(
  snapshotId: string,
  pairs: readonly PersistedLookupPair[],
  rowLimit = PERSISTENT_LOOKUP_RAW_MATCH_ROWS,
): CodeGraphSqlQueryStatement {
  const boundedLimit =
    Number.isSafeInteger(rowLimit) && rowLimit > 0 && rowLimit <= PERSISTENT_LOOKUP_RAW_MATCH_ROWS
      ? rowLimit
      : PERSISTENT_LOOKUP_RAW_MATCH_ROWS;
  return {
    parameters: [...pairs.flat(), snapshotId, boundedLimit + 1],
    text: `WITH requested(lookup_key, resolution_domain) AS (
        VALUES ${pairs.map(() => '(?, ?)').join(', ')}
      )
      SELECT requested.lookup_key, requested.resolution_domain,
        lookup.symbol_id, lookup.exported
      FROM requested
      CROSS JOIN snapshot_symbol_lookup AS lookup
        INDEXED BY sqlite_autoindex_snapshot_symbol_lookup_1
      WHERE lookup.snapshot_id = ?
        AND lookup.lookup_key = requested.lookup_key
        AND lookup.resolution_domain = requested.resolution_domain
      LIMIT ?`,
  };
}

/** Resolve every reference from the first matching tier, preserving SQL ambiguity semantics. */
export function resolvePersistedReferenceSelections(
  references: readonly PersistedReferenceResolutionInput[],
  summaries: readonly PersistedLookupSummary[],
): readonly PersistedReferenceResolutionSelection[] {
  const summariesByKey = new Map<string, Map<string, PersistedLookupSummary>>();
  for (const summary of summaries) {
    let byDomain = summariesByKey.get(summary.lookupKey);
    if (byDomain === undefined) {
      byDomain = new Map();
      summariesByKey.set(summary.lookupKey, byDomain);
    }
    byDomain.set(summary.resolutionDomain, summary);
  }
  const resolved: PersistedReferenceResolutionSelection[] = [];
  for (const reference of references) {
    for (const tier of reference.lookupTiers) {
      let ambiguous = false;
      let matched = false;
      const symbolIds = new Set<string>();
      for (const lookupKey of tier) {
        const summary = summariesByKey.get(lookupKey)?.get(reference.resolutionDomain);
        if (summary === undefined) continue;
        const symbolCount = reference.exportedOnly ? summary.exportedSymbolCount : summary.symbolCount;
        const minimumSymbolId = reference.exportedOnly ? summary.minimumExportedSymbolId : summary.minimumSymbolId;
        const maximumSymbolId = reference.exportedOnly ? summary.maximumExportedSymbolId : summary.maximumSymbolId;
        const excludesSource =
          reference.relation === 'overrides' &&
          reference.sourceId !== undefined &&
          (reference.sourceId === minimumSymbolId || reference.sourceId === maximumSymbolId);
        const remainingCount = symbolCount - (excludesSource ? 1 : 0);
        if (remainingCount <= 0) continue;
        let symbolId = minimumSymbolId;
        if (reference.relation === 'overrides' && symbolCount === 2) {
          if (reference.sourceId === minimumSymbolId) symbolId = maximumSymbolId;
          else if (reference.sourceId === maximumSymbolId) symbolId = minimumSymbolId;
        }
        if (symbolId === undefined) continue;
        matched = true;
        if (remainingCount > 1) ambiguous = true;
        symbolIds.add(symbolId);
      }
      if (!matched) continue;
      if (!ambiguous && symbolIds.size === 1) {
        resolved.push({edgeId: reference.edgeId, symbolId: symbolIds.values().next().value!});
      }
      break;
    }
  }
  return resolved;
}

export const resolvePersistedFullReferencePage = Effect.fn('codeGraph.resolvePersistedFullReferencePage')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  page: readonly PersistedFullReferencePageRow[],
  cursor: string,
  batchEnd: string,
  onLookupBatch?: () => Effect.Effect<void, unknown>,
) {
  const decoded = yield* decodePersistedReferencePage(page);
  const metadata = yield* sql.unsafe<PersistedReferenceMetadataRow>(
    `SELECT reference.edge_id AS id, reference.source_id, reference.source_name,
         reference.relation, NULL AS target_id, reference.target_name,
         reference.provenance, reference.confidence, reference.evidence_path,
         reference.evidence_span_json, reference.alias_lookup_keys_json,
         reference.resolution_domain, reference.exported_only
       FROM building_references AS reference
       WHERE reference.snapshot_id = ?
         AND reference.edge_id > ? AND reference.edge_id <= ?
       ORDER BY reference.edge_id`,
    [snapshotId, cursor, batchEnd],
  );
  const metadataByEdge = new Map(metadata.map(row => [row.id, row]));
  const inputs: PersistedReferenceResolutionInput[] = [];
  const pairDomainsByKey = new Map<string, Set<string>>();
  for (const reference of decoded) {
    const row = metadataByEdge.get(reference.edgeId);
    if (row === undefined) continue;
    inputs.push({
      edgeId: reference.edgeId,
      exportedOnly: row.exported_only === 1,
      lookupTiers: reference.lookupTiers,
      relation: row.relation,
      resolutionDomain: row.resolution_domain,
      ...(typeof row.source_id === 'string' ? {sourceId: row.source_id} : {}),
    });
    for (const tier of reference.lookupTiers) {
      for (const lookupKey of tier) {
        let domains = pairDomainsByKey.get(lookupKey);
        if (domains === undefined) {
          domains = new Set();
          pairDomainsByKey.set(lookupKey, domains);
        }
        domains.add(row.resolution_domain);
      }
    }
  }
  const pairs = [...pairDomainsByKey].flatMap(([lookupKey, domains]) =>
    [...domains].map(domain => [lookupKey, domain] as const),
  );
  pairs.sort((left, right) => compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1], right[1]));
  const summaries: PersistedLookupSummary[] = [];
  for (const pairBatch of chunk(pairs, PERSISTENT_LOOKUP_PAIR_BATCH_ROWS)) {
    yield* loadLookupSummaries(sql, snapshotId, pairBatch, summaries, onLookupBatch);
  }
  const selections = resolvePersistedReferenceSelections(inputs, summaries);
  if (selections.length === 0) return [] satisfies readonly ResolvableActivationReferenceRow[];
  const symbolsById = new Map<string, PersistedTargetSymbolRow>();
  const targetIds = [...new Set(selections.map(selection => selection.symbolId))];
  for (const targetBatch of chunk(targetIds, PERSISTENT_TARGET_SYMBOL_BATCH_ROWS)) {
    const symbols = yield* sql.unsafe<PersistedTargetSymbolRow>(
      `SELECT id, name, exported, kind, resolution_domain
         FROM symbols
         WHERE snapshot_id = ? AND id IN (${targetBatch.map(() => '?').join(', ')})`,
      [snapshotId, ...targetBatch],
    );
    for (const symbol of symbols) symbolsById.set(symbol.id, symbol);
  }
  const selectionByEdge = new Map(selections.map(selection => [selection.edgeId, selection.symbolId]));
  const rows: ResolvableActivationReferenceRow[] = [];
  for (const reference of decoded) {
    const row = metadataByEdge.get(reference.edgeId);
    const targetId = selectionByEdge.get(reference.edgeId);
    const symbol = targetId === undefined ? undefined : symbolsById.get(targetId);
    if (row === undefined || symbol === undefined) continue;
    rows.push({
      ...row,
      symbol_exported: symbol.exported,
      symbol_kind: symbol.kind,
      symbol_resolution_domain: symbol.resolution_domain,
      target_symbol_id: symbol.id,
      target_symbol_name: symbol.name,
    });
  }
  return rows;
});

function decodePersistedReferencePage(
  references: readonly PersistedFullReferencePageRow[],
): Effect.Effect<readonly DecodedPersistedReference[], CodeGraphStoreFailure> {
  return Effect.try({
    try: () =>
      references.map(reference => {
        if (
          !Number.isSafeInteger(reference.candidate_count) ||
          reference.candidate_count < 0 ||
          reference.candidate_count > PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES ||
          !Number.isSafeInteger(reference.candidate_payload_bytes) ||
          reference.candidate_payload_bytes < 0 ||
          reference.candidate_payload_bytes > PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES
        ) {
          throw CodeGraphStoreError.of('Stored reference candidate metadata is invalid.');
        }
        if (reference.lookup_tiers_json.length > PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES) {
          throw CodeGraphStoreError.of('Stored reference candidate payload exceeds its byte budget.');
        }
        const actualPayloadBytes = referenceCandidateEncoder.encode(reference.lookup_tiers_json).byteLength;
        if (
          actualPayloadBytes > PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES ||
          actualPayloadBytes !== reference.candidate_payload_bytes
        ) {
          throw CodeGraphStoreError.of('Stored reference candidate metadata does not match its payload.');
        }
        const parsed: unknown = JSON.parse(reference.lookup_tiers_json);
        if (
          !Array.isArray(parsed) ||
          !parsed.every(tier => Array.isArray(tier) && tier.every(lookupKey => typeof lookupKey === 'string'))
        ) {
          throw CodeGraphStoreError.of('Stored reference lookup tiers are invalid.');
        }
        let candidateCount = 0;
        for (const tier of parsed) {
          for (let index = 0; index < tier.length; index += 1) {
            candidateCount += 1;
            if (
              candidateCount > PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES ||
              (index > 0 && compareCodeUnits(tier[index - 1], tier[index]) >= 0)
            ) {
              throw CodeGraphStoreError.of('Stored reference candidate payload is not canonical.');
            }
          }
        }
        if (candidateCount !== reference.candidate_count) {
          throw CodeGraphStoreError.of('Stored reference candidate metadata does not match its payload.');
        }
        return {edgeId: reference.edge_id, lookupTiers: parsed};
      }),
    catch: cause =>
      isCodeGraphStoreError(cause)
        ? cause
        : CodeGraphStoreError.of('Stored reference candidate payload could not be decoded.'),
  });
}

function loadLookupSummaries(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  pairs: readonly PersistedLookupPair[],
  output: PersistedLookupSummary[],
  onLookupBatch?: () => Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const statement = codeGraphPersistentLookupMatchStatement(snapshotId, pairs);
    const matches = yield* sql.unsafe<PersistedLookupMatchRow>(statement.text, statement.parameters);
    yield* onLookupBatch?.() ?? Effect.void;
    yield* Effect.yieldNow;
    if (matches.length <= PERSISTENT_LOOKUP_RAW_MATCH_ROWS) {
      output.push(...summarizeLookupMatches(matches));
      return;
    }
    if (pairs.length > 1) {
      const middle = Math.ceil(pairs.length / 2);
      yield* loadLookupSummaries(sql, snapshotId, pairs.slice(0, middle), output, onLookupBatch);
      yield* loadLookupSummaries(sql, snapshotId, pairs.slice(middle), output, onLookupBatch);
      return;
    }
    const [lookupKey, resolutionDomain] = pairs[0];
    const aggregate = yield* sql.unsafe<PersistedLookupAggregateRow>(
      `SELECT ? AS lookup_key, ? AS resolution_domain,
         COUNT(*) AS symbol_count,
         MIN(symbol_id) AS minimum_symbol_id,
         MAX(symbol_id) AS maximum_symbol_id,
         SUM(CASE WHEN exported = 1 THEN 1 ELSE 0 END) AS exported_symbol_count,
         MIN(CASE WHEN exported = 1 THEN symbol_id END) AS minimum_exported_symbol_id,
         MAX(CASE WHEN exported = 1 THEN symbol_id END) AS maximum_exported_symbol_id
       FROM snapshot_symbol_lookup INDEXED BY sqlite_autoindex_snapshot_symbol_lookup_1
       WHERE snapshot_id = ? AND lookup_key = ? AND resolution_domain = ?`,
      [lookupKey, resolutionDomain, snapshotId, lookupKey, resolutionDomain],
    );
    const summary = aggregate[0];
    if (summary !== undefined && Number(summary.symbol_count) > 0) output.push(summaryFromAggregate(summary));
    yield* onLookupBatch?.() ?? Effect.void;
    yield* Effect.yieldNow;
  });
}

function summarizeLookupMatches(matches: readonly PersistedLookupMatchRow[]): readonly PersistedLookupSummary[] {
  const summariesByKey = new Map<string, Map<string, MutablePersistedLookupSummary>>();
  for (const match of matches) {
    let byDomain = summariesByKey.get(match.lookup_key);
    if (byDomain === undefined) {
      byDomain = new Map();
      summariesByKey.set(match.lookup_key, byDomain);
    }
    let summary = byDomain.get(match.resolution_domain);
    if (summary === undefined) {
      summary = {
        exportedSymbolCount: 0,
        lookupKey: match.lookup_key,
        resolutionDomain: match.resolution_domain,
        symbolCount: 0,
      };
      byDomain.set(match.resolution_domain, summary);
    }
    summary.symbolCount += 1;
    summary.minimumSymbolId = minimumId(summary.minimumSymbolId, match.symbol_id);
    summary.maximumSymbolId = maximumId(summary.maximumSymbolId, match.symbol_id);
    if (match.exported === 1) {
      summary.exportedSymbolCount += 1;
      summary.minimumExportedSymbolId = minimumId(summary.minimumExportedSymbolId, match.symbol_id);
      summary.maximumExportedSymbolId = maximumId(summary.maximumExportedSymbolId, match.symbol_id);
    }
  }
  return [...summariesByKey.values()].flatMap(byDomain => [...byDomain.values()]);
}

interface MutablePersistedLookupSummary {
  exportedSymbolCount: number;
  readonly lookupKey: string;
  maximumExportedSymbolId?: string;
  maximumSymbolId?: string;
  minimumExportedSymbolId?: string;
  minimumSymbolId?: string;
  readonly resolutionDomain: string;
  symbolCount: number;
}

function summaryFromAggregate(row: PersistedLookupAggregateRow): PersistedLookupSummary {
  return {
    exportedSymbolCount: Number(row.exported_symbol_count),
    lookupKey: row.lookup_key,
    ...(row.maximum_exported_symbol_id === null ? {} : {maximumExportedSymbolId: row.maximum_exported_symbol_id}),
    ...(row.maximum_symbol_id === null ? {} : {maximumSymbolId: row.maximum_symbol_id}),
    ...(row.minimum_exported_symbol_id === null ? {} : {minimumExportedSymbolId: row.minimum_exported_symbol_id}),
    ...(row.minimum_symbol_id === null ? {} : {minimumSymbolId: row.minimum_symbol_id}),
    resolutionDomain: row.resolution_domain,
    symbolCount: Number(row.symbol_count),
  };
}

function minimumId(current: string | undefined, candidate: string): string {
  return current === undefined || compareCodeUnits(candidate, current) < 0 ? candidate : current;
}

function maximumId(current: string | undefined, candidate: string): string {
  return current === undefined || compareCodeUnits(candidate, current) > 0 ? candidate : current;
}
