import {finalizeNativeInferenceOverlay} from './native-inference-payload.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Path} from 'effect';
import {provideScriptLayer, scriptError} from './effect/errors.js';
import {parseNativeVectorReaderManifest} from '@threadnote/recall/vector/native-reader-payload';
import {publishNativeReaderManifest} from './native-vector-reader-payload.js';

/** Codesigning changes Mach-O bytes. Rebind the final digest after signing and before archiving. */
export const finalizeNativeVectorReader = Effect.fn('finalizeNativeVectorReader')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, 'dist', 'runtime', 'vector-reader');
  const manifestPath = path.join(directory, 'manifest.json');
  if (!(yield* fs.exists(manifestPath))) return undefined;
  const manifest = yield* Effect.tryPromise({
    try: async () => parseNativeVectorReaderManifest(await Bun.file(manifestPath).json()),
    catch: scriptError,
  });
  return yield* Effect.tryPromise({
    try: () =>
      publishNativeReaderManifest(directory, {
        bunTarget: manifest.bunTarget,
        development: manifest.development,
        buildEnvironment: manifest.buildEnvironment,
        buildInfo: manifest.buildInfo,
      }),
    catch: scriptError,
  });
});

if (import.meta.main) {
  const main = Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('..', import.meta.url));
    yield* finalizeNativeVectorReader(root);
    yield* finalizeNativeInferenceOverlay(path.join(root, 'dist'));
  });
  BunRuntime.runMain(provideScriptLayer(main, BunServices.layer));
}
