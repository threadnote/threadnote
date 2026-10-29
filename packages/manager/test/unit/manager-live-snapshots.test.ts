import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {String as Str} from 'effect';
import {createManagerLiveClient} from '../../src/live/client.js';
import {
  MANAGER_LIVE_LIMITS,
  type ManagerLiveResource,
  type ManagerLiveSnapshotTopic,
} from '../../src/live/contracts.js';
import {FakeManagerSocket, liveFrame} from './live-consumer-fixture.js';

const processes = {topic: 'processes', scope: 'account'} as const;
const graph = {topic: 'graph-status', scope: 'account'} as const;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture() {
  const reads = vi.fn(async () => ({value: 'rest'}));
  const client = createManagerLiveClient({
    origin: 'http://127.0.0.1:1234',
    scopeKey: 'one',
    requestTicket: async () => ({ticket: 'fixture'}),
    createSocket: () => new FakeManagerSocket(''),
    random: () => 0,
  });
  for (const resource of [processes, graph]) client.subscribe(resource, reads, () => undefined);
  client.start();
  return {client, reads};
}
beforeEach(() => {
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
});
afterEach(() => vi.useRealTimers());

it('receives initial and changed snapshots for both resources without REST reads or idle polling', async () => {
  const {client, reads} = fixture();
  await flush();
  const socket = FakeManagerSocket.instances[0];
  socket.open(['processes', 'graph-status'], ['processes', 'graph-status']);
  socket.ack();
  await flush();
  expect(reads).not.toHaveBeenCalled();
  let sequence = 0;
  for (let value = 0; value < 20; value++) {
    for (const resource of [processes, graph]) {
      socket.snapshot(++sequence, resource, {value});
      expect(client.getSnapshot(resource)).toEqual({status: 'ready', data: {value}});
    }
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reads).not.toHaveBeenCalled();
  client.revalidate();
  const generation = socket.sent.at(-1)?.generation;
  socket.ack(sequence);
  socket.snapshot(sequence + 1, processes, {value: 'revalidated'});
  expect(socket.sent.at(-1)?.generation).toBe(generation);
  expect(reads).not.toHaveBeenCalled();
  client.stop();
});

it('recovers sequence gaps and availability through a new ACK and snapshot, fencing old generations and scopes', async () => {
  const {client, reads} = fixture();
  await flush();
  const socket = FakeManagerSocket.instances[0];
  socket.open(['processes', 'graph-status'], ['processes', 'graph-status']);
  const oldGeneration = socket.sent.at(-1)?.generation;
  socket.snapshot(1, processes, {value: 'before-ack'});
  expect(client.getSnapshot(processes).status).toBe('loading');
  socket.ack();
  socket.snapshot(1, processes, {value: 'first'});
  socket.snapshot(3, processes, {value: 'gap'});
  expect(client.getSnapshot(processes)).toEqual({status: 'stale', data: {value: 'first'}});
  socket.emit(
    liveFrame('snapshot', {
      epoch: 'epoch-one',
      generation: oldGeneration,
      sequence: 2,
      resource: processes,
      data: {value: 'old-generation'},
    }),
  );
  socket.ack();
  socket.snapshot(1, processes, {value: 'recovered'});
  const availability = (sequence: number, available: boolean) =>
    socket.emit(
      liveFrame('availability', {
        epoch: 'epoch-one',
        generation: socket.sent.at(-1)?.generation,
        sequence,
        resource: processes,
        available,
      }),
    );
  availability(2, false);
  socket.snapshot(3, processes, {value: 'unavailable'});
  expect(client.getSnapshot(processes)).toEqual({status: 'unsupported', data: {value: 'recovered'}});
  availability(4, true);
  socket.ack();
  socket.snapshot(1, processes, {value: 'available'});
  expect(client.getSnapshot(processes)).toEqual({status: 'ready', data: {value: 'available'}});
  client.setScope('two');
  socket.snapshot(2, processes, {value: 'old-scope'});
  expect(client.getSnapshot(processes).status).toBe('loading');
  expect(reads).not.toHaveBeenCalled();
  client.stop();
});

it('uses event-triggered REST fallback for unavailable projections and fences its delayed result behind newer push data', async () => {
  const {client, reads} = fixture();
  const pending = Promise.withResolvers<{value: string}>();
  reads.mockImplementation(() => pending.promise);
  await flush();
  const socket = FakeManagerSocket.instances[0];
  socket.open(['processes', 'graph-status'], ['processes', 'graph-status']);
  socket.ack();
  socket.invalidate(1, processes);
  await flush();
  expect(reads).toHaveBeenCalledTimes(1);
  socket.snapshot(2, processes, {value: 'pushed'});
  pending.resolve({value: 'late-rest'});
  await flush();
  expect(client.getSnapshot(processes)).toEqual({status: 'ready', data: {value: 'pushed'}});
  expect(reads).toHaveBeenCalledTimes(1);
  client.stop();
});

it('preserves legacy reads when the server does not advertise snapshot support', async () => {
  const {client, reads} = fixture();
  await flush();
  const socket = FakeManagerSocket.instances[0];
  socket.open(['processes', 'graph-status']);
  socket.ack();
  await flush();
  expect(reads).toHaveBeenCalledTimes(2);
  socket.invalidate(1, processes);
  await flush();
  expect(reads).toHaveBeenCalledTimes(3);
  client.stop();
});

it('accepts bounded snapshots larger than control frames and rejects oversized snapshot frames', async () => {
  const {client} = fixture();
  await flush();
  const socket = FakeManagerSocket.instances[0];
  socket.open(['processes', 'graph-status'], ['processes', 'graph-status']);
  socket.ack();
  const value = Str.repeat(MANAGER_LIVE_LIMITS.messageBytes + 1)('x');
  socket.snapshot(1, processes, {value});
  expect(client.getSnapshot(processes)).toEqual({status: 'ready', data: {value}});
  socket.snapshot(2, processes, {value: Str.repeat(MANAGER_LIVE_LIMITS.snapshotBytes)('x')});
  expect(socket.readyState).toBe(3);
  expect(client.getSnapshot(processes)).toEqual({status: 'stale', data: {value}});
  client.stop();
});

it('only applies fresh, ordered snapshot deliveries under duplicate and old-generation replay', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          topic: fc.constantFrom('processes', 'graph-status'),
          value: fc.integer(),
          replay: fc.constantFrom('fresh', 'duplicate', 'old-generation'),
        }),
        {minLength: 1, maxLength: 35},
      ),
      async events => {
        const {client, reads} = fixture();
        await flush();
        const socket = FakeManagerSocket.instances.at(-1)!;
        socket.open(['processes', 'graph-status'], ['processes', 'graph-status']);
        socket.ack();
        const expected = new Map<ManagerLiveSnapshotTopic, number>();
        let sequence = 0;
        for (const event of events) {
          const resource: ManagerLiveResource = {topic: event.topic, scope: 'account'};
          if (event.replay === 'fresh') {
            socket.snapshot(++sequence, resource, {value: event.value});
            expected.set(event.topic, event.value);
          } else if (event.replay === 'duplicate') socket.snapshot(sequence, resource, {value: event.value});
          else
            socket.emit(
              liveFrame('snapshot', {
                epoch: 'epoch-one',
                generation: 99,
                sequence: sequence + 1,
                resource,
                data: {value: event.value},
              }),
            );
          for (const [topic, value] of expected)
            expect(client.getSnapshot({topic, scope: 'account'})).toEqual({
              status: 'ready',
              data: {value},
            });
        }
        expect(reads).not.toHaveBeenCalled();
        client.stop();
      },
    ),
    {numRuns: 30},
  );
});
