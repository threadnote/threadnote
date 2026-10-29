import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {createActivationPlanV1} from '@threadnote/threadnote/activation/planner';
import {
  bindActivationApprovalV1,
  createActivationReceiptV1,
  recordActivationOutcomeV1,
} from '@threadnote/threadnote/activation/receipt';
import type {ActivationReceiptV1} from '@threadnote/threadnote/activation/contract';
import {reconcileActivationValueEventsV1} from '@threadnote/threadnote/activation/value';
import {initializeActivationStateV1} from '@threadnote/threadnote/activation/store';
import {captureThreadnote5ActivationTrialV1} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-receipts';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {readLocalValueEvents, summarizeLocalValueEvents} from '@threadnote/threadnote/value_report/events';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('activation value events', () => {
  effectIt.effect('captures a completed production chain and zero-attempt offline observer for readiness replay', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-capture-'});
        const plan = createActivationPlanV1({
          catalogSnapshotHash: Effect2.pipe('a', EffectString.repeat(64)),
          primarySurfaceId: 'codex-cli',
          publicationMode: 'direct',
          repositoryIdentityHash: Effect2.pipe('b', EffectString.repeat(64)),
          secondarySurfaceId: 'claude-code',
          selectedSourceSetHash: Effect2.pipe('c', EffectString.repeat(64)),
          taskHash: Effect2.pipe('d', EffectString.repeat(64)),
          teamId: 'default',
          teamShareStateHash: Effect2.pipe('e', EffectString.repeat(64)),
          threadnoteVersion: '5.0.0-test',
        });
        const {approvals, receipt, receiptChain} = completedActivation(plan);
        yield* initializeActivationStateV1({agentContextHome: home}, plan, receipt);
        yield* reconcileActivationValueEventsV1({agentContextHome: home}, {plan, receipt});
        const capture = yield* captureThreadnote5ActivationTrialV1(
          {agentContextHome: home},
          {
            activationId: plan.activationId,
            approvals,
            offlineObserver: {attemptedNetworkActivityCount: () => 0},
            receiptChain,
          },
        );
        expect(capture).toMatchObject({
          authorityTrial: {
            activationId: plan.activationId,
            attestationDigest: null,
            finalReceiptRevision: receipt.revision,
            offlineObservationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            resumeBoundaryRevision: null,
          },
          trial: {
            offlineObservation: {
              afterAttemptCount: 0,
              afterRevision: receipt.revision,
              beforeAttemptCount: 0,
              beforeRevision: receiptChain[0].revision,
            },
            state: {plan, receipt},
          },
        });
        expect(capture.trial.events).toHaveLength(4);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('derives four content-free events once across replay and concurrent resume', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-value-'});
        const plan = createActivationPlanV1({
          catalogSnapshotHash: Effect2.pipe('a', EffectString.repeat(64)),
          primarySurfaceId: 'codex-cli',
          publicationMode: 'direct',
          repositoryIdentityHash: Effect2.pipe('b', EffectString.repeat(64)),
          secondarySurfaceId: 'claude-code',
          selectedSourceSetHash: Effect2.pipe('c', EffectString.repeat(64)),
          taskHash: Effect2.pipe('d', EffectString.repeat(64)),
          teamId: 'default',
          teamShareStateHash: Effect2.pipe('e', EffectString.repeat(64)),
          threadnoteVersion: '5.0.0-test',
        });
        const receipt = completedActivation(plan).receipt;
        const state = {plan, receipt};
        yield* TestClock.withLive(
          Effect.all(
            Array.from({length: 8}, () => reconcileActivationValueEventsV1({agentContextHome: home}, state)),
            {concurrency: 'unbounded'},
          ),
        );
        yield* reconcileActivationValueEventsV1({agentContextHome: home}, state);
        const events = yield* readLocalValueEvents(home);
        expect(events).toHaveLength(4);
        expect(
          EffectArray.map(events, event => (event.kind === 'activation' ? event.phase : 'unexpected')).sort(),
        ).toEqual(['completed', 'first-evidence', 'second-surface-proof', 'started']);
        expect(
          summarizeLocalValueEvents(events, {
            from: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-18T00:00:00.000Z')),
            to: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-19T00:00:00.000Z')),
          }).setup,
        ).toEqual({
          completed: 1,
          failed: 0,
          started: 1,
          supportedAgentReuse: 1,
          timeToFirstEvidenceMillisecondsSamples: [6_000],
        });
        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain(plan.activationId);
        expect(serialized).not.toContain('private task');
        expect(serialized).not.toContain('/private/repository');
        expect(serialized).not.toContain('memory body');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function completedActivation(plan: ReturnType<typeof createActivationPlanV1>): {
  readonly approvals: readonly NonNullable<Parameters<typeof recordActivationOutcomeV1>[0]['approval']>[];
  readonly receipt: ActivationReceiptV1;
  readonly receiptChain: readonly ActivationReceiptV1[];
} {
  let receipt = createActivationReceiptV1(plan, '2026-09-18T08:00:00.000Z');
  const approvals: NonNullable<Parameters<typeof recordActivationOutcomeV1>[0]['approval']>[] = [];
  const receiptChain = [receipt];
  for (const [index, operation] of plan.operations.entries()) {
    const approval =
      operation.approvalKind === undefined
        ? undefined
        : bindActivationApprovalV1(plan, receipt, operation.id, Effect2.pipe('f', EffectString.repeat(64)));
    if (approval !== undefined) approvals.push(approval);
    const transition = recordActivationOutcomeV1({
      approval,
      now: new Date(Date.parse(receipt.updatedAt) + 1_000).toISOString(),
      operationId: operation.id,
      outcome: {
        ownership: operation.reversible ? 'activation-created' : 'preexisting',
        status: operation.expectedOutcome,
        subsystemReceiptHash: Effect2.pipe((index + 1).toString(16), EffectString.padStart(64, '0')),
        undoEligible: operation.reversible,
      },
      plan,
      receipt,
    });
    if (transition.status === 'conflict') throw new Error(`Could not build activation receipt: ${transition.code}`);
    receipt = transition.receipt;
    receiptChain.push(receipt);
  }
  return {approvals, receipt, receiptChain};
}
