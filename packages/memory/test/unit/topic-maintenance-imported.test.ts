import {parseCandidateReview} from '../../src/candidate.js';
import {parseCandidateReview as parseLegacyCandidateReview} from '../fixtures/candidate-v2-reader.mjs';
import {validateTopicMaintenanceObsidianCaptureIntent} from '../../src/topic-maintenance-draft.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import * as legacy from '../fixtures/schema10-writer.mjs';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryObsidianEvidenceV1,
} from '../../src/document.js';
import {
  memoryCodeCitationSharingBlocker,
  memoryCodeCitationContentSharingBlocker,
} from '../../src/code/citation-policy.js';
import {consolidationRevision} from '../../src/consolidation.js';
import {
  buildTopicMaintenanceObsidianManifest,
  topicMaintenanceObsidianCitationId,
  validateTopicMaintenanceManifest,
  topicMaintenanceReplacementError,
} from '../../src/topic-maintenance.js';
import {
  parseTopicMaintenanceDraft,
  validateTopicMaintenanceBasis,
  validateTopicMaintenanceDraftBasis,
  validateTopicMaintenanceReview,
  validateTopicMaintenanceReviewPayload,
  type TopicMaintenanceObsidianDraftBasisV2,
  type TopicMaintenanceObsidianReviewPayloadV2,
} from '../../src/topic-maintenance-draft.js';
import {
  prepareTopicMaintenanceObsidianAcceptance,
  prepareTopicMaintenanceSourceAcceptance,
  validateTopicMaintenanceSourceAcceptancePreview,
  validateTopicMaintenanceObsidianAcceptancePreview,
} from '../../src/topic-maintenance-acceptance.js';

const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/topic.md';
const originText = 'Initial retained fragment.';
const currentText = 'Current retained fragment.';
const origin: MemoryObsidianEvidenceV1 = {
  version: 1,
  sourceId: 'notes',
  sourceInstanceId: '11111111-1111-4111-8111-111111111111',
  vaultHash: 'a'.repeat(64),
  accessHash: 'b'.repeat(64),
  noteId: '22222222-2222-4222-8222-222222222222',
  relativePath: 'Decision.md',
  revisionHash: 'c'.repeat(64),
  sanitizerVersion: 'scrubber-redact-v1',
  fragmentHash: consolidationRevision(originText),
  fragmentStart: 0,
  fragmentEnd: originText.length,
  pinId: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2027-01-01T00:00:00.000Z',
};
const current: MemoryObsidianEvidenceV1 = {
  ...origin,
  relativePath: 'Renamed.md',
  revisionHash: 'd'.repeat(64),
  fragmentHash: consolidationRevision(currentText),
  fragmentEnd: currentText.length,
  pinId: '44444444-4444-4444-8444-444444444444',
  expiresAt: '2027-01-02T00:00:00.000Z',
};
const originId = topicMaintenanceObsidianCitationId(origin);
const body = 'Old descriptive claim.\n\nHistorical constraint.';

function fixture() {
  const content = formatMemoryDocument(
    'MEMORY',
    {
      memoryId: 'tn_imported_fixture',
      kind: 'durable',
      status: 'active',
      project: 'threadnote',
      schemaVersion: 10,
      sourceAgentClient: 'test',
      timestamp: '2026-10-18T00:00:00.000Z',
      obsidianEvidence: origin,
    },
    body,
  );
  const original = parseMemoryDocument(uri, content)!;
  const manifest = buildTopicMaintenanceObsidianManifest(original, {
    paragraphs: [
      {role: 'descriptive', support: 'direct', citationIds: [originId]},
      {role: 'historical', support: 'direct', citationIds: [originId]},
    ],
  });
  const record = parseMemoryDocument(
    uri,
    formatMemoryDocument('MEMORY', {...original.metadata, topicMaintenance: manifest}, body).replace(
      '\n\n',
      '\nopaque_header: preserve exactly\n\n',
    ),
  )!;
  const basis: TopicMaintenanceObsidianDraftBasisV2 = {
    version: 2,
    sourceKind: 'obsidian',
    targetUri: uri,
    targetHash: consolidationRevision(canonicalMemoryDocumentContent(record.content)),
    observationRevision: 'e'.repeat(64),
    packetDigest: 'f'.repeat(64),
    body,
    paragraphs: manifest.paragraphs,
    additionalDependencies: [],
    handles: (['historical', 'current'] as const).map(variant => ({
      id: `${variant}:${originId}`,
      citationId: originId,
      variant,
    })),
    originEvidence: origin,
    activeEvidence: origin,
    currentEvidence: current,
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
        beforeHash: manifest.paragraphs[0].hash,
        text: 'New descriptive claim.',
        supportHandles: [`current:${originId}`],
        rationale: 'Reviewed exact current fragment.',
      },
    ],
    reviewedHandles: [],
    rationale: 'Explicit imported update.',
    unresolvedQuestions: [],
    removedClaims: [],
  };
  const review: TopicMaintenanceObsidianReviewPayloadV2 = {
    version: 2,
    sourceKind: 'obsidian',
    basis,
    proposal: parseTopicMaintenanceDraft(basis, JSON.stringify(draft)),
    reviewEvidence: basis.handles.map(handle => ({
      sourceKind: 'obsidian',
      handleId: handle.id,
      content: handle.variant === 'historical' ? originText : currentText,
      excerptHash: handle.variant === 'historical' ? origin.fragmentHash : current.fragmentHash,
      provenance: handle.variant === 'historical' ? 'historical-verified' : 'current-verified',
      supportsCitation: true,
      truncated: false,
      citation: handle.variant === 'historical' ? origin : current,
    })),
    generation: {
      origin: 'manual',
      agent: 'manual',
      model: 'none',
      promptVersion: 'manual-topic-v1',
      attempts: 0,
      usage: {status: 'unavailable'},
    },
  };
  return {original, record, manifest, basis, draft, review};
}
const options = {reviewId: 'review-imported-fixture', approvedAt: '2026-10-18T00:00:00.000Z'};

describe('closed imported topic maintenance contracts', () => {
  it('round-trips the imported union, preserving immutable origin and protected raw paragraphs', () => {
    const {record, review} = fixture();
    expect(validateTopicMaintenanceBasis(review.basis)).toEqual(review.basis);
    expect(validateTopicMaintenanceReview(review)).toEqual(review);
    const preview = prepareTopicMaintenanceObsidianAcceptance(record, review, options);
    expect(validateTopicMaintenanceObsidianAcceptancePreview(preview, review)).toEqual(preview);
    expect(prepareTopicMaintenanceSourceAcceptance(record, review, options)).toEqual(preview);
    expect(validateTopicMaintenanceSourceAcceptancePreview(preview, review)).toEqual(preview);
    const next = parseMemoryDocument(uri, preview.content)!;
    expect(next.metadata.obsidianEvidence).toEqual(origin);
    expect(preview.manifest.activeEvidence).toEqual(current);
    expect(preview.manifest.originCitationId).toBe(originId);
    expect(next.body).toBe('New descriptive claim.\n\nHistorical constraint.');
    expect(preview.content).toContain('opaque_header: preserve exactly');
    expect(preview.manifest.paragraphs[1]).toEqual(record.metadata.topicMaintenance!.paragraphs[1]);
    expect(topicMaintenanceReplacementError(record, next)).toMatch(/reviewed update/);
    expect(memoryCodeCitationContentSharingBlocker(uri, preview.content)).toBe('private-obsidian-evidence');
    expect(memoryCodeCitationSharingBlocker({topicMaintenance: preview.manifest})).toBe('private-obsidian-evidence');
  });

  it('preserves CRLF header/protected prose bytes and refuses generic origin replacement', () => {
    const {record, review, draft} = fixture();
    const crlf = parseMemoryDocument(uri, record.content.replaceAll('\n', '\r\n'))!;
    const basis = {...review.basis, targetHash: consolidationRevision(canonicalMemoryDocumentContent(crlf.content))};
    const proposal = parseTopicMaintenanceDraft(basis, JSON.stringify({...draft, targetHash: basis.targetHash}));
    const preview = prepareTopicMaintenanceObsidianAcceptance(crlf, {...review, basis, proposal}, options);
    expect(preview.content).toContain('\r\nopaque_header: preserve exactly\r\n');
    expect(preview.content.slice(preview.content.indexOf('\r\n\r\n') + 4)).toBe(
      'New descriptive claim.\r\n\r\nHistorical constraint.',
    );
    const originLine = crlf.content.split('\r\n').find(line => line.startsWith('obsidian_evidence:'));
    expect(preview.content.split('\r\n')).toContain(originLine);
    expect(
      topicMaintenanceReplacementError(record, {...record, metadata: {...record.metadata, obsidianEvidence: current}}),
    ).toMatch(/reviewed update/);
  });

  it('keeps old code-only consumers closed and never fabricates code proof fields', () => {
    const {basis, review, record} = fixture();
    expect(() => validateTopicMaintenanceDraftBasis(basis)).toThrow(/provider adapter/);
    expect(() => validateTopicMaintenanceReviewPayload(review)).toThrow(/provider adapter/);
    for (const sourceKind of ['unknown', 'github', 'code', '', null]) {
      expect(() =>
        validateTopicMaintenanceManifest({...record.metadata.topicMaintenance, sourceKind}, record),
      ).toThrow();
      expect(() => validateTopicMaintenanceBasis({...basis, sourceKind})).toThrow();
      expect(() => validateTopicMaintenanceReview({...review, sourceKind})).toThrow();
    }
    for (const key of ['sourceCommit', 'startLine', 'rendererVersion'])
      expect(() =>
        validateTopicMaintenanceReview({
          ...review,
          reviewEvidence: review.reviewEvidence.map(item => ({...item, [key]: 'invented'})),
        }),
      ).toThrow();
    expect(() => validateTopicMaintenanceReview({...review, reviewEvidence: review.reviewEvidence.slice(1)})).toThrow();
    expect(() =>
      validateTopicMaintenanceReview({
        ...review,
        reviewEvidence: review.reviewEvidence.map(item => ({...item, content: 'Withheld or modified'})),
      }),
    ).toThrow();
  });

  it('rejects mixed, cross-note, shared, unsupported and expired evidence without changing accepted bytes', () => {
    const {record, manifest, review} = fixture();
    const accepted = record.content;
    for (const key of ['sourceId', 'sourceInstanceId', 'vaultHash', 'accessHash', 'noteId', 'sanitizerVersion']) {
      expect(() =>
        validateTopicMaintenanceManifest({...manifest, activeEvidence: {...current, [key]: 'other'}}, record),
      ).toThrow();
    }
    expect(() =>
      validateTopicMaintenanceManifest(manifest, {
        ...record,
        uri: 'threadnote://team/default/memories/durable/projects/threadnote/topic.md',
      }),
    ).toThrow();
    expect(() =>
      validateTopicMaintenanceManifest(manifest, {
        ...record,
        metadata: {...record.metadata, sourceEvidenceError: true},
      }),
    ).toThrow();
    expect(() =>
      validateTopicMaintenanceManifest(
        {...manifest, originCitationId: topicMaintenanceObsidianCitationId(current)},
        record,
      ),
    ).toThrow();
    expect(() =>
      validateTopicMaintenanceManifest({...manifest, activeEvidence: {...current, pinId: origin.pinId}}, record),
    ).toThrow(/immutable metadata/);
    expect(() =>
      prepareTopicMaintenanceObsidianAcceptance(record, review, {...options, approvedAt: origin.expiresAt}),
    ).toThrow(/expired/);
    expect(() =>
      validateTopicMaintenanceManifest(
        {
          ...manifest,
          paragraphs: [{...manifest.paragraphs[0], citationIds: [`tncc_${'a'.repeat(40)}`]}, manifest.paragraphs[1]],
        },
        record,
      ),
    ).toThrow(/unknown citation/);
    expect(record.content).toBe(accepted);
  });

  it('uses a frozen pre-Phase7 schema10 writer for parser, formatter, replacement, archive and keyword refusal', () => {
    const {record} = fixture();
    const parsed = legacy.parseMemoryDocument(uri, record.content)!;
    expect(parsed.metadata.topicMaintenance).toBeUndefined();
    expect(parsed.metadata.topicMaintenanceError).toBeDefined();
    expect(() => legacy.assertMemoryDocumentSchemaWritable(record.content)).toThrow();
    expect(() => legacy.formatMemoryDocument('MEMORY', record.metadata, record.body)).toThrow();
    expect(() => legacy.formatMemoryDocumentWithKeywords(record.content, ['updated'])).toThrow();
    expect(() => legacy.assertMemoryRecordArchivable(parsed)).toThrow();
    expect(legacy.topicMaintenanceReplacementError(parsed, parsed)).toMatch(/malformed/);
    for (const content of [
      record.content.replace('topic_maintenance:', ' topic_maintenance :'),
      record.content.replace('\n\n', `\ntopic_maintenance: ${JSON.stringify(record.metadata.topicMaintenance)}\n\n`),
      record.content.replace('"version":3,"sourceKind":"obsidian"', '"version":99,"sourceKind":"unknown"'),
    ]) {
      expect(() => legacy.assertMemoryDocumentSchemaWritable(content)).toThrow();
      expect(() => legacy.formatMemoryDocumentWithKeywords(content, ['updated'])).toThrow();
    }
  });

  it('round-trips bounded arbitrary imported claims and preserves every protected byte (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'β', '🙂', ' '), {minLength: 1, maxLength: 80}), chars => {
        const {record, review, draft} = fixture();
        const text = `Updated: ${chars.join('')}.`;
        const proposal = parseTopicMaintenanceDraft(
          review.basis,
          JSON.stringify({...draft, operations: [{...draft.operations[0], text}]}),
        );
        const preview = prepareTopicMaintenanceObsidianAcceptance(record, {...review, proposal}, options);
        const parsed = parseMemoryDocument(uri, preview.content)!;
        expect(validateTopicMaintenanceManifest(preview.manifest, parsed)).toEqual(preview.manifest);
        expect(parsed.metadata.obsidianEvidence).toEqual(origin);
        expect(preview.content.split('\n\n').slice(2).join('\n\n')).toBe(
          record.content.split('\n\n').slice(2).join('\n\n'),
        );
        expect(preview.manifest.paragraphs[1]).toEqual(review.basis.paragraphs[1]);
        expect(preview.codeCitations).toEqual([]);
      }),
      {numRuns: 30},
    );
  });
});

it('uses a closed v3 imported journal envelope that the actual old candidate reader refuses', () => {
  const {basis, review} = fixture();
  const capture = validateTopicMaintenanceObsidianCaptureIntent({
    version: 1,
    sourceKind: 'obsidian',
    stage: 'captured',
    targetUri: uri,
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    inspectionDigest: '9'.repeat(64),
    citation: current,
    input: {
      sourceId: current.sourceId,
      relativePath: current.relativePath,
      fragment: currentText,
      expectedSourceInstanceId: current.sourceInstanceId,
      expectedNoteId: current.noteId,
      expectedRevisionHash: current.revisionHash,
      expectedSanitizerVersion: current.sanitizerVersion,
      retentionDays: 30,
      reservation: {
        version: 1,
        operationId: '55555555-5555-4555-8555-555555555555',
        pinId: current.pinId,
        capturedAt: '2026-12-03T00:00:00.000Z',
        expiresAt: current.expiresAt,
        accessHash: current.accessHash,
        vaultHash: current.vaultHash,
        fragmentStart: 0,
        fragmentEnd: currentText.length,
      },
    },
  });
  const journal = {
    version: 3,
    reviewId: 'review-imported',
    revision: 1,
    createdAt: '2026-12-03T00:00:00.000Z',
    project: 'notes',
    topic: 'decision',
    task: 'Private capture.',
    outcome: 'Captured.',
    sourceAgentClient: 'test',
    candidates: [],
    codeCitations: [],
    auditEvents: [],
    maintenanceCapture: capture,
  };
  expect(parseLegacyCandidateReview({...journal, version: 2})).toMatchObject({
    maintenanceCapture: {input: {fragment: currentText}},
  });
  expect(() => parseLegacyCandidateReview(journal)).toThrow('unsupported review document');
  expect(parseCandidateReview(JSON.parse(JSON.stringify(journal)))).toEqual(journal);
  expect(parseCandidateReview({...journal, maintenance: review})).toMatchObject({version: 3, maintenance: review});
  expect(() => parseCandidateReview({...journal, version: 2})).toThrow('closed v3');
  expect(() => parseCandidateReview({...journal, maintenance: review, maintenanceCapture: undefined})).toThrow();
  expect(() => parseCandidateReview({...journal, maintenanceCapture: undefined})).toThrow();
});
