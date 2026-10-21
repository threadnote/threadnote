import {
  createReviewedSupportSnapshot,
  currentMemoryCodeCitations,
  reviewedMemorySupportDigest,
} from '@threadnote/memory/reviewed-support';
import {consolidationRevision} from '@threadnote/memory/consolidation';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertMemoryMaintenanceFragmentSource,
  memoryMaintenanceFragmentSource,
  prepareMemoryMaintenanceBasis,
} from '../../src/memory_maintenance.js';
import {
  assertAutomaticMaintenanceTarget,
  assertAutomaticMaintenanceAssessment,
  automaticMaintenanceEvidenceId,
  automaticMaintenanceSourceIdentity,
  MAX_AUTOMATIC_MAINTENANCE_BYTES,
  MAX_AUTOMATIC_MAINTENANCE_V2_BYTES,
  encodeAutomaticMaintenanceAssessment,
  parseAutomaticMaintenanceAssessment,
  projectShareableAutomaticMaintenanceAssessment,
  type AutomaticMaintenanceEvidenceV1,
} from '@threadnote/memory/automatic-maintenance';
import {createMemoryCodeCitation, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryObsidianEvidenceV1,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {
  buildTopicMaintenanceManifest,
  buildTopicMaintenanceObsidianManifest,
  topicMaintenanceObsidianCitationId,
  type TopicMaintenanceManifest,
} from '@threadnote/memory/topic-maintenance';
import type {MemoryKind} from '@threadnote/memory/types';
import {buildContextHealthReport} from '../../src/health.js';
import {contextHealthCitationCaseSlotV2, contextHealthCitationCoverageV2} from '../../src/health_maintenance.js';
import type {ContextBriefCitationValidationReceiptV2} from '../../src/types.js';

const uri = 'threadnote://user/test/memories/durable/projects/threadnote/target.md';
const origin = createMemoryCodeCitation({
  version: 1,
  evidenceRetention: 'capsule-retained',
  extractorSet: 'native-code-graph-13',
  fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
  path: 'packages/memory/src/document.ts',
  repositoryId: 'b'.repeat(64),
  repositoryIdentityKind: 'remote',
  sourceCommit: 'c'.repeat(40),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
  target: {kind: 'file'},
});
const {id: _originId, ...originInput} = origin;
const accepted = createMemoryCodeCitation({
  ...originInput,
  fileContentHash: {algorithm: 'sha256', value: 'e'.repeat(64)},
  sourceCommit: 'f'.repeat(40),
});
function record(
  body = 'Same paragraph.\n\nSame paragraph.\n\nPolicy is protected.',
  metadata: Partial<MemoryMetadata> = {},
  targetUri = uri,
): MemoryRecord {
  return parseMemoryDocument(
    targetUri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        memoryId: 'tn_target',
        status: 'active',
        schemaVersion: 10,
        sourceAgentClient: 'test',
        timestamp: '2026-10-21T00:00:00.000Z',
        ...metadata,
      },
      body,
    ),
  )!;
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function currentEvidence(
  sourceRecord = record('Current source claim.', {memoryId: 'tn_support'}, uri.replace('target.md', 'support.md')),
): AutomaticMaintenanceEvidenceV1 {
  const source = memoryMaintenanceFragmentSource(sourceRecord, 0);
  return {
    id: automaticMaintenanceEvidenceId(source),
    source,
    scope: 'personal',
    authority: 'provisional',
    availability: 'available',
  };
}
function legacyCode(version: 1 | 2 | 3): MemoryRecord {
  const initial = record(undefined, {codeCitations: [origin, accepted]});
  const v1 = buildTopicMaintenanceManifest(initial, {
    paragraphs: [
      {
        role: 'descriptive',
        support: 'direct',
        citationIds: [origin.id],
        scope: 'Configured project.',
        validity: 'Current fact.',
      },
      {role: 'historical', support: 'contextual', citationIds: [origin.id]},
      {role: 'normative', support: 'unresolved', citationIds: []},
    ],
    additionalDependencies: [{kind: 'configuration', citationId: origin.id}],
  });
  const v2 = {
    ...v1,
    version: 2 as const,
    originCitationIds: [origin.id],
    acceptedSources: [{citationId: origin.id, acceptedCitationId: accepted.id}],
  };
  const manifest: TopicMaintenanceManifest =
    version === 1
      ? v1
      : version === 2
        ? v2
        : {
            ...v2,
            version: 3,
            sourceKind: 'code',
            dependencyExpansions: [
              {
                version: 1,
                revision: '1'.repeat(64),
                proofDigest: '2'.repeat(64),
                requestDigest: '3'.repeat(64),
                previousManifestHash: '4'.repeat(64),
                sourceCommit: 'c'.repeat(40),
                citationIds: [origin.id],
              },
            ],
          };
  const content = formatMemoryDocument(
    'MEMORY',
    {...initial.metadata, topicMaintenance: manifest},
    initial.body,
  ).replace('\n\n', '\nopaque_header: preserve exactly\n\n');
  return parseMemoryDocument(uri, content)!;
}

describe('automatic memory maintenance evidence projection', () => {
  it.each([1, 2, 3] as const)(
    'normalizes legacy code V%i without losing original/accepted support, protected roles or history',
    version => {
      const original = freeze(legacyCode(version));
      const before = JSON.stringify(original);
      const current = currentEvidence();
      const basis = prepareMemoryMaintenanceBasis(original, {
        evidence: [current],
        inferences: [0, 1, 2].map(ordinal => ({
          ordinal,
          role: 'descriptive',
          support: 'direct',
          currentEvidenceIds: [current.id],
        })),
      });
      const assessment = parseAutomaticMaintenanceAssessment(encodeAutomaticMaintenanceAssessment(basis.assessment));
      const originalId = automaticMaintenanceEvidenceId({kind: 'code', citation: origin});
      const acceptedId = automaticMaintenanceEvidenceId({kind: 'code', citation: version === 1 ? origin : accepted});
      expect(basis.record).toBe(original);
      expect(basis.record.body).toBe(original.body);
      expect(assessment.target).toMatchObject({uri, memoryId: 'tn_target', kind: 'durable'});
      expect(assessment.preparation).toMatchObject({kind: 'legacy-approved', manifestVersion: version});
      expect(assessment.paragraphs.map(item => item.role)).toEqual(['descriptive', 'historical', 'normative']);
      expect(assessment.paragraphs.map(item => item.roleAuthority)).toEqual([
        'legacy-approved',
        'legacy-approved',
        'legacy-approved',
      ]);
      expect(assessment.paragraphs[0]).toMatchObject({
        scope: 'Configured project.',
        validity: 'Current fact.',
        support: 'direct',
        supportAuthority: 'legacy-approved',
        historicalEvidenceIds: [originalId],
        acceptedEvidenceIds: [acceptedId],
        currentEvidenceIds: [current.id],
        currentSupportAuthority: 'provisional',
      });
      expect(assessment.paragraphs[2]).toMatchObject({
        support: 'unresolved',
        historicalEvidenceIds: [],
        acceptedEvidenceIds: [],
        currentSupport: 'direct',
        currentEvidenceIds: [current.id],
      });
      expect(assessment.dependencies).toEqual([{kind: 'configuration', evidenceId: originalId}]);
      expect(assessment.capabilities).toMatchObject({draft: true, apply: false, publish: false});
      expect(() => assertAutomaticMaintenanceTarget(assessment, original)).not.toThrow();
      if (assessment.version !== 1) throw new Error('Legacy preparation must keep its V1 assessment.');
      const alteredCaches = [
        {
          ...assessment,
          paragraphs: assessment.paragraphs.map(item =>
            item.ordinal === 1 || item.ordinal === 2 ? {...item, role: 'descriptive' as const} : item,
          ),
        },
        {
          ...assessment,
          paragraphs: assessment.paragraphs.map(item =>
            item.ordinal === 0 ? {...item, support: 'contextual' as const} : item,
          ),
        },
        {...assessment, dependencies: assessment.dependencies.map(item => ({...item, kind: 'dependency' as const}))},
      ];
      for (const altered of alteredCaches) {
        // These are valid closed values with the *same* manifestHash; canonical binding must reject them.
        expect(() => assertAutomaticMaintenanceAssessment(altered)).not.toThrow();
        expect(() => assertAutomaticMaintenanceTarget(altered, original)).toThrow();
      }

      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it('retains valid legacy Unicode and tab-bearing scope/validity verbatim', () => {
    const initial = record('Legacy claim.', {codeCitations: [origin]});
    const scope = '界'.repeat(512);
    const validity = 'Reviewed\tcontext';
    const manifest = buildTopicMaintenanceManifest(initial, {
      paragraphs: [{role: 'normative', support: 'direct', citationIds: [origin.id], scope, validity}],
    });
    const original = freeze(record(initial.body, {...initial.metadata, topicMaintenance: manifest}));
    const basis = prepareMemoryMaintenanceBasis(original);
    expect(basis.assessment.paragraphs[0]).toMatchObject({scope, validity});
    expect(parseAutomaticMaintenanceAssessment(encodeAutomaticMaintenanceAssessment(basis.assessment))).toEqual(
      basis.assessment,
    );
    expect(() => assertAutomaticMaintenanceTarget(basis.assessment, original)).not.toThrow();
  });

  it.each([2, 3] as const)('preserves convergent accepted code support in legacy V%i', version => {
    const initial = record('Current claim.', {codeCitations: [origin, accepted]});
    const ids = [origin.id, accepted.id].sort();
    const v1 = buildTopicMaintenanceManifest(initial, {
      paragraphs: [{role: 'descriptive', support: 'direct', citationIds: ids}],
    });
    const v2 = {
      ...v1,
      version: 2 as const,
      originCitationIds: ids,
      acceptedSources: ids.map(citationId => ({citationId, acceptedCitationId: accepted.id})),
    };
    const manifest: TopicMaintenanceManifest = version === 2 ? v2 : {...v2, version: 3, sourceKind: 'code'};
    const original = freeze(record(initial.body, {...initial.metadata, topicMaintenance: manifest}));
    const before = JSON.stringify(original);
    const basis = prepareMemoryMaintenanceBasis(original);
    expect(basis.assessment.paragraphs[0].historicalEvidenceIds).toEqual(
      ids.map(id => automaticMaintenanceEvidenceId({kind: 'code', citation: id === origin.id ? origin : accepted})),
    );
    expect(basis.assessment.paragraphs[0].acceptedEvidenceIds).toEqual([
      automaticMaintenanceEvidenceId({kind: 'code', citation: accepted}),
    ]);
    expect(() => assertAutomaticMaintenanceTarget(basis.assessment, original)).not.toThrow();
    expect(JSON.stringify(original)).toBe(before);
  });

  it.each([false, true])('normalizes distinct Obsidian origin/active pins (convergent support: %s)', converges => {
    const pin: MemoryObsidianEvidenceV1 = {
      version: 1,
      sourceId: 'notes',
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
      vaultHash: 'a'.repeat(64),
      accessHash: 'b'.repeat(64),
      noteId: '22222222-2222-4222-8222-222222222222',
      relativePath: 'Decision.md',
      revisionHash: 'c'.repeat(64),
      sanitizerVersion: 'scrubber-redact-v1',
      fragmentHash: 'd'.repeat(64),
      fragmentStart: 0,
      fragmentEnd: 12,
      pinId: '33333333-3333-4333-8333-333333333333',
      expiresAt: '2027-01-01T00:00:00.000Z',
    };
    const active = {
      ...pin,
      revisionHash: 'e'.repeat(64),
      pinId: '44444444-4444-4444-8444-444444444444',
      expiresAt: '2027-01-02T00:00:00.000Z',
    };
    const initial = record('Current claim.\n\nHistorical decision.', {obsidianEvidence: pin});
    const manifest = {
      ...buildTopicMaintenanceObsidianManifest(initial, {
        paragraphs: [
          {role: 'descriptive', support: 'direct', citationIds: [topicMaintenanceObsidianCitationId(pin)]},
          {role: 'historical', support: 'contextual', citationIds: [topicMaintenanceObsidianCitationId(pin)]},
        ],
      }),
      activeEvidence: active,
    };
    if (converges)
      manifest.paragraphs = manifest.paragraphs.map(paragraph => ({
        ...paragraph,
        citationIds: [topicMaintenanceObsidianCitationId(pin), topicMaintenanceObsidianCitationId(active)],
      }));
    const original = freeze(record(initial.body, {...initial.metadata, topicMaintenance: manifest}));
    const before = JSON.stringify(original);
    const basis = prepareMemoryMaintenanceBasis(original);
    const assessment = parseAutomaticMaintenanceAssessment(encodeAutomaticMaintenanceAssessment(basis.assessment));
    expect(basis.record).toBe(original);
    expect(assessment.paragraphs[0].historicalEvidenceIds).toEqual([
      automaticMaintenanceEvidenceId({kind: 'obsidian', evidence: pin}),
      ...(converges ? [automaticMaintenanceEvidenceId({kind: 'obsidian', evidence: active})] : []),
    ]);
    expect(assessment.paragraphs[0].acceptedEvidenceIds).toEqual([
      automaticMaintenanceEvidenceId({kind: 'obsidian', evidence: active}),
    ]);
    expect(assessment.paragraphs[0].currentEvidenceIds).toEqual([]);
    expect(assessment.evidence.map(item => item.availability)).toEqual(['unknown', 'unknown']);
    expect(assessment.capabilities.draft).toBe(false);
    expect(projectShareableAutomaticMaintenanceAssessment(assessment)).toBeUndefined();
    expect(JSON.stringify(original)).toBe(before);
  });

  it('represents every ordinary memory kind, uncited records and missing IDs without enrollment', () => {
    const kinds: readonly MemoryKind[] = ['durable', 'handoff', 'incident', 'preference', 'smoke'];
    for (const kind of kinds) {
      const input = freeze(
        record('Ordinary uncited text.', {
          kind,
          relations: [
            {type: 'references', uri: 'threadnote://memory/tn_reference'},
            {type: 'depends_on', uri: 'threadnote://memory/tn_dependency'},
          ],
        }),
      );
      const before = JSON.stringify(input);
      const basis = prepareMemoryMaintenanceBasis(input);
      expect(basis.assessment.target.kind).toBe(kind);
      expect(basis.assessment.capabilities).toMatchObject({assess: true, draft: false, apply: false, publish: false});
      expect(basis.assessment.coverage).toEqual({
        outcome: 'unknown',
        scope: 'none',
        searchedScopes: [],
        omittedSources: 0,
        omittedParagraphs: 0,
      });
      expect(basis.assessment.paragraphs[0].roleAuthority).toBe('provisional');
      expect(basis.record).toBe(input);
      expect(basis.record.metadata.relations).toEqual(input.metadata.relations);
      expect(basis.record.metadata.relations).toHaveLength(2);
      const missing = prepareMemoryMaintenanceBasis(record(input.body, {...input.metadata, memoryId: undefined}));
      expect(missing.assessment.target.memoryId).toBeUndefined();
      expect(missing.assessment.capabilities).toMatchObject({assess: true, draft: false});
      expect(missing.assessment.capabilities.reasons).toContain('missing-id');
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it('protects preferences and chronology, leaving ordinary unknown roles uncertain', () => {
    const evidence = currentEvidence();
    for (const [kind, expected] of [
      ['preference', 'normative'],
      ['handoff', 'historical'],
      ['incident', 'historical'],
    ] as const) {
      const assessment = prepareMemoryMaintenanceBasis(record('Protected text.', {kind}), {
        evidence: [evidence],
        inferences: [{ordinal: 0, role: 'descriptive', support: 'direct', currentEvidenceIds: [evidence.id]}],
      }).assessment;
      expect(assessment.paragraphs[0].role).toBe(expected);
      expect(assessment.capabilities.draft).toBe(false);
    }
    expect(prepareMemoryMaintenanceBasis(record('Unknown text.')).assessment.paragraphs[0].role).toBe('unknown');
  });

  it('distinguishes shared owner review, read-only assessment and inactive/artifact exclusions', () => {
    const evidence = currentEvidence();
    const options = {
      evidence: [evidence],
      inferences: [
        {ordinal: 0, role: 'descriptive' as const, support: 'direct' as const, currentEvidenceIds: [evidence.id]},
      ],
    };
    const shared = record(
      'Shared claim.',
      {visibility: 'shared'},
      uri.replace('/memories/', '/memories/shared/default/'),
    );
    expect(prepareMemoryMaintenanceBasis(shared, options).assessment.capabilities).toMatchObject({
      assess: true,
      draft: true,
      apply: false,
      publish: false,
      reviewRoute: 'shared-owner-review',
    });
    const readOnly = prepareMemoryMaintenanceBasis(shared, {...options, readOnly: true}).assessment;
    expect(readOnly.capabilities).toMatchObject({
      assess: true,
      draft: true,
      apply: false,
      publish: false,
      reviewRoute: 'read-only',
    });
    expect(projectShareableAutomaticMaintenanceAssessment(readOnly)).toBeUndefined();
    for (const status of ['archived', 'expired', 'superseded'] as const)
      expect(
        prepareMemoryMaintenanceBasis(record('Inactive.', {status}), options).assessment.capabilities,
      ).toMatchObject({assess: false, draft: false, reviewRoute: 'excluded'});
    const artifact = record('Agent artifact.', {}, 'threadnote://user/test/memories/agent-artifacts/internal.md');
    expect(prepareMemoryMaintenanceBasis(artifact, options).assessment.capabilities).toMatchObject({
      assess: false,
      draft: false,
      reviewRoute: 'excluded',
    });
    const future = {...record('Future schema.'), metadata: {...record().metadata, schemaVersion: 999}};
    expect(prepareMemoryMaintenanceBasis(future, options).assessment.capabilities).toMatchObject({
      assess: true,
      draft: false,
    });
  });

  it('reports unavailable geometry for oversized/empty bodies without silently dropping accepted text', () => {
    for (const body of ['x'.repeat(32769), Array.from({length: 65}, () => 'Paragraph.').join('\n\n'), '']) {
      const input = record(body);
      const basis = prepareMemoryMaintenanceBasis(input);
      expect(basis.record.body).toBe(input.body);
      expect(basis.assessment.target.paragraphCount).toBeNull();
      expect(basis.assessment.coverage.omittedParagraphs).toBeNull();
      expect(basis.assessment.capabilities.reasons).toContain('target-bounds');
      expect(basis.assessment.capabilities.draft).toBe(false);
      expect(() => assertAutomaticMaintenanceTarget(basis.assessment, input)).not.toThrow();
    }
  });

  it('preserves exact ordinal/hash/span identity for duplicate and Unicode source fragments', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({minLength: 1, maxLength: 12}).filter(text => text.trim().length > 0 && !text.includes('\n')),
          {minLength: 1, maxLength: 8},
        ),
        pieces => {
          const text = pieces.map(piece => piece.trim()).join(' ');
          const original = freeze(record(`${text}\n\n${text}`));
          const before = JSON.stringify(original);
          const first = memoryMaintenanceFragmentSource(original, 0);
          const second = memoryMaintenanceFragmentSource(original, 1);
          expect(() => assertMemoryMaintenanceFragmentSource(first, original)).not.toThrow();
          expect(() =>
            assertMemoryMaintenanceFragmentSource(
              {...first, fragment: {...first.fragment, startOffset: first.fragment.startOffset + 1}},
              original,
            ),
          ).toThrow();
          expect(first.fragment.hash).toBe(second.fragment.hash);
          expect(first.fragment.ordinal).not.toBe(second.fragment.ordinal);
          expect(automaticMaintenanceSourceIdentity(first)).toBe(automaticMaintenanceSourceIdentity(second));
          expect(automaticMaintenanceEvidenceId(first)).not.toBe(automaticMaintenanceEvidenceId(second));
          for (const source of [first, second])
            expect(original.body.slice(source.fragment.startOffset, source.fragment.endOffset)).toBe(text);
          const assessment = prepareMemoryMaintenanceBasis(original).assessment;
          expect(parseAutomaticMaintenanceAssessment(encodeAutomaticMaintenanceAssessment(assessment))).toEqual(
            assessment,
          );
          expect(() => assertAutomaticMaintenanceTarget(assessment, original)).not.toThrow();
          expect(JSON.stringify(original)).toBe(before);
        },
      ),
      {numRuns: 60},
    );
  });

  it('does not fabricate historical support when newly discovered evidence reconstructs an uncited claim', () => {
    const original = freeze(record('Uncited current claim.'));
    const evidence = currentEvidence();
    const assessment = prepareMemoryMaintenanceBasis(original, {
      evidence: [evidence],
      inferences: [{ordinal: 0, role: 'descriptive', support: 'direct', currentEvidenceIds: [evidence.id]}],
      coverage: {
        outcome: 'partial',
        scope: 'bounded-search',
        searchedScopes: ['project:threadnote'],
        omittedSources: 3,
      },
    }).assessment;
    expect(assessment.paragraphs[0]).toMatchObject({
      roleAuthority: 'provisional',
      supportAuthority: 'provisional',
      historicalEvidenceIds: [],
      acceptedEvidenceIds: [],
      currentEvidenceIds: [evidence.id],
      currentSupportAuthority: 'provisional',
    });
    expect(assessment.capabilities).toMatchObject({draft: true, apply: false, publish: false});
    const changedMetadata = record(original.body, {...original.metadata, owner: 'metadata-only'});
    const before = memoryMaintenanceFragmentSource(original, 0);
    const after = memoryMaintenanceFragmentSource(changedMetadata, 0);
    expect(before.fragment).toEqual(after.fragment);
    expect(before.canonicalHash).not.toBe(after.canonicalHash);
    expect(automaticMaintenanceEvidenceId(before)).not.toBe(automaticMaintenanceEvidenceId(after));
  });

  it('refuses malformed legacy records and inference gaps rather than treating them as new authority', () => {
    const initial = record('Claim.');
    expect(() =>
      prepareMemoryMaintenanceBasis({...initial, metadata: {...initial.metadata, topicMaintenanceError: 'malformed'}}),
    ).toThrow(/protected/);
    const evidence = currentEvidence();
    expect(() =>
      prepareMemoryMaintenanceBasis(initial, {
        inferences: [{ordinal: 1, role: 'descriptive', support: 'direct', currentEvidenceIds: [evidence.id]}],
      }),
    ).toThrow();
    expect(() =>
      prepareMemoryMaintenanceBasis(initial, {
        inferences: [{ordinal: 0, role: 'descriptive', support: 'direct', currentEvidenceIds: [evidence.id]}],
      }),
    ).toThrow();
    expect(() => memoryMaintenanceFragmentSource(initial, -1)).toThrow();
  });
});

describe('preparation from canonical approved ordinary support', () => {
  it('rebuilds approved roles and active support from only canonical bytes and resists provisional role poisoning', () => {
    const body = 'Same paragraph.\n\nSame paragraph.\n\nPolicy is protected.';
    const source = {kind: 'code' as const, citation: accepted};
    const id = automaticMaintenanceEvidenceId(source);
    const approved = {
      type: 'reviewed-memory-support' as const,
      version: 1 as const,
      active: createReviewedSupportSnapshot({
        bodyHash: consolidationRevision(body),
        paragraphs: body.split('\n\n').map((paragraph, ordinal) => ({
          ordinal,
          hash: consolidationRevision(paragraph),
          role: ordinal === 2 ? ('normative' as const) : ('descriptive' as const),
          support: 'direct' as const,
          evidenceIds: [id],
        })),
        sources: [{id, source, scope: 'repository'}],
        acceptance: {
          reviewId: 'review-canonical-context',
          approvedAt: '2026-10-21T00:00:00.000Z',
          targetBeforeHash: '1'.repeat(64),
          preparationDigest: '2'.repeat(64),
          sourceVectorDigest: '3'.repeat(64),
        },
      }),
    };
    const saved = record(body, {schemaVersion: 11, reviewedSupport: approved});
    const fresh = parseMemoryDocument(uri, saved.content)!;
    const basis = prepareMemoryMaintenanceBasis(fresh, {
      inferences: [{ordinal: 2, role: 'descriptive', support: 'direct', currentEvidenceIds: [id]}],
    });
    expect(basis.assessment.version).toBe(2);
    expect(basis.assessment.preparation).toEqual({
      version: 2,
      kind: 'reviewed-support',
      supportDigest: reviewedMemorySupportDigest(approved),
    });
    expect(basis.assessment.paragraphs[2]).toMatchObject({
      role: 'normative',
      roleAuthority: 'reviewed',
      supportAuthority: 'reviewed',
      acceptedEvidenceIds: [id],
    });
    expect(basis.assessment.evidence[0].source).toEqual(source);
    expect(() => assertAutomaticMaintenanceTarget(basis.assessment, fresh)).not.toThrow();
    const poisoned = structuredClone(basis.assessment);
    (poisoned.paragraphs[2] as {role: string}).role = 'descriptive';
    expect(() => assertAutomaticMaintenanceTarget(poisoned, fresh)).toThrow();
    expect(prepareMemoryMaintenanceBasis(parseMemoryDocument(uri, saved.content)!).assessment).toEqual(
      prepareMemoryMaintenanceBasis(fresh).assessment,
    );
  });
});

it('rebuilds eight immutable roots plus eight approved sources and accounts for eight distinct current reads', () => {
  const body = 'Current descriptive claim.\n\nProtected policy.\n\nRecorded history.';
  const citations = (group: string) =>
    Array.from({length: 8}, (_, index) =>
      createMemoryCodeCitation({
        ...originInput,
        // Real canonical envelopes exercise the serialized budget, rather than padding an invalid assessment.
        path: `${'nested/'.repeat(500)}${group}-${index}.ts`,
        fileContentHash: {algorithm: 'sha256', value: consolidationRevision(`${group}-${index}`)},
      }),
    );
  const roots = citations('root');
  const active = citations('active');
  const current = citations('current');
  const approvedSources = active.map(citation => {
    const source = {kind: 'code' as const, citation};
    return {id: automaticMaintenanceEvidenceId(source), source, scope: 'repository' as const};
  });
  const approved = {
    type: 'reviewed-memory-support' as const,
    version: 1 as const,
    active: createReviewedSupportSnapshot({
      bodyHash: consolidationRevision(body),
      paragraphs: body.split('\n\n').map((section, ordinal) => ({
        ordinal,
        hash: consolidationRevision(section),
        role: (['descriptive', 'normative', 'historical'] as const)[ordinal],
        support: 'direct' as const,
        evidenceIds: approvedSources.map(source => source.id),
      })),
      sources: approvedSources,
      acceptance: {
        reviewId: 'review-root-active-budget',
        approvedAt: '2026-10-21T00:00:00.000Z',
        targetBeforeHash: '1'.repeat(64),
        preparationDigest: '2'.repeat(64),
        sourceVectorDigest: '3'.repeat(64),
      },
    }),
  };
  const saved = record(body, {schemaVersion: 11, codeCitations: roots, reviewedSupport: approved});
  expect(saved.metadata.citationErrors).toBeUndefined();
  expect(saved.metadata.reviewedSupportError).toBeUndefined();
  const canonical = parseMemoryDocument(uri, saved.content)!;
  const untouched = structuredClone(canonical);
  const rebuilt = prepareMemoryMaintenanceBasis(canonical).assessment;
  expect(rebuilt.evidence).toHaveLength(16);
  expect(
    rebuilt.evidence
      .filter(item => item.source.kind === 'code')
      .map(item => (item.source.kind === 'code' ? item.source.citation : undefined)),
  ).toEqual([...roots, ...active]);
  expect(
    rebuilt.paragraphs.map(item => [
      item.role,
      item.roleAuthority,
      item.support,
      item.supportAuthority,
      item.acceptedEvidenceIds,
    ]),
  ).toEqual(
    approved.active.paragraphs.map(item => [item.role, 'reviewed', item.support, 'reviewed', item.evidenceIds]),
  );
  const currentEvidence: AutomaticMaintenanceEvidenceV1[] = current.map(citation => {
    const source = {kind: 'code' as const, citation};
    return {
      id: automaticMaintenanceEvidenceId(source),
      source,
      scope: 'repository',
      authority: 'provisional',
      availability: 'available',
    };
  });
  const assessment = prepareMemoryMaintenanceBasis(canonical, {
    evidence: currentEvidence,
    inferences: [
      {ordinal: 0, role: 'descriptive', support: 'direct', currentEvidenceIds: currentEvidence.map(item => item.id)},
    ],
  }).assessment;
  expect(assessment.version).toBe(2);
  expect(assessment.evidence).toHaveLength(24);
  expect(assessment.paragraphs[0].currentEvidenceIds).toEqual(currentEvidence.map(item => item.id));
  expect(assessment.paragraphs[0].acceptedEvidenceIds).toEqual(approvedSources.map(item => item.id));
  expect(assessment.capabilities.draft).toBe(true);
  const encoded = encodeAutomaticMaintenanceAssessment(assessment);
  expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(MAX_AUTOMATIC_MAINTENANCE_BYTES);
  expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(MAX_AUTOMATIC_MAINTENANCE_V2_BYTES);
  expect(parseAutomaticMaintenanceAssessment(encoded)).toEqual(assessment);
  expect(() => assertAutomaticMaintenanceTarget(assessment, canonical)).not.toThrow();
  const extra = currentEvidence[0];
  const citation = createMemoryCodeCitation({...originInput, path: 'extra-current.ts'});
  const source = {kind: 'code' as const, citation};
  const evidence = [...currentEvidence, {...extra, source, id: automaticMaintenanceEvidenceId(source)}];
  expect(() => prepareMemoryMaintenanceBasis(canonical, {evidence})).toThrow(/source budget/u);
  expect(() =>
    assertAutomaticMaintenanceAssessment({...assessment, evidence: [...assessment.evidence, evidence.at(-1)]}),
  ).toThrow();
  expect(canonical).toEqual(untouched);
  expect(canonical.metadata.reviewedSupport!.active.sources).toHaveLength(8);
  expect(() =>
    prepareMemoryMaintenanceBasis(record(body, {codeCitations: roots}), {evidence: [currentEvidence[0]]}),
  ).toThrow(/source budget/u);
});

describe('health readers of approved ordinary support', () => {
  const second = createMemoryCodeCitation({...originInput, path: 'packages/context/src/health.ts'});
  const unused = createMemoryCodeCitation({...originInput, path: 'packages/context/src/health_maintenance.ts'});
  const now = new Date('2026-10-21T00:00:00.000Z');
  const acceptance = {
    reviewId: 'review-current-health',
    approvedAt: now.toISOString(),
    targetBeforeHash: '1'.repeat(64),
    preparationDigest: '2'.repeat(64),
    sourceVectorDigest: '3'.repeat(64),
  };
  function approved(referenced: readonly MemoryCodeCitationV1[] = [accepted, second]): MemoryRecord {
    const body = 'Approved current claim.';
    const memory = currentEvidence();
    const descriptor = (citation: MemoryCodeCitationV1) => {
      const source = {kind: 'code' as const, citation};
      return {id: automaticMaintenanceEvidenceId(source), source, scope: 'repository' as const};
    };
    const paragraph = {
      ordinal: 0,
      hash: consolidationRevision(body),
      role: 'descriptive' as const,
      support: 'direct' as const,
    };
    return record(body, {
      project: 'threadnote',
      schemaVersion: 11,
      codeCitations: [origin],
      reviewedSupport: {
        type: 'reviewed-memory-support',
        version: 1,
        active: createReviewedSupportSnapshot({
          bodyHash: consolidationRevision(body),
          paragraphs: [{...paragraph, evidenceIds: [...referenced.map(c => descriptor(c).id), memory.id]}],
          sources: [
            ...[accepted, second, unused].map(descriptor),
            {id: memory.id, source: memory.source, scope: memory.scope},
          ],
          acceptance,
        }),
        initialApproval: createReviewedSupportSnapshot({
          bodyHash: consolidationRevision(body),
          paragraphs: [{...paragraph, evidenceIds: [descriptor(origin).id]}],
          sources: [descriptor(origin)],
          acceptance,
        }),
      },
    });
  }
  function receipt(
    citation: MemoryCodeCitationV1,
    status: 'exact' | 'changed' | 'unknown',
  ): ContextBriefCitationValidationReceiptV2 {
    return {
      citationId: citation.id,
      candidateCount: 0,
      coverage: status === 'unknown' ? 'incomplete' : 'current-complete',
      kind: 'file',
      observedAt: now.toISOString(),
      provenance: 'current-verified',
      reason: status === 'exact' ? 'exact' : status === 'changed' ? 'source-changed' : 'repository-unavailable',
      status,
      strategy: 'content-hash',
      validatorVersion: 1,
    };
  }

  it('selects only referenced active code pins without changing canonical roots or source envelopes', () => {
    fc.assert(
      fc.property(fc.subarray([accepted, second]), referenced => {
        const canonical = freeze(approved(referenced));
        const before = JSON.stringify(canonical);
        expect(currentMemoryCodeCitations(canonical)).toEqual(referenced);
        expect(currentMemoryCodeCitations(parseMemoryDocument(uri, canonical.content)!)).toEqual(referenced);
        expect(canonical.metadata.codeCitations).toEqual([origin]);
        expect(JSON.stringify(canonical)).toBe(before);
      }),
      {numRuns: 20},
    );
    const legacy = freeze(record('Legacy claim.', {codeCitations: [origin, accepted]}));
    expect(currentMemoryCodeCitations(legacy)).toBe(legacy.metadata.codeCitations);
  });

  it('uses the current vector for coverage and drift findings while ignoring root and unreferenced receipts', () => {
    const canonical = freeze(approved());
    const before = JSON.stringify(canonical);
    const historical = [receipt(origin, 'changed'), receipt(unused, 'unknown')];
    const validations = [{uri, receipts: [...historical, receipt(accepted, 'exact'), receipt(second, 'exact')]}];
    expect(contextHealthCitationCoverageV2({records: [canonical], validations})).toMatchObject({
      eligible: 2,
      checked: 2,
      pending: 0,
      unavailable: 0,
      currentVerified: 2,
      historicalVerified: 0,
      state: 'complete',
      reasons: [],
    });
    const result = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [canonical],
      citationValidations: [{uri, receipts: [...historical, receipt(accepted, 'changed'), receipt(second, 'exact')]}],
      includeCitationCoverageFindings: true,
    });
    const findings = result.findings.filter(item => item.category.startsWith('citation-'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: 'citation-changed',
      repair: {targetUri: `${uri}#${accepted.id}`},
      caseIdentity: {slot: contextHealthCitationCaseSlotV2(accepted)},
    });
    expect(
      contextHealthCitationCoverageV2({records: [canonical], validations: [{uri, receipts: historical}]}),
    ).toMatchObject({eligible: 2, checked: 0, pending: 2, state: 'unavailable'});
    expect(JSON.stringify(canonical)).toBe(before);
  });

  it('preserves an explicitly selected worker subset and permits active support containing no code', () => {
    const canonical = approved();
    const selected = {...canonical, metadata: {...canonical.metadata, codeCitations: [accepted]}};
    expect(
      contextHealthCitationCoverageV2({
        records: [selected],
        validations: [{uri, receipts: [receipt(accepted, 'exact'), receipt(second, 'unknown')]}],
        citationSelection: 'provided',
      }),
    ).toMatchObject({eligible: 1, checked: 1, pending: 0, currentVerified: 1, state: 'complete'});
    expect(contextHealthCitationCoverageV2({records: [approved([])], validations: []})).toMatchObject({
      eligible: 0,
      state: 'complete',
    });
  });

  it('fails closed for malformed or body-stale reviewed headers instead of reviving legacy roots', () => {
    const canonical = approved();
    const invalid = parseMemoryDocument(
      uri,
      canonical.content.replace(/^reviewed_support:.*$/mu, 'reviewed_support: {invalid}'),
    )!;
    expect(invalid.metadata.reviewedSupportError).toBeDefined();
    const stripped = {...canonical, metadata: {...canonical.metadata, reviewedSupport: undefined}};
    const wrongSchema = {...canonical, metadata: {...canonical.metadata, schemaVersion: 10}};
    for (const unsafe of [invalid, stripped, wrongSchema, {...canonical, body: 'Changed after approval.'}]) {
      expect(() => currentMemoryCodeCitations(unsafe)).toThrow(/Reviewed memory support/u);
      expect(() => contextHealthCitationCoverageV2({records: [unsafe], validations: []})).toThrow();
      expect(() => buildContextHealthReport({now, project: 'threadnote', records: [unsafe]})).toThrow();
    }
  });
});
