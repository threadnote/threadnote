import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {releaseMetadataText, stageTypeScriptNativeAsset} from './build.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';

const ROOT_URL = new URL('..', import.meta.url);
const PendingRelease = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Completes native TypeScript staging that a glibc 2.17 GNU build container deferred: stages the verified payload named
 * by THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR into dist/runtime/typescript through the release build's own staging, then
 * rewrites dist/release.json byte-identically to a build that staged it. Runs on the host as the payload's owner.
 */
const stage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(ROOT_URL);
  const outputRoot = path.join(root, 'dist');
  const releasePath = path.join(outputRoot, 'release.json');
  const release = yield* Schema.decodeEffect(Schema.fromJsonString(PendingRelease))(
    yield* fs.readFileString(releasePath),
  ).pipe(Effect.mapError(cause => ScriptError.make({message: 'dist/release.json is not a release manifest.', cause})));
  if (release.typescriptNativeAssetPending !== true || release.typescriptNativeAsset !== undefined)
    return yield* ScriptError.make({message: 'dist/release.json has no pending native TypeScript staging.'});
  if (!Bun.env.THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR)
    return yield* ScriptError.make({message: 'Set THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR to the verified payload.'});
  const typescriptNativeAsset = yield* stageTypeScriptNativeAsset(fs, path, root, outputRoot);
  if (typescriptNativeAsset === undefined)
    return yield* ScriptError.make({message: 'The native TypeScript payload was not staged.'});
  const {typescriptNativeAssetPending: _pending, ...staged} = release;
  yield* fs.writeFileString(releasePath, releaseMetadataText({...staged, typescriptNativeAsset}));
  yield* Console.log(`Staged native TypeScript ${typescriptNativeAsset.version} into dist/runtime/typescript.`);
});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(stage, BunServices.layer));
