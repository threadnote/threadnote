import {Array as EffectArray} from 'effect';
import {DateTime, Effect, FileSystem, Option, Path, Schema} from 'effect';
import type {RecallVectorBuildOutcome, RecallVectorRefreshRecord} from '../diagnostics.js';
import * as SqlClient from 'effect/sql/SqlClient';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {recallVectorStorage} from '../vector-index.js';
import type {RecallEmbeddingScope} from '../background/demand.js';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';

export class RecallVectorPreparationChanged extends Schema.TaggedError<
  RecallVectorPreparationChanged,
  {readonly brand: unique symbol}
>()('RecallVectorPreparationChanged', {message: Schema.String}) {}
export const preparationChanged = () =>
  RecallVectorPreparationChanged.make({message: 'Recall vector preparation ownership changed; retry current demand.'});

/** The scope columns of a chunk row in every table that holds one; each chunk copy carries exactly these. */
export const RECALL_CHUNK_SCOPE_COLUMNS = 'chunk_id,uri,fingerprint,project,approved_authoritative';

/**
 * Delta state of a target. `copy_stage` walks 'chunks' → 'aliases' → 'done'; the page cursor is the largest key
 * the target holds, since copying precedes preparation. `copy_expected` and `alias_expected` are the base rows
 * outside the changed set; `copied_chunks` is the durable count that activation adds to the prepared chunks.
 * `purging` marks a delta reset to a full walk whose rows later steps delete in bounded batches.
 */
const RECALL_TARGET_ADDITIVE_COLUMNS = [
  ['base_generation', 'TEXT'],
  ['copy_stage', "TEXT CHECK(copy_stage IN ('chunks','aliases','done'))"],
  ['copy_expected', 'INTEGER NOT NULL DEFAULT 0 CHECK(copy_expected >= 0)'],
  ['alias_expected', 'INTEGER NOT NULL DEFAULT 0 CHECK(alias_expected >= 0)'],
  ['copied_chunks', 'INTEGER NOT NULL DEFAULT 0 CHECK(copied_chunks >= 0)'],
  ['purging', 'INTEGER NOT NULL DEFAULT 0 CHECK(purging IN (0, 1))'],
  ['embedded_chunks', 'INTEGER CHECK(embedded_chunks >= 0)'],
] as const;

/** The model writer lock of manual builds, background builds and compaction; it never creates the home. */
export function recallVectorLockPath(path: Path.Path, home: string, modelId: string) {
  return path.join(home, 'locks', 'indexes', 'vectors', modelId + '.lock');
}

/**
 * Lock only, with no connection or transaction: a compaction runs `VACUUM`, which SQLite refuses inside a
 * transaction, under the same lock as a build write.
 */
export function withRecallVectorLock<A, E, R>(home: string, modelId: string, program: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(home))) return yield* preparationChanged();
    const filename = recallVectorStorage.databasePath(path, home, modelId);
    for (const directory of [
      path.join(home, 'indexes'),
      path.join(home, 'indexes', 'vectors'),
      path.dirname(filename),
      path.join(home, 'locks'),
      path.join(home, 'locks', 'indexes'),
      path.join(home, 'locks', 'indexes', 'vectors'),
    ]) {
      yield* fs
        .makeDirectory(directory, {mode: 0o700})
        .pipe(
          Effect.catchTag('PlatformError', error =>
            error.reason._tag === 'AlreadyExists' ? Effect.void : Effect.fail(error),
          ),
        );
    }
    return yield* withExclusiveFileLock(
      fs,
      recallVectorLockPath(path, home, modelId),
      {
        createParentDirectory: false,
        heartbeatIntervalMilliseconds: 1000,
        retryIntervalMilliseconds: 10,
        staleAfterMilliseconds: 60_000,
        waitTimeoutMilliseconds: 1000,
      },
      program,
    );
  });
}

/** One model writer lease and connection. The caller chooses the SQLite transaction boundaries. */
export function withRecallVectorWriter<A, E, R>(
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  program: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = recallVectorStorage.databasePath(path, config.agentContextHome, manifest.id);
    return yield* withRecallVectorLock(
      config.agentContextHome,
      manifest.id,
      Effect.gen(function* () {
        const existed = yield* fs.exists(filename);
        if (!existed && ((yield* fs.exists(filename + '-wal')) || (yield* fs.exists(filename + '-shm'))))
          return yield* preparationChanged();
        return yield* recallVectorStorage.use(
          filename,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Never run the destructive version/recovery initializer against an existing file.
            yield* existed ? recallVectorStorage.validate(sql) : recallVectorStorage.initialize(sql);
            if (!existed) yield* fs.chmod(filename, 0o600);
            return yield* program;
          }),
        );
      }),
    );
  });
}

/** One bounded metadata or payload transaction under the model writer. */
export function withRecallVectorWrite<A, E, R>(
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  program: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) {
  return withRecallVectorWriter(
    config,
    manifest,
    Effect.flatMap(SqlClient.SqlClient, sql => recallVectorWriteTransaction(sql, program)),
  );
}

/** Prepare additive state and perform the first transaction of a writer lease. */
export function recallVectorWriteTransaction<A, E, R>(sql: SqlClient.SqlClient, program: Effect.Effect<A, E, R>) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const columns = yield* sql.unsafe<{readonly name: string}>('PRAGMA table_info(vector_generations)');
      if (!EffectArray.some(columns, column => column.name === 'scope_mapping_version'))
        yield* sql.unsafe(
          'ALTER TABLE vector_generations ADD COLUMN scope_mapping_version INTEGER NOT NULL DEFAULT 0 CHECK(scope_mapping_version >= 0)',
        );
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS idle_recall_targets (
        generation TEXT PRIMARY KEY REFERENCES vector_generations(generation) ON DELETE CASCADE,
        phase TEXT NOT NULL CHECK(phase IN ('metadata','resolve','hydrate','embed','retire','ready')),
        source_after TEXT, cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
        chunk_cursor INTEGER NOT NULL DEFAULT 0 CHECK(chunk_cursor >= 0), alias_cursor INTEGER NOT NULL DEFAULT 0 CHECK(alias_cursor >= 0)
      )`);
      // Additive delta-build columns; a target without a base generation is a full walk.
      const targetColumns = yield* sql.unsafe<{readonly name: string}>('PRAGMA table_info(idle_recall_targets)');
      for (const [name, definition] of RECALL_TARGET_ADDITIVE_COLUMNS)
        if (!EffectArray.some(targetColumns, column => column.name === name))
          yield* sql.unsafe(`ALTER TABLE idle_recall_targets ADD COLUMN ${name} ${definition}`);
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS idle_recall_delta_uris (
        generation TEXT NOT NULL REFERENCES idle_recall_targets(generation) ON DELETE CASCADE,
        uri TEXT NOT NULL, PRIMARY KEY(generation, uri)
      ) WITHOUT ROWID`);
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS idle_recall_metadata (
        generation TEXT NOT NULL REFERENCES idle_recall_targets(generation) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, candidate_json TEXT NOT NULL, candidate_sha256 TEXT NOT NULL, PRIMARY KEY(generation, ordinal)
      ) WITHOUT ROWID`);
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS idle_recall_documents (
        generation TEXT NOT NULL REFERENCES idle_recall_targets(generation) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, candidate_json TEXT NOT NULL, candidate_sha256 TEXT NOT NULL, PRIMARY KEY(generation, ordinal)
      ) WITHOUT ROWID`);
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS idle_recall_chunks (
        generation TEXT NOT NULL REFERENCES idle_recall_targets(generation) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL, uri TEXT NOT NULL, fingerprint TEXT NOT NULL, project TEXT,
        approved_authoritative INTEGER NOT NULL, vector_key TEXT NOT NULL, content TEXT NOT NULL, payload_hash TEXT NOT NULL,
        PRIMARY KEY(generation, chunk_id)
      ) WITHOUT ROWID`);
      yield* sql.unsafe(
        "CREATE UNIQUE INDEX IF NOT EXISTS idle_recall_documents_uri ON idle_recall_documents (generation,json_extract(candidate_json, '$.uri'))",
      );
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS idle_recall_document_preparations (
        generation TEXT NOT NULL REFERENCES idle_recall_targets(generation) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, reuse_key TEXT NOT NULL, chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
        reused INTEGER NOT NULL CHECK(reused IN (0,1)), PRIMARY KEY(generation, ordinal)
      ) WITHOUT ROWID`);
      yield* sql.unsafe(
        'CREATE INDEX IF NOT EXISTS idle_recall_preparation_reuse ON idle_recall_document_preparations (reuse_key)',
      );
      yield* sql.unsafe('CREATE INDEX IF NOT EXISTS idle_recall_chunks_uri ON idle_recall_chunks (generation,uri)');
      // One row per prepared memory, outside any target and without text: the identity of its last
      // body read and a digest of the chunk rows that read produced.
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS idle_recall_document_identities (
        uri TEXT PRIMARY KEY, identity_key TEXT NOT NULL,
        chunk_count INTEGER NOT NULL CHECK(chunk_count > 0), chunk_digest TEXT NOT NULL
      ) WITHOUT ROWID`);
      return yield* program;
    }),
  );
}

const RECALL_VECTOR_REFRESH_LIMIT = 16;

export function recallVectorRefreshRecord(
  counts: RecallVectorBuildOutcome,
  createdAt: string,
  activatedAt: number,
  firstUncoveredPublication: number | undefined,
): RecallVectorRefreshRecord {
  const start = DateTime.make(createdAt).pipe(
    Option.map(DateTime.toEpochMillis),
    Option.getOrElse(() => activatedAt),
  );
  return {
    ...counts,
    durationMilliseconds: Math.max(0, activatedAt - start),
    ...(firstUncoveredPublication === undefined
      ? {}
      : {staleDurationMilliseconds: Math.max(0, activatedAt - firstUncoveredPublication)}),
  };
}

/** Append a pending record inside the pointer transaction. Only the post-activation fence can confirm it. */
export const recordRecallVectorRefresh = Effect.fn('recall.recordVectorRefresh')(function* (
  sql: SqlClient.SqlClient,
  record: RecallVectorRefreshRecord,
) {
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS recall_vector_refreshes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
    kind TEXT NOT NULL CHECK(kind IN ('delta','full')),
    changed_count INTEGER NOT NULL CHECK(changed_count >= 0),
    copied_chunks INTEGER NOT NULL CHECK(copied_chunks >= 0),
    reused_chunks INTEGER NOT NULL CHECK(reused_chunks >= 0),
    embedded_chunks INTEGER NOT NULL CHECK(embedded_chunks >= 0),
    duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
    stale_duration_ms INTEGER CHECK(stale_duration_ms >= 0)
  )`);
  const rows = yield* sql<{readonly sequence: number}>`
    INSERT INTO recall_vector_refreshes (kind,changed_count,copied_chunks,reused_chunks,embedded_chunks,duration_ms,stale_duration_ms)
    VALUES (${record.kind},${record.changedCount},${record.copiedChunkCount},${record.reusedChunkCount},
      ${record.embeddedChunkCount},${record.durationMilliseconds},${record.staleDurationMilliseconds ?? null})
    RETURNING sequence`;
  yield* sql`DELETE FROM recall_vector_refreshes WHERE sequence IN (
    SELECT sequence FROM recall_vector_refreshes WHERE verified = 0
    ORDER BY sequence DESC LIMIT -1 OFFSET ${RECALL_VECTOR_REFRESH_LIMIT}
  )`;
  return rows[0]?.sequence ?? (yield* Effect.die('vector refresh record insert returned no sequence'));
});

/** Unconfirmed rows can survive a crash. Readers cannot see them, and later writes bound their retention. */
export const confirmRecallVectorRefresh = Effect.fn('recall.confirmVectorRefresh')(function* (
  sql: SqlClient.SqlClient,
  sequence: number,
) {
  yield* sql`UPDATE recall_vector_refreshes SET verified = 1 WHERE sequence = ${sequence}`;
  yield* sql`DELETE FROM recall_vector_refreshes WHERE sequence IN (
    SELECT sequence FROM recall_vector_refreshes WHERE verified = 1
    ORDER BY sequence DESC LIMIT -1 OFFSET ${RECALL_VECTOR_REFRESH_LIMIT}
  )`;
});

/** Undo the exact publication record if its cross-database post-activation fence fails. */
export const removeRecallVectorRefresh = (sql: SqlClient.SqlClient, sequence: number) =>
  sql`DELETE FROM recall_vector_refreshes WHERE sequence = ${sequence}`;

export const readLastRecallVectorRefreshRecord = Effect.fn('recall.readLastVectorRefreshRecord')(function* (
  sql: SqlClient.SqlClient,
) {
  const exists = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recall_vector_refreshes'`;
  if (!exists.length) return undefined;
  const [row] = yield* sql<{
    readonly kind: RecallVectorRefreshRecord['kind'];
    readonly changed_count: number;
    readonly copied_chunks: number;
    readonly reused_chunks: number;
    readonly embedded_chunks: number;
    readonly duration_ms: number;
    readonly stale_duration_ms: number | null;
  }>`SELECT kind,changed_count,copied_chunks,reused_chunks,embedded_chunks,duration_ms,stale_duration_ms
      FROM recall_vector_refreshes WHERE verified = 1 ORDER BY sequence DESC LIMIT 1`;
  if (!row) return undefined;
  return {
    kind: row.kind,
    changedCount: row.changed_count,
    copiedChunkCount: row.copied_chunks,
    reusedChunkCount: row.reused_chunks,
    embeddedChunkCount: row.embedded_chunks,
    durationMilliseconds: row.duration_ms,
    ...(row.stale_duration_ms === null ? {} : {staleDurationMilliseconds: row.stale_duration_ms}),
  } satisfies RecallVectorRefreshRecord;
});
