import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {BUILTIN_MODEL_MANIFESTS, CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
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
