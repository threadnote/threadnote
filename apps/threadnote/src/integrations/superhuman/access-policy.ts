import {Effect, FileSystem, Layer, Path, Redacted} from 'effect';
import {ExternalSourcePolicy} from '@threadnote/store/external-resource';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {resolveLinearCredential} from '../linear/credentials.js';
import {readSourceConfiguration, sourceConfigurationFingerprint} from '../config.js';

export const superhumanExternalSourcePolicyLayer = Layer.effect(
  ExternalSourcePolicy,
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | SystemInfo>();
    return ExternalSourcePolicy.of({
      current: (location, sourceId, provider = 'superhuman') =>
        readSourceConfiguration({agentContextHome: location.home}).pipe(
          Effect.flatMap(configuration => {
            const source = configuration.sources.find(
              candidate => candidate.id === sourceId && candidate.type === provider,
            );
            if (source?.type === 'linear')
              return resolveLinearCredential({agentContextHome: location.home}, source).pipe(
                Effect.map(token => ({
                  enabled: source.enabled,
                  credentialFingerprint: sha256HexSync(Redacted.value(token)),
                  configFingerprint: sourceConfigurationFingerprint(source),
                  project: source.project,
                  maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
                })),
                Effect.orElseSucceed(() => undefined),
              );
            return Effect.succeed(
              source?.type === 'superhuman' || source?.type === 'pocket'
                ? {
                    enabled: source.enabled,
                    configFingerprint: sourceConfigurationFingerprint(source),
                    project: source.project,
                    maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
                  }
                : undefined,
            );
          }),
          Effect.orElseSucceed(() => undefined),
          Effect.provide(services),
        ),
    });
  }),
);
