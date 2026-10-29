import {Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  type ActivationApprovalV1,
  type ActivationOperationOutcomeV1,
  type ActivationPlanV1,
  type ActivationReceiptV1,
} from './contract.js';
import {createActivationPlanV1, previewActivationResumeV1} from './planner.js';
import {bindActivationApprovalV1, createActivationReceiptV1, recordActivationOutcomeV1} from './receipt.js';
import {
  compareAndSetActivationReceiptV1,
  initializeActivationStateV1,
  readActivationStateV1,
  type ActivationStateV1,
} from './store.js';

export interface ActivationOperationExecutionV1 {
  readonly approval?: ActivationApprovalV1;
  readonly operationId: string;
  readonly plan: ActivationPlanV1;
  readonly receipt: ActivationReceiptV1;
}

export class ActivationOperationExecutionError extends Schema.TaggedError<
  ActivationOperationExecutionError,
  {readonly brand: unique symbol}
>()('ActivationOperationExecutionError', {message: Schema.String}) {}

export class ActivationOperationPause extends Schema.TaggedError<
  ActivationOperationPause,
  {readonly brand: unique symbol}
>()('ActivationOperationPause', {message: Schema.String}) {}

/** Adapter boundary for setup/share/import/brief/candidate/proof subsystems. Raw content stays outside activation state. */
export interface ActivationOperationExecutorV1<R = never> {
  readonly execute: (
    input: ActivationOperationExecutionV1,
  ) => Effect.Effect<ActivationOperationOutcomeV1, ActivationOperationExecutionError | ActivationOperationPause, R>;
}

export type ActivationContinuationV1 =
  | {readonly state: ActivationStateV1; readonly status: 'preview' | 'completed' | 'awaiting-approval' | 'drifted'}
  | {readonly state: ActivationStateV1; readonly status: 'operation-failed'};

export interface ContinueActivationInputV1 {
  readonly apply: boolean;
  readonly approval?: {readonly operationId: string; readonly reviewRevisionHash: string};
  readonly now: () => string;
  readonly plan: ActivationPlanV1;
}

/**
 * Re-validates deterministic inputs on every continuation and crosses at most one approval gate per invocation.
 * Executors receive raw, freshly-observed material via their own closure; activation only persists hashes and receipts.
 */
export const continueActivationV1 = Effect.fn('activation.continue')(function* <R>(
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  input: ContinueActivationInputV1,
  executor: ActivationOperationExecutorV1<R>,
) {
  const suppliedPlan = createActivationPlanV1(input.plan);
  const initialReceipt = createActivationReceiptV1(suppliedPlan, input.now());
  if (!input.apply) {
    const existing = yield* readActivationStateV1(config, suppliedPlan.activationId);
    const state = existing ?? {plan: suppliedPlan, receipt: initialReceipt};
    const resume = previewActivationResumeV1(suppliedPlan, state.receipt);
    return {
      state,
      status: resume.status === 'drifted' ? 'drifted' : resume.status === 'completed' ? 'completed' : 'preview',
    } satisfies ActivationContinuationV1;
  }
  let state = yield* initializeActivationStateV1(config, suppliedPlan, initialReceipt);
  let usedApproval = false;
  for (;;) {
    const resume = previewActivationResumeV1(state.plan, state.receipt);
    if (resume.status === 'completed') return {state, status: 'completed'} satisfies ActivationContinuationV1;
    if (resume.status === 'drifted') return {state, status: 'drifted'} satisfies ActivationContinuationV1;
    let approval: ActivationApprovalV1 | undefined;
    if (resume.status === 'awaiting-approval') {
      if (usedApproval || input.approval?.operationId !== resume.operationId) {
        return {state, status: 'awaiting-approval'} satisfies ActivationContinuationV1;
      }
      approval = bindActivationApprovalV1(
        state.plan,
        state.receipt,
        resume.operationId,
        input.approval.reviewRevisionHash,
      );
      usedApproval = true;
    }
    const outcome = yield* executor.execute({
      approval,
      operationId: resume.operationId,
      plan: state.plan,
      receipt: state.receipt,
    });
    const transition = recordActivationOutcomeV1({
      approval,
      now: input.now(),
      operationId: resume.operationId,
      outcome,
      plan: state.plan,
      receipt: state.receipt,
    });
    if (transition.status === 'conflict') {
      const reread = yield* readActivationStateV1(config, state.plan.activationId);
      if (reread === undefined)
        throw new Error(`Activation ${state.plan.activationId} disappeared during continuation.`);
      state = reread;
      continue;
    }
    const saved = yield* compareAndSetActivationReceiptV1(
      config,
      state.plan.activationId,
      state.receipt.revision,
      transition.receipt,
    );
    if (saved.status === 'conflict') {
      const reread = yield* readActivationStateV1(config, state.plan.activationId);
      if (reread === undefined)
        throw new Error(`Activation ${state.plan.activationId} disappeared during continuation.`);
      state = reread;
      continue;
    }
    state = {plan: state.plan, receipt: saved.receipt};
    if (outcome.status === 'failed') return {state, status: 'operation-failed'} satisfies ActivationContinuationV1;
  }
});

export const activationStatusV1 = readActivationStateV1;
