import {Effect, FileSystem, Path, Schema} from 'effect';
import {fromPromise} from '@threadnote/platform/errors';
import {
  fileSystemModeIsPrivate,
  runtimeLstat,
  runtimeReadBoundedStableRegularFile,
  SystemInfo,
  type SystemInfoShape,
  type RuntimeBigIntStats,
} from '@threadnote/platform/system';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {effectiveGraphShareContributionMode} from '../contribution.js';
import {parseSha256Digest, SHA256_DIGEST, SHA256_HEX, type Sha256Digest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {
  graphShareProfileDigest,
  parseGraphShareCoordinatorUrl,
  parseGraphShareProfilePointer,
  type GraphShareEnrollmentV2,
  type GraphShareProfileV1,
} from '../profile.js';
import {isGraphShareRegistryReference, parseGraphShareRegistryTarget} from '../registry/reference.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const STRICT = {errors: 'all', onExcessProperty: 'error'} as const;
const APPROVAL_MAX_BYTES = 16_384;
const ORGANIZATION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CANONICAL_REMOTE = /^[a-z0-9.-]+\/[A-Za-z0-9._/-]+$/u;
const GIT_REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,255}$/u;
const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const Registry = Schema.String.check(Schema.makeFilter(isGraphShareRegistryReference));

const ManagedApprovalSchema = Schema.Struct({
  accessMode: Schema.Literals(['join', 'read-only']),
  contribution: Schema.Struct({
    declared: Schema.Struct({
      activeOnlyOnAcPower: Schema.Boolean,
      activeOnlyWhenIdle: Schema.Boolean,
      defaultMode: Schema.Literals(['off', 'passive', 'idle', 'dedicated']),
      maximumCpus: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(64)),
      maximumMemoryBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      maximumUploadBytesPerSecond: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    effectiveMode: Schema.Literals(['off', 'passive-on-index']),
  }),
  coordinatorUrl: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  organization: Schema.String.check(Schema.isPattern(ORGANIZATION)),
  profileDigest: Digest,
  publisherKeyFingerprint: Digest,
  registry: Schema.Struct({
    canonical: Registry,
    worker: Registry,
  }),
  repositoryId: Schema.String.check(Schema.isPattern(SHA256_HEX)),
  schemaVersion: Schema.Literal(1),
  source: Schema.Struct({
    branches: Schema.Array(Schema.String.check(Schema.isPattern(GIT_REF))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
    canonicalRemote: Schema.String.check(Schema.isPattern(CANONICAL_REMOTE), Schema.isMaxLength(512)),
  }),
});

export type GraphShareManagedApprovalV1 = typeof ManagedApprovalSchema.Type;

export interface GraphShareApprovedRoot {
  readonly profileDigest: Sha256Digest;
  readonly publisherKeyFingerprint: Sha256Digest;
  readonly registryCanonical: string;
  readonly repositoryId: string;
}

export interface GraphShareManagedApprovalFile {
  readonly approvalPath: string;
  readonly gitCommonDirectory: string;
  readonly repoRoot: string;
}

export function parseGraphShareManagedApproval(value: unknown): GraphShareManagedApprovalV1 {
  try {
    const approval = Schema.decodeUnknownSync(ManagedApprovalSchema, STRICT)(value);
    if (
      approval.coordinatorUrl !== null &&
      parseGraphShareCoordinatorUrl(approval.coordinatorUrl) !== approval.coordinatorUrl
    )
      throw new Error('noncanonical coordinator');
    return approval;
  } catch {
    throw graphSharingFailure('Managed graph approval is invalid.');
  }
}

export function assertGraphShareApprovalRoot(
  approval: GraphShareManagedApprovalV1,
  enrollment: GraphShareEnrollmentV2,
  remoteIdentity: string | undefined,
): GraphShareApprovedRoot {
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  if (
    pointer.kind !== 'oci' ||
    approval.repositoryId !== enrollment.repositoryId ||
    approval.profileDigest !== enrollment.profileDigest ||
    approval.publisherKeyFingerprint !== enrollment.publisherKeyFingerprint ||
    approval.registry.canonical !== pointer.registryReference ||
    approval.source.canonicalRemote !== remoteIdentity
  ) {
    throw graphSharingFailure('Managed graph approval does not match the enrolled repository and OCI authority.');
  }
  return {
    profileDigest: parseSha256Digest(approval.profileDigest),
    publisherKeyFingerprint: parseSha256Digest(approval.publisherKeyFingerprint),
    registryCanonical: pointer.registryReference,
    repositoryId: approval.repositoryId,
  };
}

export function assertGraphShareApprovedProfile(
  approval: GraphShareManagedApprovalV1,
  profile: GraphShareProfileV1,
  effectiveCoordinatorUrl: string | undefined,
): void {
  const mode = effectiveGraphShareContributionMode(approval.accessMode, profile.contribution.defaultMode);
  const effectiveMode = mode === 'off' ? 'off' : 'passive-on-index';
  if (
    profile.repositoryId !== approval.repositoryId ||
    profile.organization !== approval.organization ||
    graphShareProfileDigest(profile) !== approval.profileDigest ||
    !profile.trust.publisherKeys.includes(approval.publisherKeyFingerprint) ||
    profile.registry.canonical !== approval.registry.canonical ||
    profile.registry.worker !== approval.registry.worker ||
    profile.source.canonicalRemote !== approval.source.canonicalRemote ||
    canonicalJson(profile.source.branches) !== canonicalJson(approval.source.branches) ||
    canonicalJson(profile.contribution) !== canonicalJson(approval.contribution.declared) ||
    (effectiveCoordinatorUrl ?? null) !== approval.coordinatorUrl ||
    approval.contribution.effectiveMode !== effectiveMode
  ) {
    throw graphSharingFailure('Managed graph approval does not match the verified profile and effective policy.');
  }
  if (approval.accessMode === 'join') {
    const canonical = parseGraphShareRegistryTarget(profile.registry.canonical);
    const worker = parseGraphShareRegistryTarget(profile.registry.worker);
    if (
      effectiveCoordinatorUrl === undefined ||
      (canonical.origin === worker.origin && canonical.repository === worker.repository)
    ) {
      throw graphSharingFailure('Graph contribution needs an approved coordinator and separate worker registry.');
    }
  }
}

export const loadGraphShareManagedApprovalFile = Effect.fn('codeGraph.sharing.loadManagedApproval')(function* (
  input: GraphShareManagedApprovalFile,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (system.platform === 'win32')
    return yield* graphSharingFailure('Managed graph approval requires supported private-file ownership verification.');
  const target = input.approvalPath;
  if (!path.isAbsolute(target) || path.resolve(target) !== target || target.length > 4_096) {
    return yield* graphSharingFailure('Managed graph approval path must be absolute and canonical.');
  }
  const read = Effect.gen(function* () {
    const repoRoot = yield* fs.realPath(input.repoRoot);
    const gitRoot = yield* fs.realPath(input.gitCommonDirectory);
    const before = yield* inspectApprovalPath(target, repoRoot, gitRoot, path, system);
    const bytes = yield* fromPromise('codeGraph.sharing.readManagedApproval', () =>
      runtimeReadBoundedStableRegularFile(target, APPROVAL_MAX_BYTES),
    );
    const after = yield* inspectApprovalPath(target, repoRoot, gitRoot, path, system);
    if (!sameFile(before, after)) return yield* graphSharingFailure('Managed graph approval file changed during read.');
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    return parseGraphShareManagedApproval(value);
  });
  return yield* read.pipe(
    Effect.mapError(() => graphSharingFailure('Managed graph approval file is invalid or unavailable.')),
  );
});

function inspectApprovalPath(
  target: string,
  repoRoot: string,
  gitRoot: string,
  path: Path.Path,
  system: SystemInfoShape,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (
      (yield* fs.realPath(target)) !== target ||
      withinPath(path, repoRoot, target) ||
      withinPath(path, gitRoot, target)
    ) {
      return yield* graphSharingFailure('Managed graph approval path is not an external regular file.');
    }
    let directory = path.dirname(target);
    while (true) {
      const info = yield* fromPromise('codeGraph.sharing.lstatApprovalDirectory', () => runtimeLstat(directory));
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return yield* graphSharingFailure('Managed graph approval path contains a symbolic link.');
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const info = yield* fromPromise('codeGraph.sharing.lstatManagedApproval', () => runtimeLstat(target));
    const uid = (info as RuntimeBigIntStats & {readonly uid?: bigint}).uid;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !fileSystemModeIsPrivate(system.platform, Number(info.mode & 0o777n)) ||
      (system.platform !== 'win32' &&
        (system.userId === undefined || uid === undefined || uid !== BigInt(system.userId)))
    ) {
      return yield* graphSharingFailure('Managed graph approval file is not owned privately by this user.');
    }
    return info;
  });
}

function withinPath(path: Path.Path, parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !Effect2.pipe(relative, EffectString.startsWith(`..${path.sep}`)) &&
      !path.isAbsolute(relative))
  );
}

function sameFile(left: RuntimeBigIntStats, right: RuntimeBigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
