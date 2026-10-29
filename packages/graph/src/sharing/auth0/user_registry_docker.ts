import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {readBoundedPrivateBytes, writePrivateJsonFile} from '../atomic.js';
import {graphSharingFailure} from '../errors.js';

const HELPER = 'threadnote-auth0-user';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

export function withRegistryReaderHelper(config: unknown, host: string): Record<string, unknown> {
  if (!isRecord(config) || (config.credHelpers !== undefined && !isRecord(config.credHelpers)))
    throw new Error('Docker credential config is invalid.');
  const helpers = config.credHelpers ?? {};
  if (!isRecord(helpers)) throw new Error('Docker credential config is invalid.');
  const existing = helpers[host];
  if (existing !== undefined && existing !== HELPER)
    throw new Error('Docker registry already uses another credential helper.');
  return {...config, credHelpers: {...helpers, [host]: HELPER}};
}

export const configureRegistryReaderDockerHelper = Effect.fn('codeGraph.sharing.configureRegistryReaderDockerHelper')(
  function* (origin: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const directory = system.environment().DOCKER_CONFIG ?? path.join(system.homeDirectory, '.docker');
    if (!path.isAbsolute(directory)) return yield* graphSharingFailure('Docker credential config must be absolute.');
    yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    const target = path.join(directory, 'config.json');
    const host = new URL(origin).host;
    yield* withExclusiveFileLock(
      fs,
      path.join(directory, '.threadnote-auth0-reader.lock'),
      {
        heartbeatIntervalMilliseconds: 10_000,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 60_000,
        waitTimeoutMilliseconds: 3_000,
      },
      Effect.gen(function* () {
        const bytes = (yield* fs.exists(target)) ? yield* readBoundedPrivateBytes(target, 65_536) : undefined;
        const existing =
          bytes !== undefined
            ? yield* Effect.try({
                try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown,
                catch: () => graphSharingFailure('Docker credential config is invalid.'),
              })
            : {};
        const updated = yield* Effect.try({
          try: () => withRegistryReaderHelper(existing, host),
          catch: () => graphSharingFailure('Docker credential config cannot bind the registry reader.'),
        });
        yield* writePrivateJsonFile(target, updated);
      }),
    );
  },
);
