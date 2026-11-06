import {Console, Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {readModelSelection, selectedEmbeddingModelId} from '@threadnote/inference/models/selection';
import {loadRecallVectorAuthorizationKey, purgeVectorIndex, vectorIndexStatus} from '@threadnote/recall/vector-index';
import {prepareRecallIndexes} from '../lifecycle.js';

class SearchCommandError extends Schema.TaggedError<SearchCommandError, {readonly brand: unique symbol}>()(
  'SearchCommandError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const runIndexRebuild = Effect.fn('index.command.rebuild')(function* (
  config: RuntimeConfig,
  options: {readonly model?: string},
) {
  const catalog = yield* LocalModelCatalog;
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = options.model ?? selectedEmbeddingModelId(selection, 'recall');
  if (!modelId) {
    return yield* SearchCommandError.make({
      message: 'No embedding model is selected. Run `threadnote repair` to provision it.',
    });
  }
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== 'embedding') {
    return yield* SearchCommandError.make({message: `Model ${modelId} is not an embedding model.`});
  }
  const authorizationKey = yield* loadRecallVectorAuthorizationKey(config);
  const verifyInputs = Effect.gen(function* () {
    if (
      (options.model === undefined &&
        selectedEmbeddingModelId(yield* readModelSelection(config.agentContextHome), 'recall') !== modelId) ||
      (yield* loadRecallVectorAuthorizationKey(config)) !== authorizationKey
    ) {
      return yield* SearchCommandError.make({
        message: 'Recall inputs changed during preparation. Run `threadnote index rebuild` again.',
      });
    }
  });
  yield* prepareRecallIndexes(config, manifest, authorizationKey, verifyInputs);
});

export const runIndexStatus = Effect.fn('index.command.status')(function* (config: RuntimeConfig) {
  const catalog = yield* LocalModelCatalog;
  const selection = yield* readModelSelection(config.agentContextHome);
  for (const manifest of yield* catalog.list('embedding')) {
    const status = yield* vectorIndexStatus(config.agentContextHome, manifest);
    const selected = selectedEmbeddingModelId(selection, 'recall') === manifest.id ? ' selected' : '';
    yield* Console.log(
      status.ready
        ? `${manifest.id}\tready\t${status.chunkCount} chunks\t${status.generation}${selected}`
        : `${manifest.id}\tunavailable\t${status.reason ?? 'unknown'}${selected}`,
    );
  }
});

export const runIndexVerify = Effect.fn('index.command.verify')(function* (
  config: RuntimeConfig,
  options: {readonly model?: string},
) {
  const catalog = yield* LocalModelCatalog;
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = options.model ?? selectedEmbeddingModelId(selection, 'recall');
  if (!modelId) {
    return yield* SearchCommandError.make({
      message: 'No embedding model is selected. Run `threadnote repair` to provision it.',
    });
  }
  const manifest = yield* catalog.get(modelId);
  const status = yield* vectorIndexStatus(config.agentContextHome, manifest);
  if (!status.ready) {
    return yield* SearchCommandError.make({
      message: `Vector index ${modelId} is invalid: ${status.reason ?? 'unknown error'}.`,
    });
  }
  yield* Console.log(
    `Verified vector generation ${status.generation}: ${status.chunkCount} chunks, ${status.dimensions} dimensions.`,
  );
});

export const runIndexPurge = Effect.fn('index.command.purge')(function* (
  config: RuntimeConfig,
  options: {readonly dryRun?: boolean; readonly model?: string},
) {
  const catalog = yield* LocalModelCatalog;
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = options.model ?? selectedEmbeddingModelId(selection, 'recall');
  if (!modelId) {
    return yield* SearchCommandError.make({
      message: 'No embedding model is selected. Run `threadnote repair` to provision it.',
    });
  }
  yield* catalog.get(modelId);
  if (options.dryRun === true) {
    yield* Console.log(`Would purge derived vector generations for ${modelId}; canonical resources are untouched.`);
    return;
  }
  const removed = yield* purgeVectorIndex(config.agentContextHome, modelId);
  yield* Console.log(
    removed ? `Purged derived vector index for ${modelId}.` : `No vector index exists for ${modelId}.`,
  );
});
