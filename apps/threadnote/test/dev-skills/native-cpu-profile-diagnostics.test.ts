import {it as effectIt} from '@effect/vitest';
import {Cause, ConfigProvider, Effect, Exit, Schema} from 'effect';
import type {SamplingProfile, SamplingProfileStackFrame} from 'bun:jsc';
import {expect, it} from 'vitest';
import {
  captureNativeCpu,
  nativeCpuLimits,
  summarizeNativeCpu,
  type NativeCpuPacket,
  type NativeCpuProfiler,
} from './native-cpu-profile-diagnostics.js';

const root = new URL('../../../../', import.meta.url);
const frame = (name = 'close', sourceURL?: string): SamplingProfileStackFrame => ({
  name,
  sourceURL,
  sourceID: sourceURL ? 1 : 4_294_967_295,
  category: sourceURL ? 'DFG' : 'Unknown Executable',
  location: '',
  line: 4,
  column: 1,
  flags: 0,
});
const source = (path: string) => frame('allowed', new URL(path, root).href);
const driver = () => source('node_modules/@effect/sql-sqlite-bun/dist/SqliteClient.js');
const recall = () => source('packages/recall/src/index/database.ts');
const profile = (traces: SamplingProfileStackFrame[][]): SamplingProfile => ({
  functions: '',
  bytecodes: '',
  stackTraces: {
    interval: 0.01,
    sources: [],
    traces: traces.map(frames => ({timestamp: 0, frames})),
  },
});
const completed =
  (value = profile([[frame(), driver(), recall()]])): NativeCpuProfiler =>
  async done => {
    await done();
    return value;
  };

it('partitions CLOSE using only qualified context from that same bounded trace', () => {
  const summary = summarizeNativeCpu(
    profile([
      [frame(), driver(), recall()],
      [frame(), driver()],
      [frame(), recall()],
      [frame()],
      [frame(), frame('PRIVATE', 'file:///private/PRIVATE.ts')],
      [frame(), ...Array.from({length: 31}, () => frame('inlined')), driver(), recall()],
      [frame('close', new URL('packages/recall/src/index/database.ts', root).href), driver(), recall()],
      [
        frame('close', undefined),
        {...driver(), sourceURL: driver().sourceURL?.replace('SqliteClient.js', 'SqliteClient.js.evil')},
        recall(),
      ],
    ]),
  );
  expect(summary.close).toEqual({
    nativeCloseTotal: 7,
    closeDriverAndRecallObserved: 1,
    closeDriverObservedRecallUnknown: 1,
    closeDriverUnknown: 5,
    missingContext: 1,
    rejectedContext: 1,
    truncatedContext: 1,
  });
  expect(summary.omissions.frames).toBe(2);
  expect(JSON.stringify(summary)).not.toContain('PRIVATE');
  expect(summary.dependency.some(row => row.file === 'node_modules/@effect/sql-sqlite-bun/dist/SqliteClient.js')).toBe(
    true,
  );
});

it('rejects traversal, wrong roots, encoded separators, query strings and unqualified native names', () => {
  const privatePaths = [
    'file:///PRIVATE/packages/recall/src/index/database.ts',
    root.href + 'packages/../PRIVATE.ts',
    root.href + 'packages/%2e%2e/PRIVATE.ts',
    root.href + 'packages/recall/src/index/database.ts?PRIVATE',
    root.href + 'node_modules/@effect/sql-sqlite-bun/../../PRIVATE.ts',
    root.href + 'packages/PRIVATE%2f..%2f..%2foutside.ts',
  ];
  const summary = summarizeNativeCpu(
    profile(
      privatePaths
        .map(path => [frame(), frame('PRIVATE', path)])
        .concat([[{...frame(), sourceID: 1}], [{...frame(), category: 'PRIVATE'}], [frame('PRIVATE')]]),
    ),
  );
  expect(summary.close.nativeCloseTotal).toBe(privatePaths.length);
  expect(summary.close.closeDriverUnknown).toBe(privatePaths.length);
  expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|file:|Users|outside/u);
});

effectIt.effect.prop(
  'never joins contexts across traces and preserves the CLOSE partition',
  {
    driverAt: Schema.Literals([-1, 0, 1, 2, 31, 32, 64]),
    recallAt: Schema.Literals([-1, 0, 1, 2, 31, 32, 64]),
    split: Schema.Boolean,
  },
  ({driverAt, recallAt, split}) =>
    Effect.sync(() => {
      const traces = [
        Array.from({length: 66}, () => frame('unknown')),
        Array.from({length: 66}, () => frame('unknown')),
      ];
      for (const trace of traces) trace[0] = frame();
      if (driverAt >= 0) traces[0][driverAt + 1] = driver();
      if (recallAt >= 0) traces[split ? 1 : 0][recallAt + 1] = recall();
      const {close} = summarizeNativeCpu(profile(traces));
      expect(
        close.closeDriverAndRecallObserved + close.closeDriverObservedRecallUnknown + close.closeDriverUnknown,
      ).toBe(close.nativeCloseTotal);
      if (split) expect(close.closeDriverAndRecallObserved).toBe(0);
      if (driverAt >= 31 || driverAt < 0) expect(close.closeDriverAndRecallObserved).toBe(0);
    }),
);

it('bounds trace/frame/key/table/UTF-8 storage with exact omitted row/sample accounting', () => {
  const traces = Array.from({length: 5000}, (_, index) => [
    source(`packages/recall/src/f${index}.ts`),
    source(`node_modules/effect/dist/f${index}.js`),
  ]);
  const summary = summarizeNativeCpu(profile(traces));
  expect(summary.omissions.keys.self).toBe(905);
  for (const table of ['self', 'application', 'dependency'] as const) {
    expect(summary[table].length).toBeLessThanOrEqual(nativeCpuLimits[table]);
    expect(summary[table].reduce((sum, row) => sum + row.samples, 0) + summary.omissions.samples[table]).toBe(5000);
    expect(summary[table].length + summary.omissions.rows[table]).toBe(4096);
  }
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(nativeCpuLimits.bytes);
  const capped = summarizeNativeCpu(profile(Array.from({length: 65_538}, () => [frame()])));
  expect(capped.analyzedTraces).toBe(65_536);
  expect(capped.omissions.traces).toBe(2);
});

it('returns the exact disabled Effect without invoking the loader, sink or clocks', () => {
  const program = Effect.succeed(1);
  const crash = () => {
    throw new Error('disabled');
  };
  expect(captureNativeCpu(program, crash, {enabled: false, load: crash})).toBe(program);
});

effectIt.effect('awaits mocked Promise completion after provided-scope finalization for every original Exit', () =>
  Effect.gen(function* () {
    const value = {original: true};
    for (const kind of ['success', 'failure', 'defect', 'interruption'] as const) {
      const events: string[] = [];
      const packets: NativeCpuPacket[] = [];
      const original =
        kind === 'success'
          ? Effect.succeed(value)
          : kind === 'failure'
            ? Effect.fail(value)
            : kind === 'defect'
              ? Effect.die(value)
              : Effect.interrupt;
      const program = Effect.acquireUseRelease(
        Effect.sync(() => events.push('acquire')),
        () => original,
        () => Effect.sync(() => events.push('release')),
      );
      const result = yield* captureNativeCpu(
        program,
        packet => {
          events.push('sink');
          packets.push(packet);
        },
        {
          enabled: true,
          load: async () => async done => {
            events.push('profile');
            await done();
            events.push('complete');
            return profile([[frame()]]);
          },
        },
      ).pipe(Effect.exit);
      expect(events).toEqual(['profile', 'acquire', 'release', 'complete', 'sink']);
      expect(packets).toHaveLength(1);
      expect(packets[0]).toMatchObject({
        status: 'captured',
        outcome: kind === 'success' ? 'Success' : 'Failure',
        intervalMicros: 10000,
      });
      if (kind === 'success') {
        expect(Exit.isSuccess(result)).toBe(true);
        if (Exit.isSuccess(result)) expect(result.value).toBe(value);
      } else if (kind === 'interruption') expect(Exit.hasInterrupts(result)).toBe(true);
      else if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(value);
      else throw new Error('lost original failure');
    }
  }),
);

effectIt.effect('isolates overlap, unavailable, failed/empty profile, summary and sink errors', () =>
  Effect.gen(function* () {
    const cases: {load: () => Promise<NativeCpuProfiler>; expected: NativeCpuPacket['status']}[] = [
      {
        load: async () => {
          throw new Error('PRIVATE');
        },
        expected: 'unavailable',
      },
      {
        load: async () => async done => {
          await done();
          throw new Error('PRIVATE');
        },
        expected: 'profile-failed',
      },
      {load: async () => completed(profile([])), expected: 'insufficient'},
      {load: async () => completed(JSON.parse('{}')), expected: 'export-failed'},
    ];
    for (const {load, expected} of cases) {
      const packets: NativeCpuPacket[] = [];
      const original = {private: true};
      const result = yield* captureNativeCpu(Effect.fail(original), packet => packets.push(packet), {
        enabled: true,
        load,
      }).pipe(Effect.exit);
      expect(packets[0].status).toBe(expected);
      expect(JSON.stringify(packets)).not.toContain('PRIVATE');
      if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(original);
      else throw new Error('lost failure');
    }
    const statuses: string[] = [];
    yield* captureNativeCpu(
      captureNativeCpu(Effect.void, packet => statuses.push(packet.status), {
        enabled: true,
        load: async () => completed(),
      }),
      packet => statuses.push(packet.status),
      {enabled: true, load: async () => completed()},
    );
    expect(statuses).toEqual(['overlap', 'captured']);
    const result = yield* captureNativeCpu(
      Effect.succeed(42),
      () => {
        throw new Error('sink');
      },
      {enabled: true, load: async () => completed()},
    );
    expect(result).toBe(42);
  }),
);

effectIt.effect('bounds the awaited flush and retains a timed-out owner until completion', () =>
  Effect.gen(function* () {
    const gate = Promise.withResolvers<SamplingProfile>();
    const packets: NativeCpuPacket[] = [];
    const value = yield* captureNativeCpu(Effect.succeed(7), packet => packets.push(packet), {
      enabled: true,
      flushMs: 1,
      load: async () => async done => {
        await done();
        return gate.promise;
      },
    });
    expect(value).toBe(7);
    expect(packets[0].status).toBe('flush-timeout');
    yield* captureNativeCpu(Effect.void, packet => packets.push(packet), {
      enabled: true,
      load: async () => completed(),
    });
    expect(packets[1].status).toBe('overlap');
    gate.resolve(profile([]));
    yield* Effect.promise(() => gate.promise.then(() => Promise.resolve()));
  }),
);

effectIt.effect('rejects configured external profiler conflicts without loading or changing the original result', () =>
  Effect.gen(function* () {
    for (const environment of [{BUN_CPU_PROFILE: '1'}, {BUN_OPTIONS: '--cpu-prof'}]) {
      const packets: NativeCpuPacket[] = [];
      const result = yield* captureNativeCpu(Effect.succeed(3), packet => packets.push(packet), {
        enabled: true,
        load: () => {
          throw new Error('must not load');
        },
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)));
      expect(result).toBe(3);
      expect(packets[0].status).toBe('conflict');
    }
  }),
);

effectIt.effect('bounds a stuck loader and prevents a late loader from ever starting profiling', () =>
  Effect.gen(function* () {
    const loader = Promise.withResolvers<NativeCpuProfiler>();
    const packets: NativeCpuPacket[] = [];
    let starts = 0;
    const result = yield* captureNativeCpu(Effect.succeed(9), packet => packets.push(packet), {
      enabled: true,
      startupMs: 1,
      load: () => loader.promise,
    });
    expect(result).toBe(9);
    expect(packets[0].status).toBe('unavailable');
    loader.resolve(async done => {
      starts++;
      await done();
      return profile([]);
    });
    yield* Effect.promise(() => loader.promise.then(() => Promise.resolve()));
    expect(starts).toBe(0);
    yield* captureNativeCpu(Effect.void, packet => packets.push(packet), {
      enabled: true,
      load: async () => completed(),
    });
    expect(packets[1].status).toBe('captured');
  }),
);
