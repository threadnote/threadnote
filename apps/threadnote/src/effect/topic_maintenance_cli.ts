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
import {
  applyTopicDependencyExpansion,
  inspectTopicDependencyExpansion,
  previewTopicDependencyExpansion,
  restartTopicDependencyExpansion,
} from '../memory/maintenance/topic_expansion.js';

export function makeContextTopicCommand(withRuntimeEffect: CliRuntimeRunner) {
  const target = {
    uri: requiredString('uri', 'Personal durable memory URI or stable memory ID'),
    json: boolean('json', 'Emit JSON'),
  };
  const enrollment = {
    ...target,
    cwd: optionalString('cwd', 'Committed repository supporting this topic; defaults to current directory'),
    project: optionalString('project', 'Configured graph project name or root; otherwise infer from cwd'),
    input: requiredString('input', 'JSON paragraph support decisions and declared dependency citation IDs'),
  };
  return Command.make('topic').pipe(
    Command.withDescription('Enroll a durable topic for source-driven maintenance'),
    Command.withSubcommands([
      makeDependencyExpansionCommand(withRuntimeEffect),
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

function makeDependencyExpansionCommand(withRuntimeEffect: CliRuntimeRunner) {
  const target = {
    uri: requiredString('uri', 'Private enrolled code topic'),
    cwd: requiredString('cwd', 'Clean committed repository checkout'),
    project: requiredString('project', 'Exact configured graph project'),
    json: boolean('json', 'Emit the complete typed result'),
  };
  return Command.make('dependencies').pipe(
    Command.withDescription('Review selected one-hop or configuration dependencies without changing topic prose'),
    Command.withSubcommands([
      Command.make(
        'inspect',
        {...target, input: optionalString('input', 'Optional JSON with explicitly selected seeds and traversal scope')},
        options =>
          withRuntimeEffect(config =>
            Effect.gen(function* () {
              const input = options.input ? yield* readExpansionJson(options.input, 32 * 1024) : undefined;
              const result = yield* inspectTopicDependencyExpansion(config, {
                uri: options.uri,
                callerCwd: options.cwd,
                project: options.project,
                input,
              });
              yield* writeFinalCliOutput(
                options.json
                  ? JSON.stringify(result)
                  : [
                      result.warning,
                      ...result.seeds.map(seed => `Seed: ${seed.label} (${seed.path})`),
                      ...(result.choices?.eligible.map(node => `Available dependency: ${node.path}`) ?? []),
                      ...(result.choices?.omissions.map(item => `Omitted: ${item.kind} (${item.id})`) ?? []),
                    ].join('\n'),
              );
            }),
          ),
      ),
      Command.make(
        'preview',
        {...target, input: requiredString('input', 'JSON with exact selected endpoints/configuration files')},
        options =>
          withRuntimeEffect(config =>
            Effect.gen(function* () {
              const input = yield* readExpansionJson(options.input, 32 * 1024);
              const result = yield* previewTopicDependencyExpansion(config, {
                uri: options.uri,
                callerCwd: options.cwd,
                input,
              });
              if (result.preview.input.project !== options.project)
                return yield* MemoryOperationError.make({message: 'The input project differs from --project.'});
              yield* writeFinalCliOutput(
                options.json
                  ? JSON.stringify(result)
                  : [
                      'Only the selected dependencies will be added. Topic prose and paragraph authority stay unchanged.',
                      ...result.preview.additions.map(item => `${item.kind}: ${item.citation.path}`),
                      ...result.preview.omissions.map(item => `Omitted: ${item.kind}`),
                      'Full proposed memory:',
                      result.preview.content,
                      `Revision: ${result.preview.revision}`,
                      `Approval digest: ${result.preview.approvalDigest}`,
                    ].join('\n\n'),
              );
            }),
          ),
      ),
      ...(['apply', 'restart'] as const).map(action =>
        Command.make(
          action,
          {
            preview: requiredString('preview', 'Complete preview JSON saved from dependencies preview --json'),
            revision: requiredString('revision', 'Exact preview revision'),
            digest: requiredString('digest', 'Exact preview approval digest'),
            approved: boolean(
              'approved',
              action === 'restart'
                ? 'Explicitly supersede this expired unwritten approval and request a fresh preview'
                : 'Approve the selected additions and full unchanged topic preview',
            ),
            json: boolean('json', 'Emit JSON'),
          },
          options =>
            withRuntimeEffect(config =>
              Effect.gen(function* () {
                const raw = yield* readExpansionJson(options.preview, 256 * 1024);
                const preview = typeof raw === 'object' && raw !== null && 'preview' in raw ? raw.preview : raw;
                const result = yield* (
                  action === 'restart' ? restartTopicDependencyExpansion : applyTopicDependencyExpansion
                )(config, {
                  preview,
                  revision: options.revision,
                  approvalDigest: options.digest,
                  approved: options.approved,
                });
                yield* writeFinalCliOutput(
                  options.json
                    ? JSON.stringify(result)
                    : 'preview' in result
                      ? [
                          'Review the fresh full preview and approve it separately.',
                          result.preview.content,
                          `Revision: ${result.preview.revision}`,
                          `Approval digest: ${result.preview.approvalDigest}`,
                        ].join('\n\n')
                      : `${result.status}: ${result.targetUri}`,
                );
              }),
            ),
        ),
      ),
    ]),
  );
}

const readExpansionJson = Effect.fn('topicMaintenance.readExpansionJson')(function* (file: string, limit: number) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(file);
  if (stat.type !== 'File' || stat.size > limit)
    return yield* MemoryOperationError.make({message: 'Expansion input must be a bounded regular JSON file.'});
  const source = yield* fs.readFileString(file);
  if (new TextEncoder().encode(source).byteLength > limit)
    return yield* MemoryOperationError.make({message: 'Expansion input is too large.'});
  return yield* Effect.try({
    try: (): unknown => JSON.parse(source),
    catch: cause => MemoryOperationError.make({message: 'Expansion input is not valid JSON.', cause}),
  });
});

const readEnrollmentInput = Effect.fn('topicMaintenance.readInput')(function* (options: {
  readonly uri: string;
  readonly cwd?: string;
  readonly project?: string;
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
  return {uri: options.uri, callerCwd: options.cwd ?? system.currentDirectory(), project: options.project, input};
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
