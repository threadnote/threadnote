import {EventEmitter} from 'node:events';
import {PassThrough} from '@threadnote/testing/node-stream';
import {expect, it, vi} from 'vitest';
import {fixtureDeadline, FixtureProcesses, FixtureStdioTransport} from '../../../../scripts/fixture-owned-process.js';

it('requests EOF and waits for the owned MCP child exit and close', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: () => {},
    kill: () => {
      throw new Error('must not signal');
    },
  });
  const processes = new FixtureProcesses(() => child);
  const transport = new FixtureStdioTransport(processes, {
    command: 'fixture',
    args: [],
    cwd: '.',
    env: {},
    deadline: performance.now() + 1000,
  });
  const started = transport.start();
  child.emit('spawn');
  await started;
  let closed = false;
  const close = transport.close().then(() => {
    closed = true;
  });
  expect(child.stdin.writableEnded).toBe(true);
  child.emit('exit', 0, null);
  await Promise.resolve();
  expect(closed).toBe(false);
  child.emit('close', 0, null);
  await close;
  expect(await processes.closeAndObserve(performance.now() + 1000)).toBe('exited');
});

it('does not accept a close without observed exit', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: () => {},
    kill: () => {
      throw new Error('must not signal');
    },
  });
  const processes = new FixtureProcesses(() => child);
  const transport = new FixtureStdioTransport(processes, {
    command: 'fixture',
    args: [],
    cwd: '.',
    env: {},
    deadline: performance.now() + 1000,
  });
  const started = transport.start();
  child.emit('spawn');
  await started;
  const close = transport.close();
  child.emit('close', null, null);
  await expect(close).rejects.toThrow('did not exit cleanly');
  expect(await processes.closeAndObserve(performance.now() + 5)).toBe('unknown');
});

it('does not launch a new producer after either original clock budget expires', async () => {
  let launches = 0;
  const launch = () => {
    launches++;
    throw new Error('unexpected launch');
  };
  for (const [epoch, monotonic] of [
    [Date.now() - 1, performance.now() + 1000],
    [Date.now() + 1000, performance.now() - 1],
  ]) {
    const processes = new FixtureProcesses(launch, epoch, monotonic);
    const transport = new FixtureStdioTransport(processes, {
      command: 'fixture',
      args: [],
      cwd: '.',
      env: {},
      deadline: monotonic,
    });
    await expect(transport.start()).rejects.toThrow('deadline');
  }
  expect(launches).toBe(0);
});

it('a wall clock rollback cannot extend the original monotonic deadline', () => {
  const epoch = Date.now();
  const monotonic = performance.now();
  const processes = new FixtureProcesses(undefined, epoch + 1000, monotonic + 1000);
  const wallClock = vi.spyOn(Date, 'now').mockReturnValue(epoch - 60_000);
  try {
    expect(processes.remaining(monotonic + 1000)).toBeLessThanOrEqual(1000);
    wallClock.mockReturnValue(epoch + 2000);
    expect(processes.remaining(monotonic + 1000)).toBeLessThanOrEqual(0);
  } finally {
    wallClock.mockRestore();
  }
});

it('rejects an operation that completes after its original deadline before a timer fires', async () => {
  let remaining = 10;
  const operation = Promise.resolve().then(() => {
    remaining = 0;
  });
  await expect(fixtureDeadline(() => remaining, operation)).rejects.toThrow('deadline');
});

it('preserves a child operation failure when it wins the deadline race', async () => {
  const original = new Error('child failed');
  await expect(fixtureDeadline(() => 10, Promise.reject(original))).rejects.toBe(original);
});
