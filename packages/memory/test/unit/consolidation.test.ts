import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  buildConsolidationProvenanceV2,
  captureConsolidationSource,
  reviewConsolidation,
  consolidationSections,
  validateConsolidationProvenanceV2,
  validateConsolidationV2ActiveEvidence,
} from '../../src/consolidation.js';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  inferMemoryMetadata,
  memoryArchiveBody,
  parseMemoryDocument,
} from '../../src/document.js';
import {createMemoryCodeCitation} from '../../src/code/citation.js';
import {migrateMemoryDocumentToCurrent} from '../../src/migrations.js';
import {consolidationRevision} from '../../src/consolidation.js';
import {createReviewedSupportSnapshot} from '../../src/reviewed-support.js';
import {automaticMaintenanceEvidenceId} from '../../src/automatic-maintenance.js';

const citation = (path: string) =>
  createMemoryCodeCitation({
    evidenceRetention: 'capsule-retained',
    extractorSet: 'test',
    fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
    path,
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: 'local',
    sourceCommit: 'a'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  });
const source = (body = 'Keep this claim.', citations = [citation('one.ts')]) =>
  captureConsolidationSource({
    uri: 'threadnote://user/test/memories/durable/global/source.md',
    content: formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        sourceAgentClient: 'test',
        timestamp: '2026-10-08T00:00:00Z',
        schemaVersion: 6,
        codeCitations: citations,
      },
      body,
    ),
  });
const review = (
  text: string,
  disposition: 'direct' | 'contextual' | 'unsupported' = 'direct',
  ids = [citation('one.ts').id],
) => ({
  section: text,
  disposition,
  supports:
    disposition === 'unsupported'
      ? []
      : [{sourceUri: source().uri, fragment: 0, citationIds: ids, relationIndexes: []}],
});
const options = {
  operationId: 'operation',
  cleanup: 'archive' as const,
  cleanupShared: false,
  target: {
    kind: 'durable' as const,
    status: 'active' as const,
    project: 'test',
    topic: 'result',
    sourceAgentClient: 'manager',
  },
};

describe('reviewed consolidation', () => {
  it('refuses to capture current approved support as historical root-only evidence', () => {
    const root = citation('old-limit.ts');
    const current = citation('current-limit.ts');
    const body = 'Current limit is 60.';
    const evidence = {kind: 'code' as const, citation: current};
    const id = automaticMaintenanceEvidenceId(evidence);
    const active = createReviewedSupportSnapshot({
      bodyHash: consolidationRevision(body),
      paragraphs: [
        {ordinal: 0, hash: consolidationRevision(body), role: 'descriptive', support: 'direct', evidenceIds: [id]},
      ],
      sources: [{id, source: evidence, scope: 'repository'}],
      acceptance: {
        reviewId: 'review-capture-provenance',
        approvedAt: '2026-10-21T00:00:00.000Z',
        targetBeforeHash: '1'.repeat(64),
        preparationDigest: '2'.repeat(64),
        sourceVectorDigest: '3'.repeat(64),
      },
    });
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        sourceAgentClient: 'test',
        timestamp: '2026-10-21T00:00:00.000Z',
        schemaVersion: 11,
        codeCitations: [root],
        reviewedSupport: {type: 'reviewed-memory-support', version: 1, active, initialApproval: active},
      },
      body,
    );
    const uri = source().uri;
    const parsed = parseMemoryDocument(uri, content)!;
    expect(parsed.metadata.reviewedSupportError).toBeUndefined();
    expect(parsed.metadata.codeCitations).toEqual([root]);
    expect(parsed.metadata.reviewedSupport?.active.sources[0].source).toEqual(evidence);
    expect(() => captureConsolidationSource({uri, content})).toThrow(/reviewed support.*cannot preserve/iu);
    const malformed = content.replace(/^reviewed_support: .*$/mu, 'reviewed_support: {not-json}');
    expect(parseMemoryDocument(uri, malformed)?.metadata.reviewedSupportError).toBeDefined();
    expect(() => captureConsolidationSource({uri, content: malformed})).toThrow();
    expect(captureConsolidationSource({uri, content: content.replace(/^reviewed_support: .*\n/mu, '')})).toMatchObject({
      fragments: [body],
      codeCitations: [root],
    });
  });

  it('preserves derivation through repeated archives without removing a reviewed archive paragraph', () => {
    const body = 'Archived original Threadnote memory.\n\nKeep this claim.';
    const reviewed = reviewConsolidation(
      body,
      [source()],
      [review('Archived original Threadnote memory.', 'unsupported'), review('Keep this claim.')],
      options,
    );
    const metadata = {
      kind: 'durable' as const,
      status: 'archived' as const,
      sourceAgentClient: 'test',
      timestamp: '2026-10-08T00:00:00Z',
      schemaVersion: 6,
      codeCitations: reviewed.codeCitations,
      relations: reviewed.relations,
      consolidation: reviewed.provenance,
    };
    const archived = formatMemoryDocument('MEMORY', metadata, memoryArchiveBody(memoryArchiveBody(body)));
    expect(parseMemoryDocument(source().uri, archived)?.metadata.consolidation).toEqual(reviewed.provenance);
  });
  it('rejects edited or removed claims with old support bindings', () => {
    expect(() => reviewConsolidation('Edited claim.', [source()], [review('Keep this claim.')], options)).toThrow(
      /review/i,
    );
    expect(() => reviewConsolidation('Keep this claim.', [source()], [], options)).toThrow(/review/i);
  });
  it('keeps only individually selected direct evidence; contextual support is derivation', () => {
    const sources = [source('Keep this claim.\n\nContext.', [citation('one.ts'), citation('two.ts')])];
    const result = reviewConsolidation(
      'Keep this claim.\n\nContext.',
      sources,
      [
        review('Keep this claim.'),
        {
          ...review('Context.', 'contextual', [citation('two.ts').id]),
          supports: [
            {sourceUri: sources[0].uri, fragment: 1, citationIds: [citation('two.ts').id], relationIndexes: []},
          ],
        },
      ],
      options,
    );
    expect(result.codeCitations?.map(c => c.path)).toEqual(['one.ts']);
    expect(result.provenance.reviews[1]?.disposition).toBe('contextual');
  });
  it('blocks explicit nine-citation overflow rather than truncating', () => {
    const first = source(
      'First.',
      Array.from({length: 8}, (_, i) => citation(`${i}.ts`)),
    );
    const second = {...source('Second.', [citation('ninth.ts')]), uri: first.uri.replace('source.md', 'second.md')};
    const reviews = [first, second].map(s => ({
      section: s.fragments[0],
      disposition: 'direct' as const,
      supports: [{sourceUri: s.uri, fragment: 0, citationIds: s.codeCitations.map(c => c.id), relationIndexes: []}],
    }));
    expect(() => reviewConsolidation('First.\n\nSecond.', [first, second], reviews, options)).toThrow(/9.*8/);
  });
  it('fails closed on malformed source evidence and stale persisted body bindings', () => {
    expect(() =>
      captureConsolidationSource({
        uri: source().uri,
        content: 'MEMORY\nkind: durable\nschema_version: 6\ncode_citation: garbage\n\nClaim.',
      }),
    ).toThrow();
    const result = reviewConsolidation('Keep this claim.', [source()], [review('Keep this claim.')], options);
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        sourceAgentClient: 'test',
        timestamp: '2026-10-08T00:00:00Z',
        schemaVersion: 6,
        consolidation: result.provenance,
        codeCitations: result.codeCitations,
      },
      'Keep this claim.',
    );
    expect(parseMemoryDocument(source().uri, content)?.metadata.consolidation).toEqual(result.provenance);
    const schema8 = content.replace('schema_version: 6', 'schema_version: 8');
    const schema10 = migrateMemoryDocumentToCurrent(schema8);
    expect(schema10).toBe(schema8.replace('schema_version: 8', 'schema_version: 10'));
    expect(parseMemoryDocument(source().uri, schema10)?.metadata.consolidation).toEqual(result.provenance);
    expect(
      parseMemoryDocument(source().uri, content.replace(/Keep this claim\.$/, 'Changed.'))?.metadata.citationErrors
        ?.length,
    ).toBeGreaterThan(0);
    expect(inferMemoryMetadata(content).consolidation).toEqual(result.provenance);
    for (const header of [
      'consolidation:',
      ' consolidation: {}',
      'consolidation: {"version":2}',
      `consolidation: ${JSON.stringify(result.provenance)}\nconsolidation:`,
    ]) {
      const malformed = content.replace(/^consolidation:.*$/mu, header);
      expect(parseMemoryDocument(source().uri, malformed)?.metadata.consolidationError).toBeDefined();
      expect(() => assertMemoryDocumentSchemaWritable(malformed)).toThrow();
    }
  });
  it('keeps immutable V1 note provenance while binding changed claim support to current code', () => {
    const originalBody = 'Keep this claim.';
    const body = 'Updated code claim.';
    const original = reviewConsolidation(originalBody, [source()], [review(originalBody)], options);
    const current = citation('new.ts');
    const manifest = {
      version: 2 as const,
      memoryId: 'tn_topic_fixture',
      repositoryId: current.repositoryId,
      bodyHash: consolidationRevision(body),
      coverage: 'declared-only' as const,
      paragraphs: [
        {
          ordinal: 0,
          hash: consolidationRevision(body),
          role: 'descriptive' as const,
          support: 'direct' as const,
          citationIds: [current.id],
        },
      ],
      additionalDependencies: [],
      originCitationIds: [original.codeCitations[0].id],
      acceptedSources: [{citationId: current.id, acceptedCitationId: current.id}],
    };
    const receipt = buildConsolidationProvenanceV2(original.provenance, originalBody, body, manifest, {
      reviewId: 'review-one',
      targetBeforeHash: '1'.repeat(64),
      packetDigest: '2'.repeat(64),
      observationRevision: '3'.repeat(64),
    });
    expect(validateConsolidationProvenanceV2(receipt, body)).toEqual(receipt);
    expect(receipt.origin).toEqual(original.provenance);
    expect(receipt.acceptance.paragraphs[0]).toMatchObject({evidence: 'reviewed-current', citationIds: [current.id]});
    validateConsolidationV2ActiveEvidence(receipt, manifest, [...original.codeCitations, current], []);
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        sourceAgentClient: 'test',
        timestamp: '2026-10-08T00:00:00Z',
        schemaVersion: 10,
        memoryId: manifest.memoryId,
        project: 'test',
        topic: 'result',
        codeCitations: [...original.codeCitations, current],
        consolidation: receipt,
        topicMaintenance: manifest,
      },
      body,
    );
    const parsed = parseMemoryDocument(source().uri, content)!;
    expect(parsed.metadata.consolidation).toEqual(receipt);
    expect(parsed.metadata.topicMaintenance).toEqual(manifest);
    expect(parsed.metadata.citationErrors).toBeUndefined();
    expect(() => validateConsolidationV2ActiveEvidence(receipt, manifest, original.codeCitations, [])).toThrow();
    expect(() => validateConsolidationProvenanceV2(receipt, 'Different.')).toThrow();
    expect(() => validateConsolidationProvenanceV2({...receipt, originBody: 'Forged.'}, body)).toThrow();
  });
  it('retains only exact final sections and round trips bounded arbitrary unsupported prose', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,24}$/), {minLength: 1, maxLength: 12}), paragraphs => {
        const body = paragraphs.join('\n\n');
        const reviews = consolidationSections(body).map(section => ({
          section,
          disposition: 'unsupported' as const,
          supports: [],
        }));
        const result = reviewConsolidation(body, [source()], reviews, options);
        expect(result.codeCitations).toEqual([]);
        expect(result.provenance.reviews.map(r => r.section)).toEqual(paragraphs);
        const metadata = {
          kind: 'durable' as const,
          status: 'active' as const,
          sourceAgentClient: 'test',
          timestamp: '2026-10-08T00:00:00Z',
          schemaVersion: 6,
          consolidation: result.provenance,
        };
        expect(
          parseMemoryDocument(source().uri, formatMemoryDocument('MEMORY', metadata, body))?.metadata.consolidation,
        ).toEqual(result.provenance);
      }),
      {numRuns: 40},
    );
  });
  it('preserves exactly the independently selected evidence for retained direct paragraphs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), {minLength: 3, maxLength: 3}).filter(retained => retained.some(Boolean)),
        fc.array(fc.boolean(), {minLength: 3, maxLength: 3}),
        fc.array(fc.uniqueArray(fc.integer({min: 0, max: 7}), {maxLength: 8}), {minLength: 3, maxLength: 3}),
        (retained, direct, slots) => {
          const citations = Array.from({length: 8}, (_, i) => citation(`source-${i}.ts`));
          const paragraphs = ['First.', 'Second.', 'Third.'];
          const captured = source(paragraphs.join('\n\n'), citations);
          const reviews = paragraphs.flatMap((section, index) =>
            retained[index]
              ? [
                  {
                    section,
                    disposition: direct[index] ? ('direct' as const) : ('unsupported' as const),
                    supports: direct[index]
                      ? [
                          {
                            sourceUri: captured.uri,
                            fragment: index,
                            citationIds: slots[index].map(i => citations[i].id),
                            relationIndexes: [],
                          },
                        ]
                      : [],
                  },
                ]
              : [],
          );
          const body = paragraphs.filter((_, i) => retained[i]).join('\n\n');
          const expected = new Set(
            slots.flatMap((ids, i) => (retained[i] && direct[i] ? ids.map(id => citations[id].id) : [])),
          );
          const result = reviewConsolidation(body, [captured], reviews, options);
          expect(new Set(result.codeCitations.map(c => c.id))).toEqual(expected);
          expect(reviewConsolidation(body, [captured], reviews, options)).toEqual(result);
        },
      ),
      {numRuns: 40},
    );
  });
});
