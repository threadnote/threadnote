import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {RECALL_LOW_CONFIDENCE_NOTE, buildRecallSections} from '@threadnote/recall/results';

describe('hybrid recall result presentation', () => {
  it('surfaces default-threshold semantic matches at the semantic confidence floor', () => {
    const uri = 'threadnote://user/me/memories/durable/projects/threadnote/coupon-proration.md';
    const sections = buildRecallSections([], [], 5, {
      allowSemanticRescue: true,
      indexedCandidates: [
        {
          authority: 'agent_generated',
          fields: {project: 'threadnote', title: 'Coupon proration', topic: 'coupon-proration'},
          kind: 'durable',
          semantic: 0.77,
          status: 'active',
          text: 'For online orders, apply coupons to merchandise before calculating sales tax.',
          timestamp: '2026-10-08T00:00:00.000Z',
          trust: 'inferred',
          uri,
        },
      ],
      minimumScore: 0.3,
      now: new Date('2026-10-08T00:00:00.000Z'),
      project: 'threadnote',
      query: 'Does reducing an invoice with a voucher change what portion incurs duty?',
    });

    expect(sections.ranked).toHaveLength(1);
    expect(sections.ranked[0]?.uri).toBe(uri);
    expect(sections.ranked[0]?.finalScore).toBeGreaterThanOrEqual(0.271);
    expect(sections.ranked[0]?.finalScore).toBeLessThan(0.3);
    expect(sections.ranked[0]?.score).toBeGreaterThan(0);
    expect(sections.ranked[0]?.rankSignals?.semantic).toBe(0.77);
    expect(sections.semanticSection).not.toContain('keyword-only:');
    expect(sections.semanticSection).not.toContain(RECALL_LOW_CONFIDENCE_NOTE);
    expect(sections.semanticSection).toContain('semantic_similarity');
  });

  it('keeps an explicitly configured topical threshold strict for semantic-only candidates', () => {
    const sections = buildRecallSections([], [], 5, {
      indexedCandidates: [
        {
          fields: {project: 'threadnote', title: 'Coupon proration', topic: 'coupon-proration'},
          semantic: 0.77,
          status: 'active',
          text: 'For online orders, apply coupons to merchandise before calculating sales tax.',
          timestamp: '2026-10-08T00:00:00.000Z',
          uri: 'threadnote://user/me/memories/durable/projects/threadnote/coupon-proration.md',
        },
      ],
      minimumScore: 0.3,
      now: new Date('2026-10-08T00:00:00.000Z'),
      project: 'threadnote',
      query: 'Does reducing an invoice with a voucher change what portion incurs duty?',
    });

    expect(sections.ranked).toEqual([]);
    expect(sections.confidence?.level).toBe('no_answer');
  });

  it('preserves the semantic-only rescue band across model scores below the default topical cutoff', () => {
    fc.assert(
      fc.property(fc.integer({max: 84, min: 77}), semanticPercent => {
        const uri = 'threadnote://user/me/memories/durable/projects/threadnote/coupon-proration.md';
        const sections = buildRecallSections([], [], 1, {
          allowSemanticRescue: true,
          indexedCandidates: [
            {
              authority: 'agent_generated',
              fields: {project: 'threadnote', title: 'Coupon proration', topic: 'coupon-proration'},
              kind: 'durable',
              semantic: semanticPercent / 100,
              status: 'active',
              text: 'For online orders, apply coupons to merchandise before calculating sales tax.',
              timestamp: '2026-10-08T00:00:00.000Z',
              trust: 'inferred',
              uri,
            },
          ],
          minimumScore: 0.3,
          now: new Date('2026-10-08T00:00:00.000Z'),
          project: 'threadnote',
          query: 'Does reducing an invoice with a voucher change what portion incurs duty?',
        });

        expect(sections.ranked[0]?.uri).toBe(uri);
        expect(sections.ranked[0]?.finalScore).toBeGreaterThanOrEqual(0.271);
        expect(sections.ranked[0]?.finalScore).toBeLessThan(0.3);
      }),
      {numRuns: 32},
    );
  });
});
