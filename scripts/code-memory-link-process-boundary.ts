/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed evaluation helper owns explicit operating-system process-group boundaries. */
import {spawn, type ChildProcess} from 'node:child_process';

export interface CodeMemoryLinkProcessCaptureOptions {
  readonly allowFailure?: boolean;
  readonly arguments: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly label: string;
  readonly maxOutputBytes: number;
  readonly stdin?: string | Uint8Array;
  readonly terminationGraceMilliseconds?: number;
  readonly timeoutMilliseconds: number;
}

export const CODE_MEMORY_LINK_MAX_STDIN_BYTES = 1 * 1_024 * 1_024;

export interface CodeMemoryLinkProcessCaptureResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Run one reviewed evaluation boundary in its own process group. The group is
 * terminated and observed empty even after the leader exits successfully, so a
 * child cannot outlive the candidate, judge, or matrix invocation.
 */
export async function captureCodeMemoryLinkProcessGroup(
  options: CodeMemoryLinkProcessCaptureOptions,
): Promise<CodeMemoryLinkProcessCaptureResult> {
  if (process.platform === 'win32') {
    throw new Error(`${options.label} process-group isolation requires macOS or Linux.`);
  }
  const stdin = options.stdin === undefined ? undefined : Buffer.from(options.stdin);
  if (stdin !== undefined && stdin.byteLength > CODE_MEMORY_LINK_MAX_STDIN_BYTES) {
    throw new Error(`${options.label} stdin exceeded its byte limit.`);
  }
  const child = spawn(options.command, [...options.arguments], {
    cwd: options.cwd,
    detached: true,
    env: {...options.environment},
    shell: false,
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let processError: unknown;
  const close = new Promise<number | null>(resolvePromise => {
    child.once('error', cause => {
      processError = cause;
    });
    child.once('close', code => resolvePromise(code));
  });
  const groupId = child.pid;
  if (groupId === undefined || groupId <= 0) {
    child.kill('SIGKILL');
    throw new Error(`${options.label} process has no valid process-group id.`);
  }
  if (child.stdout === null || child.stderr === null) {
    child.kill('SIGKILL');
    throw new Error(`${options.label} process output pipes were not available.`);
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputExceeded = false;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> =>
    (termination ??= terminateCodeMemoryLinkProcessGroup(child, groupId, {
      graceMilliseconds: options.terminationGraceMilliseconds ?? 1_000,
      label: options.label,
    }));
  const beginTermination = (): void => {
    void terminate().catch(() => undefined);
  };
  const collect = (destination: Buffer[]) => (value: Uint8Array) => {
    const chunk = Buffer.from(value);
    outputBytes += chunk.byteLength;
    if (outputBytes > options.maxOutputBytes) {
      outputExceeded = true;
      beginTermination();
      return;
    }
    destination.push(chunk);
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  const timeout = setTimeout(() => {
    timedOut = true;
    beginTermination();
  }, options.timeoutMilliseconds);
  let exitCode: number | null;
  try {
    if (stdin !== undefined) await writeCodeMemoryLinkProcessStdin(child, stdin, options.label);
    exitCode = await close;
    if (processError !== undefined) throw new Error(`${options.label} process failed to start.`, {cause: processError});
  } finally {
    clearTimeout(timeout);
    await terminate();
  }
  if (timedOut) throw new Error(`${options.label} exceeded ${options.timeoutMilliseconds} ms.`);
  if (outputExceeded) throw new Error(`${options.label} output exceeded its byte limit.`);
  const result = {
    exitCode: exitCode ?? 255,
    stderr: decodeUtf8(stderr, `${options.label} stderr`),
    stdout: decodeUtf8(stdout, `${options.label} stdout`),
  };
  if (!options.allowFailure && result.exitCode !== 0) {
    throw new Error(`${options.label} failed with exit code ${result.exitCode}.`);
  }
  return result;
}

async function writeCodeMemoryLinkProcessStdin(child: ChildProcess, stdin: Buffer, label: string): Promise<void> {
  if (child.stdin === null) throw new Error(`${label} process stdin was not available.`);
  const input = child.stdin;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      input.removeListener('error', onError);
      if (error === undefined || error === null) resolvePromise();
      else rejectPromise(new Error(`${label} stdin write failed.`, {cause: error}));
    };
    const onError = (error: unknown): void => settle(error);
    input.once('error', onError);
    input.write(stdin, (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        settle(error);
        return;
      }
      input.end(() => settle());
    });
  });
}

export async function terminateCodeMemoryLinkProcessGroup(
  child: ChildProcess,
  groupId: number,
  options: {readonly graceMilliseconds: number; readonly label: string},
): Promise<void> {
  signalProcessGroup(groupId, 'SIGTERM');
  if (!(await waitForProcessGroupExit(groupId, options.graceMilliseconds))) {
    signalProcessGroup(groupId, 'SIGKILL');
    if (!(await waitForProcessGroupExit(groupId, 5_000))) {
      throw new Error(`${options.label} process group survived SIGKILL.`);
    }
  }
  if (!(await waitForChildExit(child, 1_000))) {
    throw new Error(`${options.label} process-group leader did not exit.`);
  }
}

export async function codeMemoryLinkProcessGroupMembers(groupId: number): Promise<readonly number[]> {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('Process-group id is invalid.');
  const executable = process.platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps';
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ['-axo', 'pid=,pgid='], {stdio: ['ignore', 'pipe', 'pipe']});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', value => {
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > 8 * 1_024 * 1_024) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.on('data', value => stderr.push(Buffer.from(value)));
    child.once('error', rejectPromise);
    child.once('exit', code => {
      if (code !== 0 || bytes > 8 * 1_024 * 1_024) {
        rejectPromise(new Error(`Could not inspect process group: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolvePromise(
        Buffer.concat(stdout)
          .toString('utf8')
          .split(/\r?\n/u)
          .flatMap(line => {
            const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/u.exec(line);
            return match?.[2] === String(groupId) ? [Number(match[1])] : [];
          }),
      );
    });
  });
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupId, signal);
  } catch (cause) {
    if (!isNoSuchProcess(cause)) throw cause;
  }
}

async function waitForProcessGroupExit(groupId: number, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    if ((await codeMemoryLinkProcessGroupMembers(groupId)).length === 0) return true;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  } while (Date.now() < deadline);
  return false;
}

async function waitForChildExit(child: ChildProcess, timeoutMilliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise(resolvePromise => {
    const timeout = setTimeout(() => resolvePromise(false), timeoutMilliseconds);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolvePromise(true);
    });
  });
}

function decodeUtf8(chunks: readonly Buffer[], label: string): string {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
  } catch (cause) {
    throw new Error(`${label} was not valid UTF-8.`, {cause});
  }
}

function isNoSuchProcess(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ESRCH';
}
