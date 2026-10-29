import {Array as EffectArray} from 'effect';
import {Clock, Context, Crypto, Effect, FileSystem, Layer, Path, Ref, Schema} from 'effect';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runCodeGraphCheckpointExport} from '@threadnote/graph/checkpoint/operations';
import {codeGraphCheckpointAbiInputV1} from '../../checkpoint/compatibility.js';
import {codeGraphCheckpointAbiDigestV1} from '../../checkpoint/pack.js';
import type {CodeGraphCheckpointHeaderV1, CodeGraphCheckpointRecordV1} from '../../checkpoint/schema.js';
import {CodeGraphIndexer} from '../../indexer.js';
import {codeGraphLayout} from '../../layout.js';
import {resolveRepositoryIdentity} from '../../repository.js';
import {CodeGraphStore} from '../../store.js';
import {graphShareLanguageAndRole, graphShareParseActionKey} from '../action.js';
import {
  generateGraphSharePublisherKey,
  parseGraphSharePublisherKey,
  parseGraphShareFrontierManifest,
  parseGraphShareFrontierPointer,
  signGraphShareFrontier,
  graphShareFrontierDigest,
  type GraphShareFrontierManifestV1,
  type GraphSharePublisherKeyV1,
} from '../artifacts.js';
import {graphShareDeltaClosureComplete, planGraphSharePublication} from '../delta.js';
import {
  composeGraphShareTargetRecords,
  decodeGraphShareCheckpointBytes,
  encodeGraphShareDeltaPack,
  putGraphShareDeltaArtifact,
} from '../delta_pack.js';
import {decodeJsonBytes, readJsonFile, writeDurablePrivateJsonFile, writePrivateJsonFile} from '../atomic.js';
import {putCasFile, readVerifiedCasBlob} from '../cas.js';
import {putGraphShareCheckpointLayers} from '../checkpoint_cas.js';
import {putGraphShareOciDescriptor, putSignedGraphShareFrontierDocuments} from '../descriptor.js';
import {readGraphControlPolicy, type GraphControlPolicy} from '../control/authorization.js';
import {GraphControlEnrollmentError, requireGraphControlPublisherWorker} from '../control/enrollment.js';
import {
  readGraphWorkerAdmissionStore,
  retireGraphWorkerAdmissionsCoveredByPublishedSourceLocked,
} from '../control/result_admission.js';
import {
  loadGraphShareCoordinatorState,
  updateGraphShareCoordinatorMachine,
  withCoordinatorStateLock,
} from '../control/server.js';
import type {GraphShareCoordinatorStateV1} from '../control/protocol.js';
import {parseSha256Digest, sha256Digest, type Sha256Digest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {
  adoptPublishedFrontier,
  assembleGraphShareBatch,
  failGraphShareBatch,
  freezeGraphShareBatch,
  observeCanonicalHead,
  publishGraphShareBatch,
  verifyGraphShareBatch,
  type GraphShareFrontierMachineV1,
  type GraphShareFrontierPhase,
  type GraphShareFrontierThresholds,
} from '../frontier.js';
import {
  assertGraphShareCommitChain,
  graphShareCommitDiffStats,
  graphShareCommitIsAncestor,
  graphShareCommitUnixSeconds,
} from '../git.js';
import {graphShareEnrollmentPath, graphSharingFrontierPointerPath, graphSharingLayout} from '../layout.js';
import {verifyGraphShareParseReceipt} from '../parse/cache.js';
import {
  assertEnrollmentMatchesIdentity,
  enrolledProfileBodyDigest,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
  type GraphShareProfileV1,
} from '../profile.js';
import {readGraphShareEnrolledProfile} from '../profile/storage.js';
import {selectGraphShareResultsForFrozenMachine} from '../receipts.js';
import {
  graphPublisherContributionEvidence,
  type GraphPublisherContributionEvidence,
  type GraphPublisherHydrationEvidence,
} from '../publication_evidence.js';
import {writeGraphPublisherEvidenceRecord} from './evidence_record.js';
import {resolveGraphShareCasRoot} from '../trust.js';
import {makeGraphShareSourceVerification, type GraphShareSourceVerifiedReceipt} from '../source_verification.js';
import {completeGraphPublisherRegistryPublication} from './registry.js';
import {readAuthenticatedGraphShareFrontier} from '../frontier_acceptance.js';
import {graphShareRegistryPublicationScope} from '../registry/publication.js';
import {graphWorkerRegistryForProfile} from '../worker/registry_upload.js';
import {makeGraphShareRegistryReader} from '../registry/reader.js';
import {selectGraphWorkerReceiptsForSource} from '../worker/receipts.js';
import {verifyPublisherWorkerReceipt} from '../worker/publisher_receipt.js';
import type {GraphWorkerAdmissionReceiptV2} from '../worker/admission_state.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface GraphPublisherCycleOptions {
  readonly authorizationPolicy?: string;
  readonly cas?: string;
  readonly cwd?: string;
  readonly forceFreeze?: boolean;
  readonly json?: boolean;
  readonly listen?: string;
  readonly onMachine?: (machine: GraphShareFrontierMachineV1) => Effect.Effect<void>;
  readonly stateRef?: Ref.Ref<GraphShareCoordinatorStateV1>;
}

const FORCE_FREEZE_THRESHOLDS: GraphShareFrontierThresholds = {
  maximumAgeSeconds: 0,
  maximumChangedBytes: 1,
  maximumChangedFiles: 1,
};

export interface GraphPublisherAdvanceResult {
  readonly checkpointDigest: Sha256Digest;
  readonly contributionEvidence?: GraphPublisherContributionEvidence;
  readonly descriptorDigest?: Sha256Digest;
  readonly envelopeDigest: Sha256Digest;
  readonly generation: number;
  readonly manifestDigest: Sha256Digest;
  readonly phase: GraphShareFrontierPhase;
  readonly profileDigest: Sha256Digest;
  readonly published: boolean;
  readonly sourceCommit: string;
  readonly type: 'code-graph-publisher-serve';
  readonly version: 1;
}

export const advanceGraphPublisherFrontier = Effect.fn('codeGraph.sharing.advancePublisherFrontier')(function* (
  config: RuntimeConfig,
  options: GraphPublisherCycleOptions,
) {
  const candidate = yield* advanceGraphPublisherCandidate(config, options);
  const publication = yield* completeGraphPublisherRegistryPublication(config, options);
  return {
    ...candidate,
    publication,
    published:
      publication.status === 'local'
        ? candidate.published
        : publication.status === 'acknowledged' && (publication.changed || candidate.published),
  };
});

const advanceGraphPublisherCandidate = Effect.fn('codeGraph.sharing.advancePublisherCandidate')(function* (
  config: RuntimeConfig,
  options: GraphPublisherCycleOptions,
) {
  const clockNow = yield* Clock.currentTimeMillis;
  const nowSeconds = Math.floor(clockNow / 1_000);
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const path = yield* Path.Path;
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)));
  assertEnrollmentMatchesIdentity(enrollment, identity.repositoryId);
  const profile = yield* readGraphShareEnrolledProfile(casRoot, enrollment);
  const signedProfile = Effect2.pipe(profile.registry.worker, EffectString.startsWith('oci://'));
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  const pointerPath = graphSharingFrontierPointerPath(path, layout.frontiersRoot, identity.repositoryId);
  const pointer = parseGraphShareFrontierPointer(yield* readJsonFile(pointerPath));
  const current = signedProfile
    ? yield* readAuthenticatedGraphShareFrontier(
        casRoot,
        graphShareRegistryPublicationScope({enrollment, profile}),
        pointer,
      )
    : parseGraphShareFrontierManifest(
        yield* decodeJsonBytes(yield* readVerifiedCasBlob(casRoot, pointer.manifestDigest)),
      );
  const policyFile = options.authorizationPolicy === undefined ? undefined : path.resolve(options.authorizationPolicy);
  if (signedProfile && policyFile === undefined)
    return yield* graphSharingFailure('OCI worker publication requires a control authorization policy.');
  const initialPolicy = signedProfile
    ? yield* readGraphControlPolicy(policyFile!).pipe(
        Effect.filterOrFail(
          policy =>
            policy.organization === profile.organization &&
            policy.repositoryId === identity.repositoryId &&
            policy.profileDigest === graphShareProfileDigest(profile),
          () => graphSharingFailure('Publisher control policy does not match the enrolled profile.'),
        ),
      )
    : undefined;
  const coordinatorOptions = {
    organization: profile.organization,
    repositoryId: identity.repositoryId,
    threadnoteHome: config.agentContextHome,
  };
  const coordinator = yield* loadGraphShareCoordinatorState(coordinatorOptions);
  let machine =
    coordinator.machine.generation === 0 && coordinator.machine.publishedFrontier === null
      ? {
          ...coordinator.machine,
          generation: current.generation,
          observedHead: current.sourceCommit,
          phase: 'published' as const,
          previousManifestDigest: pointer.manifestDigest,
          publishedFrontier: current.sourceCommit,
        }
      : coordinator.machine;
  if (initialPolicy !== undefined)
    yield* withCoordinatorStateLock(
      coordinatorOptions,
      Effect.gen(function* () {
        const latestIdentity = yield* resolveRepositoryIdentity(cwd);
        const latestEnrollment = parseGraphShareEnrollment(
          yield* readJsonFile(graphShareEnrollmentPath(path, latestIdentity.repoRoot)),
        );
        assertEnrollmentMatchesIdentity(latestEnrollment, latestIdentity.repositoryId);
        const latestPointer = parseGraphShareFrontierPointer(yield* readJsonFile(pointerPath));
        if (
          latestIdentity.repositoryId !== identity.repositoryId ||
          latestIdentity.repoRoot !== identity.repoRoot ||
          latestIdentity.headCommit !== identity.headCommit ||
          latestEnrollment.profile !== enrollment.profile ||
          enrolledProfileBodyDigest(latestEnrollment) !== current.profileDigest ||
          latestPointer.manifestDigest !== pointer.manifestDigest ||
          latestPointer.envelopeDigest !== pointer.envelopeDigest
        )
          return yield* graphSharingFailure('Published worker source or profile changed before admission cleanup.');
        const authenticated = yield* readAuthenticatedGraphShareFrontier(
          casRoot,
          graphShareRegistryPublicationScope({enrollment: latestEnrollment, profile}),
          latestPointer,
        );
        if (authenticated.sourceCommit !== current.sourceCommit)
          return yield* graphSharingFailure('Published worker source changed before admission cleanup.');
        yield* retireGraphWorkerAdmissionsCoveredByPublishedSourceLocked(
          {
            casRoot,
            enrollment: latestEnrollment,
            home: config.agentContextHome,
            profile,
            repoRoot: latestIdentity.repoRoot,
          },
          initialPolicy,
        );
      }),
    );
  if (identity.headCommit === current.sourceCommit) {
    machine = adoptPublishedFrontier(machine, {
      generation: current.generation,
      manifestDigest: pointer.manifestDigest,
      sourceCommit: current.sourceCommit,
    });
    yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
    return currentPointer(current, pointer, machine.phase);
  }
  if (signedProfile && machine.generation < current.generation) {
    machine = adoptPublishedFrontier(machine, {
      generation: current.generation,
      manifestDigest: pointer.manifestDigest,
      sourceCommit: current.sourceCommit,
    });
    yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
  }
  const publishedCommit = machine.publishedFrontier ?? current.sourceCommit;
  const descendant = yield* graphShareCommitIsAncestor(identity.repoRoot, publishedCommit, identity.headCommit);
  machine = observeCanonicalHead(machine, {
    commit: identity.headCommit,
    isDescendantOfPublished: descendant || identity.headCommit === publishedCommit,
    nowSeconds,
  });
  yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
  if (!descendant) {
    return currentPointer(current, pointer, machine.phase);
  }
  const stats = yield* graphShareCommitDiffStats(identity.repoRoot, publishedCommit, identity.headCommit);
  const admissions =
    initialPolicy === undefined
      ? undefined
      : yield* readGraphWorkerAdmissionStore(config.agentContextHome, initialPolicy, identity.headCommit);
  const actionKeys =
    admissions === undefined
      ? EffectArray.map(
          EffectArray.filter(
            coordinator.receipts.receipts,
            receipt => receipt.batchId === identity.headCommit || receipt.batchId === machine.frozenBatchId,
          ),
          receipt => receipt.actionKey,
        )
      : EffectArray.map(
          EffectArray.filter(admissions.receipts, receipt => receipt.sourceCommit === identity.headCommit),
          receipt => receipt.announcement.body.actionKey,
        );
  machine = freezeGraphShareBatch(machine, {
    actionKeys,
    changedBytes: options.forceFreeze === true ? 1 : stats.changedBytes,
    changedFiles: options.forceFreeze === true ? 1 : stats.changedFiles,
    nowSeconds,
    thresholds: options.forceFreeze === true ? FORCE_FREEZE_THRESHOLDS : profileThresholds(profile),
  });
  yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
  if (machine.phase !== 'frozen') {
    return currentPointer(current, pointer, machine.phase);
  }
  const selected =
    admissions === undefined ? selectGraphShareResultsForFrozenMachine(coordinator.receipts, machine) : undefined;
  if (enrolledProfileBodyDigest(enrollment) !== current.profileDigest) {
    return yield* graphSharingFailure('Publisher enrollment profile differs from the current canonical frontier.');
  }
  const verified: GraphShareSourceVerifiedReceipt[] = [];
  for (const announcement of selected?.selected ?? []) {
    const receipt = yield* verifyGraphShareParseReceipt({
      announcement,
      casRoot,
      graphAbi: current.graphAbi,
      repositoryId: identity.repositoryId,
    }).pipe(Effect.option);
    if (receipt._tag === 'None') {
      machine = failGraphShareBatch(machine);
      yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
      return currentPointer(current, pointer, machine.phase);
    }
    verified.push(receipt.value);
  }
  const selectedSigned: GraphWorkerAdmissionReceiptV2[] = [];
  if (
    admissions != null &&
    admissions.receipts != null &&
    Boolean(EffectArray.some(admissions.receipts, receipt => receipt.sourceCommit === identity.headCommit)) &&
    initialPolicy !== undefined
  ) {
    const indexer = yield* CodeGraphIndexer;
    const store = yield* CodeGraphStore;
    const eligible = new Map<
      string,
      {
        readonly contentHash: string;
        readonly extractorSet: string;
        readonly factsDigest: string;
        readonly gitBlobId: string;
        readonly languageAndRole: string;
        readonly normalizedPath: string;
      }
    >();
    const fresh = yield* indexer.index({
      cwd,
      ensureVectors: false,
      force: true,
      includeOverlay: false,
      sourceOnly: true,
      sourceVerification: {
        observeParserBatch: group =>
          Effect.try({
            try: () => {
              const facts = new Map(EffectArray.map(group.facts, item => [item.facts.path, item.facts]));
              for (const file of group.files) {
                const parsed = facts.get(file.path);
                if (file.source !== 'commit' || parsed === undefined)
                  throw new Error('First-pass parser evidence is not committed source.');
                const languageAndRole = graphShareLanguageAndRole(file.language, 'source');
                eligible.set(
                  graphShareParseActionKey({
                    contentHash: file.contentHash,
                    extractorSet: group.cacheIdentity,
                    languageAndRole,
                    normalizedPath: file.path,
                    repositoryId: identity.repositoryId,
                  }),
                  {
                    contentHash: file.contentHash,
                    extractorSet: group.cacheIdentity,
                    factsDigest: sha256Digest(canonicalJson(parsed)),
                    gitBlobId: file.blobId,
                    languageAndRole,
                    normalizedPath: file.path,
                  },
                );
              }
            },
            catch: () => graphSharingFailure('First-pass parser source evidence is invalid.'),
          }),
        materializeFacts: batch => Effect.succeed(batch.facts),
      },
      threadnoteHome: config.agentContextHome,
    });
    const signedSelection =
      eligible.size === 0
        ? undefined
        : selectGraphWorkerReceiptsForSource(admissions, {
            actionKeys: [...eligible.keys()],
            profileDigest: enrolledProfileBodyDigest(enrollment),
            repositoryId: identity.repositoryId,
            sourceCommit: identity.headCommit,
          });
    const graphLayout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
    const ready = yield* store.readySnapshot(graphLayout.databasePath, identity.worktreeId);
    if (
      ready === undefined ||
      ready.dirty ||
      ready.baseSnapshotId !== undefined ||
      ready.commit !== identity.headCommit ||
      ready.id !== fresh.snapshot.id
    )
      return yield* graphSharingFailure('Signed worker ABI requires a fresh exact-source snapshot.');
    const provenance = yield* store.snapshotPackProvenance(graphLayout.databasePath, ready.id);
    if (provenance === undefined)
      return yield* graphSharingFailure('Signed worker ABI requires complete language-pack provenance.');
    const targetAbi = codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(provenance)).digest;
    const workerRegistry = yield* Effect.try({
      try: () =>
        graphWorkerRegistryForProfile(profile, {
          profileDigest: enrolledProfileBodyDigest(enrollment),
          repositoryId: identity.repositoryId,
        }),
      catch: () => graphSharingFailure('Publisher worker registry is outside its enrolled scope.'),
    });
    const commandExecutor = Context.get(yield* Layer.build(CommandExecutor.layer), CommandExecutor);
    const reader = yield* makeGraphShareRegistryReader(workerRegistry).pipe(
      Effect.provideService(CommandExecutor, commandExecutor),
    );
    for (const group of signedSelection?.candidateGroups ?? []) {
      for (const receipt of group.alternatives) {
        if (receipt.graphAbi !== targetAbi) continue;
        const body = receipt.announcement.body;
        const worker = yield* requireGraphControlPublisherWorker({
          home: config.agentContextHome,
          initialPolicy,
          principalId: body.principalId,
          readCurrentPolicy: readGraphControlPolicy(policyFile!),
          signingPublicKey: receipt.announcement.publicKey,
          workerId: body.workerId,
        }).pipe(
          Effect.catchIf(
            error => Schema.is(GraphControlEnrollmentError)(error),
            () => Effect.void,
          ),
        );
        if (worker === undefined) continue;
        const candidate = yield* verifyPublisherWorkerReceipt({
          authority: worker,
          expectedGraphAbi: targetAbi,
          reader,
          receipt,
          sourceCommit: identity.headCommit,
        }).pipe(Effect.provideService(CommandExecutor, commandExecutor), Effect.option);
        if (candidate._tag === 'None') continue;
        const expected = eligible.get(candidate.value.parsed.actionKey);
        if (
          expected === undefined ||
          candidate.value.parsed.normalizedPath !== expected.normalizedPath ||
          candidate.value.parsed.gitBlobId !== expected.gitBlobId ||
          candidate.value.parsed.contentHash !== expected.contentHash ||
          candidate.value.parsed.extractorSet !== expected.extractorSet ||
          candidate.value.parsed.languageAndRole !== expected.languageAndRole ||
          sha256Digest(canonicalJson(candidate.value.parsed.facts)) !== expected.factsDigest
        )
          continue;
        verified.push(candidate.value);
        selectedSigned.push(receipt);
        break;
      }
    }
  }
  const hydration: GraphPublisherHydrationEvidence = {status: 'skipped-source-verification', hydratedResults: 0};
  const verification = makeGraphShareSourceVerification({
    repositoryId: identity.repositoryId,
    sourceCommit: identity.headCommit,
    verified,
  });
  const published = yield* Effect.gen(function* () {
    const indexer = yield* CodeGraphIndexer;
    const store = yield* CodeGraphStore;
    const indexed = yield* indexer.index({
      cwd,
      ensureVectors: false,
      force: true,
      includeOverlay: false,
      sourceOnly: true,
      sourceVerification: verification.hooks,
      threadnoteHome: config.agentContextHome,
    });
    const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
    const ready = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
    if (
      ready === undefined ||
      ready.dirty ||
      ready.baseSnapshotId !== undefined ||
      ready.commit !== identity.headCommit
    ) {
      return yield* graphSharingFailure(
        'Checkpoint export requires the exact ready CLEAN root snapshot for the current repository HEAD.',
      );
    }
    if (ready.id !== indexed.snapshot.id) {
      return yield* graphSharingFailure('The ready graph changed after source-verified assembly.');
    }
    const sourceUse = yield* verification.complete();
    if (selectedSigned.length > 0) {
      const provenance = yield* store.snapshotPackProvenance(layout.databasePath, ready.id);
      if (
        provenance === undefined ||
        EffectArray.some(
          selectedSigned,
          receipt =>
            receipt.graphAbi !== codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(provenance)).digest,
        )
      )
        return yield* graphSharingFailure('Signed worker ABI differs from the source-verified target snapshot.');
    }
    machine = assembleGraphShareBatch(machine);
    yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
    machine = verifyGraphShareBatch(machine);
    yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
    const contributionEvidence = graphPublisherContributionEvidence({
      hydration,
      index: indexed,
      selectedResults: selected?.selected.length ?? selectedSigned.length,
      sourceUse,
      verifiedResultDigests: EffectArray.map(verified, item => item.announcement.resultManifestDigest),
    });
    const exported = yield* exportSignedGeneration(config, options, current, identity.repositoryId, profile, {
      contributionEvidence,
      enrollmentProfile: enrollment.profile,
      snapshotId: ready.id,
      sourceCommit: identity.headCommit,
      verified,
      ...(initialPolicy === undefined
        ? {}
        : {
            signedAdmissions: {
              initialPolicy,
              policyFile: policyFile!,
              receipts: selectedSigned,
              sourceSnapshot: EffectArray.filter(
                admissions!.receipts,
                receipt => receipt.sourceCommit === identity.headCommit,
              ),
            },
          }),
    });
    return {
      ...exported,
      contributionEvidence,
    };
  }).pipe(
    Effect.tapError(() => {
      machine = failGraphShareBatch(machine);
      return persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
    }),
  );
  machine = publishGraphShareBatch(machine, published.manifestDigest);
  yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
  return {
    ...published,
    phase: machine.phase,
    published: true,
    type: 'code-graph-publisher-serve' as const,
    version: 1 as const,
  };
});

function persistMachine(
  options: {readonly organization: string; readonly repositoryId: string; readonly threadnoteHome: string},
  machine: GraphShareFrontierMachineV1,
  onMachine?: (machine: GraphShareFrontierMachineV1) => Effect.Effect<void>,
  stateRef?: Ref.Ref<GraphShareCoordinatorStateV1>,
) {
  return updateGraphShareCoordinatorMachine(options, machine, stateRef).pipe(
    Effect.andThen(onMachine?.(machine) ?? Effect.void),
  );
}

function profileThresholds(profile: GraphShareProfileV1): GraphShareFrontierThresholds {
  return {
    maximumAgeSeconds: profile.frontier.batchMaximumAgeSeconds,
    maximumChangedBytes: profile.frontier.batchMaximumChangedBytes,
    maximumChangedFiles: profile.frontier.batchMaximumChangedFiles,
  };
}

function currentPointer(
  current: GraphShareFrontierManifestV1,
  pointer: {readonly envelopeDigest: Sha256Digest; readonly manifestDigest: Sha256Digest},
  phase: GraphShareFrontierPhase,
): GraphPublisherAdvanceResult {
  return {
    checkpointDigest: current.checkpoint.manifestDigest,
    envelopeDigest: pointer.envelopeDigest,
    generation: current.generation,
    manifestDigest: pointer.manifestDigest,
    phase,
    profileDigest: current.profileDigest,
    published: false,
    sourceCommit: current.sourceCommit,
    type: 'code-graph-publisher-serve',
    version: 1,
  };
}

export const ensureGraphSharePublishedOciDescriptor = Effect.fn('codeGraph.sharing.ensurePublishedOciDescriptor')(
  function* (
    casRoot: string,
    pointer: {readonly envelopeDigest: Sha256Digest; readonly manifestDigest: Sha256Digest},
    metadataDigest: Sha256Digest,
  ) {
    return yield* putGraphShareOciDescriptor(casRoot, {
      envelope: yield* readVerifiedCasBlob(casRoot, pointer.envelopeDigest),
      frontier: yield* readVerifiedCasBlob(casRoot, pointer.manifestDigest),
      metadata: yield* readVerifiedCasBlob(casRoot, metadataDigest),
    });
  },
);

const exportSignedGeneration = Effect.fn('codeGraph.sharing.exportSignedGeneration')(function* (
  config: RuntimeConfig,
  options: GraphPublisherCycleOptions,
  current: GraphShareFrontierManifestV1,
  repositoryId: string,
  profile: GraphShareProfileV1,
  expected: {
    readonly enrollmentProfile: string;
    readonly snapshotId: string;
    readonly sourceCommit: string;
    readonly verified: readonly GraphShareSourceVerifiedReceipt[];
    readonly contributionEvidence: GraphPublisherContributionEvidence;
    readonly signedAdmissions?: {
      readonly initialPolicy: GraphControlPolicy;
      readonly policyFile: string;
      readonly receipts: readonly GraphWorkerAdmissionReceiptV2[];
      readonly sourceSnapshot: readonly GraphWorkerAdmissionReceiptV2[];
    };
  },
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const key = yield* loadPublisherKey(config.agentContextHome);
  const spool = path.join(casRoot, 'spool', `${yield* crypto.randomUUIDv4()}.cgcp`);
  const exported = yield* runCodeGraphCheckpointExport(config, {
    cwd,
    expectedSnapshotId: expected.snapshotId,
    output: spool,
    quiet: true,
  });
  const exportedBytes = yield* fs.readFile(spool);
  const target = decodeGraphShareCheckpointBytes(exportedBytes);
  const previous = yield* loadPublishedTargetGraph(casRoot, current);
  const deltaPack = encodeGraphShareDeltaPack({
    base: {
      commit: current.sourceCommit,
      logicalDigest: previous.header.logical,
      snapshotId: current.snapshotId,
    },
    previousRecords: previous.records,
    target,
  });
  const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
  const checkpointTime = yield* graphShareCommitUnixSeconds(identity.repoRoot, current.checkpoint.sourceCommit);
  const chainDeltaBytes = yield* publishedDeltaBytes(casRoot, current);
  const publication = planGraphSharePublication({
    chainDeltaBytes,
    chainDeltaCount: current.deltas.length,
    checkpointAgeSeconds:
      checkpointTime === undefined ? profile.frontier.compactAfterSeconds : Math.max(0, nowSeconds - checkpointTime),
    closureComplete: graphShareDeltaClosureComplete(previous.header, target.header),
    nextDeltaBytes: deltaPack.bytes.byteLength,
    profile: profile.frontier,
  });
  yield* assertGraphShareCommitChain(identity.repoRoot, [
    current.checkpoint.sourceCommit,
    ...EffectArray.map(current.deltas, delta => delta.targetCommit),
    exported.sourceCommit,
  ]);
  const checkpointDigest =
    publication === 'compact' ? yield* putCasFile(casRoot, spool) : current.checkpoint.manifestDigest;
  yield* fs.remove(spool, {force: true});
  if (publication === 'compact' && checkpointDigest !== parseSha256Digest(exported.artifact.digest)) {
    return yield* graphSharingFailure('Checkpoint CAS digest does not match the exported artifact.');
  }
  const checkpointLayers =
    publication === 'compact'
      ? yield* putGraphShareCheckpointLayers(casRoot, checkpointDigest)
      : current.checkpoint.metadataDigest === undefined
        ? undefined
        : {metadataDigest: current.checkpoint.metadataDigest};
  const publishedDelta = publication === 'delta' ? yield* putGraphShareDeltaArtifact(casRoot, deltaPack) : undefined;
  const coordinatorOptions = {
    organization: profile.organization,
    repositoryId,
    threadnoteHome: config.agentContextHome,
  };
  // Serialize the last quarantine check and canonical pointer promotion with receipt acceptance.
  return yield* withCoordinatorStateLock(
    coordinatorOptions,
    Effect.gen(function* () {
      const verifyTarget = Effect.gen(function* () {
        const latestIdentity = yield* resolveRepositoryIdentity(cwd);
        const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
        const latestPointer = parseGraphShareFrontierPointer(
          yield* readJsonFile(graphSharingFrontierPointerPath(path, layout.frontiersRoot, repositoryId)),
        );
        const latestEnrollment = parseGraphShareEnrollment(
          yield* readJsonFile(graphShareEnrollmentPath(path, latestIdentity.repoRoot)),
        );
        if (
          latestIdentity.repositoryId !== repositoryId ||
          latestIdentity.headCommit !== expected.sourceCommit ||
          exported.sourceCommit !== expected.sourceCommit ||
          latestPointer.manifestDigest !== graphShareFrontierDigest(current) ||
          latestEnrollment.profile !== expected.enrollmentProfile ||
          enrolledProfileBodyDigest(latestEnrollment) !== current.profileDigest
        ) {
          return yield* graphSharingFailure('Publication source, profile, or predecessor changed during verification.');
        }
        if (expected.signedAdmissions !== undefined) {
          const admissions = yield* readGraphWorkerAdmissionStore(
            config.agentContextHome,
            expected.signedAdmissions.initialPolicy,
            expected.sourceCommit,
          );
          if (
            canonicalJson(
              EffectArray.filter(admissions.receipts, receipt => receipt.sourceCommit === expected.sourceCommit),
            ) !== canonicalJson(expected.signedAdmissions.sourceSnapshot)
          )
            return yield* graphSharingFailure('Signed contributions changed during publication; retry the batch.');
          const quarantine = new Set(
            EffectArray.map(
              EffectArray.filter(admissions.quarantine, item => item.repositoryId === repositoryId),
              item => item.actionKey,
            ),
          );
          for (const receipt of expected.signedAdmissions.receipts) {
            const body = receipt.announcement.body;
            if (
              quarantine.has(body.actionKey) ||
              !EffectArray.some(
                admissions.receipts,
                current =>
                  current.announcement.body.idempotencyKey === body.idempotencyKey &&
                  current.announcementDigest === receipt.announcementDigest &&
                  current.announcement.body.resultManifestDigest === body.resultManifestDigest &&
                  current.sourceCommit === expected.sourceCommit,
              )
            )
              return yield* graphSharingFailure(
                'A signed contribution changed or entered quarantine before publication.',
              );
            yield* requireGraphControlPublisherWorker({
              home: config.agentContextHome,
              initialPolicy: expected.signedAdmissions.initialPolicy,
              principalId: body.principalId,
              readCurrentPolicy: readGraphControlPolicy(expected.signedAdmissions.policyFile),
              signingPublicKey: receipt.announcement.publicKey,
              workerId: body.workerId,
            });
          }
        } else {
          const state =
            options.stateRef === undefined
              ? yield* loadGraphShareCoordinatorState(coordinatorOptions)
              : yield* Ref.get(options.stateRef);
          const quarantine = new Set(EffectArray.map(state.receipts.quarantine, item => item.actionKey));
          if (
            EffectArray.some(
              expected.verified,
              item =>
                quarantine.has(item.announcement.actionKey) ||
                !EffectArray.some(
                  state.receipts.receipts,
                  receipt =>
                    receipt.actionKey === item.announcement.actionKey &&
                    receipt.resultManifestDigest === item.announcement.resultManifestDigest &&
                    receipt.batchId === item.announcement.batchId,
                ),
            )
          ) {
            return yield* graphSharingFailure(
              'A selected contribution changed or entered quarantine before publication.',
            );
          }
        }
      });
      yield* verifyTarget;
      const signed = yield* signGraphShareFrontier(key, {
        branch: current.branch,
        checkpoint:
          publication === 'compact'
            ? {
                manifestDigest: checkpointDigest,
                metadataDigest: checkpointLayers?.metadataDigest,
                snapshotId: exported.snapshotId,
                sourceCommit: exported.sourceCommit,
              }
            : current.checkpoint,
        deltas:
          publication === 'compact' || publishedDelta === undefined
            ? []
            : [
                ...current.deltas,
                {
                  baseSnapshotId: current.snapshotId,
                  manifestDigest: publishedDelta.digest,
                  metadataDigest: publishedDelta.layers.metadataDigest,
                  targetCommit: exported.sourceCommit,
                  targetSnapshotId: exported.snapshotId,
                },
              ],
        generation: current.generation + 1,
        graphAbi: exported.graphAbi,
        graphContentId: exported.graphContentId,
        logicalGraphDigest: parseSha256Digest(exported.logicalDigest),
        previousManifestDigest: graphShareFrontierDigest(current),
        profileDigest: current.profileDigest,
        publisherFence: current.publisherFence,
        repositoryId,
        schemaVersion: 1,
        snapshotId: exported.snapshotId,
        sourceCommit: exported.sourceCommit,
      });
      const metadataDigest =
        publication === 'compact'
          ? checkpointLayers?.metadataDigest
          : (current.checkpoint.metadataDigest ?? publishedDelta?.layers.metadataDigest);
      if (metadataDigest === undefined) {
        return yield* graphSharingFailure('Frontier publication is missing checkpoint metadata.');
      }
      const metadataBytes = yield* readVerifiedCasBlob(casRoot, metadataDigest);
      const documents = yield* putSignedGraphShareFrontierDocuments(casRoot, signed, metadataBytes);
      const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
      yield* verifyTarget;
      yield* writeGraphPublisherEvidenceRecord({
        contributionEvidence: expected.contributionEvidence,
        generation: current.generation + 1,
        manifestDigest: documents.manifestDigest,
        repositoryId,
        sourceCommit: exported.sourceCommit,
        threadnoteHome: config.agentContextHome,
      });
      yield* writeDurablePrivateJsonFile(graphSharingFrontierPointerPath(path, layout.frontiersRoot, repositoryId), {
        envelopeDigest: documents.envelopeDigest,
        manifestDigest: documents.manifestDigest,
        schemaVersion: 1,
      });
      if (expected.signedAdmissions !== undefined)
        yield* retireGraphWorkerAdmissionsCoveredByPublishedSourceLocked(
          {
            casRoot,
            enrollment: parseGraphShareEnrollment(
              yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)),
            ),
            home: config.agentContextHome,
            profile,
            repoRoot: identity.repoRoot,
          },
          expected.signedAdmissions.initialPolicy,
        );
      return {
        checkpointDigest,
        descriptorDigest: documents.descriptorDigest,
        envelopeDigest: documents.envelopeDigest,
        generation: current.generation + 1,
        manifestDigest: documents.manifestDigest,
        profileDigest: current.profileDigest,
        sourceCommit: exported.sourceCommit,
      };
    }),
  );
});

const loadPublishedTargetGraph = Effect.fn('codeGraph.sharing.loadPublishedTarget')(function* (
  casRoot: string,
  current: GraphShareFrontierManifestV1,
) {
  const checkpoint = decodeGraphShareCheckpointBytes(
    yield* readVerifiedCasBlob(casRoot, current.checkpoint.manifestDigest),
  );
  const deltas = [];
  for (const delta of current.deltas) {
    deltas.push(decodeGraphShareCheckpointBytes(yield* readVerifiedCasBlob(casRoot, delta.manifestDigest)));
  }
  return {
    header: deltas.at(-1)?.header ?? checkpoint.header,
    records: composeGraphShareTargetRecords(checkpoint.records, deltas),
  } satisfies {
    readonly header: CodeGraphCheckpointHeaderV1;
    readonly records: readonly CodeGraphCheckpointRecordV1[];
  };
});

const publishedDeltaBytes = Effect.fn('codeGraph.sharing.publishedDeltaBytes')(function* (
  casRoot: string,
  current: GraphShareFrontierManifestV1,
) {
  let total = 0;
  for (const delta of current.deltas) {
    total += (yield* readVerifiedCasBlob(casRoot, delta.manifestDigest)).byteLength;
  }
  return total;
});

const loadPublisherKey = Effect.fn('codeGraph.sharing.cycleLoadPublisherKey')(function* (threadnoteHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  if (yield* fs.exists(layout.publisherKeyPath)) {
    return parseGraphSharePublisherKey(yield* readJsonFile(layout.publisherKeyPath));
  }
  const key: GraphSharePublisherKeyV1 = yield* generateGraphSharePublisherKey();
  yield* writePrivateJsonFile(layout.publisherKeyPath, key);
  return key;
});

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
