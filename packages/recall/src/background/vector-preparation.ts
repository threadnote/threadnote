import {SecureRandom} from 'effect/crypto';
import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import {Clock, DateTime, Effect, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {RECALL_CHUNKER_VERSION} from '../chunker.js';
import type {RecallCandidate} from '../rank.js';
import type {RecallEmbeddingScope} from './demand.js';
import {recallEmbeddingDemandKey} from './demand.js';
import {openRecallVectorPreparationSource} from '../index/vector-preparation-source.js';
import {recallVectorStorage, vectorReadExpectation} from '../vector-index.js';
import {type RecallVectorGenerationMetadata, VECTOR_SCOPE_MAPPING_VERSION} from '../vector/generation-compatibility.js';
import {recallMaskedReadCompatible} from '../vector/masked-read.js';
import {preparationChanged, RECALL_CHUNK_SCOPE_COLUMNS, withRecallVectorWrite} from '../vector/storage.js';
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
      yield* sql`INSERT INTO idle_recall_targets (generation,phase,base_generation,copy_stage,embedded_chunks)
      VALUES (${generation},'metadata',${delta ? delta.base.generation : null},${delta ? 'chunks' : null},0)`;
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
      readonly identityKey: string | undefined;
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

/** The chunk columns a body read decides; the digest binds a document identity to its chunk rows. */
type RecallChunkBinding = Pick<
  RecallPreparedChunk,
  'chunk_id' | 'uri' | 'fingerprint' | 'project' | 'approved_authoritative' | 'vector_key'
>;
function recallChunkSetDigest(chunks: readonly RecallChunkBinding[]) {
  const ordered = [...chunks].sort((left, right) =>
    left.chunk_id < right.chunk_id ? -1 : left.chunk_id > right.chunk_id ? 1 : 0,
  );
  return sha256HexSync(
    JSON.stringify(
      EffectArray.map(ordered, chunk => [
        chunk.chunk_id,
        chunk.uri,
        chunk.fingerprint,
        chunk.project ?? null,
        chunk.approved_authoritative,
        chunk.vector_key,
      ]),
    ),
  );
}

/**
 * The durable identity of each document: its lexical stamp (lexical schema, text derivation, URI, stored size,
 * modification time and content hash), its candidate record without text, the authorization key, embedding
 * recipe, chunker version and scope mapping version. A document without a stamp has no identity.
 */
const recallDocumentIdentityKeys = Effect.fn('recall.documentIdentityKeys')(function* (
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  candidates: readonly RecallCandidate[],
) {
  const stamps = yield* source.readDocumentStamps(candidates);
  return EffectArray.map(candidates, candidate => {
    const stamp = stamps.get(candidate.uri);
    if (stamp === undefined) return undefined;
    const {text: _text, ...record} = candidate;
    return sha256HexSync(
      JSON.stringify([
        'recall-document-identity-v1',
        stamp,
        sha256HexSync(JSON.stringify(record)),
        source.authorizationKey,
        recallVectorStorage.recipe(manifest),
        RECALL_CHUNKER_VERSION,
        VECTOR_SCOPE_MAPPING_VERSION,
      ]),
    );
  });
});

/** Records the identity of a body read, or drops a stale one when the document has no identity or chunks. */
const recordRecallDocumentIdentity = (
  uri: string,
  identityKey: string | undefined,
  chunks: readonly RecallChunkBinding[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (identityKey === undefined || chunks.length === 0)
      return yield* sql`DELETE FROM idle_recall_document_identities WHERE uri = ${uri}`;
    return yield* sql`INSERT INTO idle_recall_document_identities (uri,identity_key,chunk_count,chunk_digest)
      VALUES (${uri},${identityKey},${chunks.length},${recallChunkSetDigest(chunks)})
      ON CONFLICT(uri) DO UPDATE SET identity_key = excluded.identity_key, chunk_count = excluded.chunk_count,
        chunk_digest = excluded.chunk_digest`;
  });

/** Most chunk and alias rows one step copies for documents that need no body read. */
const UNCHANGED_COPY_ROWS = 100;

/**
 * The leading documents whose recorded identity equals the current one and whose chunk rows, by digest, exist
 * in a ready generation that the masked read accepts, up to `UNCHANGED_COPY_ROWS` rows. It stops at the first
 * document that needs a body read.
 */
const matchUnchangedRecallDocuments = (
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  candidates: readonly RecallCandidate[],
  identityKeys: readonly (string | undefined)[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const expected = vectorReadExpectation(manifest);
    const ready = EffectArray.filter(
      yield* sql<RecallVectorGenerationMetadata>`SELECT g.* FROM vector_generations g WHERE g.state = 'ready'
        ORDER BY EXISTS (SELECT 1 FROM vector_pointer p WHERE p.generation = g.generation) DESC,
          g.created_at DESC, g.generation DESC`,
      generation => recallMaskedReadCompatible(generation, expected, source.authorizationKey),
    );
    const matched: {readonly candidate: RecallCandidate; readonly generation: string; readonly chunks: number}[] = [];
    let rows = 0;
    for (const [index, candidate] of candidates.entries()) {
      const identityKey = identityKeys[index];
      if (identityKey === undefined) break;
      const identity = yield* sql<{readonly chunk_count: number; readonly chunk_digest: string}>`
        SELECT chunk_count,chunk_digest FROM idle_recall_document_identities
        WHERE uri = ${candidate.uri} AND identity_key = ${identityKey}`;
      const recorded = identity[0];
      const aliases = recallVectorStorage.aliasMappings([candidate]).length;
      if (!recorded || rows + recorded.chunk_count + aliases > UNCHANGED_COPY_ROWS) break;
      let generation: string | undefined;
      for (const {generation: candidateGeneration} of ready) {
        const chunks = yield* sql.unsafe<RecallChunkBinding>(
          `SELECT ${RECALL_CHUNK_SCOPE_COLUMNS},v.vector_key FROM vector_chunks c JOIN vector_values v ON v.id = c.vector_id
           WHERE c.generation = ? AND c.uri = ? LIMIT ?`,
          [candidateGeneration, candidate.uri, recorded.chunk_count + 1],
        );
        if (chunks.length === recorded.chunk_count && recallChunkSetDigest(chunks) === recorded.chunk_digest) {
          generation = candidateGeneration;
          break;
        }
      }
      if (generation === undefined) break;
      matched.push({candidate, generation, chunks: recorded.chunk_count});
      rows += recorded.chunk_count + aliases;
    }
    return matched;
  });

/**
 * One bounded batch of documents whose identity did not change: their chunk rows come from a ready generation
 * that holds them, with their vector ids, and their alias rows from the candidate. No body is read; external
 * URIs are still authorized. Returns false when the first document, whose key the caller has, needs a body read;
 * only then are the keys of the rest of the batch computed.
 */
const copyUnchangedRecallDocuments = Effect.fn('recall.copyUnchangedDocuments')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  target: RecallVectorTarget,
  candidates: readonly RecallCandidate[],
  firstKey: string | undefined,
) {
  const path = yield* Path.Path;
  const filename = recallVectorStorage.databasePath(path, config.agentContextHome, manifest.id);
  const first = yield* recallVectorStorage.read(
    filename,
    matchUnchangedRecallDocuments(manifest, source, candidates.slice(0, 1), [firstKey]),
  );
  if (!first.length) return false;
  const identityKeys = [firstKey, ...(yield* recallDocumentIdentityKeys(manifest, source, candidates.slice(1)))];
  const planned = yield* recallVectorStorage.read(
    filename,
    matchUnchangedRecallDocuments(manifest, source, candidates, identityKeys),
  );
  if (!planned.length) return false;
  yield* source.authorize(EffectArray.map(planned, document => document.candidate));
  return yield* withRecallVectorWrite(
    config,
    manifest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertRecallVectorTarget(target);
      yield* source.fence;
      // Only the authorized documents, matched again under the writer.
      const matched = yield* matchUnchangedRecallDocuments(
        manifest,
        source,
        candidates.slice(0, planned.length),
        identityKeys,
      );
      if (!matched.length) return false;
      let copied = 0;
      for (const {candidate, generation, chunks} of matched) {
        yield* sql.unsafe(
          `INSERT INTO vector_chunks (generation,${RECALL_CHUNK_SCOPE_COLUMNS},vector_id)
           SELECT ?,${RECALL_CHUNK_SCOPE_COLUMNS},vector_id FROM vector_chunks WHERE generation = ? AND uri = ?`,
          [target.generation, generation, candidate.uri],
        );
        for (const alias of recallVectorStorage.aliasMappings([candidate]))
          yield* sql`INSERT INTO vector_aliases (generation,uri,representative_uri)
            VALUES (${target.generation},${alias.uri},${alias.representativeUri})`;
        copied += chunks;
      }
      yield* sql`UPDATE idle_recall_targets SET cursor = ${target.cursor + matched.length},
        copied_chunks = ${target.copied_chunks + copied}, source_after = NULL WHERE generation = ${target.generation}`;
      return true;
    }),
  );
});

const reusePreparedDocument = Effect.fn('recall.reusePreparedDocument')(function* (
  config: RecallEmbeddingScope,
  manifest: LocalModelManifest,
  source: RecallVectorSource,
  target: RecallVectorTarget,
  candidate: RecallCandidate,
  reuseKey: string,
  identityKey: string | undefined,
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
      // The rows just validated: every chunk of the URI, since the read above was not truncated.
      yield* sql.unsafe(
        `INSERT INTO idle_recall_chunks (generation,${RECALL_CHUNK_SCOPE_COLUMNS},vector_key,content,payload_hash)
         SELECT ?,${RECALL_CHUNK_SCOPE_COLUMNS},vector_key,content,payload_hash FROM idle_recall_chunks
         WHERE generation = ? AND uri = ?`,
        [target.generation, previous.generation, candidate.uri],
      );
      for (const alias of aliases)
        yield* sql`INSERT INTO vector_aliases (generation,uri,representative_uri)
      VALUES (${target.generation},${alias.uri},${alias.representativeUri})`;
      yield* sql`INSERT INTO idle_recall_document_preparations (generation,ordinal,reuse_key,chunk_count,reused)
      VALUES (${target.generation},${target.cursor},${reuseKey},${chunks.length},1)`;
      yield* recordRecallDocumentIdentity(candidate.uri, identityKey, chunks);
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
  let prepared =
    preparedDocument?.generation === target.generation && preparedDocument.ordinal === target.cursor
      ? preparedDocument
      : undefined;
  let identityKey: string | undefined;
  if (!prepared && selected.length) {
    [identityKey] = yield* recallDocumentIdentityKeys(manifest, source, selected);
    // A document start may copy a batch of unchanged documents; a resumed document reads its body again.
    if (
      target.chunk_cursor === 0 &&
      target.alias_cursor === 0 &&
      (yield* copyUnchangedRecallDocuments(config, manifest, source, target, metadata.slice(0, 100), identityKey))
    )
      return;
  }
  yield* source.authorize(selected);
  let reuseKey: string | undefined;
  if (!prepared) {
    const documents = yield* source.hydrate(selected, {requireAll: true});
    if (
      documents.length !== selected.length ||
      !EffectArray.every(documents, (document, index) => document.uri === selected[index]?.uri)
    )
      return yield* preparationChanged();
    if (selected[0]) {
      reuseKey = documentPreparationKey(selected[0], documents[0].text, manifest, source.authorizationKey);
      if (yield* reusePreparedDocument(config, manifest, source, target, selected[0], reuseKey, identityKey)) return;
    }
    const recipe = recallVectorStorage.recipe(manifest);
    prepared = {
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
      identityKey,
    };
    preparedDocument = prepared;
  }
  const document = prepared;
  const chunks = document.chunks.slice(target.chunk_cursor, target.chunk_cursor + 100);
  const aliases = document.aliases.slice(target.alias_cursor, target.alias_cursor + 100 - chunks.length);
  const done =
    target.chunk_cursor + chunks.length === document.chunks.length &&
    target.alias_cursor + aliases.length === document.aliases.length;
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
      if (done && selected.length && document.reuseKey)
        yield* sql`INSERT INTO idle_recall_document_preparations (generation,ordinal,reuse_key,chunk_count,reused)
          VALUES (${target.generation},${target.cursor},${document.reuseKey},${document.chunks.length},0)`;
      if (done && selected[0])
        yield* recordRecallDocumentIdentity(selected[0].uri, document.identityKey, document.chunks);
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
      // Every ready generation holds the whole corpus, so an identity without chunks here is a removed memory.
      const removedIdentities = yield* sql`DELETE FROM idle_recall_document_identities WHERE uri IN (
        SELECT i.uri FROM idle_recall_document_identities i WHERE NOT EXISTS (
          SELECT 1 FROM vector_chunks c WHERE c.generation = ${target.generation} AND c.uri = i.uri) LIMIT 100
      ) RETURNING uri`;
      if (removedIdentities.length) return false;
      const removedValues = yield* sql.unsafe(`DELETE FROM vector_values WHERE id IN (
      SELECT v.id FROM vector_values v WHERE NOT EXISTS (SELECT 1 FROM vector_chunks c WHERE c.vector_id = v.id) LIMIT 100
    ) RETURNING id`);
      if (removedValues.length) return false;
      yield* sql`UPDATE idle_recall_targets SET phase = 'ready' WHERE generation = ${target.generation}`;
      return true;
    }),
  );
});
