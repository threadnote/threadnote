import {FileSystem} from 'effect';
import {Effect, Layer, String as EffectString, Array as EffectArray} from 'effect';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {runCommandEffect} from '@threadnote/platform/command';
import {platformPathFor} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ScriptCommandExecutorLayer, ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer} from './effect/errors.js';
import {auditNativeReaderBinary, nativeReaderGit} from './native-vector-reader-payload.js';
import {
  NATIVE_INFERENCE_BUNDLE_SHA256,
  NATIVE_INFERENCE_LLAMA_COMMIT,
  NATIVE_INFERENCE_PACKAGE_VERSION,
  nativeInferenceHostTarget,
  nativeInferenceInventory,
  publishNativeInferenceOverlay,
  stageNativeInferenceOverlay,
} from './native-inference-payload.js';

const path = platformPathFor(process.platform);
const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));
const PORTABLE_OPTIONS = {
  CMAKE_EXPORT_COMPILE_COMMANDS: 'ON',
  GGML_NATIVE: 'OFF',
  GGML_AVX: 'OFF',
  GGML_AVX2: 'OFF',
  GGML_AVX512: 'OFF',
  GGML_AVX512_VBMI: 'OFF',
  GGML_AVX512_VNNI: 'OFF',
  GGML_FMA: 'OFF',
  GGML_F16C: 'OFF',
  GGML_CPU_ALL_VARIANTS: 'ON',
  GGML_BACKEND_DL: 'ON',
  GGML_OPENMP: 'OFF',
  GGML_CUDA: 'OFF',
  GGML_VULKAN: 'OFF',
  GGML_METAL: 'OFF',
  GGML_BLAS: 'OFF',
  LLAMA_CURL: 'OFF',
  LLAMA_HTTPLIB: 'OFF',
  LLAMA_BUILD_TESTS: 'OFF',
  LLAMA_BUILD_EXAMPLES: 'OFF',
  LLAMA_BUILD_SERVER: 'OFF',
};

async function sourceInputs(root: string) {
  const packageRoot = path.join(root, 'node_modules', 'node-llama-cpp');
  const inputs: [string, string][] = [];
  for (const relative of [
    'bun.lock',
    'node_modules/node-llama-cpp/package.json',
    'node_modules/node-llama-cpp/llama/gitRelease.bundle',
    'node_modules/node-llama-cpp/llama/CMakeLists.txt',
    'node_modules/node-addon-api/napi.h',
    'node_modules/node-api-headers/include/node_api.h',
    'scripts/assemble-native-inference.ts',
    'scripts/native-inference-payload.ts',
  ]) {
    const bytes = new Uint8Array(await Bun.file(path.join(root, relative)).arrayBuffer());
    const hash = sha256HexSync(bytes);
    if (EffectString.endsWith('gitRelease.bundle')(relative) && hash !== NATIVE_INFERENCE_BUNDLE_SHA256)
      throw new Error('Pinned llama.cpp source bundle differs from node-llama-cpp 3.22.2.');
    inputs.push([relative, hash]);
  }
  // Bind all wrapper/addon/header/patch/profile files, including future package changes.
  for (const directory of [
    'llama/addon',
    'llama/cmake',
    'llama/profiles',
    'llama/toolchains',
    'llama/patches',
    'dist/bindings',
  ]) {
    const names = await Array.fromAsync(
      new Bun.Glob('**/*').scan({cwd: path.join(packageRoot, directory), onlyFiles: true}),
    );
    for (const name of names.sort()) {
      const relative = `${directory}/${name}`;
      inputs.push([
        relative,
        sha256HexSync(new Uint8Array(await Bun.file(path.join(packageRoot, relative)).arrayBuffer())),
      ]);
    }
  }
  for (const directory of ['node-addon-api', 'node-api-headers/include']) {
    const names = await Array.fromAsync(
      new Bun.Glob('**/*.{h,hpp,gyp,gypi,json}').scan({
        cwd: path.join(root, 'node_modules', directory),
        onlyFiles: true,
      }),
    );
    for (const name of names.sort())
      inputs.push([
        `${directory}/${name}`,
        sha256HexSync(new Uint8Array(await Bun.file(path.join(root, 'node_modules', directory, name)).arrayBuffer())),
      ]);
  }
  return {packageRoot, sourceInputDigest: sha256HexSync(JSON.stringify({inputs, portableOptions: PORTABLE_OPTIONS}))};
}

/** CI/build-time only. Runtime always uses build:never and skipDownload:true. */
export const assembleNativeInference = Effect.fn('assembleNativeInference')(function* (options: {
  readonly root: string;
  readonly distributionRoot: string;
  readonly bunTarget: string;
  readonly portable?: boolean;
}) {
  const filesystem = yield* FileSystem.FileSystem;
  if (options.bunTarget !== nativeInferenceHostTarget())
    throw new Error('Inference assets must be built on their exact native OS/architecture/libc host.');
  if (Bun.env.CFLAGS || Bun.env.CXXFLAGS || Bun.env.CPPFLAGS || Bun.env.LDFLAGS)
    throw new Error('Native inference assembly rejects ambient compiler/linker flags.');
  const before = yield* Effect.promise(() => sourceInputs(options.root));
  const toolchain: Record<string, string> = {bun: Bun.version};
  const portable =
    options.portable ||
    EffectString.startsWith('bun-linux-')(options.bunTarget) ||
    options.bunTarget === 'bun-windows-arm64';
  if (portable) {
    const sourceGpu = process.platform === 'darwin' && process.arch === 'arm64' ? 'metal' : false;
    toolchain.buildGpu = String(sourceGpu);
    let buildEnvironment = {...Bun.env};
    if (process.platform !== 'win32') {
      const compatibilityBin = path.join(options.root, '.context', 'native-inference-compat');
      yield* filesystem.makeDirectory(compatibilityBin, {recursive: true});
      const bunLiteral = "'" + EffectString.replaceAll("'", "'\"'\"'")(process.execPath) + "'";
      yield* filesystem.writeFileString(path.join(compatibilityBin, 'node'), `#!/bin/sh\nexec ${bunLiteral} "$@"\n`);
      yield* filesystem.writeFileString(
        path.join(compatibilityBin, 'npm'),
        `#!/bin/sh\n[ "$1" = run ] || exit 2\nshift\n[ "$1" != -s ] || shift\nscript=$1\nshift\n[ "$1" != -- ] || shift\nexec ${bunLiteral} run --silent "$script" "$@"\n`,
      );
      yield* filesystem.chmod(path.join(compatibilityBin, 'node'), 0o755);
      yield* filesystem.chmod(path.join(compatibilityBin, 'npm'), 0o755);
      buildEnvironment = {
        ...Bun.env,
        PATH: `${compatibilityBin}:${Bun.env.PATH ?? ''}`,
      };
      toolchain.nodeCompatibilityHost = `bun-${Bun.version}`;
    }
    const compilerCommands =
      process.platform === 'win32'
        ? ([
            ['clang', ['--version']],
            ['clang++', ['--version']],
            ['node', ['--version']],
            ['npm', ['--version']],
          ] as const)
        : ([
            ['cc', ['--version']],
            ['c++', ['--version']],
          ] as const);
    for (const [name, args] of [
      ['cmake', ['--version']],
      ...(Bun.which('ninja') ? [['ninja', ['--version']] as const] : []),
      ...compilerCommands,
    ] as const) {
      const result = yield* runCommandEffect(name, [...args], {timeoutMs: 10_000, maxOutputBytes: 16_384});
      toolchain[name] = result.stdout;
    }
    toolchain.container = Bun.env.THREADNOTE_NATIVE_BUILD_IMAGE ?? 'native-host';
    toolchain.sysroot = Bun.env.THREADNOTE_NATIVE_SYSROOT_IDENTITY ?? 'native-host';
    if (EffectString.endsWith('-musl')(options.bunTarget)) {
      for (const file of ['apk-sha256.txt', 'installed-packages.txt', 'installed-db-sha256.txt']) {
        toolchain[file] = yield* filesystem.readFileString(
          path.join(options.root, '.context', 'native-inference-toolchain', file),
        );
      }
    }
    if (
      EffectString.endsWith('-musl')(options.bunTarget) &&
      (!EffectString.includes('@sha256:')(toolchain.container) || toolchain.sysroot === 'native-host')
    )
      throw new Error('Musl inference builds require a digest-pinned build image and explicit sysroot identity.');
    const scratch = path.join(options.root, '.context', 'native-inference-build');
    const isolatedPackage = path.join(scratch, 'node-llama-cpp');
    yield* filesystem.remove(scratch, {recursive: true, force: true});
    yield* filesystem.makeDirectory(scratch, {recursive: true});
    yield* filesystem.copy(before.packageRoot, isolatedPackage, {overwrite: true});
    yield* filesystem.symlink(path.join(options.root, 'node_modules'), path.join(scratch, 'node_modules'));
    const upstreamDriverPath = path.join(isolatedPackage, 'dist', 'bindings', 'utils', 'compileLLamaCpp.js');
    const upstreamDriver = yield* filesystem.readFileString(upstreamDriverPath);
    if (!EffectString.includes('const cpuCount = os.cpus().length;')(upstreamDriver))
      throw new Error('Pinned upstream build parallelism policy changed.');
    yield* filesystem.writeFileString(
      upstreamDriverPath,
      EffectString.replace(
        'const cpuCount = os.cpus().length;',
        'const cpuCount = Math.min(4, os.cpus().length);',
      )(upstreamDriver),
    );
    toolchain.maximumBuildThreads = '4';

    if (process.platform === 'win32') {
      const toolchainPath = path.join(isolatedPackage, 'llama', 'toolchains', 'win32.host-arm64.target-arm64.cmake');
      const original = yield* filesystem.readFileString(toolchainPath);
      if (!EffectString.includes('-march=armv8.7-a')(original))
        throw new Error('Pinned Windows ARM inference toolchain changed.');
      yield* filesystem.writeFileString(
        toolchainPath,
        EffectString.replaceAll('-march=armv8.7-a', '-march=armv8-a -fms-runtime-lib=static')(original),
      );
      const adaptationPath = path.join(isolatedPackage, 'llama', 'cmake', 'win32.llvmApplyGnuModeAdaptations.cmake');
      const adaptation = yield* filesystem.readFileString(adaptationPath);
      if (!EffectString.includes('--dependent-lib=msvcrt')(adaptation))
        throw new Error('Pinned Windows inference CRT adaptation changed.');
      yield* filesystem.writeFileString(
        adaptationPath,
        EffectString.replaceAll('--dependent-lib=msvcrt', '--dependent-lib=libcmt')(adaptation),
      );
      toolchain.windowsCpuFloor = 'armv8-a';
      toolchain.windowsCrt = 'static';
    }

    const source = path.join(isolatedPackage, 'llama', 'llama.cpp');
    const cloneDriver = path.join(scratch, 'clone.mjs');
    yield* Effect.promise(() =>
      Bun.write(
        cloneDriver,
        `import {cloneLlamaCppRepo} from './node-llama-cpp/dist/bindings/utils/cloneLlamaCppRepo.js'; await cloneLlamaCppRepo('ggml-org','llama.cpp','v0.7.0',true,false,false);`,
      ),
    );
    yield* runCommandEffect(process.execPath, [cloneDriver], {
      cwd: scratch,
      timeoutMs: 60_000,
      env: {...Bun.env, GIT_ALLOW_PROTOCOL: 'file'},
    });
    if (nativeReaderGit(source, ['rev-parse', 'HEAD']) !== NATIVE_INFERENCE_LLAMA_COMMIT)
      throw new Error('Pinned llama.cpp source commit differs from the bundled source.');
    const driver = path.join(scratch, 'build.mjs');
    // Use upstream's real build driver: it owns metadata, completion marker and full Release closure.
    yield* Effect.promise(() =>
      Bun.write(
        driver,
        `
      import {compileLlamaCpp} from './node-llama-cpp/dist/bindings/utils/compileLLamaCpp.js';
      import {getPlatformInfo} from './node-llama-cpp/dist/bindings/utils/getPlatformInfo.js';
      await compileLlamaCpp({customCmakeOptions:new Map(Object.entries(${JSON.stringify({...PORTABLE_OPTIONS, ...(sourceGpu === 'metal' ? {GGML_METAL: 'ON', GGML_METAL_EMBED_LIBRARY: 'ON'} : {}), ...(process.platform === 'win32' ? {GGML_CPU_ALL_VARIANTS: 'OFF', GGML_CPU_ARM_ARCH: 'armv8-a', CMAKE_MSVC_RUNTIME_LIBRARY: 'MultiThreaded'} : {})})})),
        progressLogs:'stderr',platform:${JSON.stringify(process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux')},
        platformInfo:await getPlatformInfo(),arch:process.arch,gpu:${JSON.stringify(sourceGpu)},
        llamaCpp:{repo:'ggml-org/llama.cpp',release:'v0.7.0'}},
        {includeBuildOptionsInBinaryFolderName:false,downloadCmakeIfNeeded:false,ensureLlamaCppRepoIsCloned:false,ciMode:true});
    `,
      ),
    );
    const buildResult = yield* runCommandEffect(process.execPath, [driver], {
      cwd: scratch,
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 4 * 1024 * 1024,
      detached: true,
      verifyOwnedProcessExit: 'group',
      env: {...buildEnvironment, CFLAGS: '', CXXFLAGS: '', SOURCE_DATE_EPOCH: '0'},
    });
    yield* filesystem.writeFileString(
      path.join(scratch, 'build-output.log'),
      `${buildResult.stdout}\n${buildResult.stderr}`,
    );
    yield* filesystem.remove(path.join(options.distributionRoot, 'runtime', 'native'), {recursive: true, force: true});
    const localBuilds = path.join(options.distributionRoot, 'llama', 'localBuilds');
    yield* filesystem.remove(localBuilds, {recursive: true, force: true});
    const builtRoot = path.join(isolatedPackage, 'llama', 'localBuilds');
    for (const folder of yield* filesystem.readDirectory(builtRoot)) {
      const cmakeCache = yield* filesystem.readFileString(path.join(builtRoot, folder, 'CMakeCache.txt'));
      const compileCommands = yield* filesystem.readFileString(path.join(builtRoot, folder, 'compile_commands.json'));
      toolchain[`compileCommandsSha256:${folder}`] = sha256HexSync(compileCommands);
      if (process.platform === 'win32') {
        if (
          !EffectString.includes('-march=armv8-a')(compileCommands) ||
          !EffectString.includes('-fms-runtime-lib=static')(compileCommands) ||
          /-march=(?:native|armv(?:8\.[1-9]|9)[^\s"\\]*)/u.test(compileCommands) ||
          EffectString.includes('--dependent-lib=msvcrt')(compileCommands)
        )
          throw new Error('Actual Windows ARM compile commands violate the portable CPU/static CRT profile.');
        toolchain.windowsCompileProfileVerified = 'armv8-a/staticCRT';
      }

      toolchain[`cmakeInputs:${folder}`] = EffectArray.join(
        EffectArray.filter(EffectString.split(cmakeCache, '\n'), line =>
          /^(?:CMAKE_(?:(?:C|CXX)_COMPILER(?:_AR|_RANLIB)?|LINKER|SYSROOT|(?:C|CXX|SHARED_LINKER)_FLAGS(?:_[A-Z]+)?|OSX_DEPLOYMENT_TARGET|MSVC_RUNTIME_LIBRARY)|GGML_[A-Z_]+):[^=]*=/u.test(
            line,
          ),
        ),
        '\n',
      );
      const destination = path.join(localBuilds, folder);
      yield* filesystem.makeDirectory(destination, {recursive: true});
      yield* filesystem.copy(path.join(builtRoot, folder, 'Release'), path.join(destination, 'Release'));
      yield* filesystem.copyFile(
        path.join(builtRoot, folder, 'buildDone.status'),
        path.join(destination, 'buildDone.status'),
      );
      if (process.platform === 'linux') {
        for (const library of ['libstdc++.so.6', 'libgcc_s.so.1']) {
          const located = yield* runCommandEffect('c++', [`-print-file-name=${library}`], {
            timeoutMs: 10_000,
            maxOutputBytes: 16_384,
          });
          const sourceLibrary = EffectString.trim(located.stdout);
          if (!path.isAbsolute(sourceLibrary))
            throw new Error(`The pinned compiler did not resolve required runtime ${library}.`);
          const actualLibrary = yield* filesystem.realPath(sourceLibrary);
          yield* filesystem.copyFile(actualLibrary, path.join(destination, 'Release', library));
        }
      }
    }
    yield* filesystem.copyFile(
      path.join(isolatedPackage, 'llama', 'lastBuild.json'),
      path.join(options.distributionRoot, 'llama', 'lastBuild.json'),
    );
  }
  const audits: Record<string, string> = {};
  for (const file of yield* nativeInferenceInventory(options.distributionRoot)) {
    if (/\.(?:node|so(?:\.[0-9]+)*|dylib|dll)$/iu.test(file.path))
      audits[file.path] = yield* auditNativeReaderBinary(
        path.join(options.distributionRoot, file.path),
        options.bunTarget,
        {inference: true},
      );
  }
  toolchain.binaryAudit = JSON.stringify(audits);
  const after = yield* Effect.promise(() => sourceInputs(options.root));
  if (before.sourceInputDigest !== after.sourceInputDigest)
    throw new Error('Native inference inputs changed during assembly.');
  return yield* publishNativeInferenceOverlay(options.distributionRoot, {
    bunVersion: Bun.version,
    bunTarget: options.bunTarget,
    packageVersion: NATIVE_INFERENCE_PACKAGE_VERSION,
    llamaCommit: NATIVE_INFERENCE_LLAMA_COMMIT,
    sourceInputDigest: before.sourceInputDigest,
    origin: portable ? 'portable-local-build' : 'locked-prebuilt',
    toolchain,
  });
});

const GNU_PINS = {
  x64: {
    image: 'quay.io/pypa/manylinux2014_x86_64@sha256:62eeff30ef134a85ec0f97109e008a319b0315ca5e8a6d754ee771556c02622a',
    rust: 'x86_64-unknown-linux-gnu',
    bun: 'bun-linux-x64-baseline',
    bunSha: 'e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76',
    rustupSha: '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c',
  },
  arm64: {
    image: 'quay.io/pypa/manylinux2014_aarch64@sha256:101d2292840109c9d329fcfcd7b89b46f59e19ca23cbfdcf059fb389994665fc',
    rust: 'aarch64-unknown-linux-gnu',
    bun: 'bun-linux-aarch64',
    bunSha: 'baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e',
    rustupSha: 'e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c',
  },
} as const;
export const runGnuBuildContainer = Effect.fn('nativeInference.gnuContainer')(function* (
  root: string,
  command: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64'))
    throw new Error('GNU CI builds require a native Linux host.');
  const pins = GNU_PINS[process.arch];
  const target = process.arch === 'x64' ? 'bun-linux-x64-baseline' : 'bun-linux-arm64';
  const scratch = path.join(root, '.context', 'native-inference-container');
  yield* fs.makeDirectory(scratch, {recursive: true});
  const driver = path.join(scratch, 'run-gnu.mjs');
  yield* fs.writeFileString(
    driver,
    `const child=Bun.spawn(${JSON.stringify(command)},{cwd:${JSON.stringify(root)},stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;`,
  );
  const quote = (value: string) => "'" + EffectString.replaceAll("'", "'\"'\"'")(value) + "'";
  const bootstrap = `set -eu
curl --fail --location --silent --show-error 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/${pins.bun}.zip' -o /tmp/bun.zip
printf '${pins.bunSha}  /tmp/bun.zip\\n' | sha256sum -c -
unzip -q /tmp/bun.zip -d /tmp/bun
export PATH='/tmp/bun/${pins.bun}:/tmp/threadnote-cargo/bin':"$PATH"
export CARGO_HOME=/tmp/threadnote-cargo RUSTUP_HOME=/tmp/threadnote-rustup
curl --fail --location --silent --show-error 'https://static.rust-lang.org/rustup/archive/1.28.2/${pins.rust}/rustup-init' -o /tmp/rustup-init
printf '${pins.rustupSha}  /tmp/rustup-init\\n' | sha256sum -c -
chmod 755 /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --profile minimal --default-host '${pins.rust}' --default-toolchain 1.89.0
git config --global --add safe.directory ${quote(root)}
cd ${quote(root)}
bun install --frozen-lockfile
bun ${quote(driver)}
`;
  yield* runCommandEffect(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      '--volume',
      `${root}:${root}`,
      '--workdir',
      root,
      '--env',
      `THREADNOTE_BUILD_TARGET=${target}`,
      '--env',
      `THREADNOTE_NATIVE_BUILD_IMAGE=${pins.image}`,
      '--env',
      'THREADNOTE_NATIVE_SYSROOT_IDENTITY=manylinux2014-glibc2.17',
      pins.image,
      'bash',
      '-ec',
      bootstrap,
    ],
    {timeoutMs: 40 * 60_000, maxOutputBytes: 8 * 1024 * 1024, detached: true, verifyOwnedProcessExit: 'group'},
  );
});

export const MUSL_BUILD_IMAGE =
  'alpine:3.17.10@sha256:8fc3dacfb6d69da8d44e42390de777e48577085db99aa4e4af35f483eb08b989';
const MUSL_PINS = {
  x64: {
    arch: 'x86_64',
    rust: 'x86_64-unknown-linux-musl',
    bun: 'bun-linux-x64-musl-baseline',
    bunSha: '6e9c37098b293920aed28bfb51ab240e26d23bfdd9bbfecb3ad428ac166549bc',
    rustupSha: 'e6599a1c7be58a2d8eaca66a80e0dc006d87bbcf780a58b7343d6e14c1605cb2',
    main: '904e7cbc13661ee11bc5b4ea2561977f39ace5b9b74d12a2f942107978e35102',
    community: '3878b969ce54edc86a1011fb6eb461f2cafc0922020f19f05f1a60e89499be3e',
  },
  arm64: {
    arch: 'aarch64',
    rust: 'aarch64-unknown-linux-musl',
    bun: 'bun-linux-aarch64-musl',
    bunSha: '57f01b02ac7113c61c935f28f38c2eab849e3c970dab21f8b640a87b1ef65009',
    rustupSha: 'a97c8f56d7462908695348dd8c71ea6740c138ce303715793a690503a94fc9a9',
    main: 'f4dea1e892a703d39b94806643ed7c13b309066a28ce9ae9561e781a07c9ebff',
    community: 'c356077cd32d88d77b09951f315af4e85062446769e26ed54d477cc84ca9e7ee',
  },
} as const;

/** Native-architecture CI container only; this deliberately has no emulation switch. */
export const runMuslBuildContainer = Effect.fn('nativeInference.muslContainer')(function* (
  root: string,
  command: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64'))
    throw new Error('Musl CI builds require a native Linux x64 or ARM64 Docker host.');
  const pins = MUSL_PINS[process.arch];
  const target = process.arch === 'x64' ? 'bun-linux-x64-baseline-musl' : 'bun-linux-arm64-musl';
  const scratch = path.join(root, '.context', 'native-inference-container');
  yield* fs.makeDirectory(scratch, {recursive: true});
  const driver = path.join(scratch, 'run.mjs');
  yield* fs.writeFileString(
    driver,
    `const child=Bun.spawn(${JSON.stringify(command)},{cwd:${JSON.stringify(root)},stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;`,
  );
  const shellLiteral = (value: string) => "'" + EffectString.replaceAll("'", "'\"'\"'")(value) + "'";
  const shellRoot = shellLiteral(root);
  const shellDriver = shellLiteral(driver);
  const bootstrap = `
set -eu
[ "$(uname -m)" = '${pins.arch}' ]
mkdir -p /tmp/threadnote-index /tmp/threadnote-apks ${shellRoot}/.context/native-inference-toolchain
printf '%s\\n' 'https://dl-cdn.alpinelinux.org/alpine/v3.17/main' 'https://dl-cdn.alpinelinux.org/alpine/v3.17/community' > /etc/apk/repositories
apk --cache-dir /tmp/threadnote-index update
find /tmp/threadnote-index -name 'APKINDEX.*.tar.gz' -exec sha256sum {} \\; > /tmp/index-sha256
[ "$(wc -l < /tmp/index-sha256)" -eq 2 ]
grep -q '^${pins.main} ' /tmp/index-sha256
grep -q '^${pins.community} ' /tmp/index-sha256
apk --cache-dir /tmp/threadnote-index fetch --recursive --output /tmp/threadnote-apks \
 build-base=0.5-r3 cmake=3.24.4-r0 samurai=1.2-r2 nodejs=18.20.1-r0 npm=9.1.2-r0 \
 python3=3.10.15-r0 git=2.39.5-r0 curl=8.9.0-r0 bash=5.2.15-r0 linux-headers=5.19.5-r0
find /tmp/threadnote-index -name 'APKINDEX.*.tar.gz' -exec sha256sum {} \\; > /tmp/index-after-sha256
cmp /tmp/index-sha256 /tmp/index-after-sha256
apk --no-network add /tmp/threadnote-apks/*.apk
sha256sum /tmp/threadnote-apks/*.apk > ${shellRoot}/.context/native-inference-toolchain/apk-sha256.txt
apk info -v > ${shellRoot}/.context/native-inference-toolchain/installed-packages.txt
sha256sum /lib/apk/db/installed > ${shellRoot}/.context/native-inference-toolchain/installed-db-sha256.txt
curl --fail --location --silent --show-error 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/${pins.bun}.zip' -o /tmp/bun.zip
printf '${pins.bunSha}  /tmp/bun.zip\\n' | sha256sum -c -
unzip -q /tmp/bun.zip -d /tmp/bun
export PATH='/tmp/bun/${pins.bun}:/tmp/threadnote-cargo/bin':"$PATH"
export CARGO_HOME=/tmp/threadnote-cargo RUSTUP_HOME=/tmp/threadnote-rustup
curl --fail --location --silent --show-error 'https://static.rust-lang.org/rustup/archive/1.28.2/${pins.rust}/rustup-init' -o /tmp/rustup-init
printf '${pins.rustupSha}  /tmp/rustup-init\\n' | sha256sum -c -
chmod 755 /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --profile minimal --default-host '${pins.rust}' --default-toolchain 1.89.0
git config --global --add safe.directory ${shellRoot}
cd ${shellRoot}
bun install --frozen-lockfile
bun ${shellDriver}
`;
  yield* runCommandEffect(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      '--volume',
      `${root}:${root}`,
      '--workdir',
      root,
      '--env',
      `THREADNOTE_BUILD_TARGET=${target}`,
      '--env',
      `THREADNOTE_NATIVE_BUILD_IMAGE=${MUSL_BUILD_IMAGE}`,
      '--env',
      'THREADNOTE_NATIVE_SYSROOT_IDENTITY=alpine3.17.10-musl1.2.3',
      MUSL_BUILD_IMAGE,
      'sh',
      '-ec',
      bootstrap,
    ],
    {timeoutMs: 40 * 60_000, maxOutputBytes: 8 * 1024 * 1024, detached: true, verifyOwnedProcessExit: 'group'},
  );
});

if (import.meta.main) {
  const argument = (name: string) => {
    const index = Bun.argv.indexOf(name);
    return index < 0 ? undefined : Bun.argv[index + 1];
  };
  const destination = argument('--distribution-root') ?? path.join(ROOT, 'dist');
  const overlay = argument('--stage-overlay');
  const containerCommand = argument('--container-command-json');
  const parsedCommand: unknown =
    containerCommand === undefined ? ['bun', 'run', 'build:release'] : JSON.parse(containerCommand);
  if (
    !EffectArray.isArray(parsedCommand) ||
    !EffectArray.every(parsedCommand, (part): part is string => typeof part === 'string') ||
    parsedCommand.length === 0
  )
    throw new Error('Container command must be a nonempty string array.');
  const main = Bun.argv.includes('--gnu-container')
    ? runGnuBuildContainer(ROOT, parsedCommand)
    : Bun.argv.includes('--musl-container')
      ? runMuslBuildContainer(ROOT, parsedCommand)
      : overlay
        ? stageNativeInferenceOverlay(overlay, destination)
        : assembleNativeInference({
            root: ROOT,
            distributionRoot: destination,
            bunTarget: Bun.env.THREADNOTE_BUILD_TARGET ?? nativeInferenceHostTarget(),
            portable: Bun.argv.includes('--portable'),
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
