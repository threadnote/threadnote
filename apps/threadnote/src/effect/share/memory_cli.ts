import {Effect, Option, Schema} from 'effect';
import {Command, Flag} from 'effect/cli';
import type {
  KnowledgeDeltaGitProposalExportOptionsV1,
  KnowledgeDeltaGitProposalMaterializeOptionsV1,
} from '../../git_proposal/commands.js';
import type {SharePublishOptions} from '../../types.js';
import type {SharedTopicProposalOptions} from '../../git_proposal/topic_maintenance_commands.js';
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

export function makeShareMemoryCommands<PE, PR, GE, GR, ME, MR, TE, TR>(
  publishHandler: (uri: string, options: SharePublishOptions) => Effect.Effect<void, PE, PR>,
  proposeHandler: (options: KnowledgeDeltaGitProposalExportOptionsV1) => Effect.Effect<void, GE, GR>,
  materializeHandler: (options: KnowledgeDeltaGitProposalMaterializeOptionsV1) => Effect.Effect<void, ME, MR>,
  topicProposeHandler: (options: SharedTopicProposalOptions) => Effect.Effect<void, TE, TR>,
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
      approvalDigest: optionalString('approval-digest', 'For topic maintenance, echo the exact preview proposalHash'),
      sourceCwd: optionalString('source-cwd', 'Absolute cited source checkout for topic maintenance verification'),
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
      approvalDigest: optionalString('approval-digest', 'For topic maintenance, approve the exact proposalHash'),
      sourceCwd: optionalString('source-cwd', 'Absolute cited source checkout for topic maintenance verification'),
      proposal: requiredString('proposal', 'Local Knowledge Delta Git proposal JSON'),
      team: optionalString('team', 'Shared Git team; defaults to configured default'),
    },
    materializeHandler,
  ).pipe(Command.withDescription('Preview or explicitly materialize a provider-neutral Git proposal locally'));

  const shareTopicPropose = Command.make(
    'topic-propose',
    {
      uri: requiredString('uri', 'Exact existing enrolled shared topic URI'),
      sourceCwd: requiredString('source-cwd', 'Absolute cited source checkout'),
      draftFile: optionalString('draft-file', 'Canonical draft JSON; omit to inspect the fresh packet and basis'),
      reviewId: optionalString('review-id', 'Existing private review ID when editing a pending proposal'),
      revision: integerFlag('revision').pipe(Flag.optional),
      team: optionalString('team', 'Shared Git team'),
    },
    options => topicProposeHandler({...options, revision: Option.getOrUndefined(options.revision)}),
  ).pipe(
    Command.withDescription('Prepare a manual shared-topic proposal in the private review store; zero model calls'),
  );

  return {shareMaterialize, sharePropose, sharePublish, shareTopicPropose};
}
