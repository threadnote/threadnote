import {Array as EffectArray, Option as EffectOption, Predicate, Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
import {nativeNextCommand} from '@threadnote/workflow-automations/gates';
import {NativeBranchBindingsSchema, NativeTaskStartRequestSchema} from '@threadnote/workflow-automations/task';

export const decodeStoredBindings = (value: unknown) =>
  Schema.decodeUnknownOption(NativeBranchBindingsSchema)(value).pipe(EffectOption.getOrUndefined);

/** A compact start that received delivery or bindings returns a confirm hint with them already filled in. */
export const withConfirmArguments = <A extends object>(
  started: A,
  request: {readonly delivery?: string | undefined; readonly bindings?: object | undefined},
  runId: string,
  callerCwd: string,
) => {
  const intentHash = 'intentHash' in started ? started.intentHash : undefined;
  if ((request.delivery === undefined && request.bindings === undefined) || typeof intentHash !== 'string')
    return started;
  const scope = {runId, callerCwd};
  const chosen: Record<string, unknown> = {
    ...(request.delivery === undefined ? {} : {delivery: request.delivery}),
    ...(request.bindings === undefined ? {} : {bindings: request.bindings}),
  };
  const cliChosen: Record<string, string> = EffectRecord.map(chosen, value =>
    typeof value === 'string' ? value : JSON.stringify(value),
  );
  const next = nativeNextCommand(
    'workflow_task_compact_confirm',
    'compact-confirm',
    {
      command: 'task-action compact-confirm',
      flags: {
        ...scope,
        intentHash,
        ...cliChosen,
        userDecision: '<userDecision>',
        userResponse: '<userResponse>',
      },
    },
    {
      ...scope,
      presentedIntentHash: intentHash,
      ...chosen,
      userDecision: '<userDecision>',
      userResponse: '<userResponse>',
    },
  );
  // The consent step stays in `instruction`: the command is pre-filled but still needs the user's real response.
  return {
    ...started,
    instruction:
      'next' in started && typeof started.next === 'string' ? started.next : 'Collect a real user response first.',
    next,
  };
};
/** Names the fields that do not belong to, or are missing from, the chosen start shape. */
export const nativeTaskStartShapeMessage = (input: unknown) => {
  const fields = Predicate.isObject(input) ? EffectRecord.keys(input) : [];
  const shared = EffectArray.contains(fields, 'sharedPlanRef');
  const [compact, sharedPlan] = NativeTaskStartRequestSchema.members;
  const shapeFields: Readonly<Record<string, Schema.Top>> = shared ? sharedPlan.fields : compact.fields;
  const label = shared ? 'A shared-plan' : 'A compact';
  const foreign = EffectArray.filter(fields, field => !(field in shapeFields));
  if (foreign.length) {
    const confirmTime = !shared && EffectArray.contains(foreign, 'baseBranch');
    return `${label} start does not accept ${EffectArray.join(foreign, ', ')}.${confirmTime ? ' Choose baseBranch at compact-confirm, or supply bindings.' : ''}`;
  }
  const missing = EffectArray.filter(
    EffectRecord.keys(shapeFields),
    field => !shapeFields[field].ast.context?.isOptional && !EffectArray.contains(fields, field),
  );
  if (!missing.length) {
    const record = Predicate.isObject(input) ? input : {};
    if ('delivery' in record && !Schema.is(Schema.Literals(['local', 'commit', 'pr']))(record.delivery))
      return 'delivery must be local, commit or pr.';
    if ('bindings' in record && !Schema.is(NativeBranchBindingsSchema)(record.bindings))
      return 'bindings must map phase IDs to {branch, baseBranch}.';
  }
  if (!missing.length)
    return 'Provide a feature name, absolute checkout path, bounded compact intent, and an optional installed target or task reference.';
  const resume = !shared && EffectArray.contains(fields, 'taskRef');
  return `${label} ${resume ? 'resume' : 'start'} requires ${EffectArray.join(missing, ', ')}.${resume ? ' A resume repeats the original featureName and intent with the taskRef.' : ''}`;
};
