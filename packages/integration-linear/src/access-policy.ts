import {succeedUndefined} from '@threadnote/platform/optional';
import {Effect, Redacted} from 'effect';
import type {ExternalSourcePolicyRegistration} from '@threadnote/integration-core/access-policy';
import {isLinearSource, sourceConfigurationFingerprint} from './config.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {resolveLinearCredential} from './credentials.js';
export const linearExternalSourcePolicy: ExternalSourcePolicyRegistration = {
  provider: 'linear',
  resolve: (source, config) => {
    if (!isLinearSource(source)) return succeedUndefined;
    return resolveLinearCredential(config, source).pipe(
      Effect.map(token => ({
        enabled: source.enabled,
        configFingerprint: sourceConfigurationFingerprint(source),
        project: source.project,
        maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
        credentialFingerprint: sha256HexSync(Redacted.value(token)),
      })),
      Effect.orElseSucceed(() => undefined),
    );
  },
};
