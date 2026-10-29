import {CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {stopModelSetup} from './setup.js';
import {Console, Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelCatalog, type LocalModelRole} from '@threadnote/inference/models/catalog';
import {bundledCoreEmbeddingSource} from './core-embedding-asset.js';
import {LocalModelStore, modelDownloadUrl} from '@threadnote/inference/models/store';
import {readModelSelection, selectLocalModel} from '@threadnote/inference/models/selection';

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
  for (const manifest of yield* catalog.list()) {
    const status = yield* store.status(config.agentContextHome, manifest);
    const selected = selection.roles[manifest.role] === manifest.id ? ' selected' : '';
    const state = status.installed
      ? `installed ${formatBytes(status.bytes)}`
      : status.partialBytes > 0
        ? `partial ${formatBytes(status.partialBytes)}/${formatBytes(manifest.size)}`
        : 'not installed';
    yield* Console.log(`${manifest.id}\t${manifest.role}\t${state}${selected}\t${manifest.license}`);
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
  const store = yield* LocalModelStore;
  if (options.dryRun === true) {
    yield* Console.log(`Would remove ${store.path(config.agentContextHome, manifest)}.`);
    return;
  }
  if (manifest.id === CORE_GENERATION_MODEL_ID) yield* stopModelSetup(config.agentContextHome);
  const removed = yield* store.remove(config.agentContextHome, manifest);
  yield* Console.log(removed ? `Removed model ${manifest.id}.` : `Model ${manifest.id} is not installed.`);
});

export const runModelSelect = Effect.fn('models.command.select')(function* (
  config: RuntimeConfig,
  role: LocalModelRole,
  modelId: string,
  options: {readonly dryRun?: boolean},
) {
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== role) {
    return yield* ModelCommandError.make({message: `Model ${modelId} has role ${manifest.role}, not ${role}.`});
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
  yield* selectLocalModel(config.agentContextHome, catalog, role, modelId);
  yield* Console.log(`Selected ${modelId} for ${role}.`);
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
