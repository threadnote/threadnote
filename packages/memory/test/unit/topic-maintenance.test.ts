import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {memoryCodeCitationContentSharingBlocker} from '@threadnote/memory/code/citation-policy';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  formatMemoryDocumentWithKeywords,
  parseMemoryDocument,
} from '@threadnote/memory/document';
import {
  buildTopicMaintenanceManifest,
  proposeTopicMaintenanceEnrollment,
  validateTopicMaintenanceEnrollmentInput,
  validateTopicMaintenanceManifest,
  topicMaintenanceReplacementError,
} from '@threadnote/memory/topic-maintenance';

const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/topic.md';
const citation = createMemoryCodeCitation({
  evidenceRetention: 'capsule-retained',
  extractorSet: 'native-code-graph-13',
  fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
  path: 'packages/memory/src/document.ts',
  repositoryId: '1'.repeat(64),
  repositoryIdentityKind: 'remote',
  sourceCommit: '2'.repeat(40),
  sourceDirty: false,
  sourceGraphContentId: `cgc_${'3'.repeat(40)}`,
  sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
  target: {kind: 'file'},
  version: 1,
});
const body = 'Same paragraph.\n\nSame paragraph.\n\nA configuration controls retries.';

function record(text = body) {
  return parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        codeCitations: [citation],
        kind: 'durable',
        memoryId: 'tn_topic_fixture',
        project: 'threadnote',
        schemaVersion: 8,
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-10-16T00:00:00.000Z',
      },
      text,
    ),
  )!;
}

function decisions() {
  return {
    paragraphs: [
      {role: 'descriptive' as const, support: 'direct' as const, citationIds: [citation.id]},
      {role: 'historical' as const, support: 'contextual' as const, citationIds: [citation.id]},
      {role: 'normative' as const, support: 'unresolved' as const, citationIds: []},
    ],
    additionalDependencies: [{kind: 'configuration' as const, citationId: citation.id}],
  };
}

describe('topic maintenance manifest', () => {
  it('permits only the exact dedicated initial enrollment while generic writers preserve evidence', () => {
    const source = record();
    const proposal = proposeTopicMaintenanceEnrollment(source, decisions());
    const next = parseMemoryDocument(uri, proposal.content)!;
    expect(topicMaintenanceReplacementError(source, next)).toMatch(/dedicated review/);
    expect(topicMaintenanceReplacementError(source, next, proposal.manifest)).toBeUndefined();
    expect(topicMaintenanceReplacementError(source, {...next, body: 'Changed.'}, proposal.manifest)).toBeDefined();
    expect(
      topicMaintenanceReplacementError(source, next, {...proposal.manifest, bodyHash: '0'.repeat(64)}),
    ).toBeDefined();
    expect(topicMaintenanceReplacementError(next, source, proposal.manifest)).toMatch(/dedicated review/);
    expect(topicMaintenanceReplacementError(next, {...next, body: 'Changed.'}, proposal.manifest)).toMatch(
      /reviewed update/,
    );
  });

  it('enrolls canonical schema 9 while preserving existing provenance and duplicate paragraph identity', () => {
    const source = record();
    const proposal = proposeTopicMaintenanceEnrollment(source, decisions());
    const parsed = parseMemoryDocument(uri, proposal.content)!;
    expect(parsed.metadata.topicMaintenance).toEqual(proposal.manifest);
    expect(parsed.metadata.codeCitations).toEqual([citation]);
    expect(proposal.manifest.paragraphs.map(paragraph => paragraph.ordinal)).toEqual([0, 1, 2]);
    expect(proposal.manifest.paragraphs[0].hash).toBe(proposal.manifest.paragraphs[1].hash);
    expect(proposal.manifest.bodyHash).toBeDefined();
    expect(proposal.content).toContain('schema_version: 9');
    expect(
      parseMemoryDocument(uri, formatMemoryDocumentWithKeywords(proposal.content, ['updated']))?.metadata
        .topicMaintenance,
    ).toEqual(proposal.manifest);
  });

  it('rejects stale body, unknown citation, dirty citation, and over-budget enrollment', () => {
    const source = record();
    const manifest = buildTopicMaintenanceManifest(source, decisions());
    expect(() => validateTopicMaintenanceManifest(manifest, {...source, body: `${source.body} edited`})).toThrow(
      /body|paragraph/i,
    );
    expect(() =>
      buildTopicMaintenanceManifest(source, {
        ...decisions(),
        additionalDependencies: [{kind: 'dependency', citationId: `tncc_${'f'.repeat(40)}`}],
      }),
    ).toThrow(/citation/i);
    const dirtyCitation = createMemoryCodeCitation({
      evidenceRetention: 'capsule-retained',
      extractorSet: citation.extractorSet,
      fileContentHash: citation.fileContentHash,
      path: citation.path,
      repositoryId: citation.repositoryId,
      repositoryIdentityKind: citation.repositoryIdentityKind,
      sourceCommit: citation.sourceCommit,
      sourceDirty: true,
      sourceGraphContentId: citation.sourceGraphContentId,
      sourceSnapshotId: citation.sourceSnapshotId,
      target: citation.target,
      version: 1,
    });
    const dirty = {...source, metadata: {...source.metadata, codeCitations: [dirtyCitation]}};
    expect(() => buildTopicMaintenanceManifest(dirty, decisions())).toThrow(/dirty/i);
    expect(() =>
      buildTopicMaintenanceManifest(record(Array(65).fill('Section.').join('\n\n')), {
        paragraphs: Array(65).fill({role: 'descriptive', support: 'unresolved', citationIds: []}),
        additionalDependencies: [],
      }),
    ).toThrow(/64|paragraph/i);
  });

  it('rejects unknown JSON input fields and shared enrollment targets', () => {
    expect(() => validateTopicMaintenanceEnrollmentInput({...decisions(), privateJob: 'leak'})).toThrow(/input/i);
    expect(() =>
      validateTopicMaintenanceEnrollmentInput({
        ...decisions(),
        paragraphs: [{...decisions().paragraphs[0], sourceExcerpt: 'private'}],
      }),
    ).toThrow(/paragraph input/i);
    const source = record();
    expect(() =>
      proposeTopicMaintenanceEnrollment(
        {
          ...source,
          uri: 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/topic.md',
        },
        decisions(),
      ),
    ).toThrow(/personal durable/i);
  });

  it('preserves unrelated raw headers and CRLF body bytes during enrollment', () => {
    const source = record();
    const content = source.content
      .replace(/\n/gu, '\r\n')
      .replace('\r\n\r\n', '\r\nopaque_header: keeps-byte-shape\r\n\r\n');
    const parsed = parseMemoryDocument(uri, content)!;
    const proposal = proposeTopicMaintenanceEnrollment(parsed, decisions());
    expect(proposal.content).toContain('opaque_header: keeps-byte-shape\r\n');
    expect(proposal.content.slice(proposal.content.indexOf('\r\n\r\n') + 4)).toBe(
      content.slice(content.indexOf('\r\n\r\n') + 4),
    );
    expect(proposal.content).toContain('schema_version: 9\r\n');
  });

  it('rejects malformed and unsupported manifest headers before rewrite', () => {
    const content = proposeTopicMaintenanceEnrollment(record(), decisions()).content;
    const cases = [
      content.replace(/^topic_maintenance: .*$/mu, 'topic_maintenance: {bad-json}'),
      content.replace(/^topic_maintenance: .*$/mu, line => `${line}\n${line}`),
      content.replace(/^topic_maintenance: .*$/mu, line => ` ${line}`),
      content.replace(/^topic_maintenance: .*$/mu, line => line.replace(': ', ':  ')),
      content.replace('schema_version: 9', 'schema_version: 8'),
      content.replace('Same paragraph.', 'Edited paragraph.'),
      content.replace('"version":1', '"version":2'),
    ];
    for (const malformed of cases) {
      expect(parseMemoryDocument(uri, malformed)?.metadata.topicMaintenanceError).toBeDefined();
      expect(parseMemoryDocument(uri, malformed)?.metadata.citationErrors).toContainEqual({reason: 'invalid-shape'});
      expect(() => assertMemoryDocumentSchemaWritable(malformed)).toThrow(/topic maintenance/i);
      expect(memoryCodeCitationContentSharingBlocker(uri, malformed)).toBe('malformed-citation');
    }
  });

  it('has deterministic round trips and invalidates any edited paragraph (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({minLength: 1, maxLength: 30}).filter(s => s.trim().length > 0 && !s.includes('\n')),
          {minLength: 1, maxLength: 12},
        ),
        sections => {
          const source = record(sections.join('\n\n'));
          const input = {
            paragraphs: sections.map(() => ({
              role: 'descriptive' as const,
              support: 'direct' as const,
              citationIds: [citation.id],
            })),
            additionalDependencies: [],
          };
          const first = buildTopicMaintenanceManifest(source, input);
          expect(buildTopicMaintenanceManifest(source, input)).toEqual(first);
          const content = proposeTopicMaintenanceEnrollment(source, input).content;
          expect(parseMemoryDocument(uri, content)?.metadata.topicMaintenance).toEqual(first);
          expect(() => validateTopicMaintenanceManifest(first, {...source, body: `${source.body}x`})).toThrow();
        },
      ),
      {numRuns: 40},
    );
  });
});
