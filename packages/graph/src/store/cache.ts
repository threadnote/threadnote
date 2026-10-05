import {Effect, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphBlobExtractionReuseClass} from '../blob_reuse.js';
import {
  CODE_GRAPH_CACHE_TRANSACTION_LIMITS,
  codeGraphFileBlobCapacityBytes,
  codeGraphMaterializedShardCapacityBytes,
  codeGraphTextFieldsCapacityBytes,
  planCodeGraphCacheCapacityChunks,
  type CodeGraphCacheCapacityChunk,
  type CodeGraphCacheCapacityRow,
} from '../cache_capacity.js';
import {saturatingCapacityAdd, type CodeGraphDirectPersistentCapacityBoundary} from '../disk/capacity.js';
import {ensureBoundedCodeGraphFact, type BoundedCodeGraphFact} from '../fact/budget.js';
import {encodeStoredCodeGraphFact} from '../fact/storage.js';
import {compareCodeUnits} from '../ordering.js';
import {
  type CodeGraphMaterializedShardCacheBatch,
  type CodeGraphFactCacheBatch,
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphReusableBaseReceiptInput,
} from './models.js';
import {useDatabase} from './session.js';
import {
  type CodeGraphInventoryFile,
  type CodeGraphSnapshot,
  CodeGraphStoreError,
  isCodeGraphStoreError,
  type CodeGraphStoreFailure,
} from '../types.js';
import {CodeGraphCacheCapacityPlanChanged} from './internal_models.js';
import {lastStatementChangeCount} from './activation/core.js';
import {assertPersistentBuildOwner} from './build/core.js';

interface PlannedFreshFactCacheRow extends CodeGraphCacheCapacityRow {
  readonly blobId?: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly extractorSet: string;
  readonly factsJson: string;
  readonly path: string;
  readonly reuseClass?: string;
}

interface PlannedMaterializedShardCacheRow extends CodeGraphCacheCapacityRow {
  readonly contentHash: string;
  readonly createdAt: string;
  readonly derivationIdentity: string;
  readonly extractorSet: string;
  readonly factsJson: string;
  readonly id: string;
  readonly lastUsedAt: string;
  readonly path: string;
}

function freshFactCacheCapacityKey(contentHash: string, extractorSet: string, path: string): string {
  return JSON.stringify([contentHash, extractorSet, path]);
}

function cacheCapacityPlanningError(label: string, cause: unknown): CodeGraphStoreFailure {
  if (isCodeGraphStoreError(cause)) return cause;
  const reason = cause instanceof Error && cause.message.includes('payload ceiling') ? ' payload ceiling' : ' input';
  return CodeGraphStoreError.of(`Code graph cache ${label}${reason} is invalid.`);
}

function prepareFreshFactCacheRows(
  files: readonly CodeGraphInventoryFile[],
  facts: readonly BoundedCodeGraphFact[],
  extractorSet: string,
  createdAt: string,
): readonly PlannedFreshFactCacheRow[] {
  const inputs = pairCacheInputs(files, facts, 'Fresh parser facts');
  return inputs.map(({bounded, file}) => {
    const reuseClass = codeGraphBlobExtractionReuseClass(file);
    const stored = encodeStoredCodeGraphFact(bounded);
    const row = {
      ...(reuseClass === undefined ? {} : {blobId: file.blobId, reuseClass}),
      contentHash: file.contentHash,
      createdAt,
      extractorSet,
      factsJson: stored.json,
      key: freshFactCacheCapacityKey(file.contentHash, extractorSet, file.path),
      path: file.path,
    };
    return {...row, payloadBytes: codeGraphFileBlobCapacityBytes(row)};
  });
}

function prepareFreshFactCacheChunks(
  files: readonly CodeGraphInventoryFile[],
  facts: readonly BoundedCodeGraphFact[],
  extractorSet: string,
  createdAt: string,
): readonly CodeGraphCacheCapacityChunk<PlannedFreshFactCacheRow>[] {
  return planCodeGraphCacheCapacityChunks(
    'cache code graph file facts',
    prepareFreshFactCacheRows(files, facts, extractorSet, createdAt),
  );
}

function prepareFreshFactCacheBatchChunks(
  batches: readonly CodeGraphFactCacheBatch[],
  createdAt: string,
): readonly CodeGraphCacheCapacityChunk<PlannedFreshFactCacheRow>[] {
  return planCodeGraphCacheCapacityChunks(
    'cache code graph file facts',
    batches.flatMap(batch =>
      prepareFreshFactCacheRows(
        batch.files,
        batch.facts.map(ensureBoundedCodeGraphFact),
        batch.extractorSet,
        createdAt,
      ),
    ),
  );
}

function storeFreshFactRows(sql: SqlClient.SqlClient, rows: readonly PlannedFreshFactCacheRow[]) {
  return Effect.gen(function* () {
    for (const page of codeGraphCacheWritePages(rows)) {
      yield* sql.unsafe(
        `INSERT INTO file_blobs (
           content_hash, extractor_set, path_hint, blob_id, reuse_class, facts_json, created_at
         ) VALUES ${page.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT(content_hash, extractor_set, path_hint) DO UPDATE SET
           blob_id = excluded.blob_id,
           reuse_class = excluded.reuse_class,
           facts_json = excluded.facts_json,
           created_at = excluded.created_at`,
        page.flatMap(row => [
          row.contentHash,
          row.extractorSet,
          row.path,
          row.blobId ?? null,
          row.reuseClass ?? null,
          row.factsJson,
          row.createdAt,
        ]),
      );
    }
  });
}

/** @internal Keeps every cache UPSERT within the existing physical transaction row ceiling. */
export function codeGraphCacheWritePages<A>(rows: readonly A[]): readonly (readonly A[])[] {
  const pages: A[][] = [];
  for (let offset = 0; offset < rows.length; offset += CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows) {
    pages.push(rows.slice(offset, offset + CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows));
  }
  return pages;
}

export function materializedShardDerivationIdentity(
  extractorSet: string,
  workspaceFingerprint: string,
  graphContentId: string,
): string {
  return `cgfd_${sha256HexSync(
    `materialized-file-derivation-v3\n${extractorSet}\n${workspaceFingerprint}\n${graphContentId}`,
  ).slice(0, 40)}`;
}

type MaterializedShardRepositoryEnvelopeFile = Pick<
  CodeGraphInventoryFile,
  'contentHash' | 'language' | 'mode' | 'path' | 'source'
>;

function retainedMaterializationContext(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.toLowerCase() === 'package.json' || /^tsconfig(?:\.[^/]+)?\.json$/iu.test(name);
}

/**
 * Captures every repository path that can affect attribution, while retaining
 * content only for manifests consumed outside the deterministic source batch.
 * Ordinary source bodies are intentionally represented by their batch key.
 */
export function materializedShardRepositorySemanticEnvelope(
  files: readonly MaterializedShardRepositoryEnvelopeFile[],
): string {
  const entries = [...files]
    .sort((left, right) => compareCodeUnits(left.path, right.path))
    .map(file => [
      file.path,
      file.language,
      file.mode,
      retainedMaterializationContext(file.path) ? file.contentHash : null,
    ]);
  return `cgfe_${sha256HexSync(`materialized-repository-semantic-envelope-v1\n${JSON.stringify(entries)}`).slice(
    0,
    40,
  )}`;
}

/**
 * V4 final-fact derivation identity. The ordered batch is part of the key so
 * attribution never observes a hit/miss partition that differs from the one
 * that originally produced the shard rows.
 */
export function materializedBatchShardDerivationIdentity(
  extractorSet: string,
  workspaceFingerprint: string,
  repositorySemanticEnvelope: string,
  files: readonly MaterializedShardRepositoryEnvelopeFile[],
): string {
  const orderedBatchMembers = files.map(file => [file.path, file.contentHash, file.language, file.mode, file.source]);
  return `cgfd_${sha256HexSync(
    `materialized-file-derivation-v4\n${extractorSet}\n${workspaceFingerprint}\n${repositorySemanticEnvelope}\n${JSON.stringify(
      orderedBatchMembers,
    )}`,
  ).slice(0, 40)}`;
}

export function materializedFileShardIdentity(
  contentHash: string,
  extractorSet: string,
  derivationIdentity: string,
  path: string,
): string {
  return `cgfs_${sha256HexSync(
    `materialized-file-shard-v1\n${contentHash}\n${extractorSet}\n${derivationIdentity}\n${path}`,
  ).slice(0, 40)}`;
}

export function shardDonorIds(...candidates: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(candidates.filter((value): value is string => value !== undefined))].slice(0, 2);
}

const associateMaterializedFileShardBatch = Effect.fn('codeGraph.associateMaterializedFileShardBatch')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
  derivationIdentity: string,
  selectedShardIds: ReadonlyMap<string, string>,
) {
  if (
    files.length === 0 ||
    new Set(files.map(file => file.path)).size !== files.length ||
    selectedShardIds.size !== files.length
  ) {
    return yield* CodeGraphStoreError.of('Materialized file shard batch association is incomplete.');
  }
  const expected = files.map(file => ({
    contentHash: file.contentHash,
    id: materializedFileShardIdentity(file.contentHash, extractorSet, derivationIdentity, file.path),
    path: file.path,
  }));
  if (expected.some(row => selectedShardIds.get(row.path) !== row.id)) {
    return yield* CodeGraphStoreError.of('Materialized file shard batch selection changed.');
  }

  yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
  const requested = JSON.stringify(expected);
  const rows = yield* sql<{
    readonly content_hash: string;
    readonly id: string;
    readonly path: string;
  }>`
    SELECT shard.id, file.path, file.content_hash
    FROM json_each(${requested}) AS requested
    JOIN snapshot_files AS file
      ON file.snapshot_id = ${snapshotId}
     AND file.path = json_extract(requested.value, '$.path')
     AND file.content_hash = json_extract(requested.value, '$.contentHash')
    JOIN materialized_file_shards AS shard
      ON shard.id = json_extract(requested.value, '$.id')
     AND shard.content_hash = file.content_hash
     AND shard.path_hint = file.path
     AND shard.extractor_set = ${extractorSet}
     AND shard.derivation_identity = ${derivationIdentity}
  `;
  const stored = new Map(rows.map(row => [row.path, row]));
  if (
    stored.size !== expected.length ||
    expected.some(row => {
      const actual = stored.get(row.path);
      return actual?.id !== row.id || actual.content_hash !== row.contentHash;
    })
  ) {
    return yield* CodeGraphStoreError.of('Materialized file shard batch is unavailable.');
  }
  yield* sql.unsafe(
    `INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id)
     VALUES ${expected.map(() => '(?, ?, ?)').join(', ')}
     ON CONFLICT(snapshot_id, path) DO UPDATE SET shard_id = excluded.shard_id`,
    expected.flatMap(row => [snapshotId, row.path, row.id]),
  );
});

const associateSnapshotFileShards = Effect.fn('codeGraph.associateSnapshotFileShards')(function* (
  sql: SqlClient.SqlClient,
  snapshot: Pick<CodeGraphSnapshot, 'extractorSet' | 'graphContentId' | 'id'>,
  receipt: CodeGraphReusableBaseReceiptInput | undefined,
) {
  if (!receipt) return;
  const derivationIdentity = materializedShardDerivationIdentity(
    snapshot.extractorSet,
    receipt.workspaceFingerprint,
    snapshot.graphContentId ?? snapshot.id,
  );
  yield* sql`
    INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id)
    SELECT ${snapshot.id}, file.path, shard.id
    FROM snapshot_files AS file
    JOIN materialized_file_shards AS shard
      ON shard.content_hash = file.content_hash
     AND shard.path_hint = file.path
     AND shard.extractor_set = ${snapshot.extractorSet}
     AND shard.derivation_identity = ${derivationIdentity}
    WHERE file.snapshot_id = ${snapshot.id}
    ON CONFLICT(snapshot_id, path) DO NOTHING
  `;
});

const inheritSnapshotFileShards = Effect.fn('codeGraph.inheritSnapshotFileShards')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string,
) {
  yield* sql`
    INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id)
    SELECT ${snapshotId}, base.path, base.shard_id
    FROM snapshot_file_shards AS base
    WHERE base.snapshot_id = ${baseSnapshotId}
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_files AS current
        WHERE current.snapshot_id = ${snapshotId} AND current.path = base.path
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_file_deletions AS deleted
        WHERE deleted.snapshot_id = ${snapshotId} AND deleted.path = base.path
      )
    ON CONFLICT(snapshot_id, path) DO NOTHING
  `;
});

function prepareMaterializedShardCacheChunks(
  files: readonly CodeGraphInventoryFile[],
  facts: readonly BoundedCodeGraphFact[],
  extractorSet: string,
  derivationIdentity: string,
  now: string,
): readonly CodeGraphCacheCapacityChunk<PlannedMaterializedShardCacheRow>[] {
  const inputs = pairCacheInputs(files, facts, 'Materialized file shard');
  return planCodeGraphCacheCapacityChunks(
    'cache materialized code graph file shards',
    inputs.map(({bounded, file}) => {
      const stored = encodeStoredCodeGraphFact(bounded);
      const row = {
        contentHash: file.contentHash,
        createdAt: now,
        derivationIdentity,
        extractorSet,
        factsJson: stored.json,
        id: materializedFileShardIdentity(file.contentHash, extractorSet, derivationIdentity, file.path),
        key: file.path,
        lastUsedAt: now,
        path: file.path,
      };
      return {...row, payloadBytes: codeGraphMaterializedShardCapacityBytes(row)};
    }),
  );
}

/** Plans several already-bounded attribution batches into the same physical cache transaction ceilings. */
function prepareMaterializedShardCacheBatchChunks(
  batches: readonly CodeGraphMaterializedShardCacheBatch[],
  now: string,
): readonly CodeGraphCacheCapacityChunk<PlannedMaterializedShardCacheRow>[] {
  const rows = batches.flatMap(batch =>
    prepareMaterializedShardCacheChunks(
      batch.files,
      batch.facts.map(ensureBoundedCodeGraphFact),
      batch.extractorSet,
      batch.derivationIdentity,
      now,
    ).flatMap(chunk => chunk.rows),
  );
  return planCodeGraphCacheCapacityChunks('cache materialized code graph file shards', rows);
}

function pairCacheInputs(
  files: readonly CodeGraphInventoryFile[],
  facts: readonly BoundedCodeGraphFact[],
  label: string,
): readonly {readonly bounded: BoundedCodeGraphFact; readonly file: CodeGraphInventoryFile}[] {
  const filesByPath = new Map(files.map(file => [file.path, file]));
  const factsByPath = new Map(facts.map(bounded => [bounded.facts.path, bounded]));
  if (
    files.length !== facts.length ||
    filesByPath.size !== files.length ||
    factsByPath.size !== facts.length ||
    [...filesByPath.keys()].some(path => !factsByPath.has(path))
  ) {
    throw CodeGraphStoreError.of(`${label} inputs are inconsistent.`);
  }
  return [...filesByPath]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([path, file]) => ({bounded: factsByPath.get(path)!, file}));
}

interface MaterializedShardMetadataRow {
  readonly content_hash: string;
  readonly created_at: string;
  readonly derivation_identity: string;
  readonly extractor_set: string;
  readonly facts_bytes: number;
  readonly id: string;
  readonly last_used_at: string;
  readonly path_hint: string;
}

interface RawMaterializedShardMetadataRow {
  readonly content_hash: unknown;
  readonly created_at: unknown;
  readonly derivation_identity: unknown;
  readonly extractor_set: unknown;
  readonly facts_bytes: unknown;
  readonly id: unknown;
  readonly last_used_at: unknown;
  readonly path_hint: unknown;
}

interface MaterializedShardAssociationRow {
  readonly path: string;
  readonly shard_id: string;
  readonly snapshot_id: string;
}

interface RawMaterializedShardAssociationPageRow {
  readonly association_count: unknown;
  readonly path: unknown;
  readonly shard_id: unknown;
  readonly snapshot_id: unknown;
}

type MaterializedShardRepairPlan =
  | {
      readonly associations: readonly MaterializedShardAssociationRow[];
      readonly associationCount: number;
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly conflicts: readonly MaterializedShardMetadataRow[];
      readonly mode: 'drain';
      readonly row: PlannedMaterializedShardCacheRow;
    }
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly conflicts: readonly MaterializedShardMetadataRow[];
      readonly mode: 'final';
      readonly row: PlannedMaterializedShardCacheRow;
    }
  | {readonly mode: 'normal'};

type CodeGraphCacheWriterGate = <A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, unknown, R>;

interface MaterializedShardCacheWriteInput {
  readonly databasePath: string;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly withWriterGate: CodeGraphCacheWriterGate;
}

const writeMaterializedShardCacheRows = Effect.fn('codeGraph.writeMaterializedShardCacheRows')(function* (input: {
  readonly databasePath: string;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly rows: readonly PlannedMaterializedShardCacheRow[];
  readonly withWriterGate: CodeGraphCacheWriterGate;
}) {
  let pending = [...input.rows];
  while (pending.length > 0) {
    const collisionIndex = yield* useDatabase(
      input.databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const existing = yield* materializedShardMetadata(sql, pending);
        return pending.findIndex(row => materializedShardConflicts(row, existing).length > 0);
      }),
    );
    if (collisionIndex > 0) {
      if (!(yield* writeNormalMaterializedShardCacheRows(input, pending.slice(0, collisionIndex)))) {
        yield* Effect.yieldNow;
        continue;
      }
      pending = pending.slice(collisionIndex);
      continue;
    }
    if (collisionIndex === 0) {
      if (yield* repairMaterializedShardCacheRow(input, pending[0])) {
        pending = pending.slice(1);
      }
      continue;
    }

    if (yield* writeNormalMaterializedShardCacheRows(input, pending)) return;
    yield* Effect.yieldNow;
  }
});

const writeNormalMaterializedShardCacheRows = Effect.fn('codeGraph.writeNormalMaterializedShardCacheRows')(function* (
  input: MaterializedShardCacheWriteInput,
  rows: readonly PlannedMaterializedShardCacheRow[],
) {
  const chunk = planCodeGraphCacheCapacityChunks('cache materialized code graph file shards', rows)[0];
  return yield* input
    .persistentCapacityProtector(
      chunk.boundary,
      input.withWriterGate(
        input.databasePath,
        useDatabase(
          input.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.withTransaction(storeNormalMaterializedShardRows(sql, chunk.rows));
          }),
        ),
      ),
    )
    .pipe(
      Effect.as(true),
      Effect.catchIf(Schema.is(CodeGraphCacheCapacityPlanChanged), () => Effect.succeed(false)),
    );
});

const repairMaterializedShardCacheRow = Effect.fn('codeGraph.repairMaterializedShardCacheRow')(function* (
  input: {
    readonly databasePath: string;
    readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
    readonly withWriterGate: CodeGraphCacheWriterGate;
  },
  row: PlannedMaterializedShardCacheRow,
) {
  for (;;) {
    const plan = yield* useDatabase(
      input.databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* prepareMaterializedShardRepairPlan(sql, row);
      }),
    );
    if (plan.mode === 'normal') return false;
    const completed = yield* input
      .persistentCapacityProtector(
        plan.boundary,
        input.withWriterGate(
          input.databasePath,
          useDatabase(
            input.databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.withTransaction(applyMaterializedShardRepairPlan(sql, plan));
            }),
          ),
        ),
      )
      .pipe(
        Effect.as(true),
        Effect.catchIf(Schema.is(CodeGraphCacheCapacityPlanChanged), () => Effect.succeed(false)),
      );
    if (!completed) {
      yield* Effect.yieldNow;
      continue;
    }
    if (plan.mode === 'final') return true;
    yield* Effect.yieldNow;
  }
});

function storeNormalMaterializedShardRows(sql: SqlClient.SqlClient, rows: readonly PlannedMaterializedShardCacheRow[]) {
  return Effect.gen(function* () {
    if (rows.length === 0) return;
    // The cache capacity planner already bounds this physical transaction to
    // 512 rows / 32 MiB. Bind bounded multi-row pages so cold builds do not
    // prepare one SQLite statement per file. The existing 512-row physical
    // transaction ceiling needs at most 4,096 binds for this eight-column
    // statement; any omitted RETURNING row still fails the whole transaction
    // through the unchanged collision-repair path.
    for (const page of codeGraphCacheWritePages(rows)) {
      const stored = yield* sql.unsafe<{readonly id: string}>(
        `INSERT INTO materialized_file_shards (
           id, content_hash, extractor_set, derivation_identity, path_hint,
           facts_json, created_at, last_used_at
         ) VALUES ${page.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT(id) DO UPDATE SET
           facts_json = excluded.facts_json,
           last_used_at = excluded.last_used_at
         WHERE materialized_file_shards.content_hash = excluded.content_hash
           AND materialized_file_shards.extractor_set = excluded.extractor_set
           AND materialized_file_shards.derivation_identity = excluded.derivation_identity
           AND materialized_file_shards.path_hint = excluded.path_hint
         ON CONFLICT(content_hash, extractor_set, derivation_identity, path_hint) DO NOTHING
         RETURNING id`,
        page.flatMap(row => [
          row.id,
          row.contentHash,
          row.extractorSet,
          row.derivationIdentity,
          row.path,
          row.factsJson,
          row.createdAt,
          row.lastUsedAt,
        ]),
      );
      if (
        !sameMaterializedShardWriteIds(
          page.map(row => row.id),
          stored.map(row => row.id),
        )
      ) {
        return yield* CodeGraphCacheCapacityPlanChanged.make({});
      }
    }
  });
}

/** @internal Accepts driver-independent RETURNING order while rejecting every partial or ambiguous write. */
export function sameMaterializedShardWriteIds(expectedIds: readonly string[], storedIds: readonly string[]): boolean {
  if (storedIds.length !== expectedIds.length) return false;
  const expected = new Set(expectedIds);
  const stored = new Set(storedIds);
  return (
    expected.size === expectedIds.length && stored.size === storedIds.length && expectedIds.every(id => stored.has(id))
  );
}

const prepareMaterializedShardRepairPlan = Effect.fn('codeGraph.prepareMaterializedShardRepairPlan')(function* (
  sql: SqlClient.SqlClient,
  row: PlannedMaterializedShardCacheRow,
) {
  const existing = yield* materializedShardMetadata(sql, [row]);
  const conflicts = materializedShardConflicts(row, existing);
  if (conflicts.length === 0) return {mode: 'normal'} as const satisfies MaterializedShardRepairPlan;
  if (conflicts.length > 2) {
    return yield* CodeGraphStoreError.of(`Materialized file shard identity collision: ${row.id}.`);
  }
  const conflictIds = conflicts.map(conflict => conflict.id);
  const associationPage = yield* materializedShardAssociationPage(
    sql,
    conflictIds,
    CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows,
  );
  const associationCount = associationPage.associationCount;
  if (associationCount > 0) {
    const page: MaterializedShardAssociationRow[] = [];
    let payloadBytes = 0;
    for (const association of associationPage.associations) {
      const candidateBytes = codeGraphTextFieldsCapacityBytes(
        association.snapshot_id,
        association.path,
        association.shard_id,
      );
      if (candidateBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes) {
        return yield* CodeGraphStoreError.of(`Materialized file shard association exceeds the repair payload ceiling.`);
      }
      if (payloadBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes - candidateBytes) break;
      page.push(association);
      payloadBytes += candidateBytes;
    }
    if (page.length === 0) {
      return yield* CodeGraphStoreError.of('Materialized file shard repair could not make progress.');
    }
    return {
      associations: page,
      associationCount,
      boundary: {
        finalFactBytes: payloadBytes,
        operation: 'cache materialized code graph file shards',
        rowCount: page.length,
      },
      conflicts,
      mode: 'drain',
      row,
    } as const satisfies MaterializedShardRepairPlan;
  }

  const conflictBytes = conflicts.reduce(
    (total, conflict) => saturatingCapacityAdd(total, materializedShardMetadataCapacityBytes(conflict)),
    0,
  );
  const payloadBytes = saturatingCapacityAdd(conflictBytes, row.payloadBytes);
  if (payloadBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes) {
    return yield* CodeGraphStoreError.of('Materialized file shard collision exceeds the repair payload ceiling.');
  }
  return {
    boundary: {
      finalFactBytes: payloadBytes,
      operation: 'cache materialized code graph file shards',
      rowCount: conflicts.length + 1,
    },
    conflicts,
    mode: 'final',
    row,
  } as const satisfies MaterializedShardRepairPlan;
});

const applyMaterializedShardRepairPlan = Effect.fn('codeGraph.applyMaterializedShardRepairPlan')(function* (
  sql: SqlClient.SqlClient,
  plan: Exclude<MaterializedShardRepairPlan, {readonly mode: 'normal'}>,
) {
  const current = materializedShardConflicts(plan.row, yield* materializedShardMetadata(sql, [plan.row]));
  if (!sameMaterializedShardMetadata(current, plan.conflicts)) {
    return yield* CodeGraphCacheCapacityPlanChanged.make({});
  }
  const conflictIds = plan.conflicts.map(conflict => conflict.id);
  const associationPage = yield* materializedShardAssociationPage(
    sql,
    conflictIds,
    plan.mode === 'drain' ? plan.associations.length : 1,
  );
  const associationCount = associationPage.associationCount;
  if (plan.mode === 'drain') {
    if (
      associationCount !== plan.associationCount ||
      !sameMaterializedShardAssociations(associationPage.associations, plan.associations)
    ) {
      return yield* CodeGraphCacheCapacityPlanChanged.make({});
    }
    for (const association of plan.associations) {
      yield* sql`
        DELETE FROM snapshot_file_shards
        WHERE snapshot_id = ${association.snapshot_id}
          AND path = ${association.path}
          AND shard_id = ${association.shard_id}
      `;
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* CodeGraphCacheCapacityPlanChanged.make({});
      }
    }
    return;
  }
  if (associationCount !== 0) {
    return yield* CodeGraphCacheCapacityPlanChanged.make({});
  }
  for (const conflict of plan.conflicts) {
    yield* sql`
      DELETE FROM materialized_file_shards
      WHERE id = ${conflict.id}
        AND content_hash = ${conflict.content_hash}
        AND extractor_set = ${conflict.extractor_set}
        AND derivation_identity = ${conflict.derivation_identity}
        AND path_hint = ${conflict.path_hint}
        AND created_at = ${conflict.created_at}
        AND last_used_at = ${conflict.last_used_at}
        AND length(CAST(facts_json AS BLOB)) = ${conflict.facts_bytes}
    `;
    if ((yield* lastStatementChangeCount(sql)) !== 1) {
      return yield* CodeGraphCacheCapacityPlanChanged.make({});
    }
  }
  yield* storeNormalMaterializedShardRows(sql, [plan.row]);
});

function materializedShardMetadata(sql: SqlClient.SqlClient, rows: readonly PlannedMaterializedShardCacheRow[]) {
  if (rows.length === 0) return Effect.succeed([] as readonly MaterializedShardMetadataRow[]);
  const ids = rows.map(row => row.id);
  const requested = JSON.stringify(
    rows.map(row => ({
      contentHash: row.contentHash,
      derivationIdentity: row.derivationIdentity,
      extractorSet: row.extractorSet,
      path: row.path,
    })),
  );
  return Effect.gen(function* () {
    const [byId, byTuple] = yield* Effect.all(
      [
        sql<RawMaterializedShardMetadataRow>`
          SELECT id, content_hash, extractor_set, derivation_identity, path_hint,
            length(CAST(facts_json AS BLOB)) AS facts_bytes, created_at, last_used_at
          FROM materialized_file_shards
          WHERE ${sql.in('id', ids)}
        `,
        sql<RawMaterializedShardMetadataRow>`
          SELECT shard.id, shard.content_hash, shard.extractor_set, shard.derivation_identity, shard.path_hint,
            length(CAST(shard.facts_json AS BLOB)) AS facts_bytes, shard.created_at, shard.last_used_at
          FROM materialized_file_shards AS shard
          JOIN json_each(${requested}) AS requested
            ON shard.content_hash = json_extract(requested.value, '$.contentHash')
           AND shard.extractor_set = json_extract(requested.value, '$.extractorSet')
           AND shard.derivation_identity = json_extract(requested.value, '$.derivationIdentity')
           AND shard.path_hint = json_extract(requested.value, '$.path')
        `,
      ] as const,
      {concurrency: 1},
    );
    const unique = new Map<string, MaterializedShardMetadataRow>();
    for (const value of [...byId, ...byTuple]) {
      const decoded = yield* decodeMaterializedShardMetadata(value);
      unique.set(decoded.id, decoded);
    }
    return [...unique.values()].sort((left, right) => compareCodeUnits(left.id, right.id));
  });
}

function decodeMaterializedShardMetadata(row: RawMaterializedShardMetadataRow) {
  if (
    !validMaterializedShardText(row.id) ||
    !validMaterializedShardText(row.content_hash) ||
    !validMaterializedShardText(row.extractor_set) ||
    !validMaterializedShardText(row.derivation_identity) ||
    !validMaterializedShardText(row.path_hint) ||
    !validMaterializedShardText(row.created_at) ||
    !validMaterializedShardText(row.last_used_at) ||
    typeof row.facts_bytes !== 'number' ||
    !Number.isSafeInteger(row.facts_bytes) ||
    row.facts_bytes < 0
  ) {
    return Effect.fail(CodeGraphStoreError.of('Materialized file shard metadata is invalid.'));
  }
  return Effect.succeed({
    content_hash: row.content_hash,
    created_at: row.created_at,
    derivation_identity: row.derivation_identity,
    extractor_set: row.extractor_set,
    facts_bytes: row.facts_bytes,
    id: row.id,
    last_used_at: row.last_used_at,
    path_hint: row.path_hint,
  } satisfies MaterializedShardMetadataRow);
}

function decodeMaterializedShardAssociationPageRow(row: RawMaterializedShardAssociationPageRow) {
  if (
    !validMaterializedShardText(row.snapshot_id) ||
    !validMaterializedShardText(row.path) ||
    !validMaterializedShardText(row.shard_id) ||
    typeof row.association_count !== 'number' ||
    !Number.isSafeInteger(row.association_count) ||
    row.association_count < 1
  ) {
    return Effect.fail(CodeGraphStoreError.of('Materialized file shard association metadata is invalid.'));
  }
  return Effect.succeed({
    association: {path: row.path, shard_id: row.shard_id, snapshot_id: row.snapshot_id},
    associationCount: row.association_count,
  });
}

function validMaterializedShardText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function materializedShardConflicts(
  row: PlannedMaterializedShardCacheRow,
  existing: readonly MaterializedShardMetadataRow[],
): readonly MaterializedShardMetadataRow[] {
  return existing.filter(candidate => {
    const tupleMatches = materializedShardTupleMatches(row, candidate);
    const relevant = candidate.id === row.id || tupleMatches;
    return relevant && !(candidate.id === row.id && tupleMatches);
  });
}

function materializedShardTupleMatches(
  row: PlannedMaterializedShardCacheRow,
  candidate: MaterializedShardMetadataRow,
): boolean {
  return (
    candidate.content_hash === row.contentHash &&
    candidate.extractor_set === row.extractorSet &&
    candidate.derivation_identity === row.derivationIdentity &&
    candidate.path_hint === row.path
  );
}

function materializedShardMetadataCapacityBytes(row: MaterializedShardMetadataRow): number {
  return saturatingCapacityAdd(
    codeGraphTextFieldsCapacityBytes(
      row.id,
      row.content_hash,
      row.extractor_set,
      row.derivation_identity,
      row.path_hint,
      row.created_at,
      row.last_used_at,
    ),
    row.facts_bytes,
  );
}

function materializedShardAssociationPage(sql: SqlClient.SqlClient, shardIds: readonly string[], limit: number) {
  if (shardIds.length === 0 || limit <= 0) {
    return Effect.succeed({associationCount: 0, associations: [] as readonly MaterializedShardAssociationRow[]});
  }
  const statement = codeGraphMaterializedShardAssociationPageStatement(shardIds, limit);
  return sql.unsafe<RawMaterializedShardAssociationPageRow>(statement.text, statement.parameters).pipe(
    Effect.flatMap(rows =>
      Effect.gen(function* () {
        if (rows.length === 0) return {associationCount: 0, associations: [] as const};
        const associations: MaterializedShardAssociationRow[] = [];
        let associationCount: number | undefined;
        for (const row of rows) {
          const decoded = yield* decodeMaterializedShardAssociationPageRow(row);
          associationCount ??= decoded.associationCount;
          if (decoded.associationCount !== associationCount) {
            return yield* CodeGraphStoreError.of('Materialized file shard association metadata is invalid.');
          }
          associations.push(decoded.association);
        }
        return {associationCount: associationCount!, associations};
      }),
    ),
  );
}

/** @internal Exposed for deterministic SQLite snapshot-contract tests. */
export function codeGraphMaterializedShardAssociationPageStatement(shardIds: readonly string[], limit: number) {
  return {
    parameters: [
      JSON.stringify(shardIds),
      Math.min(CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows, Math.max(1, Math.floor(limit))),
    ] as const,
    text: `
    SELECT snapshot_id, path, shard_id, COUNT(*) OVER () AS association_count
    FROM snapshot_file_shards
    WHERE shard_id IN (SELECT value FROM json_each(?))
    ORDER BY snapshot_id, path
    LIMIT ?
  `,
  };
}

function sameMaterializedShardMetadata(
  left: readonly MaterializedShardMetadataRow[],
  right: readonly MaterializedShardMetadataRow[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameMaterializedShardAssociations(
  left: readonly MaterializedShardAssociationRow[],
  right: readonly MaterializedShardAssociationRow[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export {
  PlannedMaterializedShardCacheRow,
  MaterializedShardMetadataRow,
  MaterializedShardAssociationRow,
  CodeGraphCacheWriterGate,
  PlannedFreshFactCacheRow,
  inheritSnapshotFileShards,
  pairCacheInputs,
  RawMaterializedShardMetadataRow,
  RawMaterializedShardAssociationPageRow,
  MaterializedShardRepairPlan,
  storeNormalMaterializedShardRows,
  validMaterializedShardText,
  associateMaterializedFileShardBatch,
  associateSnapshotFileShards,
  MaterializedShardCacheWriteInput,
  writeNormalMaterializedShardCacheRows,
  decodeMaterializedShardMetadata,
  materializedShardMetadata,
  decodeMaterializedShardAssociationPageRow,
  materializedShardTupleMatches,
  materializedShardConflicts,
  materializedShardMetadataCapacityBytes,
  materializedShardAssociationPage,
  prepareMaterializedShardRepairPlan,
  sameMaterializedShardMetadata,
  sameMaterializedShardAssociations,
  applyMaterializedShardRepairPlan,
  repairMaterializedShardCacheRow,
  cacheCapacityPlanningError,
  prepareFreshFactCacheBatchChunks,
  prepareFreshFactCacheChunks,
  storeFreshFactRows,
  prepareMaterializedShardCacheChunks,
  prepareMaterializedShardCacheBatchChunks,
  writeMaterializedShardCacheRows,
};
