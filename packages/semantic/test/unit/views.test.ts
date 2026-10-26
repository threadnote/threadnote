import {Schema} from 'effect';
import fc from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
import {observationKey} from '../../src/contracts.js';
import {createQuerySnapshot, queryPage, type Continuation} from '../../src/views.js';
import {hash, observation, evidence} from '../fixtures.js';

describe('semantic pagination', () => {
  it('preserves order, duplicates and coverage across bounded pages against an independent array model', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({maxLength: 80}), {maxLength: 60}),
        fc.integer({min: 1, max: 12}),
        (items, pageSize) => {
          const snapshot = createQuerySnapshot({
            id: 'snapshot',
            query: hash('d'),
            evidence,
            items,
          });
          let cursor: Continuation | undefined;
          const actual: Schema.Json[] = [];
          let pages = 0;
          do {
            const result = queryPage(snapshot, observation, hash('d'), {maxItems: pageSize, maxBytes: 30_000}, cursor);
            expect(result.status).toBe('page');
            if (result.status !== 'page') throw new Error('Expected page');
            expect(result.page.items.length).toBeLessThanOrEqual(pageSize);
            expect(result.page.evidence).toEqual(evidence);
            expect(result.encodedBytes).toBe(new TextEncoder().encode(JSON.stringify(result.page)).length);
            expect(result.encodedBytes).toBeLessThanOrEqual(30_000);
            actual.push(...result.page.items);
            expect(result.page.remaining).toBe(items.length - actual.length);
            cursor = result.page.next ?? undefined;
            expect(++pages).toBeLessThanOrEqual(items.length + 1);
          } while (cursor);
          expect(actual).toEqual(items);
        },
      ),
      {numRuns: 100},
    );
  });

  it('rejects stale observations, changed queries and forged cursor identity without mixing snapshots', () => {
    const snapshot = createQuerySnapshot({
      id: 'snapshot',
      query: hash('d'),
      evidence,
      items: ['a', 'b'],
    });
    const first = queryPage(snapshot, observation, hash('d'), {
      maxItems: 1,
      maxBytes: 30_000,
    });
    if (first.status !== 'page' || !first.page.next) throw new Error('Expected cursor');
    const budget = {maxItems: 1, maxBytes: 30_000};
    expect(queryPage(snapshot, {...observation, documentVersion: 2}, hash('d'), budget, first.page.next).status).toBe(
      'stale',
    );
    expect(queryPage(snapshot, observation, hash('e'), budget, first.page.next).status).toBe('stale');
    for (const offset of [-1, 0, 2, 1.5, NaN])
      expect(
        queryPage(snapshot, observation, hash('d'), budget, {
          ...first.page.next,
          offset,
        }).status,
      ).toBe('invalid-cursor');
    expect(
      queryPage(snapshot, observation, hash('d'), budget, {
        ...first.page.next,
        snapshot: 'another',
      }).status,
    ).toBe('invalid-cursor');
  });

  it('protects retained data from caller mutation and reports budgets too small for progress', () => {
    const input = {
      id: 'snapshot',
      query: hash('d'),
      evidence: structuredClone(evidence),
      items: [{text: '😀\r\n'.repeat(200)}],
    };
    const snapshot = createQuerySnapshot(input);
    input.items[0].text = 'changed';
    expect(snapshot.items).not.toEqual(input.items);
    expect(Object.isFrozen(snapshot.items[0])).toBe(true);
    expect(queryPage(snapshot, observation, hash('d'), {maxItems: 1, maxBytes: 1}).status).toBe('budget-exceeded');
    expect(
      queryPage(snapshot, observation, hash('d'), {
        maxItems: 0,
        maxBytes: 1000,
      }).status,
    ).toBe('invalid-budget');
  });

  it('selects the longest fitting prefix under tight UTF-8 budgets', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('😀', '\r\n', 'é', 'x'.repeat(40)), {
          minLength: 1,
          maxLength: 30,
        }),
        fc.integer({min: 1, max: 8000}),
        (items, maxBytes) => {
          const snapshot = createQuerySnapshot({
            id: 'snapshot',
            query: hash('d'),
            evidence,
            items,
          });
          const expected = Array.from({length: items.length}, (_, i) => {
            const count = i + 1;
            return {
              version: 1,
              status: 'ok',
              evidence,
              items: items.slice(0, count),
              offset: 0,
              remaining: items.length - count,
              next:
                count === items.length
                  ? null
                  : {
                      version: 1,
                      snapshot: 'snapshot',
                      query: hash('d'),
                      observation: observationKey(observation),
                      offset: count,
                    },
            };
          })
            .filter(page => new TextEncoder().encode(JSON.stringify(page)).length <= maxBytes)
            .at(-1);
          const result = queryPage(snapshot, observation, hash('d'), {
            maxItems: 1000,
            maxBytes,
          });
          if (!expected) expect(result.status).toBe('budget-exceeded');
          else {
            expect(result.status).toBe('page');
            if (result.status === 'page') {
              expect(result.page).toEqual(expected);
              expect(result.encodedBytes).toBeLessThanOrEqual(maxBytes);
            }
          }
        },
      ),
      {numRuns: 100},
    );
  });

  it('serializes item data once instead of every growing prefix', () => {
    const items = Array.from({length: 1000}, () => 'x'.repeat(16 * 1024));
    const snapshot = createQuerySnapshot({
      id: 'snapshot',
      query: hash('d'),
      evidence,
      items,
    });
    const spy = vi.spyOn(JSON, 'stringify');
    let calls: unknown[];
    try {
      queryPage(snapshot, observation, hash('d'), {
        maxItems: 1000,
        maxBytes: 8 * 1024 * 1024,
      });
      calls = spy.mock.calls.map(([value]) => value);
    } finally {
      spy.mockRestore();
    }
    expect(calls.reduce<number>((total, value) => total + JSON.stringify(value).length, 0)).toBeLessThan(
      17 * 1024 * 1024,
    );
  });
});
