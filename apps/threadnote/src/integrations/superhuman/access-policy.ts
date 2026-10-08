import {Effect, FileSystem, Layer, Path} from 'effect';
import {ExternalSourcePolicy} from '@threadnote/store/external-resource';
import {readSourceConfiguration, sourceConfigurationFingerprint} from '../config.js';

export const superhumanExternalSourcePolicyLayer = Layer.effect(
  ExternalSourcePolicy,
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    return ExternalSourcePolicy.of({
      current: (location, sourceId, provider = 'superhuman') =>
        readSourceConfiguration({agentContextHome: location.home}).pipe(
          Effect.map(configuration => {
            const source = configuration.sources.find(
              candidate => candidate.id === sourceId && candidate.type === provider,
            );
            return source?.type === 'superhuman' || source?.type === 'pocket'
              ? {
                  enabled: source.enabled,
                  configFingerprint: sourceConfigurationFingerprint(source),
                  project: source.project,
                  maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
                }
              : undefined;
          }),
          Effect.orElseSucceed(() => undefined),
          Effect.provide(services),
        ),
    });
  }),
);
