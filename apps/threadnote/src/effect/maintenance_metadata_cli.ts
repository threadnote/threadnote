import {type Effect} from 'effect';
import {Command} from 'effect/cli';
import type {
  runMaintenanceMetadataApply,
  runMaintenanceMetadataPreview,
} from '../memory/maintenance/metadata_commands.js';
import {boolean, optionalString, requiredString} from './cli/flags.js';

const clearFlag = boolean;

/** Factory only: src/effect/cli.ts deliberately owns the top-level context registration. */
export function makeContextMetadataCommand<E, R>(
  previewHandler: (options: Parameters<typeof runMaintenanceMetadataPreview>[1]) => Effect.Effect<void, E, R>,
  applyHandler: (options: Parameters<typeof runMaintenanceMetadataApply>[1]) => Effect.Effect<void, E, R>,
) {
  const base = {
    clearOwner: clearFlag('clear-owner', 'Explicitly clear owner'),
    clearReviewAfter: clearFlag('clear-review-after', 'Explicitly clear review_after'),
    clearValidTo: clearFlag('clear-valid-to', 'Explicitly clear valid_to'),
    memoryId: optionalString('memory-id', 'Stable tn_ memory ID; provide exactly one of this or --uri'),
    owner: optionalString('owner', 'Opaque owner label'),
    reviewAfter: optionalString('review-after', 'ISO calendar date or canonical ISO instant'),
    uri: optionalString('uri', 'Canonical memory URI; provide exactly one of this or --memory-id'),
    validTo: optionalString('valid-to', 'Canonical ISO instant'),
  };
  const preview = Command.make('preview', {...base, json: boolean('json', 'Emit JSON')}, options =>
    previewHandler({...options, ...clearPatchOptions(options)}),
  ).pipe(Command.withDescription('Preview a CAS-bound personal durable-memory metadata update'));
  const apply = Command.make(
    'apply',
    {
      ...base,
      approved: boolean('approved', 'Confirm explicit approval'),
      expectedContentHash: requiredString('content-hash', 'Exact target hash from preview'),
      json: boolean('json', 'Emit JSON'),
      proposalId: requiredString('proposal-id', 'Exact proposal ID from preview'),
      revision: requiredString('revision', 'Exact proposal revision from preview'),
    },
    options => applyHandler({...options, ...clearPatchOptions(options)}),
  ).pipe(Command.withDescription('Apply one approved CAS-bound metadata update'));
  return Command.make('metadata').pipe(
    Command.withDescription('Preview or apply durable memory maintenance metadata'),
    Command.withSubcommands([preview, apply]),
  );
}

function clearPatchOptions(options: {
  readonly clearOwner: boolean;
  readonly clearReviewAfter: boolean;
  readonly clearValidTo: boolean;
  readonly owner?: string;
  readonly reviewAfter?: string;
  readonly validTo?: string;
}) {
  if (options.clearOwner && options.owner !== undefined) throw new Error('Cannot combine --owner and --clear-owner.');
  if (options.clearReviewAfter && options.reviewAfter !== undefined)
    throw new Error('Cannot combine --review-after and --clear-review-after.');
  if (options.clearValidTo && options.validTo !== undefined)
    throw new Error('Cannot combine --valid-to and --clear-valid-to.');
  return {
    ...(options.clearOwner ? {owner: null} : {}),
    ...(options.clearReviewAfter ? {reviewAfter: null} : {}),
    ...(options.clearValidTo ? {validTo: null} : {}),
  };
}
