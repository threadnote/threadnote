import {Array as EffectArray} from 'effect';
import {Cause, Effect, Exit, Layer, Option, Predicate, Schema, Semaphore, Stream} from 'effect';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {parseLocalModelManifest} from '@threadnote/inference/models/catalog';
import {
  EmbeddingFailed,
  GenerationFailed,
  InferenceInterrupted,
  InsufficientMemory,
  InvalidModelOutput,
  ModelLoadFailed,
  ModelNotInstalled,
  NativeRuntimeUnavailable,
  RerankingFailed,
  UnsupportedNativeRuntime,
} from '@threadnote/inference/engine/errors';
import {
  LocalModelRuntime,
  type LocalEmbeddingRequest,
  type LocalGenerationRequest,
  type LocalModelRuntimeShape,
  type LocalRerankingRequest,
} from '@threadnote/inference/engine/local-model-runtime';
import type {LlamaCppDiagnostics} from '@threadnote/inference/engine/llama-cpp-engine';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {withThreadnoteProcessActivity} from '../../process/diagnostics.js';
import {LOCAL_MODEL_WORKER_ARGUMENT} from '../../worker_protocol.js';
import {withAnonymousTelemetryPhase} from '../telemetry.js';
import {attachAnonymousTelemetryDiagnostic} from '../../telemetry/diagnostic.js';
import {withCurrentAgentSessionEnvironment} from '../../telemetry/session.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export {LOCAL_MODEL_WORKER_ARGUMENT};

const DEFAULT_REQUEST_DEADLINE_MS = 120_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 32 * 1024;
export const DEFAULT_LOCAL_MODEL_WORKER_IDLE_TIMEOUT_MS = 5 * 60_000;
export const LOCAL_MODEL_WORKER_IDLE_TIMEOUT_ENV = 'THREADNOTE_LOCAL_MODEL_WORKER_IDLE_TIMEOUT_MS';
const LOCAL_MODEL_PROCESS_ACTIVITY_IDLE_DELAY_MS = 250;
const WORKER_SHUTDOWN_DEADLINE_MS = 1_000;
const EMBEDDING_BATCH_SIZE = 32;
const PROTOCOL_VERSION = 1;
const WORKER_CRASH_PATTERN =
  /(?:bun has crashed|panic(?:\([^)]*\))?:|segmentation fault|fatal error:|reached heap limit|allocation failed)/i;

type WorkerOperation = 'diagnostics' | 'embedMany' | 'generate' | 'rerank';
type WorkerFailureReason = 'crash' | 'exit' | 'protocol' | 'spawn' | 'timeout' | 'write';

interface WorkerRequest {
  readonly id: string;
  readonly operation: WorkerOperation;
  readonly payload: unknown;
  readonly protocol: typeof PROTOCOL_VERSION;
}

interface WorkerSuccess {
  readonly id: string;
  readonly ok: true;
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly result: unknown;
}

interface WorkerFailure {
  readonly error: {
    readonly tag: string;
  };
  readonly id: string;
  readonly ok: false;
  readonly protocol: typeof PROTOCOL_VERSION;
}

type WorkerResponse = WorkerFailure | WorkerSuccess;

export class LocalModelWorkerTransportError extends Schema.TaggedError<
  LocalModelWorkerTransportError,
  {readonly brand: unique symbol}
>()('LocalModelWorkerTransportError', {
  message: Schema.String,
  operation: Schema.String,
  reason: Schema.Literals(['crash', 'exit', 'protocol', 'spawn', 'timeout', 'write']),
}) {}

export interface LocalModelWorkerProcess {
  readonly closeInput: () => Promise<void> | void;
  readonly exited: Promise<number>;
  readonly kill: () => void;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly write: (line: string) => Promise<void> | void;
}

export interface LocalModelWorkerSpawnOptions {
  readonly arguments: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly executable: string;
}

export type LocalModelWorkerSpawner = (
  options: LocalModelWorkerSpawnOptions,
) => LocalModelWorkerProcess | Promise<LocalModelWorkerProcess>;

export interface IsolatedLocalModelRuntimeOptions {
  /** Milliseconds to keep an unused native worker resident. Set to 0 to disable idle eviction. */
  readonly idleTimeoutMs?: number;
  readonly maxStderrBytes?: number;
  readonly responseLimitBytes?: number;
  readonly requestDeadlineMs?: number;
  /** Background workers persist retries in their durable demand instead. Defaults to 2. */
  readonly maximumRequestAttempts?: 1 | 2;
  readonly spawnWorker?: LocalModelWorkerSpawner;
}

interface LocalModelRuntimeWithDiagnostics extends LocalModelRuntimeShape {
  readonly diagnostics: Effect.Effect<LlamaCppDiagnostics, NativeRuntimeUnavailable | UnsupportedNativeRuntime>;
}

interface PendingResponse {
  readonly id: string;
  readonly operation: WorkerOperation;
  readonly reject: (error: LocalModelWorkerTransportError) => void;
  readonly resolve: (response: WorkerResponse) => void;
}

interface DecodedOperationError {
  readonly tag: string;
}

/**
 * Runs local inference in one persistent child process. A native crash can take
 * down the worker, but not the Threadnote CLI or MCP server that owns this
 * layer.
 */
export function isolatedLocalModelRuntimeLayer(
  options: IsolatedLocalModelRuntimeOptions = {},
): Layer.Layer<LocalModelRuntime, never, SystemInfo> {
  return Layer.effect(
    LocalModelRuntime,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        const permits = yield* Semaphore.make(1);
        const pool = new LocalModelWorkerPool(system, options);

        const request = <A>(
          operation: WorkerOperation,
          payload: unknown,
          decode: (result: unknown) => Option.Option<A>,
        ): Effect.Effect<A, DecodedOperationError | LocalModelWorkerTransportError> => {
          const transmitted: Effect.Effect<WorkerResponse, LocalModelWorkerTransportError> = Effect.tryPromise({
            try: signal => pool.request(operation, payload, signal),
            catch: (cause): LocalModelWorkerTransportError =>
              Schema.is(LocalModelWorkerTransportError)(cause) ? cause : transportError(operation, 'protocol'),
          });
          return Effect.gen(function* () {
            const response = yield* transmitted;
            if (!response.ok) return yield* Effect.fail<DecodedOperationError>(response.error);
            const result = decode(response.result);
            return Option.isSome(result) ? result.value : yield* transportError(operation, 'protocol');
          });
        };

        const service: LocalModelRuntimeWithDiagnostics = {
          diagnostics: withAnonymousTelemetryPhase(
            'model.diagnostics',
            permits.withPermit(
              request('diagnostics', {}, decodeDiagnostics).pipe(
                Effect.mapError(error =>
                  Schema.is(LocalModelWorkerTransportError)(error)
                    ? withWorkerTransportDiagnostic(
                        NativeRuntimeUnavailable.make({
                          cause: genericWorkerCause(error.reason),
                          message: `The isolated local AI worker could not report runtime diagnostics: ${error.message}`,
                        }),
                        error,
                      )
                    : remoteNativeRuntimeError(error),
                ),
              ),
            ),
          ),
          embedMany: input =>
            withAnonymousTelemetryPhase(
              'model.embedding',
              permits.withPermit(
                Effect.gen(function* () {
                  const vectors: (readonly number[])[] = [];
                  for (let start = 0; start < input.inputs.length; start += EMBEDDING_BATCH_SIZE) {
                    const batch = input.inputs.slice(start, start + EMBEDDING_BATCH_SIZE);
                    const response = yield* request('embedMany', {...input, inputs: batch}, result =>
                      decodeVectors(result, batch.length, input.manifest.dimensions),
                    ).pipe(
                      Effect.mapError(error =>
                        Schema.is(LocalModelWorkerTransportError)(error)
                          ? workerEmbeddingFailure(input, error)
                          : remoteEmbeddingFailure(input, error),
                      ),
                    );
                    vectors.push(...response);
                  }
                  return vectors;
                }),
              ),
            ),
          generate: input =>
            withAnonymousTelemetryPhase(
              'model.generation',
              permits.withPermit(
                request('generate', input, result => Option.some(result)).pipe(
                  Effect.mapError(error =>
                    Schema.is(LocalModelWorkerTransportError)(error)
                      ? workerGenerationFailure(input, error)
                      : remoteGenerationFailure(input, error),
                  ),
                ),
              ),
            ),
          rerank: input =>
            withAnonymousTelemetryPhase(
              'model.reranking',
              permits.withPermit(
                request('rerank', input, result => decodeScores(result, input.documents.length)).pipe(
                  Effect.mapError(error =>
                    Schema.is(LocalModelWorkerTransportError)(error)
                      ? workerRerankingFailure(input, error)
                      : remoteRerankingFailure(input, error),
                  ),
                ),
              ),
            ),
        };
        return {pool, service};
      }),
      ({pool}) => Effect.promise(() => pool.close()),
    ).pipe(Effect.map(({service}) => service)),
  );
}

/**
 * JSON-lines worker server. The caller normally supplies
 * `LocalModelRuntime.nativeLayer`, which keeps native model sessions warm for
 * the lifetime of this effect.
 */
export const localModelWorkerServer: Effect.Effect<void, never, LocalModelRuntime> = Effect.gen(function* () {
  const runtime = yield* LocalModelRuntime;
  yield* serveWorker(runtime, {
    input: process.stdin as AsyncIterable<string | Uint8Array>,
    writeLine: line => {
      const {promise, reject, resolve} = Promise.withResolvers<void>();
      process.stdout.write(`${line}\n`, error => (error ? reject(error) : resolve()));
      return promise;
    },
  }).pipe(
    Effect.ignore,
    Effect.ensuring(
      Effect.sync(() => {
        if (!process.stdin.destroyed) process.stdin.pause();
      }),
    ),
  );
});

export interface LocalModelWorkerServerIo {
  readonly input: AsyncIterable<string | Uint8Array>;
  readonly writeLine: (line: string) => Promise<void>;
}

class LocalModelWorkerServerError extends Schema.TaggedError<
  LocalModelWorkerServerError,
  {readonly brand: unique symbol}
>()('LocalModelWorkerServerError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export function serveWorker(
  runtime: LocalModelRuntimeShape,
  io: LocalModelWorkerServerIo,
): Effect.Effect<void, LocalModelWorkerServerError> {
  const decoder = new TextDecoder();
  let buffered = '';
  const writeResponse = (line: string) =>
    handleWorkerLine(runtime, line).pipe(
      Effect.flatMap(response =>
        Effect.tryPromise({
          try: () => io.writeLine(JSON.stringify(response)),
          catch: cause =>
            LocalModelWorkerServerError.make({
              cause,
              message: 'Could not write local model worker response.',
            }),
        }),
      ),
    );
  const consumeChunk = (chunk: string | Uint8Array) =>
    Effect.gen(function* () {
      buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true});
      for (;;) {
        const newline = Effect2.pipe(
          buffered,
          EffectString.indexOf('\n'),
          Effect2.Option.getOrElse(() => -1),
        );
        if (newline < 0) break;
        const line = Effect2.pipe(buffered, EffectString.slice(0, newline), EffectString.replace(/\r$/, ''));
        buffered = Effect2.pipe(buffered, EffectString.slice(newline + 1));
        if (!line) continue;
        yield* writeResponse(line);
      }
    });
  return Stream.fromAsyncIterable(io.input, cause =>
    LocalModelWorkerServerError.make({
      cause,
      message: 'Could not read local model worker input.',
    }),
  ).pipe(
    Stream.runForEach(consumeChunk),
    Effect.andThen(
      Effect.gen(function* () {
        buffered += decoder.decode();
        const finalLine = Effect2.pipe(buffered, EffectString.trim);
        if (finalLine) yield* writeResponse(finalLine);
      }),
    ),
  );
}

class LocalModelWorkerPool {
  private activeRequests = 0;
  private closed = false;
  private connection = Option.none<LocalModelWorkerConnection>();
  private readonly deadlineMs: number;
  private readonly maximumRequestAttempts: number;
  private evictingConnection: Promise<void> | undefined;
  private idleGeneration = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleTimeoutMs: number;
  private readonly maxStderrBytes: number;
  private readonly responseLimitBytes: number;
  private spawningConnection: Promise<LocalModelWorkerConnection> | undefined;
  private readonly spawnWorker: LocalModelWorkerSpawner;
  private sequence = 0;

  constructor(
    private readonly system: SystemInfoShape,
    options: IsolatedLocalModelRuntimeOptions,
  ) {
    this.maximumRequestAttempts = options.maximumRequestAttempts ?? 2;
    this.deadlineMs = positiveInteger(options.requestDeadlineMs, DEFAULT_REQUEST_DEADLINE_MS);
    this.idleTimeoutMs = nonNegativeInteger(
      options.idleTimeoutMs ?? parseInteger(system.environment()[LOCAL_MODEL_WORKER_IDLE_TIMEOUT_ENV]),
      DEFAULT_LOCAL_MODEL_WORKER_IDLE_TIMEOUT_MS,
    );
    this.maxStderrBytes = positiveInteger(options.maxStderrBytes, DEFAULT_STDERR_LIMIT_BYTES);
    this.responseLimitBytes = positiveInteger(options.responseLimitBytes, DEFAULT_RESPONSE_LIMIT_BYTES);
    this.spawnWorker = options.spawnWorker ?? spawnBunWorker;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelIdleEviction();
    await this.evictingConnection?.catch(() => undefined);
    const spawning = this.spawningConnection;
    if (spawning) {
      const connection = await spawning.catch(() => undefined);
      if (connection && (Option.isNone(this.connection) || this.connection.value !== connection)) {
        await connection.close();
      }
    }
    if (Option.isNone(this.connection)) return;
    const connection = this.connection.value;
    this.connection = Option.none();
    await connection.close();
  }

  async request(operation: WorkerOperation, payload: unknown, signal: AbortSignal): Promise<WorkerResponse> {
    if (this.closed) throw transportError(operation, 'exit');
    this.activeRequests += 1;
    this.cancelIdleEviction();
    try {
      for (let attempt = 0; attempt < this.maximumRequestAttempts; attempt += 1) {
        let connection = Option.none<LocalModelWorkerConnection>();
        try {
          const activeConnection = await this.activeConnection(operation);
          connection = Option.some(activeConnection);
          const id = `${this.system.processId}-${++this.sequence}`;
          return await activeConnection.request(
            {
              id,
              operation,
              payload,
              protocol: PROTOCOL_VERSION,
            },
            this.deadlineMs,
            signal,
          );
        } catch (cause: unknown) {
          if (Option.isSome(connection)) await this.discard(connection.value);
          if (
            !Schema.is(LocalModelWorkerTransportError)(cause) ||
            attempt + 1 === this.maximumRequestAttempts ||
            signal.aborted
          )
            throw cause;
        }
      }
      throw transportError(operation, 'exit');
    } finally {
      this.activeRequests -= 1;
      this.scheduleIdleEviction();
    }
  }

  private async activeConnection(operation: WorkerOperation): Promise<LocalModelWorkerConnection> {
    if (this.closed) throw transportError(operation, 'exit');
    if (Option.isSome(this.connection) && !this.connection.value.isClosed) return this.connection.value;
    const eviction = this.evictingConnection;
    if (eviction) await eviction.catch(() => undefined);
    if (this.closed) throw transportError(operation, 'exit');
    if (Option.isSome(this.connection) && !this.connection.value.isClosed) return this.connection.value;
    if (this.spawningConnection) return this.spawningConnection;
    const spawning = this.spawnConnection(operation);
    this.spawningConnection = spawning;
    try {
      return await spawning;
    } finally {
      if (this.spawningConnection === spawning) this.spawningConnection = undefined;
    }
  }

  private async spawnConnection(operation: WorkerOperation): Promise<LocalModelWorkerConnection> {
    try {
      const process = await this.spawnWorker(localModelWorkerSpawnOptions(this.system));
      const connection = new LocalModelWorkerConnection(process, this.maxStderrBytes, this.responseLimitBytes);
      if (this.closed) {
        await connection.close();
        throw transportError(operation, 'exit');
      }
      this.connection = Option.some(connection);
      return connection;
    } catch (cause: unknown) {
      if (Schema.is(LocalModelWorkerTransportError)(cause)) throw cause;
      throw transportError(operation, 'spawn');
    }
  }

  private async discard(connection: LocalModelWorkerConnection): Promise<void> {
    if (Option.isSome(this.connection) && this.connection.value === connection) this.connection = Option.none();
    await connection.close();
  }

  private cancelIdleEviction(): void {
    this.idleGeneration += 1;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleEviction(): void {
    if (this.closed || this.idleTimeoutMs === 0 || this.activeRequests !== 0 || Option.isNone(this.connection)) {
      return;
    }
    const connection = this.connection.value;
    const generation = ++this.idleGeneration;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (
        this.closed ||
        this.activeRequests !== 0 ||
        generation !== this.idleGeneration ||
        Option.isNone(this.connection) ||
        this.connection.value !== connection
      ) {
        return;
      }
      this.connection = Option.none();
      const eviction = connection.close();
      this.evictingConnection = eviction;
      const clearEviction = () => {
        if (this.evictingConnection === eviction) this.evictingConnection = undefined;
      };
      void eviction.then(clearEviction, clearEviction);
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }
}

class LocalModelWorkerConnection {
  private closed = false;
  private pending = Option.none<PendingResponse>();
  private stderrTail = new Uint8Array();
  private stdoutBuffer = '';
  private stdoutBufferBytes = 0;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly process: LocalModelWorkerProcess,
    private readonly maxStderrBytes: number,
    private readonly responseLimitBytes: number,
  ) {
    void this.consumeStdout();
    void this.consumeStderr();
    void process.exited.then(
      () => this.fail('exit'),
      () => this.fail('exit'),
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) {
      this.kill();
      void Promise.resolve()
        .then(() => this.process.closeInput())
        .catch(() => undefined);
      return;
    }
    this.closed = true;
    this.rejectPending('exit');
    const closedGracefully = await completesBeforeDeadline(
      Promise.resolve()
        .then(() => this.process.closeInput())
        .then(() => this.process.exited),
      WORKER_SHUTDOWN_DEADLINE_MS,
    );
    if (!closedGracefully) this.kill();
  }

  async request(request: WorkerRequest, deadlineMs: number, signal: AbortSignal): Promise<WorkerResponse> {
    if (this.closed) throw transportError(request.operation, 'exit');
    if (Option.isSome(this.pending)) throw transportError(request.operation, 'protocol');
    if (signal.aborted) {
      this.fail('exit');
      throw transportError(request.operation, 'exit');
    }

    let removeAbortListener = () => {};
    const {promise: response, reject, resolve} = Promise.withResolvers<WorkerResponse>();
    this.pending = Option.some({
      id: request.id,
      operation: request.operation,
      reject,
      resolve,
    });
    const timeout = setTimeout(() => this.fail('timeout'), deadlineMs);
    const onAbort = () => this.fail('exit');
    signal.addEventListener('abort', onAbort, {once: true});
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);

    try {
      void Promise.resolve(this.process.write(`${JSON.stringify(request)}\n`)).catch(() => this.fail('write'));
    } catch {
      this.fail('write');
    }

    return response.finally(() => {
      clearTimeout(timeout);
      removeAbortListener();
    });
  }

  private async consumeStderr(): Promise<void> {
    try {
      for await (const chunk of this.process.stderr) {
        const bytes = typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk;
        const currentText = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        this.appendStderr(bytes);
        if (
          WORKER_CRASH_PATTERN.test(currentText) ||
          WORKER_CRASH_PATTERN.test(new TextDecoder().decode(this.stderrTail))
        ) {
          this.fail('crash');
          return;
        }
      }
    } catch {
      this.fail('exit');
    }
  }

  private async consumeStdout(): Promise<void> {
    try {
      for await (const chunk of this.process.stdout) {
        const decoded = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, {stream: true});
        this.stdoutBuffer += decoded;
        this.stdoutBufferBytes += typeof chunk === 'string' ? this.encoder.encode(chunk).byteLength : chunk.byteLength;
        if (this.stdoutBufferBytes > this.responseLimitBytes) {
          this.fail('protocol');
          return;
        }
        this.consumeStdoutLines();
        if (Effect2.pipe(decoded, EffectString.includes('\n'))) {
          this.stdoutBufferBytes = this.encoder.encode(this.stdoutBuffer).byteLength;
        }
      }
      this.stdoutBuffer += this.decoder.decode();
      this.consumeStdoutLines();
      if (Effect2.pipe(this.stdoutBuffer, EffectString.trim)) this.fail('protocol');
      else this.fail('exit');
    } catch {
      this.fail('exit');
    }
  }

  private consumeStdoutLines(): void {
    for (;;) {
      const newline = Effect2.pipe(
        this.stdoutBuffer,
        EffectString.indexOf('\n'),
        Effect2.Option.getOrElse(() => -1),
      );
      if (newline < 0) return;
      const line = Effect2.pipe(this.stdoutBuffer, EffectString.slice(0, newline), EffectString.replace(/\r$/, ''));
      this.stdoutBuffer = Effect2.pipe(this.stdoutBuffer, EffectString.slice(newline + 1));
      if (!line) continue;
      const pending = this.pending;
      if (Option.isNone(pending)) {
        this.fail('protocol');
        return;
      }
      const response = decodeWorkerResponse(line);
      if (Option.isNone(response) || response.value.id !== pending.value.id) {
        this.fail(WORKER_CRASH_PATTERN.test(line) ? 'crash' : 'protocol');
        return;
      }
      this.pending = Option.none();
      pending.value.resolve(response.value);
    }
  }

  private appendStderr(chunk: Uint8Array): void {
    if (this.maxStderrBytes <= 0) {
      this.stderrTail = new Uint8Array();
      return;
    }
    if (chunk.byteLength >= this.maxStderrBytes) {
      this.stderrTail = chunk.slice(chunk.byteLength - this.maxStderrBytes);
      return;
    }
    const retained = Math.min(this.stderrTail.byteLength, this.maxStderrBytes - chunk.byteLength);
    const merged = new Uint8Array(retained + chunk.byteLength);
    merged.set(this.stderrTail.slice(this.stderrTail.byteLength - retained), 0);
    merged.set(chunk, retained);
    this.stderrTail = merged;
  }

  private fail(reason: WorkerFailureReason): void {
    if (!this.closed) {
      this.closed = true;
      this.rejectPending(reason);
      this.kill();
    }
  }

  private kill(): void {
    try {
      this.process.kill();
    } catch {
      // A native crash can close the process before its pipes settle.
    }
  }

  private rejectPending(reason: WorkerFailureReason): void {
    if (Option.isNone(this.pending)) return;
    const pending = this.pending.value;
    this.pending = Option.none();
    pending.reject(transportError(pending.operation, reason));
  }
}

function spawnBunWorker(options: LocalModelWorkerSpawnOptions): LocalModelWorkerProcess {
  const child = Bun.spawn({
    cmd: [options.executable, ...options.arguments],
    env: {...options.environment},
    stdin: 'pipe',
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const input = child.stdin;
  return {
    closeInput: async () => {
      await input.end();
    },
    exited: child.exited,
    kill: () => child.kill('SIGKILL'),
    stderr: child.stderr as ReadableStream<Uint8Array>,
    stdout: child.stdout as ReadableStream<Uint8Array>,
    write: async line => {
      await input.write(line);
      await input.flush();
    },
  };
}

export function localModelWorkerSpawnOptions(system: SystemInfoShape): LocalModelWorkerSpawnOptions {
  const script = developmentStandaloneScript(system);
  return {
    arguments: [...Option.toArray(script), LOCAL_MODEL_WORKER_ARGUMENT],
    environment: {
      ...withCurrentAgentSessionEnvironment(system.environment(), 'local-model-worker'),
      THREADNOTE_LOCAL_MODEL_WORKER: '1',
    },
    executable: system.executablePath,
  };
}

function developmentStandaloneScript(system: SystemInfoShape): Option.Option<string> {
  const executableName = Effect2.pipe(
    system.executablePath,
    EffectString.replaceAll('\\', '/'),
    EffectString.split('/'),
  ).at(-1);
  if (executableName !== 'bun' && executableName !== 'bun.exe') return Option.none();
  const candidate = system.processArguments[1];
  if (
    candidate &&
    /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/i.test(candidate) &&
    candidate !== LOCAL_MODEL_WORKER_ARGUMENT
  ) {
    return Option.some(candidate);
  }
  // Evaluation and development scripts use ApplicationLayer without running
  // through standalone.ts themselves. Point Bun at the source entrypoint so
  // the isolated worker receives the worker argument instead of Bun treating
  // it as an unknown top-level command and printing help on protocol stdout.
  return Option.some(Bun.fileURLToPath(new URL('../../standalone.ts', import.meta.url)));
}

function handleWorkerLine(runtime: LocalModelRuntimeShape, line: string): Effect.Effect<WorkerResponse> {
  const request = decodeWorkerRequest(line);
  if (Option.isNone(request)) return Effect.succeed(protocolFailure('invalid'));
  const effect = withThreadnoteProcessActivity(
    'local-model-worker',
    workerOperationLabel(request.value.operation),
    dispatchWorkerRequest(runtime, request.value),
    {idleTransitionDelayMilliseconds: LOCAL_MODEL_PROCESS_ACTIVITY_IDLE_DELAY_MS},
  );
  return Effect.exit(effect).pipe(
    Effect.map(exit => {
      if (Exit.isSuccess(exit)) {
        return {
          id: request.value.id,
          ok: true,
          protocol: PROTOCOL_VERSION,
          result: exit.value,
        } satisfies WorkerResponse;
      }
      const failure = Cause.findErrorOption(exit.cause);
      return {
        error: {
          tag: Option.isSome(failure) ? operationErrorTag(failure.value) : 'WorkerOperationFailed',
        },
        id: request.value.id,
        ok: false,
        protocol: PROTOCOL_VERSION,
      } satisfies WorkerResponse;
    }),
  );
}

function workerOperationLabel(operation: string): string {
  return operation === 'embedMany' ? 'embed-many' : operation;
}

function dispatchWorkerRequest(
  runtime: LocalModelRuntimeShape,
  request: WorkerRequest,
): Effect.Effect<unknown, unknown> {
  if (request.operation === 'diagnostics') {
    const diagnostics = (runtime as Partial<LocalModelRuntimeWithDiagnostics>).diagnostics;
    return diagnostics ?? Effect.fail({_tag: 'NativeRuntimeUnavailable'});
  }
  if (request.operation === 'embedMany') {
    const decoded = decodeEmbeddingRequest(request.payload);
    return Option.isSome(decoded) ? runtime.embedMany(decoded.value) : Effect.fail({_tag: 'WorkerProtocolInvalid'});
  }
  if (request.operation === 'generate') {
    const decoded = decodeGenerationRequest(request.payload);
    return Option.isSome(decoded) ? runtime.generate(decoded.value) : Effect.fail({_tag: 'WorkerProtocolInvalid'});
  }
  const decoded = decodeRerankingRequest(request.payload);
  return Option.isSome(decoded) ? runtime.rerank(decoded.value) : Effect.fail({_tag: 'WorkerProtocolInvalid'});
}

function decodeWorkerRequest(line: string): Option.Option<WorkerRequest> {
  const parsedOption = parseJson(line);
  if (Option.isNone(parsedOption)) return Option.none();
  const parsed = parsedOption.value;
  if (
    !Predicate.isObject(parsed) ||
    parsed.protocol !== PROTOCOL_VERSION ||
    typeof parsed.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(parsed.id) ||
    !isWorkerOperation(parsed.operation) ||
    !('payload' in parsed)
  ) {
    return Option.none();
  }
  return Option.some({
    id: parsed.id,
    operation: parsed.operation,
    payload: parsed.payload,
    protocol: PROTOCOL_VERSION,
  });
}

function decodeWorkerResponse(line: string): Option.Option<WorkerResponse> {
  const parsedOption = parseJson(line);
  if (Option.isNone(parsedOption)) return Option.none();
  const parsed = parsedOption.value;
  if (
    !Predicate.isObject(parsed) ||
    parsed.protocol !== PROTOCOL_VERSION ||
    typeof parsed.id !== 'string' ||
    typeof parsed.ok !== 'boolean'
  ) {
    return Option.none();
  }
  if (parsed.ok) {
    return 'result' in parsed
      ? Option.some({
          id: parsed.id,
          ok: true,
          protocol: PROTOCOL_VERSION,
          result: parsed.result,
        })
      : Option.none();
  }
  if (!Predicate.isObject(parsed.error) || typeof parsed.error.tag !== 'string') return Option.none();
  return Option.some({
    error: {tag: parsed.error.tag},
    id: parsed.id,
    ok: false,
    protocol: PROTOCOL_VERSION,
  });
}

function decodeEmbeddingRequest(value: unknown): Option.Option<LocalEmbeddingRequest> {
  if (!Predicate.isObject(value) || !isStringArray(value.inputs) || typeof value.modelPath !== 'string')
    return Option.none();
  const embeddingContextPoolSize = value.embeddingContextPoolSize;
  if (
    embeddingContextPoolSize !== undefined &&
    embeddingContextPoolSize !== 1 &&
    embeddingContextPoolSize !== 2 &&
    embeddingContextPoolSize !== 4 &&
    embeddingContextPoolSize !== 8
  ) {
    return Option.none();
  }
  const manifest = decodeManifest(value.manifest);
  return Option.isSome(manifest)
    ? Option.some({
        ...(embeddingContextPoolSize === undefined ? {} : {embeddingContextPoolSize}),
        inputs: value.inputs,
        manifest: manifest.value,
        modelPath: value.modelPath,
      })
    : Option.none();
}

function decodeGenerationRequest(value: unknown): Option.Option<LocalGenerationRequest> {
  if (
    !Predicate.isObject(value) ||
    !Predicate.isObject(value.jsonSchema) ||
    typeof value.maxTokens !== 'number' ||
    !Number.isSafeInteger(value.maxTokens) ||
    value.maxTokens <= 0 ||
    typeof value.modelPath !== 'string' ||
    typeof value.prompt !== 'string' ||
    (value.seed !== undefined && (typeof value.seed !== 'number' || !Number.isSafeInteger(value.seed))) ||
    (value.system !== undefined && typeof value.system !== 'string')
  ) {
    return Option.none();
  }
  const manifest = decodeManifest(value.manifest);
  return Option.isSome(manifest)
    ? Option.some({
        jsonSchema: value.jsonSchema,
        manifest: manifest.value,
        maxTokens: value.maxTokens,
        modelPath: value.modelPath,
        prompt: value.prompt,
        ...(typeof value.seed === 'number' ? {seed: value.seed} : {}),
        ...(typeof value.system === 'string' ? {system: value.system} : {}),
      })
    : Option.none();
}

function decodeRerankingRequest(value: unknown): Option.Option<LocalRerankingRequest> {
  if (
    !Predicate.isObject(value) ||
    !isStringArray(value.documents) ||
    typeof value.modelPath !== 'string' ||
    typeof value.query !== 'string'
  ) {
    return Option.none();
  }
  const manifest = decodeManifest(value.manifest);
  return Option.isSome(manifest)
    ? Option.some({
        documents: value.documents,
        manifest: manifest.value,
        modelPath: value.modelPath,
        query: value.query,
      })
    : Option.none();
}

function decodeManifest(value: unknown): Option.Option<LocalModelManifest> {
  try {
    return Option.some(parseLocalModelManifest(value));
  } catch {
    return Option.none();
  }
}

function decodeVectors(
  value: unknown,
  expectedCount: number,
  expectedDimensions: number | undefined,
): Option.Option<readonly (readonly number[])[]> {
  if (!EffectArray.isArray(value) || value.length !== expectedCount) return Option.none();
  const vectors: number[][] = [];
  for (const vector of value) {
    if (!EffectArray.isArray(vector) || (expectedDimensions !== undefined && vector.length !== expectedDimensions)) {
      return Option.none();
    }
    const coordinates: number[] = [];
    for (const coordinate of vector) {
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) return Option.none();
      coordinates.push(coordinate);
    }
    vectors.push(coordinates);
  }
  return Option.some(vectors);
}

function decodeScores(value: unknown, expectedCount: number): Option.Option<readonly number[]> {
  if (!EffectArray.isArray(value) || value.length !== expectedCount) return Option.none();
  const scores: number[] = [];
  for (const score of value) {
    if (typeof score !== 'number' || !Number.isFinite(score)) return Option.none();
    scores.push(score);
  }
  return Option.some(scores);
}

function decodeDiagnostics(value: unknown): Option.Option<LlamaCppDiagnostics> {
  if (
    !Predicate.isObject(value) ||
    typeof value.backend !== 'string' ||
    (value.buildType !== 'prebuilt' && value.buildType !== 'localBuild') ||
    typeof value.cpuMathCores !== 'number' ||
    !Number.isSafeInteger(value.cpuMathCores) ||
    value.cpuMathCores <= 0
  ) {
    return Option.none();
  }
  const embeddingContextPlan = decodeEmbeddingContextPlanDiagnostics(value.embeddingContextPlan);
  if (value.embeddingContextPlan !== undefined && Option.isNone(embeddingContextPlan)) return Option.none();
  return Option.some({
    backend: value.backend,
    buildType: value.buildType,
    cpuMathCores: value.cpuMathCores,
    ...(Option.isSome(embeddingContextPlan) ? {embeddingContextPlan: embeddingContextPlan.value} : {}),
  });
}

function decodeEmbeddingContextPlanDiagnostics(
  value: unknown,
): Option.Option<NonNullable<LlamaCppDiagnostics['embeddingContextPlan']>> {
  if (value === undefined) return Option.none();
  if (
    !Predicate.isObject(value) ||
    !isEmbeddingContextCount(value.requestedContexts) ||
    typeof value.effectiveContexts !== 'number' ||
    !Number.isSafeInteger(value.effectiveContexts) ||
    value.effectiveContexts < 1 ||
    value.effectiveContexts > value.requestedContexts ||
    (value.modelGpuLayers !== undefined &&
      (typeof value.modelGpuLayers !== 'number' ||
        !Number.isSafeInteger(value.modelGpuLayers) ||
        value.modelGpuLayers < 0)) ||
    !EffectArray.isArray(value.threadCounts)
  ) {
    return Option.none();
  }
  const threadCounts: number[] = [];
  for (const threads of value.threadCounts) {
    if (typeof threads !== 'number' || !Number.isSafeInteger(threads) || threads <= 0) return Option.none();
    threadCounts.push(threads);
  }
  if (threadCounts.length !== value.effectiveContexts && (value.effectiveContexts !== 1 || threadCounts.length !== 0)) {
    return Option.none();
  }
  return Option.some({
    effectiveContexts: value.effectiveContexts,
    ...(value.modelGpuLayers === undefined ? {} : {modelGpuLayers: value.modelGpuLayers}),
    requestedContexts: value.requestedContexts,
    threadCounts,
  });
}

function isEmbeddingContextCount(value: unknown): value is number {
  return typeof value === 'number' && [1, 2, 4, 8].includes(value);
}

function remoteEmbeddingFailure(
  request: LocalEmbeddingRequest,
  error: DecodedOperationError,
):
  | EmbeddingFailed
  | InferenceInterrupted
  | InsufficientMemory
  | ModelLoadFailed
  | ModelNotInstalled
  | NativeRuntimeUnavailable
  | UnsupportedNativeRuntime {
  const common = remoteModelError(request.manifest.id, request.modelPath, 'embedding', error);
  return Option.isSome(common)
    ? common.value
    : EmbeddingFailed.make({
        cause: genericWorkerCause('protocol'),
        message: 'Local AI embedding failed in the isolated worker.',
        modelId: request.manifest.id,
      });
}

function remoteGenerationFailure(
  request: LocalGenerationRequest,
  error: DecodedOperationError,
):
  | GenerationFailed
  | InferenceInterrupted
  | InsufficientMemory
  | InvalidModelOutput
  | ModelLoadFailed
  | ModelNotInstalled
  | NativeRuntimeUnavailable
  | UnsupportedNativeRuntime {
  const common = remoteModelError(request.manifest.id, request.modelPath, 'generation', error);
  if (Option.isSome(common)) return common.value;
  if (error.tag === 'InvalidModelOutput') {
    return InvalidModelOutput.make({
      message: 'The isolated local AI worker returned invalid structured output.',
      modelId: request.manifest.id,
    });
  }
  return GenerationFailed.make({
    cause: genericWorkerCause('protocol'),
    message: 'Local AI generation failed in the isolated worker.',
    modelId: request.manifest.id,
  });
}

function remoteRerankingFailure(
  request: LocalRerankingRequest,
  error: DecodedOperationError,
):
  | InferenceInterrupted
  | InsufficientMemory
  | ModelLoadFailed
  | ModelNotInstalled
  | NativeRuntimeUnavailable
  | RerankingFailed
  | UnsupportedNativeRuntime {
  const common = remoteModelError(request.manifest.id, request.modelPath, 'reranking', error);
  return Option.isSome(common)
    ? common.value
    : RerankingFailed.make({
        cause: genericWorkerCause('protocol'),
        message: 'Local AI reranking failed in the isolated worker.',
        modelId: request.manifest.id,
      });
}

function remoteModelError(
  modelId: string,
  modelPath: string,
  operation: string,
  error: DecodedOperationError,
): Option.Option<
  | InferenceInterrupted
  | InsufficientMemory
  | ModelLoadFailed
  | ModelNotInstalled
  | NativeRuntimeUnavailable
  | UnsupportedNativeRuntime
> {
  if (error.tag === 'InferenceInterrupted') {
    return Option.some(
      InferenceInterrupted.make({
        message: `Local AI ${operation} was interrupted in the isolated worker.`,
        modelId,
        operation,
      }),
    );
  }
  if (error.tag === 'InsufficientMemory') {
    return Option.some(
      InsufficientMemory.make({
        cause: genericWorkerCause('protocol'),
        message: `The isolated local AI worker did not have enough memory for ${operation}.`,
        modelId,
      }),
    );
  }
  if (error.tag === 'ModelLoadFailed') {
    return Option.some(
      ModelLoadFailed.make({
        cause: genericWorkerCause('protocol'),
        message: `The isolated local AI worker could not load the model for ${operation}.`,
        modelId,
      }),
    );
  }
  if (error.tag === 'ModelNotInstalled') {
    return Option.some(
      ModelNotInstalled.make({
        message: `The local AI model required for ${operation} is not installed.`,
        modelId,
        path: modelPath,
      }),
    );
  }
  if (error.tag === 'NativeRuntimeUnavailable') {
    return Option.some(
      NativeRuntimeUnavailable.make({
        cause: genericWorkerCause('protocol'),
        message: 'The isolated local AI native runtime is unavailable.',
      }),
    );
  }
  if (error.tag === 'UnsupportedNativeRuntime') {
    return Option.some(
      UnsupportedNativeRuntime.make({
        cause: genericWorkerCause('protocol'),
        message: 'The isolated local AI native runtime is unsupported.',
      }),
    );
  }
  return Option.none();
}

function remoteNativeRuntimeError(error: DecodedOperationError): NativeRuntimeUnavailable | UnsupportedNativeRuntime {
  return error.tag === 'UnsupportedNativeRuntime'
    ? UnsupportedNativeRuntime.make({
        cause: genericWorkerCause('protocol'),
        message: 'The isolated local AI native runtime is unsupported.',
      })
    : NativeRuntimeUnavailable.make({
        cause: genericWorkerCause('protocol'),
        message: 'The isolated local AI native runtime is unavailable.',
      });
}

function workerEmbeddingFailure(
  request: LocalEmbeddingRequest,
  error: LocalModelWorkerTransportError,
): EmbeddingFailed {
  return withWorkerTransportDiagnostic(
    EmbeddingFailed.make({
      cause: genericWorkerCause(error.reason),
      message: `Local AI embedding failed after the isolated worker retry was exhausted: ${error.message}`,
      modelId: request.manifest.id,
    }),
    error,
  );
}

function workerGenerationFailure(
  request: LocalGenerationRequest,
  error: LocalModelWorkerTransportError,
): GenerationFailed {
  return withWorkerTransportDiagnostic(
    GenerationFailed.make({
      cause: genericWorkerCause(error.reason),
      message: `Local AI generation failed after the isolated worker retry was exhausted: ${error.message}`,
      modelId: request.manifest.id,
    }),
    error,
  );
}

function workerRerankingFailure(
  request: LocalRerankingRequest,
  error: LocalModelWorkerTransportError,
): RerankingFailed {
  return withWorkerTransportDiagnostic(
    RerankingFailed.make({
      cause: genericWorkerCause(error.reason),
      message: `Local AI reranking failed after the isolated worker retry was exhausted: ${error.message}`,
      modelId: request.manifest.id,
    }),
    error,
  );
}

function withWorkerTransportDiagnostic<A extends object>(
  error: A & {readonly _tag?: string},
  transport: LocalModelWorkerTransportError,
): A {
  return attachAnonymousTelemetryDiagnostic(error, {
    domain: 'model-worker',
    errorType: error._tag ?? 'LocalModelWorkerError',
    operation: workerOperationLabel(transport.operation),
    reason: transport.reason,
  });
}

function operationErrorTag(error: unknown): string {
  return Predicate.isObject(error) && isKnownOperationErrorTag(error._tag) ? error._tag : 'WorkerOperationFailed';
}

function protocolFailure(id: string): WorkerFailure {
  return {
    error: {tag: 'WorkerProtocolInvalid'},
    id,
    ok: false,
    protocol: PROTOCOL_VERSION,
  };
}

function transportError(operation: WorkerOperation, reason: WorkerFailureReason): LocalModelWorkerTransportError {
  return LocalModelWorkerTransportError.make({
    message: workerTransportMessage(operation, reason),
    operation,
    reason,
  });
}

function workerTransportMessage(operation: WorkerOperation, reason: WorkerFailureReason): string {
  if (reason === 'timeout') return `The isolated local AI worker timed out during ${operation}.`;
  if (reason === 'crash') return `The isolated local AI worker crashed during ${operation}.`;
  if (reason === 'spawn') return `The isolated local AI worker could not start for ${operation}.`;
  if (reason === 'write') return `The isolated local AI worker input closed during ${operation}.`;
  if (reason === 'protocol') return `The isolated local AI worker returned an invalid ${operation} response.`;
  return `The isolated local AI worker exited during ${operation}.`;
}

function genericWorkerCause(reason: WorkerFailureReason): Error {
  return new Error(`Isolated local AI worker ${reason}.`);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function completesBeforeDeadline(promise: Promise<unknown>, deadlineMs: number): Promise<boolean> {
  const {promise: result, resolve} = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), deadlineMs);
  timer.unref?.();
  void promise.then(
    () => {
      clearTimeout(timer);
      resolve(true);
    },
    () => {
      clearTimeout(timer);
      resolve(false);
    },
  );
  return result;
}

function parseJson(value: string): Option.Option<unknown> {
  try {
    return Option.some(JSON.parse(value) as unknown);
  } catch {
    return Option.none();
  }
}

function isStringArray(value: unknown): value is string[] {
  return EffectArray.isArray(value) && EffectArray.every(value, item => typeof item === 'string');
}

function isWorkerOperation(value: unknown): value is WorkerOperation {
  return value === 'diagnostics' || value === 'embedMany' || value === 'generate' || value === 'rerank';
}

function isKnownOperationErrorTag(value: unknown): value is string {
  return (
    value === 'AiError' ||
    value === 'EmbeddingFailed' ||
    value === 'GenerationFailed' ||
    value === 'InferenceInterrupted' ||
    value === 'InsufficientMemory' ||
    value === 'InvalidModelOutput' ||
    value === 'ModelLoadFailed' ||
    value === 'ModelNotInstalled' ||
    value === 'NativeRuntimeUnavailable' ||
    value === 'RerankingFailed' ||
    value === 'UnsupportedNativeRuntime' ||
    value === 'WorkerProtocolInvalid'
  );
}
