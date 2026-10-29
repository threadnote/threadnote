import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {
  ACTIVATION_PLAN_VERSION,
  ACTIVATION_RECEIPT_VERSION,
  activationIdV1,
  activationPlanHashV1,
  activationUndoPlanHashV1,
  canonicalActivationOperationsV1,
  operationIsComplete,
  parseActivationPlanV1,
  parseActivationReceiptV1,
  parseActivationUndoPlanV1,
  type ActivationApprovalKind,
  type ActivationFailureCode,
  type ActivationPlanInputV1,
  type ActivationPlanV1,
  type ActivationReceiptOperationV1,
  type ActivationReceiptV1,
  type ActivationUndoPlanV1,
} from './contract.js';

export type ActivationResumePlanV1 =
  | {
      readonly approvalKind?: ActivationApprovalKind;
      readonly operationId: string;
      readonly planHash: string;
      readonly previousFailureCode?: ActivationFailureCode;
      readonly receiptRevision: string;
      readonly retry: boolean;
      readonly status: 'ready' | 'awaiting-approval';
      readonly version: typeof ACTIVATION_RECEIPT_VERSION;
    }
  | {
      readonly planHash: string;
      readonly receiptRevision: string;
      readonly status: 'completed';
      readonly version: typeof ACTIVATION_RECEIPT_VERSION;
    }
  | {
      readonly code: 'activation-target-drift' | 'plan-drift' | 'receipt-state-invalid';
      readonly driftedOperationIds: readonly string[];
      readonly planHash: string;
      readonly receiptRevision: string;
      readonly status: 'drifted';
      readonly version: typeof ACTIVATION_RECEIPT_VERSION;
    };

export function createActivationPlanV1(input: ActivationPlanInputV1): ActivationPlanV1 {
  if (input.primarySurfaceId === input.secondarySurfaceId) throw new Error('Activation surfaces must be distinct.');
  const activationId = activationIdV1(input);
  const operations = canonicalActivationOperationsV1(input);
  const body = {
    ...input,
    activationId,
    operations,
    type: 'threadnote-activation-plan' as const,
    version: ACTIVATION_PLAN_VERSION,
  };
  return parseActivationPlanV1({...body, planHash: activationPlanHashV1(body)});
}

export function previewActivationResumeV1(
  suppliedPlan: ActivationPlanV1,
  suppliedReceipt: ActivationReceiptV1,
): ActivationResumePlanV1 {
  const plan = parseActivationPlanV1(suppliedPlan);
  const receipt = parseActivationReceiptV1(suppliedReceipt);
  const drift = activationDriftV1(plan, receipt);
  if (drift !== undefined) return drift;
  const next = EffectOption.getOrUndefined(
    EffectArray.findFirst(receipt.operations, operation => !operationIsComplete(operation.status)),
  );
  if (next === undefined) {
    return {
      planHash: plan.planHash,
      receiptRevision: receipt.revision,
      status: 'completed',
      version: ACTIVATION_RECEIPT_VERSION,
    };
  }
  const operation = EffectOption.getOrUndefined(
    EffectArray.findFirst(plan.operations, candidate => candidate.id === next.id),
  )!;
  const common = {
    operationId: operation.id,
    planHash: plan.planHash,
    ...(next.failureCode === undefined ? {} : {previousFailureCode: next.failureCode}),
    receiptRevision: receipt.revision,
    retry: next.status === 'failed',
    version: ACTIVATION_RECEIPT_VERSION,
  };
  return operation.approvalKind === undefined
    ? {...common, status: 'ready'}
    : {...common, approvalKind: operation.approvalKind, status: 'awaiting-approval'};
}

export function planActivationUndoV1(
  suppliedPlan: ActivationPlanV1,
  suppliedReceipt: ActivationReceiptV1,
): ActivationUndoPlanV1 {
  const plan = parseActivationPlanV1(suppliedPlan);
  const receipt = parseActivationReceiptV1(suppliedReceipt);
  if (activationDriftV1(plan, receipt) !== undefined) throw new Error('Cannot plan activation undo after drift.');
  const operations = EffectArray.flatMap(receipt.operations, receiptOperation => {
    const planned = EffectOption.getOrUndefined(
      EffectArray.findFirst(plan.operations, operation => operation.id === receiptOperation.id),
    )!;
    if (
      !operationIsComplete(receiptOperation.status) ||
      !planned.reversible ||
      receiptOperation.ownership !== 'activation-created' ||
      receiptOperation.undoEligible !== true ||
      receiptOperation.outcomeHash === undefined ||
      receiptOperation.subsystemReceiptHash === undefined
    ) {
      return [];
    }
    return [
      {
        inputHash: receiptOperation.inputHash,
        operationId: receiptOperation.id,
        outcomeHash: receiptOperation.outcomeHash,
        subsystemReceiptHash: receiptOperation.subsystemReceiptHash,
      },
    ];
  }).reverse();
  const selected = new Set(EffectArray.map(operations, operation => operation.operationId));
  const body = {
    activationId: plan.activationId,
    operations,
    planHash: plan.planHash,
    receiptRevision: receipt.revision,
    requiresApproval: 'undo-apply' as const,
    retainedOperationIds: EffectArray.map(
      EffectArrayPipe(receipt.operations, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (operation, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues &&
            operationIsComplete(operation.status) &&
            !selected.has(operation.id),
        ),
      ),
      operation => operation.id,
    ),
    type: 'threadnote-activation-undo-plan' as const,
    version: ACTIVATION_RECEIPT_VERSION,
  };
  return parseActivationUndoPlanV1({...body, undoPlanHash: activationUndoPlanHashV1(body)});
}

function activationDriftV1(
  plan: ActivationPlanV1,
  receipt: ActivationReceiptV1,
): Extract<ActivationResumePlanV1, {status: 'drifted'}> | undefined {
  const driftedOperationIds = EffectArray.map(
    EffectArray.filter(plan.operations, (operation, index) => {
      const prior = receipt.operations[index];
      return (
        prior === undefined ||
        prior.id !== operation.id ||
        prior.kind !== operation.kind ||
        prior.inputHash !== operation.inputHash
      );
    }),
    operation => operation.id,
  );
  if (receipt.activationId !== plan.activationId) {
    return {
      code: 'activation-target-drift',
      driftedOperationIds: EffectArray.map(plan.operations, operation => operation.id),
      planHash: plan.planHash,
      receiptRevision: receipt.revision,
      status: 'drifted',
      version: ACTIVATION_RECEIPT_VERSION,
    };
  }
  if (
    receipt.planHash !== plan.planHash ||
    receipt.operations.length !== plan.operations.length ||
    driftedOperationIds.length > 0
  ) {
    return {
      code: 'plan-drift',
      driftedOperationIds,
      planHash: plan.planHash,
      receiptRevision: receipt.revision,
      status: 'drifted',
      version: ACTIVATION_RECEIPT_VERSION,
    };
  }
  const invalidOperationIds = invalidReceiptStateOperationIds(plan, receipt);
  if (invalidOperationIds.length > 0) {
    return {
      code: 'receipt-state-invalid',
      driftedOperationIds: invalidOperationIds,
      planHash: plan.planHash,
      receiptRevision: receipt.revision,
      status: 'drifted',
      version: ACTIVATION_RECEIPT_VERSION,
    };
  }
  return undefined;
}

function invalidReceiptStateOperationIds(plan: ActivationPlanV1, receipt: ActivationReceiptV1): readonly string[] {
  const invalid = new Set<string>();
  let reachedFrontier = false;
  for (const [index, operation] of receipt.operations.entries()) {
    const planned = plan.operations[index];
    const complete = operationIsComplete(operation.status);
    if (reachedFrontier && operation.status !== 'pending') invalid.add(operation.id);
    if (!reachedFrontier && !complete) reachedFrontier = true;
    if (complete && !successStatusMatches(planned.expectedOutcome, operation.status)) invalid.add(operation.id);
    const approvalPresent = operation.approvalHash !== undefined;
    const attempted = operation.status !== 'pending';
    if (attempted && approvalPresent !== (planned.approvalKind !== undefined)) invalid.add(operation.id);
  }
  return [...invalid];
}

function successStatusMatches(
  expected: ActivationPlanV1['operations'][number]['expectedOutcome'],
  observed: ActivationReceiptOperationV1['status'],
): boolean {
  return expected === 'verified' ? observed === 'verified' : observed === 'applied' || observed === 'already-current';
}
