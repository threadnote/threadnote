import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {MemoryMetadata, MemoryRecord} from '@threadnote/memory/document';
import {
  contextHealthCaseIdV2,
  contextHealthCitationCoverageV2,
  migrateContextHealthCitationCaseSlotV2,
  contextHealthFindingCaseIdentityV2,
  resolveContextHealthRelationTargetV2,
} from '@threadnote/context/health_maintenance';
import type {ContextBriefCitationValidationReceiptV2} from '@threadnote/context/types';
import {createMemoryCodeCitation, preserveMemoryCodeCitationAnchor} from '@threadnote/memory/code/citation';
import {buildContextHealthReport} from '@threadnote/context/health';
import {
  analyzeContextHealthSemantics,
  compareContextHealthSemanticClaims,
  compareContextHealthSemanticClaimWindow,
  extractContextHealthSemanticClaims,
  findContextHealthSemanticContradiction,
} from '@threadnote/context/health_semantic';

const now = new Date('2026-09-17T12:00:00.000Z');

function record(uri: string, body: string, metadata: Partial<MemoryMetadata> = {}): MemoryRecord {
  const complete = {
    kind: 'durable' as const,
    project: 'threadnote',
    sourceAgentClient: 'codex',
    status: 'active' as const,
    timestamp: '2026-09-01T00:00:00.000Z',
    topic: 'context-health',
    ...metadata,
  };
  return {
    body,
    content: [
      'MEMORY',
      `kind: ${complete.kind}`,
      `status: ${complete.status}`,
      `project: ${complete.project}`,
      `topic: ${complete.topic}`,
      `source_agent_client: ${complete.sourceAgentClient}`,
      `timestamp: ${complete.timestamp}`,
      '',
      body,
    ].join('\n'),
    headerTitle: complete.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
    metadata: complete,
    uri,
  };
}

describe('buildContextHealthReport', () => {
  it('reaches a contradiction after the direct per-record claim limit and rechecks its exact source pair', () => {
    const filler = Array.from(
      {length: 17},
      (_, index) => `Worker ${String.fromCharCode(97 + index)} must retain verified context.`,
    );
    const candidates = Array.from(
      {length: 100},
      (_, index) =>
        `Deployment policy${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
    );
    const subject = candidates.find(candidate => {
      const source = record('threadnote://memory/a', [...filler, `${candidate} must use signed artifacts.`].join('\n'));
      return (
        extractContextHealthSemanticClaims(source).claims.findIndex(claim => claim.text.startsWith(candidate)) >= 16
      );
    })!;
    const left = record('threadnote://memory/a', [...filler, `${subject} must use signed artifacts.`].join('\n'));
    const right = record('threadnote://memory/z', `${subject} must not use signed artifacts.`);
    const before = [left.content, right.content];
    expect(analyzeContextHealthSemantics({project: 'threadnote', records: [left, right]}).contradictions).toHaveLength(
      0,
    );
    const extracted = extractContextHealthSemanticClaims(left);
    expect(extracted.claims).toHaveLength(18);
    expect(extracted.reasons).not.toContain('claim-limit');
    const evidence = compareContextHealthSemanticClaims(
      extracted.claims.find(claim => claim.text.startsWith(subject))!,
      extractContextHealthSemanticClaims(right).claims[0],
    )!;
    expect(
      findContextHealthSemanticContradiction([left, right], evidence.contradictionId, [
        evidence.left.claimFingerprint,
        evidence.right.claimFingerprint,
      ]),
    ).toEqual(evidence);
    expect([left.content, right.content]).toEqual(before);
  });

  it('compares the exhaustive claim domain across bounded pages and serialized restarts', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), {minLength: 1, maxLength: 8}),
        fc.array(fc.boolean(), {minLength: 1, maxLength: 8}),
        fc.integer({min: 1, max: 7}),
        (leftPolarity, rightPolarity, limit) => {
          const make = (uri: string, denied: readonly boolean[]) =>
            record(uri, denied.map(value => `Agents must ${value ? 'not ' : ''}load verified context.`).join('\n'));
          const left = make('threadnote://memory/a', leftPolarity);
          const right = make('threadnote://memory/b', rightPolarity);
          const before = [left.content, right.content];
          const a = extractContextHealthSemanticClaims(left).claims;
          const b = extractContextHealthSemanticClaims(right).claims;
          const expected =
            leftPolarity.filter(Boolean).length * rightPolarity.filter(value => !value).length +
            leftPolarity.filter(value => !value).length * rightPolarity.filter(Boolean).length;
          const found = new Set<string>();
          let cursor = 0;
          while (cursor < a.length * b.length) {
            const page = compareContextHealthSemanticClaimWindow(a, b, cursor, limit);
            for (const evidence of page.contradictions) found.add(evidence.contradictionId);
            cursor = JSON.parse(JSON.stringify(page.nextCursor)) as number;
          }
          expect(found.size).toBe(expected);
          expect([left.content, right.content]).toEqual(before);
        },
      ),
      {numRuns: 40},
    );
  });
  it('excludes reserved artifact targets without hiding ordinary missing-memory evidence', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.constantFrom('missing', 'inactive', 'conflicted'), (shared, status) => {
        const prefix = `threadnote://user/tester/memories/${shared ? 'shared/default/' : ''}`;
        const artifact = `${prefix}agent-artifacts/skills/review/SKILL.md`;
        const ordinary = `${prefix}durable/projects/threadnote/agent-artifacts/missing.md`;
        const source = record(`${prefix}durable/projects/threadnote/source.md`, 'Artifact references.', {
          relations: [
            {type: 'depends_on', uri: artifact},
            {type: 'depends_on', uri: ordinary},
          ],
        });
        const report = buildContextHealthReport({
          now,
          project: 'threadnote',
          records: [source],
          relationEvidence: [artifact, ordinary].map(targetUri => ({sourceUri: source.uri, targetUri, status})),
        });
        const findings = report.findings.filter(item => item.category.startsWith('relation-target-'));
        expect(findings).toHaveLength(1);
        expect(findings[0]?.repair.targetUri).toBe(ordinary);
        expect(
          (report.maintenance?.actionableFindings ?? 0) + (report.maintenance?.automaticallyManagedFindings ?? 0),
        ).toBe(1);
      }),
      {numRuns: 24, seed: 74653},
    );
  });

  it('reports the 2,001-citation admission tail as coverage rather than content damage', () => {
    const records = Array.from({length: 2_001}, (_, index) =>
      record(`threadnote://memory/tn_${index}`, `unique claim ${index}`, {kind: 'handoff'}),
    );
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records,
      citationValidations: records.map((item, index) => ({
        uri: item.uri,
        receipts: [
          {
            ...receipt('unknown', 'repository-unavailable'),
            citationId: `citation-${index}`,
            reason: index < 96 ? 'exact' : 'citation-limit',
            status: index < 96 ? 'exact' : 'unknown',
            coverage: index < 96 ? 'current-complete' : 'incomplete',
          },
        ],
      })),
    });
    expect(report.findings).toEqual([]);
    expect(report.status).toBe('unknown');
    expect(report.maintenance).toMatchObject({
      actionableFindings: 0,
      citationCoverage: {
        eligible: 2_001,
        checked: 96,
        deferred: 1_905,
        state: 'partial',
        reasons: [{reason: 'citation-limit', count: 1_905}],
      },
    });
  });

  it('keeps admission invariance under valid corpus growth', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 150}), count => {
        const records = Array.from({length: count}, (_, index) =>
          record(`threadnote://memory/tn_${index}`, `unique ${index}`, {kind: 'handoff'}),
        );
        const report = buildContextHealthReport({
          now,
          project: 'threadnote',
          records,
          citationValidations: records.map((item, index) => ({
            uri: item.uri,
            receipts: [
              {
                ...receipt('unknown', 'repository-unavailable'),
                citationId: `citation-${index}`,
                reason: index < 96 ? 'exact' : 'citation-limit',
                status: index < 96 ? 'exact' : 'unknown',
                coverage: index < 96 ? 'current-complete' : 'incomplete',
              },
            ],
          })),
        });
        expect(report.maintenance?.actionableFindings).toBe(0);
        expect(report.maintenance?.citationCoverage.checked).toBe(Math.min(count, 96));
        expect(report.maintenance?.citationCoverage.deferred).toBe(Math.max(0, count - 96));
      }),
      {numRuns: 40},
    );
  });

  it('keeps stable cases across transient reasons, citation replacement and memory moves', () => {
    const source = record('threadnote://memory/old-path', 'source', {
      memoryId: 'tn_stable',
      codeCitations: [citation('old-citation')],
    });
    const build = (item: MemoryRecord, reason: ContextBriefCitationValidationReceiptV2['reason'], citationId: string) =>
      buildContextHealthReport({
        now,
        project: 'threadnote',
        records: [item],
        citationValidations: [
          {uri: item.uri, receipts: [{...receipt('unknown', 'repository-unavailable'), reason, citationId}]},
        ],
      }).findings[0];
    const original = source.metadata.codeCitations![0];
    const first = build(source, 'repository-unavailable', original.id);
    expect(build(source, 'repository-ambiguous', original.id)?.caseId).toBe(first?.caseId);
    const moved = {
      ...source,
      uri: 'threadnote://memory/new-path',
      metadata: {
        ...source.metadata,
        codeCitations: [preserveMemoryCodeCitationAnchor(original, citation('new-citation'))],
      },
    };
    expect(build(moved, 'repository-unavailable', moved.metadata.codeCitations[0].id)?.caseId).toBe(first?.caseId);
    expect(first?.classification).toBe('coverage');
  });

  it('shares the stable canonical anchor identity with persisted maintenance cases', () => {
    const source = record('threadnote://memory/source', 'source', {
      memoryId: 'tn_source',
      codeCitations: [citation('first'), citation('second'), citation('third')],
    });
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [
        {
          uri: source.uri,
          receipts: [{...receipt('changed', 'source-changed'), citationId: source.metadata.codeCitations![1].id}],
        },
      ],
    });
    const finding = report.findings[0];
    if (finding === undefined) throw new Error('Expected changed citation finding');
    const identity = contextHealthFindingCaseIdentityV2({project: 'threadnote', finding, records: [source]});
    expect(identity).toEqual({
      project: 'threadnote',
      memoryId: 'tn_source',
      family: 'citation',
      slot: `anchor:${source.metadata.codeCitations![1].id}`,
    });
    expect(contextHealthCaseIdV2(identity)).toBe(finding.caseId);
  });

  it('keeps B on its own case after removing A', () => {
    const [a, b] = [citation('A'), citation('B')];
    const cases = (citations: readonly (typeof a)[]) => {
      const source = record('threadnote://memory/source', 'claim', {memoryId: 'tn_source', codeCitations: citations});
      return buildContextHealthReport({
        now,
        project: 'threadnote',
        records: [source],
        citationValidations: [
          {
            uri: source.uri,
            receipts: citations.map(item => ({...receipt('changed', 'source-changed'), citationId: item.id})),
          },
        ],
      }).findings;
    };
    const before = cases([a, b]);
    const after = cases([b]);
    const bCase = before.find(item => item.repair.targetUri?.endsWith(`#${b.id}`));
    const aCase = before.find(item => item.repair.targetUri?.endsWith(`#${a.id}`));
    expect(after[0]?.caseId).toBe(bCase?.caseId);
    expect(after[0]?.caseId).not.toBe(aCase?.caseId);
  });

  it('preserves the independent original-anchor case model under edits and replacement', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            label: fc.integer({min: 0, max: 100}),
            keep: fc.boolean(),
            rank: fc.integer({min: 0, max: 100}),
            replacements: fc.integer({min: 0, max: 3}),
          }),
          {minLength: 1, maxLength: 6, selector: item => item.label},
        ),
        entries => {
          const original = entries.map(item => ({...item, citation: citation(`original-${item.label}`)}));
          const report = (citations: readonly ReturnType<typeof citation>[]) => {
            const source = record('threadnote://memory/source', 'claim', {
              memoryId: 'tn_source',
              codeCitations: citations,
            });
            return buildContextHealthReport({
              now,
              project: 'threadnote',
              records: [source],
              citationValidations: [
                {
                  uri: source.uri,
                  receipts: citations.map(item => ({...receipt('changed', 'source-changed'), citationId: item.id})),
                },
              ],
            }).findings;
          };
          const before = report(original.map(item => item.citation));
          const expected = new Map(
            original.map(item => [
              item.label,
              before.find(finding => finding.repair.targetUri?.endsWith(`#${item.citation.id}`))!.caseId,
            ]),
          );
          const survivors = original
            .filter(item => item.keep)
            .map(item => {
              let next = item.citation;
              for (let generation = 0; generation < item.replacements; generation += 1) {
                next = preserveMemoryCodeCitationAnchor(next, citation(`replacement-${item.label}-${generation}`));
              }
              return {...item, citation: next};
            })
            .sort((left, right) => left.rank - right.rank || left.label - right.label);
          const after = report([citation('unrelated-insertion'), ...survivors.map(item => item.citation)]);
          for (const item of survivors) {
            expect(after.find(finding => finding.repair.targetUri?.endsWith(`#${item.citation.id}`))?.caseId).toBe(
              expected.get(item.label),
            );
          }
          expect(new Set(after.map(item => item.caseId)).size).toBe(after.length);
        },
      ),
      {numRuns: 80},
    );
  });

  it('migrates only unique proved citation lineage and refuses ordinal guesses', () => {
    const original = citation('original');
    const replacement = preserveMemoryCodeCitationAnchor(original, citation('replacement'));
    expect(migrateContextHealthCitationCaseSlotV2({slot: 'anchor:0', citations: [replacement]})).toBeUndefined();
    expect(
      migrateContextHealthCitationCaseSlotV2({slot: 'anchor:0', citationId: replacement.id, citations: [replacement]}),
    ).toBe(`anchor:${original.id}`);
    expect(migrateContextHealthCitationCaseSlotV2({slot: `anchor:${original.id}`, citations: [replacement]})).toBe(
      `anchor:${original.id}`,
    );
    expect(
      migrateContextHealthCitationCaseSlotV2({slot: 'anchor:0', citationId: original.id, citations: [replacement]}),
    ).toBe(`anchor:${original.id}`);
    expect(
      migrateContextHealthCitationCaseSlotV2({
        slot: replacement.id,
        citations: [replacement, {...citation('duplicate'), anchorId: original.id}],
      }),
    ).toBeUndefined();
    expect(
      migrateContextHealthCitationCaseSlotV2({
        slot: replacement.id,
        citations: [{...replacement, anchorId: 'invalid'}],
      }),
    ).toBeUndefined();
  });

  it('separates completed checks, verified current support, historical provenance and deferred work', () => {
    const source = record('threadnote://memory/coverage', 'source', {kind: 'handoff'});
    const receipts: ContextBriefCitationValidationReceiptV2[] = [
      {
        ...receipt('changed', 'source-changed'),
        citationId: 'exact',
        status: 'exact',
        reason: 'exact',
        provenance: 'current-verified',
      },
      {...receipt('changed', 'source-changed'), citationId: 'changed', provenance: 'unverified'},
      {
        ...receipt('deleted', 'source-deleted'),
        citationId: 'deleted',
        coverage: 'incomplete',
        provenance: 'unverified',
      },
      {...receipt('unknown', 'repository-unavailable'), citationId: 'historical', provenance: 'historical-verified'},
      {
        ...receipt('unknown', 'repository-unavailable'),
        citationId: 'queued',
        reason: 'citation-limit',
        provenance: 'unverified',
      },
    ];
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [{uri: source.uri, receipts}],
    });
    expect(report.maintenance?.citationCoverage).toMatchObject({
      eligible: 5,
      checked: 3,
      currentVerified: 1,
      historicalVerified: 1,
      pending: 1,
      unavailable: 0,
      deferred: 2,
      unverified: 3,
      state: 'partial',
    });
    expect(report.findings.map(item => item.category)).toEqual(['citation-changed', 'citation-missing']);
    expect(report.status).toBe('unknown');
  });

  it('counts missing and admission-deferred citations as pending and source failures as unavailable', () => {
    const source = record('threadnote://memory/coverage-buckets', 'source', {
      codeCitations: [
        {id: 'missing'} as never,
        {id: 'queued'} as never,
        {id: 'limited'} as never,
        {id: 'blocked'} as never,
      ],
    });
    const coverage = contextHealthCitationCoverageV2({
      records: [source],
      validations: [
        {
          uri: source.uri,
          receipts: [
            {...receipt('unknown', 'source-changed'), citationId: 'queued', reason: 'citation-limit'},
            {...receipt('unknown', 'source-changed'), citationId: 'limited', reason: 'citation-limit'},
            {...receipt('unknown', 'repository-unavailable'), citationId: 'blocked'},
          ],
        },
      ],
    });
    expect(coverage).toMatchObject({eligible: 4, checked: 0, historicalVerified: 0, pending: 3, unavailable: 1});
  });

  it('partitions each eligible citation into checked, historical, pending or unavailable buckets', () => {
    const scenarios = fc.array(
      fc.record({
        status: fc.constantFrom('changed' as const, 'deleted' as const, 'unknown' as const, 'missing' as const),
        reason: fc.constantFrom('citation-limit', 'repository-unavailable', 'source-changed'),
        historical: fc.boolean(),
      }),
      {minLength: 0, maxLength: 40},
    );
    fc.assert(
      fc.property(scenarios, cases => {
        const source = record('threadnote://memory/coverage-property', 'source', {
          codeCitations: cases.map((_, index) => ({id: `c${index}`}) as never),
        });
        const receipts = cases.flatMap((item, index) =>
          item.status === 'missing'
            ? []
            : [
                {
                  ...receipt(item.status === 'unknown' ? 'unknown' : item.status, 'source-changed'),
                  citationId: `c${index}`,
                  reason: item.reason,
                  ...(item.historical ? {provenance: 'historical-verified' as const} : {}),
                },
              ],
        );
        const coverage = contextHealthCitationCoverageV2({
          records: [source],
          validations: [{uri: source.uri, receipts}],
        });
        const expected = cases.reduce(
          (counts, item) => {
            if (item.historical && item.status !== 'missing') counts.historical += 1;
            else if (item.status === 'missing') counts.pending += 1;
            else if (item.status !== 'unknown') counts.checked += 1;
            else if (item.reason === 'citation-limit') counts.pending += 1;
            else counts.unavailable += 1;
            return counts;
          },
          {checked: 0, historical: 0, pending: 0, unavailable: 0},
        );
        expect(coverage.checked).toBe(expected.checked);
        expect(coverage.historicalVerified).toBe(expected.historical);
        expect(coverage.pending ?? 0).toBe(expected.pending);
        expect(coverage.unavailable ?? 0).toBe(expected.unavailable);
        expect(
          coverage.checked + coverage.historicalVerified + (coverage.pending ?? 0) + (coverage.unavailable ?? 0),
        ).toBe(coverage.eligible);
      }),
      {numRuns: 100},
    );
  });

  it('completes valid current checks that find changed or deleted support without verifying the claims', () => {
    const source = record('threadnote://memory/current-defects', 'source', {kind: 'handoff'});
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [
        {
          uri: source.uri,
          receipts: [
            {...receipt('changed', 'source-changed'), provenance: 'unverified'},
            {...receipt('deleted', 'source-deleted'), provenance: 'unverified'},
          ],
        },
      ],
    });
    expect(report.maintenance?.citationCoverage).toMatchObject({
      checked: 2,
      deferred: 0,
      currentVerified: 0,
      unverified: 2,
      state: 'complete',
    });
    expect(report.status).toBe('findings');
  });

  it('keeps incomplete exact receipts checked but abstains from verified current coverage', () => {
    const source = record('threadnote://memory/partial-exact', 'source', {kind: 'handoff'});
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [
        {
          uri: source.uri,
          receipts: [
            {
              ...receipt('unknown', 'repository-unavailable'),
              status: 'exact',
              reason: 'exact',
              provenance: 'current-verified',
            },
          ],
        },
      ],
    });
    expect(report.maintenance?.citationCoverage).toMatchObject({
      checked: 1,
      deferred: 0,
      currentVerified: 0,
      state: 'partial',
    });
    expect(report.status).toBe('unknown');
  });

  it('preserves explicit fail-closed coverage findings for Context Check callers', () => {
    const source = record('threadnote://memory/cold-graph', 'source', {kind: 'handoff'});
    const input = {
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [
        {
          uri: source.uri,
          receipts: [{...receipt('unknown', 'repository-unavailable'), reason: 'graph-incomplete' as const}],
        },
      ],
    };
    expect(buildContextHealthReport(input).findings).toEqual([]);
    const strict = buildContextHealthReport({...input, includeCitationCoverageFindings: true});
    expect(strict.findings).toMatchObject([{category: 'citation-unknown', classification: 'coverage'}]);
    expect(strict.status).toBe('unknown');
  });

  it('uses one stable relation target identity for aliases, direct URIs and archived redirects', () => {
    const target = record('threadnote://user/me/archive/target.md', 'target', {
      memoryId: 'tn_target',
      status: 'archived',
      archivedFrom: 'threadnote://user/me/memories/target.md',
    });
    const selectors = [target.uri, target.metadata.archivedFrom!, 'threadnote://memory/tn_target'];
    const source = record('threadnote://user/me/memories/source.md', 'source', {
      memoryId: 'tn_source',
      relations: selectors.map(uri => ({type: 'references' as const, uri})),
    });
    const corpus = [source, target];
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: corpus,
      relationEvidence: selectors.map(targetUri => ({sourceUri: source.uri, targetUri, status: 'inactive' as const})),
    });
    expect(new Set(report.findings.map(finding => finding.caseId)).size).toBe(1);
    for (const selector of selectors)
      expect(resolveContextHealthRelationTargetV2(corpus, selector)).toMatchObject({
        state: 'inactive',
        record: {metadata: {memoryId: 'tn_target'}},
      });
    expect(report.findings.every(finding => finding.caseIdentity?.slot === 'tn_target')).toBe(true);
    const conflicting = {...target, uri: 'threadnote://user/me/archive/other-target.md'};
    expect(resolveContextHealthRelationTargetV2([...corpus, conflicting], 'threadnote://memory/tn_target')).toEqual({
      state: 'conflicted',
    });
    expect(resolveContextHealthRelationTargetV2([...corpus, conflicting], target.metadata.archivedFrom!)).toEqual({
      state: 'conflicted',
    });
  });

  it('keeps historical provenance separate from current source and human decisions', () => {
    const source = record('threadnote://memory/historical', 'source', {
      relations: [{type: 'evidence_for', uri: 'threadnote://memory/archived'}],
    });
    const historical = {...receipt('unknown', 'repository-unavailable'), provenance: 'historical-verified' as const};
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [{uri: source.uri, receipts: [historical]}],
      relationEvidence: [{sourceUri: source.uri, targetUri: 'threadnote://memory/archived', status: 'inactive'}],
    });
    expect(report.findings).toMatchObject([{category: 'relation-target-inactive', classification: 'historical'}]);
    expect(report.maintenance).toMatchObject({
      actionableFindings: 0,
      historicalFindings: 1,
      citationCoverage: {currentVerified: 0, historicalVerified: 1, checked: 0, state: 'unavailable'},
    });
    expect(report.status).toBe('unknown');
  });

  it('keeps shared structural changes in the authority decision queue', () => {
    const source = record('threadnote://memory/shared', 'source', {
      visibility: 'shared',
      validTo: '2026-09-16',
      relations: [{type: 'depends_on', uri: 'threadnote://memory/missing'}],
    });
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      relationEvidence: [{sourceUri: source.uri, targetUri: 'threadnote://memory/missing', status: 'missing'}],
    });
    expect(report.maintenance).toMatchObject({
      actionableFindings: 2,
      automaticallyManagedFindings: 0,
      affectedMemories: 1,
    });
  });

  it('distinguishes uncertain applicability from extraction coverage and finding confidence', () => {
    for (const knownEnvironment of [false, true]) {
      for (const knownValidity of [false, true]) {
        const metadata = knownValidity ? {validFrom: '2026-01-01', validTo: '2027-01-01'} : {};
        const environment = knownEnvironment ? 'production ' : '';
        const report = buildContextHealthReport({
          now,
          project: 'threadnote',
          records: [
            record('threadnote://memory/tn_left', `The ${environment}request timeout is 30 seconds.`, metadata),
            record('threadnote://memory/tn_right', `The ${environment}request timeout is 60 seconds.`, metadata),
          ],
        });
        const finding = report.findings.find(item => item.category === 'semantic-contradiction');
        expect(report.semanticCompleteness).toMatchObject({state: 'complete', supportedClaims: 2});
        expect(finding).toMatchObject({
          confidence: knownEnvironment && knownValidity ? 'medium' : 'low',
          repairability: 'manual-review',
          semanticEvidence: {
            classification: knownEnvironment && knownValidity ? 'incompatibility' : 'uncertain-comparison',
          },
        });
      }
    }
  });

  it('keeps extraction coverage truthful when exact reviewed comparisons leave the queue', () => {
    fc.assert(
      fc.property(fc.integer({min: 2, max: 5}), count => {
        const records = Array.from({length: count}, (_, index) =>
          record(`threadnote://memory/tn_${index}`, `The production request timeout is ${index + 1} seconds.`, {
            validFrom: '2026-01-01',
            validTo: '2027-01-01',
          }),
        );
        const before = structuredClone(records);
        const input = {now, project: 'threadnote', records};
        const report = buildContextHealthReport(input);
        const selected = report.findings.find(item => item.category === 'semantic-contradiction')!;
        const contradictionId = selected.semanticEvidence!.contradictionId;
        const reviewed = buildContextHealthReport({
          ...input,
          reviewedSemanticContradictionIds: [contradictionId, contradictionId, 'unrelated-id'],
        });
        expect(reviewed.findings).toEqual(report.findings.filter(item => item.id !== selected.id));
        expect(reviewed.semanticCompleteness).toEqual(report.semanticCompleteness);
        const changedUri = selected.semanticEvidence!.left.recordUri;
        const changed = records.map(item =>
          item.uri === changedUri ? record(item.uri, `${item.body}\nAdditional source context.`, item.metadata) : item,
        );
        const fresh = buildContextHealthReport({now, project: 'threadnote', records: changed});
        expect(
          buildContextHealthReport({
            now,
            project: 'threadnote',
            records: changed,
            reviewedSemanticContradictionIds: [contradictionId],
          }).findings,
        ).toEqual(fresh.findings);
        expect(records).toEqual(before);
      }),
      {numRuns: 24, seed: 753},
    );
  });

  it('reports semantic limits without manufacturing actionable content findings', () => {
    const records = Array.from({length: 130}, (_, index) =>
      record(`threadnote://memory/tn_${index}`, `Unique module claim ${index}.`),
    );
    const report = buildContextHealthReport({now, project: 'threadnote', records});
    expect(report.maintenance?.actionableFindings).toBe(0);
    expect(report.maintenance?.semanticCoverage).toMatchObject({
      state: 'unavailable',
      eligibleRecords: 130,
      unknownRecords: 130,
    });
    expect(report.status).toBe('unknown');
  });

  it('projects guidance drift onto source memory URIs without a target path', () => {
    const source = record('threadnote://user/me/memories/durable/projects/threadnote/guidance.md', 'guidance');
    const report = buildContextHealthReport({
      guidanceEvidence: [{sourceUris: [source.uri], state: 'locally-modified'}],
      now,
      project: 'threadnote',
      records: [source],
    });
    expect(report.findings).toMatchObject([
      {category: 'guidance-locally-modified', repair: {kind: 'repair-guidance'}, uris: [source.uri]},
    ]);
    expect(JSON.stringify(report)).not.toContain('AGENTS.md');
  });

  it('keeps stale and unavailable guidance evidence when a source is no longer active', () => {
    const source = record('threadnote://user/me/memories/durable/projects/threadnote/retired.md', 'retired', {
      status: 'archived',
    });
    const report = buildContextHealthReport({
      guidanceEvidence: [
        {sourceUris: [source.uri], state: 'stale-sources'},
        {sourceUris: [source.uri], state: 'unavailable'},
      ],
      includeFindingUris: [source.uri],
      now,
      project: 'threadnote',
      records: [source],
    });
    expect(report.findings.map(finding => finding.category)).toEqual([
      'guidance-unavailable',
      'guidance-stale-sources',
    ]);
    expect(report.findings.every(finding => finding.uris.includes(source.uri))).toBe(true);
  });

  it('reports independently actionable health findings from supplied evidence', () => {
    const expired = record('threadnote://user/me/memories/durable/projects/threadnote/expired.md', 'expired', {
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const reviewed = record('threadnote://user/me/memories/durable/projects/threadnote/review.md', 'review', {
      reviewAfter: '2026-09-16',
    });
    const cited = record('threadnote://user/me/memories/durable/projects/threadnote/cited.md', 'citation');
    const related = record('threadnote://user/me/memories/durable/projects/threadnote/related.md', 'relation', {
      relations: [
        {type: 'depends_on', uri: 'threadnote://memory/tn_missing'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_inactive'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_conflicted'},
      ],
    });
    const first = record('threadnote://user/me/memories/durable/projects/threadnote/first.md', 'same body');
    const second = record('threadnote://user/me/memories/durable/projects/threadnote/second.md', 'same body');

    const report = buildContextHealthReport({
      candidateEvidence: [
        {candidateId: 'contradiction', comparison: 'contradiction', project: 'threadnote'},
        {candidateId: 'possible', comparison: 'possible_duplicate', project: 'threadnote'},
      ],
      citationValidations: [
        {
          receipts: [
            receipt('changed', 'source-changed'),
            receipt('deleted', 'source-deleted'),
            receipt('unknown', 'repository-unavailable'),
          ],
          uri: cited.uri,
        },
      ],
      now,
      project: 'threadnote',
      records: [
        second,
        related,
        cited,
        reviewed,
        expired,
        first,
        record('threadnote://user/me/memories/durable/projects/other/other.md', 'other', {project: 'other'}),
      ],
      relationEvidence: [
        {sourceUri: related.uri, status: 'missing', targetUri: 'threadnote://memory/tn_missing'},
        {sourceUri: related.uri, status: 'inactive', targetUri: 'threadnote://memory/tn_inactive'},
        {sourceUri: related.uri, status: 'conflicted', targetUri: 'threadnote://memory/tn_conflicted'},
      ],
    });

    expect(report.findings.map(finding => finding.category)).toEqual([
      'validity-expired',
      'citation-changed',
      'citation-missing',
      'relation-target-missing',
      'relation-target-inactive',
      'relation-target-conflicted',
      'review-overdue',
      'exact-duplicate',
      'candidate-contradiction',
      'candidate-possible-duplicate',
      'citation-unknown',
    ]);
    expect(report.findings.every(finding => finding.repair !== undefined)).toBe(true);
    expect(report.findings.find(finding => finding.category === 'citation-unknown')).toMatchObject({
      confidence: 'low',
      repairability: 'requires-evidence',
    });
    expect(report.recordsScanned).toBe(6);
  });

  it('is deterministic, bounded, and does not mutate inputs', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,12}$/u), {maxLength: 40}), values => {
        const records = values.map((body, index) =>
          record(`threadnote://user/me/memories/durable/projects/threadnote/${index}.md`, body, {
            validTo: index % 2 === 0 ? '2026-09-16T00:00:00.000Z' : undefined,
          }),
        );
        const original = structuredClone(records);
        const input = {limit: 7, now, project: 'threadnote', records};
        const first = buildContextHealthReport(input);
        const second = buildContextHealthReport({...input, records: [...records].reverse()});
        expect(first).toEqual(second);
        expect(first.findings.length).toBeLessThanOrEqual(7);
        expect(first.omittedFindings).toBeGreaterThanOrEqual(0);
        expect(records).toEqual(original);
      }),
      {numRuns: 50},
    );
  });

  it('applies URI scoping before the finding limit while retaining cross-record evidence', () => {
    fc.assert(
      fc.property(fc.integer({min: 101, max: 180}), unrelatedCount => {
        const affected = record('threadnote://user/me/memories/durable/projects/threadnote/affected.md', 'same body');
        const duplicate = record('threadnote://user/me/memories/durable/projects/threadnote/duplicate.md', 'same body');
        const unrelated = Array.from({length: unrelatedCount}, (_, index) =>
          record(`threadnote://user/me/memories/durable/projects/threadnote/unrelated-${index}.md`, `${index}`, {
            validTo: '2026-09-16T00:00:00.000Z',
          }),
        );
        const duplicateCorpus = [...unrelated, duplicate, affected];
        const broad = buildContextHealthReport({
          duplicateCorpus,
          now,
          project: 'threadnote',
          records: [duplicate, affected],
        });
        const duplicateFinding = broad.findings.find(finding => finding.category === 'exact-duplicate');
        const selected = [duplicate, affected].find(item => item.uri === duplicateFinding?.repair.subjectUri);
        if (selected === undefined) throw new Error('expected exact duplicate subject');
        const report = buildContextHealthReport({
          duplicateCorpus,
          includeFindingUris: [selected.uri],
          now,
          project: 'threadnote',
          records: [selected],
        });

        expect(report.findings).toEqual([expect.objectContaining({category: 'exact-duplicate'})]);
        expect(report.omittedFindings).toBe(0);
      }),
      {numRuns: 20},
    );
  });

  it('uses the full duplicate corpus while admitting only a selected duplicate subject', () => {
    const first = record('threadnote://user/me/memories/durable/projects/threadnote/first.md', 'same body');
    const second = record('threadnote://user/me/memories/durable/projects/threadnote/second.md', 'same body');
    const broad = buildContextHealthReport({now, project: 'threadnote', records: [first, second]});
    const duplicate = broad.findings.find(finding => finding.category === 'exact-duplicate');
    expect(duplicate?.repair.subjectUri).toBeDefined();
    expect(duplicate?.repair.targetUri).toBeDefined();
    const subject = [first, second].find(item => item.uri === duplicate?.repair.subjectUri);
    const survivor = [first, second].find(item => item.uri === duplicate?.repair.targetUri);
    if (subject === undefined || survivor === undefined) throw new Error('expected duplicate subject and survivor');

    const selectedSubject = buildContextHealthReport({
      duplicateCorpus: [first, second],
      includeFindingUris: [subject.uri],
      now,
      project: 'threadnote',
      records: [subject],
    });
    expect(selectedSubject.findings).toEqual([
      expect.objectContaining({
        category: 'exact-duplicate',
        repair: expect.objectContaining({subjectUri: subject.uri, targetUri: survivor.uri}),
      }),
    ]);
    const selectedSurvivor = buildContextHealthReport({
      duplicateCorpus: [first, second],
      includeFindingUris: [survivor.uri],
      now,
      project: 'threadnote',
      records: [survivor],
    });
    expect(selectedSurvivor.findings).toEqual([]);
  });

  it('preserves legacy any-match filtering for internal report consumers', () => {
    const affected = record('threadnote://memory/affected', 'affected', {reviewAfter: '2026-09-16'});
    const unrelated = record('threadnote://memory/unrelated', 'unrelated', {
      relations: [{type: 'depends_on', uri: 'threadnote://memory/conflicted'}],
    });
    const report = buildContextHealthReport({
      includeFindingCategories: ['relation-target-conflicted'],
      includeFindingUris: [affected.uri],
      now,
      project: 'threadnote',
      records: [unrelated, affected],
      relationEvidence: [
        {sourceUri: unrelated.uri, status: 'conflicted', targetUri: 'threadnote://memory/conflicted'},
        {sourceUri: unrelated.uri, status: 'missing', targetUri: 'threadnote://memory/missing'},
      ],
    });

    expect(report.findings.map(finding => finding.category)).toEqual(['relation-target-conflicted', 'review-overdue']);
  });

  it('intersects normalized user selectors across category and URI filters', () => {
    const affected = record('threadnote://memory/affected', 'affected', {reviewAfter: '2026-09-16'});
    const unrelated = record('threadnote://memory/unrelated', 'unrelated', {
      relations: [{type: 'depends_on', uri: 'threadnote://memory/conflicted'}],
    });
    const report = buildContextHealthReport({
      includeFindingCategories: ['relation-target-conflicted'],
      includeFindingCombination: 'all',
      includeFindingUris: [affected.uri],
      now,
      project: 'threadnote',
      records: [unrelated, affected],
      relationEvidence: [
        {sourceUri: unrelated.uri, status: 'conflicted', targetUri: 'threadnote://memory/conflicted'},
        {sourceUri: unrelated.uri, status: 'missing', targetUri: 'threadnote://memory/missing'},
      ],
    });

    expect(report.findings).toEqual([]);
  });
});

function receipt(
  status: 'changed' | 'deleted' | 'unknown',
  reason: 'repository-unavailable' | 'source-changed' | 'source-deleted',
) {
  return {
    candidateCount: 0,
    citationId: `tncc_${status}`,
    coverage: status === 'unknown' ? ('incomplete' as const) : ('current-complete' as const),
    kind: 'file' as const,
    observedAt: now.toISOString(),
    reason,
    status,
    strategy: 'none' as const,
    validatorVersion: 1 as const,
  };
}

function citation(name: string) {
  return createMemoryCodeCitation({
    extractorSet: 'fixture',
    fileContentHash: {algorithm: 'sha256' as const, value: '1'.repeat(64)},
    path: `src/${name}.ts`,
    repositoryId: '3'.repeat(64),
    repositoryIdentityKind: 'remote' as const,
    sourceCommit: '2'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
    target: {kind: 'file' as const},
    version: 1 as const,
  });
}
