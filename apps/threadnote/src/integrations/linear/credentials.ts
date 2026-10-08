import {Effect} from 'effect';
import {
  resolveExternalCredential,
  storeExternalCredential,
  removeExternalCredential,
  externalCredentialConfigured,
  validExternalApiToken,
} from '../external-credentials.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {LinearSourceConfig} from './config.js';
export {validExternalApiToken as validLinearApiToken};
export const resolveLinearCredential = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  source: Pick<LinearSourceConfig, 'id' | 'credentialEnv' | 'credentialStorage'>,
) => resolveExternalCredential(config, source, 'linear');
export const linearCredentialConfigured = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  source: LinearSourceConfig,
) => externalCredentialConfigured(config, source, 'linear');
export const storeLinearCredential = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  id: string,
  token: Parameters<typeof storeExternalCredential>[2],
) => storeExternalCredential(config, id, token, 'linear');
export const removeLinearCredential = Effect.fn('linear.removeCredential')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  id: string,
) {
  yield* removeExternalCredential(config, id, 'linear');
});
