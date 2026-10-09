import {succeedUndefined} from '@threadnote/platform/optional';
import {Effect} from 'effect';
import type {ExternalSourcePolicyRegistration} from '@threadnote/integration-core/access-policy';
import {isSuperhumanSource, sourceConfigurationFingerprint} from './config.js';
export const superhumanExternalSourcePolicy: ExternalSourcePolicyRegistration = {
  provider: 'superhuman',
  resolve: source => {
    if (!isSuperhumanSource(source)) return succeedUndefined;
    return Effect.succeed({
      enabled: source.enabled,
      configFingerprint: sourceConfigurationFingerprint(source),
      project: source.project,
      maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
    });
  },
};
