import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {createMemoryCodeCitation} from '../../src/code/citation.js';
import {formatMemoryDocument, parseMemoryDocument} from '../../src/document.js';
import {proposeTopicMaintenanceEnrollment} from '../../src/topic-maintenance.js';
import {
  buildConsolidationProvenanceV2,
  captureConsolidationSource,
  consolidationSections,
  reviewConsolidation,
} from '../../src/consolidation.js';
import {parseCandidateReview} from '../../src/candidate.js';
import * as oldReview from '../fixtures/candidate-v2-reader.mjs';
import * as oldWriter from '../fixtures/schema10-writer.mjs';
import {
  prepareTopicDependencyExpansion,
  restartTopicDependencyExpansionPreview,
  validateTopicDependencyExpansionJournal,
  topicExpansionDigest,
  topicDependencyExpansionChoices,
  validateTopicDependencyExpansionPreview,
  type TopicDependencyExpansionProof,
  type TopicDependencyExpansionRequest,
} from '../../src/topic-maintenance-expansion.js';

const uri = 'threadnote://user/tester/memories/durable/projects/fixture/topic.md';
const seed = `cgs_${'1'.repeat(32)}`;
const endpoint = `cgs_${'2'.repeat(32)}`;
const body =
  'The implementation uses a request limit.\n\nChanging the limit requires explicit approval.\n\nHistorically the limit was smaller.';
function citation(path: string, index = 1) {
  return createMemoryCodeCitation({
    version: 1,
    repositoryId: 'a'.repeat(64),
    repositoryIdentityKind: 'local',
    sourceCommit: 'b'.repeat(40),
    sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
    sourceGraphContentId: `cgc_${'d'.repeat(40)}`,
    sourceDirty: false,
    extractorSet: 'fixture-extractor',
    fileContentHash: {algorithm: 'sha256', value: index.toString(16).repeat(64)},
    path,
    target: {kind: 'file'},
    evidenceRetention: 'capsule-retained',
  });
}
function fixture(extra = 0) {
  const original = citation('src/main.ts');
  const record = parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        project: 'fixture',
        topic: 'limit',
        memoryId: 'tn_expansion_fixture',
        sourceAgentClient: 'test',
        schemaVersion: 10,
        timestamp: '2026-10-18T00:00:00.000Z',
        codeCitations: [original, ...Array.from({length: extra}, (_, i) => citation(`src/extra-${i}.ts`))],
      },
      body,
    ).replace('\n\n', '\nopaque_header: retain exactly\n\n'),
  )!;
  const enrolled = proposeTopicMaintenanceEnrollment(record, {
    paragraphs: (['descriptive', 'normative', 'historical'] as const).map(role => ({
      role,
      support: 'direct',
      citationIds: [original.id],
      scope: 'Only the declared topic',
    })),
  });
  return parseMemoryDocument(uri, enrolled.content)!;
}
function input(): TopicDependencyExpansionRequest {
  return {
    version: 1,
    depth: 1,
    project: 'fixture',
    root: '/fixture',
    configDigest: 'e'.repeat(64),
    seeds: [seed],
    direction: 'outgoing',
    kinds: ['imports'],
    provenances: ['declared', 'resolved'],
    minConfidence: 1,
    nodeLimit: 8,
    edgeLimit: 16,
    selectedNodeIds: [endpoint],
    configurationPaths: [],
  };
}
function proof(): TopicDependencyExpansionProof {
  return {
    version: 1,
    repositoryId: 'a'.repeat(64),
    worktreeId: 'fixture-worktree',
    sourceCommit: 'b'.repeat(40),
    sourceFenceDigest: 'f'.repeat(64),
    project: 'fixture',
    root: '/fixture',
    configDigest: 'e'.repeat(64),
    snapshot: {
      id: `cgsn_${'c'.repeat(40)}`,
      commit: 'b'.repeat(40),
      graphContentId: `cgc_${'d'.repeat(40)}`,
      extractorSet: 'fixture-extractor',
    },
    profileDigest: 'a'.repeat(64),
    scopeDigest: 'b'.repeat(64),
    scopeReceiptJson: '{"kind":"full-repository"}',
    completeProject: true,
    reads: [
      {
        seedId: seed,
        nodes: [
          {id: seed, path: 'src/main.ts', contentHash: '1'.repeat(64)},
          {id: endpoint, path: 'src/dependency.ts', contentHash: '2'.repeat(64)},
        ],
        edges: [
          {
            id: 'edge-import',
            sourceId: seed,
            targetId: endpoint,
            kind: 'imports',
            provenance: 'resolved',
            confidence: 1,
          },
        ],
        coverage: {
          status: 'exhaustive',
          limitsReached: [],
          requestedDepth: 1,
          completedDepth: 1,
          direction: 'outgoing',
          nodeLimit: 8,
          edgeLimit: 16,
          allowedProvenances: ['declared', 'resolved', 'syntactic'],
          omittedNodes: 0,
          missingNodes: 0,
          unresolvedEdges: 0,
          visitedNodes: 2,
          inspectedEdges: 1,
        },
      },
    ],
  };
}
const additions = () => [{kind: 'dependency' as const, ref: endpoint, citation: citation('src/dependency.ts', 2)}];

describe('explicit code dependency extension', () => {
  it('admits an exactly full proved neighborhood and refuses exceeded, partial, foreign and disallowed scope', () => {
    const p = proof();
    const request = {...input(), nodeLimit: 2, edgeLimit: 1};
    const exact = {...p, reads: [{...p.reads[0], coverage: {...p.reads[0].coverage, nodeLimit: 2, edgeLimit: 1}}]};
    expect(prepareTopicDependencyExpansion(fixture(), '/fixture', request, exact, additions()).additions).toHaveLength(
      1,
    );
    for (const invalid of [
      {...exact, completeProject: false},
      {...exact, repositoryId: '0'.repeat(64)},
      {...exact, reads: [{...exact.reads[0], coverage: {...exact.reads[0].coverage, limitsReached: ['edge-limit']}}]},
      {...exact, reads: [{...exact.reads[0], coverage: {...exact.reads[0].coverage, nodeLimit: 1}}]},
      {...exact, reads: [{...exact.reads[0], edges: exact.reads[0].edges.map(edge => ({...edge, confidence: 0}))}]},
    ]) {
      const record = fixture();
      const bytes = record.content;
      expect(() => prepareTopicDependencyExpansion(record, '/fixture', request, invalid, additions())).toThrow();
      expect(record.content).toBe(bytes);
    }
    expect(() =>
      prepareTopicDependencyExpansion(fixture(), '/fixture', {...request, kinds: ['calls']}, exact, additions()),
    ).toThrow(/lacks an admitted/u);
    expect(() =>
      prepareTopicDependencyExpansion(fixture(), '/fixture', {...request, depth: 2}, exact, additions()),
    ).toThrow();
  });
  it('reports real self-loops, seed cycles and repeated endpoint prunes without granting second-hop authority', () => {
    const base = proof();
    const read = base.reads[0];
    const request = {...input(), selectedNodeIds: []};
    const self = {...read.edges[0], id: 'self-loop', targetId: seed};
    const repeated = {...read.edges[0], id: 'same-endpoint'};
    const p = {
      ...base,
      reads: [{...read, edges: [...read.edges, self, repeated], coverage: {...read.coverage, inspectedEdges: 3}}],
    };
    expect(topicDependencyExpansionChoices(request, p).omissions).toEqual(
      expect.arrayContaining([
        {kind: 'self-loop', id: 'self-loop'},
        {kind: 'duplicate', id: endpoint},
        {kind: 'unselected', id: endpoint},
      ]),
    );
    const cycleRequest = {...request, seeds: [seed, endpoint].sort()};
    const cycleProof = {...base, reads: [read, {...read, seedId: endpoint}]};
    expect(topicDependencyExpansionChoices(cycleRequest, cycleProof).omissions).toContainEqual({
      kind: 'cycle',
      id: 'edge-import',
    });
    const second = `cgs_${'3'.repeat(32)}`;
    expect(() =>
      prepareTopicDependencyExpansion(fixture(), '/fixture', {...request, selectedNodeIds: [second]}, p, [
        {kind: 'dependency', ref: second, citation: citation('src/dependency.ts', 2)},
      ]),
    ).toThrow(/lacks an admitted/u);
  });
  it('sorts distinct explicit configuration selections independently of request/transport order', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.integer({min: 0, max: 9}), (reverse, suffix) => {
        const paths = [`config-${suffix}-a.json`, `config-${suffix}-b.json`];
        const request = {
          ...input(),
          seeds: [],
          selectedNodeIds: [],
          configurationPaths: reverse ? [...paths].reverse() : paths,
        };
        const p = {...proof(), reads: []};
        const selected = paths.map((ref, index) => ({
          kind: 'configuration' as const,
          ref,
          citation: citation(ref, index + 3),
        }));
        const actual = prepareTopicDependencyExpansion(
          fixture(),
          '/fixture',
          request,
          p,
          reverse ? [...selected].reverse() : selected,
        );
        const expected = prepareTopicDependencyExpansion(
          fixture(),
          '/fixture',
          {...request, configurationPaths: paths},
          p,
          selected,
        );
        expect(actual.approvalDigest).toBe(expected.approvalDigest);
        expect(actual.content).toBe(expected.content);
        expect(new Set(actual.manifest.additionalDependencies.map(item => item.citationId))).toEqual(
          new Set(selected.map(item => item.citation.id)),
        );
      }),
      {numRuns: 24},
    );
  });
  it.each([1, 2] as const)(
    'preserves consolidation V%s original source/relations/body and paragraph derivation',
    version => {
      const record = fixture();
      const captured = captureConsolidationSource({
        uri: 'threadnote://user/tester/memories/durable/projects/fixture/source.md',
        content: formatMemoryDocument(
          'MEMORY',
          {
            ...record.metadata,
            topicMaintenance: undefined,
            relations: [{type: 'references', uri: 'threadnote://memory/tn_related_fixture'}],
          },
          body,
        ),
      });
      const reviewed = reviewConsolidation(
        body,
        [captured],
        consolidationSections(body).map((section, index) => ({
          section,
          disposition: 'direct',
          supports: [
            {
              sourceUri: captured.uri,
              fragment: index,
              citationIds: [record.metadata.codeCitations![0].id],
              relationIndexes: [0],
            },
          ],
        })),
        {
          operationId: 'fixture-origin',
          cleanup: 'keep',
          cleanupShared: false,
          target: {kind: 'durable', status: 'active', project: 'fixture', topic: 'limit', sourceAgentClient: 'test'},
        },
      );
      const old = record.metadata.topicMaintenance!;
      if (old.version !== 1) throw new Error('Expected V1 fixture');
      const manifest = {
        ...old,
        version: 2 as const,
        originCitationIds: record.metadata.codeCitations!.map(c => c.id).sort(),
        acceptedSources: [
          {citationId: record.metadata.codeCitations![0].id, acceptedCitationId: record.metadata.codeCitations![0].id},
        ],
      };
      const consolidation =
        version === 1
          ? reviewed.provenance
          : buildConsolidationProvenanceV2(reviewed.provenance, body, body, manifest, {
              reviewId: 'review-origin',
              targetBeforeHash: '1'.repeat(64),
              packetDigest: '2'.repeat(64),
              observationRevision: '3'.repeat(64),
            });
      const consolidated = parseMemoryDocument(
        uri,
        formatMemoryDocument(
          'MEMORY',
          {...record.metadata, topicMaintenance: manifest, consolidation, relations: reviewed.relations},
          body,
        ),
      )!;
      expect(consolidated.metadata.consolidationError).toBeUndefined();
      const preview = prepareTopicDependencyExpansion(consolidated, '/fixture', input(), proof(), additions());
      const parsed = parseMemoryDocument(uri, preview.content)!;
      expect(parsed.metadata.consolidationError).toBeUndefined();
      expect(parsed.metadata.relations).toEqual(reviewed.relations);
      expect(parsed.body).toBe(body);
      const receipt = parsed.metadata.consolidation;
      if (receipt?.version !== 2) throw new Error('Expected validated active-vector receipt');
      expect(receipt.origin).toEqual(reviewed.provenance);
      expect(receipt.originBody).toBe(body);
      if (version === 2) expect(receipt).toEqual(consolidation);
      expect(receipt.acceptance.paragraphs.map(p => p.citationIds)).toEqual(
        record.metadata.topicMaintenance!.paragraphs.map(p => p.citationIds),
      );
    },
  );
  it('preserves exact body, raw origin bytes, protected support and lineage while upgrading V1 to code V3', () => {
    const record = fixture();
    const before = record.content;
    const preview = prepareTopicDependencyExpansion(record, '/fixture', input(), proof(), additions());
    const parsed = parseMemoryDocument(uri, preview.content)!;
    expect(parsed.body).toBe(body);
    expect(parsed.metadata.topicMaintenanceError).toBeUndefined();
    expect(preview.manifest.paragraphs).toEqual(record.metadata.topicMaintenance!.paragraphs);
    expect(preview.manifest.originCitationIds).toEqual(record.metadata.codeCitations!.map(c => c.id).sort());
    for (const line of before
      .split('\n')
      .filter(line => line.startsWith('code_citation:') || line.startsWith('opaque_header:')))
      expect(preview.content.split('\n')).toContain(line);
    expect(preview.manifest.acceptedSources).toContainEqual({
      citationId: record.metadata.codeCitations![0].id,
      acceptedCitationId: record.metadata.codeCitations![0].id,
    });
    expect(preview.manifest.additionalDependencies).toEqual([
      {kind: 'dependency', citationId: additions()[0].citation.id},
    ]);
    expect(validateTopicDependencyExpansionPreview(JSON.parse(JSON.stringify(preview)))).toEqual(preview);
    expect(record.content).toBe(before);
    expect(() => oldWriter.assertMemoryDocumentSchemaWritable(preview.content)).toThrow();
    expect(() => oldWriter.formatMemoryDocumentWithKeywords(preview.content, ['changed'])).toThrow();
  });
  it('retains prior accepted V2 mappings and old origins exactly', () => {
    const record = fixture();
    const old = record.metadata.topicMaintenance!;
    if (old.version !== 1) throw new Error('Expected V1 fixture');
    const oldCitation = record.metadata.codeCitations![0];
    const accepted = citation('src/main.ts', 3);
    const manifest = {
      ...old,
      version: 2 as const,
      originCitationIds: [oldCitation.id],
      acceptedSources: [{citationId: oldCitation.id, acceptedCitationId: accepted.id}],
    };
    const v2 = parseMemoryDocument(
      uri,
      formatMemoryDocument(
        'MEMORY',
        {...record.metadata, codeCitations: [oldCitation, accepted], topicMaintenance: manifest},
        body,
      ),
    )!;
    const preview = prepareTopicDependencyExpansion(v2, '/fixture', input(), proof(), additions());
    expect(preview.manifest.originCitationIds).toEqual(manifest.originCitationIds);
    expect(preview.manifest.acceptedSources.find(m => m.citationId === oldCitation.id)).toEqual(
      manifest.acceptedSources[0],
    );
    expect(parseMemoryDocument(uri, preview.content)!.metadata.codeCitations).toEqual([
      ...v2.metadata.codeCitations!,
      additions()[0].citation,
    ]);
  });
  it('uses a closed V4 write-ahead journal which the actual frozen old parser refuses', () => {
    const preview = prepareTopicDependencyExpansion(fixture(), '/fixture', input(), proof(), additions());
    const review = {
      version: 4,
      reviewId: `review-${preview.revision.slice(0, 24)}`,
      revision: 1,
      createdAt: '2026-10-18T00:00:00.000Z',
      project: 'fixture',
      topic: 'limit',
      task: 'Expansion',
      outcome: 'Metadata only',
      sourceAgentClient: 'test',
      auditEvents: [],
      candidates: [],
      codeCitations: [],
      dependencyExpansion: {version: 1, stage: 'prepared', preview},
    };
    expect(parseCandidateReview(review)).toEqual(review);
    expect(() => oldReview.parseCandidateReview(review)).toThrow();
    expect(() => parseCandidateReview({...review, version: 2})).toThrow();
    expect(() => parseCandidateReview({...review, unknownField: true})).toThrow();
    expect(() => parseCandidateReview({...review, createdAt: 'not-a-fixed-time'})).toThrow();
    expect(() => parseCandidateReview({...review, dependencyExpansion: undefined})).toThrow();
    expect(() => parseCandidateReview({...review, candidates: [{}]})).toThrow();
  });
  it('deterministically binds each explicit successor identity without changing protected authority', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.uuid({version: 4}), {minLength: 2, maxLength: 2}), identities => {
        const record = fixture();
        const old = prepareTopicDependencyExpansion(record, '/fixture', input(), proof(), additions());
        const operation = (id: string) => ({
          id,
          generation: 1,
          predecessorRevision: old.revision,
          predecessorApprovalDigest: old.approvalDigest,
        });
        const first = restartTopicDependencyExpansionPreview(old, operation(identities[0]));
        const replay = restartTopicDependencyExpansionPreview(old, operation(identities[0]));
        const second = restartTopicDependencyExpansionPreview(old, operation(identities[1]));
        expect(replay).toEqual(first);
        expect(first.revision).not.toBe(second.revision);
        expect(first.approvalDigest).not.toBe(second.approvalDigest);
        for (const fresh of [first, second]) {
          expect(fresh.approvalDigest).not.toBe(old.approvalDigest);
          const parsed = parseMemoryDocument(uri, fresh.content)!;
          expect(parsed.body).toBe(record.body);
          expect(parsed.metadata.codeCitations).toContainEqual(record.metadata.codeCitations![0]);
          expect(fresh.manifest.originCitationIds).toEqual(old.manifest.originCitationIds);
          expect(fresh.manifest.paragraphs).toEqual(old.manifest.paragraphs);
          expect(fresh.manifest.acceptedSources).toEqual(old.manifest.acceptedSources);
        }
        expect(record.content).toBe(old.beforeContent);
      }),
      {numRuns: 16},
    );
  });
  it('binds explicit restart identities, preserves every original byte, and bounds receipt lineage', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 8}), count => {
        const record = fixture();
        let prior = prepareTopicDependencyExpansion(record, '/fixture', input(), proof(), additions());
        const initial = prior;
        for (let generation = 1; generation <= count; generation++) {
          const frozen = JSON.stringify(prior);
          const operation = {
            id: `00000000-0000-4000-8000-${generation.toString().padStart(12, '0')}`,
            generation,
            predecessorRevision: prior.revision,
            predecessorApprovalDigest: prior.approvalDigest,
          };
          const next = restartTopicDependencyExpansionPreview(prior, operation);
          expect(next.revision).not.toBe(prior.revision);
          expect(next.approvalDigest).not.toBe(prior.approvalDigest);
          expect(next.beforeContent).toBe(initial.beforeContent);
          expect(parseMemoryDocument(uri, next.content)!.body).toBe(body);
          expect(next.additions).toEqual(initial.additions);
          expect(next.manifest.paragraphs).toEqual(initial.manifest.paragraphs);
          expect(next.manifest.dependencyExpansions).toHaveLength(1);
          expect(validateTopicDependencyExpansionPreview(next)).toEqual(next);
          const journal = {
            version: 1,
            stage: 'superseded',
            preview: prior,
            successor: {
              operation,
              revision: next.revision,
              approvalDigest: next.approvalDigest,
              createdAt: '2026-10-18T00:00:00.000Z',
            },
          };
          expect(validateTopicDependencyExpansionJournal(journal)).toEqual(journal);
          expect(() => validateTopicDependencyExpansionJournal({...journal, stage: 'prepared'})).toThrow();
          expect(() =>
            restartTopicDependencyExpansionPreview(prior, {...operation, predecessorRevision: '0'.repeat(64)}),
          ).toThrow();
          expect(JSON.stringify(prior)).toBe(frozen);
          prior = next;
        }
        if (count === 8)
          expect(() =>
            restartTopicDependencyExpansionPreview(prior, {
              id: '00000000-0000-4000-8000-000000000009',
              generation: 9,
              predecessorRevision: prior.revision,
              predecessorApprovalDigest: prior.approvalDigest,
            }),
          ).toThrow();
        expect(record.content).toBe(initial.beforeContent);
      }),
      {numRuns: 16},
    );
  });
  it('counts retained origins and accepted sources in the eight-citation capacity', () => {
    expect(() => prepareTopicDependencyExpansion(fixture(7), '/fixture', input(), proof(), additions())).toThrow(
      /eight/u,
    );
    expect(
      parseMemoryDocument(
        uri,
        prepareTopicDependencyExpansion(fixture(6), '/fixture', input(), proof(), additions()).content,
      )!.metadata.codeCitations,
    ).toHaveLength(8);
  });
  it('labels exact configuration selections independently without inventing graph edges', () => {
    const request = {...input(), seeds: [], selectedNodeIds: [], configurationPaths: ['config.json']};
    const p = {...proof(), reads: []};
    const preview = prepareTopicDependencyExpansion(fixture(), '/fixture', request, p, [
      {kind: 'configuration', ref: 'config.json', citation: citation('config.json', 4)},
    ]);
    expect(preview.manifest.additionalDependencies).toEqual([
      {kind: 'configuration', citationId: citation('config.json', 4).id},
    ]);
    expect(preview.proof.reads).toEqual([]);
    expect(() =>
      prepareTopicDependencyExpansion(fixture(), '/fixture', {...request, configurationPaths: []}, p, []),
    ).toThrow(/at least one/u);
  });
  it.each(['syntactic', 'heuristic', 'model'] as const)(
    'never lets %s suggestions authorize an endpoint',
    provenance => {
      const p = proof();
      const request = {
        ...input(),
        provenances: ['declared', 'resolved', provenance] as TopicDependencyExpansionRequest['provenances'],
      };
      const read = {
        ...p.reads[0],
        edges: p.reads[0].edges.map(edge => ({...edge, provenance})),
        coverage: {
          ...p.reads[0].coverage,
          allowedProvenances: [...new Set([...p.reads[0].coverage.allowedProvenances, provenance])],
        },
      };
      expect(() =>
        prepareTopicDependencyExpansion(fixture(), '/fixture', request, {...p, reads: [read]}, additions()),
      ).toThrow(/lacks an admitted/u);
    },
  );
  it('refuses missing endpoints, incoming/outgoing mismatch, unknown fields and tampered approved bytes', () => {
    const record = fixture();
    const p = proof();
    const preview = prepareTopicDependencyExpansion(record, '/fixture', input(), p, additions());
    expect(() =>
      prepareTopicDependencyExpansion(
        record,
        '/fixture',
        input(),
        {...p, reads: [{...p.reads[0], nodes: p.reads[0].nodes.slice(0, 1)}]},
        additions(),
      ),
    ).toThrow();
    expect(() =>
      prepareTopicDependencyExpansion(record, '/fixture', {...input(), direction: 'incoming'}, p, additions()),
    ).toThrow();
    expect(() =>
      prepareTopicDependencyExpansion(record, '/fixture', {...input(), sourceKind: 'code'}, p, additions()),
    ).toThrow();
    expect(() => validateTopicDependencyExpansionPreview({...preview, content: preview.content + 'changed'})).toThrow();
    expect(() =>
      prepareTopicDependencyExpansion(
        record,
        '/fixture',
        {...input(), configurationPaths: ['../outside']},
        p,
        additions(),
      ),
    ).toThrow();
  });
  it('is deterministic under duplicate/permuted explicit selections and monotonically preserves accepted bytes', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(endpoint), {minLength: 1, maxLength: 8}), fc.boolean(), (ids, reversed) => {
        const record = fixture();
        const request = {...input(), selectedNodeIds: reversed ? [...ids].reverse() : ids};
        const one = prepareTopicDependencyExpansion(record, '/fixture', request, proof(), additions());
        const expected = prepareTopicDependencyExpansion(record, '/fixture', input(), proof(), additions());
        expect(one.approvalDigest).toBe(expected.approvalDigest);
        expect(one.content).toBe(expected.content);
        expect(one.manifest.paragraphs).toEqual(record.metadata.topicMaintenance!.paragraphs);
        expect(one.content.slice(one.content.indexOf('\n\n'))).toBe(
          record.content.slice(record.content.indexOf('\n\n')),
        );
        for (const old of record.metadata.codeCitations!)
          expect(parseMemoryDocument(uri, one.content)!.metadata.codeCitations).toContainEqual(old);
      }),
      {numRuns: 32},
    );
  });
  it('never admits incomplete/partial proof and rejected transitions preserve the independent original bytes', () => {
    fc.assert(
      fc.property(fc.constantFrom('bounded', 'timed-out', 'unresolved', 'missing'), status => {
        const record = fixture();
        const bytes = record.content;
        const p = proof();
        const incomplete =
          status === 'missing'
            ? {...p, reads: []}
            : {...p, reads: [{...p.reads[0], coverage: {...p.reads[0].coverage, status}}]};
        expect(() => prepareTopicDependencyExpansion(record, '/fixture', input(), incomplete, additions())).toThrow();
        expect(record.content).toBe(bytes);
      }),
      {numRuns: 24},
    );
  });
  it('binds same-code project/config changes and refuses counterfeit proof digests', () => {
    const record = fixture();
    const preview = prepareTopicDependencyExpansion(record, '/fixture', input(), proof(), additions());
    expect(() =>
      prepareTopicDependencyExpansion(
        record,
        '/fixture',
        input(),
        {...proof(), configDigest: '1'.repeat(64)},
        additions(),
      ),
    ).toThrow();
    expect(() =>
      validateTopicDependencyExpansionPreview({...preview, proofDigest: topicExpansionDigest('fake')}),
    ).toThrow();
  });
});
