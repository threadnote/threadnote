import {succeedUndefined} from '@threadnote/platform/optional';
import {Effect, Redacted} from 'effect';
import type {ExternalSourcePolicyRegistration} from '@threadnote/integration-core/access-policy';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isPocketSource, sourceConfigurationFingerprint} from './config.js';
import {resolvePocketCredential} from './credentials.js';
export const pocketExternalSourcePolicy: ExternalSourcePolicyRegistration = {
  provider: 'pocket',
  evidenceFingerprint: (source, config) =>
    isPocketSource(source) && source.enabled
      ? resolvePocketCredential(config, source).pipe(
          Effect.map(token => sha256HexSync(Redacted.value(token))),
          Effect.orElseSucceed(() => undefined),
        )
      : succeedUndefined,
  resolve: source => {
    if (!isPocketSource(source)) return succeedUndefined;
    return Effect.succeed({
      enabled: source.enabled,
      configFingerprint: sourceConfigurationFingerprint(source),
      project: source.project,
      maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
    });
  },
};
