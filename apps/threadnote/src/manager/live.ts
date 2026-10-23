import {Clock, Crypto, Effect, FileSystem, PubSub, Queue, Schema, Semaphore, Stream} from 'effect';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Socket from 'effect/socket/Socket';
import {managerRequestIsAuthorized} from '@threadnote/manager/authorization';
import {
  MANAGER_LIVE_LIMITS,
  MANAGER_LIVE_VERSION,
  ManagerLiveClientFrame,
  managerLiveResourceKey,
  type ManagerLiveResource,
  type ManagerLiveServerFrame,
  type ManagerLiveTopic,
} from '@threadnote/manager/live/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseSeedManifest} from '@threadnote/workspace/manifest';

// Only status has complete producer coverage in this additive rollout. Health
// reports and evidence packets also depend on current repository source files.
const topics: readonly ManagerLiveTopic[] = ['context-maintenance'];
const limits = MANAGER_LIVE_LIMITS;
export const managerLiveWebSocketOptions = {
  maxPayloadLength: limits.messageBytes,
  backpressureLimit: limits.bufferedBytes,
  closeOnBackpressureLimit: true,
  idleTimeout: 60,
} as const;
export const managerLiveHttpLayer = (port: number) =>
  BunHttpServer.layer({hostname: '127.0.0.1', port, websocket: managerLiveWebSocketOptions});
const utf8 = new TextEncoder();
const decode = Schema.decodeUnknownEffect(ManagerLiveClientFrame, {onExcessProperty: 'error'});

class ManagerLiveProtocolError extends Schema.TaggedError<ManagerLiveProtocolError>()('ManagerLiveProtocolError', {
  message: Schema.String,
}) {}
const refused = () => ManagerLiveProtocolError.make({message: 'Live session no longer valid.'});

export const readManagerLiveProjects = Effect.fn('manager.live.projects')(function* (
  fs: FileSystem.FileSystem,
  manifestPath: string,
) {
  const info = yield* fs.stat(manifestPath);
  if (info.type !== 'File' || Number(info.size) > 1_048_576) return yield* refused();
  const raw = yield* fs.readFileString(manifestPath);
  if (utf8.encode(raw).length > 1_048_576) return yield* refused();
  const manifest = yield* Effect.try({try: () => parseSeedManifest(raw, manifestPath), catch: refused});
  if (manifest.projects.length > 4_096) return yield* refused();
  return new Set(manifest.projects.map(project => project.name));
});

/** A bounded latest-revision mailbox. All access occurs in synchronous Effect sections. */
export function makeManagerLiveMailbox() {
  let resources = new Map<string, ManagerLiveResource>();
  const pending = new Map<string, {resource: ManagerLiveResource; revision: string}>();
  let reset = false;
  return {
    resources: () => [...resources.values()],
    replace: (next: readonly ManagerLiveResource[]) => {
      resources = new Map(next.map(resource => [managerLiveResourceKey(resource), resource]));
      pending.clear();
      reset = false;
    },
    dirty: (changed: readonly ManagerLiveTopic[], revision: string) => {
      for (const [key, resource] of resources) {
        if (!changed.includes(resource.topic) || reset) continue;
        pending.set(key, {resource, revision});
        if (pending.size > limits.pendingResources) {
          pending.clear();
          reset = true;
        }
      }
      return reset || pending.size > 0;
    },
    drain: () => {
      const result = {reset, invalidations: [...pending.values()]};
      reset = false;
      pending.clear();
      return result;
    },
    size: () => pending.size,
  };
}

interface LiveConnection {
  readonly incoming: Queue.Queue<string>;
  readonly mailbox: ReturnType<typeof makeManagerLiveMailbox>;
  readonly wake: PubSub.PubSub<void>;
  readonly close: Effect.Effect<void>;
  generation: number;
  sequence: number;
}

export interface ManagerLiveOptions {
  readonly origin: string;
  readonly token: string;
  /** A bounded account-local manifest read; no corpus or graph discovery. */
  readonly projects: Effect.Effect<ReadonlySet<string>, unknown>;
}

export const makeManagerLive = Effect.fn('manager.live.make')(function* (options: ManagerLiveOptions) {
  const crypto = yield* Crypto.Crypto;
  const epoch = yield* crypto.randomUUIDv4();
  const origin = new URL(options.origin);
  const tickets = new Map<string, number>();
  const connections = new Set<LiveConnection>();
  let reservedConnections = 0;
  const pruneTickets = (now: number) => {
    for (const [ticket, expires] of tickets) if (expires <= now) tickets.delete(ticket);
  };
  const projects = options.projects.pipe(Effect.timeoutOption(1_000));
  const json = (status: number, body: unknown) =>
    HttpServerResponse.jsonUnsafe(body, {status, headers: {'cache-control': 'no-store'}});
  const validOrigin = (request: HttpServerRequest.HttpServerRequest, required: boolean) =>
    request.headers.host === origin.host &&
    (request.headers.origin === origin.origin || (!required && request.headers.origin === undefined));
  const readProjects = projects.pipe(
    Effect.flatMap(result => Effect.fromOption(result, refused)),
    Effect.mapError(refused),
  );

  const serveSocket = (socket: Socket.Socket) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        const gate = yield* Semaphore.make(1);
        const wake = yield* PubSub.sliding<void>({capacity: 1, replay: 1});
        const incoming = yield* Queue.dropping<string>(limits.incomingFrames);
        const close = writer.write(new Socket.CloseEvent(1008, 'Live session closed')).pipe(Effect.ignoreCause);
        const connection: LiveConnection = {
          incoming,
          mailbox: makeManagerLiveMailbox(),
          wake,
          close,
          generation: 0,
          sequence: 0,
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => connections.add(connection)),
          () =>
            Effect.sync(() => connections.delete(connection)).pipe(
              Effect.andThen(PubSub.shutdown(wake)),
              Effect.andThen(Queue.shutdown(incoming)),
              Effect.andThen(close),
            ),
        );
        const send = (frame: ManagerLiveServerFrame) => writer.write(JSON.stringify(frame));
        yield* send({
          type: 'welcome',
          version: MANAGER_LIVE_VERSION,
          epoch,
          topics,
          heartbeatMilliseconds: limits.heartbeatMilliseconds,
        });
        let lastMessage = yield* Clock.currentTimeMillis;
        let rateWindow = lastMessage;
        let rateCount = 0;
        // Keep pulling independently of slow authorization. The Bun adapter's
        // own receive array has no capacity; never leave it waiting on I/O.
        const admitFrame = Effect.fn('manager.live.admit')(function* (raw: string | Uint8Array) {
          if (typeof raw !== 'string' || utf8.encode(raw).length > limits.messageBytes) return yield* refused();
          const now = yield* Clock.currentTimeMillis;
          if (now - rateWindow >= 1_000) {
            rateWindow = now;
            rateCount = 0;
          }
          if (++rateCount > 64) return yield* refused();
          if (!(yield* Queue.offer(incoming, raw))) return yield* refused();
        });
        const processFrame = Effect.fn('manager.live.frame')(function* (raw: string) {
          const value = yield* Effect.try({try: () => JSON.parse(raw) as unknown, catch: refused});
          const frame = yield* decode(value).pipe(Effect.mapError(refused));
          lastMessage = yield* Clock.currentTimeMillis;
          if (frame.type === 'heartbeat') return;
          if (frame.generation <= connection.generation) return yield* refused();
          const allowed = yield* readProjects;
          if (frame.resources.some(resource => !topics.includes(resource.topic) || !allowed.has(resource.project)))
            return yield* refused();
          yield* gate.withPermits(1)(
            Effect.gen(function* () {
              connection.mailbox.replace(frame.resources);
              connection.generation = frame.generation;
              // Filters are live before this barrier; flush uses the same gate.
              yield* send({
                type: 'subscribed',
                version: MANAGER_LIVE_VERSION,
                epoch,
                generation: frame.generation,
                startingSequence: connection.sequence,
              });
            }),
          );
        });
        const receive = Effect.forever(
          reader.pull.pipe(
            Effect.flatMap(batch =>
              batch.length > limits.incomingFrames
                ? Effect.fail(refused())
                : Effect.forEach(batch, admitFrame, {discard: true}),
            ),
          ),
        );
        const processIncoming = Effect.forever(Queue.take(incoming).pipe(Effect.flatMap(processFrame)));
        const flush = gate.withPermits(1)(
          Effect.gen(function* () {
            if (connection.generation === 0) return;
            const batch = connection.mailbox.drain();
            const common = {version: MANAGER_LIVE_VERSION, epoch, generation: connection.generation} as const;
            if (batch.reset) {
              yield* send({...common, type: 'reset', sequence: ++connection.sequence});
            } else {
              for (const invalidation of batch.invalidations)
                yield* send({...common, type: 'invalidation', sequence: ++connection.sequence, ...invalidation});
            }
          }),
        );
        const output = Stream.fromPubSub(wake).pipe(
          Stream.runForEach(() => Effect.sleep(20).pipe(Effect.andThen(flush))),
        );
        const heartbeat = Effect.forever(
          Effect.sleep(limits.heartbeatMilliseconds).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                if (now - lastMessage >= limits.clientTimeoutMilliseconds) return yield* refused();
                const allowed = yield* readProjects;
                if (connection.mailbox.resources().some(resource => !allowed.has(resource.project)))
                  return yield* refused();
                yield* gate.withPermits(1)(send({type: 'heartbeat', version: MANAGER_LIVE_VERSION, epoch}));
              }),
            ),
          ),
        );
        yield* receive.pipe(
          Effect.raceFirst(processIncoming),
          Effect.raceFirst(output),
          Effect.raceFirst(heartbeat),
          Effect.catchCause(() => close),
        );
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...connections], connection => connection.close, {discard: true}).pipe(
      Effect.andThen(Effect.sync(() => tickets.clear())),
    ),
  );

  const handle = Effect.fn('manager.live.handle')(function* (request: HttpServerRequest.HttpServerRequest) {
    const url = new URL(request.url, origin);
    if (url.pathname !== '/api/live-session' && url.pathname !== '/api/live') return undefined;
    if (url.origin !== origin.origin || !validOrigin(request, url.pathname === '/api/live'))
      return json(403, {error: 'Forbidden'});
    const now = yield* Clock.currentTimeMillis;
    pruneTickets(now);
    if (url.pathname === '/api/live-session') {
      if (request.method !== 'POST') return json(405, {error: 'Method not allowed'});
      if (!managerRequestIsAuthorized(request, options.token)) return json(401, {error: 'Unauthorized'});
      if (tickets.size >= limits.tickets) return json(429, {error: 'Too many pending live sessions'});
      const ticket = yield* crypto.randomUUIDv4();
      const expiresAt = now + limits.ticketLifetimeMilliseconds;
      tickets.set(ticket, expiresAt);
      return json(200, {version: MANAGER_LIVE_VERSION, ticket, expiresAt});
    }
    if (request.method !== 'GET') return json(405, {error: 'Method not allowed'});
    const ticket = url.searchParams.get('ticket');
    if (ticket === null || !tickets.has(ticket) || [...url.searchParams.keys()].some(key => key !== 'ticket'))
      return json(401, {error: 'Unauthorized'});
    tickets.delete(ticket);
    if (reservedConnections >= limits.connections) return json(429, {error: 'Too many live sessions'});
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => reservedConnections++),
      () =>
        request.upgrade.pipe(
          Effect.flatMap(serveSocket),
          Effect.as(HttpServerResponse.empty({status: 204})),
          Effect.catchCause(() => Effect.succeed(json(400, {error: 'Live upgrade refused'}))),
        ),
      () => Effect.sync(() => reservedConnections--),
    );
  });

  const publish = (changed: readonly ManagerLiveTopic[], revision: string) =>
    Effect.gen(function* () {
      const opaqueRevision = sha256HexSync(revision);
      for (const connection of connections)
        if (connection.mailbox.dirty(changed, opaqueRevision)) yield* PubSub.publish(connection.wake, undefined);
    }).pipe(Effect.ignoreCause);

  return {
    handle,
    publish,
    invalidateScope: Effect.sync(() => tickets.clear()).pipe(
      Effect.andThen(
        Effect.suspend(() => Effect.forEach([...connections], connection => connection.close, {discard: true})),
      ),
      Effect.ignoreCause,
    ),
    diagnostics: Effect.sync(() => ({
      connections: reservedConnections,
      tickets: tickets.size,
      pendingResources: [...connections].reduce((sum, connection) => sum + connection.mailbox.size(), 0),
      incomingFrames: [...connections].reduce((sum, connection) => sum + Queue.sizeUnsafe(connection.incoming), 0),
    })),
  };
});

export type ManagerLive = Effect.Success<ReturnType<typeof makeManagerLive>>;
