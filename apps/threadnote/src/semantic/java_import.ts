import {Digest as EffectDigest} from 'effect/crypto';
import {
  Array as EffectArray,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Schema,
  Scope,
  String as EffectString,
} from 'effect';
import * as Native from '@threadnote/platform/system';
import {canonicalFileUri, Digest, FileUri} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readBounded} from './fingerprint.js';
import {
  inspectSemanticHostProfile,
  JavaImportPolicy,
  JavaTrustedImportPolicyBody,
  javaTrustedImportMode,
  javaTrustedImportPermissions,
  javaTrustedImportRisk,
  javaTrustedImportRiskVersion,
  readSemanticHostProfile,
  SemanticHostProfileFault,
  writeSemanticJavaImportPolicy,
} from './host_profile.js';
import {makeSemanticAdmission} from './admission.js';
import {LspFault} from './lsp_transport.js';
import {makeJavaPreparation, type JavaPreparationHost} from './providers/java.js';
import {
  JavaPreparationGradle,
  javaGradleOwnedImport,
  javaMavenBootstrapContractDigest,
} from './providers/java_preparation.js';
import {
  JavaRuntimeCandidate,
  javaRuntimeQualification,
  javaRuntimePinsForHost,
  makeJavaRuntime,
  makeJavaPreparationOwners,
  javaPreparationOwnerContract,
  verifyJavaGradleInstallation,
} from './providers/java_runtime.js';

/** Original authored-project input, compared byte for byte. Never a replacement for a repository POM. */
export const javaImportCanonicalPom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>io.threadnote.diagnostic</groupId>
  <artifactId>original-java21</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
`;
const permissions = {
  importer: true,
  repositoryCommands: false,
  sourceExecution: false,
  network: false,
  dependencies: false,
  plugins: false,
  annotationProcessors: false,
  gradle: false,
} as const;
export class JavaImportFault extends Schema.TaggedError<JavaImportFault, {readonly brand: unique symbol}>()(
  'JavaImportFault',
  {
    reason: Schema.Literals([
      'invalid-request',
      'unsupported-input',
      'stale',
      'denied',
      'enforcement-unavailable',
      'import-support-unavailable',
    ]),
  },
) {}
const reject = (reason: JavaImportFault['reason']) => JavaImportFault.make({reason});

/** A closed bounded input inventory, not an XML evaluator or an arbitrary-build permission bit. */
export const inspectJavaImportInputs = Effect.fn('semantic.inspectJavaImportInputs')(function* (
  worktree: string,
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const root of [worktree, project])
    if (
      !path.isAbsolute(root) ||
      path.resolve(root) !== root ||
      (yield* fs.realPath(root)) !== root ||
      (yield* fs.stat(root)).type !== 'Directory'
    )
      return yield* reject('unsupported-input');
  // The preparation engine copies the whole worktree. This finite profile must inventory that entire closure.
  if (project !== worktree) return yield* reject('unsupported-input');
  const entries: [string, string][] = [];
  let total = 0;
  let sources = 0;
  const walk = (directory: string, relative: string, depth: number): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (depth > 24) return yield* reject('unsupported-input');
      for (const name of (yield* fs.readDirectory(directory)).sort()) {
        if (relative === '' && name === '.git' && project === worktree) continue;
        const file = path.join(directory, name);
        const member = relative ? relative + '/' + name : name;
        if (entries.length >= 512 || (yield* fs.realPath(file)) !== file) return yield* reject('unsupported-input');
        const info = yield* fs.stat(file);
        if (info.type === 'Directory') {
          if (
            !['src', 'src/main', 'src/main/java'].includes(member) &&
            !/^src\/main\/java\/(?:[A-Za-z_$][A-Za-z0-9_$]*\/)*[A-Za-z_$][A-Za-z0-9_$]*$/.test(member)
          )
            return yield* reject('unsupported-input');
          entries.push([member + '/', 'directory']);
          yield* walk(file, member, depth + 1);
        } else {
          if (
            info.type !== 'File' ||
            Number(info.size) > 1024 * 1024 ||
            (member !== 'pom.xml' &&
              !/^src\/main\/java\/(?:[A-Za-z_$][A-Za-z0-9_$]*\/)*[A-Za-z_$][A-Za-z0-9_$]*\.java$/.test(member))
          )
            return yield* reject('unsupported-input');
          const bytes = yield* readBounded(file, 1024 * 1024);
          if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return yield* reject('unsupported-input');
          const text = yield* Effect.try({
            try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
            catch: () => reject('unsupported-input'),
          });
          total += bytes.byteLength;
          if (
            total > 8 * 1024 * 1024 ||
            EffectString.includes('\u0000')(text) ||
            EffectString.startsWith('\ufeff')(text)
          )
            return yield* reject('unsupported-input');
          if (member === 'pom.xml' && text !== javaImportCanonicalPom) return yield* reject('unsupported-input');
          if (member !== 'pom.xml') sources++;
          entries.push([member, sha256HexSync(bytes)]);
        }
      }
    });
  yield* walk(project, '', 0);
  if (!sources || !EffectArray.some(entries, ([name]) => name === 'pom.xml')) return yield* reject('unsupported-input');
  return sha256HexSync(JSON.stringify(entries));
});

/** Raw closure of the unchanged copy, including nested project parents/siblings. It is not an OS read boundary. */
export const inspectTrustedJavaImportInputs = Effect.fn('semantic.inspectTrustedJavaImportInputs')(function* (
  worktree: string,
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const root of [worktree, project])
    if (
      !path.isAbsolute(root) ||
      path.resolve(root) !== root ||
      (yield* fs.realPath(root)) !== root ||
      (yield* fs.stat(root)).type !== 'Directory'
    )
      return yield* reject('unsupported-input');
  if (project !== worktree && !EffectString.startsWith(worktree + path.sep)(project))
    return yield* reject('unsupported-input');
  const entries: (readonly [string, string, number, number, string])[] = [];
  const pending = [''];
  let total = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    const directory = path.join(worktree, relative);
    for (const name of (yield* fs.readDirectory(directory)).sort()) {
      if (!relative && name === '.git') continue;
      const member = relative ? relative + '/' + name : name;
      if (name === '.mvn' || entries.length >= 20000) return yield* reject('unsupported-input');
      const file = path.join(directory, name);
      if ((yield* fs.realPath(file)) !== file) return yield* reject('unsupported-input');
      const before = yield* fs.stat(file);
      if (Option.isNone(before.ino)) return yield* reject('unsupported-input');
      if (before.type === 'Directory') {
        entries.push([member, 'directory', before.mode & 0o777, 0, '']);
        pending.push(member);
      } else if (before.type === 'File') {
        const size = Number(before.size);
        if (size > 32 * 1024 * 1024 || (total += size) > 256 * 1024 * 1024) return yield* reject('unsupported-input');
        const bytes = yield* readBounded(file, 32 * 1024 * 1024);
        const after = yield* fs.stat(file);
        if (
          after.type !== before.type ||
          before.dev !== after.dev ||
          Option.isNone(after.ino) ||
          before.ino.value !== after.ino.value ||
          before.mode !== after.mode ||
          before.size !== after.size ||
          (yield* fs.realPath(file)) !== file
        )
          return yield* reject('stale');
        entries.push([member, 'file', before.mode & 0o777, size, sha256HexSync(bytes)]);
      } else return yield* reject('unsupported-input');
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (
    !(yield* fs.exists(path.join(project, 'pom.xml'))) &&
    !(yield* fs.exists(path.join(project, 'build.gradle'))) &&
    !(yield* fs.exists(path.join(project, 'build.gradle.kts')))
  )
    return yield* reject('unsupported-input');
  return sha256HexSync(JSON.stringify(['java-import-raw-worktree-v1', path.relative(worktree, project), entries]));
});

const cachePath = Schema.String.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/^(?:m2|gradle|notices)\/[A-Za-z0-9._+@/-]+$/u),
);
const CacheManifest = Schema.Struct({
  version: Schema.Literal(1),
  build: Schema.Literals(['maven', 'gradle']),
  artifacts: Schema.Array(Schema.Struct({path: cachePath, sha256: Digest, notice: cachePath})).check(
    Schema.isBetweenLength(1, 512),
  ),
  notices: Schema.Array(Schema.Struct({path: cachePath, sha256: Digest})).check(Schema.isBetweenLength(1, 512)),
});
const cacheFailure = <A>(operation: () => A) => Effect.try({try: operation, catch: () => reject('unsupported-input')});
/** Source-independent private cache image. Its manifest proves bytes/notice presence, not license qualification. */
export const inspectJavaImportCache = Effect.fn('semantic.inspectJavaImportCache')(function* (
  input: {readonly directory: string; readonly manifestDigest: string},
  build: 'maven' | 'gradle',
  protectedRoots: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL(input.directory));
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    (yield* fs.realPath(root)) !== root ||
    EffectArray.some(
      protectedRoots,
      protectedRoot =>
        root === protectedRoot ||
        EffectString.startsWith(root + path.sep)(protectedRoot) ||
        EffectString.startsWith(protectedRoot + path.sep)(root),
    )
  )
    return yield* reject('unsupported-input');
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const own = (open: () => Native.RuntimePrivateWriterDirectory) =>
        Effect.acquireRelease(cacheFailure(open), owned =>
          Effect.sync(() => Native.runtimeClosePrivateWriterDirectory(owned)),
        );
      const directory = yield* own(() => Native.runtimeOpenPrivateWriterDirectory(root));
      const files = new Map<string, Uint8Array>();
      const inventory: (readonly [string, string, number, string])[] = [];
      let total = 0;
      const walk = (
        owned: Native.RuntimePrivateWriterDirectory,
        relative: string,
      ): Effect.Effect<void, unknown, Scope.Scope> =>
        Effect.gen(function* () {
          yield* cacheFailure(() => Native.runtimeAssertPrivateWriterDirectoryCurrent(owned));
          for (const name of (yield* fs.readDirectory(owned.path)).sort()) {
            const member = relative ? relative + '/' + name : name;
            if (inventory.length >= 20000 || name === '.' || name === '..') return yield* reject('unsupported-input');
            const info = yield* fs.stat(path.join(owned.path, name));
            if (info.type === 'Directory') {
              const child = yield* own(() => Native.runtimeOpenPrivateWriterChild(owned, name, false));
              inventory.push([member, 'directory', info.mode & 0o777, '']);
              yield* walk(child, member);
            } else if (info.type === 'File') {
              const value = yield* cacheFailure(() =>
                Native.runtimeReadPrivateWriterFile(owned, name, 16 * 1024 * 1024),
              );
              if (!value || (total += value.bytes.length) > 256 * 1024 * 1024)
                return yield* reject('unsupported-input');
              const after = yield* fs.stat(path.join(owned.path, name));
              if (
                after.type !== info.type ||
                after.dev !== info.dev ||
                Option.isNone(info.ino) ||
                Option.isNone(after.ino) ||
                after.ino.value !== info.ino.value ||
                after.mode !== info.mode ||
                after.size !== info.size
              )
                return yield* reject('stale');
              files.set(member, value.bytes);
              inventory.push([member, 'file', after.mode & 0o777, sha256HexSync(value.bytes)]);
            } else return yield* reject('unsupported-input');
          }
          yield* cacheFailure(() => Native.runtimeAssertPrivateWriterDirectoryCurrent(owned));
        });
      yield* walk(directory, '');
      const bytes = files.get('manifest.json');
      if (!bytes || bytes.length > 128 * 1024 || sha256HexSync(bytes) !== input.manifestDigest)
        return yield* reject('stale');
      const parsed = yield* Effect.try({
        try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)),
        catch: () => reject('unsupported-input'),
      });
      const manifest = yield* Schema.decodeUnknownEffect(CacheManifest, {onExcessProperty: 'error'})(parsed).pipe(
        Effect.mapError(() => reject('unsupported-input')),
      );
      if (manifest.build !== build) return yield* reject('unsupported-input');
      const declared = new Set<string>(['manifest.json']);
      for (const notice of manifest.notices) {
        if (
          !EffectString.startsWith('notices/')(notice.path) ||
          EffectString.split('/')(notice.path).includes('..') ||
          declared.has(notice.path) ||
          !files.has(notice.path) ||
          sha256HexSync(files.get(notice.path)!) !== notice.sha256
        )
          return yield* reject('unsupported-input');
        declared.add(notice.path);
      }
      for (const artifact of manifest.artifacts) {
        if (
          !EffectString.startsWith(build === 'maven' ? 'm2/' : 'gradle/')(artifact.path) ||
          (build === 'gradle' &&
            !EffectString.startsWith('gradle/caches/')(artifact.path) &&
            !EffectString.startsWith('gradle/native/')(artifact.path)) ||
          EffectString.split('/')(artifact.path).includes('..') ||
          declared.has(artifact.path) ||
          !EffectString.startsWith('notices/')(artifact.notice) ||
          !declared.has(artifact.notice) ||
          !files.has(artifact.path) ||
          sha256HexSync(files.get(artifact.path)!) !== artifact.sha256
        )
          return yield* reject('unsupported-input');
        declared.add(artifact.path);
      }
      if (files.size !== declared.size) return yield* reject('unsupported-input');
      inventory.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return {
        binding: {...input, imageDigest: sha256HexSync(JSON.stringify(['java-import-cache-image-v1', inventory]))},
        files,
      };
    }),
  );
});

const trustedConfiguration = (
  candidate: JavaRuntimeCandidate,
  build: 'maven' | 'gradle',
  gradle?: typeof JavaPreparationGradle.Type,
) => ({
  version: 'private-java-import-bootstrap-v1' as const,
  digest: sha256HexSync(
    JSON.stringify([
      'private-java-import-bootstrap-v1',
      build,
      javaRuntimePinsForHost()?.configurationDigest ?? null,
      candidate.serverTreeDigest,
      build === 'maven'
        ? javaMavenBootstrapContractDigest(candidate.projectJavaHome)
        : gradle
          ? [javaGradleOwnedImport, gradle.sdkDirectory, gradle.sdkDigest]
          : 'gradle-owner-not-qualified',
      'workspace/.mvn:empty',
      'private-HOME-user.home-TMP-settings-cache',
      'offline-operational-not-sandbox',
      javaPreparationOwnerContract,
    ]),
  ),
});
/** Ordered closed body, with the predecessor CAS anchor outside the approved body. No digest cycle. */
export const javaTrustedImportPreviewDigest = (body: JavaTrustedImportPolicyBody, expectedDigest: string | null) =>
  sha256HexSync(
    JSON.stringify([
      'threadnote-java-import-approval-v1',
      body.mode,
      body.build,
      body.project,
      body.sourceDigest,
      body.scope.account,
      body.scope.user,
      body.scope.worktree,
      body.candidate.serverDirectory,
      body.candidate.serverTreeDigest,
      body.candidate.runtimeJavaHome,
      body.candidate.runtimeSdkDigest,
      body.candidate.projectJavaHome,
      body.candidate.projectSdkDigest,
      body.cacheImage.directory,
      body.cacheImage.manifestDigest,
      body.cacheImage.imageDigest,
      body.configuration.version,
      body.configuration.digest,
      body.risk.version,
      body.risk.digest,
      body.permissions.importer,
      body.permissions.repositoryCommands,
      body.permissions.sourceExecution,
      body.permissions.network,
      body.permissions.dependencies,
      body.permissions.plugins,
      body.permissions.annotationProcessors,
      body.permissions.gradle,
      body.permissions.filesystem,
      body.permissions.dataDisclosure,
      ...(body.gradle ? [body.gradle.sdkDirectory, body.gradle.sdkDigest] : []),
      expectedDigest,
    ]),
  );

interface EnforcementContract {
  readonly mode: JavaImportPolicy['mode'];
  readonly serverTreeDigest: string;
  readonly runtimeSdkDigest: string;
  readonly projectSdkDigest: string;
  readonly originalPomDigest: string;
  readonly ownerPlan: 'provider-tree';
}
// No pinned JDT/m2e implementation has yet passed the independent nonexecution/acquisition examination.
// Adding a row requires source review and actual exact-importer evidence; no JSON or service can supply a row.
const enforcementContracts: readonly EnforcementContract[] = Object.freeze([]);
const enforcedContract = (policy: JavaImportPolicy) =>
  EffectArray.findFirst(
    enforcementContracts,
    contract =>
      contract.mode === policy.mode &&
      contract.serverTreeDigest === policy.candidate.serverTreeDigest &&
      contract.runtimeSdkDigest === policy.candidate.runtimeSdkDigest &&
      contract.projectSdkDigest === policy.candidate.projectSdkDigest &&
      contract.originalPomDigest === sha256HexSync(javaImportCanonicalPom),
  );

const Common = {version: Schema.Literal(1), callerCwd: Schema.String};
const policyRequestFields = {
  ...Common,
  project: FileUri,
  candidate: JavaRuntimeCandidate,
  expectedDigest: Schema.optional(Digest),
  previewDigest: Schema.optional(Digest),
};
const PolicyRequest = Schema.Union([
  Schema.Struct({...policyRequestFields, mode: Schema.optional(Schema.Literal('maven21-dependency-free-v1'))}),
  Schema.Struct({
    ...policyRequestFields,
    mode: Schema.Literal(javaTrustedImportMode),
    build: Schema.Literals(['maven', 'gradle']),
    gradle: Schema.optional(JavaPreparationGradle),
    cacheImage: Schema.Struct({directory: FileUri, manifestDigest: Digest}),
  }),
]);
const RevokeRequest = Schema.Struct({...Common, expectedDigest: Digest});
const RunRequest = Schema.Struct(Common);
// This support gate is separate from denied-operation enforcement. Consent cannot prove build ownership.
interface TrustedImportContract {
  readonly build: 'maven' | 'gradle';
  readonly sourceDigest: string;
  readonly imageDigest: string;
  readonly configurationDigest: string;
  readonly serverTreeDigest: string;
  readonly runtimeSdkDigest: string;
  readonly projectSdkDigest: string;
  readonly ownerPlan: 'provider-tree' | 'provider-and-gradle-foreground';
}
// No real Maven model/cache/build-owner closure has yet been qualified. Gradle requires its own actual owner join.
const trustedImportContracts: readonly TrustedImportContract[] = Object.freeze([]);
const trustedContract = (policy: JavaImportPolicy) =>
  policy.mode === javaTrustedImportMode
    ? EffectArray.findFirst(
        trustedImportContracts,
        contract =>
          contract.build === policy.build &&
          contract.sourceDigest === policy.sourceDigest &&
          contract.imageDigest === policy.cacheImage.imageDigest &&
          contract.configurationDigest === policy.configuration.digest &&
          contract.serverTreeDigest === policy.candidate.serverTreeDigest &&
          contract.runtimeSdkDigest === policy.candidate.runtimeSdkDigest &&
          contract.projectSdkDigest === policy.candidate.projectSdkDigest,
      )
    : Option.none<TrustedImportContract>();
const cacheProtectedRoots = (root: string, candidate: JavaRuntimeCandidate) => [
  root,
  candidate.serverDirectory,
  candidate.runtimeJavaHome,
  candidate.projectJavaHome,
];
const verifyTrustedBinding = Effect.fn('semantic.verifyTrustedJavaImportBinding')(function* (
  config: RuntimeConfig,
  root: string,
  project: string,
  worktree: string,
  policy: JavaImportPolicy,
) {
  if (policy.mode !== javaTrustedImportMode) return yield* reject('denied');
  if (
    policy.scope.account !== config.account ||
    policy.scope.user !== config.user ||
    policy.scope.worktree !== worktree ||
    policy.configuration.digest !== trustedConfiguration(policy.candidate, policy.build, policy.gradle).digest ||
    javaTrustedImportPreviewDigest(policy, policy.approval.expectedDigest) !== policy.approval.previewDigest
  )
    return yield* reject('stale');
  if ((policy.build === 'gradle') !== (policy.gradle !== undefined)) return yield* reject('unsupported-input');
  if (policy.gradle) yield* verifyJavaGradleInstallation(policy.gradle);
  if ((yield* inspectTrustedJavaImportInputs(root, project)) !== policy.sourceDigest) return yield* reject('stale');
  const cache = yield* inspectJavaImportCache(
    policy.cacheImage,
    policy.build,
    cacheProtectedRoots(root, policy.candidate),
  );
  if (cache.binding.imageDigest !== policy.cacheImage.imageDigest) return yield* reject('stale');
});
const authorizations = new WeakMap<object, {readonly guard: Effect.Effect<void, unknown>}>();

/** Orders currentness reads only; it cannot mint authority or fill the enforcement registry. */
export const verifyJavaImportCurrentness = <E, R, E2, R2>(
  profileGuard: Effect.Effect<void, E, R>,
  verifyInputsAndRuntime: Effect.Effect<void, E2, R2>,
) => profileGuard.pipe(Effect.andThen(verifyInputsAndRuntime), Effect.andThen(profileGuard));

/** Concrete native/cache adapter. Only the private post-admission mint can supply its live token. */
const executeImport = Effect.fn('semantic.executeJavaImport')(function* (
  config: RuntimeConfig,
  root: string,
  project: string,
  worktree: string,
  profileDigest: string,
  policy: JavaImportPolicy,
  contract: {readonly ownerPlan: 'provider-tree' | 'provider-and-gradle-foreground'},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let verifyDisposed: Effect.Effect<void, unknown> | undefined;
  let launchAttempted = false;
  const profileGuard = Effect.gen(function* () {
    const current = yield* readSemanticHostProfile(config, worktree);
    if (current.digest !== profileDigest || JSON.stringify(current.profile.javaImport) !== JSON.stringify(policy))
      return yield* reject('stale');
  });
  const runtime = yield* makeJavaRuntime(policy.candidate);
  const guard = verifyJavaImportCurrentness(
    profileGuard,
    Effect.gen(function* () {
      if (policy.mode === javaTrustedImportMode) yield* verifyTrustedBinding(config, root, project, worktree, policy);
      else if ((yield* inspectJavaImportInputs(root, project)) !== policy.sourceDigest) return yield* reject('stale');
      yield* runtime.verify;
    }),
  );
  const descriptor = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* guard;
      const selected = yield* readSemanticHostProfile(config, worktree);
      const admission = yield* makeSemanticAdmission({directory: path.join(selected.home, 'semantic', 'admission-v1')});
      const owners = yield* makeJavaPreparationOwners(contract.ownerPlan);
      const reservation = yield* admission.acquire(sha256HexSync(worktree), 120000);
      const token = Object.freeze({});
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          authorizations.delete(token);
          const receipt = yield* owners.finish;
          const disposed =
            !launchAttempted || (verifyDisposed !== undefined && Exit.isSuccess(yield* Effect.exit(verifyDisposed)));
          yield* reservation.release(receipt.drained && receipt.stdioClosed && disposed);
        }).pipe(Effect.orDie),
      );
      yield* guard; // Queue waiting cannot preserve a stale policy.
      authorizations.set(token, {
        guard: guard.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(EffectDigest.Digest, yield* EffectDigest.Digest),
        ),
      });
      const verifySetup = Effect.suspend(() => authorizations.get(token)?.guard ?? reject('denied'));
      const host: JavaPreparationHost = {
        verifySetup,
        verifyOwners: owners.verify,
        beforePreparationLaunch: () => {
          launchAttempted = true;
          owners.beforeLaunch('provider');
        },
        beforeGradleLaunch: () => {
          launchAttempted = true;
          owners.beforeLaunch('gradle-foreground');
        },
        captureGradleForeground: originalFinish => owners.capture('gradle-foreground', originalFinish),
        capturePreparationProvider: (_pid, originalFinish) => {
          owners.capture('provider', originalFinish);
        },
        onProviderStarted: pid => reservation.bindProvider(pid),
        provisionOfflineCache: context =>
          Effect.gen(function* () {
            verifyDisposed = context.verifyDisposed;
            for (const directory of [path.join(context.runtimeDirectory, 'm2'), context.gradleUserHome]) {
              const info = yield* fs.stat(directory);
              if (
                (yield* fs.realPath(directory)) !== directory ||
                info.type !== 'Directory' ||
                info.mode & 0o077 ||
                (yield* fs.readDirectory(directory)).length !== 0
              )
                return yield* LspFault.make({code: 'prerequisite'});
            }
            if (policy.mode === javaTrustedImportMode) {
              const image = yield* inspectJavaImportCache(
                policy.cacheImage,
                policy.build,
                cacheProtectedRoots(root, policy.candidate),
              );
              if (image.binding.imageDigest !== policy.cacheImage.imageDigest) return yield* reject('stale');
              for (const [relative, bytes] of image.files) {
                if (!EffectString.startsWith(policy.build === 'gradle' ? 'gradle/' : 'm2/')(relative)) continue;
                const file = path.join(context.runtimeDirectory, relative);
                yield* fs.makeDirectory(path.dirname(file), {recursive: true, mode: 0o700});
                if ((yield* fs.realPath(path.dirname(file))) !== path.dirname(file)) return yield* reject('stale');
                yield* fs.writeFile(file, bytes, {flag: 'wx', mode: 0o600});
                // Gradle's private working cache has mutable locks/indexes. Its exact source
                // image remains approval-bound and reverified by verifySetup; it is not a sealed output.
                if (policy.build === 'maven') yield* context.retainInput(file, sha256HexSync(bytes));
              }
            }
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path)),
        drainBuildProcesses: () =>
          owners.finish.pipe(
            Effect.flatMap(receipt =>
              receipt.drained && receipt.stdioClosed ? Effect.succeed({drained: true}) : LspFault.make({code: 'exit'}),
            ),
          ),
      };
      const privateDirectory = path.join(selected.home, 'semantic', 'java-import');
      const artifactDirectory = path.join(privateDirectory, 'artifacts');
      for (const directory of [privateDirectory, artifactDirectory])
        yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
      const operation = makeJavaPreparation(
        {
          project,
          worktree: root,
          candidate: policy.candidate,
          privateDirectory,
          artifactDirectory,
          build: policy.mode === javaTrustedImportMode ? policy.build : 'maven',
          ...(policy.mode === javaTrustedImportMode && policy.gradle ? {gradle: policy.gradle} : {}),
        },
        host,
      ).pipe(Effect.tap(() => verifySetup));
      // A failing scoped watchdog interrupts the operation and joins its original native finalization.
      const watchdog = Effect.forever(Effect.sleep(250).pipe(Effect.andThen(profileGuard)));
      return yield* Effect.raceFirst(operation, watchdog);
    }),
  ).pipe(
    // Admission release may yield after the engine/watchdog complete. Fence success and failure cleanup.
    Effect.onExit(() => guard.pipe(Effect.interruptible)),
  );
  return descriptor;
});

/** Local CLI composition only. JSON cannot choose privileged dispatch or assert local intent. */
export const runSemanticJavaImport = Effect.fn('semantic.javaImport')(function* (
  config: RuntimeConfig,
  input: unknown,
  action: 'preview' | 'apply' | 'revoke' | 'run',
  localIntent = false,
  acknowledgeUnconfinedBuildImport = false,
) {
  const operation = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parsed = yield* Schema.decodeUnknownEffect(
      action === 'revoke' ? RevokeRequest : action === 'run' ? RunRequest : PolicyRequest,
      {onExcessProperty: 'error'},
    )(input).pipe(Effect.mapError(() => reject('invalid-request')));
    if (!path.isAbsolute(parsed.callerCwd)) return yield* reject('invalid-request');
    const root = yield* fs.realPath(parsed.callerCwd);
    const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
    if ((action === 'apply' || action === 'revoke' || action === 'run') && !localIntent) return yield* reject('denied');
    const selected = yield* inspectSemanticHostProfile(config, worktree).pipe(
      Effect.catchTag('SemanticHostProfileFault', fault =>
        fault.reason === 'missing' ? Effect.void : Effect.fail(fault),
      ),
    );
    if (action === 'revoke') {
      const request = yield* Schema.decodeUnknownEffect(RevokeRequest, {onExcessProperty: 'error'})(input);
      const written = yield* writeSemanticJavaImportPolicy(config, worktree, undefined, request.expectedDigest);
      return {version: 1, action, state: 'revoked', profileDigest: written.digest, changed: written.changed};
    }
    if (action === 'run') {
      if (!selected?.profile.enabled || !selected.profile.javaImport) return yield* reject('denied');
      const policy = selected.profile.javaImport;
      const project = yield* path.fromFileUrl(new URL(policy.project));
      const contract = policy.mode === javaTrustedImportMode ? trustedContract(policy) : enforcedContract(policy);
      if (policy.mode === javaTrustedImportMode) {
        if (policy.build === 'gradle' && !policy.gradle) return yield* reject('import-support-unavailable');
        yield* verifyTrustedBinding(config, root, project, worktree, policy);
        if (contract._tag === 'None') return yield* reject('import-support-unavailable');
      } else {
        if ((yield* inspectJavaImportInputs(root, project)) !== policy.sourceDigest) return yield* reject('stale');
        if (contract._tag === 'None') return yield* reject('enforcement-unavailable');
      }
      const descriptor = yield* executeImport(config, root, project, worktree, selected.digest, policy, contract.value);
      return {version: 1, action, state: 'prepared', descriptor};
    }
    const request = yield* Schema.decodeUnknownEffect(PolicyRequest, {onExcessProperty: 'error'})(input);
    const project = yield* path.fromFileUrl(new URL(request.project));
    if (request.mode === javaTrustedImportMode && action === 'apply' && !acknowledgeUnconfinedBuildImport)
      return yield* reject('denied');
    // A Gradle grant cannot be complete before its vetted SDK and original build-owner join exist.
    if (request.mode === javaTrustedImportMode && request.build === 'gradle' && !request.gradle)
      return yield* reject('import-support-unavailable');
    const sourceDigest = yield* request.mode === javaTrustedImportMode
      ? inspectTrustedJavaImportInputs(root, project)
      : inspectJavaImportInputs(root, project);
    // Standalone runtime verification needs no preexisting JavaHostCandidate/environment.
    const runtime = yield* makeJavaRuntime(request.candidate);
    yield* runtime.verify;
    if (request.mode === javaTrustedImportMode) {
      if ((request.build === 'gradle') !== (request.gradle !== undefined)) return yield* reject('unsupported-input');
      if (request.gradle) yield* verifyJavaGradleInstallation(request.gradle);
      const cache = yield* inspectJavaImportCache(
        request.cacheImage,
        request.build,
        cacheProtectedRoots(root, request.candidate),
      );
      if ((yield* inspectTrustedJavaImportInputs(root, project)) !== sourceDigest) return yield* reject('stale');
      const body: JavaTrustedImportPolicyBody = {
        version: 1,
        mode: javaTrustedImportMode,
        build: request.build,
        ...(request.gradle ? {gradle: request.gradle} : {}),
        project: request.project,
        sourceDigest,
        candidate: request.candidate,
        scope: {account: config.account, user: config.user, worktree},
        cacheImage: cache.binding,
        configuration: trustedConfiguration(request.candidate, request.build, request.gradle),
        risk: {version: javaTrustedImportRiskVersion, digest: sha256HexSync(javaTrustedImportRisk)},
        permissions: javaTrustedImportPermissions,
      };
      const expectedDigest = selected?.digest ?? null;
      const previewDigest = javaTrustedImportPreviewDigest(body, expectedDigest);
      const policy: JavaImportPolicy = {...body, approval: {expectedDigest, previewDigest}};
      if (action === 'apply') {
        if (request.previewDigest !== previewDigest || request.expectedDigest !== selected?.digest)
          return yield* reject('stale');
        const written = yield* writeSemanticJavaImportPolicy(config, worktree, policy, request.expectedDigest);
        return {version: 1, action, state: 'configured', profileDigest: written.digest, changed: written.changed};
      }
      return {
        version: 1,
        action,
        state: 'preview',
        worktree,
        policy,
        expectedDigest,
        previewDigest,
        riskStatement: javaTrustedImportRisk,
        authority:
          'Explicit unconfined OS-user build authority; caller-asserted local consent, not human authentication',
        execution: trustedContract(policy)._tag === 'Some' ? 'supported-owned-import' : 'import-support-unavailable',
        nextAction:
          'Apply requires --authorize-import AND --acknowledge-unconfined-build-import with exact previewDigest/expectedDigest. Native build ownership/model/cache/platform qualification remains required.',
      };
    }
    if ((yield* inspectJavaImportInputs(root, project)) !== sourceDigest) return yield* reject('stale');
    const policy: JavaImportPolicy = {
      version: 1,
      mode: 'maven21-dependency-free-v1',
      project: request.project,
      sourceDigest,
      candidate: request.candidate,
      permissions,
    };
    const preview = {worktree, policy, expectedDigest: selected?.digest ?? null};
    const previewDigest = sha256HexSync(JSON.stringify(preview));
    if (action === 'apply') {
      if (request.previewDigest !== previewDigest || request.expectedDigest !== selected?.digest)
        return yield* reject('stale');
      const written = yield* writeSemanticJavaImportPolicy(config, worktree, policy, request.expectedDigest);
      return {version: 1, action, state: 'configured', profileDigest: written.digest, changed: written.changed};
    }
    return {
      version: 1,
      action,
      state: 'preview',
      ...preview,
      previewDigest,
      versions: {
        server: javaRuntimeQualification.serverVersion,
        runtime: javaRuntimeQualification.runtimeVersion,
        project: javaRuntimeQualification.projectVersion,
      },
      operation: 'Import unchanged original dependency-free Maven project into a private copy',
      enforcement: enforcedContract(policy)._tag === 'Some' ? 'finite-application-profile' : 'unavailable',
      authority:
        'Caller-asserted same-user local intent; no writer grant. Finite application policy, not a machine sandbox',
      nextAction:
        'Apply requires --authorize-import and the exact previewDigest/expectedDigest; import remains blocked without independently reviewed pinned-importer enforcement',
    };
  });
  return yield* operation.pipe(
    Effect.catch(error =>
      Effect.succeed({
        version: 1,
        action,
        state: Schema.is(JavaImportFault)(error)
          ? error.reason
          : Schema.is(SemanticHostProfileFault)(error)
            ? error.reason
            : 'unavailable',
        nextAction:
          'Inspect current private policy and original inputs; missing enforcement or owned-build support proof refuses before provisioning, admission or provider launch. Maven/Gradle and platform qualification remain incomplete',
      }),
    ),
  );
});
