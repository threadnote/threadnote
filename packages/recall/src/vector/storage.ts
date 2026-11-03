import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Schema} from 'effect';
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

/** Same model writer as manual builds, held only around one bounded metadata/payload transaction. */
export function withRecallVectorWrite<A, E, R>(
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  program: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(config.agentContextHome))) return yield* preparationChanged();
    const filename = recallVectorStorage.databasePath(path, config.agentContextHome, manifest.id);
    for (const directory of [
      path.join(config.agentContextHome, 'indexes'),
      path.join(config.agentContextHome, 'indexes', 'vectors'),
      path.dirname(filename),
      path.join(config.agentContextHome, 'locks'),
      path.join(config.agentContextHome, 'locks', 'indexes'),
      path.join(config.agentContextHome, 'locks', 'indexes', 'vectors'),
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
      path.join(config.agentContextHome, 'locks', 'indexes', 'vectors', manifest.id + '.lock'),
      {
        createParentDirectory: false,
        heartbeatIntervalMilliseconds: 1000,
        retryIntervalMilliseconds: 10,
        staleAfterMilliseconds: 60_000,
        waitTimeoutMilliseconds: 1000,
      },
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
            return yield* sql.withTransaction(
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
                yield* sql.unsafe(
                  'CREATE INDEX IF NOT EXISTS idle_recall_chunks_uri ON idle_recall_chunks (generation,uri)',
                );
                return yield* program;
              }),
            );
          }),
        );
      }),
    );
  });
}
