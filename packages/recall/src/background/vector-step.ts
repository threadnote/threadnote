import {sha256HexSync} from '@threadnote/platform/sha256';
import {Array as EffectArray} from 'effect';
import {recallCandidateIsValid} from '../candidate_validation.js';
import {Clock, Effect, Exit, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {readModelSelection, selectedEmbeddingModelId} from '@threadnote/inference/models/selection';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {normalizeVector} from '@threadnote/inference/vector-search';
import {openRecallVectorPreparationSource} from '../index/vector-preparation-source.js';
export {RecallVectorSourceChanged} from '../index/vector-preparation-source.js';
import type {RecallCandidate} from '../rank.js';
import {recallVectorStorage, VectorIndexCorrupt} from '../vector-index.js';
import {
  recallVectorDeltaJobId,
  recallVectorPreparationIdentity,
  recallVectorPreparationJobId,
} from '../vector/preparation-identity.js';
import {
  confirmRecallVectorRefresh,
  preparationChanged,
  recallVectorRefreshRecord,
  recallVectorWriteTransaction,
  recordRecallVectorRefresh,
  removeRecallVectorRefresh,
  withRecallVectorWrite,
  withRecallVectorWriter,
} from '../vector/storage.js';
import type {RecallEmbeddingObservation, RecallEmbeddingScope} from './demand.js';
import {emitRecallDiagnostic} from '../diagnostics.js';
import {
  authorizeRecallVectorCorpus,
  copyRecallVectorDeltaRows,
  planRecallVectorDelta,
  readRecallVectorDeltaUris,
} from './vector-delta.js';
import {
  assertRecallVectorTarget,
  hydrateRecallVectorDocuments,
  prepareRecallVectorMetadata,
  purgeRecallVectorTarget,
  recallVectorTarget,
  resolveRecallVectorMetadata,
  releaseResolvedRecallMetadata,
  retireRecallVectorPreparation,
  recallPreparedChunkDigest,
  type RecallPreparedChunk,
} from './vector-preparation.js';

interface PreparedChunk extends RecallPreparedChunk {
  readonly existing_vector: Uint8Array | null;
}

/** One admitted unit: metadata page, document page, one inference input, or exact fenced activation. */
export const stepRecallVectorPreparation = Effect.fn('recall.stepVectorPreparation')(function* <R>(
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  stillDesired: Effect.Effect<boolean, unknown, R>,
) {
  if (manifest.role !== 'embedding' || !manifest.dimensions) return yield* preparationChanged();
  const verify = Effect.gen(function* () {
    const selection = yield* readModelSelection(config.agentContextHome);
    if (selectedEmbeddingModelId(selection, 'recall') !== manifest.id || !(yield* stillDesired))
      return yield* preparationChanged();
    const selected = yield* (yield* LocalModelCatalog).get(manifest.id);
    if (recallVectorStorage.recipe(selected) !== recallVectorStorage.recipe(manifest))
      return yield* preparationChanged();
  });
  yield* verify;
  const source = yield* openRecallVectorPreparationSource(config);
  const target = yield* recallVectorTarget(config, manifest, source, planRecallVectorDelta(config, manifest, source));
  const job = recallVectorPreparationJobId(
    recallVectorPreparationIdentity(
      source.generation,
      source.authorizationKey,
      manifest.id,
      recallVectorStorage.recipe(manifest),
    ),
  );
  const path = yield* Path.Path;
  const filename = recallVectorStorage.databasePath(path, config.agentContextHome, manifest.id);
  const documents = (offset: number, limit = 100) =>
    recallVectorStorage.read(
      filename,
      Effect.gen(function* () {
        const rows = yield* (yield* SqlClient.SqlClient)<{
          readonly candidate_json: string;
          readonly candidate_sha256: string;
        }>`
      SELECT candidate_json,candidate_sha256 FROM idle_recall_documents WHERE generation = ${target.generation} AND ordinal >= ${offset} ORDER BY ordinal LIMIT ${limit}`;
        return yield* Effect.forEach(rows, row => decodePreparedCandidate(row.candidate_json, row.candidate_sha256));
      }),
    );
  if (target.phase === 'metadata') {
    yield* prepareRecallVectorMetadata(config, manifest, source, target);
  } else if (target.phase === 'resolve') {
    const metadata = recallVectorStorage.read(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const candidates: RecallCandidate[] = [];
        let after = -1;
        for (;;) {
          const rows = yield* sql<{
            readonly candidate_json: string;
            readonly candidate_sha256: string;
            readonly ordinal: number;
          }>`SELECT ordinal, candidate_json,candidate_sha256 FROM idle_recall_metadata
            WHERE generation = ${target.generation} AND ordinal > ${after} ORDER BY ordinal LIMIT 100`;
          candidates.push(
            ...(yield* Effect.forEach(rows, row => decodePreparedCandidate(row.candidate_json, row.candidate_sha256))),
          );
          after = rows.at(-1)?.ordinal ?? after;
          if (rows.length < 100) break;
        }
        return candidates;
      }),
    );
    const changed =
      target.base_generation === null ? undefined : readRecallVectorDeltaUris(filename, target.generation);
    yield* resolveRecallVectorMetadata(config, manifest, source, target, metadata, changed);
  } else if (target.phase === 'hydrate') {
    releaseResolvedRecallMetadata(target.generation);
    // A delta copies the base rows of unchanged memories before it prepares the changed ones; a reset delta
    // purges its rows before it resolves again as a full walk.
    if (target.purging === 1) yield* purgeRecallVectorTarget(config, manifest, source, target);
    else if (target.copy_stage === 'chunks' || target.copy_stage === 'aliases')
      yield* copyRecallVectorDeltaRows(config, manifest, source, target);
    else yield* hydrateRecallVectorDocuments(config, manifest, source, target, yield* documents(target.cursor));
  } else if (target.phase === 'embed') {
    const pending = yield* recallVectorStorage.read(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<PreparedChunk>`SELECT p.*, v.vector AS existing_vector FROM idle_recall_chunks p
        LEFT JOIN vector_values v ON v.vector_key = p.vector_key
        WHERE p.generation = ${target.generation} AND p.chunk_id > ${target.source_after ?? ''}
        ORDER BY p.chunk_id LIMIT 100`;
      }),
    );
    if (pending.length) {
      const reusable = EffectArray.takeWhile(pending, chunk => chunk.existing_vector !== null);
      const chunks = yield* Effect.try({
        try: () => {
          const recipe = recallVectorStorage.recipe(manifest);
          return EffectArray.map(reusable.length ? reusable : pending.slice(0, 1), row => {
            // JSON preserves UTF-16 fragments at chunk boundaries through SQLite TEXT binding.
            const content: unknown = JSON.parse(row.content);
            if (typeof content !== 'string') throw preparationChanged();
            const chunk = {...row, content};
            if (
              sha256HexSync(content) !== chunk.fingerprint ||
              recallVectorStorage.key(recipe, chunk) !== chunk.vector_key ||
              recallPreparedChunkDigest(chunk) !== chunk.payload_hash
            )
              throw preparationChanged();
            return chunk;
          });
        },
        catch: preparationChanged,
      });
      const metadata = yield* recallVectorStorage.read(
        filename,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const candidates: RecallCandidate[] = [];
          for (const uri of new Set(EffectArray.map(chunks, chunk => chunk.uri))) {
            const rows = yield* sql<{
              readonly candidate_json: string;
              readonly candidate_sha256: string;
            }>`SELECT candidate_json,candidate_sha256 FROM idle_recall_documents
            WHERE generation = ${target.generation} AND json_extract(candidate_json, '$.uri') = ${uri}`;
            if (rows.length !== 1) return yield* preparationChanged();
            candidates.push(yield* decodePreparedCandidate(rows[0].candidate_json, rows[0].candidate_sha256));
          }
          return candidates;
        }),
      );
      yield* source.authorize(metadata);
      let inferred: Uint8Array | undefined;
      if (!reusable.length) {
        const installed = yield* (yield* LocalModelStore).verify(config.agentContextHome, manifest);
        const vectors = yield* (yield* LocalModelRuntime).embedMany({
          manifest,
          modelPath: installed.path,
          inputs: [(manifest.promptPrefixes?.document ?? '') + chunks[0].content],
        });
        if (vectors.length !== 1) return yield* preparationChanged();
        inferred = yield* Effect.try({
          try: () => recallVectorStorage.encode(normalizeVector(vectors[0]), manifest.dimensions!),
          catch: preparationChanged,
        });
      }
      const values = EffectArray.map(chunks, chunk => ({chunk, vector: chunk.existing_vector ?? inferred!}));
      yield* Effect.try({
        try: () => {
          for (const value of values) recallVectorStorage.validateVector(value.vector, manifest.dimensions!);
        },
        catch: preparationChanged,
      });
      yield* verify;
      yield* source.fence;
      yield* source.authorize(metadata);
      yield* withRecallVectorWrite(
        config,
        manifest,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* assertRecallVectorTarget(target);
          yield* source.fence;
          for (const {chunk, vector} of values) {
            yield* sql`INSERT OR IGNORE INTO vector_values (vector_key,vector) VALUES (${chunk.vector_key},${vector})`;
            yield* sql`INSERT INTO vector_chunks (generation,chunk_id,uri,fingerprint,project,approved_authoritative,vector_id)
            SELECT ${target.generation},${chunk.chunk_id},${chunk.uri},${chunk.fingerprint},${chunk.project},${chunk.approved_authoritative},id FROM vector_values WHERE vector_key = ${chunk.vector_key}`;
          }
          yield* sql`UPDATE idle_recall_targets SET source_after = ${chunks[chunks.length - 1].chunk_id},
            embedded_chunks = embedded_chunks + ${inferred === undefined ? 0 : 1} WHERE generation = ${target.generation}`;
        }),
      );
      return {
        state: 'pending' as const,
        phase: target.phase,
        inferred: inferred !== undefined,
        generation: target.generation,
      };
    }
    // Live external authorization is distinct from canonical corpus freshness.
    yield* authorizeRecallVectorCorpus(source);
    yield* verify;
    yield* source.fence;
    const activated = yield* withRecallVectorWriter(
      config,
      manifest,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Keep the writer lease across both transactions so foreground work cannot take the lock between them.
        return yield* Effect.acquireUseRelease(
          recallVectorWriteTransaction(
            sql,
            Effect.gen(function* () {
              yield* assertRecallVectorTarget(target);
              const [previous] = yield* sql<{
                readonly generation: string;
                readonly corpus_generation: string | null;
              }>`SELECT g.generation, g.corpus_generation FROM vector_pointer p
            JOIN vector_generations g USING(generation) WHERE p.singleton = 1`;
              const previousCorpus = previous?.corpus_generation ?? undefined;
              const changes =
                previousCorpus === undefined
                  ? undefined
                  : yield* source.readRefreshChanges(previousCorpus).pipe(Effect.orElseSucceed(() => undefined));
              // A delta adds copied chunks to the chunks it prepared. Only a build resumed from an older
              // binary lacks the count of inference steps; use the previous estimate for that build.
              const counts = yield* sql<{
                readonly prepared: number;
                readonly actual: number;
                readonly changed: number;
                readonly embedded: number;
                readonly created_at: string;
              }>`SELECT
        (SELECT COUNT(*) FROM idle_recall_chunks WHERE generation = ${target.generation}) AS prepared,
        (SELECT COUNT(*) FROM vector_chunks WHERE generation = ${target.generation}) AS actual,
        COALESCE(${changes?.changedCount ?? null}, CASE WHEN ${target.base_generation} IS NULL
          THEN (SELECT COUNT(*) FROM idle_recall_metadata WHERE generation = ${target.generation})
          ELSE (SELECT COUNT(*) FROM idle_recall_delta_uris WHERE generation = ${target.generation})
        END) AS changed,
        COALESCE(
          (SELECT embedded_chunks FROM idle_recall_targets WHERE generation = ${target.generation}),
          (SELECT COUNT(DISTINCT c.vector_id) FROM vector_chunks c
            JOIN idle_recall_chunks p ON p.generation = c.generation AND p.chunk_id = c.chunk_id
            WHERE c.generation = ${target.generation} AND NOT EXISTS (
              SELECT 1 FROM vector_chunks o WHERE o.vector_id = c.vector_id AND o.generation <> c.generation))
        ) AS embedded,
        (SELECT created_at FROM vector_generations WHERE generation = ${target.generation}) AS created_at`;
              const count = counts[0];
              if (
                !count ||
                (target.copy_stage !== null && target.copy_stage !== 'done') ||
                count.prepared + target.copied_chunks !== count.actual
              )
                return yield* preparationChanged();
              yield* verify;
              yield* source.fence;
              // A delta takes its real job id only now; an older binary's full target of the same job wins.
              const promoted =
                yield* sql`UPDATE vector_generations SET job_id = ${job}, state = 'ready', chunk_count = ${count.actual}
            WHERE generation = ${target.generation}
            AND NOT EXISTS (SELECT 1 FROM vector_generations o WHERE o.job_id = ${job} AND o.generation <> ${target.generation})
            RETURNING generation`;
              if (!promoted.length) return yield* preparationChanged();
              yield* sql`INSERT INTO vector_pointer (singleton,generation) VALUES (1,${target.generation}) ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation`;
              yield* sql`UPDATE idle_recall_targets SET phase = 'retire' WHERE generation = ${target.generation}`;
              const refresh = recallVectorRefreshRecord(
                {
                  kind: target.base_generation === null ? 'full' : 'delta',
                  changedCount: count.changed,
                  copiedChunkCount: target.copied_chunks,
                  reusedChunkCount: count.prepared - count.embedded,
                  embeddedChunkCount: count.embedded,
                },
                count.created_at,
                yield* Clock.currentTimeMillis,
                changes?.publishedAtMillis,
              );
              return {
                previous: previous?.generation,
                refresh,
                sequence: yield* recordRecallVectorRefresh(sql, refresh),
              };
            }),
          ),
          current =>
            verify.pipe(
              Effect.andThen(source.fence),
              Effect.andThen(sql.withTransaction(confirmRecallVectorRefresh(sql, current.sequence))),
              Effect.as(current),
            ),
          ({previous: previousPointer, sequence}, exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : sql.withTransaction(
                  Effect.gen(function* () {
                    const restored =
                      previousPointer === undefined
                        ? []
                        : yield* sql`
            UPDATE vector_pointer SET generation = ${previousPointer}
            WHERE generation = ${target.generation}
              AND EXISTS (SELECT 1 FROM vector_generations WHERE generation = ${previousPointer} AND state = 'ready')
            RETURNING generation`;
                    if (!restored.length)
                      yield* sql`DELETE FROM vector_pointer WHERE generation = ${target.generation}`;
                    yield* sql`UPDATE vector_generations SET state = 'building',
                  job_id = ${target.base_generation === null ? job : recallVectorDeltaJobId(job)}
                  WHERE generation = ${target.generation}`;
                    yield* sql`UPDATE idle_recall_targets SET phase = 'embed' WHERE generation = ${target.generation}`;
                    yield* removeRecallVectorRefresh(sql, sequence);
                  }),
                ),
        );
      }),
    );
    // Logged after the pointer is final, so an interrupted log write cannot undo a publication.
    yield* emitRecallDiagnostic(config.agentContextHome, {
      event: 'recall.vector-build',
      scope: 'active',
      ...activated.refresh,
    });
    return {state: 'pending' as const, phase: 'retire' as const, inferred: false, generation: target.generation};
  } else if (target.phase === 'retire') {
    yield* verify;
    yield* source.fence;
    const complete = yield* retireRecallVectorPreparation(config, manifest, target, source.generation);
    return {
      state: 'pending' as const,
      phase: complete ? ('ready' as const) : target.phase,
      inferred: false,
      generation: target.generation,
    };
  } else {
    yield* verify;
    yield* source.fence;
    // A ready target keeps no document rows; authorize the current corpus itself.
    yield* authorizeRecallVectorCorpus(source);
    const pointer = yield* recallVectorStorage.read(
      filename,
      Effect.gen(function* () {
        return yield* (yield* SqlClient.SqlClient)<{
          readonly generation: string;
        }>`SELECT generation FROM vector_pointer WHERE singleton = 1`;
      }),
    );
    if (pointer[0]?.generation !== target.generation)
      yield* recallVectorStorage
        .validateGenerationRows(config.agentContextHome, manifest, target.generation, manifest.dimensions)
        .pipe(
          Effect.mapError(() =>
            VectorIndexCorrupt.make({
              modelId: manifest.id,
              message: 'Retained recall vectors require explicit repair.',
            }),
          ),
        );
    // A different authorization scope may have activated since this target retired.
    // Reuse its immutable ready vectors only after fresh authorization and exact fences.
    return yield* Effect.acquireUseRelease(
      withRecallVectorWrite(
        config,
        manifest,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* assertRecallVectorTarget(target);
          const ready = yield* sql`SELECT 1 FROM vector_generations g
          WHERE g.generation = ${target.generation} AND g.state = 'ready'
          AND g.job_id = ${job} AND g.corpus_generation = ${source.generation}
          AND g.chunk_count = (SELECT COUNT(*) FROM vector_chunks c WHERE c.generation = g.generation)`;
          if (ready.length !== 1) return yield* preparationChanged();
          const previous = yield* sql<{
            readonly generation: string;
          }>`SELECT generation FROM vector_pointer WHERE singleton = 1`;
          yield* verify;
          yield* source.fence;
          yield* sql`INSERT INTO vector_pointer (singleton,generation) VALUES (1,${target.generation})
          ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation`;
          return previous[0]?.generation;
        }),
      ),
      () =>
        verify.pipe(
          Effect.andThen(source.fence),
          Effect.as({state: 'current' as const, phase: target.phase, inferred: false, generation: target.generation}),
        ),
      (previous, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : withRecallVectorWrite(
              config,
              manifest,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const restored =
                  previous === undefined
                    ? []
                    : yield* sql`UPDATE vector_pointer SET generation = ${previous}
          WHERE generation = ${target.generation}
          AND EXISTS (SELECT 1 FROM vector_generations WHERE generation = ${previous} AND state = 'ready') RETURNING generation`;
                if (!restored.length) yield* sql`DELETE FROM vector_pointer WHERE generation = ${target.generation}`;
                // Ready targets retain immutable preparation and must never be demoted.
              }),
            ),
    );
  }
  return {state: 'pending' as const, phase: target.phase, inferred: false, generation: target.generation};
});

/** Amortize admission over short preparation steps; every native request still ends the batch. */
export const runRecallVectorPreparationBatch = Effect.fn('recall.prepareVectorBatch')(function* <R>(
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  stillDesired: Effect.Effect<boolean, unknown, R>,
) {
  const started = yield* Clock.monotonicTimeNanos;
  let result = yield* stepRecallVectorPreparation(config, manifest, stillDesired);
  for (
    let step = 1;
    step < 32 && result.state !== 'current' && ['metadata', 'resolve', 'hydrate', 'retire'].includes(result.phase);
    step++
  ) {
    if ((yield* Clock.monotonicTimeNanos) - started >= 250_000_000n) break;
    result = yield* stepRecallVectorPreparation(config, manifest, stillDesired);
  }
  const path = yield* Path.Path;
  const progress = yield* recallVectorStorage.read(
    recallVectorStorage.databasePath(path, config.agentContextHome, manifest.id),
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly phase: NonNullable<RecallEmbeddingObservation['progress']>['phase'];
        readonly cursor: number;
        readonly documents: number;
        readonly chunks: number;
        readonly embedded: number;
        readonly reused: number;
      }>`SELECT t.phase,t.cursor,
        (SELECT COUNT(*) FROM idle_recall_documents WHERE generation=t.generation) AS documents,
        (SELECT COUNT(*) FROM idle_recall_chunks WHERE generation=t.generation) AS chunks,
        (SELECT COUNT(*) FROM vector_chunks WHERE generation=t.generation) AS embedded,
        (SELECT COUNT(*) FROM idle_recall_document_preparations WHERE generation=t.generation AND reused=1) AS reused
        FROM idle_recall_targets t WHERE t.generation=${result.generation}`;
      const row = rows[0];
      if (!row) return undefined;
      return {
        phase: row.phase,
        completed: row.phase === 'embed' || row.phase === 'retire' || row.phase === 'ready' ? row.embedded : row.cursor,
        total: row.phase === 'hydrate' ? row.documents : row.phase === 'embed' ? row.chunks : 0,
        reusedDocuments: row.reused,
      };
    }),
  );
  return {...result, progress};
});

function decodePreparedCandidate(text: string, expectedHash: string) {
  return Effect.try({
    try: (): RecallCandidate => {
      if (sha256HexSync(text) !== expectedHash) throw preparationChanged();
      const value: unknown = JSON.parse(text);
      if (!recallCandidateIsValid(value)) throw preparationChanged();
      return value;
    },
    catch: preparationChanged,
  });
}
