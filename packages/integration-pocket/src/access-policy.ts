import {succeedUndefined} from '@threadnote/platform/optional';
import {Effect} from 'effect';
import type {ExternalSourcePolicyRegistration} from '@threadnote/integration-core/access-policy';
import {isPocketSource, sourceConfigurationFingerprint} from './config.js';
export const pocketExternalSourcePolicy: ExternalSourcePolicyRegistration = {
  provider: 'pocket',
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
