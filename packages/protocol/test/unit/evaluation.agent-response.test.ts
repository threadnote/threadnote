import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  AgentResponseBudgetTooSmallError,
  encodedJsonBytes,
  estimatedAgentTokens,
  measureAgentToolResponse,
  projectRankedJsonPrefix,
} from '@threadnote/protocol/agent-response';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface TestEnvelope {
  readonly cards: readonly string[];
  readonly coverage: {readonly complete: boolean};
  readonly output: {readonly omittedCards: number};
  readonly trust: 'evidence-only';
}

function render(cards: readonly string[], omittedCards: number): TestEnvelope {
  return {
    cards,
    coverage: {complete: true},
    output: {omittedCards},
    trust: 'evidence-only',
  };
}

describe('agent response evaluation', () => {
  it('measures structured content and text instead of hiding duplicated context', () => {
    const measurement = measureAgentToolResponse({
      structuredContent: {cards: ['alpha']},
      text: 'alpha',
    });

    expect(measurement).toEqual({
      estimatedTokens: Math.ceil((encodedJsonBytes({cards: ['alpha']}) + 5) / 3),
      structuredBytes: encodedJsonBytes({cards: ['alpha']}),
      textBytes: 5,
      totalBytes: encodedJsonBytes({cards: ['alpha']}) + 5,
    });
  });

  it('uses a conservative, deterministic byte-to-token estimate', () => {
    expect(estimatedAgentTokens(0)).toBe(0);
    expect(estimatedAgentTokens(1)).toBe(1);
    expect(estimatedAgentTokens(3)).toBe(1);
    expect(estimatedAgentTokens(4)).toBe(2);
    expect(() => estimatedAgentTokens(-1)).toThrow(/non-negative safe integer/i);
  });

  it('returns the longest ranked prefix and an exact omission receipt', () => {
    const cards = ['first', 'second', 'third'];
    const twoCardBytes = encodedJsonBytes(render(cards.slice(0, 2), 1));
    const projection = projectRankedJsonPrefix(cards, twoCardBytes, render);

    expect(projection.value.cards).toEqual(['first', 'second']);
    expect(projection.value.output.omittedCards).toBe(1);
    expect(projection).toMatchObject({
      encodedBytes: twoCardBytes,
      omittedItems: 1,
      returnedItems: 2,
      truncated: true,
    });
  });

  it('finds the longest fitting prefix even when envelope size is not monotonic', () => {
    const cards = ['first', 'second'];
    const nonMonotonicRender = (prefix: readonly string[], omittedCards: number) => ({
      cards: prefix,
      omittedCards,
      padding: prefix.length === 1 ? Effect.pipe('x', EffectString.repeat(1_000)) : '',
    });
    const twoCardBytes = encodedJsonBytes(nonMonotonicRender(cards, 0));
    const projection = projectRankedJsonPrefix(cards, twoCardBytes, nonMonotonicRender);

    expect(projection.returnedItems).toBe(2);
    expect(projection.value.cards).toEqual(cards);
  });

  it('fails explicitly when required trust and coverage metadata cannot fit', () => {
    const minimum = encodedJsonBytes(render([], 1));
    expect(() => projectRankedJsonPrefix(['first'], minimum - 1, render)).toThrow(AgentResponseBudgetTooSmallError);
  });

  it('never exceeds the byte budget and retains the original ranked prefix', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({maxLength: 80}), {maxLength: 40}),
        fc.integer({min: 0, max: 4_000}),
        (cards, extraBytes) => {
          const minimum = encodedJsonBytes(render([], cards.length));
          const projection = projectRankedJsonPrefix(cards, minimum + extraBytes, render);
          expect(projection.encodedBytes).toBeLessThanOrEqual(minimum + extraBytes);
          expect(projection.value.cards).toEqual(cards.slice(0, projection.returnedItems));
          expect(projection.omittedItems + projection.returnedItems).toBe(cards.length);
          expect(projection.estimatedTokens).toBe(estimatedAgentTokens(projection.encodedBytes));
        },
      ),
      {numRuns: 150},
    );
  });

  it('larger budgets cannot reorder or remove a prefix that already fit', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({maxLength: 60}), {maxLength: 30}),
        fc.integer({min: 0, max: 2_000}),
        fc.integer({min: 0, max: 2_000}),
        (cards, firstExtra, secondExtra) => {
          const minimum = encodedJsonBytes(render([], cards.length));
          const smaller = minimum + Math.min(firstExtra, secondExtra);
          const larger = minimum + Math.max(firstExtra, secondExtra);
          const first = projectRankedJsonPrefix(cards, smaller, render);
          const second = projectRankedJsonPrefix(cards, larger, render);
          expect(second.returnedItems).toBeGreaterThanOrEqual(first.returnedItems);
          expect(second.value.cards.slice(0, first.returnedItems)).toEqual(first.value.cards);
        },
      ),
      {numRuns: 150},
    );
  });
});
