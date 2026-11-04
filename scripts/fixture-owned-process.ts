// oxlint-disable-next-line threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Direct child handles and close events are required for fixture-only producer exit proof.
import {spawn, type ChildProcess} from 'node:child_process';
import {Array as EffectArray} from 'effect';
import {ReadBuffer, serializeMessage} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {FixtureProducers} from '@threadnote/testing/fixture-producers';

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

export async function runFixtureCommand(
  processes: FixtureProcesses,
  command: string,
  args: readonly string[],
  options: {cwd: string; env: NodeJS.ProcessEnv; deadline: number; maxOutputBytes: number},
) {
  if (processes.remaining(options.deadline) <= 0) throw new Error('Fixture body deadline expired');
  const child = processes.spawn(command, args, options);
  child.stdin?.end();
  let stdout = '';
  let stderr = '';
  let size = 0;
  let overflow = false;
  const collect = (isOut: boolean) => (chunk: Buffer) => {
    size += chunk.length;
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
  const complete = new Promise<void>(resolve => {
    child.once('error', () => {
      failed = true;
    });
    child.once('exit', (value, signalled) => {
      code = value;
      signal = signalled;
    });
    child.once('close', () => resolve());
  });
  await processes.wait(options.deadline, complete);
  if (failed || code !== 0 || signal !== null || overflow)
    throw new Error('Fixture command failed or output exceeded limit');
  return {stdout, stderr};
}

export class FixtureStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: FixtureChild;
  private readonly buffer = new ReadBuffer();
  private closePromise?: Promise<void>;
  private exit: {code: number | null; signal: NodeJS.Signals | null} | undefined;
  constructor(
    private readonly processes: FixtureProcesses,
    private readonly options: {
      command: string;
      args: readonly string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      deadline: number;
    },
  ) {}
  async start(): Promise<void> {
    if (this.child) throw new Error('MCP transport already started');
    if (this.processes.remaining(this.options.deadline) <= 0) throw new Error('Fixture body deadline expired');
    const child = this.processes.spawn(this.options.command, this.options.args, this.options);
    this.child = child;
    child.once('exit', (code, signal) => {
      this.exit = {code, signal};
    });
    this.closePromise = new Promise(resolve =>
      child.once('close', () => {
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
    this.child?.stdin?.end();
    await this.closePromise;
    if (!this.exit || this.exit.code !== 0 || this.exit.signal !== null)
      throw new Error('MCP child did not exit cleanly');
  }
}
