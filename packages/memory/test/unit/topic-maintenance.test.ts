import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import * as legacy from '../fixtures/schema10-writer.mjs';
import {describe, expect, it} from 'vitest';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {memoryCodeCitationContentSharingBlocker} from '@threadnote/memory/code/citation-policy';
import {
  assertMemoryDocumentSchemaWritable,
  declaresTopicMaintenanceHeader,
  formatMemoryDocument,
  formatMemoryDocumentWithKeywords,
  parseMemoryDocument,
} from '@threadnote/memory/document';
import {
  buildTopicMaintenanceManifest,
  hasTopicMaintenanceEnrollment,
  proposeTopicMaintenanceEnrollment,
  topicMaintenanceAcceptedCitation,
  validateTopicMaintenanceEnrollmentInput,
  validateTopicMaintenanceManifest,
  topicMaintenanceReplacementError,
} from '@threadnote/memory/topic-maintenance';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/topic.md';
const citation = createMemoryCodeCitation({
  evidenceRetention: 'capsule-retained',
  extractorSet: 'native-code-graph-13',
  fileContentHash: {algorithm: 'sha256', value: Effect.pipe('a', EffectString.repeat(64))},
  path: 'packages/memory/src/document.ts',
  repositoryId: Effect.pipe('1', EffectString.repeat(64)),
  repositoryIdentityKind: 'remote',
  sourceCommit: Effect.pipe('2', EffectString.repeat(40)),
  sourceDirty: false,
  sourceGraphContentId: `cgc_${Effect.pipe('3', EffectString.repeat(40))}`,
  sourceSnapshotId: `cgsn_${Effect.pipe('4', EffectString.repeat(40))}`,
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
  it('round-trips explicit code V3 while the frozen schema10 writer refuses every rewriting boundary', () => {
    const original = record();
    const v1 = buildTopicMaintenanceManifest(original, decisions());
    const manifest = {
      ...v1,
      version: 3 as const,
      sourceKind: 'code' as const,
      originCitationIds: [citation.id],
      acceptedSources: [{citationId: citation.id, acceptedCitationId: citation.id}],
    };
    const content = formatMemoryDocument(
      'MEMORY',
      {...original.metadata, schemaVersion: 10, topicMaintenance: manifest},
      original.body,
    );
    const current = parseMemoryDocument(uri, content)!;
    expect(current.metadata.topicMaintenance).toEqual(manifest);
    expect(topicMaintenanceAcceptedCitation(current, citation.id)).toEqual(citation);
    const old = legacy.parseMemoryDocument(uri, content)!;
    expect(old.metadata.topicMaintenanceError).toBeDefined();
    expect(() => legacy.assertMemoryDocumentSchemaWritable(content)).toThrow();
    expect(() => legacy.formatMemoryDocument('MEMORY', current.metadata, current.body)).toThrow();
    expect(() => legacy.assertMemoryRecordArchivable(old)).toThrow();
    expect(() => legacy.formatMemoryDocumentWithKeywords(content, ['changed'])).toThrow();
    expect(legacy.topicMaintenanceReplacementError(old, old)).toMatch(/malformed/);
    expect(() => validateTopicMaintenanceManifest({...manifest, sourceKind: 'unknown'}, current)).toThrow(
      /source kind/,
    );
  });

  it('detects declarations using the parser header boundary across line endings and whitespace rows', () => {
    const proposal = proposeTopicMaintenanceEnrollment(record(), decisions());
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', '\t', ' \t '), {minLength: 1, maxLength: 3}),
        fc.constantFrom('\n', '\r\n', '\r'),
        (rows, newline) => {
          const content = Effect.pipe(proposal.content, __effectPipeInput => {
            const __effectPipeStage0 = Effect.pipe(
              __effectPipeInput,
              EffectString.replace('topic_maintenance:', `${EffectArray.join(rows, '\n')}\ntopic_maintenance:`),
            );
            const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.replaceAll('\n', newline));
            return __effectPipeStage1;
          });
          expect(parseMemoryDocument(uri, content)?.metadata.topicMaintenance).toEqual(proposal.manifest);
          expect(declaresTopicMaintenanceHeader(content)).toBe(true);
          expect(
            declaresTopicMaintenanceHeader(
              Effect.pipe(
                content,
                EffectString.replace(/topic_maintenance: [^\r\n]+/u, ' topic_maintenance : {broken'),
              ),
            ),
          ).toBe(true);
          expect(
            declaresTopicMaintenanceHeader(
              Effect.pipe(record().content, EffectString.replaceAll('\n', newline)) +
                newline +
                newline +
                'topic_maintenance: prose only',
            ),
          ).toBe(false);
        },
      ),
      {numRuns: 30},
    );
  });

  it('keeps malformed enrollment protected from automatic lifecycle changes', () => {
    const source = record();
    expect(hasTopicMaintenanceEnrollment(source)).toBe(false);
    const proposal = proposeTopicMaintenanceEnrollment(source, decisions());
    expect(hasTopicMaintenanceEnrollment(parseMemoryDocument(uri, proposal.content)!)).toBe(true);
    const malformed = parseMemoryDocument(
      uri,
      Effect.pipe(
        proposal.content,
        EffectString.replace(/topic_maintenance: .*\n/u, 'topic_maintenance: {bad-json}\n'),
      ),
    )!;
    expect(malformed.metadata.topicMaintenance).toBeUndefined();
    expect(malformed.metadata.topicMaintenanceError).toBeDefined();
    expect(hasTopicMaintenanceEnrollment(malformed)).toBe(true);
  });

  it('permits only the exact dedicated initial enrollment while generic writers preserve evidence', () => {
    const source = record();
    const proposal = proposeTopicMaintenanceEnrollment(source, decisions());
    const next = parseMemoryDocument(uri, proposal.content)!;
    expect(topicMaintenanceReplacementError(source, next)).toMatch(/dedicated review/);
    expect(topicMaintenanceReplacementError(source, next, proposal.manifest)).toBeUndefined();
    expect(topicMaintenanceReplacementError(source, {...next, body: 'Changed.'}, proposal.manifest)).toBeDefined();
    expect(
      topicMaintenanceReplacementError(source, next, {
        ...proposal.manifest,
        bodyHash: Effect.pipe('0', EffectString.repeat(64)),
      }),
    ).toBeDefined();
    expect(topicMaintenanceReplacementError(next, source, proposal.manifest)).toMatch(/dedicated review/);
    expect(topicMaintenanceReplacementError(next, {...next, body: 'Changed.'}, proposal.manifest)).toMatch(
      /reviewed update/,
    );
  });

  it('enrolls canonical schema 10 while preserving existing provenance and duplicate paragraph identity', () => {
    const source = record();
    const proposal = proposeTopicMaintenanceEnrollment(source, decisions());
    const parsed = parseMemoryDocument(uri, proposal.content)!;
    expect(parsed.metadata.topicMaintenance).toEqual(proposal.manifest);
    expect(parsed.metadata.codeCitations).toEqual([citation]);
    expect(EffectArray.map(proposal.manifest.paragraphs, paragraph => paragraph.ordinal)).toEqual([0, 1, 2]);
    expect(proposal.manifest.paragraphs[0].hash).toBe(proposal.manifest.paragraphs[1].hash);
    expect(proposal.manifest.bodyHash).toBeDefined();
    expect(proposal.content).toContain('schema_version: 10');
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
        additionalDependencies: [{kind: 'dependency', citationId: `tncc_${Effect.pipe('f', EffectString.repeat(40))}`}],
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
      buildTopicMaintenanceManifest(record(EffectArray.join(Array<string>(65).fill('Section.'), '\n\n')), {
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
    const content = Effect.pipe(
      source.content,
      EffectString.replace(/\n/gu, '\r\n'),
      EffectString.replace('\r\n\r\n', '\r\nopaque_header: keeps-byte-shape\r\n\r\n'),
    );
    const parsed = parseMemoryDocument(uri, content)!;
    const proposal = proposeTopicMaintenanceEnrollment(parsed, decisions());
    expect(proposal.content).toContain('opaque_header: keeps-byte-shape\r\n');
    expect(
      Effect.pipe(
        proposal.content,
        EffectString.slice(
          Effect.pipe(
            proposal.content,
            EffectString.indexOf('\r\n\r\n'),
            Effect.Option.getOrElse(() => -1),
          ) + 4,
        ),
      ),
    ).toBe(
      Effect.pipe(
        content,
        EffectString.slice(
          Effect.pipe(
            content,
            EffectString.indexOf('\r\n\r\n'),
            Effect.Option.getOrElse(() => -1),
          ) + 4,
        ),
      ),
    );
    expect(proposal.content).toContain('schema_version: 10\r\n');
  });

  it('rejects malformed and unsupported manifest headers before rewrite', () => {
    const content = proposeTopicMaintenanceEnrollment(record(), decisions()).content;
    const cases = [
      Effect.pipe(content, EffectString.replace(/^topic_maintenance: .*$/mu, 'topic_maintenance: {bad-json}')),
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
      content.replace(/^topic_maintenance: .*$/mu, line => `${line}\n${line}`),
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
      content.replace(/^topic_maintenance: .*$/mu, line => ` ${line}`),
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
      content.replace(/^topic_maintenance: .*$/mu, line => Effect.pipe(line, EffectString.replace(': ', ':  '))),
      Effect.pipe(content, EffectString.replace('schema_version: 10', 'schema_version: 8')),
      Effect.pipe(content, EffectString.replace('Same paragraph.', 'Edited paragraph.')),
      Effect.pipe(content, EffectString.replace('"version":1', '"version":2')),
    ];
    for (const malformed of cases) {
      expect(parseMemoryDocument(uri, malformed)?.metadata.topicMaintenanceError).toBeDefined();
      expect(parseMemoryDocument(uri, malformed)?.metadata.citationErrors).toContainEqual({reason: 'invalid-shape'});
      expect(() => assertMemoryDocumentSchemaWritable(malformed)).toThrow(/topic maintenance/i);
      expect(memoryCodeCitationContentSharingBlocker(uri, malformed)).toBe('malformed-citation');
    }
  });

  it('reads V1 schema 9 and validates V2 accepted comparison pins on schema 10', () => {
    const proposal = proposeTopicMaintenanceEnrollment(record(), decisions());
    const legacy = parseMemoryDocument(
      uri,
      Effect.pipe(proposal.content, EffectString.replace('schema_version: 10', 'schema_version: 9')),
    )!;
    expect(legacy.metadata.topicMaintenance?.version).toBe(1);
    expect(topicMaintenanceAcceptedCitation(legacy, citation.id)).toEqual(citation);
    const {id: _id, ...currentInput} = citation;
    const current = createMemoryCodeCitation({
      ...currentInput,
      fileContentHash: {algorithm: 'sha256', value: Effect.pipe('b', EffectString.repeat(64))},
      sourceCommit: Effect.pipe('5', EffectString.repeat(40)),
      sourceSnapshotId: `cgsn_${Effect.pipe('6', EffectString.repeat(40))}`,
    });
    const manifest = {
      ...proposal.manifest,
      version: 2 as const,
      originCitationIds: [citation.id],
      acceptedSources: [{citationId: citation.id, acceptedCitationId: current.id}],
    };
    const content = formatMemoryDocument(
      'MEMORY',
      {...legacy.metadata, schemaVersion: 10, codeCitations: [citation, current], topicMaintenance: manifest},
      legacy.body,
    );
    const accepted = parseMemoryDocument(uri, content)!;
    expect(accepted.metadata.topicMaintenance).toEqual(manifest);
    expect(topicMaintenanceAcceptedCitation(accepted, citation.id)).toEqual(current);
    for (const changed of [
      {...manifest, acceptedSources: []},
      {
        ...manifest,
        acceptedSources: [
          {...manifest.acceptedSources[0], acceptedCitationId: `tncc_${Effect.pipe('f', EffectString.repeat(40))}`},
        ],
      },
      {...manifest, acceptedSources: [{...manifest.acceptedSources[0], unknown: true}]},
    ])
      expect(() => validateTopicMaintenanceManifest(changed, accepted)).toThrow();
    const oldWriter = Effect.pipe(content, EffectString.replace('schema_version: 10', 'schema_version: 9'));
    expect(parseMemoryDocument(uri, oldWriter)?.metadata.topicMaintenanceError).toMatch(/V2.*schema version 10/);
    expect(() => assertMemoryDocumentSchemaWritable(oldWriter)).toThrow();
  });

  it('has deterministic round trips and invalidates any edited paragraph (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .string({minLength: 1, maxLength: 30})
            .filter(s => Effect.pipe(s, EffectString.trim).length > 0 && !Effect.pipe(s, EffectString.includes('\n'))),
          {minLength: 1, maxLength: 12},
        ),
        sections => {
          const source = record(EffectArray.join(sections, '\n\n'));
          const input = {
            paragraphs: EffectArray.map(sections, () => ({
              role: 'descriptive' as const,
              support: 'direct' as const,
              citationIds: [citation.id],
            })),
            additionalDependencies: [],
          };
          const first = buildTopicMaintenanceManifest(source, input);
          expect(buildTopicMaintenanceManifest(source, input)).toEqual(first);
          const content = proposeTopicMaintenanceEnrollment(source, input).content;
          const roundTripped = parseMemoryDocument(uri, content)?.metadata.topicMaintenance;
          expect(roundTripped).toEqual(first);
          expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(first));
          expect(() => validateTopicMaintenanceManifest(first, {...source, body: `${source.body}x`})).toThrow();
        },
      ),
      {numRuns: 40},
    );
  });
});
