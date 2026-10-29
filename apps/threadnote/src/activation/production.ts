import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {readBoundedContainedStableRegularFile} from '@threadnote/graph/inventory/contained_file';
import {compileContextBrief} from '../context_brief/index.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {shellQuote} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {buildReviewedKnowledgeDeltaGitProposal} from '../git_proposal/commands.js';
import {setupBriefIsSourceVerified, setupRepositorySourceHash} from '../setup/runtime.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {continueActivationV1, type ActivationContinuationV1} from './commands.js';
import {operationIsComplete} from './contract.js';
import {withActivationLifecycleLock} from './lock.js';
import {previewActivationResumeV1} from './planner.js';
import {
  ACTIVATION_REQUEST_MAX_BYTES,
  parseActivationProductionRequestV1,
  type ActivationProductionRequestV1,
} from './production/contract.js';
import {
  activationApprovalTokenV1,
  activationApprovedProjectionEvidenceHashV1,
  activationDecisionEvidenceHashV1,
  activationImportedMemoriesEvidenceHashV1,
  activationPublicationApprovalTokenV1,
  activationRecoveredProposalHashV1,
  activationReviewEvidenceHashV1,
  activationReviewFingerprintV1,
  activationProposalEvidenceInputV1,
  assertActivationProposalBuildEvidenceV1,
  assertActivationProposalEvidenceContextV1,
  assertProposalActivationPublicationV1,
  loadActivationDecisionReviewV1,
  observeCurrentActivationSurfaceV1,
  observeCurrentActivationTeamV1,
  onlyDecisionCandidate,
  readAppliedActivationImportsV1,
  readAppliedActivationDecisionV1,
  readOptionalPublishedActivationDecisionV1,
  readPublishedActivationDecisionV1,
} from './production/evidence.js';
import {readActivationProposalEvidenceV1} from './production/proposal_store.js';
import {buildActivationSecondSurfaceProofContextV1, makeActivationProductionExecutorV1} from './production/executor.js';
import {
  activationProductionError,
  observeActivationProductionV1,
  type ActivationProductionObservationV1,
} from './production/observe.js';
import {runActivationProductionUndoV1} from './production/undo.js';
import {readActivationUndoReceiptV1} from './production/undo_store.js';
import {
  readSecondSurfaceProofChallengeV1,
  secondSurfaceChallengeIdV1,
  verifySecondSurfaceProofAttestationV1,
} from './second/surface_store.js';
import {readActivationStateV1, type ActivationStateV1} from './store.js';
import {reconcileActivationValueEventsV1} from './value.js';

export interface ActivationProductionCommandV1 {
  readonly activationId?: string;
  readonly apply: boolean;
  readonly approval?: string;
  readonly approved: boolean;
  readonly command: 'continue' | 'start' | 'status' | 'undo';
  readonly requestFile?: string;
}

export class ActivationProductionCommandError extends Schema.TaggedError<
  ActivationProductionCommandError,
  {readonly brand: unique symbol}
>()('ActivationProductionCommandError', {message: Schema.String}) {}

export const runActivationProductionCommandV1 = Effect.fn('activation.production.command')(function* (
  config: RuntimeConfig,
  command: ActivationProductionCommandV1,
) {
  if (command.command === 'status') {
    yield* printActivationStatus(config, command.activationId!);
    return;
  }
  if (command.requestFile === undefined) {
    return yield* commandError(`activate ${command.command} requires --request.`);
  }
  if (command.approved && !command.apply) {
    return yield* commandError('--approved requires --apply.');
  }
  const request = yield* readActivationRequestFileV1(command.requestFile);
  const observation = yield* observeActivationProductionV1(config, request);
  if (command.activationId !== undefined && command.activationId !== observation.plan.activationId) {
    return yield* commandError('Supplied activation ID does not match the freshly observed request.');
  }
  const lifecycle =
    command.command === 'undo'
      ? runActivationProductionUndoV1(config, observation, {
          approval: command.approved ? command.approval : undefined,
          apply: command.apply,
        }).pipe(Effect.asVoid)
      : runActivationProductionJourneyV1(config, command, observation, command.requestFile);
  if (!command.apply) return yield* lifecycle;
  return yield* withActivationLifecycleLock(config.agentContextHome, observation.plan.activationId, lifecycle);
});

const runActivationProductionJourneyV1 = Effect.fn('activation.production.journey')(function* (
  config: RuntimeConfig,
  command: ActivationProductionCommandV1,
  observation: ActivationProductionObservationV1,
  requestFile: string,
) {
  const existing = yield* readActivationStateV1(config, observation.plan.activationId);
  if (command.command === 'continue' && existing === undefined) {
    return yield* commandError('Activation state was not found; start with activate start.');
  }
  if (existing !== undefined) yield* validateCompletedActivationWorldV1(config, observation, existing);
  if (existing !== undefined) yield* reconcileActivationValueEventsV1(config, existing).pipe(Effect.ignore);
  const current = existing ?? {
    plan: observation.plan,
    receipt: (yield* continueActivationV1(
      config,
      {apply: false, now: nowIso, plan: observation.plan},
      makeActivationProductionExecutorV1(config, observation),
    )).state.receipt,
  };
  const resume = previewActivationResumeV1(observation.plan, current.receipt);
  let approval: {readonly operationId: string; readonly reviewRevisionHash: string} | undefined;
  if (command.approved) {
    if (resume.status !== 'awaiting-approval') {
      return yield* commandError('No activation approval boundary is currently awaiting review.');
    }
    const expected = yield* activationApprovalForResumeV1(config, observation, resume.operationId);
    if (command.approval !== expected) {
      return yield* commandError('Activation approval token does not match the current reviewed evidence.');
    }
    approval = {operationId: resume.operationId, reviewRevisionHash: expected};
  } else if (command.approval !== undefined) {
    return yield* commandError('--approval requires --approved.');
  }
  if (!command.apply) {
    yield* Console.log(JSON.stringify({imports: observation.imports, plan: observation.plan}, null, 2));
    yield* Console.log(`Preview complete. Re-run with --apply to create or resume ${observation.plan.activationId}.`);
    return;
  }
  const continued = yield* continueActivationV1(
    config,
    {apply: true, ...(approval === undefined ? {} : {approval}), now: nowIso, plan: observation.plan},
    makeActivationProductionExecutorV1(config, observation),
  ).pipe(
    Effect.matchEffect({
      onFailure: error =>
        isActivationPause(error)
          ? Effect.succeed({message: error.message, status: 'paused' as const})
          : Effect.fail(commandError(errorMessage(error))),
      onSuccess: result => Effect.succeed({result, status: 'continued' as const}),
    }),
    Effect.ensuring(
      readActivationStateV1(config, observation.plan.activationId).pipe(
        Effect.flatMap(state =>
          state === undefined ? Effect.void : reconcileActivationValueEventsV1(config, state).pipe(Effect.ignore),
        ),
        Effect.ignore,
      ),
    ),
  );
  if (continued.status === 'paused') {
    const pausedState = yield* readActivationStateV1(config, observation.plan.activationId);
    if (pausedState !== undefined) yield* reconcileActivationValueEventsV1(config, pausedState).pipe(Effect.ignore);
    yield* Console.log(continued.message);
    return;
  }
  yield* reconcileActivationValueEventsV1(config, continued.result.state).pipe(Effect.ignore);
  yield* printContinuation(config, observation, continued.result, requestFile);
});

export const readActivationRequestFileV1 = Effect.fn('activation.production.readRequest')(function* (
  requestFile: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const target = path.resolve(system.currentDirectory(), requestFile);
  const requestDirectory = yield* fs
    .realPath(path.dirname(target))
    .pipe(Effect.mapError(() => commandError('Activation request file is unreadable.')));
  const bytes = yield* readBoundedContainedStableRegularFile(
    fs,
    path,
    requestDirectory,
    path.basename(target),
    ACTIVATION_REQUEST_MAX_BYTES,
  ).pipe(Effect.mapError(() => commandError('Activation request file is unreadable.')));
  return yield* Effect.try({
    try: () =>
      parseActivationProductionRequestV1(
        JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes)) as unknown,
      ),
    catch: () => commandError('Activation request is invalid or not strict JSON.'),
  });
});

const printActivationStatus = Effect.fn('activation.production.status')(function* (
  config: RuntimeConfig,
  activationId: string,
) {
  if (!/^[0-9a-f]{64}$/u.test(activationId)) return yield* commandError('Activation ID must be a SHA-256 hash.');
  const state = yield* readActivationStateV1(config, activationId);
  if (state === undefined) return yield* commandError(`Activation ${activationId} was not found.`);
  const resume = previewActivationResumeV1(state.plan, state.receipt);
  const undo = yield* readActivationUndoReceiptV1(config, activationId);
  yield* Console.log(
    JSON.stringify(
      {
        activationId,
        firstBrief: state.receipt.firstBrief,
        generation: state.receipt.generation,
        next: resume,
        receiptRevision: state.receipt.revision,
        status: state.receipt.status,
        ...(undo === undefined ? {} : {undo}),
      },
      null,
      2,
    ),
  );
});

const printContinuation = Effect.fn('activation.production.printContinuation')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  continuation: ActivationContinuationV1,
  requestFile: string,
) {
  const resume = previewActivationResumeV1(continuation.state.plan, continuation.state.receipt);
  const summary: Record<string, unknown> = {
    activationId: continuation.state.plan.activationId,
    firstBrief: continuation.state.receipt.firstBrief,
    receiptRevision: continuation.state.receipt.revision,
    status: continuation.status,
  };
  if (resume.status === 'awaiting-approval') {
    const token = yield* activationApprovalForResumeV1(config, observation, resume.operationId);
    summary.next = {
      approvalKind: resume.approvalKind,
      approvalToken: token,
      command: activationContinuationCommandV1(observation.plan.activationId, requestFile, token),
      operationId: resume.operationId,
    };
  } else {
    summary.next = resume;
  }
  yield* Console.log(JSON.stringify(summary, null, 2));
});

export function activationContinuationCommandV1(
  activationId: string,
  requestFile: string,
  approvalToken: string,
): string {
  return EffectArray.join(
    EffectArray.map(
      [
        'threadnote',
        'activate',
        'continue',
        '--activation-id',
        activationId,
        '--request',
        requestFile,
        '--apply',
        '--approved',
        '--approval',
        approvalToken,
      ],
      shellQuote,
    ),
    ' ',
  );
}

const activationApprovalForResumeV1 = Effect.fn('activation.production.approval')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  operationId: string,
) {
  if (operationId === 'imports-review') {
    return activationApprovalTokenV1(operationId, observation.imports.sourceSetHash);
  }
  if (operationId === 'decision-apply') {
    const review = yield* loadActivationDecisionReviewV1(config, observation.plan.activationId);
    return activationApprovalTokenV1(
      operationId,
      sha256HexSync(
        canonicalJson({
          operation: observation.request.decision.operation ?? null,
          replaceUri: observation.request.decision.replaceUri ?? null,
          review: activationReviewFingerprintV1(review),
        }),
      ),
    );
  }
  if (operationId === 'decision-publish' || operationId === 'decision-propose') {
    const [decision, team] = yield* Effect.all([
      readAppliedActivationDecisionV1(config, observation),
      observeCurrentActivationTeamV1(config, observation.request.team.name),
    ]);
    const decisionEvidenceHash = activationDecisionEvidenceHashV1(decision);
    let proposalHash: string | undefined;
    if (observation.request.publicationMode === 'proposal') {
      const stored = yield* readActivationProposalEvidenceV1(config, observation.plan.activationId);
      const published = yield* readOptionalPublishedActivationDecisionV1(config, observation);
      if (stored !== undefined) {
        assertActivationProposalEvidenceContextV1(observation, decision, team, stored);
        if (published._tag === 'Some') {
          assertProposalActivationPublicationV1(stored, published.decision);
        } else {
          const rebuilt = yield* buildReviewedKnowledgeDeltaGitProposal(config, {
            approved: true,
            candidateIds: [onlyDecisionCandidate(decision.review).candidateId],
            reviewId: decision.review.reviewId,
            revision: decision.review.revision,
            team: observation.request.team.name,
          });
          assertActivationProposalBuildEvidenceV1(
            stored,
            activationProposalEvidenceInputV1(observation, decision, team, rebuilt),
          );
        }
        proposalHash = stored.proposalHash;
      } else if (published._tag === 'Some') {
        if (
          activationApprovedProjectionEvidenceHashV1(published.decision) !==
          activationApprovedProjectionEvidenceHashV1(decision)
        ) {
          return yield* activationProductionError(
            'Published activation decision does not match the reviewed decision.',
          );
        }
        proposalHash = activationRecoveredProposalHashV1(activationApprovedProjectionEvidenceHashV1(decision));
      } else {
        proposalHash = (yield* buildReviewedKnowledgeDeltaGitProposal(config, {
          approved: true,
          candidateIds: [onlyDecisionCandidate(decision.review).candidateId],
          reviewId: decision.review.reviewId,
          revision: decision.review.revision,
          team: observation.request.team.name,
        })).proposal.proposalHash;
      }
    }
    return activationPublicationApprovalTokenV1({
      decisionEvidenceHash,
      mode: observation.request.publicationMode,
      operationId,
      proposalHash,
      push: observation.request.team.push,
      teamEvidenceHash: team.evidenceHash,
    });
  }
  return yield* activationProductionError(`Activation operation ${operationId} has no approval evidence.`);
});

const validateCompletedActivationWorldV1 = Effect.fn('activation.production.validateCompleted')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  state: ActivationStateV1,
) {
  if (state.plan.planHash !== observation.plan.planHash) {
    return yield* activationProductionError('Activation request or live inputs drifted from the stored plan.');
  }
  for (const operation of EffectArrayPipe(state.receipt.operations, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (item, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && operationIsComplete(item.status),
    ),
  )) {
    if (operation.subsystemReceiptHash === undefined) {
      return yield* activationProductionError(`Activation operation ${operation.id} lacks receipt evidence.`);
    }
    if (operation.kind === 'surface.primary.ensure' || operation.kind === 'surface.secondary.ensure') {
      const adapter =
        operation.kind === 'surface.primary.ensure' ? observation.primaryAdapter : observation.secondaryAdapter;
      const current = yield* observeCurrentActivationSurfaceV1(config, adapter);
      if (current.evidenceHash !== operation.subsystemReceiptHash) {
        return yield* activationProductionError(`${adapter.catalog.id} changed after activation setup.`);
      }
    } else if (operation.kind === 'team.ensure') {
      const current = yield* observeCurrentActivationTeamV1(config, observation.request.team.name);
      if (current.evidenceHash !== operation.subsystemReceiptHash) {
        return yield* activationProductionError('Activation team changed after setup.');
      }
    } else if (operation.kind === 'imports.preview') {
      if (observation.imports.sourceSetHash !== operation.subsystemReceiptHash) {
        return yield* activationProductionError('Activation import sources changed after preview.');
      }
    } else if (operation.kind === 'imports.review') {
      const imported = yield* readAppliedActivationImportsV1(config, observation);
      if (
        activationImportedMemoriesEvidenceHashV1(
          observation.imports.sourceSetHash,
          EffectArray.map(imported, decision => decision.review),
        ) !== operation.subsystemReceiptHash
      ) {
        return yield* activationProductionError('Activation imported memories changed after approval.');
      }
    } else if (operation.kind === 'brief.verify') {
      const current = yield* currentBriefSourceHash(config, observation.request);
      if (current !== operation.subsystemReceiptHash) {
        return yield* activationProductionError('Activation Context Brief evidence changed after verification.');
      }
    } else if (operation.kind === 'decision.review') {
      const review = yield* loadActivationDecisionReviewV1(config, observation.plan.activationId);
      if (activationReviewEvidenceHashV1(review) !== operation.subsystemReceiptHash) {
        return yield* activationProductionError('Activation decision review changed.');
      }
    } else if (operation.kind === 'decision.apply') {
      const decision = yield* readAppliedActivationDecisionV1(config, observation);
      if (activationDecisionEvidenceHashV1(decision) !== operation.subsystemReceiptHash) {
        return yield* activationProductionError('Applied activation decision changed.');
      }
    } else if (operation.kind === 'decision.publish') {
      const decision = yield* readPublishedActivationDecisionV1(config, observation);
      if (activationDecisionEvidenceHashV1(decision) !== operation.subsystemReceiptHash) {
        return yield* activationProductionError('Published activation decision changed.');
      }
    } else if (operation.kind === 'decision.propose') {
      const decision = yield* readAppliedActivationDecisionV1(config, observation);
      const team = yield* observeCurrentActivationTeamV1(config, observation.request.team.name);
      const evidence = yield* readActivationProposalEvidenceV1(config, observation.plan.activationId);
      const published = yield* readOptionalPublishedActivationDecisionV1(config, observation);
      if (evidence !== undefined) {
        assertActivationProposalEvidenceContextV1(observation, decision, team, evidence);
        if (evidence.proposalHash !== operation.subsystemReceiptHash) {
          return yield* activationProductionError('Activation Git proposal receipt changed after materialization.');
        }
        if (published._tag === 'Some') {
          assertProposalActivationPublicationV1(evidence, published.decision);
        } else {
          const built = yield* buildReviewedKnowledgeDeltaGitProposal(config, {
            approved: true,
            candidateIds: [onlyDecisionCandidate(decision.review).candidateId],
            reviewId: decision.review.reviewId,
            revision: decision.review.revision,
            team: observation.request.team.name,
          });
          assertActivationProposalBuildEvidenceV1(
            evidence,
            activationProposalEvidenceInputV1(observation, decision, team, built),
          );
        }
      } else if (published._tag === 'Some') {
        if (
          activationApprovedProjectionEvidenceHashV1(published.decision) !==
            activationApprovedProjectionEvidenceHashV1(decision) ||
          activationRecoveredProposalHashV1(activationApprovedProjectionEvidenceHashV1(decision)) !==
            operation.subsystemReceiptHash
        ) {
          return yield* activationProductionError('Recovered activation proposal evidence changed.');
        }
      } else {
        return yield* activationProductionError('Activation Git proposal evidence is unavailable.');
      }
    } else if (operation.kind === 'secondary.prove') {
      const publicationReceiptHash = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          state.receipt.operations,
          candidate => candidate.kind === 'decision.publish' || candidate.kind === 'decision.propose',
        ),
      )?.subsystemReceiptHash;
      const receiptRevision = state.receipt.previousRevision;
      if (publicationReceiptHash === undefined || receiptRevision === undefined) {
        return yield* activationProductionError('Completed second-surface proof evidence is unavailable.');
      }
      const decision = yield* readPublishedActivationDecisionV1(config, observation);
      const provisionalContext = yield* buildActivationSecondSurfaceProofContextV1(config, observation, decision, {
        publicationReceiptHash,
        receiptRevision,
        startedAt: state.receipt.startedAt,
      });
      const challenge = yield* readSecondSurfaceProofChallengeV1(
        config,
        secondSurfaceChallengeIdV1(provisionalContext),
      );
      if (challenge === undefined || challenge.receipt === undefined) {
        return yield* activationProductionError('Completed second-surface attestation is unavailable.');
      }
      const expectedContext = yield* buildActivationSecondSurfaceProofContextV1(config, observation, decision, {
        publicationReceiptHash,
        receiptRevision,
        startedAt: challenge.context.startedAt,
      });
      if (secondSurfaceChallengeIdV1(expectedContext) !== challenge.challengeId) {
        return yield* activationProductionError('Completed second-surface challenge changed after verification.');
      }
      const attested = yield* verifySecondSurfaceProofAttestationV1(config, challenge, challenge.receipt);
      if (attested.proof.proofHash !== operation.subsystemReceiptHash) {
        return yield* activationProductionError('Completed second-surface proof changed after verification.');
      }
    }
  }
});

const currentBriefSourceHash = Effect.fn('activation.production.currentBriefSourceHash')(function* (
  config: RuntimeConfig,
  request: ActivationProductionRequestV1,
) {
  const sourceBefore = yield* setupRepositorySourceHash(request.repositoryRoot);
  const projected = yield* compileContextBrief(config, {
    budgetTokens: 2_000,
    mode: 'brief',
    scope: {callerCwd: request.repositoryRoot, kind: 'repository'},
    task: request.task,
  });
  const sourceAfter = yield* setupRepositorySourceHash(request.repositoryRoot);
  if (!setupBriefIsSourceVerified(projected.structuredContent) || sourceBefore !== sourceAfter) {
    return yield* activationProductionError('Activation Context Brief evidence is no longer source-verified.');
  }
  return sourceAfter;
});

function nowIso(): string {
  return new Date().toISOString();
}

function commandError(message: string): ActivationProductionCommandError {
  return ActivationProductionCommandError.make({message});
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : 'Activation command failed.';
}

function isActivationPause(error: unknown): error is {readonly message: string} {
  return typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'ActivationOperationPause';
}
