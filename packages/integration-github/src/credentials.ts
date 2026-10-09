import {Redacted} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {GitHubSourceConfig} from './config.js';
import {
  ExternalCredentialError,
  externalCredentialConfigured,
  removeExternalCredential,
  resolveExternalCredential,
  storeExternalCredential,
  validExternalApiToken,
} from '@threadnote/integration-core/external-credentials';

export {ExternalCredentialError as GitHubCredentialError};
export const validGitHubApiToken = (token: Redacted.Redacted<string>) =>
  validExternalApiToken(token) && !/\s|\p{Cc}/u.test(Redacted.value(token));
export const resolveGitHubCredential = (config: Pick<RuntimeConfig, 'agentContextHome'>, source: GitHubSourceConfig) =>
  resolveExternalCredential(config, source, 'github', validGitHubApiToken);
export const githubCredentialConfigured = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  source: GitHubSourceConfig,
) => externalCredentialConfigured(config, source, 'github', validGitHubApiToken);
export const storeGitHubCredential = (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  id: string,
  token: Redacted.Redacted<string>,
) => storeExternalCredential(config, id, token, 'github', validGitHubApiToken);
export const removeGitHubCredential = (config: Pick<RuntimeConfig, 'agentContextHome'>, id: string) =>
  removeExternalCredential(config, id, 'github');
