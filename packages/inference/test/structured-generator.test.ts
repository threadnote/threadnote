import {it as effectIt} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import type {GenerationSampling} from '../src/engine/llama-cpp-engine.js';
import {nodeLlamaCppEngineLayer} from '../src/engine/node-llama-cpp.js';
import {llamaStructuredGeneratorLayer, StructuredGenerator} from '../src/engine/structured-generator.js';

function forwardingExample(sampling?: GenerationSampling) {
  return Effect.gen(function* () {
    const calls: {prompt: string; options: Record<string, unknown>}[] = [];
    class ChatSession {
      readonly disposed = false;
      dispose() {}
      prompt(prompt: string, options: Record<string, unknown>) {
        calls.push({prompt, options});
        return Promise.resolve('{"answer":"fixture"}');
      }
    }
    const engine = nodeLlamaCppEngineLayer({
      loadModule: () =>
        Promise.resolve({
          LlamaChatSession: ChatSession,
          getLlama: () =>
            Promise.resolve({
              buildType: 'prebuilt' as const,
              cpuMathCores: 1,
              disposed: false,
              gpu: false as const,
              dispose: () => Promise.resolve(),
              createGrammarForJsonSchema: () => Promise.resolve({parse: (json: string) => JSON.parse(json) as unknown}),
              loadModel: () =>
                Promise.resolve({
                  disposed: false,
                  dispose: () => Promise.resolve(),
                  createContext: () =>
                    Promise.resolve({
                      disposed: false,
                      dispose: () => Promise.resolve(),
                      getSequence: () => ({}),
                    }),
                  createEmbeddingContext: () => Promise.reject(TestError.make({message: 'Unexpected embedding'})),
                  createRankingContext: () => Promise.reject(TestError.make({message: 'Unexpected ranking'})),
                  detokenize: () => '',
                  tokenize: () => [],
                }),
            }),
        }),
    });
    const generator = llamaStructuredGeneratorLayer({modelId: 'fixture', modelPath: '/fixture.gguf'}).pipe(
      Layer.provide(engine),
    );
    const request = Object.freeze({
      jsonSchema: {type: 'object'},
      maxTokens: 37,
      prompt: 'Unmodified prompt.',
      seed: 0,
      ...(sampling ? {sampling: Object.freeze({...sampling})} : {}),
    });
    const before = structuredClone(request);
    const result = yield* Effect.scoped(
      Layer.build(generator).pipe(
        Effect.flatMap(context =>
          Effect.gen(function* () {
            const service = yield* StructuredGenerator;
            return yield* service.generate(request);
          }).pipe(Effect.provide(context)),
        ),
      ),
    );
    expect(result).toEqual({answer: 'fixture'});
    expect(request).toEqual(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      prompt: request.prompt,
      options: {maxTokens: request.maxTokens, seed: request.seed, temperature: sampling?.temperature ?? 0},
    });
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
    if (sampling) {
      expect(calls[0].options.topP).toBe(sampling.topP);
      expect(calls[0].options.topK).toBe(sampling.topK);
    } else {
      expect(calls[0].options).not.toHaveProperty('topP');
      expect(calls[0].options).not.toHaveProperty('topK');
    }
  });
}

describe('structured generation sampling at the native SDK boundary', () => {
  effectIt.effect('keeps legacy temperature zero and omits unspecified filters', () => forwardingExample());
  effectIt.effect('forwards the explicit sampling profile', () =>
    forwardingExample({temperature: 1, topP: 0.95, topK: 64}),
  );
  effectIt.effect('preserves an explicitly supplied zero temperature', () =>
    forwardingExample({temperature: 0, topP: 0.5, topK: 1}),
  );
  fcEffectProp(
    effectIt,
    'forwards optional sampling without mutating requests',
    [
      FC.option(
        FC.record({
          temperature: FC.double({min: 0, max: 2, noNaN: true}),
          topP: FC.double({min: 0, max: 1, noNaN: true}),
          topK: FC.integer({min: 1, max: 256}),
        }),
        {nil: undefined},
      ),
    ],
    ([sampling]) => forwardingExample(sampling),
    {fastCheck: {numRuns: 32, seed: 756}},
  );
});
