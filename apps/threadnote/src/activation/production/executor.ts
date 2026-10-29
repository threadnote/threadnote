import {Array as EffectArray} from 'effect';
import {Console, DateTime, Effect, FileSystem, Option, Path} from 'effect';
import {agentAdapterStatus} from '../../agent_integration/adapter_actions.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {worktreeBuildRequestState} from '@threadnote/graph/inventory';
import {compileContextBrief} from '../../context_brief/index.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  buildReviewedKnowledgeDeltaGitProposal,
  runKnowledgeDeltaGitProposalMaterialize,
} from '../../git_proposal/commands.js';
import {runCloseoutApplyWithReviewLockHeld} from '../../memory/closeout.js';
import {
  loadCandidateReview,
  withCandidateReviewLock,
  type CandidateReview,
  type MemoryCandidate,
} from '@threadnote/memory/candidate';
import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {setupBriefIsSourceVerified, setupRepositorySourceHash, ensureSurface} from '../../setup/runtime.js';
import {withSetupMutationLock} from '../../setup/lock.js';
import {runSharePublish} from '../../effect/share.js';
import {withSharedRepositoryLock} from '../../effect/share/lock.js';
import {recoverShareInit, runShareInit as runShareInitEffect} from '../../share/admin.js';
import {readTeamsFile, teamGitdirPath, teamWorktreePath} from '../../share/core.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  ActivationOperationExecutionError,
  ActivationOperationPause,
  type ActivationOperationExecutionV1,
} from '../commands.js';
import type {ActivationOperationOutcomeV1} from '../contract.js';
import {activationCatalogRevisionV1, type ActivationProductionObservationV1} from './observe.js';
import {
  activationCandidateMutationOperationIdV1,
  completeActivationMutationIntentV1,
  prepareActivationMutationIntentV1,
} from './mutation_store.js';
import {
  type AppliedActivationDecisionV1,
  activationApprovedProjectionEvidenceHashV1,
  activationDecisionEvidenceHashV1,
  activationImportedMemoriesEvidenceHashV1,
  activationPublicationApprovalTokenV1,
  activationRecoveredProposalHashV1,
  activationReviewEvidenceHashV1,
  activationProposalEvidenceInputV1,
  assertActivationProposalEvidenceContextV1,
  assertDirectActivationPublicationV1,
  assertProposalActivationPublicationV1,
  directActivationPublicationIsCompleteV1,
  findOrCreateActivationDecisionReviewV1,
  findOrCreateActivationImportReviewsV1,
  loadActivationDecisionReviewV1,
  observeCurrentActivationSurfaceV1,
  observeCurrentActivationTeamV1,
  onlyDecisionCandidate,
  previousPublicationReceiptHashV1,
  readAppliedActivationImportReviewV1,
  readAppliedActivationImportsV1,
  readAppliedActivationDecisionV1,
  readOptionalPublishedActivationDecisionV1,
  readPublishedActivationDecisionV1,
} from './evidence.js';
import {initializeActivationProposalEvidenceV1, readActivationProposalEvidenceV1} from './proposal_store.js';
import {type SecondSurfaceProofContextV1} from '../second/surface.js';
import {issueSecondSurfaceProofChallengeV1, verifySecondSurfaceProofAttestationV1} from '../second/surface_store.js';

export function makeActivationProductionExecutorV1(
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  return {
    execute: (execution: ActivationOperationExecutionV1) =>
      executeProductionOperation(config, observation, execution).pipe(
        Effect.mapError(error =>
          isActivationPause(error) ? error : ActivationOperationExecutionError.make({message: errorMessage(error)}),
        ),
      ),
  };
}

const executeProductionOperation = Effect.fn('activation.production.execute')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  execution: ActivationOperationExecutionV1,
) {
  const operation = Option.getOrUndefined(
    EffectArray.findFirst(execution.plan.operations, candidate => candidate.id === execution.operationId),
  );
  if (operation === undefined) throw new Error(`Unknown activation operation ${execution.operationId}.`);
  switch (operation.kind) {
    case 'surface.primary.ensure':
      return yield* ensureActivationSurface(config, observation, 'primary');
    case 'surface.secondary.ensure':
      return yield* ensureActivationSurface(config, observation, 'secondary');
    case 'team.ensure':
      return yield* ensureActivationTeam(config, observation);
    case 'imports.preview':
      yield* Console.log(JSON.stringify(observation.imports, null, 2));
      return verifiedOutcome(observation.imports.sourceSetHash);
    case 'imports.review':
      return yield* reviewActivationImports(config, observation);
    case 'brief.verify':
      return yield* verifyActivationBrief(config, observation);
    case 'decision.review':
      return yield* reviewActivationDecision(config, observation);
    case 'decision.apply':
      return yield* applyActivationDecision(config, observation);
    case 'decision.publish':
      return yield* publishActivationDecision(config, observation, execution);
    case 'decision.propose':
      return yield* proposeActivationDecision(config, observation, execution);
    case 'secondary.prove':
      return yield* proveActivationSecondSurface(config, observation, execution);
  }
});

const ensureActivationSurface = Effect.fn('activation.production.ensureSurface')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  selected: 'primary' | 'secondary',
) {
  const adapter = selected === 'primary' ? observation.primaryAdapter : observation.secondaryAdapter;
  const operationId = selected === 'primary' ? ('surface-primary' as const) : ('surface-secondary' as const);
  const result = yield* withSetupMutationLock(
    config.agentContextHome,
    Effect.gen(function* () {
      const before = yield* agentAdapterStatus(config, adapter);
      let intent = yield* prepareActivationMutationIntentV1(config, {
        activationId: observation.plan.activationId,
        beforeStateHash: sha256HexSync(canonicalJson({state: before.state})),
        operationId,
        ownership: before.state === 'absent' ? 'activation-created' : 'preexisting',
        targetHash: sha256HexSync(
          canonicalJson({
            repositoryIdentityHash: observation.plan.repositoryIdentityHash,
            scope: observation.request.scope ?? null,
            surfaceId: adapter.catalog.id,
            version: 1,
          }),
        ),
      });
      if (intent.phase === 'completed') {
        const current = yield* observeCurrentActivationSurfaceV1(config, adapter);
        if (current.evidenceHash !== intent.afterStateHash) {
          throw new Error(`${adapter.catalog.id} changed after its activation mutation completed.`);
        }
        return {current, intent, status: 'already-current' as const};
      }
      const setup = yield* ensureSurface(
        config,
        adapter,
        observation.request.repositoryRoot,
        true,
        observation.request.scope,
      );
      const current = yield* observeCurrentActivationSurfaceV1(config, adapter);
      intent = yield* completeActivationMutationIntentV1(config, {
        activationId: observation.plan.activationId,
        afterStateHash: current.evidenceHash,
        expectedRevision: intent.revision,
        operationId,
      });
      return {current, intent, status: setup.status};
    }),
  );
  const created = result.intent.ownership === 'activation-created';
  return {
    ownership: created ? 'activation-created' : 'preexisting',
    status: created ? 'applied' : result.status,
    subsystemReceiptHash: result.current.evidenceHash,
    undoEligible: created && adapter.kind === 'json',
  } satisfies ActivationOperationOutcomeV1;
});

const ensureActivationTeam = Effect.fn('activation.production.ensureTeam')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const result = yield* withSharedRepositoryLock(
    config,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const teams = yield* readTeamsFile(config);
      const existed = teams.teams[observation.request.team.name] !== undefined;
      const [worktree, gitdir] = yield* Effect.all([
        teamWorktreePath(config, observation.request.team.name),
        teamGitdirPath(config, observation.request.team.name),
      ]);
      const [worktreeExists, gitdirExists] = yield* Effect.all([fs.exists(worktree), fs.exists(gitdir)]);
      let intent = yield* prepareActivationMutationIntentV1(config, {
        activationId: observation.plan.activationId,
        beforeStateHash: sha256HexSync(canonicalJson({exists: existed, gitdirExists, worktreeExists})),
        operationId: 'team-share',
        ownership: existed || gitdirExists || worktreeExists ? 'preexisting' : 'activation-created',
        targetHash: sha256HexSync(
          canonicalJson({
            teamId: observation.plan.teamId,
            teamShareStateHash: observation.plan.teamShareStateHash,
            version: 1,
          }),
        ),
      });
      if (intent.phase === 'completed') {
        const current = yield* observeCurrentActivationTeamV1(config, observation.request.team.name);
        if (current.evidenceHash !== intent.afterStateHash) {
          throw new Error('Activation team changed after its mutation completed.');
        }
        return {current, intent};
      }
      if (!existed) {
        const recovered = yield* recoverShareInit(config, observation.request.team.remotePath!, {
          push: false,
          setDefault: observation.request.team.setDefault,
          team: observation.request.team.name,
        });
        if (!recovered) {
          yield* runShareInitEffect(config, observation.request.team.remotePath!, {
            dryRun: false,
            push: false,
            setDefault: observation.request.team.setDefault,
            team: observation.request.team.name,
          });
        }
      }
      const current = yield* observeCurrentActivationTeamV1(config, observation.request.team.name);
      intent = yield* completeActivationMutationIntentV1(config, {
        activationId: observation.plan.activationId,
        afterStateHash: current.evidenceHash,
        expectedRevision: intent.revision,
        operationId: 'team-share',
      });
      return {current, intent};
    }),
  );
  const created = result.intent.ownership === 'activation-created';
  return {
    ownership: created ? 'activation-created' : 'preexisting',
    status: created ? 'applied' : 'already-current',
    subsystemReceiptHash: result.current.evidenceHash,
    undoEligible: created,
  } satisfies ActivationOperationOutcomeV1;
});

const verifyActivationBrief = Effect.fn('activation.production.verifyBrief')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const sourceBefore = yield* setupRepositorySourceHash(observation.request.repositoryRoot);
  const projected = yield* compileContextBrief(config, {
    budgetTokens: 2_000,
    mode: 'brief',
    scope: {callerCwd: observation.request.repositoryRoot, kind: 'repository'},
    task: observation.request.task,
  });
  const sourceAfter = yield* setupRepositorySourceHash(observation.request.repositoryRoot);
  if (!setupBriefIsSourceVerified(projected.structuredContent) || sourceBefore !== sourceAfter) {
    throw new Error('Activation Context Brief lacks stable, current source evidence.');
  }
  yield* Console.log(projected.text);
  return verifiedOutcome(sourceAfter);
});

const reviewActivationImports = Effect.fn('activation.production.reviewImports')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const reviews = yield* findOrCreateActivationImportReviewsV1(config, observation);
  const ownership: Array<'activation-created' | 'preexisting'> = [];
  for (const review of reviews) {
    const applied = yield* applyActivationCandidate(config, observation, review, {
      kind: 'import',
      operation: 'create',
    });
    ownership.push(applied.intent.ownership);
  }
  const imported = yield* readAppliedActivationImportsV1(config, observation);
  yield* Console.log(
    JSON.stringify(
      {
        importedReviewIds: EffectArray.map(reviews, review => review.reviewId),
        sourceSetHash: observation.imports.sourceSetHash,
      },
      null,
      2,
    ),
  );
  const subsystemReceiptHash = activationImportedMemoriesEvidenceHashV1(
    observation.imports.sourceSetHash,
    EffectArray.map(imported, decision => decision.review),
  );
  const created = ownership.includes('activation-created');
  return !created
    ? verifiedOutcome(subsystemReceiptHash)
    : ({
        ownership: 'activation-created',
        status: 'verified',
        subsystemReceiptHash,
        undoEligible: true,
      } satisfies ActivationOperationOutcomeV1);
});

const reviewActivationDecision = Effect.fn('activation.production.reviewDecision')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const review = yield* findOrCreateActivationDecisionReviewV1(config, observation);
  yield* Console.log(JSON.stringify(projectKnowledgeDeltaV1(review), null, 2));
  return verifiedOutcome(activationReviewEvidenceHashV1(review));
});

const applyActivationDecision = Effect.fn('activation.production.applyDecision')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
) {
  const review = yield* loadActivationDecisionReviewV1(config, observation.plan.activationId);
  const candidate = onlyDecisionCandidate(review);
  const requestedOperation = observation.request.decision.operation;
  if (
    requestedOperation === 'replace' &&
    candidate.targetUri !== undefined &&
    observation.request.decision.replaceUri !== candidate.targetUri
  ) {
    throw new Error('Activation replacement target no longer matches the reviewed candidate.');
  }
  const applied = yield* applyActivationCandidate(config, observation, review, {
    kind: 'decision',
    operation: requestedOperation,
    replaceUri: observation.request.decision.replaceUri,
  });
  const created =
    applied.intent.ownership === 'activation-created' && applied.decision.candidate.applyOperation === 'create';
  return {
    ownership: created ? 'activation-created' : 'preexisting',
    status: 'applied',
    subsystemReceiptHash: activationDecisionEvidenceHashV1(applied.decision),
    undoEligible: created,
  } satisfies ActivationOperationOutcomeV1;
});

const applyActivationCandidate = Effect.fn('activation.production.applyCandidate')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  initialReview: CandidateReview,
  options: {
    readonly kind: 'decision' | 'import';
    readonly operation?: 'create' | 'replace';
    readonly replaceUri?: string;
  },
) {
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    initialReview.reviewId,
    Effect.gen(function* () {
      let review = yield* loadCandidateReview(config.agentContextHome, initialReview.reviewId);
      const candidate = onlyDecisionCandidate(review);
      const operationId = activationCandidateMutationOperationIdV1(review.reviewId, candidate.candidateId);
      let intent = yield* prepareActivationMutationIntentV1(config, {
        activationId: observation.plan.activationId,
        beforeStateHash: activationCandidateBeforeStateHashV1(review, candidate),
        operationId,
        ownership: candidate.state === 'applied' ? 'preexisting' : 'activation-created',
        targetHash: activationCandidateTargetHashV1(review, candidate, options),
      });
      const decision = yield* readActivationCandidate(config, observation, options.kind, review).pipe(Effect.option);
      if (intent.phase === 'completed') {
        if (Option.isNone(decision) || activationDecisionEvidenceHashV1(decision.value) !== intent.afterStateHash) {
          throw new Error('Completed activation candidate mutation evidence changed.');
        }
        return {decision: decision.value, intent};
      }
      if (candidate.state !== 'applied') {
        const result = yield* runCloseoutApplyWithReviewLockHeld(config, {
          action: 'approve',
          approved: true,
          candidateId: candidate.candidateId,
          operation: options.operation,
          replaceUri: options.replaceUri,
          reviewId: review.reviewId,
          revision: review.revision,
        });
        const text = EffectArray.join(
          EffectArray.map(
            EffectArray.filter(
              result.content,
              (item): item is {readonly text: string; readonly type: 'text'} => item.type === 'text',
            ),
            item => item.text,
          ),
          '\n',
        );
        if (result.isError === true)
          throw new Error(text || `Activation candidate ${candidate.candidateId} apply failed.`);
        yield* Console.log(text);
        review = yield* loadCandidateReview(config.agentContextHome, initialReview.reviewId);
      }
      const applied = yield* readActivationCandidate(config, observation, options.kind, review);
      const afterStateHash = activationDecisionEvidenceHashV1(applied);
      intent = yield* completeActivationMutationIntentV1(config, {
        activationId: observation.plan.activationId,
        afterStateHash,
        expectedRevision: intent.revision,
        operationId,
      });
      return {decision: applied, intent};
    }),
  );
});

function readActivationCandidate(
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  kind: 'decision' | 'import',
  review: CandidateReview,
) {
  return kind === 'decision'
    ? readAppliedActivationDecisionV1(config, observation)
    : readAppliedActivationImportReviewV1(config, observation.request.project, review);
}

function activationCandidateBeforeStateHashV1(review: CandidateReview, candidate: MemoryCandidate): string {
  return sha256HexSync(
    canonicalJson({
      applyContentHash: candidate.applyContentHash ?? null,
      applyOperation: candidate.applyOperation ?? null,
      applyTargetUriHash:
        candidate.applyTargetUri === undefined ? null : sha256HexSync(canonicalJson({uri: candidate.applyTargetUri})),
      reviewRevision: review.revision,
      state: candidate.state,
    }),
  );
}

function activationCandidateTargetHashV1(
  review: CandidateReview,
  candidate: MemoryCandidate,
  options: {readonly operation?: 'create' | 'replace'; readonly replaceUri?: string},
): string {
  return sha256HexSync(
    canonicalJson({
      candidateIdHash: sha256HexSync(candidate.candidateId),
      operation: options.operation ?? null,
      proposedTextHash: sha256HexSync(candidate.proposedText),
      replaceUriHash: options.replaceUri === undefined ? null : sha256HexSync(canonicalJson({uri: options.replaceUri})),
      reviewIdHash: sha256HexSync(review.reviewId),
      version: 1,
    }),
  );
}

const publishActivationDecision = Effect.fn('activation.production.publishDecision')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  execution: ActivationOperationExecutionV1,
) {
  const [applied, team] = yield* Effect.all([
    readAppliedActivationDecisionV1(config, observation),
    observeCurrentActivationTeamV1(config, observation.request.team.name),
  ]);
  assertPublicationApproval(observation, execution, applied, team.evidenceHash);
  const existing = yield* readOptionalPublishedActivationDecisionV1(config, observation);
  if (existing._tag === 'Some' && directActivationPublicationIsCompleteV1(applied, existing.decision)) {
    return publicationOutcome(existing.decision);
  }
  yield* runSharePublish(config, applied.record.uri, {
    dryRun: false,
    preview: false,
    push: observation.request.team.push,
    team: observation.request.team.name,
  });
  const published = yield* readPublishedActivationDecisionV1(config, observation);
  assertDirectActivationPublicationV1(applied, published);
  return publicationOutcome(published);
});

const proposeActivationDecision = Effect.fn('activation.production.proposeDecision')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  execution: ActivationOperationExecutionV1,
) {
  const [applied, team] = yield* Effect.all([
    readAppliedActivationDecisionV1(config, observation),
    observeCurrentActivationTeamV1(config, observation.request.team.name),
  ]);
  const storedEvidence = yield* readActivationProposalEvidenceV1(config, observation.plan.activationId);
  const published = yield* readOptionalPublishedActivationDecisionV1(config, observation);
  if (published._tag === 'Some') {
    if (storedEvidence !== undefined) {
      assertActivationProposalEvidenceContextV1(observation, applied, team, storedEvidence);
      assertProposalActivationPublicationV1(storedEvidence, published.decision);
      assertPublicationApproval(observation, execution, applied, team.evidenceHash, storedEvidence.proposalHash);
      return proposalOutcome(storedEvidence.proposalHash);
    }
    if (
      activationApprovedProjectionEvidenceHashV1(published.decision) !==
      activationApprovedProjectionEvidenceHashV1(applied)
    ) {
      throw new Error('Published activation decision does not match the approved proposal decision.');
    }
    const recoveredHash = activationRecoveredProposalHashV1(activationApprovedProjectionEvidenceHashV1(applied));
    assertPublicationApproval(observation, execution, applied, team.evidenceHash, recoveredHash);
    return proposalOutcome(recoveredHash);
  }
  const built = yield* buildReviewedKnowledgeDeltaGitProposal(config, {
    approved: true,
    candidateIds: [applied.candidate.candidateId],
    reviewId: applied.review.reviewId,
    revision: applied.review.revision,
    team: observation.request.team.name,
  });
  assertPublicationApproval(observation, execution, applied, team.evidenceHash, built.proposal.proposalHash);
  const proposalEvidence = yield* initializeActivationProposalEvidenceV1(
    config,
    activationProposalEvidenceInputV1(observation, applied, team, built),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-proposal-'});
      const proposalPath = path.join(directory, `${observation.plan.activationId}.json`);
      yield* fs.writeFileString(proposalPath, built.artifact, {flag: 'wx', mode: 0o600});
      yield* runKnowledgeDeltaGitProposalMaterialize(config, {
        apply: true,
        proposal: proposalPath,
        team: observation.request.team.name,
      });
    }),
  );
  yield* Console.log(
    `Local proposal ${built.proposal.branch.name} is ready. Merge it into the configured team branch and sync before second-surface proof.`,
  );
  return {
    ownership: 'activation-created',
    status: 'applied',
    subsystemReceiptHash: proposalEvidence.proposalHash,
    undoEligible: false,
  } satisfies ActivationOperationOutcomeV1;
});

const proveActivationSecondSurface = Effect.fn('activation.production.proveSecondSurface')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  execution: ActivationOperationExecutionV1,
) {
  const decision = yield* readPublishedActivationDecisionV1(config, observation).pipe(
    Effect.catch(error =>
      observation.request.publicationMode === 'proposal'
        ? Effect.fail(
            ActivationOperationPause.make({
              message:
                'Merge the materialized local proposal into the configured team branch, sync that team, then rerun this continuation.',
            }),
          )
        : Effect.fail(error),
    ),
  );
  const publicationReceiptHash = previousPublicationReceiptHashV1(execution);
  if (publicationReceiptHash === undefined) throw new Error('Activation publication evidence is incomplete.');
  const proposedContext = yield* buildActivationSecondSurfaceProofContextV1(config, observation, decision, {
    publicationReceiptHash,
    receiptRevision: execution.receipt.revision,
    startedAt: DateTime.formatIso(yield* DateTime.now),
  });
  const challenge = yield* issueSecondSurfaceProofChallengeV1(config, proposedContext);
  if (challenge.receipt === undefined) {
    yield* Console.log(
      JSON.stringify(
        {
          challengeId: challenge.challengeId,
          next: {
            runOnSurface: observation.secondaryAdapter.catalog.id,
            tool: {
              arguments: {
                callerCwd: observation.request.repositoryRoot,
                challengeId: challenge.challengeId,
                project: observation.request.project,
                query: observation.request.task,
                topic: observation.request.topic,
              },
              name: 'complete_activation_retrieval_proof',
            },
          },
        },
        null,
        2,
      ),
    );
    return yield* ActivationOperationPause.make({
      message:
        'On the named secondary surface, call complete_activation_retrieval_proof with the emitted challenge arguments, then rerun activate continue with the unchanged request file.',
    });
  }
  const attested = yield* verifySecondSurfaceProofAttestationV1(config, challenge, challenge.receipt);
  yield* Console.log(JSON.stringify(attested, null, 2));
  return {
    ownership: 'preexisting',
    status: 'verified',
    subsystemReceiptHash: attested.proof.proofHash,
    undoEligible: false,
  } satisfies ActivationOperationOutcomeV1;
});

export const buildActivationSecondSurfaceProofContextV1 = Effect.fn('activation.production.buildSecondSurfaceContext')(
  function* (
    config: RuntimeConfig,
    observation: ActivationProductionObservationV1,
    decision: AppliedActivationDecisionV1,
    evidence: {
      readonly publicationReceiptHash: string;
      readonly receiptRevision: string;
      readonly startedAt: string;
    },
  ) {
    const [primary, secondary, repository] = yield* Effect.all([
      observeCurrentActivationSurfaceV1(config, observation.primaryAdapter),
      observeCurrentActivationSurfaceV1(config, observation.secondaryAdapter),
      resolveRepositoryIdentity(observation.request.repositoryRoot),
    ]);
    const memoryId = decision.record.metadata.memoryId;
    if (memoryId === undefined) throw new Error('Activation publication evidence is incomplete.');
    const worktree = yield* worktreeBuildRequestState(repository);
    return {
      activationId: observation.plan.activationId,
      activationReceiptRevision: evidence.receiptRevision,
      catalogRevision: activationCatalogRevisionV1(),
      catalogSnapshotHash: observation.plan.catalogSnapshotHash,
      decision: {
        canonicalUri: decision.record.uri,
        contentHash: sha256HexSync(canonicalMemoryDocumentContent(decision.record.content)),
        memoryId,
        publicationReceiptHash: evidence.publicationReceiptHash,
      },
      primary: primary.snapshot,
      queryFingerprint: sha256HexSync(
        canonicalJson({
          project: observation.request.project,
          task: observation.request.task,
          topic: observation.request.topic,
        }),
      ),
      repositoryIdentityHash: observation.plan.repositoryIdentityHash,
      repositoryState: worktree.dirty ? ('dirty' as const) : ('clean' as const),
      secondary: secondary.snapshot,
      startedAt: evidence.startedAt,
      teamId: observation.plan.teamId,
      teamShareStateHash: observation.plan.teamShareStateHash,
    } satisfies SecondSurfaceProofContextV1;
  },
);

function verifiedOutcome(subsystemReceiptHash: string): ActivationOperationOutcomeV1 {
  return {ownership: 'preexisting', status: 'verified', subsystemReceiptHash, undoEligible: false};
}

function publicationOutcome(decision: AppliedActivationDecisionV1): ActivationOperationOutcomeV1 {
  return {
    ownership: 'activation-created',
    status: 'applied',
    subsystemReceiptHash: activationDecisionEvidenceHashV1(decision),
    undoEligible: false,
  };
}

function proposalOutcome(proposalHash: string): ActivationOperationOutcomeV1 {
  return {
    ownership: 'activation-created',
    status: 'applied',
    subsystemReceiptHash: proposalHash,
    undoEligible: false,
  };
}

function assertPublicationApproval(
  observation: ActivationProductionObservationV1,
  execution: ActivationOperationExecutionV1,
  decision: AppliedActivationDecisionV1,
  teamEvidenceHash: string,
  proposalHash?: string,
): void {
  const actual = execution.approval?.reviewRevisionHash;
  const expected = activationPublicationApprovalTokenV1({
    decisionEvidenceHash: activationDecisionEvidenceHashV1(decision),
    mode: observation.request.publicationMode,
    operationId: execution.operationId,
    proposalHash,
    push: observation.request.team.push,
    teamEvidenceHash,
  });
  if (actual !== expected) throw new Error('Activation publication inputs changed after approval.');
}

function isActivationPause(error: unknown): error is ActivationOperationPause {
  return typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'ActivationOperationPause';
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : 'Activation operation failed.';
}
