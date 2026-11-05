import {Console, Effect, Schema, Stdio, Stream} from 'effect';
import {Command, Flag} from 'effect/cli';
import type {CliRuntimeRunner} from './cli.js';
import {runWorkflowAutomation} from '../workflow_automation/index.js';
import {nativeWorkflowError} from '../workflow_automation/memory.js';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {SystemInfo} from '@threadnote/platform/system';
import {runNativeWatchCollector} from '../workflow_automation/watch.js';
import {runNativeJobWorker} from '../workflow_automation/native_jobs.js';
import {makeNativeTaskActionCommands, makeNativeTaskViewCommand} from './workflow_cli.js';
import {readNativeTaskView} from '../workflow_automation/task.js';
import {runNativeTaskAction} from '../workflow_automation/task_actions.js';

export const nativeWorkflowInputByteLimit = 2_000_000;

/** Stop consuming before buffering an oversized or malformed UTF-8 request. */
export const readNativeWorkflowInput = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const result = yield* stdio.stdin.pipe(
    Stream.runFoldEffect(
      () => ({bytes: 0, text: ''}),
      (previous, chunk) =>
        Effect.try({
          try: () => {
            const bytes = previous.bytes + chunk.byteLength;
            if (bytes > nativeWorkflowInputByteLimit)
              throw WorkflowAutomationError.make({
                code: 'invalid-request',
                message: 'Native workflow requests are limited to 2000000 UTF-8 bytes.',
              });
            return {bytes, text: previous.text + decoder.decode(chunk, {stream: true})};
          },
          catch: error =>
            Schema.is(WorkflowAutomationError)(error)
              ? error
              : WorkflowAutomationError.make({
                  code: 'invalid-request',
                  message: 'Native workflow input must be valid UTF-8.',
                }),
        }),
    ),
  );
  return yield* Effect.try({
    try: () => result.text + decoder.decode(),
    catch: () =>
      WorkflowAutomationError.make({code: 'invalid-request', message: 'Native workflow input must be valid UTF-8.'}),
  });
});

export function makeWorkflowAutomationCommand(withRuntime: CliRuntimeRunner) {
  return Command.make('workflow-automation', {}, () =>
    withRuntime(config =>
      Effect.gen(function* () {
        const input = yield* readNativeWorkflowInput;
        const request = yield* Effect.try({
          try: () => JSON.parse(input) as unknown,
          catch: () =>
            WorkflowAutomationError.make({
              code: 'invalid-json',
              message: 'Provide one native workflow JSON request on stdin.',
            }),
        });
        return yield* runWorkflowAutomation(config, request);
      }).pipe(
        Effect.catchDefect(error => Effect.fail(nativeWorkflowError(error))),
        Effect.catch(error => {
          const failure = nativeWorkflowError(error);
          return Effect.gen(function* () {
            (yield* SystemInfo).setExitCode(1);
            return {
              protocolVersion: 1,
              executorVersion: 1,
              status: 'error',
              code: failure.code,
              message: failure.message,
              ...(failure.retryable === undefined ? {} : {retryable: failure.retryable}),
            };
          });
        }),
        Effect.flatMap(result =>
          Effect.gen(function* () {
            if (typeof result === 'object' && result !== null && 'status' in result && result.status === 'error')
              (yield* SystemInfo).setExitCode(1);
            yield* Console.log(JSON.stringify(result));
          }),
        ),
      ),
    ),
  ).pipe(
    Command.withDescription('Opt-in structured native workflow execution for fresh runs'),
    Command.withSubcommands([
      Command.make('watch-collector', {watchId: Flag.String('watch-id'), token: Flag.String('token')}, options =>
        withRuntime(config => runNativeWatchCollector(config, options.watchId, options.token)),
      ).pipe(Command.withDescription('Internal same-executable native watcher process')),
      Command.make('job-worker', {runId: Flag.String('run-id'), jobId: Flag.String('job-id')}, options =>
        withRuntime(config =>
          runNativeJobWorker(config, options.runId, options.jobId, request =>
            runWorkflowAutomation(config, request).pipe(Effect.mapError(nativeWorkflowError)),
          ).pipe(Effect.asVoid),
        ),
      ).pipe(Command.withDescription('Internal same-executable native job process')),
      makeNativeTaskViewCommand(options =>
        withRuntime(config =>
          readNativeTaskView(config, {
            runId: options.runId,
            callerCwd: options.callerCwd,
            ...(options.role === undefined ? {} : {role: options.role}),
            ...(options.cursor === undefined ? {} : {cursor: options.cursor}),
          }).pipe(
            Effect.flatMap(value => Console.log(JSON.stringify(value))),
            Effect.mapError(nativeWorkflowError),
          ),
        ),
      ),
      makeNativeTaskActionCommands(
        options =>
          withRuntime(config =>
            runNativeTaskAction(config, {
              command: 'work',
              runId: options.runId,
              callerCwd: options.callerCwd,
              packet: options.packet,
            }).pipe(
              Effect.flatMap(value => Console.log(JSON.stringify(value))),
              Effect.mapError(nativeWorkflowError),
            ),
          ),
        options =>
          withRuntime(config =>
            runNativeTaskAction(config, {
              command: 'record-snapshot',
              runId: options.runId,
              callerCwd: options.callerCwd,
              workRef: options.workRef,
            }).pipe(
              Effect.flatMap(value => Console.log(JSON.stringify(value))),
              Effect.mapError(nativeWorkflowError),
            ),
          ),
        options =>
          withRuntime(config =>
            runNativeTaskAction(config, {
              command: 'record-review',
              runId: options.runId,
              callerCwd: options.callerCwd,
              snapshotRef: options.snapshotRef,
              report: options.report,
            }).pipe(
              Effect.flatMap(value => Console.log(JSON.stringify(value))),
              Effect.mapError(nativeWorkflowError),
            ),
          ),
        options =>
          withRuntime(config =>
            runNativeTaskAction(config, {
              command: 'record-validation',
              runId: options.runId,
              callerCwd: options.callerCwd,
              snapshotRef: options.snapshotRef,
              validation: options.validation,
            }).pipe(
              Effect.flatMap(value => Console.log(JSON.stringify(value))),
              Effect.mapError(nativeWorkflowError),
            ),
          ),
        options =>
          withRuntime(config =>
            runNativeTaskAction(config, {
              command: 'deliver-local',
              runId: options.runId,
              callerCwd: options.callerCwd,
              validationRef: options.validationRef,
            }).pipe(
              Effect.flatMap(value => Console.log(JSON.stringify(value))),
              Effect.mapError(nativeWorkflowError),
            ),
          ),
        options =>
          withRuntime(config =>
            runNativeTaskAction(config, {
              command: 'finish',
              runId: options.runId,
              callerCwd: options.callerCwd,
              ...(options.proposal === undefined ? {} : {proposal: options.proposal}),
              ...(options.prepareRef === undefined ? {} : {prepareRef: options.prepareRef}),
              ...(options.finishRef === undefined ? {} : {finishRef: options.finishRef}),
              ...(options.resume ? {resume: true} : {}),
            }).pipe(
              Effect.flatMap(value => Console.log(JSON.stringify(value))),
              Effect.mapError(nativeWorkflowError),
            ),
          ),
      ),
    ]),
  );
}
