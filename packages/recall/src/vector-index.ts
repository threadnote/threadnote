import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Clock, Crypto, DateTime, Effect, FileSystem, Layer, Option, Path, Result, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {normalizeRecallProject, type RecallEligibilityPolicy} from './eligibility.js';
import {recallApprovedAuthoritative, recallEligibilityPredicate} from './index/eligibility.js';
import {
  combineRecallSqlPredicates,
  recallUriMatchesScopes,
  recallUriScopePredicate,
  type RecallSqlPredicate,
} from './index/scope.js';
import type {RecallCandidate} from './rank.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {chunkRecallDocument, RECALL_CHUNKER_VERSION, type RecallChunk} from './chunker.js';
import {normalizeVector, type VectorSearchResult} from '@threadnote/inference/vector-search';

class VectorIndexOperationError extends Schema.TaggedError<VectorIndexOperationError>()('VectorIndexOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const VECTOR_INDEX_DATABASE_VERSION = 5;
const VECTOR_INDEX_EMBED_BATCH_SIZE = 256;
const VECTOR_INDEX_PAGE_SIZE = 400;
const VECTOR_INDEX_INSERT_BATCH_SIZE = 100;
const VECTOR_INDEX_DATABASE_FILENAME = `vectors-v${VECTOR_INDEX_DATABASE_VERSION}.sqlite`;
const VECTOR_INDEX_SCHEMA_COLUMNS = {
  vector_aliases: ['generation', 'uri', 'representative_uri'],
  vector_chunks: ['generation', 'chunk_id', 'uri', 'fingerprint', 'project', 'approved_authoritative', 'vector_id'],
  vector_generations: [
    'generation',
    'job_id',
    'corpus_generation',
    'model_id',
    'model_sha256',
    'dimensions',
    'embedding_recipe',
    'chunker_version',
    'normalized',
    'chunk_count',
    'state',
    'created_at',
  ],
  vector_pointer: ['singleton', 'generation'],
  vector_values: ['id', 'vector_key', 'vector'],
} as const;

interface VectorGenerationRow {
  readonly actual_chunk_count: number;
  readonly chunk_count: number;
  readonly chunker_version: number;
  readonly corpus_generation: string | null;
  readonly created_at: string;
  readonly dimensions: number;
  readonly embedding_recipe: string;
  readonly generation: string;
  readonly job_id: string;
  readonly model_id: string;
  readonly model_sha256: string;
  readonly normalized: 'l2';
  readonly state: 'building' | 'ready';
}

interface VectorRow {
  readonly chunk_id: string;
  readonly fingerprint: string;
  readonly uri: string;
  readonly vector: unknown;
}

interface VectorChunkMapping extends RecallChunk {
  readonly approvedAuthoritative: 0 | 1;
  readonly project: string | null;
}

interface DesiredVectorChunk extends VectorChunkMapping {
  readonly vectorKey: string;
}

interface SemanticChunkMatch extends VectorSearchResult {
  readonly uri: string;
}

interface VectorAliasRow {
  readonly representative_uri: string;
  readonly uri: string;
}

interface VectorAliasMapping {
  readonly representativeUri: string;
  readonly uri: string;
}

interface VectorInsertRow {
  readonly approvedAuthoritative: 0 | 1;
  readonly chunkId: string;
  readonly fingerprint: string;
  readonly generation: string;
  readonly project: string | null;
  readonly uri: string;
  readonly vector: Uint8Array;
  readonly vectorKey: string;
}

export interface VectorIndexStatus {
  readonly chunkCount: number;
  readonly createdAt?: string;
  readonly dimensions?: number;
  readonly embeddedChunkCount?: number;
  readonly generation?: string;
  readonly modelId: string;
  readonly ready: boolean;
  readonly reason?: string;
  readonly reusedChunkCount?: number;
}

export type VectorIndexGenerationReadiness = 'corrupt' | 'current' | 'missing' | 'stale';

export class VectorIndexCorrupt extends Schema.TaggedError<VectorIndexCorrupt>()('VectorIndexCorrupt', {
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class VectorCorpusGenerationChanged extends Schema.TaggedError<VectorCorpusGenerationChanged>()(
  'VectorCorpusGenerationChanged',
  {
    message: Schema.String,
    modelId: Schema.String,
    requestedGeneration: Schema.String,
  },
) {}

export type VectorIndexProgress =
  | {
      readonly completed: number;
      readonly phase: 'embedding';
      readonly reused: number;
      readonly total: number;
    }
  | {
      readonly chunkCount: number;
      readonly phase: 'activating';
    };

interface VectorCorpusGenerationOptions<R> {
  readonly corpusGeneration?: string;
  readonly currentCorpusGeneration?: () => Effect.Effect<Option.Option<string>, unknown, R>;
}

interface VectorIndexBuildOptions<R> extends VectorCorpusGenerationOptions<R> {
  readonly onProgress?: (progress: VectorIndexProgress) => Effect.Effect<void, unknown>;
}

interface SemanticScoreOptions<R> extends VectorCorpusGenerationOptions<R> {
  readonly allowedUriScopes?: readonly string[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly limit?: number;
}

const verifyCurrentCorpusGeneration = Effect.fn('vectorIndex.verifyCurrentCorpusGeneration')(function* <R = never>(
  manifest: LocalModelManifest,
  options: VectorCorpusGenerationOptions<R>,
) {
  if (options.currentCorpusGeneration === undefined) return;
  const requestedGeneration = options.corpusGeneration;
  if (requestedGeneration === undefined) {
    return yield* VectorIndexOperationError.make({
      message: 'A vector corpus-generation fence requires a requested generation.',
    });
  }
  const currentGeneration = yield* options.currentCorpusGeneration();
  if (Option.isSome(currentGeneration) && currentGeneration.value === requestedGeneration) return;
  return yield* VectorCorpusGenerationChanged.make({
    message: 'The lexical recall corpus changed while vector work was in progress.',
    modelId: manifest.id,
    requestedGeneration,
  });
});

const verifySelectedCorpusGeneration = Effect.fn('vectorIndex.verifySelectedCorpusGeneration')(function* <R = never>(
  active: VectorGenerationRow,
  manifest: LocalModelManifest,
  options: VectorCorpusGenerationOptions<R>,
) {
  const requestedGeneration = options.corpusGeneration;
  if (requestedGeneration !== undefined && active.corpus_generation !== requestedGeneration) {
    return yield* VectorCorpusGenerationChanged.make({
      message: 'The active vector index no longer matches the requested lexical recall corpus.',
      modelId: manifest.id,
      requestedGeneration,
    });
  }
  yield* verifyCurrentCorpusGeneration(manifest, options);
});

export const rebuildVectorIndex = Effect.fn('vectorIndex.rebuild')(function* <R = never>(
  config: {readonly agentContextHome: string},
  manifest: LocalModelManifest,
  candidates: readonly RecallCandidate[],
  options: VectorIndexBuildOptions<R> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withVectorIndexLock(fs, path, config.agentContextHome, manifest.id, () =>
    rebuildVectorIndexUnlocked(config, manifest, candidates, options),
  );
});

export const ensureVectorIndex = Effect.fn('vectorIndex.ensure')(function* <R = never>(
  config: {readonly agentContextHome: string},
  manifest: LocalModelManifest,
  candidates: readonly RecallCandidate[],
  options: VectorIndexBuildOptions<R> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const chunks = vectorChunkMappings(candidates);
  const aliases = vectorAliasMappings(candidates);
  const current = yield* currentVectorIndexStatus(config.agentContextHome, manifest, chunks, aliases, options).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (current) {
    yield* verifyCurrentCorpusGeneration(manifest, options);
    return current;
  }
  return yield* withVectorIndexLock(fs, path, config.agentContextHome, manifest.id, () =>
    Effect.gen(function* () {
      const lockedCurrent = yield* currentVectorIndexStatus(
        config.agentContextHome,
        manifest,
        chunks,
        aliases,
        options,
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (lockedCurrent) {
        yield* verifyCurrentCorpusGeneration(manifest, options);
        return lockedCurrent;
      }
      return yield* rebuildVectorIndexUnlocked(config, manifest, candidates, options, chunks, aliases);
    }),
  );
});

export const vectorIndexMatchesGeneration = Effect.fn('vectorIndex.matchesGeneration')(function* (
  home: string,
  manifest: LocalModelManifest,
  corpusGeneration: string,
) {
  return (yield* vectorIndexGenerationReadiness(home, manifest, corpusGeneration)) === 'current';
});

/**
 * Read only the active generation metadata and retain the distinction between
 * an absent/stale derived index and structural storage failure. Callers may
 * safely schedule ordinary generation work for missing/stale state, but must
 * keep corruption behind an explicit repair boundary.
 */
export const vectorIndexGenerationReadiness = Effect.fn('vectorIndex.generationReadiness')(function* (
  home: string,
  manifest: LocalModelManifest,
  corpusGeneration: string,
) {
  const active = yield* readActiveVectorGeneration(home, manifest).pipe(Effect.result);
  if (Result.isFailure(active)) return 'corrupt' as const;
  if (!active.success) return 'missing' as const;
  return generationMatchesCorpus(active.success, manifest, corpusGeneration)
    ? ('current' as const)
    : ('stale' as const);
});

const currentVectorIndexStatus = Effect.fn('vectorIndex.currentStatus')(function* <R = never>(
  home: string,
  manifest: LocalModelManifest,
  chunks: readonly VectorChunkMapping[],
  aliases: readonly VectorAliasMapping[],
  options: VectorIndexBuildOptions<R>,
) {
  const active = yield* readActiveVectorGeneration(home, manifest);
  if (!active) return undefined;
  const jobId = yield* vectorJobId(
    manifest,
    chunks,
    aliases,
    options.corpusGeneration ?? active.corpus_generation ?? undefined,
  );
  if (!generationIsCompatible(active, manifest) || active.job_id !== jobId) return undefined;
  return {
    chunkCount: active.chunk_count,
    createdAt: active.created_at,
    dimensions: active.dimensions,
    embeddedChunkCount: 0,
    generation: active.generation,
    modelId: manifest.id,
    ready: true,
    reusedChunkCount: active.chunk_count,
  } satisfies VectorIndexStatus;
});

const rebuildVectorIndexUnlocked = Effect.fn('vectorIndex.rebuildUnlocked')(function* <R = never>(
  config: {readonly agentContextHome: string},
  manifest: LocalModelManifest,
  candidates: readonly RecallCandidate[],
  options: VectorIndexBuildOptions<R> = {},
  preparedChunks?: readonly VectorChunkMapping[],
  preparedAliases?: readonly VectorAliasMapping[],
) {
  yield* verifyCurrentCorpusGeneration(manifest, options);
  if (manifest.role !== 'embedding' || !manifest.dimensions) {
    return yield* VectorIndexOperationError.make({message: `Model ${manifest.id} is not an embedding model.`});
  }
  const dimensions = manifest.dimensions;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runtime = yield* LocalModelRuntime;
  const store = yield* LocalModelStore;
  const installed = yield* store.verify(config.agentContextHome, manifest);
  const chunks = preparedChunks ?? vectorChunkMappings(candidates);
  const aliases = preparedAliases ?? vectorAliasMappings(candidates);
  const recipe = embeddingRecipe(manifest);
  const desiredChunks = chunks.map(chunk => ({
    ...chunk,
    vectorKey: vectorKeyForChunk(recipe, chunk),
  }));
  const root = vectorModelRoot(path, config.agentContextHome, manifest.id);
  const databasePath = vectorDatabasePath(path, config.agentContextHome, manifest.id);
  const jobId = yield* vectorJobId(manifest, chunks, aliases, options.corpusGeneration);
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  yield* initializeVectorDatabaseWithRecovery(fs, databasePath);

  const status = yield* useVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeVectorDatabase(sql);
      const activeResult = yield* selectActiveGeneration(sql).pipe(Effect.result);
      const active =
        Result.isSuccess(activeResult) &&
        activeResult.success !== undefined &&
        generationIsCompatible(activeResult.success, manifest)
          ? activeResult.success
          : undefined;
      if (!active && (Result.isFailure(activeResult) || activeResult.success !== undefined)) {
        yield* sql.unsafe('DELETE FROM vector_pointer');
      }
      yield* sql`DELETE FROM vector_generations WHERE state = 'building' AND job_id <> ${jobId}`;
      yield* prepareDesiredChunks(sql, desiredChunks);

      let building: VectorGenerationRow | undefined = yield* selectGenerationByJob(sql, jobId);
      if (building && !generationIsCompatible(building, manifest)) {
        yield* sql`DELETE FROM vector_generations WHERE generation = ${building.generation}`;
        building = undefined;
      }
      if (!building) {
        const generation = `${yield* Clock.currentTimeMillis}-${(yield* crypto.randomUUIDv4).slice(0, 8)}`;
        yield* sql`
          INSERT INTO vector_generations (
            generation,
            job_id,
            corpus_generation,
            model_id,
            model_sha256,
            dimensions,
            embedding_recipe,
            chunker_version,
            normalized,
            chunk_count,
            state,
            created_at
          ) VALUES (
            ${generation},
            ${jobId},
            ${options.corpusGeneration ?? null},
            ${manifest.id},
            ${manifest.sha256},
            ${manifest.dimensions},
            ${recipe},
            ${RECALL_CHUNKER_VERSION},
            'l2',
            0,
            'building',
            ${DateTime.formatIso(yield* DateTime.now)}
          )
        `;
        building = yield* selectGenerationByJob(sql, jobId);
      }
      if (!building) {
        return yield* VectorIndexOperationError.make({
          message: `Could not create vector generation for ${manifest.id}.`,
        });
      }

      yield* replaceVectorAliases(sql, building.generation, aliases);
      yield* removeUndesiredVectorRows(sql, building.generation);
      yield* mapReusableVectorRows(sql, building.generation);
      yield* removeInvalidVectorRows(sql, building.generation, dimensions);
      yield* pruneUnreferencedVectorValues(sql);

      const reusableChunkCount = yield* countVectorRows(sql, building.generation);
      if (building.state === 'ready' && reusableChunkCount === chunks.length) {
        yield* options.onProgress?.({
          completed: 0,
          phase: 'embedding',
          reused: reusableChunkCount,
          total: 0,
        }) ?? Effect.void;
        yield* options.onProgress?.({chunkCount: reusableChunkCount, phase: 'activating'}) ?? Effect.void;
        yield* activateVectorGenerationFenced(
          sql,
          building.generation,
          reusableChunkCount,
          options.corpusGeneration,
          manifest,
          options,
        );
        yield* pruneVectorGenerations(sql, building.generation);
        yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
        return vectorStatus(building, manifest.id, reusableChunkCount, 0, reusableChunkCount);
      }

      yield* sql`
        UPDATE vector_generations
        SET state = 'building', chunk_count = ${reusableChunkCount}
        WHERE generation = ${building.generation}
      `;
      const missingTotal = chunks.length - reusableChunkCount;
      let embeddedChunkCount = 0;
      yield* options.onProgress?.({
        completed: embeddedChunkCount,
        phase: 'embedding',
        reused: reusableChunkCount,
        total: missingTotal,
      }) ?? Effect.void;

      for (let pageStart = 0; pageStart < desiredChunks.length; pageStart += VECTOR_INDEX_PAGE_SIZE) {
        const page = desiredChunks.slice(pageStart, pageStart + VECTOR_INDEX_PAGE_SIZE);
        const existingIds = yield* selectExistingChunkIds(
          sql,
          building.generation,
          page.map(chunk => chunk.id),
        );
        const missing = page.filter(chunk => !existingIds.has(chunk.id));
        for (let start = 0; start < missing.length; start += VECTOR_INDEX_EMBED_BATCH_SIZE) {
          const batch = missing.slice(start, start + VECTOR_INDEX_EMBED_BATCH_SIZE);
          const vectors = yield* runtime.embedMany({
            inputs: batch.map(chunk => `${manifest.promptPrefixes?.document ?? ''}${chunk.content}`),
            manifest,
            modelPath: installed.path,
          });
          yield* verifyCurrentCorpusGeneration(manifest, options);
          const rows = batch.map((chunk, index) => ({
            approvedAuthoritative: chunk.approvedAuthoritative,
            chunkId: chunk.id,
            fingerprint: chunk.fingerprint,
            generation: building.generation,
            project: chunk.project,
            uri: chunk.uri,
            vector: encodeVector(normalizeVector(vectors[index]), dimensions),
            vectorKey: chunk.vectorKey,
          }));
          yield* insertVectorRows(sql, rows);
          embeddedChunkCount += batch.length;
          yield* options.onProgress?.({
            completed: embeddedChunkCount,
            phase: 'embedding',
            reused: reusableChunkCount,
            total: missingTotal,
          }) ?? Effect.void;
        }
      }

      const finalChunkCount = yield* countVectorRows(sql, building.generation);
      if (finalChunkCount !== chunks.length) {
        return yield* VectorIndexOperationError.make({
          message: `Vector generation ${building.generation} has ${finalChunkCount}/${chunks.length} chunks.`,
        });
      }
      yield* options.onProgress?.({chunkCount: finalChunkCount, phase: 'activating'}) ?? Effect.void;
      yield* activateVectorGenerationFenced(
        sql,
        building.generation,
        finalChunkCount,
        options.corpusGeneration,
        manifest,
        options,
      );
      yield* pruneVectorGenerations(sql, building.generation);
      yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
      return vectorStatus(building, manifest.id, finalChunkCount, embeddedChunkCount, reusableChunkCount);
    }),
  );
  yield* removeLegacyVectorSidecars(fs, path, root);
  return status;
});

export const selectedSemanticScores = Effect.fn('vectorIndex.selectedSemanticScores')(function* <R = never>(
  config: {readonly agentContextHome: string},
  query: string,
  options: SemanticScoreOptions<R> = {},
) {
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = selection.roles.embedding;
  if (!modelId) return undefined;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  if (!manifest.dimensions || manifest.role !== 'embedding') return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = vectorDatabasePath(path, config.agentContextHome, manifest.id);
  if (!(yield* fs.exists(databasePath))) return undefined;
  const store = yield* LocalModelStore;
  const runtime = yield* LocalModelRuntime;
  const status = yield* store.status(config.agentContextHome, manifest);
  if (!status.installed) return undefined;

  const activeBeforeInference = yield* readActiveVectorGeneration(config.agentContextHome, manifest);
  if (!activeBeforeInference) return undefined;
  yield* verifySelectedCorpusGeneration(activeBeforeInference, manifest, options);
  const normalizedQuery =
    activeBeforeInference.chunk_count === 0
      ? Option.none<readonly number[]>()
      : Option.some(
          normalizeVector(
            (yield* runtime.embedMany({
              inputs: [`${manifest.promptPrefixes?.query ?? ''}${query}`],
              manifest,
              modelPath: status.path,
            }))[0],
          ),
        );

  const scores = yield* useVectorDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* validateVectorDatabase(sql);
          const active = yield* selectActiveGeneration(sql);
          if (!active || !generationIsCompatible(active, manifest)) return undefined;
          yield* verifySelectedCorpusGeneration(active, manifest, options);
          if (active.chunk_count === 0) return new Map<string, number>();
          if (Option.isNone(normalizedQuery)) {
            return yield* VectorIndexOperationError.make({
              message: 'The active vector corpus changed shape during semantic scoring.',
            });
          }
          const limit = Math.min(active.chunk_count, options.limit ?? 500);
          const selection = vectorChunkSelectionPredicate(options.eligibility, options.allowedUriScopes);
          let cursor = '';
          let best: readonly SemanticChunkMatch[] = [];
          for (;;) {
            const rows = yield* sql.unsafe<VectorRow>(
              `SELECT chunk.chunk_id, chunk.uri, chunk.fingerprint, value.vector
               FROM vector_chunks AS chunk
               JOIN vector_values AS value ON value.id = chunk.vector_id
               WHERE chunk.generation = ?
                 AND chunk.chunk_id > ?
                 AND ${selection.sql}
               ORDER BY chunk.chunk_id
               LIMIT ?`,
              [active.generation, cursor, ...selection.params, VECTOR_INDEX_PAGE_SIZE],
            );
            if (rows.length === 0) break;
            const pageMatches = yield* Effect.try({
              try: () => searchEncodedVectorRows(normalizedQuery.value, rows, active.dimensions, limit),
              catch: cause =>
                VectorIndexCorrupt.make({
                  message: cause instanceof Error ? cause.message : String(cause),
                  modelId: manifest.id,
                }),
            });
            best = mergeSemanticMatches(best, pageMatches, limit);
            cursor = rows.at(-1)!.chunk_id;
            if (rows.length < VECTOR_INDEX_PAGE_SIZE) break;
          }
          const scores = new Map<string, number>();
          for (const result of best) {
            scores.set(result.uri, Math.max(scores.get(result.uri) ?? 0, Math.max(0, result.score)));
          }
          const aliases = yield* loadVectorAliasesForRepresentatives(
            sql,
            active.generation,
            [...scores.keys()],
            options.eligibility,
            options.allowedUriScopes,
          );
          for (const alias of aliases) {
            const score = scores.get(alias.representative_uri);
            if (score !== undefined) scores.set(alias.uri, Math.max(scores.get(alias.uri) ?? 0, score));
          }
          if (options.allowedUriScopes?.length) {
            for (const uri of scores.keys()) {
              if (!recallUriMatchesScopes(uri, options.allowedUriScopes)) scores.delete(uri);
            }
          }
          return scores;
        }),
      );
    }),
  ).pipe(
    // Effect's generator inference does not retain the tagged error introduced by
    // the paged synchronous scorer, so make the public failure channel explicit.
    Effect.mapError(error => error),
  );
  // The SQLite transaction pins the vector snapshot. Re-check the independently
  // changing lexical corpus after releasing that read snapshot so a long paged
  // scan cannot return scores for a corpus that was superseded mid-query.
  yield* verifyCurrentCorpusGeneration(manifest, options);
  return scores;
});

export const vectorIndexStatus = Effect.fn('vectorIndex.status')(function* (
  home: string,
  manifest: LocalModelManifest,
  candidates?: readonly RecallCandidate[],
) {
  const active = yield* readActiveVectorGeneration(home, manifest).pipe(Effect.result);
  if (Result.isFailure(active)) {
    return {
      chunkCount: 0,
      modelId: manifest.id,
      ready: false,
      reason: active.failure instanceof Error ? active.failure.message : String(active.failure),
    } satisfies VectorIndexStatus;
  }
  if (!active.success) {
    return {chunkCount: 0, modelId: manifest.id, ready: false, reason: 'not built'} satisfies VectorIndexStatus;
  }
  const vectorIntegrity = yield* validateVectorGenerationRows(
    home,
    manifest,
    active.success.generation,
    active.success.dimensions,
  ).pipe(Effect.result);
  if (Result.isFailure(vectorIntegrity)) {
    return {
      chunkCount: active.success.chunk_count,
      dimensions: active.success.dimensions,
      modelId: manifest.id,
      ready: false,
      reason:
        vectorIntegrity.failure instanceof Error ? vectorIntegrity.failure.message : String(vectorIntegrity.failure),
    } satisfies VectorIndexStatus;
  }
  if (
    candidates &&
    active.success.job_id !==
      (yield* vectorJobId(
        manifest,
        vectorChunkMappings(candidates),
        vectorAliasMappings(candidates),
        active.success.corpus_generation ?? undefined,
      ))
  ) {
    return {
      chunkCount: active.success.chunk_count,
      dimensions: active.success.dimensions,
      modelId: manifest.id,
      ready: false,
      reason: 'stale; canonical documents changed',
    } satisfies VectorIndexStatus;
  }
  return {
    chunkCount: active.success.chunk_count,
    createdAt: active.success.created_at,
    dimensions: active.success.dimensions,
    generation: active.success.generation,
    modelId: manifest.id,
    ready: true,
  } satisfies VectorIndexStatus;
});

export const purgeVectorIndex = Effect.fn('vectorIndex.purge')(function* (home: string, modelId: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withVectorIndexLock(fs, path, home, modelId, () =>
    Effect.gen(function* () {
      const root = vectorModelRoot(path, home, modelId);
      if (!(yield* fs.exists(root))) return false;
      yield* fs.remove(root, {recursive: true});
      return true;
    }),
  );
});

export function vectorIndexDatabaseFilename(): string {
  return VECTOR_INDEX_DATABASE_FILENAME;
}

const readActiveVectorGeneration = Effect.fn('vectorIndex.readActive')(function* (
  home: string,
  manifest: LocalModelManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = vectorDatabasePath(path, home, manifest.id);
  if (!(yield* fs.exists(databasePath))) return undefined;
  return yield* useVectorDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* validateVectorDatabase(sql);
      const active = yield* selectActiveGeneration(sql);
      if (active && !generationIsCompatible(active, manifest)) {
        return yield* VectorIndexOperationError.make({
          message: `Vector index ${manifest.id}/${active.generation} is incompatible.`,
        });
      }
      return active;
    }),
  );
});

const validateVectorGenerationRows = Effect.fn('vectorIndex.validateGenerationRows')(function* (
  home: string,
  manifest: LocalModelManifest,
  generation: string,
  dimensions: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = vectorDatabasePath(path, home, manifest.id);
  if (!(yield* fs.exists(databasePath))) {
    return yield* VectorIndexOperationError.make({message: `Vector database for ${manifest.id} is missing.`});
  }
  yield* useVectorDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* validateVectorDatabase(sql);
      let cursor = '';
      for (;;) {
        const rows = yield* sql.unsafe<VectorRow>(
          `SELECT chunk.chunk_id, chunk.uri, chunk.fingerprint, value.vector
           FROM vector_chunks AS chunk
           JOIN vector_values AS value ON value.id = chunk.vector_id
           WHERE chunk.generation = ? AND chunk.chunk_id > ?
           ORDER BY chunk.chunk_id
           LIMIT ?`,
          [generation, cursor, VECTOR_INDEX_PAGE_SIZE],
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          const cause = encodedVectorValidationFailure(row.vector, dimensions);
          if (cause !== undefined) {
            return yield* VectorIndexOperationError.make({
              message: `Vector chunk ${row.chunk_id} is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`,
            });
          }
        }
        cursor = rows.at(-1)!.chunk_id;
        if (rows.length < VECTOR_INDEX_PAGE_SIZE) break;
      }
    }),
  );
});

const initializeVectorDatabaseWithRecovery = Effect.fn('vectorIndex.initializeWithRecovery')(function* (
  fs: FileSystem.FileSystem,
  databasePath: string,
) {
  const initialize = useVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      yield* initializeVectorDatabase(yield* SqlClient.SqlClient);
    }),
  );
  yield* initialize.pipe(
    Effect.catchCause(() =>
      removeVectorDatabaseFiles(fs, databasePath).pipe(
        Effect.andThen(
          useVectorDatabase(
            databasePath,
            Effect.gen(function* () {
              yield* initializeVectorDatabase(yield* SqlClient.SqlClient);
            }),
          ),
        ),
      ),
    ),
  );
});

const initializeVectorDatabase = Effect.fn('vectorIndex.initializeDatabase')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
  const versions = yield* sql.unsafe<{readonly user_version: number}>('PRAGMA user_version');
  const version = Number(versions[0]?.user_version ?? 0);
  if (version !== 0 && version !== VECTOR_INDEX_DATABASE_VERSION) {
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_pointer');
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_aliases');
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_chunks');
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_generations');
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_values');
  }
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_generations (
      generation TEXT PRIMARY KEY,
      job_id TEXT UNIQUE NOT NULL,
      corpus_generation TEXT,
      model_id TEXT NOT NULL,
      model_sha256 TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK(dimensions > 0),
      embedding_recipe TEXT NOT NULL,
      chunker_version INTEGER NOT NULL CHECK(chunker_version > 0),
      normalized TEXT NOT NULL CHECK(normalized = 'l2'),
      chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
      state TEXT NOT NULL CHECK(state IN ('building', 'ready')),
      created_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_pointer (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation TEXT NOT NULL REFERENCES vector_generations(generation)
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_values (
      id INTEGER PRIMARY KEY,
      vector_key TEXT UNIQUE NOT NULL,
      vector BLOB NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_chunks (
      generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
      chunk_id TEXT NOT NULL,
      uri TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      project TEXT,
      approved_authoritative INTEGER NOT NULL CHECK(approved_authoritative IN (0, 1)),
      vector_id INTEGER NOT NULL REFERENCES vector_values(id),
      PRIMARY KEY (generation, chunk_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_aliases (
      generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
      uri TEXT NOT NULL,
      representative_uri TEXT NOT NULL,
      PRIMARY KEY (generation, uri)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS vector_chunks_by_value ON vector_chunks (vector_id)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS vector_chunks_by_project ON vector_chunks (generation, project, chunk_id)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS vector_chunks_by_authority ON vector_chunks (generation, approved_authoritative, project, chunk_id)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS vector_chunks_by_uri ON vector_chunks (generation, uri, approved_authoritative, project)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS vector_aliases_by_representative ON vector_aliases (generation, representative_uri, uri)',
  );
  yield* sql.unsafe(`PRAGMA user_version = ${VECTOR_INDEX_DATABASE_VERSION}`);
  yield* validateVectorDatabaseStructure(sql);
});

const validateVectorDatabase = Effect.fn('vectorIndex.validateDatabase')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  const versions = yield* sql.unsafe<{readonly user_version: number}>('PRAGMA user_version');
  const version = Number(versions[0]?.user_version ?? 0);
  if (version !== VECTOR_INDEX_DATABASE_VERSION) {
    return yield* VectorIndexOperationError.make({
      message: `Unsupported vector index schema ${version}; expected ${VECTOR_INDEX_DATABASE_VERSION}.`,
    });
  }
  yield* validateVectorDatabaseStructure(sql);
});

const validateVectorDatabaseStructure = Effect.fn('vectorIndex.validateDatabaseStructure')(function* (
  sql: SqlClient.SqlClient,
) {
  for (const [table, expected] of Object.entries(VECTOR_INDEX_SCHEMA_COLUMNS)) {
    const rows = yield* sql.unsafe<{readonly name: string}>(`PRAGMA table_info('${table}')`);
    const actual = rows.map(row => row.name);
    if (actual.length !== expected.length || actual.some((column, index) => column !== expected[index])) {
      return yield* VectorIndexOperationError.make({
        message: `Vector index table ${table} has invalid columns: ${actual.length > 0 ? actual.join(', ') : '(missing)'}.`,
      });
    }
  }
});

const selectActiveGeneration = Effect.fn('vectorIndex.selectActiveGeneration')(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql.unsafe<VectorGenerationRow>(
    `SELECT
       generation.*,
       (SELECT COUNT(*) FROM vector_chunks WHERE vector_chunks.generation = generation.generation)
         AS actual_chunk_count
     FROM vector_pointer AS pointer
     JOIN vector_generations AS generation ON generation.generation = pointer.generation
     WHERE pointer.singleton = 1 AND generation.state = 'ready'
     LIMIT 1`,
  );
  const active = rows[0];
  if (!active) return undefined;
  assertVectorGeneration(active);
  if (Number(active.actual_chunk_count) !== Number(active.chunk_count)) {
    return yield* VectorIndexOperationError.make({
      message: `Vector generation ${active.generation} contains ${active.actual_chunk_count}/${active.chunk_count} chunks.`,
    });
  }
  return active;
});

const selectGenerationByJob = Effect.fn('vectorIndex.selectGenerationByJob')(function* (
  sql: SqlClient.SqlClient,
  jobId: string,
) {
  const rows = yield* sql.unsafe<VectorGenerationRow>(
    `SELECT
       generation.*,
       (SELECT COUNT(*) FROM vector_chunks WHERE vector_chunks.generation = generation.generation)
         AS actual_chunk_count
     FROM vector_generations AS generation
     WHERE generation.job_id = ?
     LIMIT 1`,
    [jobId],
  );
  const generation = rows[0];
  if (generation) assertVectorGeneration(generation);
  return generation;
});

const prepareDesiredChunks = Effect.fn('vectorIndex.prepareDesiredChunks')(function* (
  sql: SqlClient.SqlClient,
  chunks: readonly DesiredVectorChunk[],
) {
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS desired_vector_chunks (
      chunk_id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      project TEXT,
      approved_authoritative INTEGER NOT NULL CHECK(approved_authoritative IN (0, 1)),
      vector_key TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('DELETE FROM desired_vector_chunks');
  for (let start = 0; start < chunks.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
    const batch = chunks.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
    yield* sql.unsafe(
      `INSERT INTO desired_vector_chunks (
         chunk_id,
         uri,
         fingerprint,
         project,
         approved_authoritative,
         vector_key
       ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      batch.flatMap(chunk => [
        chunk.id,
        chunk.uri,
        chunk.fingerprint,
        chunk.project,
        chunk.approvedAuthoritative,
        chunk.vectorKey,
      ]),
    );
  }
});

const replaceVectorAliases = Effect.fn('vectorIndex.replaceAliases')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  aliases: readonly {readonly representativeUri: string; readonly uri: string}[],
) {
  yield* sql`DELETE FROM vector_aliases WHERE generation = ${generation}`;
  for (let start = 0; start < aliases.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
    const batch = aliases.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
    yield* sql.unsafe(
      `INSERT INTO vector_aliases (generation, uri, representative_uri)
       VALUES ${batch.map(() => '(?, ?, ?)').join(', ')}`,
      batch.flatMap(alias => [generation, alias.uri, alias.representativeUri]),
    );
  }
});

const loadVectorAliasesForRepresentatives = Effect.fn('vectorIndex.loadAliasesForRepresentatives')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  representativeUris: readonly string[],
  eligibilityPolicy?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  const eligibility = recallEligibilityPredicate('chunk', eligibilityPolicy);
  const uriScope = recallUriScopePredicate('alias', allowedUriScopes);
  const aliases: VectorAliasRow[] = [];
  for (let start = 0; start < representativeUris.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
    const batch = representativeUris.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
    aliases.push(
      ...(yield* sql.unsafe<VectorAliasRow>(
        `SELECT alias.uri, alias.representative_uri
         FROM vector_aliases AS alias
         WHERE alias.generation = ?
           AND alias.representative_uri IN (${batch.map(() => '?').join(', ')})
           AND ${uriScope.sql}
           AND EXISTS (
             SELECT 1
             FROM vector_chunks AS chunk
             WHERE chunk.generation = alias.generation
               AND chunk.uri = alias.representative_uri
               AND ${eligibility.sql}
           )
         ORDER BY alias.representative_uri, alias.uri`,
        [generation, ...batch, ...uriScope.params, ...eligibility.params],
      )),
    );
  }
  return aliases;
});

function vectorChunkSelectionPredicate(
  eligibilityPolicy: RecallEligibilityPolicy | undefined,
  allowedUriScopes: readonly string[] | undefined,
): RecallSqlPredicate {
  const eligibility = recallEligibilityPredicate('chunk', eligibilityPolicy);
  const directUriScope = recallUriScopePredicate('chunk', allowedUriScopes);
  if (!directUriScope.restricted) return combineRecallSqlPredicates(eligibility, directUriScope);

  const aliasUriScope = recallUriScopePredicate('scope_alias', allowedUriScopes);
  return combineRecallSqlPredicates(eligibility, {
    params: [...directUriScope.params, ...aliasUriScope.params],
    restricted: true,
    sql: `(${directUriScope.sql} OR EXISTS (
      SELECT 1
      FROM vector_aliases AS scope_alias
      WHERE scope_alias.generation = chunk.generation
        AND scope_alias.representative_uri = chunk.uri
        AND ${aliasUriScope.sql}
    ))`,
  });
}

const removeUndesiredVectorRows = Effect.fn('vectorIndex.removeUndesiredRows')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
) {
  yield* sql.unsafe(
    `DELETE FROM vector_chunks
     WHERE generation = ?
       AND NOT EXISTS (
         SELECT 1
         FROM desired_vector_chunks AS desired
         WHERE desired.chunk_id = vector_chunks.chunk_id
           AND desired.uri = vector_chunks.uri
           AND desired.fingerprint = vector_chunks.fingerprint
           AND desired.project IS vector_chunks.project
           AND desired.approved_authoritative = vector_chunks.approved_authoritative
       )`,
    [generation],
  );
});

const mapReusableVectorRows = Effect.fn('vectorIndex.mapReusableRows')(function* (
  sql: SqlClient.SqlClient,
  buildingGeneration: string,
) {
  yield* sql.unsafe(
    `INSERT OR IGNORE INTO vector_chunks (
       generation,
       chunk_id,
       uri,
       fingerprint,
       project,
       approved_authoritative,
       vector_id
     )
     SELECT
       ?,
       desired.chunk_id,
       desired.uri,
       desired.fingerprint,
       desired.project,
       desired.approved_authoritative,
       value.id
     FROM desired_vector_chunks AS desired
     JOIN vector_values AS value ON value.vector_key = desired.vector_key`,
    [buildingGeneration],
  );
});

const removeInvalidVectorRows = Effect.fn('vectorIndex.removeInvalidRows')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  dimensions: number,
) {
  let cursor = '';
  for (;;) {
    const rows = yield* sql.unsafe<VectorRow>(
      `SELECT chunk.chunk_id, chunk.uri, chunk.fingerprint, value.vector
       FROM vector_chunks AS chunk
       JOIN vector_values AS value ON value.id = chunk.vector_id
       WHERE chunk.generation = ? AND chunk.chunk_id > ?
       ORDER BY chunk.chunk_id
       LIMIT ?`,
      [generation, cursor, VECTOR_INDEX_PAGE_SIZE],
    );
    if (rows.length === 0) break;
    const invalid: string[] = [];
    for (const row of rows) {
      if (encodedVectorValidationFailure(row.vector, dimensions) !== undefined) invalid.push(row.chunk_id);
    }
    if (invalid.length > 0) {
      yield* sql.unsafe(
        `DELETE FROM vector_chunks
         WHERE generation = ? AND chunk_id IN (${invalid.map(() => '?').join(', ')})`,
        [generation, ...invalid],
      );
    }
    cursor = rows.at(-1)!.chunk_id;
    if (rows.length < VECTOR_INDEX_PAGE_SIZE) break;
  }
});

const selectExistingChunkIds = Effect.fn('vectorIndex.selectExistingChunkIds')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  chunkIds: readonly string[],
) {
  if (chunkIds.length === 0) return new Set<string>();
  const rows = yield* sql.unsafe<{readonly chunk_id: string}>(
    `SELECT chunk_id
     FROM vector_chunks
     WHERE generation = ? AND chunk_id IN (${chunkIds.map(() => '?').join(', ')})`,
    [generation, ...chunkIds],
  );
  return new Set(rows.map(row => row.chunk_id));
});

function insertVectorRows(sql: SqlClient.SqlClient, rows: readonly VectorInsertRow[]) {
  return Effect.gen(function* () {
    for (let start = 0; start < rows.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
      const batch = rows.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* insertVectorValues(
            sql,
            batch.map(row => [row.vectorKey, row.vector] as const),
          );
          const values = yield* sql.unsafe<{readonly id: number; readonly vector_key: string}>(
            `SELECT id, vector_key
             FROM vector_values
             WHERE vector_key IN (${batch.map(() => '?').join(', ')})`,
            batch.map(row => row.vectorKey),
          );
          const idByKey = new Map(values.map(value => [value.vector_key, Number(value.id)]));
          const mappings = batch.map(row => {
            const vectorId = idByKey.get(row.vectorKey);
            if (vectorId === undefined) {
              throw VectorIndexOperationError.make({message: `Could not resolve stored vector ${row.vectorKey}.`});
            }
            return [
              row.generation,
              row.chunkId,
              row.uri,
              row.fingerprint,
              row.project,
              row.approvedAuthoritative,
              vectorId,
            ] as const;
          });
          yield* sql.unsafe(
            `INSERT OR REPLACE INTO vector_chunks (
               generation,
               chunk_id,
               uri,
               fingerprint,
               project,
               approved_authoritative,
               vector_id
             ) VALUES ${mappings.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
            mappings.flat(),
          );
        }),
      );
    }
  });
}

function insertVectorValues(sql: SqlClient.SqlClient, rows: readonly (readonly [string, Uint8Array])[]) {
  return Effect.gen(function* () {
    for (let start = 0; start < rows.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
      const batch = rows.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
      yield* sql.unsafe(
        `INSERT INTO vector_values (vector_key, vector)
         VALUES ${batch.map(() => '(?, ?)').join(', ')}
         ON CONFLICT(vector_key) DO UPDATE SET vector = excluded.vector`,
        batch.flat(),
      );
    }
  });
}

const pruneUnreferencedVectorValues = Effect.fn('vectorIndex.pruneUnreferencedValues')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(
    `DELETE FROM vector_values
     WHERE NOT EXISTS (
       SELECT 1
       FROM vector_chunks
       WHERE vector_chunks.vector_id = vector_values.id
     )`,
  );
});

const countVectorRows = Effect.fn('vectorIndex.countRows')(function* (sql: SqlClient.SqlClient, generation: string) {
  const rows = yield* sql.unsafe<{readonly count: number}>(
    'SELECT COUNT(*) AS count FROM vector_chunks WHERE generation = ?',
    [generation],
  );
  return Number(rows[0]?.count ?? 0);
});

const activateVectorGenerationFenced = Effect.fn('vectorIndex.activateGenerationFenced')(function* <R = never>(
  sql: SqlClient.SqlClient,
  generation: string,
  chunkCount: number,
  corpusGeneration: string | undefined,
  manifest: LocalModelManifest,
  options: VectorCorpusGenerationOptions<R>,
) {
  yield* verifyCurrentCorpusGeneration(manifest, options);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        UPDATE vector_generations
        SET
          state = 'ready',
          chunk_count = ${chunkCount},
          corpus_generation = ${corpusGeneration ?? null}
        WHERE generation = ${generation}
      `;
      // Keep the vector write transaction open across the last pre-commit
      // observation. The post-commit check below handles the remaining
      // cross-database gap without ever pruning the previous generation first.
      yield* verifyCurrentCorpusGeneration(manifest, options);
      yield* sql`
        INSERT INTO vector_pointer (singleton, generation)
        VALUES (1, ${generation})
        ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation
      `;
    }),
  );
  const postActivationFence = yield* verifyCurrentCorpusGeneration(manifest, options).pipe(Effect.result);
  if (Result.isFailure(postActivationFence)) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe('DELETE FROM vector_pointer WHERE singleton = 1 AND generation = ?', [generation]);
        yield* sql`UPDATE vector_generations SET state = 'building' WHERE generation = ${generation}`;
      }),
    );
    return yield* Effect.fail(postActivationFence.failure);
  }
});

const pruneVectorGenerations = Effect.fn('vectorIndex.pruneGenerations')(function* (
  sql: SqlClient.SqlClient,
  activeGeneration: string,
) {
  yield* sql`DELETE FROM vector_generations WHERE state = 'building'`;
  yield* sql.unsafe('DELETE FROM vector_generations WHERE state = ? AND generation <> ?', ['ready', activeGeneration]);
  yield* pruneUnreferencedVectorValues(sql);
});

function vectorStatus(
  generation: VectorGenerationRow,
  modelId: string,
  chunkCount: number,
  embeddedChunkCount: number,
  reusedChunkCount: number,
): VectorIndexStatus {
  return {
    chunkCount,
    createdAt: generation.created_at,
    dimensions: generation.dimensions,
    embeddedChunkCount,
    generation: generation.generation,
    modelId,
    ready: true,
    reusedChunkCount,
  };
}

function encodeVector(vector: readonly number[], dimensions: number): Uint8Array {
  if (vector.length !== dimensions) {
    throw VectorIndexOperationError.make({message: `Vector has ${vector.length} dimensions; expected ${dimensions}.`});
  }
  const bytes = new Uint8Array(dimensions * 4);
  const view = new DataView(bytes.buffer);
  let squaredMagnitude = 0;
  for (const [index, component] of vector.entries()) {
    if (!Number.isFinite(component))
      throw VectorIndexOperationError.make({message: 'Vector contains a non-finite component.'});
    squaredMagnitude += component * component;
    view.setFloat32(index * 4, component, true);
  }
  if (Math.abs(Math.sqrt(squaredMagnitude) - 1) > 0.001) {
    throw VectorIndexOperationError.make({message: 'Vector is not L2-normalized.'});
  }
  return bytes;
}

function validateEncodedVector(value: unknown, dimensions: number): void {
  const bytes = bytesFromSqlBlob(value);
  if (bytes.byteLength !== dimensions * 4) {
    throw VectorIndexOperationError.make({
      message: `Stored vector has ${bytes.byteLength} bytes; expected ${dimensions * 4}.`,
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let squaredMagnitude = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const component = view.getFloat32(index * 4, true);
    if (!Number.isFinite(component)) {
      throw VectorIndexOperationError.make({message: 'Stored vector contains a non-finite component.'});
    }
    squaredMagnitude += component * component;
  }
  if (Math.abs(Math.sqrt(squaredMagnitude) - 1) > 0.002) {
    throw VectorIndexOperationError.make({message: 'Stored vector is not L2-normalized.'});
  }
}

function encodedVectorValidationFailure(value: unknown, dimensions: number): unknown | undefined {
  try {
    validateEncodedVector(value, dimensions);
    return undefined;
  } catch (cause) {
    return cause;
  }
}

function bytesFromSqlBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw VectorIndexOperationError.make({message: 'Stored vector is not a binary SQLite value.'});
}

function mergeSemanticMatches(
  left: readonly SemanticChunkMatch[],
  right: readonly SemanticChunkMatch[],
  limit: number,
): readonly SemanticChunkMatch[] {
  return [...left, ...right].sort(compareVectorMatches).slice(0, limit);
}

function searchEncodedVectorRows(
  normalizedQuery: readonly number[],
  rows: readonly VectorRow[],
  dimensions: number,
  limit: number,
): readonly SemanticChunkMatch[] {
  if (normalizedQuery.length !== dimensions) {
    throw VectorIndexOperationError.make({
      message: `Query vector has ${normalizedQuery.length} dimensions; expected ${dimensions}.`,
    });
  }
  const matches: SemanticChunkMatch[] = [];
  for (const row of rows) {
    const bytes = bytesFromSqlBlob(row.vector);
    if (bytes.byteLength !== dimensions * 4) {
      throw VectorIndexOperationError.make({
        message: `Stored vector ${row.chunk_id} has ${bytes.byteLength} bytes; expected ${dimensions * 4}.`,
      });
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let score = 0;
    let squaredMagnitude = 0;
    for (let index = 0; index < dimensions; index += 1) {
      const component = view.getFloat32(index * 4, true);
      if (!Number.isFinite(component)) {
        throw VectorIndexOperationError.make({
          message: `Stored vector ${row.chunk_id} contains a non-finite component.`,
        });
      }
      squaredMagnitude += component * component;
      score += normalizedQuery[index] * component;
    }
    if (Math.abs(Math.sqrt(squaredMagnitude) - 1) > 0.002) {
      throw VectorIndexOperationError.make({message: `Stored vector ${row.chunk_id} is not L2-normalized.`});
    }
    matches.push({
      id: row.chunk_id,
      score: Math.max(-1, Math.min(1, score)),
      uri: row.uri,
    });
  }
  return matches.sort(compareVectorMatches).slice(0, Math.min(limit, matches.length));
}

function compareVectorMatches(left: VectorSearchResult, right: VectorSearchResult): number {
  return right.score - left.score || compareCodeUnits(left.id, right.id);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function generationMatchesCorpus(
  generation: VectorGenerationRow,
  manifest: LocalModelManifest,
  corpusGeneration: string,
): boolean {
  return generation.corpus_generation === corpusGeneration && generationIsCompatible(generation, manifest);
}

function generationIsCompatible(generation: VectorGenerationRow, manifest: LocalModelManifest): boolean {
  return (
    generation.model_id === manifest.id &&
    generation.model_sha256 === manifest.sha256 &&
    generation.dimensions === manifest.dimensions &&
    generation.embedding_recipe === embeddingRecipe(manifest) &&
    generation.chunker_version === RECALL_CHUNKER_VERSION &&
    generation.normalized === 'l2'
  );
}

function vectorChunkMappings(candidates: readonly RecallCandidate[]): readonly VectorChunkMapping[] {
  return candidates.flatMap(candidate => {
    const project = normalizeRecallProject(candidate.fields?.project) ?? null;
    const approvedAuthoritative = recallApprovedAuthoritative(candidate.authority, candidate.trust) ? 1 : 0;
    return chunkRecallDocument(candidate.uri, candidate.text).map(chunk => ({
      ...chunk,
      approvedAuthoritative,
      project,
    }));
  });
}

function vectorAliasMappings(candidates: readonly RecallCandidate[]): readonly VectorAliasMapping[] {
  return candidates
    .flatMap(candidate =>
      [candidate.uri, ...(candidate.equivalentUris ?? [])].map(uri => ({
        representativeUri: candidate.uri,
        uri,
      })),
    )
    .sort(
      (left, right) =>
        compareCodeUnits(left.uri, right.uri) || compareCodeUnits(left.representativeUri, right.representativeUri),
    );
}

function vectorJobId(
  manifest: LocalModelManifest,
  chunks: readonly VectorChunkMapping[],
  aliases: readonly VectorAliasMapping[],
  corpusGeneration: string | undefined,
) {
  const identityChunks = chunks
    .map(chunk => ({
      approvedAuthoritative: chunk.approvedAuthoritative,
      fingerprint: chunk.fingerprint,
      id: chunk.id,
      project: chunk.project,
      uri: chunk.uri,
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id) || compareCodeUnits(left.uri, right.uri));
  return sha256Hex(
    JSON.stringify({
      aliases,
      chunkerVersion: RECALL_CHUNKER_VERSION,
      chunks: identityChunks,
      corpusGeneration: corpusGeneration ?? null,
      dimensions: manifest.dimensions,
      modelSha256: manifest.sha256,
      promptPrefix: manifest.promptPrefixes?.document ?? '',
    }),
  );
}

function embeddingRecipe(manifest: LocalModelManifest): string {
  // Native backend/offload policy is intentionally excluded: the frozen Darwin
  // compatibility fixture verifies that it preserves this embedding space.
  return sha256HexSync(
    [
      'threadnote-recall-embedding-v1',
      manifest.sha256,
      String(manifest.dimensions ?? 0),
      manifest.promptPrefixes?.document ?? '',
      'l2',
    ].join('\0'),
  );
}

function vectorKeyForChunk(recipe: string, chunk: RecallChunk): string {
  return sha256HexSync(`${recipe}\0${chunk.fingerprint}`);
}

function assertVectorGeneration(generation: VectorGenerationRow): void {
  if (
    !generation.generation ||
    !/^[0-9]+-[a-f0-9-]+$/.test(generation.generation) ||
    !/^[0-9a-f]{64}$/.test(generation.job_id) ||
    !generation.model_id ||
    !/^[0-9a-f]{64}$/.test(generation.model_sha256) ||
    !/^[0-9a-f]{64}$/.test(generation.embedding_recipe) ||
    !Number.isInteger(generation.dimensions) ||
    generation.dimensions <= 0 ||
    !Number.isInteger(generation.chunker_version) ||
    generation.chunker_version <= 0 ||
    generation.normalized !== 'l2' ||
    !Number.isInteger(Number(generation.chunk_count)) ||
    Number(generation.chunk_count) < 0 ||
    !Number.isInteger(Number(generation.actual_chunk_count)) ||
    Number(generation.actual_chunk_count) < 0 ||
    !['building', 'ready'].includes(generation.state) ||
    !generation.created_at
  ) {
    throw VectorIndexOperationError.make({
      message: `Vector generation ${generation.generation || '<unknown>'} metadata is invalid.`,
    });
  }
}

function vectorDatabasePath(path: Path.Path, home: string, modelId: string): string {
  return path.join(vectorModelRoot(path, home, modelId), VECTOR_INDEX_DATABASE_FILENAME);
}

function vectorModelRoot(path: Path.Path, home: string, modelId: string): string {
  return path.join(home, 'indexes', 'vectors', modelId);
}

function useVectorDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(SqliteClient.layer({filename: databasePath})).pipe(
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
  );
}

function useVectorDatabaseReadOnly<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        create: false,
        disableWAL: true,
        filename: databasePath,
        readonly: true,
        readwrite: false,
      }),
    ).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

function removeVectorDatabaseFiles(fs: FileSystem.FileSystem, databasePath: string): Effect.Effect<void, never> {
  return Effect.forEach(
    [databasePath, `${databasePath}-shm`, `${databasePath}-wal`],
    candidate => fs.remove(candidate, {force: true}).pipe(Effect.ignore),
    {discard: true},
  ).pipe(Effect.asVoid);
}

const removeLegacyVectorSidecars = Effect.fn('vectorIndex.removeLegacySidecars')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  for (const legacy of ['active.json', 'generations', 'staging']) {
    yield* fs.remove(path.join(root, legacy), {force: true, recursive: true}).pipe(Effect.ignore);
  }
  for (let version = 1; version < VECTOR_INDEX_DATABASE_VERSION; version += 1) {
    yield* removeVectorDatabaseFiles(fs, path.join(root, `vectors-v${version}.sqlite`));
  }
});

function withVectorIndexLock<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  modelId: string,
  effect: () => Effect.Effect<A, E, R>,
) {
  return withExclusiveFileLock(
    fs,
    path.join(home, 'locks', 'indexes', 'vectors', `${modelId}.lock`),
    {
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 100,
      staleAfterMilliseconds: 60_000,
      waitTimeoutMilliseconds: 120_000,
    },
    Effect.suspend(effect),
  );
}

export function chunksForRecallCandidates(candidates: readonly RecallCandidate[]): readonly RecallChunk[] {
  return candidates.flatMap(candidate => chunkRecallDocument(candidate.uri, candidate.text));
}
