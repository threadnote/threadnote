import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {LlamaCppEngine} from '../../src/engine/llama-cpp-engine.js';
import {nodeLlamaCppEngineLayer} from '../../src/engine/node-llama-cpp.js';

const host = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        ChildEnvironmentPolicy,
        ChildEnvironmentPolicy.of({
          preserveIntendedChild: environment => environment,
          sanitizeExternal: environment => environment,
        }),
      ),
      Layer.succeed(RuntimeEntrypoint, RuntimeEntrypoint.of({developmentEntrypoint: '/unused-fixture.ts'})),
    ),
  ),
);

effectIt.layer(Layer.mergeAll(BunServices.layer, host))(it => {
  it.effect('keeps foreground host and context policy when loading a verified staged module', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* SystemInfo;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-inference-module-'});
      const modulePath = path.join(directory, 'runtime.js');
      yield* fs.writeFileString(
        modulePath,
        `export class LlamaChatSession {}
      export async function getLlama(options) {
        if(options.build!=='never'||options.skipDownload!==true) throw new Error('Unexpected runtime build/download policy');
        return {buildType:'localBuild',gpu:'metal',cpuMathCores:8,dispose:async()=>{},loadModel:async(modelOptions)=>({
          gpuLayers:modelOptions.gpuLayers,dispose:async()=>{},tokenize:()=>[1],detokenize:()=>'',
          createEmbeddingContext:async()=>({dispose:async()=>{},getEmbeddingFor:async()=>({vector:[1]})})})};
      }`,
      );
      const moduleUrl = yield* path.toFileUrl(modulePath);
      const system = SystemInfo.of({
        ...base,
        platform: 'darwin',
        architecture: 'arm64',
        environment: () => ({THREADNOTE_EMBEDDING_CONTEXTS: '4'}),
      });
      const engine = nodeLlamaCppEngineLayer({moduleSpecifier: moduleUrl.href}).pipe(
        Layer.provide(Layer.succeed(SystemInfo, system)),
      );
      yield* Effect.scoped(
        Layer.build(engine).pipe(
          Effect.flatMap(context =>
            Effect.gen(function* () {
              const service = yield* LlamaCppEngine;
              yield* service.loadEmbeddingSession({
                modelId: 'fixture',
                modelPath: '/fixture.gguf',
                dimensions: 1,
                darwinArm64EmbeddingGpuLayers: 5,
              });
              expect(service.diagnostics.embeddingContextPlan).toMatchObject({
                requestedContexts: 4,
                effectiveContexts: 1,
                modelGpuLayers: 5,
              });
            }).pipe(Effect.provide(context)),
          ),
        ),
      );
    }),
  );
});
