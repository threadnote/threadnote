import {shellQuote} from '@threadnote/platform/command';
import {Array as EffectArray, Predicate, String as EffectString} from 'effect';
import * as EffectRecord from 'effect/Record';
import {WorkflowAutomationError, type WorkflowNextCommand, type WorkflowRefusalDetail} from './contracts.js';

/** `profile` already names the host surface, so the dev-cycle strictness is a policy. */
export const nativeWorkflowPolicies = ['standard', 'strict'] as const;
export type NativeWorkflowPolicy = (typeof nativeWorkflowPolicies)[number];
export type NativeGateClass = 'integrity' | 'advisory';

/**
 * The gates `decideGate` decides. An advisory gate warns under standard and refuses under strict; an integrity gate
 * refuses on every profile unless an audited waiver covers the exact tree. Intent is not a gate: only a confirmation
 * or an admission satisfies it.
 */
export const nativeGates = {
  'scope.out-of-plan': {class: 'advisory'},
  'review.required': {class: 'integrity'},
  'review.blocking': {class: 'integrity'},
} as const satisfies Record<string, {readonly class: NativeGateClass}>;
export type GateId = keyof typeof nativeGates;
export type NativeWaivableGateId = {
  [Gate in GateId]: (typeof nativeGates)[Gate]['class'] extends 'integrity' ? Gate : never;
}[GateId];
export const nativeWaivableGateIds = EffectArray.filter(
  EffectRecord.keys(nativeGates),
  (gate): gate is NativeWaivableGateId => nativeGates[gate].class === 'integrity',
);

export type GateDecision =
  | {readonly _tag: 'pass'}
  | {
      readonly _tag: 'warn';
      readonly gate: GateId;
      readonly detail: WorkflowRefusalDetail;
      readonly waiverId?: string;
    }
  | {
      readonly _tag: 'refuse';
      readonly gate: GateId;
      readonly detail: WorkflowRefusalDetail;
      readonly next: WorkflowNextCommand;
    };

/** A run without a recorded policy predates policies and keeps the strict behavior it was created with. */
export const nativeWorkflowPolicyOf = (state: {
  readonly policy?: {readonly mode: NativeWorkflowPolicy};
}): NativeWorkflowPolicy => state.policy?.mode ?? 'strict';

/**
 * The policy fields a new run records: the request, else the configured default. A run with neither records none,
 * and `nativeWorkflowPolicyOf` reads it as strict.
 */
export const resolveNativeWorkflowPolicy = (
  config: {readonly workflowPolicyDefault?: NativeWorkflowPolicy},
  requested?: NativeWorkflowPolicy,
): {readonly policy?: {readonly mode: NativeWorkflowPolicy}} => {
  const mode = requested ?? config.workflowPolicyDefault;
  return mode === undefined ? {} : {policy: {mode}};
};

/** Pure. The one rule for every gate: a waived integrity or a standard advisory violation proceeds, others refuse. */
export const nativeGateRefuses = (policy: NativeWorkflowPolicy, gate: GateId, waived = false): boolean =>
  nativeGates[gate].class === 'integrity' ? !waived : policy !== 'standard';

/** Pure. A waived integrity violation warns, an advisory violation warns under standard, anything else refuses. */
export function decideGate(
  policy: NativeWorkflowPolicy,
  gate: GateId,
  violation: WorkflowRefusalDetail | undefined,
  waiver: {readonly id: string} | undefined,
  next: WorkflowNextCommand,
): GateDecision {
  if (violation === undefined) return {_tag: 'pass'};
  if (nativeGateRefuses(policy, gate, waiver !== undefined)) return {_tag: 'refuse', gate, detail: violation, next};
  return {
    _tag: 'warn',
    gate,
    detail: violation,
    ...(nativeGates[gate].class === 'integrity' && waiver ? {waiverId: waiver.id} : {}),
  };
}

const cliFlag = (key: string) => '--' + EffectString.replaceAll('_', '-')(EffectString.camelToSnake(key));
const placeholderKey = Symbol('workflow next placeholder');
type NextPlaceholder = {readonly [placeholderKey]: string};
type NextFlag = string | NextPlaceholder;
type NextTemplate = {
  readonly tool: WorkflowNextCommand['tool'];
  readonly command: string;
  readonly cli: {readonly command: string; readonly flags: Readonly<Record<string, NextFlag>>};
  readonly arguments: Readonly<Record<string, unknown>>;
};
const nextTemplates = new WeakMap<WorkflowNextCommand, NextTemplate>();

export const nativeNextPlaceholder = (name: string): NextPlaceholder => ({[placeholderKey]: name});
const placeholderName = (value: unknown) =>
  Predicate.isObject(value) && placeholderKey in value && typeof value[placeholderKey] === 'string'
    ? value[placeholderKey]
    : undefined;

function renderNativeNext(
  template: NextTemplate,
  values: Readonly<Record<string, string | undefined>> = {},
): WorkflowNextCommand {
  const argument = (name: string) => values[name] ?? `<${name}>`;
  const fill = (value: unknown): unknown => {
    const name = placeholderName(value);
    if (name !== undefined) return argument(name);
    if (EffectArray.isArray(value)) return EffectArray.map(value, fill);
    return Predicate.isObject(value) ? EffectRecord.map(value, fill) : value;
  };
  const flags = EffectArray.map(
    EffectRecord.toEntries(template.cli.flags),
    ([key, value]) =>
      `${cliFlag(key)} ${shellQuote(typeof value === 'string' ? value : argument(value[placeholderKey]))}`,
  );
  const next = {
    tool: template.tool,
    command: template.command,
    cli: EffectArray.join(['threadnote workflow-automation', template.cli.command, ...flags], ' '),
    arguments: EffectRecord.map(template.arguments, fill),
  };
  nextTemplates.set(next, template);
  return next;
}

/** Render MCP and CLI forms from the same arguments. An unknown value appears as a `<placeholder>`. */
export function nativeNextCommand(
  tool: NextTemplate['tool'],
  command: string,
  cli: NextTemplate['cli'],
  mcpArguments: NextTemplate['arguments'],
): WorkflowNextCommand {
  return renderNativeNext({tool, command, cli, arguments: mcpArguments});
}

/** Fill only authored placeholders. Never reinterpret a rendered command or a literal argument. */
export function fillNativeNext(
  next: WorkflowNextCommand,
  values: Readonly<Record<string, string | undefined>>,
): WorkflowNextCommand {
  const template = nextTemplates.get(next);
  return template ? renderNativeNext(template, values) : next;
}

type NativeNextScope = {readonly runId: string; readonly callerCwd: string};
const sameShape = (
  tool: WorkflowNextCommand['tool'],
  command: string,
  cliCommand: string,
  fields: Readonly<Record<string, string>>,
) => nativeNextCommand(tool, command, {command: cliCommand, flags: fields}, fields);

/**
 * A `workflow_task_control` command; MCP nests it under `control`, beside the current task card's `taskRef` for the
 * commands that act on that card.
 */
export const nativeControlNext = (
  scope: NativeNextScope,
  command: string,
  fields: Readonly<Record<string, NextFlag>>,
  cardBound = true,
) => {
  const taskRef: Readonly<Record<string, NextFlag>> = cardBound ? {taskRef: nativeNextPlaceholder('taskRef')} : {};
  return nativeNextCommand(
    'workflow_task_control',
    command,
    {command: 'task-action ' + command, flags: {...scope, ...taskRef, ...fields}},
    {...scope, ...taskRef, control: {command, ...fields}},
  );
};

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
      {
        ...scope,
        capacity: nativeNextPlaceholder('capacity'),
        anchors: nativeNextPlaceholder('anchors'),
        ownership: nativeNextPlaceholder('ownership'),
        checks: nativeNextPlaceholder('checks'),
      },
    ),
  review: (scope: NativeNextScope) =>
    nativeNextCommand(
      'workflow_task_record_review',
      'record-review',
      {
        command: 'task-action record-review',
        flags: {...scope, snapshotRef: nativeNextPlaceholder('snapshotRef'), report: nativeNextPlaceholder('report')},
      },
      {
        ...scope,
        snapshotRef: nativeNextPlaceholder('snapshotRef'),
        mode: nativeNextPlaceholder('mode'),
        selected: nativeNextPlaceholder('selected'),
        lanes: nativeNextPlaceholder('lanes'),
        findings: nativeNextPlaceholder('findings'),
      },
    ),
  validation: (scope: NativeNextScope) =>
    nativeNextCommand(
      'workflow_task_record_validation',
      'record-validation',
      {
        command: 'task-action record-validation',
        flags: {
          ...scope,
          snapshotRef: nativeNextPlaceholder('snapshotRef'),
          validation: nativeNextPlaceholder('validation'),
        },
      },
      {
        ...scope,
        snapshotRef: nativeNextPlaceholder('snapshotRef'),
        checks: nativeNextPlaceholder('checks'),
        acceptance: nativeNextPlaceholder('acceptance'),
      },
    ),
  deliver: (scope: NativeNextScope, delivery: 'local' | 'commit' | 'pr' = 'local') => {
    const fields = {
      validationRef: nativeNextPlaceholder('validationRef'),
      ...(delivery === 'local' ? {} : {commitEvidence: nativeNextPlaceholder('commitEvidence')}),
      ...(delivery === 'pr'
        ? {pr: nativeNextPlaceholder('pr'), userAuthority: nativeNextPlaceholder('userAuthority')}
        : {}),
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
        flags: {
          ...scope,
          intentHash: nativeNextPlaceholder('intentHash'),
          userDecision: nativeNextPlaceholder('userDecision'),
          userResponse: nativeNextPlaceholder('userResponse'),
        },
      },
      {
        ...scope,
        presentedIntentHash: nativeNextPlaceholder('intentHash'),
        userDecision: nativeNextPlaceholder('userDecision'),
        userResponse: nativeNextPlaceholder('userResponse'),
      },
    ),
  reopen: (scope: NativeNextScope, phaseId: string) =>
    nativeControlNext(scope, 'reopen', {phaseId, reason: nativeNextPlaceholder('reason')}),
  waive: (scope: NativeNextScope, gate: NativeWaivableGateId) =>
    nativeControlNext(
      scope,
      'waive',
      {gate, reason: nativeNextPlaceholder('reason'), userAuthority: nativeNextPlaceholder('userAuthority')},
      false,
    ),
  authoringRead: (callerCwd: string, authoringRef: string) =>
    nativeNextCommand(
      'workflow_task_author',
      'read',
      {command: 'task-author --operation read', flags: {callerCwd, authoringRef}},
      {command: 'read', callerCwd, authoringRef},
    ),
} as const;

/** Watch identity fields a watch next command repeats, in CLI order. */
export const nativeWatchIdentityKeys = [
  'runId',
  'callerCwd',
  'validationRef',
  'deliveryRef',
  'phaseId',
  'prUrl',
  'watchRef',
  'snapshotRef',
  'candidateWatchRef',
  'pr',
  'supplementalRef',
] as const;

export type NativeWatchIdentity = Readonly<Partial<Record<(typeof nativeWatchIdentityKeys)[number], string>>>;

/** The watch identity and route proof fields of a caller's input, in CLI order. */
export const nativeWatchIdentityOf = (input: Readonly<Record<string, unknown>>): NativeWatchIdentity => {
  const fields: Partial<Record<(typeof nativeWatchIdentityKeys)[number], string>> = {};
  for (const key of nativeWatchIdentityKeys) {
    const value = input[key];
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
};

/**
 * A `workflow_task_watch_pr` operation over the caller's own watch identity and route proof; `work` restarts at
 * offset zero and `relay` carries no delivery reference.
 */
export const nativeWatchNext = (
  identity: NativeWatchIdentity,
  operation: 'inspect' | 'renew' | 'work' | 'relay' | 'complete',
): WorkflowNextCommand => {
  const fields = nativeWatchIdentityOf(identity);
  return nativeNextCommand(
    'workflow_task_watch_pr',
    operation,
    {command: 'watch-pr', flags: {...fields, operation, ...(operation === 'work' ? {workOffset: '0'} : {})}},
    {...fields, operation, ...(operation === 'work' ? {workOffset: 0} : {})},
  );
};

const retainNextTemplate = (error: WorkflowAutomationError, next: WorkflowNextCommand) => {
  const template = nextTemplates.get(next);
  // Effect Schema copies the public next command when it constructs the error.
  if (template && error.next) nextTemplates.set(error.next, template);
  return error;
};

/** Every refusal names its rule and the next legal command; the type makes `next` mandatory. */
export const nativeRefusal = (
  code: string,
  message: string,
  refusal: {readonly next: WorkflowNextCommand; readonly gate?: GateId; readonly detail?: WorkflowRefusalDetail},
) =>
  retainNextTemplate(
    WorkflowAutomationError.make({
      code,
      message,
      next: refusal.next,
      ...(refusal.gate === undefined ? {} : {gate: refusal.gate}),
      ...(refusal.detail === undefined ? {} : {detail: refusal.detail}),
    }),
    refusal.next,
  );

/** The next legal command for the action on the current task card. */
export const nativeNextForTaskAction = (
  action: string,
  runId: string,
  callerCwd: string,
  delivery: 'local' | 'commit' | 'pr' = 'local',
): WorkflowNextCommand => {
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
      return nativeControlNext(scope, 'resume', {reason: nativeNextPlaceholder('reason')});
    case 'reconcile-plan':
      return nativeControlNext(scope, 'reconcile', {reason: nativeNextPlaceholder('reason')});
    case 'expand-review-budget':
      return nativeControlNext(scope, 'extend-review-budget', {
        additionalReviews: nativeNextPlaceholder('additionalReviews'),
        reason: nativeNextPlaceholder('reason'),
        userAuthority: nativeNextPlaceholder('userAuthority'),
      });
    default:
      return nativeNext.view({runId: runId, callerCwd: callerCwd});
  }
};

/** The refusal with this next command. */
export const withNativeNext = (error: WorkflowAutomationError, next: WorkflowNextCommand) =>
  retainNextTemplate(
    WorkflowAutomationError.make({
      code: error.code,
      message: error.message,
      ...(error.retryable === undefined ? {} : {retryable: error.retryable}),
      ...(error.gate === undefined ? {} : {gate: error.gate}),
      ...(error.detail === undefined ? {} : {detail: error.detail}),
      next,
    }),
    next,
  );
