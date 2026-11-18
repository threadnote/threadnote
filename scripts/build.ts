import {Array as EffectArray} from 'effect';
import {nativeVectorReaderHostProfile} from '@threadnote/recall/vector/native-reader-payload';
import {
  parseNativeRequirements,
  parseDevSkillsManifest,
  parseDevSkillsInventory,
} from '@threadnote/threadnote/dev_skills/manifest';
import {integrationStaticFiles} from '@threadnote/threadnote/manager/static-files';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {runBunBuild} from './effect/bun-build.js';
import {assertRuntimeSourceIdentity, runtimeSourceIdentity} from './runtime-source-identity.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {javascriptStringLiteral, optionalNativePackageFallbackModule} from './effect/javascript.js';
import {isDevelopmentBuildVersion} from './development-runtime.js';
import {sha256Hex} from '@threadnote/platform/digest';
import {
  assertNativeTypeScriptAssetOutsideReleaseOutput,
  stageReviewedNativeTypeScriptRuntimeAsset,
} from '../tools/semantic/build-typescript-native.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const PackageManifestSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  packageManager: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
});

const ROOT_URL = new URL('..', import.meta.url);
const RELEASE_DIRECTORIES = ['assets', 'config', 'cursor-plugin'] as const;
const REMOTE_MEMORY_MIGRATION_DIRECTORY = 'remote-memory/migrations';
const FORBIDDEN_RELEASE_DIRECTORIES = ['docs', 'training', 'apps', 'packages', 'site-dist'] as const;
const RELEASE_FILES = ['.threadnoteignore', 'LICENSE', 'THIRD_PARTY.md'] as const;
const NATIVE_RUNTIME_PACKAGE = 'node-llama-cpp';
const OPTIONAL_NATIVE_PACKAGE = /^@node-llama-cpp\//;
const EXACT_PACKAGE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(ROOT_URL);
  const outputRoot = path.join(root, 'dist');
  yield* Effect.tryPromise({
    try: () => assertNativeTypeScriptAssetOutsideReleaseOutput(Bun.env.THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR, root),
    catch: cause => ScriptError.make({message: 'Native TypeScript release input preflight failed.', cause}),
  });
  const manifest = yield* readPackageManifest(fs, path.join(root, 'package.json'));
  if (manifest.packageManager !== `bun@${Bun.version}`) {
    return yield* ScriptError.make({
      message: `Standalone builds require ${manifest.packageManager ?? 'an exact Bun packageManager pin'}; running bun@${Bun.version}.`,
    });
  }
  const configuredDevelopmentVersion = Effect2.pipe(
    Bun.env.THREADNOTE_DEVELOPMENT_BUILD_VERSION,
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (configuredDevelopmentVersion && !isDevelopmentBuildVersion(configuredDevelopmentVersion)) {
    return yield* ScriptError.make({
      message: 'THREADNOTE_DEVELOPMENT_BUILD_VERSION must be a SHA-bound local development version.',
    });
  }
  const version = configuredDevelopmentVersion ?? manifest.version;
  const nativeRuntimeVersion = manifest.dependencies?.[NATIVE_RUNTIME_PACKAGE];
  if (!version || !nativeRuntimeVersion || !EXACT_PACKAGE_VERSION.test(nativeRuntimeVersion)) {
    return yield* ScriptError.make({
      message: 'package.json must declare version and an exact node-llama-cpp dependency.',
    });
  }

  const target = buildTarget();
  assertNativeTargetMatchesHost(target);
  const executableName = Effect2.pipe(target, EffectString.includes('windows')) ? 'threadnote.exe' : 'threadnote';
  const executablePath = path.join(outputRoot, executableName);
  const devSkills = yield* buildDevSkillsManifest(root, version);

  yield* fs.makeDirectory(outputRoot, {recursive: true});
  for (const directory of FORBIDDEN_RELEASE_DIRECTORIES) {
    const releasePath = path.join(outputRoot, directory);
    if (yield* fs.exists(releasePath)) {
      yield* fs.remove(releasePath, {recursive: true});
    }
  }
  for (const directory of RELEASE_DIRECTORIES) {
    if (directory === 'config' && (yield* fs.exists(path.join(outputRoot, directory)))) {
      yield* fs.remove(path.join(outputRoot, directory), {recursive: true});
    }
    yield* fs.copy(path.join(root, directory), path.join(outputRoot, directory), {overwrite: true});
  }
  const stagedDevSkills = yield* buildDevSkillsManifest(outputRoot, version);
  if (stagedDevSkills.digest !== devSkills.digest) {
    return yield* ScriptError.make({message: 'Development workflows changed while the release was staged.'});
  }
  yield* fs.writeFileString(
    path.join(outputRoot, 'config', 'dev-skills.json'),
    `${JSON.stringify(devSkills, null, 2)}\n`,
  );
  yield* fs.copy(path.join(root, 'packages', 'manager', 'static'), path.join(outputRoot, 'manager'), {
    overwrite: true,
  });
  for (const file of EffectRecord.values(integrationStaticFiles)) {
    const destination = path.join(outputRoot, 'manager', file.path);
    yield* fs.makeDirectory(path.dirname(destination), {recursive: true});
    yield* fs.copyFile(path.join(root, file.sourceDirectory, file.path), destination);
  }
  yield* fs.copy(
    path.join(root, 'packages', 'remote-memory', 'src', 'migrations'),
    path.join(outputRoot, REMOTE_MEMORY_MIGRATION_DIRECTORY),
    {overwrite: true},
  );
  yield* stageCodeGraphPackageAssets(fs, path, root, outputRoot);
  for (const file of RELEASE_FILES) {
    yield* fs.copyFile(path.join(root, file), path.join(outputRoot, file));
  }

  const sourceIdentity = yield* runtimeSourceIdentity(root, target);
  yield* runBunBuild({
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
      outfile: executablePath,
      target,
    },
    define: {
      'process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED': JSON.stringify('true'),
      THREADNOTE_STANDALONE: 'true',
      THREADNOTE_VERSION: JSON.stringify(version),
      THREADNOTE_RUNTIME_SOURCE_IDENTITY: JSON.stringify(sourceIdentity ?? null),
    },
    bytecode: true,
    entrypoints: [path.join(root, 'apps', 'threadnote', 'src', 'standalone.ts')],
    format: 'esm',
    minify: true,
    sourcemap: 'linked',
    target: 'bun',
  });
  yield* assertRuntimeSourceIdentity(root, target, sourceIdentity).pipe(
    Effect.onError(() => fs.remove(executablePath, {force: true}).pipe(Effect.ignore)),
  );
  if (!Effect2.pipe(target, EffectString.includes('windows'))) {
    yield* fs.chmod(executablePath, 0o755);
  }

  yield* runBunBuild({
    entrypoints: [path.join(root, 'apps', 'threadnote', 'src', 'manager', 'browser.tsx')],
    format: 'iife',
    minify: true,
    naming: 'app.[ext]',
    outdir: path.join(outputRoot, 'manager'),
    target: 'browser',
  });

  yield* runBunBuild({
    entrypoints: [path.join(root, 'packages', 'manager', 'src', 'mermaid_frame.ts')],
    format: 'iife',
    minify: true,
    naming: 'mermaid.[ext]',
    outdir: path.join(outputRoot, 'manager'),
    target: 'browser',
  });

  yield* fs.rename(path.join(outputRoot, 'manager', 'app.css'), path.join(outputRoot, 'manager', 'style.css'));
  yield* fs.copyFile(
    path.join(root, 'packages', 'manager', 'static', 'app.css'),
    path.join(outputRoot, 'manager', 'app.css'),
  );

  const nativeRuntimeRoot = path.join(outputRoot, 'runtime');
  const typescriptNativeAsset = yield* stageTypeScriptNativeAsset(fs, path, root, outputRoot);
  if (Effect2.pipe(target, EffectString.includes('darwin'))) {
    yield* fs.makeDirectory(nativeRuntimeRoot, {recursive: true});
    const keychainLibrary = path.join(nativeRuntimeRoot, 'graph-keychain.dylib');
    const compilation = yield* Effect.sync(() =>
      Bun.spawnSync({
        cmd: [
          '/usr/bin/xcrun',
          'clang',
          '-fobjc-arc',
          '-O2',
          '-dynamiclib',
          '-fvisibility=hidden',
          '-framework',
          'Foundation',
          '-framework',
          'LocalAuthentication',
          '-framework',
          'Security',
          path.join(root, 'scripts', 'native', 'graph-keychain.m'),
          '-o',
          keychainLibrary,
        ],
        stderr: 'pipe',
        stdout: 'pipe',
      }),
    );
    if (compilation.exitCode !== 0)
      return yield* ScriptError.make({message: 'Could not compile the macOS graph Keychain library.'});
    yield* fs.chmod(keychainLibrary, 0o755);
  }
  const nativePackage = nativePackageForTarget(target);
  const nativePackageRoot = nativePackage
    ? path.join(root, 'node_modules', ...Effect2.pipe(nativePackage, EffectString.split('/')))
    : undefined;
  if (nativePackageRoot && !(yield* fs.exists(nativePackageRoot))) {
    return yield* ScriptError.make({
      message: `${nativePackage} is not installed on this target build host. Run bun install before building.`,
    });
  }
  yield* fs.makeDirectory(nativeRuntimeRoot, {recursive: true});
  yield* bundleNativeRuntime(
    path.join(root, 'node_modules', NATIVE_RUNTIME_PACKAGE, 'dist', 'index.js'),
    path.join(nativeRuntimeRoot, 'node-llama-cpp.js'),
    nativePackage,
    nativeRuntimeVersion,
  );
  yield* fs.remove(path.join(nativeRuntimeRoot, 'native'), {recursive: true, force: true});
  yield* fs.remove(path.join(outputRoot, 'llama', 'localBuilds'), {recursive: true, force: true});
  if (nativePackageRoot) {
    yield* fs.copy(path.join(nativePackageRoot, 'bins'), path.join(nativeRuntimeRoot, 'native'), {overwrite: true});
    yield* fs.copyFile(path.join(nativePackageRoot, 'LICENSE'), path.join(nativeRuntimeRoot, 'NATIVE-LICENSE'));
  } else {
    yield* fs.copyFile(
      path.join(root, 'node_modules', NATIVE_RUNTIME_PACKAGE, 'LICENSE'),
      path.join(nativeRuntimeRoot, 'NATIVE-LICENSE'),
    );
  }
  yield* fs.makeDirectory(path.join(outputRoot, 'llama'), {recursive: true});
  yield* fs.copyFile(
    path.join(root, 'node_modules', NATIVE_RUNTIME_PACKAGE, 'llama', 'binariesGithubRelease.json'),
    path.join(outputRoot, 'llama', 'binariesGithubRelease.json'),
  );
  yield* fs.writeFileString(
    path.join(outputRoot, 'release.json'),
    `${JSON.stringify(
      {
        codeGraphAssets: {
          manifest: 'assets/code-graph/manifest.json',
          version: 1,
        },
        codeSignature: Effect2.pipe(target, EffectString.includes('windows'))
          ? 'unsigned'
          : Effect2.pipe(target, EffectString.includes('darwin'))
            ? 'developer-id'
            : 'none',
        executable: executableName,
        devSkills: {digest: devSkills.digest, manifest: 'config/dev-skills.json', protocol: devSkills.workflowProtocol},
        nativeRuntime: `runtime/${NATIVE_RUNTIME_PACKAGE}.js`,
        ...(typescriptNativeAsset ? {typescriptNativeAsset} : {}),
        nativeRuntimePackage: nativePackage ?? 'portable-local-build',
        runtime: `bun-${Bun.version}`,
        target,
        sourceIdentity: sourceIdentity ?? null,
        version,
      },
      null,
      2,
    )}\n`,
  );
  yield* Console.log(`Built standalone Threadnote ${version} for ${target}: ${executablePath}`);
});

/** A release input is a verified derivative payload, never the old npm native binary. */
export const stageTypeScriptNativeAsset = Effect.fn('build.stageTypeScriptNativeAsset')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  outputRoot: string,
) {
  const staged = path.join(outputRoot, 'runtime', 'typescript');
  const assetRoot = Bun.env.THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR;
  if (!assetRoot) {
    if (yield* fs.exists(staged)) yield* fs.remove(staged, {recursive: true});
    return undefined;
  }
  // The release-output preflight owns source/output separation, including aliased staged paths; assembly owns
  // canonical paths and output freshness. Both receive the real paths resolved here.
  yield* Effect.tryPromise({
    try: () => assertNativeTypeScriptAssetOutsideReleaseOutput(assetRoot, root),
    catch: cause => ScriptError.make({message: 'Native TypeScript release input preflight failed.', cause}),
  });
  const sourceReal = yield* fs.realPath(path.resolve(assetRoot));
  const rootReal = yield* fs.realPath(root);
  if (yield* fs.exists(staged)) yield* fs.remove(staged, {recursive: true});
  yield* fs.makeDirectory(path.dirname(staged), {recursive: true});
  const stagedReal = path.join(yield* fs.realPath(path.dirname(staged)), path.basename(staged));
  const manifest = yield* Effect.tryPromise({
    try: () => stageReviewedNativeTypeScriptRuntimeAsset(sourceReal, stagedReal, rootReal),
    catch: cause => ScriptError.make({message: 'Could not stage the reviewed native TypeScript asset.', cause}),
  });
  return {
    manifest: 'runtime/typescript/manifest.json',
    sdk: 'runtime/typescript/sdk',
    frontend: 'runtime/typescript/frontend',
    sdkTreeDigest: manifest.frontend.derivedSdkTreeSha256,
    version: manifest.version,
    provenance: manifest.provenance.kind,
  };
});

function readPackageManifest(fs: FileSystem.FileSystem, path: string) {
  return fs.readFileString(path).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: (): unknown => JSON.parse(content),
        catch: cause => ScriptError.make({message: 'Could not parse package.json.', cause}),
      }).pipe(
        Effect.flatMap(value =>
          Schema.decodeUnknownEffect(PackageManifestSchema)(value).pipe(
            Effect.mapError(cause => ScriptError.make({message: 'Could not parse package.json.', cause})),
          ),
        ),
      ),
    ),
  );
}

const stageCodeGraphPackageAssets = Effect.fn('build.stageCodeGraphPackageAssets')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  outputRoot: string,
) {
  const manifestPath = path.join(root, 'assets', 'code-graph', 'manifest.json');
  const manifest = yield* fs.readFileString(manifestPath).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: cause => ScriptError.make({message: 'Could not parse the code graph asset manifest.', cause}),
      }),
    ),
  );
  if (!isRecord(manifest) || !isRecord(manifest.grammars)) {
    return yield* ScriptError.make({message: 'Code graph asset manifest does not declare grammars.'});
  }
  for (const [id, value] of EffectRecord.toEntries(manifest.grammars).sort(([left], [right]) =>
    Effect2.pipe(left, EffectString.localeCompare(right)),
  )) {
    if (!isRecord(value) || typeof value.path !== 'string') {
      return yield* ScriptError.make({message: `Code graph grammar metadata is invalid for ${id}.`});
    }
    const target = path.join(outputRoot, 'assets', 'code-graph', ...Effect2.pipe(value.path, EffectString.split('/')));
    if (!(yield* fs.exists(target))) {
      if (typeof value.packagePath !== 'string') {
        return yield* ScriptError.make({
          message: `Code graph grammar ${id} is not vendored and has no package source.`,
        });
      }
      const source = path.join(root, ...Effect2.pipe(value.packagePath, EffectString.split('/')));
      if (!(yield* fs.exists(source))) {
        return yield* ScriptError.make({
          message: `Code graph grammar package source is missing for ${id}: ${value.packagePath}`,
        });
      }
      yield* fs.makeDirectory(path.dirname(target), {recursive: true});
      yield* fs.copyFile(source, target);
    }
    if (typeof value.license === 'string') {
      const licenseTarget = path.join(
        outputRoot,
        'assets',
        'code-graph',
        ...Effect2.pipe(value.license, EffectString.split('/')),
      );
      if (!(yield* fs.exists(licenseTarget)) && typeof value.licensePackagePath === 'string') {
        const licenseSource = path.join(root, ...Effect2.pipe(value.licensePackagePath, EffectString.split('/')));
        if (!(yield* fs.exists(licenseSource))) {
          return yield* ScriptError.make({
            message: `Code graph grammar license package source is missing for ${id}: ${value.licensePackagePath}`,
          });
        }
        yield* fs.makeDirectory(path.dirname(licenseTarget), {recursive: true});
        yield* fs.copyFile(licenseSource, licenseTarget);
      }
    }
  }
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function bundleNativeRuntime(
  entrypoint: string,
  outfile: string,
  nativePackage: string | undefined,
  nativeRuntimeVersion: string,
) {
  return runBunBuild({
    entrypoints: [entrypoint],
    minify: true,
    naming: Effect2.pipe(outfile, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1),
    outdir: Effect2.pipe(outfile, EffectString.replace(/[\\/][^\\/]+$/, '')),
    plugins: [
      {
        name: 'threadnote-native-runtime',
        setup(builder) {
          builder.onResolve({filter: /getModuleVersion\.js$/}, () => ({
            namespace: 'threadnote-native-runtime-version',
            path: 'getModuleVersion',
          }));
          builder.onLoad({filter: /.*/, namespace: 'threadnote-native-runtime-version'}, () => ({
            contents: `export const getModuleVersion = async () => ${javascriptStringLiteral(nativeRuntimeVersion)};`,
            loader: 'js',
          }));
          builder.onResolve({filter: OPTIONAL_NATIVE_PACKAGE}, args => ({
            namespace: 'threadnote-native-runtime',
            path: args.path,
          }));
          builder.onLoad({filter: /.*/, namespace: 'threadnote-native-runtime'}, args => ({
            contents:
              args.path === nativePackage
                ? EffectArray.join(
                    [
                      `const binsDir = Bun.fileURLToPath(new URL('./native', import.meta.url));`,
                      `export const getBinsDir = () => ({binsDir, packageVersion: ${javascriptStringLiteral(nativeRuntimeVersion)}});`,
                    ],
                    '\n',
                  )
                : optionalNativePackageFallbackModule(),
            loader: 'js',
          }));
        },
      },
    ],
    target: 'bun',
  });
}

export const MUSL_NATIVE_SOURCE = {
  packageVersion: '3.22.2',
  repository: 'ggml-org/llama.cpp',
  tag: 'v0.7.0',
  commit: '1729d2ec2c4846df7754f4ce8f90f75f8a30ca3b',
  bundleSha256: '1717cc2867373a8962212f4beeff8431565393fe087b0d8cf96769cc11d4036e',
  upstreamPatchSha256: 'e5f4f94cf59e286992e14a967dd9b608b66096170fdf6f0ac4920efa61171b92',
} as const;

export function muslNativeArchitecture(target: string): 'x64' | 'arm64' | undefined {
  if (/^bun-linux-x64(?:-baseline)?-musl$/u.test(target)) return 'x64';
  if (/^bun-linux-(?:arm64|aarch64)-musl$/u.test(target)) return 'arm64';
  if (EffectString.endsWith('-musl')(target)) throw ScriptError.make({message: 'Unsupported musl native target.'});
  return undefined;
}

/** Only the pinned, explicitly musl source payload may report a local build in release smoke. */
export function expectedNativeRuntimeBuildType(release: unknown): 'localBuild' | 'prebuilt' {
  if (!isRecord(release) || typeof release.target !== 'string')
    throw ScriptError.make({message: 'Missing native release target.'});
  const architecture = muslNativeArchitecture(release.target);
  if (!architecture) return 'prebuilt';
  const source = release.nativeRuntimeSource;
  if (
    !isRecord(source) ||
    source.kind !== 'source-built' ||
    source.buildType !== 'localBuild' ||
    source.packageVersion !== MUSL_NATIVE_SOURCE.packageVersion ||
    source.repository !== MUSL_NATIVE_SOURCE.repository ||
    source.tag !== MUSL_NATIVE_SOURCE.tag ||
    source.commit !== MUSL_NATIVE_SOURCE.commit ||
    source.bundleSha256 !== MUSL_NATIVE_SOURCE.bundleSha256 ||
    source.upstreamPatchSha256 !== MUSL_NATIVE_SOURCE.upstreamPatchSha256 ||
    !isRecord(source.sourceTree) ||
    !/^[a-f0-9]{40}$/u.test(String(source.sourceTree.tree)) ||
    (source.sourceTree.disposition !== 'bundled-base' && source.sourceTree.disposition !== 'packaged-PR22566') ||
    source.architecture !== architecture ||
    source.libc !== 'musl' ||
    !isRecord(source.files) ||
    !/^[a-f0-9]{64}$/u.test(String(source.files['llama-addon.node'])) ||
    !/^[a-f0-9]{64}$/u.test(String(source.files['_nlcBuildMetadata.json'])) ||
    'nativeRuntimePackage' in release
  )
    throw ScriptError.make({message: 'Missing or incompatible musl source-built release provenance.'});
  return 'localBuild';
}

export function validateMuslBuildMetadata(value: unknown, architecture: 'x64' | 'arm64'): void {
  if (!isRecord(value) || !isRecord(value.buildOptions))
    throw ScriptError.make({message: 'Missing musl build metadata.'});
  const options = value.buildOptions;
  if (
    options.platform !== 'linux' ||
    options.arch !== architecture ||
    options.gpu !== false ||
    !isRecord(options.llamaCpp) ||
    options.llamaCpp.repo !== MUSL_NATIVE_SOURCE.repository ||
    options.llamaCpp.release !== MUSL_NATIVE_SOURCE.tag ||
    !isRecord(options.customCmakeOptions) ||
    EffectRecord.keys(options.customCmakeOptions).length !== 0
  ) {
    throw ScriptError.make({message: 'Musl build metadata differs from the pinned CPU/source basis.'});
  }
}

export function validateMuslCmakeCache(cache: string): void {
  if (!/^CMAKE_GENERATOR:INTERNAL=Unix Makefiles\r?$/mu.test(cache))
    throw ScriptError.make({message: 'Musl artifact membership requires the current Makefiles build manifest.'});
  for (const [key, value] of [
    ['GGML_NATIVE', 'OFF'],
    ['GGML_CPU_ALL_VARIANTS', 'ON'],
    ['GGML_BACKEND_DL', 'ON'],
    ['GGML_OPENMP', 'OFF'],
  ]) {
    if (!new RegExp(`^${key}:[A-Z_]+=${value}\\r?$`, 'mu').test(cache))
      throw ScriptError.make({message: `Musl portable build option is missing: ${key}=${value}.`});
  }
}

/** readelf is an explicit CI build prerequisite, never a runtime dependency. */
export function validateMuslElfReport(
  report: string,
  architecture: 'x64' | 'arm64',
  files: readonly string[],
  member?: {readonly name: string; readonly bytes: number},
): readonly string[] {
  const reject = (
    message: string,
    check: 'size' | 'class' | 'data' | 'machine' | 'glibc' | 'needed' | 'search-path',
  ) => {
    // Evidence only: never emit report text, external paths or unadmitted member names.
    const bounded = report.length <= 262144 ? report : '';
    const names = (expression: RegExp, searchPath = false) => {
      const values: string[] = [];
      for (const match of EffectString.matchAll(expression)(bounded)) {
        if (values.length === 8) break;
        const value = match[1];
        values.push(
          searchPath
            ? value === '$ORIGIN'
              ? value
              : 'external'
            : /^[A-Za-z0-9_.+-]{1,64}$/u.test(value)
              ? value
              : 'unrecognized',
        );
      }
      return values;
    };
    const admittedMember =
      member &&
      EffectArray.contains(files, member.name) &&
      /^(?:llama-addon\.node|lib[A-Za-z0-9_.+-]+\.so(?:\.[0-9]+)*)$/u.test(member.name) &&
      member.name.length <= 96;
    const diagnostic = {
      check,
      architecture,
      member: admittedMember ? member.name : 'unavailable',
      memberBytes:
        admittedMember && Number.isSafeInteger(member.bytes) && member.bytes >= 0 && member.bytes <= 256 * 1024 * 1024
          ? member.bytes
          : null,
      reportCharacters: report.length,
      reportBytes: report.length <= 262144 ? Buffer.byteLength(report, 'utf8') : null,
      class: /Class:\s+ELF64/u.test(bounded) ? 'ELF64' : /Class:\s+ELF32/u.test(bounded) ? 'ELF32' : 'unrecognized',
      data: /Data:\s+2's complement, little endian/u.test(bounded)
        ? 'little-endian'
        : /Data:\s+2's complement, big endian/u.test(bounded)
          ? 'big-endian'
          : 'unrecognized',
      machine: /Machine:\s+Advanced Micro Devices X86-64/u.test(bounded)
        ? 'x64'
        : /Machine:\s+AArch64/u.test(bounded)
          ? 'arm64'
          : 'unrecognized',
      needed: names(/\(NEEDED\)[^\n]*\[([^\]]+)\]/gu),
      rpath: names(/\(RPATH\)[^\n]*\[([^\]]+)\]/gu, true),
      runpath: names(/\(RUNPATH\)[^\n]*\[([^\]]+)\]/gu, true),
      forbidden: EffectArray.filter(['GLIBC_', 'ld-linux', 'libc.so.6'], token =>
        EffectString.includes(token)(bounded),
      ),
    };
    throw ScriptError.make({message: `${message} ${JSON.stringify(diagnostic)}`});
  };
  if (report.length > 262144) reject('Incompatible musl ELF payload.', 'size');
  if (!/Class:\s+ELF64/u.test(report)) reject('Incompatible musl ELF payload.', 'class');
  if (!/Data:\s+2's complement, little endian/u.test(report)) reject('Incompatible musl ELF payload.', 'data');
  if (!(architecture === 'x64' ? /Machine:\s+Advanced Micro Devices X86-64/u : /Machine:\s+AArch64/u).test(report))
    reject('Incompatible musl ELF payload.', 'machine');
  if (/GLIBC_|ld-linux|libc\.so\.6/u.test(report)) reject('Incompatible musl ELF payload.', 'glibc');
  const needed = EffectArray.map(
    [...EffectString.matchAll(/\(NEEDED\)[^\n]*\[([^\]]+)\]/gu)(report)],
    match => match[1],
  );
  for (const dependency of needed) {
    if (
      !EffectArray.contains(files, dependency) &&
      !new RegExp(
        `^(?:libstdc\\+\\+\\.so\\.6|libgcc_s\\.so\\.1|libc\\.musl-${architecture === 'x64' ? 'x86_64' : 'aarch64'}\\.so\\.1)$`,
        'u',
      ).test(dependency)
    )
      reject('Musl ELF dependency is outside the staged/declared system closure.', 'needed');
  }
  for (const match of EffectString.matchAll(/\((?:RPATH|RUNPATH)\)[^\n]*\[([^\]]+)\]/gu)(report))
    if (EffectArray.some(EffectString.split(':')(match[1]), entry => entry !== '$ORIGIN'))
      reject('Musl ELF contains an external runtime search path.', 'search-path');
  return needed;
}

/** Exact current CMake link outputs, independent of the Release directory being admitted. */
export function muslLinkedArtifact(command: string): {output: string; name: string} | undefined {
  if (command.length > 262144) throw ScriptError.make({message: 'Oversized CMake link command.'});
  const outputs = [...EffectString.matchAll(/(?:^|\s)-o\s+([^\s]+)/gu)(command)];
  if (outputs.length === 0) return undefined; // Static archives and utility targets have no dynamic link output.
  if (outputs.length !== 1 || !/^[A-Za-z0-9_./+-]+$/u.test(outputs[0][1]))
    throw ScriptError.make({message: 'Ambiguous CMake link output.'});
  const output = outputs[0][1],
    name = EffectString.split('/')(output).at(-1)!;
  return name === 'llama-addon.node' || /^lib[A-Za-z0-9_.+-]+\.so(?:\.[0-9]+)*$/u.test(name)
    ? {output, name}
    : undefined;
}
export function validateMuslBuildInventory(actual: readonly string[], linked: readonly string[]): void {
  const expected = ['_nlcBuildMetadata.json', ...linked].sort();
  if (
    !EffectArray.contains(linked, 'llama-addon.node') ||
    linked.length !== new Set(linked).size ||
    JSON.stringify([...actual].sort()) !== JSON.stringify(expected)
  )
    throw ScriptError.make({message: 'Musl Release inventory differs from the current CMake dynamic targets.'});
}

const muslBuildCommand = (args: readonly string[], environment?: NodeJS.ProcessEnv) =>
  Effect.try({
    try: () => {
      const result = Bun.spawnSync({cmd: [...args], env: environment, stdout: 'pipe', stderr: 'pipe'});
      if (result.exitCode !== 0 || result.stdout.byteLength > 262144 || result.stderr.byteLength > 262144)
        throw ScriptError.make({message: 'Musl source/ELF build verification failed.'});
      return new TextDecoder('utf-8', {fatal: true}).decode(result.stdout);
    },
    catch: cause => ScriptError.make({message: 'Could not verify musl source/ELF closure.', cause}),
  });

/** A separate index derives the one permitted patched tree; the original index/HEAD/source are read only. */
export const verifyMuslTrackedSource = Effect.fn('build.verifyMuslTrackedSource')(
  (source: string, patch: string, commit: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        if (
          !/^[a-f0-9]{40}$/u.test(commit) ||
          (yield* fs.realPath(source)) !== source ||
          (yield* fs.realPath(path.join(source, '.git'))) !== path.join(source, '.git') ||
          (yield* fs.stat(path.join(source, '.git'))).type !== 'Directory'
        )
          return yield* ScriptError.make({message: 'Invalid musl source checkout.'});
        const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-musl-source-index-'});
        const environment = {
          ...process.env,
          GIT_INDEX_FILE: path.join(temporary, 'index'),
          GIT_OPTIONAL_LOCKS: '0',
          GIT_CONFIG_GLOBAL: path.join(temporary, 'absent-global-config'),
          GIT_CONFIG_NOSYSTEM: '1',
        };
        const git = (args: readonly string[]) =>
          muslBuildCommand(
            ['git', '-C', source, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${temporary}`, ...args],
            environment,
          );
        if (EffectString.trim(yield* git(['rev-parse', 'HEAD'])) !== commit)
          return yield* ScriptError.make({message: 'Musl source is not the bundled commit.'});
        yield* git(['read-tree', commit]);
        if ((yield* git(['ls-files', '--others', '--exclude-standard'])).length !== 0)
          return yield* ScriptError.make({message: 'Musl source has unowned untracked files.'});
        const changes = yield* git(['diff-files', '--patch', '--no-ext-diff', '--no-textconv']);
        let disposition: 'bundled-base' | 'packaged-PR22566' = 'bundled-base';
        if (changes.length !== 0) {
          yield* git(['apply', '--cached', '--whitespace=nowarn', patch]);
          disposition = 'packaged-PR22566';
        }
        const tree = EffectString.trim(yield* git(['write-tree']));
        yield* git(['diff', '--exit-code', '--no-ext-diff', '--no-textconv', tree, '--']);
        if (EffectString.trim(yield* git(['rev-parse', 'HEAD'])) !== commit)
          return yield* ScriptError.make({message: 'Musl source commit changed during verification.'});
        return {tree, disposition};
      }),
    ),
);

function isCompileTarget(value: string): value is Bun.Build.CompileTarget {
  return /^bun-(?:darwin-(?:x64|arm64|aarch64)(?:-(?:baseline|modern))?|linux-(?:x64|arm64|aarch64)(?:-(?:glibc|musl)|-(?:baseline|modern)(?:-(?:glibc|musl))?)?|windows-(?:x64(?:-(?:baseline|modern))?|arm64|aarch64))$/u.test(
    value,
  );
}

function buildTarget(): Bun.Build.CompileTarget {
  const configured = Effect2.pipe(Bun.env.THREADNOTE_BUILD_TARGET, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (configured !== undefined) {
    if (!isCompileTarget(configured)) {
      throw ScriptError.make({message: `Unsupported Bun compile target: ${configured}.`});
    }
    return configured;
  }
  const inferred = nativeVectorReaderHostProfile({platform: process.platform, architecture: process.arch});
  if (!isCompileTarget(inferred)) {
    throw ScriptError.make({message: `Unsupported Bun compile target for this host: ${inferred}.`});
  }
  return inferred;
}

function assertNativeTargetMatchesHost(target: Bun.Build.CompileTarget): void {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const architecture = process.arch === 'arm64' ? '(?:arm64|aarch64)' : process.arch;
  const matchesHost = new RegExp(`^bun-${platform}-${architecture}(?:-|$)`).test(target);
  if (!matchesHost) {
    throw ScriptError.make({
      message:
        `Target ${target} does not match this ${platform}-${process.arch} build host. ` +
        'Native local-AI payloads must be assembled on their target OS and architecture.',
    });
  }
}

function nativePackageForTarget(target: Bun.Build.CompileTarget): string | undefined {
  if (EffectString.endsWith('-musl')(target)) return undefined;
  if (
    Effect2.pipe(target, EffectString.startsWith('bun-darwin-arm64')) ||
    Effect2.pipe(target, EffectString.startsWith('bun-darwin-aarch64'))
  ) {
    return '@node-llama-cpp/mac-arm64-metal';
  }
  if (Effect2.pipe(target, EffectString.startsWith('bun-darwin-x64'))) {
    return '@node-llama-cpp/mac-x64';
  }
  if (
    Effect2.pipe(target, EffectString.startsWith('bun-linux-arm64')) ||
    Effect2.pipe(target, EffectString.startsWith('bun-linux-aarch64'))
  ) {
    return '@node-llama-cpp/linux-arm64';
  }
  if (Effect2.pipe(target, EffectString.startsWith('bun-linux-x64'))) {
    return '@node-llama-cpp/linux-x64';
  }
  if (
    Effect2.pipe(target, EffectString.startsWith('bun-windows-arm64')) ||
    Effect2.pipe(target, EffectString.startsWith('bun-windows-aarch64'))
  ) {
    return '@node-llama-cpp/win-arm64';
  }
  if (Effect2.pipe(target, EffectString.startsWith('bun-windows-x64'))) {
    return '@node-llama-cpp/win-x64';
  }
  throw ScriptError.make({message: `No prebuilt native local-AI package is mapped for ${target}.`});
}

interface DevSkillMember {
  readonly id: string;
  readonly role: 'primary' | 'support';
  readonly files: readonly string[];
}

/** A single portable relative payload path, never a destination supplied by a caller. */
export function validDevSkillPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_./-]+$/u.test(value) &&
    EffectArray.every(
      Effect2.pipe(value, EffectString.split('/')),
      part =>
        part !== '' &&
        !Effect2.pipe(part, EffectString.endsWith('.')) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    ) &&
    !EffectArray.some(Effect2.pipe(value, EffectString.split('/')), part =>
      ['__pycache__', '.DS_Store', '.context', '.git'].includes(part),
    ) &&
    !Effect2.pipe(value, EffectString.endsWith('.pyc'))
  );
}

/** Validate the exact release closure and bind its content to this runtime release. */
export const buildDevSkillsManifest = Effect.fn('build.devSkillsManifest')(function* (root: string, version: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalRoot = yield* fs.realPath(root);
  const manifestPath = path.join(canonicalRoot, 'config', 'dev-skills.json');
  if ((yield* fs.realPath(manifestPath)) !== manifestPath) {
    return yield* ScriptError.make({message: 'Development bundle manifest symlinks are forbidden.'});
  }
  const value: unknown = yield* fs.readFileString(manifestPath).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => {
          const parsed: unknown = JSON.parse(content);
          parseDevSkillsInventory(parsed);
          return parsed;
        },
        catch: cause => ScriptError.make({message: 'Invalid development workflow manifest.', cause}),
      }),
    ),
  );
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.workflowProtocol !== 1 ||
    value.stateSchema !== 1 ||
    typeof value.minimumRuntime !== 'string' ||
    !EXACT_PACKAGE_VERSION.test(value.minimumRuntime) ||
    !EffectArray.isArray(value.skills)
  ) {
    return yield* ScriptError.make({message: 'Unsupported development workflow manifest contract.'});
  }
  const members: DevSkillMember[] = [];
  for (const skill of value.skills) {
    if (
      !isRecord(skill) ||
      typeof skill.id !== 'string' ||
      !/^[a-z][a-z-]+$/u.test(skill.id) ||
      (skill.role !== 'primary' && skill.role !== 'support') ||
      !EffectArray.isArray(skill.files) ||
      !EffectArray.every(skill.files, validDevSkillPath) ||
      new Set(EffectArray.map(skill.files, file => Effect2.pipe(file, EffectString.toLowerCase))).size !==
        skill.files.length ||
      !skill.files.includes('SKILL.md')
    ) {
      return yield* ScriptError.make({message: 'Invalid development skill member or escaping payload path.'});
    }
    members.push({id: skill.id, role: skill.role, files: [...skill.files].sort()});
  }
  members.sort((left, right) => Effect2.pipe(left.id, EffectString.localeCompare(right.id)));
  if (
    EffectArray.join(
      EffectArray.map(members, member => member.id),
      ',',
    ) !== 'dev-cycle,dev-plan,dev-spec,watch-pr' ||
    EffectArray.some(members, member => member.role !== (member.id === 'watch-pr' ? 'support' : 'primary'))
  ) {
    return yield* ScriptError.make({
      message: 'The development bundle must contain all three workflows and watch-pr exactly once.',
    });
  }
  const files: Record<string, string> = {};
  for (const member of members) {
    const directory = path.join(canonicalRoot, 'config', 'agent-skills', member.id);
    const pending = [''];
    const discovered: string[] = [];
    while (pending.length > 0) {
      const relative = pending.pop()!;
      const absolute = path.join(directory, relative);
      if ((yield* fs.realPath(absolute)) !== absolute) {
        return yield* ScriptError.make({
          message: `Development bundle symlinks are forbidden: ${member.id}/${relative}`,
        });
      }
      const stat = yield* fs.stat(absolute);
      if (stat.type === 'Directory') {
        for (const child of yield* fs.readDirectory(absolute)) pending.push(relative ? `${relative}/${child}` : child);
      } else if (stat.type === 'File' && validDevSkillPath(relative)) {
        discovered.push(relative);
      } else {
        return yield* ScriptError.make({message: `Invalid development bundle file: ${member.id}/${relative}`});
      }
    }
    if (JSON.stringify(discovered.sort()) !== JSON.stringify(member.files)) {
      return yield* ScriptError.make({message: `Development bundle file inventory differs: ${member.id}`});
    }
    for (const relative of member.files) {
      files[`${member.id}/${relative}`] = yield* sha256Hex(yield* fs.readFile(path.join(directory, relative)));
    }
  }
  const manifest = {
    schemaVersion: 2 as const,
    nativeRequirements: parseNativeRequirements(value.nativeRequirements),
    workflowProtocol: 1 as const,
    stateSchema: 1 as const,
    minimumRuntime: value.minimumRuntime,
    releaseVersion: version,
    prerequisites: {commands: ['threadnote', 'git', 'rg'], prCommands: ['gh']},
    skills: members,
    hashes: files,
  };
  return parseDevSkillsManifest({...manifest, digest: yield* sha256Hex(JSON.stringify(manifest))});
});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(build, BunServices.layer));
