import {Console, Effect, FileSystem, Path, Record} from 'effect';
import {Command} from 'effect/cli';
import {integerFlag, optional, optionalChoice, optionalString, requiredChoice, requiredString} from './cli/flags.js';
import type {CliRuntimeRunner} from './cli.js';
import {runNativeTaskAuthoring} from '../workflow_automation/task_authoring.js';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';

export const makeNativeTaskAuthoringCommand = (withRuntime: CliRuntimeRunner) =>
  Command.make(
    'task-author',
    {
      command: requiredChoice(
        'operation',
        ['start', 'read', 'save', 'decide', 'admit', 'job'],
        'Business authoring action',
      ),
      callerCwd: requiredString('caller-cwd', 'Absolute original checkout'),
      featureName: optionalString('feature-name', 'Stable feature name for start'),
      kind: optionalChoice('kind', ['spec', 'plan'], 'Document kind for start'),
      contentFile: optionalString('content-file', 'Business JSON artifact; omit native metadata'),
      saveMode: optionalChoice('save-mode', ['background'], 'Submit an exact save to the durable native job worker'),
      installationTarget: optionalString('installation-target', 'Installed target selector for start'),
      authoringRef: optionalString('authoring-ref', 'Opaque current authoring continuation'),
      jobRef: optionalString('job-ref', 'Opaque accepted semantic authoring job continuation'),
      jobOperation: optionalChoice('job-operation', ['status', 'result', 'cancel', 'resume'], 'Operate on one job'),
      specRef: optionalString('spec-ref', 'Opaque approved specification reference for plan start'),
      detail: optionalChoice('detail', ['summary', 'document'], 'Read full authored content on request'),
      userDecision: optionalChoice('decision', ['approve', 'reject', 'defer'], 'Actual human decision'),
      userResponse: optionalString('response', 'Actual response to the complete displayed document'),
      delivery: optionalChoice(
        'delivery',
        ['local', 'commit', 'pr'],
        'Approved plan delivery mode: local, commit, or pr',
      ),
      reviewOutcome: optionalChoice(
        'review-outcome',
        ['accepted', 'changes-requested'],
        'Actual independent document review',
      ),
      blockingIssueCount: optional(integerFlag('blocking-issues')),
      bindingsFile: optionalString('bindings-file', 'Business phase branch/base choices for admission'),
    },
    options =>
      withRuntime(config =>
        Effect.gen(function* () {
          const {reviewOutcome, blockingIssueCount, bindingsFile, jobOperation, ...fields} = options;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const bindings = bindingsFile
            ? yield* fs
                .readFileString(
                  path.isAbsolute(bindingsFile) ? bindingsFile : path.join(options.callerCwd, bindingsFile),
                )
                .pipe(
                  Effect.flatMap(value =>
                    Effect.try({
                      try: () => JSON.parse(value) as unknown,
                      catch: () =>
                        WorkflowAutomationError.make({
                          code: 'invalid-request',
                          message: 'Provide business branch/base choices as JSON.',
                        }),
                    }),
                  ),
                )
            : undefined;
          const result = yield* runNativeTaskAuthoring(config, {
            ...Record.filter(fields, value => value !== undefined),
            ...(jobOperation === undefined ? {} : {operation: jobOperation}),
            ...(reviewOutcome === undefined ? {} : {review: {outcome: reviewOutcome, blockingIssueCount}}),
            ...(bindings === undefined ? {} : {bindings}),
          });
          yield* Console.log(JSON.stringify(result));
        }),
      ),
  ).pipe(
    Command.withDescription(
      'Author, read, approve and admit standard business documents through current task continuations',
    ),
  );
