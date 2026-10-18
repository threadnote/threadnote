import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  validateTopicMaintenanceDraftBasis,
  type TopicMaintenanceDraftBasisV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {topicDraftCurrentSourceHandles, topicDraftGenerationEligible} from '../../src/manager/topic_draft_schema.js';

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
  disposition: 'revalidate' | 'unresolved' = 'revalidate',
) {
  const unresolved = disposition === 'unresolved';
  return {
    version: 1,
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    packetDigest: basis.packetDigest,
    decision: {
      outcome: unresolved ? 'insufficient-evidence' : 'propose-revalidation',
      operations: [] as unknown[],
      reviewedHandles: unresolved ? [] : topicDraftCurrentSourceHandles(basis),
      rationale: unresolved ? 'Manual review.' : 'Checked.',
      unresolvedQuestions: [],
      removedClaims: [],
      paragraphDispositions: {
        version: 1,
        entries: basis.paragraphs.filter(topicDraftGenerationEligible).map(paragraph => ({
          ordinal: paragraph.ordinal,
          disposition: disposition as 'update' | 'revalidate' | 'unresolved',
          sourceIndices: unresolved ? [] : [0],
          rationale: unresolved ? 'Manual review.' : 'Checked.',
        })),
      },
    },
  };
}
