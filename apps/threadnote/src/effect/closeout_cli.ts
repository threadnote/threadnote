import {Console, Effect, Schema} from 'effect';
import {Command, Flag} from 'effect/cli';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runCloseoutApply, runCloseoutPreview} from '../memory/closeout.js';
import {applicationError} from '@threadnote/platform/errors';
import {
  boolean,
  describeFlag,
  integerFlag,
  optional,
  optionalChoice,
  optionalString,
  requiredChoice,
  requiredString,
} from './cli/flags.js';

export function makeCloseoutCommand<E, R>(config: Effect.Effect<RuntimeConfig, E, R>) {
  const closeoutPreview = Command.make(
    'preview',
    {
      candidateId: optionalString('candidate-id', 'Candidate ID whose edited mutation should be previewed'),
      editedText: optionalString('edited-text', 'Edited candidate body to scrub and preview without mutation'),
      json: boolean('json', 'Emit the bounded KnowledgeDeltaV1 as JSON'),
      reviewId: requiredString('review-id', 'Existing candidate review ID'),
      revision: optional(
        describeFlag(
          integerFlag('revision').pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
          'Current review revision required with --edited-text',
        ),
      ),
    },
    options => Effect.flatMap(config, config => runCloseoutPreview(config, options)),
  ).pipe(Command.withDescription('Preview a pending candidate review without changing it'));

  const closeoutApply = Command.make(
    'apply',
    {
      action: requiredChoice('action', ['approve', 'defer', 'reject'], 'Explicit candidate decision'),
      allowDestructiveReplacement: boolean(
        'allow-destructive-replacement',
        'Confirm explicit approval to discard substantial current target content',
      ),
      approved: boolean('approved', 'Confirm explicit user approval before a write'),
      candidateId: requiredString('candidate-id', 'Candidate ID from the review'),
      editedText: optionalString('edited-text', 'Replacement text approved by the user'),
      operation: optionalChoice('operation', ['create', 'replace'], 'Approved memory operation'),
      replaceUri: optionalString('replace-uri', 'Exact reviewed target for replace'),
      reviewId: requiredString('review-id', 'Existing candidate review ID'),
      revision: describeFlag(
        integerFlag('revision').pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
        'Exact review revision from preview',
      ),
    },
    options =>
      Effect.flatMap(config, config =>
        Effect.gen(function* () {
          const result = yield* runCloseoutApply(config, options);
          const text = result.content
            .filter((content): content is {readonly type: 'text'; readonly text: string} => content.type === 'text')
            .map(content => content.text)
            .join('\n');
          if (result.isError === true) {
            return yield* applicationError('apply closeout candidate', new Error(text));
          }
          yield* Console.log(text);
        }),
      ),
  ).pipe(Command.withDescription('Apply one explicit decision to a reviewed closeout candidate'));

  return Command.make('closeout').pipe(
    Command.withDescription('Review and apply session-memory closeout candidates'),
    Command.withSubcommands([closeoutPreview, closeoutApply]),
  );
}
