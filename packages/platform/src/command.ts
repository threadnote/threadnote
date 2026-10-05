import {Context, Effect, Layer, Schema, Sink, Stdio, Stream} from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import {ChildProcessSpawner} from 'effect/process/ChildProcessSpawner';
import {redactSensitiveText} from '@threadnote/platform/scrubber';
import {ChildEnvironmentPolicy, type ChildEnvironmentPolicyShape} from './child-environment-policy.js';
import {SystemInfo, type SystemInfoShape} from './system.js';

export interface CommandOptions {
  readonly allowFailure?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** @internal Permit one explicitly selected private index for a Git child. */
  readonly trustedGitIndexFile?: string;
  readonly input?: Uint8Array;
  /** Set to zero to collect output without a byte ceiling. */
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface BinaryCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: Uint8Array;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CommandInvocation {
  readonly args: readonly string[];
  readonly executable: string;
  readonly shell?: string;
}

export interface DetachedCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Preserve only a valid current alias for one declared Threadnote child. */
  readonly intendedChild?: string;
}

export interface StreamingCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Inherit child stdout/stderr from this process. Only safe on a live TTY;
   * detached auto-update workers inherit ignored stdio and must pipe so
   * failures can be captured.
   */
  readonly inheritOutput?: boolean;
  /**
   * Inherit child stdin. Independent of `inheritOutput` so `threadnote update | tee`
   * can still answer prompts while piping logs. Detached workers leave this
   * unset so stdin is ignored.
   */
  readonly inheritStdin?: boolean;
  readonly maxOutputChars?: number;
}

const CommandFields = {
  args: Schema.Array(Schema.String),
  executable: Schema.String,
  message: Schema.String,
};

export class CommandFailed extends Schema.TaggedError<CommandFailed>()('CommandFailed', {
  ...CommandFields,
  exitCode: Schema.Finite,
  stderr: Schema.String,
  stdout: Schema.String,
}) {}

export class CommandTimedOut extends Schema.TaggedError<CommandTimedOut>()('CommandTimedOut', {
  ...CommandFields,
  timeoutMs: Schema.Finite,
}) {}

export class CommandOutputLimitExceeded extends Schema.TaggedError<CommandOutputLimitExceeded>()(
  'CommandOutputLimitExceeded',
  {
    ...CommandFields,
    maxOutputBytes: Schema.Finite,
  },
) {}

export class CommandSpawnFailed extends Schema.TaggedError<CommandSpawnFailed>()('CommandSpawnFailed', {
  ...CommandFields,
  cause: Schema.Defect(),
}) {}

export type CommandExecutionError = CommandFailed | CommandOutputLimitExceeded | CommandSpawnFailed | CommandTimedOut;

export class CommandExecutor extends Context.Service<
  CommandExecutor,
  {
    readonly execute: (
      executable: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => Effect.Effect<CommandResult, CommandExecutionError>;
    readonly executeBytes?: (
      executable: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => Effect.Effect<BinaryCommandResult, CommandExecutionError>;
    readonly executeStreaming: (
      executable: string,
      args: readonly string[],
      options?: StreamingCommandOptions,
    ) => Effect.Effect<CommandResult>;
    readonly spawnDetached?: (
      executable: string,
      args: readonly string[],
      options?: DetachedCommandOptions,
    ) => Effect.Effect<boolean>;
  }
>()('@threadnote/platform/command/CommandExecutor') {
  static readonly layer = Layer.effect(
    CommandExecutor,
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner;
      const stdio = yield* Stdio.Stdio;
      const system = yield* SystemInfo;
      const childEnvironmentPolicy = yield* ChildEnvironmentPolicy;
      return CommandExecutor.of({
        execute: (executable, args, options) =>
          executeCommand(executable, args, options, system, childEnvironmentPolicy).pipe(
            Effect.provideService(ChildProcessSpawner, childProcessSpawner),
          ),
        executeBytes: (executable, args, options) =>
          executeBinaryCommand(executable, args, options, system, childEnvironmentPolicy).pipe(
            Effect.provideService(ChildProcessSpawner, childProcessSpawner),
          ),
        executeStreaming: (executable, args, options) =>
          executeStreamingCommand(executable, args, options, system, childEnvironmentPolicy).pipe(
            Effect.provideService(ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Stdio.Stdio, stdio),
          ),
        spawnDetached: (executable, args, options) =>
          spawnDetachedCommand(executable, args, options ?? {}, system, childEnvironmentPolicy).pipe(
            Effect.provideService(ChildProcessSpawner, childProcessSpawner),
          ),
      });
    }),
  );
}

export const runCommandEffect = Effect.fn('runCommandEffect')(function* (
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
) {
  const command = yield* CommandExecutor;
  return yield* command.execute(executable, args, options);
});

export const runBinaryCommandEffect = Effect.fn('runBinaryCommandEffect')(function* (
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
) {
  const command = yield* CommandExecutor;
  if (!command.executeBytes) {
    return yield* CommandSpawnFailed.make({
      args,
      cause: new Error('The configured command adapter does not support binary output.'),
      executable,
      message: 'The configured command adapter does not support binary output.',
    });
  }
  return yield* command.executeBytes(executable, args, options);
});

export const runStreamingCommandEffect = Effect.fn('runStreamingCommandEffect')(function* (
  executable: string,
  args: readonly string[],
  options: StreamingCommandOptions = {},
) {
  const command = yield* CommandExecutor;
  return yield* command.executeStreaming(executable, args, options);
});

export const runDetachedCommandEffect = Effect.fn('runDetachedCommandEffect')(function* (
  executable: string,
  args: readonly string[],
  options: DetachedCommandOptions = {},
) {
  const command = yield* CommandExecutor;
  if (!command.spawnDetached) return false;
  return yield* command.spawnDetached(executable, args, options);
});

const executeCommand = Effect.fn('CommandExecutor.execute')(function* (
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
  system: SystemInfoShape,
  childEnvironmentPolicy: ChildEnvironmentPolicyShape,
) {
  const environment = system.environment();
  const maxOutputBytes = options.maxOutputBytes ?? commandMaxOutputBytes(environment);
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs(environment);
  const command = formatShellCommand(executable, args);
  const safeArgs = redactCommandArgs(args);
  const safeExecutable = redactSensitiveText(executable);
  const spawnFailed = (cause: unknown) => commandSpawnFailure(command, safeExecutable, safeArgs, cause);
  const outputExceeded = CommandOutputLimitExceeded.make({
    args: safeArgs,
    executable: safeExecutable,
    maxOutputBytes,
    message: `${command} exceeded output limit of ${maxOutputBytes} bytes`,
  });
  const run = Effect.scoped(
    Effect.gen(function* () {
      const invocation = yield* Effect.try({
        try: () =>
          resolveCommandInvocation(
            executable,
            args,
            system.platform,
            environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
          ),
        catch: spawnFailed,
      });
      const handle = yield* ChildProcess.make(invocation.executable, [...invocation.args], {
        cwd: options.cwd,
        env: commandEnvironment(
          executable,
          options.env,
          environment,
          childEnvironmentPolicy,
          options.trustedGitIndexFile,
        ),
        forceKillAfter: 1000,
        shell: invocation.shell,
        stdin: options.input ? Stream.make(options.input) : 'ignore',
      }).pipe(Effect.mapError(spawnFailed));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectCommandOutput(handle.stdout, maxOutputBytes, outputExceeded).pipe(
            Effect.mapError(cause => (Schema.is(CommandOutputLimitExceeded)(cause) ? cause : spawnFailed(cause))),
          ),
          collectCommandOutput(handle.stderr, maxOutputBytes, outputExceeded).pipe(
            Effect.mapError(cause => (Schema.is(CommandOutputLimitExceeded)(cause) ? cause : spawnFailed(cause))),
          ),
          handle.exitCode.pipe(Effect.map(Number), Effect.mapError(spawnFailed)),
        ],
        {concurrency: 'unbounded'},
      );
      const result = {exitCode, stderr, stdout};
      if (exitCode === 0) {
        return result;
      }
      return yield* CommandFailed.make({
        args: safeArgs,
        executable: safeExecutable,
        exitCode,
        message: redactSensitiveText(`${command} failed: ${stderr || stdout}`),
        stderr: redactSensitiveText(stderr),
        stdout: redactSensitiveText(stdout),
      });
    }),
  );
  const timedOut = CommandTimedOut.make({
    args: safeArgs,
    executable: safeExecutable,
    message: `${command} timed out after ${timeoutMs}ms`,
    timeoutMs,
  });
  const bounded =
    timeoutMs <= 0
      ? run
      : run.pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(timedOut),
          }),
        );
  return yield* options.allowFailure === true
    ? bounded.pipe(Effect.catch(error => Effect.succeed(commandErrorResult(error))))
    : bounded;
});

const executeBinaryCommand = Effect.fn('CommandExecutor.executeBinary')(function* (
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
  system: SystemInfoShape,
  childEnvironmentPolicy: ChildEnvironmentPolicyShape,
) {
  const environment = system.environment();
  const maxOutputBytes = options.maxOutputBytes ?? commandMaxOutputBytes(environment);
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs(environment);
  const command = formatShellCommand(executable, args);
  const safeArgs = redactCommandArgs(args);
  const safeExecutable = redactSensitiveText(executable);
  const spawnFailed = (cause: unknown) => commandSpawnFailure(command, safeExecutable, safeArgs, cause);
  const outputExceeded = CommandOutputLimitExceeded.make({
    args: safeArgs,
    executable: safeExecutable,
    maxOutputBytes,
    message: `${command} exceeded output limit of ${maxOutputBytes} bytes`,
  });
  const run = Effect.scoped(
    Effect.gen(function* () {
      const invocation = yield* Effect.try({
        try: () =>
          resolveCommandInvocation(
            executable,
            args,
            system.platform,
            environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
          ),
        catch: spawnFailed,
      });
      const handle = yield* ChildProcess.make(invocation.executable, [...invocation.args], {
        cwd: options.cwd,
        env: commandEnvironment(
          executable,
          options.env,
          environment,
          childEnvironmentPolicy,
          options.trustedGitIndexFile,
        ),
        forceKillAfter: 1000,
        shell: invocation.shell,
        stdin: options.input ? Stream.make(options.input) : 'ignore',
      }).pipe(Effect.mapError(spawnFailed));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectCommandBytes(handle.stdout, maxOutputBytes, outputExceeded).pipe(
            Effect.mapError(cause => (Schema.is(CommandOutputLimitExceeded)(cause) ? cause : spawnFailed(cause))),
          ),
          collectCommandOutput(handle.stderr, maxOutputBytes, outputExceeded).pipe(
            Effect.mapError(cause => (Schema.is(CommandOutputLimitExceeded)(cause) ? cause : spawnFailed(cause))),
          ),
          handle.exitCode.pipe(Effect.map(Number), Effect.mapError(spawnFailed)),
        ],
        {concurrency: 'unbounded'},
      );
      if (exitCode === 0) {
        return {exitCode, stderr, stdout};
      }
      const decoded = new TextDecoder().decode(stdout);
      return yield* CommandFailed.make({
        args: safeArgs,
        executable: safeExecutable,
        exitCode,
        message: redactSensitiveText(`${command} failed: ${stderr || decoded}`),
        stderr: redactSensitiveText(stderr),
        stdout: redactSensitiveText(decoded),
      });
    }),
  );
  const timedOut = CommandTimedOut.make({
    args: safeArgs,
    executable: safeExecutable,
    message: `${command} timed out after ${timeoutMs}ms`,
    timeoutMs,
  });
  return yield* timeoutMs <= 0
    ? run
    : run.pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(timedOut),
        }),
      );
});

const executeStreamingCommand = Effect.fn('CommandExecutor.executeStreaming')(function* (
  executable: string,
  args: readonly string[],
  options: StreamingCommandOptions = {},
  system: SystemInfoShape,
  childEnvironmentPolicy: ChildEnvironmentPolicyShape,
) {
  const environment = system.environment();
  const maxOutputChars = options.maxOutputChars ?? 64_000;
  const command = formatShellCommand(executable, args);
  const safeArgs = redactCommandArgs(args);
  const safeExecutable = redactSensitiveText(executable);
  const spawnFailed = (cause: unknown) => commandSpawnFailure(command, safeExecutable, safeArgs, cause);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const invocation = yield* Effect.try({
        try: () =>
          resolveCommandInvocation(
            executable,
            args,
            system.platform,
            environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
          ),
        catch: spawnFailed,
      });
      const inheritOutput = options.inheritOutput === true;
      const inheritStdin = options.inheritStdin === true || inheritOutput;
      const handle = yield* ChildProcess.make(invocation.executable, [...invocation.args], {
        env: commandEnvironment(executable, options.env, environment, childEnvironmentPolicy),
        forceKillAfter: 1000,
        shell: invocation.shell,
        stdin: inheritStdin ? 'inherit' : 'ignore',
        stderr: inheritOutput ? 'inherit' : 'pipe',
        stdout: inheritOutput ? 'inherit' : 'pipe',
      }).pipe(Effect.mapError(spawnFailed));
      if (inheritOutput) {
        return {
          exitCode: Number(yield* handle.exitCode.pipe(Effect.mapError(spawnFailed))),
          stderr: '',
          stdout: '',
        };
      }
      const stdio = yield* Stdio.Stdio;
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamingOutput(handle.stdout, stdio.stdout({endOnDone: false}), maxOutputChars).pipe(
            Effect.orElseSucceed(() => ''),
          ),
          collectStreamingOutput(handle.stderr, stdio.stderr({endOnDone: false}), maxOutputChars).pipe(
            Effect.orElseSucceed(() => ''),
          ),
          handle.exitCode.pipe(
            Effect.map(Number),
            Effect.orElseSucceed(() => 1),
          ),
        ],
        {concurrency: 'unbounded'},
      );
      return {exitCode, stderr, stdout};
    }),
  ).pipe(
    Effect.catchIf(Schema.is(CommandSpawnFailed), cause =>
      Effect.succeed({exitCode: 1, stderr: `${cause.message}\n`, stdout: ''}),
    ),
  );
});

const spawnDetachedCommand = Effect.fn('CommandExecutor.spawnDetached')(function* (
  executable: string,
  args: readonly string[],
  options: DetachedCommandOptions,
  system: SystemInfoShape,
  childEnvironmentPolicy: ChildEnvironmentPolicyShape,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(executable, [...args], {
        cwd: options.cwd,
        detached: true,
        env:
          options.intendedChild === undefined
            ? commandEnvironment(executable, options.env, system.environment(), childEnvironmentPolicy)
            : childEnvironmentPolicy.preserveIntendedChild(options.env ?? system.environment(), options.intendedChild),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      yield* handle.unref.pipe(Effect.asVoid);
      return true;
    }),
  ).pipe(Effect.orElseSucceed(() => false));
});

function collectCommandOutput(
  stream: Stream.Stream<Uint8Array, unknown>,
  maxOutputBytes: number,
  outputExceeded: CommandOutputLimitExceeded,
) {
  const encoder = new TextEncoder();
  return stream.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => ({chunks: [] as string[], size: 0}),
      (current, chunk) => {
        const size = current.size + encoder.encode(chunk).byteLength;
        if (maxOutputBytes > 0 && size > maxOutputBytes) return Effect.fail(outputExceeded);
        current.chunks.push(chunk);
        return Effect.succeed({chunks: current.chunks, size});
      },
    ),
    Effect.map(output => output.chunks.join('')),
  );
}

function collectCommandBytes(
  stream: Stream.Stream<Uint8Array, unknown>,
  maxOutputBytes: number,
  outputExceeded: CommandOutputLimitExceeded,
) {
  return Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* stream.pipe(
      Stream.runForEach(chunk => {
        size += chunk.byteLength;
        if (maxOutputBytes > 0 && size > maxOutputBytes) return Effect.fail(outputExceeded);
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  });
}

function collectStreamingOutput(
  stream: Stream.Stream<Uint8Array, unknown>,
  sink: Sink.Sink<void, string | Uint8Array, never, unknown>,
  maxOutputChars: number,
) {
  return stream.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => '',
      (current, chunk) =>
        // Parent stdout/stderr may be ignored (detached auto-update). Keep
        // draining the child so a full pipe cannot deadlock, and keep the
        // capture even when the parent tee write fails.
        Stream.run(Stream.make(chunk), sink).pipe(
          Effect.ignore,
          Effect.as(appendOutputTail(current, chunk, maxOutputChars)),
        ),
    ),
  );
}

function appendOutputTail(current: string, chunk: string, maxOutputChars: number): string {
  const next = `${current}${chunk}`;
  return next.length <= maxOutputChars ? next : next.slice(next.length - maxOutputChars);
}

function commandSpawnFailure(
  command: string,
  safeExecutable: string,
  safeArgs: readonly string[],
  cause: unknown,
): CommandSpawnFailed {
  const message = causeMessage(cause);
  return CommandSpawnFailed.make({
    args: safeArgs,
    cause: new Error(redactSensitiveText(message)),
    executable: safeExecutable,
    message: redactSensitiveText(`${command} failed to start: ${message}`),
  });
}

function commandErrorResult(error: CommandExecutionError): CommandResult {
  switch (error._tag) {
    case 'CommandFailed':
      return {exitCode: error.exitCode, stderr: error.stderr, stdout: error.stdout};
    case 'CommandOutputLimitExceeded':
    case 'CommandTimedOut':
      return {exitCode: 124, stderr: error.message, stdout: ''};
    case 'CommandSpawnFailed':
      return {exitCode: 127, stderr: error.message, stdout: ''};
  }
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : typeof cause === 'object' && cause !== null && 'message' in cause
      ? String(cause.message)
      : String(cause);
}

const WINDOWS_COMMAND_META = /([()\][%!^"`<>&|;, *?])/g;

export function resolveCommandInvocation(
  executable: string,
  args: readonly string[],
  currentPlatform: NodeJS.Platform,
  comspec = 'cmd.exe',
): CommandInvocation {
  if (currentPlatform !== 'win32' || !/\.(?:bat|cmd)$/i.test(executable)) {
    return {args, executable};
  }
  for (const value of [executable, ...args]) {
    if (value.includes('\0') || /[\r\n]/.test(value)) {
      throw new Error('Windows batch commands do not accept NUL, CR, or LF characters.');
    }
  }
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(executable);
  const command = escapeWindowsCommand(executable);
  const escapedArgs = args.map(arg => escapeWindowsArgument(arg, doubleEscape));
  return {
    args: [],
    executable: [command, ...escapedArgs].join(' '),
    shell: comspec,
  };
}

function escapeWindowsCommand(value: string): string {
  return value.replace(WINDOWS_COMMAND_META, '^$1');
}

function escapeWindowsArgument(value: string, doubleEscape: boolean): string {
  let escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`.replace(WINDOWS_COMMAND_META, '^$1');
  return doubleEscape ? escaped.replace(WINDOWS_COMMAND_META, '^$1') : escaped;
}

export function isGitExecutable(executable: string): boolean {
  const name = executable.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return /^(?:git)(?:\.(?:bat|cmd|com|exe))?$/i.test(name);
}

export const windowsTaskkillExecutable = Effect.fn('CommandExecutor.windowsTaskkillExecutable')(function* () {
  const environment = (yield* SystemInfo).environment();
  return `${(environment.SystemRoot ?? 'C:\\Windows').replace(/[\\/]+$/, '')}\\System32\\taskkill.exe`;
});

const GIT_ENVIRONMENT_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
] as const;

export function withoutGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = {...env};
  for (const key of GIT_ENVIRONMENT_KEYS) {
    delete next[key];
  }
  return next;
}

export function commandEnvironment(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  systemEnvironment: NodeJS.ProcessEnv,
  childEnvironmentPolicy: ChildEnvironmentPolicyShape,
  trustedGitIndexFile?: string,
): NodeJS.ProcessEnv | undefined {
  const sanitized = childEnvironmentPolicy.sanitizeExternal(env ?? systemEnvironment);
  if (!isGitExecutable(executable)) return sanitized;
  const gitEnvironment = withoutGitEnvironment(sanitized);
  return trustedGitIndexFile === undefined
    ? gitEnvironment
    : {...gitEnvironment, GIT_INDEX_FILE: trustedGitIndexFile, GIT_OPTIONAL_LOCKS: '1'};
}

export function formatShellCommand(executable: string, args: readonly string[]): string {
  const values = isGitExecutable(executable) ? formatGitCommandValues(executable, args) : [executable, ...args];
  return redactSensitiveText(values.map(shellQuote).join(' '));
}

const GIT_PATH_ARGUMENT_ROLES = new Map<string, 'gitdir' | 'worktree'>([
  ['-C', 'worktree'],
  ['--git-dir', 'gitdir'],
  ['--separate-git-dir', 'gitdir'],
  ['--work-tree', 'worktree'],
]);

function formatGitCommandValues(executable: string, args: readonly string[]): readonly string[] {
  const formattedArgs = [...args];
  const separatorIndex = args.indexOf('--');
  const optionLimit = separatorIndex >= 0 ? separatorIndex : args.length;
  for (let index = 0; index < optionLimit; index += 1) {
    const argument = args[index];
    const role = GIT_PATH_ARGUMENT_ROLES.get(argument);
    if (role !== undefined && index + 1 < optionLimit) {
      formattedArgs[index + 1] = replaceSensitiveValueWithRole(args[index + 1], role);
      index += 1;
      continue;
    }
    for (const [option, optionRole] of GIT_PATH_ARGUMENT_ROLES) {
      const prefix = `${option}=`;
      if (argument.startsWith(prefix)) {
        formattedArgs[index] = `${prefix}${replaceSensitiveValueWithRole(argument.slice(prefix.length), optionRole)}`;
        break;
      }
    }
  }

  if (args[0] === 'clone' && separatorIndex > 0 && separatorIndex + 1 < args.length) {
    formattedArgs[separatorIndex + 1] = replaceSensitiveValueWithRole(args[separatorIndex + 1], 'repository');
    if (separatorIndex + 2 < args.length) {
      formattedArgs[separatorIndex + 2] = replaceSensitiveValueWithRole(args[separatorIndex + 2], 'worktree');
    }
  }

  return [replaceSensitiveValueWithRole(executable, 'git'), ...formattedArgs];
}

function replaceSensitiveValueWithRole(value: string, role: 'git' | 'gitdir' | 'repository' | 'worktree'): string {
  return redactSensitiveText(value) === value ? value : `<${role}>`;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function commandTimeoutMs(environment: Readonly<Record<string, string | undefined>>): number {
  return positiveIntegerFromEnv(environment, 'THREADNOTE_COMMAND_TIMEOUT_MS') ?? 10 * 60 * 1000;
}

export function commandMaxOutputBytes(environment: Readonly<Record<string, string | undefined>>): number {
  return positiveIntegerFromEnv(environment, 'THREADNOTE_COMMAND_MAX_OUTPUT_BYTES') ?? 5 * 1024 * 1024;
}

function positiveIntegerFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const value = environment[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function redactCommandArgs(args: readonly string[]): readonly string[] {
  const combined = args.join(' ');
  if (redactSensitiveText(combined) !== combined) {
    return ['[REDACTED]'];
  }
  return args.map(redactSensitiveText);
}
