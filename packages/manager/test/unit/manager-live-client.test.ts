import {Array as EffectArray, Option as EffectOption} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {createManagerLiveClient} from '../../src/live/client.js';
import {MANAGER_LIVE_LIMITS, ManagerLiveResource} from '../../src/live/contracts.js';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const resource: ManagerLiveResource = {topic: 'context-health', project: 'one'};
const other: ManagerLiveResource = {topic: 'context-health', project: 'two'};
const maintenance: ManagerLiveResource = {topic: 'context-maintenance', project: 'one'};
const frame = (type: string, rest: Record<string, unknown> = {}) => JSON.stringify({type, version: 1, ...rest});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}
class FakeSocket {
  readyState: 0 | 1 | 2 | 3 = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open(topics: string[] = ['context-health']) {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    this.emit(frame('welcome', {epoch: 'epoch-one', topics, heartbeatMilliseconds: 15_000}));
  }
  emit(text: string) {
    this.onmessage?.(new MessageEvent('message', {data: text}));
  }
  ack(generation?: number, startingSequence = 0, unavailable?: ManagerLiveResource[]) {
    this.emit(
      frame('subscribed', {
        epoch: 'epoch-one',
        generation: generation ?? this.lastGeneration(),
        startingSequence,
        unavailable,
      }),
    );
  }
  lastGeneration(): number {
    const generation = EffectArray.filter(this.sent, value => value.type === 'subscribe').at(-1)?.generation;
    if (typeof generation !== 'number') throw new Error('Expected a subscribed generation.');
    return generation;
  }
}
function harness(requestTicket: (signal: AbortSignal) => Promise<unknown> = async () => ({ticket: 'ticket'})) {
  const sockets: FakeSocket[] = [];
  const client = createManagerLiveClient({
    origin: 'http://127.0.0.1:1234',
    scopeKey: 'account-one',
    requestTicket,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0,
  });
  return {
    client,
    sockets,
    async connect() {
      client.start();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      return sockets[0];
    },
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('Manager live client', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one wire resource across local queries and fences each removed query', async () => {
    const h = harness();
    const pending = deferred<number>();
    const first = vi.fn(() => pending.promise);
    const second = vi.fn(async () => 2);
    const releaseFirst = h.client.subscribeQuery(resource, 'first', first, () => {});
    const releaseSecond = h.client.subscribeQuery(resource, 'second', second, () => {});
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open();
    expect(socket.sent.at(-1)?.resources).toEqual([resource]);
    expect(first).not.toHaveBeenCalled();
    socket.ack();
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(h.client.getQuerySnapshot(resource, 'second')).toEqual({status: 'ready', data: 2});
    releaseFirst();
    pending.resolve(1);
    await flush();
    expect(h.client.getQuerySnapshot(resource, 'first')).toEqual({status: 'loading'});
    expect(EffectArray.filter(socket.sent, value => value.type === 'subscribe')).toHaveLength(1);
    releaseSecond();
    expect(socket.sent.at(-1)?.resources).toEqual([]);
    h.client.stop();
  });

  it('invalidates all local variants with one follow-up each and fences availability and sequence gaps', async () => {
    const h = harness();
    const pending = [deferred<number>(), deferred<number>()];
    const readers = [vi.fn(() => pending[0].promise), vi.fn(() => pending[1].promise)];
    h.client.subscribeQuery(resource, 'a', readers[0], () => {});
    h.client.subscribeQuery(resource, 'b', readers[1], () => {});
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open();
    socket.ack();
    await flush();
    expect(EffectArray.map(readers, reader => reader.mock.calls.length)).toEqual([1, 1]);
    for (let sequence = 1; sequence <= 100; sequence++)
      socket.emit(
        frame('invalidation', {
          epoch: 'epoch-one',
          generation: socket.lastGeneration(),
          sequence,
          resource,
          revision: 'same',
        }),
      );
    expect(h.client.getQuerySnapshot(resource, 'a').status).toBe('loading');
    pending[0].resolve(1);
    pending[1].resolve(2);
    await flush();
    expect(EffectArray.map(readers, reader => reader.mock.calls.length)).toEqual([2, 2]);
    socket.emit(
      frame('availability', {
        epoch: 'epoch-one',
        generation: socket.lastGeneration(),
        sequence: 101,
        resource,
        available: false,
      }),
    );
    expect(h.client.getQuerySnapshot(resource, 'a').status).toBe('unsupported');
    expect(h.client.getQuerySnapshot(resource, 'b').status).toBe('unsupported');
    socket.emit(
      frame('availability', {
        epoch: 'epoch-one',
        generation: socket.lastGeneration(),
        sequence: 102,
        resource,
        available: true,
      }),
    );
    expect(EffectArray.filter(socket.sent, value => value.type === 'subscribe')).toHaveLength(2);
    const before = EffectArray.map(readers, reader => reader.mock.calls.length);
    socket.emit(
      frame('invalidation', {
        epoch: 'epoch-one',
        generation: socket.lastGeneration(),
        sequence: 104,
        resource,
        revision: 'gap',
      }),
    );
    socket.ack();
    await flush();
    expect(EffectArray.map(readers, reader => reader.mock.calls.length)).toEqual(
      EffectArray.map(before, count => count + 1),
    );
    h.client.stop();
  });

  it('enforces independent wire-group and local-query caps and frees both after final listeners', () => {
    const h = harness();
    const releases = Array.from({length: MANAGER_LIVE_LIMITS.queries}, (_, index) =>
      h.client.subscribeQuery(
        resource,
        `query:${index}`,
        async () => index,
        () => {},
      ),
    );
    expect(() =>
      h.client.subscribeQuery(
        resource,
        'overflow',
        async () => 0,
        () => {},
      ),
    ).toThrow('Too many live queries');
    releases[0]();
    const replacement = h.client.subscribeQuery(
      resource,
      'replacement',
      async () => 0,
      () => {},
    );
    for (const release of releases.slice(1)) release();
    replacement();
    const groups = Array.from({length: MANAGER_LIVE_LIMITS.subscriptions}, (_, index) =>
      h.client.subscribe(
        {topic: 'home', project: `project-${index}`},
        async () => index,
        () => {},
      ),
    );
    expect(() =>
      h.client.subscribe(
        {topic: 'home', project: 'overflow'},
        async () => 0,
        () => {},
      ),
    ).toThrow('Too many live resources');
    for (const release of groups) release();
    expect(() =>
      h.client.subscribe(
        {topic: 'home', project: 'after-release'},
        async () => 0,
        () => {},
      ),
    ).not.toThrow();
    h.client.stop();
  });

  it('preserves an independent grouped-query scope and latest-value model across generated schedules', async () => {
    const operations = fc.array(
      fc.record({
        action: fc.constantFrom('mount', 'unmount', 'change', 'gap', 'ack', 'resolve', 'scope'),
        group: fc.integer({min: 0, max: 1}),
        query: fc.integer({min: 0, max: 1}),
      }),
      {minLength: 8, maxLength: 28},
    );
    await fc.assert(
      fc.asyncProperty(operations, async schedule => {
        const h = harness();
        const groups: ManagerLiveResource[] = [resource, {topic: 'worksets', scope: 'account'}];
        const mounted = new Map<string, () => void>();
        const latest = [0, 0];
        let scope = 0;
        let sequence = 0;
        let acknowledged = false;
        const reads: Array<{
          group: number;
          query: number;
          signal: AbortSignal;
          value: {scope: number; revision: number; query: number};
          pending: ReturnType<typeof deferred<{scope: number; revision: number; query: number}>>;
          settled: boolean;
        }> = [];
        const key = (group: number, query: number) => `${group}:${query}`;
        const reader = (group: number, query: number) => (signal: AbortSignal) => {
          const row = {
            group,
            query,
            signal,
            value: {scope, revision: latest[group], query},
            pending: deferred<{scope: number; revision: number; query: number}>(),
            settled: false,
          };
          reads.push(row);
          return row.pending.promise;
        };
        const mount = (group: number, query: number) => {
          const id = key(group, query);
          if (!mounted.has(id))
            mounted.set(
              id,
              h.client.subscribeQuery(groups[group], id, reader(group, query), () => {}),
            );
        };
        mount(0, 0);
        h.client.start();
        await flush();
        let socket = h.sockets[0];
        socket.open(['context-health', 'worksets']);
        try {
          for (const {action, group, query} of schedule) {
            if (action === 'mount') mount(group, query);
            else if (action === 'unmount') {
              mounted.get(key(group, query))?.();
              mounted.delete(key(group, query));
            } else if (action === 'ack') {
              socket.ack(undefined, sequence);
              acknowledged = true;
            } else if (action === 'change' || action === 'gap') {
              latest[group]++;
              if (acknowledged) {
                sequence += action === 'gap' ? 2 : 1;
                socket.emit(
                  frame('invalidation', {
                    epoch: 'epoch-one',
                    generation: socket.lastGeneration(),
                    sequence,
                    resource: groups[group],
                    revision: String(latest[group]),
                  }),
                );
                if (action === 'gap') acknowledged = false;
              }
            } else if (action === 'resolve') {
              const row = EffectOption.getOrUndefined(EffectArray.findFirst(reads, candidate => !candidate.settled));
              if (row) {
                row.settled = true;
                row.pending.resolve(row.value);
              }
            } else {
              for (const release of mounted.values()) release();
              mounted.clear();
              scope++;
              latest[0] = latest[1] = 0;
              h.client.setScope(`account-${scope}`);
              mount(group, query);
              await flush();
              socket = h.sockets.at(-1)!;
              socket.open(['context-health', 'worksets']);
              sequence = 0;
              acknowledged = false;
            }
            await flush();
            const expectedGroups = new Set(EffectArray.map([...mounted.keys()], id => Number(id[0])));
            const sent = EffectArray.filter(socket.sent, value => value.type === 'subscribe').at(-1);
            expect(
              EffectArray.map(
                Schema.decodeUnknownSync(Schema.Array(ManagerLiveResource))(sent?.resources ?? []),
                value => JSON.stringify(value),
              ).sort(),
            ).toEqual(EffectArray.map([...expectedGroups], index => JSON.stringify(groups[index])).sort());
            for (let g = 0; g < 2; g++)
              for (let q = 0; q < 2; q++) {
                const snapshot = h.client.getQuerySnapshot(groups[g], key(g, q));
                if (!mounted.has(key(g, q))) expect(snapshot.status).toBe('loading');
                if (snapshot.status === 'ready') expect(snapshot.data).toEqual({scope, revision: latest[g], query: q});
                expect(
                  EffectArray.filter(
                    reads,
                    row => row.group === g && row.query === q && !row.settled && !row.signal.aborted,
                  ).length,
                ).toBeLessThanOrEqual(1);
              }
          }
        } finally {
          h.client.stop();
          for (const row of reads) row.pending.resolve(row.value);
          await flush();
        }
      }),
      {numRuns: 24},
    );
  });

  it('waits for the current ACK, then stays idle for 60 seconds without recurring business reads', async () => {
    const h = harness();
    const reader = vi.fn(async () => ({count: 1}));
    h.client.subscribe(resource, reader, () => {});
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open();
    expect(reader).toHaveBeenCalledTimes(0);
    const obsoleteGeneration = socket.lastGeneration();
    h.client.subscribe(
      other,
      async () => 2,
      () => {},
    );
    socket.ack(obsoleteGeneration);
    await flush();
    expect(reader).toHaveBeenCalledTimes(0);
    socket.ack();
    await flush();
    expect(reader).toHaveBeenCalledTimes(1);
    const snapshot = h.client.getSnapshot(resource);
    for (let time = 0; time < 60_000; time += 15_000) {
      await vi.advanceTimersByTimeAsync(15_000);
      socket.emit(frame('heartbeat', {epoch: 'epoch-one'}));
    }
    expect(reader).toHaveBeenCalledTimes(1);
    expect(h.client.getSnapshot(resource)).toBe(snapshot);
    h.client.stop();
  });

  it('coalesces 100 invalidations during a pending read into one follow-up', async () => {
    const h = harness();
    const first = deferred<number>();
    const second = deferred<number>();
    const reader = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const observed: string[] = [];
    h.client.subscribe(resource, reader, () => observed.push(h.client.getSnapshot(resource).status));
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open();
    socket.ack();
    await flush();
    for (let sequence = 1; sequence <= 100; sequence++)
      socket.emit(
        frame('invalidation', {
          epoch: 'epoch-one',
          generation: socket.lastGeneration(),
          sequence,
          resource,
          revision: `r${sequence}`,
        }),
      );
    expect(reader).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await flush();
    expect(reader).toHaveBeenCalledTimes(2);
    expect(observed).not.toContain('ready');
    second.resolve(2);
    await flush();
    expect(observed.at(-1)).toBe('ready');
    expect(h.client.getSnapshot(resource)).toMatchObject({status: 'ready', data: 2});
    h.client.stop();
  });

  it('fences old ACKs and read results across subscription and scope replacement', async () => {
    const h = harness();
    const first = deferred<number>();
    const reader = vi.fn(() => first.promise);
    const unsubscribe = h.client.subscribe(resource, reader, () => {});
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open();
    const oldGeneration = socket.lastGeneration();
    h.client.subscribe(
      other,
      async () => 2,
      () => {},
    );
    socket.ack(oldGeneration);
    await flush();
    expect(reader).toHaveBeenCalledTimes(0);
    socket.ack();
    await flush();
    expect(reader).toHaveBeenCalledTimes(1);
    h.client.setScope('account-two');
    first.resolve(7);
    await flush();
    expect(h.client.getSnapshot(resource)).toEqual({status: 'loading'});
    expect(socket.closed).toBe(true);
    unsubscribe();
    h.client.stop();
  });

  it('resubscribes after a sequence gap and ignores duplicate events', async () => {
    const h = harness();
    const reader = vi.fn(async () => 1);
    h.client.subscribe(resource, reader, () => {});
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open();
    socket.ack();
    await flush();
    const initial = socket.lastGeneration();
    socket.emit(frame('invalidation', {epoch: 'epoch-one', generation: initial, sequence: 1, resource, revision: 'a'}));
    socket.emit(frame('invalidation', {epoch: 'epoch-one', generation: initial, sequence: 1, resource, revision: 'a'}));
    await flush();
    expect(reader).toHaveBeenCalledTimes(2);
    socket.emit(frame('invalidation', {epoch: 'epoch-one', generation: initial, sequence: 3, resource, revision: 'b'}));
    expect(socket.lastGeneration()).toBeGreaterThan(initial);
    socket.ack(initial);
    await flush();
    expect(reader).toHaveBeenCalledTimes(2);
    socket.ack();
    await flush();
    expect(reader).toHaveBeenCalledTimes(3);
    h.client.stop();
  });

  it('reconnects on epoch mismatch and waits for the new epoch ACK', async () => {
    const h = harness();
    const reader = vi.fn(async () => 1);
    h.client.subscribe(resource, reader, () => {});
    h.client.start();
    await flush();
    const original = h.sockets[0];
    original.open();
    original.ack();
    await flush();
    expect(reader).toHaveBeenCalledTimes(1);
    original.emit(frame('heartbeat', {epoch: 'another-epoch'}));
    expect(original.closed).toBe(true);
    expect(h.client.getSnapshot(resource).status).toBe('stale');
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    const replacement = h.sockets[1];
    replacement.open();
    await flush();
    expect(reader).toHaveBeenCalledTimes(1);
    replacement.ack();
    await flush();
    expect(reader).toHaveBeenCalledTimes(2);
    h.client.stop();
  });

  it('marks only explicit legacy capability unsupported; auth failure retries', async () => {
    const legacy = harness(async () => {
      throw Object.assign(new Error('unsupported'), {status: 404});
    });
    legacy.client.subscribe(
      resource,
      async () => 1,
      () => {},
    );
    legacy.client.start();
    await flush();
    expect(legacy.client.getConnectionSnapshot()).toBe('unsupported');
    legacy.client.stop();
    const auth = harness(async () => {
      throw Object.assign(new Error('unauthorized'), {status: 401});
    });
    auth.client.subscribe(
      resource,
      async () => 1,
      () => {},
    );
    auth.client.start();
    await flush();
    expect(auth.client.getConnectionSnapshot()).toBe('stale');
    auth.client.stop();
    const missing = harness();
    missing.client.subscribe(
      resource,
      async () => 1,
      () => {},
    );
    missing.client.start();
    await flush();
    missing.sockets[0].open(['context-maintenance']);
    expect(missing.client.getSnapshot(resource).status).toBe('unsupported');
    missing.client.stop();
  });

  it('keeps missing topic unsupported beside a supported topic, including late subscriptions', async () => {
    const h = harness();
    h.client.subscribe(
      maintenance,
      async () => 1,
      () => {},
    );
    h.client.subscribe(
      resource,
      async () => 2,
      () => {},
    );
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open(['context-maintenance']);
    expect(h.client.getSnapshot(resource).status).toBe('unsupported');
    socket.ack();
    await flush();
    expect(h.client.getSnapshot(resource).status).toBe('unsupported');
    expect(h.client.getSnapshot(maintenance).status).toBe('ready');
    h.client.subscribe(
      other,
      async () => 3,
      () => {},
    );
    expect(h.client.getSnapshot(other).status).toBe('unsupported');
    socket.ack();
    await flush();
    expect(h.client.getSnapshot(resource).status).toBe('unsupported');
    expect(h.client.getSnapshot(other).status).toBe('unsupported');
    h.client.stop();
  });

  it('keeps an ACK-unavailable resource subscribed and waits for a recovery ACK before reading', async () => {
    const h = harness();
    const healthRead = vi.fn(async () => 2);
    const maintenanceRead = vi.fn(async () => 1);
    h.client.subscribe(resource, healthRead, () => {});
    h.client.subscribe(maintenance, maintenanceRead, () => {});
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open(['context-health', 'context-maintenance']);
    const subscription = EffectArray.filter(socket.sent, value => value.type === 'subscribe').at(-1);
    expect(subscription?.resources).toEqual([resource, maintenance]);
    socket.ack(undefined, 0, [resource]);
    await flush();
    expect(h.client.getSnapshot(resource).status).toBe('unsupported');
    expect(healthRead).toHaveBeenCalledTimes(0);
    expect(maintenanceRead).toHaveBeenCalledTimes(1);
    const oldGeneration = socket.lastGeneration();
    socket.emit(
      frame('availability', {epoch: 'epoch-one', generation: oldGeneration, sequence: 1, resource, available: true}),
    );
    expect(socket.lastGeneration()).toBeGreaterThan(oldGeneration);
    expect(healthRead).toHaveBeenCalledTimes(0);
    socket.ack(oldGeneration);
    await flush();
    expect(healthRead).toHaveBeenCalledTimes(0);
    socket.ack();
    await flush();
    expect(healthRead).toHaveBeenCalledTimes(1);
    expect(h.client.getSnapshot(resource)).toMatchObject({status: 'ready', data: 2});
    h.client.stop();
  });

  it('fences a read on availability loss and retains its old data until a clean recovery read', async () => {
    const h = harness();
    const first = deferred<number>();
    const recovery = deferred<number>();
    const read = vi
      .fn()
      .mockResolvedValueOnce(7)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(recovery.promise);
    const statuses: string[] = [];
    h.client.subscribe(resource, read, () => statuses.push(h.client.getSnapshot(resource).status));
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open();
    socket.ack();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.client.getSnapshot(resource)).toMatchObject({status: 'ready', data: 7});
    h.client.invalidate(resource);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    socket.emit(
      frame('availability', {
        epoch: 'epoch-one',
        generation: socket.lastGeneration(),
        sequence: 1,
        resource,
        available: false,
      }),
    );
    expect(h.client.getSnapshot(resource)).toMatchObject({status: 'unsupported', data: 7});
    const afterLoss = statuses.length;
    first.resolve(11);
    await flush();
    expect(statuses.slice(afterLoss)).not.toContain('ready');
    h.client.invalidate(resource);
    expect(read).toHaveBeenCalledTimes(2);
    socket.emit(
      frame('availability', {
        epoch: 'epoch-one',
        generation: socket.lastGeneration(),
        sequence: 2,
        resource,
        available: true,
      }),
    );
    expect(read).toHaveBeenCalledTimes(2);
    socket.ack();
    await flush();
    expect(read).toHaveBeenCalledTimes(3);
    recovery.resolve(22);
    await flush();
    expect(h.client.getSnapshot(resource)).toMatchObject({status: 'ready', data: 22});
    h.client.stop();
  });

  it('marks a subscription after a legacy ticket response unsupported', async () => {
    const h = harness(async () => {
      throw Object.assign(new Error('legacy'), {status: 404});
    });
    h.client.start();
    await flush();
    expect(h.client.getConnectionSnapshot()).toBe('unsupported');
    h.client.subscribe(
      resource,
      async () => 1,
      () => {},
    );
    expect(h.client.getSnapshot(resource).status).toBe('unsupported');
    h.client.stop();
  });

  it('times out pending ticket and missing ACK, then reconnects without an early read', async () => {
    const heldTicket = deferred<{ticket: string}>();
    let requests = 0;
    const h = harness(async () => (++requests === 1 ? heldTicket.promise : {ticket: 'fresh'}));
    const reader = vi.fn(async () => 1);
    h.client.subscribe(resource, reader, () => {});
    h.client.start();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.client.getConnectionSnapshot()).toBe('stale');
    heldTicket.resolve({ticket: 'old'});
    await flush();
    expect(h.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(h.sockets).toHaveLength(1);
    const socket = h.sockets[0];
    socket.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reader).toHaveBeenCalledTimes(0);
    expect(socket.closed).toBe(true);
    expect(h.client.getConnectionSnapshot()).toBe('stale');
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    const next = h.sockets[1];
    next.open();
    next.ack();
    await flush();
    expect(reader).toHaveBeenCalledTimes(1);
    h.client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out sockets that never open or never send welcome', async () => {
    const h = harness();
    h.client.subscribe(
      resource,
      async () => 1,
      () => {},
    );
    h.client.start();
    await flush();
    const unopened = h.sockets[0];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(unopened.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    const silent = h.sockets[1];
    silent.readyState = 1;
    silent.onopen?.(new Event('open'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(silent.closed).toBe(true);
    expect(h.client.getSnapshot(resource).status).toBe('loading');
    h.client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases socket, timer, listener and read on unsubscribe and stop', async () => {
    const h = harness();
    const read = deferred<number>();
    const listener = vi.fn();
    const unsubscribe = h.client.subscribe(resource, () => read.promise, listener);
    h.client.start();
    await flush();
    const socket = h.sockets[0];
    socket.open();
    socket.ack();
    await flush();
    unsubscribe();
    const calls = listener.mock.calls.length;
    read.resolve(1);
    await flush();
    expect(listener).toHaveBeenCalledTimes(calls);
    h.client.stop();
    expect(socket.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed successful ticket responses before creating a socket', async () => {
    for (const payload of [
      undefined,
      null,
      {},
      {ticket: null},
      {ticket: 1},
      {ticket: ''},
      {ticket: Effect.pipe('x', EffectString.repeat(129))},
    ]) {
      const h = harness(async () => payload);
      const reader = vi.fn(async () => 1);
      h.client.subscribe(resource, reader, () => {});
      h.client.start();
      await flush();
      expect(h.sockets).toHaveLength(0);
      expect(reader).not.toHaveBeenCalled();
      expect(h.client.getConnectionSnapshot()).toBe('stale');
      h.client.stop();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('does not deduplicate a recurring revision across a reconnect snapshot', async () => {
    const h = harness();
    const reads: ReturnType<typeof deferred<string>>[] = [];
    h.client.subscribe(
      resource,
      () => {
        const pending = deferred<string>();
        reads.push(pending);
        return pending.promise;
      },
      () => {},
    );
    h.client.start();
    await flush();
    let socket = h.sockets[0];
    socket.open();
    socket.ack();
    await flush();
    reads[0].resolve('A');
    await flush();
    socket.emit(
      frame('invalidation', {
        epoch: 'epoch-one',
        generation: socket.lastGeneration(),
        sequence: 1,
        resource,
        revision: 'A',
      }),
    );
    await flush();
    reads[1].resolve('A');
    await flush();
    socket.onclose?.(new CloseEvent('close'));
    await vi.advanceTimersByTimeAsync(375);
    socket = h.sockets[1];
    socket.open();
    socket.ack();
    await flush();
    // The new snapshot captured B while disconnected; the source now returns to A.
    socket.emit(
      frame('invalidation', {
        epoch: 'epoch-one',
        generation: socket.lastGeneration(),
        sequence: 1,
        resource,
        revision: 'A',
      }),
    );
    reads[2].resolve('B');
    await flush();
    expect(h.client.getSnapshot(resource).status).toBe('stale');
    expect(reads).toHaveLength(4);
    reads[3].resolve('A');
    await flush();
    expect(h.client.getSnapshot(resource)).toEqual({status: 'ready', data: 'A'});
    h.client.stop();
  });

  it('never publishes obsolete data across generated ACK, event, read and scope schedules', async () => {
    const operation = fc.constantFrom('ack', 'change', 'duplicate', 'gap', 'resolve', 'scope', 'reconnect');
    await fc.assert(
      fc.asyncProperty(fc.array(operation, {minLength: 12, maxLength: 40}), async operations => {
        const h = harness();
        let source = 0;
        let scope = 0;
        let sequence = 0;
        let acknowledged = false;
        const reads: Array<{
          signal: AbortSignal;
          value: {source: number; scope: number};
          pending: ReturnType<typeof deferred<{source: number; scope: number}>>;
          settled: boolean;
        }> = [];
        const reader = (signal: AbortSignal) => {
          const row = {
            signal,
            value: {source, scope},
            pending: deferred<{source: number; scope: number}>(),
            settled: false,
          };
          reads.push(row);
          return row.pending.promise;
        };
        let unsubscribe = h.client.subscribe(resource, reader, () => {});
        h.client.start();
        await flush();
        let socket = h.sockets[0];
        socket.open();
        const settle = async () => {
          const row = EffectOption.getOrUndefined(EffectArray.findFirst(reads, value => !value.settled));
          if (row) {
            row.settled = true;
            row.pending.resolve(row.value);
            await flush();
          }
        };
        try {
          for (const op of ['ack', ...operations]) {
            if (op === 'ack') {
              socket.ack(undefined, sequence);
              acknowledged = true;
            } else if (op === 'change' || op === 'gap') {
              source++;
              if (acknowledged) {
                sequence += op === 'gap' ? 2 : 1;
                socket.emit(
                  frame('invalidation', {
                    epoch: 'epoch-one',
                    generation: socket.lastGeneration(),
                    sequence,
                    resource,
                    revision: `revision-${source % 2}`,
                  }),
                );
                if (op === 'gap') acknowledged = false;
              }
            } else if (op === 'duplicate' && acknowledged) {
              const before = h.client.getSnapshot(resource);
              socket.emit(
                frame('invalidation', {
                  epoch: 'epoch-one',
                  generation: socket.lastGeneration(),
                  sequence,
                  resource,
                  revision: 'duplicate',
                }),
              );
              expect(h.client.getSnapshot(resource)).toBe(before);
            } else if (op === 'resolve') await settle();
            else if (op === 'scope' || op === 'reconnect') {
              if (op === 'scope') {
                unsubscribe();
                scope++;
                h.client.setScope(`scope-${scope}`);
                unsubscribe = h.client.subscribe(resource, reader, () => {});
              } else {
                socket.onclose?.(new CloseEvent('close'));
                source++;
                await vi.advanceTimersToNextTimerAsync();
              }
              await flush();
              socket = h.sockets.at(-1)!;
              socket.open();
              sequence = 0;
              acknowledged = false;
            }
            await flush();
            const activeReads = EffectArray.filter(reads, row => !row.settled && !row.signal.aborted);
            expect(activeReads.length).toBeLessThanOrEqual(1);
            if (!acknowledged) expect(activeReads).toHaveLength(0);
            const snapshot = h.client.getSnapshot(resource);
            if (snapshot.status === 'ready') expect(snapshot.data).toEqual({source, scope});
          }
          if (!acknowledged) socket.ack(undefined, sequence);
          await flush();
          while (EffectArray.some(reads, row => !row.settled)) await settle();
          expect(h.client.getSnapshot(resource)).toEqual({status: 'ready', data: {source, scope}});
        } finally {
          h.client.stop();
          for (const row of reads) row.pending.resolve(row.value);
          await flush();
          expect(vi.getTimerCount()).toBe(0);
        }
      }),
      {numRuns: 24},
    );
  });

  it('keeps scoped cache identity independent under bounded subscription operations', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.boolean(), fc.boolean()), {minLength: 1, maxLength: 24}), operations => {
        const h = harness();
        const active = new Map<string, () => void>();
        const resources = [resource, other];
        for (const [add, select] of operations) {
          const selected = resources[Number(select)];
          const key = selected.project;
          if (add && !active.has(key))
            active.set(
              key,
              h.client.subscribe(
                selected,
                async () => key,
                () => {},
              ),
            );
          if (!add && active.has(key)) {
            active.get(key)!();
            active.delete(key);
          }
          for (const candidate of resources) {
            const snapshot = h.client.getSnapshot(candidate);
            expect(snapshot.status).toBe('loading');
            expect(h.client.getSnapshot(candidate)).toBe(snapshot);
          }
        }
        h.client.stop();
      }),
      {numRuns: 24},
    );
  });
});
