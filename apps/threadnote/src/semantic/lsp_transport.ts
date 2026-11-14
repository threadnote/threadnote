import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Cause, Clock, Context, Deferred, Effect, Option, Queue, Schema, Stream} from 'effect';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {
  runtimeSpawnOwnedProviderTree,
  runtimeObserveOwnedProviderTree,
  runtimeTerminateOwnedProviderTree,
  runtimeCloseOwnedProviderTree,
  type RuntimeOwnedProviderObservation,
} from '@threadnote/platform/system';
export class LspFault extends Schema.TaggedError<LspFault, {readonly brand: unique symbol}>()('LspFault', {
  code: Schema.Literals(['protocol', 'capacity', 'write', 'exit', 'timeout', 'closing', 'rejected', 'prerequisite']),
}) {}
type Message = Record<string, unknown>;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
export function encodeLspFrame(message: Message): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header);
  frame.set(body, header.length);
  return frame;
}
export class LspFrameDecoder {
  private buffered = new Uint8Array();
  constructor(private readonly maxBytes = 32 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024)
      throw LspFault.make({code: 'protocol'});
  }
  push(chunk: Uint8Array): Message[] {
    const bytes = new Uint8Array(this.buffered.length + chunk.length);
    bytes.set(this.buffered);
    bytes.set(chunk, this.buffered.length);
    this.buffered = bytes;
    const messages: Message[] = [];
    while (this.buffered.length) {
      let end = -1;
      for (let i = 0; i + 3 < Math.min(this.buffered.length, 8196); i++) {
        if (EffectArray.every([13, 10, 13, 10], (byte, offset) => this.buffered[i + offset] === byte)) {
          end = i;
          break;
        }
      }
      if (end < 0) {
        if (this.buffered.length > 8192) throw LspFault.make({code: 'protocol'});
        break;
      }
      const header = this.buffered.subarray(0, end);
      if (end > 8192 || header.some(byte => byte > 127)) throw LspFault.make({code: 'protocol'});
      const lengths = EffectArray.filter(EffectString.split('\r\n')(decoder.decode(header)), line =>
        /^content-length:/iu.test(line),
      );
      if (lengths.length !== 1 || !/^content-length: *[0-9]+$/iu.test(lengths[0]))
        throw LspFault.make({code: 'protocol'});
      const size = Number(EffectString.split(':')(lengths[0])[1]);
      if (!Number.isSafeInteger(size) || size < 1 || size > this.maxBytes) throw LspFault.make({code: 'protocol'});
      if (this.buffered.length < end + 4 + size) break;
      const value: unknown = JSON.parse(decoder.decode(this.buffered.subarray(end + 4, end + 4 + size)));
      if (
        !value ||
        typeof value !== 'object' ||
        EffectArray.isArray(value) ||
        !('jsonrpc' in value) ||
        value.jsonrpc !== '2.0'
      )
        throw LspFault.make({code: 'protocol'});
      const message = value as Message;
      const id = message.id;
      const validId = typeof id === 'string' ? id.length > 0 && id.length <= 512 : Number.isSafeInteger(id);
      if (EffectRecord.has(message, 'method')) {
        if (
          typeof message.method !== 'string' ||
          message.method.length < 1 ||
          message.method.length > 256 ||
          (id !== undefined && !validId) ||
          EffectRecord.has(message, 'result') ||
          EffectRecord.has(message, 'error')
        )
          throw LspFault.make({code: 'protocol'});
      } else if (
        (!validId && !(id === null && EffectRecord.has(message, 'error'))) ||
        EffectRecord.has(message, 'result') === EffectRecord.has(message, 'error')
      ) {
        throw LspFault.make({code: 'protocol'});
      }
      messages.push(message);
      this.buffered = this.buffered.subarray(end + 4 + size);
    }
    return messages;
  }
  finish(): void {
    if (this.buffered.length) throw LspFault.make({code: 'protocol'});
  }
}
export interface WireStop {
  readonly code: number | null;
  readonly drained: boolean;
  readonly forced: boolean;
  readonly stdioClosed: boolean;
  readonly fault: LspFault | undefined;
}
/** Host-owned startup cancellation follows the original native capability, including Java wires. */
export const SemanticWireStartup = Context.Reference<
  | {
      readonly termination: (terminate: Effect.Effect<void>) => void;
      readonly cleanup: (disposition: 'drained' | 'unknown') => void;
    }
  | undefined
>('semantic/WireStartup', {defaultValue: () => undefined});
export interface LspWire {
  readonly pid: number;
  readonly identity?: string;
  readonly messages: Stream.Stream<Message>;
  readonly failure: () => LspFault | undefined;
  readonly beginClosing: Effect.Effect<void>;
  readonly send: (message: Message) => Effect.Effect<void, LspFault>;
  readonly finish: Effect.Effect<WireStop>;
}
export interface LspLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly maxMessageBytes?: number;
  readonly beforeCreation?: () => void;
  readonly captureOriginal?: (pid: number, finish: Effect.Effect<WireStop>) => void;
}
export interface SemanticProcessAdapter {
  readonly stdout: (bytes: Uint8Array) => void;
  readonly stderr: (bytes: Uint8Array) => void;
  readonly end: (stdout: boolean) => void;
  readonly failed: (fault: LspFault) => void;
}
/** Shared ORIGINAL native acquisition, byte pumps and cached finish; adapters never own or reconstruct a PID capability. */
export const spawnSemanticProcess = Effect.fn('semantic.spawnSemanticProcess')(function* (
  options: LspLaunch,
  adapter: SemanticProcessAdapter,
) {
  const startup = yield* SemanticWireStartup;
  const policy = yield* ChildEnvironmentPolicy;
  let fault: LspFault | undefined;
  let ending = false,
    forced = false,
    nativeClosed = false,
    cleanupUnknown = false;
  let writes = 0,
    writeBytes = 0,
    endedPumps = 0;
  let pumps: readonly Promise<void>[] = [];
  const fail = (code: LspFault['code']) => {
    fault ??= LspFault.make({code});
    adapter.failed(fault);
  };
  // Native creation, cleanup registration and both output owners are one acquisition.
  // A pending interrupt is restored only after the scope can drain the owned capability.
  const {child, finish} = yield* Effect.uninterruptible(
    Effect.gen(function* () {
      // The platform capability, never a PID, owns signalling and the original group/Job.
      options.beforeCreation?.();
      const child = yield* Effect.try({
        try: () =>
          runtimeSpawnOwnedProviderTree({
            command: options.command,
            args: options.args,
            cwd: options.cwd,
            environment: policy.sanitizeExternal(options.environment),
          }),
        catch: () => LspFault.make({code: 'prerequisite'}),
      });
      const observe = (): RuntimeOwnedProviderObservation => {
        try {
          const observation = runtimeObserveOwnedProviderTree(child.handle);
          if (observation.state === 'unknown') cleanupUnknown = true;
          return observation;
        } catch {
          cleanupUnknown = true;
          fail('exit');
          return {state: 'unknown', leaderExitCode: null, stdioClosed: false};
        }
      };
      const waitTree = (milliseconds: number) =>
        Effect.gen(function* () {
          const until = (yield* Clock.currentTimeMillis) + milliseconds;
          let observation = observe();
          while (observation.state !== 'drained' && (yield* Clock.currentTimeMillis) < until) {
            yield* Effect.sleep(20);
            observation = observe();
          }
          return observation;
        });
      const terminate = (mode: 'terminate' | 'kill') =>
        Effect.sync(() => {
          forced = true;
          try {
            runtimeTerminateOwnedProviderTree(child.handle, mode);
          } catch {
            cleanupUnknown = true;
            fail('exit');
          }
        });
      const finish = yield* Effect.cached(
        Effect.uninterruptible(
          Effect.gen(function* () {
            ending = true;
            yield* fromPromiseInterruptible(
              () => child.closeInput(),
              () => LspFault.make({code: 'write'}),
            ).pipe(
              Effect.timeoutOption(2000),
              Effect.tap(result =>
                Effect.sync(() => {
                  if (Option.isNone(result)) {
                    cleanupUnknown = true;
                    fail('write');
                  }
                }),
              ),
              Effect.catch(() =>
                Effect.sync(() => {
                  cleanupUnknown = true;
                  fail('write');
                }),
              ),
            );
            let observation = yield* waitTree(2000);
            if (observation.state !== 'drained') {
              yield* terminate('terminate');
              observation = yield* waitTree(1000);
              if (observation.state !== 'drained') {
                yield* terminate('kill');
                observation = yield* waitTree(2000);
              }
            }
            yield* fromPromiseInterruptible(
              () => Promise.all(pumps),
              () => LspFault.make({code: 'exit'}),
            ).pipe(
              Effect.timeoutOption(2000),
              Effect.tap(result =>
                Effect.sync(() => {
                  if (Option.isNone(result)) cleanupUnknown = true;
                }),
              ),
              Effect.catch(() =>
                Effect.sync(() => {
                  cleanupUnknown = true;
                }),
              ),
            );
            if (writes !== 0) {
              cleanupUnknown = true;
              fail('write');
            }
            let drained =
              !cleanupUnknown &&
              endedPumps === 2 &&
              observation.state === 'drained' &&
              observation.stdioClosed &&
              writes === 0;
            if (!drained) fail('exit');
            if (drained) {
              yield* Effect.try({
                try: () => {
                  runtimeCloseOwnedProviderTree(child.handle);
                  nativeClosed = true;
                },
                catch: () => LspFault.make({code: 'exit'}),
              }).pipe(
                Effect.catch(() =>
                  Effect.sync(() => {
                    drained = false;
                    fail('exit');
                  }),
                ),
              );
            }
            // Unknown ownership deliberately retains the native handle and admission reservation.
            startup?.cleanup(drained && observation.stdioClosed ? 'drained' : 'unknown');
            return {code: observation.leaderExitCode, drained, forced, stdioClosed: observation.stdioClosed, fault};
          }),
        ),
      );
      startup?.termination(
        Effect.suspend(() => (!nativeClosed && observe().state !== 'drained' ? terminate('kill') : Effect.void)),
      );
      // These bounded stream pumps live through shutdown so descendant-held pipes and late errors
      // cannot become a successful drain merely because the leader exited or a request was cancelled.
      const pump = async (stream: ReadableStream<Uint8Array>, stdout: boolean) => {
        const reader = stream.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            if (!fault || !stdout) {
              try {
                if (stdout) adapter.stdout(next.value);
                else adapter.stderr(next.value);
              } catch (error) {
                fail(Schema.is(LspFault)(error) ? error.code : 'protocol');
              }
            }
          }
          try {
            adapter.end(stdout);
          } catch {
            fail(stdout ? 'protocol' : 'exit');
          }
          if (stdout && !ending) fail('exit');
        } catch {
          cleanupUnknown = true;
          fail(stdout ? 'protocol' : 'exit');
        } finally {
          endedPumps++;
          reader.releaseLock();
        }
      };
      pumps = [pump(child.stdout, true), pump(child.stderr, false)];
      yield* Effect.addFinalizer(() => finish.pipe(Effect.asVoid));
      options.captureOriginal?.(child.pid, finish);
      return {child, finish};
    }),
  );
  return {
    pid: child.pid,
    identity: child.identity,
    failure: () => fault,
    beginClosing: Effect.sync(() => {
      ending = true;
    }),
    write: (bytes: Uint8Array) =>
      Effect.suspend(() => {
        if (fault) return Effect.fail(fault);
        if (writes >= 64 || writeBytes + bytes.length > 32 * 1024 * 1024)
          return Effect.fail(LspFault.make({code: 'capacity'}));
        return fromPromiseInterruptible(
          signal => {
            if (signal.aborted) return Promise.reject(new Error('Provider write cancelled'));
            writes++;
            writeBytes += bytes.length;
            return child.write(bytes, signal).finally(() => {
              writes--;
              writeBytes -= bytes.length;
            });
          },
          () => {
            fail('write');
            return fault!;
          },
        ).pipe(
          Effect.onInterrupt(() => Effect.sync(() => fail('write'))),
          Effect.timeoutOption(2000),
          Effect.flatMap(result =>
            Option.isSome(result)
              ? Effect.void
              : Effect.sync(() => fail('write')).pipe(Effect.andThen(Effect.fail(LspFault.make({code: 'write'})))),
          ),
        );
      }),
    finish,
  };
});

export const spawnLspWire = Effect.fn('semantic.spawnLspWire')(function* (options: LspLaunch) {
  const frames = yield* Effect.try({
    try: () => new LspFrameDecoder(options.maxMessageBytes),
    catch: () => LspFault.make({code: 'protocol'}),
  });
  const incoming = yield* Queue.bounded<{message: Message; bytes: number}, Cause.Done>(64);
  let queuedBytes = 0,
    stderrTail = '';
  const process = yield* spawnSemanticProcess(options, {
    stdout: chunk => {
      for (const message of frames.push(chunk)) {
        const bytes = encoder.encode(JSON.stringify(message)).length;
        if (queuedBytes + bytes > 32 * 1024 * 1024 || !Queue.offerUnsafe(incoming, {message, bytes}))
          throw LspFault.make({code: 'capacity'});
        queuedBytes += bytes;
      }
    },
    stderr: chunk => {
      const text = stderrTail + new TextDecoder().decode(chunk);
      stderrTail = EffectString.slice(-4096)(text);
      if (EffectString.includes('panicked at')(text)) throw LspFault.make({code: 'exit'});
    },
    end: stdout => {
      if (stdout) {
        frames.finish();
        Queue.endUnsafe(incoming);
      }
    },
    failed: () => Queue.endUnsafe(incoming),
  });
  const wire: LspWire = {
    pid: process.pid,
    identity: process.identity,
    failure: process.failure,
    beginClosing: process.beginClosing,
    messages: Stream.fromQueue(incoming).pipe(
      Stream.map(packet => {
        queuedBytes -= packet.bytes;
        return packet.message;
      }),
    ),
    send: (message: Message) =>
      Effect.try({try: () => encodeLspFrame(message), catch: () => LspFault.make({code: 'protocol'})}).pipe(
        Effect.flatMap(process.write),
      ),
    finish: process.finish.pipe(Effect.tap(() => Queue.shutdown(incoming))),
  };
  return wire;
});

export interface LspClient {
  readonly pid: number;
  readonly request: (
    method: string,
    params: Schema.Json | undefined,
    milliseconds: number,
  ) => Effect.Effect<Schema.Json, LspFault>;
  readonly notify: (method: string, params: Schema.Json) => Effect.Effect<void, LspFault>;
  readonly close: Effect.Effect<
    WireStop & {
      readonly graceful: boolean;
    }
  >;
}
export const makeLspClient = Effect.fn('semantic.makeLspClient')(function* (
  wire: LspWire,
  onNotification: (method: string, params: unknown) => void = () => {},
  settings: Schema.Json = {},
) {
  let closing = false;
  let fault: LspFault | undefined;
  const fixedSettings = structuredClone(settings);
  const setting = (section: unknown): Schema.Json => {
    if (typeof section !== 'string' || section === '') return fixedSettings;
    let value = fixedSettings;
    for (const key of EffectString.split('.')(section)) {
      if (
        !value ||
        typeof value !== 'object' ||
        EffectArray.isArray<Schema.Json>(value) ||
        !EffectRecord.has<string, Schema.Json>(value, key)
      )
        return null;
      value = value[key];
    }
    return value;
  };
  let nextId = 1;
  const pending = new Map<number, Deferred.Deferred<Schema.Json, LspFault>>();
  const fail = (error: LspFault) =>
    Effect.sync(() => {
      fault ??= error;
      for (const entry of pending.values()) Deferred.doneUnsafe(entry, Effect.fail(error));
      pending.clear();
    });
  const request = (method: string, params: Schema.Json | undefined, milliseconds: number, internal = false) =>
    Effect.suspend(() => {
      if ((closing && !internal) || fault || wire.failure())
        return Effect.fail(fault ?? wire.failure() ?? LspFault.make({code: 'closing'}));
      if (pending.size >= 32) return Effect.fail(LspFault.make({code: 'capacity'}));
      if (
        !Number.isSafeInteger(milliseconds) ||
        milliseconds < 1 ||
        milliseconds > 120000 ||
        nextId >= Number.MAX_SAFE_INTEGER
      )
        return Effect.fail(LspFault.make({code: 'protocol'}));
      const id = nextId++;
      const entry = Deferred.makeUnsafe<Schema.Json, LspFault>();
      pending.set(id, entry);
      const cancel = wire
        .send({jsonrpc: '2.0', method: '$/cancelRequest', params: {id}})
        .pipe(Effect.timeoutOption(100), Effect.asVoid, Effect.ignore);
      return wire.send({jsonrpc: '2.0', id, method, ...(params === undefined ? {} : {params})}).pipe(
        Effect.andThen(Deferred.await(entry)),
        Effect.timeoutOption(milliseconds),
        Effect.flatMap(result => {
          if (Option.isNone(result)) return cancel.pipe(Effect.andThen(Effect.fail(LspFault.make({code: 'timeout'}))));
          const currentFault = wire.failure();
          return currentFault ? Effect.fail(currentFault) : Effect.succeed(result.value);
        }),
        Effect.onInterrupt(() => cancel),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      );
    });
  yield* wire.messages.pipe(
    Stream.runForEach(message =>
      Effect.gen(function* () {
        if (typeof message.method === 'string') {
          const method = message.method;
          if (message.method.length > 256) return yield* fail(LspFault.make({code: 'protocol'}));
          if (message.id === undefined) {
            yield* Effect.try({
              try: () => onNotification(method, message.params),
              catch: () => LspFault.make({code: 'protocol'}),
            });
          } else {
            const items =
              message.method === 'workspace/configuration' &&
              typeof message.params === 'object' &&
              message.params !== null &&
              'items' in message.params &&
              EffectArray.isArray(message.params.items)
                ? message.params.items
                : undefined;
            const configurationAllowed = items !== undefined && items.length <= 64;
            const result =
              message.method === 'workspace/applyEdit'
                ? {applied: false, failureReason: 'Read-only semantic session'}
                : configurationAllowed
                  ? EffectArray.map(items, item =>
                      setting(
                        typeof item === 'object' && item !== null && 'section' in item ? item.section : undefined,
                      ),
                    )
                  : null;
            const supported =
              ['workspace/applyEdit', 'workspace/configuration', 'window/workDoneProgress/create'].includes(
                message.method,
              ) &&
              (message.method !== 'workspace/configuration' || configurationAllowed);
            yield* wire.send({
              jsonrpc: '2.0',
              id: message.id,
              ...(supported
                ? {result}
                : {
                    error: {
                      code: message.method === 'workspace/configuration' ? -32602 : -32601,
                      message: 'Unsupported provider request',
                    },
                  }),
            });
          }
        } else if (message.id === null) {
          yield* fail(LspFault.make({code: 'protocol'}));
        } else if (typeof message.id === 'number') {
          const entry = pending.get(message.id);
          if (entry) {
            const response = EffectRecord.has(message, 'error')
              ? Effect.fail(LspFault.make({code: 'rejected'}))
              : EffectRecord.has(message, 'result') && Schema.is(Schema.Json)(message.result)
                ? Effect.succeed(message.result)
                : Effect.fail(LspFault.make({code: 'protocol'}));
            Deferred.doneUnsafe(entry, response);
          }
        }
      }),
    ),
    Effect.catchCause(() => fail(LspFault.make({code: 'protocol'}))),
    Effect.ensuring(
      Effect.suspend(() => (closing ? Effect.void : fail(wire.failure() ?? LspFault.make({code: 'exit'})))),
    ),
    Effect.forkScoped,
  );
  const close = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        closing = true;
        for (const entry of pending.values()) Deferred.doneUnsafe(entry, Effect.fail(LspFault.make({code: 'closing'})));
        pending.clear();
        yield* wire.beginClosing;
        let handshakeFault: LspFault | undefined;
        const handshake = yield* Effect.gen(function* () {
          yield* request('shutdown', undefined, 2000, true);
          yield* wire.send({jsonrpc: '2.0', method: 'exit'});
        }).pipe(
          Effect.catch(error =>
            Effect.sync(() => {
              handshakeFault = error;
            }),
          ),
          Effect.timeoutOption(2000),
        );
        if (Option.isNone(handshake)) handshakeFault ??= LspFault.make({code: 'timeout'});
        const stopped = yield* wire.finish;
        yield* fail(LspFault.make({code: 'closing'}));
        const finalFault = stopped.fault ?? handshakeFault;
        return {
          ...stopped,
          fault: finalFault,
          graceful:
            Option.isSome(handshake) &&
            !finalFault &&
            !stopped.forced &&
            stopped.code === 0 &&
            stopped.drained &&
            stopped.stdioClosed,
        };
      }),
    ),
  );
  yield* Effect.addFinalizer(() => close.pipe(Effect.asVoid));
  return {
    pid: wire.pid,
    request,
    notify: (method: string, params: Schema.Json) =>
      Effect.suspend(() =>
        closing || fault || wire.failure()
          ? Effect.fail(fault ?? wire.failure() ?? LspFault.make({code: 'closing'}))
          : wire.send({jsonrpc: '2.0', method, params}),
      ),
    close,
  } satisfies LspClient;
});
