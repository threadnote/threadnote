import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path} from 'effect';
import {provideScriptLayer, scriptError} from './effect/errors.js';
import {sameNativeVectorReaderBuildInfo} from '@threadnote/recall/vector/native-reader-payload';
import {readNativeReaderBuildInfo, verifyNativeVectorReaderPayload} from './native-vector-reader-payload.js';

export const verifyNativeVectorReader = Effect.fn('verifyNativeVectorReader')(function* (
  root: string,
  required = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(root, 'dist', 'runtime', 'vector-reader', 'manifest.json');
  if (!(yield* fs.exists(manifestPath))) {
    if (required) throw new Error('Required native vector reader payload is missing.');
    return undefined;
  }
  const manifest = yield* Effect.tryPromise({
    try: () => verifyNativeVectorReaderPayload(manifestPath),
    catch: scriptError,
  });
  const info = yield* Effect.tryPromise({
    try: () => readNativeReaderBuildInfo(path.join(path.dirname(manifestPath), manifest.binary)),
    catch: scriptError,
  });
  if (!sameNativeVectorReaderBuildInfo(info, manifest.buildInfo))
    throw new Error('Native vector reader binary build identity mismatch.');
  yield* Console.log(`Verified native vector reader ${manifest.buildInfo.target} (${manifest.binarySha256}).`);
  return manifest;
});

if (import.meta.main) {
  const main = Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* verifyNativeVectorReader(
      yield* path.fromFileUrl(new URL('..', import.meta.url)),
      Bun.argv.includes('--required'),
    );
  });
  BunRuntime.runMain(provideScriptLayer(main, BunServices.layer));
}
