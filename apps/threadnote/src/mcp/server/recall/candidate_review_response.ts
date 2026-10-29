import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Array as EffectArray, pipe as EffectArrayPipe} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {type CandidateReview} from '@threadnote/memory/candidate';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';

export function candidateReviewResult(review: CandidateReview): CallToolResult {
  const actionable = EffectArrayPipe(review.candidates, __effectFilterValues =>
    EffectArray.filter(
      __effectFilterValues,
      (candidate, __effectFilterIndex) =>
        __effectFilterIndex in __effectFilterValues && candidate.recommendation !== 'no_action',
    ),
  );
  const knowledgeDeltaItems = projectKnowledgeDeltaV1(review).items;
  const warnedItems = EffectArray.filter(knowledgeDeltaItems, item =>
    Boolean(item.mutationPreview.replacementSafety?.warning),
  );
  const replacementWarnings = new Map(
    EffectArray.map(warnedItems, item => [item.candidateId, item.mutationPreview.replacementSafety?.warning]),
  );
  const lines =
    review.candidates.length === 0
      ? ['No additional memory candidates found in this task closeout. No candidate memory was written.']
      : actionable.length === 0
        ? ['No memory update is recommended; every candidate duplicates active memory.']
        : [
            `Review ${review.reviewId} · revision ${review.revision}`,
            'Present these additional recommendations in the current conversation. Do not write these additional candidates until the user decides:',
            ...EffectArray.map(
              review.candidates,
              (candidate, index) =>
                `${index + 1}. [${candidate.recommendation}] ${candidate.kind}/${candidate.topic} · ${candidate.reason}\n` +
                `   candidate: ${candidate.candidateId}` +
                (candidate.targetUri ? `\n   target: ${candidate.targetUri}` : '') +
                (replacementWarnings.get(candidate.candidateId)
                  ? `\n   WARNING: ${replacementWarnings.get(candidate.candidateId)}`
                  : '') +
                `\n${EffectArray.join(
                  EffectArray.map(Effect2.pipe(candidate.proposedText, EffectString.split('\n')), line => `   ${line}`),
                  '\n',
                )}`,
            ),
          ];
  return {
    content: [{type: 'text', text: EffectArray.join(lines, '\n')}],
    structuredContent: candidateReviewStructuredContent(review, {
      candidates: review.candidates,
      noAction: actionable.length === 0,
      reviewId: review.reviewId,
      revision: review.revision,
    }),
  };
}

export function candidateReviewStructuredContent(
  review: CandidateReview,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {...fields, knowledgeDelta: projectKnowledgeDeltaV1(review)};
}
