import {Array as EffectArray, Schema} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {runMcpBroker, type McpBrokerChild} from '@threadnote/threadnote/mcp/broker';

afterEach(() => vi.useRealTimers());

describe('MCP broker idle child retirement', () => {
  it.each(['EPIPE', 'ERR_STREAM_DESTROYED', 'EAGAIN', undefined])(
    'terminates the transport after a final response write fails (%s)',
    async code => {
      const session = startSession(async line => {
        if (line.id === 2) throw Object.assign(new Error('output failed'), {code});
      });
      await session.initialize();
      const child = session.children[0];
      session.send({id: 2, method: 'tools/call'});
      await settle();
      child.emit({id: 2, result: {ok: true}});
      await settle();
      expect(child.ended).toBe(true);
      expect(session.failure).toMatchObject({_tag: 'McpBrokerError'});
      session.send({id: 3, method: 'tools/call'});
      await settle();
      await vi.advanceTimersByTimeAsync(500);
      expect(session.children).toHaveLength(1);
      expect(EffectArray.some(child.received, line => line.id === 3)).toBe(false);
      expect(EffectArray.some(session.output, line => line.id === 2)).toBe(false);
      await session.close();
    },
  );

  it.each(['EPIPE', undefined])('fails closed for unclassified or terminal progress loss (%s)', async code => {
    const session = startSession(async line => {
      if (line.method === 'notifications/progress') throw Object.assign(new Error('output failed'), {code});
    });
    await session.initialize();
    session.children[0].emit({method: 'notifications/progress'});
    await settle();
    expect(session.children[0].ended).toBe(true);
    expect(session.failure).toMatchObject({_tag: 'McpBrokerError'});
    await session.close();
  });

  it.each([false, true])('bounds retirement when child EOF never completes: %s', async neverEnds => {
    const session = startSession();
    await session.initialize();
    const child = session.children[0];
    child.ignoreEnd = true;
    child.ignoreSignals = true;
    if (neverEnds) child.endGate = new Promise(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(child.endRequested).toBe(true);
    session.send({id: 2, method: 'tools/call'});
    await settle();
    const resumed = session.children[1];
    resumed.emit({id: 1, result: {}});
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(resumed.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    const closing = session.close();
    await settle();
    expect(resumed.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    expect(session.failure).toBeUndefined();
  });

  it('bounds shutdown directly when the current child never settles EOF', async () => {
    const session = startSession();
    await session.initialize();
    const child = session.children[0];
    child.endGate = new Promise(() => undefined);
    const closing = session.close();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    expect(child.signals).toEqual(['SIGTERM']);
    expect(child.ended).toBe(true);
  });

  it('releases an idle child and resumes the active release with initialization replay', async () => {
    const session = startSession();
    await session.initialize();
    await vi.advanceTimersByTimeAsync(100);
    expect(session.children[0].ended).toBe(true);
    session.version = '4.0.1';
    session.send({id: 2, method: 'tools/call'});
    await settle();
    const resumed = session.children[1];
    expect(resumed.received).toEqual([{jsonrpc: '2.0', id: 1, method: 'initialize', params: {}}]);
    resumed.emit({id: 1, result: {}});
    await settle();
    expect(EffectArray.map(resumed.received, line => line.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(resumed.version).toBe('4.0.1');
    resumed.emit({id: 2, result: {ok: true}});
    await settle();
    expect(EffectArray.filter(session.output, line => line.id === 1)).toHaveLength(1);
    expect(session.output.at(-1)).toMatchObject({id: 2, result: {ok: true}});
    await session.close();
  });

  it('keeps requests, progress and unflushed responses active until client output completes', async () => {
    const responseFlushed = Promise.withResolvers<void>();
    const session = startSession(line => (line.id === 2 ? responseFlushed.promise : Promise.resolve()));
    await session.initialize();
    session.send({id: 2, method: 'tools/call'});
    await settle();
    const child = session.children[0];
    child.emit({method: 'notifications/progress', params: {progressToken: 2, progress: 1}});
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(child.ended).toBe(false);
    child.emit({id: 2, result: {ok: true}});
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(child.ended).toBe(false);
    responseFlushed.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(99);
    expect(child.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.ended).toBe(true);
    await session.close();
  });

  it('does not retire while server routes, pending initialization or replay are outstanding', async () => {
    const session = startSession();
    session.send({id: 1, method: 'initialize', params: {}});
    await settle();
    const first = session.children[0];
    await vi.advanceTimersByTimeAsync(500);
    expect(first.ended).toBe(false);
    first.emit({id: 1, result: {}});
    await settle();
    session.send({method: 'notifications/initialized'});
    await settle();
    first.emit({id: 10, method: 'sampling/createMessage', params: {}});
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(first.ended).toBe(false);
    session.send({id: session.output.at(-1)?.id, result: {}});
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(first.ended).toBe(true);
    session.send({id: 2, method: 'tools/call'});
    await settle();
    const resumed = session.children[1];
    await vi.advanceTimersByTimeAsync(500);
    expect(resumed.ended).toBe(false);
    resumed.emit({id: 1, result: {}});
    await settle();
    resumed.emit({id: 2, result: {}});
    await settle();
    await session.close();
  });

  it('holds idle retirement while admitting a request and isolates an already retiring generation', async () => {
    const session = startSession();
    await session.initialize();
    const first = session.children[0];
    const releaseLookup = Promise.withResolvers<void>();
    session.releaseLookup = releaseLookup.promise;
    session.send({id: 2, method: 'tools/call'});
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(first.ended).toBe(false);
    releaseLookup.resolve();
    await settle();
    first.emit({id: 2, result: {}});
    await settle();
    const end = Promise.withResolvers<void>();
    first.endGate = end.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(first.endRequested).toBe(true);
    session.send({id: 3, method: 'tools/call'});
    await settle();
    const resumed = session.children[1];
    resumed.emit({id: 1, result: {}});
    await settle();
    end.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(first.ended).toBe(true);
    expect(resumed.ended).toBe(false);
    resumed.emit({id: 3, result: {}});
    await settle();
    await session.close();
  });

  it('restarts the idle interval on unsolicited notifications and waits for their output', async () => {
    const notificationFlushed = Promise.withResolvers<void>();
    const session = startSession(line =>
      line.method === 'notifications/tools/list_changed' ? notificationFlushed.promise : Promise.resolve(),
    );
    await session.initialize();
    const child = session.children[0];
    await vi.advanceTimersByTimeAsync(90);
    child.emit({method: 'notifications/tools/list_changed'});
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(child.ended).toBe(false);
    notificationFlushed.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(99);
    expect(child.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.ended).toBe(true);
    await session.close();
  });
});

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const EnvelopeSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
    method: Schema.optionalKey(Schema.String),
    params: Schema.optionalKey(Schema.Unknown),
    result: Schema.optionalKey(Schema.Unknown),
  }),
  [JsonRecordSchema],
);

function parseEnvelope(line: string): Envelope {
  const value: unknown = JSON.parse(line);
  if (!Schema.is(EnvelopeSchema)(value)) throw new Error('Invalid MCP broker envelope.');
  return value;
}

interface Envelope {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

function startSession(writeOutput: (line: Envelope) => Promise<void> = async () => undefined) {
  vi.useFakeTimers();
  const input = new ByteQueue();
  const children: ControlledChild[] = [];
  const output: Envelope[] = [];
  const session = {
    children,
    output,
    failure: undefined as unknown,
    version: '4.0.0',
    releaseLookup: Promise.resolve(),
    send: (line: Envelope) => input.push(line),
    initialize: async () => {
      input.push({id: 1, method: 'initialize', params: {}});
      await settle();
      children[0].emit({id: 1, result: {}});
      await settle();
      input.push({method: 'notifications/initialized'});
      await settle();
    },
    close: async () => {
      input.end();
      await running;
    },
  };
  const running = runMcpBroker({
    childIdleTimeoutMilliseconds: 100,
    input,
    readActiveRelease: async () => {
      await session.releaseLookup;
      return {releaseRoot: `/releases/${session.version}`, version: session.version};
    },
    spawn: release => {
      const child = new ControlledChild(release.version);
      children.push(child);
      return child;
    },
    writeOutput: async line => {
      const parsed = parseEnvelope(line);
      await writeOutput(parsed);
      output.push(parsed);
    },
  }).catch(cause => {
    session.failure = cause;
  });
  return session;
}

class ControlledChild implements McpBrokerChild {
  readonly output = new ByteQueue();
  readonly exit = Promise.withResolvers<number>();
  readonly exited = this.exit.promise;
  readonly processId = 1;
  readonly received: Envelope[] = [];
  endGate = Promise.resolve();
  endRequested = false;
  ignoreEnd = false;
  ignoreSignals = false;
  readonly signals: (number | NodeJS.Signals | undefined)[] = [];
  ended = false;
  readonly input = {
    write: (line: string) => {
      if (this.ended) throw new Error('Child input is closed');
      this.received.push(parseEnvelope(line));
      return line.length;
    },
    flush: async () => undefined,
    end: async () => {
      this.endRequested = true;
      await this.endGate;
      if (!this.ignoreEnd) this.finish();
    },
  };

  constructor(readonly version: string) {}

  emit(line: Envelope) {
    this.output.push(line);
  }

  kill(signal?: number | NodeJS.Signals) {
    this.signals.push(signal);
    if (!this.ignoreSignals) this.finish();
  }

  finish() {
    this.ended = true;
    this.output.end();
    this.exit.resolve(0);
  }
}

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly queued: Uint8Array[] = [];
  waiter: ((value: IteratorResult<Uint8Array>) => void) | undefined;
  ended = false;

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.queued.shift();
        if (value) return Promise.resolve({done: false, value});
        if (this.ended) return Promise.resolve({done: true, value: undefined});
        return new Promise(resolve => {
          this.waiter = resolve;
        });
      },
    };
  }

  push(line: Envelope) {
    const value = new TextEncoder().encode(`${JSON.stringify({jsonrpc: '2.0', ...line})}\n`);
    if (this.waiter) {
      this.waiter({done: false, value});
      this.waiter = undefined;
    } else this.queued.push(value);
  }

  end() {
    this.ended = true;
    this.waiter?.({done: true, value: undefined});
    this.waiter = undefined;
  }
}

async function settle() {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}
