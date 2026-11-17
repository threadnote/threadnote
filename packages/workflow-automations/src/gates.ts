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

/**
 * One next command in both callable forms: MCP `arguments` shaped by the tool's input schema, and the CLI line. An
 * unknown value appears as a `<placeholder>`.
 */
export function nativeNextCommand(
  tool: NativeNextCommand['tool'],
  command: string,
  cli: {readonly command: string; readonly flags: Readonly<Record<string, string>>},
  mcpArguments: Readonly<Record<string, unknown>>,
): NativeNextCommand {
  const flags = EffectArray.map(
    EffectRecord.toEntries(cli.flags),
    ([key, value]) => `${cliFlag(key)} ${cliValue(value)}`,
  );
  return {
    tool,
    command,
    cli: EffectArray.join(['threadnote workflow-automation', cli.command, ...flags], ' '),
    arguments: mcpArguments,
  };
}

type NativeNextScope = {readonly runId: string; readonly callerCwd: string};
const sameShape = (
  tool: NativeNextCommand['tool'],
  command: string,
  cliCommand: string,
  fields: Readonly<Record<string, string>>,
) => nativeNextCommand(tool, command, {command: cliCommand, flags: fields}, fields);

/** A `workflow_task_control` command; MCP nests it under `control` beside the current task card's `taskRef`. */
export const nativeControlNext = (
  scope: NativeNextScope,
  command: string,
  fields: Readonly<Record<string, string>>,
  cliTaskRef = true,
) =>
  nativeNextCommand(
    'workflow_task_control',
    command,
    {command: 'task-action ' + command, flags: {...scope, ...(cliTaskRef ? {taskRef: '<taskRef>'} : {}), ...fields}},
    {...scope, taskRef: '<taskRef>', control: {command, ...fields}},
  );

/** The next legal commands of the dev-cycle, each callable as given on MCP and on the CLI. */
export const nativeNext = {
  view: (scope: NativeNextScope) => sameShape('workflow_task_view', 'view', 'task-view', scope),
  snapshot: (scope: NativeNextScope) =>
    nativeNextCommand(
      'workflow_task_snapshot',
      'record',
      {command: 'task-action record-snapshot', flags: scope},
      {...scope, snapshot: {command: 'record'}},
    ),
  work: (scope: NativeNextScope) =>
    nativeNextCommand(
      'workflow_task_work',
      'work',
      {command: 'task-action work', flags: scope},
      {...scope, capacity: '<capacity>', anchors: '<anchors>', ownership: '<ownership>', checks: '<checks>'},
    ),
  review: (scope: NativeNextScope) =>
    nativeNextCommand(
      'workflow_task_record_review',
      'record-review',
      {command: 'task-action record-review', flags: {...scope, snapshotRef: '<snapshotRef>', report: '<report>'}},
      {
        ...scope,
        snapshotRef: '<snapshotRef>',
        mode: '<mode>',
        selected: '<selected>',
        lanes: '<lanes>',
        findings: '<findings>',
      },
    ),
  validation: (scope: NativeNextScope) =>
    nativeNextCommand(
      'workflow_task_record_validation',
      'record-validation',
      {
        command: 'task-action record-validation',
        flags: {...scope, snapshotRef: '<snapshotRef>', validation: '<validation>'},
      },
      {...scope, snapshotRef: '<snapshotRef>', checks: '<checks>', acceptance: '<acceptance>'},
    ),
  deliver: (scope: NativeNextScope, delivery: 'local' | 'commit' | 'pr' = 'local') => {
    const fields = {
      validationRef: '<validationRef>',
      ...(delivery === 'local' ? {} : {commitEvidence: '<commitEvidence>'}),
      ...(delivery === 'pr' ? {pr: '<pr>', publication: '<publication>', userAuthority: '<userAuthority>'} : {}),
    };
    return nativeNextCommand(
      'workflow_task_deliver',
      'deliver-' + delivery,
      {command: (delivery === 'pr' ? '' : 'task-action ') + 'deliver-' + delivery, flags: {...scope, ...fields}},
      {...scope, delivery: {command: delivery, ...fields}},
    );
  },
  finish: (scope: NativeNextScope) => sameShape('workflow_task_finish', 'finish', 'task-action finish', scope),
  compactConfirm: (scope: NativeNextScope) =>
    nativeNextCommand(
      'workflow_task_compact_confirm',
      'compact-confirm',
      {
        command: 'task-action compact-confirm',
        flags: {...scope, intentHash: '<intentHash>', userDecision: '<userDecision>', userResponse: '<userResponse>'},
      },
      {...scope, presentedIntentHash: '<intentHash>', userDecision: '<userDecision>', userResponse: '<userResponse>'},
    ),
  waive: (scope: NativeNextScope, gate: NativeWaivableGateId) =>
    nativeControlNext(scope, 'waive', {gate, reason: '<reason>', userAuthority: '<userAuthority>'}, false),
  authoringRead: (callerCwd: string, authoringRef: string) =>
    nativeNextCommand(
      'workflow_task_author',
      'read',
      {command: 'task-author --operation read', flags: {callerCwd, authoringRef}},
      {command: 'read', callerCwd, authoringRef},
    ),
} as const;

/** The default next step for a mechanical refusal: reread the current task card. */
export const nativeTaskViewNext = (runId: string, callerCwd: string) => nativeNext.view({runId, callerCwd});

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
export const nativeNextForTaskAction = (
  action: string,
  runId: string,
  callerCwd: string,
  delivery: 'local' | 'commit' | 'pr' = 'local',
): NativeNextCommand => {
  const scope = {runId, callerCwd};
  switch (action) {
    case 'implement':
      return nativeNext.snapshot(scope);
    case 'review':
      return nativeNext.review(scope);
    case 'validate':
      return nativeNext.validation(scope);
    case 'deliver':
      return nativeNext.deliver(scope, delivery);
    case 'complete':
      return nativeNext.finish(scope);
    case 'compact-confirm':
      return nativeNext.compactConfirm(scope);
    case 'blocked':
      return nativeControlNext(scope, 'resume', {reason: '<reason>'});
    case 'reconcile-plan':
      return nativeControlNext(scope, 'reconcile', {reason: '<reason>'});
    case 'expand-review-budget':
      return nativeControlNext(scope, 'extend-review-budget', {
        additionalReviews: '<additionalReviews>',
        reason: '<reason>',
        userAuthority: '<userAuthority>',
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
