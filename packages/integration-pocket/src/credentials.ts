import {Redacted} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {PocketSourceConfig} from './config.js';
import {
  ExternalCredentialError,
  externalCredentialConfigured,
  removeExternalCredential,
  resolveExternalCredential,
  storeExternalCredential,
  validExternalApiToken,
} from '@threadnote/integration-core/external-credentials';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export {ExternalCredentialError as PocketCredentialError};
export const validPocketApiToken = (token: Redacted.Redacted<string>) =>
  Effect.pipe(Redacted.value(token), EffectString.startsWith('pk_')) && validExternalApiToken(token);
export const resolvePocketCredential = (config: Pick<RuntimeConfig, 'agentContextHome'>, source: PocketSourceConfig) =>
  resolveExternalCredential(config, source, 'pocket', validPocketApiToken);
export const pocketCredentialConfigured = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  source: PocketSourceConfig,
) => externalCredentialConfigured(config, source, 'pocket', validPocketApiToken);
export const storePocketCredential = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  sourceId: string,
  token: Redacted.Redacted<string>,
) => storeExternalCredential(config, sourceId, token, 'pocket', validPocketApiToken);
export const removePocketCredential = (config: Pick<RuntimeConfig, 'agentContextHome'>, sourceId: string) =>
  removeExternalCredential(config, sourceId, 'pocket');
