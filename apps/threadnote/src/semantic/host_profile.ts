import {Effect, FileSystem, Path, Schema, String as EffectString} from 'effect';
import {SecureRandom} from 'effect/crypto';
import {Digest} from '@threadnote/semantic/contracts';
import {JavaRuntimeCandidate} from './providers/java_runtime.js';
import {FileUri} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as Native from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {SemanticHostCatalog} from './host_catalog.js';
import {withExclusiveFileLockLease} from '@threadnote/platform/file/lock';

/** Policy data selects a finite local operation; it is never a serialized execution capability. */
const RestrictedJavaImportPolicy = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.Literal('maven21-dependency-free-v1'),
  project: FileUri,
  sourceDigest: Digest,
  candidate: JavaRuntimeCandidate,
  permissions: Schema.Struct({
    importer: Schema.Literal(true),
    repositoryCommands: Schema.Literal(false),
    sourceExecution: Schema.Literal(false),
    network: Schema.Literal(false),
    dependencies: Schema.Literal(false),
    plugins: Schema.Literal(false),
    annotationProcessors: Schema.Literal(false),
    gradle: Schema.Literal(false),
  }),
});
export const javaTrustedImportMode = 'trusted-java-build-import-unconfined-v1' as const;
export const javaTrustedImportRiskVersion = 'unconfined-build-import-risk-v1' as const;
export const javaTrustedImportRisk =
  'Trusted build import runs code from this exact project and its resolved build dependencies as your OS user. ' +
  'It can read or change files outside the private copy, including original files, SDKs and readable credentials, ' +
  'run programs, and contact arbitrary network destinations or transmit readable data. ' +
  'The private copy and offline flags are not a sandbox. Revocation stops owned work when observed and cannot undo prior effects. ' +
  'If you require filesystem, network or source-execution restrictions, use a separately qualified restricted mode or do not grant this mode.';
export const javaTrustedImportPermissions = Object.freeze({
  importer: true,
  repositoryCommands: true,
  sourceExecution: true,
  network: true,
  dependencies: true,
  plugins: true,
  annotationProcessors: true,
  gradle: true,
  filesystem: 'unconfined-os-user',
  dataDisclosure: 'unconfined-os-user-network',
} as const);
const trustedPolicyFields = {
  version: Schema.Literal(1),
  mode: Schema.Literal(javaTrustedImportMode),
  build: Schema.Literals(['maven', 'gradle']),
  project: FileUri,
  sourceDigest: Digest,
  candidate: JavaRuntimeCandidate,
  scope: Schema.Struct({account: Schema.String, user: Schema.String, worktree: FileUri}),
  cacheImage: Schema.Struct({directory: FileUri, manifestDigest: Digest, imageDigest: Digest}),
  configuration: Schema.Struct({version: Schema.Literal('private-java-import-bootstrap-v1'), digest: Digest}),
  risk: Schema.Struct({
    version: Schema.Literal(javaTrustedImportRiskVersion),
    digest: Schema.Literal(sha256HexSync(javaTrustedImportRisk)),
  }),
  permissions: Schema.Struct({
    importer: Schema.Literal(true),
    repositoryCommands: Schema.Literal(true),
    sourceExecution: Schema.Literal(true),
    network: Schema.Literal(true),
    dependencies: Schema.Literal(true),
    plugins: Schema.Literal(true),
    annotationProcessors: Schema.Literal(true),
    gradle: Schema.Literal(true),
    filesystem: Schema.Literal('unconfined-os-user'),
    dataDisclosure: Schema.Literal('unconfined-os-user-network'),
  }),
};
export const JavaTrustedImportPolicyBody = Schema.Struct(trustedPolicyFields);
export type JavaTrustedImportPolicyBody = typeof JavaTrustedImportPolicyBody.Type;
export const JavaTrustedImportPolicy = Schema.Struct({
  ...trustedPolicyFields,
  // The predecessor is the approved CAS anchor, never the newly containing profile digest.
  approval: Schema.Struct({expectedDigest: Schema.NullOr(Digest), previewDigest: Digest}),
});
export type JavaTrustedImportPolicy = typeof JavaTrustedImportPolicy.Type;
export const JavaImportPolicy = Schema.Union([RestrictedJavaImportPolicy, JavaTrustedImportPolicy]);
export type JavaImportPolicy = typeof JavaImportPolicy.Type;

export const SemanticHostProfile = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  worktree: FileUri,
  catalog: SemanticHostCatalog,
  javaImport: Schema.optional(JavaImportPolicy),
});
export class SemanticHostProfileFault extends Schema.TaggedError<
  SemanticHostProfileFault,
  {readonly brand: unique symbol}
>()('SemanticHostProfileFault', {
  reason: Schema.Literals([
    'missing',
    'disabled',
    'incompatible',
    'untrusted',
    'invalid',
    'unsupported-platform',
    'indeterminate',
  ]),
}) {}

export const semanticHostProfileName = (config: Pick<RuntimeConfig, 'account' | 'user'>, worktree: string) =>
  sha256HexSync(JSON.stringify([config.account, config.user, worktree])) + '.json';

const reject = (reason: typeof SemanticHostProfileFault.prototype.reason) => SemanticHostProfileFault.make({reason});
const native = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: error =>
      Schema.is(SemanticHostProfileFault)(error)
        ? error
        : reject(
            Schema.is(Native.RuntimeWriterFault)(error) && error.reason === 'unsupported-platform'
              ? 'unsupported-platform'
              : 'untrusted',
          ),
  });

const profileLocation = Effect.fn('semantic.profileLocation')(function* (
  config: RuntimeConfig,
  worktree: string,
  create = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!Schema.is(FileUri)(worktree)) return yield* reject('invalid');
  const home =
    create && Native.runtimePlatform === 'win32' && !(yield* fs.exists(config.agentContextHome))
      ? path.resolve(config.agentContextHome)
      : yield* fs.realPath(config.agentContextHome);
  const root = yield* path.fromFileUrl(new URL(worktree));
  if (
    home !== path.resolve(config.agentContextHome) ||
    (yield* fs.realPath(root)) !== root ||
    (yield* fs.stat(root)).type !== 'Directory'
  )
    return yield* reject('untrusted');
  const directory = path.join(home, 'semantic', 'profiles');
  const name = semanticHostProfileName(config, worktree);
  const file = path.join(directory, name);
  if (file === root || EffectString.startsWith(root + path.sep)(file)) return yield* reject('untrusted');
  return {home, directory, name};
});

/** Descriptor traversal proves ownership, identity and ACL privacy before any private bytes are read or created. */
const openProfiles = Effect.fn('semantic.openProfiles')(function* (home: string, create: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const own = (operation: () => Native.RuntimePrivateWriterDirectory) =>
    Effect.acquireRelease(native(operation), directory =>
      Effect.sync(() => Native.runtimeClosePrivateWriterDirectory(directory)),
    );
  let directory = yield* own(() =>
    create && Native.runtimePlatform === 'win32'
      ? Native.runtimeProvisionPrivateWriterDirectory(home)
      : Native.runtimeOpenPrivateWriterDirectory(home),
  );
  for (const name of ['semantic', 'profiles']) {
    const parent = directory;
    if (!create && !(yield* fs.exists(path.join(parent.path, name)))) return yield* reject('missing');
    directory = yield* own(() => Native.runtimeOpenPrivateWriterChild(parent, name, create));
  }
  return directory;
});
const decodeProfile = Effect.fn('semantic.decodeHostProfile')(function* (bytes: Uint8Array, worktree: string) {
  const text = yield* Effect.try({
    try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes),
    catch: () => reject('invalid'),
  });
  const decoded = yield* Effect.try({try: () => JSON.parse(text), catch: () => reject('invalid')});
  if (typeof decoded === 'object' && decoded !== null && 'version' in decoded && decoded.version !== 1)
    return yield* reject('incompatible');
  const profile = yield* Schema.decodeUnknownEffect(SemanticHostProfile, {onExcessProperty: 'error'})(decoded).pipe(
    Effect.mapError(() => reject('invalid')),
  );
  if (profile.worktree !== worktree) return yield* reject('incompatible');
  return {profile, digest: sha256HexSync(text)};
});

/** Read desired host configuration only. Reads never create, migrate or repair setup state. */
export const inspectSemanticHostProfile = Effect.fn('semantic.inspectHostProfile')(function* (
  config: RuntimeConfig,
  worktree: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const location = yield* profileLocation(config, worktree);
      const directory = yield* openProfiles(location.home, false);
      const file = yield* native(() => Native.runtimeReadPrivateWriterFile(directory, location.name, 16 * 1024));
      if (!file) return yield* reject('missing');
      const selected = yield* decodeProfile(file.bytes, worktree);
      return {home: location.home, ...selected};
    }),
  );
});

/** Query admission remains enabled-only; operational inspection never grants analysis or writer authority. */
export const readSemanticHostProfile = Effect.fn('semantic.readHostProfile')(function* (
  config: RuntimeConfig,
  worktree: string,
) {
  const selected = yield* inspectSemanticHostProfile(config, worktree);
  if (!selected.profile.enabled) return yield* reject('disabled');
  return selected;
});

/** Explicit local setup only. Unknown configuration is never migrated, replaced or removed. */
const publishSemanticHostProfile = Effect.fn('semantic.publishHostProfile')(function* (
  config: RuntimeConfig,
  worktree: string,
  input: unknown,
  expectedDigest: string | undefined,
  policyMutation: boolean,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const random = yield* SecureRandom.SecureRandom;
      const profile = yield* Schema.decodeUnknownEffect(SemanticHostProfile, {onExcessProperty: 'error'})(input).pipe(
        Effect.mapError(() => reject('invalid')),
      );
      if (profile.worktree !== worktree) return yield* reject('incompatible');
      const location = yield* profileLocation(config, worktree, true);
      const text = JSON.stringify(profile);
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > 16 * 1024) return yield* reject('invalid');
      const directory = yield* openProfiles(location.home, true);
      const assertParentCurrent = () => Native.runtimeAssertPrivateWriterDirectoryCurrent(directory);
      return yield* withExclusiveFileLockLease(
        fs,
        (yield* Path.Path).join(location.directory, 'setup.lock'),
        {
          createParentDirectory: false,
          allowUnverifiedStaleRecovery: false,
          useCanonicalProcessStartIdentity: true,
          recoverReusedProcessIdImmediately: true,
          waitTimeoutMilliseconds: 2000,
          retryIntervalMilliseconds: 25,
          staleAfterMilliseconds: 30000,
          heartbeatIntervalMilliseconds: 1000,
          assertParentCurrent,
          privateDirectory: directory,
        },
        lease =>
          Effect.gen(function* () {
            const read = () => Native.runtimeReadPrivateWriterFile(directory, location.name, 16 * 1024);
            const previousFile = yield* native(read);
            const previous = previousFile ? yield* decodeProfile(previousFile.bytes, worktree) : undefined;
            yield* lease.assertCurrent;
            // The preserve-only guard runs under the same lease/CAS as the actual publication.
            if (!policyMutation && JSON.stringify(previous?.profile.javaImport) !== JSON.stringify(profile.javaImport))
              return yield* reject('incompatible');
            if (policyMutation && expectedDigest !== previous?.digest) return yield* reject('incompatible');
            if (previous && JSON.stringify(previous.profile) === text) return {digest: previous.digest, changed: false};
            if (expectedDigest !== previous?.digest) return yield* reject('incompatible');
            const nonce = EffectString.replaceAll('-', '')(yield* random.uuidV4());
            const published = yield* native(() =>
              Native.runtimePublishPrivateWriterFile(directory, location.name, bytes, {
                mode: previous ? 'replace' : 'exclusive',
                nonce,
                assertCurrentSync: () => {
                  lease.assertCurrentSync();
                  assertParentCurrent();
                  if (previous) {
                    const current = read();
                    if (
                      !current ||
                      sha256HexSync(new TextDecoder('utf-8', {fatal: true}).decode(current.bytes)) !== previous.digest
                    )
                      throw reject('incompatible');
                  }
                },
              }),
            );
            // Unknown publication is not proof of no write. Inspect the retained profile before any explicit retry.
            if (published.status !== 'published') return yield* reject('indeterminate');
            return {digest: sha256HexSync(text), changed: true};
          }),
      );
    }),
  );
});

/** Generic setup can preserve a policy, but cannot establish, widen or revoke one. */
export const writeSemanticHostProfile = (
  config: RuntimeConfig,
  worktree: string,
  input: unknown,
  expectedDigest?: string,
) => publishSemanticHostProfile(config, worktree, input, expectedDigest, false);

/** Dedicated same-user local CLI policy operation; caller intent is asserted, not human authentication. */
export const writeSemanticJavaImportPolicy = Effect.fn('semantic.writeJavaImportPolicy')(function* (
  config: RuntimeConfig,
  worktree: string,
  policy: JavaImportPolicy | undefined,
  expectedDigest: string | undefined,
) {
  const existing = yield* inspectSemanticHostProfile(config, worktree).pipe(
    Effect.catchTag('SemanticHostProfileFault', fault =>
      fault.reason === 'missing' ? Effect.void : Effect.fail(fault),
    ),
  );
  if (existing?.digest !== expectedDigest) return yield* reject('incompatible');
  if (!existing && !policy) return yield* reject('missing');
  const base = existing?.profile ?? {version: 1 as const, enabled: true, worktree, catalog: {}};
  const updated = {...base, javaImport: policy};
  return yield* publishSemanticHostProfile(config, worktree, updated, expectedDigest, true);
});

/** Existing host profile, authenticated through its actual private directory; never creates setup. */
export const readSemanticPrivateProfile = (home: string, principal: string, worktree: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!/^[a-f0-9]{64}$/u.test(principal)) return yield* reject('invalid');
      const directory = yield* openProfiles(home, false);
      const file = yield* native(() => Native.runtimeReadPrivateWriterFile(directory, principal + '.json', 16384));
      if (!file) return yield* reject('missing');
      const selected = yield* decodeProfile(file.bytes, worktree);
      if (!selected.profile.enabled) return yield* reject('disabled');
      return selected;
    }),
  );
