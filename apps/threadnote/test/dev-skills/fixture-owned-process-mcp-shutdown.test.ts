import {EventEmitter} from 'node:events';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Child-process writable events are the transport behavior under test.
import {PassThrough} from 'node:stream';
import {expect, it} from 'vitest';
import {FixtureProcesses, FixtureStdioTransport} from '../../../../scripts/fixture-owned-process.js';

class TestFixtureChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  unref(): void {}
}

const fixture = (
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  emitExit = true,
  emitClose = true,
  deadlineMilliseconds = 10_000,
) => {
  const child = new TestFixtureChild();
  const processes = new FixtureProcesses(() => {
    child.stdin.once('finish', () => {
      queueMicrotask(() => {
        if (emitExit) child.emit('exit', exitCode, signal);
        if (emitClose) {
          child.emit('close', exitCode, signal);
          child.stdout.destroy();
          child.stderr.destroy();
        }
      });
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const deadline = performance.now() + deadlineMilliseconds;
  const transport = new FixtureStdioTransport(processes, {
    args: ['mcp-server'],
    command: 'non-product fixture child',
    cwd: '/private/fixture',
    env: {},
    deadline,
    shutdownMode: 'effect-mcp-stdio-eof-130',
  });
  return {child, deadline, processes, transport};
};

it('accepts only initialized MCP EOF followed by the observed no-signal Effect 130 exit', async () => {
  const {transport} = fixture(130, null);
  await transport.start();
  transport.markMcpInitialized();
  await expect(transport.close()).resolves.toBeUndefined();
});

it('rejects exit 130 when stdin finish has not been observed at exit, even if finish follows', async () => {
  const {child, transport} = fixture(130, null);
  const end = child.stdin.end;
  Object.defineProperty(child.stdin, 'end', {
    value: (...args: Parameters<typeof child.stdin.end>) => {
      child.emit('exit', 130, null);
      Reflect.apply(end, child.stdin, args);
      child.once('finish', () => queueMicrotask(() => child.emit('close', 130, null)));
      return child.stdin;
    },
  });
  await transport.start();
  transport.markMcpInitialized();
  await expect(transport.close()).rejects.toThrow('MCP child did not exit cleanly');
});

it('rejects EOF-requested exit 130 and close when stdin finish never arrives', async () => {
  const {child, transport} = fixture(130, null);
  Object.defineProperty(child.stdin, 'end', {
    value: () => {
      child.emit('exit', 130, null);
      child.emit('close', 130, null);
      return child.stdin;
    },
  });
  await transport.start();
  transport.markMcpInitialized();
  await expect(transport.close()).rejects.toThrow('MCP child did not exit cleanly');
});

it('keeps the default strict and rejects early, uninitialized, abnormal, missing, or expired outcomes', async () => {
  const strict = fixture(130, null);
  const strictTransport = new FixtureStdioTransport(strict.processes, {
    args: ['mcp-server'],
    command: 'non-product fixture child',
    cwd: '/private/fixture',
    env: {},
    deadline: performance.now() + 10_000,
  });
  await strictTransport.start();
  strictTransport.markMcpInitialized();
  await expect(strictTransport.close()).rejects.toThrow('MCP child did not exit cleanly');

  const uninitialized = fixture(130, null);
  await uninitialized.transport.start();
  await expect(uninitialized.transport.close()).rejects.toThrow('MCP child did not exit cleanly');

  const beforeEof = fixture(130, null);
  await beforeEof.transport.start();
  beforeEof.transport.markMcpInitialized();
  beforeEof.child.emit('exit', 130, null);
  beforeEof.child.emit('close', 130, null);
  await expect(beforeEof.transport.close()).rejects.toThrow('MCP child did not exit cleanly');

  const nonzero = fixture(131, null);
  await nonzero.transport.start();
  nonzero.transport.markMcpInitialized();
  await expect(nonzero.transport.close()).rejects.toThrow('MCP child did not exit cleanly');

  const signalled = fixture(null, 'SIGINT');
  await signalled.transport.start();
  signalled.transport.markMcpInitialized();
  await expect(signalled.transport.close()).rejects.toThrow('MCP child did not exit cleanly');

  const missingExit = fixture(130, null, false);
  await missingExit.transport.start();
  missingExit.transport.markMcpInitialized();
  await expect(missingExit.transport.close()).rejects.toThrow('MCP child did not exit cleanly');

  const missingClose = fixture(130, null, true, false, 200);
  await missingClose.transport.start();
  missingClose.transport.markMcpInitialized();
  await expect(missingClose.processes.wait(missingClose.deadline, missingClose.transport.close())).rejects.toThrow(
    'Fixture deadline expired',
  );
  missingClose.child.emit('close', 130, null);

  const expired = fixture(130, null);
  await expired.transport.start();
  expired.transport.markMcpInitialized();
  const remaining = expired.processes.remaining.bind(expired.processes);
  expired.processes.remaining = () => 0;
  await expect(expired.transport.close()).rejects.toThrow('MCP child did not exit cleanly');
  expired.processes.remaining = remaining;
});
