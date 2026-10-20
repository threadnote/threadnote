import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  validateTopicMaintenanceDraftBasis,
  type TopicMaintenanceDraftBasisV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {
  topicDraftCurrentSourceHandles,
  topicDraftGenerationEligible,
  topicDraftPolicyScope,
} from '../../src/manager/topic_draft_schema.js';

interface ParagraphDecision {
  ordinal: number;
  disposition: 'update' | 'unchanged' | 'unresolved';
  sourceIndices: number[];
  rationale: string;
  text?: string;
}

export function makeTopicDraftWireBasis(
  count: number,
  options: {sourceCount?: number; protectedOrdinal?: number; firstParagraph?: string} = {},
): TopicMaintenanceDraftBasisV1 {
  const sourceCount = options.sourceCount ?? 3;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 64 ||
    !Number.isInteger(sourceCount) ||
    sourceCount < 1 ||
    sourceCount > 8
  )
    throw new Error('Invalid topic wire fixture size.');
  const ids = Array.from({length: sourceCount}, (_, index) => 'tncc_' + index.toString(16).padStart(40, '0'));
  const paragraphs = Array.from({length: count}, (_, ordinal) =>
    ordinal === 0 && options.firstParagraph ? options.firstParagraph : `Claim ${ordinal}.`,
  );
  return validateTopicMaintenanceDraftBasis({
    version: 1,
    targetUri: 'threadnote://user/tester/memories/durable/topic.md',
    targetHash: 'a'.repeat(64),
    observationRevision: 'b'.repeat(64),
    packetDigest: 'c'.repeat(64),
    body: paragraphs.join('\n\n'),
    paragraphs: paragraphs.map((text, ordinal) => ({
      ordinal,
      hash: sha256HexSync(text),
      role: ordinal === options.protectedOrdinal ? 'normative' : 'descriptive',
      support: 'direct',
      citationIds: ids,
    })),
    additionalDependencies: [],
    handles: ids.flatMap(id => [
      {id: `historical:${id}`, citationId: id, variant: 'historical'},
      {id: `current:${id}`, citationId: id, variant: 'current'},
    ]),
  });
}

export function makeTopicDraftWireFixture(
  basis: TopicMaintenanceDraftBasisV1,
  disposition: 'unchanged' | 'unresolved' = 'unchanged',
) {
  const unresolved = disposition === 'unresolved';
  const eligible = basis.paragraphs.filter(topicDraftGenerationEligible);
  return {
    version: 3,
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    packetDigest: basis.packetDigest,
    decision: {
      ...(!eligible.length && !unresolved
        ? {comparison: 'Checked source currency only; policy compliance not assessed.'}
        : {
            observedBehavior: unresolved ? 'Behavior could not be established.' : 'Current behavior checked.',
            behaviorSourceIndices: unresolved ? [] : topicDraftPolicyScope(basis).behaviorSourceIndices.slice(0, 1),
            comparison: unresolved
              ? 'Manual comparison required.'
              : topicDraftPolicyScope(basis).normativeOrdinals.length
                ? 'No conflict observed in supplied evidence.'
                : 'No protected normative requirement supplied.',
          }),
      policyAssessment: unresolved ? 'undetermined' : eligible.length ? 'no-conflict-observed' : 'source-review',
      unresolvedQuestions: unresolved ? ['What current behavior applies?'] : [],
      removedClaims: [],
      ...(!eligible.length && !unresolved
        ? {reviewedSourceIndices: topicDraftCurrentSourceHandles(basis).map((_, index) => index)}
        : {}),
      paragraphDispositions: {
        version: 1,
        entries: eligible.map<ParagraphDecision>(paragraph => ({
          ordinal: paragraph.ordinal,
          disposition,
          sourceIndices: unresolved ? [] : [0],
          rationale: unresolved ? 'Manual review.' : 'Checked.',
        })),
      },
    },
  };
}
