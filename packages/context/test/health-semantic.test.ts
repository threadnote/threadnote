import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {analyzeContextHealthSemantics} from '../src/health_semantic.js';
import type {MemoryMetadata, MemoryRecord} from '@threadnote/memory/document';

function record(name: string, body: string, metadata: Partial<MemoryMetadata> = {}): MemoryRecord {
  return {
    body,
    content: body,
    headerTitle: 'MEMORY',
    uri: `threadnote://memory/${name}`,
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-10-01',
      ...metadata,
    },
  };
}
function analyze(left: string, right: string, a: Partial<MemoryMetadata> = {}, b: Partial<MemoryMetadata> = {}) {
  return analyzeContextHealthSemantics({project: 'threadnote', records: [record('a', left, a), record('b', right, b)]});
}
const interval = {validFrom: '2026-01-01', validTo: '2027-01-01'};

describe('scoped English semantic review', () => {
  it('preserves project, lifecycle, and durable-kind isolation', () => {
    const positive = record('positive', 'Deployments must use signed artifacts.');
    const negative = record('negative', 'Deployments must not use signed artifacts.');
    const otherProject = record('other-project', 'Deployments must not use signed artifacts.', {project: 'other'});
    const archived = record('archived', 'Deployments must not use signed artifacts.', {status: 'archived'});
    const handoff = record('handoff', 'Deployments must not use signed artifacts.', {kind: 'handoff'});

    const analysis = analyzeContextHealthSemantics({
      project: 'threadnote',
      records: [negative, otherProject, archived, handoff, positive],
    });
    expect(analysis.completeness).toMatchObject({eligibleRecords: 2, state: 'complete'});
    expect(analysis.contradictions).toHaveLength(1);
    expect(new Set([analysis.contradictions[0]?.left.recordUri, analysis.contradictions[0]?.right.recordUri])).toEqual(
      new Set([positive.uri, negative.uri]),
    );
  });

  it('is deterministic, order-invariant, and does not mutate records', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{3,12}$/u), {minLength: 1, maxLength: 24}),
        fc.array(fc.boolean(), {minLength: 1, maxLength: 24}),
        (subjects, polarities) => {
          const records = subjects.map((subject, index) =>
            record(
              `${subject}-${index}`,
              `${subject} must${polarities[index % polarities.length] ? ' not' : ''} retain verified context.`,
            ),
          );
          const original = structuredClone(records);
          const first = analyzeContextHealthSemantics({project: 'threadnote', records});
          const second = analyzeContextHealthSemantics({project: 'threadnote', records: [...records].reverse()});
          expect(second).toEqual(first);
          expect(records).toEqual(original);
        },
      ),
      {numRuns: 75},
    );
  });

  it('does not interpret environment-named identifier values as applicability', () => {
    for (const heading of ['', '# Production\n']) {
      const finding = analyze(
        `${heading}Deployment mode is production.`,
        `${heading}Deployment mode is staging.`,
        interval,
        interval,
      ).contradictions[0];
      expect(finding?.reason).toBe('incompatible-values');
      expect(finding?.uncertainty).not.toContain('ambiguous-environment');
      expect(finding?.left.context.environment).toBe(heading ? 'production' : undefined);
      expect(
        analyze(
          `${heading}Deployment mode is one of [production, local].`,
          `${heading}Deployment mode is staging.`,
          interval,
          interval,
        ).contradictions,
      ).toHaveLength(1);
      expect(
        analyze(
          `${heading}Deployment mode is one of [production, local].`,
          `${heading}Deployment mode is production.`,
          interval,
          interval,
        ).contradictions,
      ).toEqual([]);
    }
  });
  it('requires lexical boundaries for word operators without requiring spaces around symbols', () => {
    const modal = analyze(
      'Agents must retain deterministic evidence.',
      'Agents must not retain deterministic evidence.',
    );
    expect(modal.completeness).toMatchObject({state: 'complete', supportedClaims: 2, unsupportedClaims: 0});
    expect(modal.contradictions[0]?.left.extraction).toBe('explicit-polarity');
    expect(modal.contradictions[0]?.reason).toBe('opposite-polarity');
    expect(
      analyze('Production timeout=30 seconds.', 'Production timeout=60 seconds.', interval, interval).contradictions,
    ).toHaveLength(1);
    expect(
      analyze('Agents must never reuse verified context.', 'Agents must reuse verified context.').contradictions[0]
        ?.reason,
    ).toBe('opposite-polarity');
  });
  it('covers the three reported failures and retains clear negation', () => {
    expect(
      analyze('Deployments must use signed artifacts.', 'Deployments must not use signed artifacts.').contradictions,
    ).toHaveLength(1);
    expect(
      analyze(
        'The production request timeout is 30 seconds.',
        'The production request timeout is 60 seconds.',
        interval,
        interval,
      ).contradictions[0],
    ).toMatchObject({classification: 'incompatibility', reason: 'incompatible-values'});
    expect(
      analyze('Production deployments must use signed artifacts.', 'Local deployments must not use signed artifacts.')
        .contradictions,
    ).toEqual([]);
  });
  it('inherits headings, keeps context, and separates headings-only scopes', () => {
    expect(
      analyze('# Production\nThe request timeout is 30 seconds.', '# Local\nThe request timeout is 60 seconds.')
        .contradictions,
    ).toEqual([]);
    expect(
      analyze('# Production\nThe request timeout is 30 seconds.', '# Production\nThe request timeout is 60 seconds.')
        .contradictions[0]?.left,
    ).toMatchObject({
      text: 'The request timeout is 30 seconds.',
      context: {headings: ['Production'], environment: 'production', project: 'threadnote'},
    });
  });
  it('compares normalized units, operators, ranges, and finite sets', () => {
    expect(
      analyze('The production timeout is 30 seconds.', 'The production timeout is 30,000 milliseconds.').contradictions,
    ).toEqual([]);
    expect(analyze('Production timeout = 30 seconds.', 'Production timeout <= 60 seconds.').contradictions).toEqual([]);
    expect(
      analyze('Production timeout is between 20 and 40 seconds.', 'Production timeout is 30 seconds.').contradictions,
    ).toEqual([]);
    expect(
      analyze('Production timeout < 30 seconds.', 'Production timeout >= 30 seconds.').contradictions,
    ).toHaveLength(1);
    expect(
      analyze('Production storage engine is one of [sqlite, postgres].', 'Production storage engine is postgres.')
        .contradictions,
    ).toEqual([]);
    expect(
      analyze('Production storage engine is sqlite.', 'Production storage engine is postgres.').contradictions,
    ).toHaveLength(1);
  });
  it('compares overlapping workspace roots and half-open explicit validity periods', () => {
    const left = 'Production timeout is 30 seconds.';
    const right = 'Production timeout is 60 seconds.';
    expect(analyze(left, right, {workspaceScope: 'apps/web'}, {workspaceScope: 'apps/api'}).contradictions).toEqual([]);
    expect(analyze(left, right, {workspaceScope: 'apps'}, {workspaceScope: 'apps/web'}).contradictions).toHaveLength(1);
    expect(
      analyze(
        left,
        right,
        {validFrom: '2026-01-01', validTo: '2026-02-01'},
        {validFrom: '2026-02-01', validTo: '2026-03-01'},
      ).contradictions,
    ).toEqual([]);
    expect(
      analyze(left, right, interval, {validFrom: '2026-06-01', validTo: '2028-01-01'}).contradictions,
    ).toHaveLength(1);
  });
  it('reports unknown applicability and unsupported extraction independently of confidence', () => {
    expect(analyze('Timeout is 30 seconds.', 'Timeout is 60 seconds.').contradictions[0]).toMatchObject({
      classification: 'uncertain-comparison',
      uncertainty: expect.arrayContaining(['unknown-environment', 'unknown-validity']),
    });
    expect(
      analyze(
        'Production timeout is 30 seconds.',
        'Production timeout is 60 seconds.',
        {validFrom: 'yesterday'},
        interval,
      ).contradictions[0]?.uncertainty,
    ).toContain('invalid-validity');
    expect(
      analyze(
        'Maybe production timeout is approximately 30 seconds.',
        'Maybe production timeout is approximately 60 seconds.',
      ).completeness.unknownReasons,
    ).toContainEqual({reason: 'unsupported-extraction', count: 2});
  });
  it('distinguishes policy violations and preserves historical claims as history', () => {
    expect(
      analyze('Production timeout is 60 seconds.', 'Production timeout must be 30 seconds.', interval, interval)
        .contradictions[0],
    ).toMatchObject({reason: 'policy-conflict', left: {role: 'descriptive'}, right: {role: 'normative'}});
    expect(
      analyze('# History\nProduction timeout was 60 seconds.', 'Production timeout is 30 seconds.').contradictions,
    ).toEqual([]);
  });
  it('binds exact body spans and content revisions, including repeated text in different sections', () => {
    const body = '# Production\r\n- Timeout is 30 seconds.\r\n# Local\r\n- Timeout is 30 seconds.';
    const finding = analyze(body, '# Production\nTimeout is 60 seconds.').contradictions[0];
    expect(finding).toBeDefined();
    const claim = finding.left;
    expect(body.slice(claim.span.start, claim.span.end)).toBe(claim.text);
    expect(claim.recordContentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(analyze(body + '\n', '# Production\nTimeout is 60 seconds.').contradictions[0]?.contradictionId).not.toBe(
      finding.contradictionId,
    );
    expect(
      analyzeContextHealthSemantics({project: 'threadnote', records: [record('a', body)]}).completeness.claimsAnalyzed,
    ).toBe(2);
  });
  it('supports fractional unit conversion and abstains on ambiguous applicability and prose values', () => {
    expect(
      analyze('Production timeout is 1.001 seconds.', 'Production timeout is 1001 milliseconds.').contradictions,
    ).toEqual([]);
    expect(
      analyze('# Local\nProduction timeout is 30 seconds.', '# Production\nTimeout is 60 seconds.', interval, interval)
        .contradictions[0]?.uncertainty,
    ).toContain('ambiguous-environment');
    expect(analyze('Production timeout is high.', 'Production timeout is low.').completeness.unsupportedClaims).toBe(2);
    expect(
      analyze('Production timeout is 30 seconds.', 'Production timeout is 30 bytes.', interval, interval)
        .contradictions[0],
    ).toMatchObject({reason: 'unsupported-interpretation', classification: 'uncertain-comparison'});
    expect(
      analyze(
        'Repository-wide deployments must use signed artifacts.',
        'Production deployments must not use signed artifacts.',
        interval,
        interval,
      ).contradictions[0]?.classification,
    ).toBe('incompatibility');
  });
  it('identifies heading spans and metadata revisions without choosing by ingestion order', () => {
    const body = '# Production\nTimeout is 30 seconds.';
    const first = analyze(
      body,
      '# Production\nTimeout is 60 seconds.',
      {...interval, timestamp: '2026-01-01'},
      {...interval, timestamp: '2026-02-01'},
    );
    const context = first.contradictions[0].left.context;
    expect(body.slice(context.headingEvidence[0].span.start, context.headingEvidence[0].span.end)).toBe('Production');
    expect(
      analyze(body, '# Production\nTimeout is 60 seconds.', {...interval, workspaceScope: 'apps/web'}, interval)
        .contradictions[0]?.left.claimFingerprint,
    ).not.toBe(first.contradictions[0]?.left.claimFingerprint);
    expect(
      analyze(
        body,
        '# Production\nTimeout is 60 seconds.',
        {...interval, timestamp: '2026-02-01'},
        {...interval, timestamp: '2026-01-01'},
      ).contradictions[0]?.reason,
    ).toBe(first.contradictions[0]?.reason);
  });
  it('is order invariant and never mutates lifecycle or source input', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 1000}), n => {
        const records = [
          record('a', `Production timeout is ${n} seconds.`),
          record('b', `Production timeout is ${n + 1} seconds.`),
        ];
        const original = structuredClone(records);
        const first = analyzeContextHealthSemantics({project: 'threadnote', records});
        expect(analyzeContextHealthSemantics({project: 'threadnote', records: [...records].reverse()})).toEqual(first);
        expect(first.contradictions).toHaveLength(1);
        expect(records).toEqual(original);
      }),
      {numRuns: 60},
    );
  });
  it('equivalent units and compatible constraints never conflict', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 1000}), n => {
        expect(
          analyze(`Production timeout is ${n} seconds.`, `Production timeout is ${n * 1000} milliseconds.`)
            .contradictions,
        ).toEqual([]);
        expect(
          analyze(`Production timeout = ${n} seconds.`, `Production timeout <= ${n + 1} seconds.`).contradictions,
        ).toEqual([]);
      }),
      {numRuns: 60},
    );
  });
  it('disjoint periods never conflict and overlapping incompatible values require review', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 20}), fc.integer({min: 1, max: 1000}), (day, n) => {
        const date = (d: number) => `2026-01-${String(d).padStart(2, '0')}`;
        const a = {validFrom: date(day), validTo: date(day + 1)};
        const b = {validFrom: date(day + 1), validTo: date(day + 2)};
        expect(
          analyze(`Production timeout is ${n} seconds.`, `Production timeout is ${n + 1} seconds.`, a, b)
            .contradictions,
        ).toEqual([]);
        expect(
          analyze(`Production timeout is ${n} seconds.`, `Production timeout is ${n + 1} seconds.`, a, a)
            .contradictions[0]?.classification,
        ).toBe('incompatibility');
      }),
      {numRuns: 60},
    );
  });
});
