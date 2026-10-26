/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Tests exercise the real JSON-RPC child-process boundary, not an Effect program. */
import {spawn} from 'node:child_process';
import {ownedProbeGroup, releaseProbeHandles, withinProbeDeadline} from './semantic_probe_process.js';

type Message = Record<string, unknown>;
export function appendProbeStderr(previous: {stderr: string; panicObserved: boolean}, chunk: string) {
  const text = previous.stderr + chunk;
  return {stderr: text.slice(-4096), panicObserved: previous.panicObserved || text.includes('panicked at')};
}

export const encodeProbeFrame = (message: unknown) => {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};

/** A disposable transport harness, not the P02 production transport. */
export class ProbeFrameDecoder {
  private buffered = Buffer.alloc(0);
  constructor(private readonly limit = 16 * 1024 * 1024) {}

  push(chunk: Uint8Array): Message[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: Message[] = [];
    while (this.buffered.length) {
      const end = this.buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buffered.length > 8192) throw new Error('LSP header exceeds probe limit');
        break;
      }
      if (end > 8192) throw new Error('LSP header exceeds probe limit');
      const lengths = this.buffered
        .subarray(0, end)
        .toString('ascii')
        .split('\r\n')
        .filter(line => /^content-length:/iu.test(line));
      if (lengths.length !== 1 || !/^content-length: *[0-9]+$/iu.test(lengths[0]))
        throw new Error('Invalid LSP Content-Length');
      const length = Number(lengths[0].split(':')[1]);
      if (!Number.isSafeInteger(length) || length > this.limit) throw new Error('LSP frame exceeds probe limit');
      if (this.buffered.length < end + 4 + length) break;
      const message: unknown = JSON.parse(this.buffered.subarray(end + 4, end + 4 + length).toString('utf8'));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid JSON-RPC object');
      messages.push(message as Message);
      this.buffered = this.buffered.subarray(end + 4 + length);
    }
    return messages;
  }
}

export async function observeProbeReadiness(
  request: (timeoutMs: number) => Promise<unknown>,
  matches: (value: unknown) => boolean,
  maximumMilliseconds = 60_000,
) {
  if (!Number.isSafeInteger(maximumMilliseconds) || maximumMilliseconds < 1 || maximumMilliseconds > 60_000)
    throw new Error('Invalid probe readiness budget');
  const deadline = performance.now() + maximumMilliseconds;
  const attempts: unknown[] = [];
  let attemptCount = 0;
  while (performance.now() < deadline) {
    attemptCount++;
    try {
      const detail = await request(Math.min(20_000, Math.max(1, Math.ceil(deadline - performance.now()))));
      if (attempts.length < 32) attempts.push(detail);
      if (matches(detail)) return {ready: true, attemptCount, attempts};
    } catch (error) {
      if (attempts.length < 32) attempts.push({error: String(error)});
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
  }
  return {ready: false, attemptCount, attempts};
}

export function startSemanticProbe(
  command: string,
  args: string[],
  cwd: string,
  settings: unknown = {},
  onNotification?: (method: string, params: unknown) => void,
) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ['PATH', 'LANG', 'TMPDIR', 'SYSTEMROOT', 'SystemRoot', 'WINDIR'].includes(key),
      ),
    ),
  });
  const group = ownedProbeGroup(child);
  const decoder = new ProbeFrameDecoder();
  const pending = new Map<
    number,
    {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}
  >();
  let nextId = 1;
  let failure: Error | undefined;
  let diagnostics = {stderr: '', panicObserved: false};
  let shutdownError: string | undefined;
  let shutdownCompleted = false;
  let stdioClosed = false;
  const events: string[] = [];
  const write = (message: Message) => child.stdin.write(encodeProbeFrame(message));
  const fail = (error: Error) => {
    failure = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  const kill = () => {
    group.signal('SIGKILL');
  };
  let observedExit: {code: number | null; signal: NodeJS.Signals | null} | undefined;
  const exited = new Promise<NonNullable<typeof observedExit>>(resolve => {
    child.once('exit', (code, signal) => {
      fail(new Error(`Provider exited (${code ?? signal})`));
      observedExit = {code, signal};
      resolve(observedExit);
    });
    child.once('error', error => {
      fail(error);
      observedExit = {code: null, signal: null};
      resolve(observedExit);
    });
  });
  const closed = new Promise<true>(resolve => {
    child.once('close', () => {
      stdioClosed = true;
      resolve(true);
    });
  });
  child.stdin.on('error', error => {
    shutdownError ??= String(error);
    fail(error);
  });
  child.stderr.on('data', chunk => {
    diagnostics = appendProbeStderr(diagnostics, String(chunk));
  });
  child.stdout.on('data', chunk => {
    try {
      for (const message of decoder.push(chunk)) {
        if (typeof message.method === 'string') {
          if (events.length < 64) events.push(message.method);
          if (message.id === undefined) onNotification?.(message.method, message.params);
          if (message.id !== undefined) {
            let result: unknown = null;
            let error: unknown;
            if (message.method === 'workspace/configuration') {
              const params = message.params as {items?: unknown[]};
              result = (params.items ?? []).map(() => settings);
            } else if (message.method === 'workspace/applyEdit') {
              result = {applied: false, failureReason: 'Feasibility probe never applies provider edits'};
            } else if (
              !['window/workDoneProgress/create', 'client/registerCapability', 'client/unregisterCapability'].includes(
                message.method,
              )
            ) {
              error = {code: -32601, message: 'Request not supported by disposable probe'};
            }
            write({jsonrpc: '2.0', id: message.id, ...(error ? {error} : {result})});
          }
        } else if (typeof message.id === 'number') {
          const item = pending.get(message.id);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(message.id);
            if (message.error) item.reject(new Error(JSON.stringify(message.error)));
            else item.resolve(message.result);
          }
        }
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      kill();
    }
  });
  const request = (method: string, params: unknown, timeoutMs = 20_000) => {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        write({jsonrpc: '2.0', method: '$/cancelRequest', params: {id}});
        reject(new Error(`Provider timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, {resolve, reject, timer});
      write({jsonrpc: '2.0', id, method, params});
    });
  };
  const finish = async () => {
    let exitTimedOut = false;
    try {
      if (failure) shutdownError = String(failure);
      else {
        try {
          const handshake = async () => {
            await request('shutdown', undefined, 2000);
            return new Promise<true>((resolve, reject) => {
              child.stdin.write(encodeProbeFrame({jsonrpc: '2.0', method: 'exit'}), error => {
                if (error) reject(error);
                else resolve(true);
              });
            });
          };
          if ((await withinProbeDeadline(handshake(), 2000)) !== true)
            throw new Error('Provider shutdown handshake did not complete before its deadline');
          shutdownCompleted = true;
        } catch (error) {
          shutdownError = String(error);
          kill();
        }
      }
      child.stdin.end();
      if ((await withinProbeDeadline(exited, 2000)) === undefined) {
        exitTimedOut = true;
        shutdownError ??= 'Provider exit was not observed before the shutdown deadline';
        kill();
      }
    } catch (error) {
      shutdownError = String(error);
    }
    let cleanup;
    try {
      cleanup = await group.cleanup();
    } catch (error) {
      cleanup = {scope: 'unknown', drained: false, forced: true, error: String(error)};
    } finally {
      if ((await withinProbeDeadline(closed, 2000)) === undefined)
        shutdownError ??= 'Provider stdio closure was not observed before the shutdown deadline';
      fail(new Error('Provider probe stopped'));
      releaseProbeHandles(child);
    }
    return {
      ...(observedExit ?? {code: null, signal: null}),
      exitObserved: observedExit !== undefined,
      exitTimedOut,
      forced: cleanup.forced,
      cleanup: {...cleanup, drained: cleanup.drained && observedExit !== undefined},
      pid: child.pid,
      ...diagnostics,
      shutdownCompleted: shutdownCompleted && shutdownError === undefined,
      stdioClosed,
      shutdownError,
    };
  };
  let stopping: ReturnType<typeof finish> | undefined;
  return {
    request,
    notify: (method: string, params: unknown) => write({jsonrpc: '2.0', method, params}),
    events,
    stop: () => (stopping ??= finish()),
  };
}
