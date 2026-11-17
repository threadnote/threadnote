import {Array as EffectArray, String as EffectString} from 'effect';
import * as EffectRecord from 'effect/Record';
import {WorkflowAutomationError, type WorkflowNextCommand, type WorkflowRefusalDetail} from './contracts.js';

/** `profile` already names the host surface, so the dev-cycle strictness is a policy. */
export const nativeWorkflowPolicies = ['standard', 'strict'] as const;
export type NativeWorkflowPolicy = (typeof nativeWorkflowPolicies)[number];
export type NativeGateClass = 'intent' | 'integrity' | 'advisory';

/** One registry for every policy refusal; intent is satisfied only by a confirmation or an admission. */
export const nativeGates = {
  'scope.out-of-plan': {class: 'advisory'},
  'source.clean-tree': {class: 'advisory'},
  'source.anchor': {class: 'advisory'},
  'base.binding-change': {class: 'advisory'},
  'graph.citation-currency': {class: 'advisory'},
  'review.required': {class: 'integrity'},
  'review.blocking': {class: 'integrity'},
  'validation.required': {class: 'integrity'},
  'intent.confirmation': {class: 'intent'},
} as const satisfies Record<string, {readonly class: NativeGateClass}>;
export type GateId = keyof typeof nativeGates;
export type NativeWaivableGateId = Exclude<GateId, 'intent.confirmation'>;
export const nativeWaivableGateIds = EffectArray.filter(
  EffectRecord.keys(nativeGates),
  (gate): gate is NativeWaivableGateId => nativeGates[gate].class !== 'intent',
);

export type NativeNextCommand = WorkflowNextCommand;
export type NativeRefusalDetail = WorkflowRefusalDetail;
export type GateDecision =
  | {readonly _tag: 'pass'}
  | {
      readonly _tag: 'warn';
      readonly gate: GateId;
      readonly detail: NativeRefusalDetail;
      readonly waiverId?: string;
    }
  | {
      readonly _tag: 'refuse';
      readonly gate: GateId;
      readonly detail: NativeRefusalDetail;
      readonly next: NativeNextCommand;
    };

/** A run without a recorded policy predates policies and keeps the strict behavior it was created with. */
export const nativeWorkflowPolicyOf = (state: {
  readonly policy?: {readonly mode: NativeWorkflowPolicy};
}): NativeWorkflowPolicy => state.policy?.mode ?? 'strict';

/** Pure. A waived violation warns, an advisory violation warns under standard, anything else refuses. */
export function decideGate(
  policy: NativeWorkflowPolicy,
  gate: GateId,
  violation: NativeRefusalDetail | undefined,
  waiver: {readonly id: string} | undefined,
  next: NativeNextCommand,
): GateDecision {
  if (violation === undefined) return {_tag: 'pass'};
  const gateClass: NativeGateClass = nativeGates[gate].class;
  if (gateClass !== 'intent' && waiver) return {_tag: 'warn', gate, detail: violation, waiverId: waiver.id};
  if (gateClass === 'advisory' && policy === 'standard') return {_tag: 'warn', gate, detail: violation};
  return {_tag: 'refuse', gate, detail: violation, next};
}

const cliFlag = (key: string) => '--' + EffectString.replaceAll('_', '-')(EffectString.camelToSnake(key));
const cliValue = (value: string) => (/[\s"'$`\\]/u.test(value) ? JSON.stringify(value) : value);

export function nativeNextCommand(
  tool: NativeNextCommand['tool'],
  command: string,
  cliCommand: string,
  args: Readonly<Record<string, string>>,
): NativeNextCommand {
  const flags = EffectArray.map(EffectRecord.toEntries(args), ([key, value]) => `${cliFlag(key)} ${cliValue(value)}`);
  return {
    tool,
    command,
    cli: EffectArray.join(['threadnote workflow-automation', cliCommand, ...flags], ' '),
    args,
  };
}

/** The default next step for a mechanical refusal: reread the current task card. */
export const nativeTaskViewNext = (runId: string, callerCwd: string) =>
  nativeNextCommand('workflow_task_view', 'view', 'task-view', {runId, callerCwd});

/** Every refusal names its rule and the next legal command; the type makes `next` mandatory. */
export const nativeRefusal = (
  code: string,
  message: string,
  refusal: {readonly next: NativeNextCommand; readonly gate?: GateId; readonly detail?: NativeRefusalDetail},
) =>
  WorkflowAutomationError.make({
    code,
    message,
    next: refusal.next,
    ...(refusal.gate === undefined ? {} : {gate: refusal.gate}),
    ...(refusal.detail === undefined ? {} : {detail: refusal.detail}),
  });

export const nativeGateRefusal = (
  code: string,
  message: string,
  decision: Extract<GateDecision, {readonly _tag: 'refuse'}>,
) => nativeRefusal(code, message, decision);

/** The next legal command for the action on the current task card. */
export const nativeNextForTaskAction = (action: string, runId: string, callerCwd: string): NativeNextCommand => {
  const scope = {runId, callerCwd};
  switch (action) {
    case 'implement':
      return nativeNextCommand('workflow_task_snapshot', 'record', 'task-action record-snapshot', scope);
    case 'review':
      return nativeNextCommand('workflow_task_record_review', 'record-review', 'task-action record-review', {
        ...scope,
        snapshotRef: '<snapshotRef>',
        report: '<report>',
      });
    case 'validate':
      return nativeNextCommand(
        'workflow_task_record_validation',
        'record-validation',
        'task-action record-validation',
        {...scope, snapshotRef: '<snapshotRef>', validation: '<validation>'},
      );
    case 'deliver':
      return nativeNextCommand('workflow_task_deliver', 'deliver-local', 'task-action deliver-local', {
        ...scope,
        validationRef: '<validationRef>',
      });
    case 'complete':
      return nativeNextCommand('workflow_task_finish', 'finish', 'task-action finish', scope);
    case 'compact-confirm':
      return nativeNextCommand('workflow_task_compact_confirm', 'compact-confirm', 'task-action compact-confirm', {
        ...scope,
        intentHash: '<intentHash>',
        userResponse: '<userResponse>',
      });
    default:
      return nativeTaskViewNext(runId, callerCwd);
  }
};

/** Attach a next command to a refusal that does not name one yet. */
export const withNativeNext = (error: WorkflowAutomationError, next: NativeNextCommand) =>
  error.next !== undefined
    ? error
    : WorkflowAutomationError.make({
        code: error.code,
        message: error.message,
        ...(error.retryable === undefined ? {} : {retryable: error.retryable}),
        ...(error.gate === undefined ? {} : {gate: error.gate}),
        ...(error.detail === undefined ? {} : {detail: error.detail}),
        next,
      });
