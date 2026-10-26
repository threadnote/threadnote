import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  initializeNativeWatch,
  attachNativeWatchConsumer,
  reconcileNativeWatch,
  relayNativeWatch,
  recordNativeWatchDispositions,
  acknowledgeNativeWatch,
} from '@threadnote/workflow-automations/watch';
import {
  assertNativeWatchOutput,
  nativeWatchWorkList,
  nativeWatchWorkDetail,
} from '../../src/workflow_automation/watch_output.js';

function work(reason: string, evidence: string) {
  const state = reconcileNativeWatch(
    attachNativeWatchConsumer(
      initializeNativeWatch('fixture', 'https://github.com/fixture/repo/pull/1', 0),
      {id: 'consumer', wakeupId: 'heartbeat'},
      0,
    ),
    {
      head: 'a'.repeat(40),
      startedHead: 'a'.repeat(40),
      state: 'open',
      at: 1,
      sources: [
        {
          source: 'threads',
          complete: true,
          at: 1,
          items: [
            {
              id: 'thread',
              kind: 'review_thread',
              url: 'https://github.com/fixture/repo/pull/1#discussion_r1',
              version: 'b'.repeat(64),
              bootstrap: true,
            },
          ],
        },
      ],
      ci: {head: 'a'.repeat(40), complete: false, count: 0, pending: 0, failed: 0, version: 'c'.repeat(64)},
    },
  );
  const relayed = relayNativeWatch(state, 'consumer', 2);
  if (!relayed.delivery) throw new Error('Fixture must produce one delivery.');
  const recorded = recordNativeWatchDispositions(
    relayed.state,
    'consumer',
    relayed.delivery.id,
    [{eventId: relayed.delivery.events[0].id, status: 'open', reason, evidence}],
    3,
  );
  return acknowledgeNativeWatch(recorded, 'consumer', relayed.delivery.id, 4).work;
}
const identity = {protocolVersion: 1, executorVersion: 1, status: 'ok', watchId: 'fixture', revision: 'd'.repeat(64)};

describe('native watch bounded work readers', () => {
  it('round trips legal Unicode and escaping maxima through complete digest-bound pages', () => {
    fc.assert(
      fc.property(fc.constantFrom('界', '語', 'é', '"', '\\', '😀'), character => {
        const records = work(character.repeat(1024 / character.length), character.repeat(2048 / character.length));
        const before = JSON.stringify(records);
        const list = nativeWatchWorkList(records);
        expect(list.items).toHaveLength(1);
        assertNativeWatchOutput({...identity, work: list});
        let offset = 0;
        let digest: string | undefined;
        let result = '';
        for (;;) {
          const page = nativeWatchWorkDetail(records, records[0].eventId, offset, digest);
          assertNativeWatchOutput({...identity, workDetail: page});
          result += page.text;
          digest = page.sourceDigest;
          if (page.nextOffsetBytes === null) break;
          expect(page.nextOffsetBytes).toBeGreaterThan(offset);
          offset = page.nextOffsetBytes;
        }
        expect(JSON.parse(result)).toEqual(records[0]);
        expect(JSON.stringify(records)).toBe(before);
        expect(() => nativeWatchWorkDetail(records, records[0].eventId, 1)).toThrow();
        expect(() => nativeWatchWorkDetail(records, records[0].eventId, 0, 'f'.repeat(64))).toThrow();
      }),
      {numRuns: 12},
    );
  });

  it('returns a detail locator for work that exceeds the list budget', () => {
    const records = work('界'.repeat(1024), '語'.repeat(2048));
    expect(nativeWatchWorkList(records).items[0]).toMatchObject({
      available: false,
      eventId: records[0].eventId,
      event: {source: 'threads', key: 'thread', url: 'https://github.com/fixture/repo/pull/1#discussion_r1'},
      detail: {command: 'work-detail', eventId: records[0].eventId},
    });
    expect(() => assertNativeWatchOutput({oversized: '界'.repeat(8192)})).toThrow();
  });
});
