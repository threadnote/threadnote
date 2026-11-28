import {SecureRandom} from 'effect/crypto';
import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import {Clock, DateTime, Effect} from 'effect';
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
import {
  RECALL_DELTA_JOB_PREFIX,
  recallVectorDeltaJobId,
  recallVectorPreparationIdentity,
  recallVectorPreparationJobId,
} from '../vector/preparation-identity.js';

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
  /** The ready generation a delta copies unchanged rows from; null for a full walk. */
  readonly base_generation: string | null;
  readonly copy_stage: 'chunks' | 'aliases' | 'done' | null;
  readonly copy_expected: number;
  readonly alias_expected: number;
  readonly copied_chunks: number;
  readonly purging: 0 | 1;
}
/** A delta from a ready base over the changed URIs (extended to groups and identities), or a full walk. */
export type RecallVectorBuildPlan =
  | {readonly kind: 'full'}
  | {
      readonly kind: 'delta';
      readonly base: {readonly generation: string; readonly job_id: string};
      readonly changed: readonly string[];
    };
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
    current.alias_cursor !== target.alias_cursor ||
    current.base_generation !== target.base_generation ||
    current.copy_stage !== target.copy_stage ||
    current.copied_chunks !== target.copied_chunks ||
    current.purging !== target.purging
  )
    return yield* preparationChanged();
});

/** The current target of the source's job. `plan` runs only when the job has no target yet. */
export const recallVectorTarget = Effect.fn('recall.vectorTarget')(function* <E, R>(
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  plan: Effect.Effect<RecallVectorBuildPlan, E, R>,
) {
  const inputIdentity = recallVectorPreparationIdentity(
    source.generation,
    source.authorizationKey,
    manifest.id,
    recallVectorStorage.recipe(manifest),
  );
  const job = recallVectorPreparationJobId(inputIdentity);
  const deltaJob = recallVectorDeltaJobId(job);
  const previousSharedJob = sha256HexSync(JSON.stringify(['idle-recall-v2', ...inputIdentity]));
  const legacyJob = sha256HexSync(
    JSON.stringify(['idle-recall-v1', recallEmbeddingDemandKey(config), ...inputIdentity]),
  );
  const lookup = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // A finished target holds the real job id; an older binary's full target wins over an unfinished delta.
    const existing = yield* sql<RecallVectorTarget>`SELECT t.* FROM idle_recall_targets t
      JOIN vector_generations g USING(generation) WHERE g.job_id IN (${job},${deltaJob})
      ORDER BY g.job_id = ${job} DESC LIMIT 1`;
    if (existing[0]) return existing[0];
    const legacy =
      yield* sql<RecallVectorTarget>`SELECT t.* FROM idle_recall_targets t JOIN vector_generations g USING(generation) WHERE g.job_id IN (${legacyJob},${previousSharedJob}) ORDER BY g.created_at,g.generation LIMIT 1`;
    if (legacy[0]) {
      yield* sql`UPDATE vector_generations SET job_id = ${job} WHERE generation = ${legacy[0].generation} AND job_id IN (${legacyJob},${previousSharedJob})`;
      return legacy[0];
    }
    return undefined;
  });
  const found = yield* withRecallVectorWrite(config, manifest, lookup);
  if (found) return found;
  // Plan outside the writer: it reads the lexical change log and the base generation's groups.
  const planned = yield* plan;
  return yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const raced = yield* lookup;
      if (raced) return raced;
      yield* source.fence;
      // Only a whole base can be copied: its recorded chunk count must equal its rows.
      const delta =
        planned.kind === 'delta' &&
        (yield* sql`SELECT 1 FROM vector_generations g WHERE g.generation = ${planned.base.generation}
          AND g.job_id = ${planned.base.job_id} AND g.state = 'ready'
          AND g.chunk_count = (SELECT COUNT(*) FROM vector_chunks c WHERE c.generation = g.generation)`).length === 1
          ? planned
          : undefined;
      const generation = `${yield* Clock.currentTimeMillis}-${EffectString.slice(0, 8)(yield* (yield* SecureRandom.SecureRandom).uuidV4())}`;
      yield* sql`INSERT INTO vector_generations (generation,job_id,corpus_generation,model_id,model_sha256,dimensions,embedding_recipe,chunker_version,normalized,chunk_count,state,created_at,scope_mapping_version)
      VALUES (${generation},${delta ? deltaJob : job},${source.generation},${manifest.id},${manifest.sha256},${manifest.dimensions},${recallVectorStorage.recipe(manifest)},${RECALL_CHUNKER_VERSION},'l2',0,'building',${DateTime.formatIso(yield* DateTime.now)},1)`;
      yield* sql`INSERT INTO idle_recall_targets (generation,phase,base_generation,copy_stage)
      VALUES (${generation},'metadata',${delta ? delta.base.generation : null},${delta ? 'chunks' : null})`;
      for (const uri of delta ? delta.changed : [])
        yield* sql`INSERT INTO idle_recall_delta_uris (generation,uri) VALUES (${generation},${uri})`;
      // The copy must end with exactly the base chunks and aliases outside the changed set.
      if (delta)
        yield* sql`UPDATE idle_recall_targets SET
          copy_expected = (SELECT COUNT(*) FROM vector_chunks WHERE generation = ${delta.base.generation}
            AND uri NOT IN (SELECT uri FROM idle_recall_delta_uris WHERE generation = ${generation})),
          alias_expected = (SELECT COUNT(*) FROM vector_aliases WHERE generation = ${delta.base.generation}
            AND uri NOT IN (SELECT uri FROM idle_recall_delta_uris WHERE generation = ${generation}))
          WHERE generation = ${generation}`;
      const created =
        yield* sql<RecallVectorTarget>`SELECT * FROM idle_recall_targets WHERE generation = ${generation}`;
      return created[0] ?? (yield* preparationChanged());
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
  /** A delta prepares only the resolved groups that contain a changed URI; resolution itself stays global. */
  readChanged?: Effect.Effect<ReadonlySet<string>, unknown>,
) {
  if (resolvedTarget?.generation !== target.generation) {
    const candidates = yield* source.resolve(yield* readMetadata);
    const changed = readChanged === undefined ? undefined : yield* readChanged;
    resolvedTarget = {
      generation: target.generation,
      candidates:
        changed === undefined
          ? candidates
          : EffectArray.filter(candidates, candidate =>
              EffectArray.some([candidate.uri, ...(candidate.equivalentUris ?? [])], uri => changed.has(uri)),
            ),
    };
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
      readonly reuseKey: string | undefined;
    }
  | undefined;
export function releasePreparedRecallDocument(generation: string): void {
  if (preparedDocument?.generation === generation) preparedDocument = undefined;
}

function documentPreparationKey(
  candidate: RecallCandidate,
  text: string,
  manifest: LocalModelManifest,
  authorization: string,
) {
  // Bind exact hydrated text too: logical memory hashes intentionally omit hygiene trailers.
  return sha256HexSync(
    JSON.stringify([
      'recall-document-v1',
      authorization,
      recallVectorStorage.recipe(manifest),
      RECALL_CHUNKER_VERSION,
      candidate,
      sha256HexSync(text),
    ]),
  );
}

const reusePreparedDocument = Effect.fn('recall.reusePreparedDocument')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  target: RecallVectorTarget,
  candidate: RecallCandidate,
  reuseKey: string,
) {
  const aliases = recallVectorStorage.aliasMappings([candidate]);
  if (target.chunk_cursor !== 0 || target.alias_cursor !== 0 || aliases.length > 100) return false;
  return yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertRecallVectorTarget(target);
      yield* source.fence;
      const cached = yield* sql<{readonly generation: string; readonly chunk_count: number}>`
      SELECT generation,chunk_count FROM idle_recall_document_preparations
      WHERE reuse_key = ${reuseKey} AND generation <> ${target.generation}
        AND chunk_count <= ${100 - aliases.length} ORDER BY generation DESC LIMIT 1`;
      const previous = cached[0];
      if (!previous) return false;
      const chunks = yield* sql<RecallPreparedChunk>`SELECT * FROM idle_recall_chunks
      WHERE generation = ${previous.generation} AND uri = ${candidate.uri} ORDER BY chunk_id LIMIT 101`;
      if (chunks.length !== previous.chunk_count) return false;
      const valid = yield* Effect.try({
        try: () =>
          EffectArray.every(chunks, chunk => {
            const content: unknown = JSON.parse(chunk.content);
            return (
              typeof content === 'string' &&
              sha256HexSync(content) === chunk.fingerprint &&
              recallVectorStorage.key(recallVectorStorage.recipe(manifest), chunk) === chunk.vector_key &&
              recallPreparedChunkDigest({...chunk, content}) === chunk.payload_hash
            );
          }),
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false));
      if (!valid) return false;
      for (const chunk of chunks)
        yield* sql`INSERT INTO idle_recall_chunks
      (generation,chunk_id,uri,fingerprint,project,approved_authoritative,vector_key,content,payload_hash)
      VALUES (${target.generation},${chunk.chunk_id},${chunk.uri},${chunk.fingerprint},${chunk.project},
        ${chunk.approved_authoritative},${chunk.vector_key},${chunk.content},${chunk.payload_hash})`;
      for (const alias of aliases)
        yield* sql`INSERT INTO vector_aliases (generation,uri,representative_uri)
      VALUES (${target.generation},${alias.uri},${alias.representativeUri})`;
      yield* sql`INSERT INTO idle_recall_document_preparations (generation,ordinal,reuse_key,chunk_count,reused)
      VALUES (${target.generation},${target.cursor},${reuseKey},${chunks.length},1)`;
      yield* sql`UPDATE idle_recall_targets SET cursor = ${target.cursor + 1} WHERE generation = ${target.generation}`;
      return true;
    }),
  );
});

export const hydrateRecallVectorDocuments = Effect.fn('recall.hydrateVectorDocuments')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  target: RecallVectorTarget,
  metadata: readonly RecallCandidate[],
) {
  const selected = metadata.slice(0, 1);
  yield* source.authorize(selected);
  let reuseKey: string | undefined;
  if (preparedDocument?.generation !== target.generation || preparedDocument.ordinal !== target.cursor) {
    const documents = yield* source.hydrate(selected, {requireAll: true});
    if (
      documents.length !== selected.length ||
      !EffectArray.every(documents, (document, index) => document.uri === selected[index]?.uri)
    )
      return yield* preparationChanged();
    if (selected[0]) {
      reuseKey = documentPreparationKey(selected[0], documents[0].text, manifest, source.authorizationKey);
      if (yield* reusePreparedDocument(config, manifest, source, target, selected[0], reuseKey)) return;
    }
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
      reuseKey,
    };
  }
  const chunks = preparedDocument.chunks.slice(target.chunk_cursor, target.chunk_cursor + 100);
  const aliases = preparedDocument.aliases.slice(target.alias_cursor, target.alias_cursor + 100 - chunks.length);
  const done =
    target.chunk_cursor + chunks.length === preparedDocument.chunks.length &&
    target.alias_cursor + aliases.length === preparedDocument.aliases.length;
  const preparedChunkCount = preparedDocument.chunks.length;
  const preparedReuseKey = preparedDocument.reuseKey;
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
      if (done && selected.length && preparedReuseKey)
        yield* sql`INSERT INTO idle_recall_document_preparations (generation,ordinal,reuse_key,chunk_count,reused)
          VALUES (${target.generation},${target.cursor},${preparedReuseKey},${preparedChunkCount},0)`;
      yield* sql`UPDATE idle_recall_targets SET cursor = ${target.cursor + (done ? selected.length : 0)},
      chunk_cursor = ${done ? 0 : target.chunk_cursor + chunks.length}, alias_cursor = ${done ? 0 : target.alias_cursor + aliases.length},
      phase = ${selected.length === 0 ? 'embed' : 'hydrate'}, source_after = NULL WHERE generation = ${target.generation}`;
    }),
  );
  if (done) preparedDocument = undefined;
});

/** Every per-target table with its batch key, in deletion order: build rows, then vector rows. */
const RECALL_TARGET_TABLES = [
  {table: 'idle_recall_document_preparations', key: 'ordinal', build: true},
  {table: 'idle_recall_metadata', key: 'ordinal', build: true},
  {table: 'idle_recall_documents', key: 'ordinal', build: true},
  {table: 'idle_recall_chunks', key: 'chunk_id', build: true},
  {table: 'idle_recall_delta_uris', key: 'uri', build: true},
  {table: 'vector_chunks', key: 'chunk_id', build: false},
  {table: 'vector_aliases', key: 'uri', build: false},
] as const;
/** Rows a ready target drops: no chunk text, metadata or changed set. */
const RECALL_BUILD_TABLES = EffectArray.filter(RECALL_TARGET_TABLES, table => table.build);
/** Rows a reset delta drops; it keeps its global metadata, so the full walk resolves again from it. */
const RECALL_RESET_TABLES = EffectArray.filter(RECALL_TARGET_TABLES, table => table.table !== 'idle_recall_metadata');

/** Deletes at most 100 rows of one generation from one table; the bounded unit of every cleanup step. */
const removeRecallTargetBatch = (generation: string, {table, key}: (typeof RECALL_TARGET_TABLES)[number]) =>
  Effect.gen(function* () {
    const removed = yield* (yield* SqlClient.SqlClient).unsafe(
      `DELETE FROM ${table} WHERE generation = ? AND ${key} IN (SELECT ${key} FROM ${table} WHERE generation = ? LIMIT 100) RETURNING ${key}`,
      [generation, generation],
    );
    return removed.length > 0;
  });

/** One bounded batch of a reset delta's rows; with none left the target restarts as a full walk. */
export const purgeRecallVectorTarget = Effect.fn('recall.purgeVectorTarget')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  target: RecallVectorTarget,
) {
  yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertRecallVectorTarget(target);
      yield* source.fence;
      for (const table of RECALL_RESET_TABLES) if (yield* removeRecallTargetBatch(target.generation, table)) return;
      yield* sql`UPDATE idle_recall_targets SET purging = 0, phase = 'resolve', source_after = NULL, cursor = 0,
        chunk_cursor = 0, alias_cursor = 0 WHERE generation = ${target.generation}`;
    }),
  );
});

/** Bounded retirement never cascades a corpus-sized generation under the writer. */
export const retireRecallVectorPreparation = Effect.fn('recall.retireVectorPreparation')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  target: RecallVectorTarget,
  currentCorpusGeneration: string,
) {
  return yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertRecallVectorTarget(target);
      const own = yield* sql`SELECT 1 FROM vector_generations WHERE generation = ${target.generation}
        AND state = 'ready' AND corpus_generation = ${currentCorpusGeneration}`;
      if (own.length !== 1) return yield* preparationChanged();
      // A base is kept while a delta target still copies from it. A delta placeholder loses to a target that
      // holds its real job id, which an older binary may have built.
      const obsolete = yield* sql<{readonly generation: string}>`SELECT g.generation FROM vector_generations g
      WHERE g.generation <> ${target.generation}
      AND NOT EXISTS (SELECT 1 FROM vector_pointer p WHERE p.generation = g.generation)
      AND NOT EXISTS (SELECT 1 FROM idle_recall_targets c
        WHERE c.base_generation = g.generation AND c.copy_stage IN ('chunks','aliases')) AND (
        g.corpus_generation <> ${currentCorpusGeneration}
        OR (g.state = 'ready' AND NOT EXISTS (
          SELECT 1 FROM idle_recall_targets t WHERE t.generation = g.generation
        ))
        OR EXISTS (SELECT 1 FROM vector_generations r WHERE g.job_id = ${RECALL_DELTA_JOB_PREFIX} || r.job_id)
      )
      ORDER BY g.created_at, g.generation LIMIT 1`;
      const old = obsolete[0]?.generation;
      if (old) {
        // 100 rows per step: 1,000 indexed vector rows hold the writer about ten times longer than other steps.
        for (const table of RECALL_TARGET_TABLES) if (yield* removeRecallTargetBatch(old, table)) return false;
        yield* sql`DELETE FROM vector_generations WHERE generation = ${old}`;
        return false;
      }
      for (const table of RECALL_BUILD_TABLES)
        if (yield* removeRecallTargetBatch(target.generation, table)) return false;
      const removedValues = yield* sql.unsafe(`DELETE FROM vector_values WHERE id IN (
      SELECT v.id FROM vector_values v WHERE NOT EXISTS (SELECT 1 FROM vector_chunks c WHERE c.vector_id = v.id) LIMIT 100
    ) RETURNING id`);
      if (removedValues.length) return false;
      yield* sql`UPDATE idle_recall_targets SET phase = 'ready' WHERE generation = ${target.generation}`;
      return true;
    }),
  );
});
