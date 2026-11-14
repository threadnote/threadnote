import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path, Console, Array as EffectArray, String as EffectString} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {ScriptCommandExecutorLayer, ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, scriptError} from './effect/errors.js';
import {
  nativeReaderBuildInputs,
  publishNativeReaderManifest,
  auditNativeReaderBinary,
} from './native-vector-reader-payload.js';
import {
  nativeVectorReaderTarget,
  nativeVectorReaderHostProfile,
  nativeVectorReaderBuildEnvironmentSha256,
} from '@threadnote/recall/vector/native-reader-payload';

export const buildNativeVectorReaderCargo = Effect.fn('buildNativeVectorReaderCargo')(function* (options: {
  readonly cargo: string;
  readonly crateRoot: string;
  readonly target: string;
  readonly targetDirectory: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const system = yield* SystemInfo;
  return yield* runCommandEffect(
    options.cargo,
    ['build', '--locked', '--release', '--target', options.target, '--target-dir', options.targetDirectory],
    {
      cwd: options.crateRoot,
      env: options.env,
      timeoutMs: 20 * 60_000,
      maxOutputBytes: 4 * 1024 * 1024,
      detached: true,
      // Retain scoped Windows tree cleanup and leader confirmation; POSIX also verifies its owned group.
      verifyOwnedProcessExit: system.platform === 'win32' ? 'leader' : 'group',
    },
  );
});

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
  if (!target) throw new Error(`No required native vector target is mapped for ${options.bunTarget}.`);
  if (nativeVectorReaderHostProfile({platform: process.platform, architecture: process.arch}) !== options.bunTarget) {
    throw new Error(`Native vector reader ${target} must be built on its exact target OS, architecture and libc.`);
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
  if (Bun.env.CFLAGS || Bun.env.CXXFLAGS || Bun.env.CPPFLAGS || Bun.env.LDFLAGS)
    throw new Error('Native vector reader builds reject ambient C/linker flags.');
  const encodedRustFlags = EffectArray.join(
    [
      '--cfg',
      'sha2_backend="soft"',
      ...(EffectString.endsWith('-musl')(target)
        ? ['-C', 'target-feature=-crt-static']
        : EffectString.endsWith('-windows-msvc')(target)
          ? ['-C', 'target-feature=+crt-static']
          : []),
    ],
    '\x1f',
  );
  const compiler = Bun.env.CC || (process.platform === 'win32' ? 'cl' : 'cc');
  const compilerPath = Bun.which(compiler);
  if (!compilerPath) throw new Error('Initialize the native target C compiler before assembly.');
  const compilerBytes = new Uint8Array(yield* Effect.promise(() => Bun.file(compilerPath).arrayBuffer()));
  const compilerSha256 = sha256HexSync(compilerBytes);
  const compilerVersion = Bun.spawnSync({
    cmd: [compiler, ...(process.platform === 'win32' ? ['/Bv'] : ['--version'])],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const compilerOutput = `${compilerVersion.stdout}${compilerVersion.stderr}`;
  if (!compilerOutput || (process.platform !== 'win32' && compilerVersion.exitCode !== 0))
    throw new Error('Could not identify native C compiler; initialize the target toolchain explicitly.');
  const buildEnvironment = {
    cargoVersion: EffectString.trim(cargoVersion.stdout.toString()),
    cCompiler: compilerPath,
    cCompilerSha256: compilerSha256,
    cCompilerVersion: compilerOutput,
    rustVersion: '1.89.0',
    encodedRustFlags,
    buildImage: Bun.env.THREADNOTE_NATIVE_BUILD_IMAGE ?? 'native-host',
    sysrootIdentity: Bun.env.THREADNOTE_NATIVE_SYSROOT_IDENTITY ?? 'native-host',
    deploymentTarget: EffectString.endsWith('-apple-darwin')(target) ? '13.0' : '',
  };
  const buildEnvironmentSha256 = nativeVectorReaderBuildEnvironmentSha256(buildEnvironment);
  const targetDirectory = path.join(options.root, '.context', 'native-vector-reader-cargo');
  yield* buildNativeVectorReaderCargo({
    cargo,
    crateRoot,
    target,
    targetDirectory,
    env: {
      ...Bun.env,
      CC: compilerPath,
      // Override user Cargo configuration too: assets use portable default target features.
      CARGO_ENCODED_RUSTFLAGS: encodedRustFlags,
      THREADNOTE_NATIVE_BUILD_ENVIRONMENT_SHA256: buildEnvironmentSha256,
      MACOSX_DEPLOYMENT_TARGET: '13.0',
      THREADNOTE_NATIVE_DEPLOYMENT_TARGET: EffectString.endsWith('-apple-darwin')(target) ? '13.0' : '',
      RUSTFLAGS: '',
      THREADNOTE_NATIVE_SOURCE_COMMIT: before.sourceCommit,
      THREADNOTE_NATIVE_SOURCE_TREE: before.sourceTree,
      THREADNOTE_NATIVE_LOCK_SHA256: before.lockSha256,
      THREADNOTE_NATIVE_TOOLCHAIN_SHA256: before.toolchainSha256,
      THREADNOTE_NATIVE_SOURCE_SHA256: before.sourceSha256,
    },
  });
  if (
    sha256HexSync(new Uint8Array(yield* Effect.promise(() => Bun.file(compilerPath).arrayBuffer()))) !== compilerSha256
  )
    throw new Error('C compiler changed during native assembly.');
  const after = yield* Effect.tryPromise({
    try: () => nativeReaderBuildInputs(options.root, options.bunTarget, options.development === true),
    catch: scriptError,
  });
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Native vector reader source changed during Cargo build; discard this output.');
  yield* fs.makeDirectory(directory, {recursive: true});
  const library = EffectString.endsWith('-apple-darwin')(target)
    ? 'libthreadnote_native_vector_reader.dylib'
    : EffectString.endsWith('-windows-msvc')(target)
      ? 'threadnote_native_vector_reader.dll'
      : 'libthreadnote_native_vector_reader.so';
  const binaryPath = path.join(directory, 'threadnote-vector-reader.node');
  yield* fs.copyFile(path.join(targetDirectory, target, 'release', library), binaryPath);
  yield* fs.copyFile(path.join(crateRoot, 'NOTICE'), path.join(directory, 'NOTICE'));
  yield* auditNativeReaderBinary(binaryPath, options.bunTarget);
  const {readNativeReaderBuildInfo} = yield* Effect.promise(() => import('./native-vector-reader-payload.js'));
  const buildInfo = yield* Effect.tryPromise({try: () => readNativeReaderBuildInfo(binaryPath), catch: scriptError});
  if (buildInfo.buildEnvironmentSha256 !== buildEnvironmentSha256)
    throw new Error('Native vector reader build environment digest differs from actual build tools.');
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
        buildEnvironment,
      }),
    catch: scriptError,
  });
});

if (import.meta.main) {
  const main = Effect.gen(function* () {
    const path = yield* Path.Path;
    const result = yield* assembleNativeVectorReader({
      root: yield* path.fromFileUrl(new URL('..', import.meta.url)),
      bunTarget:
        Bun.env.THREADNOTE_BUILD_TARGET ||
        nativeVectorReaderHostProfile({platform: process.platform, architecture: process.arch}),
      development: Bun.argv.includes('--development'),
    });
    if (result?.development)
      yield* Console.log(
        `Source native reader ready. Set THREADNOTE_NATIVE_VECTOR_READER_MANIFEST=${path.join(result.sourceRoot ?? '', '.context', 'native-vector-reader', 'manifest.json')}`,
      );
    return result;
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
