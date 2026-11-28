import {Array as EffectArray, Effect, FileSystem, Option, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {recallVectorStorage, vectorReadExpectation} from '../vector-index.js';
import type {RecallVectorGenerationMetadata} from '../vector/generation-compatibility.js';
import {
  decideRecallMaskedRead,
  readRecallVectorGroupMembers,
  recallMaskedReadCompatible,
} from '../vector/masked-read.js';
import {preparationChanged, withRecallVectorWrite} from '../vector/storage.js';
import type {RecallEmbeddingScope} from './demand.js';
import {
  assertRecallVectorTarget,
  type RecallVectorBuildPlan,
  type RecallVectorSource,
  type RecallVectorTarget,
} from './vector-preparation.js';

/**
 * Delta build of a vector generation. A target with a ready compatible base copies the base rows of
 * unchanged memories and prepares only the changed set, by the same rule the masked read uses.
 */

/** Largest changed set, after group and identity extension, that a delta build accepts. */
export const RECALL_DELTA_BUILD_MAX_CHANGED = 1024;
const COPY_PAGE_SIZE = 100;

/**
 * Plans the next target: a delta from the served (else newest) ready generation that the masked read would
 * accept for this authorization key, or a full walk when there is none or its change set is unknown or too big.
 */
export const planRecallVectorDelta = Effect.fn('recall.planVectorDelta')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  cap: number = RECALL_DELTA_BUILD_MAX_CHANGED,
) {
  const full: RecallVectorBuildPlan = {kind: 'full'};
  const expected = vectorReadExpectation(manifest);
  const path = yield* Path.Path;
  const filename = recallVectorStorage.databasePath(path, config.agentContextHome, manifest.id);
  if (!(yield* (yield* FileSystem.FileSystem).exists(filename))) return full;
  const readyGenerations = yield* recallVectorStorage.read(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<RecallVectorGenerationMetadata & {readonly chunk_count: number; readonly actual: number}>`
        SELECT g.*, (SELECT COUNT(*) FROM vector_chunks c WHERE c.generation = g.generation) AS actual
        FROM vector_generations g WHERE g.state = 'ready'
        ORDER BY EXISTS (SELECT 1 FROM vector_pointer p WHERE p.generation = g.generation) DESC,
          g.created_at DESC, g.generation DESC`;
    }),
  );
  const base = Option.getOrUndefined(
    EffectArray.findFirst(
      readyGenerations,
      generation =>
        Number(generation.actual) === Number(generation.chunk_count) &&
        recallMaskedReadCompatible(generation, expected, source.authorizationKey),
    ),
  );
  if (base === undefined || base.corpus_generation === null) return full;
  const decision = yield* decideRecallMaskedRead({
    generation: base,
    expected,
    authorizationKey: source.authorizationKey,
    cap,
    readLexicalInputs: (fromGeneration, limit) => source.readMaskLexicalInputs(fromGeneration, limit),
    readGroupMembers: (seeds, limit) =>
      readRecallVectorGroupMembers(
        recallVectorStorage,
        config.agentContextHome,
        manifest.id,
        base.generation,
        seeds,
        limit,
      ),
  });
  if (!decision.servable || decision.mask.contentGeneration !== source.generation) return full;
  const delta: RecallVectorBuildPlan = {
    kind: 'delta',
    base: {generation: base.generation, job_id: base.job_id},
    changed: decision.mask.uris,
  };
  return delta;
});

/** The durable changed set of a delta target. */
export const readRecallVectorDeltaUris = Effect.fn('recall.readVectorDeltaUris')(function* (
  filename: string,
  generation: string,
) {
  const rows = yield* recallVectorStorage.read(
    filename,
    Effect.gen(function* () {
      return yield* (yield* SqlClient.SqlClient)<{readonly uri: string}>`
        SELECT uri FROM idle_recall_delta_uris WHERE generation = ${generation}`;
    }),
  );
  const uris: ReadonlySet<string> = new Set(EffectArray.map(rows, row => row.uri));
  return uris;
});

/**
 * One bounded page of base rows for unchanged memories: chunk rows first, then alias rows. Rows keep the
 * base `vector_id`; no vector blob or chunk text is copied. Copying precedes preparation, so the largest key
 * the target holds is the page cursor. A base that is gone, or a copy that ends off `copy_expected` or
 * `alias_expected`, resets the target to a full walk.
 */
export const copyRecallVectorDeltaRows = Effect.fn('recall.copyVectorDeltaRows')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  target: RecallVectorTarget,
) {
  const base = target.base_generation;
  const stage = target.copy_stage;
  if (base === null || (stage !== 'chunks' && stage !== 'aliases')) return yield* preparationChanged();
  yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertRecallVectorTarget(target);
      yield* source.fence;
      const ready = yield* sql`SELECT 1 FROM vector_generations WHERE generation = ${base} AND state = 'ready'`;
      if (ready.length !== 1) return yield* resetRecallVectorDeltaToFull(target.generation);
      const [table, key, columns] =
        stage === 'chunks'
          ? ([
              'vector_chunks',
              'chunk_id',
              'chunk_id,uri,fingerprint,project,approved_authoritative,vector_id',
            ] as const)
          : (['vector_aliases', 'uri', 'uri,representative_uri'] as const);
      const copied = yield* sql.unsafe(
        `INSERT INTO ${table} (generation,${columns}) SELECT ?,${columns} FROM ${table}
         WHERE generation = ? AND ${key} > COALESCE((SELECT MAX(${key}) FROM ${table} WHERE generation = ?), '')
           AND uri NOT IN (SELECT uri FROM idle_recall_delta_uris WHERE generation = ?)
         ORDER BY ${key} LIMIT ${COPY_PAGE_SIZE} RETURNING ${key}`,
        [target.generation, base, target.generation, target.generation],
      );
      const finished = copied.length < COPY_PAGE_SIZE;
      const copiedChunks = target.copied_chunks + (stage === 'chunks' ? copied.length : 0);
      if (finished && stage === 'chunks' && copiedChunks !== target.copy_expected)
        return yield* resetRecallVectorDeltaToFull(target.generation);
      if (finished && stage === 'aliases') {
        // Preparation has not written aliases yet, so every alias row of the target was copied.
        const aliases = yield* sql<{readonly count: number}>`
          SELECT COUNT(*) AS count FROM vector_aliases WHERE generation = ${target.generation}`;
        if (aliases[0]?.count !== target.alias_expected) return yield* resetRecallVectorDeltaToFull(target.generation);
      }
      const nextStage = !finished ? stage : stage === 'chunks' ? 'aliases' : 'done';
      yield* sql`UPDATE idle_recall_targets SET copy_stage = ${nextStage}, copied_chunks = ${copiedChunks}
        WHERE generation = ${target.generation}`;
    }),
  );
});

/**
 * Marks a delta for a full walk and clears its delta inputs (the changed set is at most the delta cap). Later
 * steps purge its copied and prepared rows in bounded batches, so the writer never deletes a corpus at once.
 */
const resetRecallVectorDeltaToFull = Effect.fn('recall.resetVectorDeltaToFull')(function* (generation: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM idle_recall_delta_uris WHERE generation = ${generation}`;
  yield* sql`UPDATE idle_recall_targets SET purging = 1, base_generation = NULL, copy_stage = NULL,
    copy_expected = 0, alias_expected = 0, copied_chunks = 0 WHERE generation = ${generation}`;
});

/** Authorizes every external URI of the new corpus from lexical metadata pages, copied rows included. */
export const authorizeRecallVectorCorpus = Effect.fn('recall.authorizeVectorCorpus')(function* (
  source: RecallVectorSource,
) {
  let after: string | undefined;
  for (;;) {
    const page = yield* source.readMetadataPage(after);
    yield* source.authorize(page.candidates);
    if (page.done) return;
    after = page.after;
  }
});
