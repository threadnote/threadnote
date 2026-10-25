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

const required = <A>(value: A | null | undefined): A => {
  if (value === null || value === undefined) throw new Error('Expected a fixture delivery.');
  return value;
};
const sha = (letter: string) => letter.repeat(40);
const digest = (letter: string) => letter.repeat(64);
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
  sourceNames.map(source => ({
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
    expect(initial.events.map(event => event.key)).toEqual(['one']);
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
    expect(next.events.map(event => [event.key, event.kind, event.removed])).toEqual([
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
                  items: beforeIds.map(id => entity(id)),
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
                  items: afterIds.map(id => entity(id)),
                },
              ],
            }),
          );
          const diff = after.events
            .slice(before.events.length)
            .map(event => `${event.removed ? '-' : '+'}${event.key}`)
            .sort();
          const expected = [
            ...afterIds.filter(id => !beforeIds.includes(id)).map(id => `+${id}`),
            ...beforeIds.filter(id => !afterIds.includes(id)).map(id => `-${id}`),
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
    expect(failed.sources.find(item => item.source === 'comments')).toMatchObject({
      items: [entity('thread', {head: sha('b')})],
      lastCompleteAt: 1_000,
    });
    expect(failed.sources.find(item => item.source === 'checks')).toMatchObject({
      items: [],
      error: {code: 'head_changed'},
    });
    expect(failed.events.map(event => event.kind)).toEqual(['comment', 'source_error', 'source_error']);
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
      allComplete(at).map(result =>
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
    expect(current.sources.find(item => item.source === 'checks')?.items[0]?.version).toBe(digest('b'));
    expect(current.sources.find(item => item.source === 'statuses')?.items[0]?.version).toBe(digest('c'));

    const failed = reconcileNativeWatch(
      current,
      sweep({
        at: 8_000,
        sources: sourceResults(8_000, digest('d'), digest('c')).map(result =>
          result.source === 'checks'
            ? {...result, items: [entity('check-1', {kind: 'ci_error', version: digest('d')})]}
            : result,
        ),
      }),
    );
    expect(failed.events.map(event => event.kind)).toEqual(['ci_error']);
    expect(failed.sources.find(item => item.source === 'checks')?.items[0]?.kind).toBe('ci_error');

    const ci = {head: sha('a'), complete: true, count: 1, pending: 0, failed: 0, version: digest('e')};
    const firstComplete = reconcileNativeWatch(state(), sweep({sources: allComplete(1_000), ci}));
    const secondComplete = reconcileNativeWatch(firstComplete, sweep({at: 61_000, sources: allComplete(61_000), ci}));
    expect(secondComplete.events.map(event => event.kind)).toEqual(['ci_complete']);
  });

  it('emits head and terminal transitions once and ignores an initial head as noise', () => {
    const initial = reconcileNativeWatch(state(), sweep());
    expect(initial.events).toEqual([]);
    const changed = reconcileNativeWatch(initial, sweep({head: sha('b'), startedHead: sha('b'), at: 2_000}));
    expect(changed.events.map(event => event.kind)).toEqual(['head_changed']);
    const terminal = reconcileNativeWatch(
      changed,
      sweep({head: sha('b'), startedHead: sha('b'), state: 'merged', at: 3_000}),
    );
    const repeated = reconcileNativeWatch(
      terminal,
      sweep({head: sha('b'), startedHead: sha('b'), state: 'merged', at: 4_000}),
    );
    expect(terminal.events.map(event => event.kind)).toEqual(['head_changed', 'merged']);
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
    expect(newHeadConfirmed.events.filter(event => event.kind === 'ci_complete')).toHaveLength(2);
    expect(newHeadConfirmed.events.filter(event => event.kind === 'ci_complete').map(event => event.head)).toEqual([
      sha('a'),
      sha('b'),
    ]);
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
    expect(later.sources.find(source => source.source === 'comments')?.items).toEqual([]);
    expect(later.events.find(event => event.key === 'one')).toMatchObject({key: 'one', removed: true});
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
    expect(resolved.work.find(item => item.eventId === open.eventId)?.status).toBe('resolved');
    expect(resolved.work.find(item => item.eventId === open.eventId)?.event).toEqual(acked.work[0]?.event);
    const reopened = updateNativeWatchWork(
      resolved,
      'consumer-1',
      [{eventId: open.eventId, status: 'open', reason: 'Regression', evidence: 'new failing check'}],
      25,
    );
    expect(reopened.work.find(item => item.eventId === open.eventId)?.status).toBe('open');
    const recordedNew = recordNativeWatchDispositions(
      withNewDelivery.state,
      'consumer-1',
      withNewDelivery.delivery!.id,
      withNewDelivery.delivery!.events.map(event => ({
        eventId: event.id,
        status: 'ignored' as const,
        reason: 'Duplicate context',
        evidence: 'same thread',
      })),
      24,
    );
    const ackedNew = acknowledgeNativeWatch(recordedNew, 'consumer-1', withNewDelivery.delivery!.id, 25);
    expect(ackedNew.work.find(item => item.eventId === open.eventId)?.status).toBe('open');
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
      events: [131, 132].map(sequence => ({...event, id: `watch-1:${sequence}`, sequence, key: `event-${sequence}`})),
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
    expect(compacted.work.filter(item => item.status === 'ignored')).toHaveLength(129);
    expect(compacted.work.find(item => item.eventId === 'watch-1:1')?.status).toBe('open');
    expect(compacted.work.find(item => item.eventId === 'watch-1:132')?.reason).toBe('Pending terminal record');
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
      const dispositions = relayed.delivery!.events.map(event => ({
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
