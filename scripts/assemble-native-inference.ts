import {FileSystem} from 'effect';
import {Console, Effect, Layer, Schema, String as EffectString, Array as EffectArray} from 'effect';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {CommandFailed, runCommandEffect, type CommandExecutionError} from '@threadnote/platform/command';
import {platformPathFor, SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ScriptCommandExecutorLayer, ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer} from './effect/errors.js';
import {auditNativeReaderBinary, nativeReaderGit, type CompilerLibgccProvider} from './native-vector-reader-payload.js';
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

const MUSL_ARM_CMAKE_SHA256 = 'bae77e31bc3498973b435e29681c74e8a28857e84383698ef3b88ca2fb6b900a';
export const MUSL_ARM_BASE_VARIANTS = ['armv8.0_1', 'armv8.2_1', 'armv8.2_2', 'armv8.2_3', 'armv8.6_1', 'armv8.6_2'];
const MUSL_ARM_SME_VARIANTS = [
  {
    name: 'armv9.2_1',
    features: 'DOTPROD FP16_VECTOR_ARITHMETIC SVE MATMUL_INT8 SME',
    flags: '-march=armv9.2-a+dotprod+fp16+sve+i8mm+sme',
  },
  {
    name: 'armv9.2_2',
    features: 'DOTPROD FP16_VECTOR_ARITHMETIC SVE MATMUL_INT8 SVE2 SME',
    flags: '-march=armv9.2-a+dotprod+fp16+sve+i8mm+sve2+sme',
  },
] as const;

/** Only optional SME registrations change; the caller also verifies the entire pinned upstream file. */
export function muslArmVariantSource(original: string, included: readonly string[]) {
  let adapted = original;
  for (const variant of MUSL_ARM_BASE_VARIANTS) {
    if (EffectString.split(original, `ggml_add_cpu_backend_variant(${variant}`).length !== 2)
      throw new Error('Pinned musl ARM baseline variant context changed.');
  }
  for (const variant of MUSL_ARM_SME_VARIANTS) {
    const call = `            ggml_add_cpu_backend_variant(${variant.name}    ${variant.features})`;
    if (EffectString.split(original, call).length !== 2)
      throw new Error('Pinned musl ARM SME variant context changed.');
    if (!included.includes(variant.name))
      adapted = EffectString.replace(
        call,
        `            # Threadnote: ${variant.name} omitted after target compiler capability probe.`,
      )(adapted);
  }
  const patch = JSON.stringify({path: 'ggml/src/CMakeLists.txt', original, adapted});
  return {
    adapted,
    patch,
    identity: {
      originalSha256: sha256HexSync(original),
      adaptedSha256: sha256HexSync(adapted),
      patchSha256: sha256HexSync(patch),
    },
  };
}

/** Compile only with the selected target compilers; neither execute instructions nor inspect the build host CPU. */
export const probeMuslArmVariants = Effect.fn('nativeInference.muslArmVariants')(function* (options: {
  readonly scratch: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const probes = [];
  for (const variant of [{name: 'baseline', features: '', flags: '-march=armv8-a'}, ...MUSL_ARM_SME_VARIANTS]) {
    const features = variant.features ? EffectString.split(variant.features, ' ') : [];
    const source = `${EffectArray.join(
      EffectArray.map(
        features,
        feature => `#ifndef __ARM_FEATURE_${feature}\n#error Required target feature ${feature} is unavailable\n#endif`,
      ),
      '\n',
    )}\nint threadnote_compiler_probe(void) { return 0; }\n`;
    const languages = [];
    for (const [language, compiler, extension] of [
      ['c', options.env.CC ?? 'cc', 'c'],
      ['cxx', options.env.CXX ?? 'c++', 'cpp'],
    ] as const) {
      const input = path.join(options.scratch, `threadnote-${variant.name}.${extension}`);
      yield* fs.writeFileString(input, source);
      const args = [variant.flags, '-c', input, '-o', `${input}.o`];
      const result = yield* runCommandEffect(compiler, args, {
        cwd: options.scratch,
        env: options.env,
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      }).pipe(
        Effect.map(result => ({
          supported: true,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        })),
        Effect.catchTag('CommandFailed', error =>
          error.exitCode === 1 && variant.name !== 'baseline'
            ? Effect.succeed({supported: false, exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr})
            : Effect.fail(error),
        ),
      );
      languages.push({language, compiler, args, sourceSha256: sha256HexSync(source), ...result});
    }
    probes.push({variant: variant.name, flags: variant.flags, requiredFeatures: features, languages});
  }
  const included = [
    ...MUSL_ARM_BASE_VARIANTS,
    ...EffectArray.map(
      EffectArray.filter(
        probes,
        probe => probe.variant !== 'baseline' && EffectArray.every(probe.languages, language => language.supported),
      ),
      probe => probe.variant,
    ),
  ];
  return {
    requested: 'GGML_CPU_ALL_VARIANTS=ON',
    effective: 'compiler-supported-linux-arm-variants',
    included,
    omitted: EffectArray.map(
      EffectArray.filter(MUSL_ARM_SME_VARIANTS, variant => !included.includes(variant.name)),
      variant => ({variant: variant.name, reason: 'target-compiler-rejected-required-feature-probe'}),
    ),
    probes,
  };
});

/** Scope the newer GNU compiler to inference; vector assembly keeps the container's original compiler. */
export function nativeInferenceBuildEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...(environment.THREADNOTE_NATIVE_INFERENCE_CC ? {CC: environment.THREADNOTE_NATIVE_INFERENCE_CC} : {}),
    ...(environment.THREADNOTE_NATIVE_INFERENCE_CXX ? {CXX: environment.THREADNOTE_NATIVE_INFERENCE_CXX} : {}),
  };
}

// This exact helper and version table are supplied by the digest-pinned manylinux2014 images.
export const GNU_INFERENCE_COMPILER_BOOTSTRAP = `manylinux-install-clang -v v20.1.8.0 -c a0e42b3a3b8c752e1382d697b98d00bff256a99dc04146de2eb2fb1c0bd908be
threadnote_inference_compiler_bin=/opt/clang/bin
threadnote_outer_path=":$PATH:"
while case "$threadnote_outer_path" in *:"$threadnote_inference_compiler_bin":*) true;; *) false;; esac; do
  threadnote_outer_prefix="\${threadnote_outer_path%%:"$threadnote_inference_compiler_bin":*}"
  threadnote_outer_path="$threadnote_outer_prefix:\${threadnote_outer_path#*:"$threadnote_inference_compiler_bin":}"
done
threadnote_outer_path="\${threadnote_outer_path#:}"
export PATH="\${threadnote_outer_path%:}"
unset threadnote_outer_path threadnote_outer_prefix threadnote_inference_compiler_bin
export THREADNOTE_NATIVE_INFERENCE_CC=/opt/clang/bin/clang THREADNOTE_NATIVE_INFERENCE_CXX=/opt/clang/bin/clang++
`;

/** APK2.12 fetch arguments are names; --world feeds parsed exact constraints to its own recursive solver. */
export function muslToolchainFetchScript(workflowRuntime = false): string {
  return `cp /etc/apk/world /tmp/threadnote-original-world
printf '%s\\n' build-base=0.5-r3 cmake=3.24.4-r0 samurai=1.2-r2 nodejs=18.20.1-r0 npm=9.1.2-r0 python3=3.10.15-r0 git=2.39.5-r0 curl=8.9.0-r0 bash=5.2.15-r0 linux-headers=5.19.5-r0${workflowRuntime ? ' ripgrep=13.0.0-r1 bubblewrap=0.7.0-r0' : ''} >> /etc/apk/world
apk --cache-dir /tmp/threadnote-index fetch --world --recursive --output /tmp/threadnote-apks
cp /tmp/threadnote-original-world /etc/apk/world
`;
}

// Root prepare installs development hooks/lint replacements; the pinned Oxlint patch has no musl build.
// Refuse this exemption if required installation hooks or trusted dependency scripts are introduced.
export const MUSL_BUILD_DEPENDENCY_INSTALL = String.raw`bun -e '
const root = await Bun.file("package.json").json();
const prepare = "bun --bun husky && bun --bun effect-tsgo patch --no-typescript --oxlint";
const hooks = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];
if (root.scripts?.prepare !== prepare || JSON.stringify(root.trustedDependencies) !== "[]" || !Array.isArray(root.workspaces))
  throw new Error("Musl build dependency lifecycle policy changed; inspect required install contracts.");
const check = (manifest, root = false) => {
  if (JSON.stringify(manifest.trustedDependencies ?? []) !== "[]" ||
      hooks.some(hook => !(root && hook === "prepare") && manifest.scripts?.[hook] !== undefined))
    throw new Error("Musl build cannot skip a required package installation hook.");
};
check(root, true);
for (const pattern of root.workspaces)
  for await (const file of new Bun.Glob(pattern + "/package.json").scan({onlyFiles: true}))
    check(await Bun.file(file).json());
'
bun install --frozen-lockfile --ignore-scripts
HUSKY=0 bun --bun husky
bun --bun effect-tsgo patch --no-typescript --oxlint --skip-missing
`;

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

export const buildNativeInferenceDriver = Effect.fn('nativeInference.buildDriver')(function* (options: {
  readonly driver: string;
  readonly scratch: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const system = yield* SystemInfo;
  return yield* runCommandEffect(process.execPath, [options.driver], {
    cwd: options.scratch,
    timeoutMs: 30 * 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
    detached: true,
    // Windows retains scoped tree cleanup and leader confirmation; POSIX can also observe its owned group.
    verifyOwnedProcessExit: system.platform === 'win32' ? 'leader' : 'group',
    env: options.env,
  });
});

/** Upstream forwards every compiler progress line; retain live bounded tails in this isolated build process. */
export function nativeInferenceBuildDriverSource(body: string): string {
  return String.raw`
import {Buffer} from 'node:buffer';
const maximumTailBytes = 512 * 1024;
const captures = [process.stdout, process.stderr].map((stream, index) => {
  const write = stream.write.bind(stream);
  const tail = Buffer.alloc(maximumTailBytes);
  let offset = 0;
  let totalBytes = 0;
  stream.write = (chunk, encoding, callback) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
    totalBytes += bytes.length;
    const last = bytes.subarray(Math.max(0, bytes.length - maximumTailBytes));
    const firstLength = Math.min(last.length, maximumTailBytes - offset);
    last.copy(tail, offset, 0, firstLength);
    last.copy(tail, 0, firstLength);
    offset = (offset + last.length) % maximumTailBytes;
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(() => done());
    return true;
  };
  return {
    restore() { stream.write = write; },
    flush() {
      const retained = totalBytes < maximumTailBytes ? tail.subarray(0, totalBytes)
        : Buffer.concat([tail.subarray(offset), tail.subarray(0, offset)]);
      const notice = totalBytes > retained.length
        ? Buffer.from('Threadnote native build ' + (index === 0 ? 'stdout' : 'stderr') + ': retained final ' + retained.length + ' of ' + totalBytes + ' bytes.\n')
        : Buffer.alloc(0);
      return new Promise((resolve, reject) => write(Buffer.concat([notice, retained]), error => error ? reject(error) : resolve()));
    }
  };
});
try {
${body}
} finally {
  for (const capture of captures) capture.restore();
  await Promise.all(captures.map(capture => capture.flush()));
}
`;
}

/** CI/build-time only. Runtime always uses build:never and skipDownload:true. */
/** Capture bytes from the selected compiler's runtime lookup before enrolling any provider audit role. */
export const copyNativeInferenceCompilerRuntimes = Effect.fn('nativeInference.copyCompilerRuntimes')(
  function* (options: {
    readonly compiler: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly destination: string;
    readonly bunTarget: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const copies = [];
    for (const library of ['libstdc++.so.6', 'libgcc_s.so.1']) {
      const located = yield* runCommandEffect(options.compiler, [`-print-file-name=${library}`], {
        env: options.environment,
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      });
      const locatedPath = EffectString.trim(located.stdout);
      if (!path.isAbsolute(locatedPath))
        throw new Error(`The pinned compiler did not resolve required runtime ${library}.`);
      const sourcePath = yield* fs.realPath(locatedPath);
      const bytes = yield* fs.readFile(sourcePath);
      const sha256 = sha256HexSync(bytes);
      const destination = path.join(options.destination, library);
      yield* fs.writeFile(destination, bytes);
      if (
        sha256HexSync(yield* fs.readFile(sourcePath)) !== sha256 ||
        sha256HexSync(yield* fs.readFile(destination)) !== sha256
      )
        throw new Error('Compiler runtime source/copy changed while capturing its bytes.');
      const compilerLibgccProvider: CompilerLibgccProvider | undefined =
        options.bunTarget === 'bun-linux-arm64-musl' && library === 'libgcc_s.so.1' ? {sourcePath, sha256} : undefined;
      copies.push({library, sourcePath, destination, sha256, compilerLibgccProvider});
    }
    return copies;
  },
);

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
  const compilerLibgccProviders: Record<string, CompilerLibgccProvider> = {};
  const compilerRuntimeCopies: Array<{path: string; sourcePath: string; sha256: string; auditRole: string}> = [];
  let muslArmSourceIdentity: {originalSha256: string; adaptedSha256: string; patchSha256: string} | undefined;
  let includedMuslArmVariants: readonly string[] | undefined;
  const portable =
    options.portable ||
    EffectString.startsWith('bun-linux-')(options.bunTarget) ||
    options.bunTarget === 'bun-windows-arm64';
  if (portable) {
    const sourceGpu = process.platform === 'darwin' && process.arch === 'arm64' ? 'metal' : false;
    toolchain.buildGpu = String(sourceGpu);
    let buildEnvironment = nativeInferenceBuildEnvironment(Bun.env);
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
        ...buildEnvironment,
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
            [buildEnvironment.CC ?? 'cc', ['--version']],
            [buildEnvironment.CXX ?? 'c++', ['--version']],
          ] as const);
    for (const [name, args] of [
      ['cmake', ['--version']],
      ...(Bun.which('ninja') ? [['ninja', ['--version']] as const] : []),
      ...compilerCommands,
    ] as const) {
      const result = yield* runCommandEffect(name, [...args], {timeoutMs: 10_000, maxOutputBytes: 16_384});
      toolchain[name] = result.stdout;
    }
    if (process.platform !== 'win32') {
      for (const [field, compiler] of [
        ['cCompiler', buildEnvironment.CC ?? 'cc'],
        ['cxxCompiler', buildEnvironment.CXX ?? 'c++'],
      ]) {
        const executable = Bun.which(compiler, {PATH: buildEnvironment.PATH});
        if (!executable) throw new Error(`Native inference compiler is unavailable: ${compiler}`);
        toolchain[field] = executable;
        toolchain[`${field}Sha256`] = sha256HexSync(yield* filesystem.readFile(yield* filesystem.realPath(executable)));
      }
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
    if (options.bunTarget === 'bun-linux-arm64-musl') {
      const cmakePath = path.join(source, 'ggml', 'src', 'CMakeLists.txt');
      const original = yield* filesystem.readFileString(cmakePath);
      if (sha256HexSync(original) !== MUSL_ARM_CMAKE_SHA256)
        throw new Error('Pinned musl ARM inference CMake source changed.');
      const policy = yield* probeMuslArmVariants({scratch, env: buildEnvironment});
      const adaptation = muslArmVariantSource(original, policy.included);
      muslArmSourceIdentity = adaptation.identity;
      includedMuslArmVariants = policy.included;
      toolchain.muslArmVariantPolicy = JSON.stringify({
        ...policy,
        source: {
          baseCommit: NATIVE_INFERENCE_LLAMA_COMMIT,
          baseSourceInputDigest: before.sourceInputDigest,
          ...muslArmSourceIdentity,
        },
      });
      yield* filesystem.writeFileString(path.join(scratch, 'musl-arm-sme.patch.json'), adaptation.patch);
      yield* filesystem.writeFileString(path.join(scratch, 'musl-arm-sme-policy.json'), toolchain.muslArmVariantPolicy);
      yield* filesystem.writeFileString(cmakePath, adaptation.adapted);
    }
    const driver = path.join(scratch, 'build.mjs');
    // Use upstream's real build driver: it owns metadata, completion marker and full Release closure.
    yield* Effect.promise(() =>
      Bun.write(
        driver,
        nativeInferenceBuildDriverSource(`
      const {compileLlamaCpp} = await import('./node-llama-cpp/dist/bindings/utils/compileLLamaCpp.js');
      const {getPlatformInfo} = await import('./node-llama-cpp/dist/bindings/utils/getPlatformInfo.js');
      await compileLlamaCpp({customCmakeOptions:new Map(Object.entries(${JSON.stringify({...PORTABLE_OPTIONS, ...(sourceGpu === 'metal' ? {GGML_METAL: 'ON', GGML_METAL_EMBED_LIBRARY: 'ON'} : {}), ...(process.platform === 'win32' ? {GGML_CPU_ALL_VARIANTS: 'OFF', GGML_CPU_ARM_ARCH: 'armv8-a', CMAKE_MSVC_RUNTIME_LIBRARY: 'MultiThreaded'} : {})})})),
        progressLogs:'stderr',platform:${JSON.stringify(process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux')},
        platformInfo:await getPlatformInfo(),arch:process.arch,gpu:${JSON.stringify(sourceGpu)},
        llamaCpp:{repo:'ggml-org/llama.cpp',release:'v0.7.0'}},
        {includeBuildOptionsInBinaryFolderName:false,downloadCmakeIfNeeded:false,ensureLlamaCppRepoIsCloned:false,ciMode:true});
    `),
      ),
    );
    const buildResult = yield* buildNativeInferenceDriver({
      driver,
      scratch,
      env: {...buildEnvironment, CFLAGS: '', CXXFLAGS: '', SOURCE_DATE_EPOCH: '0'},
    });
    if (
      muslArmSourceIdentity &&
      sha256HexSync(yield* filesystem.readFileString(path.join(source, 'ggml', 'src', 'CMakeLists.txt'))) !==
        muslArmSourceIdentity.adaptedSha256
    )
      throw new Error('Musl ARM inference CMake source changed during assembly.');
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
      if (includedMuslArmVariants) {
        for (const variant of [
          ...MUSL_ARM_BASE_VARIANTS,
          ...EffectArray.map(MUSL_ARM_SME_VARIANTS, variant => variant.name),
        ]) {
          const included = includedMuslArmVariants.includes(variant);
          const libraryExists = yield* filesystem.exists(
            path.join(builtRoot, folder, 'Release', `libggml-cpu-${variant}.so`),
          );
          if (
            EffectString.includes(`CMakeFiles/ggml-cpu-${variant}.dir/`)(compileCommands) !== included ||
            libraryExists !== included
          )
            throw new Error(`Musl ARM compile commands differ from the verified variant policy: ${variant}.`);
        }
      }
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
        for (const copy of yield* copyNativeInferenceCompilerRuntimes({
          compiler: buildEnvironment.CXX ?? 'c++',
          environment: buildEnvironment,
          destination: path.join(destination, 'Release'),
          bunTarget: options.bunTarget,
        })) {
          const relative = EffectArray.join(
            EffectString.split(path.relative(options.distributionRoot, copy.destination), path.sep),
            '/',
          );
          if (copy.compilerLibgccProvider) compilerLibgccProviders[relative] = copy.compilerLibgccProvider;
          compilerRuntimeCopies.push({
            path: relative,
            sourcePath: copy.sourcePath,
            sha256: copy.sha256,
            auditRole: copy.compilerLibgccProvider ? 'compiler-libgcc' : 'inference',
          });
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
        {inference: true, compilerLibgccProvider: compilerLibgccProviders[file.path]},
      );
  }
  if (compilerRuntimeCopies.length !== 0) toolchain.compilerRuntimeCopies = JSON.stringify(compilerRuntimeCopies);
  toolchain.binaryAudit = JSON.stringify(audits);
  const after = yield* Effect.promise(() => sourceInputs(options.root));
  if (before.sourceInputDigest !== after.sourceInputDigest)
    throw new Error('Native inference inputs changed during assembly.');
  return yield* publishNativeInferenceOverlay(options.distributionRoot, {
    bunVersion: Bun.version,
    bunTarget: options.bunTarget,
    packageVersion: NATIVE_INFERENCE_PACKAGE_VERSION,
    llamaCommit: NATIVE_INFERENCE_LLAMA_COMMIT,
    sourceInputDigest: muslArmSourceIdentity
      ? sha256HexSync(JSON.stringify({baseSourceInputDigest: before.sourceInputDigest, muslArmSourceIdentity}))
      : before.sourceInputDigest,
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

/** Command adapter streams are already redacted; keep both when Docker stderr masks a build failure on stdout. */
export function nativeContainerFailureReport(error: CommandExecutionError) {
  return Schema.is(CommandFailed)(error)
    ? {version: 1, failure: error._tag, exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr}
    : {version: 1, failure: error._tag, message: error.message};
}

const retainNativeContainerFailure = Effect.fn('nativeInference.containerFailure')(function* (
  scratch: string,
  container: 'gnu' | 'musl',
  error: CommandExecutionError,
) {
  const fs = yield* FileSystem.FileSystem;
  const report = nativeContainerFailureReport(error);
  yield* fs
    .writeFileString(path.join(scratch, `${container}-failure.json`), JSON.stringify(report, null, 2))
    .pipe(Effect.catch(() => Console.error(`Could not retain ${container} container failure receipt.`)));
  // The receipt retains the complete bounded streams; CI logs need only the final diagnostic from each.
  yield* Console.error(
    `Native ${container} container failure:`,
    JSON.stringify(
      Schema.is(CommandFailed)(error)
        ? {
            ...report,
            stdout: EffectString.slice(-32_768)(error.stdout),
            stderr: EffectString.slice(-32_768)(error.stderr),
          }
        : report,
    ),
  );
});

/** Git2.39 compares safe.directory literally, including trailing slashes and symlink spellings. */
export const nativeContainerCheckoutRoot = Effect.fn('nativeInference.checkoutRoot')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  return path.resolve(yield* fs.realPath(root));
});

export const runGnuBuildContainer = Effect.fn('nativeInference.gnuContainer')(function* (
  root: string,
  command: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64'))
    throw new Error('GNU CI builds require a native Linux host.');
  const checkoutRoot = yield* nativeContainerCheckoutRoot(root);
  const pins = GNU_PINS[process.arch];
  const target = process.arch === 'x64' ? 'bun-linux-x64-baseline' : 'bun-linux-arm64';
  const scratch = path.join(checkoutRoot, '.context', 'native-inference-container');
  yield* fs.makeDirectory(scratch, {recursive: true});
  const driver = path.join(scratch, 'run-gnu.mjs');
  yield* fs.writeFileString(
    driver,
    `const child=Bun.spawn(${JSON.stringify(command)},{cwd:${JSON.stringify(checkoutRoot)},stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;`,
  );
  const quote = (value: string) => "'" + EffectString.replaceAll("'", "'\"'\"'")(value) + "'";
  const bootstrap = `set -eu
stage=bun-bootstrap
trap 'status=$?; if [ "$status" -ne 0 ]; then printf "Native GNU container failed at %s (exit %s)\\n" "$stage" "$status" >&2; fi' 0
curl --fail --location --silent --show-error 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/${pins.bun}.zip' -o /tmp/bun.zip
printf '${pins.bunSha}  /tmp/bun.zip\\n' | sha256sum -c -
unzip -q /tmp/bun.zip -d /tmp/bun
export PATH='/tmp/bun/${pins.bun}:/tmp/threadnote-cargo/bin':"$PATH"
export CARGO_HOME=/tmp/threadnote-cargo RUSTUP_HOME=/tmp/threadnote-rustup
stage=rust-bootstrap
curl --fail --location --silent --show-error 'https://static.rust-lang.org/rustup/archive/1.28.2/${pins.rust}/rustup-init' -o /tmp/rustup-init
printf '${pins.rustupSha}  /tmp/rustup-init\\n' | sha256sum -c -
chmod 755 /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --profile minimal --default-host '${pins.rust}' --default-toolchain 1.89.0
stage=inference-compiler-bootstrap
${GNU_INFERENCE_COMPILER_BOOTSTRAP}git config --global --add safe.directory ${quote(checkoutRoot)}
stage=checkout-git-preflight
git -C ${quote(checkoutRoot)} status --porcelain --untracked-files=normal > /dev/null
cd ${quote(checkoutRoot)}
stage=frozen-dependency-install
bun install --frozen-lockfile
stage=requested-command
bun ${quote(driver)}
`;
  yield* runCommandEffect(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      '--volume',
      `${checkoutRoot}:${checkoutRoot}`,
      '--workdir',
      checkoutRoot,
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
  ).pipe(Effect.tapError(error => retainNativeContainerFailure(scratch, 'gnu', error)));
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

// The trusted harness supplies fixed namespace arguments and no capability-restoring options.
export const MUSL_WORKFLOW_BWRAP_SHIM = '#!/bin/sh\nexec /usr/bin/bwrap --cap-drop ALL "$@"\n';
const MUSL_WORKFLOW_CAPABILITY_PROBE = String.raw`
const status = await Bun.file('/proc/self/status').text();
const capabilities = {};
for (const field of ['CapEff', 'CapPrm', 'CapAmb']) {
  const line = status.split('\n').find(line => line.startsWith(field + ':'));
  const value = line?.slice(field.length + 1).trim();
  if (!value || !/^0+$/.test(value)) throw new Error('Inner workflow retained or omitted ' + field);
  capabilities[field] = value;
}
process.stdout.write(JSON.stringify({pid: process.pid, capabilities}) + '\n');
`;

/** The outer harness needs mount and loopback setup; the inner bwrap command drops all capabilities. */
export function muslWorkflowRuntimeArguments(environment: Readonly<NodeJS.ProcessEnv>): readonly string[] {
  const archive = environment.THREADNOTE_RELEASE_ARCHIVE;
  const profile = environment.THREADNOTE_RELEASE_PROFILE;
  if (
    !archive ||
    !/^artifacts\/threadnote-linux-(?:x64|arm64)-musl\.tar\.gz$/u.test(archive) ||
    !profile ||
    !/^[a-z][a-z0-9-]*$/u.test(profile)
  )
    throw new Error('Musl workflow execution requires its extracted release archive and profile.');
  return [
    '--cap-add',
    'SYS_ADMIN',
    '--cap-add',
    'NET_ADMIN',
    '--security-opt',
    'apparmor=unconfined',
    '--env',
    `THREADNOTE_RELEASE_ARCHIVE=${archive}`,
    '--env',
    `THREADNOTE_RELEASE_PROFILE=${profile}`,
  ];
}

/** Native-architecture CI container only; this deliberately has no emulation switch. */
export const runMuslBuildContainer = Effect.fn('nativeInference.muslContainer')(function* (
  root: string,
  command: readonly string[],
  options: {readonly workflowRuntime?: boolean} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const workflowArguments = options.workflowRuntime ? muslWorkflowRuntimeArguments(Bun.env) : [];
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64'))
    throw new Error('Musl CI builds require a native Linux x64 or ARM64 Docker host.');
  const checkoutRoot = yield* nativeContainerCheckoutRoot(root);
  const pins = MUSL_PINS[process.arch];
  const target = process.arch === 'x64' ? 'bun-linux-x64-baseline-musl' : 'bun-linux-arm64-musl';
  const scratch = path.join(checkoutRoot, '.context', 'native-inference-container');
  yield* fs.makeDirectory(scratch, {recursive: true});
  const driver = path.join(scratch, 'run.mjs');
  yield* fs.writeFileString(
    driver,
    `const child=Bun.spawn(${JSON.stringify(command)},{cwd:${JSON.stringify(checkoutRoot)},stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;`,
  );
  const shellLiteral = (value: string) => "'" + EffectString.replaceAll("'", "'\"'\"'")(value) + "'";
  const shellRoot = shellLiteral(checkoutRoot);
  const shellDriver = shellLiteral(driver);
  const bootstrap = `
set -eu
stage=host-architecture
trap 'status=$?; if [ "$status" -ne 0 ]; then printf "Native musl container failed at %s (exit %s)\\n" "$stage" "$status" >&2; fi' 0
[ "$(uname -m)" = '${pins.arch}' ]
mkdir -p /tmp/threadnote-index /tmp/threadnote-apks ${shellRoot}/.context/native-inference-toolchain
printf '%s\\n' 'https://dl-cdn.alpinelinux.org/alpine/v3.17/main' 'https://dl-cdn.alpinelinux.org/alpine/v3.17/community' > /etc/apk/repositories
stage=apk-index-update
apk --cache-dir /tmp/threadnote-index update
stage=apk-index-bytepins
find /tmp/threadnote-index -name 'APKINDEX.*.tar.gz' -exec sha256sum {} \\; > /tmp/index-sha256
[ "$(wc -l < /tmp/index-sha256)" -eq 2 ]
grep -q '^${pins.main} ' /tmp/index-sha256
grep -q '^${pins.community} ' /tmp/index-sha256
stage=apk-package-fetch
${muslToolchainFetchScript(options.workflowRuntime)}find /tmp/threadnote-index -name 'APKINDEX.*.tar.gz' -exec sha256sum {} \\; > /tmp/index-after-sha256
cmp /tmp/index-sha256 /tmp/index-after-sha256
stage=apk-offline-install
apk --no-network add /tmp/threadnote-apks/*.apk
sha256sum /tmp/threadnote-apks/*.apk > ${shellRoot}/.context/native-inference-toolchain/apk-sha256.txt
apk info -v > ${shellRoot}/.context/native-inference-toolchain/installed-packages.txt
sha256sum /lib/apk/db/installed > ${shellRoot}/.context/native-inference-toolchain/installed-db-sha256.txt
stage=bun-bootstrap
curl --fail --location --silent --show-error 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/${pins.bun}.zip' -o /tmp/bun.zip
printf '${pins.bunSha}  /tmp/bun.zip\\n' | sha256sum -c -
unzip -q /tmp/bun.zip -d /tmp/bun
export PATH='/tmp/bun/${pins.bun}:/tmp/threadnote-cargo/bin':"$PATH"
export CARGO_HOME=/tmp/threadnote-cargo RUSTUP_HOME=/tmp/threadnote-rustup
stage=rust-bootstrap
curl --fail --location --silent --show-error 'https://static.rust-lang.org/rustup/archive/1.28.2/${pins.rust}/rustup-init' -o /tmp/rustup-init
printf '${pins.rustupSha}  /tmp/rustup-init\\n' | sha256sum -c -
chmod 755 /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --profile minimal --default-host '${pins.rust}' --default-toolchain 1.89.0
git config --global --add safe.directory ${shellRoot}
stage=checkout-git-preflight
git -C ${shellRoot} status --porcelain --untracked-files=normal > /dev/null
cd ${shellRoot}
stage=frozen-dependency-install
${MUSL_BUILD_DEPENDENCY_INSTALL}
${
  options.workflowRuntime
    ? `stage=workflow-capability-boundary
mkdir -p /usr/local/bin ${shellRoot}/.context/release-artifact
printf '%s' ${shellLiteral(MUSL_WORKFLOW_BWRAP_SHIM)} > /usr/local/bin/bwrap
chmod 755 /usr/local/bin/bwrap
export PATH=/usr/local/bin:"$PATH"
[ "$(command -v bwrap)" = /usr/local/bin/bwrap ]
bwrap --unshare-net --die-with-parent --ro-bind / / --tmpfs ${shellRoot} --dev /dev --proc /proc --chdir /tmp bun -e ${shellLiteral(MUSL_WORKFLOW_CAPABILITY_PROBE)} > ${shellRoot}/.context/release-artifact/capabilities.json
`
    : ''
}stage=requested-command
bun ${shellDriver}
`;
  yield* runCommandEffect(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      ...workflowArguments,
      '--volume',
      `${checkoutRoot}:${checkoutRoot}`,
      '--workdir',
      checkoutRoot,
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
  ).pipe(Effect.tapError(error => retainNativeContainerFailure(scratch, 'musl', error)));
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
      ? runMuslBuildContainer(ROOT, parsedCommand, {workflowRuntime: Bun.argv.includes('--workflow-runtime')})
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
