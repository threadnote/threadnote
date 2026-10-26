import {Schema} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {advanceChange, prepareChange, ChangeState} from '../../src/changes.js';
import {hash, owned, proposal, step} from '../fixtures.js';

describe('guarded change state model', () => {
  it('owns nested preconditions and expected content after restoring persisted state', () => {
    const restored = Schema.decodeUnknownSync(ChangeState)(
      JSON.parse(JSON.stringify(prepareChange('operation', proposal(1)))),
    );
    // This mutable alias represents the caller retaining the decoded persistence value.
    const target = restored.proposal.targets[0] as {before: {fence: number}; after: string};
    const begun = step(restored, {type: 'begin', current: restored.proposal.targets.map(t => t.before)});
    target.before.fence = 2;
    target.after = hash('f');
    expect(begun.proposal.targets[0].before.fence).toBe(1);
    expect(begun.proposal.targets[0].after).toBe(hash('e'));
    expect(Object.isFrozen(begun.proposal.targets[0].before.observation)).toBe(true);
    expect(
      step(begun, {type: 'intent', index: 0, current: {...begun.proposal.targets[0].before, fence: 2}}).status,
    ).toBe('conflict');
    const intended = step(begun, {type: 'intent', index: 0, current: begun.proposal.targets[0].before});
    expect(step(intended, {type: 'ack', index: 0, outcome: 'applied', content: hash('f')}).status).toBe(
      'indeterminate',
    );
    expect(step(intended, {type: 'ack', index: 0, outcome: 'applied', content: hash('e')}).status).toBe('applied');
  });

  it('rejects malformed persisted states and never dereferences a nonexistent target', () => {
    const state = prepareChange('operation', proposal(1));
    for (const malformed of [
      {...state, status: 'applying', written: 1},
      {...state, status: 'applied'},
      {...state, status: 'indeterminate', pendingIntent: false},
    ]) {
      expect(Schema.is(ChangeState)(malformed)).toBe(false);
      expect(
        advanceChange(malformed as ChangeState, {
          type: 'intent',
          index: 1,
          current: owned,
        }).status,
      ).toBe('invalid-transition');
    }
  });
  it('rejects preflight conflict before scheduling any target', () => {
    const p = proposal(2);
    const state = prepareChange('operation', p);
    const result = step(state, {
      type: 'begin',
      current: [p.targets[0].before, {...p.targets[1].before, fence: 2}],
    });
    expect(result).toMatchObject({
      status: 'conflict',
      written: 0,
      pendingIntent: false,
    });
    expect(
      advanceChange(result, {
        type: 'intent',
        index: 0,
        current: p.targets[0].before,
      }).status,
    ).toBe('invalid-transition');
  });

  it('stops after a concurrent change at any target and never schedules later targets', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 20}), fc.nat({max: 100}), (count, fault) => {
        const p = proposal(count);
        const stop = fault % count;
        let state = step(prepareChange('operation', p), {
          type: 'begin',
          current: p.targets.map(t => t.before),
        });
        for (let i = 0; i < stop; i++) {
          state = step(state, {
            type: 'intent',
            index: i,
            current: p.targets[i].before,
          });
          state = step(state, {
            type: 'ack',
            index: i,
            outcome: 'applied',
            content: hash('e'),
          });
        }
        state = step(state, {
          type: 'intent',
          index: stop,
          current: {...p.targets[stop].before, fence: 2},
        });
        expect(state.written).toBe(stop);
        expect(state.status).toBe(stop === 0 ? 'conflict' : 'partial');
        expect(Schema.is(ChangeState)(state)).toBe(true);
        expect(
          advanceChange(state, {
            type: 'intent',
            index: stop,
            current: p.targets[stop].before,
          }).status,
        ).toBe('invalid-transition');
      }),
      {numRuns: 100},
    );
  });

  it('never promotes a lost acknowledgement to success or replays an unknown write', () => {
    const p = proposal(2);
    let state = step(prepareChange('operation', p), {
      type: 'begin',
      current: p.targets.map(t => t.before),
    });
    state = step(state, {
      type: 'intent',
      index: 0,
      current: p.targets[0].before,
    });
    state = step(state, {type: 'interrupted'});
    expect(state).toMatchObject({
      status: 'indeterminate',
      written: 0,
      pendingIntent: true,
    });
    expect(
      advanceChange(state, {
        type: 'intent',
        index: 0,
        current: p.targets[0].before,
      }).status,
    ).toBe('invalid-transition');
  });

  it('makes duplicate acknowledgements idempotent without issuing another intent', () => {
    const p = proposal(2);
    let state = step(prepareChange('operation', p), {
      type: 'begin',
      current: p.targets.map(t => t.before),
    });
    state = step(state, {
      type: 'intent',
      index: 0,
      current: p.targets[0].before,
    });
    const ack = {
      type: 'ack',
      index: 0,
      outcome: 'applied',
      content: hash('e'),
    } as const;
    state = step(state, ack);
    expect(step(state, ack)).toEqual(state);
    expect(
      advanceChange(state, {
        type: 'intent',
        index: 0,
        current: p.targets[0].before,
      }).status,
    ).toBe('invalid-transition');
    state = step(state, {
      type: 'intent',
      index: 1,
      current: p.targets[1].before,
    });
    state = step(state, {...ack, index: 1});
    expect(state.status).toBe('applied');
    expect(step(state, {...ack, index: 1})).toEqual(state);
    expect(Object.isFrozen(state.proposal.targets[0].before.observation)).toBe(true);
  });
});
