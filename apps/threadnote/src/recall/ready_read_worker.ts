import type {SecureRandom} from 'effect/crypto';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import * as BunStdio from '@effect/platform-bun/BunStdio';
import {fromPromise} from '@threadnote/platform/errors';
import {succeedUndefined} from '@threadnote/platform/optional';
import {ExternalSourcePolicy} from '@threadnote/store/external-resource';
import {
  Array as EffectArray,
  Cause,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  Scope,
  Stdio,
  Stream,
} from 'effect';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import {
  readRecallCodeLinks,
  readRecallExactMatches,
  readRecallIndexData,
  readRecallIndexDataBatch,
  readRecallMemoryIdentities,
  readRecallMemoryLinks,
  recallIndexStatus,
  currentRecallCorpusGeneration,
  RecallReadyReadUnavailable,
} from '@threadnote/recall/index';
import {
  recallReadyReadRequestSchema,
  recallReadyReadResponseSchema,
  RecallReadyReadBoundaryError,
  type RecallReadyReadObservation,
  type RecallReadyReadRequest,
  type RecallReadyReadResponse,
} from '@threadnote/recall/read_boundary';
import {
  recallVectorStorage,
  readSelectedSemanticVectorState,
  readSelectedSemanticVectorScores,
  vectorIndexGenerationReadiness,
  loadRecallVectorAuthorizationKey,
} from '@threadnote/recall/vector-index';
import type {MemoryRecord} from '@threadnote/memory/document';
import type {RecallIndexQueryDiagnostics, RecallReadyReadState} from '@threadnote/recall/index';
import {CallerReadCancellation, hasReadCleanupUnconfirmed} from '@threadnote/platform/read_deadline';
import type {RecallSemanticPreflight} from '@threadnote/recall/read_boundary';
import {negativeSemanticReadinessHint} from '@threadnote/recall/vector/negative-readiness';

import {
  RECALL_READY_READ_INPUT_BYTES,
  RECALL_READY_READ_OUTPUT_BYTES,
  recallReadyReadBinding,
} from './ready_read_protocol.js';
export {RECALL_READY_READ_INPUT_BYTES, RECALL_READY_READ_OUTPUT_BYTES, recallReadyReadBinding};

const readWorkerPolicyLayer = Layer.unwrap(
  fromPromise('load ready-read external policy', async () => {
    const [{integrationExternalSourcePolicyLayer}, {sourceConfigurationLayer}] = await Promise.all([
      import('../integrations/access-policy.js'),
      import('../integrations/config.js'),
    ]);
    return integrationExternalSourcePolicyLayer.pipe(Layer.provideMerge(sourceConfigurationLayer));
  }).pipe(Effect.orDie),
);
const readWorkerResourceStoreLayer = Layer.unwrap(
  fromPromise('load ready-read store', async () => {
    const [{ResourceStore}, {recallResourceInvalidationLayer}] = await Promise.all([
      import('@threadnote/store/resource-store'),
      import('@threadnote/recall/resource-invalidation'),
    ]);
    return ResourceStore.layer.pipe(Layer.provideMerge(recallResourceInvalidationLayer));
  }).pipe(Effect.orDie),
);
const workerPlatform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunStdio.layer,
  cryptoLayer,
  SystemInfo.layer,
);

/** Full composition for callers supplying the worker's services directly. */
export const readyRecallReadWorkerLayer = readWorkerResourceStoreLayer.pipe(
  Layer.provideMerge(readWorkerPolicyLayer),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.unwrap(
        fromPromise(
          'load direct worker platform',
          async () => (await import('@effect/platform-bun/BunServices')).layer,
        ).pipe(Effect.orDie),
      ),
      cryptoLayer,
      SystemInfo.layer,
    ),
  ),
);

// External admission traverses the filesystem on every proof. Only defer constructing the policy
// and its configuration services until a source is found. Every lookup still reads current configuration.
export const readyRecallReadWorkerStartupLayer = Layer.effect(
  ExternalSourcePolicy,
  Effect.gen(function* () {
    const platform = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | SystemInfo | SecureRandom.SecureRandom
    >();
    const scope = yield* Scope.Scope;
    const policy = yield* Effect.cached(
      Layer.buildWithScope(readWorkerPolicyLayer, scope).pipe(
        Effect.map(Context.get(ExternalSourcePolicy)),
        Effect.provide(platform),
      ),
    );
    return ExternalSourcePolicy.of({
      current: (location, sourceId, provider) =>
        Effect.flatMap(policy, value => value.current(location, sourceId, provider)),
      evidenceFingerprint: (location, sourceId, provider) =>
        Effect.flatMap(policy, value => value.evidenceFingerprint?.(location, sourceId, provider) ?? succeedUndefined),
    });
  }),
).pipe(Layer.provideMerge(workerPlatform));

type ResourceReadRequest = Extract<RecallReadyReadRequest, {operation: 'sections' | 'memory-connections'}>;
const serveResourceRead = Effect.fn('recall.serveReadyResourceRead')(function* (request: ResourceReadRequest) {
  switch (request.operation) {
    case 'sections': {
      const [{serveRecallSections}, {RECALL_PREFLIGHT_METADATA_MILLISECONDS}] = yield* fromPromise(
        'load ready recall sections',
        () => Promise.all([import('@threadnote/recall/sections_read'), import('@threadnote/recall/runtime')]),
      ).pipe(Effect.orDie);
      const model = request.options.mode === 'baseline' ? request.options.semanticPreflightModel : undefined;
      const callerCancelled = yield* CallerReadCancellation;
      const semanticPreflight =
        model === undefined
          ? undefined
          : yield* Effect.gen(function* () {
              const readiness = yield* negativeSemanticReadinessHint(request.config, model, recallVectorStorage);
              return {model, readiness} satisfies RecallSemanticPreflight;
            }).pipe(
              Effect.catchCauseIf(
                cause => !Cause.hasInterrupts(cause) && !hasReadCleanupUnconfirmed(cause),
                () => Effect.succeed({model, readiness: 'unknown' as const}),
              ),
              work =>
                callerCancelled
                  ? work
                  : work.pipe(
                      Effect.timeoutOrElse({
                        duration: RECALL_PREFLIGHT_METADATA_MILLISECONDS,
                        orElse: () => Effect.succeed({model, readiness: 'unknown' as const}),
                      }),
                    ),
            );
      // Read-only preflight precedes the baseline's final canonical and permission proof.
      const sections = yield* serveRecallSections(request.config, request.options);
      return semanticPreflight === undefined ? sections : {...sections, semanticPreflight};
    }
    case 'memory-connections': {
      const [{retrieveRecallMemoryConnections}, {readLocalMemoryRecordsByUri}] = yield* fromPromise(
        'load ready memory connections',
        () => Promise.all([import('@threadnote/recall/memory/connections'), import('@threadnote/memory/local-path')]),
      ).pipe(Effect.orDie);
      const instant = DateTime.make(request.options.now);
      if (Option.isNone(instant)) return yield* RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
      return yield* retrieveRecallMemoryConnections(request.config, {
        ...request.options,
        now: DateTime.toDateUtc(instant.value),
        readRecords: uris => readLocalMemoryRecordsByUri(request.config, uris),
      });
    }
  }
});

/** Complete direct ready reads, including their live canonical and external authorization fences. */
type ResourceReadEffect = ReturnType<typeof serveResourceRead>;
const serveRecallReadyReadWith = Effect.fn('recall.serveReadyRead')(function* <R>(
  request: RecallReadyReadRequest,
  serveResource: (
    request: ResourceReadRequest,
  ) => Effect.Effect<Effect.Success<ResourceReadEffect>, Effect.Error<ResourceReadEffect>, R>,
) {
  const observations: RecallReadyReadObservation[] = [];
  let maintenanceRequested = false;
  const observe = (value: RecallReadyReadObservation) => {
    if (observations.length >= 1024) throw RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
    observations.push(value);
  };
  const onReadState = (value: RecallReadyReadState) => observe({kind: 'state', value});
  const onQueryDiagnostics = (selectionOrdinal?: number) => (value: RecallIndexQueryDiagnostics) =>
    Effect.sync(() => observe({kind: 'query', ...(selectionOrdinal === undefined ? {} : {selectionOrdinal}), value}));
  const onCanonicalMismatch = (value: number) => observe({kind: 'mismatch', value});
  const program = Effect.gen(function* () {
    switch (request.operation) {
      case 'sections':
      case 'memory-connections':
        return yield* serveResource(request);
      case 'vector-readiness': {
        const corpus = yield* currentRecallCorpusGeneration(request.config);
        if (Option.isNone(corpus) || corpus.value !== request.options.corpusGeneration) return 'stale';
        const authorizationKey = yield* loadRecallVectorAuthorizationKey(request.config);
        if (request.options.authorizationKey !== undefined && request.options.authorizationKey !== authorizationKey)
          return 'stale';
        return yield* vectorIndexGenerationReadiness(
          request.config.agentContextHome,
          request.options.model,
          request.options.corpusGeneration,
          authorizationKey,
        );
      }
      case 'vector-state': {
        const current = yield* currentRecallCorpusGeneration(request.config);
        if (Option.isNone(current)) return {readiness: 'lexical-unavailable' as const};
        const corpusGeneration = current.value;
        if (request.options.corpusGeneration !== undefined && request.options.corpusGeneration !== corpusGeneration)
          return {readiness: 'stale' as const, corpusGeneration};
        const authorizationKey = yield* loadRecallVectorAuthorizationKey(request.config);
        const readiness = yield* vectorIndexGenerationReadiness(
          request.config.agentContextHome,
          request.options.model,
          corpusGeneration,
          authorizationKey,
        );
        if (readiness !== 'current') return {readiness, corpusGeneration};
        const state = yield* readSelectedSemanticVectorState(request.config, request.options.model, {
          corpusGeneration,
          currentCorpusGeneration: () => currentRecallCorpusGeneration(request.config),
        });
        return state === undefined
          ? {readiness: 'stale' as const, corpusGeneration}
          : {readiness: 'current' as const, corpusGeneration, state};
      }
      case 'vector-scores': {
        const generation = request.options.corpusGeneration ?? request.options.state.corpusGeneration;
        if (generation === undefined) return undefined;
        const value = yield* readSelectedSemanticVectorScores(
          request.config,
          request.options.model,
          request.options.state,
          Option.fromUndefinedOr(request.options.queryVector),
          {
            corpusGeneration: generation,
            allowedUriScopes: request.options.allowedUriScopes,
            eligibility: request.options.eligibility,
            limit: request.options.limit,
            currentCorpusGeneration: () => currentRecallCorpusGeneration(request.config),
          },
          true,
        );
        return value === undefined ? undefined : EffectArray.fromIterable(value);
      }
      case 'status':
        return yield* recallIndexStatus(request.config, request.options.includeInactive);
      case 'generation':
        return Option.getOrNull(yield* currentRecallCorpusGeneration(request.config));
      case 'data':
        return yield* readRecallIndexData(request.config, {
          ...request.options,
          onReadState,
          onQueryDiagnostics: onQueryDiagnostics(),
        });
      case 'batch':
        return yield* readRecallIndexDataBatch(request.config, {
          ...request.options,
          onReadState,
          selections: EffectArray.map(request.options.selections, (selection, selectionOrdinal) => ({
            ...selection,
            onQueryDiagnostics: onQueryDiagnostics(selectionOrdinal),
          })),
        });
      case 'exact':
        return yield* readRecallExactMatches(request.config, {...request.options, onReadState});
      case 'code-links':
        return yield* readRecallCodeLinks(request.config, {
          ...request.options,
          onReadState,
          onCanonicalMismatch,
          onSearchTruncated: value => observe({kind: 'code-truncated', value}),
        });
      case 'memory-links': {
        const parsedInstant =
          request.options.sourceCurrentAt === undefined ? undefined : DateTime.make(request.options.sourceCurrentAt);
        if (parsedInstant !== undefined && Option.isNone(parsedInstant))
          return yield* RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
        const sourceCurrentAt =
          parsedInstant !== undefined && Option.isSome(parsedInstant)
            ? DateTime.toDateUtc(parsedInstant.value)
            : undefined;
        return yield* readRecallMemoryLinks(request.config, {
          ...request.options,
          sourceCurrentAt,
          onReadState,
          onCanonicalMismatch,
          onSearchTruncated: value => observe({kind: 'memory-truncated', value}),
          onRawRows: value => observe({kind: 'rows', value}),
          onCanonicalReread: value => observe({kind: 'reread', value}),
          onCanonicalRecords: (records: readonly MemoryRecord[]) =>
            observe({
              kind: 'records',
              value: EffectArray.map(records, record => ({uri: record.uri, content: record.content})),
            }),
        });
      }
      case 'identities':
        return yield* readRecallMemoryIdentities(request.config, request.options);
    }
  });
  const result = yield* program.pipe(
    Effect.provideService(RecallEmbeddingWakePort, () =>
      Effect.sync(() => {
        maintenanceRequested = true;
      }),
    ),
    Effect.result,
  );
  return {
    protocol: 1,
    binding: recallReadyReadBinding(request),
    operation: request.operation,
    observations,
    maintenanceRequested,
    ...(Result.isSuccess(result)
      ? {outcome: 'success' as const, value: result.success}
      : {
          outcome: Schema.is(RecallReadyReadUnavailable)(result.failure)
            ? ('unavailable' as const)
            : ('failed' as const),
        }),
  } satisfies RecallReadyReadResponse;
});

export const serveRecallReadyRead = (request: RecallReadyReadRequest) =>
  serveRecallReadyReadWith(request, serveResourceRead);

const serveReadyRecallReadWithDeferredStore = (request: RecallReadyReadRequest) =>
  serveRecallReadyReadWith(request, resourceRequest =>
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The one-shot worker owns this layer for the selected request.
    serveResourceRead(resourceRequest).pipe(Effect.provide(readWorkerResourceStoreLayer)),
  );

const readRequest = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const encoder = new TextEncoder();
  const state = yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => ({chunks: [] as string[], bytes: 0}),
      (state, chunk) => {
        const bytes = state.bytes + encoder.encode(chunk).byteLength;
        if (bytes > RECALL_READY_READ_INPUT_BYTES)
          return Effect.fail(RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'}));
        state.chunks.push(chunk);
        return Effect.succeed({chunks: state.chunks, bytes});
      },
    ),
  );
  return yield* Schema.decodeEffect(Schema.fromJsonString(recallReadyReadRequestSchema), {onExcessProperty: 'error'})(
    EffectArray.join(state.chunks, ''),
  );
});

/** Signal-transparent one-shot worker; the parent owns its process and every pipe. */
const makeWorkerProgram = <R>(
  serve: (request: RecallReadyReadRequest) => Effect.Effect<RecallReadyReadResponse, never, R>,
) =>
  Effect.gen(function* () {
    const request = yield* readRequest;
    const served = yield* serve(request);
    const encode = (value: RecallReadyReadResponse) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const complete = encode(served);
    // An oversize result stays bound to its request and names its reason instead of failing opaquely.
    const response: RecallReadyReadResponse =
      complete.byteLength <= RECALL_READY_READ_OUTPUT_BYTES
        ? served
        : {
            protocol: served.protocol,
            binding: served.binding,
            operation: served.operation,
            observations: [],
            maintenanceRequested: served.maintenanceRequested,
            outcome: 'failed',
            failure: 'output-limit',
          };
    const bytes = response === served ? complete : encode(response);
    yield* Schema.decodeEffect(recallReadyReadResponseSchema)(response);
    const stdio = yield* Stdio.Stdio;
    yield* Stream.run(Stream.make(bytes), stdio.stdout({endOnDone: false}));
  }).pipe(Effect.catchCause(() => Effect.fail(RecallReadyReadBoundaryError.make({reason: 'worker-failed'}))));

export const recallReadyReadWorkerProgram = makeWorkerProgram(serveRecallReadyRead);
export const recallReadyReadWorkerStartupProgram = makeWorkerProgram(serveReadyRecallReadWithDeferredStore);
