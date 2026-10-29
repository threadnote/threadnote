import {Array as EffectArray, Option as EffectOption} from 'effect';
import {stopModelSetup} from '../models/setup.js';
import {Console, Effect, Predicate, Schema} from 'effect';
import {BUILTIN_MODEL_MANIFESTS, CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {runModelInstall, runModelSelect} from '../models/commands.js';
import {resolveSelectedLocalModel, type SelectedLocalModel} from '@threadnote/inference/models/inference';
import {clearLocalModelSelection, readModelSelection, selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class LocalAiOperationError extends Schema.TaggedError<LocalAiOperationError, {readonly brand: unique symbol}>()(
  'LocalAiOperationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const COMPATIBILITY_MODEL_ID = 'gemma-4-e4b-it-q4';
const compatibilityModel = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === COMPATIBILITY_MODEL_ID),
)!;

export const LOCAL_AI_MODEL_ID = compatibilityModel.id;
export const LOCAL_AI_MODEL_FILE = compatibilityModel.file;
export const LOCAL_AI_MODEL_REPOSITORY = compatibilityModel.repository;
export const LOCAL_AI_MODEL_REVISION = compatibilityModel.revision;
export const LOCAL_AI_MODEL_SHA256 = compatibilityModel.sha256;
export const LOCAL_AI_MODEL_SIZE = compatibilityModel.size;
/** @deprecated Threadnote 4 local inference has no listening port. */
export const LOCAL_AI_DEFAULT_PORT = 0;

type LocalAiRuntimeConfig = Pick<RuntimeConfig, 'agentContextHome'>;

export interface LocalAiSettings {
  readonly enabled: true;
  readonly host: 'in-process';
  readonly model: string;
  readonly modelPath: string;
  readonly port: 0;
  readonly version: 2;
}

export interface LocalAiInstallOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly model?: string;
  readonly modelPath?: string;
  readonly start?: boolean;
}

export interface LocalAiLifecycleOptions {
  readonly dryRun?: boolean;
}

export interface LocalAiModelSwitchOptions extends LocalAiLifecycleOptions {
  readonly model?: string;
}

export interface LocalAiUninstallOptions extends LocalAiLifecycleOptions {
  readonly eraseModel?: boolean;
}

export interface InstalledLocalAiModel {
  readonly definition: LocalModelManifest;
  readonly path: string;
}

export const runLocalAiInstall = Effect.fn('localAi.compat.install')(function* (
  config: RuntimeConfig,
  options: LocalAiInstallOptions,
) {
  if (options.modelPath) {
    return yield* LocalAiOperationError.make({
      message:
        '`threadnote local-ai --model-path` was removed in 4.0 because unmanaged model files bypass the signed catalog. Use `threadnote models install`.',
    });
  }
  const modelId = options.model ?? COMPATIBILITY_MODEL_ID;
  yield* Console.warn('`threadnote local-ai install` is deprecated; use `threadnote models install/select`.');
  yield* runModelInstall(config, modelId, {dryRun: options.dryRun});
  yield* runModelSelect(config, 'generation', modelId, {dryRun: options.dryRun});
});

export const runLocalAiModelSwitch = Effect.fn('localAi.compat.switch')(function* (
  config: RuntimeConfig,
  options: LocalAiModelSwitchOptions,
) {
  if (!options.model) {
    return yield* LocalAiOperationError.make({
      message: 'Specify `--model <id>`, or use `threadnote models list` and `threadnote models select generation`.',
    });
  }
  yield* Console.warn('`threadnote local-ai model switch` is deprecated; use `threadnote models select generation`.');
  yield* runModelSelect(config, 'generation', options.model, {dryRun: options.dryRun});
});

export const runLocalAiEnable = Effect.fn('localAi.compat.enable')(function* (
  config: RuntimeConfig,
  options: LocalAiLifecycleOptions,
) {
  const models = yield* installedGenerationModels(config);
  if (models.length === 0) {
    return yield* LocalAiOperationError.make({
      message: 'No generation model is installed. Run `threadnote models install <model-id>` first.',
    });
  }
  const selected = models[0];
  if (options.dryRun) {
    yield* Console.log(`Would select ${selected.definition.id} for local generation.`);
    return;
  }
  const catalog = yield* LocalModelCatalog;
  yield* selectLocalModel(config.agentContextHome, catalog, 'generation', selected.definition.id);
  yield* Console.log(`Selected ${selected.definition.id} for local generation.`);
});

export const runLocalAiDisable = Effect.fn('localAi.compat.disable')(function* (
  config: RuntimeConfig,
  options: LocalAiLifecycleOptions,
) {
  if (options.dryRun) {
    yield* Console.log('Would clear the selected generation model; installed GGUF files would remain.');
    return;
  }
  yield* stopModelSetup(config.agentContextHome);
  yield* clearLocalModelSelection(config.agentContextHome, 'generation');
  yield* Console.log('Cleared the selected generation model; installed GGUF files were preserved.');
});

export const runLocalAiStart = Effect.fn('localAi.compat.start')(function* (
  config: RuntimeConfig,
  options: LocalAiLifecycleOptions,
) {
  const selected = yield* requireSelectedGeneration(config);
  yield* Console.log(
    options.dryRun
      ? `Would verify ${selected.manifest.id}; inference starts in a supervised local worker on demand.`
      : `${selected.manifest.id} is ready. Threadnote 4 starts a supervised local inference worker on demand; there is no server to start.`,
  );
});

export const ensureLocalAiStarted = Effect.fn('localAi.compat.ensureReady')(function* (config: LocalAiRuntimeConfig) {
  yield* requireSelectedGeneration(config);
});

export const runLocalAiStop = Effect.fn('localAi.compat.stop')(function* (
  _config: RuntimeConfig,
  options: LocalAiLifecycleOptions,
) {
  yield* Console.log(
    options.dryRun
      ? 'Would release native model resources when the current Threadnote process exits.'
      : 'No local AI server is running; native model resources are scoped to each Threadnote process.',
  );
});

export const runLocalAiStatus = Effect.fn('localAi.compat.status')(function* (config: RuntimeConfig) {
  const selected = yield* resolveSelectedLocalModel(config.agentContextHome, 'generation');
  if (!selected) {
    yield* Console.log('No local generation model is selected.');
    return;
  }
  yield* Console.log(`${selected.manifest.id}\tselected\tlocal-worker\t${selected.path}`);
});

export const localAiDoctorCheck = Effect.fn('localAi.compat.doctorCheck')(function* (config: RuntimeConfig) {
  const selected = yield* resolveSelectedLocalModel(config.agentContextHome, 'generation');
  return selected
    ? {detail: `${selected.manifest.id}; local worker`, name: 'local generation model', status: 'ok' as const}
    : {
        detail: 'optional; no generation model selected',
        name: 'local generation model',
        status: 'warn' as const,
      };
});

export const runLocalAiUninstall = Effect.fn('localAi.compat.uninstall')(function* (
  config: RuntimeConfig,
  options: LocalAiUninstallOptions,
) {
  if (!options.dryRun) yield* stopModelSetup(config.agentContextHome);
  const selected = yield* resolveSelectedLocalModel(config.agentContextHome, 'generation');
  if (options.dryRun) {
    yield* Console.log(
      options.eraseModel
        ? `Would clear generation selection and remove ${selected?.manifest.id ?? CORE_GENERATION_MODEL_ID}.`
        : 'Would clear generation selection and preserve installed GGUF files.',
    );
    return;
  }
  yield* clearLocalModelSelection(config.agentContextHome, 'generation');
  if (options.eraseModel) {
    const store = yield* LocalModelStore;
    const catalog = yield* LocalModelCatalog;
    const manifest = selected?.manifest ?? (yield* catalog.get(CORE_GENERATION_MODEL_ID));
    yield* store.remove(config.agentContextHome, manifest);
  }
  yield* Console.log('Removed deprecated local-ai configuration state.');
});

export const readLocalAiSettings = Effect.fn('localAi.compat.readSettings')(function* (config: LocalAiRuntimeConfig) {
  const selected = yield* resolveSelectedLocalModel(config.agentContextHome, 'generation');
  return selected ? settingsFor(selected) : undefined;
});

export const listInstalledLocalAiModels = Effect.fn('localAi.compat.listInstalled')(function* (
  config: LocalAiRuntimeConfig,
) {
  const catalog = yield* LocalModelCatalog;
  const store = yield* LocalModelStore;
  const installed: InstalledLocalAiModel[] = [];
  for (const manifest of yield* catalog.list('generation')) {
    const status = yield* store.status(config.agentContextHome, manifest);
    if (status.installed) installed.push({definition: manifest, path: status.path});
  }
  return installed;
});

export function parseLocalAiSettings(value: unknown): LocalAiSettings {
  if (!Predicate.isObject(value)) {
    throw LocalAiOperationError.make({message: 'Legacy local-ai server settings are not valid Threadnote 4 settings.'});
  }
  if (
    value.enabled !== true ||
    value.version !== 2 ||
    value.host !== 'in-process' ||
    value.port !== 0 ||
    typeof value.model !== 'string' ||
    typeof value.modelPath !== 'string'
  ) {
    throw LocalAiOperationError.make({message: 'Legacy local-ai server settings are not valid Threadnote 4 settings.'});
  }
  return {enabled: true, host: 'in-process', model: value.model, modelPath: value.modelPath, port: 0, version: 2};
}

/** @deprecated There is no HTTP endpoint in Threadnote 4. */
export function localAiApiUrl(_settings: Pick<LocalAiSettings, 'host' | 'port'>): string {
  return 'threadnote+in-process://local-ai';
}

/** @deprecated Threadnote 4 has no local AI bearer token. */
export const readLocalAiAccessToken = Effect.fn('localAi.compat.readAccessToken')(function* (
  _config: LocalAiRuntimeConfig,
) {
  yield* Effect.void;
  return undefined;
});

function requireSelectedGeneration(config: LocalAiRuntimeConfig) {
  return resolveSelectedLocalModel(config.agentContextHome, 'generation').pipe(
    Effect.filterOrFail(
      selected => selected !== undefined,
      () =>
        LocalAiOperationError.make({
          message:
            'No generation model is selected. Use `threadnote models install` and `threadnote models select generation`.',
        }),
    ),
  );
}

function installedGenerationModels(config: LocalAiRuntimeConfig) {
  return Effect.gen(function* () {
    const current = yield* readModelSelection(config.agentContextHome);
    const installed = yield* listInstalledLocalAiModels(config);
    return [...installed].sort(
      (left, right) =>
        Number(right.definition.id === current.roles.generation) -
          Number(left.definition.id === current.roles.generation) ||
        Effect2.pipe(left.definition.id, EffectString.localeCompare(right.definition.id)),
    );
  });
}

function settingsFor(selected: SelectedLocalModel): LocalAiSettings {
  return {
    enabled: true,
    host: 'in-process',
    model: selected.manifest.id,
    modelPath: selected.path,
    port: 0,
    version: 2,
  };
}
