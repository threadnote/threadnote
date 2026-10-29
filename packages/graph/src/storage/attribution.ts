import {Array as EffectArray} from 'effect';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {storedCodeGraphFactRawBytesSql} from '../fact/storage.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../languages/registry.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_STORAGE_SNAPSHOT_ATTRIBUTION_LIMIT = 64;
export const CODE_GRAPH_STORAGE_SEMANTIC_OBJECT_LIMIT = 512;

export type CodeGraphStorageSemanticGroupName =
  | 'analysis'
  | 'facts-cache'
  | 'lifecycle'
  | 'lexical'
  | 'lookup-resolution'
  | 'other'
  | 'structural-graph'
  | 'workspace-inventory';

export interface CodeGraphStorageSemanticGroupAttribution {
  readonly bytes: number;
  readonly name: CodeGraphStorageSemanticGroupName;
  readonly objectCount: number;
  readonly pages: number;
}

export interface CodeGraphSnapshotStorageAttribution {
  readonly active: boolean;
  readonly associatedFactRawBytes: number;
  readonly associatedFactStoredBytes: number;
  readonly classifiers: readonly CodeGraphClassifierStorageAttribution[];
  readonly commit: string;
  readonly completedAt?: string;
  readonly edgeCount: number;
  readonly id: string;
  readonly logicalPayloadBytes: number;
  readonly logicalRows: number;
  readonly state: 'building' | 'failed' | 'ready' | 'retired';
  readonly symbolCount: number;
}

export interface CodeGraphClassifierStorageAttribution {
  readonly classifier: string;
  readonly edgeRows: number;
  readonly factRawBytes: number;
  readonly factStoredBytes: number;
  readonly files: number;
  readonly logicalBytes: number;
  readonly logicalRows: number;
  readonly lookupRows: number;
  readonly sourceBytes: number;
  readonly symbolRows: number;
}

export interface CodeGraphStorageBytesPerSymbolBaseline {
  readonly activeLogicalPayloadBytes: number;
  readonly activeLogicalPayloadBytesPerSymbol?: number;
  readonly activeSnapshotCount: number;
  readonly activeSymbolCount: number;
  readonly attributedBtreeBytes: number;
  readonly attributedBtreeBytesPerSymbol?: number;
  readonly denominator: 'unique-active-snapshot-symbols';
  readonly readyLogicalPayloadBytes: number;
  readonly retiredLogicalPayloadBytes: number;
}

export type CodeGraphStorageSnapshotAttribution =
  | {
      readonly baseline: CodeGraphStorageBytesPerSymbolBaseline;
      readonly snapshots: readonly CodeGraphSnapshotStorageAttribution[];
      readonly snapshotsTruncated: boolean;
      readonly state: 'available';
    }
  | {readonly reason: 'snapshot-attribution-unavailable'; readonly state: 'unavailable'};

export interface CodeGraphStorageSemanticAttribution {
  readonly groups: readonly CodeGraphStorageSemanticGroupAttribution[];
  readonly groupsComplete: boolean;
  readonly snapshots: CodeGraphStorageSnapshotAttribution;
}

interface StorageObjectRow {
  readonly bytes: number;
  readonly name: string;
  readonly pages: number;
}

interface SnapshotMetadataRow {
  readonly active: number;
  readonly commit_id: string;
  readonly completed_at: string | null;
  readonly edge_count: number;
  readonly id: string;
  readonly state: CodeGraphSnapshotStorageAttribution['state'];
  readonly symbol_count: number;
}

interface SnapshotLogicalRow {
  readonly fact_raw_bytes: number;
  readonly group_name: string;
  readonly logical_bytes: number;
  readonly row_count: number;
  readonly snapshot_id: string;
}

interface SnapshotClassifierLogicalRow extends SnapshotLogicalRow {
  readonly language: string;
  readonly source_bytes: number;
}

export function readCodeGraphStorageSemanticAttribution(
  database: Database,
  objects: readonly StorageObjectRow[],
  objectCount: number,
  attributedBtreeBytes: number,
): CodeGraphStorageSemanticAttribution {
  const groups = semanticStorageGroups(objects);
  let snapshots: CodeGraphStorageSnapshotAttribution;
  try {
    snapshots = readSnapshotStorageAttribution(database, attributedBtreeBytes);
  } catch {
    snapshots = {reason: 'snapshot-attribution-unavailable', state: 'unavailable'};
  }
  return {
    groups,
    groupsComplete: objectCount <= CODE_GRAPH_STORAGE_SEMANTIC_OBJECT_LIMIT,
    snapshots,
  };
}

export function codeGraphStorageSemanticGroup(name: string): CodeGraphStorageSemanticGroupName {
  if (
    /^(?:sqlite_autoindex_)?(?:file_blob_authority|file_blobs|materialized_file_shards|snapshot_file_shards)/u.test(
      name,
    )
  ) {
    return 'facts-cache';
  }
  if (/^(?:sqlite_autoindex_)?(?:lexical_|symbol_terms)/u.test(name)) return 'lexical';
  if (
    /^(?:sqlite_autoindex_)?(?:snapshot_symbol_lookup|building_reference|building_references|snapshot_reexport|legacy_building_references)/u.test(
      name,
    )
  ) {
    return 'lookup-resolution';
  }
  if (/^(?:sqlite_autoindex_)?(?:symbols|edges)(?:_|$)/u.test(name)) return 'structural-graph';
  if (/^(?:sqlite_autoindex_)?workspace_/u.test(name)) return 'workspace-inventory';
  if (/^(?:sqlite_autoindex_)?snapshot_(?:analysis|component_edge)/u.test(name)) return 'analysis';
  if (
    /^(?:sqlite_autoindex_)?(?:active_snapshots|building_|removed_|repositories|routine_|schema_initialization_receipt|schema_metadata|snapshot_build|snapshot_extractor|snapshot_files|snapshot_leases|snapshot_reuse|snapshots|sqlite_schema)/u.test(
      name,
    )
  ) {
    return 'lifecycle';
  }
  return 'other';
}

function semanticStorageGroups(
  objects: readonly StorageObjectRow[],
): readonly CodeGraphStorageSemanticGroupAttribution[] {
  const groups = new Map<CodeGraphStorageSemanticGroupName, {bytes: number; objectCount: number; pages: number}>();
  for (const object of objects) {
    const name = codeGraphStorageSemanticGroup(object.name);
    const current = groups.get(name) ?? {bytes: 0, objectCount: 0, pages: 0};
    current.bytes += object.bytes;
    current.objectCount += 1;
    current.pages += object.pages;
    groups.set(name, current);
  }
  return EffectArray.map([...groups], ([name, value]) => ({name, ...value})).sort(
    (left, right) => right.bytes - left.bytes || Effect.pipe(left.name, EffectString.localeCompare(right.name)),
  );
}

function readSnapshotStorageAttribution(
  database: Database,
  attributedBtreeBytes: number,
): CodeGraphStorageSnapshotAttribution {
  const metadata = database
    .query<SnapshotMetadataRow, SQLQueryBindings[]>(
      `SELECT snapshot.id, snapshot.commit_id, snapshot.state, snapshot.symbol_count,
              snapshot.edge_count, snapshot.completed_at,
              EXISTS (
                SELECT 1 FROM active_snapshots AS active
                WHERE active.snapshot_id = snapshot.id
                  AND NOT EXISTS (
                    SELECT 1 FROM removed_views AS removed
                    WHERE removed.worktree_id = active.worktree_id
                      AND removed.expected_snapshot_id = active.snapshot_id
                  )
              ) AS active
         FROM snapshots AS snapshot
        ORDER BY active DESC,
                 CASE snapshot.state WHEN 'ready' THEN 0 WHEN 'building' THEN 1
                   WHEN 'failed' THEN 2 ELSE 3 END,
                 snapshot.completed_at DESC, snapshot.id DESC
        LIMIT ?`,
    )
    .all(CODE_GRAPH_STORAGE_SNAPSHOT_ATTRIBUTION_LIMIT + 1);
  const snapshotsTruncated = metadata.length > CODE_GRAPH_STORAGE_SNAPSHOT_ATTRIBUTION_LIMIT;
  const selected = metadata.slice(0, CODE_GRAPH_STORAGE_SNAPSHOT_ATTRIBUTION_LIMIT);
  if (selected.length === 0) {
    return {
      baseline: {
        activeLogicalPayloadBytes: 0,
        activeSnapshotCount: 0,
        activeSymbolCount: 0,
        attributedBtreeBytes,
        denominator: 'unique-active-snapshot-symbols',
        readyLogicalPayloadBytes: 0,
        retiredLogicalPayloadBytes: 0,
      },
      snapshots: [],
      snapshotsTruncated,
      state: 'available',
    };
  }
  validateSnapshotMetadata(selected);
  const ids = EffectArray.map(selected, row => row.id);
  const values = EffectArray.join(
    EffectArray.map(ids, () => '(?)'),
    ', ',
  );
  const logicalRows = database
    .query<SnapshotLogicalRow, SQLQueryBindings[]>(
      `WITH selected(snapshot_id) AS (VALUES ${values})
       SELECT file.snapshot_id, 'workspace-inventory' AS group_name, COUNT(*) AS row_count,
              COALESCE(SUM(length(CAST(file.path AS BLOB)) + length(CAST(file.content_hash AS BLOB)) +
                length(CAST(COALESCE(file.raw_content_hash, '') AS BLOB)) +
                length(CAST(file.language AS BLOB)) + length(CAST(file.mode AS BLOB)) +
                length(CAST(file.source AS BLOB)) + 8), 0) AS logical_bytes,
              0 AS fact_raw_bytes
         FROM snapshot_files AS file JOIN selected ON selected.snapshot_id = file.snapshot_id
        GROUP BY file.snapshot_id
       UNION ALL
       SELECT symbol.snapshot_id, 'structural-graph', COUNT(*),
              COALESCE(SUM(length(CAST(symbol.id AS BLOB)) + length(CAST(symbol.content_hash AS BLOB)) +
                length(CAST(symbol.kind AS BLOB)) + length(CAST(symbol.name AS BLOB)) +
                length(CAST(symbol.qualified_name AS BLOB)) + length(CAST(symbol.path AS BLOB)) +
                length(CAST(symbol.language AS BLOB)) + length(CAST(symbol.lookup_keys_json AS BLOB)) +
                length(CAST(COALESCE(symbol.resolution_domain, '') AS BLOB)) +
                length(CAST(COALESCE(symbol.resolution_scope_id, '') AS BLOB)) +
                length(CAST(COALESCE(symbol.package_name, '') AS BLOB)) +
                length(CAST(COALESCE(symbol.signature, '') AS BLOB)) +
                length(CAST(COALESCE(symbol.documentation, '') AS BLOB)) +
                length(CAST(symbol.span_json AS BLOB)) + 8 + CASE WHEN symbol.arity IS NULL THEN 0 ELSE 8 END), 0), 0
         FROM symbols AS symbol JOIN selected ON selected.snapshot_id = symbol.snapshot_id
        GROUP BY symbol.snapshot_id
       UNION ALL
       SELECT edge.snapshot_id, 'structural-graph', COUNT(*),
              COALESCE(SUM(length(CAST(edge.id AS BLOB)) + length(CAST(COALESCE(edge.source_id, '') AS BLOB)) +
                length(CAST(edge.source_name AS BLOB)) + length(CAST(edge.relation AS BLOB)) +
                length(CAST(COALESCE(edge.target_id, '') AS BLOB)) + length(CAST(edge.target_name AS BLOB)) +
                length(CAST(edge.provenance AS BLOB)) + length(CAST(edge.evidence_path AS BLOB)) +
                length(CAST(edge.evidence_span_json AS BLOB)) + 8), 0), 0
         FROM edges AS edge JOIN selected ON selected.snapshot_id = edge.snapshot_id
        GROUP BY edge.snapshot_id
       UNION ALL
       SELECT lookup.snapshot_id, 'lookup-resolution', COUNT(*),
              COALESCE(SUM(length(CAST(lookup.lookup_key AS BLOB)) + length(CAST(lookup.symbol_id AS BLOB)) +
                length(CAST(lookup.resolution_domain AS BLOB)) + length(CAST(lookup.provenance AS BLOB)) +
                length(CAST(COALESCE(lookup.evidence_edge_id, '') AS BLOB)) +
                length(CAST(COALESCE(lookup.evidence_path, '') AS BLOB)) + 8), 0), 0
         FROM snapshot_symbol_lookup AS lookup JOIN selected ON selected.snapshot_id = lookup.snapshot_id
        GROUP BY lookup.snapshot_id
       UNION ALL
       SELECT lexical.snapshot_id, 'lexical',
              (SELECT COUNT(*) FROM lexical_compact_terms AS term WHERE term.snapshot_key = lexical.snapshot_key) +
              (SELECT COUNT(*) FROM lexical_compact_symbols AS symbol WHERE symbol.snapshot_key = lexical.snapshot_key) +
              (SELECT COUNT(*) FROM lexical_compact_postings AS posting WHERE posting.snapshot_key = lexical.snapshot_key),
              COALESCE((SELECT SUM(length(CAST(term.term AS BLOB)) + 16)
                FROM lexical_compact_terms AS term WHERE term.snapshot_key = lexical.snapshot_key), 0) +
              COALESCE((SELECT SUM(length(CAST(symbol.symbol_id AS BLOB)) + 16)
                FROM lexical_compact_symbols AS symbol WHERE symbol.snapshot_key = lexical.snapshot_key), 0) +
              COALESCE((SELECT COUNT(*) * 32 FROM lexical_compact_postings AS posting
                WHERE posting.snapshot_key = lexical.snapshot_key), 0), 0
         FROM lexical_compact_snapshots AS lexical JOIN selected ON selected.snapshot_id = lexical.snapshot_id
       UNION ALL
       SELECT association.snapshot_id, 'facts-cache', COUNT(*),
              COALESCE(SUM(length(CAST(shard.facts_json AS BLOB))), 0),
              COALESCE(SUM(${storedCodeGraphFactRawBytesSql('shard.facts_json')}), 0)
         FROM snapshot_file_shards AS association
         JOIN selected ON selected.snapshot_id = association.snapshot_id
         JOIN materialized_file_shards AS shard ON shard.id = association.shard_id
        GROUP BY association.snapshot_id
       UNION ALL
       SELECT component.snapshot_id, 'workspace-inventory', COUNT(*),
              COALESCE(SUM(length(CAST(component.id AS BLOB)) + length(CAST(component.workspace_id AS BLOB)) +
                length(CAST(component.build_system AS BLOB)) + length(CAST(component.kind AS BLOB)) +
                length(CAST(component.name AS BLOB)) + length(CAST(component.root AS BLOB)) +
                length(CAST(component.resolution_domain AS BLOB)) + length(CAST(component.languages_json AS BLOB)) +
                length(CAST(component.source_roots_json AS BLOB)) +
                length(CAST(component.workspace_roots_json AS BLOB)) + length(CAST(component.provenance AS BLOB)) +
                length(CAST(component.diagnostics_json AS BLOB))), 0), 0
         FROM workspace_components AS component JOIN selected ON selected.snapshot_id = component.snapshot_id
        GROUP BY component.snapshot_id
       UNION ALL
       SELECT dependency.snapshot_id, 'workspace-inventory', COUNT(*),
              COALESCE(SUM(length(CAST(dependency.source_component_id AS BLOB)) +
                length(CAST(dependency.target_component_id AS BLOB)) + length(CAST(dependency.provenance AS BLOB)) +
                length(CAST(COALESCE(dependency.evidence, '') AS BLOB))), 0), 0
         FROM workspace_component_dependencies AS dependency
         JOIN selected ON selected.snapshot_id = dependency.snapshot_id
        GROUP BY dependency.snapshot_id
       UNION ALL
       SELECT scope.snapshot_id, 'workspace-inventory', COUNT(*),
              COALESCE(SUM(length(CAST(scope.id AS BLOB)) + length(CAST(scope.build_system AS BLOB)) +
                length(CAST(scope.name AS BLOB)) + length(CAST(scope.root AS BLOB)) +
                length(CAST(scope.provenance AS BLOB)) + length(CAST(scope.diagnostics_json AS BLOB))), 0), 0
         FROM workspace_scopes AS scope JOIN selected ON selected.snapshot_id = scope.snapshot_id
        GROUP BY scope.snapshot_id`,
    )
    .all(...ids);
  const classifierRows = readSnapshotClassifierStorageAttribution(database, ids, values);
  const aggregates = new Map<
    string,
    {factRawBytes: number; factStoredBytes: number; logicalBytes: number; rows: number}
  >();
  for (const row of logicalRows) {
    const current = aggregates.get(row.snapshot_id) ?? {factRawBytes: 0, factStoredBytes: 0, logicalBytes: 0, rows: 0};
    current.logicalBytes += safeAggregate(row.logical_bytes);
    current.rows += safeAggregate(row.row_count);
    if (row.group_name === 'facts-cache') {
      current.factRawBytes += safeAggregate(row.fact_raw_bytes);
      current.factStoredBytes += safeAggregate(row.logical_bytes);
    }
    aggregates.set(row.snapshot_id, current);
  }
  const snapshots = EffectArray.map(selected, row => {
    const aggregate = aggregates.get(row.id) ?? {factRawBytes: 0, factStoredBytes: 0, logicalBytes: 0, rows: 0};
    return {
      active: row.active === 1,
      associatedFactRawBytes: aggregate.factRawBytes,
      associatedFactStoredBytes: aggregate.factStoredBytes,
      classifiers: classifierRows.get(row.id) ?? [],
      commit: row.commit_id,
      ...(row.completed_at === null ? {} : {completedAt: row.completed_at}),
      edgeCount: row.edge_count,
      id: row.id,
      logicalPayloadBytes: aggregate.logicalBytes,
      logicalRows: aggregate.rows,
      state: row.state,
      symbolCount: row.symbol_count,
    } satisfies CodeGraphSnapshotStorageAttribution;
  });
  const active = EffectArray.filter(
    snapshots,
    (snapshot, __effectArrayIndex) => __effectArrayIndex in snapshots && snapshot.active,
  );
  const activeSymbolCount = EffectArray.reduce(active, 0, (total, snapshot) => total + snapshot.symbolCount);
  const activeLogicalPayloadBytes = EffectArray.reduce(
    active,
    0,
    (total, snapshot) => total + snapshot.logicalPayloadBytes,
  );
  const readyLogicalPayloadBytes = EffectArray.reduce(
    EffectArray.filter(snapshots, snapshot => snapshot.state === 'ready'),
    0,
    (total, snapshot) => total + snapshot.logicalPayloadBytes,
  );
  const retiredLogicalPayloadBytes = EffectArray.reduce(
    EffectArray.filter(snapshots, snapshot => snapshot.state === 'retired' || snapshot.state === 'failed'),
    0,
    (total, snapshot) => total + snapshot.logicalPayloadBytes,
  );
  return {
    baseline: {
      activeLogicalPayloadBytes,
      readyLogicalPayloadBytes,
      retiredLogicalPayloadBytes,
      ...(activeSymbolCount > 0
        ? {
            activeLogicalPayloadBytesPerSymbol: Math.round(activeLogicalPayloadBytes / activeSymbolCount),
            attributedBtreeBytesPerSymbol: Math.round(attributedBtreeBytes / activeSymbolCount),
          }
        : {}),
      activeSnapshotCount: active.length,
      activeSymbolCount,
      attributedBtreeBytes,
      denominator: 'unique-active-snapshot-symbols',
    },
    snapshots,
    snapshotsTruncated,
    state: 'available',
  };
}

function readSnapshotClassifierStorageAttribution(
  database: Database,
  snapshotIds: readonly string[],
  selectedValues: string,
): ReadonlyMap<string, readonly CodeGraphClassifierStorageAttribution[]> {
  const rows = database
    .query<SnapshotClassifierLogicalRow, SQLQueryBindings[]>(
      `WITH selected(snapshot_id) AS (VALUES ${selectedValues})
       SELECT file.snapshot_id, file.language, 'source' AS group_name, COUNT(*) AS row_count,
              COALESCE(SUM(file.size), 0) AS source_bytes,
              COALESCE(SUM(length(CAST(file.path AS BLOB)) + length(CAST(file.content_hash AS BLOB)) +
                length(CAST(COALESCE(file.raw_content_hash, '') AS BLOB)) +
                length(CAST(file.language AS BLOB)) + length(CAST(file.mode AS BLOB)) +
                length(CAST(file.source AS BLOB)) + 8), 0) AS logical_bytes,
              0 AS fact_raw_bytes
         FROM snapshot_files AS file JOIN selected ON selected.snapshot_id = file.snapshot_id
        GROUP BY file.snapshot_id, file.language
       UNION ALL
       SELECT association.snapshot_id, file.language, 'facts-cache', COUNT(*), 0,
              COALESCE(SUM(length(CAST(shard.facts_json AS BLOB))), 0),
              COALESCE(SUM(${storedCodeGraphFactRawBytesSql('shard.facts_json')}), 0)
         FROM snapshot_file_shards AS association
         JOIN selected ON selected.snapshot_id = association.snapshot_id
         JOIN snapshot_files AS file
           ON file.snapshot_id = association.snapshot_id AND file.path = association.path
         JOIN materialized_file_shards AS shard ON shard.id = association.shard_id
        GROUP BY association.snapshot_id, file.language
       UNION ALL
       SELECT symbol.snapshot_id, file.language, 'symbols', COUNT(*), 0,
              COALESCE(SUM(length(CAST(symbol.id AS BLOB)) + length(CAST(symbol.content_hash AS BLOB)) +
                length(CAST(symbol.kind AS BLOB)) + length(CAST(symbol.name AS BLOB)) +
                length(CAST(symbol.qualified_name AS BLOB)) + length(CAST(symbol.path AS BLOB)) +
                length(CAST(symbol.language AS BLOB)) + length(CAST(symbol.lookup_keys_json AS BLOB)) +
                length(CAST(COALESCE(symbol.resolution_domain, '') AS BLOB)) +
                length(CAST(COALESCE(symbol.resolution_scope_id, '') AS BLOB)) +
                length(CAST(COALESCE(symbol.package_name, '') AS BLOB)) +
                length(CAST(COALESCE(symbol.signature, '') AS BLOB)) +
                length(CAST(COALESCE(symbol.documentation, '') AS BLOB)) +
                length(CAST(symbol.span_json AS BLOB)) + 8 + CASE WHEN symbol.arity IS NULL THEN 0 ELSE 8 END), 0), 0
         FROM symbols AS symbol JOIN selected ON selected.snapshot_id = symbol.snapshot_id
         JOIN snapshot_files AS file ON file.snapshot_id = symbol.snapshot_id AND file.path = symbol.path
        GROUP BY symbol.snapshot_id, file.language
       UNION ALL
       SELECT edge.snapshot_id, file.language, 'edges', COUNT(*), 0,
              COALESCE(SUM(length(CAST(edge.id AS BLOB)) + length(CAST(COALESCE(edge.source_id, '') AS BLOB)) +
                length(CAST(edge.source_name AS BLOB)) + length(CAST(edge.relation AS BLOB)) +
                length(CAST(COALESCE(edge.target_id, '') AS BLOB)) + length(CAST(edge.target_name AS BLOB)) +
                length(CAST(edge.provenance AS BLOB)) + length(CAST(edge.evidence_path AS BLOB)) +
                length(CAST(edge.evidence_span_json AS BLOB)) + 8), 0), 0
         FROM edges AS edge JOIN selected ON selected.snapshot_id = edge.snapshot_id
         JOIN snapshot_files AS file ON file.snapshot_id = edge.snapshot_id AND file.path = edge.evidence_path
        GROUP BY edge.snapshot_id, file.language
       UNION ALL
       SELECT lookup.snapshot_id, file.language, 'lookup', COUNT(*), 0,
              COALESCE(SUM(length(CAST(lookup.lookup_key AS BLOB)) + length(CAST(lookup.symbol_id AS BLOB)) +
                length(CAST(lookup.resolution_domain AS BLOB)) + length(CAST(lookup.provenance AS BLOB)) +
                length(CAST(COALESCE(lookup.evidence_edge_id, '') AS BLOB)) +
                length(CAST(COALESCE(lookup.evidence_path, '') AS BLOB)) + 8), 0), 0
         FROM snapshot_symbol_lookup AS lookup JOIN selected ON selected.snapshot_id = lookup.snapshot_id
         JOIN symbols AS symbol ON symbol.snapshot_id = lookup.snapshot_id AND symbol.id = lookup.symbol_id
         JOIN snapshot_files AS file ON file.snapshot_id = symbol.snapshot_id AND file.path = symbol.path
        GROUP BY lookup.snapshot_id, file.language`,
    )
    .all(...snapshotIds);
  const aggregates = new Map<string, Map<string, CodeGraphClassifierStorageAttribution>>();
  for (const row of rows) {
    if (typeof row.language !== 'string' || typeof row.group_name !== 'string') {
      throw new Error('Code graph classifier storage attribution is invalid.');
    }
    const classifier = codeGraphStorageClassifierForLanguage(row.language);
    const byClassifier = aggregates.get(row.snapshot_id) ?? new Map<string, CodeGraphClassifierStorageAttribution>();
    if (!aggregates.has(row.snapshot_id)) aggregates.set(row.snapshot_id, byClassifier);
    const current = byClassifier.get(classifier) ?? {
      classifier,
      edgeRows: 0,
      factRawBytes: 0,
      factStoredBytes: 0,
      files: 0,
      logicalBytes: 0,
      logicalRows: 0,
      lookupRows: 0,
      sourceBytes: 0,
      symbolRows: 0,
    };
    const rowCount = safeAggregate(row.row_count);
    const logicalBytes = safeAggregate(row.logical_bytes);
    const next = {
      ...current,
      edgeRows: current.edgeRows + (row.group_name === 'edges' ? rowCount : 0),
      factRawBytes: current.factRawBytes + (row.group_name === 'facts-cache' ? safeAggregate(row.fact_raw_bytes) : 0),
      factStoredBytes: current.factStoredBytes + (row.group_name === 'facts-cache' ? logicalBytes : 0),
      files: current.files + (row.group_name === 'source' ? rowCount : 0),
      logicalBytes: current.logicalBytes + logicalBytes,
      logicalRows: current.logicalRows + rowCount,
      lookupRows: current.lookupRows + (row.group_name === 'lookup' ? rowCount : 0),
      sourceBytes: current.sourceBytes + (row.group_name === 'source' ? safeAggregate(row.source_bytes) : 0),
      symbolRows: current.symbolRows + (row.group_name === 'symbols' ? rowCount : 0),
    } satisfies CodeGraphClassifierStorageAttribution;
    byClassifier.set(classifier, next);
  }
  return new Map(
    EffectArray.map([...aggregates], ([snapshotId, values]) => [
      snapshotId,
      [...values.values()].sort(
        (left, right) =>
          right.logicalBytes - left.logicalBytes ||
          Effect.pipe(left.classifier, EffectString.localeCompare(right.classifier)),
      ),
    ]),
  );
}

export function codeGraphStorageClassifierForLanguage(language: string): string {
  for (const pack of BUILTIN_LANGUAGE_PACK_REGISTRY.packs) {
    if (EffectArray.some(pack.files, matcher => matcher.language === language)) return pack.id;
  }
  return 'unmatched';
}

function validateSnapshotMetadata(rows: readonly SnapshotMetadataRow[]): void {
  for (const row of rows) {
    if (
      typeof row.id !== 'string' ||
      typeof row.commit_id !== 'string' ||
      !['building', 'failed', 'ready', 'retired'].includes(row.state) ||
      (row.completed_at !== null && typeof row.completed_at !== 'string') ||
      !Number.isSafeInteger(row.symbol_count) ||
      row.symbol_count < 0 ||
      !Number.isSafeInteger(row.edge_count) ||
      row.edge_count < 0 ||
      (row.active !== 0 && row.active !== 1)
    ) {
      throw new Error('Code graph snapshot storage metadata is invalid.');
    }
  }
}

function safeAggregate(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Code graph storage aggregate is invalid.');
  return value;
}
