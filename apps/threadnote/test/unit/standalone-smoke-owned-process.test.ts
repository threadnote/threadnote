import {EventEmitter} from 'node:events';
import {PassThrough} from '@threadnote/testing/node-stream';
import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import * as EffectString from 'effect/String';
import {
  fixtureDeadline,
  FixtureProcesses,
  FixtureStdioTransport,
  runFixtureCommand,
} from '../../../../scripts/fixture-owned-process.js';

function commandChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: () => {},
    kill: () => {
      throw new Error('must not signal');
    },
  });
}

function commandFailureDetails(outcome: unknown): unknown {
  if (!(outcome instanceof Error)) throw new Error('Expected a fixture command failure.');
  const prefix = 'Fixture command failed or output exceeded limit: ';
  expect(EffectString.startsWith(prefix)(outcome.message)).toBe(true);
  return JSON.parse(EffectString.slice(prefix.length)(outcome.message));
}

it.each(['nonzero-exit', 'missing-exit-code', 'signal', 'child-error', 'spawn-error', 'output-overflow'] as const)(
  'reports %s only after the owned command closes',
  async scenario => {
    const reason = scenario === 'spawn-error' ? 'child-error' : scenario;
    const child = commandChild();
    const processes = new FixtureProcesses(() => child);
    let settled = false;
    const command = runFixtureCommand(processes, 'PRIVATE_COMMAND', ['PRIVATE_ARGUMENT'], {
      stage: 'recall',
      cwd: 'PRIVATE_PATH',
      env: {PRIVATE_ENV: 'PRIVATE_VALUE'},
      deadline: performance.now() + 1000,
      maxOutputBytes: 4,
    })
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true;
      });
    if (scenario !== 'spawn-error') child.emit('spawn');
    child.stdout.write('out');
    if (reason === 'output-overflow') child.stderr.write('PRIVATE_OUTPUT');
    if (reason === 'child-error') child.emit('error', new Error('PRIVATE_ERROR'));
    if (reason !== 'missing-exit-code')
      child.emit('exit', reason === 'nonzero-exit' ? 7 : 0, reason === 'signal' ? 'SIGTERM' : null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close');
    const details = commandFailureDetails(await command);
    expect(details).toEqual({
      stage: 'recall',
      observed: 'owned-close',
      reason,
      spawned: scenario !== 'spawn-error',
      exited: reason !== 'missing-exit-code',
      childError: reason === 'child-error',
      exitCode: reason === 'missing-exit-code' ? null : reason === 'nonzero-exit' ? 7 : 0,
      signal: reason === 'signal' ? 'SIGTERM' : null,
      stdoutBytes: 3,
      stderrBytes: reason === 'output-overflow' ? 5 : 0,
      totalBytes: reason === 'output-overflow' ? 5 : 3,
      maxOutputBytes: 4,
      overflow: reason === 'output-overflow',
    });
    expect(JSON.stringify(details)).not.toContain('PRIVATE_');
  },
);

it('preserves deadline failure without claiming an observed close', async () => {
  const child = commandChild();
  const processes = new FixtureProcesses(() => child);
  const command = runFixtureCommand(processes, 'fixture', [], {
    stage: 'version',
    cwd: '.',
    env: {},
    deadline: performance.now() + 5,
    maxOutputBytes: 4,
  });
  child.emit('spawn');
  child.emit('exit', 0, null);
  await expect(command).rejects.toThrow('Fixture deadline expired');
});

it('keeps command acceptance and private failure projection invariant under output chunking', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({min: 0, max: 128}),
      fc.integer({min: 0, max: 128}),
      fc.integer({min: 1, max: 128}),
      fc.integer({min: 1, max: 32}),
      fc.integer({min: 0, max: 3}),
      fc.constantFrom(null, 'SIGTERM', 'PRIVATE_SIGNAL'),
      fc.boolean(),
      async (outBytes, errBytes, cap, width, code, signal, childError) => {
        const capture = async (chunkWidth: number) => {
          const child = commandChild();
          const processes = new FixtureProcesses(() => child);
          const options = {
            stage: 'recall' as const,
            cwd: 'PRIVATE_PATH',
            env: {PRIVATE_ENV: 'PRIVATE_VALUE'},
            deadline: performance.now() + 1000,
            maxOutputBytes: cap,
          };
          // Runtime callers cannot turn the stage identifier into an arbitrary payload.
          Reflect.set(options, 'stage', 'PRIVATE_STAGE');
          const command = runFixtureCommand(processes, 'PRIVATE_COMMAND', ['PRIVATE_ARGUMENT'], options).catch(
            (cause: unknown) => cause,
          );
          child.emit('spawn');
          for (const [stream, count, character] of [
            [child.stdout, outBytes, 'x'],
            [child.stderr, errBytes, 'y'],
          ] as const) {
            for (let emitted = 0; emitted < count; emitted += chunkWidth)
              stream.write(EffectString.repeat(Math.min(chunkWidth, count - emitted))(character));
          }
          if (childError) child.emit('error', new Error('PRIVATE_ERROR'));
          child.emit('exit', code, signal);
          child.emit('close');
          const outcome = await command;
          if (outBytes + errBytes <= cap && code === 0 && signal === null && !childError) {
            expect(outcome).toEqual({
              stdout: EffectString.repeat(outBytes)('x'),
              stderr: EffectString.repeat(errBytes)('y'),
            });
            return outcome;
          }
          const details = commandFailureDetails(outcome);
          expect(details).toMatchObject({
            stage: 'unspecified',
            observed: 'owned-close',
            stdoutBytes: Math.min(outBytes, cap + 1),
            stderrBytes: Math.min(errBytes, cap + 1),
            totalBytes: Math.min(outBytes + errBytes, cap + 1),
            maxOutputBytes: cap,
            overflow: outBytes + errBytes > cap,
            signal: signal === 'PRIVATE_SIGNAL' ? 'other' : signal,
          });
          expect(JSON.stringify(details)).not.toContain('PRIVATE_');
          return details;
        };
        expect(await capture(width)).toEqual(await capture(256));
      },
    ),
    {
      numRuns: 24,
      examples: [
        [2, 2, 4, 1, 0, null, false],
        [2, 3, 4, 1, 0, null, false],
      ],
    },
  );
});

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
