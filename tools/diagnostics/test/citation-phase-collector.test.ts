import {Array as EffectArray, Option as EffectOption} from 'effect';
import {expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, Fiber, Stream, Sink, FileSystem} from 'effect';
import {make as makeSpawner, makeHandle, ProcessId, ExitCode} from 'effect/process/ChildProcessSpawner';
import * as ChildProcess from 'effect/process/ChildProcess';
import fc from 'fast-check';
import {CommandFailed} from '@threadnote/platform/command';
import {Collector, commandOperation, intervalUnion} from '../citation-phase-collector.js';

it('distinguishes metadata carrying --git-path from exclude policy and private status', () => {
  expect(commandOperation('/usr/bin/git', ['rev-parse', '--git-path', 'index'], false)).toBe('identity-metadata');
  expect(commandOperation('git', ['rev-parse', '--git-path', 'info/exclude'], false)).toBe('info-exclude-path');
  expect(commandOperation('git', ['status', '--untracked-files=no'], false)).toBe('canonical-tracked-status');
  expect(commandOperation('git', ['status'], true)).toBe('private-untracked-status');
  expect(commandOperation('/sensitive/path/custom', ['secret'], false)).toBe('other-command');
});

it('unions intervals against an independent bounded occupancy model; order and duplicates are irrelevant', () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({start: fc.integer({min: 0, max: 40}), milliseconds: fc.integer({min: 0, max: 20})}), {
        maxLength: 25,
      }),
      events => {
        const occupied = new Set<number>();
        for (const e of events) for (let n = e.start; n < e.start + e.milliseconds; n++) occupied.add(n);
        expect(intervalUnion(events)).toBe(occupied.size);
        expect(intervalUnion(events)).toBeGreaterThanOrEqual(0);
        expect(intervalUnion(events)).toBeLessThanOrEqual(
          EffectArray.reduce(events, 0, (total, event) => total + event.milliseconds),
        );
        expect(intervalUnion([...events].reverse())).toBe(occupied.size);
        expect(intervalUnion([...events, ...events])).toBe(occupied.size);
      },
    ),
    {seed: 844, numRuns: 100},
  );
});

effectIt.effect('forwards both command boundaries without changing arguments, options, results or failure', () =>
  Effect.gen(function* () {
    const collector = new Collector();
    const args = ['status'];
    const options = {trustedGitIndexFile: '/synthetic/private/index'};
    const bytes = new Uint8Array([0, 255, 10]);
    const result = {stdout: 'unchanged', stderr: '', exitCode: 0};
    const binary = {stdout: bytes, stderr: '', exitCode: 0};
    const failure = CommandFailed.make({
      executable: 'git',
      args: [],
      message: 'same-failure',
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
    const received: unknown[][] = [];
    const executor = {
      execute: (...input: unknown[]) => {
        received.push(input);
        return Effect.succeed(result);
      },
      executeBytes: (...input: unknown[]) => {
        received.push(input);
        return Effect.succeed(binary);
      },
      executeStreaming: () => Effect.succeed(result),
    };
    const wrapped = collector.command(executor);
    yield* collector.sample(
      0,
      Effect.gen(function* () {
        expect(yield* wrapped.execute('git', args, options)).toBe(result);
        expect(yield* wrapped.executeBytes!('git', args, options)).toBe(binary);
      }),
    );
    expect(EffectArray.every(received, row => row[1] === args && row[2] === options)).toBe(true);
    expect(EffectArray.filter(collector.events, e => e.kind === 'command')).toHaveLength(2);
    expect(
      EffectArray.map(
        EffectArray.filter(collector.events, e => e.kind === 'command'),
        e => e.operation,
      ),
    ).toEqual(['private-untracked-status', 'private-untracked-status']);
    expect(JSON.stringify(collector.events)).not.toContain('/synthetic');
    const failing = collector.command({...executor, execute: () => Effect.fail(failure)});
    const exit = yield* collector.sample(1, failing.execute('git', args)).pipe(Effect.exit);
    expect(
      Exit.isFailure(exit) &&
        EffectArray.some(exit.cause.reasons, reason => reason._tag === 'Fail' && reason.error === failure),
    ).toBe(true);
  }),
);

effectIt.effect('retains interruption and finalizers and never consumes child streams', () =>
  Effect.gen(function* () {
    const collector = new Collector(100);
    let consumed = 0;
    let finalized = 0;
    const entered = yield* Deferred.make<void>();
    const stream = Stream.fromEffect(
      Effect.sync(() => {
        consumed++;
        return new Uint8Array();
      }),
    );
    const handle = makeHandle({
      pid: ProcessId(17),
      stdout: stream,
      stderr: stream,
      exitCode: Effect.succeed(ExitCode(0)),
      kill: () => Effect.void,
      stdin: Sink.drain,
      all: stream,
      isRunning: Effect.succeed(false),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
    const original = makeSpawner(() => Effect.succeed(handle));
    const wrapped = collector.spawner(original);
    yield* collector.sample(
      3,
      Effect.scoped(
        Effect.gen(function* () {
          const observed = yield* wrapped.spawn(ChildProcess.make('git', ['status']));
          expect(observed.stdout).toBe(stream);
          expect(observed.stderr).toBe(stream);
          expect(observed.kill).toBe(handle.kill);
          expect(yield* observed.exitCode).toBe(0);
        }),
      ),
    );
    expect(consumed).toBe(0);
    const running = collector.sample(
      4,
      collector.measure(
        'store',
        'boundary',
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized++;
            }),
          ),
        ),
      ),
    );
    const fiber = yield* running.pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    expect(finalized).toBe(1);
    expect(EffectArray.some(collector.events, e => e.sample === 4 && e.outcome === 'interrupted')).toBe(true);
  }),
);

effectIt.effect('keeps concurrent phase and command IDs fiber-local and reports overflow', () =>
  Effect.gen(function* () {
    const collector = new Collector(3);
    const run = (sample: number) =>
      collector.sample(
        sample,
        collector.phase('closing', collector.measure('file', 'stat:canonical-index', Effect.succeed(sample))),
      );
    expect(yield* Effect.all([run(1), run(2)], {concurrency: 2})).toEqual([1, 2]);
    expect(collector.dropped).toBeGreaterThan(0);
    expect(
      EffectArray.every(
        EffectArray.filter(collector.events, e => e.kind === 'file'),
        e => e.phase === 'closing',
      ),
    ).toBe(true);
  }),
);

effectIt.effect('distinguishes typed errors, defects and interruptions and invalidates truncated coverage', () =>
  Effect.gen(function* () {
    const collector = new Collector();
    yield* collector.sample(0, collector.measure('store', 'typed', Effect.fail('typed'))).pipe(Effect.exit);
    yield* collector.sample(1, collector.measure('store', 'defect', Effect.die('defect'))).pipe(Effect.exit);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(collector.events, event => event.operation === 'typed'))
        ?.outcome,
    ).toBe('typed-error');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(collector.events, event => event.operation === 'defect'))
        ?.outcome,
    ).toBe('defect');
  }),
);

effectIt.effect(
  'scopes path categories to concurrent synthetic invocations and detects work after its observation ends',
  () =>
    Effect.gen(function* () {
      const collector = new Collector();
      const fs = collector.filesystem(FileSystem.makeNoop({readFile: () => Effect.succeed(new Uint8Array([1]))}));
      yield* Effect.all(
        [
          collector.sample(1, fs.readFile('/fixture-a/src/x.ts'), {sourceRoot: '/fixture-a'}),
          collector.sample(2, fs.readFile('/fixture-a/src/x.ts'), {sourceRoot: '/fixture-b'}),
        ],
        {concurrency: 2},
      );
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(collector.events, event => event.kind === 'file' && event.sample === 1),
        )?.operation,
      ).toBe('readFile:cited-source');
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(collector.events, event => event.kind === 'file' && event.sample === 2),
        )?.operation,
      ).toBe('readFile:other');
      const proceed = yield* Deferred.make<void>();
      const child = yield* collector.sample(
        3,
        Deferred.await(proceed).pipe(
          Effect.andThen(collector.measure('file', 'stat:other', Effect.void)),
          Effect.forkScoped,
        ),
      );
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(child);
      expect(collector.lateEvents).toBe(1);
      expect(collector.lateInvocationEvents).toBe(1);
      const cleanup = yield* Deferred.make<void>();
      const cleanupFiber = yield* collector.sample(
        4,
        Deferred.await(cleanup).pipe(
          Effect.andThen(collector.measure('file', 'remove:other', Effect.void)),
          Effect.forkScoped,
        ),
      );
      collector.beginTeardown();
      yield* Deferred.succeed(cleanup, undefined);
      yield* Fiber.join(cleanupFiber);
      expect(collector.teardownEvents).toBe(1);
      expect(collector.lateInvocationEvents).toBe(1);
      expect(JSON.stringify(collector.events)).not.toContain('/fixture-');
    }),
);
