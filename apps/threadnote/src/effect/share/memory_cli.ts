import {Effect, Schema} from 'effect';
import {Command, Flag} from 'effect/cli';
import type {
  KnowledgeDeltaGitProposalExportOptionsV1,
  KnowledgeDeltaGitProposalMaterializeOptionsV1,
} from '../../git_proposal/commands.js';
import type {SharePublishOptions} from '../../types.js';
import {
  argument,
  boolean,
  describeFlag,
  integerFlag,
  negatedBoolean,
  optionalString,
  repeatedString,
  requiredString,
} from '../cli/flags.js';

export const publishFlags = {
  dryRun: boolean('dry-run', 'Print actions without running them'),
  message: optionalString('message', 'Commit message override'),
  preview: boolean('preview', 'Print exact shared bytes without writing or committing'),
  push: negatedBoolean('push', 'Skip the push step'),
  redact: boolean('redact', 'Redact soft leaks; credentials still block'),
  team: optionalString('team', 'Team name'),
} as const;

export function makeShareMemoryCommands<E, R>(
  publishHandler: (uri: string, options: SharePublishOptions) => Effect.Effect<void, E, R>,
  proposeHandler: (options: KnowledgeDeltaGitProposalExportOptionsV1) => Effect.Effect<void, E, R>,
  materializeHandler: (options: KnowledgeDeltaGitProposalMaterializeOptionsV1) => Effect.Effect<void, E, R>,
) {
  const sharePublish = Command.make(
    'publish',
    {
      ...publishFlags,
      allowUncitedPendingCodeRefs: boolean(
        'allow-uncited-pending-code-refs',
        'Publish without pending code citations and discard the private pending intent',
      ),
      uri: argument('resource-uri', 'Personal threadnote:// memory URI'),
    },
    ({uri, ...options}) => publishHandler(uri, options),
  ).pipe(Command.withDescription('Move a personal memory into the shared team namespace, commit and push'));

  const sharePropose = Command.make(
    'propose',
    {
      approved: boolean('approved', 'Confirm explicit approval to propose these exact candidates for shared Git'),
      candidateIds: repeatedString('candidate-id', 'Applied candidate ID to include; repeat up to three times', 3),
      output: optionalString('output', 'Explicit local path for the canonical proposal JSON; default prints it'),
      reviewId: requiredString('review-id', 'Candidate review ID from closeout preview'),
      revision: describeFlag(
        integerFlag('revision').pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
        'Exact current candidate review revision',
      ),
      team: optionalString('team', 'Shared Git team; defaults to the configured default team'),
    },
    proposeHandler,
  ).pipe(Command.withDescription('Export an approved Knowledge Delta as a provider-neutral Git proposal'));

  const shareMaterialize = Command.make(
    'materialize',
    {
      apply: boolean('apply', 'Create the local deterministic proposal branch and commit'),
      proposal: requiredString('proposal', 'Local Knowledge Delta Git proposal JSON'),
      team: optionalString('team', 'Shared Git team; defaults to configured default'),
    },
    materializeHandler,
  ).pipe(Command.withDescription('Preview or explicitly materialize a provider-neutral Git proposal locally'));

  return {shareMaterialize, sharePropose, sharePublish};
}
