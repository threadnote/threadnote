import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Console, Effect, FileSystem, Path} from 'effect';
import {agentAdapterStatus, runAgentAdapterAction} from '../../agent_integration/adapter_actions.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {runForget} from '../../memory/index.js';
import {canonicalMemoryDocumentContent, parseMemoryDocument} from '@threadnote/memory/document';
import {readMemoryWithRelocations} from '@threadnote/memory/relocation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  buildReviewedKnowledgeDeltaGitProposal,
  runKnowledgeDeltaGitProposalMaterialize,
} from '../../git_proposal/commands.js';
import {withSharedRepositoryLock} from '../../effect/share/lock.js';
import {runShareRemove as runShareRemoveEffect} from '../../share/admin.js';
import {readTeamsFile} from '../../share/core.js';
import {withSetupMutationLock} from '../../setup/lock.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {operationIsComplete} from '../contract.js';
import {planActivationUndoV1} from '../planner.js';
import {readActivationStateV1, type ActivationStateV1} from '../store.js';
import {activationCandidateMutationOperationIdV1, readActivationMutationIntentV1} from './mutation_store.js';
import {
  initializeActivationUndoReceiptV1,
  readActivationUndoReceiptV1,
  recordActivationUndoCompletionV1,
  type ActivationUndoReceiptV1,
} from './undo_store.js';
import type {ActivationProductionObservationV1} from './observe.js';
import {activationProductionError} from './observe.js';
import {
  activationApprovedProjectionEvidenceHashV1,
  activationDecisionEvidenceHashV1,
  activationImportedMemoriesEvidenceHashV1,
  activationProposalEvidenceInputV1,
  assertActivationProposalBuildEvidenceV1,
  assertActivationProposalEvidenceContextV1,
  assertDirectActivationPublicationV1,
  assertProposalActivationPublicationV1,
  loadActivationDecisionReviewV1,
  loadActivationImportReviewsV1,
  observeCurrentActivationSurfaceV1,
  observeCurrentActivationTeamV1,
  onlyDecisionCandidate,
  readAppliedActivationImportReviewV1,
  readAppliedActivationDecisionV1,
  readOptionalPublishedActivationDecisionV1,
} from './evidence.js';
import {readActivationProposalEvidenceV1} from './proposal_store.js';

export const runActivationProductionUndoV1 = Effect.fn('activation.production.undo')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  options: {readonly approval?: string; readonly apply: boolean},
) {
  const state = yield* readActivationStateV1(config, observation.plan.activationId);
  if (state === undefined) return yield* activationProductionError('Activation state was not found.');
  if (state.plan.planHash !== observation.plan.planHash) {
    return yield* activationProductionError('Activation inputs drifted; refusing undo.');
  }
  const plan = planActivationUndoV1(state.plan, state.receipt);
  const priorUndo = yield* readActivationUndoReceiptV1(config, plan.activationId);
  const effective =
    priorUndo === undefined
      ? yield* establishActivationProductionUndoPlanV1(config, observation, state, plan)
      : resumeActivationProductionUndoPlanV1(plan, priorUndo);
  const executable = effective.operations;
  const completedBefore = new Set(priorUndo?.completedOperationIds ?? []);
  const pending = EffectArray.filter(executable, operation => !completedBefore.has(operation.operationId));
  const retainedOperationIds = effective.retainedOperationIds;
  const approvalToken = effective.approvalToken;
  const preview = {
    activationId: plan.activationId,
    completedOperationIds: [...completedBefore],
    operations: EffectArray.map(pending, operation => operation.operationId),
    retainedOperationIds,
    undoPlanHash: approvalToken,
  };
  yield* Console.log(JSON.stringify(preview, null, 2));
  if (!options.apply) {
    yield* Console.log(`Re-run with --apply --approved --approval ${approvalToken} to execute this undo plan.`);
    return preview;
  }
  if (options.approval !== approvalToken) {
    return yield* activationProductionError('Activation undo approval does not match the current undo plan.');
  }
  let undoReceipt =
    priorUndo ??
    (yield* initializeActivationUndoReceiptV1(config, {
      activationId: plan.activationId,
      operationIds: EffectArray.map(executable, operation => operation.operationId),
      publicationEvidenceHash: effective.publicationEvidenceHash,
      retainedOperationIds: preview.retainedOperationIds,
      undoPlanHash: approvalToken,
    }));
  for (const operation of pending) {
    if (operation.operationId === 'imports-review') {
      const reviews = yield* loadActivationImportReviewsV1(config, observation);
      if (
        activationImportedMemoriesEvidenceHashV1(observation.imports.sourceSetHash, reviews) !==
        operation.subsystemReceiptHash
      ) {
        return yield* activationProductionError('Activation imports changed after apply; refusing undo.');
      }
      for (const review of reviews) {
        const candidate = onlyDecisionCandidate(review);
        if (candidate.recommendation === 'no_action') {
          yield* readAppliedActivationImportReviewV1(config, observation.request.project, review);
          continue;
        }
        const intent = yield* readActivationMutationIntentV1(
          config,
          observation.plan.activationId,
          activationCandidateMutationOperationIdV1(review.reviewId, candidate.candidateId),
        );
        if (intent === undefined || intent.phase !== 'completed') {
          return yield* activationProductionError('Activation import ownership evidence is incomplete.');
        }
        if (intent.ownership === 'preexisting') continue;
        const target = candidate.applyTargetUri!;
        const resolved = yield* readMemoryWithRelocations(config, target).pipe(
          Effect.map(value => ({_tag: 'Some' as const, value})),
          Effect.catchTag('MemoryPointerNotFound', () => Effect.succeed({_tag: 'None' as const})),
        );
        if (resolved._tag === 'None') continue;
        const record = parseMemoryDocument(resolved.value.canonicalUri, resolved.value.content);
        if (
          record === undefined ||
          record.metadata.candidateId !== candidate.candidateId ||
          sha256HexSync(canonicalMemoryDocumentContent(record.content)) !== candidate.applyContentHash ||
          activationDecisionEvidenceHashV1({candidate, record, review}) !== intent.afterStateHash
        ) {
          return yield* activationProductionError('Activation import changed after apply; refusing undo.');
        }
        yield* runForget(config, record.uri, {dryRun: false});
      }
      undoReceipt = yield* recordActivationUndoCompletionV1(config, {
        activationId: plan.activationId,
        expectedRevision: undoReceipt.revision,
        operationId: operation.operationId,
      });
      continue;
    }
    if (operation.operationId === 'decision-apply') {
      const review = yield* loadActivationDecisionReviewV1(config, observation.plan.activationId);
      const target = onlyDecisionCandidate(review).applyTargetUri;
      if (target === undefined) {
        return yield* activationProductionError('Activation decision receipt lacks its applied target.');
      }
      const exists = yield* readMemoryWithRelocations(config, target).pipe(
        Effect.as(true),
        Effect.catchTag('MemoryPointerNotFound', () => Effect.succeed(false)),
      );
      if (!exists) {
        undoReceipt = yield* recordActivationUndoCompletionV1(config, {
          activationId: plan.activationId,
          expectedRevision: undoReceipt.revision,
          operationId: operation.operationId,
        });
        continue;
      }
      const decision = yield* readAppliedActivationDecisionV1(config, observation);
      const intent = yield* readActivationMutationIntentV1(
        config,
        observation.plan.activationId,
        activationCandidateMutationOperationIdV1(decision.review.reviewId, decision.candidate.candidateId),
      );
      if (
        intent === undefined ||
        intent.phase !== 'completed' ||
        intent.ownership !== 'activation-created' ||
        intent.afterStateHash !== activationDecisionEvidenceHashV1(decision)
      ) {
        return yield* activationProductionError('Activation decision ownership evidence is incomplete.');
      }
      if (activationDecisionEvidenceHashV1(decision) !== operation.subsystemReceiptHash) {
        return yield* activationProductionError('Activation decision changed after apply; refusing undo.');
      }
      yield* runForget(config, decision.record.uri, {dryRun: false});
      undoReceipt = yield* recordActivationUndoCompletionV1(config, {
        activationId: plan.activationId,
        expectedRevision: undoReceipt.revision,
        operationId: operation.operationId,
      });
      continue;
    }
    if (operation.operationId === 'team-share') {
      yield* withSharedRepositoryLock(
        config,
        Effect.gen(function* () {
          const teams = yield* readTeamsFile(config);
          if (teams.teams[observation.request.team.name] === undefined) return;
          const team = yield* observeCurrentActivationTeamV1(config, observation.request.team.name);
          if (team.evidenceHash !== operation.subsystemReceiptHash) {
            return yield* activationProductionError('Activation team changed after setup; refusing undo.');
          }
          yield* runShareRemoveEffect(config, {team: observation.request.team.name});
        }),
      );
      undoReceipt = yield* recordActivationUndoCompletionV1(config, {
        activationId: plan.activationId,
        expectedRevision: undoReceipt.revision,
        operationId: operation.operationId,
      });
      continue;
    }
    const adapter =
      operation.operationId === 'surface-primary'
        ? observation.primaryAdapter
        : operation.operationId === 'surface-secondary'
          ? observation.secondaryAdapter
          : undefined;
    if (adapter === undefined) continue;
    yield* withSetupMutationLock(
      config.agentContextHome,
      Effect.gen(function* () {
        const before = yield* agentAdapterStatus(config, adapter);
        if (before.state === 'absent') return;
        const current = yield* observeCurrentActivationSurfaceV1(config, adapter);
        if (current.evidenceHash !== operation.subsystemReceiptHash) {
          return yield* activationProductionError(`${adapter.catalog.id} changed after setup; refusing undo.`);
        }
        yield* runAgentAdapterAction(
          config,
          adapter,
          'remove',
          true,
          observation.request.scope,
          observation.request.repositoryRoot,
          true,
        );
        const after = yield* agentAdapterStatus(config, adapter);
        if (after.state !== 'absent') {
          return yield* activationProductionError(`${adapter.catalog.id} was not removed by activation undo.`);
        }
      }),
    );
    undoReceipt = yield* recordActivationUndoCompletionV1(config, {
      activationId: plan.activationId,
      expectedRevision: undoReceipt.revision,
      operationId: operation.operationId,
    });
  }
  yield* Console.log(JSON.stringify(undoReceipt, null, 2));
  return undoReceipt;
});

export function activationProductionUndoApprovalTokenV1(input: {
  readonly baseUndoPlanHash: string;
  readonly operations: readonly {
    readonly inputHash: string;
    readonly operationId: string;
    readonly outcomeHash: string;
    readonly subsystemReceiptHash: string;
  }[];
  readonly publicationEvidenceHash: string;
  readonly retainedOperationIds: readonly string[];
}): string {
  return sha256HexSync(
    canonicalJson({
      baseUndoPlanHash: input.baseUndoPlanHash,
      operations: input.operations,
      publicationEvidenceHash: input.publicationEvidenceHash,
      retainedOperationIds: input.retainedOperationIds,
      type: 'threadnote-activation-production-undo-approval',
      version: 1,
    }),
  );
}

type ActivationUndoPlan = ReturnType<typeof planActivationUndoV1>;
type ActivationUndoOperation = ActivationUndoPlan['operations'][number];

interface EffectiveActivationProductionUndoPlanV1 {
  readonly approvalToken: string;
  readonly operations: readonly ActivationUndoOperation[];
  readonly publicationEvidenceHash: string;
  readonly retainedOperationIds: readonly string[];
}

const establishActivationProductionUndoPlanV1 = Effect.fn('activation.production.undo.establishPlan')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  state: ActivationStateV1,
  plan: ActivationUndoPlan,
) {
  const receiptPublished = EffectArray.some(
    state.receipt.operations,
    operation =>
      (operation.kind === 'decision.publish' || operation.kind === 'decision.propose') &&
      operationIsComplete(operation.status),
  );
  const publication = yield* observeActivationPublicationForUndoV1(config, observation, state, receiptPublished);
  const published = receiptPublished || publication.published;
  const operations = EffectArray.filter(plan.operations, operation =>
    published ? operation.operationId !== 'decision-apply' && operation.operationId !== 'team-share' : true,
  );
  const retainedOperationIds = [
    ...new Set([
      ...plan.retainedOperationIds,
      ...EffectArray.map(
        EffectArray.filter(plan.operations, operation => !operations.includes(operation)),
        operation => operation.operationId,
      ),
    ]),
  ].sort();
  return {
    approvalToken: activationProductionUndoApprovalTokenV1({
      baseUndoPlanHash: plan.undoPlanHash,
      operations,
      publicationEvidenceHash: publication.evidenceHash,
      retainedOperationIds,
    }),
    operations,
    publicationEvidenceHash: publication.evidenceHash,
    retainedOperationIds,
  };
});

function resumeActivationProductionUndoPlanV1(
  plan: ActivationUndoPlan,
  receipt: ActivationUndoReceiptV1,
): EffectiveActivationProductionUndoPlanV1 {
  const operationById = new Map(EffectArray.map(plan.operations, operation => [operation.operationId, operation]));
  const selected = new Set(receipt.operationIds);
  const operations = EffectArrayPipe(plan.operations, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (operation, __effectArrayIndex) =>
        __effectArrayIndex in __effectArrayValues && selected.has(operation.operationId),
    ),
  );
  const canonicalOperationIds = EffectArray.map(operations, operation => operation.operationId);
  const canonicalRetainedOperationIds = [
    ...new Set([
      ...plan.retainedOperationIds,
      ...EffectArray.map(
        EffectArray.filter(plan.operations, operation => !selected.has(operation.operationId)),
        operation => operation.operationId,
      ),
    ]),
  ].sort();
  const approvalToken = activationProductionUndoApprovalTokenV1({
    baseUndoPlanHash: plan.undoPlanHash,
    operations,
    publicationEvidenceHash: receipt.publicationEvidenceHash,
    retainedOperationIds: canonicalRetainedOperationIds,
  });
  if (
    EffectArray.some(receipt.operationIds, operationId => !operationById.has(operationId)) ||
    EffectArray.some(receipt.operationIds, operationId => receipt.retainedOperationIds.includes(operationId)) ||
    canonicalJson(receipt.operationIds) !== canonicalJson(canonicalOperationIds) ||
    canonicalJson(receipt.retainedOperationIds) !== canonicalJson(canonicalRetainedOperationIds) ||
    receipt.undoPlanHash !== approvalToken
  ) {
    throw new Error('Activation undo receipt does not match the activation undo plan.');
  }
  return {
    approvalToken,
    operations,
    publicationEvidenceHash: receipt.publicationEvidenceHash,
    retainedOperationIds: receipt.retainedOperationIds,
  };
}

const observeActivationPublicationForUndoV1 = Effect.fn('activation.production.undo.observePublication')(function* (
  config: RuntimeConfig,
  observation: ActivationProductionObservationV1,
  state: ActivationStateV1,
  receiptPublished: boolean,
) {
  const publicationOperation = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      state.receipt.operations,
      operation => operation.kind === 'decision.publish' || operation.kind === 'decision.propose',
    ),
  );
  const receiptEvidence =
    publicationOperation === undefined
      ? null
      : {
          id: publicationOperation.id,
          outcomeHash: publicationOperation.outcomeHash ?? null,
          status: publicationOperation.status,
          subsystemReceiptHash: publicationOperation.subsystemReceiptHash ?? null,
        };
  const decisionApplied = EffectArray.some(
    state.receipt.operations,
    operation => operation.kind === 'decision.apply' && operationIsComplete(operation.status),
  );
  if (!decisionApplied) {
    return {
      evidenceHash: sha256HexSync(canonicalJson({mode: observation.request.publicationMode, receiptEvidence})),
      published: receiptPublished,
    };
  }
  const applied = yield* readAppliedActivationDecisionV1(config, observation);
  const published = yield* readOptionalPublishedActivationDecisionV1(config, observation);
  if (observation.request.publicationMode === 'direct') {
    if (published._tag === 'Some') assertDirectActivationPublicationV1(applied, published.decision);
    return {
      evidenceHash: sha256HexSync(
        canonicalJson({
          appliedProjectionHash: activationApprovedProjectionEvidenceHashV1(applied),
          mode: 'direct',
          published:
            published._tag === 'None'
              ? null
              : {
                  canonicalUri: published.decision.record.uri,
                  memoryId: published.decision.record.metadata.memoryId ?? null,
                  projectionHash: activationApprovedProjectionEvidenceHashV1(published.decision),
                },
          receiptEvidence,
        }),
      ),
      published: receiptPublished || published._tag === 'Some',
    };
  }
  const evidence = yield* readActivationProposalEvidenceV1(config, observation.plan.activationId);
  if (published._tag === 'Some') {
    if (evidence !== undefined) {
      assertProposalActivationPublicationV1(evidence, published.decision);
    } else if (
      activationApprovedProjectionEvidenceHashV1(published.decision) !==
      activationApprovedProjectionEvidenceHashV1(applied)
    ) {
      return yield* activationProductionError('Published activation proposal does not match its reviewed decision.');
    }
  }
  let materialization;
  if (evidence !== undefined) {
    const team = yield* observeCurrentActivationTeamV1(config, observation.request.team.name);
    assertActivationProposalEvidenceContextV1(observation, applied, team, evidence);
    const built = yield* buildReviewedKnowledgeDeltaGitProposal(config, {
      approved: true,
      candidateIds: [onlyDecisionCandidate(applied.review).candidateId],
      reviewId: applied.review.reviewId,
      revision: applied.review.revision,
      team: observation.request.team.name,
    });
    assertActivationProposalBuildEvidenceV1(
      evidence,
      activationProposalEvidenceInputV1(observation, applied, team, built),
    );
    materialization = yield* Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-undo-proposal-'});
        const proposalPath = path.join(directory, `${observation.plan.activationId}.json`);
        yield* fs.writeFileString(proposalPath, built.artifact, {flag: 'wx', mode: 0o600});
        return yield* runKnowledgeDeltaGitProposalMaterialize(config, {
          apply: false,
          proposal: proposalPath,
          team: observation.request.team.name,
        });
      }),
    );
  }
  return {
    evidenceHash: sha256HexSync(
      canonicalJson({
        evidenceRevision: evidence?.revision ?? null,
        materialization: materialization ?? null,
        mode: 'proposal',
        published:
          published._tag === 'None'
            ? null
            : {
                canonicalUri: published.decision.record.uri,
                memoryId: published.decision.record.metadata.memoryId ?? null,
                projectionHash: activationApprovedProjectionEvidenceHashV1(published.decision),
              },
        receiptEvidence,
      }),
    ),
    published: receiptPublished || published._tag === 'Some' || materialization?.materialized === true,
  };
});
