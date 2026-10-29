import {Array as EffectArray} from 'effect';
import {Console, Effect} from 'effect';
import {applyMemoryCandidate} from '../mcp/server/recall.js';
import type {ApplyMemoryCandidateInput} from './candidate_apply_contract.js';
import {applyScrubber} from '@threadnote/platform/scrubber';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {loadCandidateReview} from '@threadnote/memory/candidate';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {MemoryOperationError} from './migrations.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface CloseoutRuntime {
  readonly agentContextHome: string;
}

export const runCloseoutPreview = Effect.fn('memory.closeout.preview')(function* (
  config: CloseoutRuntime,
  options: {
    readonly candidateId?: string;
    readonly editedText?: string;
    readonly json: boolean;
    readonly reviewId: string;
    readonly revision?: number;
  },
) {
  const review = yield* loadCandidateReview(config.agentContextHome, options.reviewId);
  const editedPreview = yield* previewEdit(options);
  const delta = yield* Effect.try({
    try: () => projectKnowledgeDeltaV1(review, editedPreview),
    catch: cause =>
      MemoryOperationError.make({message: cause instanceof Error ? cause.message : 'Invalid edited preview.'}),
  });
  if (options.json) {
    yield* Console.log(JSON.stringify(delta, null, 2));
    return;
  }
  const lines = [
    `Knowledge delta for ${delta.reviewId} (revision ${delta.revision})`,
    ...(delta.items.length === 0
      ? ['No candidates.']
      : EffectArray.flatMap(delta.items, item => [
          '',
          `${item.candidateId}: ${item.type} (${item.state})`,
          `  recommendation: ${item.recommendation}`,
          `  operation: ${item.mutationPreview.operation}`,
          ...(item.mutationPreview.replaceUri ? [`  replace: ${item.mutationPreview.replaceUri}`] : []),
          ...(item.mutationPreview.replacementSafety?.warning
            ? [`  WARNING: ${item.mutationPreview.replacementSafety.warning}`]
            : []),
          `  reason: ${item.comparisonReason}`,
          ...EffectArray.map(
            Effect2.pipe(item.mutationPreview.bodyText, EffectString.split('\n')),
            line => `  ${line}`,
          ),
        ])),
  ];
  yield* Console.log(EffectArray.join(lines, '\n'));
});

const previewEdit = Effect.fn('memory.closeout.previewEdit')(function* (options: {
  readonly candidateId?: string;
  readonly editedText?: string;
  readonly revision?: number;
}) {
  if (options.editedText === undefined) {
    if (options.candidateId !== undefined || options.revision !== undefined) {
      return yield* MemoryOperationError.make({
        message: '--candidate-id and --revision require --edited-text for a non-mutating edited preview.',
      });
    }
    return undefined;
  }
  if (options.candidateId === undefined || options.revision === undefined) {
    return yield* MemoryOperationError.make({
      message: '--edited-text requires --candidate-id and the current --revision.',
    });
  }
  const scrub = applyScrubber(options.editedText, {redact: true});
  if (scrub.blocker) {
    return yield* MemoryOperationError.make({
      message: `Refusing to preview edited candidate text: possible ${scrub.blocker}.`,
    });
  }
  return {bodyText: scrub.cleaned, candidateId: options.candidateId, revision: options.revision};
});

export const runCloseoutApply = (config: RuntimeConfig, input: ApplyMemoryCandidateInput) =>
  applyMemoryCandidate(config, input);

export const runCloseoutApplyWithReviewLockHeld = (config: RuntimeConfig, input: ApplyMemoryCandidateInput) =>
  applyMemoryCandidate(config, input, {reviewLockHeld: true});
