import {Effect, FileSystem, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {RECALL_CHUNKER_VERSION} from '../chunker.js';
import {readRecallPublishedGenerationHint, type RecallIndexConfig} from '../index.js';
import type {recallVectorStorage} from '../vector-index.js';

export const VECTOR_SCOPE_MAPPING_VERSION = 1;
type VectorReadModel = Pick<LocalModelManifest, 'id' | 'sha256' | 'dimensions' | 'promptPrefixes'>;
type NegativeMetadataAccess = Pick<typeof recallVectorStorage, 'databasePath' | 'read' | 'validate' | 'recipe'>;

interface GuardedGeneration {
  readonly corpus_generation: string | null;
  readonly generation: string | null;
  readonly job_id: string | null;
  readonly chunk_count: number | null;
  readonly created_at: string | null;
  readonly model_id: string | null;
  readonly model_sha256: string | null;
  readonly dimensions: number | null;
  readonly embedding_recipe: string | null;
  readonly chunker_version: number | null;
  readonly normalized: string | null;
  readonly scope_mapping_version: number | null;
  readonly state: string | null;
}

/** Fixed metadata reads only. Matching metadata is unknown, never positive vector authority. */
export const negativeSemanticReadinessHint = Effect.fn('vectorIndex.negativeReadinessHint')(function* (
  config: RecallIndexConfig,
  manifest: VectorReadModel,
  storage: NegativeMetadataAccess,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = storage.databasePath(path, config.agentContextHome, manifest.id);
  if (!(yield* fs.exists(databasePath))) return 'missing' as const;
  const corpus = yield* readRecallPublishedGenerationHint(config);
  if (corpus === undefined) return 'unknown' as const;
  return yield* storage.read(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* storage.validate(sql, 50, true);
      // Guard the pointer before using it as a generation lookup key. CASE is lazy;
      // octet_length(column) reads size metadata, unlike substr or text length.
      const pointers = yield* sql.unsafe<{readonly generation: string | null}>(
        `SELECT CASE WHEN typeof(generation) = 'text' THEN
          CASE WHEN octet_length(generation) <= 128 THEN generation END END AS generation
         FROM vector_pointer WHERE singleton = 1 LIMIT 1`,
      );
      const pointer = pointers[0]?.generation;
      if (typeof pointer !== 'string' || !/^[0-9]+-[a-f0-9-]+$/.test(pointer)) return 'unknown' as const;
      const rows = yield* sql<GuardedGeneration>`SELECT
        CASE WHEN typeof(corpus_generation) = 'text' THEN CASE WHEN octet_length(corpus_generation) <= 65536 THEN corpus_generation END END AS corpus_generation,
        CASE WHEN typeof(generation) = 'text' THEN CASE WHEN octet_length(generation) <= 128 THEN generation END END AS generation,
        CASE WHEN typeof(job_id) = 'text' THEN CASE WHEN octet_length(job_id) <= 79 THEN job_id END END AS job_id,
        CASE WHEN typeof(chunk_count) = 'integer' THEN chunk_count END AS chunk_count,
        CASE WHEN typeof(created_at) = 'text' THEN CASE WHEN octet_length(created_at) <= 128 THEN created_at END END AS created_at,
        CASE WHEN typeof(model_id) = 'text' THEN CASE WHEN octet_length(model_id) <= 128 THEN model_id END END AS model_id,
        CASE WHEN typeof(model_sha256) = 'text' THEN CASE WHEN octet_length(model_sha256) <= 64 THEN model_sha256 END END AS model_sha256,
        CASE WHEN typeof(dimensions) = 'integer' THEN dimensions END AS dimensions,
        CASE WHEN typeof(embedding_recipe) = 'text' THEN CASE WHEN octet_length(embedding_recipe) <= 65536 THEN embedding_recipe END END AS embedding_recipe,
        CASE WHEN typeof(chunker_version) = 'integer' THEN chunker_version END AS chunker_version,
        CASE WHEN typeof(normalized) = 'text' THEN CASE WHEN octet_length(normalized) <= 2 THEN normalized END END AS normalized,
        CASE WHEN typeof(scope_mapping_version) = 'integer' THEN scope_mapping_version END AS scope_mapping_version,
        CASE WHEN typeof(state) = 'text' THEN CASE WHEN octet_length(state) <= 5 THEN state END END AS state
        FROM vector_generations WHERE generation = ${pointer} LIMIT 1`;
      const active = rows[0];
      if (
        !active ||
        typeof active.corpus_generation !== 'string' ||
        active.corpus_generation.length === 0 ||
        active.generation !== pointer ||
        typeof active.job_id !== 'string' ||
        !/^(?:idle-recall-v2:)?[0-9a-f]{64}$/.test(active.job_id) ||
        active.chunk_count === null ||
        !Number.isSafeInteger(active.chunk_count) ||
        active.chunk_count < 0 ||
        typeof active.created_at !== 'string' ||
        active.created_at.length === 0 ||
        active.model_id !== manifest.id ||
        active.model_sha256 !== manifest.sha256 ||
        active.dimensions !== manifest.dimensions ||
        active.embedding_recipe !== storage.recipe(manifest) ||
        active.chunker_version !== RECALL_CHUNKER_VERSION ||
        active.normalized !== 'l2' ||
        active.scope_mapping_version !== VECTOR_SCOPE_MAPPING_VERSION ||
        active.state !== 'ready'
      )
        return 'unknown' as const;
      return active.corpus_generation === corpus ? ('unknown' as const) : ('stale' as const);
    }),
  );
});
