import {
  Array as Arr,
  Clock,
  Crypto,
  Effect,
  FileSystem,
  Option,
  PubSub,
  Queue,
  Schema,
  Semaphore,
  Stream,
  String as Str,
} from 'effect';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Socket from 'effect/socket/Socket';
import {managerRequestIsAuthorized} from '@threadnote/manager/authorization';
import {
  MANAGER_LIVE_LIMITS,
  MANAGER_LIVE_VERSION,
  MANAGER_LIVE_SNAPSHOT_HEADER,
  ManagerLiveSnapshotResource,
  ManagerLiveTopic,
  ManagerLiveClientFrame,
  managerLiveResourceKey,
  type ManagerLiveResource,
  type ManagerLiveServerFrame,
  type ManagerLiveSnapshotTopic,
} from '@threadnote/manager/live/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseSeedManifest} from '@threadnote/workspace/manifest';

// Maintenance status is always available. Health is advertised only when its
// source broker is installed by the Manager composition root.
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
const isSnapshotResource = Schema.is(ManagerLiveSnapshotResource);
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
    dirtyResource: (resource: ManagerLiveResource, revision: string) => {
      const key = managerLiveResourceKey(resource);
      const subscribed = resources.get(key);
      if (subscribed === undefined || reset) return reset;
      pending.set(key, {resource: subscribed, revision});
      if (pending.size > limits.pendingResources) {
        pending.clear();
        reset = true;
      }
      return true;
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
  readonly key: string;
  readonly incoming: Queue.Queue<string>;
  readonly mailbox: ReturnType<typeof makeManagerLiveMailbox>;
  readonly availability: Map<string, {resource: ManagerLiveResource; available: boolean}>;
  readonly wake: PubSub.PubSub<void>;
  readonly snapshots: readonly ManagerLiveSnapshotTopic[];
  readonly unobserved: Map<string, ManagerLiveResource>;
  readonly nextSnapshotSample: Map<string, number>;
  readonly close: Effect.Effect<void>;
  generation: number;
  sequence: number;
}

export interface ManagerLiveOptions {
  readonly origin: string;
  readonly token: string;
  /** A bounded account-local manifest read; no corpus or graph discovery. */
  readonly projects: Effect.Effect<ReadonlySet<string>, unknown>;
  readonly snapshots?: Partial<
    Readonly<
      Record<
        ManagerLiveSnapshotTopic,
        Effect.Effect<
          {
            readonly data: unknown;
            readonly reconcileMilliseconds: number;
          },
          unknown
        >
      >
    >
  >;
  readonly health?: {
    readonly subscribe: (connectionKey: string, projects: readonly string[]) => Effect.Effect<readonly string[], never>;
    readonly release: (connectionKey: string) => Effect.Effect<void, never>;
  };
  readonly observations?: {
    readonly topics: readonly ManagerLiveTopic[];
    readonly subscribe: (
      connectionKey: string,
      resources: readonly ManagerLiveResource[],
    ) => Effect.Effect<readonly ManagerLiveResource[], never>;
    readonly release: (connectionKey: string) => Effect.Effect<void, never>;
  };
}

export const makeManagerLive = Effect.fn('manager.live.make')(function* (options: ManagerLiveOptions) {
  const crypto = yield* Crypto.Crypto;
  const epoch = yield* crypto.randomUUIDv4();
  const topics: readonly ManagerLiveTopic[] = [
    ...new Set<ManagerLiveTopic>([
      'context-maintenance',
      ...(options.health ? ['context-health' as const] : []),
      ...(options.observations?.topics ?? []),
    ]),
  ];
  const origin = new URL(options.origin);
  const tickets = new Map<
    string,
    {expiresAt: number; topics: readonly ManagerLiveTopic[]; snapshots: readonly ManagerLiveSnapshotTopic[]}
  >();
  const connections = new Set<LiveConnection>();
  let reservedConnections = 0;
  const pruneTickets = (now: number) => {
    for (const [ticket, value] of tickets) if (value.expiresAt <= now) tickets.delete(ticket);
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
  const readTicketTopics = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      if (
        (request.headers['content-length'] === undefined || request.headers['content-length'] === '0') &&
        request.headers['transfer-encoding'] === undefined
      )
        return ['context-maintenance', 'context-health'] as readonly ManagerLiveTopic[];
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* request.stream.pipe(
        Stream.runForEach(chunk => {
          size += chunk.byteLength;
          if (size > 1_024) return Effect.fail(refused());
          chunks.push(chunk);
          return Effect.void;
        }),
      );
      if (size === 0) return ['context-maintenance', 'context-health'] as readonly ManagerLiveTopic[];
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value = yield* Effect.try({
        try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        catch: refused,
      });
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).some(key => key !== 'topics')
      )
        return yield* refused();
      const requested = (value as {topics?: unknown}).topics;
      if (requested === undefined) return ['context-maintenance', 'context-health'] as readonly ManagerLiveTopic[];
      if (
        !Array.isArray(requested) ||
        requested.length > ManagerLiveTopic.literals.length ||
        requested.some(
          topic => typeof topic !== 'string' || !ManagerLiveTopic.literals.includes(topic as ManagerLiveTopic),
        ) ||
        new Set(requested).size !== requested.length
      )
        return yield* refused();
      return requested as readonly ManagerLiveTopic[];
    });

  const serveSocket = (
    socket: Socket.Socket,
    negotiatedTopics: readonly ManagerLiveTopic[],
    snapshots: readonly ManagerLiveSnapshotTopic[],
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        const gate = yield* Semaphore.make(1);
        const wake = yield* PubSub.sliding<void>({capacity: 1, replay: 1});
        const incoming = yield* Queue.dropping<string>(limits.incomingFrames);
        const connectionKey = yield* crypto.randomUUIDv4();
        const close = writer.write(new Socket.CloseEvent(1008, 'Live session closed')).pipe(Effect.ignoreCause);
        const connection: LiveConnection = {
          key: connectionKey,
          incoming,
          mailbox: makeManagerLiveMailbox(),
          availability: new Map(),
          wake,
          snapshots,
          unobserved: new Map(),
          nextSnapshotSample: new Map(),
          close,
          generation: 0,
          sequence: 0,
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => connections.add(connection)),
          () =>
            Effect.sync(() => connections.delete(connection)).pipe(
              Effect.andThen(options.health?.release(connectionKey) ?? Effect.void),
              Effect.andThen(options.observations?.release(connectionKey) ?? Effect.void),
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
          topics: negotiatedTopics,
          ...(snapshots.length > 0 ? {snapshots} : {}),
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
          if (
            frame.resources.some(
              resource =>
                !negotiatedTopics.includes(resource.topic) || ('project' in resource && !allowed.has(resource.project)),
            )
          )
            return yield* refused();
          yield* gate.withPermits(1)(
            Effect.gen(function* () {
              // Install the filter before broker registration. Broker callbacks
              // may publish synchronously; the gate holds their flush until ACK.
              connection.mailbox.replace(frame.resources);
              connection.availability.clear();
              const healthProjects = [
                ...new Set(
                  frame.resources
                    .filter(
                      (resource): resource is Extract<ManagerLiveResource, {project: string}> =>
                        'project' in resource && resource.topic === 'context-health',
                    )
                    .map(resource => resource.project),
                ),
              ];
              const healthUnavailable =
                options.health === undefined ? [] : yield* options.health.subscribe(connectionKey, healthProjects);
              const observationResources = frame.resources.filter(
                resource => resource.topic !== 'context-health' && resource.topic !== 'context-maintenance',
              );
              const observationUnavailable =
                options.observations === undefined
                  ? []
                  : yield* options.observations.subscribe(connectionKey, observationResources);
              const sourceUnavailable: ManagerLiveResource[] = [
                ...healthUnavailable.map(project => ({topic: 'context-health' as const, project})),
                ...observationUnavailable,
              ];
              connection.unobserved.clear();
              connection.nextSnapshotSample.clear();
              const unavailable = Arr.filter(sourceUnavailable, resource => {
                if (!isSnapshotResource(resource) || !snapshots.includes(resource.topic)) return true;
                connection.unobserved.set(managerLiveResourceKey(resource), resource);
                return false;
              });
              connection.generation = frame.generation;
              // Filters are live before this barrier; flush uses the same gate.
              yield* send({
                type: 'subscribed',
                version: MANAGER_LIVE_VERSION,
                epoch,
                generation: frame.generation,
                startingSequence: connection.sequence,
                ...(unavailable.length > 0 ? {unavailable} : {}),
              });
              for (const resource of frame.resources) {
                if (
                  isSnapshotResource(resource) &&
                  snapshots.includes(resource.topic) &&
                  !Arr.some(
                    unavailable,
                    missing => managerLiveResourceKey(missing) === managerLiveResourceKey(resource),
                  )
                )
                  connection.mailbox.dirtyResource(resource, sha256HexSync('subscription'));
              }
              yield* PubSub.publish(wake, undefined);
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
        const reconcileSnapshots = Effect.forever(
          Effect.sleep('1 second').pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                for (const [key, resource] of connection.unobserved) {
                  if (now < (connection.nextSnapshotSample.get(key) ?? 0)) continue;
                  connection.nextSnapshotSample.set(key, now + 15_000);
                  connection.mailbox.dirtyResource(resource, sha256HexSync('reconciliation'));
                }
                if (connection.unobserved.size > 0) yield* PubSub.publish(wake, undefined);
              }),
            ),
          ),
        );
        const flush = gate.withPermits(1)(
          Effect.gen(function* () {
            if (connection.generation === 0) return;
            const batch = connection.mailbox.drain();
            const common = {version: MANAGER_LIVE_VERSION, epoch, generation: connection.generation} as const;
            if (batch.reset) {
              yield* send({...common, type: 'reset', sequence: ++connection.sequence});
            } else {
              for (const invalidation of batch.invalidations) {
                const resource = isSnapshotResource(invalidation.resource) ? invalidation.resource : undefined;
                const readSnapshot =
                  resource && connection.snapshots.includes(resource.topic)
                    ? options.snapshots?.[resource.topic]
                    : undefined;
                if (readSnapshot && resource) {
                  const result = yield* readSnapshot.pipe(
                    Effect.timeoutOption('8 seconds'),
                    Effect.catchCause(() => Effect.succeedNone),
                  );
                  if (Option.isSome(result)) {
                    connection.nextSnapshotSample.set(
                      managerLiveResourceKey(resource),
                      (yield* Clock.currentTimeMillis) +
                        Math.max(1_000, Math.min(15_000, result.value.reconcileMilliseconds)),
                    );
                    const frame = {
                      ...common,
                      type: 'snapshot' as const,
                      sequence: connection.sequence + 1,
                      resource,
                      data: result.value.data,
                    };
                    if (utf8.encode(JSON.stringify(frame)).length <= limits.snapshotBytes) {
                      yield* send(frame);
                      connection.sequence++;
                      continue;
                    }
                  }
                  connection.nextSnapshotSample.set(
                    managerLiveResourceKey(resource),
                    (yield* Clock.currentTimeMillis) + 15_000,
                  );
                }
                // A failed or oversized projection retains one event-triggered REST read.
                yield* send({...common, type: 'invalidation', sequence: ++connection.sequence, ...invalidation});
              }
            }
            const availability = [...connection.availability.values()];
            connection.availability.clear();
            for (const item of availability)
              yield* send({...common, type: 'availability', sequence: ++connection.sequence, ...item});
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
                if (
                  connection.mailbox
                    .resources()
                    .some(resource => 'project' in resource && !allowed.has(resource.project))
                )
                  return yield* refused();
                yield* gate.withPermits(1)(send({type: 'heartbeat', version: MANAGER_LIVE_VERSION, epoch}));
              }),
            ),
          ),
        );
        yield* receive.pipe(
          Effect.raceFirst(processIncoming),
          Effect.raceFirst(reconcileSnapshots),
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
      const requested = yield* readTicketTopics(request).pipe(Effect.orElseSucceed(() => undefined));
      if (requested === undefined) return json(400, {error: 'Invalid live session request'});
      const ticket = yield* crypto.randomUUIDv4();
      const expiresAt = now + limits.ticketLifetimeMilliseconds;
      const requestedSnapshots = Str.split(request.headers[MANAGER_LIVE_SNAPSHOT_HEADER] ?? '', ',');
      const snapshots = Arr.filter(
        ['processes', 'graph-status'] as const,
        topic =>
          topics.includes(topic) &&
          requested.includes(topic) &&
          requestedSnapshots.includes(topic) &&
          options.snapshots?.[topic] !== undefined,
      );
      tickets.set(ticket, {expiresAt, topics: Arr.filter(topics, topic => requested.includes(topic)), snapshots});
      return json(200, {version: MANAGER_LIVE_VERSION, ticket, expiresAt});
    }
    if (request.method !== 'GET') return json(405, {error: 'Method not allowed'});
    const ticket = url.searchParams.get('ticket');
    if (ticket === null || !tickets.has(ticket) || [...url.searchParams.keys()].some(key => key !== 'ticket'))
      return json(401, {error: 'Unauthorized'});
    const negotiatedTopics = tickets.get(ticket)?.topics ?? [];
    const snapshots = tickets.get(ticket)?.snapshots ?? [];
    tickets.delete(ticket);
    if (reservedConnections >= limits.connections) return json(429, {error: 'Too many live sessions'});
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => reservedConnections++),
      () =>
        request.upgrade.pipe(
          Effect.flatMap(socket => serveSocket(socket, negotiatedTopics, snapshots)),
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

  const publishResource = (resource: ManagerLiveResource, revision: string) =>
    Effect.gen(function* () {
      const opaqueRevision = sha256HexSync(revision);
      for (const connection of connections)
        if (connection.mailbox.dirtyResource(resource, opaqueRevision))
          yield* PubSub.publish(connection.wake, undefined);
    }).pipe(Effect.ignoreCause);

  const publishResourceAvailability = (resource: ManagerLiveResource, available: boolean) =>
    Effect.gen(function* () {
      const key = managerLiveResourceKey(resource);
      for (const connection of connections) {
        if (!connection.mailbox.resources().some(subscribed => managerLiveResourceKey(subscribed) === key)) continue;
        if (isSnapshotResource(resource) && connection.snapshots.includes(resource.topic)) {
          if (available) {
            connection.unobserved.delete(key);
            connection.nextSnapshotSample.delete(key);
          } else connection.unobserved.set(key, resource);
          connection.mailbox.dirtyResource(resource, sha256HexSync('coverage'));
          yield* PubSub.publish(connection.wake, undefined);
          continue;
        }
        connection.availability.set(key, {resource, available});
        // A connection can subscribe to at most 32 resources, so this map is
        // bounded independently of invalidation coalescing and reset state.
        yield* PubSub.publish(connection.wake, undefined);
      }
    }).pipe(Effect.ignoreCause);
  const publishAvailability = (project: string, available: boolean) =>
    publishResourceAvailability({topic: 'context-health', project}, available);

  return {
    handle,
    publish,
    publishResource,
    publishAvailability,
    publishResourceAvailability,
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
