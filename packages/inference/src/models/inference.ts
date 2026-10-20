import {Effect, FileSystem} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {LocalModelRuntime, type LocalGenerationRequest} from '../engine/local-model-runtime.js';
import type {StructuredGenerationRequest} from '../engine/structured-generator.js';
import {LocalModelCatalog, type LocalModelManifest, type LocalModelRole} from './catalog.js';
import {inspectModelSelection, readModelSelection} from './selection.js';
import {CORE_GENERATION_MODEL_ID} from './builtin.js';
import {modelSetupFileIdentity, modelSetupJob, readModelSetup, sameModelSetupFile, sameModelSetupJob} from './setup.js';
import {LocalModelStore} from './store.js';

export interface SelectedLocalModel {
  readonly manifest: LocalModelManifest;
  readonly path: string;
}

export interface LocalModelResolutionOptions {
  /** Explicit request identity wins even when that model is unavailable. */
  readonly modelId?: string;
  /** Provider dispatch stays explicit. Remote providers cannot acquire a local fallback. */
  readonly provider?: string;
  /** Environment/runtime policy may suspend the automatic default without changing durable intent. */
  readonly automaticSetup?: boolean;
}

export const resolveSelectedLocalModel = Effect.fn('models.resolveSelected')(function* (
  home: string,
  role: LocalModelRole,
  options: LocalModelResolutionOptions = {},
) {
  if (options.provider !== undefined && options.provider !== 'local-ai') return undefined;
  const inspected = role === 'generation' ? yield* inspectModelSelection(home) : undefined;
  const selection =
    inspected === undefined
      ? yield* readModelSelection(home)
      : inspected.status === 'valid'
        ? inspected.selection
        : undefined;
  const modelId = options.modelId ?? selection?.roles[role];
  if (modelId !== undefined) {
    const catalog = yield* LocalModelCatalog;
    const manifest = yield* catalog.get(modelId);
    if (manifest.role !== role) return undefined;
    const store = yield* LocalModelStore;
    const status = yield* store.status(home, manifest);
    return status.installed ? ({manifest, path: status.path} satisfies SelectedLocalModel) : undefined;
  }
  if (role !== 'generation' || inspected?.status === 'malformed' || options.automaticSetup === false) return undefined;
  const system = yield* SystemInfo;
  if (system.environment().THREADNOTE_MODEL_SETUP === 'off') return undefined;
  const setup = yield* readModelSetup(home);
  if (
    setup.status !== 'valid' ||
    setup.state.policy !== 'automatic' ||
    setup.state.phase !== 'ready' ||
    !setup.state.receipt
  )
    return undefined;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(CORE_GENERATION_MODEL_ID);
  if (manifest.role !== 'generation') return undefined;
  const fs = yield* FileSystem.FileSystem;
  const canonicalHome = yield* fs.realPath(home);
  if (
    !sameModelSetupJob(setup.state.job, modelSetupJob(canonicalHome, manifest)) ||
    setup.state.receipt.sha256 !== manifest.sha256 ||
    setup.state.receipt.fileIdentity.size !== String(manifest.size)
  )
    return undefined;
  const store = yield* LocalModelStore;
  const status = yield* store.status(home, manifest);
  if (!status.installed) return undefined;
  const identity = yield* modelSetupFileIdentity(status.path).pipe(Effect.orElseSucceed(() => undefined));
  return identity && sameModelSetupFile(identity, setup.state.receipt.fileIdentity)
    ? ({manifest, path: status.path} satisfies SelectedLocalModel)
    : undefined;
});

export const generateWithSelectedLocalModel = Effect.fn('models.generateSelected')(function* (
  home: string,
  request: StructuredGenerationRequest,
  options: LocalModelResolutionOptions = {},
) {
  const selected = yield* resolveSelectedLocalModel(home, 'generation', options);
  if (!selected) return undefined;
  const runtime = yield* LocalModelRuntime;
  return yield* runtime.generate({
    ...request,
    manifest: selected.manifest,
    modelPath: selected.path,
  } satisfies LocalGenerationRequest);
});

export const rerankWithSelectedLocalModel = Effect.fn('models.rerankSelected')(function* (
  home: string,
  query: string,
  documents: readonly string[],
) {
  const selected = yield* resolveSelectedLocalModel(home, 'reranker');
  if (!selected) return undefined;
  const runtime = yield* LocalModelRuntime;
  return yield* runtime.rerank({
    documents,
    manifest: selected.manifest,
    modelPath: selected.path,
    query,
  });
});
