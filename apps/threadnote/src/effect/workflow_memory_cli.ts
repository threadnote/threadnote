import {Console, Effect, Schema} from 'effect';
import {Command} from 'effect/cli';
import type {CliRuntimeRunner} from './cli.js';
import {getInputText} from '../utils.js';
import {runWorkflowMemory} from '../workflow_memory/index.js';
import {WorkflowMemoryError, workflowError} from '../workflow_memory/protocol.js';

export function makeWorkflowMemoryCommand(withRuntime: CliRuntimeRunner) {
  return Command.make('workflow-memory', {}, () =>
    withRuntime(config =>
      Effect.gen(function* () {
        const input = yield* getInputText(undefined, true);
        if (new TextEncoder().encode(input).byteLength > 256_000)
          return yield* workflowError('invalid-request', 'Workflow requests are limited to 256000 UTF-8 bytes.');
        const request = yield* Effect.try({
          try: () => JSON.parse(input) as unknown,
          catch: () => workflowError('invalid-json', 'Provide one workflow JSON request on stdin.'),
        });
        return yield* runWorkflowMemory(config, request);
      }).pipe(
        Effect.catchDefect(cause =>
          Effect.fail(
            workflowError(
              'workflow-operation-failed',
              cause instanceof Error ? cause.message : 'Unexpected workflow failure; no success is implied.',
            ),
          ),
        ),
        Effect.catch(error =>
          Effect.succeed({
            protocolVersion: 1 as const,
            status: 'error' as const,
            code: Schema.is(WorkflowMemoryError)(error) ? error.code : 'workflow-operation-failed',
            message: error instanceof Error ? error.message : 'Workflow operation failed; no success is implied.',
          }),
        ),
        Effect.flatMap(result => Console.log(JSON.stringify(result))),
      ),
    ),
  ).pipe(Command.withDescription('Structured private workflow artifact persistence for development skills'));
}
