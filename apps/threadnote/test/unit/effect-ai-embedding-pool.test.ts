import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Effect, Exit, Fiber} from 'effect';
import {describe} from 'vitest';
import {LlamaCppEngine} from '@threadnote/inference/engine/llama-cpp-engine';
import {
  nativeEmbeddingContextPlan,
  nodeLlamaCppEngineLayer,
  parseEmbeddingContextPoolSize,
  type EmbeddingContextPoolSize,
} from '@threadnote/inference/engine/node-llama-cpp';
import {localModelRuntimeLayer, LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface EmbeddingContextCreationOptions {
  readonly contextSize?: number;
  readonly createSignal: AbortSignal;
  readonly ignoreMemorySafetyChecks: false;
  readonly threads?: number;
}

interface EmbeddingContextDouble {
  readonly disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly getEmbeddingFor: (input: string) => Promise<{readonly vector: readonly number[]}>;
}

interface EmbeddingHarnessState {
  readonly contextCalls: Array<
    EmbeddingContextCreationOptions & {readonly contextIndex: number; readonly modelIndex: number}
  >;
  readonly events: string[];
  readonly modelDisposals: number[];
  modelLoads: number;
}

function embeddingHarness(options: {
  readonly context: (input: {
    readonly contextIndex: number;
    readonly creation: EmbeddingContextCreationOptions;
    readonly modelIndex: number;
  }) => EmbeddingContextDouble;
  readonly cpuMathCores?: number;
  readonly gpu?: string | false;
  readonly gpuLayers?: number;
  readonly poolSize?: EmbeddingContextPoolSize;
}) {
  const state: EmbeddingHarnessState = {
    contextCalls: [],
    events: [],
    modelDisposals: [],
    modelLoads: 0,
  };
  const layer = nodeLlamaCppEngineLayer({
    ...(options.poolSize === undefined ? {} : {embeddingContextPoolSize: options.poolSize}),
    loadModule: () =>
      Promise.resolve({
        getLlama: () => {
          let llamaDisposed = false;
          return Promise.resolve({
            buildType: 'prebuilt' as const,
            cpuMathCores: options.cpuMathCores ?? 8,
            get disposed() {
              return llamaDisposed;
            },
            dispose: () => {
              llamaDisposed = true;
              state.events.push('llama:dispose');
              return Promise.resolve();
            },
            gpu: options.gpu ?? false,
            loadModel: () => {
              const modelIndex = state.modelLoads;
              state.modelLoads += 1;
              let modelDisposed = false;
              let contextIndex = 0;
              return Promise.resolve({
                createEmbeddingContext: (creation: EmbeddingContextCreationOptions) => {
                  const currentContext = contextIndex;
                  contextIndex += 1;
                  state.contextCalls.push({...creation, contextIndex: currentContext, modelIndex});
                  try {
                    return Promise.resolve(options.context({contextIndex: currentContext, creation, modelIndex}));
                  } catch (cause) {
                    return Promise.reject(cause);
                  }
                },
                createRankingContext: () => Promise.reject(TestError.make({message: 'Unexpected ranking context'})),
                detokenize: (tokens: readonly number[]) => String.fromCodePoint(...tokens),
                get disposed() {
                  return modelDisposed;
                },
                dispose: () => {
                  modelDisposed = true;
                  state.modelDisposals.push(modelIndex);
                  state.events.push(`model-${modelIndex}:dispose`);
                  return Promise.resolve();
                },
                gpuLayers: options.gpuLayers,
                tokenize: (text: string) =>
                  EffectArray.map([...text], character =>
                    Effect2.pipe(
                      character,
                      EffectString.codePointAt(0),
                      Effect2.Option.getOrElse(() => undefined),
                    )!,
                  ),
              });
            },
          });
        },
      }),
  });
  return {layer, state};
}

function immediateContext(vector: (input: string) => readonly number[]): EmbeddingContextDouble {
  let disposed = false;
  return {
    get disposed() {
      return disposed;
    },
    dispose: () => {
      disposed = true;
      return Promise.resolve();
    },
    getEmbeddingFor: input => Promise.resolve({vector: vector(input)}),
  };
}

describe('native embedding context pool', () => {
  it('keeps the shared runtime serial by default and accepts only the benchmarked capacities', () => {
    expect(parseEmbeddingContextPoolSize(undefined)).toBe(1);
    expect(parseEmbeddingContextPoolSize('')).toBe(1);
    expect(parseEmbeddingContextPoolSize(' 4 ')).toBe(4);
    for (const invalid of ['0', '3', '16', 'four']) {
      expect(() => parseEmbeddingContextPoolSize(invalid)).toThrow(/1, 2, 4, or 8/);
    }
  });

  it('partitions CPU threads, caps lanes to available cores, and keeps GPU or unknown offload serial', () => {
    expect(nativeEmbeddingContextPlan({cpuMathCores: 8, modelGpuLayers: 0, requestedContexts: 1})).toEqual({
      contexts: 1,
      threadCounts: [undefined],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 8, modelGpuLayers: 0, requestedContexts: 2})).toEqual({
      contexts: 2,
      threadCounts: [4, 4],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 8, modelGpuLayers: 0, requestedContexts: 4})).toEqual({
      contexts: 4,
      threadCounts: [2, 2, 2, 2],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 8, modelGpuLayers: 0, requestedContexts: 8})).toEqual({
      contexts: 8,
      threadCounts: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 3, modelGpuLayers: 0, requestedContexts: 8})).toEqual({
      contexts: 2,
      threadCounts: [2, 1],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 6, modelGpuLayers: 0, requestedContexts: 8})).toEqual({
      contexts: 4,
      threadCounts: [2, 2, 1, 1],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 8, modelGpuLayers: 1, requestedContexts: 8})).toEqual({
      contexts: 1,
      threadCounts: [undefined],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 8, modelGpuLayers: undefined, requestedContexts: 8})).toEqual({
      contexts: 1,
      threadCounts: [undefined],
    });
  });

  fcProp(
    it,
    'uses every available CPU core without exceeding the configured context cap',
    {
      cpuMathCores: FC.integer({max: 128, min: 1}),
      requestedContexts: FC.constantFrom<EmbeddingContextPoolSize>(1, 2, 4, 8),
    },
    ({cpuMathCores, requestedContexts}) => {
      const plan = nativeEmbeddingContextPlan({cpuMathCores, modelGpuLayers: 0, requestedContexts});
      const expectedContexts = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          [8, 4, 2, 1] as const,
          candidate => candidate <= cpuMathCores && candidate <= requestedContexts,
        ),
      )!;
      expect(plan.contexts).toBe(expectedContexts);
      if (requestedContexts === 1) {
        expect(plan.threadCounts).toEqual([undefined]);
        return;
      }
      const threadCounts = EffectArray.filter(plan.threadCounts, (threads): threads is number => threads !== undefined);
      expect(threadCounts).toHaveLength(expectedContexts);
      expect(EffectArray.reduce(threadCounts, 0, (total, threads) => total + threads)).toBe(cpuMathCores);
      expect(Math.max(...threadCounts) - Math.min(...threadCounts)).toBeLessThanOrEqual(1);
    },
  );

  it.effect('uses the available CPU core budget when the graph session requests the benchmarked cap', () => {
    const manifest = EffectOption.getOrUndefined(
      EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.role === 'embedding'),
    )!;
    const {layer, state} = embeddingHarness({
      context: () => immediateContext(input => Array(manifest.dimensions).fill(input.length)),
      cpuMathCores: 6,
      gpuLayers: 0,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* LocalModelRuntime;
        const vectors = yield* runtime.embedMany({
          embeddingContextPoolSize: 8,
          inputs: ['cpu'],
          manifest,
          modelPath: '/models/auto-cpu.gguf',
        });
        expect(vectors[0]).toHaveLength(manifest.dimensions);
        expect(EffectArray.map(state.contextCalls, call => call.threads)).toEqual([2, 2, 1, 1]);
        expect((yield* runtime.diagnostics).embeddingContextPlan).toEqual({
          effectiveContexts: 4,
          modelGpuLayers: 0,
          requestedContexts: 8,
          threadCounts: [2, 2, 1, 1],
        });
      }).pipe(provideTestLayer(localModelRuntimeLayer(layer))),
    );
  });

  it.effect('lets an explicit serial runtime override supersede the graph session cap', () => {
    const {layer, state} = embeddingHarness({
      context: () => immediateContext(input => [input.length]),
      gpuLayers: 0,
      poolSize: 1,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* LlamaCppEngine;
        const session = yield* engine.loadEmbeddingSession({
          dimensions: 1,
          embeddingContextPoolSize: 8,
          modelId: 'serial-override',
          modelPath: '/models/serial.gguf',
        });
        expect(yield* session.embedMany(['serial'])).toEqual([[6]]);
        expect(EffectArray.map(state.contextCalls, call => call.threads)).toEqual([undefined]);
        expect(engine.diagnostics.embeddingContextPlan).toEqual({
          effectiveContexts: 1,
          modelGpuLayers: 0,
          requestedContexts: 1,
          threadCounts: [],
        });
      }).pipe(provideTestLayer(layer)),
    );
  });

  it.effect('isolates and reuses default and graph-cap sessions while reporting the active plan', () => {
    const manifest = EffectOption.getOrUndefined(
      EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.role === 'embedding'),
    )!;
    const {layer, state} = embeddingHarness({
      context: () => immediateContext(input => Array(manifest.dimensions).fill(input.length)),
      gpuLayers: 0,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* LocalModelRuntime;
        const base = {inputs: ['input'], manifest, modelPath: '/models/cached-plans.gguf'} as const;
        yield* runtime.embedMany(base);
        expect((yield* runtime.diagnostics).embeddingContextPlan?.requestedContexts).toBe(1);
        yield* runtime.embedMany({...base, embeddingContextPoolSize: 8});
        expect((yield* runtime.diagnostics).embeddingContextPlan?.requestedContexts).toBe(8);
        yield* runtime.embedMany(base);
        expect((yield* runtime.diagnostics).embeddingContextPlan?.requestedContexts).toBe(1);
        yield* runtime.embedMany({...base, embeddingContextPoolSize: 8});
        expect((yield* runtime.diagnostics).embeddingContextPlan?.requestedContexts).toBe(8);
        expect(state.modelLoads).toBe(2);
        expect(state.contextCalls).toHaveLength(9);
      }).pipe(provideTestLayer(localModelRuntimeLayer(layer))),
    );
  });

  it.effect('runs distinct CPU contexts concurrently and preserves reverse-completion order', () => {
    const pending: Array<{readonly input: string; readonly resolve: () => void}> = [];
    let active = 0;
    let maximumActive = 0;
    const {layer, state} = embeddingHarness({
      context: () => {
        let disposed = false;
        return {
          get disposed() {
            return disposed;
          },
          dispose: () => {
            disposed = true;
            return Promise.resolve();
          },
          getEmbeddingFor: input => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            return new Promise(resolve => {
              pending.push({
                input,
                resolve: () => {
                  active -= 1;
                  resolve({vector: [Number(Effect2.pipe(input, EffectString.slice(5)))]});
                },
              });
            });
          },
        };
      },
      gpuLayers: 0,
      poolSize: 4,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* LlamaCppEngine;
        const session = yield* engine.loadEmbeddingSession({
          dimensions: 1,
          modelId: 'pool-order',
          modelPath: '/models/pool.gguf',
        });
        const fiber = yield* Effect.forkChild(session.embedMany(['item-0', 'item-1', 'item-2', 'item-3']));
        while (pending.length < 4) yield* Effect.yieldNow;
        for (const item of pending.splice(0).reverse()) item.resolve();
        const vectors = yield* Fiber.join(fiber);
        expect(vectors).toEqual([[0], [1], [2], [3]]);
        expect(maximumActive).toBe(4);
        expect(state.contextCalls).toHaveLength(4);
        expect(EffectArray.map(state.contextCalls, call => call.threads)).toEqual([2, 2, 2, 2]);
        expect(engine.diagnostics.embeddingContextPlan).toEqual({
          effectiveContexts: 4,
          modelGpuLayers: 0,
          requestedContexts: 4,
          threadCounts: [2, 2, 2, 2],
        });
      }).pipe(provideTestLayer(layer)),
    );
  });

  it.effect('forces an offloaded model to one context without overriding its thread default', () => {
    const {layer, state} = embeddingHarness({
      context: () => immediateContext(input => [input.length]),
      gpu: 'metal',
      gpuLayers: 1,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* LlamaCppEngine;
        const session = yield* engine.loadEmbeddingSession({
          dimensions: 1,
          embeddingContextPoolSize: 8,
          modelId: 'gpu-pool',
          modelPath: '/models/gpu.gguf',
        });
        expect(yield* session.embedMany(['gpu'])).toEqual([[3]]);
        expect(state.contextCalls).toHaveLength(1);
        expect(state.contextCalls[0]?.threads).toBeUndefined();
      }).pipe(provideTestLayer(layer)),
    );
  });

  it.effect('rolls back earlier contexts and the model when pool construction fails', () => {
    const {layer, state} = embeddingHarness({
      context: ({contextIndex, modelIndex}) => {
        if (contextIndex === 2) throw TestError.make({message: 'context construction failed'});
        let disposed = false;
        return {
          get disposed() {
            return disposed;
          },
          dispose: () => {
            disposed = true;
            state.events.push(`model-${modelIndex}:context-${contextIndex}:dispose`);
            return Promise.resolve();
          },
          getEmbeddingFor: () => Promise.reject(TestError.make({message: 'Unexpected embedding'})),
        };
      },
      gpuLayers: 0,
      poolSize: 4,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* LlamaCppEngine;
        const exit = yield* Effect.exit(
          engine.loadEmbeddingSession({
            dimensions: 1,
            modelId: 'partial-pool',
            modelPath: '/models/partial.gguf',
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(state.events.slice(0, 3)).toEqual([
          'model-0:context-1:dispose',
          'model-0:context-0:dispose',
          'model-0:dispose',
        ]);
      }).pipe(provideTestLayer(layer)),
    );
  });

  it.effect('treats rejection with undefined as failure, disposes the whole pool, and reloads', () => {
    const manifest = EffectOption.getOrUndefined(
      EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.role === 'embedding'),
    )!;
    const {layer, state} = embeddingHarness({
      context: ({contextIndex, modelIndex}) => {
        let disposed = false;
        return {
          get disposed() {
            return disposed;
          },
          dispose: () => {
            disposed = true;
            state.events.push(`model-${modelIndex}:context-${contextIndex}:dispose`);
            return Promise.resolve();
          },
          getEmbeddingFor: input =>
            modelIndex === 0
              ? Promise.reject(undefined)
              : Promise.resolve({vector: Array(manifest.dimensions).fill(input.length)}),
        };
      },
      gpuLayers: 0,
      poolSize: 4,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* LocalModelRuntime;
        const first = yield* Effect.exit(
          runtime.embedMany({inputs: ['first'], manifest, modelPath: '/models/reload.gguf'}),
        );
        expect(Exit.isFailure(first)).toBe(true);
        expect(state.events.slice(0, 5)).toEqual([
          'model-0:context-0:dispose',
          'model-0:context-1:dispose',
          'model-0:context-2:dispose',
          'model-0:context-3:dispose',
          'model-0:dispose',
        ]);
        expect(yield* runtime.embedMany({inputs: ['second'], manifest, modelPath: '/models/reload.gguf'})).toHaveLength(
          1,
        );
        expect(state.modelLoads).toBe(2);
      }).pipe(provideTestLayer(localModelRuntimeLayer(layer))),
    );
  });

  it.effect('poisons and reloads the pooled session after an invalid native vector', () => {
    const manifest = EffectOption.getOrUndefined(
      EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.role === 'embedding'),
    )!;
    const {layer, state} = embeddingHarness({
      context: ({contextIndex, modelIndex}) => {
        let disposed = false;
        return {
          get disposed() {
            return disposed;
          },
          dispose: () => {
            disposed = true;
            state.events.push(`model-${modelIndex}:context-${contextIndex}:dispose`);
            return Promise.resolve();
          },
          getEmbeddingFor: input =>
            Promise.resolve({
              vector:
                modelIndex === 0
                  ? [Number.NaN, ...Array(manifest.dimensions - 1).fill(0)]
                  : Array(manifest.dimensions).fill(input.length),
            }),
        };
      },
      gpuLayers: 0,
      poolSize: 4,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* LocalModelRuntime;
        const request = {inputs: ['invalid'], manifest, modelPath: '/models/invalid.gguf'} as const;
        expect(Exit.isFailure(yield* Effect.exit(runtime.embedMany(request)))).toBe(true);
        expect(state.modelDisposals).toEqual([0]);
        expect(yield* runtime.embedMany({...request, inputs: ['valid']})).toHaveLength(1);
        expect(state.modelLoads).toBe(2);
      }).pipe(provideTestLayer(localModelRuntimeLayer(layer))),
    );
  });

  it.effect('awaits interrupted-pool teardown before loading a replacement model', () => {
    const manifest = EffectOption.getOrUndefined(
      EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.role === 'embedding'),
    )!;
    const rejectPending = new Map<number, (cause: unknown) => void>();
    let releaseDisposals = () => {};
    const disposalGate = new Promise<void>(resolve => {
      releaseDisposals = resolve;
    });
    let embeddingStarted = false;
    const {layer, state} = embeddingHarness({
      context: ({contextIndex, modelIndex}) => {
        let disposed = false;
        return {
          get disposed() {
            return disposed;
          },
          dispose: async () => {
            state.events.push(`model-${modelIndex}:context-${contextIndex}:dispose-start`);
            if (modelIndex === 0) await disposalGate;
            disposed = true;
            const reject = rejectPending.get(contextIndex);
            rejectPending.delete(contextIndex);
            reject?.(new DOMException('Embedding context disposed.', 'AbortError'));
            state.events.push(`model-${modelIndex}:context-${contextIndex}:dispose-end`);
          },
          getEmbeddingFor: input => {
            if (modelIndex > 0) return Promise.resolve({vector: Array(manifest.dimensions).fill(input.length)});
            embeddingStarted = true;
            return new Promise((_, reject) => rejectPending.set(contextIndex, reject));
          },
        };
      },
      gpuLayers: 0,
      poolSize: 4,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* LocalModelRuntime;
        const request = {inputs: ['blocked'], manifest, modelPath: '/models/interrupted.gguf'} as const;
        const blocked = yield* Effect.forkChild(runtime.embedMany(request));
        while (!embeddingStarted) yield* Effect.yieldNow;
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(blocked));
        while (!state.events.includes('model-0:context-3:dispose-start')) yield* Effect.yieldNow;
        const retry = yield* Effect.forkChild(runtime.embedMany({...request, inputs: ['retry']}));
        for (let index = 0; index < 4; index += 1) yield* Effect.yieldNow;
        expect(state.modelLoads).toBe(1);
        releaseDisposals();
        yield* Fiber.join(interrupt);
        expect(yield* Fiber.join(retry)).toHaveLength(1);
        expect(state.modelLoads).toBe(2);
        expect(rejectPending.size).toBe(0);
        const oldModelDisposal = state.events.indexOf('model-0:dispose');
        expect(oldModelDisposal).toBeGreaterThan(state.events.lastIndexOf('model-0:context-0:dispose-end'));
      }).pipe(provideTestLayer(localModelRuntimeLayer(layer))),
    );
  });

  fcEffectProp(
    it,
    'preserves the serial input mapping under arbitrary bounded completion priorities',
    {
      poolSize: FC.constantFrom<EmbeddingContextPoolSize>(1, 2, 4, 8),
      priorities: FC.array(FC.integer({max: 100, min: 0}), {maxLength: 12, minLength: 1}),
    },
    ({poolSize, priorities}) => {
      const pending: Array<{
        readonly inputIndex: number;
        readonly priority: number;
        readonly resolve: () => void;
      }> = [];
      const calls: number[] = [];
      const activeByContext = new Map<number, number>();
      let active = 0;
      let maximumActive = 0;
      let perContextOverlap = false;
      const {layer} = embeddingHarness({
        context: ({contextIndex}) => {
          let disposed = false;
          return {
            get disposed() {
              return disposed;
            },
            dispose: () => {
              disposed = true;
              return Promise.resolve();
            },
            getEmbeddingFor: input => {
              // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
              const inputIndex = Number(Effect2.pipe(input, EffectString.slice(5)).split(':', 1)[0]);
              calls.push(inputIndex);
              active += 1;
              maximumActive = Math.max(maximumActive, active);
              const contextActive = (activeByContext.get(contextIndex) ?? 0) + 1;
              activeByContext.set(contextIndex, contextActive);
              if (contextActive > 1) perContextOverlap = true;
              return new Promise(resolve => {
                pending.push({
                  inputIndex,
                  priority: priorities[inputIndex],
                  resolve: () => {
                    active -= 1;
                    activeByContext.set(contextIndex, contextActive - 1);
                    resolve({vector: [inputIndex, input.length]});
                  },
                });
              });
            },
          };
        },
        gpuLayers: 0,
        poolSize,
      });
      const inputs = EffectArray.map(priorities, (priority, index) => `item-${index}:${priority}`);
      return Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* LlamaCppEngine;
          const session = yield* engine.loadEmbeddingSession({
            dimensions: 2,
            modelId: 'pool-property',
            modelPath: '/models/property.gguf',
          });
          const fiber = yield* Effect.forkChild(session.embedMany(inputs));
          for (let completed = 0; completed < inputs.length; completed += 1) {
            while (pending.length === 0) yield* Effect.yieldNow;
            let selected = 0;
            for (let index = 1; index < pending.length; index += 1) {
              if (pending[index].priority > pending[selected].priority) selected = index;
            }
            pending.splice(selected, 1)[0].resolve();
            yield* Effect.yieldNow;
          }
          const vectors = yield* Fiber.join(fiber);
          expect(vectors).toEqual(EffectArray.map(inputs, (input, index) => [index, input.length]));
          expect([...calls].sort((left, right) => left - right)).toEqual(EffectArray.map(inputs, (_, index) => index));
          expect(maximumActive).toBeLessThanOrEqual(poolSize);
          expect(perContextOverlap).toBe(false);
        }).pipe(provideTestLayer(layer)),
      );
    },
    {fastCheck: {numRuns: 24}},
  );
});
