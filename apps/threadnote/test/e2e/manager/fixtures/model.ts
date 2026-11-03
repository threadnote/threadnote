import type {ManagerRuntime} from './runtime.js';
import {releaseRoutes} from './releases.js';

export const modelOrigin = 'https://manager-e2e-model.invalid';
export async function modelReply(manager: ManagerRuntime, text: string, gate?: string) {
  await manager.setNetwork([
    ...releaseRoutes(manager.expectedVersion),
    {
      origin: modelOrigin,
      path: '/v1/chat/completions',
      method: 'POST',
      ...(gate ? {gate} : {}),
      body: {
        id: 'chatcmpl_fixture',
        object: 'chat.completion',
        created: 0,
        model: 'synthetic-model',
        choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: text}}],
        usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
      },
    },
  ]);
}
export async function configureModel(manager: ManagerRuntime) {
  manager.environment.THREADNOTE_EFFECT_AI = '1';
  manager.environment.THREADNOTE_EFFECT_AI_MODEL = 'synthetic-model';
  manager.environment.THREADNOTE_EFFECT_AI_API_KEY = 'synthetic-manager-key';
  manager.environment.THREADNOTE_EFFECT_AI_API_URL = `${modelOrigin}/v1`;
  await modelReply(manager, '{invalid fixture JSON', 'model-response-ready');
}
