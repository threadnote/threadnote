import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_RESOLUTION_PASS_MAXIMUM,
  codeGraphResolutionPassAdmitted,
  nextPersistentUnresolvedReferenceBatchRows,
  persistentUnresolvedReferenceMaximumBatchRows,
} from '@threadnote/graph/store/resolution';
import {
  aggregatePersistentReferenceResolutionCapacityBoundaries,
  nextPersistentReferenceResolutionTransactionPages,
  PERSISTENT_FULL_RESOLUTION_MAXIMUM_TRANSACTION_PAGES,
  PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES,
  PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES,
  planPersistentReferenceResolutionPages,
} from '@threadnote/graph/store/resolution/core';

describe('code graph resolution pass bounds', () => {
  it('adapts unresolved publication without exceeding the workload-specific hydrated-row ceiling', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 1_000_000, min: 0}),
        fc.array(fc.integer({max: 60_000, min: 0}), {maxLength: 64}),
        (referenceRows, durations) => {
          const maximum = persistentUnresolvedReferenceMaximumBatchRows(referenceRows);
          let current = 1_500;
          for (const duration of durations) {
            const next = nextPersistentUnresolvedReferenceBatchRows(current, duration, referenceRows);
            expect(Number.isSafeInteger(next)).toBe(true);
            expect(next).toBeGreaterThanOrEqual(250);
            expect(next).toBeLessThanOrEqual(maximum);
            expect(next).toBeLessThanOrEqual(current * 2);
            if (duration >= 2_000 && duration <= 5_000) expect(next).toBe(current);
            else if (duration > 5_000) expect(next).toBeLessThanOrEqual(current);
            else expect(next).toBeGreaterThanOrEqual(current);
            current = next;
          }
        },
      ),
      {numRuns: 250},
    );
    const growth = (referenceRows: number) => {
      let current = 1_500;
      return Array.from(
        {length: 4},
        () => (current = nextPersistentUnresolvedReferenceBatchRows(current, 0, referenceRows)),
      );
    };
    expect(growth(149_999)).toEqual([3_000, 6_000, 10_000, 10_000]);
    expect(growth(150_000)).toEqual([3_000, 6_000, 12_000, 20_000]);
  });

  it('selects the wider ceiling only for finite safe large-graph reference counts', () => {
    fc.assert(
      fc.property(fc.integer({max: 149_999, min: 0}), referenceRows => {
        expect(persistentUnresolvedReferenceMaximumBatchRows(referenceRows)).toBe(10_000);
      }),
      {numRuns: 250},
    );
    fc.assert(
      fc.property(fc.integer({max: Number.MAX_SAFE_INTEGER, min: 150_000}), referenceRows => {
        expect(persistentUnresolvedReferenceMaximumBatchRows(referenceRows)).toBe(20_000);
      }),
      {numRuns: 250},
    );
    for (const invalid of [-1, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 149_999.5]) {
      expect(persistentUnresolvedReferenceMaximumBatchRows(invalid)).toBe(10_000);
    }
  });

  it('admits exactly the finite non-negative pass prefix', () => {
    fc.assert(
      fc.property(fc.integer({max: 1_000, min: -1_000}), completed => {
        expect(codeGraphResolutionPassAdmitted(completed)).toBe(
          completed >= 0 && completed < CODE_GRAPH_RESOLUTION_PASS_MAXIMUM,
        );
      }),
      {numRuns: 250},
    );
    expect(codeGraphResolutionPassAdmitted(Number.POSITIVE_INFINITY)).toBe(false);
    expect(codeGraphResolutionPassAdmitted(1.5)).toBe(false);
  });

  it('aggregates compatible page capacities without overflow or order dependence', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            finalFactBytes: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
            rowCount: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
          }),
          {maxLength: 16, minLength: 1},
        ),
        pages => {
          const boundaries = EffectArray.map(pages, page => ({
            ...page,
            operation: 'resolve persistent code graph references' as const,
          }));
          const expectedBytes = EffectArray.reduce(pages, 0n, (total, page) => total + BigInt(page.finalFactBytes));
          const expectedRows = EffectArray.reduce(pages, 0n, (total, page) => total + BigInt(page.rowCount));
          const maximum = BigInt(Number.MAX_SAFE_INTEGER);
          const expected = {
            finalFactBytes: Number(expectedBytes > maximum ? maximum : expectedBytes),
            operation: 'resolve persistent code graph references',
            rowCount: Number(expectedRows > maximum ? maximum : expectedRows),
          };
          expect(aggregatePersistentReferenceResolutionCapacityBoundaries(boundaries)).toEqual(expected);
          expect(aggregatePersistentReferenceResolutionCapacityBoundaries([...boundaries].reverse())).toEqual(expected);
        },
      ),
      {numRuns: 250},
    );
  });

  it('fails closed for absent, invalid, or incompatible capacity evidence', () => {
    expect(aggregatePersistentReferenceResolutionCapacityBoundaries([])).toMatchObject({
      finalFactBytes: Number.NaN,
      rowCount: Number.NaN,
    });
    expect(
      aggregatePersistentReferenceResolutionCapacityBoundaries([
        {finalFactBytes: 1, operation: 'resolve persistent code graph references', rowCount: 1},
        {
          finalFactBytes: 1,
          mainFilesystem: 'temporary',
          operation: 'resolve temporary code graph references',
          rowCount: 1,
          transientFilesystem: 'temporary',
        },
      ]),
    ).toMatchObject({finalFactBytes: Number.NaN, rowCount: Number.NaN});
    expect(
      aggregatePersistentReferenceResolutionCapacityBoundaries([
        {finalFactBytes: Number.NaN, operation: 'resolve persistent code graph references', rowCount: 1},
      ]),
    ).toMatchObject({finalFactBytes: Number.NaN, rowCount: Number.NaN});
  });

  it('keeps transaction groups within reservation memory bounds without changing page order', () => {
    expect(PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES).toBeGreaterThanOrEqual(
      PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES,
    );
    expect(PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES).toBeGreaterThanOrEqual(
      PERSISTENT_FULL_RESOLUTION_MAXIMUM_TRANSACTION_PAGES,
    );
    expect(PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES % PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES).toBe(0);
    fc.assert(
      fc.property(fc.array(fc.integer(), {maxLength: 257}), pages => {
        const reservations = planPersistentReferenceResolutionPages(pages);
        expect(EffectArray.flatMap(reservations, reservation => reservation.pages)).toEqual(pages);
        expect(reservations).toHaveLength(Math.ceil(pages.length / PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES));
        for (const reservation of reservations) {
          expect(reservation.pages.length).toBeGreaterThan(0);
          expect(reservation.pages.length).toBeLessThanOrEqual(PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES);
          expect(reservation.transactions.flat()).toEqual(reservation.pages);
          for (const transaction of reservation.transactions) {
            expect(transaction.length).toBeGreaterThan(0);
            expect(transaction.length).toBeLessThanOrEqual(PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES);
          }
        }
        expect(EffectArray.flatMap(reservations, reservation => reservation.transactions)).toHaveLength(
          Math.ceil(pages.length / PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES),
        );
      }),
      {numRuns: 250},
    );

    const boundary = planPersistentReferenceResolutionPages(Array.from({length: 17}, (_, index) => index));
    expect(EffectArray.map(boundary, reservation => reservation.pages.length)).toEqual([8, 8, 1]);
    expect(
      EffectArray.map(boundary, reservation =>
        EffectArray.map(reservation.transactions, transaction => transaction.length),
      ),
    ).toEqual([[4, 4], [4, 4], [1]]);
    const widened = planPersistentReferenceResolutionPages(
      Array.from({length: 17}, (_, index) => index),
      PERSISTENT_FULL_RESOLUTION_MAXIMUM_TRANSACTION_PAGES,
    );
    expect(
      EffectArray.map(widened, reservation =>
        EffectArray.map(reservation.transactions, transaction => transaction.length),
      ),
    ).toEqual([[8], [8], [1]]);

    fc.assert(
      fc.property(
        fc.array(fc.integer(), {maxLength: 257}),
        fc.integer({
          max: PERSISTENT_FULL_RESOLUTION_MAXIMUM_TRANSACTION_PAGES,
          min: 1,
        }),
        (pages, transactionPageLimit) => {
          const reservations = planPersistentReferenceResolutionPages(pages, transactionPageLimit);
          expect(EffectArray.flatMap(reservations, reservation => reservation.pages)).toEqual(pages);
          expect(EffectArray.flatMap(reservations, reservation => reservation.transactions).flat()).toEqual(pages);
          for (const transaction of EffectArray.flatMap(reservations, reservation => reservation.transactions)) {
            expect(transaction.length).toBeGreaterThan(0);
            expect(transaction.length).toBeLessThanOrEqual(transactionPageLimit);
          }
        },
      ),
      {numRuns: 250},
    );
    expect(planPersistentReferenceResolutionPages([1, 2, 3, 4, 5], Number.NaN)[0]?.transactions).toEqual([
      [1, 2, 3, 4],
      [5],
    ]);
  });

  it('adapts resolved-reference commits within the existing eight-page reservation', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({max: 60_000, min: 0}), {maxLength: 64}), durations => {
        let current = PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES;
        for (const duration of durations) {
          const next = nextPersistentReferenceResolutionTransactionPages(current, duration);
          expect(Number.isSafeInteger(next)).toBe(true);
          expect(next).toBeGreaterThanOrEqual(1);
          expect(next).toBeLessThanOrEqual(PERSISTENT_FULL_RESOLUTION_MAXIMUM_TRANSACTION_PAGES);
          expect(next).toBeLessThanOrEqual(current * 2);
          if (duration < 2_000) expect(next).toBeGreaterThanOrEqual(current);
          else if (duration > 5_000) expect(next).toBeLessThanOrEqual(current);
          else expect(next).toBe(current);
          current = next;
        }
      }),
      {numRuns: 250},
    );

    expect(nextPersistentReferenceResolutionTransactionPages(4, 1_999)).toBe(8);
    expect(nextPersistentReferenceResolutionTransactionPages(8, 2_000)).toBe(8);
    expect(nextPersistentReferenceResolutionTransactionPages(8, 5_001)).toBe(4);
    expect(nextPersistentReferenceResolutionTransactionPages(4, 5_001)).toBe(2);
    expect(nextPersistentReferenceResolutionTransactionPages(2, 5_001)).toBe(1);
    expect(nextPersistentReferenceResolutionTransactionPages(Number.NaN, 3_000)).toBe(
      PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES,
    );
    expect(nextPersistentReferenceResolutionTransactionPages(8, Number.NaN)).toBe(8);
    expect(nextPersistentReferenceResolutionTransactionPages(8, -1)).toBe(8);
  });
});
