import {Array as EffectArray, Option as EffectOption} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  ACTIVATION_MAX_DURATION_MILLISECONDS,
  ACTIVATION_RECEIPT_VERSION,
  activationReceiptRevisionV1,
  activationReceiptStatusV1,
  activationUndoPlanHashV1,
  operationIsComplete,
  parseActivationPlanV1,
  parseActivationReceiptV1,
  parseActivationUndoApprovalV1,
  parseActivationUndoPlanV1,
  type ActivationApprovalV1,
  type ActivationOperationOutcomeV1,
  type ActivationPlanV1,
  type ActivationReceiptOperationV1,
  type ActivationReceiptV1,
  type ActivationUndoApprovalV1,
  type ActivationUndoPlanV1,
} from './contract.js';
import {previewActivationResumeV1} from './planner.js';

export type ActivationTransitionConflictCode =
  | 'approval-mismatch'
  | 'approval-required'
  | 'duration-out-of-range'
  | 'operation-not-ready'
  | 'outcome-invalid'
  | 'outcome-mismatch'
  | 'plan-drift'
  | 'time-invalid';

export type ActivationTransitionResultV1 =
  | {readonly receipt: ActivationReceiptV1; readonly status: 'updated' | 'already-recorded'}
  | {readonly code: ActivationTransitionConflictCode; readonly status: 'conflict'};

export interface RecordActivationOutcomeInputV1 {
  readonly approval?: ActivationApprovalV1;
  readonly now: string;
  readonly operationId: string;
  readonly outcome: ActivationOperationOutcomeV1;
  readonly plan: ActivationPlanV1;
  readonly receipt: ActivationReceiptV1;
}

export function createActivationReceiptV1(suppliedPlan: ActivationPlanV1, startedAt: string): ActivationReceiptV1 {
  const plan = parseActivationPlanV1(suppliedPlan);
  assertIsoInstant(startedAt);
  const body = {
    activationId: plan.activationId,
    generation: 0,
    operations: EffectArray.map(plan.operations, operation => ({
      attempt: 0,
      id: operation.id,
      inputHash: operation.inputHash,
      kind: operation.kind,
      status: 'pending' as const,
    })),
    planHash: plan.planHash,
    startedAt,
    status: 'pending' as const,
    type: 'threadnote-activation-receipt' as const,
    updatedAt: startedAt,
    version: ACTIVATION_RECEIPT_VERSION,
  };
  return parseActivationReceiptV1({...body, revision: activationReceiptRevisionV1(body)});
}

export function bindActivationApprovalV1(
  suppliedPlan: ActivationPlanV1,
  suppliedReceipt: ActivationReceiptV1,
  operationId: string,
  reviewRevisionHash: string,
): ActivationApprovalV1 {
  assertSha256(reviewRevisionHash, 'review revision');
  const plan = parseActivationPlanV1(suppliedPlan);
  const receipt = parseActivationReceiptV1(suppliedReceipt);
  const resume = previewActivationResumeV1(plan, receipt);
  if (resume.status !== 'awaiting-approval' || resume.operationId !== operationId) {
    throw new Error(`Activation operation ${operationId} is not awaiting approval.`);
  }
  if (resume.approvalKind === undefined) throw new Error(`Activation operation ${operationId} has no approval gate.`);
  const body = {
    approved: true as const,
    kind: resume.approvalKind,
    operationId,
    planHash: plan.planHash,
    receiptRevision: receipt.revision,
    reviewRevisionHash,
    type: 'threadnote-activation-approval' as const,
    version: ACTIVATION_RECEIPT_VERSION,
  };
  return {...body, approvalHash: sha256HexSync(canonicalJson(body))};
}

export function recordActivationOutcomeV1(input: RecordActivationOutcomeInputV1): ActivationTransitionResultV1 {
  const plan = parseActivationPlanV1(input.plan);
  const receipt = parseActivationReceiptV1(input.receipt);
  assertIsoInstant(input.now);
  const plannedOperation = EffectOption.getOrUndefined(
    EffectArray.findFirst(plan.operations, operation => operation.id === input.operationId),
  );
  const receiptOperation = EffectOption.getOrUndefined(
    EffectArray.findFirst(receipt.operations, operation => operation.id === input.operationId),
  );
  if (plannedOperation === undefined || receiptOperation === undefined) {
    return {code: 'operation-not-ready', status: 'conflict'};
  }
  const resume = previewActivationResumeV1(plan, receipt);
  if (resume.status === 'drifted') return {code: 'plan-drift', status: 'conflict'};
  if (operationIsComplete(receiptOperation.status)) {
    const replayHash = activationOutcomeHashV1(
      plannedOperation.inputHash,
      input.outcome,
      receiptOperation.approvalHash,
    );
    return receiptOperation.outcomeHash === replayHash
      ? {receipt, status: 'already-recorded'}
      : {code: 'outcome-mismatch', status: 'conflict'};
  }
  const approvalHash = validatedApprovalHash(input.approval, plannedOperation, plan, receipt);
  if (approvalHash === 'required' || approvalHash === 'mismatch') {
    return {code: approvalHash === 'required' ? 'approval-required' : 'approval-mismatch', status: 'conflict'};
  }
  return recordActivationOutcomeWithApprovalHashV1({
    approvalHash,
    now: input.now,
    operationId: input.operationId,
    outcome: input.outcome,
    plan,
    receipt,
  });
}

/** Replays one persisted transition with the same production state machine that created it. */
export function activationReceiptTransitionMatchesV1(
  suppliedPlan: ActivationPlanV1,
  suppliedPrevious: ActivationReceiptV1,
  suppliedNext: ActivationReceiptV1,
  suppliedApproval?: ActivationApprovalV1,
): boolean {
  try {
    const plan = parseActivationPlanV1(suppliedPlan);
    const previous = parseActivationReceiptV1(suppliedPrevious);
    const next = parseActivationReceiptV1(suppliedNext);
    const resume = previewActivationResumeV1(plan, previous);
    if (resume.status === 'completed' || resume.status === 'drifted') return false;
    const operationId = resume.operationId;
    const plannedOperation = EffectOption.getOrUndefined(
      EffectArray.findFirst(plan.operations, operation => operation.id === operationId),
    );
    const nextOperation = EffectOption.getOrUndefined(
      EffectArray.findFirst(next.operations, operation => operation.id === operationId),
    );
    if (plannedOperation === undefined || nextOperation === undefined) return false;
    const outcome = activationOutcomeFromReceiptOperation(nextOperation);
    if (outcome === undefined) return false;
    const replay = recordActivationOutcomeV1({
      approval: suppliedApproval,
      now: next.updatedAt,
      operationId,
      outcome,
      plan,
      receipt: previous,
    });
    return replay.status === 'updated' && canonicalJson(replay.receipt) === canonicalJson(next);
  } catch {
    return false;
  }
}

function recordActivationOutcomeWithApprovalHashV1(input: {
  readonly approvalHash: string | undefined;
  readonly now: string;
  readonly operationId: string;
  readonly outcome: ActivationOperationOutcomeV1;
  readonly plan: ActivationPlanV1;
  readonly receipt: ActivationReceiptV1;
}): ActivationTransitionResultV1 {
  const {approvalHash, plan, receipt} = input;
  const plannedOperation = EffectOption.getOrUndefined(
    EffectArray.findFirst(plan.operations, operation => operation.id === input.operationId),
  );
  const receiptOperation = EffectOption.getOrUndefined(
    EffectArray.findFirst(receipt.operations, operation => operation.id === input.operationId),
  );
  if (
    plannedOperation === undefined ||
    receiptOperation === undefined ||
    operationIsComplete(receiptOperation.status)
  ) {
    return {code: 'operation-not-ready', status: 'conflict'};
  }
  const outcomeHash = activationOutcomeHashV1(plannedOperation.inputHash, input.outcome, approvalHash);
  const resume = previewActivationResumeV1(plan, receipt);
  if (resume.status === 'completed' || resume.status === 'drifted' || resume.operationId !== input.operationId) {
    return {code: 'operation-not-ready', status: 'conflict'};
  }
  if (!outcomeMatchesPlan(plannedOperation.expectedOutcome, input.outcome)) {
    return {code: 'outcome-invalid', status: 'conflict'};
  }
  if (input.outcome.status !== 'failed' && !isSha256(input.outcome.subsystemReceiptHash)) {
    return {code: 'outcome-invalid', status: 'conflict'};
  }
  if (
    input.outcome.status === 'already-current' &&
    (input.outcome.ownership !== 'preexisting' || input.outcome.undoEligible)
  ) {
    return {code: 'outcome-invalid', status: 'conflict'};
  }
  if (
    input.outcome.status !== 'failed' &&
    input.outcome.undoEligible &&
    (!plannedOperation.reversible || input.outcome.ownership !== 'activation-created')
  ) {
    return {code: 'outcome-invalid', status: 'conflict'};
  }
  if (Date.parse(input.now) < Date.parse(receipt.updatedAt)) return {code: 'time-invalid', status: 'conflict'};
  const nextOperation = receiptOperationWithOutcome(receiptOperation, input.outcome, outcomeHash, approvalHash);
  const operations = EffectArray.map(receipt.operations, operation =>
    operation.id === input.operationId ? nextOperation : operation,
  );
  const status = activationReceiptStatusV1(operations);
  const firstBrief = firstBriefTiming(receipt, plannedOperation.kind, input.outcome, input.now);
  if (firstBrief === 'invalid') return {code: 'duration-out-of-range', status: 'conflict'};
  const body = {
    activationId: receipt.activationId,
    ...(status === 'completed' ? {completedAt: input.now} : {}),
    ...(firstBrief === undefined ? {} : {firstBrief}),
    generation: receipt.generation + 1,
    operations,
    planHash: receipt.planHash,
    previousRevision: receipt.revision,
    startedAt: receipt.startedAt,
    status,
    type: 'threadnote-activation-receipt' as const,
    updatedAt: input.now,
    version: ACTIVATION_RECEIPT_VERSION,
  };
  return {
    receipt: parseActivationReceiptV1({...body, revision: activationReceiptRevisionV1(body)}),
    status: 'updated',
  };
}

export function bindActivationUndoApprovalV1(plan: ActivationUndoPlanV1): ActivationUndoApprovalV1 {
  const parsed = parseActivationUndoPlanV1(plan);
  return {
    approved: true,
    receiptRevision: parsed.receiptRevision,
    type: 'threadnote-activation-undo-approval',
    undoPlanHash: parsed.undoPlanHash,
    version: ACTIVATION_RECEIPT_VERSION,
  };
}

export function activationUndoApprovalMatchesV1(
  plan: ActivationUndoPlanV1,
  approval: ActivationUndoApprovalV1 | undefined,
): boolean {
  if (approval === undefined) return false;
  try {
    const parsedPlan = parseActivationUndoPlanV1(plan);
    const parsedApproval = parseActivationUndoApprovalV1(approval);
    return (
      activationUndoPlanHashV1(parsedPlan) === parsedPlan.undoPlanHash &&
      parsedApproval.receiptRevision === parsedPlan.receiptRevision &&
      parsedApproval.undoPlanHash === parsedPlan.undoPlanHash
    );
  } catch {
    return false;
  }
}

function activationOutcomeHashV1(
  inputHash: string,
  outcome: ActivationOperationOutcomeV1,
  approvalHash: string | undefined,
): string {
  return sha256HexSync(canonicalJson({...(approvalHash === undefined ? {} : {approvalHash}), inputHash, outcome}));
}

function validatedApprovalHash(
  approval: ActivationApprovalV1 | undefined,
  operation: ActivationPlanV1['operations'][number],
  plan: ActivationPlanV1,
  receipt: ActivationReceiptV1,
): string | 'required' | 'mismatch' | undefined {
  if (operation.approvalKind === undefined) return approval === undefined ? undefined : 'mismatch';
  if (approval === undefined) return 'required';
  const {approvalHash, ...body} = approval;
  if (
    approval.approved !== true ||
    approval.type !== 'threadnote-activation-approval' ||
    approval.version !== ACTIVATION_RECEIPT_VERSION ||
    approval.kind !== operation.approvalKind ||
    approval.operationId !== operation.id ||
    approval.planHash !== plan.planHash ||
    approval.receiptRevision !== receipt.revision ||
    !isSha256(approval.reviewRevisionHash) ||
    sha256HexSync(canonicalJson(body)) !== approvalHash
  ) {
    return 'mismatch';
  }
  return approvalHash;
}

function outcomeMatchesPlan(
  expected: ActivationPlanV1['operations'][number]['expectedOutcome'],
  outcome: ActivationOperationOutcomeV1,
): boolean {
  if (outcome.status === 'failed') return true;
  if (expected === 'verified') return outcome.status === 'verified';
  return outcome.status === 'applied' || outcome.status === 'already-current';
}

function receiptOperationWithOutcome(
  operation: ActivationReceiptOperationV1,
  outcome: ActivationOperationOutcomeV1,
  outcomeHash: string,
  approvalHash: string | undefined,
): ActivationReceiptOperationV1 {
  const base = {
    ...(approvalHash === undefined ? {} : {approvalHash}),
    attempt: operation.attempt + 1,
    id: operation.id,
    inputHash: operation.inputHash,
    kind: operation.kind,
    outcomeHash,
  };
  return outcome.status === 'failed'
    ? {...base, failureCode: outcome.failureCode, status: 'failed'}
    : {
        ...base,
        ownership: outcome.ownership,
        status: outcome.status,
        subsystemReceiptHash: outcome.subsystemReceiptHash,
        undoEligible: outcome.undoEligible,
      };
}

function activationOutcomeFromReceiptOperation(
  operation: ActivationReceiptOperationV1,
): ActivationOperationOutcomeV1 | undefined {
  if (operation.status === 'failed') {
    return operation.failureCode === undefined ? undefined : {failureCode: operation.failureCode, status: 'failed'};
  }
  if (
    operation.status === 'pending' ||
    operation.ownership === undefined ||
    operation.subsystemReceiptHash === undefined ||
    operation.undoEligible === undefined
  ) {
    return undefined;
  }
  return {
    ownership: operation.ownership,
    status: operation.status,
    subsystemReceiptHash: operation.subsystemReceiptHash,
    undoEligible: operation.undoEligible,
  };
}

function firstBriefTiming(
  receipt: ActivationReceiptV1,
  kind: ActivationPlanV1['operations'][number]['kind'],
  outcome: ActivationOperationOutcomeV1,
  now: string,
): ActivationReceiptV1['firstBrief'] | 'invalid' {
  if (receipt.firstBrief !== undefined) return receipt.firstBrief;
  if (kind !== 'brief.verify' || outcome.status !== 'verified') return undefined;
  const durationMilliseconds = Date.parse(now) - Date.parse(receipt.startedAt);
  if (
    !Number.isSafeInteger(durationMilliseconds) ||
    durationMilliseconds < 0 ||
    durationMilliseconds > ACTIVATION_MAX_DURATION_MILLISECONDS
  ) {
    return 'invalid';
  }
  return {completedAt: now, durationMilliseconds};
}

function assertIsoInstant(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error('Activation time must be an ISO instant.');
  }
}

function assertSha256(value: string, label: string): void {
  if (!isSha256(value)) throw new Error(`Activation ${label} must be a SHA-256 hash.`);
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}
