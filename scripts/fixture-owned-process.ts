// oxlint-disable-next-line threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Direct child handles and close events are required for fixture-only producer exit proof.
import {spawn, type ChildProcess} from 'node:child_process';
import {Array as EffectArray, Option} from 'effect';
import {fixturePipelineReceiptProvesExit} from '@threadnote/testing/fixture-pipeline-receipt';
import {ReadBuffer, serializeMessage} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {FixtureProducers, type FixtureProducerObservation} from '@threadnote/testing/fixture-producers';
import {projectAnonymousTelemetryDiagnostic} from '@threadnote/threadnote/telemetry/diagnostic';
import {projectLocalModelWorkerExitObservation} from '@threadnote/threadnote/effect/ai/isolated-local-model-runtime';

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
