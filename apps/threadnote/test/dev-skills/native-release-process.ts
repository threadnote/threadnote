/** Host-only OS boundary. Product commands always use the extracted executable. */
// Bun 1.4.2 compile cannot bundle the testing builtin export-star wrappers.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {spawnSync} from 'node:child_process';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Same compiled host-boundary requirement.
import {writeFileSync} from 'node:fs';

const diagnosticLimit = 16 * 1024;
const normalize = (text: string) => text.replace(/\r\n?/g, '\n');
export const decodeReleaseOutput = (value: Uint8Array): string =>
  normalize(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(value));

// oxlint-disable-next-line effecttsgo/extends-native-error -- Host OS boundary preserves process failure fields, outside the Effect failure channel.
export class ReleaseCommandError extends Error {
  readonly args: readonly string[];
  readonly cmd: readonly string[];
  readonly output: Buffer;
  readonly returncode: number | null;
  readonly timedOut: boolean;
  constructor(
    readonly command: readonly string[],
    readonly status: number | null,
    readonly stdout: Buffer,
    readonly stderr: Buffer,
    readonly signal: NodeJS.Signals | null,
    readonly cause?: Error & {code?: string},
  ) {
    super(`Release command ${cause?.code === 'ETIMEDOUT' ? 'timed out' : 'failed'} (status ${status}): ${command[0]}`);
    this.name = 'ReleaseCommandError';
    this.args = command;
    this.cmd = command;
    this.output = stdout;
    this.returncode = status;
    this.timedOut = cause?.code === 'ETIMEDOUT';
  }
}

/** Retain raw bytes first; diagnostics are bounded, lossy human companions only. */
const persistEvidence = (
  path: string,
  stdout: Buffer,
  stderr: Buffer,
  status: number | null,
  signal: string | null,
  error?: Error,
) => {
  writeFileSync(`${path}.stdout.bin`, stdout);
  writeFileSync(`${path}.stderr.bin`, stderr);
  const readable = (bytes: Buffer) => normalize(bytes.subarray(0, diagnosticLimit).toString('utf8'));
  writeFileSync(
    path,
    `status=${status} signal=${signal ?? 'none'} error=${error?.message ?? 'none'}\nstdout (${stdout.length} bytes):\n${readable(stdout)}\nstderr (${stderr.length} bytes):\n${readable(stderr)}\n`,
    'utf8',
  );
};

export function runReleaseCommandBytes(
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  options: {timeoutMs?: number; input?: string; evidencePath?: string} = {},
): {stdout: Buffer; stderr: Buffer} {
  if (!command.length) throw new Error('Release command must include an executable');
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: environment,
    input: options.input === undefined ? undefined : Buffer.from(options.input, 'utf8'),
    timeout: options.timeoutMs ?? 120_000,
    killSignal: 'SIGKILL',
    maxBuffer: Number.MAX_SAFE_INTEGER,
    windowsHide: true,
  });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  if (options.evidencePath)
    persistEvidence(options.evidencePath, stdout, stderr, result.status, result.signal, result.error);
  // Failure callers need the original binary captures, even when either pipe is malformed.
  if (result.error || result.status !== 0) {
    throw new ReleaseCommandError(command, result.status, stdout, stderr, result.signal, result.error);
  }
  return {stdout, stderr};
}

export function runReleaseCommand(
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  options: {timeoutMs?: number; input?: string; evidencePath?: string} = {},
): string {
  const {stdout, stderr} = runReleaseCommandBytes(command, environment, cwd, options);
  const output = decodeReleaseOutput(stdout);
  decodeReleaseOutput(stderr);
  return output;
}
