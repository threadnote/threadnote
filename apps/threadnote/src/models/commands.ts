import {CORE_EMBEDDING_MODEL_ID, CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {stopModelSetup} from './setup.js';
import {Array as EffectArray, Console, Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelCatalog, type LocalModelRole} from '@threadnote/inference/models/catalog';
import {bundledCoreEmbeddingSource} from './core-embedding-asset.js';
import {LocalModelStore, modelDownloadUrl} from '@threadnote/inference/models/store';
import {
  clearLocalModelPurposeSelection,
  modelSelectionReferences,
  readModelSelection,
  selectLocalModel,
  selectLocalModelForPurpose,
  selectedEmbeddingModelId,
  type EmbeddingPurpose,
} from '@threadnote/inference/models/selection';

class ModelCommandError extends Schema.TaggedError<ModelCommandError, {readonly brand: unique symbol}>()(
  'ModelCommandError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const runModelList = Effect.fn('models.command.list')(function* (config: RuntimeConfig) {
  const catalog = yield* LocalModelCatalog;
  const store = yield* LocalModelStore;
  const selection = yield* readModelSelection(config.agentContextHome);
  for (const purpose of ['graph', 'recall'] as const) {
    const modelId = (yield* catalog.get(selectedEmbeddingModelId(selection, purpose) ?? CORE_EMBEDDING_MODEL_ID)).id;
    const source = selection.purposes?.[purpose] ? '' : selection.roles.embedding ? ' (shared fallback)' : ' (default)';
    yield* Console.log(`${purpose} embedding: ${modelId}${source}`);
  }
  for (const manifest of yield* catalog.list()) {
    const status = yield* store.status(config.agentContextHome, manifest);
    const purposes =
      manifest.role === 'embedding'
        ? EffectArray.filter(
            ['graph', 'recall'] as const,
            purpose => (selectedEmbeddingModelId(selection, purpose) ?? CORE_EMBEDDING_MODEL_ID) === manifest.id,
          )
        : [];
    const selected = EffectArray.join(
      EffectArray.filter(
        [selection.roles[manifest.role] === manifest.id ? 'role' : undefined, ...purposes],
        (value): value is string => value !== undefined,
      ),
      ', ',
    );
    const state = status.installed
      ? `installed ${formatBytes(status.bytes)}`
      : status.partialBytes > 0
        ? `partial ${formatBytes(status.partialBytes)}/${formatBytes(manifest.size)}`
        : 'not installed';
    yield* Console.log(
      `${manifest.id}\t${manifest.role}\t${state}${selected ? ` selected(${selected})` : ''}\t${manifest.license}`,
    );
  }
});

export const runModelInstall = Effect.fn('models.command.install')(function* (
  config: RuntimeConfig,
  modelId: string,
  options: {readonly dryRun?: boolean},
) {
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  const store = yield* LocalModelStore;
  const bundledSource = bundledCoreEmbeddingSource(manifest);
  if (options.dryRun === true) {
    yield* Console.log(
      bundledSource
        ? `Would install ${manifest.id} from the Threadnote executable.`
        : `Would download ${modelDownloadUrl(manifest)}.`,
    );
    yield* Console.log(`Would verify ${manifest.size} bytes and SHA-256 ${manifest.sha256}.`);
    yield* Console.log(`Would install to the Threadnote ${manifest.role} model store.`);
    return;
  }
  yield* Console.log(
    bundledSource
      ? `Installing bundled ${manifest.id} (${formatBytes(manifest.size)}).`
      : `Downloading ${manifest.id} (${formatBytes(manifest.size)}); interrupted downloads are resumable.`,
  );
  const installed = yield* store.install(config.agentContextHome, manifest, bundledSource);
  yield* Console.log(
    `${installed.resumed ? 'Resumed and installed' : 'Installed'} ${manifest.id}; checksum verified at ${installed.path}.`,
  );
});

export const runModelVerify = Effect.fn('models.command.verify')(function* (config: RuntimeConfig, modelId: string) {
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  const store = yield* LocalModelStore;
  const status = yield* store.verify(config.agentContextHome, manifest);
  yield* Console.log(`Verified ${manifest.id}: ${formatBytes(status.bytes)}, SHA-256 ${manifest.sha256}.`);
});

export const runModelRemove = Effect.fn('models.command.remove')(function* (
  config: RuntimeConfig,
  modelId: string,
  options: {readonly dryRun?: boolean},
) {
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  const selection = yield* readModelSelection(config.agentContextHome);
  const selectedFor = modelSelectionReferences(selection, modelId);
  if (selectedFor.length > 0) {
    return yield* ModelCommandError.make({
      message: `Model ${modelId} is selected for ${EffectArray.join(selectedFor, ', ')}. Clear or change those selections before removing it.`,
    });
  }
  const store = yield* LocalModelStore;
  if (options.dryRun === true) {
    yield* Console.log(`Would remove ${store.path(config.agentContextHome, manifest)}.`);
    return;
  }
  if (manifest.id === CORE_GENERATION_MODEL_ID) yield* stopModelSetup(config.agentContextHome);
  const removed = yield* store.remove(config.agentContextHome, manifest);
  yield* Console.log(removed ? `Removed model ${manifest.id}.` : `Model ${manifest.id} is not installed.`);
});

export const runModelClear = Effect.fn('models.command.clear')(function* (
  config: RuntimeConfig,
  purpose: EmbeddingPurpose,
) {
  const catalog = yield* LocalModelCatalog;
  const selection = yield* clearLocalModelPurposeSelection(config.agentContextHome, purpose);
  const modelId = (yield* catalog.get(selectedEmbeddingModelId(selection, purpose) ?? CORE_EMBEDDING_MODEL_ID)).id;
  yield* Console.log(
    `Cleared the ${purpose} embedding override; it now uses ${modelId}${selection.roles.embedding ? ' (shared fallback)' : ' (default)'}.`,
  );
});

export const runModelSelect = Effect.fn('models.command.select')(function* (
  config: RuntimeConfig,
  role: LocalModelRole | EmbeddingPurpose,
  modelId: string,
  options: {readonly dryRun?: boolean},
) {
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  const expectedRole = role === 'graph' || role === 'recall' ? 'embedding' : role;
  if (manifest.role !== expectedRole) {
    return yield* ModelCommandError.make({message: `Model ${modelId} has role ${manifest.role}, not ${expectedRole}.`});
  }
  const store = yield* LocalModelStore;
  const status = yield* store.status(config.agentContextHome, manifest);
  if (!status.installed) {
    return yield* ModelCommandError.make({
      message: `Model ${modelId} is not installed. Run: threadnote models install ${modelId}`,
    });
  }
  if (options.dryRun === true) {
    yield* Console.log(`Would select ${modelId} for ${role}.`);
    return;
  }
  yield* store.verify(config.agentContextHome, manifest);
  if (role === 'graph' || role === 'recall')
    yield* selectLocalModelForPurpose(config.agentContextHome, catalog, role, modelId);
  else yield* selectLocalModel(config.agentContextHome, catalog, role, modelId);
  yield* Console.log(`Selected ${modelId} for ${role}.`);
  if (role === 'graph')
    yield* Console.log('Graph vectors use model-specific storage; rebuild graph vectors to prepare this choice.');
  if (role === 'recall')
    yield* Console.log('Run `threadnote index rebuild` to prepare recall vectors for this choice.');
});

export const runModelRuntimeStatus = Effect.fn('models.command.runtime')(function* () {
  const runtime = yield* LocalModelRuntime;
  const diagnostics = yield* runtime.diagnostics;
  yield* Console.log(`node-llama-cpp: ${diagnostics.buildType}`);
  yield* Console.log(`Backend: ${diagnostics.backend}`);
  yield* Console.log(`CPU math cores: ${diagnostics.cpuMathCores}`);
});

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
