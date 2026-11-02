import {cryptoLayer} from '@threadnote/platform/crypto';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Clock, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, PlatformError, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {nativeEmbeddingContextPlan} from '../src/engine/node-llama-cpp.js';
import {
  BACKGROUND_INFERENCE_BATCH_MILLISECONDS,
  BACKGROUND_INFERENCE_FOREGROUND_AGE_MILLISECONDS,
  CurrentBackgroundBatchAuthority,
  type BackgroundBatchAuthority,
  backgroundInferenceAdmissionStateSchema,
  classifyBackgroundCpuCapacity,
  emptyBackgroundInferenceAdmission,
  makeBackgroundInferenceAdmission,
  planBackgroundInferenceBatch,
  pruneBackgroundInferenceOwners,
  registerBackgroundForegroundLease,
  releaseBackgroundInferenceLease,
  type BackgroundInferenceAdmissionState,
  type BackgroundInferenceOwner,
  type CpuCapacity,
} from '../src/background/admission.js';

const idle: CpuCapacity = {state: 'idle', utilization: 0, spareCpus: 4};
const owner = (number: number): BackgroundInferenceOwner => ({
  processId: number,
  identityKind: 'canonical',
  startIdentity: 'fixture-' + number,
  token: '00000000-0000-4000-8000-' + EffectString.padStart(12, '0')(String(number)),
});
const policy = Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
  Layer.succeed(ChildEnvironmentPolicy, {
    preserveIntendedChild: environment => environment,
    sanitizeExternal: environment => environment,
  }),
);
const platform = Layer.mergeAll(
  Layer.merge(BunServices.layer, cryptoLayer),
  SystemInfo.layer.pipe(Layer.provide(policy)),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const actual = yield* SystemInfo;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'inference-admission-'});
  const identities = new Map<number, string | undefined>([[actual.processId, 'fixture-self']]);
  let total = 0;
  let idleTime = 0;
  let busy = false;
  const system = SystemInfo.of({
    ...actual,
    canonicalProcessStartIdentity: processId => Effect.succeed(identities.get(processId)),
    processStartIdentity: processId => Effect.succeed(identities.get(processId)),
    isProcessRunning: processId => identities.has(processId),
    cpuTimes: Effect.sync(() => {
      total += 2_000;
      idleTime += busy ? 0 : 2_000;
      return {logicalCpus: 4, totalMilliseconds: total, idleMilliseconds: idleTime};
    }),
  });
  const admission = yield* makeBackgroundInferenceAdmission.pipe(Effect.provideService(SystemInfo, system));
  const filename = path.join(home, 'locks', 'inference-idle-v1', 'state.json');
  const read = () =>
    fs
      .readFileString(filename)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(backgroundInferenceAdmissionStateSchema))));
  const write = (state: BackgroundInferenceAdmissionState) => fs.writeFileString(filename, JSON.stringify(state));
  yield* admission.withForeground(home, Effect.void);
  yield* TestClock.adjust(1_000);
  return {
    admission,
    filename,
    fs,
    home,
    identities,
    system,
    read,
    write,
    samples: () => total,
    busy: (value: boolean) => {
      busy = value;
    },
  };
});

describe('background CPU admission policy', () => {
  effectIt.effect('existing-home foreground workers never recreate a removed home or its ancestors', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.remove(f.home, {recursive: true});
      for (const suffix of ['', '/nested/new']) {
        let entered = false;
        expect(
          (yield* f.admission
            .withForeground(
              f.home + suffix,
              Effect.sync(() => {
                entered = true;
              }),
              {existingHomeOnly: true},
            )
            .pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(entered).toBe(false);
        expect(yield* f.fs.exists(f.home)).toBe(false);
      }
    }).pipe(provideFixtureLayer(platform)),
  );

  it("does not let repeatedly ineligible demand reserve another domain's fair turn", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.integer({min: 1, max: 30}), (missingIdentity, rounds) => {
        let state: BackgroundInferenceAdmissionState = {...emptyBackgroundInferenceAdmission(), lastGranted: 'recall'};
        for (let round = 0; round < rounds; round++) {
          const ineligible = planBackgroundInferenceBatch(
            state,
            'graph',
            missingIdentity ? {...owner(1), startIdentity: undefined} : owner(1),
            round,
            missingIdentity ? idle : {state: 'unknown'},
          );
          expect(ineligible.admitted).toBe(false);
          const eligible = planBackgroundInferenceBatch(ineligible.state, 'recall', owner(2), round, idle);
          expect(eligible.admitted).toBe(true);
          state = releaseBackgroundInferenceLease(eligible.state, owner(2).token, round);
        }
      }),
      {numRuns: 100},
    );
  });

  it('keeps one native background context and thread regardless of machine capacity or requested parallelism', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 512}),
        fc.constantFrom(1 as const, 2 as const, 4 as const, 8 as const),
        fc.option(fc.integer({min: 0, max: 100}), {nil: undefined}),
        (cpuMathCores, requestedContexts, modelGpuLayers) => {
          expect(
            nativeEmbeddingContextPlan({background: true, cpuMathCores, requestedContexts, modelGpuLayers}),
          ).toEqual({contexts: 1, threadCounts: [1]});
        },
      ),
      {numRuns: 100},
    );
  });

  it('requires two fresh spaced consistent observations and conservative headroom', () => {
    const before = {atMilliseconds: 0, logicalCpus: 10, totalMilliseconds: 0, idleMilliseconds: 0};
    const after = {...before, atMilliseconds: 500, totalMilliseconds: 5_000, idleMilliseconds: 4_000};
    expect(classifyBackgroundCpuCapacity(undefined, after)).toEqual({state: 'unknown'});
    expect(classifyBackgroundCpuCapacity(before, after).state).toBe('idle');
    for (const changed of [
      {atMilliseconds: 499},
      {atMilliseconds: 10_001},
      {totalMilliseconds: 0},
      {idleMilliseconds: -1},
      {idleMilliseconds: 5_001},
      {logicalCpus: 4},
      {totalMilliseconds: Number.NaN},
    ]) {
      expect(classifyBackgroundCpuCapacity(before, {...after, ...changed})).toEqual({state: 'unknown'});
    }
    expect(classifyBackgroundCpuCapacity(before, {...after, idleMilliseconds: 1_000}).state).toBe('busy');
  });

  it('retains expired live or uncertain ownership while expiring only waiting tickets', () => {
    const state: BackgroundInferenceAdmissionState = {
      ...emptyBackgroundInferenceAdmission(),
      foreground: [{owner: owner(1), expiresAt: 0}],
      active: {domain: 'graph', owner: owner(2), expiresAt: 0},
      pending: [{domain: 'recall', requestedAt: 0, expiresAt: 0}],
    };
    const pruned = pruneBackgroundInferenceOwners(state, new Set(), 100_000);
    expect(pruned.foreground).toEqual(state.foreground);
    expect(pruned.active).toEqual(state.active);
    expect(pruned.pending).toEqual([]);
    expect(pruneBackgroundInferenceOwners(state, new Set([owner(2).token]), 100_000).active).toBeUndefined();
  });

  it('never grants with foreground work, unknown/busy CPU or an active claim', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom<CpuCapacity>({state: 'unknown'}, {state: 'busy', utilization: 1, spareCpus: 0}, idle),
        fc.boolean(),
        (foreground, capacity, active) => {
          let state = emptyBackgroundInferenceAdmission();
          if (foreground) state = registerBackgroundForegroundLease(state, owner(1), 0);
          if (active) state = {...state, active: {domain: 'recall', owner: owner(2), expiresAt: 30_000}};
          const original = JSON.stringify(state);
          const result = planBackgroundInferenceBatch(state, 'graph', owner(3), 1_000, capacity);
          if (foreground || active || capacity.state !== 'idle') expect(result.admitted).toBe(false);
          if (result.admitted) expect(result.state.active?.owner.token).toBe(owner(3).token);
          expect(JSON.stringify(state)).toBe(original);
          expect(releaseBackgroundInferenceLease(state, owner(9).token, 2_000)).toEqual(state);
        },
      ),
      {numRuns: 160},
    );
  });

  it('gives both continuously queued domains turns under bounded arbitrary request ordering', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), {minLength: 4, maxLength: 60}), order => {
        let state: BackgroundInferenceAdmissionState = {
          ...emptyBackgroundInferenceAdmission(),
          pending: [
            {domain: 'recall', requestedAt: 0, expiresAt: 30_000},
            {domain: 'graph', requestedAt: 0, expiresAt: 30_000},
          ],
        };
        const grants = {recall: 0, graph: 0};
        for (const [round, graphFirst] of order.entries()) {
          for (const domain of graphFirst ? (['graph', 'recall'] as const) : (['recall', 'graph'] as const)) {
            const result = planBackgroundInferenceBatch(
              state,
              domain,
              owner(domain === 'graph' ? 1 : 2),
              round + 1,
              idle,
            );
            state = result.state;
            if (result.admitted) {
              grants[domain]++;
              state = releaseBackgroundInferenceLease(state, state.active!.owner.token, round + 1);
            }
          }
        }
        expect(grants.recall).toBeGreaterThanOrEqual(Math.floor(order.length / 2));
        expect(grants.graph).toBeGreaterThanOrEqual(Math.floor(order.length / 2));
      }),
      {numRuns: 120},
    );
  });
});

describe('background admission service', () => {
  effectIt.layer(platform)(it => {
    it.effect('initializes a background-only existing home without recreating a removed home', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const home = yield* f.fs.makeTempDirectoryScoped({prefix: 'background-only-admission-'});
        const admission = yield* makeBackgroundInferenceAdmission.pipe(Effect.provideService(SystemInfo, f.system));
        expect(yield* admission.runBatch(home, 'recall', Effect.void)).toEqual({
          state: 'deferred',
          reason: 'cpu-unknown',
        });
        yield* TestClock.adjust(500);
        expect(yield* admission.runBatch(home, 'recall', Effect.succeed('ready'))).toEqual({
          state: 'completed',
          value: 'ready',
        });
        yield* f.fs.remove(home, {recursive: true});
        expect(yield* admission.runBatch(home, 'recall', Effect.die('removed home'))).toEqual({
          state: 'deferred',
          reason: 'admission-unavailable',
        });
        expect(yield* f.fs.exists(home)).toBe(false);
      }),
    );

    it.effect('retries failed owned cleanup without requiring another request from an idle foreground process', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let fail = false;
        let retryExpected = false;
        const cleaned = yield* Deferred.make<void>();
        const path = yield* Path.Path;
        const guard = path.join(f.home, 'locks', 'inference-idle-v1', 'guard.lock');
        const admission = yield* makeBackgroundInferenceAdmission.pipe(
          Effect.provideService(SystemInfo, f.system),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              fail && to === f.filename
                ? Effect.fail(PlatformError.systemError({_tag: 'Busy', module: 'FileSystem', method: 'rename'}))
                : f.fs.rename(from, to),
            remove: (filename, options) =>
              f.fs
                .remove(filename, options)
                .pipe(
                  Effect.tap(() =>
                    filename === guard && retryExpected && !fail ? Deferred.succeed(cleaned, undefined) : Effect.void,
                  ),
                ),
          }),
        );
        yield* admission.withForeground(
          f.home,
          Effect.sync(() => {
            fail = true;
            retryExpected = true;
          }),
        );
        expect((yield* f.read()).foreground).toHaveLength(1);
        fail = false;
        yield* TestClock.adjust(250);
        yield* Deferred.await(cleaned);
        expect((yield* f.read()).foreground).toEqual([]);
        // Only the independent worker transacts after the original request.
        yield* TestClock.adjust(1_000);
        yield* f.admission.runBatch(f.home, 'graph', Effect.void);
        yield* TestClock.adjust(500);
        expect(yield* f.admission.runBatch(f.home, 'graph', Effect.succeed('recovered'))).toEqual({
          state: 'completed',
          value: 'recovered',
        });
      }),
    );

    it.effect('preserves pure and mixed cancellation while observing CPU or acquiring admission', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const mixed = Cause.combine(Cause.interrupt(123), Cause.die('cancelled-observation'));
        for (const cause of [Cause.interrupt(123), mixed]) {
          for (const boundary of ['cpu', 'state'] as const) {
            const admission = yield* makeBackgroundInferenceAdmission.pipe(
              Effect.provideService(SystemInfo, {
                ...f.system,
                cpuTimes: boundary === 'cpu' ? Effect.failCause(cause) : f.system.cpuTimes,
              }),
              Effect.provideService(FileSystem.FileSystem, {
                ...f.fs,
                readFileString: (filename, encoding) =>
                  boundary === 'state' ? Effect.failCause(cause) : f.fs.readFileString(filename, encoding),
              }),
            );
            const exit = yield* Effect.exit(admission.runBatch(f.home, 'graph', Effect.die('must not execute')));
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) expect(exit.cause).toEqual(cause);
          }
        }
      }),
    );

    it.effect('retires a foreground token when initialization fails after publishing its ledger row', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const path = yield* Path.Path;
        const home = path.join(f.home, 'initialization-failure');
        let failures = 1;
        const admission = yield* makeBackgroundInferenceAdmission.pipe(
          Effect.provideService(SystemInfo, f.system),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            writeFileString: (filename, content, options) => {
              if (filename === path.join(home, 'locks', 'inference-idle-v1', 'initialized') && failures-- > 0)
                return Effect.fail(
                  PlatformError.systemError({_tag: 'Busy', module: 'FileSystem', method: 'writeFileString'}),
                );
              return f.fs.writeFileString(filename, content, options);
            },
          }),
        );
        expect(Exit.isFailure(yield* Effect.exit(admission.withForeground(home, Effect.void)))).toBe(true);
        yield* admission.withForeground(home, Effect.void);
        yield* TestClock.adjust(1_000);
        expect(yield* admission.runBatch(home, 'graph', Effect.void)).toEqual({
          state: 'deferred',
          reason: 'cpu-unknown',
        });
        yield* TestClock.adjust(500);
        expect(yield* admission.runBatch(home, 'graph', Effect.succeed('recovered'))).toEqual({
          state: 'completed',
          value: 'recovered',
        });
        const state = yield* f.fs
          .readFileString(path.join(home, 'locks', 'inference-idle-v1', 'state.json'))
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(backgroundInferenceAdmissionStateSchema))),
          );
        expect(state.foreground).toEqual([]);
        expect(state.active).toBeUndefined();
      }),
    );

    it.effect('defers unknown/busy capacity and foreground work before entering a domain unit', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let entered = 0;
        const work = Effect.sync(() => ++entered);
        expect(yield* f.admission.runBatch(f.home, 'recall', work)).toEqual({state: 'deferred', reason: 'cpu-unknown'});
        f.busy(true);
        yield* TestClock.adjust(500);
        expect(yield* f.admission.runBatch(f.home, 'recall', work)).toEqual({state: 'deferred', reason: 'cpu-busy'});
        f.busy(false);
        yield* TestClock.adjust(500);
        yield* f.admission.withForeground(
          f.home,
          Effect.gen(function* () {
            expect(yield* f.admission.runBatch(f.home, 'recall', work)).toEqual({
              state: 'deferred',
              reason: 'foreground',
            });
          }),
        );
        expect(entered).toBe(0);
        expect(yield* f.admission.runBatch(f.home, 'recall', work)).toEqual({
          state: 'deferred',
          reason: 'foreground-quiet',
        });
        yield* TestClock.adjust(1_000);
        expect(yield* f.admission.runBatch(f.home, 'recall', work)).toEqual({state: 'completed', value: 1});
        expect((yield* f.read()).active).toBeUndefined();
      }),
    );

    it.effect('admits foreground work without waiting for an already running bounded batch', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.admission.runBatch(f.home, 'graph', Effect.void);
        yield* TestClock.adjust(500);
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const batch = yield* f.admission
          .runBatch(f.home, 'graph', Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))))
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* f.admission.withForeground(
          f.home,
          Effect.gen(function* () {
            expect((yield* f.read()).active?.domain).toBe('graph');
            expect((yield* f.read()).foreground).toHaveLength(1);
            expect(
              yield* f.admission.runBatch(f.home, 'recall', Effect.die('Foreground work must prevent a new unit')),
            ).toEqual({state: 'deferred', reason: 'foreground'});
            yield* Deferred.succeed(finish, undefined);
            expect(yield* Fiber.join(batch)).toEqual({state: 'completed', value: undefined});
          }),
        );
        expect((yield* f.read()).foreground).toEqual([]);
      }),
    );

    it.effect('bounds a batch and cleans its claim on timeout and foreground interruption', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.admission.runBatch(f.home, 'recall', Effect.void);
        yield* TestClock.adjust(500);
        const started = yield* Deferred.make<void>();
        const batch = yield* f.admission
          .runBatch(f.home, 'recall', Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust(BACKGROUND_INFERENCE_BATCH_MILLISECONDS);
        expect(yield* Fiber.join(batch)).toEqual({state: 'deferred', reason: 'batch-deadline'});
        expect((yield* f.read()).active).toBeUndefined();
        const foreground = yield* f.admission
          .withForeground(f.home, Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild);
        while ((yield* f.read()).foreground.length === 0) yield* Effect.yieldNow;
        yield* Fiber.interrupt(foreground);
        expect((yield* f.read()).foreground).toEqual([]);
      }),
    );

    it.effect('retains the batch claim until interrupted computation cleanup acknowledges completion', () =>
      Effect.acquireUseRelease(
        Deferred.make<void>(),
        exited =>
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.admission.runBatch(f.home, 'graph', Effect.void);
            yield* TestClock.adjust(500);
            const started = yield* Deferred.make<void>();
            const stopping = yield* Deferred.make<void>();
            const work = Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Deferred.await(exited)))),
            );
            const batch = yield* f.admission.runBatch(f.home, 'graph', work).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            const interruption = yield* Fiber.interrupt(batch).pipe(Effect.forkChild);
            yield* Deferred.await(stopping);
            expect((yield* f.read()).active?.domain).toBe('graph');
            expect(yield* f.admission.runBatch(f.home, 'recall', Effect.die('cleanup still owns computation'))).toEqual(
              {
                state: 'deferred',
                reason: 'inference-active',
              },
            );
            yield* f.admission.withForeground(f.home, Effect.void);
            yield* Deferred.succeed(exited, undefined);
            yield* Fiber.join(interruption);
            expect(Exit.isFailure(yield* Fiber.await(batch))).toBe(true);
            expect((yield* f.read()).active).toBeUndefined();
          }),
        exited => Deferred.succeed(exited, undefined),
      ),
    );

    it.effect('recovers only positively dead process instances and fails closed on malformed state', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const foreign = owner(9000);
        f.identities.set(foreign.processId, undefined);
        yield* f.write({...(yield* f.read()), quietUntil: 0, foreground: [{owner: foreign, expiresAt: 0}]});
        expect(yield* f.admission.runBatch(f.home, 'graph', Effect.die('Unknown owners remain authoritative'))).toEqual(
          {state: 'deferred', reason: 'foreground'},
        );
        f.identities.set(foreign.processId, 'reused-process');
        yield* TestClock.adjust(500);
        expect(yield* f.admission.runBatch(f.home, 'graph', Effect.succeed('recovered'))).toEqual({
          state: 'completed',
          value: 'recovered',
        });
        yield* f.fs.writeFileString(f.filename, '{corrupt');
        expect(
          yield* f.admission.runBatch(f.home, 'graph', Effect.die('Corrupt control state must not grant work')),
        ).toEqual({state: 'deferred', reason: 'admission-unavailable'});
      }),
    );

    for (const crash of [false, true]) {
      it.effect(
        crash
          ? 'recovers a positively dead process claim without expiring its lease'
          : 'admits at most one batch across independent processes',
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'inference-admission-process-'});
            const held = path.join(home, 'held');
            const contended = path.join(home, 'contended');
            const active = path.join(home, 'fixture-computing');
            const start = (first: boolean) =>
              Effect.acquireRelease(
                Effect.sync(() => spawnAdmission({home, held, contended, active, first, crash})),
                child =>
                  Effect.gen(function* () {
                    if (child.exitCode === null) child.kill('SIGKILL');
                    yield* Effect.promise(() => child.exited);
                  }),
              );
            const first = yield* start(true);
            while (!(yield* fs.exists(held))) {
              if (first.exitCode !== null)
                return yield* Effect.die(yield* Effect.promise(() => new Response(first.stdout).text()));
              yield* Effect.sleep(10);
            }
            if (crash) {
              first.kill('SIGKILL');
              yield* Effect.promise(() => first.exited);
              // Only the fixture's auxiliary overlap detector is removed; the
              // product claim remains untouched for positive-death recovery.
              yield* fs.remove(active);
            }
            const second = yield* start(false);
            for (const child of crash ? [second] : [first, second]) {
              const code = yield* Effect.promise(() => child.exited);
              const stdout = yield* Effect.promise(() => new Response(child.stdout).text());
              const stderr = yield* Effect.promise(() => new Response(child.stderr).text());
              expect(code, stderr || stdout).toBe(0);
            }
            const state: BackgroundInferenceAdmissionState = JSON.parse(
              yield* fs.readFileString(path.join(home, 'locks', 'inference-idle-v1', 'state.json')),
            );
            expect(state.active).toBeUndefined();
            expect(state.foreground).toEqual([]);
            if (!crash) expect(yield* fs.exists(contended)).toBe(true);
          }).pipe(TestClock.withLive, Effect.timeout('30 seconds')),
        {timeout: 40_000},
      );
    }
  });
});

function spawnAdmission(options: {
  readonly home: string;
  readonly held: string;
  readonly contended: string;
  readonly active: string;
  readonly first: boolean;
  readonly crash: boolean;
}) {
  return Bun.spawn({
    cmd: [
      process.execPath,
      '--eval',
      `
    import {cryptoLayer} from '@threadnote/platform/crypto';
    import * as BunServices from '@effect/platform-bun/BunServices';
    import * as BunRuntime from '@effect/platform-bun/BunRuntime';
    import {Clock, Effect, FileSystem, Layer} from 'effect';
    import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
    import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
    import {SystemInfo} from '@threadnote/platform/system';
    import {makeBackgroundInferenceAdmission} from ${JSON.stringify(new URL('../src/background/admission.ts', import.meta.url).href)};
    const options = ${JSON.stringify(options)};
    const policy = Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'admission-fixture'}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: value => value, sanitizeExternal: value => value}),
    );
    const platform = Layer.mergeAll(Layer.merge(BunServices.layer, cryptoLayer), SystemInfo.layer.pipe(Layer.provide(policy)));
    BunRuntime.runMain(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const system = yield* SystemInfo;
      const cpuTimes = Clock.monotonicTimeNanos.pipe(Effect.map(value => ({logicalCpus: 4, totalMilliseconds: Number(value) / 250_000, idleMilliseconds: Number(value) / 250_000})));
      const admission = yield* makeBackgroundInferenceAdmission.pipe(Effect.provideService(SystemInfo, SystemInfo.of({...system, cpuTimes})));
      if (options.first) yield* admission.withForeground(options.home, Effect.void);
      if (!options.first && !options.crash) {
        const denied = yield* admission.runBatch(options.home, 'recall', Effect.die('Two independent batches overlapped'));
        if (denied.state !== 'deferred' || denied.reason !== 'inference-active') return yield* Effect.die('Expected the first process to retain compute authority');
        yield* fs.writeFileString(options.contended, '');
      }
      const work = Effect.acquireUseRelease(
        fs.writeFileString(options.active, String(system.processId), {flag: 'wx'}),
        () => Effect.gen(function* () {
          if (!options.first) return 'recall';
          yield* fs.writeFileString(options.held, '');
          if (options.crash) return yield* Effect.never;
          while (!(yield* fs.exists(options.contended))) yield* Effect.sleep(10);
          return 'graph';
        }),
        () => fs.remove(options.active),
      );
      for (;;) {
        const result = yield* admission.runBatch(options.home, options.first ? 'graph' : 'recall', work);
        if (result.state === 'completed') return;
        yield* Effect.sleep(500);
      }
    }).pipe(Effect.scoped, Effect.timeout('20 seconds'), Effect.provide(platform)));
  `,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('native child execution admission', () => {
  effectIt.effect('rejects a queued frame after its exact parent batch was released', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.admission.runBatch(f.home, 'recall', Effect.void);
      yield* TestClock.adjust(500);
      const granted = yield* f.admission.runBatch(f.home, 'recall', CurrentBackgroundBatchAuthority);
      expect(granted.state).toBe('completed');
      if (granted.state !== 'completed' || !granted.value) return yield* Effect.die('expected authority');
      let executed = false;
      const result = yield* f.admission
        .withExecution(
          granted.value,
          Effect.sync(() => {
            executed = true;
          }),
        )
        .pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      expect(executed).toBe(false);
      expect((yield* f.read()).foreground).toEqual([]);
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('a live computing child blocks a new batch after its parent dies', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const childPid = f.system.processId + 100_000;
      f.identities.set(childPid, 'fixture-child');
      const child = yield* makeBackgroundInferenceAdmission.pipe(
        Effect.provideService(SystemInfo, {...f.system, processId: childPid}),
      );
      const authority = yield* Deferred.make<BackgroundBatchAuthority>();
      const releaseParent = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const releaseChild = yield* Deferred.make<void>();
      yield* f.admission.runBatch(f.home, 'recall', Effect.void);
      yield* TestClock.adjust(500);
      const parent = yield* f.admission
        .runBatch(
          f.home,
          'recall',
          Effect.gen(function* () {
            const current = yield* CurrentBackgroundBatchAuthority;
            if (!current) return yield* Effect.die('missing authority');
            yield* Deferred.succeed(authority, current);
            yield* Deferred.await(releaseParent);
          }),
        )
        .pipe(Effect.forkScoped);
      const witness = yield* Deferred.await(authority);
      const executing = yield* child
        .withExecution(witness, Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(releaseChild))))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      f.identities.delete(f.system.processId);
      yield* Deferred.succeed(releaseParent, undefined);
      yield* Fiber.join(parent);
      const state = yield* f.read();
      expect(state.active).toBeUndefined();
      expect(state.foreground).toHaveLength(1);
      expect(state.foreground[0]?.owner.processId).toBe(childPid);
      expect(state.foreground[0]?.purpose).toBe('idle-execution');
      expect(yield* f.admission.runBatch(f.home, 'graph', Effect.die('overlapping native work'))).toEqual({
        state: 'deferred',
        reason: 'foreground',
      });
      const second = yield* child
        .withExecution(witness, Effect.die('stale queued child execution'))
        .pipe(Effect.result);
      expect(second._tag).toBe('Failure');
      yield* Deferred.succeed(releaseChild, undefined);
      yield* Fiber.join(executing);
      expect((yield* f.read()).foreground).toEqual([]);
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('repeated rejected native execution returns unpublished owner reservations', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const parentPid = f.system.processId + 200_000;
      f.identities.set(parentPid, 'fixture-parent');
      const authority: BackgroundBatchAuthority = {
        home: f.home,
        domain: 'recall',
        owner: {...owner(1), processId: parentPid, startIdentity: 'fixture-parent'},
      };
      for (const unknownChild of [false, true]) {
        const system = unknownChild
          ? {
              ...f.system,
              canonicalProcessStartIdentity: (pid: number) =>
                Effect.succeed(pid === parentPid ? 'fixture-parent' : undefined),
              processStartIdentity: (pid: number) => Effect.succeed(pid === parentPid ? 'fixture-parent' : undefined),
            }
          : f.system;
        const admission = yield* makeBackgroundInferenceAdmission.pipe(Effect.provideService(SystemInfo, system));
        for (let index = 0; index < 132; index++)
          expect(
            yield* admission.withExecution(authority, Effect.die('must not execute')).pipe(Effect.result),
          ).toMatchObject({
            _tag: 'Failure',
            failure: {_tag: 'BackgroundInferenceDeferred'},
          });
        expect(yield* admission.withForeground(f.home, Effect.succeed('ready'))).toBe('ready');
        expect((yield* f.read()).foreground).toEqual([]);
      }
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('a foreground request that arrives before native execution revokes eligibility', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const authority = yield* Deferred.make<BackgroundBatchAuthority>();
      const releaseParent = yield* Deferred.make<void>();
      yield* f.admission.runBatch(f.home, 'recall', Effect.void);
      yield* TestClock.adjust(500);
      const parent = yield* f.admission
        .runBatch(
          f.home,
          'recall',
          Effect.gen(function* () {
            const current = yield* CurrentBackgroundBatchAuthority;
            if (!current) return yield* Effect.die('missing authority');
            yield* Deferred.succeed(authority, current);
            yield* Deferred.await(releaseParent);
          }),
        )
        .pipe(Effect.forkScoped);
      const witness = yield* Deferred.await(authority);
      yield* f.admission.withForeground(
        f.home,
        Effect.gen(function* () {
          expect(
            (yield* f.admission.withExecution(witness, Effect.die('must not start')).pipe(Effect.result))._tag,
          ).toBe('Failure');
        }),
      );
      yield* Deferred.succeed(releaseParent, undefined);
      yield* Fiber.join(parent);
    }).pipe(provideFixtureLayer(platform)),
  );
});

function provideFixtureLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(program: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
}

describe('spare capacity during sustained foreground work', () => {
  const sustained = () => ({
    ...registerBackgroundForegroundLease(emptyBackgroundInferenceAdmission(), owner(90), 0, true),
    foreground: [{owner: owner(90), expiresAt: 1_000_000, nativeFree: true as const}],
  });
  const tick = (
    state: BackgroundInferenceAdmissionState,
    domain: 'recall' | 'graph',
    now: number,
    capacity: CpuCapacity = idle,
  ) =>
    planBackgroundInferenceBatch(
      pruneBackgroundInferenceOwners(state, new Set(), now),
      domain,
      owner(domain === 'recall' ? 1 : 2),
      now,
      capacity,
    );

  it('ages across short-call quiet gaps, resets after real quiet, and retains legacy/native blockers', () => {
    let state = tick(sustained(), 'recall', 0).state;
    expect(tick(state, 'recall', 29_999).admitted).toBe(false);
    const ended = releaseBackgroundInferenceLease(state, owner(90).token, 29_900);
    const granted = tick(ended, 'recall', 30_000);
    expect(granted.admitted).toBe(true);
    expect(granted.state.active?.spareCapacityStartedAt).toBe(30_000);
    state = releaseBackgroundInferenceLease(granted.state, owner(1).token, 30_010);
    const quiet = tick(state, 'graph', 31_000);
    expect(quiet.admitted).toBe(true);
    expect(quiet.state.foregroundBusySince).toBeUndefined();
    expect(quiet.state.active?.spareCapacityStartedAt).toBeUndefined();
    state = registerBackgroundForegroundLease(
      releaseBackgroundInferenceLease(quiet.state, owner(2).token, 31_001),
      owner(90),
      31_002,
      true,
    );
    expect(tick(state, 'recall', 31_003).admitted).toBe(false);
    for (const foreground of [
      [{owner: owner(90), expiresAt: 0}],
      [{owner: owner(90), expiresAt: 0, nativeFree: true as const}],
      [{owner: {...owner(90), startIdentity: undefined}, expiresAt: 0, nativeFree: true as const}],
      [{owner: owner(90), expiresAt: 0, nativeFree: true as const, purpose: 'idle-execution' as const}],
    ]) {
      const blocked = {...sustained(), foreground, foregroundBusySince: 0};
      expect(tick(blocked, 'recall', 100_000).admitted).toBe(false);
    }
    for (const capacity of [
      {state: 'unknown'} as const,
      {state: 'busy', utilization: 1, spareCpus: 0} as const,
      {state: 'idle', utilization: 0, spareCpus: 0.75} as const,
    ])
      expect(tick({...sustained(), foregroundBusySince: 0}, 'recall', 30_000, capacity).admitted).toBe(false);
  });

  it('charges proportional bounded cooldown on release and crash pruning without mutating or extending retired evidence', () => {
    for (const elapsed of [1, 500, 40_000]) {
      const state: BackgroundInferenceAdmissionState = {
        ...sustained(),
        foregroundBusySince: 0,
        active: {domain: 'recall', owner: owner(1), expiresAt: 0, spareCapacityStartedAt: 30_000},
        foreground: [
          ...sustained().foreground,
          {owner: owner(3), expiresAt: 0, purpose: 'idle-execution', spareCapacityStartedAt: 30_010},
        ],
      };
      const before = JSON.stringify(state),
        now = 30_000 + elapsed;
      const expected = now + Math.max(100, Math.min(15_000, elapsed));
      const pruned = pruneBackgroundInferenceOwners(state, new Set([owner(1).token, owner(3).token]), now);
      expect(pruned.spareCapacityNotBefore).toBe(expected);
      expect(
        pruneBackgroundInferenceOwners(pruned, new Set([owner(1).token, owner(3).token]), now + 1)
          .spareCapacityNotBefore,
      ).toBe(expected);
      expect(releaseBackgroundInferenceLease(state, owner(1).token, now).spareCapacityNotBefore).toBe(expected);
      expect(pruneBackgroundInferenceOwners(state, new Set(), now).active).toEqual(state.active);
      expect(JSON.stringify(state)).toBe(before);
      expect(tick(pruned, 'graph', expected - 1).admitted).toBe(false);
      expect(tick({...pruned, foreground: [], quietUntil: 0}, 'graph', expected - 1).admitted).toBe(false);
      expect(tick(pruned, 'graph', expected).admitted).toBe(true);
    }
  });

  it('both domains make fair progress through one shared yielded budget under continuous compatible foreground work', () => {
    for (const orderMode of ['graph', 'recall', 'random'] as const)
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              graphFirst: fc.boolean(),
              duration: fc.integer({min: 1, max: 500}),
              advance: fc.integer({min: 100, max: 500}),
            }),
            {minLength: 40, maxLength: 60},
          ),
          trace => {
            let state = tick(sustained(), 'recall', 0).state;
            let now = BACKGROUND_INFERENCE_FOREGROUND_AGE_MILLISECONDS,
              nextSlot = 0;
            const counts = {recall: 0, graph: 0};
            for (const step of trace) {
              for (const domain of (orderMode === 'random' ? step.graphFirst : orderMode === 'graph')
                ? (['graph', 'recall'] as const)
                : (['recall', 'graph'] as const)) {
                const before = JSON.stringify(state),
                  result = tick(state, domain, now);
                expect(JSON.stringify(state)).toBe(before);
                state = result.state;
                if (!result.admitted) continue;
                expect(now).toBeGreaterThanOrEqual(nextSlot);
                expect(state.active?.domain).toBe(domain);
                expect(state.active?.spareCapacityStartedAt).toBe(now);
                expect(state.foreground).toEqual(sustained().foreground);
                counts[domain]++;
                now += step.duration;
                nextSlot = now + Math.max(100, step.duration);
                state = releaseBackgroundInferenceLease(state, owner(domain === 'recall' ? 1 : 2).token, now);
                expect(state.spareCapacityNotBefore).toBe(nextSlot);
              }
              now += step.advance;
            }
            expect(counts.recall).toBeGreaterThan(0);
            expect(counts.graph).toBeGreaterThan(0);
            expect(Math.abs(counts.recall - counts.graph)).toBeLessThanOrEqual(1);
          },
        ),
        {numRuns: 40},
      );
  });

  effectIt.effect(
    'selects and executes a capacity batch while compatible foreground remains live, then yields to the other domain',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        // Age selection is covered above; controlled age avoids advancing heartbeat time during filesystem I/O.
        yield* TestClock.adjust(BACKGROUND_INFERENCE_FOREGROUND_AGE_MILLISECONDS);
        yield* f.admission.withForeground(
          f.home,
          Effect.gen(function* () {
            expect((yield* f.admission.runBatch(f.home, 'recall', Effect.die('too early'))).state).toBe('deferred');
            yield* f.write({...(yield* f.read()), foregroundBusySince: 0});
            yield* TestClock.adjust(500);
            const nativeStarting = yield* Deferred.make<void>();
            const executing = yield* f.admission
              .runBatch(
                f.home,
                'recall',
                Effect.gen(function* () {
                  const authority = yield* CurrentBackgroundBatchAuthority;
                  expect(authority?.capacityMode).toBe('spare-cpu-v2');
                  if (!authority) return yield* Effect.die('missing authority');
                  yield* Deferred.succeed(nativeStarting, undefined);
                  return yield* f.admission.withExecution(
                    authority,
                    Effect.gen(function* () {
                      const state = yield* f.read();
                      expect(state.foreground.length).toBe(2);
                      expect(state.foreground[0].nativeFree).toBe(true);
                      expect(state.foreground[1].purpose).toBe('idle-execution');
                      return 'native complete';
                    }),
                  );
                }),
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(nativeStarting);
            yield* TestClock.adjust(500);
            expect(yield* Fiber.join(executing)).toEqual({state: 'completed', value: 'native complete'});
            expect((yield* f.read()).foreground.length).toBe(1);
            expect((yield* f.admission.runBatch(f.home, 'graph', Effect.die('must yield'))).state).toBe('deferred');
            yield* TestClock.adjust(1_000);
            expect(yield* f.admission.runBatch(f.home, 'graph', Effect.succeed('graph complete'))).toEqual({
              state: 'completed',
              value: 'graph complete',
            });
          }),
          {nativeFree: true},
        );
        expect((yield* f.read()).foreground).toEqual([]);
      }).pipe(provideFixtureLayer(platform)),
  );

  for (const fault of [
    'none',
    'cpu-busy',
    'unclassified',
    'missing-identity',
    'expired',
    'full',
    'wrong-mode',
    'parent-reused',
  ] as const)
    effectIt.effect(`capacity native boundary ${fault} preserves CPU and child ledger authority`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.admission.withForeground(
          f.home,
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const authority: BackgroundBatchAuthority = {
              home: f.home,
              domain: 'recall',
              capacityMode: 'spare-cpu-v2',
              owner: {...owner(900), processId: f.system.processId, startIdentity: 'fixture-self'},
            };
            const original = yield* f.read();
            // These foreign owners are live; dead-owner pruning is tested separately.
            if (fault === 'unclassified' || fault === 'missing-identity' || fault === 'expired')
              f.identities.set(999, 'fixture-999');
            if (fault === 'full') for (let n = 0; n < 128; n++) f.identities.set(n + 10_000, 'fixture-' + (n + 10_000));
            // Controlled service fixture; the pure state-machine property above exercises real grant selection.
            yield* f.write({
              ...original,
              foregroundBusySince: 0,
              active: {domain: 'recall', owner: authority.owner, expiresAt: now + 30_000, spareCapacityStartedAt: now},
              ...(fault === 'unclassified'
                ? {foreground: [...original.foreground, {owner: owner(999), expiresAt: 999_999}]}
                : {}),
              ...(fault === 'missing-identity'
                ? {
                    foreground: [
                      ...original.foreground,
                      {owner: {...owner(999), startIdentity: undefined}, expiresAt: 999_999, nativeFree: true as const},
                    ],
                  }
                : {}),
              ...(fault === 'expired'
                ? {foreground: [...original.foreground, {owner: owner(999), expiresAt: 0, nativeFree: true as const}]}
                : {}),
              ...(fault === 'full'
                ? {
                    foreground: Array.from({length: 128}, (_, n) => ({
                      owner: owner(n + 10_000),
                      expiresAt: 999_999,
                      nativeFree: true as const,
                    })),
                  }
                : {}),
            });
            if (fault === 'cpu-busy') f.busy(true);
            let entered = false;
            const samples = f.samples();
            const executing = yield* f.admission
              .withExecution(
                fault === 'wrong-mode' ? {...authority, capacityMode: undefined} : authority,
                Effect.sync(() => {
                  entered = true;
                }),
              )
              .pipe(Effect.result, Effect.forkChild);
            if (fault !== 'wrong-mode') {
              while (f.samples() === samples) yield* Effect.yieldNow;
              if (fault === 'parent-reused') f.identities.set(f.system.processId, 'reused-parent');
              yield* TestClock.adjust(500);
            }
            expect((yield* Fiber.join(executing))._tag).toBe(fault === 'none' ? 'Success' : 'Failure');
            expect(entered).toBe(fault === 'none');
            expect((yield* f.read()).foreground.length).toBe(
              fault === 'full'
                ? 128
                : fault === 'unclassified' || fault === 'missing-identity' || fault === 'expired'
                  ? 2
                  : 1,
            );
            f.identities.set(f.system.processId, 'fixture-self');
            yield* f.write(original);
          }),
          {nativeFree: true},
        );
        expect((yield* f.read()).foreground).toEqual([]);
        expect(yield* f.admission.withForeground(f.home, Effect.succeed('owner reservation returned'))).toBe(
          'owner reservation returned',
        );
      }).pipe(provideFixtureLayer(platform)),
    );
});
