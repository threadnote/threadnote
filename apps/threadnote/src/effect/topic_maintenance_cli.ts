import {Effect, FileSystem} from 'effect';
import {Command} from 'effect/cli';
import {SystemInfo} from '@threadnote/platform/system';
import {MAX_TOPIC_MAINTENANCE_BYTES} from '@threadnote/memory/topic-maintenance';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  applyTopicEnrollment,
  inspectTopicEnrollment,
  previewTopicEnrollment,
} from '../memory/maintenance/topic_enrollment.js';
import {MemoryOperationError} from '../memory/migrations.js';
import {boolean, optionalString, requiredString} from './cli/flags.js';
import {writeFinalCliOutput} from './cli/output.js';
import type {CliRuntimeRunner} from './cli.js';

export function makeContextTopicCommand(withRuntimeEffect: CliRuntimeRunner) {
  const target = {
    uri: requiredString('uri', 'Personal durable memory URI or stable memory ID'),
    json: boolean('json', 'Emit JSON'),
  };
  const enrollment = {
    ...target,
    cwd: optionalString('cwd', 'Committed repository supporting this topic; defaults to current directory'),
    input: requiredString('input', 'JSON paragraph support decisions and declared dependency citation IDs'),
  };
  return Command.make('topic').pipe(
    Command.withDescription('Enroll a durable topic for source-driven maintenance'),
    Command.withSubcommands([
      Command.make('inspect', target, options =>
        withRuntimeEffect(config =>
          inspectTopicEnrollment(config, options.uri).pipe(
            Effect.flatMap(result => renderResult(result, options.json)),
          ),
        ),
      ),
      Command.make('preview', enrollment, options =>
        withRuntimeEffect(config =>
          readEnrollmentInput(options).pipe(
            Effect.flatMap(input => previewTopicEnrollment(config, input)),
            Effect.flatMap(result => renderResult(result, options.json)),
          ),
        ),
      ),
      Command.make(
        'enroll',
        {
          ...enrollment,
          approved: boolean('approved', 'Approve the exact previewed paragraph support and dependency coverage'),
          expectedContentHash: requiredString('content-hash', 'Exact target hash from preview'),
          revision: requiredString('revision', 'Exact enrollment revision from preview'),
        },
        options => withRuntimeEffect(config => applyEnrollmentCommand(config, options)),
      ),
    ]),
  );
}

const readEnrollmentInput = Effect.fn('topicMaintenance.readInput')(function* (options: {
  readonly uri: string;
  readonly cwd?: string;
  readonly input: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(options.input);
  if (stat.type !== 'File' || stat.size > MAX_TOPIC_MAINTENANCE_BYTES)
    return yield* MemoryOperationError.make({message: 'Enrollment input must be a regular JSON file within 32 KiB.'});
  const source = yield* fs.readFileString(options.input);
  if (new TextEncoder().encode(source).byteLength > MAX_TOPIC_MAINTENANCE_BYTES)
    return yield* MemoryOperationError.make({message: 'Enrollment input exceeds 32 KiB.'});
  const input = yield* Effect.try({
    try: (): unknown => JSON.parse(source),
    catch: cause => MemoryOperationError.make({message: 'Enrollment input is not valid JSON.', cause}),
  });
  const system = yield* SystemInfo;
  return {uri: options.uri, callerCwd: options.cwd ?? system.currentDirectory(), input};
});

const applyEnrollmentCommand = Effect.fn('topicMaintenance.enrollCommand')(function* (
  config: RuntimeConfig,
  options: Parameters<typeof readEnrollmentInput>[0] & {
    readonly approved: boolean;
    readonly expectedContentHash: string;
    readonly revision: string;
    readonly json: boolean;
  },
) {
  const input = yield* readEnrollmentInput(options);
  const result = yield* applyTopicEnrollment(config, {
    ...input,
    approved: options.approved,
    expectedContentHash: options.expectedContentHash,
    revision: options.revision,
  });
  yield* renderResult(result, options.json);
});

function renderResult(result: {readonly status: string; readonly message?: string}, json: boolean) {
  return writeFinalCliOutput(json ? JSON.stringify(result) : (result.message ?? 'Topic maintenance: ' + result.status));
}
