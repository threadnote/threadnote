import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Effect, Layer} from 'effect';
import {describe, expect, it} from 'vitest';
import {GenerationFailed} from '@threadnote/inference/engine/errors';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {runNativeMemoryEnrichment} from '@threadnote/threadnote/effect/ai/enrichment';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const manifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'gemma-4-e4b-it-q4'),
)!;

describe('native memory enrichment', () => {
  it('uses the selected in-process generation model and validates its structured output', async () => {
    const home = await mkdtemp('threadnote-native-enrichment-');
    try {
      const effect = Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'generation', manifest.id);
        return yield* runNativeMemoryEnrichment(
          {agentContextHome: home},
          {
            body: 'Workers resume after a stalled heartbeat lease expires.',
            kind: 'durable',
            project: 'threadnote',
            topic: 'lease-recovery',
          },
        );
      }).pipe(provideTestLayer(fakeRuntimeLayer), provideTestLayer(fakeStoreLayer(home)));
      await expect(runEffect(effect)).resolves.toEqual([
        'resume jobs after heartbeat timeout',
        'recover worker after expired lease',
      ]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('keeps the native generation failure actionable when enrichment is skipped', async () => {
    const home = await mkdtemp('threadnote-native-enrichment-');
    try {
      const effect = Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'generation', manifest.id);
        return yield* runNativeMemoryEnrichment(
          {agentContextHome: home},
          {
            body: 'A durable memory.',
            kind: 'durable',
            project: 'threadnote',
            topic: 'native-enrichment',
          },
        );
      }).pipe(provideTestLayer(failingRuntimeLayer), provideTestLayer(fakeStoreLayer(home)));
      await expect(runEffect(effect)).rejects.toThrow(
        'Native memory enrichment failed: Could not create a generation context for gemma-4-e4b-it-q4: native context detail',
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });
});

const fakeRuntimeLayer = Layer.succeed(
  LocalModelRuntime,
  LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: () => Effect.die(TestError.make({message: 'Unexpected embedding'})),
    generate: () =>
      Effect.succeed({
        searchPhrases: ['resume jobs after heartbeat timeout', 'recover worker after expired lease', 'lease recovery'],
      }),
    rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
  }),
);

const failingRuntimeLayer = Layer.succeed(
  LocalModelRuntime,
  LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: () => Effect.die(TestError.make({message: 'Unexpected embedding'})),
    generate: request =>
      Effect.fail(
        GenerationFailed.make({
          cause: new TypeError("Cannot read properties of undefined (reading '_vocabOnly')"),
          message: `Could not create a generation context for ${request.manifest.id}: native context detail`,
          modelId: request.manifest.id,
        }),
      ),
    rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
  }),
);

function fakeStoreLayer(home: string) {
  const installation = {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/gemma.gguf`,
    verified: true,
  };
  return Layer.succeed(
    LocalModelStore,
    LocalModelStore.of({
      install: () => Effect.die(TestError.make({message: 'Unexpected install'})),
      path: () => installation.path,
      remove: () => Effect.succeed(false),
      status: () => Effect.succeed(installation),
      verify: () => Effect.succeed(installation),
    } satisfies LocalModelStoreShape),
  );
}
