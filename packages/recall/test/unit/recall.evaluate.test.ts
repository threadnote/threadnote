import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {evaluateRecallFixture, parseRecallEvaluationFixture} from '@threadnote/recall/evaluate';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('recall evaluation contract v1', () => {
  it('classifies any query batch with no candidates without mutating its fixture', () => {
    fc.assert(
      fc.property(fc.array(fc.string({maxLength: 40}), {minLength: 1, maxLength: 10}), queries => {
        const fixture = {
          version: 1 as const,
          documents: [],
          queries: EffectArray.map(queries, (query, index) => ({
            id: String(index),
            query,
            expectedAnswerability: 'no_answer' as const,
            relevance: {},
          })),
        };
        const before = structuredClone(fixture);
        const result = evaluateRecallFixture(fixture);
        expect(result.failures).toEqual([]);
        expect(result.metrics.noAnswerPrecision).toBe(1);
        expect(result.metrics.noAnswerRecall).toBe(1);
        expect(
          EffectArray.every(
            result.queryResults,
            query => query.confidence === 'no_answer' && query.rankedUris.length === 0,
          ),
        ).toBe(true);
        expect(fixture).toEqual(before);
      }),
      {numRuns: 50},
    );
  });

  it('meets the checked-in ranking, lifecycle, explanation, and no-answer contract', async () => {
    const raw = await readFile('apps/threadnote/test/evaluation/fixtures/recall-v1/fixture.json', 'utf8');
    const result = evaluateRecallFixture(parseRecallEvaluationFixture(JSON.parse(raw)));

    expect(result.failures).toEqual([]);
    expect(result.metrics.meanNdcgAt5).toBeGreaterThanOrEqual(0.95);
    expect(result.metrics.meanReciprocalRank).toBe(1);
    expect(result.metrics.recallAt5).toBe(1);
    expect(result.metrics.noAnswerPrecision).toBe(1);
    expect(result.metrics.noAnswerRecall).toBe(1);
    expect(result.metrics.requiredReasonsPresent).toBe(true);
    expect(result.metrics.staleHitRate).toBe(0);

    const paraphrases = EffectArrayPipe(result.queryResults, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (query, __effectArrayIndex) =>
          __effectArrayIndex in __effectArrayValues && Effect.pipe(query.id, EffectString.startsWith('paraphrase-')),
      ),
    );
    expect(paraphrases).toHaveLength(4);
    expect(EffectArray.every(paraphrases, query => query.expanded && query.initialConfidence !== 'high')).toBe(true);
    expect(EffectArray.every(paraphrases, query => query.rankedUris.length > 0)).toBe(true);
  });
});
