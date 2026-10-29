import {Console, Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {currentRecallCorpusGeneration, loadRecallIndexData} from '@threadnote/recall/index';
import {purgeVectorIndex, rebuildVectorIndex, vectorIndexStatus} from '@threadnote/recall/vector-index';

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
  const modelId = options.model ?? selection.roles.embedding;
  if (!modelId) {
    return yield* SearchCommandError.make({
      message: 'No embedding model is selected. Run `threadnote repair` to provision it.',
    });
  }
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== 'embedding') {
    return yield* SearchCommandError.make({message: `Model ${modelId} is not an embedding model.`});
  }
  const index = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
  yield* Console.log(`Embedding ${index.candidates.length} canonical document(s) with ${manifest.id}.`);
  const result = yield* rebuildVectorIndex(config, manifest, index.candidates, {
    corpusGeneration: index.generation,
    currentCorpusGeneration: () => currentRecallCorpusGeneration(config),
  });
  yield* Console.log(
    `Activated vector generation ${result.generation}: ${result.chunkCount} chunk(s), ${result.dimensions} dimensions.`,
  );
});

export const runIndexStatus = Effect.fn('index.command.status')(function* (config: RuntimeConfig) {
  const catalog = yield* LocalModelCatalog;
  const selection = yield* readModelSelection(config.agentContextHome);
  for (const manifest of yield* catalog.list('embedding')) {
    const status = yield* vectorIndexStatus(config.agentContextHome, manifest);
    const selected = selection.roles.embedding === manifest.id ? ' selected' : '';
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
  const modelId = options.model ?? selection.roles.embedding;
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
  const modelId = options.model ?? selection.roles.embedding;
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
