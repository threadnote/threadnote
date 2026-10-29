import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  bindActivationApprovalV1,
  createActivationReceiptV1,
  recordActivationOutcomeV1,
} from '@threadnote/threadnote/activation/receipt';
import {activationStatePathsV1, initializeActivationStateV1} from '@threadnote/threadnote/activation/store';
import {observeActivationProductionV1} from '@threadnote/threadnote/activation/production/observe';
import {parseActivationProductionRequestV1} from '@threadnote/threadnote/activation/production/contract';
import {
  activationApprovedProjectionEvidenceHashV1,
  activationDecisionEvidenceHashV1,
  findOrCreateActivationDecisionReviewV1,
  onlyDecisionCandidate,
  readAppliedActivationDecisionV1,
} from '@threadnote/threadnote/activation/production/evidence';
import {
  activationCandidateMutationOperationIdV1,
  completeActivationMutationIntentV1,
  prepareActivationMutationIntentV1,
} from '@threadnote/threadnote/activation/production/mutation_store';
import {runActivationProductionUndoV1} from '@threadnote/threadnote/activation/production/undo';
import {
  initializeActivationUndoReceiptV1,
  recordActivationUndoCompletionV1,
  type ActivationUndoReceiptV1,
} from '@threadnote/threadnote/activation/production/undo_store';
import type {ActivationPlanV1} from '@threadnote/threadnote/activation/contract';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runCloseoutApply} from '@threadnote/threadnote/memory/closeout';
import {runForget} from '@threadnote/threadnote/memory/index';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('activation production undo interruption recovery', () => {
  effectIt.effect('resumes when decision deletion completed before its receipt CAS', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeUndoFixture();
        yield* runForget(fixture.config, fixture.decision.record.uri, {dryRun: false});

        const resumed = yield* runActivationProductionUndoV1(fixture.config, fixture.observation, {
          apply: true,
          approval: fixture.preview.undoPlanHash,
        });

        if (!('status' in resumed)) throw new Error('Expected a completed activation undo receipt.');
        expect(resumed.status).toBe('completed');
        expect(resumed.completedOperationIds).toContain('decision-apply');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('resumes when decision deletion and its receipt CAS both completed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeUndoFixture();
        yield* runForget(fixture.config, fixture.decision.record.uri, {dryRun: false});
        yield* recordActivationUndoCompletionV1(fixture.config, {
          activationId: fixture.observation.plan.activationId,
          expectedRevision: fixture.undoReceipt.revision,
          operationId: 'decision-apply',
        });

        const resumed = yield* runActivationProductionUndoV1(fixture.config, fixture.observation, {
          apply: true,
          approval: fixture.preview.undoPlanHash,
        });

        if (!('status' in resumed)) throw new Error('Expected a completed activation undo receipt.');
        expect(resumed.status).toBe('completed');
        expect(resumed.completedOperationIds).toEqual(['decision-apply']);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a rehashed receipt that swaps a retained operation into the deletion scope', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeUndoFixture();
        expect(fixture.undoReceipt.operationIds).toEqual(['decision-apply']);
        expect(fixture.undoReceipt.retainedOperationIds).toContain('team-share');
        yield* rewriteUndoReceipt(fixture.config, fixture.undoReceipt, {
          operationIds: ['team-share'],
          retainedOperationIds: EffectArray.map(fixture.undoReceipt.retainedOperationIds, operationId =>
            operationId === 'team-share' ? 'decision-apply' : operationId,
          ),
        });

        const rejected = yield* runActivationProductionUndoV1(fixture.config, fixture.observation, {
          apply: true,
          approval: fixture.preview.undoPlanHash,
        }).pipe(Effect.exit);

        expect(Exit.isFailure(rejected)).toBe(true);
        expect((yield* readAppliedActivationDecisionV1(fixture.config, fixture.observation)).record.uri).toBe(
          fixture.decision.record.uri,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a rehashed receipt whose executable operations are reordered', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeUndoFixture({includeTeamUndo: true});
        expect(fixture.undoReceipt.operationIds).toEqual(['decision-apply', 'team-share']);
        yield* rewriteUndoReceipt(fixture.config, fixture.undoReceipt, {
          operationIds: [...fixture.undoReceipt.operationIds].reverse(),
          retainedOperationIds: fixture.undoReceipt.retainedOperationIds,
        });

        const rejected = yield* runActivationProductionUndoV1(fixture.config, fixture.observation, {
          apply: true,
          approval: fixture.preview.undoPlanHash,
        }).pipe(Effect.exit);

        expect(Exit.isFailure(rejected)).toBe(true);
        expect((yield* readAppliedActivationDecisionV1(fixture.config, fixture.observation)).record.uri).toBe(
          fixture.decision.record.uri,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const makeUndoFixture = Effect.fn('test.activation.undoFixture')(function* (
  options: {readonly includeTeamUndo?: boolean} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const command = yield* CommandExecutor;
  const repositoryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-undo-resume-repo-'});
  const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-undo-resume-home-'});
  yield* command.execute('git', ['init', '--quiet'], {
    cwd: repositoryRoot,
    maxOutputBytes: 4_096,
    timeoutMs: 5_000,
  });
  const config = {
    account: 'test',
    agentContextHome,
    agentId: 'test-agent',
    agentIdSource: 'system' as const,
    manifestPath: path.join(agentContextHome, 'manifest.yaml'),
    user: 'test-user',
    userSource: 'system' as const,
  };
  const observation = yield* observeActivationProductionV1(
    config,
    parseActivationProductionRequestV1({
      adrPaths: [],
      decision: {
        constraints: ['Stay offline.'],
        decision: 'Keep Git as the shared source of truth.',
        invalidated: [],
        rationale: 'It preserves review and portability.',
        unresolvedRisks: [],
        verification: ['The local decision was applied.'],
      },
      primarySurfaceId: 'codex-cli',
      project: 'threadnote',
      publicationMode: 'direct',
      repositoryRoot,
      secondarySurfaceId: 'claude-code',
      task: 'Exercise undo recovery.',
      team: {name: 'default', push: false, remotePath: repositoryRoot, setDefault: true},
      topic: 'activation-undo-resume',
      type: 'threadnote-activation-request',
      version: 1,
    }),
  );
  const review = yield* findOrCreateActivationDecisionReviewV1(config, observation);
  const candidate = onlyDecisionCandidate(review);
  const applied = yield* runCloseoutApply(config, {
    action: 'approve',
    approved: true,
    candidateId: candidate.candidateId,
    operation: 'create',
    reviewId: review.reviewId,
    revision: review.revision,
  });
  if (applied.isError === true) throw new Error('Could not apply activation decision fixture.');
  const decision = yield* readAppliedActivationDecisionV1(config, observation);
  const operationId = activationCandidateMutationOperationIdV1(review.reviewId, candidate.candidateId);
  const intent = yield* prepareActivationMutationIntentV1(config, {
    activationId: observation.plan.activationId,
    beforeStateHash: Effect2.pipe('a', EffectString.repeat(64)),
    operationId,
    ownership: 'activation-created',
    targetHash: Effect2.pipe('b', EffectString.repeat(64)),
  });
  yield* completeActivationMutationIntentV1(config, {
    activationId: observation.plan.activationId,
    afterStateHash: activationDecisionEvidenceHashV1(decision),
    expectedRevision: intent.revision,
    operationId,
  });
  const receipt = receiptThroughDecisionApply(
    observation.plan,
    activationDecisionEvidenceHashV1(decision),
    options.includeTeamUndo === true,
  );
  yield* initializeActivationStateV1(config, observation.plan, receipt);
  const previewResult = yield* runActivationProductionUndoV1(config, observation, {apply: false});
  if (!('operations' in previewResult)) throw new Error('Expected an activation undo preview.');
  expect(previewResult.operations).toEqual(
    options.includeTeamUndo === true ? ['decision-apply', 'team-share'] : ['decision-apply'],
  );
  const publicationOperation = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      receipt.operations,
      operation => operation.kind === 'decision.publish' || operation.kind === 'decision.propose',
    ),
  );
  const publicationEvidenceHash = sha256HexSync(
    canonicalJson({
      appliedProjectionHash: activationApprovedProjectionEvidenceHashV1(decision),
      mode: 'direct',
      published: null,
      receiptEvidence:
        publicationOperation === undefined
          ? null
          : {
              id: publicationOperation.id,
              outcomeHash: publicationOperation.outcomeHash ?? null,
              status: publicationOperation.status,
              subsystemReceiptHash: publicationOperation.subsystemReceiptHash ?? null,
            },
    }),
  );
  const undoReceipt = yield* initializeActivationUndoReceiptV1(config, {
    activationId: observation.plan.activationId,
    operationIds: previewResult.operations,
    publicationEvidenceHash,
    retainedOperationIds: previewResult.retainedOperationIds,
    undoPlanHash: previewResult.undoPlanHash,
  });
  return {config, decision, observation, preview: previewResult, undoReceipt};
});

function receiptThroughDecisionApply(plan: ActivationPlanV1, decisionEvidenceHash: string, includeTeamUndo: boolean) {
  let receipt = createActivationReceiptV1(plan, '2026-09-18T08:00:00.000Z');
  for (const operation of plan.operations) {
    const approval =
      operation.approvalKind === undefined
        ? undefined
        : bindActivationApprovalV1(plan, receipt, operation.id, Effect2.pipe('c', EffectString.repeat(64)));
    const undoEligible = operation.kind === 'decision.apply' || (includeTeamUndo && operation.id === 'team-share');
    const transition = recordActivationOutcomeV1({
      approval,
      now: new Date(Date.parse(receipt.updatedAt) + 1_000).toISOString(),
      operationId: operation.id,
      outcome: {
        ownership: undoEligible ? 'activation-created' : 'preexisting',
        status: operation.expectedOutcome,
        subsystemReceiptHash:
          operation.kind === 'decision.apply' ? decisionEvidenceHash : Effect2.pipe('d', EffectString.repeat(64)),
        undoEligible,
      },
      plan,
      receipt,
    });
    if (transition.status === 'conflict') throw new Error(`Could not build receipt: ${transition.code}`);
    receipt = transition.receipt;
    if (operation.kind === 'decision.apply') break;
  }
  return receipt;
}

const rewriteUndoReceipt = Effect.fn('test.activation.rewriteUndoReceipt')(function* (
  config: {readonly agentContextHome: string},
  receipt: ActivationUndoReceiptV1,
  replacement: Pick<ActivationUndoReceiptV1, 'operationIds' | 'retainedOperationIds'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* activationStatePathsV1(config, receipt.activationId);
  const {revision: _, ...currentBody} = receipt;
  const body = {...currentBody, ...replacement};
  const forged = {...body, revision: sha256HexSync(canonicalJson(body))};
  yield* fs.writeFileString(path.join(paths.root, 'undo.json'), `${JSON.stringify(forged)}\n`);
});
