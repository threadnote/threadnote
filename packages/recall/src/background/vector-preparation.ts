import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import {Clock, Crypto, DateTime, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {RECALL_CHUNKER_VERSION} from '../chunker.js';
import type {RecallCandidate} from '../rank.js';
import type {RecallEmbeddingScope} from './demand.js';
import {recallEmbeddingDemandKey} from './demand.js';
import {openRecallVectorPreparationSource} from '../index/vector-preparation-source.js';
import {recallVectorStorage} from '../vector-index.js';
import {preparationChanged, withRecallVectorWrite} from '../vector/storage.js';

export interface RecallPreparedChunk {
  readonly chunk_id: string;
  readonly uri: string;
  readonly fingerprint: string;
  readonly project: string | null;
  readonly approved_authoritative: number;
  readonly vector_key: string;
  readonly content: string;
  readonly payload_hash: string;
}
export function recallPreparedChunkDigest(chunk: Omit<RecallPreparedChunk, 'payload_hash'>): string {
  return sha256HexSync(
    JSON.stringify([
      chunk.chunk_id,
      chunk.uri,
      chunk.fingerprint,
      chunk.project,
      chunk.approved_authoritative,
      chunk.vector_key,
      chunk.content,
    ]),
  );
}

export interface RecallVectorTarget {
  readonly generation: string;
  readonly phase: 'metadata' | 'resolve' | 'hydrate' | 'embed' | 'retire' | 'ready';
  readonly source_after: string | null;
  readonly cursor: number;
  readonly chunk_cursor: number;
  readonly alias_cursor: number;
}
export type RecallVectorSource = Effect.Success<ReturnType<typeof openRecallVectorPreparationSource>>;
export const assertRecallVectorTarget = Effect.fn('recall.assertVectorTarget')(function* (target: RecallVectorTarget) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql<RecallVectorTarget>`SELECT * FROM idle_recall_targets WHERE generation = ${target.generation}`;
  const current = rows[0];
  if (
    !current ||
    current.phase !== target.phase ||
    current.cursor !== target.cursor ||
    current.source_after !== target.source_after ||
    current.chunk_cursor !== target.chunk_cursor ||
    current.alias_cursor !== target.alias_cursor
  )
    return yield* preparationChanged();
});

export const recallVectorTarget = Effect.fn('recall.vectorTarget')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
) {
  const job = sha256HexSync(
    JSON.stringify([
      'idle-recall-v1',
      recallEmbeddingDemandKey(config),
      source.generation,
      source.authorizationKey,
      manifest.id,
      recallVectorStorage.recipe(manifest),
      RECALL_CHUNKER_VERSION,
    ]),
  );
  return yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const existing =
        yield* sql<RecallVectorTarget>`SELECT t.* FROM idle_recall_targets t JOIN vector_generations g USING(generation) WHERE g.job_id = ${job}`;
      if (existing[0]) return existing[0];
      const generation = `${yield* Clock.currentTimeMillis}-${EffectString.slice(0, 8)(yield* (yield* Crypto.Crypto).randomUUIDv4())}`;
      yield* sql`INSERT INTO vector_generations (generation,job_id,corpus_generation,model_id,model_sha256,dimensions,embedding_recipe,chunker_version,normalized,chunk_count,state,created_at,scope_mapping_version)
      VALUES (${generation},${job},${source.generation},${manifest.id},${manifest.sha256},${manifest.dimensions},${recallVectorStorage.recipe(manifest)},${RECALL_CHUNKER_VERSION},'l2',0,'building',${DateTime.formatIso(yield* DateTime.now)},1)`;
      yield* sql`INSERT INTO idle_recall_targets (generation,phase) VALUES (${generation},'metadata')`;
      return {generation, phase: 'metadata' as const, source_after: null, cursor: 0, chunk_cursor: 0, alias_cursor: 0};
    }),
  );
});

export const prepareRecallVectorMetadata = Effect.fn('recall.prepareVectorMetadata')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  target: RecallVectorTarget,
) {
  const page = yield* source.readMetadataPage(target.source_after ?? undefined);
  yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertRecallVectorTarget(target);
      yield* source.fence;
      for (const [index, candidate] of page.candidates.entries()) {
        const encoded = JSON.stringify(candidate);
        yield* sql`INSERT INTO idle_recall_metadata (generation,ordinal,candidate_json,candidate_sha256) VALUES (${target.generation},${target.cursor + index},${encoded},${sha256HexSync(encoded)})`;
      }
      yield* sql`UPDATE idle_recall_targets SET source_after = ${page.after ?? target.source_after}, cursor = ${page.done ? 0 : target.cursor + page.candidates.length}, phase = ${page.done ? 'resolve' : 'metadata'} WHERE generation = ${target.generation}`;
    }),
  );
});

// Optional accelerator for the one target owned by a worker process. Durable output
// cursor is authoritative; restart may recompute global metadata once, never bodies.
let resolvedTarget: {readonly generation: string; readonly candidates: readonly RecallCandidate[]} | undefined;
export function releaseResolvedRecallMetadata(generation: string): void {
  if (resolvedTarget?.generation === generation) resolvedTarget = undefined;
}
export const resolveRecallVectorMetadata = Effect.fn('recall.resolveVectorMetadata')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  target: RecallVectorTarget,
  readMetadata: Effect.Effect<readonly RecallCandidate[], unknown>,
) {
  if (resolvedTarget?.generation !== target.generation) {
    const candidates = yield* source.resolve(yield* readMetadata);
    resolvedTarget = {generation: target.generation, candidates};
  }
  const resolved = resolvedTarget.candidates;
  const page = resolved.slice(target.cursor, target.cursor + 100);
  yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertRecallVectorTarget(target);
      yield* source.fence;
      for (const [index, candidate] of page.entries()) {
        const encoded = JSON.stringify(candidate);
        yield* sql`INSERT INTO idle_recall_documents (generation,ordinal,candidate_json,candidate_sha256) VALUES (${target.generation},${target.cursor + index},${encoded},${sha256HexSync(encoded)})`;
      }
      const done = target.cursor + page.length >= resolved.length;
      yield* sql`UPDATE idle_recall_targets SET phase = ${done ? 'hydrate' : 'resolve'}, cursor = ${done ? 0 : target.cursor + page.length} WHERE generation = ${target.generation}`;
    }),
  );
});

let preparedDocument:
  | {
      readonly generation: string;
      readonly ordinal: number;
      readonly chunks: readonly RecallPreparedChunk[];
      readonly aliases: ReturnType<typeof recallVectorStorage.aliasMappings>;
    }
  | undefined;
export function releasePreparedRecallDocument(generation: string): void {
  if (preparedDocument?.generation === generation) preparedDocument = undefined;
}
export const hydrateRecallVectorDocuments = Effect.fn('recall.hydrateVectorDocuments')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  target: RecallVectorTarget,
  metadata: readonly RecallCandidate[],
) {
  const selected = metadata.slice(0, 1);
  yield* source.authorize(selected);
  if (preparedDocument?.generation !== target.generation || preparedDocument.ordinal !== target.cursor) {
    const documents = yield* source.hydrate(selected, {requireAll: true});
    if (
      documents.length !== selected.length ||
      !EffectArray.every(documents, (document, index) => document.uri === selected[index]?.uri)
    )
      return yield* preparationChanged();
    const recipe = recallVectorStorage.recipe(manifest);
    preparedDocument = {
      generation: target.generation,
      ordinal: target.cursor,
      chunks: EffectArray.map(recallVectorStorage.chunkMappings(documents), chunk => {
        const row = {
          chunk_id: chunk.id,
          uri: chunk.uri,
          fingerprint: chunk.fingerprint,
          project: chunk.project,
          approved_authoritative: chunk.approvedAuthoritative,
          vector_key: recallVectorStorage.key(recipe, chunk),
          content: chunk.content,
        };
        return {...row, payload_hash: recallPreparedChunkDigest(row)};
      }),
      aliases: recallVectorStorage.aliasMappings(documents),
    };
  }
  const chunks = preparedDocument.chunks.slice(target.chunk_cursor, target.chunk_cursor + 100);
  const aliases = preparedDocument.aliases.slice(target.alias_cursor, target.alias_cursor + 100 - chunks.length);
  const done =
    target.chunk_cursor + chunks.length === preparedDocument.chunks.length &&
    target.alias_cursor + aliases.length === preparedDocument.aliases.length;
  yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertRecallVectorTarget(target);
      yield* source.fence;
      for (const chunk of chunks)
        yield* sql`INSERT INTO idle_recall_chunks (generation,chunk_id,uri,fingerprint,project,approved_authoritative,vector_key,content,payload_hash)
      VALUES (${target.generation},${chunk.chunk_id},${chunk.uri},${chunk.fingerprint},${chunk.project},${chunk.approved_authoritative},${chunk.vector_key},${JSON.stringify(chunk.content)},${chunk.payload_hash})`;
      for (const alias of aliases)
        yield* sql`INSERT INTO vector_aliases (generation,uri,representative_uri) VALUES (${target.generation},${alias.uri},${alias.representativeUri})`;
      yield* sql`UPDATE idle_recall_targets SET cursor = ${target.cursor + (done ? selected.length : 0)},
      chunk_cursor = ${done ? 0 : target.chunk_cursor + chunks.length}, alias_cursor = ${done ? 0 : target.alias_cursor + aliases.length},
      phase = ${selected.length === 0 ? 'embed' : 'hydrate'}, source_after = NULL WHERE generation = ${target.generation}`;
    }),
  );
  if (done) preparedDocument = undefined;
});

/** Bounded retirement never cascades a corpus-sized generation under the writer. */
export const retireRecallVectorPreparation = Effect.fn('recall.retireVectorPreparation')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  target: RecallVectorTarget,
) {
  return yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertRecallVectorTarget(target);
      const pointer = yield* sql<{
        readonly generation: string;
      }>`SELECT generation FROM vector_pointer WHERE singleton = 1`;
      if (pointer[0]?.generation !== target.generation) return yield* preparationChanged();
      const obsolete = yield* sql<{readonly generation: string}>`SELECT g.generation FROM vector_generations g
      WHERE g.generation <> ${target.generation} AND (g.state = 'ready' OR EXISTS (SELECT 1 FROM idle_recall_targets t WHERE t.generation = g.generation))
      ORDER BY g.created_at, g.generation LIMIT 1`;
      const old = obsolete[0]?.generation;
      if (old) {
        for (const [table, key] of [
          ['idle_recall_metadata', 'ordinal'],
          ['idle_recall_documents', 'ordinal'],
          ['idle_recall_chunks', 'chunk_id'],
          ['vector_chunks', 'chunk_id'],
          ['vector_aliases', 'uri'],
        ] as const) {
          const removed = yield* sql.unsafe(
            `DELETE FROM ${table} WHERE generation = ? AND ${key} IN (SELECT ${key} FROM ${table} WHERE generation = ? LIMIT 100) RETURNING ${key}`,
            [old, old],
          );
          if (removed.length) return false;
        }
        yield* sql`DELETE FROM vector_generations WHERE generation = ${old}`;
        return false;
      }
      // Current read contracts need vector_chunks/aliases; preparation bodies do not.
      for (const [table, key] of [
        ['idle_recall_metadata', 'ordinal'],
        ['idle_recall_chunks', 'chunk_id'],
      ] as const) {
        const removed = yield* sql.unsafe(
          `DELETE FROM ${table} WHERE generation = ? AND ${key} IN (SELECT ${key} FROM ${table} WHERE generation = ? LIMIT 100) RETURNING ${key}`,
          [target.generation, target.generation],
        );
        if (removed.length) return false;
      }
      const removedValues = yield* sql.unsafe(`DELETE FROM vector_values WHERE id IN (
      SELECT v.id FROM vector_values v WHERE NOT EXISTS (SELECT 1 FROM vector_chunks c WHERE c.vector_id = v.id) LIMIT 100
    ) RETURNING id`);
      if (removedValues.length) return false;
      yield* sql`UPDATE idle_recall_targets SET phase = 'ready' WHERE generation = ${target.generation}`;
      return true;
    }),
  );
});
