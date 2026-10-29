import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_BUILDER_BACKGROUND_AGING_MILLISECONDS as aging,
  CODE_GRAPH_BUILDER_HOME_CAPACITY as capacity,
  orderCodeGraphBuilderAdmissionQueue as projectQueue,
  orderCodeGraphBuilderAdmissionTickets as order,
  selectCodeGraphBuilderAdmissionTickets as select,
} from '@threadnote/graph/builder/admission_scheduler';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const checkoutId = fc.option(fc.constantFrom('a', 'b', 'c'), {nil: undefined});
const candidate = fc.record({
  admissionClass: fc.constantFrom('background' as const, 'current-required' as const),
  checkoutId,
  createdAt: fc.integer({min: 0, max: aging * 2}),
  token: fc.uuid(),
});
const tickets = fc.uniqueArray(candidate, {maxLength: 40, selector: value => value.token});

describe('checkout-aware builder scheduler properties', () => {
  it('is deterministic, permutation independent, and non-mutating with bounded capacity', () => {
    fc.assert(
      fc.property(
        tickets,
        fc.array(checkoutId, {maxLength: capacity}),
        fc.integer({min: 0, max: aging * 3}),
        fc.func(fc.integer()),
        (input, active, now, priority) => {
          const original = structuredClone(input);
          const permuted = [...input].sort(
            (left, right) =>
              priority(left.token) - priority(right.token) ||
              Effect.pipe(left.token, EffectString.localeCompare(right.token)),
          );
          const result = select(input, active, now);
          expect(select(permuted, active, now)).toEqual(result);
          expect(order(permuted, now)).toEqual(order(input, now));
          expect(select(input, active, now)).toEqual(result);
          expect(input).toEqual(original);
          expect(result.length + active.length).toBeLessThanOrEqual(capacity);
          expect(new Set(EffectArray.map(result, value => value.token)).size).toBe(result.length);
          expect(EffectArray.every(result, value => input.includes(value))).toBe(true);
        },
      ),
      {numRuns: 200},
    );
  });

  it('projects a deterministic advisory order while every slot is occupied', () => {
    fc.assert(
      fc.property(tickets, fc.integer({min: 0, max: aging * 3}), fc.func(fc.integer()), (input, now, priority) => {
        const active = ['a', 'b'];
        const permuted = [...input].sort(
          (left, right) =>
            priority(left.token) - priority(right.token) ||
            Effect.pipe(left.token, EffectString.localeCompare(right.token)),
        );
        expect(select(input, active, now)).toEqual([]);
        expect(projectQueue(permuted, active, now)).toEqual(projectQueue(input, active, now));
        expect(projectQueue(input, active, now)).toHaveLength(input.length);
      }),
      {numRuns: 200},
    );
  });

  it('chooses checkout diversity before a second occupant, including within a single selection', () => {
    fc.assert(
      fc.property(tickets, fc.array(checkoutId, {maxLength: capacity - 1}), (input, active) => {
        const selected = select(input, active, 0);
        const occupied = new Set(EffectArray.filter(active, (value): value is 'a' | 'b' | 'c' => value !== undefined));
        const remaining = [...input];
        for (const ticket of selected) {
          if (
            ticket.checkoutId !== undefined &&
            EffectArray.some(remaining, value => value.checkoutId !== undefined && !occupied.has(value.checkoutId))
          )
            expect(occupied.has(ticket.checkoutId)).toBe(false);
          if (ticket.checkoutId !== undefined) occupied.add(ticket.checkoutId);
          remaining.splice(remaining.indexOf(ticket), 1);
        }
      }),
      {numRuns: 200},
    );
  });

  it('keeps background builds for one checkout serial even when a home slot is free', () => {
    const first = {admissionClass: 'background' as const, checkoutId: 'a', createdAt: 0, token: 'first'};
    const second = {...first, createdAt: 1, token: 'second'};
    const unrelated = {...first, checkoutId: 'b', createdAt: 2, token: 'unrelated'};
    expect(select([first, second], [], 0)).toEqual([first]);
    expect(select([first, second, unrelated], [], 0)).toEqual([first, unrelated]);
    expect(select([first, second], ['a'], 0)).toEqual([]);
    expect(select([first, {...second, admissionClass: 'current-required' as const}], [], 0)).toHaveLength(1);
  });

  it('never selects speculative background work for an occupied checkout', () => {
    fc.assert(
      fc.property(
        tickets,
        fc.array(checkoutId, {maxLength: capacity}),
        fc.integer({min: 0, max: aging * 3}),
        (input, active, now) => {
          const occupied = new Set(
            EffectArray.filter(active, (value): value is 'a' | 'b' | 'c' => value !== undefined),
          );
          for (const ticket of select(input, active, now)) {
            if (
              ticket.admissionClass === 'background' &&
              ticket.checkoutId !== undefined &&
              now - ticket.createdAt < aging
            )
              expect(occupied.has(ticket.checkoutId)).toBe(false);
            if (ticket.checkoutId !== undefined) occupied.add(ticket.checkoutId);
          }
        },
      ),
      {numRuns: 200},
    );
  });

  it('has a total FIFO order within each effective rank, including equal timestamp tokens', () => {
    fc.assert(
      fc.property(tickets, fc.integer({min: 0, max: aging * 3}), (input, now) => {
        const ordered = order(input, now);
        const rank = (ticket: typeof candidate extends fc.Arbitrary<infer T> ? T : never) =>
          ticket.admissionClass === 'current-required' || now - ticket.createdAt >= aging ? 0 : 1;
        for (let index = 1; index < ordered.length; index++) {
          const previous = ordered[index - 1];
          const current = ordered[index];
          expect(rank(previous)).toBeLessThanOrEqual(rank(current));
          if (rank(previous) === rank(current)) {
            expect(previous.createdAt).toBeLessThanOrEqual(current.createdAt);
            if (previous.createdAt === current.createdAt) expect(previous.token < current.token).toBe(true);
          }
        }
      }),
      {numRuns: 200},
    );
  });

  it('ages background ahead of every later foreground arrival from the same occupancy tier', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 0, max: 1_000_000}),
        fc.array(fc.integer({min: 1, max: aging * 2}), {maxLength: 40}),
        (createdAt, offsets) => {
          const background = {admissionClass: 'background' as const, checkoutId: 'a', createdAt, token: 'background'};
          const current = EffectArray.map(offsets, (offset, index) => ({
            admissionClass: 'current-required' as const,
            checkoutId: 'a',
            createdAt: createdAt + offset,
            token: String(index),
          }));
          expect(select([...current, background], [], createdAt + aging)[0]).toBe(background);
          if (current.length > 0)
            expect(order([...current, background], createdAt + aging - 1)[0]).not.toBe(background);
        },
      ),
      {numRuns: 200},
    );
  });

  it('reserves an aged background ticket against sustained same-checkout foreground arrivals', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 40}), steps => {
        const oldest = {admissionClass: 'background' as const, checkoutId: 'a', createdAt: 0, token: 'oldest'};
        const newer = {admissionClass: 'background' as const, checkoutId: 'a', createdAt: 1, token: 'newer'};
        for (let step = 0; step < steps; step++) {
          const now = Math.floor((aging * step) / steps);
          const foreground = {
            admissionClass: 'current-required' as const,
            checkoutId: 'a',
            createdAt: now,
            token: `foreground-${step}`,
          };
          const selected = select([oldest, newer, foreground], ['a'], now);
          expect(selected).toHaveLength(1);
          expect(selected[0]).toBe(foreground);
        }
        const foreground = {
          admissionClass: 'current-required' as const,
          checkoutId: 'a',
          createdAt: aging + 1,
          token: 'foreground-aged',
        };
        expect(select([oldest, newer, foreground], ['a'], aging + 1)).toEqual([]);
        expect(select([oldest, newer, foreground], [], aging + 1)).toEqual([oldest]);
      }),
      {numRuns: 200},
    );
  });

  it('counts legacy checkout identities toward capacity without treating them as shared ownership', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: aging * 2}), fc.uuid(), (createdAt, token) => {
        const legacy = {admissionClass: 'background' as const, checkoutId: undefined, createdAt, token};
        expect(select([legacy], [undefined, undefined], aging * 2)).toEqual([]);
        expect(select([legacy], [undefined], createdAt)).toEqual([legacy]);
      }),
      {numRuns: 200},
    );
  });
});
