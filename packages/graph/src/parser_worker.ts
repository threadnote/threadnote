import {Array as EffectArray} from 'effect';
import {
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Queue,
  Stdio,
  Stream,
  Schema,
} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fromPromise, fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {
  cachedCodeGraphFactByteUpperBound,
  cachedCodeGraphFactBytes,
  CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
  serializeBoundedCodeGraphFact,
} from './fact/budget.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from './languages/registry.js';
import {TreeSitterRuntime, type TreeSitterRuntimeShape} from './tree_sitter/runtime.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from './types.js';
import {CODE_GRAPH_PARSER_WORKER_ARGUMENT} from '@threadnote/graph/worker_protocol';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export {CODE_GRAPH_PARSER_WORKER_ARGUMENT};
export const CODE_GRAPH_PARSER_WORKERS_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_WORKERS';
export const CODE_GRAPH_PARSER_TIMEOUT_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS';
export const CODE_GRAPH_PARSER_IDLE_TIMEOUT_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS';
export const CODE_GRAPH_PARSER_ALLOCATION_BYTES_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_ALLOCATION_BYTES_MAX';
export const CODE_GRAPH_PARSER_RSS_BYTES_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_RSS_BYTES_MAX';
export const CODE_GRAPH_PARSER_WORKER_RESPONSE_BYTES_MAXIMUM = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM + 4 * 1_024;
export const CODE_GRAPH_PARSER_SOURCE_BYTES_MAXIMUM = 16 * 1_048_576;
export const CODE_GRAPH_PARSER_SYMBOLS_MAXIMUM = 4_000;
export const CODE_GRAPH_PARSER_ALLOCATION_BYTES_MAXIMUM = 512 * 1_048_576;
export const CODE_GRAPH_PARSER_RSS_BYTES_MAXIMUM = 2 * 1_024 * 1_024 * 1_024;

const PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 60_000;
const MAX_PROTOCOL_LINE_BYTES = 256 * 1_048_576;
const STDERR_BYTES_LIMIT = 32 * 1_024;
const WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS = 500;
const SLOT_RETRY_MILLISECONDS = 25;
const SLOT_STALE_MILLISECONDS = 30_000;
const PARSER_WORKER_PREWARM_CONCURRENCY = 4;
const PARSER_WORKER_MEMORY_BYTES_PER_SLOT = 8 * 1_024 * 1_024 * 1_024;
const PARSER_WORKER_WARMUP_SOURCE = 'export const __threadnoteParserWarmup = true;\n';
const PARSER_WORKER_WARMUP_FILE: CodeGraphInventoryFile = {
  blobId: '',
  content: PARSER_WORKER_WARMUP_SOURCE,
  contentHash: sha256HexSync(PARSER_WORKER_WARMUP_SOURCE),
  language: 'typescript',
  mode: '100644',
  path: '.threadnote/parser-warmup.ts',
  size: new TextEncoder().encode(PARSER_WORKER_WARMUP_SOURCE).byteLength,
  source: 'worktree',
};

type ParserWorkerEnvironment = Readonly<Record<string, string | undefined>>;

export type ParserWorkerFailureReason =
  | 'abort'
  | 'allocation'
  | 'exit'
  | 'fact-bytes'
  | 'operation'
  | 'protocol'
  | 'rss'
  | 'source-bytes'
  | 'spawn'
  | 'symbols'
  | 'timeout'
  | 'write';

export interface ParserWorkerBudgetDiagnostic {
  readonly code: 'allocation-bytes' | 'elapsed' | 'fact-bytes' | 'rss-bytes' | 'source-bytes' | 'symbols';
  readonly maximum: number;
  readonly observed: number;
  readonly unit: 'bytes' | 'milliseconds' | 'symbols';
}

export interface ParserWorkerSourceByteBudget {
  readonly exceeded: boolean;
  readonly maximumBytes: number;
  readonly observedBytes: number;
}

class ParserWorkerError extends Schema.TaggedError<ParserWorkerError, {readonly brand: unique symbol}>()(
  'ParserWorkerError',
  {
    budget: Schema.optionalKey(Schema.Any),
    message: Schema.String,
    reason: Schema.Literals([
      'abort',
      'allocation',
      'exit',
      'fact-bytes',
      'operation',
      'protocol',
      'rss',
      'source-bytes',
      'spawn',
      'symbols',
      'timeout',
      'write',
    ]),
  },
) {
  static of(reason: ParserWorkerFailureReason, budget?: ParserWorkerBudgetDiagnostic): ParserWorkerError {
    return ParserWorkerError.make({
      message: parserWorkerFailureSummary(reason),
      reason,
      ...(budget === undefined ? {} : {budget}),
    });
  }
}

export interface ParserWorkerProcess {
  readonly closeInput: () => Promise<void> | void;
  readonly exited: Promise<number>;
  readonly kill: () => void;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly write: (line: string) => Promise<void> | void;
}

export interface ParserWorkerSpawnOptions {
  readonly arguments: readonly string[];
  readonly environment: ParserWorkerEnvironment;
  readonly executable: string;
}

export type ParserWorkerSpawner = (
  options: ParserWorkerSpawnOptions,
) => ParserWorkerProcess | Promise<ParserWorkerProcess>;

export interface CodeGraphParserPoolOptions {
  readonly capacity?: number;
  readonly idleTimeoutMilliseconds?: number;
  readonly maxProtocolLineBytes?: number;
  /** Test and internal callers may lower, but never raise, the production source budget. */
  readonly maxSourceBytes?: number;
  readonly maxStderrBytes?: number;
  readonly requestTimeoutMilliseconds?: number;
  readonly spawnWorker?: ParserWorkerSpawner;
}

interface ParserWorkerRequest {
  readonly file: CodeGraphInventoryFile;
  readonly id: string;
  readonly protocol: typeof PROTOCOL_VERSION;
}

interface ParserWorkerSuccess {
  readonly degradationReason?: ParserWorkerFailureReason;
  readonly degraded: boolean;
  readonly facts: CodeGraphFileFacts;
  readonly id: string;
  readonly ok: true;
  readonly parseMilliseconds: number;
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly recycle: boolean;
}

interface ParserWorkerFailure {
  readonly error: {readonly summary: string};
  readonly id: string;
  readonly ok: false;
  readonly protocol: typeof PROTOCOL_VERSION;
}

type ParserWorkerResponse = ParserWorkerFailure | ParserWorkerSuccess;

export interface CodeGraphParserResult {
  /** Closed parent-observed reason; never includes a path or native message. */
  readonly degradationReason?: ParserWorkerFailureReason;
  readonly degraded: boolean;
  readonly facts: CodeGraphFileFacts;
  readonly parseMilliseconds: number;
}

export interface ParserWorkerFactBudgetOptions {
  readonly maximumFactBytes?: number;
  readonly maximumSymbols?: number;
}

export interface ParserWorkerResourceSnapshot {
  readonly peakRssBytes: number;
  readonly rssBytes: number;
}

export interface ParserWorkerResourceBudgetOptions {
  readonly maximumAllocationBytes?: number;
  readonly maximumRssBytes?: number;
}

export class ParserWorkerConfigurationError extends Schema.TaggedError<
  ParserWorkerConfigurationError,
  {readonly brand: unique symbol}
>()('ParserWorkerConfigurationError', {message: Schema.String}) {}

export interface CodeGraphParserPoolShape {
  readonly capacity: number;
  readonly extract: (
    file: CodeGraphInventoryFile,
    threadnoteHome: string,
  ) => Effect.Effect<CodeGraphParserResult, never>;
  readonly withParserSlot: <A, E, R>(
    threadnoteHome: string,
    files: readonly CodeGraphInventoryFile[],
    use: (
      extract: (file: CodeGraphInventoryFile) => Effect.Effect<CodeGraphParserResult, never>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly warm: (
    threadnoteHome: string,
    requestedSlots?: number,
  ) => Effect.Effect<void, ParserWorkerConfigurationError>;
  readonly trimIdle: Effect.Effect<void, never>;
}

export function warmPlannedParserCapacity(
  pool: CodeGraphParserPoolShape,
  threadnoteHome: string,
  fileCount: number,
): Effect.Effect<void, ParserWorkerConfigurationError> {
  return fileCount <= pool.capacity ? Effect.void : pool.warm(threadnoteHome, fileCount);
}

class ParserWorkerSessionUseError<E> {
  constructor(readonly error: E) {}
}

export interface ParserWorkerCapacityInput {
  readonly effectiveMemoryBytes?: number;
  readonly environment: ParserWorkerEnvironment;
  readonly hardwareConcurrency: number;
  readonly override?: number;
}

export class CodeGraphParserPool extends Context.Service<CodeGraphParserPool, CodeGraphParserPoolShape>()(
  '@threadnote/graph/parser_worker/CodeGraphParserPool',
) {
  static get layer() {
    return codeGraphParserPoolLayer();
  }
}

export function codeGraphParserPoolLayer(
  options: CodeGraphParserPoolOptions = {},
): Layer.Layer<CodeGraphParserPool, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo> {
  return Layer.effect(
    CodeGraphParserPool,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const environment = system.environment();
        const explicitCapacity = explicitParserWorkerCapacity(environment, options.capacity);
        const capacity =
          explicitCapacity ??
          (yield* system.hardwareInfo.pipe(
            Effect.map(hardware =>
              parserWorkerCapacity({
                effectiveMemoryBytes: hardware.effectiveMemoryBytes,
                environment,
                hardwareConcurrency: currentHardwareConcurrency(),
              }),
            ),
            Effect.orElseSucceed(() => 1),
          ));
        const requestTimeoutMilliseconds = positiveInteger(
          options.requestTimeoutMilliseconds,
          parserWorkerTimeout(environment),
        );
        const idleTimeoutMilliseconds = nonNegativeInteger(
          options.idleTimeoutMilliseconds,
          parserWorkerIdleTimeout(environment),
        );
        const maxProtocolLineBytes = positiveInteger(options.maxProtocolLineBytes, MAX_PROTOCOL_LINE_BYTES);
        const maxSourceBytes = Math.min(
          CODE_GRAPH_PARSER_SOURCE_BYTES_MAXIMUM,
          positiveInteger(options.maxSourceBytes, CODE_GRAPH_PARSER_SOURCE_BYTES_MAXIMUM),
        );
        const maxStderrBytes = positiveInteger(options.maxStderrBytes, STDERR_BYTES_LIMIT);
        const spawnWorker = options.spawnWorker ?? spawnBunParserWorker;
        const slots = Array.from(
          {length: capacity},
          (_, index) =>
            new ParserWorkerSlot(
              index,
              system,
              requestTimeoutMilliseconds,
              idleTimeoutMilliseconds,
              maxProtocolLineBytes,
              maxStderrBytes,
              spawnWorker,
            ),
        );
        const available = yield* Queue.unbounded<ParserWorkerSlot>();
        yield* Queue.offerAll(available, slots);
        const degradedResult = (file: CodeGraphInventoryFile, cause: unknown): CodeGraphParserResult => {
          const reason = Schema.is(ParserWorkerError)(cause) ? cause.reason : 'protocol';
          return {
            degradationReason: reason,
            degraded: true,
            facts: degradedFacts(file, cause),
            parseMilliseconds: 0,
          };
        };
        const sourceBudgetResult = (file: CodeGraphInventoryFile): CodeGraphParserResult | undefined => {
          const sourceByteBudget = parserWorkerSourceByteBudget(file, maxSourceBytes);
          if (!sourceByteBudget.exceeded) return undefined;
          return degradedResult(
            file,
            ParserWorkerError.of('source-bytes', {
              code: 'source-bytes',
              maximum: sourceByteBudget.maximumBytes,
              observed: sourceByteBudget.observedBytes,
              unit: 'bytes',
            }),
          );
        };
        const extractFromSlot = (slot: ParserWorkerSlot, file: CodeGraphInventoryFile, threadnoteHome: string) => {
          const budgeted = sourceBudgetResult(file);
          return budgeted === undefined
            ? slot
                .extract(file, threadnoteHome)
                .pipe(Effect.catch(cause => Effect.succeed(degradedResult(file, cause))))
            : Effect.succeed(budgeted);
        };
        const requiresWorker = (file: CodeGraphInventoryFile) =>
          file.bytes === undefined && sourceBudgetResult(file) === undefined;
        const workPlans = new WeakMap<
          readonly CodeGraphInventoryFile[],
          {readonly required: boolean; readonly warm: boolean}
        >();
        const workPlan = (files: readonly CodeGraphInventoryFile[]) => {
          const cached = workPlans.get(files);
          if (cached !== undefined) return cached;
          let workerFiles = 0;
          for (const file of files) {
            if (!requiresWorker(file)) continue;
            workerFiles += 1;
            if (workerFiles > capacity) break;
          }
          const planned = {required: workerFiles > 0, warm: capacity > 1 && workerFiles > capacity};
          workPlans.set(files, planned);
          return planned;
        };
        const extractWithoutSlot = (file: CodeGraphInventoryFile) => {
          const budgeted = sourceBudgetResult(file);
          return Effect.succeed(
            budgeted ?? degradedResult(file, ParserWorkerError.of(file.bytes === undefined ? 'protocol' : 'operation')),
          );
        };
        const warmSlot = (slot: ParserWorkerSlot, threadnoteHome: string) =>
          fromPromiseInterruptibleAwaiting(
            signal => slot.warm(threadnoteHome, signal),
            cause => (Schema.is(ParserWorkerError)(cause) ? cause : ParserWorkerError.of('protocol')),
          );
        const prewarmSlot = (slot: ParserWorkerSlot, threadnoteHome: string) =>
          fromPromise('warm parser worker', () => slot.warm(threadnoteHome, new AbortController().signal));

        return {
          service: CodeGraphParserPool.of({
            capacity,
            extract: (file, threadnoteHome) => {
              const budgeted = sourceBudgetResult(file);
              if (budgeted !== undefined) return Effect.succeed(budgeted);
              return Effect.acquireUseRelease(
                Queue.take(available),
                slot =>
                  withGlobalParserSlot(
                    crypto,
                    fs,
                    path,
                    system,
                    threadnoteHome,
                    capacity,
                    slot.index,
                    extractFromSlot(slot, file, threadnoteHome),
                  ).pipe(Effect.catch(cause => Effect.succeed(degradedResult(file, cause)))),
                slot => Queue.offer(available, slot),
              );
            },
            withParserSlot: (threadnoteHome, files, use) => {
              const planned = workPlan(files);
              return planned.required
                ? Effect.acquireUseRelease(
                    Queue.take(available),
                    slot =>
                      withGlobalParserSlot(
                        crypto,
                        fs,
                        path,
                        system,
                        threadnoteHome,
                        capacity,
                        slot.index,
                        (planned.warm ? warmSlot(slot, threadnoteHome) : Effect.void).pipe(
                          Effect.andThen(
                            use(file => extractFromSlot(slot, file, threadnoteHome)).pipe(
                              Effect.mapError(error => new ParserWorkerSessionUseError(error)),
                            ),
                          ),
                        ),
                      ).pipe(
                        Effect.catch(error =>
                          error instanceof ParserWorkerSessionUseError
                            ? Effect.fail(error.error)
                            : use(file => Effect.succeed(degradedResult(file, error))),
                        ),
                      ),
                    slot => Queue.offer(available, slot),
                  )
                : use(extractWithoutSlot);
            },
            warm: (threadnoteHome, requestedSlots = capacity) =>
              Number.isSafeInteger(requestedSlots) && requestedSlots >= 0
                ? Effect.acquireUseRelease(
                    Queue.clear(available),
                    idleSlots =>
                      Effect.forEach(
                        idleSlots.slice(0, Math.min(capacity, requestedSlots)),
                        slot =>
                          withGlobalParserSlot(
                            crypto,
                            fs,
                            path,
                            system,
                            threadnoteHome,
                            capacity,
                            slot.index,
                            prewarmSlot(slot, threadnoteHome),
                          ),
                        {concurrency: PARSER_WORKER_PREWARM_CONCURRENCY, discard: true},
                      ).pipe(Effect.ignore),
                    idleSlots => Queue.offerAll(available, idleSlots),
                  ).pipe(Effect.asVoid)
                : Effect.fail(
                    ParserWorkerConfigurationError.make({message: 'Code graph parser warm slot count is invalid.'}),
                  ),
            trimIdle: Effect.acquireUseRelease(
              Queue.clear(available),
              idleSlots =>
                Effect.forEach(idleSlots, slot => fromPromise('trim idle parser worker', () => slot.trimIdle()), {
                  concurrency: 'unbounded',
                  discard: true,
                }).pipe(Effect.ignore),
              idleSlots => Queue.offerAll(available, idleSlots),
            ).pipe(Effect.asVoid),
          }),
          slots,
        };
      }),
      ({slots}) =>
        Effect.forEach(slots, slot => fromPromise('close parser worker', () => slot.close()), {
          concurrency: 'unbounded',
          discard: true,
        }).pipe(Effect.ignore),
    ).pipe(Effect.map(({service}) => service)),
  );
}

function withGlobalParserSlot<A, E, R>(
  crypto: Crypto.Crypto,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
  capacity: number,
  preferredSlot: number,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> {
  const slotRoot = path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'parser-slots');
  const attempt = (slot: number) =>
    withExclusiveFileLock(
      fs,
      path.join(slotRoot, `${slot}.lock`),
      {
        heartbeatIntervalMilliseconds: 5_000,
        retryIntervalMilliseconds: 1,
        staleAfterMilliseconds: SLOT_STALE_MILLISECONDS,
        waitTimeoutMilliseconds: 0,
      },
      effect,
    ).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SystemInfo, system),
      Effect.asSome,
      Effect.catchIf(isFileLockTimeout, () => Effect.succeedNone),
    );

  return Effect.gen(function* () {
    while (true) {
      for (let offset = 0; offset < capacity; offset += 1) {
        const acquired = yield* attempt((preferredSlot + offset) % capacity);
        if (Option.isSome(acquired)) return acquired.value;
      }
      yield* Effect.sleep(SLOT_RETRY_MILLISECONDS);
    }
  });
}

class ParserWorkerSlot {
  private closed = false;
  private connection = Option.none<ParserWorkerConnection>();
  private connectionHome = Option.none<string>();
  private warmedConnection = Option.none<ParserWorkerConnection>();
  private evictingConnection: Promise<void> | undefined;
  private idleGeneration = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;

  constructor(
    readonly index: number,
    private readonly system: SystemInfoShape,
    private readonly timeoutMilliseconds: number,
    private readonly idleTimeoutMilliseconds: number,
    private readonly maxProtocolLineBytes: number,
    private readonly maxStderrBytes: number,
    private readonly spawnWorker: ParserWorkerSpawner,
  ) {}

  extract(file: CodeGraphInventoryFile, threadnoteHome: string): Effect.Effect<CodeGraphParserResult, Error> {
    return fromPromiseInterruptibleAwaiting(
      async signal => {
        if (this.closed) throw ParserWorkerError.of('exit');
        this.cancelIdleEviction();
        try {
          if (file.bytes !== undefined) throw ParserWorkerError.of('operation');
          for (let attempt = 0; attempt < 2; attempt += 1) {
            let connection = Option.none<ParserWorkerConnection>();
            try {
              const active = await this.activeConnection(threadnoteHome);
              connection = Option.some(active);
              const response = await active.request(
                {
                  file,
                  id: `${this.system.processId}-${this.index}-${++this.sequence}`,
                  protocol: PROTOCOL_VERSION,
                },
                this.timeoutMilliseconds,
                signal,
              );
              if (!response.ok) throw ParserWorkerError.of('operation');
              if (response.recycle) await this.discard(active).catch(() => undefined);
              return {
                ...(response.degradationReason === undefined
                  ? response.degraded
                    ? {degradationReason: 'operation' as const}
                    : {}
                  : {degradationReason: response.degradationReason}),
                degraded: response.degraded,
                facts: response.facts,
                parseMilliseconds: response.parseMilliseconds,
              };
            } catch (cause) {
              if (Option.isSome(connection) && Schema.is(ParserWorkerError)(cause) && cause.reason !== 'operation') {
                await this.discard(connection.value);
              }
              if (
                !Schema.is(ParserWorkerError)(cause) ||
                cause.reason === 'operation' ||
                attempt === 1 ||
                signal.aborted
              ) {
                throw cause;
              }
            }
          }
          throw ParserWorkerError.of('exit');
        } finally {
          this.scheduleIdleEviction();
        }
      },
      cause => (cause instanceof Error ? cause : ParserWorkerError.of('protocol')),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelIdleEviction();
    await this.evictingConnection?.catch(() => undefined);
    if (Option.isNone(this.connection)) return;
    const connection = this.connection.value;
    this.connection = Option.none();
    this.connectionHome = Option.none();
    this.warmedConnection = Option.none();
    await connection.close();
  }

  async warm(threadnoteHome: string, signal: AbortSignal): Promise<void> {
    if (this.closed) throw ParserWorkerError.of('exit');
    this.cancelIdleEviction();
    let connection = Option.none<ParserWorkerConnection>();
    try {
      const active = await this.activeConnection(threadnoteHome);
      connection = Option.some(active);
      if (Option.contains(this.warmedConnection, active) && !active.closed) return;
      const response = await active.request(
        {
          file: PARSER_WORKER_WARMUP_FILE,
          id: `${this.system.processId}-${this.index}-${++this.sequence}`,
          protocol: PROTOCOL_VERSION,
        },
        this.timeoutMilliseconds,
        signal,
      );
      if (!response.ok || response.degraded || response.recycle) throw ParserWorkerError.of('operation');
      this.warmedConnection = Option.some(active);
    } catch (cause) {
      if (Option.isSome(connection)) await this.discard(connection.value).catch(() => undefined);
      throw cause;
    } finally {
      this.scheduleIdleEviction();
    }
  }

  async trimIdle(): Promise<void> {
    this.cancelIdleEviction();
    await this.evictingConnection?.catch(() => undefined);
    if (this.closed || Option.isNone(this.connection)) return;
    await this.evictConnection(this.connection.value);
  }

  private async activeConnection(threadnoteHome: string): Promise<ParserWorkerConnection> {
    if (this.closed) throw ParserWorkerError.of('exit');
    const eviction = this.evictingConnection;
    if (eviction) await eviction.catch(() => undefined);
    if (this.closed) throw ParserWorkerError.of('exit');
    if (
      Option.isSome(this.connection) &&
      Option.contains(this.connectionHome, threadnoteHome) &&
      !this.connection.value.closed
    ) {
      return this.connection.value;
    }
    if (Option.isSome(this.connection)) await this.discard(this.connection.value);
    let worker: ParserWorkerProcess;
    try {
      worker = await this.spawnWorker(parserWorkerSpawnOptions(this.system, threadnoteHome));
    } catch {
      throw ParserWorkerError.of('spawn');
    }
    const connection = new ParserWorkerConnection(worker, this.maxProtocolLineBytes, this.maxStderrBytes);
    if (this.closed) {
      await connection.close();
      throw ParserWorkerError.of('exit');
    }
    this.connection = Option.some(connection);
    this.connectionHome = Option.some(threadnoteHome);
    return connection;
  }

  private async discard(connection: ParserWorkerConnection): Promise<void> {
    if (Option.isSome(this.connection) && this.connection.value === connection) {
      this.connection = Option.none();
      this.connectionHome = Option.none();
      this.warmedConnection = Option.none();
    }
    await connection.close();
  }

  private cancelIdleEviction(): void {
    this.idleGeneration += 1;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleEviction(): void {
    if (
      this.closed ||
      this.idleTimeoutMilliseconds === 0 ||
      Option.isNone(this.connection) ||
      this.evictingConnection !== undefined
    ) {
      return;
    }
    const connection = this.connection.value;
    const generation = ++this.idleGeneration;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (
        this.closed ||
        generation !== this.idleGeneration ||
        Option.isNone(this.connection) ||
        this.connection.value !== connection
      ) {
        return;
      }
      void this.evictConnection(connection);
    }, this.idleTimeoutMilliseconds);
    this.idleTimer.unref?.();
  }

  private async evictConnection(connection: ParserWorkerConnection): Promise<void> {
    if (Option.isSome(this.connection) && this.connection.value === connection) {
      this.connection = Option.none();
      this.connectionHome = Option.none();
      this.warmedConnection = Option.none();
    }
    const eviction = connection.close();
    this.evictingConnection = eviction;
    try {
      await eviction;
    } finally {
      if (this.evictingConnection === eviction) this.evictingConnection = undefined;
    }
  }
}

class ParserWorkerConnection {
  private buffer = '';
  private bufferBytes = 0;
  private isClosed = false;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly reader: AsyncIterator<string | Uint8Array>;
  private stderrBytes = 0;

  constructor(
    private readonly worker: ParserWorkerProcess,
    private readonly maxProtocolLineBytes: number,
    private readonly maxStderrBytes: number,
  ) {
    this.reader = worker.stdout[Symbol.asyncIterator]();
    void this.consumeStderr(worker.stderr).catch(() => undefined);
    void worker.exited.then(
      () => {
        this.isClosed = true;
      },
      () => {
        this.isClosed = true;
      },
    );
  }

  get closed(): boolean {
    return this.isClosed;
  }

  async request(
    request: ParserWorkerRequest,
    timeoutMilliseconds: number,
    signal: AbortSignal,
  ): Promise<ParserWorkerResponse> {
    if (signal.aborted) throw ParserWorkerError.of('abort');
    const encoded = `${JSON.stringify(request)}\n`;
    if (this.encoder.encode(encoded).byteLength > this.maxProtocolLineBytes) {
      throw ParserWorkerError.of('protocol');
    }
    const response = await raceWorkerResponse(this.writeAndRead(encoded), timeoutMilliseconds, signal, () => {
      try {
        this.worker.kill();
      } catch {
        // The worker may have exited while the deadline or interrupt fired.
      }
    });
    const decoded = decodeResponse(response, request.id, request.file.path);
    if (decoded === undefined) {
      throw ParserWorkerError.of('protocol');
    }
    return decoded;
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      this.kill();
      void Promise.resolve()
        .then(() => this.worker.closeInput())
        .catch(() => undefined);
      return;
    }
    this.isClosed = true;
    const closedGracefully = await completesBeforeDeadline(
      Promise.resolve()
        .then(() => this.worker.closeInput())
        .then(() => this.worker.exited),
      WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS,
    );
    if (!closedGracefully) this.kill();
    void Promise.resolve()
      .then(() => this.reader.return?.())
      .catch(() => undefined);
  }

  private async writeAndRead(encoded: string): Promise<string> {
    try {
      await this.worker.write(encoded);
    } catch {
      throw ParserWorkerError.of('write');
    }
    return this.readLine();
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const newline = Effect2.pipe(
        this.buffer,
        EffectString.indexOf('\n'),
        Effect2.Option.getOrElse(() => -1),
      );
      if (newline >= 0) {
        const line = Effect2.pipe(this.buffer, EffectString.slice(0, newline), EffectString.replace(/\r$/, ''));
        this.buffer = Effect2.pipe(this.buffer, EffectString.slice(newline + 1));
        this.bufferBytes = this.encoder.encode(this.buffer).byteLength;
        return line;
      }
      let chunk: IteratorResult<string | Uint8Array>;
      try {
        chunk = await this.reader.next();
      } catch {
        throw ParserWorkerError.of('exit');
      }
      if (chunk.done) throw ParserWorkerError.of('exit');
      const bytes = typeof chunk.value === 'string' ? this.encoder.encode(chunk.value) : chunk.value;
      this.bufferBytes += bytes.byteLength;
      if (this.bufferBytes > this.maxProtocolLineBytes) throw ParserWorkerError.of('protocol');
      this.buffer += typeof chunk.value === 'string' ? chunk.value : this.decoder.decode(chunk.value, {stream: true});
    }
  }

  private async consumeStderr(stream: AsyncIterable<string | Uint8Array>): Promise<void> {
    for await (const chunk of stream) {
      if (this.stderrBytes >= this.maxStderrBytes) continue;
      const bytes = typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk;
      this.stderrBytes += Math.min(bytes.byteLength, this.maxStderrBytes - this.stderrBytes);
    }
  }

  private kill(): void {
    try {
      this.worker.kill();
    } catch {
      // The worker may already have exited while its pipes are settling.
    }
  }
}

function spawnBunParserWorker(options: ParserWorkerSpawnOptions): ParserWorkerProcess {
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

function parserWorkerSpawnOptions(system: SystemInfoShape, threadnoteHome: string): ParserWorkerSpawnOptions {
  const script = developmentStandaloneScript(system);
  return {
    arguments: [...Option.toArray(script), CODE_GRAPH_PARSER_WORKER_ARGUMENT],
    environment: {
      ...system.intendedChildEnvironment(system.environment(), 'parser-worker'),
      THREADNOTE_HOME: threadnoteHome,
      THREADNOTE_CODE_GRAPH_PARSER_WORKER: '1',
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
  if (candidate && /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/i.test(candidate)) {
    return Option.some(candidate);
  }
  // Test and library callers do not run through standalone.ts themselves, but
  // Bun can execute the source entrypoint directly for an isolated worker.
  return Option.some(system.developmentEntrypoint);
}

async function raceWorkerResponse<A>(
  response: Promise<A>,
  timeoutMilliseconds: number,
  signal: AbortSignal,
  abort: () => void,
): Promise<A> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const timeoutDeferred = Promise.withResolvers<never>();
    const abortDeferred = Promise.withResolvers<never>();
    timeout = setTimeout(() => {
      abort();
      timeoutDeferred.reject(
        ParserWorkerError.of('timeout', {
          code: 'elapsed',
          maximum: timeoutMilliseconds,
          observed: timeoutMilliseconds,
          unit: 'milliseconds',
        }),
      );
    }, timeoutMilliseconds);
    onAbort = () => {
      abort();
      abortDeferred.reject(ParserWorkerError.of('abort'));
    };
    signal.addEventListener('abort', onAbort, {once: true});
    return await Promise.race([response, timeoutDeferred.promise, abortDeferred.promise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function completesBeforeDeadline(promise: Promise<unknown>, timeoutMilliseconds: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutDeferred = Promise.withResolvers<false>();
    timeout = setTimeout(() => timeoutDeferred.resolve(false), timeoutMilliseconds);
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeoutDeferred.promise,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export const codeGraphParserWorkerServer: Effect.Effect<void, never, Stdio.Stdio | SystemInfo | TreeSitterRuntime> =
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const system = yield* SystemInfo;
    const treeSitter = yield* TreeSitterRuntime;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffered = '';
    let bufferedBytes = 0;

    const writeResponse = (response: ParserWorkerResponse) =>
      Stream.run(Stream.make(encodeParserWorkerResponse(response)), stdio.stdout({endOnDone: false}));

    const processLine = (line: string) =>
      handleParserWorkerLine(line, treeSitter, system).pipe(Effect.flatMap(writeResponse));

    yield* stdio.stdin.pipe(
      Stream.runForEach(chunk =>
        Effect.gen(function* () {
          bufferedBytes += chunk.byteLength;
          buffered += decoder.decode(chunk, {stream: true});
          for (;;) {
            const newline = Effect2.pipe(
              buffered,
              EffectString.indexOf('\n'),
              Effect2.Option.getOrElse(() => -1),
            );
            if (newline < 0) break;
            const lineWithNewline = Effect2.pipe(buffered, EffectString.slice(0, newline + 1));
            const line = Effect2.pipe(lineWithNewline, __effectPipeInput => {
              const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.slice(0, -1));
              const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.replace(/\r$/, ''));
              return __effectPipeStage1;
            });
            bufferedBytes -= encoder.encode(lineWithNewline).byteLength;
            buffered = Effect2.pipe(buffered, EffectString.slice(newline + 1));
            if (encoder.encode(line).byteLength > MAX_PROTOCOL_LINE_BYTES) {
              return yield* ParserWorkerError.of('protocol');
            }
            if (line) yield* processLine(line);
          }
          if (bufferedBytes > MAX_PROTOCOL_LINE_BYTES) {
            return yield* ParserWorkerError.of('protocol');
          }
        }),
      ),
    );

    buffered += decoder.decode();
    if (encoder.encode(buffered).byteLength > MAX_PROTOCOL_LINE_BYTES) {
      return yield* ParserWorkerError.of('protocol');
    }
    if (Effect2.pipe(buffered, EffectString.trim)) yield* processLine(Effect2.pipe(buffered, EffectString.trim));
  }).pipe(Effect.ignore);

function handleParserWorkerLine(
  line: string,
  treeSitter: TreeSitterRuntimeShape,
  system: SystemInfoShape,
): Effect.Effect<ParserWorkerResponse, never> {
  const request = decodeRequest(line);
  if (request === undefined) return Effect.succeed(protocolFailure('invalid', 'Invalid parser worker request.'));
  const startedAt = performance.now();
  const resourceBefore = parserWorkerResourceSnapshot(system);
  const resourceOptions = parserWorkerResourceOptions(system.environment());
  const completedResponse = (facts: CodeGraphFileFacts | undefined): ParserWorkerResponse => {
    const parseMilliseconds = Math.max(0, performance.now() - startedAt);
    const resourceBudget = parserWorkerResourceBudget(
      resourceBefore,
      parserWorkerResourceSnapshot(system),
      resourceOptions,
    );
    if (resourceBudget !== undefined) {
      const degradationReason = resourceBudget.code === 'rss-bytes' ? 'rss' : 'allocation';
      return {
        degradationReason,
        degraded: true,
        facts: degradedFacts(request.file, ParserWorkerError.of(degradationReason, resourceBudget)),
        id: request.id,
        ok: true,
        parseMilliseconds,
        protocol: PROTOCOL_VERSION,
        recycle: true,
      };
    }
    if (facts === undefined) return protocolFailure(request.id, 'Language extraction failed.');
    const bounded = budgetParserWorkerFacts(request.file, facts);
    return {
      ...(bounded.degradationReason === undefined ? {} : {degradationReason: bounded.degradationReason}),
      degraded: bounded.degraded,
      facts: bounded.facts,
      id: request.id,
      ok: true,
      parseMilliseconds,
      protocol: PROTOCOL_VERSION,
      recycle: bounded.degraded,
    };
  };
  return BUILTIN_LANGUAGE_PACK_REGISTRY.extractRawFile(request.file).pipe(
    Effect.provideService(TreeSitterRuntime, treeSitter),
    Effect.match({
      onFailure: () => completedResponse(undefined),
      onSuccess: completedResponse,
    }),
  );
}

function decodeRequest(line: string): ParserWorkerRequest | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      !Predicate.isObject(value) ||
      value.protocol !== PROTOCOL_VERSION ||
      typeof value.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)
    ) {
      return undefined;
    }
    const file = value.file;
    if (
      !Predicate.isObject(file) ||
      typeof file.blobId !== 'string' ||
      typeof file.contentHash !== 'string' ||
      typeof file.language !== 'string' ||
      typeof file.mode !== 'string' ||
      typeof file.path !== 'string' ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      (file.source !== 'commit' && file.source !== 'worktree') ||
      (file.content !== undefined && typeof file.content !== 'string') ||
      (file.contentOmittedReason !== undefined &&
        file.contentOmittedReason !== 'metadata-only' &&
        file.contentOmittedReason !== 'size-budget') ||
      file.bytes !== undefined
    ) {
      return undefined;
    }
    return {
      file: {
        blobId: file.blobId,
        ...(file.content === undefined ? {} : {content: file.content}),
        contentHash: file.contentHash,
        ...(file.contentOmittedReason === undefined ? {} : {contentOmittedReason: file.contentOmittedReason}),
        language: file.language,
        mode: file.mode,
        path: file.path,
        size: file.size,
        source: file.source,
      },
      id: value.id,
      protocol: PROTOCOL_VERSION,
    };
  } catch {
    return undefined;
  }
}

function decodeResponse(line: string, expectedId: string, expectedPath: string): ParserWorkerResponse | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      !Predicate.isObject(value) ||
      value.protocol !== PROTOCOL_VERSION ||
      value.id !== expectedId ||
      typeof value.ok !== 'boolean'
    ) {
      return undefined;
    }
    if (!value.ok) {
      return Predicate.isObject(value.error) && typeof value.error.summary === 'string'
        ? {error: {summary: value.error.summary}, id: value.id, ok: false, protocol: PROTOCOL_VERSION}
        : undefined;
    }
    return isFileFacts(value.facts) &&
      value.facts.path === expectedPath &&
      typeof value.degraded === 'boolean' &&
      (value.degradationReason === undefined || parserWorkerFailureReason(value.degradationReason)) &&
      typeof value.recycle === 'boolean' &&
      typeof value.parseMilliseconds === 'number' &&
      Number.isFinite(value.parseMilliseconds) &&
      value.parseMilliseconds >= 0
      ? {
          ...(value.degradationReason === undefined ? {} : {degradationReason: value.degradationReason}),
          degraded: value.degraded,
          facts: value.facts,
          id: value.id,
          ok: true,
          parseMilliseconds: value.parseMilliseconds,
          protocol: PROTOCOL_VERSION,
          recycle: value.recycle,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function protocolFailure(id: string, summary: string): ParserWorkerFailure {
  return {error: {summary}, id, ok: false, protocol: PROTOCOL_VERSION};
}

function isFileFacts(value: unknown): value is CodeGraphFileFacts {
  return (
    Predicate.isObject(value) &&
    typeof value.path === 'string' &&
    EffectArray.isArray(value.diagnostics) &&
    EffectArray.every(value.diagnostics, diagnostic => typeof diagnostic === 'string') &&
    EffectArray.isArray(value.edges) &&
    EffectArray.every(value.edges, isCodeGraphEdge) &&
    (value.references === undefined ||
      (EffectArray.isArray(value.references) && EffectArray.every(value.references, isCodeGraphReference))) &&
    EffectArray.isArray(value.symbols) &&
    EffectArray.every(value.symbols, isCodeGraphSymbol)
  );
}

function isCodeGraphEdge(value: unknown): boolean {
  return (
    Predicate.isObject(value) &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    typeof value.evidencePath === 'string' &&
    isCodeGraphSpan(value.evidenceSpan) &&
    typeof value.id === 'string' &&
    typeof value.provenance === 'string' &&
    typeof value.relation === 'string' &&
    (value.sourceId === undefined || typeof value.sourceId === 'string') &&
    typeof value.sourceName === 'string' &&
    (value.targetId === undefined || typeof value.targetId === 'string') &&
    typeof value.targetName === 'string'
  );
}

function isCodeGraphReference(value: unknown): boolean {
  return (
    Predicate.isObject(value) &&
    (value.aliasLookupKeys === undefined || isStringArray(value.aliasLookupKeys)) &&
    (value.arity === undefined || Number.isSafeInteger(value.arity)) &&
    typeof value.edgeId === 'string' &&
    typeof value.evidencePath === 'string' &&
    isCodeGraphSpan(value.evidenceSpan) &&
    (value.exportedOnly === undefined || typeof value.exportedOnly === 'boolean') &&
    EffectArray.isArray(value.lookupTiers) &&
    EffectArray.every(value.lookupTiers, isStringArray) &&
    typeof value.provenance === 'string' &&
    typeof value.relation === 'string' &&
    typeof value.resolutionDomain === 'string' &&
    (value.sourceId === undefined || typeof value.sourceId === 'string') &&
    typeof value.sourceName === 'string' &&
    typeof value.targetName === 'string'
  );
}

function isCodeGraphSymbol(value: unknown): boolean {
  return (
    Predicate.isObject(value) &&
    (value.arity === undefined || Number.isSafeInteger(value.arity)) &&
    typeof value.contentHash === 'string' &&
    (value.documentation === undefined || typeof value.documentation === 'string') &&
    typeof value.exported === 'boolean' &&
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.language === 'string' &&
    (value.lookupKeys === undefined || isStringArray(value.lookupKeys)) &&
    typeof value.name === 'string' &&
    (value.packageName === undefined || typeof value.packageName === 'string') &&
    typeof value.path === 'string' &&
    typeof value.qualifiedName === 'string' &&
    (value.resolutionDomain === undefined || typeof value.resolutionDomain === 'string') &&
    (value.resolutionScopeId === undefined || typeof value.resolutionScopeId === 'string') &&
    (value.signature === undefined || typeof value.signature === 'string') &&
    isCodeGraphSpan(value.span)
  );
}

function isCodeGraphSpan(value: unknown): boolean {
  return (
    Predicate.isObject(value) &&
    Number.isSafeInteger(value.column) &&
    Number.isSafeInteger(value.endColumn) &&
    Number.isSafeInteger(value.endLine) &&
    Number.isSafeInteger(value.line)
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return EffectArray.isArray(value) && EffectArray.every(value, entry => typeof entry === 'string');
}

function degradedFacts(file: CodeGraphInventoryFile, cause: unknown): CodeGraphFileFacts {
  const reason = Schema.is(ParserWorkerError)(cause) ? cause.reason : 'protocol';
  const budgetDiagnostic =
    Schema.is(ParserWorkerError)(cause) && cause.budget !== undefined
      ? ` [code-graph-budget code=${cause.budget.code} status=exhausted observed-${cause.budget.unit}=${cause.budget.observed} maximum-${cause.budget.unit}=${cause.budget.maximum}]`
      : '';
  const diagnostic = `${file.path}: parser extraction degraded this file to searchable metadata (${parserWorkerFailureSummary(reason)})${budgetDiagnostic}`;
  const symbol: CodeGraphSymbol = {
    contentHash: file.contentHash,
    documentation: diagnostic,
    exported: true,
    id: `cgs_${Effect2.pipe(sha256HexSync(`parser-degraded-v1\n${file.path}\n${file.contentHash}`), EffectString.slice(0, 40))}`,
    kind: 'module',
    language: file.language,
    lookupKeys: uniqueStrings([file.path, ...tokens(file.path)]),
    name: Effect2.pipe(file.path, EffectString.split('/')).at(-1) ?? file.path,
    path: file.path,
    qualifiedName: file.path,
    resolutionDomain: 'degraded',
    signature: `${file.size} bytes`,
    span: {column: 1, endColumn: 1, endLine: 1, line: 1},
  };
  return {diagnostics: [diagnostic], edges: [], path: file.path, symbols: [symbol]};
}

export function budgetParserWorkerFacts(
  file: CodeGraphInventoryFile,
  facts: CodeGraphFileFacts,
  options: ParserWorkerFactBudgetOptions = {},
): Pick<CodeGraphParserResult, 'degradationReason' | 'degraded' | 'facts'> {
  const maximumSymbols = Math.min(
    CODE_GRAPH_PARSER_SYMBOLS_MAXIMUM,
    positiveInteger(options.maximumSymbols, CODE_GRAPH_PARSER_SYMBOLS_MAXIMUM),
  );
  if (facts.symbols.length > maximumSymbols) {
    return {
      degradationReason: 'symbols',
      degraded: true,
      facts: degradedFacts(
        file,
        ParserWorkerError.of('symbols', {
          code: 'symbols',
          maximum: maximumSymbols,
          observed: facts.symbols.length,
          unit: 'symbols',
        }),
      ),
    };
  }
  const maximumFactBytes = Math.min(
    CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
    positiveInteger(options.maximumFactBytes, CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM),
  );
  if (cachedCodeGraphFactByteUpperBound(facts) > maximumFactBytes) {
    const observedBytes = cachedCodeGraphFactBytes(facts);
    if (observedBytes > maximumFactBytes) {
      return {
        degradationReason: 'fact-bytes',
        degraded: true,
        facts: degradedFacts(
          file,
          ParserWorkerError.of('fact-bytes', {
            code: 'fact-bytes',
            maximum: maximumFactBytes,
            observed: observedBytes,
            unit: 'bytes',
          }),
        ),
      };
    }
  }
  return {degraded: false, facts: serializeBoundedCodeGraphFact(facts, maximumFactBytes).facts};
}

export function parserWorkerSourceByteBudget(
  file: CodeGraphInventoryFile,
  maximumBytes = CODE_GRAPH_PARSER_SOURCE_BYTES_MAXIMUM,
): ParserWorkerSourceByteBudget {
  const effectiveMaximumBytes = positiveInteger(maximumBytes, CODE_GRAPH_PARSER_SOURCE_BYTES_MAXIMUM);
  if (file.content === undefined) {
    return {exceeded: false, maximumBytes: effectiveMaximumBytes, observedBytes: 0};
  }
  const observedBytes = Math.max(file.size, Buffer.byteLength(file.content, 'utf8'));
  return {
    exceeded: observedBytes > effectiveMaximumBytes,
    maximumBytes: effectiveMaximumBytes,
    observedBytes,
  };
}

export function parserWorkerResourceBudget(
  before: ParserWorkerResourceSnapshot,
  after: ParserWorkerResourceSnapshot,
  options: ParserWorkerResourceBudgetOptions = {},
): ParserWorkerBudgetDiagnostic | undefined {
  const maximumRssBytes = Math.min(
    CODE_GRAPH_PARSER_RSS_BYTES_MAXIMUM,
    positiveInteger(options.maximumRssBytes, CODE_GRAPH_PARSER_RSS_BYTES_MAXIMUM),
  );
  const observedRssBytes = Math.max(after.peakRssBytes, after.rssBytes);
  if (observedRssBytes > maximumRssBytes) {
    return {code: 'rss-bytes', maximum: maximumRssBytes, observed: observedRssBytes, unit: 'bytes'};
  }
  const maximumAllocationBytes = Math.min(
    CODE_GRAPH_PARSER_ALLOCATION_BYTES_MAXIMUM,
    positiveInteger(options.maximumAllocationBytes, CODE_GRAPH_PARSER_ALLOCATION_BYTES_MAXIMUM),
  );
  const observedAllocationBytes = Math.max(0, after.peakRssBytes - before.peakRssBytes);
  return observedAllocationBytes > maximumAllocationBytes
    ? {
        code: 'allocation-bytes',
        maximum: maximumAllocationBytes,
        observed: observedAllocationBytes,
        unit: 'bytes',
      }
    : undefined;
}

export function parserWorkerSuccessResponseBytes(
  facts: CodeGraphFileFacts,
  id = 'parser-worker-response-size',
): number {
  return new TextEncoder().encode(
    `${JSON.stringify({degraded: false, facts, id, ok: true, parseMilliseconds: 0, protocol: PROTOCOL_VERSION, recycle: false})}\n`,
  ).byteLength;
}

export function parserWorkerCapacity(input: ParserWorkerCapacityInput): number {
  const explicit = explicitParserWorkerCapacity(input.environment, input.override);
  if (explicit !== undefined) return explicit;
  const hardwareConcurrency =
    Number.isSafeInteger(input.hardwareConcurrency) && input.hardwareConcurrency > 0 ? input.hardwareConcurrency : 1;
  const cpuCapacity = Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 2)));
  const effectiveMemoryBytes = input.effectiveMemoryBytes;
  if (
    typeof effectiveMemoryBytes !== 'number' ||
    !Number.isSafeInteger(effectiveMemoryBytes) ||
    effectiveMemoryBytes <= 0
  ) {
    return 1;
  }
  const memoryCapacity = Math.max(1, Math.floor(effectiveMemoryBytes / PARSER_WORKER_MEMORY_BYTES_PER_SLOT));
  return Math.min(cpuCapacity, memoryCapacity);
}

function explicitParserWorkerCapacity(environment: ParserWorkerEnvironment, override?: number): number | undefined {
  if (Number.isSafeInteger(override) && override! > 0) return Math.min(8, override!);
  const configured = Number.parseInt(environment[CODE_GRAPH_PARSER_WORKERS_ENV] ?? '', 10);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(8, configured) : undefined;
}

function currentHardwareConcurrency(): number {
  try {
    return navigator.hardwareConcurrency || 1;
  } catch {
    return 1;
  }
}

function encodeParserWorkerResponse(response: ParserWorkerResponse): string {
  const line = `${JSON.stringify(response)}\n`;
  if (new TextEncoder().encode(line).byteLength <= CODE_GRAPH_PARSER_WORKER_RESPONSE_BYTES_MAXIMUM) return line;
  return `${JSON.stringify(protocolFailure(response.id, 'Parser worker response exceeded its protocol budget.'))}\n`;
}

function parserWorkerTimeout(environment: ParserWorkerEnvironment): number {
  const configured = Number.parseInt(environment[CODE_GRAPH_PARSER_TIMEOUT_ENV] ?? '', 10);
  return Number.isSafeInteger(configured) && configured >= 1_000
    ? Math.min(10 * 60_000, configured)
    : DEFAULT_REQUEST_TIMEOUT_MILLISECONDS;
}

function parserWorkerIdleTimeout(environment: ParserWorkerEnvironment): number {
  const configured = Number.parseInt(environment[CODE_GRAPH_PARSER_IDLE_TIMEOUT_ENV] ?? '', 10);
  return Number.isSafeInteger(configured) && configured >= 0
    ? Math.min(60 * 60_000, configured)
    : DEFAULT_IDLE_TIMEOUT_MILLISECONDS;
}

function parserWorkerResourceOptions(environment: ParserWorkerEnvironment): ParserWorkerResourceBudgetOptions {
  return {
    maximumAllocationBytes: parserWorkerByteMaximum(
      environment,
      CODE_GRAPH_PARSER_ALLOCATION_BYTES_ENV,
      CODE_GRAPH_PARSER_ALLOCATION_BYTES_MAXIMUM,
    ),
    maximumRssBytes: parserWorkerByteMaximum(
      environment,
      CODE_GRAPH_PARSER_RSS_BYTES_ENV,
      CODE_GRAPH_PARSER_RSS_BYTES_MAXIMUM,
    ),
  };
}

function parserWorkerByteMaximum(environment: ParserWorkerEnvironment, name: string, fallback: number): number {
  const configured = Number.parseInt(environment[name] ?? '', 10);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(fallback, configured) : fallback;
}

function parserWorkerResourceSnapshot(system: SystemInfoShape): ParserWorkerResourceSnapshot {
  const usage = system.memoryUsage();
  return {
    peakRssBytes: nonNegativeSafeInteger(usage.peakRss ?? usage.rss, usage.rss),
    rssBytes: nonNegativeSafeInteger(usage.rss, 0),
  };
}

function parserWorkerFailureSummary(reason: ParserWorkerFailureReason): string {
  switch (reason) {
    case 'abort':
      return 'parser request was interrupted';
    case 'allocation':
      return 'per-file allocation exceeded its byte budget';
    case 'exit':
      return 'parser worker exited unexpectedly';
    case 'operation':
      return 'language extraction failed';
    case 'protocol':
      return 'parser worker protocol failed';
    case 'rss':
      return 'parser worker RSS exceeded its byte budget';
    case 'source-bytes':
      return 'source exceeded its per-file byte budget';
    case 'symbols':
      return 'emitted symbols exceeded their per-file budget';
    case 'fact-bytes':
      return 'emitted facts exceeded their per-file byte budget';
    case 'spawn':
      return 'parser worker could not start';
    case 'timeout':
      return 'parser request exceeded its time budget';
    case 'write':
      return 'parser worker input failed';
  }
}

function parserWorkerFailureReason(value: unknown): value is ParserWorkerFailureReason {
  return (
    value === 'abort' ||
    value === 'allocation' ||
    value === 'exit' ||
    value === 'fact-bytes' ||
    value === 'operation' ||
    value === 'protocol' ||
    value === 'rss' ||
    value === 'source-bytes' ||
    value === 'spawn' ||
    value === 'symbols' ||
    value === 'timeout' ||
    value === 'write'
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}

function nonNegativeSafeInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function tokens(value: string): readonly string[] {
  return EffectArray.filter(
    EffectArray.map(
      Effect2.pipe(value, EffectString.replace(/([a-z0-9])([A-Z])/g, '$1 $2'), EffectString.split(/[^A-Za-z0-9]+/)),
      token => Effect2.pipe(token, EffectString.toLowerCase),
    ),
    token => token.length >= 2,
  );
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(EffectArray.filter(values, Boolean))];
}
