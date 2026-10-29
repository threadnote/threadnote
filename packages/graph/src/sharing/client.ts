import {Array as EffectArray} from 'effect';
import {Crypto, Effect, Exit, FileSystem, Option, Path, Schema} from 'effect';
import {importCodeGraphCheckpointSnapshot} from '@threadnote/graph/checkpoint/operations';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {encodeCodeGraphCheckpointPackV1} from '../checkpoint/pack.js';
import {SystemInfo} from '@threadnote/platform/system';
import {resolveRepositoryIdentity} from '../repository.js';
import type {CodeGraphProgress, RepositoryIdentity} from '../types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  parseGraphShareFrontierManifest,
  parseGraphShareFrontierPointer,
  type GraphShareFrontierManifestV1,
} from './artifacts.js';
import {decodeJsonBytes, readJsonFile, writePrivateJsonFile} from './atomic.js';
import {putCasBytes, readVerifiedCasBlob} from './cas.js';
import {ensureGraphShareCheckpointArtifact} from './checkpoint_cas.js';
import {GraphSharingError, graphSharingFailure, graphSharingUnavailable} from './errors.js';
import type {Sha256Digest} from './digest.js';
import {graphShareApplyBaseMatches, graphShareApplyIsAlreadyAtTarget} from './delta.js';
import {
  checkpointMetadataFromHeader,
  composeGraphShareTargetRecords,
  decodeGraphShareCheckpointBytes,
  writeTemporaryCheckpointPack,
} from './delta_pack.js';
import {assertGraphShareCommitChain, graphShareBlobExists, graphShareCommitIsAncestor} from './git.js';
import {graphShareControlGetFrontier, graphShareControlGetTag, mirrorCoordinatorCasBlob} from './control/client.js';
import {graphShareFrontierPointerFromOciDescriptor, parseGraphShareOciDescriptor} from './descriptor.js';
import {graphShareFrontierDiscoveryTag} from './namespace.js';
import {discoverGraphShareRegistryFrontier, makeGraphShareRegistryReader} from './registry/reader.js';
import {fetchGraphShareOciProfile, readTrustedGraphShareOciProfile} from './profile/client.js';
import {parseGraphShareRegistryTarget} from './registry/reference.js';
import {
  assertGraphShareApprovalRoot,
  assertGraphShareApprovedProfile,
  loadGraphShareManagedApprovalFile,
} from './profile/approval.js';
import {promptGraphShareOciProfileAccess, promptGraphShareOciTrustRoot} from './profile/consent.js';
import {ensureSharedGraphBlob as ensureSharedCasBlob, type GraphShareBlobSource} from './shared_blob.js';
import {
  effectiveGraphShareContributionPolicy,
  effectiveGraphShareContributionMode,
  readGraphShareContributionQueue,
} from './contribution.js';
import {readTrustedGraphShareContributionProfile} from './profile/storage.js';
import {graphShareEnrollmentPath, graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {planGraphWorkerActions, readAdvertisedGraphWorkerActions} from './worker.js';
import {
  assertEnrollmentMatchesIdentity,
  assertProfileMatchesEnrollment,
  enrolledProfileBodyDigest,
  graphShareProfileDigest,
  parseGraphShareCoordinatorUrl,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
  type GraphShareEnrollment,
  type GraphShareEnrollmentV2,
} from './profile.js';
import {
  readSharedGraphImportAttempt,
  readSharedGraphProvenance,
  removeSharedGraphProvenance,
  writeSharedGraphImportAttempt,
  writeSharedGraphProvenance,
  type SharedGraphImportAttemptV1,
} from './provenance.js';
import {
  lookupGraphShareTrustReceipt,
  isGraphShareAutoEnrollmentRevoked,
  readGraphShareClientState,
  removeGraphShareTrustReceipt,
  resolveGraphShareCasRoot,
  trustReceiptFromEnrollment,
  writeGraphShareRepositoryContributionMode,
  writeGraphShareTrustReceipt,
  type GraphShareAccessMode,
  type GraphShareTrustReceiptV1,
} from './trust.js';
import {legacyGraphShareContributionMode, resolveGraphShareRepositoryClient} from './client/state.js';
import {
  acceptGraphShareFrontier,
  assertGraphSharePredecessor,
  readAcceptedGraphShareFrontier,
  readAuthenticatedGraphShareFrontier,
  type GraphShareFrontierScope,
} from './frontier_acceptance.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface GraphShareJoinOptions {
  readonly approvalFile?: string;
  /** Internal ordinary-graph-use path; revoked approvals never reenroll. */
  readonly automatic?: boolean;
  readonly cas?: string;
  readonly coordinator?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly readOnly?: boolean;
}

export interface GraphShareLeaveOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly purge?: boolean;
}

export interface GraphShareStatusOptions {
  readonly cas?: string;
  readonly cwd?: string;
  readonly json?: boolean;
}

export interface SharedGraphImportRequest {
  readonly cwd: string;
  readonly identity: RepositoryIdentity;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly threadnoteHome: string;
}

export type SharedGraphImportSkipReason =
  | 'already-installed'
  | 'invalid-enrollment'
  | 'quarantined'
  | 'repository-mismatch'
  | 'trust-pin-mismatch'
  | 'unavailable'
  | 'unenrolled'
  | 'untrusted';

export type SharedGraphImportResult =
  | {
      readonly atGeneration: number;
      readonly checkpointDigest: Sha256Digest;
      readonly imported: true;
      readonly snapshotId: string;
    }
  | {
      readonly imported: false;
      readonly reason: SharedGraphImportSkipReason;
      readonly atGeneration?: number;
      readonly checkpointDigest?: Sha256Digest;
      readonly snapshotId?: string;
    };

const sharingProgress = (
  onProgress: SharedGraphImportRequest['onProgress'],
  subphase: 'applying-deltas' | 'building-local-overlay' | 'discovering-shared-base' | 'downloading-checkpoint',
) => (onProgress?.({phase: 'sharing', subphase}) ?? Effect.void).pipe(Effect.ignore);

const assertOciJoinScope = Effect.fn('codeGraph.sharing.assertOciJoinScope')(function* (
  profile: ReturnType<typeof parseGraphShareProfile>,
  identity: RepositoryIdentity,
  coordinatorUrl: string | undefined,
) {
  if (coordinatorUrl === undefined)
    return yield* graphSharingFailure('Graph contribution needs an approved coordinator URL.');
  const canonical = yield* decodeValue(
    parseGraphShareRegistryTarget,
    profile.registry.canonical,
    'Canonical OCI registry is invalid.',
  );
  const worker = yield* decodeValue(
    parseGraphShareRegistryTarget,
    profile.registry.worker,
    'Worker OCI registry is invalid.',
  );
  if (canonical.origin === worker.origin && canonical.repository === worker.repository)
    return yield* graphSharingFailure('Graph contribution needs distinct canonical and worker OCI registries.');
  if (identity.branch === undefined || !profile.source.branches.includes(`refs/heads/${identity.branch}`))
    return yield* graphSharingFailure('OCI profile does not authorize this checkout branch for contribution.');
});

export const runGraphShareJoin = Effect.fn('codeGraph.sharing.join')(function* (
  config: RuntimeConfig,
  options: GraphShareJoinOptions,
) {
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const previous = yield* lookupGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  if (options.automatic) {
    if (options.approvalFile === undefined)
      return yield* graphSharingFailure('Automatic OCI graph enrollment requires a managed approval file.');
    if (previous !== undefined)
      return {
        accessMode: previous.accessMode,
        organization: previous.organization,
        profileDigest: previous.profileDigest,
        type: 'code-graph-share-join' as const,
        version: 1 as const,
      };
  }
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas ?? previous?.client?.casRoot);
  const enrollment = yield* decodeValue(
    parseGraphShareEnrollment,
    yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)),
    'Enrollment pointer is invalid.',
  );
  yield* decodeValue(
    () => assertEnrollmentMatchesIdentity(enrollment, identity.repositoryId),
    undefined,
    'Enrollment repository identity is invalid.',
  );
  const pointer = yield* decodeValue(
    parseGraphShareProfilePointer,
    enrollment.profile,
    'Enrollment profile pointer is invalid.',
  );
  let profile: ReturnType<typeof parseGraphShareProfile>;
  let firstUseAccessMode: GraphShareAccessMode | undefined;
  let firstUseCoordinatorUrl: string | undefined;
  if (pointer.kind === 'oci') {
    if (enrollment.schemaVersion !== 2) return yield* graphSharingFailure('OCI enrollment must use schema version 2.');
    if (previous === undefined || options.approvalFile !== undefined) {
      const v2Enrollment: GraphShareEnrollmentV2 = enrollment;
      const approval =
        options.approvalFile === undefined
          ? undefined
          : yield* loadGraphShareManagedApprovalFile({
              approvalPath: options.approvalFile,
              repoRoot: identity.repoRoot,
              gitCommonDirectory: identity.gitCommonDirectory,
            });
      const root =
        approval === undefined
          ? {
              ...(yield* promptGraphShareOciTrustRoot({enrollment: v2Enrollment, json: options.json})),
              profileDigest: enrolledProfileBodyDigest(v2Enrollment),
              repositoryId: v2Enrollment.repositoryId,
            }
          : yield* decodeValue(
              () => assertGraphShareApprovalRoot(approval, v2Enrollment, identity.remoteIdentity),
              undefined,
              'Managed OCI root approval is invalid.',
            );
      const fetched = yield* fetchGraphShareOciProfile(casRoot, enrollment, root);
      profile = fetched.profile;
      const coordinatorFallback = options.coordinator ?? approval?.coordinatorUrl ?? undefined;
      const effectiveCoordinatorUrl =
        profile.coordinator?.url ??
        (coordinatorFallback === undefined
          ? undefined
          : yield* decodeValue(parseGraphShareCoordinatorUrl, coordinatorFallback, 'Coordinator URL is invalid.'));
      firstUseCoordinatorUrl = effectiveCoordinatorUrl;
      if (profile.source.canonicalRemote !== identity.remoteIdentity)
        return yield* graphSharingFailure('OCI profile source remote differs from this checkout.');
      if (approval === undefined) {
        firstUseAccessMode = yield* promptGraphShareOciProfileAccess({
          profile,
          effectiveCoordinatorUrl,
          readOnly: options.readOnly,
          json: options.json,
        });
      } else {
        yield* decodeValue(
          () => assertGraphShareApprovedProfile(approval, profile, effectiveCoordinatorUrl),
          undefined,
          'Managed OCI profile approval is invalid.',
        );
        firstUseAccessMode = approval.accessMode;
      }
      if (options.readOnly && firstUseAccessMode !== 'read-only')
        return yield* graphSharingFailure('Read-only join cannot approve graph contribution.');
      if (firstUseAccessMode === 'join') yield* assertOciJoinScope(profile, identity, effectiveCoordinatorUrl);
      const currentEnrollment = yield* decodeValue(
        parseGraphShareEnrollment,
        yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)),
        'Enrollment pointer changed during first-use approval.',
      );
      if (canonicalJson(currentEnrollment) !== canonicalJson(enrollment))
        return yield* graphSharingFailure('Enrollment pointer changed during first-use approval.');
      yield* putCasBytes(casRoot, fetched.manifest);
      yield* putCasBytes(casRoot, fetched.body);
    } else {
      profile = yield* readTrustedGraphShareOciProfile(casRoot, enrollment, previous);
      if (previous.accessMode === 'read-only' && !options.readOnly) {
        firstUseAccessMode = yield* promptGraphShareOciProfileAccess({
          profile,
          effectiveCoordinatorUrl: profile.coordinator?.url ?? options.coordinator ?? previous.client?.coordinatorUrl,
          json: options.json,
        });
      }
    }
  } else {
    if (options.approvalFile !== undefined || options.automatic)
      return yield* graphSharingFailure('Managed graph approval only supports OCI enrollment.');
    if (options.coordinator !== undefined) {
      const coordinatorUrl = parseGraphShareCoordinatorUrl(options.coordinator);
      yield* mirrorCoordinatorCasBlob(casRoot, coordinatorUrl, pointer.bodyDigest);
    }
    profile = yield* decodeJson(
      yield* readVerifiedCasBlob(casRoot, pointer.bodyDigest),
      parseGraphShareProfile,
      'Organization graph profile is invalid.',
    );
  }
  const profileDigest = graphShareProfileDigest(profile);
  yield* decodeValue(
    () => assertProfileMatchesEnrollment(profile, enrollment, profileDigest),
    undefined,
    'Profile does not match the enrollment pointer.',
  );
  const coordinatorUrl =
    firstUseCoordinatorUrl ??
    profile.coordinator?.url ??
    options.coordinator ??
    (previous?.profileDigest === profileDigest ? previous.client?.coordinatorUrl : undefined);
  const accessMode: GraphShareAccessMode = firstUseAccessMode ?? (options.readOnly ? 'read-only' : 'join');
  if (pointer.kind === 'oci' && previous !== undefined && options.approvalFile === undefined && accessMode === 'join')
    yield* assertOciJoinScope(profile, identity, coordinatorUrl);
  const contributionMode =
    previous?.accessMode === 'join' && previous.profileDigest === profileDigest && previous.client === undefined
      ? legacyGraphShareContributionMode(
          accessMode,
          (yield* readGraphShareClientState(config.agentContextHome)).contributionMode,
          profile.contribution.defaultMode,
        )
      : effectiveGraphShareContributionMode(accessMode, profile.contribution.defaultMode);
  const receipt = yield* writeGraphShareTrustReceipt(
    config.agentContextHome,
    {
      ...trustReceiptFromEnrollment(enrollment, profile, profileDigest, accessMode),
      client: {
        casRoot,
        contributionMode,
        ...(coordinatorUrl === undefined ? {} : {coordinatorUrl: parseGraphShareCoordinatorUrl(coordinatorUrl)}),
      },
    },
    {
      automatic: options.automatic,
      clearAutoEnrollmentRevocation: !options.automatic,
      preserveContributionMode: true,
    },
  );
  return {
    accessMode: receipt.accessMode,
    organization: receipt.organization,
    profileDigest: receipt.profileDigest,
    type: 'code-graph-share-join' as const,
    version: 1 as const,
  };
});

export const runGraphShareLeave = Effect.fn('codeGraph.sharing.leave')(function* (
  config: RuntimeConfig,
  options: GraphShareLeaveOptions,
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  yield* removeGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId, {revokeAutomatic: true});
  yield* removeSharedGraphProvenance(config.agentContextHome, identity.checkoutId);
  return {
    purged: true,
    repositoryId: identity.repositoryId,
    type: 'code-graph-share-leave' as const,
    version: 1 as const,
  };
});

export const runGraphShareStatus = Effect.fn('codeGraph.sharing.status')(function* (
  config: RuntimeConfig,
  options: GraphShareStatusOptions,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const enrollmentPath = graphShareEnrollmentPath(path, identity.repoRoot);
  const enrolled = yield* fs.exists(enrollmentPath);
  const enrollment = enrolled
    ? yield* readJsonFile(enrollmentPath).pipe(
        Effect.flatMap(value =>
          Effect.try({
            try: () => parseGraphShareEnrollment(value),
            catch: cause => graphSharingFailure('Enrollment pointer is invalid.', cause),
          }),
        ),
        Effect.option,
      )
    : Option.none();
  const enrollmentValid = Option.isSome(enrollment) && enrollment.value.repositoryId === identity.repositoryId;
  const trust = yield* lookupGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas ?? trust?.client?.casRoot);
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  const pointerPath = graphSharingFrontierPointerPath(path, layout.frontiersRoot, identity.repositoryId);
  let frontier: unknown;
  if (trust !== undefined && enrollmentValid) {
    const profile = yield* readVerifiedCasBlob(casRoot, trust.profileDigest).pipe(
      Effect.flatMap(bytes => decodeJson(bytes, parseGraphShareProfile, 'Organization graph profile is invalid.')),
      Effect.option,
    );
    if (
      Option.isSome(profile) &&
      graphShareProfileDigest(profile.value) === trust.profileDigest &&
      profile.value.repositoryId === identity.repositoryId &&
      profile.value.trust.publisherKeys.includes(trust.publisherKeyFingerprint)
    ) {
      const accepted = yield* readAcceptedGraphShareFrontier(config.agentContextHome, {
        branch: profile.value.source.branches[0] ?? 'refs/heads/main',
        profileDigest: trust.profileDigest,
        publisherKeyFingerprint: trust.publisherKeyFingerprint,
        repositoryId: identity.repositoryId,
      });
      if (accepted !== undefined) {
        frontier = {
          envelopeDigest: accepted.envelopeDigest,
          manifestDigest: accepted.manifestDigest,
          schemaVersion: accepted.schemaVersion,
        };
      }
    }
  }
  if (frontier === undefined && enrolled && (yield* fs.exists(pointerPath))) {
    frontier = yield* readJsonFile(pointerPath);
  }
  const lastImport = yield* readSharedGraphImportAttempt(config.agentContextHome, identity.checkoutId).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return {
    accessMode: trust?.accessMode,
    enrolled,
    enrollmentValid,
    organization: trust?.organization,
    profileDigest: trust?.profileDigest,
    repositoryId: identity.repositoryId,
    trusted: trust !== undefined,
    type: 'code-graph-share-status' as const,
    version: 1 as const,
    ...(frontier === undefined ? {} : {frontier}),
    ...(lastImport === undefined ? {} : {lastImport}),
  };
});

export const maybeImportSharedGraphBase = Effect.fn('codeGraph.sharing.maybeImportSharedBase')(function* (
  request: SharedGraphImportRequest,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* sharingProgress(request.onProgress, 'discovering-shared-base');
  const enrollmentPath = graphShareEnrollmentPath(path, request.identity.repoRoot);
  if (!(yield* fs.exists(enrollmentPath))) return {imported: false as const, reason: 'unenrolled' as const};
  const loaded = yield* readJsonFile(enrollmentPath).pipe(Effect.option);
  if (loaded._tag === 'None') return {imported: false as const, reason: 'invalid-enrollment' as const};
  const enrollment = yield* Effect.try({
    try: () => parseGraphShareEnrollment(loaded.value),
    catch: cause => graphSharingFailure('Enrollment pointer is invalid.', cause),
  }).pipe(Effect.option);
  if (enrollment._tag === 'None') return {imported: false as const, reason: 'invalid-enrollment' as const};
  if (enrollment.value.repositoryId !== request.identity.repositoryId) {
    return {imported: false as const, reason: 'repository-mismatch' as const};
  }
  let trust = yield* lookupGraphShareTrustReceipt(request.threadnoteHome, request.identity.repositoryId);
  if (trust === undefined && enrollment.value.schemaVersion === 2) {
    const system = yield* SystemInfo;
    const approvalFile = system.environment().THREADNOTE_GRAPH_APPROVAL_FILE;
    if (
      approvalFile !== undefined &&
      approvalFile.length > 0 &&
      !(yield* isGraphShareAutoEnrollmentRevoked(request.threadnoteHome, request.identity.repositoryId))
    ) {
      const approved = yield* runGraphShareJoin(runtimeConfigForHome(request.threadnoteHome), {
        approvalFile,
        automatic: true,
        cwd: request.cwd,
      }).pipe(Effect.option);
      if (Option.isSome(approved))
        trust = yield* lookupGraphShareTrustReceipt(request.threadnoteHome, request.identity.repositoryId);
    }
  }
  if (trust === undefined) return {imported: false as const, reason: 'untrusted' as const};
  const enrollmentPointer = yield* decodeValue(
    parseGraphShareProfilePointer,
    enrollment.value.profile,
    'Enrollment profile pointer is invalid.',
  ).pipe(Effect.option);
  if (enrollmentPointer._tag === 'None') return {imported: false as const, reason: 'invalid-enrollment' as const};
  if (
    trust.publisherKeyFingerprint !== enrollment.value.publisherKeyFingerprint ||
    trust.profileDigest !== enrolledProfileBodyDigest(enrollment.value)
  ) {
    return {imported: false as const, reason: 'trust-pin-mismatch' as const};
  }
  const casRoot = yield* resolveGraphShareCasRoot(request.threadnoteHome, trust.client?.casRoot);
  yield* sharingProgress(request.onProgress, 'downloading-checkpoint');
  return yield* importVerifiedSharedCheckpoint({
    casRoot,
    enrollment: enrollment.value,
    request,
    trust,
  }).pipe(
    Effect.catchIf(isUnavailableSharingFailure, () =>
      Effect.succeed({imported: false as const, reason: 'unavailable' as const}),
    ),
    Effect.catch(error =>
      quarantineSharedFailure(request.threadnoteHome, request.identity.repositoryId, error).pipe(
        Effect.as({imported: false as const, reason: 'quarantined' as const}),
      ),
    ),
  );
});

export const captureSharedGraphImportBase = Effect.fn('codeGraph.sharing.captureSharedImport')(function* (
  request: SharedGraphImportRequest,
) {
  const exit = yield* Effect.exit(maybeImportSharedGraphBase(request));
  const result: SharedGraphImportResult = Exit.isSuccess(exit)
    ? exit.value
    : {imported: false as const, reason: 'unavailable' as const};
  yield* writeSharedGraphImportAttempt(
    request.threadnoteHome,
    request.identity.checkoutId,
    sharedGraphImportAttemptFrom(result),
  ).pipe(Effect.ignore);
  return result;
});

const importVerifiedSharedCheckpoint = Effect.fn('codeGraph.sharing.importVerifiedCheckpoint')(function* (input: {
  readonly casRoot: string;
  readonly enrollment: GraphShareEnrollment;
  readonly request: SharedGraphImportRequest;
  readonly trust: GraphShareTrustReceiptV1;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointer = yield* decodeValue(
    parseGraphShareProfilePointer,
    input.enrollment.profile,
    'Enrollment profile pointer is invalid.',
  );
  const legacyClient =
    pointer.kind === 'cas'
      ? yield* resolveGraphShareRepositoryClient(input.request.threadnoteHome, input.trust)
      : undefined;
  const profile =
    pointer.kind === 'oci'
      ? yield* readTrustedGraphShareOciProfile(input.casRoot, input.enrollment, input.trust)
      : yield* decodeJson(
          yield* ensureSharedCasBlob(input.casRoot, pointer.bodyDigest, legacyClient?.coordinatorUrl),
          parseGraphShareProfile,
          'Organization graph profile is invalid.',
        );
  const client = legacyClient ?? (yield* resolveGraphShareRepositoryClient(input.request.threadnoteHome, input.trust));
  const profileDigest = graphShareProfileDigest(profile);
  yield* decodeValue(
    () => {
      assertProfileMatchesEnrollment(profile, input.enrollment, profileDigest);
      return profile;
    },
    undefined,
    'Profile does not match the enrollment pointer.',
  );
  if (profileDigest !== input.trust.profileDigest) {
    return {imported: false as const, reason: 'trust-pin-mismatch' as const};
  }
  const registry = Effect2.pipe(profile.registry.canonical, EffectString.startsWith('oci://'))
    ? yield* makeGraphShareRegistryReader(profile.registry.canonical)
    : undefined;
  const blobSource = registry?.readBlob;
  const coordinatorUrl = registry === undefined ? client.coordinatorUrl : undefined;
  const scope: GraphShareFrontierScope = {
    branch: profile.source.branches[0] ?? 'refs/heads/main',
    profileDigest,
    publisherKeyFingerprint: input.trust.publisherKeyFingerprint,
    repositoryId: input.request.identity.repositoryId,
  };
  let accepted = yield* readAcceptedGraphShareFrontier(input.request.threadnoteHome, scope);
  const layout = graphSharingLayout(path, input.request.threadnoteHome, input.casRoot);
  const pointerPath = graphSharingFrontierPointerPath(path, layout.frontiersRoot, input.request.identity.repositoryId);
  let legacyFailure: GraphSharingError | undefined;
  if (yield* fs.exists(pointerPath)) {
    const legacy = yield* Effect.gen(function* () {
      const legacy = yield* decodeValue(
        parseGraphShareFrontierPointer,
        yield* readJsonFile(pointerPath),
        'Frontier pointer is invalid.',
      );
      yield* readAuthenticatedGraphShareFrontier(input.casRoot, scope, legacy);
      return legacy;
    }).pipe(
      Effect.catch(error => {
        legacyFailure = Schema.is(GraphSharingError)(error)
          ? error
          : graphSharingFailure('Legacy frontier is unavailable.');
        return Effect.void;
      }),
    );
    if (legacy !== undefined) {
      accepted = yield* acceptGraphShareFrontier({
        casRoot: input.casRoot,
        home: input.request.threadnoteHome,
        legacy: true,
        pointer: legacy,
        scope,
      });
    }
  }
  if (registry !== undefined || coordinatorUrl !== undefined) {
    yield* Effect.gen(function* () {
      const candidate = yield* registry !== undefined
        ? discoverGraphShareRegistryFrontier(
            input.casRoot,
            registry,
            graphShareFrontierDiscoveryTag(scope.repositoryId, scope.branch),
          )
        : refreshFrontierPointerFromCoordinator({
            branch: scope.branch,
            casRoot: input.casRoot,
            coordinatorUrl: coordinatorUrl!,
            repositoryId: scope.repositoryId,
          });
      accepted = yield* acceptGraphShareFrontier({
        casRoot: input.casRoot,
        home: input.request.threadnoteHome,
        pointer: candidate,
        scope,
      });
    }).pipe(Effect.catchIf(isUnavailableSharingFailure, () => Effect.void));
  }
  if (accepted === undefined) {
    if (legacyFailure !== undefined) return yield* legacyFailure;
    return yield* graphSharingUnavailable('Shared frontier pointer is missing.');
  }
  yield* ensureSharedCasBlob(input.casRoot, accepted.manifestDigest, coordinatorUrl, blobSource);
  yield* ensureSharedCasBlob(input.casRoot, accepted.envelopeDigest, coordinatorUrl, blobSource);
  const manifest = yield* readAuthenticatedGraphShareFrontier(input.casRoot, scope, accepted);
  const selected = yield* selectPublishedAncestorManifest(
    input.casRoot,
    input.request.identity,
    manifest,
    coordinatorUrl,
    blobSource,
  );
  yield* assertGraphShareCommitChain(input.request.identity.repoRoot, [
    selected.checkpoint.sourceCommit,
    ...EffectArray.map(selected.deltas, delta => delta.targetCommit),
    selected.sourceCommit,
  ]);
  const existing = yield* readSharedGraphProvenance(
    input.request.threadnoteHome,
    input.request.identity.checkoutId,
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (
    existing !== undefined &&
    existing.repositoryId === input.request.identity.repositoryId &&
    existing.profileDigest === profileDigest &&
    graphShareApplyIsAlreadyAtTarget(existing, selected)
  ) {
    return {
      imported: false as const,
      reason: 'already-installed' as const,
      snapshotId: existing.snapshotId,
      checkpointDigest: selected.checkpoint.manifestDigest,
      atGeneration: selected.generation,
    };
  }
  if (
    selected.deltas.length > 0 &&
    existing !== undefined &&
    existing.repositoryId === input.request.identity.repositoryId &&
    !graphShareApplyBaseMatches(existing, selected)
  ) {
    return yield* graphSharingFailure('Shared graph delta base does not match the installed snapshot.');
  }
  if (selected.deltas.length === 0) {
    const checkpointPath = yield* ensureGraphShareCheckpointArtifact({
      artifactDigest: selected.checkpoint.manifestDigest,
      casRoot: input.casRoot,
      ...(coordinatorUrl === undefined ? {} : {coordinatorUrl}),
      ...(blobSource === undefined ? {} : {blobSource}),
      ...(selected.checkpoint.metadataDigest === undefined ? {} : {metadataDigest: selected.checkpoint.metadataDigest}),
    });
    yield* sharingProgress(input.request.onProgress, 'applying-deltas');
    const imported = yield* importCodeGraphCheckpointSnapshot(runtimeConfigForHome(input.request.threadnoteHome), {
      cwd: input.request.cwd,
      expectedDigest: selected.checkpoint.manifestDigest,
      followOnIndex: false,
      input: checkpointPath,
      quiet: true,
    });
    yield* sharingProgress(input.request.onProgress, 'building-local-overlay');
    yield* writeSharedGraphProvenance(input.request.threadnoteHome, input.request.identity.checkoutId, {
      checkpointDigest: selected.checkpoint.manifestDigest,
      deltaCount: selected.deltas.length,
      frontierCommit: selected.sourceCommit,
      profileDigest,
      repositoryId: input.request.identity.repositoryId,
      schemaVersion: 1,
      snapshotId: imported.result.snapshotId,
    });
    return {
      imported: true as const,
      snapshotId: imported.result.snapshotId,
      checkpointDigest: selected.checkpoint.manifestDigest,
      atGeneration: selected.generation,
    };
  }
  const checkpointPath = yield* ensureGraphShareCheckpointArtifact({
    artifactDigest: selected.checkpoint.manifestDigest,
    casRoot: input.casRoot,
    ...(coordinatorUrl === undefined ? {} : {coordinatorUrl}),
    ...(blobSource === undefined ? {} : {blobSource}),
    ...(selected.checkpoint.metadataDigest === undefined ? {} : {metadataDigest: selected.checkpoint.metadataDigest}),
  });
  const deltaPaths = [];
  for (const delta of selected.deltas) {
    deltaPaths.push(
      yield* ensureGraphShareCheckpointArtifact({
        artifactDigest: delta.manifestDigest,
        casRoot: input.casRoot,
        ...(coordinatorUrl === undefined ? {} : {coordinatorUrl}),
        ...(blobSource === undefined ? {} : {blobSource}),
        ...(delta.metadataDigest === undefined ? {} : {metadataDigest: delta.metadataDigest}),
      }),
    );
  }
  yield* sharingProgress(input.request.onProgress, 'applying-deltas');
  const crypto = yield* Crypto.Crypto;
  const checkpoint = decodeGraphShareCheckpointBytes(yield* fs.readFile(checkpointPath));
  const deltas = [];
  let previousLogical = checkpoint.header.logical.digest;
  for (const [index, descriptor] of selected.deltas.entries()) {
    const deltaPath = deltaPaths[index];
    if (deltaPath === undefined) {
      return yield* graphSharingFailure('Shared frontier delta artifact is missing.');
    }
    const decoded = decodeGraphShareCheckpointBytes(yield* fs.readFile(deltaPath));
    if (decoded.header.packKind !== 'delta' || decoded.header.base === undefined) {
      return yield* graphSharingFailure('Shared frontier delta is not a TCG1 delta pack.');
    }
    if (
      decoded.header.base.snapshotId !== descriptor.baseSnapshotId ||
      decoded.header.base.logicalDigest.digest !== previousLogical
    ) {
      return yield* graphSharingFailure('Shared graph delta base does not match the installed snapshot.');
    }
    previousLogical = decoded.header.logical.digest;
    deltas.push(decoded);
  }
  const composedRecords = composeGraphShareTargetRecords(checkpoint.records, deltas);
  const lastDelta = deltas[deltas.length - 1];
  if (lastDelta === undefined) {
    return yield* graphSharingFailure('Shared frontier delta chain is empty.');
  }
  const composed = encodeCodeGraphCheckpointPackV1(
    checkpointMetadataFromHeader({
      ...lastDelta.header,
      packKind: 'checkpoint',
      base: undefined,
      deletions: undefined,
    }),
    composedRecords,
  );
  if (composed.header.logical.digest !== lastDelta.header.logical.digest) {
    return yield* graphSharingFailure('Composed shared graph digest does not match the delta target.');
  }
  const composedPath = yield* writeTemporaryCheckpointPack(
    path.join(layout.root, 'downloads'),
    `${yield* crypto.randomUUIDv4()}.cgcp`,
    composed,
  );
  const imported = yield* importCodeGraphCheckpointSnapshot(runtimeConfigForHome(input.request.threadnoteHome), {
    cwd: input.request.cwd,
    expectedDigest: composed.descriptor.digest,
    followOnIndex: false,
    input: composedPath,
    quiet: true,
  }).pipe(Effect.ensuring(fs.remove(composedPath, {force: true}).pipe(Effect.ignore)));
  yield* sharingProgress(input.request.onProgress, 'building-local-overlay');
  yield* writeSharedGraphProvenance(input.request.threadnoteHome, input.request.identity.checkoutId, {
    checkpointDigest: selected.checkpoint.manifestDigest,
    deltaCount: selected.deltas.length,
    frontierCommit: selected.sourceCommit,
    profileDigest,
    repositoryId: input.request.identity.repositoryId,
    schemaVersion: 1,
    snapshotId: imported.result.snapshotId,
  });
  return {
    imported: true as const,
    snapshotId: imported.result.snapshotId,
    checkpointDigest: selected.checkpoint.manifestDigest,
    atGeneration: selected.generation,
  };
});

export interface GraphShareContributeStatusOptions {
  readonly cwd?: string;
  readonly json?: boolean;
}

export interface GraphShareContributeSetOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly mode?: string;
}

export interface GraphWorkerOptions {
  readonly cas?: string;
  readonly cwd?: string;
  readonly json?: boolean;
}

export const runGraphContributeStatus = Effect.fn('codeGraph.sharing.contributeStatus')(function* (
  config: RuntimeConfig,
  options: GraphShareContributeStatusOptions,
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const trust = yield* lookupGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  const state =
    trust === undefined ? undefined : yield* resolveGraphShareRepositoryClient(config.agentContextHome, trust);
  const requested = state?.contributionMode ?? 'off';
  const mode = effectiveGraphShareContributionMode(trust?.accessMode, requested);
  const queue = yield* readGraphShareContributionQueue(config.agentContextHome, identity.repositoryId, mode);
  const profile =
    trust === undefined || state === undefined
      ? Option.none()
      : yield* readTrustedGraphShareContributionProfile(trust, state.casRoot).pipe(Effect.option);
  const resourcePolicy =
    trust === undefined
      ? undefined
      : Option.isSome(profile)
        ? {
            ...effectiveGraphShareContributionPolicy(
              trust.accessMode,
              requested,
              profile.value.contribution.maximumUploadBytesPerSecond,
            ),
            verification: 'verified' as const,
          }
        : {
            activeResourceLimitsEnforced: false,
            deliveryPausedReason: 'profile-unavailable' as const,
            mode,
            positiveUploadRateLimitEnforced: false,
            verification: 'unavailable' as const,
          };
  return {
    accessMode: trust?.accessMode,
    mode,
    requestedMode: requested,
    queued: queue.announcements.length,
    resourcePolicy,
    repositoryId: identity.repositoryId,
    type: 'code-graph-contribute-status' as const,
    version: 1 as const,
  };
});

export const runGraphContributeSet = Effect.fn('codeGraph.sharing.contributeSet')(function* (
  config: RuntimeConfig,
  options: GraphShareContributeSetOptions,
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const trust = yield* lookupGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  const requested = yield* decodeContributionMode(options.mode);
  const requestedMode =
    trust === undefined
      ? 'off'
      : yield* writeGraphShareRepositoryContributionMode(
          config.agentContextHome,
          trust,
          yield* resolveGraphShareRepositoryClient(config.agentContextHome, trust),
          requested,
        );
  return {
    accessMode: trust?.accessMode,
    mode: effectiveGraphShareContributionMode(trust?.accessMode, requestedMode),
    requestedMode,
    repositoryId: identity.repositoryId,
    type: 'code-graph-contribute-set' as const,
    version: 1 as const,
  };
});

export const runGraphWorker = Effect.fn('codeGraph.sharing.worker')(function* (
  config: RuntimeConfig,
  options: GraphWorkerOptions,
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const trust = yield* lookupGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  if (trust?.accessMode !== 'join') {
    return {
      eligible: 0,
      skippedMissingBlob: 0,
      type: 'code-graph-worker' as const,
      version: 1 as const,
    };
  }
  const client = yield* resolveGraphShareRepositoryClient(config.agentContextHome, trust);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas ?? client.casRoot);
  const advertised = yield* readAdvertisedGraphWorkerActions(config.agentContextHome, identity.repositoryId, casRoot);
  const presentBlobIds = new Set<string>();
  for (const action of advertised) {
    if (yield* graphShareBlobExists(identity.repoRoot, action.gitBlobId)) presentBlobIds.add(action.gitBlobId);
  }
  const plan = planGraphWorkerActions(advertised, presentBlobIds);
  return {
    eligible: plan.eligible.length,
    skippedMissingBlob: plan.skippedMissingBlob.length,
    type: 'code-graph-worker' as const,
    version: 1 as const,
  };
});

const quarantineSharedFailure = Effect.fn('codeGraph.sharing.quarantine')(function* (
  threadnoteHome: string,
  repositoryId: string,
  cause: unknown,
) {
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  const message = cause instanceof Error ? cause.message : String(cause);
  yield* writePrivateJsonFile(path.join(layout.quarantineRoot, `${repositoryId}.json`), {
    message,
    repositoryId,
    schemaVersion: 1,
  });
});

function isUnavailableSharingFailure(error: unknown): error is GraphSharingError {
  return Schema.is(GraphSharingError)(error) && error.kind === 'unavailable';
}

function runtimeConfigForHome(threadnoteHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: threadnoteHome,
    agentId: 'threadnote',
    manifestPath: `${threadnoteHome}/seed-manifest.yaml`,
    user: 'local',
  };
}

function commandCwd(value: string | undefined) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return path.resolve(
      Effect2.pipe(value, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || system.currentDirectory(),
    );
  });
}

function decodeContributionMode(value: string | undefined) {
  return Effect.try({
    try: () => {
      if (value === undefined || Effect2.pipe(value, EffectString.trim).length === 0) {
        throw graphSharingFailure('Contribution mode must be off, passive, idle, or dedicated.');
      }
      const mode = Effect2.pipe(value, EffectString.trim);
      if (mode === 'off' || mode === 'passive' || mode === 'idle' || mode === 'dedicated') return mode;
      throw graphSharingFailure('Contribution mode must be off, passive, idle, or dedicated.');
    },
    catch: cause =>
      Schema.is(GraphSharingError)(cause) ? cause : graphSharingFailure('Contribution mode is invalid.', cause),
  });
}

function decodeJson<A>(bytes: Uint8Array, parse: (value: unknown) => A, message: string) {
  return decodeJsonBytes(bytes).pipe(
    Effect.mapError(cause => graphSharingFailure(message, cause)),
    Effect.flatMap(value => decodeValue(parse, value, message)),
  );
}

export const GRAPH_SHARE_ANCESTOR_WALK_LIMIT = 64;

export const selectPublishedAncestorManifest = Effect.fn('codeGraph.sharing.selectPublishedAncestor')(function* (
  casRoot: string,
  identity: RepositoryIdentity,
  latest: GraphShareFrontierManifestV1,
  coordinatorUrl?: string,
  blobSource?: GraphShareBlobSource,
) {
  let current = latest;
  for (let step = 0; step < GRAPH_SHARE_ANCESTOR_WALK_LIMIT; step += 1) {
    if (yield* graphShareCommitIsAncestor(identity.repoRoot, current.sourceCommit, identity.headCommit)) {
      return current;
    }
    if (current.previousManifestDigest === null) {
      return yield* graphSharingUnavailable('No published ancestor frontier for this HEAD.');
    }
    const predecessor = yield* decodeJson(
      yield* ensureSharedCasBlob(casRoot, current.previousManifestDigest, coordinatorUrl, blobSource),
      parseGraphShareFrontierManifest,
      'Predecessor frontier manifest is invalid.',
    );
    yield* decodeValue(
      () => assertGraphSharePredecessor(current, predecessor),
      undefined,
      'Predecessor frontier lineage is invalid.',
    );
    current = predecessor;
  }
  return yield* graphSharingUnavailable('Published ancestor walk exceeded the generation limit.');
});

const refreshFrontierPointerFromCoordinator = Effect.fn('codeGraph.sharing.refreshFrontierPointer')(function* (input: {
  readonly branch: string;
  readonly casRoot: string;
  readonly coordinatorUrl: string;
  readonly repositoryId: string;
}) {
  const tagName = graphShareFrontierDiscoveryTag(input.repositoryId, input.branch);
  const fromDescriptor = yield* refreshFrontierPointerFromOciTag({
    casRoot: input.casRoot,
    coordinatorUrl: input.coordinatorUrl,
    tagName,
  }).pipe(Effect.option);
  const frontier =
    fromDescriptor._tag === 'Some'
      ? fromDescriptor.value
      : yield* graphShareControlGetFrontier(
          input.coordinatorUrl,
          Effect2.pipe(tagName, EffectString.slice('tn-frontier-'.length)),
        );
  yield* ensureSharedCasBlob(input.casRoot, frontier.manifestDigest, input.coordinatorUrl);
  yield* ensureSharedCasBlob(input.casRoot, frontier.envelopeDigest, input.coordinatorUrl);
  return {
    envelopeDigest: frontier.envelopeDigest,
    manifestDigest: frontier.manifestDigest,
    schemaVersion: 1 as const,
  };
});

const refreshFrontierPointerFromOciTag = Effect.fn('codeGraph.sharing.refreshFrontierFromOciTag')(function* (input: {
  readonly casRoot: string;
  readonly coordinatorUrl: string;
  readonly tagName: string;
}) {
  const descriptorDigest = yield* graphShareControlGetTag(input.coordinatorUrl, input.tagName);
  const descriptor = yield* decodeJson(
    yield* ensureSharedCasBlob(input.casRoot, descriptorDigest, input.coordinatorUrl),
    parseGraphShareOciDescriptor,
    'OCI descriptor is invalid.',
  );
  const pointer = graphShareFrontierPointerFromOciDescriptor(descriptor);
  yield* ensureSharedCasBlob(input.casRoot, pointer.metadataDigest, input.coordinatorUrl);
  return pointer;
});

function decodeValue<A, I>(parse: (value: I) => A, value: I, message: string) {
  return Effect.try({
    try: () => parse(value),
    catch: cause => (Schema.is(GraphSharingError)(cause) ? cause : graphSharingFailure(message, cause)),
  });
}

export function sharedGraphImportAttemptFrom(result: SharedGraphImportResult): SharedGraphImportAttemptV1 {
  if (result.imported) {
    return {
      imported: true,
      reason: 'imported',
      atGeneration: result.atGeneration,
      checkpointDigest: result.checkpointDigest,
    };
  }
  return {
    imported: false,
    reason: result.reason,
    ...(result.atGeneration === undefined ? {} : {atGeneration: result.atGeneration}),
    ...(result.checkpointDigest === undefined ? {} : {checkpointDigest: result.checkpointDigest}),
  };
}
