import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertAutomaticMaintenanceAssessment,
  assertAutomaticMaintenanceTarget,
  automaticMaintenanceCapabilities,
  automaticMaintenanceEvidenceId,
  automaticMaintenanceSourceIdentity,
  encodeAutomaticMaintenanceAssessment,
  MAX_AUTOMATIC_MAINTENANCE_BYTES,
  parseAutomaticMaintenanceAssessment,
  projectShareableAutomaticMaintenanceAssessment,
  type AutomaticMaintenanceAssessmentV1,
  type AutomaticMaintenanceEvidenceV1,
  type AutomaticMaintenanceSourceV1,
} from '../../src/automatic-maintenance.js';
import {createMemoryCodeCitation} from '../../src/code/citation.js';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryObsidianEvidenceV1,
} from '../../src/document.js';
import {consolidationRevision} from '../../src/consolidation.js';

const code = createMemoryCodeCitation({
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
const imported: MemoryObsidianEvidenceV1 = {
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
const uri = 'threadnote://user/test/memories/durable/projects/threadnote/target.md';
function fixture(
  sourceKind: 'code' | 'memory' | 'obsidian' = 'memory',
  legacy = false,
): AutomaticMaintenanceAssessmentV1 {
  const source: AutomaticMaintenanceSourceV1 =
    sourceKind === 'code'
      ? {kind: 'code', citation: code}
      : sourceKind === 'obsidian'
        ? {kind: 'obsidian', evidence: imported}
        : {
            kind: 'memory',
            uri: uri.replace('target.md', 'support.md'),
            memoryId: 'tn_source',
            canonicalHash: 'e'.repeat(64),
            fragment: {ordinal: 0, hash: 'f'.repeat(64), startOffset: 0, endOffset: 12},
          };
  const evidence: AutomaticMaintenanceEvidenceV1 = {
    id: automaticMaintenanceEvidenceId(source),
    source,
    scope: sourceKind === 'code' ? 'repository' : 'personal',
    authority: legacy ? 'recorded' : 'provisional',
    availability: 'available',
  };
  const target = {
    uri,
    memoryId: 'tn_target',
    kind: 'durable' as const,
    status: 'active' as const,
    schemaVersion: 10,
    canonicalHash: '1'.repeat(64),
    bodyHash: '2'.repeat(64),
    paragraphCount: 1,
    visibility: 'personal' as const,
    readOnly: false,
    artifact: false,
  };
  const paragraphs = [
    {
      ordinal: 0,
      hash: '3'.repeat(64),
      role: 'descriptive' as const,
      roleAuthority: legacy ? ('legacy-approved' as const) : ('provisional' as const),
      support: 'direct' as const,
      supportAuthority: legacy ? ('legacy-approved' as const) : ('provisional' as const),
      historicalEvidenceIds: legacy ? [evidence.id] : [],
      acceptedEvidenceIds: legacy ? [evidence.id] : [],
      currentEvidenceIds: [evidence.id],
      currentSupport: 'direct' as const,
      currentSupportAuthority: 'provisional' as const,
      scope: 'The configured project.',
      validity: 'Current source only.',
    },
  ];
  const coverage = {
    outcome: 'partial' as const,
    scope: 'bounded-search' as const,
    searchedScopes: ['threadnote'],
    omittedSources: 2,
    omittedParagraphs: 0,
  };
  return {
    version: 1,
    preparation: legacy
      ? {version: 1, kind: 'legacy-approved', manifestVersion: 3, manifestHash: '4'.repeat(64)}
      : {version: 1, kind: 'derived'},
    target,
    paragraphs,
    evidence: [evidence],
    dependencies: [{kind: 'dependency', evidenceId: evidence.id}],
    coverage,
    capabilities: automaticMaintenanceCapabilities(target, paragraphs, [evidence], coverage),
  };
}
function recalculate(value: AutomaticMaintenanceAssessmentV1): AutomaticMaintenanceAssessmentV1 {
  return {
    ...value,
    capabilities: automaticMaintenanceCapabilities(value.target, value.paragraphs, value.evidence, value.coverage),
  };
}

describe('automatic maintenance closed assessment contract', () => {
  it('round-trips all source variants, role authority, availability and omissions without mutation', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('code' as const, 'memory' as const, 'obsidian' as const),
        fc.boolean(),
        fc.constantFrom(
          'available' as const,
          'missing' as const,
          'expired' as const,
          'revoked' as const,
          'corrupt' as const,
          'unknown' as const,
        ),
        fc.constantFrom('descriptive' as const, 'normative' as const, 'historical' as const, 'unknown' as const),
        fc.integer({min: 0, max: 10000}),
        fc.boolean(),
        (kind, legacy, availability, role, omitted, readOnly) => {
          const seed = fixture(kind, legacy);
          const input = recalculate({
            ...seed,
            target: {...seed.target, readOnly},
            paragraphs: seed.paragraphs.map(item => ({...item, role})),
            evidence: seed.evidence.map(item => ({...item, availability})),
            coverage: {...seed.coverage, omittedSources: omitted},
          });
          const before = JSON.stringify(input);
          const decoded = parseAutomaticMaintenanceAssessment(encodeAutomaticMaintenanceAssessment(input));
          expect(decoded).toEqual(input);
          expect(JSON.stringify(input)).toBe(before);
          expect(decoded.evidence[0].source.kind).toBe(kind);
          expect(decoded.paragraphs[0].roleAuthority).toBe(legacy ? 'legacy-approved' : 'provisional');
          expect(decoded.coverage.omittedSources).toBe(omitted);
          expect(decoded.capabilities.apply).toBe(false);
          expect(decoded.capabilities.publish).toBe(false);
        },
      ),
      {numRuns: 100},
    );
  });

  it('keeps exact fragment IDs separate from stable source identity', () => {
    const source = fixture().evidence[0].source as Extract<AutomaticMaintenanceSourceV1, {kind: 'memory'}>;
    const second = {...source, fragment: {...source.fragment, ordinal: 1, startOffset: 14, endOffset: 26}};
    expect(automaticMaintenanceSourceIdentity(source)).toBe(automaticMaintenanceSourceIdentity(second));
    expect(automaticMaintenanceEvidenceId(source)).not.toBe(automaticMaintenanceEvidenceId(second));
    const seed = fixture();
    const evidence = [
      ...seed.evidence,
      {...seed.evidence[0], source: second, id: automaticMaintenanceEvidenceId(second)},
    ];
    expect(() => assertAutomaticMaintenanceAssessment(recalculate({...seed, evidence}))).not.toThrow();
    expect(() =>
      assertAutomaticMaintenanceAssessment(recalculate({...seed, evidence: [...evidence, evidence[0]]})),
    ).toThrow();
  });

  it('refuses unknown fields and versions at every contract boundary', () => {
    const base = fixture();
    const cases = [
      {...base, version: 2},
      {...base, extra: true},
      {...base, preparation: {...base.preparation, version: 2}},
      {...base, preparation: {...base.preparation, extra: true}},
      {...base, target: {...base.target, extra: true}},
      {...base, target: {...base.target, kind: 'future'}},
      {...base, coverage: {...base.coverage, extra: true}},
      {...base, paragraphs: [{...base.paragraphs[0], extra: true}]},
      {...base, evidence: [{...base.evidence[0], extra: true}]},
      {...base, evidence: [{...base.evidence[0], source: {...base.evidence[0].source, version: 2}}]},
      {...base, evidence: [{...base.evidence[0], source: {kind: 'unknown'}}]},
      {
        ...base,
        evidence: [
          {
            ...base.evidence[0],
            source: {
              ...base.evidence[0].source,
              fragment: {ordinal: 0, hash: 'f'.repeat(64), startOffset: 12, endOffset: 12},
            },
          },
        ],
      },
      {
        ...base,
        evidence: [
          {
            ...base.evidence[0],
            source: {
              ...base.evidence[0].source,
              fragment: {ordinal: 64, hash: 'f'.repeat(64), startOffset: 0, endOffset: 12},
            },
          },
        ],
      },
      {...base, dependencies: [{...base.dependencies[0], extra: true}]},
      {...base, capabilities: {...base.capabilities, extra: true}},
    ];
    for (const value of cases) expect(() => parseAutomaticMaintenanceAssessment(JSON.stringify(value))).toThrow();
  });

  it('refuses malformed bounds, mismatched identities and fabricated historical support', () => {
    const base = fixture();
    const cases = [
      {...base, coverage: {...base.coverage, omittedSources: -1}},
      {...base, coverage: {...base.coverage, omittedParagraphs: 1}},
      {...base, coverage: {...base.coverage, omittedSources: 0.5}},
      {...base, coverage: {...base.coverage, outcome: 'complete'}},
      {...base, coverage: {...base.coverage, searchedScopes: Array.from({length: 9}, (_, index) => `${index}`)}},
      {...base, target: {...base.target, canonicalHash: 'invalid'}},
      {...base, target: {...base.target, paragraphCount: -1}},
      {...base, target: {...base.target, paragraphCount: 65}},
      {...base, target: {...base.target, memoryId: ''}},
      {...base, target: {...base.target, artifact: true}},
      {...base, paragraphs: [{...base.paragraphs[0], ordinal: 1}]},
      {...base, paragraphs: [{...base.paragraphs[0], scope: 'x'.repeat(513)}]},
      {...base, paragraphs: [{...base.paragraphs[0], currentEvidenceIds: ['missing']}]},
      {...base, paragraphs: [{...base.paragraphs[0], historicalEvidenceIds: [base.evidence[0].id]}]},
      {...base, paragraphs: [{...base.paragraphs[0], roleAuthority: 'legacy-approved'}]},
      {...base, paragraphs: [{...base.paragraphs[0], currentSupportAuthority: 'legacy-approved'}]},
      {...base, capabilities: {...base.capabilities, apply: true}},
      {...base, capabilities: {...base.capabilities, publish: true}},
      {...base, evidence: [{...base.evidence[0], id: 'ame_wrong'}]},
      {...base, evidence: [{...base.evidence[0], scope: 'shared'}]},
      {...base, evidence: Array.from({length: 9}, () => base.evidence[0])},
    ];
    for (const value of cases) expect(() => parseAutomaticMaintenanceAssessment(JSON.stringify(value))).toThrow();
    expect(() => parseAutomaticMaintenanceAssessment(' '.repeat(MAX_AUTOMATIC_MAINTENANCE_BYTES + 1))).toThrow();
    expect(() => parseAutomaticMaintenanceAssessment('{broken')).toThrow();
    expect(() =>
      encodeAutomaticMaintenanceAssessment({...base, target: {...base.target, memoryId: undefined}}),
    ).toThrow();
  });

  it('withholds the entire sharing projection for private/imported evidence, including inactive baseline evidence', () => {
    const seed = fixture('code');
    const shared = recalculate({
      ...seed,
      target: {...seed.target, uri: uri.replace('/memories/', '/memories/shared/default/'), visibility: 'shared'},
    });
    const before = JSON.stringify(shared);
    const projected = projectShareableAutomaticMaintenanceAssessment(shared);
    expect(projected).toEqual(shared);
    expect(projected).not.toBe(shared);
    const privateEvidence = fixture('memory', true).evidence[0];
    expect(
      projectShareableAutomaticMaintenanceAssessment(
        recalculate({...shared, evidence: [...shared.evidence, privateEvidence]}),
      ),
    ).toBeUndefined();
    expect(
      projectShareableAutomaticMaintenanceAssessment(
        recalculate({...shared, evidence: [...shared.evidence, fixture('obsidian', true).evidence[0]]}),
      ),
    ).toBeUndefined();
    for (const unsafe of [{sourceDirty: true}, {repositoryIdentityKind: 'local' as const}]) {
      const {id: _id, ...input} = code;
      const citation = createMemoryCodeCitation({...input, ...unsafe});
      const source = {kind: 'code' as const, citation};
      const evidence = {...shared.evidence[0], source, id: automaticMaintenanceEvidenceId(source)};
      const rewritten = {
        ...shared,
        evidence: [evidence],
        paragraphs: shared.paragraphs.map(item => ({...item, currentEvidenceIds: [evidence.id]})),
        dependencies: [],
      };
      expect(projectShareableAutomaticMaintenanceAssessment(recalculate(rewritten))).toBeUndefined();
    }
    expect(projectShareableAutomaticMaintenanceAssessment(seed)).toBeUndefined();
    expect(JSON.stringify(shared)).toBe(before);
  });

  it('binds a cached assessment to exact canonical bytes and paragraph identity', () => {
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        memoryId: 'tn_target',
        status: 'active',
        schemaVersion: 10,
        sourceAgentClient: 'test',
        timestamp: '2026-10-21T00:00:00.000Z',
      },
      'Current claim.',
    );
    const record = parseMemoryDocument(uri, content)!;
    const seed = fixture();
    const assessment = recalculate({
      ...seed,
      target: {
        ...seed.target,
        canonicalHash: consolidationRevision(canonicalMemoryDocumentContent(content)),
        bodyHash: consolidationRevision(record.body),
      },
      paragraphs: seed.paragraphs.map(item => ({...item, hash: consolidationRevision(record.body)})),
    });
    expect(() => assertAutomaticMaintenanceTarget(assessment, record)).not.toThrow();
    const changed = parseMemoryDocument(
      uri,
      content.replace('source_agent_client: test', 'source_agent_client: other'),
    )!;
    expect(changed.body).toBe(record.body);
    expect(() => assertAutomaticMaintenanceTarget(assessment, changed)).toThrow();
    expect(() => assertAutomaticMaintenanceTarget(assessment, {...record, body: 'Other claim.'})).toThrow();
  });
});
