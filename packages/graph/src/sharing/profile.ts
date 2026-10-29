import {Schema} from 'effect';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {graphSharingFailure} from './errors.js';
import {SHA256_DIGEST, SHA256_HEX, sha256Digest, type Sha256Digest} from './digest.js';
import {
  isGraphShareRegistryReference,
  parseGraphShareRegistryTarget,
  type GraphShareRegistryTarget,
} from './registry/reference.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const STRICT = {errors: 'all', onExcessProperty: 'error'} as const;
const ORGANIZATION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const GIT_REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,255}$/u;
const COORDINATOR_URL =
  /^(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:127\.0\.0\.1|localhost))(?::\d{1,5})?(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]*)?$/u;
const CAS_REGISTRY = /^cas:\/\/local(?:\/(?:canonical|worker))?$/u;
const CAS_PROFILE = /^cas:\/\/sha256:[0-9a-f]{64}$/u;
const CANONICAL_REMOTE = /^[a-z0-9.-]+\/[A-Za-z0-9._/-]+$/u;

const HexId = Schema.String.check(Schema.isPattern(SHA256_HEX));
const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const NonEmptyShort = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const GRAPH_SHARE_ENROLLMENT_SCHEMA_VERSION = 1 as const;
export const GRAPH_SHARE_ENROLLMENT_OCI_SCHEMA_VERSION = 2 as const;
export const GRAPH_SHARE_PROFILE_SCHEMA_VERSION = 1 as const;

export const GraphShareEnrollmentSchemaV1 = Schema.Struct({
  profile: Schema.String.check(Schema.isPattern(CAS_PROFILE)),
  publisherKeyFingerprint: Digest,
  repositoryId: HexId,
  schemaVersion: Schema.Literal(GRAPH_SHARE_ENROLLMENT_SCHEMA_VERSION),
});

export type GraphShareEnrollmentV1 = typeof GraphShareEnrollmentSchemaV1.Type;

export const GraphShareEnrollmentSchemaV2 = Schema.Struct({
  profile: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(600)),
  profileDigest: Digest,
  publisherKeyFingerprint: Digest,
  repositoryId: HexId,
  schemaVersion: Schema.Literal(GRAPH_SHARE_ENROLLMENT_OCI_SCHEMA_VERSION),
});

export type GraphShareEnrollmentV2 = typeof GraphShareEnrollmentSchemaV2.Type;
export type GraphShareEnrollment = GraphShareEnrollmentV1 | GraphShareEnrollmentV2;

const RegistryReference = Schema.String.check(
  Schema.makeFilter(value => CAS_REGISTRY.test(value) || isGraphShareRegistryReference(value)),
);

export const GraphShareProfileSchemaV1 = Schema.Struct({
  contribution: Schema.Struct({
    activeOnlyOnAcPower: Schema.Boolean,
    activeOnlyWhenIdle: Schema.Boolean,
    defaultMode: Schema.Literals(['off', 'passive', 'idle', 'dedicated']),
    maximumCpus: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(64)),
    maximumMemoryBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    maximumUploadBytesPerSecond: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  coordinator: Schema.optionalKey(
    Schema.Struct({
      url: Schema.String.check(Schema.isPattern(COORDINATOR_URL)),
    }),
  ),
  frontier: Schema.Struct({
    batchMaximumAgeSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    batchMaximumChangedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    batchMaximumChangedFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    compactAfterDeltaBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    compactAfterDeltas: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    compactAfterSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    targetMaximumLagSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  organization: Schema.String.check(Schema.isPattern(ORGANIZATION)),
  registry: Schema.Struct({
    canonical: RegistryReference,
    worker: RegistryReference,
  }),
  repositoryId: HexId,
  retention: Schema.Struct({
    checkpointCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32)),
    workMaximumAgeSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  schemaVersion: Schema.Literal(GRAPH_SHARE_PROFILE_SCHEMA_VERSION),
  source: Schema.Struct({
    branches: Schema.Array(Schema.String.check(Schema.isPattern(GIT_REF))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
    canonicalRemote: Schema.String.check(Schema.isPattern(CANONICAL_REMOTE), Schema.isMaxLength(512)),
  }),
  trust: Schema.Struct({
    contributorPolicy: NonEmptyShort,
    publisherKeys: Schema.Array(Digest).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
});

export type GraphShareProfileV1 = typeof GraphShareProfileSchemaV1.Type;

export type GraphShareProfilePointer =
  | {readonly kind: 'cas'; readonly bodyDigest: Sha256Digest}
  | {
      readonly kind: 'oci';
      readonly manifestDigest: Sha256Digest;
      readonly registryReference: string;
      readonly registryTarget: GraphShareRegistryTarget;
    };

export function parseGraphShareEnrollment(value: unknown): GraphShareEnrollment {
  try {
    const enrollment = Schema.decodeUnknownSync(
      Schema.Union([GraphShareEnrollmentSchemaV1, GraphShareEnrollmentSchemaV2]),
      STRICT,
    )(value);
    if (enrollment.schemaVersion === 2 && parseGraphShareProfilePointer(enrollment.profile).kind !== 'oci')
      throw new Error('OCI enrollment requires an OCI profile artifact');
    return enrollment;
  } catch (cause) {
    throw graphSharingFailure('Enrollment pointer is invalid.', cause);
  }
}

function isSha256Digest(value: string): value is Sha256Digest {
  return SHA256_DIGEST.test(value);
}

export function parseGraphShareProfile(value: unknown): GraphShareProfileV1 {
  try {
    return Schema.decodeUnknownSync(GraphShareProfileSchemaV1, STRICT)(value);
  } catch (cause) {
    throw graphSharingFailure('Organization graph profile is invalid.', cause);
  }
}

export function graphShareProfileDigest(profile: GraphShareProfileV1): Sha256Digest {
  return sha256Digest(canonicalJson(profile));
}

export function parseGraphShareProfilePointer(value: string): GraphShareProfilePointer {
  if (CAS_PROFILE.test(value)) {
    return {bodyDigest: `sha256:${Effect.pipe(value, EffectString.slice('cas://sha256:'.length))}`, kind: 'cas'};
  }
  const at = Effect.pipe(
    value,
    EffectString.lastIndexOf('@'),
    Effect.Option.getOrElse(() => -1),
  );
  const registryReference = Effect.pipe(value, EffectString.slice(0, at));
  const manifestDigest = Effect.pipe(value, EffectString.slice(at + 1));
  if (at > 0 && isSha256Digest(manifestDigest)) {
    try {
      const registryTarget = parseGraphShareRegistryTarget(registryReference);
      if (registryReference === `oci://${registryTarget.registry}/${registryTarget.repository}`)
        return {
          kind: 'oci',
          manifestDigest,
          registryReference,
          registryTarget,
        };
    } catch {
      throw graphSharingFailure('Enrollment profile pointer must be a digest-pinned cas:// or oci:// reference.');
    }
  }
  throw graphSharingFailure('Enrollment profile pointer must be a digest-pinned cas:// or oci:// reference.');
}

export function ociProfilePointer(registryReference: string, manifestDigest: Sha256Digest): string {
  const target = parseGraphShareRegistryTarget(registryReference);
  if (registryReference !== `oci://${target.registry}/${target.repository}` || !SHA256_DIGEST.test(manifestDigest))
    throw graphSharingFailure('OCI profile pointer is invalid.');
  return `${registryReference}@${manifestDigest}`;
}

export function enrolledProfileBodyDigest(enrollment: GraphShareEnrollment): Sha256Digest {
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  if (enrollment.schemaVersion === 1 && pointer.kind === 'cas') return pointer.bodyDigest;
  if (enrollment.schemaVersion === 2 && pointer.kind === 'oci' && isSha256Digest(enrollment.profileDigest))
    return enrollment.profileDigest;
  throw graphSharingFailure('Enrollment profile pointer is invalid.');
}

export function parseGraphShareCoordinatorUrl(value: string): string {
  const trimmed = trimTrailingCharacters(Effect.pipe(value, EffectString.trim), '/');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (cause) {
    throw graphSharingFailure('Coordinator URL is invalid.', cause);
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol === 'http:' && !loopback) {
    throw graphSharingFailure('HTTP coordinator URLs must be loopback.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw graphSharingFailure('Coordinator URL must be https or loopback http.');
  }
  if (!COORDINATOR_URL.test(trimmed)) {
    throw graphSharingFailure('Coordinator URL is invalid.');
  }
  const port = parsed.port.length === 0 ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw graphSharingFailure('Coordinator URL port is invalid.');
  }
  return trimmed;
}

export function casProfilePointer(digest: Sha256Digest): string {
  return `cas://${digest}`;
}

export function defaultGraphShareProfile(input: {
  readonly branch: string;
  readonly canonicalRemote: string;
  readonly coordinatorUrl?: string;
  readonly organization: string;
  readonly publisherKeyFingerprint: Sha256Digest;
  readonly repositoryId: string;
}): GraphShareProfileV1 {
  return {
    contribution: {
      activeOnlyOnAcPower: true,
      activeOnlyWhenIdle: true,
      defaultMode: 'passive',
      maximumCpus: 2,
      maximumMemoryBytes: 4_294_967_296,
      maximumUploadBytesPerSecond: 1_048_576,
    },
    ...(input.coordinatorUrl === undefined
      ? {}
      : {coordinator: {url: parseGraphShareCoordinatorUrl(input.coordinatorUrl)}}),
    frontier: {
      batchMaximumAgeSeconds: 30,
      batchMaximumChangedBytes: 104_857_600,
      batchMaximumChangedFiles: 1_000,
      compactAfterDeltaBytes: 1_073_741_824,
      compactAfterDeltas: 16,
      compactAfterSeconds: 21_600,
      targetMaximumLagSeconds: 120,
    },
    organization: input.organization,
    registry: {
      canonical: 'cas://local',
      worker: 'cas://local/worker',
    },
    repositoryId: input.repositoryId,
    retention: {
      checkpointCount: 3,
      workMaximumAgeSeconds: 2_592_000,
    },
    schemaVersion: GRAPH_SHARE_PROFILE_SCHEMA_VERSION,
    source: {
      branches: [
        Effect.pipe(input.branch, EffectString.startsWith('refs/')) ? input.branch : `refs/heads/${input.branch}`,
      ],
      canonicalRemote: input.canonicalRemote,
    },
    trust: {
      contributorPolicy: 'explicit-join',
      publisherKeys: [input.publisherKeyFingerprint],
    },
  };
}

export function assertEnrollmentMatchesIdentity(enrollment: GraphShareEnrollment, repositoryId: string): void {
  if (enrollment.repositoryId !== repositoryId) {
    throw graphSharingFailure('Enrollment repositoryId does not match the credential-free checkout identity.');
  }
}

export function assertProfileMatchesEnrollment(
  profile: GraphShareProfileV1,
  enrollment: GraphShareEnrollment,
  digest: Sha256Digest,
): void {
  if (enrolledProfileBodyDigest(enrollment) !== digest) {
    throw graphSharingFailure('Profile digest does not match the enrollment pointer.');
  }
  if (profile.repositoryId !== enrollment.repositoryId) {
    throw graphSharingFailure('Profile repositoryId does not match the enrollment pointer.');
  }
  if (!profile.trust.publisherKeys.includes(enrollment.publisherKeyFingerprint)) {
    throw graphSharingFailure('Enrollment publisher key is not listed in the profile.');
  }
}
