import {Digest as EffectDigest} from 'effect/crypto';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Cause, Effect, Exit, Fiber, FileSystem, Option, Path, Schema} from 'effect';
import {Digest} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runtimeNativePlatformTarget, runtimePlatform, platformPathFor} from '@threadnote/platform/system';
import {boundedFileDigest, readBounded, semanticSdkDigest} from '../fingerprint.js';
import {LspFault, makeLspClient, spawnLspWire, type LspWire, type WireStop} from '../lsp_transport.js';
import {SemanticJavaRuntimeVerifier, SemanticSetupFault, wellFormed} from '../provider.js';
import {
  consumeJavaPreparationConnection,
  materializeJavaMavenConfiguration,
  verifyJavaPreparationInputs,
  type JavaPreparationInputs,
} from './java_preparation.js';

export const JavaRuntimeCandidate = Schema.Struct({
  serverDirectory: Schema.String,
  serverTreeDigest: Digest,
  runtimeJavaHome: Schema.String,
  runtimeSdkDigest: Digest,
  projectJavaHome: Schema.String,
  projectSdkDigest: Digest,
});
export type JavaRuntimeCandidate = typeof JavaRuntimeCandidate.Type;

/** Retained experimental Darwin pins; no production or all-platform qualification is implied. */
export const javaRuntimeQualification = Object.freeze({
  platform: 'darwin-arm64',
  serverVersion: '1.63.0-202610191322',
  runtimeVersion: '25.0.5+8',
  projectVersion: '21.0.13+9',
  serverTreeDigest: '2157c2e0f504a186de8bbd7d21230442643337d33181aa89e10b870a4f567cd6',
  runtimeSdkDigest: 'e55e2e5a8caf01f0fdd6437d9de55bddaadb7c1d3b5ee3eec96e963a0359bb1a',
  projectSdkDigest: 'dd093e5af74a05c92e4f5102489655696f1ea8cd1c42ac2fb1c27d02083ff604',
  runtimeExecutableDigest: 'd6b5c8ffce485baa7e9aacfd9c652e2999c89053a5070104c598731636bd2249',
  projectExecutableDigest: '0f642542ea1f0be6957557c0db96653ec128113bb5a4aaa7c2534d1d72ddb51f',
  configurationDigest: '0d5587fcd30641a4ce5b59e706d3565a8a7b7b40cd75c1d78ece842722c0b3ee',
} as const);
const JavaPlatformPins = Schema.Struct({
  serverTreeDigest: Digest,
  configurationDigest: Digest,
  configurationDirectory: Schema.Literals([
    'config_mac_arm',
    'config_mac',
    'config_linux',
    'config_linux_arm',
    'config_win',
  ]),
  runtimeSdkDigest: Digest,
  runtimeExecutableDigest: Digest,
  projectSdkDigest: Digest,
  projectExecutableDigest: Digest,
});
const JavaPlatformArtifact = Schema.Struct({
  role: Schema.Literals(['provider', 'runtime-sdk', 'project-sdk']),
  version: Schema.String,
  url: Schema.String,
  archiveSha256: Digest,
  licenseEvidence: Schema.Array(Schema.Struct({url: Schema.String, sha256: Digest})).check(Schema.isMinLength(1)),
});
const JavaPlatformCandidate = Schema.Struct({
  status: Schema.Literal('candidate-artifacts-verified'),
  artifacts: Schema.Array(JavaPlatformArtifact).check(Schema.isBetweenLength(3, 3)),
  runtimePins: JavaPlatformPins,
  productionQualified: Schema.Literal(false),
});
const JavaRuntimePlatform = Schema.Literals([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-arm64-musl',
  'linux-x64-baseline',
  'linux-x64-baseline-musl',
  'windows-arm64',
  'windows-x64-baseline',
]);
// These source-owned rows are independent of the root qualification evidence ledger.
// There are no vetted additional platform images to ship yet; absent rows always refuse.
const javaRuntimePlatformArtifacts: Readonly<Record<string, unknown>> = Object.freeze({});
/** Decode one reviewed source pin image without granting any process or writer capability. */
export function selectJavaRuntimePlatformPins(platform: string | undefined, candidate: unknown) {
  if (!Schema.is(JavaRuntimePlatform)(platform)) return undefined;
  try {
    const row = Schema.decodeUnknownSync(JavaPlatformCandidate)(candidate);
    const roles = new Set(EffectArray.map(row.artifacts, artifact => artifact.role));
    const provider = EffectArray.findFirst(row.artifacts, artifact => artifact.role === 'provider');
    const runtime = EffectArray.findFirst(row.artifacts, artifact => artifact.role === 'runtime-sdk');
    const project = EffectArray.findFirst(row.artifacts, artifact => artifact.role === 'project-sdk');
    if (
      roles.size !== 3 ||
      Option.isNone(provider) ||
      Option.isNone(runtime) ||
      Option.isNone(project) ||
      provider.value.version !== javaRuntimeQualification.serverVersion ||
      !EffectString.startsWith('25.')(runtime.value.version) ||
      !EffectString.startsWith('21.')(project.value.version)
    )
      return undefined;
    const config = EffectString.startsWith('darwin-')(platform)
      ? EffectString.endsWith('arm64')(platform)
        ? 'config_mac_arm'
        : 'config_mac'
      : EffectString.startsWith('windows-')(platform)
        ? 'config_win'
        : EffectString.startsWith('linux-arm64')(platform)
          ? 'config_linux_arm'
          : 'config_linux';
    if (row.runtimePins.configurationDirectory !== config) return undefined;
    return {
      ...javaRuntimeQualification,
      ...row.runtimePins,
      platform,
      runtimeVersion: runtime.value.version,
      projectVersion: project.value.version,
    };
  } catch {
    return undefined;
  }
}
/** Select execution pins only from immutable product source, never a host profile or evidence ledger. */
export function javaRuntimePinsForHost() {
  const platform = runtimeNativePlatformTarget();
  if (platform === javaRuntimeQualification.platform)
    return {...javaRuntimeQualification, configurationDirectory: 'config_mac_arm' as const};
  return selectJavaRuntimePlatformPins(platform, platform ? javaRuntimePlatformArtifacts[platform] : undefined);
}
export const isCurrentJavaRuntimePlatform = (platform: string) =>
  Schema.is(JavaRuntimePlatform)(platform) && runtimeNativePlatformTarget() === platform;
const javaExecutable = (home: string) =>
  platformPathFor(runtimePlatform).join(home, 'bin', runtimePlatform === 'win32' ? 'java.exe' : 'java');
export const javaRuntimeSetupAction = `Configure the host-approved JDT LS ${javaRuntimeQualification.serverVersion}, server Java ${javaRuntimeQualification.runtimeVersion} and separate project Java ${javaRuntimeQualification.projectVersion} SDKs with their qualified full-tree digests; platform-specific archive, license, complete-tree and executable pins are required for this experimental profile`;
const fail = () => LspFault.make({code: 'prerequisite'});
const setupFault = (component: 'provider' | 'runtime' | 'project', reason: SemanticSetupFault['reason']) =>
  SemanticSetupFault.make({
    providerId: 'jdtls',
    component: component === 'provider' ? 'provider' : 'sdk',
    reason,
    requiredVersion: javaRuntimeQualification.serverVersion,
    requiredSdkVersion:
      component === 'project' ? javaRuntimeQualification.projectVersion : javaRuntimeQualification.runtimeVersion,
    nextAction: javaRuntimeSetupAction,
  });
const inside = (root: string, file: string, separator: string) =>
  root === file || EffectString.startsWith(root + separator)(file);

/** One cleanup owner for a Java project/copy and its runtime. An unconfirmed process keeps the entire tree. */
export const makeJavaWorkspace = Effect.fn('semantic.makeJavaWorkspace')(function* (parent: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(parent) || path.resolve(parent) !== parent || (yield* fs.realPath(parent)) !== parent)
    return yield* fail();
  const parentInfo = yield* fs.stat(parent);
  if (parentInfo.type !== 'Directory' || parentInfo.mode & 0o077) return yield* fail();
  const directory = yield* fs.makeTempDirectory({directory: parent, prefix: 'java-'});
  const original = yield* fs.stat(directory);
  let state: 'unused' | 'held' | 'drained' | 'closing' | 'disposed' | 'unknown' = 'unused';
  let invalid = false;
  const inputs: {file: string; digest: string; identity: FileSystem.File.Info}[] = [];
  const verifyInput = Effect.fn('semantic.verifyJavaDisposableInput')(function* (input: (typeof inputs)[number]) {
    const current = yield* fs.lstat(input.file);
    const same = (value: FileSystem.File.Info) =>
      value.type === 'File' &&
      value.dev === input.identity.dev &&
      Option.isSome(value.ino) &&
      Option.isSome(input.identity.ino) &&
      value.ino.value === input.identity.ino.value &&
      value.mode === input.identity.mode &&
      value.size === input.identity.size;
    if (
      !same(current) ||
      (yield* fs.realPath(input.file)) !== input.file ||
      sha256HexSync(yield* readBounded(input.file, 64 * 1024 * 1024)) !== input.digest ||
      !same(yield* fs.lstat(input.file))
    )
      return yield* fail();
  });
  const verifyDirectory = Effect.gen(function* () {
    if (invalid) return yield* fail();
    const current = yield* fs.stat(directory);
    if (
      (yield* fs.realPath(directory)) !== directory ||
      current.type !== 'Directory' ||
      current.mode & 0o077 ||
      Option.isNone(original.ino) ||
      Option.isNone(current.ino) ||
      original.dev !== current.dev ||
      original.ino.value !== current.ino.value
    )
      return yield* fail();
  }).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        invalid = true;
      }),
    ),
  );
  const verifyLive = verifyDirectory.pipe(
    Effect.andThen(
      Effect.gen(function* () {
        for (const input of inputs) yield* verifyInput(input);
      }),
    ),
    Effect.onError(() =>
      Effect.sync(() => {
        invalid = true;
      }),
    ),
  );
  const verify = Effect.suspend(() =>
    state === 'closing' || state === 'disposed' || state === 'unknown' ? fail() : verifyLive,
  );
  yield* verify;
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const retained = state === 'held' || invalid;
      state = 'closing';
      if (retained) {
        state = 'unknown';
        return Effect.void;
      }
      return verifyLive.pipe(
        Effect.andThen(fs.remove(directory, {recursive: true})),
        Effect.andThen(
          Effect.sync(() => {
            state = 'disposed';
          }),
        ),
        Effect.onError(() =>
          Effect.sync(() => {
            state = 'unknown';
          }),
        ),
      );
    }).pipe(Effect.orDie),
  );
  return {
    directory,
    verify,
    /** Only this owner's successful removal can establish disposal; absence is never a receipt. */
    verifyDisposed: Effect.suspend(() => (state === 'disposed' && !invalid ? Effect.void : fail())),
    retainInput: (file: string, digest: string) =>
      Effect.suspend(() =>
        state !== 'held'
          ? fail()
          : Effect.gen(function* () {
              yield* verifyDirectory;
              if (
                state !== 'held' ||
                !Schema.is(Digest)(digest) ||
                !path.isAbsolute(file) ||
                path.resolve(file) !== file ||
                file === directory ||
                !inside(directory, file, path.sep) ||
                inputs.length >= 512 ||
                EffectArray.some(inputs, input => input.file === file)
              )
                return yield* fail();
              const identity = yield* fs.lstat(file);
              if (identity.mode & 0o077) return yield* fail();
              const input = {file, digest, identity};
              yield* verifyInput(input);
              if (
                state !== 'held' ||
                invalid ||
                inputs.length >= 512 ||
                EffectArray.some(inputs, input => input.file === file)
              )
                return yield* fail();
              inputs.push(input);
            }).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  invalid = true;
                }),
              ),
            ),
      ),
    hold: verify.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (state !== 'unused') return fail();
          state = 'held';
          return Effect.void;
        }),
      ),
    ),
    confirmDrained: (receipt: {readonly drained: boolean; readonly stdioClosed: boolean}) =>
      verify.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (state !== 'held' || !receipt.drained || !receipt.stdioClosed) return LspFault.make({code: 'exit'});
            state = 'drained';
            return Effect.void;
          }),
        ),
      ),
  };
});
export type JavaWorkspace = Effect.Success<ReturnType<typeof makeJavaWorkspace>>;

export type JavaPreparationOwnerPlan = 'provider-tree' | 'provider-and-gradle-foreground';
export const javaPreparationOwnerContract = 'original-preparation-owners-v1' as const;
type JavaPreparationOwnerRole = 'provider' | 'gradle-foreground';

/** Private host composition only. A role or a PID is never a process capability or a reuse proof. */
export const makeJavaPreparationOwners = Effect.fn('semantic.makeJavaPreparationOwners')(function* (
  plan: JavaPreparationOwnerPlan,
) {
  if (plan !== 'provider-tree' && plan !== 'provider-and-gradle-foreground') return yield* fail();
  const roles: readonly JavaPreparationOwnerRole[] =
    plan === 'provider-tree' ? ['provider'] : ['provider', 'gradle-foreground'];
  const attempted = new Set<JavaPreparationOwnerRole>();
  const captured = new Map<JavaPreparationOwnerRole, Effect.Effect<WireStop, unknown>>();
  let unknown = false;
  let closing = false;
  const refuse = (): never => {
    unknown = true;
    throw fail();
  };
  const beforeLaunch = (role: JavaPreparationOwnerRole): void => {
    if (closing || unknown || !roles.includes(role) || attempted.has(role)) refuse();
    attempted.add(role);
  };
  const capture = (role: JavaPreparationOwnerRole, originalFinish: Effect.Effect<WireStop, unknown>): void => {
    if (closing || !attempted.has(role) || captured.has(role) || !Effect.isEffect(originalFinish)) refuse();
    // Even after another owner becomes uncertain, retain this original capability for cleanup.
    captured.set(role, originalFinish);
  };
  const verify = Effect.suspend(() => {
    if (closing || unknown || EffectArray.some(roles, role => !captured.has(role))) {
      unknown = true;
      return fail();
    }
    return Effect.void;
  });
  const finish = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        closing = true;
        for (const role of attempted) if (!captured.has(role)) unknown = true;
        // Start every captured owner even when another fails. One shared deadline bounds the
        // collection; the original native finishes keep their own finite cleanup contracts.
        const finishing = yield* Effect.all(
          EffectArray.flatMap(roles, role => {
            const original = captured.get(role);
            return original ? [Effect.exit(original)] : [];
          }),
          {concurrency: 2},
        ).pipe(Effect.timeoutOption(30000), Effect.interruptible, Effect.forkChild);
        const completed = yield* Fiber.await(finishing);
        if (Exit.isFailure(completed) || Option.isNone(completed.value)) unknown = true;
        else
          for (const receipt of completed.value.value)
            if (Exit.isFailure(receipt) || !receipt.value.drained || !receipt.value.stdioClosed) unknown = true;
        return Object.freeze({drained: !unknown, stdioClosed: !unknown});
      }),
    ),
  );
  return Object.freeze({
    beforeLaunch,
    capture,
    verify,
    markUnknown: () => {
      unknown = true;
    },
    finish,
  });
});

/** Nearest importer ancestor, outside the unchanged source copy. This is bootstrap selection, not a sandbox. */
export const makeJavaMavenBoundary = Effect.fn('semantic.makeJavaMavenBoundary')(function* (workspace: JavaWorkspace) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* workspace.verify;
  const directory = path.join(workspace.directory, '.mvn');
  yield* fs.makeDirectory(directory, {mode: 0o700});
  const original = yield* fs.stat(directory);
  let invalid = false;
  const verify = Effect.suspend(() => (invalid ? fail() : workspace.verify)).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const current = yield* fs.stat(directory);
        if (
          (yield* fs.realPath(directory)) !== directory ||
          current.type !== 'Directory' ||
          current.mode & 0o077 ||
          Option.isNone(original.ino) ||
          Option.isNone(current.ino) ||
          original.dev !== current.dev ||
          original.ino.value !== current.ino.value ||
          (yield* fs.readDirectory(directory)).length !== 0
        )
          return yield* fail();
      }),
    ),
    Effect.onError(() =>
      Effect.sync(() => {
        invalid = true;
      }),
    ),
  );
  yield* verify;
  return {directory, verify};
});

export interface JavaPreparationDrainContext {
  readonly runtimeDirectory: string;
  readonly gradleUserHome: string;
  readonly retainInput: JavaWorkspace['retainInput'];
  readonly verifyDisposed: JavaWorkspace['verifyDisposed'];
}
type JavaLaunchOptions = {
  readonly workspace: JavaWorkspace;
  readonly project: string;
  readonly worktree: string;
};
type JavaPreparationOptions = JavaLaunchOptions & {
  readonly capturePreparationProvider: (pid: number, finish: Effect.Effect<WireStop>) => void;
  readonly build: 'maven' | 'gradle';
  readonly inputs: JavaPreparationInputs;
  readonly drainBuildProcesses: (
    context: JavaPreparationDrainContext,
  ) => Effect.Effect<{readonly drained: boolean}, LspFault>;
};
export interface JavaPreparationRuntime {
  readonly pid: number;
  readonly finish: Effect.Effect<WireStop, LspFault>;
  readonly directory: string;
  readonly verify: Effect.Effect<void, unknown>;
  readonly inputs: JavaPreparationInputs;
  readonly projectJavaHome: string;
}
const preparationRuntimes = new WeakMap<JavaPreparationRuntime, LspWire>();
/** Host process identity, separate from setup permission and from a completed import. */
export const isJavaPreparationRuntime = (runtime: JavaPreparationRuntime) => preparationRuntimes.has(runtime);

/** The fixed importer alone owns the first reader and initialize channel; callers retain only bounded drain access. */
export const makeJavaPreparationClient = Effect.fn('semantic.makeJavaPreparationClient')(function* (
  runtime: JavaPreparationRuntime,
  admission: object,
  onNotification: (method: string, params: unknown) => void,
  settings: Schema.Json,
) {
  const wire = preparationRuntimes.get(runtime);
  if (!wire) return yield* fail();
  yield* consumeJavaPreparationConnection(runtime, admission);
  return yield* makeLspClient(wire, onNotification, settings);
});

/** Both owners must stop, including when either finalizer fails. An uncertain build keeps the entire workspace. */
export const finishJavaPreparation = Effect.fn('semantic.finishJavaPreparation')(function* (
  workspace: JavaWorkspace,
  finishProvider: Effect.Effect<WireStop, LspFault>,
  finishBuild: Effect.Effect<{readonly drained: boolean}, LspFault>,
) {
  const provider = yield* finishProvider.pipe(
    Effect.flatMap(receipt => (receipt.drained && receipt.stdioClosed ? Effect.void : LspFault.make({code: 'exit'}))),
    Effect.exit,
  );
  // A new child has no pending caller interruption; the finalizer still awaits its bounded result.
  const buildFiber = yield* finishBuild.pipe(
    Effect.flatMap(receipt => (receipt.drained ? Effect.void : LspFault.make({code: 'exit'}))),
    Effect.timeoutOption(30000),
    Effect.flatMap(result => (Option.isSome(result) ? Effect.void : LspFault.make({code: 'timeout'}))),
    Effect.interruptible,
    Effect.forkChild,
  );
  const build = yield* Fiber.await(buildFiber);
  if (Exit.isFailure(provider) && Exit.isFailure(build))
    return yield* Effect.failCause(Cause.combine(provider.cause, build.cause));
  if (Exit.isFailure(provider)) return yield* Effect.failCause(provider.cause);
  if (Exit.isFailure(build)) return yield* Effect.failCause(build.cause);
  yield* workspace.confirmDrained({drained: true, stdioClosed: true});
});

/** The exact captured configuration image is pinned before any write; SDK before/after checks alone cannot bind a copy. */
export const materializeJavaRuntimeConfiguration = Effect.fn('semantic.materializeJavaRuntimeConfiguration')(function* (
  input: Uint8Array,
  directory: string,
  expectedDigest: string = javaRuntimeQualification.configurationDigest,
) {
  if (input.length > 16 * 1024) return yield* setupFault('provider', 'incompatible');
  const bytes = input.slice();
  if (sha256HexSync(bytes) !== expectedDigest) return yield* setupFault('provider', 'incompatible');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    (yield* fs.realPath(directory)) !== directory
  )
    return yield* fail();
  const info = yield* fs.stat(directory);
  if (info.type !== 'Directory' || info.mode & 0o077) return yield* fail();
  const file = path.join(directory, 'config.ini');
  yield* fs.writeFile(file, bytes, {flag: 'wx', mode: 0o600});
  if ((yield* boundedFileDigest(file, 16 * 1024)) !== expectedDigest) return yield* fail();
  return file;
});

/** Host-only SDK and process composition shared by preparation and analysis; callers cannot supply JVM arguments. */
export const makeJavaRuntime = Effect.fn('semantic.makeJavaRuntime')(
  function* (candidate: JavaRuntimeCandidate | undefined) {
    if (!candidate) return yield* setupFault('provider', 'missing');
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* EffectDigest.Digest;
    const selected = Object.freeze(
      structuredClone(
        yield* Schema.decodeEffect(JavaRuntimeCandidate, {onExcessProperty: 'error'})(candidate).pipe(
          Effect.mapError(() => setupFault('provider', 'incompatible')),
        ),
      ),
    );
    const staticPath = (value: string) =>
      value.length > 0 &&
      value.length <= 8192 &&
      wellFormed(value) &&
      !/\p{Cc}/u.test(value) &&
      path.isAbsolute(value) &&
      path.resolve(value) === value &&
      !EffectString.split(path.sep)(value).includes('.git');
    const directory = (value: string) =>
      Effect.gen(function* () {
        if (!staticPath(value) || (yield* fs.realPath(value)) !== value || (yield* fs.stat(value)).type !== 'Directory')
          return yield* fail();
      });
    const pins = javaRuntimePinsForHost();
    if (!pins) return yield* setupFault('provider', 'incompatible');
    const sdks = [
      [selected.serverDirectory, selected.serverTreeDigest, pins.serverTreeDigest, 'provider'],
      [selected.runtimeJavaHome, selected.runtimeSdkDigest, pins.runtimeSdkDigest, 'runtime'],
      [selected.projectJavaHome, selected.projectSdkDigest, pins.projectSdkDigest, 'project'],
    ] as const;
    const verifyLocal = Effect.gen(function* () {
      if (!isCurrentJavaRuntimePlatform(pins.platform)) return yield* setupFault('provider', 'incompatible');
      for (const [root, expected, qualified, component] of sdks)
        if (expected !== qualified || !staticPath(root)) return yield* setupFault(component, 'incompatible');
      for (const [root, , qualified, component] of sdks) {
        yield* Effect.gen(function* () {
          if (!(yield* fs.exists(root))) return yield* setupFault(component, 'missing');
          yield* directory(root).pipe(Effect.catchTag('LspFault', () => setupFault(component, 'incompatible')));
          if ((yield* semanticSdkDigest(root)) !== qualified) return yield* setupFault(component, 'incompatible');
        }).pipe(
          Effect.mapError(error =>
            Schema.is(SemanticSetupFault)(error) ? error : setupFault(component, 'unavailable'),
          ),
        );
      }
      for (const [root, expected, component] of [
        [selected.runtimeJavaHome, pins.runtimeExecutableDigest, 'runtime'],
        [selected.projectJavaHome, pins.projectExecutableDigest, 'project'],
      ] as const) {
        yield* Effect.gen(function* () {
          const file = javaExecutable(root);
          const info = yield* fs.stat(file);
          if (
            (yield* fs.realPath(file)) !== file ||
            info.type !== 'File' ||
            (runtimePlatform !== 'win32' && !(info.mode & 0o111)) ||
            (yield* boundedFileDigest(file, 64 * 1024 * 1024)) !== expected
          )
            return yield* setupFault(component, 'incompatible');
        }).pipe(
          Effect.mapError(error =>
            Schema.is(SemanticSetupFault)(error) ? error : setupFault(component, 'unavailable'),
          ),
        );
      }
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(EffectDigest.Digest, digest),
    );
    const hostVerifier = yield* SemanticJavaRuntimeVerifier;
    const verify = hostVerifier ? hostVerifier(selected) : verifyLocal;
    yield* verify;
    const launch = (
      mode: 'analysis' | 'preparation',
      input: JavaLaunchOptions,
      drainBuildProcesses?: JavaPreparationOptions['drainBuildProcesses'],
      build?: JavaPreparationOptions['build'],
      inputs?: JavaPreparationInputs,
      capturePreparationProvider?: JavaPreparationOptions['capturePreparationProvider'],
    ) => {
      const options = {...input};
      return Effect.gen(function* () {
        if (
          mode === 'preparation' &&
          (typeof drainBuildProcesses !== 'function' ||
            typeof capturePreparationProvider !== 'function' ||
            !['maven', 'gradle'].includes(build ?? '') ||
            !inputs ||
            inputs.build !== build ||
            inputs.worktree !== options.worktree ||
            inputs.copiedProject !== options.project)
        )
          return yield* fail();
        if (mode === 'preparation') yield* verifyJavaPreparationInputs(inputs!, {...options, build: build!});
        yield* verify;
        const privateDirectory = options.workspace.directory;
        yield* options.workspace.verify;
        for (const value of [privateDirectory, options.project, options.worktree]) yield* directory(value);
        if (
          !inside(privateDirectory, options.project, path.sep) ||
          inside(options.worktree, privateDirectory, path.sep) ||
          inside(privateDirectory, options.worktree, path.sep) ||
          EffectArray.some(sdks, ([root]) =>
            EffectArray.some(
              [options.worktree, privateDirectory],
              directory => inside(root, directory, path.sep) || inside(directory, root, path.sep),
            ),
          )
        )
          return yield* fail();
        const boundary = mode === 'preparation' ? yield* makeJavaMavenBoundary(options.workspace) : undefined;
        const root = yield* fs.makeTempDirectory({directory: privateDirectory, prefix: 'jdt-'});
        yield* directory(root);
        const launched: {started: boolean; wire: LspWire | undefined} = {started: false, wire: undefined};
        const drainContext = Object.freeze({
          runtimeDirectory: root,
          gradleUserHome: path.join(root, 'gradle'),
          retainInput: options.workspace.retainInput,
          verifyDisposed: options.workspace.verifyDisposed,
        });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (!launched.started) return;
            const provider = launched.wire?.finish ?? LspFault.make({code: 'exit'});
            if (drainBuildProcesses)
              return yield* finishJavaPreparation(
                options.workspace,
                provider,
                Effect.suspend(() => drainBuildProcesses(drainContext)),
              );
            yield* options.workspace.confirmDrained(yield* provider);
          }).pipe(Effect.orDie),
        );
        for (const name of ['home', 'm2', 'configuration', 'data', 'tmp', 'gradle'])
          yield* fs.makeDirectory(path.join(root, name), {mode: 0o700});
        const mavenConfiguration =
          mode === 'preparation' && build === 'maven'
            ? yield* materializeJavaMavenConfiguration(root, selected.projectJavaHome)
            : undefined;
        const verifyLaunch = verify.pipe(
          Effect.andThen(boundary?.verify ?? Effect.void),
          Effect.andThen(mavenConfiguration?.verify ?? Effect.void),
        );
        const preparationProperties =
          mode === 'preparation'
            ? [
                '-Dthreadnote.java.preparedProjectUri=' + (yield* path.toFileUrl(options.project)).href,
                '-Dthreadnote.java.projectJavaHomeUri=' + (yield* path.toFileUrl(selected.projectJavaHome)).href,
                '-Dthreadnote.java.preparedMavenCacheUri=' + (yield* path.toFileUrl(path.join(root, 'm2'))).href,
                '-Dthreadnote.java.preparedGradleCacheUri=' + (yield* path.toFileUrl(drainContext.gradleUserHome)).href,
                '-Dthreadnote.java.preparedBuild=' + build,
              ]
            : [];
        const configuration = yield* materializeJavaRuntimeConfiguration(
          yield* readBounded(path.join(selected.serverDirectory, pins.configurationDirectory, 'config.ini'), 16 * 1024),
          path.join(root, 'configuration'),
          pins.configurationDigest,
        );
        yield* verifyLaunch;
        if ((yield* boundedFileDigest(configuration, 16 * 1024)) !== pins.configurationDigest) return yield* fail();
        if (inputs) yield* verifyJavaPreparationInputs(inputs, {...options, build: build!});
        yield* options.workspace.hold;
        launched.started = true;
        const wire = yield* spawnLspWire({
          command: javaExecutable(selected.runtimeJavaHome),
          cwd: options.project,
          args: [
            '-Djava.awt.headless=true',
            `-Dthreadnote.java.preparation=${mode === 'preparation' ? 'true' : 'false'}`,
            ...preparationProperties,
            '-Duser.home=' + path.join(root, 'home'),
            '-Dmaven.repo.local=' + path.join(root, 'm2'),
            '-Declipse.application=org.eclipse.jdt.ls.core.id1',
            '-Dosgi.bundles.defaultStartLevel=4',
            '-Declipse.product=org.eclipse.jdt.ls.core.product',
            '-Dosgi.install.area=' + (yield* path.toFileUrl(selected.serverDirectory)).href,
            '-Xmx512m',
            '--add-modules=ALL-SYSTEM',
            '--add-opens',
            'java.base/java.util=ALL-UNNAMED',
            '--add-opens',
            'java.base/java.lang=ALL-UNNAMED',
            '-jar',
            path.join(selected.serverDirectory, 'plugins/org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar'),
            '-configuration',
            path.join(root, 'configuration'),
            '-data',
            path.join(root, 'data'),
          ],
          environment: {
            PATH: path.join(selected.runtimeJavaHome, 'bin') + (runtimePlatform === 'win32' ? '' : ':/usr/bin:/bin'),
            JAVA_HOME: selected.runtimeJavaHome,
            HOME: path.join(root, 'home'),
            TMPDIR: path.join(root, 'tmp'),
            ...(runtimePlatform === 'win32'
              ? {TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), USERPROFILE: path.join(root, 'home')}
              : {}),
            GRADLE_USER_HOME: path.join(root, 'gradle'),
            JAVA_TOOL_OPTIONS: '',
            _JAVA_OPTIONS: '',
            JDK_JAVA_OPTIONS: '',
            CLASSPATH: '',
          },
        });
        launched.wire = wire;
        // Capture the ORIGINAL cached native finish before post-spawn verification can yield or fail.
        if (mode === 'preparation') capturePreparationProvider!(wire.pid, wire.finish);
        yield* verifyLaunch.pipe(Effect.onError(() => wire.finish.pipe(Effect.asVoid)));
        return {wire, directory: root, verify: verifyLaunch};
      }).pipe(
        Effect.timeoutOption(45000),
        Effect.flatMap(result =>
          Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
        ),
      );
    };
    return {
      verify,
      identity: sha256HexSync(JSON.stringify(EffectArray.map(sdks, ([root, digest]) => [root, digest]))),
      projectJavaHome: selected.projectJavaHome,
      analysis: (options: JavaLaunchOptions) => launch('analysis', options),
      preparation: (options: JavaPreparationOptions) => {
        const captured = {...options};
        return launch(
          'preparation',
          captured,
          captured.drainBuildProcesses,
          captured.build,
          captured.inputs,
          captured.capturePreparationProvider,
        ).pipe(
          Effect.map(runtime => {
            const prepared: JavaPreparationRuntime = Object.freeze({
              pid: runtime.wire.pid,
              finish: runtime.wire.finish,
              directory: runtime.directory,
              verify: runtime.verify,
              inputs: captured.inputs,
              projectJavaHome: selected.projectJavaHome,
            });
            preparationRuntimes.set(prepared, Object.freeze({...runtime.wire}));
            return prepared;
          }),
        );
      },
    };
  },
  effect =>
    effect.pipe(
      Effect.timeoutOption(45000),
      Effect.flatMap(result =>
        Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
      ),
    ),
);
