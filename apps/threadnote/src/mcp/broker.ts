import type {StandaloneActiveRelease} from '../process/standalone_lease.js';
import {Predicate, Schema} from 'effect';

const MCP_BROKER_MAX_LINE_BYTES = 32 * 1024 * 1024;
const MCP_BROKER_REPLAY_TIMEOUT_MILLISECONDS = 10_000;
const MCP_BROKER_CHILD_STOP_WAIT_MILLISECONDS = 1_000;
const MCP_BROKER_CHILD_IDLE_TIMEOUT_MILLISECONDS = 5 * 60_000;
const MCP_BROKER_RUNTIME_EXIT_ERROR =
  'Threadnote MCP runtime exited before responding. A write may have committed. Read the canonical record before deciding whether to retry; do not replay the write blindly.';
const MCP_BROKER_RUNTIME_REPLACED_ERROR =
  'Threadnote MCP runtime was replaced before responding. A write may have committed on the old runtime. Read the canonical record before deciding whether to retry; do not replay the write blindly.';
const MCP_BROKER_INTERRUPTED_CODE = -32_080;
const MCP_BROKER_NO_ACTIVE_RELEASE_ERROR =
  'No valid active Threadnote release is installed. Run "threadnote install --no-start" with the downloaded executable, then reconnect this client. This request was not sent to a runtime.';
const MCP_BROKER_STARTUP_ERROR =
  'Threadnote could not start or select an MCP runtime. Check the Threadnote installation and reconnect this client. This request was not sent to a runtime.';

type McpBrokerStartupFailure = 'no-active-release' | 'startup-failed';

export class McpBrokerError extends Schema.TaggedError<McpBrokerError>()('McpBrokerError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
  reason: Schema.optionalKey(Schema.Literal('no-active-release')),
}) {}

interface McpBrokerChildInput {
  end(): Promise<unknown> | unknown;
  flush(): Promise<unknown> | unknown;
  write(value: string): number | Promise<number>;
}

export interface McpBrokerChild {
  readonly exited: Promise<number>;
  readonly input: McpBrokerChildInput;
  kill(signal?: number | NodeJS.Signals): void;
  readonly output: AsyncIterable<Uint8Array>;
  readonly processId: number;
}

export type McpBrokerFailureEvent =
  | {readonly area: 'child'; readonly reason: 'exit' | 'spawn' | 'write'}
  | {readonly area: 'promotion'; readonly reason: 'protocol' | 'timeout'};

export interface McpBrokerDependencies {
  readonly childIdleTimeoutMilliseconds?: number;
  readonly input: AsyncIterable<Uint8Array>;
  readonly onFailure?: (event: McpBrokerFailureEvent) => void;
  readonly readActiveRelease: () => Promise<StandaloneActiveRelease | undefined>;
  readonly replayTimeoutMilliseconds?: number;
  readonly spawn: (release: StandaloneActiveRelease) => McpBrokerChild;
  readonly writeOutput: (line: string) => Promise<void>;
}

interface JsonRpcEnvelope {
  readonly error?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
}

interface ActiveBrokerChild {
  readonly child: McpBrokerChild;
  readonly generation: number;
  readonly release: StandaloneActiveRelease;
  replay?: {
    readonly idKey: string;
    readonly reject: (cause: unknown) => void;
    readonly resolve: () => void;
  };
}

interface ServerRequestRoute {
  readonly child: ActiveBrokerChild;
  readonly externalId: string;
  readonly originalId: string | number;
}

/**
 * Keeps the editor-owned stdio transport stable while versioned MCP runtimes
 * are promoted behind it. Requests already admitted by the old runtime are
 * allowed to finish; the next request starts the active release and replays the
 * MCP initialization handshake before forwarding new work.
 */
export async function runMcpBroker(dependencies: McpBrokerDependencies): Promise<void> {
  const broker = new McpBroker(dependencies);
  await broker.run();
}

class McpBroker {
  readonly #clientRequests = new Map<string, string | number>();
  readonly #dependencies: McpBrokerDependencies;
  readonly #serverRequestRoutes = new Map<string, ServerRequestRoute>();
  readonly #serverRequestRoutesByChildId = new Map<string, ServerRequestRoute>();
  readonly #retiringChildren = new Set<Promise<void>>();
  readonly #terminalOutputFailure = Promise.withResolvers<never>();
  #child: ActiveBrokerChild | undefined;
  #closed = false;
  #handlingClientLine = false;
  #idleChildTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingOutputWrites = 0;
  #nextChildGeneration = 0;
  #nextServerRequestSequence = 0;
  #initializeLine: string | undefined;
  #initializeRequestId: string | number | undefined;
  #initializedLine: string | undefined;
  #outputTail = Promise.resolve();
  #pendingInitialize:
    | {
        readonly child: ActiveBrokerChild;
        readonly idKey: string;
        readonly line: string;
        readonly requestId: string | number;
      }
    | undefined;

  constructor(dependencies: McpBrokerDependencies) {
    this.#dependencies = dependencies;
  }

  async run(): Promise<void> {
    try {
      await Promise.race([this.#readClientInput(), this.#terminalOutputFailure.promise]);
    } finally {
      this.#closed = true;
      this.#cancelIdleChildTimer();
      await this.#stopCurrentChild();
      await Promise.all(this.#retiringChildren);
      await this.#outputTail.catch(() => undefined);
    }
  }

  async #readClientInput(): Promise<void> {
    for await (const line of ndjsonLines(this.#dependencies.input)) {
      if (this.#closed) return;
      this.#cancelIdleChildTimer();
      this.#handlingClientLine = true;
      try {
        await this.#handleClientLine(line);
      } finally {
        this.#handlingClientLine = false;
        this.#scheduleIdleChildRetirement();
      }
    }
  }

  async #handleClientLine(line: string): Promise<void> {
    const envelope = parseJsonRpcEnvelope(line);
    if (envelope?.method === undefined && isJsonRpcId(envelope?.id)) {
      await this.#handleClientResponse(line, envelope.id);
      return;
    }

    const requestId = envelope?.method !== undefined && isJsonRpcId(envelope.id) ? envelope.id : undefined;
    let trackedRequest = false;
    try {
      const current = await this.#ensureCurrentChild();
      if (this.#closed) return;
      if (envelope?.method === 'initialize' && requestId !== undefined) {
        this.#pendingInitialize = {
          child: current,
          idKey: jsonRpcIdKey(requestId),
          line,
          requestId,
        };
      } else if (envelope?.method === 'notifications/initialized') {
        this.#initializedLine = line;
      } else if (envelope?.method === 'notifications/cancelled') {
        const cancelledId = cancelledRequestId(envelope.params);
        if (cancelledId !== undefined) {
          const cancelledKey = jsonRpcIdKey(cancelledId);
          if (!this.#clientRequests.has(cancelledKey)) return;
          this.#clientRequests.delete(cancelledKey);
        }
      }
      if (requestId !== undefined) {
        this.#clientRequests.set(jsonRpcIdKey(requestId), requestId);
        trackedRequest = true;
      }
      await this.#writeChildLine(current.child, line);
    } catch (cause) {
      if (this.#closed) return;
      const pending = [...this.#clientRequests.values()];
      this.#clientRequests.clear();
      const failedChild = this.#child;
      await this.#stopCurrentChild();
      const runtimeReason = failedChild ? await this.#runtimeFailureReason(failedChild) : 'runtime-interrupted';
      for (const id of pending) await this.#queueRequestFailure(id, undefined, runtimeReason);
      if (requestId !== undefined && !trackedRequest) {
        const reason =
          Schema.is(McpBrokerError)(cause) && cause.reason === 'no-active-release'
            ? 'no-active-release'
            : 'startup-failed';
        await this.#queueRequestFailure(requestId, reason);
      }
    }
  }

  async #handleClientResponse(line: string, externalId: string | number): Promise<void> {
    const route = this.#serverRequestRoutes.get(jsonRpcIdKey(externalId));
    if (route === undefined) return;
    this.#deleteServerRequestRoute(route);
    if (this.#child !== route.child) return;
    try {
      await this.#writeChildLine(route.child.child, replaceJsonRpcId(line, route.originalId));
    } catch {
      await this.#stopCurrentChild();
    }
  }

  async #ensureCurrentChild(): Promise<ActiveBrokerChild> {
    const active = await this.#dependencies.readActiveRelease();
    if (this.#closed) throw McpBrokerError.make({message: 'Threadnote MCP client transport is closed.'});
    if (active === undefined) {
      if (this.#child !== undefined) return this.#child;
      throw McpBrokerError.make({message: MCP_BROKER_NO_ACTIVE_RELEASE_ERROR, reason: 'no-active-release'});
    }
    if (
      this.#child !== undefined &&
      this.#child.release.version === active.version &&
      this.#child.release.releaseRoot === active.releaseRoot
    ) {
      return this.#child;
    }
    if (this.#child !== undefined && (this.#clientRequests.size > 0 || this.#serverRequestRoutes.size > 0)) {
      return this.#child;
    }
    await this.#stopCurrentChild();
    if (this.#closed) throw McpBrokerError.make({message: 'Threadnote MCP client transport is closed.'});
    const next = this.#startChild(active);
    if (this.#initializeLine !== undefined && this.#initializeRequestId !== undefined) {
      await this.#replayInitialization(next);
      if (this.#initializedLine !== undefined) await this.#queueListChangedNotifications();
    }
    return next;
  }

  #startChild(release: StandaloneActiveRelease): ActiveBrokerChild {
    let child: McpBrokerChild;
    try {
      child = this.#dependencies.spawn(release);
    } catch (cause) {
      this.#reportFailure({area: 'child', reason: 'spawn'});
      throw cause;
    }
    const active = {
      child,
      generation: (this.#nextChildGeneration += 1),
      release,
    } satisfies ActiveBrokerChild;
    this.#child = active;
    void this.#observeChild(active);
    return active;
  }

  async #observeChild(active: ActiveBrokerChild): Promise<void> {
    // Wait for the process to exit before failing in-flight requests. A
    // stdout-pump error is not itself a runtime exit; stop the child so the
    // observer can settle instead of reporting exit while work continues.
    const outputPump = this.#readChildOutput(active).catch(() => {
      if (this.#child !== active) return;
      try {
        active.child.kill('SIGTERM');
      } catch {
        // The child can already have exited.
      }
    });
    await Promise.all([outputPump, active.child.exited.catch(() => -1)]);
    if (this.#child !== active) return;
    this.#cancelIdleChildTimer();
    this.#reportFailure({area: 'child', reason: 'exit'});
    this.#child = undefined;
    if (this.#pendingInitialize?.child === active) this.#pendingInitialize = undefined;
    active.replay?.reject(McpBrokerError.make({message: 'Threadnote MCP runtime exited during session promotion.'}));
    active.replay = undefined;
    const pending = [...this.#clientRequests.values()];
    this.#clientRequests.clear();
    const runtimeReason = await this.#runtimeFailureReason(active);
    await this.#cancelServerRequestRoutes(active);
    this.#deleteServerRequestRoutes(active);
    for (const id of pending) {
      await this.#queueRequestFailure(id, undefined, runtimeReason);
    }
  }

  async #readChildOutput(active: ActiveBrokerChild): Promise<void> {
    for await (const line of ndjsonLines(active.child.output)) {
      if (this.#child !== active) continue;
      this.#cancelIdleChildTimer();
      const envelope = parseJsonRpcEnvelope(line);
      if (envelope === undefined) {
        // The stdio transport is JSON-RPC NDJSON. Never forward child stdout
        // that is not a JSON-RPC envelope (for example a pretty-logger line
        // that escaped to stdout): clients fail the transport on the first
        // non-JSON line. The child already records the underlying condition
        // in its production logs and telemetry.
        continue;
      }
      let outgoingLine = line;
      let completedRequest: string | undefined;
      if (isJsonRpcId(envelope?.id)) {
        const idKey = jsonRpcIdKey(envelope.id);
        if (active.replay?.idKey === idKey && envelope?.method === undefined) {
          const replay = active.replay;
          active.replay = undefined;
          if (envelope.error === undefined && envelope.result !== undefined) replay.resolve();
          else {
            this.#reportFailure({area: 'promotion', reason: 'protocol'});
            replay.reject(
              McpBrokerError.make({message: 'The promoted MCP runtime rejected the replayed initialization.'}),
            );
          }
          continue;
        }
        if (this.#pendingInitialize?.child === active && this.#pendingInitialize.idKey === idKey) {
          const pending = this.#pendingInitialize;
          this.#pendingInitialize = undefined;
          if (envelope.error === undefined && envelope.result !== undefined) {
            this.#initializeLine = pending.line;
            this.#initializeRequestId = pending.requestId;
          }
        }
        if (envelope?.method === undefined) {
          completedRequest = idKey;
        } else {
          const route = this.#createServerRequestRoute(active, envelope.id);
          outgoingLine = replaceJsonRpcId(line, route.externalId);
        }
      } else if (envelope?.method === 'notifications/cancelled') {
        const requestId = cancelledRequestId(envelope.params);
        if (requestId !== undefined) {
          const route = this.#serverRequestRoutesByChildId.get(childRequestIdKey(active, requestId));
          if (route === undefined) continue;
          this.#deleteServerRequestRoute(route);
          outgoingLine = replaceCancelledRequestId(line, route.externalId);
        }
      }
      await this.#queueOutput(outgoingLine).catch(() => undefined);
      if (this.#closed) return;
      if (this.#child === active && completedRequest !== undefined) this.#clientRequests.delete(completedRequest);
      this.#scheduleIdleChildRetirement();
    }
  }

  async #replayInitialization(active: ActiveBrokerChild): Promise<void> {
    const initializeLine = this.#initializeLine;
    const initializeRequestId = this.#initializeRequestId;
    if (initializeLine === undefined || initializeRequestId === undefined) return;
    const replayed = Promise.withResolvers<void>();
    const replay = {
      idKey: jsonRpcIdKey(initializeRequestId),
      reject: (cause: unknown) => replayed.reject(cause),
      resolve: () => replayed.resolve(),
    };
    active.replay = replay;
    await this.#writeChildLine(active.child, initializeLine);
    await Promise.race([
      replayed.promise,
      Bun.sleep(this.#dependencies.replayTimeoutMilliseconds ?? MCP_BROKER_REPLAY_TIMEOUT_MILLISECONDS).then(() => {
        if (active.replay !== replay) return;
        this.#reportFailure({area: 'promotion', reason: 'timeout'});
        throw McpBrokerError.make({message: 'Timed out initializing the promoted Threadnote MCP runtime.'});
      }),
    ]);
    if (this.#initializedLine !== undefined) await this.#writeChildLine(active.child, this.#initializedLine);
  }

  async #stopCurrentChild(active = this.#child): Promise<void> {
    if (active === undefined || this.#child !== active) return;
    this.#cancelIdleChildTimer();
    this.#child = undefined;
    if (this.#pendingInitialize?.child === active) this.#pendingInitialize = undefined;
    await this.#cancelServerRequestRoutes(active);
    this.#deleteServerRequestRoutes(active);
    active.replay?.reject(McpBrokerError.make({message: 'Threadnote MCP runtime promotion was superseded.'}));
    active.replay = undefined;
    try {
      void Promise.resolve(active.child.input.end()).catch(() => undefined);
    } catch {
      // A closed stdin still needs the bounded exit and signal sequence.
    }
    if (await exitsWithin(active.child, MCP_BROKER_CHILD_STOP_WAIT_MILLISECONDS)) return;
    try {
      active.child.kill('SIGTERM');
    } catch {
      // The child can exit between the bounded wait and the signal.
    }
    if (await exitsWithin(active.child, MCP_BROKER_CHILD_STOP_WAIT_MILLISECONDS)) return;
    try {
      active.child.kill('SIGKILL');
    } catch {
      // The child already exited.
    }
    await exitsWithin(active.child, MCP_BROKER_CHILD_STOP_WAIT_MILLISECONDS);
  }

  #childIsIdle(active: ActiveBrokerChild): boolean {
    return (
      !this.#closed &&
      this.#child === active &&
      !this.#handlingClientLine &&
      this.#pendingOutputWrites === 0 &&
      this.#clientRequests.size === 0 &&
      this.#serverRequestRoutes.size === 0 &&
      this.#pendingInitialize === undefined &&
      active.replay === undefined
    );
  }

  #cancelIdleChildTimer(): void {
    if (this.#idleChildTimer === undefined) return;
    clearTimeout(this.#idleChildTimer);
    this.#idleChildTimer = undefined;
  }

  #scheduleIdleChildRetirement(): void {
    const active = this.#child;
    if (active === undefined || !this.#childIsIdle(active) || this.#idleChildTimer !== undefined) return;
    const configured = this.#dependencies.childIdleTimeoutMilliseconds;
    const timeout =
      configured !== undefined && Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647
        ? configured
        : MCP_BROKER_CHILD_IDLE_TIMEOUT_MILLISECONDS;
    this.#idleChildTimer = setTimeout(() => {
      this.#idleChildTimer = undefined;
      if (!this.#childIsIdle(active)) return;
      const retiring = this.#stopCurrentChild(active).catch(() => undefined);
      this.#retiringChildren.add(retiring);
      void retiring.finally(() => this.#retiringChildren.delete(retiring));
    }, timeout);
  }

  #createServerRequestRoute(active: ActiveBrokerChild, originalId: string | number): ServerRequestRoute {
    const previous = this.#serverRequestRoutesByChildId.get(childRequestIdKey(active, originalId));
    if (previous !== undefined) this.#deleteServerRequestRoute(previous);
    const externalId = `threadnote-broker:${active.generation}:${(this.#nextServerRequestSequence += 1)}`;
    const route = {child: active, externalId, originalId} satisfies ServerRequestRoute;
    this.#serverRequestRoutes.set(jsonRpcIdKey(externalId), route);
    this.#serverRequestRoutesByChildId.set(childRequestIdKey(active, originalId), route);
    return route;
  }

  #deleteServerRequestRoute(route: ServerRequestRoute): void {
    this.#serverRequestRoutes.delete(jsonRpcIdKey(route.externalId));
    this.#serverRequestRoutesByChildId.delete(childRequestIdKey(route.child, route.originalId));
  }

  #deleteServerRequestRoutes(active: ActiveBrokerChild): void {
    for (const route of this.#serverRequestRoutes.values()) {
      if (route.child === active) this.#deleteServerRequestRoute(route);
    }
  }

  async #cancelServerRequestRoutes(active: ActiveBrokerChild): Promise<void> {
    for (const route of this.#serverRequestRoutes.values()) {
      if (route.child !== active) continue;
      await this.#queueOutput(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: {reason: 'Threadnote MCP runtime exited.', requestId: route.externalId},
        }),
      );
    }
  }

  async #queueListChangedNotifications(): Promise<void> {
    await this.#queueOutput(JSON.stringify({jsonrpc: '2.0', method: 'notifications/tools/list_changed'}));
    await this.#queueOutput(JSON.stringify({jsonrpc: '2.0', method: 'notifications/resources/list_changed'}));
  }

  #queueRequestFailure(
    id: string | number,
    startupFailure?: McpBrokerStartupFailure,
    runtimeReason: 'runtime-interrupted' | 'runtime-replaced' = 'runtime-interrupted',
  ): Promise<void> {
    return this.#queueOutput(
      JSON.stringify({
        error: {
          code: startupFailure === undefined ? MCP_BROKER_INTERRUPTED_CODE : -32_603,
          message:
            startupFailure === undefined
              ? runtimeReason === 'runtime-replaced'
                ? MCP_BROKER_RUNTIME_REPLACED_ERROR
                : MCP_BROKER_RUNTIME_EXIT_ERROR
              : startupFailure === 'no-active-release'
                ? MCP_BROKER_NO_ACTIVE_RELEASE_ERROR
                : MCP_BROKER_STARTUP_ERROR,
          data:
            startupFailure === undefined
              ? {
                  reason: runtimeReason,
                  requestDisposition: 'dispatched-or-uncertain',
                  writeOutcome: 'unknown',
                  recovery: 'Read the canonical record before retrying a mutating operation.',
                }
              : {reason: startupFailure, requestDisposition: 'not-dispatched'},
        },
        id,
        jsonrpc: '2.0',
      }),
    );
  }

  async #runtimeFailureReason(active: ActiveBrokerChild): Promise<'runtime-interrupted' | 'runtime-replaced'> {
    const current = await this.#dependencies.readActiveRelease().catch(() => undefined);
    return current && (current.version !== active.release.version || current.releaseRoot !== active.release.releaseRoot)
      ? 'runtime-replaced'
      : 'runtime-interrupted';
  }

  #queueOutput(line: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#cancelIdleChildTimer();
    this.#pendingOutputWrites += 1;
    const write = this.#outputTail.then(async () => {
      if (this.#closed) return;
      try {
        await this.#dependencies.writeOutput(line);
      } catch (cause) {
        if (recoverableProgressWriteFailure(line, cause)) return;
        this.#closed = true;
        this.#cancelIdleChildTimer();
        this.#terminalOutputFailure.reject(McpBrokerError.make({message: 'Threadnote MCP client output failed.'}));
      }
    });
    this.#outputTail = write.catch(() => undefined);
    return write.finally(() => {
      this.#pendingOutputWrites -= 1;
      this.#scheduleIdleChildRetirement();
    });
  }

  #reportFailure(event: McpBrokerFailureEvent): void {
    try {
      this.#dependencies.onFailure?.(event);
    } catch {
      // Optional diagnostics cannot alter broker recovery or client transport.
    }
  }

  async #writeChildLine(child: McpBrokerChild, line: string): Promise<void> {
    try {
      await writeChildLine(child, line);
    } catch (cause) {
      this.#reportFailure({area: 'child', reason: 'write'});
      throw cause;
    }
  }
}

async function writeChildLine(child: McpBrokerChild, line: string): Promise<void> {
  await child.input.write(`${line}\n`);
  await child.input.flush();
}

async function exitsWithin(child: McpBrokerChild, timeoutMilliseconds: number): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => timeout.resolve(false), timeoutMilliseconds);
  try {
    return await Promise.race([child.exited.then(() => true).catch(() => true), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function recoverableProgressWriteFailure(line: string, cause: unknown): boolean {
  const envelope = parseJsonRpcEnvelope(line);
  return (
    envelope?.method === 'notifications/progress' &&
    envelope.id === undefined &&
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause.code === 'EAGAIN' || cause.code === 'EWOULDBLOCK')
  );
}

async function* ndjsonLines(input: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of input) {
    buffered += decoder.decode(chunk, {stream: true});
    if (new TextEncoder().encode(buffered).byteLength > MCP_BROKER_MAX_LINE_BYTES) {
      throw McpBrokerError.make({message: 'Threadnote MCP broker received an oversized protocol line.'});
    }
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).replace(/\r$/u, '');
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) yield line;
    }
  }
  buffered += decoder.decode();
  const line = buffered.replace(/\r$/u, '');
  if (line.length > 0) yield line;
}

function parseJsonRpcEnvelope(line: string): JsonRpcEnvelope | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function jsonRpcIdKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

function childRequestIdKey(active: ActiveBrokerChild, id: string | number): string {
  return `${active.generation}:${jsonRpcIdKey(id)}`;
}

function replaceJsonRpcId(line: string, id: string | number): string {
  return JSON.stringify({...JSON.parse(line), id});
}

function replaceCancelledRequestId(line: string, requestId: string | number): string {
  const parsed: unknown = JSON.parse(line);
  const envelope = Predicate.isObject(parsed) ? parsed : {};
  const params =
    typeof envelope.params === 'object' && envelope.params !== null && !Array.isArray(envelope.params)
      ? envelope.params
      : {};
  return JSON.stringify({...envelope, params: {...params, requestId}});
}

function cancelledRequestId(params: unknown): string | number | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params) || !('requestId' in params)) {
    return undefined;
  }
  return isJsonRpcId(params.requestId) ? params.requestId : undefined;
}
