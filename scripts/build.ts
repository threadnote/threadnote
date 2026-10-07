import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {runBunBuild} from './effect/bun-build.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path} from 'effect';
import {javascriptStringLiteral, optionalNativePackageFallbackModule} from './effect/javascript.js';
import {isDevelopmentBuildVersion} from './development-runtime.js';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
  readonly version?: string;
}

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
  const manifest = yield* readPackageManifest(fs, path.join(root, 'package.json'));
  if (manifest.packageManager !== `bun@${Bun.version}`) {
    return yield* ScriptError.make({
      message: `Standalone builds require ${manifest.packageManager ?? 'an exact Bun packageManager pin'}; running bun@${Bun.version}.`,
    });
  }
  const configuredDevelopmentVersion = Bun.env.THREADNOTE_DEVELOPMENT_BUILD_VERSION?.trim();
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
  const executableName = target.includes('windows') ? 'threadnote.exe' : 'threadnote';
  const executablePath = path.join(outputRoot, executableName);

  yield* fs.makeDirectory(outputRoot, {recursive: true});
  for (const directory of FORBIDDEN_RELEASE_DIRECTORIES) {
    const releasePath = path.join(outputRoot, directory);
    if (yield* fs.exists(releasePath)) {
      yield* fs.remove(releasePath, {recursive: true});
    }
  }
  for (const directory of RELEASE_DIRECTORIES) {
    yield* fs.copy(path.join(root, directory), path.join(outputRoot, directory), {overwrite: true});
  }
  yield* fs.copy(path.join(root, 'packages', 'manager', 'static'), path.join(outputRoot, 'manager'), {
    overwrite: true,
  });
  yield* fs.copy(
    path.join(root, 'packages', 'remote-memory', 'src', 'migrations'),
    path.join(outputRoot, REMOTE_MEMORY_MIGRATION_DIRECTORY),
    {overwrite: true},
  );
  yield* stageCodeGraphPackageAssets(fs, path, root, outputRoot);
  for (const file of RELEASE_FILES) {
    yield* fs.copyFile(path.join(root, file), path.join(outputRoot, file));
  }

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
    },
    bytecode: true,
    entrypoints: [path.join(root, 'apps', 'threadnote', 'src', 'standalone.ts')],
    format: 'esm',
    minify: true,
    sourcemap: 'linked',
    target: 'bun',
  });
  if (!target.includes('windows')) {
    yield* fs.chmod(executablePath, 0o755);
  }

  yield* runBunBuild({
    entrypoints: [path.join(root, 'packages', 'manager', 'src', 'ui.tsx')],
    format: 'iife',
    minify: true,
    naming: 'app.[ext]',
    outdir: path.join(outputRoot, 'manager'),
    target: 'browser',
  });

  // Bun emits imported editor styles alongside the UI entry. Keep app styles last in the cascade.
  yield* fs.rename(path.join(outputRoot, 'manager', 'app.css'), path.join(outputRoot, 'manager', 'style.css'));
  yield* fs.copyFile(
    path.join(root, 'packages', 'manager', 'static', 'app.css'),
    path.join(outputRoot, 'manager', 'app.css'),
  );

  const nativeRuntimeRoot = path.join(outputRoot, 'runtime');
  if (target.includes('darwin')) {
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
  const nativePackageRoot = path.join(root, 'node_modules', ...nativePackage.split('/'));
  if (!(yield* fs.exists(nativePackageRoot))) {
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
  yield* fs.copy(path.join(nativePackageRoot, 'bins'), path.join(nativeRuntimeRoot, 'native'), {overwrite: true});
  yield* fs.copyFile(path.join(nativePackageRoot, 'LICENSE'), path.join(nativeRuntimeRoot, 'NATIVE-LICENSE'));
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
        codeSignature: target.includes('windows') ? 'unsigned' : target.includes('darwin') ? 'developer-id' : 'none',
        executable: executableName,
        nativeRuntime: `runtime/${NATIVE_RUNTIME_PACKAGE}.js`,
        nativeRuntimePackage: nativePackage,
        runtime: `bun-${Bun.version}`,
        target,
        version,
      },
      null,
      2,
    )}\n`,
  );
  yield* Console.log(`Built standalone Threadnote ${version} for ${target}: ${executablePath}`);
});

function readPackageManifest(fs: FileSystem.FileSystem, path: string) {
  return fs.readFileString(path).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as PackageManifest,
        catch: cause => ScriptError.make({message: 'Could not parse package.json.', cause}),
      }),
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
  for (const [id, value] of Object.entries(manifest.grammars).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isRecord(value) || typeof value.path !== 'string') {
      return yield* ScriptError.make({message: `Code graph grammar metadata is invalid for ${id}.`});
    }
    const target = path.join(outputRoot, 'assets', 'code-graph', ...value.path.split('/'));
    if (!(yield* fs.exists(target))) {
      if (typeof value.packagePath !== 'string') {
        return yield* ScriptError.make({
          message: `Code graph grammar ${id} is not vendored and has no package source.`,
        });
      }
      const source = path.join(root, ...value.packagePath.split('/'));
      if (!(yield* fs.exists(source))) {
        return yield* ScriptError.make({
          message: `Code graph grammar package source is missing for ${id}: ${value.packagePath}`,
        });
      }
      yield* fs.makeDirectory(path.dirname(target), {recursive: true});
      yield* fs.copyFile(source, target);
    }
    if (typeof value.license === 'string') {
      const licenseTarget = path.join(outputRoot, 'assets', 'code-graph', ...value.license.split('/'));
      if (!(yield* fs.exists(licenseTarget)) && typeof value.licensePackagePath === 'string') {
        const licenseSource = path.join(root, ...value.licensePackagePath.split('/'));
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bundleNativeRuntime(entrypoint: string, outfile: string, nativePackage: string, nativeRuntimeVersion: string) {
  return runBunBuild({
    entrypoints: [entrypoint],
    minify: true,
    naming: outfile.replaceAll('\\', '/').split('/').at(-1),
    outdir: outfile.replace(/[\\/][^\\/]+$/, ''),
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
                ? [
                    `const binsDir = Bun.fileURLToPath(new URL('./native', import.meta.url));`,
                    `export const getBinsDir = () => ({binsDir, packageVersion: ${javascriptStringLiteral(nativeRuntimeVersion)}});`,
                  ].join('\n')
                : optionalNativePackageFallbackModule(),
            loader: 'js',
          }));
        },
      },
    ],
    target: 'bun',
  });
}

function buildTarget(): Bun.Build.CompileTarget {
  const configured = Bun.env.THREADNOTE_BUILD_TARGET?.trim();
  if (configured) {
    return configured as Bun.Build.CompileTarget;
  }
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `bun-${platform}-${process.arch}` as Bun.Build.CompileTarget;
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

function nativePackageForTarget(target: Bun.Build.CompileTarget): string {
  if (target.startsWith('bun-darwin-arm64') || target.startsWith('bun-darwin-aarch64')) {
    return '@node-llama-cpp/mac-arm64-metal';
  }
  if (target.startsWith('bun-darwin-x64')) {
    return '@node-llama-cpp/mac-x64';
  }
  if (target.startsWith('bun-linux-arm64') || target.startsWith('bun-linux-aarch64')) {
    return '@node-llama-cpp/linux-arm64';
  }
  if (target.startsWith('bun-linux-x64')) {
    return '@node-llama-cpp/linux-x64';
  }
  if (target.startsWith('bun-windows-arm64') || target.startsWith('bun-windows-aarch64')) {
    return '@node-llama-cpp/win-arm64';
  }
  if (target.startsWith('bun-windows-x64')) {
    return '@node-llama-cpp/win-x64';
  }
  throw ScriptError.make({message: `No prebuilt native local-AI package is mapped for ${target}.`});
}

BunRuntime.runMain(provideScriptLayer(build, BunServices.layer));
