import {Array as EffectArray, Option as EffectOption} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result, Schema} from 'effect';
import {describe, expect, vi} from 'vitest';
import {LocalModelCatalog, type LocalModelManifest, type LocalModelRole} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {ModelManifestInvalid} from '@threadnote/inference/engine/errors';
import {LocalModelRuntime, type LocalGenerationRequest} from '@threadnote/inference/engine/local-model-runtime';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {SystemInfo} from '@threadnote/platform/system';
import {discoverLocalConsolidationModels} from '../../src/manager/consolidation_models.js';
import {detectConsolidationAgents} from '../../src/manager/state.js';
import {runNativeAiConsolidation} from '../../src/effect/ai/consolidator.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as utils from '../../src/utils.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

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
    revision: Effect2.pipe('a', EffectString.repeat(40)),
    role,
    runtime: {nodeLlamaCpp: '3.21.1'},
    sha256: Effect2.pipe('b', EffectString.repeat(64)),
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
      get: id => {
        const model = EffectOption.getOrUndefined(EffectArray.findFirst(manifests, model => model.id === id));
        return model
          ? Effect.succeed(model)
          : Effect.fail(ModelManifestInvalid.make({message: `Unknown local model: ${id}.`, modelId: id}));
      },
      list: role => Effect.succeed(EffectArray.filter(manifests, model => role === undefined || model.role === role)),
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
  effectIt.effect('keeps an unavailable explicit selection when the installed catalog is empty', () =>
    Effect.gen(function* () {
      const home = yield* temporaryHome();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(home, 'models'));
      const selectionPath = path.join(home, 'models/selection.json');
      const raw = JSON.stringify({version: 1, roles: {generation: 'model-0'}});
      yield* fs.writeFileString(selectionPath, raw);
      expect(yield* discoverLocalConsolidationModels(home)).toEqual([]);
      expect(yield* fs.readFileString(selectionPath)).toBe(raw);
    }).pipe(provideTestLayer(services([], []))),
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
      const manifests = EffectArray.map(entries, (entry, index) => manifest(`model-${index}`, entry.role));
      const installed = EffectArray.map(
        EffectArray.filter(manifests, (_model, index) => index in manifests && entries[index].installed),
        model => model.id,
      );
      return Effect.gen(function* () {
        const home = yield* temporaryHome();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(home, 'models'));
        const selection = {version: 1, roles: selected < 0 ? {} : {generation: `model-${selected}`}};
        const raw = JSON.stringify(selection);
        yield* fs.writeFileString(path.join(home, 'models/selection.json'), raw);
        const models = yield* discoverLocalConsolidationModels(home);
        expect(EffectArray.map(models, model => model.id)).toEqual(
          EffectArray.map(
            EffectArray.filter(
              manifests,
              (model, index) => index in manifests && model.role === 'generation' && entries[index].installed,
            ),
            model => model.id,
          ),
        );
        expect(
          EffectArray.map(
            EffectArray.filter(models, (model, __effectArrayIndex) => __effectArrayIndex in models && model.isDefault),
            model => model.id,
          ),
        ).toEqual(
          EffectArray.map(
            EffectArray.filter(models, model => model.id === selection.roles.generation),
            model => model.id,
          ),
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
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(agents, agent => agent.id === 'local-ai')),
      ).toMatchObject({
        available: true,
        label: 'Threadnote local AI',
      });
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(agents, agent => agent.id === 'effect-ai')),
      ).toMatchObject({
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
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(agents, agent => agent.id === 'local-ai')),
        ).toMatchObject({
          available: false,
          command: undefined,
          label: 'Threadnote local AI',
        });
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(agents, agent => agent.id === 'effect-ai')),
        ).toMatchObject({
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
