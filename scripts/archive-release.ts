import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256FileHex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';

const ROOT_URL = new URL('..', import.meta.url);
const ARCHIVE_TARGET_PATTERN = /^(darwin|linux|windows)-(arm64|x64)$/;

export interface ArchiveReleaseOptions {
  readonly root: string;
  readonly target: string;
  readonly artifactsRoot?: string;
}

export const archiveRelease = Effect.fn('archiveRelease')(function* (options: ArchiveReleaseOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(options.root);
  const target = options.target;
  if (!target || !ARCHIVE_TARGET_PATTERN.test(target)) {
    return yield* ScriptError.make({
      message: 'THREADNOTE_RELEASE_TARGET must be one of darwin|linux|windows combined with arm64|x64.',
    });
  }

  const distributionRoot = path.join(root, 'dist');
  const artifactsRoot = options.artifactsRoot ? path.resolve(options.artifactsRoot) : path.join(root, 'artifacts');
  const artifactName = `threadnote-${target}.tar.gz`;
  const artifactPath = path.join(artifactsRoot, artifactName);
  const checksumPath = `${artifactPath}.sha256`;
  if (!(yield* fs.exists(path.join(distributionRoot, 'release.json')))) {
    return yield* ScriptError.make({message: 'dist/release.json is missing; build the release before archiving it.'});
  }

  yield* fs.makeDirectory(artifactsRoot, {recursive: true});
  yield* fs.remove(artifactPath, {force: true});
  yield* fs.remove(checksumPath, {force: true});
  const environment = (yield* SystemInfo).environment();
  yield* runCommandEffect('tar', ['-czf', artifactPath, '-C', distributionRoot, '.'], {
    env: {...environment, COPYFILE_DISABLE: '1'},
    timeoutMs: 10 * 60_000,
  });
  const checksum = yield* sha256FileHex(artifactPath);
  yield* fs.writeFileString(checksumPath, `${checksum}  ${artifactName}\n`, {mode: 0o644});
  yield* Console.log(`Archived ${artifactName}`);
  return {artifactPath, checksumPath, checksum};
});

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const archiveLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

if (import.meta.main) {
  const main = Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(ROOT_URL);
    return yield* archiveRelease({
      root,
      target: Bun.env.THREADNOTE_RELEASE_TARGET?.trim() ?? '',
      artifactsRoot: Bun.env.THREADNOTE_ARTIFACTS_ROOT?.trim() || undefined,
    });
  });
  BunRuntime.runMain(provideScriptLayer(main, archiveLayer));
}
