import {Redacted} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {SuperhumanSourceConfig} from '../config.js';
import {
  ExternalCredentialError,
  externalCredentialConfigured,
  removeExternalCredential,
  resolveExternalCredential,
  storeExternalCredential,
  validExternalApiToken,
} from '../external-credentials.js';

export {ExternalCredentialError as SuperhumanCredentialError};
export const validSuperhumanApiToken = validExternalApiToken;
export const resolveSuperhumanCredential = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  source: SuperhumanSourceConfig,
) => resolveExternalCredential(config, source, 'superhuman');
export const superhumanCredentialConfigured = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  source: SuperhumanSourceConfig,
) => externalCredentialConfigured(config, source, 'superhuman');
export const storeSuperhumanCredential = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  sourceId: string,
  token: Redacted.Redacted<string>,
) => storeExternalCredential(config, sourceId, token, 'superhuman');
export const removeSuperhumanCredential = (config: Pick<RuntimeConfig, 'agentContextHome'>, sourceId: string) =>
  removeExternalCredential(config, sourceId, 'superhuman');
