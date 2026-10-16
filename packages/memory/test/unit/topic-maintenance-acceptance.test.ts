import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {createMemoryCodeCitation} from '../../src/code/citation.js';
import {parseCandidateReview} from '../../src/candidate.js';
import {
  captureConsolidationSource,
  consolidationRevision,
  consolidationSections,
  reviewConsolidation,
} from '../../src/consolidation.js';
import {canonicalMemoryDocumentContent, formatMemoryDocument, parseMemoryDocument} from '../../src/document.js';
import {proposeTopicMaintenanceEnrollment, topicMaintenanceReplacementError} from '../../src/topic-maintenance.js';
import {parseTopicMaintenanceDraft} from '../../src/topic-maintenance-draft.js';
import {
  prepareTopicMaintenanceAcceptance,
  validateApprovedTopicMaintenanceWrite,
  validateTopicMaintenanceAcceptancePreview,
} from '../../src/topic-maintenance-acceptance.js';

const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/topic.md';
const oldCitation = createMemoryCodeCitation({
  version: 1,
  evidenceRetention: 'capsule-retained',
  repositoryId: '1'.repeat(64),
  repositoryIdentityKind: 'local',
  sourceCommit: '2'.repeat(40),
  sourceSnapshotId: `cgsn_${'3'.repeat(40)}`,
  sourceDirty: false,
  extractorSet: 'native-test',
  path: 'src/topic.ts',
  fileContentHash: {algorithm: 'sha256', value: '4'.repeat(64)},
  target: {kind: 'file'},
});
const {id: _id, ...currentInput} = oldCitation;
const currentCitation = createMemoryCodeCitation({
  ...currentInput,
  sourceCommit: '5'.repeat(40),
  sourceSnapshotId: `cgsn_${'6'.repeat(40)}`,
  fileContentHash: {algorithm: 'sha256', value: '7'.repeat(64)},
});

function fixture(body = 'Old claim.\n\nHistorical note.', consolidated = false, extraCitations = 0) {
  const provenance = consolidated
    ? (() => {
        const source = captureConsolidationSource({
          uri: 'threadnote://user/tester/memories/durable/projects/threadnote/source.md',
          content: formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              project: 'threadnote',
              topic: 'source',
              sourceAgentClient: 'test',
              timestamp: '2026-10-16T00:00:00.000Z',
              schemaVersion: 9,
              codeCitations: [oldCitation],
            },
            body,
          ),
        });
        return reviewConsolidation(
          body,
          [source],
          consolidationSections(body).map((section, index) => ({
            section,
            disposition: 'direct' as const,
            supports: [{sourceUri: source.uri, fragment: index, citationIds: [oldCitation.id], relationIndexes: []}],
          })),
          {
            operationId: 'topic-source',
            cleanup: 'keep',
            cleanupShared: false,
            target: {
              kind: 'durable',
              status: 'active',
              project: 'threadnote',
              topic: 'topic',
              sourceAgentClient: 'test',
            },
          },
        ).provenance;
      })()
    : undefined;
  const content = formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      status: 'active',
      project: 'threadnote',
      topic: 'topic',
      memoryId: 'tn_topic_fixture',
      sourceAgentClient: 'test',
      timestamp: '2026-10-16T00:00:00.000Z',
      schemaVersion: 9,
      codeCitations: [
        oldCitation,
        ...Array.from({length: extraCitations}, (_, index) =>
          createMemoryCodeCitation({
            ...currentInput,
            path: `src/extra-${index}.ts`,
          }),
        ),
      ],
      owner: 'tester',
      authority: 'user_approved',
      visibility: 'personal',
      ...(provenance ? {consolidation: provenance} : {}),
    },
    body,
  ).replace('\n\n', '\nopaque_header: keep exactly\n\n');
  const enrolled = proposeTopicMaintenanceEnrollment(parseMemoryDocument(uri, content)!, {
    paragraphs: consolidationSections(body).map((_, ordinal) => ({
      role: ordinal === 0 ? ('descriptive' as const) : ('historical' as const),
      support: 'direct' as const,
      citationIds: [oldCitation.id],
      scope: 'Only this repository',
    })),
  });
  const record = parseMemoryDocument(uri, enrolled.content)!;
  const basis = {
    version: 1 as const,
    targetUri: uri,
    targetHash: consolidationRevision(canonicalMemoryDocumentContent(record.content)),
    observationRevision: '8'.repeat(64),
    packetDigest: '9'.repeat(64),
    body: record.body,
    paragraphs: record.metadata.topicMaintenance!.paragraphs,
    additionalDependencies: [],
    handles: [
      {id: `historical:${oldCitation.id}`, citationId: oldCitation.id, variant: 'historical' as const},
      {id: `current:${oldCitation.id}`, citationId: oldCitation.id, variant: 'current' as const},
    ],
  };
  const draft = {
    version: 1,
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    packetDigest: basis.packetDigest,
    outcome: 'propose-update',
    operations: [
      {
        ordinal: 0,
        beforeHash: basis.paragraphs[0].hash,
        text: 'New claim.',
        supportHandles: [`current:${oldCitation.id}`],
        rationale: 'Current source changed.',
      },
    ],
    reviewedHandles: [`current:${oldCitation.id}`],
    rationale: 'Review new claim.',
    unresolvedQuestions: [],
    removedClaims: [],
  };
  const proposal = parseTopicMaintenanceDraft(basis, JSON.stringify(draft));
  const evidence = [oldCitation, currentCitation].map((citation, index) => ({
    handleId: `${index === 0 ? 'historical' : 'current'}:${oldCitation.id}`,
    content: 'export const topic = 1;',
    excerptHash: consolidationRevision('export const topic = 1;'),
    fileBytesHash: `${index === 0 ? 'a' : 'b'}`.repeat(64),
    startLine: 1,
    endLine: 1,
    provenance: index === 0 ? ('historical-verified' as const) : ('current-verified' as const),
    supportsCitation: true as const,
    truncated: false as const,
    source: {
      extractorSet: citation.extractorSet,
      fileContentHash: citation.fileContentHash.value,
      path: citation.path,
      repositoryId: citation.repositoryId,
      sourceCommit: citation.sourceCommit,
      sourceDirty: citation.sourceDirty,
      sourceSnapshotId: citation.sourceSnapshotId,
    },
    citation,
  }));
  const review = {
    version: 1 as const,
    basis,
    proposal,
    reviewEvidence: evidence,
    generation: {
      origin: 'manual' as const,
      agent: 'manual' as const,
      model: 'none' as const,
      promptVersion: 'manual-topic-v1' as const,
      attempts: 0 as const,
      usage: {status: 'unavailable' as const},
    },
  };
  return {record, review};
}

describe('topic maintenance accepted document', () => {
  it('prepares exact V2 body, support, origin and private approval proof', () => {
    const {record, review} = fixture();
    const preview = prepareTopicMaintenanceAcceptance(record, review, {
      reviewId: 'review-one',
      approvedAt: '2026-10-16T12:00:00.000Z',
    });
    expect(preview.content).toContain('opaque_header: keep exactly');
    expect(preview.content).toContain('authority: user_approved');
    expect(preview.content).toContain('owner: tester');
    expect(preview.manifest.originCitationIds).toEqual([oldCitation.id]);
    expect(preview.manifest.paragraphs[0].citationIds).toEqual([currentCitation.id]);
    expect(preview.manifest.paragraphs[1].citationIds).toEqual([oldCitation.id]);
    expect(preview.manifest.acceptedSources).toEqual(
      [
        {citationId: oldCitation.id, acceptedCitationId: currentCitation.id},
        {citationId: currentCitation.id, acceptedCitationId: currentCitation.id},
      ].sort((a, b) => a.citationId.localeCompare(b.citationId)),
    );
    expect(validateTopicMaintenanceAcceptancePreview(preview, review)).toEqual(preview);
    const approval = {version: 1 as const, reviewRevision: 2, stage: 'prepared' as const, preview};
    const privateReview = {reviewId: 'review-one', revision: 3, maintenance: review, maintenanceApproval: approval};
    expect(validateApprovedTopicMaintenanceWrite(record.content, preview.content, privateReview)).toEqual(preview);
    expect(() => validateApprovedTopicMaintenanceWrite(record.content + 'x', preview.content, privateReview)).toThrow();
  });

  it('leaves no-text revalidation body bytes unchanged and rejects edits to historical claims', () => {
    const {record, review} = fixture();
    const revalidation = parseTopicMaintenanceDraft(
      review.basis,
      JSON.stringify({
        ...review.proposal.draft,
        outcome: 'propose-revalidation',
        operations: [],
      }),
    );
    const preview = prepareTopicMaintenanceAcceptance(
      record,
      {...review, proposal: revalidation},
      {
        reviewId: 'review-one',
        approvedAt: '2026-10-16T12:00:00.000Z',
      },
    );
    expect(parseMemoryDocument(uri, preview.content)?.body).toBe(record.body);
    const historicalEdit = {
      ...review.proposal.draft,
      operations: [{...review.proposal.draft.operations[0], ordinal: 1, beforeHash: review.basis.paragraphs[1].hash}],
    };
    expect(() =>
      prepareTopicMaintenanceAcceptance(record, review, {
        reviewId: 'review-one',
        approvedAt: '2026-10-16T12:00:00.000Z',
        editedDraftJson: JSON.stringify(historicalEdit),
      }),
    ).toThrow();
  });

  it('keeps consolidated origin replayable while replacing only reviewed active support', () => {
    const {record, review} = fixture(undefined, true);
    const preview = prepareTopicMaintenanceAcceptance(record, review, {
      reviewId: 'review-one',
      approvedAt: '2026-10-16T12:00:00.000Z',
    });
    const parsed = parseMemoryDocument(uri, preview.content)!;
    expect(parsed.metadata.citationErrors).toBeUndefined();
    expect(parsed.metadata.consolidation?.version).toBe(2);
    if (parsed.metadata.consolidation?.version !== 2) throw new Error('Expected V2 provenance.');
    expect(parsed.metadata.consolidation.origin).toEqual(record.metadata.consolidation);
    expect(parsed.metadata.consolidation.originBody).toBe(record.body);
    expect(parsed.metadata.consolidation.acceptance.paragraphs).toMatchObject([
      {evidence: 'reviewed-current', citationIds: [currentCitation.id]},
      {evidence: 'origin', citationIds: [oldCitation.id]},
    ]);
    expect(
      topicMaintenanceReplacementError(record, {
        ...record,
        metadata: {...record.metadata, consolidation: undefined},
      }),
    ).toMatch(/reviewed update/);
  });

  it('rejects the ninth citation rather than pruning immutable origin lineage', () => {
    const {record, review} = fixture(undefined, false, 7);
    expect(record.metadata.codeCitations).toHaveLength(8);
    expect(() =>
      prepareTopicMaintenanceAcceptance(record, review, {
        reviewId: 'review-one',
        approvedAt: '2026-10-16T12:00:00.000Z',
      }),
    ).toThrow(/citation union has 9 entries/);
  });

  it('round trips the private approval stage with a fixed preview revision', () => {
    const {record, review} = fixture();
    const preview = prepareTopicMaintenanceAcceptance(record, review, {
      reviewId: 'review-one',
      approvedAt: '2026-10-16T12:00:00.000Z',
    });
    const base = {
      version: 2,
      reviewId: 'review-one',
      revision: 2,
      candidates: [],
      codeCitations: [],
      auditEvents: [],
      createdAt: '2026-10-16T00:00:00.000Z',
      outcome: 'maintenance',
      project: 'threadnote',
      sourceAgentClient: 'test',
      task: 'review topic',
      topic: 'topic',
      maintenance: review,
    };
    const approval = {version: 1, reviewRevision: 2, stage: 'preview', preview};
    expect(parseCandidateReview({...base, maintenanceApproval: approval}).maintenanceApproval).toEqual(approval);
    expect(
      parseCandidateReview({...base, revision: 3, maintenanceApproval: {...approval, stage: 'prepared'}})
        .maintenanceApproval?.reviewRevision,
    ).toBe(2);
    expect(() => parseCandidateReview({...base, revision: 3, maintenanceApproval: approval})).toThrow();
    expect(() =>
      parseCandidateReview({
        ...base,
        maintenanceApproval: {...approval, preview: {...preview, beforeContent: 'tampered'}},
      }),
    ).toThrow();
    const conflict = {...approval, stage: 'conflict'};
    const maintenanceClosedConflict = {
      version: 1,
      reviewRevision: approval.reviewRevision,
      targetUri: preview.targetUri,
      beforeContentHash: preview.beforeContentHash,
      contentHash: preview.contentHash,
      approvalDigest: preview.approvalDigest,
    };
    expect(
      parseCandidateReview({...base, revision: 3, maintenanceApproval: conflict, maintenanceClosedConflict})
        .maintenanceClosedConflict,
    ).toEqual(maintenanceClosedConflict);
    expect(parseCandidateReview({...base, revision: 4, maintenanceClosedConflict}).maintenanceClosedConflict).toEqual(
      maintenanceClosedConflict,
    );
    expect(() =>
      parseCandidateReview({
        ...base,
        revision: 3,
        maintenanceApproval: conflict,
        maintenanceClosedConflict: {...maintenanceClosedConflict, approvalDigest: 'f'.repeat(64)},
      }),
    ).toThrow();
    expect(() =>
      parseCandidateReview({...base, maintenanceClosedConflict: {...maintenanceClosedConflict, extra: true}}),
    ).toThrow();
    const nextPreview = prepareTopicMaintenanceAcceptance(record, review, {
      reviewId: 'review-one',
      approvedAt: '2026-10-16T13:00:00.000Z',
    });
    const nextConflict = {version: 1, reviewRevision: 5, stage: 'conflict', preview: nextPreview};
    expect(
      parseCandidateReview({
        ...base,
        revision: 6,
        maintenanceApproval: nextConflict,
        maintenanceClosedConflict,
      }).maintenanceClosedConflict,
    ).toEqual(maintenanceClosedConflict);
    const nextClosed = {
      ...maintenanceClosedConflict,
      reviewRevision: nextConflict.reviewRevision,
      contentHash: nextPreview.contentHash,
      approvalDigest: nextPreview.approvalDigest,
    };
    expect(
      parseCandidateReview({
        ...base,
        revision: 7,
        maintenanceApproval: nextConflict,
        maintenanceClosedConflict: nextClosed,
      }).maintenanceClosedConflict,
    ).toEqual(nextClosed);
    expect(
      parseCandidateReview({...base, revision: 8, maintenanceClosedConflict: nextClosed}).maintenanceClosedConflict,
    ).toEqual(nextClosed);
    expect(() =>
      parseCandidateReview({
        ...base,
        revision: 6,
        maintenanceApproval: nextConflict,
        maintenanceClosedConflict: {...maintenanceClosedConflict, reviewRevision: 6},
      }),
    ).toThrow();
  });

  it('prepares an existing shared enrolled target without changing its visibility', () => {
    const {record, review} = fixture();
    const sharedUri = 'threadnote://user/tester/memories/shared/team/durable/projects/threadnote/topic.md';
    const sharedContent = record.content.replace('visibility: personal', 'visibility: shared');
    const shared = parseMemoryDocument(sharedUri, sharedContent)!;
    const sharedReview = {
      ...review,
      basis: {
        ...review.basis,
        targetUri: sharedUri,
        targetHash: consolidationRevision(canonicalMemoryDocumentContent(shared.content)),
      },
    };
    const sharedDraft = {...review.proposal.draft, targetHash: sharedReview.basis.targetHash};
    const proposal = parseTopicMaintenanceDraft(sharedReview.basis, JSON.stringify(sharedDraft));
    const preview = prepareTopicMaintenanceAcceptance(
      shared,
      {...sharedReview, proposal},
      {
        reviewId: 'review-one',
        approvedAt: '2026-10-16T12:00:00.000Z',
      },
    );
    expect(preview.content).toContain('visibility: shared');
    expect(parseMemoryDocument(sharedUri, preview.content)?.metadata.visibility).toBe('shared');
  });

  it('keeps origin identity and untouched paragraphs across bounded arbitrary replacements', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,24}$/u), replacement => {
        fc.pre(replacement !== 'Old claim.');
        const {record, review} = fixture();
        const draft = {
          ...review.proposal.draft,
          operations: [{...review.proposal.draft.operations[0], text: replacement}],
        };
        const preview = prepareTopicMaintenanceAcceptance(record, review, {
          reviewId: 'review-one',
          approvedAt: '2026-10-16T12:00:00.000Z',
          editedDraftJson: JSON.stringify(draft),
        });
        expect(preview.content).toContain(`${replacement}\n\nHistorical note.`);
        expect(preview.manifest.originCitationIds).toEqual([oldCitation.id]);
        expect(preview.manifest.paragraphs[1]).toEqual(record.metadata.topicMaintenance!.paragraphs[1]);
      }),
      {numRuns: 40},
    );
  });
});
