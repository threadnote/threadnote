import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result, Schema} from 'effect';
import {describe, expect, vi} from 'vitest';
import {LocalModelCatalog, type LocalModelManifest, type LocalModelRole} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime, type LocalGenerationRequest} from '@threadnote/inference/engine/local-model-runtime';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {SystemInfo} from '@threadnote/platform/system';
import {discoverLocalConsolidationModels} from '../../src/manager/consolidation_models.js';
import {detectConsolidationAgents} from '../../src/manager/state.js';
import {runNativeAiConsolidation} from '../../src/effect/ai/consolidator.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as utils from '../../src/utils.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

function manifest(id: string, role: LocalModelRole = 'generation'): LocalModelManifest {
  return {
    architecture: 'gemma',
    contextLimit: 8192,
    file: `${id}.gguf`,
    id,
    license: 'test',
    minimumRamBytes: 1,
    quantization: 'q4',
    repository: 'test/model',
    revision: 'a'.repeat(40),
    role,
    runtime: {nodeLlamaCpp: '3.21.1'},
    sha256: 'b'.repeat(64),
    size: 1,
    version: 1,
  };
}
function services(
  manifests: readonly LocalModelManifest[],
  installed: readonly string[],
  generate = (_request: LocalGenerationRequest) => Effect.succeed<unknown>({draft: ' Selected draft. '}),
) {
  return Layer.mergeAll(
    BunServices.layer,
    TestSystemInfoLayer,
    Layer.succeed(LocalModelCatalog, {
      get: id => Effect.succeed(manifests.find(model => model.id === id)!),
      list: role => Effect.succeed(manifests.filter(model => role === undefined || model.role === role)),
      selected: () => Effect.die('Catalog defaults must not select a consolidation model.'),
    }),
    Layer.succeed(LocalModelStore, {
      path: (_home, model) => `/installed/${model.id}.gguf`,
      status: (_home, model) =>
        Effect.succeed({
          bytes: 1,
          installed: installed.includes(model.id),
          modelId: model.id,
          partialBytes: 0,
          path: `/installed/${model.id}.gguf`,
          verified: false,
        }),
      install: () => Effect.die('Consolidation must not install models.'),
      remove: () => Effect.die('Consolidation must not remove models.'),
      verify: () => Effect.die('Not used.'),
    }),
    Layer.succeed(LocalModelRuntime, {
      generate,
      diagnostics: Effect.die('Not used.'),
      embedMany: () => Effect.die('Not used.'),
      rerank: () => Effect.die('Not used.'),
    }),
  );
}
function temporaryHome() {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.makeTempDirectoryScoped({prefix: 'threadnote-local-consolidation-'})),
  );
}

describe('Manager local AI consolidation', () => {
  effectIt.effect('lists only installed generation models and marks only the installed selection as default', () =>
    Effect.gen(function* () {
      const home = yield* temporaryHome();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(home, 'models'));
      yield* fs.writeFileString(
        path.join(home, 'models/selection.json'),
        JSON.stringify({version: 1, roles: {generation: 'selected'}}),
      );
      expect(yield* discoverLocalConsolidationModels(home)).toEqual([
        {id: 'selected', label: 'selected', isDefault: true},
        {id: 'other', label: 'other', isDefault: false},
      ]);
    }).pipe(
      provideTestLayer(
        services(
          [manifest('selected'), manifest('other'), manifest('missing'), manifest('embedding', 'embedding')],
          ['selected', 'other', 'embedding'],
        ),
      ),
    ),
  );
  effectIt.effect.prop(
    'installed catalog is the generation subset and discovery preserves selection',
    {
      entries: Schema.Array(
        Schema.Struct({role: Schema.Literals(['generation', 'embedding', 'reranker']), installed: Schema.Boolean}),
      ).check(Schema.isMaxLength(20)),
      selected: Schema.Int.check(Schema.isBetween({minimum: -1, maximum: 20})),
    },
    ({entries, selected}) => {
      const manifests = entries.map((entry, index) => manifest(`model-${index}`, entry.role));
      const installed = manifests.filter((_model, index) => entries[index].installed).map(model => model.id);
      return Effect.gen(function* () {
        const home = yield* temporaryHome();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(home, 'models'));
        const selection = {version: 1, roles: selected < 0 ? {} : {generation: `model-${selected}`}};
        const raw = JSON.stringify(selection);
        yield* fs.writeFileString(path.join(home, 'models/selection.json'), raw);
        const models = yield* discoverLocalConsolidationModels(home);
        expect(models.map(model => model.id)).toEqual(
          manifests
            .filter((model, index) => model.role === 'generation' && entries[index].installed)
            .map(model => model.id),
        );
        expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(
          models.filter(model => model.id === selection.roles.generation).map(model => model.id),
        );
        expect(yield* fs.readFileString(path.join(home, 'models/selection.json'))).toBe(raw);
      }).pipe(provideTestLayer(services(manifests, installed)));
    },
    {arbitrary: {runs: 30}},
  );
  effectIt.effect('advertises local availability without a global default and keeps remote identity separate', () =>
    Effect.gen(function* () {
      const home = yield* temporaryHome();
      const find = vi.spyOn(utils, 'findExecutable').mockImplementation(() => Effect.succeed('/fake/agent'));
      const agents = yield* detectConsolidationAgents({agentContextHome: home}).pipe(
        Effect.ensuring(Effect.sync(() => find.mockRestore())),
      );
      expect(agents.find(agent => agent.id === 'local-ai')).toMatchObject({
        available: true,
        label: 'Threadnote local AI',
      });
      expect(agents.find(agent => agent.id === 'effect-ai')).toMatchObject({
        label: 'Configured remote AI',
      });
    }).pipe(provideTestLayer(services([manifest('installed')], ['installed']))),
  );
  effectIt.effect(
    'advertises explicit remote configuration separately when no local generation model is installed',
    () =>
      Effect.gen(function* () {
        const home = yield* temporaryHome();
        const system = yield* SystemInfo;
        const find = vi.spyOn(utils, 'findExecutable').mockImplementation(() => Effect.succeed('/fake/agent'));
        const agents = yield* detectConsolidationAgents({agentContextHome: home}).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            environment: () => ({THREADNOTE_EFFECT_AI: 'true', THREADNOTE_EFFECT_AI_MODEL: 'remote-model'}),
          }),
          Effect.ensuring(Effect.sync(() => find.mockRestore())),
        );
        expect(agents.find(agent => agent.id === 'local-ai')).toMatchObject({
          available: false,
          command: undefined,
          label: 'Threadnote local AI',
        });
        expect(agents.find(agent => agent.id === 'effect-ai')).toMatchObject({
          available: true,
          command: 'remote-model',
          label: 'Configured remote AI',
        });
      }).pipe(provideTestLayer(services([manifest('not-installed')], []))),
  );
  effectIt.effect('generates exactly the submitted installed model and preserves the global selection', () => {
    let request: LocalGenerationRequest | undefined;
    return Effect.gen(function* () {
      const home = yield* temporaryHome();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(home, 'models'));
      const raw = JSON.stringify({version: 1, roles: {generation: 'default'}});
      yield* fs.writeFileString(path.join(home, 'models/selection.json'), raw);
      expect(yield* runNativeAiConsolidation({agentContextHome: home}, 'Combine sources.', 'chosen')).toBe(
        'Selected draft.',
      );
      expect(request).toMatchObject({
        manifest: {id: 'chosen'},
        modelPath: '/installed/chosen.gguf',
        prompt: 'Combine sources.',
      });
      expect(yield* fs.readFileString(path.join(home, 'models/selection.json'))).toBe(raw);
    }).pipe(
      provideTestLayer(
        services([manifest('default'), manifest('chosen')], ['default', 'chosen'], input =>
          Effect.sync(() => {
            request = input;
            return {draft: ' Selected draft. '};
          }),
        ),
      ),
    );
  });
  effectIt.effect.each(['missing', 'embedding'])(
    'rejects uninstalled or wrong-role submitted model %s without generation',
    model => {
      let generated = false;
      return Effect.gen(function* () {
        const home = yield* temporaryHome();
        const result = yield* runNativeAiConsolidation({agentContextHome: home}, 'Combine sources.', model).pipe(
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(generated).toBe(false);
        expect((yield* readModelSelection(home)).roles).toEqual({});
      }).pipe(
        provideTestLayer(
          services([manifest('missing'), manifest('embedding', 'embedding')], ['embedding'], () =>
            Effect.sync(() => {
              generated = true;
              return {draft: 'Unexpected'};
            }),
          ),
        ),
      );
    },
  );
});
