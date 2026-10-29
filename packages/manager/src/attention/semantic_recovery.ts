import {Array as EffectArray} from 'effect';
import type {ContextHealthSemanticContradictionV2} from '@threadnote/context/health_semantic';
import type {ManagerSemanticReviewInputV1} from './contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

type Choice = ManagerSemanticReviewInputV1['choice'];
/** Human intent follows a source URI, never its current left/right position. */
export function retainSemanticChoice(
  choice: Choice | undefined,
  before: ContextHealthSemanticContradictionV2,
  after: ContextHealthSemanticContradictionV2,
): Choice | undefined {
  const samePair =
    EffectArray.join(EffectArray.sort([before.left.recordUri, before.right.recordUri], Effect.Order.String), '\n') ===
    EffectArray.join(EffectArray.sort([after.left.recordUri, after.right.recordUri], Effect.Order.String), '\n');
  if (!samePair || !choice) return undefined;
  if (choice === 'both') return choice;
  const uri = before[choice].recordUri;
  return after.left.recordUri === uri ? 'left' : 'right';
}

export function semanticEvidenceIdentity(evidence: ContextHealthSemanticContradictionV2): string {
  return JSON.stringify([
    evidence.contradictionId,
    ...EffectArray.map([evidence.left, evidence.right], claim => [
      claim.recordUri,
      claim.recordContentFingerprint,
      claim.claimFingerprint,
    ]).sort((left, right) => Effect.pipe(left[0], EffectString.localeCompare(right[0]))),
  ]);
}
