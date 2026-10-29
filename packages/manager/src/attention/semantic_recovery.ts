import type {ContextHealthSemanticContradictionV2} from '@threadnote/context/health_semantic';
import type {ManagerSemanticReviewInputV1} from './contracts.js';

type Choice = ManagerSemanticReviewInputV1['choice'];
/** Human intent follows a source URI, never its current left/right position. */
export function retainSemanticChoice(
  choice: Choice | undefined,
  before: ContextHealthSemanticContradictionV2,
  after: ContextHealthSemanticContradictionV2,
): Choice | undefined {
  const samePair =
    [before.left.recordUri, before.right.recordUri].sort().join('\n') ===
    [after.left.recordUri, after.right.recordUri].sort().join('\n');
  if (!samePair || !choice) return undefined;
  if (choice === 'both') return choice;
  const uri = before[choice].recordUri;
  return after.left.recordUri === uri ? 'left' : 'right';
}

export function semanticEvidenceIdentity(evidence: ContextHealthSemanticContradictionV2): string {
  return JSON.stringify([
    evidence.contradictionId,
    ...[evidence.left, evidence.right]
      .map(claim => [claim.recordUri, claim.recordContentFingerprint, claim.claimFingerprint])
      .sort((left, right) => left[0].localeCompare(right[0])),
  ]);
}
