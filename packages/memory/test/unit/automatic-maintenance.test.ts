import {
  captureReviewedSupportLegacyOrigin,
  validateReviewedSupportLegacyOrigin,
  createReviewedSupportSnapshot,
  validateReviewedMemorySupport,
  reviewedSupportSharingBlocker,
  type ReviewedMemorySupportV1,
} from '../../src/reviewed-support.js';
import {topicMaintenanceReplacementError} from '../../src/topic-maintenance.js';
import {memoryCodeCitationContentSharingBlocker} from '../../src/code/citation-policy.js';
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
  MAX_AUTOMATIC_MAINTENANCE_V2_BYTES,
  parseAutomaticMaintenanceAssessment,
  projectShareableAutomaticMaintenanceAssessment,
  type AutomaticMaintenanceAssessmentV1,
  type AutomaticMaintenanceEvidenceV1,
  type AutomaticMaintenanceSourceV1,
} from '../../src/automatic-maintenance.js';
import {createMemoryCodeCitation} from '../../src/code/citation.js';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryObsidianEvidenceV1,
} from '../../src/document.js';
import {consolidationRevision, reviewConsolidation} from '../../src/consolidation.js';

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

// Canonical approval survives disposal of the private preparation/review stores.
describe('canonical reviewed support', () => {
  const acceptance = {
    reviewId: 'review-canonical-support',
    approvedAt: '2026-10-21T00:00:00.000Z',
    targetBeforeHash: '1'.repeat(64),
    preparationDigest: '2'.repeat(64),
    sourceVectorDigest: '3'.repeat(64),
  };
  function support(body = 'Approved claim.', citation = code): ReviewedMemorySupportV1 {
    const source = {kind: 'code' as const, citation};
    const id = automaticMaintenanceEvidenceId(source);
    return {
      type: 'reviewed-memory-support',
      version: 1,
      active: createReviewedSupportSnapshot({
        bodyHash: consolidationRevision(body),
        paragraphs: [
          {ordinal: 0, hash: consolidationRevision(body), role: 'normative', support: 'direct', evidenceIds: [id]},
        ],
        sources: [{id, source, scope: 'repository'}],
        acceptance,
      }),
    };
  }
  function content(value: ReviewedMemorySupportV1, body = 'Approved claim.') {
    return formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        schemaVersion: 11,
        memoryId: 'tn_target',
        sourceAgentClient: 'test',
        timestamp: acceptance.approvedAt,
        reviewedSupport: value,
      },
      body,
    );
  }
  it('round-trips a body-bound approval without granting body edits or header removal', () => {
    const value = support();
    const stored = content(value);
    const current = parseMemoryDocument(uri, stored)!;
    expect(current.metadata.reviewedSupport).toEqual(value);
    expect(() => assertMemoryDocumentSchemaWritable(stored)).not.toThrow();
    expect(topicMaintenanceReplacementError(current, current)).toBeUndefined();
    expect(
      topicMaintenanceReplacementError(current, {
        ...current,
        metadata: {...current.metadata, reviewedSupport: undefined},
      }),
    ).toMatch(/review\/manual-preview/u);
    expect(topicMaintenanceReplacementError(undefined, current)).toMatch(/review\/manual-preview/u);
    expect(topicMaintenanceReplacementError(current, {...current, body: 'Changed claim.'})).toMatch(
      /malformed or stale/u,
    );
    expect(
      parseMemoryDocument(uri, stored.replace('Approved claim.', 'Changed claim.'))!.metadata.reviewedSupportError,
    ).toBeTruthy();
  });
  it('rejects duplicate, noncanonical, unsupported, and schema-10 approved headers', () => {
    const stored = content(support());
    const line = stored.split('\n').find(line => line.startsWith('reviewed_support: '))!;
    for (const modified of [
      stored.replace(line, `${line}\n${line}`),
      stored.replace(line, ` ${line}`),
      stored.replace('schema_version: 11', 'schema_version: 10'),
      stored.replace('"type":"reviewed-memory-support","version":1', '"type":"reviewed-memory-support","version":2'),
    ]) {
      expect(parseMemoryDocument(uri, modified)!.metadata.reviewedSupportError).toBeTruthy();
      expect(() => assertMemoryDocumentSchemaWritable(modified)).toThrow();
      expect(memoryCodeCitationContentSharingBlocker(uri, modified)).toBe('malformed-citation');
    }
  });
  it('inspects retained unreferenced initial approval evidence and portable memory locators', () => {
    const clean = support();
    const {id: _id, ...input} = code;
    const dirty = createMemoryCodeCitation({...input, sourceDirty: true});
    expect(reviewedSupportSharingBlocker({...clean, initialApproval: support('Earlier policy.', dirty).active})).toBe(
      'dirty-source',
    );
    const source: AutomaticMaintenanceSourceV1 = {
      kind: 'memory',
      uri: uri.replace('/durable/', '/shared/default/durable/').replace('target.md', 'source.md'),
      memoryId: 'tn_source',
      canonicalHash: '4'.repeat(64),
      fragment: {ordinal: 0, hash: '5'.repeat(64), startOffset: 0, endOffset: 6},
    };
    const descriptor = {id: automaticMaintenanceEvidenceId(source), source, scope: 'shared' as const};
    const active = createReviewedSupportSnapshot({
      ...clean.active,
      paragraphs: [{...clean.active.paragraphs[0], evidenceIds: [descriptor.id]}],
      sources: [descriptor],
    });
    expect(reviewedSupportSharingBlocker({...clean, active})).toBe('private-source-evidence');
    const portable = createReviewedSupportSnapshot({
      ...active,
      sources: [
        {
          ...descriptor,
          locator: {repositoryId: 'a'.repeat(64), teamId: 'default', path: 'durable/projects/threadnote/source.md'},
        },
      ],
    });
    expect(reviewedSupportSharingBlocker({...clean, active: portable})).toBeUndefined();
  });
  it('preserves truthful consolidation source revisions and rejects private nested origin', () => {
    const body = 'Reviewed origin.';
    const sourceUri = uri.replace('target.md', 'original.md');
    const reviewed = reviewConsolidation(
      body,
      [
        {
          uri: sourceUri,
          revision: '9'.repeat(64),
          memoryId: 'tn_original',
          fragments: [body],
          codeCitations: [code],
          relations: [],
        },
      ],
      [
        {
          section: body,
          disposition: 'direct',
          supports: [{sourceUri, fragment: 0, citationIds: [code.id], relationIndexes: []}],
        },
      ],
      {
        operationId: 'origin-support',
        cleanup: 'keep',
        cleanupShared: false,
        target: {kind: 'durable', status: 'active', project: 'threadnote', topic: 'target', sourceAgentClient: 'test'},
      },
    );
    const previous = parseMemoryDocument(
      uri,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          schemaVersion: 10,
          memoryId: 'tn_target',
          sourceAgentClient: 'test',
          timestamp: acceptance.approvedAt,
          codeCitations: reviewed.codeCitations,
          relations: reviewed.relations,
          consolidation: reviewed.provenance,
        },
        body,
      ),
    )!;
    const legacyOrigin = captureReviewedSupportLegacyOrigin(previous)!;
    expect(legacyOrigin.consolidation).toEqual(reviewed.provenance);
    expect(legacyOrigin.body).toBe(body);
    expect(() => validateReviewedSupportLegacyOrigin(legacyOrigin)).not.toThrow();
    expect(reviewedSupportSharingBlocker({...support(), legacyOrigin})).toBe('private-source-evidence');
    const corrupted = structuredClone(legacyOrigin);
    (corrupted as {body: string}).body = 'Invented origin.';
    expect(() => validateReviewedSupportLegacyOrigin(corrupted)).toThrow();
    expect(
      captureReviewedSupportLegacyOrigin({
        ...previous,
        metadata: {...previous.metadata, reviewedSupport: {...support(), legacyOrigin}},
      }),
    ).toBe(legacyOrigin);
  });
  it('accepts a large explicit manual body without weakening automatic draft bounds', () => {
    const body = 'a'.repeat(40 * 1024);
    expect(parseMemoryDocument(uri, content(support(body), body))!.metadata.reviewedSupportError).toBeUndefined();
  });
  it('validates snapshot encoding without mutating the input', () => {
    fc.assert(
      fc.property(
        fc.string({minLength: 1, maxLength: 200}).filter(value => value.trim().length > 0 && !value.includes('\n')),
        text => {
          const body = text.trim();
          const value = support(body);
          const original = structuredClone(value);
          expect(validateReviewedMemorySupport(JSON.parse(JSON.stringify(value)), body)).toEqual(original);
          expect(value).toEqual(original);
          expect(() => validateReviewedMemorySupport(value, `${body} changed`)).toThrow();
        },
      ),
      {numRuns: 30},
    );
  });
});

it('keeps legacy private assessment byte and descriptor limits while preflighting the new version separately', () => {
  const legacy = fixture();
  const encoded = encodeAutomaticMaintenanceAssessment(legacy);
  expect(() =>
    parseAutomaticMaintenanceAssessment(`${encoded}${' '.repeat(MAX_AUTOMATIC_MAINTENANCE_BYTES)}`),
  ).toThrow();
  expect(() => parseAutomaticMaintenanceAssessment(' '.repeat(MAX_AUTOMATIC_MAINTENANCE_V2_BYTES + 1))).toThrow();
  const evidence = [
    legacy.evidence[0],
    ...Array.from({length: 8}, (_, ordinal) => {
      const source: AutomaticMaintenanceSourceV1 = {
        kind: 'memory',
        uri: uri.replace('target.md', `source-${ordinal}.md`),
        memoryId: `tn_source_${ordinal}`,
        canonicalHash: 'a'.repeat(64),
        fragment: {ordinal: 0, hash: 'b'.repeat(64), startOffset: 0, endOffset: 6},
      };
      return {...legacy.evidence[0], source, id: automaticMaintenanceEvidenceId(source)};
    }),
  ];
  expect(() => assertAutomaticMaintenanceAssessment({...legacy, evidence})).toThrow();
});
