import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  validateTopicMaintenanceDraftBasis,
  type TopicMaintenanceDraftBasisV1,
  type TopicMaintenanceDraftBasis,
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

export interface TopicDraftWireFixture {
  version: number;
  targetHash: string;
  observationRevision: string;
  packetDigest: string;
  decision: {
    observedBehavior?: string;
    behaviorSourceIndices?: number[];
    comparison: string;
    policyAssessment: string;
    unresolvedQuestions: string[];
    removedClaims: string[];
    reviewedSourceIndices?: number[];
    paragraphDispositions: {version: number; entries: ParagraphDecision[]};
  };
}

export function makeTopicDraftWireFixture(
  basis: TopicMaintenanceDraftBasis,
  disposition: 'unchanged' | 'unresolved' = 'unchanged',
): TopicDraftWireFixture {
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

/** Complete trusted packet for controller tests; no graph, model or provider process. */
export function makeTopicDraftControllerPacket() {
  const citations = [0, 1].map(index =>
    createMemoryCodeCitation({
      evidenceRetention: 'capsule-retained',
      extractorSet: 'test',
      fileContentHash: {algorithm: 'sha256', value: '2'.repeat(64)},
      path: `source-${index}.ts`,
      repositoryId: '3'.repeat(64),
      repositoryIdentityKind: 'local',
      sourceCommit: '1'.repeat(40),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${'1'.repeat(40)}`,
      target: {kind: 'file'},
      version: 1,
    }),
  );
  const uri = 'threadnote://user/tester/memories/durable/projects/fixture/topic.md';
  const record = parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        schemaVersion: 8,
        memoryId: 'tn_controller_topic',
        project: 'fixture',
        topic: 'topic',
        sourceAgentClient: 'test',
        timestamp: '2026-10-20T00:00:00.000Z',
        codeCitations: citations,
      },
      'Old first fact.\n\nOld second fact.\n\nProtected requirement.',
    ),
  )!;
  const paragraphs = record.body.split('\n\n').map((text, ordinal) => ({
    ordinal,
    hash: sha256HexSync(text),
    role: ordinal === 2 ? ('normative' as const) : ('descriptive' as const),
    support: 'direct' as const,
    citationIds: citations.map(citation => citation.id),
  }));
  const excerpt = (citation: (typeof citations)[number], provenance: 'current-verified' | 'historical-verified') => {
    const content =
      provenance === 'current-verified' ? 'Current factual implementation.' : 'Historical implementation.';
    return {
      content,
      excerptHash: sha256HexSync(content),
      fileBytesHash: citation.fileContentHash.value,
      startLine: 1,
      endLine: 1,
      provenance,
      supportsCitation: true,
      truncated: false,
      source: {
        extractorSet: citation.extractorSet,
        fileContentHash: citation.fileContentHash.value,
        path: citation.path,
        repositoryId: citation.repositoryId,
        sourceCommit: citation.sourceCommit,
        sourceDirty: citation.sourceDirty,
        sourceSnapshotId: citation.sourceSnapshotId,
      },
    };
  };
  const topicEvidence = {
    version: 1 as const,
    outcome: 'ready' as const,
    targetUri: uri,
    targetHash: sha256HexSync(record.content),
    observationRevision: 'b'.repeat(64),
    coverage: 'declared-only' as const,
    body: record.body,
    paragraphs,
    additionalDependencies: [],
    sources: citations.map(citation => ({
      citationId: citation.id,
      status: 'changed' as const,
      original: citation,
      current: citation,
      oldExcerpt: excerpt(citation, 'historical-verified'),
      newExcerpt: excerpt(citation, 'current-verified'),
    })),
  };
  return {
    record,
    packet: {
      version: 2 as const,
      caseId: 'health-case-' + 'a'.repeat(40),
      project: 'fixture',
      memoryUri: uri,
      memoryId: 'tn_controller_topic',
      evidenceRevision: topicEvidence.observationRevision,
      expectedContentHash: topicEvidence.targetHash,
      disposition: 'needs-decision' as const,
      reason: 'source-changed',
      coverage: 'declared-only' as const,
      topicEvidence,
      evidenceCounts: {declared: 2, unavailable: 0, historicalUnavailable: 0, truncated: 0},
      choices: [],
      allowedOperations: [],
      instructions: 'Review exact evidence.',
    },
  };
}
