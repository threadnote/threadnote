import {verifyNativeInferenceOverlay} from './native-inference-payload.js';
import {releaseTargetForBunTarget} from './release-targets.js';
import {verifyNativeVectorReaderPayload} from '@threadnote/recall/vector/native-reader-payload';
import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256FileHex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ROOT_URL = new URL('..', import.meta.url);
const ARCHIVE_TARGET_PATTERN = /^(?:(darwin|windows)-(arm64|x64)|linux-(arm64|x64)(?:-musl)?)$/;
const GitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const ReleaseSourceIdentity = Schema.Struct({
  version: Schema.Literal(1),
  commit: GitObject,
  tree: GitObject,
  bun: Schema.String.check(Schema.isMinLength(1)),
  target: Schema.String,
});

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

  const release: unknown = JSON.parse(yield* fs.readFileString(path.join(distributionRoot, 'release.json')));
  if (
    typeof release !== 'object' ||
    release === null ||
    !('target' in release) ||
    typeof release.target !== 'string' ||
    releaseTargetForBunTarget(release.target) !== target
  )
    return yield* ScriptError.make({
      message: 'Release metadata target differs from the requested archive target/libc.',
    });
  if (
    !('sourceIdentity' in release) ||
    !Schema.is(ReleaseSourceIdentity)(release.sourceIdentity) ||
    release.sourceIdentity.target !== release.target
  )
    return yield* ScriptError.make({
      message: 'Release source identity is missing, invalid or differs from its target.',
    });
  const identity = release.sourceIdentity;
  const vectorManifest = path.join(distributionRoot, 'runtime', 'vector-reader', 'manifest.json');
  const vector = yield* Effect.tryPromise({
    try: () => verifyNativeVectorReaderPayload(vectorManifest),
    catch: cause => ScriptError.make({message: 'Native vector reader payload is invalid before archive.', cause}),
  });
  if (vector.development || vector.bunTarget !== release.target)
    return yield* ScriptError.make({message: 'Native vector reader target/source mode differs from this release.'});
  if (vector.buildInfo.sourceCommit !== identity.commit || vector.buildInfo.sourceTree !== identity.tree)
    return yield* ScriptError.make({message: 'Native vector reader source identity differs from this release.'});
  const inference = yield* verifyNativeInferenceOverlay(distributionRoot).pipe(
    Effect.mapError(cause => ScriptError.make({message: 'Native inference payload is invalid before archive.', cause})),
  );

  if (inference.bunTarget !== release.target)
    return yield* ScriptError.make({message: 'Native inference target/libc differs from this release.'});

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
      target:
        Effect2.pipe(Bun.env.THREADNOTE_RELEASE_TARGET, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) ?? '',
      artifactsRoot:
        Effect2.pipe(Bun.env.THREADNOTE_ARTIFACTS_ROOT, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) || undefined,
    });
  });
  BunRuntime.runMain(provideScriptLayer(main, archiveLayer));
}
