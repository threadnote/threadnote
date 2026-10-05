import {Context, Effect, Exit, Layer, Path, Scope, Semaphore} from 'effect';
import * as AiError from 'effect/ai/AiError';
import * as EmbeddingModel from 'effect/ai/EmbeddingModel';
import type {LocalModelManifest} from '../models/catalog.js';
import {LlamaCppEngine, type LlamaCppDiagnostics} from './llama-cpp-engine.js';
import {llamaEmbeddingModelLayer} from './embedding.js';
import {nodeLlamaCppEngineLayer} from './node-llama-cpp.js';
import {llamaRerankerLayer, Reranker, type RerankerShape} from './reranker.js';
import {
  llamaStructuredGeneratorLayer,
  StructuredGenerator,
  type StructuredGenerationError,
  type StructuredGenerationRequest,
} from './structured-generator.js';
import type {InferenceInterrupted, ModelSessionError, NativeRuntimeError, RerankingFailed} from './errors.js';
import type {SystemInfo} from '@threadnote/platform/system';

const EMBEDDING_BATCH_SIZE = 32;
const GENERATION_CONTEXT_MINIMUM = 2_048;
const GENERATION_CONTEXT_RESERVE = 512;
const GENERATION_CONTEXT_QUANTUM = 1_024;

export interface LocalEmbeddingRequest {
  readonly embeddingContextPoolSize?: 1 | 2 | 4 | 8;
  readonly inputs: readonly string[];
  readonly manifest: LocalModelManifest;
  readonly modelPath: string;
}

export type LocalEmbeddingError = AiError.AiError | ModelSessionError;

export interface LocalRerankingRequest {
  readonly documents: readonly string[];
  readonly manifest: LocalModelManifest;
  readonly modelPath: string;
  readonly query: string;
}

export interface LocalGenerationRequest extends StructuredGenerationRequest {
  readonly manifest: LocalModelManifest;
  readonly modelPath: string;
}

export interface LocalModelRuntimeShape {
  readonly diagnostics: Effect.Effect<LlamaCppDiagnostics, NativeRuntimeError>;
  readonly embedMany: (
    request: LocalEmbeddingRequest,
  ) => Effect.Effect<readonly (readonly number[])[], LocalEmbeddingError>;
  readonly generate: (request: LocalGenerationRequest) => Effect.Effect<unknown, StructuredGenerationError>;
  readonly rerank: (
    request: LocalRerankingRequest,
  ) => Effect.Effect<readonly number[], InferenceInterrupted | RerankingFailed | ModelSessionError>;
}

/**
 * Threadnote-owned inference port. Domain code depends on this service, never
 * Effect AI or node-llama-cpp directly. Tests can replace it with a pure Layer.
 */
export class LocalModelRuntime extends Context.Service<LocalModelRuntime, LocalModelRuntimeShape>()(
  '@threadnote/inference/engine/local-model-runtime/LocalModelRuntime',
) {
  static readonly nativeLayer = localModelRuntimeLayer();
}

export function localModelRuntimeLayer(): Layer.Layer<LocalModelRuntime, NativeRuntimeError, Path.Path | SystemInfo>;
export function localModelRuntimeLayer<R>(
  engineLayer: Layer.Layer<LlamaCppEngine, NativeRuntimeError, R>,
): Layer.Layer<LocalModelRuntime, NativeRuntimeError, R>;
export function localModelRuntimeLayer<R>(engineLayer?: Layer.Layer<LlamaCppEngine, NativeRuntimeError, R>) {
  if (engineLayer === undefined) return localModelRuntimeLayer(nodeLlamaCppEngineLayer());
  return Layer.fromBuild((_memoMap, scope) =>
    Effect.gen(function* () {
      const inferencePermits = yield* Semaphore.make(1);
      const engineRequirements = yield* Effect.context<R>();
      const engineContext: Effect.Effect<Context.Context<LlamaCppEngine>, NativeRuntimeError> = yield* Effect.cached(
        Layer.buildWithScope(engineLayer, scope).pipe(Effect.provide(engineRequirements)),
      );
      const embeddingModels = new Map<string, Effect.Effect<EmbeddingModel.EmbeddingModel, LocalEmbeddingError>>();
      const rerankers = new Map<
        string,
        Effect.Effect<RerankerShape, InferenceInterrupted | RerankingFailed | ModelSessionError>
      >();
      return Context.make(LocalModelRuntime, {
        diagnostics: engineContext.pipe(Effect.map(context => Context.get(context, LlamaCppEngine).diagnostics)),
        embedMany: request =>
          inferencePermits.withPermit(embedManyNative(request, scope, engineContext, embeddingModels)),
        generate: request => inferencePermits.withPermit(generateNative(request, engineContext)),
        rerank: request => inferencePermits.withPermit(rerankNative(request, scope, engineContext, rerankers)),
      });
    }),
  );
}

function embedManyNative(
  request: LocalEmbeddingRequest,
  scope: Scope.Scope,
  engineContext: Effect.Effect<Context.Context<LlamaCppEngine>, NativeRuntimeError>,
  models: Map<string, Effect.Effect<EmbeddingModel.EmbeddingModel, LocalEmbeddingError>>,
) {
  const dimensions = request.manifest.dimensions;
  if (!dimensions) {
    return Effect.die(new Error(`Embedding dimensions are missing for ${request.manifest.id}.`));
  }
  const key = `${modelCacheKey(request)}\u0000embedding-contexts:${request.embeddingContextPoolSize ?? 'default'}`;
  return Effect.gen(function* () {
    let model = models.get(key);
    if (!model) {
      model = yield* Effect.cached(
        Effect.gen(function* () {
          const engine = yield* engineContext;
          const services = yield* Layer.buildWithScope(
            llamaEmbeddingModelLayer({
              contextSize: request.manifest.contextLimit,
              darwinArm64EmbeddingGpuLayers: request.manifest.runtime.darwinArm64EmbeddingGpuLayers,
              dimensions,
              ...(request.embeddingContextPoolSize === undefined
                ? {}
                : {embeddingContextPoolSize: request.embeddingContextPoolSize}),
              modelId: request.manifest.id,
              modelPath: request.modelPath,
            }),
            scope,
          ).pipe(Effect.provide(engine));
          return Context.get(services, EmbeddingModel.EmbeddingModel);
        }),
      );
      models.set(key, model);
    }
    const embedding = yield* model;
    const vectors: number[][] = [];
    for (let start = 0; start < request.inputs.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = yield* embedding.embedMany(request.inputs.slice(start, start + EMBEDDING_BATCH_SIZE));
      vectors.push(...batch.embeddings.map(item => [...item.vector]));
    }
    return vectors;
  }).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? Effect.sync(() => models.delete(key)) : Effect.void)));
}

function rerankNative(
  request: LocalRerankingRequest,
  scope: Scope.Scope,
  engineContext: Effect.Effect<Context.Context<LlamaCppEngine>, NativeRuntimeError>,
  models: Map<string, Effect.Effect<RerankerShape, InferenceInterrupted | RerankingFailed | ModelSessionError>>,
) {
  if (request.manifest.role !== 'reranker') {
    return Effect.die(new Error(`Model ${request.manifest.id} is not a reranker.`));
  }
  const key = modelCacheKey(request);
  return Effect.gen(function* () {
    let model = models.get(key);
    if (!model) {
      model = yield* Effect.cached(
        Effect.gen(function* () {
          const engine = yield* engineContext;
          const services = yield* Layer.buildWithScope(
            llamaRerankerLayer({
              contextSize: request.manifest.contextLimit,
              modelId: request.manifest.id,
              modelPath: request.modelPath,
              ...(request.manifest.architecture === 'modern-bert'
                ? {rankingTemplate: '[CLS]{{query}}[SEP]{{document}}[SEP]'}
                : {}),
            }),
            scope,
          ).pipe(Effect.provide(engine));
          return Context.get(services, Reranker);
        }),
      );
      models.set(key, model);
    }
    const reranker = yield* model;
    return yield* reranker.rank(request.query, request.documents);
  }).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? Effect.sync(() => models.delete(key)) : Effect.void)));
}

function generateNative(
  request: LocalGenerationRequest,
  engineContext: Effect.Effect<Context.Context<LlamaCppEngine>, NativeRuntimeError>,
) {
  if (request.manifest.role !== 'generation') {
    return Effect.die(new Error(`Model ${request.manifest.id} is not a generation model.`));
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const engine = yield* engineContext;
      const services = yield* Layer.buildWithScope(
        llamaStructuredGeneratorLayer({
          contextSize: localGenerationContextSize(request),
          modelId: request.manifest.id,
          modelPath: request.modelPath,
        }),
        scope,
      ).pipe(Effect.provide(engine));
      return yield* Context.get(services, StructuredGenerator).generate(request);
    }),
  );
}

/**
 * Allocate enough native context for the concrete request, rather than the
 * model's maximum on every small metadata enrichment. UTF-8 bytes are a
 * conservative tokenizer-independent upper bound for prompt material; larger
 * consolidation requests still receive the manifest's full context window.
 */
export function localGenerationContextSize(request: LocalGenerationRequest): number {
  const inputBytes = new TextEncoder().encode(
    [request.system ?? '', request.prompt, JSON.stringify(request.jsonSchema)].join('\n'),
  ).byteLength;
  const requested = roundUp(
    Math.max(GENERATION_CONTEXT_MINIMUM, inputBytes + request.maxTokens + GENERATION_CONTEXT_RESERVE),
    GENERATION_CONTEXT_QUANTUM,
  );
  return Math.min(request.manifest.contextLimit, requested);
}

function roundUp(value: number, quantum: number): number {
  return Math.ceil(value / quantum) * quantum;
}

function modelCacheKey(request: {readonly manifest: LocalModelManifest; readonly modelPath: string}): string {
  return `${request.manifest.role}\u0000${request.manifest.id}\u0000${request.manifest.sha256}\u0000${request.modelPath}`;
}
