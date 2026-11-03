import {Array as EffectArray} from 'effect';
import {Cause, Effect, Layer, Schema} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  externalResourceAccess,
  isExternalResourceUri,
  loadExternalResourceAccess,
} from '@threadnote/store/external-resource';
import {recallCandidateIsValid} from '../candidate_validation.js';
import {recallIndexStatus, RecallIndexCorrupt} from '../index.js';
import {deduplicateLogicalRecallCandidates, type RecallCandidate} from '../rank.js';
import type {RecallEmbeddingScope} from '../background/demand.js';
import {recallIndexCandidateIsEligible} from './candidate.js';
import {stripRecallAnchor} from './lexical.js';
import {recallVectorAuthorizationKey} from '../vector/preparation-identity.js';
import {createRecallIdentityConflictLoader, markRecallIdentityConflicts} from './identity.js';

export class RecallVectorSourceChanged extends Schema.TaggedError<
  RecallVectorSourceChanged,
  {readonly brand: unique symbol}
>()('RecallVectorSourceChanged', {message: Schema.String}) {}
const changed = () =>
  RecallVectorSourceChanged.make({
    message: 'Recall source or authorization changed; retry the latest embedding demand.',
  });

const corrupt = () =>
  RecallIndexCorrupt.make({
    message: 'Recall vector preparation source is invalid or unavailable; run threadnote repair.',
  });
const pageSize = 100;

/** Fresh read-only connections; no writer, read transaction, or corpus body survives a page. */
export const openRecallVectorPreparationSource = Effect.fn('recall.openVectorPreparationSource')(function* (
  config: RecallEmbeddingScope,
) {
  const initial = yield* recallIndexStatus(config, false);
  if (!initial.ready || !initial.generation || !initial.databasePath)
    return yield* initial.reason === 'canonical documents changed; run `threadnote repair`' ? changed() : corrupt();
  const databasePath = initial.databasePath;
  const generation = initial.generation;
  const location = {home: config.agentContextHome, account: config.account, user: config.user};
  const externalResources = yield* loadExternalResourceAccess(location);
  const eligibility = {
    kind: 'candidate-policy' as const,
    authority: 'any' as const,
    projects: {mode: 'unrestricted' as const},
    externalResources,
  };
  const authorizationKey = recallVectorAuthorizationKey(externalResources);
  const fence = Effect.gen(function* () {
    if (recallVectorAuthorizationKey(yield* loadExternalResourceAccess(location)) !== authorizationKey)
      return yield* changed();
    const current = yield* recallIndexStatus(config, false);
    if (current.reason === 'canonical documents changed; run `threadnote repair`') return yield* changed();
    if (!current.ready) return yield* corrupt();
    if (current.generation !== generation || current.databasePath !== databasePath) return yield* changed();
  });
  const read = <A, E, R>(program: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
    Effect.gen(function* () {
      yield* fence;
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Explicit deferred transaction: this read must never reserve SQLite's writer.
          return yield* Effect.acquireUseRelease(
            sql.unsafe('BEGIN DEFERRED'),
            () =>
              Effect.gen(function* () {
                const rows = yield* sql<{
                  readonly value: string;
                }>`SELECT value FROM metadata WHERE key = 'content_generation'`;
                if (!rows[0]?.value) return yield* corrupt();
                if (rows[0].value !== generation) return yield* changed();
                return yield* program;
              }),
            () => sql.unsafe('ROLLBACK').pipe(Effect.orDie),
          );
        }).pipe(program =>
          Layer.build(
            SqliteClient.layer({
              filename: databasePath,
              disableWAL: true,
              readonly: true,
              create: false,
              readwrite: false,
            }).pipe(Layer.orDie),
          ).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))),
        ),
      );
      yield* fence;
      return result;
    }).pipe(
      Effect.catchCauseIf(
        cause =>
          !Cause.hasInterrupts(cause) &&
          !EffectArray.every(
            cause.reasons,
            reason => Cause.isFailReason(reason) && Schema.is(RecallVectorSourceChanged)(reason.error),
          ),
        () => fence.pipe(Effect.andThen(corrupt())),
      ),
    );
  const decode = (row: {readonly uri: string; readonly candidate_json: string; readonly text_type: string | null}) =>
    Effect.try({
      try: () => {
        const candidate: unknown = JSON.parse(row.candidate_json);
        if (
          row.text_type !== 'text' ||
          !recallCandidateIsValid(candidate) ||
          stripRecallAnchor(candidate.uri) !== row.uri
        )
          throw corrupt();
        return candidate;
      },
      catch: corrupt,
    });
  return {
    generation,
    databasePath,
    authorizationKey,
    fence,
    readMetadataPage: (after: string | undefined) =>
      read(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<{
            readonly uri: string;
            readonly candidate_json: string;
            readonly text_type: string | null;
          }>(
            `SELECT uri, json_type(candidate_json, '$.text') AS text_type,
          json_set(candidate_json, '$.text', '') AS candidate_json
         FROM documents ${after === undefined ? '' : 'WHERE uri COLLATE BINARY > ?'} ORDER BY uri COLLATE BINARY LIMIT ?`,
            after === undefined ? [pageSize] : [after, pageSize],
          );
          const candidates = yield* Effect.forEach(rows, decode);
          return {
            candidates: EffectArray.filter(candidates, candidate =>
              recallIndexCandidateIsEligible(eligibility, candidate),
            ),
            after: rows.at(-1)?.uri,
            done: rows.length < pageSize,
          };
        }),
      ),
    authorize: (metadata: readonly RecallCandidate[]) =>
      Effect.gen(function* () {
        if (
          !EffectArray.some(metadata, candidate =>
            EffectArray.some([candidate.uri, ...(candidate.equivalentUris ?? [])], isExternalResourceUri),
          )
        )
          return;
        const currentAccess = yield* loadExternalResourceAccess(location);
        for (const candidate of metadata) {
          for (const uri of [candidate.uri, ...(candidate.equivalentUris ?? [])]) {
            if (!isExternalResourceUri(uri)) continue;
            if (
              currentAccess[stripRecallAnchor(uri)] !== candidate.contentHash ||
              !(yield* externalResourceAccess(location, uri, undefined, candidate.contentHash))
            )
              return yield* changed();
          }
        }
      }),
    // This pass is global and metadata-sized. Per-page or logical_key grouping is not equivalent.
    resolve: (metadata: readonly RecallCandidate[]) =>
      read(
        Effect.gen(function* () {
          const candidates = deduplicateLogicalRecallCandidates(metadata);
          const conflicts = yield* createRecallIdentityConflictLoader(yield* SqlClient.SqlClient)(
            undefined,
            eligibility,
            EffectArray.flatMap(candidates, candidate => (candidate.memoryId ? [candidate.memoryId] : [])),
          );
          return markRecallIdentityConflicts(candidates, conflicts);
        }),
      ),
    hydrate: (metadata: readonly RecallCandidate[], options: {readonly requireAll?: boolean} = {}) =>
      read(
        Effect.gen(function* () {
          if (metadata.length > pageSize) return yield* corrupt();
          const sql = yield* SqlClient.SqlClient;
          const hydrated: RecallCandidate[] = [];
          for (const merged of metadata) {
            const rows = yield* sql<{
              readonly candidate_json: string;
              readonly uri: string;
              readonly text_type: string | null;
            }>`
          SELECT uri, candidate_json, json_type(candidate_json, '$.text') AS text_type FROM documents WHERE uri = ${stripRecallAnchor(merged.uri)}`;
            const row = rows[0];
            if (!row) return yield* corrupt();
            const candidate = yield* decode(row);
            // Preserve merged aliases, relations, conflicts and order; hydrate only the representative body.
            if (
              isExternalResourceUri(merged.uri) &&
              !(yield* externalResourceAccess(location, merged.uri, undefined, merged.contentHash))
            ) {
              if (options.requireAll) return yield* changed();
              continue;
            }
            for (const uri of merged.equivalentUris ?? []) {
              if (
                isExternalResourceUri(uri) &&
                !(yield* externalResourceAccess(location, uri, undefined, merged.contentHash))
              )
                return yield* changed();
            }
            hydrated.push({...merged, text: candidate.text});
          }
          return hydrated;
        }),
      ),
  };
});
