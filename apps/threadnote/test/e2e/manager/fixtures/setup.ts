import {Array as EffectArray, Option as EffectOption} from 'effect';
import {BUILTIN_MODEL_MANIFESTS, CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {modelDownloadUrl} from '@threadnote/inference/models/store';
import type {ManagerRuntime} from './runtime.js';
import {releaseRoutes} from './releases.js';

export async function configureSetup(manager: ManagerRuntime) {
  await manager.cli(['models', 'setup', '--auto', 'off']);
  delete manager.environment.THREADNOTE_MODEL_SETUP;
  const manifest = EffectOption.getOrUndefined(
    EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === CORE_GENERATION_MODEL_ID),
  );
  if (!manifest) throw new Error('The pinned setup model is missing.');
  const url = new URL(modelDownloadUrl(manifest));
  await manager.setNetwork([
    ...releaseRoutes(manager.expectedVersion),
    {
      origin: url.origin,
      path: url.pathname,
      status: 403,
      body: {error: 'Synthetic model access refusal'},
      gate: 'model-download-ready',
    },
  ]);
}
