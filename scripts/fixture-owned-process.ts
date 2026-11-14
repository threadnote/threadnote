// oxlint-disable-next-line threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Direct child handles and close events are required for fixture-only producer exit proof.
import {spawn, type ChildProcess} from 'node:child_process';
import {dlopen} from 'bun:ffi';
import {Array as EffectArray, Option, Console, Effect, FileSystem, Path} from 'effect';
import * as EffectString from 'effect/String';
import {fixturePipelineReceiptProvesExit} from '@threadnote/testing/fixture-pipeline-receipt';
import {ReadBuffer, serializeMessage} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {FixtureProducers, type FixtureProducerObservation} from '@threadnote/testing/fixture-producers';
import {projectAnonymousTelemetryDiagnostic} from '@threadnote/threadnote/telemetry/diagnostic';
import {
  LOCAL_MODEL_WORKER_ARGUMENT,
  projectLocalModelWorkerExitObservation,
} from '@threadnote/threadnote/effect/ai/isolated-local-model-runtime';
import type {LocalEmbeddingRequest} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';
import {readModelSelection, selectedEmbeddingModelId} from '@threadnote/inference/models/selection';
import {sha256Hex} from '@threadnote/platform/digest';
import {ScriptError} from './effect/errors.js';

interface FixtureChild {
  readonly stdin: ChildProcess['stdin'];
  readonly stdout: ChildProcess['stdout'];
  readonly stderr: ChildProcess['stderr'];
  once(event: 'spawn' | 'close', listener: () => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}
type FixtureLaunch = (
  command: string,
  args: readonly string[],
  options: {cwd: string; env: NodeJS.ProcessEnv},
) => FixtureChild;

const launchChild: FixtureLaunch = (command, args, options) =>
  spawn(command, [...args], {...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});

export class FixtureProcesses {
  readonly registry = new FixtureProducers();
  private readonly children: FixtureChild[] = [];
  private closed = false;
  constructor(
    private readonly launch: FixtureLaunch = launchChild,
    private readonly epochDeadline = Number.POSITIVE_INFINITY,
    private readonly monotonicDeadline = Number.POSITIVE_INFINITY,
  ) {}

  remaining(deadline: number): number {
    const monotonic = deadline - performance.now();
    return Number.isFinite(this.epochDeadline)
      ? Math.min(monotonic, this.epochDeadline - Date.now() + deadline - this.monotonicDeadline)
      : monotonic;
  }

  wait(deadline: number, operation: Promise<void>): Promise<void> {
    return fixtureDeadline(() => this.remaining(deadline), operation);
  }

  spawn(command: string, args: readonly string[], options: {cwd: string; env: NodeJS.ProcessEnv}): FixtureChild {
    if (this.closed) throw new Error('Fixture process registration closed');
    const observation = this.registry.register();
    let child: FixtureChild;
    try {
      child = this.launch(command, args, options);
    } catch (error) {
      observation.failed();
      throw error;
    }
    this.children.push(child);
    child.once('spawn', observation.spawned);
    child.once('exit', observation.exited);
    child.once('close', observation.closed);
    child.on('error', observation.failed);
    return child;
  }

  async closeAndObserve(deadline: number): Promise<'exited' | 'unknown'> {
    this.closed = true;
    for (const child of this.children)
      if (child.stdin && !child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end();
    while (this.remaining(deadline) > 0) {
      if (EffectArray.every(this.registry.seal(), result => result.state === 'exited')) return 'exited';
      await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(0, this.remaining(deadline)))));
    }
    // No process is signalled. Unref unfinished handles so an unknown fixture can be reported.
    for (const child of this.children) {
      child.unref();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    return 'unknown';
  }
}

interface FixtureEmbeddingProbeChild {
  readonly pid?: number;
  readonly stdin: {
    write(text: string): number | Promise<number>;
    flush(): number | Promise<number>;
    end(): void | number | Promise<void | number>;
  };
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  readonly exited: Promise<number>;
  readonly signalCode: NodeJS.Signals | number | null;
  kill(signal: NodeJS.Signals): void;
  unref(): void;
}

export const FIXTURE_EMBEDDING_PROBE_SAMPLE = 'short-single-input-control' as const;

interface FixtureWindowsExitLibrary {
  readonly symbols: {
    OpenProcess(access: number, inherit: number, processId: number): bigint;
    GetExitCodeProcess(handle: bigint, output: Uint32Array): number;
    CloseHandle(handle: bigint): number;
  };
  close(): void;
}

/** Fixture-only: Bun's Windows exitCode is a low byte; retain a query-only native handle. */
export function createFixtureWindowsExitObserver(
  load: () => FixtureWindowsExitLibrary = () =>
    dlopen('kernel32.dll', {
      OpenProcess: {args: ['u32', 'i32', 'u32'], returns: 'u64'},
      GetExitCodeProcess: {args: ['u64', 'buffer'], returns: 'i32'},
      CloseHandle: {args: ['u64'], returns: 'i32'},
    }),
) {
  let library: FixtureWindowsExitLibrary;
  try {
    library = load();
  } catch {
    return undefined;
  }
  let handle: bigint | undefined;
  let disposed = false,
    pinned = false,
    queried = false;
  return {
    pin(processId: number | undefined): void {
      if (disposed || pinned) return;
      pinned = true;
      if (processId === undefined || !Number.isInteger(processId) || processId <= 0 || processId > 0xffffffff) return;
      try {
        const value = library.symbols.OpenProcess(0x1000, 0, processId);
        if (value !== 0n) handle = value;
      } catch {
        /* Unavailable observation remains unknown. */
      }
    },
    read(): number | undefined {
      if (disposed || queried || handle === undefined) return undefined;
      queried = true;
      try {
        const output = new Uint32Array(1);
        return library.symbols.GetExitCodeProcess(handle, output) !== 0 ? output[0] : undefined;
      } catch {
        return undefined;
      }
    },
    close(): void {
      if (disposed) return;
      disposed = true;
      try {
        if (handle !== undefined) library.symbols.CloseHandle(handle);
      } catch {
        /* Observation cleanup must not replace the original repair failure. */
      } finally {
        try {
          library.close();
        } catch {
          /* No native library or error value escapes the fixture. */
        }
      }
    },
  };
}

type FixtureWindowsExitObserver = NonNullable<ReturnType<typeof createFixtureWindowsExitObserver>>;

/** Expected setup failure is diagnostic only; external interruption still propagates. */
export const diagnoseFixtureEmbeddingFailure = Effect.fn('fixture.diagnoseEmbeddingFailure')(function* (
  processes: FixtureProcesses,
  executable: string,
  options: {
    home: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    deadline: number;
    bodyDeadline: number;
    maxOutputBytes: number;
  },
) {
  const remaining = processes.remaining(options.deadline);
  if (options.deadline >= options.bodyDeadline || remaining <= 0) {
    yield* Console.error(
      `Standalone model worker probe: ${JSON.stringify({sample: FIXTURE_EMBEDDING_PROBE_SAMPLE, outcome: 'no-budget'})}`,
    );
    return undefined;
  }
  const prepare = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = Option.getOrUndefined(
      EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === CORE_EMBEDDING_MODEL_ID),
    );
    const selected = selectedEmbeddingModelId(yield* readModelSelection(options.home), 'recall');
    if (!manifest || (selected !== undefined && selected !== manifest.id))
      return yield* ScriptError.make({message: 'Probe model selection differs.'});
    const modelPath = path.join(options.home, 'models', manifest.role, manifest.id, `${manifest.sha256}.gguf`);
    if (
      Number((yield* fs.stat(modelPath)).size) !== manifest.size ||
      (yield* sha256Hex(yield* fs.readFile(modelPath))) !== manifest.sha256
    )
      return yield* ScriptError.make({message: 'Probe model is not verified.'});
    const inputs = [`${manifest.promptPrefixes?.document ?? ''}QZ9 standalone short embedding control.`];
    const nativeExit = yield* Effect.acquireRelease(
      Effect.sync(() => (process.platform === 'win32' ? createFixtureWindowsExitObserver() : undefined)),
      observer => Effect.sync(() => observer?.close()),
    );
    return {request: {inputs, manifest, modelPath}, nativeExit};
  });
  return yield* prepare.pipe(
    // This is the remaining original absolute budget, including selection, I/O and hashing.
    Effect.timeoutOrElse({
      duration: Math.max(0, processes.remaining(options.deadline)),
      orElse: () => ScriptError.make({message: 'Probe setup deadline expired.'}),
    }),
    Effect.flatMap(({request, nativeExit}) =>
      Effect.tryPromise({
        try: () => runFixtureEmbeddingExitProbe(processes, executable, request, {...options, nativeExit}),
        catch: () => ScriptError.make({message: 'Probe unavailable.'}),
      }),
    ),
    Effect.catch(() =>
      Console.error(
        `Standalone model worker probe: ${JSON.stringify({sample: FIXTURE_EMBEDDING_PROBE_SAMPLE, outcome: 'setup-unavailable'})}`,
      ).pipe(Effect.as(undefined)),
    ),
    Effect.scoped,
  );
});

/** One failure-only request; the existing registry guards removal until actual exit and pipe closure. */
export async function runFixtureEmbeddingExitProbe(
  processes: FixtureProcesses,
  executable: string,
  request: LocalEmbeddingRequest,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    deadline: number;
    maxOutputBytes: number;
    spawn?: () => FixtureEmbeddingProbeChild;
    nativeExit?: FixtureWindowsExitObserver;
  },
) {
  const id = 'standalone-embedding-exit-probe';
  const input = `${JSON.stringify({id, protocol: 1, operation: 'embedMany', payload: request})}\n`;
  const requestBytes = new TextEncoder().encode(input).byteLength;
  let stdoutBytes = 0,
    stderrBytes = 0,
    buffered = '';
  let stdoutRead: 'pending' | 'eof' | 'failed' = 'pending';
  let stderrRead: 'pending' | 'eof' | 'failed' = 'pending';
  let writeBytes: number | undefined, flushBytes: number | undefined;
  let write: 'pending' | 'returned' | 'failed' = 'pending';
  let flush: 'not-started' | 'pending' | 'complete' | 'failed' = 'not-started';
  let reply: 'none' | 'valid' | 'worker-error' | 'invalid' = 'none';
  let firstFault:
    | 'stdout-eof'
    | 'stdout-read'
    | 'stderr-read'
    | 'write'
    | 'flush'
    | 'reply'
    | 'output-overflow'
    | 'exit-observation'
    | 'deadline'
    | 'spawn'
    | undefined;
  let outcome: 'pending' | 'reply' | 'exit' | 'output-overflow' | 'deadline' | 'spawn' | 'no-budget' = 'pending';
  let inputCloseRequested = false,
    cleanupRequested = false,
    processClosed = false,
    exited = false;
  let exitOrigin: 'natural' | 'stdin-close-requested' | 'cleanup' | undefined;
  let exit: ReturnType<typeof projectLocalModelWorkerExitObservation>;
  let rawExitCode: number | undefined;
  const fault = (value: NonNullable<typeof firstFault>) => {
    firstFault ??= value;
  };
  const byteCount = (value: number) =>
    Number.isInteger(value) && value >= 0 && value <= options.maxOutputBytes ? value : undefined;
  const snapshot = () => ({
    outcome,
    ...(firstFault === undefined ? {} : {firstFault}),
    requestBytes,
    inputs: request.inputs.length,
    write,
    ...(writeBytes === undefined ? {} : {writeBytes}),
    flush,
    ...(flushBytes === undefined ? {} : {flushBytes}),
    stdoutBytes,
    stderrBytes,
    stdoutRead,
    stderrRead,
    reply,
    ...(exitOrigin === undefined ? {} : {exitOrigin}),
    ...(exit === undefined ? {} : {exit}),
    ...(rawExitCode === undefined ? {} : {rawExitCode}),
    cleanupRequested,
    processClosed,
  });
  if (processes.remaining(options.deadline) <= 0 || requestBytes > options.maxOutputBytes) {
    outcome = 'no-budget';
    return {snapshot};
  }
  const observation = processes.registry.register();
  let child: FixtureEmbeddingProbeChild;
  try {
    child =
      options.spawn?.() ??
      Bun.spawn({
        cmd: [executable, LOCAL_MODEL_WORKER_ARGUMENT],
        cwd: options.cwd,
        env: options.env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    // Synchronous, before request writing: the handle pins this child's process instance.
    options.nativeExit?.pin(child.pid);
    observation.spawned();
  } catch {
    observation.failed();
    fault('spawn');
    outcome = 'spawn';
    return {snapshot};
  }
  const ready = Promise.withResolvers<'reply' | 'exit' | 'output-overflow'>();
  const observedExit = child.exited.then(
    code => {
      exited = true;
      exitOrigin = cleanupRequested ? 'cleanup' : inputCloseRequested ? 'stdin-close-requested' : 'natural';
      if (!cleanupRequested && !inputCloseRequested) rawExitCode = options.nativeExit?.read();
      exit = projectLocalModelWorkerExitObservation({stage: 'process-exit', exitCode: code, signal: child.signalCode});
      const signal = Option.getOrUndefined(
        EffectArray.findFirst(FIXTURE_DIAGNOSTIC_SIGNALS, known => known === child.signalCode),
      );
      observation.exited(code, signal ?? null);
      ready.resolve('exit');
    },
    () => {
      observation.failed();
      fault('exit-observation');
      ready.resolve('exit');
    },
  );
  const consume = async (stream: AsyncIterable<string | Uint8Array>, isOut: boolean) => {
    try {
      for await (const chunk of stream) {
        const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength;
        if (isOut) stdoutBytes = Math.min(options.maxOutputBytes + 1, stdoutBytes + bytes);
        else stderrBytes = Math.min(options.maxOutputBytes + 1, stderrBytes + bytes);
        if (stdoutBytes + stderrBytes > options.maxOutputBytes) {
          fault('output-overflow');
          ready.resolve('output-overflow');
          continue;
        }
        if (!isOut) continue;
        buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true});
        const newline = Option.getOrUndefined(EffectString.indexOf('\n')(buffered));
        if (newline === undefined) continue;
        const line = EffectString.slice(0, newline)(buffered);
        buffered = EffectString.slice(newline + 1)(buffered);
        if (!EffectString.trim(line)) continue;
        if (reply !== 'none') {
          reply = 'invalid';
          fault('reply');
          ready.resolve('reply');
          continue;
        }
        try {
          const value: unknown = JSON.parse(line);
          if (
            typeof value !== 'object' ||
            value === null ||
            !('id' in value) ||
            value.id !== id ||
            !('protocol' in value) ||
            value.protocol !== 1 ||
            !('ok' in value)
          )
            reply = 'invalid';
          else if (value.ok === false) reply = 'worker-error';
          else if (
            value.ok === true &&
            'result' in value &&
            EffectArray.isArray(value.result) &&
            value.result.length === request.inputs.length &&
            EffectArray.every(
              value.result,
              vector =>
                EffectArray.isArray(vector) &&
                vector.length === request.manifest.dimensions &&
                EffectArray.every(vector, value => typeof value === 'number' && Number.isFinite(value)),
            )
          )
            reply = 'valid';
          else reply = 'invalid';
        } catch {
          reply = 'invalid';
        }
        if (reply !== 'valid') fault('reply');
        ready.resolve('reply');
      }
      if (isOut) stdoutRead = 'eof';
      else stderrRead = 'eof';
      if (isOut && reply === 'none') fault('stdout-eof');
      if (isOut && EffectString.trim(buffered)) {
        fault('reply');
        reply = 'invalid';
      }
    } catch {
      if (isOut) stdoutRead = 'failed';
      else stderrRead = 'failed';
      fault(isOut ? 'stdout-read' : 'stderr-read');
    }
  };
  const decoder = new TextDecoder();
  const stdoutClosed = consume(child.stdout, true),
    stderrClosed = consume(child.stderr, false);
  const closed = Promise.all([observedExit, stdoutClosed, stderrClosed]).then(() => {
    processClosed = exited;
    if (exited) observation.closed();
  });
  const writing = (async () => {
    try {
      writeBytes = byteCount(await child.stdin.write(input));
      write = 'returned';
      flush = 'pending';
      flushBytes = byteCount(await child.stdin.flush());
      flush = 'complete';
    } catch {
      fault(write === 'returned' ? 'flush' : 'write');
      if (write === 'returned') flush = 'failed';
      else write = 'failed';
    }
  })();
  try {
    await processes.wait(
      options.deadline,
      ready.promise.then(() => {}),
    );
    outcome = await ready.promise;
    if (outcome === 'reply') {
      await processes.wait(options.deadline, writing);
      inputCloseRequested = true;
      await processes.wait(
        options.deadline,
        Promise.resolve()
          .then(() => child.stdin.end())
          .then(() => {}),
      );
    }
    if (outcome !== 'output-overflow') await processes.wait(options.deadline, closed);
  } catch {
    fault('deadline');
    outcome = 'deadline';
  } finally {
    if (!inputCloseRequested) {
      inputCloseRequested = true;
      void Promise.resolve()
        .then(() => child.stdin.end())
        .catch(() => undefined);
    }
    if (!processClosed) {
      cleanupRequested = true;
      if (!exited) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* Existing registry retains unknown exit. */
        }
      }
      child.unref();
    }
  }
  return {snapshot};
}

export function fixtureDeadline(remaining: () => number, operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const expiration = new Promise<never>((_, reject) => {
    const poll = () => {
      if (done) return;
      const left = remaining();
      if (left <= 0) {
        reject(new Error('Fixture deadline expired'));
        return;
      }
      timer = setTimeout(poll, Math.min(left, 50));
    };
    poll();
  });
  return Promise.race([operation, expiration])
    .then(() => {
      if (remaining() <= 0) throw new Error('Fixture deadline expired');
    })
    .finally(() => {
      done = true;
      if (timer !== undefined) clearTimeout(timer);
    });
}

const FIXTURE_COMMAND_STAGES = [
  'unspecified',
  'version',
  'install-dry-run',
  'models-runtime',
  'remember',
  'recall',
  'repair',
  'doctor',
  'graph-index',
  'graph-query',
  'graph-explain',
  'graph-path',
  'graph-impact',
  'large-output-pipeline',
  'git-init',
  'git-remote',
  'git-email',
  'git-name',
  'git-add',
  'git-commit',
] as const;
export type FixtureCommandStage = (typeof FIXTURE_COMMAND_STAGES)[number];
const REPAIR_PROGRESS_MARKERS = [
  ['started', /^Repairing the self-contained Threadnote home\.$/m],
  ['lexical-started', /^Preparing lexical recall from canonical documents\.$/m],
  ['lexical-prepared', /^Lexical recall prepared: /m],
  ['embedding-started', /^Embedding \d+ canonical document\(s\) with /m],
  ['vectors-activated', /^Activated vector generation /m],
  ['recall-ready', /^Lexical and vector recall indexes are ready for /m],
  ['integrations-skipped', /^Skipping host instructions, hooks, and MCP client repair \(--core-only\)\.$/m],
  ['doctor-started', /^Running Threadnote doctor checks\.$/m],
] as const;
const REPAIR_ERROR_MARKERS = [
  ['recall-index', /Recall index repair failed:/u],
  ['code-graph', /Native code graph repair failed:/u],
  ['sqlite-busy', /\b(?:SQLITE_BUSY|database is locked)\b/u],
  ['sqlite-io', /\b(?:SQLITE_IOERR|SQLITE_CANTOPEN|SQLITE_READONLY)\b/u],
  ['native-runtime', /\b(?:UnsupportedNativeRuntime|NativeRuntimeUnavailable)\b|Native vector reader /u],
  ['model-load', /\b(?:ModelLoadFailed|ModelNotInstalled|ModelChecksumMismatch|InsufficientMemory)\b/u],
  ['embedding', /\b(?:EmbeddingFailed|InvalidModelOutput)\b/u],
  ['corpus-changed', /\bVectorCorpusGenerationChanged\b/u],
  ['output-drain', /\bCliOutputError\b/u],
] as const;

const REPAIR_SQL_REASONS = new Set([
  'ConnectionError',
  'AuthenticationError',
  'AuthorizationError',
  'SqlSyntaxError',
  'UniqueViolation',
  'ConstraintError',
  'DeadlockError',
  'SerializationError',
  'LockTimeoutError',
  'StatementTimeoutError',
  'UnknownError',
]);
const REPAIR_SQLITE_CODES = new Set([
  'SQLITE_ERROR',
  'SQLITE_INTERNAL',
  'SQLITE_PERM',
  'SQLITE_ABORT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
  'SQLITE_INTERRUPT',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_NOTFOUND',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_EMPTY',
  'SQLITE_SCHEMA',
  'SQLITE_TOOBIG',
  'SQLITE_CONSTRAINT',
  'SQLITE_MISMATCH',
  'SQLITE_MISUSE',
  'SQLITE_NOLFS',
  'SQLITE_AUTH',
  'SQLITE_FORMAT',
  'SQLITE_RANGE',
  'SQLITE_NOTADB',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED_SHAREDCACHE',
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_FOREIGNKEY',
]);
const REPAIR_WORKER_REASONS = [
  'crash',
  'exit',
  'protocol',
  'spawn',
  'timeout',
  'write',
  'cleanup-unconfirmed',
] as const;
const repairTypedFailure = (stderr: string) => {
  const line = /^Recall repair failure diagnostic: (\{[^\r\n]{1,512}\})$/m.exec(stderr)?.[1];
  if (line === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || !('errorType' in value)) return {errorType: 'UnknownError'};
    if (value.errorType === 'SqlError') {
      return {
        errorType: 'SqlError',
        sqlReason:
          'sqlReason' in value && typeof value.sqlReason === 'string' && REPAIR_SQL_REASONS.has(value.sqlReason)
            ? value.sqlReason
            : 'UnknownError',
        ...('sqliteCode' in value && typeof value.sqliteCode === 'string' && REPAIR_SQLITE_CODES.has(value.sqliteCode)
          ? {sqliteCode: value.sqliteCode}
          : {}),
      };
    }
    const projected = projectAnonymousTelemetryDiagnostic({
      errorType: typeof value.errorType === 'string' ? value.errorType : 'UnknownError',
      ...('domain' in value && value.domain === 'model-worker'
        ? {
            domain: 'model-worker',
            operation: 'operation' in value && typeof value.operation === 'string' ? value.operation : undefined,
            reason: Option.getOrUndefined(
              EffectArray.findFirst(REPAIR_WORKER_REASONS, reason => 'reason' in value && value.reason === reason),
            ),
          }
        : {}),
    });
    const exitObservation =
      'exitObservation' in value ? projectLocalModelWorkerExitObservation(value.exitObservation) : undefined;
    return projected?.domain === 'model-worker'
      ? {...projected, ...(exitObservation === undefined ? {} : {exitObservation})}
      : {errorType: projected?.errorType ?? 'UnknownError'};
  } catch {
    return {errorType: 'UnknownError'};
  }
};

const repairFailureMarkers = (stdout: string, stderr: string) => {
  const milestones = EffectArray.map(
    EffectArray.filter(REPAIR_PROGRESS_MARKERS, ([, pattern]) => pattern.test(stdout)),
    ([name]) => name,
  );
  const errors = EffectArray.map(
    EffectArray.filter(REPAIR_ERROR_MARKERS, ([, pattern]) => pattern.test(stderr)),
    ([name]) => name,
  );
  const typedFailure = repairTypedFailure(stderr);
  return {
    milestones,
    errorCategories: errors.length > 0 ? errors : ['unknown'],
    ...(typedFailure === undefined ? {} : {typedFailure}),
  };
};
const FIXTURE_DIAGNOSTIC_SIGNALS: readonly NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGABRT',
  'SIGSEGV',
  'SIGPIPE',
  'SIGHUP',
  'SIGQUIT',
  'SIGILL',
  'SIGBUS',
  'SIGFPE',
  'SIGTRAP',
  'SIGSYS',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGALRM',
  'SIGUSR1',
  'SIGUSR2',
  'SIGBREAK',
  'SIGCHLD',
  'SIGCONT',
  'SIGIO',
  'SIGIOT',
  'SIGPOLL',
  'SIGPROF',
  'SIGPWR',
  'SIGSTKFLT',
  'SIGSTOP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGUNUSED',
  'SIGURG',
  'SIGVTALRM',
  'SIGWINCH',
  'SIGLOST',
  'SIGINFO',
];

/** Reconcile every nonce-bound endpoint before deciding whether the pipeline succeeded. */
export function reconcileFixturePipelineReceipts(
  receipts: readonly {
    readonly role: 'producer' | 'consumer';
    readonly token: string;
    readonly text: string | undefined;
    readonly observation: FixtureProducerObservation;
  }[],
) {
  return EffectArray.map(receipts, ({role, token, text, observation}) => {
    const unknown = {role, state: 'unknown' as const, exitCode: null, signal: null};
    if (text === undefined || !fixturePipelineReceiptProvesExit(text, token)) return unknown;
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || !('code' in value) || !('signal' in value)) return unknown;
    if (value.code !== null && (typeof value.code !== 'number' || !Number.isSafeInteger(value.code))) return unknown;
    const signal =
      value.signal === null
        ? null
        : Option.getOrUndefined(EffectArray.findFirst(FIXTURE_DIAGNOSTIC_SIGNALS, known => known === value.signal));
    if (signal === undefined) return unknown;
    observation.spawned();
    observation.exited(value.code, signal);
    observation.closed();
    return {role, state: 'exited' as const, exitCode: value.code, signal};
  });
}

export async function runFixtureCommand(
  processes: FixtureProcesses,
  command: string,
  args: readonly string[],
  options: {cwd: string; env: NodeJS.ProcessEnv; deadline: number; maxOutputBytes: number; stage?: FixtureCommandStage},
) {
  if (processes.remaining(options.deadline) <= 0) throw new Error('Fixture body deadline expired');
  const child = processes.spawn(command, args, options);
  child.stdin?.end();
  let stdout = '';
  let stderr = '';
  let size = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  const collect = (isOut: boolean) => (chunk: Buffer) => {
    // Saturation retains the original overflow decision without unbounded counters.
    size = Math.min(options.maxOutputBytes + 1, size + chunk.length);
    if (isOut) stdoutBytes = Math.min(options.maxOutputBytes + 1, stdoutBytes + chunk.length);
    else stderrBytes = Math.min(options.maxOutputBytes + 1, stderrBytes + chunk.length);
    if (size > options.maxOutputBytes) {
      overflow = true;
      return;
    }
    if (isOut) stdout += chunk.toString();
    else stderr += chunk.toString();
  };
  child.stdout?.on('data', collect(true));
  child.stderr?.on('data', collect(false));
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let failed = false;
  let spawned = false;
  let exited = false;
  const complete = new Promise<void>(resolve => {
    child.once('spawn', () => {
      spawned = true;
    });
    child.once('error', () => {
      failed = true;
    });
    child.once('exit', (value, signalled) => {
      exited = true;
      code = value;
      signal = signalled;
    });
    child.once('close', () => resolve());
  });
  await processes.wait(options.deadline, complete);
  if (failed || code !== 0 || signal !== null || overflow) {
    // Emit only after this owned child's close, never from timeout/unknown cleanup.
    // Do not include the command, arguments, output, environment or child error.
    const stage = options.stage ?? 'unspecified';
    throw new Error(
      `Fixture command failed or output exceeded limit: ${JSON.stringify({
        stage: EffectArray.contains(FIXTURE_COMMAND_STAGES, stage) ? stage : 'unspecified',
        observed: 'owned-close',
        reason: failed
          ? 'child-error'
          : overflow
            ? 'output-overflow'
            : signal !== null
              ? 'signal'
              : code === null
                ? 'missing-exit-code'
                : 'nonzero-exit',
        spawned,
        exited,
        childError: failed,
        exitCode: Number.isSafeInteger(code) ? code : null,
        signal: signal === null ? null : EffectArray.contains(FIXTURE_DIAGNOSTIC_SIGNALS, signal) ? signal : 'other',
        stdoutBytes,
        stderrBytes,
        totalBytes: size,
        maxOutputBytes: options.maxOutputBytes,
        overflow,
        ...(!failed && !overflow && signal === null && code !== null && code !== 0 && stage === 'repair'
          ? {repair: repairFailureMarkers(stdout, stderr)}
          : {}),
      })}`,
    );
  }
  return {stdout, stderr};
}

export class FixtureStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: FixtureChild;
  private readonly buffer = new ReadBuffer();
  private closePromise?: Promise<void>;
  private exit:
    | {
        code: number | null;
        signal: NodeJS.Signals | null;
        stdinEofRequested: boolean;
        stdinEofFinished: boolean;
      }
    | undefined;
  private stdinEofRequested = false;
  private stdinEofFinished = false;
  private closeObserved = false;
  private mcpInitialized = false;
  constructor(
    private readonly processes: FixtureProcesses,
    private readonly options: {
      command: string;
      args: readonly string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      deadline: number;
      shutdownMode?: 'strict' | 'effect-mcp-stdio-eof-130';
    },
  ) {}

  markMcpInitialized(): void {
    if (this.options.shutdownMode === 'effect-mcp-stdio-eof-130') this.mcpInitialized = true;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('MCP transport already started');
    if (this.processes.remaining(this.options.deadline) <= 0) throw new Error('Fixture body deadline expired');
    const child = this.processes.spawn(this.options.command, this.options.args, this.options);
    this.child = child;
    child.stdin?.once('finish', () => {
      this.stdinEofFinished = true;
    });
    child.once('exit', (code, signal) => {
      this.exit = {
        code,
        signal,
        stdinEofRequested: this.stdinEofRequested,
        stdinEofFinished: this.stdinEofFinished,
      };
    });
    this.closePromise = new Promise(resolve =>
      child.once('close', () => {
        this.closeObserved = true;
        this.onclose?.();
        resolve();
      }),
    );
    child.stderr?.resume();
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error('Invalid MCP stream'));
      }
    });
    child.stdin?.on('error', error => this.onerror?.(error));
    child.stdout?.on('error', error => this.onerror?.(error));
    child.on('error', error => this.onerror?.(error));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error('MCP child stdin unavailable');
    await new Promise<void>((resolve, reject) =>
      stdin.write(serializeMessage(message), error => (error ? reject(error) : resolve())),
    );
  }
  async close(): Promise<void> {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.writableEnded && !stdin.destroyed) {
      this.stdinEofRequested = true;
      stdin.end();
    }
    await this.closePromise;
    const expectedMcpEofInterrupt =
      this.options.shutdownMode === 'effect-mcp-stdio-eof-130' &&
      this.mcpInitialized &&
      this.exit?.stdinEofRequested === true &&
      this.exit.stdinEofFinished &&
      this.exit.code === 130 &&
      this.exit.signal === null &&
      this.closeObserved &&
      this.processes.remaining(this.options.deadline) > 0;
    if (!this.exit || ((this.exit.code !== 0 || this.exit.signal !== null) && !expectedMcpEofInterrupt))
      throw new Error('MCP child did not exit cleanly');
  }
}
