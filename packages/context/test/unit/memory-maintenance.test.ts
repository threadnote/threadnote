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
  encodeAutomaticMaintenanceAssessment,
  parseAutomaticMaintenanceAssessment,
  projectShareableAutomaticMaintenanceAssessment,
  type AutomaticMaintenanceEvidenceV1,
} from '@threadnote/memory/automatic-maintenance';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
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
