import {Array as EffectArray} from 'effect';
import {
  parseNativeRequirements,
  parseDevSkillsManifest,
  parseDevSkillsInventory,
} from '@threadnote/threadnote/dev_skills/manifest';
import {integrationStaticFiles} from '@threadnote/threadnote/manager/static-files';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {runBunBuild} from './effect/bun-build.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {javascriptStringLiteral, optionalNativePackageFallbackModule} from './effect/javascript.js';
import {isDevelopmentBuildVersion} from './development-runtime.js';
import {sha256Hex} from '@threadnote/platform/digest';
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
  const nativePackageRoot = path.join(root, 'node_modules', ...Effect2.pipe(nativePackage, EffectString.split('/')));
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
        codeSignature: Effect2.pipe(target, EffectString.includes('windows'))
          ? 'unsigned'
          : Effect2.pipe(target, EffectString.includes('darwin'))
            ? 'developer-id'
            : 'none',
        executable: executableName,
        devSkills: {digest: devSkills.digest, manifest: 'config/dev-skills.json', protocol: devSkills.workflowProtocol},
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

function bundleNativeRuntime(entrypoint: string, outfile: string, nativePackage: string, nativeRuntimeVersion: string) {
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
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const inferred = `bun-${platform}-${process.arch}`;
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

function nativePackageForTarget(target: Bun.Build.CompileTarget): string {
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
