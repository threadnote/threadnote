import {Array as EffectArray, Option as EffectOption} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  acknowledgeNativeWatch,
  attachNativeWatchConsumer,
  decodeNativeWatchState,
  initializeNativeWatch,
  nativeWatchEventLimit,
  reconcileNativeWatch,
  recordNativeWatchDispositions,
  recordNativeWatchLifecycle,
  relayNativeWatch,
  updateNativeWatchWork,
  type NativeWatchEntity,
  type NativeWatchSource,
  type NativeWatchState,
  type NativeWatchSweep,
} from '../src/watch.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const required = <A>(value: A | null | undefined): A => {
  if (value === null || value === undefined) throw new Error('Expected a fixture delivery.');
  return value;
};
const sha = (letter: string) => Effect.pipe(letter, EffectString.repeat(40));
const digest = (letter: string) => Effect.pipe(letter, EffectString.repeat(64));
const pr = 'https://github.com/example/project/pull/7';
const sourceNames: readonly NativeWatchSource[] = ['comments', 'reviews', 'threads', 'checks', 'statuses'];
const entity = (id: string, overrides: Partial<NativeWatchEntity> = {}): NativeWatchEntity => ({
  id,
  version: digest('a'),
  kind: 'comment',
  bootstrap: true,
  ...overrides,
});
const sweep = (overrides: Partial<NativeWatchSweep> = {}): NativeWatchSweep => ({
  head: sha('a'),
  state: 'open',
  at: 1_000,
  startedHead: sha('a'),
  sources: [],
  ci: {head: sha('a'), complete: false, count: 0, pending: 0, failed: 0, version: digest('c')},
  ...overrides,
});
const state = () => initializeNativeWatch('watch-1', pr, 0);
const errorCode = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
  }
  return undefined;
};
const withConsumer = (value: NativeWatchState, id = 'consumer-1', at = 10) =>
  attachNativeWatchConsumer(value, {id, wakeupId: 'wake-1'}, at);
const allComplete = (at: number, head = sha('a')) =>
  EffectArray.map(sourceNames, source => ({
    source,
    complete: true as const,
    items: [] as NativeWatchEntity[],
    ...(source === 'checks' || source === 'statuses' ? {head} : {}),
    at,
  }));

describe('native watch domain', () => {
  it('initializes a strict versioned state and rejects malformed or legacy state', () => {
    const initial = state();
    expect(decodeNativeWatchState(JSON.parse(JSON.stringify(initial)))).toEqual(initial);
    expect(errorCode(() => initializeNativeWatch('../bad', pr, 0))).toBe('invalid-watch');
    expect(errorCode(() => initializeNativeWatch('watch-1', 'https://github.com/a/b/pull/7?x=1', 0))).toBe(
      'invalid-watch',
    );
    expect(errorCode(() => decodeNativeWatchState({...initial, pythonQueue: []}))).toBe('invalid-watch');
  });

  it('reconciles exactly the new, changed, and removed entity set without repeating unchanged items', () => {
    const initial = reconcileNativeWatch(
      state(),
      sweep({
        sources: [
          {source: 'comments', complete: true, at: 1_000, items: [entity('one'), entity('two', {bootstrap: false})]},
        ],
      }),
    );
    expect(EffectArray.map(initial.events, event => event.key)).toEqual(['one']);
    const next = reconcileNativeWatch(
      initial,
      sweep({
        at: 2_000,
        sources: [
          {
            source: 'comments',
            complete: true,
            at: 2_000,
            items: [entity('one', {version: digest('b')}), entity('three')],
          },
        ],
      }),
    );
    expect(EffectArray.map(next.events, event => [event.key, event.kind, event.removed])).toEqual([
      ['one', 'comment', false],
      ['one', 'comment', false],
      ['three', 'comment', false],
      ['two', 'removed', true],
    ]);
    expect(
      reconcileNativeWatch(
        next,
        sweep({
          at: 3_000,
          sources: [
            {
              source: 'comments',
              complete: true,
              at: 3_000,
              items: [entity('one', {version: digest('b')}), entity('three')],
            },
          ],
        }),
      ).events,
    ).toEqual(next.events);
  });

  it('replaces old-head CI checkpoints without removal noise or losing work', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('checks' as const, 'statuses' as const),
        fc.uniqueArray(fc.integer({min: 0, max: 30}), {maxLength: 20}),
        fc.boolean(),
        (source, ids, delayed) => {
          const initial = reconcileNativeWatch(
            state(),
            sweep({
              sources: [
                {
                  source,
                  complete: true,
                  head: sha('a'),
                  at: 1_000,
                  items: [
                    entity('old-failure', {kind: 'ci_error', head: sha('a')}),
                    ...EffectArray.map(ids, id => entity('old-' + id, {kind: 'ci_update', head: sha('a')})),
                  ],
                },
                {
                  source: 'comments',
                  complete: true,
                  at: 1_000,
                  items: [entity('comment', {head: sha('a'), bootstrap: false})],
                },
              ],
            }),
          );
          const relayed = relayNativeWatch(withConsumer(initial), 'consumer-1', 20);
          const delivery = required(relayed.delivery);
          const recorded = recordNativeWatchDispositions(
            relayed.state,
            'consumer-1',
            delivery.id,
            [
              {
                eventId: delivery.events[0].id,
                status: 'open',
                reason: 'Needs a verified fix',
                evidence: 'Known old-head failure',
              },
            ],
            21,
          );
          const before = acknowledgeNativeWatch(recorded, 'consumer-1', delivery.id, 22);
          const original = JSON.stringify(before);
          const waiting = delayed
            ? reconcileNativeWatch(
                before,
                sweep({
                  head: sha('b'),
                  startedHead: sha('b'),
                  at: 2_000,
                  sources: [{source, complete: false, at: 2_000, error: {code: 'temporary', retryable: true}}],
                }),
              )
            : before;
          const next = reconcileNativeWatch(
            waiting,
            sweep({
              head: sha('b'),
              startedHead: sha('b'),
              at: 3_000,
              sources: [
                {
                  source,
                  complete: true,
                  head: sha('b'),
                  at: 3_000,
                  items: [entity('current-failure', {kind: 'ci_error', head: sha('b')})],
                },
                {source: 'comments', complete: true, at: 3_000, items: []},
              ],
            }),
          );
          expect(EffectArray.filter(next.events, event => event.kind === 'head_changed')).toHaveLength(1);
          expect(
            EffectArray.map(
              EffectArray.filter(next.events, event => event.kind === 'removed'),
              event => event.key,
            ),
          ).toEqual(['comment']);
          expect(
            EffectArray.map(
              EffectArray.filter(next.events, event => event.kind === 'ci_error'),
              event => event.key,
            ),
          ).toEqual(['current-failure']);
          expect(
            EffectOption.getOrUndefined(
              EffectOption.map(
                EffectOption.fromNullishOr(
                  EffectOption.getOrUndefined(EffectArray.findFirst(next.sources, item => item.source === source))
                    ?.items,
                ),
                __effectArrayReceiver => EffectArray.map(__effectArrayReceiver, item => item.id),
              ),
            ),
          ).toEqual(['current-failure']);
          expect(next.work).toEqual(before.work);
          expect(JSON.stringify(before)).toBe(original);
          const removed = reconcileNativeWatch(
            next,
            sweep({
              head: sha('b'),
              startedHead: sha('b'),
              at: 4_000,
              sources: [{source, complete: true, head: sha('b'), at: 4_000, items: []}],
            }),
          );
          expect(removed.events.slice(next.events.length)).toMatchObject([
            {kind: 'removed', key: 'current-failure', head: sha('b')},
          ]);
          expect(removed.work).toEqual(before.work);
        },
      ),
      {numRuns: 32, examples: [['checks', Array.from({length: 64}, (_, index) => index), false]]},
    );
  });

  it('retains CI removal signals when the prior entity has no proven head', () => {
    const before = reconcileNativeWatch(
      state(),
      sweep({
        sources: [
          {
            source: 'checks',
            complete: true,
            head: sha('a'),
            at: 1_000,
            items: [entity('unknown-head', {kind: 'ci_update'})],
          },
        ],
      }),
    );
    const after = reconcileNativeWatch(
      before,
      sweep({
        head: sha('b'),
        startedHead: sha('b'),
        at: 2_000,
        sources: [{source: 'checks', complete: true, head: sha('b'), at: 2_000, items: []}],
      }),
    );
    expect(EffectArray.map(after.events, event => event.kind)).toEqual(['head_changed', 'removed']);
  });

  it('accepts canonical external HTTPS entity URLs and rejects insecure or credential URLs', () => {
    const external = reconcileNativeWatch(
      state(),
      sweep({
        sources: [
          {
            source: 'statuses',
            complete: true,
            head: sha('a'),
            at: 1_000,
            items: [entity('status', {url: 'https://circleci.com/gh/example/project/123'})],
          },
        ],
      }),
    );
    expect(external.events[0]?.url).toBe('https://circleci.com/gh/example/project/123');
    for (const url of ['http://circleci.com/build/1', 'https://user:secret@circleci.com/build/1']) {
      expect(
        errorCode(() =>
          reconcileNativeWatch(
            state(),
            sweep({
              sources: [{source: 'statuses', complete: true, head: sha('a'), at: 1_000, items: [entity('bad', {url})]}],
            }),
          ),
        ),
      ).toBe('invalid-watch');
    }
  });

  it('matches a simple set model for bounded additions/removals and leaves inputs immutable', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/u), {maxLength: 12}),
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/u), {maxLength: 12}),
        (beforeIds, afterIds) => {
          const before = reconcileNativeWatch(
            state(),
            sweep({
              sources: [
                {
                  source: 'comments',
                  complete: true,
                  at: 1_000,
                  items: EffectArray.map(beforeIds, id => entity(id)),
                },
              ],
            }),
          );
          const original = JSON.stringify(before);
          const after = reconcileNativeWatch(
            before,
            sweep({
              at: 2_000,
              sources: [
                {
                  source: 'comments',
                  complete: true,
                  at: 2_000,
                  items: EffectArray.map(afterIds, id => entity(id)),
                },
              ],
            }),
          );
          const diff = EffectArray.map(
            after.events.slice(before.events.length),
            event => `${event.removed ? '-' : '+'}${event.key}`,
          ).sort();
          const expected = [
            ...EffectArray.map(
              EffectArray.filter(afterIds, id => !beforeIds.includes(id)),
              id => `+${id}`,
            ),
            ...EffectArray.map(
              EffectArray.filter(beforeIds, id => !afterIds.includes(id)),
              id => `-${id}`,
            ),
          ].sort();
          expect(diff).toEqual(expected);
          expect(JSON.stringify(before)).toBe(original);
        },
      ),
      {numRuns: 80},
    );
  });

  it('keeps failed and stale-head check/status checkpoints while retaining observed feedback heads', () => {
    const first = reconcileNativeWatch(
      state(),
      sweep({sources: [{source: 'comments', complete: true, at: 1_000, items: [entity('thread', {head: sha('b')})]}]}),
    );
    const failed = reconcileNativeWatch(
      first,
      sweep({
        at: 2_000,
        sources: [
          {source: 'comments', complete: false, error: {code: 'api-down', retryable: true}, at: 2_000},
          {source: 'checks', complete: true, head: sha('b'), at: 2_000, items: [entity('check')]},
        ],
      }),
    );
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(failed.sources, item => item.source === 'comments')),
    ).toMatchObject({
      items: [entity('thread', {head: sha('b')})],
      lastCompleteAt: 1_000,
    });
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(failed.sources, item => item.source === 'checks')),
    ).toMatchObject({
      items: [],
      error: {code: 'head_changed'},
    });
    expect(EffectArray.map(failed.events, event => event.kind)).toEqual(['comment', 'source_error', 'source_error']);
    const repeatedFailure = reconcileNativeWatch(
      failed,
      sweep({
        at: 3_000,
        sources: [{source: 'comments', complete: false, error: {code: 'api-down', retryable: true}, at: 3_000}],
      }),
    );
    expect(repeatedFailure.events).toEqual(failed.events);
  });

  it('checkpoints routine CI updates without relay events while preserving failures and aggregate completion', () => {
    const sourceResults = (at: number, checkVersion: string, statusVersion: string) =>
      EffectArray.map(allComplete(at), result =>
        result.source === 'checks'
          ? {...result, items: [entity('check-1', {kind: 'ci_update', version: checkVersion})]}
          : result.source === 'statuses'
            ? {...result, items: [entity('status-1', {kind: 'ci_update', version: statusVersion})]}
            : result,
      );
    let current = reconcileNativeWatch(
      state(),
      sweep({at: 1_000, sources: sourceResults(1_000, digest('a'), digest('a'))}),
    );
    expect(current.events).toEqual([]);
    for (let index = 1; index <= 6; index++) {
      current = reconcileNativeWatch(
        current,
        sweep({at: 1_000 + index * 1_000, sources: sourceResults(1_000 + index * 1_000, digest('b'), digest('c'))}),
      );
      expect(current.events).toEqual([]);
    }
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(current.sources, item => item.source === 'checks'))?.items[0]
        ?.version,
    ).toBe(digest('b'));
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(current.sources, item => item.source === 'statuses'))?.items[0]
        ?.version,
    ).toBe(digest('c'));

    const failed = reconcileNativeWatch(
      current,
      sweep({
        at: 8_000,
        sources: EffectArray.map(sourceResults(8_000, digest('d'), digest('c')), result =>
          result.source === 'checks'
            ? {...result, items: [entity('check-1', {kind: 'ci_error', version: digest('d')})]}
            : result,
        ),
      }),
    );
    expect(EffectArray.map(failed.events, event => event.kind)).toEqual(['ci_error']);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(failed.sources, item => item.source === 'checks'))?.items[0]
        ?.kind,
    ).toBe('ci_error');

    const ci = {head: sha('a'), complete: true, count: 1, pending: 0, failed: 0, version: digest('e')};
    const firstComplete = reconcileNativeWatch(state(), sweep({sources: allComplete(1_000), ci}));
    const secondComplete = reconcileNativeWatch(firstComplete, sweep({at: 61_000, sources: allComplete(61_000), ci}));
    expect(EffectArray.map(secondComplete.events, event => event.kind)).toEqual(['ci_complete']);
  });

  it('emits head and terminal transitions once and ignores an initial head as noise', () => {
    const initial = reconcileNativeWatch(state(), sweep());
    expect(initial.events).toEqual([]);
    const changed = reconcileNativeWatch(initial, sweep({head: sha('b'), startedHead: sha('b'), at: 2_000}));
    expect(EffectArray.map(changed.events, event => event.kind)).toEqual(['head_changed']);
    const terminal = reconcileNativeWatch(
      changed,
      sweep({head: sha('b'), startedHead: sha('b'), state: 'merged', at: 3_000}),
    );
    const repeated = reconcileNativeWatch(
      terminal,
      sweep({head: sha('b'), startedHead: sha('b'), state: 'merged', at: 4_000}),
    );
    expect(EffectArray.map(terminal.events, event => event.kind)).toEqual(['head_changed', 'merged']);
    expect(repeated.events).toEqual(terminal.events);
  });

  it('requires complete stable nonempty CI evidence twice across a minute and marks it advisory', () => {
    const ci = {head: sha('a'), complete: true, count: 1, pending: 0, failed: 0, version: digest('d')};
    const first = reconcileNativeWatch(state(), sweep({sources: allComplete(1_000), ci}));
    expect(first.events).toEqual([]);
    const unstable = reconcileNativeWatch(
      first,
      sweep({at: 60_000, startedHead: sha('b'), sources: allComplete(60_000), ci}),
    );
    expect(unstable.events).toEqual([]);
    const stableAgain = reconcileNativeWatch(unstable, sweep({at: 61_000, sources: allComplete(61_000), ci}));
    expect(stableAgain.events).toEqual([]);
    const confirmed = reconcileNativeWatch(stableAgain, sweep({at: 121_000, sources: allComplete(121_000), ci}));
    expect(confirmed.events).toMatchObject([{kind: 'ci_complete', ready: false, head: sha('a')}]);
    expect(reconcileNativeWatch(confirmed, sweep({at: 181_000, sources: allComplete(181_000), ci})).events).toEqual(
      confirmed.events,
    );
    const interrupted = reconcileNativeWatch(
      confirmed,
      sweep({at: 182_000, sources: allComplete(182_000).slice(0, 4), ci}),
    );
    expect(reconcileNativeWatch(interrupted, sweep({at: 242_000, sources: allComplete(242_000), ci})).events).toEqual(
      confirmed.events,
    );
    const partial = reconcileNativeWatch(state(), sweep({sources: allComplete(1_000).slice(0, 4), ci}));
    expect(partial.events).toEqual([]);

    const newHeadFirst = reconcileNativeWatch(
      confirmed,
      sweep({
        head: sha('b'),
        startedHead: sha('b'),
        at: 122_000,
        sources: allComplete(122_000, sha('b')),
        ci: {...ci, head: sha('b')},
      }),
    );
    const newHeadConfirmed = reconcileNativeWatch(
      newHeadFirst,
      sweep({
        head: sha('b'),
        startedHead: sha('b'),
        at: 182_000,
        sources: allComplete(182_000, sha('b')),
        ci: {...ci, head: sha('b')},
      }),
    );
    expect(EffectArray.filter(newHeadConfirmed.events, event => event.kind === 'ci_complete')).toHaveLength(2);
    expect(
      EffectArray.map(
        EffectArray.filter(newHeadConfirmed.events, event => event.kind === 'ci_complete'),
        event => event.head,
      ),
    ).toEqual([sha('a'), sha('b')]);
  });

  it('pins and replays the same delivery after takeover, requiring all dispositions before ack', () => {
    const withEvents = reconcileNativeWatch(
      state(),
      sweep({sources: [{source: 'comments', complete: true, at: 1_000, items: [entity('one'), entity('two')]}]}),
    );
    const owned = withConsumer(withEvents);
    const pinned = relayNativeWatch(owned, 'consumer-1', 20, 1);
    expect(pinned.delivery?.events).toHaveLength(1);
    expect(
      errorCode(() =>
        attachNativeWatchConsumer(pinned.state, {id: 'consumer-2', wakeupId: 'wake-2'}, 21, {takeover: true}),
      ),
    ).toBe('invalid-watch');
    const replayed = relayNativeWatch(pinned.state, 'consumer-1', 30, 32);
    expect(replayed.delivery).toEqual(pinned.delivery);
    const expired = attachNativeWatchConsumer(pinned.state, {id: 'consumer-2', wakeupId: 'wake-2'}, 901_000, {
      takeover: true,
    });
    const taken = relayNativeWatch(expired, 'consumer-2', 901_001);
    expect(taken.delivery).toEqual({...pinned.delivery, consumerId: 'consumer-2'});
    const beforeRejectedAck = JSON.stringify(taken.state);
    expect(errorCode(() => acknowledgeNativeWatch(taken.state, 'consumer-2', taken.delivery!.id, 901_002))).toBe(
      'invalid-watch',
    );
    expect(JSON.stringify(taken.state)).toBe(beforeRejectedAck);
    expect(taken.state.acknowledged).toBe(0);
    const disposition = {
      eventId: required(taken.delivery).events[0].id,
      status: 'open' as const,
      reason: 'Review reply',
      evidence: 'https://github.com/example/project/pull/7#issuecomment-1',
    };
    const recorded = recordNativeWatchDispositions(
      taken.state,
      'consumer-2',
      taken.delivery!.id,
      [disposition],
      901_002,
    );
    const acked = acknowledgeNativeWatch(recorded, 'consumer-2', taken.delivery!.id, 901_003);
    expect(acked.acknowledged).toBe(1);
    expect(acked.work).toMatchObject([{status: 'open'}]);
    expect(acknowledgeNativeWatch(acked, 'consumer-2', taken.delivery!.id, 901_004)).toEqual(acked);
  });

  it('preserves queued work after acknowledgement and permits only explicit resolution', () => {
    const withEvents = reconcileNativeWatch(
      state(),
      sweep({
        sources: [
          {
            source: 'comments',
            complete: true,
            at: 1_000,
            items: [entity('one', {url: 'https://github.com/example/project/pull/7#issuecomment-1', head: sha('a')})],
          },
        ],
      }),
    );
    const owned = withConsumer(withEvents);
    const {state: relayed, delivery} = relayNativeWatch(owned, 'consumer-1', 20);
    const open = {
      eventId: required(delivery).events[0].id,
      status: 'open' as const,
      reason: 'Needs fix',
      evidence: 'review link',
    };
    const recorded = recordNativeWatchDispositions(relayed, 'consumer-1', delivery!.id, [open], 21);
    const acked = acknowledgeNativeWatch(recorded, 'consumer-1', delivery!.id, 22);
    const restoredAck = decodeNativeWatchState(JSON.parse(JSON.stringify(acked)));
    expect(restoredAck.work[0]).toMatchObject({
      ...open,
      at: 21,
      event: {
        source: 'comments',
        url: 'https://github.com/example/project/pull/7#issuecomment-1',
        head: sha('a'),
      },
    });
    expect(acked.work).toEqual(restoredAck.work);
    const later = reconcileNativeWatch(
      restoredAck,
      sweep({
        at: 2_000,
        sources: [
          {source: 'comments', complete: true, at: 2_000, items: []},
          {source: 'reviews', complete: true, at: 2_000, items: [entity('new-review')]},
        ],
      }),
    );
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(later.sources, source => source.source === 'comments'))?.items,
    ).toEqual([]);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(later.events, event => event.key === 'one')),
    ).toMatchObject({key: 'one', removed: true});
    const withNewDelivery = relayNativeWatch(later, 'consumer-1', 23);
    expect(withNewDelivery.work[0]?.event).toEqual(acked.work[0]?.event);
    expect(
      errorCode(() =>
        updateNativeWatchWork(
          withNewDelivery.state,
          'stranger',
          [{eventId: open.eventId, status: 'resolved', reason: 'Fixed', evidence: 'commit abc'}],
          24,
        ),
      ),
    ).toBe('invalid-watch');
    const unchanged = JSON.stringify(withNewDelivery.state);
    expect(
      errorCode(() =>
        updateNativeWatchWork(
          withNewDelivery.state,
          'consumer-1',
          [{eventId: 'watch-1:999', status: 'resolved', reason: 'Fixed', evidence: 'commit abc'}],
          24,
        ),
      ),
    ).toBe('invalid-watch');
    expect(JSON.stringify(withNewDelivery.state)).toBe(unchanged);
    const forged = Object.assign(
      {eventId: open.eventId, status: 'resolved' as const, reason: 'Fixed', evidence: 'commit abc'},
      {event: {...acked.work[0].event, source: 'reviews' as const}},
    );
    expect(errorCode(() => updateNativeWatchWork(withNewDelivery.state, 'consumer-1', [forged], 24))).toBe(
      'invalid-watch',
    );
    expect(JSON.stringify(withNewDelivery.state)).toBe(unchanged);
    const resolved = updateNativeWatchWork(
      withNewDelivery.state,
      'consumer-1',
      [{eventId: open.eventId, status: 'resolved', reason: 'Fixed', evidence: 'commit abc'}],
      24,
    );
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(resolved.work, item => item.eventId === open.eventId))?.status,
    ).toBe('resolved');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(resolved.work, item => item.eventId === open.eventId))?.event,
    ).toEqual(acked.work[0]?.event);
    const reopened = updateNativeWatchWork(
      resolved,
      'consumer-1',
      [{eventId: open.eventId, status: 'open', reason: 'Regression', evidence: 'new failing check'}],
      25,
    );
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(reopened.work, item => item.eventId === open.eventId))?.status,
    ).toBe('open');
    const recordedNew = recordNativeWatchDispositions(
      withNewDelivery.state,
      'consumer-1',
      withNewDelivery.delivery!.id,
      EffectArray.map(withNewDelivery.delivery!.events, event => ({
        eventId: event.id,
        status: 'ignored' as const,
        reason: 'Duplicate context',
        evidence: 'same thread',
      })),
      24,
    );
    const ackedNew = acknowledgeNativeWatch(recordedNew, 'consumer-1', withNewDelivery.delivery!.id, 25);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(ackedNew.work, item => item.eventId === open.eventId))?.status,
    ).toBe('open');
  });

  it('compacts acknowledged terminal work on explicit updates while preserving pending dispositions', () => {
    const base = reconcileNativeWatch(
      state(),
      sweep({
        sources: [{source: 'comments', complete: true, at: 1_000, items: [entity('first'), entity('second')]}],
      }),
    );
    const acknowledged = 130;
    const event = base.events[0];
    const provenance = (sequence: number) => ({
      ...event,
      id: `watch-1:${sequence}`,
      sequence,
      key: `event-${sequence}`,
    });
    const handcrafted = decodeNativeWatchState({
      ...base,
      acknowledged,
      nextSequence: 133,
      events: EffectArray.map([131, 132], sequence => ({
        ...event,
        id: `watch-1:${sequence}`,
        sequence,
        key: `event-${sequence}`,
      })),
      consumer: {id: 'consumer-1', wakeupId: 'wake-1', lastSeenAt: 10, leaseUntil: 900_010, leaseMilliseconds: 900_000},
      delivery: {id: '131:132', first: 131, last: 132},
      work: [
        ...Array.from({length: 130}, (_, index) => ({
          eventId: `watch-1:${index + 1}`,
          status: 'ignored' as const,
          reason: 'Old terminal record',
          evidence: 'old evidence',
          event: provenance(index + 1),
          at: 2,
        })),
        {
          eventId: 'watch-1:132',
          status: 'ignored' as const,
          reason: 'Pending terminal record',
          evidence: 'pending evidence',
          event: provenance(132),
          at: 3,
        },
      ],
    });
    const compacted = updateNativeWatchWork(
      handcrafted,
      'consumer-1',
      [{eventId: 'watch-1:1', status: 'open', reason: 'Reopened explicitly', evidence: 'new evidence'}],
      20,
    );
    expect(EffectArray.filter(compacted.work, item => item.status === 'ignored')).toHaveLength(129);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(compacted.work, item => item.eventId === 'watch-1:1'))?.status,
    ).toBe('open');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(compacted.work, item => item.eventId === 'watch-1:132'))
        ?.reason,
    ).toBe('Pending terminal record');
    expect(compacted.acknowledged).toBe(acknowledged);
    expect(compacted.delivery).toEqual(handcrafted.delivery);
  });

  it('records lifecycle events once while pending and never resolves queued work', () => {
    const withOpenWork = decodeNativeWatchState({
      ...state(),
      nextSequence: 2,
      events: [
        {
          sequence: 1,
          id: 'watch-1:1',
          source: 'comments',
          kind: 'comment',
          key: 'comment-1',
          version: digest('a'),
          at: 1,
          removed: false,
        },
      ],
      work: [
        {
          eventId: 'watch-1:1',
          status: 'open',
          reason: 'Review needed',
          evidence: 'thread',
          event: {
            sequence: 1,
            id: 'watch-1:1',
            source: 'comments',
            kind: 'comment',
            key: 'comment-1',
            version: digest('a'),
            at: 1,
            removed: false,
          },
          at: 1,
        },
      ],
    });
    const lifecycle = recordNativeWatchLifecycle(withOpenWork, 'watcher_timeout', 'poll-timeout', 2);
    expect(lifecycle.events.at(-1)).toMatchObject({
      source: 'watch',
      kind: 'watcher_timeout',
      key: 'poll-timeout',
      url: pr,
      removed: false,
    });
    expect(recordNativeWatchLifecycle(lifecycle, 'watcher_timeout', 'poll-timeout', 3)).toEqual(lifecycle);
    expect(lifecycle.work).toEqual(withOpenWork.work);
    const full = decodeNativeWatchState({
      ...lifecycle,
      nextSequence: nativeWatchEventLimit + 1,
      events: Array.from({length: nativeWatchEventLimit}, (_, index) => ({
        sequence: index + 1,
        id: `watch-1:${index + 1}`,
        source: 'watch' as const,
        kind: 'watcher_stopped',
        key: `code-${index}`,
        version: digest('b'),
        at: index,
        removed: false,
      })),
      acknowledged: 0,
      delivery: null,
      work: [],
    });
    const before = JSON.stringify(full);
    expect(errorCode(() => recordNativeWatchLifecycle(full, 'watcher_error', 'poll-error', 4))).toBe('invalid-watch');
    expect(JSON.stringify(full)).toBe(before);
  });

  it('rejects capacity overflow without advancing any source checkpoint or input state', () => {
    const full = reconcileNativeWatch(
      state(),
      sweep({
        sources: [
          {
            source: 'comments',
            complete: true,
            at: 1_000,
            items: Array.from({length: nativeWatchEventLimit}, (_, index) => entity(`id-${index}`)),
          },
        ],
      }),
    );
    const before = JSON.stringify(full);
    expect(
      errorCode(() =>
        reconcileNativeWatch(
          full,
          sweep({at: 2_000, sources: [{source: 'comments', complete: true, at: 2_000, items: []}]}),
        ),
      ),
    ).toBe('invalid-watch');
    expect(JSON.stringify(full)).toBe(before);
    expect(full.sources[0]?.lastCompleteAt).toBe(1_000);
  });

  it('roundtrips crash-visible state at relay, disposition, and acknowledgement boundaries', () => {
    const events = reconcileNativeWatch(
      state(),
      sweep({
        sources: [
          {
            source: 'reviews',
            complete: true,
            at: 1_000,
            items: [entity('review')],
          },
        ],
      }),
    );
    const owned = withConsumer(events);
    const relayed = relayNativeWatch(decodeNativeWatchState(JSON.parse(JSON.stringify(owned))), 'consumer-1', 20);
    expect(
      relayNativeWatch(decodeNativeWatchState(JSON.parse(JSON.stringify(relayed.state))), 'consumer-1', 21).delivery,
    ).toEqual(relayed.delivery);
    const disposition = {
      eventId: required(relayed.delivery).events[0].id,
      status: 'blocked' as const,
      reason: 'Waiting for CI',
      evidence: 'check details',
    };
    const recorded = recordNativeWatchDispositions(
      decodeNativeWatchState(JSON.parse(JSON.stringify(relayed.state))),
      'consumer-1',
      relayed.delivery!.id,
      [disposition],
      22,
    );
    const acked = acknowledgeNativeWatch(
      decodeNativeWatchState(JSON.parse(JSON.stringify(recorded))),
      'consumer-1',
      relayed.delivery!.id,
      23,
    );
    expect(decodeNativeWatchState(JSON.parse(JSON.stringify(acked)))).toEqual(acked);
    expect(acked.work).toMatchObject([{status: 'blocked'}]);
  });

  it('compacts terminal work to the newest 128 records only after acknowledgement', () => {
    let current = withConsumer(
      reconcileNativeWatch(
        state(),
        sweep({
          sources: [
            {
              source: 'comments',
              complete: true,
              at: 1_000,
              items: Array.from({length: 140}, (_, index) => entity(`item-${index}`)),
            },
          ],
        }),
      ),
    );
    for (let at = 20; current.events.length > 0; at += 10) {
      const relayed = relayNativeWatch(current, 'consumer-1', at, 32);
      const dispositions = EffectArray.map(relayed.delivery!.events, event => ({
        eventId: event.id,
        status: 'ignored' as const,
        reason: 'Reviewed duplicate',
        evidence: 'linked issue',
      }));
      const recorded = recordNativeWatchDispositions(
        relayed.state,
        'consumer-1',
        relayed.delivery!.id,
        dispositions,
        at + 1,
      );
      expect(recorded.work.length).toBeLessThanOrEqual(140);
      current = acknowledgeNativeWatch(recorded, 'consumer-1', relayed.delivery!.id, at + 2);
    }
    expect(current.work).toHaveLength(128);
    expect(current.events).toHaveLength(0);
  });

  it('strictly decodes sequence, checkpoint, and delivery invariants', () => {
    const withEvents = reconcileNativeWatch(
      state(),
      sweep({sources: [{source: 'comments', complete: true, at: 1_000, items: [entity('one')]}]}),
    );
    const owned = withConsumer(withEvents);
    const relayed = relayNativeWatch(owned, 'consumer-1', 20).state;
    expect(errorCode(() => decodeNativeWatchState({...relayed, nextSequence: 10}))).toBe('invalid-watch');
    expect(errorCode(() => decodeNativeWatchState({...relayed, delivery: {id: '2:2', first: 2, last: 2}}))).toBe(
      'invalid-watch',
    );
    expect(
      errorCode(() => decodeNativeWatchState({...relayed, sources: [...relayed.sources, relayed.sources[0]]})),
    ).toBe('invalid-watch');
  });
});

describe('native merge conflict metadata', () => {
  const conflict = (overrides: Partial<NativeWatchSweep> = {}) =>
    sweep({
      base: sha('b'),
      startedBase: sha('b'),
      mergeable: false,
      ...overrides,
    });
  it('bootstraps actionable durable conflict work with no CI and deduplicates through unknown, restart and ack', () => {
    const initial = reconcileNativeWatch(state(), conflict());
    expect(initial.events).toHaveLength(1);
    expect(initial.events[0]).toMatchObject({
      source: 'watch',
      kind: 'merge_conflict',
      key: sha('b'),
      head: sha('a'),
      url: pr,
    });
    expect(initial.work).toHaveLength(1);
    expect(initial.work[0]).toMatchObject({status: 'open', eventId: initial.events[0].id});
    expect(initial.ci).toBeNull();
    const unknown = reconcileNativeWatch(initial, conflict({mergeable: null, at: 2_000}));
    const restarted = decodeNativeWatchState(JSON.parse(JSON.stringify(unknown)));
    const relayed = relayNativeWatch(withConsumer(restarted), 'consumer-1', 20);
    const recorded = recordNativeWatchDispositions(
      relayed.state,
      'consumer-1',
      required(relayed.delivery).id,
      [
        {
          eventId: initial.events[0].id,
          status: 'open',
          reason: initial.work[0].reason,
          evidence: initial.work[0].evidence,
        },
      ],
      21,
    );
    const acked = acknowledgeNativeWatch(recorded, 'consumer-1', required(relayed.delivery).id, 22);
    expect(acked.events).toHaveLength(0);
    expect(acked.work).toEqual(initial.work);
    const again = reconcileNativeWatch(acked, conflict({at: 3_000}));
    expect(again.events).toHaveLength(0);
    expect(again.work).toEqual(initial.work);
  });
  it('preserves work through missing and resolved metadata and emits a renewed explicit blockage', () => {
    const initial = reconcileNativeWatch(state(), conflict());
    const missing = reconcileNativeWatch(initial, sweep({at: 2_000}));
    expect(missing.work).toEqual(initial.work);
    expect(missing.mergeConflictVersion).toEqual(initial.mergeConflictVersion);
    const clear = reconcileNativeWatch(missing, conflict({mergeable: true, at: 3_000}));
    expect(clear.work).toEqual(initial.work);
    const renewed = reconcileNativeWatch(clear, conflict({at: 4_000}));
    expect(EffectArray.filter(renewed.events, event => event.kind === 'merge_conflict')).toHaveLength(2);
    expect(EffectArray.every(renewed.work, item => item.status === 'open')).toBe(true);
  });
  it('emits once per changed head/base and never infers a conflict from unknown or missing metadata', () => {
    let value = reconcileNativeWatch(state(), conflict());
    value = reconcileNativeWatch(value, conflict({base: sha('c'), startedBase: sha('c')}));
    value = reconcileNativeWatch(
      value,
      conflict({base: sha('c'), startedBase: sha('c'), head: sha('d'), startedHead: sha('d')}),
    );
    expect(EffectArray.filter(value.events, event => event.kind === 'merge_conflict')).toHaveLength(3);
    for (const metadata of [
      {mergeable: null},
      {},
      {mergeable: false},
      {state: 'closed' as const, mergeable: false, base: sha('b')},
    ]) {
      expect(
        EffectArray.some(
          reconcileNativeWatch(state(), sweep(metadata)).events,
          event => event.kind === 'merge_conflict',
        ),
      ).toBe(false);
    }
  });
  it('suppresses advisory completion during explicit conflict and base drift while preserving all five source fences', () => {
    const green = conflict({
      sources: allComplete(1_000),
      ci: {
        head: sha('a'),
        complete: true,
        count: 1,
        pending: 0,
        failed: 0,
        version: digest('c'),
      },
    });
    for (const metadata of [
      {mergeable: false},
      {mergeable: true, startedBase: sha('c')},
      {mergeable: true, sources: allComplete(1_000).slice(0, 4)},
      {mergeable: true, sources: allComplete(1_000, sha('d'))},
    ]) {
      const first = reconcileNativeWatch(state(), {...green, ...metadata});
      const later = reconcileNativeWatch(first, {...green, ...metadata, at: 61_000});
      expect(EffectArray.some(later.events, event => event.kind === 'ci_complete')).toBe(false);
    }
  });
  it('deduplicates the same pair across bounded arbitrary observations and JSON restarts', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('missing', 'unknown', 'conflict'), {maxLength: 20}), observations => {
        let current = reconcileNativeWatch(state(), conflict());
        for (const observation of observations) {
          const metadata = observation === 'missing' ? {} : {mergeable: observation === 'unknown' ? null : false};
          current = reconcileNativeWatch(
            decodeNativeWatchState(JSON.parse(JSON.stringify(current))),
            sweep({base: sha('b'), startedBase: sha('b'), ...metadata}),
          );
          expect(EffectArray.filter(current.events, event => event.kind === 'merge_conflict')).toHaveLength(1);
          expect(current.work).toHaveLength(1);
          expect(current.work[0].status).toBe('open');
        }
      }),
      {numRuns: 32},
    );
  });
  it('retains legacy native v1 decoding and rejects malformed optional metadata', () => {
    expect(decodeNativeWatchState(state()).base).toBeUndefined();
    for (const metadata of [{base: 'invalid'}, {startedBase: 'invalid'}, {mergeable: 'dirty'}]) {
      expect(errorCode(() => reconcileNativeWatch(state(), {...sweep(), ...metadata}))).toBe('invalid-watch');
    }
  });
});
