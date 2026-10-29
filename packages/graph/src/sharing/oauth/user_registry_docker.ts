import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {readBoundedPrivateBytes, writePrivateJsonFile} from '../atomic.js';
import {graphSharingFailure} from '../errors.js';

const HELPER = 'threadnote-oauth-user';
const LEGACY_HELPER = 'threadnote-auth0-user';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

export function withOAuthRegistryReaderHelper(
  config: unknown,
  host: string,
  helper: typeof HELPER | typeof LEGACY_HELPER = HELPER,
): Record<string, unknown> {
  if (!isRecord(config) || (config.credHelpers !== undefined && !isRecord(config.credHelpers)))
    throw new Error('Docker credential config is invalid.');
  const helpers = config.credHelpers ?? {};
  if (!isRecord(helpers)) throw new Error('Docker credential config is invalid.');
  const existing = helpers[host];
  if (existing !== undefined && existing !== HELPER && existing !== LEGACY_HELPER)
    throw new Error('Docker registry already uses another credential helper.');
  return {...config, credHelpers: {...helpers, [host]: helper}};
}

export const configureOAuthRegistryReaderDockerHelper = Effect.fn(
  'codeGraph.sharing.configureOAuthRegistryReaderDockerHelper',
)(function* (origin: string, helper: typeof HELPER | typeof LEGACY_HELPER = HELPER) {
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
    path.join(directory, '.threadnote-oauth-reader.lock'),
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
        try: () => withOAuthRegistryReaderHelper(existing, host, helper),
        catch: () => graphSharingFailure('Docker credential config cannot bind the registry reader.'),
      });
      yield* writePrivateJsonFile(target, updated);
    }),
  );
});
