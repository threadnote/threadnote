import {SecureRandom} from 'effect/crypto';
import {Array as EffectArray} from 'effect';
import {Context, Effect, FileSystem, Layer, Option, Path, Predicate, Queue, Stdio, Stream, Schema, Scope} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fromPromise, fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  SystemInfo,
  runtimeSpawnOwnedProviderTree,
  runtimeObserveOwnedProviderTree,
  runtimeObserveOwnedProviderResources,
  runtimeTerminateOwnedProviderTree,
  runtimeCloseOwnedProviderTree,
  platformPathFor,
  type SystemInfoShape,
} from '@threadnote/platform/system';
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
import {
  createNativeTypeScriptSession,
  connectNativeTypeScriptPipeSession,
  nativeTypeScriptSessionOwnership,
  nativeTypeScriptOwnershipUnknown,
  NativeTypeScriptSessionService,
  isNativeTypeScriptSource,
  type NativeTypeScriptSession,
  NativeTypeScriptUnavailable,
  boundedNativeTypeScriptSession,
} from './typescript_runtime.js';
import type {CodeGraphSourceSequenceOutcome, CodeGraphSourceSequenceRequest} from './query/diagram_sequence.js';
import {
  decodeSourceSequenceRequest,
  decodeSourceSequenceResponse,
  PARSER_WORKER_PROTOCOL_VERSION,
  projectParserWorkerSourceSequence,
  sourceSequenceUnavailable,
  type ParserWorkerSourceSequenceRequest,
  type ParserWorkerSourceSequenceResponse,
} from './parser_worker_sequence.js';
import {NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV} from './typescript_native_asset_pins.js';
import {
  currentHardwareConcurrency,
  explicitParserWorkerCapacity,
  nativeParserWorkerCapacity,
  parserWorkerCapacity,
  type CodeGraphParserLanePlan,
  type ParserWorkerEnvironment,
} from './parser_worker_capacity.js';

export {CODE_GRAPH_PARSER_WORKER_ARGUMENT};
export {
  CODE_GRAPH_NATIVE_PARSER_WORKERS_ENV,
  CODE_GRAPH_PARSER_WORKERS_ENV,
  nativeParserWorkerCapacity,
  parserWorkerCapacity,
  plannedGeneralParserLanes,
  warmPlannedParserCapacity,
  type CodeGraphParserLanePlan,
  type ParserWorkerCapacityInput,
} from './parser_worker_capacity.js';
export const CODE_GRAPH_PARSER_TIMEOUT_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS';
export const CODE_GRAPH_PARSER_IDLE_TIMEOUT_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS';
export const CODE_GRAPH_PARSER_ALLOCATION_BYTES_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_ALLOCATION_BYTES_MAX';
export const CODE_GRAPH_PARSER_RSS_BYTES_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_RSS_BYTES_MAX';
export const CODE_GRAPH_PARSER_WORKER_RESPONSE_BYTES_MAXIMUM = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM + 4 * 1_024;
export const CODE_GRAPH_PARSER_SOURCE_BYTES_MAXIMUM = 16 * 1_048_576;
export const CODE_GRAPH_PARSER_SYMBOLS_MAXIMUM = 4_000;
export const CODE_GRAPH_PARSER_ALLOCATION_BYTES_MAXIMUM = 512 * 1_048_576;
export const CODE_GRAPH_PARSER_RSS_BYTES_MAXIMUM = 2 * 1_024 * 1_024 * 1_024;

const PROTOCOL_VERSION = PARSER_WORKER_PROTOCOL_VERSION;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 60_000;
const MAX_PROTOCOL_LINE_BYTES = 256 * 1_048_576;
const STDERR_BYTES_LIMIT = 32 * 1_024;
const WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS = 500;
const SLOT_RETRY_MILLISECONDS = 25;
const SLOT_STALE_MILLISECONDS = 30_000;
const PARSER_WORKER_PREWARM_CONCURRENCY = 4;
const PARSER_WORKER_WARMUP_SOURCE = '{"__threadnoteParserWarmup":true}\n';
const PARSER_WORKER_WARMUP_FILE: CodeGraphInventoryFile = {
  blobId: '',
  content: PARSER_WORKER_WARMUP_SOURCE,
  contentHash: sha256HexSync(PARSER_WORKER_WARMUP_SOURCE),
  language: 'json',
  mode: '100644',
  path: '.threadnote/parser-warmup.json',
  size: Buffer.byteLength(PARSER_WORKER_WARMUP_SOURCE, 'utf8'),
  source: 'worktree',
};
const PARSER_WORKER_TYPESCRIPT_WARMUP_SOURCE = 'export const __threadnoteParserWarmup = true;\n';
const PARSER_WORKER_TYPESCRIPT_WARMUP_FILE: CodeGraphInventoryFile = {
  blobId: '',
  content: PARSER_WORKER_TYPESCRIPT_WARMUP_SOURCE,
  contentHash: sha256HexSync(PARSER_WORKER_TYPESCRIPT_WARMUP_SOURCE),
  language: 'typescript',
  mode: '100644',
  path: '.threadnote/parser-warmup.ts',
  size: Buffer.byteLength(PARSER_WORKER_TYPESCRIPT_WARMUP_SOURCE, 'utf8'),
  source: 'worktree',
};

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
  readonly cwd: string;
  readonly nativeTypeScript?: boolean;
  readonly startupDeadline?: number;
  readonly compilerAssetDirectory?: string;
}

export type ParserWorkerSpawner = (
  options: ParserWorkerSpawnOptions,
  signal?: AbortSignal,
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

/** A native lane may run a native TypeScript compiler pair; a general lane never does. */
export type CodeGraphParserLane = 'native' | 'general';
export interface CodeGraphParserPoolShape {
  readonly capacity: number;
  /** Slots that may own a native TypeScript compiler; native TypeScript work runs only on them. */
  readonly nativeCapacity: number;
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
    lane?: CodeGraphParserLane,
  ) => Effect.Effect<A, E | ParserWorkerError, R>;
  readonly warm: (
    threadnoteHome: string,
    requestedSlots?: number,
    nativeTypeScript?: boolean,
    /** Warm only the slots of the lanes that planned work runs; every slot when omitted. */
    lanes?: CodeGraphParserLanePlan,
  ) => Effect.Effect<void, ParserWorkerConfigurationError>;
  readonly trimIdle: Effect.Effect<void, never>;
  /**
   * Projects a diagram's source order in a worker that borrows this pool's native TypeScript session. Any worker,
   * session or budget failure, or a `deadline` (wall-clock milliseconds) already passed, is `unavailable`.
   */
  readonly projectSourceSequence: (
    request: CodeGraphSourceSequenceRequest,
    threadnoteHome: string,
    deadline: number,
  ) => Effect.Effect<CodeGraphSourceSequenceOutcome, never>;
}

class ParserWorkerSessionUseError<E> {
  constructor(readonly error: E) {}
}
/** The SDK changed under a public operation: its results are not trusted and are never re-run as degraded. */
class ParserWorkerSdkFenceFailure {
  constructor(readonly error: ParserWorkerError) {}
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
): Layer.Layer<CodeGraphParserPool, never, SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | SystemInfo> {
  return Layer.effect(
    CodeGraphParserPool,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const crypto = yield* SecureRandom.SecureRandom;
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
        const nativeCapacity = nativeParserWorkerCapacity(capacity, environment);
        const generalCapacity = capacity - nativeCapacity;
        const slots = Array.from(
          {length: capacity},
          (_, index) =>
            new ParserWorkerSlot(
              index,
              index < nativeCapacity ? 'native' : 'general',
              system,
              requestTimeoutMilliseconds,
              idleTimeoutMilliseconds,
              maxProtocolLineBytes,
              maxStderrBytes,
              spawnWorker,
            ),
        );
        const nativeAvailable = yield* Queue.unbounded<ParserWorkerSlot>();
        const generalAvailable = yield* Queue.unbounded<ParserWorkerSlot>();
        const queueFor = (lane: CodeGraphParserLane) =>
          lane === 'general' && generalCapacity > 0 ? generalAvailable : nativeAvailable;
        // A slot always returns to the queue of its own role.
        const release = (slot: ParserWorkerSlot) => Queue.offer(queueFor(slot.role), slot);
        // Lowest index first, so a lane reuses the worker it started instead of starting one per idle slot.
        const takeLowest = (lane: CodeGraphParserLane) =>
          Effect.gen(function* () {
            const idle = [yield* Queue.take(queueFor(lane)), ...(yield* Queue.clear(queueFor(lane)))];
            const lowest = EffectArray.reduce(idle, idle[0], (best, slot) => (slot.index < best.index ? slot : best));
            yield* Queue.offerAll(
              queueFor(lane),
              EffectArray.filter(idle, slot => slot !== lowest),
            );
            return lowest;
          }).pipe(Effect.uninterruptible);
        const releaseAll = (idle: readonly ParserWorkerSlot[]) => Effect.forEach(idle, release, {discard: true});
        const clearIdle = Effect.zipWith(
          Queue.clear(nativeAvailable),
          Queue.clear(generalAvailable),
          (native, general) => [...native, ...general].sort((left, right) => left.index - right.index),
        );
        yield* releaseAll(slots);
        // Native and general slots hold separate global lock ranges, so the cross-process total stays at `capacity`.
        const globalSlot = <A, E, R>(slot: ParserWorkerSlot, threadnoteHome: string, effect: Effect.Effect<A, E, R>) =>
          withGlobalParserSlot(crypto, fs, path, system, threadnoteHome, lockRange(slot), slot.index, effect);
        // A worker idle in a lane that planned work never runs only adds resident memory. Native lanes take general
        // work only without general slots, as the materializer schedules them.
        const runsPlannedLane = (slot: ParserWorkerSlot, lanes: CodeGraphParserLanePlan | undefined) =>
          lanes === undefined ||
          (slot.role === 'native'
            ? lanes.native || (lanes.general && generalCapacity === 0)
            : lanes.general && slot.index < nativeCapacity + (lanes.generalSlots ?? generalCapacity));
        const lockRange = (slot: ParserWorkerSlot) =>
          slot.role === 'native' ? {first: 0, count: nativeCapacity} : {first: nativeCapacity, count: generalCapacity};
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
          {readonly required: boolean; readonly warm: boolean; readonly nativeTypeScript: boolean}
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
          const planned = {
            required: workerFiles > 0,
            warm: capacity > 1 && workerFiles > capacity,
            nativeTypeScript: EffectArray.some(
              files,
              file => requiresWorker(file) && isNativeTypeScriptSource(file.path),
            ),
          };
          workPlans.set(files, planned);
          return planned;
        };
        const extractWithoutSlot = (file: CodeGraphInventoryFile) => {
          const budgeted = sourceBudgetResult(file);
          return Effect.succeed(
            budgeted ?? degradedResult(file, ParserWorkerError.of(file.bytes === undefined ? 'protocol' : 'operation')),
          );
        };
        const warmSlot = (slot: ParserWorkerSlot, threadnoteHome: string, nativeTypeScript: boolean) =>
          fromPromiseInterruptibleAwaiting(
            signal => slot.warm(threadnoteHome, signal, nativeTypeScript),
            cause => (Schema.is(ParserWorkerError)(cause) ? cause : ParserWorkerError.of('protocol')),
          );
        const prewarmSlot = (slot: ParserWorkerSlot, threadnoteHome: string, nativeTypeScript: boolean) =>
          fromPromise('warm parser worker', () =>
            slot.warm(threadnoteHome, new AbortController().signal, nativeTypeScript),
          );

        const extract = (file: CodeGraphInventoryFile, threadnoteHome: string) => {
          const budgeted = sourceBudgetResult(file);
          if (budgeted !== undefined) return Effect.succeed(budgeted);
          return Effect.acquireUseRelease(
            takeLowest(isNativeTypeScriptSource(file.path) ? 'native' : 'general'),
            slot =>
              globalSlot(slot, threadnoteHome, extractFromSlot(slot, file, threadnoteHome)).pipe(
                Effect.catch(cause => Effect.succeed(degradedResult(file, cause))),
              ),
            release,
          );
        };

        return {
          service: CodeGraphParserPool.of({
            capacity,
            nativeCapacity,
            extract,
            withParserSlot: (threadnoteHome, files, use, lane = 'general') => {
              const planned = workPlan(files);
              return planned.required
                ? Effect.acquireUseRelease(
                    takeLowest(lane),
                    slot => {
                      // A general lane never warms or upgrades to a native compiler pair.
                      const warmNative = planned.nativeTypeScript && lane === 'native' && slot.role === 'native';
                      return globalSlot(
                        slot,
                        threadnoteHome,
                        slot.withSdkScope(
                          (planned.warm
                            ? warmSlot(slot, threadnoteHome, warmNative).pipe(
                                Effect.asVoid,
                                // A failed native warm only means TypeScript is unavailable here; other files proceed.
                                Effect.catch(error => (warmNative ? Effect.succeed(error) : Effect.fail(error))),
                              )
                            : Effect.void
                          ).pipe(
                            Effect.flatMap(nativeWarmFailure =>
                              use(file =>
                                !isNativeTypeScriptSource(file.path)
                                  ? extractFromSlot(slot, file, threadnoteHome)
                                  : slot.role === 'general'
                                    ? // A native slot never waits for a general one, so this delegation cannot deadlock.
                                      extract(file, threadnoteHome)
                                    : nativeWarmFailure !== undefined
                                      ? Effect.succeed(degradedResult(file, nativeWarmFailure))
                                      : extractFromSlot(slot, file, threadnoteHome),
                              ).pipe(Effect.mapError(error => new ParserWorkerSessionUseError(error))),
                            ),
                          ),
                        ),
                      ).pipe(
                        Effect.catch(error =>
                          error instanceof ParserWorkerSessionUseError
                            ? Effect.fail(error.error)
                            : error instanceof ParserWorkerSdkFenceFailure
                              ? Effect.fail(error.error)
                              : use(file => Effect.succeed(degradedResult(file, error))),
                        ),
                      );
                    },
                    release,
                  )
                : use(extractWithoutSlot);
            },
            warm: (threadnoteHome, requestedSlots = capacity, nativeTypeScript = false, lanes) =>
              Number.isSafeInteger(requestedSlots) && requestedSlots >= 0
                ? Effect.acquireUseRelease(
                    clearIdle,
                    idleSlots =>
                      Effect.forEach(
                        EffectArray.filter(idleSlots, slot => runsPlannedLane(slot, lanes)).slice(
                          0,
                          Math.min(capacity, requestedSlots),
                        ),
                        slot =>
                          globalSlot(
                            slot,
                            threadnoteHome,
                            prewarmSlot(slot, threadnoteHome, nativeTypeScript && slot.role === 'native'),
                          ),
                        {concurrency: PARSER_WORKER_PREWARM_CONCURRENCY, discard: true},
                      ).pipe(Effect.ignore),
                    releaseAll,
                  ).pipe(Effect.asVoid)
                : Effect.fail(
                    ParserWorkerConfigurationError.make({message: 'Code graph parser warm slot count is invalid.'}),
                  ),
            projectSourceSequence: (request, threadnoteHome, deadline) =>
              Date.now() >= deadline || Buffer.byteLength(request.text, 'utf8') > maxSourceBytes
                ? Effect.succeed(sourceSequenceUnavailable)
                : Effect.acquireUseRelease(
                    takeLowest('native'),
                    slot =>
                      globalSlot(slot, threadnoteHome, slot.projectSourceSequence(request, threadnoteHome, deadline)),
                    release,
                  ).pipe(Effect.orElseSucceed(() => sourceSequenceUnavailable)),
            trimIdle: Effect.acquireUseRelease(
              clearIdle,
              idleSlots =>
                Effect.forEach(idleSlots, slot => fromPromise('trim idle parser worker', () => slot.trimIdle()), {
                  concurrency: 'unbounded',
                  discard: true,
                }).pipe(Effect.ignore),
              releaseAll,
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
  crypto: SecureRandom.SecureRandom['Service'],
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
  /** The lock indices of this slot's role: `count` indices from `first`. */
  {first, count}: {readonly first: number; readonly count: number},
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
      Effect.provideService(SecureRandom.SecureRandom, crypto),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SystemInfo, system),
      Effect.asSome,
      Effect.catchIf(isFileLockTimeout, () => Effect.succeedNone),
    );

  return Effect.gen(function* () {
    while (true) {
      for (let offset = 0; offset < count; offset += 1) {
        const acquired = yield* attempt(first + ((preferredSlot - first + offset) % count));
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
  private sdkScope: Map<ParserWorkerConnection, () => Promise<void>> | undefined;

  constructor(
    readonly index: number,
    readonly role: CodeGraphParserLane,
    private readonly system: SystemInfoShape,
    private readonly timeoutMilliseconds: number,
    private readonly idleTimeoutMilliseconds: number,
    private readonly maxProtocolLineBytes: number,
    private readonly maxStderrBytes: number,
    private readonly spawnWorker: ParserWorkerSpawner,
  ) {}

  withSdkScope<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | ParserWorkerSdkFenceFailure, R> {
    return Effect.acquireUseRelease(
      Effect.suspend(() => {
        // A nested scope on one slot is a typed refusal, never a defect.
        if (this.sdkScope) return Effect.fail(new ParserWorkerSdkFenceFailure(ParserWorkerError.of('operation')));
        const scope = new Map<ParserWorkerConnection, () => Promise<void>>();
        this.sdkScope = scope;
        return Effect.succeed(scope);
      }),
      () => effect,
      scope =>
        fromPromiseInterruptibleAwaiting(
          async () => {
            let failure: unknown;
            for (const finish of scope.values()) {
              try {
                await finish();
              } catch (error) {
                failure ??= error;
              }
            }
            if (this.sdkScope === scope) this.sdkScope = undefined;
            if (failure !== undefined) throw failure instanceof Error ? failure : ParserWorkerError.of('protocol');
          },
          cause =>
            new ParserWorkerSdkFenceFailure(
              Schema.is(ParserWorkerError)(cause) ? cause : ParserWorkerError.of('protocol'),
            ),
        ),
    );
  }
  private async enterSdkScope(connection: ParserWorkerConnection): Promise<void> {
    const scope = this.sdkScope;
    if (!scope || scope.has(connection)) return;
    const finish = await connection.sdkFence();
    if (this.sdkScope !== scope) {
      await finish();
      throw ParserWorkerError.of('operation');
    }
    scope.set(connection, finish);
  }

  extract(file: CodeGraphInventoryFile, threadnoteHome: string): Effect.Effect<CodeGraphParserResult, Error> {
    return this.exchange(
      threadnoteHome,
      isNativeTypeScriptSource(file.path),
      undefined,
      async (active, id, signal) => {
        const response = await active.request({file, id, protocol: PROTOCOL_VERSION}, this.timeoutMilliseconds, signal);
        if (!response.ok) throw ParserWorkerError.of('operation');
        return {
          recycle: response.recycle,
          value: {
            ...(response.degradationReason === undefined
              ? response.degraded
                ? {degradationReason: 'operation' as const}
                : {}
              : {degradationReason: response.degradationReason}),
            degraded: response.degraded,
            facts: response.facts,
            parseMilliseconds: response.parseMilliseconds,
          },
        };
      },
      () => {
        if (file.bytes !== undefined) throw ParserWorkerError.of('operation');
      },
    );
  }

  projectSourceSequence(
    sequence: CodeGraphSourceSequenceRequest,
    threadnoteHome: string,
    deadline: number,
  ): Effect.Effect<CodeGraphSourceSequenceOutcome, Error> {
    return this.exchange(threadnoteHome, true, deadline, async (active, id, signal) => {
      const response = await active.requestSourceSequence(
        {deadline, id, protocol: PROTOCOL_VERSION, sequence},
        Math.min(this.timeoutMilliseconds, Math.max(1, deadline - Date.now())),
        signal,
      );
      if (!response.ok) throw ParserWorkerError.of('operation');
      return {recycle: response.recycle, value: response.outcome};
    });
  }

  /** One request on this slot's worker, retried once on a fresh worker after a transport failure. */
  private exchange<A>(
    threadnoteHome: string,
    nativeTypeScript: boolean,
    /** A caller deadline that also ends worker and compiler startup, when it is earlier than the slot timeout. */
    deadline: number | undefined,
    send: (
      active: ParserWorkerConnection,
      id: string,
      signal: AbortSignal,
    ) => Promise<{readonly recycle: boolean; readonly value: A}>,
    refuse?: () => void,
  ): Effect.Effect<A, Error> {
    return fromPromiseInterruptibleAwaiting(
      async signal => {
        if (this.closed) throw ParserWorkerError.of('exit');
        this.cancelIdleEviction();
        try {
          refuse?.();
          for (let attempt = 0; attempt < 2; attempt += 1) {
            let connection = Option.none<ParserWorkerConnection>();
            try {
              // Worker and compiler startup has its own deadline; the request then gets its whole budget.
              const active = await this.activeConnection(
                threadnoteHome,
                nativeTypeScript,
                Math.min(Date.now() + this.timeoutMilliseconds, deadline ?? Number.POSITIVE_INFINITY),
                signal,
              );
              connection = Option.some(active);
              const response = await send(active, `${this.system.processId}-${this.index}-${++this.sequence}`, signal);
              if (response.recycle) await this.discard(active).catch(() => undefined);
              return response.value;
            } catch (cause) {
              if (Option.isSome(connection) && Schema.is(ParserWorkerError)(cause) && cause.reason !== 'operation') {
                await this.discard(connection.value);
              }
              if (
                !Schema.is(ParserWorkerError)(cause) ||
                cause.reason === 'operation' ||
                cause.reason === 'rss' ||
                cause.reason === 'allocation' ||
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
    await this.discard(connection);
  }

  async warm(threadnoteHome: string, signal: AbortSignal, nativeTypeScript = false): Promise<void> {
    if (this.closed) throw ParserWorkerError.of('exit');
    this.cancelIdleEviction();
    let connection = Option.none<ParserWorkerConnection>();
    try {
      const active = await this.activeConnection(
        threadnoteHome,
        nativeTypeScript,
        Date.now() + this.timeoutMilliseconds,
        signal,
      );
      connection = Option.some(active);
      if (Option.contains(this.warmedConnection, active) && !active.closed) return;
      const response = await active.request(
        {
          file: nativeTypeScript ? PARSER_WORKER_TYPESCRIPT_WARMUP_FILE : PARSER_WORKER_WARMUP_FILE,
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

  private async activeConnection(
    threadnoteHome: string,
    nativeTypeScript: boolean,
    deadline: number,
    signal: AbortSignal,
  ): Promise<ParserWorkerConnection> {
    if (this.closed) throw ParserWorkerError.of('exit');
    // Routing keeps native TypeScript off general slots; this keeps the invariant explicit.
    if (nativeTypeScript && this.role === 'general') throw ParserWorkerError.of('operation');
    const eviction = this.evictingConnection;
    if (eviction) await eviction.catch(() => undefined);
    if (this.closed) throw ParserWorkerError.of('exit');
    if (
      Option.isSome(this.connection) &&
      Option.contains(this.connectionHome, threadnoteHome) &&
      !this.connection.value.closed &&
      (!nativeTypeScript || this.connection.value.nativeTypeScript)
    ) {
      await this.enterSdkScope(this.connection.value);
      return this.connection.value;
    }
    if (Option.isSome(this.connection)) await this.discard(this.connection.value);
    let worker: ParserWorkerProcess;
    try {
      worker = await this.spawnWorker(
        {
          ...parserWorkerSpawnOptions(this.system, threadnoteHome),
          nativeTypeScript,
          startupDeadline: deadline,
        },
        signal,
      );
    } catch {
      throw ParserWorkerError.of('spawn');
    }
    const connection = new ParserWorkerConnection(
      worker,
      this.maxProtocolLineBytes,
      this.maxStderrBytes,
      nativeTypeScript,
      parserWorkerResourceOptions(this.system.environment()),
    );
    if (this.closed) {
      await connection.close();
      throw ParserWorkerError.of('exit');
    }
    this.connection = Option.some(connection);
    this.connectionHome = Option.some(threadnoteHome);
    await this.enterSdkScope(connection);
    return connection;
  }

  private async discard(connection: ParserWorkerConnection): Promise<void> {
    try {
      await connection.close();
    } catch (cause) {
      this.closed = true;
      this.connection = Option.some(connection);
      throw cause;
    }
    if (Option.isSome(this.connection) && this.connection.value === connection) {
      this.connection = Option.none();
      this.connectionHome = Option.none();
      this.warmedConnection = Option.none();
    }
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
      void this.evictConnection(connection).catch(() => undefined);
    }, this.idleTimeoutMilliseconds);
    this.idleTimer.unref?.();
  }

  private async evictConnection(connection: ParserWorkerConnection): Promise<void> {
    const eviction = this.discard(connection);
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
  /** Buffer prefix already known to contain no newline. */
  private scannedLength = 0;
  private isClosed = false;
  private readonly decoder = new TextDecoder();
  private readonly reader: AsyncIterator<string | Uint8Array>;
  private stderrBytes = 0;
  private readonly stderrDone: Promise<void>;
  private finishing: Promise<void> | undefined;
  private readonly sdkFences = new Set<object>();

  constructor(
    private readonly worker: ParserWorkerProcess,
    private readonly maxProtocolLineBytes: number,
    private readonly maxStderrBytes: number,
    readonly nativeTypeScript: boolean,
    private readonly resourceOptions: ParserWorkerResourceBudgetOptions,
  ) {
    this.reader = worker.stdout[Symbol.asyncIterator]();
    this.stderrDone = this.consumeStderr(worker.stderr);
    void this.stderrDone.catch(() => undefined);
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
    const decoded = decodeResponse(
      await this.exchangeLine(request, timeoutMilliseconds, signal),
      request.id,
      request.file.path,
    );
    if (decoded === undefined) throw ParserWorkerError.of('protocol');
    return decoded;
  }

  async requestSourceSequence(
    request: ParserWorkerSourceSequenceRequest,
    timeoutMilliseconds: number,
    signal: AbortSignal,
  ): Promise<ParserWorkerSourceSequenceResponse> {
    const decoded = decodeSourceSequenceResponse(
      parseParserWorkerLine(await this.exchangeLine(request, timeoutMilliseconds, signal)),
      request.id,
    );
    if (decoded === undefined) throw ParserWorkerError.of('protocol');
    return decoded;
  }

  private async exchangeLine(
    request: ParserWorkerRequest | ParserWorkerSourceSequenceRequest,
    timeoutMilliseconds: number,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw ParserWorkerError.of('abort');
    if (timeoutMilliseconds <= 0) throw ParserWorkerError.of('timeout');
    const encoded = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > this.maxProtocolLineBytes) {
      throw ParserWorkerError.of('protocol');
    }
    return raceWorkerResponse(this.ownedWriteAndRead(encoded), timeoutMilliseconds, signal, () => {
      try {
        this.worker.kill();
      } catch {
        // The worker may have exited while the deadline or interrupt fired.
      }
    });
  }

  close(): Promise<void> {
    return (this.finishing ??= this.finish());
  }

  private async finish(): Promise<void> {
    this.isClosed = true;
    const deadline = performance.now() + WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS;
    const input = Promise.resolve().then(() => this.worker.closeInput());
    const graceful = input.then(() => this.worker.exited);
    // Reserve part of the existing close budget for original-owner kill and its completion proof.
    const closedGracefully = await completesBeforeDeadline(graceful, Math.max(0, deadline - performance.now() - 100));
    if (!closedGracefully) this.kill();
    const completion = Promise.all([
      this.worker.exited,
      this.stderrDone,
      Promise.resolve().then(() => this.reader.return?.()),
    ]);
    if (!(await completesBeforeDeadline(completion, Math.max(0, deadline - performance.now())))) {
      nativeParserWorkerUnknown.get(this.worker)?.();
      throw ParserWorkerError.of('exit');
    }
  }

  async sdkFence(): Promise<() => Promise<void>> {
    const owner = nativeParserResourceOwners.get(this.worker);
    if (!owner) return async () => undefined;
    await owner.verifyCurrent();
    const fence = Object.freeze({});
    this.sdkFences.add(fence);
    return async () => {
      try {
        await owner.verifyCurrent();
      } finally {
        this.sdkFences.delete(fence);
      }
    };
  }

  private async ownedWriteAndRead(encoded: string): Promise<string> {
    const owner = nativeParserResourceOwners.get(this.worker);
    if (!owner) return this.writeAndRead(encoded);
    if (this.sdkFences.size === 0) await owner.verifyCurrent();
    owner.assertCurrent();
    const before = owner.resources();
    const response = await this.writeAndRead(encoded);
    const after = owner.resources();
    const rejected = parserWorkerResourceBudget(before, after, this.resourceOptions);
    if (rejected) throw ParserWorkerError.of(rejected.code === 'rss-bytes' ? 'rss' : 'allocation', rejected);
    owner.assertCurrent();
    if (this.sdkFences.size === 0) await owner.verifyCurrent();
    return response;
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
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Resuming the search position keeps framing linear; Effect String indexOf has no position parameter.
      const newline = this.buffer.indexOf('\n', this.scannedLength);
      if (newline >= 0) {
        const line = Effect2.pipe(this.buffer, EffectString.slice(0, newline), EffectString.replace(/\r$/, ''));
        this.buffer = Effect2.pipe(this.buffer, EffectString.slice(newline + 1));
        this.bufferBytes = Buffer.byteLength(this.buffer, 'utf8');
        this.scannedLength = 0;
        return line;
      }
      this.scannedLength = this.buffer.length;
      let chunk: IteratorResult<string | Uint8Array>;
      try {
        chunk = await this.reader.next();
      } catch {
        throw ParserWorkerError.of('exit');
      }
      if (chunk.done) throw ParserWorkerError.of('exit');
      this.bufferBytes +=
        typeof chunk.value === 'string' ? Buffer.byteLength(chunk.value, 'utf8') : chunk.value.byteLength;
      if (this.bufferBytes > this.maxProtocolLineBytes) throw ParserWorkerError.of('protocol');
      this.buffer += typeof chunk.value === 'string' ? chunk.value : this.decoder.decode(chunk.value, {stream: true});
    }
  }

  private async consumeStderr(stream: AsyncIterable<string | Uint8Array>): Promise<void> {
    for await (const chunk of stream) {
      if (this.stderrBytes >= this.maxStderrBytes) continue;
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      this.stderrBytes += Math.min(bytes, this.maxStderrBytes - this.stderrBytes);
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

// A failed original-owner completion remains charged for this process lifetime. Recreating
// a pool cannot turn an unobserved child into capacity for unbounded replacement workers.
let parserWorkerOwnershipUnknown = false;
/**
 * A `tsc --api` close that failed with its owner drained (slow or nonzero exit, stray output) is that session's own
 * anomaly. Only an owner the runtime could not prove gone blocks every later parser worker, of any language.
 */
const chargeUnknownCompilerOwner = () => {
  if (nativeTypeScriptOwnershipUnknown()) parserWorkerOwnershipUnknown = true;
};
const nativeParserWorkerUnknown = new WeakMap<ParserWorkerProcess, () => void>();
const nativeParserResourceOwners = new WeakMap<
  ParserWorkerProcess,
  {verifyCurrent(): Promise<void>; assertCurrent(): void; resources(): ParserWorkerResourceSnapshot}
>();
async function spawnBunParserWorker(
  options: ParserWorkerSpawnOptions,
  signal?: AbortSignal,
): Promise<ParserWorkerProcess> {
  if (parserWorkerOwnershipUnknown) throw ParserWorkerError.of('exit');
  const startupDeadline = options.startupDeadline ?? Date.now() + DEFAULT_REQUEST_TIMEOUT_MILLISECONDS;
  if (signal?.aborted) throw ParserWorkerError.of('abort');
  if (!Number.isFinite(startupDeadline) || startupDeadline <= Date.now()) throw ParserWorkerError.of('timeout');
  const {cwd} = options;
  const compiler = options.nativeTypeScript
    ? await createNativeTypeScriptSession({
        cwd,
        deadline: startupDeadline,
        ...(signal === undefined ? {} : {startupSignal: signal}),
        assetDirectory: options.compilerAssetDirectory,
      })
    : undefined;
  const compilerOwner = compiler === undefined ? undefined : nativeTypeScriptSessionOwnership(compiler);
  let child: ReturnType<typeof runtimeSpawnOwnedProviderTree>;
  try {
    if (signal?.aborted) throw ParserWorkerError.of('abort');
    if (!Number.isFinite(startupDeadline) || startupDeadline <= Date.now()) throw ParserWorkerError.of('timeout');
    child = runtimeSpawnOwnedProviderTree({
      command: options.executable,
      args: options.arguments,
      cwd,
      environment: {
        ...options.environment,
        ...(compilerOwner
          ? {
              THREADNOTE_NATIVE_TYPESCRIPT_PIPE: compilerOwner.pipe,
              THREADNOTE_NATIVE_TYPESCRIPT_DIRECTORY: compilerOwner.endpointDirectory,
              THREADNOTE_NATIVE_TYPESCRIPT_SDK: compilerOwner.sdkDirectory,
            }
          : {}),
      },
    });
  } catch (error) {
    await compiler?.close().catch(chargeUnknownCompilerOwner);
    throw error;
  }
  let retainedUnknown = false;
  const exited = (async () => {
    try {
      for (;;) {
        if (retainedUnknown) throw ParserWorkerError.of('exit');
        const observation = runtimeObserveOwnedProviderTree(child.handle);
        if (observation.state === 'unknown') throw ParserWorkerError.of('exit');
        if (observation.state === 'drained') {
          if (!observation.stdioClosed || observation.leaderExitCode === null) throw ParserWorkerError.of('exit');
          runtimeCloseOwnedProviderTree(child.handle);
          return observation.leaderExitCode;
        }
        await Bun.sleep(5);
      }
    } finally {
      // The `tsc --api` owner is closed on every outcome, including an unknown worker state.
      await compiler?.close().catch(chargeUnknownCompilerOwner);
    }
  })();
  void exited.catch(() => {
    // Do not close/release an owner whose original process/group/stdio proof is unknown.
    parserWorkerOwnershipUnknown = true;
  });
  const worker: ParserWorkerProcess = {
    closeInput: child.closeInput,
    exited,
    kill: () => runtimeTerminateOwnedProviderTree(child.handle, 'kill'),
    stderr: child.stderr,
    stdout: child.stdout,
    write: line => child.write(new TextEncoder().encode(line)),
  };
  nativeParserResourceOwners.set(worker, {
    verifyCurrent: async () => {
      await compilerOwner?.verifyCurrent();
    },
    assertCurrent: () => {
      if (runtimeObserveOwnedProviderTree(child.handle).state !== 'running') throw ParserWorkerError.of('exit');
      compilerOwner?.assertCurrent();
    },
    resources: () => {
      const owners = compilerOwner ? [child.handle, compilerOwner.owner] : [child.handle];
      let rssBytes = 0,
        peakRssBytes = 0;
      for (const handle of owners) {
        const resource = runtimeObserveOwnedProviderResources(handle);
        if (resource.state !== 'known') throw ParserWorkerError.of('exit');
        rssBytes += resource.currentRssBytes;
        peakRssBytes += resource.peakRssUpperBoundBytes;
      }
      if (!Number.isSafeInteger(rssBytes) || !Number.isSafeInteger(peakRssBytes)) throw ParserWorkerError.of('exit');
      // POSIX is an attested closed parser/API pair of original processes, not a generic subtree census.
      return {rssBytes, peakRssBytes};
    },
  });
  nativeParserWorkerUnknown.set(worker, () => {
    retainedUnknown = true;
    parserWorkerOwnershipUnknown = true;
  });
  return worker;
}

/**
 * A compiled executable only ever uses its packaged `runtime/typescript`; the source-mode prepared-asset variable is
 * ignored there. Source mode reads that variable through SystemInfo and has no other fallback.
 */
function nativeTypeScriptAssetDirectory(
  system: SystemInfoShape,
  script: Option.Option<string>,
): {readonly compilerAssetDirectory?: string} {
  if (Option.isNone(script)) {
    const path = platformPathFor(system.platform);
    return {compilerAssetDirectory: path.join(path.dirname(system.executablePath), 'runtime', 'typescript')};
  }
  const prepared = system.environment()[NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV];
  return prepared ? {compilerAssetDirectory: prepared} : {};
}

function parserWorkerSpawnOptions(system: SystemInfoShape, threadnoteHome: string): ParserWorkerSpawnOptions {
  const script = developmentStandaloneScript(system);
  return {
    arguments: [...Option.toArray(script), CODE_GRAPH_PARSER_WORKER_ARGUMENT],
    cwd: system.currentDirectory(),
    ...nativeTypeScriptAssetDirectory(system, script),
    environment: {
      ...system.intendedChildEnvironment(system.environment(), 'parser-worker'),
      THREADNOTE_NATIVE_TYPESCRIPT_PIPE: undefined,
      THREADNOTE_NATIVE_TYPESCRIPT_DIRECTORY: undefined,
      THREADNOTE_NATIVE_TYPESCRIPT_SDK: undefined,
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
        () => false,
      ),
      timeoutDeferred.promise,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export const codeGraphParserWorkerServer: Effect.Effect<
  void,
  never,
  Stdio.Stdio | SystemInfo | TreeSitterRuntime | Scope.Scope
> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const system = yield* SystemInfo;
  const treeSitter = yield* TreeSitterRuntime;
  const environment = system.environment();
  const pipe = environment.THREADNOTE_NATIVE_TYPESCRIPT_PIPE;
  const endpointDirectory = environment.THREADNOTE_NATIVE_TYPESCRIPT_DIRECTORY;
  const sdkDirectory = environment.THREADNOTE_NATIVE_TYPESCRIPT_SDK;
  if (
    (pipe === undefined) !== (endpointDirectory === undefined) ||
    (pipe === undefined) !== (sdkDirectory === undefined)
  )
    // A partial parent-owned API environment is a composition defect, never a silent non-native worker.
    return yield* Effect.die(new Error('Parser worker native TypeScript environment is incomplete.'));
  const nativeSession =
    pipe !== undefined && endpointDirectory !== undefined && sdkDirectory !== undefined
      ? yield* Effect.acquireRelease(
          fromPromise('connect parent-owned TypeScript API', () =>
            connectNativeTypeScriptPipeSession({
              pipe,
              endpointDirectory,
              sdkDirectory,
              deadline: Date.now() + parserWorkerTimeout(environment),
            }),
          ),
          session => fromPromise('close borrowed TypeScript API', () => session.close()).pipe(Effect.ignore),
        )
      : undefined;
  const decoder = new TextDecoder();
  let buffered = '';
  let bufferedBytes = 0;
  let scannedLength = 0;

  const writeResponse = (response: ParserWorkerResponse | ParserWorkerSourceSequenceResponse) =>
    Stream.run(Stream.make(encodeParserWorkerResponse(response)), stdio.stdout({endOnDone: false}));

  // Once the borrowed session fails, every later response asks the parent to discard this worker.
  const nativeState = {failed: false};
  const processLine = (line: string) =>
    handleParserWorkerLine(line, treeSitter, system, nativeSession, nativeState).pipe(Effect.flatMap(writeResponse));

  yield* stdio.stdin.pipe(
    Stream.runForEach(chunk =>
      Effect.gen(function* () {
        bufferedBytes += chunk.byteLength;
        buffered += decoder.decode(chunk, {stream: true});
        for (;;) {
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Resuming the search position keeps framing linear; Effect String indexOf has no position parameter.
          const newline = buffered.indexOf('\n', scannedLength);
          if (newline < 0) {
            scannedLength = buffered.length;
            break;
          }
          scannedLength = 0;
          const lineWithNewline = Effect2.pipe(buffered, EffectString.slice(0, newline + 1));
          const line = Effect2.pipe(lineWithNewline, __effectPipeInput => {
            const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.slice(0, -1));
            const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.replace(/\r$/, ''));
            return __effectPipeStage1;
          });
          bufferedBytes -= Buffer.byteLength(lineWithNewline, 'utf8');
          buffered = Effect2.pipe(buffered, EffectString.slice(newline + 1));
          if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
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
  if (Buffer.byteLength(buffered, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
    return yield* ParserWorkerError.of('protocol');
  }
  if (Effect2.pipe(buffered, EffectString.trim)) yield* processLine(Effect2.pipe(buffered, EffectString.trim));
}).pipe(Effect.ignore);

function handleParserWorkerLine(
  line: string,
  treeSitter: TreeSitterRuntimeShape,
  system: SystemInfoShape,
  nativeSession?: NativeTypeScriptSession,
  nativeState: {failed: boolean} = {failed: false},
): Effect.Effect<ParserWorkerResponse | ParserWorkerSourceSequenceResponse, never> {
  const value = parseParserWorkerLine(line);
  if (Predicate.isObject(value) && 'sequence' in value)
    return handleSourceSequenceRequest(decodeSourceSequenceRequest(value), system, nativeSession, nativeState);
  const request = decodeRequest(value);
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
      recycle: bounded.degraded || nativeState.failed,
    };
  };
  const observed = observeNativeSessionFailure(nativeState);
  const deadline = Date.now() + parserWorkerTimeout(system.environment());
  const extract = BUILTIN_LANGUAGE_PACK_REGISTRY.extractRawFile(request.file);
  const bounded =
    nativeSession === undefined
      ? extract
      : extract.pipe(
          Effect.provideService(
            NativeTypeScriptSessionService,
            boundedNativeTypeScriptSession(nativeSession, deadline, observed),
          ),
        );
  return bounded.pipe(
    Effect.provideService(TreeSitterRuntime, treeSitter),
    Effect.match({
      onFailure: () => completedResponse(undefined),
      onSuccess: completedResponse,
    }),
  );
}

/** Once the borrowed session fails, later responses ask the parent to discard this worker. */
function observeNativeSessionFailure(nativeState: {failed: boolean}) {
  return <A>(operation: Promise<A>): Promise<A> =>
    operation.catch((error: unknown) => {
      // A request refused before it was sent (oversized input, expired budget) leaves the borrowed session healthy.
      if (Schema.is(NativeTypeScriptUnavailable)(error) && error.reason !== 'input-budget') nativeState.failed = true;
      throw error;
    });
}

function handleSourceSequenceRequest(
  request: ParserWorkerSourceSequenceRequest | undefined,
  system: SystemInfoShape,
  nativeSession: NativeTypeScriptSession | undefined,
  nativeState: {failed: boolean},
): Effect.Effect<ParserWorkerSourceSequenceResponse, never> {
  if (request === undefined) return Effect.succeed(protocolFailure('invalid', 'Invalid parser worker request.'));
  // The parent sends source order only to a native worker; a worker without the session cannot answer it.
  if (nativeSession === undefined)
    return Effect.succeed(protocolFailure(request.id, 'Native TypeScript is unavailable.'));
  const resourceBefore = parserWorkerResourceSnapshot(system);
  const deadline = Date.now() + parserWorkerTimeout(system.environment());
  const observe = observeNativeSessionFailure(nativeState);
  return fromPromise('project diagram source order', () =>
    projectParserWorkerSourceSequence(request, nativeSession, deadline, observe),
  ).pipe(
    Effect.orElseSucceed(() => sourceSequenceUnavailable),
    Effect.map((outcome): ParserWorkerSourceSequenceResponse => {
      const resources = parserWorkerResourceSnapshot(system);
      const options = parserWorkerResourceOptions(system.environment());
      const exhausted = parserWorkerResourceBudget(resourceBefore, resources, options) !== undefined;
      const recycle = exhausted || nativeState.failed;
      const shown = exhausted ? sourceSequenceUnavailable : outcome;
      return {id: request.id, ok: true, outcome: shown, protocol: PROTOCOL_VERSION, recycle};
    }),
  );
}

function parseParserWorkerLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function decodeRequest(value: unknown): ParserWorkerRequest | undefined {
  try {
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
  return Buffer.byteLength(
    `${JSON.stringify({degraded: false, facts, id, ok: true, parseMilliseconds: 0, protocol: PROTOCOL_VERSION, recycle: false})}\n`,
    'utf8',
  );
}

function encodeParserWorkerResponse(response: ParserWorkerResponse | ParserWorkerSourceSequenceResponse): string {
  const line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line, 'utf8') <= CODE_GRAPH_PARSER_WORKER_RESPONSE_BYTES_MAXIMUM) return line;
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
