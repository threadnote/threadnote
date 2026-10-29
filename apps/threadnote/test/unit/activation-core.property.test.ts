import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  bindActivationApprovalV1,
  createActivationPlanV1,
  createActivationReceiptV1,
  parseActivationPlanV1,
  parseActivationReceiptV1,
  previewActivationResumeV1,
  recordActivationOutcomeV1,
} from '@threadnote/threadnote/activation/index';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const hex = fc.string({unit: fc.constantFrom(...'0123456789abcdef'), minLength: 64, maxLength: 64});
const identifier = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'),
    fc.string({unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), maxLength: 23}),
  )
  .map(([first, rest]) => `${first}${rest}`);
const version = fc.string({
  unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.-'),
  minLength: 1,
  maxLength: 24,
});

const inputArbitrary = fc
  .record({
    catalogSnapshotHash: hex,
    primarySurfaceId: identifier,
    publicationMode: fc.constantFrom('direct' as const, 'proposal' as const),
    repositoryIdentityHash: hex,
    secondarySurfaceId: identifier,
    selectedSourceSetHash: hex,
    taskHash: hex,
    teamId: identifier,
    teamShareStateHash: hex,
    threadnoteVersion: version,
  })
  .filter(value => value.primarySurfaceId !== value.secondarySurfaceId);

describe('activation core properties', () => {
  it('keeps plan identity deterministic and sensitive to every observed input', () => {
    fc.assert(
      fc.property(inputArbitrary, input => {
        const plan = createActivationPlanV1(input);
        expect(createActivationPlanV1(structuredClone(input))).toEqual(plan);
        const mutations = [
          {...input, catalogSnapshotHash: flipHash(input.catalogSnapshotHash)},
          {...input, primarySurfaceId: changedIdentifier(input.primarySurfaceId, input.secondarySurfaceId)},
          {...input, publicationMode: input.publicationMode === 'direct' ? ('proposal' as const) : ('direct' as const)},
          {...input, repositoryIdentityHash: flipHash(input.repositoryIdentityHash)},
          {...input, secondarySurfaceId: changedIdentifier(input.secondarySurfaceId, input.primarySurfaceId)},
          {...input, selectedSourceSetHash: flipHash(input.selectedSourceSetHash)},
          {...input, taskHash: flipHash(input.taskHash)},
          {...input, teamId: `${input.teamId}-changed`},
          {...input, teamShareStateHash: flipHash(input.teamShareStateHash)},
          {...input, threadnoteVersion: `${input.threadnoteVersion}.changed`},
        ];
        for (const mutated of mutations) expect(createActivationPlanV1(mutated).planHash).not.toBe(plan.planHash);
      }),
      {numRuns: 100},
    );
  });

  it('advances monotonically, never bypasses gates, and replays exact outcomes idempotently', () => {
    fc.assert(
      fc.property(inputArbitrary, input => {
        const plan = createActivationPlanV1(input);
        let receipt = createActivationReceiptV1(plan, '2026-09-18T08:00:00.000Z');
        for (const [index, operation] of plan.operations.entries()) {
          const resume = previewActivationResumeV1(plan, receipt);
          if (resume.status === 'completed' || resume.status === 'drifted') {
            throw new Error(`Unexpected activation resume state ${resume.status}.`);
          }
          expect(resume.operationId).toBe(operation.id);
          expect(resume.status).toBe(operation.approvalKind === undefined ? 'ready' : 'awaiting-approval');
          const approval =
            operation.approvalKind === undefined
              ? undefined
              : bindActivationApprovalV1(plan, receipt, operation.id, flipHash(operation.inputHash));
          const outcome = {
            ownership: 'preexisting' as const,
            status: operation.expectedOutcome,
            subsystemReceiptHash: flipHash(operation.inputHash),
            undoEligible: false,
          };
          const transition = recordActivationOutcomeV1({
            approval,
            now: `2026-09-18T08:${Effect.pipe(String(index), EffectString.padStart(2, '0'))}:00.000Z`,
            operationId: operation.id,
            outcome,
            plan,
            receipt,
          });
          expect(transition.status).toBe('updated');
          if (transition.status !== 'updated') return;
          const replay = recordActivationOutcomeV1({
            approval,
            now: '2026-09-18T09:59:00.000Z',
            operationId: operation.id,
            outcome,
            plan,
            receipt: transition.receipt,
          });
          expect(replay).toEqual({receipt: transition.receipt, status: 'already-recorded'});
          receipt = transition.receipt;
        }
        expect(previewActivationResumeV1(plan, receipt).status).toBe('completed');
      }),
      {numRuns: 50},
    );
  });

  it('keeps a persisted plan and receipt resume frontier deterministic across JSON round trips', () => {
    fc.assert(
      fc.property(inputArbitrary, input => {
        const plan = createActivationPlanV1(input);
        const receipt = createActivationReceiptV1(plan, '2026-09-18T08:00:00.000Z');
        const restoredPlan = parseActivationPlanV1(JSON.parse(JSON.stringify(plan)));
        const restoredReceipt = parseActivationReceiptV1(JSON.parse(JSON.stringify(receipt)));
        expect(previewActivationResumeV1(restoredPlan, restoredReceipt)).toEqual(
          previewActivationResumeV1(plan, receipt),
        );
      }),
      {numRuns: 50},
    );
  });
});

function flipHash(value: string): string {
  return `${value[0] === '0' ? '1' : '0'}${Effect.pipe(value, EffectString.slice(1))}`;
}

function changedIdentifier(value: string, avoid: string): string {
  const changed = `${value}x`;
  return changed === avoid ? `${changed}x` : changed;
}
