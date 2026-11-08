import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Deferred, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {parse as parseToml} from 'smol-toml';
import {CommandExecutor} from '@threadnote/platform/command';
import {runtimePlatform, runtimeNativePlatformTarget, platformPathFor} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {LspFault, type LspClient} from '../lsp_transport.js';
import {boundedFileDigest, readBounded} from '../fingerprint.js';
import {makeLspSession, type LspSessionOptions} from '../provider.js';
import {isJsonObject} from '@threadnote/platform/json';
export const rustProviderVersion = '0.3.3097-standalone (0c4d74686b 2026-10-22)';
export const rustExecutableDigest = '29e8a7d408e7d6936c6d762f2982820812578d7f97a3f5013789de6fc8a711d4';
export const rustToolDigest = '1ba7bb8e273bd64125f4048d2ecce530e0a6470e565ab1b3aecf0b82b532f7b1';
export const cargoToolDigest = '6d576d8058f8ca643e8fce55b64ee3c614ba64c9da2e536bae843e6a2e1f3951';
// Only reviewed shipped bytes can enter this allowlist; ledger rows cannot grant execution.
const rustRuntimePins = Object.freeze({
  provider: 'rust-analyzer' as const,
  providerExecutableDigest: rustExecutableDigest,
  rustcExecutableDigest: rustToolDigest,
  cargoExecutableDigest: cargoToolDigest,
  sdkTreeDigest: undefined as string | undefined,
});
export function rustRuntimePinsForHost() {
  return runtimeNativePlatformTarget() === 'darwin-arm64' ? rustRuntimePins : undefined;
}
const fail = () => LspFault.make({code: 'prerequisite'});
const staticPath = (value: string) =>
  value.length > 0 &&
  value.length <= 8192 &&
  !/[\p{Cc}$]/u.test(value) &&
  !EffectString.startsWith('~')(value) &&
  (runtimePlatform === 'win32'
    ? !EffectString.includes(':')(EffectString.replace(/^[a-z]:[\\/]/iu, '')(value)) &&
      !EffectString.startsWith('\\\\')(value)
    : !/[:\\]/u.test(value));
const record = (value: unknown): Record<string, unknown> => (isJsonObject(value) ? value : {});
export const rustToolPath = (
  sdk: string,
  tool: 'cargo' | 'rustc' | 'rustdoc',
  platform: NodeJS.Platform = runtimePlatform,
) => platformPathFor(platform).join(sdk, 'bin', tool + (platform === 'win32' ? '.exe' : ''));
export const rustEnvironment = (
  sdk: string,
  directory: string,
  platform: NodeJS.Platform = runtimePlatform,
): Record<string, string> => {
  const path = platformPathFor(platform);
  return {
    PATH: path.join(sdk, 'bin') + (platform === 'win32' ? '' : ':/usr/bin:/bin'),
    HOME: path.join(directory, 'home'),
    CARGO_HOME: path.join(directory, 'cargo'),
    CARGO: rustToolPath(sdk, 'cargo', platform),
    RUSTC: rustToolPath(sdk, 'rustc', platform),
    RUSTDOC: rustToolPath(sdk, 'rustdoc', platform),
    RUSTUP_TOOLCHAIN: sdk,
    RUSTUP_AUTO_INSTALL: '0',
    CARGO_NET_OFFLINE: 'true',
    CARGO_TARGET_DIR: path.join(directory, 'target'),
    CARGO_BUILD_BUILD_DIR: path.join(directory, 'build'),
    CARGO_CACHE_RUSTC_INFO: '0',
    RUSTC_WRAPPER: '',
    RUSTC_WORKSPACE_WRAPPER: '',
    CARGO_BUILD_RUSTC_WRAPPER: '',
    CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: '',
    RUSTFLAGS: '',
    CARGO_ENCODED_RUSTFLAGS: '',
    XDG_CACHE_HOME: path.join(directory, 'cache'),
    XDG_CONFIG_HOME: path.join(directory, 'config'),
    TMPDIR: path.join(directory, 'tmp'),
    ...(platform === 'win32'
      ? {TEMP: path.join(directory, 'tmp'), TMP: path.join(directory, 'tmp'), USERPROFILE: path.join(directory, 'home')}
      : {}),
  };
};
export const makeRustProject = Effect.fn('semantic.makeRustProject')(function* (options: {
  readonly project: string;
  readonly worktree: string;
  readonly sdk: string;
  readonly privateDirectory: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const command = yield* CommandExecutor;
  const inside = (file: string) =>
    file === options.worktree || EffectString.startsWith(options.worktree + path.sep)(file);
  const canonical = (file: string) =>
    Effect.gen(function* () {
      if (!inside(file) || EffectString.split(path.sep)(file).includes('.git') || (yield* fs.realPath(file)) !== file)
        return yield* fail();
      return file;
    });
  // Cargo reads ancestor config even when an explicit manifest is supplied. Reject before any tool probe.
  const configAncestry = (directory: string) =>
    Effect.gen(function* () {
      let current = directory;
      while (true) {
        for (const name of [
          '.cargo/config',
          '.cargo/config.toml',
          'rust-analyzer.toml',
          '.rust-analyzer.toml',
          'rust-toolchain',
          'rust-toolchain.toml',
        ])
          if (yield* fs.exists(path.join(current, name))) return yield* fail();
        const parent = path.dirname(current);
        if (current === parent) return;
        current = parent;
      }
    });
  yield* configAncestry(options.project);
  const candidates: string[] = [];
  const walk = [options.worktree];
  let count = 0;
  while (walk.length) {
    const directory = walk.pop()!;
    for (const name of yield* fs.readDirectory(directory)) {
      if (name === '.git') continue;
      if (++count > 20000) return yield* LspFault.make({code: 'capacity'});
      const file = path.join(directory, name);
      yield* canonical(file);
      const info = yield* fs.stat(file);
      if (info.type === 'Directory') walk.push(file);
      else if (name === 'Cargo.toml') candidates.push(file);
    }
  }
  const manifests = new Map<string, string>();
  const pending = [path.join(options.project, 'Cargo.toml')];
  const addPath = (directory: string, value: unknown, manifest: boolean) =>
    Effect.gen(function* () {
      if (typeof value !== 'string' || !staticPath(value)) return yield* fail();
      const target = yield* canonical(path.resolve(directory, value));
      if (manifest) pending.push(path.join(target, 'Cargo.toml'));
    });
  const dependencies = (directory: string, value: unknown) =>
    Effect.gen(function* () {
      for (const dependency of EffectRecord.values(record(value))) {
        const item = record(dependency);
        if (item.path !== undefined) yield* addPath(directory, item.path, true);
      }
    });
  while (pending.length) {
    const file = pending.pop()!;
    if (manifests.has(file)) continue;
    if (manifests.size >= 128) return yield* LspFault.make({code: 'capacity'});
    yield* canonical(file);
    const directory = path.dirname(file);
    yield* configAncestry(directory);
    const bytes = yield* readBounded(file, 1024 * 1024);
    const text = yield* Effect.try({try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes), catch: fail});
    const raw = yield* Effect.try({try: () => parseToml(text), catch: fail});
    manifests.set(file, sha256HexSync(bytes));
    const workspace = record(raw.workspace);
    const pkg = record(raw.package);
    if (pkg.workspace !== undefined) yield* addPath(directory, pkg.workspace, true);
    if (typeof pkg.build === 'string') yield* addPath(directory, pkg.build, false);
    for (const member of EffectArray.isArray(workspace.members) ? workspace.members : []) {
      if (typeof member !== 'string' || !staticPath(member)) return yield* fail();
      if (!/[?*[]/u.test(member)) yield* addPath(directory, member, true);
      else {
        if (path.isAbsolute(member) || EffectString.split(/[\\/]/u)(member).includes('..')) return yield* fail();
        const glob = new Bun.Glob(member + '/Cargo.toml');
        for (const candidate of candidates)
          if (
            EffectString.startsWith(directory + path.sep)(candidate) &&
            glob.match(EffectString.replaceAll('\\', '/')(path.relative(directory, candidate)))
          )
            pending.push(candidate);
      }
    }
    for (const group of [raw, workspace, ...EffectArray.map(EffectRecord.values(record(raw.target)), record)]) {
      for (const key of ['dependencies', 'dev-dependencies', 'build-dependencies'])
        yield* dependencies(directory, group[key]);
    }
    for (const patch of EffectRecord.values(record(raw.patch))) yield* dependencies(directory, patch);
    yield* dependencies(directory, raw.replace);
    for (const target of [
      record(raw.lib),
      ...EffectArray.flatMap(['bin', 'test', 'example', 'bench'], kind =>
        EffectArray.isArray(raw[kind]) ? EffectArray.map(raw[kind], record) : [],
      ),
    ])
      if (target.path !== undefined) yield* addPath(directory, target.path, false);
  }
  yield* fs.makeDirectory(options.privateDirectory, {recursive: true, mode: 0o700});
  if (
    (yield* fs.realPath(options.privateDirectory)) !== options.privateDirectory ||
    (yield* fs.stat(options.privateDirectory)).mode & 0o077
  )
    return yield* fail();
  const directory = yield* fs.makeTempDirectoryScoped({directory: options.privateDirectory, prefix: 'rust-'});
  for (const child of ['home', 'cargo', 'cache', 'config', 'target', 'build', 'tmp'])
    yield* fs.makeDirectory(path.join(directory, child), {mode: 0o700});
  const environment = rustEnvironment(options.sdk, directory);
  const configFile = path.join(directory, 'cargo-policy.toml');
  const policy = {
    build: {
      rustc: environment.RUSTC,
      'rustc-wrapper': '',
      'rustc-workspace-wrapper': '',
      'target-dir': environment.CARGO_TARGET_DIR,
      'build-dir': environment.CARGO_BUILD_BUILD_DIR,
    },
    net: {offline: true},
    env: EffectRecord.fromEntries(
      EffectArray.map(
        EffectArray.filter(EffectRecord.toEntries(environment), ([key]) =>
          [
            'RUSTC',
            'RUSTDOC',
            'RUSTC_WRAPPER',
            'RUSTC_WORKSPACE_WRAPPER',
            'CARGO_BUILD_RUSTC_WRAPPER',
            'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',
            'RUSTFLAGS',
            'CARGO_ENCODED_RUSTFLAGS',
            'CARGO_CACHE_RUSTC_INFO',
          ].includes(key),
        ),
        ([key, value]) => [key, {value, force: true}],
      ),
    ),
  };
  // JSON strings are valid TOML basic strings for these canonical host paths and fixed values.
  const lines = [
    '[build]',
    ...EffectArray.map(EffectRecord.toEntries(policy.build), ([key, value]) => key + ' = ' + JSON.stringify(value)),
    '[net]',
    'offline = true',
    ...EffectArray.flatMap(EffectRecord.toEntries(policy.env), ([key, value]) => [
      '[env.' + key + ']',
      'value = ' + JSON.stringify(value.value),
      'force = true',
    ]),
  ];
  yield* fs.writeFileString(configFile, EffectArray.join(lines, '\n') + '\n', {flag: 'wx', mode: 0o600});
  const configDigest = yield* boundedFileDigest(configFile, 64 * 1024);
  const verify = Effect.gen(function* () {
    if ((yield* boundedFileDigest(configFile, 64 * 1024)) !== configDigest) return yield* fail();
    for (const [file, digest] of manifests) {
      yield* configAncestry(path.dirname(file));
      if ((yield* boundedFileDigest(file, 1024 * 1024)) !== digest) return yield* fail();
    }
  });
  yield* verify;
  const manifest = path.join(options.project, 'Cargo.toml');
  const result = yield* command.execute(
    environment.CARGO,
    ['metadata', '--format-version', '1', '--offline', '--locked', '--manifest-path', manifest, '--config', configFile],
    {cwd: options.project, env: environment, timeoutMs: 10000, maxOutputBytes: 4 * 1024 * 1024},
  );
  const metadata = yield* Effect.try({try: () => JSON.parse(result.stdout) as unknown, catch: fail}).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          packages: Schema.Array(
            Schema.Struct({
              manifest_path: Schema.String,
              name: Schema.String.check(Schema.isBetweenLength(1, 1024)),
              version: Schema.String.check(Schema.isBetweenLength(1, 1024)),
              targets: Schema.Array(
                Schema.Struct({src_path: Schema.String.check(Schema.isBetweenLength(1, 8192))}),
              ).check(Schema.isBetweenLength(1, 256)),
            }),
          ).check(Schema.isMaxLength(128)),
          workspace_root: Schema.String,
        }),
      ),
    ),
  );
  yield* canonical(metadata.workspace_root);
  for (const pkg of metadata.packages) {
    if (!manifests.has(pkg.manifest_path)) return yield* fail();
    for (const target of pkg.targets) yield* canonical(target.src_path);
  }
  yield* verify;
  const initializationOptions = {
    linkedProjects: [manifest],
    diagnostics: {enable: true, experimental: {enable: true}},
    vfs: {extraIncludes: []},
    workspace: {discoverConfig: null},
    cargo: {
      buildScripts: {enable: false, overrideCommand: null, rebuildOnSave: false},
      noDeps: false,
      sysroot: options.sdk,
      sysrootSrc: path.join(options.sdk, 'lib/rustlib/src/rust/library'),
      configPath: configFile,
      metadataExtraArgs: ['--offline', '--locked'],
      extraArgs: [],
      extraEnv: environment,
      targetDir: environment.CARGO_TARGET_DIR,
    },
    procMacro: {enable: false, server: null},
    checkOnSave: false,
    check: {overrideCommand: null},
    cachePriming: {enable: false},
    rustc: {source: null},
  };
  return {
    verify,
    environment,
    ready: Effect.void,
    roots: [options.sdk],
    initializationOptions,
    settings: {'rust-analyzer': initializationOptions},
    profile: {
      kind: 'rust-offline',
      version: '1.99.1',
      workspace: metadata.workspace_root,
      manifests: [...manifests.keys()],
      packages: EffectArray.map(metadata.packages, pkg => ({
        name: pkg.name,
        version: pkg.version,
        manifest: pkg.manifest_path,
      })),
      buildScripts: false,
      proceduralMacros: false,
      cargoChecks: false,
      dependencyAcquisition: false,
    },
  };
});
const Status = Schema.Struct({health: Schema.Literals(['ok', 'warning', 'error']), quiescent: Schema.Boolean});
export const makeRustSession = Effect.fn('semantic.makeRustSession')(function* (
  client: LspClient,
  options: Omit<LspSessionOptions, 'policy'> & {
    readonly initializationOptions: Schema.Json;
  },
) {
  let status: typeof Status.Type | undefined;
  let wake = Deferred.makeUnsafe<void>();
  const quiet = Effect.gen(function* () {
    while (!status?.quiescent) yield* Deferred.await(wake);
    if (status.health !== 'ok') return yield* fail();
  });
  const session = yield* makeLspSession(client, {
    ...options,
    ready: options.ready.pipe(Effect.andThen(quiet), Effect.timeout(options.startupMilliseconds)),
    policy: {
      language: 'rust',
      editSourceQualification: 'versioned-text-document-v1',
      resolveCodeActions: true,
      pullDiagnostics: true,
      codeActionKinds: ['', 'quickfix', 'refactor'],
      workspaceName: 'semantic-rust-project',
      acceptsServer: server => server?.name === 'rust-analyzer' && server.version === rustProviderVersion,
      initializationOptions: options.initializationOptions,
      experimentalCapabilities: {serverStatusNotification: true},
      receive: (method, params) => {
        if (method !== 'experimental/serverStatus' || !Schema.is(Status)(params)) return;
        status = params;
        const previous = wake;
        wake = Deferred.makeUnsafe<void>();
        Deferred.doneUnsafe(previous, Effect.void);
      },
      limitations: [
        'Experimental Rust offline Cargo workspace profile',
        'Selected Cargo manifests and resolved local dependencies only',
        'Build scripts, procedural macros, cargo checks, commands and dependency acquisition disabled; generated and macro-dependent coverage is partial',
        'Native experimental diagnostics may report false positives; cargo-check diagnostics are unavailable',
      ],
    },
  });
  const close = yield* Effect.cached(
    Effect.gen(function* () {
      const quiescent = yield* quiet.pipe(
        Effect.timeoutOption(10000),
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      );
      const receipt = yield* session.close;
      return quiescent
        ? receipt
        : {...receipt, graceful: false, fault: receipt.fault ?? LspFault.make({code: 'timeout'})};
    }),
  );
  return {...session, close};
});
