import {succeedUndefined} from '@threadnote/platform/optional';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {ExternalSourcePolicy} from '@threadnote/store/external-resource';
import {SystemInfo} from '@threadnote/platform/system';
import {readSourceConfiguration, SourceConfigurationStore} from '@threadnote/integration-core/config';
import type {ExternalSourcePolicyRegistration} from '@threadnote/integration-core/access-policy';

export function externalSourcePolicyLayer(registrations: readonly ExternalSourcePolicyRegistration[]) {
  const policies = new Map(registrations.map(registration => [registration.provider, registration]));
  if (policies.size !== registrations.length) throw new Error('Duplicate external source policy registration.');
  return Layer.effect(
    ExternalSourcePolicy,
    Effect.gen(function* () {
      const services = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | SystemInfo | SourceConfigurationStore
      >();
      return ExternalSourcePolicy.of({
        current: (location, sourceId, provider = 'superhuman') =>
          readSourceConfiguration({agentContextHome: location.home}).pipe(
            Effect.flatMap(configuration => {
              const source = configuration.sources.find(
                candidate => candidate.id === sourceId && candidate.type === provider,
              );
              const policy = policies.get(provider);
              return source && policy ? policy.resolve(source, {agentContextHome: location.home}) : succeedUndefined;
            }),
            Effect.orElseSucceed(() => undefined),
            Effect.provide(services),
          ),
        evidenceFingerprint: (location, sourceId, provider) =>
          readSourceConfiguration({agentContextHome: location.home}).pipe(
            Effect.flatMap(configuration => {
              const source = configuration.sources.find(
                candidate => candidate.id === sourceId && candidate.type === provider && candidate.enabled,
              );
              const policy = policies.get(provider);
              return source && policy?.evidenceFingerprint
                ? policy.evidenceFingerprint(source, {agentContextHome: location.home})
                : succeedUndefined;
            }),
            Effect.orElseSucceed(() => undefined),
            Effect.provide(services),
          ),
      });
    }),
  );
}
