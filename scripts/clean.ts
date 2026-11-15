import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Path} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {assertNativeTypeScriptAssetOutsideReleaseOutput} from '../tools/semantic/build-typescript-native.js';

const clean = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, '..');
  yield* Effect.tryPromise({
    try: () => assertNativeTypeScriptAssetOutsideReleaseOutput(Bun.env.THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR, root),
    catch: cause => ScriptError.make({message: 'Native TypeScript release input preflight failed.', cause}),
  });
  if (process.argv.includes('--preflight-native-asset')) return;
  yield* fs.remove(path.join(root, 'dist'), {force: true, recursive: true});
});

BunRuntime.runMain(provideScriptLayer(clean, BunServices.layer));
