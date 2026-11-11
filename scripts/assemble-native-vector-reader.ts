import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {ScriptCommandExecutorLayer, ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, scriptError} from './effect/errors.js';
import {nativeReaderBuildInputs, publishNativeReaderManifest} from './native-vector-reader-payload.js';
import {nativeVectorReaderTarget} from '@threadnote/recall/vector/native-reader-payload';

export const assembleNativeVectorReader = Effect.fn('assembleNativeVectorReader')(function* (options: {
  readonly root: string;
  readonly bunTarget: string;
  readonly development?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    options.root,
    options.development ? '.context' : 'dist',
    ...(options.development ? ['native-vector-reader'] : ['runtime', 'vector-reader']),
  );
  // Never reuse an ignored addon or a descriptor from a previous build.
  yield* fs.remove(directory, {recursive: true, force: true});
  const target = nativeVectorReaderTarget(options.bunTarget);
  if (!target) return undefined;
  const host = `${process.arch}-${process.platform}`;
  if (
    (target === 'aarch64-apple-darwin' && host !== 'arm64-darwin') ||
    (target === 'x86_64-unknown-linux-gnu' && host !== 'x64-linux')
  ) {
    throw new Error(`Native vector reader ${target} must be built on its target host.`);
  }
  const before = yield* Effect.tryPromise({
    try: () => nativeReaderBuildInputs(options.root, options.bunTarget, options.development === true),
    catch: scriptError,
  });
  if (!before) return undefined;
  const crateRoot = path.join(options.root, 'packages', 'recall', 'native-vector-reader');
  const cargo = Bun.env.THREADNOTE_NATIVE_CARGO || 'cargo';
  const cargoVersion = yield* Effect.sync(() =>
    Bun.spawnSync({cmd: [cargo, '--version'], cwd: crateRoot, stdout: 'pipe', stderr: 'pipe'}),
  );
  if (cargoVersion.exitCode !== 0 || !/^cargo 1\.89\.0 /u.test(cargoVersion.stdout.toString()))
    throw new Error('Native vector reader requires pinned Cargo/Rust 1.89.0.');
  if (Bun.env.RUSTFLAGS || Bun.env.CARGO_ENCODED_RUSTFLAGS)
    throw new Error('Native vector reader builds reject ambient Rust flags.');
  const targetDirectory = path.join(options.root, '.context', 'native-vector-reader-cargo');
  yield* runCommandEffect(
    cargo,
    ['build', '--locked', '--release', '--target', target, '--target-dir', targetDirectory],
    {
      cwd: crateRoot,
      env: {
        ...Bun.env,
        // Override user Cargo configuration too: assets use portable default target features.
        CARGO_ENCODED_RUSTFLAGS: '',
        RUSTFLAGS: '',
        THREADNOTE_NATIVE_SOURCE_COMMIT: before.sourceCommit,
        THREADNOTE_NATIVE_SOURCE_TREE: before.sourceTree,
        THREADNOTE_NATIVE_LOCK_SHA256: before.lockSha256,
        THREADNOTE_NATIVE_TOOLCHAIN_SHA256: before.toolchainSha256,
        THREADNOTE_NATIVE_SOURCE_SHA256: before.sourceSha256,
      },
      timeoutMs: 20 * 60_000,
      maxOutputBytes: 4 * 1024 * 1024,
      detached: true,
      verifyOwnedProcessExit: 'group',
    },
  );
  const after = yield* Effect.tryPromise({
    try: () => nativeReaderBuildInputs(options.root, options.bunTarget, options.development === true),
    catch: scriptError,
  });
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Native vector reader source changed during Cargo build; discard this output.');
  yield* fs.makeDirectory(directory, {recursive: true});
  const library =
    target === 'aarch64-apple-darwin'
      ? 'libthreadnote_native_vector_reader.dylib'
      : 'libthreadnote_native_vector_reader.so';
  const binaryPath = path.join(directory, 'threadnote-vector-reader.node');
  yield* fs.copyFile(path.join(targetDirectory, target, 'release', library), binaryPath);
  const {readNativeReaderBuildInfo} = yield* Effect.promise(() => import('./native-vector-reader-payload.js'));
  const buildInfo = yield* Effect.tryPromise({try: () => readNativeReaderBuildInfo(binaryPath), catch: scriptError});
  for (const key of [
    'sourceCommit',
    'sourceTree',
    'sourceSha256',
    'lockSha256',
    'toolchainSha256',
    'target',
  ] as const) {
    if (buildInfo[key] !== before[key]) throw new Error(`Native vector reader buildInfo mismatch: ${key}.`);
  }
  return yield* Effect.tryPromise({
    try: () =>
      publishNativeReaderManifest(directory, {
        bunTarget: options.bunTarget,
        development: options.development === true,
        ...(options.development ? {sourceRoot: options.root} : {}),
        buildInfo,
      }),
    catch: scriptError,
  });
});

if (import.meta.main) {
  const main = Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* assembleNativeVectorReader({
      root: yield* path.fromFileUrl(new URL('..', import.meta.url)),
      bunTarget:
        Bun.env.THREADNOTE_BUILD_TARGET ||
        `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`,
      development: Bun.argv.includes('--development'),
    });
  });
  BunRuntime.runMain(
    provideScriptLayer(
      main,
      Layer.merge(ScriptSystemInfoLayer, ScriptCommandExecutorLayer.pipe(Layer.provide(ScriptSystemInfoLayer))).pipe(
        Layer.provideMerge(BunServices.layer),
      ),
    ),
  );
}
