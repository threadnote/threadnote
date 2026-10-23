import {Schema} from 'effect';
import {
  MANAGER_LIVE_LIMITS,
  MANAGER_LIVE_VERSION,
  ManagerLiveServerFrame,
  managerLiveResourceKey,
  type ManagerLiveResource,
} from './contracts.js';
import {ManagerLiveStore, type ManagerLiveEntry, type ManagerLiveSnapshot} from './store.js';

type Socket = Pick<WebSocket, 'send' | 'close' | 'readyState' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'>;
export type ManagerLiveConnection = 'connecting' | 'connected' | 'stale' | 'unsupported' | 'stopped';
export interface ManagerLiveClientOptions {
  readonly origin: string;
  readonly scopeKey: string;
  readonly requestTicket: (signal: AbortSignal) => Promise<unknown>;
  readonly createSocket?: (url: string) => Socket;
  readonly random?: () => number;
}

const decode = Schema.decodeUnknownSync(ManagerLiveServerFrame, {onExcessProperty: 'error'});
const decodeTicket = Schema.decodeUnknownSync(
  Schema.Struct({ticket: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))}),
);
const textBytes = new TextEncoder();
const emptySnapshot: ManagerLiveSnapshot = {status: 'loading'};
const unavailableStatus = new Set([404, 405, 501]);
const handshakeTimeoutMilliseconds = 10_000;
function isUnavailable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    unavailableStatus.has((error as {status: number}).status)
  );
}

export function createManagerLiveClient(options: ManagerLiveClientOptions) {
  const store = new ManagerLiveStore();
  const connectionListeners = new Set<() => void>();
  const createSocket = options.createSocket ?? (url => new WebSocket(url));
  let connection: ManagerLiveConnection = 'stopped';
  let scopeKey = options.scopeKey;
  let running = false;
  let socket: Socket | undefined;
  let ticketController: AbortController | undefined;
  let token = 0;
  let generation = 0;
  let pendingGeneration = 0;
  let acknowledged = false;
  let epoch: string | undefined;
  let sequence = 0;
  let topics = new Set<string>();
  let heartbeatMilliseconds: number = MANAGER_LIVE_LIMITS.heartbeatMilliseconds;
  let lastFrame = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const setConnection = (next: ManagerLiveConnection) => {
    if (connection === next) return;
    connection = next;
    for (const listener of [...connectionListeners]) listener();
  };
  const update = (entry: ManagerLiveEntry, status: ManagerLiveSnapshot['status'], error?: unknown) => {
    const data = 'data' in entry.snapshot ? entry.snapshot.data : undefined;
    if (status === 'error') store.update(entry, {status, data, error});
    else if ((status === 'ready' || status === 'stale') && data !== undefined) store.update(entry, {status, data});
    else store.update(entry, {status: status === 'unsupported' ? 'unsupported' : 'loading', data});
  };
  const fence = (entry: ManagerLiveEntry) => {
    entry.version++;
    entry.controller?.abort();
    entry.controller = undefined;
    entry.reading = false;
    entry.dirty = false;
  };
  const staleAll = () => {
    for (const entry of store.values()) {
      fence(entry);
      update(
        entry,
        entry.snapshot.status === 'unsupported' || (epoch && !supported(entry))
          ? 'unsupported'
          : 'data' in entry.snapshot
            ? 'stale'
            : 'loading',
      );
    }
  };
  const clearTimers = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    heartbeatTimer = undefined;
    handshakeTimer = undefined;
    reconnectTimer = undefined;
  };
  const armHandshake = () => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      handshakeTimer = undefined;
      disconnect();
    }, handshakeTimeoutMilliseconds);
  };
  const releaseSocket = () => {
    const old = socket;
    socket = undefined;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      old.close();
    }
  };
  const scheduleReconnect = () => {
    if (!running || reconnectTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6));
    // This browser callback has no Effect runtime; jitter never forms a security identifier.
    // oxlint-disable-next-line effecttsgo/global-random
    const jitter = options.random?.() ?? Math.random();
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = undefined;
        void connect();
      },
      Math.floor(delay * (0.75 + 0.5 * jitter)),
    );
  };
  const disconnect = () => {
    token++;
    ticketController?.abort();
    ticketController = undefined;
    clearTimers();
    releaseSocket();
    acknowledged = false;
    epoch = undefined;
    staleAll();
    if (running && connection !== 'unsupported') {
      setConnection('stale');
      scheduleReconnect();
    }
  };
  const send = (frame: unknown) => socket?.send(JSON.stringify(frame));
  const supported = (entry: ManagerLiveEntry) => topics.has(entry.resource.topic);
  const read = (entry: ManagerLiveEntry) => {
    if (!running || !acknowledged || !supported(entry) || !entry.available || entry.reading) return;
    entry.reading = true;
    entry.dirty = false;
    const controller = new AbortController();
    entry.controller = controller;
    const version = ++entry.version;
    const readScope = scopeKey;
    void Promise.resolve()
      .then(() => entry.read(controller.signal))
      .then(
        value => {
          if (entry.version !== version || controller.signal.aborted || scopeKey !== readScope || !running) return;
          if (!entry.dirty) store.update(entry, {status: 'ready', data: value});
        },
        error => {
          if (entry.version !== version || controller.signal.aborted || scopeKey !== readScope || !running) return;
          if (!entry.dirty) update(entry, 'error', error);
        },
      )
      .finally(() => {
        if (entry.version !== version) return;
        entry.reading = false;
        entry.controller = undefined;
        if (entry.dirty) read(entry);
      });
  };
  const dirty = (entry: ManagerLiveEntry) => {
    if (!supported(entry) || !entry.available) return;
    if (entry.reading) {
      entry.dirty = true;
      if (entry.snapshot.status !== 'stale' && entry.snapshot.status !== 'loading')
        update(entry, 'data' in entry.snapshot ? 'stale' : 'loading');
      return;
    }
    update(entry, 'data' in entry.snapshot ? 'stale' : 'loading');
    read(entry);
  };
  const subscribeFrame = () => {
    if (!socket || socket.readyState !== 1 || !epoch) return;
    acknowledged = false;
    staleAll();
    armHandshake();
    const resources = store
      .values()
      .filter(supported)
      .map(entry => entry.resource);
    pendingGeneration = ++generation;
    send({type: 'subscribe', version: MANAGER_LIVE_VERSION, generation: pendingGeneration, resources});
  };
  const receive = (raw: unknown) => {
    if (
      typeof raw !== 'string' ||
      raw.length > MANAGER_LIVE_LIMITS.messageBytes ||
      textBytes.encode(raw).length > MANAGER_LIVE_LIMITS.messageBytes
    )
      return disconnect();
    let frame: ManagerLiveServerFrame;
    try {
      frame = decode(JSON.parse(raw));
    } catch {
      return disconnect();
    }
    lastFrame = Date.now();
    if (frame.type === 'welcome') {
      if (epoch) return disconnect();
      epoch = frame.epoch;
      topics = new Set(frame.topics);
      heartbeatMilliseconds = Math.max(1_000, Math.min(60_000, frame.heartbeatMilliseconds));
      for (const entry of store.values()) if (!supported(entry)) update(entry, 'unsupported');
      if (store.values().length && store.values().every(entry => !supported(entry))) {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
        setConnection('unsupported');
      } else subscribeFrame();
      return;
    }
    if (!epoch || frame.epoch !== epoch) return disconnect();
    if (frame.type === 'heartbeat') return;
    if (frame.type === 'subscribed') {
      if (frame.generation !== pendingGeneration || acknowledged) return;
      acknowledged = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
      sequence = frame.startingSequence;
      attempt = 0;
      setConnection('connected');
      const unavailable = new Set((frame.unavailable ?? []).map(managerLiveResourceKey));
      for (const entry of store.values()) {
        if (!supported(entry)) continue;
        entry.available = !unavailable.has(entry.key);
        if (!entry.available) {
          fence(entry);
          update(entry, 'unsupported');
        } else {
          if (entry.snapshot.status === 'unsupported') update(entry, 'data' in entry.snapshot ? 'stale' : 'loading');
          read(entry);
        }
      }
      return;
    }
    if (!acknowledged || frame.generation !== pendingGeneration) return;
    if (frame.sequence <= sequence) return;
    if (frame.sequence !== sequence + 1 || frame.type === 'reset') return subscribeFrame();
    sequence = frame.sequence;
    const entry = store.get(frame.resource);
    if (!entry) return;
    if (frame.type === 'availability') {
      if (!frame.available) {
        entry.available = false;
        fence(entry);
        update(entry, 'unsupported');
      } else {
        entry.available = true;
        subscribeFrame();
      }
      return;
    }
    // Sequence numbers deduplicate delivery. Content revisions can legitimately
    // recur, including while a new subscription's snapshot is in flight.
    dirty(entry);
  };
  const connect = async () => {
    if (!running) return;
    token++;
    const current = token;
    const controller = new AbortController();
    ticketController = controller;
    setConnection('connecting');
    armHandshake();
    try {
      const payload = await options.requestTicket(controller.signal);
      if (!running || current !== token || controller.signal.aborted) return;
      const {ticket} = decodeTicket(payload);
      const url = new URL('/api/live', options.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', ticket);
      const next = createSocket(url.toString());
      socket = next;
      next.onopen = () => {
        if (current !== token) return;
        armHandshake();
        lastFrame = Date.now();
        heartbeatTimer = setInterval(() => {
          if (
            Date.now() - lastFrame >
            Math.max(3 * heartbeatMilliseconds, MANAGER_LIVE_LIMITS.clientTimeoutMilliseconds)
          )
            disconnect();
          else send({type: 'heartbeat', version: MANAGER_LIVE_VERSION});
        }, heartbeatMilliseconds);
      };
      next.onmessage = event => {
        if (current === token) receive(event.data);
      };
      next.onclose = next.onerror = () => {
        if (current === token) disconnect();
      };
    } catch (error) {
      if (current !== token || controller.signal.aborted || !running) return;
      if (isUnavailable(error)) {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
        setConnection('unsupported');
        for (const entry of store.values()) update(entry, 'unsupported');
      } else {
        disconnect();
      }
    }
  };
  return {
    start() {
      if (running) return;
      running = true;
      void connect();
    },
    stop() {
      running = false;
      token++;
      ticketController?.abort();
      clearTimers();
      releaseSocket();
      acknowledged = false;
      epoch = undefined;
      store.clear();
      setConnection('stopped');
      connectionListeners.clear();
    },
    setScope(next: string) {
      if (scopeKey === next) return;
      scopeKey = next;
      store.clear();
      if (running) {
        disconnect();
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        void connect();
      }
    },
    subscribe<T>(resource: ManagerLiveResource, reader: (signal: AbortSignal) => Promise<T>, listener: () => void) {
      const existed = store.get(resource);
      const entry = store.add(resource, reader, listener);
      if (!existed && epoch && socket?.readyState === 1) subscribeFrame();
      if ((epoch && !supported(entry)) || (connection === 'unsupported' && !epoch)) update(entry, 'unsupported');
      return () => {
        if (store.remove(entry, listener) && epoch && socket?.readyState === 1) subscribeFrame();
      };
    },
    getSnapshot<T>(resource: ManagerLiveResource): ManagerLiveSnapshot<T> {
      return (store.get(resource)?.snapshot ?? emptySnapshot) as ManagerLiveSnapshot<T>;
    },
    invalidate(resource: ManagerLiveResource) {
      const entry = store.get(resource);
      if (entry) dirty(entry);
    },
    revalidate() {
      for (const entry of store.values()) dirty(entry);
    },
    getConnectionSnapshot: () => connection,
    subscribeConnection(listener: () => void) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };
}
