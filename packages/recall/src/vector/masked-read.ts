import {Array as EffectArray, Cause, Effect, FileSystem, Option, Path, String as EffectString} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {hasReadCleanupUnconfirmed} from '@threadnote/platform/read_deadline';
import {readRecallChangesSince, type RecallChangeEntry} from '../index/change_log.js';
import {useRecallDatabaseReadOnly} from '../index/read_policy.js';
import type {RecallSqlPredicate} from '../index/scope.js';
import {recallIndexStatus, type RecallIndexConfig} from '../index.js';
import {RECALL_MASKED_READ_MAX_URIS, RecallReadyReadBoundary} from '../read_boundary.js';
import type {recallVectorStorage} from '../vector-index.js';
import {
  RECALL_PREPARATION_PREFIX,
  recallVectorPreparationIdentity,
  recallVectorPreparationJobId,
} from './preparation-identity.js';
import {
  recallVectorGenerationMatchesModel,
  sqlPlaceholders,
  type RecallVectorGenerationMetadata,
  type RecallVectorModelExpectation,
} from './generation-compatibility.js';

/**
 * Masked read of an older vector generation. The active READY generation can serve vectors after a
 * lexical publication only for memories that did not change since its corpus. Every decision input
 * is here; the vector index supplies its own rows and applies the mask in the native SQL selection.
 */

/** URIs that get no vector score from the served generation, bound to one lexical generation. */
export interface RecallVectorMask {
  readonly contentGeneration: string;
  readonly uris: readonly string[];
}

export type RecallMaskedReadDecision =
  | {readonly servable: true; readonly mask: RecallVectorMask}
  | {readonly servable: false; readonly reason: 'incompatible' | 'unknown-changes' | 'over-cap' | 'unreadable'};

/** Lexical inputs of the mask, read in one snapshot of the active lexical index. */
export type RecallMaskLexicalInputs =
  | {
      readonly state: 'known';
      readonly contentGeneration: string;
      readonly changed: readonly RecallChangeEntry[];
      /** Current URIs whose memory ID or content hash equals a value before or after a change. */
      readonly identityUris: readonly string[];
    }
  | {readonly state: 'unknown' | 'over-cap'};

/** One row of the served generation's `vector_aliases`. */
export interface RecallVectorGroupMember {
  readonly uri: string;
  readonly representativeUri: string;
}

const notServable = (
  reason: 'incompatible' | 'unknown-changes' | 'over-cap' | 'unreadable',
): RecallMaskedReadDecision => ({servable: false, reason});
const lexicalNotKnown = (state: 'unknown' | 'over-cap'): RecallMaskLexicalInputs => ({state});

/** Cheap metadata test: only an identity that records an authorization key can ever serve a masked read. */
export function recallMaskedReadMayServe(generation: {readonly job_id: string | null}): boolean {
  return generation.job_id !== null && EffectString.startsWith(RECALL_PREPARATION_PREFIX)(generation.job_id);
}

/** The full masked-read compatibility of a generation for the current authorization key. */
export function recallMaskedReadCompatible(
  generation: RecallVectorGenerationMetadata,
  expected: RecallVectorModelExpectation,
  authorizationKey: string | undefined,
): boolean {
  const corpus = generation.corpus_generation;
  return (
    generation.state === 'ready' &&
    typeof corpus === 'string' &&
    corpus.length > 0 &&
    authorizationKey !== undefined &&
    recallVectorGenerationMatchesModel(generation, expected) &&
    generation.scope_mapping_version === expected.scopeMappingVersion &&
    recallMaskedReadMayServe(generation) &&
    generation.job_id ===
      recallVectorPreparationJobId(
        recallVectorPreparationIdentity(corpus, authorizationKey, expected.modelId, expected.embeddingRecipe),
      )
  );
}

/** Seeds plus every member, representative and alias, of an old group that contains a seed. */
function extendRecallVectorMask(
  seeds: ReadonlySet<string>,
  members: readonly RecallVectorGroupMember[],
): ReadonlySet<string> {
  const representatives = new Set(
    EffectArray.flatMap(members, member =>
      seeds.has(member.uri) || seeds.has(member.representativeUri) ? [member.representativeUri] : [],
    ),
  );
  const mask = new Set(seeds);
  for (const member of members) {
    if (!representatives.has(member.representativeUri)) continue;
    mask.add(member.uri);
    mask.add(member.representativeUri);
  }
  return mask;
}

/** Identity values of the changed entries, before and after each change. */
function recallChangeIdentityValues(changed: readonly RecallChangeEntry[]) {
  const memoryIds = new Set<string>();
  const contentHashes = new Set<string>();
  for (const entry of changed) {
    for (const value of [entry.beforeMemoryId, entry.afterMemoryId]) if (value) memoryIds.add(value);
    for (const value of [entry.beforeContentHash, entry.afterContentHash]) if (value) contentHashes.add(value);
  }
  return {memoryIds: [...memoryIds].sort(), contentHashes: [...contentHashes].sort()};
}

/**
 * The single masked-read decision. The readers return at most `cap + 1` rows, which is over the cap by
 * itself. A typed read failure is not servable (today's stale behavior); a defect propagates.
 */
export const decideRecallMaskedRead = Effect.fn('recall.decideMaskedRead')(function* <E1, R1, E2, R2>(input: {
  readonly generation: RecallVectorGenerationMetadata;
  readonly expected: RecallVectorModelExpectation;
  readonly authorizationKey: string | undefined;
  readonly cap?: number;
  readonly readLexicalInputs: (fromGeneration: string, cap: number) => Effect.Effect<RecallMaskLexicalInputs, E1, R1>;
  readonly readGroupMembers: (
    seeds: readonly string[],
    cap: number,
  ) => Effect.Effect<readonly RecallVectorGroupMember[], E2, R2>;
}) {
  const {generation} = input;
  const cap = input.cap ?? RECALL_MASKED_READ_MAX_URIS;
  const corpus = generation.corpus_generation;
  if (!recallMaskedReadCompatible(generation, input.expected, input.authorizationKey) || !corpus)
    return notServable('incompatible');
  return yield* Effect.gen(function* () {
    const lexical = yield* input.readLexicalInputs(corpus, cap);
    if (lexical.state !== 'known') return notServable(lexical.state === 'unknown' ? 'unknown-changes' : 'over-cap');
    const seeds = new Set([...EffectArray.map(lexical.changed, entry => entry.uri), ...lexical.identityUris]);
    if (seeds.size > cap) return notServable('over-cap');
    const members = seeds.size === 0 ? [] : yield* input.readGroupMembers([...seeds].sort(), cap);
    const mask = extendRecallVectorMask(seeds, members);
    if (members.length > cap || mask.size > cap) return notServable('over-cap');
    const servable: RecallMaskedReadDecision = {
      servable: true,
      mask: {contentGeneration: lexical.contentGeneration, uris: [...mask].sort()},
    };
    return servable;
  }).pipe(
    Effect.catchCauseIf(
      cause => !Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !hasReadCleanupUnconfirmed(cause),
      () => Effect.succeed(notServable('unreadable')),
    ),
  );
});

/**
 * Reads the change log and the identity matches in one read-only snapshot of the active lexical index.
 * It runs where the lexical index is read directly: in the ready-read worker or in a process without
 * the boundary. With the boundary present it gives `unknown`, so the caller keeps today's behavior.
 */
export const readRecallMaskLexicalInputs = Effect.fn('recall.readMaskLexicalInputs')(function* (
  config: RecallIndexConfig,
  fromGeneration: string,
  cap: number = RECALL_MASKED_READ_MAX_URIS,
) {
  if (Option.isSome(yield* Effect.serviceOption(RecallReadyReadBoundary))) return lexicalNotKnown('unknown');
  const status = yield* recallIndexStatus(config, false);
  if (!status.ready || status.databasePath === undefined || status.generation === undefined)
    return lexicalNotKnown('unknown');
  return yield* useRecallDatabaseReadOnly(
    status.databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* readRecallChangesSince(sql, fromGeneration);
      if (changes.state === 'unknown') return lexicalNotKnown('unknown');
      if (changes.changed.length > cap) return lexicalNotKnown('over-cap');
      const {memoryIds, contentHashes} = recallChangeIdentityValues(changes.changed);
      const clauses = [
        ...(memoryIds.length === 0 ? [] : [`memory_id IN (${sqlPlaceholders(memoryIds.length)})`]),
        ...(contentHashes.length === 0 ? [] : [`content_hash IN (${sqlPlaceholders(contentHashes.length)})`]),
      ];
      // No index serves content_hash alone (about 4 ms warm for 6,200 rows); adding one needs a lexical version bump.
      const rows =
        clauses.length === 0
          ? []
          : yield* sql.unsafe<{readonly uri: string}>(
              `SELECT uri FROM documents WHERE ${EffectArray.join(clauses, ' OR ')} ORDER BY uri LIMIT ?`,
              [...memoryIds, ...contentHashes, cap + 1],
            );
      if (rows.length > cap) return lexicalNotKnown('over-cap');
      const known: RecallMaskLexicalInputs = {
        state: 'known',
        contentGeneration: changes.contentGeneration,
        changed: changes.changed,
        identityUris: EffectArray.map(rows, row => row.uri),
      };
      return known;
    }),
  );
});

type VectorMaskStorage = Pick<typeof recallVectorStorage, 'databasePath' | 'read'>;

/** The served generation's `vector_aliases` rows for every group that contains a seed, at most `cap + 1`. */
export const readRecallVectorGroupMembers = Effect.fn('recall.readVectorGroupMembers')(function* (
  storage: VectorMaskStorage,
  home: string,
  modelId: string,
  generation: string,
  seeds: readonly string[],
  cap: number = RECALL_MASKED_READ_MAX_URIS,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = storage.databasePath(path, home, modelId);
  if (seeds.length === 0 || !(yield* fs.exists(databasePath))) return [];
  const placeholders = sqlPlaceholders(seeds.length);
  const rows = yield* storage.read(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<{readonly uri: string; readonly representative_uri: string}>(
        `SELECT member.uri AS uri, member.representative_uri AS representative_uri
         FROM vector_aliases AS member
         WHERE member.generation = ? AND member.representative_uri IN (
           SELECT seed.representative_uri FROM vector_aliases AS seed
           WHERE seed.generation = ? AND (seed.uri IN (${placeholders}) OR seed.representative_uri IN (${placeholders})))
         ORDER BY member.uri LIMIT ?`,
        [generation, generation, ...seeds, ...seeds, cap + 1],
      );
    }),
  );
  return EffectArray.map(
    rows,
    row => ({uri: row.uri, representativeUri: row.representative_uri}) satisfies RecallVectorGroupMember,
  );
});

/**
 * The masked read of the active older generation for exactly the requested lexical generation. `moved`: the
 * decision was servable for another lexical generation, so a publication raced the caller's generation.
 */
export type RecallVectorMaskRead =
  {readonly state: 'served'; readonly mask: RecallVectorMask} | {readonly state: 'refused'} | {readonly state: 'moved'};

export const readRecallVectorMask = (
  storage: VectorMaskStorage,
  config: RecallIndexConfig,
  modelId: string,
  expected: RecallVectorModelExpectation,
  read: {
    readonly active: RecallVectorGenerationMetadata;
    readonly authorizationKey: string | undefined;
    readonly requestedGeneration: string;
  },
) =>
  decideRecallMaskedRead({
    generation: read.active,
    expected,
    authorizationKey: read.authorizationKey,
    readLexicalInputs: (fromGeneration, cap) => readRecallMaskLexicalInputs(config, fromGeneration, cap),
    readGroupMembers: (seeds, cap) =>
      readRecallVectorGroupMembers(storage, config.agentContextHome, modelId, read.active.generation, seeds, cap),
  }).pipe(
    Effect.map((decision): RecallVectorMaskRead =>
      !decision.servable
        ? {state: 'refused'}
        : decision.mask.contentGeneration === read.requestedGeneration
          ? {state: 'served', mask: decision.mask}
          : {state: 'moved'},
    ),
  );

/** URI exclusion for the native selection. No masked URIs gives no clause. */
export function recallVectorMaskPredicate(
  predicate: RecallSqlPredicate,
  column: string,
  mask: RecallVectorMask | undefined,
): RecallSqlPredicate {
  if (mask === undefined || mask.uris.length === 0) return predicate;
  return {
    params: [...predicate.params, ...mask.uris],
    restricted: true,
    sql: `(${predicate.sql}) AND ${column} NOT IN (${sqlPlaceholders(mask.uris.length)})`,
  };
}
