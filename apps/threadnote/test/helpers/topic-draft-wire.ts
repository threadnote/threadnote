import {Array as EffectArray} from 'effect';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  validateTopicMaintenanceDraftBasis,
  type TopicMaintenanceDraftBasisV1,
  type AutomaticMaintenanceDraftBasisV3,
  type AutomaticMaintenanceDraftV2,
  type LegacyTopicMaintenanceDraftBasis as TopicMaintenanceDraftBasis,
} from '@threadnote/memory/topic-maintenance-draft';
import {
  topicDraftCurrentEvidence,
  topicDraftCurrentSourceHandles,
  topicDraftGenerationEligible,
  topicDraftPolicyScope,
} from '../../src/manager/topic_draft_schema.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

interface ParagraphDecision {
  ordinal: number;
  currentBehavior: string | null;
  rationale: string;
  disposition: 'update' | 'unchanged' | 'unresolved';
  sourceIndices: number[];
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
  const ids = Array.from(
    {length: sourceCount},
    (_, index) => 'tncc_' + Effect.pipe(index.toString(16), EffectString.padStart(40, '0')),
  );
  const paragraphs = Array.from({length: count}, (_, ordinal) =>
    ordinal === 0 && options.firstParagraph ? options.firstParagraph : `Claim ${ordinal}.`,
  );
  return validateTopicMaintenanceDraftBasis({
    version: 1,
    targetUri: 'threadnote://user/tester/memories/durable/topic.md',
    targetHash: Effect.pipe('a', EffectString.repeat(64)),
    observationRevision: Effect.pipe('b', EffectString.repeat(64)),
    packetDigest: Effect.pipe('c', EffectString.repeat(64)),
    body: EffectArray.join(paragraphs, '\n\n'),
    paragraphs: EffectArray.map(paragraphs, (text, ordinal) => ({
      ordinal,
      hash: sha256HexSync(text),
      role: ordinal === options.protectedOrdinal ? 'normative' : 'descriptive',
      support: 'direct',
      citationIds: ids,
    })),
    additionalDependencies: [],
    handles: EffectArray.flatMap(ids, id => [
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
  facts: {version: number; entries: ParagraphDecision[]};
  normativeComparisons: {ordinal: number; rationale: string}[];
  decision: {
    /** Legacy fields retained only for strict-rejection fixtures. */
    currentWitnesses?: {sourceIndex: number; quote: string}[];
    currentBehaviorSourceIndex?: number;
    normativeOrdinal?: number;
    requirementQuote?: string;
    missingFact?: string;
    policyAssessment: string;
    removedClaims: string[];
    reviewedSourceIndices?: number[];
  };
}

export function makeTopicDraftWireEvidence(basis: TopicMaintenanceDraftBasis) {
  return topicDraftCurrentEvidence(
    basis,
    EffectArray.map(topicDraftCurrentSourceHandles(basis), (handleId, index) => ({
      handleId,
      content: `Current source ${index}.`,
    })),
  );
}

export function topicDraftEvidenceFromPrompt(
  prompt: string,
  basis: TopicMaintenanceDraftBasis,
): Readonly<Record<string, string>> {
  const packet = JSON.parse(/^Packet: (.+)$/mu.exec(prompt)![1]);
  return Object.freeze(
    EffectRecord.fromEntries(
      packet.sources.map((source: {sourceIndex: number; current: {excerpt: string}}) => [
        topicDraftCurrentSourceHandles(basis)[source.sourceIndex],
        source.current.excerpt,
      ]),
    ),
  );
}

export function makeTopicDraftWireFixture(
  basis: TopicMaintenanceDraftBasis,
  disposition: 'update' | 'unchanged' | 'unresolved' = 'unchanged',
  _evidence = makeTopicDraftWireEvidence(basis),
): TopicDraftWireFixture {
  const unresolved = disposition === 'unresolved';
  const eligible = EffectArray.filter(
    basis.paragraphs,
    (__effectFilterValue: (typeof basis.paragraphs)[number], __effectFilterIndex: number) =>
      __effectFilterIndex in basis.paragraphs && topicDraftGenerationEligible(__effectFilterValue),
  );
  const scope = topicDraftPolicyScope(basis);
  const policyUnknown = unresolved && scope.normativeOrdinals.length > 0;
  const sourceReview = !eligible.length && !policyUnknown;
  return {
    version: 8,
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    packetDigest: basis.packetDigest,
    facts: {
      version: 1,
      entries: EffectArray.map(eligible, paragraph => ({
        ordinal: paragraph.ordinal,
        currentBehavior: unresolved ? null : 'Current supported behavior.',
        rationale: unresolved ? 'Manual review.' : 'Checked.',
        disposition,
        sourceIndices: unresolved
          ? []
          : [
              EffectOption.getOrElse(
                EffectArray.findFirstIndex(
                  topicDraftCurrentSourceHandles(basis),
                  __effectArrayValue =>
                    !!(handle =>
                      EffectArray.some(
                        [...paragraph.citationIds, ...EffectArray.map(basis.additionalDependencies, d => d.citationId)],
                        id => handle === `current:${id}`,
                      ))(__effectArrayValue),
                ),
                () => -1,
              ),
            ],
        ...(disposition === 'update' ? {text: `Current claim ${paragraph.ordinal}.`} : {}),
      })),
    },
    normativeComparisons: EffectArray.map(
      EffectArray.filter(basis.paragraphs, p => p.role === 'normative'),
      p => ({
        ordinal: p.ordinal,
        rationale: unresolved ? 'Manual review.' : 'Checked.',
      }),
    ),
    decision: {
      ...(policyUnknown
        ? {
            normativeOrdinal: scope.normativeOrdinals[0],
            missingFact: 'Current applicable behavior is not established.',
          }
        : {}),
      policyAssessment: policyUnknown ? 'undetermined' : sourceReview ? 'source-review' : 'no-conflict-observed',
      removedClaims: [],
      ...(sourceReview
        ? {reviewedSourceIndices: EffectArray.map(topicDraftCurrentSourceHandles(basis), (_, index) => index)}
        : {}),
    },
  };
}

/** Complete trusted packet for controller tests; no graph, model or provider process. */
export function makeTopicDraftControllerPacket() {
  const citations = EffectArray.map([0, 1], index =>
    createMemoryCodeCitation({
      evidenceRetention: 'capsule-retained',
      extractorSet: 'test',
      fileContentHash: {algorithm: 'sha256', value: Effect.pipe('2', EffectString.repeat(64))},
      path: `source-${index}.ts`,
      repositoryId: Effect.pipe('3', EffectString.repeat(64)),
      repositoryIdentityKind: 'local',
      sourceCommit: Effect.pipe('1', EffectString.repeat(40)),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${Effect.pipe('1', EffectString.repeat(40))}`,
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
  const paragraphs = EffectArray.map(Effect.pipe(record.body, EffectString.split('\n\n')), (text, ordinal) => ({
    ordinal,
    hash: sha256HexSync(text),
    role: ordinal === 2 ? ('normative' as const) : ('descriptive' as const),
    support: 'direct' as const,
    citationIds: EffectArray.map(citations, citation => citation.id),
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
    observationRevision: Effect.pipe('b', EffectString.repeat(64)),
    coverage: 'declared-only' as const,
    body: record.body,
    paragraphs,
    additionalDependencies: [],
    sources: EffectArray.map(citations, citation => ({
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
      caseId: 'health-case-' + Effect.pipe('a', EffectString.repeat(40)),
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

/** Independent test encoder; provider fixtures must use the distinct compact wire. */
export function compactAutomaticTopicDraftFixture(
  basis: AutomaticMaintenanceDraftBasisV3,
  draft: AutomaticMaintenanceDraftV2,
) {
  const evidence = [
    ...new Set([
      ...EffectArray.map(basis.assessment.evidence, entry => entry.id),
      ...EffectArray.map(basis.handles, h => h.citationId),
    ]),
  ].sort();
  const current = [
    ...new Set(
      EffectArray.map(
        EffectArray.filter(basis.handles, h => h.variant === 'current'),
        h => h.id,
      ),
    ),
  ].sort();
  const {purpose: _purpose, reviewedHandles, paragraphDecisions, operations, ...rest} = draft;
  return {
    ...rest,
    version: 1 as const,
    kind: 'automatic-model' as const,
    paragraphDecisions: EffectArray.map(paragraphDecisions, ({beforeHash: _beforeHash, evidenceIds, ...decision}) => ({
      ...decision,
      evidenceIndices: EffectArray.map(evidenceIds, id => evidence.indexOf(id)),
    })),
    operations: EffectArray.map(operations, ({beforeHash: _beforeHash, supportHandles, ...operation}) => ({
      ...operation,
      supportIndices: EffectArray.map(supportHandles, handle => current.indexOf(handle)),
    })),
    currentSourceIndices: EffectArray.map(reviewedHandles, handle => current.indexOf(handle)),
  };
}
