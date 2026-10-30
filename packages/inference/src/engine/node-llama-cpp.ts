import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Effect, Exit, Layer, Path, Scope} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {SystemInfo} from '@threadnote/platform/system';
import {
  EmbeddingFailed,
  GenerationFailed,
  InferenceInterrupted,
  InsufficientMemory,
  ModelLoadFailed,
  ModelNotInstalled,
  NativeRuntimeUnavailable,
  RerankingFailed,
  InvalidModelOutput,
  UnsupportedNativeRuntime,
} from './errors.js';
import {
  LlamaCppEngine,
  type LlamaCppEngineShape,
  type LlamaEmbeddingSession,
  type LlamaGenerationSession,
  type LlamaRankingSession,
  type LocalModelLoadOptions,
} from './llama-cpp-engine.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface NativeEmbedding {
  readonly vector: readonly number[];
}

interface NativeEmbeddingContext {
  readonly disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly getEmbeddingFor: (input: string) => Promise<NativeEmbedding>;
}

interface NativeRankingContext {
  readonly disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly rankAll: (query: string, documents: string[]) => Promise<number[]>;
}

interface NativeModel {
  readonly disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly gpuLayers?: number;
  readonly createEmbeddingContext: (options: {
    readonly contextSize?: number;
    readonly createSignal: AbortSignal;
    readonly ignoreMemorySafetyChecks: false;
    readonly threads?: number;
  }) => Promise<NativeEmbeddingContext>;
  readonly createRankingContext: (options: {
    readonly contextSize?: number;
    readonly createSignal: AbortSignal;
    readonly ignoreMemorySafetyChecks: false;
    readonly template?: string;
  }) => Promise<NativeRankingContext>;
  readonly createContext?: (options: {
    readonly contextSize?: number;
    readonly createSignal: AbortSignal;
    readonly ignoreMemorySafetyChecks: false;
    readonly sequences: 1;
  }) => Promise<NativeGenerationContext>;
  readonly detokenize: (tokens: readonly number[], specialTokens?: boolean, lastTokens?: readonly number[]) => string;
  readonly tokenize: (text: string, specialTokens?: boolean, options?: 'trimLeadingSpace') => readonly number[];
}

interface NativeGenerationContext {
  readonly disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly getSequence: () => unknown;
}

interface NativeGrammar {
  readonly parse: (json: string) => unknown;
}

interface NativeChatSession {
  readonly dispose: (options?: {readonly disposeSequence?: boolean}) => void;
  readonly disposed: boolean;
  readonly prompt: (
    prompt: string,
    options: {
      readonly grammar: NativeGrammar;
      readonly maxTokens: number;
      readonly seed?: number;
      readonly signal: AbortSignal;
      readonly temperature: number;
      readonly topP?: number;
      readonly topK?: number;
    },
  ) => Promise<string>;
}

interface NativeLlama {
  readonly buildType: 'localBuild' | 'prebuilt';
  readonly cpuMathCores: number;
  readonly disposed: boolean;
  readonly gpu: string | false;
  readonly dispose: () => Promise<void>;
  readonly loadModel: (options: {
    readonly gpuLayers?: number;
    readonly ignoreMemorySafetyChecks: false;
    readonly loadSignal: AbortSignal;
    readonly modelPath: string;
  }) => Promise<NativeModel>;
  readonly createGrammarForJsonSchema?: (schema: Readonly<Record<string, unknown>>) => Promise<NativeGrammar>;
}

interface NodeLlamaCppModule {
  readonly LlamaChatSession?: new (options: {
    readonly contextSequence: unknown;
    readonly systemPrompt?: string;
  }) => NativeChatSession;
  readonly getLlama: (options: {
    readonly build: 'never';
    readonly debug: false;
    readonly logger: (_level: string, _message: string) => void;
    readonly logLevel: 'disabled';
    readonly progressLogs: false;
    readonly skipDownload: true;
    readonly usePrebuiltBinaries: true;
  }) => Promise<NativeLlama>;
}

const EMBEDDING_CONTEXT_TOKEN_RESERVE = 16;
const EMBEDDING_WINDOW_OVERLAP_TOKENS = 32;
const discardNativeLog = (_level: string, _message: string): void => undefined;
const EMBEDDING_CONTEXT_POOL_SIZES = [1, 2, 4, 8] as const;

export type EmbeddingContextPoolSize = (typeof EMBEDDING_CONTEXT_POOL_SIZES)[number];
export const THREADNOTE_EMBEDDING_CONTEXTS_ENV = 'THREADNOTE_EMBEDDING_CONTEXTS';

export interface NodeLlamaCppLayerOptions {
  readonly embeddingContextPoolSize?: EmbeddingContextPoolSize;
  readonly embeddingGpuLayers?: number;
  readonly loadModule?: () => Promise<NodeLlamaCppModule>;
}

interface NativeEmbeddingPolicy {
  readonly architecture?: string;
  readonly contextPoolSize?: EmbeddingContextPoolSize;
  readonly contextPoolSizeEnvironment?: string;
  readonly gpuLayers?: number;
  readonly platform?: string;
}

const loadInstalledNodeLlamaCpp = async (moduleSpecifier: string = 'node-llama-cpp'): Promise<NodeLlamaCppModule> =>
  await import(moduleSpecifier);

export function nodeLlamaCppEngineLayer(
  options: NodeLlamaCppLayerOptions & {
    readonly loadModule: () => Promise<NodeLlamaCppModule>;
  },
): Layer.Layer<LlamaCppEngine, NativeRuntimeUnavailable | UnsupportedNativeRuntime>;
export function nodeLlamaCppEngineLayer(
  options?: NodeLlamaCppLayerOptions,
): Layer.Layer<LlamaCppEngine, NativeRuntimeUnavailable | UnsupportedNativeRuntime, Path.Path | SystemInfo>;
export function nodeLlamaCppEngineLayer(options: NodeLlamaCppLayerOptions = {}) {
  return Layer.effect(
    LlamaCppEngine,
    Effect.gen(function* () {
      let loadModule = options.loadModule;
      let embeddingPolicy: NativeEmbeddingPolicy = {
        contextPoolSize: options.embeddingContextPoolSize,
        gpuLayers: options.embeddingGpuLayers,
      };
      if (!loadModule) {
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        embeddingPolicy = {
          architecture: system.architecture,
          contextPoolSize: options.embeddingContextPoolSize,
          contextPoolSizeEnvironment: system.environment()[THREADNOTE_EMBEDDING_CONTEXTS_ENV],
          gpuLayers: options.embeddingGpuLayers,
          platform: system.platform,
        };
        let moduleSpecifier = 'node-llama-cpp';
        if (typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE) {
          const nativeModuleUrl = yield* path
            .toFileUrl(path.join(path.dirname(system.executablePath), 'runtime', 'node-llama-cpp.js'))
            .pipe(
              Effect.mapError(cause =>
                NativeRuntimeUnavailable.make({
                  cause,
                  message: 'Could not resolve the bundled node-llama-cpp runtime.',
                }),
              ),
            );
          moduleSpecifier = nativeModuleUrl.href;
        }
        loadModule = () => loadInstalledNodeLlamaCpp(moduleSpecifier);
      }
      const module = yield* fromPromiseInterruptible(
        () => loadModule(),
        cause =>
          NativeRuntimeUnavailable.make({
            cause,
            message: `Could not load the node-llama-cpp runtime: ${errorMessage(cause)}`,
          }),
      );
      const llama = yield* Effect.acquireRelease(
        fromPromiseInterruptible(
          () =>
            module.getLlama({
              build: 'never',
              debug: false,
              logger: discardNativeLog,
              logLevel: 'disabled',
              progressLogs: false,
              skipDownload: true,
              usePrebuiltBinaries: true,
            }),
          cause =>
            isNoBinaryFound(cause)
              ? UnsupportedNativeRuntime.make({
                  cause,
                  message:
                    'No compatible prebuilt node-llama-cpp binary is available. Threadnote will not compile llama.cpp automatically.',
                })
              : NativeRuntimeUnavailable.make({
                  cause,
                  message: `Could not initialize node-llama-cpp: ${errorMessage(cause)}`,
                }),
        ),
        native => disposeIgnoringFailure(native),
      );
      return LlamaCppEngine.of(makeEngine(llama, module, embeddingPolicy));
    }),
  );
}

function makeEngine(
  llama: NativeLlama,
  module: NodeLlamaCppModule,
  embeddingPolicy: NativeEmbeddingPolicy,
): LlamaCppEngineShape {
  const diagnostics: LlamaCppEngineShape['diagnostics'] & {
    embeddingContextPlan?: NonNullable<LlamaCppEngineShape['diagnostics']['embeddingContextPlan']>;
  } = {
    backend: llama.gpu === false ? 'cpu' : llama.gpu,
    buildType: llama.buildType,
    cpuMathCores: llama.cpuMathCores,
  };
  return {
    diagnostics,
    loadEmbeddingSession: options =>
      Effect.gen(function* () {
        const contextPoolSize = yield* Effect.try({
          try: () =>
            embeddingPolicy.contextPoolSize ??
            (Effect2.pipe(embeddingPolicy.contextPoolSizeEnvironment, effectOptionalString =>
              effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
            )
              ? parseEmbeddingContextPoolSize(embeddingPolicy.contextPoolSizeEnvironment)
              : (options.embeddingContextPoolSize ?? parseEmbeddingContextPoolSize(undefined))),
          catch: cause =>
            ModelLoadFailed.make({
              cause,
              message: `${THREADNOTE_EMBEDDING_CONTEXTS_ENV} must be one of 1, 2, 4, or 8.`,
              modelId: options.modelId,
            }),
        });
        const parentScope = yield* Scope.Scope;
        const sessionScope = yield* Scope.fork(parentScope);
        const gpuLayers = resolveNativeEmbeddingGpuLayers({
          architecture: embeddingPolicy.architecture,
          layerGpuLayers: embeddingPolicy.gpuLayers,
          modelDarwinArm64GpuLayers: options.darwinArm64EmbeddingGpuLayers,
          platform: embeddingPolicy.platform,
        });
        const load = Effect.gen(function* () {
          const model = yield* acquireModel(llama, options, gpuLayers);
          const activeBatches = new Set<Promise<unknown>>();
          yield* Scope.addFinalizer(
            sessionScope,
            fromPromiseInterruptible(
              () => Promise.allSettled([...activeBatches]).then(() => undefined),
              cause => cause,
            ).pipe(Effect.ignore),
          );
          const modelGpuLayers = model.gpuLayers ?? gpuLayers ?? (llama.gpu === false ? 0 : undefined);
          const contextPlan = nativeEmbeddingContextPlan({
            cpuMathCores: llama.cpuMathCores,
            modelGpuLayers,
            requestedContexts: contextPoolSize,
          });
          const embeddingContextPlan = {
            effectiveContexts: contextPlan.contexts,
            ...(modelGpuLayers === undefined ? {} : {modelGpuLayers}),
            requestedContexts: contextPoolSize,
            threadCounts: EffectArray.filter(
              contextPlan.threadCounts,
              (threads): threads is number => threads !== undefined,
            ),
          };
          diagnostics.embeddingContextPlan = embeddingContextPlan;
          const contexts = yield* Effect.forEach(
            contextPlan.threadCounts,
            threads =>
              Effect.acquireRelease(
                fromPromiseInterruptible(
                  signal =>
                    model.createEmbeddingContext({
                      contextSize: options.contextSize,
                      createSignal: signal,
                      ignoreMemorySafetyChecks: false,
                      ...(threads === undefined ? {} : {threads}),
                    }),
                  cause => modelLoadError(options, cause, 'embedding context'),
                ),
                native => disposeIgnoringFailure(native),
              ),
            {concurrency: 1},
          );
          return embeddingSession(
            options,
            model,
            contexts,
            activeBatches,
            () => {
              diagnostics.embeddingContextPlan = embeddingContextPlan;
            },
            exit => Scope.close(sessionScope, exit),
          );
        }).pipe(Effect.provideService(Scope.Scope, sessionScope));
        return yield* load.pipe(
          Effect.onExit(exit => (Exit.isFailure(exit) ? Scope.close(sessionScope, exit) : Effect.void)),
        );
      }),
    loadGenerationSession: options =>
      Effect.gen(function* () {
        const model = yield* acquireModel(llama, options);
        if (!model.createContext || !llama.createGrammarForJsonSchema || !module.LlamaChatSession) {
          return yield* ModelLoadFailed.make({
            cause: new Error('Installed node-llama-cpp runtime does not expose structured generation APIs.'),
            message: `Could not load structured generation for ${options.modelId}.`,
            modelId: options.modelId,
          });
        }
        return generationSession(options, model, llama, module.LlamaChatSession);
      }),
    loadRankingSession: options =>
      Effect.gen(function* () {
        const model = yield* acquireModel(llama, options);
        const context = yield* Effect.acquireRelease(
          fromPromiseInterruptible(
            signal =>
              model.createRankingContext({
                contextSize: options.contextSize,
                createSignal: signal,
                ignoreMemorySafetyChecks: false,
                ...(options.rankingTemplate === undefined ? {} : {template: options.rankingTemplate}),
              }),
            cause => modelLoadError(options, cause, 'ranking context'),
          ),
          native => disposeIgnoringFailure(native),
        );
        return rankingSession(options, context);
      }),
  };
}

export function resolveNativeEmbeddingGpuLayers(options: {
  readonly architecture?: string;
  readonly layerGpuLayers?: number;
  readonly modelDarwinArm64GpuLayers?: number;
  readonly platform?: string;
}): number | undefined {
  return (
    options.layerGpuLayers ??
    (options.platform === 'darwin' && options.architecture === 'arm64' ? options.modelDarwinArm64GpuLayers : undefined)
  );
}

export function parseEmbeddingContextPoolSize(value: string | undefined): EmbeddingContextPoolSize {
  if (value === undefined || Effect2.pipe(value, EffectString.trim) === '') return 1;
  const parsed = Number(value);
  if (!isEmbeddingContextPoolSize(parsed)) {
    throw new RangeError(`${THREADNOTE_EMBEDDING_CONTEXTS_ENV} must be one of 1, 2, 4, or 8.`);
  }
  return parsed;
}

function isEmbeddingContextPoolSize(value: number): value is EmbeddingContextPoolSize {
  return value === 1 || value === 2 || value === 4 || value === 8;
}

export function nativeEmbeddingContextPlan(options: {
  readonly cpuMathCores: number;
  readonly modelGpuLayers: number | undefined;
  readonly requestedContexts: EmbeddingContextPoolSize;
}): {
  readonly contexts: number;
  readonly threadCounts: readonly (number | undefined)[];
} {
  if (options.modelGpuLayers !== 0 || options.requestedContexts === 1) {
    return {contexts: 1, threadCounts: [undefined]};
  }
  const availableCores = Math.max(1, Math.floor(options.cpuMathCores));
  // Three single-thread contexts avoid the measured 2+1 partition overhead
  // without changing the requested cap or planning on other CPU capacities.
  if (availableCores === 3 && options.requestedContexts >= 4) {
    return {contexts: 3, threadCounts: [1, 1, 1]};
  }
  const contexts = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...EMBEDDING_CONTEXT_POOL_SIZES].reverse(),
      candidate => candidate <= options.requestedContexts && candidate <= availableCores,
    ),
  )!;
  const baseThreads = Math.floor(availableCores / contexts);
  const remainder = availableCores % contexts;
  return {
    contexts,
    threadCounts: Array.from({length: contexts}, (_, index) => baseThreads + (index < remainder ? 1 : 0)),
  };
}

function generationSession(
  options: LocalModelLoadOptions,
  model: NativeModel,
  llama: NativeLlama,
  ChatSession: NonNullable<NodeLlamaCppModule['LlamaChatSession']>,
): LlamaGenerationSession {
  return {
    generate: request =>
      Effect.scoped(
        Effect.gen(function* () {
          const createContext = model.createContext;
          const createGrammar = llama.createGrammarForJsonSchema;
          if (!createContext || !createGrammar) {
            return yield* GenerationFailed.make({
              cause: new Error('Structured generation APIs became unavailable.'),
              message: `Structured generation with ${options.modelId} is unavailable.`,
              modelId: options.modelId,
            });
          }
          const context = yield* Effect.acquireRelease(
            fromPromiseInterruptible(
              signal =>
                createContext.call(model, {
                  contextSize: options.contextSize,
                  createSignal: signal,
                  ignoreMemorySafetyChecks: false,
                  sequences: 1,
                }),
              cause => modelLoadError(options, cause, 'generation context'),
            ),
            native => disposeIgnoringFailure(native),
          ).pipe(
            Effect.mapError(cause =>
              GenerationFailed.make({
                cause,
                message: `Could not create a generation context for ${options.modelId}: ${errorMessage(cause)}`,
                modelId: options.modelId,
              }),
            ),
          );
          const grammar = yield* fromPromiseInterruptible(
            () => createGrammar.call(llama, request.jsonSchema),
            cause =>
              GenerationFailed.make({
                cause,
                message: `Could not create JSON grammar for ${options.modelId}.`,
                modelId: options.modelId,
              }),
          );
          const session = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new ChatSession({
                  contextSequence: context.getSequence(),
                  systemPrompt: request.system,
                }),
            ),
            native => Effect.sync(() => native.dispose({disposeSequence: false})),
          );
          const output = yield* fromPromiseInterruptible(
            signal =>
              session.prompt(request.prompt, {
                grammar,
                maxTokens: request.maxTokens,
                seed: request.seed,
                signal,
                temperature: request.sampling?.temperature ?? 0,
                ...(request.sampling ? {topP: request.sampling.topP, topK: request.sampling.topK} : {}),
              }),
            cause =>
              isAbortError(cause)
                ? InferenceInterrupted.make({
                    message: `Generation with ${options.modelId} was interrupted.`,
                    modelId: options.modelId,
                    operation: 'generate',
                  })
                : GenerationFailed.make({
                    cause,
                    message: `Generation with ${options.modelId} failed: ${errorMessage(cause)}`,
                    modelId: options.modelId,
                  }),
          );
          return yield* Effect.try({
            try: () => grammar.parse(output),
            catch: () =>
              InvalidModelOutput.make({
                message: `Generation model ${options.modelId} returned output that did not match its JSON schema.`,
                modelId: options.modelId,
              }),
          });
        }),
      ),
    modelId: options.modelId,
  };
}

function acquireModel(llama: NativeLlama, options: LocalModelLoadOptions, gpuLayers?: number) {
  return Effect.acquireRelease(
    fromPromiseInterruptible(
      signal =>
        llama.loadModel({
          ...(gpuLayers === undefined ? {} : {gpuLayers}),
          ignoreMemorySafetyChecks: false,
          loadSignal: signal,
          modelPath: options.modelPath,
        }),
      cause => modelLoadError(options, cause, 'model'),
    ),
    model => disposeIgnoringFailure(model),
  );
}

function embeddingSession(
  options: LocalModelLoadOptions & {readonly dimensions: number},
  model: NativeModel,
  contexts: readonly NativeEmbeddingContext[],
  activeBatches: Set<Promise<unknown>>,
  activateDiagnostics: () => void,
  close: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>,
): LlamaEmbeddingSession {
  return {
    dimensions: options.dimensions,
    embedMany: inputs =>
      fromPromiseInterruptible(
        signal => {
          activateDiagnostics();
          const running = embedInputsWithContextPool(model, contexts, inputs, options.contextSize, signal);
          const tracked = running.finally(() => activeBatches.delete(tracked));
          activeBatches.add(tracked);
          return tracked;
        },
        cause =>
          isAbortError(cause)
            ? InferenceInterrupted.make({
                message: `Embedding with ${options.modelId} was interrupted.`,
                modelId: options.modelId,
                operation: 'embed',
              })
            : EmbeddingFailed.make({
                cause,
                message: `Embedding with ${options.modelId} failed: ${errorMessage(cause)}`,
                modelId: options.modelId,
              }),
      ).pipe(
        Effect.flatMap(embeddings => {
          const vectors = EffectArray.map(embeddings, embedding => embedding.vector);
          const invalid = EffectOption.getOrUndefined(
            EffectArray.findFirst(
              vectors,
              __effectArrayValue =>
                !!(vector =>
                  vector.length !== options.dimensions ||
                  EffectArray.some(vector, component => !Number.isFinite(component)))(__effectArrayValue),
            ),
          );
          return invalid
            ? Effect.fail(
                EmbeddingFailed.make({
                  cause: invalid,
                  message: `Embedding model ${options.modelId} returned an invalid vector; expected ${options.dimensions} finite dimensions.`,
                  modelId: options.modelId,
                }),
              )
            : Effect.succeed(vectors);
        }),
        Effect.onExit(exit => (Exit.isFailure(exit) ? close(exit) : Effect.void)),
      ),
    modelId: options.modelId,
  };
}

async function embeddingForInput(
  model: NativeModel,
  context: NativeEmbeddingContext,
  input: string,
  contextSize: number | undefined,
): Promise<NativeEmbedding> {
  const windows = embeddingInputWindows(model, input, contextSize);
  if (windows.length === 1) {
    return context.getEmbeddingFor(windows[0].text);
  }
  const embeddings: NativeEmbedding[] = [];
  for (const window of windows) {
    embeddings.push(await context.getEmbeddingFor(window.text));
  }
  const dimensions = embeddings[0]?.vector.length ?? 0;
  const pooled = new Array<number>(dimensions).fill(0);
  let totalWeight = 0;
  for (const [index, embedding] of embeddings.entries()) {
    const weight = windows[index].weight;
    totalWeight += weight;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      pooled[dimension] += (embedding.vector[dimension] ?? 0) * weight;
    }
  }
  if (totalWeight > 0) {
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      pooled[dimension] /= totalWeight;
    }
  }
  const magnitude = Math.sqrt(EffectArray.reduce(pooled, 0, (sum, value) => sum + value * value));
  return {vector: magnitude > 0 ? EffectArray.map(pooled, value => value / magnitude) : pooled};
}

async function embedInputsWithContextPool(
  model: NativeModel,
  contexts: readonly NativeEmbeddingContext[],
  inputs: readonly string[],
  contextSize: number | undefined,
  signal: AbortSignal,
): Promise<readonly NativeEmbedding[]> {
  const embeddings = new Array<NativeEmbedding>(inputs.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  let stopped = signal.aborted;
  let contextDisposal: Promise<void> | undefined;
  const stop = () => {
    stopped = true;
  };
  signal.addEventListener('abort', stop, {once: true});
  const workers = EffectArray.map(contexts.slice(0, inputs.length), async context => {
    for (;;) {
      if (stopped || failed) return;
      const index = cursor;
      cursor += 1;
      if (index >= inputs.length) return;
      try {
        embeddings[index] = await embeddingForInput(model, context, inputs[index], contextSize);
      } catch (cause) {
        if (signal.aborted) {
          stopped = true;
          return;
        }
        if (!failed) {
          failed = true;
          failure = cause;
          contextDisposal = disposeEmbeddingContexts(contexts);
          await contextDisposal;
        }
        return;
      }
    }
  });
  try {
    await Promise.allSettled(workers);
    if (failed) {
      await contextDisposal;
      await disposeEmbeddingModel(model);
      throw failure;
    }
    return embeddings;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

async function disposeEmbeddingContexts(contexts: readonly NativeEmbeddingContext[]): Promise<void> {
  await Promise.all(
    EffectArray.map(contexts, async context => {
      if (context.disposed) return;
      try {
        await context.dispose();
      } catch {
        // Preserve the embedding failure or interruption that triggered disposal.
      }
    }),
  );
}

async function disposeEmbeddingModel(model: NativeModel): Promise<void> {
  if (!model.disposed) {
    try {
      await model.dispose();
    } catch {
      // Preserve the embedding failure or interruption that triggered disposal.
    }
  }
}

function embeddingInputWindows(
  model: NativeModel,
  input: string,
  contextSize: number | undefined,
): readonly {readonly text: string; readonly weight: number}[] {
  if (contextSize === undefined || contextSize <= EMBEDDING_CONTEXT_TOKEN_RESERVE + 1) {
    return [{text: input, weight: 1}];
  }
  const maximumTokens = contextSize - EMBEDDING_CONTEXT_TOKEN_RESERVE;
  const tokens = model.tokenize(input, false);
  if (tokens.length <= maximumTokens) {
    return [{text: input, weight: Math.max(1, tokens.length)}];
  }
  const overlapTokens = Math.min(EMBEDDING_WINDOW_OVERLAP_TOKENS, Math.max(1, Math.floor(maximumTokens / 8)));
  const windows: Array<{readonly text: string; readonly weight: number}> = [];
  for (let start = 0; start < tokens.length;) {
    const end = Math.min(tokens.length, start + maximumTokens);
    const windowTokens = tokens.slice(start, end);
    const text = model.detokenize(windowTokens, false);
    if (text.length > 0) {
      windows.push({text, weight: windowTokens.length});
    }
    if (end >= tokens.length) break;
    start = end - overlapTokens;
  }
  return windows.length > 0 ? windows : [{text: input, weight: 1}];
}

function rankingSession(options: LocalModelLoadOptions, context: NativeRankingContext): LlamaRankingSession {
  return {
    modelId: options.modelId,
    rank: (query, documents) =>
      fromPromiseInterruptible(
        signal => {
          const disposeOnAbort = () => {
            void context.dispose();
          };
          signal.addEventListener('abort', disposeOnAbort, {once: true});
          return context.rankAll(query, [...documents]).finally(() => {
            signal.removeEventListener('abort', disposeOnAbort);
          });
        },
        cause =>
          isAbortError(cause)
            ? InferenceInterrupted.make({
                message: `Reranking with ${options.modelId} was interrupted.`,
                modelId: options.modelId,
                operation: 'rerank',
              })
            : RerankingFailed.make({
                cause,
                message: `Reranking with ${options.modelId} failed: ${errorMessage(cause)}`,
                modelId: options.modelId,
              }),
      ).pipe(
        Effect.filterOrFail(
          scores => scores.length === documents.length && EffectArray.every(scores, score => Number.isFinite(score)),
          scores =>
            RerankingFailed.make({
              cause: scores,
              message: `Reranker ${options.modelId} returned ${scores.length} invalid scores for ${documents.length} documents.`,
              modelId: options.modelId,
            }),
        ),
      ),
  };
}

function modelLoadError(options: LocalModelLoadOptions, cause: unknown, resource: string) {
  if (isMissingFile(cause)) {
    return ModelNotInstalled.make({
      message: `Model ${options.modelId} is not installed.`,
      modelId: options.modelId,
      path: options.modelPath,
    });
  }
  if (isInsufficientMemory(cause)) {
    return InsufficientMemory.make({
      cause,
      message: `There is not enough memory to load the ${resource} for ${options.modelId}.`,
      modelId: options.modelId,
    });
  }
  return ModelLoadFailed.make({
    cause,
    message: `Could not load the ${resource} for ${options.modelId}: ${errorMessage(cause)}`,
    modelId: options.modelId,
  });
}

function disposeIgnoringFailure(resource: {readonly disposed: boolean; readonly dispose: () => Promise<void>}) {
  return resource.disposed
    ? Effect.void
    : fromPromiseInterruptible(
        () => resource.dispose(),
        () => undefined,
      ).pipe(Effect.ignore);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errorName(cause: unknown): string | undefined {
  if (cause instanceof Error) {
    return cause.name && cause.name !== 'Error' ? cause.name : cause.constructor.name;
  }
  return typeof cause === 'object' && cause !== null && 'name' in cause ? String(cause.name) : undefined;
}

function isAbortError(cause: unknown): boolean {
  return errorName(cause) === 'AbortError';
}

function isInsufficientMemory(cause: unknown): boolean {
  return errorName(cause) === 'InsufficientMemoryError';
}

function isMissingFile(cause: unknown): boolean {
  return (
    errorName(cause) === 'ENOENT' ||
    (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT')
  );
}

function isNoBinaryFound(cause: unknown): boolean {
  return errorName(cause) === 'NoBinaryFoundError';
}
