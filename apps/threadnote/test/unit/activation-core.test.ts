import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  activationPlanHashV1,
  activationReceiptRevisionV1,
  activationUndoApprovalMatchesV1,
  bindActivationApprovalV1,
  bindActivationUndoApprovalV1,
  createActivationPlanV1,
  createActivationReceiptV1,
  parseActivationPlanV1,
  parseActivationReceiptV1,
  planActivationUndoV1,
  previewActivationResumeV1,
  recordActivationOutcomeV1,
  withActivationLifecycleLock,
  withActivationReceiptLock,
} from '@threadnote/threadnote/activation/index';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const digest = (character: string) => Effect2.pipe(character, EffectString.repeat(64));
const now = '2026-09-18T08:00:00.000Z';
const later = '2026-09-18T08:01:00.000Z';

const planInput = {
  catalogSnapshotHash: digest('a'),
  primarySurfaceId: 'codex-cli',
  publicationMode: 'proposal' as const,
  repositoryIdentityHash: digest('b'),
  secondarySurfaceId: 'claude-code',
  selectedSourceSetHash: digest('c'),
  taskHash: digest('d'),
  teamId: 'default',
  teamShareStateHash: digest('e'),
  threadnoteVersion: '5.0.0-local.test',
};

const success = (kind: 'applied' | 'verified' = 'applied', created = false) => ({
  ownership: created ? ('activation-created' as const) : ('preexisting' as const),
  status: kind,
  subsystemReceiptHash: digest(created ? 'f' : '9'),
  undoEligible: created,
});

describe('activation core', () => {
  it('creates a deterministic, content-free plan for two distinct catalog surfaces', () => {
    const first = createActivationPlanV1(planInput);
    const second = createActivationPlanV1(structuredClone(planInput));

    expect(first).toEqual(second);
    expect(EffectArray.map(first.operations, operation => operation.kind)).toEqual([
      'surface.primary.ensure',
      'surface.secondary.ensure',
      'team.ensure',
      'imports.preview',
      'imports.review',
      'brief.verify',
      'decision.review',
      'decision.apply',
      'decision.propose',
      'secondary.prove',
    ]);
    expect(JSON.stringify(first)).not.toContain('/Users/');
    expect(() => createActivationPlanV1({...planInput, secondarySurfaceId: planInput.primarySurfaceId})).toThrow(
      /distinct/u,
    );
  });

  it('rejects self-hashed plans that weaken the canonical approval contract', () => {
    const plan = createActivationPlanV1(planInput);
    const operations = EffectArray.map(plan.operations, operation => {
      if (operation.id !== 'imports-review') return operation;
      const {approvalKind: _, ...withoutApproval} = operation;
      return withoutApproval;
    });
    const {planHash: _, ...body} = {...plan, operations};
    expect(() => parseActivationPlanV1({...body, planHash: activationPlanHashV1(body)})).toThrow(/canonical/u);
  });

  it('stops at every approval boundary and binds approval to the exact receipt revision', () => {
    const plan = createActivationPlanV1(planInput);
    let receipt = createActivationReceiptV1(plan, now);

    for (const operation of plan.operations.slice(0, 4)) {
      const transition = recordActivationOutcomeV1({
        now,
        operationId: operation.id,
        outcome: success(operation.kind === 'imports.preview' ? 'verified' : 'applied'),
        plan,
        receipt,
      });
      expect(transition.status).toBe('updated');
      if (transition.status !== 'updated') throw new Error('Expected activation transition.');
      receipt = transition.receipt;
    }

    expect(previewActivationResumeV1(plan, receipt)).toMatchObject({
      approvalKind: 'imports-reviewed',
      operationId: 'imports-review',
      status: 'awaiting-approval',
    });
    expect(
      recordActivationOutcomeV1({
        now,
        operationId: 'imports-review',
        outcome: success('verified'),
        plan,
        receipt,
      }),
    ).toMatchObject({code: 'approval-required', status: 'conflict'});

    const approval = bindActivationApprovalV1(plan, receipt, 'imports-review', digest('1'));
    const staleReceipt = receipt;
    const accepted = recordActivationOutcomeV1({
      approval,
      now,
      operationId: 'imports-review',
      outcome: success('verified'),
      plan,
      receipt,
    });
    expect(accepted.status).toBe('updated');
    if (accepted.status !== 'updated') throw new Error('Expected approved activation transition.');
    receipt = accepted.receipt;

    expect(
      recordActivationOutcomeV1({
        approval,
        now,
        operationId: 'imports-review',
        outcome: success('verified'),
        plan,
        receipt: staleReceipt,
      }),
    ).toEqual(accepted);
    expect(
      recordActivationOutcomeV1({
        approval,
        now,
        operationId: 'imports-review',
        outcome: {...success('verified'), subsystemReceiptHash: digest('2')},
        plan,
        receipt,
      }),
    ).toMatchObject({code: 'outcome-mismatch', status: 'conflict'});
  });

  it('records bounded timing at the first cited brief and rejects receipt content fields', () => {
    const plan = createActivationPlanV1(planInput);
    let receipt = createActivationReceiptV1(plan, now);
    for (const operation of plan.operations.slice(0, 6)) {
      const approval =
        operation.approvalKind === undefined
          ? undefined
          : bindActivationApprovalV1(plan, receipt, operation.id, digest('3'));
      const transition = recordActivationOutcomeV1({
        approval,
        now: operation.kind === 'brief.verify' ? later : now,
        operationId: operation.id,
        outcome: success(
          ['imports.preview', 'imports.review', 'brief.verify'].includes(operation.kind) ? 'verified' : 'applied',
        ),
        plan,
        receipt,
      });
      if (transition.status !== 'updated') throw new Error(`Unexpected ${JSON.stringify(transition)}.`);
      receipt = transition.receipt;
    }

    expect(receipt.firstBrief).toEqual({completedAt: later, durationMilliseconds: 60_000});
    expect(() => parseActivationReceiptV1({...receipt, importedText: 'private'})).toThrow();
  });

  it('retains only bounded failure codes and requires fresh approval before retrying a gated step', () => {
    const plan = createActivationPlanV1(planInput);
    let receipt = createActivationReceiptV1(plan, now);
    for (const operation of plan.operations.slice(0, 4)) {
      const transition = recordActivationOutcomeV1({
        now,
        operationId: operation.id,
        outcome: success(operation.expectedOutcome),
        plan,
        receipt,
      });
      if (transition.status !== 'updated') throw new Error(`Unexpected ${JSON.stringify(transition)}.`);
      receipt = transition.receipt;
    }
    const approval = bindActivationApprovalV1(plan, receipt, 'imports-review', digest('4'));
    const failed = recordActivationOutcomeV1({
      approval,
      now,
      operationId: 'imports-review',
      outcome: {failureCode: 'verification-failed', status: 'failed'},
      plan,
      receipt,
    });
    if (failed.status !== 'updated') throw new Error(`Unexpected ${JSON.stringify(failed)}.`);
    expect(previewActivationResumeV1(plan, failed.receipt)).toMatchObject({
      approvalKind: 'imports-reviewed',
      previousFailureCode: 'verification-failed',
      retry: true,
      status: 'awaiting-approval',
    });
    expect(
      recordActivationOutcomeV1({
        approval,
        now: later,
        operationId: 'imports-review',
        outcome: success('verified'),
        plan,
        receipt: failed.receipt,
      }),
    ).toMatchObject({code: 'approval-mismatch', status: 'conflict'});
  });

  it('reports plan drift before offering another operation', () => {
    const plan = createActivationPlanV1(planInput);
    const receipt = createActivationReceiptV1(plan, now);
    const changed = createActivationPlanV1({...planInput, teamShareStateHash: digest('0')});

    expect(previewActivationResumeV1(changed, receipt)).toMatchObject({
      code: 'plan-drift',
      status: 'drifted',
    });
  });

  it('rejects a self-hashed receipt that completes work beyond the dependency frontier', () => {
    const plan = createActivationPlanV1(planInput);
    const receipt = createActivationReceiptV1(plan, now);
    const operations = EffectArray.map(receipt.operations, operation =>
      operation.id === 'surface-secondary'
        ? {
            ...operation,
            attempt: 1,
            outcomeHash: digest('5'),
            ownership: 'preexisting' as const,
            status: 'already-current' as const,
            subsystemReceiptHash: digest('6'),
            undoEligible: false,
          }
        : operation,
    );
    const {revision: _, ...body} = {...receipt, operations, status: 'in-progress' as const};
    const tampered = parseActivationReceiptV1({...body, revision: activationReceiptRevisionV1(body)});
    expect(previewActivationResumeV1(plan, tampered)).toMatchObject({
      code: 'receipt-state-invalid',
      driftedOperationIds: ['surface-secondary'],
      status: 'drifted',
    });
  });

  it('rejects unsafe ownership evidence and non-monotonic receipt time', () => {
    const plan = createActivationPlanV1(planInput);
    const receipt = createActivationReceiptV1(plan, later);
    expect(
      recordActivationOutcomeV1({
        now: later,
        operationId: 'surface-primary',
        outcome: {...success('applied', true), status: 'already-current'},
        plan,
        receipt,
      }),
    ).toMatchObject({code: 'outcome-invalid', status: 'conflict'});
    expect(
      recordActivationOutcomeV1({
        now,
        operationId: 'surface-primary',
        outcome: success('applied'),
        plan,
        receipt,
      }),
    ).toMatchObject({code: 'time-invalid', status: 'conflict'});
  });

  it('plans undo in reverse order for activation-created mutations and requires exact approval', () => {
    const plan = createActivationPlanV1(planInput);
    let receipt = createActivationReceiptV1(plan, now);
    for (const operation of plan.operations.slice(0, 3)) {
      const transition = recordActivationOutcomeV1({
        now,
        operationId: operation.id,
        outcome: success('applied', true),
        plan,
        receipt,
      });
      if (transition.status !== 'updated') throw new Error(`Unexpected ${JSON.stringify(transition)}.`);
      receipt = transition.receipt;
    }

    const undo = planActivationUndoV1(plan, receipt);
    expect(EffectArray.map(undo.operations, operation => operation.operationId)).toEqual([
      'team-share',
      'surface-secondary',
      'surface-primary',
    ]);
    expect(undo.requiresApproval).toBe('undo-apply');
    const approval = bindActivationUndoApprovalV1(undo);
    expect(approval).toMatchObject({
      approved: true,
      receiptRevision: receipt.revision,
      undoPlanHash: undo.undoPlanHash,
    });
    expect(activationUndoApprovalMatchesV1(undo, approval)).toBe(true);
    const tampered = {...undo, operations: undo.operations.slice(1)};
    expect(() => bindActivationUndoApprovalV1(tampered)).toThrow(/hash/u);
    expect(activationUndoApprovalMatchesV1(tampered, approval)).toBe(false);
  });
});

describe('activation receipt lock', () => {
  effectIt.effect('uses an activation-scoped privacy-safe file lock', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-lock-'});
        const plan = createActivationPlanV1(planInput);
        let observed = '';
        yield* withActivationReceiptLock(home, plan.activationId, Effect.succeed('held'), {
          onAcquired: lockPath => Effect.sync(() => (observed = lockPath)),
        });
        expect(observed).toBe(path.join(home, 'activation', 'locks', `${plan.activationId}.lock`));
        expect(yield* fs.exists(observed)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('serializes continue and undo lifecycle mutations for one activation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-lifecycle-lock-'});
        const plan = createActivationPlanV1(planInput);
        const firstEntered = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const first = yield* Effect.forkScoped(
          withActivationLifecycleLock(
            home,
            plan.activationId,
            Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
          ),
        );
        yield* Deferred.await(firstEntered);
        const second = yield* Effect.forkScoped(
          withActivationLifecycleLock(home, plan.activationId, Deferred.succeed(secondEntered, undefined)),
        );
        yield* Effect.sleep(25);
        expect(Option.isNone(yield* Deferred.poll(secondEntered))).toBe(true);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        yield* Deferred.await(secondEntered);
        yield* Fiber.join(second);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});
