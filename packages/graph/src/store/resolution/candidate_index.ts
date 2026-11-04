import {Array as EffectArray, Effect} from 'effect';
import * as EffectString from 'effect/String';
import * as SqlClient from 'effect/sql/SqlClient';
import type {ProjectResolutionLookupKey} from '../../incremental/closure.js';
import type {CodeGraphInventoryFile, CodeGraphReference} from '../../types.js';
import {CodeGraphStoreError} from '../../types.js';
import {normalizeSchemaDefinition} from '../schema/normalization.js';
import {lookupDomain} from '../utilities.js';
import {CANDIDATE_PAGE_OBJECTS, CANDIDATE_PAGE_INDEXES, CANDIDATE_PAGE_TABLES} from './candidate_page_schema.js';
import {isCodeGraphReferenceWithinCandidateBudget} from '../../fact/budget.js';
import {candidateTextRepresentable} from './candidate_pages.js';

export const RESOLUTION_CANDIDATE_INDEX_VERSION = 1;
export const RESOLUTION_CANDIDATE_INDEX_PAGE_ROWS = 1_000;
export const RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES = 8 * 1_048_576;

export interface ResolutionCandidateIndexIdentity {
  readonly snapshotId: string;
  readonly workspaceFingerprint: string;
  readonly fileSetFingerprint: string;
}

export interface ResolutionCandidateIndexStage {
  /** In-process builder ownership; released before waiting for durable writer transactions. */
  readonly preparationGate?: import('../models.js').CodeGraphPreparationGate;
  readonly snapshotId: string;
  readonly files: readonly Pick<CodeGraphInventoryFile, 'path' | 'contentHash'>[];
  readonly references: readonly CodeGraphReference[];
}

export interface ResolutionCandidateIndexFinish extends ResolutionCandidateIndexIdentity {
  /** A prior one-level delta whose unchanged paths are carried by ordinary fold-forward. */
  readonly inheritedSnapshotId?: string;
}

export interface ResolutionCandidateIndexQuery extends ResolutionCandidateIndexIdentity {
  readonly initialLookupKeys: readonly ProjectResolutionLookupKey[];
  readonly additionalReexports: readonly import('./candidate_closure.js').ProjectResolutionReexportKeys[];
  readonly maximumSelectedFiles: number;
}

export interface ResolutionCandidateIndexWork {
  readonly keysQueried: number;
  readonly associationsRead: number;
  readonly reexportsRead: number;
  readonly bytesRead: number;
}

/** Optional derived evidence; installing it never retires readable old graph snapshots. */
export const RESOLUTION_CANDIDATE_INDEX_TABLES = [
  {
    name: 'snapshot_candidate_files',
    keyColumns: ['snapshot_id', 'path'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_files (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      association_count INTEGER NOT NULL CHECK (association_count >= 0),
      reexport_count INTEGER NOT NULL CHECK (reexport_count >= 0),
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID`,
  },
  {
    name: 'snapshot_candidate_lookup',
    keyColumns: ['snapshot_id', 'resolution_domain', 'lookup_key', 'evidence_path'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_lookup (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      resolution_domain TEXT NOT NULL,
      lookup_key TEXT NOT NULL,
      evidence_path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, resolution_domain, lookup_key, evidence_path)
    ) WITHOUT ROWID`,
  },
  {
    name: 'snapshot_candidate_reexports',
    keyColumns: ['snapshot_id', 'evidence_path', 'edge_id'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_reexports (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      evidence_path TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (length(CAST(payload_json AS BLOB)) <= 8388608),
      PRIMARY KEY (snapshot_id, evidence_path, edge_id)
    ) WITHOUT ROWID`,
  },
  {
    name: 'snapshot_candidate_receipts',
    keyColumns: ['snapshot_id'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id),
      version INTEGER NOT NULL CHECK (version = 1),
      root_snapshot_id TEXT,
      extractor_set TEXT NOT NULL,
      graph_content_id TEXT NOT NULL,
      workspace_fingerprint TEXT NOT NULL,
      file_set_fingerprint TEXT NOT NULL,
      file_count INTEGER NOT NULL CHECK (file_count >= 0)
    ) WITHOUT ROWID`,
  },
  {
    name: 'snapshot_candidate_generations',
    keyColumns: ['snapshot_id', 'kind', 'path'],
    sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_generations (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      kind TEXT NOT NULL CHECK (kind IN ('file', 'receipt')),
      path TEXT NOT NULL,
      authority_token TEXT NOT NULL,
      CHECK ((kind = 'receipt' AND path = '') OR (kind = 'file' AND path <> '')),
      PRIMARY KEY (snapshot_id, kind, path)
    ) WITHOUT ROWID`,
  },
] as const;

const candidateAuthority = {
  name: 'snapshot_candidate_authority',
  sql: `CREATE TABLE IF NOT EXISTS snapshot_candidate_authority (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    token TEXT NOT NULL CHECK (length(CAST(token AS BLOB)) = 64 AND token NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK (state IN ('ready', 'blocked'))
  ) WITHOUT ROWID`,
};

/** A missing authority gets a fresh opaque token, never a default that could revive old proof. */
export const resolutionCandidateAuthorityToken = Effect.fn('codeGraph.candidateAuthorityToken')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<{
    readonly token: string;
  }>`SELECT token FROM snapshot_candidate_authority WHERE singleton = 1 AND state = 'ready'
    AND typeof(token) = 'text' AND length(CAST(token AS BLOB)) = 64 AND token NOT GLOB '*[^0-9a-f]*' LIMIT 1`;
  return rows[0]?.token;
});

const preGenerationSnapshotTriggerSql = `CREATE TRIGGER IF NOT EXISTS snapshots_candidate_invalidate_update AFTER UPDATE ON snapshots
      WHEN NEW.state NOT IN ('ready', 'retired') OR OLD.extractor_set IS NOT NEW.extractor_set
        OR OLD.graph_content_id IS NOT NEW.graph_content_id OR OLD.base_snapshot_id IS NOT NEW.base_snapshot_id
        OR OLD.file_count IS NOT NEW.file_count OR OLD.symbol_count IS NOT NEW.symbol_count OR OLD.edge_count IS NOT NEW.edge_count
      BEGIN DELETE FROM snapshot_candidate_receipts WHERE snapshot_id = OLD.id; END`;

const indexObjects = [
  {
    name: 'snapshot_candidate_lookup_path',
    sql: `CREATE INDEX IF NOT EXISTS snapshot_candidate_lookup_path
      ON snapshot_candidate_lookup(snapshot_id, evidence_path, resolution_domain, lookup_key)`,
  },
  ...EffectArray.flatMap(
    [
      ...EffectArray.take(RESOLUTION_CANDIDATE_INDEX_TABLES, 3),
      {name: 'snapshot_files'},
      {name: 'snapshot_file_deletions'},
      {name: 'snapshot_symbol_lookup'},
      {name: 'snapshot_candidate_generations'},
    ],
    table =>
      EffectArray.map(['INSERT', 'UPDATE', 'DELETE'] as const, operation => ({
        name: `${table.name}_candidate_invalidate_${EffectString.toLowerCase(operation)}`,
        sql: `CREATE TRIGGER IF NOT EXISTS ${table.name}_candidate_invalidate_${EffectString.toLowerCase(operation)}
        AFTER ${operation} ON ${table.name}
        BEGIN DELETE FROM snapshot_candidate_receipts
          WHERE snapshot_id IN (${operation === 'DELETE' ? 'OLD.snapshot_id' : 'NEW.snapshot_id'}${operation === 'UPDATE' ? ', OLD.snapshot_id' : ''});
          ${
            table.name === 'snapshot_candidate_lookup' || table.name === 'snapshot_candidate_reexports'
              ? `UPDATE snapshot_candidate_files SET complete = 0 WHERE complete = 1 AND
              (snapshot_id, path) IN ((${operation === 'DELETE' ? 'OLD' : 'NEW'}.snapshot_id, ${operation === 'DELETE' ? 'OLD' : 'NEW'}.evidence_path)${operation === 'UPDATE' ? ', (OLD.snapshot_id, OLD.evidence_path)' : ''});`
              : ''
          }
        END`,
      })),
  ),
  {
    name: 'snapshots_candidate_invalidate_update',
    sql: `CREATE TRIGGER IF NOT EXISTS snapshots_candidate_invalidate_update AFTER UPDATE ON snapshots
      WHEN NEW.state NOT IN ('ready', 'retired') OR OLD.extractor_set IS NOT NEW.extractor_set
        OR OLD.graph_content_id IS NOT NEW.graph_content_id OR OLD.base_snapshot_id IS NOT NEW.base_snapshot_id
        OR OLD.file_count IS NOT NEW.file_count OR OLD.symbol_count IS NOT NEW.symbol_count OR OLD.edge_count IS NOT NEW.edge_count
      BEGIN DELETE FROM snapshot_candidate_receipts WHERE snapshot_id = OLD.id;
        DELETE FROM snapshot_candidate_generations WHERE snapshot_id = OLD.id AND kind = 'receipt'; END`,
  },
];

const objects = [candidateAuthority, ...RESOLUTION_CANDIDATE_INDEX_TABLES, ...indexObjects, ...CANDIDATE_PAGE_OBJECTS];
export const RESOLUTION_CANDIDATE_SNAPSHOT_TRIGGER = indexObjects[indexObjects.length - 1];
const snapshotFileTriggers = EffectArray.filter(
  indexObjects,
  object =>
    object.name === 'snapshot_files_candidate_invalidate_insert' ||
    object.name === 'snapshot_files_candidate_invalidate_update' ||
    object.name === 'snapshot_files_candidate_invalidate_delete',
);

/** Only the three exact optional invalidation definitions may coexist with file-citation authority. */
export const resolutionCandidateSnapshotFileTriggersCompatible = Effect.fn('codeGraph.candidateFileTriggersCompatible')(
  function* (sql: SqlClient.SqlClient) {
    const names = EffectArray.map(snapshotFileTriggers, trigger => trigger.name);
    const slots = EffectArray.join(
      EffectArray.map(names, () => '?'),
      ',',
    );
    const rows = yield* sql.unsafe<{readonly name: string; readonly tbl_name: string; readonly sql: string | null}>(
      `SELECT name, tbl_name, CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql ELSE NULL END AS sql
     FROM sqlite_master WHERE type = 'trigger' AND name IN (${slots}) LIMIT 3`,
      names,
    );
    if (
      EffectArray.some(rows, row => {
        const contract = EffectArray.findFirst(snapshotFileTriggers, trigger => trigger.name === row.name);
        return (
          row.tbl_name !== 'snapshot_files' ||
          typeof row.sql !== 'string' ||
          contract._tag === 'None' ||
          normalizeSchemaDefinition(row.sql) !== normalizeSchemaDefinition(contract.value.sql)
        );
      })
    )
      return false;
    const unknown = yield* sql.unsafe(
      `SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'snapshot_files' COLLATE NOCASE
    AND name NOT IN (${slots}) LIMIT 1`,
      names,
    );
    return unknown.length === 0;
  },
);

/** Reconciliation accepts only this exact optional derived-data trigger, never arbitrary snapshot triggers. */
export const resolutionCandidateSnapshotTriggerCompatible = Effect.fn('codeGraph.candidateSnapshotTriggerCompatible')(
  function* (sql: SqlClient.SqlClient) {
    const rows = yield* sql<{readonly sql: string | null; readonly tbl_name: string}>`
    SELECT CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql ELSE NULL END AS sql,
      tbl_name FROM sqlite_master WHERE type = 'trigger' AND name = ${RESOLUTION_CANDIDATE_SNAPSHOT_TRIGGER.name} LIMIT 1`;
    return (
      rows.length === 0 ||
      (rows[0]?.tbl_name === 'snapshots' &&
        typeof rows[0].sql === 'string' &&
        normalizeSchemaDefinition(rows[0].sql) === normalizeSchemaDefinition(RESOLUTION_CANDIDATE_SNAPSHOT_TRIGGER.sql))
    );
  },
);

/** Checking the small schema contract also proves the mutation invalidation triggers still exist. */
const candidateIndexDefinitionsReady = Effect.fn('codeGraph.candidateIndexDefinitionsReady')(function* (
  sql: SqlClient.SqlClient,
  missingIndexes: ReadonlySet<string> = new Set(),
) {
  const rows = yield* sql.unsafe<{readonly name: string; readonly sql: string | null}>(
    `SELECT name, CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql ELSE NULL END AS sql
      FROM sqlite_master WHERE name IN (${EffectArray.join(
        EffectArray.map(objects, () => '?'),
        ',',
      )})`,
    EffectArray.map(objects, object => object.name),
  );
  const found = new Map(EffectArray.map(rows, row => [row.name, row.sql] as const));
  return EffectArray.every(objects, object => {
    if (missingIndexes.has(object.name) && !found.has(object.name)) return true;
    const actual = found.get(object.name);
    return typeof actual === 'string' && normalizeSchemaDefinition(actual) === normalizeSchemaDefinition(object.sql);
  });
});

/** Exact first-release schema is additive to pre-generation evidence; those rows lack bindings and stay untrusted. */
export const resolutionCandidateIndexSchemaReady = Effect.fn('codeGraph.candidateIndexSchemaReady')(function* (
  sql: SqlClient.SqlClient,
) {
  return (yield* candidateIndexDefinitionsReady(sql)) && (yield* resolutionCandidateAuthorityToken(sql)) !== undefined;
});

export const ensureResolutionCandidateIndexSchema = Effect.fn('codeGraph.ensureCandidateIndexSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  if (yield* resolutionCandidateIndexSchemaReady(sql)) return false;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (yield* resolutionCandidateIndexSchemaReady(sql)) return false;
      const lookup = RESOLUTION_CANDIDATE_INDEX_TABLES[1];
      const priorTables = new Set<string>();
      // Unknown populated layouts are never interpreted, migrated or rebuilt.
      for (const table of [...RESOLUTION_CANDIDATE_INDEX_TABLES, ...CANDIDATE_PAGE_TABLES]) {
        const prior = yield* sql<{readonly type: string; readonly name: string; readonly sql: string | null}>`
          SELECT type, name, CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192
            THEN sql ELSE NULL END AS sql FROM sqlite_master
          WHERE type IN ('table', 'view') AND name = ${table.name} COLLATE NOCASE LIMIT 1`;
        if (prior.length === 0) continue;
        if (
          prior[0]?.type !== 'table' ||
          prior[0].name !== table.name ||
          typeof prior[0].sql !== 'string' ||
          normalizeSchemaDefinition(prior[0].sql) !== normalizeSchemaDefinition(table.sql)
        )
          return yield* CodeGraphStoreError.of('Resolution candidate index schema is incompatible.');
        priorTables.add(table.name);
      }
      // Fence the exact unpublished pre-generation prototype without scanning/rebuilding any table or index.
      const predecessor = yield* sql<{readonly sql: string | null}>`SELECT
        CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql ELSE NULL END AS sql
        FROM sqlite_master WHERE type = 'trigger' AND name = 'snapshots_candidate_invalidate_update' LIMIT 1`;
      if (
        typeof predecessor[0]?.sql === 'string' &&
        normalizeSchemaDefinition(predecessor[0].sql) === normalizeSchemaDefinition(preGenerationSnapshotTriggerSql)
      )
        yield* sql.unsafe('DROP TRIGGER snapshots_candidate_invalidate_update');
      // Creating a missing secondary index over retained rows is unbounded foreground recovery.
      // Refuse only optional evidence until canonical schema restoration; first creation on an empty table is safe.
      const missing = new Set<string>();
      for (const index of [{name: 'snapshot_candidate_lookup_path', table: lookup.name}, ...CANDIDATE_PAGE_INDEXES]) {
        const present =
          yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ${index.name} COLLATE NOCASE LIMIT 1`;
        if (
          present.length === 0 &&
          priorTables.has(index.table) &&
          (yield* sql.unsafe(`SELECT 1 FROM ${index.table} LIMIT 1`)).length > 0
        )
          missing.add(index.name);
      }
      const blocked = missing.size > 0;
      if (
        blocked &&
        (yield* candidateIndexDefinitionsReady(sql, missing)) &&
        (yield* sql`SELECT 1 FROM snapshot_candidate_authority WHERE singleton = 1 AND state = 'blocked' LIMIT 1`)
          .length === 1
      )
        return false;
      for (const object of objects) {
        if (!missing.has(object.name)) yield* sql.unsafe(object.sql);
      }
      if (!(yield* candidateIndexDefinitionsReady(sql, missing)))
        return yield* CodeGraphStoreError.of('Resolution candidate index schema is incompatible.');
      // Constant-size atomic revocation: all prior bindings become stale without touching retained snapshot/file rows.
      // Compatible pre-generation rows need canonical restaging; missing authority never gets a reusable default token.
      yield* sql`INSERT INTO snapshot_candidate_authority (singleton, token, state)
        VALUES (1, lower(hex(randomblob(32))), ${blocked ? 'blocked' : 'ready'})
        ON CONFLICT(singleton) DO UPDATE SET token = excluded.token, state = excluded.state`;
      return true;
    }),
  );
});

/** Exact bounded persisted hyperedge form, shared by admission and writer. */
export function resolutionCandidateReexportRow(reference: CodeGraphReference) {
  if (reference.relation !== 'reexports' || (reference.aliasLookupKeys?.length ?? 0) === 0) return undefined;
  const prefix = `{"sourcePath":${JSON.stringify(reference.evidencePath)},"aliases":[`;
  const middle = '],"candidates":[';
  let bytes = Buffer.byteLength(prefix + middle + ']}');
  const encode = (keys: Iterable<string>, aliases: boolean) => {
    const parts: string[] = [];
    for (const key of keys) {
      const part = JSON.stringify({
        key,
        resolutionDomain: aliases ? lookupDomain(key, reference.resolutionDomain) : reference.resolutionDomain,
      });
      bytes += Buffer.byteLength(part) + (parts.length > 0 ? 1 : 0);
      if (bytes > RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES) return undefined;
      parts.push(part);
    }
    return EffectArray.join(parts, ',');
  };
  const aliases = encode(reference.aliasLookupKeys ?? [], true);
  if (aliases === undefined) return undefined;
  const candidates = encode(
    EffectArray.flatMap(reference.lookupTiers, tier => tier),
    false,
  );
  if (candidates === undefined) return undefined;
  return {path: reference.evidencePath, id: reference.edgeId, json: `${prefix}${aliases}${middle}${candidates}]}`};
}

/** Optional evidence may refuse a whole file without changing ordinary graph publication. */
export function resolutionCandidateFileRepresentable(
  snapshotId: string,
  file: Pick<CodeGraphInventoryFile, 'path' | 'contentHash'>,
  references: readonly CodeGraphReference[],
) {
  if (
    Buffer.byteLength(JSON.stringify([snapshotId, file.path, file.contentHash])) >
    RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES
  )
    return false;
  if (!candidateTextRepresentable(file.path) || !candidateTextRepresentable(file.contentHash)) return false;
  return EffectArray.every(references, reference => {
    if (
      !candidateTextRepresentable(reference.resolutionDomain) ||
      !isCodeGraphReferenceWithinCandidateBudget(reference)
    )
      return false;
    if (
      !EffectArray.every(reference.lookupTiers, tier =>
        EffectArray.every(
          tier,
          key =>
            candidateTextRepresentable(key) &&
            Buffer.byteLength(JSON.stringify([snapshotId, reference.resolutionDomain, key, reference.evidencePath])) <=
              RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES,
        ),
      )
    )
      return false;
    if (reference.relation !== 'reexports' || (reference.aliasLookupKeys?.length ?? 0) === 0) return true;
    const row = resolutionCandidateReexportRow(reference);
    return (
      row !== undefined &&
      Buffer.byteLength(JSON.stringify([snapshotId, row.path, row.id, row.json])) <=
        RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES
    );
  });
}
