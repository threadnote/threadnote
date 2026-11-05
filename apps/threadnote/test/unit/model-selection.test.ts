import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  BUILTIN_MODEL_MANIFESTS,
  CORE_EMBEDDING_MODEL_ID,
  CORE_GENERATION_MODEL_ID,
} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {runModelClear, runModelList} from '@threadnote/threadnote/models/commands';
import {
  readModelSelection,
  selectLocalModel,
  clearLocalModelSelection,
  clearLocalModelPurposeSelection,
  modelSelectionReferences,
  selectLocalModelForPurpose,
  selectedEmbeddingModelId,
  writeModelSelection,
} from '@threadnote/inference/models/selection';

describe('model selection', () => {
  effectIt.effect('distinguishes an unselected home from a provisioned shared embedding fallback', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-command-'});
        const config = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        const listed = yield* captureConsole(runModelList(config));
        expect(listed.output).toContain(`graph embedding: unselected (setup default: ${CORE_EMBEDDING_MODEL_ID})`);
        expect(listed.output).toContain(`recall embedding: unselected (setup default: ${CORE_EMBEDDING_MODEL_ID})`);
        expect(listed.output).not.toContain('selected(graph, recall)');
        yield* writeModelSelection(home, {purposes: {graph: 'embeddinggemma-2-q8'}, roles: {}, version: 1});
        const cleared = yield* captureConsole(runModelClear(config, 'graph'));
        expect(cleared.output).toContain(`it now uses no selected model (setup default: ${CORE_EMBEDDING_MODEL_ID}).`);
        expect((yield* readModelSelection(home)).purposes?.graph).toBeUndefined();
        yield* writeModelSelection(home, {
          purposes: {graph: 'embeddinggemma-2-q8'},
          roles: {embedding: CORE_EMBEDDING_MODEL_ID},
          version: 1,
        });
        const provisioned = yield* captureConsole(runModelList(config));
        expect(provisioned.output).toContain(`recall embedding: ${CORE_EMBEDDING_MODEL_ID} (shared fallback)`);
        expect(provisioned.output).toContain('selected(role, recall)');
        const inherited = yield* captureConsole(runModelClear(config, 'graph'));
        expect(inherited.output).toContain(`it now uses ${CORE_EMBEDDING_MODEL_ID} (shared fallback).`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('atomically records role-aware selection and ignores a malformed receipt', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectory({prefix: 'threadnote-model-selection-'});
      yield* Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* writeModelSelection(home, {
          purposes: {graph: 'embeddinggemma-2-q8', recall: 'qwen3-embedding-0.6b-q8'},
          roles: {},
          version: 1,
        });
        const selected = yield* selectLocalModel(home, catalog, 'embedding', 'bge-small-en-v1.5-q8');
        expect(selected.roles.embedding).toBe('bge-small-en-v1.5-q8');
        expect(selected.purposes).toEqual({graph: 'embeddinggemma-2-q8', recall: 'qwen3-embedding-0.6b-q8'});
        yield* selectLocalModel(home, catalog, 'generation', CORE_GENERATION_MODEL_ID);
        const clearedRole = yield* clearLocalModelSelection(home, 'generation');
        expect(clearedRole.roles.generation).toBeUndefined();
        expect(clearedRole.roles.embedding).toBe('bge-small-en-v1.5-q8');
        expect(clearedRole.purposes).toEqual({graph: 'embeddinggemma-2-q8', recall: 'qwen3-embedding-0.6b-q8'});
        expect((yield* readModelSelection(home)).roles.embedding).toBe('bge-small-en-v1.5-q8');
      }).pipe(Effect.ensuring(fs.remove(home, {force: true, recursive: true}).pipe(Effect.orDie)));
    }).pipe(provideTestLayer(LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS)), provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('stores graph and recall embedding choices independently from the shared fallback', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectory({prefix: 'threadnote-model-purpose-'});
      yield* Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', 'bge-small-en-v1.5-q8');
        yield* selectLocalModelForPurpose(home, catalog, 'graph', 'embeddinggemma-2-q8');
        yield* selectLocalModelForPurpose(home, catalog, 'recall', 'qwen3-embedding-0.6b-q8');
        const selection = yield* readModelSelection(home);
        expect(selection.roles.embedding).toBe('bge-small-en-v1.5-q8');
        expect(selectedEmbeddingModelId(selection, 'graph')).toBe('embeddinggemma-2-q8');
        expect(selectedEmbeddingModelId(selection, 'recall')).toBe('qwen3-embedding-0.6b-q8');
        expect(modelSelectionReferences(selection, 'embeddinggemma-2-q8')).toEqual(['graph']);
        expect(modelSelectionReferences(selection, 'qwen3-embedding-0.6b-q8')).toEqual(['recall']);
        const changed = yield* selectLocalModelForPurpose(home, catalog, 'graph', 'qwen3-embedding-0.6b-q8');
        expect(changed.roles.embedding).toBe('bge-small-en-v1.5-q8');
        expect(changed.purposes?.recall).toBe('qwen3-embedding-0.6b-q8');
        const cleared = yield* clearLocalModelPurposeSelection(home, 'graph');
        expect(cleared.purposes?.graph).toBeUndefined();
        expect(selectedEmbeddingModelId(cleared, 'graph')).toBe('bge-small-en-v1.5-q8');
        expect(selectedEmbeddingModelId(cleared, 'recall')).toBe('qwen3-embedding-0.6b-q8');
      }).pipe(Effect.ensuring(fs.remove(home, {force: true, recursive: true}).pipe(Effect.orDie)));
    }).pipe(provideTestLayer(LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS)), provideTestLayer(ApplicationLayer)),
  );
});
