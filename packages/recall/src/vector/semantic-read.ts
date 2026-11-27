import {VECTOR_SCOPE_MAPPING_VERSION} from './generation-compatibility.js';
import {Array as EffectArray} from 'effect';
import {Cause, Effect, FileSystem, Option, Path, Result, Schema} from 'effect';
import {hasReadCleanupUnconfirmed} from '@threadnote/platform/read_deadline';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {readModelSelection, selectedEmbeddingModelId} from '@threadnote/inference/models/selection';
import {type RecallEligibilityPolicy} from '../eligibility.js';
import {recallEligibilityPredicate} from '../index/eligibility.js';
import {
  combineRecallSqlPredicates,
  recallUriMatchesScopes,
  recallUriScopePredicate,
  type RecallSqlPredicate,
} from '../index/scope.js';
import {
  externalResourceAccess,
  isExternalResourceUri,
  loadExternalResourceAccess,
} from '@threadnote/store/external-resource';
import {RECALL_CHUNKER_VERSION} from '../chunker.js';
import {normalizeVector} from '@threadnote/inference/vector-search';
import {VectorIndexOperationError} from './scoring.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {
  loadRecallVectorAuthorizationKey,
  recallVectorAuthorizationKey,
  recallVectorPreparationIdentity,
  recallVectorPreparationMatches,
  recallVectorPreparationJobId,
} from './preparation-identity.js';
import {
  isServableVectorReadiness,
  RecallReadyReadBoundary,
  RecallReadyReadBoundaryError,
  recallReadyReadRequestSchema,
  recallVectorReadinessSchema,
  type RecallVectorReadiness,
  recallVectorQueryStateSchema,
  type RecallReadyReadRequest,
  type RecallVectorReadModel,
  type RecallVectorReadState,
} from '../read_boundary.js';
import {currentRecallCorpusGeneration, readRecallIndexData, type RecallIndexConfig} from '../index.js';
import {readRecallVectorMask, recallMaskedReadCompatible, recallVectorMaskPredicate} from './masked-read.js';
import {requiredNativeVectorReader, runNativeVectorRead} from './native-reader.js';
import type {NativeVectorReadRequest} from './native-reader-contract.js';
import {
  embeddingRecipe,
  generationIsCompatible,
  readActiveVectorGeneration,
  recallVectorStorage,
  vectorDatabasePath,
  vectorReadExpectation,
  verifyCurrentCorpusGeneration,
  VectorCorpusGenerationChanged,
  VectorIndexCorrupt,
  type VectorCorpusGenerationOptions,
  type VectorGenerationRow,
  type VectorReadConfig,
  type VectorReadModel,
} from '../vector-index.js';

/** The read side of the vector index: readiness, the opening of a semantic read, and its scores. */
const wireVectorModel = (manifest: VectorReadModel): RecallVectorReadModel => ({
  id: manifest.id,
  sha256: manifest.sha256,
  dimensions: manifest.dimensions ?? 0,
  ...(manifest.promptPrefixes === undefined ? {} : {promptPrefixes: manifest.promptPrefixes}),
});

const throughVectorReadBoundary = Effect.fn('vectorIndex.throughReadyReadBoundary')(function* <A>(
  boundary: ReturnType<typeof RecallReadyReadBoundary.of>,
  request: RecallReadyReadRequest,
  decode: (value: unknown) => A,
) {
  const checked = yield* Schema.decodeEffect(recallReadyReadRequestSchema, {onExcessProperty: 'error'})({
    ...request,
    config: {
      account: request.config.account,
      user: request.config.user,
      agentContextHome: request.config.agentContextHome,
      ...(request.config.manifestPath === undefined ? {} : {manifestPath: request.config.manifestPath}),
    },
  });
  const response = yield* boundary.read(checked);
  if (response.operation !== request.operation || response.outcome !== 'success')
    return yield* RecallReadyReadBoundaryError.make({reason: 'worker-failed'});
  return yield* Effect.try({
    try: () => decode(response.value),
    catch: () => RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'}),
  });
});

/** `serving-older`: the active generation is older but compatible and serves a masked read; not current. */
export type VectorIndexGenerationReadiness = RecallVectorReadiness;

/** Semantic fences run in the caller's ambient context, outside the native snapshot.
 * Build/promotion callbacks retain their separate vector-SqlClient transaction context.
 */
interface SemanticCorpusGenerationOptions<R> {
  readonly corpusGeneration?: string;
  readonly currentCorpusGeneration?: () => Effect.Effect<Option.Option<string>, unknown, R>;
}

interface SemanticScoreOptions<R> extends SemanticCorpusGenerationOptions<R> {
  readonly allowedUriScopes?: readonly string[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly limit?: number;
}

const verifySelectedCorpusGeneration = Effect.fn('vectorIndex.verifySelectedCorpusGeneration')(function* <R = never>(
  active: VectorGenerationRow,
  manifest: VectorReadModel,
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

export const vectorIndexMatchesGeneration = Effect.fn('vectorIndex.matchesGeneration')(function* (
  home: string,
  manifest: LocalModelManifest,
  corpusGeneration: string,
  authorizationKey?: string,
  readConfig?: RecallIndexConfig,
) {
  return (
    (yield* vectorIndexGenerationReadiness(home, manifest, corpusGeneration, authorizationKey, readConfig)) ===
    'current'
  );
});

/**
 * Read only the active generation metadata and retain the distinction between
 * an absent/stale derived index and structural storage failure. Callers may
 * safely schedule ordinary generation work for missing/stale state, but must
 * keep corruption behind an explicit repair boundary.
 */
export const vectorIndexGenerationReadiness = Effect.fn('vectorIndex.generationReadiness')(function* (
  home: string,
  manifest: VectorReadModel,
  corpusGeneration: string,
  authorizationKey?: string,
  readConfig?: RecallIndexConfig,
) {
  const boundary = yield* Effect.serviceOption(RecallReadyReadBoundary);
  if (Option.isSome(boundary)) {
    if (readConfig === undefined) return yield* RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
    if (readConfig.agentContextHome !== home)
      return yield* RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
    return yield* throughVectorReadBoundary(
      boundary.value,
      {
        operation: 'vector-readiness',
        config: readConfig,
        options: {
          model: wireVectorModel(manifest),
          corpusGeneration,
          ...(authorizationKey === undefined ? {} : {authorizationKey}),
        },
      },
      value => Schema.decodeUnknownSync(recallVectorReadinessSchema)(value),
    );
  }
  const active = yield* readActiveVectorGeneration(home, manifest).pipe(Effect.result);
  if (Result.isFailure(active)) return 'corrupt' as const;
  if (!active.success) return 'missing' as const;
  if (
    generationMatchesCorpus(active.success, manifest, corpusGeneration) &&
    (authorizationKey === undefined ||
      recallVectorPreparationMatches(
        active.success.job_id,
        recallVectorPreparationIdentity(corpusGeneration, authorizationKey, manifest.id, embeddingRecipe(manifest)),
      ))
  )
    return 'current' as const;
  // A readiness-only call runs the masked decision once; a read derives the readiness from its state instead.
  if (readConfig === undefined || active.success.corpus_generation === corpusGeneration) return 'stale' as const;
  const masked = yield* maskedVectorRead(readConfig, manifest, active.success, authorizationKey, corpusGeneration);
  return masked.state === 'served' ? ('serving-older' as const) : ('stale' as const);
});

/**
 * The one opening of a semantic read for a lexical generation, in process and in the ready-read worker.
 * The readiness check reads metadata only; the state read runs the masked decision at most once, and its
 * mask is what makes the opening `serving-older`.
 */
export const openSelectedSemanticVectorRead = Effect.fn('vectorIndex.openSelectedRead')(function* <R = never>(
  config: VectorReadConfig,
  manifest: VectorReadModel,
  options: SemanticCorpusGenerationOptions<R> & {readonly corpusGeneration: string},
) {
  const corpusGeneration = options.corpusGeneration;
  const authorizationKey = yield* loadRecallVectorAuthorizationKey(config);
  const readiness = yield* vectorIndexGenerationReadiness(
    config.agentContextHome,
    manifest,
    corpusGeneration,
    authorizationKey,
  );
  if (readiness === 'missing' || readiness === 'corrupt') return {readiness, corpusGeneration};
  const read = readSelectedSemanticVectorState(config, manifest, options);
  // A stale generation is read only to look for a mask. A typed read failure there is no mask (stale); a
  // defect and a lexical publication that raced the read propagate, so the caller's retry loop sees the race.
  const state =
    readiness === 'current'
      ? yield* read
      : yield* read.pipe(
          Effect.catchCauseIf(
            cause =>
              !Cause.hasInterrupts(cause) &&
              !Cause.hasDies(cause) &&
              !hasReadCleanupUnconfirmed(cause) &&
              !EffectArray.some(
                cause.reasons,
                reason => Cause.isFailReason(reason) && Schema.is(VectorCorpusGenerationChanged)(reason.error),
              ),
            () => Effect.void,
          ),
        );
  if (state?.mask !== undefined) return {readiness: 'serving-older' as const, corpusGeneration, state};
  return state !== undefined && readiness === 'current'
    ? {readiness: 'current' as const, corpusGeneration, state}
    : {readiness: 'stale' as const, corpusGeneration};
});

const maskedVectorRead = (
  config: RecallIndexConfig,
  manifest: VectorReadModel,
  active: VectorGenerationRow,
  authorizationKey: string | undefined,
  requestedGeneration: string,
) =>
  readRecallVectorMask(recallVectorStorage, config, manifest.id, vectorReadExpectation(manifest), {
    active,
    authorizationKey,
    requestedGeneration,
  });

export const selectedSemanticScoreSnapshot = Effect.fn('vectorIndex.selectedSemanticScoreSnapshot')(function* <
  R = never,
>(config: VectorReadConfig, query: string, options: SemanticScoreOptions<R> = {}) {
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = selectedEmbeddingModelId(selection, 'recall');
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

  const boundary = yield* Effect.serviceOption(RecallReadyReadBoundary);
  const wireConfig =
    config.account !== undefined && config.user !== undefined
      ? {
          account: config.account,
          user: config.user,
          agentContextHome: config.agentContextHome,
          manifestPath: config.manifestPath,
        }
      : undefined;
  const nativeRead = Option.getOrUndefined(boundary);
  if (nativeRead !== undefined && wireConfig === undefined)
    return yield* RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
  const useBoundary = nativeRead !== undefined && wireConfig !== undefined;
  const opening = useBoundary
    ? yield* throughVectorReadBoundary(
        nativeRead,
        {
          operation: 'vector-state',
          config: wireConfig,
          options: {
            model: wireVectorModel(manifest),
            ...(options.corpusGeneration === undefined ? {} : {corpusGeneration: options.corpusGeneration}),
          },
        },
        value => Schema.decodeUnknownSync(recallVectorQueryStateSchema)(value),
      )
    : options.corpusGeneration !== undefined && wireConfig !== undefined
      ? yield* openSelectedSemanticVectorRead(config, manifest, {
          ...options,
          corpusGeneration: options.corpusGeneration,
        })
      : undefined;
  if (opening !== undefined && !isServableVectorReadiness(opening.readiness))
    return {readiness: opening.readiness, corpusGeneration: opening.corpusGeneration, scores: undefined};
  const state =
    opening === undefined
      ? yield* readSelectedSemanticVectorState(config, manifest, options)
      : 'state' in opening
        ? opening.state
        : undefined;
  if (state === undefined) return undefined;
  // Custom parent callbacks remain authoritative in addition to the worker's production fence.
  yield* verifyCurrentCorpusGeneration(manifest, options);
  const normalizedQuery =
    state.chunkCount === 0
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

  const scores = useBoundary
    ? yield* throughVectorReadBoundary(
        nativeRead,
        {
          operation: 'vector-scores',
          config: wireConfig,
          options: {
            model: wireVectorModel(manifest),
            state,
            ...(Option.isNone(normalizedQuery) ? {} : {queryVector: normalizedQuery.value}),
            ...(options.corpusGeneration === undefined ? {} : {corpusGeneration: options.corpusGeneration}),
            ...(options.eligibility === undefined ? {} : {eligibility: options.eligibility}),
            ...(options.allowedUriScopes === undefined ? {} : {allowedUriScopes: options.allowedUriScopes}),
            ...(options.limit === undefined ? {} : {limit: options.limit}),
          },
        },
        value => {
          const decoded = Schema.decodeUnknownSync(
            Schema.UndefinedOr(Schema.Array(Schema.Tuple([Schema.String, Schema.Finite]))),
          )(value);
          return decoded === undefined ? undefined : new Map(decoded);
        },
      )
    : yield* readSelectedSemanticVectorScores(config, manifest, state, normalizedQuery, options);
  yield* verifyCurrentCorpusGeneration(manifest, options);
  // A masked result is bound to its mask's lexical generation, never to the served vector corpus.
  return state.mask === undefined
    ? {readiness: 'current' as const, corpusGeneration: state.corpusGeneration ?? options.corpusGeneration, scores}
    : {readiness: 'serving-older' as const, corpusGeneration: state.mask.contentGeneration, scores};
});

/** Stable scores-only API; query inference remains in the caller's foreground runtime. */
export const selectedSemanticScores = Effect.fn('vectorIndex.selectedSemanticScores')(function* <R = never>(
  config: VectorReadConfig,
  query: string,
  options: SemanticScoreOptions<R> = {},
) {
  return (yield* selectedSemanticScoreSnapshot(config, query, options))?.scores;
});

/** Model-free opening proof; the child independently checks current authorization and corpus. */
export const readSelectedSemanticVectorState = Effect.fn('vectorIndex.readSelectedState')(function* <R = never>(
  config: VectorReadConfig,
  manifest: VectorReadModel,
  options: SemanticCorpusGenerationOptions<R> = {},
) {
  const externalLocation =
    config.account !== undefined && config.user !== undefined
      ? {home: config.agentContextHome, account: config.account, user: config.user}
      : undefined;
  const externalResources = externalLocation === undefined ? {} : yield* loadExternalResourceAccess(externalLocation);
  const authorizationKey = recallVectorAuthorizationKey(externalResources);
  const matchesAuthorization = (active: VectorGenerationRow) =>
    recallVectorPreparationMatches(
      active.job_id,
      recallVectorPreparationIdentity(
        options.corpusGeneration ?? active.corpus_generation ?? '',
        authorizationKey,
        manifest.id,
        embeddingRecipe(manifest),
      ),
    );

  const activeBeforeInference = yield* readActiveVectorGeneration(config.agentContextHome, manifest);
  if (!activeBeforeInference) return undefined;
  const requested = options.corpusGeneration;
  if (
    requested !== undefined &&
    activeBeforeInference.corpus_generation !== null &&
    activeBeforeInference.corpus_generation !== requested &&
    config.account !== undefined &&
    config.user !== undefined
  ) {
    // An older generation serves only through the masked decision for the requested lexical generation.
    const masked = yield* maskedVectorRead(
      {
        account: config.account,
        user: config.user,
        agentContextHome: config.agentContextHome,
        ...(config.manifestPath === undefined ? {} : {manifestPath: config.manifestPath}),
      },
      manifest,
      activeBeforeInference,
      authorizationKey,
      requested,
    );
    // A refused decision is no state, never an error used as a signal.
    if (masked.state === 'refused') return undefined;
    if (masked.state === 'moved')
      return yield* VectorCorpusGenerationChanged.make({
        message: 'The lexical recall corpus changed while the masked vector read was opened.',
        modelId: manifest.id,
        requestedGeneration: requested,
      });
    yield* verifyCurrentCorpusGeneration(manifest, options);
    return {
      chunkCount: activeBeforeInference.chunk_count,
      generation: activeBeforeInference.generation,
      authorizationKey,
      corpusGeneration: activeBeforeInference.corpus_generation,
      mask: masked.mask,
    } satisfies RecallVectorReadState;
  }
  if (!matchesAuthorization(activeBeforeInference)) return undefined;
  yield* verifySelectedCorpusGeneration(activeBeforeInference, manifest, options);
  return {
    chunkCount: activeBeforeInference.chunk_count,
    generation: activeBeforeInference.generation,
    authorizationKey,
    ...(activeBeforeInference.corpus_generation === null
      ? {}
      : {corpusGeneration: activeBeforeInference.corpus_generation}),
  } satisfies RecallVectorReadState;
});

/** Model-free scoring, authorization and closing proof; never starts inference or builds an index. */
export const readSelectedSemanticVectorScores = Effect.fn('vectorIndex.readSelectedScores')(function* <R = never>(
  config: VectorReadConfig,
  manifest: VectorReadModel,
  state: RecallVectorReadState,
  normalizedQuery: Option.Option<readonly number[]>,
  options: SemanticScoreOptions<R> = {},
  validateCanonicalScores = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = vectorDatabasePath(path, config.agentContextHome, manifest.id);
  if (!(yield* fs.exists(databasePath))) return undefined;
  const externalLocation =
    config.account !== undefined && config.user !== undefined
      ? {home: config.agentContextHome, account: config.account, user: config.user}
      : undefined;
  const externalResources = externalLocation === undefined ? {} : yield* loadExternalResourceAccess(externalLocation);
  const authorizationKey = recallVectorAuthorizationKey(externalResources);
  if (authorizationKey !== state.authorizationKey) return undefined;
  const mask = state.mask;
  // A masked read binds its scores to the lexical generation its mask was computed for.
  if (mask !== undefined && options.corpusGeneration !== mask.contentGeneration)
    return yield* VectorCorpusGenerationChanged.make({
      message: 'The masked vector read no longer matches the requested lexical recall corpus.',
      modelId: manifest.id,
      requestedGeneration: options.corpusGeneration ?? '',
    });
  if (mask !== undefined) {
    // Never serve an older generation on the caller's word: the active row must still allow it for this key.
    const active = yield* readActiveVectorGeneration(config.agentContextHome, manifest);
    if (
      active === undefined ||
      active.generation !== state.generation ||
      active.corpus_generation !== state.corpusGeneration ||
      !recallMaskedReadCompatible(active, vectorReadExpectation(manifest), authorizationKey)
    )
      return undefined;
  }
  // The native reader checks the served generation's own corpus; the lexical fence uses the mask generation.
  const vectorCorpusGeneration = mask === undefined ? options.corpusGeneration : state.corpusGeneration;
  const suppliedExternal = options.eligibility?.externalResources;
  const effectiveExternal =
    suppliedExternal === undefined
      ? externalResources
      : EffectRecord.fromEntries(
          EffectArray.filter(
            EffectRecord.toEntries(externalResources),
            ([uri, fingerprint]) => suppliedExternal[uri] === fingerprint,
          ),
        );
  const eligibility: RecallEligibilityPolicy = {
    ...(options.eligibility ?? {kind: 'candidate-policy', authority: 'any', projects: {mode: 'unrestricted'}}),
    externalResources: effectiveExternal,
  };
  const nativeRequest: NativeVectorReadRequest = {
    dbPath: databasePath,
    generation: state.generation,
    model: {
      id: manifest.id,
      sha256: manifest.sha256,
      dimensions: manifest.dimensions ?? 0,
      embeddingRecipe: embeddingRecipe(manifest),
      chunkerVersion: RECALL_CHUNKER_VERSION,
    },
    expectedPreparationJobId: recallVectorPreparationJobId(
      recallVectorPreparationIdentity(
        vectorCorpusGeneration ?? state.corpusGeneration ?? '',
        authorizationKey,
        manifest.id,
        embeddingRecipe(manifest),
      ),
    ),
    preparationIdentitySuffix: EffectString.slice(1)(
      JSON.stringify([authorizationKey, manifest.id, embeddingRecipe(manifest), RECALL_CHUNKER_VERSION]),
    ),
    ...(vectorCorpusGeneration === undefined ? {} : {corpusGeneration: vectorCorpusGeneration}),
    limit: options.limit ?? 500,
    // Masked URIs are excluded inside SQL, so the top-K stays complete. Alias rows need their own exclusion.
    selection: recallVectorMaskPredicate(
      vectorChunkSelectionPredicate(eligibility, options.allowedUriScopes),
      'chunk.uri',
      mask,
    ),
    aliasScope: recallVectorMaskPredicate(
      recallUriScopePredicate('alias', options.allowedUriScopes),
      'alias.uri',
      mask,
    ),
    aliasEligibility: recallEligibilityPredicate('chunk', eligibility, false),
  };
  const query = Option.getOrUndefined(normalizedQuery);
  const binding = yield* requiredNativeVectorReader;
  const selectedRead = Effect.gen(function* () {
    // Evaluate the independent lexical proof before native work, but defer its
    // failure until metadata reaches the old callback position. Schema/count,
    // generation/preparation and requested-corpus outcomes keep their precedence.
    const openingCorpus = yield* verifyCurrentCorpusGeneration(manifest, options).pipe(Effect.result);
    const result = yield* runNativeVectorRead(binding, nativeRequest, query);
    if (result.corpusCheckRequired && Result.isFailure(openingCorpus)) return yield* Effect.fail(openingCorpus.failure);
    switch (result.status) {
      case 'success':
        return new Map(EffectArray.map(result.scores, value => [value.uri, value.score] as const));
      case 'absent':
        return undefined;
      case 'corrupt':
        return yield* VectorIndexCorrupt.make({modelId: manifest.id, message: result.message});
      case 'corpus-changed':
        return yield* VectorCorpusGenerationChanged.make({
          modelId: manifest.id,
          requestedGeneration: nativeRequest.corpusGeneration ?? '',
          message: result.message,
        });
      case 'operation-error':
        return yield* VectorIndexOperationError.make({message: result.message});
      case 'cancelled':
        return yield* Effect.interrupt;
    }
  });
  const scores = yield* selectedRead;
  // The SQLite transaction pins the vector snapshot. Re-check the independently
  // changing lexical corpus after releasing that read snapshot so a long paged
  // scan cannot return scores for a corpus that was superseded mid-query.
  yield* verifyCurrentCorpusGeneration(manifest, options);
  if (scores !== undefined) {
    for (const uri of scores.keys()) {
      if (!recallUriMatchesScopes(uri, options.allowedUriScopes)) {
        scores.delete(uri);
        continue;
      }
      if (
        isExternalResourceUri(uri) &&
        (externalLocation === undefined ||
          !(yield* externalResourceAccess(externalLocation, uri, undefined, externalResources[uri])))
      )
        scores.delete(uri);
    }
  }
  if (
    externalLocation !== undefined &&
    recallVectorAuthorizationKey(yield* loadExternalResourceAccess(externalLocation)) !== authorizationKey
  )
    return undefined;
  // A masked read always proves each scored URI against the current lexical document, on every path.
  if ((validateCanonicalScores || mask !== undefined) && scores !== undefined) {
    if (config.account === undefined || config.user === undefined) return undefined;
    const current = yield* readRecallIndexData(
      {
        account: config.account,
        user: config.user,
        agentContextHome: config.agentContextHome,
        manifestPath: config.manifestPath,
      },
      {
        includeInactive: false,
        requiredUris: [...scores.keys()],
        query: '',
        limit: Math.max(1, scores.size),
        allowedUriScopes: options.allowedUriScopes,
        eligibility: options.eligibility,
      },
    );
    const currentUris = new Set(EffectArray.map(current.candidates, candidate => candidate.uri));
    for (const uri of scores.keys()) if (!currentUris.has(uri)) scores.delete(uri);
    yield* verifyCurrentCorpusGeneration(manifest, options);
    if (mask !== undefined && options.currentCorpusGeneration === undefined) {
      // With a callback the fence above already proved the mask generation; without one, read it here.
      const lexical = yield* currentRecallCorpusGeneration({
        account: config.account,
        user: config.user,
        agentContextHome: config.agentContextHome,
        manifestPath: config.manifestPath,
      });
      if (Option.isNone(lexical) || lexical.value !== mask.contentGeneration)
        return yield* VectorCorpusGenerationChanged.make({
          message: 'The lexical recall corpus changed while a masked vector read was in progress.',
          modelId: manifest.id,
          requestedGeneration: mask.contentGeneration,
        });
    }
    const closing = yield* readActiveVectorGeneration(config.agentContextHome, manifest);
    if (
      closing?.generation !== state.generation ||
      (externalLocation !== undefined &&
        recallVectorAuthorizationKey(yield* loadExternalResourceAccess(externalLocation)) !== authorizationKey)
    )
      return undefined;
  }
  return scores;
});

function vectorChunkSelectionPredicate(
  eligibilityPolicy: RecallEligibilityPolicy | undefined,
  allowedUriScopes: readonly string[] | undefined,
): RecallSqlPredicate {
  const eligibility = recallEligibilityPredicate('chunk', eligibilityPolicy, false);
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

function generationMatchesCorpus(
  generation: VectorGenerationRow,
  manifest: VectorReadModel,
  corpusGeneration: string,
): boolean {
  return (
    generation.corpus_generation === corpusGeneration &&
    generation.scope_mapping_version === VECTOR_SCOPE_MAPPING_VERSION &&
    generationIsCompatible(generation, manifest)
  );
}
