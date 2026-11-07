import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
/* oxlint-disable effecttsgo/node-builtin-import, threadnote/no-node-runtime -- This scoped OS stdio boundary retains late write errors through close; the standard process sink loses them on Bun. */
import {spawn, type ChildProcess} from 'node:child_process';
import {Cause, Clock, Deferred, Effect, Option, Queue, Schema, Stream} from 'effect';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {isJsonObject} from '@threadnote/platform/json';
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
export interface LspWire {
  readonly pid: number;
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
}
export const spawnLspWire = Effect.fn('semantic.spawnLspWire')(function* (options: LspLaunch) {
  // Windows process-tree containment remains a mandatory release qualification gate.
  if (process.platform === 'win32') return yield* LspFault.make({code: 'prerequisite'});
  const frames = yield* Effect.try({
    try: () => new LspFrameDecoder(options.maxMessageBytes),
    catch: () => LspFault.make({code: 'protocol'}),
  });
  const policy = yield* ChildEnvironmentPolicy;
  const incoming = yield* Queue.bounded<
    {
      message: Message;
      bytes: number;
    },
    Cause.Done
  >(64);
  const spawned = Deferred.makeUnsafe<void, LspFault>();
  const exited = Deferred.makeUnsafe<void>();
  const closed = Deferred.makeUnsafe<void>();
  let child: ChildProcess | undefined;
  let fault: LspFault | undefined;
  let ending = false;
  let code: number | null = null;
  let stdioClosed = false;
  let forced = false;
  let queuedBytes = 0;
  let writes = 0;
  let writeBytes = 0;
  let stderrTail = '';
  const fail = (code: LspFault['code']) => {
    fault ??= LspFault.make({code});
    Queue.endUnsafe(incoming);
  };
  const alive = () => {
    if (!child?.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return !isJsonObject(error) || error.code !== 'ESRCH';
    }
  };
  const signal = (signal: NodeJS.Signals) =>
    Effect.sync(() => {
      if (!alive()) return;
      forced = true;
      try {
        process.kill(-child!.pid!, signal);
      } catch (error) {
        if (!isJsonObject(error) || error.code !== 'ESRCH') fail('exit');
      }
    });
  const waitGroup = (milliseconds: number) =>
    Effect.gen(function* () {
      const until = (yield* Clock.currentTimeMillis) + milliseconds;
      while (alive() && (yield* Clock.currentTimeMillis) < until) yield* Effect.sleep(20);
    });
  const finish = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        ending = true;
        const gracefulUntil = (yield* Clock.currentTimeMillis) + 2000;
        yield* Effect.try({try: () => child?.stdin?.end(), catch: () => LspFault.make({code: 'write'})}).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              fail('write');
            }),
          ),
        );
        if (Option.isNone(yield* Deferred.await(exited).pipe(Effect.timeoutOption(2000)))) fail('exit');
        // A server can exit before its compiler children finish their own shutdown.
        // Give the whole owned group the remaining grace budget before escalation.
        yield* waitGroup(Math.max(0, gracefulUntil - (yield* Clock.currentTimeMillis)));
        if (alive()) {
          yield* signal('SIGTERM');
          yield* waitGroup(1000);
          if (alive()) {
            yield* signal('SIGKILL');
            yield* waitGroup(1000);
          }
        }
        if (Option.isNone(yield* Deferred.await(closed).pipe(Effect.timeoutOption(2000)))) fail('exit');
        if (writes !== 0) fail('write');
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        yield* Queue.shutdown(incoming);
        return {code, drained: !alive(), forced, stdioClosed, fault};
      }),
    ),
  );
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        child = spawn(options.command, [...options.args], {
          cwd: options.cwd,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: policy.sanitizeExternal(options.environment),
        });
        child.once('spawn', () => Deferred.doneUnsafe(spawned, Effect.void));
        child.once('error', () => {
          fail('exit');
          Deferred.doneUnsafe(spawned, Effect.fail(fault!));
          Deferred.doneUnsafe(exited, Effect.void);
        });
        child.once('exit', value => {
          code = value;
          if (!ending) fail('exit');
          Deferred.doneUnsafe(exited, Effect.void);
        });
        child.once('close', () => {
          stdioClosed = true;
          Queue.endUnsafe(incoming);
          Deferred.doneUnsafe(closed, Effect.void);
        });
        child.stdin!.on('error', () => fail('write'));
        child.stdout!.on('error', () => fail('protocol'));
        child.stdout!.on('data', bytes => {
          try {
            for (const message of frames.push(bytes)) {
              const size = encoder.encode(JSON.stringify(message)).length;
              if (queuedBytes + size > 32 * 1024 * 1024) throw LspFault.make({code: 'capacity'});
              queuedBytes += size;
              if (!Queue.offerUnsafe(incoming, {message, bytes: size})) {
                queuedBytes -= size;
                throw LspFault.make({code: 'capacity'});
              }
            }
          } catch (error) {
            fail(Schema.is(LspFault)(error) ? error.code : 'protocol');
          }
        });
        child.stdout!.on('end', () => {
          try {
            frames.finish();
          } catch {
            fail('protocol');
          }
          Queue.endUnsafe(incoming);
        });
        child.stderr!.on('error', () => fail('exit'));
        child.stderr!.on('data', bytes => {
          const text = stderrTail + new TextDecoder().decode(bytes);
          if (EffectString.includes('panicked at')(text)) fail('exit');
          stderrTail = EffectString.slice(-4096)(text);
        });
        return child;
      },
      catch: () => LspFault.make({code: 'exit'}),
    }),
    () => finish.pipe(Effect.asVoid),
  );
  yield* Deferred.await(spawned);
  const pid = child?.pid;
  if (!pid) return yield* LspFault.make({code: 'exit'});
  return {
    pid,
    messages: Stream.fromQueue(incoming).pipe(
      Stream.map(packet => {
        queuedBytes -= packet.bytes;
        return packet.message;
      }),
    ),
    failure: () => fault,
    beginClosing: Effect.sync(() => {
      ending = true;
    }),
    send: (message: Message) =>
      Effect.callback<void, LspFault>(resume => {
        if (fault) {
          resume(Effect.fail(fault));
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = encodeLspFrame(message);
        } catch {
          resume(Effect.fail(LspFault.make({code: 'protocol'})));
          return;
        }
        if (writes >= 64 || writeBytes + bytes.length > 32 * 1024 * 1024) {
          resume(Effect.fail(LspFault.make({code: 'capacity'})));
          return;
        }
        writes++;
        writeBytes += bytes.length;
        let completed = false;
        const complete = (error?: Error | null) => {
          if (completed) return;
          completed = true;
          writes--;
          writeBytes -= bytes.length;
          if (error) fail('write');
          resume(error ? Effect.fail(LspFault.make({code: 'write'})) : Effect.void);
        };
        try {
          child!.stdin!.write(bytes, complete);
        } catch {
          complete(new Error('Provider write failed'));
        }
      }).pipe(
        Effect.timeoutOption(2000),
        Effect.flatMap(result =>
          Effect.fromOption(result).pipe(
            Effect.mapError(() => {
              fail('write');
              return fault!;
            }),
          ),
        ),
      ),
    finish,
  } satisfies LspWire;
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
