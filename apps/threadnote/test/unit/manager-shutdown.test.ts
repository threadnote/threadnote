import {createInterface} from 'node:readline';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Node readline requires a Node stream at this child stdout callback boundary.
import {Readable} from 'node:stream';
import {Array as Arr, Option, Schema, String as Str} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

const fixturePath = 'apps/threadnote/test/fixtures/manager-shutdown-server.ts';
const decodeFrame = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ticket: Schema.String}));
const decodeReleased = Schema.decodeUnknownSync(
  Schema.Struct({
    diagnostics: Schema.Struct({
      connections: Schema.Finite,
      tickets: Schema.Finite,
      pendingResources: Schema.Finite,
      incomingFrames: Schema.Finite,
    }),
    healthSubscribed: Schema.Array(Schema.String),
    healthReleased: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
    observationSubscribed: Schema.Array(Schema.String),
    observationReleased: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
  }),
);

async function deadline<A>(result: Promise<A>, milliseconds = 5_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture exceeded ${milliseconds}ms.`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function socketFrame(socket: WebSocket, type: string) {
  let listener: (event: MessageEvent) => void;
  const result = new Promise<Record<string, unknown>>(resolve => {
    listener = event => {
      const frame = decodeFrame(JSON.parse(String(event.data)));
      if (frame.type === type) resolve(frame);
    };
    socket.addEventListener('message', listener);
  });
  return deadline(result).finally(() => socket.removeEventListener('message', listener));
}

async function withServer(test: (server: ReturnType<typeof startServer>) => Promise<void>) {
  const server = startServer();
  try {
    await server.ready;
    await test(server);
  } finally {
    await server.cleanup();
  }
}

function startServer() {
  const child = Bun.spawn([process.execPath, fixturePath], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
  const stderr = new Response(child.stderr).text();
  const input = createInterface({input: Readable.from(child.stdout)});
  const queued: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  const sockets: WebSocket[] = [];
  const requests = new AbortController();
  let ended = false;
  input.on('line', line => {
    queued.push(decodeFrame(JSON.parse(line)));
    for (const listener of listeners) listener();
  });
  input.on('close', () => {
    ended = true;
    for (const listener of listeners) listener();
  });
  const frame = (type: string) => {
    let listener: () => void;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      listener = () => {
        const index = Arr.findFirstIndex(queued, item => item.type === type);
        if (Option.isSome(index)) resolve(queued.splice(index.value, 1)[0]);
        else if (ended) reject(new Error(`Fixture ended before ${type}.`));
      };
      listeners.add(listener);
      listener();
    });
    return deadline(result).finally(() => listeners.delete(listener));
  };
  let origin = '';
  const ready = frame('ready').then(value => {
    if (typeof value.port !== 'number') throw new Error('Fixture port is missing.');
    origin = `http://127.0.0.1:${value.port}`;
  });
  const request = async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`${origin}${path}`, {
      ...options,
      signal: AbortSignal.any([requests.signal, AbortSignal.timeout(5_000)]),
    });
    // Keep both response acquisition and its body within the request's abort lifetime.
    return {status: response.status, text: await response.text()};
  };
  const ticket = async () => {
    const response = await request('/api/live-session', {
      method: 'POST',
      headers: {authorization: 'Bearer synthetic-shutdown-fixture', origin, 'content-type': 'application/json'},
      body: JSON.stringify({topics: ['context-health', 'graph-status']}),
    });
    expect(response.status).toBe(200);
    return decodeTicket(JSON.parse(response.text)).ticket;
  };
  const connect = async () => {
    const options: Bun.WebSocketOptions = {headers: {origin}};
    // DOM typings omit Bun's documented headers overload; verify the constructed client.
    const socket = Schema.decodeUnknownSync(Schema.instanceOf(WebSocket))(
      Reflect.construct(WebSocket, [
        `${Str.replace('http:', 'ws:')(origin)}/api/live?ticket=${await ticket()}`,
        options,
      ]),
    );
    sockets.push(socket);
    const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), {once: true}));
    await socketFrame(socket, 'welcome');
    const subscribed = socketFrame(socket, 'subscribed');
    socket.send(
      JSON.stringify({
        type: 'subscribe',
        version: 1,
        generation: 1,
        resources: [
          {topic: 'context-health', project: 'fixture'},
          {topic: 'graph-status', scope: 'account'},
        ],
      }),
    );
    await subscribed;
    return {socket, closed};
  };
  return {
    child,
    ready,
    frame,
    connect,
    ticket,
    request,
    abortRequests: () => requests.abort(),
    get origin() {
      return origin;
    },
    send: async (command: 'stop' | 'release') => {
      await child.stdin.write(`${command}\n`);
    },
    cleanup: async () => {
      requests.abort();
      for (const socket of sockets) socket.close();
      if (child.exitCode === null) {
        try {
          // Also release an accepted fixture response if its assertion path failed.
          await child.stdin.write('release\nstop\n');
        } catch {
          // A concurrently exiting child may close stdin; still reap that exact child.
        }
      }
      let forced = false;
      try {
        try {
          await deadline(child.exited, 2_000);
        } catch {
          forced = true;
          if (child.exitCode === null) child.kill('SIGKILL');
          await deadline(child.exited, 2_000);
        }
      } finally {
        input.close();
      }
      expect(await deadline(stderr, 2_000)).toBe('');
      expect(forced).toBe(false);
    },
  };
}

describe('Manager live shutdown composition', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps an open live client from delaying one SIGINT',
    async () => {
      await withServer(async server => {
        const client = await server.connect();
        server.child.kill('SIGINT');
        expect(await deadline(server.child.exited)).toBe(130);
        // The parent owns this socket and has not closed it to make shutdown pass.
        await deadline(client.closed);
      });
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'retains the closed-client SIGINT control',
    async () => {
      await withServer(async server => {
        const client = await server.connect();
        client.socket.close();
        await deadline(client.closed);
        server.child.kill('SIGINT');
        expect(await deadline(server.child.exited)).toBe(130);
      });
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'drains an already accepted finite HTTP response during live shutdown',
    async () => {
      await withServer(async server => {
        const client = await server.connect();
        const response = server.request('/slow').then(
          value => ({value}),
          error => ({error}),
        );
        try {
          await server.frame('accepted');
          server.child.kill('SIGINT');
          await deadline(client.closed);
          expect(server.child.exitCode).toBeNull();
          await server.send('release');
          const result = await deadline(response);
          if ('error' in result) throw result.error;
          expect(result.value).toEqual({status: 207, text: 'finite response'});
          expect(await deadline(server.child.exited)).toBe(130);
        } finally {
          server.abortRequests();
          await deadline(response);
        }
      });
    },
    15_000,
  );

  it('releases every admitted consumer once and clears unused tickets after actual scope closure', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), {maxLength: 3}), async closedBeforeStop => {
        await withServer(async server => {
          for (const closeBefore of closedBeforeStop) {
            const client = await server.connect();
            if (closeBefore) {
              client.socket.close();
              await deadline(client.closed);
            }
          }
          await server.ticket();
          const before = decodeFrame(JSON.parse((await server.request('/diagnostics')).text));
          expect(before.tickets).toBe(1);
          await server.send('stop');
          const report = decodeReleased(await server.frame('released'));
          expect(await deadline(server.child.exited)).toBe(0);
          expect(report.diagnostics).toEqual({connections: 0, tickets: 0, pendingResources: 0, incomingFrames: 0});
          expect(report.healthSubscribed).toHaveLength(closedBeforeStop.length);
          expect(report.observationSubscribed).toHaveLength(closedBeforeStop.length);
          for (const [subscribed, released] of [
            [report.healthSubscribed, report.healthReleased],
            [report.observationSubscribed, report.observationReleased],
          ] as const) {
            expect([...released].sort(([a], [b]) => Str.localeCompare(b)(a))).toEqual(
              Arr.map([...subscribed].sort(), key => [key, 1]),
            );
          }
        });
      }),
      {numRuns: 12, examples: [[[]], [[false, false, false]], [[true, false, true]]]},
    );
  }, 30_000);

  it('aborts a stalled owned response and reaps its server without forced cleanup', async () => {
    const server = startServer();
    try {
      await server.ready;
      const response = server.request('/slow').then(
        value => ({value}),
        error => ({error}),
      );
      await server.frame('accepted');
      const result = await deadline(response, 6_000);
      expect(result).toHaveProperty('error');
      if ('error' in result) expect(result.error).toMatchObject({name: 'TimeoutError'});
    } finally {
      await server.cleanup();
    }
    expect(server.child.exitCode).toBe(0);
  }, 15_000);
});
