import {readLocalMemoryRecordsByUri} from '@threadnote/memory/local-path';
import {serveRecallSections} from '@threadnote/recall/sections_read';
import {retrieveRecallMemoryConnections} from '@threadnote/recall/memory/connections';
import {ResourceStore} from '@threadnote/store/resource-store';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {
  Array as EffectArray,
  DateTime,
  Effect,
  Layer,
  Option,
  Record as EffectRecord,
  Result,
  Schema,
  Stdio,
  Stream,
} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import * as BunServices from '@effect/platform-bun/BunServices';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import {integrationExternalSourcePolicyLayer} from '../integrations/access-policy.js';
import {sourceConfigurationLayer} from '../integrations/config.js';
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
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  readSelectedSemanticVectorState,
  readSelectedSemanticVectorScores,
  vectorIndexGenerationReadiness,
  loadRecallVectorAuthorizationKey,
} from '@threadnote/recall/vector-index';
import type {MemoryRecord} from '@threadnote/memory/document';
import type {RecallIndexQueryDiagnostics, RecallReadyReadState} from '@threadnote/recall/index';

export const RECALL_READY_READ_INPUT_BYTES = 256 * 1024;
export const RECALL_READY_READ_OUTPUT_BYTES = 16 * 1024 * 1024;

// Reuse production authorization/configuration without constructing graph or model services.
const workerPlatform = Layer.mergeAll(BunServices.layer, cryptoLayer, SystemInfo.layer);
const readWorkerDependencies = integrationExternalSourcePolicyLayer.pipe(
  Layer.provideMerge(sourceConfigurationLayer.pipe(Layer.provideMerge(workerPlatform))),
);

export const readyRecallReadWorkerLayer = ResourceStore.layer.pipe(
  Layer.provideMerge(Layer.merge(readWorkerDependencies, recallResourceInvalidationLayer)),
);

export function recallReadyReadBinding(request: RecallReadyReadRequest): string {
  return sha256HexSync(
    JSON.stringify(Schema.encodeSync(recallReadyReadRequestSchema)(request), (_key, value: unknown) =>
      isJsonObject(value)
        ? EffectRecord.fromEntries(
            EffectRecord.toEntries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
          )
        : value,
    ),
  );
}

/** Complete direct ready reads, including their live canonical and external authorization fences. */
export const serveRecallReadyRead = Effect.fn('recall.serveReadyRead')(function* (request: RecallReadyReadRequest) {
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
        return yield* serveRecallSections(request.config, request.options);
      case 'memory-connections': {
        const instant = DateTime.make(request.options.now);
        if (Option.isNone(instant)) return yield* RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
        return yield* retrieveRecallMemoryConnections(request.config, {
          ...request.options,
          now: DateTime.toDateUtc(instant.value),
          readRecords: uris => readLocalMemoryRecordsByUri(request.config, uris),
        });
      }
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
export const recallReadyReadWorkerProgram = Effect.gen(function* () {
  const request = yield* readRequest;
  const response = yield* serveRecallReadyRead(request);
  const bytes = new TextEncoder().encode(`${JSON.stringify(response)}\n`);
  if (bytes.byteLength > RECALL_READY_READ_OUTPUT_BYTES)
    return yield* RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
  yield* Schema.decodeEffect(recallReadyReadResponseSchema)(response);
  const stdio = yield* Stdio.Stdio;
  yield* Stream.run(Stream.make(bytes), stdio.stdout({endOnDone: false}));
}).pipe(Effect.catchCause(() => Effect.fail(RecallReadyReadBoundaryError.make({reason: 'worker-failed'}))));
